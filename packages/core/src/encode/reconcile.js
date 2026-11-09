// 对账（§7.5、§5.4 的更新规则）：新增、重复、更新还是同类的另一次。
//   - 重复候选只在同一主体、同一属性（含同义键）里找；计划和事件还要同一个 occurrence_key（评审:SC-01）；
//   - 矛盾候选在整个主体相关范围找；两者都用 BM25 + 向量的 RRF 混合排序，不设分数门槛；
//   - 快速路径：同主体、同属性、规范化后文本相同 → 重复（计划和事件永远不走）；
//   - 信任度低的说法不能取代信任度高的（两种说法都留着）；迟到的旧消息失效的是它自己（late）；
//   - 拿不准的（相似度落在中间）先新增，标 needsReconcile，夜里批量用一次 LLM 判断。
import {
  param, isNum, normText, jaccard, cosine, isOccurrenceKind, TRUST, rstr,
} from './util.js';
import { assertionRow, assertionSubjects, predicateFamily, cardinalityOf, occurrenceKeyOf, canonicalPredicate, selfIdOf } from './write.js';

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function terms(core, text) {
  try { return [...new Set(core.mods.lang.queryTerms(core, String(text ?? '')))]; } catch { return []; }
}

const canonicalOf = (core, key) => canonicalPredicate(core, key);

/** 候选（同步）：同主体同属性（dup），主体相关（related），模型指出的那条（target）。 */
function gather(core, fact) {
  const subjects = [...new Set((fact.subjects ?? []).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b);
  const canonical = canonicalOf(core, fact.predicate);
  const family = predicateFamily(core, canonical);
  const max = param(core, 'reconcile.maxCandidates');
  let related = [];
  if (subjects.length) {
    related = core.store.all(`SELECT a.* FROM assertions a JOIN assertion_entities e ON e.assertion_id = a.id AND e.role = 'subject'
                                WHERE e.entity_id IN (${subjects.map(() => '?').join(',')}) GROUP BY a.id ORDER BY a.recorded_at DESC LIMIT ?`, ...subjects, max * 3);
  }
  const subjOf = new Map(related.map((r) => [r.id, assertionSubjects(core, r.id)]));
  const dup = related.filter((r) => family.includes(r.predicate) && sameSet(subjOf.get(r.id), subjects)).slice(0, max);
  const target = Number.isInteger(fact.opTargetId) ? assertionRow(core, fact.opTargetId) : null;
  if (target && !subjOf.has(target.id)) subjOf.set(target.id, assertionSubjects(core, target.id));
  return { subjects, canonical, family, related: related.slice(0, max), dup, target, subjOf };
}

/** BM25（候选集内的文档频率）+ 向量（有的话），RRF 合并排序；返回 [{row, lex, cos, sim}]（sim 是校准过的相似度，用来分中间地带）。 */
function rank(core, fact, rows, vec) {
  if (!rows.length) return [];
  const q = terms(core, fact.text);
  const docs = rows.map((r) => terms(core, r.text));
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const k1 = 1.2;
  const b = 0.75;
  const bm25 = docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return s;
  });
  const items = rows.map((row, i) => ({ row, lex: bm25[i], jac: jaccard(q, docs[i]), cos: vec?.get(row.id) ?? null }));
  const k = core.config.get().recall.rrfK;
  const order = (key) => [...items].sort((x, y) => (y[key] ?? -Infinity) - (x[key] ?? -Infinity));
  const rrf = new Map(items.map((x) => [x, 0]));
  order('lex').forEach((x, i) => rrf.set(x, rrf.get(x) + 1 / (k + i + 1)));
  if (vec) order('cos').filter((x) => x.cos != null).forEach((x, i) => rrf.set(x, rrf.get(x) + 1 / (k + i + 1)));
  const exact = normText(fact.text);
  for (const x of items) x.exact = normText(x.row.text) === exact;
  return items.sort((x, y) => rrf.get(y) - rrf.get(x));
}

