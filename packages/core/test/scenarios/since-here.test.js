// 「这之后他的事」（D164，用户反馈第 38 轮，实测问题 #69）。回放的是一次实测（内容全是编的）：
//   傍晚他在群 A 说今晚六点抢演出票；过了二十分钟她在和他的私聊里说了一句；六点他在群 A 说抢到了，她当场回了他，提炼记下「抢到了周六的票」、
//   那条计划标成做完了；之后他在群 B 跟她闲聊了二十多句；她在私聊里主动开口——修之前这一轮她心里全是群 B 的闲聊，抢票那件事一行没进，
//   她就问「六点那波抢票，到手了没」。
// 真模块 + 替身端口 + 假平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, platformSeeds, FakeLLM, MINUTE, glancer, discreetJudge } from './presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
const metric = (core, name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
const TO_HER = { addressed: 'to-her', attention: 'attended' };
const AMBIENT = { addressed: 'ambient', attention: 'peripheral' };

/** 加一个群（「群B」：成员列不全、四十人）。 */
function addGroup(w, name, label) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`sh-${SEED}`, 'setting', name);
  Object.assign(d, { id, label });
  d.audience = { ...d.audience, size: 40, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' };
  d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
  d.capabilities = { preSendGate: true, canHold: false };
  w.fp.settings[name] = { id, descriptor: d };
  w.fp.sink.describe(structuredClone(d));
}
async function world(name, { config = {}, appraise = () => [] } = {}) {
  const w = await openWorld({ seed: SEED, name, config: { ...LIVE, ...config }, llm: new FakeLLM({ fallback: { appraise, glance: glancer() } }), friendDm: true });
  addGroup(w, 'groupB', '群B');
  await w.flush();
  return w;
}
const bind = (w, sid, where) => w.pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings[where].id, adapterId: w.fp.namespace, confidence: 'specific' });
const selfTurn = (w, where, sid) => w.pm.recall({ settingId: w.fp.settings[where].id, trigger: 'idle', ...(sid ? { sessionId: sid } : {}) },
  { mode: 'involuntary', deadlineMs: 3000, budgetChars: 900 });
const layer = (out, l = 'sinceHere') => out.items.filter((i) => i.layer === l);

/** 一条关于 subject 的事实（来源是那句话；和提炼写进来的一样经 encode.writeAssertion）。 */
function fact(w, o, { subject, text, imp = 5, plan = null, mode = 'told_to_her' }) {
  const p = w.perceptOf(o);
  return w.core.mods.encode.writeAssertion(w.core, {
    subjects: [subject], predicate: plan ? '计划' : '近况', value: null, text, kindHint: plan ? 'plan' : 'event', certainty: 'stated', confidence: 0.9, imp,
    ...(plan ? { plan: { agent: subject, status: 'planned' } } : {}),
    sources: [{ perceptId: p.id, speaker: p.actor_entity_id, asserter: p.actor_entity_id, mode, hop: 0, confidence: 0.9, at: p.at }], norm: {}, w: 1,
  });
}
/** 群 B 里他和她闲聊 n 来回。 */
async function chatter(w, n) {
  for (let i = 0; i < n; i++) {
    w.say('groupB', 'principal', `夜宵吃什么好呢${i}`, TO_HER, 30_000);
    w.say('groupB', 'her', `白饭配咸菜${i}`, {}, 30_000);
  }
  await w.flush();
}

