// 记忆包的容器格式和加密（§12.4.1、§12.4.3）：往返、篡改检测、错误的恢复码、恢复码的格式和校验位。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePack, readPack, readPackHeader, PackError } from '../../src/backup/format.js';
import { generateRecoveryCode, normalizeRecoveryCode, deriveKey, keyIdOf, wrapSecret, unwrapSecret, resolveKey, installBackupKey, BackupKeyError } from '../../src/backup/crypto.js';
import { createConfig } from '../../src/config/defaults.js';
import { tmpDir, rmDir } from '../helpers.js';

const withDir = (name, fn) => async () => { const dir = tmpDir(name); try { await fn(dir); } finally { rmDir(dir); } };
const FAST_KDF = { N: 1024, r: 8, p: 1 };

function files(dir) {
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(a, crypto.randomBytes(300_000));
  fs.writeFileSync(b, JSON.stringify({ hello: '世界' }));
  return [{ name: 'main.db', file: a }, { name: 'config.json', file: b }];
}

test('包：写了再读，条目逐字节相同；manifest 记了大小和 sha256', withDir('bk-fmt', async (dir) => {
  const entries = files(dir);
  const w = await writePack(path.join(dir, 'p.pmpack'), { header: { kind: 'manual', createdAt: 1, packId: 'x' }, manifest: { counts: { t: 1 } }, entries });
  assert.equal(w.manifest.files.length, 2);
  assert.equal(w.manifest.files[0].sha256, crypto.createHash('sha256').update(fs.readFileSync(entries[0].file)).digest('hex'));
  assert.ok(!fs.existsSync(`${w.path}.partial`), '临时文件改名了');
  const out = path.join(dir, 'out');
  const r = await readPack(w.path, { outDir: out });
  assert.deepEqual(r.manifest.counts, { t: 1 });
  for (const e of entries) assert.ok(fs.readFileSync(r.files[e.name]).equals(fs.readFileSync(e.file)), e.name);
  const m = await readPack(w.path, { manifestOnly: true });
  assert.equal(m.manifest.files.length, 2);
  assert.deepEqual(m.files, {});
  const h = await readPackHeader(w.path);
  assert.equal(h.header.kind, 'manual');
  assert.equal(h.header.encrypted, false);
  assert.equal(w.sha256, crypto.createHash('sha256').update(fs.readFileSync(w.path)).digest('hex'), '登记的 sha256 = 整个文件的');
}));

test('包：改一个字节就读不出来（gzip / 条目 sha256）；截断的包报 truncated 或 corrupt', withDir('bk-fmt-tamper', async (dir) => {
  const w = await writePack(path.join(dir, 'p.pmpack'), { header: { kind: 'daily', createdAt: 1, packId: 'x' }, manifest: {}, entries: files(dir) });
  const buf = fs.readFileSync(w.path);
  const bad = Buffer.from(buf);
  bad[bad.length - 100] ^= 0xff;
  fs.writeFileSync(path.join(dir, 'bad.pmpack'), bad);
  await assert.rejects(readPack(path.join(dir, 'bad.pmpack'), { outDir: path.join(dir, 'o1') }), (e) => e instanceof PackError);
  fs.writeFileSync(path.join(dir, 'short.pmpack'), buf.subarray(0, Math.floor(buf.length / 2)));
  await assert.rejects(readPack(path.join(dir, 'short.pmpack'), { outDir: path.join(dir, 'o2') }), (e) => e instanceof PackError && ['truncated', 'corrupt'].includes(e.reason));
  fs.writeFileSync(path.join(dir, 'junk.pmpack'), 'not a pack');
  await assert.rejects(readPackHeader(path.join(dir, 'junk.pmpack')), (e) => e.reason === 'format');
}));

