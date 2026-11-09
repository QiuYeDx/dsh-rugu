// JSONL 宽进严出（§7.3：DSH 没有 JSON 模式）。纯函数：逐行 JSON.parse，坏行跳过并计数；不认识的 type 丢掉。
export const LINE_TYPES = Object.freeze(['header', 'narrative', 'ent', 'fact', 'plan', 'plan_status', 'intent', 'rel', 'norm_update',
  'self', 'emotion', 'confirm', 'future_q', 'boundary']);
const TYPES = new Set(LINE_TYPES);

/** 一行里如果混着别的文字（「好的：{...}」），取出第一个完整的 {...}。 */
function extractObject(s) {
  const i = s.indexOf('{');
  if (i < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (c === '\\') j += 1;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

function accept(v, out, types) {
  if (Array.isArray(v)) { let ok = false; for (const x of v) ok = accept(x, out, types) || ok; return ok; }
  if (!v || typeof v !== 'object') return false;
  const type = typeof v.type === 'string' ? v.type.trim().toLowerCase() : '';
  if (!types.has(type)) return true;   // 能解析、但不认识的 type：丢掉，不算坏行
  out.push({ ...v, type });
  return true;
}

/**
 * 实现 encode.parseJsonl。
 * @param {string} text
 * @returns {{lines: import('./index.js').ExtractLine[], errors: number}}
 */
export function parseJsonl(text) {
  return parseJsonlWith(text, TYPES);
}

/** 同样的宽进严出，认的 type 由调用方给（夜间复核的 review 行）。 */
export function parseJsonlWith(text, types) {
  const lines = [];
  let errors = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let s = raw.trim();
    if (!s || /^```/.test(s) || s === '[' || s === ']') continue;
    if (s.endsWith(',')) s = s.slice(0, -1);
    let v;
    try { v = JSON.parse(s); } catch {
      const obj = extractObject(s);
      if (obj) { try { v = JSON.parse(obj); } catch { v = undefined; } }
    }
    if (v === undefined || !accept(v, lines, types)) errors += 1;
  }
  return { lines, errors };
}
