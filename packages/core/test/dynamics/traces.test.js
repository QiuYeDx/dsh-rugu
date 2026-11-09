// dynamics 的痕迹规则和 §6.4 / §14.2「动力学」的不变式（全部要有单元测试，docs/实现/模块与接口.md §4.5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCore, insertEntity, insertImpression, insertAssertion, insertPercept, insertIntention, askedP, H, D, M, T0 } from './helpers.js';

const a = (id) => ({ kind: 'assertion', id });
const rows = (core, ref) => core.store.all('SELECT t, w, d, source_key, reason FROM traces WHERE owner_kind = ? AND owner_id = ? ORDER BY t', ref.kind, ref.id);
const act = (core, ref) => core.store.get('SELECT * FROM activation WHERE owner_kind = ? AND owner_id = ?', ref.kind, ref.id);
const add = (core, ref, t, w = 1, sourceKey = '', reason = 'mention') => core.mods.dynamics.addTrace(core, ref, { t, w, sourceKey, reason });

test('addTrace：第一条 d = a，之后 d 由写入前的激活决定；traceState / baseActivation 读回来', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.deepEqual(add(core, a(1), T0, 1, 's1', 'encode'), { added: true });
  assert.deepEqual(add(core, a(1), T0 + 2 * D, 0.8, 's2'), { added: true });
  const r = rows(core, a(1));
  assert.equal(r.length, 2);
  assert.equal(r[0].d, core.config.get().activation.a);
  const P = { ageFloorMin: 3, timeUnitMs: H };
  const m1 = dyn.baseActivationOf({ traces: [{ t: T0, w: 1, d: 0.3 }], agg: { n: 0, w: 0, first: null, last: null, d: null } }, T0 + 2 * D, P);
  assert.ok(Math.abs(r[1].d - (0.3 + 0.3 * Math.exp(m1))) < 1e-12);
  const st = dyn.traceState(core, a(1));
  assert.equal(st.traces.length, 2);
  assert.equal(dyn.baseActivation(core, a(1), T0 + 10 * D), dyn.baseActivationOf(st, T0 + 10 * D, P));
  assert.equal(act(core, a(1)).trace_count, 2);
  assert.equal(act(core, a(1)).last_trace_at, T0 + 2 * D);
}));

test('只被召回、注入、对同一批人复述、导入、压缩摘要不加痕迹：每天都注入的记忆和从未注入的曲线完全一样', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  add(core, a(1), T0, 1, 'x', 'encode');
  add(core, a(2), T0, 1, 'x', 'encode');
  for (let day = 1; day <= 30; day++) {
    for (const reason of ['injected', 'recalled', 'retold-same-audience', 'import', 'compaction', 'used', '']) {
      assert.deepEqual(dyn.addTrace(core, a(1), { t: T0 + day * D, w: 1, sourceKey: `s${day}`, reason }), { added: false, why: 'not-counted' });
    }
  }
  for (const at of [T0 + D, T0 + 31 * D, T0 + 365 * D]) assert.equal(dyn.baseActivation(core, a(1), at), dyn.baseActivation(core, a(2), at));
  assert.equal(rows(core, a(1)).length, 1);
}));

test('来源窗口：同一条记忆每个 6 小时格最多一条；同一来源同一天最多一条', () => withCore((core) => {
  // 同一格（本地 00:00–06:00）
  assert.equal(add(core, a(1), T0, 1, 's1').added, true);
  assert.deepEqual(add(core, a(1), T0 + 1 * H, 1, 's2'), { added: false, why: 'memory-window' });
  // 下一格、同一来源、同一天
  assert.deepEqual(add(core, a(1), T0 + 7 * H, 1, 's1'), { added: false, why: 'source-window' });
  // 下一格、别的来源
  assert.equal(add(core, a(1), T0 + 7 * H, 1, 's3').added, true);
  // 第二天，原来的来源又可以了
  assert.equal(add(core, a(1), T0 + D + 1 * H, 1, 's1').added, true);
  // 没有 sourceKey 的只受「同一条记忆」那条约束
  assert.equal(add(core, a(1), T0 + D + 13 * H, 1, '').added, true);
  assert.equal(rows(core, a(1)).length, 4);
}));

