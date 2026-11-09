// 集成场景 S1、S2（设计 §14.3；模块与接口 §4.14 牵头方「集成」）：十二个真模块一起跑，走完整的
// 感知（假平台 → observe）→ tick / runJobs（切分、提炼、时间维护）→ 夜间整理 → 回想（resident / recall）→ 外发审视 → outcome。
// 期望照 §14.3 原文和它依据的 §1.1、§5.5、§6：
//   S1 「等下去拿快递」→ 两小时后「拿到了」→ 三天后问「快递拿了没」：答「拿了，那天晚上说拿到的」；拿到之后不会再主动提醒。
//   S2 「去拿快递」后一直没下文，第二天主人出现：自然地问「快递后来拿到没」，不断言。
// 另有：S2 的后续（不确定的计划之后照样能结案）；起真 worker 线程的冒烟（observe → 嵌入队列 → 稠密 + 词法召回 → 干净地关掉）；
// 假平台夹具和真实适配器一致（一对一的成员）；提炼调用的间隔不让 runJobs 悬空（子进程里跑）。
// 假平台的种子在失败时打印（t.diagnostic），用 FAKE_PLATFORM_SEED 复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePlansWorld, parcelPlan, parcelDone, localMs, speakerCode, msgCode } from './plans-world.js';
import { FakeEmbedding, fakePorts } from '../fakes/index.js';
import { createPersonaMemory } from '../../src/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { rmDir, TMP_ROOT } from '../helpers.js';

const inLayer = (layers, layer) => layers.items.filter((i) => i.layer === layer);
const allText = (layers) => layers.items.map((i) => i.rendered).join('\n');
const itemOf = (layers, ref) => layers.items.find((i) => i.id === ref) ?? null;
const show = (layers) => JSON.stringify(layers.items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));

