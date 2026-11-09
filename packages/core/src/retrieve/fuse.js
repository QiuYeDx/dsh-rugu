// 融合和去重（§8.3 第 1、5 步）：两个纯函数。
import { parseRef } from '../store/refs.js';

const SIGNAL_OF = { dense: 'dense', lexical: 'bm25', entity: 'ppr', time: 'timeHit', present: 'present' };

/**
 * RRF：每一路第 r 名得 1/(k + r)，各路相加；按和降序，留 ≤ keep 条（§8.3 第 1 步，向量:279）。
 * 同一路里同一条出现多次（比如稠密路的记忆层和原文层）只算最好的名次。同分按最好名次、再按引用排，结果确定。
 * @param {import('./index.js').RouteResult[]} routes
 * @param {{k: number, keep: number}} params
 * @returns {import('../core-types.js').Candidate[]}
 */
export function fuse(routes, params) {
  const k = Number.isFinite(params?.k) ? params.k : 60;
  const keep = Number.isFinite(params?.keep) ? params.keep : 200;
  /** @type {Map<string, import('../core-types.js').Candidate & {best: number}>} */
  const by = new Map();
  for (const r of routes ?? []) {
    if (!r || !Array.isArray(r.hits)) continue;
    const seen = new Set();
    let rank = 0;
    for (const h of r.hits) {
      if (!h || typeof h.ref !== 'string' || seen.has(h.ref)) continue;
      const mref = parseRef(h.ref);
      if (!mref) continue;
      seen.add(h.ref);
      rank += 1;
      let c = by.get(h.ref);
      if (!c) {
        c = { ref: h.ref, mref, ranks: /** @type {any} */ ({}), rrf: 0, signals: {}, best: Infinity };
        by.set(h.ref, c);
      }
      c.ranks[r.route] = rank;
      c.rrf += 1 / (k + rank);
      c.best = Math.min(c.best, rank);
      const sig = SIGNAL_OF[r.route];
      if (sig && Number.isFinite(h.score)) c.signals[sig] = Math.max(c.signals[sig] ?? -Infinity, h.score);
    }
  }
  return [...by.values()]
    .sort((a, b) => b.rrf - a.rrf || a.best - b.best || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .slice(0, Math.max(0, keep))
    .map(({ best, ...c }) => c);
}

/**
 * MMR 去重（λ ≈ 0.7，§8.3 第 5 步）：每次挑 λ·score − (1−λ)·max sim(已选) 最大的。同分取输入里靠前的。
 * 【补】params.dup(a, b)：挑中的这一条和已选的某一条「几乎一样」（a 是挑中的，b 是已选的）时不进结果、不占名额
 * （MMR 只是往后排，名额够时两条几乎一样的照样都选上）；调用方在 dup 里记下合并到了谁。
 * @template T
 * @param {T[]} items                   已按分数降序
 * @param {{lambda: number, sim: (a: T, b: T) => number, score: (x: T) => number, limit: number, dup?: (a: T, b: T) => boolean}} params
 * @returns {T[]}
 */
export function mmr(items, params) {
  const list = Array.isArray(items) ? items : [];
  const lambda = Number.isFinite(params?.lambda) ? params.lambda : 0.7;
  const limit = Math.min(list.length, Number.isFinite(params?.limit) ? Math.max(0, params.limit) : list.length);
  const score = params.score;
  const sim = params.sim;
  const dup = typeof params.dup === 'function' ? params.dup : null;
  const rel = list.map((x) => { const v = Number(score(x)); return Number.isFinite(v) ? v : 0; });
  const maxSim = new Array(list.length).fill(0);
  const taken = new Array(list.length).fill(false);
  const out = [];
  while (out.length < limit) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < list.length; i++) {
      if (taken[i]) continue;
      const v = lambda * rel[i] - (1 - lambda) * maxSim[i];
      if (v > bestVal) { bestVal = v; best = i; }
    }
    if (best < 0) break;
    taken[best] = true;
    if (dup && out.some((s) => { try { return dup(list[best], s) === true; } catch { return false; } })) continue;
    out.push(list[best]);
    for (let i = 0; i < list.length; i++) {
      if (taken[i]) continue;
      const s = Number(sim(list[i], list[best]));
      if (Number.isFinite(s) && s > maxSim[i]) maxSim[i] = s;
    }
  }
  return out;
}
