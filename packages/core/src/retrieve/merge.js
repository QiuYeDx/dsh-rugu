// 同一件事合并（D156，设计「回忆」§3.5）：同一件事常常被记成几段——同一张图发到三个场合是三段情节，一段事件情节和那段时间的小结……
// 回忆的结果里这些归成一组，展示信息最多的那一条（带「她看到的」图 / 视频说明的、叙述更完整的），后面标「另外 N 处也提到」。
// 归成一组要两样都成立：时间接近（起止重叠，或相隔 ≤ merge.gapMin 分钟），内容很像（存的向量余弦 ≥ merge.minSim，或者来源的原话
// 重合 ≥ merge.minOverlap——占较少一边的比例）。宁可少合并：把两件不同的事合成一件比重复更糟，所以不传递（新的一条只和各组的代表比）。
import { cosine, parseJson, rowsByIds, safe, withDeadline } from './util.js';

const SEEN_RE = /[你我]看到的[:：]/u;

/**
 * 把一串候选里的同一件事归成组（不改候选）：按原来的先后，每一条只和已有各组的第一条比；每组挑信息最多的那一条当代表。
 * 返回各组 {rep, others: [其余的引用]}，按组里最早出现的那一条的先后。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object[]} list   带 meta 的候选
 * @param {{gapMin: number, minSim: number, minOverlap: number, deadlineMs?: number, signal?: AbortSignal}} o
 * @returns {Promise<{rep: object, others: string[]}[]>}
 */
export async function groupSame(core, list, o) {
  if (list.length < 2) return list.map((c) => ({ rep: c, others: [] }));
  const refs = list.map((c) => c.ref);
  const vecs = await withDeadline(() => core.mods.worker.storedVectors(core, refs), Math.max(1, o.deadlineMs ?? 80), o.signal);
  const vmap = vecs.value instanceof Map ? vecs.value : new Map();
  const percepts = safe(core, 'mergePercepts', () => perceptSets(core, refs), new Map()) ?? new Map();
  const gap = Math.max(0, Number(o.gapMin) || 0) * 60_000;
  const groups = [];
  for (const c of list) {
    const g = groups.find((x) => same(x.lead, c, { vmap, percepts, gap, minSim: o.minSim, minOverlap: o.minOverlap }));
    if (g) g.members.push(c); else groups.push({ lead: c, members: [c] });
  }
  return groups.map((g) => {
    const rep = g.members.length === 1 ? g.lead : [...g.members].sort((a, b) => info(b) - info(a))[0];
    return { rep, others: g.members.filter((m) => m !== rep).map((m) => m.ref) };
  });
}

/** 信息量：带「她看到的」说明的优先，再看正文长短。 */
function info(c) {
  const t = String(c.meta?.text ?? '');
  return (SEEN_RE.test(t) ? 100_000 : 0) + [...t].length;
}

function same(a, b, { vmap, percepts, gap, minSim, minOverlap }) {
  const ma = a.meta ?? {};
  const mb = b.meta ?? {};
  // 只在同一种记忆之间合并：情节和情节（同一张图发到几个场合、一段事件和那段时间的小结）、原文窗口和原文窗口、事实和事实。
  // 情节和它里面的原文窗口不是「同一件事记了两遍」，是一件事的两层（窗口是展开），不合
  if (!ma.kind || ma.kind !== mb.kind) return false;
  const a0 = ma.tStart; const a1 = ma.tEnd ?? ma.tStart;
  const b0 = mb.tStart; const b1 = mb.tEnd ?? mb.tStart;
  if (![a0, a1, b0, b1].every(Number.isFinite)) return false;
  const apart = Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
  if (apart > gap) return false;
  // 来源是同一批原话：情节之间看较小一边被盖住多少（一段事件和盖住它的小结）；别的种类看重合占并集多少（相邻的原文窗口本来就有几句重叠）
  const pa = percepts.get(a.ref);
  const pb = percepts.get(b.ref);
  if (pa?.size && pb?.size && Number.isFinite(minOverlap) && minOverlap > 0) {
    let n = 0;
    for (const x of pa) if (pb.has(x)) n += 1;
    const ratio = ma.kind === 'episode' ? n / Math.min(pa.size, pb.size) : n / (pa.size + pb.size - n);
    if (ratio >= minOverlap) return true;
  }
  const va = vmap.get(a.ref);
  const vb = vmap.get(b.ref);
  return !!(va && vb && Number.isFinite(minSim) && cosine(va, vb) >= minSim);
}

/** 每条记忆的来源原话（感知 id 的集合）：情节是归进它的感知和它的来源，原文窗口是成员，事实是来源，原话是它自己。 */
function perceptSets(core, refs) {
  const out = new Map();
  const add = (ref, id) => { if (!Number.isSafeInteger(id)) return; if (!out.has(ref)) out.set(ref, new Set()); out.get(ref).add(id); };
  const ids = (k) => refs.filter((r) => r[0] === k).map((r) => Number(r.slice(1))).filter(Number.isSafeInteger);
  const eps = ids('e');
  for (const r of rowsByIds(core.store, 'SELECT id, episode_id AS o FROM percepts WHERE episode_id IN (?*)', eps)) add(`e${r.o}`, r.id);
  for (const r of rowsByIds(core.store, "SELECT owner_id AS o, percept_id AS id FROM sources WHERE owner_kind = 'episode' AND owner_id IN (?*)", eps)) add(`e${r.o}`, r.id);
  for (const r of rowsByIds(core.store, "SELECT owner_id AS o, percept_id AS id FROM sources WHERE owner_kind = 'assertion' AND owner_id IN (?*)", ids('a'))) add(`a${r.o}`, r.id);
  for (const r of rowsByIds(core.store, 'SELECT id, members_json FROM raw_windows WHERE id IN (?*)', ids('w'))) {
    for (const m of parseJson(r.members_json, []) ?? []) add(`w${r.id}`, m);
  }
  for (const id of ids('p')) add(`p${id}`, id);
  return out;
}
