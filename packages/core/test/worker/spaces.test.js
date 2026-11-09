// 向量空间（§8.9、§8.6.1、§13.2）：建空间和探针、模型被悄悄换过（suspect）、换档走影子空间、新写入两边都嵌、切换和回滚。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, MultiSpacePort, WrapPort, FakeEmbedding } from './_helpers.js';
import { fakePorts } from '../fakes/index.js';

const W = (core) => core.mods.worker;
const DAY = 86_400_000;

test('ensureSpace：建活动空间并存 20 条探针向量；再来一次探针一致', async () => {
  const emb = new FakeEmbedding({ dim: 64 });
  const { core, cleanup } = await workerCore({ name: 'worker-space', embedding: emb });
  try {
    const r = await W(core).ensureSpace(core);
    assert.deepEqual(r, { spaceId: emb.spaceId, status: 'active' });
    const row = core.store.get('SELECT * FROM vector_spaces');
    assert.equal(row.status, 'active');
    assert.equal(row.model, 'fake-ngram');
    assert.equal(row.dim, 64);
    assert.equal(row.probe_vectors.byteLength, 20 * 64 * 4);
    const again = await W(core).ensureSpace(core);
    assert.equal(again.status, 'active');
    assert.ok(again.meanCos > 0.9999);
    assert.equal(core.store.get('SELECT count(*) AS n FROM vector_spaces').n, 1);
    assert.deepEqual(W(core).spaces(core).map((s) => [s.spaceId, s.status]), [[emb.spaceId, 'active']]);
  } finally { await cleanup(); }
});

test('探针：同一个空间 id 下模型被悄悄换过 → suspect，降到 L3；模型换回来 → 重新启用，旧向量照用', async () => {
  const real = new FakeEmbedding();
  const port = new WrapPort(real);
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-suspect', ports });
  try {
    addText(core, 'assertion', 1, '主人说他最近总是失眠');
    await drainQueue(core);
    // 「自动升级」：空间 id 没变，向量变了
    const other = new FakeEmbedding({ synonyms: [['失眠', '睡不着'], ['最近', '这阵子']], model: 'fake-ngram' });
    port.inner = other;
    port.spaceIdOverride = real.spaceId;
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'suspect');
    assert.ok(r.meanCos < 0.999);
    assert.equal(core.store.get('SELECT status FROM vector_spaces').status, 'suspect');
    assert.equal(await W(core).embedQuery(core, ['睡得好吗'], { deadlineMs: 500 }), null);
    assert.equal(W(core).health(core).dense, false);
    assert.ok(core.log.events?.('worker.space.suspect')?.length >= 1);
    // 换回原来的模型：重新确认后启用，已经存好的向量还能用
    port.inner = real;
    port.spaceIdOverride = undefined;
    const back = await W(core).ensureSpace(core);
    assert.equal(back.status, 'active');
    const qv = await W(core).embedQuery(core, ['主人最近睡得好吗'], { deadlineMs: 500 });
    const hits = (await W(core).denseSearch(core, { vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 1000 })).hits;
    assert.equal(hits[0].ref, 'a1');
    assert.equal(core.store.get('SELECT status FROM embed_texts').status, 'done');
  } finally { await cleanup(); }
});

test('主人确认「就用现在这个模型」（rebaseline）：重新存探针，旧向量删掉，全部重嵌', async () => {
  const real = new FakeEmbedding();
  const port = new WrapPort(real);
  const { core, cleanup } = await workerCore({ name: 'worker-rebaseline', ports: fakePorts({ embedding: port }) });
  try {
    addText(core, 'assertion', 1, '一条记忆');
    await drainQueue(core);
    port.mapVectors = (v) => Float32Array.from(v).reverse();   // 同一个空间 id，换了一个「模型」
    assert.equal((await W(core).ensureSpace(core)).status, 'suspect');
    const a = await W(core).activateSpace(core, real.spaceId, { rebaseline: true });
    assert.deepEqual(a, { ok: true });
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 0);
    assert.equal(core.store.get('SELECT status FROM embed_texts').status, 'pending');
    await drainQueue(core);
    assert.equal((await W(core).ensureSpace(core)).status, 'active');
  } finally { await cleanup(); }
});

