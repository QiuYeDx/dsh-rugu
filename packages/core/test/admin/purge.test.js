// 彻底删除（§12.7、级联表见 docs/实现/模块与接口.md §2.3）、墓碑重删（§12.4.5 第 5 步）、按来源撤回。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { ContractError } from '../../src/contract/errors.js';
import { openDatabase } from '../../src/store/index.js';
import { createConfig } from '../../src/config/defaults.js';
import { DAY, HOUR } from '../fakes/index.js';
import {
  adminCore, seedSetting, seedEntity, seedPercept, seedWindow, seedAssertion, seedEpisode, seedImpression, seedIdentity, seedInjection,
  memoryRows, leftovers, NONE_LEFT, terms,
} from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};

/** 一个小世界：阿明说了两句，小红说了一句，派生出事实、情节、窗口、印象、意图，注入过一次。 */
function world(core) {
  const sk = seedSetting(core, { key: 'sk-world' });
  const P = seedEntity(core, { name: '主人', authority: 'principal', closeness: 1 });
  const S = seedEntity(core, { name: '她', isSelf: 1 });
  const A = seedEntity(core, { name: '阿明' });
  const B = seedEntity(core, { name: '小红' });
  const t0 = core.now();
  const p1 = seedPercept(core, { settingKey: sk, actor: A, text: '我表哥开网约车', at: t0, ext: 'm-1' });
  const p2 = seedPercept(core, { settingKey: sk, actor: A, text: '周末一起去爬山吧', at: t0 + 1000, ext: 'm-2' });
  const p3 = seedPercept(core, { settingKey: sk, actor: B, text: '我也去爬山', at: t0 + 2000, ext: 'm-3' });
  const w1 = seedWindow(core, { settingKey: sk, perceptIds: [p1, p2, p3], text: '我表哥开网约车 / 周末一起去爬山吧 / 我也去爬山' });
  const a1 = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [A], speaker: A, perceptIds: [p1], settingKey: sk });
  const a2 = seedAssertion(core, { text: '周末大家去爬山', subjects: [A, B], speaker: A, perceptIds: [p2, p3], settingKey: sk });
  const a3 = seedAssertion(core, { text: '阿明和小红都认识那位司机', subjects: [A, B], speaker: A, perceptIds: [p1, p3], settingKey: sk });
  const e1 = seedEpisode(core, { settingKey: sk, narrative: '阿明说他表哥开网约车，约大家周末爬山', participants: [A], perceptIds: [p1, p2] });
  const i1 = seedImpression(core, { entityId: A, text: '阿明有个开网约车的表哥', evidence: [`a${a1}`] });
  const t1 = Number(core.store.run(`INSERT INTO intentions(about_kind, about_id, act, origin, formed_at, created_at, updated_at, sources_json)
                                    VALUES ('assertion', ?, 'ask', 'self-care', ?, ?, ?, ?)`, a1, t0, t0, t0, JSON.stringify([p1])).lastInsertRowid);
  memoryRows(core, 'intention', t1);
  seedInjection(core, { sessionId: 'sess-1', refs: [`a${a1}`, `a${a2}`] });
  seedInjection(core, { sessionId: 'sess-2', refs: [`a${a2}`] });
  return { sk, P, S, A, B, p1, p2, p3, w1, a1, a2, a3, e1, i1, t1 };
}

function snapshotState(core) {
  const tables = ['percepts', 'raw_windows', 'assertions', 'episodes', 'entity_impressions', 'intentions', 'entities', 'sources', 'flow_norms', 'known_by',
    'traces', 'activation', 'embed_texts', 'assertion_entities', 'identity_evidence', 'entity_links'];
  const out = {};
  for (const t of tables) out[t] = core.store.all(`SELECT * FROM ${t}`).map((r) => JSON.stringify(r)).sort();
  out.tombstones = core.store.all('SELECT kind, ref FROM tombstones ORDER BY kind, ref').map((r) => `${r.kind}:${r.ref}`);
  out.review = core.store.all('SELECT id FROM assertions WHERE needs_review = 1 ORDER BY id').map((r) => r.id);
  out.released = core.store.all('SELECT id, episode_id, historical, window_id FROM percepts ORDER BY id').map((r) => JSON.stringify(r));
  return out;
}

