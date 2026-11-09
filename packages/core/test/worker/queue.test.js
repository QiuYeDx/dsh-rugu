// 嵌入队列（§7.6）：embed_texts 的登记、优先级、让路、熔断、失败重试、积压推到夜里、彻底删除先删向量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, WrapPort, FakeEmbedding } from './_helpers.js';
import { fakePorts, FakeLogger } from '../fakes/index.js';

const W = (core) => core.mods.worker;
const rowsOf = (core, kind, id) => core.store.all('SELECT * FROM embed_texts WHERE owner_kind = ? AND owner_id = ? ORDER BY kind, chunk_no', kind, id);

test('enqueueEmbed：新块 pending；文本没变不动；变了 done → stale；同一 kind 里没再出现的旧块连向量一起删', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-enqueue' });
  try {
    core.store.tx(() => W(core).enqueueEmbed(core, { kind: 'assertion', id: 1 }, [
      { chunkNo: 0, kind: 'text', text: '主人说他去驿站取了包裹' },
      { chunkNo: 1, kind: 'fq', text: '快递拿了没' },
      { chunkNo: 2, kind: 'fq', text: '包裹到了吗' },
    ], { layer: 'memory', priority: 2 }));
    let rows = rowsOf(core, 'assertion', 1);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === 'pending' && r.layer === 'memory' && r.priority === 2 && r.hash.length === 32));
    await drainQueue(core);
    rows = rowsOf(core, 'assertion', 1);
    assert.ok(rows.every((r) => r.status === 'done'));
    const before = rows.map((r) => r.updated_at);
    // 同样的文本再登记一次：什么都不变
    core.mods.worker.enqueueEmbed(core, 'a1', [{ chunkNo: 0, kind: 'text', text: '主人说他去驿站取了包裹' }], { layer: 'memory', priority: 2 });
    assert.deepEqual(rowsOf(core, 'assertion', 1).map((r) => r.updated_at), before);
    // fq 只剩一条、改了文本：旧的 fq 2 连向量删掉，fq 1 变 stale，text 块不受影响
    W(core).enqueueEmbed(core, { kind: 'assertion', id: 1 }, [{ chunkNo: 1, kind: 'fq', text: '快递取回来了吗' }], { layer: 'memory', priority: 2 });
    rows = rowsOf(core, 'assertion', 1);
    assert.deepEqual(rows.map((r) => `${r.kind}${r.chunk_no}:${r.status}`), ['fq1:stale', 'text0:done']);
    const vecIds = core.vectors.all("SELECT embed_text_id AS id FROM vectors WHERE owner_kind = 'assertion' AND owner_id = 1").map((r) => r.id).sort();
    assert.deepEqual(vecIds, rows.map((r) => r.id).sort());
    // 回滚的事务什么都不留
    assert.throws(() => core.store.tx(() => {
      W(core).enqueueEmbed(core, { kind: 'episode', id: 9 }, [{ chunkNo: 0, kind: 'text', text: '这段不会留下' }], { layer: 'memory', priority: 2 });
      throw new Error('rollback');
    }));
    assert.equal(rowsOf(core, 'episode', 9).length, 0);
    assert.throws(() => W(core).enqueueEmbed(core, { kind: 'nope', id: 1 }, [], { layer: 'memory', priority: 2 }), TypeError);
    assert.throws(() => W(core).enqueueEmbed(core, { kind: 'episode', id: 1 }, [], { layer: 'disk', priority: 2 }), TypeError);
  } finally { await cleanup(); }
});

test('runEmbedQueue：按优先级（原文窗口先），记忆层存 f32、原文层不存；第一次自动建活动空间', async () => {
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-queue', embedding: port });
  try {
    addText(core, 'assertion', 1, '他说下周要搬家');
    addText(core, 'assertion', 2, '阿明换了新工作');
    addText(core, 'window', 1, '[10/31 20:01] 甲：我到驿站了\n[10/31 20:02] 乙：取到没', { layer: 'raw' });
    const r = await W(core).runEmbedQueue(core, { maxBatches: 1, batchSize: 1 });
    assert.equal(r.embedded, 1);
    const first = core.store.get("SELECT owner_kind FROM embed_texts WHERE status = 'done'");
    assert.equal(first.owner_kind, 'window');   // 优先级 1 先
    const space = core.store.get("SELECT * FROM vector_spaces WHERE status = 'active'");
    assert.equal(space.space_id, emb.spaceId);
    assert.equal(space.dim, 256);
    assert.equal(space.probe_vectors.byteLength, 20 * 256 * 4);
    await drainQueue(core);
    const vecs = core.vectors.all('SELECT owner_kind, layer, f32, q8, bin, space_id FROM vectors ORDER BY owner_kind');
    assert.equal(vecs.length, 3);
    for (const v of vecs) {
      assert.equal(v.space_id, emb.spaceId);
      assert.equal(v.q8.byteLength, 256);
      assert.equal(v.bin.byteLength, 32);
      if (v.layer === 'memory') assert.equal(v.f32.byteLength, 256 * 4);
      else assert.equal(v.f32, null);
    }
    assert.ok(core.store.all('SELECT status, space_id FROM embed_texts').every((x) => x.status === 'done' && x.space_id === emb.spaceId));
    assert.ok(port.calls.filter((c) => c.kind === 'doc').length >= 3);
    // 日志里没有内容
    /** @type {FakeLogger} */ (core.log).assertNoText?.('驿站', '搬家', '阿明');
  } finally { await cleanup(); }
});