test('迟到的处理不改变结果：痕迹时间用证据时间，到达顺序、处理延迟都不影响 B', () => withCore((core, ports) => {
  const dyn = core.mods.dynamics;
  const events = [[T0, 's1'], [T0 + 3 * D, 's2'], [T0 + 10 * D, 's3'], [T0 + 10 * D + 2 * H, 's4'], [T0 + 30 * D, 's1']];
  for (const [t, s] of events) add(core, a(1), t, 1, s);
  // 乱序到达（而且处理时钟已经过了很久）
  ports.clock.days(40);
  for (const i of [3, 0, 4, 2, 1]) add(core, a(2), events[i][0], 1, events[i][1]);
  const ra = rows(core, a(1));
  const rb = rows(core, a(2));
  assert.deepEqual(rb.map((r) => [r.t, r.w, r.source_key]), ra.map((r) => [r.t, r.w, r.source_key]));
  rb.forEach((r, i) => assert.ok(Math.abs(r.d - ra[i].d) < 1e-12));
  for (const at of [T0 + 31 * D, T0 + 200 * D]) assert.ok(Math.abs(dyn.baseActivation(core, a(1), at) - dyn.baseActivation(core, a(2), at)) < 1e-12);
}));

test('同一格里最早的那次算数：更早的证据迟到了会顶替已记下的较晚那条（两种顺序结果相同）', () => withCore((core) => {
  add(core, a(1), T0 + 2 * H, 1, 's1');
  assert.equal(add(core, a(1), T0 + 1 * H, 0.7, 's2').added, true);   // 更早：顶替
  add(core, a(2), T0 + 1 * H, 0.7, 's2');
  assert.equal(add(core, a(2), T0 + 2 * H, 1, 's1').added, false);
  assert.deepEqual(rows(core, a(1)).map((r) => [r.t, r.w]), [[T0 + H, 0.7]]);
  assert.deepEqual(rows(core, a(2)).map((r) => [r.t, r.w]), [[T0 + H, 0.7]]);
  // 同一来源同一天：最早的那次算
  add(core, a(3), T0 + 13 * H, 1, 'src');
  assert.equal(add(core, a(3), T0 + 7 * H, 1, 'src').added, true);
  assert.deepEqual(rows(core, a(3)).map((r) => r.t), [T0 + 7 * H]);
}));

test('§6.4 的事件系数：确认 × 1.2、被问起 × 0.6、讲给新听众 0.3、夜间重放 0.2', () => withCore((core) => {
  const ev = core.config.get().activation.events;
  add(core, a(1), T0, 0.5, 'a', 'confirm');
  add(core, a(1), T0 + D, 0.5, 'b', 'asked');
  add(core, a(1), T0 + 2 * D, 0.9, 'c', 'retell');
  add(core, a(1), T0 + 3 * D, 0.9, 'd', 'replay');
  add(core, a(1), T0 + 4 * D, 0.5, 'e', 'reply');
  assert.deepEqual(rows(core, a(1)).map((r) => +r.w.toFixed(6)), [0.5 * ev.confirm, 0.5 * ev.askedAndRecalled, ev.retellNewAudience, ev.replay, 0.5].map((x) => +x.toFixed(6)));
}));

test('上限：夜间重放每条 ≤ 3 次、只给 30 天内的新记忆；讲给新听众每条 ≤ 5 次、每个听众一次', () => withCore((core) => {
  add(core, a(1), T0, 1, 'x', 'encode');
  for (let i = 1; i <= 3; i++) assert.equal(add(core, a(1), T0 + i * D, 1, `n${i}`, 'replay').added, true);
  assert.deepEqual(add(core, a(1), T0 + 4 * D, 1, 'n4', 'replay'), { added: false, why: 'cap' });
  add(core, a(2), T0, 1, 'x', 'encode');
  assert.deepEqual(add(core, a(2), T0 + 31 * D, 1, 'n', 'replay'), { added: false, why: 'too-old' });
  add(core, a(3), T0, 1, 'x', 'encode');
  assert.deepEqual(add(core, a(3), T0 + D, 1, 'listener-1', 'retell'), { added: true });
  assert.deepEqual(add(core, a(3), T0 + 2 * D, 1, 'listener-1', 'retell'), { added: false, why: 'source-window' });
  for (let i = 2; i <= 5; i++) assert.equal(add(core, a(3), T0 + i * 2 * D, 1, `listener-${i}`, 'retell').added, true);
  assert.deepEqual(add(core, a(3), T0 + 20 * D, 1, 'listener-6', 'retell'), { added: false, why: 'cap' });
  assert.equal(act(core, a(3)).retell_count, 5);
  assert.equal(act(core, a(1)).replay_count, 3);
}));

