// 计划和意图（§5.5）：transitionPlan / formIntention / transitionIntention / recordExecution / dueIntentions / recheckIntention。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, MINUTE, HOUR, DAY } from './harness.js';

async function setup() {
  const w = await makeWorld();
  const owner = w.entity('阿杰', { closeness: 1, authority: 'principal' });
  const ming = w.entity('阿明', { closeness: 0.3 });
  const dm = w.setting('私聊', { exposure: 0 });
  const g = w.setting('游戏群', { exposure: 2 });
  const enc = w.core.mods.encode;
  /** 主人的一个计划（取快递），返回 {plan, p}。 */
  const plan = (text = '等下去拿快递', o = {}) => {
    const p = w.percept(o.setting ?? dm, o.agent ?? owner, text, { addressed: 'to-her' });
    const at = w.clock.now();
    const id = enc.writeAssertion(w.core, { subjects: [o.agent ?? owner], predicate: '取快递', text: o.factText ?? '阿杰要去拿快递', kindHint: 'plan', certainty: 'stated', confidence: 0.9, imp: 3,
      plannedTime: { start: at, end: at + 3 * HOUR, precision: 'fuzzy' }, plan: { agent: o.agent ?? owner, status: 'planned' }, futureQ: ['快递拿了没'],
      sources: [{ perceptId: p, speaker: o.agent ?? owner, asserter: o.agent ?? owner, mode: 'told_to_her', hop: 0, confidence: 0.9, at }], norm: {}, w: 1 });
    return { plan: id, p, at };
  };
  const intend = (planId, p, o = {}) => enc.formIntention(w.core, {
    about: { kind: 'assertion', id: planId }, targetEntityId: o.target ?? owner, act: o.act ?? '追问', text: o.text ?? '晚点问问他快递拿到没', origin: o.origin ?? 'self-care',
    trigger: { timeWindow: o.window ?? null, cues: o.cues ?? [{ entity: o.target ?? owner }] }, evidencePerceptIds: o.evidence ?? [p],
  }, { at: o.at ?? w.clock.now(), historical: o.historical, jobId: null });
  return { w, owner, ming, dm, g, enc, plan, intend };
}

test('transitionPlan：每次变化写历史；done / cancelled / missed 把指向它的意图转 obsolete 并开始抑制；结案后不会被「到点没下文」改回 unknown', async () => {
  const { w, enc, plan, intend } = await setup();
  try {
    const { plan: id, p } = plan();
    const t = intend(id, p);
    assert.equal(w.intentions()[0].state, 'armed');
    w.clock.hours(2);
    enc.transitionPlan(w.core, id, 'in_progress', { at: w.clock.now(), evidencePerceptId: p });
    enc.transitionPlan(w.core, id, 'done', { at: w.clock.now(), evidencePerceptId: p, outcomeRef: 'e5', source: { jobId: 3 } });
    const a = w.assertion(id);
    assert.equal(a.plan_status, 'done');
    assert.equal(a.plan_outcome_ref, 'e5');
    assert.equal(a.valid_to_known, w.clock.now());
    const it = w.core.store.get('SELECT * FROM intentions WHERE id = ?', t);
    assert.equal(it.state, 'obsolete');
    assert.equal(it.suppressed_at, w.clock.now());
    enc.transitionPlan(w.core, id, 'unknown', { at: w.clock.now() + DAY });
    assert.equal(w.assertion(id).plan_status, 'done');
    assert.deepEqual(enc.planHistory(w.core, id).map((h) => h.status), ['planned', 'in_progress', 'done']);
    assert.deepEqual(enc.planHistory(w.core, id)[2].source, { jobId: 3 });
    assert.throws(() => enc.transitionPlan(w.core, id, 'whatever', { at: 1 }), TypeError);
    // 到点没下文 → unknown（不是过期删除）
    const { plan: id2 } = plan('明天去取');
    enc.transitionPlan(w.core, id2, 'unknown', { at: w.clock.now() });
    assert.equal(w.assertion(id2).plan_status, 'unknown');
    assert.equal(w.assertion(id2).valid_to_known, null);
  } finally { await w.cleanup(); }
});

