// 范围（D153，「回忆」的第②步「圈范围」）：时间、人、场合是「在哪儿找」，不是「加几分」。
// 给时间窗 / 关于谁 / 场合，取出范围里的全部记忆（情节 e…、事实 a…、原文窗口 w…）；之后的稠密、字面检索只在这里面比
// （worker.denseSearch / lexicalSearch 的 only）。只读、同步、只走索引（迁移 020 补了三个索引）；不过关口——那是后面的事，
// 但已经不在了的不算：被取代或系统认定过时的事实、原文到期的窗口、隐藏 / 忘掉 / 彻底删除的（admin.suppressedRefs，和召回的
// 预过滤同一个口径，查不了就当全都不能访问）。
import { entityToken } from '../store/fts.js';
import { errKind, log, metric, parseJson, rowsByIds } from './util.js';

/** 「他亲口说的话」算哪几种感知（原文窗口按成员里有没有这几种他的感知判断）。 */
const SPOKEN_KINDS = ['utterance', 'action', 'content', 'self-utterance', 'self-action', 'edit'];
const SPOKEN_SQL = SPOKEN_KINDS.map((k) => `'${k}'`).join(',');
const ABOUT_ROLES = "('subject','object','mention')";
/** 有别的条件要在取出来以后再筛时，一样东西一个时间窗最多取这么多行（maxRefs 的倍数）；到了就标 clipped。 */
const FILTER_POOL = 20;

/**
 * @typedef {{ref: string, tStart: number, tEnd: number, settingKey: string|null}} ScopeRow
 * @typedef {{given: boolean, refs: Set<string>|null, rows: ScopeRow[], counts: {episodes: number, assertions: number, windows: number},
 *            clipped: boolean, failed?: string}} Scope
 */

/**
 * 范围里有哪些记忆（设计「回忆」§3.2、§11.2）。
 * - 时间窗（UTC 毫秒，几个窗取并集）：情节按起止和窗有重叠；事实按事件时间（event_start，没有就 valid_from，再没有 recorded_at）
 *   落在窗里；原文窗口按起止和窗有重叠。
 * - 关于谁（实体 id，可以是她自己）：情节的参与者里有他；事实的主体 / 宾语 / 提到里有他（assertion_entities）；原文窗口的成员里
 *   有他亲口说的话（他自己的发言、动作、发的内容、编辑）。几个人取并集。
 * - 场合（场合键）：情节、原文窗口按自己的场合；事实按来源那条消息所在的场合（没有消息的按来源记的场合）。几个取并集。
 * - 几样条件取交集。一样都没给（或给的全不合法）：given = false、refs = null（= 不圈）。
 * - 超过 maxRefs：留最近的（按结束时间），clipped = true。
 * 只给了人或场合时，事实按场合找只认来源有消息的（导入的、没有消息的事实只在有时间或人的条件时按场合筛得到）。
 * opt.at 之后才记下的不算（重放库副本时用）。rows 按开始时间升序。不抛错：库读不了 failed = 'store'、隐藏查不了 failed = 'suppression'，
 * 两种都是 refs 为空集合（fail closed）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{timeWindows?: {start: number, end: number}[], aboutEntityIds?: number[], settingKeys?: string[]}} spec
 * @param {{at?: number, maxRefs?: number}} [opt]
 * @returns {Scope}
 */
