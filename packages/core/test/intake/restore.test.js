// 和备份恢复、彻底删除的配合（§12.4.5、§12.7、D27）：
//   - 彻底删除过的消息（admin.tombstonedObs）重投、从来源补回时不再入库；
//   - 整体恢复期间（backup.isRestoring）什么都不写：感知留在队列里，describe / sealBuffers / expectRelay / observeInternal 挂起，
//     换库时（dispose → init）队列接着用，恢复完按顺序补上；恢复期间排队的批次不推进游标；
//   - 补回窗口（backup.replayWindow）里交来的、发生在恢复之前的消息按历史模式入库；
//   - 恢复后有 start() 的适配器重启一次，从恢复出来的游标重读；重启之前排队的批次不推进游标。
// admin / backup 用 helpers 里按契约写的替身（t.env 控制）；最后一个用例用真的 backup 整体恢复走一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readMetrics } from '../../src/store/kv.js';
import { ftsSearch } from '../../src/store/fts.js';
import { textHash } from '../../src/contract/ids.js';
import { createConfig } from '../../src/config/defaults.js';
import { withIntake, ingest, obs, descriptor, makeAdapter, sid, ADAPTER, T0, M } from './helpers.js';

const metric = (core, name) => readMetrics(core.store).filter((r) => r.name === name).reduce((a, r) => a + r.value, 0);
const count = (core, sql, ...p) => Number(core.store.get(sql, ...p).n);
const metricTotal = (core) => count(core, 'SELECT coalesce(sum(value), 0) AS n FROM metrics');
const tick = () => new Promise((r) => setImmediate(r));

// ── 彻底删除过的消息 ────────────────────────────────────────────────────────

test('§12.7：彻底删除过的消息重投不再入库；同一批别的照常入库、游标照常推进；一批只问一次 admin，给的是存储键', () => withIntake((t) => {
  const purged = obs('g', 'friend', '被彻底删掉的那句');
  const keep = obs('g', 'friend', '留着的');
  t.env.tombstoned.add(t.core.keys.obsKey(ADAPTER, purged.id));
  const r = ingest(t, [purged, keep], { cursor: { key: 'g', value: '2' } });
  assert.equal(r.accepted, 1);
  assert.equal(r.dropped, 1);
  assert.deepEqual(t.rows().map((p) => p.text), ['留着的']);
  assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), '2');
  assert.equal(metric(t.core, 'intake.dropped.tombstoned'), 1);
  assert.equal(t.calls['admin.tombstonedObs'].length, 1);
  const [adapter, keys] = t.calls['admin.tombstonedObs'][0];
  assert.equal(adapter, ADAPTER);
  assert.equal(keys.length, 2);
  assert.ok(!keys.includes(purged.id) && !keys.includes(keep.id), 'ObsId 原值不出 intake');
  // 指向它的撤回、编辑也不入库（编辑带着它改过的原话）
  const edit = obs('g', 'friend', '改过的原话', { kind: 'edit', target: purged.id, at: T0 + M });
  const retract = obs('g', 'friend', '', { kind: 'retract', target: purged.id, evidential: false, at: T0 + M });
  assert.equal(ingest(t, [edit, retract]).dropped, 2);
  assert.equal(t.rows().length, 1);
  assert.equal(metric(t.core, 'intake.dropped.tombstoned'), 3);
  t.core.log.assertNoText('被彻底删掉的那句', '改过的原话', purged.id);
}));

test('§12.7：声明是彻底删除过的那条的副本（derivedFrom，别的适配器转进来的）不入库；按副本所在的适配器去问', () => withIntake((t) => {
  const OTHER = 'tfake2';
  const origId = 'orig-msg-1';
  t.env.tombstoned.add(t.core.keys.obsKey(OTHER, origId));
  const copy = obs('g', 'friend', '转进来的那句被删掉的话', { derivedFrom: { adapter: OTHER, obsId: origId } });
  const fresh = obs('g', 'friend', '别处转来的、没删过的', { derivedFrom: { adapter: OTHER, obsId: 'orig-msg-2' } });
  const r = ingest(t, [copy, fresh]);
  assert.equal(r.dropped, 1);
  assert.deepEqual(t.rows().map((p) => p.text), ['别处转来的、没删过的']);
  const asked = t.calls['admin.tombstonedObs'].map(([adapter, keys]) => [adapter, keys.length]);
  assert.deepEqual(asked.sort(), [[ADAPTER, 2], [OTHER, 2]], '每个适配器问一次，同一批只问一次');
  assert.equal(metric(t.core, 'intake.dropped.tombstoned'), 1);
  t.core.log.assertNoText('转进来的那句被删掉的话', origId);
}));

