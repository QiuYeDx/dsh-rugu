// 恢复（§12.4.5、§12.4.6）、可移植导出（§12.4.7）、彻底删除后重写本地包（§12.4.8）。backup 牵头 S31、S32、S33。
// admin 用真的（墓碑重删、按来源撤回都是本人写的）；别的模块一律用照契约的替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackupCore, quietMods, seedSetting, seedEntity, seedPercept, seedAssertion, seedEpisode } from './harness.js';
import { fakeMods } from '../admin/fixtures.js';
import { createConfig } from '../../src/config/defaults.js';
import { DAY, HOUR } from '../fakes/index.js';
import { tmpDir, rmDir } from '../helpers.js';

const FAST = { backup: { scrypt: { N: 1024, r: 8, p: 1 } } };
const sqlDerivedFrom = fakeMods().mods.encode.derivedFrom;
const count = (core, sql, ...p) => Number(core.store.get(sql, ...p).n);

test('S31：用一周前的日包整体恢复——先做「恢复前」快照；之前彻底删除过的仍然不在；快照之后的消息从来源补回（历史模式）；向量库对账；恢复期间照常聊天', async () => {
  const seen = { restoringDuringSweep: null, sweeps: 0 };
  const h = await createBackupCore({
    name: 'bk-s31',
    config: FAST,
    mods: quietMods({
      encode: { derivedFrom: sqlDerivedFrom },
      worker: { sweepVectors: (core) => { seen.sweeps += 1; seen.restoringDuringSweep = core.mods.backup.isRestoring(core); return { removed: 0, requeued: 3 }; } },
    }),
  });
  const { core } = h;
  const clock = h.ports.clock;
  try {
    // 一周前：日常的记忆，做了日包
    const sk = seedSetting(core, { key: 'sk-group-a' });
    const A = seedEntity(core, { name: '阿明' });
    const p1 = seedPercept(core, { settingKey: sk, actor: A, text: '我的秘密是我欠了钱', ext: 'm-1' });
    const p2 = seedPercept(core, { settingKey: sk, actor: A, text: '周末去爬山', ext: 'm-2' });
    const a1 = seedAssertion(core, { text: '阿明欠了钱', subjects: [A], speaker: A, perceptId: p1, settingKey: sk });
    seedAssertion(core, { text: '阿明周末去爬山', subjects: [A], speaker: A, perceptId: p2, settingKey: sk });
    const [weekOld] = await core.mods.backup.createPack(core, { kind: 'daily' });
    // 这一周里：又聊了几句（之后要从来源补回）；主人彻底删除了那条秘密（之后恢复了也不能回来）
    clock.advance(DAY);
    const p3 = seedPercept(core, { settingKey: sk, actor: A, text: '我换工作了', ext: 'm-3' });
    const p4 = seedPercept(core, { settingKey: sk, actor: A, text: '新公司很远', ext: 'm-4' });
    const p5 = seedPercept(core, { settingKey: sk, actor: A, text: '刚才那句也删掉吧', ext: 'm-5' });
    clock.advance(DAY);
    await core.mods.admin.purge(core, [`p${p1}`, `p${p5}`], { by: 'owner', at: core.now() });
    assert.equal(count(core, 'SELECT count(*) AS n FROM assertions WHERE id = ?', a1), 0, '只靠那条秘密的事实一起删了');
    clock.advance(5 * DAY);
    const atP3 = core.store.get('SELECT at FROM percepts WHERE id = ?', p3).at;
    const atP4 = core.store.get('SELECT at FROM percepts WHERE id = ?', p4).at;

    // 1. 预览：包的时间、条数，和当前库的差别，恢复后要补回的经历，要再删的墓碑，确认语
    const pv = await core.mods.backup.previewRestore(core, weekOld.path);
    assert.equal(pv.ok, true);
    assert.equal(pv.pack.kind, 'daily');
    assert.equal(pv.pack.counts.percepts, 2);
    assert.equal(pv.diff.percept.lost, 2, '恢复后少掉的：这一周新来的两条');
    assert.equal(pv.diff.percept.regained, 1, '会回来的：被删的那条秘密（之后会按墓碑再删）');
    assert.ok(pv.tombstonesToReapply >= 2);
    assert.equal(pv.gaps.length, 1);
    assert.equal(pv.gaps[0].settingKey, sk);
    assert.equal(pv.gaps[0].count, 2);
    assert.equal(pv.newMachine, false);
    assert.match(pv.confirmPhrase, /^确认恢复到 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 的备份$/);
    assert.ok(pv.people.some((p) => p.entityId === A));

    // 2. 确认语不对：什么都不动
    await assert.rejects(core.mods.backup.restoreFull(core, weekOld.path, { confirmPhrase: '确认' }), { code: 'CONFIRM_MISMATCH' });
    await assert.rejects(core.mods.backup.restoreFull(core, weekOld.path, /** @type {any} */ ({})), { code: 'CONFIRM_REQUIRED' });
    assert.equal(count(core, 'SELECT count(*) AS n FROM percepts'), 3);
    assert.equal(core.mods.backup.isRestoring(core), false);

    // 3. 恢复
    const r = await core.mods.backup.restoreFull(core, weekOld.path, { confirmPhrase: pv.confirmPhrase });
    assert.equal(r.ok, true);
    assert.equal(core.mods.backup.isRestoring(core), false);
    assert.equal(seen.restoringDuringSweep, true, '恢复期间（换库后的对账）isRestoring = true：不写新记忆、不注入新回想');
    assert.equal(seen.sweeps, 1, '向量库和主库对账（缺的重新排队，期间检索按 L3 降级）');
    // 恢复前快照：恢复本身可以撤销
    assert.ok(r.preRestorePack && fs.existsSync(r.preRestorePack));
    assert.equal((await core.mods.backup.verifyPack(core, r.preRestorePack)).ok, true);
    const preManifest = await core.mods.backup.readManifest(core, r.preRestorePack);
    assert.equal(preManifest.counts.percepts, 3, '恢复前快照是恢复之前的样子');
    // 之前彻底删除过的仍然不在
    assert.equal(count(core, 'SELECT count(*) AS n FROM percepts WHERE id = ?', p1), 0);
    assert.equal(count(core, 'SELECT count(*) AS n FROM assertions WHERE id = ?', a1), 0);
    assert.ok(r.tombstonesReapplied >= 2);
    assert.ok(count(core, "SELECT count(*) AS n FROM tombstones WHERE kind = 'obs'") >= 2, '换回来的旧库里补上了之后的墓碑');
    // 快照之后的消息：缺口记下来，补回窗口开着
    assert.deepEqual(r.gaps, [{ from: atP3, to: atP4, settingKey: sk }]);
    const win = core.mods.backup.replayWindow(core);
    assert.ok(win && win.until === win.restoredAt && win.packCreatedAt === weekOld.createdAt, '这段时间交来的、发生在恢复之前的消息按历史模式入库');
    assert.equal(core.mods.backup.replayStatus(core).active, true);
    // 适配器从快照时的游标接着读，把这一周的消息再交一遍（intake 写进来；这里直接写表模拟）
    clock.advance(HOUR);
    seedPercept(core, { settingKey: sk, actor: A, text: '我换工作了', at: atP3, ext: 'm-3' });
    seedPercept(core, { settingKey: sk, actor: A, text: '新公司很远', at: atP4, ext: 'm-4' });
    const back5 = seedPercept(core, { settingKey: sk, actor: A, text: '刚才那句也删掉吧', at: atP3 + 2, ext: 'm-5' });
    // 被彻底删除过的那条：认得出来（intake 入库前问），漏进来了也会在下次启动时按墓碑删掉
    assert.deepEqual([...core.mods.admin.tombstonedObs(core, 'zz', ['m-3', 'm-5'])], ['m-5']);
    await core.mods.admin.reapplyTombstones(core);
    assert.equal(count(core, 'SELECT count(*) AS n FROM percepts WHERE id = ?', back5), 0);
    const rs = core.mods.backup.replayStatus(core);
    assert.equal(rs.active, false, '补齐了就结束跟踪');
    assert.deepEqual(rs.gaps.map((g) => [g.refilled, g.missing]), [[2, 0]]);
    assert.equal(core.mods.backup.overview(core).gaps.length, 0, '没有补不回的空白');
    // backups 表被换回了旧的：已经按目录重建（三份包都在：日包、彻底删除前的、恢复前的）
    const kinds = core.store.all('SELECT kind, reason FROM backups WHERE deleted_at IS NULL ORDER BY created_at').map((x) => `${x.kind}:${x.reason ?? ''}`);
    assert.deepEqual(kinds, ['daily:', 'pre-op:purge', 'pre-op:restore']);
    // 运维事件（只有数字）；她不会被告知「你被恢复了」：恢复本身不写任何感知
    const ev = JSON.parse(core.store.get("SELECT value FROM meta WHERE key = 'backup.lastRestore'").value);
    assert.equal(ev.kind, 'daily');
    assert.equal(count(core, "SELECT count(*) AS n FROM percepts WHERE text LIKE '%恢复%'"), 0);
    h.ports.logger.assertNoText('秘密', '欠了钱', '阿明', '爬山');
  } finally { await h.cleanup(); }
});

