// 核心端口的 DSH 实现（§3.3）：LLMPort（包 ctx.llm.stream，§10.6）、BudgetPort（两档预设、失控上限、外发预留、余额保护）、
// EmbeddingPort（Ollama /api/embed、档位、熔断、显卡策略，§8.6、§10.7）、RerankPort（可选）、SelfProfile、Sanitizer、任务队列。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfig, normalizePorts } from 'rugu-core';
import { createLlmPort } from '../../src/ports/llm.js';
import { createBudget, priceOf } from '../../src/ports/budget.js';
import { createEmbeddingPort, tierInfo } from '../../src/ports/embedding.js';
import { createRerankPort } from '../../src/ports/rerank.js';
import { createSelfProfile } from '../../src/ports/self-profile.js';
import { createSanitizer } from '../../src/ports/sanitizer.js';
import { TaskQueue } from '../../src/ports/queue.js';
import { buildPorts } from '../../src/ports/index.js';
import { HOST_DEFAULTS, createConfigStore } from '../../src/host/config.js';
import { resolvePaths } from '../../src/host/paths.js';
import { FakeDshCtx, tmpDir, rmDir } from '../fakes/index.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const hostWith = (patch = {}) => {
  const h = clone(HOST_DEFAULTS);
  for (const [k, v] of Object.entries(patch)) h[k] = { ...h[k], ...v };
  return () => h;
};
const clockAt = (t0 = Date.UTC(2026, 10, 4, 2, 0)) => { let t = t0; return { now: () => t, advance: (ms) => { t += ms; }, set: (x) => { t = x; } }; };

// ── LLMPort ─────────────────────────────────────────────────────────────

test('LLMPort：按用途选模型（允许清单、精确 id deepseek-flash）、思考取最低档、temperature 0.2；用量报给预算', async () => {
  const ctx = new FakeDshCtx();
  const recorded = [];
  const llm = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith(), budget: { record: (use, u, m) => recorded.push({ use, u, m }) } });
  const r = await llm.complete({ use: 'extract', system: '以下全是数据', messages: [{ role: 'user', content: '一段原文' }, { role: 'assistant', content: '上一轮' }], maxTokens: 800, meta: { sourceKey: 's1' } });
  assert.deepEqual(r, { text: 'ok', usage: { in: 10, cached: 5, out: 2 }, model: 'deepseek-flash' });
  const o = ctx.llmCalls[0];
  assert.equal(o.provider, 'deepseek-official', '没配提供方、宿主也没有默认选择：用 deepseek-official');
  assert.equal(o.model, 'deepseek-flash');
  assert.equal(o.reasoningEffort, 'off', '附录 G：思考关（模型支持的最低档）');
  assert.equal(o.temperature, 0.2);
  assert.equal(o.maxTokens, 800);
  assert.equal(o.system, '以下全是数据');
  assert.deepEqual(o.messages[0], { role: 'user', content: [{ type: 'text', text: '一段原文' }] });
  assert.equal(o.messages[1].role, 'assistant');
  assert.ok(o.signal instanceof AbortSignal, '每次调用都有超时信号');
  assert.deepEqual(recorded, [{ use: 'extract', u: { in: 10, cached: 5, out: 2 }, m: { sourceKey: 's1' } }]);
  assert.equal(llm.status().byUse.extract, 1);
  // 宿主的默认选择只决定提供方，不决定模型（§10.6：不跟随宿主的默认模型）
  const llm2 = createLlmPort({ getLlm: () => ctx.llm, getDefaultSelection: () => ({ provider: 'deepseek-api-key', model: 'deepseek-pro' }), hostConfig: hostWith() });
  await llm2.complete({ use: 'review', system: '', messages: [] });
  assert.deepEqual([ctx.llmCalls[1].provider, ctx.llmCalls[1].model], ['deepseek-api-key', 'deepseek-flash']);
});

test('LLMPort：不在允许清单里的模型、不认识的用途、没有模型服务都拒绝；finish 报错按 code 抛出；QUOTA 通知余额保护', async () => {
  const ctx = new FakeDshCtx();
  const bad = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith({ llm: { models: { ...HOST_DEFAULTS.llm.models, extract: 'deepseek-pro' } } }) });
  await assert.rejects(() => bad.complete({ use: 'extract', system: '', messages: [] }), (e) => e.code === 'MODEL_NOT_ALLOWED');
  await assert.rejects(() => bad.complete({ use: 'chat', system: '', messages: [] }), (e) => e.code === 'BAD_USE');
  const none = createLlmPort({ getLlm: () => null, hostConfig: hostWith() });
  await assert.rejects(() => none.complete({ use: 'appraise', system: '', messages: [] }), (e) => e.code === 'NO_LLM');
  let quota = 0;
  ctx.llmScript = () => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: '余额不足' } } }];
  const q = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith(), budget: { notifyQuota: () => { quota += 1; } } });
  await assert.rejects(() => q.complete({ use: 'review', system: '', messages: [] }), (e) => e.code === 'QUOTA');
  assert.equal(quota, 1, 'H5：402 → 后台进余额保护');
});

