// DSH 绑定（§4.6）：契约的另一半，只在 DSH 上需要——会话认领、会话事件解析、工具声明。
// 核心契约（rugu-core/contract）不含任何宿主概念；微信接在 DSH 上时两半都实现，接在别的宿主上只实现核心契约 + 那个宿主的绑定。
// 这里只有类型和校验；每个适配器自己实现自己的绑定（adapters/*.js）。
import { isAdapterId, ContractError } from 'rugu-core/contract';

/**
 * 会话的说明（从会话头取，§10.3）。
 * @typedef {object} SessionInfo
 * @property {string} id
 * @property {string} [preset]
 * @property {string} [cwd]
 * @property {string} [origin]            子代理是 'subagent'（一律排除，F20）
 * @property {number} [delegationDepth]
 * @property {string} [parentSession]
 * @property {unknown} header
 * @property {unknown[]} [messages]       在第一次 pre-step 认领时：这一步 claimed 的消息（找「本机界面会话」的正面证据用，F24）
 */
/**
 * 工具分类（§4.6）：speak 当场说话 / defer 延时说话 / standing 写成以后每次都会被看到的规则 /
 * persist-foreign 写进别的系统的持久存储 / read 只读、结果是她读到的内容 / none 和说话无关。前四类都按 §4.4 的渠道属性审视。
 * @typedef {'speak'|'defer'|'standing'|'persist-foreign'|'read'|'none'} ToolClass
 */
/**
 * @typedef {object} ToolDecl
 * @property {string} tool                 精确工具名（MCP 工具带完整前缀）
 * @property {ToolClass} class
 * @property {(args: unknown, exec: {sessionId?: string, callId: string, homeSettingId?: string}) => (import('rugu-core/contract').Utterance|null)} [resolve]
 * @property {(args: unknown, exec: {sessionId?: string, callId: string, homeSettingId?: string}) => import('rugu-core/contract').Utterance[]} [resolveAll]
 *           一次调用会落到几个场合时（定时任务的多个目标、写进全局存储的笔记）逐个场合各给一个 Utterance：宿主逐个审，全都能说才放行；
 *           有它时宿主不用 resolve
 * @property {'content'} [readerKind]      read 类：结果作为她读到的内容入库（§7.1）
 * @property {'core'|'adapter'} [appraisedBy]   'adapter'：在适配器自己的汇合点审，核心的 pre-execute 跳过
 * @property {boolean} [returns]           说话类：她发出去的话会不会经适配器回流成感知（默认 true；false 时宿主把原文交给 outcome，核心自己记成她说的话）
 * @property {boolean} [taints]            read 类：结果进上下文算不算按轮污点（默认 true，§9.6；查状态这类只有平台数据的可以 false）
 * @property {(args: unknown, exec: {sessionId?: string, callId: string, homeSettingId?: string}) => boolean} [silent]
 *           说话类：这一次调用没有说任何新的话（暂停 / 恢复定时任务、只改时间、列出 / 删除规则）时返回 true，宿主不审直接放行。
 *           返回 false 而 resolve 不出目标的，宿主照「审不了」处理（fail closed）；拿不准就返回 false
 * @property {boolean} [sessionScoped]     只在这个适配器认领的会话里算数（平台会转述的 DSH 自带工具，例如 QQ 会话里的 ask_user_question：
 *           桥接把问题发进那个 QQ 会话）；别的会话里同名的工具照宿主的默认分类
 */
