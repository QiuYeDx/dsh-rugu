// 模型输出的文字怎么读（D169，宽进）：DSH 没有 JSON 模式（§7.3），各家模型给的样子不一样——前面多说一句「好的，以下是结果：」、
// 整段套在 ``` 围栏里、输出成一个 JSON 数组、一个对象排成多行缩进、开头带一段 <think>…</think>、行尾多一个逗号、键值之间写成中文冒号。
// 这里只管「从文字里把 JSON 值取出来」，不管字段：取出来以后该怎么校验，由各用途自己照旧做（严出）。
// 纯函数，不 import 任何东西；第一眼、第二段评估、外发审视（discretion）、提炼（encode）、小结和夜间整理（consolidate）、
// 预取改写（retrieve）、媒体摘一句（intake）共用这一套，不各写一份。

/** 最多看这么多字（超长的输出只看前面这一段：扫描是线性的，失败的起点有上限，不会被一串「{{{{」拖慢）。 */
export const LLM_TEXT_MAX_CHARS = 64_000;
/** 一段输出里最多取这么多个值（再多的不要：结果最多几十行）。 */
const MAX_VALUES = 400;
/** 起点配不上（括号不成对、解析不了）最多试这么多次；找配对结尾一共最多走这么多步（一串「{{{{」不会拖慢）。 */
const MAX_FAILED_STARTS = 2000;
const MAX_SCAN_STEPS = 2_000_000;

