// 桥接 MCP 工具的全量分类（§4.6、§11.1 工具表）和关口②要用的 Utterance 解析。
// 工具名单来自只读核对桥接的 src/mcp-snowluma-safe.js（52 个）和 src/mcp-host-server.js（1 个）；
// 桥接升级加了工具而这里没分类，契约测试和启动自检会报出来（PM_QQ_BRIDGE_DIR 指向桥接目录时，测试逐个核对）。
// 平台到属性的翻译（§4.4）：「写常驻规则」「定时发送」「把话带进另一个群」「写进桥接自己的笔记」都只是
// 目标场合 × 留存方式（once / recurring-context）× 延时，核心不认识这些说法。
import { canonicalKey, splitKey } from './files.js';
import { peerActor } from './describe.js';

export const DEFAULT_MCP_PREFIX = 'mcp__snowluma__';
export const DEFAULT_HOST_PREFIX = 'mcp__snowluma-host__';

/** beta 一装上就拒绝写桥接自己的记忆（§11.1、§15.2、B13）。宿主的 tools/pre-execute 用它。 */
export const FROZEN_BARE = Object.freeze(['qq_memory_append', 'qq_memory_remove', 'qq_memory_clear', 'qq_note_person']);
export const FROZEN_REASON = '这些现在由记忆插件负责，桥接自己的记忆暂时只读。';

/**
 * 每个工具的分类。reader：结果里有消息，可以按 fromToolResult 当场提交（attended）：
 *   messages 本会话的消息 / peek 替主人看的另一个群 / forward 合并转发的节点。
 */
export const QQ_TOOL_CLASSES = Object.freeze({
  // 当场说话
  qq_send_message: 'speak', qq_send_burst: 'speak', qq_reply: 'speak', qq_send_group_message: 'speak',
  qq_send_private_message: 'speak', qq_send_sticker: 'speak', qq_send_voice: 'speak', qq_send_web_image: 'speak',
  qq_send_poke: 'speak', qq_ask_group_session: 'speak',
  // dsh-qq 1.1.2：把一句话念成语音发出去，文字要过审视
  qq_speak: 'speak',
  // 延时说话：登记时审，桥接到点代发时没有钩子
  qq_schedule_create: 'defer', qq_schedule_update: 'defer',
  // 写成以后每次唤醒都会出现的规则
  qq_owner_group_rule: 'standing',
  // 写进桥接自己的持久存储，以后会被注入别的会话
  qq_note_person: 'persist-foreign', qq_memory_append: 'persist-foreign', qq_slang_submit: 'persist-foreign',
  qq_sticker_note: 'persist-foreign', qq_set_sticker_remark: 'persist-foreign', qq_collect_sticker: 'persist-foreign',
  // 只读
  qq_get_unread_messages: 'read', qq_get_recent_messages: 'read', qq_wait_for_messages: 'read', qq_get_message_detail: 'read',
  qq_get_my_recent_messages: 'read', qq_get_active_members: 'read', qq_get_forward_msg: 'read', qq_owner_peek_group: 'read',
  qq_get_group_history: 'read', qq_get_group_members: 'read', qq_list_groups: 'read', qq_get_person: 'read',
  qq_memory_query: 'read', qq_slang_query: 'read', qq_get_prompt: 'read', qq_social_state: 'read', qq_status: 'read',
  qq_get_message_images: 'read', qq_list_stickers: 'read', qq_get_sticker_image: 'read', qq_list_voices: 'read',
  qq_get_self_image: 'read', qq_search_images: 'read', qq_preview_image: 'read', qq_cross_group_query: 'read',
  qq_schedule_list: 'read',
  // dsh-qq 1.1.2：自己的 QQ 空间和资料（只读，只在主人私聊里）
  qq_qzone_list: 'read', qq_qzone_feeds: 'read', qq_my_profile: 'read',
  // 和说话无关（qq_report_feedback / qq_request_mode_change 的文字只到主人那里，主人对记忆有全部知情权，§9.3.7）
  qq_mark_read: 'none', qq_set_wake_config: 'none', qq_schedule_delete: 'none', qq_memory_remove: 'none',
  qq_memory_clear: 'none', qq_report_feedback: 'none', qq_request_mode_change: 'none',
  // dsh-qq 1.1.2：撤回自己的消息；QQ 空间和签名、昵称这些只在主人私聊里可用、发出前桥接自己要主人确认（CONFIRM_NOTE），不算她对别人开口
  qq_recall: 'none', qq_qzone_post: 'none', qq_qzone_delete: 'none', qq_qzone_like: 'none', qq_qzone_comment: 'none',
  qq_set_signature: 'none', qq_set_nickname: 'none', qq_set_online_status: 'none', qq_set_input_status: 'none',
});
export const HOST_TOOL_CLASSES = Object.freeze({ snowluma_status: 'none' });
/**
 * DSH 自带、但在 QQ 会话里会被桥接转述进那个 QQ 会话的工具（只在 QQ 适配器认领的会话里算，ToolDecl.sessionScoped）：
 * ask_user_question 的问题和选项，桥接收到 question/requested 后原样发进这个会话（「❓ agent 需要你回答：…」）。
 */
