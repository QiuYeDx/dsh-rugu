// context 模块（§10.4、§10.5、§5.7、§9.4.1 污点账本）：把召回结果变成按层组织、已过分寸、按预算打包的 RecallLayers，
// 以及每个会话的账本（本周期发过什么、注入日志、按轮污点、压缩周期）。
//   - 设计 §3.2 没有单列这个目录；§4.5 的读接口（resident / recall / recallCached / self.coreBlock）和 §10.4 的分层、
//     §9.4.1 的污点账本都需要一个归属，放在这里，retrieve 只管「想起什么」。
//   - 进入她上下文的任何记忆文字都必须由若干条已过关口①的条目渲染出来（§9.3.6）：人物卡、在场者近况、今天到目前为止、
//     时间间隔、暖启动……全都先 discretion.gate 再 retrieve.render，不允许直接拼一段汇总文字。
//   - resident() 同步、读冻结的缓存（F1）：只在有真实新消息时（refreshResident）或压缩结束后换文本，出错返回上一次的冻结文本。
// 拥有的表：sessions、injections。
// 用到的端口：selfProfile、clock。
// 契约细节：docs/实现/模块与接口.md §4.8。
import * as ledger from './ledger.js';
import * as res from './resident.js';
import * as rc from './recall.js';
import * as diag from './diag.js';

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.context = {
    resident: new Map(),        // 场合键 → 冻结的常驻区 {text, version, itemIds, at, partial}
    dirty: new Set(),           // 标脏的场合（下一次真实消息到来时重新渲染）
    staged: new Map(),          // 回合开始后才渲染完的版本，留到下一次真实消息再换上
    refreshing: new Map(),
    timers: new Map(),
    cache: new Map(),           // 已经过完关口①、渲染好的条目（recallCached 用），键 = （场合键，会话）
    inflight: new Map(),
    // 场合键 → {settingId, adapterId}：SettingId 只在内存里，不落库（§12.3）。常驻区渲染时交给 discretion.targetFor，
    // 能列成员的平台据此刷新名单（契约 §1.1：members() 只由 targetFor 调）
    settingIds: new Map(),
    // 会话 → 这一轮的触发者 {triggerEntityIds, focusPerceptId, at}（D107：关口②据此判「问的是不是说的人」「是不是他自己提起的」）。
    // 只在内存里；读不到（重启了、这一轮没回想过）关口②按「问的不是说的人」处理（fail closed）
    turns: new Map(),
  };
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) {
  const st = core.state.context;
  if (!st) return;
  for (const h of st.timers.values()) clearImmediate(h);
  st.timers.clear();
}

// ── 读接口（§4.5） ────────────────────────────────────────────────────────

/**
 * 常驻区（同步）：核心自我 + 成长块、用法说明、重要的人（按场合过分寸）、现在的我（心境一行，不含原因）、近期约定、
 * 待审提示（只在和有管理权限的人一对一时，admin.pendingCount）。各部分预算见 config.context.resident。
 * 读 state.context.resident 里的冻结文本；没有就同步渲染一次只含核心自我的版本，并安排 refreshResident。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingId
 * @returns {import('../contract/types.js').ResidentBlock}
 */
export function resident(core, settingId) {
  return res.residentFor(core, settingId);
}

/**
 * 重新渲染常驻区并冻结（真实新消息到来时、压缩结束后、主人编辑后；定时器和夜间整理只标脏）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {Promise<void>}
 */
export async function refreshResident(core, settingKey) {
  return res.refreshResident(core, settingKey);
}

/**
 * 【补】常驻区标脏（定时器、夜间整理、主人在管理页编辑之后调；不换文本，等下一条真实消息或下一次压缩结束）。
 * settingKey 不给 = 全部场合。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} [settingKey]
 */
export function markResidentDirty(core, settingKey) {
  const st = core.state.context;
  if (settingKey) res.markDirty(core, settingKey);
  else for (const k of st.resident.keys()) if (k) st.dirty.add(k);
}

/**
 * self.coreBlock()：核心自我（selfProfile.coreSelf）+ 成长块（consolidate.growthBlock），所有场合都一样（§5.7）。
 * 给不经 DSH 注入的调用方（例：后台的评论引擎）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingId
 * @returns {{text: string, hash: string}}
 */
export function coreBlock(core, settingId) {
  return res.coreBlockText(core);
}

