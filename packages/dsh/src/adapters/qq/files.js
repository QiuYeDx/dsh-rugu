// QQ 桥接落盘文件的投影（§11.1）：只取白名单字段，原始对象读完就丢。
// 桥接不改；字段来自只读核对桥接代码（v0-桥接核实.md、v2-感知通道与适配契约.md §2.1）：
//   state/social-v2.json   {paused, conversations: {<key>: {recentMessages, unread, lastUnreadSeq, lastReadThroughSeq, lastIncomingAt,
//                           ownerRules, agentToken(会话秘密，丢掉), memberImpressions/activeTopics/pendingThoughts(桥接自己的记忆，不读)…}}}
//   state/mode.json        {mode}：只有二代模式（reserved2，别名 simulation）才写 social-v2（H3）
//   state/sessions.json    {sessions: {<key>: <DSH 会话 id>}, dormantSessions: {<key>: {sessionId}}}
//   state/initial-prompts.json  {<key>: {text}}：操作者写的私聊 / 群聊环境说明
//   state/scheduler.json   {tasks: [{id, kind, name, text, instruction, targets, schedule, timezone, createdBy}]}：只读核对「以她名义」的
//                          定时文字（§9.5），改任务时按存着的任务合并补丁（关口②要审合起来以后发什么、发给谁）
//   config.json            ownerQQ、allow / deny、continuity.groups.<群>.{label, recordable}、preset 和工作目录、snowluma.homeDir（D111）；
//                          这个文件里有令牌，只取下面列出的几项，其余立刻丢掉，绝不进日志
import { createHash } from 'node:crypto';
import { isRecord, BAD_KEYS } from '../util.js';

/** 会话 key：group:<id> / private:<id>。纯数字去掉前导零（和桥接的 canonicalV2Key 一致）；别的字符只在测试和以后的桥接里出现。 */
const KEY_RE = /^(group|private):([A-Za-z0-9_-]{1,64})$/;
/**
 * @param {unknown} k
 * @returns {string|null}
 */
export function canonicalKey(k) {
  const m = KEY_RE.exec(String(k ?? '').trim());
  if (!m) return null;
  let id = m[2];
  if (/^\d+$/.test(id)) {
    id = id.replace(/^0+(?=\d)/, '');
    if (id === '0') return null;
  }
  return `${m[1]}:${id}`;
}
/** key 的种类和对方 id。 */
export function splitKey(key) {
  const i = key.indexOf(':');
  return { kind: /** @type {'group'|'private'} */ (key.slice(0, i)), id: key.slice(i + 1) };
}

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const idStr = (v) => {
  const s = str(v, 64);
  return s && /^[A-Za-z0-9_-]+$/.test(s) ? s : undefined;
};
const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const time = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? v : undefined);

/**
 * 【D118】合并转发 id 的指纹：先按桥接的 sanitizeForwardId 清洗（去首尾空白、≤ 256 字、只许常见的资源 id 字符），
 * 再取 sha256 的前 16 位十六进制。原始 id 只在桥接里；适配器内存里只认指纹（谁转来的这份，qq-bridge.js 的转发人表），不进库、不进日志。
 * @param {unknown} v
 * @returns {string|null}
 */
export function forwardKey(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 256 || !/^[\w:.\-/=+@]+$/.test(s)) return null;
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
const forwardKeys = (a) => {
  const ks = Array.isArray(a) ? [...new Set(a.slice(0, 32).map(forwardKey).filter(Boolean))] : [];
  return ks.length ? ks : undefined;
};

/**
 * 一条消息的投影。没有时间的丢掉（时间是去重键和游标的一部分）。
 * 丢掉的字段：ownerLabel（里面有主人账号原值）、media 的 file / url / emojiId（定位信息，可能带签名）、
 * forwardIds（只留有没有，和每个 id 的指纹 forwardKeys——【D118】她打开那份转发时认得出是谁发来的）。
 * @param {unknown} m
 */
