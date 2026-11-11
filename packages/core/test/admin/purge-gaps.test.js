// 彻底删除漏掉的地方（D143）：社区小结（当前的、退休的、跨场合的）、成长块（当前文本和全部历史版本）、成长的审核项、
// 「连备份一起删」的结果、旧结构的备份副本（迁移 014 之前没有 glances.follows）、删完以后库文件（含 WAL）里搜不到那句话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { openDatabase } from '../../src/store/index.js';
import {
  adminCore, seedSetting, seedEntity, seedPercept, seedWindow, seedAssertion, seedEpisode, memoryRows,
} from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};
const n = (core, sql, ...p) => Number(core.store.get(sql, ...p).n);

function seedCommunity(core, { settingKey = null, members, summary, current = 1 }) {
  const id = Number(core.store.run('INSERT INTO communities(setting_key, label, summary, members_json, built_at, is_current) VALUES (?, ?, ?, ?, ?, ?)',
    settingKey, '一组人', summary, JSON.stringify(members), core.now(), current).lastInsertRowid);
  memoryRows(core, 'community', id, { settingKey: settingKey ?? 'sk-x' });
  return id;
}
const communityIds = (core) => core.store.all('SELECT id FROM communities ORDER BY id').map((r) => r.id);

test('社区：直接删一条事实，事实涉及的人所在的社区都删（当前的、退休的、跨场合的），别人的不动；删向量、写墓碑', withCore('d143-comm-a', async (core, t) => {
  const sk = seedSetting(core, { key: 'sk-c1' });
  const A = seedEntity(core, { name: '甲某' });
  const B = seedEntity(core, { name: '乙某' });
  const C = seedEntity(core, { name: '丙某' });
  const D = seedEntity(core, { name: '丁某' });
  const a = seedAssertion(core, { text: '甲某和乙某在合伙开店', subjects: [A], mentions: [B], settingKey: sk });
  const cur = seedCommunity(core, { settingKey: sk, members: [A, C], summary: '甲某他们在合伙开店' });
  const retired = seedCommunity(core, { settingKey: sk, members: [A, C], summary: '甲某他们最近在开店', current: 0 });
  const cross = seedCommunity(core, { members: [B, D], summary: '乙某在帮忙开店' });
  const other = seedCommunity(core, { settingKey: sk, members: [C, D], summary: '丙某和丁某在打球' });
  const r = await core.mods.admin.purge(core, [`a${a}`], { by: 'owner', at: core.now() });
  assert.equal(r.deleted.community, 3);
  assert.deepEqual(communityIds(core), [other]);
  const dropped = t.of('worker.dropEmbeddings')[0].args[0];
  for (const id of [cur, retired, cross]) {
    assert.ok(dropped.includes(`c${id}`), '先删向量');
    assert.ok(core.store.get("SELECT 1 FROM tombstones WHERE kind = 'community' AND ref = ?", `c${id}`));
    assert.equal(n(core, "SELECT count(*) AS n FROM flow_norms WHERE owner_kind = 'community' AND owner_id = ?", id), 0);
  }
}));

test('社区：删一段经历，这个场合的社区（退休的也算）和参与者所在的跨场合社区一起删；删一个人，他在的社区都删', withCore('d143-comm-e', async (core) => {
  const sk = seedSetting(core, { key: 'sk-c2' });
  const sk2 = seedSetting(core, { key: 'sk-c3' });
  const A = seedEntity(core, { name: '甲某' });
  const B = seedEntity(core, { name: '乙某' });
  const C = seedEntity(core, { name: '丙某' });
  const e = seedEpisode(core, { settingKey: sk, narrative: '甲某说起他要搬家', participants: [A] });
  const retired = seedCommunity(core, { settingKey: sk, members: [B, C], summary: '这个群在聊搬家', current: 0 });
  const cross = seedCommunity(core, { members: [A, B], summary: '甲某要搬家' });
  const elsewhere = seedCommunity(core, { settingKey: sk2, members: [C, B], summary: '丙某在别的群聊天' });
  const r = await core.mods.admin.purge(core, [`e${e}`], { by: 'owner', at: core.now() });
  assert.equal(r.deleted.community, 2);
  assert.ok(!communityIds(core).includes(retired) && !communityIds(core).includes(cross));
  assert.deepEqual(communityIds(core), [elsewhere]);
  // 删一个人：当前、退休、哪个场合的都删
  const c2 = seedCommunity(core, { settingKey: sk2, members: [B, C], summary: '乙某和丙某', current: 0 });
  const r2 = await core.mods.admin.purge(core, [`n${C}`], { by: 'owner', at: core.now() });
  assert.equal(r2.deleted.community, 2, `${elsewhere} 和 ${c2}`);
  assert.deepEqual(communityIds(core), []);
}));

