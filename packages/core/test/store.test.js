import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  openStore, openDatabase, migrate, checkMigrations, schemaVersionOf, MIGRATIONS, SCHEMA_VERSION, TABLE_OWNERS, checkSchema,
  StoreLockedError, ensurePerceptShard, listPerceptShards, perceptShardName, ftsInsert, ftsDelete, ftsSearch, matchQuery,
  normalizeToken, tokensValue, entityToken, refOf, parseRef, OWNER_KINDS, OWNER_TABLES,
  getMeta, setMeta, getCursor, setCursor, bumpMetric, readMetrics, registerPromptVersion,
  enqueueJob, claimNextJob, completeJob, failJob, requeueStale, getJob, withCursor, openBufferSettings, SEGMENT_BUFFER_SQL,
  loadOrCreateKey, makeKeyring, openVectorStore, sweepVectorCache, mainDbIdOf, VECTORS_SCHEMA_VERSION,
} from '../src/store/index.js';
import { FakeClock } from './fakes/index.js';
import { tmpDir, rmDir } from './helpers.js';

const withDir = (name, fn) => async (t) => {
  const dir = tmpDir(name);
  try { await fn(dir, t); } finally { rmDir(dir); }
};
const tables = (store) => new Set(store.all("SELECT name FROM sqlite_schema WHERE type IN ('table','view')").map((r) => r.name));

test('迁移：全新的库建好全部表，PRAGMA 符合 §12.1', withDir('mig', async (dir) => {
  const store = await openStore({ file: path.join(dir, 'm.db'), clock: new FakeClock() });
  try {
    assert.equal(schemaVersionOf(store), SCHEMA_VERSION);
    assert.deepEqual(store.migration.applied, MIGRATIONS.map((m) => m.version));
    assert.equal(store.migration.backup, null);                     // 全新的库不需要迁移前备份
    assert.equal(String(store.pragma('journal_mode')).toLowerCase(), 'wal');
    assert.equal(store.pragma('synchronous'), 1);                   // NORMAL
    assert.equal(store.pragma('auto_vacuum'), 2);                   // INCREMENTAL
    const have = tables(store);
    for (const t of Object.keys(TABLE_OWNERS)) assert.ok(have.has(t), `缺表 ${t}`);
    assert.deepEqual(checkSchema(store, MIGRATIONS), { ok: true, missing: [] });
    assert.equal(getMeta(store, 'schema_version'), String(SCHEMA_VERSION));
    assert.match(getMeta(store, 'db_id'), /^[0-9a-f]{32}$/);
  } finally { store.close(); }
  // 再开一次：没有待迁移的
  const again = await openStore({ file: path.join(dir, 'm.db') });
  try { assert.deepEqual(again.migration.applied, []); } finally { again.close(); }
}));

test('迁移：表都有唯一的拥有者；§12.2 的每张表都在', () => {
  checkMigrations(MIGRATIONS);
  const all = MIGRATIONS.flatMap((m) => m.tables);
  assert.equal(new Set(all).size, all.length, '一张表只能出现在一份迁移里');
  const design = ['meta', 'settings', 'setting_snapshots', 'presence_sets', 'sessions', 'entities', 'entity_impressions', 'entity_names',
    'entity_descriptors', 'identity_evidence', 'entity_links', 'percepts', 'raw_windows', 'episodes', 'episodes_fts', 'assertions',
    'assertions_fts', 'assertion_entities', 'same_type', 'sources', 'plan_status_history', 'predicates', 'flow_norms', 'setting_rules',
    'known_by', 'told_log', 'intentions', 'traces', 'mood', 'embed_texts', 'vector_spaces', 'prompt_versions', 'appraisals', 'utterances',
    'injections', 'core_blocks', 'core_block_versions', 'jobs', 'cursors', 'review_queue', 'rules', 'tombstones'];
  for (const t of design) assert.ok(TABLE_OWNERS[t], `§12.2 的 ${t} 没有建`);
  for (const kind of Object.keys(OWNER_KINDS)) assert.ok(TABLE_OWNERS[OWNER_TABLES[kind]], `${kind} 的主表 ${OWNER_TABLES[kind]} 不存在`);
});

