// admin 模块（§4.5 AdminApi、§9.3.7「需要你知道」、§12.6 保留期、§12.7 遗忘和删除、§13.1 管理页的数据）：治理。
//   - 管理接口只给主人：鉴权由集成层负责（Fetch 路由 + principal.kind === 'owner'，§13.1），这里假定调用方就是主人，
//     但会记下 by（谁操作的）。
//   - 规则是数据不是代码：「别记」、主人的披露规则、按场合的开 / 关，目标是实体、信息类型或场合属性，不是入口名。
//   - 隐藏 / 忘掉统一记在 suppressions（所有记忆单元通用）；彻底删除按来源链级联，**先删向量再删主库**，写墓碑，中途崩溃可以安全重跑。
//   - 彻底删除和原文到期删除是唯一允许删除别的模块的表里的行的操作（级联规则见 docs/实现/模块与接口.md §2.3）。
//   - 保留期、成长方式、预算这类设置只能在管理页改（§9.6）；缩短保留期要确认语 + 7 天冷静期 + 到期前先备份（§12.6）。
// 拥有的表：review_queue、rules、suppressions、tombstones、need_to_know。
// 用到的端口：clock、logger。
// 契约细节：docs/实现/模块与接口.md §4.12。实现分在 rules / review / suppress / purge / retention / views / simulate 几个文件。
import * as rules from './rules.js';
import * as review from './review.js';
import * as sup from './suppress.js';
import * as purgeMod from './purge.js';
import * as retention from './retention.js';
import * as views from './views.js';
import * as sim from './simulate.js';
import { parseRef } from '../store/refs.js';
import { getMetaJson, setMetaJson } from '../store/kv.js';
import { ContractError } from '../contract/errors.js';

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.admin = { rules: new Map(), dnr: null, modes: new Map() };
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) { /* 无资源 */ }

// ── 浏览和模拟 ────────────────────────────────────────────────────────────

/**
 * 管理页的列表（记忆、人与物、场合、经历、意图、分寸日志、注入日志……）。q.view 选哪一类，其余是筛选条件和分页游标。
 * 返回的条目只含主人能看的内容（主人看得到全部，包括隐藏的，§9.3.7 第 3 条）。
 * view：memories（kind='episode' 时是情节）/ assertions / episodes / entities / settings / percepts / windows / intentions / discretion /
 * injections / utterances / holds / review / needToKnow / rules / suppressed / forgotten / tombstones / backups / drills。
 * 分页：limit、next（上一页返回的游标）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{view: string, [k: string]: unknown}} q
 * @returns {import('../contract/types.js').Page}
 */
export function list(core, q) { return views.list(core, q); }

/**
 * 一条的详情：来源链、流动规范、谁知道、告诉过谁、版本链、同类的其他几次、注入过它的会话。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} ref
 * @returns {object|null}
 */
export function get(core, ref) { return views.get(core, ref); }

/**
 * 模拟器（§13.1）：「如果 X 在 Y 说了 Z」，只计算召回和分寸，不注入、不写感知、不加痕迹（判定记录照常写，标模拟）。
 * 【补】s.refs：直接判这几条记忆（不经召回）；s.mode：'involuntary'（默认）/ 'deliberate'。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingId: string, as: import('../contract/types.js').ActorRef, text: string}} s
 * @returns {Promise<import('../contract/types.js').SimResult>}
 */
export async function simulate(core, s) { return sim.simulate(core, s); }

// ── 审核队列 ──────────────────────────────────────────────────────────────

/**
 * 排一条审核（各模块都通过它写 review_queue）。payload 只放引用和结构化字段，不放原文。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'forget_request'|'owner_op'|'merge'|'growth'|'held_utterance'|'norm_change'|'setting_rule_relax'|'withdraw',
 *          payload: object, reason: string, expiresAt?: number|null}} item
 * @returns {number}
 */
