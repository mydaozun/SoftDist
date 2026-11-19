# SoftDist · 软件分发系统

基于 **Cloudflare Workers + D1 + Workers Assets** 的轻量软件分发系统：管理端在网页里维护「软件名称 + 下载链接」写入数据库，Windows 客户端读取清单后自动比对版本、下载并**静默安装**。

```
        ┌────────────────────────────┐
        │  Cloudflare Worker         │
 浏览器  │  ├─ /             管理前端  │  ← Workers Assets（public/）
 ──────▶ │  ├─ /user.html    只读用户页│  ← 勾选软件生成安装命令
        │  ├─ /api/apps     公开读   │  ← D1
        │  └─ /api/admin/*  鉴权写   │
        └──────────┬─────────────────┘
                   │
        ┌──────────▼──────────┐        ┌────────────────────┐
        │  D1 (SQLite) apps   │        │ 安装包直链          │
        └─────────────────────┘        │ GitHub Release / CDN│
                                       └─────────┬──────────┘
                                                 │ HTTPS / UNC
                                       ┌─────────▼──────────┐
                                       │ Install-Agent.ps1  │ 静默安装
                                       └────────────────────┘
```

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/index.ts` | Worker：路由、鉴权、校验、D1 CRUD |
| `public/` | 前端：`index.html` 管理台（登录 + 卡片列表 + 新增/编辑/删除）、`user.html` 只读用户下载页 |
| `migrations/0001_init.sql` | D1 建表脚本 |
| `public/Install-Agent.ps1` | Windows 静默安装客户端（同时对外提供 `/Install-Agent.ps1` 下载） |
| `wrangler.jsonc` | Worker / 静态资源 / D1 绑定配置 |

## 一、部署（不用 GitHub Actions，一条命令发布）

```bash
npm install
npx wrangler login

# 1. 创建 D1，把返回的 database_id 填进 wrangler.jsonc
npx wrangler d1 create soft-dist

# 2. 建表
npx wrangler d1 migrations apply soft-dist --remote

# 3. 设置管理员 Token（前端登录用，自己生成一串长随机字符）
npx wrangler secret put ADMIN_TOKEN

# 4. 发布
npm run deploy
```

发布后得到 `https://soft-dist.<你的子域>.workers.dev`，打开即进入管理后台。

> 若已有自定义域名，在 Cloudflare 面板的 Workers 路由里绑定即可。

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # Windows: copy .dev.vars.example .dev.vars
npm run db:local
npm run dev                      # http://127.0.0.1:8787
```

## 二、管理前端

1. 输入 `ADMIN_TOKEN` 登录（Token 只存在浏览器 `sessionStorage`，关闭标签页即失效）。
2. **+ 新增软件** 填写：
   - **软件名称**：必须与「控制面板 → 程序和功能」里的显示名一致（或为其前缀），客户端靠它判断是否已安装。
   - **分类**：可选（≤40 字符），管理台与用户页会据此显示筛选按钮，用户页按分类分组展示。
   - **下载链接**：`https://…`、`\\fileserver\share\app.exe` 或 `C:\pkg\app.exe`。
   - **安装类型**：`msi` / `exe` / `ps1` / `msix` / `msstore` / `zip` / `none` / `auto`（按扩展名推断；商店链接自动按 `msstore` 处理）。
   - **微软商店应用**：下载链接填 `https://apps.microsoft.com/detail/<产品ID>`，客户端会调用 `winget install --id <产品ID> --source msstore` 安装，不需要填静默参数；目标机器需自带 winget（Win11 及 Win10 21H2+ 默认有）。
   - **静默参数**：可留空。客户端会识别安装包类型并套用默认值（NSIS `/S`、Inno Setup `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`、InstallShield `/s`、WiX `/quiet`、Squirrel `--silent`，识别不出按 NSIS 处理）；也可手填覆盖。
   - **安装目录**：留空则安装到 `C:\APP\<软件名>`；也可填 `D:\Tools\Foo` 等绝对路径。
   - **SHA256**：可选，填了客户端就会校验，防止下载被篡改。
3. 「启用」开关控制客户端是否可见，停用即下线该软件。

### API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 否 | 健康检查 |
| GET | `/api/apps?name=` | 否 | 客户端清单，仅返回已启用项 |
| POST | `/api/admin/login` | Bearer | 校验 Token |
| GET | `/api/admin/apps` | Bearer | 全部软件（含停用） |
| POST | `/api/admin/apps` | Bearer | 新增 |
| PUT | `/api/admin/apps/:id` | Bearer | 更新（支持部分字段） |
| DELETE | `/api/admin/apps/:id` | Bearer | 删除 |

## 三、Windows 客户端

客户端脚本随站点一起托管在 `<你的域名>/Install-Agent.ps1`。**以管理员身份**打开 CMD 或 PowerShell，直接粘贴页面生成的命令即可，无需事先下载脚本：

```powershell
# 安装/升级全部软件
powershell -ExecutionPolicy Bypass -Command "iwr 'https://soft-dist.xxx.workers.dev/Install-Agent.ps1' -OutFile C:\Windows\Temp\Install-Agent.ps1 -UseBasicParsing; & C:\Windows\Temp\Install-Agent.ps1 -Server 'https://soft-dist.xxx.workers.dev'"

# 只处理指定软件（支持通配符）
powershell -ExecutionPolicy Bypass -Command "iwr 'https://soft-dist.xxx.workers.dev/Install-Agent.ps1' -OutFile C:\Windows\Temp\Install-Agent.ps1 -UseBasicParsing; & C:\Windows\Temp\Install-Agent.ps1 -Server 'https://soft-dist.xxx.workers.dev' -App '7-Zip','Google*'"

# 只看会做什么，不实际下载安装
powershell -ExecutionPolicy Bypass -Command "iwr 'https://soft-dist.xxx.workers.dev/Install-Agent.ps1' -OutFile C:\Windows\Temp\Install-Agent.ps1 -UseBasicParsing; & C:\Windows\Temp\Install-Agent.ps1 -Server 'https://soft-dist.xxx.workers.dev' -DryRun"
```

