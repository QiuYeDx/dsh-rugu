// discretion 模块（§9、§5.6）：知道 ≠ 说出来。
//   - 代码维护模型记不准的事实：出现集合、谁知道、告诉过谁、流动规范、场合规矩（单调性）。
//   - 关口①（gate）：第一段代码快速判定（**先查底线 B1–B5、T1/T2，再看放行 A1–A3**）+ 第二段她的独立判断（信息流卡片，use='appraise'）。
//     进入她上下文的每一段记忆文字都逐条过关口①，每条都能对上 appraisals 里的一行（§9.3.6）。
//   - 关口②（appraise）：公开目标——代码初筛 + 独立审视（use='review'，有独立预留预算），审不了就 fail closed（§9.4.2 第 4 条）；
//     其余目标——两条只认「几乎原样」的外发守护（G1 核对过原话的叮嘱、G2 一对一里别人私下的原话，D113），出错放行。
//   - D113「功能优先」：非公开目标的关口①只跑第一段，知道的事带着来源标签进上下文，说不说由她判断。
//   - 关口③（onSelfUtterance）：她的话回流后记告诉过谁、扩充谁知道、找出没经过审视的发言。
//   - 只读抽象属性，没有入口名、没有固定词表、没有对「主人」的特例（主人 = 亲密度最高 + 有管理权限的实体）。
// 拥有的表：presence_sets、flow_norms、setting_rules、known_by、told_log、appraisals、utterances、discretion_log、glances。
// 用到的端口：llm（appraise、review、glance）、budget、selfProfile、clock、embedding（初筛的整句向量，经 worker）。
// 契约细节：docs/实现/模块与接口.md §4.7。内部文件：
//   util / facts（读别的模块的数据）/ knowledge（出现集合、谁知道、知情圈、新知情者）/ norms（规范、场合规矩）/
//   stage1（底线和放行）/ stage2（卡片、缓存、独立判断）/ gate（关口①）/ working（工作记忆的准入，D100）/ egress（关口②）/
//   told（关口③、分寸日志）/ match（文字比对）/ glance（第一眼，D106：感知落库后异步看一眼，只让分寸更准，从不决定她知不知道）。
import { dcfg, semaphore, soft } from './util.js';
import { parseRef } from '../store/index.js';
import * as FA from './facts.js';
import * as K from './knowledge.js';
import * as NRM from './norms.js';
import * as S1 from './stage1.js';
import * as G from './gate.js';
import * as EG from './egress.js';
import * as T from './told.js';
import * as WK from './working.js';
import * as GL from './glance.js';
import * as EX from './expire.js';

export { STAGE1_RULES } from './stage1.js';
export { TRIGGER_CLASSES, AUDIENCE_FEATURES, APPRAISE_PROMPT_VERSION } from './stage2.js';
export { REVIEW_PROMPT_VERSION, FINAL_REFLECTION } from './egress.js';
export { GLANCE_PROMPT_VERSION } from './glance.js';
export { SECRECY_REQUEST_REASON, RIGHTS_DECIDERS } from './facts.js';
export { JOB_TOLD_SCAN, JOB_POSTCHECK } from './told.js';
export { TURN_TAINT_MARK } from './util.js';

/**
 * 写 known_by 的一条。
 * @typedef {object} KnowledgeEntry
 * @property {'entity'|'presence_set'|'setting'} whoKind
 * @property {string} whoRef            实体 id / 出现集合 id / 场合键（都转成字符串存）
 * @property {number} since
 * @property {'presence'|'setting'|'subject'|'told_by_her'|'public'|'claimed'} basis
 * @property {number|null} [claimant]   basis='claimed' 时：是谁声称的（「X 声称 B 已经知道」，只进卡片）
 */
