// 五路召回（§8.2，并行、互相独立）。每一路都有自己的截止时间，到点没完成的那一路直接丢掉（§8.8）。
//   稠密、词法、图扩散经 worker（只读连接）；时间、在场者近况在主线程（走索引的几条小查询）。
//   预过滤（隐藏、忘掉、墓碑）在融合之后统一做；这里从不看「这里能不能说」（§8.2）。
import { listPerceptShards, monthOf, normalizeToken } from '../store/fts.js';
import { cosine, errKind, log, meanVector, metric, mrefOf, rowsByIds, safe, selfId, wall, withDeadline, sleep } from './util.js';
import { activeSpace, denseHealth, embedQueryTracked } from './level.js';
import { fuse } from './fuse.js';

/** @typedef {import('./index.js').RouteResult} RouteResult */

/**
 * 一次召回的运行时上下文（pipeline 建）。
 * @typedef {object} RouteCtx
 * @property {import('../core-types.js').CoreContext} core
 * @property {ReturnType<typeof import('./params.js').params>} p
 * @property {ReturnType<typeof import('./cues.js').buildCues>} cues
 * @property {'involuntary'|'deliberate'} mode
 * @property {number} at
 * @property {number} deadlineAt          墙钟（performance.now）截止
 * @property {AbortSignal} [signal]
 * @property {0|1|2|3|4} level
 * @property {boolean} noDense            旁听的便宜预取：不做稠密路（§8.1）
 * @property {{spaceId: string, vectors: Float32Array[], hash: string}|null} queryVectors
 * @property {boolean} embedFailed
 * @property {boolean} pseudo
 * @property {Set<string>} exclude
 * @property {Record<string, number>} routeMs
 */

export const remaining = (ctx) => Math.max(0, ctx.deadlineAt - wall());
const empty = (route, extra = {}) => ({ route, hits: [], ms: 0, timedOut: false, ...extra });

/** 查询端的文字：通用指令 + 线索（§8.1）。 */
export function queryInputs(ctx) {
  const inst = ctx.p.x.queryInstruct || '';
  const texts = [...ctx.cues.queryTexts, ...ctx.cues.rewrites].filter(Boolean).slice(0, ctx.p.x.maxQueryVectors);
  return texts.map((t) => `${inst}${t}`);
}

// ── 稠密 ────────────────────────────────────────────────────────────────
/**
 * @param {RouteCtx} ctx
 * @param {Promise<RouteResult>[]} pseudoSources  L3 时伪查询向量从词法和实体路的前 3 条来
 * @returns {Promise<RouteResult>}
 */
export async function denseRoute(ctx, pseudoSources) {
  const { core } = ctx;
  if (ctx.noDense) return empty('dense', { skipped: true });
  // worker 线程挂了（fallback）：向量扫描做不了（不在主线程冷加载向量），这一路直接缺席，不白嵌查询、不白取存好的向量（L3，§8.8）
  if (denseHealth(core)?.scan === false) return empty('dense', { skipped: true, down: true });
  const t0 = wall();
  const rcfg = ctx.p.recall.dense;
  let qv = ctx.queryVectors;
  if (!qv && ctx.level <= 2) {
    const inputs = queryInputs(ctx);
    if (inputs.length) {
      const te = wall();
      const r = await embedQueryTracked(core, inputs, { deadlineMs: Math.max(1, remaining(ctx) - 40), signal: ctx.signal });
      ctx.routeMs.embed = Math.round(wall() - te);
      if (r) { qv = { spaceId: r.spaceId, vectors: r.vectors, hash: inputs.join('\u0001') }; ctx.queryVectors = qv; }
      else ctx.embedFailed = true;
    }
  }
  let vectors = qv?.vectors ?? null;
  let spaceId = qv?.spaceId ?? null;
  let layers = /** @type {('memory'|'raw')[]} */ (['memory', 'raw']);
  if (!vectors) {
    // L3：伪查询向量 = 词法和实体路前 3 条已经存好的向量的平均，只在记忆层找近邻（§8.8）
    const srcs = await Promise.race([Promise.all(pseudoSources), sleep(Math.max(0, remaining(ctx) - 60)).then(() => null)]);
    if (!srcs) return { ...empty('dense'), ms: wall() - t0, timedOut: true };
    const top = fuse(srcs.filter(Boolean), { k: ctx.p.recall.rrfK, keep: 12 + ctx.exclude.size }).map((c) => c.ref)
      .filter((r) => !ctx.exclude.has(r)).slice(0, 12);
    if (!top.length) return { ...empty('dense'), ms: wall() - t0 };
    const sp = activeSpace(core);
    if (!sp) return { ...empty('dense'), ms: wall() - t0 };
    const got = await withDeadline(() => core.mods.worker.storedVectors(core, top), Math.max(1, remaining(ctx) - 40), ctx.signal);
    const map = got.value instanceof Map ? got.value : new Map();
    const picked = top.filter((r) => map.has(r)).slice(0, 3).map((r) => map.get(r));
    const v = meanVector(picked);
    if (!v) return { ...empty('dense'), ms: wall() - t0 };
    vectors = [v];
    spaceId = sp.spaceId;
    layers = ['memory'];
    ctx.pseudo = true;
  }
  const r = await withDeadline((signal) => core.mods.worker.denseSearch(core, {
    vectors, spaceId, layers,
    topK: { memory: rcfg.memoryTopK, raw: rcfg.rawTopK },
    includeCold: ctx.mode === 'deliberate',
    exclude: ctx.exclude.size ? ctx.exclude : undefined,
  }, { deadlineMs: Math.max(1, remaining(ctx)), signal }), Math.max(1, remaining(ctx)), ctx.signal);
  return routeOf('dense', r, t0, ctx);
}

