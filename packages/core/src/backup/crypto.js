// 备份的加密（§12.4.3）：AES-256-GCM，密钥由恢复码经 scrypt 派生。
//   - 恢复码：128 位随机数，Crockford base32（不含 I L O U），末尾 4 位校验，6 组 × 5 位。只在开启加密时显示一次，库里不存。
//   - 本机密钥文件（默认 <dataDir>/persona-memory-backup.key，DSH 上是 ~/.dsh/persona-memory-backup.key）存派生好的密钥和
//     scrypt 参数，用来自动加密；换电脑、本机密钥丢了时，用恢复码 + 包头里的盐重新派生。文件里可以有多把（换过恢复码时旧的留着，
//     老的异地包照样能解开），active 是现在用来加密的那把。
//   - 身份哈希密钥在包里单独加密（wrap）：有备份密钥时一律包一层，没有时（从没开过异地备份）只有本机包，原样放（和密钥文件本身
//     在同一个私有目录里，风险相同）。
//   - 这些值永远不进日志。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { param } from './util.js';

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford base32
const CODE_BODY = 26;                                   // 128 位 → 26 位
const CODE_CHECK = 4;
const WRAP_AAD = Buffer.from('persona-memory/identity-key/v1');

export class BackupKeyError extends Error {
  /** @param {'RECOVERY_CODE_FORMAT'|'WRONG_RECOVERY_CODE'|'NEED_RECOVERY_CODE'|'KEY_FILE'} code */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'BackupKeyError';
    this.code = code;
  }
}

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
const checksum = (body) => base32(crypto.createHash('sha256').update(`pm-recovery/${body}`).digest()).slice(0, CODE_CHECK);

/**
 * 生成恢复码（管理页只显示这一次）。
 * @returns {string} 形如 'K7Q2M-9XMD4-…'（6 组 × 5 位）
 */
export function generateRecoveryCode() {
  const body = base32(crypto.randomBytes(16)).slice(0, CODE_BODY);
  const all = body + checksum(body);
  return all.match(/.{5}/g).join('-');
}

/**
 * 规范化主人输入的恢复码：大小写、空格、连字符都不计较，O → 0、I / L → 1；校验位不对直接报错（打错字和「恢复码不对」分开说）。
 * @param {string} code
 * @returns {string} 26 位的正文（派生密钥用它）
 */
export function normalizeRecoveryCode(code) {
  const s = String(code ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_BODY + CODE_CHECK || [...s].some((ch) => !ALPHABET.includes(ch))) {
    throw new BackupKeyError('RECOVERY_CODE_FORMAT', '恢复码的格式不对');
  }
  const body = s.slice(0, CODE_BODY);
  if (checksum(body) !== s.slice(CODE_BODY)) throw new BackupKeyError('RECOVERY_CODE_FORMAT', '恢复码有字抄错了（校验位对不上）');
  return body;
}

/** 密钥指纹（包头和密钥文件里用它认是哪一把，不泄露密钥本身）。 */
export const keyIdOf = (key) => crypto.createHash('sha256').update('pm-backup-key/').update(key).digest('hex').slice(0, 16);

/**
 * 恢复码 → 密钥（scrypt，在线程池里跑）。
 * @param {string} code
 * @param {{salt: string, N: number, r: number, p: number}} kdf   salt 是 base64
 * @returns {Promise<Buffer>}
 */
export async function deriveKey(code, kdf) {
  const body = normalizeRecoveryCode(code);
  const salt = Buffer.from(kdf.salt, 'base64');
  const maxmem = 256 * kdf.N * kdf.r + 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    crypto.scrypt(body, salt, KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem }, (e, k) => (e ? reject(e) : resolve(k)));
  });
}

/** 本机备份密钥文件的位置。 */
export function backupKeyFile(core) {
  const cfg = core.config.get();
  const f = cfg.backup?.keyFile;
  return typeof f === 'string' && f ? f : path.join(core.dataDir, 'persona-memory-backup.key');
}

/**
 * 读本机备份密钥。文件不存在返回 null；格式不对报错（绝不覆盖）。
 * @returns {{active: string|null, keys: Map<string, {key: Buffer, kdf: {alg: string, salt: string, N: number, r: number, p: number}, createdAt: number}>}|null}
 */
