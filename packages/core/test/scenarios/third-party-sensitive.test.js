// 第三方敏感私事的底线（D135）：不随提炼完成而消失，也覆盖原文窗口和情节。
// 形状（内容是编的）：朋友在一对一里跟她说了一句很私的事（第一眼判成高敏感，没有叮嘱）；提炼完成后规范的敏感度很低。
// 修之前：有了规范以后「给第三方的敏感私事不进上下文」只看规范，这句话就进了群的上下文；含这句话的原文窗口、情节从不触发；
// 外发守护的「转述」只认单条感知，她把原文窗口里那句原话几乎原样说到群里也挡不下。
// 敏感度事实 = 规范的和来源原话第一眼的取大。他自己问起、平常的话照旧。
// 真模块 + 替身端口 + 假平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, platformSeeds, FakeLLM, glancer } from './presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const TO_HER = { addressed: 'to-her', attention: 'attended' };
const ASK = { addressed: 'mentions-her', attention: 'attended' };
const metric = (core, name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;

const SECRET = '我欠了网贷八万多，最近天天被催债';
const PLAIN = '我周末去爬山了，山顶风景不错';

function addGroup(w) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`tps-${SEED}`, 'setting', 'groupY');
  Object.assign(d, { id, label: '群Y' });
  d.audience = { ...d.audience, size: 40, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' };
  d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
  d.capabilities = { preSendGate: true, canHold: false };
  w.fp.settings.groupY = { id, descriptor: d };
  w.fp.sink.describe(structuredClone(d));
}

/** 朋友私下说的两句（一句很私、一句平常），第一眼看过；再按「提炼完成」写下很低的规范，切出原文窗口、写一条归了它的情节。 */
async function world(name) {
  const w = await openWorld({ seed: SEED, name, config: LIVE, llm: new FakeLLM({ fallback: { appraise: () => [], glance: glancer() } }), friendDm: true });
  addGroup(w);
  await w.flush();
  const { core } = w;
  const D = core.mods.discretion;
  const s = w.say('friendDm', 'friend', SECRET, TO_HER);
  w.say('friendDm', 'her', '别太着急，慢慢想办法');
  const p = w.say('friendDm', 'friend', PLAIN, TO_HER);
  await w.flush();
  await D.glancesIdle(core);
  const secret = w.perceptOf(s);
  const plain = w.perceptOf(p);
  const friend = secret.actor_entity_id;
  assert.ok(D.glancesOf(core, [secret.id]).get(secret.id)?.sens >= 0.7, '第一眼判成高敏感');
  // 提炼完成：规范的敏感度很低（提炼只记下了「他手头紧」这类说法）
  for (const id of [secret.id, plain.id]) D.writeNorm(core, { kind: 'percept', id }, { sensitivity: 0.1, restriction: 'none' });
  core.mods.intake.markAssessed(core, [secret.id, plain.id]);
  core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE setting_key = ?", secret.setting_key);
  core.mods.intake.flushWindows(core, { force: true });
  const win = core.store.get('SELECT id FROM raw_windows WHERE setting_key = ? AND first_percept <= ? AND last_percept >= ?', secret.setting_key, secret.id, secret.id);
  assert.ok(win, '切出了含这句话的原文窗口');
  const ep = core.mods.encode.writeEpisode(core, {
    settingKey: secret.setting_key, kind: 'event', title: '朋友说手头紧', header: '朋友私下聊到最近手头有点紧', narrative: '他说最近手头紧，她安慰了他。',
    tStart: secret.at, tEnd: plain.at, participants: [friend],
    sources: [{ perceptId: secret.id, speaker: friend, asserter: friend, mode: 'told_to_her', hop: 0, quote: null, confidence: 0.9, at: secret.at }],
    norm: { sensitivity: 0.1, restriction: 'none' },
  });
  core.store.run('UPDATE percepts SET episode_id = ? WHERE id = ?', ep, secret.id);
  const refs = { secret: `p${secret.id}`, plain: `p${plain.id}`, window: `w${win.id}`, episode: `e${ep}` };
  return { w, friend, refs };
}

/** 一个人在群里问她，这一轮的关口①（真的判定，D113：非公开目标只跑第一段）。 */
async function gateIn(w, who, refs) {
  const { core } = w;
  const ask = w.say('groupY', who, '@她 他最近怎么样', ASK);
  await w.flush();
  const trig = w.perceptOf(ask).actor_entity_id;
  const target = core.mods.discretion.targetFor(core, { settingKey: w.keyOf('groupY'), homeSettingKey: w.keyOf('groupY'), sessionId: null, triggerEntityId: trig,
    mode: 'involuntary', at: w.clock.now() });
  const items = await core.mods.discretion.gate(core, refs.map((ref) => ({ ref, mref: { kind: { p: 'percept', w: 'window', e: 'episode' }[ref[0]], id: Number(ref.slice(1)) } })),
    target, { mode: 'involuntary', deadlineMs: 800 });
  return { ids: new Set(items.map((i) => i.ref)), items, ask };
}

test('提炼完成、规范敏感度很低以后：别人在群里问起，那句私事、含它的原文窗口、归了它的情节都不进群的上下文；平常的话照常进', async () => {
  const { w, refs } = await world('tps-gate');
  try {
    const before = metric(w.core, 'discretion.gate.omit.sensitiveOther');
    const { ids } = await gateIn(w, 'other', [refs.secret, refs.window, refs.episode, refs.plain]);
    assert.ok(!ids.has(refs.secret), '单条感知不进');
    assert.ok(!ids.has(refs.window), '原文窗口不进');
    assert.ok(!ids.has(refs.episode), '情节不进');
    assert.ok(ids.has(refs.plain), `平常的话照常进 ${[...ids]}`);
    assert.equal(metric(w.core, 'discretion.gate.omit.sensitiveOther') - before, 3);
    assert.ok(metric(w.core, 'discretion.gate.omit.sensitiveOther.byGlance') >= 3, '靠第一眼定的另记一笔');
  } finally { await w.close(); }
});