export function scopeOf(core, spec, opt = {}) {
  const windows = mergeWindows(spec?.timeWindows);
  const ents = [...new Set((spec?.aboutEntityIds ?? []).filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 64);
  const settings = new Set((spec?.settingKeys ?? []).filter((x) => typeof x === 'string' && x));
  const counts = { episodes: 0, assertions: 0, windows: 0 };
  if (!windows.length && !ents.length && !settings.size) return { given: false, refs: null, rows: [], counts, clipped: false };
  const cfgMax = core.config.get().recall?.scope?.maxRefs ?? 5000;
  const maxRefs = Math.max(1, Math.floor(Number(opt.maxRefs ?? cfgMax)) || 1);
  const at = Number.isFinite(opt.at) ? opt.at : core.now();
  const q = { db: core.store, windows, ents, settings, at, maxRefs, pool: maxRefs + 1, filtered: false, overflow: false };
  q.filtered = windows.length ? (ents.length > 0 || settings.size > 0) : (ents.length > 0 && settings.size > 0);
  if (q.filtered) q.pool = maxRefs * FILTER_POOL;

  let rows;
  try {
    rows = [...episodesIn(q), ...assertionsIn(q), ...windowsIn(q)];
  } catch (e) {
    // 库读不了：不知道范围里有什么，当作什么都不能看（和隐藏查不了一样 fail closed），调用方据 failed 退回别的办法
    log(core, 'warn', 'retrieve.scope.failed', { error: errKind(e) });
    metric(core, 'retrieve.scope.failed');
    return { given: true, refs: new Set(), rows: [], counts, clipped: false, failed: 'store' };
  }
  // 隐藏、忘掉、墓碑：和召回的预过滤同一个口径（admin.suppressedRefs）；查不了就当全都不能访问（fail closed）
  let blocked;
  try {
    const b = rows.length ? core.mods.admin.suppressedRefs(core, rows.map((r) => r.ref)) : new Set();
    blocked = b instanceof Set ? b : new Set(b ?? []);
  } catch (e) {
    log(core, 'warn', 'retrieve.scope.failed', { error: errKind(e), what: 'suppression' });
    return { given: true, refs: new Set(), rows: [], counts, clipped: false, failed: 'suppression' };
  }
  let kept = rows.filter((r) => !blocked.has(r.ref));
  let clipped = q.overflow;
  if (kept.length > maxRefs) {
    kept = kept.sort((x, y) => y.tEnd - x.tEnd || y.tStart - x.tStart || cmp(x.ref, y.ref)).slice(0, maxRefs);
    clipped = true;
  }
  kept.sort((x, y) => x.tStart - y.tStart || x.tEnd - y.tEnd || cmp(x.ref, y.ref));
  for (const r of kept) counts[{ e: 'episodes', a: 'assertions', w: 'windows' }[r.ref[0]]] += 1;
  return { given: true, refs: new Set(kept.map((r) => r.ref)), rows: kept, counts, clipped };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 合法的时间窗，重叠的并起来。 */
function mergeWindows(list) {
  const ws = (Array.isArray(list) ? list : [])
    .map((w) => ({ start: Number(w?.start), end: Number(w?.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const w of ws) {
    const last = out.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out.slice(0, 16);
}

/**
 * 和时间窗重叠（t_end ≥ 开头、t_start ≤ 结尾）的行：窗离库里最晚的时间近就按 t_end 的索引从新往旧走，离最早的近就按 t_start 的索引走
 * （另一个条件前面加 + 不让它用索引，免得 SQLite 没有统计时挑错）。
 */
function overlapRows(q, table, cols, extra, endIndexBounds) {
  const out = [];
  for (const w of q.windows) {
    const b = endIndexBounds;
    const recent = b.max == null || b.min == null || (b.max - w.start) <= (w.end - b.min);
    const where = recent ? `t_end >= ? AND +t_start <= ?` : `t_start <= ? AND +t_end >= ?`;
    const args = recent ? [w.start, w.end] : [w.end, w.start];
    const rows = q.db.all(`SELECT ${cols} FROM ${table} WHERE ${where}${extra} ORDER BY ${recent ? 't_end' : '+t_end'} DESC LIMIT ?`, ...args, q.pool);
    if (rows.length >= q.pool) q.overflow = true;
    out.push(...rows);
  }
  return out;
}

// ── 情节 ───────────────────────────────────────────────────────────────────
function episodesIn(q) {
  const cols = 'id, setting_key, t_start, t_end, participants_json, created_at';
  let rows;
  if (q.windows.length) {
    const b = q.db.get('SELECT (SELECT MIN(t_start) FROM episodes) AS min, (SELECT MAX(t_end) FROM episodes) AS max');
    rows = overlapRows(q, 'episodes', cols, '', b ?? {});
  } else if (q.ents.length) {
    // 参与者 = episodes_fts 里的实体词元（encode 写情节时加的，扇出项的 fan 也这么数），走 FTS 索引
    const match = q.ents.map((e) => `"${entityToken(e)}"`).join(' OR ');
    const ids = q.db.all('SELECT rowid AS id FROM episodes_fts WHERE episodes_fts MATCH ?', match).map((r) => r.id);
    rows = rowsByIds(q.db, `SELECT ${cols} FROM episodes WHERE id IN (?*)`, ids);
  } else {
    rows = [];
    for (const k of q.settings) {
      const r = q.db.all(`SELECT ${cols} FROM episodes WHERE setting_key = ? ORDER BY t_end DESC LIMIT ?`, k, q.pool);
      if (r.length >= q.pool) q.overflow = true;
      rows.push(...r);
    }
  }
  const ents = new Set(q.ents);
  const out = new Map();
  for (const r of rows) {
    if (out.has(r.id) || r.created_at > q.at) continue;
    if (q.settings.size && !q.settings.has(r.setting_key)) continue;
    if (ents.size && q.windows.length) {
      const ps = parseJson(r.participants_json, []);
      if (!Array.isArray(ps) || !ps.some((x) => ents.has(x))) continue;
    }
    out.set(r.id, { ref: `e${r.id}`, tStart: r.t_start, tEnd: Math.max(r.t_start, r.t_end), settingKey: r.setting_key });
  }
  return out.values();
}

// ── 事实 ───────────────────────────────────────────────────────────────────
const WHEN = 'COALESCE(event_start, valid_from, recorded_at)';   // 和迁移 020 的 assertions_when 一字不差，才用得上索引
const LIVE = 'superseded_by IS NULL AND expired_at IS NULL';

function assertionsIn(q) {
  const cols = `id, ${WHEN} AS t, event_start, event_end, recorded_at`;
  let rows = [];
  if (q.windows.length) {
    for (const w of q.windows) {
      const r = q.db.all(`SELECT ${cols} FROM assertions WHERE ${WHEN} BETWEEN ? AND ? AND ${LIVE} ORDER BY ${WHEN} DESC LIMIT ?`, w.start, w.end, q.pool);
      if (r.length >= q.pool) q.overflow = true;
      rows.push(...r);
    }
  } else if (q.ents.length) {
    const ids = q.db.all(`SELECT DISTINCT assertion_id AS id FROM assertion_entities WHERE entity_id IN (${q.ents.map(() => '?').join(',')})
                           AND role IN ${ABOUT_ROLES}`, ...q.ents).map((r) => r.id);
    rows = rowsByIds(q.db, `SELECT ${cols} FROM assertions WHERE id IN (?*) AND ${LIVE}`, ids);
  } else {
    // 只给了场合：来源那条消息在这些场合里的事实（按消息从新往旧，走 percepts_setting 和 sources_percept）
    for (const k of q.settings) {
      // CROSS JOIN 定死连接顺序：从这个场合的消息出发（不然 SQLite 会从全部事实的来源扫起）
      const got = q.db.all(`SELECT s.owner_id AS id FROM percepts p CROSS JOIN sources s ON s.percept_id = p.id
                             WHERE p.setting_key = ? AND s.owner_kind = 'assertion' ORDER BY p.id DESC LIMIT ?`, k, q.pool);
      if (got.length >= q.pool) q.overflow = true;
      const ids = [...new Set(got.map((r) => r.id))];
      rows.push(...rowsByIds(q.db, `SELECT ${cols} FROM assertions WHERE id IN (?*) AND ${LIVE}`, ids));
    }
  }
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id) && r.recorded_at <= q.at) byId.set(r.id, r);
  const ids = [...byId.keys()];
  if (q.ents.length && q.windows.length) {
    const about = new Set();
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const r of q.db.all(`SELECT DISTINCT assertion_id AS id FROM assertion_entities WHERE assertion_id IN (${part.map(() => '?').join(',')})
                                 AND entity_id IN (${q.ents.map(() => '?').join(',')}) AND role IN ${ABOUT_ROLES}`, ...part, ...q.ents)) about.add(r.id);
    }
    for (const id of ids) if (!about.has(id)) byId.delete(id);
  }
  // 场合：来源那条消息所在的场合（没有消息的按来源记的场合）；第一条来源的当这条事实的场合
  const where = new Map();
  for (const r of rowsByIds(q.db, `SELECT s.owner_id AS id, COALESCE(p.setting_key, s.perceived_in) AS k FROM sources s
                                    LEFT JOIN percepts p ON p.id = s.percept_id WHERE s.owner_kind = 'assertion' AND s.owner_id IN (?*) ORDER BY s.id`, [...byId.keys()])) {
    if (!where.has(r.id)) where.set(r.id, []);
    if (r.k != null) where.get(r.id).push(r.k);
  }
  const out = [];
  for (const [id, r] of byId) {
    const ks = where.get(id) ?? [];
    if (q.settings.size && !ks.some((k) => q.settings.has(k))) continue;
    const end = r.event_start != null ? Math.max(r.t, r.event_end ?? r.t) : r.t;
    out.push({ ref: `a${id}`, tStart: r.t, tEnd: end, settingKey: (q.settings.size ? ks.find((k) => q.settings.has(k)) : ks[0]) ?? null });
  }
  return out;
}

// ── 原文窗口 ───────────────────────────────────────────────────────────────
function windowsIn(q) {
  const cols = 'id, setting_key, visible_to, members_json, last_percept, t_start, t_end, created_at, (text IS NOT NULL) AS live';
  let rows = [];
  const spoken = new Set();   // 他亲口说的那些感知 id（按人取的时候顺便记下）
  if (q.windows.length) {
    const b = q.db.get(`SELECT (SELECT MIN(t_start) FROM raw_windows WHERE text IS NOT NULL) AS min,
                               (SELECT MAX(t_end) FROM raw_windows WHERE text IS NOT NULL) AS max`);
    rows = overlapRows(q, 'raw_windows', cols, ' AND text IS NOT NULL', b ?? {});
  } else if (q.ents.length) {
    // 他说的话（percepts_actor）→ 最后一个包含它的窗口（window_id）；相邻窗口重叠，前一个窗口也可能有它，按成员核对
    const ps = q.db.all(`SELECT id, window_id FROM percepts WHERE actor_entity_id IN (${q.ents.map(() => '?').join(',')})
                          AND kind IN (${SPOKEN_SQL}) AND window_id > 0`, ...q.ents);
    for (const p of ps) spoken.add(p.id);
    rows = rowsByIds(q.db, `SELECT ${cols} FROM raw_windows WHERE id IN (?*) AND text IS NOT NULL`, ps.map((p) => p.window_id));
    const seen = new Set(rows.map((r) => r.id));
    for (const w of [...rows]) {
      const prev = q.db.get(`SELECT ${cols} FROM raw_windows WHERE setting_key = ? AND visible_to = ? AND last_percept < ?
                              ORDER BY last_percept DESC LIMIT 1`, w.setting_key, w.visible_to, w.last_percept);
      if (prev?.live && !seen.has(prev.id)) { seen.add(prev.id); rows.push(prev); }
    }
  } else {
    for (const k of q.settings) {
      const r = q.db.all(`SELECT ${cols} FROM raw_windows WHERE setting_key = ? AND text IS NOT NULL ORDER BY last_percept DESC LIMIT ?`, k, q.pool);
      if (r.length >= q.pool) q.overflow = true;
      rows.push(...r);
    }
  }
  const byId = new Map();
  for (const r of rows) {
    if (byId.has(r.id) || r.created_at > q.at) continue;
    if (q.settings.size && !q.settings.has(r.setting_key)) continue;
    byId.set(r.id, { r, members: (parseJson(r.members_json, []) ?? []).filter((x) => Number.isSafeInteger(x)) });
  }
  if (q.ents.length) {
    if (q.windows.length) {
      const all = [...new Set([...byId.values()].flatMap((x) => x.members))];
      for (let i = 0; i < all.length; i += 500) {
        const part = all.slice(i, i + 500);
        for (const r of q.db.all(`SELECT id FROM percepts WHERE id IN (${part.map(() => '?').join(',')})
                                   AND actor_entity_id IN (${q.ents.map(() => '?').join(',')}) AND kind IN (${SPOKEN_SQL})`, ...part, ...q.ents)) spoken.add(r.id);
      }
    }
    for (const [id, x] of byId) if (!x.members.some((m) => spoken.has(m))) byId.delete(id);
  }
  return [...byId.values()].map(({ r }) => ({ ref: `w${r.id}`, tStart: r.t_start, tEnd: Math.max(r.t_start, r.t_end), settingKey: r.setting_key }));
}
