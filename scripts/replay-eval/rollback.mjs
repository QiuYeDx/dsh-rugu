// 回放评测（D152）：把库副本拨回「那一刻」T。规则写成一张登记表，每张表一条（方案：私有笔记里的回放评测方案 §1.2）。
//   - 「那一刻」按入库时间算（percepts.created_at 等），不是事件时间：迟到的消息当时还不在库里。
//   - 启动时把库里的表清单和登记表对一遍：有没登记的表（以后加了迁移忘了登记）就拒绝跑，不会悄悄变得不忠实。
//   - 每次拨回之后逐表断言没有晚于 T 的行。
//   - 只动副本：调用方先把源库复制出来，这里打开的永远是副本。
// 和方案 §1.2 不一样的地方写在 NOT_RESTORED 和各条的 why 里，报告原样带上。
import { DatabaseSync } from 'node:sqlite';

/**
 * 主库的登记表。rule：
 *   time     只追加，删掉 col > T 的行（parent 给了的，主记录被删的也跟着删）
 *   parent   跟着主表删（主记录被删了就删）
 *   restore  会被改写的状态，按 T 还原（见 restoreAll）；col 给了的也先按时间删
 *   keep     配置、词表、序号：和时间无关，不动
 *   ignore   回想不读（计数、备份记录、提炼配额……），不动
 * parent：'owner'（owner_kind / owner_id 指向 OWNER_TABLES）、或 {col, table}（col 指向 table.id）。
 */
export const MAIN_REGISTRY = Object.freeze({
  percepts: { rule: 'restore', col: 'created_at', why: '按入库时间删；episode_id / window_id 指向的被删了就清空' },
  raw_windows: { rule: 'time', col: 'created_at' },
  episodes: { rule: 'time', col: 'created_at' },
  assertions: { rule: 'restore', col: 'created_at', why: '按入库时间删；取代它的那条被删了、过期时间晚于 T 的清掉；计划状态按 plan_status_history 取 T 时的值；夜里核对改过的把握度还原成核对前' },
  assertion_entities: { rule: 'parent', parent: [{ col: 'assertion_id', table: 'assertions' }, { col: 'entity_id', table: 'entities' }] },
  sources: { rule: 'time', col: 'at', parent: 'owner' },
  glances: { rule: 'restore', col: 'created_at', why: '那一刻还没看完的（done_at > T）还原成没看完' },
  known_by: { rule: 'time', col: 'at', parent: 'owner' },
  told_log: { rule: 'time', col: 'at', parent: 'owner' },
  appraisals: { rule: 'time', col: 'at' },
  injections: { rule: 'time', col: 'ts' },
  discretion_log: { rule: 'time', col: 'at' },
  utterances: { rule: 'time', col: 'created_at' },
  presence_sets: { rule: 'time', col: 'at' },
  setting_snapshots: { rule: 'time', col: 'at' },
  settings: { rule: 'restore', why: 'T 之后才出现的场合删掉；current_snapshot_id 取 T 之前最后一份快照' },
  setting_rules: { rule: 'time', col: 'at' },
  mood: { rule: 'time', col: 'at' },
  intentions: { rule: 'restore', col: 'created_at', why: '状态按 armed_at / executions_json 里的时间取 T 时的值' },
  entities: { rule: 'time', col: 'created_at' },
  entity_names: { rule: 'time', col: 'first', parent: [{ col: 'entity_id', table: 'entities' }] },
  entity_descriptors: { rule: 'time', col: 'created_at', parent: [{ col: 'entity_id', table: 'entities' }] },
  entity_impressions: { rule: 'restore', col: 'built_at', parent: [{ col: 'entity_id', table: 'entities' }], why: '按 built_at 删，每个人每一层取 T 时最新的一版当现行' },
  entity_links: { rule: 'time', col: 'created_at' },
  identity_evidence: { rule: 'time', col: 'created_at' },
  communities: { rule: 'restore', col: 'built_at', why: '按 built_at 删，每个场合取 T 时最新的一版当现行' },
  core_blocks: { rule: 'restore', why: '按 core_block_versions 取 T 时最新的一版' },
  core_block_versions: { rule: 'time', col: 'created_at' },
  embed_texts: { rule: 'time', col: 'created_at', parent: 'owner' },
  traces: { rule: 'time', col: 't', parent: 'owner' },
  activation: { rule: 'restore', parent: 'owner', why: '痕迹按时间删以后，痕迹数和最近一次按剩下的重算；b_cache / tier 打开核心后在 T 重跑一次 retier' },
  flow_norms: { rule: 'parent', parent: 'owner' },
  plan_status_history: { rule: 'time', col: 'at', parent: [{ col: 'assertion_id', table: 'assertions' }] },
  memory_checks: { rule: 'time', col: 'at' },
  need_to_know: { rule: 'restore', col: 'created_at', why: 'T 之后才读的还原成没读' },
  sessions: { rule: 'restore', why: 'T 之后才绑定的删掉；周期取 T 之前最后一块注入的；「本周期已经给过」清空；间隔提示的时刻从 T 之前带间隔层的注入取；预算窗口、污点、暖启动标记清掉' },
  storylines: { rule: 'restore', why: '只有现在的文本，还原不了（照现在的用）' },
  jobs: { rule: 'time', col: 'created_at' },
  review_queue: { rule: 'time', col: 'created_at' },
  rules: { rule: 'time', col: 'at' },
  suppressions: { rule: 'time', col: 'at' },
  relays: { rule: 'time', col: 'created_at' },
  extract_stalled: { rule: 'time', col: 'first_at' },
  tombstones: { rule: 'keep', why: '彻底删除是永久的：被删的东西副本里本来就没有' },
  meta: { rule: 'keep' },
  cursors: { rule: 'keep' },
  prompt_versions: { rule: 'keep' },
  predicates: { rule: 'keep', why: '谓词词表' },
  same_type: { rule: 'keep' },
  vector_spaces: { rule: 'keep' },
  fts_shards: { rule: 'keep' },
  sqlite_sequence: { rule: 'keep' },
  metrics: { rule: 'ignore', why: '计数' },
  speaker_quota: { rule: 'ignore', why: '提炼配额，回放不提炼' },
  backups: { rule: 'ignore' },
  restore_drills: { rule: 'ignore' },
});

