// 回忆（D155，设计「回忆」§2、§3、§11.4）：被问到以前的事、或者她自己决定想一想时，有目的地找——不是「浮现」那套按激活排的流水线。
// 有意回想（mode = 'deliberate'：她调记忆工具，或者这一轮被判定为「在问过去」）走这里；不自主回想（浮现）不动。
//   1. 读懂问题：buildIntent（工具参数 > 预取改写 > 语言层），得到关于谁、时间窗、场合、形状、几句换好人称的线索；
//   2. 线索：范围内的稠密和字面检索以意图的线索为主，窗口照旧是辅助；
//   3. 圈范围：scopeOf（时间、人、场合是「在哪儿找」，不是加几分）；
//   4. 范围内检索：给了范围而且不空时，在范围里做一次稠密（only）和一次字面（only，挑词用 pickLexicalTerms），按名次合并；
//      查询向量和全库那一次共用（稠密路一嵌入好就交过来），不重复嵌入；
//   5. 全库：原来的有意回想流水线照跑一次（没有范围的情况、范围之外的、版本和结果的带出、知道感、补不回的空白都靠它）；
//   6. 合并：范围内找到的在前（按合并名次，不看 B 和 S），全库的在后，去重；候选照旧带元数据、照旧算激活（B 只管「印象很模糊」）；
//   7. 盖住时间：范围有时间窗时，把有记忆的跨度等分成几段，按形状决定先盖住（timeline）、只按名次（point）还是一半一半（null）；
//   8. 名额：recall.recollect 的两档（工具 / 自动触发），随花费档位（budget.presets 的 recollectScale）。
// 出错的退路：意图、范围、范围内检索任何一步出错或超时，都退回「只有全库那一份」，记计数，不让回想失败。
// 产出的仍是还没过关口①的候选（CandidateSet），另带 recollect：意图和范围的摘要、名额、时间段（给 context 写「找了哪儿」那一行）。
import { budgetLimits } from '../config/defaults.js';
import { listPerceptShards } from '../store/fts.js';
import { buildCues } from './cues.js';
import { hydrate } from './hydrate.js';
import { buildIntent } from './intent.js';
import { params } from './params.js';
import { deadlineOf, inWindow, runRecall, scoreScoped } from './pipeline.js';
import { cachedRewrite } from './prefetch.js';
import { blendRanks, pickLexicalTerms } from './routes.js';
import { scopeOf } from './scope.js';
import { errKind, log, metric, mrefOf, rowsByIds, safe, wall, withDeadline } from './util.js';

/** 回忆这条路开着没有（recall.recollect.enabled；关掉 = 有意回想完全走原来的路）。 */
export function recollectEnabled(core) {
  try { return core.config.get().recall?.recollect?.enabled !== false; } catch { return false; }
}

/**
 * 这一档的名额（D155）：tool（她调记忆工具）/ auto（被直接问到以前的事，自动触发）；条数和总字数乘花费档位的 recollectScale（节省档 0.5）。
 * @param {object} cfg  core.config.get()
 * @param {'tool'|'auto'} kind
 * @returns {{kind: 'tool'|'auto', maxItems: number, itemChars: number, totalChars: number}}
 */
export function recollectTier(cfg, kind) {
  const r = cfg?.recall?.recollect ?? {};
  const t = (kind === 'tool' ? r.tool : r.auto) ?? { maxItems: 18, itemChars: 240, totalChars: 2000 };
  let scale = 1;
  try { scale = Number(budgetLimits(cfg).recollectScale); } catch { scale = 1; }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  scale = Math.min(1, Math.max(0.1, scale));
  return {
    kind: kind === 'tool' ? 'tool' : 'auto',
    maxItems: Math.max(1, Math.round((Number(t.maxItems) || 1) * scale)),
    itemChars: Math.max(40, Math.floor(Number(t.itemChars) || 240)),
    totalChars: Math.max(200, Math.round((Number(t.totalChars) || 2000) * scale)),
  };
}

