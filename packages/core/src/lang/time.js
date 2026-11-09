// 时间表达解析的框架（zh 和 und 共用，§6.6、§8.1、§8.2「时间路」）。
//   1. 按位置扫描：每个位置试所有「词元匹配器」，取最长的那个（匹配器由语言给：und 只有和语言无关的 ISO 日期、HH:MM；
//      zh 再加「昨天、上周六、晚上八点、10/31、那天……」）；
//   2. 紧挨着的词元（中间只有空白，或者「的」后面接时段 / 钟点）合成一组：年 → 月 → 日 → 时段 → 钟点，从粗到细；
//   3. 每组换算成绝对时间窗（UTC 毫秒）。本地时间按 tzOffsetMin（分钟，东八区 = 480；null = 本机时区）；
//   4. 两组之间是「到 / 至 / ~ / -」就并成一个区间（「昨天三点到五点」的后半段沿用前半段的日子）。
// 说不准的地方给多个候选窗口，不替说话的人做决定：光说「周六」给上一个和下一个周六；没有时段的「八点」给 8 点和 20 点。
// 「那天」「上次」这类回指，单看一句话定不下是哪天，给一个宽的「过去一段时间」窗口（precision='fuzzy'）。

import { DEFAULTS } from '../config/defaults.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** 一次最多看多长的文字（从末尾算：线索里最新的话在最后）。 */
export const PARSE_MAX_CHARS = 4000;

/** 没有配置时的兜底（registry 每次从 config.lang.time 取，热加载）；数值在 config/defaults.js 的 lang.time。 */
export const TIME_DEFAULTS = DEFAULTS.lang.time;

/**
 * 本地时间的换算。tz 是相对 UTC 的分钟数；null / undefined = 本机时区（按那一刻的偏移，夏令时也对）。
 * @param {number|null|undefined} tzOffsetMin
 */
export function localClock(tzOffsetMin) {
  if (typeof tzOffsetMin === 'number' && Number.isFinite(tzOffsetMin)) {
    const off = tzOffsetMin * MINUTE_MS;
    return {
      parts(t) {
        const d = new Date(t + off);
        return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), wd: d.getUTCDay() };
      },
      make: (y, m, d, h = 0, min = 0) => Date.UTC(y, m, d, h, min) - off,
    };
  }
  return {
    parts(t) {
      const d = new Date(t);
      return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes(), wd: d.getDay() };
    },
    make: (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime(),
  };
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
export const validDate = (y, m, d) => Number.isInteger(m) && m >= 0 && m <= 11 && Number.isInteger(d) && d >= 1 && d <= daysInMonth(y, m);

// ── 词元 ──────────────────────────────────────────────────────────────────
// 匹配器：{re: 带 y（粘连）标志的正则, make(m, ctx) → 词元 | 词元[] | null}
// 词元种类：
//   year {y}                         年（相对的已经换算好）；sub: 'early'|'mid'|'late'
//   month {m, y?, rel?, sub?}        月（0–11）；rel = 相对本月的偏移
//   date {y?, m?, d}                 某一天（缺的年、月由同组的年、月补，否则就近）
//   day {offset}                     相对今天
//   weekday {wd, weekOffset}         wd 0 = 周一 … 6 = 周日；weekOffset null = 只说了「周六」
//   week {offset, weekend?}          offset null + weekend = 只说了「周末」
//   part {h0, h1}                    一天里的时段（小时，可以跨过午夜：h1 > 24）
//   clock {h, min, ambiguous, span, approx}
//   span {start, end, precision}     已经算好的窗口（N 小时前、最近、那天……）
//   holiday {m, d, days}             固定日期的节日

/** 数字（阿拉伯数字或中文数字，「二十一」「两」「二〇二六」）。不认识返回 NaN。 */
const ZH_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function parseNumber(s) {
  if (s == null || s === '') return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (!/[十百]/.test(s)) {
    let n = 0;
    for (const ch of s) {
      if (!(ch in ZH_DIGIT)) return NaN;
      n = n * 10 + ZH_DIGIT[ch];
    }
    return n;
  }
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in ZH_DIGIT) cur = ZH_DIGIT[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else return NaN;
  }
  return total + cur;
}
const NUM_CHAR_RE = /[\d零〇一二两三四五六七八九十百]/u;