/**
 * 规范变化的请求（提炼的 norm_update 行、memory_fix、管理页）。
 * @typedef {object} NormUpdate
 * @property {{kind: 'memory', ref: string}|{kind: 'setting', settingKey: string}} target
 * @property {'relax'|'tighten'} direction
 * @property {Partial<import('../core-types.js').NormInput>} change
 * @property {string|null} quote
 */

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.discretion = {
    inflight: new Map(),          // 第二段：缓存键 → 正在跑的那次调用（同一件事不重复花钱）
    calls: new Map(),             // 场合键 → 最近一小时的第二段调用时刻（每场合每小时上限）
    lastModel: {},                // use → 上次回复的模型（缓存键里带模型）
    promptHash: {},               // use → 登记过的提示词哈希
    membersAt: new Map(),         // 场合键 → 上次向适配器要成员名单的时刻
    selfId: null,                 // 她自己的实体 id（建好以后不变；recordPresence 判 private 用）
    sem: semaphore(Math.max(1, dcfg(core).stage2.concurrency)),
    ctl: new AbortController(),   // dispose 时取消进行中的评估
    glance: { queue: new Map(), inflight: new Set(), live: new Set(), active: 0, waiting: [], idle: [], hot: new Set() },   // 第一眼的队列（D106）
  };
  core.jobHandlers.set(T.JOB_TOLD_SCAN, (c, job, opt) => T.runToldScan(c, job, opt));
  core.jobHandlers.set(T.JOB_POSTCHECK, (c, job, opt) => T.runPostcheck(c, job, opt));
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) {
  const st = core.state.discretion;
  if (!st) return;
  try { st.ctl.abort(); } catch { /* 忽略 */ }
  st.inflight.clear();
  GL.disposeGlance(core);
}

// ── 出现集合、谁知道 ────────────────────────────────────────────────────────

/**
 * 记一个出现集合（§5.6 第 1 条）。和这个场合上一个同类的出现集合的名单相同就复用那一行。在 intake 的事务里调用（同步）。
 * 完整名单里只有她自己（her-only 的感知记在她知道的那个场合），或者给了 private：记成 private（presence_sets.private=1），
 * 它说的是「这条只有她看到」，算这个场合的知情圈、谁在场时跳过。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, at: number, members: number[], completeness: 'exact'|'recent-speakers'|'unknown', unknownObservers: boolean, private?: boolean}} p
 * @returns {number}
 */
export function recordPresence(core, p) { return K.recordPresence(core, p); }

/**
 * 写「谁知道」（§5.6）。encode 写情节、事实时按来源的 visible_to 调用：setting-audience → 场合级（who_kind='setting'，since = 感知时间）
 * 加出现集合；her-only → 不写别人（selfOnly）；participants → 出现集合。主体本人只在说话人就是主体本人（权利层确认）时记。
 * 在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {KnowledgeEntry[]} entries
 */
export function recordKnowledge(core, ref, entries) { NRM.assertRef(ref); K.recordKnowledge(core, ref, entries); }

/**
 * 一条记忆的已知圈（§9.3.1）。'claimed' 和 'public' 不进已知圈（PS-05、PS-08）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {number} at
 * @returns {import('../core-types.js').KnownCircle}
 */
export function knownCircle(core, ref, at) { NRM.assertRef(ref); return K.knownCircle(core, ref, at); }

/**
 * 目标场合的知情圈（§9.3.1）：当前快照 + 最近的出现集合 + adapter.members()（能列成员的平台）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {number} at
 * @returns {import('../core-types.js').Audience}
 */
export function audienceOf(core, settingKey, at) { return K.audienceOf(core, settingKey, Number.isFinite(at) ? at : core.now(), new Map()); }

// ── 流动规范、场合规矩 ─────────────────────────────────────────────────────

/**
 * 写（或整体替换）一条记忆的规范，version + 1，旧值进 history_json；让相关的评估缓存失效。在调用方的事务里调用。
 * 规范只能由写记忆的模块在写入时给出（§5.6「规范在写入时给出」）；之后的变化走 tightenNorm / applyNormUpdate。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {import('../core-types.js').NormInput} norm
 * @returns {number} 新版本号
 */
export function writeNorm(core, ref, norm) { return NRM.writeNorm(core, ref, norm); }

/**
 * 读规范；没有行时返回 unassessed（按最严处理：只能经 A1 放行，离开 visible_to 最多给到「说个大概」，§5.6）。
 * 引用的场合规矩比规范本身更严时，按更严的算（setting_rule_ref 的最新 active 版本）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @returns {import('../core-types.js').Norm}
 */
export function normOf(core, ref) { NRM.assertRef(ref); return NRM.normOf(core, ref, new Map()); }