test('LLMPort：后台队列连续失败按 1 / 4 / 16 分钟退避；评估和审视不受影响；超时报 TIMEOUT', async () => {
  const ctx = new FakeDshCtx();
  const clock = clockAt();
  ctx.llmScript = () => [new Error('boom')];
  const llm = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith({ llm: { bgMinSpacingMs: 0 } }), now: clock.now });
  await assert.rejects(() => llm.complete({ use: 'extract', system: '', messages: [] }));
  await assert.rejects(() => llm.complete({ use: 'sleep', system: '', messages: [] }), (e) => e.code === 'LLM_BACKOFF');
  assert.equal(llm.status().backoffUntil, clock.now() + 60_000);
  ctx.llmScript = () => [{ type: 'text-delta', text: 'speak' }, { type: 'finish', reason: { kind: 'stop' } }];
  assert.equal((await llm.complete({ use: 'review', system: '', messages: [] })).text, 'speak', '外发审视走自己的队列');
  clock.advance(61_000);
  ctx.llmScript = () => [new Error('boom')];
  await assert.rejects(() => llm.complete({ use: 'extract', system: '', messages: [] }));
  assert.equal(llm.status().backoffUntil, clock.now() + 4 * 60_000, '第二次 4 分钟');
  clock.advance(5 * 60_000);
  ctx.llmScript = () => [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }];
  await llm.complete({ use: 'extract', system: '', messages: [] });
  assert.equal(llm.status().backoffUntil, null, '成功一次就清掉退避');
  // 超时：脚本先等 20 ms，超时设 5 ms
  ctx.llmScript = () => ['wait', { type: 'text-delta', text: 'late' }, { type: 'finish', reason: { kind: 'stop' } }];
  const slow = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith({ llm: { timeoutMs: { ...HOST_DEFAULTS.llm.timeoutMs, appraise: 5 } } }) });
  await assert.rejects(() => slow.complete({ use: 'appraise', system: '', messages: [] }), (e) => e.code === 'TIMEOUT');
});