test('超过 K 条的旧痕迹并进聚合项：精确行 ≤ K，总条数照算，B 和全部精确时几乎一样', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const K = core.config.get().activation.exactTraces;
  for (let i = 0; i < 14; i++) add(core, a(1), T0 + i * 2 * D, 0.6 + (i % 3) * 0.2, `s${i}`);
  assert.equal(rows(core, a(1)).length, K);
  const row = act(core, a(1));
  assert.equal(row.agg_n, 14 - K);
  assert.equal(row.trace_count, 14);
  const exact = dyn.stateFromEvents(Array.from({ length: 14 }, (_, i) => ({ t: T0 + i * 2 * D, w: 0.6 + (i % 3) * 0.2 })),
    { a: 0.3, c: 0.3, dMax: 1, ageFloorMin: 3, timeUnitMs: H, exactTraces: 100 });
  for (const at of [T0 + 40 * D, T0 + 300 * D]) {
    assert.ok(Math.abs(dyn.baseActivation(core, a(1), at) - dyn.baseActivationOf(exact, at, { ageFloorMin: 3, timeUnitMs: H })) < 0.01);
  }
}));

test('impression 的痕迹跟随实体；percept 只编码一次；intention、link 不加痕迹', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const e = insertEntity(core, { name: '表哥' });
  const i = insertImpression(core, e);
  assert.equal(add(core, { kind: 'impression', id: i }, T0, 0.5, 's').added, true);
  assert.equal(rows(core, { kind: 'entity', id: e }).length, 1);
  assert.equal(dyn.baseActivation(core, { kind: 'impression', id: i }, T0 + D), dyn.baseActivation(core, { kind: 'entity', id: e }, T0 + D));
  assert.deepEqual(dyn.traceState(core, { kind: 'impression', id: i }), dyn.traceState(core, { kind: 'entity', id: e }));

  const p = insertPercept(core, { at: T0, wEnc: 0.35 });
  assert.deepEqual(add(core, { kind: 'percept', id: p }, T0, 1, 's'), { added: false, why: 'not-counted' });
  const want = dyn.perceptActivation(core, { w_enc: 0.35, at: T0 }, T0 + D);
  assert.equal(dyn.baseActivation(core, `p${p}`, T0 + D), want);
  assert.ok(Math.abs(want - (Math.log(0.35) - 0.3 * Math.log(24))) < 1e-12);
  assert.equal(dyn.traceState(core, { kind: 'percept', id: p }).traces[0].w, 0.35);

  const t = insertIntention(core, { at: T0 });
  assert.deepEqual(add(core, { kind: 'intention', id: t }, T0 + H, 1, 's'), { added: false, why: 'not-counted' });
  assert.ok(Number.isFinite(dyn.baseActivation(core, { kind: 'intention', id: t }, T0 + D)));   // 按形成那一刻她自己的一次
  assert.deepEqual(add(core, { kind: 'link', id: 1 }, T0, 1, 's'), { added: false, why: 'not-counted' });
  assert.equal(dyn.baseActivation(core, { kind: 'link', id: 1 }, T0), -Infinity);
  assert.equal(dyn.traceState(core, { kind: 'intention', id: t }), null);
}));

test('没有痕迹的记忆单元（导入的）按来源时间算一次低强度的编码，不是永远想不起来', () => withCore((core) => {
  const id = insertAssertion(core, { at: T0 });
  const B = core.mods.dynamics.baseActivation(core, a(id), T0 + 7 * D);
  assert.ok(Number.isFinite(B));
  assert.ok(Math.abs(B - (Math.log(0.35) - 0.3 * Math.log(7 * 24))) < 1e-12);
  assert.equal(core.mods.dynamics.baseActivation(core, a(999999), T0), -Infinity);   // 根本不存在
}));

test('新版本至少继承旧版本的激活；重复继承不重复计数；旧版本不变', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  for (const [i, t] of [0, 5, 12, 20].entries()) add(core, a(1), T0 + t * D, 1, `s${i}`);
  add(core, a(2), T0 + 21 * D, 1, 'fix', 'encode');
  const oldB = dyn.baseActivation(core, a(1), T0 + 60 * D);
  const before = rows(core, a(1));
  dyn.inheritActivation(core, a(1), a(2), { at: T0 + 21 * D });
  const newB = dyn.baseActivation(core, a(2), T0 + 60 * D);
  assert.ok(newB >= oldB, `${newB} ≥ ${oldB}`);
  assert.deepEqual(rows(core, a(1)), before);
  const n = rows(core, a(2)).length;
  dyn.inheritActivation(core, a(1), a(2), { at: T0 + 22 * D });
  assert.equal(rows(core, a(2)).length, n);
  assert.equal(dyn.baseActivation(core, a(2), T0 + 60 * D), newB);
  assert.deepEqual(JSON.parse(act(core, a(2)).inherited_json), ['a1']);
  assert.ok(rows(core, a(2)).some((r) => r.reason === 'inherit'));
}));