export function projectMessage(m) {
  if (!isRecord(m)) return null;
  // 桥接记「我发了条语音」的那一行用的是 at 不是 time（recordVoiceSentV2）
  const at = time(m.time) ?? time(m.at);
  if (at === undefined) return null;
  const media = Array.isArray(m.media) ? m.media.filter(isRecord).slice(0, 16).map((x) => {
    const kind = typeof x.kind === 'string' && /^[a-z]{1,16}$/.test(x.kind) ? x.kind : 'image';
    const summary = str(x.summary, 120);
    return summary ? { kind, summary } : { kind };
  }) : [];
  const out = {
    seq: int(m.seq),
    messageId: str(m.messageId, 64),
    sender: str(m.sender, 120),
    userId: idStr(m.userId),
    text: str(m.text) ?? '',
    plain: str(m.plain),
    tail: str(m.tail),
    quoteTargetIsSelf: m.quoteTargetIsSelf === true,
    isOwner: m.isOwner === true,
    isSelf: m.isSelf === true,
    kind: typeof m.kind === 'string' && /^[a-z_-]{1,24}$/.test(m.kind) ? m.kind : undefined,
    media,
    hasForward: m.hasForward === true || (Array.isArray(m.forwardIds) && m.forwardIds.length > 0),
    forwardKeys: forwardKeys(m.forwardIds),
    poke: isRecord(m.poke) ? { targetId: idStr(m.poke.targetId), targetIsSelf: m.poke.targetIsSelf === true } : undefined,
    time: at,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
/** @typedef {NonNullable<ReturnType<typeof projectMessage>>} BridgeMessage */

/**
 * social-v2.json 的投影：只有会话里的消息流、计数和管理员写的群规。没有 agentToken，没有桥接自己的记忆。
 * @param {unknown} raw
 * @returns {{paused: boolean, conversations: Map<string, {recent: BridgeMessage[], unread: BridgeMessage[],
 *   lastUnreadSeq: number, lastReadThroughSeq: number, lastIncomingAt: number, ownerRules: {id: number, text: string, at: number}[]}>}}
 */
export function projectSocial(raw) {
  const conversations = new Map();
  if (!isRecord(raw)) return { paused: false, conversations };
  const convs = isRecord(raw.conversations) ? raw.conversations : {};
  for (const [k, v] of Object.entries(convs)) {
    if (BAD_KEYS.has(k) || !isRecord(v)) continue;
    const key = canonicalKey(k);
    if (!key) continue;
    const list = (a) => (Array.isArray(a) ? a.map(projectMessage).filter(Boolean) : []);
    const ownerRules = Array.isArray(v.ownerRules) ? v.ownerRules.filter(isRecord).map((r) => ({
      id: int(r.id) ?? 0, text: (str(r.text, 400) ?? '').trim(), at: time(r.at) ?? 0,
    })).filter((r) => r.id > 0 && r.text).slice(-20) : [];
    conversations.set(key, {
      recent: list(v.recentMessages),
      unread: list(v.unread),
      lastUnreadSeq: int(v.lastUnreadSeq) ?? 0,
      lastReadThroughSeq: int(v.lastReadThroughSeq) ?? 0,
      lastIncomingAt: time(v.lastIncomingAt) ?? 0,
      ownerRules,
    });
  }
  return { paused: raw.paused === true, conversations };
}

/** 桥接模式（H3）：别名归一，和桥接的 MODE_INPUT_ALIASES 一致。 */
const MODES = { chat: 'chat', reserved: 'reserved', reserved2: 'reserved2', simulation: 'reserved2', 'closed-agent': 'closed-agent' };
export function projectMode(raw) {
  const m = isRecord(raw) && typeof raw.mode === 'string' ? MODES[raw.mode.trim()] ?? null : null;
  return { mode: m };
}
/** 二代模式才写 social-v2。 */
export const isSecondGen = (mode) => mode === 'reserved2';

/**
 * sessions.json：DSH 会话 id → 会话 key（含休眠的会话）。
 * @returns {Map<string, string>}
 */
export function projectSessions(raw) {
  const out = new Map();
  if (!isRecord(raw)) return out;
  const add = (k, sid) => {
    const key = canonicalKey(k);
    if (key && typeof sid === 'string' && sid && sid.length <= 200) out.set(sid, key);
  };
  if (isRecord(raw.sessions)) for (const [k, v] of Object.entries(raw.sessions)) if (!BAD_KEYS.has(k)) add(k, v);
  if (isRecord(raw.dormantSessions)) for (const [k, v] of Object.entries(raw.dormantSessions)) if (!BAD_KEYS.has(k) && isRecord(v)) add(k, v.sessionId);
  return out;
}

const idList = (a) => (Array.isArray(a) ? a.map(idStr).filter(Boolean).slice(0, 2000) : []);
/**
 * config.json 的投影。令牌、端口、模型、人设一概不取。
 * @param {unknown} raw
 */
export function projectBridgeConfig(raw) {
  const c = isRecord(raw) ? raw : {};
  const allow = isRecord(c.allow) ? c.allow : {};
  const deny = isRecord(c.deny) ? c.deny : {};
  const groups = new Map();
  const cg = isRecord(c.continuity) && isRecord(c.continuity.groups) ? c.continuity.groups : {};
  for (const [gid, g] of Object.entries(cg)) {
    const id = idStr(gid);
    if (!id || BAD_KEYS.has(gid) || !isRecord(g)) continue;
    groups.set(id, { label: (str(g.label, 60) ?? '').trim() || undefined, recordable: g.recordable !== false });
  }
  const preset = (v) => (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? v : undefined);
  return {
    ownerId: idStr(c.ownerQQ),
    allow: { private: idList(allow.private ?? allow.privates), group: idList(allow.groups ?? allow.group) },
    deny: { private: idList(deny.private ?? deny.privates), group: idList(deny.groups ?? deny.group) },
    allowAllWhenEmpty: c.allowAllWhenEmpty === true,
    groups,
    presets: [preset(isRecord(c.socialV2) ? c.socialV2.agentPreset : undefined), preset(c.agentPreset)].filter(Boolean),
    sessionCwd: typeof c.sessionCwd === 'string' && c.sessionCwd.length <= 400 ? c.sessionCwd : '',
    // 【D111】SnowLuma 的安装目录（只是一个路径，不是秘密）：平台上的群名从它的缓存库里被动地读（qq/names.js）。同一段里的令牌、地址不取
    snowlumaHome: isRecord(c.snowluma) && typeof c.snowluma.homeDir === 'string' && c.snowluma.homeDir.length <= 400 ? c.snowluma.homeDir : '',
  };
}
/** @typedef {ReturnType<typeof projectBridgeConfig>} BridgeConfig */

/**
 * 这个会话在不在桥接的白名单里（和桥接的 allowed() 一致）。读不到配置时返回 null（不知道）。
 * @param {BridgeConfig|null} cfg
 * @param {string} key
 */
export function allowedByBridge(cfg, key) {
  if (!cfg) return null;
  const { kind, id } = splitKey(key);
  if (cfg.deny[kind].includes(id)) return false;
  const list = cfg.allow[kind];
  if (list.length > 0) return list.includes(id);
  return cfg.allowAllWhenEmpty;
}

/** initial-prompts.json：key → 环境说明文字。 */
export function projectInitialPrompts(raw) {
  const out = new Map();
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = canonicalKey(k);
    if (!key || BAD_KEYS.has(k)) continue;
    const text = (str(isRecord(v) ? v.text : v, 2000) ?? '').trim();
    if (text) out.set(key, text);
  }
  return out;
}

/**
 * scheduler.json：任务的 id、种类（固定文字 text / 叫 AI 来说 ai）、名字、文字或说明、目标、时间规则的类型和一次性任务的日期时间、
 * 时区，以及是不是她自己登记的（owner-chat-ai）。用来核对「以她名义」（只看固定文字的）和改任务时合并补丁（§11.1：桥接按存着的任务补全）。
 */
export function projectScheduler(raw) {
  const tasks = isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  return tasks.filter(isRecord).filter((t) => Number.isSafeInteger(t.id) && (t.kind === undefined || t.kind === 'text' || t.kind === 'ai')).slice(0, 500).map((t) => {
    const sc = isRecord(t.schedule) ? t.schedule : null;
    return {
      id: t.id,
      kind: t.kind === 'ai' ? 'ai' : 'text',
      name: str(t.name, 40) ?? '',
      text: str(t.text, 2000) ?? '',
      instruction: str(t.instruction, 2000) ?? '',
      targets: (Array.isArray(t.targets) ? t.targets : []).map(canonicalKey).filter(Boolean),
      schedule: sc ? { type: str(sc.type, 20), date: str(sc.date, 20), time: str(sc.time, 20) } : null,
      timezone: str(t.timezone, 64) ?? null,
      byHer: t.createdBy === 'owner-chat-ai',
    };
  });
}
