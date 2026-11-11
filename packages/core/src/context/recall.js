// recall() / recallCached() 的实现（§3「读」、§10.4、§9.3.5、§6.6）：
//   retrieve.recall 取候选（未过关口①）→ discretion.targetFor + gate（本模块组的各层也一起判）→ 分层 → retrieve.render
//   → 去掉本周期已发过的 → 按预算打包。进入她上下文的每一条都对得上一次判定（appraisalRef，§9.3.6）。
// 本模块自己组的层：
//   - gap：这个场合（或这个人）距上次互动超过 context.layers.gapH 小时，第一条真实消息到来时提示一次（评审:SC-21）；
//   - warmStart：新会话、压缩结束后、时间间隔触发时：本场合的故事线、最近的情节、还没封口的原文窗口；
//   - people：本周期第一次出现的在场者的人物卡；
//   - todaySoFar：有意回想时，她今天在别的场合的小结（§5.7）；召回里出现的今天的小结也归这一层；
//   - intentions：encode.dueIntentions → 按激活排序 → 浮上来前 encode.recheckIntention（评审:SC-08）→ 意图和它指向的事实都过关口①；
//   - working（工作记忆，§8.10，D100）：第一步就同步算好（working.js），眼前这个人刚在别处跟她说过、她回过他的话确定地在她心里，
//     写进 recallCached 的缓存（整个回想超时了也拿得到）；放进来的从普通回想的候选里去掉。
//     她自己开口的一轮（空闲唤醒，D132；定时提醒到点，D144）没有「眼前这个人」，按「她要对谁说」取（addresseesFor：一对一就是对方，
//     群里是她最近在别处来往过、又在这里的人；提醒对得上对象、他又在这里时他在最前）；这些人也算在场（人物卡、在场者近况、
//     对着他的意图），「今天到目前为止」也给。
// 「看起来在问过去」（§6.6、§8.5）：对她说的话看起来在问过去，就把这一轮切到有意回想（τ_del、可以等到 3 秒）。
// 重新开始（§10.5、§17 Q6）：只给常驻区和长期记忆，不给「这里最近在聊什么」（暖启动、时间间隔、重新开始前不久的原文），
// 等下一次压缩结束再恢复。
// 渲染（retrieve.render）时带上目标场合（来源在这里说「在这里」）；新版本和最近被取代的那一版都能说时合成「之前……，后来……」
// 一条；对这里的人讲过的带一句「讲过了」（S14）；暗示在可以具体一点时（hintSpecific）点出关于谁（§9.3.4）。
// 整体恢复期间（§12.4.5 第 2 步）不给新回想。
// 指回去（D146）：别人直接对她说的话开启的一轮，回想排在最前面的条目这个周期已经给过时，给一行「指回去」（pack.pointBackOf）。
import { refOf, parseRef, bumpMetric } from '../store/index.js';
import { sameId } from '../contract/index.js';
import { pack, countSent, pointBackOf } from './pack.js';
import { loadSession, sentTags, budgetState, noteInteraction, clearWarm, pendingLayers, pointBackCounts } from './ledger.js';
import { needsRefresh, refreshResident, swapStaged, isRestoring, noteSettingId } from './resident.js';
import { activateExtras, cardFor, bestImpression, burstGap, bestName } from './people.js';
import { buildWorking } from './working.js';
import { recallDiag } from './diag.js';
import { sanitize, clip, charLen, whenText, nowText, spanText, dayStart, newTraceId, HOUR_MS, MINUTE_MS } from './text.js';

const CONTENT = new Set(['share', 'share_vague']);
// 「心里有数」「还在想」的提示只跟着话题线索走；暖启动、人物卡这些背景层不给暗示
const HINT_LAYERS = new Set(['recalled', 'recentFromPresent', 'todaySoFar']);
// retrieve 召回的候选落在这几层（routeRecalled）：版本合并、计划和结果成组只在这几层里做
const RECALL_LAYERS = new Set(['recalled', 'recentFromPresent', 'todaySoFar']);
const PENDING_TEXT = '你隐约记得和这个问题有关的事，还在想这里能不能说';
const AWARE_TEXT = '你记得一件和这个话题有关的事，这里不适合提';
// 「讲过了」附注要占的字数放不下时，正文至少还要留这么多字，否则不带附注（附注只是提醒，正文才是内容）
const TOLD_MIN_BODY = 24;
// 来源原话被他后来的一句改掉了（D110 C7）：普通回想的条目带这一句，不说新的是什么
const SUPERSEDED_MARK = '（后来换了新的）';
// 恢复期间返回的空层（和 api 层的一致：degradeLevel 4）
const RESTORING_LEVEL = 4;

/** 预取缓存的键：同一个场合、同一个会话。 */
const cacheKeyOf = (key, sessionId) => JSON.stringify([key, sessionId ?? null]);

function emptyLayers(core, traceId, level) {
  return { items: [], degradeLevel: level ?? degrade(core), traceId };
}
function degrade(core) {
  try {
    const d = core.mods.retrieve.degradeLevel(core);
    return Number.isInteger(d) && d >= 0 && d <= 4 ? d : 4;
  } catch { return 4; }
}

export async function recall(core, s, opt) {
  const traceId = newTraceId();
  // 宿主取消了这一轮（signal）之后各步的出错不算出错（记 context.recall.aborted，不算回想次数，D117 评审）
  const diag = recallDiag(core, { trigger: s?.trigger, signal: opt?.signal ?? null });
  try {
    // 整体恢复期间：聊天照常，不注入新回想（§12.4.5 第 2 步；api 层也挡着，这里挡住已经在算的和别的调用方）
    if (isRestoring(core)) return emptyLayers(core, traceId, RESTORING_LEVEL);
    // 这一轮的触发消息往往刚经 observe 入队（intake 在 setImmediate 里才落库）：先把队列写进去，线索、「这一轮由哪条消息触发」
    // （focusObsId）才对得上，不然回想用的是上一条（D96）。drain 自己有时间上限（drainBudgetMs），落不了库就按库里现有的算
    try { core.mods.intake.drain(core); } catch (e) { diag.fault('drain', e); }
    const out = await compute(core, s, opt, { traceId, background: false, diag });
    // 这个场合不注入（档位 off）、找不到这个场合：不算一次回想（context.recall.skipped）
    if (!out) { diag.skip(); return emptyLayers(core, traceId, isRestoring(core) ? RESTORING_LEVEL : undefined); }
    // 目标拿不到：只认这一刻（之后没有新消息）已经判过的那一份，不用「工作记忆那一层还能用」的旧一份（判它时的目标更早）
    if (out.lost) return lostFallback(core, s, traceId, diag, { exactOnly: out.lost === 'target' });
    diag.done({ items: out.items.length });
    return { items: out.items, degradeLevel: out.degradeLevel, traceId, ...(out.alreadySent > 0 ? { alreadySent: out.alreadySent } : {}) };
  } catch (e) {
    // 各步都单独兜住了，到这里的是没想到的（D117）：记下来，已经算好、写进缓存的照给
    diag.fault('fatal', e);
    return lostFallback(core, s, traceId, diag);
  }
}

/**
 * 这一轮算到一半出错、给不出结果（D117）：已经算好写进缓存的（工作记忆第一步就写进去，过了关口①的）照给——走 recallCached 同一条路
 * （只认这个场合这个会话、之后没有新消息的那一份，或者工作记忆那一层还能用的；exactOnly：只认前一种）；什么都没有才是空的
 * （context.recall.lost）。只读缓存：不在后台再算一遍（再算一遍是同一条会出错的路，一次出错会记成两次，D117 评审）。
 */
function lostFallback(core, s, traceId, diag, { exactOnly = false } = {}) {
  let r = null;
  try { r = cachedFor(core, s, { exactOnly }); } catch { r = null; }
  const n = Array.isArray(r?.items) ? r.items.length : 0;
  diag.done({ items: n, lost: n === 0 });
  return n ? { items: r.items, degradeLevel: r.degradeLevel, traceId } : emptyLayers(core, traceId);
}

/**
 * 工作记忆的接续（§13.3）：按 A 排在前 maxLines、还没给过她的那几行（他亲口说的、她回他的），这一轮注入里没有的，按去向分开计数——
 *   - wm.continuity.miss（应该是 0）：装进来了却在打包时被挤掉（packed-out）、预算装不下（budget）；
 *   - wm.continuity.excluded.<rule>：第一段底线、点了别人的名、不在话题上、还没评估的私聊……挡在外面的（按设计如此，排查用）。
 */
function noteContinuity(core, top, items) {
  if (!top?.length) return;
  const got = new Set(items.map((i) => i.id));
  const causes = new Map();
  for (const t of top) {
    if (got.has(t.ref)) continue;
    // unit:<kind>（D110）：装进了某一段，和原来的 chosen 一样；elided：它那一段装进来了，它是省掉的中间行（按设计，不算漏）
    const c = t.cause === 'chosen' || String(t.cause).startsWith('unit:') ? 'packed-out' : t.cause;
    causes.set(c, (causes.get(c) ?? 0) + 1);
  }
  if (!causes.size) return;
  const elided = causes.get('elided') ?? 0;
  if (elided) { try { bumpMetric(core.store, 'wm.continuity.elided', elided); } catch { /* 只是计数 */ } causes.delete('elided'); }
  if (!causes.size) return;
  for (const [c, n] of causes) {
    const name = c.startsWith('excluded:') ? `wm.continuity.excluded.${c.slice(9)}` : 'wm.continuity.miss';
    try { bumpMetric(core.store, name, n); } catch { /* 只是计数 */ }
    if (!c.startsWith('excluded:')) { try { bumpMetric(core.store, `wm.continuity.miss.${c}`, n); } catch { /* 只是计数 */ } }
  }
  core.log.info('context.working.miss', { causes: Object.fromEntries(causes) });
}

/**
 * 整个回想超时、宿主走 recallCached 时，缓存算好以后这里又来了新消息：一般的缓存作废（线索变了），工作记忆那一层照样能用——
 * 只要之后没有别人对她说话（新来的都是旁边的人随口说的、或者还是同一个人）。返回能用的那几条，没有返回 null。
 */
function workingStillValid(core, key, entry) {
  if (!Number.isSafeInteger(entry?.triggerEntityId)) return null;
  const wm = entry.entries.filter((e) => e.layer === 'working');
  if (!wm.length) return null;
  const other = core.store.get(`SELECT 1 AS x FROM percepts WHERE setting_key = ? AND id > ? AND actor_self = 0 AND addressed IN ('to-her','mentions-her')
                                  AND (actor_entity_id IS NULL OR actor_entity_id <> ?) LIMIT 1`, key, entry.latestId ?? 0, entry.triggerEntityId);
  return other ? null : wm;
}

export function recallCached(core, s) {
  const traceId = newTraceId();
  try {
    if (isRestoring(core)) return emptyLayers(core, traceId, RESTORING_LEVEL);
    const r = cachedFor(core, s);
    if (r?.hit) return { items: r.items, degradeLevel: r.degradeLevel, traceId };
    if (!r?.set) return emptyLayers(core, traceId);
    // 宿主等不到回想、缓存里也没有能用的：这一轮她心里连工作记忆都没有（实测排查：应该很少）
    if (r.latest && !r.latest.actor_self && isToHer(r.latest)) { try { bumpMetric(core.store, 'wm.continuity.fallbackEmpty'); } catch { /* 只是计数 */ } }
    maybePrepare(core, s, r.set.key, r.latest);
    return emptyLayers(core, traceId);
  } catch (e) {
    core.log.warn('context.recallCached.error', { error: e?.code ?? e?.name ?? 'Error' });
    return emptyLayers(core, traceId);
  }
}

/**
 * 只读缓存（recallCached 和 lostFallback 共用，D117）：这个场合这个会话之后没有新消息的那一份（exact），或者工作记忆那一层还能用的
 * （exactOnly 时不认这一种）。命中返回 {hit: true, items, degradeLevel}；没命中返回 {hit: false, set, latest}（set 为 null：场合找不到 / 不注入）。
 * 不在后台补算、不记 fallbackEmpty。
 */
