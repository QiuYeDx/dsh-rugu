// encode 模块（§7.2–§7.5、§5.4、§5.5、§10.8 工具授权、§4.5 ingest）：情节切分、提炼、核验、污点检查、对账，
// 以及事实、情节、计划、意图的全部写入。
//   - 一次 LLM 调用（use='extract'），输出 JSONL，逐行宽进严出；说话人由程序编号，账号永远不发给 LLM。
//   - 核验只检查结构化字段之间是否自洽（§7.4 的 14 条，第 14 条「只记以后用得上的」是 D123），不用词表。
//   - 一批提炼的全部输出在一个事务里写入（store.completeJob，§12.8 第 3 条）。
//   - 计划和事件每一次是独立的一次（occurrence_key），永远不走「重复」快速路径（评审:SC-01）。
// 拥有的表：episodes、episodes_fts、assertions、assertions_fts、assertion_entities、same_type、sources、
//   plan_status_history、predicates、intentions、speaker_quota、extract_stalled（D136）。
// 用到的端口：llm（extract、sleep）、budget、clock、logger；嵌入经 worker，语言经 lang。
// 契约细节：docs/实现/模块与接口.md §4.4。实现分在同目录的几个文件里：segment（切分）、prompt / parse / verify / taint /
// reconcile / extract（提炼的各步）、write（情节、事实、来源的写入）、plans（计划和意图）、review（夜间复核）、tools（note、fix、导入）、
// lessons（她自己的经验，D124）、stalled（提炼一直不成的段，D136）。
import * as seg from './segment.js';
import * as ext from './extract.js';
import * as pr from './prompt.js';
import * as ps from './parse.js';
import * as vf from './verify.js';
import * as tc from './taint.js';
import * as rc from './reconcile.js';
import * as rv from './review.js';
import * as wr from './write.js';
import * as pl from './plans.js';
import * as tl from './tools.js';
import * as ls from './lessons.js';
import * as st from './stalled.js';

/**
 * 一个待提炼的段（切分的产物）。
 * @typedef {object} Segment
 * @property {string} settingKey
 * @property {number[]} perceptIds       按 id 升序
 * @property {boolean} boundaryCertain   便宜信号已经确定是边界；否则让 LLM 在同一次调用里判断（置信度 > 0.7 才封口）
 * @property {boolean} historical
 */
/**
 * 解析出的 JSONL 行（type 之外的字段照 §7.3 的输出表）。
 * @typedef {{type: 'header'|'narrative'|'ent'|'fact'|'plan'|'plan_status'|'intent'|'rel'|'norm_update'|'self'|'emotion'|'confirm'|'future_q'|'boundary', [k: string]: unknown}} ExtractLine
 */
/**
 * 写一条情节（writeEpisode）。来源、规范、谁知道、嵌入、痕迹都在同一次调用里写好。
 * @typedef {object} EpisodeInput
 * @property {string} settingKey
 * @property {'event'|'summary'|'diary'|'lapse'|'import'} kind
 * @property {string} title
 * @property {string} narrative
 * @property {string} header
 * @property {string|null} [headerVer]
 * @property {number} tStart
 * @property {number} tEnd
 * @property {number[]} participants
 * @property {number|null} [snapshotId]
 * @property {{valence: number, intensity: number, text?: string}|null} [emotion]
 * @property {SourceInput[]} sources
 * @property {import('../core-types.js').NormInput} norm
 * @property {number} w                  编码强度（dynamics.encodingWeight）
 * @property {number|null} [jobId]
 * @property {string|null} [extractVer]
 * @property {string|null} [model]
 * @property {number[]} [extraEntities]  【补】参与者以外、这段经历里提到的实体（只用来算 involves_others）
 * @property {boolean} [noKnowledge]     【补】不写「谁知道」（她自己的「没顾上」这类只有她知道的情节）
 */
