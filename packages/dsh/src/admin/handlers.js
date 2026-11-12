// 管理接口的 HTTP 层（§13.1）：四条精确的 Fetch 路由，全部经 ctx.connection.fetch.register 注册——
// DSH 先过自己的 /api 围栏（Host/Origin、Cookie），再要求 principal.kind === 'owner'，否则 403。
//   GET  /api/persona-memory/admin          管理页（一个自带样式和脚本的 HTML，CSP 带 nonce）
//   GET  /api/persona-memory/admin.data     只读视图：?view=overview|needToKnow|review|settings|rules|memories|memoryDays|memory|growth|backups|config|diagnostics
//   POST /api/persona-memory/admin.do       写操作：{action, ...参数, confirm?: {token, typed?}}
//   GET  /api/persona-memory/admin.export   下载导出的 JSONL：?name=pm-export-….jsonl
// 在 DSH 的鉴权之外再加两道（纵深防御）：
//   - 页面里带一个每个进程随机的令牌，数据、操作、下载三条路由都要求请求头 x-pm-admin 和它一致（只有拿得到页面的主人知道它；
//     自定义请求头也让跨站请求必须先过预检）；
//   - Sec-Fetch-Site 只收 same-origin / none；POST 只收 application/json、≤ 64 KB。
// 响应一律 no-store、nosniff。日志只记路由、操作名、状态码和错误类型，不记参数和返回的内容。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { InputError, isPlainObject } from './check.js';
import { ConfirmError, createConfirmStore } from './confirm.js';
import { createViews, codeOf } from './views.js';
import { createActions, exportFileName } from './actions.js';
import { renderPage, pageCsp } from './page.js';

export const ROUTES = Object.freeze({
  page: '/api/persona-memory/admin',
  data: '/api/persona-memory/admin.data',
  act: '/api/persona-memory/admin.do',
  file: '/api/persona-memory/admin.export',
});
export const TOKEN_HEADER = 'x-pm-admin';
const MAX_BODY = 64 * 1024;
/** 设置模式（D128，还没有核心）下只开这几条：向导本身、嵌入、QQ 桥接。 */
const SETUP_VIEWS = new Set(['setup', 'embeddingSetup', 'bridge']);
const SETUP_ACTIONS = new Set(['prepare', 'setup.finish', 'embedding.pull', 'embedding.pullCancel', 'embedding.test', 'embedding.save', 'bridge.apply', 'bridge.setDir']);

const BASE_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-resource-policy': 'same-origin',
});

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers } });
}
const fail = (status, code, error, extra = {}) => json(status, { ok: false, code, error, ...extra });

/** 错误 → 状态码。核心的错误按 code 判断（errors.js：只按 code，不按 message）。 */
function errorResponse(e) {
  const code = codeOf(e);
  if (e instanceof InputError) return fail(400, 'BAD_INPUT', e.message, { path: e.path });
  if (e instanceof ConfirmError) return fail(code === 'CONFIRM_MISMATCH' ? 422 : 428, code, e.message, e.reasons ? { reasons: e.reasons } : {});
  switch (code) {
    case 'CONTRACT': return fail(400, 'CONTRACT', String(e.message ?? '参数不合契约').slice(0, 300));
    case 'READ_ONLY': return fail(409, 'READ_ONLY', '数据库现在是只读的，不能改');
    case 'NOT_FOUND': return fail(404, 'NOT_FOUND', String(e.message ?? '没有找到').slice(0, 200));
    case 'BUSY': return fail(409, 'BUSY', String(e.message).slice(0, 200));
    case 'UNAVAILABLE': return fail(503, 'UNAVAILABLE', String(e.message).slice(0, 200));
    case 'TIMEOUT': return fail(504, 'TIMEOUT', '宿主没有及时响应');
    case 'CONFIRM_REQUIRED': return fail(428, 'CONFIRM_REQUIRED', String(e.message ?? '要先确认').slice(0, 200));
    case 'CONFIRM_MISMATCH': return fail(422, 'CONFIRM_MISMATCH', String(e.message ?? '确认语不对').slice(0, 200));
    case 'REJECTED': return fail(422, 'REJECTED', String(e.message ?? '宿主拒绝了这项改动').slice(0, 300));
    case 'CONFIG_WRITE': return fail(409, 'CONFIG_WRITE', String(e.message ?? '宿主没有保存这项设置').slice(0, 300));
    case 'GROWTH_NOT_APPLIED': return fail(409, code, String(e.message).slice(0, 200));
    case 'REVIEW_WITHDRAWN': return fail(409, code, String(e.message).slice(0, 200));
    case 'RangeError': return fail(404, 'NOT_FOUND', String(e.message).slice(0, 200));
    default:
      // 备份恢复的错误（RestoreError、BackupKeyError）带着自己的 code，信息是给人看的中文，不含记忆内容
      if (e?.name === 'RestoreError' || e?.name === 'BackupKeyError') return fail(422, code, String(e.message).slice(0, 300));
      return fail(500, 'INTERNAL', '内部错误（日志里只记了错误类型）');
  }
}

/** 浏览器的请求来源：只收同源的（DSH 自己的页面）和直接打开的。 */
function badSite(req) {
  const site = req.headers.get('sec-fetch-site');
  return site != null && site !== 'same-origin' && site !== 'none';
}

/**
 * @param {{pm: any, host?: any, now?: () => number, log?: {info: Function, warn: Function, error?: Function},
 *          exportDir?: string|null|(() => string|null), token?: string}} deps
 *        exportDir 可以是一个函数（用到时才查，查到就记住）
 */
