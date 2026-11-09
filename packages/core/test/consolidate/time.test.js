// 时间维护（§7.7 第 6 步）和「回头问问」（§5.5 第 5 条，S2 的 consolidate 部分）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, reply, T0, MIN, HOUR, DAY } from './world.js';
import { FakeLLM } from '../fakes/index.js';
import { planDeadline, followUpUnknownPlans } from '../../src/consolidate/time.js';
import { newRun } from '../../src/consolidate/util.js';

test('planDeadline：有结束时间按结束 + 1 小时；只有开始按开始 + 宽限；都没有按记录时间 + t50', () => {
  assert.equal(planDeadline({ planned_time_json: JSON.stringify({ start: 1000, end: 5000 }), recorded_at: 0 }, 6), 5000 + HOUR);
  assert.equal(planDeadline({ planned_time_json: JSON.stringify({ start: 1000 }), recorded_at: 0 }, 6), 1000 + 6 * HOUR);
  assert.equal(planDeadline({ planned_time_json: null, event_start: 2000, recorded_at: 0 }, 2), 2000 + 2 * HOUR);
  assert.equal(planDeadline({ planned_time_json: null, recorded_at: 100, t50_h: 3 }, 6), 100 + 3 * HOUR);
  assert.equal(planDeadline({ planned_time_json: '坏的 json', recorded_at: 100 }, 6), 100 + 24 * HOUR);
});

test('timeMaintenance：过了时间窗没下文的计划 → unknown（不删、不断言）；没到的不动；已经有结果的不动', async () => {
  const w = await world();
  try {
    const { core } = w;
    const owner = w.entity({ name: '主人', authority: 'principal', closeness: 1 });
    const past = w.fact({ subjects: [owner], text: '主人 10/31 晚上去拿快递', kindHint: 'plan', plan: { agent: owner, status: 'planned' }, plannedTime: { start: T0, end: T0 + 2 * HOUR } });
    const future = w.fact({ subjects: [owner], text: '主人周六去爬山', kindHint: 'plan', plan: { agent: owner, status: 'planned' }, plannedTime: { start: T0 + 3 * DAY } });
    const done = w.fact({ subjects: [owner], text: '主人去理发', kindHint: 'plan', plan: { agent: owner, status: 'done' }, plannedTime: { start: T0 - DAY } });
    const r = core.mods.consolidate.timeMaintenance(core, T0 + 4 * HOUR);
    assert.equal(r.plansUnknown, 1);
    assert.deepEqual(w.rec.transitionPlan.map((x) => [x.id, x.status]), [[past.id, 'unknown']]);
    assert.equal(core.store.get('SELECT plan_status FROM assertions WHERE id = ?', future.id).plan_status, 'planned');
    assert.equal(core.store.get('SELECT plan_status FROM assertions WHERE id = ?', done.id).plan_status, 'done');
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM assertions').n, 3, '什么都不删');
    assert.deepEqual(w.rec.expireReviews, [T0 + 4 * HOUR], '挂起的发言过期交给 admin');
  } finally { await w.cleanup(); }
});

test('timeMaintenance：意图到了时间窗 armed；过了时间窗不是马上作废（D103），淡到 lapseBelowA 以下才 lapsed（先放下淡了的）；一条出错不影响别的', async () => {
  let fails = 0;
  const w = await world({ mods: { encode: { transitionIntention: (c, id, state, ctx) => {
    if (id === 3) { fails += 1; throw new Error('boom'); }
    c.store.run('UPDATE intentions SET state = ? WHERE id = ?', state, id);
  } } } });
  try {
    const { core } = w;
    const p = w.entity({ name: '甲' });
    const mk = (formed, start, end) => core.store.run(`INSERT INTO intentions(target_entity_id, act, origin, state, formed_at, window_start, window_end, created_at, updated_at)
        VALUES (?, '追问', 'self-care', 'formed', ?, ?, ?, ?, ?)`, p, formed, start, end, formed, formed);
    mk(T0 - 2 * HOUR, T0 - HOUR, T0 + DAY);          // 1：到时间窗了
    mk(T0, T0 + DAY, T0 + 2 * DAY);                  // 2：还没到
    mk(T0 - 30 * DAY, T0 - 30 * DAY, T0 - 29 * DAY);  // 3：一个月前的、早就淡了（出错）
    mk(T0, null, null);                              // 4：没有时间窗 → 立刻 armed
    mk(T0 - 30 * DAY, T0 - 30 * DAY, T0 - 29 * DAY);  // 5：一个月前的、早就淡了 → 放下
    mk(T0 - 2 * HOUR, T0 - 2 * HOUR, T0 - HOUR);      // 6：窗口一小时前刚过 → 不作废，照样开着
    const r = core.mods.consolidate.timeMaintenance(core, T0);
    assert.equal(r.intentionsArmed, 2);
    assert.equal(r.intentionsLapsed, 1);
    assert.equal(r.errors, 1);
    assert.equal(fails, 1);
    const st = Object.fromEntries(core.store.all('SELECT id, state FROM intentions').map((x) => [x.id, x.state]));
    assert.deepEqual(st, { 1: 'armed', 2: 'formed', 3: 'formed', 4: 'armed', 5: 'lapsed', 6: 'formed' });
  } finally { await w.cleanup(); }
});