test('§12.7：引用了彻底删除过的那条：新消息照常入库，但不留被引用的原话和作者（FTS 里也没有）', () => withIntake((t) => {
  const purged = obs('g', 'other', '被彻底删掉的原话');
  t.env.tombstoned.add(t.core.keys.obsKey(ADAPTER, purged.id));
  const reply = obs('g', 'friend', '我同意楼上', { quote: { obs: purged.id, author: purged.actor, excerpt: '被彻底删掉的原话' } });
  const keep = obs('g', 'friend', '引用一条还在的', { quote: { obs: 'still-here', excerpt: '还在的原话' } });
  assert.equal(ingest(t, [reply, keep]).accepted, 2);
  const [a, b] = t.rows();
  const qa = JSON.parse(a.quote_json);
  assert.equal(qa.gone, true);
  assert.equal(qa.excerpt, undefined);
  assert.equal(qa.author, undefined);
  assert.equal(typeof qa.obsKey, 'string', '只留「引用了一条」');
  assert.equal(JSON.parse(b.quote_json).excerpt, '还在的原话');
  assert.equal(metric(t.core, 'intake.quote.tombstoned'), 1);
  // 词法路找不到被删的原话（FTS 只索引新消息自己的文字）；还在的引用照常能找到
  const find = (text) => ftsSearch(t.core.store, a.fts_shard, t.core.mods.lang.queryTerms(t.core, text)).map((h) => h.rowid);
  assert.ok(!find('删掉').includes(a.id));
  assert.ok(find('原话').includes(b.id));
  assert.ok(find('楼上').includes(a.id));
}));

test('§12.7：墓碑查不了 → 整批不提交（感知和游标都没写），留在队列头上，好了以后补上', () => withIntake((t) => {
  const real = t.core.mods.admin.tombstonedObs;
  let broken = true;
  t.core.mods = { ...t.core.mods, admin: { ...t.core.mods.admin, tombstonedObs: (...a) => { if (broken) throw new Error('tombstones unavailable'); return real(...a); } } };
  t.observe([obs('g', 'friend', '一'), obs('g', 'friend', '二')], { cursor: { key: 'g', value: '2' } });
  assert.equal(t.drain().accepted, 0);
  assert.equal(t.rows().length, 0);
  assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), null);
  broken = false;
  assert.equal(t.drain().accepted, 2);
  assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), '2');
}));

test('§12.7：observeInternal 同一个 dedupeKey 被彻底删除过 → 不再写（返回 0）', () => withIntake((t) => {
  const p = { settingKey: t.key('g'), kind: 'self-utterance', text: '她说过、后来被删掉的话', at: T0, visibleTo: 'setting-audience', dedupeKey: 'tok-purged' };
  t.env.tombstoned.add(t.core.keys.hash('core', 'tok-purged'));
  assert.equal(t.core.mods.intake.observeInternal(t.core, p), 0);
  assert.equal(t.rows().length, 0);
  assert.equal((t.calls['discretion.onSelfUtterance'] ?? []).length, 0);
  assert.ok(t.core.mods.intake.observeInternal(t.core, { ...p, dedupeKey: 'tok-ok' }) > 0);
}));

// ── 补回窗口：历史模式 ──────────────────────────────────────────────────────