export function createAdminHandlers(deps) {
  if (!deps?.pm?.admin && deps?.setupMode !== true) throw new TypeError('registerAdmin 需要 pm（核心 API）');
  const setupMode = deps.setupMode === true;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? { info() {}, warn() {}, error() {} };
  const token = deps.token ?? crypto.randomBytes(24).toString('base64url');
  const confirms = createConfirmStore({ now });
  let exportDirMemo = null;
  /** 导出目录（绝对路径）；没有配置返回 null。 */
  const exportDir = () => {
    if (exportDirMemo) return exportDirMemo;
    let d = null;
    try { d = typeof deps.exportDir === 'function' ? deps.exportDir() : deps.exportDir; } catch { d = null; }
    if (typeof d === 'string' && d) exportDirMemo = path.resolve(d);
    return exportDirMemo;
  };
  const views = createViews({ pm: deps.pm, host: deps.host ?? null, now, exportDir });
  const actions = createActions({ pm: deps.pm, host: deps.host ?? null, now, confirms, exportDir, views });
  const tokenBuf = Buffer.from(token);

  function authed(req) {
    const h = req.headers.get(TOKEN_HEADER);
    if (typeof h !== 'string') return false;
    const b = Buffer.from(h);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  }
  /** 一个请求记一行：路由、状态码、耗时，写操作再加操作名和错误类型。 */
  function note(fields) {
    try { (fields.status >= 500 ? log.warn : log.info).call(log, 'admin.request', fields); } catch { /* 日志失败不影响请求 */ }
  }
  /** 统一的外壳：方法、来源、令牌，最后兜住所有异常（永不外抛，§10.10）。meta 由处理函数填（操作名）。 */
  async function guarded(route, req, methods, { needToken = true } = {}, fn) {
    const t0 = now();
    const meta = {};
    let res;
    try {
      if (!methods.includes(req.method)) res = fail(405, 'METHOD', '不支持这个请求方法');
      else if (badSite(req)) res = fail(403, 'FORBIDDEN', '只接受 DSH 自己页面的请求');
      else if (needToken && !authed(req)) res = fail(403, 'FORBIDDEN', '缺少管理页令牌（请从 DSH 设置里打开「记忆」）');
      else res = await fn(meta);
    } catch (e) {
      res = errorResponse(e);
      meta.error = codeOf(e);
    }
    note({ route, status: res.status, ms: Math.max(0, now() - t0), ...meta });
    return res;
  }

  return {
    token,
    views,
    actions,
    confirms,

    /** GET 管理页。 */
    page(req) {
      return guarded('page', req, ['GET'], { needToken: false }, async () => {
        const nonce = crypto.randomBytes(18).toString('base64');
        const html = renderPage({ nonce, token });
        return new Response(html, { status: 200, headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp(nonce) } });
      });
    },

    /** GET 只读视图。 */
    data(req) {
      return guarded('data', req, ['GET'], {}, async () => {
        const url = new URL(req.url);
        const q = Object.fromEntries(url.searchParams);
        const view = q.view;
        if (typeof view !== 'string' || !views.names.includes(view)) throw new InputError('view', '不认识的视图');
        if (setupMode && !SETUP_VIEWS.has(view)) return fail(503, 'NOT_READY', '还没完成首次设置');
        delete q.view;
        const data = await views.run(view, q);
        return json(200, { ok: true, data });
      });
    },

    /** POST 写操作。 */
    act(req) {
      return guarded('act', req, ['POST'], {}, async (meta) => {
        const ct = req.headers.get('content-type') ?? '';
        if (!/^application\/json\b/i.test(ct)) return fail(415, 'MEDIA_TYPE', '请求体要是 JSON');
        const len = Number(req.headers.get('content-length') ?? 0);
        if (len > MAX_BODY) return fail(413, 'TOO_LARGE', '请求太大');
        const raw = await req.text();
        if (Buffer.byteLength(raw) > MAX_BODY) return fail(413, 'TOO_LARGE', '请求太大');
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw new InputError('body', '不是合法的 JSON'); }
        if (!isPlainObject(body)) throw new InputError('body', '应为对象');
        const action = typeof body.action === 'string' && /^[a-zA-Z.]{1,40}$/.test(body.action) ? body.action : null;
        if (!action) throw new InputError('action', '缺少 action');
        meta.action = action;
        if (setupMode && !SETUP_ACTIONS.has(action)) return fail(503, 'NOT_READY', '还没完成首次设置');
        if (action === 'prepare' && typeof body.for === 'string' && /^[a-zA-Z.]{1,40}$/.test(body.for)) meta.for = body.for;
        if (setupMode && action === 'prepare' && !SETUP_ACTIONS.has(body.for)) return fail(503, 'NOT_READY', '还没完成首次设置');
        const result = await actions.run(action, body);
        return json(200, { ok: true, result: result ?? {} });
      });
    },

    /** GET 下载导出文件（只认导出目录里、名字形如 pm-export-….jsonl 的文件）。 */
    file(req) {
      return guarded('file', req, ['GET'], {}, async () => {
        const dir = exportDir();
        if (!dir) return fail(503, 'UNAVAILABLE', '导出目录没有配置');
        const name = exportFileName(new URL(req.url).searchParams.get('name'));
        const file = path.join(dir, name);
        if (path.dirname(file) !== dir) throw new InputError('name', '文件名不对');
        let st;
        try { st = await fs.promises.stat(file); } catch { return fail(404, 'NOT_FOUND', '这个导出文件不在了'); }
        if (!st.isFile()) return fail(404, 'NOT_FOUND', '这个导出文件不在了');
        const body = Readable.toWeb(fs.createReadStream(file));
        return new Response(/** @type {any} */ (body), { status: 200, headers: { ...BASE_HEADERS,
          'content-type': name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/octet-stream',
          'content-length': String(st.size),
          'content-disposition': `attachment; filename="${name}"` } });
      });
    },

    dispose() { confirms.clear(); },
  };
}