function band(core, x) {
  if (!x) return 'none';
  const hiCos = param(core, 'reconcile.dupCos');
  const midCos = param(core, 'reconcile.midCos');
  const hiJac = param(core, 'reconcile.dupJaccard');
  const midJac = param(core, 'reconcile.midJaccard');
  if (x.exact || (x.cos != null && x.cos >= hiCos) || x.jac >= hiJac) return 'high';
  if ((x.cos != null && x.cos >= midCos) || x.jac >= midJac) return 'mid';
  return 'low';
}

const trust = (certainty) => TRUST[certainty] ?? 1;
const startOf = (row) => row.valid_from ?? row.event_start ?? row.recorded_at;
const occurrenceStart = (row) => {
  try { const p = row.planned_time_json ? JSON.parse(row.planned_time_json) : null; if (isNum(p?.start)) return p.start; } catch { /* 坏 JSON */ }
  return row.event_start ?? row.valid_from ?? row.recorded_at;
};

function occurrenceKeyFor(core, fact, canonical, subjects) {
  if (fact.occurrenceKey) return fact.occurrenceKey;
  const win = fact.plannedTime ?? fact.eventTime ?? null;
  if (!win) return null;
  return occurrenceKeyOf(core, { predicate: canonical, subjects, agent: fact.plan?.agent ?? null, window: win });
}

/** 判定（同步）。vec：候选 id → 余弦（没有向量时为 null）。 */
function decide(core, fact, c, vec) {
  const kind = fact.kindHint ?? 'fact';
  const occ = isOccurrenceKind(kind);
  const op = fact.op ?? 'new';
  const factTrust = trust(fact.certainty);
  const factStart = isNum(fact.validFrom) ? fact.validFrom : (fact.eventTime?.start ?? fact.plannedTime?.start ?? null);

  // 1) 模型给了 op 和目标：代码只核对能不能这样做
  if (c.target && op !== 'new' && op !== 'occurrence') {
    const t = c.target;
    const tSubj = c.subjOf.get(t.id) ?? [];
    const overlap = !c.subjects.length || c.subjects.some((s) => tSubj.includes(s));
    if (overlap) {
      // 「变了但新值未知」（§5.4 第 3 条）：这句话本身多半是一件事（「换工作了」），但它说的是旧事实变了，不看两边的种类
      if (op === 'changed') return { op: 'changed', targetId: t.id };
      if (occ || isOccurrenceKind(t.kind_hint)) {
        // 计划和事件：只有同一个 occurrence_key 才是重复；不同时间窗就是同一类事的另一次，互不取代
        const key = occurrenceKeyFor(core, fact, c.canonical, c.subjects);
        if (op === 'dup' && key && t.occurrence_key === key) return { op: 'dup', targetId: t.id };
        if (c.family.includes(t.predicate) || op === 'dup') return { op: 'occurrence', targetId: t.id };
        return { op: 'new', needsReconcile: true };
      }
      if (op === 'dup') return { op: 'dup', targetId: t.id };
      if (op === 'contradict') {
        if (cardinalityOf(core, t.predicate) === 'many' && c.family.includes(t.predicate)) return { op: 'new', needsReconcile: true };
        if (factTrust < trust(t.certainty)) return { op: 'new', needsReconcile: false, coexist: t.id };   // 信任度低的不能取代信任度高的
        if (isNum(factStart) && isNum(startOf(t)) && factStart < startOf(t)) return { op: 'late', targetId: t.id };   // 迟到的旧消息
        return { op: 'contradict', targetId: t.id };
      }
    }
  }

  // 2) 没有可用的 op：代码自己看候选
  if (occ) {
    const key = occurrenceKeyFor(core, fact, c.canonical, c.subjects);
    const same = c.dup.filter((r) => r.occurrence_key && r.occurrence_key === key);
    if (same.length) {
      const ranked = rank(core, fact, same, vec);
      const b0 = band(core, ranked[0]);
      // 同一个时间窗里的同一件事、意思也一样才算重复（计划和事件不走只看文本的快速路径）
      if (b0 === 'high') return { op: 'dup', targetId: ranked[0].row.id };
      return { op: 'new', needsReconcile: true };
    }
    const others = c.dup.filter((r) => isOccurrenceKind(r.kind_hint));
    if (others.length) {
      const latest = [...others].sort((a, b) => occurrenceStart(b) - occurrenceStart(a))[0];
      return { op: 'occurrence', targetId: latest.id };
    }
    const near = rank(core, fact, c.related.filter((r) => isOccurrenceKind(r.kind_hint)), vec)[0];
    if (band(core, near) !== 'low' && band(core, near) !== 'none') return { op: 'new', needsReconcile: true };
    return { op: 'new' };
  }
  const exact = c.dup.find((r) => normText(r.text) === normText(fact.text) && r.superseded_by == null)
    ?? c.dup.find((r) => normText(r.text) === normText(fact.text));
  if (exact) return { op: 'dup', targetId: exact.id };   // 快速路径
  const current = c.dup.filter((r) => r.superseded_by == null);
  // 她自己的看法：对同一个东西的新看法取代旧看法（§5.7）；关于她自己的偏好（「喜欢猫」「喜欢狗」）只在单值属性上取代
  const aboutThing = !c.subjects.includes(selfIdOf(core));
  if (fact.certainty === 'self_said' && (kind === 'opinion' || kind === 'preference') && current.length
    && ((kind === 'opinion' && aboutThing) || cardinalityOf(core, c.canonical) === 'one')) {
    const t = [...current].sort((a, b) => startOf(b) - startOf(a))[0];
    if (isNum(factStart) && factStart < startOf(t)) return { op: 'late', targetId: t.id };
    return { op: 'contradict', targetId: t.id };
  }
  const ranked = rank(core, fact, current.length ? current : c.dup, vec);
  const top = band(core, ranked[0]);
  if (top === 'high' || top === 'mid') return { op: 'new', needsReconcile: true };
  if (current.length && cardinalityOf(core, c.canonical) === 'one') return { op: 'new', needsReconcile: true };   // 单值属性又来一个值：可能矛盾
  const rel = rank(core, fact, c.related, vec)[0];
  if (band(core, rel) === 'high') return { op: 'new', needsReconcile: true };
  return { op: 'new' };
}

