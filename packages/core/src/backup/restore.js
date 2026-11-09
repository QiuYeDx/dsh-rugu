// 恢复（§12.4.5、§12.4.6）：预览、整体恢复、部分恢复、恢复后「补回快照之后的经历」的跟踪。
//   - 整体恢复全程聊天照常（集成层照常调 API），只是这段时间不写入新记忆、不注入新回想（isRestoring）。
//   - 先做「恢复前」快照，所以恢复本身也能撤销；**换库前读出当前库的墓碑**，换库后按它们再删一遍（旧库里没有之后的墓碑）。
//   - 补回：恢复出的库里是快照时的游标，适配器从那里接着读，就会把快照之后的消息再交一遍；这段时间里交来的、发生在恢复之前的
//     消息按历史模式入库（replayWindow，intake 读它），不会冒出过期的「回头问问」。补不回的时间段记下来给总览。
//   - 她不会被告知「你被恢复了」：这里不写任何感知。
import fs from 'node:fs';
import path from 'node:path';
import { getMetaJson, setMetaJson, setMeta, makeKeyring, bumpMetric } from '../store/index.js';
import { validateImportRecords } from '../contract/validate.js';
import { unwrapSecret, installBackupKey, loadBackupKeys, resolveKey, BackupKeyError } from './crypto.js';
import { runDbTask } from './thread.js';
import { unpackVerified, rescan, serialize, makePack, hasBackupsTable } from './packs.js';
import { DAY, localMinute, removeDir, identityKeyFile, readIdentityKey, machineHash, writeFileAtomic, moveFile, param } from './util.js';

export class RestoreError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'RestoreError';
    this.code = code;
  }
}

/** 配置里只属于这台机器的项（恢复到新机器时不从包里拿）。 */
const MACHINE_LOCAL = ['offsiteDir', 'keyFile', 'configFile'];

/** 管理页给出的确认语（整体恢复要主人手动输入，不能只点一下）。 */
export const confirmPhraseFor = (core, createdAt) => `确认恢复到 ${localMinute(core, createdAt)} 的备份`;

function rs(core) {
  core.state.backup ??= { queue: Promise.resolve(), pending: [], restoring: null };
  return core.state.backup;
}

/**
 * 包里的身份密钥（解不开就报错：恢复后账号对不上人比不恢复更糟）。本机包本身不加密，但开过备份加密之后里面的身份密钥是包住的：
 * 拷到新机器上恢复时用恢复码 + 它自己记的 scrypt 参数解开（§12.4.6「拷过来的文件」）。
 * @returns {Promise<{key: Buffer|null, derived: {key: Buffer, kdf: object}|null}>}
 */
async function packIdentityKey(core, u, recoveryCode) {
  const f = u.files['identity.json'];
  if (!f) return { key: null, derived: null };
  const w = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!w.wrapped) return { key: Buffer.from(w.key, 'base64'), derived: null };
  let key = null;
  let derived = null;
  try { key = loadBackupKeys(core)?.keys.get(w.keyId)?.key ?? null; } catch { key = null; }
  if (!key && u.header.encrypted && u.header.enc?.keyId === w.keyId) key = u.key;
  if (!key && recoveryCode && w.kdf) {
    try { const r = await resolveKey(core, { keyId: w.keyId, kdf: w.kdf }, { recoveryCode }); key = r.key; if (r.fromCode) derived = { key: r.key, kdf: r.kdf }; } catch (e) {
      if (e?.code === 'WRONG_RECOVERY_CODE' || e?.code === 'RECOVERY_CODE_FORMAT') throw e;
    }
  }
  if (!key) throw new BackupKeyError('NEED_RECOVERY_CODE', '包里的身份密钥是加密的，需要恢复码');
  return { key: unwrapSecret(w, key), derived };
}

function currentlyEmpty(core) {
  try {
    const p = core.store.get('SELECT count(*) AS n FROM percepts').n;
    const a = core.store.get('SELECT count(*) AS n FROM assertions').n;
    const e = core.store.get('SELECT count(*) AS n FROM episodes').n;
    return Number(p) + Number(a) + Number(e) === 0;
  } catch { return true; }
}