/**
 * @typedef {object} DshBinding
 * @property {string} adapterId
 * @property {(s: SessionInfo) => ({settingId: string, confidence: 'specific'|'fallback'}|null)} claimSession   不认识就返回 null（fail closed）
 * @property {() => {cwdPrefixes?: string[], presets?: string[]}} sessionSignature      适配器被停用时进「拒认名单」
 * @property {(ev: {type: string, data: unknown, seq: number}, setting: string, sessionId: string) => import('rugu-core/contract').Observation[]} [fromSessionEvent]
 *           宿主交来的事件：会话日志里的 user/message、assistant/message、tool/result，pre-step 里 claimed 的消息（{type:'user/message', data: 消息, seq: -1}），
 *           post-execute 里读内容的工具结果（{type:'tool/result', data: {callId, name, arguments, content, isError}, seq: -1}）
 * @property {(ev: unknown) => (string|null)} [resolveFocus]
 * @property {ToolDecl[]} tools            这个适配器相关的全部工具，每个都必须分类（§11.1）
 *
 * 宿主还认这些可选的钩子（没有就按默认）：
 * @property {(m: unknown) => boolean} [isRealMessage]        claimed 里哪些算「真实的新消息」（默认：source.kind 是 user 或 schedule）
 * @property {(m: unknown) => (string[]|null)} [newObsIds]   【D115】一条真实消息（pre-step 里 claimed 的那条）带来的感知里，哪些是这一轮新来的（ObsId）；
 *           其余是附带的上下文（例：QQ 唤醒快照的 recent）——照常入库，但不能触发这一轮、不当焦点和清污点的依据、不给记忆工具权限。
 *           空数组 = 没有新来的（这一轮是她自己开启的）；null / 没有这个钩子 = 分不出（宿主按兜底规则：早于她在这批里最后一次开口、
 *           或者早于这一轮开始前 tools.seenFreshMs 的不算）
 * @property {(r: {tool: string, args: object, resultText: string, declared: boolean, turn: {sessionId: string, homeSettingId: string, startedAt: number|null, floor: number,
 *           media: {obsId: string, settingId: string, at: number, seenAt: number, kinds: string[]}[]}}) => (string|null|undefined)} [resolveViewedMedia]
 *           【D116】她用工具看了媒体（工具结果带图片，或者是 host.media.viewTools 里的工具，declared = 后者）：看的是哪一条消息（ObsId）。
 *           参数里点明了消息（消息 id）就是那一条；没点明的，只有声明过的看媒体工具才按 uniqueViewed 认（恰好一条才算）；
 *           别的（结果带图片、但参数点的是表情、头像、搜索候选、合并转发、网址……）→ null。
 *           turn.media 是这一轮她看到的、带媒体的别人的消息（宿主记的）；null = 认不出（宿主什么都不做）；undefined / 没有这个钩子 =
 *           宿主兜底（只对声明过的工具：这个会话自己的场合里 uniqueViewed）
 * @property {(ev: {type: string, data: unknown, seq: number}) => boolean} [isRestart]   这条会话事件是不是「对方要求在这个场合重新开始」（§10.5、§17 Q6）
 * @property {{sessionId: string, reason: string, at: number}|null} [lastWakeAlarm]
 *           翻译时发现的一致性告警（C1：唤醒头和绑定的场合对不上）。原因在 host.claim.suspendOnAlarms 里的，宿主停掉那个会话的感知和注入
 * @property {(u: import('rugu-core/contract').Utterance, token: string) => void} [noteAppraisal]
 *           外发审完放行后宿主告诉适配器令牌：她的话回流成感知时按（场合、文本哈希、时间窗）对账（§9.5）
 * @property {(toolName: string) => boolean} [isFrozenTool]   这个工具写别的系统的持久记忆、要拒绝（B13；不看模式、不需要核心）
 * @property {{forStore?: (t: string, o: object) => string, forPrompt?: (t: string) => string}} [sanitizer]   平台相关的转义（§3.3 Sanitizer）
 */

export const TOOL_CLASSES = Object.freeze(['speak', 'defer', 'standing', 'persist-foreign', 'read', 'none']);
/** 要按渠道属性审视的分类。 */
export const SPEAKING_CLASSES = Object.freeze(['speak', 'defer', 'standing', 'persist-foreign']);

