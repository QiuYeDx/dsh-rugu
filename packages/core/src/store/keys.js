// 身份哈希密钥和由它算出的各种存储键（§12.3）。
//   - 账号 id、SettingId、ObsId 都不存原值，只存 HMAC-SHA256（本机密钥）。同一个值得到同一个键，但推不回原值。
//   - 密钥丢了，恢复后账号就对不上人，所以它随备份包走（§12.4.1），由集成层决定放哪（DSH 上是 ~/.dsh/persona-memory.key）。
//   - 这个文件的内容永远不打印、不进日志。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { opaqueFrom } from '../contract/ids.js';

const KEY_BYTES = 32;

/**
 * 读密钥；文件不存在就生成一个（权限尽量收紧）。文件存在但内容不对就报错，绝不覆盖。
 * @param {string} file
 * @returns {Buffer}
 */
export function loadOrCreateKey(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`身份哈希密钥文件格式不对：${path.basename(file)}`);
    return key;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(KEY_BYTES);
  fs.writeFileSync(file, `${key.toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
  return key;
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
