// 备份线程里跑的数据库任务（由 thread.js 的 runDbTask 启动，每个任务一个线程）。
// 对正在用的主库只开只读连接；能写的只有备份暂存目录里的副本。返回值只有数字、id 和主人管理页要看的字段，不打日志。
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { matchQuery } from '../store/fts.js';

const TABLE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SHADOW = ['_data', '_idx', '_content', '_docsize', '_config'];
const MEMORY_TABLES = Object.freeze({
  percept: 'percepts', window: 'raw_windows', episode: 'episodes', assertion: 'assertions', entity: 'entities',
  impression: 'entity_impressions', intention: 'intentions', storyline: 'storylines', community: 'communities', link: 'entity_links',
});
const PREFIX = Object.freeze({ percept: 'p', window: 'w', episode: 'e', assertion: 'a', entity: 'n', impression: 'i', intention: 't', storyline: 's', community: 'c', link: 'l' });
const CREATED_COL = Object.freeze({
  percepts: 'created_at', raw_windows: 'created_at', episodes: 'created_at', assertions: 'created_at', entities: 'created_at',
  entity_impressions: 'built_at', intentions: 'created_at', storylines: 'updated_at', communities: 'built_at', entity_links: 'at',
});

const open = (file, readOnly = true) => {
  const db = new DatabaseSync(file, { readOnly });
  if (readOnly) db.exec('PRAGMA query_only = ON');
  return db;
};
const jsonParse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

