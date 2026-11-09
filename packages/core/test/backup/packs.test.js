// 做包、验证、轮转、重新扫描、夜间排程、恢复演练、操作前快照（§12.4.1–§12.4.4、§12.5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackupCore, quietMods, seedSetting, seedEntity, seedPercept, seedAssertion, seedEpisode } from './harness.js';
import { openDatabase, migrate, MIGRATIONS, openStore } from '../../src/store/index.js';
import { readPackHeader } from '../../src/backup/format.js';
import { DAY, HOUR } from '../fakes/index.js';
import { tmpDir, rmDir } from '../helpers.js';

const FAST = { backup: { scrypt: { N: 1024, r: 8, p: 1 } } };
const run = (name, fn, opt = {}) => async () => {
  const h = await createBackupCore({ name, mods: quietMods(opt.mods ?? {}), config: { ...FAST, ...(opt.config ?? {}) } });
  try { await fn(h.core, h); } finally { await h.cleanup(); }
};
function seed(core) {
  const sk = seedSetting(core);
  const a = seedEntity(core, { name: '阿明' });
  const p1 = seedPercept(core, { settingKey: sk, actor: a, text: '我表哥开网约车' });
  const p2 = seedPercept(core, { settingKey: sk, actor: a, text: '周末一起去爬山吧' });
  seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [a], speaker: a, perceptId: p1, settingKey: sk });
  seedEpisode(core, { settingKey: sk, narrative: '阿明约大家周末爬山', participants: [a], perceptIds: [p2] });
  return { sk, a, p1, p2 };
}

test('createPack：本机一份，写完验证通过并登记；manifest 有 schema 版本、条数、身份密钥、配置；文件名没有人名', run('bk-create', async (core) => {
  seed(core);
  const [p] = await core.mods.backup.createPack(core, { kind: 'manual' });
  assert.equal(p.location, 'local');
  assert.equal(p.verified, true);
  assert.equal(p.encrypted, false);
  assert.ok(fs.existsSync(p.path));
  assert.match(path.basename(p.path), /^pm-manual-\d{8}T\d{6}Z-[0-9a-f]{6}\.pmpack$/);
  assert.ok(!path.basename(p.path).includes('阿明'));
  assert.ok(path.resolve(p.path).startsWith(path.resolve(core.dataDir, 'backup', 'manual')));
  const row = core.store.get('SELECT * FROM backups WHERE id = ?', p.id);
  assert.equal(row.verify_status, 'ok');
  assert.equal(row.sha256, p.sha256);
  const m = JSON.parse(row.manifest_json);
  assert.equal(m.schemaVersion, core.store.pragma('user_version'));
  assert.equal(m.counts.assertions, 1);
  assert.equal(m.counts.percepts, 2);
  assert.equal(m.identityKey.present, true);
  assert.equal(m.identityKey.wrapped, false, '没开加密时身份密钥原样放（本机包，和密钥文件同一个私有目录）');
  assert.deepEqual(m.files.map((f) => f.name), ['main.db', 'identity.json', 'config.json']);
  assert.ok(fs.existsSync(`${p.path}.verified.json`));
  const v = await core.mods.backup.verifyPack(core, p.path);
  assert.deepEqual(v, { ok: true, errors: [] });
}));

test('周包 / 月包：VACUUM INTO 压实，带向量库', run('bk-weekly', async (core) => {
  seed(core);
  const [p] = await core.mods.backup.createPack(core, { kind: 'weekly' });
  assert.equal(p.includesVectors, true);
  const m = await core.mods.backup.readManifest(core, p.path);
  assert.equal(m.compacted, true);
  assert.ok(m.files.some((f) => f.name === 'vectors.db'));
  assert.equal(p.verified, true);
}));

test('verifyPack：包被改过 → 不通过、标红（failed），登记的 sha256 对不上', run('bk-verify', async (core) => {
  seed(core);
  const [p] = await core.mods.backup.createPack(core, { kind: 'daily' });
  const buf = fs.readFileSync(p.path);
  buf[buf.length - 50] ^= 0x55;
  fs.writeFileSync(p.path, buf);
  const v = await core.mods.backup.verifyPack(core, p.path);
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes('sha256'));
  assert.equal(core.store.get('SELECT verify_status FROM backups WHERE id = ?', p.id).verify_status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(`${p.path}.verified.json`, 'utf8')).status, 'failed');
}));

