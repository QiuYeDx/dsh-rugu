// retrieve 模块（§8、§6.6）：线索 → 五路召回 → RRF 融合 → 激活打分 → 抽样 → 重排 → MMR → 版本和发生次。
//   - 产出的是**还没过关口①**的候选（CandidateSet）；分寸评估、分层、打包、去掉本周期已发的，在 context 模块。
//   - 热路径零 LLM；不自主回想 800 ms 硬截止，到点没完成的那一路直接丢掉（§8.8）；有意回想可以等到 3 秒。
//   - 预过滤只看能不能访问（隐藏 / 忘掉 / 墓碑 / 空间不对），**从不按「这里能不能说」过滤**（§8.2）。
//   - 预取缓存键 = （场合键，这个场合最新一条感知的 id）（§8.1）。
//   - 稠密、词法、图扩散三路经 worker（只读连接、worker_threads）；时间、在场者近况两路在主线程（都很便宜）。
// 拥有的表：无（只读）。内存里的预取缓存在 state.retrieve。
// 用到的端口：embedding（查询，经 worker.embedQuery）、rerank、llm（可选的预取改写 use='rewrite'）、clock。
// 契约细节：docs/实现/模块与接口.md §4.6。
// 内部文件：cues.js（线索）、routes.js（五路）、fuse.js（RRF、MMR）、hydrate.js（候选元数据）、pipeline.js（主流程）、
//   render.js（渲染）、past.js（看起来在问过去）、prefetch.js（预取和缓存）、background.js（提炼背景）、level.js（降级和熔断）、
//   params.js（参数和还没并进 defaults.js 的默认值）、names.js（称呼）、working.js（工作记忆的候选，§8.10）、util.js、
//   scope.js（范围，D153）、intent.js（读懂问题，D154）、recollect.js（回忆，D155）。
import { buildCues as buildCuesImpl } from './cues.js';
import { hydrate as hydrateRefs } from './hydrate.js';
import { runRecall, emptySet } from './pipeline.js';
import { fuse as fuseImpl, mmr as mmrImpl } from './fuse.js';
import { render as renderImpl } from './render.js';
import { looksLikePast as looksLikePastImpl } from './past.js';
import { onPercepts as onPerceptsImpl, prefetch as prefetchImpl, cached as cachedImpl, cacheEntry, store as storeCache,
  cachedRewrite as cachedRewriteImpl, parseRewrite as parseRewriteImpl } from './prefetch.js';
import { buildIntent as buildIntentImpl } from './intent.js';
import { backgroundForExtraction as backgroundImpl } from './background.js';
import { workingSet as workingSetImpl, recentPartners as recentPartnersImpl, topicSimilarity } from './working.js';
import { staticLevel, storeOk } from './level.js';
import { scopeOf as scopeOfImpl } from './scope.js';
import { recollect as recollectImpl, recollectEnabled, recollectTier as recollectTierImpl } from './recollect.js';
import { outlineRows } from './outline.js';
import { groupSame } from './merge.js';
import { errKind, latestPerceptAnywhere, latestPerceptOf, log, metric, safe } from './util.js';

/**
 * 一路的结果。
 * @typedef {object} RouteResult
 * @property {'dense'|'lexical'|'entity'|'time'|'present'} route
 * @property {{ref: string, score: number}[]} hits   按相关度降序
 * @property {number} ms
 * @property {boolean} timedOut
 */

/** 会写进预取缓存的触发方式（模拟器、提炼背景、有意回想的结果不进缓存）。 */
const CACHEABLE_TRIGGERS = new Set(['message', 'reminder', 'relay', 'idle', 'prefetch']);

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.retrieve = {
    prefetch: new Map(),          // 场合键 → {key: 最新感知 id, cueHash, full, set, queryVectors, at}
    timers: new Map(),            // 场合键 → {timer, full}（预取防抖）
    breaker: { failures: 0, openUntil: 0 },   // 查询嵌入熔断（§8.8）
    exemplars: new Map(),         // 「看起来在问过去」的示例问法向量（按语言 + 空间）
    pastCache: new Map(),
    lastSeen: new Map(),          // 场合键 → 上次回想时「这个场合最新一条:全库最新一条」感知的 id（纯超时唤醒、哪儿都没有新的事才跳过，D132）
    selfId: null,
    disposed: false,
  };
}
/** 清掉防抖定时器。 @param {import('../core-types.js').CoreContext} core */
export function dispose(core) {
  const st = core.state.retrieve;
  if (!st) return;
  st.disposed = true;
  for (const t of st.timers.values()) clearTimeout(t.timer);
  st.timers.clear();
  st.prefetch.clear();
}