test('整体恢复：补不回的时间段过了补回窗口就记进总览', async () => {
  const h = await createBackupCore({ name: 'bk-gaps', config: FAST, mods: quietMods() });
  const { core } = h;
  try {
    const sk = seedSetting(core, { key: 'sk-lost' });
    seedPercept(core, { settingKey: sk, text: '包里有的' });
    const [p] = await core.mods.backup.createPack(core, { kind: 'daily' });
    h.ports.clock.advance(HOUR);
    seedPercept(core, { settingKey: sk, text: '包里没有、来源也读不回的' });
    const pv = await core.mods.backup.previewRestore(core, p.path);
    await core.mods.backup.restoreFull(core, p.path, { confirmPhrase: pv.confirmPhrase });
    h.ports.clock.advance(8 * DAY);
    const rs = core.mods.backup.replayStatus(core);
    assert.equal(rs.active, false);
    const o = core.mods.backup.overview(core);
    assert.equal(o.gaps.length, 1);
    assert.equal(o.gaps[0].missing, 1);
    assert.equal(core.mods.backup.replayWindow(core), null);
  } finally { await h.cleanup(); }
});

test('S32：新机器上用异地加密包 + 恢复码恢复——账号哈希对得上（认得出原来的人）；配置、插件配置（模型档位）、保留期都和原来一致', async () => {
  const off = tmpDir('bk-s32-offsite');
  const oldDir = tmpDir('bk-s32-old');
  const newDir = tmpDir('bk-s32-new');
  // 插件配置文件的位置（backup.configFile 还没并进 defaults.js：用一层包装的配置给出来）
  const withFile = (file, overrides) => { const base = createConfig(overrides); return { ...base, get: () => ({ ...base.get(), backup: { ...base.get().backup, configFile: file } }) }; };
  const oldPluginCfg = path.join(oldDir, 'persona-memory.json');
  fs.writeFileSync(oldPluginCfg, JSON.stringify({ model: { tier: 'light' }, gpu: 'adaptive' }));
  const A = await createBackupCore({ dir: oldDir, keepDir: true, mods: quietMods(),
    config: withFile(oldPluginCfg, { ...FAST, backup: { ...FAST.backup, offsiteDir: off }, mode: { global: 'off' }, budget: { preset: 'saving' }, time: { tzOffsetMin: 480 } }) });
  let B = null;
  try {
    const { core } = A;
    const { recoveryCode } = await core.mods.backup.setupEncryption(core);
    const friend = seedEntity(core, { name: '阿明' });
    const idHash = core.keys.identityHash('zz', '', 'u7x2k9q');
    core.store.run("INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'zz', '', ?, 'platform', ?)", friend, idHash, core.now());
    core.mods.admin.requestRetentionChange(core, { to: '5y', by: 'owner', at: core.now() });
    seedAssertion(core, { text: '阿明喜欢猫', subjects: [friend] });
    const packs = await core.mods.backup.createPack(core, { kind: 'daily' });
    const offPack = packs.find((p) => p.location === 'offsite');
    assert.ok(offPack && offPack.encrypted && offPack.verified);
    const oldKey = fs.readFileSync(path.join(oldDir, 'persona-memory.key'), 'utf8').trim();
    await A.close();
    rmDir(oldDir);   // 旧电脑坏了

    // 新机器：全新的数据目录、新生成的身份密钥、默认配置，没有备份密钥文件
    const newPluginCfg = path.join(newDir, 'persona-memory.json');
    B = await createBackupCore({ dir: newDir, keepDir: true, key: null, mods: quietMods(), config: withFile(newPluginCfg, { ...FAST, backup: { ...FAST.backup, offsiteDir: off } }) });
    const nc = B.core;
    assert.notEqual(nc.keys.identityHash('zz', '', 'u7x2k9q'), idHash, '新机器的密钥不一样，账号哈希对不上');
    const noCode = await nc.mods.backup.previewRestore(nc, offPack.path);
    assert.equal(noCode.ok, false);
    assert.deepEqual(noCode.errors, ['no-key']);
    const wrong = await nc.mods.backup.previewRestore(nc, offPack.path, { recoveryCode: nc.mods.backup.generateRecoveryCode() });
    assert.deepEqual(wrong.errors, ['wrong-recovery-code']);
    const typo = await nc.mods.backup.previewRestore(nc, offPack.path, { recoveryCode: 'AAAAA-BBBBB' });
    assert.deepEqual(typo.errors, ['recovery-code-format']);
    const pv = await nc.mods.backup.previewRestore(nc, offPack.path, { recoveryCode: recoveryCode.toLowerCase() });
    assert.equal(pv.ok, true);
    assert.equal(pv.newMachine, true);
    const r = await nc.mods.backup.restoreFull(nc, offPack.path, { confirmPhrase: pv.confirmPhrase, recoveryCode });
    assert.equal(r.ok, true);
    assert.equal(r.identityKeyReplaced, true);
    assert.equal(r.configRestored, true);
    // 认得出原来的人：同一个账号算出同一个哈希，找得到原来的档案
    const h2 = nc.keys.identityHash('zz', '', 'u7x2k9q');
    assert.equal(h2, idHash);
    assert.equal(nc.store.get('SELECT entity_id FROM identity_evidence WHERE id_hash = ?', h2).entity_id, friend);
    assert.equal(fs.readFileSync(path.join(newDir, 'persona-memory.key'), 'utf8').trim(), oldKey, '身份密钥换成了原来的那把');
    // 配置、模型档位、保留期一致；这台机器自己的路径不被旧机器的覆盖
    const cfg = nc.config.get();
    assert.equal(cfg.mode.global, 'off');
    assert.equal(cfg.budget.preset, 'saving');
    assert.equal(cfg.time.tzOffsetMin, 480);
    assert.equal(cfg.backup.offsiteDir, off);
    assert.deepEqual(JSON.parse(fs.readFileSync(newPluginCfg, 'utf8')), { model: { tier: 'light' }, gpu: 'adaptive' });
    assert.equal(nc.mods.admin.retentionState(nc).current, '5y');
    // 恢复码是主人给的：以后这台机器就能自动加密异地副本
    const again = await nc.mods.backup.createPack(nc, { kind: 'daily' });
    assert.ok(again.some((p) => p.location === 'offsite' && p.encrypted && p.verified));
    B.ports.logger.assertNoText(recoveryCode, 'u7x2k9q');
  } finally {
    try { await A.close(); } catch { /* 已关 */ }
    if (B) await B.close();
    for (const d of [off, oldDir, newDir]) { try { rmDir(d); } catch { /* 尽力 */ } }
  }
});

