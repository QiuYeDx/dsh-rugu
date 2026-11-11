// 她自己开口的一轮（空闲唤醒，D132）：没有人在问她，但别处刚发生的事她得知道。
// 回放的是一次实测（内容是编的）：前一晚他在私聊里说头疼；第二天早上她在群里问他好了没，他答好多了、还没吃早饭；
// 过了二十分钟她在私聊里主动开口——修之前这一轮没有工作记忆（没有「眼前这个人」）、回想沿用昨晚那一刻算好的候选，
// 她又问了一遍头还疼不疼。
// 真模块 + 替身端口 + 假平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, platformSeeds, FakeLLM, MINUTE, glancer } from './presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
const metric = (core, name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
const TO_HER = { addressed: 'to-her', attention: 'attended' };
const AMBIENT = { addressed: 'ambient', attention: 'peripheral' };

function addGroup(w) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`st-${SEED}`, 'setting', 'groupY');
  Object.assign(d, { id, label: '群Y' });
  d.audience = { ...d.audience, size: 40, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' };
  d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
  d.capabilities = { preSendGate: true, canHold: false };
  w.fp.settings.groupY = { id, descriptor: d };
  w.fp.sink.describe(structuredClone(d));
}
async function world(name, config = {}) {
  const w = await openWorld({ seed: SEED, name, config: { ...LIVE, ...config }, llm: new FakeLLM({ fallback: { appraise: () => [], glance: glancer() } }), friendDm: true });
  addGroup(w);
  await w.flush();
  return w;
}
const bind = (w, sid, where) => w.pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings[where].id, adapterId: w.fp.namespace, confidence: 'specific' });
/** 她自己开启的一轮：没有触发消息。 */
const selfTurn = (w, where, sid) => w.pm.recall({ settingId: w.fp.settings[where].id, trigger: 'idle', ...(sid ? { sessionId: sid } : {}) },
  { mode: 'involuntary', deadlineMs: 3000, budgetChars: 900 });
const working = (out) => out.items.filter((i) => i.layer === 'working');
const ref = (w, o) => `p${w.perceptOf(o).id}`;

/** 前一晚的私聊 + 第二天早上群里的一来一回。返回各条消息。 */
async function morning(w, { groupAddressed = AMBIENT } = {}) {
  const ache = w.say('oneOnOne', 'principal', '我头有点疼，先睡了', TO_HER);
  w.say('oneOnOne', 'her', '快去睡，明天还疼的话跟我说');
  await w.flush();
  bind(w, 'dm', 'oneOnOne');
  // 这一轮照常回想一次：候选缓存里留下昨晚这一刻算好的那一份
  await recallAt(w, 'oneOnOne', ache, { sessionId: 'dm' });
  w.clock.advance(9 * 60 * MINUTE);
  w.say('groupY', 'her', '头还疼吗');
  const better = w.say('groupY', 'principal', '好多了，已经不疼了', groupAddressed);
  w.say('groupY', 'her', '那就好，早饭吃了没');
  const bread = w.say('groupY', 'principal', '还没吃，到公司吃点面包', groupAddressed);
  await w.flush();
  await w.core.mods.discretion.glancesIdle(w.core);
  w.clock.advance(20 * MINUTE);
  return { ache, better, bread };
}

test('私聊里她自己开口：他早上在群里答过的话在她心里（工作记忆），知道是在哪儿说的、比他在这里说过的都晚', async () => {
  const w = await world('st-dm');
  try {
    const m = await morning(w);
    const out = await selfTurn(w, 'oneOnOne', 'dm');
    const wm = working(out);
    const ids = wm.map((i) => i.id);
    assert.ok(ids.includes(ref(w, m.better)), `他在群里说的「好多了」在心里 ${show(out.items)}`);
    assert.ok(ids.includes(ref(w, m.bread)), `「还没吃」也在 ${show(out.items)}`);
    const text = wm.map((i) => i.rendered).join('\n');
    assert.match(text, /群Y/, text);
    assert.match(text, /比他在这里跟你说过的都晚/, text);
    assert.ok(metric(w.core, 'wm.selfTurn') >= 1);
    // 没有记成触发者：这一轮没有「被回答的人」
    const info = w.core.mods.context.sessionInfo(w.core, 'dm');
    assert.deepEqual(info.triggerEntityIds, []);
    assert.equal(info.selfTurn, true);
  } finally { await w.close(); }
});