/**
 * recall()：retrieve.recall 取候选 → discretion.targetFor + gate → 分层（recalled / awarePrivate / recentFromPresent，
 * 加本模块自己组的 people / todaySoFar / gap / warmStart / intentions）→ retrieve.render → 去掉这个会话本周期已发过的
 * （sessions.sent_items_json）→ 按 opt.budgetChars 和 config.context.layers 打包。返回的每条都有 appraisalRef。
 * 别人直接对她说的话开启的一轮，回想排在这一轮新给的前面的条目本周期已经给过时，加一层 pointBack：那一条的一行「指回去」
 * （沿用这一轮对它的判定，D146；config.context.pointBack）。
 * 场合关着（admin.modeFor = off）就不算、返回 null；开着就照常给，说不说已经由关口①逐条判断过（没有影子档了，用户反馈第 6 轮）。
 * 在聊天路径上：任何依赖出错都只降级（少给或不给），不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').SituationRef} s
 * @param {import('../contract/types.js').RecallOptions} opt
 * @returns {Promise<import('../contract/types.js').RecallLayers>}
 */
export async function recall(core, s, opt) {
  return rc.recall(core, s, opt);
}

/**
 * recallCached()（同步）：只读预取缓存里已经过完关口①的结果；没有就返回空的 RecallLayers（degradeLevel 照实填）。
 * 预取缓存里有新候选、最新一条又是对她说的，就在后台过一遍关口①，下一次调用就有结果。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').SituationRef} s
 * @returns {import('../contract/types.js').RecallLayers}
 */
export function recallCached(core, s) {
  return rc.recallCached(core, s);
}

/**
 * retrieve 的完整预取做完后通知（对她说的、@ 她的消息）：在后台把这一轮会交给关口①的条目先判一遍，第二段的结论提前进判定缓存，
 * 宿主开始这一轮时多半已经判完（D99，§9.3.5）。只预热判定缓存，不改会话状态、不写 recallCached 的缓存。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {void}
 */
export function prepareAfterPrefetch(core, settingKey) {
  rc.prepareAfterPrefetch(core, settingKey);
}

/**
 * 【D117】回想的健康（管理页的诊断、启动自检）：今天和前几天（UTC 日）的回想次数、出错处数（按步骤 / 错误类型）、partial / lost、
 * 前台回想的耗时分布、宿主等回想的结果（等到 / 超时 / 出错 / 退回缓存给了）、查询嵌入的重试；加最近的出错（新的在前，
 * 每条只有时刻、步骤、错误类型、代码位置、触发、降级级别）。只有数字和代码事实，没有内容。不抛错。
 * 【D133】每天另有注入预算的计数（days[].inject：超了每天 / 滚动窗口额度的轮数、因为预算没放进去的条数）；injectBudget：
 * 最近一天动过的活跃会话（最多 opt.sessions 个，默认 8；0 = 不看）今天已用 / 上限、滚动窗口已用 / 上限（null = 不限或窗口还没满）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{days?: number, recent?: number, sessions?: number}} [opt]
 * @returns {{days: object[], recent: object[], buckets: string[], injectBudget?: object[]}}
 */
export function recallHealth(core, opt) {
  try { return diag.recallHealth(core, opt ?? {}); } catch { return { days: [], recent: [], buckets: [] }; }
}

/**
 * 【D117】宿主报来这一轮等回想的结果（集成层 blockFor 等完以后）：outcome = ok / timeout / error / aborted，code = 回想报错时的错误类型，
 * waitedMs = 等了多久，served = 超时或出错后退回 recallCached 给了几条。记 host.recall.* 计数；超时和出错进「最近的出错」。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string|null} sessionId
 * @param {{outcome: string, code?: string, waitedMs?: number, trigger?: string, served?: number}} o
 * @returns {void}
 */
export function noteHostRecall(core, sessionId, o) {
  try { diag.noteHostRecall(core, sessionId, o ?? {}); } catch { /* 只是计数 */ }
}

// ── 会话账本【补】（§10.3–§10.5、§9.4.1；api.sessions.*） ──────────────────────

/**
 * 会话和场合绑定（集成层认领会话之后调用，§10.3）。重复调用更新绑定。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{sessionId: string, settingId: string, adapterId: string, confidence: 'specific'|'fallback'}} b
 */
export function bindSession(core, b) {
  ledger.bindSession(core, b, (key) => res.residentItemsOf(core, key));
}

/**
 * 记一个准备注入的块（集成层插入消息之前调用）：injections 一行（seen=0）+ sessions.pending_json。
 * items 只记 id / layer / verdict / appraisalRef（speak 已弃用，D113：交来的照样校验、不再记下），不记正文（§12.3）。同一个 nonce 重复记返回同一个 id。
 * items[].chars（可选，D133）：这一条自己的字数，原样记下；注入预算按条目的层记账（「你想着的」和工作记忆不算），没带就按整块的 chars 算。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{sessionId: string, nonce: string, layer: string, items: {id: string, layer: string, verdict: string, appraisalRef: string, speak?: 'free'|'careful'|'not-here', chars?: number}[],
 *          chars: number, degradeLevel?: number, routeMs?: Record<string, number>, mode: 'live'|'shadow'}} inj   mode 只有 'live'（'shadow' 只为旧版本的集成层留着：照常记，但不算进上下文）
 * @returns {number} 注入 id
 */
