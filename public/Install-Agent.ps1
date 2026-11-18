#Requires -Version 5.1
<#
.SYNOPSIS
    SoftDist 静默安装客户端。

.DESCRIPTION
    从 Cloudflare Worker 读取软件清单，比对本机已安装版本，下载并静默安装缺失或版本过旧的软件。

.PARAMETER Server
    服务地址，例如 https://soft-dist.example.workers.dev

.PARAMETER App
    只处理指定软件（支持通配符），可传多个，例如 -App "7-Zip","Chrome"

.PARAMETER DownloadDir
    安装包缓存目录，默认 %ProgramData%\SoftDist\cache

.PARAMETER InstallRoot
    默认安装根目录，软件未单独配置安装目录时安装到 <InstallRoot>\<软件名>，默认 C:\APP

.PARAMETER LogPath
    日志文件路径，默认 %ProgramData%\SoftDist\install.log

.PARAMETER Force
    忽略版本比对，强制重新安装

.PARAMETER DryRun
    只检查并输出将要执行的动作，不下载、不安装

.EXAMPLE
    .\Install-Agent.ps1 -Server "https://soft-dist.example.workers.dev"

.EXAMPLE
    .\Install-Agent.ps1 -Server "https://soft-dist.example.workers.dev" -App "7-Zip" -Force

.EXAMPLE
    .\Install-Agent.ps1 -Server "https://soft-dist.example.workers.dev" -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Server,

    [string[]]$App,

    [string]$DownloadDir = (Join-Path $env:ProgramData 'SoftDist\cache'),

    [string]$InstallRoot = 'C:\APP',

    [string]$LogPath = (Join-Path $env:ProgramData 'SoftDist\install.log'),

    [switch]$Force,

    [switch]$DryRun
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 强制启用 TLS 1.2+，否则 Windows PowerShell 5.1 访问 HTTPS 会失败
try {
    $protocols = [Net.SecurityProtocolType]::Tls12
    if ([Enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') {
        $protocols = $protocols -bor [Net.SecurityProtocolType]::Tls13
    }
    [Net.ServicePointManager]::SecurityProtocol = $protocols
}
catch {
    # 老系统忽略即可
}

# ---------------------------------------------------------------- 日志

$script:LogReady = $false

function Initialize-Log {
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $script:LogReady = $true
    }
    catch {
        $script:LogReady = $false
        Write-Host "日志目录不可写，仅输出到控制台：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR', 'STEP')][string]$Level = 'INFO'
    )

    $line = '[{0}] [{1,-5}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message

    $color = switch ($Level) {
        'OK' { 'Green' }
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        'STEP' { 'Cyan' }
        default { 'Gray' }
    }
    Write-Host $line -ForegroundColor $color

    if ($script:LogReady) {
        try {
            Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
        }
        catch {
            $script:LogReady = $false
        }
    }
}

# ---------------------------------------------------------------- 本机检测

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-InstalledPrograms {
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    $result = New-Object System.Collections.ArrayList
    foreach ($path in $paths) {
        try {
            $items = Get-ItemProperty -Path $path -ErrorAction SilentlyContinue
        }
        catch {
            continue
        }
        foreach ($item in $items) {
            if (-not $item.DisplayName) { continue }
            [void]$result.Add([pscustomobject]@{
                    DisplayName     = [string]$item.DisplayName
                    DisplayVersion  = if ($item.DisplayVersion) { [string]$item.DisplayVersion } else { '' }
                    InstallLocation = if ($item.InstallLocation) { [string]$item.InstallLocation } else { '' }
                })
        }
    }
    return $result
}

function Find-InstalledApp {
    param(
        [string]$Name,
        [object[]]$Index
    )

    $exact = $Index | Where-Object { $_.DisplayName -ieq $Name } | Select-Object -First 1
    if ($exact) { return $exact }

    $pattern = [WildcardPattern]::Escape($Name) + '*'
    return $Index | Where-Object { $_.DisplayName -like $pattern } | Select-Object -First 1
}

function ConvertTo-VersionOrNull {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $match = [regex]::Match($Text, '\d+(?:\.\d+){0,3}')
    if (-not $match.Success) { return $null }
    try {
        return [version]$match.Value
    }
    catch {
        return $null
    }
}

function Compare-AppVersion {
    param(
        [string]$Installed,
        [string]$Target
    )

    if ([string]::IsNullOrWhiteSpace($Installed)) { return -1 }
    if ([string]::IsNullOrWhiteSpace($Target)) { return 0 }

    $current = ConvertTo-VersionOrNull $Installed
    $wanted = ConvertTo-VersionOrNull $Target
    if ($current -and $wanted) {
        return $current.CompareTo($wanted)
    }
    return [string]::Compare($Installed, $Target, [StringComparison]::OrdinalIgnoreCase)
}

# ---------------------------------------------------------------- 下载与安装

