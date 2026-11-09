// EmbeddingPort 的冷热（实测问题 #1）：模型闲久了被 Ollama 卸掉，下一次查询要先加载好几秒，正好错过回想的截止。
//   预热（warm）、加载参数稳定（GPU 上不带 num_thread）、文档批切片让查询插队、只有服务端报错才算显卡坏了、冷加载和错误看得见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingPort, keepAliveMs } from '../../src/ports/embedding.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const hostWith = (patch = {}) => {
  const h = clone(HOST_DEFAULTS);
  for (const [k, v] of Object.entries(patch)) h[k] = { ...h[k], ...v };
  return () => h;
};
const clockAt = (t0 = Date.UTC(2026, 10, 5, 0, 40)) => { let t = t0; return { now: () => t, advance: (ms) => { t += ms; } }; };
const MIN = 60_000;

/** 假的 Ollama：/api/embed 按 input 回向量；loaded 决定 /api/ps 里有没有模型；loadMs 是回给端口的 load_duration。 */
function fakeOllama({ loaded = true, loadMs = 0, gate = null } = {}) {
  const calls = [];
  const state = { loaded, loadMs, gate, failWith: null };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, body });
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.pathname === '/api/embed') {
      if (state.failWith) { const f = state.failWith; return typeof f === 'number' ? { ok: false, status: f, json: async () => ({}) } : Promise.reject(f); }
      if (state.gate && body.input?.[0] === state.gate.text) await state.gate.promise;
      const ld = state.loaded ? 2e6 : state.loadMs * 1e6;
      if (body.keep_alive !== 0) state.loaded = true; else state.loaded = false;
      return json({ embeddings: (body.input ?? []).map(() => Array.from({ length: 1024 }, (_, j) => (j === 0 ? 1 : 0))), load_duration: ld });
    }
    if (u.pathname === '/api/version') return json({ version: '0.40.13' });
    if (u.pathname === '/api/tags') return json({ models: [{ name: 'qwen3-embedding:4b' }] });
    if (u.pathname === '/api/ps') return json({ models: state.loaded ? [{ name: 'qwen3-embedding:4b', size_vram: 2675 * 1048576 }] : [] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls, state };
}
const embeds = (o) => o.calls.filter((c) => c.path === '/api/embed');

test('keep_alive 换算：单位、秒数、负数 = 一直留着；认不出来按 Ollama 的默认 5 分钟', () => {
  assert.equal(keepAliveMs('2h'), 2 * 60 * MIN);
  assert.equal(keepAliveMs('30m'), 30 * MIN);
  assert.equal(keepAliveMs('45s'), 45_000);
  assert.equal(keepAliveMs(600), 600_000);
  assert.equal(keepAliveMs('-1'), Infinity);
  assert.equal(keepAliveMs(-1), Infinity);
  assert.equal(keepAliveMs('不知道'), 5 * MIN);
});

test('预热：模型不在内存里（健康检查看到的）就发一个空请求加载它，带和查询一样的加载参数和 keep_alive；热着、刚预热过就不发', async () => {
  const o = fakeOllama({ loaded: false, loadMs: 2800 });
  const clock = clockAt();
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now, governor: { decision: () => ({ device: 'gpu', cpuThreads: 4 }) } });
  await e.checkHealth();
  assert.equal(e.health().loaded, false);
  assert.equal(await e.warm(), true);
  const w = embeds(o).at(-1);
  assert.deepEqual(w.body.input, []);
  assert.equal(w.body.keep_alive, '2h');
  assert.deepEqual(w.body.options, { num_ctx: 1024 }, '和查询一样的加载参数，否则查询来时又要重新加载');
  assert.equal(e.status().warms, 1);
  // 刚预热过、刚用过：不再发
  clock.advance(30_000);
  assert.equal(await e.warm(), false);
  await e.embed(['在吗'], 'query');
  clock.advance(10 * MIN);
  assert.equal(await e.warm(), false, '最近用过，模型还热着（keep_alive 2 小时）');
  assert.equal(embeds(o).length, 2);
  // 闲过了 keep_alive，Ollama 卸掉了：下一次有人说话时再预热
  clock.advance(2 * 60 * MIN);
  o.state.loaded = false;
  await e.checkHealth();
  assert.equal(await e.warm(), true);
  // 并发的预热只发一次
  o.state.loaded = false;
  clock.advance(3 * 60 * MIN);
  await e.checkHealth();
  const [a, b] = await Promise.all([e.warm(), e.warm()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(e.status().warms, 3);
  e.dispose();
});