test('§12.4.5 第 6 步：补回窗口里交来的、发生在恢复之前的消息按历史模式入库（不预取）；恢复之后发生的照常', () => withIntake((t) => {
  const restoredAt = T0 + 10 * M;
  t.env.replay = { packCreatedAt: T0 - 60 * M, restoredAt, until: restoredAt };
  t.clock.set(restoredAt + M);
  const old = obs('g', 'friend', '快照之后、恢复之前说的', { at: T0 + 5 * M, addressed: 'to-her' });
  const live = obs('g', 'friend', '恢复以后刚说的', { at: restoredAt + M, addressed: 'to-her' });
  const r = ingest(t, [old, live]);
  assert.equal(r.accepted, 2);
  const [a, b] = t.rows();
  assert.equal(a.historical, 1);
  assert.equal(b.historical, 0);
  assert.equal(metric(t.core, 'intake.replayed'), 1);
  // 只有恢复以后的那条通知预取
  const notified = (t.calls['retrieve.onPercepts'] ?? []).flatMap(([, rows]) => rows.map((x) => x.id));
  assert.deepEqual(notified, [b.id]);
  // 补回窗口关了：照常
  t.env.replay = null;
  ingest(t, [obs('g', 'friend', '窗口关了以后补来的旧消息', { at: T0 + 6 * M })]);
  assert.equal(t.rows().at(-1).historical, 0);
}));

// ── 整体恢复期间 ────────────────────────────────────────────────────────────

test('D27：整体恢复期间什么都不写（感知、游标、窗口、计数）；恢复完补上，恢复期间排队的批次不推进游标', () => withIntake((t) => {
  const { intake } = t.core.mods;
  ingest(t, [obs('g', 'friend', '恢复之前')], { cursor: { key: 'g', value: '1' } });
  const metricsBefore = metricTotal(t.core);
  t.env.restoring = true;
  t.observe([obs('g', 'friend', '恢复期间来的一'), obs('g', 'friend', '恢复期间来的二')], { cursor: { key: 'g', value: '3' } });
  const r = t.drain();
  assert.equal(r.accepted, 0);
  assert.equal(r.waiting, 1);
  assert.equal(t.rows().length, 1);
  assert.deepEqual(intake.flushWindows(t.core, { force: true }), { windows: 0, pending: 0 });
  assert.equal(count(t.core, 'SELECT count(*) AS n FROM raw_windows'), 0);
  assert.equal(metricTotal(t.core), metricsBefore, '恢复期间连计数都不写');
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '1');
  // 恢复结束
  t.env.restoring = false;
  const r2 = t.drain();
  assert.equal(r2.accepted, 2);
  assert.deepEqual(t.rows().map((p) => p.text), ['恢复之前', '恢复期间来的一', '恢复期间来的二']);
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '1', '恢复出来的游标不被恢复前的位置盖掉（适配器从它重读，重复的去重）');
  assert.equal(metric(t.core, 'intake.cursor.stale'), 1);
  assert.equal(metric(t.core, 'intake.restore.resumed'), 1);
  // 之后的批次照常推进游标
  ingest(t, [obs('g', 'friend', '之后')], { cursor: { key: 'g', value: '4' } });
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '4');
}));