// 设计 §12.2 每张表的「关键列」（§5.3 的来源字段并在 sources 里）。没有照原名建的列，必须在 MOVED 里说清楚落在哪
// （docs/实现/模块与接口.md §7 的 D4、D7、D8、D9、D24），而且落脚的那一列真的存在。
const DESIGN_COLUMNS = {
  meta: 'key value',
  settings: 'key adapter label stability entity_id current_snapshot_id rules_version first_seen last_seen',
  setting_snapshots: 'id setting_key at descriptor_json reach_hash',
  presence_sets: 'id setting_key at members_json completeness unknown_observers members_hash',
  sessions: 'session_id setting_key adapter bound_at last_event_seq sent_items_json pending_json warm_pending restart_marker inject_window_json taint_ledger_json status',
  entities: 'id kind status display_name closeness authority b_cache tier last_mention_at',
  entity_impressions: 'entity_id layer text evidence_ids_json norm_ref version',
  entity_names: 'entity_id text_raw text_norm used_by scope_setting_key count first last',
  entity_descriptors: 'entity_id anchor_entity_id relation text source_json',
  identity_evidence: 'entity_id namespace scope id_hash strength source_json',
  entity_links: 'a b rel confidence evidence_json decided_by at norm_ref',
  percepts: 'id adapter ext_key setting_key snapshot_id perceived_in presence_set_id visible_to at perceived_at actor_entity_id kind target_id text text_state lang media_json quote_json reply_to mentions_json addressed attention evidential forwarded_json derived_from_json w_enc standing via_json session_ref_json episode_id window_id norm_state',
  raw_windows: 'id setting_key first_percept last_percept t_start t_end text embed_status b_cache tier',
  episodes: 'id setting_key title narrative header header_ver t_start t_end participants_json sealed_at emotion_json extract_ver model embed_status b_cache tier',
  assertions: 'id predicate value object_entity_id text kind_hint recurrence occurrence_key certainty confidence imp event_start event_end event_precision planned_time_json valid_from valid_to_known change_known t50_h shape recorded_at expired_at supersedes superseded_by plan_agent plan_status plan_outcome_id status pinned extract_ver model embed_status b_cache tier',
  assertion_entities: 'assertion_id entity_id role',
  same_type: 'a b',
  sources: 'owner_kind owner_id percept_id snapshot_id perceived_in speaker asserter mode hop quote confidence used_bg_json at extract_ver',
  plan_status_history: 'assertion_id status at evidence_percept source_json',
  predicates: 'key canonical cardinality is_current synonyms_json created_by',
  flow_norms: 'owner_kind owner_id version origin_exposure_json setting_rule_ref setting_rule_version restriction allow_json deny_json restriction_quote attribute sensitivity involves_others summary history_json',
  setting_rules: 'setting_key version rule_json author authority at',
  known_by: 'owner_kind owner_id who_kind who_ref since basis',
  told_log: 'owner_kind owner_id at setting_key presence_set_id utterance_percept_id level',
  intentions: 'id about_kind about_id act origin trigger_json state formed_at armed_at window_end executions_json sources_json norm_ref',
  traces: 'owner_kind owner_id t w d',
  mood: 'at valence intensity cause_ids_json',
  embed_texts: 'owner_kind owner_id chunk_no kind text hash header_ver',
  vector_spaces: 'space_id model quant dim doc_tpl_ver status coverage probe_vectors created_at',
  prompt_versions: 'use version hash created_at',
  appraisals: 'memory_kind memory_id norm_version snapshot_id audience_class trigger_class taint told_ver prompt_ver self_hash model verdict vague_text hint_ok reason at expires_at',
  utterances: 'id setting_key at form_hint text_hash held_text token verdict reflection outcome session_id call_id matched_percept',
  injections: 'id ts session_id setting_key layer nonce items_json chars scores_json degrade_level route_ms_json seen',
  core_blocks: 'name text version char_limit updated_at updated_by pending_text evidence_ids revoked_at',
  jobs: 'use tokens_in tokens_cached tokens_out',
  review_queue: 'id kind payload_json reason status created_at decided_at',
  rules: 'id kind target_json created_by at',
  tombstones: 'id kind ref at',
};
// '表.列' → 落脚的 '表.列'（'derived:…' = 不存，按需推出）
const ACT = (c) => `activation.${c}`;
const MOVED = {
  'settings.rules_version': 'derived:setting_rules.version',          // D8：MAX(version)
  'sessions.taint_ledger_json': 'derived:injections.seen',            // D4：本周期已确认的注入
  'entity_impressions.norm_ref': 'flow_norms.owner_id',               // D8
  'entity_links.norm_ref': 'flow_norms.owner_id',
  'intentions.norm_ref': 'flow_norms.owner_id',
  'percepts.reply_to': 'percepts.reply_to_key',                       // D9
  'assertions.plan_outcome_id': 'assertions.plan_outcome_ref',        // D24
  'assertions.status': 'suppressions.state',                          // D7
  'setting_rules.author': 'setting_rules.author_entity_id',           // D24
  'core_blocks.evidence_ids': 'core_block_versions.evidence_ids',     // D24
  'core_blocks.revoked_at': 'core_block_versions.revoked_at',
};
for (const t of ['entities', 'raw_windows', 'episodes', 'assertions']) {
  MOVED[`${t}.b_cache`] = ACT('b_cache');                             // D7
  MOVED[`${t}.tier`] = ACT('tier');
}
for (const t of ['raw_windows', 'episodes', 'assertions']) MOVED[`${t}.embed_status`] = 'embed_texts.status';