export function enqueueReview(core, item) { return review.enqueueReview(core, item); }

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {{status?: string, kind?: string}} [q]
 * @returns {import('../contract/types.js').ReviewItem[]}
 */
export function listReview(core, q) { return review.listReview(core, q ?? {}); }

/**
 * 主人的决定，按 kind 交给拥有者执行：forget_request → suppress / restore；merge → entities.link（decided_by='owner'）；
 * growth → consolidate.applyGrowth（应用不上抛 GROWTH_NOT_APPLIED，留在队列里）；held_utterance → discretion.holdDecision；
 * norm_change → discretion.applyNormUpdate；setting_rule_relax → discretion.decideSettingRule（挂起的那一版生效或驳回；
 * 那一版已不在等审核时撤回并抛 REVIEW_WITHDRAWN；discretion 还没有它时批准退回 writeSettingRule（authority='principal'））；
 * withdraw → purge。执行完常驻区标脏（挂起的发言除外）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} id
 * @param {'approve'|'reject'} decision
 * @param {{by: string}} [ctx]
 * @returns {Promise<void>}
 */
export async function decideReview(core, id, decision, ctx) { return review.decideReview(core, id, decision, ctx ?? {}); }

/**
 * 过期处理：挂起的发言 14 天没处理 → expired（discretion.holdDecision(token, false)）；maybe_same **永远不**自动判成 not_same。
 * 顺带撤回已经有答案的审核项（status='withdrawn'，不执行决定）：权利层已经定了是不是同一个、那一版场合规矩已不在等审核、
 * 要处理的记忆已被彻底删除；再给上次扫到之后才写出来的派生内容补上隐藏（inheritSuppression 的兜底，按 created_at 往后扫，
 * 每张表每次最多 admin.inheritBatch 行）。返回过期的条数。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} at
 * @returns {number}
 */
export function expireReviews(core, at) { return review.expireReviews(core, at); }

/**
 * 【补】撤回还在等着的审核项：问题已经由拥有那件事的模块回答了（例：entities 的双向自认把「可能是同一个」定成了同一个，
 * 调 withdrawReviews(core, {kind: 'merge', match: {a, b}}, {reason: 'mutual-claim'})）。不执行任何决定，只标 withdrawn。
 * 在调用方的事务里调用也行。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'forget_request'|'owner_op'|'merge'|'growth'|'held_utterance'|'norm_change'|'setting_rule_relax'|'withdraw', match: object}} q
 *        match：payload 里要相等的字段（merge 的 a / b 不分先后）
 * @param {{reason?: string, at?: number}} [ctx]
 * @returns {number} 撤回了几条
 */
export function withdrawReviews(core, q, ctx) { return review.withdrawReviews(core, q, ctx ?? {}); }

/**
 * 待审提示的条数（常驻区，§10.4）：审核队列 + 需要你知道 + 最近的成长变化 +（保留期缩短的冷静期倒计时另给）。
 * principalOnly=true 时只算需要主人本人处理的。
 * @param {import('../core-types.js').CoreContext} core
 * @param {boolean} principalOnly
 * @returns {number}
 */
export function pendingCount(core, principalOnly) { return review.pendingCount(core, principalOnly); }

/**
 * 【补】待审提示的各项（常驻区一行「审核队列有 N 条；需要你知道 N 条；最近有 N 处成长变化」+ 冷静期倒计时）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{reviews: number, needToKnow: number, growth: number, retention: {to: string, effectiveAt: number, daysLeft: number}|null}}
 */
export function pendingSummary(core) { return review.pendingSummary(core); }

// ── 需要你知道（§9.3.7） ──────────────────────────────────────────────────