test('S1 拿快递：计划 → 拿到了（这一次结案、意图撤掉）→ 之后不再主动提醒；三天后问「快递拿了没」答得上「拿了，那天晚上说拿到的」；没有硬过期', async (t) => {
  const w = await makePlansWorld('s1');
  t.diagnostic(`fake-platform seed=${w.fp.seed}`);
  try {
    const owner = w.entityOf('principal');
    // 10/31 18:00 主人私聊：「等下去拿快递」
    const said = await w.say('oneOnOne', 'principal', '等下去拿快递');
    w.clock.minutes(1);
    await w.say('oneOnOne', 'her', '好呀，拿到跟我说一声');
    w.onExtract('去拿快递', parcelPlan({ intent: true }));
    await w.settle(25);
    const plans = w.rows("SELECT * FROM assertions WHERE kind_hint = 'plan'");
    assert.equal(plans.length, 1, '他的计划是一条关于世界的事实（§1.1）');
    const plan = plans[0];
    const planRef = `a${plan.id}`;
    assert.equal(plan.plan_status, 'planned');
    assert.equal(plan.plan_agent, owner, '谁的计划');
    assert.ok(plan.occurrence_key, '这一次：计划的身份里有它发生的时间窗（§5.4 发生次）');
    const [intent] = w.rows('SELECT * FROM intentions');
    assert.ok(intent, '她自己的意图单独建记录：晚点问问');
    assert.deepEqual([intent.about_kind, intent.about_id, intent.target_entity_id, intent.state], ['assertion', plan.id, owner, 'formed']);

    // 19:30 意图到了时间窗（armed）；主人在私聊里冒个头：「你想着的」浮上来（惦记）
    w.at('2026-10-31T19:30');
    assert.equal((await w.tick()).time.intentionsArmed, 1);
    assert.equal(w.row('SELECT state FROM intentions WHERE id = ?', intent.id).state, 'armed');
    await w.say('oneOnOne', 'principal', '在吗');
    let L = await w.recall();
    const want = inLayer(L, 'intentions');
    assert.ok(want.some((i) => i.id === `t${intent.id}` && /快递/.test(i.rendered)), `还没下文：想着要问（${show(L)}）`);
    const wantPlan = want.find((i) => i.id === planRef);
    assert.ok(wantPlan, '意图指向的计划也一起过了关口①');
    assert.match(wantPlan.rendered, /还没听说结果/, '那时的状态：还没下文');
    assert.match(w.pm.resident(w.DM).text, /近期约定[\s\S]*快递/, '常驻区的近期约定里有这件事');

    // 20:00 主人：「拿到了」→ 提炼把这一次结案
    w.at('2026-10-31T20:00');
    const got = await w.say('oneOnOne', 'principal', '拿到了');
    const seen = {};
    w.onExtract('拿到了', parcelDone(seen));
    await w.settle(25);
    assert.deepEqual(w.pendingExtract(), [], '两段都提炼了');
    assert.ok(seen.target, '提炼背景里有这个人还没结案的计划（模型只能对背景里的事实写 plan_status）');
    assert.match(seen.bg, /还没听说结果|到时候了/, '背景里的计划写着当时的状态');
    const after = w.row('SELECT * FROM assertions WHERE id = ?', plan.id);
    assert.equal(after.plan_status, 'done', '这一次 → 完成');
    assert.equal(w.rows("SELECT id FROM assertions WHERE kind_hint = 'plan'").length, 1, '结案不新建、不删除');
    const hist = w.rows('SELECT status, at, evidence_percept FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id', plan.id);
    assert.deepEqual(hist.map((h) => h.status), ['planned', 'done'], '每一次变化都留在历史里');
    assert.deepEqual([hist[0].evidence_percept, hist[1].evidence_percept], [said.perceptId, got.perceptId], '每一次变化都有出处');
    assert.equal(hist[1].at, localMs('2026-10-31T20:00'), '结案的时间是证据消息的时间');
    // 完成这件事本身作为一条普通情节编码（outcome 指向它）
    assert.match(String(after.plan_outcome_ref), /^e\d+$/);
    const outcomeId = Number(after.plan_outcome_ref.slice(1));
    const outcome = w.row('SELECT * FROM episodes WHERE id = ?', outcomeId);
    assert.ok(outcome && outcome.ep_kind === 'event' && /拿到了/.test(outcome.narrative), '「他说拿到了」是一条普通的情节');
    const io = w.row('SELECT * FROM intentions WHERE id = ?', intent.id);
    assert.equal(io.state, 'obsolete', '指向它的意图撤掉（§5.5 第 3 条）');
    assert.equal(io.suppressed_at, localMs('2026-10-31T20:00'), '抑制从完成证据的时间开始');

    // 21:00 主人又冒个头：不会再去提醒 / 追问
    w.at('2026-10-31T21:00');
    await w.say('oneOnOne', 'principal', '在吗');
    const bias21 = w.core.mods.dynamics.intentionBias(w.core, w.row('SELECT * FROM intentions WHERE id = ?', intent.id), { at: w.clock.now(), cueHit: true });
    assert.ok(bias21 < -0.3, `完成后短暂抑制（I = ${bias21}）`);
    const B21 = w.core.mods.dynamics.baseActivation(w.core, { kind: 'episode', id: outcomeId }, w.clock.now());
    L = await w.recall();
    assert.deepEqual(inLayer(L, 'intentions'), [], `拿到之后不会再主动提醒（${show(L)}）`);
    assert.doesNotMatch(allText(L), /问问他快递/);
    assert.doesNotMatch(w.pm.resident(w.DM).text, /近期约定[\s\S]*快递/, '结案的计划不再列在近期约定里');

    // 夜里整理：做完的事不会被「到点没下文」改回不确定，也不会被重新拎出来「回头问问」
    w.at('2026-11-01T04:30');
    const night = await w.pm.maintenance.sleep();
    assert.ok(night.steps.some((s) => s.name === 'time'), JSON.stringify(night.steps));
    assert.deepEqual(w.calls.followUp, [], '没有没下文的计划，不问模型');
    assert.equal(w.row('SELECT plan_status FROM assertions WHERE id = ?', plan.id).plan_status, 'done');
    assert.deepEqual(w.rows('SELECT id, state FROM intentions').map((r) => [r.id, r.state]), [[intent.id, 'obsolete']]);

    // 次日上午：照样不提
    w.at('2026-11-01T10:00');
    await w.say('oneOnOne', 'principal', '早呀');
    L = await w.recall();
    assert.deepEqual(inLayer(L, 'intentions'), [], `第二天也不会提醒（${show(L)}）`);

    // 三天后 20:00：「我那个快递拿了没来着」
    w.at('2026-11-03T20:00');
    assert.ok(w.row('SELECT 1 AS x FROM assertions WHERE id = ?', plan.id), '没有硬过期：计划还在');
    assert.ok(w.row('SELECT 1 AS x FROM episodes WHERE id = ?', outcomeId), '完成的经历还在');
    const B3 = w.core.mods.dynamics.baseActivation(w.core, { kind: 'episode', id: outcomeId }, w.clock.now());
    assert.ok(Number.isFinite(B3) && B3 < B21, `按统一曲线慢慢淡忘（B ${B21.toFixed(2)} → ${B3.toFixed(2)}），不是删掉`);
    const biasNow = w.core.mods.dynamics.intentionBias(w.core, w.row('SELECT * FROM intentions WHERE id = ?', intent.id), { at: w.clock.now(), cueHit: true });
    assert.ok(Math.abs(biasNow) < 0.01, `抑制只是短暂的（I = ${biasNow}）`);
    await w.say('oneOnOne', 'principal', '我那个快递拿了没来着');
    L = await w.recall();
    t.diagnostic(`三天后问：${show(L)}`);
    const p = itemOf(L, planRef);
    assert.ok(p, `问起来能想到这次计划（${show(L)}）`);
    assert.equal(p.layer, 'recalled');
    assert.ok(['share', 'share_vague'].includes(p.verdict));
    assert.match(p.rendered, /快递/);
    assert.match(p.rendered, /做完了/, '时态正确：做完了');
    assert.match(p.rendered, /10\/31 20:00/, '「那天晚上说拿到的」：结案的时间来自状态历史');
    const o = itemOf(L, `e${outcomeId}`);
    assert.ok(o && /拿到了/.test(o.rendered), `沿着「完成了」这条链接找到「他说拿到了」（${show(L)}）`);
    assert.doesNotMatch(allText(L), /还没听说结果|后来怎么样没听说/, '不会说成还没下文');
    assert.deepEqual(inLayer(L, 'intentions'), []);
    // 答「拿了，那天晚上说拿到的」，不是「好像拿了」：他本人当面说的、问起来也想得起（P≈1），措辞不该含糊（§6.6）。
    // 提炼行照着提示词【示例一】写（示例的计划行带不带 confidence，模型就带不带），这一条照样要成立
    assert.doesNotMatch(p.rendered, /好像/,
      `他自己说的、问起来想得起：直接说，不含糊（${p.rendered}；confidence=${after.confidence}，直接说的门槛 ${w.core.config.get().recall.render.sureAbove}）`);
  } finally { await w.close(); }
});

