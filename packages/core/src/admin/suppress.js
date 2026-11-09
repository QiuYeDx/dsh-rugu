// 隐藏和忘掉（§12.7）：所有记忆单元通用，记在 suppressions。
//   - 隐藏 = 对别人隐藏（召回预过滤掉、不渲染），主人和审核视图仍可见；随时可以恢复。
//   - 忘掉 = 隐藏 + 一条指向它的「别记」规则（同样的内容之后不再记成新的）+ 30 天内可恢复（retention.forgetRestoreDays）。
//     30 天之后不能再恢复，但也不会自动彻底删除：彻底删除只由主人决定。
//   - 派生内容跟着隐藏（级联），方向和彻底删除一样从来源到派生（D55）：
//       · 隐藏一条消息：含它的原文窗口、复述它的每段叙述（情节是整段派生出来的，任何一种）、只靠它作证据的记忆；
//       · 隐藏一条事实、一段经历、一个原文窗口：从同一批消息汇总出来的小结、日记（它们复述当天的一切，主人不会想到去找）；
//       · 汇总只往更高一层带：小结 → 日记；日记不带别的（小结不是从日记来的）。
//     级联来的行 by='system'、reason='cascade:<来源引用>'，来源恢复时一起恢复（还有别的直接隐藏会带给它的，改记那一条）。
//     隐藏之后才写出来的派生内容（小结、日记、窗口、提炼的事实）：写的模块调 inheritSuppression，tick 也会扫一遍（sweepInherited）。
//     来源被彻底删除之后：窗口重新渲染过、不再含删掉的消息就放开；还复述着删掉内容的留着隐藏，改记 'purged:<来源引用>'（settleCascades）。
//     故事线、社区、印象由 consolidate 自己重建（D45）。
//   - 墓碑：被彻底删除的东西永远算「访问不到」（suppressedRefs 一并返回）。墓碑按时间生效（D42）：删掉最新的一行之后，
//     下一条新记忆会拿到同一个 id，它是新的记忆，不受那块墓碑影响。
import { ContractError } from '../contract/errors.js';
import { parseRef, refOf, OWNER_TABLES } from '../store/refs.js';
import { getMetaJson, setMetaJson } from '../store/kv.js';
import { addRule, invalidateRules } from './rules.js';
import { derivedOf, windowsContaining, evidencePercepts, episodeKind, hasTable, hasColumn, CREATED } from './derive.js';
import { residentDirty } from './notify.js';
import { param } from './params.js';

const DAY = 86_400_000;
const RANK = { hidden: 1, forgotten: 2 };
/** 会把隐藏带给派生内容的记忆种类：对话里来的、带着内容的。 */
const CASCADE_FROM = new Set(['percept', 'window', 'episode', 'assertion']);
/** 汇总的层级：今天到目前为止的小结 < 日记（日记汇总小结）。其余情节（经历、提炼的）是 0。 */
const AGG_RANK = Object.freeze({ summary: 1, diary: 2 });
const CASCADE = 'cascade:';
const PURGED = 'purged:';
export const cascadeReason = (ref) => `${CASCADE}${ref}`;
export const isCascade = (reason) => typeof reason === 'string' && reason.startsWith(CASCADE);
/** tick 扫「隐藏之后才写出来的派生内容」扫到哪了：每张表一个（created_at, id）游标。 */
const INHERIT_CURSOR = 'admin.inherit.cursor';
/** 隐藏之后可能才写出来、要继承隐藏的派生内容。 */
const INHERIT_TABLES = Object.freeze([['episode', 'episodes'], ['window', 'raw_windows'], ['assertion', 'assertions'], ['intention', 'intentions']]);
const bad = (what, path, message) => new ContractError(what, [{ path, message }]);

export function mustRef(ref, what = 'ref') {
  const m = parseRef(ref);
  if (!m) throw bad(what, 'ref', '应为记忆引用');
  return m;
}

/** 记忆单元还在不在（主表有没有这一行）。 */
export function unitExists(db, m) {
  return !!db.get(`SELECT 1 FROM ${OWNER_TABLES[m.kind]} WHERE id = ?`, m.id);
}

/**
 * 一批 id 里哪些被彻底删除过：有墓碑，并且这一行已经不在了、或者是墓碑时间之前就有的（D42）。
 * 墓碑之后才写进来、碰巧拿到同一个 id 的新行不算。
 * @param {import('../store/db.js').Store} db
 * @param {string} kind   owner_kind
 * @param {number[]} ids
 * @returns {Set<number>}
 */
