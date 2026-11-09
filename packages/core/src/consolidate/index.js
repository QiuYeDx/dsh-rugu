// consolidate 模块（§7.7、§5.7、§5.8）：夜间整理、今天到目前为止、故事线、印象重建、反思、自我概念和成长块。
//   - 夜间整理每天 04:30（本地时间），距上次超过 24 小时启动时补跑；LLM 调用总数 ≤ sleep.maxLlmCalls（12），超了顺延；
//     预算不够时整步跳过（§10.6）。第 10 步的运维（在线备份、副本上的完整性检查、FTS 小步合并、增量 vacuum、保留期）
//     委托给 backup / worker / admin。
//   - 派生内容（泛化、反思、印象、故事线、小结）的规范一律经 discretion.inheritNorm；推断类的「谁知道」只有她自己。
//   - 成长块默认自动生效、可撤销（§17 Q4）；依据至少来自 2 个不同的人或场合；指令类、被标了污点的内容不能作为依据。
//   - 常驻区（§10.4）用到的东西（成长块、印象、小结和日记、近期约定）变了只经 context.markResidentDirty 标脏，不换文本。
//   - 整体恢复进行中（backup.isRestoring）不开始夜间整理、不写小结、不做时间维护（§12.4.5「不写新记忆」）。
//   - 第 2 步先对照原话纠错（D122，correct.js）：挑最可能错、最常被想起的事实回到原话核对，改了的经 encode.applyCorrection 写回，
//     主人做的（钉住、确认、改正、主人说的）不动；核对结果记在 memory_checks。
// 拥有的表：storylines、communities、core_blocks、core_block_versions、memory_checks（D122）。
//   夜里产出的情节和事实经 encode.writeEpisode / writeAssertion 写，印象经 entities.writeImpression 写。
// 用到的端口：llm（sleep、summary）、budget、selfProfile、clock。
// 契约细节：docs/实现/模块与接口.md §4.9。内部文件：sleep（编排、第 1/2/9/10 步）、today、storyline、communities、impressions、
//   generalize、reflect、self、time、growth；params 把配置快照摆成方便用的形状，util、memory 是小工具。
import { newRun, residentDirty } from './util.js';
import { shouldSleepImpl, sleepImpl } from './sleep.js';
import { todaySoFarImpl } from './today.js';
import { storylineBatch } from './storyline.js';
import { impressionsBatch } from './impressions.js';
import { timeMaintenanceImpl } from './time.js';
import { revertCheckImpl } from './correct.js';
import { growthBlock as growthBlockImpl, applyGrowthImpl, revokeGrowthImpl, rollbackGrowthImpl, growthVersionsImpl } from './growth.js';

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.consolidate = { running: null, abort: null, renormed: new Map() };
}
/**
 * 中止正在跑的夜间整理，并等它在下一个检查点停下（tick 不等夜间整理，D26：不等的话 api 关库时它还在库上跑）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<void>}
 */
export async function dispose(core) {
  const st = core.state.consolidate;
  try { st?.abort?.abort(); } catch { /* 尽力 */ }
  try { await st?.running; } catch { /* 出错它自己记过 */ }
}

/**
 * 现在该不该跑夜间整理（meta 'sleep.lastAt'；04:30 本地时间之后且今天没跑过，或者距上次超过 catchUpH）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} at
 * @returns {boolean}
 */
export function shouldSleep(core, at) { return shouldSleepImpl(core, at); }

/**
 * 夜间整理（§7.7 的 10 步）。开始前先让 backup 做日包（backup.runScheduled）。每一步失败只跳过这一步，记进报告。
 * 同一时间只跑一个（state.consolidate.running）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{signal?: AbortSignal, at?: number}} [opt]
 * @returns {Promise<import('../contract/types.js').SleepReport>}
 */
export async function sleep(core, opt) { return sleepImpl(core, opt ?? {}); }

/**
 * 今天到目前为止（§5.7，评审:UV-07）：她参与过、对话空闲 today.idleMin 分钟的场合，生成一句话小结（use='summary'；
 * 预算紧时直接拼接她自己说的话和话题词），写成 ep_kind='summary' 的情节，「谁知道」= 那个场合的受众。
 * 由 maintenance.tick 定期调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at: number, signal?: AbortSignal}} opt
 * @returns {Promise<{written: number}>}
 */