test('S2 拿快递一直没下文：到点变成「不确定」（不删）→ 夜里形成「回头问问」→ 第二天主人一出现就问「快递后来拿到没」，不断言；问过不再问；之后的回答照样能结案', async (t) => {
  const w = await makePlansWorld('s2', {
    // 夜里那一问：拿快递对最亲近的人也算件该问一句的事（形不形成由模型判断，§5.5 第 1、5 条）
    followUp: ({ text }) => (/快递/.test(text) ? { form: true, act: '追问', text: '问问他快递后来拿到没' } : { form: false }),
  });
  t.diagnostic(`fake-platform seed=${w.fp.seed}`);
  try {
    const owner = w.entityOf('principal');
    // 10/31 18:00：「等下去拿快递」——琐事，模型这次没形成意图
    await w.say('oneOnOne', 'principal', '等下去拿快递');
    w.onExtract('去拿快递', parcelPlan({ intent: false, narrative: '傍晚主人说等下要去拿快递。' }));
    await w.settle(25);
    const [plan] = w.rows("SELECT * FROM assertions WHERE kind_hint = 'plan'");
    assert.ok(plan);
    const planRef = `a${plan.id}`;
    assert.equal(plan.plan_status, 'planned');
    assert.deepEqual(w.rows('SELECT id FROM intentions'), [], '琐事不一定形成意图');

    // 21:30 还在时间窗附近：不急着下结论
    w.at('2026-10-31T21:30');
    assert.equal((await w.tick()).time.plansUnknown, 0);
    // 22:30 过了时间窗、没有任何下文：unknown，不是过期删除
    w.at('2026-10-31T22:30');
    assert.equal((await w.tick()).time.plansUnknown, 1);
    const unk = w.row('SELECT * FROM assertions WHERE id = ?', plan.id);
    assert.equal(unk.plan_status, 'unknown');
    assert.equal(unk.valid_to_known, null, '不确定不是结案');
    assert.deepEqual(w.rows('SELECT status FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id', plan.id).map((r) => r.status), ['planned', 'unknown']);

    // 夜里整理：问一次模型要不要回头问问 → 形成意图
    w.at('2026-11-01T04:30');
    await w.pm.maintenance.sleep();
    assert.equal(w.calls.followUp.length, 1, '新变成 unknown 的计划交给模型掂量');
    assert.match(w.calls.followUp[0].text, /要去拿快递/);
    const [intent] = w.rows('SELECT * FROM intentions');
    assert.ok(intent, '形成「回头问问」');
    assert.deepEqual([intent.about_kind, intent.about_id, intent.target_entity_id, intent.origin], ['assertion', plan.id, owner, 'self-care']);
    assert.ok(['formed', 'armed'].includes(intent.state));
    assert.equal(w.row('SELECT plan_status FROM assertions WHERE id = ?', plan.id).plan_status, 'unknown', '计划还是不确定');

    // 第二天 10:00 主人一出现
    w.at('2026-11-01T10:00');
    w.pm.sessions.bind({ sessionId: 'sess-s2', settingId: w.DM, adapterId: w.fp.namespace, confidence: 'specific' });
    await w.say('oneOnOne', 'principal', '早呀', { sessionRef: { sessionId: 'sess-s2' } });
    let L = await w.recall('oneOnOne', { sessionId: 'sess-s2' });
    t.diagnostic(`第二天主人一出现：${show(L)}`);
    const want = inLayer(L, 'intentions');
    const ti = want.find((i) => i.id === `t${intent.id}`);
    assert.ok(ti && /快递后来拿到没/.test(ti.rendered), `自然地想问「快递后来拿到没」（${show(L)}）`);
    const about = want.find((i) => i.id === planRef);
    assert.ok(about, '意图指向的计划一起给出');
    assert.match(about.rendered, /后来怎么样没听说/, '计划的状态是「不确定」');
    assert.doesNotMatch(allText(L), /做完了|没做成|取消了/, '不断言（既不说拿了，也不说没拿）');

    // 她开口问：注入 → 确认 → 外发审视 → 发出去 → 她的话回流 → 记下「问过了」
    const items = L.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef }));
    w.pm.sessions.injected({ sessionId: 'sess-s2', nonce: 'nonce-s2-1', layer: 'recall', items, chars: allText(L).length, degradeLevel: L.degradeLevel, mode: 'live' });
    w.pm.sessions.confirm('sess-s2', 'nonce-s2-1');
    const line = '早呀～对了，快递后来拿到没？';
    const ap = await w.pm.expression.appraise({ channel: { targetSettingId: w.DM, persistence: 'once' }, text: [line], origin: { path: 'tool', sessionId: 'sess-s2' } });
    t.diagnostic(`外发审视：${ap.verdict}（独立审视调用 ${w.calls.review} 次）`);
    assert.equal(ap.verdict, 'speak', '在和主人的私聊里问他自己的事：直接说');
    w.clock.minutes(1);
    await w.say('oneOnOne', 'her', line, { appraisalToken: ap.token, sessionRef: { sessionId: 'sess-s2' } });
    w.pm.expression.outcome(ap.token, 'sent');
    await w.flush();
    const done = w.row('SELECT * FROM intentions WHERE id = ?', intent.id);
    assert.equal(done.state, 'executed', '问过了');
    const ex = JSON.parse(done.executions_json);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].targetEntityId, owner);

    // 几分钟后主人又说了句别的：不会再问一遍（对同一个人冷却 48 小时，§5.5 第 8 条）
    w.clock.minutes(4);
    await w.say('oneOnOne', 'principal', '刚起床', { sessionRef: { sessionId: 'sess-s2' } });
    L = await w.recall('oneOnOne', { sessionId: 'sess-s2' });
    assert.deepEqual(inLayer(L, 'intentions'), [], `问过了不再问（${show(L)}）`);

    // 主人回答「拿到了，昨晚就拿了」：不确定的计划照样能被之后的证据结案
    w.clock.minutes(1);
    const ans = await w.say('oneOnOne', 'principal', '拿到了，昨晚就拿了', { sessionRef: { sessionId: 'sess-s2' } });
    const seen = {};
    w.onExtract('拿到了', parcelDone(seen));
    await w.settle(25);
    assert.deepEqual(w.pendingExtract(), [], `回答那一段提炼了（背景里有那条计划：${seen.bg ?? '没有'}）`);
    assert.match(String(seen.bg), /后来怎么样没听说/, '背景里的计划写着「不确定」');
    const fin = w.row('SELECT * FROM assertions WHERE id = ?', plan.id);
    assert.equal(fin.plan_status, 'done');
    const hist = w.rows('SELECT status, evidence_percept FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id', plan.id);
    assert.deepEqual(hist.map((h) => h.status), ['planned', 'unknown', 'done']);
    assert.equal(hist.at(-1).evidence_percept, ans.perceptId);
  } finally { await w.close(); }
});