test('S33：有人被灌输了一套说法，主人按来源撤回，再从一个月前的月包里只取回关于这个人的记忆——其他记忆不受影响，冲突走对账，看法回到灌输之前', async () => {
  const imported = [];
  const regenerated = [];
  const h = await createBackupCore({
    name: 'bk-s33', config: FAST,
    mods: quietMods({
      encode: {
        derivedFrom: sqlDerivedFrom,
        // encode.importRecords 的替身（契约：导入的来源方式记 imported，冲突走对账；这里只记下收到了什么）
        importRecords: async (core, records, opt) => { imported.push({ records, opt }); return { accepted: records.length, skipped: 0, errors: [] }; },
      },
      consolidate: { regenerateImpressions: async (core, id) => { regenerated.push(id); } },
    }),
  });
  const { core } = h;
  const clock = h.ports.clock;
  try {
    const sk = seedSetting(core, { key: 'sk-group', label: '老同学群' });
    const X = seedEntity(core, { name: '小刚' });
    const O = seedEntity(core, { name: '小红' });
    const bad = seedEntity(core, { name: '阿坏' });
    const po = seedPercept(core, { settingKey: sk, actor: O, text: '小刚开网约车，人很靠谱' });
    const a1 = seedAssertion(core, { text: '小刚很靠谱', subjects: [X], speaker: O, perceptId: po, settingKey: sk });
    const a2 = seedAssertion(core, { text: '小刚在开网约车', subjects: [X], speaker: O, perceptId: po, settingKey: sk });
    const a3 = seedAssertion(core, { text: '小刚有个妹妹', subjects: [X], speaker: O, perceptId: po, settingKey: sk });
    const other = seedAssertion(core, { text: '小红喜欢猫', subjects: [O], speaker: O, perceptId: po, settingKey: sk });
    core.store.run("UPDATE flow_norms SET restriction = 'soft', deny_json = ? WHERE owner_kind = 'assertion' AND owner_id = ?", JSON.stringify([bad]), a2);
    clock.set(Date.UTC(2026, 9, 31, 20, 0));
    const [monthly] = await core.mods.backup.createPack(core, { kind: 'monthly' });
    const monthAgo = core.now();
    clock.advance(30 * DAY);

    // 这一个月里：阿坏一遍遍地说小刚的坏话，她的看法被带偏了；小红也被带着转述了一句
    const lies = [];
    for (let i = 0; i < 3; i++) { lies.push(seedPercept(core, { settingKey: sk, actor: bad, text: `小刚偷过东西 ${i}`, at: monthAgo + (i + 1) * DAY })); }
    const b1 = seedAssertion(core, { text: '小刚手脚不干净', subjects: [X], speaker: bad, perceptId: lies[0], settingKey: sk, at: monthAgo + DAY });
    core.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', b1, a1);
    core.store.run('UPDATE assertions SET supersedes = ? WHERE id = ?', a1, b1);
    const relay = seedPercept(core, { settingKey: sk, actor: O, text: '听说小刚被开除了', at: monthAgo + 5 * DAY });
    const c1 = seedAssertion(core, { text: '小刚不开网约车了，被开除了', subjects: [X], speaker: O, perceptId: relay, settingKey: sk, at: monthAgo + 5 * DAY });
    core.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', c1, a2);
    // 主人另外彻底删除过一条关于小刚的（取回时不能把它带回来）
    await core.mods.admin.purge(core, [`a${a3}`], { by: 'owner', at: core.now() });
    const otherBefore = core.store.get('SELECT * FROM assertions WHERE id = ?', other);

    // 1. 按来源撤回阿坏这一个月说的（admin 那一段）
    const w = core.mods.admin.withdrawBySource(core, { entityId: bad, from: monthAgo, to: core.now(), by: 'owner', at: core.now() });
    await core.mods.admin.decideReview(core, w.reviewId, 'approve');
    assert.equal(count(core, 'SELECT count(*) AS n FROM assertions WHERE id = ?', b1), 0);
    assert.equal(core.store.get('SELECT superseded_by FROM assertions WHERE id = ?', a1).superseded_by, null, '灌输的那条没了，原来的看法重新是当前版本');

    // 2. 从月包里只取回关于小刚的
    const rep = await core.mods.backup.restorePartial(core, monthly.path, { entityIds: [X] });
    assert.equal(rep.accepted, 1);
    assert.equal(rep.present, 1, '已经在当前库里的（小刚很靠谱）不重复导入');
    assert.equal(rep.tombstoned, 1, '彻底删除过的（小刚有个妹妹）不带回来');
    assert.equal(imported.length, 1);
    const { records, opt } = imported[0];
    assert.equal(opt.provenance, 'imported');
    assert.match(opt.source, /^backup:[0-9a-f]{16}$/);
    assert.deepEqual(records.map((x) => x.text), ['小刚在开网约车'], '被带偏覆盖掉的旧版本，以导入的方式合并回来（和「被开除了」的冲突交给 encode 对账）');
    assert.deepEqual(records[0].subjects, ['小刚']);
    assert.equal(records[0].sourceMeta.speaker, '小红');
    assert.equal(records[0].sourceMeta.settingLabel, '老同学群');
    assert.deepEqual(records[0].norm, { restriction: 'soft', scope: { deny: [bad] } }, '规范跟着回来');
    assert.deepEqual(regenerated, [X], '取回后对这个人的印象从事实重新生成');
    // 其他记忆不受影响
    assert.deepEqual({ ...core.store.get('SELECT * FROM assertions WHERE id = ?', other) }, { ...otherBefore });
    assert.ok(core.store.get('SELECT 1 FROM backups WHERE kind = ? AND reason = ?', 'pre-op', 'restore-partial'), '部分恢复之前也做了操作前快照');
    await assert.rejects(core.mods.backup.restorePartial(core, monthly.path, {}), { code: 'SELECTOR_EMPTY' });
    // 按时间取：某个时间以前的版本
    imported.length = 0;
    const rep2 = await core.mods.backup.restorePartial(core, monthly.path, { before: monthAgo + 1 });
    assert.ok(rep2.accepted >= 1);
    assert.ok(imported[0].records.every((x) => x.text !== '小刚有个妹妹'));
    h.ports.logger.assertNoText('小刚', '偷', '网约车');
  } finally { await h.cleanup(); }
});

