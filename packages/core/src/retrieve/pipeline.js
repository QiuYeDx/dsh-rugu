// 召回的主流程（§8.3、§6.5、§6.6、§8.8）：
//   线索 → 五路并行（各自截止）→ RRF 融合 → 预过滤（只看能不能访问）→ 元数据 → 激活打分（S、C 由这里算，B、I、P_sup、ε 由 dynamics）
//   → 不自主回想按 P 抽样 / 有意回想 A ≥ τ_del → 有余力就重排前 30 条（替换 C 里稠密和 BM25 的部分）→ MMR
//   → 版本（最近被取代的跟着新版本带出）和发生次（最近的一次排前，时间接近标「可能指多次」）→ 每个实体最多 3 条。
// 产出的是还没过关口①的候选；这里永远不按「这里能不能说」过滤（§8.2）。
import crypto from 'node:crypto';
import { buildCues, cuesEmpty, directEntities } from './cues.js';
import { denseRoute, entityRoute, lexicalRoute, presentRoute, queryInputs, remaining, timeRoute } from './routes.js';
import { fuse, mmr } from './fuse.js';
import { hydrate, occTime } from './hydrate.js';
import { params } from './params.js';
import { rerankUsable, staticLevel } from './level.js';
import { clamp, cosine, errKind, log, metric, mrefOf, rowsByIds, safe, selfId, wall, withDeadline } from './util.js';
import { entityToken, normalizeToken } from '../store/fts.js';

const ROUTES = ['dense', 'lexical', 'entity', 'time', 'present'];

/** 空的候选集（线索为空、存储故障、出错时）。 */
export function emptySet(cues, level, extra = {}) {
  return { items: [], cues: cues ?? null, degradeLevel: level, routeMs: {}, traceId: traceId(), ...extra };
}
const traceId = () => `r${crypto.randomBytes(6).toString('hex')}`;

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null, sessionId?: string|null, trigger: string}} s
 * @param {{mode: 'involuntary'|'deliberate', query?: string, about?: string, time?: string, includeHistory?: boolean,
 *          deadlineMs: number, signal?: AbortSignal}} opt
 * @param {{cues?: object, noDense?: boolean, rewrites?: string[], queryVectors?: object|null, exclude?: Set<string>}} [internal]
 * @returns {Promise<{set: import('../core-types.js').CandidateSet, queryVectors: object|null}>}
 */
