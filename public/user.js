(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const INSTALLER_LABEL = {
    auto: '自动推断',
    msi: 'MSI',
    exe: 'EXE',
    ps1: '脚本',
    msix: 'MSIX',
    zip: '压缩包',
    none: '仅下载',
  };

  let apps = [];
  const picked = new Set();

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  /** 生成客户端命令；PowerShell 单引号字符串里的 ' 需要写成 '' */
  function buildCommand(names) {
    const base = `powershell -ExecutionPolicy Bypass -File .\\Install-Agent.ps1 -Server "${location.origin}"`;
    if (!names.length) return base;
    const list = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
    return `${base} -App ${list}`;
  }

  function syncBar() {
    const names = apps.filter((app) => picked.has(app.name)).map((app) => app.name);
    $('user-command').textContent = buildCommand(names);
    $('pick-title').textContent = names.length ? `已选 ${names.length} 个软件` : `未选择 · 将安装全部 ${apps.length} 个软件`;
    $('pick-hint').textContent = names.length
      ? '在目标 Windows 机器上以管理员身份执行下面的命令，只会安装勾选的软件。'
      : '勾选需要的软件即可生成对应的安装命令；未勾选时命令会安装全部已启用软件。';
  }

  function cardHtml(app, index) {
    const meta = [
      ['类型', INSTALLER_LABEL[app.installerType] || app.installerType],
      ['目录', app.installDir || `C:\\APP\\${app.name}`],
    ]
      .map(([label, value]) => `<div class="meta-row"><b>${label}</b><span>${escapeHtml(value)}</span></div>`)
      .join('');

    return `
      <label class="glass app-card pick-card${picked.has(app.name) ? ' is-picked' : ''}" style="animation-delay:${Math.min(index, 8) * 40}ms">
        <div class="card-head">
          <div class="pick-name">
            <input type="checkbox" data-name="${escapeHtml(app.name)}"${picked.has(app.name) ? ' checked' : ''} />
            <span class="card-title">${escapeHtml(app.name)}</span>
          </div>
          ${app.version ? `<span class="card-version">v${escapeHtml(app.version)}</span>` : ''}
        </div>
        <p class="card-desc">${escapeHtml(app.description) || '暂无描述'}</p>
        <div class="card-meta">${meta}</div>
      </label>`;
  }

  function render() {
    const grid = $('grid');
    grid.innerHTML = apps.map(cardHtml).join('');
    $('empty').hidden = apps.length > 0;
    $('user-stat').textContent = `软件下载 · 共 ${apps.length} 个可安装`;
    syncBar();
  }

  async function load() {
    try {
      const res = await fetch('/api/apps');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      apps = Array.isArray(data.apps) ? data.apps : [];
      // 清理已不存在的勾选项
      for (const name of [...picked]) {
        if (!apps.some((app) => app.name === name)) picked.delete(name);
      }
      render();
    } catch (error) {
      apps = [];
      render();
      $('user-stat').textContent = '读取失败';
      toast(`读取软件列表失败：${error.message}`, true);
    }
  }

  /* ---------- 交互 ---------- */

  $('grid').addEventListener('change', (event) => {
    const input = event.target.closest('input[data-name]');
    if (!input) return;
    const name = input.dataset.name;
    if (input.checked) picked.add(name);
    else picked.delete(name);
    input.closest('.pick-card').classList.toggle('is-picked', input.checked);
    syncBar();
  });

  $('select-all').addEventListener('click', () => {
    if (!apps.length) return toast('暂无可选软件', true);
    apps.forEach((app) => picked.add(app.name));
    render();
  });

  $('select-none').addEventListener('click', () => {
    picked.clear();
    render();
  });

  $('copy-btn').addEventListener('click', async () => {
    const text = $('user-command').textContent;
    if (await copyText(text)) {
      toast('命令已复制');
    } else {
      toast('复制失败，请手动选择文本', true);
    }
  });

  load();
})();