test('exportJsonl：一行一个自描述的对象，不依赖表结构；加密导出要先开启加密', async () => {
  const h = await createBackupCore({ name: 'bk-export', config: FAST, mods: quietMods() });
  const { core } = h;
  try {
    const sk = seedSetting(core);
    const A = seedEntity(core, { name: '阿明' });
    const p = seedPercept(core, { settingKey: sk, actor: A, text: '我表哥开网约车' });
    const a = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [A], speaker: A, perceptId: p, settingKey: sk });
    seedAssertion(core, { text: '阿明的表哥换工作了', subjects: [A], speaker: A, perceptId: p, settingKey: sk });
    seedEpisode(core, { settingKey: sk, narrative: '阿明聊表哥', participants: [A], perceptIds: [p] });
    const dest = path.join(core.dataDir, 'out');
    fs.mkdirSync(dest);
    const r = await core.mods.backup.exportJsonl(core, { dest });
    assert.ok(r.path.startsWith(dest) && r.path.endsWith('.jsonl'));
    const lines = fs.readFileSync(r.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'header');
    assert.equal(lines[0].format, 'persona-memory-export');
    assert.equal(lines.at(-1).type, 'footer');
    assert.equal(lines.filter((l) => l.type === 'assertion').length, 2);
    const fa = lines.find((l) => l.type === 'assertion' && l.id === a);
    assert.equal(fa.sources[0].perceptId, p);
    assert.equal(fa.norm.restriction, 'none');
    assert.ok(lines.some((l) => l.type === 'entity' && l.names[0].text === '阿明'));
    assert.ok(lines.some((l) => l.type === 'episode'));
    assert.ok(lines.some((l) => l.type === 'self'));
    assert.ok(lines.some((l) => l.type === 'setting'));
    assert.deepEqual(r.counts.assertion, 2);
    await assert.rejects(core.mods.backup.exportJsonl(core, { dest, encrypt: true }), { code: 'NEED_RECOVERY_CODE' });
    await core.mods.backup.setupEncryption(core);
    const enc = await core.mods.backup.exportJsonl(core, { dest, encrypt: true });
    assert.ok(enc.path.endsWith('.pmpack'));
    assert.ok(!fs.readFileSync(enc.path).includes(Buffer.from('网约车')));
    await assert.rejects(core.mods.backup.exportJsonl(core, /** @type {any} */ ({})), TypeError);
  } finally { await h.cleanup(); }
});

