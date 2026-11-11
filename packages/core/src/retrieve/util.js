// retrieve 内部的小工具：截止时间、批量 SQL、计数和日志（日志只记 id、类型、计数，§12.3）。
import crypto from 'node:crypto';
import { bumpMetric } from '../store/kv.js';
import { parseRef } from '../store/refs.js';

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const errKind = (e) => e?.code ?? e?.name ?? 'Error';
/** 墙钟毫秒（只用来量延迟和截止时间；记忆里的时间一律 core.now()）。 */
export const wall = () => performance.now();

export function sha(s, n = 16) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);
}

/** 计数，失败（只读、库坏了）就算了。 */
export function metric(core, name, by = 1) {
  try {
    if (core.store && !core.store.closed && !core.store.readOnly) bumpMetric(core.store, name, by, core.now());
  } catch { /* 计数失败不影响回想 */ }
}
export function log(core, level, event, fields = {}) {
  try { core.log?.[level]?.(event, fields); } catch { /* 日志失败不影响回想 */ }
}

/** 同步地试一下，出错返回 fallback（记一条 debug，只记错误类型）。 */
export function safe(core, what, fn, fallback) {
  try { return fn(); } catch (e) {
    log(core, 'debug', 'retrieve.degraded', { what, error: errKind(e) });
    return fallback;
  }
}

/**
 * 带截止时间跑一段异步活：到点就放弃（返回 timedOut），出错返回 error，永不抛。
 * 给 run 的 signal 在截止或上游取消时 abort，worker 可以据此提前停。
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>|T} run
 * @param {number} ms
 * @param {AbortSignal} [parent]
 * @returns {Promise<{value?: T, error?: unknown, timedOut: boolean, ms: number}>}
 */
export function withDeadline(run, ms, parent) {
  const ac = new AbortController();
  const t0 = wall();
  const onAbort = () => ac.abort();
  if (parent) {
    if (parent.aborted) ac.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve({ timedOut: true }); }, Math.max(0, ms));
    timer.unref?.();
  });
  const work = Promise.resolve()
    .then(() => (ac.signal.aborted ? Promise.reject(abortError()) : run(ac.signal)))
    .then((value) => ({ value, timedOut: false }), (error) => ({ error, timedOut: false }));
  return Promise.race([work, timeout]).then((r) => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
    return { ...r, ms: wall() - t0 };
  });
}
function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** 等一会儿（不抛、不挡进程退出）。 */
export function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, ms)); t.unref?.(); });
}

/** 按 id 批量取行（IN 的参数分批，免得超过 SQLite 的参数上限）。 */
export function rowsByIds(store, sql, ids, chunk = 500) {
  const out = [];
  const list = [...new Set(ids)].filter((x) => Number.isInteger(x) && x > 0);
  for (let i = 0; i < list.length; i += chunk) {
    const part = list.slice(i, i + chunk);
    out.push(...store.all(sql.replace('(?*)', `(${part.map(() => '?').join(',')})`), ...part));
  }
  return out;
}

export function parseJson(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** 按码位截断（不切坏 emoji），超出时末尾加「…」。 */
export function clip(s, max) {
  const chars = Array.from(String(s ?? ''));
  if (chars.length <= max) return chars.join('');
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}
export const charLen = (s) => Array.from(String(s ?? '')).length;

/** 有效的记忆引用 → MemoryRef；不认识的返回 null。 */
export const mrefOf = (ref) => parseRef(ref);

/** 两个归一化向量的余弦。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
/** 几条向量的平均再归一化（伪查询向量用，§8.8）。 */
export function meanVector(vectors) {
  const vs = vectors.filter((v) => v && v.length);
  if (!vs.length) return null;
  const dim = vs[0].length;
  const out = new Float32Array(dim);
  for (const v of vs) { if (v.length !== dim) continue; for (let i = 0; i < dim; i++) out[i] += v[i]; }
  let n = 0;
  for (let i = 0; i < dim; i++) n += out[i] * out[i];
  if (n === 0) return null;
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < dim; i++) out[i] *= inv;
  return out;
}

/** 她自己的实体 id（找到一次就记住；没有返回 null，不在这里建）。 */
export function selfId(core) {
  const st = core.state.retrieve;
  if (st?.selfId) return st.selfId;
  const row = safe(core, 'self', () => core.store.get('SELECT id FROM entities WHERE is_self = 1'), null);
  if (row?.id && st) st.selfId = row.id;
  return row?.id ?? null;
}

/** 这个场合最新一条感知的 id（预取缓存键的一半，§8.1）。 */
/** 全库最新一条感知的 id（D132：别处有没有新的事；没有感知是 0）。 */
export function latestPerceptAnywhere(core) {
  const row = core.store.get('SELECT MAX(id) AS id FROM percepts');
  return row?.id ?? 0;
}
export function latestPerceptOf(core, settingKey) {
  const row = core.store.get('SELECT MAX(id) AS id FROM percepts WHERE setting_key = ?', settingKey);
  return row?.id ?? 0;
}