// ── 词法 ────────────────────────────────────────────────────────────────
/**
 * FTS5 BM25：原文分表 + 情节 + 事实。热路径只查最近 3 个月的原文分表。挑词见 pickLexicalTerms（D150）：
 * 虚词不当查询词、跨词边界的碎片不占名额、常见词降权不剔除；线索的「焦点」（有意回想的 query、最新对她说的那句）的词
 * 权重 1、排在前面，窗口其余部分的词权重 recall.lexical.contextWeight。
 * 统计不算眼前这段对话（线索窗口里的感知，worker.termStats 的 excludePercepts，D90）：问题本身入了库，只在问题里出现过的词
 * 原来 docs = 1、IDF 最高，会把真正能匹配上记忆的词挤出名额。
 * @param {RouteCtx} ctx
 * @returns {Promise<RouteResult>}
 */
export async function lexicalRoute(ctx) {
  const { core, cues } = ctx;
  const t0 = wall();
  const lx = ctx.p.recall.lexical;
  const entityIds = [...new Set([...cues.names.map((n) => n.entityId), ...cues.mentioned])].filter((e) => e !== selfId(core));
  const focusText = [cues.queryTexts.length && cues.queryTexts[0] !== cues.windowText ? cues.queryTexts[0] : null, cues.directedText,
    ...cues.rewrites].filter(Boolean).join('\n');
  // 窗口其余部分不带「名字：」：说话人已经是实体线索了，名字当词用只会让关于他的每一条都命中
  const restText = cues.windowPlain ?? cues.windowText;
  const termsOf = (text, ents) => (text ? safe(core, 'queryTerms', () => core.mods.lang.queryTerms(core, text, { lang: cues.lang, entityIds: ents }), []) ?? [] : []);
  const text1 = focusText || restText;
  const tier1 = dedupe(termsOf(text1, entityIds));
  const tier2 = dedupe(termsOf(focusText ? restText : '', [])).filter((t) => !tier1.includes(t));
  if (!tier1.length && !tier2.length) return empty('lexical');
  const tiers = [{ text: text1, terms: tier1, weight: 1 }, { text: focusText ? restText : '', terms: tier2, weight: lx.contextWeight ?? 0.3 }];
  // 统计连二元组的两个字一起要（凝聚度用；有 jieba 时单字不一定在查询词里）
  const all = [...new Set(tiers.flatMap((t) => [...t.terms, ...t.terms.flatMap(gramParts)]))];
  let stats = null;
  // 眼前这段对话（线索窗口里的感知）不算进词的统计：只在问题里出现过的词库里其实没有，不该占前面的名额（D34 同一个道理）
  const live = (cues.window ?? []).map((w) => w.perceptId).filter(Number.isInteger);
  const s = await withDeadline(() => core.mods.worker.termStats(core, all, live.length ? { excludePercepts: live } : undefined),
    Math.max(1, Math.min(remaining(ctx) / 3, 150)), ctx.signal);
  if (s.value instanceof Map) stats = s.value;
  const classOf = (t) => safe(core, 'termClass', () => core.mods.lang.termClass?.(core, t, { lang: cues.lang }) ?? null, null);
  const { terms, weights } = pickLexicalTerms(tiers, stats, { ...lx, classOf });
  if (!terms.length) return { ...empty('lexical'), ms: wall() - t0 };
  const shards = safe(core, 'shards', () => perceptShards(core, ctx.mode === 'involuntary' ? lx.hotMonths : null, ctx.at), []);
  const tables = [...shards, 'episodes_fts', 'assertions_fts'];
  const r = await withDeadline((signal) => core.mods.worker.lexicalSearch(core, { terms, weights, tables, limit: lx.topK },
    { deadlineMs: Math.max(1, remaining(ctx)), signal }), Math.max(1, remaining(ctx)), ctx.signal);
  const out = routeOf('lexical', r, t0, ctx);
  out.terms = terms.length;
  return out;
}

/** 不用空格分词的文字（汉字、假名……）的一个字：这些文字的二元组才谈得上「是词还是碎片」。 */
const UNSEG = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー々〇]$/u;
const ENTITY_TOKEN = /^ent_\d+$/;
/** 二元组的两个字（不是二元组给 []）。 */
function gramParts(t) {
  const c = [...t];
  return c.length === 2 && UNSEG.test(c[0]) && UNSEG.test(c[1]) ? c : [];
}

