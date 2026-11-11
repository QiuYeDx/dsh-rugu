// 身份哈希密钥和库的核对（D140）：库里记密钥的指纹；密钥丢了、换了就拒绝打开，不悄悄生成一把新的，库和密钥文件都不动。
// 升级上来的老库用现有密钥补记指纹；整体恢复（换机）带着包里的密钥，照常打开。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPersonaMemory } from '../src/index.js';
import { openDatabase, migrate, MIGRATIONS, keyFingerprint, KEY_FINGERPRINT_META, IdentityKeyError } from '../src/store/index.js';
import { fakePorts } from './fakes/index.js';
import { tmpDir, rmDir } from './helpers.js';

const open = (dataDir, keyFile, extra = {}) => createPersonaMemory({ dataDir, keyFile, ports: fakePorts(), startWorker: false, ...extra });
const dbFile = (dir) => path.join(dir, 'persona-memory.db');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const keyOf = (f) => Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
const metaFp = (dir) => {
  const db = openDatabase({ file: dbFile(dir), readOnly: true });
  try { return db.get('SELECT value FROM meta WHERE key = ?', KEY_FINGERPRINT_META)?.value ?? null; } finally { db.close(); }
};
/** 一个有数据的库（账号哈希是用密钥算的），关好。 */
async function seeded(dir, keyFile) {
  const pm = await open(dir, keyFile);
  const core = pm._core;
  const e = core.mods.entities.ensurePrincipal(core);
  core.store.run("INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'zz', '', ?, 'platform', ?)",
    e, core.keys.identityHash('zz', '', 'acct-7f3k'), core.now());
  await pm.close();
}

test('新库、没有密钥：照旧生成，并记下指纹（推不回密钥）', async () => {
  const dir = tmpDir('idk-new');
  const keyFile = path.join(dir, 'k', 'id.key');
  try {
    const pm = await open(dir, keyFile);
    await pm.close();
    assert.ok(fs.existsSync(keyFile));
    const fp = metaFp(dir);
    assert.equal(fp, keyFingerprint(keyOf(keyFile)));
    assert.match(fp, /^[0-9a-f]{16}$/);
    assert.ok(!fs.readFileSync(dbFile(dir)).includes(fs.readFileSync(keyFile, 'utf8').trim()), '库里没有密钥本身');
    const again = await open(dir, keyFile);
    await again.close();
  } finally { rmDir(dir); }
});

test('库里有指纹、密钥文件不在：不生成新的，拒绝打开（IDENTITY_KEY_MISSING），库没被改动', async () => {
  const dir = tmpDir('idk-missing');
  const keyFile = path.join(dir, 'id.key');
  try {
    await seeded(dir, keyFile);
    fs.rmSync(keyFile);
    const before = sha(dbFile(dir));
    await assert.rejects(open(dir, keyFile), (e) => e instanceof IdentityKeyError && e.code === 'IDENTITY_KEY_MISSING' && /没有改动/.test(e.message));
    assert.equal(fs.existsSync(keyFile), false, '没有新建密钥');
    assert.equal(sha(dbFile(dir)), before, '库文件一个字节都没变');
    assert.equal(fs.existsSync(`${dbFile(dir)}-wal`) && fs.statSync(`${dbFile(dir)}-wal`).size > 0, false);
    // 只读打开（工具、诊断）也一样
    await assert.rejects(open(dir, keyFile, { readOnly: true }), { code: 'IDENTITY_KEY_MISSING' });
  } finally { rmDir(dir); }
});

test('密钥在、指纹对不上：拒绝打开（IDENTITY_KEY_MISMATCH），密钥文件和库都不动', async () => {
  const dir = tmpDir('idk-mismatch');
  const keyFile = path.join(dir, 'id.key');
  try {
    await seeded(dir, keyFile);
    const other = `${crypto.randomBytes(32).toString('base64')}\n`;
    fs.writeFileSync(keyFile, other);
    const before = sha(dbFile(dir));
    await assert.rejects(open(dir, keyFile), (e) => e.code === 'IDENTITY_KEY_MISMATCH');
    assert.equal(fs.readFileSync(keyFile, 'utf8'), other);
    assert.equal(sha(dbFile(dir)), before);
  } finally { rmDir(dir); }
});

