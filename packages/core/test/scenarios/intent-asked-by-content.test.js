// 意图「问过了」按内容认（D134）：她在哪儿问了同一件事都算问过了，不只认注入过这条意图的那个会话。
// 回放的是一次实测的形状（内容是编的）：前一晚他在私聊里说头疼，她起意「问问他头疼好了没」；早上她在一个群里问过了，
// 半小时后这条意图又在私聊里浮上来，她又问了一遍。修好以后：她说了对得上的话就记一次执行，之后哪个场合都不再提起。
// 「对象在这个场合」：在这句话的听众里，或者以前亲自在这里说过话（成员列不全的群里，半小时没开口的人照样是这里的人）。
// 真模块 + 替身端口 + 假平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { runJobs } from '../../src/maintenance.js';
import { JOB_TOLD_SCAN } from '../../src/discretion/index.js';
import { openWorld, platformSeeds, FakeLLM, MINUTE, glancer } from './presence-world.js';
import { FakeEmbedding } from '../fakes/index.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const TO_HER = { addressed: 'to-her', attention: 'attended' };
const AMBIENT = { addressed: 'ambient', attention: 'peripheral' };
const metric = (core, name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;

/** 一个成员列不全的群（只看得到最近说话的人）。 */
function addGroup(w, name, label) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`iabc-${SEED}`, 'setting', name);
  Object.assign(d, { id, label });
  d.audience = { ...d.audience, size: 40, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' };
  d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
  d.capabilities = { preSendGate: true, canHold: false };
  w.fp.settings[name] = { id, descriptor: d };
  w.fp.sink.describe(structuredClone(d));
}

async function world(name, opt = {}) {
  const w = await openWorld({ seed: SEED, name, config: LIVE, llm: new FakeLLM({ fallback: { appraise: () => [], glance: glancer() } }), friendDm: true, ...opt });
  addGroup(w, 'groupY', '群Y');
  addGroup(w, 'groupZ', '群Z');
  await w.flush();
  await w.core.mods.worker.ensureSpace(w.core);   // 向量空间就绪（嵌入可用时异步比对才拿得到向量）
  return w;
}

/** 前一晚：他在私聊里说头疼，她起意明早问问他（她自己起意的，证据是他的话）。返回 {target, iid}。 */
async function evening(w, text = '问问他头疼好了没') {
  const ache = w.say('oneOnOne', 'principal', '我头有点疼，先睡了', TO_HER);
  w.say('oneOnOne', 'her', '快去睡吧');
  await w.flush();
  const target = w.perceptOf(ache).actor_entity_id;
  const at = w.clock.now();
  const iid = w.core.mods.encode.formIntention(w.core, {
    about: null, targetEntityId: target, act: '问候', text, origin: 'self-care',
    trigger: { timeWindow: { start: at + 8 * 60 * MINUTE, end: at + 14 * 60 * MINUTE }, cues: [{ entity: target }] }, evidencePerceptIds: [w.perceptOf(ache).id],
  }, { at });
  assert.ok(iid, '意图形成了');
  w.clock.advance(9 * 60 * MINUTE);
  return { target, iid };
}

const stateOf = (w, iid) => w.core.store.get('SELECT state, executions_json FROM intentions WHERE id = ?', iid);
const open = (w, iid) => ['formed', 'armed'].includes(stateOf(w, iid).state);
const due = (w, where, target) => w.core.mods.encode.dueIntentions(w.core, { presentEntityIds: [target], settingKey: w.keyOf(where), at: w.clock.now() }).map((r) => r.id);
/** 她说一句，落库、跑完关口③的异步比对。 */
async function herSays(w, where, text) {
  const o = w.say(where, 'her', text);
  await w.flush();
  await runJobs(w.core, { kinds: [JOB_TOLD_SCAN] });
  return o;
}