test('D27：恢复期间的 describe / sealBuffers / sealBuffersByKey / expectRelay / observeInternal 先挂起，恢复完按顺序补上', () => withIntake((t) => {
  const { intake } = t.core.mods;
  ingest(t, [obs('g', 'friend', '一')]);
  const lastBefore = t.rows().at(-1).id;
  t.env.restoring = true;
  // 新场合：恢复期间描述的（同一个场合只留最新的一份）
  t.describe(descriptor('later', { label: '旧称呼' }));
  t.describe(descriptor('later', { label: '新称呼' }));
  intake.sealBuffers(t.core, sid('g'));
  intake.sealBuffersByKey(t.core, t.key('g'));
  const orig = obs('g', 'friend', '要被转达的原话');
  intake.expectRelay(t.core, { adapter: ADAPTER, obsId: orig.id, textHash: textHash(orig.text), until: T0 + 60 * M });
  const pid = intake.observeInternal(t.core, { settingKey: t.key('g'), kind: 'self-utterance', text: '恢复期间她在别处说的', at: T0, visibleTo: 'setting-audience', appraisalToken: 'tok-r', dedupeKey: 'tok-r' });
  assert.equal(pid, 0, '恢复期间先挂起，返回 0');
  t.observe([obs('later', 'friend', '新场合里的一句')]);
  t.drain();
  assert.equal(intake.settingByKey(t.core, t.key('later')), null);
  assert.equal(intake.settingByKey(t.core, t.key('g')).checkpointPercept, null);
  assert.equal(count(t.core, 'SELECT count(*) AS n FROM relays'), 0);
  assert.equal(t.rows().length, 1);
  assert.equal(t.core.state.intake.held.length, 5);   // describe 合成一份
  // 恢复结束：先补挂起的（场合描述在前，批次要用），再处理队列
  t.env.restoring = false;
  t.drain();
  const later = intake.settingByKey(t.core, t.key('later'));
  assert.equal(later.label, '新称呼');
  assert.equal(count(t.core, 'SELECT count(*) AS n FROM setting_snapshots WHERE setting_key = ?', t.key('later')), 1);
  assert.ok(intake.settingByKey(t.core, t.key('g')).checkpointPercept >= lastBefore);
  assert.equal(count(t.core, 'SELECT count(*) AS n FROM relays'), 1);
  const texts = t.rows().map((p) => p.text);
  assert.ok(texts.includes('恢复期间她在别处说的') && texts.includes('新场合里的一句'));
  const self = t.rows().find((p) => p.text === '恢复期间她在别处说的');
  assert.equal(self.appraisal_token, 'tok-r');
  assert.ok(t.calls['discretion.onSelfUtterance'].some(([p]) => p.id === self.id), '补写的她的话照常通知（按令牌对上审视记录）');
  assert.equal(t.core.state.intake.held.length, 0);
  // 参数不合法的照样当场抛错（调用方兜住），不挂起
  t.env.restoring = true;
  assert.throws(() => intake.observeInternal(t.core, { settingKey: t.key('g'), kind: 'utterance', text: 'x', at: T0, dedupeKey: 'bad' }), TypeError);
  assert.equal(t.core.state.intake.held.length, 0);
}));

test('D27：换库时 reopen 先 dispose 再 init——恢复期间的队列和挂起的操作接着用，换库那一小段里来的也不丢', () => withIntake(async (t) => {
  const { intake } = t.core.mods;
  t.env.restoring = true;
  t.observe([obs('g', 'friend', '换库前来的')], { cursor: { key: 'g', value: '1' } });
  t.drain();
  intake.sealBuffersByKey(t.core, t.key('g'));
  intake.dispose(t.core);                       // reopen：先 dispose（这时还在恢复）
  t.observe([obs('g', 'friend', '换库的那一小段来的')]);   // 库关着、模块还没重新 init
  intake.init(t.core);                          // 重新 init：接着用
  assert.equal(t.core.state.intake.queues.get(ADAPTER).length, 2);
  assert.equal(t.core.state.intake.held.length, 1);
  await tick();
  assert.equal(t.rows().length, 0, '还在恢复：init 排的那次 drain 接着等');
  t.env.restoring = false;
  t.drain();
  assert.deepEqual(t.rows().map((p) => p.text), ['换库前来的', '换库的那一小段来的']);
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), null, '恢复期间排队的批次不推进游标');
  // 不在恢复时的 dispose：照旧把队列处理掉、清空（之后 init 是全新的）
  t.observe([obs('g', 'friend', '关库前最后一句')]);
  intake.dispose(t.core);
  assert.equal(t.rows().at(-1).text, '关库前最后一句');
  intake.init(t.core);
  assert.equal(t.core.state.intake.queues.size, 0);
}));