test('formIntention：origin 和证据一致才形成；历史模式不形成；同一条还开着不重复；每人每天 ≤ 4 条；规范继承 about 和证据（推断类）', async () => {
  const { w, owner, ming, dm, g, enc, plan, intend } = await setup();
  try {
    const { plan: id, p } = plan();
    assert.equal(intend(id, p, { historical: true }), null, '回填旧日志时不形成意图（§5.5 第 13 条）');
    const t1 = intend(id, p);
    assert.ok(t1);
    assert.equal(intend(id, p), t1, '同一条还开着：不重复形成');
    const inh = w.callsOf('inheritNorm').at(-1);
    assert.equal(inh.ref, `t${t1}`);
    assert.deepEqual(inh.evidence, [`a${id}`, `p${p}`]);
    assert.equal(inh.ctx.derivation, 'inference');
    assert.equal(w.sources('intention', t1).length, 1);
    assert.ok(w.embeds.get(`t${t1}`));
    // 第三方请求（证据是阿明的话，内容不是阿明自己的事）→ 不形成
    const pm = w.percept(g, ming, '下次见到阿杰跟他说我还钱了');
    assert.equal(intend(null, pm, { target: owner, act: '转告', origin: 'self-care', evidence: [pm] }), null);
    // 她答应过的（证据里有她的话）→ 形成
    const ps = w.percept(g, 'self', '好，见到他我跟他说');
    assert.ok(intend(null, pm, { target: owner, act: '转告', text: '跟阿杰说阿明还钱了', origin: 'self-commitment', evidence: [pm, ps] }));
    // 主人要求的
    const po = w.percept(dm, owner, '明天提醒我交电费', { addressed: 'to-her' });
    assert.ok(intend(null, po, { act: '提醒', text: '提醒交电费', origin: 'principal-request', evidence: [po] }));
    assert.equal(intend(null, pm, { act: '提醒', text: 'x', origin: 'principal-request', evidence: [pm] }), null, '冒称主人要求');
    // 核实只对有权限的人
    assert.equal(intend(null, pm, { target: ming, act: 'verify', text: 'x', evidence: [pm] }), null);
    // 每人每天自动形成的上限（不算主人要求的）
    for (let i = 0; i < 6; i++) {
      const { plan: pid, p: pp } = plan(`第${i}件事`, { factText: `阿杰的第${i}件事` });
      intend(pid, pp, { act: `问${i}` });
    }
    const today = w.intentions().filter((r) => r.target_entity_id === owner && r.origin !== 'principal-request');
    assert.equal(today.length, 4);
    assert.ok(w.core.store.get("SELECT value FROM metrics WHERE name = 'encode.intention.capped'").value >= 1);
  } finally { await w.cleanup(); }
});

test('transitionIntention：formed → armed → executed / cancelled / obsolete / lapsed；结束了的不再变；lapsed 写一条只有她知道的低强度情节', async () => {
  const { w, enc, plan, intend } = await setup();
  try {
    const { plan: id, p } = plan();
    const later = w.clock.now() + 2 * HOUR;
    const t = intend(id, p, { window: { start: later, end: later + 6 * HOUR } });
    assert.equal(w.intentions()[0].state, 'formed', '还没到时间窗');
    enc.transitionIntention(w.core, t, 'armed', { at: later });
    assert.equal(w.intentions()[0].armed_at, later);
    enc.transitionIntention(w.core, t, 'lapsed', { at: later + 7 * HOUR });
    assert.equal(w.intentions()[0].state, 'lapsed');
    enc.transitionIntention(w.core, t, 'armed', { at: later + 8 * HOUR });
    assert.equal(w.intentions()[0].state, 'lapsed', '结束了的意图不再变');
    const ep = w.episodes().find((e) => e.ep_kind === 'lapse');
    assert.ok(ep);
    assert.match(ep.narrative, /那阵子想晚点问问他快递拿到没，没顾上/);
    assert.equal(w.callsOf('addTrace').find((c) => c.ref === `e${ep.id}`).w, 0.3);
    assert.equal(w.callsOf('recordKnowledge').filter((c) => c.ref === `e${ep.id}`).length, 0, '只有她自己知道');
    assert.equal(w.callsOf('writeNorm').find((c) => c.ref === `e${ep.id}`).norm.originExposure.visibleTo, 'her-only');
    assert.throws(() => enc.transitionIntention(w.core, 999, 'armed', { at: 1 }));
  } finally { await w.cleanup(); }
});

