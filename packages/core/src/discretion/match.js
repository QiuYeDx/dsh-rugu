// 一句话和一条记忆「说的是不是同一件事」的代码比对（§9.4.2 初筛、§9.5 告诉过谁）：区分性词（数字、高 IDF 的词、实体名）、
// 提到的实体、词元重合、整句向量。不用固定词表：词由语言分析器给，IDF 由 worker 统计。
import { softAsync, raceDeadline } from './util.js';
import { selfId, isIndividual } from './facts.js';

/** 一段文字的特征（同步部分）。idf 有就用（高 IDF 的词才算区分性词）。 */
export function features(core, text, opt = {}) {
  const t = String(text ?? '');
  const out = { terms: new Set(), distinct: new Set(), entities: new Set(), names: new Set() };
  if (!t.trim()) return out;
  try { for (const w of core.mods.lang.queryTerms(core, t) ?? []) out.terms.add(String(w)); } catch {
    for (const w of fallbackTerms(t)) out.terms.add(w);
  }
  let names = [];
  try {
    const hits = core.mods.entities.nameMatcher(core).scan(t, opt.settingKey ? { settingKey: opt.settingKey } : {}) ?? [];
    const me = selfId(core, opt.memo);
    for (const h of hits) {
      if (h.entityId == null || h.entityId === me) continue;
      out.entities.add(h.entityId);
      if (h.name) { names.push(h.name); out.names.add(String(h.name).normalize('NFKC').toLowerCase()); }
    }
  } catch { names = []; }
  try {
    for (const w of core.mods.lang.distinctiveTerms(core, t, { idf: opt.idf, names, exclude: opt.exclude, minIdf: opt.minIdf }) ?? []) out.distinct.add(String(w));
  } catch {
    for (const d of t.match(/\d{2,}/g) ?? []) out.distinct.add(d);
    for (const n of names) out.distinct.add(n);
  }
  for (const x of opt.exclude ?? []) out.distinct.delete(x);
  return out;
}

/** 语言模块不可用时的退路：CJK 二元组 + 其他文字的词（只用来算重合度，不做判断）。 */
function fallbackTerms(t) {
  const out = new Set();
  const norm = t.normalize('NFKC').toLowerCase();
  for (const seg of norm.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(seg)) {
      if (seg.length === 1) out.add(seg);
      for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
    } else out.add(seg);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n / (a.size + b.size - n);
}

/**
 * 重合分：共同的区分性词 + 共同提到的具体的人 + 词元重合度（≥ 0.3 加 1、≥ 0.5 再加 1）+ 整句向量（≥ 阈值加 2）。
 * @returns {number}
 */
export function overlapScore(core, a, b, opt = {}) {
  let s = 0;
  for (const x of a.distinct) if (b.distinct.has(x)) s += 1;
  const me = selfId(core, opt.memo);
  for (const e of a.entities) if (e !== me && b.entities.has(e) && isIndividual(core, e, opt.memo)) s += 1;
  const j = jaccard(a.terms, b.terms);
  if (j >= 0.3) s += 1;
  if (j >= 0.5) s += 1;
  if (opt.cos != null && opt.vectorSim != null && opt.cos >= opt.vectorSim) s += 2;
  return s;
}

/**
 * 这句话讲到了这条记忆的多少（§5.6「说得多细」）：记忆的词元里有几成出现在这句话里。人名的词元不算——
 * 复述时把名字换成「他」「她」很常见，换了说法不等于只说了个大概。
 * @param {{terms: Set<string>}} said  这句话的特征
 * @param {{terms: Set<string>, names?: Set<string>}} mem  记忆的特征
 * @returns {number} 0–1；记忆没有可比的词元时为 0
 */
export function coverage(said, mem) {
  const names = [...(mem.names ?? [])];
  let total = 0;
  let hit = 0;
  for (const t of mem.terms) {
    const lt = t.normalize('NFKC').toLowerCase();
    if (names.some((n) => n.includes(lt))) continue;
    total += 1;
    if (said.terms.has(t)) hit += 1;
  }
  return total ? hit / total : 0;
}

/**
 * 词的 IDF（worker.termStats），等不到就不用（只剩数字和名字算区分性词）。统计里带了含这个词的文字条数（docs）时
 * 连同 docs 一起交给 lang.distinctiveTerms（库还小、IDF 到不了门槛时，「只在一条文字里出现过」也算区分性词）。
 */
export async function idfFor(core, texts, ms) {
  const terms = new Set();
  for (const t of texts) {
    try { for (const w of core.mods.lang.queryTerms(core, String(t ?? '')) ?? []) terms.add(String(w)); } catch { /* 没有语言模块 */ }
  }
  if (!terms.size) return undefined;
  const p = softAsync(core, 'worker.termStats', () => core.mods.worker.termStats(core, [...terms]), null);
  const r = await raceDeadline(p, ms);
  const stats = r.done ? r.value : null;
  if (!(stats instanceof Map)) return undefined;
  return (term) => {
    const s = stats.get(term);
    if (!s) return 0;
    return Number.isFinite(s.docs) ? { idf: s.idf, docs: s.docs } : s.idf ?? 0;
  };
}

/** 整句向量（查询嵌入），等不到返回 null。 */
export async function sentenceVector(core, text, ms, signal) {
  const p = softAsync(core, 'worker.embedQuery', () => core.mods.worker.embedQuery(core, [String(text ?? '')], { deadlineMs: ms, signal }), null);
  const r = await raceDeadline(p, ms + 20);
  const v = r.done ? r.value : null;
  return v?.vectors?.[0] ? { spaceId: v.spaceId, vec: v.vectors[0] } : null;
}

export async function storedVectors(core, refs, ms) {
  if (!refs.length) return new Map();
  const p = softAsync(core, 'worker.storedVectors', () => core.mods.worker.storedVectors(core, refs), new Map());
  const r = await raceDeadline(p, ms);
  return r.done && r.value instanceof Map ? r.value : new Map();
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
