// backup 测试用的 CoreContext：和 createTestCore 一样（真库、真迁移、替身端口、可替换的 core.mods），
// 另外支持真的 core.reopen(swap)（整体恢复要关库、换文件、重新打开），身份密钥写在数据目录的文件里（包要带上它），
// 也可以指定已有的数据目录（模拟同一台机器重启、或一台新机器）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore, openVectorStore, mainDbIdOf, makeKeyring, loadOrCreateKey, dataFiles } from '../../src/store/index.js';
import { normalizePorts } from '../../src/ports/index.js';
import { createConfig } from '../../src/config/defaults.js';
import { MODULES } from '../../src/api.js';
import { fakePorts } from '../fakes/index.js';
import { tmpDir, rmDir } from '../helpers.js';

/** 什么都不做的依赖替身（其他模块正在并行实现，这里不依赖它们）。 */
export const quietMods = (extra = {}) => ({
  entities: { ensureSelf: () => 1, ensurePrincipal: () => 2, principals: () => [], ...(extra.entities ?? {}) },
  worker: { sweepVectors: () => ({ removed: 0, requeued: 0 }), dropEmbeddings: () => ({ texts: 0, vectors: 0 }), ...(extra.worker ?? {}) },
  encode: { derivedFrom: () => [], ...(extra.encode ?? {}) },
  lang: { queryTerms: (core, text) => fallbackTerms(text), ...(extra.lang ?? {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['entities', 'worker', 'encode', 'lang'].includes(k))),
});

/** 测试里的 queryTerms 替身：和 lang 的契约一致（规范化、去重、不排序不截断），中文切二元组。 */
export function fallbackTerms(text) {
  const out = [];
  for (const m of String(text).normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    const w = m[0];
    if (/\p{Script=Han}/u.test(w) && w.length > 1) for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    else out.push(w);
  }
  return [...new Set(out)];
}

/**
 * @param {{name?: string, dir?: string, mods?: object, config?: object, ports?: object, key?: Buffer|null, keepDir?: boolean}} [opt]
 *        key：写进 <dir>/persona-memory.key 的身份密钥；null = 让 loadOrCreateKey 生成（新机器）；不给 = 固定的测试密钥
 */
export async function createBackupCore(opt = {}) {
  const dir = opt.dir ?? tmpDir(opt.name ?? 'backup');
  const keyFile = path.join(dir, 'persona-memory.key');
  if (opt.key !== null && !fs.existsSync(keyFile)) {
    const key = opt.key ?? crypto.createHash('sha256').update('rugu-core/backup-test-key').digest();
    fs.writeFileSync(keyFile, `${key.toString('base64')}\n`);
  }
  const rawPorts = opt.ports ?? fakePorts();
  const p = normalizePorts(rawPorts);
  const cfg = opt.config && typeof opt.config.get === 'function' ? opt.config : createConfig(opt.config ?? {});
  const files = dataFiles(dir);
  const merged = Object.freeze(Object.fromEntries(Object.entries(MODULES).map(([k, ns]) => [k, Object.freeze({ ...ns, ...(opt.mods?.[k] ?? {}) })])));
  /** @type {any} */
  const core = {
    store: null, vectors: null, ports: p, config: cfg, keys: makeKeyring(loadOrCreateKey(keyFile)), keyFile,
    adapters: new Map(), dataDir: dir, readOnly: false, state: {}, log: p.logger, now: () => p.clock.now(),
    jobHandlers: new Map(), mods: merged, reopen: null,
  };
  const openStores = async () => {
    core.store = await openStore({ file: files.main, clock: p.clock, logger: p.logger, backup: (info) => core.mods.backup.preOperationSnapshot(core, info) });
    core.readOnly = core.store.readOnly;
    core.vectors = openVectorStore({ file: files.vectors, mainDbId: mainDbIdOf(core.store), clock: p.clock, logger: p.logger });
  };
  const initModules = async () => { for (const [k, m] of Object.entries(core.mods)) { await m.init(core); core.state[k] ??= {}; } };
  const disposeModules = async () => { for (const m of Object.values(core.mods).reverse()) { try { await m.dispose(core); } catch { /* 尽力 */ } } };
  const closeStores = () => { try { core.vectors?.close(); } catch { /* 尽力 */ } try { core.store?.close(); } catch { /* 尽力 */ } };
  core.reopen = async (swap) => {
    await disposeModules();
    closeStores();
    await swap({ ...files });
    await openStores();
    await initModules();
  };
  await openStores();
  await initModules();
  let done = false;
  return {
    core, dir, ports: rawPorts, files,
    async close() { if (done) return; done = true; await disposeModules(); closeStores(); },
    async cleanup() { await this.close(); if (!opt.keepDir) rmDir(dir); },
  };
}

// ── 测试数据（直接写表：别的模块还在并行实现，测试只需要行在那里） ─────────────

let seq = 0;
export function seedSetting(core, { key = `sk-${++seq}`, label = '小群', exposure = 1, descriptor } = {}) {
  const at = core.now();
  const d = descriptor ?? { id: 'opaque', label, stability: 'persistent', audience: { size: 5, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
    disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true }, ownership: { owner: 'unknown', herRole: 'member', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false }, attending: true };
  const snap = Number(core.store.run(`INSERT INTO setting_snapshots(setting_key, at, descriptor_json, descriptor_hash, reach_hash, exposure_rank, persistence_rank)
                                      VALUES (?, ?, ?, 'h', 'r', ?, 1)`, key, at, JSON.stringify(d), exposure).lastInsertRowid);
  core.store.run('INSERT INTO settings(key, adapter, label, stability, current_snapshot_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', key, 'zz', label, 'persistent', snap, at, at);
  return key;
}
export function seedEntity(core, { name = '阿明', kind = 'person', authority = 'none', closeness = 0.3, isSelf = 0 } = {}) {
  const at = core.now();
  const id = Number(core.store.run('INSERT INTO entities(kind, status, display_name, is_self, closeness, authority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    kind, 'established', name, isSelf, closeness, authority, at, at).lastInsertRowid);
  core.store.run('INSERT INTO entity_names(entity_id, text_raw, text_norm, first, last) VALUES (?, ?, ?, ?, ?)', id, name, name, at, at);
  return id;
}
export function seedPercept(core, { settingKey, actor = null, text = '你好', at = core.now(), ext } = {}) {
  const shard = `percepts_fts_${new Date(at).getUTCFullYear()}${String(new Date(at).getUTCMonth() + 1).padStart(2, '0')}`;
  core.store.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${shard} USING fts5(tokens, content='', contentless_delete=1, tokenize="unicode61 remove_diacritics 0 tokenchars '_'")`);
  core.store.run('INSERT OR IGNORE INTO fts_shards(name, month, created_at) VALUES (?, ?, ?)', shard, shard.slice(-6), core.now());
  const id = Number(core.store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_entity_id, actor_json, kind,
                                     text, text_hash, addressed, attention, attention_class, evidential, standing, fts_shard, created_at)
                                   VALUES ('zz', ?, ?, ?, 'setting-audience', ?, ?, ?, '{}', 'utterance', ?, 'th', 'ambient', 'attended', 'attended', 1, 'first-hand', ?, ?)`,
  ext ?? `x${++seq}`, settingKey, settingKey, at, at, actor, text, shard, core.now()).lastInsertRowid);
  core.store.run(`INSERT INTO ${shard}(rowid, tokens) VALUES (?, ?)`, id, fallbackTerms(text).join(' '));
  return id;
}
export function seedAssertion(core, { text, subjects = [], speaker = null, perceptId = null, settingKey = null, at = core.now(), supersededBy = null } = {}) {
  const id = Number(core.store.run(`INSERT INTO assertions(predicate, text, certainty, confidence, recorded_at, valid_from, superseded_by, created_at, updated_at)
                                   VALUES ('p', ?, 'stated', 0.8, ?, ?, ?, ?, ?)`, text, at, at, supersededBy, core.now(), core.now()).lastInsertRowid);
  for (const e of subjects) core.store.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')", id, e);
  core.store.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, speaker, asserter, mode, confidence, at)
                  VALUES ('assertion', ?, ?, ?, ?, ?, 'told_to_her', 0.8, ?)`, id, perceptId, settingKey, speaker, speaker, at);
  core.store.run('INSERT INTO assertions_fts(rowid, tokens) VALUES (?, ?)', id, fallbackTerms(text).join(' '));
  core.store.run("INSERT INTO flow_norms(owner_kind, owner_id, restriction, updated_at) VALUES ('assertion', ?, 'none', ?)", id, core.now());
  return id;
}
export function seedEpisode(core, { settingKey, narrative = '大家在聊天', participants = [], perceptIds = [], at = core.now() } = {}) {
  const id = Number(core.store.run(`INSERT INTO episodes(setting_key, narrative, header, t_start, t_end, participants_json, sealed_at, created_at)
                                   VALUES (?, ?, '', ?, ?, ?, ?, ?)`, settingKey, narrative, at, at, JSON.stringify(participants), at, core.now()).lastInsertRowid);
  for (const pid of perceptIds) {
    core.store.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, mode, confidence, at) VALUES ('episode', ?, ?, ?, 'overheard', 0.5, ?)`, id, pid, settingKey, at);
    core.store.run('UPDATE percepts SET episode_id = ? WHERE id = ?', id, pid);
  }
  core.store.run('INSERT INTO episodes_fts(rowid, tokens) VALUES (?, ?)', id, fallbackTerms(narrative).join(' '));
  return id;
}