test('recordExecution 以人为单位：问过之后对同一个人冷却 48 小时，不管哪个场合；dueIntentions 只给 armed、对象在场或线索命中的', async () => {
  const { w, owner, ming, dm, g, enc, plan, intend } = await setup();
  try {
    const { plan: id, p } = plan();
    const t1 = intend(id, p);
    const { plan: id2, p: p2 } = plan('我下周考驾照', { factText: '阿杰下周考驾照' });
    const t2 = intend(id2, p2, { act: '祝福', text: '祝他考试顺利' });
    const at = w.clock.now();
    let due = enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: dm.key, at });
    assert.deepEqual(due.map((d) => d.id).sort(), [t1, t2]);
    assert.equal(due[0].ref, `t${due[0].id}`);
    assert.deepEqual(enc.dueIntentions(w.core, { presentEntityIds: [ming], settingKey: g.key, at }), [], '对象不在场、也没有线索');
    assert.equal(enc.dueIntentions(w.core, { presentEntityIds: [ming], settingKey: g.key, at, cueEntityIds: [owner] }).length, 2, '话题线索命中也算');
    // 在私聊问过（执行了第一个）→ 对同一个人，另一个意图在群里也要等冷却
    enc.recordExecution(w.core, t1, { at, settingKey: dm.key, targetEntityId: owner, utteranceRef: 'p99' });
    const row = w.core.store.get('SELECT * FROM intentions WHERE id = ?', t1);
    assert.equal(row.state, 'executed');
    assert.deepEqual(JSON.parse(row.executions_json), [{ at, settingKey: dm.key, targetEntityId: owner, utteranceRef: 'p99' }]);
    assert.deepEqual(enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: g.key, at: at + HOUR }), []);
    assert.deepEqual(enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: g.key, at: at + 49 * HOUR }).map((d) => d.id), [t2]);
    // 时间窗过了的不再浮上来；场合属性条件（「下次和主人一对一时」）
    const pv = w.percept(g, ming, '主人说你可以告诉大家');
    const t3 = enc.formIntention(w.core, { about: null, targetEntityId: owner, act: 'verify', text: '核实一下', origin: 'self-care',
      trigger: { timeWindow: null, cues: [{ entity: owner }, { settingAttrs: { maxExposureRank: 0 } }] }, evidencePerceptIds: [pv] }, { at });
    assert.ok(t3);
    const later = at + 60 * HOUR;
    assert.ok(enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: dm.key, at: later }).some((d) => d.id === t3), '一对一时浮上来');
    assert.ok(!enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: g.key, at: later }).some((d) => d.id === t3), '群里不浮上来');
    // 过了时间窗的不再一刀切掉（D103）：照样到点，只是平滑减分、排在没超时的后面
    const t4 = intend(id2, p2, { act: '问问', text: 'x', window: { start: at - 2 * HOUR, end: at - HOUR } });
    const late = enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: dm.key, at: later });
    const d4 = late.find((d) => d.id === t4);
    assert.ok(d4, '过了 window_end 仍然到点');
    assert.ok(d4.overdue > 0, '只是减分');
    assert.ok(late.findIndex((d) => d.id === t4) > late.findIndex((d) => d.id === t3), '超时的排在没超时的后面');
    const d4b = enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: dm.key, at: later + 100 * HOUR }).find((d) => d.id === t4);
    assert.ok(d4b.overdue > d4.overdue, '超时越久减得越多（平滑的，不是到点就没）');
  } finally { await w.cleanup(); }
});

test('dueIntentions（D103）：主人要她做的事不受冷却限制；新形成的排在前面；过了时间窗只减分', async () => {
  const { w, owner, dm, enc, plan, intend } = await setup();
  try {
    const { plan: a1, p: pa1 } = plan('我说一个数字你就回复乘2');
    const at = w.clock.now();
    const old = intend(a1, pa1, { act: '配合', text: '按乘2回复', origin: 'principal-request', window: { start: at, end: at + HOUR } });
    w.clock.minutes(10);
    const { plan: a2, p: pa2 } = plan('改成乘3');
    const now = w.clock.now();
    const neu = intend(a2, pa2, { act: '配合', text: '按乘3回复', origin: 'principal-request', window: { start: now, end: now + HOUR } });
    assert.ok(old && neu);
    // 对同一个人刚执行过别的意图：她自己找话说的要冷却，主人要她做的不受影响
    const { plan: a3, p: pa3 } = plan('等下去拿快递');
    const own = intend(a3, pa3);
    enc.recordExecution(w.core, own, { at: now, settingKey: dm.key, targetEntityId: owner, utteranceRef: 'p1' });
    const due = enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: dm.key, at: now + 5 * 60_000 });
    assert.deepEqual(due.map((d) => d.id), [neu, old], '新的在前；冷却不挡主人要她做的事');
    // 两个小时以后：都过了时间窗，照样在，只是带着 overdue
    const later = enc.dueIntentions(w.core, { presentEntityIds: [owner], settingKey: dm.key, at: now + 3 * HOUR });
    assert.deepEqual(later.map((d) => d.id).sort(), [neu, old].sort());
    assert.ok(later.every((d) => d.overdue > 0));
  } finally { await w.cleanup(); }
});