/** 向量库的登记表。 */
export const VEC_REGISTRY = Object.freeze({
  vectors: { rule: 'time', col: 'created_at', why: '按 created_at 删；对应的 embed_texts 行被删了也删' },
  vmeta: { rule: 'keep' },
});

/** FTS 表（无内容表，rowid = 主表 id）：主记录被删了就删。 */
const FTS_BASE = [
  { re: /^episodes_fts$/, base: 'episodes' },
  { re: /^assertions_fts$/, base: 'assertions' },
  { re: /^percepts_fts_\d{6}$/, base: 'percepts' },
];
const FTS_SHADOW = /_(data|idx|docsize|config|content)$/;

/** 方案 §1.2 里「只有现在的值、还原不了」的，加上这里另外没做的：报告每次都写明。 */
export const NOT_RESTORED = Object.freeze([
  '会话：预算窗口、按轮污点、暖启动标记、常驻区已放的条目（都清掉：不限预算、不带污点）；「本周期已经给过」默认清空（看排序本身）',
  '故事线的文本、实体的权限和最近提到时间、实体的合并 / 撤回状态（照现在的）',
  'flow_norms 的旧版本、感知的 norm_state（照现在的）',
  '事实的 updated_at / confirmed_at / needs_review（照现在的）',
  '冷热分层：在 T 重算一次，不是 T 之前最后一次夜间整理的结果',
  '已经折进聚合项的旧痕迹（activation.agg_*）里晚于 T 的部分去不掉（只数出有几行）',
  '计划状态按 plan_status_history 的事件时间取，不是写进库的时间',
]);

const OWNER_TABLES = Object.freeze({
  percept: 'percepts', window: 'raw_windows', episode: 'episodes', assertion: 'assertions', entity: 'entities',
  impression: 'entity_impressions', intention: 'intentions', storyline: 'storylines', community: 'communities', link: 'entity_links',
});

const q = (name) => `"${String(name).replaceAll('"', '""')}"`;

function userTables(db) {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
}

/**
 * 把库里的表和登记表对一遍。返回 {unknown: string[], fts: {name, base}[]}；unknown 非空时调用方拒绝跑。
 * @param {DatabaseSync} db
 * @param {Record<string, object>} registry
 */