/** 实测的时间线（内容是编的）。返回各条和事实的 id。 */
async function evening(w, { chat = 11 } = {}) {
  const him = () => w.perceptOf(ann).actor_entity_id;
  // 下午他们在私聊里聊过几句（一对一的成员名单列不全时，她要对着说的人靠他在这里说过话认出来，D132）
  w.say('oneOnOne', 'principal', '下午好困', TO_HER);
  w.say('oneOnOne', 'her', '喝杯咖啡');
  w.clock.advance(30 * MINUTE);
  const ann = w.say('smallGroup', 'principal', '今晚六点抢演出票，祝我好运', TO_HER);
  w.say('smallGroup', 'her', '冲呀');
  await w.flush();
  const P = him();
  const planId = fact(w, ann, { subject: P, text: '主人今晚六点抢演出票', imp: 5, plan: true });
  w.clock.advance(20 * MINUTE);
  const dmSaid = w.say('oneOnOne', 'her', '抢票前正好看看这个视频');
  await w.flush();
  w.clock.advance(44 * MINUTE);
  const got = w.say('smallGroup', 'principal', '抢到周六的了', TO_HER);
  w.say('smallGroup', 'her', '太好了！');
  await w.flush();
  w.clock.advance(2 * MINUTE);
  const outId = fact(w, got, { subject: P, text: '主人抢到了周六的票', imp: 6 });
  w.core.mods.encode.transitionPlan(w.core, planId, 'done', { at: w.clock.now(), evidencePerceptId: w.perceptOf(got).id, outcomeRef: `a${outId}` });
  w.clock.advance(14 * MINUTE);
  await chatter(w, chat);
  // 群 B 闲聊里记下的两件小事（重要度低）
  const snack = w.say('groupB', 'principal', '我决定吃泡面了', TO_HER);
  w.say('groupB', 'her', '好吧');
  await w.flush();
  const snackId = fact(w, snack, { subject: P, text: '主人今晚夜宵吃泡面', imp: 2 });
  await w.core.mods.discretion.glancesIdle(w.core);
  w.clock.advance(2 * MINUTE);
  return { P, planId, outId, snackId, ann, got, dmSaid };
}

test('私聊里她自己开口：群 B 聊了二十多句以后，「抢到票了」那件事照样在「这之后他的事」里——计划做完了和它的结果成一组，一行说清有结果了', async () => {
  const w = await world('sh-self');
  try {
    const e = await evening(w);
    bind(w, 'dm', 'oneOnOne');
    const out = await selfTurn(w, 'oneOnOne', 'dm');
    const sh = layer(out);
    const ids = sh.map((i) => i.id);
    // 回归点：它确定地在「这之后他的事」这一层，不靠普通回想碰运气（没有这一层时下面第二条断言不成立，见下一个测试）
    assert.ok(out.items.some((i) => i.id === `a${e.outId}`), `「抢到了周六的票」在她心里 ${show(out.items)}`);
    assert.deepEqual(ids.slice(0, 2), [`a${e.planId}`, `a${e.outId}`], `有结果的计划排最前、结果紧跟着 ${show(sh)}`);
    const [planLine, outLine] = sh;
    assert.match(planLine.rendered, /抢演出票/);
    assert.match(planLine.rendered, /后来做完了/, '计划的状态沿用 render 的说法');
    assert.match(outLine.rendered, /^结果：/);
    assert.match(outLine.rendered, /抢到了周六的票/);
    assert.ok(ids.includes(`a${e.snackId}`), '群 B 的小事也在（重要度低，排在后面）');
    assert.ok(ids.indexOf(`a${e.snackId}`) > ids.indexOf(`a${e.outId}`));
    // 同一条不在两层出现
    assert.equal(out.items.filter((i) => i.id === `a${e.outId}`).length, 1);
    assert.ok(metric(w.core, 'context.sinceHere.turns') >= 1);
    assert.ok(metric(w.core, 'context.sinceHere.items') >= 3);
  } finally { await w.close(); }
});

test('关掉这一层（context.sinceHere.enabled = false，修之前的样子）：这一层是空的，别的层照旧；上一个测试的这一层断言在这时不成立', async () => {
  // 说明：这个小世界里普通回想一共只有几条候选，「抢到了」照样会被普通回想想起来；实测里它是被群 B 二十多句闲聊挤掉的（抽样、名额），
  // 这里不去模拟那种挤法——回归点是「它确定地在这一层」，不靠普通回想碰运气
  const w = await world('sh-off', { config: { context: { sinceHere: { enabled: false } } } });
  try {
    await evening(w);
    const out = await selfTurn(w, 'oneOnOne');
    assert.equal(layer(out).length, 0, show(out.items));
    assert.ok(layer(out, 'working').length > 0, '工作记忆照旧');
  } finally { await w.close(); }
});

