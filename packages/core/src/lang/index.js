// lang 模块（§3.3 LanguageAnalyzer、§6.6、§8.1、§8.2）：语言分析器接口的实现和注册表。
//   - 自带两个分析器：zh（可选 @node-rs/jieba 搜索模式分词 + 中文二元组 + ASCII 词）和 und（Unicode 回退：
//     CJK 连续段切二元组、其他按词）。jieba 加载失败（没装、Electron 里加载不了）就退回只用二元组，绝不抛错。
//   - 端口 ports.languages 里给的分析器覆盖同名的内置分析器；以后加 en 等不改核心（评审:UV-16）。
//   - 语言标签认得（整个或主标签）就用它；认不出（随机标签、'und'、没给）就按文字本身检测，检测不出的混合文字按段分派
//     （汉字段给 zh，其余给 Unicode 回退）。入库和查询对同一段文字一定选到同一个分析器（§14.2「随机标签和真实适配器一致」）。
//   - 这里没有任何固定词表（「今天」「我妈」……）：时间表达解析和问句线索是语言层面的通用语法，不是按入口写的规则（§2.2）。
// 拥有的表：无。用到的端口：ports.languages。
// 契约细节：docs/实现/模块与接口.md §4.1。
//
// 注册表的每个方法都不抛错：外来的分析器出错时退回 und；结果都会再规范化（store.normalizeToken），
// 所以同一段文字在 index 和 query 两种模式下切出来的词一定对得上。
import { normalizeToken, entityToken } from '../store/fts.js';
import { createZh, buildZhAnalyzer } from './zh.js';
import { createUnicode } from './unicode.js';
import { prep, segmentRuns } from './text.js';
import { phrasingFor } from './when.js';
import { DEFAULTS } from '../config/defaults.js';

/**
 * 注册表：按语言取分析器，自动检测语言。
 * @typedef {object} AnalyzerRegistry
 * @property {(lang?: string) => import('../ports/index.js').LanguageAnalyzer} get        没有这种语言就给 und（按文字分派的回退）
 * @property {(text: string) => string} detect                                              最有把握的语言标签；都没把握给 'und'
 * @property {(text: string, lang?: string) => string} resolve                              【补】这段文字实际用哪个分析器：标签认得就是它，
 *                                                                                          认不出（随机标签、'und'、没给）按文字检测
 * @property {(text: string, opt?: {lang?: string, mode?: 'index'|'query'}) => string[]} tokenize
 * @property {(text: string, at: number, lang?: string) => import('../ports/index.js').TimeWindow[]} parseTime
 * @property {(text: string, lang?: string) => number} questionCue
 * @property {(term: string, lang?: string) => ('function'|'word'|null)} termClass   【D150】查询词的词类（分析器不给就是 null）
 * @property {(lang?: string) => string[]} pastQuestionExemplars
 * @property {(words: string[]) => void} setUserDictionary                                  转给支持的分析器（jieba）
 * @property {{jieba: boolean, langs: string[]}} info                                       给启动自检看
 */

/** 没有 config（单独用分析器）或快照里缺键时的兜底：就是 config/defaults.js 的 lang 段。 */
const LANG_FALLBACK = DEFAULTS.lang;

/** 时间解析每次用的参数（热加载：每次都从 config 取）。 */
function timeParams(core) {
  const cfg = core.config?.get?.() ?? {};
  return {
    tzOffsetMin: cfg.time?.tzOffsetMin ?? null,
    fuzzyPastDays: cfg.lang?.time?.fuzzyPastDays ?? LANG_FALLBACK.time.fuzzyPastDays,
    recentDays: cfg.lang?.time?.recentDays ?? LANG_FALLBACK.time.recentDays,
  };
}
const langCfg = (core) => core.config?.get?.().lang ?? {};

/**
 * 建注册表放进 core.state.lang.registry（内置 zh、und，加上 ports.languages）。
 * 尝试加载 jieba：`await import('@node-rs/jieba')`，失败就记一条 info 日志，zh 只用二元组。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<void>}
 */
export async function init(core) {
  core.state.lang = { registry: null };
  const params = () => timeParams(core);
  let zh;
  try {
    zh = await createZh({ jieba: 'auto', params });
  } catch {
    zh = buildZhAnalyzer({ params });
  }
  if (!zh.jieba) {
    try { core.log.info('lang.jieba.unavailable', { reason: String(/** @type {any} */ (zh).jiebaError ?? 'unknown').slice(0, 40) }); } catch { /* 日志失败不影响 */ }
  }
  core.state.lang.registry = buildRegistry(core, [createUnicode({ params }), zh, ...(core.ports?.languages ?? [])], { jieba: zh.jieba });
}

