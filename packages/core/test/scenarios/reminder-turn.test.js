// 定时提醒到点开启的一轮（D144）：和空闲唤醒是同一类——没有人在问她，是她自己要开口。
// 修之前核心把「这里最后一个对她说话的人」（常常是几个小时前的一句）当成这一轮的触发者：工作记忆围着他转，
// 外发守护把他当成「被回答的人」，对他的叮嘱和私下说的话就放过了。内容都是编的。
// 真模块 + 替身端口 + 假平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, platformSeeds, FakeLLM, MINUTE, glancer } from './presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
const TO_HER = { addressed: 'to-her', attention: 'attended' };
const AMBIENT = { addressed: 'ambient', attention: 'peripheral' };
// 适配器把定时提醒映射成挂在她名下的一条「提醒」（网页适配器就是这样）
const REMINDER = { kind: 'reminder', addressed: 'to-her', attention: 'attended', evidential: false, standing: 'platform' };

function addGroup(w) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`rt-${SEED}`, 'setting', 'groupY');
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
/** 定时提醒到点开启的一轮。focus：宿主交进来的焦点（提醒那一条）；不给 = 适配器没把提醒映射成感知。 */
const reminderTurn = (w, where, sid, focus = null) => w.pm.recall(
  { settingId: w.fp.settings[where].id, trigger: 'reminder', sessionId: sid, ...(focus ? { focusObsId: focus.id } : {}) },
  { mode: 'involuntary', deadlineMs: 3000, budgetChars: 900 });
const working = (out) => out.items.filter((i) => i.layer === 'working');
const ref = (w, o) => `p${w.perceptOf(o).id}`;
const entityOf = (w, o) => w.perceptOf(o).actor_entity_id;
/** 一条正在时间窗里的意图（到点了），对象是 target。 */
function dueIntention(w, target, text) {
  const at = w.clock.now();
  return Number(w.core.store.run(`INSERT INTO intentions(target_entity_id, act, text, origin, trigger_json, state, formed_at, window_start, window_end, created_at, updated_at)
    VALUES (?, '提醒', ?, 'self-commitment', '{}', 'formed', ?, ?, ?, ?, ?)`, target, text, at - 3 * 60 * MINUTE, at - MINUTE, at + 2 * 60 * MINUTE, at, at).lastInsertRowid);
}

test('提醒在私聊里到点：工作记忆围着这个私聊的对方（他在别处和她最近的来往），不围着几个小时前在群里对她说话的人；没有触发者', async () => {
  const w = await world('rt-dm');
  try {
    // 甲几个小时前在群里对她说过话
    const jia = w.say('groupY', 'other', '周末有人一起去看展吗', TO_HER);
    w.say('groupY', 'her', '我可能会去');
    await w.flush();
    w.clock.advance(3 * 60 * MINUTE);
    // 乙在群里和她说了几句，又在私聊里托她到点提醒
    const late = w.say('groupY', 'principal', '今晚要加班，可能很晚才到家', TO_HER);
    w.say('groupY', 'her', '辛苦了，记得吃饭');
    w.say('oneOnOne', 'principal', '八点提醒我给阿猫喂药', TO_HER);
    w.say('oneOnOne', 'her', '好，到点叫你');
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    w.clock.advance(60 * MINUTE);
    const remind = w.say('oneOnOne', 'her', '提醒：给阿猫喂药', REMINDER);
    await w.flush();
    bind(w, 'dm', 'oneOnOne');
    const out = await reminderTurn(w, 'oneOnOne', 'dm', remind);
    const ids = working(out).map((i) => i.id);
    assert.ok(ids.includes(ref(w, late)), `他在群里说的「加班」在心里 ${show(out.items)}`);
    assert.ok(!out.items.some((i) => i.id === ref(w, jia)), `甲的话不进来 ${show(out.items)}`);
    const info = w.core.mods.context.sessionInfo(w.core, 'dm');
    assert.deepEqual(info.triggerEntityIds, []);
    assert.equal(info.selfTurn, true);
    // 适配器没把提醒映射成感知（焦点交不进来）：也不退回最后一个对她说话的人（这里是托她提醒的那一句）
    await reminderTurn(w, 'oneOnOne', 'dm');
    const info2 = w.core.mods.context.sessionInfo(w.core, 'dm');
    assert.deepEqual(info2.triggerEntityIds, []);
    assert.equal(info2.selfTurn, true);
  } finally { await w.close(); }
});