/**
 * 线索（§8.1，零 LLM、< 2 ms）：窗口（最近 6–10 条，≤ 400 字）、在场者（成员能列全时是成员，否则最近 30 分钟亲自发过言的人 + 她自己，
 * 评审:PS-13）、被提到的人（只是线索）、正文里的名字（entities.nameMatcher）、时间表达（lang）、查询文本（1–2 条）、
 * 「看起来在问过去」（looksLikePast 的同步部分；嵌入相似度在 recall 里补）。
 * 返回的 Cues 另外带几个内部字段（directedText、focusSpeaker、aboutEntityIds、windowText、windowPlain、rewrites）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null, query?: string|null, about?: string|null, time?: string|null}} s
 * @returns {import('../core-types.js').Cues}
 */
export function buildCues(core, s) { return buildCuesImpl(core, s); }

/**
 * 召回（不含分寸）：五路并行 → fuse → dynamics.activate → dynamics.sample（不自主）或 τ_del 门槛（有意）→
 * 有余力就重排前 30 条（rerank 端口可用时）→ mmr → 版本（最近被取代的跟着新版本带出）和发生次（最近的一次排前，
 * 几次时间接近标「可能指多次」）→ 每个实体最多 3 条。预取命中就直接用缓存。
 * 不抛错：嵌入、重排、worker 出问题按降级走；存储坏了返回空的候选集（degradeLevel 4，本轮不注入）。
 * 眼前这段对话（线索窗口里的感知、整段落在窗口里的原文窗口）不算「想起来的」，不进候选。
 * 候选上另外带：meta（元数据）、previousRef / versionOf（版本链）、occurrence（同类事的第几次、是否可能指多次）、
 * outcomeOf（计划的结果，跟着计划走）、belief（关于的人只是「可能是同一个人」，渲染带「好像」）、
 * fok（知道感，只说想不起细节）、attachedTo（顺着链接带出来的，跟着哪条走）、
 * blank（和 fok 一起：有意回想碰到整体恢复后没补回来的那段时间 {from, to, settingKey, here}，§12.4.5 第 8 步：问到的时间落在
 * 空白里，或者没给时间、什么都没想起来、而眼下的对话是接着空白那段聊下来的；锚在那个场合的一条感知上，照常过关口①，
 * 渲染只写那几天有些事「记不太清」，不给锚点的内容）。
 * 降级级别：稠密路可不可用以 worker.health 为准（线程挂了 embedQuery 照样给向量，只有扫描降级，D40）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null, sessionId?: string|null, trigger: string}} s
 * 【D155】有意回想（mode = 'deliberate'）默认走「回忆」（retrieve/recollect.js）：读懂问题（buildIntent）→ 圈范围（scopeOf）→ 范围内稠密 + 字面
 * （按名次合并）+ 上面这条全库流水线照跑一次 → 范围内的在前、有时间窗时盖住时间 → 名额按 recall.recollect 的两档（工具 / 自动触发，随花费档位）。
 * 结果另带 recollect：{tier, fallback, intent, scope, segments, ms}（给 context 写「找了哪儿」那一行、记进注入日志），每条候选带
 * recollect: {pick, t, scoped, seg}（pick 是名额的先后，t 是时间）。意图、范围、范围内检索出错或超时退回只有全库那一份（fallback 记哪一步）。
 * opt.recollect === false（夜里反思取证据）或 recall.recollect.enabled 关掉时照旧走全库流水线。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null, sessionId?: string|null, trigger: string}} s
 * @param {{mode: 'involuntary'|'deliberate', query?: string, about?: string, time?: string, where?: string, includeHistory?: boolean,
 *          deadlineMs: number, signal?: AbortSignal, recollect?: boolean}} opt
 * @returns {Promise<import('../core-types.js').CandidateSet>}
 */
