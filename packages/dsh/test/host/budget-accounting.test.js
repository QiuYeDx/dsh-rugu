// 后台花费的账（D120）：每个用途分开记次数、失败、未命中 / 命中 / 输出 token 和估算元；失败的调用宿主报了用量也照记；
// 旧的 host-budget.json（byUse 只有次数、历史只有元）照样读；历史留 90 天。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfig } from 'rugu-core';
import { createLlmPort } from '../../src/ports/llm.js';
import { createBudget, priceOf, BG_USES, HISTORY_DAYS } from '../../src/ports/budget.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';
import { FakeDshCtx, tmpDir, rmDir } from '../fakes/index.js';

const host = () => HOST_DEFAULTS;
/** 本机时间的某一天某个钟点（谷时：晚上 21 点）。 */
const localAt = (y, m, d, h = 21) => new Date(y, m, d, h, 0, 0, 0).getTime();
const env = ({ t0 = localAt(2026, 10, 7), file = null, core = {} } = {}) => {
  let t = t0;
  const clock = { now: () => t, set: (x) => { t = x; }, advance: (ms) => { t += ms; } };
  const b = createBudget({ coreConfig: createConfig(core), hostConfig: host, file, now: clock.now });
  return { b, clock };
};
const off = (u) => priceOf(u, HOST_DEFAULTS.budget.prices, localAt(2026, 10, 7, 21));

test('每个用途分开记：次数、失败、未命中 / 命中 / 输出、估算元；放行不算调用（真正发出去才算）', () => {
  const { b } = env();
  assert.equal(b.allow('extract', 100), true);
  assert.equal(b.status().today.byUse.extract, undefined, '放行了还没发出去：不算一次调用');
  assert.equal(b.status().today.calls, 1, '失控上限按放行的次数算');
  b.record('extract', { in: 4000, cached: 2500, out: 700 });
  b.record('extract', null, { failed: true });                                // 超时，宿主没报用量
  b.record('appraise', { in: 1800, cached: 0, out: 30 }, { failed: true });   // 中止，宿主报了用量：钱照样花了
  b.record('glance', { in: 600, cached: 0, out: 50 }, { estimated: true });
  b.record('review', { in: 1400, cached: 0, out: 100 });
  const t = b.status().today;
  assert.deepEqual(t.byUse.extract, { calls: 2, failed: 1, estimated: 0, in: 4000, cached: 2500, out: 700, yuan: Math.round(off({ in: 4000, cached: 2500, out: 700 }) * 1e4) / 1e4 });
  assert.equal(t.byUse.appraise.failed, 1);
  assert.equal(t.byUse.appraise.in, 1800, '失败的调用报了用量也照记');
  assert.equal(t.byUse.glance.estimated, 1);
  assert.equal(t.byUse.review.calls, 1, '外发审视也在按用途的账里');
  assert.equal(t.failed, 2);
  assert.equal(t.uncachedTokens, 4000 + 1800 + 600 + 1400);
  const sumYuan = Object.values(t.byUse).reduce((a, x) => a + x.yuan, 0);
  assert.ok(Math.abs(sumYuan - t.bgYuan) < 0.001, '各用途的元加起来就是今天后台的元');
  assert.deepEqual(b.status().uses, BG_USES);
  assert.deepEqual(b.status().prices, { hit: 0.02, miss: 1, out: 4, peakFactor: 2, peakHours: [[9, 12], [14, 18]] });
});

test('写缓存的 token 按未命中算；高峰时段的花费单独记一份', () => {
  const { b } = env({ t0: Date.UTC(2026, 10, 4, 2, 0) });   // 周三北京时间 10:00：高峰
  b.record('glance', { in: 100, cacheWrite: 900, cached: 0, out: 0 });
  assert.equal(b.status().today.byUse.glance.in, 1000);
  assert.equal(b.status().today.bgPeakYuan, 0.002, '高峰价 ×2');
  b.recordMainChat({ in: 100, cacheWrite: 900, cached: 0, out: 0 });
  assert.equal(b.status().main.uncachedTokens, 1000);
  const night = env({ t0: Date.UTC(2026, 10, 4, 13, 0) }).b;   // 北京时间 21:00
  night.record('glance', { in: 1000, cached: 0, out: 0 });
  assert.deepEqual([night.status().today.bgYuan, night.status().today.bgPeakYuan], [0.001, 0]);
});

