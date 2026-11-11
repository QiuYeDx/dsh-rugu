// 「那段时间的经过」（D156，设计「回忆」§3.3）：人回忆一天的事，先想起的是「上午干了什么、中午跟谁吃的饭」，再往里想细节。
// 范围圈出来以后，把范围里的经历（事件情节）一段一句地按时间摆出来；她自己闲聊的原文窗口这类细节不在这一层。
//   - 一句话：情节的上下文头（提炼时写的，带人名和主要的事），开头的完整日期去掉（时间已经写在前面）；头是空的用「标题：叙述的第一句」；
//   - 某一段时间没有任何事件情节盖到时，用那段时间的小结、日记补；范围跨了 outline.dayLayerDays 天以上时先给日记、小结（一天一两行），
//     事件情节只补没有日记和小结的那几天；
//   - 选哪些行：照「盖住时间」，按段轮流取，段内按和线索的对题程度（范围内检索的名次；没检索到的排在段内最后、按时间均匀取）。
// 每一行对应一段情节（一条记忆），照常过关口①（在 context）。只读、同步。
import { rowsByIds } from './util.js';
import { segOf, cutSpan } from './recollect-util.js';

const DAY_MS = 86_400_000;

/**
 * 一段情节的一句话（梗概行的正文，不含时间和场合）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{header?: string, title?: string, narrative?: string}} row
 * @returns {string}
 */
export function outlineText(core, row) {
  const header = String(row?.header ?? '').replace(/\s+/gu, ' ').trim();
  if (header) {
    let t = header;
    try { t = core.mods.lang.stripLeadingDate(core, header); } catch { t = header; }
    if (t.trim()) return t.trim();
    // 头里只有日期：当它是空的
  }
  const title = String(row?.title ?? '').replace(/\s+/gu, ' ').trim();
  const first = firstSentence(row?.narrative);
  if (title && first) return `${title}：${first}`;
  return title || first;
}

/** 叙述的第一句（到第一个句末标点，含它）。 */
export function firstSentence(text) {
  const s = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!s) return '';
  const m = /^.*?[。！？!?；;](?=\s|$|[^。！？!?；;])/u.exec(s);
  return (m ? m[0] : s).trim();
}

/**
 * 范围里的经过（按选中的先后，每条带时间、所在的段、名次）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{rows: {ref: string, tStart: number, tEnd: number, settingKey: string|null}[]}} scope
 * @param {{ranks?: Map<string, number>|null, segments?: {start: number, end: number}[], span?: {start: number, end: number}|null,
 *          max: number, dayLayerDays?: number}} o
 * @returns {{ref: string, t: number, kind: string, seg: number|null, rank: number|null}[]}
 */
export function outlineRows(core, scope, o) {
  const max = Math.max(0, Math.floor(o.max ?? 0));
  if (!max) return [];
  const ids = (scope?.rows ?? []).filter((r) => r.ref.startsWith('e')).map((r) => Number(r.ref.slice(1))).filter(Number.isSafeInteger);
  if (!ids.length) return [];
  const eps = rowsByIds(core.store, 'SELECT id, ep_kind, t_start, t_end FROM episodes WHERE id IN (?*)', ids)
    .map((r) => ({ ref: `e${r.id}`, t: r.t_start, tEnd: Math.max(r.t_start, r.t_end), kind: r.ep_kind === 'import' ? 'event' : r.ep_kind }))
    .filter((r) => ['event', 'summary', 'diary'].includes(r.kind))
    .sort((a, b) => a.t - b.t || (a.ref < b.ref ? -1 : 1));
  if (!eps.length) return [];
  const span = o.span ?? { start: eps[0].t, end: Math.max(...eps.map((e) => e.tEnd)) };
  const segs = o.segments?.length ? o.segments : cutSpan(span, 6);
  const ranks = o.ranks instanceof Map ? o.ranks : new Map();
  const events = eps.filter((e) => e.kind === 'event');
  const others = eps.filter((e) => e.kind !== 'event');
  const days = (span.end - span.start) / DAY_MS;
  let pool;
  if (Number.isFinite(o.dayLayerDays) && days > o.dayLayerDays) {
    // 范围很大：一天先给日记，没有日记给小结；这几天都没有的，再用那天的事件情节
    const dayOf = (t) => Math.floor(t / DAY_MS);
    const diaryDays = new Set(others.filter((x) => x.kind === 'diary').map((x) => dayOf(x.t)));
    pool = others.filter((x) => x.kind === 'diary' || !diaryDays.has(dayOf(x.t)));
    const covered = new Set(others.map((x) => dayOf(x.t)));
    for (const e of events) if (!covered.has(dayOf(e.t))) pool.push(e);
  } else {
    // 一般：事件情节；哪一段时间一段事件情节都没有盖到，用那段时间的小结、日记补
    const segHasEvent = new Set(events.map((e) => segOf(segs, e.t)));
    pool = [...events, ...others.filter((e) => !segHasEvent.has(segOf(segs, e.t)))];
  }
  // 按段轮流取；段内按名次（没检索到的在后面，按时间均匀取）
  const bySeg = segs.map(() => []);
  for (const e of pool) {
    const i = segOf(segs, e.t);
    if (i != null) bySeg[i].push({ ...e, seg: i, rank: ranks.get(e.ref) ?? null });
  }
  for (const q of bySeg) {
    const ranked = q.filter((x) => x.rank != null).sort((a, b) => a.rank - b.rank);
    const rest = spread(q.filter((x) => x.rank == null));
    q.splice(0, q.length, ...ranked, ...rest);
  }
  const out = [];
  for (let round = 0; out.length < max; round++) {
    let any = false;
    for (const q of bySeg) {
      if (out.length >= max) break;
      if (q[round]) { out.push(q[round]); any = true; }
    }
    if (!any) break;
  }
  return out.map(({ ref, t, kind, seg, rank }) => ({ ref, t, kind, seg, rank }));
}

/** 按时间排好的一串，按二分次序取（正中、两边的四分之一处……），名次靠前的散在整段时间里。 */
function spread(list) {
  const n = list.length;
  if (n <= 2) return list;
  const out = [];
  const seen = new Uint8Array(n);
  for (let step = n; step >= 1; step = Math.floor(step / 2)) {
    for (let i = Math.floor(step / 2); i < n; i += Math.max(1, step)) if (!seen[i]) { seen[i] = 1; out.push(list[i]); }
    if (step === 1) break;
  }
  for (let i = 0; i < n; i++) if (!seen[i]) out.push(list[i]);
  return out;
}
