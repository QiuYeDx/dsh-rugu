// store 自己的几张公共表的读写：meta、cursors、metrics、prompt_versions。
// 这几张表归 store，任何模块都通过这里的函数读写（不直接写 SQL）。
import crypto from 'node:crypto';

// ── meta：键名按模块加前缀，例如 'sleep.lastAt'、'retention.pending' ──────────
export function getMeta(store, key) {
  return store.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
}
export function setMeta(store, key, value) {
  store.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, value == null ? null : String(value));
}
export function getMetaJson(store, key, fallback = null) {
  const v = getMeta(store, key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
export const setMetaJson = (store, key, value) => setMeta(store, key, JSON.stringify(value));

// ── cursors ──────────────────────────────────────────────────────────────
/** 适配器游标的 source 名。 */
export const adapterCursorSource = (adapterId) => `adapter:${adapterId}`;
export function getCursor(store, source, key) {
  return store.get('SELECT value FROM cursors WHERE source = ? AND key = ?', source, key)?.value ?? null;
}
/** 推进游标。§12.8 第 1 条：适配器游标必须和对应的感知在同一个事务里调用。 */
export function setCursor(store, source, key, value) {
  store.run(`INSERT INTO cursors(source, key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(source, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  source, key, String(value), store.now());
}

// ── metrics：只记数字（§13.3） ──────────────────────────────────────────────
export const utcDay = (at) => new Date(at).toISOString().slice(0, 10);
export function bumpMetric(store, name, by = 1, at = store.now()) {
  if (store.readOnly) return;
  store.run(`INSERT INTO metrics(day, name, value) VALUES (?, ?, ?)
             ON CONFLICT(day, name) DO UPDATE SET value = value + excluded.value`, utcDay(at), name, by);
}
export function readMetrics(store, { day, prefix } = {}) {
  const rows = day ? store.all('SELECT day, name, value FROM metrics WHERE day = ? ORDER BY name', day)
    : store.all('SELECT day, name, value FROM metrics ORDER BY day, name');
  return prefix ? rows.filter((r) => r.name.startsWith(prefix)) : rows;
}

// ── prompt_versions（§8.9） ──────────────────────────────────────────────
/**
 * 登记一个提示词版本（同一 use + version 重复登记无副作用；内容变了但版本号没变会报错，逼着改版本号）。
 * @returns {string} 内容哈希
 */
export function registerPromptVersion(store, use, version, text) {
  const hash = crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
  const row = store.get('SELECT hash FROM prompt_versions WHERE use = ? AND version = ?', use, version);
  if (row) {
    if (row.hash !== hash) throw new Error(`提示词 ${use}@${version} 的内容变了，请换一个版本号`);
    return hash;
  }
  store.run('INSERT INTO prompt_versions(use, version, hash, created_at) VALUES (?, ?, ?, ?)', use, version, hash, store.now());
  return hash;
}