/**
 * @typedef {object} SourceInput
 * @property {number|null} perceptId
 * @property {number|null} [snapshotId]
 * @property {string|null} [perceivedIn]
 * @property {number|null} speaker
 * @property {number|null} asserter
 * @property {'told_to_her'|'overheard'|'read'|'observed'|'relayed'|'inferred'|'self_generated'|'imported'} mode
 * @property {number} hop
 * @property {string|null} [quote]
 * @property {number} confidence
 * @property {string[]} [usedBg]
 * @property {number} at
 */
/**
 * 写一条事实（writeAssertion）。subjects 和 speaker 分开（§5.1）。
 * @typedef {object} AssertionInput
 * @property {number[]} subjects
 * @property {number|null} [objectEntityId]
 * @property {number[]} [mentions]
 * @property {string} predicate
 * @property {string|null} [value]
 * @property {string} text
 * @property {string} kindHint
 * @property {object|null} [recurrence]
 * @property {string|null} [occurrenceKey]
 * @property {'stated'|'confirmed'|'self_said'|'hearsay'|'inferred'} certainty
 * @property {number} confidence
 * @property {number} imp
 * @property {{start?: number, end?: number, precision?: string}|null} [eventTime]
 * @property {object|null} [plannedTime]
 * @property {number|null} [validFrom]
 * @property {number|null} [validToKnown]
 * @property {{t50h: number, shape: number}|null} [survival]
 * @property {{agent: number, status: string}|null} [plan]
 * @property {boolean} [pinned]
 * @property {string[]} [futureQ]        ≤ 3 条，作为额外的检索文本块（embed_texts kind='fq'）
 * @property {SourceInput[]} sources
 * @property {import('../core-types.js').NormInput} norm
 * @property {number} w
 * @property {number|null} [jobId]
 * @property {string|null} [extractVer]
 * @property {string|null} [model]
 * @property {boolean} [needsReview]
 * @property {boolean} [needsReconcile]
 * @property {'one'|'many'|null} [cardinality]   【补】新属性键的基数（模型给的；不给按 kind_hint 推）
 * @property {boolean} [isCurrent]               【补】新属性键是不是「当前状态」类
 * @property {string} [predicateCreatedBy]       【补】新属性键是谁提出的（extractor / import / owner）
 * @property {boolean} [noTrace]                 【补】不加痕迹（新版本的激活靠 supersede 继承）
 */
/**
 * 意图提议（提炼的 intent 行，或 note/fix、夜间整理、核实请求）。
 * @typedef {object} IntentionProposal
 * @property {{kind: string, id: number}|null} about
 * @property {number} targetEntityId
 * @property {string} act
 * @property {string} text
 * @property {'self-care'|'self-commitment'|'principal-request'} origin
 * @property {{timeWindow?: {start: number, end: number}, cues?: object[]}} trigger
 * @property {number[]} evidencePerceptIds
 */

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.encode = { lastCallAt: 0, selfId: null, predicates: null };
  core.jobHandlers.set(seg.EXTRACT_KIND, (c, job, opt) => ext.runExtract(c, job, opt));
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) { /* 无资源 */ }

// ── 切分和提炼 ────────────────────────────────────────────────────────────

/**
 * 扫各场合的切分缓冲（store.SEGMENT_BUFFER_SQL，§12.8 第 2 条），按便宜信号找可能的边界（间隔 ≥ 20 分钟、
 * 原文窗口向量的话题漂移、参与者大换、满 25 条或 4000 字），给每个段排一个 kind='extract' 的任务
 * （dedupe_key 含场合和感知 id 范围；优先级只按 w_att × w_rel × 新鲜度，§7.2）。force=true 时把全部缓冲封口（夜间整理第 1 步）。
 * 【D136】提炼一直不成的段（extract_stalled）切段时跳过、当作确定的边界；到点的按原来的范围各排一个重试任务（一轮一次）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey?: string, force?: boolean, at?: number}} [opt]
 * @returns {{jobs: number}}
 */
export function segment(core, opt) { return seg.segment(core, opt); }

