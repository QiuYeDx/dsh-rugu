// 中文分析器（lang = 'zh'）。
//   - 分词：jieba 搜索模式（装了才用）+ 中文二元组 + 字母数字词；没有 jieba 时再加单字和用户词典的整词，
//     这样「猫」这种单字词、「小鱼干」这种三字名在词法路上也对得上（§8.2，F29）。
//   - 时间：中文时间表达的通用语法（昨天、上周六、10 月 31 号、晚上八点、三天前、那天……），见 time.js 的框架。
//   - 问句线索：句末语气词、「X 不 X」、疑问代词、问号——汉语问句的通用语法，不是按入口写的规则（§6.6）。
//   - 虚词：代词、疑问词、语气词、助词、语法副词、连词、介词这些封闭词类，词法路不拿它们当查询词（D150）。
// 这里列出的时间词、语气词、虚词都是语言知识（封闭的语法类），不是用来判断「该不该说」的词表（§2.2）。
import { prep, segmentRuns, wordTokens, cjkTokens, uniq, DictMatcher, scriptCounts } from './text.js';
import {
  COMMON_MATCHERS, parseTimeWith, parseNumber, spanTok, todayStart, MINUTE_MS, HOUR_MS, DAY_MS, TIME_DEFAULTS,
} from './time.js';

// ── 时间词 ────────────────────────────────────────────────────────────────
const NUM = '(\\d{1,4}|[零〇一二两三四五六七八九十百]{1,5})';
const YEAR_DIGITS = '(\\d{4}|[〇零一二三四五六七八九]{4})';
const SUB = '(初|中旬|上旬|下旬|中|底|末)';
const SUB_MAP = { 初: 'early', 上旬: 'early', 中: 'mid', 中旬: 'mid', 底: 'late', 末: 'late', 下旬: 'late' };
const YEAR_SUB_MAP = { 初: 'early', 中: 'mid', 底: 'late', 末: 'late' };

/** 时段（本地小时；可以跨过午夜）。 */
const PART_WORDS = Object.freeze({
  凌晨: [0, 6], 清晨: [5, 8], 早晨: [5, 10], 早上: [5, 10], 一早: [5, 10], 一大早: [5, 9], 大清早: [5, 8],
  上午: [6, 12], 中午: [11, 14], 午间: [11, 14], 晌午: [11, 14], 下午: [12, 18], 午后: [12, 17],
  傍晚: [17, 20], 黄昏: [17, 20], 晚上: [18, 24], 晚间: [18, 24], 夜晚: [18, 24], 夜里: [20, 29], 夜间: [20, 29],
  半夜: [22, 28], 深夜: [22, 28], 午夜: [23, 25],
});
/** 单字时段：只紧跟在日子后面才算（「周六晚」「10/31 早」），单独出现多半不是时间。 */
const PART_SHORT = Object.freeze({ 早: [5, 10], 晚: [18, 24], 夜: [20, 29] });
const DAY_WORDS = Object.freeze({
  今天: 0, 今日: 0, 今儿: 0, 今儿个: 0, 今个: 0, 今个儿: 0,
  昨天: -1, 昨日: -1, 昨儿: -1, 昨儿个: -1,
  前天: -2, 前日: -2, 前儿: -2, 前儿个: -2, 大前天: -3,
  明天: 1, 明日: 1, 明儿: 1, 明儿个: 1, 后天: 2, 后儿: 2, 后儿个: 2, 大后天: 3,
});
/** 带时段的日子词。 */
const DAY_PART_WORDS = Object.freeze({
  今早: [0, '早上'], 今晨: [0, '清晨'], 今晚: [0, '晚上'], 今夜: [0, '夜里'],
  昨早: [-1, '早上'], 昨晚: [-1, '晚上'], 昨夜: [-1, '夜里'], 前晚: [-2, '晚上'],
  明早: [1, '早上'], 明晨: [1, '清晨'], 明晚: [1, '晚上'], 明夜: [1, '夜里'],
});
const WEEKDAY_CHAR = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, 七: 6, 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 };
const REL_PREFIX = { 上上: -2, 上: -1, 这: 0, 本: 0, 今: 0, 下: 1, 下下: 2 };
const YEAR_REL = { 大前: -3, 前: -2, 去: -1, 今: 0, 明: 1, 后: 2, 大后: 3 };
/** 固定公历日期的节日：[月, 日, 天数]。农历节日要历法表，这里不做。 */
const HOLIDAYS = Object.freeze({
  元旦: [1, 1, 1], 情人节: [2, 14, 1], 妇女节: [3, 8, 1], 愚人节: [4, 1, 1], 劳动节: [5, 1, 5], 五一: [5, 1, 5],
  儿童节: [6, 1, 1], 六一: [6, 1, 1], 国庆节: [10, 1, 7], 国庆: [10, 1, 7], 万圣节: [10, 31, 1], 双十一: [11, 11, 1],
  平安夜: [12, 24, 1], 圣诞节: [12, 25, 1], 圣诞: [12, 25, 1],
});
/** 回指过去某一次（「那天」「上次」）：单看一句话定不下是哪天。 */
const ANAPHORA = ['那一天', '那天', '那一晚', '那晚', '那一次', '那次', '那回', '那时候', '那时', '那会儿', '那阵子', '当时', '当天', '当晚', '上一次', '上次', '上回'];
/** 「最近」一类：[词, 种类]。 */
const RECENT = Object.freeze({
  最近: 'recent', 近来: 'recent', 近期: 'recent', 这阵子: 'recent', 这段时间: 'recent', 这段日子: 'recent',
  这些天: 'thesedays', 这些日子: 'thesedays', 前些天: 'fewdaysago', 前些日子: 'fewdaysago',
  前阵子: 'awhileago', 前段时间: 'awhileago', 刚才: 'justnow', 刚刚: 'justnow', 方才: 'justnow',
});