test('彻底删除时「同时从所有本地备份里清除」：按墓碑重写每个包（VACUUM，删掉的内容不留在空闲页），重写后照样验证通过', async () => {
  const h = await createBackupCore({ name: 'bk-scrub', config: FAST, mods: quietMods({ encode: { derivedFrom: sqlDerivedFrom } }) });
  const { core } = h;
  try {
    const sk = seedSetting(core);
    const A = seedEntity(core, { name: '阿明' });
    const p = seedPercept(core, { settingKey: sk, actor: A, text: '绝密内容甲乙丙' });
    const a = seedAssertion(core, { text: '阿明说了绝密内容甲乙丙', subjects: [A], speaker: A, perceptId: p, settingKey: sk });
    seedAssertion(core, { text: '阿明喜欢猫', subjects: [A], speaker: A, settingKey: sk });
    const [daily] = await core.mods.backup.createPack(core, { kind: 'daily' });
    const [weekly] = await core.mods.backup.createPack(core, { kind: 'weekly' });
    const res = await core.mods.admin.purge(core, [`p${p}`], { by: 'owner', alsoBackups: true, at: core.now() });
    assert.deepEqual(res.backups, { rewritten: 3, unchanged: 0, failed: 0, failures: [] }, '日包、周包、这次的操作前快照都改写了（D143：结果带回去）');
    for (const pk of [daily, weekly]) {
      assert.equal((await core.mods.backup.verifyPack(core, pk.path)).ok, true, '重写后照样验证通过（登记的 sha256 也更新了）');
      const out = path.join(core.dataDir, `unpacked-${pk.kind}`);
      const u = await core.mods.backup.unpack(core, pk.path, { dest: out });
      const db = new DatabaseSync(u.files['main.db'], { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM assertions WHERE id = ?').get(a).n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM percepts WHERE id = ?').get(p).n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM assertions').get().n, 1, '别的记忆还在');
      } finally { db.close(); }
      assert.ok(!fs.readFileSync(u.files['main.db']).includes(Buffer.from('绝密内容甲乙丙')), '空闲页里也没有');
    }
    // 操作前快照（purge 自己刚做的那份）里本来就有它：也一起重写了
    const pre = core.store.get("SELECT path FROM backups WHERE kind = 'pre-op' AND reason = 'purge'").path;
    const u = await core.mods.backup.unpack(core, pre, { dest: path.join(core.dataDir, 'unpacked-pre') });
    assert.ok(!fs.readFileSync(u.files['main.db']).includes(Buffer.from('绝密内容甲乙丙')));
  } finally { await h.cleanup(); }
});

