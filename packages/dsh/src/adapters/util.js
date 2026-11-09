// 适配器共用的小工具：日志归一、容错的 JSON 解析、按文件指纹缓存的读取、可注入的文件和定时器、适配器自己的盐。
// 规矩：只依赖 node 内置模块和核心契约；日志只记事件名和数字，不记消息内容、不记账号（§3.3 Logger、§13.3）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { opaqueFrom } from 'rugu-core/contract';

const noop = () => {};
const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * 把 deps.log 归一成 {debug, info, warn, error}(event, fields)。
 * 接受核心 Logger 端口的形状（对象），或者 (level, event, fields) 形式的函数；日志自己出错不外抛。
 * @param {unknown} log
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
export function mkLog(log) {
  const out = {};
  for (const level of LEVELS) {
    const target = log && typeof log === 'object' && typeof log[level] === 'function' ? (e, f) => log[level](e, f)
      : typeof log === 'function' ? (e, f) => log(level, e, f) : noop;
    out[level] = (event, fields) => { try { target(event, fields ?? {}); } catch { /* 日志坏了不影响适配器 */ } };
  }
  return /** @type {any} */ (out);
}

/** 普通对象（不是数组、不是 null）。 */
export const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 原型污染的键一律跳过。 */
export const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 容错的 JSON 解析：去 BOM；空文件、半截文件、坏文件都返回 {ok:false}，不抛错。
 * @param {unknown} text
 * @returns {{ok: true, value: unknown} | {ok: false, error: 'empty'|'parse'}}
 */
export function parseJson(text) {
  if (typeof text !== 'string') return { ok: false, error: 'parse' };
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!s.trim()) return { ok: false, error: 'empty' };
  try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false, error: 'parse' }; }
}

const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

/**
 * 注入的同步函数；给的是异步的（返回 Promise，例如宿主传的 fs.promises.readFile / stat）就改用 node 的同步实现。
 * 适配器读桥接文件必须同步、一次读完就关（H2），读到一半让出事件循环会撞上桥接的 rename。
 * @param {Function|undefined} fn
 * @param {(p: string) => any} fallback
 * @param {(r: any) => any} normalize
 */
function syncOrFallback(fn, fallback, normalize) {
  if (typeof fn !== 'function') return fallback;
  let async = false;
  return (p) => {
    if (async) return fallback(p);
    const r = fn(p, 'utf8');
    if (isThenable(r)) {
      async = true;
      r.then(noop, noop);   // 那一次异步的结果不要，也别留下未处理的 rejection
      return fallback(p);
    }
    return normalize(r);
  };
}
const syncRead = (p) => fs.readFileSync(p, 'utf8');
const syncStat = (p) => {
  try { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; } catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
};
const textOf = (r) => (Buffer.isBuffer(r) ? r.toString('utf8') : r);
/** fs.Stats 或 {size, mtimeMs} → {size, mtimeMs}；文件不在 → null。 */
const stampFields = (r) => (r && Number.isFinite(Number(r.size)) ? { size: Number(r.size), mtimeMs: Number(r.mtimeMs) || 0 } : null);

/**
 * 文件和定时器的默认实现（测试里整套换掉）。都是同步读：桥接的文件只有几百 KB，一次读完立即关闭，不长期持有句柄（H2）。
 * 两种注入形状都认：测试的同步 readFile(p) / stat(p) / watch(dir, cb)，宿主的
 * readFileSync(f, enc) / readFile(f, enc)（异步）/ stat(f)（异步）/ watch(f, opt, cb)（fs.watch 的签名）。
 * @param {object} deps
 * @returns {{readFile: (p: string) => string, stat: (p: string) => ({size: number, mtimeMs: number}|null),
 *            watch: (dir: string, cb: (event: string, file: string|null) => void) => ({close: () => void}),
 *            timers: {setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function},
 *            now: () => number}}
 */