/**
 * 【D136】提炼一直不成、搁置着的段（管理页诊断，只有数字）：几段、一时的 / 稳定被拒的各几段、最多失败了几轮、
 * 最早的从什么时候起、下一次什么时候再试。【D141】最近 7 天提炼的输出被上限截断了几次（truncated）、为此拆了几次（splits）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{segments: number, transient: number, rejected: number, maxRounds: number, oldestAt: number|null, nextAt: number|null,
 *            truncated: number, splits: number}}
 */
export function stalledSummary(core) { return st.stalledSummary(core); }

/**
 * 跑一个提炼任务（maintenance.runJobs 调用，kind='extract'）：取背景（retrieve.backgroundForExtraction，分两组）→
 * 拼提示词（静态前缀在前）→ LLMPort.complete({use:'extract'}) → parseJsonl → verify → taintCheck → 实体解析 → 对账 →
 * 在 store.completeJob 的一个事务里写完全部输出。预算不允许（budget.allow=false）时不调 LLM，任务推迟。
 * 【D141】输出被 maxTokens 截断（端口的 stopReason='length'；没给停止原因时，最后一行不完整且输出量接近上限）：这一次什么都不写，
 * 这一段按消息数对半拆成两段各排一个任务（status 'split'）；一条消息还截断的，失败并搁置（TRUNCATED）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../store/jobs.js').JobRow} job
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{status: 'written'|'skipped'|'deferred'|'failed'|'split', reason?: string}>}
 */
export async function runExtract(core, job, opt) { return ext.runExtract(core, job, opt); }

/**
 * 拼提炼提示词（§7.3 的输入格式）。说话人按程序编号（[U1]），亲近的人只用关系描述标注；成员文字中和（[ → ［ 等）。
 * 【补】说话人卡片里带上适配器给的自我介绍（SelfIntroductionClaim 的原文，代码不解析）：那条消息在本段就标它的编号，
 * 在库里但不在本段就不给（它自己那段看得到原话），库里没有的只在他还没记过自称时给；只本人自称的关系标「自称是」（§5.2）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {Segment} seg
 * @param {{known: object[], private: object[], candidates: object[]}} background
 * @returns {{system: string, messages: {role: 'user', content: string}[], speakers: Map<string, number|null>, msgRefs: Map<string, number>, promptVer: string}}
 */
export function buildExtractPrompt(core, seg, background) { return pr.buildExtractPrompt(core, seg, background); }

/**
 * JSONL 宽进严出：逐行 JSON.parse，坏行跳过并计数；不认识的 type 丢掉。纯函数。
 * @param {string} text
 * @returns {{lines: ExtractLine[], errors: number}}
 */
export function parseJsonl(text) { return ps.parseJsonl(text); }

/**
 * 核验（§7.4 的 14 条，纯代码；第 14 条 D123：没挂着别的行的一时的状态 / 事件不成事实，她自己说的关于自己的断言封顶把握）：msgRefs 属于本段、quote 是原文子串、evidential:false / 引用 / 转发不当证据、
 * 本人说 vs 听说、关于她自己、非人物实体、时间自洽、self 只来自她的行、confirm 不能是她自己、
 * 指令类内容不成为规则或意图（只记「U3 提过一个要求，没采纳」并报 T1 给 admin.notifyNeedToKnow）、
 * norm_update 放宽要权限、配额、intent 的 origin 和证据一致、ent 的锚点必须出现过、复述不新建。
 * 【补】ent 行的 "is"（这一行就是在场的某个说话人：自我介绍、锚点当面指认）只认本段的说话人编号（不能是她自己），
 * 交给 entities 时是 ExtractedEntity.speaker；之后各行里这个 ent 的编号一律当成那个说话人的编号。individual 只留布尔值。
 * @param {import('../core-types.js').CoreContext} core
 * @param {ExtractLine[]} lines
 * @param {{seg: Segment, percepts: object[], speakers: Map<string, number|null>, msgRefs: Map<string, number>}} ctx
 * @returns {{accepted: ExtractLine[], dropped: {line: ExtractLine, rule: number, reason: string}[], rewritten: number}}
 */
export function verify(core, lines, ctx) { return vf.verify(core, lines, ctx); }

