export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  ASSETS: Fetcher;
}

type InstallerType = 'auto' | 'msi' | 'exe' | 'ps1' | 'msix' | 'zip' | 'msstore' | 'none';

interface AppRow {
  id: number;
  name: string;
  version: string;
  description: string;
  download_url: string;
  installer_type: string;
  silent_args: string;
  install_dir: string;
  sha256: string;
  category: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const INSTALLER_TYPES: InstallerType[] = ['auto', 'msi', 'exe', 'ps1', 'msix', 'zip', 'msstore', 'none'];
const MAX_BODY_BYTES = 32 * 1024;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function fail(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间比较，避免通过响应耗时猜测 Token */
async function tokensMatch(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = (env.ADMIN_TOKEN ?? '').trim();
  if (!token || !expected) return false;
  return tokensMatch(token, expected);
}

function toApi(row: AppRow) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    downloadUrl: row.download_url,
    installerType: row.installer_type,
    silentArgs: row.silent_args,
    installDir: row.install_dir,
    sha256: row.sha256,
    category: row.category,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isAllowedSource(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return true;
  if (/^\\\\[\w.$-]+\\/.test(value)) return true; // UNC 共享路径
  if (/^[a-zA-Z]:\\/.test(value)) return true; // 本地绝对路径
  return false;
}

interface AppInput {
  name: string;
  version: string;
  description: string;
  downloadUrl: string;
  installerType: InstallerType;
  silentArgs: string;
  installDir: string;
  sha256: string;
  category: string;
  enabled: boolean;
}

function parseInput(raw: unknown, partial: boolean): { ok: true; value: Partial<AppInput> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '请求体必须是 JSON 对象' };
  const body = raw as Record<string, unknown>;
  const out: Partial<AppInput> = {};

  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 100) return { ok: false, error: '软件名称长度需在 1-100 字符之间' };
    out.name = name;
  }

  if (body.version !== undefined || !partial) {
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    if (version.length > 50) return { ok: false, error: '版本号不能超过 50 字符' };
    out.version = version;
  }

  if (body.description !== undefined) {
    const desc = typeof body.description === 'string' ? body.description.trim() : '';
    if (desc.length > 500) return { ok: false, error: '描述不能超过 500 字符' };
    out.description = desc;
  } else if (!partial) {
    out.description = '';
  }

  if (body.downloadUrl !== undefined || !partial) {
    const url = typeof body.downloadUrl === 'string' ? body.downloadUrl.trim() : '';
    if (!url) return { ok: false, error: '下载链接不能为空' };
    if (url.length > 2000) return { ok: false, error: '下载链接过长' };
    if (!isAllowedSource(url)) return { ok: false, error: '下载链接只支持 http(s)://、\\\\共享路径 或 C:\\ 本地路径' };
    out.downloadUrl = url;
  }

  if (body.installerType !== undefined || !partial) {
    const type = typeof body.installerType === 'string' ? body.installerType.trim().toLowerCase() : 'auto';
    if (!INSTALLER_TYPES.includes(type as InstallerType)) {
      return { ok: false, error: `安装类型必须是 ${INSTALLER_TYPES.join(' / ')}` };
    }
    out.installerType = type as InstallerType;
  }

  if (body.silentArgs !== undefined || !partial) {
    const args = typeof body.silentArgs === 'string' ? body.silentArgs.trim() : '';
    if (args.length > 500) return { ok: false, error: '静默参数不能超过 500 字符' };
    out.silentArgs = args;
  }

  if (body.installDir !== undefined || !partial) {
    const raw = typeof body.installDir === 'string' ? body.installDir.trim() : '';
    if (raw.length > 260) return { ok: false, error: '安装目录不能超过 260 字符' };
    if (raw && !/^[a-zA-Z]:\\/.test(raw) && !/^\\\\[\w.$-]+\\/.test(raw)) {
      return { ok: false, error: '安装目录必须是绝对路径，例如 C:\\APP\\App' };
    }
    let dir = raw;
    if (dir.length > 3) dir = dir.replace(/[\\/]+$/, '');
    out.installDir = dir;
  }

  if (body.sha256 !== undefined || !partial) {
    const sha = typeof body.sha256 === 'string' ? body.sha256.trim().toLowerCase() : '';
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) return { ok: false, error: 'SHA256 必须是 64 位十六进制字符串' };
    out.sha256 = sha;
  }

  if (body.category !== undefined) {
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (category.length > 40) return { ok: false, error: '分类不能超过 40 字符' };
    out.category = category;
  } else if (!partial) {
    out.category = '';
  }

  if (body.enabled !== undefined || !partial) {
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    out.enabled = enabled;
  }

  return { ok: true, value: out };
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: '请求体过大' };
  if (!text.trim()) return { ok: false, error: '请求体为空' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' };
  }
}