test('LLMPort 满足核心的端口检查（normalizePorts）', () => {
  const ctx = new FakeDshCtx();
  const dir = tmpDir('ports-shape');
  const store = createConfigStore({ file: path.join(dir, 'persona-memory.json') });
  const p = buildPorts({ ctxGet: (n) => ctx.get(n), configStore: store, paths: resolvePaths({ dshHome: dir }), log: { debug() {}, info() {}, warn() {}, error() {} }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.doesNotThrow(() => normalizePorts(p.core));
  assert.equal(p.core.rerank, undefined, '没配重排 → 没有这个端口（核心跳过重排）');
  assert.equal(p.core.selfProfile.locale, 'zh');
  p.dispose();
  rmDir(dir);
});

// ── BudgetPort ──────────────────────────────────────────────────────────

const budgetEnv = (o = {}) => {
  const clock = o.clock ?? clockAt();
  const core = createConfig(o.core ?? {});
  const host = hostWith(o.host ?? {});
  const b = createBudget({ coreConfig: core, hostConfig: host, file: o.file ?? null, now: clock.now });
  return { b, clock, core };
};

test('预算：默认「宽松」——不设比例上限，失控上限 3000 次 / 500 万；超了只剩对她说的一对一提炼的预留份额', () => {
  const { b } = budgetEnv({ core: { budget: { overrides: { dailyCalls: 5 } } } });
  const st0 = b.status();
  assert.equal(st0.preset, 'loose');
  assert.equal(st0.limits.mainChatRatioCap, null, '宽松档不设比例上限（§17 Q10）');
  assert.equal(st0.limits.dailyUncachedTokens, 5_000_000);
  assert.equal(st0.limits.balanceProtectDays, 1);
  for (let i = 0; i < 5; i++) assert.equal(b.allow('extract', 100), true);
  assert.equal(b.allow('appraise', 100), false, '失控上限');
  assert.equal(b.allow('extract', 100, { reserved: true }), true, '预留份额：ceil(5 × 0.2) = 1 次');
  assert.equal(b.allow('extract', 100, { reserved: true }), false);
  assert.equal(b.status().today.denied['appraise:calls'], 1);
  // 节省档
  const s = budgetEnv({ core: { budget: { preset: 'saving' } } }).b.status();
  assert.deepEqual([s.limits.dailyCalls, s.limits.dailyUncachedTokens, s.limits.mainChatRatioCap, s.limits.balanceProtectDays], [600, 1_000_000, 0.25, 3]);
});

test('预算：节省档的第二段评估只在对她说的轮次放行（核心在 meta.direct 里说）；宽松档、不带 direct 的调用不受限', () => {
  const saving = budgetEnv({ core: { budget: { preset: 'saving' } } }).b;
  assert.equal(saving.allow('appraise', 10, { direct: false }), false, '群里旁听到的一轮：不跑第二段');
  assert.equal(saving.status().today.denied['appraise:scope'], 1);
  assert.equal(saving.allow('appraise', 10, { direct: true }), true);
  assert.equal(saving.allow('appraise', 10), true, '常驻区之类不带 direct 的照常');
  assert.equal(saving.allow('extract', 10, { direct: false }), true, '只管第二段评估');
  const loose = budgetEnv().b;
  assert.equal(loose.allow('appraise', 10, { direct: false }), true, '宽松档 stage2Scope=all');
});

test('预算：外发审视单独预留（默认每天 100 次），不受失控上限和余额保护影响；用完就 fail closed（核心按审不了处理）', () => {
  const { b } = budgetEnv({ core: { budget: { egressReservePerDay: 2, overrides: { dailyCalls: 0 } } } });
  assert.equal(b.allow('extract', 1), false);
  assert.equal(b.allow('review', 1), true);
  b.notifyQuota();
  assert.equal(b.allow('review', 1), true, '余额保护时也有');
  assert.equal(b.allow('review', 1), false, '预留用完');
  assert.deepEqual(b.status().egressReserve, { used: 2, total: 2 });
  assert.equal(b.state().reserveLeft, 0);
});

test('预算：单个来源的份额上限（防刷屏）；比例上限只在节省档；用量按价目折算成元', () => {
  const { b } = budgetEnv({ core: { budget: { overrides: { dailyUncachedTokens: 1000, perSourceShare: 0.5 } } } });
  assert.equal(b.allow('extract', 400, { sourceKey: 'g1' }), true);
  assert.equal(b.allow('extract', 200, { sourceKey: 'g1' }), false, '一个群最多用一半');
  assert.equal(b.allow('extract', 400, { sourceKey: 'g2' }), true);
  const saving = budgetEnv({ core: { budget: { preset: 'saving' } } }).b;
  saving.recordMainChat({ in: 1_000_000, cached: 0, out: 0 });   // 主聊天花了 1 元（谷时）
  saving.record('extract', { in: 300_000, cached: 0, out: 0 });     // 后台 0.3 元 > 25%
  assert.equal(saving.allow('extract', 10), false);
  assert.equal(saving.status().today.denied['extract:ratio'], 1);
  // 峰谷：北京时间工作日 9–12、14–18 点翻倍（附录 G）
  const peak = Date.UTC(2026, 10, 4, 2, 0);   // 周三北京时间 10:00
  const off = Date.UTC(2026, 10, 4, 13, 0);   // 21:00
  const prices = HOST_DEFAULTS.budget.prices;
  assert.equal(priceOf({ in: 1_000_000, cached: 0, out: 0 }, prices, peak), 2);
  assert.equal(priceOf({ in: 1_000_000, cached: 1_000_000, out: 1_000_000 }, prices, off), 1 + 0.02 + 4);
});

test('预算：余额保护——剩余不够 1 天的预计花费就停后台（只留外发审视）；充值后自动恢复；设 0 关掉', () => {
  const dir = tmpDir('budget-balance');
  const balFile = path.join(dir, 'balance.json');
  fs.writeFileSync(balFile, JSON.stringify({ data: { balance: 0.5 } }));
  const env = budgetEnv({ host: { budget: { balance: { file: balFile, path: 'data.balance', everyMs: 0 } } } });
  env.b.recordMainChat({ in: 1_000_000, cached: 0, out: 500_000 });   // 今天已经花了约 3 元 → 外推一天远超 0.5 元
  env.b.refreshBalance();
  assert.equal(env.b.state().paused, true);
  assert.equal(env.b.allow('extract', 10), false);
  assert.equal(env.b.allow('sleep', 10), false);
  assert.equal(env.b.allow('review', 10), true);
  assert.equal(env.b.status().balance.protecting, true);
  fs.writeFileSync(balFile, JSON.stringify({ data: { balance: 500 } }));
  env.clock.advance(1000);
  env.b.refreshBalance();
  assert.equal(env.b.state().paused, false, '充值后自动恢复');
  assert.equal(env.b.allow('extract', 10), true);
  // 宿主报过 QUOTA：停到余额来源说恢复了
  env.b.notifyQuota();
  assert.equal(env.b.allow('extract', 10), false);
  env.clock.advance(1000);
  env.b.refreshBalance();
  assert.equal(env.b.allow('extract', 10), true);
  // 设 0 关掉余额保护
  fs.writeFileSync(balFile, JSON.stringify({ data: { balance: 0.01 } }));
  const off = budgetEnv({ core: { budget: { overrides: { balanceProtectDays: 0 } } }, host: { budget: { balance: { file: balFile, path: 'data.balance', everyMs: 0 } } } });
  off.b.recordMainChat({ in: 1_000_000, cached: 0, out: 0 });
  off.b.refreshBalance();
  assert.equal(off.b.allow('extract', 10), true);
  rmDir(dir);
});

test('预算（D121）：「不设上限」档——次数、token、比例都不拦，其余全开；余额保护照留', () => {
  const { b } = budgetEnv({ core: { budget: { preset: 'unlimited' } } });
  const st = b.status();
  assert.equal(st.preset, 'unlimited');
  assert.equal(st.custom, false);
  assert.deepEqual([st.limits.dailyCalls, st.limits.dailyUncachedTokens, st.limits.dailyOutputTokens, st.limits.mainChatRatioCap, st.limits.perSourceShare, st.limits.balanceProtectDays],
    [Infinity, Infinity, Infinity, null, 1, 1]);
  b.recordMainChat({ in: 10_000, cached: 0, out: 0 });
  for (let i = 0; i < 4000; i++) assert.equal(b.allow('extract', 5000, { sourceKey: 'g1' }), true);
  b.record('extract', { in: 50_000_000, cached: 0, out: 5_000_000 }, { sourceKey: 'g1' });
  assert.equal(b.allow('appraise', 5000, { direct: false, sourceKey: 'g1' }), true, '超过宽松档的次数、token、输出、比例，一个群占满也放行');
  assert.deepEqual(b.status().today.denied, {});
  b.notifyQuota();
  assert.equal(b.allow('extract', 10), false, '余额保护（402）照样停后台');
  assert.equal(b.allow('review', 10), true);
});

test('预算（D121）：主人单独改的项盖过预设（含每天输出的上限）；null = 不设；只改了开关时上限还按那一档', () => {
  const { b } = budgetEnv({ core: { budget: { preset: 'saving', overrides: { dailyCalls: 2, dailyOutputTokens: 500, stage2Scope: 'all' } } } });
  const st = b.status();
  assert.equal(st.custom, true);
  assert.deepEqual(st.overridden.sort(), ['dailyCalls', 'dailyOutputTokens', 'stage2Scope']);
  assert.deepEqual([st.limits.dailyCalls, st.limits.dailyOutputTokens, st.limits.dailyUncachedTokens], [2, 500, 1_000_000]);
  assert.equal(b.allow('appraise', 10, { direct: false }), true, 'stage2Scope 改回 all：群里也评估');
  b.record('appraise', { in: 10, cached: 0, out: 600 });
  assert.equal(b.allow('extract', 10), false, '输出到了主人改的 500');
  assert.equal(b.status().today.denied['extract:output'], 1);
  // 输出不设、次数不设（宽松档上）：只剩 token 上限；token 到了，对她说的一对一提炼的预留也不按次数限
  const u = budgetEnv({ core: { budget: { overrides: { dailyCalls: null, dailyOutputTokens: null, dailyUncachedTokens: 1000 } } } }).b;
  assert.deepEqual([u.status().limits.dailyCalls, u.status().limits.dailyOutputTokens], [Infinity, Infinity]);
  for (let i = 0; i < 5000; i++) assert.equal(u.allow('glance', 0), true);
  u.record('extract', { in: 1000, cached: 0, out: 9_000_000 });
  assert.equal(u.allow('extract', 10), false, 'token 到了');
  assert.equal(u.allow('extract', 10, { reserved: true }), true, '预留不按次数限');
  // 只改开关：saving 的上限不动；宿主每档的输出上限照用
  const sw = budgetEnv({ core: { budget: { preset: 'saving', overrides: { rerank: false } } } }).b.status();
  assert.deepEqual([sw.limits.dailyCalls, sw.limits.dailyOutputTokens], [600, 300_000]);
  // 文件里写错的那一项忽略（核心的 mergeConfig 给 warning），其余照用
  const bad = budgetEnv({ core: { budget: { overrides: { dailyCalls: -5, dailyUncachedTokens: 'many', perSourceShare: 0.2 } } } }).b.status();
  assert.deepEqual([bad.limits.dailyCalls, bad.limits.dailyUncachedTokens, bad.limits.perSourceShare], [3000, 5_000_000, 0.2]);
});

test('预算：计数按本机的日子存文件、重启不丢；过了一天清零并进历史', () => {
  const dir = tmpDir('budget-file');
  const file = path.join(dir, 'host-budget.json');
  const clock = clockAt(new Date(2026, 10, 4, 10, 0).getTime());
  const a = budgetEnv({ file, clock });
  a.b.allow('extract', 10);
  a.b.record('extract', { in: 100, cached: 50, out: 10 });
  a.b.dispose();
  const b = budgetEnv({ file, clock });
  assert.equal(b.b.status().today.calls, 1);
  assert.equal(b.b.status().today.uncachedTokens, 100);
  clock.set(new Date(2026, 10, 5, 0, 30).getTime());
  assert.equal(b.b.status().today.calls, 0);
  assert.equal(b.b.status().history.length, 1);
  b.b.dispose();
  rmDir(dir);
});

// ── EmbeddingPort ───────────────────────────────────────────────────────

/** 一个假的 Ollama：记下请求，按维数回向量。 */
function fakeOllama({ dim = 1024, fail = 0, failStatus = 0, models = ['qwen3-embedding:4b', 'qwen3-embedding:0.6b'], loaded = true } = {}) {
  const calls = [];
  let failures = fail;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, body });
    if (failures > 0 && u.pathname === '/api/embed') {
      failures -= 1;
      // failStatus：服务端报错（5xx，比如显卡加载失败）；不给就是连不上
      if (failStatus) return { ok: false, status: failStatus, json: async () => ({}) };
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    }
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.pathname === '/api/embed') return json({ embeddings: (body.input ?? []).map((_, i) => Array.from({ length: dim }, (_, j) => (j === i ? 3 : j === i + 1 ? 4 : 0))) });
    if (u.pathname === '/api/version') return json({ version: '0.40.13' });
    if (u.pathname === '/api/tags') return json({ models: models.map((name) => ({ name })) });
    if (u.pathname === '/api/ps') return json({ models: loaded ? [{ name: 'qwen3-embedding:4b', size_vram: 4200 * 1048576 }] : [] });
    if (u.pathname === '/v1/embeddings') return json({ data: (body.input ?? []).map((_, i) => ({ index: i, embedding: Array.from({ length: dim }, () => 1) })) });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls, setFail: (n) => { failures = n; } };
}