test('异地目录：设了就再放一份加密的；没开加密（没有恢复码）就不往外放，并报警', async () => {
  const off = tmpDir('bk-offsite-dir');
  const h = await createBackupCore({ name: 'bk-offsite', mods: quietMods(), config: { backup: { ...FAST.backup, offsiteDir: off } } });
  try {
    const { core } = h;
    seed(core);
    const first = await core.mods.backup.createPack(core, { kind: 'daily' });
    assert.equal(first.length, 1, '没有备份密钥 → 只有本机一份');
    assert.ok(h.ports.logger.events('backup.offsite-no-key').length >= 1);
    const { recoveryCode, keyId } = await core.mods.backup.setupEncryption(core);
    assert.ok(recoveryCode && keyId);
    const packs = await core.mods.backup.createPack(core, { kind: 'daily' });
    assert.equal(packs.length, 2);
    const offPack = packs.find((p) => p.location === 'offsite');
    assert.equal(offPack.encrypted, true);
    assert.equal(offPack.verified, true);
    assert.ok(path.resolve(offPack.path).startsWith(path.resolve(off)));
    const { header } = await readPackHeader(offPack.path);
    assert.equal(header.encrypted, true);
    assert.equal(header.enc.keyId, keyId);
    assert.ok(!fs.readFileSync(offPack.path).includes(Buffer.from('网约车')), '异地副本是密文');
    const m = await core.mods.backup.readManifest(core, packs[0].path);
    assert.equal(m.identityKey.wrapped, true, '有了备份密钥之后，包里的身份密钥单独包一层');
    assert.equal(core.mods.backup.overview(core).offsite.encrypted, true);
    h.ports.logger.assertNoText(recoveryCode, '网约车', '阿明');
  } finally { await h.cleanup(); rmDir(off); }
});

test('rotate：每种只留最近 N 份验证通过的；验证不过的不删也不算数；手动的不删', run('bk-rotate', async (core, h) => {
  seed(core);
  const clock = h.ports.clock;
  const made = [];
  for (let i = 0; i < 4; i++) { made.push((await core.mods.backup.createPack(core, { kind: 'daily' }))[0]); clock.advance(HOUR); }
  const [manual] = await core.mods.backup.createPack(core, { kind: 'manual' });
  // 最新的那份坏了：它不算进 2 份里，也不被删
  core.store.run("UPDATE backups SET verify_status = 'failed' WHERE id = ?", made[3].id);
  core.config.update({ backup: { retention: { daily: 2 } } });
  const r = await core.mods.backup.rotate(core);
  assert.equal(r.deleted, 1);
  assert.ok(!fs.existsSync(made[0].path), '最旧的好包删了');
  for (const p of made.slice(1)) assert.ok(fs.existsSync(p.path));
  assert.ok(fs.existsSync(manual.path));
  assert.ok(core.store.get('SELECT deleted_at FROM backups WHERE id = ?', made[0].id).deleted_at);
}));

test('rotate：磁盘快满了 → 先删最旧的日包并报警，留下最新的一份；月包和操作前快照不因此删', run('bk-lowdisk', async (core, h) => {
  seed(core);
  const d1 = (await core.mods.backup.createPack(core, { kind: 'daily' }))[0];
  h.ports.clock.advance(HOUR);
  const d2 = (await core.mods.backup.createPack(core, { kind: 'daily' }))[0];
  const m1 = (await core.mods.backup.createPack(core, { kind: 'monthly' }))[0];
  const pre = await core.mods.backup.preOperationSnapshot(core, { reason: 'purge' });
  core.config.update({ backup: { lowDiskGb: 1e9 } });
  const r = await core.mods.backup.rotate(core);
  assert.equal(r.lowDisk, true);
  assert.ok(!fs.existsSync(d1.path));
  assert.ok(fs.existsSync(d2.path), '最新的日包留着');
  assert.ok(fs.existsSync(m1.path) && fs.existsSync(pre));
  assert.ok(h.ports.logger.events('backup.low-disk').length >= 1);
}));