// ── 成长块 ──────────────────────────────────────────────────────────────

function seedGrowth(core, versions) {
  let text = '';
  versions.forEach((v, i) => {
    text = v.text;
    core.store.run(`INSERT INTO core_block_versions(name, version, text, change_json, evidence_ids, created_at, created_by, revoked_at)
                    VALUES ('growth', ?, ?, ?, ?, ?, ?, ?)`, i + 1, v.text, JSON.stringify(v.change), JSON.stringify(v.evidence ?? []), v.at ?? core.now(), v.by ?? 'sleep', v.revokedAt ?? null);
  });
  core.store.run(`INSERT INTO core_blocks(name, text, version, char_limit, updated_at, updated_by, pending_text) VALUES ('growth', ?, ?, 600, ?, 'sleep', ?)
                  ON CONFLICT(name) DO UPDATE SET text = excluded.text, version = excluded.version`, text, versions.length, core.now(), null);
}
const growthDump = (core) => JSON.stringify([core.store.all('SELECT * FROM core_blocks'), core.store.all('SELECT * FROM core_block_versions'), core.store.all('SELECT * FROM review_queue')]);

test('成长块：依据里有被删事实的行从当前文本和全部历史版本里抹掉，改写过的那一行跟着去；留一版「因为彻底删除去掉了几行」，不留文字；撤销、回滚回不来', withCore('d143-growth', async (core, t) => {
  const keep1 = seedAssertion(core, { text: '她说过喜欢早起' });
  const keep2 = seedAssertion(core, { text: '她说过爱喝茶' });
  const gone = seedAssertion(core, { text: '她说过怕黑的秘密' });
  const L1 = '我其实挺怕黑';
  const L1b = '我怕黑，但在慢慢好起来';
  const L2 = '我喜欢早起喝茶';
  seedGrowth(core, [
    { text: L1, change: { op: 'add', before: null, after: L1, signature: 'add:x' }, evidence: [`a${gone}`, `a${keep1}`] },
    { text: `${L1}\n${L2}`, change: { op: 'add', before: null, after: L2, signature: 'add:y' }, evidence: [`a${keep1}`, `a${keep2}`] },
    // 改写那一行：这一版的依据里没有被删的，但改写的是由被删内容写出来的那一行
    { text: `${L1b}\n${L2}`, change: { op: 'revise', before: L1, after: L1b, signature: 'revise:z' }, evidence: [`a${keep2}`] },
  ]);
  const rq = core.mods.admin.enqueueReview(core, { kind: 'growth', payload: { name: 'growth', baseVersion: 3, change: { op: 'add', before: null, after: '我怕黑所以开着灯睡', signature: 's' }, evidenceRefs: [`a${gone}`] }, reason: 'growth-proposal' });
  const rqKeep = core.mods.admin.enqueueReview(core, { kind: 'growth', payload: { name: 'growth', baseVersion: 3, change: { op: 'add', before: null, after: '我爱早起', signature: 's2' }, evidenceRefs: [`a${keep1}`] }, reason: 'growth-proposal' });
  const dirty = t.of('context.markResidentDirty').length;
  const r = await core.mods.admin.purge(core, [`a${gone}`], { by: 'owner', at: core.now() });
  assert.deepEqual(r.growth, { lines: 1, versions: 3, unknown: 0 });
  const cur = core.mods.consolidate.growthBlock(core);
  assert.deepEqual(cur, { text: L2, version: 4 });
  const vs = core.mods.consolidate.growthVersions(core);
  assert.deepEqual(vs.map((v) => v.text), ['', L2, L2, L2]);
  assert.deepEqual({ ...vs[3].change }, { op: 'purge', removed: 1, before: null, after: null, signature: 'purge:4' }, '只记去掉了几行');
  assert.equal(vs[3].createdBy, 'owner');
  assert.equal(vs[0].change.after, null);
  assert.equal(vs[0].change.purged, true);
  assert.equal(vs[2].change.before, null);
  assert.equal(vs[1].change.after, L2, '别的变化不动');
  assert.ok(!growthDump(core).includes('怕黑'), '成长块、历史版本、审核项里都没有被删内容写出来的话');
  assert.ok(t.of('context.markResidentDirty').length > dirty, '常驻区标脏');
  // 审核项：依据里有被删的那条撤下、抹掉文字；别的不动
  const it = core.store.get('SELECT status, decided_by FROM review_queue WHERE id = ?', rq);
  assert.deepEqual({ ...it }, { status: 'withdrawn', decided_by: 'purge' });
  assert.equal(core.store.get('SELECT status FROM review_queue WHERE id = ?', rqKeep).status, 'pending');
  // 撤销最新一版、回到任何一版：都回不来
  core.mods.consolidate.revokeGrowth(core, 4, { by: 'owner', at: core.now() });
  assert.ok(!core.mods.consolidate.growthBlock(core).text.includes('怕黑'));
  core.mods.consolidate.rollbackGrowth(core, 1, { by: 'owner', at: core.now() });
  assert.equal(core.mods.consolidate.growthBlock(core).text, '');
  core.mods.consolidate.rollbackGrowth(core, 0, { by: 'owner', at: core.now() });
  assert.ok(!growthDump(core).includes('怕黑'));
  // 再跑一遍墓碑重删：不再有变化
  assert.equal((await core.mods.admin.reapplyTombstones(core)).deleted, 0);
}));