test('计划和结果只占一个名额：maxItems = 1 时那一组整组都在，别的不在', async () => {
  const w = await world('sh-one', { config: { context: { sinceHere: { maxItems: 1 } } } });
  try {
    const e = await evening(w);
    const out = await selfTurn(w, 'oneOnOne');
    assert.deepEqual(layer(out).map((i) => i.id), [`a${e.planId}`, `a${e.outId}`], show(out.items));
  } finally { await w.close(); }
});

test('since 之前就知道的事、他就在这个场合说的事，不在这一层', async () => {
  const w = await world('sh-before');
  try {
    // 她在私聊开口之前就知道的：他在群 A 说在学吉他
    const g = w.say('smallGroup', 'principal', '最近在学吉他', TO_HER);
    await w.flush();
    const P = w.perceptOf(g).actor_entity_id;
    const guitar = fact(w, g, { subject: P, text: '主人在学吉他', imp: 7 });
    w.clock.advance(5 * MINUTE);
    const e = await evening(w, { chat: 2 });
    // 他在私聊里说的（她还没回）：来源全在这里
    const phone = w.say('oneOnOne', 'principal', '我换了新手机', TO_HER);
    await w.flush();
    const phoneId = fact(w, phone, { subject: P, text: '主人换了新手机', imp: 8 });
    w.clock.advance(MINUTE);
    const out = await selfTurn(w, 'oneOnOne');
    const ids = layer(out).map((i) => i.id);
    assert.ok(ids.includes(`a${e.outId}`), show(out.items));
    assert.ok(!ids.includes(`a${guitar}`), 'since 之前就知道的不在');
    assert.ok(!ids.includes(`a${phoneId}`), '他就在这里说的不在');
  } finally { await w.close(); }
});

test('有人对她说话的轮：他隔了一阵回到这里说「在吗」，这一层有东西；她回了以后他紧接着再说一句，这一层是空的；他连发两句她还没回，照样按上一次说完话算', async () => {
  const w = await world('sh-msg');
  try {
    const e = await evening(w, { chat: 2 });
    bind(w, 'dm', 'oneOnOne');
    const hi = w.say('oneOnOne', 'principal', '在吗', TO_HER);
    await w.flush();
    let out = await recallAt(w, 'oneOnOne', hi, { sessionId: 'dm' });
    assert.ok(layer(out).some((i) => i.id === `a${e.outId}`), `隔了一阵回来：有这之后的事 ${show(out.items)}`);
    // 连发第二句（她还没回）：「眼前还没回的这一串」不算，since 照旧是她下午那一句（换一个会话看，免得本周期已给过）
    const hi2 = w.say('oneOnOne', 'principal', '人呢', TO_HER);
    await w.flush();
    bind(w, 'dm2', 'oneOnOne');
    out = await recallAt(w, 'oneOnOne', hi2, { sessionId: 'dm2' });
    assert.ok(layer(out).some((i) => i.id === `a${e.outId}`), `连发两句：照样有 ${show(out.items)}`);
    // 她回了，他紧接着又说一句：since 推到刚才，这一层空了
    w.say('oneOnOne', 'her', '在的在的');
    const next = w.say('oneOnOne', 'principal', '跟你说个事', TO_HER);
    await w.flush();
    bind(w, 'dm3', 'oneOnOne');
    out = await recallAt(w, 'oneOnOne', next, { sessionId: 'dm3' });
    assert.deepEqual(layer(out), [], show(out.items));
  } finally { await w.close(); }
});

