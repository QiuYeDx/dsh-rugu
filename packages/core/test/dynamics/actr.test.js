// dynamics 的纯函数：§6.7 数值演示的回归（容差 ±0.03，docs/实现/模块与接口.md §4.5「测试」）、Petrov 近似、噪声、成立概率。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../../src/config/defaults.js';
import {
  stateFromEvents, baseActivationOf, pRecall, seededNoise, uniformFrom, decayFor, pHoldOf, aggregateSum, foldOldest, emptyAgg,
  traceSum, replayDecays, localDay, slotOf,
} from '../../src/dynamics/actr.js';

const H = 3_600_000;
const D = 24 * H;
const M = 60_000;
const A = DEFAULTS.activation;
const P = { a: A.a, c: A.c, dMax: A.dMax, ageFloorMin: A.ageFloorMin, timeUnitMs: A.timeUnitMs, exactTraces: A.exactTraces };
const near = (got, want, tol = 0.03, what = '') => assert.ok(Math.abs(got - want) <= tol, `${what} 期望 ${want}±${tol}，实际 ${got.toFixed(3)}`);
/** 被问到时（有意回想，τ_del）、线索强度 S 时想得起的概率 */
const asked = (st, at, S = 1.0) => pRecall(baseActivationOf(st, at, P) + S, A.tauDeliberate, A.s);
const single = (w) => stateFromEvents([{ t: 0, w }], P);

test('§6.7 只编码一次，被问到时（S = +1.0）能想起的概率：三档注意力 × 1/7/30/180 天', () => {
  const table = [
    [1.0, [0.98, 0.93, 0.83, 0.56]],
    [0.35, [0.82, 0.51, 0.26, 0.08]],
    [0.15, [0.35, 0.11, 0.04, 0.01]],
  ];
  for (const [w, want] of table) {
    [1, 7, 30, 180].forEach((d, i) => near(asked(single(w), d * D), want[i], 0.03, `w=${w} ${d} 天`));
  }
});

test('§6.7 没有线索时：对她说的事 1 小时后自发想起 0.50，1 天后 0.08；旁听的 1 天后 0.01', () => {
  const spont = (st, at) => pRecall(baseActivationOf(st, at, P), A.tauInvoluntary, A.s);
  near(spont(single(1), H), 0.50, 0.03, '1 小时');
  near(spont(single(1), D), 0.08, 0.03, '1 天');
  near(spont(single(0.35), D), 0.01, 0.03, '旁听 1 天');
});

test('§6.7 听来的事（亲密度 0.3、社交相关 1.2）：四种情况 × 7/30/90/180 天', () => {
  const w = 1.0 * 1.2 * 1.0 * (A.relation.base + A.relation.span * 0.3);   // 对她说
  const wp = A.attention.peripheral * 1.2 * (A.relation.base + A.relation.span * 0.3);   // 旁听
  const fan = 1.0 + (A.fanSMax - Math.log(3));
  const rows = [
    ['对她说，只这一条', single(w), 1.0, [0.96, 0.89, 0.77, 0.67]],
    ['旁听，只这一条', single(wp), 1.0, [0.63, 0.36, 0.20, 0.13]],
    ['旁听，档案被提到两次（周一、周三）', stateFromEvents([{ t: 0, w: wp }, { t: 2 * D, w: wp }], P), 1.0, [0.89, 0.71, 0.50, 0.36]],
    ['同上，加扇出项（档案下 3 条事实）', stateFromEvents([{ t: 0, w: wp }, { t: 2 * D, w: wp }], P), fan, [0.96, 0.87, 0.73, 0.61]],
  ];
  for (const [what, st, S, want] of rows) {
    [7, 30, 90, 180].forEach((d, i) => near(asked(st, d * D, S), want[i], 0.03, `${what} ${d} 天`));
  }
  // 对照：草稿口径（听说降权三次）一个月后几乎答不上
  const draft = single(wp * 0.5 * 0.5 * Math.pow(2, (3 - 5) / 2.5));
  assert.ok(asked(draft, 30 * D) < 0.1);
});

