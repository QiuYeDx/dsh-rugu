// 分词的公共部分（zh 和 und 共用）：把文字按「文字类别」切成连续段，再从段里出词。
// 规矩：
//   - 这里只做语言层面的通用切分，不放任何词表；
//   - 出来的词最后都会再过 store.normalizeToken（NFKC + 小写 + 只留字母数字下划线），index 和 query 用同一套切法，两边一定对得上；
//   - 下划线一律当分隔符：用户文字永远切不出 `ent_12` 这种形状，实体词元只能由 lang.indexTokens 按实体 id 加（防伪造）。

/** 不用空格分词的文字：汉字、假名、泰文、老挝文、高棉文、缅甸文（加上长音符「ー」、「々」「〇」）。这些按连续段切二元组。 */
const UNSEGMENTED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー々〇]/u;
/** 其他「词里的字符」：字母、数字、组合符号。下划线不算（见文件头）。 */
const WORD_RE = /[\p{L}\p{N}\p{M}]/u;
/** 汉字（检测语言、区分性词用）。 */
export const HAN_RE = /\p{Script=Han}/u;

/** 统一的预处理：NFKC（全角字母数字变半角）、小写。 */
export const prep = (text) => String(text ?? '').normalize('NFKC').toLowerCase();

/**
 * 切成连续段。cls：'cjk' 不用空格分词的文字；'word' 字母数字。其余字符（空白、标点、符号、下划线）是分隔符。
 * @param {string} text 已经过 prep
 * @returns {{cls: 'cjk'|'word', text: string, chars: string[], pos: number}[]}
 */
export function segmentRuns(text) {
  const runs = [];
  let cur = null;
  let pos = 0;
  for (const ch of text) {
    const cls = UNSEGMENTED_RE.test(ch) ? 'cjk' : WORD_RE.test(ch) ? 'word' : null;
    if (cls && cur && cur.cls === cls) { cur.text += ch; cur.chars.push(ch); }
    else if (cls) { cur = { cls, text: ch, chars: [ch], pos }; runs.push(cur); }
    else cur = null;
    pos += ch.length;
  }
  return runs;
}

/**
 * 字母数字段出的词：整段，加上字母和数字交界处切开的几段（iphone15 → iphone15、iphone、15）。
 * @param {string} word
 * @returns {string[]}
 */
export function wordTokens(word) {
  const out = [word];
  const parts = word.match(/[\p{L}\p{M}]+|\p{N}+/gu);
  if (parts && parts.length > 1) for (const p of parts) out.push(p);
  return out;
}

/**
 * 不用空格分词的段出的词：相邻两字的二元组（F29：两字词靠它匹配）；只有一个字的段保留单字。
 * unigrams=true 时每个字也单独出一个词（zh 没有 jieba 时用，让「猫」这种单字词也能对上）。
 * 按出现位置排：每个位置先二元组、后单字。
 * @param {string[]} chars
 * @param {{unigrams?: boolean}} [opt]
 */
export function cjkTokens(chars, { unigrams = false } = {}) {
  if (chars.length === 1) return [chars[0]];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
    if (unigrams) out.push(chars[i]);
  }
  return out;
}

/** 去掉空串、去重，保持第一次出现的顺序。 */
export function uniq(tokens) {
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * 用户词典（实体别名，§8.2）的子串匹配：没有 jieba 时，词典里的词出现在文字里就整词出一个词元，
 * 这样「小鱼干」和「小鱼」在词法路上分得开（二元组分不开，§5.2）。
 */
export class DictMatcher {
  constructor() {
    /** @type {Map<string, Set<string>>} 首字 → 词 */
    this.byFirst = new Map();
    this.maxLen = 0;
    this.size = 0;
  }
  /** @param {string[]} words */
  set(words) {
    this.byFirst = new Map();
    this.maxLen = 0;
    this.size = 0;
    for (const w0 of words ?? []) {
      const w = prep(w0).replace(/[\s_]+/g, '');
      const chars = [...w];
      if (chars.length < 2 || chars.length > 32) continue;
      let set = this.byFirst.get(chars[0]);
      if (!set) { set = new Set(); this.byFirst.set(chars[0], set); }
      if (!set.has(w)) { set.add(w); this.size += 1; }
      this.maxLen = Math.max(this.maxLen, chars.length);
    }
  }
  /**
   * 文字里出现的词典词，按位置排。
   * @param {string} text 已经过 prep
   * @returns {{pos: number, word: string}[]}
   */
  scan(text) {
    if (!this.size) return [];
    const chars = [...text];
    const out = [];
    let pos = 0;
    for (let i = 0; i < chars.length; i++) {
      const set = this.byFirst.get(chars[i]);
      if (set) {
        for (let len = Math.min(this.maxLen, chars.length - i); len >= 2; len--) {
          const w = chars.slice(i, i + len).join('');
          if (set.has(w)) out.push({ pos, word: w });
        }
      }
      pos += chars[i].length;
    }
    return out;
  }
}

/**
 * 文字里各类字符的数量（语言检测用）。
 * @param {string} text
 */
export function scriptCounts(text) {
  const c = { han: 0, kana: 0, hangul: 0, otherLetters: 0, total: 0 };
  for (const m of String(text ?? '').matchAll(/\p{Script=Han}|[\p{Script=Hiragana}\p{Script=Katakana}]|\p{Script=Hangul}|\p{L}/gu)) {
    const ch = m[0];
    c.total += 1;
    if (HAN_RE.test(ch)) c.han += 1;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) c.kana += 1;
    else if (/\p{Script=Hangul}/u.test(ch)) c.hangul += 1;
    else c.otherLetters += 1;
  }
  return c;
}