/**
 * 收紧（撤回 → 至少 soft，§5.6；被标了污点；主人的纠正）。收紧不需要权限。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {{restriction?: 'soft'|'strict', sensitivity?: number, reason: string, at: number}} t
 */
export function tightenNorm(core, ref, t) { NRM.tightenNorm(core, ref, t); }

/**
 * 派生内容的规范（§5.6「派生内容的规范」）：默认继承所有证据里最严的；复述原话的「谁知道」取交集，
 * 推断类（反思、猜测、泛化）的「谁知道」固定是她自己。放宽只在代码可核验的条件下（k 个主体、没有具体个人……），最多一级。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {import('../core-types.js').MemoryRef[]} evidence
 * @param {{derivation: 'quote'|'inference', at: number}} ctx
 */
export function inheritNorm(core, ref, evidence, ctx) { NRM.inheritNorm(core, ref, evidence, ctx); }

/**
 * 规范或场合规矩的变化请求（§7.4 第 9 条、§5.6 单调性）：收紧直接生效；放宽只认经权利层确认的主体本人、当初提出限制的人、
 * 有管理权限的人，否则只记成听来的「有人说可以说了」（不生效），必要时进审核队列（admin.enqueueReview kind='norm_change' /
 * 'setting_rule_relax'）。「别告诉主人」这类专门对管理者保密的要求，本身报 T1（admin.notifyNeedToKnow）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {NormUpdate} update
 * @param {{speakerEntityId: number|null, at: number, perceptId?: number|null}} ctx
 * @returns {{applied: boolean, queued: boolean, reason?: string}}
 */
export function applyNormUpdate(core, update, ctx) { return NRM.applyNormUpdate(core, update, ctx); }

/**
 * 「他叮嘱过别外传」（D113）：只认核对过原话、或者主人定过的叮嘱——第一眼 limit 是 soft / strict 且 quote_ok、不是她自己的话；
 * 规范的 restriction_quote 真在来源原文里（说那句的不是她）；有 deny / allow 名单而 restricted_by 不是她；规范历史里有管理者收紧过。
 * 没有原话的 soft（提炼、撤回留下的）不算。工作记忆的标签和非公开目标的外发守护（G1）用它；第一段照旧按自己的方式读规范。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @returns {{kind: 'soft'|'strict', quote: string|null, by: number|null, deny: number[]}|null}
 */
export function explicitLimit(core, ref) {
  NRM.assertRef(ref);
  const memo = new Map();
  const g = ref.kind === 'percept' ? GL.glancesOf(core, [ref.id]).get(ref.id) ?? null : null;
  return NRM.explicitLimit(core, ref, g, memo);
}

/**
 * 主人解除一条叮嘱（D113，管理页「她在守的叮嘱」）：规范按有权限的放宽（restriction none、清掉名单），第一眼核对过的限制一并清掉。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {{at: number, speakerEntityId?: number|null}} ctx
 * @returns {{applied: boolean}}
 */
export function relaxLimit(core, ref, ctx) { return NRM.relaxLimit(core, ref, ctx ?? {}); }

/**
 * 写场合规矩的新版本（来源：适配器的 norms.notes、群里学到的、主人写的）。比较前后的结论：变松的部分，来源没有权限就丢弃或进审核队列。
 * 当场生效，不等夜里（评审:UV-09）；相关缓存失效。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{text: string, restriction?: 'none'|'soft'|'strict', scope?: object}} rule
 * @param {{source: 'adapter-notes'|'learned'|'owner', authorEntityId: number|null, authority: 'none'|'moderator'|'principal'|'config', at: number}} ctx
 * @returns {{version: number, status: 'active'|'pending'|'rejected'}}
 */
export function writeSettingRule(core, settingKey, rule, ctx) { return NRM.writeSettingRule(core, settingKey, rule, ctx); }

/**
 * 【补】主人对一条还在等审核的场合规矩（setting_rule_relax 审核项的 {settingKey, version}）的决定（admin.decideReview 调用）：
 * 批准 → 按那一版的内容和原作者写一版主人认可的（authority='principal'，当场生效），那一版标成被取代；
 * 驳回 → 那一版标 rejected（同一个人以同样的权限再提同一条不再排队）。那一版已经不在等审核时什么都不做（'not-pending'）。
 * 在调用方的事务里调用也可以（同步）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {number} version
 * @param {boolean} approve
 * @param {{at?: number}} [ctx]
 * @returns {{version: number|null, status: 'active'|'rejected'|'not-pending'}}
 */