function cachedFor(core, s, { exactOnly = false } = {}) {
  const set = core.mods.intake.resolveSetting(core, s.settingId);
  if (!set) return { hit: false, set: null, latest: null };
  if (modeOf(core, set.key) === 'off') return { hit: false, set: null, latest: null };
  const cfg = core.config.get();
  const st = core.state.context;
  const latest = latestPercept(core, set.key);
  const entry = st.cache.get(cacheKeyOf(set.key, s.sessionId));
  const ttl = cfg.context.cacheTtlMin * MINUTE_MS;
  const fresh = entry && core.now() - entry.at <= ttl;
  const exact = fresh && entry.latestId === (latest?.id ?? 0);
  const wmOnly = fresh && !exact && !exactOnly ? workingStillValid(core, set.key, entry) : null;
  if (!exact && !wmOnly) return { hit: false, set, latest };
  const base = exact ? entry.entries : wmOnly;
  const hidden = suppressed(core, base.map((e) => e.ref));
  const session = s.sessionId ? loadSession(core, s.sessionId) : null;
  let list = base.filter((e) => !hidden.has(e.ref));
  // 时间间隔「只提示一次」：缓存算好以后这一行已经发出去（或正等确认）了，就不再给
  if (session && ((session.gap_ack_at != null && session.gap_ack_at >= entry.at) || pendingLayers(core, session).has('gap'))) {
    list = list.filter((e) => e.layer !== 'gap');
  }
  const items = pack(list, {
    cfg, mode: entry.mode, sent: session ? sentTags(core, session) : new Set(), budgetChars: cfg.context.blockMaxChars,
    budget: budgetState(core, session, core.now()),
  });
  return { hit: true, items, degradeLevel: entry.degradeLevel };
}

/**
 * 预取缓存里有了新的候选、而且最新一条是对她说的：在后台过一遍关口①（第二段只在对她说的消息到达时跑，§9.3.3），
 * 下一次 recallCached 就有已经判过的结果。不改会话状态。
 */
function maybePrepare(core, s, key, latest) {
  const st = core.state.context;
  const ck = cacheKeyOf(key, s.sessionId);
  if (st.inflight.has(ck) || !latest || !isToHer(latest) || isRestoring(core)) return;
  let cached = null;
  try { cached = core.mods.retrieve.cached(core, key); } catch { cached = null; }
  if (!cached) return;
  const cfg = core.config.get();
  const p = compute(core, s, { mode: 'involuntary', deadlineMs: cfg.recall.involuntary.deadlineMs, budgetChars: cfg.context.blockMaxChars },
    { traceId: newTraceId(), background: true })
    .catch((e) => { core.log.warn('context.prepare.error', { error: e?.code ?? e?.name ?? 'Error' }); })
    .finally(() => st.inflight.delete(ck));
  st.inflight.set(ck, p);
}

/**
 * 预取做完了（retrieve 的完整预取：对她说的、@ 她的消息到达后）：在后台把这一轮会交给关口①的条目先判一遍（D99，§9.3.5
 * 「不自主回想：第二段在预取时做」）。宿主真正开始这一轮（pre-step）往往比感知晚好几秒（QQ 实测 7–12 秒），这时第二段的结论
 * 多半已经在判定缓存里；还在判的，注入时等同一次调用（runStage2 按缓存键合并），不重复花钱。
 * 只在最新一条是别人对她说的、这个场合的 SettingId 这次运行里见过（常驻区、回想时记下的）时做；同一条消息只做一次。
 * 不改会话状态、不写 recallCached 的缓存。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} key
 */