test('D27：恢复期间 drain 隔 restorePollMs 自己再看一次，恢复一结束就补上（不用等新消息）', async () => {
  // intake.restorePollMs 是 defaults.js 里的键：主人的配置改得了（mergeConfig 不当未知键丢掉）
  const warnings = [];
  const handle = createConfig({ time: { tzOffsetMin: 480 }, intake: { restorePollMs: 10 } }, { onWarn: (w) => warnings.push(...w) });
  assert.equal(handle.get().intake.restorePollMs, 10);
  assert.deepEqual(warnings, []);
  await withIntake(async (t) => {
    t.env.restoring = true;
    t.observe([obs('g', 'friend', '等恢复结束')]);
    await tick();
    assert.equal(t.rows().length, 0);
    assert.ok(t.core.state.intake.holdTimer, '定了一个再看的定时器');
    t.env.restoring = false;
    for (let i = 0; i < 50 && !t.rows().length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(t.rows().length, 1);
  }, { configHandle: handle });
});

test('flushWindows（tick 调）：队列里还有没处理的批次时顺便安排一次 drain', () => withIntake(async (t) => {
  t.core.mods.intake.enqueue(t.core, ADAPTER, [obs('g', 'friend', '定时器丢了')]);
  // 模拟 setImmediate 丢了：取消掉
  clearImmediate(t.core.state.intake.immediate);
  t.core.state.intake.scheduled = false;
  t.core.mods.intake.flushWindows(t.core);
  await tick();
  assert.equal(t.rows().length, 1);
}));

// ── 恢复后适配器从游标重读 ────────────────────────────────────────────────────

test('§12.4.5 第 6 步：恢复后有 start() 的适配器重启一次（从恢复出来的游标重读）；重启之前排队的批次不推进游标；同一次恢复只重启一次', () => withIntake((t) => {
  const { intake } = t.core.mods;
  const a = t.adapter;
  assert.equal(a.starts, 1);
  a.sink.observe([obs('g', 'friend', '一')], { cursor: { key: 'g', value: '1' } });
  t.drain();
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '1');
  // 恢复：库换回了快照（这里游标还是 '1'），补回窗口开了
  t.env.restoring = true;
  a.sink.observe([obs('g', 'friend', '恢复期间')], { cursor: { key: 'g', value: '5' } });
  t.drain();
  t.env.restoring = false;
  t.env.replay = { packCreatedAt: T0 - 60 * M, restoredAt: T0, until: T0 };
  // 恢复刚结束、适配器还没重启时又交来一批（它内存里的位置在恢复之前的前面）
  const oldSink = a.sink;
  a.sink.observe([obs('g', 'friend', '恢复后、重启前')], { cursor: { key: 'g', value: '6' } });
  t.drain();
  assert.equal(a.starts, 2, '重启了一次');
  assert.equal(a.stopped, false);
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '1', '重启之前排队的批次都不推进游标');
  assert.equal(metric(t.core, 'intake.adapter.replayRestart'), 1);
  // 重启后的 sink 照常用，游标照常推进
  a.sink.observe([obs('g', 'friend', '重读来的')], { cursor: { key: 'g', value: '7' } });
  t.drain();
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '7');
  // 停掉之前发出去的读取晚到了，还用旧的 sink 交来：感知照常入库，游标不被它往回拨、也不被它往前推
  oldSink.observe([obs('g', 'friend', '旧的一代晚到的')], { cursor: { key: 'g', value: '6' } });
  t.drain();
  assert.ok(t.rows().some((p) => p.text === '旧的一代晚到的'));
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '7');
  // 同一次恢复（同一个 restoredAt）不再重启
  t.env.restoring = true;
  t.drain();
  t.env.restoring = false;
  t.drain();
  assert.equal(a.starts, 2);
  // 注册时就已经在补回窗口里的适配器：它刚从库里的游标开始读，不为这次恢复重启
  const b = makeAdapter({}, { id: 'tfake2' });
  t.core.adapters.set(b.id, b);
  intake.registerAdapter(t.core, b);
  t.env.restoring = true;
  t.drain();
  t.env.restoring = false;
  t.drain();
  assert.equal(b.starts, 1);
}));