async function handlePublicList(env: Env, url: URL): Promise<Response> {
  const name = (url.searchParams.get('name') ?? '').trim();
  const stmt = name
    ? env.DB.prepare('SELECT * FROM apps WHERE enabled = 1 AND name LIKE ? ORDER BY name COLLATE NOCASE').bind(`%${name}%`)
    : env.DB.prepare('SELECT * FROM apps WHERE enabled = 1 ORDER BY name COLLATE NOCASE');
  const { results } = await stmt.all<AppRow>();
  return json({
    ok: true,
    apps: (results ?? []).map(toApi),
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAdminList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM apps ORDER BY name COLLATE NOCASE').all<AppRow>();
  return json({ ok: true, apps: (results ?? []).map(toApi) });
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return fail(body.error);
  const parsed = parseInput(body.value, false);
  if (!parsed.ok) return fail(parsed.error);
  const input = parsed.value as AppInput;

  try {
    const result = await env.DB.prepare(
      `INSERT INTO apps (name, version, description, download_url, installer_type, silent_args, install_dir, sha256, category, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        input.name,
        input.version,
        input.description,
        input.downloadUrl,
        input.installerType,
        input.silentArgs,
        input.installDir,
        input.sha256,
        input.category,
        input.enabled ? 1 : 0
      )
      .run();

    const row = await env.DB.prepare('SELECT * FROM apps WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first<AppRow>();
    return json({ ok: true, app: row ? toApi(row) : null }, 201);
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) return fail('已存在同名软件，请直接编辑该条目', 409);
    throw error;
  }
}

async function handleUpdate(request: Request, env: Env, id: number): Promise<Response> {
  const existing = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>();
  if (!existing) return fail('软件不存在', 404);

  const body = await readJson(request);
  if (!body.ok) return fail(body.error);
  const parsed = parseInput(body.value, true);
  if (!parsed.ok) return fail(parsed.error);
  const patch = parsed.value as Partial<AppInput>;

  const merged = {
    name: patch.name ?? existing.name,
    version: patch.version ?? existing.version,
    description: patch.description ?? existing.description,
    downloadUrl: patch.downloadUrl ?? existing.download_url,
    installerType: patch.installerType ?? existing.installer_type,
    silentArgs: patch.silentArgs ?? existing.silent_args,
    installDir: patch.installDir ?? existing.install_dir,
    sha256: patch.sha256 ?? existing.sha256,
    category: patch.category ?? existing.category,
    enabled: patch.enabled ?? existing.enabled === 1,
  };

  try {
    await env.DB.prepare(
      `UPDATE apps
          SET name = ?, version = ?, description = ?, download_url = ?, installer_type = ?,
              silent_args = ?, install_dir = ?, sha256 = ?, category = ?, enabled = ?, updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(
        merged.name,
        merged.version,
        merged.description,
        merged.downloadUrl,
        merged.installerType,
        merged.silentArgs,
        merged.installDir,
        merged.sha256,
        merged.category,
        merged.enabled ? 1 : 0,
        id
      )
      .run();

    const row = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>();
    return json({ ok: true, app: row ? toApi(row) : null });
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) return fail('已存在同名软件', 409);
    throw error;
  }
}

async function handleDelete(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM apps WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return fail('软件不存在', 404);
  return json({ ok: true });
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (path === '/api/health') {
    return json({ ok: true, service: 'soft-dist', time: new Date().toISOString() });
  }

  // 客户端读取接口（公开，只返回已启用的软件）
  if (path === '/api/apps' && method === 'GET') {
    return handlePublicList(env, url);
  }

  // 管理员登录校验：前端仅用于验证 Token 是否正确，不签发会话
  if (path === '/api/admin/login' && method === 'POST') {
    if (!(await isAuthorized(request, env))) return fail('Token 无效', 401);
    return json({ ok: true });
  }

  if (path.startsWith('/api/admin/')) {
    if (!(await isAuthorized(request, env))) return fail('未授权：缺少或错误的 Bearer Token', 401);

    if (path === '/api/admin/apps') {
      if (method === 'GET') return handleAdminList(env);
      if (method === 'POST') return handleCreate(request, env);
      return fail('方法不允许', 405);
    }

    const match = path.match(/^\/api\/admin\/apps\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      if (method === 'PUT') return handleUpdate(request, env, id);
      if (method === 'DELETE') return handleDelete(env, id);
      return fail('方法不允许', 405);
    }
  }

  return fail('接口不存在', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }
    try {
      return await route(request, env, url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no such table')) {
        return fail('数据库尚未初始化，请先执行迁移：npm run db:remote', 500);
      }
      return fail(`服务器内部错误：${message}`, 500);
    }
  },
};