test('连备份一起删（D143）：解不开的包、文件不见了的包算「没改成」，带着原因回去，原包留着；改写成的照常', async () => {
  const h = await createBackupCore({ name: 'bk-scrub-fail', config: FAST, mods: quietMods({ encode: { derivedFrom: sqlDerivedFrom } }) });
  const { core } = h;
  try {
    const sk = seedSetting(core);
    const p = seedPercept(core, { settingKey: sk, text: '要从包里清掉的一句' });
    const [daily] = await core.mods.backup.createPack(core, { kind: 'daily' });
    const [weekly] = await core.mods.backup.createPack(core, { kind: 'weekly' });
    const buf = fs.readFileSync(weekly.path);
    buf[buf.length - 30] ^= 0x5a;
    fs.writeFileSync(weekly.path, buf);
    const r = await core.mods.admin.purge(core, [`p${p}`], { by: 'owner', alsoBackups: true, at: core.now() });
    assert.equal(r.backups.rewritten, 2, '日包和这次的操作前快照');
    assert.equal(r.backups.failed, 1);
    assert.equal(r.backups.failures[0].id, weekly.id);
    assert.equal(typeof r.backups.failures[0].reason, 'string');
    assert.deepEqual(fs.readFileSync(weekly.path), buf, '没改成的包原样留着');
    assert.equal((await core.mods.backup.verifyPack(core, daily.path)).ok, true);
    fs.rmSync(daily.path);
    const p2 = seedPercept(core, { settingKey: sk, text: '又一句' });
    const r2 = await core.mods.admin.purge(core, [`p${p2}`], { by: 'owner', alsoBackups: true, at: core.now() });
    assert.ok(r2.backups.failures.some((f) => f.id === daily.id && f.reason === 'missing'), '文件不见了也说出来');
  } finally { await h.cleanup(); }
});