/**
 * 回忆（见文件头）。不抛错：意图、范围、范围内检索出问题都退回全库那一份；全库那一次本身出错由调用方（retrieve.recall）兜。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null, sessionId?: string|null, trigger: string}} s
 * @param {{mode: 'deliberate', query?: string, about?: string, time?: string, where?: string, includeHistory?: boolean,
 *          deadlineMs: number, signal?: AbortSignal}} opt
 * @param {{entry?: object|null, fresh?: object|null}} [ctx]  预取缓存（查询向量、改写的线索）
 * @returns {Promise<{set: import('../core-types.js').CandidateSet, queryVectors: object|null}>}
 */
export async function recollect(core, s, opt, { entry = null, fresh = null } = {}) {
  const t0 = wall();
  const p = params(core);
  const R = p.recall.recollect ?? {};
  const kind = typeof opt?.query === 'string' && opt.query.trim() ? 'tool' : 'auto';
  const tier = recollectTier(p.cfg, kind);
  const budget = deadlineOf(p, 'deliberate', opt?.deadlineMs);
  const deadlineAt = t0 + budget;
  const left = () => Math.max(0, deadlineAt - wall());
  const ms = {};
  let fallback = null;
  const fail = (step, e) => {
    if (!fallback) fallback = step;
    metric(core, `retrieve.recollect.fallback.${step}`);
    if (e) log(core, 'warn', 'retrieve.recollect.fallback', { step, error: errKind(e) });
  };
  metric(core, `retrieve.recollect.run.${kind}`);

  // 1. 线索（和全库那一次共用一份）
  const cues = buildCues(core, {
    settingKey: s.settingKey, focusPerceptId: s.focusPerceptId ?? null, query: opt.query ?? null, about: opt.about ?? null, time: opt.time ?? null,
  });

  // 2. 读懂问题
  let intent = null;
  let rewrite = null;
  try {
    rewrite = cachedRewrite(core, s.settingKey);
    intent = buildIntent(core, cues, { query: opt.query ?? null, about: opt.about ?? null, time: opt.time ?? null, where: opt.where ?? null, rewrite });
    metric(core, `retrieve.recollect.rewrite.${!rewrite ? 'none' : rewrite.structured ? 'structured' : 'loose'}`);
    for (const f of ['about', 'time', 'where', 'shape', 'cues']) metric(core, `retrieve.recollect.intent.${f}.${intent.from?.[f] ?? 'none'}`);
  } catch (e) {
    intent = null;
    fail('intent', e);
  }

  // 3. 圈范围
  let scope = null;
  const t1 = wall();
  if (intent) {
    try {
      scope = scopeOf(core, { timeWindows: intent.timeWindows, aboutEntityIds: intent.aboutEntityIds, settingKeys: intent.settingKeys }, { at: core.now() });
      if (scope.failed) { fail('scope'); scope = null; }
    } catch (e) {
      scope = null;
      fail('scope', e);
    }
  }
  ms.scope = Math.round(wall() - t1);
  const exclude = safe(core, 'inWindow', () => inWindow(core, cues), new Set()) ?? new Set();
  const scopeRefs = scope?.given && scope.refs ? [...scope.refs].filter((r) => !exclude.has(r)) : [];
  const scoped = scopeRefs.length > 0;
  // 被判成「在问过去」、可那一句没有内容（寒暄、叫她一声，D151）也没圈出范围的一轮：没有要找的东西，不当回忆，照旧走全库流水线
  // （「看起来在问过去」判别从宽，拿不准也切过来；这种轮按回忆给三四千字只是噪声）
  if (kind === 'auto' && cues.focusContent === false && !scope?.given) {
    metric(core, 'retrieve.recollect.noContent');
    return runRecall(core, s, opt, { cues, queryVectors: entry?.queryVectors ?? null, rewrites: fresh?.rewrites ?? [] });
  }
  metric(core, scope?.given ? (scoped ? 'retrieve.recollect.scoped' : 'retrieve.recollect.scopeEmpty') : 'retrieve.recollect.unscoped');

  // 4 + 5. 范围内检索和全库那一次一起跑：字面马上开始；稠密等全库那一次的查询向量（一嵌入好就交过来）
  const K = Math.max(10, Math.floor(Number(R.scopeTopK) || 120));
  const intentCues = (intent?.cues ?? []).filter((x) => typeof x === 'string' && x);
  const searchMs = () => Math.max(1, left() - 20);
  let lexP = null;
  let denseP = null;
  if (scoped) {
    const tl = wall();
    lexP = withDeadline((signal) => scopedLexical(core, p, cues, intentCues, scopeRefs, K, signal, left),
      searchMs(), opt.signal).then((r) => { ms.scopeLexical = Math.round(wall() - tl); return r; });
  }
  const onVectors = (qv, rctx) => {
    if (!scoped || denseP || !qv?.vectors?.length) return;
    const td = wall();
    denseP = withDeadline((signal) => scopedDense(core, p, qv, rctx, intentCues, scopeRefs, exclude, K, signal, left),
      searchMs(), opt.signal).then((r) => { ms.scopeDense = Math.round(wall() - td); return r; });
  };
  // 有范围时让全库那一次也用上换好人称的线索（多一两条查询，一次嵌入），并给范围内检索留一点时间；没有范围时和原来一模一样
  const baseRewrites = fresh?.rewrites ?? [];
  const rewrites = scoped ? dedupe([...intentCues.filter((c) => !cues.queryTexts.includes(c)), ...baseRewrites]) : baseRewrites;
  const reserve = scoped ? Math.max(0, Number(R.reserveMs) || 0) : 0;
  const globalOpt = { ...opt, mode: 'deliberate', deadlineMs: Math.max(1, budget - reserve) };
  const { set, queryVectors } = await runRecall(core, s, globalOpt, { cues, queryVectors: entry?.queryVectors ?? null, rewrites, onVectors });

  // 范围内两路的结果（到点的那一路丢掉；两路都没有 = 退回全库那一份）
  let inScope = [];
  if (scoped) {
    const [lex, dense] = await Promise.all([lexP ?? null, denseP ?? null].map((x) => (x ? x : Promise.resolve(null))));
    const ok = (r) => r && !r.timedOut && !r.error && Array.isArray(r.value);
    if (lex && !ok(lex)) metric(core, `retrieve.recollect.lexical.${lex.timedOut ? 'timeout' : 'error'}`);
    if (dense && !ok(dense)) metric(core, `retrieve.recollect.dense.${dense.timedOut ? 'timeout' : 'error'}`);
    const lexHits = ok(lex) ? lex.value : [];
    const denseHits = ok(dense) ? dense.value : [];
    if (!ok(lex) && !ok(dense)) fail(lex?.timedOut || dense?.timedOut ? 'timeout' : 'search');
    else {
      try {
        inScope = mergeScoped(core, p, cues, { lexHits, denseHits, scopeRefs: new Set(scopeRefs), exclude, K, global: set.items ?? [] });
      } catch (e) {
        inScope = [];
        fail('merge', e);
      }
    }
  }

  // 6 + 7. 合并、盖住时间、名额
  const global = Array.isArray(set.items) ? set.items : [];
  const cap = Math.max(tier.maxItems, Math.floor(tier.maxItems * Math.max(1, Number(R.poolFactor) || 2)));
  const windows = intent?.timeWindows ?? [];
  let segments = [];
  let items = global;
  if (inScope.length) {
    try {
      const span = spanOf(scope.rows, windows, core.now());
      segments = span && windows.length ? cut(span, Math.max(1, Math.floor(Number(R.segments) || 6)), scope.rows) : [];
      const ordered = arrange(inScope, { shape: intent?.shape ?? null, segments, n: tier.maxItems });
      const inSet = new Set(ordered.map((c) => c.ref));
      const rest = global.filter((c) => !inSet.has(c.ref));
      const keepScoped = Math.min(ordered.length, Math.max(0, cap - Math.min(rest.length, Math.floor(cap / 4))));
      items = [...ordered.slice(0, keepScoped), ...rest].slice(0, Math.max(cap, keepScoped));
    } catch (e) {
      items = global;
      segments = [];
      fail('arrange', e);
    }
  }
  // 展示用的时间：和渲染写出来的那个时间一致（事实写的是第一次听说的时间，不是事件时间——「当天说过想吃夜宵」的事件时间是 0 点，
  // 按它排会排到最前，读起来像时间乱了）；别的用开始时间
  const heard = safe(core, 'heardAt', () => heardTimes(core, items), new Map()) ?? new Map();
  items.forEach((c, i) => {
    const t = heard.get(c.ref) ?? c.meta?.tStart ?? null;
    c.recollect = { pick: i, t: Number.isFinite(t) ? t : null, scoped: !!c.scopeRank, seg: Number.isFinite(c.seg) ? c.seg : null };
  });

  ms.total = Math.round(wall() - t0);
  const summary = {
    tier,
    fallback,
    intent: intent ? {
      aboutEntityIds: intent.aboutEntityIds.slice(0, 8), timeWindows: windows.slice(0, 4), settingKeys: intent.settingKeys.slice(0, 8),
      shape: intent.shape, cues: intentCues.slice(0, 3), from: intent.from,
    } : null,
    scope: scope?.given ? {
      given: { time: windows.length > 0, about: (intent?.aboutEntityIds ?? []).length > 0, where: (intent?.settingKeys ?? []).length > 0 },
      counts: { ...scope.counts }, total: scopeRefs.length, clipped: !!scope.clipped, found: inScope.length, searched: scoped && !fallback,
    } : null,
    segments,
    ms,
  };
  log(core, 'debug', 'retrieve.recollect', { kind, scoped, items: items.length, inScope: inScope.length, fallback, ms: ms.total });
  return {
    set: { ...set, items, mode: 'deliberate', recollect: summary, routeMs: { ...(set.routeMs ?? {}), recollect: ms.total },
      stats: { ...(set.stats ?? {}), recollect: { inScope: inScope.length, fallback } } },
    queryVectors,
  };
}