test('§6.7 同样四次：隔开（第 0、3、10、30 天）比集中（几分钟内）记得牢', () => {
  const spaced = stateFromEvents([0, 3, 10, 30].map((d) => ({ t: d * D, w: 1 })), P);
  const massed = stateFromEvents([0, 2, 4, 6].map((m) => ({ t: m * M, w: 1 })), P);
  [31, 180, 365].forEach((d, i) => {
    near(asked(spaced, d * D), [0.99, 0.92, 0.86][i], 0.03, `隔开 ${d} 天`);
    near(asked(massed, d * D), [0.83, 0.56, 0.43][i], 0.03, `集中 ${d} 天`);
    assert.ok(asked(spaced, d * D) > asked(massed, d * D));
  });
  // 集中重复时后面几条的衰减率顶到上限（写入前激活高 → 衰减快），隔开的不会
  assert.ok(massed.traces.slice(1).every((t) => t.d === A.dMax));
  assert.ok(spaced.traces.slice(1).every((t) => t.d < A.dMax));
});

test('§6.7「今晚加班」的两条曲线：成立概率和被问时想得起互不相干', () => {
  const fact = { valid_from: 0, valid_to_known: null, t50_h: 5, shape: 2, change_known: 0, recorded_at: 0 };
  const st = single(1);
  const rows = [[H, 0.97, 1.00], [4 * H, 0.64, 1.00], [8 * H, 0.17, 0.99], [7 * D, 0.00, 0.93]];
  for (const [t, hold, recall] of rows) {
    near(pHoldOf(fact, t, DEFAULTS.validity.changeKnownFactor), hold, 0.03, `成立 ${t / H} 小时`);
    near(asked(st, t), recall, 0.03, `想得起 ${t / H} 小时`);
  }
});

test('衰减率：第一条 d = a；d = a + c·e^min(m, 3)，上限 dMax', () => {
  assert.equal(decayFor(-Infinity, P), A.a);
  near(decayFor(-2, P), A.a + A.c * Math.exp(-2), 1e-12);
  assert.equal(decayFor(5, P), Math.min(A.dMax, A.a + A.c * Math.exp(3)));
  assert.equal(decayFor(10, { ...P, dMax: 100 }), A.a + A.c * Math.exp(3));   // m 封顶在 3
});

test('Petrov 聚合近似：超过 K 条的旧痕迹并进聚合项，和精确求和差得很小', () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ t: i * 2 * D + (i % 3) * H, w: 0.5 + (i % 4) * 0.2 }));
  const approx = stateFromEvents(events, P);
  const exact = stateFromEvents(events, { ...P, exactTraces: 1000 });
  assert.equal(approx.traces.length, A.exactTraces);
  assert.equal(approx.agg.n, 30 - A.exactTraces);
  for (const at of [61 * D, 120 * D, 400 * D]) {
    const da = baseActivationOf(approx, at, P);
    const de = baseActivationOf(exact, at, P);
    assert.ok(Math.abs(da - de) < 0.01, `差 ${Math.abs(da - de)}`);
  }
  // 只有一条的聚合项就是精确值
  const g = foldOldest([{ t: 0, w: 1, d: 0.4 }, { t: D, w: 1, d: 0.3 }], emptyAgg(), 1).agg;
  near(aggregateSum(g, 10 * D, P), Math.pow(10 * 24, -0.4), 1e-12);
});

test('B：没有痕迹是 -Infinity；未来的痕迹不算；age 下限 3 分钟', () => {
  assert.equal(baseActivationOf({ traces: [], agg: emptyAgg() }, 0, P), -Infinity);
  const st = { traces: [{ t: 10 * H, w: 1, d: 0.3 }], agg: emptyAgg() };
  assert.equal(baseActivationOf(st, 5 * H, P), -Infinity);
  near(traceSum(st, 10 * H, P), Math.pow(3 / 60, -0.3), 1e-12);
  near(traceSum(st, 10 * H + M, P), Math.pow(3 / 60, -0.3), 1e-12);
});

