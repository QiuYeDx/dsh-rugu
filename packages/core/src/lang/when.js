// 时间说法（D148）：进她上下文的每一处「什么时候」都由代码按人感觉的方式算好，不让读的人自己和「现在」做减法
// （实测：小模型看到「11/11 21:39」不会算出是二十分钟前，同一块里又混着几天前的日期，把当天的事说成了好几天前的）。
//   - 几个小时以内（lang.timePhrase.agoH）以「多久以前」为主：今天的写「今晚 21:39 · 20 分钟前」；跨了午夜的写「40 分钟前（23:50）」，
//     不说「昨天」（凌晨 0:30 说 23:50 的事，人说的是「四十分钟前」）；
//   - 今天更早的「今天下午 16:20」；昨天「昨天晚上 22:14」；前天「前天下午」；一周内「周日（11/8）下午」；更早写日期，跨年带年；
//   - 以后的事：「今晚 21:00」「明天上午 9:30」「后天下午」「周六（11/14）」……
// 三种写法（style）：
//   full  上面那样（每一轮现算的块：想起来的、在场者近况、工作记忆、间隔那一句、工具结果）；
//   day   不带「多久以前」（会冻结一段时间的文字：常驻区、「讲过了」的附注），到天和钟点为止；
//   date  只到天（「今天」「昨天」「周日（11/8）」「10/31」：记不清的那几天、说个大概的那一条）。
// 只管说法，不做判断。核心不绑定语言：这里给 zh 的说法和一个和语言无关的兜底（绝对时间，别的语言的分析器以后可以给自己的）。
import { localClock, MINUTE_MS, HOUR_MS, DAY_MS } from './time.js';