test('成长块：删一个人、删一段经历也走到；判断不了来历的行（整块替换写进来的）不去掉、只报行数；墓碑之后才写的依据不算', withCore('d143-growth-paths', async (core) => {
  const A = seedEntity(core, { name: '甲某' });
  const sk = seedSetting(core, { key: 'sk-g' });
  const aboutA = seedAssertion(core, { text: '甲某教她下棋', subjects: [A], settingKey: sk });
  const e = seedEpisode(core, { settingKey: sk, narrative: '她和甲某下了一下午棋', participants: [A] });
  const LA = '我开始喜欢下棋';
  const LE = '下午安静的时候我会想起棋盘';
  const LU = '我说话变直了';
  seedGrowth(core, [
    { text: LA, change: { op: 'add', before: null, after: LA }, evidence: [`a${aboutA}`] },
    { text: `${LA}\n${LE}`, change: { op: 'add', before: null, after: LE }, evidence: [`e${e}`] },
    { text: `${LA}\n${LE}\n${LU}`, change: { op: 'replace', before: null, after: null, signature: 'replace:q' }, evidence: [], by: 'owner' },
  ]);
  // 删人：只关于他的事实一起删 → 那一行去掉；判断不了来历的那一行留着（多半是主人自己写的），报给主人 1 行
  const r1 = await core.mods.admin.purge(core, [`n${A}`], { by: 'owner', at: core.now() });
  assert.equal(core.mods.consolidate.growthBlock(core).text, `${LE}
${LU}`);
  assert.equal(r1.growth.unknown, 1);
  // 删经历
  await core.mods.admin.purge(core, [`e${e}`], { by: 'owner', at: core.now() });
  assert.equal(core.mods.consolidate.growthBlock(core).text, LU);
  assert.ok(!growthDump(core).includes('下棋') && !growthDump(core).includes('棋盘') && growthDump(core).includes('变直'));
  // 墓碑按时间生效：恢复之后同一个 id 的新事实写出来的行不算被删的内容
  const at0 = core.now();
  const tombAt = core.store.get("SELECT at FROM tombstones WHERE kind = 'assertion' AND ref = ?", `a${aboutA}`).at;
  assert.ok(tombAt <= at0);
  const v = core.mods.consolidate.growthBlock(core).version;
  core.store.run(`INSERT INTO core_block_versions(name, version, text, change_json, evidence_ids, created_at, created_by) VALUES ('growth', ?, '我会等别人说完', ?, ?, ?, 'sleep')`,
    v + 1, JSON.stringify({ op: 'add', before: null, after: '我会等别人说完' }), JSON.stringify([`a${aboutA}`]), at0 + 1000);
  core.store.run("UPDATE core_blocks SET text = '我会等别人说完', version = ? WHERE name = 'growth'", v + 1);
  await core.mods.admin.reapplyTombstones(core);
  assert.equal(core.mods.consolidate.growthBlock(core).text, '我会等别人说完', '墓碑之后才写的依据指向新的行');
}));