/**
 * 记一条「需要你知道」：T1 想改变她的东西（无权限者的指令或设定、「别告诉你主人」这类请求本身）、T2 伤害 / 违法 / 安全、
 * taint 被污染的、poison 疑似投毒、foreign_write 准备写进规矩 / 意图 / 成长块而来源不是管理者的。各模块发现时调用。
 * 【D118】T1 的那条消息是有管理权限的人自己转给她的（合并转发，转发人有权限）→ 不记，返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'T1'|'T2'|'taint'|'poison'|'foreign_write', ref?: string|null, perceptId?: number|null,
 *          sourceEntityId?: number|null, reason: string, severity?: number, at: number}} item
 * @returns {number|null}
 */
export function notifyNeedToKnow(core, item) { return review.notifyNeedToKnow(core, item); }

/**
 * 「需要你知道」列表（管理页）。【D118】按轮污点只在打开 context.taint.notify 时列；每条带 forwardedBy（转发进来的是谁转的）、
 * growth（原因是 growth-v<N> 时那一版成长块的变化和文字）。
 * @param {import('../core-types.js').CoreContext} core @param {{status?: string}} [q] @returns {object[]}
 */
export function listNeedToKnow(core, q) { return review.listNeedToKnow(core, q ?? {}); }

/** @param {import('../core-types.js').CoreContext} core @param {number} id */
export function markNeedToKnowRead(core, id) { review.markNeedToKnowRead(core, id); }

// ── 规则 ──────────────────────────────────────────────────────────────────

/**
 * 加一条规则。do_not_remember 的目标：场合键 / 实体 / 记忆引用；disclosure：{entity | attribute | settingAttrs} + 限制；
 * mode：{settingKey} + 'off'|'live'。只能来自管理页（created_by='owner'）或经授权的工具（「别记这里」）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'do_not_remember'|'disclosure'|'mode', target: object, value?: unknown, createdBy: string, note?: string, at: number}} rule
 * @returns {number}
 */
export function addRule(core, rule) { return rules.addRule(core, rule); }

/** @param {import('../core-types.js').CoreContext} core @param {number} id @param {{at: number}} ctx */
export function revokeRule(core, id, ctx) { rules.revokeRule(core, id, ctx); }

/** @param {import('../core-types.js').CoreContext} core @param {'do_not_remember'|'disclosure'|'mode'} kind @returns {object[]} */
export function activeRules(core, kind) { return rules.activeRules(core, kind); }

/**
 * 这个场合当前的生效档（§10.1、§15.2）：min(config.mode.global, 场合覆盖（rules.kind='mode'）?? 按场合属性的默认档)。
 * 按属性的默认档：和有管理权限的人一对一 → principalOneOnOne；任何人可见或公开留存 → public；其余 → closed。
 * 每类场合默认都是 live（她在哪儿都记得；说不说由关口①②逐条判断，不按场合一刀切）；旧版本的 'shadow' 不再是一档。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {'off'|'live'}
 */
export function modeFor(core, settingKey) { return rules.modeFor(core, settingKey); }

/**
 * 「别记」规则命中吗（intake 入库前问：场合、说话人）。【补】q.ref：这条被忘掉的记忆（encode 对账时问，别把同样的内容又记回去）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey?: string, entityIds?: number[]}} q
 * @returns {boolean}
 */
export function doNotRemember(core, q) { return rules.doNotRemember(core, q); }

// ── 隐藏、忘掉、彻底删除（§12.7） ───────────────────────────────────────────

/**
 * 隐藏（对别人隐藏，主人和审核视图仍可见）或忘掉（再加一条指向它的「别记」规则；restore_until = 30 天后）。
 * 派生内容一起对别人隐藏（级联，by='system'、reason='cascade:<ref>'；方向从来源到派生，同彻底删除 D55）：
 * 一条消息 → 含它的原文窗口、以它为来源的每段叙述（任何一种情节）、只靠它作证据的记忆；一条事实、一段经历、一个原文窗口 →
 * 证据消息汇总出的小结、日记（summary / diary）；小结 → 汇总它的日记；日记不带别的。常驻区标脏。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} ref
 * @param {{state: 'hidden'|'forgotten', by: string, reason?: string, at: number}} s
 */