/** 事实第一次听说的时间（来源里按 hop、把握、时间排的第一条，和 retrieve.render 写出来的时间同一个口径）。 */
function heardTimes(core, items) {
  const ids = items.filter((c) => c.meta?.kind === 'assertion').map((c) => mrefOf(c.ref)?.id).filter(Number.isSafeInteger);
  const out = new Map();
  if (!ids.length) return out;
  const rows = rowsByIds(core.store, `SELECT owner_id AS id, at FROM sources WHERE owner_kind = 'assertion' AND owner_id IN (?*)
                                     ORDER BY owner_id, hop, confidence DESC, at`, ids);
  for (const r of rows) if (!out.has(`a${r.id}`) && Number.isFinite(r.at)) out.set(`a${r.id}`, r.at);
  for (const c of items) if (c.meta?.kind === 'assertion' && !out.has(c.ref) && Number.isFinite(c.meta.row?.recorded_at)) out.set(c.ref, c.meta.row.recorded_at);
  return out;
}

const dedupe = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x))];

/**
 * 范围内的字面检索：焦点层是意图的线索（换好人称的那几句），窗口其余部分是辅助（contextWeight）；不带实体词元（人已经是范围了）。
 * 返回按分数降序的 {ref, score}；原文窗口的命中是成员感知 p…（mergeScoped 再换回窗口）。
 */
