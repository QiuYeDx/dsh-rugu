// taintCheck（§7.3 污点检查，纯代码）和 reconcile（§7.5、§5.4 的更新规则，评审:SC-01）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, DAY, HOUR } from './harness.js';

test('taintCheck：区分性词进了叙述就去掉那一句（标题也清掉）；事实里出现却没记 used_bg 的补记；不靠模型自报', async () => {
  const w = await makeWorld();
  try {
    const lines = [
      { type: 'header', title: '聊小美的23000', text: '阿明聊表哥。表哥欠小美23000块。' },
      { type: 'narrative', text: '阿明说表哥开网约车！听说欠了23000？还挺多' },
      { type: 'fact', id: 'f1', text: '表哥欠了23000块', used_bg: [] },
      { type: 'fact', id: 'f2', text: '表哥欠小美的钱', used_bg: ['p1'] },
      { type: 'fact', id: 'f3', text: '表哥开网约车' },
      { type: 'fact', id: 'f4', text: '编号123000不是那个数' },
    ];
    const out = w.core.mods.encode.taintCheck(w.core, lines, [{ ref: 'a9', code: 'p1', text: '阿明私下说表哥欠小美23000块', terms: ['23000', '小美'] }]);
    assert.equal(out[0].text, '阿明聊表哥。');
    assert.equal(out[0].title, '');
    assert.equal(out[0].tainted, true);
    assert.equal(out[1].text, '阿明说表哥开网约车！还挺多');
    assert.deepEqual(out[2].used_bg, ['p1']);
    assert.equal(out[2].tainted, true);
    assert.equal(out[3].tainted, undefined, '已经自报了的不改');
    assert.equal(out[4].tainted, undefined);
    assert.equal(out[5].tainted, undefined, '数字按整词比，123000 不算 23000');
    assert.notEqual(out, lines);
    assert.equal(lines[0].text, '阿明聊表哥。表哥欠小美23000块。', '不改输入');
    // 没给 terms：按 lang.distinctiveTerms 现算（不给 idf 时只有数字和名字）
    const out2 = w.core.mods.encode.taintCheck(w.core, [{ type: 'narrative', text: '他欠了4500。' }], [{ ref: 'a1', text: '欠款4500' }]);
    assert.equal(out2[0].text, '');
    // 没有私下背景：原样
    assert.deepEqual(w.core.mods.encode.taintCheck(w.core, lines, []), lines);
  } finally { await w.cleanup(); }
});

/** 写一条事实（直接走 writeAssertion）。 */
function put(w, o) {
  return w.core.mods.encode.writeAssertion(w.core, {
    subjects: o.subjects, predicate: o.predicate ?? '职业', text: o.text, kindHint: o.kind ?? 'state', certainty: o.certainty ?? 'stated', confidence: 0.8, imp: 5,
    eventTime: o.eventTime ?? null, plannedTime: o.plannedTime ?? null, validFrom: o.validFrom ?? null, plan: o.plan ?? null,
    sources: [{ perceptId: null, speaker: o.subjects[0], asserter: o.subjects[0], mode: 'told_to_her', hop: 0, confidence: 0.8, at: o.at ?? w.clock.now() }],
    norm: {}, w: 1,
  });
}

test('reconcile 快速路径：同主体、同属性、规范化后文本相同 → dup；不同属性或不同主体不是重复', async () => {
  const w = await makeWorld();
  try {
    const a = w.entity('阿明');
    const b = w.entity('小刚');
    const id = put(w, { subjects: [a], text: '阿明是程序员。' });
    const rc = (f) => w.core.mods.encode.reconcile(w.core, { kindHint: 'state', certainty: 'stated', ...f }, { at: w.clock.now() });
    assert.deepEqual(await rc({ subjects: [a], predicate: '职业', text: '阿明是程序员' }), { op: 'dup', targetId: id });
    assert.equal((await rc({ subjects: [b], predicate: '职业', text: '阿明是程序员' })).op, 'new');
    assert.equal((await rc({ subjects: [a], predicate: '爱好', text: '阿明是程序员' })).op, 'new');
    // 同义写法的属性键（「职 业」）也在同一个家族里
    assert.equal((await rc({ subjects: [a], predicate: '职 业', text: '阿明是程序员' })).op, 'dup');
  } finally { await w.cleanup(); }
});