test('purge 一条感知：§2.3 的顺序（操作前快照 → 先删向量 → 主库 → 墓碑）；只靠它的派生一起删，有别的证据的标复核；返回注入过的会话', withCore('adm-purge-p', async (core, t) => {
  const w = world(core);
  seedInjection(core, { sessionId: 'sess-w', refs: [`w${w.w1}`] });
  const ext1 = core.store.get('SELECT ext_key FROM percepts WHERE id = ?', w.p1).ext_key;
  const shard = core.store.get('SELECT fts_shard FROM percepts WHERE id = ?', w.p1).fts_shard;
  const r = await core.mods.admin.purge(core, [`p${w.p1}`], { by: 'owner', at: core.now() });
  // 顺序
  const names = t.calls.map((c) => c.name);
  assert.ok(names.indexOf('backup.preOperationSnapshot') < names.indexOf('worker.dropEmbeddings'));
  assert.ok(names.indexOf('worker.dropEmbeddings') < names.indexOf('intake.dropFromWindows'));
  assert.equal(t.of('backup.preOperationSnapshot')[0].args[0].reason, 'purge');
  const [dropped, stillThere] = t.of('worker.dropEmbeddings')[0].args;
  assert.ok(stillThere.every(Boolean), '删向量的时候主库的行都还在（先删向量，再删主库）');
  assert.deepEqual(new Set(dropped), new Set([`p${w.p1}`, `a${w.a1}`, `e${w.e1}`, `i${w.i1}`, `t${w.t1}`]));
  // 原文窗口（§2.3 第 4 步）：交给 intake 把这条从成员里拿掉、重新渲染（它先删这个窗口的向量），窗口里别人的话留着
  assert.deepEqual(t.of('intake.dropFromWindows').map((c) => c.args[0]), [[w.p1]]);
  assert.deepEqual(t.of('worker.dropEmbeddings')[1].args[0], [`w${w.w1}`]);
  const win = core.store.get('SELECT members_json, text FROM raw_windows WHERE id = ?', w.w1);
  assert.deepEqual(JSON.parse(win.members_json), [w.p2, w.p3]);
  assert.ok(!win.text.includes('网约车'), '窗口里不留删掉的原话');
  // 删掉的
  assert.deepEqual(r.deleted, { percept: 1, assertion: 1, episode: 1, impression: 1, intention: 1 });
  assert.deepEqual(r.sessions.sort(), ['sess-1', 'sess-w'], '「已经注入过的文字收不回」：列出注入过它（或含它的原文窗口）的会话');
  assert.ok(t.of('context.markResidentDirty').length >= 1, '常驻区标脏');
  assert.equal(t.of('entities.invalidateNames').length, 0, '没删人，名字表不用重建');
  for (const [kind, id] of [['percept', w.p1], ['assertion', w.a1], ['episode', w.e1], ['impression', w.i1], ['intention', w.t1]]) {
    assert.deepEqual(leftovers(core, kind, id), NONE_LEFT, `${kind} 身上挂的行都删了`);
  }
  assert.equal(core.store.get('SELECT count(*) AS n FROM percepts WHERE id = ?', w.p1).n, 0);
  assert.equal(core.store.get(`SELECT count(*) AS n FROM ${shard} WHERE ${shard} MATCH ?`, terms('网约车')[0]).n, 0, 'FTS 行删了');
  assert.equal(core.store.get('SELECT count(*) AS n FROM assertions_fts WHERE assertions_fts MATCH ?', terms('网约车')[0]).n, 0);
  assert.equal(core.store.get("SELECT count(*) AS n FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", w.a1).n, 0);
  assert.equal(core.store.get('SELECT count(*) AS n FROM assertion_entities WHERE assertion_id = ?', w.a1).n, 0);
  // 留下的：有别的证据的事实标复核；被删情节的其他感知放回切分缓冲（历史模式）；窗口的其他成员还在重新渲染过的窗口里
  assert.equal(core.store.get('SELECT needs_review FROM assertions WHERE id = ?', w.a3).needs_review, 1, '还有小红作证：留着，标复核');
  assert.equal(core.store.get('SELECT needs_review FROM assertions WHERE id = ?', w.a2).needs_review, 0, '和这条感知无关的不动');
  assert.deepEqual({ ...core.store.get('SELECT episode_id, historical, window_id FROM percepts WHERE id = ?', w.p2) }, { episode_id: null, historical: 1, window_id: w.w1 });
  assert.equal(core.store.get('SELECT window_id FROM percepts WHERE id = ?', w.p3).window_id, w.w1);
  assert.ok(core.store.get('SELECT 1 FROM entities WHERE id = ?', w.A), '人还在');
  // 墓碑
  const tombs = core.store.all('SELECT kind, ref FROM tombstones ORDER BY kind, ref').map((x) => `${x.kind}:${x.ref}`);
  assert.deepEqual(tombs, [`assertion:a${w.a1}`, `episode:e${w.e1}`, `impression:i${w.i1}`, `intention:t${w.t1}`, `obs:zz:${ext1}`, `percept:p${w.p1}`].sort());
  assert.deepEqual([...core.mods.admin.tombstonedObs(core, 'zz', [ext1, 'other'])], [ext1], '从来源补回或平台重发同一条消息时认得出来');
  assert.equal(core.store.get("SELECT value FROM meta WHERE key = 'admin.purge.pending'")?.value ?? null, null, '做完了，没有挂着的计划');
  // 日志里没有内容
  t.ports.logger.assertNoText('网约车', '阿明', '爬山');
}));