test('S2（意图从提炼时就挂着）：到点没下文 → 计划不确定、意图还挂着；夜里不重复形成；第二天主人一出现就问，不断言', async (t) => {
  const w = await makePlansWorld('s2b-hang', { followUp: () => ({ form: true, act: '追问', text: '问问他快递后来拿到没' }) });
  t.diagnostic(`fake-platform seed=${w.fp.seed}`);
  try {
    await w.say('oneOnOne', 'principal', '等下去拿快递');
    w.onExtract('去拿快递', parcelPlan({ intent: true, narrative: '傍晚主人说等下要去拿快递。' }));   // 意图的时间窗：19:00 到次日 12:00
    await w.settle(25);
    const [plan] = w.rows("SELECT * FROM assertions WHERE kind_hint = 'plan'");
    const [intent] = w.rows('SELECT * FROM intentions');
    assert.ok(plan && intent);
    w.at('2026-10-31T22:30');
    const tk = await w.tick();
    assert.equal(tk.time.plansUnknown, 1);
    assert.equal(w.row('SELECT plan_status FROM assertions WHERE id = ?', plan.id).plan_status, 'unknown');
    assert.equal(w.row('SELECT state FROM intentions WHERE id = ?', intent.id).state, 'armed', '计划不确定不撤意图');
    w.at('2026-11-01T04:30');
    await w.pm.maintenance.sleep();
    assert.deepEqual(w.calls.followUp, [], '已经挂着意图的计划不再问模型');
    assert.equal(w.rows('SELECT id FROM intentions').length, 1, '不重复形成');
    w.at('2026-11-01T09:30');
    await w.say('oneOnOne', 'principal', '早呀');
    const L = await w.recall();
    const want = inLayer(L, 'intentions');
    assert.ok(want.some((i) => i.id === `t${intent.id}` && /快递/.test(i.rendered)), `意图还挂着：问（${show(L)}）`);
    const about = want.find((i) => i.id === `a${plan.id}`);
    assert.ok(about && /后来怎么样没听说/.test(about.rendered), '计划写成不确定');
    assert.doesNotMatch(allText(L), /做完了/, '不断言');
  } finally { await w.close(); }
});