export async function todaySoFar(core, opt) { return todaySoFarImpl(core, opt ?? {}); }

/**
 * 稳定场合的故事线增量摘要（§5.8）：从水位线之后的情节接着写，写完推进水位线。transient 场合不做。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{updated: boolean}>}
 */
export async function updateStoryline(core, settingKey, opt) {
  const r = await storylineBatch(core, [settingKey], { run: newRun(1), signal: opt?.signal, at: core.now(), learnRules: true });
  return { updated: r.updated.includes(settingKey) };
}

/**
 * 从事实**重新**生成一个人的分层印象（shared 只用他本人当众说的和大家当场都看到的；private 用一对一里得到的，§5.2）。
 * 八卦内容只记在被说的人名下（「A 说 B 很懒」不改变 A 的印象）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<void>}
 */
export async function regenerateImpressions(core, entityId, opt) {
  await impressionsBatch(core, [entityId], { run: newRun(2), signal: opt?.signal, at: core.now(), pairs: [] });
  // 印象在常驻区「重要的人」里（§10.4）：白天被叫来重建（部分恢复之后等）也只标脏，新文本等下一条真实消息
  residentDirty(core);
}

/**
 * 时间维护（§7.7 第 6 步，也由 maintenance.tick 轻量地跑）：窗口已过、没有完成证据的计划标 unknown（encode.transitionPlan）；
 * 到了时间窗的意图 armed；过了时间窗、在她心里已经淡了的意图 lapsed（最活跃的那条痕迹的 B——意图本身、来源原话、主人要她做的事
 * 还看他最近一次对她说的话——减去 encode.intentionOverdue，低于 intention.lapseBelowA；不是到点作废，D103；
 * encode.transitionIntention 会写 lapse 情节）；挂起的发言 14 天过期（admin.expireReviews）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} at
 * @returns {{plansUnknown: number, intentionsArmed: number, intentionsLapsed: number}}
 */
export function timeMaintenance(core, at) { return timeMaintenanceImpl(core, Number.isFinite(at) ? at : core.now()); }

/**
 * 【D122】主人撤销夜里的一次改正（管理页「记忆 → 夜里改过的」）：照改之前的那一版恢复成新的一版（certainty confirmed，夜里不再挑它），
 * 取代现在这一版，memory_checks 那一行记下撤销的时间和人。只撤改正、降低把握、标「变了」的；之后又换过版本的不撤。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} checkId
 * @param {{by: string, at: number}} ctx
 * @returns {{reverted: boolean, restored?: string, reason?: 'not-found'|'already-reverted'|'nothing-to-revert'|'gone'|'changed-since'}}
 */
export function revertCheck(core, checkId, ctx) { return revertCheckImpl(core, checkId, ctx ?? {}); }

// ── 成长块（§5.7） ────────────────────────────────────────────────────────

/**
 * 当前生效的成长块（context.coreBlock 和常驻区用）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{text: string, version: number}}
 */
export function growthBlock(core) { return growthBlockImpl(core); }

/**
 * 应用一处成长变化：auto 方式直接写新版本；approve 方式写 pending_text 并进审核队列（admin.enqueueReview kind='growth'）。
 * 门槛：≥ 5 条证据、跨 ≥ 3 天、来自 ≥ 2 个不同的人或场合；被撤销过的同一变化，没有新证据就不再写回。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{text: string, change: object, evidenceRefs: string[]}} change
 * @param {{by: 'sleep'|'owner', at: number}} ctx
 * @returns {{version: number|null, queued: boolean, reason?: string}}
 */
export function applyGrowth(core, change, ctx) { return applyGrowthImpl(core, change, ctx); }

/**
 * 撤销单条变化（主人在管理页，§5.7）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} version
 * @param {{by: string, at: number}} ctx
 */
export function revokeGrowth(core, version, ctx) { revokeGrowthImpl(core, version, ctx); }

/**
 * 一键回到任意旧版本。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} toVersion
 * @param {{by: string, at: number}} ctx
 */
export function rollbackGrowth(core, toVersion, ctx) { rollbackGrowthImpl(core, toVersion, ctx); }

/**
 * 成长块的版本历史（管理页「她」）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{version: number, text: string, change: object, evidenceRefs: string[], createdAt: number, createdBy: string, revokedAt: number|null}[]}
 */
export function growthVersions(core) { return growthVersionsImpl(core); }