test('说的人自己在群里问起：他自己的事，照常进', async () => {
  const { w, refs } = await world('tps-own');
  try {
    const { ids } = await gateIn(w, 'friend', [refs.secret, refs.window, refs.episode]);
    assert.ok(ids.has(refs.secret) && ids.has(refs.window), `他自己的话照常进 ${[...ids]}`);
  } finally { await w.close(); }
});

test('外发守护：他自己问起时注入过的原文窗口，后来别人问起、她在群里几乎原样转述里面那句一对一的敏感原话 → 挡下；被回答的只有说话人 → 不挡；平常的话不挡', async () => {
  const { w, refs } = await world('tps-guard');
  try {
    const { pm } = w;
    const sid = 'g';
    pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings.groupY.id, adapterId: w.fp.namespace, confidence: 'specific' });
    // 他自己在群里问起：原文窗口和那句平常话照常进来（他自己的事），注入这个会话
    const { items, ask: own } = await gateIn(w, 'friend', [refs.window, refs.plain]);
    assert.ok(items.some((i) => i.ref === refs.window), '他自己问起：原文窗口进来了');
    await recallAt(w, 'groupY', own, { sessionId: sid });
    pm.sessions.injected({ sessionId: sid, nonce: 'n-own', layer: 'block', mode: 'live', chars: 80,
      items: items.map((i) => ({ id: i.ref, layer: 'recalled', verdict: i.verdict, appraisalRef: i.appraisalRef })) });
    pm.sessions.confirm(sid, 'n-own');
    const say = async (text) => {
      const a = await pm.expression.appraise({ channel: { targetSettingId: w.fp.settings.groupY.id, persistence: 'once' }, text: [text],
        origin: { path: 'tool', sessionId: sid, homeSettingId: w.fp.settings.groupY.id } });
      return { verdict: a.verdict, reasons: JSON.parse(w.core.store.get('SELECT reasons_json FROM utterances WHERE token = ?', a.token).reasons_json) };
    };
    const relay = `你跟我说过${SECRET}`;
    const b = await say(relay);
    assert.equal(b.verdict, 'speak', `被回答的只有说话人：不挡 ${JSON.stringify(b.reasons)}`);
    // 后来别人在群里问起：会话里还带着那个原文窗口
    const ask = w.say('groupY', 'other', '@她 他最近怎么样', ASK);
    await w.flush();
    await recallAt(w, 'groupY', ask, { sessionId: sid });
    const a = await say(`他跟我说${SECRET}`);
    assert.equal(a.verdict, 'reconsider', JSON.stringify(a.reasons));
    assert.ok(a.reasons.includes('guard:relay'), JSON.stringify(a.reasons));
    assert.ok(a.reasons.includes(refs.secret), `挡下的是窗口里那一句原话 ${JSON.stringify(a.reasons)}`);
    const c = await say(`他说${PLAIN}`);
    assert.equal(c.verdict, 'speak', `平常的话不挡 ${JSON.stringify(c.reasons)}`);
  } finally { await w.close(); }
});

test('第一眼落在中间一段（0.6）、规范很低：别人在群里问起，不因为第一眼降成「说个大概」——那条上限只看规范（D135 当天的修正）', async () => {
  const { evaluate } = await import('../../src/discretion/stage1.js');
  const MID = '今天心情有点复杂，说不上来';
  const w = await openWorld({ seed: SEED, name: 'tps-mid', config: LIVE, friendDm: true,
    llm: new FakeLLM({ fallback: { appraise: () => [], glance: glancer((t) => (t.text.includes('复杂') ? { sens: 0.6 } : {})) } }) });
  try {
    addGroup(w);
    await w.flush();
    const { core } = w;
    const D = core.mods.discretion;
    const a = w.say('friendDm', 'friend', MID, TO_HER);
    const b = w.say('friendDm', 'friend', PLAIN, TO_HER);
    await w.flush();
    await D.glancesIdle(core);
    const mid = w.perceptOf(a);
    const plain = w.perceptOf(b);
    assert.equal(D.glancesOf(core, [mid.id]).get(mid.id)?.sens, 0.6);
    for (const id of [mid.id, plain.id]) D.writeNorm(core, { kind: 'percept', id }, { sensitivity: 0.1, restriction: 'none' });
    core.mods.intake.markAssessed(core, [mid.id, plain.id]);
    core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE setting_key = ?", mid.setting_key);
    const ask = w.say('groupY', 'other', '@她 他最近怎么样', ASK);
    await w.flush();
    const target = D.targetFor(core, { settingKey: w.keyOf('groupY'), homeSettingKey: w.keyOf('groupY'), sessionId: null,
      triggerEntityId: w.perceptOf(ask).actor_entity_id, mode: 'involuntary', at: w.clock.now() });
    const evMid = evaluate(core, { kind: 'percept', id: mid.id }, target, new Map());
    const evPlain = evaluate(core, { kind: 'percept', id: plain.id }, target, new Map());
    assert.equal(evMid.sensitiveOther, false, '没到 0.7：底线不触发');
    assert.deepEqual([evMid.decision, evMid.cap ?? null], [evPlain.decision, evPlain.cap ?? null], '和一句平常的话判得一样，没有被第一眼的 0.6 压成说个大概');
  } finally { await w.close(); }
});