test('迁移：§12.2 的每一列都建了，或者在 D 表里说明了落在哪', withDir('cols', async (dir) => {
  const store = openDatabase({ file: path.join(dir, 'c.db') });
  try {
    await migrate(store, MIGRATIONS);
    const cols = (t) => new Set(store.all(`PRAGMA table_info("${t}")`).map((r) => r.name));
    const has = (ref) => { const [t, c] = ref.replace(/^derived:/, '').split('.'); return cols(t).has(c); };
    const missing = [];
    for (const [t, list] of Object.entries(DESIGN_COLUMNS)) {
      const have = cols(t);
      assert.ok(have.size > 0, `表 ${t} 不存在`);
      for (const c of list.split(' ')) {
        if (have.has(c)) continue;
        const to = MOVED[`${t}.${c}`];
        if (!to) missing.push(`${t}.${c}`);
        else assert.ok(has(to), `${t}.${c} 说是落在 ${to}，但那一列不存在`);
      }
    }
    assert.deepEqual(missing, [], '§12.2 的这些列既没建也没说明');
    for (const k of Object.keys(MOVED)) {
      const [t, c] = k.split('.');
      assert.ok(!cols(t).has(c), `${k} 已经建了，MOVED 里那一行该删掉`);
    }
  } finally { store.close(); }
  // 向量库（纯缓存，不走迁移）：§12.2 的 vec 拆成 f32 / q8（D24）
  const vec = openVectorStore({ file: path.join(dir, 'v.db'), mainDbId: 'x' });
  try {
    const vcols = new Set(vec.all('PRAGMA table_info(vectors)').map((r) => r.name));
    for (const c of ['space_id', 'owner_kind', 'owner_id', 'chunk_no', 'f32', 'q8', 'bin']) assert.ok(vcols.has(c), `vectors.${c}`);
  } finally { vec.close(); }
}));

test('迁移：已有数据的库先调备份钩子；钩子失败就不迁移',withDir('mig-backup', async (dir) => {
  const file = path.join(dir, 'm.db');
  const first = openDatabase({ file });
  await migrate(first, MIGRATIONS, { target: 3 });
  first.close();
  const calls = [];
  await assert.rejects(openStore({ file, backup: async (info) => { calls.push(info); throw new Error('备份盘满了'); } }), /备份盘满了/);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].reason, calls[0].from, calls[0].to], ['migrate', 3, SCHEMA_VERSION]);
  const still = openDatabase({ file });
  assert.equal(schemaVersionOf(still), 3, '备份失败时库停在原来的版本');
  still.close();
  const ok = await openStore({ file, backup: async (info) => { calls.push(info); return 'snap.db'; } });
  try {
    assert.equal(ok.migration.from, 3);
    assert.equal(ok.migration.backup, 'snap.db');
    assert.equal(schemaVersionOf(ok), SCHEMA_VERSION);
  } finally { ok.close(); }
}));