export function checkRegistry(db, registry) {
  const unknown = [];
  const fts = [];
  const tables = userTables(db);
  const ftsNames = new Set();
  for (const t of tables) {
    const f = FTS_BASE.find((x) => x.re.test(t.name));
    if (f && /^CREATE VIRTUAL TABLE/i.test(t.sql ?? '')) { fts.push({ name: t.name, base: f.base }); ftsNames.add(t.name); }
  }
  for (const t of tables) {
    if (registry[t.name] || ftsNames.has(t.name)) continue;
    const m = FTS_SHADOW.exec(t.name);
    if (m && ftsNames.has(t.name.slice(0, -m[0].length))) continue;
    unknown.push(t.name);
  }
  // 登记了但库里没有的不算错（旧库），只是用不上
  return { unknown, fts };
}

function cols(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name));
}

function deleteOrphans(db, table, parent, stats) {
  const has = cols(db, table);
  if (parent === 'owner') {
    let n = 0;
    for (const [kind, base] of Object.entries(OWNER_TABLES)) {
      n += Number(db.prepare(`DELETE FROM ${q(table)} WHERE owner_kind = ? AND owner_id NOT IN (SELECT id FROM ${q(base)})`).run(kind).changes);
    }
    if (n) stats[`${table}:orphan`] = (stats[`${table}:orphan`] ?? 0) + n;
    return n;
  }
  let n = 0;
  for (const p of parent) {
    if (!has.has(p.col)) continue;
    n += Number(db.prepare(`DELETE FROM ${q(table)} WHERE ${q(p.col)} IS NOT NULL AND ${q(p.col)} NOT IN (SELECT id FROM ${q(p.table)})`).run().changes);
  }
  if (n) stats[`${table}:orphan`] = (stats[`${table}:orphan`] ?? 0) + n;
  return n;
}

/**
 * 主库拨回 T。返回各步删了 / 改了多少行（只有数字）。
 * @param {DatabaseSync} db   副本
 * @param {number} T
 */
export function rollbackMain(db, T, { sent = 'clear' } = {}) {
  const stats = {};
  const run = (label, sql, ...args) => {
    const n = Number(db.prepare(sql).run(...args).changes);
    if (n) stats[label] = (stats[label] ?? 0) + n;
    return n;
  };
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const present = new Set(userTables(db).map((t) => t.name));
    // 1. 按时间删
    for (const [table, r] of Object.entries(MAIN_REGISTRY)) {
      if (!present.has(table) || !r.col) continue;
      run(`${table}:time`, `DELETE FROM ${q(table)} WHERE ${q(r.col)} > ?`, T);
    }
    // 场合：T 之后才出现的
    if (present.has('settings')) run('settings:time', 'DELETE FROM settings WHERE first_seen > ?', T);
    // 会话：T 之后才绑定的
    if (present.has('sessions')) run('sessions:time', 'DELETE FROM sessions WHERE bound_at > ?', T);

    // 2. 跟着主表删（反复几轮：删了事实又会让 assertion_entities、sources 变成孤儿）
    for (let round = 0; round < 3; round++) {
      let n = 0;
      for (const [table, r] of Object.entries(MAIN_REGISTRY)) {
        if (!present.has(table) || !r.parent) continue;
        n += deleteOrphans(db, table, r.parent, stats);
      }
      if (!n) break;
    }

    // 3. 能还原的还原
    restoreAll(db, T, present, run, stats);
    if (sent === 'at-time' && present.has('sessions')) stats['sessions.sent'] = sentAtTime(db);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // 4. FTS（不在事务里：secure-delete 的大删除分开做也没关系）
  for (const f of checkRegistry(db, MAIN_REGISTRY).fts) {
    const n = Number(db.prepare(`DELETE FROM ${q(f.name)} WHERE rowid NOT IN (SELECT id FROM ${q(f.base)})`).run().changes);
    if (n) stats[`${f.name}:orphan`] = n;
  }
  return stats;
}

