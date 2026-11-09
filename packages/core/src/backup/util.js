// backup 模块内部的小工具：目录、时间戳、本地时间、暂存目录、身份密钥文件、配置差异。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULTS, defaultAt } from '../config/defaults.js';

export const DAY = 86_400_000;

/**
 * 参数快照里的一项（'backup.drill.sample'）：每次读当前快照（热加载）；快照的键是全的，只有测试里手搭的 core 缺键时退回 DEFAULTS（D25）。
 * @param {object} core
 * @param {string} p
 * @returns {any}
 */
export function param(core, p) {
  let v = core.config.get();
  for (const k of p.split('.')) {
    if (v == null || typeof v !== 'object') { v = undefined; break; }
    v = v[k];
  }
  return v ?? defaultAt(p);
}
export const PACK_KINDS = Object.freeze(['daily', 'weekly', 'monthly', 'pre-op', 'manual']);
const STAGING = '.staging';

/** 本机备份目录：<dataDir>/backup（§12.4.3）。 */
export const backupRoot = (core) => path.join(core.dataDir, 'backup');
/** 每种包一个子目录（文件名里只有种类、时间和随机后缀，没有人名，§12.4.8）。 */
export const kindDir = (core, kind) => path.join(backupRoot(core), kind);
export const exportDir = (core) => path.join(backupRoot(core), 'export');
/** 异地目录（空 = 没设置）。 */
export function offsiteRoot(core) {
  const d = core.config.get().backup?.offsiteDir;
  return typeof d === 'string' && d.trim() ? d : null;
}

/** 'YYYYMMDDTHHMMSSZ'（UTC）。 */
export const stampOf = (at) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
/** 原因只留 [a-z0-9-]，最多 24 个字符（文件名用）。 */
export const reasonTag = (reason) => String(reason ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);

/** 本地时间的偏移（分钟）：config.time.tzOffsetMin，null = 本机时区（D19）。 */
export function tzOffsetMin(core, at) {
  const v = core.config.get().time?.tzOffsetMin;
  return typeof v === 'number' ? v : -new Date(at).getTimezoneOffset();
}
/** 本地日历的各部分（按 UTC 的方法读偏移后的时间）。 */
export function localParts(core, at) {
  const off = tzOffsetMin(core, at) * 60_000;
  const d = new Date(at + off);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off;
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - off;
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), weekday: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dayStart, monthStart };
}
const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:mm'（本地时间，确认语用）。 */
export function localMinute(core, at) {
  const p = localParts(core, at);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`;
}

/** 一个新的暂存目录（和数据在同一块盘上，不用系统临时目录：C 盘快满了）。 */
export function makeStaging(core, purpose) {
  const dir = path.join(backupRoot(core), STAGING, `${reasonTag(purpose) || 'work'}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function removeDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* 下次轮转时再清 */ }
}
/** 崩溃留下的暂存目录（超过 maxAgeMs 的）清掉。 */
export function sweepStaging(core, maxAgeMs = DAY) {
  const root = path.join(backupRoot(core), STAGING);
  let removed = 0;
  let list = [];
  try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  const now = Date.now();
  for (const e of list) {
    const p = path.join(root, e.name);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) { removeDir(p); removed += 1; }
    } catch { /* 忽略 */ }
  }
  return removed;
}

/** 身份哈希密钥文件的位置（api 把 opt.keyFile 放在 core.keyFile；没有时用数据目录里的默认位置）。 */
export function identityKeyFile(core) {
  return /** @type {any} */ (core).keyFile ?? path.join(core.dataDir, 'persona-memory.key');
}
/** 读身份哈希密钥的原始字节；读不了返回 null。 */
export function readIdentityKey(core) {
  try {
    const key = Buffer.from(fs.readFileSync(identityKeyFile(core), 'utf8').trim(), 'base64');
    return key.length === 32 ? key : null;
  } catch { return null; }
}

/** 当前配置相对默认值改了哪些（= 主人的配置）。只比较默认值里有的键。 */
export function configDiff(cur, base = DEFAULTS) {
  const out = {};
  for (const [k, v] of Object.entries(cur ?? {})) {
    if (!(k in (base ?? {}))) continue;
    const b = base[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) {
      const d = configDiff(v, b);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) {
      out[k] = v;
    }
  }
  return out;
}

/** 这台机器的指纹（HMAC，不存机器名本身，§12.4.1）。 */
export const machineHash = (core) => core.keys.hash('backup-machine', os.hostname());

/** 核心的版本号（manifest 里记，换版本后的导入器据此兼容）。 */
export const CORE_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null; } catch { return null; }
})();

/** 原子写一个文件（先写临时文件再改名）。 */
export function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, mode != null ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** 把文件挪到 dest（同一块盘直接改名，跨盘复制）。 */
export function moveFile(src, dest) {
  try { fs.renameSync(src, dest); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
}

/** 磁盘剩余（字节）；查不了返回 null。 */
export function freeBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}
