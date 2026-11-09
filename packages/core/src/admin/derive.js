// 派生关系（隐藏的级联、彻底删除的展开、墓碑重删共用）。只读：主库上走 encode.derivedFrom（契约），
// 解开的备份副本上（或 encode 不可用时）用同样语义的 SQL。
//   - 证据感知：一条记忆是从哪几条感知来的（sources.percept_id；情节另加归进它的感知；窗口是它的成员）。
//   - 窗口成员看 members_json（intake 按（场合，visible_to）分别切窗口，D53：同一段 id 范围里可能是别的窗口）。
import { refOf } from '../store/refs.js';

/** 各主表「这一行是什么时候有的」那一列：墓碑按时间生效（D42），主表 id 不是 AUTOINCREMENT，删掉最新的一行之后新行会拿到同一个 id。 */
export const CREATED = Object.freeze({
  percept: 'created_at', window: 'created_at', episode: 'created_at', assertion: 'created_at', entity: 'created_at',
  impression: 'built_at', intention: 'created_at', storyline: 'updated_at', community: 'built_at', link: 'at',
});

const tableCache = new WeakMap();
function cacheOf(db) {
  let m = tableCache.get(db);
  if (!m) { m = new Map(); tableCache.set(db, m); }
  return m;
}
export function hasTable(db, name) {
  const m = cacheOf(db);
  if (!m.has(name)) m.set(name, !!db.get("SELECT 1 FROM sqlite_schema WHERE name = ? AND type IN ('table')", name));
  return m.get(name);
}
export function hasColumn(db, table, col) {
  const key = `${table}.${col}`;
  const m = cacheOf(db);
  if (!m.has(key)) m.set(key, hasTable(db, table) && db.all(`PRAGMA table_info(${table})`).some((c) => c.name === col));
  return m.get(key);
}
const parseIds = (s) => {
  try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x)) : []; } catch { return []; }
};

/** 和 encode.derivedFrom 同样语义的 SQL（备份副本上用）：别的证据 = 别的感知，或没有感知的导入 / 推断 / 她自己生成的来源。 */
function derivedSql(db, perceptId) {
  if (!hasTable(db, 'sources')) return [];
  const out = db.all(`SELECT s.owner_kind AS kind, s.owner_id AS id,
                        (SELECT count(*) FROM sources s2 WHERE s2.owner_kind = s.owner_kind AND s2.owner_id = s.owner_id
                           AND ((s2.percept_id IS NOT NULL AND s2.percept_id <> ?)
                                OR (s2.percept_id IS NULL AND s2.mode IN ('imported','inferred','self_generated')))) AS others
                      FROM sources s WHERE s.percept_id = ? GROUP BY s.owner_kind, s.owner_id`, perceptId, perceptId)
    .map((r) => ({ ref: refOf(r.kind, r.id), onlySource: Number(r.others) === 0 }));
  if (hasColumn(db, 'percepts', 'episode_id')) {
    const p = db.get('SELECT episode_id FROM percepts WHERE id = ?', perceptId);
    if (p?.episode_id && !out.some((x) => x.ref === refOf('episode', p.episode_id))) {
      const n = Number(db.get('SELECT count(*) AS n FROM percepts WHERE episode_id = ? AND id <> ?', p.episode_id, perceptId).n);
      out.push({ ref: refOf('episode', p.episode_id), onlySource: n === 0 });
    }
  }
  return out;
}

/**
 * 以这条感知为来源的记忆。
 * @param {object} core
 * @param {import('../store/db.js').Store} db
 * @param {number} perceptId
 * @returns {{ref: string, onlySource: boolean}[]}
 */
export function derivedOf(core, db, perceptId) {
  if (db === core.store) {
    try { const r = core.mods.encode.derivedFrom(core, perceptId); if (Array.isArray(r)) return r; } catch { /* 退回 SQL */ }
  }
  return derivedSql(db, perceptId);
}

/** 包含这条感知的原文窗口（看成员；没有成员记录的老窗口按 id 范围算，只在同一个场合里找）。 */
export function windowsContaining(db, perceptId) {
  if (!hasTable(db, 'raw_windows')) return [];
  const p = hasTable(db, 'percepts') ? db.get('SELECT setting_key FROM percepts WHERE id = ?', perceptId) : null;
  const rows = p
    ? db.all('SELECT id, members_json FROM raw_windows WHERE setting_key = ? AND first_percept <= ? AND last_percept >= ?', p.setting_key, perceptId, perceptId)
    : db.all('SELECT id, members_json FROM raw_windows WHERE first_percept <= ? AND last_percept >= ?', perceptId, perceptId);
  const out = [];
  for (const w of rows) {
    const members = parseIds(w.members_json);
    if (members.length ? members.includes(perceptId) : !!p) out.push(w.id);
  }
  return out;
}

/** 窗口的成员感知。 */
export function windowMembers(db, windowId) {
  const w = hasTable(db, 'raw_windows') ? db.get('SELECT members_json FROM raw_windows WHERE id = ?', windowId) : null;
  if (!w) return [];
  const members = parseIds(w.members_json);
  if (members.length) return members;
  return hasColumn(db, 'percepts', 'window_id') ? db.all('SELECT id FROM percepts WHERE window_id = ? ORDER BY id', windowId).map((r) => r.id) : [];
}

/**
 * 一条记忆的证据感知。
 * @param {import('../store/db.js').Store} db
 * @param {{kind: string, id: number}} m
 * @returns {number[]}
 */
export function evidencePercepts(db, m) {
  if (m.kind === 'percept') return [m.id];
  if (m.kind === 'window') return windowMembers(db, m.id);
  const ids = new Set();
  if (hasTable(db, 'sources')) {
    for (const r of db.all('SELECT DISTINCT percept_id AS p FROM sources WHERE owner_kind = ? AND owner_id = ? AND percept_id IS NOT NULL', m.kind, m.id)) ids.add(r.p);
  }
  if (m.kind === 'episode' && hasColumn(db, 'percepts', 'episode_id')) {
    for (const r of db.all('SELECT id FROM percepts WHERE episode_id = ?', m.id)) ids.add(r.id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** 情节的种类（event / summary / diary / lapse / import）。 */
export function episodeKind(db, id) {
  if (!hasColumn(db, 'episodes', 'ep_kind')) return null;
  return db.get('SELECT ep_kind FROM episodes WHERE id = ?', id)?.ep_kind ?? null;
}
