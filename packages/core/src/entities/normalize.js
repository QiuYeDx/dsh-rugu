// 名字和关系的规范化（§5.2）。
//   - 逐个码点做 NFKC + 小写，只留字母、数字和组合符（任何文字都留着）：中文名绝不会被规范化成空串
//     （Graphiti 把非 ASCII 全删掉，所有中文名都变成空串、被合并成一个，业界:139-147）。
//   - 只做「完全相等」的比较，不做字符串模糊匹配：「小鱼干」≠「小鱼」。
//   - 名字匹配器扫正文时用同一个逐字符规范化，并保留回到原文位置的映射，两边一定对得上。
// 纯函数，没有状态。

const KEEP = /[\p{L}\p{N}\p{M}]/u;
const ASCII_ALNUM = /[A-Za-z0-9]/;
const cache = new Map();
const CACHE_MAX = 4096;

/** 一个码点规范化后的样子（可能是空串，也可能变成几个字符，比如全角、合字）。 */
export function normChar(ch) {
  let v = cache.get(ch);
  if (v !== undefined) return v;
  v = '';
  for (const c of ch.normalize('NFKC').toLowerCase()) if (KEEP.test(c)) v += c;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ch, v);
  return v;
}

/**
 * 名字（也用于关系词）→ 比较用的键。规范化后为空（全是符号、表情）时退回 NFKC + 去空白的原文，
 * 这样它仍然只和自己相等，而不是和所有「空名字」相等。
 * @param {string|null|undefined} s
 * @returns {string}
 */
export function normalizeName(s) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (const ch of s) out += normChar(ch);
  if (out) return out;
  return s.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

/**
 * 正文 → 规范化后的码点数组 + 每个码点在原文里的 [start, end)。
 * @param {string} text
 * @returns {{chars: string[], map: [number, number][]}}
 */
export function normalizeWithMap(text) {
  const chars = [];
  const map = [];
  let i = 0;
  for (const ch of String(text ?? '')) {
    const start = i;
    i += ch.length;
    const n = normChar(ch);
    if (!n) continue;
    for (const c of n) { chars.push(c); map.push([start, i]); }
  }
  return { chars, map };
}

/** 一个码点串的长度（不是 UTF-16 长度）。 */
export const charLength = (s) => { let n = 0; for (const _ of s) n++; return n; };

/** 是不是 ASCII 字母数字（名字两头是拉丁字母时要按整词匹配：「Tom」不该命中「Tomato」）。 */
export const isAsciiAlnum = (c) => typeof c === 'string' && c.length > 0 && ASCII_ALNUM.test(c);

/** 原文里截出来、准备存进库的名字：去首尾空白、折叠空白、限长。 */
export function cleanRaw(s, max = 64) {
  if (typeof s !== 'string') return '';
  const t = s.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return [...t].slice(0, max).join('');
}

/** 实体种类（开放词表）的规范形：小写、去空白；空的当 'unknown'。 */
export function normalizeKind(kind) {
  const k = typeof kind === 'string' ? kind.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '-') : '';
  return k ? [...k].slice(0, 32).join('') : 'unknown';
}

/**
 * 核心自己的档案结构里「不是具体的个人」的种类（§5.2 的 kind 列：宠物、物品、地点、组织、群体、作品、游戏、场合、话题）。
 * 这是档案结构的取值，不是判断内容用的词表；提炼的提示词按这几个值输出 kind（encode）。
 * 不认识的种类按「个人」算：宁可规范更严，也不把别人的事当成不涉及别人（§5.6 involves_others）。
 */
export const NON_INDIVIDUAL_KINDS = Object.freeze(new Set(['pet', 'object', 'place', 'org', 'group', 'work', 'game', 'setting', 'topic']));

/**
 * 某个种类的实体是不是具体的个人。explicit（提炼输出里可选的 individual 字段）优先。
 * @param {string} kind 规范化过的种类
 * @param {boolean} [explicit]
 */
export function individualOf(kind, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  if (kind === 'self') return false;
  return !NON_INDIVIDUAL_KINDS.has(kind);
}