async function scopedLexical(core, p, cues, intentCues, refs, K, signal, left) {
  const lx = p.recall.lexical;
  const focus = (intentCues.length ? intentCues : [cues.directedText, ...cues.queryTexts]).filter(Boolean).join('\n');
  const rest = cues.windowPlain ?? cues.windowText ?? '';
  const termsOf = (text) => (text ? safe(core, 'queryTerms', () => core.mods.lang.queryTerms(core, text, { lang: cues.lang, entityIds: [] }), []) ?? [] : []);
  const norm = (ts) => [...new Set(ts.map((t) => String(t).normalize('NFKC').toLowerCase()).filter((t) => t && !/^ent_\d+$/u.test(t)))];
  const tier1 = norm(termsOf(focus || rest));
  const tier2 = focus ? norm(termsOf(rest)).filter((t) => !tier1.includes(t)) : [];
  if (!tier1.length && !tier2.length) return [];
  const tiers = [{ text: focus || rest, terms: tier1, weight: 1 }, { text: focus ? rest : '', terms: tier2, weight: lx.contextWeight ?? 0.3 }];
  const live = (cues.window ?? []).map((w) => w.perceptId).filter(Number.isInteger);
  const gram = (t) => { const c = [...t]; return c.length === 2 ? c : []; };
  const all = [...new Set(tiers.flatMap((t) => [...t.terms, ...t.terms.flatMap(gram)]))];
  const st = await withDeadline(() => core.mods.worker.termStats(core, all, live.length ? { excludePercepts: live } : undefined),
    Math.max(1, Math.min(left() / 3, 150)), signal);
  const stats = st.value instanceof Map ? st.value : null;
  const classOf = (t) => safe(core, 'termClass', () => core.mods.lang.termClass?.(core, t, { lang: cues.lang }) ?? null, null);
  const { terms, weights } = pickLexicalTerms(tiers, stats, { ...lx, classOf });
  if (!terms.length) return [];
  const tables = [...(safe(core, 'shards', () => listPerceptShards(core.store), []) ?? []), 'episodes_fts', 'assertions_fts'];
  const r = await core.mods.worker.lexicalSearch(core, { terms, weights, tables, limit: K, only: refs }, { deadlineMs: Math.max(1, left() - 10), signal });
  return Array.isArray(r?.hits) ? r.hits.filter((h) => h && typeof h.ref === 'string' && Number.isFinite(h.score)) : [];
}

