// backup 模块（§12.4、§12.5 迁移前快照）：向量能重建，经历不能。多份、多处、加密、每份验证、一键恢复、能搬到新电脑。
//   - 记忆包 *.pmpack：manifest.json + 主库快照（node:sqlite 模块级 backup()；周包、月包用 VACUUM INTO 压实）+ 身份密钥（包内单独加密）
//     + 配置 + 可选的向量库；整体 node:zlib 压缩，异地副本 node:crypto AES-256-GCM 加密（密钥由恢复码经 scrypt 派生）。不依赖第三方库。
//     格式见 format.js，加密见 crypto.js。
//   - 日包 7 / 周包 4 / 月包 12 / 操作前快照 10（config.backup.retention），手动的不自动删；验证不过的不参与轮转删除。
//   - 整体恢复：先给当前库做「恢复前」快照；**先读出当前库的墓碑**再换库（换回来的旧库里没有之后的墓碑），换完按墓碑重删；
//     按各适配器游标补回快照之后的经历（历史模式）；向量库对账或重建；恢复后重新扫描备份目录（backups 表也被换回了旧的）。
//   - 包的文件名里没有人名；下载只给主人（集成层负责鉴权）。
//   - > 50 ms 的数据库活（integrity_check、条数、VACUUM INTO、对比、导出）都在本模块的短命线程里做（thread.js）。
// 拥有的表：backups、restore_drills。
// 用到的端口：clock、logger。
// 契约细节：docs/实现/模块与接口.md §4.11。
import fs from 'node:fs';
import path from 'node:path';
import { bumpMetric } from '../store/index.js';
import { ReadOnlyError } from '../contract/errors.js';
import * as packs from './packs.js';
import * as restore from './restore.js';
import * as exporter from './export.js';
import * as bcrypto from './crypto.js';
import { readPack, readPackHeader } from './format.js';
import { backupRoot, offsiteRoot, freeBytes, removeDir, param } from './util.js';

/**
 * @typedef {object} PackInfo
 * @property {number} id            backups 表的行（迁移前快照当时没法登记时为 null，之后补登记）
 * @property {string} path
 * @property {'daily'|'weekly'|'monthly'|'pre-op'|'manual'} kind
 * @property {number} size
 * @property {string} sha256
 * @property {boolean} encrypted
 * @property {boolean} includesVectors
 * @property {'local'|'offsite'} [location]   【补】
 * @property {boolean} [verified]             【补】写完后验证通过
 * @property {number} [createdAt]             【补】
 */
/**
 * 整体恢复后某个场合快照之后的那段（§12.4.5 第 6、8 步）。label 是场合的显示名（只给主人看的总览用）。
 * @typedef {object} ReplayGap
 * @property {string} settingKey
 * @property {string} label
 * @property {number} from
 * @property {number} to
 * @property {number} missing      还没补回的条数
 * @property {number} [count]      快照之后那段原本有多少条（补回进行中才有）
 * @property {number} [refilled]   已经补回多少条（补回进行中才有）
 */

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  // 迁移前快照（init 之前）留下的待登记项、恢复中的标记要保留：reopen 会重新 init
  const prev = core.state.backup;
  core.state.backup = { queue: prev?.queue ?? Promise.resolve(), pending: prev?.pending ?? [], restoring: prev?.restoring ?? null };
  // 库已经就位（迁移跑完了）：迁移前快照马上补登记，不等下一次做包或轮转——进程在那之前退出的话，那一行要等 rescan 才回来
  if (!core.state.backup.pending.length || core.readOnly) return;
  try {
    const n = packs.flushPending(core);
    if (n) core.log.info('backup.pending-registered', { n });
  } catch (e) {
    core.log.warn('backup.pending-register-failed', { error: e?.code ?? e?.name ?? 'Error' });   // 留在内存里，下次做包时再补
  }
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) { /* 线程都是短命的，没有常驻资源 */ }

/** 本机备份目录：<dataDir>/backup。 */
export const backupDir = (core) => backupRoot(core);

/**
 * 操作前快照（迁移、恢复、换档切换、按来源撤回、批量彻底删除、原文到期删除之前，§12.4.2）：一份本机的、验证过的记忆包，登记进 backups
 * （迁移前 backups 表可能还不存在，就先记在内存里，之后补登记；rescan 也会按目录补上）。验证不过就抛错——宁可这次不做那个操作。
 * 迁移时 core.store 还没就位，用 info.store。不排队：迁移可能正发生在整体恢复的换库过程中。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{reason: string, from?: number, to?: number, store?: import('../store/db.js').Store}} info
 * @returns {Promise<string>} 本机包的路径
 */
