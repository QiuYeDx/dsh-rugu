// 身份哈希密钥和由它算出的各种存储键（§12.3）。
//   - 账号 id、SettingId、ObsId 都不存原值，只存 HMAC-SHA256（本机密钥）。同一个值得到同一个键，但推不回原值。
//   - 密钥丢了，恢复后账号就对不上人，所以它随备份包走（§12.4.1），由集成层决定放哪（DSH 上是 ~/.dsh/persona-memory.key）。
//   - 这个文件的内容永远不打印、不进日志。
//   - 库里记着这把密钥的指纹（meta 'identity.keyFingerprint'，D140）：打开库时核对，密钥丢了、换了就拒绝打开，不悄悄换一把新的
//     （换了以后主人不再被认成主人、去重失效、每个群都成了新场合，而且没有任何提示）。指纹推不回密钥。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { opaqueFrom } from '../contract/ids.js';
import { setMeta } from './kv.js';

const KEY_BYTES = 32;
/** 库里记密钥指纹的 meta 键。 */
export const KEY_FINGERPRINT_META = 'identity.keyFingerprint';

/**
 * 读密钥文件。文件不存在返回 null；存在但内容不对就报错（绝不覆盖）。
 * @param {string} file
 * @returns {Buffer|null}
 */
export function readKeyFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`身份哈希密钥文件格式不对：${path.basename(file)}`);
  return key;
}

/**
 * 读密钥；文件不存在就生成一个（权限尽量收紧）。文件存在但内容不对就报错，绝不覆盖。
 * 打开主库时不直接用它，走 checkIdentityKey（库里已经有数据时不新建）。
 * @param {string} file
 * @returns {Buffer}
 */
export function loadOrCreateKey(file) {
  const old = readKeyFile(file);
  if (old) return old;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
  return key;
}

/**
 * 密钥的指纹：带用途前缀的 sha256，取前 16 个十六进制字符。推不回密钥，只用来核对「是不是同一把」。
 * 和可移植导出里的 identityKeyId 是同一个算法。
 * @param {Buffer} key
 * @returns {string}
 */
export function keyFingerprint(key) {
  return crypto.createHash('sha256').update('pm-identity-key/').update(key).digest('hex').slice(0, 16);
}

/** 身份哈希密钥和库对不上（D140）。code：'IDENTITY_KEY_MISSING'（密钥文件不在）/ 'IDENTITY_KEY_MISMATCH'（不是这个库的那把）。 */
export class IdentityKeyError extends Error {
  /** @param {'IDENTITY_KEY_MISSING'|'IDENTITY_KEY_MISMATCH'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'IdentityKeyError';
    this.code = code;
  }
}

const hasTable = (store, name) => !!store.get("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = ?", name);

/** 库里记着的指纹（还没有 meta 表、没记过都是 null）。 */
function storedFingerprint(store) {
  if (!hasTable(store, 'meta')) return null;
  return store.get('SELECT value FROM meta WHERE key = ?', KEY_FINGERPRINT_META)?.value ?? null;
}

/** 库里有没有用密钥算出来的东西（场合键、感知的存储键、账号哈希）。 */
function hasHashedData(store) {
  for (const t of ['settings', 'percepts', 'identity_evidence']) {
    if (hasTable(store, t) && store.get(`SELECT 1 AS x FROM ${t} LIMIT 1`)) return true;
  }
  return false;
}

const MISSING = (name) => `身份哈希密钥文件不在了（${name}）。这个库里的账号、场合、消息去重都是用它算的，换一把新的就全对不上了，`
  + '所以没有新建密钥，也没有打开库、没有改动任何数据。把原来的密钥文件放回原处（DSH 上在 DSH 家目录里；数据目录放在别的盘上时，'
  + '密钥仍在家目录里，不跟着数据目录走），然后重新打开。';
const MISMATCH = (name) => `身份哈希密钥文件（${name}）和这个库不是一套：库是用另一把密钥建的。用这把打开，账号、场合都会对不上，`
  + '所以没有打开库，也没有改动任何数据。把这个库原来的那把密钥放回原处再重新打开；换过库或换过电脑的，确认密钥文件和库是一起拷过来的。';

/**
 * 打开主库时核对身份哈希密钥（D140）。在迁移之前调（库可能还是旧版本），只读库，不写库：
 *   - 库里记着指纹：密钥文件不在 → IDENTITY_KEY_MISSING；指纹对不上 → IDENTITY_KEY_MISMATCH。都不新建密钥。
 *   - 库里还没有指纹（新库，或者升级上来的老库）：密钥在就用它；不在而库里已经有用密钥算出来的数据 → IDENTITY_KEY_MISSING；
 *     库是空的才新建一把。返回 record = true，迁移完由调用方记下指纹（recordKeyFingerprint）。
 * @param {import('./db.js').Store} store
 * @param {string} file   密钥文件
 * @returns {{key: Buffer, fingerprint: string, record: boolean}}
 */
export function checkIdentityKey(store, file) {
  const name = path.basename(file);
  const stored = storedFingerprint(store);
  let key = readKeyFile(file);
  if (stored) {
    if (!key) throw new IdentityKeyError('IDENTITY_KEY_MISSING', MISSING(name));
    if (keyFingerprint(key) !== stored) throw new IdentityKeyError('IDENTITY_KEY_MISMATCH', MISMATCH(name));
    return { key, fingerprint: stored, record: false };
  }
  if (!key) {
    if (hasHashedData(store)) throw new IdentityKeyError('IDENTITY_KEY_MISSING', MISSING(name));
    key = loadOrCreateKey(file);
  }
  return { key, fingerprint: keyFingerprint(key), record: true };
}

/** 记下密钥指纹（迁移之后、库可写时）。 */
export function recordKeyFingerprint(store, fingerprint) {
  setMeta(store, KEY_FINGERPRINT_META, fingerprint);
}

/**
 * @typedef {object} Keyring
 * @property {(adapterId: string, settingId: string) => string} settingKey   settings.key
 * @property {(adapterId: string, obsId: string) => string} obsKey           percepts.ext_key、target_key、relays.obs_key
 * @property {(namespace: string, scope: string|undefined, id: string) => string} identityHash   identity_evidence.id_hash
 * @property {(...parts: unknown[]) => string} hash                           其他需要不透明键的地方（带用途前缀）
 */

/**
 * @param {Buffer} key
 * @returns {Keyring}
 */
export function makeKeyring(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error('身份哈希密钥应为 32 字节');
  return Object.freeze({
    settingKey: (adapterId, settingId) => opaqueFrom(key, 'setting', adapterId, settingId),
    obsKey: (adapterId, obsId) => opaqueFrom(key, 'obs', adapterId, obsId),
    identityHash: (namespace, scope, id) => opaqueFrom(key, 'identity', namespace, scope ?? '', id),
    hash: (...parts) => opaqueFrom(key, 'misc', ...parts),
  });
}