test('迁移：一个迁移失败，整体回滚', withDir('mig-fail', async (dir) => {
  const file = path.join(dir, 'm.db');
  const broken = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'broken', owner: 'store', tables: ['x'], up(db) { db.exec('CREATE TABLE x (a)'); db.exec('THIS IS NOT SQL'); } }];
  await assert.rejects(openStore({ file, migrations: broken }));
  const db = openDatabase({ file });
  try {
    assert.equal(schemaVersionOf(db), 0, '第一次就失败：什么都没留下');
    assert.equal(tables(db).has('meta'), false);
  } finally { db.close(); }
}));

test('只读：库的版本比代码新（主人回退了插件）', withDir('newer', async (dir) => {
  const file = path.join(dir, 'm.db');
  const s = await openStore({ file });
  s.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
  s.close();
  const ro = await openStore({ file });
  try {
    assert.equal(ro.readOnly, true);
    assert.equal(ro.readOnlyReason, 'newer-schema');
    assert.equal(ro.migration.readOnly, true);
    assert.throws(() => ro.run('INSERT INTO meta(key, value) VALUES (?, ?)', 'a', 'b'), (e) => e.code === 'READ_ONLY');
    assert.throws(() => ro.tx(() => {}), (e) => e.code === 'READ_ONLY');
    assert.ok(ro.get("SELECT value FROM meta WHERE key = 'db_id'"), '读照常');
  } finally { ro.close(); }
}));

test('单写者：同一个文件不能有第二个写者；关掉后可以再开；worker 用只读连接', withDir('lock', async (dir) => {
  const file = path.join(dir, 'm.db');
  const a = await openStore({ file });
  try {
    assert.throws(() => openDatabase({ file }), StoreLockedError);
    const reader = openDatabase({ file, readOnly: true });
    try {
      assert.ok(reader.get('SELECT count(*) AS n FROM meta').n >= 1);
      assert.throws(() => reader.run("INSERT INTO meta(key, value) VALUES ('x', 'y')"), (e) => e.code === 'READ_ONLY');
    } finally { reader.close(); }
  } finally { a.close(); }
  assert.equal(fs.existsSync(`${file}.writer.lock`), false, '关闭时释放锁');
  // 崩溃留下的过期锁（pid 不存在）会被清掉
  fs.writeFileSync(`${file}.writer.lock`, JSON.stringify({ pid: 2 ** 30, at: 0 }));
  const b = openDatabase({ file });
  b.close();
}));

test('事务：失败整体回滚；嵌套用 SAVEPOINT；回调不能是异步的；afterCommit 只在提交后跑', withDir('tx', async (dir) => {
  const s = await openStore({ file: path.join(dir, 'm.db') });
  try {
    assert.throws(() => s.tx((db) => { setMeta(db, 'a', '1'); throw new Error('boom'); }), /boom/);
    assert.equal(getMeta(s, 'a'), null);
    s.tx((db) => {
      setMeta(db, 'outer', '1');
      assert.throws(() => db.tx((inner) => { setMeta(inner, 'inner', '1'); throw new Error('inner'); }));
      setMeta(db, 'after', '1');
    });
    assert.deepEqual([getMeta(s, 'outer'), getMeta(s, 'inner'), getMeta(s, 'after')], ['1', null, '1']);
    assert.throws(() => s.tx(async () => {}), /同步/);
    assert.equal(s.inTransaction, false);
    const seen = [];
    s.tx((db) => { db.afterCommit(() => seen.push('committed')); assert.deepEqual(seen, []); });
    assert.deepEqual(seen, ['committed']);
    assert.throws(() => s.tx((db) => { db.afterCommit(() => seen.push('rolled-back')); throw new Error('x'); }));
    assert.deepEqual(seen, ['committed']);
    // 参数规范化：布尔值转 1/0，undefined 转 null，对象拒绝
    s.run('INSERT INTO cursors(source, key, value, updated_at) VALUES (?, ?, ?, ?)', 's', 'k', 'v', 1);
    assert.throws(() => s.run('UPDATE cursors SET value = ? WHERE source = ?', { a: 1 }, 's'), TypeError);
  } finally { s.close(); }
}));