test('私聊里她自己开口：回想不沿用昨晚那一刻算好的候选——他算在场，别处的近况进候选；哪儿都没有新的事才不重新回想', async () => {
  // 工作记忆关掉，单看回想这一路
  const w = await world('st-cache', { recall: { working: { enabled: false } } });
  try {
    const m = await morning(w);
    const key = w.keyOf('oneOnOne');
    const hit0 = metric(w.core, 'retrieve.cache.hit');
    const set = await w.core.mods.retrieve.recall(w.core, { settingKey: key, sessionId: 'dm', trigger: 'idle' }, { mode: 'involuntary', deadlineMs: 3000 });
    assert.equal(metric(w.core, 'retrieve.cache.hit'), hit0, '昨晚的缓存不再沿用');
    const him = w.perceptOf(m.better).actor_entity_id;
    assert.ok(set.cues.present.includes(him), '一对一的对方算在场，不靠最近 30 分钟说过话');
    assert.ok(set.items.some((c) => c.ref === ref(w, m.better)), `他早上在群里说的进了候选 ${JSON.stringify(set.items.map((c) => c.ref))}`);
    // 哪儿都没有新消息的又一次唤醒：不重新回想
    const again = await w.core.mods.retrieve.recall(w.core, { settingKey: key, sessionId: 'dm', trigger: 'idle' }, { mode: 'involuntary', deadlineMs: 3000 });
    assert.ok(metric(w.core, 'retrieve.cache.hit') > hit0 || again.items.length === 0, '没有新的事：沿用刚算好的或者不回想');
    // 别处又来了一句：再唤醒就重新回想
    const later = w.say('groupY', 'principal', '面包吃完了，开始干活', AMBIENT);
    await w.flush();
    const third = await w.core.mods.retrieve.recall(w.core, { settingKey: key, sessionId: 'dm', trigger: 'idle' }, { mode: 'involuntary', deadlineMs: 3000 });
    assert.ok(third.items.some((c) => c.ref === ref(w, later)), '别处的新消息进了候选');
  } finally { await w.close(); }
});

test('候选缓存有新鲜度：这个场合一直没有新消息，过了 recall.prefetchTtlMin 的那一份不再沿用（定时提醒开启的轮也一样）', async () => {
  const w = await world('st-ttl');
  try {
    const first = w.say('oneOnOne', 'principal', '周末想去爬山', TO_HER);
    await w.flush();
    const key = w.keyOf('oneOnOne');
    const opt = { mode: 'involuntary', deadlineMs: 3000 };
    const s = { settingKey: key, focusPerceptId: w.perceptOf(first).id, trigger: 'reminder' };
    await w.core.mods.retrieve.recall(w.core, s, opt);
    const hit0 = metric(w.core, 'retrieve.cache.hit');
    await w.core.mods.retrieve.recall(w.core, s, opt);
    assert.equal(metric(w.core, 'retrieve.cache.hit'), hit0 + 1, '刚算好的：沿用');
    w.clock.advance((w.core.config.get().recall.prefetchTtlMin + 1) * MINUTE);
    await w.core.mods.retrieve.recall(w.core, s, opt);
    assert.equal(metric(w.core, 'retrieve.cache.hit'), hit0 + 1, '放久了的：重新回想');
    assert.equal(w.core.mods.retrieve.cached(w.core, key) != null, true, '重新算好的那一份又是新鲜的');
  } finally { await w.close(); }
});

