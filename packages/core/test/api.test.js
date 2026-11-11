import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPersonaMemory, CAPABILITIES, SCHEMA_VERSION, ContractError, NotImplementedError, validateRecallLayers, isOpaqueId } from '../src/index.js';
import { MODULES } from '../src/api.js';
import { openDatabase, migrate, MIGRATIONS, enqueueJob, getJob, setMetaJson } from '../src/store/index.js';
import { readPack } from '../src/backup/format.js';
import { fakePorts } from './fakes/index.js';
import { tmpDir, rmDir } from './helpers.js';

const open = (dataDir, extra = {}) => createPersonaMemory({ dataDir, ports: fakePorts(), startWorker: false, ...extra });
const withPm = (name, fn) => async () => {
  const dir = tmpDir(name);
  const pm = await open(dir);
  try { await fn(pm, dir); } finally { await pm.close(); rmDir(dir); }
};

// 各模块必须导出的函数（docs/实现/模块与接口.md §4 和附录 A）。实现者不能改名或删掉；要加新的导出可以。
// 阶段 B 之后新加、而 api.js / maintenance.js 依赖的（intake.flushWindows、backup.isRestoring / setupEncryption / overview、
// worker.health / spaces / activateSpace）也锁在这里；阶段 B 接线时模块之间新接上的调用（discretion.decideSettingRule ← admin，
// admin.withdrawReviews ← entities，admin.tombstonedObs ← intake，admin.inheritSuppression ← 写派生内容的模块，backup.replayWindow / replayStatus ← intake、retrieve，
// intake.dropFromWindows ← admin.purge，intake.sealBuffersByKey ← context）也一样。
const MODULE_EXPORTS = {
  lang: ['init', 'dispose', 'registry', 'createUnicodeAnalyzer', 'createZhAnalyzer', 'indexTokens', 'queryTerms', 'distinctiveTerms'],
  intake: ['init', 'dispose', 'registerAdapter', 'enqueue', 'drain', 'describe', 'sealBuffers', 'expectRelay', 'cursor', 'resolveSetting',
    'settingByKey', 'snapshotById', 'observeInternal', 'assignEpisode', 'markAssessed', 'expireRawText', 'sanitizeForStore', 'sanitizeForPrompt', 'recentPercepts',
    'flushWindows', 'dropFromWindows', 'sealBuffersByKey'],
  entities: ['init', 'dispose', 'ensureSelf', 'ensurePrincipal', 'registerAdapterClaims', 'resolveActor', 'ensureSettingEntity', 'noteMention',
    'nameMatcher', 'candidates', 'resolveExtracted', 'link', 'setBond', 'setStatus', 'writeImpression', 'profile', 'bondOf', 'isIndividual',
    'rightsHolder', 'belief', 'principals', 'userDictionary'],
  encode: ['init', 'dispose', 'segment', 'runExtract', 'buildExtractPrompt', 'parseJsonl', 'verify', 'taintCheck', 'reconcile', 'reviewFlagged',
    'writeEpisode', 'writeAssertion', 'addSource', 'supersede', 'markChanged', 'transitionPlan', 'formIntention', 'transitionIntention',
    'recordExecution', 'dueIntentions', 'recheckIntention', 'ensurePredicate', 'derivedFrom', 'onPerceptRetracted', 'onPerceptEdited',
    'note', 'fix', 'importRecords', 'prioritizeExtraction'],
  dynamics: ['init', 'dispose', 'attentionClass', 'encodingWeight', 'addTrace', 'inheritActivation', 'traceState', 'baseActivationOf',
    'baseActivation', 'perceptActivation', 'activate', 'sample', 'pRecall', 'seededNoise', 'pHold', 'tense', 'intentionBias', 'retier',
    'currentMood', 'pushMood'],
  retrieve: ['init', 'dispose', 'buildCues', 'recall', 'onPercepts', 'prefetch', 'cached', 'fuse', 'mmr', 'render', 'looksLikePast',
    'backgroundForExtraction', 'degradeLevel', 'workingSet'],
  discretion: ['init', 'dispose', 'recordPresence', 'recordKnowledge', 'knownCircle', 'audienceOf', 'writeNorm', 'normOf', 'tightenNorm',
    'inheritNorm', 'applyNormUpdate', 'writeSettingRule', 'settingRules', 'stage1', 'stage2', 'gate', 'targetFor', 'appraise', 'outcome',
    'holdDecision', 'onSelfUtterance', 'logDecision', 'decideSettingRule', 'admitWorking', 'explicitLimit', 'relaxLimit'],
  context: ['init', 'dispose', 'resident', 'refreshResident', 'coreBlock', 'recall', 'recallCached', 'bindSession', 'recordInjection',
    'confirmInjection', 'abortPending', 'compaction', 'markTurnTaint', 'recordStep', 'taintLedger', 'sessionInfo', 'prepareAfterPrefetch'],
  consolidate: ['init', 'dispose', 'shouldSleep', 'sleep', 'todaySoFar', 'updateStoryline', 'regenerateImpressions', 'timeMaintenance',
    'growthBlock', 'applyGrowth', 'revokeGrowth', 'rollbackGrowth', 'growthVersions'],
  worker: ['init', 'dispose', 'start', 'stop', 'denseSearch', 'lexicalSearch', 'termStats', 'pprSearch', 'enqueueEmbed', 'dropEmbeddings',
    'runEmbedQueue', 'embedQuery', 'storedVectors', 'ensureSpace', 'shadowReembed', 'maintenance', 'sweepVectors',
    'health', 'spaces', 'activateSpace'],
  backup: ['init', 'dispose', 'backupDir', 'preOperationSnapshot', 'createPack', 'verifyPack', 'rotate', 'runScheduled', 'restoreDrill',
    'previewRestore', 'restoreFull', 'restorePartial', 'exportJsonl', 'rescan', 'generateRecoveryCode', 'isRestoring',
    'setupEncryption', 'overview', 'replayWindow', 'replayStatus'],
  admin: ['init', 'dispose', 'list', 'get', 'simulate', 'enqueueReview', 'listReview', 'decideReview', 'expireReviews', 'pendingCount',
    'notifyNeedToKnow', 'listNeedToKnow', 'markNeedToKnowRead', 'addRule', 'revokeRule', 'activeRules', 'modeFor', 'doNotRemember',
    'suppress', 'restore', 'suppression', 'suppressedRefs', 'purge', 'reapplyTombstones', 'withdrawBySource', 'retentionState',
    'requestRetentionChange', 'cancelRetentionChange', 'applyRetention', 'tombstonedObs', 'withdrawReviews', 'inheritSuppression', 'relaxLimit'],
};