test('rescan：backups 表丢了（恢复后被换回旧的）也能按目录重建，验证结果从旁边的文件读回', run('bk-rescan', async (core) => {
  seed(core);
  const a = (await core.mods.backup.createPack(core, { kind: 'daily' }))[0];
  const b = (await core.mods.backup.createPack(core, { kind: 'monthly' }))[0];
  core.store.run('DELETE FROM backups');
  const r = await core.mods.backup.rescan(core);
  assert.equal(r.found, 2);
  const rows = core.store.all('SELECT path, kind, verify_status, sha256, manifest_json FROM backups WHERE deleted_at IS NULL ORDER BY kind');
  assert.deepEqual(rows.map((x) => x.kind), ['daily', 'monthly']);
  assert.ok(rows.every((x) => x.verify_status === 'ok' && x.sha256 && x.manifest_json));
  fs.rmSync(a.path);
  await core.mods.backup.rescan(core);
  assert.equal(core.store.get('SELECT count(*) AS n FROM backups WHERE deleted_at IS NULL').n, 1);
  assert.ok(fs.existsSync(b.path));
}));

test('runScheduled：第一晚日包 + 周包 + 月包，轮转，第一次恢复演练；第二晚只有日包；周日有周包；每月 1 日有月包和导出', run('bk-sched', async (core, h) => {
  seed(core);
  const clock = h.ports.clock;
  core.config.update({ time: { tzOffsetMin: 480 } });
  clock.set(Date.UTC(2026, 10, 1, 20, 30));   // 本地 11-02（周一）04:30
  let made = await core.mods.backup.runScheduled(core, { at: core.now() });
  assert.deepEqual(made.map((p) => p.kind).sort(), ['daily', 'monthly', 'weekly']);
  assert.equal(core.store.get('SELECT count(*) AS n FROM restore_drills').n, 1);
  assert.equal(core.store.get('SELECT status FROM restore_drills').status, 'ok');
  assert.ok(fs.readdirSync(path.join(core.dataDir, 'backup', 'export')).some((f) => f.endsWith('.jsonl')), '月包那晚有一份 JSONL 导出');
  clock.advance(DAY);
  made = await core.mods.backup.runScheduled(core, { at: core.now() });
  assert.deepEqual(made.map((p) => p.kind), ['daily']);
  assert.equal(core.store.get('SELECT count(*) AS n FROM restore_drills').n, 1, '演练每周一次');
  // 同一天再跑：什么都不做
  assert.deepEqual(await core.mods.backup.runScheduled(core, { at: core.now() }), []);
  clock.set(Date.UTC(2026, 10, 7, 20, 30));   // 本地 11-08（周日）
  made = await core.mods.backup.runScheduled(core, { at: core.now() });
  assert.deepEqual(made.map((p) => p.kind).sort(), ['daily', 'weekly']);
  assert.equal(core.store.get('SELECT count(*) AS n FROM restore_drills').n, 2);
  clock.set(Date.UTC(2026, 10, 30, 20, 30));  // 本地 12-01
  made = await core.mods.backup.runScheduled(core, { at: core.now() });
  assert.ok(made.some((p) => p.kind === 'monthly'));
}));

test('runScheduled：做包失败不往外抛（夜间整理照常往下走）', run('bk-sched-fail', async (core, h) => {
  seed(core);
  core.store.close();
  const made = await core.mods.backup.runScheduled(core, { at: core.now() });
  assert.deepEqual(made, []);
  assert.ok(h.ports.logger.events('backup.scheduled-failed').length + h.ports.logger.events('backup.scheduled').length >= 1);
}));

