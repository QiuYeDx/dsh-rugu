// Unicode 回退分析器（lang = 'und'）：不认识的语言、随机的语言标签（假平台，§14.2 S18）都退回它。
//   - 不用空格分词的文字（汉字、假名、泰文……）切二元组，只有一个字的段保留单字；其余按字母数字段切词、小写；
//   - 时间只认和语言无关的写法（ISO 日期、YYYY/MM/DD、HH:MM）；
//   - 问句线索只看问号（各种文字的问号）。
import { prep, segmentRuns, wordTokens, cjkTokens, uniq } from './text.js';
import { COMMON_MATCHERS, parseTimeWith } from './time.js';

/**
 * 各种文字的问号：拉丁 / 全角、西班牙文倒问号、阿拉伯文、亚美尼亚文、埃塞俄比亚文。
 * 希腊文问号（U+037E）经 NFKC 会变成普通分号，和分号分不开，所以不算。
 */
const QUESTION_MARKS = /[?？¿؟՞፧]/u;
const QUESTION_END = /[?？؟՞፧]["'”’»)）\]」』\s]*$/u;

/**
 * 「看起来在问过去」的示例问法：嵌入模型是多语言的，没有专门分析器的语言也能拿它们比相似度（§6.6）。
 * 只是示例句，不是关键词。
 */
export const UND_PAST_EXEMPLARS = Object.freeze([
  'do you remember what I told you last time',
  'what happened with that in the end',
  'did you get it done',
  'what did we talk about the other day',
  'how did it go',
  'what was that place called again',
]);

/**
 * @param {{tzOffsetMin?: number|null, params?: () => {tzOffsetMin?: number|null}}} [opt]
 * @returns {import('../ports/index.js').LanguageAnalyzer}
 */
export function createUnicode(opt = {}) {
  const tz = () => {
    if (typeof opt.params === 'function') {
      try { const p = opt.params(); if (p && p.tzOffsetMin !== undefined) return p.tzOffsetMin; } catch { /* 用 opt 里的 */ }
    }
    return opt.tzOffsetMin ?? null;
  };
  return {
    lang: 'und',
    detect: () => 0.01,
    tokenize(text) {
      const out = [];
      for (const run of segmentRuns(prep(text))) {
        if (run.cls === 'word') out.push(...wordTokens(run.text));
        else out.push(...cjkTokens(run.chars));
      }
      return uniq(out);
    },
    parseTime: (text, at) => parseTimeWith(text, at, { matchers: COMMON_MATCHERS, tzOffsetMin: tz() }),
    pastQuestionExemplars: () => [...UND_PAST_EXEMPLARS],
    questionCue(text) {
      const t = String(text ?? '').normalize('NFKC').trim();
      if (!t) return 0;
      if (QUESTION_END.test(t)) return 1;
      return QUESTION_MARKS.test(t) ? 0.5 : 0;
    },
  };
}