export function ioOf(deps = {}) {
  const readFile = syncOrFallback(typeof deps.readFileSync === 'function' ? deps.readFileSync : deps.readFile, syncRead, textOf);
  const statRaw = syncOrFallback(typeof deps.statSync === 'function' ? deps.statSync : deps.stat, syncStat, stampFields);
  const stat = (p) => { try { return statRaw(p); } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } };
  const watch = (dir, cb) => {
    const listener = (event, file) => cb(event, file == null ? null : String(file));
    const w = typeof deps.watch !== 'function' ? fs.watch(dir, { persistent: false }, listener)
      : deps.watch.length >= 3 ? deps.watch(dir, { persistent: false }, listener) : deps.watch(dir, listener);
    try { w?.on?.('error', noop); } catch { /* 没有 on 的替身 */ }
    return w;
  };
  const t = deps.timers ?? {};
  const timers = {
    setTimeout: t.setTimeout ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }),
    clearTimeout: t.clearTimeout ?? clearTimeout,
    setInterval: t.setInterval ?? ((fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; }),
    clearInterval: t.clearInterval ?? clearInterval,
  };
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  return { readFile, stat, watch, timers, now };
}

/** 读失败的种类：读不动（占用、权限，等会儿可以再试）还是内容坏了（等文件变了再说）。 */
const IO_RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
export const isRetryableIo = (e) => IO_RETRYABLE.has(e?.code);

/** 文件指纹（大小 + 修改时间）。文件不在返回 null。 */
export function stampOf(io, file) {
  const s = io.stat(file);
  return s ? `${s.size}:${s.mtimeMs}` : null;
}

/**
 * 按指纹缓存的 JSON 文件：指纹没变就用上次投影的结果；变了才读、解析、投影。
 * 解析失败时保留上一次好的值（配置这类文件半截时别把已知的设置丢掉），ok=false 让自检看得到。
 * 投影函数只取白名单字段，原始对象读完就丢（§11.1：读进来立刻丢掉凭据一类的东西）。
 * @template T
 * @param {ReturnType<typeof ioOf>} io
 * @param {string} file
 * @param {(raw: unknown) => T} project
 */
export function createJsonCache(io, file, project) {
  let stamp;           // undefined = 还没读过
  /** @type {{value: T|null, ok: boolean, missing: boolean, error?: string}} */
  let last = { value: null, ok: false, missing: true };
  return {
    file,
    /** @returns {{value: T|null, ok: boolean, missing: boolean, error?: string}} */
    get() {
      let s;
      try { s = stampOf(io, file); } catch (e) { return { ...last, ok: false, error: isRetryableIo(e) ? 'busy' : 'io' }; }
      if (s === stamp) return last;
      if (s === null) { stamp = s; last = { value: null, ok: true, missing: true }; return last; }
      let text;
      try { text = io.readFile(file); } catch (e) {
        if (e?.code === 'ENOENT') { stamp = null; last = { value: null, ok: true, missing: true }; return last; }
        return { ...last, ok: false, error: isRetryableIo(e) ? 'busy' : 'io' };   // 不记指纹：下次再试
      }
      stamp = s;
      const p = parseJson(text);
      if (!p.ok) { last = { ...last, ok: false, missing: false, error: p.error }; return last; }
      try { last = { value: project(p.value), ok: true, missing: false }; } catch { last = { ...last, ok: false, missing: false, error: 'project' }; }
      return last;
    },
    /** 下次 get() 一定重读。 */
    invalidate() { stamp = undefined; },
  };
}

// ── 适配器自己的盐（§4.2、§11.1：SettingId、ObsId 都用它 HMAC，不含账号原值）──
/** 身份哈希密钥的文件名（§12.1：DSH 上是 ~/.dsh/persona-memory.key，随备份包和私有 kit 走）。 */
export const IDENTITY_KEY_FILE = 'persona-memory.key';
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const saltOk = (s) => (typeof s === 'string' && s.length >= 16) || (Buffer.isBuffer(s) && s.length >= 16);

