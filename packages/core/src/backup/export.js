// 可移植导出（§12.4.7）：实体、身份证据、事实（含历史版本）、情节、意图、流动规范、来源、原文窗口、她自己，JSONL。
// 不依赖数据库结构和嵌入模型：每行一个自描述的对象（type 字段），以后插件大改版、换存储都能用它导入；也是一份人能读懂的「她的全部记忆」。
// 导出在备份线程里用一个只读事务读，是一致的快照。encrypt=true 时装进加密的包（kind='export'，条目 export.jsonl）。
// 身份哈希密钥不进导出（它在记忆包里）；header 里只记它的指纹，导入时据此确认拿到的是对的那把。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePack, PACK_EXT } from './format.js';
import { activeBackupKey, BackupKeyError } from './crypto.js';
import { runDbTask } from './thread.js';
import { exportDir, offsiteRoot, stampOf, makeStaging, removeDir, readIdentityKey, CORE_VERSION, param } from './util.js';

function destFile(dest, at, ext) {
  const isDir = /[\\/]$/.test(dest) || (fs.existsSync(dest) && fs.statSync(dest).isDirectory());
  const file = isDir ? path.join(dest, `pm-export-${stampOf(at)}${ext}`) : dest;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/**
 * @param {object} core
 * @param {{dest: string, encrypt?: boolean}} opt   dest 是目录（自动起名）或文件路径
 * @returns {Promise<{path: string, counts: Record<string, number>}>}
 */
export async function exportJsonl(core, opt) {
  if (!opt || typeof opt.dest !== 'string' || !opt.dest) throw new TypeError('exportJsonl 需要 dest');
  const at = core.now();
  const idKey = readIdentityKey(core);
  const meta = { createdAt: at, coreVersion: CORE_VERSION, identityKeyId: idKey ? crypto.createHash('sha256').update('pm-identity-key/').update(idKey).digest('hex').slice(0, 16) : null };
  if (!opt.encrypt) {
    const file = destFile(opt.dest, at, '.jsonl');
    const tmp = `${file}.partial`;
    try {
      const r = await runDbTask('exportJsonl', { file: core.store.file, dest: tmp, meta });
      fs.renameSync(tmp, file);
      core.log.info('backup.exported', { encrypted: false, lines: Object.values(r.counts).reduce((a, b) => a + b, 0) });
      return { path: file, counts: r.counts };
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  let bk = null;
  try { bk = activeBackupKey(core); } catch { bk = null; }
  if (!bk) throw new BackupKeyError('NEED_RECOVERY_CODE', '加密导出需要先开启备份加密（恢复码）');
  const dir = makeStaging(core, 'export');
  try {
    const plain = path.join(dir, 'export.jsonl');
    const r = await runDbTask('exportJsonl', { file: core.store.file, dest: plain, meta });
    const file = destFile(opt.dest, at, PACK_EXT);
    await writePack(file, {
      header: { kind: 'export', createdAt: at, packId: crypto.randomBytes(8).toString('hex') },
      manifest: { format: 1, kind: 'export', createdAt: at, coreVersion: CORE_VERSION, counts: r.counts },
      entries: [{ name: 'export.jsonl', file: plain }],
      encryption: bk,
      level: param(core, 'backup.compressLevel'),
    });
    core.log.info('backup.exported', { encrypted: true, lines: Object.values(r.counts).reduce((a, b) => a + b, 0) });
    return { path: file, counts: r.counts };
  } finally { removeDir(dir); }
}

/** 每月一份：本机明文 JSONL（人能读），设了异地目录再放一份加密的。 */
export async function exportMonthly(core, { at = core.now() } = {}) {
  const out = [];
  out.push(await exportJsonl(core, { dest: `${exportDir(core)}${path.sep}` }));
  const off = offsiteRoot(core);
  if (off) {
    try { out.push(await exportJsonl(core, { dest: `${path.join(off, 'export')}${path.sep}`, encrypt: true })); } catch (e) {
      core.log.warn('backup.export-offsite-skipped', { error: e?.code ?? e?.name ?? 'Error' });
    }
  }
  return out;
}