export async function preOperationSnapshot(core, info) {
  const store = info.store ?? core.store;
  const reason = info.from != null ? `${info.reason}-v${Number(info.from)}` : info.reason;
  const [local] = await packs.makePack(core, { kind: 'pre-op', reason, store, offsite: false, includeVectors: false });
  if (!local?.verified) throw new Error('操作前快照验证不过');
  return local.path;
}

/**
 * 做一个记忆包（§12.4.1），写本机目录；设了异地目录就再加密复制一份过去。写完逐份验证（verifyPack 的同一套核对）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'daily'|'weekly'|'monthly'|'pre-op'|'manual', reason?: string, includeVectors?: boolean}} opt
 * @returns {Promise<PackInfo[]>}   本机一份，异地可能再一份
 */
export async function createPack(core, opt) {
  if (core.readOnly) throw new ReadOnlyError('只读模式下不做备份登记');
  return packs.serialize(core, () => packs.makePack(core, opt ?? { kind: 'manual' }));
}

/**
 * 验证一个包（§12.4.4）：sha256、解开后在线程里 integrity_check、各表条数和 manifest 对得上。不通过就标红，不参与轮转删除。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} packPath
 * @param {{recoveryCode?: string}} [opt]
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function verifyPack(core, packPath, opt) {
  return packs.verifyAndRecord(core, packPath, opt ?? {});
}

/**
 * 轮转删除（日 7 / 周 4 / 月 12 / 操作前 10）。所在盘剩余 < lowDiskGb 时先删最旧的日包并报警；月包和操作前快照不自动删。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<{deleted: number}>}
 */
export async function rotate(core) { return packs.rotate(core); }

/**
 * 夜间整理开始前调用：该做的日包 / 周包（周日，带向量库）/ 月包（每月 1 日，带向量库），做完轮转；每周一次恢复演练；每月一份 JSONL 导出。
 * 某一步失败只记日志，不影响后面的步骤，也不往外抛。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at: number, signal?: AbortSignal}} opt
 * @returns {Promise<PackInfo[]>}
 */
export async function runScheduled(core, opt) {
  if (core.readOnly) return [];
  try { return await packs.runScheduled(core, opt ?? { at: core.now() }); } catch (e) {
    core.log.error('backup.scheduled', { error: e?.code ?? e?.name ?? 'Error' });
    try { bumpMetric(core.store, 'backup.scheduled.error'); } catch { /* 忽略 */ }
    return [];
  }
}

/**
 * 恢复演练（§12.4.4）：最新的包完整恢复到备份目录下的临时目录，随机抽 config.backup.drill.sample 条记忆走一遍检索，确认能找回，删掉临时目录。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<{ok: boolean, sampled: number, found: number}>}
 */
export async function restoreDrill(core) {
  return packs.serialize(core, () => packs.restoreDrill(core));
}

/**
 * 整体恢复前的预览（§12.4.5 第 1 步）：包的时间、条数，和当前库比多了、少了多少记忆、涉及哪些人、要补回的经历、确认语。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} packPath
 * @param {{recoveryCode?: string}} [opt]
 * @returns {Promise<object>}
 */
export async function previewRestore(core, packPath, opt) {
  return restore.previewRestore(core, packPath, opt ?? {});
}

/**
 * 整体恢复（§12.4.5 第 2–8 步）。用 core.reopen(swap) 换库：swap 里替换主库、处理残留的 -wal / -shm、需要时换身份密钥。
 * 换完：admin.reapplyTombstones（用换库前读出的墓碑）→ 按游标补回快照之后的经历（历史模式，replayWindow）→ worker.sweepVectors → rescan。
 * confirmPhrase 必须和 previewRestore 给出的确认语一致。opt.restoreConfig（【补】）不给时：新机器（或当前库是空的）才用包里的配置。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} packPath
 * @param {{confirmPhrase: string, recoveryCode?: string, restoreConfig?: boolean}} opt
 * @returns {Promise<{ok: boolean, gaps: {from: number, to: number, settingKey?: string}[]}>}
 */