/**
 * 从身份哈希密钥派生一个适配器的盐。算法固定，名字用宿主 host.adapters 配置里的键（'qq'、'web'）：
 * 谁照这个算法算（适配器自己、宿主、工具），得到的都是同一个盐，SettingId 都一样。
 * @param {Buffer} key       32 字节
 * @param {string} name
 * @returns {string}         base64url
 */
export const deriveAdapterSalt = (key, name) => opaqueFrom(key, 'persona-memory/adapter-salt', name);

/**
 * 适配器的盐，必须稳定：换了盐，同一个群就成了一个新场合，游标也对不上。按顺序找：
 *   1. deps.salt（宿主或测试直接给）；给了但太短就报错，不悄悄换成别的；
 *   2. 从身份哈希密钥派生（deriveAdapterSalt）。密钥随每个备份包走（§12.4.1），恢复、换电脑之后 SettingId 不变；
 *      派生是单向的，盐泄露推不回密钥。位置：paths.keyFile，或 paths.dshHome 下的默认文件名。密钥文件格式不对就报错；
 *   3. 数据目录下适配器自己的盐文件（paths.dataDir/adapter-salt/<名字>.salt，没有就生成）：只在本机稳定，不在备份包里。
 * 盐和密钥的内容永远不进日志、不进状态。
 * @param {{salt?: unknown, paths?: {keyFile?: string, dshHome?: string, dataDir?: string}}} deps
 * @param {string} adapterId
 * @param {string} [name]    派生用的名字（默认 = adapterId；和宿主配置里的键一致）
 * @returns {{salt: Buffer|string, source: 'deps'|'identity-key'|'local-file'}}
 */
export function resolveSalt(deps, adapterId, name = adapterId) {
  const given = deps?.salt;
  if (given !== undefined && given !== null) {
    if (!saltOk(given)) throw Object.assign(new TypeError(`适配器 ${adapterId}：salt 至少 16 字节`), { code: 'PM_ADAPTER_SALT' });
    return { salt: given, source: 'deps' };
  }
  const p = isRecord(deps?.paths) ? deps.paths : {};
  const keyFile = typeof p.keyFile === 'string' && p.keyFile ? p.keyFile
    : typeof p.dshHome === 'string' && p.dshHome ? path.join(p.dshHome, IDENTITY_KEY_FILE) : null;
  if (keyFile) {
    let raw = null;
    try { raw = fs.readFileSync(keyFile, 'utf8').trim(); } catch (e) {
      if (e?.code !== 'ENOENT') throw Object.assign(new Error(`适配器 ${adapterId}：读不了身份哈希密钥`), { code: 'PM_ADAPTER_KEY_IO' });
    }
    if (raw !== null) {
      const key = Buffer.from(raw, 'base64');
      if (key.length !== KEY_BYTES) throw Object.assign(new Error(`适配器 ${adapterId}：身份哈希密钥文件格式不对`), { code: 'PM_ADAPTER_KEY_FORMAT' });
      return { salt: deriveAdapterSalt(key, name), source: 'identity-key' };
    }
  }
  if (typeof p.dataDir === 'string' && p.dataDir) {
    const file = path.join(p.dataDir, 'adapter-salt', `${name}.salt`);
    const read = () => { const b = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64'); return b.length >= 16 ? b : null; };
    try { const b = read(); if (b) return { salt: b, source: 'local-file' }; } catch (e) {
      if (e?.code !== 'ENOENT') throw Object.assign(new Error(`适配器 ${adapterId}：盐文件读不了`), { code: 'PM_ADAPTER_SALT_IO' });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.writeFileSync(file, `${crypto.randomBytes(SALT_BYTES).toString('base64')}\n`, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
    const b = read();
    if (b) return { salt: b, source: 'local-file' };
  }
  throw Object.assign(new TypeError(`适配器 ${adapterId}：需要 salt（至少 16 字节、稳定、保密），或者 paths.dshHome / paths.dataDir 让它自己找`), { code: 'PM_ADAPTER_SALT' });
}