test('成长块：D143 之前的彻底删除留在成长块里的行，下次启动按墓碑清掉（没有要删的行也清）', withCore('d143-growth-old', async (core) => {
  const a = seedAssertion(core, { text: '一件以前删掉的事' });
  core.store.run('DELETE FROM assertions WHERE id = ?', a);
  core.store.run("INSERT INTO tombstones(kind, ref, at) VALUES ('assertion', ?, ?)", `a${a}`, core.now() + 10);
  seedGrowth(core, [{ text: '我记得那件旧事', change: { op: 'add', before: null, after: '我记得那件旧事' }, evidence: [`a${a}`] }]);
  const r = await core.mods.admin.reapplyTombstones(core);
  assert.ok(r.deleted >= 1);
  assert.equal(core.mods.consolidate.growthBlock(core).text, '');
  assert.ok(!growthDump(core).includes('旧事'));
}));

// ── 备份包的结果 ─────────────────────────────────────────────────────────

test('连备份一起删：改写了几个、几个没改成（原因）带回去；scrubPacks 整个失败也算没改成，不当成功', async () => {
  const fails = await adminCore('d143-scrub-res', { mods: { backup: { scrubPacks: async () => ({ rewritten: 2, failed: 1, skipped: 1, failures: [{ id: 9, reason: 'no-key' }] }) } } });
  try {
    const { core } = fails;
    const a = seedAssertion(core, { text: '要从备份里清掉的' });
    const r = await core.mods.admin.purge(core, [`a${a}`], { by: 'owner', alsoBackups: true, at: core.now() });
    assert.deepEqual(r.backups, { rewritten: 2, unchanged: 1, failed: 1, failures: [{ id: 9, reason: 'no-key' }] });
    assert.equal(fails.ports.logger.events('admin.purge-backups-incomplete').length, 1);
    const b = seedAssertion(core, { text: '不勾备份' });
    assert.equal((await core.mods.admin.purge(core, [`a${b}`], { by: 'owner', at: core.now() })).backups, undefined);
  } finally { await fails.cleanup(); }
  const boom = await adminCore('d143-scrub-boom', { mods: { backup: { scrubPacks: async () => { const e = new Error('x'); e.code = 'EBUSY'; throw e; } } } });
  try {
    const a = seedAssertion(boom.core, { text: '要从备份里清掉的' });
    const r = await boom.core.mods.admin.purge(boom.core, [`a${a}`], { by: 'owner', alsoBackups: true, at: boom.core.now() });
    assert.deepEqual(r.backups, { rewritten: 0, unchanged: 0, failed: 1, failures: [{ id: null, reason: 'EBUSY' }] });
  } finally { await boom.cleanup(); }
});

// ── 旧结构的备份副本 ──────────────────────────────────────────────────────

test('迁移 013 之后、014 之前的备份副本（glances 还没有 follows 列）：按墓碑删感知不抛错', withCore('d143-old-glances', async (core) => {
  const sk = seedSetting(core);
  const p = seedPercept(core, { settingKey: sk, text: '旧包里的一句话' });
  core.store.run("INSERT INTO glances(percept_id, setting_key, state, created_at) VALUES (?, ?, 'done', ?)", p, sk, core.now());
  const copy = path.join(core.dataDir, 'old-013.db');
  await sqliteBackup(core.store.raw, copy);
  const db = openDatabase({ file: copy, lock: false });
  try {
    db.exec('ALTER TABLE glances DROP COLUMN follows');
    db.exec('PRAGMA user_version = 13');
    const r = core.mods.admin.applyTombstonesTo(core, db, [{ kind: 'percept', ref: `p${p}`, at: core.now() + 1 }]);
    assert.ok(r.deleted >= 1);
    assert.equal(db.get('SELECT count(*) AS n FROM percepts WHERE id = ?', p).n, 0);
    assert.equal(db.get('SELECT count(*) AS n FROM glances WHERE percept_id = ?', p).n, 0);
  } finally { db.close(); }
}));