/**
 * 污点检查（§7.3，纯代码）：第二组背景（只供理解的）里的区分性词（lang.distinctiveTerms）出现在 header / narrative 里就去掉那一句；
 * 出现在某条 fact 里却没记进 used_bg 的，补记进去，这条事实的规范取最严。不靠模型自报。
 * @param {import('../core-types.js').CoreContext} core
 * @param {ExtractLine[]} lines
 * @param {{text: string, ref: string}[]} privateBackground
 * @returns {ExtractLine[]}
 */
export function taintCheck(core, lines, privateBackground) { return tc.taintCheck(core, lines, privateBackground); }

/**
 * 对账（§7.5、§5.4 的更新规则）：重复候选只在同主体同属性里找（计划和事件还要同 occurrence_key），矛盾候选在主体相关范围找，
 * BM25 + 向量 RRF 混合，不设门槛。快速路径：同主体、同属性、规范化后文本相同 → dup（计划和事件永远不走）。
 * 中间地带返回 'new' 并要求标 needsReconcile。
 * @param {import('../core-types.js').CoreContext} core
 * @param {AssertionInput & {op?: string}} fact
 * @param {{at: number, signal?: AbortSignal}} ctx
 * @returns {Promise<{op: 'new'|'dup'|'contradict'|'changed'|'occurrence'|'late', targetId?: number, needsReconcile?: boolean}>}
 */
export async function reconcile(core, fact, ctx) { return rc.reconcile(core, fact, ctx); }

/**
 * 夜间整理第 1 步的复核：标了 needs_review / needs_reconcile 的事实，批量用一次 LLM（use='sleep'）再看一次。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{limit?: number, signal?: AbortSignal}} [opt]
 * @returns {Promise<{reviewed: number, llmCalls: number}>}
 */
export async function reviewFlagged(core, opt) { return rv.reviewFlagged(core, opt); }

// ── 写入（别的模块要写情节、事实、意图都调这里；都必须在调用方的事务里，同步） ──────────

/**
 * 写一条情节：episodes + episodes_fts（lang.indexTokens(header + narrative)）+ sources + 规范（discretion.writeNorm）+
 * 谁知道（discretion.recordKnowledge，按来源的 visible_to 和出现集合）+ 痕迹（dynamics.addTrace）+ 嵌入文本
 * （worker.enqueueEmbed：上下文头 + 叙述，超过 400 字按 200–400 字切块）。场合名不进嵌入文本（§7.2）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {EpisodeInput} ep
 * @returns {number}
 */
export function writeEpisode(core, ep) { return wr.writeEpisode(core, ep); }

/**
 * 写一条事实（同上：主表、FTS、assertion_entities、sources、规范、谁知道、痕迹、嵌入文本含 future_q 块）。
 * involves_others 由代码从 subjects / object / mentions 和来源说话人算（entities.isIndividual），不信模型（评审:PS-19）。
 * 听说的 confidence 不超过 activation.hearsayConfidenceCap，但编码强度 w 不打折（评审:UV-01）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {AssertionInput} a
 * @returns {number}
 */
export function writeAssertion(core, a) { return wr.writeAssertion(core, a); }

/**
 * 给已有的记忆追加一个来源（对账判为重复时；不改写旧来源）。顺带加一条「又遇到了一次」的痕迹。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'episode'|'assertion', id: number}} owner
 * @param {SourceInput} source
 * @param {{w: number, reason: string}} trace
 */
export function addSource(core, owner, source, trace) { wr.addSource(core, owner, source, trace); }

/**
 * 新事实取代旧事实（§5.4 第 2 条）：旧的 valid_to_known = 新的 valid_from、expired_at = 现在、superseded_by；两条都保留。
 * 新版本至少继承旧版本的激活（dynamics.inheritActivation，§5.4 第 7 条）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} oldId
 * @param {number} newId
 * @param {{at: number}} ctx
 */
export function supersede(core, oldId, newId, ctx) { wr.supersede(core, oldId, newId, ctx); }