/**
 * 整体恢复前的预览（§12.4.5 第 1 步）：包的时间、条数，和当前库比少了、多了多少记忆、涉及哪些人、恢复后要补回的经历。
 * 预览本身也完整核对一遍包，坏包在这一步就看得出来。
 */
export async function previewRestore(core, packPath, opt = {}) {
  const u = await unpackVerified(core, packPath, { ...opt, keep: true, purpose: 'preview' });
  if (!u.ok) return { ok: false, errors: u.errors, pack: u.header ? { path: packPath, kind: u.header.kind, createdAt: u.header.createdAt, encrypted: !!u.header.encrypted } : null };
  try {
    const cmp = await runDbTask('compare', { pack: u.files['main.db'], current: core.store.file, since: u.manifest.createdAt });
    const m = u.manifest;
    return {
      ok: true,
      errors: [],
      warnings: u.warnings,
      pack: { path: packPath, kind: m.kind, createdAt: m.createdAt, schemaVersion: m.schemaVersion, includesVectors: !!m.includesVectors,
        encrypted: !!u.header.encrypted, size: fs.statSync(packPath).size, coreVersion: m.coreVersion, counts: m.counts },
      diff: cmp.kinds,
      changed: cmp.changed,
      people: cmp.people,
      tombstonesToReapply: cmp.tombstoned,
      gaps: cmp.gaps,
      newMachine: m.machine !== machineHash(core) || currentlyEmpty(core),
      confirmPhrase: confirmPhraseFor(core, m.createdAt),
    };
  } finally { removeDir(u.dir); }
}

/** 恢复期间：她照常聊天，但不写入新记忆、不注入新回想（intake / context 读它）。 */
export const isRestoring = (core) => !!core.state.backup?.restoring;

/**
 * 整体恢复（§12.4.5 第 2–8 步、§12.4.6）。
 * @returns {Promise<{ok: boolean, gaps: {from: number, to: number, settingKey?: string}[], preRestorePack: string|null,
 *          identityKeyReplaced: boolean, configRestored: boolean, config?: object, tombstonesReapplied: number}>}
 */
export async function restoreFull(core, packPath, opt) {
  if (typeof opt?.confirmPhrase !== 'string') throw new RestoreError('CONFIRM_REQUIRED', '需要确认语');
  return serialize(core, () => doRestoreFull(core, packPath, opt));
}