/**
 * 词法路挑词（D150）。每一层（焦点、窗口其余部分）分别：
 *   1. 分类：实体词元 ent_<id>；虚词（lang.termClass = 'function'：代词、疑问词、语气词、助词……这门语言的封闭词类）不进查询，
 *      但盖住它的字；认得的整词（'word'，用户词典里的名字、别名）直接当词；不用空格分词的文字的二元组、单字；其他（字母数字词、
 *      三字以上的词）当词。
 *   2. 二元组看凝聚度 df(ab)·N / (df(a)·df(b))（类似 PMI，用 termStats 的条数），按它在文字里的每一处判断：≥ cohesionMin、
 *      而且不低于和它重叠的左右二元组的 cohesionRivalRatio 倍，才算词；否则是跨词边界的碎片（「些猫」「得群」；「检测指令」里
 *      的「测指」——几个字都少见时碎片的凝聚度也会过 1，要和两边的词比），丢掉：稀有不等于有信息。判断不了（统计超时、没给条数、
 *      单字没入库）的照旧当词；库里一行都没有的（docs = 0：可能是新词，统计也可能是缓存的旧数）留着、排在最后、不盖字。
 *   3. 单字只在它出现的某一处没被任何词（含虚词）盖住时才当词（「群里有过哪些猫」的「猫」）。
 *   4. 常见词降权不剔除（BM25 的 IDF 本来就低）；只有出现在 skipRowFraction 以上的行里（IDF 到 0，只剩开销）、而且行数也超过
 *      commonMinDocs 的才跳过（刚装上的小库出现几次就过了比例，D72）。其余按 IDF 从高到低。
 * 合起来：焦点层能匹配的词在前（权重 = 层的 weight），下一层在后，库里一行都没有的最后；最多 maxTerms 个。
 * 选中的词加起来匹配的行数（按统计的条数估）超过 maxPostings 时先去掉最常见的词（FTS 查询的开销和匹配的行数成正比），至少留一个。
 * 没有统计时按出现的顺序，只去掉虚词。
 * @param {{text: string, terms: string[], weight: number}[]} tiers  terms：规范化、去重过的 queryTerms
 * @param {Map<string, {idf: number, rowFraction: number, docs?: number, rows?: number}>|null} stats  worker.termStats 的结果
 * @param {{classOf?: (t: string) => ('function'|'word'|null), maxTerms: number, cohesionMin?: number, cohesionRivalRatio?: number, skipRowFraction?: number,
 *          commonMinDocs?: number, maxPostings?: number}} opt
 * @returns {{terms: string[], weights: number[], dropped: {functions: string[], fragments: string[], skipped: string[]}}}
 */