test('有查询在等时文档批让路', async () => {
  const order = [];
  const emb = new FakeEmbedding({ delayMs: 30 });
  const port = new WrapPort(emb, { before: (texts, kind) => { order.push(kind); } });
  const { core, cleanup } = await workerCore({ name: 'worker-yield', embedding: port });
  try {
    await W(core).ensureSpace(core);
    order.length = 0;
    addText(core, 'assertion', 1, '一条要嵌的记忆');
    const q = W(core).embedQuery(core, ['快递拿了没'], { deadlineMs: 2000 });
    const d = W(core).runEmbedQueue(core, {});
    const [qr] = await Promise.all([q, d]);
    assert.ok(qr && qr.vectors.length === 1);
    assert.deepEqual(order.slice(0, 2), ['query', 'doc']);
  } finally { await cleanup(); }
});

test('熔断：连续 2 次失败后 60 秒内不调；之后放一次探测，成功就恢复', async () => {
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb);
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-breaker', ports });
  try {
    await W(core).ensureSpace(core);
    for (let i = 1; i <= 5; i++) addText(core, 'assertion', i, `记忆 ${i}`);
    emb.setFailing(true);
    const r1 = await W(core).runEmbedQueue(core, { batchSize: 1 });
    assert.equal(r1.embedded, 0);
    assert.equal(r1.failed, 2);   // 第二次失败就熔断，不再继续
    const n = port.calls.length;
    const r2 = await W(core).runEmbedQueue(core, { batchSize: 1 });
    assert.equal(r2.breaker, true);
    assert.equal(await W(core).embedQuery(core, ['还在吗'], { deadlineMs: 500 }), null);
    assert.equal(port.calls.length, n);   // 熔断期间一次都没调
    assert.equal(W(core).health(core).breakerOpen, true);
    emb.setFailing(false);
    ports.clock.advance(61_000);
    const r3 = await W(core).runEmbedQueue(core, { batchSize: 2 });
    assert.equal(r3.embedded, 5);
    assert.equal(W(core).health(core).breakerOpen, false);
    assert.ok(await W(core).embedQuery(core, ['恢复了'], { deadlineMs: 500 }));
    // 探测失败：立刻又熔断
    emb.setFailing(true);
    await W(core).embedQuery(core, ['a'], { deadlineMs: 500 });
    await W(core).embedQuery(core, ['b'], { deadlineMs: 500 });
    assert.equal(W(core).health(core).breakerOpen, true);
    ports.clock.advance(61_000);
    assert.equal(await W(core).embedQuery(core, ['c'], { deadlineMs: 500 }), null);   // 这是那一次探测，又失败了
    assert.equal(W(core).health(core).breakerOpen, true);
  } finally { await cleanup(); }
});

test('失败到上限标 failed；夜里重试一天前失败的；坏向量只记那一行', async () => {
  const emb = new FakeEmbedding();
  let bad = '';
  const port = new WrapPort(emb, { mapVectors: (v, i, text) => (text === bad ? new Float32Array(v.length).fill(Number.NaN) : v) });
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-fail', ports, config: { embedding: { maxAttempts: 2 } } });
  try {
    await W(core).ensureSpace(core);
    bad = '坏的那条';
    addText(core, 'assertion', 1, '好的那条');
    addText(core, 'assertion', 2, bad);
    await W(core).runEmbedQueue(core, {});
    assert.equal(core.store.get("SELECT status FROM embed_texts WHERE owner_id = 1").status, 'done');
    assert.equal(core.store.get("SELECT status, attempts FROM embed_texts WHERE owner_id = 2").attempts, 1);
    await W(core).runEmbedQueue(core, {});
    assert.equal(core.store.get("SELECT status FROM embed_texts WHERE owner_id = 2").status, 'failed');
    assert.equal((await W(core).runEmbedQueue(core, {})).failed, 0);   // failed 白天不重试
    bad = '';
    ports.clock.advance(25 * 3_600_000);
    const r = await W(core).runEmbedQueue(core, { night: true });
    assert.equal(r.embedded, 1);
    assert.equal(core.store.get("SELECT status FROM embed_texts WHERE owner_id = 2").status, 'done');
  } finally { await cleanup(); }
});