test('purge 一个人：档案、名字、身份证据（墓碑记 id_hash）、印象、链接一起删；只关于他的事实删，同时涉及别人的标复核；不能删她自己和主人', withCore('adm-purge-n', async (core, t) => {
  const w = world(core);
  const h = seedIdentity(core, { entityId: w.A });
  core.store.run("INSERT INTO entity_links(a, b, rel, confidence, decided_by, at, created_at) VALUES (?, ?, 'maybe_same', 0.5, 'extractor', ?, ?)",
    Math.min(w.A, w.B), Math.max(w.A, w.B), core.now(), core.now());
  const r = await core.mods.admin.purge(core, [`n${w.A}`], { by: 'owner', at: core.now() });
  assert.equal(r.deleted.entity, 1);
  assert.equal(t.of('entities.invalidateNames').length, 1, '删了档案和名字：名字匹配器重建');
  assert.equal(r.deleted.assertion, 1, '只关于他的那条（a1）删了');
  assert.equal(r.deleted.impression, 1);
  assert.equal(r.deleted.link, 1);
  assert.equal(core.store.get('SELECT count(*) AS n FROM entity_names WHERE entity_id = ?', w.A).n, 0);
  assert.equal(core.store.get('SELECT count(*) AS n FROM identity_evidence WHERE entity_id = ?', w.A).n, 0);
  assert.ok(core.store.get("SELECT 1 FROM tombstones WHERE kind = 'identity' AND ref = ?", h));
  assert.equal(core.store.get('SELECT needs_review FROM assertions WHERE id = ?', w.a2).needs_review, 1);
  assert.equal(core.store.get('SELECT count(*) AS n FROM percepts WHERE actor_entity_id = ?', w.A).n, 0, '他说过的话不再指向不存在的人');
  assert.ok(core.store.get('SELECT 1 FROM percepts WHERE id = ?', w.p2), '原话本身不因为删人而删（要删用按来源撤回）');
  await assert.rejects(core.mods.admin.purge(core, [`n${w.S}`], { by: 'owner', at: core.now() }), ContractError);
  await assert.rejects(core.mods.admin.purge(core, [`n${w.P}`], { by: 'owner', at: core.now() }), ContractError);
  await assert.rejects(core.mods.admin.purge(core, [], { by: 'owner', at: core.now() }), ContractError);
  await assert.rejects(core.mods.admin.purge(core, ['zz9'], { by: 'owner', at: core.now() }), ContractError);
}));

test('purge：操作前快照做不了就不删（宁可这次不做）', withCore('adm-purge-snapfail', async (core) => {
  const a = seedAssertion(core, { text: '要删的事' });
  await assert.rejects(core.mods.admin.purge(core, [`a${a}`], { by: 'owner', at: core.now() }), /disk full/);
  assert.ok(core.store.get('SELECT 1 FROM assertions WHERE id = ?', a));
  assert.equal(core.store.get('SELECT count(*) AS n FROM tombstones').n, 0);
}, { mods: { backup: { preOperationSnapshot: async () => { throw new Error('disk full'); } } } }));