test('嵌入：Ollama /api/embed，默认标准档 4B（§17 Q1）、1024 维、固定 num_ctx；资源管家说 CPU 就带 num_gpu:0 和线程数；向量 L2 归一化', async () => {
  const o = fakeOllama();
  const gov = { decision: () => ({ device: 'cpu', cpuThreads: 2 }) };
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, governor: gov });
  const info = e.info();
  assert.equal(info.model, 'qwen3-embedding:4b');
  assert.equal(info.dim, 1024);
  assert.equal(info.device, 'cpu');
  const r = await e.embed(['你好', '在吗'], 'query');
  assert.equal(r.spaceId, info.spaceId);
  assert.equal(r.vectors.length, 2);
  assert.ok(r.vectors[0] instanceof Float32Array);
  assert.ok(Math.abs(r.vectors[0][0] - 0.6) < 1e-6 && Math.abs(r.vectors[0][1] - 0.8) < 1e-6, 'L2 归一化');
  const req = o.calls[0];
  assert.equal(req.path, '/api/embed');
  assert.equal(req.body.model, 'qwen3-embedding:4b');
  assert.equal(req.body.dimensions, 1024);
  assert.equal(req.body.keep_alive, '2h', '模型常驻 2 小时（实测问题 #1）');
  assert.deepEqual(req.body.options, { num_ctx: 1024, num_gpu: 0, num_thread: 2 });
  // GPU：不带 num_gpu
  const g = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, governor: { decision: () => ({ device: 'gpu', cpuThreads: 4 }) } });
  await g.embed(['x'], 'doc');
  assert.equal(o.calls.at(-1).body.options.num_gpu, undefined);
  assert.deepEqual(o.calls.at(-1).body.options, { num_ctx: 1024 }, 'GPU 上不带 num_thread：值一变 Ollama 就整个重新加载模型');
  assert.equal(g.info().spaceId, info.spaceId, 'CPU / GPU 之间切换不改向量空间（§8.6.2）');
});