export async function recall(core, s, opt) {
  try {
    if (!s || typeof s.settingKey !== 'string' || !s.settingKey) return emptySet(null, degradeLevel(core));
    if (!storeOk(core)) return emptySet(null, 4);
    const st = core.state.retrieve;
    const mode = opt?.mode === 'deliberate' ? 'deliberate' : 'involuntary';
    const plain = !opt?.query && !opt?.about && !opt?.time && !opt?.includeHistory;
    const entry = cacheEntry(core, s.settingKey);
    const fresh = entry && !entry.stale ? entry : null;
    // 她自己开启的一轮（idle）沿用缓存、或者干脆不回想，都要「别处也没有新的事」（D132）：原来只看这个场合有没有新消息，
    // 安静了一夜的私聊里她主动开口时，拿到的是昨晚那一刻算好的候选（或者什么都没有），早上在别处发生的事一条都想不起来
    if (mode === 'involuntary' && plain && fresh && (s.trigger === 'idle' ? !fresh.elsewhere : fresh.full || staticLevel(core) >= 3)) {
      metric(core, 'retrieve.cache.hit');
      return fresh.set;
    }
    // 纯超时唤醒、哪儿都没有新消息：不重新回想（§8.1）
    const latest = `${latestPerceptOf(core, s.settingKey)}:${latestPerceptAnywhere(core)}`;
    if (s.trigger === 'idle' && plain && st.lastSeen.get(s.settingKey) === latest) return emptySet(null, staticLevel(core));
    // 预取时（直接对她说的消息）做过的指代改写，同一份线索的回想接着用（有意回想的查询扩展，§6.6）
    const rewrites = fresh?.rewrites ?? [];
    // 回忆（D155）：有意回想走新路（读懂问题 → 圈范围 → 范围内找 + 全库照跑一次）；recall.recollect.enabled 关掉、或者调用方说不要
    // （夜里反思取证据）时照旧
    const { set, queryVectors } = mode === 'deliberate' && opt?.recollect !== false && recollectEnabled(core)
      ? await recollectImpl(core, s, { ...opt, mode }, { entry, fresh })
      : await runRecall(core, s, opt ?? { mode, deadlineMs: 0 }, { queryVectors: entry?.queryVectors ?? null, rewrites });
    st.lastSeen.set(s.settingKey, latest);
    if (mode === 'involuntary' && plain && CACHEABLE_TRIGGERS.has(s.trigger) && set.cues) {
      // 预取时改写的结构化结果（D154）跟着线索一起留下：她自己开口的轮重算时原来只带了 rewrites，「读懂问题」就拿不到它了
      storeCache(core, s.settingKey, { key: set.cues.latestPerceptId, cueHash: set.cues.hash, full: true, set, queryVectors, rewrites,
        ...(fresh?.rewrite ? { rewrite: fresh.rewrite } : {}), at: core.now(), any: latestPerceptAnywhere(core) });
    }
    return set;
  } catch (e) {
    metric(core, 'retrieve.recall.error');
    log(core, 'error', 'retrieve.recall.failed', { error: errKind(e) });
    return emptySet(null, storeOk(core) ? safe(core, 'level', () => staticLevel(core), 4) : 4, { failed: errKind(e) });
  }
}

/**
 * intake 提交感知后通知（store.afterCommit 里调）：对她说的、@ 她的消息按场合防抖 intake.prefetchDebounceMs 做完整预取
 * （含查询嵌入，必要时 context 会再启动第二段评估）；旁听消息只算词法、实体、时间、在场者近况四路，不做查询嵌入、不调 LLM。
 * historical 的不预取。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {import('../intake/index.js').PerceptRow[]} rows
 */
export function onPercepts(core, settingKey, rows) { onPerceptsImpl(core, settingKey, rows); }

