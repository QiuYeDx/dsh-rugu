// context 自己拼的那几句话的小工具：绝对时间、「多久以前」、按字数截断、清洗、哈希。
// 只管格式，不做判断（能不能说由关口①决定，这里拿到的都是已经判过的条目）。
import crypto from 'node:crypto';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

function offsetMs(at, tzOffsetMin) {
  return (tzOffsetMin == null ? -new Date(at).getTimezoneOffset() : tzOffsetMin) * MINUTE_MS;
}
/** 本地时间 'YYYY-MM-DD HH:MM'（注入里一律写绝对时间，F25）。 */
export function fmtTime(at, tzOffsetMin) {
  const iso = new Date(at + offsetMs(at, tzOffsetMin)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
/** 本地日期 'YYYY-MM-DD'。 */
export function fmtDate(at, tzOffsetMin) {
  return new Date(at + offsetMs(at, tzOffsetMin)).toISOString().slice(0, 10);
}
/** 短一点的绝对时间：和 now 同一年写 'MM-DD HH:MM'，跨年写全（条目里的附注用，仍然是绝对时间，F25）。 */
export function fmtShort(at, tzOffsetMin, now) {
  const full = fmtTime(at, tzOffsetMin);
  return full.slice(0, 4) === fmtTime(now, tzOffsetMin).slice(0, 4) ? full.slice(5) : full;
}
/** 本地日的开始（UTC 毫秒）。 */
export function dayStart(at, tzOffsetMin) {
  const off = offsetMs(at, tzOffsetMin);
  return Math.floor((at + off) / DAY_MS) * DAY_MS - off;
}

/** 一段时长的口语说法：「3 小时」「2 天」「3 周」「约 2 个月」。 */
export function humanSpan(ms) {
  const m = Math.max(0, ms);
  if (m < HOUR_MS) return `${Math.max(1, Math.round(m / MINUTE_MS))} 分钟`;
  if (m < DAY_MS) return `${Math.round(m / HOUR_MS)} 小时`;
  if (m < 14 * DAY_MS) return `${Math.round(m / DAY_MS)} 天`;
  if (m < 60 * DAY_MS) return `${Math.round(m / (7 * DAY_MS))} 周`;
  if (m < 365 * DAY_MS) return `约 ${Math.round(m / (30 * DAY_MS))} 个月`;
  return `约 ${Math.round(m / (365 * DAY_MS))} 年`;
}

/** 字数（按码点，不按 UTF-16）。 */
export const charLen = (s) => Array.from(String(s ?? '')).length;

/** 截到 max 个字，超了用「…」收尾。 */
export function clip(s, max) {
  const a = Array.from(String(s ?? ''));
  if (a.length <= max) return a.join('');
  if (max <= 1) return max === 1 ? '…' : '';
  return `${a.slice(0, max - 1).join('')}…`;
}

/** 截到 max 个字，尽量停在句子边界（核心自我这类整段文字用；找不到合适的边界就硬截）。 */
export function clipSentence(s, max) {
  const a = Array.from(String(s ?? ''));
  if (a.length <= max) return a.join('');
  const head = a.slice(0, max);
  for (let i = head.length - 1; i >= Math.floor(max * 0.6); i--) {
    if (/[。！？!?\n；;]/u.test(head[i])) return head.slice(0, i + 1).join('').trimEnd();
  }
  return clip(s, max);
}

// 控制字符、零宽字符、方向控制符（按码点列出，源码里不放这些字符本身）
const INVISIBLE = new RegExp(`[${[[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
  .map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`, 'gu');
function hex(n) { return `\\u{${n.toString(16)}}`; }

/**
 * 注入前的清洗（intake.sanitizeForPrompt）。intake 出错时退回最小的通用清洗（去控制字符和不可见字符、【】换「」、折叠换行），
 * 宁可多洗，不让没洗过的文字进上下文。
 */
export function sanitize(core, text) {
  const s = String(text ?? '');
  try {
    const out = core.mods.intake.sanitizeForPrompt(core, s);
    if (typeof out === 'string') return out;
  } catch { /* 退回下面的最小清洗 */ }
  return s.replace(INVISIBLE, '')
    .replace(/【/g, '「').replace(/】/g, '」').replace(/\s*\n+\s*/g, ' ').trim();
}

export const hash16 = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);
export const newTraceId = () => `ctx-${crypto.randomBytes(6).toString('hex')}`;

export function safeJson(s, fallback) {
  if (s == null) return fallback;
  try {
    const v = JSON.parse(s);
    if (Array.isArray(fallback)) return Array.isArray(v) ? v : fallback;
    return v && typeof v === 'object' ? v : fallback;
  } catch { return fallback; }
}