test('recheckIntention：意图形成以来还没提炼的话里有可能的完成证据（词法、向量、旁听到当事人说的）→ 先压住，并把它们的提炼提到最前', async () => {
  const { w, owner, ming, dm, g, enc, plan, intend } = await setup();
  try {
    const { plan: id, p } = plan();
    const t = intend(id, p);
    w.clock.minutes(30);
    assert.deepEqual(await enc.recheckIntention(w.core, t), { suppress: false, perceptIds: [] }, '没有新的话');
    // 对她说的、和这件事无关的话：不压
    w.percept(dm, owner, '早', { addressed: 'to-her' });
    assert.equal((await enc.recheckIntention(w.core, t)).suppress, false);
    // 第三方在群里说「阿杰的快递到了」：词法命中（共同词够多）
    const p3 = w.percept(g, ming, '阿杰的快递拿到了');
    const r = await enc.recheckIntention(w.core, t);
    assert.equal(r.suppress, true);
    assert.deepEqual(r.perceptIds, [p3]);
    const boosted = w.jobs().filter((j) => j.priority >= 1_000_000);
    assert.ok(boosted.some((j) => JSON.parse(j.payload_json).perceptIds.includes(p3)), '这批感知的提炼提到最前');
    assert.equal(JSON.parse(boosted[0].payload_json).boundaryCertain, true);
    // 提炼过了的（提炼已经判过）不再拿来压
    w.core.store.run('UPDATE percepts SET episode_id = 1 WHERE id = ?', p3);
    assert.equal((await enc.recheckIntention(w.core, t)).suppress, false);
    // 结束了的意图不复核
    enc.transitionIntention(w.core, t, 'cancelled', { at: w.clock.now() });
    assert.equal((await enc.recheckIntention(w.core, t)).suppress, false);
  } finally { await w.cleanup(); }
});

test('recheckIntention：换个说法也认得出（原文窗口的向量）；嵌入挂了只靠词法和当事人的话；出错不抛', async () => {
  // 字符 n-gram 的替身向量比真模型的余弦低得多：阈值按替身调低，测的是「向量路能认出换说法」这个机制
  const w = await makeWorld({
    ports: (await import('../fakes/ports.js')).fakePorts({ embedding: new (await import('../fakes/embedding.js')).FakeEmbedding({ synonyms: [['快递', '包裹'], ['拿', '取']] }) }),
    extraConfig: { intention: { recheckCos: 0.35 } },
  });
  try {
    const owner = w.entity('阿杰', { closeness: 1, authority: 'principal' });
    const ming = w.entity('阿明');
    const dm = w.setting('私聊', { exposure: 0 });
    const g = w.setting('群', { exposure: 2 });
    const enc = w.core.mods.encode;
    const p = w.percept(dm, owner, '等下去拿快递', { addressed: 'to-her' });
    const id = enc.writeAssertion(w.core, { subjects: [owner], predicate: '取快递', text: '阿杰要去拿快递', kindHint: 'plan', certainty: 'stated', confidence: 0.9, imp: 3,
      plannedTime: { start: w.clock.now(), end: w.clock.now() + 3 * HOUR }, plan: { agent: owner, status: 'planned' },
      sources: [{ perceptId: p, speaker: owner, asserter: owner, mode: 'told_to_her', hop: 0, confidence: 0.9, at: w.clock.now() }], norm: {}, w: 1 });
    const t = enc.formIntention(w.core, { about: { kind: 'assertion', id }, targetEntityId: owner, act: '追问', text: '问问他快递拿到没', origin: 'self-care',
      trigger: { cues: [{ entity: owner }] }, evidencePerceptIds: [p] }, { at: w.clock.now() });
    w.clock.minutes(20);
    const q = w.percept(g, ming, '他的包裹取到了', { attention: 'attended' });
    w.rawWindow(g, [q]);
    const r = await enc.recheckIntention(w.core, t);
    assert.equal(r.suppress, true);
    assert.deepEqual(r.perceptIds, [q]);
    w.state.embedDown = true;
    w.core.store.run('UPDATE percepts SET episode_id = 1 WHERE id = ?', q);
    assert.equal((await enc.recheckIntention(w.core, t)).suppress, false);
  } finally { await w.cleanup(); }
  const bad = await makeWorld({ mods: { lang: { queryTerms: () => { throw new Error('boom'); } }, worker: { embedQuery: async () => { throw new Error('x'); } } } });
  try {
    const o = bad.entity('阿杰', { authority: 'principal', closeness: 1 });
    const dm = bad.setting('私聊', { exposure: 0 });
    const p = bad.percept(dm, o, '等下去拿快递', { addressed: 'to-her' });
    const t = bad.core.mods.encode.formIntention(bad.core, { about: null, targetEntityId: o, act: '提醒', text: 'x', origin: 'principal-request', trigger: {}, evidencePerceptIds: [p] }, { at: bad.clock.now() });
    bad.core.store.run("UPDATE intentions SET formed_at = formed_at - 1");
    const r = await bad.core.mods.encode.recheckIntention(bad.core, t);
    assert.equal(typeof r.suppress, 'boolean');
  } finally { await bad.cleanup(); }
});