/**
 * 立刻预取一次并放进缓存（onPercepts 的防抖到点时调用；测试里直接调）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{full: boolean, focusPerceptId?: number|null, signal?: AbortSignal}} opt
 * @returns {Promise<void>}
 */
export async function prefetch(core, settingKey, opt) { return prefetchImpl(core, settingKey, opt ?? { full: false }); }

/**
 * 预取缓存（同步）。键 = （场合键，最新感知 id）；对不上、或者算好以后过了 recall.prefetchTtlMin（D132）返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {import('../core-types.js').CandidateSet|null}
 */
export function cached(core, settingKey) { return cachedImpl(core, settingKey); }

/**
 * 【D154】读懂问题：把工具参数（query / about / time / where）、预取改写的结构化结果、语言层（人称、时间表达）合并成一份意图——
 * 关于谁（aboutEntityIds）、时间窗、场合（settingKeys）、形状（point / timeline / roster / profile，只来自改写）、1–3 句线索，
 * 外加每一项哪来的（from）。先后：工具参数 > 改写 > 语言层，每一项各取第一个算得出的来源。同步、不调模型、不抛错（算不出的项为空）。
 * 这一版只产出意图，回想的流水线还没用它（D155）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object|null} cues  buildCues 的结果
 * @param {{query?: string|null, about?: string|null, time?: string|null, where?: string|null, rewrite?: object|null}} [given]
 * @returns {import('./intent.js').Intent}
 */
export function buildIntent(core, cues, given) { return buildIntentImpl(core, cues, given ?? {}); }

/**
 * 【D154】这个场合最新一次预取改写的结构化结果（给 buildIntent 的 given.rewrite）；没有、作废了（来了新消息、过了 recall.prefetchTtlMin）给 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {import('./prefetch.js').RewriteResult|null}
 */
export function cachedRewrite(core, settingKey) { return cachedRewriteImpl(core, settingKey); }

/**
 * 【D154】宽容地解析改写的输出：JSON 对象（可以包在代码块、多余文字里）取 cues / about / time / where / shape，不合法的项为空；
 * 不是 JSON 就按行取线索（rewrite-1 的格式）。纯函数，不抛。
 * @param {string} text
 * @param {{maxCues?: number}} [opt]
 * @returns {import('./prefetch.js').RewriteResult}
 */
export function parseRewrite(text, opt) { return parseRewriteImpl(text, opt); }

/**
 * RRF（k = recall.rrfK）合并各路，留 ≤ recall.fuseKeep 条。纯函数。
 * @param {RouteResult[]} routes
 * @param {{k: number, keep: number}} params
 * @returns {import('../core-types.js').Candidate[]}
 */
export function fuse(routes, params) { return fuseImpl(routes, params); }

/**
 * MMR 去重（λ ≈ 0.7）。sim 返回两条候选的相似度（有向量用向量，没有用词元 Jaccard）。纯函数。
 * 【补】dup(a, b) 为真（挑中的 a 和已选的 b 几乎一样）时 a 不进结果、不占名额（合并到 b）。
 * @template T
 * @param {T[]} items                   已按分数降序
 * @param {{lambda: number, sim: (a: T, b: T) => number, score: (x: T) => number, limit: number, dup?: (a: T, b: T) => boolean}} params
 * @returns {T[]}
 */
export function mmr(items, params) { return mmrImpl(items, params); }