test('群里她自己开口：最近在别处来往过、又在这里的人（半小时没开口也算），他私下说的话在她心里（带「你们俩私聊时」）；不在这里的人的不进来；原样转述出去照旧被外发守护挡下', async () => {
  const w = await world('st-group');
  try {
    // 朋友私下说的：他不是这个群的人（从没在这里说过话）
    const moving = w.say('friendDm', 'friend', '我下个月要搬家了，先别跟别人说', TO_HER);
    w.say('friendDm', 'her', '好，我不说');
    // 他几个小时前在群里说过话：成员列不全的群里看不到他「最近在这里」，但他是这里的人
    w.say('groupY', 'principal', '中午吃什么好', AMBIENT);
    await w.flush();
    w.clock.advance(3 * 60 * MINUTE);
    const leave = w.say('oneOnOne', 'principal', '我今天请假了，在家休息', TO_HER);
    w.say('oneOnOne', 'her', '那你好好歇着');
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    w.clock.advance(10 * MINUTE);
    bind(w, 'g', 'groupY');
    // 这一轮带着污点（她读过转来的内容）：守护对一对一里别人的原话一律把关（平常话在没有污点的轮里本来就不拦）
    w.pm.sessions.markTurnTaint('g', { tainted: true, reason: 'read:wait_for_messages' });
    const out = await selfTurn(w, 'groupY', 'g');
    const wm = working(out);
    const ids = wm.map((i) => i.id);
    assert.ok(ids.includes(ref(w, leave)), `他私下说的在心里 ${show(out.items)}`);
    assert.match(wm.map((i) => i.rendered).join('\n'), /你们俩私聊时/);
    assert.ok(!out.items.some((i) => i.id === ref(w, moving)), `不在这里的人私下说的不进来 ${show(out.items)}`);
    // 她把他私下的原话原样说到群里：这一轮没有被回答的人，守护照旧挡下这一句
    w.pm.sessions.injected({ sessionId: 'g', nonce: 'n1', layer: 'block', mode: 'live', chars: 10,
      items: out.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })) });
    w.pm.sessions.confirm('g', 'n1');
    const a = await w.pm.expression.appraise({
      channel: { targetSettingId: w.fp.settings.groupY.id, persistence: 'once' }, text: ['他跟我说：我今天请假了，在家休息'],
      origin: { path: 'tool', sessionId: 'g', homeSettingId: w.fp.settings.groupY.id },
    });
    const reasons = JSON.parse(w.core.store.get('SELECT reasons_json FROM utterances WHERE token = ?', a.token).reasons_json);
    assert.equal(a.verdict, 'reconsider', JSON.stringify(reasons));
    assert.ok(reasons.includes('guard:relay'), JSON.stringify(reasons));
  } finally { await w.close(); }
});

test('群里她自己开口：听众里没有她最近在别处来往过的人——没有工作记忆，也不出错', async () => {
  const w = await world('st-none');
  try {
    w.say('oneOnOne', 'principal', '我今天请假了，在家休息', TO_HER);
    w.say('oneOnOne', 'her', '那你好好歇着');
    w.say('groupY', 'other', '有人在吗', AMBIENT);
    await w.flush();
    w.clock.advance(5 * MINUTE);
    bind(w, 'g', 'groupY');
    const out = await selfTurn(w, 'groupY', 'g');
    assert.equal(working(out).length, 0, show(out.items));
    assert.equal(metric(w.core, 'context.recall.fault'), 0);
  } finally { await w.close(); }
});

test('有人问她的一轮不受影响：触发者照旧是说话的那个人', async () => {
  const w = await world('st-msg');
  try {
    const m = await morning(w, { groupAddressed: TO_HER });
    const ask = w.say('oneOnOne', 'principal', '在吗', TO_HER);
    await w.flush();
    const out = await recallAt(w, 'oneOnOne', ask, { sessionId: 'dm' });
    assert.ok(working(out).map((i) => i.id).includes(ref(w, m.better)), show(out.items));
    const info = w.core.mods.context.sessionInfo(w.core, 'dm');
    assert.equal(info.selfTurn, false);
    assert.equal(info.triggerEntityIds.length, 1);
  } finally { await w.close(); }
});