function restoreAll(db, T, present, run, stats) {
  if (present.has('percepts')) {
    run('percepts.episode_id', 'UPDATE percepts SET episode_id = NULL WHERE episode_id IS NOT NULL AND episode_id NOT IN (SELECT id FROM episodes)');
    run('percepts.window_id', 'UPDATE percepts SET window_id = NULL WHERE window_id IS NOT NULL AND window_id NOT IN (SELECT id FROM raw_windows)');
  }
  if (present.has('assertions')) {
    run('assertions.superseded', `UPDATE assertions SET superseded_by = NULL, expired_at = NULL
      WHERE (superseded_by IS NOT NULL AND superseded_by NOT IN (SELECT id FROM assertions)) OR expired_at > ?`, T);
    if (present.has('plan_status_history')) {
      run('assertions.plan_status', `UPDATE assertions SET plan_status = COALESCE((SELECT h.status FROM plan_status_history h WHERE h.assertion_id = assertions.id AND h.at <= ?
          ORDER BY h.at DESC, h.id DESC LIMIT 1), plan_status)
        WHERE plan_status IS NOT NULL AND plan_status IS NOT COALESCE((SELECT h.status FROM plan_status_history h WHERE h.assertion_id = assertions.id AND h.at <= ?
          ORDER BY h.at DESC, h.id DESC LIMIT 1), plan_status)`, T, T);
    }
    // 夜里核对改过的把握度要在按时间删 memory_checks 之前读：见 restoreCheckedConfidence（rollbackCopy 先调它）
  }
  if (present.has('glances')) {
    run('glances.pending', "UPDATE glances SET state = 'pending', done_at = NULL WHERE done_at > ?", T);
  }
  if (present.has('intentions')) {
    const rows = db.prepare('SELECT id, state, armed_at, suppressed_at, executions_json, updated_at FROM intentions').all();
    const upd = db.prepare('UPDATE intentions SET state = ?, armed_at = ?, suppressed_at = ?, executions_json = ?, updated_at = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      let ex = [];
      try { ex = JSON.parse(r.executions_json ?? '[]'); } catch { ex = []; }
      const keep = Array.isArray(ex) ? ex.filter((e) => Number(e?.at) <= T) : [];
      const armed = r.armed_at != null && r.armed_at <= T;
      let state = r.state;
      if (r.updated_at > T || (r.armed_at != null && r.armed_at > T) || keep.length !== (Array.isArray(ex) ? ex.length : 0)) {
        if (state === 'executed' && keep.length) state = 'executed';
        else if (state !== 'formed') state = armed ? 'armed' : 'formed';
      }
      const sup = r.suppressed_at != null && r.suppressed_at <= T ? r.suppressed_at : null;
      const next = [state, armed ? r.armed_at : null, sup, JSON.stringify(keep), Math.min(r.updated_at, T)];
      if (next[0] !== r.state || next[1] !== r.armed_at || next[2] !== r.suppressed_at || next[3] !== (r.executions_json ?? '[]') || next[4] !== r.updated_at) {
        upd.run(...next, r.id);
        n += 1;
      }
    }
    if (n) stats['intentions:state'] = n;
  }
  if (present.has('entity_impressions')) {
    run('entity_impressions.current', `UPDATE entity_impressions SET is_current = 1 WHERE id IN (
      SELECT (SELECT i2.id FROM entity_impressions i2 WHERE i2.entity_id = g.entity_id AND i2.layer = g.layer ORDER BY i2.built_at DESC, i2.id DESC LIMIT 1)
      FROM (SELECT entity_id, layer FROM entity_impressions GROUP BY entity_id, layer HAVING SUM(is_current) = 0) g)`);
  }
  if (present.has('communities')) {
    run('communities.current', `UPDATE communities SET is_current = 1 WHERE id IN (
      SELECT (SELECT c2.id FROM communities c2 WHERE c2.setting_key IS g.setting_key ORDER BY c2.built_at DESC, c2.id DESC LIMIT 1)
      FROM (SELECT setting_key FROM communities GROUP BY setting_key HAVING SUM(is_current) = 0) g)`);
  }
  if (present.has('settings') && present.has('setting_snapshots')) {
    run('settings.snapshot', `UPDATE settings SET current_snapshot_id = (SELECT MAX(id) FROM setting_snapshots s WHERE s.setting_key = settings.key)
      WHERE current_snapshot_id IS NULL OR current_snapshot_id NOT IN (SELECT id FROM setting_snapshots)`);
  }
  if (present.has('core_blocks') && present.has('core_block_versions')) {
    for (const b of db.prepare('SELECT name, version FROM core_blocks').all()) {
      const v = db.prepare('SELECT version, text, created_at FROM core_block_versions WHERE name = ? AND (revoked_at IS NULL OR revoked_at > ?) ORDER BY version DESC LIMIT 1').get(b.name, T);
      if (!v) { run('core_blocks:none', 'DELETE FROM core_blocks WHERE name = ?', b.name); continue; }
      if (v.version !== b.version) run('core_blocks.version', 'UPDATE core_blocks SET text = ?, version = ?, pending_text = NULL, updated_at = ? WHERE name = ?', v.text, v.version, v.created_at, b.name);
    }
  }
  if (present.has('need_to_know')) {
    run('need_to_know.unread', "UPDATE need_to_know SET read_at = NULL, status = CASE WHEN status = 'read' THEN 'open' ELSE status END WHERE read_at > ?", T);
  }
  if (present.has('sessions')) {
    run('sessions.reset', `UPDATE sessions SET
        sent_items_json = '[]', pending_json = '[]', warm_pending = 0, restart_marker = NULL, resident_items_json = '[]', inject_window_json = '{}', turn_taint_json = NULL,
        cycle = COALESCE((SELECT i.cycle FROM injections i WHERE i.session_id = sessions.session_id ORDER BY i.ts DESC, i.id DESC LIMIT 1), 0),
        cycle_started_at = CASE WHEN cycle_started_at > ? THEN NULL ELSE cycle_started_at END,
        gap_ack_at = (SELECT MAX(i.ts) FROM injections i WHERE i.session_id = sessions.session_id AND i.layer LIKE '%gap%'),
        last_interaction_at = CASE WHEN last_interaction_at > ? THEN (SELECT MAX(i.ts) FROM injections i WHERE i.session_id = sessions.session_id) ELSE last_interaction_at END,
        updated_at = MIN(updated_at, ?)`, T, T, T);
  }
  if (present.has('activation')) {
    if (present.has('traces')) {
      run('activation.traces', `UPDATE activation SET
          trace_count = (SELECT COUNT(*) FROM traces t WHERE t.owner_kind = activation.owner_kind AND t.owner_id = activation.owner_id),
          last_trace_at = (SELECT MAX(t.t) FROM traces t WHERE t.owner_kind = activation.owner_kind AND t.owner_id = activation.owner_id)
        WHERE last_trace_at > ?`, T);
    }
    const folded = db.prepare('SELECT COUNT(*) AS n FROM activation WHERE agg_last > ?').get(T)?.n ?? 0;
    if (folded) stats['activation:foldedAfterT'] = folded;
  }
}