test('意图从没注入过任何会话：她在和他的私聊里问了对得上的话 → 记一次执行，之后哪个场合都不再浮上来', async () => {
  const w = await world('iabc-dm');
  try {
    const { target, iid } = await evening(w);
    assert.ok(due(w, 'oneOnOne', target).includes(iid), '到点了：私聊里会浮上来');
    assert.ok(due(w, 'groupY', target).includes(iid), '他在的群里也会');
    await herSays(w, 'oneOnOne', '你头疼好了没');
    const s = stateOf(w, iid);
    assert.equal(s.state, 'executed', JSON.stringify(s));
    const ex = JSON.parse(s.executions_json);
    assert.deepEqual([ex.length, ex[0].targetEntityId, ex[0].settingKey], [1, target, w.keyOf('oneOnOne')]);
    assert.ok(metric(w.core, 'discretion.told.intention.byContent.sync') + metric(w.core, 'discretion.told.intention.byContent.async') >= 1, '按内容认出来的记了数');
    // 执行记下以后：别的会话、别的场合都不再提起（现有机制自然的结果）
    for (const where of ['oneOnOne', 'groupY', 'groupZ']) assert.ok(!due(w, where, target).includes(iid), `${where} 不再浮上来`);
    w.clock.advance(60 * MINUTE);
    assert.ok(!due(w, 'groupY', target).includes(iid), '过一会儿也不会');
  } finally { await w.close(); }
});

test('群里问了：他几个小时前在这个群说过话（不在最近 30 分钟里）→ 算执行；他从没在那个群说过话 → 不算', async () => {
  const w = await world('iabc-group');
  try {
    w.say('groupY', 'principal', '这周谁值班', AMBIENT);
    await w.flush();
    w.clock.advance(60 * MINUTE);
    const { target, iid } = await evening(w);
    // 群Z：只有别人在说话，他从没来过
    w.say('groupZ', 'other', '有人在吗', AMBIENT);
    await w.flush();
    await herSays(w, 'groupZ', '你头疼好了没');
    assert.ok(open(w, iid), '他不在群Z：不算问过了');
    await herSays(w, 'groupY', '你头疼好了没');
    const s = stateOf(w, iid);
    assert.equal(s.state, 'executed', JSON.stringify(s));
    assert.equal(JSON.parse(s.executions_json)[0].settingKey, w.keyOf('groupY'));
    assert.ok(!due(w, 'oneOnOne', target).includes(iid), '私聊里不再浮上来');
  } finally { await w.close(); }
});

test('说的话和意图不相干 → 意图照旧开着；在和别人的私聊里说了对得上的话 → 不算对他执行', async () => {
  const w = await world('iabc-other');
  try {
    const { target, iid } = await evening(w);
    await herSays(w, 'oneOnOne', '今天外面好像要下雨，出门记得带伞');
    assert.ok(open(w, iid), '不相干的话不算');
    w.say('friendDm', 'friend', '在吗', TO_HER);
    await w.flush();
    await herSays(w, 'friendDm', '你头疼好了没');
    assert.ok(open(w, iid), '对别人说的不算对他执行');
    assert.ok(due(w, 'oneOnOne', target).includes(iid), '私聊里照旧会浮上来');
  } finally { await w.close(); }
});

test('嵌入不可用：字面那条路（共有的区分性词）照样认得出；字面对不上的同一句，嵌入可用时靠向量认出来', async () => {
  // 字面：意图文字里有几个只在这件事里出现的词（猫的名字、手术），她问的时候用了两个以上
  const w = await world('iabc-lex');
  try {
    w.ports.embedding.setFailing(true);
    const { iid } = await evening(w, '问问他家团子的绝育手术做了没');
    await herSays(w, 'oneOnOne', '团子绝育手术做完了吗');
    assert.equal(stateOf(w, iid).state, 'executed', '嵌入挂了，字面认得出');
    assert.ok(metric(w.core, 'discretion.told.intention.byContent.async') >= 1, '同步比对拿不到 IDF 对不上，是异步任务按区分性词认出来的');
  } finally { await w.close(); }
  // 向量：换了个说法（替身嵌入里把「脑袋还难受吗」当成「头疼好了没」的同义说法），和意图文字一个共同的词都没有；
  // 嵌入挂了时认不出（意图照旧开着），嵌入可用时靠向量认出来
  for (const failing of [true, false]) {
    const v = await world(`iabc-vec-${failing}`, { embedding: new FakeEmbedding({ synonyms: [['头疼好了没', '脑袋还难受吗']] }) });
    try {
      if (failing) v.ports.embedding.setFailing(true);
      const { iid } = await evening(v);
      await herSays(v, 'oneOnOne', '脑袋还难受吗');
      assert.equal(open(v, iid), failing, `嵌入${failing ? '挂了：认不出，照旧开着' : '可用：认出来了'}`);
      if (!failing) assert.ok(metric(v.core, 'discretion.told.intention.byContent.async') >= 1, '是异步任务按向量认出来的');
    } finally { await v.close(); }
  }
});