test('升级上来的老库（有数据、没有指纹）：用现有密钥补记指纹，照常打开；密钥也不在就拒绝', async () => {
  const dir = tmpDir('idk-legacy');
  const keyFile = path.join(dir, 'id.key');
  try {
    await seeded(dir, keyFile);
    const db = openDatabase({ file: dbFile(dir) });
    db.run('DELETE FROM meta WHERE key = ?', KEY_FINGERPRINT_META);
    db.close();
    assert.equal(metaFp(dir), null);
    const pm = await open(dir, keyFile);
    assert.equal(pm._core.store.get('SELECT count(*) AS n FROM identity_evidence').n, 1);
    await pm.close();
    assert.equal(metaFp(dir), keyFingerprint(keyOf(keyFile)));

    // 老库、密钥也丢了：库里已经有用密钥算出来的数据，不能新建
    const dir2 = tmpDir('idk-legacy2');
    try {
      const old = openDatabase({ file: dbFile(dir2) });
      await migrate(old, MIGRATIONS, { target: 4 });
      old.run("INSERT INTO settings(key, adapter, label, stability, first_seen, last_seen) VALUES ('sk-a', 'zz', '小群', 'persistent', 1, 1)");
      old.close();
      const k2 = path.join(dir2, 'id.key');
      await assert.rejects(open(dir2, k2), { code: 'IDENTITY_KEY_MISSING' });
      assert.equal(fs.existsSync(k2), false);
    } finally { rmDir(dir2); }
  } finally { rmDir(dir); }
});

test('换机恢复：新机器上生成的密钥被包里的那把换掉，恢复出的库带着旧指纹照常打开；重开也照常', async () => {
  const oldDir = tmpDir('idk-restore-old');
  const newDir = tmpDir('idk-restore-new');
  const oldKey = path.join(oldDir, 'id.key');
  const newKey = path.join(newDir, 'id.key');
  try {
    await seeded(oldDir, oldKey);
    const A = await open(oldDir, oldKey);
    const [pack] = await A.admin.backup.now();
    const copied = path.join(newDir, 'copied.pmpack');
    fs.copyFileSync(pack.path, copied);
    await A.close();
    const B = await open(newDir, newKey);
    assert.notEqual(keyFingerprint(keyOf(newKey)), keyFingerprint(keyOf(oldKey)));
    const pv = await B.admin.backup.preview(copied);
    assert.equal(pv.ok, true);
    const r = await B.admin.backup.restore(copied, { confirmPhrase: pv.confirmPhrase });
    assert.equal(r.ok, true);
    assert.equal(r.identityKeyReplaced, true);
    assert.equal(B._core.keys.identityHash('zz', '', 'acct-7f3k'), B._core.store.get('SELECT id_hash FROM identity_evidence').id_hash, '认得出原来的账号');
    await B.close();
    assert.equal(metaFp(newDir), keyFingerprint(keyOf(oldKey)));
    const B2 = await open(newDir, newKey);
    await B2.close();
  } finally { rmDir(oldDir); rmDir(newDir); }
});

test('恢复一个和本机密钥对不上、包里又没带密钥的库：换库失败、回到恢复前，不是绕过核对的口子', async () => {
  const oldDir = tmpDir('idk-nokey-old');
  const newDir = tmpDir('idk-nokey-new');
  const oldKey = path.join(oldDir, 'id.key');
  const newKey = path.join(newDir, 'id.key');
  try {
    await seeded(oldDir, oldKey);
    const A = await open(oldDir, oldKey);
    fs.rmSync(oldKey);   // 运行中密钥文件被删了：做出来的包里没有身份密钥
    const [pack] = await A.admin.backup.now();
    await A.close();
    const B = await open(newDir, newKey);
    try {
      const mark = B._core.store.get('SELECT count(*) AS n FROM identity_evidence').n;
      const pv = await B.admin.backup.preview(pack.path);
      assert.equal(pv.ok, true);
      await assert.rejects(B.admin.backup.restore(pack.path, { confirmPhrase: pv.confirmPhrase }), { code: 'RESTORE_FAILED' });
      assert.equal(B.readOnly, false);
      assert.equal(B._core.store.get('SELECT count(*) AS n FROM identity_evidence').n, mark, '回到了恢复前的库');
    } finally { await B.close(); }
    assert.equal(metaFp(newDir), keyFingerprint(keyOf(newKey)), '本机的密钥和库仍是一套');
  } finally { rmDir(oldDir); rmDir(newDir); }
});