/**
 * 「本周期已经给过」按当时的样子重建（--sent at-time）：这个会话当前周期里、T 之前记下的每一块注入（确认了的和还在等确认的）里，
 * 带内容的记 id，只给了暗示的记 id~aware（和 context/ledger.js 的 sentTag 一个口径）。injections 已经拨回过。
 * @param {DatabaseSync} db
 */
export function sentAtTime(db) {
  let n = 0;
  const upd = db.prepare('UPDATE sessions SET sent_items_json = ? WHERE session_id = ?');
  for (const s of db.prepare('SELECT session_id, cycle FROM sessions').all()) {
    const tags = new Set();
    for (const r of db.prepare('SELECT items_json FROM injections WHERE session_id = ? AND cycle = ? ORDER BY id').all(s.session_id, s.cycle)) {
      let items = [];
      try { items = JSON.parse(r.items_json ?? '[]'); } catch { items = []; }
      for (const it of items) {
        if (it?.verdict === 'share' || it?.verdict === 'share_vague') tags.add(String(it.id));
        else if (it?.verdict === 'aware_private') tags.add(`${it.id}~aware`);
      }
    }
    if (tags.size) { upd.run(JSON.stringify([...tags]), s.session_id); n += 1; }
  }
  return n;
}

/**
 * 夜里核对改过的把握度：要在按时间删 memory_checks 之前读。rollbackMain 之前单独调一次。
 * @param {DatabaseSync} db
 * @param {number} T
 */
export function restoreCheckedConfidence(db, T) {
  const tables = new Set(userTables(db).map((t) => t.name));
  if (!tables.has('memory_checks') || !tables.has('assertions')) return 0;
  return Number(db.prepare(`UPDATE assertions SET confidence = (SELECT m.before_conf FROM memory_checks m WHERE m.assertion_id = assertions.id AND m.at > ?
      AND m.before_conf IS NOT NULL ORDER BY m.at, m.id LIMIT 1)
    WHERE EXISTS (SELECT 1 FROM memory_checks m WHERE m.assertion_id = assertions.id AND m.at > ? AND m.before_conf IS NOT NULL)`).run(T, T).changes);
}

/**
 * 向量库拨回 T：按 created_at 删，对应的 embed_texts 行（主库里，已经拨回）没有了也删。
 * @param {DatabaseSync} vdb
 * @param {DatabaseSync} db   主库（已拨回）
 * @param {number} T
 */