test('本周期给过的第二轮不再给', async () => {
  const w = await world('sh-sent');
  try {
    const e = await evening(w, { chat: 2 });
    bind(w, 'dm', 'oneOnOne');
    const first = await selfTurn(w, 'oneOnOne', 'dm');
    assert.ok(layer(first).length >= 2, show(first.items));
    w.pm.sessions.injected({ sessionId: 'dm', nonce: 'n1', layer: 'block', mode: 'live', chars: 10,
      items: first.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })) });
    w.pm.sessions.confirm('dm', 'n1');
    w.clock.advance(5 * MINUTE);
    const again = await selfTurn(w, 'oneOnOne', 'dm');
    const ids = layer(again).map((i) => i.id);
    for (const r of [`a${e.planId}`, `a${e.outId}`, `a${e.snackId}`]) assert.ok(!ids.includes(r), `${r} 给过了 ${show(again.items)}`);
    assert.ok(!again.items.some((i) => i.id === `a${e.outId}`), '别的层也不再给');
  } finally { await w.close(); }
});

test('他们从没在这里说过话：没有这一层', async () => {
  const w = await world('sh-never');
  try {
    // 朋友在群 A 说了自己的事；她和朋友的私聊里谁都没说过话
    const f = w.say('smallGroup', 'friend', '我下周去海边玩', TO_HER);
    w.say('smallGroup', 'her', '真好');
    await w.flush();
    fact(w, f, { subject: w.perceptOf(f).actor_entity_id, text: '朋友下周去海边', imp: 6 });
    w.clock.advance(10 * MINUTE);
    const out = await selfTurn(w, 'friendDm');
    assert.deepEqual(layer(out), [], show(out.items));
  } finally { await w.close(); }
});

test('关口①照常过：朋友在一对一私下说的关于主人的事，在群里不出现在这一层；主人私下说的自己的事，在有别人的群里照现有底线（不放宽）', async () => {
  const seen = [];
  const w = await world('sh-gate', { appraise: discreetJudge(seen) });
  try {
    // 群 A 里她回过主人：这里有「上次」
    const a = w.say('smallGroup', 'principal', '大家晚上好', TO_HER);
    w.say('smallGroup', 'her', '晚上好');
    await w.flush();
    const P = w.perceptOf(a).actor_entity_id;
    w.clock.advance(10 * MINUTE);
    // 朋友私下说主人的事
    const tip = w.say('friendDm', 'friend', '主人下个月要换工作了', TO_HER);
    w.say('friendDm', 'her', '这样啊');
    // 主人私下说自己的事
    const own = w.say('oneOnOne', 'principal', '我体检血糖有点高', TO_HER);
    w.say('oneOnOne', 'her', '少吃点甜的');
    // 主人在群 B 说的（大家都看得到）
    const pub = w.say('groupB', 'principal', '我周末去爬山', TO_HER);
    w.say('groupB', 'her', '注意安全');
    await w.flush();
    // 第一眼先看过（提炼也是在看过以后才写事实的）：事实的规范从来源继承
    await w.core.mods.discretion.glancesIdle(w.core);
    const tipId = fact(w, tip, { subject: P, text: '主人下个月要换工作', imp: 8, mode: 'told_to_her' });
    const ownId = fact(w, own, { subject: P, text: '主人体检血糖有点高', imp: 8 });
    const pubId = fact(w, pub, { subject: P, text: '主人周末去爬山', imp: 4 });
    w.clock.advance(10 * MINUTE);
    const out = await selfTurn(w, 'smallGroup');
    const sh = layer(out);
    const text = sh.map((i) => i.rendered).join('\n');
    // 这几件都挑进了这一层的候选、交给了关口①（不是没挑到才不出现）：判定记录里有它们在这个群的结论
    const key = w.keyOf('smallGroup');
    const verdictOf = (id) => w.core.store.get(`SELECT verdict FROM appraisals WHERE memory_kind = 'assertion' AND memory_id = ? AND setting_key = ?
                                                ORDER BY id DESC LIMIT 1`, id, key)?.verdict ?? null;
    for (const id of [tipId, ownId]) assert.ok(verdictOf(id) != null, `a${id} 交给了关口①`);
    assert.ok(verdictOf(pubId) != null, '他在群 B 说的也交给了关口①');
    assert.ok(!sh.some((i) => i.id === `a${tipId}` && i.verdict === 'share'), `朋友私下说的不能原样在群里 ${show(sh)}`);
    assert.doesNotMatch(text, /换工作/);
    assert.notEqual(verdictOf(tipId), 'share');
    assert.ok(!sh.some((i) => i.id === `a${ownId}` && i.verdict === 'share'), `主人私下说的在群里不放宽 ${show(sh)}`);
    assert.doesNotMatch(text, /血糖/);
    assert.notEqual(verdictOf(ownId), 'share');
  } finally { await w.close(); }
});