test('恢复后重启适配器：start() 出错只计数（不抛到 drain 外面）；注销过的适配器不再重启', () => withIntake((t) => {
  const { intake } = t.core.mods;
  const a = makeAdapter({ g: descriptor('g') });
  let fail = false;
  const realStart = a.start;
  a.start = (sink) => { if (fail) throw new Error('start failed'); return realStart(sink); };
  t.core.adapters.set(a.id, a);
  const unregister = intake.registerAdapter(t.core, a);
  const b = makeAdapter({}, { id: 'tfake2' });
  t.core.adapters.set(b.id, b);
  intake.registerAdapter(t.core, b)();          // 注册了又注销
  fail = true;
  t.env.restoring = true;
  t.drain();
  t.env.restoring = false;
  t.env.replay = { packCreatedAt: T0 - 60 * M, restoredAt: T0, until: T0 };
  assert.doesNotThrow(() => t.drain());
  assert.equal(metric(t.core, 'intake.adapter.restart.error'), 1);
  assert.equal(b.starts, 1);
  unregister();
}, { register: false }));

test('D27：挂起的操作按到达的先后补——在它之前到达的批次写完就补，不等后来的批次（补回大量历史时不一直拖着）', async () => {
  // drainBudgetMs = 0：每次 drain 处理一批就让出，看得出补的时机
  const base = createConfig({ time: { tzOffsetMin: 480 } });
  const handle = { ...base, get: () => ({ ...base.get(), intake: { ...base.get().intake, drainBudgetMs: 0 } }) };
  await withIntake((t) => {
    const { intake } = t.core.mods;
    t.env.restoring = true;
    t.observe([obs('g', 'friend', '封口之前到的')]);
    intake.sealBuffersByKey(t.core, t.key('g'));
    t.observe([obs('g', 'friend', '封口之后到的')]);
    t.drain();
    t.env.restoring = false;
    t.drain();   // 只写了第一批就让出：检查点补在它后面
    const first = t.rows().find((p) => p.text === '封口之前到的');
    assert.ok(first);
    assert.equal(t.rows().length, 1);
    assert.equal(intake.settingByKey(t.core, t.key('g')).checkpointPercept, first.id, '检查点 = 封口时最新的那条，不含之后到的');
    assert.equal(t.core.state.intake.held.length, 0);
    t.drain();
    assert.equal(t.rows().length, 2);
    assert.equal(intake.settingByKey(t.core, t.key('g')).checkpointPercept, first.id);
  }, { configHandle: handle });
});

test('§12.4.5 第 6 步：没有 start() 的适配器——恢复后它的游标停在恢复出来的位置，它读过一次这个键（api.cursor）之后到的批次才接着推进；重新注册就清掉', () => withIntake((t) => {
  const { intake } = t.core.mods;
  const a = makeAdapter({ g: descriptor('g') }, { start: undefined });
  t.core.adapters.set(a.id, a);
  intake.registerAdapter(t.core, a);
  t.describe(descriptor('g'));
  ingest(t, [obs('g', 'friend', '一')], { cursor: { key: 'g', value: '1' } });
  ingest(t, [obs('g', 'friend', '一h')], { cursor: { key: 'h', value: '1' } });
  // 恢复：库换回快照（游标都是 '1'），补回窗口开了
  t.env.restoring = true;
  t.observe([obs('g', 'friend', '恢复期间')], { cursor: { key: 'g', value: '5' } });
  t.drain();
  t.env.restoring = false;
  t.env.replay = { packCreatedAt: T0 - 60 * M, restoredAt: T0, until: T0 };
  // 它还没读游标：照它内存里的位置交来的批次，感知照常入库，游标不推进
  ingest(t, [obs('g', 'friend', '恢复后、读游标之前')], { cursor: { key: 'g', value: '6' } });
  assert.equal(intake.cursor(t.core, ADAPTER, 'h'), '1');   // 顺便读了 h（还没交批次）
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '1');   // 读到恢复出来的位置：之后的批次照常
  assert.equal(metric(t.core, 'intake.adapter.replayResync'), 1);
  assert.ok(t.rows().some((p) => p.text === '恢复后、读游标之前'));
  ingest(t, [obs('g', 'friend', '从恢复出来的位置重读的')], { cursor: { key: 'g', value: '7' } });
  assert.equal(intake.cursor(t.core, ADAPTER, 'g'), '7');
  ingest(t, [obs('g', 'friend', '二h')], { cursor: { key: 'h', value: '2' } });
  assert.equal(intake.cursor(t.core, ADAPTER, 'h'), '2');
  // 一直没读过的键：这次运行里不推进（它下次注册时从恢复出来的位置重读）
  ingest(t, [obs('g', 'friend', '一k')], { cursor: { key: 'k', value: '9' } });
  assert.equal(intake.cursor(t.core, ADAPTER, 'k'), null);
  // 同一次恢复不会再标一次；重新注册（适配器重启）清掉
  t.drain();
  assert.equal(metric(t.core, 'intake.adapter.replayResync'), 1);
  intake.registerAdapter(t.core, a);
  ingest(t, [obs('g', 'friend', '二k')], { cursor: { key: 'k', value: '10' } });
  assert.equal(intake.cursor(t.core, ADAPTER, 'k'), '10');
}, { register: false }));

