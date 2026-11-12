// JSONL 宽进严出（§7.3：DSH 没有 JSON 模式）。纯函数：逐行解析，坏行跳过并计数；不认识的 type 丢掉。
// 从文字里取 JSON 的那一层（去思考段、去围栏、从前言里抠出对象、行尾逗号、中文冒号）和第一眼、第二段评估共用 ports/llm-text.js（D169）。
import { stripThinking, jsonValueInLine } from '../ports/llm-text.js';

export const LINE_TYPES = Object.freeze(['header', 'narrative', 'ent', 'fact', 'plan', 'plan_status', 'intent', 'rel', 'norm_update',
  'self', 'emotion', 'confirm', 'future_q', 'boundary']);
const TYPES = new Set(LINE_TYPES);

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

/**
 * 同样的宽进严出，认的 type 由调用方给（夜间复核的 review 行）。
 * 先去掉思考段（<think>…</think>，D169：里面的草稿行不当成结果、也不算坏行）；一行里混着别的文字（「好的：{...}」）取出第一个带对象的值。
 */
export function parseJsonlWith(text, types) {
  const lines = [];
  let errors = 0;
  for (const raw of stripThinking(String(text ?? '')).split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || /^```/.test(s) || s === '[' || s === ']') continue;
    const v = jsonValueInLine(s);
    if (v === undefined || !accept(v, lines, types)) errors += 1;
  }
  return { lines, errors };
}
