// 回忆（D155、D156）共用的小工具：把一段时间等分成几段、一个时刻落在第几段。纯函数。

/**
 * 把跨度等分成 k 段（通用的、不按话题）：每段 {start, end, total}，total 是 rows 里落在这一段（按开始时间，早于跨度的算第一段）的条数。
 * 跨度不到一分钟时只有一段。
 * @param {{start: number, end: number}} span
 * @param {number} k
 * @param {{tStart: number}[]} [rows]
 */
export function cutSpan(span, k, rows = []) {
  const len = Math.max(1, span.end - span.start);
  const n = len < 60_000 ? 1 : Math.max(1, Math.floor(k));
  const segs = Array.from({ length: n }, (_, i) => ({ start: span.start + Math.floor((len * i) / n), end: span.start + Math.floor((len * (i + 1)) / n), total: 0 }));
  for (const r of rows ?? []) {
    const i = segOf(segs, r.tStart);
    if (i != null) segs[i].total += 1;
  }
  return segs;
}

/** 一个时刻落在第几段（早于第一段算第一段，晚于最后一段算最后一段）；不是数返回 null。 */
export function segOf(segs, t) {
  if (!segs.length || !Number.isFinite(t)) return null;
  for (let i = 0; i < segs.length; i++) if (t < segs[i].end) return i;
  return segs.length - 1;
}