const alt = (words) => [...words].sort((a, b) => b.length - a.length).join('|');
const re = (src) => new RegExp(src, 'yu');
/** 没有分词时的切分歧义：「之前天气」「如今天下」「以前年纪」里的「前天」「今天」「前年」不是时间。只挡这几个常见的前字。 */
const NOT_AFTER = '(?<![以之从提目眼当面然随此如过])';
const PART_ALT = alt(Object.keys(PART_WORDS));
/** 「N 号」后面可以接的：非汉字，或者时段、钟点、「的」（「31 号晚上」「1 号线」里的「1 号」就不算）。 */
const AFTER_DAY_NUMBER_RE = new RegExp(`^(?:[^\\p{Script=Han}]|$|的|${PART_ALT}|[早晚夜]|${NUM}(?:点|时))`, 'u');
const afterDayNumberOk = (text, end) => AFTER_DAY_NUMBER_RE.test(text.slice(end, end + 8));

function partTok(word) {
  const [h0, h1] = PART_WORDS[word] ?? PART_SHORT[word];
  return { k: 'part', h0, h1 };
}
const weekdayOf = (ch) => WEEKDAY_CHAR[ch];

/** zh 的时间词元匹配器（再加上 time.js 里和语言无关的那几个）。 */
const ZH_MATCHERS = Object.freeze([
  ...COMMON_MATCHERS,
  // 10/31（中文习惯是月/日）
  {
    re: /(\d{1,2})\/(\d{1,2})(?![\d/])/y,
    make(m, env, text, i) {
      if (i > 0 && /[\d/]/.test(text[i - 1])) return null;
      const mo = +m[1]; const d = +m[2];
      return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { k: 'date', m: mo - 1, d } : null;
    },
  },
  // （2025 年）10 月（31 日 / 号）（初 / 底……）
  {
    re: re(`(?:${YEAR_DIGITS}年)?${NUM}月份?(?:${NUM}(日|号)|(\\d{1,2})(?![\\d个]))?${SUB}?`),
    make(m, env, text) {
      const y = m[1] != null ? parseNumber(m[1]) : null;
      const mo = parseNumber(m[2]);
      if (!(mo >= 1 && mo <= 12)) return null;
      const dRaw = m[3] ?? m[5];
      if (dRaw != null) {
        const d = parseNumber(dRaw);
        if (!(d >= 1 && d <= 31)) return null;
        return { k: 'date', y: y ?? undefined, m: mo - 1, d };
      }
      return { k: 'month', y: y ?? undefined, m: mo - 1, sub: m[6] ? SUB_MAP[m[6]] : undefined };
    },
  },
  // 31 号 / 31 日（单说日）
  {
    re: re(`${NUM}(日|号)`),
    make(m, env, text, i) {
      const d = parseNumber(m[1]);
      if (!(d >= 1 && d <= 31)) return null;
      const digits = /^\d+$/.test(m[1]);
      if ((m[2] === '号' || !digits) && !afterDayNumberOk(text, i + m[0].length)) return null;
      return { k: 'date', d };
    },
  },
  // 2025 年（年底）
  {
    re: re(`${YEAR_DIGITS}年(?:年)?(初|中|底|末)?`),
    make: (m) => ({ k: 'year', y: parseNumber(m[1]), sub: m[2] ? YEAR_SUB_MAP[m[2]] : undefined }),
  },
  // 去年 / 今年年初
  {
    re: re(`${NOT_AFTER}(${alt(Object.keys(YEAR_REL))})年(?:年)?(初|中|底|末)?`),
    make: (m, env) => ({ k: 'year', y: env.now.y + YEAR_REL[m[1]], sub: m[2] ? YEAR_SUB_MAP[m[2]] : undefined }),
  },
  // 年初 / 年底（今年）
  { re: /年(初|底|末)/y, make: (m, env) => ({ k: 'year', y: env.now.y, sub: YEAR_SUB_MAP[m[1]] }) },
  // 上个月 / 这个月底
  {
    re: re(`(上上|上|下下|下|这|本)个?月份?${SUB}?`),
    make: (m) => ({ k: 'month', rel: REL_PREFIX[m[1]], sub: m[2] ? SUB_MAP[m[2]] : undefined }),
  },
  // 月初 / 月底（本月）
  { re: /月(初|上旬|中旬|下旬|底|末)/y, make: (m) => ({ k: 'month', rel: 0, sub: SUB_MAP[m[1]] }) },
  // 今天、昨天、大后天……；今晚、昨夜……
  {
    re: re(`${NOT_AFTER}(${alt([...Object.keys(DAY_WORDS), ...Object.keys(DAY_PART_WORDS)])})`),
    make(m) {
      if (m[1] in DAY_PART_WORDS) {
        const [offset, part] = DAY_PART_WORDS[m[1]];
        return [{ k: 'day', offset }, partTok(part)];
      }
      return { k: 'day', offset: DAY_WORDS[m[1]] };
    },
  },
  // 上周六、这个星期天、下礼拜、上个周末
  {
    re: re('(上上|上|下下|下|这|本|今)个?(?:周|星期|礼拜|週)(?:([一二三四五六日天七1-7])|(末))?'),
    make(m) {
      const offset = REL_PREFIX[m[1]];
      if (m[2]) return { k: 'weekday', wd: weekdayOf(m[2]), weekOffset: offset };
      return { k: 'week', offset, weekend: !!m[3] };
    },
  },
  // 周六、星期天（只说了星期几）
  { re: /(?:周|星期|礼拜|週)([一二三四五六日天七1-7])/y, make: (m) => ({ k: 'weekday', wd: weekdayOf(m[1]), weekOffset: null }) },
  // 周末（只说了周末）
  { re: /周末/y, make: () => ({ k: 'week', offset: null, weekend: true }) },
  // 三天前、两个月后、半小时前、几天前
  {
    re: re(`(${NUM.slice(1, -1)}|几|半)(个)?(天|日|周|星期|礼拜|月|年|小时|钟头|分钟)(?:之|以)?(前|后)`),
    make(m, env) {
      const sign = m[4] === '前' ? -1 : 1;
      const unit = m[3];
      if (unit === '月' && !m[2]) return null;   // 「三月前」多半是三月，不是三个月
      const few = m[1] === '几';
      const n = m[1] === '半' ? 0.5 : few ? null : parseNumber(m[1]);
      if (!few && !(n > 0)) return null;
      const t0 = todayStart(env);
      switch (unit) {
        case '天': case '日':
          if (few) return sign < 0 ? spanTok(t0 - env.recentDays * DAY_MS, t0, 'fuzzy') : spanTok(t0 + DAY_MS, t0 + (env.recentDays + 1) * DAY_MS, 'fuzzy');
          if (n === 0.5) return spanTok(env.at + sign * 9 * HOUR_MS, env.at + sign * 15 * HOUR_MS, 'fuzzy');
          return Number.isInteger(n) ? { k: 'day', offset: sign * n } : null;
        case '周': case '星期': case '礼拜':
          if (few) return sign < 0 ? spanTok(t0 - 6 * 7 * DAY_MS, t0 - 7 * DAY_MS, 'fuzzy') : spanTok(t0 + 7 * DAY_MS, t0 + 6 * 7 * DAY_MS, 'fuzzy');
          return Number.isInteger(n) ? { k: 'week', offset: sign * n } : null;
        case '月':
          if (few) return sign < 0 ? spanTok(env.at - 270 * DAY_MS, env.at - 30 * DAY_MS, 'fuzzy') : spanTok(env.at + 30 * DAY_MS, env.at + 270 * DAY_MS, 'fuzzy');
          if (n === 0.5) return spanTok(env.at + sign * 10 * DAY_MS, env.at + sign * 20 * DAY_MS, 'fuzzy');
          return Number.isInteger(n) ? { k: 'month', rel: sign * n } : null;
        case '年':
          if (few) return sign < 0 ? spanTok(env.at - 9 * 365 * DAY_MS, env.at - 365 * DAY_MS, 'fuzzy') : spanTok(env.at + 365 * DAY_MS, env.at + 9 * 365 * DAY_MS, 'fuzzy');
          if (n === 0.5) return spanTok(env.at + sign * 120 * DAY_MS, env.at + sign * 240 * DAY_MS, 'fuzzy');
          return Number.isInteger(n) ? { k: 'year', y: env.now.y + sign * n } : null;
        case '小时': case '钟头': {
          if (few) return sign < 0 ? spanTok(env.at - 9 * HOUR_MS, env.at - HOUR_MS, 'fuzzy') : spanTok(env.at + HOUR_MS, env.at + 9 * HOUR_MS, 'fuzzy');
          const c = env.at + sign * n * HOUR_MS;
          const half = Math.max(15 * MINUTE_MS, n * HOUR_MS * 0.25);
          return spanTok(c - half, c + half, 'exact');
        }
        case '分钟': {
          if (few) return sign < 0 ? spanTok(env.at - 15 * MINUTE_MS, env.at, 'exact') : spanTok(env.at, env.at + 15 * MINUTE_MS, 'exact');
          const c = env.at + sign * n * MINUTE_MS;
          const half = Math.max(5 * MINUTE_MS, n * MINUTE_MS * 0.25);
          return spanTok(c - half, c + half, 'exact');
        }
        default: return null;
      }
    },
  },
  // 最近三天、前两天、这几天、接下来一周
  {
    re: re(`(最近|近|过去|这|前|后|未来|接下来)的?(${NUM.slice(1, -1)}|几)个?(天|日|周|星期|礼拜|月|年)`),
    make(m, env) {
      const unitDays = { 天: 1, 日: 1, 周: 7, 星期: 7, 礼拜: 7, 月: 30, 年: 365 }[m[3]];
      // 「这几天」约三天；「前几天」是「几天前」那一段（最近 recentDays 天）
      const n = m[2] === '几' ? (m[1] === '前' && unitDays === 1 ? env.recentDays : 3) : parseNumber(m[2]);
      if (!(n >= 1 && n <= 366)) return null;
      const t0 = todayStart(env);
      const span = n * unitDays * DAY_MS;
      const precision = unitDays === 1 ? 'day' : unitDays === 7 ? 'week' : 'month';
      if (m[1] === '前') return spanTok(t0 - span, t0, precision);
      if (m[1] === '后' || m[1] === '未来' || m[1] === '接下来') return spanTok(env.at, t0 + DAY_MS + span, precision);
      return spanTok(t0 - span + unitDays * DAY_MS, env.at, precision);
    },
  },
  // 最近、刚才、前阵子……
  {
    re: re(`(${alt(Object.keys(RECENT))})`),
    make(m, env) {
      const t0 = todayStart(env);
      switch (RECENT[m[1]]) {
        case 'recent': return spanTok(env.at - env.recentDays * DAY_MS, env.at, 'fuzzy');
        case 'thesedays': return spanTok(t0 - 3 * DAY_MS, env.at, 'fuzzy');
        case 'fewdaysago': return spanTok(t0 - env.recentDays * DAY_MS, t0, 'fuzzy');
        case 'awhileago': return spanTok(env.at - env.fuzzyPastDays * DAY_MS, Math.max(env.at - env.fuzzyPastDays * DAY_MS + DAY_MS, t0 - DAY_MS), 'fuzzy');
        case 'justnow': return spanTok(env.at - HOUR_MS, env.at, 'fuzzy');
        default: return null;
      }
    },
  },
  // 那天、上次……（回指）
  { re: re(`(${alt(ANAPHORA)})`), make: (m, env) => spanTok(env.at - env.fuzzyPastDays * DAY_MS, env.at, 'fuzzy') },
  // 节日
  {
    re: re(`(${alt(Object.keys(HOLIDAYS))})`),
    make(m) { const [mo, d, days] = HOLIDAYS[m[1]]; return { k: 'holiday', m: mo - 1, d, days }; },
  },
  // 时段
  { re: re(`(${PART_ALT})`), make: (m) => partTok(m[1]) },
  // 单字时段：只接在紧挨着的日子后面
  { re: /([早晚夜])/y, make: (m, env, text, i) => (env.prevEnd === i ? partTok(m[1]) : null) },
  // 钟点：八点、8 点半、十点一刻、八点二十（分）、三点左右
  {
    re: re(`${NUM}(点钟?|时)(半|一刻|三刻|过?${NUM}分?)?(左右|前后|多|整|许)?`),
    make(m, env, text, i) {
      const h = parseNumber(m[1]);
      if (!(h >= 0 && h <= 24)) return null;
      let min = 0;
      if (m[3] === '半') min = 30;
      else if (m[3] === '一刻') min = 15;
      else if (m[3] === '三刻') min = 45;
      else if (m[4] != null) min = parseNumber(m[4]);
      if (!(min >= 0 && min <= 59)) return null;
      // 「一点」「一时」单独出现多半是「一点儿」「一时半会儿」，只在紧跟日子 / 时段时才当钟点
      if ((m[1] === '一') && m[2] !== '点钟' && m[3] == null && env.prevEnd !== i) return null;
      return {
        k: 'clock', h, min, ambiguous: h >= 1 && h <= 12,
        span: m[3] != null ? 15 * MINUTE_MS : HOUR_MS, approx: m[5] === '左右' || m[5] === '前后' || m[5] === '多' || m[5] === '许',
      };
    },
  },
]);