test('嵌入：换档 = 换向量空间（轻量 0.6B）；影子期间按 spaceId 找回旧档的模型；维数不对报错；自定义档没填全就没有模型', async () => {
  const o = fakeOllama();
  const light = createEmbeddingPort({ hostConfig: hostWith({ embedding: { tier: 'light' } }), fetchImpl: o.fetchImpl });
  const std = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl });
  assert.equal(light.info().model, 'qwen3-embedding:0.6b');
  assert.notEqual(light.info().spaceId, std.info().spaceId);
  await light.embed(['x'], 'doc', { spaceId: std.info().spaceId });
  assert.equal(o.calls.at(-1).body.model, 'qwen3-embedding:4b', '影子空间：旧档的模型');
  const wrong = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: fakeOllama({ dim: 512 }).fetchImpl });
  await assert.rejects(() => wrong.embed(['x'], 'query'), (e) => e.code === 'EMBED_DIM');
  const custom = createEmbeddingPort({ hostConfig: hostWith({ embedding: { tier: 'custom' } }), fetchImpl: o.fetchImpl });
  assert.equal(custom.info().spaceId, '');
  await assert.rejects(() => custom.embed(['x'], 'query'), (e) => e.code === 'NO_MODEL');
  assert.equal(tierInfo(clone(HOST_DEFAULTS.embedding)).spaceId, std.info().spaceId, 'space_id = hash(模型, 量化档, 维数, 文档模板版本)，稳定');
});