test('S2 续：不确定的计划不是结案——第二天他先聊了一串别的事，再说「拿到了，昨晚就拿了」，提炼背景里照样有这条计划，能结案', async (t) => {
  const w = await makePlansWorld('s2-later');
  t.diagnostic(`fake-platform seed=${w.fp.seed}`);
  try {
    await w.say('oneOnOne', 'principal', '等下去拿快递');
    w.onExtract('去拿快递', parcelPlan({ intent: false, narrative: '傍晚主人说等下要去拿快递。' }));
    await w.settle(25);
    const [plan] = w.rows("SELECT * FROM assertions WHERE kind_hint = 'plan'");
    w.at('2026-10-31T22:30');
    await w.tick();
    assert.equal(w.row('SELECT plan_status FROM assertions WHERE id = ?', plan.id).plan_status, 'unknown');
    // 次日上午：他先说了一串今天和最近的事（都是关于他的、刚说的、比拿快递要紧的新事实）
    w.at('2026-11-01T10:25');
    const news = [['今天要开一天的会', '开会', '主人11/01要开一天的会'], ['晚上还要去健身', '健身', '主人11/01晚上要去健身'],
      ['周末回老家', '回老家', '主人这个周末要回老家'], ['最近在减肥', '减肥', '主人最近在减肥'],
      ['下个月要出差', '出差', '主人下个月要出差'], ['新买了一辆自行车', '自行车', '主人新买了一辆自行车']];
    for (const [text] of news) { await w.say('oneOnOne', 'principal', text); w.clock.minutes(1); }
    w.onExtract('今天要开一天的会', (req) => {
      const U = speakerCode(req, '主人');
      return [{ type: 'narrative', text: '上午主人说了今天、周末和下个月的安排，还说最近在减肥、新买了自行车。' },
        ...news.map(([quote, predicate, text], i) => ({ type: 'fact', id: `f${i + 1}`, subjects: [U], speaker: U, asserter: U, certainty: 'stated',
          predicate, value: predicate, text, kind_hint: 'state', imp: 7, confidence: 0.9, msgRefs: [msgCode(req, quote)], quote }))];
    });
    await w.settle(25);
    assert.equal(w.rows('SELECT id FROM assertions').length, 1 + news.length);
    // 11:00 他回答昨天那件事（和上面那段隔了 25 分钟，是另一段）
    w.at('2026-11-01T11:00');
    const ans = await w.say('oneOnOne', 'principal', '拿到了，昨晚就拿了');
    const seen = {};
    w.onExtract('拿到了', (req) => { seen.prompt = req.messages[0].content; return parcelDone(seen)(req); });
    await w.settle(25);
    t.diagnostic(`提炼背景：${String(seen.prompt ?? '').split('\n').filter((l) => l.includes('背景')).join(' / ')}`);
    // 「拿到了」和「去拿快递」没有共同的词（D58）：这个人还没结案的计划要先想到——unknown 也还没结案（§5.5 第 3、5 条）
    assert.ok(seen.target, '提炼背景里有这条不确定的计划（模型只能对背景里的事实写 plan_status）');
    assert.match(String(seen.bg), /后来怎么样没听说/);
    assert.equal(w.row('SELECT plan_status FROM assertions WHERE id = ?', plan.id).plan_status, 'done');
    const h = w.rows('SELECT status, evidence_percept FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id', plan.id);
    assert.deepEqual(h.map((x) => x.status), ['planned', 'unknown', 'done']);
    assert.equal(h.at(-1).evidence_percept, ans.perceptId);
  } finally { await w.close(); }
});