/**
 * 「变了但新值未知」（§5.4 第 3 条）：change_known=1，成立概率乘 validity.changeKnownFactor。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} assertionId
 * @param {{at: number, source: SourceInput}} ctx
 */
export function markChanged(core, assertionId, ctx) { wr.markChanged(core, assertionId, ctx); }

/**
 * 【D122】夜里对照原话纠错的结果写回（consolidate 夜间整理第 2 步、主人撤销改正时调用）。要动的那一版已经被取代了就不动，返回 null。
 * correct：写一条改正后的新版本（主体、种类、时间照旧；来源 = 引用的证据感知，说话人和方式按感知的结构算），旧的被它取代、两条都留着，
 * 规范照旧版本再经 discretion.inheritNorm（quote）；doubt / raise：把握降到 / 升到 confidence（新版本，来源照抄，修改写历史；只降 / 只升）；
 * changed：只标 change_known=1（不加来源、不加痕迹）；restore：照 from 那一版恢复成 confirmed 的新版本（主人撤销改正）。
 * 换版本时还开着的意图跟着指向新版本。extractVer 记出处（'consolidate-correction-v1#…'）。返回之后代表这件事的那条事实的 id。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} assertionId
 * @param {{op: 'correct'|'doubt'|'raise'|'changed'|'restore', text?: string, predicate?: string|null, certainty?: 'stated'|'self_said'|'hearsay', confidence?: number, evidence?: number[], from?: number, extractVer?: string|null, model?: string|null}} correction
 * @param {{at: number}} ctx
 * @returns {number|null}
 */
export function applyCorrection(core, assertionId, correction, ctx) { return wr.applyCorrection(core, assertionId, correction, ctx); }

/**
 * 计划状态变化（§5.5）：写 plan_status_history；done / cancelled / missed 时把指向它的意图转 obsolete（transitionIntention）并开始抑制。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} assertionId
 * @param {'planned'|'in_progress'|'done'|'cancelled'|'missed'|'unknown'} status
 * @param {{at: number, evidencePerceptId?: number|null, outcomeRef?: string|null, source?: object}} ctx
 */
export function transitionPlan(core, assertionId, status, ctx) { pl.transitionPlan(core, assertionId, status, ctx); }

/**
 * 形成意图（§5.5 第 1、2、10、11 条的代码部分）：origin 和证据一致（第三方请求没有她的答应 → 不形成）、
 * 每人每天 ≤ intention.maxPerPersonPerDay、historical 时不形成（第 13 条）。规范继承 about 和证据里最严的（discretion.inheritNorm）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {IntentionProposal} p
 * @param {{at: number, historical?: boolean, jobId?: number|null}} ctx
 * @returns {number|null}  null = 没形成
 */
export function formIntention(core, p, ctx) { return pl.formIntention(core, p, ctx); }

/**
 * 意图状态机：formed → armed → executed / cancelled / obsolete / lapsed。obsolete / cancelled 记 suppressed_at（短暂抑制）；
 * lapsed 时写一条低强度的 lapse 情节（「那阵子想问他考试的事，没顾上」）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} intentionId
 * @param {'armed'|'executed'|'cancelled'|'obsolete'|'lapsed'} state
 * @param {{at: number, reason?: string}} ctx
 */
export function transitionIntention(core, intentionId, state, ctx) { pl.transitionIntention(core, intentionId, state, ctx); }

/**
 * 记一次执行（以人为单位，§5.5 第 8 条）：之后对同一个人要等 intention.cooldownH 才再问，不管哪个场合。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} intentionId
 * @param {{at: number, settingKey: string, targetEntityId: number, utteranceRef?: string|null}} exec
 */
export function recordExecution(core, intentionId, exec) { pl.recordExecution(core, intentionId, exec); }

/**
 * 现在可能浮上来的意图（读）：armed、目标在场或话题线索命中、不在冷却期（主人要她做的事不受冷却限制）。给 context 的「你想着的」层用。
 * 没有硬到期（D103）：过了 window_end 的照样返回，行上带 overdue（≥ 0，intention.overdueWeight × log1p(超时 / 窗口长度)，
 * 调用方从激活里减掉）；排序：线索命中的在前，其次没超时的，再其次新形成的在前。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{presentEntityIds: number[], settingKey: string, at: number, cueEntityIds?: number[]}} q
 * @returns {object[]}  intentions 行（另带 ref、trigger、executions、cueHit、overdue）
 */