/** 群里：朋友托她到点提醒；主人最近在私聊里和她来往过；甲是群里最后一个对她说话的人（几个小时前）。 */
async function groupSetup(w) {
  const friendHere = w.say('groupY', 'friend', '大家晚上好', AMBIENT);
  w.say('groupY', 'principal', '中午吃什么好', AMBIENT);
  const jia = w.say('groupY', 'other', '有人知道附近哪里修车吗', TO_HER);
  w.say('groupY', 'her', '东门那边有一家');
  await w.flush();
  w.clock.advance(2 * 60 * MINUTE);
  const parcel = w.say('friendDm', 'friend', '明晚八点提醒我去驿站取快递，我老忘', TO_HER);
  w.say('friendDm', 'her', '好，到点叫你');
  const leave = w.say('oneOnOne', 'principal', '我今天请假了，在家休息', TO_HER);
  w.say('oneOnOne', 'her', '那你好好歇着');
  await w.flush();
  await w.core.mods.discretion.glancesIdle(w.core);
  w.clock.advance(30 * MINUTE);
  bind(w, 'g', 'groupY');
  return { friend: entityOf(w, friendHere), jia, parcel, leave };
}

test('提醒在群里到点、对得上对象（到点的意图）而且他在这个群：他排在「她要对谁说」的最前面', async () => {
  const w = await world('rt-group', { recall: { working: { maxTriggers: 1 } } });
  try {
    const m = await groupSetup(w);
    dueIntention(w, m.friend, '提醒他去驿站取快递');
    const out = await reminderTurn(w, 'groupY', 'g');
    const ids = working(out).map((i) => i.id);
    assert.ok(ids.includes(ref(w, m.parcel)), `托她提醒的那个人和她的来往在心里 ${show(out.items)}`);
    assert.ok(!ids.includes(ref(w, m.leave)), `只能装一个人时，提醒的对象在前 ${show(out.items)}`);
    assert.ok(!ids.includes(ref(w, m.jia)), show(out.items));
    const info = w.core.mods.context.sessionInfo(w.core, 'g');
    assert.deepEqual(info.triggerEntityIds, []);
    assert.equal(info.selfTurn, true);
  } finally { await w.close(); }
});

test('提醒在群里到点、对不上对象（没有到点的意图，或者对象不在这个群）：照 D132 取她最近在别处来往过、又在这里的人', async () => {
  const w = await world('rt-group-none', { recall: { working: { maxTriggers: 1 } } });
  try {
    const m = await groupSetup(w);
    // 对象从没在这个群出现过：不算在这里
    const s = w.say('smallGroup', 'stranger', '在吗', AMBIENT);
    await w.flush();
    dueIntention(w, entityOf(w, s), '提醒他回电话');
    const out = await reminderTurn(w, 'groupY', 'g');
    const ids = working(out).map((i) => i.id);
    assert.ok(ids.includes(ref(w, m.leave)), `最近来往过的主人在心里 ${show(out.items)}`);
    assert.ok(!ids.includes(ref(w, m.parcel)), show(out.items));
    assert.deepEqual(w.core.mods.context.sessionInfo(w.core, 'g').triggerEntityIds, []);
  } finally { await w.close(); }
});

test('提醒开启的一轮里，她把「最后一个对她说话的人」私下说的原话几乎原样说到群里：照旧被外发守护挡下（他不是被回答的人）', async () => {
  const w = await world('rt-egress');
  try {
    // 他是群里最后一个对她说话的人（几个小时前）
    w.say('groupY', 'principal', '中午吃什么好', TO_HER);
    w.say('groupY', 'her', '楼下的面馆吧');
    await w.flush();
    w.clock.advance(3 * 60 * MINUTE);
    const leave = w.say('oneOnOne', 'principal', '我今天请假了，在家休息', TO_HER);
    w.say('oneOnOne', 'her', '那你好好歇着');
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    w.clock.advance(10 * MINUTE);
    bind(w, 'g', 'groupY');
    // 这一轮带着污点：守护对一对一里别人的原话一律把关（平常话在没有污点的轮里本来就不拦）
    w.pm.sessions.markTurnTaint('g', { tainted: true, reason: 'read:wait_for_messages' });
    const out = await reminderTurn(w, 'groupY', 'g');
    assert.ok(working(out).map((i) => i.id).includes(ref(w, leave)), `他私下说的在心里 ${show(out.items)}`);
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