test('timeMaintenance（D103）：主人要她做的事，他一直在跟她说话就淡得慢；同样过了时间窗、早就没人提的先放下', async () => {
  const w = await world();
  try {
    const { core } = w;
    const owner = w.entity({ name: '主人', authority: 'principal', closeness: 1 });
    const mk = (origin) => Number(core.store.run(`INSERT INTO intentions(target_entity_id, act, origin, state, formed_at, window_start, window_end, created_at, updated_at)
        VALUES (?, '配合', ?, 'armed', ?, ?, ?, ?, ?)`, owner, origin, T0 - 2 * DAY, T0 - 2 * DAY, T0 - 2 * DAY + 40 * MIN, T0 - 2 * DAY, T0 - 2 * DAY).lastInsertRowid);
    const asked = mk('principal-request');
    const own = mk('self-care');
    // 主人刚刚还在对她说话
    w.percept(w.setting(), { at: T0 - MIN, actor: owner, text: '7', addressed: 'mentions-her' });
    core.mods.consolidate.timeMaintenance(core, T0);
    const st = (id) => core.store.get('SELECT state FROM intentions WHERE id = ?', id).state;
    assert.equal(st(asked), 'armed', '他一直在跟她说话：还开着');
    assert.equal(st(own), 'lapsed', '她自己想着的、两天前四十分钟的事：已经淡了，放下');
  } finally { await w.cleanup(); }
});

test('回头问问：模型按关系和分量判断；代码只核验（具体的人、不是她自己、没有挂着的意图、不是回填的）', async () => {
  const llm = new FakeLLM({ script: { sleep: [reply((req, text) => {
    assert.ok(text.includes('你最亲近的人'), '主人只按属性标注');
    assert.ok(!text.includes('去散步'), '她自己的计划不问');
    return [
      { type: 'followup', plan: 'q1', form: true, act: '追问', text: '问问快递后来拿到没' },
      { type: 'followup', plan: 'q2', form: false },
    ];
  })] } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const owner = w.entity({ name: '主人', authority: 'principal', closeness: 1 });
    const stranger = w.entity({ name: '路人', closeness: 0.05 });
    const club = w.entity({ name: '读书会', kind: 'group' });
    const S = w.setting({ exposure: 0 });
    const mk = (agent, text, extra = {}) => {
      const pid = w.percept(S, { at: T0, actor: agent === w.self ? null : agent, self: agent === w.self, text, historical: !!extra.historical });
      const f = w.fact({ subjects: [agent], text, kindHint: 'plan', plan: { agent, status: 'planned' }, plannedTime: { start: T0 },
        sources: [{ perceptId: pid, speaker: agent, mode: 'told_to_her', at: T0 }] });
      return f.id;
    };
    const a1 = mk(owner, '主人等下去拿快递');
    const a2 = mk(stranger, '路人明天去买菜');
    mk(w.self, '我晚上去散步');
    mk(club, '读书会周末聚会');
    mk(owner, '主人以前说过去看牙', { historical: true });
    const a6 = mk(owner, '主人要交报告');
    core.store.run(`INSERT INTO intentions(about_kind, about_id, target_entity_id, act, origin, state, formed_at, created_at, updated_at)
        VALUES ('assertion', ?, ?, '追问', 'self-care', 'armed', ?, ?, ?)`, a6, owner, T0, T0, T0);
    core.mods.consolidate.timeMaintenance(core, T0 + DAY);
    const r = await followUpUnknownPlans(core, { run: newRun(5), at: T0 + DAY + HOUR });
    assert.deepEqual(r, { considered: 2, formed: 1 });
    const [f] = w.rec.formIntention;
    assert.deepEqual(f.p.about, { kind: 'assertion', id: a1 });
    assert.equal(f.p.targetEntityId, owner);
    assert.equal(f.p.origin, 'self-care', '围绕对方自己的计划');
    assert.equal(f.p.trigger.timeWindow.end - f.p.trigger.timeWindow.start, 72 * HOUR);
    assert.equal(f.p.evidencePerceptIds.length, 1);
    assert.ok(a2);
    // 处理过的不再问
    const again = await followUpUnknownPlans(core, { run: newRun(5), at: T0 + DAY + 2 * HOUR });
    assert.deepEqual(again, { considered: 0, formed: 0 });
    assert.equal(llm.callsFor('sleep').length, 1);
  } finally { await w.cleanup(); }
});

test('回头问问：到了 LLM 上限就顺延（水位线不推进，下一晚接着问）', async () => {
  const llm = new FakeLLM({ fallback: { sleep: [] } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const owner = w.entity({ name: '主人', authority: 'principal', closeness: 1 });
    w.fact({ subjects: [owner], text: '主人等下去拿快递', kindHint: 'plan', plan: { agent: owner, status: 'planned' }, plannedTime: { start: T0 } });
    core.mods.consolidate.timeMaintenance(core, T0 + DAY);
    const r = await followUpUnknownPlans(core, { run: { calls: 3, max: 3 }, at: T0 + DAY + MIN });
    assert.equal(r.skipped, 'llm-cap');
    const r2 = await followUpUnknownPlans(core, { run: newRun(3), at: T0 + 2 * DAY });
    assert.equal(r2.considered, 1);
  } finally { await w.cleanup(); }
});