/**
 * 按目标场合渲染一条记忆（§5.3「存储比人精确，表达像人」、§5.4 时态、§6.6 措辞、§8.5 来源说法）：
 *   - 时态由 dynamics.pHold + tense 决定（「那天他加班了」「他之前说在加班，现在不知道」）；
 *   - 来源说法按来源和激活：「他自己说的 / 听阿明说 / 我猜」，激活低时可以说成「好像是听你们群里谁提过」；
 *   - 版本：最近被取代的带出来渲染成「之前……，后来……」；
 *   - verdict='share_vague' 时用第二段写好的含糊版本，来源也含糊；
 *   - 时间按人感觉的写（D148，lang.describeTime：「今晚 21:39 · 20 分钟前」「昨天晚上 22:14」「周日（11/8）下午」），钟点和日子照样写着（F25）。
 * 渲染结果 ≤ itemChars；文字过 intake.sanitizeForPrompt。
 * 可选字段：opt.settingKey（目标场合：来源在同一个场合时说「在这里」，称呼按这个场合里的叫法）；
 * opt.previous（旧版本也过了关口①时传进来，渲染成「之前……，后来……」；没传就只渲染这一版）；
 * opt.placeAllowed【补】（场合键 → 能不能在目标这里写出那个场合的名字：别的场合的名字也是记忆，场合的档案卡过了关口①才写，
 * 否则来源说法里不写在哪儿；context 总是给，不给时照旧写名字）；
 * opt.timeStyle【补】（D148：'full' 缺省，几个小时以内带「多久以前」；'day' 不带，常驻区这种会冻结一段时间的文字用）；
 * opt.excerpt【补】（D155，只在回忆这条路上给：几句线索；正文放不下时截和它们的词最对得上的那一段，两头带「…」，不是从头截）；
 * opt.outline【补】（D156：渲染成「那段时间的经过」的一行——时间 · 在哪儿 · 这段经历的一句话）。
 * 候选上的 belief（maybe_same）让措辞带「好像」、把握不超过链接的置信度；计划写明状态和结案的绝对时间；
 * blank（补不回的空白）只写「那几天有些事记不太清」，说个大概也一样，不给锚点的内容。
 * 记忆已经不在了（被删）返回空字符串，调用方跳过这条。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').ScoredCandidate} c
 * @param {{verdict: 'share'|'share_vague', vagueText?: string|null, at: number, itemChars: number, settingKey?: string|null,
 *          previous?: {candidate: import('../core-types.js').ScoredCandidate, verdict: 'share'|'share_vague', vagueText?: string|null}|null,
 *          placeAllowed?: (settingKey: string) => boolean, timeStyle?: 'full'|'day', excerpt?: string[], outline?: boolean}} opt
 * @returns {{rendered: string, provenance: string, confidence: number}}
 */
export function render(core, c, opt) { return renderImpl(core, c, opt); }

/**
 * 「看起来在问过去」（§6.6）：最新一句话和 lang 的示例问法比嵌入相似度 + 时间表达解析；嵌入不可用（L3）时退回时间解析 + 句式线索，
 * 判别从宽（拿不准也返回 true，评审:SC-22）。不调 LLM。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {{lang?: string, signal?: AbortSignal}} [opt]
 * @returns {Promise<boolean>}
 */
export async function looksLikePast(core, text, opt) { return looksLikePastImpl(core, text, opt); }

/**
 * 提炼用的背景（§7.3）：用同一套混合召回（有意模式）取出，按「本场合的人是不是本来就知道」分成两组
 * （discretion.knownCircle 覆盖本场合受众的进 known，其余进 private）。还没结案的计划在两组里都以事实（'a<id>'）给出，
 * 模型才能对它写 plan_status（S2b）：本段说话的人（含她自己）的计划排在最前（最多 recall.background.plans 条），
 * 召回到的原始感知 / 窗口 / 情节是哪条计划的证据，那条计划跟在它后面。不抛错：出问题返回空的两组。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, perceptIds: number[]}} seg
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{known: {ref: string, text: string}[], private: {ref: string, text: string}[]}>}
 */
export async function backgroundForExtraction(core, seg, opt) { return backgroundImpl(core, seg, opt ?? {}); }

