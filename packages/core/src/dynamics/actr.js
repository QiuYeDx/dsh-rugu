// 纯函数（没有数据库、没有 core）：ACT-R 基础激活（每条痕迹自己的衰减率 + Petrov 2006 聚合近似）、回想概率、
// 可复现的 logistic 噪声、成立概率 p_hold、本地日和时间格。index.js 和测试都用它们，数值回归（§6.7）也只测这里。
import crypto from 'node:crypto';
import { encodeParts } from '../contract/ids.js';
import { DEFAULTS } from '../config/defaults.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * @typedef {{t: number, w: number, d: number}} Trace
 * @typedef {{k?: number, n: number, w: number, first: number|null, last: number|null, d: number|null}} Bin
 * @typedef {{n: number, w: number, first: number|null, last: number|null, d: number|null, bins?: Bin[]}} Agg
 * @typedef {{traces: Trace[], agg: Agg}} State
 * @typedef {{ageFloorMin: number, timeUnitMs: number}} AgeParams
 * @typedef {{a: number, c: number, dMax: number}} DecayParams
 */

export const emptyAgg = () => ({ n: 0, w: 0, first: null, last: null, d: null, bins: [] });
// 聚合项按衰减率分箱（每箱宽 0.05）：每条痕迹的 d 不同（Pavlik），只用一个平均 d 会把慢衰减的老痕迹压低（x^(−d) 对 d 是凸的），
// 长期激活偏低 0.1–0.2；分箱后每箱各用 Petrov 近似，误差 < 0.01。这是近似的分辨率，不是行为参数。
const BIN_WIDTH = 0.05;

/** age（时间单位，默认小时），下限 ageFloorMin 分钟（§6.3）。 */
export function ageIn(at, t, p) {
  const floor = (p.ageFloorMin * MINUTE_MS) / p.timeUnitMs;
  return Math.max((at - t) / p.timeUnitMs, floor);
}

/**
 * 聚合项对 Σ w·age^(−d) 的贡献（Petrov 2006）：并进来的 n 条痕迹看成在 [first, last] 里均匀分布，
 * Σ ≈ W / (a_hi − a_lo) · ∫ x^(−d̄) dx。只有一条、或者都在同一时刻时就是精确值。
 * @param {Agg} g
 */
export function aggregateSum(g, at, p) {
  if (!g || !(g.n > 0) || !(g.w > 0)) return 0;
  if (Array.isArray(g.bins) && g.bins.length) return g.bins.reduce((sum, b) => sum + petrov(b, at, p), 0);
  return petrov(g, at, p);
}

/** 一组 d 相近的痕迹：均匀分布在 [first, last] 里的 Petrov 近似。 */
function petrov(g, at, p) {
  if (!g || !(g.n > 0) || !(g.w > 0) || g.first == null || g.first > at) return 0;
  const d = Number.isFinite(g.d) ? g.d : 0.3;
  const last = Math.min(g.last ?? g.first, at);
  const aLo = ageIn(at, last, p);
  const aHi = Math.max(ageIn(at, g.first, p), aLo);
  if (g.n === 1 || aHi - aLo < 1e-9) return g.w * Math.pow(aLo, -d);
  const integral = Math.abs(1 - d) < 1e-9 ? Math.log(aHi / aLo) : (Math.pow(aHi, 1 - d) - Math.pow(aLo, 1 - d)) / (1 - d);
  return (g.w / (aHi - aLo)) * integral;
}

/** Σ w_j · age_j^(−d_j)（只算 at 之前的痕迹）。 */
export function traceSum(state, at, p) {
  let sum = 0;
  for (const tr of state?.traces ?? []) {
    if (!(tr.t <= at) || !(tr.w > 0)) continue;
    sum += tr.w * Math.pow(ageIn(at, tr.t, p), -tr.d);
  }
  return sum + aggregateSum(state?.agg, at, p);
}