// ── 问句线索 ──────────────────────────────────────────────────────────────
// 汉语问句的语法（§6.6「句式线索」）：问号、句末疑问语气词（吗 / 呢 / 了没 / 来着）、正反问（X 不 X）、疑问代词。
// 这些是封闭的语法类（像时间词一样属于这门语言的知识，只放在 zh 分析器里，核心不认识），不是按话题、按入口判断的词表；
// 「是不是在问过去」由 retrieve 用示例问法（pastQuestionExemplars）的嵌入相似度加时间表达来判断，这里的分数只在嵌入
// 不可用（L3）时当退路，判别从宽。示例问法不拿来按字面比：字面重合的是「快递」「那件事」这些话题词，按它判断就成了话题词表。
// 疑问代词按句子结构分三种读法，只有疑问读法算：
//   - 疑问：「你去哪了」「他是做什么的」；
//   - 任指 / 遍指：后面跟「都」（「什么都吃」「哪儿都行」），或跟「也」再接否定、让步（「谁也不认识」「怎么都行」）；
//   - 虚指：前面紧挨着否定（「没什么」「不怎么喜欢」「没有多少钱」）。
const SENTENCE_SPLIT = /(?<=[。！!？?\n])/u;
const CLAUSE_SPLIT = /[，,、；;：:]/u;
const TRAILING = /[\s。！!？?~…．.，,、）)」』"'”’]+$/u;
/** 疑问代词（问原因的「为什么 / 为啥 / 干嘛」没有任指用法；「怎么 / 怎样 / 咋」问方式，任指要带否定或让步）。 */
const WH_RE = /为什么|为啥|干[嘛吗啥]|什么|谁|哪|怎么|怎样|咋|多少|几[点个天时号岁次回]|啥/gu;
const REASON_WH = /^(?:为什么|为啥|干.)$/u;
const MANNER_WH = /^(?:怎么|怎样|咋)$/u;
/** 疑问代词后面（中间至多隔一个量词或名词，如「什么时候都」「哪儿都」）跟「都 / 也」。 */
const UNIVERSAL_AFTER = /^\p{Script=Han}{0,2}?([都也])/u;
/** 「都 / 也」之后紧接（至多隔两个字）否定或让步（「也想不起来」「都行」「也没来」）。 */
const CONCESSIVE_HEAD = /^\p{Script=Han}{0,2}?(?:[不没别]|行|可以|成|好|无所谓|一样)/u;
/** 句末的「么」是「吗」的写法；「什么 / 怎么 / 这么 / 那么 / 多么 / 要么」里的「么」不是。 */
const FINAL_MA = /(?:吗|(?<![什怎这那多要])么)$/u;

