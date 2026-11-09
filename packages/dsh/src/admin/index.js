// 管理页（§13.1、§9.3.7、§12.4、§13.2、§13.3）：DSH 设置侧边栏的「记忆」。
//   registerAdmin(ctx, {pm, host}) → dispose
// 只注册主人专用的 Fetch 路由（ctx.connection.fetch.register：先过 DSH 的 /api 围栏和 Cookie，再要求 owner），
// **绝不**用 webServer.register（它不鉴权，还会绕过 /api 的围栏，§10.2 F19、附录 G）。没有 connection 服务就什么都不注册（fail closed）。
// 侧边栏里的入口在 client.js（DSH 的浏览器模块，用 iframe 打开 ROUTES.page），由 package.json 的 "./client" 导出。
import path from 'node:path';
import { createAdminHandlers, ROUTES, TOKEN_HEADER } from './handlers.js';
import { registerFallbackAdmin, renderFallbackPage } from './fallback.js';

export { ROUTES, TOKEN_HEADER, createAdminHandlers, registerFallbackAdmin, renderFallbackPage };

/**
 * 宿主给管理页的那一半（host 集成层实现）。每个方法可以同步也可以返回 Promise；缺了哪一块，页面上那一块就显示「不可用」。
 * @typedef {object} AdminHost   DSH 宿主的实现是 host/index.js 的 hostApi（接口说明见 docs/实现/模块与接口.md §9）
 * @property {{dataDir?: string, exportDir?: string, configFile?: string}} [paths]
 * @property {() => object} status            宿主状态（钩子熔断、调度、降级级别分布 degrade、上次自检 {at, level, fails, warns}……），只有数字和短状态
 * @property {(o?: {force?: boolean}) => Promise<{at: number, level: string, items: object[]}>} selfCheck
 *           启动自检的结果（§13.2）：不带 force 给上一次的结果，force=true 重新检查
 * @property {{status: () => object, setPolicy: (p: 'off'|'on'|'adaptive'|{policy?: string, gameMode?: {on: boolean, hours?: number}, confirm?: boolean}) => unknown}} gpu
 *           显卡策略（§8.6.2）和游戏模式
 * @property {{status: () => object}} budget  预算用量、预设、余额天数（§10.6，ports/budget.js 的 status()）
 * @property {{get: () => object, set: (patch: object, o: {confirm: boolean, replace?: string[]}) => unknown}} config
 *           配置（热加载）。get() 给核心参数表（顶层）+ host + meta:{file, warnings, loadError}；也认 {core, host, warnings, loadError}。
 *           管理页只会改 mode.*、budget.preset 和 budget.overrides（D121）、sleep.growth.mode、context.usageStyle（D125）、backup.offsiteDir；confirm=true 表示主人在页面上确认过；
 *           replace 里的路径整个换成补丁里的值（budget.overrides 回到预设时清空）。
 *           宿主不肯写时抛 {code: 'CONFIRM_REQUIRED', needsConfirm: string[]} / {code: 'CONTRACT'} / {code: 'UNAVAILABLE'}，
 *           或者返回 {ok: false, needsConfirm? | rejected? | warnings}，两种都认。
 */

/**
 * 注册管理页的路由。
 * @param {object} ctx   Cordis 上下文（要有 connection 服务）
 * @param {{pm: object|null, host?: AdminHost, exportDir?: string, dataDir?: string, log?: {info: Function, warn: Function, error?: Function}, now?: () => number, setupMode?: boolean}} opts
 *        setupMode：首次设置（D128）：还没有核心（pm = null），页面只有向导、嵌入和桥接几条接口
 *        exportDir：导出 JSONL 放哪儿（默认 <dataDir>/backup/export，和核心的月度导出同一个目录；dataDir 不给就用 host.paths.dataDir
 *        或 host.status().dataDir）。log：记录端口（只记事件名和计数），不给就用 ctx.logger
 * @returns {() => void}   dispose：撤掉全部路由
 */
export function registerAdmin(ctx, opts) {
  const { pm, host } = opts ?? {};
  const log = opts?.log ?? loggerOf(ctx);
  const conn = connectionOf(ctx);
  if (typeof conn?.fetch?.register !== 'function') {
    try { log.warn('admin.unavailable', { reason: 'no-connection' }); } catch { /* 忽略 */ }
    return () => {};
  }
  // 导出目录：和核心的月度导出同一个（<数据目录>/backup/export）。数据目录从参数、host.paths 或宿主状态里的 dataDir 拿，用到时才查
  const exportDir = () => {
    if (typeof opts?.exportDir === 'string' && opts.exportDir) return opts.exportDir;
    if (typeof host?.paths?.exportDir === 'string' && host.paths.exportDir) return host.paths.exportDir;
    let dataDir = opts?.dataDir ?? host?.paths?.dataDir ?? null;
    if (!dataDir) { try { dataDir = host?.status?.()?.dataDir ?? null; } catch { dataDir = null; } }
    return typeof dataDir === 'string' && dataDir ? path.join(dataDir, 'backup', 'export') : null;
  };
  const h = createAdminHandlers({ pm, host, log, exportDir, now: opts?.now, setupMode: opts?.setupMode === true });
  const routes = [
    [ROUTES.page, ['GET'], h.page],
    [ROUTES.data, ['GET'], h.data],
    [ROUTES.act, ['POST'], h.act],
    [ROUTES.file, ['GET'], h.file],
  ];
  const disposers = [];
  const dispose = () => {
    for (const d of disposers.splice(0).reverse()) { try { d(); } catch { /* 尽力 */ } }
    h.dispose();
  };
  try {
    for (const [p, methods, fn] of routes) {
      const d = conn.fetch.register({ path: p, methods, requestBody: 'buffered', fetch: (request) => fn(request) });
      if (typeof d === 'function') disposers.push(d);
    }
  } catch (e) {
    dispose();
    throw e;
  }
  try { log.info('admin.registered', { routes: routes.length }); } catch { /* 忽略 */ }
  return dispose;
}

function connectionOf(ctx) {
  if (!ctx) return null;
  try { return ctx.connection ?? ctx.get?.('connection') ?? null; } catch { return null; }
}

/** Cordis 的 logger（字符串）→ 记录端口的形状（事件名 + 只有 id 和计数的字段）。 */
function loggerOf(ctx) {
  const l = ctx?.logger;
  const fmt = (ev, f) => `[persona-memory] ${ev}${f ? ` ${JSON.stringify(f)}` : ''}`;
  return {
    info: (ev, f) => { try { l?.info?.(fmt(ev, f)); } catch { /* 忽略 */ } },
    warn: (ev, f) => { try { l?.warn?.(fmt(ev, f)); } catch { /* 忽略 */ } },
    error: (ev, f) => { try { l?.error?.(fmt(ev, f)); } catch { /* 忽略 */ } },
  };
}