export function pickLexicalTerms(tiers, stats, opt) {
  const classOf = typeof opt.classOf === 'function' ? opt.classOf : () => null;
  const cohesionMin = opt.cohesionMin ?? 1;
  const rivalRatio = opt.cohesionRivalRatio ?? 0.5;
  const skipFrac = opt.skipRowFraction ?? 0.5;
  const minDocs = opt.commonMinDocs ?? 20;
  const st = (t) => (stats instanceof Map ? stats.get(t) : undefined);
  const dropped = { functions: [], fragments: [], skipped: [] };
  /** 凝聚度；判断不了给 null。 */
  const cohesion = (g, [a, b]) => {
    const sg = st(g); const sa = st(a); const sb = st(b);
    const N = sg?.rows;
    if (!(sg?.docs > 0) || !(sa?.docs > 0) || !(sb?.docs > 0) || !(N > 0)) return null;
    return (sg.docs * N) / (sa.docs * sb.docs);
  };
  const lists = tiers.map((tier) => {
    const chars = [...String(tier.text ?? '').normalize('NFKC').toLowerCase()];
    const covered = new Uint8Array(chars.length);
    const cover = (t) => {
      const c = [...t];
      for (let i = 0; i + c.length <= chars.length; i++) {
        let ok = true;
        for (let k = 0; k < c.length && ok; k++) ok = chars[i + k] === c[k];
        if (ok) covered.fill(1, i, i + c.length);
      }
    };
    // 文字里每一处二元组的凝聚度（和左右两边重叠的二元组比）
    const termSet = new Set(tier.terms);
    const at = new Map();
    for (let i = 0; i + 1 < chars.length; i++) {
      const g = chars[i] + chars[i + 1];
      if (termSet.has(g) && gramParts(g).length) at.set(i, { g, c: cohesion(g, gramParts(g)) });
    }
    /** 这一处是不是词：够凝聚，而且不比和它重叠的二元组弱太多（「测指」夹在「检测」「指令」中间）。判断不了算是。 */
    const wordAt = (i) => {
      const o = at.get(i);
      if (o.c === null) return true;
      if (o.c < cohesionMin) return false;
      const rival = Math.max(at.get(i - 1)?.c ?? 0, at.get(i + 1)?.c ?? 0);
      return !(o.c < rivalRatio * rival);
    };
    const keep = [];
    const dead = [];
    const singles = [];
    for (const t of tier.terms) {
      if (ENTITY_TOKEN.test(t)) { keep.push(t); continue; }
      const cls = classOf(t);
      if (cls === 'function') { dropped.functions.push(t); cover(t); continue; }
      if (cls !== 'word' && [...t].length === 1 && UNSEG.test(t)) { singles.push(t); continue; }
      const parts = cls === 'word' ? [] : gramParts(t);
      if (parts.length && stats) {
        if (st(t)?.docs === 0) { dead.push(t); continue; }   // 库里没有：可能是新词，统计也可能是旧数——不盖字、排最后
        const spots = [...at].filter(([, o]) => o.g === t).map(([i]) => i);
        const words = spots.filter(wordAt);
        if (spots.length && !words.length) { dropped.fragments.push(t); continue; }
        keep.push(t);
        for (const i of words) covered.fill(1, i, i + 2);
        if (!spots.length) cover(t);
        continue;
      }
      keep.push(t);
      cover(t);
    }
    // 单字：某一处没被盖住就当词（文字里找不到它的位置时也留着）
    for (const t of singles) {
      let found = false;
      let free = false;
      chars.forEach((ch, i) => { if (ch === t) { found = true; if (!covered[i]) free = true; } });
      if (free || !found) keep.push(t);
    }
    const ranked = keep.filter((t) => {
      const x = st(t);
      const skip = x?.rowFraction >= skipFrac && !(Number.isFinite(x.docs) && x.docs <= minDocs);
      if (skip) dropped.skipped.push(t);
      return !skip;
    }).map((t) => ({ t, idf: st(t)?.idf ?? Infinity, i: tier.terms.indexOf(t) }));   // 没统计到的词（新词）当最稀有
    ranked.sort(stats ? (a, b) => b.idf - a.idf || a.i - b.i : (a, b) => a.i - b.i);
    const none = (t) => st(t)?.docs === 0;
    const names = ranked.map((x) => x.t);
    return { live: names.filter((t) => !none(t)), dead: [...names.filter(none), ...dead], weight: tier.weight };
  });
  const picked = [];
  const seen = new Set();
  const add = (t, w) => { if (!seen.has(t)) { seen.add(t); picked.push({ t, w }); } };
  for (const l of lists) for (const t of l.live) add(t, l.weight);
  for (const l of lists) for (const t of l.dead) add(t, l.weight);
  let out = picked.slice(0, Math.max(0, opt.maxTerms ?? 12));
  if (Number.isFinite(opt.maxPostings)) {
    const docs = (t) => (Number.isFinite(st(t)?.docs) ? st(t).docs : 0);
    let total = out.reduce((n, x) => n + docs(x.t), 0);
    while (total > opt.maxPostings && out.length > 1) {
      const worst = out.reduce((a, b) => (docs(b.t) > docs(a.t) ? b : a));
      total -= docs(worst.t);
      dropped.skipped.push(worst.t);
      out = out.filter((x) => x !== worst);
    }
  }
  return { terms: out.map((x) => x.t), weights: out.map((x) => x.w), dropped };
}

/**
 * 原文分表：热路径只要覆盖最近 hotMonths 个月的那几张（按日历算，中间几个月没消息也不会多查更早的），有意回想全查。
 */