/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) { /* 无资源 */ }

/**
 * 当前注册表（init 之后同步可用）。init 之前被用到时，先同步建一个不带 jieba 的（不抛错）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {AnalyzerRegistry}
 */
export function registry(core) {
  const st = core.state.lang ?? (core.state.lang = { registry: null });
  if (!st.registry) {
    const params = () => timeParams(core);
    st.registry = buildRegistry(core, [createUnicode({ params }), buildZhAnalyzer({ params }), ...(core.ports?.languages ?? [])], { jieba: false });
  }
  return st.registry;
}

/**
 * 【补】时间说法（D148）：进她上下文的「什么时候」按人感觉的方式写好（今晚 21:39 · 20 分钟前 / 昨天晚上 22:14 / 周日（11/8）下午），
 * 不让读的人自己和「现在」做减法。说法按 selfProfile.locale 选（zh 有自己的；别的语言用和语言无关的兜底：绝对时间），
 * 时区按 config.time.tzOffsetMin，「多久以前」为主的范围按 config.lang.timePhrase.agoH。不抛错：出问题返回空字符串。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} t   要说的那个时刻（UTC 毫秒）
 * @param {{now?: number, style?: 'full'|'day'|'date'}} [opt]
 *        now：现在（缺省 core.now()）；style：full（缺省，几个小时以内带「多久以前」）/ day（不带「多久以前」：会冻结一段时间的文字用）/ date（只到天）
 * @returns {string}
 */
export function describeTime(core, t, opt = {}) {
  try {
    const P = phrasingFor(core.ports?.selfProfile?.locale);
    const now = Number.isFinite(opt.now) ? opt.now : core.now();
    return P.when(t, now, { tzOffsetMin: core.config?.get?.().time?.tzOffsetMin ?? null, style: opt.style ?? 'full', agoH: phraseCfg(core).agoH });
  } catch { return ''; }
}

/**
 * 【补】「现在」那一句的时间（D148）：zh 是「2026-11-11（周三）晚上 22:00」——年月日写全，带星期几和时段。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} [at]  缺省 core.now()
 * @returns {string}
 */
export function describeNow(core, at) {
  try {
    const P = phrasingFor(core.ports?.selfProfile?.locale);
    return P.now(Number.isFinite(at) ? at : core.now(), { tzOffsetMin: core.config?.get?.().time?.tzOffsetMin ?? null });
  } catch { return ''; }
}

/**
 * 【补】一段时长的说法（D148）：zh 是「20 分钟」「4 天」「约 2 个月」。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} ms
 * @returns {string}
 */
export function describeSpan(core, ms) {
  try { return phrasingFor(core.ports?.selfProfile?.locale).span(ms); } catch { return ''; }
}
const phraseCfg = (core) => core.config?.get?.().lang?.timePhrase ?? LANG_FALLBACK.timePhrase ?? {};

/**
 * Unicode 回退分析器（lang = 'und'）：CJK 连续段切成二元组（单字段保留单字），其他文字按 \p{L}\p{N} 连续段切词并小写。
 * detect 恒为 0.01（兜底），parseTime 只认 ISO 日期和 HH:MM 这类和语言无关的写法，questionCue 只看问号。
 * @param {{tzOffsetMin?: number|null, params?: () => {tzOffsetMin?: number|null}}} [opt]  【补】本地时区（缺省 = 本机）
 * @returns {import('../ports/index.js').LanguageAnalyzer}
 */
export function createUnicodeAnalyzer(opt) { return createUnicode(opt ?? {}); }

/**
 * 中文分析器（lang = 'zh'）。
 *   - tokenize(text, {mode:'index'})：jieba 搜索模式词 + 中文二元组 + ASCII 词（都会再过 store.normalizeToken）；
 *     mode:'query' 时同样，但去重后按出现顺序返回（IDF 排序和截到 12 个由调用方做，§8.2）。
 *     【补】没有 jieba 时再加单字和用户词典（setUserDictionary）里的整词，单字词、三字名也能对上。
 *   - parseTime：把「昨天、上周、那天晚上、下周六、10/31、晚上八点……」解析成绝对时间窗（以 at 为基准；
 *     「昨天」「晚上」按本地时区算，偏移来自 opt.tzOffsetMin，registry 从 config.time.tzOffsetMin 传进来，null = 本机时区）。
 *   - pastQuestionExemplars：一小组「看起来在问过去」的示例问法（§6.6），给嵌入比相似度用。
 *   - questionCue：汉语问句的语法线索（问号、句末「吗 / 呢 / 了没 / 来着」、正反问、疑问代词），0–1。疑问代词按结构分读法，
 *     任指（「什么都吃」「谁也不认识」）、虚指（「没什么」「不怎么」）不算。只是嵌入不可用时（L3）的退路；
 *     「是不是在问过去」由示例问法的嵌入相似度加时间表达判断（§6.6），示例问法不按字面比（字面重合的是话题词）。
 * @param {{jieba?: 'auto'|false|object, tzOffsetMin?: number,
 *          params?: () => {tzOffsetMin?: number|null, fuzzyPastDays?: number, recentDays?: number}}} [opt]
 *        jieba: 'auto' 尝试加载；false 不用；对象 = 已加载的模块；params【补】每次解析时取的参数（热加载）
 * @returns {Promise<import('../ports/index.js').LanguageAnalyzer>}
 */