/** B = ln Σ w_j · age_j^(−d_j)；没有任何痕迹返回 -Infinity。 */
export function baseActivationOf(state, at, p) {
  const s = traceSum(state, at, p);
  return s > 0 ? Math.log(s) : -Infinity;
}

/** d_j = a + c·e^min(m_{j−1}, 3)，上限 dMax；写入前没有任何激活（第一条）时 d = a（Pavlik & Anderson 2005）。 */
export function decayFor(mPrev, p) {
  if (!Number.isFinite(mPrev)) return p.a;
  return Math.min(p.dMax, p.a + p.c * Math.exp(Math.min(mPrev, 3)));
}

/**
 * 按时间顺序重算 traces[from..] 的衰减率：每条用「写入前一刻」的激活（聚合项 + 更早的精确痕迹）。
 * 迟到的证据插到中间时，后面的痕迹要重算，这样结果和按时间顺序到达时一样（§6.4「迟到的处理不改变结果」）。
 * 只改传进来的数组（traces 必须已按 t 升序）。
 * @param {Trace[]} traces
 * @param {Agg} agg
 * @param {AgeParams & DecayParams} p
 * @param {number} [from]
 * @param {(tr: Trace) => boolean} [skip]  不重算的痕迹（继承来的，衰减率是在旧版本里定下的）
 */
export function replayDecays(traces, agg, p, from = 0, skip = null) {
  for (let j = Math.max(0, from); j < traces.length; j++) {
    if (skip?.(traces[j])) continue;
    const prior = { traces: traces.slice(0, j), agg };
    traces[j].d = decayFor(baseActivationOf(prior, traces[j].t, p), p);
  }
  return traces;
}

/** 把一条痕迹（或另一个聚合项）并进聚合项。d 按权重取平均。 */
export function mergeAgg(g, x) {
  const n = x.n ?? 1;
  const w = x.w;
  if (!(w > 0) || !(n > 0)) return g;
  const out = mergeScalar(g, x);
  const bins = (Array.isArray(g.bins) ? g.bins : []).map((b) => ({ ...b }));
  // 老数据（没有分箱）先整体当成一箱
  if (!bins.length && g.n > 0) bins.push({ k: binKey(g.d), n: g.n, w: g.w, first: g.first, last: g.last, d: g.d });
  const parts = Array.isArray(x.bins) && x.bins.length ? x.bins
    : x.t != null ? [{ n: 1, w: x.w, first: x.t, last: x.t, d: x.d }]
      : [{ n: x.n, w: x.w, first: x.first, last: x.last, d: x.d }];
  for (const part of parts) {
    const k = binKey(part.d);
    const i = bins.findIndex((b) => b.k === k);
    if (i < 0) bins.push({ k, ...mergeScalar({ n: 0, w: 0, first: null, last: null, d: null }, part) });
    else bins[i] = { k, ...mergeScalar(bins[i], part) };
  }
  bins.sort((p, q) => p.k - q.k);
  return { ...out, bins };
}
const binKey = (d) => Math.round((Number.isFinite(d) ? d : 0) / BIN_WIDTH);
function mergeScalar(g, x) {
  const n = x.n ?? 1;
  const w = x.w;
  const first = x.first ?? x.t;
  const last = x.last ?? x.t;
  const d = x.d;
  const total = g.w + w;
  return {
    n: g.n + n,
    w: total,
    first: g.first == null ? first : Math.min(g.first, first),
    last: g.last == null ? last : Math.max(g.last, last),
    d: g.d == null || !(g.w > 0) ? d : (g.d * g.w + d * w) / total,
  };
}

/** 精确痕迹超过 K 条时，最旧的并进聚合项（traces 按 t 升序，原地修改；返回被并进去的）。 */
export function foldOldest(traces, agg, K) {
  const folded = [];
  let g = agg;
  while (traces.length > Math.max(1, K)) {
    const tr = traces.shift();
    folded.push(tr);
    g = mergeAgg(g, tr);
  }
  return { agg: g, folded };
}