test('LLMPort 把每次真正发出去的调用都报给预算：成功、失败带用量、失败没用量、宿主没报用量；没发出去的不报', async () => {
  const ctx = new FakeDshCtx();
  const { b } = env();
  const llm = createLlmPort({ getLlm: () => ctx.llm, hostConfig: host, budget: b });
  await llm.complete({ use: 'extract', system: '', messages: [{ role: 'user', content: 'x' }] });
  // 宿主先报了用量、然后报错（结果丢了）
  ctx.llmScript = () => [{ type: 'usage', usage: { inputTokens: 300, outputTokens: 7, cacheReadTokens: 0 } }, { type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } } }];
  await assert.rejects(() => llm.complete({ use: 'appraise', system: '', messages: [] }), (e) => e.code === 'MALFORMED_RESPONSE');
  // 流中途断了，没有用量
  ctx.llmScript = () => [new Error('socket hang up')];
  await assert.rejects(() => llm.complete({ use: 'glance', system: '', messages: [] }));
  // 宿主没报用量：按字数估
  ctx.llmScript = () => [{ type: 'text-delta', text: '一二三四五六' }, { type: 'finish', reason: { kind: 'stop' } }];
  const r = await llm.complete({ use: 'summary', system: '系统', messages: [{ role: 'user', content: '内容' }] });
  assert.equal('estimated' in r, false, '给核心的结果形状不变');
  // 没配模型：根本没发出去
  const bad = createLlmPort({ getLlm: () => ctx.llm, hostConfig: () => ({ ...HOST_DEFAULTS, llm: { ...HOST_DEFAULTS.llm, models: {} } }), budget: b });
  await assert.rejects(() => bad.complete({ use: 'rewrite', system: '', messages: [] }), (e) => e.code === 'NO_MODEL');
  const u = b.status().today.byUse;
  assert.deepEqual([u.extract.calls, u.extract.in, u.extract.cached, u.extract.out], [1, 10, 5, 2]);
  assert.deepEqual([u.appraise.calls, u.appraise.failed, u.appraise.in, u.appraise.out], [1, 1, 300, 7]);
  assert.deepEqual([u.glance.calls, u.glance.failed, u.glance.in], [1, 1, 0]);
  assert.deepEqual([u.summary.calls, u.summary.estimated], [1, 1]);
  assert.ok(u.summary.in > 0);
  assert.equal(u.rewrite, undefined);
});

test('旧的 host-budget.json：byUse 只有次数 → 标成只有次数的（partial），token 和元在合计里；旧历史照读', () => {
  const dir = tmpDir('budget-legacy');
  const file = path.join(dir, 'host-budget.json');
  fs.writeFileSync(file, JSON.stringify({
    today: { day: '2026-11-08', calls: 3, uncached: 1002, cached: 1152, out: 178, review: 0, reservedCalls: 0, glanceReserved: 0, byUse: { glance: 3 }, bySource: { s: 1910 },
      bgYuan: 0.0017, main: { in: 7170, cached: 1158784, out: 1379, yuan: 0.0359 }, acctYuan: 0.0359, denied: {} },
    history: [{ day: '2026-11-05', bgYuan: 2.9603, mainYuan: 8.2383, acctYuan: 10.1754 }, { day: '2026-11-07', bgYuan: 0.4842, mainYuan: 3.7229, acctYuan: 4.2259 }],
  }));
  const { b, clock } = env({ t0: localAt(2026, 10, 8, 12), file });
  let s = b.status();
  assert.deepEqual(s.today.byUse.glance, { calls: 3, failed: 0, estimated: 0, in: 0, cached: 0, out: 0, yuan: 0, partial: true });
  assert.equal(s.today.uncachedTokens, 1002, '那天的合计照旧');
  assert.equal(s.history.length, 2);
  b.record('glance', { in: 100, cached: 0, out: 10 });
  assert.deepEqual([b.status().today.byUse.glance.calls, b.status().today.byUse.glance.in, b.status().today.byUse.glance.partial], [4, 100, true]);
  // 过一天：今天按新样子进历史，旧的两天原样留着
  clock.set(localAt(2026, 10, 9, 1));
  s = b.status();
  assert.equal(s.history.length, 3);
  const h = s.history.at(-1);
  assert.equal(h.day, '2026-11-08');
  assert.deepEqual([h.calls, h.in, h.out, h.byUse.glance.calls, h.byUse.glance.partial], [4, 1102, 188, 4, true]);
  assert.equal(h.mainYuan, 0.0359);
  assert.deepEqual(s.history[0], { day: '2026-11-05', bgYuan: 2.9603, mainYuan: 8.2383, acctYuan: 10.1754 });
  b.dispose();
  // 写回去再读：形状不变
  const again = env({ t0: localAt(2026, 10, 9, 2), file }).b;
  assert.equal(again.status().history.length, 3);
  again.dispose();
  rmDir(dir);
});

test(`历史留 ${HISTORY_DAYS} 天：多出来的从最早的删；读到更长的旧文件也截到 ${HISTORY_DAYS} 天`, () => {
  const dir = tmpDir('budget-history');
  const file = path.join(dir, 'host-budget.json');
  const { b, clock } = env({ t0: localAt(2026, 0, 1, 20), file });
  for (let i = 0; i < 100; i++) {
    clock.set(localAt(2026, 0, 1 + i, 20));
    b.record('extract', { in: 1000, cached: 0, out: 100 });
  }
  clock.set(localAt(2026, 0, 101, 20));
  const s = b.status();
  assert.equal(s.history.length, HISTORY_DAYS);
  assert.equal(s.history[0].day, '2026-01-11', '最早的 10 天删掉了');
  assert.equal(s.history.at(-1).day, '2026-04-10');
  assert.equal(s.historyDays, HISTORY_DAYS);
  assert.equal(s.history.at(-1).byUse.extract.calls, 1);
  b.dispose();
  const long = { today: { day: '2026-04-11' }, history: Array.from({ length: 120 }, (_, i) => ({ day: `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, bgYuan: 1 })) };
  fs.writeFileSync(file, JSON.stringify(long));
  assert.equal(env({ t0: localAt(2026, 3, 11, 20), file }).b.status().history.length, HISTORY_DAYS);
  rmDir(dir);
});