/**
 * 【补】工作记忆的候选（§8.10，D100；同步、零 LLM，不抽样）：这一轮的触发者（和权利层确认的同一个人）在别的场合亲口跟她说的话、
 * 她在别的场合回他的话（他每一行之后同一场合紧跟着的 recall.working.replyScan 条里、别人接话之前她说的，按 id 判）、
 * 他要她做还没了结的意图的来源行。每行
 * A = 基础激活 B + recall.working.triggerBoost + cueWeight × 话题相似度（只拿他这一句和他在这里最近 topicOwnLines 行算）
 * +（意图的来源行）openBoost（过了时间窗的按 encode.intentionOverdue 平滑减掉；她回他的话不沾光，D110），话题里他在这里的旧行按激活加权；
 * 按 A 预选最多 maxLines 的两倍（primary），每行带上同一段里前面最多 contextLines 条一来一回。没有任何时间窗或到期：
 * candidatePool 只限一次看多少行（按 id 倒序走索引）。不判能不能说（discretion.admitWorking 判）。不抛错：出问题返回空的。
 * units（D110）：在全部候选上切的段——open（一件开着的意图，成员是它的来源行）、thread（约定的一串：根是他的 asks、照着做的一步经 follows
 * 追到根；第一眼 glance-2 以前的旧行按连续几句宽松 asks 退回切，fallback）、talk（其余），每段带 core、B（成员 B 的最大值 + cueWeight × 他这一句
 * 的话题相似度的最大值）、newerThanHere、latestRoot、replacedRef；有成员 A ≥ tau 的段（和开着的事）才返回，lines 含它们的全部成员。
 * 【D145】他的一句话在回别人时，这一行带 repliedTo（被回的那一句：回复 / 引用的目标；没有的话是同一场合往前 recall.working.repliedScan
 * 条以内（她的话跳过，他自己连着说的几句不算数）别人亲口说的几句里，他这一句的词出现得最多的那一句，都对不上取最近的；对她说的话
 * 不猜）和 repliedLead（说那一句的人紧挨在它前面、没人插话连着说的话，最多 recall.working.repliedRun 句，新的在前），replied 列出
 * 这几句（原话、时间、说的人、回它的那几行、跟着哪一句 leadOf）。它们不是候选行，只在算他这一行的话题相似度时把词并进来；
 * 闲聊段的 core 另加话题相似度 ≥ onTopicMin 的他的那一句（最相近的一句）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null}} cues
 * @param {{triggerEntityId: number|null, at?: number}} opt
 * @returns {{triggerEntityId: number|null, people: number[], lines: object[], units: object[], candidates: number, aboveTau: number, replied: object[]}}
 */
export function workingSet(core, cues, opt) {
  try { return workingSetImpl(core, cues, opt ?? {}); } catch (e) {
    metric(core, 'retrieve.working.error');
    log(core, 'warn', 'retrieve.working.failed', { error: errKind(e) });
    return { triggerEntityId: opt?.triggerEntityId ?? null, people: [], lines: [], units: [], candidates: 0, aboveTau: 0, replied: [] };
  }
}

/**
 * 【补】她最近在别的场合来往过的人里，哪几个在这里（D132；同步、零 LLM）：她自己开口的一轮没有「眼前这个人」，context 拿它定
 * 「她要对谁说」，再按每个人各算一份 workingSet。来往 = 别处对她说的话、她在别处接着回的那个人；在这里 = 在 among 里（这里的听众），
 * 或者以前亲自在这里说过话（成员列不全的群），权利层确认的同一个人也算。按最近一次来往从新到旧，最多 max 个（默认
 * recall.working.maxTriggers）；没有时间窗，一次往回看 recall.working.candidatePool 条。不抛错：出问题返回空的。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string}} q
 * @param {{among?: number[], max?: number}} opt
 * @returns {number[]}
 */
export function recentPartners(core, q, opt) {
  try { return recentPartnersImpl(core, q, opt ?? {}); } catch (e) {
    metric(core, 'retrieve.working.error');
    log(core, 'warn', 'retrieve.partners.failed', { error: errKind(e) });
    return [];
  }
}

/**
 * 工作记忆的话题相似度（D107：关口②判「是不是他自己提起的」）：触发者这一句（focusPerceptId）+ 他在这里最近的 recall.working.topicOwnLines 句
 * 和每段文字的相似度（0–1，词的重合，同步、零 LLM）。别人的话不参与。出错按 0（不算他提起的，更严）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, people: number[], focusPerceptId?: number|null}} q
 * @param {string[]} texts
 * @returns {number[]}
 */
export function workingSimilarity(core, q, texts) {
  try { return topicSimilarity(core, q, texts); } catch (e) {
    metric(core, 'retrieve.working.error');
    return (texts ?? []).map(() => 0);
  }
}