export function dueIntentions(core, q) { return pl.dueIntentions(core, q); }

/**
 * 一条意图过了时间窗多少（读，≥ 0）：intention.overdueWeight × log1p(超时 / 窗口长度)（窗口长度不知道时按 1 天算），没过时间窗是 0。
 * dueIntentions 的 overdue、工作记忆里 openBoost 的减分、时间维护「渐渐放下」都用这一个量（D103：没有硬到期，淡忘是渐进的）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{window_start?: number|null, window_end?: number|null}} row  intentions 行（至少带 window_start / window_end）
 * @param {number} at
 * @returns {number}
 */
export function intentionOverdue(core, row, at) { return pl.intentionOverdue(core, row, at); }

/**
 * 【补】把这几条感知的提炼提到队列最前（它们所在的那一段直接封口，马上就能被提炼）：工作记忆里还没评估的原话（speak = careful）
 * 由 context 在注入之后调，让提炼尽快替它们写好规范（D101）。已经提过的不重复提。返回新排进去的任务数。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 * @param {{at?: number}} [ctx]
 * @returns {number}
 */
export function prioritizeExtraction(core, perceptIds, ctx) { return seg.prioritizeExtraction(core, perceptIds, ctx ?? {}); }

/**
 * 触发前先复核（§5.5 第 6 条，评审:SC-08）：拿意图对象自意图形成以来的全部原始感知（不限场合，含还没提炼的），
 * 和 about 做词法加向量匹配；命中可能的完成证据就压住这个意图，并把这批感知的提炼任务提到最前。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} intentionId
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{suppress: boolean, perceptIds: number[]}>}
 */
export async function recheckIntention(core, intentionId, opt) { return pl.recheckIntention(core, intentionId, opt); }

/**
 * 【D134】一条意图要核对的文字（读）：意图本身、它指向的事（计划 / 事实 / 情节）、那条事实的 future_q。
 * 和触发前复核（recheckIntention）用的是同一份；关口③按内容认「她问过了」时拿它和她说的话比。意图不存在返回 []。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} intentionId
 * @returns {string[]}
 */
export function intentionTexts(core, intentionId) { return pl.intentionTexts(core, intentionId); }

/**
 * 属性键注册（§5.4：属性键是数据）。已有同义键时返回规范名。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} key
 * @param {{cardinality?: 'one'|'many', isCurrent?: boolean, createdBy: string}} info
 * @returns {string} 规范名
 */
export function ensurePredicate(core, key, info) { return wr.ensurePredicate(core, key, info); }

/**
 * 以这条感知为来源的记忆（读，sources.percept_id）。撤回、彻底删除的级联都靠它。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} perceptId
 * @returns {{ref: string, onlySource: boolean}[]}  onlySource：只靠它作证据
 */
export function derivedFrom(core, perceptId) { return wr.derivedFrom(core, perceptId); }

/**
 * 感知被撤回之后（intake 提交后通知）：派生记忆的规范收紧到至少 soft（discretion.tightenNorm），原话不再展示（sources.quote 置空）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} perceptId
 */
export function onPerceptRetracted(core, perceptId) { wr.onPerceptRetracted(core, perceptId); }

/**
 * 感知被编辑之后：依赖它的事实标 needs_review，夜里重新核验。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} oldPerceptId
 * @param {number} newPerceptId
 */
export function onPerceptEdited(core, oldPerceptId, newPerceptId) { wr.onPerceptEdited(core, oldPerceptId, newPerceptId); }

// ── 工具和导入（§10.8、§4.5） ──────────────────────────────────────────────