export async function createZhAnalyzer(opt) { return createZh(opt ?? {}); }

/**
 * 写进 FTS 的词元（§8.2）：分析器的词 + 实体词元 ent_<id>（store.entityToken），规范化、去重。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {{lang?: string, entityIds?: number[]}} [opt]
 * @returns {string[]}
 */
export function indexTokens(core, text, opt) {
  const toks = registry(core).tokenize(String(text ?? ''), { lang: opt?.lang, mode: 'index' });
  return withEntities(toks, opt?.entityIds);
}

/**
 * 查询词（还没按 IDF 排序，也没截断）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {{lang?: string, entityIds?: number[]}} [opt]
 * @returns {string[]}
 */
export function queryTerms(core, text, opt) {
  const toks = registry(core).tokenize(String(text ?? ''), { lang: opt?.lang, mode: 'query' });
  return withEntities(toks, opt?.entityIds);
}

/**
 * 查询词的词类（D150，词法路挑词用）：'function' 虚词——代词、疑问词、语气词、助词、连词、介词这类封闭词类，
 * 不带「要找什么」的信息，不当查询词；'word' 分析器认得的整词（用户词典里的名字、别名），优先于虚词；
 * null 不知道（交给统计）。词类由各语言的分析器给（LanguageAnalyzer.termClass，可选），核心不放词表。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} term  queryTerms 给出的词
 * @param {{lang?: string}} [opt]
 * @returns {'function'|'word'|null}
 */
export function termClass(core, term, opt) {
  return registry(core).termClass(String(term ?? ''), opt?.lang);
}

/**
 * 区分性的词（§7.3 污点检查、§9.4.2 外发初筛、§5.6 告诉过谁的比对）：数字、高 IDF 的二元组、实体名。
 * idf 不给时只返回数字和 names 里命中的名字。exclude 里的词先去掉（外发初筛要去掉线索里本来就有的词）。
 *   - 数字：两位以上的数字串（电话、日期、金额）；
 *   - 词：不用空格分词的文字取 ≥ 2 字的词（二元组、词典词、jieba 词），其他文字取 ≥ 3 个字母的词；idf(term) ≥ minIdf 的才算
 *     （minIdf 缺省取 config.lang.distinctiveMinIdf；idf 返回 Infinity = 库里从没出现过，算；NaN / 不是数字 = 不知道，不算）；
 *     【补】idf 也可以返回统计 {idf, docs}（worker.termStats 的一项，docs = 含这个词的文字条数）：docs ≤ 1 的也算——
 *     库还小的时候（N ≤ 约 220 行，ln(1 + (N − 0.5) / 1.5) < 5）BM25 的 IDF 到不了门槛，可「只在一条文字里出现过」
 *     本身就是最高的区分度；库大了这一条和 IDF 门槛说的是同一回事；
 *   - 名字：names 里出现在文字中的（≥ 2 个字；字母名按整词比，不按子串）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {{lang?: string, idf?: (term: string) => (number|{idf: number, docs?: number}|undefined), minIdf?: number, names?: string[],
 *          exclude?: Iterable<string>}} [opt]
 * @returns {string[]}
 */