export async function runRecall(core, s, opt, internal = {}) {
  const t0 = wall();
  const p = params(core);
  const mode = opt?.mode === 'deliberate' ? 'deliberate' : 'involuntary';
  const level0 = staticLevel(core);
  if (level0 >= 4) return { set: emptySet(null, 4), queryVectors: null };
  const cues = internal.cues ?? buildCues(core, {
    settingKey: s.settingKey, focusPerceptId: s.focusPerceptId ?? null, query: opt.query ?? null, about: opt.about ?? null, time: opt.time ?? null,
  });
  if (internal.rewrites?.length) cues.rewrites = internal.rewrites.slice(0, p.x.rewrite.maxCues);
  if (cuesEmpty(cues) || opt.signal?.aborted) return { set: emptySet(cues, level0), queryVectors: null };

  const cap = mode === 'deliberate' ? p.recall.deliberate.deadlineMs : p.recall.involuntary.deadlineMs;
  const budget = Math.min(Number.isFinite(opt.deadlineMs) && opt.deadlineMs > 0 ? opt.deadlineMs : cap, cap);
  /** @type {import('./routes.js').RouteCtx} */
  const ctx = {
    core, p, cues, mode, at: core.now(), deadlineAt: t0 + budget - p.x.routeReserveMs, signal: opt.signal, level: level0,
    noDense: !!internal.noDense, queryVectors: null, embedFailed: false, pseudo: false,
    exclude: new Set([...(internal.exclude ?? []), ...inWindow(core, cues)]), routeMs: {},
  };
  if (internal.queryVectors && internal.queryVectors.hash === queryInputs(ctx).join('\u0001')) ctx.queryVectors = internal.queryVectors;

  // ── 五路并行 ──
  const lexP = guard(ctx, 'lexical', lexicalRoute(ctx));
  const entP = guard(ctx, 'entity', entityRoute(ctx, lexP));
  const timeP = guard(ctx, 'time', timeRoute(ctx));
  const presP = guard(ctx, 'present', presentRoute(ctx));
  const denseP = guard(ctx, 'dense', denseRoute(ctx, [lexP, entP]));
  const routes = await Promise.all([denseP, lexP, entP, timeP, presP]);

  // ── 预过滤（只看能不能访问：隐藏 / 忘掉 / 墓碑；眼前的对话；没被线索点到的档案卡）→ 融合 → 元数据 ──
  // 先过滤再融合：被剔掉的不占各路的名次，也不占 fuseKeep 的名额
  const me = selfId(core);
  const direct = directEntities(cues, me);
  const uncued = (ref) => { const m = mrefOf(ref); return m?.kind === 'entity' && !direct.has(m.id); };
  const allRefs = [...new Set(routes.flatMap((r) => r.hits.map((h) => h.ref)))].filter((ref) => !ctx.exclude.has(ref) && !uncued(ref));
  const blocked = suppressed(core, allRefs);
  if (blocked === null) return { set: emptySet(cues, level0, { routeMs: ctx.routeMs, failed: 'suppression' }), queryVectors: ctx.queryVectors };
  const visible = routes.map((r) => ({ ...r, hits: r.hits.filter((h) => !ctx.exclude.has(h.ref) && !blocked.has(h.ref) && !uncued(h.ref)) }));
  let fused = fuse(visible, { k: p.recall.rrfK, keep: p.recall.fuseKeep });
  const meta = hydrate(core, fused.map((c) => c.ref));
  fused = fused.filter((c) => meta.has(c.ref));
  for (const c of fused) c.meta = meta.get(c.ref);

  // ── 激活打分 ──
  const fan = fanOf(core, direct);
  const pprMax = Math.max(0, ...fused.map((c) => c.signals.ppr ?? 0));
  const bm25Max = Math.max(0, ...fused.map((c) => c.signals.bm25 ?? 0));
  const presentOthers = new Set(cues.present.filter((e) => e !== me));
  for (const c of fused) {
    c.signals.timeHit = c.signals.timeHit ?? timeOverlap(c.meta, cues.timeWindows);
    c.signals.contextSim = contextSim(c.meta, cues.settingKey, presentOthers, p.x.contextSim);
  }
  const inputs = fused.map((c) => activationInput(c, { p, direct, fan, pprMax, bm25Max, present: presentOthers, core }));
  const seed = [cues.settingKey, String(cues.latestPerceptId), mode];
  let scored = activate(core, p, inputs, { at: ctx.at, mode, seed });
  let sampled = sample(core, p, scored, { mode, seed });

  // ── 知道感（有意回想）：线索很强、只差一点没想起来的，给一行「好像听谁提过，想不起细节」（§6.6）──
  const fok = mode === 'deliberate' ? feelingOfKnowing(p, scored, sampled) : [];

  // ── 重排：有余力、端口可用才做（§8.4）──
  let reranked = false;
  if (sampled.length > 1 && rerankUsable(core) && remaining(ctx) >= p.x.rerank.minMs) {
    reranked = await rerank(core, p, ctx, sampled, mode);
  }
  sampled.sort(byA);

  // ── MMR ──
  // 相关度用这一批里归一化到 0–1 的 A：P 在有意回想（τ_del 很低）时几乎全是 1，拿它做 MMR 就只剩「多样」没有「相关」。
  // 在场者近况（这一路找到的）自成一组，名额是 recall.present.maxItems，不和别的几路抢 limit 那几条（实测问题 #5）：
  // 上下文里它本来就是单独的一层、有自己的条数和字数上限（§10.4），在这里先被一大堆别的候选按带噪声的 A 挤掉，
  // 那一层的名额就是空的——主人两分钟前在别处定下的游戏规则排在第 40 名，连关口①都到不了。两组各自做 MMR，再按 A 合并。
  const limit = (mode === 'deliberate' ? p.recall.deliberate.maxItems : p.recall.involuntary.maxItems) * p.x.poolFactor;
  const presentLimit = Math.max(0, Number(p.x.present.maxItems) || 0);
  const general = sampled.filter((c) => !viaPresent(c));
  const pool = general.slice(0, limit * 2);
  const presentPool = sampled.filter(viaPresent).slice(0, presentLimit * 2);
  const both = [...pool, ...presentPool];
  const vecs = both.length > 1 && remaining(ctx) > 20 ? await vectorsFor(core, ctx, both.map((c) => c.ref)) : new Map();
  const tokens = tokenSets(core, cues.lang, both);
  // 几乎一样的文字（同一种记忆、同一批场合）合并成一条：MMR 只往后排，名额够时两段几乎一样的情节照样都占名额
  const dupJ = Number.isFinite(p.recall.mmrDupJaccard) ? p.recall.mmrDupJaccard : 0.8;
  const pick = (items, n) => mmr(items, {
    lambda: p.recall.mmrLambda, limit: n, score: relevanceScale(items),
    sim: (a, b) => similarity(a, b, vecs, tokens),
    dup: dupJ > 0 && dupJ <= 1 ? (a, b) => {
      if (!nearDuplicate(a, b, tokens, dupJ)) return false;
      (b.duplicates ??= []).push(a.ref);
      return true;
    } : undefined,
  });
  let list = mergeByA(pick(pool, limit), pick(presentPool, presentLimit));
  const merged = list.reduce((n, c) => n + (c.duplicates?.length ?? 0), 0);
  if (merged) metric(core, 'retrieve.mmr.merged');

  // ── 沿链接带出：版本、计划的结果、发生次；每个实体最多 3 条 ──
  // 有意回想沿链接多跳（§6.6）：完成（计划 → 结果）、取代（往回几版）、同一类事的其他几次；同一件事、可能同一个人由实体扩散路的图负责
  const anchorCtx = { core, p, ctx, seed, mode, at: ctx.at, scoredByRef: new Map(scored.map((c) => [c.ref, c])) };
  const deep = !!opt.includeHistory || (mode === 'deliberate' && cues.pastQuestion);
  list = attachVersions(anchorCtx, list, deep);
  if (mode === 'deliberate' || opt.includeHistory) list = attachOutcomes(anchorCtx, list);
  list = orderOccurrences(anchorCtx, list);
  list = capPerEntity(list, p.recall.perEntityMax, new Set([me, ...cues.aboutEntityIds].filter((x) => x != null)));
  for (const f of fok) if (!list.some((c) => c.ref === f.ref)) list.push(f);
  markBelief(core, list, direct);
  // 补不回的空白（§12.4.5 第 8 步）：有意回想碰到整体恢复后没补回来的那段时间，像人记不清一样说「好像有点印象」。
  // 排在最前：问的就是那几天（或者什么都没想起来），这一行是这次回想的主要答案；排在最后会被上下文的条数上限挤掉
  if (mode === 'deliberate' && s.trigger !== 'extract') {
    const blank = blankFor(anchorCtx, cues, list);
    if (blank) list.unshift(blank);
  }

  let level = level0;
  if (ctx.embedFailed || ctx.pseudo) level = Math.max(level, 3);
  if (!reranked && level < 1) level = 1;
  ctx.routeMs.total = Math.round(wall() - t0);
  const set = {
    items: list, cues, degradeLevel: /** @type {0|1|2|3|4} */ (level), routeMs: ctx.routeMs, traceId: traceId(),
    mode, stats: { fused: fused.length, sampled: sampled.length, reranked, routes: routes.map((r) => ({ route: r.route, hits: r.hits.length, timedOut: !!r.timedOut })) },
  };
  metric(core, `retrieve.recall.${mode}`);
  metric(core, `retrieve.level.${level}`);
  log(core, 'debug', 'retrieve.recall', { mode, level, items: list.length, fused: fused.length, ms: ctx.routeMs.total });
  return { set, queryVectors: ctx.queryVectors };
}