export function rollbackVectors(vdb, db, T) {
  const stats = {};
  const ids = new Set(db.prepare('SELECT id FROM embed_texts').all().map((r) => r.id));
  vdb.exec('BEGIN');
  try {
    stats['vectors:time'] = Number(vdb.prepare('DELETE FROM vectors WHERE created_at > ?').run(T).changes);
    const del = vdb.prepare('DELETE FROM vectors WHERE embed_text_id = ?');
    let n = 0;
    for (const r of vdb.prepare('SELECT DISTINCT embed_text_id AS id FROM vectors').all()) if (!ids.has(r.id)) n += Number(del.run(r.id).changes);
    stats['vectors:orphan'] = n;
    vdb.exec('COMMIT');
  } catch (e) {
    vdb.exec('ROLLBACK');
    throw e;
  }
  return stats;
}

/**
 * 拨回之后的防漏断言：按时间删的每张表都没有晚于 T 的行；返回违反的 [表, 列, 行数]（应该是空的）。
 * @param {DatabaseSync} db
 * @param {Record<string, object>} registry
 * @param {number} T
 */
export function assertNoLater(db, registry, T) {
  const bad = [];
  const present = new Set(userTables(db).map((t) => t.name));
  for (const [table, r] of Object.entries(registry)) {
    if (!present.has(table) || !r.col) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${q(r.col)} > ?`).get(T)?.n ?? 0;
    if (n) bad.push([table, r.col, n]);
  }
  if (present.has('settings')) { const n = db.prepare('SELECT COUNT(*) AS n FROM settings WHERE first_seen > ?').get(T).n; if (n) bad.push(['settings', 'first_seen', n]); }
  if (present.has('sessions')) { const n = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE bound_at > ?').get(T).n; if (n) bad.push(['sessions', 'bound_at', n]); }
  if (present.has('glances')) { const n = db.prepare('SELECT COUNT(*) AS n FROM glances WHERE done_at > ?').get(T).n; if (n) bad.push(['glances', 'done_at', n]); }
  if (present.has('assertions')) { const n = db.prepare('SELECT COUNT(*) AS n FROM assertions WHERE expired_at > ?').get(T).n; if (n) bad.push(['assertions', 'expired_at', n]); }
  if (present.has('traces')) { const n = db.prepare('SELECT COUNT(*) AS n FROM traces WHERE t > ?').get(T).n; if (n) bad.push(['traces', 't', n]); }
  return bad;
}

/**
 * 整套：打开副本，核对登记表，拨回，断言。返回 {stats, unknown}；有没登记的表时不动副本、unknown 非空。
 * @param {{main: string, vectors: string|null}} files   副本的路径
 * @param {number} T
 * @param {{sent?: 'clear'|'at-time'}} [opt]   「本周期已经给过」：clear（默认，看排序本身）/ at-time（按当时的样子重建）
 */
export function rollbackCopy(files, T, opt = {}) {
  const db = new DatabaseSync(files.main);
  let vdb = null;
  try {
    const unknown = checkRegistry(db, MAIN_REGISTRY).unknown;
    if (files.vectors) {
      vdb = new DatabaseSync(files.vectors);
      unknown.push(...checkRegistry(vdb, VEC_REGISTRY).unknown.map((t) => `vectors:${t}`));
    }
    if (unknown.length) return { unknown, stats: {} };
    const stats = { 'assertions.confidence': restoreCheckedConfidence(db, T), ...rollbackMain(db, T, opt) };
    if (vdb) Object.assign(stats, rollbackVectors(vdb, db, T));
    const bad = [...assertNoLater(db, MAIN_REGISTRY, T), ...(vdb ? assertNoLater(vdb, VEC_REGISTRY, T).map((b) => [`vectors:${b[0]}`, b[1], b[2]]) : [])];
    if (bad.length) throw Object.assign(new Error(`拨回之后还有晚于那一刻的行：${bad.map((b) => `${b[0]}.${b[1]}×${b[2]}`).join('、')}`), { code: 'ROLLBACK_LEAK' });
    for (const [k, v] of Object.entries(stats)) if (!v) delete stats[k];
    return { unknown: [], stats };
  } finally {
    try { vdb?.close(); } catch { /* 尽力 */ }
    try { db.close(); } catch { /* 尽力 */ }
  }
}
