// 不透明 id 的帮手（§2.2、§4.2）。
// SettingId、ObsId、账号 id 都是不透明值：核心只能整体比较是否相等，不许 startsWith / split / 正则 / 模板拼接。
// 需要把几个值合成一个键时，用 opaqueFrom()（带长度前缀的 HMAC），不要自己拼字符串。
// scripts/check-boundaries.mjs 会扫这些写法；确实需要的地方（比如这里的泄露检查）在同一行或上一行写
// `// boundary-allow: opaque-id <理由>`。
import crypto from 'node:crypto';

export const MAX_ID_LENGTH = 512;
// 控制字符（含 DEL）不许出现在 id 里：日志、文件名、SQL 都可能被它弄乱
const CONTROL = /[\u0000-\u001f\u007f]/;   // boundary-allow: opaque-id 只检查字符类别，不解析结构

/** 是不是一个合格的不透明 id：非空字符串、长度有限、没有控制字符。 */
export function isOpaqueId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH && !CONTROL.test(v);   // boundary-allow: opaque-id 同上
}

/** 两个不透明 id 是不是同一个。唯一允许的比较方式。 */
export const sameId = (a, b) => isOpaqueId(a) && a === b;

/**
 * 把若干段值无歧义地编码成一个 Buffer：每段前面写 4 字节长度。
 * 用它代替 `${a}:${b}` 这类拼接，避免「a:b」+「c」和「a」+「b:c」撞在一起。
 */
export function encodeParts(...parts) {
  const bufs = [];
  for (const p of parts) {
    const b = Buffer.from(p == null ? '' : String(p), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    bufs.push(len, b);
  }
  return Buffer.concat(bufs);
}

/**
 * 用一个密钥（盐）把几段值变成新的不透明 id（base64url，43 字符）。
 * 适配器用它把「群号」「私聊对象的账号」变成 SettingId（§4.2：SettingId 里不许出现账号原值）；
 * 核心用同一个原语算 HMAC(adapterId, SettingId) 等存储键。
 * @param {Buffer|string} key
 * @param {...unknown} parts
 */
export function opaqueFrom(key, ...parts) {
  return crypto.createHmac('sha256', key).update(encodeParts(...parts)).digest('base64url');
}

/**
 * 文本哈希：NFKC、折叠空白、去首尾空白后取 sha256 的前 32 位十六进制。
 * expectRelay()、outcome() 的 textHash、自身发言回流对账都用它，两边必须是同一个算法。
 */
export function textHash(text) {
  const norm = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 契约测试用：SettingId 里有没有出现某个账号 claim 的 id 原值（§4.2）。
 * 只用在测试和启动自检里，业务代码不需要。
 * @param {string} settingId
 * @param {import('./types.js').IdentityClaim[]} claims
 */
export function settingIdLeaksAccount(settingId, claims) {
  for (const c of claims ?? []) {
    if (c?.kind !== 'account' || typeof c.id !== 'string' || c.id.length < 3) continue;
    if (settingId.includes(c.id)) return true;   // boundary-allow: opaque-id 契约测试：检查账号原值有没有泄露进 SettingId
  }
  return false;
}