test('§12.8 不变式 1：游标和感知同一个事务', withDir('cursor', async (dir) => {
  const s = await openStore({ file: path.join(dir, 'm.db') });
  try {
    const insertPercept = (db, ext) => db.run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_json, kind,
      text, text_hash, addressed, attention, attention_class, evidential, standing, created_at)
      VALUES ('zz', ?, 'S', 'S', 'setting-audience', 1, 1, '{}', 'utterance', 'x', 'h', 'ambient', 'peripheral', 'peripheral', 1, 'first-hand', 1)`, ext);
    assert.throws(() => withCursor(s, { source: 'adapter:zz', key: 'file', value: '10' }, (db) => { insertPercept(db, 'e1'); throw new Error('crash'); }));
    assert.equal(getCursor(s, 'adapter:zz', 'file'), null);
    assert.equal(s.get('SELECT count(*) AS n FROM percepts').n, 0);
    withCursor(s, { source: 'adapter:zz', key: 'file', value: '10' }, (db) => insertPercept(db, 'e1'));
    assert.equal(getCursor(s, 'adapter:zz', 'file'), '10');
    // 不变式 2：缓冲就是 episode_id 为空的感知
    assert.equal(s.all(SEGMENT_BUFFER_SQL, 'S').length, 1);
    assert.equal(openBufferSettings(s)[0].setting_key, 'S');
    // UNIQUE(adapter, ext_key)：同一条消息不会入库两次
    assert.throws(() => insertPercept(s, 'e1'), /UNIQUE/);
  } finally { s.close(); }
}));

test('§12.8 不变式 3：任务结果在一个事务里写入，重跑幂等；失败按退避重排', withDir('jobs', async (dir) => {
  const clock = new FakeClock();
  const s = await openStore({ file: path.join(dir, 'm.db'), clock });
  try {
    const a = enqueueJob(s, { kind: 'extract', dedupeKey: 'S:1-5', priority: 2, epFrom: 1, epTo: 5 });
    const dup = enqueueJob(s, { kind: 'extract', dedupeKey: 'S:1-5' });
    assert.equal(dup.created, false);
    assert.equal(dup.id, a.id);
    const job = claimNextJob(s, { kinds: ['extract'] });
    assert.equal(job.id, a.id);
    assert.equal(job.attempts, 1);
    assert.equal(claimNextJob(s), null, '正在跑的不会再被取走');
    // 写到一半崩了：什么都没提交，任务还能重跑
    assert.throws(() => completeJob(s, job.id, (db) => { setMeta(db, 'out', 'half'); throw new Error('crash'); }));
    assert.equal(getMeta(s, 'out'), null);
    assert.equal(getJob(s, job.id).status, 'running');
    assert.equal(requeueStale(s), 1);
    const again = claimNextJob(s);
    const r1 = completeJob(s, again.id, (db) => { setMeta(db, 'out', 'full'); return 7; }, { model: 'm', tokensIn: 10, tokensOut: 3 });
    assert.deepEqual(r1, { skipped: false, result: 7 });
    const r2 = completeJob(s, again.id, () => { throw new Error('不该再执行'); });
    assert.deepEqual(r2, { skipped: true });
    assert.equal(getJob(s, again.id).tokens_in, 10);
    // 失败：1 / 4 / 16 分钟退避，次数用完 failed；错误只记类型
    const b = enqueueJob(s, { kind: 'extract', dedupeKey: 'S:6-9' });
    let j = claimNextJob(s);
    assert.equal(failJob(s, j.id, { errorCode: 'LLM_DOWN' }), 'queued');
    assert.equal(claimNextJob(s), null, '退避期内不跑');
    clock.minutes(1);
    j = claimNextJob(s);
    assert.equal(j.id, b.id);
    assert.equal(failJob(s, j.id, { errorCode: 'LLM_DOWN' }), 'queued');
    clock.minutes(4); j = claimNextJob(s); failJob(s, j.id, { errorCode: 'LLM_DOWN' });
    clock.minutes(16); j = claimNextJob(s);
    assert.equal(failJob(s, j.id, { errorCode: 'LLM_DOWN' }), 'failed');
    assert.equal(getJob(s, b.id).last_error, 'LLM_DOWN');
  } finally { s.close(); }
}));

test('FTS：分表按月创建；任何用户文本拼出的查询都不报错（§14.2）', withDir('fts', async (dir) => {
  const s = await openStore({ file: path.join(dir, 'm.db') });
  try {
    const nov = Date.UTC(2026, 10, 1);
    const t = ensurePerceptShard(s, nov);
    assert.equal(t, 'percepts_fts_202611');
    assert.equal(ensurePerceptShard(s, nov + 1000), t);
    ensurePerceptShard(s, Date.UTC(2026, 9, 15));
    assert.deepEqual(listPerceptShards(s), ['percepts_fts_202611', 'percepts_fts_202610']);
    assert.deepEqual(listPerceptShards(s, { months: 1 }), ['percepts_fts_202611']);
    assert.equal(perceptShardName(nov), t);
    ftsInsert(s, t, 1, ['快递', '拿了', entityToken(12), 'Hello']);
    ftsInsert(s, t, 2, ['驿站', '包裹', entityToken(1)]);
    assert.deepEqual(ftsSearch(s, t, ['ent_12']).map((r) => r.rowid), [1]);
    assert.deepEqual(ftsSearch(s, t, ['ent_1']).map((r) => r.rowid), [2], 'ent_1 不会匹配到 ent_12');
    assert.deepEqual(ftsSearch(s, t, ['HELLO']).map((r) => r.rowid), [1]);
    const nasty = ['AND', 'NOT', 'NEAR', 'x:y', 'c++', '"', '""', "'", '(', ')', '*', '^', 'OR', 'a"b', '\u0000', '', '   ', '快递 OR', 'NEAR(a b)'];
    for (const q of nasty) assert.doesNotThrow(() => ftsSearch(s, t, [q]), `查询 ${JSON.stringify(q)} 报错了`);
    assert.doesNotThrow(() => ftsSearch(s, t, nasty));
    assert.equal(matchQuery(['', '  ', '!!']), null);
    assert.equal(matchQuery(Array.from({ length: 30 }, (_, i) => `w${i}`)).split(' OR ').length, 12, '最多 12 个词');
    ftsDelete(s, t, 1);
    assert.deepEqual(ftsSearch(s, t, ['快递']), []);
    assert.equal(normalizeToken('Ｃ＋＋'), 'c');
    assert.equal(tokensValue(['A', 'a', 'b!']), 'a b');
    for (const table of ['episodes_fts', 'assertions_fts']) {
      ftsInsert(s, table, 5, ['阿明', '表哥']);
      assert.deepEqual(ftsSearch(s, table, ['表哥']).map((r) => r.rowid), [5]);
    }
    assert.throws(() => ftsInsert(s, 'percepts; DROP TABLE meta', 1, ['x']), /不合法/);
  } finally { s.close(); }
}));

test('记忆引用', () => {
  assert.equal(refOf('assertion', 123), 'a123');
  assert.deepEqual(parseRef('a123'), { kind: 'assertion', id: 123 });
  assert.deepEqual(parseRef('w7'), { kind: 'window', id: 7 });
  for (const bad of ['', 'a', 'a0', 'a-1', 'a01', 'x5', 'a1.5', 42, null]) assert.equal(parseRef(bad), null, `${bad}`);
  assert.throws(() => refOf('nope', 1));
  assert.throws(() => refOf('assertion', 0));
  for (const [kind, prefix] of Object.entries(OWNER_KINDS)) assert.equal(parseRef(`${prefix}9`).kind, kind);
});

test('密钥和存储键：不存原值，同值同键，换密钥全变；坏文件不覆盖', withDir('keys', async (dir) => {
  const file = path.join(dir, 'k.key');
  const k1 = loadOrCreateKey(file);
  assert.equal(k1.length, 32);
  assert.deepEqual(loadOrCreateKey(file), k1);
  const ring = makeKeyring(k1);
  // 原值用 base64url 里不会出现的字符（随机的键碰巧含「S1」这种两个字符的串，测试就会偶发失败）
  const RAW = 'S1!原值';
  const s1 = ring.settingKey('zz', RAW);
  assert.equal(ring.settingKey('zz', RAW), s1);
  assert.notEqual(ring.settingKey('yy', RAW), s1, '不同适配器的同一个 SettingId 是不同的场合');
  assert.notEqual(ring.obsKey('zz', RAW), s1, '不同用途的键互不相同');
  assert.ok(!s1.includes(RAW) && !s1.includes('!') && !s1.includes('原'), '不存原值');
  const h = ring.identityHash('zz', undefined, 'u1');
  assert.equal(h, ring.identityHash('zz', '', 'u1'));
  assert.notEqual(h, ring.identityHash('zz', 'app', 'u1'));
  assert.notEqual(makeKeyring(Buffer.alloc(32, 7)).settingKey('zz', RAW), s1);
  fs.writeFileSync(path.join(dir, 'bad.key'), 'not-a-key');
  assert.throws(() => loadOrCreateKey(path.join(dir, 'bad.key')), /格式不对/);
  assert.equal(fs.readFileSync(path.join(dir, 'bad.key'), 'utf8'), 'not-a-key');
}));

test('meta、计数、提示词版本', withDir('kv', async (dir) => {
  const clock = new FakeClock(Date.UTC(2026, 10, 1, 12));
  const s = await openStore({ file: path.join(dir, 'm.db'), clock });
  try {
    bumpMetric(s, 'recall.l3');
    bumpMetric(s, 'recall.l3', 2);
    assert.deepEqual(readMetrics(s, { day: '2026-11-01', prefix: 'recall.' }).map((r) => [r.name, r.value]), [['recall.l3', 3]]);
    const h = registerPromptVersion(s, 'extract', 'v1', '提示词');
    assert.equal(registerPromptVersion(s, 'extract', 'v1', '提示词'), h);
    assert.throws(() => registerPromptVersion(s, 'extract', 'v1', '改了的提示词'), /版本号/);
  } finally { s.close(); }
}));

test('向量缓存库：版本或主库对不上就清空重建；清扫删掉孤儿、补回缺失', withDir('vec', async (dir) => {
  const main = await openStore({ file: path.join(dir, 'm.db') });
  const vfile = path.join(dir, 'v.db');
  try {
    let vec = openVectorStore({ file: vfile, mainDbId: mainDbIdOf(main) });
    assert.equal(vec.pragma('user_version'), VECTORS_SCHEMA_VERSION);
    assert.equal(vec.wiped, null);
    const now = 1;
    const addText = (ownerId, hash, status = 'done') => Number(main.run(`INSERT INTO embed_texts(owner_kind, owner_id, chunk_no, kind, layer, text, hash, priority, status, space_id, created_at, updated_at)
      VALUES ('assertion', ?, 0, 'text', 'memory', 't', ?, 2, ?, 'sp', ?, ?)`, ownerId, hash, status, now, now).lastInsertRowid);
    const addVec = (embedTextId, ownerId, hash) => vec.run(`INSERT INTO vectors(space_id, embed_text_id, owner_kind, owner_id, chunk_no, kind, layer, text_hash, q8, q8_scale, bin, created_at)
      VALUES ('sp', ?, 'assertion', ?, 0, 'text', 'memory', ?, ?, 1.0, ?, ?)`, embedTextId, ownerId, hash, new Uint8Array(4), new Uint8Array(1), now);
    const live = addText(1, 'h1');
    const changed = addText(2, 'h2-new');
    const missing = addText(3, 'h3');
    addVec(live, 1, 'h1');
    addVec(changed, 2, 'h2-old');
    addVec(9999, 9, 'gone');                                 // 主库里已经没有了
    const r = sweepVectorCache(main, vec, { activeSpaceId: 'sp', batch: 2 });
    assert.deepEqual(r, { removed: 2, requeued: 2 });        // changed + 孤儿；changed 和 missing 改回 pending
    assert.equal(main.get('SELECT status FROM embed_texts WHERE id = ?', missing).status, 'pending');
    assert.equal(main.get('SELECT status FROM embed_texts WHERE id = ?', live).status, 'done');
    vec.close();
    // 换了主库（比如拷过来的别人的向量文件）：整个清空
    vec = openVectorStore({ file: vfile, mainDbId: 'someone-else' });
    assert.equal(vec.wiped, 'other-main-db');
    assert.equal(vec.get('SELECT count(*) AS n FROM vectors').n, 0);
    vec.close();
  } finally { main.close(); }
}));