const THINK_TAGS = 'think|thinking|reasoning';
const THINK_BLOCK = new RegExp(`<(${THINK_TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi');
const THINK_OPEN = new RegExp(`<(?:${THINK_TAGS})\\b[^>]*>`, 'i');
const THINK_CLOSE = new RegExp(`</(?:${THINK_TAGS})\\s*>`, 'gi');

/**
 * 去掉思考段：完整的 <think>…</think>（也认 <thinking>、<reasoning>）整段去掉；只有开头没有结尾的（输出在思考里被截断）从开头到末尾都去掉；
 * 只有结尾没有开头的（有的服务商把开头吃掉了），结尾之前的都算思考。没有这些标签的文字原样返回。
 * @param {unknown} text
 * @returns {string}
 */
export function stripThinking(text) {
  let t = String(text ?? '');
  if (!/<\/?(?:think|thinking|reasoning)\b/i.test(t)) return t;
  t = t.replace(THINK_BLOCK, '');
  const open = THINK_OPEN.exec(t);
  if (open) t = t.slice(0, open.index);
  let last = -1;
  let len = 0;
  for (const m of t.matchAll(THINK_CLOSE)) { last = m.index; len = m[0].length; }
  if (last >= 0) t = t.slice(last + len);
  return t;
}

/** 去掉代码块围栏的记号（```、```json、```jsonl……），里面的内容留下。 */
export function stripFences(text) {
  return String(text ?? '').replace(/```[A-Za-z0-9_-]*/g, '\n');
}

/**
 * 从 s[i]（「{」或「[」）开始找配对的结尾：认字符串（"…" 里的括号不算）和转义；两种括号必须成对、不能交错。
 * @param {string} s
 * @param {number} i
 * @param {{left: number}} [budget]  还能走几步（大家共用；走完了按配不上算）
 * @returns {number}  结尾的下标；配不上返回 -1
 */
export function balancedEnd(s, i, budget = { left: Infinity }) {
  const stack = [];
  let inStr = false;
  for (let j = i; j < s.length; j++) {
    if (--budget.left < 0) return -1;
    const c = s[j];
    if (inStr) {
      if (c === '\\') j += 1;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return j;
    }
  }
  return -1;
}

/**
 * 修一段 JSON 里模型常犯的小毛病（只动字符串外面的字）：中文冒号、中文逗号换成英文的；「}」「]」前面多出来的逗号去掉。
 * @param {string} seg
 * @returns {string}
 */
function repairJson(seg) {
  let out = '';
  let inStr = false;
  for (let j = 0; j < seg.length; j++) {
    let c = seg[j];
    if (inStr) {
      out += c;
      if (c === '\\') { out += seg[j + 1] ?? ''; j += 1; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '：') c = ':';
    else if (c === '，') c = ',';
    if (c === ',') {
      let k = j + 1;
      while (k < seg.length && /\s/.test(seg[k])) k += 1;
      if (seg[k] === '}' || seg[k] === ']') continue;
    }
    out += c;
  }
  return out;
}

/**
 * 解析一段 JSON：先原样解析，不行再修一遍小毛病（repairJson）。解析不了返回 undefined。
 * @param {string} seg
 * @returns {unknown}
 */
export function parseLooseJson(seg) {
  try { return JSON.parse(seg); } catch { /* 修一修再试 */ }
  try { return JSON.parse(repairJson(seg)); } catch { return undefined; }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 文字里的顶层 JSON 值（对象和数组），按出现的顺序：从每个「{」「[」找配对的结尾、解析（带修补）；成了就跳到结尾之后接着找，
 * 不成就从下一个字接着找（所以一个坏掉的大数组里的好元素、一段散文里混着的对象都取得出来）。字符串里的东西不算。
 * @param {string} text  已经去掉思考段和围栏的文字
 * @returns {{value: unknown, start: number, end: number}[]}
 */
export function jsonValuesIn(text) {
  const t = String(text ?? '');
  const out = [];
  let failed = 0;
  const budget = { left: MAX_SCAN_STEPS };
  for (let i = 0; i < t.length && out.length < MAX_VALUES && budget.left > 0; i++) {
    const c = t[i];
    if (c !== '{' && c !== '[') continue;
    const end = balancedEnd(t, i, budget);
    if (end < 0) { if (++failed > MAX_FAILED_STARTS) break; continue; }
    const v = parseLooseJson(t.slice(i, end + 1));
    if (v === undefined || v === null || typeof v !== 'object') { if (++failed > MAX_FAILED_STARTS) break; continue; }
    out.push({ value: v, start: i, end });
    i = end;
  }
  return out;
}

/** 值 → 里面的对象：对象就是它自己；数组取里面的对象（数组套数组再展开一层）。 */
function objectsOf(v, depth = 0) {
  if (isPlain(v)) return [v];
  if (Array.isArray(v) && depth < 2) return v.flatMap((x) => objectsOf(x, depth + 1));
  return [];
}

/**
 * 模型输出里的 JSON 对象（宽进）。先按行：去掉围栏记号和行尾逗号以后整行就是一个 JSON 对象（或一行数组）的，是「干净的」；
 * 再在整段文字里找别的（前言后面跟着的、多行排版的、数组里的、夹在散文里的）。干净的排在前面，其余按出现的顺序跟在后面——
 * 输出里另有一个看起来像结果的 JSON（举例、自言自语）时，按行写好的那一份先被用到。
 * 现在能解析的输出（每行一个对象，DeepSeek 的样子）结果和原来逐项相同：那些行全是干净的；散文行里能解析出 JSON 的才会多出来。
 * @param {unknown} text
 * @returns {{objects: object[], clean: number}}  clean：其中干净的有几个（排在最前面）
 */
export function readJsonObjects(text) {
  const t = stripFences(stripThinking(String(text ?? '').slice(0, LLM_TEXT_MAX_CHARS)));
  const found = jsonValuesIn(t);
  if (!found.length) return { objects: [], clean: 0 };
  // 每个值在哪一行、那一行是不是整行就是它
  const lineStarts = [0];
  for (let i = 0; i < t.length; i++) if (t[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const clean = [];
  const rest = [];
  for (const f of found) {
    const ln = lineOf(f.start);
    const lineEnd = ln + 1 < lineStarts.length ? lineStarts[ln + 1] - 1 : t.length;
    const before = t.slice(lineStarts[ln], f.start).trim();
    const after = t.slice(f.end + 1, lineEnd).trim();
    const whole = lineOf(f.end) === ln && before === '' && (after === '' || after === ',');
    (whole ? clean : rest).push(...objectsOf(f.value));
  }
  return { objects: [...clean, ...rest], clean: clean.length };
}

/**
 * 一行文字里的 JSON 值（逐行解析的用途：提炼、夜间整理）：整行能解析（带修补、去掉行尾逗号）就是它；否则取行里第一个能解析的值
 *（「好的：{...}」「1. {...} 以上」）。都没有返回 undefined。
 * @param {string} line
 * @returns {unknown}
 */
export function jsonValueInLine(line) {
  let s = String(line ?? '').trim();
  if (s.endsWith(',')) s = s.slice(0, -1).trimEnd();
  if (s[0] === '{' || s[0] === '[') {
    const v = parseLooseJson(s);
    if (v !== undefined) return v;
  }
  // 行里有好几个值（「[1] {...}」）：取第一个带对象的
  const vals = jsonValuesIn(s);
  return (vals.find((x) => objectsOf(x.value).length > 0) ?? vals[0])?.value;
}