export function prepareAfterPrefetch(core, key) {
  try {
    const st = core.state.context;
    if (!st || isRestoring(core) || !key) return;
    // 这次运行里还没见过这个场合的 SettingId（插件刚重启、这个群还没人认领会话）：只带场合键也照样先判（D102）。
    // 只是这时不刷新成员名单（members() 要 SettingId）
    const ids = st.settingIds.get(key) ?? null;
    const latest = latestPercept(core, key);
    if (!latest || latest.actor_self || !isToHer(latest)) return;
    const ck = `prefetch:${key}:${latest.id}`;
    if (st.inflight.has(ck)) return;
    const sessionId = core.store.get("SELECT session_id FROM sessions WHERE setting_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1", key)?.session_id ?? null;
    const cfg = core.config.get();
    const p = compute(core, ids ? { settingId: ids.settingId, homeSettingId: ids.settingId, sessionId, trigger: 'prefetch' } : { settingKey: key, sessionId, trigger: 'prefetch' },
      { mode: 'involuntary', deadlineMs: cfg.recall.involuntary.deadlineMs, budgetChars: cfg.context.blockMaxChars },
      { traceId: newTraceId(), background: true, prefetch: true })
      .catch((e) => { core.log.warn('context.prefetchGate.error', { error: e?.code ?? e?.name ?? 'Error' }); })
      .finally(() => st.inflight.delete(ck));
    st.inflight.set(ck, p);
    try { bumpMetric(core.store, 'context.prefetchGate'); } catch { /* 只是计数 */ }
  } catch (e) {
    core.log.warn('context.prefetchGate.error', { error: e?.code ?? e?.name ?? 'Error' });
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function compute(core, s, opt, { traceId, background, prefetch = false, diag = recallDiag(core, { trigger: s?.trigger, background: true }) }) {
  const t0 = performance.now();
  const cfg = core.config.get();
  const at = core.now();
  const tz = cfg.time.tzOffsetMin;
  // 每一步单独兜住（D117，实测问题 #28）：出错的那一步按它的退路（多半是「这一层没有」）接着算，记 context.recall.fault.<步骤>；
  // 只有目标（判断不了能不能说，fail closed：只给这一刻已经判过、缓存着的那一份）和场合本身找不到时整轮不重新算
  const guard = (stage, fn, fallback) => {
    try { return fn(); } catch (e) { diag.fault(stage, e); return typeof fallback === 'function' ? fallback() : fallback; }
  };
  const guardAsync = async (stage, fn, fallback) => {
    try { return await fn(); } catch (e) { diag.fault(stage, e); return fallback; }
  };
  // 只带场合键（预取时替这一轮先判、这次运行里还没见过 SettingId，D102）：按场合键找；平常按 SettingId
  const set = s.settingId ? core.mods.intake.resolveSetting(core, s.settingId)
    : (prefetch && typeof s.settingKey === 'string' ? core.mods.intake.settingByKey(core, s.settingKey) : null);
  if (!set) return null;
  const key = set.key;
  if (modeOf(core, key, diag) === 'off') return null;
  if (s.settingId) guard('setting-id', () => noteSettingId(core, key, s.settingId, set.adapter));
  const homeKey = s.settingId && s.homeSettingId && !sameId(s.homeSettingId, s.settingId)
    ? guard('home', () => core.mods.intake.resolveSetting(core, s.homeSettingId)?.key ?? key, key) : key;
  const session = s.sessionId ? guard('session', () => loadSession(core, s.sessionId), null) : null;
  const latest = guard('focus', () => latestPercept(core, key), null);
  const selfId = guard('focus', () => core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null, null);
  // 焦点（D108）：交进来的那条还在队列里就先把它落库（drainFor）；还是找不到，退回这里最后一条别人对她说的话——
  // 不退回「最后一条」：那常常是她自己刚说的，触发者就成了 null，整批工作记忆因为 no-trigger 进不来
  const findObs = (obs) => {
    if (!obs) return null;
    let r = perceptByObs(core, set.adapter, obs);
    if (!r && !prefetch) {
      try { if (core.mods.intake.drainFor(core, set.adapter, obs)) r = perceptByObs(core, set.adapter, obs); } catch { /* 按库里现有的算 */ }
    }
    return r;
  };
  // 空闲唤醒（idle，D115）：这一轮没有人在对她说话（主动冒泡、回复检查、潜水到点……），焦点就是这里最近的对话（最后一条），
  // 不退回这里最后一个对她说话的人——那常常是几个小时前的一句，拿它当「眼前这个人」，工作记忆、外发守护的「被回答的人」就都错了。
  // 定时提醒到点（reminder，D144）是同一类：也没有人在问她，是她自己要开口。一批里只要有一条真实的新消息，宿主就按 message 开启这一轮
  const selfTurn = s.trigger === 'idle' || s.trigger === 'reminder';
  let focus = s.focusObsId ? guard('focus', () => findObs(s.focusObsId), null) : null;
  if (!focus) {
    if (s.focusObsId) { try { bumpMetric(core.store, 'context.focus.fallback'); } catch { /* 只是计数 */ } }
    focus = selfTurn ? (latest ?? null)
      : s.focusObsId || latest?.actor_self ? (guard('focus', () => lastToHer(core, key), null) ?? (latest?.actor_self ? null : latest)) : latest;
  }
  const triggerEntityId = !selfTurn && focus && !focus.actor_self ? (focus.actor_entity_id ?? null) : null;
  // 一批里有几个人都在对她说话（D108）：主触发者在前，其余按交进来的顺序，各算一份工作记忆
  const triggers = [];
  if (triggerEntityId != null) triggers.push({ entityId: triggerEntityId, focus });
  for (const obs of !selfTurn && Array.isArray(s.focusObsIds) ? s.focusObsIds : []) {
    if (obs === s.focusObsId) continue;
    const f = guard('focus', () => findObs(obs), null);
    if (!f || f.actor_self || f.setting_key !== key || !Number.isSafeInteger(f.actor_entity_id) || triggers.some((t) => t.entityId === f.actor_entity_id)) continue;
    triggers.push({ entityId: f.actor_entity_id, focus: f });
  }
  // 只有前台的这一轮记（后台的 maybePrepare、预取不写：评审，原来后台的一次回想会把「问的是谁」换掉）
  if (s.sessionId && !prefetch && !background) guard('turn', () => noteTurn(core, s.sessionId, key, triggers, focus, at, { self: selfTurn }));

  // 「看起来在问过去」→ 有意回想（§6.6 (b)）；拿不准也切（评审:SC-22）
  let mode = opt.mode;
  if (mode === 'involuntary' && !selfTurn && focus && isToHer(focus) && focus.text && focus.kind === 'utterance') {
    if (await looksPast(core, focus, cfg, opt.signal)) mode = 'deliberate';
  }
  // 查询模型正在冷加载（闲了很久以后的第一句话，要两三秒）：这一轮多等一会儿，等到有意回想的截止时间，
  // 不然这一轮必然没有查询向量，只能按字面想（实测问题 #1）。模式不变，只是截止时间放宽；集成层本来就按这个时间等
  const cold = mode === 'involuntary' && !background && s.trigger === 'message' && queryWarming(core);
  const deadlineMs = mode !== opt.mode || cold ? Math.max(opt.deadlineMs, cfg.recall.deliberate.deadlineMs) : opt.deadlineMs;
  if (cold) core.log.info('context.recall.coldWait', { deadlineMs });
  const left = () => Math.max(0, deadlineMs - (performance.now() - t0));
  // 直接对她说的消息触发的这一轮（D99，实测问题 #5）：关口①第二段没判过的条目，这一轮可以等它到有意回想的截止时间
  //（集成层本来就按这个时间等，见 dsh/src/host/context.js 的 recallWaitMs），不留到下一轮——人被直接叫到时也会停一下想一想（§9.3.5）。
  // 只延长等第二段的那一段，召回、渲染照不自主回想的时间算；第二段的条数、每小时次数、预算照旧
  // 她自己开口的一轮也等（D132）：没有人对她说话，这个场合就没有预取替它先判过第二段；不等的话，别处刚发生、还没评估过的事
  // 这一轮判不完，要到下一轮才给——她自己开口的下一轮可能是几个小时以后。定时提醒到点的一轮也一样（D144：提醒那一条挂在她名下，不预取）
  const directTurn = mode === 'involuntary' && !background && ((s.trigger === 'message' && !!focus && isToHer(focus)) || selfTurn);
  // 预取时替这一轮先判的在后台：等第二段自己的超时（不到点就记「判不完、待定」，那是这一轮的事，不该算到预取头上）
  const gateWait = directTurn ? () => Math.max(left(), cfg.recall.deliberate.deadlineMs - (performance.now() - t0))
    : prefetch ? () => (cfg.discretion?.stage2?.timeoutMs ?? 8000) + 500 : null;
  // 有意回想：留一部分时间给关口①的第二段（注入前可以等它判完，§9.3.5）；不自主回想的第二段在预取时就做了
  const retrieveBudget = () => (mode === 'deliberate' ? left() * cfg.context.deliberateRetrieveShare : left());

  // 常驻区：真实新消息到来时才换文本（和回想并行，回合开始前做完就换上，否则留到下一次）
  let residentP = null;
  if (!background && s.trigger === 'message') {
    guard('resident', () => {
      swapStaged(core, key);
      if (needsRefresh(core, key)) residentP = refreshResident(core, key, { stageAfter: t0 + deadlineMs, deadlineMs }).catch(() => {});
    });
  }

  // 0. 目标（拿不到就不重新算：判断不了能不能说，fail closed——只给这一刻（之后没有新消息）已经判过、缓存着的那一份，D117）。settingId / adapterId 是可选字段：能列成员的平台据此刷新名单。
  //    工作记忆要先有目标，所以放在召回之前
  let target = null;
  try {
    target = core.mods.discretion.targetFor(core, /** @type {any} */ ({
      settingKey: key, homeSettingKey: homeKey, sessionId: s.sessionId ?? null, triggerEntityId, mode, egress: s.egress, at,
      ...(s.settingId ? { settingId: s.settingId } : {}), adapterId: set.adapter, direct: mode === 'deliberate' || (!selfTurn && !!focus && isToHer(focus)),
      ...(Number.isSafeInteger(focus?.id) ? { focusPerceptId: focus.id } : {}),
      // 预取时替这一轮先判：主人对她说的话开启的轮，宿主会在开始时清掉上一轮的污点（§9.6；集成层只认主人的声明，
      // 受托的管理者不清），按清掉之后的样子判（D99）。别人开启的轮照会话现在的污点判
      ...(prefetch && triggerEntityId != null && isPrincipal(core, triggerEntityId) ? { expectCleanTurn: true } : {}),
    }));
  } catch (e) {
    diag.fault('target', e);
    return { items: [], degradeLevel: degrade(core), alreadySent: 0, lost: 'target' };
  }
  const sent = session ? guard('sent', () => sentTags(core, session), () => new Set()) : new Set();
  const placeOk = placeGate(core, target, key);
  const latestId = latest?.id ?? 0;
  const cacheKey = cacheKeyOf(key, s.sessionId);

  // 0a. 她自己开口的一轮（D132）：没有人在问她，但她要对这里的人说话——工作记忆按「她要对谁说」取，每个人各算一份。
  //     不记成触发者（noteTurn 记的是 triggers）：外发守护的「被回答的人」照旧是空的。
  //     定时提醒到点的一轮（D144）：提醒对得上对象、他又在这里，排在最前
  const addressees = selfTurn && !prefetch
    ? guard('addressees', () => addresseesFor(core, target, { key, selfId, cfg, at, reminder: s.trigger === 'reminder' }), []) : [];
  if (addressees.length) { try { bumpMetric(core.store, 'wm.selfTurn'); } catch { /* 只是计数 */ } }
  const wmTriggers = selfTurn ? addressees.map((id) => ({ entityId: id, focus: null })) : triggers;

  // 0b. 工作记忆（§8.10，D100）：同步、零 LLM、不抽样，第一段判完就写进 recallCached 的缓存。预取时替这一轮先判的不做（它只预热第二段）
  const noWm = { entries: [], admitted: new Set(), top: [] };
  let wm = prefetch ? noWm
    : guard('working', () => buildWorking(core, { key, focus, triggerEntityId, at, target, cfg, sent, placeOk, selfId, triggers: wmTriggers, fault: diag.fault }) ?? noWm, noWm);
  if (!prefetch && wm.entries.length) {
    guard('cache', () => core.state.context.cache.set(cacheKey, { latestId, entries: wm.entries, degradeLevel: degrade(core), mode, at, partial: true, triggerEntityId }));
  }

  // 1. 候选（未过关口①）。抛错（不是到点：到点 retrieve 自己返回已有的）且剩下的时间还够，就再试一次（D117）。
  //    每一步最多等它自己的截止时间 + context.stageGraceMs：超过了（不该有：retrieve、关口①都自己守截止时间）算这一步超时，按没有接着算
  const graceMs = Math.max(0, cfg.context.stageGraceMs ?? 250);
  let cset = null;
  const retryMinLeft = Math.max(0, cfg.context.retrieveRetryMinLeftMs ?? 400);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const budgetMs = retrieveBudget();
      cset = await bounded(core.mods.retrieve.recall(core,
        { settingKey: key, focusPerceptId: focus?.id ?? null, sessionId: s.sessionId ?? null, trigger: s.trigger },
        { mode, query: opt.query, about: opt.about, time: opt.time, includeHistory: opt.includeHistory, deadlineMs: budgetMs, signal: opt.signal }), budgetMs + graceMs, opt.signal);
      if (attempt) { try { bumpMetric(core.store, 'context.retrieve.retryOk'); } catch { /* 只是计数 */ } }
      break;
    } catch (e) {
      diag.fault('retrieve', e);
      // 只有真的抛错才再试：卡住到点的（bounded 的 Timeout）那一次没有取消，再发一次只会两个一起卡、把关口①的时间也吃掉（D117 评审）
      if (attempt || e?.code === 'Timeout' || opt.signal?.aborted || left() < retryMinLeft) break;
      try { bumpMetric(core.store, 'context.retrieve.retry'); } catch { /* 只是计数 */ }
    }
  }
  const degradeLevel = Number.isInteger(cset?.degradeLevel) ? cset.degradeLevel : degrade(core);
  diag.setLevel(degradeLevel);
  // 她自己调记忆工具认真想一件事（D148，实测问题 #51）：查到的排最前；工作记忆、在场者近况只留和要想的这件事有关的
  const toolRecall = opt.mode === 'deliberate' && typeof opt.query === 'string' && !!opt.query.trim();
  const asked = toolRecall ? guard('tool-focus', () => askedRelevance(core, opt.query, cset, cfg), null) : null;
  if (asked && wm.entries.length) {
    wm = { ...wm, entries: guard('tool-focus', () => relevantWorking(wm.entries, asked), wm.entries) };
  }
  // 已经放进工作记忆的不再走普通回想（同一条不判两遍、不占两份名额）；预取缓存里的候选集是共用的，不改它，另拿一份。
  // 有意回想只去掉这一轮工作记忆里真的给了的：本周期已经给过她的那几条照常经回想、按「已发过」去重，
  // 什么都没给出来时集成层据此说「前面已经有了」，不说成想不起来（D95）
  const wmGiven = new Set(wm.entries.map((e) => e.ref));
  const recalledItems = (Array.isArray(cset?.items) ? cset.items : []).filter((c) => !(mode === 'deliberate' ? wmGiven : wm.admitted).has(c?.ref))
    // 有意回想的工具：只靠「在场」那一路来的近况（他刚才在别处说的、和要想的事不相干的）不放
    .filter((c) => !asked || !isPresentRoute(c) || asked.byRoute(c) || asked.byText(textOfRef(core, c?.ref)));

  // 3. 各层的候选（每一层单独兜住：一层出错只少这一层）
  const restart = session?.restart_marker != null;
  const pendingL = session ? guard('ledger', () => pendingLayers(core, session), () => new Set()) : new Set();
  // 她要对着说的人也算在场（D132）：人物卡、对着他的意图跟着来
  const lead = [triggerEntityId, ...addressees].filter(Number.isInteger);
  const present = guard('present', () => presentOf(core, cset, key, at, selfId, lead, cfg), () => lead);
  const cueIds = guard('cues', () => [...new Set([...(cset?.cues?.names ?? []).map((n) => n.entityId), ...(cset?.cues?.mentioned ?? [])])].filter(Number.isInteger), []);
  const seed = [s.sessionId ?? key, String(latest?.id ?? 0)];
  /** @type {{ref: string, layer: string, role: string, group: string, order: number, cand?: object, extra?: object}[]} */
  const slots = [];
  let order = 0;

  const routed = guard('route', () => routeRecalled(core, recalledItems, { key, at, tz, restart, restartAt: session?.restart_marker, cfg }),
    // 分层出错：重新开始时不给（「这里最近在聊什么」要等压缩结束，判断不了就不给）；平常都当「想起来的」
    () => (restart ? [] : recalledItems.filter((c) => { const m = parseRef(c?.ref); return m && m.kind !== 'intention' && m.kind !== 'link'; })
      .map((c) => ({ ref: c.ref, layer: isPresentRoute(c) ? 'recentFromPresent' : 'recalled', role: 'recalled' }))));
  routed.forEach((x) => { slots.push({ ...x, group: `r:${x.ref}`, order: order++ * 10 }); });

  const extras = [];
  const addExtra = (x) => { extras.push(x); slots.push({ ...x, order: order++ * 10 }); };

  // 时间间隔和暖启动只在真实的新消息到来时给（§10.4「第一条真实消息到来时」、§10.5）；提醒、空闲唤醒不算
  const realMsg = s.trigger === 'message';
  let gapFired = false;
  if (realMsg && !restart && !pendingL.has('gap')) {
    for (const g of guard('gap', () => gapsFor(core, { key, focus, session, triggerEntityId, selfId, cfg }), [])) {
      gapFired = true;
      addExtra({ ref: g.ref, layer: 'gap', role: g.kind, group: `g:${g.kind}`, extra: g });
      // 上一段经历不能说时，退一步用上次那条原话（同一个场合、同一批人）作这一行的依据：至少知道「隔了多久」
      if (g.alt && g.alt !== g.ref) addExtra({ ref: g.alt, layer: 'gap', role: 'alt', group: `g:${g.kind}`, extra: g });
    }
  }
  const sessionNew = !!session && guard('warm', () => !core.store.get('SELECT 1 AS x FROM injections WHERE session_id = ? LIMIT 1', session.session_id), false);
  const warmDue = realMsg && !restart && !!session && !pendingL.has('warmStart') && (session.warm_pending === 1 || sessionNew || gapFired);
  if (warmDue) for (const w of guard('warm', () => warmFor(core, key, focus, cfg), [])) addExtra({ ...w, layer: 'warmStart', group: `w:${w.ref}` });

  guard('people', () => {
    const persons = personsFor(present, triggerEntityId, selfId, sent, cfg);
    for (const id of persons) {
      const imps = core.store.all('SELECT id, layer FROM entity_impressions WHERE entity_id = ? AND is_current = 1', id);
      addExtra({ ref: refOf('entity', id), layer: 'people', role: 'card', group: `p:${id}`, person: id });
      for (const imp of imps) addExtra({ ref: refOf('impression', imp.id), layer: 'people', role: 'impression', group: `p:${id}`, person: id, impLayer: imp.layer });
    }
  });

  // 她自己开口的一轮也给「今天到目前为止」（D132）：开口之前先知道今天在别处过得怎么样（提醒到点的一轮也是她自己开口，D144）
  if (mode === 'deliberate' || selfTurn) {
    for (const e of guard('today', () => todayFor(core, key, at, tz, cset?.cues?.timeWindows ?? [], cfg), [])) addExtra({ ref: e, layer: 'todaySoFar', role: 'today', group: `d:${e}` });
  }

  // 她的经验（D124）：按范围对上的（她正在用 / 这个会话刚用过的工具、在场的人、这个场合；新会话的第一轮里她有经验的工具）进「你的经验」
  // 那一层；只靠话题对上的（lessonsFor 的 scoped=false、五路回想碰到的）和别的想起来的排在同一档（评审 M4），照样渲染成经验的样子
  const lessonRows = await guardAsync('lessons', () => core.mods.encode.lessonsFor(core, {
    settingKey: key, people: [...new Set([...present, ...triggers.map((t) => t.entityId)])].filter(Number.isInteger), tools: s.tools ?? [],
    text: [focus?.text, opt.query].filter((x) => typeof x === 'string' && x).join(' ') || null, sessionId: s.sessionId ?? null, at,
    max: (cfg.lessons?.recallMax ?? 2) + 1, startOfCycle: warmDue, focusPerceptId: focus?.id ?? null,
  }), []);
  guard('lessons', () => {
    // 五路回想碰到、lessonsFor 却没认（范围、话题都对不上）的经验不给：经验只在对得上的时候想起（评审 M4；不然库里的经验会当成普通的事实到处冒出来）
    const keepIds = new Set((Array.isArray(lessonRows) ? lessonRows : []).map((l) => refOf('assertion', l.id)));
    for (let i = slots.length - 1; i >= 0; i--) if (slots[i].role === 'lesson' && !keepIds.has(slots[i].ref)) slots.splice(i, 1);
    for (const l of Array.isArray(lessonRows) ? lessonRows : []) {
      const ref = refOf('assertion', l.id);
      const slot = slots.find((x) => x.ref === ref);
      if (slot) { if (l.scoped) { slot.layer = 'lessons'; slot.role = 'lesson'; slot.group = `l:${ref}`; } continue; }
      addExtra({ ref, layer: l.scoped ? 'lessons' : 'recalled', role: 'lesson', group: `l:${ref}` });
    }
  });

  const intent = await guardAsync('intentions', () => intentionFor(core, { key, at, present, cueIds, sent, left, signal: opt.signal, seed, mode, cfg }), null);
  if (intent) {
    addExtra({ ref: intent.ref, layer: 'intentions', role: 'intention', group: `t:${intent.ref}`, intention: intent.row, cueHit: intent.cueHit });
    if (intent.aboutRef) addExtra({ ref: intent.aboutRef, layer: 'intentions', role: 'about', group: `t:${intent.ref}` });
  }

  // 4. 关口①：召回的和本模块组的一起判（第二段一次调用 ≤ 8 条，§9.3.3）
  const scored = new Map();
  for (const c of recalledItems) if (c?.ref && !scored.has(c.ref)) scored.set(c.ref, c);
  for (const c of guard('activate', () => activateExtras(core, extras.filter((x) => !scored.has(x.ref)), { at, mode, seed }) ?? [], [])) if (c?.ref) scored.set(c.ref, c);
  const pool = slots.filter((x) => scored.has(x.ref));
  const toGate = gateOrder(pool).map((r) => scored.get(r));
  let gated = [];
  if (toGate.length) {
    try {
      const gl = left();
      const gw = gateWait ? gateWait() : 0;
      gated = await bounded(core.mods.discretion.gate(core, toGate, target, { mode, deadlineMs: gl, ...(gateWait ? { waitMs: gw } : {}), signal: opt.signal }), Math.max(gl, gw) + graceMs, opt.signal);
    } catch (e) {
      diag.fault('gate', e);
      gated = [];   // 判不了：一条都不给（工作记忆另有它自己的准入，照给）
    }
  }
  const gmap = new Map();
  for (const g of Array.isArray(gated) ? gated : []) if (g?.ref && typeof g.appraisalRef === 'string' && g.appraisalRef) gmap.set(g.ref, g);
  const hidden = suppressed(core, [...gmap.keys()], diag);
  for (const r of hidden) gmap.delete(r);

  // 5. 渲染（一条出错只丢那一条，见 renderSlots）
  // 这一轮在场 / 在受众里的人（暗示具体到谁时，只点在场的人，§9.3.4）
  const aud = target?.audience ?? {};
  const here = guard('present', () => new Set([...present, ...(aud.members ?? []), ...(aud.recentSpeakers ?? [])].filter(Number.isInteger)), () => new Set(present));
  const entries0 = guard('render', () => renderSlots(core, pool, { gmap, scored, at, tz, key, mode, cfg, focus, selfId, intent, here, placeOk, diag }), []);
  const entries = [...wm.entries, ...entries0];
  if (intent && !entries.some((e) => e.layer === 'intentions')) {
    try { core.mods.discretion.logDecision(core, { kind: 'omit', settingKey: key, ref: intent.ref, reason: 'intention-not-cleared', at }); } catch { /* 记不了就算了 */ }
  }
  // 算的这段时间里开始了整体恢复：这一轮不给（库马上要被换掉，结果也不进缓存）
  if (isRestoring(core)) return null;

  // 6. 缓存（给 recallCached），然后按这个会话去重、打包。预取时替这一轮先判的不进这份缓存：它按预计的污点判，
  // 只用来让第二段的结论提前进判定缓存（按污点分开），不直接交给宿主
  if (!prefetch) guard('cache', () => core.state.context.cache.set(cacheKey, { latestId, entries, degradeLevel, mode, at, triggerEntityId }));
  // 算不出预算（D133）：这一轮不限（和原来「今天还没用」一样），记忆效果优先
  const budget = guard('budget', () => budgetState(core, session, at), () => ({ dayUsed: 0, dayLimit: Infinity, rollingLeft: Infinity }));
  // 打包出错：退回只打包工作记忆（她眼前这个人的那几句最要紧）
  let packed = {};
  let items = guard('pack', () => pack(entries, { cfg, mode, sent, budgetChars: opt.budgetChars, budget, report: packed, recallFirst: toolRecall }),
    () => guard('pack-working', () => pack(wm.entries, { cfg, mode, sent, budgetChars: opt.budgetChars, budget, report: packed, recallFirst: toolRecall }), []));
  // 6a. 指回去（D146）：这一轮是别人直接对她说的话开启的（她自己开启的轮、旁听的轮、记忆工具那条路都不算——工具那条路有 D95 的提示），
  //     回想排在这一轮新给的「想起来的 / 在场者近况」前面的条目这个周期已经给过、被去重掉了：给一行指回去，和别的条目一起再打包一次
  //     （它排在想起来的那一档前面，块满了时挤掉的是排得比它靠后的新条目）。算不出来就照第一次打包的结果给
  const askedTurn = !background && !prefetch && opt.mode === 'involuntary' && s.trigger === 'message' && !selfTurn
    && !!focus && !focus.actor_self && isToHer(focus);
  const pbCfg = cfg.context.pointBack ?? {};
  if (askedTurn && session && sent.size && (pbCfg.max ?? 0) > 0) {
    const pb = guard('point-back', () => pointBackOf(entries, items, sent, {
      max: pbCfg.max, chars: pbCfg.chars, perCycle: pbCfg.perCycle, counts: pointBackCounts(core, session),
    }), null);
    if (pb?.entries.length) {
      const again = {};
      const repacked = guard('pack', () => pack([...entries, ...pb.entries], { cfg, mode, sent, budgetChars: opt.budgetChars, budget, report: again }), null);
      if (repacked) { items = repacked; packed = again; }
    }
    if (!core.readOnly) {
      try {
        const n = items.filter((i) => i.layer === 'pointBack').length;
        if (n) bumpMetric(core.store, 'context.pointBack', n);
        if (pb?.capped) bumpMetric(core.store, 'context.pointBack.capped', pb.capped);
      } catch { /* 只是计数 */ }
    }
  }
  // 注入预算的计数（D133，管理页的诊断）：前台这一轮超了没有、有多少条因为预算没放进去
  if (!background && !core.readOnly) {
    try {
      if (packed.over) bumpMetric(core.store, `context.pack.over.${packed.over}`);
      if (packed.budgetDropped > 0) bumpMetric(core.store, 'context.pack.budgetDropped', packed.budgetDropped);
    } catch { /* 只是计数 */ }
  }
  if (!background) guard('continuity', () => noteContinuity(core, wm.top, items));

  if (!background && session) {
    guard('ledger-write', () => {
      if (s.trigger === 'message') noteInteraction(core, session.session_id, at);
      // 该补暖启动但没什么可补的（没有，或者本周期都发过了）：清掉标记，免得每一轮都再找一遍、再判一遍
      const warm = entries.filter((e) => e.layer === 'warmStart');
      if (warmDue && !items.some((i) => i.layer === 'warmStart') && warm.every((e) => sent.has(e.ref))) clearWarm(core, session.session_id);
    });
  }
  if (residentP) await Promise.race([residentP, new Promise((r) => { setTimeout(r, left()); })]);
  // 有意回想：有关、过了关口①、但本周期已经给过她的（D95）。这一次什么都没给出来时，集成层据此说「前面已经有了」
  const alreadySent = mode === 'deliberate' ? guard('pack', () => countSent(entries, sent), 0) : 0;
  return { items, degradeLevel, alreadySent };
}