async function doRestoreFull(core, packPath, opt) {
  const s = rs(core);
  const u = await unpackVerified(core, packPath, { recoveryCode: opt.recoveryCode, keep: true, purpose: 'restore' });
  if (!u.ok) throw new RestoreError('PACK_INVALID', `包验证不过：${u.errors.join(',')}`);
  let preRestore = null;
  try {
    if (opt.confirmPhrase !== confirmPhraseFor(core, u.manifest.createdAt)) throw new RestoreError('CONFIRM_MISMATCH', '确认语不对');
    const idk = await packIdentityKey(core, u, opt.recoveryCode);   // 解不开就在换库之前失败
    const packKey = idk.key;
    s.restoring = { startedAt: core.now(), packId: u.manifest.packId };

    // 第 3 步：「恢复前」快照（恢复本身也能撤销）
    preRestore = (await makePack(core, { kind: 'pre-op', reason: 'restore', offsite: false }))[0]?.path ?? null;

    // 换库之前读出：墓碑、快照之后的经历（补回用）、新机器与否
    const tombstones = core.store.all('SELECT kind, ref, at FROM tombstones ORDER BY id');
    // 包做完之后才入库的感知 = 恢复后会少掉、要从来源补回的经历
    const gapsRaw = core.store.all(`SELECT setting_key AS settingKey, count(*) AS n, min(at) AS "from", max(at) AS "to" FROM percepts
                                    WHERE created_at > ? GROUP BY setting_key`, u.manifest.createdAt);
    const newMachine = typeof opt.restoreConfig === 'boolean' ? opt.restoreConfig : (u.manifest.machine !== machineHash(core) || currentlyEmpty(core));
    const curKey = readIdentityKey(core);
    const replaceKey = !!packKey && (!curKey || !curKey.equals(packKey));
    const restoredAt = core.now();

    // 第 4 步：换库（关库 → 换文件、清掉残留的 -wal / -shm → 重新打开、迁移、各模块重新 init）
    let swapped = false;
    try {
      await core.reopen(async (files) => {
        moveFile(u.files['main.db'], `${files.main}.restoring`);
        for (const f of [`${files.main}-wal`, `${files.main}-shm`]) fs.rmSync(f, { force: true });
        fs.renameSync(`${files.main}.restoring`, files.main);
        swapped = true;
        if (u.files['vectors.db']) {
          moveFile(u.files['vectors.db'], `${files.vectors}.restoring`);
          for (const f of [`${files.vectors}-wal`, `${files.vectors}-shm`]) fs.rmSync(f, { force: true });
          fs.renameSync(`${files.vectors}.restoring`, files.vectors);
        }
        if (replaceKey) {
          writeFileAtomic(identityKeyFile(core), `${packKey.toString('base64')}\n`, 0o600);
          core.keys = makeKeyring(packKey);
        }
      });
    } catch (e) {
      await rollback(core, { swapped, preRestore, curKey, replaceKey });
      throw new RestoreError('RESTORE_FAILED', `换库失败，已回到恢复前的状态（${e?.code ?? e?.name ?? 'Error'}）`);
    }

    // 第 5 步：按换库前的墓碑再删一遍
    let reapplied = 0;
    try { reapplied = (await core.mods.admin.reapplyTombstones(core, { tombstones })).deleted; } catch (e) {
      core.log.error('backup.restore-tombstones-failed', { error: e?.code ?? e?.name ?? 'Error' });
      try { setMetaJson(core.store, 'backup.tombstonesPending', tombstones); } catch { /* 下次启动 reapply 会按库里的墓碑表再删 */ }
    }
    // 新机器：配置跟着包走（§12.4.6）；同一台机器上恢复不动现在的配置
    let configRestored = false;
    let config;
    if (newMachine && u.files['config.json']) {
      try {
        // 主人的设置（模式、预算、保留期、阈值……）跟着包走；这台机器自己的路径（异地目录、密钥文件、插件配置文件）用这台机器的
        const here = { ...(core.config.get().backup ?? {}) };
        config = JSON.parse(fs.readFileSync(u.files['config.json'], 'utf8')).core ?? {};
        const b = { ...(config.backup ?? {}) };
        for (const k of MACHINE_LOCAL) { if (here[k] !== undefined) b[k] = here[k]; else delete b[k]; }
        config = { ...config, backup: b };
        core.config.replace(config);
        configRestored = true;
        const target = here.configFile;
        if (u.files['plugin-config.json'] && typeof target === 'string' && target) writeFileAtomic(target, fs.readFileSync(u.files['plugin-config.json']));
      } catch (e) { core.log.warn('backup.restore-config-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
    }
    // 恢复码是主人给的：以后本机就能自动加密异地副本
    for (const d of [u.fromCode && u.key && u.kdf ? { key: u.key, kdf: u.kdf } : null, idk.derived]) {
      if (d) { try { installBackupKey(core, d.key, d.kdf, { makeActive: !loadBackupKeys(core)?.active }); } catch { /* 不影响恢复 */ } }
    }

    // 第 6 步：补回快照之后的经历（历史模式）
    const gaps = gapsRaw.map((g) => ({ settingKey: g.settingKey, from: Number(g.from), to: Number(g.to), count: Number(g.n) }));
    setMetaJson(core.store, 'backup.replay', { packCreatedAt: u.manifest.createdAt, restoredAt, until: restoredAt, gaps });
    // 第 7 步：向量库和主库对账（包里没带就由清扫把缺的重新排队，期间检索按 L3 降级）
    try { core.mods.worker.sweepVectors(core); } catch (e) { core.log.warn('backup.restore-sweep-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
    // backups 表被换回了旧的：按目录重建
    try { await rescan(core); } catch (e) { core.log.warn('backup.restore-rescan-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
    // 第 8 步：一条运维事件（只有数字）
    setMetaJson(core.store, 'backup.lastRestore', { at: restoredAt, packId: u.manifest.packId, kind: u.manifest.kind, packCreatedAt: u.manifest.createdAt,
      gaps: gaps.length, newMachine, preRestorePack: preRestore ? path.basename(preRestore) : null });
    bumpMetric(core.store, 'backup.restored');
    core.log.info('backup.restored', { kind: u.manifest.kind, gaps: gaps.length, tombstones: reapplied, newMachine });
    return {
      ok: true,
      gaps: gaps.map((g) => ({ from: g.from, to: g.to, settingKey: g.settingKey })),
      preRestorePack: preRestore,
      identityKeyReplaced: replaceKey,
      configRestored,
      ...(configRestored ? { config } : {}),
      tombstonesReapplied: reapplied,
    };
  } finally {
    rs(core).restoring = null;   // 换库时各模块重新 init 过，state 是新的那份
    removeDir(u.dir);
  }
}

/** 换库失败：没换成就原样重新打开；换成了就用「恢复前」快照换回去（身份密钥也换回去）。 */
async function rollback(core, { swapped, preRestore, curKey, replaceKey }) {
  try {
    if (!swapped || !preRestore) {
      if (replaceKey && curKey) { writeFileAtomic(identityKeyFile(core), `${curKey.toString('base64')}\n`, 0o600); core.keys = makeKeyring(curKey); }
      await core.reopen(async () => {});
      return;
    }
    const back = await unpackVerified(core, preRestore, { keep: true, purpose: 'rollback', checkRegistered: false });
    if (!back.ok) throw new RestoreError('ROLLBACK_INVALID');
    try {
      await core.reopen(async (files) => {
        moveFile(back.files['main.db'], `${files.main}.restoring`);
        for (const f of [`${files.main}-wal`, `${files.main}-shm`]) fs.rmSync(f, { force: true });
        fs.renameSync(`${files.main}.restoring`, files.main);
        if (replaceKey && curKey) { writeFileAtomic(identityKeyFile(core), `${curKey.toString('base64')}\n`, 0o600); core.keys = makeKeyring(curKey); }
      });
    } finally { removeDir(back.dir); }
  } catch (e) {
    core.log.error('backup.rollback-failed', { error: e?.code ?? e?.name ?? 'Error' });
  }
}

/**
 * 恢复后的补回窗口（intake 用）：这段时间里交来的、发生在 until 之前的消息按历史模式入库。没有在补回就返回 null。
 * @returns {{packCreatedAt: number, restoredAt: number, until: number}|null}
 */
export function replayWindow(core) {
  if (!core.store || core.store.closed) return null;
  const r = getMetaJson(core.store, 'backup.replay', null);
  if (!r) return null;
  const days = param(core, 'backup.replayWindowDays');
  if (core.now() > r.restoredAt + days * DAY) return null;
  return { packCreatedAt: r.packCreatedAt, restoredAt: r.restoredAt, until: r.until };
}

/**
 * 补回进度：每个场合快照之后的那段，现在补回了多少条。全部补回或者补回窗口过了，就结束跟踪，
 * 剩下没补回的时间段记进 meta 'backup.gaps'（总览列出来）。
 */
export function replayStatus(core) {
  const r = getMetaJson(core.store, 'backup.replay', null);
  if (!r) return { active: false, gaps: getMetaJson(core.store, 'backup.gaps', []) };
  const gaps = (r.gaps ?? []).map((g) => {
    const n = Number(core.store.get('SELECT count(*) AS n FROM percepts WHERE setting_key = ? AND at >= ? AND at <= ? AND created_at >= ?',
      g.settingKey, g.from, g.to, r.restoredAt).n);
    const label = core.store.get('SELECT label FROM settings WHERE key = ?', g.settingKey)?.label ?? '';
    return { ...g, label, refilled: n, missing: Math.max(0, g.count - n) };
  });
  const days = param(core, 'backup.replayWindowDays');
  const over = core.now() > r.restoredAt + days * DAY;
  const done = gaps.every((g) => g.missing === 0);
  if ((done || over) && !core.store.readOnly) {
    setMetaJson(core.store, 'backup.gaps', gaps.filter((g) => g.missing > 0).map((g) => ({ settingKey: g.settingKey, label: g.label, from: g.from, to: g.to, missing: g.missing })));
    setMeta(core.store, 'backup.replay', null);
  }
  return { active: !(done || over), gaps };
}

/**
 * 部分恢复（§12.4.5）：只取回某个人、某个场合或某段时间以前的版本，以导入的方式合并进当前库（encode.importRecords，冲突走对账），
 * 不覆盖其他记忆。已经在当前库里、被彻底删除过的跳过；取回后让这些人的印象从事实重新生成（看法回到那之前）。
 */
export async function restorePartial(core, packPath, selector, opt = {}) {
  const sel = {
    entityIds: Array.isArray(selector?.entityIds) ? selector.entityIds.filter((x) => Number.isSafeInteger(x) && x > 0) : [],
    settingKeys: Array.isArray(selector?.settingKeys) ? selector.settingKeys.filter((x) => typeof x === 'string' && x) : [],
    before: Number.isFinite(selector?.before) ? selector.before : null,
  };
  if (!sel.entityIds.length && !sel.settingKeys.length && sel.before == null) throw new RestoreError('SELECTOR_EMPTY', '部分恢复要指定人、场合或时间');
  return serialize(core, async () => {
    const u = await unpackVerified(core, packPath, { recoveryCode: opt.recoveryCode, keep: true, purpose: 'partial' });
    if (!u.ok) throw new RestoreError('PACK_INVALID', `包验证不过：${u.errors.join(',')}`);
    try {
      await makePack(core, { kind: 'pre-op', reason: 'restore-partial', offsite: false });
      const picked = await runDbTask('partialSelect', { pack: u.files['main.db'], current: core.store.file, selector: sel });
      const items = [...picked.assertions, ...picked.episodes];
      const report = { accepted: 0, skipped: picked.skipped.present + picked.skipped.tombstoned + picked.skipped.noSubject, errors: [],
        considered: items.length + picked.skipped.present + picked.skipped.tombstoned + picked.skipped.noSubject, ...picked.skipped };
      const batch = 1000;
      for (let i = 0; i < items.length; i += batch) {
        const chunk = items.slice(i, i + batch);
        const v = validateImportRecords(chunk.map((x) => x.record));
        if (!v.ok) {
          // 个别记录不合契约（比如名字太长）：逐条筛掉，记进 errors
          const good = [];
          chunk.forEach((x, j) => { const one = validateImportRecords([x.record]); if (one.ok) good.push(one.value[0]); else report.errors.push({ index: i + j, reason: 'contract' }); });
          if (good.length) mergeReport(report, await core.mods.encode.importRecords(core, good, { provenance: 'imported', source: `backup:${u.manifest.packId}` }), i);
          continue;
        }
        mergeReport(report, await core.mods.encode.importRecords(core, v.value, { provenance: 'imported', source: `backup:${u.manifest.packId}` }), i);
      }
      for (const id of sel.entityIds) {
        try { await core.mods.consolidate.regenerateImpressions(core, id, {}); } catch (e) {
          core.log.warn('backup.partial-impressions-deferred', { entity: id, error: e?.code ?? e?.name ?? 'Error' });
        }
      }
      core.log.info('backup.restore-partial', { accepted: report.accepted, skipped: report.skipped, errors: report.errors.length });
      if (hasBackupsTable(core.store)) bumpMetric(core.store, 'backup.restorePartial');
      return report;
    } finally { removeDir(u.dir); }
  });
}

function mergeReport(report, r, offset) {
  if (!r) return;
  report.accepted += r.accepted ?? 0;
  report.skipped += r.skipped ?? 0;
  for (const e of r.errors ?? []) report.errors.push({ index: (e.index ?? 0) + offset, reason: e.reason });
}
