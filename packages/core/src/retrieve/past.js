// 「看起来在问过去」（§6.6、§8.8 的判断点表）：不调 LLM。
//   正常：最新一句话和语言分析器的示例问法比嵌入相似度（「还记得……吗」「……了没」「上次说的那个」），加上时间表达解析；
//   嵌入不可用（L3）：时间表达 + 句式线索，判别从宽，拿不准也返回 true（切到有意回想，评审:SC-22）。
// 示例问法的向量按（语言，空间）缓存在 state.retrieve.exemplars；同一句话的结果按文字哈希缓存一小会儿（同一轮里 context 可能问两次）。
import { params } from './params.js';
import { embedQueryTracked } from './level.js';
import { cosine, errKind, log, safe, sha } from './util.js';

const TEXT_CACHE_MAX = 64;

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {{lang?: string, signal?: AbortSignal}} [opt]
 * @returns {Promise<boolean>}
 */
export async function looksLikePast(core, text, opt = {}) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const { x } = params(core);
  const st = core.state.retrieve;
  try {
    const reg = core.mods.lang.registry(core);
    // 感知上的语言标签可能是认不出的随机标签：按注册表实际选中的分析器（认不出就按文字检测），示例问法和句式线索才对得上这段文字
    const lang = (typeof reg.resolve === 'function' ? safe(core, 'resolve', () => reg.resolve(t, opt.lang), null) : null)
      ?? opt.lang ?? (safe(core, 'detect', () => reg.detect(t), 'und') || 'und');
    const at = core.now();
    const wins = safe(core, 'parseTime', () => reg.parseTime(t, at, lang), []) ?? [];
    if (wins.some((w) => Number.isFinite(w?.start) && w.start < at)) return true;   // 时间表达指向过去
    const cue = Number(safe(core, 'questionCue', () => reg.questionCue(t, lang), 0)) || 0;
    const key = sha(`${lang}\u0001${t}`);
    const hit = st.pastCache.get(key);
    if (hit && hit.at > at - 60_000) return hit.v;
    const sim = await exemplarSimilarity(core, reg, t, lang, opt.signal, x.past.deadlineMs);
    let v;
    if (sim == null) v = cue >= x.past.lenientCueMin;   // L3：从宽
    else v = sim >= x.past.simMin || (cue >= x.past.cueMin && sim >= x.past.simWithCue);
    st.pastCache.set(key, { v, at });
    if (st.pastCache.size > TEXT_CACHE_MAX) st.pastCache.delete(st.pastCache.keys().next().value);
    return v;
  } catch (e) {
    log(core, 'debug', 'retrieve.past.error', { error: errKind(e) });
    return true;   // 拿不准就当在问过去：多想一次只是多花一点，漏想一次她会答「不记得」
  }
}

/** 和示例问法的最大余弦；嵌入不可用返回 null。 */
async function exemplarSimilarity(core, reg, text, lang, signal, deadlineMs) {
  const ex = (safe(core, 'exemplars', () => reg.pastQuestionExemplars(lang), []) ?? []).filter((s) => typeof s === 'string' && s);
  if (!ex.length) return null;
  const st = core.state.retrieve;
  const exKey = `${lang}\u0001${sha(ex.join('\u0001'))}`;
  const cached = st.exemplars.get(exKey);
  const need = !cached;
  const r = await embedQueryTracked(core, need ? [text, ...ex] : [text], { deadlineMs, signal });
  if (!r) return null;
  let exVecs = cached?.vectors;
  if (need) {
    exVecs = r.vectors.slice(1);
    st.exemplars.set(exKey, { spaceId: r.spaceId, vectors: exVecs });
  } else if (cached.spaceId !== r.spaceId) {
    // 换了向量空间：示例问法要重新嵌（不同空间的向量永远不比，§8.9）
    st.exemplars.delete(exKey);
    return exemplarSimilarity(core, reg, text, lang, signal, deadlineMs);
  }
  const v = r.vectors[0];
  let best = -1;
  for (const e of exVecs) best = Math.max(best, cosine(v, e));
  return best;
}