// ── 召回的候选分到哪一层 ──────────────────────────────────────────────────

function routeRecalled(core, items, { key, at, tz, restart, restartAt, cfg }) {
  const eps = items.map((c) => parseRef(c?.ref)).filter((m) => m?.kind === 'episode').map((m) => m.id);
  const epRows = new Map(rowsIn(core, 'SELECT id, ep_kind, setting_key, t_end FROM episodes WHERE id IN', eps).map((r) => [r.id, r]));
  // 她的经验（D124）：五路回想碰到的经验和别的想起来的在同一档（只靠话题对上，评审 M4），照经验的样子渲染（验证过没有、要避开的坑）
  const as = items.map((c) => parseRef(c?.ref)).filter((m) => m?.kind === 'assertion').map((m) => m.id);
  const lessonIds = new Set(rowsIn(core, "SELECT id FROM assertions WHERE kind_hint = 'lesson' AND id IN", as).map((r) => r.id));
  let raw = new Map();
  if (restart) {
    const ps = items.map((c) => parseRef(c?.ref)).filter((m) => m?.kind === 'percept').map((m) => m.id);
    const ws = items.map((c) => parseRef(c?.ref)).filter((m) => m?.kind === 'window').map((m) => m.id);
    raw = new Map([
      ...rowsIn(core, 'SELECT id, setting_key, at AS t FROM percepts WHERE id IN', ps).map((r) => [refOf('percept', r.id), r]),
      ...rowsIn(core, 'SELECT id, setting_key, t_end AS t FROM raw_windows WHERE id IN', ws).map((r) => [refOf('window', r.id), r]),
    ]);
  }
  const today = dayStart(at, tz);
  const horizon = cfg.context.layers.gapH * HOUR_MS;
  const out = [];
  for (const c of items) {
    const m = parseRef(c?.ref);
    if (!m || m.kind === 'intention' || m.kind === 'link') continue;   // 意图只经「你想着的」那条路浮上来（要先复核）
    if (restart) {
      const r = raw.get(c.ref);
      // 重新开始前不久这里的原话：属于「这里最近在聊什么」，等下一次压缩结束再给
      if (r && r.setting_key === key && r.t <= restartAt && r.t >= restartAt - horizon) continue;
    }
    let layer = 'recalled';
    const ep = m.kind === 'episode' ? epRows.get(m.id) : null;
    let role = 'recalled';
    if (m.kind === 'assertion' && lessonIds.has(m.id)) role = 'lesson';
    else if (ep?.ep_kind === 'summary' && ep.t_end >= today && ep.setting_key !== key) layer = 'todaySoFar';
    else if (isPresentRoute(c)) layer = 'recentFromPresent';
    out.push({ ref: c.ref, layer, role });
  }
  return out;
}

/**
 * 交给关口①的顺序（第二段一次只判前 maxItemsPerCall 条，后面的这一轮不给、留到下一轮，§9.3.3）：在场者近况和别的
 * 交替排，各自内部保持原来的先后（回想的 A、然后是本模块组的人物卡、意图……）。近况那一路有自己的名额，刚说的话又大多
 * 还没评估过：按 A 一起排的话，几条新鲜的近况就能占满第二段的位置，别的想起来的、人物卡一直轮不到；反过来也一样。
 * 只影响谁先轮到第二段，判断本身不看顺序。
 * @param {{ref: string, layer: string}[]} pool
 * @returns {string[]}
 */
