(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const INSTALLER_LABEL = {
    auto: '自动推断',
    msi: 'MSI',
    exe: 'EXE',
    ps1: '脚本',
    msix: 'MSIX',
    msstore: '微软商店',
    zip: '压缩包',
    none: '仅下载',
  };

  let apps = [];
  let activeCategory = '';
  let searchTerm = '';
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

  /**
   * 生成客户端命令。
   * 1) 用 -Command 而非 -File：-File 无法把 `'A','B'` 绑定成数组，会拼成一个 "A,B" 导致匹配不到软件。
   * 2) 先把脚本下载到固定路径再执行，用户无需本地准备 Install-Agent.ps1。
   * 3) 全部路径写死不使用 $env: 变量，保证 CMD 与 PowerShell 粘贴都能正确执行。
   * PowerShell 单引号字符串里的 ' 需要写成 ''。
   */
  function buildCommand(names) {
    const origin = location.origin;
    const local = 'C:\\Windows\\Temp\\Install-Agent.ps1';
    const invoke = `iwr '${origin}/Install-Agent.ps1' -OutFile ${local} -UseBasicParsing; & ${local} -Server '${origin}'`;
    const base = `powershell -ExecutionPolicy Bypass -Command "${invoke}"`;
    if (!names.length) return base;
    const list = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
    return `powershell -ExecutionPolicy Bypass -Command "${invoke} -App ${list}"`;
  }

  const isStoreApp = (app) => /^https?:\/\/(apps\.microsoft\.com|www\.microsoft\.com\/store)/i.test(app.downloadUrl || '');

  function storeProductId(app) {
    const match = String(app.downloadUrl || '').match(/(?:detail|apps)\/([A-Z0-9]{12})(?:[/?#]|$)/i);
    return match ? match[1].toUpperCase() : '';
  }

  /** 微软商店应用单独生成 winget 命令，与安装包软件的命令分开执行 */
  function buildStoreCommand(storeApps) {
    return storeApps
      .map((app) => {
        const id = storeProductId(app);
        return id ? `winget install --id ${id} --source msstore --accept-package-agreements --accept-source-agreements --silent` : '';
      })
      .filter(Boolean)
      .join('; ');
  }

  function syncBar() {
    const selected = apps.filter((app) => picked.has(app.name));
    const useAll = selected.length === 0;
    const target = useAll ? apps : selected;
    const storeApps = target.filter(isStoreApp);
    const restApps = target.filter((app) => !isStoreApp(app));

    $('cmd-rest').hidden = restApps.length === 0;
    $('user-command').textContent = restApps.length ? buildCommand(restApps.map((app) => app.name)) : '';

    $('cmd-store').hidden = storeApps.length === 0;
    $('store-command').textContent = storeApps.length ? buildStoreCommand(storeApps) : '';

    $('pick-title').textContent = useAll
      ? `未选择 · 将安装全部 ${apps.length} 个软件`
      : `已选 ${selected.length} 个软件`;

    if (!storeApps.length) {
      $('pick-hint').textContent = selected.length
        ? '在目标 Windows 机器上以管理员身份执行下面的命令，只会安装勾选的软件。'
        : '勾选需要的软件即可生成对应的安装命令；未勾选时命令会安装全部已启用软件。';
      return;
    }
    $('pick-hint').textContent = restApps.length
      ? '安装包软件与微软商店应用分成两条命令，请分别以管理员身份执行。'
      : '微软商店应用通过 winget 安装，需要目标机器带有 winget（App Installer）。';
  }

  function cardHtml(app, index) {
    const isStore = /^https?:\/\/(apps\.microsoft\.com|www\.microsoft\.com\/store)/i.test(app.downloadUrl);
    const meta = [
      ['类型', INSTALLER_LABEL[app.installerType] || app.installerType],
      ['目录', isStore ? '微软商店（winget）' : app.installDir || `C:\\APP\\${app.name}`],
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

  function categories() {
    return [...new Set(apps.map((app) => app.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function matchesSearch(app) {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return true;
    return [app.name, app.version, app.description, app.category, app.installDir].some((value) =>
      String(value || '').toLowerCase().includes(term)
    );
  }

  function visibleApps() {
    const list = apps.filter(matchesSearch);
    return activeCategory ? list.filter((app) => app.category === activeCategory) : list;
  }

  function renderFilter() {
    const list = categories();
    const bar = $('cat-filter');
    if (!list.length) {
      bar.hidden = true;
      activeCategory = '';
      return;
    }
    if (activeCategory && !list.includes(activeCategory)) activeCategory = '';
    bar.hidden = false;
    bar.innerHTML = [['', `全部 ${apps.length}`]]
      .concat(list.map((name) => [name, `${name} ${apps.filter((app) => app.category === name).length}`]))
      .map(
        ([value, label]) =>
          `<button class="cat-chip${activeCategory === value ? ' is-active' : ''}" type="button" data-category="${escapeHtml(value)}">${escapeHtml(label)}</button>`
      )
      .join('');
  }

  function render() {
    renderFilter();

    const groups = new Map();
    for (const app of visibleApps()) {
      const key = app.category || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(app);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b, 'zh-CN');
    });

    $('grid').innerHTML = keys
      .map((key) => {
        const items = groups.get(key);
        const title = key || '未分类';
        return `<section class="cat-group">
          <h2 class="cat-group-title">${escapeHtml(title)}<span>${items.length}</span></h2>
          <div class="cat-group-grid">${items.map(cardHtml).join('')}</div>
        </section>`;
      })
      .join('');

    $('empty').hidden = visibleApps().length > 0;
    if (!$('empty').hidden) {
      const filtering = Boolean(activeCategory || searchTerm.trim());
      $('empty-title').textContent = filtering && apps.length ? '没有匹配的软件' : '暂无可下载的软件';
      $('empty-hint').textContent =
        filtering && apps.length ? '换个关键词或分类试试。' : '管理员在控制台添加并启用软件后，这里就会出现。';
    }
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

  $('search').addEventListener('input', (event) => {
    searchTerm = event.target.value;
    render();
  });

  $('cat-filter').addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-category]');
    if (!chip) return;
    activeCategory = chip.dataset.category;
    render();
  });

  $('select-all').addEventListener('click', () => {
    const visible = visibleApps();
    if (!visible.length) return toast('暂无可选软件', true);
    visible.forEach((app) => picked.add(app.name));
    render();
  });

  $('select-none').addEventListener('click', () => {
    visibleApps().forEach((app) => picked.delete(app.name));
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

  $('copy-store-btn').addEventListener('click', async () => {
    const text = $('store-command').textContent;
    if (await copyText(text)) {
      toast('商店安装命令已复制');
    } else {
      toast('复制失败，请手动选择文本', true);
    }
  });

  load();
})();