export function decideSettingRule(core, settingKey, version, approve, ctx) { return NRM.decideSettingRule(core, settingKey, version, !!approve, ctx); }

/**
 * 【补】来源撤下了的场合规矩（适配器描述里那条 norms.notes 没了；intake.describe 调用）：只撤 source='adapter-notes'、
 * 文字对得上的；作者是主人或配置的不撤（主人写的只由主人撤）。生效中的记下撤下时间：之后才知道的内容不再受它约束，
 * 撤下之前知道的照旧（当时就是在这条规矩下听到的），所以撤下不会让任何已经知道的事变松；还在等审核的那一版作废。
 * q.texts = 撤下这几条；q.keep = 来源现在的完整清单，清单里没有的都撤下（intake 用这个：不依赖上一次描述里有什么）。
 * 同步，可以在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{source: 'adapter-notes', texts?: string[], keep?: string[]}} q
 * @param {{at?: number}} [ctx]
 * @returns {number} 撤下了几条
 */
export function withdrawSettingRules(core, settingKey, q, ctx) { return NRM.withdrawSettingRules(core, settingKey, q, ctx ?? {}); }

/**
 * 场合当前生效的规矩（MAX(version) 的 active 链）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {{version: number, rules: {text: string, restriction: string, author: number|null, authority: string}[]}}
 */
export function settingRules(core, settingKey) { return NRM.settingRules(core, settingKey); }

// ── 关口① ────────────────────────────────────────────────────────────────

/**
 * 第一段（§9.3.2，同步、纯代码）：**先查底线**（B1 明确限制、B2 公开场合涉及别人、B3 身份对应、B4 主人的披露规则、
 * B5 一对一面对陌生人的敏感信息；对管理者的 T1 / T2 知情底线，§9.3.7），底线命中的任何放行都推翻不了；
 * 再看放行（A1 已知圈覆盖 / 同场合当众说的且范围没变大、A2 只涉及她自己或非个人、A3 本来就公开且不涉及别人）。
 * 心里想的、推断的、私下读到的永远不经 A1；unassessed 只能经 A1；其余交给第二段。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {import('../core-types.js').DisclosureTarget} target
 * @returns {import('../core-types.js').Stage1Decision}
 */
export function stage1(core, ref, target) { NRM.assertRef(ref); return S1.stage1Public(core, ref, target); }

/**
 * 【补】别的场合的名字能不能对这个目标说出来（§5.8 场合也是实体、§9.3.6 所有记忆文字都过关口①）：渲染来源说法
 * （「在 X 群里听阿明说的」）时用。那个场合的档案卡在目标上过了第一段（pass）才算能说；一对一场合的档案卡涉及对方
 * （它的名字就是「她私下和谁聊」），出了那个一对一通常放不过去。没有档案卡的场合（一次性的）按公开程度：不是一对一就能说。
 * 目标场合本身永远能说（渲染成「在这里」）。不认识的场合、判不了：false（fail closed）。同步，不调 LLM。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {import('../core-types.js').DisclosureTarget} target
 * @returns {boolean}
 */
export function placeAllowed(core, settingKey, target) {
  if (typeof settingKey !== 'string' || !settingKey || !target) return false;
  if (settingKey === target.audience?.settingKey && !target.batchTargets?.length) return true;
  try {
    const s = core.store.get(`SELECT s.entity_id, ss.exposure_rank FROM settings s LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id
      WHERE s.key = ?`, settingKey);
    if (!s) return false;
    const ent = s.entity_id ?? core.store.get('SELECT id FROM entities WHERE setting_key = ?', settingKey)?.id ?? null;
    if (Number.isSafeInteger(ent) && ent > 0) return S1.stage1Public(core, { kind: 'entity', id: ent }, target).decision === 'pass';
    return Number(s.exposure_rank) > 0;
  } catch { return false; }
}