test('预热：熔断中、OpenAI 兼容接口、没有模型时什么都不发，也不抛错', async () => {
  const o = fakeOllama({ loaded: false });
  const clock = clockAt();
  const oa = createEmbeddingPort({ hostConfig: hostWith({ embedding: { provider: 'openai-compat' } }), fetchImpl: o.fetchImpl, now: clock.now });
  assert.equal(await oa.warm(), false);
  const custom = createEmbeddingPort({ hostConfig: hostWith({ embedding: { tier: 'custom' } }), fetchImpl: o.fetchImpl, now: clock.now });
  assert.equal(await custom.warm(), false);
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now });
  o.state.failWith = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  await assert.rejects(() => e.embed(['a'], 'query'));
  await assert.rejects(() => e.embed(['b'], 'query'));
  const n = o.calls.length;
  assert.equal(await e.warm(), false);
  assert.equal(o.calls.length, n);
});

test('冷加载看得见：Ollama 回的 load_duration 超过半秒记一次冷加载和耗时；错误按类型计数，最近一次错误进 status', async () => {
  const o = fakeOllama({ loaded: false, loadMs: 2800 });
  const clock = clockAt();
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now, governor: { decision: () => ({ device: 'gpu' }) } });
  await e.embed(['5'], 'query');
  await e.embed(['6'], 'query');
  const s = e.status();
  assert.equal(s.coldLoads, 1);
  assert.equal(s.lastLoadMs, 2800);
  assert.equal(s.keepAlive, '2h');
  assert.equal(s.device, 'gpu');
  o.state.failWith = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  await assert.rejects(() => e.embed(['7'], 'query'));
  assert.deepEqual(e.status().errors, { TimeoutError: 1 });
  assert.equal(e.status().lastError.code, 'TimeoutError');
});

test('只有服务端报错（5xx）才算显卡坏了：连不上、超时都不让资源管家退回 CPU', async () => {
  const o = fakeOllama();
  const clock = clockAt();
  let gpuErrors = 0;
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now,
    governor: { decision: () => ({ device: 'gpu', cpuThreads: 4 }), reportGpuError: () => { gpuErrors += 1; } } });
  o.state.failWith = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  await assert.rejects(() => e.embed(['a'], 'query'));
  o.state.failWith = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
  await assert.rejects(() => e.embed(['b'], 'query'));
  assert.equal(gpuErrors, 0);
  clock.advance(61_000);
  o.state.failWith = 500;
  await assert.rejects(() => e.embed(['c'], 'query'));
  assert.equal(gpuErrors, 1);
});

test('文档批切成小片排队：中途来的查询只等手上这一片，不等整批', async () => {
  let release;
  const gate = { text: 'd0', promise: new Promise((r) => { release = r; }) };
  const o = fakeOllama({ gate });
  const e = createEmbeddingPort({ hostConfig: hostWith({ embedding: { docSlice: { cpu: 2, gpu: 2 } } }), fetchImpl: o.fetchImpl,
    governor: { decision: () => ({ device: 'gpu' }) } });
  const docs = e.embed(['d0', 'd1', 'd2', 'd3', 'd4', 'd5'], 'doc');
  await new Promise((r) => setTimeout(r, 5));
  const q = e.embed(['问一句'], 'query');
  await new Promise((r) => setTimeout(r, 5));
  release();
  const [d, qr] = await Promise.all([docs, q]);
  assert.equal(d.vectors.length, 6);
  assert.equal(qr.vectors.length, 1);
  assert.deepEqual(embeds(o).map((c) => c.body.input), [['d0', 'd1'], ['问一句'], ['d2', 'd3'], ['d4', 'd5']]);
});