export function distinctiveTerms(core, text, opt = {}) {
  const src = String(text ?? '').normalize('NFKC');
  if (!src) return [];
  const exclude = new Set();
  for (const e of opt.exclude ?? []) { const n = cleanToken(e); if (n) exclude.add(n); }
  const out = [];
  const seen = new Set();
  const push = (t) => { if (t && !exclude.has(t) && !seen.has(t)) { seen.add(t); out.push(t); } };

  for (const m of src.matchAll(/\p{Nd}{2,}/gu)) push(cleanToken(m[0]));

  const terms = queryTerms(core, src, { lang: opt.lang });
  if (Array.isArray(opt.names) && opt.names.length) {
    const flat = normalizeToken(src);
    const termSet = new Set(terms);
    for (const name of opt.names) {
      const n = cleanToken(name);
      if (!n || [...n].length < 2) continue;
      const hit = /^[\p{Script=Latin}\p{N}]+$/u.test(n) ? termSet.has(n) : flat.includes(n);
      if (hit) push(n);
    }
  }

  if (typeof opt.idf === 'function') {
    const minIdf = Number.isFinite(opt.minIdf) ? opt.minIdf : (langCfg(core).distinctiveMinIdf ?? LANG_FALLBACK.distinctiveMinIdf);
    for (const term of terms) {
      if (!isDistinctiveShape(term)) continue;
      let v;
      try { v = opt.idf(term); } catch { v = NaN; }
      const stats = v !== null && typeof v === 'object' ? v : null;
      const idf = stats ? stats.idf : v;
      if (typeof idf === 'number' && !Number.isNaN(idf) && idf >= minIdf) push(term);
      else if (stats && Number.isFinite(stats.docs) && stats.docs >= 0 && stats.docs <= 1) push(term);   // 只在一条文字里出现过
    }
  }
  return out;
}