/**
 * 第二段（§9.3.3）：这一轮所有待定的条目（≤ 8 条）放进一次 LLM 调用（use='appraise'，和说话的模型分开），
 * 每条一张信息流卡片；输出四选一（share / share_vague 带含糊版本 / aware_private 带能不能暗示 / omit）+ 一句理由。
 * 先查缓存（appraisals.cache_key，键见 §9.3.3），结果写回缓存。预算不允许或 LLM 失败 → 待定条目不给内容（第一段放行的照常给）。
 * 每个场合每小时 discretion.stage2.perSettingPerHour 次上限。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef[]} refs
 * @param {import('../core-types.js').DisclosureTarget} target
 * @param {{signal?: AbortSignal, deadlineMs: number}} opt
 * @returns {Promise<Map<string, {verdict: 'share'|'share_vague'|'aware_private'|'omit', vagueText?: string, hintOk?: boolean, appraisalId: number}>>}
 */
export async function stage2(core, refs, target, opt) {
  if (core.readOnly) return new Map();   // 只读库写不了判定记录：什么都不判（调用方据此不给内容）
  return G.stage2(core, refs, target, opt);
}

/**
 * 关口①的总入口（context 调用）。D113 起两条路：
 *   - 公开目标、受众读不到、说出去就收不回（preSendGate=false）而听的不只是管理者：每条先 stage1，需要的进 stage2；按 §9.3.5 的时机：
 *     不自主回想到 deadline 还没判完的不给，有意回想先给一行不含内容的 pending 提示；preSendGate=false 收紧（§9.3.4）；带污点的轮里
 *     N 不为空的条目不给「能说」（§9.6）；
 *   - 其余目标只跑第一段：block、sensitive-other（给第三方的敏感私事）、named-deny（叮嘱里点名的人可能在场）不进，其余 verdict share、
 *     原文进来（判定行 reason 'stage1:<rule>:open'），不调第二段。
 * 每条结论（含第一段放行）都写一行 appraisals，返回的 appraisalRef 指向它（§9.3.6）。想起来了但没说（aware_private / omit / pending）记 discretion_log。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').ScoredCandidate[]} candidates
 * @param {import('../core-types.js').DisclosureTarget} target
 * @param {{mode: 'involuntary'|'deliberate', deadlineMs: number, signal?: AbortSignal}} opt
 * @returns {Promise<import('../core-types.js').GatedItem[]>}
 */
export async function gate(core, candidates, target, opt) {
  // 只读库：每条结论都要能对上一行判定记录（§9.3.6），写不了就一条都不给（fail closed）
  if (core.readOnly) return [];
  return G.gate(core, candidates, target, opt);
}

/**
 * 【补】工作记忆的准入（§8.10、§9.2，D100 / D106 / D113）：只跑第一段（同步、零 LLM、不调第二段、不等第一眼）。「知道 ≠ 说」：眼前这个人
 * 跟她说的话、她回他的话，感知一落库就在她心里；D113 起知道的事带着来源标签进来，说不说、说多少由她回话时自己看着标签判断。
 *   - 整批不进：没有触发者、目标 publicLike、preSendGate:false 而对方不是管理者、批量提示词（excluded，照旧走普通回想）；
 *   - 逐条不进：第一段 block（隐藏 / 忘掉、撤回、missing / error、B1 strict 和叮嘱里被点名的人在场、B3、B4 block、B5），以及给第三方的
 *     敏感私事（sensitive-other）。B1 豁免（D106）原样：触发者自己的一句（A4）、要她做点什么、限制是他自己的话定的、这里没有被点名
 *     不许知道的人 → 带着叮嘱放进来；
 *   - 其余一律放进来（B1 soft / relation、B4 封顶、还没评估、她自己的猜测……），每项带 label：origin（one-on-one / group / self / material）、
 *     place、at、tellerId、limit（只来自 explicitLimit：核对过原话的叮嘱 {kind, quote, by}）、ownerVague（主人定过最多说个大概）、
 *     mentions（讲到的别的人的实体 id）、selfOnly（'guess' / 'read'）、hearsay（听谁说的）、open（他托她、还没办的）。
 * 每一项另带 glance（done / pending / failed / none）、restricted（有叮嘱）、quote、tellerId、replaces（第一眼核对过的「改掉了哪一条」）。
 * 每条放进来的对得上一行 appraisals（stage 1、verdict share；reason 'working:<rule>:<origin>[:l]'，同样的情形沿用上一行），
 * 返回的 appraisalRef 指向它（§9.3.6）；被挡下的记 discretion_log（reason 'wm-excluded:<rule>'；同一条同一个原因每个会话只记一次）。
 * 还 pending 而这个进程里没有在看的第一眼顺手重新排上。只读库：什么都不放（写不了判定记录）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{ref: string, topicSim?: number, open?: boolean}[]} refs
 * @param {import('../core-types.js').DisclosureTarget} target
 * @returns {{items: import('../core-types.js').GatedItem[], excluded: {ref: string, rule: string, unassessed?: boolean}[]}}
 */
