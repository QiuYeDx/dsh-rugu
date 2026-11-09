// 集成层共用的小工具：清洗、截断、超时、随机串、原子写文件。只用 Node 内置模块。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 不可见字符：零宽、方向控制、BOM 等（§10.4 清洗规则沿用 v1:839）。 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * 给提示词用的清洗（§10.4）：【】换成「」（唤醒头、注入块头都用【】，记忆里的文字不能伪造它们），
 * 去不可见字符和控制字符，折叠换行，插值语法 {{ }} 拆开（F2：我们的 context 都是 interpolate:false，这里再兜一层）。
 * @param {unknown} text
 * @param {{keepNewlines?: boolean}} [opt]
 */
export function sanitizeForPrompt(text, { keepNewlines = false } = {}) {
  let s = String(text ?? '').replace(INVISIBLE, '').replace(CONTROL, '');
  s = s.replace(/【/g, '「').replace(/】/g, '」');
  s = s.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  s = keepNewlines ? s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s*[\r\n]+\s*/g, ' ');
  return s.trim();
}

/** 按字符（码点）截断，超出时末尾加「…」。 */
export function clip(text, max) {
  const s = String(text ?? '');
  if (!(max > 0)) return '';
  const cps = [...s];
  return cps.length <= max ? s : `${cps.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** 码点长度。 */
export const charLen = (s) => [...String(s ?? '')].length;

/** 不透明的随机串（base64url），用作 nonce、令牌。 */
export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

/** sha256 的前 n 位十六进制。 */
export const sha = (text, n = 16) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, n);

/** 错误的类型名（只记类型，不记消息原文：消息里可能带内容，§12.3）。 */
export const errCode = (e) => String(e?.code ?? e?.name ?? 'Error').slice(0, 64);

/** 带取消的等待。 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(signal.reason ?? abortError()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export function abortError(message = 'aborted') {
  const e = new Error(message);
  e.name = 'AbortError';
  e.code = 'ABORTED';
  return e;
}

/**
 * 给一个 Promise 加截止时间：到点返回 {timedOut: true}，不抛错；原 Promise 的错误照常返回 {error}。
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<{value?: T, error?: unknown, timedOut?: boolean}>}
 */
export function settleWithin(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, Math.max(0, ms));
    Promise.resolve(p).then(
      (value) => { if (!done) { done = true; clearTimeout(t); resolve({ value }); } },
      (error) => { if (!done) { done = true; clearTimeout(t); resolve({ error }); } },
    );
  });
}

/** 组合多个取消信号（AbortSignal.any 不在时的退路）。 */
export function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ac = new AbortController();
  for (const s of list) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

/** 读 JSON 文件；不存在返回 fallback，坏了抛出带 code 的错误。 */
export function readJson(file, fallback = null) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return fallback; throw e; }
  try { return JSON.parse(raw.replace(/^﻿/, '')); } catch { const e = new Error('JSON 解析失败'); e.code = 'BAD_JSON'; throw e; }
}

/** 原子写 JSON：先写临时文件再 rename。 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomId(4)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } throw e; }
}

/** 本地日期键 YYYY-MM-DD（预算按本机的日子算）。 */
export function localDay(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export { isPlain };

/** 深冻结。 */
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** 一个很小的环形计数窗：记最近 n 个耗时，给 p95。 */
export class Durations {
  constructor(n = 200) { this.n = n; this.list = []; this.count = 0; }
  add(ms) { this.count += 1; this.list.push(ms); if (this.list.length > this.n) this.list.shift(); }
  pct(p) {
    if (!this.list.length) return null;
    const s = [...this.list].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
  }
}

const TO_HER = new Set(['to-her', 'mentions-her']);
/**
 * 这一轮由哪条感知触发（D104）：绑定认出来的那条（resolveFocus）是对她说的就用它；认不出来、或者认出来的是别人随口的一句，
 * 就取最后一条对她说的（to-her / mentions-her）；都没有才退回最后一条。pre-step（唤醒消息）和工具结果（读消息的工具）用同一个规矩：
 * 读消息的工具一次拿回好几条，最后一条往往是别的群员，拿它当触发者就认错了人（11-05 那次就是这样）。
 * @param {{id: string, addressed?: string, at?: number}[]} obs  这次交给核心的感知（不一定按时间先后，按 at 排）
 * @param {string|null} resolvedId                  绑定认出来的 ObsId（没有就 null）
 * @param {{fallbackLast?: boolean}} [opt]          fallbackLast=false：没有对她说的就返回 null（pre-step 原来的口径）
 * @returns {{id: string, addressed?: string, actor?: unknown}|null}
 */
export function pickFocus(obs, resolvedId, { fallbackLast = true } = {}) {
  // 交进来的不一定按时间先后：读消息的工具把「新消息」和「最近的上下文」拼在一起（[新的…, 较早的…]），按数组顺序取「最后一条」
  // 会取到更早的那条（评审）。按事情发生的时间排一遍（同一时间的保持原来的先后）
  const list = (Array.isArray(obs) ? obs.filter((o) => o && typeof o.id === 'string') : [])
    .map((o, i) => ({ o, i, t: Number.isFinite(o.at) ? o.at : Number.isFinite(o.perceivedAt) ? o.perceivedAt : null }))
    .sort((x, y) => (x.t != null && y.t != null && x.t !== y.t ? x.t - y.t : x.i - y.i))
    .map((x) => x.o);
  const resolved = resolvedId ? list.find((o) => o.id === resolvedId) ?? null : null;
  if (resolved && TO_HER.has(resolved.addressed)) return resolved;
  const toHer = [...list].reverse().find((o) => TO_HER.has(o.addressed)) ?? null;
  if (toHer) return toHer;
  if (resolved) return resolved;
  return fallbackLast ? (list.at(-1) ?? null) : null;
}

/**
 * 这一批里对她说话的几个人（D108）：主触发者（pickFocus 认出的那条）在前，其余是她上一次开口之后、对她说话的别的人各自最后一条，
 * 按时间从新到旧，最多 max 个（不同的人）。说话人对不上（没有 actor）的只算主触发者那条。
 * @param {{id: string, addressed?: string, at?: number, actor?: unknown, isSelf?: boolean, kind?: string}[]} obs
 * @param {string|null} resolvedId
 * @param {{max?: number, fallbackLast?: boolean}} [opt]
 * @returns {{id: string}[]}
 */
export function pickFoci(obs, resolvedId, { max = 3, fallbackLast = true } = {}) {
  const primary = pickFocus(obs, resolvedId, { fallbackLast });
  if (!primary) return [];
  const list = (Array.isArray(obs) ? obs.filter((o) => o && typeof o.id === 'string') : [])
    .map((o, i) => ({ o, i, t: Number.isFinite(o.at) ? o.at : Number.isFinite(o.perceivedAt) ? o.perceivedAt : null }))
    .sort((x, y) => (x.t != null && y.t != null && x.t !== y.t ? x.t - y.t : x.i - y.i))
    .map((x) => x.o);
  // 她上一次开口之后的那几条
  let start = 0;
  list.forEach((o, i) => { if (o.addressed === 'by-her' || o.actor?.self === true) start = i + 1; });
  const keyOf = (o) => { try { return o.actor ? JSON.stringify(o.actor) : null; } catch { return null; } };
  const out = [primary];
  const seen = new Set([keyOf(primary)]);
  for (const o of list.slice(start).reverse()) {
    if (out.length >= Math.max(1, max)) break;
    if (o.id === primary.id || !TO_HER.has(o.addressed)) continue;
    const k = keyOf(o);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

const atOf = (o) => (Number.isFinite(o?.at) ? o.at : Number.isFinite(o?.perceivedAt) ? o.perceivedAt : null);
/**
 * 一批感知里她这一轮才看到的、别人对她说的（D114 集成复核）：对她说的（to-her / mentions-her）、不是她自己说的、
 * 在这批里她最后一次开口之后的、知道时间而且不早于 floor 的。唤醒消息里的旧上下文（快照的 recent）、翻历史读到的旧消息不算：
 * 拿它们当记忆工具的触发消息，等于借了一条旧消息的说话人的权限去办别人这会儿要她办的事。
 * @param {{id: string, addressed?: string, at?: number, perceivedAt?: number, actor?: any, isSelf?: boolean}[]} obs
 * @param {number|null} floor
 */
export function freshToHer(obs, floor) {
  const list = (Array.isArray(obs) ? obs.filter((o) => o && typeof o.id === 'string' && o.id) : [])
    .map((o, i) => ({ o, i, t: atOf(o) }))
    .sort((x, y) => (x.t != null && y.t != null && x.t !== y.t ? x.t - y.t : x.i - y.i))
    .map((x) => x.o);
  const mine = (o) => o.addressed === 'by-her' || o.isSelf === true || o.actor?.self === true;
  let start = 0;
  list.forEach((o, i) => { if (mine(o)) start = i + 1; });
  return list.slice(start).filter((o) => TO_HER.has(o.addressed) && !mine(o) && atOf(o) != null && (floor == null || atOf(o) >= floor));
}

/**
 * 唤醒消息带来的感知里，哪些能当这一轮的触发消息（D115，实测问题 #26）：只有这一轮新来的。唤醒消息里还带着旧的上下文
 * （QQ 桥接快照的 recent：已经读过的几句）——它们照常入库，但不能当触发消息、焦点、清污点的依据、外发守护的「被回答的人」，
 * 也不能当记忆工具的权限来源。
 *   - 适配器分得出（绑定的 newObsIds 对每条真实消息都给了数组）：只认它说是新的那些；
 *   - 分不出（没有这个钩子、或者给了 null）：兜底——在这批里她最后一次开口之前的不算，知道时间而且早于 floor
 *     （这一轮开始前 tools.seenFreshMs）的不算；不知道时间的照旧算（看不出旧，不改原来的行为）。
 * 她自己的话一律不算。
 * @param {{id: string, addressed?: string, at?: number, perceivedAt?: number, actor?: any, isSelf?: boolean}[]} obs
 * @param {{newIds?: Set<string>|null, floor?: number|null}} [opt]
 */
export function turnCandidates(obs, { newIds = null, floor = null } = {}) {
  const list = (Array.isArray(obs) ? obs.filter((o) => o && typeof o.id === 'string' && o.id) : [])
    .map((o, i) => ({ o, i, t: atOf(o) }))
    .sort((x, y) => (x.t != null && y.t != null && x.t !== y.t ? x.t - y.t : x.i - y.i))
    .map((x) => x.o);
  const mine = (o) => o.addressed === 'by-her' || o.isSelf === true || o.actor?.self === true;
  if (newIds) return list.filter((o) => newIds.has(o.id) && !mine(o));
  // 「她开口」只看她说的话（平台替她记的定时提醒也挂在她名下，不算开口）
  const spoke = (o) => mine(o) && o.kind !== 'reminder';
  let start = 0;
  list.forEach((o, i) => { if (spoke(o)) start = i + 1; });
  return list.slice(start).filter((o) => !mine(o) && (floor == null || atOf(o) == null || atOf(o) >= floor));
}

/** 这一轮最多记几条「她看到的、别人对她说的」（核心的 triggerObsIds 最多 8 条，加上主的那条一共 9）。 */
export const SEEN_MAX = 9;
/**
 * 记下这一轮她看到的、别人对她说的消息（D114）：唤醒消息里的、读消息工具的结果里的都算（在 bridge 的 reserved2 模式下，
 * 新消息常常不是唤醒消息带来的，而是她自己调 qq_wait_for_messages / qq_get_unread_messages 读到的）。
 * 只记对她说的（to-her / mentions-her）、不是她自己说的、有 ObsId 的；按事情发生的时间从新到旧，最多 SEEN_MAX 条。
 * 记忆工具（memory_note / memory_fix）把这些都交给核心，由核心在库里核对哪一条真有她引用的原话、说话人是谁。
 * @param {{obsId: string, actor: unknown, at: number|null}[]} seen   原来的（这一轮早些时候看到的）
 * @param {{id: string, addressed?: string, at?: number, perceivedAt?: number, actor?: any, isSelf?: boolean}[]} obs
 * @returns {{obsId: string, actor: unknown, at: number|null}[]}
 */
export function mergeSeen(seen, obs) {
  const map = new Map((Array.isArray(seen) ? seen : []).map((x) => [x.obsId, x]));
  for (const o of Array.isArray(obs) ? obs : []) {
    if (!o || typeof o.id !== 'string' || !o.id || !TO_HER.has(o.addressed)) continue;
    if (o.isSelf === true || o.actor?.self === true) continue;
    const at = Number.isFinite(o.at) ? o.at : Number.isFinite(o.perceivedAt) ? o.perceivedAt : null;
    map.set(o.id, { obsId: o.id, actor: o.actor ?? map.get(o.id)?.actor ?? null, at });
  }
  return [...map.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, SEEN_MAX);
}
