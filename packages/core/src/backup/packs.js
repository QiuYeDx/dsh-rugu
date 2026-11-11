// 做包、验证、登记、轮转、重新扫描、夜间排程、恢复演练、彻底删除后重写本地包（§12.4.1–§12.4.4、§12.4.8）。
// backups 表只是缓存：真相是备份目录里每个包自带的 manifest，加上旁边的验证结果文件 <包>.verified.json
// （整体恢复会把 backups 表换回旧的，rescan 按目录重建时验证结果不丢）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backup as sqliteBackup } from 'node:sqlite';
import { bumpMetric, openDatabase, parseRef, getMetaJson, setMeta } from '../store/index.js';
import { writePack, readPack, readPackHeader, fileDigest, PACK_EXT, PackError } from './format.js';
import { activeBackupKey, wrapSecret, unwrapSecret, resolveKey, loadBackupKeys } from './crypto.js';
import { runDbTask } from './thread.js';
import { exportMonthly } from './export.js';
import {
  DAY, PACK_KINDS, backupRoot, kindDir, exportDir, offsiteRoot, stampOf, reasonTag, localParts, makeStaging, removeDir,
  sweepStaging, readIdentityKey, configDiff, machineHash, CORE_VERSION, writeFileAtomic, freeBytes, param,
} from './util.js';

const SIDE = '.verified.json';

/** @param {import('../store/db.js').Store} store */
const hasBackupsTable = (store) => !!store && !store.closed
  && !!store.get("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'backups'");
const writable = (store) => hasBackupsTable(store) && !store.readOnly;

function st(core) {
  core.state.backup ??= { queue: Promise.resolve(), pending: [], restoring: null };
  return core.state.backup;
}

/** 同一时间只做一件大事（做包、恢复、重写包），按顺序排队。 */
export function serialize(core, fn) {
  const s = st(core);
  const run = s.queue.then(fn, fn);
  s.queue = run.catch(() => {});
  return run;
}

// ── 登记 ──────────────────────────────────────────────────────────────────

function rowToInfo(r) {
  return { id: r.id, path: r.path, kind: r.kind, size: r.size, sha256: r.sha256, encrypted: !!r.encrypted, includesVectors: !!r.includes_vectors,
    location: r.location, createdAt: r.created_at, verifyStatus: r.verify_status };
}

function writeSidecar(file, v) {
  try { writeFileAtomic(`${file}${SIDE}`, `${JSON.stringify(v)}\n`); } catch { /* 只是缓存 */ }
}
function readSidecar(file) {
  try { return JSON.parse(fs.readFileSync(`${file}${SIDE}`, 'utf8')); } catch { return null; }
}