/**
 * 当前的降级级别（§8.8）：0 完整 / 1 不重排 / 2 CPU 稠密 / 3 无嵌入（端口缺失、熔断、空间可疑，或 worker.health 说稠密路
 * 不可用：线程挂了、worker 的嵌入熔断）/ 4 存储故障。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {0|1|2|3|4}
 */
export function degradeLevel(core) {
  try { return staticLevel(core); } catch { return 4; }
}

/**
 * 【D153】范围（「回忆」的圈范围）：时间窗 / 关于谁 / 场合里的全部记忆（情节 e…、事实 a…、原文窗口 w…）。只读、同步、只走索引，不过关口；
 * 被取代或过时的事实、原文到期的窗口、隐藏 / 忘掉 / 删掉的不在里面。几样条件取交集，同一样里几个值取并集；一样都没给 given = false、
 * refs = null（不圈）。超过 maxRefs（默认 recall.scope.maxRefs）留最近的、clipped = true；opt.at 之后才记下的不算。
 * 口径细节见 retrieve/scope.js。查隐藏出错时 refs 是空集合、failed = 'suppression'（fail closed）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{timeWindows?: {start: number, end: number}[], aboutEntityIds?: number[], settingKeys?: string[]}} spec
 * @param {{at?: number, maxRefs?: number}} [opt]
 * @returns {{given: boolean, refs: Set<string>|null, rows: {ref: string, tStart: number, tEnd: number, settingKey: string|null}[],
 *            counts: {episodes: number, assertions: number, windows: number}, clipped: boolean, failed?: string}}
 */
export function scopeOf(core, spec, opt) { return scopeOfImpl(core, spec, opt ?? {}); }

/**
 * 【D155】回忆这一档的名额：tool（她调记忆工具）/ auto（被直接问到以前的事、自动触发）。recall.recollect 的 maxItems、totalChars
 * 乘花费档位的 recollectScale（节省档 0.5），itemChars 不变。同步、不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {'tool'|'auto'} kind
 * @returns {{kind: 'tool'|'auto', maxItems: number, itemChars: number, totalChars: number}}
 */
export function recollectTier(core, kind) { return recollectTierImpl(core.config.get(), kind); }

/**
 * 【D156】「那段时间的经过」（memory_look 的 when 用）：范围里的经历一段一行的候选，按段轮流、段内按时间均匀取（没有线索，不排对题），
 * 最多 max 条；同一件事合并（recall.recollect.merge），每组 {ref, t, merged}，按时间从早到晚。范围跨了 recall.recollect.outline.dayLayerDays
 * 天以上时先给日记、小结。只给候选（还没过关口①），出错返回空的。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{rows: {ref: string, tStart: number, tEnd: number, settingKey: string|null}[]}} scope   scopeOf 的结果
 * @param {{max: number, signal?: AbortSignal}} opt
 * @returns {Promise<{ref: string, t: number, merged: string[]}[]>}
 */
export async function outlineOf(core, scope, opt) {
  try {
    const R = core.config.get().recall.recollect ?? {};
    const rows = outlineRows(core, scope, { max: opt?.max ?? 40, dayLayerDays: R.outline?.dayLayerDays });
    if (!rows.length) return [];
    const metas = hydrateRefs(core, rows.map((r) => r.ref));
    const cands = rows.filter((r) => metas.has(r.ref)).map((r) => ({ ref: r.ref, t: r.t, meta: metas.get(r.ref) }));
    const M = R.merge ?? {};
    const groups = await groupSame(core, cands, { gapMin: M.gapMin, minSim: M.minSim, minOverlap: M.minOverlap, deadlineMs: 120, signal: opt?.signal });
    return groups.map((g) => ({ ref: g.rep.ref, t: g.rep.t, merged: g.others })).sort((a, b) => a.t - b.t || (a.ref < b.ref ? -1 : 1));
  } catch (e) {
    metric(core, 'retrieve.outline.error');
    log(core, 'warn', 'retrieve.outline.failed', { error: errKind(e) });
    return [];
  }
}