export function suppress(core, ref, s) { sup.suppress(core, ref, s); }

/**
 * 恢复（30 天内）。级联隐藏的派生内容一起恢复，除非还有别的直接隐藏会带给它。常驻区标脏。
 * @param {import('../core-types.js').CoreContext} core @param {string} ref @param {{by: string, at: number}} ctx
 */
export function restore(core, ref, ctx) { sup.restore(core, ref, ctx); }

/**
 * 【补】解除一条叮嘱（D113，管理页「她在守的叮嘱」）：discretion.relaxLimit（规范按主人的权限放宽、第一眼核对过的限制清掉）。
 * 只认 discretion.explicitLimit 认的条目；不是叮嘱的返回 {applied: false}。
 * @param {import('../core-types.js').CoreContext} core @param {string} ref @param {{by: string, at: number}} ctx
 * @returns {{applied: boolean}}
 */
export function relaxLimit(core, ref, ctx) {
  const m = parseRef(ref);
  if (!m) throw new ContractError('admin.relaxLimit', [{ path: 'ref', message: '不认识的记忆引用' }]);
  if (!core.mods.discretion.explicitLimit(core, m)) return { applied: false };
  let speaker = null;
  try { speaker = core.mods.entities.principals(core)?.[0] ?? null; } catch { speaker = null; }
  return core.mods.discretion.relaxLimit(core, m, { at: ctx?.at ?? core.now(), speakerEntityId: speaker });
}

/**
 * 【补】新写出来的派生内容（今天到目前为止的小结、日记、原文窗口、提炼出的事实）：证据里有被直接隐藏的，就一起对别人隐藏
 * （和 suppress 的级联同一套规则）。写派生内容的模块在写入的事务里调：encode.writeEpisode / writeAssertion / formIntention
 *（有消息作证据的；今天到目前为止的小结也经 writeEpisode 写），consolidate 写日记（证据是小结，不是消息）时再调一次；
 * 原文窗口和没调到的由 tick 的 expireReviews 补上（最多晚一个 tick）。重复调不重复记。返回带来隐藏的那条引用，没有是 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} ref
 * @param {{at?: number}} [ctx]
 * @returns {string|null}
 */
export function inheritSuppression(core, ref, ctx) { return sup.inheritSuppression(core, ref, ctx ?? {}); }

/**
 * 这条记忆的隐藏状态（retrieve 预过滤、context 渲染前都要查；批量用 suppressedRefs）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} ref
 * @returns {'hidden'|'forgotten'|null}
 */
export function suppression(core, ref) { return sup.suppression(core, ref); }

/**
 * 一批里哪些被隐藏 / 忘掉 / 彻底删除（墓碑）了（召回的预过滤用）。墓碑按时间生效（D42）：墓碑之后写进来、碰巧拿到同一个 id 的
 * 新记忆不算。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} refs
 * @returns {Set<string>}
 */
export function suppressedRefs(core, refs) { return sup.suppressedRefs(core, refs); }

/**
 * 彻底删除（只给主人）：按来源链级联（只靠它作证据的派生记忆一起删，有其他证据的重新评估），**先删向量（worker.dropEmbeddings），
 * 再删主库**（记忆本身、FTS 行、规范、谁知道、告诉过谁、痕迹、来源……按 §2.3 的级联表），写墓碑。分批、可中断、可安全重跑。
 * 含被删感知的原文窗口在第一批的事务里交给 intake.dropFromWindows 重新渲染（一条不剩的删掉；删掉的窗口身上挂的行由 admin
 * 清掉并写墓碑）。删完重新定来源被删掉的级联隐藏（重新渲染过的窗口放开；还复述着删掉内容的留着，reason 改成 'purged:<ref>'）。
 * 删了人或身份证据时 entities.invalidateNames；常驻区标脏。
 * 删之前先做操作前快照（backup.preOperationSnapshot reason='purge'）。alsoBackups=true 时再重写本地的每个包（慢）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} refs
 * @param {{by: string, alsoBackups?: boolean, at: number, reason?: 'purge'|'withdraw'}} ctx   【补】reason：操作前快照记的原因
 * @returns {Promise<{deleted: Record<string, number>, sessions: string[]}>}   sessions：注入过这些记忆的会话（提示「已经注入过的文字收不回」）
 */