// ── 内部 ──────────────────────────────────────────────────────────────────
/** 分析器出的词再规范化一次；下划线去掉（用户文字切不出 ent_<id>，实体词元只能按 id 加）。 */
const cleanToken = (t) => normalizeToken(t).replaceAll('_', '');
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
function isDistinctiveShape(term) {
  if (/^\p{N}+$/u.test(term)) return false;   // 数字另算
  const n = [...term].length;
  return UNSEGMENTED.test(term) ? n >= 2 : n >= 3;
}
function withEntities(toks, entityIds) {
  const out = [];
  const seen = new Set();
  for (const t of toks) {
    const n = cleanToken(t);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  for (const id of entityIds ?? []) {
    if (!Number.isInteger(id) || id <= 0) continue;
    const e = entityToken(id);
    if (!seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}
/** 分析器给的词类；不给、出错、给了不认识的值都当不知道（null）。 */
function classOf(a, term) {
  if (typeof a?.termClass !== 'function') return null;
  try { const c = a.termClass(String(term ?? '')); return c === 'function' || c === 'word' ? c : null; } catch { return null; }
}
const clamp01 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const validWindow = (w) => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start;

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../ports/index.js').LanguageAnalyzer[]} analyzers  后面的覆盖前面同名的
 * @param {{jieba: boolean}} meta
 * @returns {AnalyzerRegistry}
 */
function buildRegistry(core, analyzers, meta) {
  const byLang = new Map();
  for (const a of analyzers) if (a && typeof a.lang === 'string') byLang.set(a.lang.toLowerCase(), a);
  const base = byLang.get('und') ?? createUnicode();
  const minScore = () => langCfg(core).detectMinScore ?? LANG_FALLBACK.detectMinScore;
  const scored = (text) => {
    let best = null;
    let bestScore = minScore();
    for (const [l, a] of byLang) {
      if (l === 'und') continue;
      let s = 0;
      try { s = clamp01(a.detect(String(text ?? ''))); } catch { s = 0; }
      if (s >= bestScore && (!best || s > bestScore)) { best = a; bestScore = s; }
    }
    return best;
  };
  // und = 按文字分派的回退：不认识的语言标签、检测不出语言的混合文字，每一段交给认得那种文字的分析器（S18、§14.2）
  const und = routedUnd(base, scored);
  byLang.set('und', und);
  // 认得的语言标签：整个标签或主标签（zh-Hans-CN → zh）。'und' 本身、x-abc 这类随机标签都不算认得
  const known = (lang) => {
    if (typeof lang !== 'string' || !lang) return null;
    const l = lang.toLowerCase();
    const a = byLang.get(l) ?? byLang.get(l.split(/[-_]/)[0]);
    return a && a !== und ? a : null;
  };
  const get = (lang) => known(lang) ?? und;
  const detect = (text) => scored(text)?.lang ?? 'und';
  // 标签认得就用它；认不出（随机标签、und、没给）就按文字本身选——入库和查询对同一段文字一定选到同一个分析器
  const pick = (text, lang) => known(lang) ?? scored(text) ?? und;
  const reg = {
    get,
    detect,
    resolve: (text, lang) => pick(text, lang).lang,
    tokenize(text, opt = {}) {
      const a = pick(text, opt.lang);
      try {
        const r = a.tokenize(String(text ?? ''), { mode: opt.mode ?? 'index' });
        if (Array.isArray(r)) return r.filter((x) => typeof x === 'string');
      } catch { /* 外来的分析器出错：退回 und */ }
      try { return a === base ? [] : base.tokenize(String(text ?? ''), { mode: opt.mode ?? 'index' }); } catch { return []; }
    },
    parseTime(text, at, lang) {
      const a = pick(text, lang);
      try {
        const r = a.parseTime(String(text ?? ''), at);
        if (Array.isArray(r)) return r.filter(validWindow);
      } catch { /* 解析不了就当没有时间表达 */ }
      return [];
    },
    questionCue(text, lang) {
      const a = pick(text, lang);
      try { return clamp01(a.questionCue(String(text ?? ''))); } catch { return 0; }
    },
    termClass(term, lang) { return classOf(pick(term, lang), term); },
    pastQuestionExemplars(lang) {
      const a = get(lang ?? core.ports?.selfProfile?.locale);
      try { const r = a.pastQuestionExemplars(); return Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []; } catch { return []; }
    },
    setUserDictionary(words) {
      for (const a of new Set(byLang.values())) {
        if (typeof a.setUserDictionary !== 'function') continue;
        try { a.setUserDictionary(Array.isArray(words) ? words : []); } catch { /* 不支持就算了 */ }
      }
    },
    info: Object.freeze({ jieba: !!meta.jieba, langs: [...byLang.keys()].sort() }),
  };
  return Object.freeze(reg);
}

/**
 * 按文字分派的 und：把文字切成连续段（不用空格分词的文字一段、字母数字一段），每一段交给 detect 认得它的分析器
 * （汉字段 → zh），相邻的同一个分析器的段合成一段一起切；谁都不认的段用 Unicode 回退分析器。
 * 这样「随机语言标签的中文消息」入库时切出的词和不带标签查询时一样（以前入库用 und 的二元组、查询用 zh 的二元组 + 单字，
 * 单字词对不上），问句线索也用认得那种文字的分析器的句式（以前 und 只认「?」，「拿了没来着」不算问）。
 * 不放任何词表：只是按文字类别分派，规则在各语言的分析器里。
 * @param {import('../ports/index.js').LanguageAnalyzer} base   Unicode 回退分析器（或端口给的同名分析器）
 * @param {(text: string) => import('../ports/index.js').LanguageAnalyzer|null} owner  认得这段文字的分析器（没有给 null）
 * @returns {import('../ports/index.js').LanguageAnalyzer}
 */
function routedUnd(base, owner) {
  /** 文字 → [{a, text}]：分派好的段（a = null 用 base）。 */
  const spans = (text) => {
    const t = prep(text);
    const out = [];
    for (const run of segmentRuns(t)) {
      const a = owner(run.text);
      const end = run.pos + run.text.length;
      const last = out.at(-1);
      if (last && last.a === a) last.end = end;
      else out.push({ a, start: run.pos, end });
    }
    return out.map((s) => ({ a: s.a, text: t.slice(s.start, s.end) }));
  };
  const owners = (text) => [...new Set(spans(text).map((s) => s.a).filter(Boolean))];
  return {
    lang: 'und',
    detect: () => 0.01,
    tokenize(text, opt) {
      const parts = spans(text);
      if (!parts.some((s) => s.a)) return base.tokenize(text, opt);
      const out = [];
      for (const s of parts) {
        let r = null;
        if (s.a) { try { r = s.a.tokenize(s.text, opt); } catch { r = null; } }
        if (!Array.isArray(r)) r = base.tokenize(s.text, opt);
        for (const x of r) if (typeof x === 'string') out.push(x);
      }
      return [...new Set(out)];
    },
    parseTime(text, at) {
      const out = [];
      const seen = new Set();
      for (const a of [base, ...owners(text)]) {
        let r = [];
        try { r = a.parseTime(text, at) ?? []; } catch { r = []; }
        for (const w of Array.isArray(r) ? r : []) {
          if (!validWindow(w)) continue;
          const k = `${w.start}:${w.end}`;
          if (!seen.has(k)) { seen.add(k); out.push(w); }
        }
      }
      return out;
    },
    termClass(term) { return classOf(owner(term) ?? base, term); },
    questionCue(text) {
      let best = 0;
      for (const a of [base, ...owners(text)]) {
        try { best = Math.max(best, clamp01(a.questionCue(text))); } catch { /* 这个分析器不算 */ }
      }
      return best;
    },
    pastQuestionExemplars: () => base.pastQuestionExemplars(),
    setUserDictionary(words) { if (typeof base.setUserDictionary === 'function') base.setUserDictionary(words); },
  };
}