/** 一天里的时段（小时 → 说法）。按人平常的叫法，不是精确的定义。 */
const ZH_PARTS = [[0, '凌晨'], [5, '早上'], [8, '上午'], [11, '中午'], [13, '下午'], [18, '晚上']];
const ZH_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function partOf(h) {
  let out = ZH_PARTS[0][1];
  for (const [h0, name] of ZH_PARTS) if (h >= h0) out = name;
  return out;
}
const pad2 = (n) => String(n).padStart(2, '0');
const clockOf = (p) => `${p.h}:${pad2(p.min)}`;
/** 本地日历上的第几天（只用来比两天差几天）。 */
const dayNo = (p) => Math.round(Date.UTC(p.y, p.m, p.d) / DAY_MS);
/** 「多久以前」：1 小时以内按分钟，以上按小时（四舍五入，至少 1）。 */
function zhAgo(ms) {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))} 分钟前`;
  return `${Math.max(1, Math.round(ms / HOUR_MS))} 小时前`;
}
/** 某一天叫什么（相对今天差 dd 天；正数是过去）：今天 / 昨天 / 前天 / 明天 / 后天；别的返回 null。 */
function zhDayWord(dd) {
  return { 0: '今天', 1: '昨天', 2: '前天', [-1]: '明天', [-2]: '后天' }[dd] ?? null;
}
/** 「今天晚上」说成「今晚」，别的照写（昨天晚上、明天上午……）。 */
function zhDayPart(word, part) {
  return word === '今天' && part === '晚上' ? '今晚' : `${word}${part}`;
}
function zhDate(p, now) {
  return p.y === now.y ? `${p.m + 1}/${p.d}` : `${p.y}/${p.m + 1}/${p.d}`;
}

/**
 * zh 的时间说法。
 * @param {number} t     要说的那个时刻（UTC 毫秒）
 * @param {number} now   现在（UTC 毫秒）
 * @param {{tzOffsetMin?: number|null, style?: 'full'|'day'|'date', agoH?: number}} [opt]
 * @returns {string}
 */
export function zhWhen(t, now, opt = {}) {
  if (!Number.isFinite(t) || !Number.isFinite(now)) return '';
  const style = opt.style ?? 'full';
  const agoMs = (Number.isFinite(opt.agoH) && opt.agoH >= 0 ? opt.agoH : 3) * HOUR_MS;
  const clock = localClock(opt.tzOffsetMin);
  const p = clock.parts(t);
  const n = clock.parts(now);
  const dd = dayNo(n) - dayNo(p);   // 正数：过去几天
  const d = now - t;
  const part = partOf(p.h);
  const word = zhDayWord(dd);
  const weekday = () => `${ZH_WEEK[p.wd]}（${p.m + 1}/${p.d}）`;
  if (style === 'date') {
    if (word) return word;
    if (Math.abs(dd) <= 6) return weekday();
    return zhDate(p, n);
  }
  // 刚才（含一分钟以内的时钟误差）
  if (style === 'full' && Math.abs(d) < MINUTE_MS) return '刚才';
  // 几个小时以内的过去：以「多久以前」为主
  if (style === 'full' && d > 0 && d < agoMs) {
    return dd === 0 ? `${zhDayPart('今天', part)} ${clockOf(p)} · ${zhAgo(d)}` : `${zhAgo(d)}（${clockOf(p)}）`;
  }
  if (dd === 0 || dd === 1 || dd === -1) return `${zhDayPart(word, part)} ${clockOf(p)}`;
  if (dd === 2 || dd === -2) return zhDayPart(word, part);
  if (Math.abs(dd) <= 6) return `${weekday()}${part}`;
  return zhDate(p, n);
}

/** zh：「现在」那一句的时间：「2026-11-11（周三）晚上 22:00」（年月日写全：这一句是整块的锚点，留在会话里也认得出是哪天）。 */
export function zhNow(at, opt = {}) {
  if (!Number.isFinite(at)) return '';
  const p = localClock(opt.tzOffsetMin).parts(at);
  return `${p.y}-${pad2(p.m + 1)}-${pad2(p.d)}（${ZH_WEEK[p.wd]}）${partOf(p.h)} ${clockOf(p)}`;
}

/** zh：一段时长：「20 分钟」「3 小时」「4 天」「3 周」「约 2 个月」「约 1 年」。 */
export function zhSpan(ms) {
  const m = Math.max(0, Number(ms) || 0);
  if (m < HOUR_MS) return `${Math.max(1, Math.round(m / MINUTE_MS))} 分钟`;
  if (m < DAY_MS) return `${Math.round(m / HOUR_MS)} 小时`;
  if (m < 14 * DAY_MS) return `${Math.round(m / DAY_MS)} 天`;
  if (m < 60 * DAY_MS) return `${Math.round(m / (7 * DAY_MS))} 周`;
  if (m < 365 * DAY_MS) return `约 ${Math.round(m / (30 * DAY_MS))} 个月`;
  return `约 ${Math.round(m / (365 * DAY_MS))} 年`;
}

// ── 和语言无关的兜底：绝对时间（没有给自己说法的语言用） ─────────────────
function isoParts(t, tz) {
  const p = localClock(tz).parts(t);
  return { ...p, date: `${p.y}-${pad2(p.m + 1)}-${pad2(p.d)}`, hm: `${pad2(p.h)}:${pad2(p.min)}` };
}
/** 兜底：同一年「MM-DD HH:MM」，跨年写全；date 只写日期。 */
export function undWhen(t, now, opt = {}) {
  if (!Number.isFinite(t) || !Number.isFinite(now)) return '';
  const p = isoParts(t, opt.tzOffsetMin);
  const n = isoParts(now, opt.tzOffsetMin);
  const date = p.y === n.y ? p.date.slice(5) : p.date;
  return opt.style === 'date' ? date : `${date} ${p.hm}`;
}
export function undNow(at, opt = {}) {
  if (!Number.isFinite(at)) return '';
  const p = isoParts(at, opt.tzOffsetMin);
  return `${p.date} ${p.hm}`;
}
export function undSpan(ms) {
  const m = Math.max(0, Number(ms) || 0);
  if (m < HOUR_MS) return `${Math.max(1, Math.round(m / MINUTE_MS))} min`;
  if (m < DAY_MS) return `${Math.round(m / HOUR_MS)} h`;
  return `${Math.round(m / DAY_MS)} d`;
}

/** 语言 → 说法（主标签）。不认识的用兜底。 */
export const PHRASINGS = Object.freeze({
  zh: Object.freeze({ when: zhWhen, now: zhNow, span: zhSpan }),
  und: Object.freeze({ when: undWhen, now: undNow, span: undSpan }),
});
export function phrasingFor(locale) {
  const l = String(locale ?? 'zh').toLowerCase().split(/[-_]/)[0];
  return PHRASINGS[l] ?? PHRASINGS.und;
}
