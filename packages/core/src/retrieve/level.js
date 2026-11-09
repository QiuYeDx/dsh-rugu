// 降级级别（§8.8）和查询嵌入的熔断。
//   L0 完整（GPU 有空，能重排）/ L1 不重排 / L2 CPU 稠密（常态）/ L3 无嵌入（端口缺失、熔断、空间可疑或还没建）/ L4 存储故障。
// 熔断记在 state.retrieve.breaker（本模块自己观察到的查询嵌入结果）：连续 2 次失败后 60 秒内不调，之后放一次探测（§8.8）。
// 稠密路可不可用以 worker.health 为准（D40）：worker 线程挂了时 embedQuery 照样给向量（嵌入服务是好的），只有稠密扫描降级，
// 所以「这一轮是不是 L3」不能靠查询向量是不是 null 来判断。
import { budgetLimits } from '../config/defaults.js';
import { errKind, log, metric, wall } from './util.js';

// worker.health 会数一遍嵌入队列，聊天路径上每轮都问太贵：结果在本模块的状态里留这么久（墙钟毫秒；线程挂掉 / 熔断这种状态
// 本来就以秒计，晚一两秒标 L3 不影响结果，那一轮稠密路自己也拿不到东西）
const HEALTH_TTL_MS = 2000;

/**
 * worker 报的稠密路状态。拿不到（替身没有这个函数、出错、形状不对）返回 null：不知道，按别的条件判断。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{dense: boolean, scan: boolean}|null}  dense：稠密路整体可用（worker.health().dense）；
 *          scan：向量扫描本身能跑（线程挂了、退回 fallback 就不能；嵌入熔断时扫描还能用伪查询向量跑）
 */
export function denseHealth(core) {
  const st = core.state.retrieve;
  const now = wall();
  if (st?.health && now - st.health.t < HEALTH_TTL_MS) return st.health.v;
  let v = null;
  try {
    const h = core.mods.worker.health(core);
    if (h && typeof h.dense === 'boolean') v = { dense: h.dense, scan: h.mode !== 'fallback' };
  } catch (e) {
    log(core, 'debug', 'retrieve.health.unavailable', { error: errKind(e) });
    v = null;
  }
  if (st) st.health = { t: now, v };
  return v;
}

/** 存储能不能用（打不开、关了、查询报错 → L4）。 */
export function storeOk(core) {
  try {
    if (!core.store || core.store.closed) return false;
    core.store.get('SELECT 1 AS ok');
    return true;
  } catch { return false; }
}

/** 当前活动的向量空间（status='active'）；没有就看有没有可疑的（suspect）。 */
export function activeSpace(core) {
  try {
    return core.store.get(
      "SELECT space_id AS spaceId, status FROM vector_spaces WHERE status IN ('active','suspect') ORDER BY status = 'active' DESC, created_at DESC LIMIT 1") ?? null;
  } catch { return null; }
}

export function breakerOpen(core) {
  const br = core.state.retrieve?.breaker;
  return !!br && br.openUntil > core.now();
}

/** 嵌入这条路现在用不用得上（不可用 → L3）。 */
export function embeddingUsable(core) {
  if (!core.ports.embedding) return false;
  if (!core.vectors) return false;              // 向量库打不开：只是缓存，降到 L3
  if (breakerOpen(core)) return false;
  const sp = activeSpace(core);
  return !!sp && sp.status === 'active';
}

export function embeddingInfo(core) {
  try { return core.ports.embedding?.info?.() ?? null; } catch { return null; }
}

/** 重排能不能用（端口在、资源管家允许、预算预设没关）。 */
export function rerankUsable(core) {
  const rr = core.ports.rerank;
  if (!rr) return false;
  try {
    if (budgetLimits(core.config.get()).rerank === false) return false;
    return !!rr.available();
  } catch { return false; }
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @returns {0|1|2|3|4}
 */
export function staticLevel(core) {
  if (!storeOk(core)) return 4;
  if (!embeddingUsable(core)) return 3;
  // worker 说稠密路不可用（线程挂了、它那边的嵌入熔断、活动空间生成不了查询向量）：L3
  if (denseHealth(core)?.dense === false) return 3;
  const info = embeddingInfo(core);
  if (!info || info.device !== 'gpu') return 2;   // 没报设备的按 CPU（常态）算
  if (!rerankUsable(core)) return 1;
  return 0;
}

/**
 * 查询嵌入（经 worker），顺带维护熔断。端口缺失、熔断、超时、失败都返回 null（调用方降到 L3）。
 * 只有「很快就失败」才算一次失败；等到截止才没结果的是冷模型或太慢，不算（冷启动按 L3 过这一轮，§8.8）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} texts
 * @param {{deadlineMs: number, signal?: AbortSignal}} opt
 * @returns {Promise<{spaceId: string, vectors: Float32Array[]}|null>}
 */
export async function embedQueryTracked(core, texts, opt) {
  const st = core.state.retrieve;
  const cfgB = core.config.get().recall.embedBreaker;
  if (!core.ports.embedding || !texts.length) return null;
  if (breakerOpen(core)) return null;
  const ms = Math.max(1, Math.floor(opt.deadlineMs));
  const t0 = wall();
  let r = null;
  try {
    r = await core.mods.worker.embedQuery(core, texts, { deadlineMs: ms, signal: opt.signal });
  } catch (e) {
    r = null;
    log(core, 'debug', 'retrieve.embed.error', { error: errKind(e) });
  }
  const elapsed = wall() - t0;
  const br = st.breaker;
  if (r && Array.isArray(r.vectors) && r.vectors.length === texts.length && r.spaceId) {
    br.failures = 0;
    br.openUntil = 0;
    return r;
  }
  if (opt.signal?.aborted) return null;   // 调用方放弃的（截止、回合取消）不算失败
  // 很快就空手回来，但嵌入这条路本来就用不上（没有活动空间、空间可疑、worker 那边熔断着）：这是状态，不是这一次失败了，
  // 不再叠一层熔断（实测问题 #1：空间被判可疑时，这里每次「很快失败」都算一次，又把本模块的熔断打开）
  if (elapsed < ms * 0.9 && (!embeddingUsable(core) || denseHealth(core)?.dense === false)) return null;
  if (elapsed < ms * 0.9) {
    br.failures += 1;
    if (br.failures >= cfgB.failures) {
      br.openUntil = core.now() + cfgB.coolMs;
      br.failures = cfgB.failures - 1;   // 冷却后放一次探测：再失败一次立刻又熔断
      metric(core, 'retrieve.embed.breakerOpen');
      log(core, 'warn', 'retrieve.embed.breaker', { coolMs: cfgB.coolMs });
    }
  }
  return null;
}