export const RELAYED_BUILTINS = Object.freeze({ ask_user_question: 'speak' });
/**
 * 她的话会不会以「她自己的一行」回流到 social-v2（桥接的 send-message / send-burst / /api/send/* 会调 recordSentMessagesV2）。
 * 回流的由适配器交 self-utterance、核心按令牌或（场合、文本哈希、时间窗）对账；不回流的（表情、语音、拍一拍、写进别处的）
 * 宿主在 outcome 里带上原文，由核心自己生成她说过的那条感知（§9.5，DshBinding 的 ToolDecl.returns）。
 */
const RETURNS = new Set(['qq_send_message', 'qq_send_burst', 'qq_reply', 'qq_send_group_message', 'qq_send_private_message']);
/**
 * 读进来的不是别人写的文字（状态、配置、她自己的形象、表情清单）：不给这一轮打按轮污点（§9.6，ToolDecl.taints）。
 * 读者工具里的 messages / peek（本会话的群消息、替主人看的另一个群，D113）也不打：那是群里的人对她说的话，本来就逐条入库、带着说话人，
 * 不是来路不明的素材（原来几乎每一轮都因此带污点）。forward（合并转发的节点）照旧打污点。
 */
const NO_TAINT = new Set(['qq_status', 'qq_get_prompt', 'qq_social_state', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_list_voices',
  'qq_get_self_image', 'qq_schedule_list', 'qq_list_groups', 'qq_get_group_members', 'qq_get_active_members']);
const READERS = Object.freeze({
  qq_get_unread_messages: 'messages', qq_get_recent_messages: 'messages', qq_wait_for_messages: 'messages',
  qq_get_message_detail: 'messages', qq_get_my_recent_messages: 'messages', qq_owner_peek_group: 'peek', qq_get_forward_msg: 'forward',
});

const SPEAKING = new Set(['speak', 'defer', 'standing', 'persist-foreign']);
const MAX_PART = 8000;
const strings = (v) => (Array.isArray(v) ? v : [v]).filter((s) => typeof s === 'string').map((s) => s.slice(0, MAX_PART));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 审的必须是桥接真正发出去的那句（评审：模型把话写成 JSON 字符串时，桥接会解出来再发）。
// 桥接对 messages 的兼容（mcp-snowluma-safe.js 的工具处理函数一次、bridge.js 的 /api/socialV2/send-message、send-burst 再一次）：
//   以 [ 开头、解得出数组 → 每个元素 String(x)；以 " 开头、解得出字符串 → 那个字符串，解得出数组 → 同上；其余原样。
// 单条消息的工具（qq_reply、qq_send_group_message、qq_send_private_message）只解 "…"（unquoteJsonString，也是两层各一次），不认数组。
function decodeMessages(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('[') && !t.startsWith('"')) return v;
  try {
    const p = JSON.parse(t);
    if (Array.isArray(p)) return p.map(String);
    if (typeof p === 'string' && t.startsWith('"')) return p;
  } catch { /* 当普通文字 */ }
  return v;
}
function unquoteJsonString(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('"')) { try { const p = JSON.parse(t); if (typeof p === 'string') return p; } catch { /* 原样 */ } }
  return v;
}
/** messages：和桥接一样解两层；数组的每个元素 String()、去首尾空白、丢掉空的。 */
export function messagesArg(v) {
  let x = decodeMessages(v);
  if (!Array.isArray(x)) x = decodeMessages(x);
  const list = Array.isArray(x) ? x.map((m) => String(m ?? '')) : typeof x === 'string' ? [x] : [];
  return list.map((m) => m.trim()).filter(Boolean).map((m) => m.slice(0, MAX_PART));
}
/** message（单条）：和桥接一样只解 "…"，两层。 */
export function singleMessageArg(v) {
  if (typeof v !== 'string') return [];
  const m = String(unquoteJsonString(unquoteJsonString(v))).trim();
  return m ? [m.slice(0, MAX_PART)] : [];
}
const idArg = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '');
const keyFrom = (kind, v) => { const id = idArg(v); return id ? canonicalKey(`${kind}:${id}`) : null; };