test('replayDecays：按「写入前一刻的激活」重算，插到中间的痕迹会让后面的重算，结果和按顺序到达一样', () => {
  const inOrder = stateFromEvents([{ t: 0, w: 1 }, { t: D, w: 1 }, { t: 3 * D, w: 1 }], P);
  const traces = [{ t: 0, w: 1, d: 0 }, { t: 3 * D, w: 1, d: 0 }];
  replayDecays(traces, emptyAgg(), P, 0);
  traces.splice(1, 0, { t: D, w: 1, d: 0 });
  replayDecays(traces, emptyAgg(), P, 1);
  assert.deepEqual(traces.map((t) => t.d), inOrder.traces.map((t) => t.d));
});

test('pRecall：σ((A − τ)/s) 和边界', () => {
  assert.equal(pRecall(0, 0, 0.4), 0.5);
  assert.equal(pRecall(-Infinity, 0, 0.4), 0);
  assert.equal(pRecall(Infinity, 0, 0.4), 1);
  assert.equal(pRecall(0.1, 0, 0), 1);
  assert.equal(pRecall(-0.1, 0, 0), 0);
  near(pRecall(0.4, 0, 0.4), 1 / (1 + Math.exp(-1)), 1e-12);
});

test('seededNoise：同样的种子同样的结果；分布是尺度 s 的 logistic（均值 0，P(ε > x) = σ(−x/s)）', () => {
  assert.equal(seededNoise(['会话', '回合', 'a1'], 0.4), seededNoise(['会话', '回合', 'a1'], 0.4));
  assert.notEqual(seededNoise(['会话', '回合', 'a1'], 0.4), seededNoise(['会话', '回合2', 'a1'], 0.4));
  // 编码无歧义：['ab','c'] 和 ['a','bc'] 不撞
  assert.notEqual(uniformFrom(['ab', 'c']), uniformFrom(['a', 'bc']));
  const n = 4000;
  let sum = 0;
  let above = 0;
  for (let i = 0; i < n; i++) {
    const e = seededNoise(['s', String(i)], 0.4);
    sum += e;
    if (e > 0.4) above += 1;
  }
  assert.ok(Math.abs(sum / n) < 0.05, `均值 ${sum / n}`);
  near(above / n, 1 / (1 + Math.exp(1)), 0.03, 'P(ε > s)');
  assert.equal(seededNoise(['x'], 0), 0);
});

test('pHold：超过 valid_to_known 为 0；没有 t50 为 1；还没开始为 1；据说已变 × 0.3', () => {
  const f = DEFAULTS.validity.changeKnownFactor;
  const base = { valid_from: 0, valid_to_known: null, t50_h: null, shape: null, change_known: 0, recorded_at: 0 };
  assert.equal(pHoldOf(base, 100 * D, f), 1);
  assert.equal(pHoldOf({ ...base, valid_to_known: D }, D, f), 0);
  assert.equal(pHoldOf({ ...base, t50_h: 5, valid_from: 10 * H }, 2 * H, f), 1);
  near(pHoldOf({ ...base, t50_h: 10, shape: 1 }, 10 * H, f), 0.5, 1e-12);
  near(pHoldOf({ ...base, change_known: 1 }, D, f), 0.3, 1e-12);
  // valid_from 缺失时从 recorded_at 起算
  near(pHoldOf({ ...base, valid_from: null, recorded_at: 0, t50_h: 10, shape: 1 }, 10 * H, f), 0.5, 1e-12);
});

test('本地日、时间格按配置的时区对齐', () => {
  const t = Date.UTC(2026, 9, 31, 17, 0);   // UTC 17:00 = 东八区 11-01 01:00
  assert.equal(localDay(t, 480), '2026-11-01');
  assert.equal(localDay(t, 0), '2026-10-31');
  assert.equal(slotOf(t, 6 * H, 480), slotOf(t + 4 * H, 6 * H, 480));     // 01:00 和 05:00 同一格
  assert.notEqual(slotOf(t, 6 * H, 480), slotOf(t + 5.5 * H, 6 * H, 480)); // 06:30 是下一格
});