export async function purge(core, refs, ctx) { return purgeMod.purge(core, refs, ctx); }

/**
 * 按墓碑再删一遍（每次启动时、恢复备份后，§12.4.5 第 5 步）。tombstones 不给时用当前库的墓碑表。
 * 先把上次中途停下的彻底删除做完。只删墓碑时间之前就有的行（恢复后新写入的同 id 行是新的记忆）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{tombstones?: {kind: string, ref: string, at: number}[]}} [opt]
 * @returns {Promise<{deleted: number}>}
 */
export async function reapplyTombstones(core, opt) { return purgeMod.reapplyTombstones(core, opt ?? {}); }

/**
 * 【补】在任意一个库（主库或解开的备份副本）上按墓碑删（同步）。backup 重写本地包时用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../store/db.js').Store} db
 * @param {{kind: string, ref: string, at: number}[]} tombstones
 * @returns {{deleted: number}}
 */
export function applyTombstonesTo(core, db, tombstones) { return { deleted: purgeMod.applyTombstonesTo(core, db, tombstones).deleted }; }

/**
 * 【补】一批 (adapter, ext_key) 里哪些是被彻底删除过的消息：intake 入库前问，恢复后从来源补回、或平台重发同一条消息时不再入库。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapter
 * @param {string[]} extKeys   percepts.ext_key（HMAC）
 * @returns {Set<string>}
 */
export function tombstonedObs(core, adapter, extKeys) { return purgeMod.tombstonedObs(core, adapter, extKeys); }

/**
 * 【补】这条是不是被彻底删除过（kind = owner_kind / 'identity' / 'obs'）。记忆单元按时间（D42：同 id 的新行不算）。
 * @param {import('../core-types.js').CoreContext} core @param {string} kind @param {string} ref @returns {boolean}
 */
export function isTombstoned(core, kind, ref) { return sup.isTombstoned(core.store, kind, ref); }

/**
 * 按来源撤回（§12.7）：某人在某段时间提供的全部内容和由它们派生的记忆 → 先进审核队列，主人批准后 purge。
 * 审核期间先对别人隐藏；驳回就恢复原样。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{entityId: number, from: number, to: number, by: string, at: number}} q
 * @returns {{reviewId: number, refs: number}}
 */
export function withdrawBySource(core, q) { return purgeMod.withdrawBySource(core, q); }

/** 【补】驳回按来源撤回时恢复审核期间的隐藏（decideReview 调）。 @returns {number} */
export function undoWithdrawHide(core, reviewId, at) { return purgeMod.undoWithdrawHide(core, reviewId, at); }

// ── 原文保留期（§12.6） ───────────────────────────────────────────────────

/**
 * 当前保留期和待生效的改动（冷静期倒计时）。状态存在 meta 'retention.policy' / 'retention.pending'。
 * logs：最近一次日志表到期清理的结果（D139，meta 'retention.logs.last'；还没清过是 null），只有数字。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{current: '1y'|'2y'|'5y'|'forever', pending: {to: string, effectiveAt: number, impact: object}|null,
 *            logs: {at: number, deleted: Record<string, number>, total: number, done: boolean, off: string[]}|null}}
 */
export function retentionState(core) { return /** @type {any} */ (retention.retentionState(core)); }