function perceptShards(core, hotMonths, at) {
  if (!hotMonths) return listPerceptShards(core.store);
  const cutoff = monthOf(at - hotMonths * 30.44 * 86_400_000);
  return core.store.all('SELECT name FROM fts_shards WHERE month >= ? ORDER BY month DESC', cutoff).map((r) => r.name);
}
function dedupe(terms) {
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    const n = normalizeToken(t);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// ── 实体扩散（局部推送式 PPR）────────────────────────────────────────────
/**
 * 种子 = 正文里的名字、被提到的人、正在对她说话的人、在场的人（不含她自己），加上查询匹配到的前 5 条事实的实体。
 * 在「实体—事实—情节」图上做局部推送式个性化 PageRank（worker，评审:FE-14）。
 * @param {RouteCtx} ctx
 * @param {Promise<RouteResult>} lexicalP
 * @returns {Promise<RouteResult>}
 */
export async function entityRoute(ctx, lexicalP) {
  const { core, cues } = ctx;
  const t0 = wall();
  const sw = ctx.p.x.entity.seedWeights;
  const me = selfId(core);
  const seeds = new Map();
  const add = (id, w) => { if (Number.isInteger(id) && id !== me && w > 0) seeds.set(id, Math.max(seeds.get(id) ?? 0, w)); };
  for (const n of cues.names) add(n.entityId, sw.name * Math.max(0.1, Math.min(1, n.score || 1)));
  for (const e of cues.mentioned) add(e, sw.mentioned);
  add(cues.focusSpeaker, sw.focus);
  for (const e of cues.present) add(e, sw.present);
  // 查询匹配到的前 5 条事实的实体：等词法路一小会儿，等不到就不要了
  const lex = await Promise.race([lexicalP, sleep(Math.max(0, remaining(ctx) * ctx.p.x.entity.factWaitShare)).then(() => null)]);
  const factIds = (lex?.hits ?? []).map((h) => mrefOf(h.ref)).filter((m) => m?.kind === 'assertion')
    .slice(0, ctx.p.recall.entity.seedFacts).map((m) => m.id);
  if (factIds.length) {
    const rows = safe(core, 'factSeeds', () => rowsByIds(core.store,
      "SELECT DISTINCT entity_id AS e FROM assertion_entities WHERE assertion_id IN (?*) AND role IN ('subject','object')", factIds), []);
    for (const r of rows) add(r.e, sw.fact);
  }
  if (!seeds.size) return { ...empty('entity'), ms: wall() - t0 };
  const maxHops = ctx.mode === 'deliberate' ? Math.max(ctx.p.x.entity.maxHops, ctx.p.recall.deliberateMaxHops) : ctx.p.x.entity.maxHops;
  const r = await withDeadline((signal) => core.mods.worker.pprSearch(core, {
    seeds: [...seeds].map(([entityId, weight]) => ({ entityId, weight })),
    maxHops,
    limit: ctx.p.recall.fuseKeep,
  }, { deadlineMs: Math.max(1, remaining(ctx)), signal }), Math.max(1, remaining(ctx)), ctx.signal);
  const out = routeOf('entity', r, t0, ctx);
  out.seeds = seeds.size;
  return out;
}

// ── 时间 ────────────────────────────────────────────────────────────────
/**
 * 时间窗（lang 解析出来的「昨天、上周、那天晚上……」）里的情节、事实和本场合的原文窗口。
 * 分数 = 离时间窗中心越近越高（窗口内 ≥ 0.5），同分时近的在前（「最近发生」的先验）。没有时间表达就不出结果。
 * @param {RouteCtx} ctx
 * @returns {Promise<RouteResult>}
 */
export async function timeRoute(ctx) {
  const { core, cues } = ctx;
  const t0 = wall();
  if (!cues.timeWindows.length) return empty('time');
  const topK = ctx.p.x.time.topK;
  const score = new Map();
  const put = (ref, s, t) => { const prev = score.get(ref); if (!prev || s > prev.s) score.set(ref, { s, t }); };
  const closeness = (lo, hi, w) => {
    const center = (w.start + w.end) / 2;
    const width = Math.max(w.end - w.start, 3_600_000);
    const mid = (lo + hi) / 2;
    const inside = hi >= w.start && lo <= w.end;
    const d = inside ? Math.abs(mid - center) / 2 : Math.abs(mid - center);
    return 1 / (1 + d / width);
  };
  const SPAN = 7 * 86_400_000;   // 只按开始时间走索引：一件事、一段经历很少跨一周以上
  for (const w of cues.timeWindows.slice(0, 4)) {
    const eps = safe(core, 'timeEpisodes', () => core.store.all(
      `SELECT id, t_start, t_end FROM episodes WHERE t_start BETWEEN ? AND ? AND t_end >= ?
        ORDER BY t_end DESC LIMIT ?`, w.start - SPAN, w.end, w.start, topK), []);
    for (const e of eps) put(`e${e.id}`, closeness(e.t_start, e.t_end, w), e.t_end);
    const facts = safe(core, 'timeFacts', () => core.store.all(
      `SELECT id, event_start, COALESCE(event_end, event_start) AS event_end FROM assertions
        WHERE event_start BETWEEN ? AND ? AND COALESCE(event_end, event_start) >= ? ORDER BY event_start DESC LIMIT ?`,
      w.start - SPAN, w.end, w.start, topK), []);
    for (const a of facts) put(`a${a.id}`, closeness(a.event_start, a.event_end, w), a.event_start);
    // 本场合这段时间的原文窗口：先用感知的时间索引找出 id 范围，再按（场合，last_percept）索引取窗口
    const span = safe(core, 'timeSpan', () => core.store.get(
      'SELECT MIN(id) AS lo, MAX(id) AS hi FROM percepts WHERE at BETWEEN ? AND ?', w.start, w.end), null);
    if (span?.lo != null) {
      const wins = safe(core, 'timeWindowsRaw', () => core.store.all(
        `SELECT id, t_start, t_end FROM raw_windows WHERE setting_key = ? AND last_percept BETWEEN ? AND ?
          AND t_start <= ? AND t_end >= ? ORDER BY last_percept DESC LIMIT ?`,
        cues.settingKey, span.lo, span.hi + ctx.p.cfg.intake.rawWindow.maxMsgs, w.end, w.start, topK), []);
      for (const r of wins) put(`w${r.id}`, closeness(r.t_start, r.t_end, w), r.t_end);
    }
  }
  const hits = [...score].map(([ref, v]) => ({ ref, score: v.s, t: v.t }))
    .sort((a, b) => b.score - a.score || b.t - a.t || (a.ref < b.ref ? -1 : 1)).slice(0, topK).map(({ ref, score: s }) => ({ ref, score: s }));
  const ms = wall() - t0;
  ctx.routeMs.time = Math.round(ms);
  return { route: 'time', hits, ms, timedOut: false };
}

// ── 在场者近况 ─────────────────────────────────────────────────────────────
const PRESENT_KINDS = ['utterance', 'action', 'edit', 'self-utterance', 'self-action', 'on-my-behalf'];
/**
 * present 里每个人（包括她自己）在**其他场合**自己说过、做过、这里还没出现过、而且现在还活跃或者正切题的事（活跃度和相关度合起来不为负，见下）；
 * 她自己的部分还有「今天到目前为止」的小结（ep_kind='summary'）。≤ 15 条（评审:SC-07）。只对 present 生效：被 @ 一下的人不会把自己的近况
 * 带进来（评审:PS-13）。没有「最近 12 小时」的时间窗（D103）：每人按时间倒序最多看 maxItems × poolFactor 条，淡出靠 B 渐弱——
 * 编码强的记得更久，弱的更快淡出，不在某个钟点一刀切。
 *
 * 排序 = 和当前线索的相关度 + 和这里的人的关联 + 这条记忆现在有多活跃（实测问题 #5）：
 *   - 相关度：词法重合（不带「名字：」的窗口文字，和词法路同一个道理）+ 线索里的实体出现在这句话里 + （有查询向量时）向量相似度；
 *   - 关联（with）：这句话是这里的人说的（1），或者是她在那边和这里的人一来一回时说的：那个场合里这里的人离她这句话最近的一次亲自说话
 *     隔了 Δt，按 1/(1 + Δt/h) 渐弱（h = recall.present.withHalfLifeMin），不是 ±30 分钟的二值。这是「对着谁想起来」的线索，不是按人、按场合写的规矩；
 *   - 活跃度：基础激活 B（dynamics.baseActivations：编码强度 × 幂律衰减，和激活打分是同一个量），按这一路的时间范围归一到 0–1
 *     再乘 timeWeight：刚说的（age 下限、编码强度 1）是 1，B 降到 floorB 时是 0，中间按 B 的对数尺度走（几分钟前 1、半小时前约 0.6、
 *     两小时前约 0.3、六小时前约 0.1）；B 低于 floorB 的这一项是负的，要真的切题才补得回来（补不回来的不算近况）。原来按 12 小时线性给 0–0.5，两分钟前和两小时前几乎没有差别：一句没有字面线索的「5」，
 *     排序全看哪条旧话碰巧和窗口有一两个字重合，主人刚在别处定下的游戏规则排不进前 15。不直接用 B：B 没有上界，
 *     几分钟和几小时差出去的比相关度的整个范围还大，这一路就成了「最近 15 条」；归一以后时间只是几项之一，真正切题的旧事照样排得上来。
 * 拿不到 B（dynamics 出错）时按单条痕迹的同一个公式现算（activation 的参数）。
 * @param {RouteCtx} ctx
 * @returns {Promise<RouteResult>}
 */
export async function presentRoute(ctx) {
  const { core, cues } = ctx;
  const t0 = wall();
  const pc = ctx.p.x.present;
  if (!cues.present.length) return empty('present');
  const me = selfId(core);
  const others = cues.present.filter((e) => e !== me);
  const pool = pc.maxItems * pc.poolFactor;
  const rows = [];
  if (others.length) {
    rows.push(...safe(core, 'presentRows', () => core.store.all(
      `SELECT id, setting_key, at, actor_entity_id, actor_self, text, text_hash, relay_of, w_enc FROM percepts
        WHERE actor_entity_id IN (${others.map(() => '?').join(',')}) AND setting_key <> ?
          AND kind IN (${PRESENT_KINDS.map(() => '?').join(',')}) AND standing <> 'material'
          AND text IS NOT NULL AND text_state NOT IN ('retracted','expired')
        ORDER BY at DESC LIMIT ?`, ...others, cues.settingKey, ...PRESENT_KINDS, pool), []));
  }
  if (me != null && cues.present.includes(me)) {
    rows.push(...safe(core, 'presentSelf', () => core.store.all(
      `SELECT id, setting_key, at, actor_entity_id, actor_self, text, text_hash, relay_of, w_enc FROM percepts
        WHERE actor_self = 1 AND setting_key <> ? AND kind IN ('self-utterance','self-action','on-my-behalf')
          AND text IS NOT NULL AND text_state NOT IN ('retracted','expired')
        ORDER BY at DESC LIMIT ?`, cues.settingKey, pool), []));
  }
  // 这里已经出现过的（同样的文字后来转进来过、贴进来过，或者就是转过来的那条）不算「近况」。只看在那句话之后出现在这里的：
  // 「1」「好」这种短句，这里几个小时前碰巧也有人说过，不等于别处刚才那句已经到了这里（实测问题 #5：私聊昨晚玩过同一个游戏，
  // 群里刚才的「1」「2」就全被当成「这里出现过」丢掉了）
  const here = new Map();
  for (const r of safe(core, 'presentHere', () => core.store.all(
    'SELECT text_hash, at FROM percepts WHERE setting_key = ? ORDER BY id DESC LIMIT 500', cues.settingKey), []) ?? []) {
    if (!(here.get(r.text_hash) >= r.at)) here.set(r.text_hash, r.at);
  }
  const hereAfter = (r) => here.has(r.text_hash) && here.get(r.text_hash) >= r.at;
  const relayIds = rows.map((r) => r.relay_of).filter((x) => Number.isInteger(x));
  const relaySettings = new Map((relayIds.length ? safe(core, 'presentRelay', () => rowsByIds(core.store,
    'SELECT id, setting_key FROM percepts WHERE id IN (?*)', relayIds), []) ?? [] : []).map((r) => [r.id, r.setting_key]));
  // 她在那边说话时，这里的人在不在跟前：同一个场合里离她这句话最近的一次他们亲自说话，按 1/(1 + Δt/h) 渐弱
  const h = Math.max(1, Number(pc.withHalfLifeMin) || 30) * 60_000;
  const othersAt = new Map();
  for (const r of rows) {
    if (r.actor_self) continue;
    if (!othersAt.has(r.setting_key)) othersAt.set(r.setting_key, []);
    othersAt.get(r.setting_key).push(r.at);
  }
  const withHere = (r) => {
    if (!r.actor_self) return 1;
    let best = 0;
    for (const t of othersAt.get(r.setting_key) ?? []) best = Math.max(best, 1 / (1 + Math.abs(t - r.at) / h));
    return best;
  };
  const items = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id) || hereAfter(r)) continue;
    if (r.relay_of != null && relaySettings.get(r.relay_of) === cues.settingKey) continue;
    seen.add(r.id);
    items.push({ ref: `p${r.id}`, text: r.text, at: r.at, w: r.w_enc, with: withHere(r), windowRef: null });
  }
  if (me != null && cues.present.includes(me)) {
    const sums = safe(core, 'presentSummaries', () => core.store.all(
      `SELECT id, narrative, header, t_end FROM episodes WHERE ep_kind = 'summary' AND setting_key <> ?
        ORDER BY t_end DESC LIMIT ?`, cues.settingKey, pc.maxItems), []);
    for (const e of sums) items.push({ ref: `e${e.id}`, text: e.narrative || e.header || '', at: e.t_end, w: null, with: 0 });
  }
  if (!items.length) return { ...empty('present'), ms: wall() - t0 };

  // 相关度：词法重合 + 线索里的实体出现在这句话里 + （有查询向量时）向量相似度
  const reg = safe(core, 'lang', () => core.mods.lang.registry(core), null);
  const qTerms = new Set();
  // 窗口那条查询不带「名字：」（和词法路一样：说话人已经是实体线索了，「我：」「某某：」当词用只会让谁说的话都沾一点边）
  const plain = (t) => (t === cues.windowText && typeof cues.windowPlain === 'string' ? cues.windowPlain : t);
  for (const t of [...cues.queryTexts.map(plain), cues.directedText].filter(Boolean)) {
    for (const w of safe(core, 'presentTerms', () => reg?.tokenize(t, { lang: cues.lang, mode: 'query' }) ?? [], [])) {
      const n = normalizeToken(w); if (n) qTerms.add(n);
    }
  }
  const cueEnts = new Set([...cues.names.map((n) => n.entityId), ...cues.mentioned]);
  const matcher = cueEnts.size ? safe(core, 'nameMatcher', () => core.mods.entities.nameMatcher(core), null) : null;
  let vecs = new Map();
  if (ctx.queryVectors && remaining(ctx) > 40) {
    const refs = items.map((i) => i.ref);
    const winIds = items.map((i) => mrefOf(i.ref)).filter((m) => m?.kind === 'percept').map((m) => m.id);
    const wmap = new Map((safe(core, 'presentWin', () => rowsByIds(core.store, 'SELECT id, window_id FROM percepts WHERE id IN (?*)', winIds), []) ?? [])
      .filter((r) => r.window_id != null).map((r) => [`p${r.id}`, `w${r.window_id}`]));
    for (const i of items) i.windowRef = wmap.get(i.ref) ?? null;
    const want = [...new Set([...refs, ...[...wmap.values()]])];
    const got = await withDeadline(() => core.mods.worker.storedVectors(core, want), Math.max(1, Math.min(remaining(ctx) - 20, 100)), ctx.signal);
    if (got.value instanceof Map) vecs = got.value;
  }
  const strength = presentStrength(core, ctx, items);
  // 活跃度和相关度一起算（代替原来的「最近 12 小时」）：B 低于 floorB 的活跃度一项是负的，要真的切题（词、实体、向量）才补得回来；
  // 补不回来的（淡了、又和眼前的事不相干）不算近况。不是先按 B 筛掉再看相关度：十几个小时前、正好切题的一句照样能想起来（评审）
  const scored = items.map((i) => {
    let lexical = 0;
    if (qTerms.size && reg) {
      const toks = new Set((safe(core, 'presentTok', () => reg.tokenize(i.text, { lang: cues.lang, mode: 'index' }), []) ?? [])
        .map(normalizeToken).filter(Boolean));
      let hit = 0;
      for (const t of toks) if (qTerms.has(t)) hit++;
      lexical = toks.size ? hit / Math.sqrt(toks.size * qTerms.size) : 0;
    }
    let ent = 0;
    if (matcher) {
      const hits = safe(core, 'presentScan', () => matcher.scan(i.text, {}), []) ?? [];
      if (hits.some((h) => cueEnts.has(h.entityId))) ent = 1;
    }
    let vec = 0;
    const v = vecs.get(i.ref) ?? (i.windowRef ? vecs.get(i.windowRef) : null);
    if (v && ctx.queryVectors) for (const q of ctx.queryVectors.vectors) vec = Math.max(vec, cosine(q, v));
    const B = strength.get(i.ref) ?? STRENGTH_FLOOR;
    const relevance = lexical + ent + Math.max(0, vec);
    const rec = pc.timeWeight * recency(ctx, pc, B);
    return { ref: i.ref, score: relevance + i.with + rec, at: i.at, live: relevance + rec >= 0 };
  }).filter((x) => x.live).sort((a, b) => b.score - a.score || b.at - a.at || (a.ref < b.ref ? -1 : 1));
  if (!scored.length) return { ...empty('present'), ms: wall() - t0 };
  const hits = scored.slice(0, pc.maxItems).map(({ ref, score }) => ({ ref, score }));
  const ms = wall() - t0;
  ctx.routeMs.present = Math.round(ms);
  return { route: 'present', hits, ms, timedOut: false };
}