export function recordInjection(core, inj) {
  return ledger.recordInjection(core, inj);
}

/**
 * 会话事件里出现了这个 nonce（§10.4「已发过」的确认）：seen=1，条目进 sent_items_json，也就进了这个会话的污点账本。
 * 不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 * @param {string} nonce
 */
export function confirmInjection(core, sessionId, nonce) {
  ledger.confirmInjection(core, sessionId, nonce);
}

/**
 * 回合中止没发出去的块：丢掉 pending，下次照常可以发。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 */
export function abortPending(core, sessionId) {
  ledger.abortPending(core, sessionId);
}

/**
 * 压缩（§10.5）：start → intake.sealBuffers（只记检查点；给场合键，D53，插件重启后还没重新绑定的会话也记得上）；
 * end → cycle + 1、清空已发名单、标 warm_pending、常驻区标脏。
 * restart（主人主动重新开始）→ 清空工作记忆，只给常驻区，等下一次压缩再恢复暖启动（§17 Q6）。
 * end / restart 之后常驻区马上重新渲染并换上（压缩结束是允许换文本的时机，§10.4）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 * @param {'start'|'end'|'restart'} phase
 */
export function compaction(core, sessionId, phase) {
  ledger.compaction(core, sessionId, phase, {
    residentItemsOf: (key) => res.residentItemsOf(core, key),
    onResidentDirty: (key) => {
      res.markDirty(core, key);
      core.state.context.staged.delete(key);
      res.refreshResident(core, key).catch(() => { /* refreshResident 自己记日志 */ });
    },
  });
}

/**
 * 按轮污点（§9.6）：从最近一条有权限的说话人的消息开始，只要有素材或无权限者的文字进入上下文，这一轮就带污点。
 * 集成层在 post-execute 看到工具结果时调用 mark(tainted=true)；新的一轮由有权限的人开启时调用 mark(tainted=false)。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 * @param {{tainted: boolean, reason: string, at: number}} m
 */
export function markTurnTaint(core, sessionId, m) {
  ledger.markTurnTaint(core, sessionId, m);
}

/**
 * 记一步（滚动窗口预算用，§10.4）：这一步之后的上下文 token 数。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 * @param {{contextTokens: number, at: number}} step
 */
export function recordStep(core, sessionId, step) {
  ledger.recordStep(core, sessionId, step);
}

/**
 * 这个会话的污点账本（§9.4.1）：当前周期里已确认送达的注入条目（injections.seen=1 且 cycle = sessions.cycle）。
 * discretion.appraise 拿它对每个外发目标重跑 stage1，判断「对这个目标是不是不为空」。
 * 只算带内容进了上下文的（share / share_vague；旧版本记下的 mode='shadow' 不算）；另加本周期常驻区放进过这个会话的条目（场合现在开着记忆时）。
 * 场合后来被关掉、总开关后来被关掉，已经注入的这些照样算：discretion.appraise 据此决定两边都关着时还要不要审。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 * @returns {string[]} 记忆引用（新注入的在前，常驻区的在后）
 */
export function taintLedger(core, sessionId) {
  return ledger.taintLedger(core, sessionId, {
    residentLive: (key) => {
      try { return core.mods.admin.modeFor(core, key) === 'live'; } catch { return true; }   // 不知道就当注入过（宁可多审）
    },
  });
}

/**
 * 到期清理注入日志（D139，admin.expireLogs 在夜里调）：早于 before 的行分批删掉，还在用的留着——会话当前周期的、还在等确认的、
 * 滚动窗口里的、每个会话最新的一行。可以中断，下次接着删。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{before: number, batch?: number, maxBatches?: number, signal?: AbortSignal}} opt
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireInjections(core, opt) {
  return ledger.expireInjections(core, opt);
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} sessionId
 * triggerEntityIds / focusPerceptId：这个会话这一轮回想时认出的触发者（主触发者在前）和焦点那条感知（D107，只在内存里；没回想过、重启了是 [] / null）。
 * selfTurn：这一轮是她自己开启的（按 idle 或定时提醒到点回想、没有触发者，D115、D144）；turnAt：这一轮回想记下的时刻（没记过是 null）。
 * @returns {{sessionId: string, settingKey: string|null, adapter: string|null, cycle: number, turnTainted: boolean, warmPending: boolean,
 *            triggerEntityIds: number[], focusPerceptId: number|null, selfTurn: boolean, turnAt: number|null}|null}
 */
export function sessionInfo(core, sessionId) {
  return ledger.sessionInfo(core, sessionId);
}