export function tombstonedIds(db, kind, ids) {
  const out = new Set();
  if (!ids?.length || !OWNER_TABLES[kind] || !hasTable(db, 'tombstones')) return out;
  const hits = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const refs = JSON.stringify(ids.slice(i, i + 500).map((id) => refOf(/** @type {any} */ (kind), id)));
    for (const r of db.all('SELECT ref, at FROM tombstones WHERE kind = ? AND ref IN (SELECT value FROM json_each(?))', kind, refs)) {
      const m = parseRef(r.ref);
      if (m) hits.set(m.id, r.at);
    }
  }
  if (!hits.size) return out;
  const table = OWNER_TABLES[kind];
  const col = CREATED[kind];
  const newer = new Set();
  if (col && hasColumn(db, table, col)) {
    for (const r of db.all(`SELECT id, ${col} AS c FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([...hits.keys()]))) {
      if (r.c != null && r.c > hits.get(r.id)) newer.add(r.id);
    }
  }
  for (const id of hits.keys()) if (!newer.has(id)) out.add(id);
  return out;
}

/** 这条是不是被彻底删除过。记忆单元按时间（tombstonedIds）；'obs'、'identity' 这类没有主表行的只看有没有墓碑。 */
export function isTombstoned(db, kind, ref) {
  const m = OWNER_TABLES[kind] ? parseRef(ref) : null;
  if (m && m.kind === kind) return tombstonedIds(db, kind, [m.id]).has(m.id);
  return !!db.get('SELECT 1 FROM tombstones WHERE kind = ? AND ref = ?', kind, ref);
}

// ── 级联 ──────────────────────────────────────────────────────────────────

/**
 * 隐藏这条记忆时一起对别人隐藏的派生内容（方向从来源到派生，同彻底删除，D55）：
 *   - 一条消息：含它的原文窗口、以它为来源的每段叙述（任何一种情节）、只靠它作证据的记忆；
 *   - 一条事实、一段经历、一个原文窗口：证据消息汇总出来的小结、日记；
 *   - 小结：汇总它的日记；日记：不带别的。
 * @param {object} core
 * @param {{kind: string, id: number}} m
 * @returns {string[]}
 */
export function cascadeTargets(core, m) {
  if (!CASCADE_FROM.has(m.kind)) return [];
  const db = core.store;
  const self = refOf(/** @type {any} */ (m.kind), m.id);
  const percept = m.kind === 'percept';
  const rank = m.kind === 'episode' ? (AGG_RANK[episodeKind(db, m.id)] ?? 0) : 0;
  const out = new Set();
  for (const pid of evidencePercepts(db, m)) {
    for (const d of derivedOf(core, db, pid) ?? []) {
      const dm = parseRef(d.ref);
      if (!dm || d.ref === self) continue;
      if (dm.kind === 'episode') {
        if (percept || (AGG_RANK[episodeKind(db, dm.id)] ?? 0) > rank) out.add(d.ref);
      } else if (percept && d.onlySource) out.add(d.ref);
    }
    if (percept) for (const w of windowsContaining(db, pid)) out.add(refOf('window', w));
  }
  out.delete(self);
  return [...out];
}

/**
 * 直接隐藏的（不是级联来的）记忆里，哪一条会把隐藏带给 t：先按证据感知的重叠找候选，再用 cascadeTargets 核实（两个方向同一套规则）。
 * @param {object} core
 * @param {{kind: string, id: number}} t
 * @returns {string|null}
 */
export function inheritedFrom(core, t) {
  const db = core.store;
  const tref = refOf(/** @type {any} */ (t.kind), t.id);
  const pids = evidencePercepts(db, t);
  if (!pids.length) return null;
  const list = JSON.stringify(pids);
  const cands = new Map();
  const add = (kind, id) => { const r = refOf(kind, id); if (r !== tref && !cands.has(r)) cands.set(r, { kind, id }); };
  for (const id of pids) add('percept', id);
  for (const pid of pids) for (const w of windowsContaining(db, pid)) add('window', w);
  if (hasTable(db, 'sources')) {
    for (const r of db.all(`SELECT DISTINCT owner_kind AS k, owner_id AS id FROM sources
                            WHERE percept_id IN (SELECT value FROM json_each(?)) AND owner_kind IN ('episode','assertion')`, list)) add(r.k, r.id);
  }
  for (const r of db.all('SELECT DISTINCT episode_id AS id FROM percepts WHERE id IN (SELECT value FROM json_each(?)) AND episode_id IS NOT NULL', list)) add('episode', r.id);
  for (const [ref, m] of cands) {
    const s = db.get('SELECT reason FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
    if (!s || isCascade(s.reason)) continue;
    if (cascadeTargets(core, m).includes(tref)) return ref;
  }
  return null;
}

/** 把派生内容一起对别人隐藏（已经有隐藏状态的不动）。在调用方的事务里调用。 */
function hideDerived(core, m, at) {
  const db = core.store;
  const src = refOf(/** @type {any} */ (m.kind), m.id);
  let n = 0;
  for (const r of cascadeTargets(core, m)) {
    const t = parseRef(r);
    if (!t || isTombstoned(db, t.kind, r) || !unitExists(db, t)) continue;
    n += Number(db.run(`INSERT INTO suppressions(owner_kind, owner_id, state, by, reason, at) VALUES (?, ?, 'hidden', 'system', ?, ?)
                        ON CONFLICT(owner_kind, owner_id) DO NOTHING`, t.kind, t.id, cascadeReason(src), at).changes);
  }
  return n;
}

// ── 隐藏、忘掉、恢复 ──────────────────────────────────────────────────────

/**
 * 隐藏或忘掉。不会把「忘掉」降回「隐藏」（要撤销用 restore）。级联来的隐藏被主人（或本人）直接隐藏时改记成直接的，
 * 来源恢复时不会把它一起恢复。再隐藏一次也会补上之后才写出来的派生内容。
 * @param {object} core
 * @param {string} ref
 * @param {{state: 'hidden'|'forgotten', by: string, reason?: string, at: number}} s
 */
export function suppress(core, ref, s) {
  const m = mustRef(ref, 'suppress');
  if (!RANK[s?.state]) throw bad('suppress', 'state', '应为 hidden / forgotten');
  const at = Number.isFinite(s.at) ? s.at : core.now();
  const by = typeof s.by === 'string' && s.by ? s.by.slice(0, 40) : 'owner';
  const reason = typeof s.reason === 'string' && !isCascade(s.reason) ? s.reason.slice(0, 200) : null;
  let cascaded = 0;
  core.store.tx((db) => {
    if (isTombstoned(db, m.kind, ref)) throw Object.assign(new Error('这条记忆已经被彻底删除'), { code: 'PURGED' });
    if (!unitExists(db, m)) throw Object.assign(new Error('没有这条记忆'), { code: 'NOT_FOUND' });
    const old = db.get('SELECT state, rule_id, reason FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
    if (!(old && RANK[old.state] >= RANK[s.state] && !isCascade(old.reason))) {
      let ruleId = old?.rule_id ?? null;
      let until = null;
      if (s.state === 'forgotten') {
        const ruleBy = /^(owner|tool|system|subject:[1-9]\d{0,15})$/.test(by) ? by : 'system';
        ruleId = addRule(core, { kind: 'do_not_remember', target: { ref }, createdBy: ruleBy, note: 'forgotten', at });
        until = at + param(core, 'retention.forgetRestoreDays') * DAY;
      }
      db.run(`INSERT INTO suppressions(owner_kind, owner_id, state, by, reason, at, restore_until, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner_kind, owner_id) DO UPDATE SET state = excluded.state, by = excluded.by, reason = excluded.reason, at = excluded.at,
                restore_until = excluded.restore_until, rule_id = excluded.rule_id`,
      m.kind, m.id, s.state, by, reason, at, until, ruleId);
    }
    cascaded = hideDerived(core, m, at);
  });
  invalidateRules(core);
  residentDirty(core);
  core.log.info('admin.suppressed', { kind: m.kind, state: s.state, cascaded });
}

/**
 * 恢复。隐藏的随时可以；忘掉的只在 30 天内（过了抛 RESTORE_EXPIRED）。连带的「别记」规则一并撤销；
 * 级联隐藏的派生内容一起恢复，除非还有别的直接隐藏会带给它（改记那一条）。
 * @param {object} core
 * @param {string} ref
 * @param {{by: string, at: number}} ctx
 */
export function restore(core, ref, ctx) {
  const m = mustRef(ref, 'restore');
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  let changed = 0;
  core.store.tx((db) => {
    const row = db.get('SELECT state, restore_until, rule_id FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
    if (!row) return;
    if (row.state === 'forgotten' && row.restore_until != null && at > row.restore_until) {
      throw Object.assign(new Error('忘掉超过 30 天了，不能再恢复'), { code: 'RESTORE_EXPIRED' });
    }
    db.run('DELETE FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
    if (row.rule_id) db.run('UPDATE rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, row.rule_id);
    changed += 1;
    for (const c of db.all('SELECT owner_kind AS k, owner_id AS id FROM suppressions WHERE reason = ? ORDER BY owner_kind, owner_id', cascadeReason(ref))) {
      const other = inheritedFrom(core, { kind: c.k, id: c.id });
      if (other) db.run('UPDATE suppressions SET reason = ? WHERE owner_kind = ? AND owner_id = ?', cascadeReason(other), c.k, c.id);
      else { db.run('DELETE FROM suppressions WHERE owner_kind = ? AND owner_id = ?', c.k, c.id); changed += 1; }
    }
  });
  if (!changed) return;
  invalidateRules(core);
  residentDirty(core);
  core.log.info('admin.restored', { kind: m.kind, units: changed });
}

/**
 * 新写出来的派生内容（小结、日记、原文窗口）：证据里有被直接隐藏的，就一起对别人隐藏（和隐藏时的级联同一套规则）。
 * 已经有隐藏状态的不动。返回带来隐藏的那条引用，没有就是 null。
 * @param {object} core
 * @param {string} ref
 * @param {{at?: number}} [ctx]
 * @returns {string|null}
 */
export function inheritSuppression(core, ref, ctx = {}) {
  const m = mustRef(ref, 'inheritSuppression');
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  const src = core.store.tx(() => inheritInto(core, m, at));
  if (src) {
    residentDirty(core);
    core.log.info('admin.suppression-inherited', { kind: m.kind });
  }
  return src;
}

/** 一条记忆的隐藏状态（被彻底删除的算 forgotten：永远访问不到）。 */
export function suppression(core, ref) {
  const m = parseRef(ref);
  if (!m) return null;
  const row = core.store.get('SELECT state FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
  if (row) return row.state;
  return isTombstoned(core.store, m.kind, ref) ? 'forgotten' : null;
}

/**
 * 一批里哪些访问不到（隐藏、忘掉、彻底删除）——召回的预过滤（只看能不能访问，不看这里能不能说）。
 * 每种记忆一次查询，热路径上 200 条候选是两三次小查询。
 */
export function suppressedRefs(core, refs) {
  const out = new Set();
  const byKind = new Map();
  for (const r of refs ?? []) {
    const m = parseRef(r);
    if (!m) continue;
    if (!byKind.has(m.kind)) byKind.set(m.kind, new Map());
    byKind.get(m.kind).set(m.id, r);
  }
  for (const [kind, ids] of byKind) {
    const list = JSON.stringify([...ids.keys()]);
    for (const row of core.store.all('SELECT owner_id FROM suppressions WHERE owner_kind = ? AND owner_id IN (SELECT value FROM json_each(?))', kind, list)) {
      out.add(ids.get(row.owner_id));
    }
    for (const id of tombstonedIds(core.store, kind, [...ids.keys()])) out.add(ids.get(id));
  }
  return out;
}

// ── 隐藏之后才写出来的派生内容、来源被彻底删除之后的级联 ──────────────────────

/** 一条（新写出来的）派生内容继承隐藏：已经有隐藏状态的不动。在调用方的事务里调用。返回带来隐藏的那条引用。 */
function inheritInto(core, m, at) {
  const db = core.store;
  if (!OWNER_TABLES[m.kind] || !unitExists(db, m)) return null;
  if (db.get('SELECT 1 FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id)) return null;
  const src = inheritedFrom(core, m);
  if (src) {
    db.run(`INSERT INTO suppressions(owner_kind, owner_id, state, by, reason, at) VALUES (?, ?, 'hidden', 'system', ?, ?)`,
      m.kind, m.id, cascadeReason(src), at);
  }
  return src;
}

/** 最早的一条会把隐藏带给派生内容的直接隐藏是什么时候（没有就是 null，什么都不用扫）。 */
function firstDirectAt(db) {
  return db.get(`SELECT MIN(at) AS t FROM suppressions WHERE owner_kind IN ('percept','window','episode','assertion')
                   AND (reason IS NULL OR substr(reason, 1, ?) <> ?)`, CASCADE.length, CASCADE)?.t ?? null;
}

/**
 * tick 顺带做（expireReviews 之后）：上次扫到之后写出来的小结、日记、原文窗口、提炼的事实和意图，证据里有被直接隐藏的就跟着隐藏。
 * 写派生内容的模块写完就调 inheritSuppression 时这里是空操作；没调的（或者调的时候失败了）由这里补上。
 * 按（created_at, id）往后扫，从不早于最早的直接隐藏的地方开始，每张表每次最多 admin.inheritBatch 行；没有任何直接隐藏时直接把游标推到现在。
 * @param {object} core
 * @param {number} [at]
 * @returns {number} 这次跟着隐藏了几条
 */
export function sweepInherited(core, at) {
  const db = core.store;
  const now = Number.isFinite(at) ? at : core.now();
  const cursor = getMetaJson(db, INHERIT_CURSOR, null) ?? {};
  // 游标（created_at, id）：同一毫秒写出来的行再多也不会重扫、不会漏
  const pos = (kind) => (Array.isArray(cursor[kind]) && cursor[kind].length === 2 ? cursor[kind].map(Number) : [0, 0]);
  // 没有直接隐藏时跳到现在（之前写出来的不用扫：之后有了直接隐藏，suppress 当场就会带上那时已有的派生内容）；只往前走
  const skipTo = (kind) => { const [c] = pos(kind); if (c < now) cursor[kind] = [now, 0]; };
  const floor = firstDirectAt(db);
  if (floor == null) {
    for (const [kind] of INHERIT_TABLES) skipTo(kind);
    setMetaJson(db, INHERIT_CURSOR, cursor);
    return 0;
  }
  const limit = Math.max(1, Math.trunc(param(core, 'admin.inheritBatch')));
  let n = 0;
  db.tx(() => {
    for (const [kind, table] of INHERIT_TABLES) {
      if (!hasTable(db, table) || !hasColumn(db, table, 'created_at')) continue;
      // 最早的直接隐藏之前写出来的不用扫：那时已有的派生内容 suppress 当场就带上了
      const [c0, id0] = pos(kind)[0] < floor ? [floor, 0] : pos(kind);
      const rows = db.all(`SELECT id, created_at AS c FROM ${table} WHERE (created_at > ? OR (created_at = ? AND id > ?)) AND created_at <= ?
                           ORDER BY created_at, id LIMIT ?`, c0, c0, id0, now, limit);
      for (const r of rows) if (inheritInto(core, { kind, id: r.id }, now)) n += 1;
      // 下次从扫过的最后一行接着扫（之后写出来的行 created_at 不会更早）
      if (rows.length) cursor[kind] = [rows.at(-1).c, rows.at(-1).id];
    }
    setMetaJson(db, INHERIT_CURSOR, cursor);
  });
  if (n) {
    residentDirty(core);
    core.log.info('admin.suppression-inherited', { n });
  }
  return n;
}

/**
 * 彻底删除之后（主库上）：来源被删掉的级联隐藏重新定。还有别的直接隐藏会带给它的，改记那一条；原文窗口重新渲染过、
 * 已经不含删掉的消息的，放开；其余（例：复述着被删经历的小结）还复述着删掉的内容，留着隐藏，改记 'purged:<来源引用>'，
 * 成为系统的直接隐藏（主人在管理页看得到原因，可以自己恢复）。
 * @param {object} core
 * @param {Iterable<string>} deleted   删掉的记忆引用
 * @param {Iterable<string>} [rebuilt] 重新渲染过的原文窗口的引用
 * @returns {{released: number, kept: number, moved: number}}
 */
export function settleCascades(core, deleted, rebuilt = []) {
  const gone = new Set(deleted);
  const redone = new Set(rebuilt);
  const out = { released: 0, kept: 0, moved: 0 };
  if (!gone.size) return out;
  const db = core.store;
  db.tx(() => {
    for (const c of db.all(`SELECT owner_kind AS k, owner_id AS id, reason FROM suppressions WHERE substr(reason, 1, ?) = ? ORDER BY owner_kind, owner_id`,
      CASCADE.length, CASCADE)) {
      if (!gone.has(c.reason.slice(CASCADE.length))) continue;
      const t = { kind: c.k, id: c.id };
      const other = inheritedFrom(core, t);
      if (other) { db.run('UPDATE suppressions SET reason = ? WHERE owner_kind = ? AND owner_id = ?', cascadeReason(other), c.k, c.id); out.moved += 1; continue; }
      if (redone.has(refOf(c.k, c.id))) { db.run('DELETE FROM suppressions WHERE owner_kind = ? AND owner_id = ?', c.k, c.id); out.released += 1; continue; }
      db.run('UPDATE suppressions SET reason = ? WHERE owner_kind = ? AND owner_id = ?', `${PURGED}${c.reason.slice(CASCADE.length)}`.slice(0, 200), c.k, c.id);
      out.kept += 1;
    }
  });
  if (out.released || out.moved || out.kept) {
    residentDirty(core);
    core.log.info('admin.cascades-settled', out);
  }
  return out;
}