/**
 * memory_note：用 triggerObsId（和 triggerObsIds：这一轮她看到的、别人对她说的其他几条，D114）找到库里的感知（不信调用方的说法），
 * 取时间最新、evidenceQuote 是它的子串（规范化后比）的那条，再按那条的说话人判权限
 * （主人直接生效；其他人进审核队列 admin.enqueueReview），一条消息只执行一个操作。remember → 钉住的事实；todo → 意图。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').NoteRequest} req
 * @returns {Promise<import('../contract/types.js').NoteResult>}
 */
export async function note(core, req) { return tl.note(core, req); }

/**
 * memory_fix：forget → 主人：admin.suppress(forgotten) + 「别记」规则；身份经权利层确认的本人、关于自己的：立即对别人隐藏
 * （admin.suppress hidden）再进审核队列；其他人只进审核队列。correct → 新事实取代旧的；confirm → certainty='confirmed' + 痕迹 × 1.2。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').FixRequest} req
 * @returns {Promise<import('../contract/types.js').FixResult>}
 */
export async function fix(core, req) { return tl.fix(core, req); }

/**
 * ingest.import()：导入的记忆来源方式记 imported，**不加激活痕迹**（§4.5、§6.4）。subjects 是名字，按 entities 的名字表认人
 * （认不出就建 provisional）；norm 照 ImportRecord.norm 转成规范。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').ImportRecord[]} records
 * @param {{provenance: 'imported', source: string}} opt
 * @returns {Promise<import('../contract/types.js').ImportReport>}
 */
export async function importRecords(core, records, opt) { return tl.importRecords(core, records, opt); }

// ── 【补】额外的导出（不在 §4.4 的表里；别的模块需要时用） ────────────────────

/**
 * 审核队列里 owner_op（非主人发起的 note / correct / confirm）被主人批准之后执行：admin.decideReview 对 kind='owner_op'、
 * payload.tool ∈ {'note','fix'} 的项调用它。文字从库里那条感知取（不信当初的工具参数）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{tool: 'note'|'fix', op: string, perceptId: number, span?: [number, number]|null, ref?: string, about?: number|null, when?: {start: number, end: number}|null}} payload
 * @param {{by?: string, at?: number}} [ctx]
 * @returns {Promise<import('../contract/types.js').ToolResult>}
 */
export async function applyToolOp(core, payload, ctx) { return tl.applyToolOp(core, payload, ctx); }

/**
 * 一条计划的状态历史（读，按时间）：管理页「经历」、渲染「那天说要去，后来拿到了」。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} assertionId
 * @returns {{status: string, at: number, evidencePercept: number|null, source: object}[]}
 */
export function planHistory(core, assertionId) { return pl.planHistory(core, assertionId); }

/**
 * 同一类事的其他几次（same_type，读）：回想时「最近的一次排前，时间接近标可能指多次」（retrieve），管理页「同类的其他几次」（admin）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} assertionId
 * @returns {number[]}
 */
export function sameTypeOf(core, assertionId) { return wr.sameTypeOf(core, assertionId); }

// ── 她自己的经验（D124）：做事学到的规则 + 怎么知道它是对的 + 要避开的坑，标验证过 / 还没验证（存成 kind_hint='lesson' 的事实） ──

/**
 * memory_note 的「经验」：她自己的知识，不占「一条消息一个操作」、不进审核队列；验证过没有由代码按证据定（主人的原话、宿主看到的
 * 「先没成、换了做法以后成了」），见 lessons.js 开头。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{sessionId?: string, triggerObsId?: string, triggerObsIds?: string[], text: string, trap?: string, tool?: string, about?: string, here?: boolean, evidenceQuote?: string}} req
 * @returns {{status: 'done'|'rejected', reason?: string, refs?: string[], lessonStatus?: string, merged?: boolean, triggerObsId?: string}}
 */
export function noteLesson(core, req) { return ls.noteLesson(core, req); }

/**
 * 写一条经验，或并进说同一件事的那一条（同一个工具、同一个范围、意思差不多）；夜里回顾也用它。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object} input  见 lessons.js 的 writeLesson
 * @returns {{id: number, merged: boolean, upgraded: boolean}}
 */
export function writeLesson(core, input) { return ls.writeLesson(core, input); }