test('换档：新空间建成影子，新写入两边都嵌，影子重嵌补齐旧的；期间召回用旧空间；评测通过后切换，旧空间退役 14 天后删向量', async () => {
  const small = new FakeEmbedding({ dim: 64, model: 'small' });
  const big = new FakeEmbedding({ dim: 128, model: 'big' });
  const port = new MultiSpacePort({ small, big }, 'small');
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-shadow', ports });
  try {
    for (let i = 1; i <= 6; i++) addText(core, 'assertion', i, `旧记忆 ${i}：主人说过的第 ${i} 件事`);
    await drainQueue(core);
    // 主人在管理页换到 big：端口的 info() 变了，但还能按空间产 small 的向量
    port.current = 'big';
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'active');
    assert.equal(r.spaceId, small.spaceId);
    assert.equal(r.shadow, big.spaceId);
    assert.equal(core.store.get("SELECT status FROM vector_spaces WHERE space_id = ?", big.spaceId).status, 'shadow');
    // 查询仍在旧空间
    const qv = await W(core).embedQuery(core, ['主人说过的第 3 件事'], { deadlineMs: 500 });
    assert.equal(qv.spaceId, small.spaceId);
    assert.equal(qv.vectors[0].length, 64);
    // 新写入：两边都嵌
    addText(core, 'assertion', 7, '新记忆：两边都要有');
    await W(core).runEmbedQueue(core, { maxBatches: 1 });
    const id7 = core.store.get('SELECT id FROM embed_texts WHERE owner_id = 7').id;
    assert.deepEqual(core.vectors.all('SELECT space_id FROM vectors WHERE embed_text_id = ? ORDER BY space_id', id7).map((x) => x.space_id).sort(), [big.spaceId, small.spaceId].sort());
    // 影子重嵌补齐
    const sh = await W(core).shadowReembed(core, { spaceId: big.spaceId });
    assert.equal(sh.coverage, 1);
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors WHERE space_id = ?', big.spaceId).n, 7);
    // 端口还能产旧空间：不自动切换，等评测（activateSpace）
    assert.equal(W(core).activeSpaceId(core), small.spaceId);
    assert.deepEqual(await W(core).activateSpace(core, 'nope'), { ok: false, reason: 'unknown-space' });
    assert.deepEqual(await W(core).activateSpace(core, big.spaceId), { ok: true });
    assert.equal(W(core).activeSpaceId(core), big.spaceId);
    assert.equal(core.store.get('SELECT status FROM vector_spaces WHERE space_id = ?', small.spaceId).status, 'retired');
    assert.ok(core.store.all('SELECT status, space_id FROM embed_texts').every((x) => x.status === 'done' && x.space_id === big.spaceId));
    const q2 = await W(core).embedQuery(core, ['主人说过的第 3 件事'], { deadlineMs: 500 });
    assert.equal(q2.spaceId, big.spaceId);
    const hits = (await W(core).denseSearch(core, { vectors: q2.vectors, spaceId: q2.spaceId, layers: ['memory'], topK: { memory: 3, raw: 0 }, includeCold: false }, { deadlineMs: 1000 })).hits;
    assert.equal(hits[0].ref, 'a3');
    // 14 天内可以切回；过了 14 天清扫删掉旧空间的向量
    ports.clock.advance(15 * DAY);
    const before = core.vectors.get('SELECT count(*) AS n FROM vectors WHERE space_id = ?', small.spaceId).n;
    assert.ok(before > 0);
    W(core).sweepVectors(core);
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors WHERE space_id = ?', small.spaceId).n, 0);
    assert.equal((await W(core).activateSpace(core, small.spaceId)).reason, 'expired');
  } finally { await cleanup(); }
});

test('影子空间没补齐时不让切换（除非 force）', async () => {
  const a = new FakeEmbedding({ dim: 32, model: 'a' });
  const b = new FakeEmbedding({ dim: 32, model: 'b' });
  const port = new MultiSpacePort({ a, b }, 'a');
  const { core, cleanup } = await workerCore({ name: 'worker-shadow-gate', ports: fakePorts({ embedding: port }) });
  try {
    for (let i = 1; i <= 3; i++) addText(core, 'assertion', i, `记忆 ${i}`);
    await drainQueue(core);
    port.current = 'b';
    await W(core).ensureSpace(core);
    const r = await W(core).activateSpace(core, b.spaceId);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'coverage');
  } finally { await cleanup(); }
});

test('端口换了模型、却产不出旧空间：查询降到 L3，影子补齐后自动切换', async () => {
  const old = new FakeEmbedding({ dim: 64, model: 'old' });
  const neu = new FakeEmbedding({ dim: 64, model: 'new' });
  const port = new WrapPort(old);
  const { core, cleanup } = await workerCore({ name: 'worker-unproducible', ports: fakePorts({ embedding: port }) });
  try {
    for (let i = 1; i <= 5; i++) addText(core, 'assertion', i, `记忆 ${i}`);
    await drainQueue(core);
    port.inner = neu;   // 只会产新空间
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.shadow, neu.spaceId);
    assert.equal(await W(core).embedQuery(core, ['记忆 2'], { deadlineMs: 500 }), null);
    // 伪查询向量还是旧空间的（L3）
    assert.equal((await W(core).storedVectors(core, ['a2'])).size, 1);
    await drainQueue(core);
    assert.equal(W(core).activeSpaceId(core), neu.spaceId);
    const qv = await W(core).embedQuery(core, ['记忆 2'], { deadlineMs: 500 });
    assert.equal(qv.spaceId, neu.spaceId);
    assert.ok(core.store.all('SELECT status FROM embed_texts').every((x) => x.status === 'done'));
  } finally { await cleanup(); }
});

test('刚装好就换档（旧空间里没有任何向量）：直接换，不等影子', async () => {
  const old = new FakeEmbedding({ dim: 32, model: 'old' });
  const neu = new FakeEmbedding({ dim: 32, model: 'new' });
  const port = new WrapPort(old);
  const { core, cleanup } = await workerCore({ name: 'worker-fresh-switch', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    port.inner = neu;
    const r = await W(core).ensureSpace(core);
    assert.deepEqual(r, { spaceId: neu.spaceId, status: 'active' });
  } finally { await cleanup(); }
});