export function admitWorking(core, refs, target) {
  if (core.readOnly) return { items: [], excluded: (refs ?? []).map((r) => ({ ref: r?.ref, rule: 'read-only' })) };
  return WK.admitWorking(core, refs, target);
}

/**
 * 感知提交以后（intake 提交后通知，和 retrieve.onPercepts 并列）：合格的感知排进第一眼的队列（D106）。合格全看代码看得到的事实——
 * 不是回填的、是话（说的、做的、她说的）、不是材料、不是只有她看到的、有字；而且是一对一里的、对她说的 / 提到她的、她刚回过的人说的，
 * 或者她自己回那样一句的话。按场合排队，没有定时器：这个场合没有在看就马上看，在看的话下一次把排着的一起看；全局最多
 * discretion.glance.concurrency 个，一对一和对她说的先看；use='glance'，预算 meta.reserved。第一眼只让分寸更准，从不决定她知不知道。
 * 不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {object[]} rows  percepts 的整行（按 id）
 */
export function onPercepts(core, settingKey, rows) { GL.onPercepts(core, settingKey, rows); }

/**
 * 几条感知的第一眼（同步读，零 LLM；关口②、context 渲染用）。没看过的不在返回里。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 * @returns {Map<number, {state: 'pending'|'done'|'failed', sens: number|null, limit: string|null, quote: string|null, quoteOk: boolean,
 *   about: string|null, asks: boolean, mixed: boolean, gist: string|null, vague: string|null, replaces: number|null, follows: number|null,
 *   applies: number[], version: number}>}  follows：照着他前面定好的哪一句做（glance-2，D110）；version：提示词 glance-几（旧行 1）
 */
export function glancesOf(core, perceptIds) { return GL.glancesOf(core, perceptIds); }

/**
 * 被后来的一句改掉了的（D110，只读，走迁移 014 的索引）。ids 是感知 id 时：感知 id → 改掉它的那一句的感知 id；
 * 是记忆引用时（感知、断言、情节）：引用 → 改掉了它的某一条来源感知的那一句（context 给普通回想的条目标「（后来换了新的）」）。
 * 没被改过的不在返回里。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {(number|string)[]} ids
 * @returns {Map<number|string, number>}
 */
export function supersededBy(core, ids) {
  const out = new Map();
  try {
    const nums = (ids ?? []).filter((x) => Number.isSafeInteger(x));
    for (const [k, v] of GL.supersededBy(core, nums)) out.set(k, v);
    const memo = new Map();
    const srcOf = new Map();
    for (const r of (ids ?? []).filter((x) => typeof x === 'string')) {
      const m = parseRef(r);
      if (!m || !['percept', 'assertion', 'episode'].includes(m.kind)) continue;
      srcOf.set(r, FA.memoryFacts(core, m, memo)?.perceptIds ?? []);
    }
    if (srcOf.size) {
      const by = GL.supersededBy(core, [...new Set([...srcOf.values()].flat())]);
      // 改掉它的那一句本身就是这条记忆的来源、或者不比它所有的来源都新：这条记忆已经带上了新的说法，不标「后来换了新的」（评审）
      for (const [r, ps] of srcOf) {
        const own = new Set(ps);
        const newest = Math.max(0, ...ps.filter((x) => Number.isSafeInteger(x)));
        const hit = ps.map((p) => by.get(p)).filter((x) => x != null && !own.has(x) && x > newest).sort((a, b) => b - a)[0];
        if (hit != null) out.set(r, hit);
      }
    }
  } catch (e) { soft(core, 'discretion.supersededBy', () => { throw e; }, null); }
  return out;
}