test('整体恢复中途失败（换库之后打不开）：用「恢复前」快照换回去，库和恢复前一模一样；坏包在预览这一步就看得出来', async () => {
  const h = await createBackupCore({ name: 'bk-rollback', config: FAST, mods: quietMods() });
  const { core } = h;
  try {
    const sk = seedSetting(core);
    seedPercept(core, { settingKey: sk, text: '包里的' });
    const [p] = await core.mods.backup.createPack(core, { kind: 'daily' });
    h.ports.clock.advance(HOUR);
    seedPercept(core, { settingKey: sk, text: '恢复前新来的' });
    const before = core.store.all('SELECT id, text FROM percepts ORDER BY id').map((r) => ({ ...r }));
    const pv = await core.mods.backup.previewRestore(core, p.path);
    // 换完文件之后第一次重新打开失败
    const orig = core.reopen;
    let fail = true;
    core.reopen = async (swap) => orig(async (files) => { await swap(files); if (fail) { fail = false; throw new Error('cannot open'); } });
    await assert.rejects(core.mods.backup.restoreFull(core, p.path, { confirmPhrase: pv.confirmPhrase }), { code: 'RESTORE_FAILED' });
    assert.equal(core.mods.backup.isRestoring(core), false);
    assert.deepEqual(core.store.all('SELECT id, text FROM percepts ORDER BY id').map((r) => ({ ...r })), before);
    assert.ok(h.ports.logger.events('backup.rollback-failed').length === 0);
    // 坏包：预览直接报出来，不往下走
    const bad = path.join(core.dataDir, 'bad.pmpack');
    const buf = fs.readFileSync(p.path);
    buf[buf.length - 30] ^= 0x5a;
    fs.writeFileSync(bad, buf);
    const pb = await core.mods.backup.previewRestore(core, bad);
    assert.equal(pb.ok, false);
    assert.ok(pb.errors.length >= 1);
    await assert.rejects(core.mods.backup.restoreFull(core, bad, { confirmPhrase: pv.confirmPhrase }), { code: 'PACK_INVALID' });
  } finally { await h.cleanup(); }
});