test('嵌入：连续 2 次失败熔断 60 秒（直接报错，核心降到 L3）；GPU 上服务端报错告诉资源管家；健康检查恢复', async () => {
  const o = fakeOllama({ fail: 2, failStatus: 500 });
  const clock = clockAt();
  let gpuErrors = 0;
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now, governor: { decision: () => ({ device: 'gpu' }), reportGpuError: () => { gpuErrors += 1; } } });
  await assert.rejects(() => e.embed(['a'], 'query'));
  await assert.rejects(() => e.embed(['a'], 'query'));
  const n = o.calls.length;
  await assert.rejects(() => e.embed(['a'], 'query'), (x) => x.code === 'EMBED_BREAKER');
  assert.equal(o.calls.length, n, '熔断期间不调');
  assert.equal(gpuErrors, 2, '「开」档加载失败或服务端报错就退回 CPU（§8.6.2）');
  assert.equal(e.status().errors.HTTP_500, 2);
  assert.equal(e.status().lastError.code, 'HTTP_500');
  const h = await e.checkHealth();
  assert.equal(h.ok, true);
  assert.equal(h.version, '0.40.13');
  assert.equal(h.modelPresent, true);
  assert.equal(h.breakerOpen, false, '健康检查通过就提前合上');
  assert.equal(e.ownVramMb(), 4200);
  assert.ok((await e.embed(['a'], 'query')).vectors.length);
  // 让出 GPU：发 keep_alive 0 卸掉
  e.onDeviceChange({ device: 'gpu' });
  e.onDeviceChange({ device: 'cpu' });
  await new Promise((r) => setTimeout(r, 10));
  const unload = o.calls.filter((c) => c.path === '/api/embed' && c.body.keep_alive === 0);
  assert.equal(unload.length, 1);
  e.dispose();
});

test('嵌入：查询永远排在文档批前面（带优先级的队列，§7.6）；OpenAI 兼容接口', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    order.push(body.input[0]);
    if (body.input[0] === 'first') await gate;
    return { ok: true, json: async () => ({ embeddings: body.input.map(() => Array.from({ length: 1024 }, () => 1)) }) };
  };
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl });
  const p1 = e.embed(['first'], 'doc');
  const p2 = e.embed(['doc2'], 'doc');
  const p3 = e.embed(['query'], 'query');
  await new Promise((r) => setTimeout(r, 5));
  release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, ['first', 'query', 'doc2']);
  const o = fakeOllama();
  const oa = createEmbeddingPort({ hostConfig: hostWith({ embedding: { provider: 'openai-compat' } }), fetchImpl: o.fetchImpl });
  await oa.embed(['x'], 'query');
  assert.equal(o.calls.at(-1).path, '/v1/embeddings');
});

// ── RerankPort ──────────────────────────────────────────────────────────

test('重排：没配 → 没有这个端口；配了也只在资源管家允许（GPU 有空）时可用；分数按 index 对回', async () => {
  assert.equal(createRerankPort({ hostConfig: hostWith() }), null, '§15.2：装好、校验通过才启用');
  let allowed = false;
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }) }; };
  const r = createRerankPort({ hostConfig: hostWith({ rerank: { url: 'http://127.0.0.1:8081' } }), fetchImpl, governor: { decision: () => ({ rerankAllowed: allowed }) } });
  assert.equal(r.available(), false);
  await assert.rejects(() => r.rerank('q', ['a', 'b']), (e) => e.code === 'RERANK_NOT_ALLOWED');
  allowed = true;
  assert.equal(r.available(), true);
  assert.deepEqual(await r.rerank('q', ['a', 'b']), [0.1, 0.9]);
  assert.match(calls[0].url, /\/v1\/rerank$/);
  assert.deepEqual(calls[0].body.documents, ['a', 'b']);
  r.dispose();
});