function gateOrder(pool) {
  const near = [];
  const rest = [];
  const seen = new Set();
  for (const x of pool) {
    if (seen.has(x.ref)) continue;
    seen.add(x.ref);
    (x.layer === 'recentFromPresent' ? near : rest).push(x.ref);
  }
  const out = [];
  for (let i = 0; i < Math.max(near.length, rest.length); i++) {
    if (i < rest.length) out.push(rest[i]);
    if (i < near.length) out.push(near[i]);
  }
  return out;
}

/**
 * 「在场者近况」那一路找到的（§8.2 第五路；和 retrieve/pipeline.js 的 viaPresent 同一个判断）：在场的人刚才在别处说的、做的。
 * 别的几路也找到了也算这一层：它是什么（这里的人的近况）不看哪一路排得更前；retrieve 给这一路的名额就是这一层的名额，
 * 按「哪一路名次最好」分层的话，词法路也碰到的那几条会落进「想起来的」，被那一层的 5 条上限挤掉（实测问题 #5）。
 */
function isPresentRoute(c) {
  return Number.isFinite(c?.ranks?.present);
}

// ── 有意回想的工具：和要想的事有关的（D148） ───────────────────────────────

/**
 * 她调记忆工具要想的这件事（query）：哪些条目和它有关。
 *   - 按字面和问题比（lang.queryTerms 的词，重合的占较短一边的比例，短的一边词很少时打折；≥ context.toolRecall.minSim 才算）；
 *   - 或者 retrieve 稠密那一路把它排在前 context.toolRecall.denseTop 名以内（稠密路对每一条都有个名次，只有最前的几名才说明是在问它）。
 *   别的几路不算：词法那一路的词里有实体词元（问题里提到主人，主人说过的每一句都对得上），实体、时间、在场那几路也一样不看问题的内容。
 * @returns {{hits: Set<string>, byRoute: (c: object) => boolean, byText: (text: string) => boolean}}
 */
function askedRelevance(core, query, cset, cfg) {
  const denseTop = Number.isFinite(cfg.context.toolRecall?.denseTop) ? cfg.context.toolRecall.denseTop : 5;
  const byRoute = (c) => Number.isFinite(c?.ranks?.dense) && c.ranks.dense <= denseTop;
  const hits = new Set((Array.isArray(cset?.items) ? cset.items : []).filter(byRoute).map((c) => c.ref));
  const terms = (t) => new Set((core.mods.lang.queryTerms(core, String(t ?? '')) ?? []).map((w) => String(w).normalize('NFKC').toLowerCase()).filter(Boolean));
  const q = terms(query);
  const min = Number.isFinite(cfg.context.toolRecall?.minSim) ? cfg.context.toolRecall.minSim : 0.3;
  const byText = (text) => {
    if (!q.size || !text) return false;
    let t;
    try { t = terms(text); } catch { return false; }
    if (!t.size) return false;
    let n = 0;
    for (const w of t) if (q.has(w)) n += 1;
    const m = Math.min(q.size, t.size);
    return n / m * Math.min(1, Math.sqrt(m / 2)) >= min;
  };
  return { hits, byRoute, byText };
}

/**
 * 工作记忆里和要想的事有关的那几段（D148）：一段里有一行是 retrieve 按问题找到的、或者字面对得上问题，整段留下（段头带着在哪儿、什么时候）；
 * 别的段这一次不放。比的是那一行的话本身，不比段头（段头里的场合名不算话题）。
 */
function relevantWorking(entries, asked) {
  const bare = (s) => String(s ?? '').replace(/^〔[^〕]*〕/u, '').replace(/^（中间又来回了 \d+ 句）/u, '').replace(/^[^：]{0,24}：/u, '');
  const keep = new Set();
  for (const e of entries) if (asked.hits.has(e.ref) || asked.byText(bare(e.rendered))) keep.add(e.group);
  return entries.filter((e) => keep.has(e.group));
}

/** 一条感知的原话（在场者近况那一路的条目和问题比字面用）；别的种类给空字符串。 */
function textOfRef(core, ref) {
  const m = parseRef(ref);
  if (m?.kind !== 'percept') return '';
  try { return String(core.store.get('SELECT text FROM percepts WHERE id = ?', m.id)?.text ?? ''); } catch { return ''; }
}

// ── 时间间隔（§10.4，评审:SC-21） ─────────────────────────────────────────

function gapsFor(core, { key, focus, session, triggerEntityId, selfId, cfg }) {
  if (!focus) return [];
  const gapMs = cfg.context.layers.gapH * HOUR_MS;
  const ack = session?.gap_ack_at ?? null;
  const fresh = (burstStart) => (session ? (ack == null || burstStart.at > ack) : burstStart.id === focus.id);
  const out = [];
  // 这个场合
  const rows = core.store.all('SELECT id, at FROM percepts WHERE setting_key = ? AND id <= ? ORDER BY id DESC LIMIT 200', key, focus.id);
  const sg = burstGap(rows, gapMs);
  if (sg && fresh(sg.burstStart)) {
    // 这里隔了很久，可眼前这个人之后在别处一直和她有来往（D148，实测问题 #47）：间隔那一句要把这件事也说清楚
    let elsewhere = null;
    try {
      if (triggerEntityId && triggerEntityId !== selfId) elsewhere = elsewhereSince(core, { key, entityId: triggerEntityId, since: sg.prev, before: focus });
    } catch { elsewhere = null; }   // 查不出来：照旧只说这里隔了多久
    out.push({ kind: 'setting', ref: unitBefore(core, key, sg.prev), alt: refOf('percept', sg.prev.id), prevAt: sg.prev.at, burstStartAt: sg.burstStart.at,
      ...(elsewhere ? { elsewhere } : {}) });
  }
  // 这个人（不在场合间隔里时）：她和他距上次说话很久了
  if (!out.length && triggerEntityId && triggerEntityId !== selfId) {
    const mine = core.store.all('SELECT id, at FROM percepts WHERE actor_entity_id = ? AND id <= ? ORDER BY id DESC LIMIT 50', triggerEntityId, focus.id);
    const pg = burstGap(mine, gapMs);
    if (pg && fresh(pg.burstStart)) {
      out.push({ kind: 'person', ref: refOf('percept', pg.prev.id), prevAt: pg.prev.at, burstStartAt: pg.burstStart.at });
    }
  }
  return out;
}

/**
 * 这里上次聊过之后，眼前这个人在别处和她的来往（D148）：他在别的场合亲口说的话（不是转来的材料、不是只有她看得到的），
 * 和她在别处接着回他的话（她那一句前面最近一条别人亲口说的是他，同一场合；和 retrieve.recentPartners 同一个口径）。
 * 只看这里上一条消息之后、这一句之前的。返回最近一次的时间、场合，和他在别处说了几句；没有返回 null。
 * @returns {{at: number, settingKey: string, count: number}|null}
 */
function elsewhereSince(core, { key, entityId, since, before }) {
  const lo = Number.isFinite(since?.id) ? since.id : 0;
  const t0 = Number.isFinite(since?.at) ? since.at : 0;
  const hi = Number.isSafeInteger(before?.id) ? before.id : Number.MAX_SAFE_INTEGER;
  const his = core.store.get(`SELECT COUNT(*) AS n, MAX(id) AS id FROM percepts WHERE id > ? AND id < ? AND at > ? AND setting_key <> ? AND actor_entity_id = ?
      AND actor_self = 0 AND kind IN ('utterance','action') AND standing <> 'material' AND visible_to <> 'her-only'`, lo, hi, t0, key, entityId);
  const hisRow = Number.isSafeInteger(his?.id) ? core.store.get('SELECT id, at, setting_key FROM percepts WHERE id = ?', his.id) : null;
  const mine = core.store.get(`SELECT s.id, s.at, s.setting_key FROM percepts s WHERE s.id > ? AND s.id < ? AND s.at > ? AND s.setting_key <> ? AND s.actor_self = 1
      AND s.kind IN ('self-utterance','self-action')
      AND (SELECT o.actor_entity_id FROM percepts o WHERE o.setting_key = s.setting_key AND o.id < s.id AND o.actor_self = 0 AND o.kind IN ('utterance','action')
           ORDER BY o.id DESC LIMIT 1) = ?
      ORDER BY s.id DESC LIMIT 1`, lo, hi, t0, key, entityId);
  const last = [hisRow, mine].filter(Boolean).sort((a, b) => b.id - a.id)[0] ?? null;
  return last ? { at: last.at, settingKey: last.setting_key, count: Number(his?.n ?? 0) } : null;
}

/** 上次聊到的东西：上一段经历（情节）→ 含那条消息的原文窗口 → 那条消息本身。 */
function unitBefore(core, key, prev) {
  const ep = core.store.get(`SELECT id FROM episodes WHERE setting_key = ? AND ep_kind IN ('event','summary') AND t_end <= ?
                             ORDER BY t_end DESC LIMIT 1`, key, prev.at);
  if (ep) return refOf('episode', ep.id);
  const w = core.store.get('SELECT id FROM raw_windows WHERE setting_key = ? AND first_percept <= ? AND last_percept >= ? ORDER BY id DESC LIMIT 1',
    key, prev.id, prev.id);
  if (w) return refOf('window', w.id);
  return refOf('percept', prev.id);
}

// ── 暖启动、在场者、今天到目前为止 ─────────────────────────────────────────

function warmFor(core, key, focus, cfg) {
  const out = [];
  const sl = core.store.get('SELECT id FROM storylines WHERE setting_key = ? AND text <> \'\'', key);
  if (sl) out.push({ ref: refOf('storyline', sl.id), role: 'storyline' });
  const before = focus?.at ?? core.now();
  const eps = core.store.all(`SELECT id, t_end FROM episodes WHERE setting_key = ? AND ep_kind IN ('event','summary') AND t_end <= ?
                              ORDER BY t_end DESC LIMIT ?`, key, before, cfg.context.layers.warmEpisodes);
  eps.forEach((e) => out.push({ ref: refOf('episode', e.id), role: 'episode' }));
  // 还没封口的对话（原文窗口里的感知还没归进情节）
  const lastEp = eps[0]?.t_end ?? 0;
  const ws = core.store.all(`SELECT id FROM raw_windows WHERE setting_key = ? AND t_end > ? AND last_percept < ? ORDER BY last_percept DESC LIMIT ?`,
    key, lastEp, focus?.id ?? Number.MAX_SAFE_INTEGER, cfg.context.layers.warmWindows);
  ws.forEach((w) => out.push({ ref: refOf('window', w.id), role: 'window' }));
  return out;
}

function presentOf(core, cset, key, at, selfId, lead, cfg) {
  let ids = cset?.cues?.present;
  if (!Array.isArray(ids)) {
    // retrieve 没给线索：最近 recall.presentSpeakerWindowMin 分钟在这里亲自发过言的人（评审:PS-13）
    ids = core.store.all(`SELECT DISTINCT actor_entity_id AS id FROM percepts WHERE setting_key = ? AND actor_entity_id IS NOT NULL
        AND actor_self = 0 AND kind IN ('utterance','action') AND at >= ? AND at <= ?`, key, at - cfg.recall.presentSpeakerWindowMin * MINUTE_MS, at)
      .map((r) => r.id);
  }
  const out = [];
  for (const id of [...lead, ...ids]) if (Number.isInteger(id) && id !== selfId && !out.includes(id)) out.push(id);
  return out;
}