test('整体恢复后墓碑重删失败：那批墓碑记下来，夜里做包之前补删（包里不会再带着它们）', async () => {
  const realAdmin = await import('../../src/admin/index.js');
  const h = await createBackupCore({
    name: 'bk-tomb-retry', config: FAST,
    mods: quietMods({ admin: { reapplyTombstones: async (core, opt) => {
      if (core.state.failReapply && opt?.tombstones) { core.state.failReapply = false; throw new Error('busy'); }
      return realAdmin.reapplyTombstones(core, opt);
    } } }),
  });
  const { core } = h;
  try {
    const a = seedAssertion(core, { text: '要删的那条' });
    const [p] = await core.mods.backup.createPack(core, { kind: 'daily' });
    h.ports.clock.advance(HOUR);
    await core.mods.admin.purge(core, [`a${a}`], { by: 'owner', at: core.now() });
    const pv = await core.mods.backup.previewRestore(core, p.path);
    core.state.failReapply = true;
    const r = await core.mods.backup.restoreFull(core, p.path, { confirmPhrase: pv.confirmPhrase });
    assert.equal(r.ok, true);
    assert.ok(core.store.get('SELECT 1 FROM assertions WHERE id = ?', a), '这次没删成');
    assert.ok(h.ports.logger.events('backup.restore-tombstones-failed').length === 1);
    h.ports.clock.advance(DAY);
    await core.mods.backup.runScheduled(core, { at: core.now() });
    assert.equal(count(core, 'SELECT count(*) AS n FROM assertions WHERE id = ?', a), 0, '夜里补删了');
    assert.equal(core.store.get("SELECT value FROM meta WHERE key = 'backup.tombstonesPending'")?.value ?? null, null);
    const [tonight] = core.store.all("SELECT path FROM backups WHERE kind = 'daily' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1");
    const m = await core.mods.backup.readManifest(core, tonight.path);
    assert.equal(m.counts.assertions, 0, '今晚的包里已经没有它');
  } finally { await h.cleanup(); }
});

test('§12.4.6 拷过来的本机包：包本身不加密，但里面的身份密钥是包住的——新机器上要恢复码才解得开', async () => {
  const oldDir = tmpDir('bk-copy-old');
  const newDir = tmpDir('bk-copy-new');
  const A = await createBackupCore({ dir: oldDir, keepDir: true, mods: quietMods(), config: FAST });
  let B = null;
  try {
    const { recoveryCode } = await A.core.mods.backup.setupEncryption(A.core);
    const e = seedEntity(A.core, { name: '阿明' });
    const h = A.core.keys.identityHash('zz', '', 'u3k8p1m');
    A.core.store.run("INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'zz', '', ?, 'platform', ?)", e, h, A.core.now());
    const [local] = await A.core.mods.backup.createPack(A.core, { kind: 'manual' });
    assert.equal(local.encrypted, false);
    const copied = path.join(newDir, 'copied.pmpack');
    fs.copyFileSync(local.path, copied);
    await A.close();
    B = await createBackupCore({ dir: newDir, keepDir: true, key: null, mods: quietMods(), config: FAST });
    const nc = B.core;
    const pv = await nc.mods.backup.previewRestore(nc, copied);
    assert.equal(pv.ok, true);
    assert.ok(pv.warnings.includes('identity-key-locked'), '预览就提示：身份密钥要恢复码');
    await assert.rejects(nc.mods.backup.restoreFull(nc, copied, { confirmPhrase: pv.confirmPhrase }), { code: 'NEED_RECOVERY_CODE' });
    assert.equal(nc.store.get('SELECT count(*) AS n FROM entities').n, 0, '没换库');
    await assert.rejects(nc.mods.backup.restoreFull(nc, copied, { confirmPhrase: pv.confirmPhrase, recoveryCode: nc.mods.backup.generateRecoveryCode() }), { code: 'WRONG_RECOVERY_CODE' });
    const r = await nc.mods.backup.restoreFull(nc, copied, { confirmPhrase: pv.confirmPhrase, recoveryCode });
    assert.equal(r.identityKeyReplaced, true);
    assert.equal(nc.keys.identityHash('zz', '', 'u3k8p1m'), h);
    assert.ok(nc.mods.backup.overview(nc).offsite.encrypted, '恢复码派生的备份密钥装进了这台机器');
  } finally {
    try { await A.close(); } catch { /* 已关 */ }
    if (B) await B.close();
    rmDir(oldDir); rmDir(newDir);
  }
});