test('加密的包：AES-256-GCM，包头也被认证；钥匙不对、包被改过都解不开', withDir('bk-fmt-enc', async (dir) => {
  const key = crypto.randomBytes(32);
  const enc = { key, keyId: keyIdOf(key), kdf: { alg: 'scrypt', salt: 'c2FsdA==', ...FAST_KDF } };
  const w = await writePack(path.join(dir, 'e.pmpack'), { header: { kind: 'daily', createdAt: 5, packId: 'y' }, manifest: { secret: 'x' }, entries: files(dir), encryption: enc });
  const raw = fs.readFileSync(w.path);
  assert.ok(!raw.includes(Buffer.from('世界')), '正文不是明文');
  assert.ok(!raw.includes(Buffer.from('"secret"')), 'manifest 也加密了');
  await assert.rejects(readPack(w.path, { outDir: path.join(dir, 'o0') }), (e) => e.reason === 'decrypt', '没给钥匙');
  const ok = await readPack(w.path, { outDir: path.join(dir, 'o1'), key });
  assert.equal(ok.manifest.secret, 'x');
  await assert.rejects(readPack(w.path, { outDir: path.join(dir, 'o2'), key: crypto.randomBytes(32) }), (e) => e instanceof PackError);
  // 改包头里的 kind（明文）：GCM 的 AAD 覆盖包头，认证失败
  const s = raw.toString('latin1').replace('"kind":"daily"', '"kind":"dairy"');
  fs.writeFileSync(path.join(dir, 'hdr.pmpack'), Buffer.from(s, 'latin1'));
  await assert.rejects(readPack(path.join(dir, 'hdr.pmpack'), { outDir: path.join(dir, 'o3'), key }), (e) => e instanceof PackError);
  // 改最后的认证标签
  const t = Buffer.from(raw);
  t[t.length - 1] ^= 1;
  fs.writeFileSync(path.join(dir, 'tag.pmpack'), t);
  await assert.rejects(readPack(path.join(dir, 'tag.pmpack'), { outDir: path.join(dir, 'o4'), key }), (e) => e.reason === 'decrypt');
}));

test('恢复码：6 组 × 5 位，Crockford base32，大小写 / 连字符 / O0 / IL1 都不计较，校验位能发现抄错', () => {
  const codes = new Set(Array.from({ length: 50 }, generateRecoveryCode));
  assert.equal(codes.size, 50);
  for (const c of codes) {
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    const body = normalizeRecoveryCode(c);
    assert.equal(body.length, 26);
    assert.equal(normalizeRecoveryCode(c.toLowerCase().replaceAll('-', ' ')), body);
  }
  const c = [...codes][0];
  const swapped = c.replace(/[0-9A-Z]/, (ch) => (ch === '2' ? '3' : '2'));
  assert.throws(() => normalizeRecoveryCode(swapped), (e) => e instanceof BackupKeyError && e.code === 'RECOVERY_CODE_FORMAT');
  assert.throws(() => normalizeRecoveryCode('short'), (e) => e.code === 'RECOVERY_CODE_FORMAT');
  assert.equal(normalizeRecoveryCode(c.replaceAll('0', 'O').replaceAll('1', 'l')), normalizeRecoveryCode(c));
});

test('scrypt 派生：同一个恢复码 + 盐 → 同一把钥匙；换盐就不同；身份密钥能包住再解开', async () => {
  const code = generateRecoveryCode();
  const kdf = { alg: 'scrypt', salt: crypto.randomBytes(16).toString('base64'), ...FAST_KDF };
  const k1 = await deriveKey(code, kdf);
  const k2 = await deriveKey(code.toLowerCase(), kdf);
  assert.ok(k1.equals(k2));
  assert.equal(k1.length, 32);
  const k3 = await deriveKey(code, { ...kdf, salt: crypto.randomBytes(16).toString('base64') });
  assert.ok(!k1.equals(k3));
  const secret = crypto.randomBytes(32);
  const w = wrapSecret(secret, { key: k1, keyId: keyIdOf(k1), kdf });
  assert.ok(!JSON.stringify(w).includes(secret.toString('base64')));
  assert.ok(unwrapSecret(w, k1).equals(secret));
  assert.throws(() => unwrapSecret(w, k3));
});

test('resolveKey：本机有同一把就用本机的；没有就要恢复码；恢复码不对报 WRONG_RECOVERY_CODE', withDir('bk-resolve', async (dir) => {
  const core = { dataDir: dir, config: createConfig({}), now: () => 1 };
  const code = generateRecoveryCode();
  const kdf = { alg: 'scrypt', salt: crypto.randomBytes(16).toString('base64'), ...FAST_KDF };
  const key = await deriveKey(code, kdf);
  const enc = { keyId: keyIdOf(key), kdf };
  await assert.rejects(resolveKey(core, enc), (e) => e.code === 'NEED_RECOVERY_CODE');
  await assert.rejects(resolveKey(core, enc, { recoveryCode: generateRecoveryCode() }), (e) => e.code === 'WRONG_RECOVERY_CODE');
  const r = await resolveKey(core, enc, { recoveryCode: code });
  assert.ok(r.key.equals(key) && r.fromCode);
  installBackupKey(core, key, kdf);
  const again = await resolveKey(core, enc);
  assert.ok(again.key.equals(key) && !again.fromCode, '装进本机密钥文件之后不再要恢复码');
  const f = fs.readFileSync(path.join(dir, 'persona-memory-backup.key'), 'utf8');
  assert.ok(!f.includes(code), '密钥文件里没有恢复码本身');
}));