/** 和语言无关的写法：ISO 日期（可带 T 时间）、YYYY/MM/DD、YYYY.MM.DD、HH:MM（24 小时制，照字面）。 */
export const COMMON_MATCHERS = Object.freeze([
  {
    re: /(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(?!\d)/y,
    make(m) {
      const y = +m[1]; const mo = +m[2] - 1; const d = +m[3];
      if (!validDate(y, mo, d)) return null;
      const out = [{ k: 'date', y, m: mo, d }];
      if (m[4] != null) {
        const h = +m[4]; const min = +m[5];
        if (h > 23 || min > 59) return out;
        out.push({ k: 'clock', h, min, ambiguous: false, span: 15 * MINUTE_MS, approx: false });
      }
      return out;
    },
  },
  {
    re: /(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?![\d/.])/y,
    make(m) {
      const y = +m[1]; const mo = +m[2] - 1; const d = +m[3];
      return validDate(y, mo, d) ? { k: 'date', y, m: mo, d } : null;
    },
  },
  {
    re: /([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?![\d:])/y,
    make: (m) => ({ k: 'clock', h: +m[1], min: +m[2], ambiguous: false, span: 15 * MINUTE_MS, approx: false }),
  },
]);

// ── 扫描 ──────────────────────────────────────────────────────────────────
/**
 * @param {string} text
 * @param {readonly {re: RegExp, make: Function}[]} matchers
 * @param {object} ctx  传给 make()
 * @returns {{start: number, end: number, toks: object[]}[]}
 */
function scan(text, matchers, ctx) {
  const out = [];
  let i = 0;
  ctx.prevEnd = -1;   // 上一个词元的结尾：单字时段（「周六晚」的「晚」）只在紧挨着时才算
  while (i < text.length) {
    // 不从一串数字的中间开始（「110月」里不认出「10月」）
    if (i > 0 && NUM_CHAR_RE.test(text[i]) && NUM_CHAR_RE.test(text[i - 1])) { i += 1; continue; }
    let best = null;
    for (const mt of matchers) {
      mt.re.lastIndex = i;
      const m = mt.re.exec(text);
      if (!m || m[0].length === 0) continue;
      if (best && m[0].length <= best.len) continue;
      let toks;
      try { toks = mt.make(m, ctx, text, i); } catch { toks = null; }
      if (!toks) continue;
      best = { len: m[0].length, toks: Array.isArray(toks) ? toks : [toks] };
    }
    if (best) {
      out.push({ start: i, end: i + best.len, toks: best.toks });
      i += best.len;
      ctx.prevEnd = i;
    } else {
      i += text.codePointAt(i) > 0xffff ? 2 : 1;
    }
  }
  return out;
}

const RANGE_JOIN_RE = /^\s*(?:到|至|~|～|-|－|—|–|一直到|直到)\s*$/u;
/** 一组里词元从粗到细的次序（同一级的两个词元不合成一组：「今天 明天」是两个时间）。 */
const TOKEN_RANK = Object.freeze({ year: 0, month: 1, date: 2, day: 2, weekday: 2, holiday: 2, span: 2, week: 2, part: 3, clock: 4 });
const PRECISION_RANK = { exact: 0, day: 1, week: 2, month: 3, fuzzy: 4 };
const coarser = (a, b) => (PRECISION_RANK[a] >= PRECISION_RANK[b] ? a : b);

/**
 * 把一段文字里的时间表达解析成绝对时间窗。
 * @param {string} text
 * @param {number} at  基准时间（UTC 毫秒）：「昨天」相对它
 * @param {{matchers: readonly object[], tzOffsetMin?: number|null, fuzzyPastDays?: number, recentDays?: number}} opt
 * @returns {import('../ports/index.js').TimeWindow[]}
 */
export function parseTimeWith(text, at, opt) {
  if (typeof text !== 'string' || !text || !Number.isFinite(at)) return [];
  let t = text.normalize('NFKC');
  let base = 0;
  if (t.length > PARSE_MAX_CHARS) { base = t.length - PARSE_MAX_CHARS; t = t.slice(base); }
  const clock = localClock(opt.tzOffsetMin);
  const now = clock.parts(at);
  const env = {
    at, clock, now,
    today: { y: now.y, m: now.m, d: now.d },
    fuzzyPastDays: opt.fuzzyPastDays ?? TIME_DEFAULTS.fuzzyPastDays,
    recentDays: opt.recentDays ?? TIME_DEFAULTS.recentDays,
  };
  const hits = scan(t, opt.matchers, env);
  if (!hits.length) return [];

  // 合组：紧挨着（只隔空白；或者隔一个「的」而且后面是时段 / 钟点），并且从粗到细（年 → 月 → 日 → 时段 → 钟点）
  const groups = [];
  for (const h of hits) {
    const g = groups.at(-1);
    const gap = g ? t.slice(g.end, h.start) : null;
    const first = Math.min(...h.toks.map((x) => TOKEN_RANK[x.k] ?? 9));
    const joinable = g && first > g.rank
      && (/^\s*$/.test(gap) || (/^\s*的\s*$/.test(gap) && first >= TOKEN_RANK.part));
    if (joinable) {
      g.toks.push(...h.toks);
      g.end = h.end;
      g.rank = Math.max(g.rank, ...h.toks.map((x) => TOKEN_RANK[x.k] ?? 9));
    } else {
      groups.push({ start: h.start, end: h.end, toks: [...h.toks], rank: Math.max(...h.toks.map((x) => TOKEN_RANK[x.k] ?? 9)) });
    }
  }

  const out = [];
  let prev = null;
  for (const g of groups) {
    const joined = prev && RANGE_JOIN_RE.test(t.slice(prev.end, g.start));
    const r = resolveGroup(g.toks, env, joined ? prev.days : null);
    const text0 = t.slice(g.start, g.end);
    if (!r.windows.length) { prev = null; continue; }
    if (joined && prev.outIdx != null) {
      // 区间：前后两组配对合并
      const a = prev.windows;
      const b = r.windows;
      const pairs = a.length === b.length ? a.map((w, i) => [w, b[i]]) : [[a[0], b.at(-1)]];
      const merged = pairs.filter(([x, y]) => y.end > x.start)
        .map(([x, y]) => ({ start: x.start, end: y.end, precision: coarser(x.precision, y.precision), text: t.slice(prev.start, g.end) }));
      if (merged.length) {
        out.splice(prev.outIdx, prev.windows.length, ...merged);
        prev = null;
        continue;
      }
    }
    const outIdx = out.length;
    for (const w of r.windows) out.push({ ...w, text: text0 });
    prev = { start: g.start, end: g.end, days: r.days, windows: r.windows, outIdx };
  }
  // 去重
  const seen = new Set();
  return out.filter((w) => {
    const k = `${w.start}|${w.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── 换算 ──────────────────────────────────────────────────────────────────
function shiftDay(env, day, offset) {
  const t = env.clock.make(day.y, day.m, day.d + offset, 12);   // 用正午，避开夏令时的边
  const p = env.clock.parts(t);
  return { y: p.y, m: p.m, d: p.d };
}
/** 就近的年：候选去年、今年、明年，取离基准时间最近的。 */
function nearestYear(env, m, d) {
  let best = null;
  for (const y of [env.now.y - 1, env.now.y, env.now.y + 1]) {
    const dd = d ?? Math.min(15, daysInMonth(y, m));
    if (!validDate(y, m, dd)) continue;
    const dist = Math.abs(env.clock.make(y, m, dd, 12) - env.at);
    if (!best || dist < best.dist) best = { y, dist };
  }
  return best ? best.y : env.now.y;
}
/** 这一周的周一（周一是一周的第一天）。 */
function mondayOf(env, day) {
  const wd = env.clock.parts(env.clock.make(day.y, day.m, day.d, 12)).wd;   // 0 = 周日
  return shiftDay(env, day, -((wd + 6) % 7));
}
const weekdayIndex = (env, day) => (env.clock.parts(env.clock.make(day.y, day.m, day.d, 12)).wd + 6) % 7;

function dayWindow(env, day, len = 1) {
  return { start: env.clock.make(day.y, day.m, day.d), end: env.clock.make(day.y, day.m, day.d + len), precision: len === 1 ? 'day' : len <= 7 ? 'week' : 'fuzzy' };
}
function partWindow(env, day, part) {
  return { start: env.clock.make(day.y, day.m, day.d, part.h0), end: env.clock.make(day.y, day.m, day.d, part.h1), precision: 'day' };
}
/** 时段里的钟点：在 h、h+12、h+24 里找落在时段（含两端）里的；找不到时，下午以后的时段把 1–11 点当成下午。 */
function hourInPart(h, part) {
  for (const c of [h, h + 12, h + 24]) if (c >= part.h0 && c <= part.h1) return c;
  return h < 12 && part.h0 >= 12 ? h + 12 : h;
}
function clockWindows(env, day, c, part) {
  let hours;
  if (part) hours = [hourInPart(c.h, part)];
  else if (c.ambiguous && c.h >= 1 && c.h <= 12) hours = c.h === 12 ? [12, 24] : [c.h, c.h + 12];
  else hours = [c.h];
  return hours.map((h) => {
    let start = env.clock.make(day.y, day.m, day.d, h, c.min);
    let end = start + c.span;
    if (c.approx) { start -= 30 * MINUTE_MS; end += 30 * MINUTE_MS; }
    return { start, end, precision: 'exact' };
  });
}
function monthWindow(env, y, m, sub) {
  const n = daysInMonth(y, m);
  if (sub === 'early') return { start: env.clock.make(y, m, 1), end: env.clock.make(y, m, 11), precision: 'fuzzy' };
  if (sub === 'mid') return { start: env.clock.make(y, m, 11), end: env.clock.make(y, m, 21), precision: 'fuzzy' };
  if (sub === 'late') return { start: env.clock.make(y, m, 21), end: env.clock.make(y, m, n + 1), precision: 'fuzzy' };
  return { start: env.clock.make(y, m, 1), end: env.clock.make(y, m + 1, 1), precision: 'month' };
}
function yearWindow(env, y, sub) {
  if (sub === 'early') return { start: env.clock.make(y, 0, 1), end: env.clock.make(y, 2, 1), precision: 'fuzzy' };
  if (sub === 'mid') return { start: env.clock.make(y, 5, 1), end: env.clock.make(y, 7, 1), precision: 'fuzzy' };
  if (sub === 'late') return { start: env.clock.make(y, 10, 1), end: env.clock.make(y + 1, 0, 1), precision: 'fuzzy' };
  return { start: env.clock.make(y, 0, 1), end: env.clock.make(y + 1, 0, 1), precision: 'fuzzy' };
}
/** 只说了「周六」：今天就是周六给今天；否则给上一个和下一个。 */
function bareWeekdayDays(env, wd) {
  const todayWd = weekdayIndex(env, env.today);
  if (todayWd === wd) return [env.today];
  const back = (todayWd - wd + 7) % 7;
  return [shiftDay(env, env.today, -back), shiftDay(env, env.today, 7 - back)];
}
function holidayDays(env, h, year) {
  if (year != null) return validDate(year, h.m, h.d) ? [{ y: year, m: h.m, d: h.d, len: h.days }] : [];
  const cands = [];
  for (const y of [env.now.y - 1, env.now.y, env.now.y + 1]) {
    if (!validDate(y, h.m, h.d)) continue;
    const start = env.clock.make(y, h.m, h.d);
    cands.push({ y, m: h.m, d: h.d, len: h.days, start, end: env.clock.make(y, h.m, h.d + h.days) });
  }
  const current = cands.find((c) => c.start <= env.at && env.at < c.end);
  if (current) return [current];
  const past = cands.filter((c) => c.end <= env.at).at(-1);
  const future = cands.find((c) => c.start > env.at);
  return [past, future].filter(Boolean);
}

/**
 * 一组词元 → 时间窗。inheritDays：区间后半段只有时段 / 钟点时，沿用前半段的日子。
 * @returns {{windows: {start: number, end: number, precision: string}[], days: object[]|null}}
 */
function resolveGroup(toks, env, inheritDays) {
  let year = null;
  let yearSub = null;
  let month = null;
  let days = null;
  let week = null;
  let spans = null;
  let part = null;
  let clock = null;
  for (const t of toks) {
    switch (t.k) {
      case 'year': year = t.y; yearSub = t.sub ?? null; break;
      case 'month': month = t; break;
      case 'date': days = [completeDate(env, t, year, month)].filter(Boolean); break;
      case 'day': days = [shiftDay(env, env.today, t.offset)]; break;
      case 'weekday': days = t.weekOffset == null ? bareWeekdayDays(env, t.wd)
        : [shiftDay(env, mondayOf(env, env.today), t.weekOffset * 7 + t.wd)]; break;
      case 'week': week = t; break;
      case 'holiday': days = holidayDays(env, t, year); break;
      case 'span': spans = [t]; break;
      case 'part': part = t; break;
      case 'clock': clock = t; break;
      default: break;
    }
  }
  // 「上个月 15 号」：日期只给了日，月从同组的月补（已经在 completeDate 里）；月本身就不单独出窗口了
  if (spans) {
    // 已经是窗口：只在单日的窗口上用时段 / 钟点细化（「三天前」已经作为 day 处理，这里多是回指，细化不了）
    return { windows: spans.map((s) => ({ start: s.start, end: s.end, precision: s.precision })), days: null };
  }
  if (!days && !week && !month && year == null && inheritDays && (part || clock)) days = inheritDays;
  if (days && days.length) {
    let windows;
    if (clock) windows = days.flatMap((d) => clockWindows(env, d, clock, part));
    else if (part) windows = days.map((d) => partWindow(env, d, part));
    else windows = days.map((d) => dayWindow(env, d, d.len ?? 1));
    return { windows, days };
  }
  if (week) {
    const offsets = week.offset == null ? bareWeekendOffsets(env) : [week.offset];
    const windows = offsets.map((off) => {
      const mon = shiftDay(env, mondayOf(env, env.today), off * 7);
      if (week.weekend) { const sat = shiftDay(env, mon, 5); return { ...dayWindow(env, sat, 2), precision: 'week' }; }
      return { ...dayWindow(env, mon, 7), precision: 'week' };
    });
    return { windows, days: null };
  }
  if (month) {
    const { y, m } = monthOf(env, month, year);
    return { windows: [monthWindow(env, y, m, month.sub)], days: null };
  }
  if (year != null) return { windows: [yearWindow(env, year, yearSub)], days: null };
  if (clock) return { windows: clockWindows(env, env.today, clock, part), days: [env.today] };
  if (part) return { windows: [partWindow(env, env.today, part)], days: [env.today] };
  return { windows: [], days: null };
}
/** 只说了「周末」：今天是周六、周日给这个周末；否则给上一个和这一个。 */
function bareWeekendOffsets(env) {
  const wd = weekdayIndex(env, env.today);
  return wd >= 5 ? [0] : [-1, 0];
}
function monthOf(env, month, year) {
  if (month.rel != null) {
    const t = env.clock.make(env.now.y, env.now.m + month.rel, 1, 12);
    const p = env.clock.parts(t);
    return { y: p.y, m: p.m };
  }
  const y = month.y ?? year ?? nearestYear(env, month.m, null);
  return { y, m: month.m };
}
function completeDate(env, t, year, month) {
  let m = t.m;
  let y = t.y ?? null;
  if (m == null) {
    if (month) { const mm = monthOf(env, month, year); m = mm.m; y = y ?? mm.y; } else { m = env.now.m; y = y ?? year ?? env.now.y; }
  }
  if (y == null) y = year ?? nearestYear(env, m, t.d);
  return validDate(y, m, t.d) ? { y, m, d: t.d } : null;
}

/** 已经算好的窗口词元（给匹配器用）。 */
export function spanTok(start, end, precision) {
  return { k: 'span', start: Math.min(start, end), end: Math.max(start, end), precision };
}
/** 今天 0 点（本地）。 */
export function todayStart(env) {
  return env.clock.make(env.today.y, env.today.m, env.today.d);
}