/**
 * 她自己开口的一轮要对谁说（D132）：一对一就是对方；别的场合是她最近在别处来往过、又在这里的人（retrieve.recentPartners：
 * 在这里 = 听众名单里的、最近在这里说过话的，或者以前在这里说过话的；按最近一次来往从新到旧，没有时间窗，最多 recall.working.maxTriggers 个）。
 * 公开的、不认识的场合没有（工作记忆本来就不进这些场合）。只决定工作记忆替谁算、谁算在场；能不能进来照旧由 discretion.admitWorking 判。
 * 定时提醒到点的一轮（reminder，D144）：这次提醒对得上对象、他又在这里（remindedOf），他排在最前，其余照上面取，一共最多 maxTriggers 个。
 * @returns {number[]}
 */
function addresseesFor(core, target, { key, selfId, cfg, at, reminder = false }) {
  const a = target?.audience;
  if (!a?.known || a.publicLike) return [];
  const people = [...new Set([...(a.members ?? []), ...(a.recentSpeakers ?? [])])].filter((x) => Number.isSafeInteger(x) && x !== selfId);
  if (a.oneOnOne) return people.length === 1 ? people : [];
  const max = Math.max(1, Math.floor(cfg.recall.working?.maxTriggers ?? 3));
  // 对不上（或者找的时候出错）就只按她最近在别处来往过的人取
  let first = [];
  if (reminder) { try { first = remindedOf(core, { key, at, people, selfId }); } catch { first = []; } }
  const rest = core.mods.retrieve.recentPartners?.(core, { settingKey: key }, { among: people, max }) ?? [];
  return [...new Set([...first, ...rest])].filter((x) => Number.isSafeInteger(x) && x !== selfId).slice(0, max);
}

/**
 * 定时提醒到点的这一轮提醒的是谁（D144）：到点的意图（encode.dueIntentions）里带时间窗、现在正在窗里的那几条的对象，
 * 而且他在这里（听众名单里、最近在这里说过话的，或者以前亲自在这里说过话）。时间窗开始得晚的在前（最像刚到点的这一次）。
 * 只看意图的结构（对象、时间窗），不解析提醒的文字；dueIntentions 自己的规矩（场合属性线索、对同一个人的冷却）照旧。对不上返回空的。
 * @returns {number[]}
 */
function remindedOf(core, { key, at, people, selfId }) {
  const open = core.store.all(`SELECT DISTINCT target_entity_id AS e FROM intentions WHERE state IN ('armed','formed') AND target_entity_id IS NOT NULL
                               AND window_start IS NOT NULL AND window_start <= ? AND (window_end IS NULL OR window_end >= ?)`, at, at)
    .map((r) => r.e).filter((e) => Number.isSafeInteger(e) && e !== selfId);
  const here = open.filter((e) => people.includes(e)
    || !!core.store.get('SELECT 1 AS x FROM percepts WHERE setting_key = ? AND actor_entity_id = ? AND actor_self = 0 LIMIT 1', key, e));
  if (!here.length) return [];
  const due = (core.mods.encode.dueIntentions(core, { presentEntityIds: here, settingKey: key, at }) ?? [])
    .filter((r) => here.includes(r?.target_entity_id) && Number.isFinite(r.window_start) && r.window_start <= at && !(Number.isFinite(r.window_end) && r.window_end < at))
    .sort((x, y) => y.window_start - x.window_start);
  return [...new Set(due.map((r) => r.target_entity_id))];
}

function personsFor(present, triggerEntityId, selfId, sent, cfg) {
  const out = [];
  for (const id of present) {
    if (id === selfId || sent.has(refOf('entity', id))) continue;
    out.push(id);
    if (out.length >= cfg.context.layers.peopleCards) break;
  }
  return out;
}

function todayFor(core, key, at, tz, windows, cfg) {
  const start = dayStart(at, tz);
  if (windows.length && !windows.some((w) => w.end >= start && w.start <= at)) return [];
  return core.store.all(`SELECT id FROM episodes WHERE ep_kind = 'summary' AND setting_key <> ? AND t_end >= ? AND t_end <= ?
                         ORDER BY t_end DESC LIMIT ?`, key, start, at, cfg.context.layers.todayItems).map((r) => refOf('episode', r.id));
}

// ── 你想着的（§5.5） ──────────────────────────────────────────────────────

async function intentionFor(core, { key, at, present, cueIds, sent, left, signal, seed, mode, cfg }) {
  // 出错由调用方（compute 的 guardAsync('intentions')）记下来，这一层这一轮没有
  const due = core.mods.encode.dueIntentions(core, { presentEntityIds: present, settingKey: key, at, cueEntityIds: cueIds }) ?? [];
  const cand = due.filter((r) => Number.isInteger(r?.id) && !sent.has(refOf('intention', r.id)));
  if (!cand.length) return null;
  const cueSet = new Set(cueIds);
  // 线索命中（I 项再 +cueBoost）：dueIntentions 算过就用它的；没给就按触发条件里的实体线索自己对一遍
  const cueHit = (r) => {
    if (typeof r.cueHit === 'boolean') return r.cueHit;
    const trig = r.trigger && typeof r.trigger === 'object' ? r.trigger : safeParse(r.trigger_json);
    const cues = Array.isArray(trig?.cues) ? trig.cues : [];
    const cueEntity = (c) => (Number.isInteger(c?.entity) ? c.entity : Number.isInteger(c?.entityId) ? c.entityId : null);
    return cues.some((c) => cueEntity(c) != null && cueSet.has(cueEntity(c))) || (r.target_entity_id != null && cueSet.has(r.target_entity_id));
  };
  // 过了时间窗的不丢掉，按 dueIntentions 给的 overdue 平滑减分（D103：没有硬到期）
  const overdueOf = new Map(cand.map((r) => [refOf('intention', r.id), Number.isFinite(r.overdue) ? r.overdue : 0]));
  const scored = activateExtras(core, cand.map((r) => ({ ref: refOf('intention', r.id), intention: r, cueHit: cueHit(r) })), { at, mode, seed })
    .sort((a, b) => (b.A - (overdueOf.get(b.ref) ?? 0)) - (a.A - (overdueOf.get(a.ref) ?? 0)));
  const tries = cfg.context.intentionTries;
  for (const sc of scored.slice(0, tries)) {
    const row = cand.find((r) => refOf('intention', r.id) === sc.ref);
    if (cfg.intention.preTriggerRecheck) {
      // 触发前先复核：对象自意图形成以来的原始感知里有没有完成证据（S2b）；复核不了这一轮就不提
      let res = null;
      try { res = await withTimeout(core.mods.encode.recheckIntention(core, row.id, { signal }), left()); } catch { res = null; }
      if (!res || res.suppress) continue;
    }
    const aboutRef = row.about_kind && Number.isInteger(row.about_id) && row.about_id > 0 && OWNER_KIND_OK.has(row.about_kind)
      ? refOf(row.about_kind, row.about_id) : null;
    return { ref: sc.ref, row, aboutRef, cueHit: cueHit(row) };
  }
  return null;
}
const OWNER_KIND_OK = new Set(['percept', 'window', 'episode', 'assertion', 'entity', 'impression', 'storyline', 'community']);

// ── 渲染 ──────────────────────────────────────────────────────────────────

function renderSlots(core, pool, { gmap, scored, at, tz, key, mode, cfg, selfId, intent, here = new Set(), placeOk = () => false, diag = null }) {
  const fault = (stage, e, extra) => { if (diag) diag.fault(stage, e, extra); else core.log.warn('context.render.error', { error: e?.code ?? e?.name ?? 'Error' }); };
  const entries = [];
  const itemChars = (mode === 'deliberate' ? cfg.recall.deliberate : cfg.recall.involuntary).itemChars;
  let pendingDone = 0;
  let awareDone = 0;
  const L = cfg.context.layers;
  const push = (slot, g, rendered, extra = {}) => {
    if (!rendered) return null;
    // MMR 合并进这一条的几乎一样的文字：去重（本周期发过没有）时一起看（pack）
    const dups = (scored.get(slot.ref)?.duplicates ?? []).filter((r) => typeof r === 'string');
    const e = {
      ref: slot.ref, layer: slot.layer, verdict: extra.verdict ?? g.verdict, rendered, appraisalRef: g.appraisalRef,
      provenance: extra.provenance ?? '', confidence: extra.confidence ?? scored.get(slot.ref)?.P ?? 0,
      group: slot.group, order: slot.order, ...(extra.bound ? { bound: true } : {}), ...(dups.length ? { duplicates: dups } : {}),
    };
    entries.push(e);
    return e;
  };
  const rargs = { at, tz, key, placeOk, fault };
  // 来源原话被他后来的一句改掉了的（感知、断言、情节；第一眼的 replaces，只读反查）：带「（后来换了新的）」，不说新的是什么
  let later = new Map();
  try {
    const refs = pool.filter((x) => RECALL_LAYERS.has(x.layer) && CONTENT.has(gmap.get(x.ref)?.verdict)).map((x) => x.ref);
    if (refs.length) later = core.mods.discretion.supersededBy?.(core, refs) ?? new Map();
  } catch { later = new Map(); }
  const content = (slot, g, chars, more = {}) => renderContent(core, scored.get(slot.ref), g,
    { ...rargs, chars, ...(later.has(slot.ref) && RECALL_LAYERS.has(slot.layer) ? { mark: SUPERSEDED_MARK } : {}), ...more });

  // 人物卡要整组看：卡头不能说，印象也不单独出现
  const cards = new Map();
  for (const slot of pool.filter((x) => x.layer === 'people')) {
    if (!cards.has(slot.person)) cards.set(slot.person, []);
    cards.get(slot.person).push(slot);
  }
  // 版本：新版本和它最近被取代的那一版都过了关口①（新版本能说、旧版本能说或说个大概）→ 合成一条「之前……，后来……」
  let pairs = new Map();
  try { pairs = versionPairs(pool, { gmap, scored }); } catch (e) { fault('render-pairs', e); pairs = new Map(); }
  const absorbed = new Set([...pairs.values()].map((p) => p.slot.ref));

  // 一条出错只丢这一条（D117）：记 context.recall.fault.render（带它所在的层），别的照常渲染
  for (const slot of pool) {
    try { renderOne(slot); } catch (e) { fault('render', e, { layer: slot.layer }); }
  }
  try { groupOutcomes(entries, scored); } catch (e) { fault('render-group', e); }
  return entries;

  function renderOne(slot) {
    if (slot.layer === 'gap') {
      if (slot.role === 'alt') return;   // 跟着主条目一起处理
      const alt = pool.find((x) => x.layer === 'gap' && x.role === 'alt' && x.group === slot.group);
      const gm = gmap.get(slot.ref);
      const ga = alt ? gmap.get(alt.ref) : null;
      // 依据：上一段经历能说就用它（带上「上次聊到」）；不能说就用上次那条原话；都只给了暗示 / 还在想的，这一行只有时间
      const pickG = (gm && CONTENT.has(gm.verdict) && { s: slot, g: gm }) || (ga && CONTENT.has(ga.verdict) && { s: alt, g: ga })
        || (gm && { s: slot, g: gm }) || (ga && { s: alt, g: ga }) || null;
      if (!pickG) return;
      const text = gapText(core, slot.extra, pickG.g, scored.get(pickG.s.ref), { at, tz, cfg, key, placeOk });
      // 结论照实记：上次的内容不能说时这一行只有时间，不进污点账本
      push({ ...pickG.s, order: slot.order, group: slot.group }, pickG.g, text, { confidence: 1, provenance: '' });
      return;
    }
    const g = gmap.get(slot.ref);
    if (!g) return;
    if (slot.layer === 'people') {
      if (slot.role !== 'card') return;
      const card = cardFor(core, { entityId: slot.person, gate: g, settingKey: key, at, burstStartAt: at, selfId });
      if (!card) return;
      push(slot, g, card.text, { confidence: 1, provenance: '' });
      const imps = cards.get(slot.person).filter((x) => x.role === 'impression').map((x) => ({ ref: x.ref, layer: x.impLayer }));
      const best = bestImpression(imps, gmap);
      if (best) {
        const room = L.peopleCardChars - card.text.length;
        const islot = cards.get(slot.person).find((x) => x.ref === best.ref);
        const r = room >= 8 ? content(islot, best.gate, room, { told: false }) : null;
        if (r) push({ ...islot, order: slot.order + 1 }, best.gate, `印象：${clip(r.rendered, Math.max(1, room - 3))}`, r);
      }
      return;
    }
    if (slot.layer === 'lessons' || slot.role === 'lesson') {
      // 她的经验（D124）：「（验证过）用 X 时：……（要避开：……）〔谁、在哪儿说的〕」；关口①只让说个大概时用它给的含糊说法。
      // 听来的、主人教的带一句来源（照普通记忆的来源说法，评审 M7）；她自己琢磨的、试出来的不带
      if (!CONTENT.has(g.verdict)) return;
      const m = parseRef(slot.ref);
      const row = m ? core.store.get('SELECT * FROM assertions WHERE id = ?', m.id) : null;
      if (!row) return;
      const info = core.mods.encode.lessonInfo(row);
      // 只属于别的场合的（听来的默认只在听到的地方用，评审 M1）：五路回想碰到了也不给
      if (info.setting && info.setting !== key) return;
      let provenance = '';
      if (['told', 'owner', 'correction'].includes(info.origin)) {
        const r = content(slot, g, itemChars, { told: false });
        provenance = String(r?.provenance ?? '').trim();
      }
      const text = core.mods.encode.lessonLine(core, row, { chars: cfg.lessons?.itemChars ?? 110, provenance: provenance || null,
        vague: g.verdict === 'share_vague' ? (g.vagueText ?? null) : null });
      if (!text || (g.verdict === 'share_vague' && !g.vagueText)) return;
      push(slot, g, text, { confidence: scored.get(slot.ref)?.P ?? 1, provenance });
      return;
    }
    if (slot.layer === 'intentions') {
      if (!CONTENT.has(g.verdict)) return;
      if (slot.role === 'about') return;   // 跟着意图一起处理
      const r0 = content(slot, g, itemChars);
      if (!r0) return;
      // 过了时间窗的：照样想着，只是知道已经过了点（D103）
      const r = intent?.row?.overdue > 0 ? { ...r0, rendered: sanitize(core, `本来打算${String(r0.rendered).replace(/[。.！!]+$/u, '')}，已经过了时间`) } : r0;
      // 意图指向的事实也必须过了关口①才一起出现；它不能说，意图本身也先不提（比如私聊里说的考驾照，群里不问）
      const aboutSlot = intent?.aboutRef ? pool.find((x) => x.ref === intent.aboutRef && x.layer === 'intentions') : null;
      if (intent?.aboutRef) {
        const ag = aboutSlot ? gmap.get(aboutSlot.ref) : null;
        if (!ag || !CONTENT.has(ag.verdict)) return;
        push(slot, g, r.rendered, r);
        const ar = content(aboutSlot, ag, itemChars);
        if (ar) push({ ...aboutSlot, order: slot.order + 1 }, ag, ar.rendered, ar);
      } else {
        push(slot, g, r.rendered, r);
      }
      return;
    }
    // recalled / recentFromPresent / todaySoFar / warmStart
    if (absorbed.has(slot.ref)) return;   // 已经并进新版本那一条了
    if (CONTENT.has(g.verdict)) {
      const chars = slot.layer === 'warmStart' && slot.role === 'storyline' ? Math.min(L.warmStart, itemChars * 2) : itemChars;
      const pair = pairs.get(slot.ref);
      if (pair && renderPair(core, slot, g, pair, { push, content, chars, scored, rargs })) return;
      const r = content(slot, g, chars);
      if (r) push(slot, g, r.rendered, r);
      if (pair) {
        // 合不成一条：两版各自渲染（旧版本用它自己的那一组）
        const pr = content(pair.slot, pair.gate, chars);
        if (pr) push(pair.slot, pair.gate, pr.rendered, pr);
      }
    } else if (g.verdict === 'aware_private' && HINT_LAYERS.has(slot.layer)) {
      // 心里有数：一行暗示，不含内容（§9.3.4）；默认不点名，可以具体一点时（主体本人或当初告诉她的人在场）点出在场的那个人
      if (!g.hintOk || awareDone >= L.awareLines) return;
      awareDone += 1;
      push({ ...slot, layer: 'awarePrivate' }, g, awareText(core, slot.ref, g, { key, selfId, here }), { confidence: scored.get(slot.ref)?.P ?? 0 });
    } else if (g.verdict === 'pending' && HINT_LAYERS.has(slot.layer)) {
      // 有意回想时还没判完的：先给一行不含内容的暂定提示（§9.3.5），下一轮用缓存补上
      if (mode !== 'deliberate' || pendingDone >= L.pendingLines) return;
      pendingDone += 1;
      push({ ...slot, layer: 'recalled' }, g, sanitize(core, PENDING_TEXT), { confidence: scored.get(slot.ref)?.P ?? 0 });
    }
  }
}