/**
 * 范围内的稠密检索：查询向量是全库那一次嵌入好的（不重复嵌入）。意图的线索那几条是主查询；窗口那一条是辅助，
 * 名次按 recall.dense.windowWeight 打折再融合（和稠密路同一个口径，D149）。没有对得上线索的向量时用除窗口以外的全部。
 */
async function scopedDense(core, p, qv, rctx, intentCues, refs, exclude, K, signal, left) {
  const texts = [...(rctx?.cues?.queryTexts ?? []), ...(rctx?.cues?.rewrites ?? [])].filter(Boolean).slice(0, p.x.maxQueryVectors);
  const vecs = qv.vectors;
  const n = Math.min(texts.length, vecs.length);
  const win = rctx?.cues?.windowText ? texts.indexOf(rctx.cues.windowText) : -1;
  let main = [];
  for (let i = 0; i < n; i++) if (i !== win && intentCues.includes(texts[i])) main.push(i);
  if (!main.length) for (let i = 0; i < n; i++) if (i !== win) main.push(i);
  if (!main.length) main = [...Array(n).keys()];
  const search = (idx) => core.mods.worker.denseSearch(core, {
    vectors: idx.map((i) => vecs[i]), spaceId: qv.spaceId, layers: ['memory', 'raw'], topK: { memory: K, raw: K },
    includeCold: true, exclude: exclude.size ? exclude : undefined, only: refs,
  }, { deadlineMs: Math.max(1, left() - 10), signal });
  const ww = Number(p.recall.dense.windowWeight);
  if (win >= 0 && win < n && !main.includes(win) && Number.isFinite(ww) && ww > 0 && ww < 1) {
    const [a, b] = await Promise.all([search(main), search([win])]);
    return blendRanks([[a?.hits ?? [], 1], [b?.hits ?? [], ww]], p.recall.rrfK, 2 * K);
  }
  const r = await search(main);
  return Array.isArray(r?.hits) ? r.hits : [];
}

/**
 * 范围内两路按名次合并（RRF，两路一样重），字面命中的成员感知换回它所在的、在范围里的原文窗口（窗口带着上下文和她看到的图），
 * 眼前这段对话里的去掉。全库那一份里已经有的沿用那一条（它的激活、版本、知道感照旧），另记范围内的名次；全库那一份里在范围里、
 * 范围内两路没找到的排在后面。没在全库里的补上元数据、算激活（S = 0、C 按范围内的名次，B 照常——只管「印象很模糊」）。
 * 返回按范围内名次排好的候选（每条带 scopeRank）。
 */