/**
 * 一串「又遇到了一次」（不经过来源窗口）→ 痕迹状态。§6.7 的数值演示和测试用。
 * @param {{t: number, w: number}[]} events
 * @param {AgeParams & DecayParams & {exactTraces?: number}} p
 * @returns {State}
 */
export function stateFromEvents(events, p) {
  const sorted = [...events].sort((x, y) => x.t - y.t);
  let agg = emptyAgg();
  const traces = [];
  for (const e of sorted) {
    traces.push({ t: e.t, w: e.w, d: p.a });
    replayDecays(traces, agg, p, traces.length - 1);
    ({ agg } = foldOldest(traces, agg, p.exactTraces ?? DEFAULTS.activation.exactTraces));
  }
  return { traces, agg };
}

/** P = σ((A − τ)/s)。 */
export function pRecall(A, tau, s) {
  if (A === -Infinity || Number.isNaN(A)) return 0;
  if (A === Infinity) return 1;
  if (!(s > 0)) return A >= tau ? 1 : 0;
  return 1 / (1 + Math.exp(-(A - tau) / s));
}

/** parts → (0, 1) 里的一个确定的数（sha256，52 位）。 */
export function uniformFrom(parts) {
  const h = crypto.createHash('sha256').update(encodeParts(...parts)).digest();
  const hi = h.readUInt32BE(0) & 0xfffff;   // 20 位
  const lo = h.readUInt32BE(4);             // 32 位
  return (hi * 2 ** 32 + lo + 0.5) / 2 ** 52;
}

/** 可复现的 logistic 噪声（尺度 s）：ε = s · ln(u / (1 − u))。 */
export function seededNoise(parts, s) {
  if (!(s > 0)) return 0;
  const u = uniformFrom(parts);
  return s * Math.log(u / (1 - u));
}

/**
 * 成立概率（§5.4）：超过 valid_to_known 为 0；没有 t50（稳定类）为 1；还没开始（at < valid_from）也按 1
 * （还没开始衰减，「将来时」由渲染看 valid_from 决定）；否则 2^(−((t − t0)/t50)^shape)，change_known 再乘系数。
 * t0 = valid_from 和 confirmed_at（最近一次被本人确认还成立，D142）里较晚的那个：确认把衰减重新算起，但不改「什么时候成立的」。
 */
export function pHoldOf(a, at, changeKnownFactor) {
  if (a.valid_to_known != null && at >= a.valid_to_known) return 0;
  let p = 1;
  const t50 = Number(a.t50_h);
  if (a.t50_h != null && Number.isFinite(t50) && t50 > 0) {
    const from = a.valid_from ?? a.recorded_at;
    const t0 = Number.isFinite(a.confirmed_at) && (from == null || a.confirmed_at > from) ? a.confirmed_at : from;
    if (t0 != null && at > t0) {
      const shape = Number.isFinite(Number(a.shape)) && Number(a.shape) > 0 ? Number(a.shape) : 1;
      p = Math.pow(2, -Math.pow((at - t0) / (t50 * HOUR_MS), shape));
    }
  }
  if (a.change_known) p *= changeKnownFactor;
  return Math.min(1, Math.max(0, p));
}

/** 本地时区相对 UTC 的偏移（毫秒）。tzOffsetMin = null 时用本机时区（随日期变，含夏令时）。 */
export function tzOffsetMs(at, tzOffsetMin) {
  return (tzOffsetMin == null ? -new Date(at).getTimezoneOffset() : tzOffsetMin) * MINUTE_MS;
}
/** 本地日期 'YYYY-MM-DD'。 */
export function localDay(at, tzOffsetMin) {
  return new Date(at + tzOffsetMs(at, tzOffsetMin)).toISOString().slice(0, 10);
}
/** 按本地时间对齐的时间格编号（来源窗口用：同一条记忆每个 6 小时格最多一条）。 */
export function slotOf(at, slotMs, tzOffsetMin) {
  return Math.floor((at + tzOffsetMs(at, tzOffsetMin)) / slotMs);
}
