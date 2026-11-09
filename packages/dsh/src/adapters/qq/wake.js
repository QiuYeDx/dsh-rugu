// 桥接发进 DSH 会话的唤醒消息、读消息工具的结果：认出唤醒头、取出消息快照（§11.1 来源 E、C1）。
// 唤醒头不在消息第一行（C1）：逐行扫描，要求恰好一个，而且头后面的会话 key 和这个会话绑定的场合一致；
// 不一致（没有、多个、对不上）就停掉这个会话的感知和注入，交给宿主报警。
// 快照只认尾锚：单独一行「【本次消息快照】」，下一行是 JSON，再下一行以桥接的固定结尾开头；有好几份时取最后一份。
// 群友的话在快照 JSON 里（JSON.stringify 把换行转义了），伪造不出这样的三行。
import { canonicalKey } from './files.js';
import { isRecord, parseJson } from '../util.js';

export const WAKE_HEADERS = Object.freeze(['【唤醒】', '【回复检查】', '【主动机会】', '【引导唤醒】']);
const KEY = '((?:group|private):[A-Za-z0-9_-]{1,64})';
const HEADER_RES = [
  new RegExp(`【(?:唤醒|回复检查|主动机会)】${KEY}`),
  new RegExp(`【引导唤醒】你已接入 QQ 会话 ${KEY}`),
];
const SNAPSHOT_HEAD = '【本次消息快照】';
const SNAPSHOT_TAIL = '以上消息已提供，无需重复查询';

/**
 * 逐行找唤醒头（快照那一行 JSON 不算）。
 * @param {string} text
 * @returns {{count: number, key: string|null}}
 */
export function scanWake(text) {
  let count = 0;
  let key = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trimStart();
    if (t.startsWith('{')) continue;
    for (const re of HEADER_RES) {
      const m = re.exec(t);
      if (m) { count += 1; key = canonicalKey(m[1]); break; }
    }
  }
  return { count, key };
}

/**
 * C1：恰好一个唤醒头，而且头里的会话就是绑定的那个。
 * @param {string} text
 * @param {(key: string) => string} settingOf
 * @param {string} boundSettingId
 * @returns {{ok: boolean, reason: 'ok'|'no-header'|'multiple'|'mismatch', key: string|null}}
 */
export function wakeCheck(text, settingOf, boundSettingId) {
  const { count, key } = scanWake(text);
  if (count === 0) return { ok: false, reason: 'no-header', key: null };
  if (count > 1) return { ok: false, reason: 'multiple', key: null };
  if (!key || settingOf(key) !== boundSettingId) return { ok: false, reason: 'mismatch', key: null };
  return { ok: true, reason: 'ok', key };
}

/**
 * 取尾锚快照。
 * @param {string} text
 * @returns {{messages: unknown[], recent: unknown[]}|null}
 */
export function extractSnapshot(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 3; i >= 0; i--) {
    if (lines[i].trim() !== SNAPSHOT_HEAD || !lines[i + 2].startsWith(SNAPSHOT_TAIL)) continue;
    const p = parseJson(lines[i + 1]);
    if (!p.ok || !isRecord(p.value)) return null;
    const v = p.value;
    return { messages: Array.isArray(v.messages) ? v.messages : [], recent: Array.isArray(v.recent) ? v.recent : [] };
  }
  return null;
}

/** 消息里的文字块拼起来（DSH 消息的 content 可能是字符串，也可能是块数组）。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * 读消息工具的结果里有哪些消息。桥接把数据序列化成一段 JSON 文本（serializeModelData）；
 * 合并转发的结果前面可能多一段图片说明，所以每个文字块都试一下。
 * @param {unknown} content      工具结果：字符串、块数组，或已经解析好的对象
 * @returns {unknown[]}
 */
export function messagesInResult(content) {
  const datas = [];
  if (isRecord(content) && !Array.isArray(content.content)) datas.push(content);
  else {
    const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content
      : isRecord(content) && Array.isArray(content.content) ? content.content : [];
    for (const b of blocks) {
      const t = typeof b === 'string' ? b : isRecord(b) && b.type === 'text' ? b.text : null;
      if (typeof t !== 'string') continue;
      const p = parseJson(t);
      if (p.ok && isRecord(p.value)) datas.push(p.value);
    }
  }
  const out = [];
  for (const d of datas) {
    for (const k of ['messages', 'newMessages', 'recent']) if (Array.isArray(d[k])) out.push(...d[k]);
    if (isRecord(d.message)) out.push(d.message);
    else if (out.length === 0 && (typeof d.text === 'string' || typeof d.plain === 'string') && Number.isFinite(d.time)) out.push(d);
  }
  return out.slice(0, 500);
}