/**
 * 这一条是不是她回这一轮的触发者的话（D110 C7，和工作记忆 A5 同一个口径）：她说的一句；同一场合紧挨着的上一条不是她的感知、是触发者
 * （或权利层确认的同一个人）说的；涉及的人只有他和她；扫名字是干净的；不是她自己的猜测、私下读到的。关口①第一段据此不按「别人问起」
 * 封顶（和 toldByTrigger 一样）；问的人不是他时照旧封顶。同步、零 LLM、不抛错（判不了 false）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} ref
 * @param {number|null} triggerEntityId
 * @returns {boolean}
 */
export function repliedToTrigger(core, ref, triggerEntityId) {
  try {
    const m = parseRef(ref);
    if (!m || m.kind !== 'percept') return false;
    const memo = new Map();
    return FA.repliedToTrigger(core, FA.memoryFacts(core, m, memo), triggerEntityId, memo);
  } catch { return false; }
}

/**
 * 等到这一刻起没有在看、也没有排着的第一眼（测试、复现脚本用；聊天路径从不等它）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<void>}
 */
export function glancesIdle(core) { return GL.whenIdle(core); }

/**
 * 一句对她说的话去掉「叫她」的那一处 @ 以后的文字（工作记忆扫名字、retrieve 算话题相似度用）：只去掉 @ 后面紧跟的、确定是在叫她的
 * 那个名字（她自己的名字、提及里认成她的那个名字；整句只有一处 @ 而这句话是在叫她时，提及里记下的那个名字），别的字一个不动。
 * 不是对她说的、没有 @ 的原样返回。零 LLM、不用词表。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{id?: number, text?: string|null, addressed?: string, mentions_json?: string|null}} percept  感知行（没带 mentions_json 就按 id 读）
 * @returns {string}
 */
export function withoutAddress(core, percept) {
  return WK.withoutAddress(core, percept, new Map());
}

/**
 * 组装关口①的目标（context 调用）：audienceOf(目标场合) + 触发者 + 按轮污点 + 批量目标的并集。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, homeSettingKey: string, sessionId: string|null, triggerEntityId: number|null,
 *          mode: 'involuntary'|'deliberate', egress?: import('../contract/types.js').ExpressionChannel[], at: number}} p
 * @returns {import('../core-types.js').DisclosureTarget}
 */
export function targetFor(core, p) { return G.targetFor(core, p); }

// ── 关口② ────────────────────────────────────────────────────────────────

/**
 * 外发审视（§9.4，D113 起两条路）：
 *   - 目标是公开的（publicLike）：代码初筛（话里的实体、区分性词、整句向量，对比会话的污点账本、关于这些实体的窄来源记忆、核心自我）
 *     → 一定送审的情况（跨圈子且账本里有对目标不能说的、公开场合提到具体的人、recurring-context / 延时、带污点的轮）→ 独立审视
 *     （use='review'，预留预算）→ speak / reconsider（带她的一句转念）/ hold（canHold 的场合；原文只存 utterances.held_text）。
 *     审不了：能挂起就挂起，不能就 reconsider（「这次先不说了」）；同一句话被拒两次 → 最终拒绝；公开底线、上线头 14 天全挂不变。
 *   - 其余目标（同一场合、别的群、私聊、定时提醒、跨场合发送、读不到的目标）：两条外发守护（guardUtterance），只认「几乎原样」的复述——
 *     G1 核对过原话的叮嘱、G2 一对一里另一个人私下说的话，被回答的不是那个人、目标受众原来不知道；命中只挡这一句，reflection 是一句
 *     事实（「这句没发：里面几乎是X叮嘱过别外传的原话。这件不说，别的照常说。」），不要求她换个说法；没有送审、没有最终拒绝。
 *     任何异常、超时都放行（fail open，reasons ['fail-open']）。
 * origin.path='owner-approved' 且令牌、文本哈希和挂起记录一致 → 直接 speak，不再重审（§9.4.4）。
 * 对话所在场合和目标场合的记忆都被主人关掉（admin.modeFor = off）、这个会话本周期也没有注入过记忆（context.taintLedger 为空）时，
 * 照常计算并记录（reasons 里记 off:<结论>），但一律返回 speak。
 * 这一轮带按轮污点（§9.6）时，这次的 utterances 行不管结论如何都带 TURN_TAINT_MARK（成长不拿它当依据，§5.7）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').Utterance} u
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('../contract/types.js').Appraisal>}
 */