test('冒烟（起真 worker 线程）：observe → 嵌入队列 → 稠密和词法两路都召回得到 → 干净地关掉、再打开', async (t) => {
  const embedding = new FakeEmbedding({ synonyms: [['快递', '包裹'], ['拿', '取']] });
  const w = await makePlansWorld('smoke-thread', { startWorker: true, embedding });
  t.diagnostic(`fake-platform seed=${w.fp.seed}`);
  let closed = false;
  try {
    const st = w.pm.status().startup;
    assert.equal(st.worker?.ok, true, `worker 线程起来了：${JSON.stringify(st.worker)}`);
    assert.equal(st.space?.status, 'active', JSON.stringify(st.space));
    // 10/31 下午：主人在私聊里说了几句（够切一个原文窗口）
    const lines = ['下午去驿站取了包裹', '顺便买了杯咖啡', '驿站门口排了好长的队', '还碰到楼下的邻居'];
    for (const l of lines) { await w.say('oneOnOne', 'principal', l); w.clock.minutes(1); }
    // 最后一句直接经 api.observe 进来（不经适配器的 sink）
    const last = w.fp.obs('oneOnOne', 'principal', '回来路上下雨了', { at: w.clock.now(), perceivedAt: w.clock.now(), addressed: 'to-her', attention: 'attended' });
    w.pm.observe([last], { adapter: w.fp.namespace });
    await w.flush();
    assert.equal(w.row('SELECT count(*) AS n FROM percepts').n, lines.length + 1, '五句都入库了');
    w.onExtract('驿站取了包裹', (req) => [
      { type: 'header', title: '主人去驿站取包裹', text: '2026-10-31 下午，主人去驿站取了包裹' },
      { type: 'narrative', text: '主人说下午去驿站取了包裹，顺便买了咖啡，回来路上下雨了。' },
    ]);
    const s = await w.settle(25);
    assert.ok(w.row('SELECT count(*) AS n FROM raw_windows').n >= 1, `切出了原文窗口：${JSON.stringify(s.tick.windows)}`);
    assert.deepEqual(w.pendingExtract(), []);
    // 嵌入队列跑完（原文窗口 + 新情节）
    let embedded = s.tick.embed?.embedded ?? 0;
    for (let i = 0; i < 10; i++) {
      const r = await w.core.mods.worker.runEmbedQueue(w.core, { maxBatches: 10 });
      embedded += r.embedded ?? 0;
      if (!(r.embedded > 0)) break;
    }
    assert.ok(embedded > 0, '嵌入了');
    assert.equal(w.row("SELECT count(*) AS n FROM embed_texts WHERE status <> 'done'").n, 0, '队列清空');
    const h = w.core.mods.worker.health(w.core);
    assert.equal(h.mode, 'thread', JSON.stringify(h));
    assert.equal(h.dense, true, JSON.stringify(h));

    // 第二天换个说法问：稠密（同义改写）和词法（共同的词）都找得到
    w.at('2026-11-01T20:00');
    const q = await w.say('oneOnOne', 'principal', '我昨天的快递拿了没');
    const key = w.keyOf('oneOnOne');
    const cs = await w.core.mods.retrieve.recall(w.core, { settingKey: key, focusPerceptId: q.perceptId, trigger: 'message' }, { mode: 'deliberate', deadlineMs: 20_000 });
    const ep = w.row("SELECT id FROM episodes WHERE ep_kind = 'event' AND narrative LIKE '%包裹%'");
    assert.ok(ep);
    const hits = cs.items.filter((c) => c.ref === `e${ep.id}` || /^[wp]\d+$/.test(c.ref));
    assert.ok(cs.items.some((c) => c.ranks?.dense != null), `稠密路经 worker 线程有命中：${JSON.stringify(cs.items.map((c) => [c.ref, c.ranks]))}`);
    assert.ok(hits.some((c) => c.ranks?.dense != null), '换个说法（快递 ↔ 包裹）也想得起来');
    // 词法：直接查 worker（「驿站」只在那段里出现过）
    const lex = await w.core.mods.worker.lexicalSearch(w.core, { terms: ['驿站'], tables: ['episodes_fts', 'percepts_fts'], limit: 10 });
    assert.equal(lex.timedOut, false);
    assert.ok(lex.hits.some((x) => x.ref === `e${ep.id}`), `词法路命中情节：${JSON.stringify(lex.hits)}`);
    assert.ok(lex.hits.some((x) => /^p\d+$/.test(x.ref)), '词法路命中原文');
    const L = await w.recall();
    assert.ok(L.items.some((i) => /包裹/.test(i.rendered)), `回想里有那件事：${show(L)}`);

    // 干净地关掉：线程停了、写者锁放了，同一个目录能再打开
    await w.pm.close();
    closed = true;
    assert.equal(w.core.store.closed, true);
    const again = await createPersonaMemory({ dataDir: w.dir, ports: fakePorts({ embedding }), startWorker: true, config: { time: { tzOffsetMin: 480 } } });
    try {
      assert.equal(again.status().readOnly, false, '写者锁放了');
      assert.equal(again.status().startup.worker?.ok, true);
      assert.ok(again._core.vectors.all('SELECT count(*) AS n FROM vectors')[0].n > 0, '向量是缓存，重开后还在（嵌入文本没变就不删）');
      assert.equal(again._core.store.get("SELECT count(*) AS n FROM embed_texts WHERE status <> 'done'").n, 0, '不用重嵌');
    } finally { await again.close(); }
  } finally {
    if (!closed) await w.pm.close();
    rmDir(w.dir);
  }
});