/**
 * 哪些候选可以合成「之前……，后来……」（retrieve 的 previousRef：最近被取代的那一版跟着新版本带出，§8.3 第 6 步）：
 * 两条都在想起来的这几层、都过了关口①，新版本能说（说个大概只有第二段写的含糊版本，放不进旧版本的内容）、旧版本能说或说个大概。
 * @returns {Map<string, {slot: object, gate: object, cand: object}>} 新版本的引用 → 旧版本
 */
function versionPairs(pool, { gmap, scored }) {
  const out = new Map();
  const used = new Set();
  for (const slot of pool) {
    if (!RECALL_LAYERS.has(slot.layer) || used.has(slot.ref)) continue;
    const prev = scored.get(slot.ref)?.previousRef;
    if (!prev || used.has(prev) || out.has(prev)) continue;
    const g = gmap.get(slot.ref);
    const pg = gmap.get(prev);
    const pslot = pool.find((x) => x.ref === prev && RECALL_LAYERS.has(x.layer));
    if (!pslot || g?.verdict !== 'share' || !pg || !CONTENT.has(pg.verdict) || !scored.get(prev)) continue;
    out.set(slot.ref, { slot: pslot, gate: pg, cand: scored.get(prev) });
    used.add(slot.ref);
    used.add(prev);
  }
  return out;
}

/**
 * 新版本一条（retrieve.render 的 opt.previous 写成「之前……，后来……」），旧版本跟在后面、绑在它上面：只写一句旧版本是从哪儿知道的。
 * 旧版本的内容已经写进新版本那一条了，所以它照样作为一项交出去（注入日志、已发名单、污点账本都要有它，§9.3.6、§9.4.1）。
 * @returns {boolean} 合成了没有
 */
function renderPair(core, slot, g, pair, { push, content, chars, scored, rargs }) {
  const previous = { candidate: pair.cand, verdict: pair.gate.verdict, vagueText: pair.gate.vagueText ?? null };
  const r = content(slot, g, chars, { previous });
  if (!r) return false;
  const pr = renderContent(core, scored.get(pair.slot.ref), pair.gate, { ...rargs, chars, told: false });
  const lead = push(slot, g, r.rendered, r);
  if (!lead) return false;
  const src = String(pr?.provenance ?? '').trim();
  const stub = sanitize(core, src ? `（之前那一版是${src}）` : '（之前还有一个说法）');
  push({ ...pair.slot, layer: slot.layer, group: lead.group, order: lead.order + 1 }, pair.gate, stub,
    { provenance: src, confidence: pr?.confidence ?? scored.get(pair.slot.ref)?.P ?? 0, bound: true });
  return true;
}

/**
 * 计划和它的结果（retrieve 的 outcomeOf，「拿了，那天晚上说拿到的」，S1）放进同一组：一起分配名额、挨着出现。
 * 各自照样单独过了关口①；计划不能说时结果自成一组。
 */
function groupOutcomes(entries, scored) {
  const lead = new Map();
  for (const e of entries) if (RECALL_LAYERS.has(e.layer) && CONTENT.has(e.verdict) && !e.bound && !lead.has(e.ref)) lead.set(e.ref, e);
  for (const e of entries) {
    const plan = lead.get(scored.get(e.ref)?.outcomeOf);
    if (!plan || plan === e || e.bound || plan.layer !== e.layer || !CONTENT.has(e.verdict)) continue;
    e.group = plan.group;
    e.order = plan.order + 5;   // 排在计划（和它绑着的旧版本）后面、下一条想起来的前面（层内顺序以 10 为步长）
  }
}

/**
 * 渲染一条的内容（retrieve.render，按目标场合）。
 *   - previous：旧版本也过了关口①时一起交给 render（「之前……，后来……」）；
 *   - told：这件事对这里的人讲过（GatedItem.told，S14），后面带一句「讲过了」，不当新鲜事再讲（§5.6）；放不下就不带。
 */
function renderContent(core, cand, g, { at, tz, key, chars, previous = null, told = true, placeOk = () => false, mark = '', fault = null }) {
  if (!cand || !(chars > 0)) return null;
  // 「（后来换了新的）」（D110 C7）：它的来源原话被他后来的一句改掉了（第一眼的 replaces）；放得下才带，先于「讲过了」
  const note = `${mark && chars - charLen(mark) >= TOLD_MIN_BODY ? mark : ''}${told && !cand.fok ? toldNote(core, g, at) : ''}`;
  const room = note && chars - charLen(note) >= TOLD_MIN_BODY ? chars - charLen(note) : chars;
  const tail = room < chars ? note : '';
  try {
    const opt = { verdict: g.verdict, vagueText: g.vagueText ?? null, at, itemChars: room, settingKey: key, placeAllowed: placeOk, ...(g.label ? { label: g.label } : {}) };
    if (previous) opt.previous = previous;
    const r = core.mods.retrieve.render(core, cand, opt);
    const body = clip(String(r?.rendered ?? '').trim(), room);
    if (!body) return null;
    return { rendered: `${body}${tail}`, provenance: String(r?.provenance ?? ''), confidence: Number.isFinite(r?.confidence) ? r.confidence : (cand.P ?? 0) };
  } catch (e) {
    if (fault) fault('render-item', e, { layer: cand?.mref?.kind ?? 'unknown' });
    else core.log.warn('context.render.error', { kind: cand?.mref?.kind ?? 'unknown', error: e?.code ?? e?.name ?? 'Error' });
    return null;
  }
}

/**
 * 来源说法里能不能写出别的场合的名字（discretion.placeAllowed：那个场合的档案卡在这一轮的目标上过了关口①第一段才写，
 * §5.8、§9.3.6）。判不了就不写（fail closed）。每轮每个场合判一次。
 * @returns {(settingKey: string) => boolean}
 */
function placeGate(core, target, key) {
  const memo = new Map();
  return (settingKey) => {
    if (!settingKey || settingKey === key) return true;
    if (memo.has(settingKey)) return memo.get(settingKey);
    let ok = false;
    try { ok = !!target && core.mods.discretion.placeAllowed(core, settingKey, target) === true; } catch { ok = false; }
    memo.set(settingKey, ok);
    return ok;
  };
}

/** 「讲过了」附注（S14）：讲全了的别当新鲜事再讲；只说过个大概的，别把那个大概当新鲜事。时间按人感觉的写，不带「多久以前」（D148：「你今晚 21:18 …」）。 */
function toldNote(core, g, at) {
  const t = g?.told;
  if (!t || !Number.isFinite(t.at)) return '';
  const w = whenText(core, t.at, at, 'day');
  const when = `${/^\d/u.test(w) ? ' ' : ''}${w}${/\d$/u.test(w) ? ' ' : ''}`;
  return t.level === 'vague' ? `（你${when}对这里的人提过个大概，别把那个大概当新鲜事再讲）` : `（你${when}已经对这里的人讲过，别当新鲜事再讲）`;
}

/**
 * 心里有数的那一行（§9.3.4「暗示本身也是信息」）：默认不写主体是谁、不写是谁说的。discretion 判定可以具体一点时（hintSpecific：
 * 主体本人或当初告诉她的那个人在场），只点在场的那一个：
 *   - 告诉她的人在场：「你记得 X 说过的一件……」（不点主体：主体可能不在，点了就是告诉在场的其他人「关于某某有件事」）；
 *   - 主体本人在场：「你记得 X 的一件……」。
 * 两个都对不上（在场名单和 discretion 看到的不一样、找不到人）就用不点名的说法。
 */