// 编码强度为 0（没有痕迹）的那一条：排在有痕迹的后面，但不用 -Infinity（分数还要能比较、能当 RouteHit.score）
const STRENGTH_FLOOR = -10;

/** 单条痕迹的基础激活参数（activation 的同一套）。 */
function actParams(ctx) {
  const act = ctx.p.act;
  return {
    unit: Number(act.timeUnitMs) > 0 ? act.timeUnitMs : 3_600_000,
    floor: Math.max(1, (Number(act.ageFloorMin) || 0) * 60_000),
    d: Number.isFinite(act.a) ? act.a : 0.3,
  };
}

/**
 * B → 活跃度：刚说的（age 下限、编码强度 1）是 1，B 降到 floorB（活跃度阈值，不是时间窗）时是 0，中间按 B 线性
 * （也就是按时间的对数）；低于 floorB 的是负的（越淡越负，最低 -1），要相关度补回来。编码强度高的可以略高于同龄的，但封在 1 以内：
 * 时间这一项再大也大不过一项满分的相关度。没有痕迹的（B 读不到）按 -1。
 */
function recency(ctx, pc, B) {
  const { unit, floor, d } = actParams(ctx);
  const hi = -d * Math.log(floor / unit);
  const lo = Number.isFinite(pc.floorB) ? pc.floorB : -0.75;
  if (!(hi > lo)) return 0;
  if (!Number.isFinite(B) || B <= STRENGTH_FLOOR) return -1;
  return Math.min(1, Math.max(-1, (B - lo) / (hi - lo)));
}