export async function restoreFull(core, packPath, opt) {
  return restore.restoreFull(core, packPath, opt);
}

/**
 * 部分恢复（§12.4.5）：只取回某个人、某个场合或某段时间以前的版本，以导入的方式合并进当前库，有冲突的走对账（encode）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} packPath
 * @param {{entityIds?: number[], settingKeys?: string[], before?: number}} selector
 * @param {{recoveryCode?: string}} [opt]
 * @returns {Promise<import('../contract/types.js').ImportReport>}
 */
export async function restorePartial(core, packPath, selector, opt) {
  return restore.restorePartial(core, packPath, selector, opt ?? {});
}

/**
 * 可移植导出（§12.4.7）：实体、身份证据、事实（含历史版本）、情节、意图、流动规范、来源、原文窗口、她自己，JSONL，
 * 不依赖数据库结构和嵌入模型。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{dest: string, encrypt?: boolean}} opt
 * @returns {Promise<{path: string, counts: Record<string, number>}>}
 */
export async function exportJsonl(core, opt) { return exporter.exportJsonl(core, opt); }

/**
 * 重新扫描本机和异地备份目录，按每个包的 manifest 重建 backups 表（恢复之后必须做）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<{found: number}>}
 */
export async function rescan(core) { return packs.rescan(core); }

/**
 * 生成恢复码（第一次开启异地备份时，管理页只显示这一次，§12.4.3）。
 * @returns {string}
 */
export function generateRecoveryCode() { return bcrypto.generateRecoveryCode(); }

// ── 【补】管理页和其他模块要用的 ──────────────────────────────────────────

/**
 * 开启（或换）备份加密：用恢复码派生密钥，存进本机备份密钥文件，之后的包用它加密。不给 recoveryCode 就生成一个并返回（只显示这一次）。
 * 换恢复码时旧的那把留在文件里，老的异地包照样能解开。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{recoveryCode?: string}} [opt]
 * @returns {Promise<{keyId: string, recoveryCode?: string}>}
 */
export async function setupEncryption(core, opt = {}) {
  const code = opt.recoveryCode ?? bcrypto.generateRecoveryCode();
  const kdf = bcrypto.newKdf(core);
  const key = await bcrypto.deriveKey(code, kdf);
  const keyId = bcrypto.installBackupKey(core, key, kdf, { makeActive: true });
  core.log.info('backup.encryption-enabled', { keyId });
  return opt.recoveryCode ? { keyId } : { keyId, recoveryCode: code };
}

/**
 * 备份的健康状况（总览，§13.1）：上次备份、验证、演练、异地、磁盘、补不回的时间段。只有数字、时间和路径。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{packs: Record<string, Record<string, number>>, last: {path: string, kind: string, at: number, status: string}|null,
 *            lastOk: number|null, lastDrill: {at: number, ok: boolean, sampled: number, found: number}|null,
 *            offsite: {configured: boolean, encrypted: boolean}, diskFreeGb: number|null, lowDisk: boolean,
 *            replay: ReplayGap[]|null, gaps: ReplayGap[], unverified: number, failed: number, totalBytes: number}}
 *          packs：kind → location → 份数；replay：恢复后还在补回时，各场合正在补的那段（带 count / refilled，补完为 null）；
 *          gaps：补回结束之后仍补不回的时间段
 */