/** 登记一个包（表还不存在时——迁移前快照——先放在内存里，下次能写表时补登记）。 */
export function registerPack(core, store, p) {
  const row = {
    kind: p.kind, reason: p.reason ?? null, location: p.location, path: p.path, created_at: p.createdAt, size: p.size, sha256: p.sha256,
    schema_version: p.manifest?.schemaVersion ?? null, includes_vectors: p.includesVectors ? 1 : 0, encrypted: p.encrypted ? 1 : 0,
    manifest_json: p.manifest ? JSON.stringify(p.manifest) : null, verify_status: p.verifyStatus ?? 'pending', verified_at: p.verifiedAt ?? null,
  };
  if (!writable(store)) { st(core).pending.push(row); return null; }
  return insertRow(store, row);
}
function insertRow(store, row) {
  const old = store.get('SELECT id FROM backups WHERE path = ? AND deleted_at IS NULL', row.path);
  if (old) {
    store.run(`UPDATE backups SET kind = ?, reason = ?, location = ?, created_at = ?, size = ?, sha256 = ?, schema_version = ?, includes_vectors = ?,
                 encrypted = ?, manifest_json = ?, verify_status = ?, verified_at = ? WHERE id = ?`,
    row.kind, row.reason, row.location, row.created_at, row.size, row.sha256, row.schema_version, row.includes_vectors, row.encrypted,
    row.manifest_json, row.verify_status, row.verified_at, old.id);
    return old.id;
  }
  const r = store.run(`INSERT INTO backups(kind, reason, location, path, created_at, size, sha256, schema_version, includes_vectors, encrypted,
                         manifest_json, verify_status, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  row.kind, row.reason, row.location, row.path, row.created_at, row.size, row.sha256, row.schema_version, row.includes_vectors,
  row.encrypted, row.manifest_json, row.verify_status, row.verified_at);
  return Number(r.lastInsertRowid);
}
/** 迁移前快照这类当时没法登记的，补登记。 */
export function flushPending(core) {
  const s = st(core);
  if (!s.pending.length || !writable(core.store)) return 0;
  const rows = [...s.pending];
  core.store.tx((db) => { for (const r of rows) if (fs.existsSync(r.path)) insertRow(db, r); });
  s.pending.splice(0, rows.length);   // 写进去了才从内存里拿掉（写失败的下次再补）
  return rows.length;
}

// ── 做包 ──────────────────────────────────────────────────────────────────

async function snapshotDb(srcStore, srcFile, dest, compact) {
  if (compact && srcFile && srcFile !== ':memory:') await runDbTask('vacuumInto', { src: srcFile, dest });
  else await sqliteBackup(srcStore.raw, dest);
  return runDbTask('inspect', { file: dest, rollbackJournal: true });
}

/**
 * 准备一个包的全部条目（主库快照、可选的向量库、身份密钥、配置）和 manifest，放在暂存目录里。
 * @returns {Promise<{dir: string, entries: {name: string, file: string}[], manifest: object, packId: string, at: number}>}
 */
async function stage(core, { kind, reason, includeVectors, store }) {
  const cfg = core.config.get();
  const at = core.now();
  const packId = crypto.randomBytes(8).toString('hex');
  const dir = makeStaging(core, `pack-${kind}`);
  try {
    const compact = kind === 'weekly' || kind === 'monthly';
    const mainFile = path.join(dir, 'main.db');
    const info = await snapshotDb(store, store.file, mainFile, compact);
    const entries = [{ name: 'main.db', file: mainFile }];
    let vectorCounts = null;
    const withVectors = includeVectors ?? param(core, 'backup.vectorsIn').includes(kind);
    if (withVectors && core.vectors && !core.vectors.closed && store === core.store) {
      const vf = path.join(dir, 'vectors.db');
      vectorCounts = (await snapshotDb(core.vectors, core.vectors.file, vf, compact)).counts;
      entries.push({ name: 'vectors.db', file: vf });
    }
    // 身份哈希密钥：有备份密钥就单独包一层（§12.4.1「包内单独加密」）
    let bk = null;
    try { bk = activeBackupKey(core); } catch { bk = null; }
    const idKey = readIdentityKey(core);
    let identity = { present: false, wrapped: false };
    if (idKey) {
      const body = bk ? wrapSecret(idKey, bk) : { v: 1, wrapped: false, key: idKey.toString('base64') };
      const f = path.join(dir, 'identity.json');
      fs.writeFileSync(f, JSON.stringify(body), { mode: 0o600 });
      entries.push({ name: 'identity.json', file: f });
      identity = { present: true, wrapped: !!bk, keyId: bk?.keyId ?? null };
    } else {
      core.log.warn('backup.identity-key-missing', { kind });
    }
    // 配置：核心的配置差异；集成层指定了插件配置文件就原样带上（模式、预算、模型档位、显卡策略……）
    const cf = path.join(dir, 'config.json');
    fs.writeFileSync(cf, JSON.stringify({ v: 1, core: configDiff(cfg), at }));
    entries.push({ name: 'config.json', file: cf });
    const pluginCfg = typeof cfg.backup?.configFile === 'string' && cfg.backup.configFile ? cfg.backup.configFile : null;
    if (pluginCfg && fs.existsSync(pluginCfg)) {
      const pf = path.join(dir, 'plugin-config.json');
      fs.copyFileSync(pluginCfg, pf);
      entries.push({ name: 'plugin-config.json', file: pf });
    }
    const manifest = {
      format: 1, packId, kind, reason: reason ?? null, createdAt: at, coreVersion: CORE_VERSION,
      schemaVersion: info.userVersion, dbId: info.dbId, counts: info.counts, retention: info.retention ?? null,
      embedding: { spaces: info.spaces }, includesVectors: !!vectorCounts, vectorCounts, compacted: compact,
      identityKey: identity, machine: machineHash(core),
    };
    return { dir, entries, manifest, packId, at };
  } catch (e) { removeDir(dir); throw e; }
}

function packName(kind, reason, at, packId) {
  const tag = reasonTag(reason);
  return `pm-${kind}${tag ? `-${tag}` : ''}-${stampOf(at)}-${packId.slice(0, 6)}${PACK_EXT}`;
}

/**
 * 做包的完整流程：暂存 → 写本机包 →（该带的）写加密的异地包 → 每份都验证 → 登记。
 * @param {object} core
 * @param {{kind: string, reason?: string, includeVectors?: boolean, store?: import('../store/db.js').Store, offsite?: boolean}} opt
 * @returns {Promise<import('./index.js').PackInfo[]>}
 */
export async function makePack(core, opt) {
  const store = opt.store ?? core.store;
  if (!store || store.closed) throw new Error('数据库没打开，做不了备份');
  if (!PACK_KINDS.includes(opt.kind)) throw new TypeError(`不认识的备份种类：${opt.kind}`);
  // 迁移前那份当时没法登记的，能写表了就先补上
  if (store === core.store) { try { flushPending(core); } catch { /* 下次再补 */ } }
  const s = await stage(core, { ...opt, store });
  const out = [];
  try {
    const name = packName(opt.kind, opt.reason, s.at, s.packId);
    const header = { kind: opt.kind, createdAt: s.at, packId: s.packId };
    const level = param(core, 'backup.compressLevel');
    const targets = [{ location: 'local', dest: path.join(kindDir(core, opt.kind), name), encryption: null }];
    const offsite = offsiteRoot(core);
    const offsiteKinds = param(core, 'backup.offsiteKinds');
    if (offsite && opt.offsite !== false && offsiteKinds.includes(opt.kind)) {
      let bk = null;
      try { bk = activeBackupKey(core); } catch { bk = null; }
      if (bk) targets.push({ location: 'offsite', dest: path.join(offsite, name), encryption: bk });
      else {
        // 异地副本一律加密（§12.4.3）：没有备份密钥就不往外放
        core.log.warn('backup.offsite-no-key', { kind: opt.kind });
        if (!store.readOnly) bumpMetric(store, 'backup.offsite.noKey');
      }
    }
    for (const t of targets) {
      let w;
      try {
        w = await writePack(t.dest, { header, manifest: s.manifest, entries: s.entries, encryption: t.encryption, level });
      } catch (e) {
        core.log.error('backup.write-failed', { kind: opt.kind, location: t.location, error: e?.code ?? e?.name ?? 'Error' });
        if (t.location === 'local') throw e;
        continue;
      }
      const v = await verifyFile(core, w.path, { key: t.encryption?.key ?? null, sha256: w.sha256 });
      const status = v.ok ? 'ok' : 'failed';
      writeSidecar(w.path, { sha256: w.sha256, size: w.size, status, at: core.now(), errors: v.errors });
      const id = registerPack(core, store, {
        kind: opt.kind, reason: opt.reason, location: t.location, path: w.path, createdAt: s.at, size: w.size, sha256: w.sha256,
        manifest: w.manifest, includesVectors: s.manifest.includesVectors, encrypted: !!t.encryption, verifyStatus: status, verifiedAt: core.now(),
      });
      if (!v.ok) core.log.error('backup.verify-failed', { kind: opt.kind, location: t.location, errors: v.errors.length });
      if (!store.readOnly && hasBackupsTable(store)) bumpMetric(store, `backup.created.${opt.kind}`);
      out.push({ id, path: w.path, kind: opt.kind, size: w.size, sha256: w.sha256, encrypted: !!t.encryption, includesVectors: !!s.manifest.includesVectors,
        location: t.location, verified: v.ok, createdAt: s.at });
    }
    core.log.info('backup.created', { kind: opt.kind, packs: out.length, verified: out.every((p) => p.verified) });
    return out;
  } finally { removeDir(s.dir); }
}

// ── 验证 ──────────────────────────────────────────────────────────────────

/**
 * 解开一个包到暂存目录并核对（sha256、解密认证、逐条 sha256、integrity_check、schema 版本、各表条数）。
 * 调用方用完要 removeDir(result.dir)。keep=false 时这里就删掉。
 * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], header: any, manifest: any, files: Record<string,string>, dir: string|null, key: Buffer|null, fromCode: boolean, kdf: object|null}>}
 */
export async function unpackVerified(core, file, opt = {}) {
  const errors = [];
  const warnings = [];
  let header = null;
  let manifest = null;
  let files = {};
  let key = opt.key ?? null;
  let fromCode = false;
  let kdf = null;
  const dir = makeStaging(core, opt.purpose ?? 'verify');
  try {
    try { header = (await readPackHeader(file)).header; } catch (e) { errors.push(e?.reason ?? 'format'); return { ok: false, errors, warnings, header, manifest, files, dir: keepOrDrop(dir, opt, false), key, fromCode, kdf }; }
    if (header.encrypted && !key) {
      try { const r = await resolveKey(core, header.enc, opt); key = r.key; fromCode = r.fromCode; kdf = r.kdf; } catch (e) {
        errors.push(e?.code === 'WRONG_RECOVERY_CODE' ? 'wrong-recovery-code' : e?.code === 'RECOVERY_CODE_FORMAT' ? 'recovery-code-format' : 'no-key');
        return { ok: false, errors, warnings, header, manifest, files, dir: keepOrDrop(dir, opt, false), key: null, fromCode, kdf };
      }
    }
    if (opt.sha256 || opt.checkRegistered !== false) {
      const want = opt.sha256 ?? registeredSha(core, file);
      if (want) {
        const d = await fileDigest(file);
        if (d.sha256 !== want) errors.push('sha256');
      }
    }
    try {
      const r = await readPack(file, { outDir: dir, key: header.encrypted ? key : null });
      manifest = r.manifest;
      files = r.files;
    } catch (e) {
      errors.push(e?.reason ?? 'corrupt');
      return { ok: false, errors, warnings, header, manifest, files, dir: keepOrDrop(dir, opt, false), key, fromCode, kdf };
    }
    if (!files['main.db']) errors.push('no-main');
    else {
      try {
        const c = await runDbTask('check', { file: files['main.db'] });
        if (!c.ok) errors.push('integrity');
        if (c.userVersion !== manifest.schemaVersion) errors.push('schema-version');
        for (const [t, n] of Object.entries(manifest.counts ?? {})) if (c.counts[t] !== n) errors.push(`count:${t}`);
      } catch (e) { errors.push(`check:${e?.code ?? 'error'}`); }
    }
    if (files['vectors.db']) {
      try {
        const c = await runDbTask('check', { file: files['vectors.db'] });
        if (!c.ok) errors.push('vectors-integrity');
        for (const [t, n] of Object.entries(manifest.vectorCounts ?? {})) if (c.counts[t] !== n) errors.push(`vectors-count:${t}`);
      } catch (e) { errors.push(`vectors-check:${e?.code ?? 'error'}`); }
    }
    if (files['identity.json']) {
      try {
        const w = JSON.parse(fs.readFileSync(files['identity.json'], 'utf8'));
        if (w.wrapped) {
          const local = localKeyFor(core, w.keyId) ?? (header.encrypted && w.keyId === header.enc?.keyId ? key : null);
          if (local) { if (unwrapSecret(w, local).length !== 32) errors.push('identity-key'); } else warnings.push('identity-key-locked');
        } else if (Buffer.from(String(w.key ?? ''), 'base64').length !== 32) errors.push('identity-key');
      } catch { errors.push('identity-key'); }
    } else if (manifest.identityKey?.present) errors.push('identity-missing');
    const ok = errors.length === 0;
    return { ok, errors, warnings, header, manifest, files, dir: keepOrDrop(dir, opt, ok), key, fromCode, kdf };
  } catch (e) {
    removeDir(dir);
    throw e;
  }
}
function keepOrDrop(dir, opt, ok) {
  if (opt.keep && ok) return dir;
  removeDir(dir);
  return null;
}
function localKeyFor(core, keyId) {
  try { return loadBackupKeys(core)?.keys.get(keyId)?.key ?? null; } catch { return null; }
}
function registeredSha(core, file) {
  if (!hasBackupsTable(core.store)) return null;
  return core.store.get('SELECT sha256 FROM backups WHERE path = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', file)?.sha256 ?? null;
}

/** 验证一个文件，不留解开的内容。 */
export async function verifyFile(core, file, opt = {}) {
  const r = await unpackVerified(core, file, { ...opt, keep: false, purpose: 'verify' });
  return { ok: r.ok, errors: r.errors, warnings: r.warnings, manifest: r.manifest, header: r.header };
}

/** 对外的 verifyPack：验证、更新登记和验证结果文件。 */
export async function verifyAndRecord(core, file, opt = {}) {
  const r = await verifyFile(core, file, opt);
  const status = r.ok ? 'ok' : 'failed';
  let sha = null;
  let size = null;
  try { const d = await fileDigest(file); sha = d.sha256; size = d.size; } catch { /* 文件读不了时 r 里已经有错误 */ }
  if (writable(core.store)) {
    core.store.run('UPDATE backups SET verify_status = ?, verified_at = ? WHERE path = ? AND deleted_at IS NULL', status, core.now(), file);
  }
  if (fs.existsSync(file)) writeSidecar(file, { sha256: sha, size, status, at: core.now(), errors: r.errors });
  if (!r.ok) core.log.warn('backup.verify', { ok: false, errors: r.errors.length });
  return { ok: r.ok, errors: r.errors };
}

// ── 轮转 ──────────────────────────────────────────────────────────────────

function dropPack(core, row) {
  try { fs.rmSync(row.path, { force: true }); } catch { /* 下次再试 */ }
  try { fs.rmSync(`${row.path}${SIDE}`, { force: true }); } catch { /* 同上 */ }
  if (!fs.existsSync(row.path)) core.store.run('UPDATE backups SET deleted_at = ? WHERE id = ?', core.now(), row.id);
  return !fs.existsSync(row.path);
}

/**
 * 轮转（日 7 / 周 4 / 月 12 / 操作前 10，手动的不删）。只有验证通过的包算数、也只删验证通过的：
 * 验证不过的标红留着，不顶替好的那份（§12.4.4）。所在盘剩余不足时先删最旧的日包并报警，月包和操作前快照不因此删。
 */
export async function rotate(core) {
  if (!writable(core.store)) return { deleted: 0 };
  flushPending(core);
  const r = param(core, 'backup.retention');
  const keep = { daily: r.daily, weekly: r.weekly, monthly: r.monthly, 'pre-op': r.preOp };
  let deleted = 0;
  for (const location of ['local', 'offsite']) {
    for (const [kind, n] of Object.entries(keep)) {
      const ok = core.store.all(`SELECT * FROM backups WHERE kind = ? AND location = ? AND deleted_at IS NULL AND verify_status = 'ok'
                                 ORDER BY created_at DESC, id DESC`, kind, location);
      for (const row of ok.slice(Math.max(0, n))) if (dropPack(core, row)) deleted += 1;
    }
  }
  // 磁盘快满了：先删最旧的日包（保留最新的一份好的日包），报警
  let lowDisk = false;
  const minFree = param(core, 'backup.lowDiskGb') * 1e9;
  let free = freeBytes(backupRoot(core));
  if (free != null && free < minFree) {
    lowDisk = true;
    core.log.warn('backup.low-disk', { freeGb: Math.round(free / 1e8) / 10 });
    bumpMetric(core.store, 'backup.lowDisk');
    const dailies = core.store.all(`SELECT * FROM backups WHERE kind = 'daily' AND location = 'local' AND deleted_at IS NULL AND verify_status = 'ok'
                                    ORDER BY created_at ASC, id ASC`);
    for (const row of dailies.slice(0, -1)) {
      if (free >= minFree) break;
      if (dropPack(core, row)) { deleted += 1; free = freeBytes(backupRoot(core)) ?? free; }
    }
  }
  // 每月导出也只留最近几份
  deleted += rotateExports(core, r.export);
  sweepStaging(core);
  if (deleted) core.log.info('backup.rotated', { deleted });
  return { deleted, lowDisk };
}

function rotateExports(core, keepN) {
  let list = [];
  try { list = fs.readdirSync(exportDir(core)).filter((f) => /^pm-export-.*\.(jsonl|pmpack)$/.test(f)).sort(); } catch { return 0; }
  let n = 0;
  for (const f of list.slice(0, Math.max(0, list.length - keepN))) {
    try { fs.rmSync(path.join(exportDir(core), f), { force: true }); n += 1; } catch { /* 下次 */ }
  }
  return n;
}

// ── 重新扫描 ──────────────────────────────────────────────────────────────

function listPackFiles(dir) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) if (e.isFile() && e.name.endsWith(PACK_EXT)) out.push(path.join(dir, e.name));
  return out;
}

/**
 * 按备份目录重建 backups 表（恢复之后必须做：表被换回了旧的）。manifest 读包开头就有；加密的异地包本机有密钥才读得到 manifest。
 * 验证结果来自旁边的 .verified.json（文件大小对得上才认）。
 */
export async function rescan(core) {
  if (!writable(core.store)) return { found: 0 };
  const files = [];
  for (const kind of PACK_KINDS) files.push(...listPackFiles(kindDir(core, kind)).map((f) => ({ f, location: 'local' })));
  const off = offsiteRoot(core);
  if (off) files.push(...listPackFiles(off).map((f) => ({ f, location: 'offsite' })));
  const rows = [];
  for (const { f, location } of files) {
    let header;
    try { header = (await readPackHeader(f)).header; } catch { continue; }
    if (!PACK_KINDS.includes(header.kind)) continue;
    let manifest = null;
    try {
      const key = header.encrypted ? localKeyFor(core, header.enc?.keyId) : null;
      if (!header.encrypted || key) manifest = (await readPack(f, { manifestOnly: true, key })).manifest;
    } catch { manifest = null; }
    const size = fs.statSync(f).size;
    const side = readSidecar(f);
    const sideOk = side && side.size === size;
    rows.push({
      kind: header.kind, reason: manifest?.reason ?? null, location, path: f, created_at: header.createdAt, size,
      sha256: sideOk ? side.sha256 : null, schema_version: manifest?.schemaVersion ?? null, includes_vectors: manifest?.includesVectors ? 1 : 0,
      encrypted: header.encrypted ? 1 : 0, manifest_json: manifest ? JSON.stringify(manifest) : null,
      verify_status: sideOk && (side.status === 'ok' || side.status === 'failed') ? side.status : 'pending', verified_at: sideOk ? side.at ?? null : null,
    });
  }
  const at = core.now();
  core.store.tx((db) => {
    const seen = new Set(rows.map((r) => r.path));
    for (const old of db.all('SELECT id, path FROM backups WHERE deleted_at IS NULL')) if (!seen.has(old.path)) db.run('UPDATE backups SET deleted_at = ? WHERE id = ?', at, old.id);
    for (const r of rows) insertRow(db, r);
  });
  st(core).pending.length = 0;
  return { found: rows.length };
}

// ── 夜间排程 ──────────────────────────────────────────────────────────────

function lastPackAt(core, kind) {
  if (!hasBackupsTable(core.store)) return null;
  return core.store.get("SELECT MAX(created_at) AS t FROM backups WHERE kind = ? AND location = 'local' AND deleted_at IS NULL", kind)?.t ?? null;
}

/** 现在该做哪些包（本地时间：日包每天一份；周包在设定的星期几，错过了就补；月包每月 monthlyOnDay 号起第一次）。 */
export function duePacks(core, at) {
  const p = localParts(core, at);
  const due = [];
  const lastDaily = lastPackAt(core, 'daily');
  if (lastDaily == null || lastDaily < p.dayStart) due.push('daily');
  const weekDay = param(core, 'backup.weeklyOnDay');   // 本地的星期几（D19）
  const lastWeekly = lastPackAt(core, 'weekly');
  if ((p.weekday === weekDay && (lastWeekly == null || lastWeekly < p.dayStart)) || lastWeekly == null || lastWeekly < at - 7 * DAY) due.push('weekly');
  const lastMonthly = lastPackAt(core, 'monthly');
  if (p.d >= param(core, 'backup.monthlyOnDay') && (lastMonthly == null || lastMonthly < p.monthStart)) due.push('monthly');
  return due;
}

/** 夜间整理开始前：该做的包、轮转、每周一次恢复演练、每月一份导出。每一步失败只记下来，不影响下一步。 */
export async function runScheduled(core, opt) {
  const at = opt.at ?? core.now();
  const cfg = core.config.get().backup ?? {};
  const made = [];
  // 上次整体恢复后没删完的墓碑（换库前读出来的那批）：先补删，再做今晚的包（包里不该再带着它们）
  const left = hasBackupsTable(core.store) ? getMetaJson(core.store, 'backup.tombstonesPending', null) : null;
  if (Array.isArray(left) && left.length) {
    try {
      await core.mods.admin.reapplyTombstones(core, { tombstones: left });
      setMeta(core.store, 'backup.tombstonesPending', null);
    } catch (e) { core.log.warn('backup.tombstones-retry-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
  }
  const kinds = duePacks(core, at);
  for (const kind of kinds) {
    if (opt.signal?.aborted) break;
    try { made.push(...(await serialize(core, () => makePack(core, { kind })))); } catch (e) {
      core.log.error('backup.scheduled-failed', { kind, error: e?.code ?? e?.name ?? 'Error' });
      try { bumpMetric(core.store, 'backup.scheduled.failed'); } catch { /* 忽略 */ }
    }
  }
  if (!opt.signal?.aborted) { try { await rotate(core); } catch (e) { core.log.warn('backup.rotate-failed', { error: e?.code ?? e?.name ?? 'Error' }); } }
  // 每周一次恢复演练：跟着周包走（演练的就是刚做好的、带向量库的那份）；周包一直没做成时按间隔兜底
  const drillEvery = param(core, 'backup.drill.everyDays') * DAY;
  const lastDrill = hasBackupsTable(core.store) ? core.store.get('SELECT MAX(at) AS t FROM restore_drills')?.t ?? null : null;
  const weeklyMade = made.some((p) => p.kind === 'weekly' && p.location === 'local');
  if (!opt.signal?.aborted && (lastDrill == null || weeklyMade || lastDrill <= at - drillEvery)) {
    try { await restoreDrill(core); } catch (e) { core.log.warn('backup.drill-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
  }
  if (!opt.signal?.aborted && cfg.exportMonthly !== false && kinds.includes('monthly')) {
    try { await exportMonthly(core, { at }); } catch (e) { core.log.warn('backup.export-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
  }
  return made;
}

// ── 恢复演练 ──────────────────────────────────────────────────────────────

function fallbackTerms(text) {
  // lang 不可用时的退路：按 Unicode 字母数字切词，CJK 连续段切成二元组
  const out = [];
  for (const m of String(text).normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    const w = m[0];
    if (/\p{Script=Han}/u.test(w) && w.length > 1) for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    else out.push(w);
  }
  return [...new Set(out)];
}

/**
 * 恢复演练（§12.4.4）：最新的包完整解开到临时目录、全部核对，再随机抽几条记忆用它们自己的查询词走一遍词法检索，确认找得回来。
 * 结果记在 restore_drills（总览显示「最近一次恢复演练：通过 / 失败」）。
 */
export async function restoreDrill(core) {
  if (!hasBackupsTable(core.store)) return { ok: false, sampled: 0, found: 0 };
  const row = core.store.get(`SELECT * FROM backups WHERE location = 'local' AND deleted_at IS NULL AND kind <> 'pre-op'
                              ORDER BY (verify_status = 'ok') DESC, created_at DESC, id DESC LIMIT 1`)
    ?? core.store.get("SELECT * FROM backups WHERE location = 'local' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1");
  const at = core.now();
  const record = (status, sampled, found, error) => {
    if (writable(core.store)) core.store.run('INSERT INTO restore_drills(at, backup_id, status, sampled, found, error) VALUES (?, ?, ?, ?, ?, ?)', at, row?.id ?? null, status, sampled, found, error);
  };
  if (!row) { record('failed', 0, 0, 'no-pack'); return { ok: false, sampled: 0, found: 0 }; }
  const u = await unpackVerified(core, row.path, { keep: true, purpose: 'drill' });
  if (!u.ok) { record('failed', 0, 0, u.errors[0] ?? 'verify'); return { ok: false, sampled: 0, found: 0 }; }
  try {
    const n = param(core, 'backup.drill.sample');
    const seed = Number(BigInt.asUintN(31, BigInt(at)));
    const sample = await runDbTask('drillSample', { file: u.files['main.db'], n, seed });
    const queries = [];
    for (const s of sample) {
      let terms;
      try { terms = core.mods.lang.queryTerms(core, s.text); } catch { terms = fallbackTerms(s.text); }
      terms = (terms ?? []).filter(Boolean).slice(0, 12);
      if (terms.length) queries.push({ table: s.table, rowid: s.rowid, terms });
    }
    const r = queries.length ? await runDbTask('drillSearch', { file: u.files['main.db'], queries }) : { found: 0, missed: 0 };
    const ok = r.found === queries.length;
    record(ok ? 'ok' : 'failed', queries.length, r.found, ok ? null : 'not-found');
    core.log.info('backup.drill', { ok, sampled: queries.length, found: r.found });
    return { ok, sampled: queries.length, found: r.found };
  } catch (e) {
    record('failed', 0, 0, e?.code ?? 'error');
    throw e;
  } finally { removeDir(u.dir); }
}

// ── 彻底删除后重写本地包（§12.4.8） ─────────────────────────────────────────

/**
 * 从每个包里清除这些墓碑指向的内容：解开 → 按墓碑删（admin 的同一套级联）→ VACUUM（删掉的内容不留在空闲页）→ 重新打包 → 验证 → 换掉旧包。
 * 异地副本本机有密钥就一起重写。慢，逐个来；单个失败只记下，原包留着。
 * 【D143】结果带回每个没改成的包和原因（failures），彻底删除的结果里显示给主人：
 *   rewritten 改写了；skipped 包里本来就没有这些内容（不用改）；failed 没改成——解不开 / 验证不过（原因是校验的错误类别）、
 *   文件不见了（missing）、改写或验证出错（错误类型）。没改成的包原样留着，里面还有被删的内容。
 * @param {object} core
 * @param {{tombstones: {kind: string, ref: string, at: number}[], signal?: AbortSignal}} opt
 * @returns {Promise<{rewritten: number, failed: number, skipped: number, failures: {id: number, reason: string}[]}>}
 */
export async function scrubPacks(core, opt) {
  if (!opt.tombstones?.length) return { rewritten: 0, failed: 0, skipped: 0, failures: [] };
  if (!writable(core.store)) return { rewritten: 0, failed: 1, skipped: 0, failures: [{ id: null, reason: 'read-only' }] };
  const rows = core.store.all('SELECT * FROM backups WHERE deleted_at IS NULL ORDER BY created_at');
  let rewritten = 0;
  let skipped = 0;
  const failures = [];
  for (const row of rows) {
    if (opt.signal?.aborted) { failures.push({ id: row.id, reason: 'aborted' }); continue; }
    if (!fs.existsSync(row.path)) { failures.push({ id: row.id, reason: 'missing' }); continue; }
    try {
      const done = await serialize(core, () => scrubOne(core, row, opt.tombstones));
      if (done) rewritten += 1; else skipped += 1;
    } catch (e) {
      const reason = e?.reason ?? e?.code ?? e?.name ?? 'Error';
      failures.push({ id: row.id, reason: String(reason) });
      core.log.warn('backup.scrub-failed', { id: row.id, error: String(reason) });
    }
  }
  return { rewritten, failed: failures.length, skipped, failures };
}

async function scrubOne(core, row, tombstones) {
  const u = await unpackVerified(core, row.path, { keep: true, purpose: 'scrub', checkRegistered: false });
  // 解不开（没有密钥、校验不过）：不能当成「包里没有」——里面可能还有被删的内容
  if (!u.ok) { removeDir(u.dir); throw new PackError(u.errors?.[0] ?? 'verify', '解不开这个包'); }
  try {
    const db = openDatabase({ file: u.files['main.db'], lock: false });
    let deleted = 0;
    let cascaded = [];
    try {
      const r = core.mods.admin.applyTombstonesTo(core, db, tombstones);
      deleted = r.deleted;
      cascaded = Array.isArray(r.tombstones) ? r.tombstones : [];
      db.exec('PRAGMA journal_mode = DELETE');
    } finally { db.close(); }
    if (u.files['vectors.db']) {
      const vdb = openDatabase({ file: u.files['vectors.db'], lock: false });
      try {
        // 墓碑本身指向的，加上在这个包里顺着级联一起删的（社区、印象……）
        for (const t of [...tombstones, ...cascaded]) {
          const r = parseRef(t.ref);
          if (r && r.kind === t.kind) deleted += Number(vdb.run('DELETE FROM vectors WHERE owner_kind = ? AND owner_id = ?', r.kind, r.id).changes);
        }
        vdb.exec('PRAGMA journal_mode = DELETE');
      } finally { vdb.close(); }
    }
    if (!deleted) return false;
    await runDbTask('vacuum', { file: u.files['main.db'] });
    const info = await runDbTask('inspect', { file: u.files['main.db'], rollbackJournal: true });
    let vectorCounts = u.manifest.vectorCounts ?? null;
    if (u.files['vectors.db']) { await runDbTask('vacuum', { file: u.files['vectors.db'] }); vectorCounts = (await runDbTask('inspect', { file: u.files['vectors.db'] })).counts; }
    const manifest = { ...u.manifest, counts: info.counts, vectorCounts, scrubbedAt: core.now() };
    delete manifest.files;
    const order = ['main.db', 'vectors.db', 'identity.json', 'config.json', 'plugin-config.json'];
    const entries = u.manifest.files.map((f) => f.name).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((name) => ({ name, file: u.files[name] }));
    const encryption = u.header.encrypted ? { key: u.key, keyId: u.header.enc.keyId, kdf: u.header.enc.kdf } : null;
    const tmpDest = `${row.path}.scrub${PACK_EXT}`;
    const w = await writePack(tmpDest, { header: { kind: u.header.kind, createdAt: u.header.createdAt, packId: u.header.packId }, manifest, entries, encryption,
      level: param(core, 'backup.compressLevel') });
    const v = await verifyFile(core, w.path, { key: encryption?.key ?? null, sha256: w.sha256 });
    if (!v.ok) { fs.rmSync(w.path, { force: true }); throw new PackError('verify', '重写后的包验证不过'); }
    fs.renameSync(w.path, row.path);
    writeSidecar(row.path, { sha256: w.sha256, size: w.size, status: 'ok', at: core.now(), errors: [] });
    core.store.run('UPDATE backups SET size = ?, sha256 = ?, manifest_json = ?, verify_status = ?, verified_at = ? WHERE id = ?',
      w.size, w.sha256, JSON.stringify(w.manifest), 'ok', core.now(), row.id);
    return true;
  } finally { removeDir(u.dir); }
}

/** 某个包的登记（按路径）。 */
export function packRow(core, file) {
  if (!hasBackupsTable(core.store)) return null;
  const r = core.store.get('SELECT * FROM backups WHERE path = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', file);
  return r ? rowToInfo(r) : null;
}
export { hasBackupsTable, writable as backupsWritable };