// ── SelfProfile / Sanitizer / 队列 ─────────────────────────────────────

test('核心自我：读私有 kit 的 core-self.md（路径在配置里，仓库里没有人设）；改了重读；没配就是空', () => {
  const dir = tmpDir('self');
  const file = path.join(dir, 'core-self.md');
  fs.writeFileSync(file, '﻿说话温和，偶尔调皮。\n');
  const h = hostWith({ self: { coreSelfFile: file, principalLabel: '主人' } });
  const sp = createSelfProfile({ hostConfig: h });
  assert.equal(sp.coreSelf().text, '说话温和，偶尔调皮。');
  assert.match(sp.coreSelf().hash, /^[0-9a-f]{16}$/);
  assert.equal(sp.principalLabel(), '主人');
  assert.equal(sp.locale, 'zh');
  const before = sp.coreSelf().hash;
  fs.writeFileSync(file, '说话温和。');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
  assert.equal(sp.refresh(), true);
  assert.notEqual(sp.coreSelf().hash, before);
  assert.deepEqual(createSelfProfile({ hostConfig: hostWith() }).coreSelf(), { text: '', hash: 'empty' });
  rmDir(dir);
});

test('清洗：进提示词前【】换成「」、拆开 {{ }}（F2）、去不可见字符；适配器的平台转义按来源叠加', () => {
  const s = createSanitizer();
  assert.equal(s.forPrompt('【唤醒】{{cwd}}​好'), '「唤醒」{ {cwd} }好');
  assert.equal(s.forStore('原文【】', { adapter: 'qq' }), '原文【】', '入库时宿主这一层不改原文');
  const off = s.register('qq', { forStore: (t) => t.replace('秘密', '**'), forPrompt: (t) => t.replace('X', 'Y') });
  assert.equal(s.forStore('有秘密', { adapter: 'qq' }), '有**');
  assert.equal(s.forStore('有秘密', { adapter: 'web' }), '有秘密');
  assert.equal(s.forPrompt('X'), 'Y');
  off();
  assert.equal(s.forPrompt('X'), 'X');
});

test('任务队列：并发上限、最小间隔、按优先级取；排队中取消直接拒绝', async () => {
  const clock = clockAt();
  const q = new TaskQueue({ concurrency: 1, now: () => Date.now() });
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const a = q.run(async () => { order.push('a'); await gate; });
  const b = q.run(async () => { order.push('b'); }, { priority: 5 });
  const c = q.run(async () => { order.push('c'); }, { priority: 0 });
  const ac = new AbortController();
  const d = q.run(async () => { order.push('d'); }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(d);
  release();
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['a', 'c', 'b']);
  void clock;
  const spaced = new TaskQueue({ concurrency: 1, minSpacingMs: 30 });
  const t0 = Date.now();
  await Promise.all([spaced.run(async () => {}), spaced.run(async () => {})]);
  assert.ok(Date.now() - t0 >= 25, '两次之间至少隔 minSpacingMs');
});

test('LLMPort：DeepSeek 账号提供方把 402 改写成 ACCOUNT_QUOTA，同样通知余额保护', async () => {
  const ctx = new FakeDshCtx();
  let quota = 0;
  ctx.llmScript = () => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'ACCOUNT_QUOTA', message: 'x' } } }];
  const q = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith(), budget: { notifyQuota: () => { quota += 1; } } });
  await assert.rejects(() => q.complete({ use: 'review', system: '', messages: [] }), (e) => e.code === 'ACCOUNT_QUOTA');
  assert.equal(quota, 1);
  // 流本身抛出带 code 的错误也认
  ctx.llmScript = () => [Object.assign(new Error('quota'), { code: 'ACCOUNT_QUOTA' })];
  await assert.rejects(() => q.complete({ use: 'review', system: '', messages: [] }), (e) => e.code === 'ACCOUNT_QUOTA');
  assert.equal(quota, 2);
});