test('假平台（夹具）和真实适配器一样：能列全成员的场合，members() 不会比 audience.size 多出人来（一对一就是她和对方）', async (t) => {
  // §14.2「假平台」：它跑出来的结果必须和真实适配器一致。一对一（size 2、exact）多列出一个人，出现集合里就多一个「新知情者」，
  // 主人自己在私聊里说的事在这个私聊里也过不了 A1（S1 三天后问什么都想不起来）；本文件的小世界因此替一对一改了 members()
  const fp = createFakePlatform();
  t.diagnostic(`fake-platform seed=${fp.seed}`);
  for (const [name, s] of Object.entries(fp.settings)) {
    const a = s.descriptor.audience;
    if (a.membersKnown !== 'exact' || typeof a.size !== 'number') continue;
    const m = await fp.adapter.members(s.id);
    assert.ok(Array.isArray(m) && m.length <= a.size, `${name}：audience.size=${a.size}，members() 给了 ${m?.length} 个人`);
  }
});

test('提炼两次调用之间的间隔（§10.6）不会让 runJobs 悬空：进程里只剩它在等时，任务队列照样跑完（命令行工具、批量补提炼）', () => {
  const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'plans-spacing-child.mjs');
  const run = (spacing) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', child, String(spacing)], { encoding: 'utf8', timeout: 60_000 });
    const dir = r.stdout?.match(/^dir (.+)$/m)?.[1]?.trim();
    if (dir && path.resolve(dir).startsWith(TMP_ROOT)) rmDir(dir);   // 子进程提前退出时它自己删不了
    return r;
  };
  // 对照：不要求间隔时一定跑完（说明子进程本身没问题）
  const ok = run(0);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /jobs-done/);
  // 默认的间隔（两段在同一次 tick 里排上，第二次调用要等）：照样跑完，不能因为只剩一个 unref 的定时器就让进程直接退出
  const r = run(DEFAULTS.extract.minSpacingMs);
  assert.match(r.stdout, /jobs-done/, `runJobs 没有完成就退出了（exit ${r.status}）：${r.stderr.split(/\r?\n/).slice(0, 3).join(' / ')}`);
  assert.match(r.stdout, /closed/);
  assert.equal(r.status, 0);
});