/**
 * 改保留期。延长立即生效；缩短先算影响（会删多少条原文、时间范围、占多少空间），要求 confirmPhrase 和给出的确认语一致，
 * 然后进入 7 天冷静期（期间什么都不删，随时可以取消）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{to: '1y'|'2y'|'5y'|'forever', confirmPhrase?: string, by: string, at: number}} req
 * @returns {{status: 'applied'|'cooling-off'|'need-confirm', confirmPhrase?: string, impact?: object, effectiveAt?: number}}
 */
export function requestRetentionChange(core, req) { return retention.requestRetentionChange(core, req); }

/** @param {import('../core-types.js').CoreContext} core @param {{by: string, at: number}} ctx */
export function cancelRetentionChange(core, ctx) { retention.cancelRetentionChange(core, ctx); }

/**
 * 冷静期满了就生效：先做一次完整备份（backup.createPack kind='pre-op' reason='retention'），再分批调 intake.expireRawText。
 * 平时按当前保留期做例行到期删除（夜间整理第 10 步）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} at
 * @returns {Promise<{expired: number, done: boolean}>}
 */
export async function applyRetention(core, at) { return retention.applyRetention(core, at); }

/**
 * 日志表到期清理（D139，夜间整理第 10 步调）：任务、注入日志、她说过的话的审视记录、判定记录，按 retention.logs 的天数
 * （和读它们的步骤要看的天数取大的；0 或负数 = 不清理）分批删，还在用的不删（各表的拥有者定）。能中断，下次接着删。
 * 结果记 meta 'retention.logs.last'，retentionState 的 logs 带出来给管理页。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} [at]
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{deleted: Record<string, number>, done: boolean, skipped?: string}>}
 */
export async function expireLogs(core, at, opt) { return retention.expireLogs(core, at, opt ?? {}); }

// ── 「有记忆 / 没记忆」评测（D126） ────────────────────────────────────────────

const EVAL_KEY = 'eval.memory.last';
const evalCase = (c) => ({
  id: String(c?.id ?? '').slice(0, 40), name: String(c?.name ?? '').slice(0, 60),
  // 只看守护的用例：有记忆 / 没记忆两列是 null
  on: c?.on == null ? null : c.on === true, off: c?.off == null ? null : c.off === true, ...(typeof c?.guard === 'boolean' ? { guard: c.guard } : {}),
});

/**
 * 最近一次「有记忆 / 没记忆」评测的结果（集成层跑完交来的，只有用例名、对错和数字，没有内容）。没跑过返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{at: number, version: string, total: number, on: number, off: number, guards: number, guardsHeld: number, ms: number|null,
 *            cases: {id: string, name: string, on: boolean|null, off: boolean|null, guard?: boolean}[]}|null}
 */
export function evalResult(core) {
  const v = getMetaJson(core.store, EVAL_KEY, null);
  return v && typeof v === 'object' && Array.isArray(v.cases) ? v : null;
}

/**
 * 存下一次评测的结果（覆盖上一次）。只留用例名、对错和数字；别的字段丢掉。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at?: number, version?: string, ms?: number, cases: object[]}} r
 */
export function setEvalResult(core, r) {
  if (!r || !Array.isArray(r.cases)) throw new ContractError('evalResult', [{ path: 'cases', message: '应为数组' }]);
  const cases = r.cases.slice(0, 50).map(evalCase).filter((c) => c.id);
  const guards = cases.filter((c) => typeof c.guard === 'boolean');
  const v = {
    at: Number.isFinite(r.at) ? r.at : core.now(), version: String(r.version ?? '').slice(0, 40), ms: Number.isFinite(r.ms) ? Math.round(r.ms) : null,
    total: cases.filter((c) => c.on !== null).length, on: cases.filter((c) => c.on === true).length, off: cases.filter((c) => c.off === true).length,
    guards: guards.length, guardsHeld: guards.filter((c) => c.guard).length, cases,
  };
  setMetaJson(core.store, EVAL_KEY, v);
  return v;
}