test('CPU 上积压超过 1 小时的工作量：白天只嵌原文窗口，其余推到夜里', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-backlog', config: { embedding: { msPerText: { cpu: 3_600_000 } } } });
  try {
    await W(core).ensureSpace(core);
    addText(core, 'assertion', 1, '新记忆一');
    addText(core, 'assertion', 2, '新记忆二');
    addText(core, 'window', 1, '原文窗口', { layer: 'raw' });
    const day = await W(core).runEmbedQueue(core, {});
    assert.equal(day.embedded, 1);
    assert.equal(core.store.get("SELECT status FROM embed_texts WHERE owner_kind = 'window'").status, 'done');
    assert.equal(core.store.get("SELECT count(*) AS n FROM embed_texts WHERE status = 'pending'").n, 2);
    const night = await W(core).runEmbedQueue(core, { night: true });
    assert.equal(night.embedded, 2);
  } finally { await cleanup(); }
});

test('嵌的时候文本又变了：这条向量作废，行留给下一轮', async () => {
  let core;
  let once = true;
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb, {
    before: (texts, kind) => {
      if (kind === 'doc' && once && texts.includes('旧文本')) {
        once = false;
        core.mods.worker.enqueueEmbed(core, { kind: 'assertion', id: 1 }, [{ chunkNo: 0, kind: 'text', text: '新文本' }], { layer: 'memory', priority: 2 });
      }
    },
  });
  const t = await workerCore({ name: 'worker-race', embedding: port });
  core = t.core;
  try {
    await core.mods.worker.ensureSpace(core);
    addText(core, 'assertion', 1, '旧文本');
    const r = await core.mods.worker.runEmbedQueue(core, { maxBatches: 1 });
    assert.equal(r.embedded, 0);
    const row = core.store.get('SELECT status, text FROM embed_texts WHERE owner_id = 1');
    assert.equal(row.text, '新文本');
    assert.equal(row.status, 'pending');
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 0);
    await drainQueue(core);
    assert.equal(core.store.get('SELECT status FROM embed_texts WHERE owner_id = 1').status, 'done');
  } finally { await t.cleanup(); }
});

test('dropEmbeddings：先删向量再删嵌入文本；可以重跑', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-drop' });
  try {
    addText(core, 'assertion', 1, '要被彻底删除的');
    addText(core, 'assertion', 2, '留着的');
    addText(core, 'window', 3, '原文窗口', { layer: 'raw' });
    await drainQueue(core);
    const r = W(core).dropEmbeddings(core, [{ kind: 'assertion', id: 1 }, { kind: 'window', id: 3 }]);
    assert.deepEqual(r, { texts: 2, vectors: 2 });
    assert.deepEqual(core.store.all('SELECT owner_id FROM embed_texts').map((x) => x.owner_id), [2]);
    assert.deepEqual(core.vectors.all('SELECT owner_id FROM vectors').map((x) => x.owner_id), [2]);
    assert.deepEqual(W(core).dropEmbeddings(core, [{ kind: 'assertion', id: 1 }, 'w3', 'garbage']), { texts: 0, vectors: 0 });
    // 删了的不会再被搜到
    const qv = await W(core).embedQuery(core, ['要被彻底删除的'], { deadlineMs: 1000 });
    const hits = (await W(core).denseSearch(core, { vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory', 'raw'], topK: { memory: 10, raw: 10 }, includeCold: true }, { deadlineMs: 1000 })).hits;
    assert.deepEqual(hits.map((h) => h.ref), ['a2']);
  } finally { await cleanup(); }
});

test('没有嵌入端口：队列和查询都安静地降级', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-noport', embedding: null });
  try {
    addText(core, 'assertion', 1, '没有端口也能登记');
    assert.deepEqual(await W(core).runEmbedQueue(core, {}), { embedded: 0, failed: 0 });
    assert.equal(await W(core).embedQuery(core, ['x'], { deadlineMs: 100 }), null);
    assert.deepEqual(await W(core).ensureSpace(core), { spaceId: null, status: 'unavailable' });
    assert.equal(core.store.get('SELECT status FROM embed_texts').status, 'pending');
  } finally { await cleanup(); }
});

test('查询嵌入超时返回 null（慢不算失败）', async () => {
  const emb = new FakeEmbedding({ delayMs: 200 });
  const { core, cleanup } = await workerCore({ name: 'worker-qtimeout', embedding: emb });
  try {
    emb.delayMs = 0;
    await W(core).ensureSpace(core);
    emb.delayMs = 200;
    assert.equal(await W(core).embedQuery(core, ['慢'], { deadlineMs: 20 }), null);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(W(core).health(core).breakerOpen, false);
    emb.delayMs = 0;
    const r = await W(core).embedQuery(core, ['快', '两条'], { deadlineMs: 500 });
    assert.equal(r.vectors.length, 2);
    assert.equal(r.spaceId, emb.spaceId);
  } finally { await cleanup(); }
});