function Get-SafeName {
    param([string]$Name)
    $safe = ($Name -replace '[<>:"/\\|?*]', '_').Trim().TrimEnd('.')
    if (-not $safe) { $safe = 'app' }
    return $safe
}

function Get-InstallDir {
    param(
        [string]$Configured,
        [string]$AppName,
        [string]$Root
    )

    if (-not [string]::IsNullOrWhiteSpace($Configured)) {
        return ($Configured.Trim() -replace '[\\/]+$', '')
    }
    return (Join-Path $Root (Get-SafeName -Name $AppName))
}

function Resolve-InstallerType {
    param(
        [string]$Declared,
        [string]$FilePath
    )

    if ($Declared -eq 'none') { return 'none' }
    if ($Declared -and $Declared -ne 'auto') { return $Declared }

    switch ([System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()) {
        '.msi' { return 'msi' }
        '.msix' { return 'msix' }
        '.appx' { return 'msix' }
        '.ps1' { return 'ps1' }
        '.zip' { return 'zip' }
        default { return 'exe' }
    }
}

function Get-PackageFile {
    param(
        [string]$Url,
        [string]$TargetDir,
        [string]$Type,
        [string]$AppName,
        [string]$ExpectedHash
    )

    if (-not (Test-Path -LiteralPath $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    }

    $isHttp = $Url -match '^(?i)https?://'
    $rawName = ''
    if ($isHttp) {
        try {
            $rawName = [System.IO.Path]::GetFileName(([uri]$Url).AbsolutePath)
        }
        catch {
            $rawName = ''
        }
    }
    else {
        $rawName = [System.IO.Path]::GetFileName($Url)
    }

    $extension = [System.IO.Path]::GetExtension($rawName)
    if (-not $extension) {
        switch ($Type) {
            'msi' { $extension = '.msi' }
            'msix' { $extension = '.msix' }
            'ps1' { $extension = '.ps1' }
            'zip' { $extension = '.zip' }
            default { $extension = '.exe' }
        }
        $rawName = ($AppName -replace '[^\w\.\-]', '_') + $extension
    }

    $fileName = ($rawName -replace '[^\w\.\-]', '_')
    $destination = Join-Path $TargetDir $fileName

    # 已有缓存且哈希匹配时直接复用
    if ($ExpectedHash -and (Test-Path -LiteralPath $destination)) {
        $cached = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($cached -eq $ExpectedHash.ToLowerInvariant()) {
            Write-Log "复用已缓存的安装包：$destination"
            return $destination
        }
    }

    if ($isHttp) {
        Write-Log "下载：$Url"
        Invoke-WebRequest -Uri $Url -OutFile $destination -UseBasicParsing -TimeoutSec 3600
    }
    else {
        Write-Log "复制：$Url"
        Copy-Item -LiteralPath $Url -Destination $destination -Force
    }

    $size = (Get-Item -LiteralPath $destination).Length
    Write-Log ("下载完成：{0}（{1:N1} MB）" -f $destination, ($size / 1MB))
    return $destination
}

function Invoke-Installer {
    param(
        [string]$FilePath,
        [string]$Type,
        [string]$SilentArgs,
        [string]$InstallDir
    )

    $successCodes = @(0, 3010, 1641)

    switch ($Type) {
        'msi' {
            $arguments = "/i `"$FilePath`" /qn /norestart"
            # MSI 无法用命令行强制目录时会被忽略，不会导致安装失败
            if ($InstallDir -and $SilentArgs -notmatch '(?i)INSTALLDIR|APPLICATIONFOLDER|TARGETDIR') {
                $arguments += " INSTALLDIR=`"$InstallDir`""
            }
            if ($SilentArgs) { $arguments += " $SilentArgs" }
            Write-Log "执行：msiexec.exe $arguments"
            $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList $arguments -Wait -PassThru
        }
        'exe' {
            if (-not $SilentArgs) {
                throw "该软件未配置静默参数。请在控制台把安装类型设为 exe 并填写正确的静默参数（如 /S、/VERYSILENT /NORESTART）。"
            }
            $arguments = $SilentArgs
            # NSIS 用 /D=，必须放在最后且不能加引号；Inno 请直接在静默参数里写 /DIR="..."
            if ($InstallDir -and $arguments -notmatch '(?i)/D=|/DIR=|INSTALLDIR') {
                $arguments = "$arguments /D=$InstallDir"
            }
            Write-Log "执行：$FilePath $arguments"
            $process = Start-Process -FilePath $FilePath -ArgumentList $arguments -Wait -PassThru
        }
        'ps1' {
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$FilePath`"")
            if ($SilentArgs) { $arguments += $SilentArgs }
            Write-Log "执行：powershell.exe $($arguments -join ' ')"
            $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Wait -PassThru
        }
        'msix' {
            Write-Log "执行：Add-AppxPackage $FilePath"
            Add-AppxPackage -Path $FilePath -ErrorAction Stop
            return 0
        }
        'zip' {
            Write-Log "解压到：$InstallDir（zip 类型不做静默安装）"
            Expand-Archive -LiteralPath $FilePath -DestinationPath $InstallDir -Force
            return 0
        }
        'none' {
            Write-Log "已下载安装包，安装类型为 none，跳过安装"
            return 0
        }
        default {
            throw "不支持的安装类型：$Type"
        }
    }

    $code = $process.ExitCode
    if ($successCodes -contains $code) { return $code }
    throw "安装程序返回失败退出码 $code"
}

# ---------------------------------------------------------------- 主流程

function Invoke-Main {
    $baseUrl = $Server.TrimEnd('/')
    $index = @(Get-InstalledPrograms)

    Write-Log "已读取本机 $(@($index).Count) 个已安装程序" 'INFO'

    Write-Log "拉取软件清单：$baseUrl/api/apps"
    $response = Invoke-RestMethod -Uri "$baseUrl/api/apps" -Method Get -UseBasicParsing -TimeoutSec 60
    if (-not $response -or -not $response.PSObject.Properties['apps']) {
        throw "服务返回的数据格式不正确"
    }

    $list = @($response.apps)
    if ($App) {
        $list = @($list | Where-Object {
                $item = $_
                ($App | Where-Object { $item.name -like $_ }).Count -gt 0
            })
    }

    Write-Log "待处理软件：$($list.Count) 个" 'INFO'
    if ($list.Count -eq 0) {
        Write-Log "没有匹配的软件，结束。" 'WARN'
        return 0
    }

    $okCount = 0
    $skipCount = 0
    $failCount = 0

    foreach ($item in $list) {
        $name = [string]$item.name
        Write-Log "=== $name ===" 'STEP'

        try {
            $installed = Find-InstalledApp -Name $name -Index $index
            $installedVersion = if ($installed) { [string]$installed.DisplayVersion } else { '' }

            if ($installed) {
                Write-Log "本机已安装：$($installed.DisplayName) 版本 $installedVersion"
            }
            else {
                Write-Log "本机未检测到安装记录"
            }

            $comparison = Compare-AppVersion -Installed $installedVersion -Target ([string]$item.version)
            $installDir = Get-InstallDir -Configured ([string]$item.installDir) -AppName $name -Root $InstallRoot

            if ($item.installerType -eq 'zip' -and -not $Force -and (Test-Path -LiteralPath $installDir)) {
                Write-Log "解压目录已存在，跳过：$installDir" 'OK'
                $skipCount++
                continue
            }

            if (-not $Force -and $comparison -ge 0) {
                if ([string]::IsNullOrWhiteSpace([string]$item.version)) {
                    Write-Log "已安装且未指定目标版本，跳过" 'OK'
                }
                else {
                    Write-Log "已是目标版本 $($item.version)，跳过" 'OK'
                }
                $skipCount++
                continue
            }

            $action = if ($installed) { '升级' } else { '安装' }
            if ($DryRun) {
                Write-Log "[DryRun] 需要$action 到版本 $($item.version)，目标目录 $installDir" 'WARN'
                $skipCount++
                continue
            }

            $path = Get-PackageFile -Url ([string]$item.downloadUrl) -TargetDir $DownloadDir `
                -Type ([string]$item.installerType) -AppName $name -ExpectedHash ([string]$item.sha256)

            if ($item.sha256) {
                $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($actual -ne ([string]$item.sha256).ToLowerInvariant()) {
                    throw "SHA256 校验失败：期望 $($item.sha256)，实际 $actual"
                }
                Write-Log "SHA256 校验通过"
            }

            $type = Resolve-InstallerType -Declared ([string]$item.installerType) -FilePath $path

            if (@('msi', 'exe', 'zip') -contains $type) {
                if (-not (Test-Path -LiteralPath $installDir)) {
                    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
                }
                Write-Log "安装目录：$installDir"
            }

            $code = Invoke-Installer -FilePath $path -Type $type -SilentArgs ([string]$item.silentArgs) `
                -InstallDir $installDir

            if ($code -eq 3010 -or $code -eq 1641) {
                Write-Log "$name $action 成功，需要重启系统后生效" 'WARN'
            }
            else {
                Write-Log "$name $action 成功" 'OK'
            }
            $okCount++
        }
        catch {
            $failCount++
            Write-Log "$name 处理失败：$($_.Exception.Message)" 'ERROR'
        }
    }

    Write-Log "完成：成功 $okCount / 跳过 $skipCount / 失败 $failCount" $(if ($failCount -gt 0) { 'ERROR' } else { 'OK' })

    if ($failCount -gt 0) { return 1 }
    return 0
}

# ---------------------------------------------------------------- 入口

Initialize-Log

if (-not (Test-Administrator)) {
    Write-Log "当前不是管理员权限，安装可能失败。建议以管理员身份运行 PowerShell。" 'WARN'
}

try {
    $exitCode = Invoke-Main
}
catch {
    Write-Log "执行中断：$($_.Exception.Message)" 'ERROR'
    $exitCode = 1
}

exit $exitCode