test('每个模块都导出约定的函数（模块与接口.md §4）', () => {
  assert.deepEqual(Object.keys(MODULES).sort(), Object.keys(MODULE_EXPORTS).sort());
  for (const [name, fns] of Object.entries(MODULE_EXPORTS)) {
    for (const fn of fns) assert.equal(typeof MODULES[name][fn], 'function', `${name}.${fn} 不见了`);
  }
});

test('API 的形状（§4.5）；启动步骤都跑了', withPm('api-shape', async (pm, dir) => {
  assert.equal(pm.protocol, 2);
  assert.deepEqual(pm.capabilities, CAPABILITIES);
  for (const fn of ['registerAdapter', 'observe', 'describe', 'sealBuffers', 'expectRelay', 'cursor', 'modeOf', 'resident', 'recall', 'recallCached', 'note', 'fix', 'status', 'close']) {
    assert.equal(typeof pm[fn], 'function', fn);
  }
  assert.equal(typeof pm.self.coreBlock, 'function');
  assert.equal(typeof pm.expression.appraise, 'function');
  assert.equal(typeof pm.expression.outcome, 'function');
  assert.equal(typeof pm.ingest.import, 'function');
  for (const fn of ['list', 'get', 'simulate', 'pendingCount']) assert.equal(typeof pm.admin[fn], 'function', `admin.${fn}`);
  assert.equal(typeof pm.admin.review.list, 'function');
  assert.equal(typeof pm.admin.review.decide, 'function');
  for (const fn of ['setupEncryption', 'overview']) assert.equal(typeof pm.admin.backup[fn], 'function', `admin.backup.${fn}`);
  for (const fn of ['health', 'spaces', 'activate']) assert.equal(typeof pm.admin.embedding[fn], 'function', `admin.embedding.${fn}`);
  for (const fn of ['runJobs', 'sleep', 'tick']) assert.equal(typeof pm.maintenance[fn], 'function', fn);
  for (const fn of ['bind', 'injected', 'confirm', 'abort', 'compaction', 'markTurnTaint', 'step', 'get']) assert.equal(typeof pm.sessions[fn], 'function', fn);
  const st = pm.status();
  assert.equal(st.readOnly, false);
  assert.equal(st.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(st.schema, { ok: true, missing: [] });
  assert.deepEqual(st.startup.jobs, { requeued: 0 });
  assert.ok(Number.isInteger(st.startup.self.self) && Number.isInteger(st.startup.self.principal), '启动时建好她自己和主人（entities.ensureSelf / ensurePrincipal）');
  assert.notEqual(st.startup.self.self, st.startup.self.principal);
  assert.equal(st.startup.tombstones?.error, undefined, '墓碑重删跑了');
  assert.deepEqual(st.startup.sweep, { removed: 0, requeued: 0 }, '不起线程也做启动清扫（§12.8）');
  assert.equal(st.startup.worker, undefined, 'startWorker:false 不起线程');
  assert.equal(pm._core.keyFile, path.join(dir, 'persona-memory.key'), 'core.keyFile：身份哈希密钥的位置（backup 用）');
  // 【D138】上一次夜间整理的摘要：只有数字和步名
  assert.equal(st.sleep, null, '还没跑过');
  setMetaJson(pm._core.store, 'sleep.lastReport', { startedAt: 5, llmCalls: 6, llmMax: 6, capped: ['generalize'],
    steps: [{ name: 'generalize', detail: { asked: 2, written: 1, skippedAsked: 3, left: 0, groups: 6 } }, { name: 'self', detail: { diaries: 2, diaryPending: 1, reasons: 0 } }] });
  assert.deepEqual(pm.status().sleep, { at: 5, llmCalls: 6, llmMax: 6, capped: ['generalize'],
    generalize: { asked: 2, written: 1, skippedAsked: 3, left: 0 }, diary: { written: 2, pending: 1 } });
}));

test('启动步骤失败只降级，不让 createPersonaMemory 失败；keyFile 可以放在数据目录以外', async () => {
  const dir = tmpDir('api-degrade');
  const keyDir = tmpDir('api-keyfile');
  const keyFile = path.join(keyDir, 'k.key');
  try {
    const first = await open(dir, { keyFile });
    await first.close();
    assert.ok(fs.existsSync(keyFile));
    assert.ok(!fs.existsSync(path.join(dir, 'persona-memory.key')), '给了 keyFile 就不在数据目录里另建');
    const db = openDatabase({ file: path.join(dir, 'persona-memory.db') });
    db.exec('DROP TABLE tombstones');
    db.close();
    const pm = await open(dir, { keyFile });
    try {
      assert.equal(pm._core.keyFile, keyFile);
      const st = pm.status();
      assert.deepEqual(st.schema.missing, ['tombstones']);
      assert.ok(st.startup.tombstones.error, '这一步失败了，记下错误类型');
      assert.ok(Number.isInteger(st.startup.self.self), '别的步骤照跑');
      assert.ok(st.startup.sweep);
    } finally { await pm.close(); }
  } finally { rmDir(dir); rmDir(keyDir); }
});

test('同步入队类的方法永不抛错（§4.5）', withPm('api-quiet', async (pm) => {
  assert.doesNotThrow(() => pm.observe(null));
  assert.doesNotThrow(() => pm.observe([{ junk: true }], { adapter: 'zz' }));
  assert.doesNotThrow(() => pm.describe({}, { adapter: 'zz' }));
  assert.doesNotThrow(() => pm.sealBuffers(42));
  assert.doesNotThrow(() => pm.expectRelay(null));
  assert.doesNotThrow(() => pm.expression.outcome('t1', 'exploded'));
  assert.doesNotThrow(() => pm.expression.outcome('t1', 'sent'));
}));

test('委托给模块：参数先过契约，再交给真模块（没描述过的场合走外发守护，D113）', withPm('api-delegate', async (pm) => {
  const S = { settingId: 'S1', trigger: 'message' };
  const R = { mode: 'involuntary', deadlineMs: 800, budgetChars: 600 };
  // 读：返回值合契约；没描述过的场合没有可想起的东西
  const res = pm.resident('S1');
  assert.equal(typeof res.text, 'string');
  assert.equal(typeof res.version, 'string');
  assert.deepEqual(res.itemIds, []);
  await assert.rejects(pm.recall({ settingId: 'S1' }, R), (e) => e instanceof ContractError);
  const layers = await pm.recall(S, R);
  assert.ok(validateRecallLayers(layers).ok, JSON.stringify(validateRecallLayers(layers).errors));
  assert.deepEqual(layers.items, []);
  assert.ok(validateRecallLayers(pm.recallCached({ settingId: 'S1', trigger: 'idle' })).ok);
  const cb = pm.self.coreBlock('S1');
  assert.equal(cb.text, pm._core.ports.selfProfile.coreSelf().text, '核心自我来自 selfProfile');
  assert.equal(typeof cb.hash, 'string');
  // 说：目标场合不认识（D113）→ 走外发守护；会话里什么都没注入过，没有要守的叮嘱和私下的话 → 照常说（不是公开目标，不 fail closed）
  const u = { channel: { targetSettingId: 'S1', persistence: 'once' }, text: ['好'], origin: { path: 'tool' } };
  await assert.rejects(pm.expression.appraise({ ...u, text: [] }), (e) => e instanceof ContractError);
  const ap = await pm.expression.appraise(u);
  assert.equal(ap.verdict, 'speak');
  assert.ok(isOpaqueId(ap.token));
  // 写：工具的授权只依据库里那条感知（§10.8）
  const actor = { claims: [] };
  assert.equal((await pm.note({ triggerObsId: 'm1', speaker: actor, op: 'remember', text: 'x', evidenceQuote: 'x' })).status, 'rejected');
  assert.equal((await pm.fix({ triggerObsId: 'm1', speaker: actor, op: 'forget', target: 'a1', evidenceQuote: 'x' })).status, 'rejected');
  await assert.rejects(pm.ingest.import([{ subjects: ['a'], text: 'b', sourceMeta: {} }], { provenance: 'told', source: 'x' }), (e) => e instanceof ContractError);
  const imp = await pm.ingest.import([{ subjects: ['a'], text: '导入的一条', sourceMeta: {} }], { provenance: 'imported', source: 'test' });
  assert.deepEqual([imp.accepted, imp.skipped, imp.errors], [1, 0, []]);
  assert.ok(pm.admin.list({ view: 'memories' }).items.some((m) => m.text === '导入的一条'), '管理页看得到导入的记忆');
  assert.equal(pm.cursor('zz', 'file'), null);
  // 审核：id 规范化（D23）之后交给 admin；不存在的审核项由 admin 报错
  await assert.rejects(pm.admin.review.decide(1, 'approve'), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(pm.admin.review.decide('7', 'reject'), (e) => e.code === 'NOT_FOUND', '数字字符串也认（D23）');
  for (const [id, d] of [['a1', 'approve'], [0, 'approve'], [1.5, 'approve'], [1, 'maybe']]) {
    await assert.rejects(pm.admin.review.decide(id, d), (e) => e instanceof ContractError, `${id} / ${d}`);
  }
  assert.deepEqual(pm.admin.review.list(), []);
  assert.equal(pm.admin.pendingCount(true), 0);
  // 会话账本
  pm.sessions.bind({ sessionId: 's', settingId: 'S1', adapterId: 'zz', confidence: 'specific' });
  assert.equal(pm.sessions.get('s').sessionId, 's');
  // 带 settingId 的先经 intake.resolveSetting：没描述过的场合是契约错误
  assert.throws(() => pm.admin.setMode('S1', 'live'), (e) => e instanceof ContractError);
  assert.throws(() => pm.modeOf('S1'), (e) => e instanceof ContractError);
  // registerAdapter：形状不对抛 ContractError；同一个 id 不能注册两次；注销以后不在了
  assert.throws(() => pm.registerAdapter({ id: 'zz' }), (e) => e instanceof ContractError);
  const a = { id: 'zz', protocol: 2, describeSetting() {}, selfClaims: () => [], principalClaims: () => [] };
  const off = pm.registerAdapter(a);
  assert.deepEqual(pm.status().adapters, ['zz']);
  assert.throws(() => pm.registerAdapter({ ...a }), /重复/);
  off();
  off();
  assert.deepEqual(pm.status().adapters, []);
}));

test('registerAdapter：intake 抛错时不留下半注册的适配器', withPm('api-register-fail', async (pm) => {
  const core = pm._core;
  const real = core.mods;
  core.mods = Object.freeze({ ...real, intake: Object.freeze({ ...real.intake, registerAdapter: () => { throw new Error('boom'); } }) });
  try {
    const a = { id: 'zz', protocol: 2, describeSetting() {}, selfClaims: () => [], principalClaims: () => [] };
    assert.throws(() => pm.registerAdapter(a), /boom/);
    assert.deepEqual(pm.status().adapters, []);
  } finally { core.mods = real; }
}));

test('整体恢复期间不注入新回想（§12.4.5 第 2 步）', withPm('api-restoring', async (pm) => {
  const core = pm._core;
  const real = core.mods;
  const calls = [];
  const context = Object.freeze({ ...real.context, recall: (...a) => { calls.push('recall'); return real.context.recall(...a); }, recallCached: (...a) => { calls.push('cached'); return real.context.recallCached(...a); } });
  let restoring = true;
  core.mods = Object.freeze({ ...real, context, backup: Object.freeze({ ...real.backup, isRestoring: () => restoring }) });
  try {
    const S = { settingId: 'S1', trigger: 'message' };
    const layers = await pm.recall(S, { mode: 'deliberate', deadlineMs: 800, budgetChars: 600 });
    assert.deepEqual([layers.items.length, layers.degradeLevel, layers.traceId], [0, 4, 'restoring']);
    assert.equal(pm.recallCached(S).traceId, 'restoring');
    assert.deepEqual(calls, [], '恢复期间不去 context 取');
    await assert.rejects(pm.recall({ settingId: 'S1' }, { mode: 'deliberate', deadlineMs: 800, budgetChars: 600 }), (e) => e instanceof ContractError, '参数照样先过契约');
    restoring = false;
    await pm.recall(S, { mode: 'involuntary', deadlineMs: 800, budgetChars: 600 });
    assert.deepEqual(calls, ['recall']);
  } finally { core.mods = real; }
}));

test('maintenance：runJobs 按登记的处理函数跑；没实现的不重试', withPm('api-jobs', async (pm) => {
  const core = pm._core;
  const ran = [];
  core.jobHandlers.set('demo', async (c, job) => { ran.push(job.id); c.store.run("UPDATE jobs SET status = 'done' WHERE id = ?", job.id); });
  core.jobHandlers.set('todo', async () => { throw new NotImplementedError('demo.todo'); });
  const j1 = enqueueJob(core.store, { kind: 'demo' });
  const j2 = enqueueJob(core.store, { kind: 'todo' });
  const j3 = enqueueJob(core.store, { kind: 'no-handler' });
  const r = await pm.maintenance.runJobs({ maxJobs: 10, kinds: ['demo', 'todo', 'no-handler'] });
  assert.deepEqual(r, { ran: 1, failed: 1 });
  assert.deepEqual(ran, [j1.id]);
  assert.equal(getJob(core.store, j2.id).status, 'failed');
  assert.equal(getJob(core.store, j2.id).last_error, 'NOT_IMPLEMENTED');
  assert.equal(getJob(core.store, j3.id).status, 'queued', '没有处理函数的留在队列里');
  for (const kind of ['extract']) assert.equal(typeof core.jobHandlers.get(kind), 'function', `模块在 init 里登记了 ${kind}`);
}));

test('maintenance.tick：按 §1「后台」的顺序跑，每一步独立；夜间整理开始了就不等它', withPm('api-tick', async (pm) => {
  const core = pm._core;
  const t = await pm.maintenance.tick({ sleep: true });
  assert.deepEqual(Object.keys(t), ['windows', 'segment', 'time', 'reviews', 'today', 'embed', 'retention', 'sleep']);
  for (const [k, v] of Object.entries(t)) assert.equal(v?.error, undefined, `${k}：${JSON.stringify(v)}`);
  assert.ok(['started', 'not-due'].includes(t.sleep), t.sleep);
  const report = await pm.maintenance.sleep();   // 正在跑就是同一次；跑完了就是新的一次
  assert.ok(Array.isArray(report.steps) && report.steps.length > 0);
  const t2 = await pm.maintenance.tick({ sleep: true });
  assert.equal(t2.sleep, 'not-due', '刚整理过');
  assert.equal('sleep' in await pm.maintenance.tick({ sleep: false }), false);
  // 一步出错只影响它自己
  const real = core.mods;
  const boom = () => { const e = new Error('x'); e.code = 'BOOM'; throw e; };
  core.mods = Object.freeze({ ...real, encode: Object.freeze({ ...real.encode, segment: boom }), intake: Object.freeze({ ...real.intake, flushWindows: boom }) });
  try {
    const t3 = await pm.maintenance.tick({ sleep: false });
    assert.deepEqual([t3.windows, t3.segment], [{ error: 'BOOM' }, { error: 'BOOM' }]);
    for (const k of ['time', 'reviews', 'today', 'embed', 'retention']) assert.equal(t3[k]?.error, undefined, k);
  } finally { core.mods = real; }
}));

test('tick 开始的夜间整理还在跑时关库：先中止、等它停下，再关库', async () => {
  const dir = tmpDir('api-close-sleep');
  try {
    const pm = await open(dir);
    const t = await pm.maintenance.tick({ sleep: true });
    assert.equal(t.sleep, 'started');
    await pm.close();
    assert.equal(pm._core.store.closed, true);
    const again = await open(dir);
    assert.equal(again.status().readOnly, false, '库没被弄坏，写者锁也放了');
    await again.close();
  } finally { rmDir(dir); }
});

test('迁移前自动备份（经 backup.preOperationSnapshot，存成 .pmpack）', async () => {
  const dir = tmpDir('api-premig');
  try {
    const old = openDatabase({ file: path.join(dir, 'persona-memory.db') });
    await migrate(old, MIGRATIONS, { target: 4 });
    old.run("INSERT INTO meta(key, value) VALUES ('marker', 'before')");
    old.close();
    const pm = await open(dir);
    try {
      assert.equal(pm.status().migration.from, 4);
      const snap = pm.status().migration.backup;
      assert.ok(snap && fs.existsSync(snap), '迁移前快照在');
      assert.ok(path.resolve(snap).startsWith(path.resolve(dir, 'backup', 'pre-op')));
      assert.ok(snap.endsWith('.pmpack'));
      const out = path.join(dir, 'unpacked');
      const pack = await readPack(snap, { outDir: out });
      assert.equal(pack.manifest.schemaVersion, 4);
      const db = new DatabaseSync(pack.files['main.db'], { readOnly: true });
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
        assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'marker'").get().value, 'before');
      } finally { db.close(); }
    } finally { await pm.close(); }
  } finally { rmDir(dir); }
});

test('只读模式：库比代码新 → 不注入、不摄入（§12.5）', async () => {
  const dir = tmpDir('api-ro');
  try {
    const first = await open(dir);
    await first.close();
    const db = openDatabase({ file: path.join(dir, 'persona-memory.db') });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const pm = await open(dir);
    try {
      assert.equal(pm.readOnly, true);
      assert.equal(pm.status().readOnlyReason, 'newer-schema');
      assert.equal(pm.status().startup.mode, 'read-only');
      assert.deepEqual(pm.resident('S1'), { text: '', version: 'read-only', itemIds: [] });
      const layers = await pm.recall({ settingId: 'S1', trigger: 'message' }, { mode: 'involuntary', deadlineMs: 800, budgetChars: 600 });
      assert.deepEqual([layers.items.length, layers.degradeLevel], [0, 4]);
      assert.doesNotThrow(() => pm.observe([{}], { adapter: 'zz' }));
      await assert.rejects(pm.note({ triggerObsId: 'm1', speaker: { claims: [] }, op: 'remember', text: 'x', evidenceQuote: 'x' }), (e) => e.code === 'READ_ONLY');
      const a = await pm.expression.appraise({ channel: { targetSettingId: 'S1', persistence: 'once' }, text: ['好'], origin: { path: 'tool' } });
      assert.equal(a.verdict, 'speak');
      assert.equal(pm.admin.pendingCount(true), 0);
      assert.equal(pm.modeOf('S1'), 'off');
    } finally { await pm.close(); }
  } finally { rmDir(dir); }
});

test('close 幂等；关了以后可以再打开（写者锁已释放）', async () => {
  const dir = tmpDir('api-close');
  try {
    const pm = await open(dir);
    await pm.close();
    await pm.close();
    const again = await open(dir);
    assert.equal(again.status().migration.applied.length, 0);
    await again.close();
    assert.ok(fs.existsSync(path.join(dir, 'persona-memory.key')), '身份哈希密钥在数据目录里生成');
  } finally { rmDir(dir); }
});