test('预算：报了 402 又没有余额来源——停一阵（quotaProbeMs）再放一次试试，不会一直停到 DSH 重启；有可信的余额读数时按读数', () => {
  const env = budgetEnv();
  env.b.notifyQuota();
  assert.equal(env.b.allow('extract', 10), false);
  assert.equal(env.b.status().pausedReason, 'quota');
  env.clock.advance(19 * 60_000);
  env.b.refreshBalance();
  assert.equal(env.b.allow('extract', 10), false, '还没到试探的时候');
  env.clock.advance(2 * 60_000);
  assert.equal(env.b.allow('extract', 10), true, '20 分钟后放一次试试');
  env.b.notifyQuota();
  assert.equal(env.b.allow('extract', 10), false, '再失败再停');
  // 有余额来源、读到余额是 0：不试探，按读数停着
  const dir = tmpDir('budget-probe');
  const balFile = path.join(dir, 'balance.json');
  fs.writeFileSync(balFile, JSON.stringify({ balance: 0 }));
  const real = budgetEnv({ host: { budget: { balance: { file: balFile, path: 'balance', everyMs: 0 } } } });
  real.b.refreshBalance();
  real.b.notifyQuota();
  real.clock.advance(60 * 60_000);
  real.b.refreshBalance();
  assert.equal(real.b.allow('extract', 10), false);
  rmDir(dir);
});

test('预算：余额还能撑几天按整个账户算——别的会话花的、余额每天掉的都算进去，余额保护不会来得太晚', () => {
  const dir = tmpDir('budget-acct');
  const balFile = path.join(dir, 'balance.json');
  fs.writeFileSync(balFile, JSON.stringify({ balance: 16 }));
  const clock = clockAt(Date.UTC(2026, 10, 4, 13, 0));   // 北京时间 21:00（谷时）
  const env = budgetEnv({ clock, core: { budget: { preset: 'saving' } }, host: { budget: { balance: { file: balFile, path: 'balance', everyMs: 0 } } } });
  // 她的会话和后台一天 1 元；主人写代码的会话一天 8 元（同一个账户）
  env.b.recordMainChat({ in: 500_000, cached: 0, out: 0 });
  env.b.record('extract', { in: 500_000, cached: 0, out: 0 });
  env.b.recordAccountChat({ in: 500_000, cached: 0, out: 0 });
  env.b.recordAccountChat({ in: 8_000_000, cached: 0, out: 0 });
  env.b.refreshBalance();
  const days = env.b.state().daysOfBalance;
  assert.ok(days < 3, `按账户的花费算：剩 ${days} 天，节省档 3 天的保护触发`);
  assert.equal(env.b.state().paused, true);
  // 余额每天掉多少：没有用量记录也看得出来（账户在别处花钱）
  const env2 = budgetEnv({ clock: clockAt(Date.UTC(2026, 10, 4, 0, 0)), host: { budget: { balance: { file: balFile, path: 'balance', everyMs: 0 } } } });
  fs.writeFileSync(balFile, JSON.stringify({ balance: 10 }));
  env2.b.refreshBalance();
  env2.clock.advance(12 * 3_600_000);
  fs.writeFileSync(balFile, JSON.stringify({ balance: 4 }));
  env2.b.refreshBalance();
  assert.ok(Math.abs(env2.b.status().balance.dropPerDay - 12) < 1e-6, '12 小时掉 6 元 = 一天 12 元');
  assert.equal(env2.b.state().paused, true, '剩 4 元不够一天');
  // 充了值（读数涨了）：只看充值之后的那一段
  fs.writeFileSync(balFile, JSON.stringify({ balance: 100 }));
  env2.clock.advance(60_000);
  env2.b.refreshBalance();
  assert.equal(env2.b.status().balance.dropPerDay, 0);
  assert.equal(env2.b.state().paused, false);
  rmDir(dir);
});

test('第一眼（D106）：LLMPort 认 use=glance（单独一条队列、自己的模型和超时）；预算超了每天的上限以后还有 glanceReservePerDay 的预留，余额保护照样挡', async () => {
  const ctx = new FakeDshCtx();
  const llm = createLlmPort({ getLlm: () => ctx.llm, hostConfig: hostWith() });
  const r = await llm.complete({ use: 'glance', system: '数据', messages: [{ role: 'user', content: '一张卡片' }], maxTokens: 600 });
  assert.equal(r.model, 'deepseek-flash');
  assert.equal(llm.status().byUse.glance, 1);
  assert.equal(llm.status().queued.glance, 0);
  const { b } = budgetEnv({ core: { budget: { glanceReservePerDay: 2, overrides: { dailyCalls: 0 } } } });
  assert.equal(b.allow('extract', 1), false);
  assert.equal(b.allow('glance', 1, { reserved: true }), true, '超了以后的预留');
  assert.equal(b.allow('glance', 1, { reserved: true }), true);
  assert.equal(b.allow('glance', 1, { reserved: true }), false, '预留用完');
  assert.equal(b.allow('glance', 1), false, '不带 reserved 的不占预留');
  const p = budgetEnv({ core: { budget: { glanceReservePerDay: 5 } } }).b;
  p.notifyQuota();
  assert.equal(p.allow('glance', 1, { reserved: true }), false, '余额保护时不放');
});