/** 这一处疑问代词是不是疑问读法（不是任指、虚指）。clause 是它所在的分句，start / end 是它在分句里的位置。 */
function interrogativeUse(clause, wh, start, end) {
  if (/(?:[不没别]|没有)$/u.test(clause.slice(0, start))) return false;   // 虚指：「没什么」「不怎么」「没有多少」
  if (REASON_WH.test(wh)) return true;
  const m = UNIVERSAL_AFTER.exec(clause.slice(end));
  if (!m) return true;
  if (m[1] === '都' && !MANNER_WH.test(wh)) return false;        // 「什么都吃」「谁都知道」
  return !CONCESSIVE_HEAD.test(clause.slice(end + m[0].length));   // 「谁也不认识」「怎么都行」是任指；「你怎么也来了」是在问
}

/**
 * 0–1：句式上像不像在问。只看最后一句（问句线索在句末）。
 * @param {string} text
 */
export function zhQuestionCue(text) {
  const t = String(text ?? '').normalize('NFKC').trim();
  if (!t) return 0;
  const last = t.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean).at(-1) ?? '';
  let score = 0;
  if (/[?？]\s*["'”’」』)）]*\s*$/u.test(last)) score = 1;
  const body = last.replace(TRAILING, '');
  if (FINAL_MA.test(body)) score = Math.max(score, 0.9);
  if (/(?:了没有?|了不|没有?)$/u.test(body)) score = Math.max(score, /了/u.test(body.slice(-3)) ? 0.85 : 0.6);
  if (/(?:来着|嘛)$/u.test(body)) score = Math.max(score, 0.5);
  if (/呢$/u.test(body)) score = Math.max(score, 0.6);
  if (/(\p{Script=Han})[不没]\1/u.test(last)) score = Math.max(score, 0.8);
  // 疑问代词：只算疑问读法（分句里看：「什么都别管，你去哪」后一个分句是在问）
  const asks = (clause) => [...clause.matchAll(WH_RE)].some((m) => interrogativeUse(clause, m[0], m.index, m.index + m[0].length));
  if (score < 0.6 && last.split(CLAUSE_SPLIT).some(asks)) score = 0.6;
  return score;
}

/** 「看起来在问过去」的示例问法（§6.6）：给嵌入比相似度用，不是关键词。 */
export const ZH_PAST_EXEMPLARS = Object.freeze([
  '你还记得我上次说的那件事吗',
  '还记得那天我们聊了什么吗',
  '之前跟你说过的那个，后来怎么样了',
  '快递拿了没',
  '那件事办完了没有',
  '他后来怎么样了',
  '我上周说要干嘛来着',
  '你记不记得他是做什么的',
  '上次说的那个地方叫什么来着',
  '昨天晚上你在群里跟大家聊啥了',
]);

// ── 虚词 ──────────────────────────────────────────────────────────────────
// 查询词里不带「要找什么」的那部分：人称和指示代词、疑问代词、语气词、结构 / 时态助词、语法副词、否定和系词、
// 连词、介词。都是汉语的封闭词类（数得完、不随话题增减），和时间词、问句线索一样是这门语言的知识，不是按话题或场合写的词表。
// 「记得」「知道」「有」这类实词不放：常不常见交给库里的统计（词法路的 IDF）。
// 词法路拿它决定哪些词不进查询（D150）；两个虚字连成的二元组（「你还」「过哪」「给我」）也算虚词——整词按语法本来就是。
const ZH_FUNCTION_WORDS = new Set([
  // 人称、指示代词
  '我', '你', '您', '他', '她', '它', '咱', '俺', '我们', '你们', '他们', '她们', '它们', '咱们', '自己',
  '这', '那', '此', '这个', '那个', '这些', '那些', '这里', '那里', '这儿', '那儿', '这样', '那样', '这么', '那么',
  // 疑问代词、正反问的框架
  '谁', '什么', '啥', '哪', '哪个', '哪些', '哪里', '哪儿', '怎', '怎么', '怎样', '怎么样', '咋', '为什么', '为啥', '多少', '几',
  '有没', '有没有', '是不', '是不是',
  // 语气词
  '吗', '呢', '吧', '啊', '呀', '嘛', '么', '啦', '哦', '噢', '喔', '呗', '哈', '嗯', '诶', '欸', '哇', '咯', '嘞', '哟', '呐', '而已', '罢了',
  // 结构、时态助词
  '的', '地', '得', '了', '着', '过', '之', '所', '似的',
  // 语法副词、否定、系词
  '还', '也', '都', '就', '才', '又', '再', '很', '太', '挺', '更', '最', '只', '已经', '不', '没', '没有', '别', '是',
  // 连词、介词
  '和', '跟', '与', '及', '或', '或者', '还是', '而', '而且', '但', '但是', '可是', '不过', '因为', '所以', '如果', '要是', '虽然', '然后',
  '把', '被', '给', '在', '从', '对', '向', '往', '比',
  // 叹词（D151；上面已有的语气词不重复）
  '喂', '嗨', '嘿', '哎', '唉', '呃', '哼', '嘻', '嘤', '呜', '咦', '噫', '哎呀', '哎哟', '唉呀', '嗯哼',
  // 寒暄语（D151：打招呼、道别，这句话本身不在说任何事）。只放整词：单字「早」「好」在「早饭」「好吃」里是实词
  '哈喽', '哈啰', '哈罗', '你好', '您好', '大家好', '早安', '午安', '晚安', '早上好', '上午好', '中午好', '下午好', '晚上好',
  '拜拜', '再见', '回见',
]);

/**
 * 查询词是不是虚词（见上）。两个字都是虚字的二元组也算。
 * @param {string} term 规范化过的词
 */
export function zhFunctionWord(term) {
  const t = String(term ?? '');
  if (ZH_FUNCTION_WORDS.has(t)) return true;
  const chars = [...t];
  return chars.length === 2 && ZH_FUNCTION_WORDS.has(chars[0]) && ZH_FUNCTION_WORDS.has(chars[1]);
}

// ── 分析器 ────────────────────────────────────────────────────────────────
/**
 * jieba 的几种形态都接：v2 的实例（有 cutForSearch 方法）、v2 的模块（Jieba 类）、v1 的模块（load + cutForSearch）。
 * 不认识的形态返回 null（退回二元组）。
 * @param {any} mod
 * @returns {{cut: (text: string) => string[], loadDict?: (buf: Buffer) => void}|null}
 */
export function adaptJieba(mod) {
  if (!mod) return null;
  const m = mod.default && !mod.cutForSearch && !mod.Jieba ? mod.default : mod;
  try {
    if (typeof m.cutForSearch === 'function' && typeof m.load !== 'function') {
      return { cut: (t) => m.cutForSearch(t, true), loadDict: typeof m.loadDict === 'function' ? (b) => m.loadDict(b) : undefined };
    }
    if (typeof m.Jieba === 'function') {
      const inst = m.dict && typeof m.Jieba.withDict === 'function' ? m.Jieba.withDict(m.dict) : new m.Jieba();
      if (typeof inst.cutForSearch !== 'function') return null;
      return { cut: (t) => inst.cutForSearch(t, true), loadDict: typeof inst.loadDict === 'function' ? (b) => inst.loadDict(b) : undefined };
    }
    if (typeof m.load === 'function' && typeof m.cutForSearch === 'function') {
      m.load();
      return { cut: (t) => m.cutForSearch(t, true), loadDict: typeof m.loadDict === 'function' ? (b) => m.loadDict(b) : undefined };
    }
  } catch { /* 加载失败：退回二元组 */ }
  return null;
}

/**
 * 同步构造 zh 分析器（createZhAnalyzer 先异步加载 jieba，再调它；registry 在 init 之前被用到时也用它兜底）。
 * @param {{jieba?: ReturnType<typeof adaptJieba>, tzOffsetMin?: number|null,
 *          params?: () => {tzOffsetMin?: number|null, fuzzyPastDays?: number, recentDays?: number}}} [opt]
 * @returns {import('../ports/index.js').LanguageAnalyzer & {jieba: boolean}}
 */
export function buildZhAnalyzer(opt = {}) {
  const jieba = opt.jieba ?? null;
  const dict = new DictMatcher();
  const timeParams = () => {
    const p = (typeof opt.params === 'function' ? safe(opt.params, {}) : {}) ?? {};
    return {
      tzOffsetMin: p.tzOffsetMin !== undefined ? p.tzOffsetMin : opt.tzOffsetMin ?? null,
      fuzzyPastDays: p.fuzzyPastDays ?? TIME_DEFAULTS.fuzzyPastDays,
      recentDays: p.recentDays ?? TIME_DEFAULTS.recentDays,
    };
  };
  return {
    lang: 'zh',
    jieba: !!jieba,
    detect(text) {
      const c = scriptCounts(text);
      if (!c.han) return 0;
      // 有假名、谚文的多半是日文、韩文（汉字是借用的）
      const foreign = c.kana + c.hangul;
      const score = c.han / (c.han + 2 * foreign + c.otherLetters / 4);
      return Math.max(0, Math.min(1, foreign > 0 && foreign * 5 > c.han ? score * 0.3 : score));
    },
    tokenize(text) {
      const t = prep(text);
      const out = [];
      for (const run of segmentRuns(t)) {
        if (run.cls === 'word') { out.push(...wordTokens(run.text)); continue; }
        if (jieba) {
          let words = [];
          try { words = jieba.cut(run.text) ?? []; } catch { words = []; }
          for (const w of words) {
            const n = prep(w).replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
            if (n) out.push(n);
          }
          out.push(...cjkTokens(run.chars));
        } else {
          out.push(...cjkTokens(run.chars, { unigrams: true }));
        }
      }
      // 用户词典的整词（没有 jieba 时；有 jieba 时词典已经交给它）
      if (!jieba && dict.size) {
        const hits = dict.scan(t);
        if (hits.length) return uniq(mergeByPosition(out, t, hits));
      }
      return uniq(out);
    },
    parseTime(text, at) {
      return parseTimeWith(text, at, { matchers: ZH_MATCHERS, ...timeParams() });
    },
    pastQuestionExemplars: () => [...ZH_PAST_EXEMPLARS],
    questionCue: zhQuestionCue,
    // 词典里的整词（名字、别名）优先于虚词：有人就叫这个
    termClass(term) {
      const t = prep(term);
      if (dict.has(t)) return 'word';
      return zhFunctionWord(t) ? 'function' : null;
    },
    setUserDictionary(words) {
      const list = (Array.isArray(words) ? words : []).filter((w) => typeof w === 'string');
      dict.set(list);
      if (jieba?.loadDict && list.length) {
        try { jieba.loadDict(Buffer.from(list.map((w) => `${w.replace(/\s+/g, '')} 100000 n`).join('\n'), 'utf8')); } catch { /* 词典加载失败不影响分词 */ }
      }
    },
  };
}

/** 把词典词按出现位置插回词元序列（查询词要按出现顺序）。 */
function mergeByPosition(tokens, text, hits) {
  // 词元的位置：按顺序在文字里找（找不到的放在前一个后面）
  const placed = [];
  let cursor = 0;
  for (const tok of tokens) {
    const p = text.indexOf(tok, Math.max(0, cursor - 2));
    const pos = p >= 0 ? p : cursor;
    placed.push({ pos, tok, order: placed.length });
    cursor = pos;
  }
  for (const h of hits) placed.push({ pos: h.pos, tok: h.word, order: -1 });
  placed.sort((a, b) => a.pos - b.pos || (a.order === -1 ? -1 : b.order === -1 ? 1 : a.order - b.order));
  return placed.map((x) => x.tok);
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * 中文分析器（lang = 'zh'）。jieba: 'auto' 尝试 `await import('@node-rs/jieba')`；false 不用；对象 = 已经加载好的模块或实例。
 * 加载失败不抛错，分析器的 jieba 字段为 false（只用二元组 + 单字 + 用户词典）。
 * @param {{jieba?: 'auto'|false|object, tzOffsetMin?: number|null,
 *          params?: () => {tzOffsetMin?: number|null, fuzzyPastDays?: number, recentDays?: number}}} [opt]
 * @returns {Promise<import('../ports/index.js').LanguageAnalyzer & {jieba: boolean, jiebaError?: string}>}
 */
export async function createZh(opt = {}) {
  let adapted = null;
  let jiebaError;
  if (opt.jieba === 'auto' || opt.jieba === undefined) {
    try {
      const mod = await import('@node-rs/jieba');
      adapted = adaptJieba(mod);
      if (!adapted) jiebaError = 'unsupported-shape';
    } catch (e) {
      jiebaError = e?.code ?? e?.name ?? 'Error';
    }
  } else if (opt.jieba && typeof opt.jieba === 'object') {
    adapted = adaptJieba(opt.jieba);
    if (!adapted) jiebaError = 'unsupported-shape';
  }
  const a = buildZhAnalyzer({ jieba: adapted, tzOffsetMin: opt.tzOffsetMin, params: opt.params });
  if (jiebaError) Object.defineProperty(a, 'jiebaError', { value: jiebaError, enumerable: false });
  return a;
}