/**
 * 宿主交来一次工具调用的结果：记下没成的、换了做法后成了的（只有工具名、短的出错说明、时间、会话的哈希）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{sessionId?: string, tool: string, ok: boolean, error?: string, at?: number}} o
 * @returns {{recorded: boolean, recovered: boolean, lessons: number}}
 */
export function lessonToolOutcome(core, o) { return ls.toolOutcome(core, o); }

/**
 * 这一轮该想起的经验（按范围：正在用 / 刚用过的工具、人、场合、新会话第一轮时她有经验的工具；话题按 IDF 加权对上）。按分数排好；
 * scoped=false 的是只靠话题对上的。隐藏、忘掉的不给。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, people?: number[], tools?: string[], text?: string|null, focusPerceptId?: number|null, sessionId?: string|null, at?: number, max?: number, startOfCycle?: boolean}} q
 * @returns {Promise<{id: number, scoped: boolean}[]>}
 */
export async function lessonsFor(core, q) { return ls.lessonsFor(core, q); }

/**
 * 一句话撑不撑得住一条经验（夜里回顾核对「主人的纠正撑得住这条」，评审 H2）：规范化后是子串，或经验的词大部分在那句话里。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {string} message
 * @returns {boolean}
 */
export function lessonSupportedBy(core, text, message) { return tl.supportedBy(core, text, message); }

/**
 * 这条经验是不是主人做的（主人教的、确认过、纠正过、钉住的）：夜里回顾不合并它、不让还没验证的取代它（评审 M3）。
 * @param {object} row  assertions 的一行
 * @returns {boolean}
 */
export function lessonOwnerMade(row) { return ls.ownerMade(row); }

/**
 * 一条经验给她看的一行：「（验证过）用 X 时：……（要避开：……）〔来源〕」。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object|number} rowOrId
 * @param {{chars?: number, vague?: string|null, provenance?: string|null}} [opt]
 * @returns {string}
 */
export function lessonLine(core, rowOrId, opt) { return ls.lessonLine(core, rowOrId, opt); }

/**
 * 经验的结构化部分（状态、来源、工具、场合、坑、怎么知道的、是否带污点、放进常驻区的时间）。
 * @param {object} row  assertions 的一行
 */
export function lessonInfo(row) { return ls.lessonInfo(row); }

/**
 * 放进常驻区的经验（夜里定的）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {number[]}
 */
export function promotedLessons(core) { return ls.promotedLessons(core); }

/**
 * 夜里定哪些经验放进常驻区（纯代码）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} [at]
 * @returns {{promoted: number, demoted: number}}
 */
export function promoteLessons(core, at) { return ls.promoteLessons(core, at); }

/**
 * 主人确认一条经验（管理页）：验证过、确认过。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} id
 * @param {{at?: number}} [ctx]
 * @returns {{ok: boolean, reason?: string, ref?: string}}
 */
export function confirmLesson(core, id, ctx) { return ls.confirmLesson(core, id, ctx ?? {}); }

/**
 * 工具记录（没成的、换了做法后成了的；夜里回顾用）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{at: number, t: string, ok: 0|1, s?: string, e?: string, r?: 1}[]}
 */
export function lessonToolLog(core) { return ls.toolLog(core); }

/**
 * 经验的统计（管理页、评测）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{total: number, verified: number, promoted: number, toolLog: number}}
 */
export function lessonStats(core) { return ls.lessonStats(core); }

/**
 * 现在这一版的经验（没被取代、没失效、没隐藏忘掉），新的在前。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} [limit]
 * @returns {object[]} assertions 的行
 */
export function currentLessons(core, limit) { return ls.currentLessons(core, limit ?? 500); }

/**
 * 每条经验最近被想起（注入过）的天数：引用 → 天数。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} since
 * @returns {Map<string, number>}
 */
export function lessonUses(core, since) { return ls.lessonUses(core, since); }

/** 提炼任务的种类（jobs.kind）。 */
export const EXTRACT_JOB_KIND = seg.EXTRACT_KIND;