test('purge 中途崩溃（注入：删到情节时失败），重启时 reapplyTombstones 接着做完——结果和一次做完的完全一样', async () => {
  // admin.purgeBatch 还没并进 defaults.js（交付说明里列了），这里用一个包了一层的配置把它设成 1：一批只删一个单元
  const base = createConfig({});
  const oneByOne = { ...base, get: () => ({ ...base.get(), admin: { purgeBatch: 1 } }) };
  const clean = await adminCore('adm-purge-clean', { config: {} });
  const crash = await adminCore('adm-purge-crash', { config: oneByOne });
  try {
    // 同样的数据、同样的时钟
    for (const t of [clean, crash]) { t.ports.clock.set(Date.UTC(2026, 10, 1)); world(t.core); }
    const ref = `p${1}`;
    const at = clean.core.now();
    await clean.core.mods.admin.purge(clean.core, [ref], { by: 'owner', at });
    const want = snapshotState(clean.core);
    // 崩溃的那份：删到情节（第四个单元）时失败（一个临时触发器模拟进程在事务中途死掉）
    const order = [];
    crash.core.store.exec(`CREATE TEMP TRIGGER crash_once BEFORE DELETE ON episodes BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    await assert.rejects(crash.core.mods.admin.purge(crash.core, [ref], { by: 'owner', at }), /simulated crash/);
    order.push(crash.core.store.get('SELECT count(*) AS n FROM tombstones').n);
    assert.ok(order[0] > 0, '崩溃前已经删掉并写了墓碑的几批是提交了的');
    assert.ok(crash.core.store.get("SELECT value FROM meta WHERE key = 'admin.purge.pending'").value, '计划留着');
    crash.core.store.exec('DROP TRIGGER crash_once');
    // 「重启」：启动步骤里的 reapplyTombstones 先把挂着的计划做完
    const r = await crash.core.mods.admin.reapplyTombstones(crash.core);
    assert.ok(r.deleted > 0);
    assert.deepEqual(snapshotState(crash.core), want);
    // 再跑一遍也不变（可安全重跑）
    await crash.core.mods.admin.reapplyTombstones(crash.core);
    assert.deepEqual(snapshotState(crash.core), want);
  } finally { await clean.cleanup(); await crash.cleanup(); }
});

test('reapplyTombstones：只删墓碑时间之前就有的行（恢复后新写入的同 id 行是新的记忆）；给了墓碑列表就补进墓碑表', withCore('adm-reapply', async (core, t) => {
  const a = seedAssertion(core, { text: '旧的一条' });
  const old = { kind: 'assertion', ref: `a${a}`, at: core.now() + HOUR };
  t.ports.clock.advance(2 * HOUR);
  const newer = seedAssertion(core, { text: '新的一条' });
  const late = { kind: 'assertion', ref: `a${newer}`, at: core.now() - HOUR };   // 墓碑比这一行还早
  const e = seedEntity(core, { name: '阿明' });
  const h = seedIdentity(core, { entityId: e });
  const r = await core.mods.admin.reapplyTombstones(core, { tombstones: [old, late, { kind: 'identity', ref: h, at: core.now() + 1 }] });
  assert.equal(r.deleted, 2);
  assert.equal(core.store.get('SELECT count(*) AS n FROM assertions WHERE id = ?', a).n, 0);
  assert.ok(core.store.get('SELECT 1 FROM assertions WHERE id = ?', newer), '墓碑之后才有的行不删');
  assert.equal(core.store.get('SELECT count(*) AS n FROM identity_evidence WHERE id_hash = ?', h).n, 0);
  assert.ok(core.store.get('SELECT 1 FROM entities WHERE id = ?', e), '身份证据删了，档案本身不删');
  assert.equal(core.store.get('SELECT count(*) AS n FROM tombstones').n, 3, '换回来的旧库里没有之后的墓碑：补上');
  assert.equal((await core.mods.admin.reapplyTombstones(core)).deleted, 0, '重跑不再删');
  // 从来源补回的、被彻底删除过的消息（obs 墓碑）：照样删
  const sk = seedSetting(core);
  const p = seedPercept(core, { settingKey: sk, text: '删过的消息又回来了', ext: 'm-123' });
  await core.mods.admin.reapplyTombstones(core, { tombstones: [{ kind: 'obs', ref: 'zz:m-123', at: 1 }] });
  assert.equal(core.store.get('SELECT count(*) AS n FROM percepts WHERE id = ?', p).n, 0);
}));

test('applyTombstonesTo：在解开的备份副本上按墓碑删（backup 重写本地包用），不碰主库和向量', withCore('adm-apply-copy', async (core, t) => {
  const w = world(core);
  const copy = path.join(core.dataDir, 'copy.db');
  await sqliteBackup(core.store.raw, copy);
  await core.mods.admin.purge(core, [`a${w.a1}`], { by: 'owner', at: core.now() });
  const tombs = core.store.all('SELECT kind, ref, at FROM tombstones');
  const drops = t.of('worker.dropEmbeddings').length;
  const db = openDatabase({ file: copy, lock: false });
  try {
    assert.ok(db.get('SELECT 1 FROM assertions WHERE id = ?', w.a1));
    const r = core.mods.admin.applyTombstonesTo(core, db, tombs);
    assert.ok(r.deleted >= 1);
    assert.equal(db.get('SELECT count(*) AS n FROM assertions WHERE id = ?', w.a1).n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', 'assertion', w.a1).n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM tombstones').n, tombs.length);
  } finally { db.close(); }
  assert.equal(t.of('worker.dropEmbeddings').length, drops, '副本上不碰 worker');
}));

test('purge alsoBackups：再把墓碑交给 backup.scrubPacks 重写本地的包', withCore('adm-purge-scrub', async (core, t) => {
  const a = seedAssertion(core, { text: '要从备份里也清掉的' });
  await core.mods.admin.purge(core, [`a${a}`], { by: 'owner', alsoBackups: true, at: core.now() });
  const s = t.of('backup.scrubPacks')[0].args[0];
  assert.deepEqual(s.tombstones.map((x) => `${x.kind}:${x.ref}`), [`assertion:a${a}`]);
}));

test('withdrawBySource：某人在某段时间说的全部和由它们派生的 → 先对别人隐藏、进审核；驳回恢复原样；批准才彻底删除', withCore('adm-withdraw', async (core, t) => {
  const w = world(core);
  const t0 = core.store.get('SELECT at FROM percepts WHERE id = ?', w.p1).at;
  const outside = seedPercept(core, { settingKey: w.sk, actor: w.A, text: '很久以后说的', at: t0 + 10 * DAY });
  const r = core.mods.admin.withdrawBySource(core, { entityId: w.A, from: t0 - 1, to: t0 + DAY, by: 'owner', at: core.now() });
  assert.equal(r.refs, 2, '阿明这段时间说的两条');
  const item = core.mods.admin.listReview(core, { kind: 'withdraw' })[0];
  assert.equal(item.id, r.reviewId);
  assert.deepEqual(item.payload.refs, [`p${w.p1}`, `p${w.p2}`]);
  for (const ref of [`p${w.p1}`, `p${w.p2}`, `a${w.a1}`, `e${w.e1}`]) assert.equal(core.mods.admin.suppression(core, ref), 'hidden', `${ref} 审核期间先对别人隐藏`);
  assert.equal(core.mods.admin.suppression(core, `p${outside}`), null);
  assert.equal(core.mods.admin.suppression(core, `p${w.p3}`), null, '小红说的不动');
  // 驳回：恢复原样
  await core.mods.admin.decideReview(core, r.reviewId, 'reject');
  for (const ref of [`p${w.p1}`, `p${w.p2}`, `a${w.a1}`, `e${w.e1}`]) assert.equal(core.mods.admin.suppression(core, ref), null);
  // 再来一次，批准：彻底删除（含派生）
  const r2 = core.mods.admin.withdrawBySource(core, { entityId: w.A, from: t0 - 1, to: t0 + DAY, by: 'owner', at: core.now() });
  await core.mods.admin.decideReview(core, r2.reviewId, 'approve');
  for (const id of [w.p1, w.p2]) assert.equal(core.store.get('SELECT count(*) AS n FROM percepts WHERE id = ?', id).n, 0);
  assert.equal(core.store.get('SELECT count(*) AS n FROM assertions WHERE id = ?', w.a1).n, 0);
  assert.equal(core.store.get('SELECT count(*) AS n FROM episodes WHERE id = ?', w.e1).n, 0);
  assert.equal(core.store.get('SELECT needs_review FROM assertions WHERE id = ?', w.a2).needs_review, 1, '还有小红作证的事实留着，标复核');
  assert.ok(core.store.get('SELECT 1 FROM percepts WHERE id = ?', outside));
  assert.ok(t.of('backup.preOperationSnapshot').length >= 1, '按来源撤回之前也做操作前快照');
  assert.throws(() => core.mods.admin.withdrawBySource(core, { entityId: 0, from: 0, to: 1, by: 'owner', at: 1 }), ContractError);
  assert.throws(() => core.mods.admin.withdrawBySource(core, { entityId: w.A, from: 10, to: 1, by: 'owner', at: 1 }), ContractError);
}));

test('展开到不动为止：派生的几条证据全在这次删的范围里就一起删（按来源撤回同一个人的好几句话）；直接删一个原文窗口时窗口里的消息一起删', withCore('adm-fixpoint', async (core) => {
  const w = world(core);
  // 阿明前后两句话合起来才推出的一条：两句都撤回了，它就没有证据了
  const both = seedAssertion(core, { text: '阿明周末要带表哥去爬山', subjects: [w.A], speaker: w.A, perceptIds: [w.p1, w.p2], settingKey: w.sk });
  const t2 = Number(core.store.run(`INSERT INTO intentions(act, origin, formed_at, created_at, updated_at, sources_json) VALUES ('ask', 'self-care', ?, ?, ?, ?)`,
    core.now(), core.now(), core.now(), JSON.stringify([w.p1, w.p2])).lastInsertRowid);
  memoryRows(core, 'intention', t2);
  await core.mods.admin.purge(core, [`p${w.p1}`, `p${w.p2}`], { by: 'owner', at: core.now() });
  assert.equal(core.store.get('SELECT count(*) AS n FROM assertions WHERE id = ?', both).n, 0);
  assert.equal(core.store.get('SELECT count(*) AS n FROM intentions WHERE id = ?', t2).n, 0);
  assert.equal(core.store.get('SELECT needs_review FROM assertions WHERE id = ?', w.a2).needs_review, 1, '小红那句还在：留着，标复核');
  assert.ok(core.store.get('SELECT 1 FROM percepts WHERE id = ?', w.p3), '从感知删到窗口时，窗口里别人的消息不删');
  // 直接删一个窗口：窗口里的消息一起删
  const sk2 = seedSetting(core, { key: 'sk-win' });
  const q1 = seedPercept(core, { settingKey: sk2, text: '一段聊天的第一句', ext: 'w-1' });
  const q2 = seedPercept(core, { settingKey: sk2, text: '一段聊天的第二句', ext: 'w-2' });
  const win = seedWindow(core, { settingKey: sk2, perceptIds: [q1, q2] });
  const r = await core.mods.admin.purge(core, [`w${win}`], { by: 'owner', at: core.now() });
  assert.deepEqual(r.deleted, { window: 1, percept: 2 });
}));

test('intake 重新渲染不了窗口：退回整窗删除（宁可多删窗口，也不留删掉的原话），照样写墓碑', withCore('adm-purge-winfail', async (core, t) => {
  const w = world(core);
  const r = await core.mods.admin.purge(core, [`p${w.p1}`], { by: 'owner', at: core.now() });
  assert.equal(r.deleted.window, 1);
  assert.equal(core.store.get('SELECT count(*) AS n FROM raw_windows WHERE id = ?', w.w1).n, 0);
  assert.ok(core.store.get("SELECT 1 FROM tombstones WHERE kind = 'window' AND ref = ?", `w${w.w1}`));
  assert.ok(t.of('worker.dropEmbeddings').some((c) => c.args[0].includes(`w${w.w1}`) && c.args[1].every(Boolean)), '先删窗口的向量');
  assert.equal(core.store.get("SELECT value FROM metrics WHERE name = 'admin.purge.windowsFallback'")?.value ?? 1, 1);
  assert.ok(t.ports.logger.events('admin.purge-windows-fallback').length === 1);
}, { mods: { intake: { dropFromWindows: () => { throw new Error('intake down'); } } } }));

test('墓碑重删：主库上含被删感知的窗口交给 intake 重新渲染；备份副本上整窗删除', withCore('adm-reapply-win', async (core, t) => {
  const w = world(core);
  const copy = path.join(core.dataDir, 'copy-win.db');
  await sqliteBackup(core.store.raw, copy);
  const ext1 = core.store.get('SELECT ext_key FROM percepts WHERE id = ?', w.p1).ext_key;
  // 恢复旧包之后：那条消息（obs 墓碑）又回来了
  const tomb = [{ kind: 'obs', ref: `zz:${ext1}`, at: core.now() + 1 }];
  await core.mods.admin.reapplyTombstones(core, { tombstones: tomb });
  assert.deepEqual(t.of('intake.dropFromWindows').map((c) => c.args[0]), [[w.p1]]);
  assert.deepEqual(JSON.parse(core.store.get('SELECT members_json FROM raw_windows WHERE id = ?', w.w1).members_json), [w.p2, w.p3]);
  const db = openDatabase({ file: copy, lock: false });
  try {
    core.mods.admin.applyTombstonesTo(core, db, tomb);
    assert.equal(db.get('SELECT count(*) AS n FROM percepts WHERE id = ?', w.p1).n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM raw_windows WHERE id = ?', w.w1).n, 0, '副本上没有 intake：整窗删除');
  } finally { db.close(); }
  assert.equal(t.of('intake.dropFromWindows').length, 1, '副本上不碰 intake');
}));

test('withdrawBySource：审核期间含这些消息的原文窗口、小结也对别人隐藏（隐藏的级联），驳回一起恢复', withCore('adm-withdraw-win', async (core) => {
  const w = world(core);
  const sum = seedEpisode(core, { settingKey: w.sk, kind: 'summary', narrative: '阿明说表哥开网约车', perceptIds: [w.p1, w.p3] });
  const t0 = core.store.get('SELECT at FROM percepts WHERE id = ?', w.p1).at;
  const r = core.mods.admin.withdrawBySource(core, { entityId: w.A, from: t0 - 1, to: t0 + DAY, by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `w${w.w1}`), 'hidden');
  assert.equal(core.mods.admin.suppression(core, `e${sum}`), 'hidden');
  assert.equal(core.mods.admin.suppression(core, `p${w.p3}`), null, '小红说的不动');
  await core.mods.admin.decideReview(core, r.reviewId, 'reject');
  for (const ref of [`w${w.w1}`, `e${sum}`, `p${w.p1}`]) assert.equal(core.mods.admin.suppression(core, ref), null);
}));

test('intake 删掉了一条成员都不剩的窗口：窗口身上挂的规范、谁知道、痕迹、激活、隐藏由 admin 清掉并写墓碑；重新渲染的窗口不动', withCore('adm-purge-win-gone', async (core, t) => {
  const w = world(core);
  const sk2 = seedSetting(core, { key: 'sk-solo' });
  const solo = seedPercept(core, { settingKey: sk2, text: '只有这一句', ext: 's-1' });
  const ws = seedWindow(core, { settingKey: sk2, perceptIds: [solo] });
  core.mods.admin.suppress(core, `w${ws}`, { state: 'hidden', by: 'owner', at: core.now() });
  const r = await core.mods.admin.purge(core, [`p${solo}`, `p${w.p1}`], { by: 'owner', at: core.now() });
  assert.equal(r.deleted.window, 1, '一条不剩的那个窗口算删掉的');
  assert.equal(core.store.get('SELECT count(*) AS n FROM raw_windows WHERE id = ?', ws).n, 0);
  assert.deepEqual(leftovers(core, 'window', ws), NONE_LEFT, '窗口身上挂的行都清了');
  assert.equal(core.store.get("SELECT count(*) AS n FROM suppressions WHERE owner_kind = 'window' AND owner_id = ?", ws).n, 0);
  assert.ok(core.store.get("SELECT 1 FROM tombstones WHERE kind = 'window' AND ref = ?", `w${ws}`), '写墓碑');
  assert.ok(core.store.get('SELECT 1 FROM raw_windows WHERE id = ?', w.w1), '重新渲染的窗口还在');
  assert.notDeepEqual(leftovers(core, 'window', w.w1), NONE_LEFT, '重新渲染的窗口身上的行不动');
  assert.equal(core.store.get("SELECT count(*) AS n FROM tombstones WHERE kind = 'window' AND ref = ?", `w${w.w1}`).n, 0);
  // 重跑（中途崩溃后接着做）：已经不在的窗口再清一遍也一样，不会多删
  const again = await core.mods.admin.reapplyTombstones(core);
  assert.equal(again.deleted, 0);
}));

test('来源被彻底删除之后的级联隐藏：重新渲染过、不再含删掉消息的窗口放开；还复述着删掉内容的小结留着隐藏，原因改成 purged:<ref>', withCore('adm-purge-settle', async (core, t) => {
  const w = world(core);
  const sum = seedEpisode(core, { settingKey: w.sk, kind: 'summary', narrative: '阿明约大家爬山', perceptIds: [w.p2, w.p3] });
  // 按来源撤回阿明那两句：审核期间窗口跟着隐藏；批准之后窗口去掉了阿明的话（只剩小红的），放开
  const t0 = core.store.get('SELECT at FROM percepts WHERE id = ?', w.p1).at;
  const r = core.mods.admin.withdrawBySource(core, { entityId: w.A, from: t0 - 1, to: t0 + DAY, by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `w${w.w1}`), 'hidden');
  await core.mods.admin.decideReview(core, r.reviewId, 'approve');
  assert.deepEqual(JSON.parse(core.store.get('SELECT members_json FROM raw_windows WHERE id = ?', w.w1).members_json), [w.p3]);
  assert.equal(core.mods.admin.suppression(core, `w${w.w1}`), null, '窗口里已经没有删掉的话了');
  assert.equal(core.store.get('SELECT count(*) AS n FROM episodes WHERE id = ?', sum).n, 0, '以删掉的消息为来源的小结一起删了');
  // 隐藏一段经历 → 小结跟着；彻底删除那段经历：小结还复述着它，留着隐藏
  t.ports.clock.advance(1000);   // 新写的行可能拿到刚删掉的 id：墓碑按时间生效，同一毫秒的算删掉的（D42）
  const p4 = seedPercept(core, { settingKey: w.sk, actor: w.B, text: '下周我要出差', ext: 'm-4' });
  const ev = seedEpisode(core, { settingKey: w.sk, narrative: '小红说下周出差', perceptIds: [p4] });
  const sum2 = seedEpisode(core, { settingKey: w.sk, kind: 'summary', narrative: '小红要出差', perceptIds: [p4] });
  core.mods.admin.suppress(core, `e${ev}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.store.get("SELECT reason FROM suppressions WHERE owner_kind = 'episode' AND owner_id = ?", sum2).reason, `cascade:e${ev}`);
  await core.mods.admin.purge(core, [`e${ev}`], { by: 'owner', at: core.now() });
  assert.deepEqual({ ...core.store.get("SELECT state, by, reason FROM suppressions WHERE owner_kind = 'episode' AND owner_id = ?", sum2) },
    { state: 'hidden', by: 'system', reason: `purged:e${ev}` });
  core.mods.admin.restore(core, `e${sum2}`, { by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${sum2}`), null, '主人可以自己放开');
}));

test('purge 和真的 intake.dropFromWindows 一起跑：窗口去掉删掉的那条、重新渲染并重新排嵌入', async () => {
  const intake = await import('../../src/intake/index.js');
  const t = await adminCore('adm-purge-real-intake', { mods: { intake: { dropFromWindows: intake.dropFromWindows } } });
  try {
    const { core } = t;
    const w = world(core);
    await core.mods.admin.purge(core, [`p${w.p2}`], { by: 'owner', at: core.now() });
    const win = core.store.get('SELECT members_json, text, n_percepts FROM raw_windows WHERE id = ?', w.w1);
    assert.deepEqual(JSON.parse(win.members_json), [w.p1, w.p3]);
    assert.equal(win.n_percepts, 2);
    assert.ok(!win.text.includes('周末一起去爬山吧') && win.text.includes('我也去爬山'), '删掉的原话不在，别人的话还在');
    assert.ok(core.store.get("SELECT 1 FROM embed_texts WHERE owner_kind = 'window' AND owner_id = ?", w.w1), '重新排了嵌入');
  } finally { await t.cleanup(); }
});

test('purge 的级联（D122）：事实被删 → 它的核对记录（核对它的、改出它的）一起删；感知被删 → 引用了它的核对记录删（理由可能转述了它）', withCore('adm-purge-checks', async (core) => {
  const w = world(core);
  const ins = (aid, rid, ev) => core.store.run(`INSERT INTO memory_checks(assertion_id, at, verdict, result_id, evidence_json, why, streak, next_at)
      VALUES (?, ?, ?, ?, ?, '理由', 0, ?)`, aid, core.now(), rid ? 'corrected' : 'confirmed', rid, JSON.stringify(ev), core.now() + DAY);
  ins(w.a2, null, [w.p2]);
  ins(w.a3, w.a2, [w.p3]);
  ins(w.a1, null, [w.p3]);
  await core.mods.admin.purge(core, [`a${w.a2}`], { by: 'owner', at: core.now() });
  assert.deepEqual(core.store.all('SELECT assertion_id FROM memory_checks ORDER BY id').map((r) => r.assertion_id), [w.a1], '核对 a2 的、改出 a2 的都删了');
  await core.mods.admin.purge(core, [`p${w.p3}`], { by: 'owner', at: core.now() });
  assert.equal(core.store.get('SELECT count(*) AS n FROM memory_checks').n, 0, '引用了被删感知的那条也删了');
}));

test('purge 的级联（D122 评审）：只是给模型看过（没引用）的感知被删，那一行也删；按旧版本恢复出的那一版被删，那一行也删', withCore('adm-purge-checks-shown', async (core) => {
  const w = world(core);
  core.store.run(`INSERT INTO memory_checks(assertion_id, at, verdict, evidence_json, shown_json, streak) VALUES (?, ?, 'unclear', '[]', ?, 0)`, w.a1, core.now(), JSON.stringify([w.p2]));
  core.store.run(`INSERT INTO memory_checks(assertion_id, at, verdict, evidence_json, shown_json, streak, restored_id) VALUES (?, ?, 'corrected', '[]', '[]', 0, ?)`, w.a1, core.now(), w.a3);
  await core.mods.admin.purge(core, [`p${w.p2}`], { by: 'owner', at: core.now() });
  assert.equal(core.store.get('SELECT count(*) AS n FROM memory_checks WHERE shown_json <> \'[]\'').n, 0);
  await core.mods.admin.purge(core, [`a${w.a3}`], { by: 'owner', at: core.now() });
  assert.equal(core.store.get('SELECT count(*) AS n FROM memory_checks').n, 0);
}));