/** 定时任务的延时（毫秒）。只用来告诉核心「有延时」；算不准时给 1 分钟。 */
function scheduleDelay(task, now) {
  const s = task?.schedule;
  if (s?.type === 'once' && typeof s.date === 'string' && typeof s.time === 'string' && (!task.timezone || task.timezone === 'Asia/Shanghai')) {
    const t = Date.parse(`${s.date}T${s.time.length === 5 ? `${s.time}:00` : s.time}+08:00`);
    if (Number.isFinite(t)) return Math.max(1000, t - now);
  }
  return 60_000;
}

/**
 * @typedef {object} ToolHelpers
 * @property {(key: string) => string} settingOf          key → SettingId（顺手登记，describeSetting 认得它）
 * @property {(settingId: string) => (string|null)} keyOf
 * @property {() => string[]} knownKeys                   桥接里所有会话（写进全局存储的话，受众是它们的并集）
 * @property {() => (string|null)} principalKey          主人私聊的 key（配置里没有主人时为 null）
 * @property {(id: unknown) => (ScheduledTask|null)} [scheduledTask]   桥接 state/scheduler.json 里的这个任务（读不到、没有这个编号为 null）
 * @property {() => number} now
 * @property {string} [prefix]
 * @property {string} [hostPrefix]
 */

/**
 * @typedef {{id: number, kind: 'text'|'ai', name: string, text: string, instruction: string, targets: string[],
 *            schedule: {type?: string, date?: string, time?: string}|null, timezone: string|null, byHer: boolean}} ScheduledTask
 */

/** 改定时任务时，补丁里这些字段会改变「发什么、发给谁」；其余（时间、次数、时区……）不说新的话。 */
const SCHEDULE_CONTENT_KEYS = ['kind', 'text', 'instruction', 'targets', 'name'];

/**
 * 全部工具声明（DshBinding.tools）。说话类的都有 resolve；还多给一个 resolveAll：一次调用会落到几个场合时
 * （定时任务的多个目标、写进全局存储的笔记），逐个场合各给一个 Utterance，宿主应该逐个审（取 resolve 只拿到最外扩的那一个）。
 * @param {ToolHelpers} h
 */