test('计划这个周期给过（还是「打算」），后来做完了、又没有单独的结果事实：再给一次，带新的状态；新状态给过以后不再给', async () => {
  const w = await world('sh-regive');
  try {
    w.say('oneOnOne', 'principal', '下午好困', TO_HER);
    w.say('oneOnOne', 'her', '喝杯咖啡');
    await w.flush();
    w.clock.advance(10 * MINUTE);
    const ann = w.say('smallGroup', 'principal', '今晚六点抢演出票', TO_HER);
    w.say('smallGroup', 'her', '冲呀');
    await w.flush();
    const P = w.perceptOf(ann).actor_entity_id;
    const planId = fact(w, ann, { subject: P, text: '主人今晚六点抢演出票', imp: 5, plan: true });
    w.clock.advance(5 * MINUTE);
    bind(w, 'dm', 'oneOnOne');
    const give = (out, nonce) => {
      w.pm.sessions.injected({ sessionId: 'dm', nonce, layer: 'block', mode: 'live', chars: 10,
        items: out.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })) });
      w.pm.sessions.confirm('dm', nonce);
    };
    const first = await selfTurn(w, 'oneOnOne', 'dm');
    const p1 = layer(first).find((i) => i.id === `a${planId}`);
    assert.ok(p1, `计划先作为这之后知道的事给了 ${show(first.items)}`);
    assert.doesNotMatch(p1.rendered, /后来做完了/);
    give(first, 'n1');
    w.clock.advance(60 * MINUTE);
    // 做完了，没有单独的结果事实（提炼只把计划标成 done）
    const got = w.say('smallGroup', 'principal', '抢到了', TO_HER);
    w.say('smallGroup', 'her', '太好了');
    await w.flush();
    w.core.mods.encode.transitionPlan(w.core, planId, 'done', { at: w.clock.now(), evidencePerceptId: w.perceptOf(got).id });
    w.clock.advance(10 * MINUTE);
    const second = await selfTurn(w, 'oneOnOne', 'dm');
    const p2 = layer(second).find((i) => i.id === `a${planId}`);
    assert.ok(p2, `状态变了：再给一次 ${show(second.items)}`);
    assert.match(p2.rendered, /后来做完了/);
    give(second, 'n2');
    w.clock.advance(10 * MINUTE);
    const third = await selfTurn(w, 'oneOnOne', 'dm');
    assert.ok(!third.items.some((i) => i.id === `a${planId}`), `新状态给过了：不再给 ${show(third.items)}`);
  } finally { await w.close(); }
});

test('这一层字数装不下的条目不丢：照样能经普通回想给出来', async () => {
  // 这一层只放得下一行：计划那一行进来，结果和泡面那件装不下
  const w = await world('sh-cap', { config: { context: { sinceHere: { chars: 100 } } } });
  try {
    const e = await evening(w, { chat: 2 });
    const out = await selfTurn(w, 'oneOnOne');
    const sh = layer(out).map((i) => i.id);
    assert.deepEqual(sh, [`a${e.planId}`], show(out.items));
    for (const id of [e.outId, e.snackId]) {
      const it = out.items.find((i) => i.id === `a${id}`);
      assert.ok(it && it.layer !== 'sinceHere', `a${id} 经普通回想给出来了 ${show(out.items)}`);
    }
  } finally { await w.close(); }
});