也可以把脚本下载到本地后运行（`C:\Windows\Temp` 需要管理员权限写入，脚本本身也要求管理员）：

```powershell
iwr "https://soft-dist.xxx.workers.dev/Install-Agent.ps1" -OutFile C:\SoftDist\Install-Agent.ps1 -UseBasicParsing
powershell -ExecutionPolicy Bypass -File C:\SoftDist\Install-Agent.ps1 -Server "https://soft-dist.xxx.workers.dev" -App "7-Zip","Google*"
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-Server` | 必填 | 服务地址 |
| `-App` | 全部 | 按名称过滤，支持通配符 |
| `-DownloadDir` | `%ProgramData%\SoftDist\cache` | 安装包缓存目录 |
| `-InstallRoot` | `C:\APP` | 未单独配置安装目录时的默认根目录 |
| `-LogPath` | `%ProgramData%\SoftDist\install.log` | 日志文件 |
| `-Force` | 关 | 忽略版本比对强制重装 |
| `-DryRun` | 关 | 只打印计划动作 |

执行流程：读取注册表 Uninstall 项 → 与数据库版本比对（数值版本号比较） → 下载（已有缓存且哈希一致则复用） → SHA256 校验 → 静默安装 → 写日志。

### 各类型静默安装方式

| 类型 | 实际命令 |
| --- | --- |
| msi | `msiexec /i <包> /qn /norestart INSTALLDIR="<安装目录>" <静默参数>` |
| exe | `<包> <静默参数> /D=<安装目录>` |
| ps1 | `powershell -NoProfile -ExecutionPolicy Bypass -File <包> <静默参数>` |
| msix | `Add-AppxPackage -Path <包>` |
| msstore | `winget install --id <产品ID> --source msstore --accept-package-agreements --accept-source-agreements --silent` |
| zip | 解压到 `<安装目录>`，不执行安装 |
| none | 只下载不安装 |

安装目录规则：数据库里填了就优先用；没填则用 `-InstallRoot` 默认值拼软件名，即 `C:\APP\<软件名>`（非法文件名字符会替换为 `_`）。客户端会在安装前自动创建该目录。

不同安装器认的目录参数不同，客户端按类型自动拼接，但都可被「静默参数」覆盖：

- **MSI**：默认追加 `INSTALLDIR="..."`。若该 MSI 用的是 `APPLICATIONFOLDER`、`TARGETDIR` 等属性，直接在静默参数里写 `APPLICATIONFOLDER="D:\Foo"`，客户端检测到后不再追加。
- **NSIS exe**：默认在末尾追加 `/D=<目录>`（NSIS 要求 `/D=` 必须最后且不能带引号）。
- **Inno Setup exe**：把 `/DIR="D:\Foo"` 写进静默参数（客户端检测到 `/DIR=` 或 `/D=` 后不再追加）。
- **msix**：系统托管安装位置，目录参数不生效。

常见静默参数：NSIS ` /S`，Inno Setup `/VERYSILENT /NORESTART`，InstallShield `/s /v"/qn"`，MSI 已内置 `/qn`。成功退出码：`0`、`3010`、`1641`（后两者表示需重启）。

### 定时执行

用任务计划程序以 SYSTEM 账户每天运行一次即可（无需 GitHub Actions）：

```powershell
schtasks /create /tn "SoftDist" /tr "powershell -ExecutionPolicy Bypass -File C:\SoftDist\Install-Agent.ps1 -Server https://soft-dist.xxx.workers.dev" /sc daily /st 03:00 /ru SYSTEM /rl HIGHEST
```

## 四、安全说明

- 管理写入只靠 `ADMIN_TOKEN`，请使用足够长的随机串；需要更强防护时在前面套 Cloudflare Access。
- 客户端读取接口是公开的（只返回已启用软件的名称与链接），如需限制，可在 Worker 里加客户端 Token 或用 WAF 规则限制来源 IP。
- 强烈建议为每个安装包填 SHA256；链接建议用 HTTPS，避免中间人替换安装包。
- 安装包直链的可用性由存放方保证（GitHub Release / 对象存储 / 内网共享），本系统不代理流量。
- `zip` 类型没有注册表记录，客户端靠解压目录是否存在判断，删除目录后会重新解压。

## 五、常见问题

| 现象 | 原因 |
| --- | --- |
| 登录报 401 | `ADMIN_TOKEN` 未设置或输入不一致，重新 `wrangler secret put ADMIN_TOKEN` 并 redeploy |
| 数据库绑定为D1 | DB-softdist |
| 接口 500「数据库尚未初始化」 | 未执行 `npm run db:remote` |
| 客户端一直重复安装 | 软件名称与「程序和功能」显示名不一致，改成精确名称或其前缀 |
| exe 安装失败并提示未配置静默参数 | 在后台补上该 exe 的静默参数 |
| 装到 C:\APP 时报拒绝访问 | 该目录需要管理员权限，请以管理员身份运行客户端 |
| 中文乱码 | 客户端脚本已保存为 UTF-8 with BOM，请勿用会去掉 BOM 的编辑器另存 |