test('回填的旧发言（historical=1）也通知 discretion.onSelfUtterance（「告诉过谁」照样要记；它自己不补评估、不比眼下的注入）；不通知预取', () => withIntake((t) => {
  const mine = obs('g', 'her', '我以前跟大家说过的话', { at: T0 - 3 * 24 * 60 * M });
  ingest(t, [mine], { historical: true });
  const row = t.rows()[0];
  assert.equal(row.historical, 1);
  assert.deepEqual((t.calls['discretion.onSelfUtterance'] ?? []).map(([p]) => p.id), [row.id]);
  assert.equal((t.calls['retrieve.onPercepts'] ?? []).length, 0);
}));

// ── sealBuffersByKey ─────────────────────────────────────────────────────────

test('sealBuffersByKey（context.compaction 重启后只有场合键）：只记检查点；不认识的键只计数；不抛错', () => withIntake((t) => {
  const { intake } = t.core.mods;
  ingest(t, [obs('g', 'friend', '一'), obs('g', 'friend', '二')]);
  intake.sealBuffersByKey(t.core, t.key('g'));
  assert.equal(intake.settingByKey(t.core, t.key('g')).checkpointPercept, t.rows().at(-1).id);
  assert.ok(t.rows().every((p) => p.episode_id === null));
  intake.sealBuffersByKey(t.core, 'no-such-setting-key');
  assert.equal(metric(t.core, 'intake.seal.unknown'), 1);
  assert.doesNotThrow(() => intake.sealBuffersByKey(t.core, /** @type {any} */ (null)));
  assert.doesNotThrow(() => intake.sealBuffersByKey(t.core, /** @type {any} */ (42)));
  // SettingId 不当成场合键：sealBuffersByKey 只认键
  intake.sealBuffersByKey(t.core, sid('g'));
  assert.equal(metric(t.core, 'intake.seal.unknown'), 2);
}));

// ── 真的整体恢复走一遍（backup、admin 用真的；reopen 真的关库、换文件、重新 init） ─────────────

