// 查询嵌入的重试（D117，实测问题 #28）：端口很快就报错（连接被重置、模型正在重载返回 5xx……；不是慢）、截止时间还够时，
// 在截止时间里再试 embedding.queryRetries 次（每次先等 queryRetryBackoffMs × 次数，剩下不到 queryRetryMinLeftMs 就不试）。
// 慢（到截止没回来）照旧不重试：那一次照样做完，结果进缓存给下一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, WrapPort, FakeEmbedding } from './_helpers.js';
import { fakePorts } from '../fakes/index.js';

const W = (core) => core.mods.worker;
const metrics = (core) => Object.fromEntries(core.store.all("SELECT name, value FROM metrics WHERE name LIKE 'embed.query%'").map((x) => [x.name, x.value]));

/** 查询调用的前 n 次很快就报错（像 Ollama 换参数重载时那样），之后正常。 */
function flaky(n, { code = 'EMBED_HTTP_500' } = {}) {
  const emb = new FakeEmbedding();
  const state = { left: n, queryCalls: 0 };
  const port = new WrapPort(emb, {
    before: async (texts, kind) => {
      if (kind !== 'query') return;
      state.queryCalls += 1;
      if (state.left > 0) { state.left -= 1; throw Object.assign(new Error('模型正在重载'), { code }); }
    },
  });
  return { emb, port, state };
}

test('很快就报错一次、截止时间还够：再试一次拿到向量；计 embed.query.retry / retryOk，不算失败，不熔断', async () => {
  const { port, state } = flaky(1);
  const { core, cleanup } = await workerCore({ name: 'worker-retry-ok', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    const before = state.queryCalls;
    const r = await W(core).embedQuery(core, ['还记得那只小狗吗'], { deadlineMs: 1500 });
    assert.ok(r?.vectors?.length === 1, '拿到了向量');
    assert.equal(state.queryCalls - before, 2, '调了两次端口');
    const h = W(core).health(core);
    assert.equal(h.breakerOpen, false);
    assert.equal(h.query.error, 0);
    await W(core).runEmbedQueue(core, {});   // 每一轮先把计数记进 metrics
    const m = metrics(core);
    assert.equal(m['embed.query.retry'], 1);
    assert.equal(m['embed.query.retryOk'], 1);
    assert.equal(m['embed.query.failed'] ?? 0, 0);
  } finally { await cleanup(); }
});

test('剩下的时间不够（< queryRetryMinLeftMs + backoff）：不重试，照旧按失败返回 null', async () => {
  const { port, state } = flaky(1);
  const { core, cleanup } = await workerCore({ name: 'worker-retry-short', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    const before = state.queryCalls;
    assert.equal(await W(core).embedQuery(core, ['一'], { deadlineMs: 300 }), null);
    assert.equal(state.queryCalls - before, 1);
    assert.equal(W(core).health(core).query.error, 1);
  } finally { await cleanup(); }
});

test('queryRetries: 0 → 不重试；再试也失败 → 只算一次失败（这一次查询），熔断照旧按端口的真失败记', async () => {
  const a = flaky(1);
  const one = await workerCore({ name: 'worker-retry-off', ports: fakePorts({ embedding: a.port }), config: { embedding: { queryRetries: 0 } } });
  try {
    await W(one.core).ensureSpace(one.core);
    const before = a.state.queryCalls;
    assert.equal(await W(one.core).embedQuery(one.core, ['一'], { deadlineMs: 1500 }), null);
    assert.equal(a.state.queryCalls - before, 1);
  } finally { await one.cleanup(); }
  const b = flaky(5);
  const two = await workerCore({ name: 'worker-retry-fail', ports: fakePorts({ embedding: b.port }) });
  try {
    await W(two.core).ensureSpace(two.core);
    const before = b.state.queryCalls;
    assert.equal(await W(two.core).embedQuery(two.core, ['二'], { deadlineMs: 1500 }), null);
    assert.equal(b.state.queryCalls - before, 2, '试了两次');
    assert.equal(W(two.core).health(two.core).query.error, 1, '这一次查询算一次失败');
  } finally { await two.cleanup(); }
});

test('慢（到截止没回来）不重试：那一次照样做完，结果进缓存，下一次直接用上', async () => {
  const emb = new FakeEmbedding({ delayMs: 400 });
  const calls = { query: 0 };
  const port = new WrapPort(emb, { before: async (t, kind) => { if (kind === 'query') calls.query += 1; } });
  const { core, cleanup } = await workerCore({ name: 'worker-retry-slow', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    const before = calls.query;
    assert.equal(await W(core).embedQuery(core, ['慢的那一句'], { deadlineMs: 150 }), null);
    assert.equal(calls.query - before, 1, '没有再发');
    await new Promise((r) => setTimeout(r, 600));
    const r = await W(core).embedQuery(core, ['慢的那一句'], { deadlineMs: 150 });
    assert.ok(r?.vectors?.length === 1, '晚到的进了缓存');
    assert.equal(calls.query - before, 1);
  } finally { await cleanup(); }
});

test('一次查询的两次尝试都很快报错：熔断只记一次失败（不打开），端口好了下一次查询照常拿到向量（D117 评审）', async () => {
  const { port, state } = flaky(2);
  const { core, cleanup } = await workerCore({ name: 'worker-retry-breaker', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    const before = state.queryCalls;
    assert.equal(await W(core).embedQuery(core, ['第一句'], { deadlineMs: 1500 }), null);
    assert.equal(state.queryCalls - before, 2, '试了两次');
    assert.equal(W(core).health(core).breakerOpen, false, '一次查询最多算一次熔断失败');
    const r = await W(core).embedQuery(core, ['第二句'], { deadlineMs: 1500 });
    assert.ok(r?.vectors?.length === 1, '端口好了：照常拿到');
    assert.equal(state.queryCalls - before, 3);
  } finally { await cleanup(); }
});