/*
 * 档案卡（kind = entity：名字和关系描述）只在线索直接点到这个实体时才算想起来（正文里的名字、关系路径、@ / 引用 / 回复、
 * 正在对她说话的人，directEntities）。档案卡的文字很短，稠密路上和什么都有点像，图扩散里又是枢纽：没有线索时进来只占名额，
 * 还会把别的场合的名字送到她眼前（场合也是实体，§5.8）。她自己的档案卡永远不算（她就在这里；她自己的事在常驻区）。
 * 在场的人的人物卡由 context 的人物卡层另外给。档案卡照常是图扩散的中间节点，只是不当成想起来的一条。
 */

/**
 * 眼前这段对话（线索窗口）本身不算「想起来的」：窗口里的感知、整段落在窗口里的原文窗口，她此刻就在上下文里看着
 * （和 context 去掉本周期已发过的同一个道理）。这不是「能不能说」的过滤，只是不把眼前的话当回忆。
 */
function inWindow(core, cues) {
  const out = new Set();
  const ids = (cues.window ?? []).map((w) => w.perceptId).filter(Number.isInteger);
  if (!ids.length) return out;
  for (const id of ids) out.add(`p${id}`);
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  for (const r of safe(core, 'windowRaw', () => core.store.all(
    'SELECT id FROM raw_windows WHERE setting_key = ? AND first_percept >= ? AND last_percept <= ?', cues.settingKey, lo, hi), []) ?? []) {
    out.add(`w${r.id}`);
  }
  return out;
}

/** 一路到点还没完成就丢掉（硬截止，§8.8）。 */
async function guard(ctx, route, promise) {
  const ms = Math.max(1, remaining(ctx) + ctx.p.x.routeReserveMs / 2);
  const r = await withDeadline(() => promise, ms);
  if (r.timedOut) {
    ctx.routeMs[route] = Math.round(r.ms);
    metric(ctx.core, `retrieve.route.${route}.timeout`);
    return { route, hits: [], ms: r.ms, timedOut: true };
  }
  if (r.error) {
    log(ctx.core, 'debug', 'retrieve.route.error', { route, error: errKind(r.error) });
    metric(ctx.core, `retrieve.route.${route}.error`);
    return { route, hits: [], ms: r.ms, timedOut: false, failed: true };
  }
  return r.value;
}

/** 预过滤（隐藏、忘掉、墓碑）。拿不到结果就当全都不能访问（fail closed），返回 null。 */
function suppressed(core, refs) {
  if (!refs.length) return new Set();
  try {
    const s = core.mods.admin.suppressedRefs(core, refs);
    return s instanceof Set ? s : new Set(s ?? []);
  } catch (e) {
    log(core, 'warn', 'retrieve.suppression.failed', { error: errKind(e) });
    metric(core, 'retrieve.suppression.failed');
    return null;
  }
}

/**
 * 线索直接认出的实体名下有多少条记忆（扇出项的 fan，§6.5「fan 是这个实体名下的记忆条数」）：关于他的事实（主体、宾语、提到他），
 * 加上他在场的情节——扇出项也加在这些情节上，只数事实的话，事实少、聊得多的人每段经历都拿满 S_max。
 * 情节按 episodes_fts 里的实体词元数（ent_<id> 就是情节的参与者，encode 写情节时加的），走 FTS 索引，不扫情节表。
 */
function fanOf(core, direct) {
  const m = new Map();
  if (!direct.size) return m;
  const rows = safe(core, 'fan', () => rowsByIds(core.store,
    "SELECT entity_id AS e, COUNT(*) AS n FROM assertion_entities WHERE entity_id IN (?*) AND role IN ('subject','object','mention') GROUP BY entity_id",
    [...direct]), []);
  const facts = new Map((rows ?? []).map((r) => [r.e, Number(r.n) || 0]));
  for (const e of direct) {
    const eps = Number(safe(core, 'fanEpisodes', () => core.store.get('SELECT count(*) AS n FROM episodes_fts WHERE episodes_fts MATCH ?',
      `"${entityToken(e)}"`)?.n, 0)) || 0;
    m.set(e, Math.max(1, (facts.get(e) ?? 0) + eps));
  }
  return m;
}

/** 记忆的时间落在线索的时间窗里吗（没有时间窗 → undefined，不加分也不减分）。 */
function timeOverlap(meta, windows) {
  if (!windows.length || meta.tStart == null) return undefined;
  const lo = meta.tStart;
  const hi = meta.tEnd ?? meta.tStart;
  return windows.some((w) => hi >= w.start && lo <= w.end) ? 1 : 0;
}

/** γ 项：编码情境和现在像不像（同一个场合、当时和谁在一起），连续加分，不是过滤（§6.5）。 */
function contextSim(meta, settingKey, present, w) {
  const same = meta.settingKeys.includes(settingKey) ? 1 : 0;
  const parts = new Set(meta.participants);
  let inter = 0;
  for (const e of parts) if (present.has(e)) inter++;
  const union = new Set([...parts, ...present]).size;
  const j = union ? inter / union : 0;
  return w.sameSetting * same + w.participants * j;
}

/**
 * C 的分解：调参前稠密和词法用各路的 RRF 名次分代替（§6.5），名次分在 cRankDepth 处降到 0；
 * 时间用时间窗命中度；γ 用编码情境相似度。调参后（useRrfForC=false）换成 β 加权的原始分数。
 */
export function cParts(c, p, bm25Max) {
  const w = p.recall.weights;
  const g = (rank) => rankScore(p, rank);
  const rrfMode = p.recall.useRrfForC !== false;
  const dense = rrfMode ? w.dense * g(c.ranks.dense) : w.dense * Math.max(0, c.signals.dense ?? 0);
  const lexical = rrfMode ? w.bm25 * g(c.ranks.lexical) : w.bm25 * (bm25Max > 0 ? Math.max(0, c.signals.bm25 ?? 0) / bm25Max : 0);
  const present = p.x.weightsPresent * g(c.ranks.present);
  const time = w.time * (Number.isFinite(c.signals.timeHit) ? clamp(c.signals.timeHit, 0, 1) : 0);
  const context = w.context * (c.signals.contextSim ?? 0);
  return { dense, lexical, present, time, context, total: dense + lexical + present + time + context };
}