test('restoreDrill：最新的包完整解开，抽几条记忆用自己的词查回来；包坏了演练失败并记下', run('bk-drill', async (core) => {
  seed(core);
  for (let i = 0; i < 10; i++) seedAssertion(core, { text: `第${i}条测试记忆关于登山和咖啡${i}` });
  const [p] = await core.mods.backup.createPack(core, { kind: 'daily' });
  const r = await core.mods.backup.restoreDrill(core);
  assert.equal(r.ok, true);
  assert.ok(r.sampled >= 10 && r.found === r.sampled, JSON.stringify(r));
  assert.equal(core.store.get('SELECT status FROM restore_drills ORDER BY id DESC LIMIT 1').status, 'ok');
  assert.ok(!fs.readdirSync(path.join(core.dataDir, 'backup', '.staging')).length, '临时目录删掉了');
  const buf = fs.readFileSync(p.path);
  buf[200] ^= 0xff;
  fs.writeFileSync(p.path, buf);
  const bad = await core.mods.backup.restoreDrill(core);
  assert.equal(bad.ok, false);
  assert.equal(core.store.get('SELECT status FROM restore_drills ORDER BY id DESC LIMIT 1').status, 'failed');
  const o = core.mods.backup.overview(core);
  assert.equal(o.lastDrill.ok, false);
}));

test('preOperationSnapshot：迁移前（backups 表还不存在）也能做一份验证过的包，之后补登记', async () => {
  const dir = tmpDir('bk-premig');
  try {
    const old = openDatabase({ file: path.join(dir, 'persona-memory.db') });
    await migrate(old, MIGRATIONS, { target: 4 });
    old.run("INSERT INTO meta(key, value) VALUES ('marker', 'before')");
    old.close();
    const h = await createBackupCore({ dir, mods: quietMods(), config: FAST, keepDir: true });
    try {
      const { core } = h;
      const snap = core.store.migration.backup;
      assert.ok(snap && fs.existsSync(snap), '迁移前快照在');
      assert.ok(path.resolve(snap).startsWith(path.resolve(dir, 'backup', 'pre-op')));
      assert.match(path.basename(snap), /^pm-pre-op-migrate-v4-/);
      const u = await core.mods.backup.unpack(core, snap, { dest: path.join(dir, 'unpacked') });
      const db = new DatabaseSync(u.files['main.db'], { readOnly: true });
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'marker'").get().value, 'before');
      db.close();
      // 迁移时表还不在，登记先记在内存里；库就位后 backup.init 马上补登记，不等下一次做包（进程在那之前退出也不丢这一行）
      assert.equal(core.store.get("SELECT kind FROM backups WHERE path = ?", snap)?.kind, 'pre-op', '启动时就补登记了');
      assert.equal(core.state.backup.pending.length, 0);
      await core.mods.backup.rotate(core);
      assert.equal(core.store.get('SELECT count(*) AS n FROM backups WHERE path = ?', snap).n, 1, '不会重复登记');
    } finally { await h.close(); }
  } finally { rmDir(dir); }
});

test('init：内存里待登记的包（迁移前快照）在库就位时补登记；写不进去就留在内存里，下次再补；只读时不动', run('bk-init-flush', async (core) => {
  const [p] = await core.mods.backup.createPack(core, { kind: 'manual' });
  const row = core.store.get('SELECT * FROM backups WHERE path = ?', p.path);
  core.store.run('DELETE FROM backups WHERE path = ?', p.path);
  const pending = { ...row };
  delete pending.id;
  delete pending.deleted_at;
  // 只读：不动
  core.state.backup.pending.push(pending);
  core.readOnly = true;
  core.mods.backup.init(core);
  assert.equal(core.state.backup.pending.length, 1);
  core.readOnly = false;
  // 写失败（表被锁之类）：留在内存里
  const realTx = core.store.tx.bind(core.store);
  core.store.tx = () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); };
  try { core.mods.backup.init(core); } finally { core.store.tx = realTx; }
  assert.equal(core.state.backup.pending.length, 1, '写不进去的不丢');
  assert.equal(core.store.get('SELECT count(*) AS n FROM backups WHERE path = ?', p.path).n, 0);
  // 能写了：补登记
  core.mods.backup.init(core);
  assert.equal(core.state.backup.pending.length, 0);
  assert.equal(core.store.get('SELECT kind FROM backups WHERE path = ?', p.path)?.kind, 'manual');
}));

test('preOperationSnapshot：备份做不了（库关了）就抛错——宁可这次不做那个操作', run('bk-preop-fail', async (core) => {
  const store = await openStore({ file: path.join(core.dataDir, 'other.db') });
  store.close();
  await assert.rejects(core.mods.backup.preOperationSnapshot(core, { reason: 'purge', store }));
}));