function awareText(core, ref, g, { key, selfId, here }) {
  if (g.hintSpecific) {
    const teller = tellersOf(core, ref, selfId).find((id) => here.has(id));
    const tname = teller != null ? bestName(core, teller, key) : null;
    if (tname) return sanitize(core, `你记得${tname}说过的一件和这个话题有关的事，这里不适合提`);
    const who = subjectOf(core, ref, selfId);
    const name = who != null && here.has(who) ? bestName(core, who, key) : null;
    if (name) return sanitize(core, `你记得${name}的一件和这个话题有关的事，这里不适合提`);
  }
  return sanitize(core, AWARE_TEXT);
}

/** 当初告诉她的人（不是她自己）：事实、情节的来源里的说话人和断言者；原话的说话人。别的（窗口、印象……）不认。 */
function tellersOf(core, ref, selfId) {
  const m = parseRef(ref);
  if (!m) return [];
  let ids = [];
  if (m.kind === 'assertion' || m.kind === 'episode') {
    ids = core.store.all('SELECT speaker, asserter FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY at, id', m.kind, m.id)
      .flatMap((r) => [r.speaker, r.asserter]);
  } else if (m.kind === 'percept') {
    const p = core.store.get('SELECT actor_entity_id AS e, actor_self AS s FROM percepts WHERE id = ?', m.id);
    ids = p && !p.s ? [p.e] : [];
  }
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id !== selfId))];
}

/** 一条记忆是关于谁的（不是她自己）：事实的主体、原话的说话人、印象和档案的那个人；别的（情节、窗口……）不点名。 */
function subjectOf(core, ref, selfId) {
  const m = parseRef(ref);
  if (!m) return null;
  let id = null;
  if (m.kind === 'assertion') {
    id = core.store.get("SELECT entity_id AS e FROM assertion_entities WHERE assertion_id = ? AND role = 'subject' AND entity_id <> ? ORDER BY entity_id LIMIT 1",
      m.id, selfId ?? -1)?.e ?? null;
  } else if (m.kind === 'percept') {
    const p = core.store.get('SELECT actor_entity_id AS e, actor_self AS s FROM percepts WHERE id = ?', m.id);
    id = p && !p.s ? p.e : null;
  } else if (m.kind === 'impression') {
    id = core.store.get('SELECT entity_id AS e FROM entity_impressions WHERE id = ?', m.id)?.e ?? null;
  } else if (m.kind === 'entity') {
    id = m.id;
  }
  return Number.isInteger(id) && id !== selfId ? id : null;
}

/**
 * 「现在是 X；上次在这里聊是周六（11/7）晚上，已经 4 天了，上次聊到：……」（评审:SC-21；D148 起时间都按人感觉的写）。上次聊的内容不能说时只给时间。
 * 间隔要看人（D148，实测问题 #47）：这里隔了很久，可眼前这个人之后在别处和她有来往（g0.elsewhere）时两件事都说——
 * 「；不过今天你们在别处一直有来往，最近一次是在「X」，今晚 21:55 · 5 分钟前」，不再说「隔了这么久」。那个场合的名字按工作记忆段头同样的放行规则
 * （placeOk：那个场合的档案卡在这一轮的目标上过了关口①），说不出名字就只说「在别处」。
 * 整行 ≤ itemChars + 40 字：上次聊到的内容放得下才放（至少 GAP_MIN_BODY 字）。
 */
function gapText(core, g0, g, cand, { at, tz, cfg, key, placeOk = () => false }) {
  const sp = (s) => (/^\d/u.test(s) ? ` ${s}` : s);
  const last = whenText(core, g0.prevAt, at, 'day');
  const span = spanText(core, at - g0.prevAt);
  let head = g0.kind === 'setting'
    ? `现在是 ${nowText(core, at)}；上次在这里聊是${sp(last)}，已经 ${span}了`
    : `现在是 ${nowText(core, at)}；你上次和正在跟你说话的这个人聊是${sp(last)}，已经 ${span}了`;
  const ew = g0.kind === 'setting' ? g0.elsewhere : null;
  if (ew && Number.isFinite(ew.at)) {
    const today = dayStart(ew.at, tz) === dayStart(at, tz);
    const lead = today ? (ew.count >= 3 ? '不过今天你们在别处一直有来往' : '不过今天你们在别处聊过') : '不过之后你们在别处还聊过';
    let where = '';
    try { where = placeOk(ew.settingKey) ? placeLabel(core, ew.settingKey) : ''; } catch { where = ''; }
    head += `；${lead}，最近一次是${where ? `在${where}，` : ''}${sp(whenText(core, ew.at, at, 'full'))}`;
  }
  const tail = ew ? '。先接住眼前这句，别直接接着这里上次的话题' : '。隔了这么久，先接住眼前这句，别直接接着那时的话题';
  const max = cfg.recall.involuntary.itemChars + 40;
  let text = sanitize(core, `${head}${tail}`);
  const lead = ew ? '。这里上次聊到：' : '，上次聊到：';
  const room = max - charLen(text) - charLen(lead);
  if (CONTENT.has(g.verdict) && room >= GAP_MIN_BODY) {
    const r = renderContent(core, cand, g, { at, tz, key, chars: Math.min(room, cfg.recall.involuntary.itemChars), told: false });
    if (r) text = `${sanitize(core, `${head}${lead}`)}${r.rendered}${tail}`;
  }
  return clip(text, max);
}
// 间隔那一行里「上次聊到」的内容至少要有这么多字，放不下就只说时间
const GAP_MIN_BODY = 24;

/** 场合的称呼（「X」，D148 间隔那一句用；和工作记忆段头同一个写法）。说不出（没有名字、只是一句描述）返回空字符串。 */
function placeLabel(core, sk) {
  const s = core.mods.intake.settingByKey(core, sk);
  if (!s?.label || s.labelKind === 'description') return '';
  let t = '';
  try { t = core.mods.intake.labelForPrompt(core, s.label, 20); } catch { t = clip(sanitize(core, s.label), 20).replace(/[「」『』“”"]/g, ' ').trim(); }
  return t ? `「${t}」` : '';
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function modeOf(core, key, diag = null) {
  try { return core.mods.admin.modeFor(core, key) ?? 'off'; } catch (e) {
    if (diag) diag.fault('mode', e);
    else core.log.warn('context.mode.error', { error: e?.code ?? e?.name ?? 'Error' });
    return 'off';   // 不知道这个场合开到哪一档：不注入
  }
}

/** 隐藏 / 忘掉 / 彻底删除的不渲染（admin 查不了就一条都不给：宁可这一轮没想起来）。 */
function suppressed(core, refs, diag = null) {
  if (!refs.length) return new Set();
  try { return core.mods.admin.suppressedRefs(core, refs) ?? new Set(); } catch (e) {
    if (diag) diag.fault('suppress', e);
    else core.log.warn('context.suppression.error', { error: e?.code ?? e?.name ?? 'Error' });
    return new Set(refs);
  }
}

const PERCEPT_COLS = 'id, at, setting_key, actor_entity_id, actor_self, addressed, kind, text, lang, standing';
function latestPercept(core, key) {
  return core.store.get(`SELECT ${PERCEPT_COLS} FROM percepts WHERE setting_key = ? ORDER BY id DESC LIMIT 1`, key) ?? null;
}
/** 这里最后一条别人对她说的话（焦点找不到时的退路，D108）。 */
function lastToHer(core, key) {
  return core.store.get(`SELECT ${PERCEPT_COLS} FROM percepts WHERE setting_key = ? AND actor_self = 0 AND addressed IN ('to-her','mentions-her')
                           ORDER BY id DESC LIMIT 1`, key) ?? null;
}
/**
 * 记下这个会话这一轮的触发者和焦点（关口②用，D107；只在内存里，有上限）。同一轮里又回想了一次（工具读到了新消息）：她在这个场合
 * 还没说话的，触发者取并集（这一次的在前）——不是用后一次把前一次换掉（评审：后一次只认得新读到的人，先问她的那个人就丢了）。
 */
function noteTurn(core, sessionId, key, triggers, focus, at, { self = false } = {}) {
  const st = core.state.context;
  st.turns ??= new Map();
  const ids = triggers.map((t) => t.entityId);
  const prev = st.turns.get(sessionId);
  // 她自己开启的一轮（idle；定时提醒到点，D144）：没有被回答的人，也不接上一轮的（D115）
  if (!self && prev && prev.settingKey === key && Number.isSafeInteger(prev.focusPerceptId)) {
    const spoke = core.store.get('SELECT 1 AS x FROM percepts WHERE setting_key = ? AND id > ? AND actor_self = 1 LIMIT 1', key, prev.focusPerceptId);
    if (!spoke) for (const e of prev.triggerEntityIds ?? []) if (!ids.includes(e)) ids.push(e);
  }
  st.turns.delete(sessionId);
  st.turns.set(sessionId, { triggerEntityIds: ids, focusPerceptId: Number.isSafeInteger(focus?.id) ? focus.id : null, settingKey: key, at, self: self && !ids.length });
  const cap = Math.max(16, Math.floor(core.config.get().recall.working?.memoMax ?? 2000));
  while (st.turns.size > cap) st.turns.delete(st.turns.keys().next().value);
}
function perceptByObs(core, adapter, obs) {
  if (!adapter) return null;
  return core.store.get(`SELECT ${PERCEPT_COLS} FROM percepts WHERE adapter = ? AND ext_key = ?`, adapter, core.keys.obsKey(adapter, obs)) ?? null;
}
function isPrincipal(core, id) {
  try { return core.store.get('SELECT authority FROM entities WHERE id = ?', id)?.authority === 'principal'; } catch { return false; }
}
function isToHer(p) {
  return p.addressed === 'to-her' || p.addressed === 'mentions-her';
}

function queryWarming(core) {
  try { return core.mods.worker.queryWarming(core) === true; } catch { return false; }
}

async function looksPast(core, focus, cfg, signal) {
  const ms = cfg.context.pastCheckMs;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const r = await withTimeout(core.mods.retrieve.looksLikePast(core, focus.text, { lang: focus.lang ?? undefined, signal: ac.signal }), ms, true);
    return r !== false;   // 判别从宽：拿不准（超时、出错）也当成在问过去（评审:SC-22）
  } catch {
    return true;
  } finally {
    ac.abort();
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * 最多等 ms：到点 reject 一个 code 'Timeout' 的错（回想的这一步按出错处理，记 context.recall.fault.<步骤>.Timeout，D117）。
 * 宿主取消了这一轮（signal）就马上 reject 一个 AbortError（记录器不把取消之后的出错算进出错）。
 */
function bounded(p, ms, signal = null) {
  let h;
  let onAbort = null;
  const abortErr = () => Object.assign(new Error('这一轮被取消了'), { name: 'AbortError', code: 'Aborted' });
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => {
      h = setTimeout(() => reject(Object.assign(new Error('这一步超过了它的截止时间'), { code: 'Timeout' })), Math.max(0, ms));
      if (signal) {
        if (signal.aborted) { reject(abortErr()); return; }
        onAbort = () => reject(abortErr());
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }),
  ]).finally(() => { clearTimeout(h); if (onAbort) signal.removeEventListener('abort', onAbort); });
}

function withTimeout(p, ms, onTimeout = null) {
  let h;
  return Promise.race([
    Promise.resolve(p),
    new Promise((resolve) => { h = setTimeout(() => resolve(onTimeout), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(h));
}

function rowsIn(core, sqlPrefix, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    out.push(...core.store.all(`${sqlPrefix} (${part.map(() => '?').join(',')})`, ...part));
  }
  return out;
}

function safeParse(s) {
  try { return JSON.parse(s ?? 'null'); } catch { return null; }
}