/** RRF 名次分：第 1 名 1，到 cRankDepth 名降到 0（C 的稠密、词法、在场者近况，调参前的重排都用它）。 */
function rankScore(p, rank) {
  if (!rank) return 0;
  const k = p.recall.rrfK;
  const floor = (k + 1) / (k + p.x.cRankDepth);
  return Math.max(0, ((k + 1) / (k + rank) - floor) / (1 - floor));
}

function activationInput(c, o) {
  const { p, direct, fan, pprMax } = o;
  const Smax = p.act.fanSMax;
  const sPpr = pprMax > 0 && c.signals.ppr != null ? Smax * clamp(c.signals.ppr / pprMax, 0, 1) : 0;
  let sFan = 0;
  const about = c.meta.kind === 'episode' ? [...c.meta.about, ...c.meta.participants] : c.meta.about;
  for (const e of about) if (direct.has(e)) sFan = Math.max(sFan, Math.max(0, Smax - Math.log(fan.get(e) ?? 1)));
  const cp = cParts(c, p, o.bm25Max);
  c.cParts = cp;
  const row = c.meta.row ?? {};
  let cueHit = false;
  if (c.meta.kind === 'intention') {
    const t = row.target_entity_id;
    cueHit = t != null && (direct.has(t) || o.present.has(t));
    if (!cueHit && row.about_kind === 'assertion' && Number.isInteger(row.about_id)) {
      const subs = safe(o.core, 'cueHit', () => o.core.store.all(
        "SELECT entity_id AS e FROM assertion_entities WHERE assertion_id = ? AND role IN ('subject','object')", row.about_id), []);
      cueHit = subs.some((r) => direct.has(r.e));
    }
  }
  return {
    candidate: c,
    S: sPpr + sFan,
    C: cp.total,
    superseded: c.meta.kind === 'assertion' && row.superseded_by != null,
    intention: c.meta.kind === 'intention' ? row : null,
    cueHit,
  };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const byA = (a, b) => b.A - a.A || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

/** dynamics.activate；它出错时退回只用 S + C − P_sup（不让聊天停下，记计数）。 */
function activate(core, p, inputs, ctx) {
  if (!inputs.length) return [];
  try {
    const out = core.mods.dynamics.activate(core, inputs, ctx);
    if (Array.isArray(out)) {
      // 保证 meta 等附加字段还在（dynamics 可能返回新对象）
      const byRef = new Map(inputs.map((i) => [i.candidate.ref, i.candidate]));
      return out.map((c) => Object.assign(byRef.get(c.ref) ?? c, { A: c.A, P: c.P, parts: c.parts }));
    }
  } catch (e) {
    log(core, 'warn', 'retrieve.dynamics.fallback', { step: 'activate', error: errKind(e) });
    metric(core, 'retrieve.dynamics.fallback');
  }
  const tau = ctx.mode === 'deliberate' ? p.act.tauDeliberate : p.act.tauInvoluntary;
  return inputs.map((i) => {
    const Psup = i.superseded ? p.act.supersededPenalty : 0;
    const A = i.S + i.C - Psup;
    return Object.assign(i.candidate, { A, P: sigmoid((A - tau) / p.act.s), parts: { B: 0, S: i.S, C: i.C, I: 0, Psup, eps: 0 } });
  });
}
function sample(core, p, scored, ctx) {
  if (!scored.length) return [];
  try {
    const out = core.mods.dynamics.sample(core, scored, ctx);
    if (Array.isArray(out)) {
      const byRef = new Map(scored.map((c) => [c.ref, c]));
      return out.map((c) => byRef.get(c.ref) ?? c);
    }
  } catch (e) {
    log(core, 'warn', 'retrieve.dynamics.fallback', { step: 'sample', error: errKind(e) });
    metric(core, 'retrieve.dynamics.fallback');
  }
  return ctx.mode === 'deliberate' ? scored.filter((c) => c.A >= p.act.tauDeliberate) : scored.filter((c) => c.P >= 0.5);
}

/**
 * 知道感：有意回想里没想起来（A < τ_del）、但线索命中很强（某一路前 3 名）而且差得不多的，最多 fok.maxItems 条。
 * 渲染时只说「好像听谁提过，想不起细节了」，不给内容；能不能说照常过关口①（§6.6、§9.3.4）。
 */
function feelingOfKnowing(p, scored, sampled) {
  const got = new Set(sampled.map((c) => c.ref));
  const tau = p.act.tauDeliberate;
  return scored
    .filter((c) => !got.has(c.ref) && c.A >= tau - p.x.fok.margin
      && ['assertion', 'episode', 'percept', 'window'].includes(c.meta?.kind)
      && Object.values(c.ranks).some((r) => r <= 3))
    .sort(byA).slice(0, p.x.fok.maxItems)
    .map((c) => Object.assign(c, { fok: true }));
}

/**
 * 补不回的空白（§12.4.5 第 6、8 步）：整体恢复之后，有些场合快照之后的经历没能从来源补回来（backup.replayStatus 的 gaps，
 * missing > 0）。她不会被告知「你被恢复了」；有意回想碰到那段时间时，像人记不清一样：「好像有点印象，记不太清了」。
 * 「碰到」：
 *   - 线索里的时间落在空白里（哪个场合的空白都算：问的就是那几天；不设期限，那几天她永远记不清）；
 *   - 没给时间时：空白就在这个场合、这次没想起任何经历（连知道感都没有；在场的人的档案不算），而且眼下这场对话是接着空白那段聊下来的
 *     （continuesFrom）。隔了一段长沉默的新对话里想不起来的事，和那段空白没有关系，照常是「想不起来」。
 * 这一行锚在这个场合的一条感知上（空白之前最近的，没有就用空白之后最早的；已经在这次结果里的、眼前这段对话里的、隐藏 / 忘掉的
 * 跳过；附近的都已经想起来了就锚在那个场合的档案卡上），照常过关口①：能不能在这里提那个场合的「那几天」由它决定。
 * 渲染只写时间，不给锚点的内容（候选带 fok + blank）。
 * 每次最多一行，取最近的那段空白。
 * @returns {object|null}
 */
function blankFor(ac, cues, list) {
  const { core } = ac;
  const status = safe(core, 'replayStatus', () => core.mods.backup.replayStatus(core), null);
  const gaps = (status?.gaps ?? []).filter((g) => typeof g?.settingKey === 'string' && Number.isFinite(g.from) && Number.isFinite(g.to)
    && g.to >= g.from && (Number.isFinite(g.missing) ? g.missing > 0 : true));
  if (!gaps.length) return null;
  const tw = cues.timeWindows ?? [];
  // 「什么都没想起来」：没有任何经历类的记忆（连知道感都没有）；在场的人的档案、印象只是「谁在说话」，不算想起了这件事
  const nothing = !list.some((c) => EVENT_KINDS.has((c.mref ?? mrefOf(c.ref))?.kind));
  const hits = gaps
    .filter((g) => (tw.length
      ? tw.some((w) => w.end >= g.from && w.start <= g.to)
      : nothing && g.settingKey === cues.settingKey && continuesFrom(ac, g)))
    .sort((a, b) => b.to - a.to);
  const taken = new Set(list.map((c) => c.ref));
  for (const g of hits) {
    const c = blankAnchor(ac, g, taken);
    if (!c) continue;
    metric(core, 'retrieve.blank');
    return { ...c, fok: true, blank: { from: g.from, to: g.to, settingKey: g.settingKey, here: g.settingKey === cues.settingKey } };
  }
  return null;
}

// 找空白的锚点时，往前、往后各最多看几条（只是查询成本的上限：跳过的是已经想起来的、眼前的、隐藏的）
const BLANK_ANCHOR_TRIES = 5;
// 经历类的记忆（空白里丢的就是这些）：原话、原文窗口、情节、事实
const EVENT_KINDS = new Set(['percept', 'window', 'episode', 'assertion']);

/** 空白那个场合里给这一行当锚点的感知（见 blankFor）。找不到返回 null。 */
function blankAnchor(ac, g, taken) {
  const { core } = ac;
  // 已经想起来的、眼前这段对话里的感知直接跳过，不占「最多看几条」的名额（这一次想起来的越多，越要往前多看几条）
  const skip = [...taken, ...ac.ctx.exclude].filter((r) => r.startsWith('p')).length;
  const lim = BLANK_ANCHOR_TRIES + skip;
  const rows = safe(core, 'blankAnchor', () => [
    ...core.store.all('SELECT id FROM percepts WHERE setting_key = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?', g.settingKey, g.from, lim),
    ...core.store.all('SELECT id FROM percepts WHERE setting_key = ? AND at > ? ORDER BY at, id LIMIT ?', g.settingKey, g.to, lim),
  ], []) ?? [];
  for (const r of rows) {
    const ref = `p${r.id}`;
    if (taken.has(ref)) continue;
    const c = linked(ac, ref, { parts: { S: 0, C: 0 } });
    if (c) return c;
  }
  // 附近的感知都已经想起来了（库还小、问的就是这个场合的事）：锚在那个场合的档案卡上——「能不能在这里提那个场合的那几天」
  // 本来就是那个场合的名字能不能说（§5.8），关口①照样判
  const ent = safe(core, 'blankSetting', () => core.store.get('SELECT entity_id AS e FROM settings WHERE key = ?', g.settingKey)?.e, null);
  if (Number.isInteger(ent) && !taken.has(`n${ent}`)) return linked(ac, `n${ent}`, { parts: { S: 0, C: 0 } });
  return null;
}

/**
 * 眼下这场对话是不是接着空白那段聊下来的：从空白结束到现在，这个场合里没有 ≥ recall.window.maxGapH 的沉默
 * （线索窗口在同样长的沉默处断开，D34、S20b 的同一个概念）。查不了当作不是。
 */
function continuesFrom(ac, g) {
  const maxGap = Math.max(0, Number(ac.p.x.windowMaxGapH) || 0) * 3_600_000;
  if (!(maxGap > 0)) return false;
  const r = safe(ac.core, 'blankContinuity', () => ac.core.store.get(
    `SELECT max(d) AS d, max(at) AS last FROM (
       SELECT at, at - lag(at, 1, ?) OVER (ORDER BY at, id) AS d FROM percepts WHERE setting_key = ? AND at > ? AND at <= ?)`,
    g.to, g.settingKey, g.to, ac.at), null);
  if (!r) return false;
  const last = Number.isFinite(r.last) ? r.last : g.to;
  return Math.max(Number(r.d) || 0, ac.at - last) < maxGap;
}

/**
 * 对前 topN 条重排，用重排分替换 C 里稠密和 BM25 的部分（§8.3 第 4 步），重算 A、P。
 * 换进去的量和被换掉的同一种口径：调参前（useRrfForC）C 里的稠密、BM25 都是名次分，重排也按重排名次给名次分——
 * 各家重排模型的原始分数不可比（有的给概率、有的给 logit，§6.5「调参前用名次分」的同一个理由），拿原始分硬换，
 * 分数整体偏低的模型会把问题本身的匹配抹平，剩下基础激活和噪声在排（S29）。调参后换成 β 加权的原始分数（不在 [0,1] 就先归一化）。
 * @returns {Promise<boolean>} 做成了没有
 */
async function rerank(core, p, ctx, sampled, mode) {
  const top = [...sampled].sort(byA).slice(0, p.recall.rerank.topN).filter((c) => c.meta?.text);
  if (top.length < 2) return false;
  const query = ctx.cues.queryTexts[0] ?? ctx.cues.directedText ?? '';
  if (!query) return false;
  const docs = top.map((c) => safe(core, 'sanitize', () => core.mods.intake.sanitizeForPrompt(core, c.meta.text), c.meta.text));
  const ms = Math.min(p.recall.rerank.budgetMs, remaining(ctx));
  const tr = wall();
  const r = await withDeadline((signal) => core.ports.rerank.rerank(query, docs, signal), ms, ctx.signal);
  ctx.routeMs.rerank = Math.round(wall() - tr);
  const scores = r.value;
  if (r.timedOut || r.error || !Array.isArray(scores) || scores.length !== top.length || !scores.every(Number.isFinite)) {
    metric(core, r.timedOut ? 'retrieve.rerank.timeout' : 'retrieve.rerank.error');
    return false;
  }
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const norm = lo >= 0 && hi <= 1 ? (x) => x : (x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5);
  const w = p.recall.weights;
  const tau = mode === 'deliberate' ? p.act.tauDeliberate : p.act.tauInvoluntary;
  // 重排名次：分数相同的并列（取最好的名次）
  const order = scores.map((x, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  const rankOf = new Array(scores.length);
  order.forEach((idx, pos) => { rankOf[idx] = pos > 0 && scores[order[pos - 1]] === scores[idx] ? rankOf[order[pos - 1]] : pos + 1; });
  const rrfMode = p.recall.useRrfForC !== false;
  top.forEach((c, i) => {
    const old = (c.cParts?.dense ?? 0) + (c.cParts?.lexical ?? 0);
    const neu = (w.dense + w.bm25) * (rrfMode ? rankScore(p, rankOf[i]) : norm(scores[i]));
    c.A = c.A - old + neu;
    c.P = safe(core, 'pRecall', () => core.mods.dynamics.pRecall(c.A, tau, p.act.s), sigmoid((c.A - tau) / p.act.s));
    if (c.parts) c.parts = { ...c.parts, C: (c.parts.C ?? 0) - old + neu };
    c.signals = { ...c.signals, rerank: norm(scores[i]), rerankRank: rankOf[i] };
  });
  return true;
}

/**
 * 在场者近况这一路找到的候选（有 present 名次）：在场的人最近在别处说的、做的，她自己在别处说的，她今天的小结。
 * 召回结果里它们有自己的名额（recall.present.maxItems），context 把它们放进「在场者近况」那一层（context/recall.js 的同名判断）。
 */
export const viaPresent = (c) => Number.isFinite(c?.ranks?.present);

/** 两组各自按 A 降序（MMR 的顺序）的候选合并成一组：每次取两组队首里 A 大的那条，各组内部的先后不变。 */
export function mergeByA(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && !(b[j].A > a[i].A))) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

/** MMR 的相关度：A 在这一批里线性归一化到 0–1（只有一条或全都一样时都给 1）。 */
export function relevanceScale(pool) {
  const As = pool.map((c) => c.A).filter(Number.isFinite);
  if (!As.length) return () => 1;
  const lo = Math.min(...As);
  const hi = Math.max(...As);
  return (c) => (Number.isFinite(c.A) ? (hi > lo ? (c.A - lo) / (hi - lo) : 1) : 0);
}

async function vectorsFor(core, ctx, refs) {
  const r = await withDeadline(() => core.mods.worker.storedVectors(core, refs), Math.max(1, Math.min(remaining(ctx) - 10, 80)), ctx.signal);
  return r.value instanceof Map ? r.value : new Map();
}
function tokenSets(core, lang, items) {
  const reg = safe(core, 'lang', () => core.mods.lang.registry(core), null);
  const m = new Map();
  for (const c of items) {
    const toks = reg && c.meta?.text ? safe(core, 'tokenize', () => reg.tokenize(c.meta.text, { lang, mode: 'index' }), []) ?? [] : [];
    m.set(c.ref, new Set(toks.map(normalizeToken).filter(Boolean)));
  }
  return m;
}

/**
 * 两条候选有多像（MMR 用）：包含关系（感知在原文窗口里、感知归进了情节、事实以这条感知为来源）优先；
 * 再看向量（两边都有存好的向量）或词元 Jaccard，取较大的。版本链和同类的几次不在这里算（另外成组）。
 */
export function similarity(a, b, vecs, tokens) {
  const ma = a.meta ?? {};
  const mb = b.meta ?? {};
  let s = structural(a, ma, b, mb);
  if (s >= 1) return 1;
  const va = vecs.get(a.ref);
  const vb = vecs.get(b.ref);
  if (va && vb) s = Math.max(s, clamp(cosine(va, vb), 0, 1));
  else {
    const ta = tokens.get(a.ref);
    const tb = tokens.get(b.ref);
    if (ta?.size && tb?.size) {
      let inter = 0;
      for (const t of ta) if (tb.has(t)) inter++;
      s = Math.max(s, inter / (ta.size + tb.size - inter));
    }
  }
  return s;
}
/**
 * 两条候选是不是几乎一样的文字（MMR 合并用）：同一种记忆、来自同一批场合（受众相同，关口①的结论多半也相同；
 * 不同场合的同一件事各留一条，各自过关口①），词元 Jaccard ≥ min。没有文字的不算。
 */
export function nearDuplicate(a, b, tokens, min) {
  const ma = a.meta ?? {};
  const mb = b.meta ?? {};
  if (!ma.kind || ma.kind !== mb.kind) return false;
  const sa = new Set(ma.settingKeys ?? []);
  const sb = new Set(mb.settingKeys ?? []);
  if (sa.size !== sb.size || [...sa].some((k) => !sb.has(k))) return false;
  const ta = tokens.get(a.ref);
  const tb = tokens.get(b.ref);
  if (!ta?.size || !tb?.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= min;
}

function structural(a, ma, b, mb) {
  const pa = mrefOf(a.ref);
  const pb = mrefOf(b.ref);
  if (!pa || !pb) return 0;
  const pair = (x, mx, y, my) => {
    if (x.kind === 'percept' && y.kind === 'window' && my.range) {
      if (mx.windowId === y.id) return 1;
      if (mx.row?.setting_key === my.range.settingKey && x.id >= my.range.first && x.id <= my.range.last) return 1;
    }
    if (x.kind === 'percept' && y.kind === 'episode' && mx.episodeId === y.id) return 0.8;
    if (x.kind === 'percept' && y.kind === 'assertion' && (my.sourcePercepts ?? []).includes(x.id)) return 0.6;
    return 0;
  };
  return Math.max(pair(pa, ma, pb, mb), pair(pb, mb, pa, ma));
}

// ── 版本、发生次 ─────────────────────────────────────────────────────────────

/** 顺着链接带出一条（锚点之外的）候选：照常算激活，S / C 只继承锚点的 linkDecay（§8.3 第 6 步）。 */
function linked(ac, ref, anchor) {
  const { core, p } = ac;
  if (ac.ctx.exclude.has(ref)) return null;
  const have = ac.scoredByRef.get(ref);
  if (have) return have;
  const blocked = suppressed(core, [ref]);
  if (!blocked || blocked.has(ref)) return null;
  const meta = hydrate(core, [ref]).get(ref);
  if (!meta) return null;
  const c = { ref, mref: mrefOf(ref), ranks: {}, rrf: 0, signals: {}, meta };
  const d = p.x.linkDecay;
  const input = {
    candidate: c, S: (anchor.parts?.S ?? 0) * d, C: (anchor.parts?.C ?? anchor.cParts?.total ?? 0) * d,
    superseded: meta.kind === 'assertion' && meta.row?.superseded_by != null,
    intention: meta.kind === 'intention' ? meta.row : null, cueHit: false,
  };
  const [scored] = activate(core, p, [input], { at: ac.at, mode: ac.mode, seed: ac.seed });
  if (scored) ac.scoredByRef.set(ref, scored);
  return scored ?? null;
}

/**
 * 版本：事实被新版本取代过的，新版本一定在、最近被取代的那一版跟在后面（渲染成「之前……，后来……」由 context 把两条都过了关口①
 * 再交给 render 的 opt.previous）；只想起旧版本时，把取代它的新版本放到前面（旧的错事实不能比纠正它的新事实活得久）。
 * deep：有意回想看起来在问过去、或要求带历史时，往回追到 deliberateMaxHops 版。
 */
function attachVersions(ac, list, deep) {
  const out = [];
  const inList = new Set(list.map((c) => c.ref));
  const placed = new Set();
  const hops = deep ? Math.max(1, ac.p.recall.deliberateMaxHops) : 1;
  const push = (c) => { if (c && !placed.has(c.ref)) { placed.add(c.ref); out.push(c); } };
  for (const c of list) {
    if (placed.has(c.ref)) continue;
    const row = c.meta?.kind === 'assertion' ? c.meta.row : null;
    if (!row) { push(c); continue; }
    // 只想起了旧版本：先把最新的版本找出来放前面
    let head = c;
    let guardN = 0;
    while (head.meta?.row?.superseded_by && guardN++ < 8) {
      const nref = `a${head.meta.row.superseded_by}`;
      const n = linked(ac, nref, c);
      if (!n) break;
      if (!inList.has(nref)) n.attachedTo = n.attachedTo ?? c.ref;
      head = n;
    }
    push(head);
    // 新版本后面跟着最近被取代的几版
    let cur = head;
    for (let h = 0; h < hops; h++) {
      const prev = cur.meta?.row?.supersedes;
      if (!prev) break;
      const pref = `a${prev}`;
      const o = linked(ac, pref, head);
      if (!o) break;
      cur.previousRef = pref;
      o.versionOf = cur.ref;
      if (!inList.has(pref)) o.attachedTo = head.ref;
      push(o);
      cur = o;
    }
    if (!placed.has(c.ref)) push(c);
  }
  return out;
}

/**
 * 计划的结果（§5.5、§6.6「沿链接多跳：完成」）：想起了一条有结果的计划（plan_outcome_ref 指向完成它的那条情节或事实），
 * 结果跟在计划后面（「拿了，那天晚上说拿到的」，S1）。结果本身照常过关口①。
 */
function attachOutcomes(ac, list) {
  const out = [];
  const placed = new Set(list.map((c) => c.ref));
  for (const c of list) {
    out.push(c);
    const ref = c.meta?.kind === 'assertion' ? c.meta.row?.plan_outcome_ref : null;
    if (typeof ref !== 'string' || !mrefOf(ref) || ref === c.ref) continue;
    if (placed.has(ref)) {
      const o = list.find((x) => x.ref === ref);
      if (o) o.outcomeOf = o.outcomeOf ?? c.ref;
      continue;
    }
    const o = linked(ac, ref, c);
    if (!o) continue;
    o.outcomeOf = c.ref;
    o.attachedTo = c.ref;
    placed.add(ref);
    out.push(o);
  }
  return out;
}

/**
 * 「可能是同一个人」的内容渲染成「好像」（§5.2 信念层）：一条记忆关于的人不是线索直接认出的那几个，
 * 而是和他们只有 maybe_same 链接的人（实体扩散路沿链接走过去的），标上 belief，render 据此带「好像」。
 */
function markBelief(core, list, direct) {
  if (!direct.size || !list.length) return;
  const ids = [...direct];
  const links = safe(core, 'belief', () => [
    ...rowsByIds(core.store, "SELECT a, b, confidence FROM entity_links WHERE rel = 'maybe_same' AND a IN (?*)", ids),
    ...rowsByIds(core.store, "SELECT a, b, confidence FROM entity_links WHERE rel = 'maybe_same' AND b IN (?*)", ids),
  ], []) ?? [];
  if (!links.length) return;
  const maybe = new Map();   // 实体 → 和线索里的人 maybe_same 的最高置信度
  for (const l of links) {
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) {
      if (direct.has(x) && !direct.has(y)) maybe.set(y, Math.max(maybe.get(y) ?? 0, Number(l.confidence) || 0));
    }
  }
  if (!maybe.size) return;
  for (const c of list) {
    const m = c.meta;
    if (!m) continue;
    const about = m.kind === 'entity' ? [mrefOf(c.ref)?.id] : m.kind === 'episode' ? [...m.about, ...m.participants] : m.about;
    if (about.some((e) => direct.has(e))) continue;
    const conf = Math.max(0, ...about.map((e) => maybe.get(e) ?? 0));
    if (about.some((e) => maybe.has(e))) c.belief = { rel: 'maybe_same', confidence: conf };
  }
}

/**
 * 发生次（评审:SC-01）：同一类事（same_type 连成的组）有多次时，按时间最近的那次排前，组内按时间倒序排在组里最靠前的成员的位置上；
 * 最近的一次即使没被想起也要带出来（不会凭上周的记录答「拿了」，S1b）。
 * 两次的间隔 < closeRatio × 最近那次距今 → 标「可能指多次」，让她反问（间隔是相对的：越久远的事越难分清是哪一次）。
 */
function orderOccurrences(ac, list) {
  const { core, p, at } = ac;
  const aIds = list.map((c) => mrefOf(c.ref)).filter((m) => m?.kind === 'assertion').map((m) => m.id);
  if (!aIds.length) return list;
  const edges = (ids) => [
    ...safe(core, 'sameTypeA', () => rowsByIds(core.store, 'SELECT a, b FROM same_type WHERE a IN (?*)', ids), []),
    ...safe(core, 'sameTypeB', () => rowsByIds(core.store, 'SELECT a, b FROM same_type WHERE b IN (?*)', ids), []),
  ];
  const adj = new Map();
  const link = (x, y) => { if (!adj.has(x)) adj.set(x, new Set()); adj.get(x).add(y); };
  let frontier = aIds;
  const visited = new Set(aIds);
  const maxNodes = Math.max(8, p.x.occurrence.maxSiblings * 4);
  for (let depth = 0; depth < 3 && frontier.length && visited.size < maxNodes; depth++) {
    const next = [];
    for (const e of edges(frontier)) {
      link(e.a, e.b); link(e.b, e.a);
      for (const v of [e.a, e.b]) if (!visited.has(v) && visited.size < maxNodes) { visited.add(v); next.push(v); }
    }
    frontier = next;
  }
  if (!adj.size) return list;
  // 连通分量
  const comp = new Map();
  for (const start of aIds) {
    if (comp.has(start) || !adj.has(start)) continue;
    const members = [];
    const stack = [start];
    comp.set(start, members);
    const seen = new Set([start]);
    while (stack.length) {
      const v = stack.pop();
      members.push(v);
      for (const u of adj.get(v) ?? []) if (!seen.has(u) && visited.has(u)) { seen.add(u); comp.set(u, members); stack.push(u); }
    }
  }
  const groups = [...new Set(comp.values())].filter((g) => g.length >= 2);
  if (!groups.length) return list;
  let out = [...list];
  for (const g of groups) {
    const metas = hydrate(core, g.map((id) => `a${id}`));
    const members = g.map((id) => ({ id, ref: `a${id}`, t: occTime(metas.get(`a${id}`)?.row ?? {}) ?? 0 }))
      .filter((m) => metas.has(m.ref)).sort((x, y) => y.t - x.t || y.id - x.id).slice(0, p.x.occurrence.maxSiblings);
    if (members.length < 2) continue;
    const pos = out.findIndex((c) => g.includes(mrefOf(c.ref)?.id ?? -1) && c.meta?.kind === 'assertion');
    if (pos < 0) continue;
    const anchor = out[pos];
    const inGroup = new Map(out.filter((c) => c.meta?.kind === 'assertion' && g.includes(mrefOf(c.ref).id)).map((c) => [c.ref, c]));
    // 最近的那次一定带出来；有意回想再带出同一类事的其他几次（§6.6 沿链接多跳），最多 deliberateSiblings 次
    const bring = ac.mode === 'deliberate' ? Math.max(1, p.x.occurrence.deliberateSiblings) : 1;
    const ordered = [];
    for (const [i, m] of members.entries()) {
      let c = inGroup.get(m.ref);
      if (!c && i < bring) { c = linked(ac, m.ref, anchor); if (c) c.attachedTo = anchor.ref; }
      if (c) ordered.push(c);
    }
    for (const c of inGroup.values()) if (!ordered.includes(c)) ordered.push(c);
    const tLatest = members[0].t;
    const gap = members[0].t - members[1].t;
    const ambiguous = gap < p.x.occurrence.closeRatio * Math.max(at - tLatest, 60_000);
    ordered.forEach((c, i) => {
      c.occurrence = { group: members[0].ref, index: i, count: g.length, latest: c.ref === members[0].ref, ambiguous };
    });
    out = out.filter((c) => !inGroup.has(c.ref));
    out.splice(Math.min(pos, out.length), 0, ...ordered);
  }
  return out;
}

/** 每个实体最多 n 条（v1:791）：按「关于谁」数（她自己、这次有意回想问的那个人不限）；顺着链接带出来的跟着锚点走。 */
function capPerEntity(list, n, exempt) {
  const count = new Map();
  const kept = new Set();
  for (const c of list) {
    if (c.attachedTo) continue;
    // 实体档案本身不算「关于他的一条」（人物卡另由 context 组）
    const about = c.meta?.kind === 'entity' ? [] : (c.meta?.about ?? []).filter((e) => !exempt.has(e));
    if (about.some((e) => (count.get(e) ?? 0) >= n)) continue;
    for (const e of about) count.set(e, (count.get(e) ?? 0) + 1);
    kept.add(c.ref);
  }
  const byRef = new Map(list.map((c) => [c.ref, c]));
  const root = (c) => {
    let cur = c;
    for (let i = 0; i < 8 && cur?.attachedTo; i++) cur = byRef.get(cur.attachedTo) ?? null;
    return cur?.attachedTo ? null : cur?.ref ?? c.attachedTo;
  };
  return list.filter((c) => kept.has(c.attachedTo ? root(c) : c.ref));
}