export function loadBackupKeys(core) {
  const file = backupKeyFile(core);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new BackupKeyError('KEY_FILE', '备份密钥文件读不了');
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new BackupKeyError('KEY_FILE', '备份密钥文件格式不对'); }
  if (!j || j.v !== 1 || !Array.isArray(j.keys)) throw new BackupKeyError('KEY_FILE', '备份密钥文件格式不对');
  const keys = new Map();
  for (const k of j.keys) {
    const key = Buffer.from(String(k.key ?? ''), 'base64');
    if (key.length !== KEY_BYTES || keyIdOf(key) !== k.keyId) throw new BackupKeyError('KEY_FILE', '备份密钥文件里有一把坏了');
    keys.set(k.keyId, { key, kdf: k.kdf, createdAt: k.createdAt });
  }
  return { active: keys.has(j.active) ? j.active : null, keys };
}

function saveBackupKeys(core, state) {
  const file = backupKeyFile(core);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    v: 1,
    active: state.active,
    keys: [...state.keys].map(([keyId, k]) => ({ keyId, key: k.key.toString('base64'), kdf: k.kdf, createdAt: k.createdAt })),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 把一把（由恢复码派生的）密钥加进本机密钥文件。makeActive=true 时之后的包用它加密。
 * @returns {string} keyId
 */
export function installBackupKey(core, key, kdf, { makeActive = true, at = core.now() } = {}) {
  const state = loadBackupKeys(core) ?? { active: null, keys: new Map() };
  const keyId = keyIdOf(key);
  if (!state.keys.has(keyId)) state.keys.set(keyId, { key, kdf, createdAt: at });
  if (makeActive || !state.active) state.active = keyId;
  saveBackupKeys(core, state);
  return keyId;
}

/** 新的 scrypt 参数（盐随机，N / r / p 来自 config.backup.scrypt）。 */
export function newKdf(core) {
  const s = param(core, 'backup.scrypt');
  return { alg: 'scrypt', salt: crypto.randomBytes(SALT_BYTES).toString('base64'), N: s.N, r: s.r, p: s.p };
}

/** 现在用来加密的那把（没开过加密返回 null）。 */
export function activeBackupKey(core) {
  const st = loadBackupKeys(core);
  if (!st?.active) return null;
  const k = st.keys.get(st.active);
  return { keyId: st.active, key: k.key, kdf: k.kdf };
}

/**
 * 解一个加密的包要用哪把密钥：本机密钥文件里有同一把就用它；否则用主人给的恢复码 + 包头里的 scrypt 参数重新派生，
 * 派生出来的指纹和包头对不上 = 恢复码不对。
 * @param {object} core
 * @param {{keyId: string, kdf: object}} enc   包头里的 enc / 被包住的身份密钥的描述
 * @param {{recoveryCode?: string}} [opt]
 * @returns {Promise<{key: Buffer, fromCode: boolean, kdf: object}>}
 */
export async function resolveKey(core, enc, opt = {}) {
  let st = null;
  try { st = loadBackupKeys(core); } catch { st = null; }
  const local = st?.keys.get(enc.keyId);
  if (local) return { key: local.key, fromCode: false, kdf: local.kdf };
  if (!opt.recoveryCode) throw new BackupKeyError('NEED_RECOVERY_CODE', '这个包是加密的，本机没有它的密钥，需要恢复码');
  const key = await deriveKey(opt.recoveryCode, enc.kdf);
  if (keyIdOf(key) !== enc.keyId) throw new BackupKeyError('WRONG_RECOVERY_CODE', '恢复码不对');
  return { key, fromCode: true, kdf: enc.kdf };
}

// ── 小块数据的 AES-256-GCM（包住身份密钥） ─────────────────────────────────

/**
 * @param {Buffer} data
 * @param {{key: Buffer, keyId: string, kdf: object}} bk
 */
export function wrapSecret(data, bk) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', bk.key, iv);
  c.setAAD(WRAP_AAD);
  const enc = Buffer.concat([c.update(data), c.final()]);
  return { v: 1, wrapped: true, alg: 'aes-256-gcm', keyId: bk.keyId, kdf: bk.kdf, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
}

/** @returns {Buffer} */
export function unwrapSecret(w, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(w.iv, 'base64'));
  d.setAAD(WRAP_AAD);
  d.setAuthTag(Buffer.from(w.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(w.data, 'base64')), d.final()]);
}