test('同样四次重复，隔开的比集中的记得牢（经过来源窗口的真实写入路径）', () => withCore((core) => {
  for (const [i, d] of [0, 3, 10, 30].entries()) add(core, a(1), T0 + d * D, 1, `s${i}`);
  for (let i = 0; i < 4; i++) add(core, a(2), T0 + i * 2 * M, 1, `s${i}`);   // 几分钟内四次：只算一次
  assert.equal(rows(core, a(2)).length, 1);
  for (const d of [31, 180, 365]) assert.ok(askedP(core, a(1), T0 + d * D) > askedP(core, a(2), T0 + d * D) + 0.05);
}));

test('一次直接对她说的听说，30 天后被问能答上的概率 ≥ 0.7（评审:UV-01，参数照 §6.9，S = +1.0，τ_del）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const { wAtt } = dyn.attentionClass(core, { kind: 'utterance', addressed: 'to-her', attention: 'attended' }, { herSpokeRecently: false });
  // 听说不进编码强度：只有注意力、社交相关、显著性、关系、情绪
  const w = dyn.encodingWeight(core, { wAtt, selfRelevance: core.config.get().activation.selfRelevance.social, closeness: 0.3 });
  add(core, a(1), T0, w, 'u3', 'encode');
  assert.ok(askedP(core, a(1), T0 + 30 * D) >= 0.7);
}));

test('有效性和可及性互不影响；被取代的旧版本仍能被问到（P_sup 是连续惩罚，不是过滤）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const id = insertAssertion(core, { at: T0, t50_h: 5, shape: 2 });
  const row = core.store.get('SELECT * FROM assertions WHERE id = ?', id);
  add(core, a(id), T0, 1, 's', 'encode');
  const hold = dyn.pHold(core, row, T0 + D);
  add(core, a(id), T0 + 2 * D, 1, 's2');
  assert.equal(dyn.pHold(core, row, T0 + D), hold);              // 加痕迹不改有效性
  assert.equal(dyn.tense(core, dyn.pHold(core, row, T0 + 7 * D)), 'past');
  assert.ok(askedP(core, a(id), T0 + 7 * D) > 0.9);               // 过去时了，照样想得起
  const cand = { ref: `a${id}`, mref: a(id), ranks: {}, rrf: 0, signals: {} };
  const [sup] = dyn.activate(core, [{ candidate: cand, S: 1, C: 0, superseded: true }], { at: T0 + 7 * D, mode: 'deliberate', seed: ['x'] });
  const [cur] = dyn.activate(core, [{ candidate: cand, S: 1, C: 0, superseded: false }], { at: T0 + 7 * D, mode: 'deliberate', seed: ['x'] });
  assert.ok(Math.abs(cur.A - sup.A - core.config.get().activation.supersededPenalty) < 1e-12);
  assert.ok(sup.P > 0.5, `被取代的旧版本 P = ${sup.P}`);
}));

test('retier：按基础激活分热 / 温 / 冷，分批可中断，一轮做完游标清掉', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  add(core, a(1), T0, 1, 's');                 // 新鲜
  add(core, a(2), T0 - 400 * D, 0.15, 's');    // 很久以前扫过一眼
  add(core, a(3), T0 - 20 * D, 1, 's');
  const r1 = dyn.retier(core, { at: T0 + H, limit: 2 });
  assert.deepEqual(r1, { updated: 2, done: false });
  const r2 = dyn.retier(core, { at: T0 + H, limit: 2 });
  assert.deepEqual(r2, { updated: 1, done: true });
  const tier = (id) => act(core, a(id)).tier;
  assert.equal(tier(1), 'hot');
  assert.equal(tier(2), 'cold');
  assert.equal(tier(3), 'warm');
  assert.ok(Number.isFinite(act(core, a(1)).b_cache));
  assert.deepEqual(dyn.retier(core, { at: T0 + H, limit: 10 }), { updated: 3, done: true });   // 新的一轮从头开始
}));

test('坏输入不抛错、不写痕迹', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.deepEqual(dyn.addTrace(core, a(1), { t: NaN, w: 1, sourceKey: '', reason: 'mention' }), { added: false, why: 'not-counted' });
  assert.deepEqual(dyn.addTrace(core, a(1), { t: T0, w: 0, sourceKey: '', reason: 'mention' }), { added: false, why: 'not-counted' });
  assert.deepEqual(dyn.addTrace(core, 'zz', { t: T0, w: 1, sourceKey: '', reason: 'mention' }), { added: false, why: 'not-counted' });
  assert.equal(rows(core, a(1)).length, 0);
}));

test('在调用方的事务里调用：调用方回滚，痕迹也没了', () => withCore((core) => {
  assert.throws(() => core.store.tx(() => { add(core, a(1), T0, 1, 's'); throw new Error('boom'); }), /boom/);
  assert.equal(rows(core, a(1)).length, 0);
  assert.equal(act(core, a(1)), undefined);
}));