export async function appraise(core, u, signal) {
  if (core.readOnly) return { verdict: 'speak', token: 'read-only' };   // D21：只读时什么都没注入，污点账本为空
  return EG.appraise(core, u, signal);
}

/**
 * outcome()：发出 / 失败 / 挂起 / 隐藏。sent 且这个渠道不回流（适配器不会再交一条 self-utterance）时，
 * 调 intake.observeInternal 生成她说过的那条感知（§5.6、评审:SC-12）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} token
 * @param {'sent'|'failed'|'held'|'hidden'} result
 * @param {{textHash?: string, text?: string, returns?: boolean}} [meta]   text：不回流渠道生成感知用；returns=true 表示适配器会回流
 */
export function outcome(core, token, result, meta) { EG.outcome(core, token, result, meta); }

/**
 * 挂起的发言被主人在管理页批准或驳回（admin.decideReview 调用）：批准 → adapter.onHoldDecision(token, true)，适配器带着令牌以
 * owner-approved 发出；驳回或过期 → onHoldDecision(token, false)。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} token
 * @param {boolean} approve
 * @returns {Promise<void>}
 */
export async function holdDecision(core, token, approve) { return EG.holdDecision(core, token, approve); }

// ── 关口③ ────────────────────────────────────────────────────────────────

/**
 * 她自己的发言感知回流之后（intake 提交后通知；kind self-utterance / on-my-behalf）：
 *   - 按审视令牌，或（场合、文本哈希、时间窗）对上 utterances；对不上 → 「未经审视的发言」，记 discretion_log 并按场合属性回头补评估；
 *   - 和这个会话本周期已确认送达的注入条目、最近几轮的工具结果比对（区分性词 + 向量），命中的写 told_log 和 known_by(told_by_her)，
 *     并给「讲给新听众」的记忆加痕迹（dynamics.addTrace reason='retell'，每个听众一次）；
 *   - 比对不上但有区分性词的，排一个全库比对任务；
 *   - 回填的旧发言（historical=1）不算未经审视、不补评估，也不和眼下会话的注入比对（只排全库比对）；
 *   - 没对上审视记录、又是在带按轮污点的一轮里说的：记一行 utterances（origin_path='unappraised'，带 TURN_TAINT_MARK）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../intake/index.js').PerceptRow} percept
 */
export function onSelfUtterance(core, percept) { T.onSelfUtterance(core, percept); }

/**
 * 到期清理判定记录（D139，admin.expireLogs 在夜里调，在注入日志清完之后）：早于 before 的分批删掉，除了还留着的注入行引用的、
 * 第二段缓存还没过期的。工作记忆只沿用比保留期新的判定，删不到它要沿用的。可以中断，下次接着删。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{before: number, batch?: number, maxBatches?: number, signal?: AbortSignal}} opt
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireAppraisals(core, opt) { return EX.expireAppraisals(core, opt); }

/**
 * 到期清理她说过的话的审视记录（D139）：早于 before 的分批删掉，除了还在等主人处理的挂起草稿、批准了还没发出去的、
 * 带按轮污点标记的（成长不拿那句话当依据的唯一记录）。可以中断，下次接着删。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{before: number, batch?: number, maxBatches?: number, signal?: AbortSignal}} opt
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireUtterances(core, opt) { return EX.expireUtterances(core, opt); }

/**
 * 记一笔分寸日志。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'aware_private'|'omit'|'pending'|'reconsider'|'hold'|'unappraised', settingKey?: string|null, ref?: string|null,
 *          appraisalId?: number|null, utteranceId?: number|null, triggerEntityId?: number|null, subjectEntityId?: number|null, reason: string, at: number}} e
 */
export function logDecision(core, e) { T.logDecision(core, e); }