/** 【D116】不算要「看」的媒体种类（小黄脸、表情、合并转发：用工具看的不会是它们）。 */
export const UNVIEWABLE_KINDS = Object.freeze(['face', 'sticker', 'forward']);
/**
 * 【D116】没点明是哪条消息时「看的是哪一条」：这个场合里、带能「看」的媒体的消息恰好一条才算（分不清就不猜 → null）。
 * 有带非图片媒体（视频、语音、文件……）的就只在它们里挑（看图片的工具大都按消息 id 取图，没 id 的多半是看视频 / 文件的）。
 * @param {{obsId: string, settingId: string, kinds: string[]}[]} media   这一轮她看到的、带媒体的别人的消息
 * @param {string} settingId
 * @returns {string|null}
 */
export function uniqueViewed(media, settingId) {
  const ids = new Map();
  for (const x of Array.isArray(media) ? media : []) {
    if (!x || typeof x.obsId !== 'string' || x.settingId !== settingId || !Array.isArray(x.kinds)) continue;
    const kinds = x.kinds.filter((k) => !UNVIEWABLE_KINDS.includes(k));
    if (kinds.length) ids.set(x.obsId, kinds.some((k) => k !== 'image'));
  }
  const other = [...ids].filter(([, nonImage]) => nonImage);
  const pool = other.length ? other : [...ids];
  return pool.length === 1 ? pool[0][0] : null;
}

/**
 * 校验一个绑定的形状（契约测试和启动自检用）。说话类的工具必须能 resolve 出 Utterance（appraisedBy='adapter' 的除外）。
 * @param {unknown} b
 * @returns {{ok: boolean, errors: {path: string, message: string}[]}}
 */
export function validateBinding(b) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!b || typeof b !== 'object') return { ok: false, errors: [{ path: 'binding', message: '应为对象' }] };
  const x = /** @type {any} */ (b);
  if (!isAdapterId(x.adapterId)) err('adapterId', '应为合法的适配器 id');
  for (const fn of ['claimSession', 'sessionSignature']) if (typeof x[fn] !== 'function') err(fn, '必须是函数');
  for (const fn of ['fromSessionEvent', 'resolveFocus', 'newObsIds', 'resolveViewedMedia']) if (x[fn] !== undefined && typeof x[fn] !== 'function') err(fn, '提供的话必须是函数');
  if (!Array.isArray(x.tools)) err('tools', '应为数组');
  const seen = new Set();
  (Array.isArray(x.tools) ? x.tools : []).forEach((t, i) => {
    const p = `tools[${i}]`;
    if (!t || typeof t.tool !== 'string' || !t.tool) { err(`${p}.tool`, '必填'); return; }
    if (seen.has(t.tool)) err(`${p}.tool`, `重复声明：${t.tool}`);
    seen.add(t.tool);
    if (!TOOL_CLASSES.includes(t.class)) err(`${p}.class`, `应为 ${TOOL_CLASSES.join(' / ')} 之一（未分类的工具让契约测试失败）`);
    if (t.appraisedBy !== undefined && !['core', 'adapter'].includes(t.appraisedBy)) err(`${p}.appraisedBy`, "应为 'core' 或 'adapter'");
    if (SPEAKING_CLASSES.includes(t.class) && t.appraisedBy !== 'adapter' && typeof t.resolve !== 'function') err(`${p}.resolve`, '说话类工具必须能解析出 Utterance');
    if (t.readerKind !== undefined && (t.class !== 'read' || t.readerKind !== 'content')) err(`${p}.readerKind`, "只有 read 类可以是 'content'");
    if (t.silent !== undefined && typeof t.silent !== 'function') err(`${p}.silent`, '提供的话必须是函数');
    if (t.sessionScoped !== undefined && typeof t.sessionScoped !== 'boolean') err(`${p}.sessionScoped`, '应为布尔值');
  });
  return { ok: errors.length === 0, errors };
}

/** 校验不过就抛 ContractError。 */
export function assertBinding(b) {
  const r = validateBinding(b);
  if (!r.ok) throw new ContractError('DshBinding', r.errors);
  return b;
}
