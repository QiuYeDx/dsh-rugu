// 核心打不开时的管理页（§13.1、§13.2）：只读、没有脚本、没有任何记忆内容，只有出错的代码和几个状态数字。
// 和正式的管理页一样只经 ctx.connection.fetch.register 注册（只给主人），同一个路径：主人从 DSH 设置里打开「记忆」就能看到插件没在工作。
import crypto from 'node:crypto';
import { ROUTES } from './handlers.js';

const HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-resource-policy': 'same-origin',
});
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const code = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || 'Error';

/** 常见的打不开的原因（核心和存储层的错误码）→ 给主人的一句话。 */
const HINTS = Object.freeze({
  STORE_LOCKED: '数据库被别的进程占着（另一个 DSH 实例，或者上次没退干净）。关掉另一个，再重载插件。',
  BACKUP_FAILED: '升级数据库之前的自动备份没做成（多半是磁盘满了）：没有升级，也没有改动任何数据。腾出空间后重载插件。',
  ENOSPC: '磁盘满了。腾出空间后重载插件。',
  EACCES: '数据目录没有读写权限。',
  EPERM: '数据目录没有读写权限。',
});

/**
 * @param {{error?: string|null, status?: object|null, at: number}} o
 */
export function renderFallbackPage(o) {
  const err = code(o.error);
  const st = o.status ?? {};
  const eg = st.egress ?? {};
  const adapters = Array.isArray(st.adapters) ? st.adapters : [];
  const rows = [
    ['往公开的地方说、被改口的次数', eg.coreDownDenied ?? 0],
    ['审不了、照常放行的次数', eg.coreDownPassed ?? 0],
    ['没分类的工具照常放行的次数', eg.unclassifiedPassed ?? 0],
    ['冻结桥接记忆拦下的次数', eg.frozenDenied ?? 0],
  ];
  const nonce = crypto.randomBytes(12).toString('base64');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>记忆插件没有启动</title><style nonce="${nonce}">
body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}.box{border-color:#5a1e1e;background:#2a1215}td{border-color:#30363d}}
.box{border:1px solid #f0b4b4;background:#fff5f5;border-radius:8px;padding:12px 16px;max-width:720px}
table{border-collapse:collapse;margin-top:12px}td{border-bottom:1px solid #d0d7de;padding:4px 12px 4px 0}code{font-family:ui-monospace,monospace}
</style></head><body>
<div class="box"><h2>记忆插件没有启动（<code>${esc(err)}</code>）</h2>
<p>${esc(HINTS[err] ?? '数据库没有打开。详细原因看 DSH 日志里 persona-memory 的 core.open 那一行（只有错误类型，没有内容）。')}</p>
<p>这段时间：不感知、不注入；她在原来的对话里照常聊天；往别的场合说的话（发到别的群、私聊、公开评论、定时任务）一律先不说，因为审不了。插件重载、数据库打开之后自动恢复。</p></div>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(Number(v) || 0)}</td></tr>`).join('')}
${adapters.map((a) => `<tr><td>入口 ${esc(String(a.id ?? '?').slice(0, 32))}</td><td>${esc(a.error ? code(a.error) : a.disabled ? '停用' : '已登记，等数据库')}</td></tr>`).join('')}
</table><p><small>${esc(new Date(o.at).toISOString())}</small></p></body></html>`;
  return { html, csp: `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'` };
}

/**
 * 注册只读的状态页（ROUTES.page）和数据接口（ROUTES.data，返回 {ok:false, code:'NOT_READY'}）。没有 connection 服务就什么都不注册。
 * @param {object} ctx
 * @param {{host?: {status?: () => object}, error?: string|null, now?: () => number, log?: {info: Function, warn: Function}}} opts
 * @returns {() => void}
 */
export function registerFallbackAdmin(ctx, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  let conn = null;
  try { conn = ctx?.connection ?? ctx?.get?.('connection') ?? null; } catch { conn = null; }
  if (typeof conn?.fetch?.register !== 'function') return () => {};
  const status = () => { try { return opts.host?.status?.() ?? null; } catch { return null; } };
  const disposers = [];
  const page = () => {
    const { html, csp } = renderFallbackPage({ error: opts.error, status: status(), at: now() });
    return new Response(html, { status: 200, headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp } });
  };
  const data = () => new Response(JSON.stringify({ ok: false, code: 'NOT_READY', error: `记忆插件没有启动（${code(opts.error)}）` }),
    { status: 503, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' } });
  try {
    for (const [p, fn] of [[ROUTES.page, page], [ROUTES.data, data]]) {
      const d = conn.fetch.register({ path: p, methods: ['GET'], requestBody: 'buffered', fetch: (request) => (request?.method && request.method !== 'GET' ? new Response('', { status: 405, headers: HEADERS }) : fn()) });
      if (typeof d === 'function') disposers.push(d);
    }
  } catch (e) {
    for (const d of disposers.splice(0)) { try { d(); } catch { /* 尽力 */ } }
    try { opts.log?.warn?.('admin.fallback', { error: e?.code ?? e?.name ?? 'Error' }); } catch { /* 忽略 */ }
    return () => {};
  }
  try { opts.log?.info?.('admin.fallback.registered', { error: code(opts.error) }); } catch { /* 忽略 */ }
  return () => { for (const d of disposers.splice(0).reverse()) { try { d(); } catch { /* 尽力 */ } } };
}