/**
 * 在场者近况每一条现在的基础激活 B（ref → B）。先问 dynamics（B 的唯一来源）；它出错或没给的，按单条痕迹的同一个公式现算：
 * B = ln(w_enc) − a · ln(age)，age 以 activation.timeUnitMs 计、下限 ageFloorMin 分钟（小结没有 w_enc，按 1 算）。
 * 原话（percept）在 dynamics 里本来就是单条痕迹算的（复述、确认记在派生出来的情节和事实上），所以两种算法对它是一样的；
 * 先问 dynamics 只是让 B 的定义只有一处。只用来给这一路排序，激活打分照常由 dynamics 算。
 */
function presentStrength(core, ctx, items) {
  const got = safe(core, 'presentB', () => core.mods.dynamics.baseActivations(core, items.map((i) => i.ref), ctx.at), null);
  const out = new Map();
  const { unit, floor, d } = actParams(ctx);
  for (const i of items) {
    const b = got instanceof Map ? got.get(i.ref) : undefined;
    if (Number.isFinite(b)) { out.set(i.ref, b); continue; }
    if (b === -Infinity) { out.set(i.ref, STRENGTH_FLOOR); continue; }
    const w = i.w == null ? 1 : Number(i.w);
    if (!(w > 0)) { out.set(i.ref, STRENGTH_FLOOR); continue; }
    const age = Math.max(ctx.at - i.at, floor) / unit;
    out.set(i.ref, Math.log(w) - d * Math.log(age));
  }
  return out;
}

/** worker 的结果 → RouteResult（超时或出错的那一路丢掉：hits = []）。 */
function routeOf(route, r, t0, ctx) {
  const ms = wall() - t0;
  ctx.routeMs[route] = Math.round(ms);
  if (r.timedOut) {
    metric(ctx.core, `retrieve.route.${route}.timeout`);
    return { route, hits: [], ms, timedOut: true };
  }
  if (r.error) {
    metric(ctx.core, `retrieve.route.${route}.error`);
    log(ctx.core, 'debug', 'retrieve.route.error', { route, error: errKind(r.error) });
    return { route, hits: [], ms, timedOut: false, failed: true };
  }
  const v = r.value ?? {};
  const hits = (Array.isArray(v.hits) ? v.hits : []).filter((h) => h && typeof h.ref === 'string' && Number.isFinite(h.score));
  if (v.timedOut) metric(ctx.core, `retrieve.route.${route}.partial`);
  return { route, hits, ms, timedOut: !!v.timedOut };
}