export function overview(core) {
  const out = { packs: {}, last: null, lastOk: null, lastDrill: null, offsite: { configured: !!offsiteRoot(core), encrypted: false },
    diskFreeGb: null, lowDisk: false, replay: null, gaps: [], unverified: 0, failed: 0, totalBytes: 0 };
  try { out.offsite.encrypted = !!bcrypto.activeBackupKey(core); } catch { out.offsite.encrypted = false; }
  const free = freeBytes(backupRoot(core));
  if (free != null) { out.diskFreeGb = Math.round(free / 1e8) / 10; out.lowDisk = free < param(core, 'backup.lowDiskGb') * 1e9; }
  if (!packs.hasBackupsTable(core.store)) return out;
  for (const r of core.store.all("SELECT kind, location, count(*) AS n, sum(size) AS bytes, sum(verify_status = 'failed') AS failed, sum(verify_status = 'pending') AS pending FROM backups WHERE deleted_at IS NULL GROUP BY kind, location")) {
    (out.packs[r.kind] ??= {})[r.location] = Number(r.n);
    out.totalBytes += Number(r.bytes ?? 0);
    out.failed += Number(r.failed ?? 0);
    out.unverified += Number(r.pending ?? 0);
  }
  const last = core.store.get("SELECT path, kind, created_at, verify_status FROM backups WHERE deleted_at IS NULL AND location = 'local' ORDER BY created_at DESC, id DESC LIMIT 1");
  if (last) out.last = { path: last.path, kind: last.kind, at: last.created_at, status: last.verify_status };
  const lastOk = core.store.get("SELECT created_at FROM backups WHERE deleted_at IS NULL AND location = 'local' AND verify_status = 'ok' ORDER BY created_at DESC LIMIT 1");
  out.lastOk = lastOk?.created_at ?? null;
  const d = core.store.get('SELECT at, status, sampled, found FROM restore_drills ORDER BY at DESC, id DESC LIMIT 1');
  if (d) out.lastDrill = { at: d.at, ok: d.status === 'ok', sampled: d.sampled, found: d.found };
  try { const r = restore.replayStatus(core); out.replay = r.active ? r.gaps : null; out.gaps = r.active ? [] : r.gaps; } catch { /* 忽略 */ }
  return out;
}

/**
 * 解开一个包到 dest 目录（诊断、命令行兜底恢复、测试用），先完整核对。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} packPath
 * @param {{dest: string, recoveryCode?: string}} opt
 * @returns {Promise<{dir: string, files: Record<string, string>, manifest: object, header: object}>}
 */
export async function unpack(core, packPath, opt) {
  const u = await packs.unpackVerified(core, packPath, { recoveryCode: opt?.recoveryCode, keep: true, purpose: 'unpack' });
  if (!u.ok) throw Object.assign(new Error(`包验证不过：${u.errors.join(',')}`), { code: 'PACK_INVALID', errors: u.errors });
  try {
    fs.mkdirSync(opt.dest, { recursive: true });
    const files = {};
    for (const [name, f] of Object.entries(u.files)) { const to = path.join(opt.dest, name); fs.copyFileSync(f, to); files[name] = to; }
    return { dir: opt.dest, files, manifest: u.manifest, header: u.header };
  } finally { removeDir(u.dir); }
}

/**
 * 只读 manifest（加密的包需要本机密钥或恢复码）。不解开主库，不验证。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} packPath
 * @param {{recoveryCode?: string}} [opt]
 * @returns {Promise<{format: number, kind: string, createdAt: number, packId?: string, coreVersion?: string, schemaVersion?: number,
 *                    counts?: Record<string, number>, [k: string]: unknown}>}
 */
export async function readManifest(core, packPath, opt = {}) {
  const { header } = await readPackHeader(packPath);
  let key = null;
  if (header.encrypted) key = (await bcrypto.resolveKey(core, header.enc, opt)).key;
  return (await readPack(packPath, { manifestOnly: true, key })).manifest;
}

/** 整体恢复进行中吗（intake 恢复期间先不入库、context 不注入新回想）。 */
export const isRestoring = (core) => restore.isRestoring(core);
/** 恢复后的补回窗口：这段时间交来的、发生在 until 之前的消息按历史模式入库（intake 读它）。 */
export const replayWindow = (core) => restore.replayWindow(core);
/** 补回进度；补完或窗口过了就结束跟踪，剩下的空白记给总览。 */
export const replayStatus = (core) => restore.replayStatus(core);
/**
 * 彻底删除时「同时从所有本地备份里清除」：按墓碑重写每个包（admin.purge alsoBackups=true 时调用）。
 * 【D143】返回 {rewritten, failed, skipped, failures: [{id, reason}]}：解不开、文件不见了、改写出错的包算没改成，带原因。
 */
export const scrubPacks = (core, opt) => packs.scrubPacks(core, opt);
/** 每月一份 JSONL 导出（runScheduled 在做月包的那晚调用）。 */
export const exportMonthly = (core, opt) => exporter.exportMonthly(core, opt);
/** 一个包的登记（按路径）。 */
export const packInfo = (core, packPath) => packs.packRow(core, packPath);
/** 现在该做哪些包（runScheduled 的判断，给总览和测试）。 */
export const duePacks = (core, at) => packs.duePacks(core, at);
/** 恢复的确认语（预览里给，restoreFull 核对）。 */
export const confirmPhraseFor = (core, createdAt) => restore.confirmPhraseFor(core, createdAt);
