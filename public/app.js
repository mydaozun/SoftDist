(() => {
  'use strict';

  const TOKEN_KEY = 'softdist_admin_token';
  const $ = (id) => document.getElementById(id);

  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let apps = [];
  let editingId = null;
  let loading = false;
  let activeCategory = '';

  /* ---------- 基础工具 ---------- */

  const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });

  const INSTALLER_LABEL = {
    auto: '自动推断',
    msi: 'MSI',
    exe: 'EXE',
    ps1: '脚本',
    msix: 'MSIX',
    zip: '压缩包',
    none: '仅下载',
  };

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

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }

    if (!res.ok) {
      if (res.status === 401 && path !== '/api/admin/login') {
        logout();
        toast('登录已失效，请重新输入 Token', true);
      }
      throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
    }
    return data;
  }

  /* ---------- 视图切换 ---------- */

  function showLogin() {
    $('login-view').hidden = false;
    $('app-view').hidden = true;
    $('token-input').focus();
  }

  function updateClientCommand() {
    const origin = location.origin;
    $('client-command').textContent =
      `powershell -ExecutionPolicy Bypass -Command "iwr '${origin}/Install-Agent.ps1' -OutFile C:\\Windows\\Temp\\Install-Agent.ps1 -UseBasicParsing; & C:\\Windows\\Temp\\Install-Agent.ps1 -Server '${origin}'"`;
  }

  function showConsole() {
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('stat-line').textContent = '加载中…';
  }

  function logout() {
    token = '';
    activeCategory = '';
    sessionStorage.removeItem(TOKEN_KEY);
    apps = [];
    $('grid').innerHTML = '';
    $('token-input').value = '';
    showLogin();
  }

  /* ---------- 登录 ---------- */

  async function login(tokenValue) {
    const btn = $('login-btn');
    const errEl = $('login-error');
    errEl.hidden = true;
    btn.disabled = true;

    token = tokenValue.trim();
    try {
      await api('/api/admin/login', { method: 'POST' });
      sessionStorage.setItem(TOKEN_KEY, token);
      showConsole();
      await loadApps();
    } catch (error) {
      token = '';
      sessionStorage.removeItem(TOKEN_KEY);
      errEl.textContent = error.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- 列表 ---------- */

  async function loadApps() {
    if (loading) return;
    loading = true;
    const refreshBtn = $('refresh-btn');
    refreshBtn.disabled = true;

    try {
      const data = await api('/api/admin/apps');
      apps = data.apps || [];
      renderApps();
    } catch (error) {
      toast(error.message, true);
    } finally {
      loading = false;
      refreshBtn.disabled = false;
    }
  }

  function categories() {
    return [...new Set(apps.map((app) => app.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
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

  function renderApps() {
    const enabled = apps.filter((a) => a.enabled).length;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('stat-line').textContent = `共 ${apps.length} 个软件 · 已启用 ${enabled} · 更新于 ${time}`;

    renderFilter();

    const visible = activeCategory ? apps.filter((app) => app.category === activeCategory) : apps;

    const grid = $('grid');
    const empty = $('empty');
    empty.hidden = visible.length > 0;

    grid.innerHTML = visible
      .map((app, index) => {
        const typeLabel = INSTALLER_LABEL[app.installerType] || app.installerType;
        const installLine = app.silentArgs ? `${typeLabel} · ${app.silentArgs}` : typeLabel;
        const sha = app.sha256 ? `${app.sha256.slice(0, 12)}…` : '未设置';
        const source = app.downloadUrl.replace(/^https?:\/\//i, '');
        const target = app.installDir || `C:\\APP\\${app.name}`;

        return `
        <article class="app-card glass${app.enabled ? '' : ' is-disabled'}" style="animation-delay:${Math.min(index * 30, 240)}ms">
          <div class="card-head">
            <h3 class="card-title">${escapeHtml(app.name)}${app.category ? `<span class="cat-tag">${escapeHtml(app.category)}</span>` : ''}</h3>
            ${app.version ? `<span class="card-version">${escapeHtml(app.version)}</span>` : ''}
          </div>
          <p class="card-desc">${app.description ? escapeHtml(app.description) : '无描述'}</p>
          <div class="card-meta">
            <div class="meta-row"><b>来源</b><span title="${escapeHtml(app.downloadUrl)}">${escapeHtml(source)}</span></div>
            <div class="meta-row"><b>安装</b><span title="${escapeHtml(installLine)}">${escapeHtml(installLine)}</span></div>
            <div class="meta-row"><b>目录</b><span title="${escapeHtml(target)}">${escapeHtml(target)}</span></div>
            <div class="meta-row"><b>校验</b><span title="${escapeHtml(app.sha256 || '未设置')}">${escapeHtml(sha)}</span></div>
          </div>
          <div class="card-foot">
            <button class="pill ${app.enabled ? 'pill-on' : 'pill-off'}" type="button" data-action="toggle" data-id="${app.id}"
              aria-pressed="${app.enabled}" title="${app.enabled ? '点击停用' : '点击启用'}">${app.enabled ? '已启用' : '已停用'}</button>
            <div class="card-actions">
              <button class="btn btn-ghost" type="button" data-action="edit" data-id="${app.id}">编辑</button>
              <button class="btn btn-ghost btn-danger" type="button" data-action="delete" data-id="${app.id}">删除</button>
            </div>
          </div>
        </article>`;
      })
      .join('');
  }

  /* ---------- 弹窗表单 ---------- */

  function openModal(app) {
    editingId = app ? app.id : null;
    $('modal-title').textContent = app ? '编辑软件' : '新增软件';
    $('f-name').value = app ? app.name : '';
    $('f-version').value = app ? app.version : '';
    $('f-url').value = app ? app.downloadUrl : '';
    $('f-desc').value = app ? app.description : '';
    $('f-type').value = app ? app.installerType : 'auto';
    $('f-args').value = app ? app.silentArgs : '';
    $('f-category').value = app ? app.category || '' : '';
    $('f-dir').value = app ? app.installDir : '';
    $('f-sha').value = app ? app.sha256 : '';
    $('f-enabled').checked = app ? app.enabled : true;
    $('category-list').innerHTML = categories()
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join('');
    $('form-error').hidden = true;
    $('modal').hidden = false;
    setTimeout(() => $('f-name').focus(), 40);
  }

  function closeModal() {
    $('modal').hidden = true;
    editingId = null;
  }

  async function saveApp(event) {
    event.preventDefault();

    const payload = {
      name: $('f-name').value.trim(),
      version: $('f-version').value.trim(),
      downloadUrl: $('f-url').value.trim(),
      description: $('f-desc').value.trim(),
      installerType: $('f-type').value,
      silentArgs: $('f-args').value.trim(),
      category: $('f-category').value.trim(),
      installDir: $('f-dir').value.trim(),
      sha256: $('f-sha').value.trim(),
      enabled: $('f-enabled').checked,
    };

    const errorEl = $('form-error');
    errorEl.hidden = true;

    if (!payload.name || !payload.downloadUrl) {
      errorEl.textContent = '软件名称和下载链接不能为空';
      errorEl.hidden = false;
      return;
    }
    if (payload.installerType === 'exe' && !payload.silentArgs) {
      errorEl.textContent = 'exe 安装包必须填写静默参数（如 /S 或 /VERYSILENT /NORESTART），否则客户端无法静默安装';
      errorEl.hidden = false;
      return;
    }

    const saveBtn = $('save-btn');
    saveBtn.disabled = true;

    try {
      if (editingId === null) {
        await api('/api/admin/apps', { method: 'POST', body: JSON.stringify(payload) });
        toast('已新增软件');
      } else {
        await api(`/api/admin/apps/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('已保存修改');
      }
      closeModal();
      await loadApps();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function deleteApp(id) {
    const app = apps.find((item) => item.id === id);
    if (!app) return;
    if (!confirm(`确定删除「${app.name}」？该操作不可撤销。`)) return;

    try {
      await api(`/api/admin/apps/${id}`, { method: 'DELETE' });
      toast('已删除');
      await loadApps();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function toggleApp(id, btn) {
    const app = apps.find((item) => item.id === id);
    if (!app) return;

    btn.disabled = true;
    try {
      await api(`/api/admin/apps/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !app.enabled }),
      });
      toast(app.enabled ? `已停用「${app.name}」` : `已启用「${app.name}」`);
      await loadApps();
    } catch (error) {
      btn.disabled = false;
      toast(error.message, true);
    }
  }

  /* ---------- 事件绑定 ---------- */

  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    login($('token-input').value);
  });

  $('logout-btn').addEventListener('click', () => logout());
  $('refresh-btn').addEventListener('click', () => loadApps());
  $('add-btn').addEventListener('click', () => openModal(null));
  $('modal-close').addEventListener('click', closeModal);
  $('cancel-btn').addEventListener('click', closeModal);
  $('app-form').addEventListener('submit', saveApp);

  $('modal').addEventListener('click', (event) => {
    if (event.target.dataset.close === 'true') closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('modal').hidden) closeModal();
  });

  $('cat-filter').addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-category]');
    if (!chip) return;
    activeCategory = chip.dataset.category;
    renderApps();
  });

  $('grid').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (btn.dataset.action === 'edit') {
      const app = apps.find((item) => item.id === id);
      if (app) openModal(app);
    } else if (btn.dataset.action === 'delete') {
      deleteApp(id);
    } else if (btn.dataset.action === 'toggle') {
      toggleApp(id, btn);
    }
  });

  $('copy-btn').addEventListener('click', async () => {
    const text = $('client-command').textContent;
    if (await copyText(text)) {
      toast('命令已复制');
    } else {
      toast('复制失败，请手动选择文本', true);
    }
  });

  /* ---------- 启动 ---------- */

  updateClientCommand();

  if (token) {
    showConsole();
    api('/api/admin/login', { method: 'POST' })
      .then(() => loadApps())
      .catch(() => {
        token = '';
        sessionStorage.removeItem(TOKEN_KEY);
        showLogin();
      });
  } else {
    showLogin();
  }
})();