export function qqToolDecls(h) {
  const prefix = h.prefix ?? DEFAULT_MCP_PREFIX;
  const hostPrefix = h.hostPrefix ?? DEFAULT_HOST_PREFIX;
  const homeKey = (exec) => (exec?.homeSettingId ? h.keyOf(exec.homeSettingId) : null);
  const argKey = (a, exec) => canonicalKey(a?.key) ?? homeKey(exec);

  function utter(key, text, exec, x = {}) {
    if (!key) return null;
    const parts = text.filter((s) => s.trim()).slice(0, 16);
    const media = x.media?.length ? x.media : undefined;
    if (!parts.length && !media) return null;
    const { kind, id } = splitKey(key);
    const origin = { path: 'tool' };
    if (typeof exec?.sessionId === 'string' && exec.sessionId) origin.sessionId = exec.sessionId;
    if (typeof exec?.callId === 'string' && exec.callId) origin.callId = exec.callId;
    if (typeof exec?.homeSettingId === 'string' && exec.homeSettingId) origin.homeSettingId = exec.homeSettingId;
    const channel = { targetSettingId: h.settingOf(key), persistence: x.persistence ?? 'once' };
    if (x.delayMs) channel.delayMs = x.delayMs;
    if (kind === 'private') channel.addressee = peerActor(id);
    if (x.notifies) channel.notifies = [peerActor(x.notifies)];
    if (x.formHint) channel.formHint = x.formHint;
    return { channel, text: parts, ...(media ? { media } : {}), origin };
  }
  /** 多个目标按「最可能外扩」排：群在前，别人的私聊其次，主人私聊最后。 */
  const exposureOrder = (keys) => {
    const pk = h.principalKey();
    const rank = (k) => (k.startsWith('group:') ? 0 : k === pk ? 2 : 1);
    return [...new Set(keys.filter(Boolean))].sort((a, b) => rank(a) - rank(b));
  };
  const everywhere = () => exposureOrder(h.knownKeys());

  /** @type {Record<string, (a: any, exec: any) => any[]>} 每个说话类工具：参数 → 若干 Utterance */
  const R = {
    qq_send_message: (a, x) => [utter(argKey(a, x), messagesArg(a?.messages), x, { notifies: idArg(a?.atUserId) || undefined, formHint: '消息' })],
    qq_send_burst: (a, x) => [utter(keyFrom('group', a?.groupId) ?? homeKey(x), messagesArg(a?.messages), x, { formHint: '消息' })],
    qq_reply: (a, x) => [utter(keyFrom('group', a?.groupId) ?? homeKey(x), singleMessageArg(a?.message), x, { formHint: '引用回复' })],
    qq_send_group_message: (a, x) => [utter(keyFrom('group', a?.groupId) ?? homeKey(x), singleMessageArg(a?.message), x, { formHint: '消息' })],
    qq_send_private_message: (a, x) => [utter(keyFrom('private', a?.userId) ?? homeKey(x), singleMessageArg(a?.message), x, { formHint: '私聊消息' })],
    qq_send_sticker: (a, x) => [utter(argKey(a, x), [], x, { media: [{ kind: 'sticker' }], notifies: idArg(a?.atUserId) || undefined, formHint: '表情' })],
    qq_send_voice: (a, x) => [utter(argKey(a, x), [], x, { media: [typeof a?.label === 'string' && a.label.trim() ? { kind: 'voice', summary: a.label.slice(0, 200) } : { kind: 'voice' }], formHint: '语音' })],
    qq_speak: (a, x) => [utter(argKey(a, x), strings(a?.text), x, { media: [{ kind: 'voice' }], formHint: '语音' })],
    qq_send_web_image: (a, x) => [utter(argKey(a, x), [], x, { media: [{ kind: 'image' }], formHint: '图片' })],
    qq_send_poke: (a, x) => [utter(argKey(a, x), [], x, { media: [{ kind: 'poke' }], notifies: idArg(a?.targetUserId) || undefined, formHint: '拍一拍' })],
    // 把一段意图带进她在另一个群的会话：目标是那个群
    qq_ask_group_session: (a, x) => [utter(keyFrom('group', a?.targetGroupId), strings(a?.instruction), x, { formHint: '托付进另一个群的会话' })],
    qq_schedule_create: (a, x) => scheduleUtterances(a?.task, a, x),
    // 改任务：桥接把补丁和存着的任务合起来（validateTask：targets / kind / text / instruction 缺了就用原来的），
    // 所以要审的是「合起来以后发什么、发给谁」。不知道这个任务现在是什么样（没有这个编号、读不到 scheduler.json）就审不了
    qq_schedule_update: (a, x) => {
      if (a?.action !== 'update') return [];
      const existing = h.scheduledTask?.(a?.id) ?? null;
      if (!existing) return [];
      const p = isObj(a?.task) ? a.task : {};
      return scheduleUtterances({
        kind: p.kind ?? existing.kind, name: p.name ?? existing.name, text: p.text ?? existing.text, instruction: p.instruction ?? existing.instruction,
        targets: Array.isArray(p.targets) ? p.targets : existing.targets, schedule: p.schedule ?? existing.schedule, timezone: p.timezone ?? existing.timezone,
      }, a, x);
    },
    qq_owner_group_rule: (a, x) => (a?.action === 'add'
      ? [utter(keyFrom('group', a?.targetGroupId), strings(a?.text), x, { persistence: 'recurring-context', formHint: '群长期规则' })] : []),
    // 桥接的笔记：只在当前会话可见；share=true 申请跨群共享，受众按全部会话算
    qq_note_person: (a, x) => (a?.share === true ? everywhere() : [argKey(a, x)])
      .map((k) => utter(k, strings(a?.content), x, { persistence: 'recurring-context', formHint: '桥接人物笔记' })),
    qq_memory_append: (a, x) => [utter(argKey(a, x), [...strings(a?.content), ...strings(a?.extra?.pendingQuestion)], x, { persistence: 'recurring-context', formHint: '桥接轻量记忆' })],
    // 黑话库、表情库是全局的：以后每个会话都可能看到
    qq_slang_submit: (a, x) => everywhere().map((k) => utter(k, [...strings(a?.content), ...strings(a?.context)], x, { persistence: 'recurring-context', formHint: '黑话库' })),
    qq_sticker_note: (a, x) => everywhere().map((k) => utter(k, [...strings(a?.note), ...strings(a?.usage), ...(Array.isArray(a?.tags) ? [strings(a.tags).join(' ')] : [])], x, { persistence: 'recurring-context', formHint: '表情笔记' })),
    qq_set_sticker_remark: (a, x) => everywhere().map((k) => utter(k, strings(a?.remark), x, { persistence: 'recurring-context', formHint: '表情备注' })),
    qq_collect_sticker: (a, x) => everywhere().map((k) => utter(k, strings(a?.remark), x, { persistence: 'recurring-context', formHint: '表情收藏备注' })),
  };
  function scheduleUtterances(task, a, x) {
    if (!task || typeof task !== 'object') return [];
    // 「叫 AI 来说」的任务：到点时桥接把任务名和说明交给目标会话（bridge.js 的定时任务提示），两样都审
    const text = task.kind === 'ai' ? [...strings(task.name), ...strings(task.instruction)] : strings(task.text);
    const targets = (Array.isArray(task.targets) ? task.targets : []).map(canonicalKey).filter(Boolean);
    const keys = targets.length ? targets : [h.principalKey() ?? argKey(a, x)];   // 桥接默认只发给主人私聊
    const recurring = task.schedule?.type && task.schedule.type !== 'once';
    return exposureOrder(keys).map((k) => utter(k, text, x, {
      delayMs: scheduleDelay(task, h.now()), persistence: recurring ? 'recurring-context' : 'once', formHint: task.kind === 'ai' ? '定时托付' : '定时消息',
    }));
  }

  /**
   * 这一次调用没说新的话（宿主不审直接放行，ToolDecl.silent）。说话类工具里只有这几种动作是「什么都不说」的；
   * 拿不准的一律 false（再 resolve 不出目标就 fail closed）。
   * @type {Record<string, (a: any) => boolean>}
   */
  const SILENT = {
    qq_schedule_update: (a) => a?.action === 'pause' || a?.action === 'resume'
      || (a?.action === 'update' && !SCHEDULE_CONTENT_KEYS.some((k) => isObj(a?.task) && a.task[k] !== undefined)),
    qq_owner_group_rule: (a) => a?.action === 'list' || a?.action === 'remove',
  };
  // DSH 自带、QQ 会话里会被桥接转述的工具（只在这个适配器认领的会话里算）
  const RELAYED = {
    ask_user_question: (a, x) => {
      const qs = Array.isArray(a?.questions) ? a.questions.slice(0, 16) : [];
      const text = qs.flatMap((q) => [...strings(q?.question), ...(Array.isArray(q?.options) ? q.options.map((o) => o?.label).filter((l) => typeof l === 'string') : [])]);
      return [utter(homeKey(x), text, x, { formHint: '提问' })];
    },
  };

  const decls = [];
  const withResolvers = (d, all) => {
    d.resolveAll = (args, exec) => { try { return all(args, exec).filter(Boolean); } catch { return []; } };
    d.resolve = (args, exec) => d.resolveAll(args, exec)[0] ?? null;
  };
  for (const [bare, cls] of Object.entries(QQ_TOOL_CLASSES)) {
    const d = { tool: `${prefix}${bare}`, class: cls };
    const all = R[bare];
    if (all) withResolvers(d, all);
    if (SILENT[bare]) { const q = SILENT[bare]; d.silent = (args) => { try { return q(args) === true; } catch { return false; } }; }
    if (SPEAKING.has(cls)) d.returns = RETURNS.has(bare);
    if (cls === 'read') d.taints = !NO_TAINT.has(bare) && READERS[bare] !== 'messages' && READERS[bare] !== 'peek';
    if (READERS[bare]) d.reader = READERS[bare];
    if (FROZEN_BARE.includes(bare)) d.frozen = true;
    decls.push(d);
  }
  for (const [bare, cls] of Object.entries(HOST_TOOL_CLASSES)) decls.push({ tool: `${hostPrefix}${bare}`, class: cls });
  for (const [name, cls] of Object.entries(RELAYED_BUILTINS)) {
    const d = { tool: name, class: cls, sessionScoped: true, returns: false };   // 桥接转述的问题不记回 social-v2：原文交给 outcome
    withResolvers(d, RELAYED[name]);
    decls.push(d);
  }
  return decls;
}