test('reconcile 发生次（评审:SC-01）：计划和事件永远不走快速路径；不同时间窗是同一类事的另一次（occurrence），模型说 dup 也不合并；同一时间窗才是重复', async () => {
  const w = await makeWorld();
  try {
    const o = w.entity('阿杰', { closeness: 1, authority: 'principal' });
    const lastWeek = w.clock.now() - 7 * DAY;
    const win1 = { start: lastWeek, end: lastWeek + 3 * HOUR, precision: 'fuzzy' };
    const old = put(w, { subjects: [o], predicate: '取快递', text: '阿杰要去拿快递', kind: 'plan', plannedTime: win1, plan: { agent: o, status: 'done' }, at: lastWeek });
    const win2 = { start: w.clock.now(), end: w.clock.now() + 3 * HOUR, precision: 'fuzzy' };
    const fact = { subjects: [o], predicate: '取快递', text: '阿杰要去拿快递', kindHint: 'plan', certainty: 'stated', plannedTime: win2, plan: { agent: o } };
    const rc = (f) => w.core.mods.encode.reconcile(w.core, f, { at: w.clock.now() });
    assert.deepEqual(await rc(fact), { op: 'occurrence', targetId: old }, '文本一模一样也不是重复');
    assert.deepEqual(await rc({ ...fact, op: 'dup', opTargetId: old }), { op: 'occurrence', targetId: old }, '模型说是重复也不行：时间窗不同');
    // 同一个时间窗、同一件事：重复
    assert.deepEqual(await rc({ ...fact, plannedTime: win1, op: 'dup', opTargetId: old }), { op: 'dup', targetId: old });
    assert.deepEqual(await rc({ ...fact, plannedTime: win1 }), { op: 'dup', targetId: old });
  } finally { await w.cleanup(); }
});

test('reconcile 更新规则：矛盾 → 取代；信任度低的不能取代信任度高的；迟到的旧消息失效的是它自己；变了未知不看两边的种类', async () => {
  const w = await makeWorld();
  try {
    const a = w.entity('阿明');
    const t0 = w.clock.now() - 10 * DAY;
    const old = put(w, { subjects: [a], text: '阿明开网约车', validFrom: t0, at: t0 });
    const rc = (f) => w.core.mods.encode.reconcile(w.core, { subjects: [a], predicate: '职业', kindHint: 'state', ...f }, { at: w.clock.now() });
    assert.deepEqual(await rc({ text: '阿明送外卖了', certainty: 'stated', validFrom: w.clock.now(), op: 'contradict', opTargetId: old }), { op: 'contradict', targetId: old });
    const r = await rc({ text: '阿明送外卖了', certainty: 'hearsay', validFrom: w.clock.now(), op: 'contradict', opTargetId: old });
    assert.equal(r.op, 'new', '听说的不能取代本人说的，两种说法都留着');
    assert.equal(r.coexist, old);
    assert.deepEqual(await rc({ text: '阿明以前是厨师', certainty: 'stated', validFrom: t0 - 100 * DAY, op: 'contradict', opTargetId: old }), { op: 'late', targetId: old });
    assert.deepEqual(await rc({ text: '阿明换工作了', kindHint: 'event', certainty: 'stated', eventTime: { start: w.clock.now(), end: w.clock.now() }, op: 'changed', opTargetId: old }),
      { op: 'changed', targetId: old }, '「换工作了」本身是一件事，但它说的是旧事实变了');
  } finally { await w.cleanup(); }
});

test('reconcile 中间地带：单值属性又来一个值、或文字相近 → 先新增并标 needsReconcile；无关的直接新增；嵌入挂了照样能对账', async () => {
  const w = await makeWorld();
  try {
    const a = w.entity('阿明');
    put(w, { subjects: [a], predicate: '所在城市', text: '阿明住在杭州' });
    const rc = (f) => w.core.mods.encode.reconcile(w.core, { subjects: [a], kindHint: 'state', certainty: 'stated', ...f }, { at: w.clock.now() });
    assert.deepEqual(await rc({ predicate: '所在城市', text: '阿明搬到上海了' }), { op: 'new', needsReconcile: true });
    assert.deepEqual(await rc({ predicate: '宠物', text: '阿明养了一只猫' }), { op: 'new' });
    w.state.embedDown = true;
    assert.deepEqual(await rc({ predicate: '所在城市', text: '阿明住在杭州西湖边' }), { op: 'new', needsReconcile: true });
  } finally { await w.cleanup(); }
});

test('reconcile：她自己的看法，新看法取代旧看法（§5.7）', async () => {
  const w = await makeWorld();
  try {
    const cat = w.entity('猫', { kind: 'animal', identity: false });
    const old = w.core.mods.encode.writeAssertion(w.core, { subjects: [cat], predicate: '她的看法', text: '我觉得猫有点吓人', kindHint: 'opinion', certainty: 'self_said', confidence: 0.9, imp: 5,
      sources: [{ perceptId: null, speaker: w.self, asserter: w.self, mode: 'self_generated', hop: 0, confidence: 0.9, at: w.clock.now() - DAY }], norm: {}, w: 1 });
    const r = await w.core.mods.encode.reconcile(w.core, { subjects: [cat], predicate: '她的看法', text: '我现在挺喜欢猫的', kindHint: 'opinion', certainty: 'self_said', validFrom: w.clock.now() }, { at: w.clock.now() });
    assert.deepEqual(r, { op: 'contradict', targetId: old });
  } finally { await w.cleanup(); }
});