test('S31（intake 段，真的整体恢复）：恢复期间交来的留在队列里、换库后接着用；补回的旧消息按历史模式；彻底删过的不回来；适配器重启后从恢复出来的游标重读', async () => {
  const { createBackupCore, quietMods } = await import('../backup/harness.js');
  const seen = { during: null };
  const h = await createBackupCore({
    name: 'intake-s31',
    config: { backup: { scrypt: { N: 1024, r: 8, p: 1 } }, time: { tzOffsetMin: 480 } },
    mods: quietMods({
      // 换库之后、恢复结束之前（还在恢复）：适配器照常交来一条；drain 一条都不写
      worker: {
        sweepVectors: (core) => {
          const at = core.now();
          a.sink.observe([obs('g', 'friend', '恢复期间来的', { at })], { cursor: { key: 'g', value: '5' } });
          seen.during = { restoring: core.mods.backup.isRestoring(core), report: core.mods.intake.drain(core) };
          return { removed: 0, requeued: 0 };
        },
        enqueueEmbed: () => {},
      },
      retrieve: { onPercepts: () => {} },
      discretion: { onSelfUtterance: () => {} },
    }),
  });
  const { core } = h;
  const clock = h.ports.clock;
  const a = makeAdapter({ g: descriptor('g') });
  const texts = () => core.store.all('SELECT text FROM percepts ORDER BY at, id').map((r) => r.text);
  try {
    core.adapters.set(a.id, a);
    core.mods.intake.registerAdapter(core, a);
    a.sink.describe(descriptor('g'));
    const m = [1, 2, 3, 4].map((i) => obs('g', 'friend', `第${i}条`, { at: clock.now() + i * 1000 }));
    a.sink.observe(m.slice(0, 2), { cursor: { key: 'g', value: '2' } });
    core.mods.intake.drain(core);
    const [pack] = await core.mods.backup.createPack(core, { kind: 'daily' });
    // 包做完之后：又来了两条；主人把第 2 条彻底删了
    clock.advance(60 * M);
    const m3 = { ...m[2], at: clock.now() };
    const m4 = { ...m[3], at: clock.now() + 1000 };
    a.sink.observe([m3, m4], { cursor: { key: 'g', value: '4' } });
    core.mods.intake.drain(core);
    const p2 = core.store.get('SELECT id FROM percepts WHERE text = ?', '第2条').id;
    await core.mods.admin.purge(core, [`p${p2}`], { by: 'owner', at: core.now() });
    clock.advance(60 * M);

    // 换库之前（已经在恢复）交来一条：reopen 先 dispose 再 init，队列要接着用
    const realReopen = core.reopen;
    core.reopen = async (swap) => {
      a.sink.observe([obs('g', 'friend', '换库前来的', { at: core.now() - 1 })], { cursor: { key: 'g', value: '4' } });
      await realReopen(swap);
    };
    const pv = await core.mods.backup.previewRestore(core, pack.path);
    const r = await core.mods.backup.restoreFull(core, pack.path, { confirmPhrase: pv.confirmPhrase });
    assert.equal(r.ok, true);
    assert.equal(seen.during.restoring, true);
    assert.equal(seen.during.report.accepted, 0);
    assert.ok(seen.during.report.waiting >= 1);
    // 换回了快照：第 2 条被按墓碑再删一遍，第 3、4 条不在了，游标是快照时的
    assert.deepEqual(texts(), ['第1条']);
    assert.equal(core.mods.intake.cursor(core, a.id, 'g'), '2');
    assert.equal(a.starts, 1);

    // 恢复结束后的第一次 drain：恢复期间来的那条写进恢复出来的库（不推进游标）；适配器重启一次
    core.mods.intake.drain(core);
    assert.deepEqual(texts(), ['第1条', '换库前来的', '恢复期间来的']);
    assert.equal(core.mods.intake.cursor(core, a.id, 'g'), '2', '游标还是恢复出来的那个');
    assert.equal(a.starts, 2, '适配器重启了，从恢复出来的游标重读');

    // 适配器从游标 2 往后重读：第 3、4 条按历史模式补回；它多给的第 2 条（彻底删过）不回来；恢复期间那条去重
    const during = core.store.get('SELECT * FROM percepts WHERE text = ?', '恢复期间来的');
    a.sink.observe([m[1], m3, m4], { cursor: { key: 'g', value: '4' } });
    core.mods.intake.drain(core);
    assert.deepEqual(texts(), ['第1条', '第3条', '第4条', '换库前来的', '恢复期间来的']);
    const rows = core.store.all('SELECT text, historical FROM percepts ORDER BY at, id');
    // 第 3、4 条和换库前来的那条都发生在恢复时刻之前：历史模式（不冒出过期的「回头问问」）
    assert.deepEqual(rows.map((x) => x.historical), [0, 1, 1, 1, 0]);
    assert.equal(core.mods.intake.cursor(core, a.id, 'g'), '4');
    assert.equal(core.store.get('SELECT id FROM percepts WHERE text = ?', '恢复期间来的').id, during.id);
    assert.equal(core.mods.backup.replayStatus(core).gaps[0].refilled, 2);
    h.ports.logger.assertNoText('第2条', '恢复期间来的');
  } finally { await h.cleanup(); }
});