/** 同步版（批次事务里，实体解析之后补跑；不用向量）。 */
export function reconcileSync(core, fact) {
  return decide(core, fact, gather(core, fact), null);
}

/**
 * 实现 encode.reconcile。fact.op 取 'new'|'dup'|'contradict'|'changed'，目标在 fact.opTargetId（事实 id）。
 * 向量相似度用 worker.embedQuery + worker.storedVectors，不可用时只用 BM25（降级，不抛错）。
 */
export async function reconcile(core, fact, ctx = {}) {
  const c = gather(core, fact);
  const pool = [...new Map([...c.dup, ...c.related, ...(c.target ? [c.target] : [])].map((r) => [r.id, r])).values()];
  let vec = null;
  if (pool.length) {
    try {
      const deadlineMs = param(core, 'reconcile.embedDeadlineMs');
      const q = await core.mods.worker.embedQuery(core, [String(fact.text ?? '')], { deadlineMs, signal: ctx.signal });
      if (q?.vectors?.[0]) {
        const stored = await core.mods.worker.storedVectors(core, pool.map((r) => rstr('assertion', r.id)));
        vec = new Map();
        for (const r of pool) {
          const v = stored?.get(rstr('assertion', r.id));
          const s = v ? cosine(q.vectors[0], v) : null;
          if (s != null) vec.set(r.id, s);
        }
        if (!vec.size) vec = null;
      }
    } catch { vec = null; }
  }
  return decide(core, fact, c, vec);
}