function mergeScoped(core, p, cues, { lexHits, denseHits, scopeRefs, exclude, K, global }) {
  // 字面路的原文命中是成员感知：换成在范围里的那个窗口
  const pIds = lexHits.map((h) => (/^p(\d+)$/u.exec(h.ref) ? Number(h.ref.slice(1)) : null)).filter(Number.isSafeInteger);
  const winOf = new Map((pIds.length ? rowsByIds(core.store, 'SELECT id, window_id FROM percepts WHERE id IN (?*)', pIds) : [])
    .filter((r) => Number.isSafeInteger(r.window_id)).map((r) => [`p${r.id}`, `w${r.window_id}`]));
  const lex = [];
  for (const h of lexHits) {
    let ref = h.ref;
    if (ref.startsWith('p')) {
      const w = winOf.get(ref);
      if (w && scopeRefs.has(w)) ref = w;
    }
    // 只认范围里的（worker 的 only 已经限定了，这里再核一道：换不回窗口的成员感知、范围外的都不要）
    if (exclude.has(ref) || !scopeRefs.has(ref)) continue;
    lex.push({ ref, score: h.score });
  }
  const dense = denseHits.filter((h) => !exclude.has(h.ref) && scopeRefs.has(h.ref));
  const fused = blendRanks([[dense, 1], [lex, 1]], p.recall.rrfK, 2 * K);
  const rankIn = (list) => { const m = new Map(); let r = 0; for (const h of list) if (!m.has(h.ref)) m.set(h.ref, ++r); return m; };
  const dRank = rankIn(dense);
  const lRank = rankIn(lex);
  const byRef = new Map(global.map((c) => [c.ref, c]));
  const order = fused.map((h) => h.ref);
  for (const c of global) if (scopeRefs.has(c.ref) && !order.includes(c.ref)) order.push(c.ref);
  const need = order.filter((r) => !byRef.has(r));
  const meta = need.length ? hydrate(core, need) : new Map();
  const fresh = [];
  const out = [];
  order.forEach((ref, i) => {
    let c = byRef.get(ref);
    if (!c) {
      const m = meta.get(ref);
      if (!m) return;
      c = { ref, mref: mrefOf(ref), ranks: {}, rrf: 0, signals: {}, meta: m };
      if (dRank.has(ref)) c.ranks.dense = dRank.get(ref);
      if (lRank.has(ref)) c.ranks.lexical = lRank.get(ref);
      fresh.push(c);
    }
    c.scopeRank = i + 1;
    c.scopeRanks = { dense: dRank.get(ref) ?? null, lexical: lRank.get(ref) ?? null };
    out.push(c);
  });
  if (fresh.length) scoreScoped(core, fresh, { cues, mode: 'deliberate' });
  return out.filter((c) => c.meta);
}

/** 范围里有记忆的时间跨度（和时间窗取交，不超过现在）；没有就 null。 */
function spanOf(rows, windows, now) {
  const ts = (rows ?? []).filter((r) => Number.isFinite(r.tStart));
  if (!ts.length) return null;
  let start = Math.min(...ts.map((r) => r.tStart));
  let end = Math.max(...ts.map((r) => (Number.isFinite(r.tEnd) ? r.tEnd : r.tStart)));
  if (windows.length) {
    start = Math.max(start, Math.min(...windows.map((w) => w.start)));
    end = Math.min(end, Math.max(...windows.map((w) => w.end)));
  }
  if (Number.isFinite(now)) end = Math.min(end, now);
  return end >= start ? { start, end } : null;
}

/**
 * 把跨度等分成 k 段（D155，通用的、不按话题）：每段 {start, end, total}，total 是范围里落在这一段（按开始时间，早于跨度的算第一段）的记忆条数。
 */
function cut(span, k, rows) {
  const len = Math.max(1, span.end - span.start);
  const n = len < 60_000 ? 1 : k;
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

/**
 * 范围内找到的排成名次（D155「盖住时间」）：有时间段时，先轮流从每一段取对题的下一条（每段的候选按范围内名次），盖住的条数：
 * shape = 'timeline' 是全部 n 条（每段都要有代表），null 是一半，'point' 不盖（只按名次）；其余按范围内名次补上。
 * 没有时间段时只按名次。每条记下所在的段（seg）。
 * @param {object[]} list  按范围内名次排好的候选
 * @param {{shape: string|null, segments: {start: number, end: number}[], n: number}} o
 * @returns {object[]}
 */
export function arrange(list, { shape, segments, n }) {
  for (const c of list) c.seg = segments.length ? segOf(segments, c.meta?.tStart) : null;
  if (!segments.length) return [...list];
  const cover = shape === 'timeline' ? n : shape === 'point' ? 0 : Math.ceil(n / 2);
  const bySeg = segments.map(() => []);
  for (const c of list) if (c.seg != null) bySeg[c.seg].push(c);
  const picked = [];
  const taken = new Set();
  for (let round = 0; picked.length < cover; round++) {
    let any = false;
    for (const q of bySeg) {
      if (picked.length >= cover) break;
      const c = q[round];
      if (!c) continue;
      any = true;
      picked.push(c);
      taken.add(c.ref);
    }
    if (!any) break;
  }
  return [...picked, ...list.filter((c) => !taken.has(c.ref))];
}