function tablesOf(db, schema = 'main') {
  const rows = db.prepare(`SELECT name, sql FROM ${schema}.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
  const virtual = rows.filter((r) => /^CREATE\s+VIRTUAL/i.test(r.sql ?? '')).map((r) => r.name);
  const shadow = new Set(virtual.flatMap((v) => SHADOW.map((s) => `${v}${s}`)));
  return {
    regular: rows.filter((r) => !/^CREATE\s+VIRTUAL/i.test(r.sql ?? '') && !shadow.has(r.name)).map((r) => r.name).sort(),
    virtual: virtual.sort(),
  };
}
function counts(db) {
  const out = {};
  for (const t of tablesOf(db).regular) out[t] = Number(db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n);
  return out;
}
const hasTable = (db, schema, t) => !!db.prepare(`SELECT 1 FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`).get(t);
const metaOf = (db, key) => { try { return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; } catch { return null; } };

const TASKS = {
  /** 刚做好的快照：改成回滚日志模式（单个文件，打开时不再需要 -wal / -shm），读出 manifest 要的统计。 */
  inspect({ file, rollbackJournal = true }) {
    const db = open(file, false);
    try {
      if (rollbackJournal) db.prepare('PRAGMA journal_mode = DELETE').get();
      const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
      let spaces = [];
      if (hasTable(db, 'main', 'vector_spaces')) {
        spaces = db.prepare('SELECT space_id, model, quant, dim, doc_tpl_ver, status FROM vector_spaces').all()
          .map((s) => ({ spaceId: s.space_id, model: s.model, quant: s.quant, dim: s.dim, docTplVer: s.doc_tpl_ver, status: s.status }));
      }
      return { userVersion, counts: counts(db), dbId: metaOf(db, 'db_id'), retention: metaOf(db, 'retention.policy'), spaces };
    } finally { db.close(); }
  },

  /** 压实的副本（周包、月包，评审:FE-17）。源库只开只读连接。 */
  vacuumInto({ src, dest }) {
    fs.rmSync(dest, { force: true });
    // 只读连接就够了；不能再加 query_only：VACUUM INTO 用同一个连接写目标文件，query_only 会把它也挡住
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.exec('PRAGMA busy_timeout = 5000'); db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
    return { size: fs.statSync(dest).size };
  },

  /** 副本整理（彻底删除后重写本地包时用：删掉的内容不留在空闲页里）。 */
  vacuum({ file }) {
    const db = open(file, false);
    try { db.exec('VACUUM'); } finally { db.close(); }
    return { size: fs.statSync(file).size };
  },

  /** 验证：integrity_check、schema 版本、各表条数。 */
  check({ file, maxErrors = 20 }) {
    const db = open(file, true);
    try {
      const rows = db.prepare(`PRAGMA integrity_check(${Number(maxErrors) | 0 || 20})`).all().map((r) => Object.values(r)[0]);
      return { ok: rows.length === 1 && rows[0] === 'ok', problems: rows.filter((r) => r !== 'ok').length, userVersion: Number(db.prepare('PRAGMA user_version').get().user_version), counts: counts(db) };
    } finally { db.close(); }
  },

  /** 整体恢复前的预览：包和当前库的差别（§12.4.5 第 1 步）。 */
  compare({ pack, current, since }) {
    const db = open(pack, true);
    try {
      db.prepare('ATTACH DATABASE ? AS cur').run(current);
      const kinds = {};
      for (const [kind, t] of Object.entries(MEMORY_TABLES)) {
        if (!hasTable(db, 'main', t) || !hasTable(db, 'cur', t)) continue;
        const one = (sql) => Number(db.prepare(sql).get().n);
        kinds[kind] = {
          pack: one(`SELECT count(*) AS n FROM main."${t}"`),
          current: one(`SELECT count(*) AS n FROM cur."${t}"`),
          lost: one(`SELECT count(*) AS n FROM cur."${t}" c WHERE NOT EXISTS (SELECT 1 FROM main."${t}" p WHERE p.id = c.id)`),
          regained: one(`SELECT count(*) AS n FROM main."${t}" p WHERE NOT EXISTS (SELECT 1 FROM cur."${t}" c WHERE c.id = p.id)`),
        };
      }
      const changed = {};
      const tryCount = (key, sql) => { try { changed[key] = Number(db.prepare(sql).get().n); } catch { changed[key] = null; } };
      tryCount('assertion', 'SELECT count(*) AS n FROM main.assertions p JOIN cur.assertions c ON c.id = p.id WHERE c.text <> p.text OR c.superseded_by IS NOT p.superseded_by');
      tryCount('episode', 'SELECT count(*) AS n FROM main.episodes p JOIN cur.episodes c ON c.id = p.id WHERE c.narrative <> p.narrative');
      tryCount('entity', 'SELECT count(*) AS n FROM main.entities p JOIN cur.entities c ON c.id = p.id WHERE c.display_name IS NOT p.display_name OR c.status <> p.status');

      // 涉及哪些人：会少掉的事实和会回来的事实各自关于谁
      const people = new Map();
      const bump = (rows, field) => { for (const r of rows) { const p = people.get(r.entity_id) ?? { entityId: r.entity_id, lost: 0, regained: 0 }; p[field] += Number(r.n); people.set(r.entity_id, p); } };
      try {
        bump(db.prepare(`SELECT ae.entity_id, count(*) AS n FROM cur.assertions a JOIN cur.assertion_entities ae ON ae.assertion_id = a.id
                         WHERE ae.role IN ('subject','object') AND NOT EXISTS (SELECT 1 FROM main.assertions p WHERE p.id = a.id) GROUP BY ae.entity_id`).all(), 'lost');
        bump(db.prepare(`SELECT ae.entity_id, count(*) AS n FROM main.assertions a JOIN main.assertion_entities ae ON ae.assertion_id = a.id
                         WHERE ae.role IN ('subject','object') AND NOT EXISTS (SELECT 1 FROM cur.assertions c WHERE c.id = a.id) GROUP BY ae.entity_id`).all(), 'regained');
      } catch { /* 旧版本的包可能没有这些列 */ }
      const nameStmt = (schema) => db.prepare(`SELECT COALESCE(NULLIF(e.display_name, ''), (SELECT n.text_raw FROM ${schema}.entity_names n WHERE n.entity_id = e.id ORDER BY n.count DESC LIMIT 1)) AS name, e.is_self AS self FROM ${schema}.entities e WHERE e.id = ?`);
      const curName = nameStmt('cur');
      const packName = nameStmt('main');
      const list = [...people.values()].sort((a, b) => (b.lost + b.regained) - (a.lost + a.regained)).slice(0, 30).map((p) => {
        const r = curName.get(p.entityId) ?? packName.get(p.entityId);
        return { ...p, name: r?.name ?? null, self: !!r?.self };
      });

      // 快照之后的经历：当前库里有、包里没有的感知（恢复后要从来源补回，§12.4.5 第 6 步）
      let gaps = [];
      if (hasTable(db, 'cur', 'percepts')) {
        gaps = db.prepare(`SELECT c.setting_key AS settingKey, count(*) AS n, min(c.at) AS "from", max(c.at) AS "to",
                                  (SELECT label FROM cur.settings s WHERE s.key = c.setting_key) AS label
                           FROM cur.percepts c WHERE c.at >= ? AND NOT EXISTS (SELECT 1 FROM main.percepts p WHERE p.id = c.id)
                           GROUP BY c.setting_key ORDER BY n DESC`).all(Number(since) || 0)
          .map((g) => ({ settingKey: g.settingKey, label: g.label ?? '', count: Number(g.n), from: Number(g.from), to: Number(g.to) }));
      }

      // 当前库的墓碑会在恢复后再删掉包里的多少条
      let tombstoned = 0;
      if (hasTable(db, 'cur', 'tombstones')) {
        for (const [kind, t] of Object.entries(MEMORY_TABLES)) {
          if (!hasTable(db, 'main', t)) continue;
          try {
            tombstoned += Number(db.prepare(`SELECT count(*) AS n FROM main."${t}" p JOIN cur.tombstones tb ON tb.kind = ? AND tb.ref = ? || p.id
                                             AND p."${CREATED_COL[t]}" <= tb.at`).get(kind, PREFIX[kind]).n);
          } catch { /* 列不全的旧包 */ }
        }
      }
      return { kinds, changed, people: list, gaps, tombstoned };
    } finally { db.close(); }
  },

  /** 恢复演练第一步：从恢复出的副本里随机抽几条有词元的记忆（种子可复现）。 */
  drillSample({ file, n, seed }) {
    const db = open(file, true);
    try {
      const pick = (sql) => { try { return db.prepare(sql).all(Number(seed) | 0, n); } catch { return []; } };
      const order = '((id * 1103515245 + ?) % 2147483647)';
      const rows = [
        ...pick(`SELECT 'assertions_fts' AS tbl, id AS rowid, text FROM assertions WHERE text <> '' ORDER BY ${order} LIMIT ?`),
        ...pick(`SELECT 'episodes_fts' AS tbl, id AS rowid, trim(header || ' ' || narrative) AS text FROM episodes WHERE narrative <> '' OR header <> '' ORDER BY ${order} LIMIT ?`),
        ...pick(`SELECT fts_shard AS tbl, id AS rowid, text FROM percepts WHERE text IS NOT NULL AND fts_shard IS NOT NULL ORDER BY ${order} LIMIT ?`),
      ];
      // 三类混在一起再按种子洗一遍，取 n 条
      let s = (Number(seed) >>> 0) || 1;
      const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
      for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
      return rows.slice(0, n).map((r) => ({ table: r.tbl, rowid: Number(r.rowid), text: String(r.text ?? '').slice(0, 2000) }));
    } finally { db.close(); }
  },

  /** 恢复演练第二步：用每条记忆自己的查询词在副本的 FTS 里查，看它在不在结果里。 */
  drillSearch({ file, queries, limit = 200 }) {
    const db = open(file, true);
    try {
      let found = 0;
      const missed = [];
      for (const q of queries) {
        if (!TABLE_RE.test(q.table)) { missed.push(q.rowid); continue; }
        const m = matchQuery(q.terms);
        if (!m) { missed.push(q.rowid); continue; }
        let hit = false;
        try {
          hit = db.prepare(`SELECT rowid FROM "${q.table}" WHERE "${q.table}" MATCH ? ORDER BY bm25("${q.table}") LIMIT ?`).all(m, limit)
            .some((r) => Number(r.rowid) === q.rowid);
        } catch { hit = false; }
        if (hit) found += 1; else missed.push(q.rowid);
      }
      return { found, missed: missed.length };
    } finally { db.close(); }
  },

  /** 部分恢复：从包里挑出选中的那部分记忆，带上导入要的名字和规范；和当前库比，已经在的、被彻底删除过的跳过。 */
  partialSelect({ pack, current, selector }) {
    const db = open(pack, true);
    try {
      db.prepare('ATTACH DATABASE ? AS cur').run(current);
      const ids = JSON.stringify(selector.entityIds ?? []);
      const keys = JSON.stringify(selector.settingKeys ?? []);
      const before = selector.before ?? null;
      const name = db.prepare(`SELECT COALESCE(NULLIF(e.display_name, ''),
                                 (SELECT n.text_raw FROM entity_names n WHERE n.entity_id = e.id ORDER BY n.count DESC LIMIT 1),
                                 (SELECT d.text FROM entity_descriptors d WHERE d.entity_id = e.id AND d.text <> '' LIMIT 1)) AS name,
                                 e.is_self AS self FROM entities e WHERE e.id = ?`);
      const nameOf = (id) => { if (id == null) return null; const r = name.get(id); return r && !r.self ? r.name ?? null : null; };
      const label = db.prepare('SELECT label FROM settings WHERE key = ?');
      const norm = db.prepare('SELECT restriction, allow_json, deny_json FROM flow_norms WHERE owner_kind = ? AND owner_id = ?');
      const firstSource = db.prepare('SELECT speaker, perceived_in, at FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY at, id LIMIT 1');
      const subjects = db.prepare("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role IN ('subject','object') ORDER BY role DESC, entity_id");
      const tomb = db.prepare("SELECT 1 FROM cur.tombstones WHERE kind = ? AND ref = ?");
      const tombEntity = db.prepare("SELECT 1 FROM cur.tombstones WHERE kind = 'entity' AND ref = ?");
      const skipped = { present: 0, tombstoned: 0, noSubject: 0 };
      const normOf = (kind, id) => {
        const r = norm.get(kind, id);
        if (!r) return undefined;
        const allow = jsonParse(r.allow_json, null);
        const deny = jsonParse(r.deny_json, null);
        const scope = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
        return { restriction: r.restriction, ...(Object.keys(scope).length ? { scope } : {}) };
      };
      const where = [];
      const params = [];
      if (selector.entityIds?.length) { where.push("a.id IN (SELECT assertion_id FROM assertion_entities WHERE role IN ('subject','object','mention') AND entity_id IN (SELECT value FROM json_each(?)))"); params.push(ids); }
      if (selector.settingKeys?.length) { where.push("a.id IN (SELECT owner_id FROM sources WHERE owner_kind = 'assertion' AND perceived_in IN (SELECT value FROM json_each(?)))"); params.push(keys); }
      if (before != null) { where.push('a.recorded_at < ? AND (a.expired_at IS NULL OR a.expired_at >= ?)'); params.push(before, before); } else where.push('a.superseded_by IS NULL');
      const assertions = [];
      const presentA = db.prepare('SELECT 1 FROM cur.assertions c WHERE c.id = ? AND c.text = ? AND c.superseded_by IS NULL');
      for (const a of db.prepare(`SELECT a.* FROM assertions a WHERE ${where.join(' AND ')} ORDER BY a.id`).all(...params)) {
        if (tomb.get('assertion', `a${a.id}`)) { skipped.tombstoned += 1; continue; }
        if (presentA.get(a.id, a.text)) { skipped.present += 1; continue; }
        const subj = subjects.all(a.id).map((r) => r.entity_id);
        if (subj.some((id) => tombEntity.get(`n${id}`))) { skipped.tombstoned += 1; continue; }
        const names = [...new Set(subj.map(nameOf).filter(Boolean))];
        if (!names.length) { skipped.noSubject += 1; continue; }
        const src = firstSource.get('assertion', a.id);
        assertions.push({
          ref: `a${a.id}`,
          record: {
            subjects: names.slice(0, 8),
            text: String(a.text).slice(0, 4000),
            sourceMeta: {
              speaker: nameOf(src?.speaker) ?? undefined,
              at: a.valid_from ?? a.event_start ?? a.recorded_at,
              settingLabel: src?.perceived_in ? (label.get(src.perceived_in)?.label || undefined) : undefined,
            },
            norm: normOf('assertion', a.id),
          },
        });
      }
      const episodes = [];
      const ewhere = [];
      const eparams = [];
      if (selector.entityIds?.length) { ewhere.push('EXISTS (SELECT 1 FROM json_each(e.participants_json) j WHERE j.value IN (SELECT value FROM json_each(?)))'); eparams.push(ids); }
      if (selector.settingKeys?.length) { ewhere.push('e.setting_key IN (SELECT value FROM json_each(?))'); eparams.push(keys); }
      if (before != null) { ewhere.push('e.t_end < ?'); eparams.push(before); }
      if (ewhere.length) {
        const presentE = db.prepare('SELECT 1 FROM cur.episodes c WHERE c.id = ? AND c.narrative = ?');
        for (const e of db.prepare(`SELECT e.* FROM episodes e WHERE ${ewhere.join(' AND ')} ORDER BY e.id`).all(...eparams)) {
          if (tomb.get('episode', `e${e.id}`)) { skipped.tombstoned += 1; continue; }
          if (presentE.get(e.id, e.narrative)) { skipped.present += 1; continue; }
          const names = [...new Set((jsonParse(e.participants_json, []) ?? []).map(nameOf).filter(Boolean))];
          if (!names.length) { skipped.noSubject += 1; continue; }
          const text = `${e.header ?? ''}\n${e.narrative ?? ''}`.trim();
          if (!text) continue;
          episodes.push({
            ref: `e${e.id}`,
            record: {
              subjects: names.slice(0, 8),
              text: text.slice(0, 4000),
              sourceMeta: { at: e.t_start, settingLabel: label.get(e.setting_key)?.label || undefined },
              norm: normOf('episode', e.id),
            },
          });
        }
      }
      return { assertions, episodes, skipped };
    } finally { db.close(); }
  },

  /** 可移植导出（§12.4.7）：一个只读事务里的一致快照，逐行写 JSONL，不依赖表结构。 */
  exportJsonl({ file, dest, meta }) {
    const db = open(file, true);
    const fd = fs.openSync(dest, 'w');
    const counts = {};
    const line = (o) => { fs.writeSync(fd, `${JSON.stringify(o)}\n`); counts[o.type] = (counts[o.type] ?? 0) + 1; };
    try {
      db.exec('BEGIN');
      const has = (t) => hasTable(db, 'main', t);
      line({ type: 'header', format: 'persona-memory-export', version: 1, ...meta, schemaVersion: Number(db.prepare('PRAGMA user_version').get().user_version) });
      const page = function* (table, cols = '*', batch = 1000) {
        if (!has(table)) return;
        let after = -1;
        const st = db.prepare(`SELECT ${cols} FROM "${table}" WHERE id > ? ORDER BY id LIMIT ?`);
        for (;;) {
          const rows = st.all(after, batch);
          if (!rows.length) return;
          after = rows.at(-1).id;
          yield* rows;
        }
      };
      const q = (sql) => db.prepare(sql);
      const normStmt = has('flow_norms') ? q('SELECT * FROM flow_norms WHERE owner_kind = ? AND owner_id = ?') : null;
      const knownStmt = has('known_by') ? q('SELECT who_kind, who_ref, since, basis FROM known_by WHERE owner_kind = ? AND owner_id = ?') : null;
      const supStmt = has('suppressions') ? q('SELECT state, at, restore_until FROM suppressions WHERE owner_kind = ? AND owner_id = ?') : null;
      const srcStmt = has('sources') ? q('SELECT percept_id, perceived_in, speaker, asserter, mode, hop, quote, confidence, at FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY id') : null;
      const normOf = (k, id) => {
        const n = normStmt?.get(k, id);
        if (!n) return null;
        return { version: n.version, restriction: n.restriction, allow: jsonParse(n.allow_json), deny: jsonParse(n.deny_json), quote: n.restriction_quote,
          attribute: n.attribute, sensitivity: n.sensitivity, involvesOthers: !!n.involves_others, identityLink: !!n.identity_link, summary: n.summary,
          originExposure: jsonParse(n.origin_exposure_json, {}), settingRuleRef: n.setting_rule_ref, settingRuleVersion: n.setting_rule_version };
      };
      const known = (k, id) => (knownStmt ? knownStmt.all(k, id).map((r) => ({ whoKind: r.who_kind, whoRef: r.who_ref, since: r.since, basis: r.basis })) : []);
      const sup = (k, id) => { const s = supStmt?.get(k, id); return s ? { state: s.state, at: s.at, restoreUntil: s.restore_until } : null; };
      const sources = (k, id) => (srcStmt ? srcStmt.all(k, id).map((s) => ({ perceptId: s.percept_id, settingKey: s.perceived_in, speaker: s.speaker,
        asserter: s.asserter, mode: s.mode, hop: s.hop, quote: s.quote, confidence: s.confidence, at: s.at })) : []);

      // 她自己
      const self = has('entities') ? q('SELECT id FROM entities WHERE is_self = 1').get() : null;
      line({
        type: 'self',
        entityId: self?.id ?? null,
        mood: has('mood') ? q('SELECT at, valence, intensity, cause_ids_json FROM mood ORDER BY at DESC LIMIT 50').all()
          .map((m) => ({ at: m.at, valence: m.valence, intensity: m.intensity, causes: jsonParse(m.cause_ids_json, []) })) : [],
        growth: has('core_block_versions') ? q('SELECT * FROM core_block_versions ORDER BY name, version').all()
          .map((v) => ({ name: v.name, version: v.version, text: v.text, change: jsonParse(v.change_json, {}), evidence: jsonParse(v.evidence_ids, []),
            createdAt: v.created_at, createdBy: v.created_by, revokedAt: v.revoked_at })) : [],
      });
      if (has('settings')) {
        for (const s of q('SELECT s.*, ss.descriptor_json, ss.exposure_rank, ss.persistence_rank FROM settings s LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id ORDER BY s.first_seen').all()) {
          line({ type: 'setting', key: s.key, adapter: s.adapter, label: s.label, stability: s.stability, parentKey: s.parent_key, entityId: s.entity_id,
            // 【D111】主人起的名字、适配器给的称呼、是不是真名（旧库没有这几列时是 undefined，导出里就没有）
            ownerLabel: s.owner_label ?? undefined, adapterLabel: s.adapter_label ?? undefined, labelKind: s.label_kind ?? undefined,
            labelOrigin: s.label_origin ?? undefined,
            firstSeen: s.first_seen, lastSeen: s.last_seen, descriptor: jsonParse(s.descriptor_json), exposureRank: s.exposure_rank, persistenceRank: s.persistence_rank });
        }
      }
      const names = has('entity_names') ? q('SELECT text_raw, used_by, scope_setting_key, reserved, count, first, last FROM entity_names WHERE entity_id = ?') : null;
      const descs = has('entity_descriptors') ? q('SELECT anchor_entity_id, relation, text, created_at FROM entity_descriptors WHERE entity_id = ?') : null;
      const imps = has('entity_impressions') ? q('SELECT * FROM entity_impressions WHERE entity_id = ? ORDER BY layer, version') : null;
      for (const e of page('entities')) {
        line({
          type: 'entity', id: e.id, kind: e.kind, status: e.status, displayName: e.display_name, isSelf: !!e.is_self, closeness: e.closeness,
          authority: e.authority, settingKey: e.setting_key, firstMentionAt: e.first_mention_at, lastMentionAt: e.last_mention_at,
          names: names ? names.all(e.id).map((n) => ({ text: n.text_raw, usedBy: n.used_by, scope: n.scope_setting_key, reserved: !!n.reserved, count: n.count, first: n.first, last: n.last })) : [],
          descriptors: descs ? descs.all(e.id).map((d) => ({ anchor: d.anchor_entity_id, relation: d.relation, text: d.text, at: d.created_at })) : [],
          impressions: imps ? imps.all(e.id).map((i) => ({ id: i.id, layer: i.layer, text: i.text, evidence: jsonParse(i.evidence_ids_json, []), firstHand: i.first_hand,
            hearsay: i.hearsay, version: i.version, isCurrent: !!i.is_current, builtAt: i.built_at, norm: normOf('impression', i.id) })) : [],
          suppression: sup('entity', e.id),
        });
      }
      for (const r of page('identity_evidence')) line({ type: 'identity', entityId: r.entity_id, namespace: r.namespace, scope: r.scope, idHash: r.id_hash, strength: r.strength, at: r.created_at });
      for (const l of page('entity_links')) line({ type: 'link', id: l.id, a: l.a, b: l.b, rel: l.rel, confidence: l.confidence, decidedBy: l.decided_by, crossNamespace: !!l.cross_namespace, at: l.at, norm: normOf('link', l.id) });
      const aEnts = has('assertion_entities') ? q('SELECT entity_id, role FROM assertion_entities WHERE assertion_id = ?') : null;
      const same = has('same_type') ? q('SELECT CASE WHEN a = ? THEN b ELSE a END AS other FROM same_type WHERE a = ? OR b = ?') : null;
      const plans = has('plan_status_history') ? q('SELECT status, at, evidence_percept FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id') : null;
      for (const a of page('assertions')) {
        line({
          type: 'assertion', id: a.id, predicate: a.predicate, value: a.value, objectEntityId: a.object_entity_id, text: a.text, kindHint: a.kind_hint,
          recurrence: jsonParse(a.recurrence, a.recurrence), occurrenceKey: a.occurrence_key, certainty: a.certainty, confidence: a.confidence, imp: a.imp,
          event: { start: a.event_start, end: a.event_end, precision: a.event_precision }, plannedTime: jsonParse(a.planned_time_json),
          validFrom: a.valid_from, validToKnown: a.valid_to_known, changeKnown: !!a.change_known, t50h: a.t50_h, shape: a.shape, confirmedAt: a.confirmed_at ?? null,
          recordedAt: a.recorded_at, expiredAt: a.expired_at, supersedes: a.supersedes, supersededBy: a.superseded_by,
          plan: a.plan_status ? { agent: a.plan_agent, status: a.plan_status, outcomeRef: a.plan_outcome_ref, history: plans ? plans.all(a.id).map((p) => ({ status: p.status, at: p.at, evidencePercept: p.evidence_percept })) : [] } : null,
          pinned: !!a.pinned, entities: aEnts ? aEnts.all(a.id).map((r) => ({ entityId: r.entity_id, role: r.role })) : [],
          sameType: same ? same.all(a.id, a.id, a.id).map((r) => r.other) : [],
          sources: sources('assertion', a.id), norm: normOf('assertion', a.id), knownBy: known('assertion', a.id), suppression: sup('assertion', a.id),
        });
      }
      for (const e of page('episodes')) {
        line({
          type: 'episode', id: e.id, settingKey: e.setting_key, epKind: e.ep_kind, title: e.title, narrative: e.narrative, header: e.header,
          tStart: e.t_start, tEnd: e.t_end, participants: jsonParse(e.participants_json, []), emotion: jsonParse(e.emotion_json),
          sources: sources('episode', e.id), norm: normOf('episode', e.id), knownBy: known('episode', e.id), suppression: sup('episode', e.id),
        });
      }
      for (const t of page('intentions')) {
        line({
          type: 'intention', id: t.id, about: t.about_kind ? { kind: t.about_kind, id: t.about_id } : null, targetEntityId: t.target_entity_id,
          act: t.act, text: t.text, origin: t.origin, trigger: jsonParse(t.trigger_json, {}), state: t.state, formedAt: t.formed_at, armedAt: t.armed_at,
          window: { start: t.window_start, end: t.window_end }, executions: jsonParse(t.executions_json, []), evidence: jsonParse(t.sources_json, []),
          sources: sources('intention', t.id), norm: normOf('intention', t.id), suppression: sup('intention', t.id),
        });
      }
      for (const w of page('raw_windows')) {
        line({ type: 'window', id: w.id, settingKey: w.setting_key, firstPercept: w.first_percept, lastPercept: w.last_percept, tStart: w.t_start, tEnd: w.t_end, text: w.text });
      }
      for (const s of page('storylines')) line({ type: 'storyline', id: s.id, settingKey: s.setting_key, text: s.text, version: s.version, updatedAt: s.updated_at, norm: normOf('storyline', s.id) });
      db.exec('COMMIT');
      const total = { ...counts };
      line({ type: 'footer', counts: total });
      return { counts: total };
    } finally {
      fs.closeSync(fd);
      try { db.close(); } catch { /* 尽力 */ }
    }
  },
};

try {
  const { task, args } = workerData;
  if (!Object.hasOwn(TASKS, task)) throw Object.assign(new Error(`没有这个任务：${task}`), { code: 'NO_TASK' });
  const out = await TASKS[task](args ?? {});
  parentPort.postMessage({ ok: true, out });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e?.code ?? e?.name ?? 'Error', message: String(e?.message ?? e).slice(0, 300) });
}