// ── 物理上不在了 ─────────────────────────────────────────────────────────

test('删完以后库文件（含 WAL）的字节里搜不到被删的那句话；全文索引开了 secure-delete；WAL 截断；回想用的视图照常', withCore('d143-bytes', async (core) => {
  const word = 'zqxwvplughsecret';
  const sk = seedSetting(core, { key: 'sk-bytes' });
  const A = seedEntity(core, { name: '甲某' });
  // 先有一批别的内容（让删掉的那句落在中间的页里）
  for (let i = 0; i < 30; i++) seedPercept(core, { settingKey: sk, actor: A, text: `平常的第 ${i} 句话 filler${i}` });
  const p = seedPercept(core, { settingKey: sk, actor: A, text: `这是要删的那句 ${word} 别留下`, ext: 'b-1' });
  const q = seedPercept(core, { settingKey: sk, actor: A, text: '后面还有一句 keepme' });
  seedWindow(core, { settingKey: sk, perceptIds: [p, q], text: `这是要删的那句 ${word} 别留下 / 后面还有一句 keepme` });
  const a = seedAssertion(core, { text: `甲某说了 ${word}`, subjects: [A], speaker: A, perceptIds: [p], settingKey: sk });
  core.store.run("UPDATE embed_texts SET text = ? WHERE owner_kind = 'assertion' AND owner_id = ?", `甲某说了 ${word}`, a);
  const files = () => [core.store.file, `${core.store.file}-wal`].filter((f) => fs.existsSync(f));
  const has = () => files().some((f) => fs.readFileSync(f).includes(Buffer.from(word)));
  core.store.checkpoint('PASSIVE');
  assert.ok(has(), '删之前文件里有（测试本身有效）');
  for (const t of ['episodes_fts', 'assertions_fts', core.store.get('SELECT fts_shard FROM percepts WHERE id = ?', p).fts_shard]) {
    assert.equal(Number(core.store.get(`SELECT v FROM ${t}_config WHERE k = 'secure-delete'`)?.v), 1, `${t} 开了 secure-delete`);
  }
  assert.equal(Number(core.store.pragma('secure_delete')), 2, '平时 FAST');
  const r = await core.mods.admin.purge(core, [`p${p}`], { by: 'owner', at: core.now() });
  assert.equal(r.deleted.percept, 1);
  assert.equal(r.deleted.assertion, 1);
  assert.equal(r.wal.main, 'truncated');
  assert.equal(Number(core.store.pragma('secure_delete')), 2, '删完设回 FAST');
  assert.equal(fs.existsSync(`${core.store.file}-wal`) ? fs.statSync(`${core.store.file}-wal`).size : 0, 0, 'WAL 截成 0 字节');
  assert.ok(!has(), '主库和 WAL 的字节里都没有那句话');
  // 视图照常：列表、详情、全文检索里别的内容还找得到
  const list = core.mods.admin.list(core, { view: 'percepts' });
  assert.ok(list.items.length >= 1 && !list.items.some((x) => x.ref === `p${p}`));
  assert.ok(core.mods.admin.list(core, { view: 'tombstones' }).items.length >= 1);
  assert.ok(core.mods.admin.get(core, `p${q}`));
  assert.equal(core.mods.admin.get(core, `p${p}`).purged, true);
  const shard = core.store.get('SELECT fts_shard FROM percepts WHERE id = ?', q).fts_shard;
  assert.equal(n(core, `SELECT count(*) AS n FROM ${shard} WHERE ${shard} MATCH 'keepme'`), 1);
  assert.equal(n(core, `SELECT count(*) AS n FROM ${shard} WHERE ${shard} MATCH 'filler7'`), 1);
}));