test('换设备：GPU 退回 CPU 先卸掉，最近有人用过就按新设备预热；GPU 上只是线程数变了不重新加载', async () => {
  const o = fakeOllama();
  const clock = clockAt();
  let d = { device: 'gpu', cpuThreads: 4 };
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now, governor: { decision: () => d } });
  await e.embed(['在吗'], 'query');
  const n = embeds(o).length;
  e.onDeviceChange({ device: 'gpu', cpuThreads: 2 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(embeds(o).length, n, 'GPU 上不带 num_thread，线程数变了不用动');
  d = { device: 'cpu', cpuThreads: 2 };
  e.onDeviceChange(d);
  await new Promise((r) => setTimeout(r, 10));
  const after = embeds(o).slice(n);
  assert.equal(after[0].body.keep_alive, 0, '先卸掉 GPU 上的那份');
  assert.deepEqual(after[1].body.input, []);
  assert.deepEqual(after[1].body.options, { num_ctx: 1024, num_gpu: 0, num_thread: 2 }, '按 CPU 的加载参数预热');
  // 很久没人用：换设备不预热（不白占内存）
  clock.advance(3 * 60 * MIN);
  const m = embeds(o).length;
  d = { device: 'gpu', cpuThreads: 4 };
  e.onDeviceChange(d);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(embeds(o).length, m);
});

test('换设备：CPU → GPU（启动探针刚在 CPU 上跑过、健康检查看到模型在内存里）照样按 GPU 预热，不信按名字认的「在内存里」', async () => {
  const o = fakeOllama();
  const clock = clockAt();
  let d = { device: 'cpu', cpuThreads: 4 };
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clock.now, governor: { decision: () => d } });
  await e.embed(['探针'], 'doc');
  await e.checkHealth();
  assert.equal(e.health().loaded, true);
  clock.advance(1000);
  const n = embeds(o).length;
  d = { device: 'gpu', cpuThreads: 4 };
  e.onDeviceChange(d);
  // 预热排队前又查了一次健康（/api/ps 里还是 CPU 上那一份）
  await e.checkHealth();
  await new Promise((r) => setTimeout(r, 10));
  const after = embeds(o).slice(n);
  assert.equal(after.length, 1, '按 GPU 的加载参数预热一次');
  assert.deepEqual(after[0].body.input, []);
  assert.deepEqual(after[0].body.options, { num_ctx: 1024 }, 'GPU：不带 num_gpu、num_thread');
  // 预热过了：再要预热就什么都不发
  clock.advance(60_000);
  assert.equal(await e.warm(), false);
  e.dispose();
});

test('info() 带上健康检查读到的模型指纹（/api/tags 的 digest）；还没查过、或者服务没给就不带', async () => {
  const o = fakeOllama();
  const base = o.fetchImpl;
  let digest = 'sha256:df5bd2e3';
  o.fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/api/tags') return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3-embedding:4b', ...(digest ? { digest } : {}) }] }) };
    return base(url, init);
  };
  const e = createEmbeddingPort({ hostConfig: hostWith(), fetchImpl: o.fetchImpl, now: clockAt().now, governor: { decision: () => ({ device: 'gpu' }) } });
  assert.equal(e.info().digest, undefined);
  await e.checkHealth();
  assert.equal(e.info().digest, 'sha256:df5bd2e3');
  digest = null;
  await e.checkHealth();
  assert.equal(e.info().digest, undefined);
  e.dispose();
});
