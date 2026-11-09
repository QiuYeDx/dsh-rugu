// 真的 worker 线程（H1、§8.7、§7.7 第 10 步）：只读连接、冷加载、增量发布、和主线程引擎结果一致、运维跑在副本上、
// 线程挂了降级并自动重起、stop 之后稠密路 L3。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { workerCore, addText, drainQueue, owner } from './_helpers.js';
import { ftsInsert, ensurePerceptShard } from '../../src/store/index.js';
import { fakePorts, FakeEmbedding } from '../fakes/index.js';

const W = (core) => core.mods.worker;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(20);
  }
}

test('线程：冷加载 + 增量发布；稠密、词法、词频、图扩散的结果和主线程引擎一致', async () => {
  const emb = new FakeEmbedding();
  const { core, cleanup } = await workerCore({ name: 'worker-thread', embedding: emb });
  try {
    // 先在本地模式下嵌一批（start 时线程冷加载它们；start 先清扫，所以主表里要有这些记忆）
    core.store.tx(() => {
      owner(core, 'assertion', 1);
      owner(core, 'window', 2);
      owner(core, 'assertion', 3);
      owner(core, 'entity', 5, { status: 'established', display_name: '主人' });
    });
    addText(core, 'assertion', 1, '主人说楼下新开了一家叫老街口的烧烤店');
    addText(core, 'window', 2, '[11/01 19:00] 主人：今晚吃烧烤', { layer: 'raw' });
    await drainQueue(core);
    const t = core.now();
    core.store.tx((db) => {
      ftsInsert(db, 'assertions_fts', 1, ['烧烤', '老街口', 'ent_5']);
      ftsInsert(db, ensurePerceptShard(db, t), 2, ['烧烤', '今晚']);
      db.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (1, 5, 'subject')");
    });
    const q = await W(core).embedQuery(core, ['那家烧烤店叫啥'], { deadlineMs: 1000 });
    const dq = { vectors: q.vectors, spaceId: q.spaceId, layers: ['memory', 'raw'], topK: { memory: 5, raw: 5 }, includeCold: false };
    const localDense = await W(core).denseSearch(core, dq, { deadlineMs: 2000 });
    const localLex = await W(core).lexicalSearch(core, { terms: ['烧烤'], tables: [W(core).ALL_SHARDS, 'assertions_fts'], limit: 10 }, { deadlineMs: 1000 });
    const localTerms = await W(core).termStats(core, ['烧烤', '没有']);
    const localPpr = await W(core).pprSearch(core, { seeds: [{ entityId: 5, weight: 1 }], maxHops: 2, limit: 10 }, { deadlineMs: 1000 });

    const s = await W(core).start(core);
    assert.deepEqual(s, { ok: true });
    assert.equal(W(core).health(core).mode, 'thread');
    assert.equal(W(core).health(core).readOnlyThreads, true);   // 线程里是真的只读连接（§13.2）
    // 启动后 ensureSpace 再发一次 loadSpace：已经加载过就不重复冷加载，结果照旧
    await W(core).ensureSpace(core);
    const thDense = await W(core).denseSearch(core, dq, { deadlineMs: 2000 });
    assert.deepEqual(thDense.hits.map((h) => h.ref), localDense.hits.map((h) => h.ref));
    for (let i = 0; i < thDense.hits.length; i++) assert.ok(Math.abs(thDense.hits[i].score - localDense.hits[i].score) < 1e-9);
    assert.deepEqual(await W(core).lexicalSearch(core, { terms: ['烧烤'], tables: [W(core).ALL_SHARDS, 'assertions_fts'], limit: 10 }, { deadlineMs: 1000 }), localLex);
    core.state.worker.termCache.clear();
    assert.deepEqual([...(await W(core).termStats(core, ['烧烤', '没有']))], [...localTerms]);
    assert.deepEqual(await W(core).pprSearch(core, { seeds: [{ entityId: 5, weight: 1 }], maxHops: 2, limit: 10 }, { deadlineMs: 1000 }), localPpr);
    const sv = await W(core).storedVectors(core, ['a1', 'w2']);
    assert.equal(sv.size, 2);

    // 增量发布：线程起来之后新嵌的向量不用重启就能搜到
    addText(core, 'assertion', 3, '大家约好下周五晚上在海底捞聚餐');
    await drainQueue(core);
    // FakeEmbedding 是字符 n-gram：查询要和新记忆共享足够多的字，它才稳定排第一
    const q2 = await W(core).embedQuery(core, ['下周五晚上在海底捞聚餐'], { deadlineMs: 1000 });
    const got = await waitFor(async () => {
      const r = await W(core).denseSearch(core, { ...dq, vectors: q2.vectors, layers: ['memory'] }, { deadlineMs: 2000 });
      return r.hits[0]?.ref === 'a3' ? r : null;
    });
    assert.ok(got, '新向量应该发布到线程里');
    // 删掉的也同步删掉
    W(core).dropEmbeddings(core, ['a3']);
    const gone = await waitFor(async () => {
      const r = await W(core).denseSearch(core, { ...dq, vectors: q2.vectors, layers: ['memory'] }, { deadlineMs: 2000 });
      return !r.hits.some((h) => h.ref === 'a3') ? r : null;
    });
    assert.ok(gone);
    // 新建的空间（MRL 之类）由 ensureSpace 发给线程加载：这里重载一下索引也不丢东西
    W(core).reloadIndex(core);
    const again = await W(core).denseSearch(core, dq, { deadlineMs: 2000 });
    assert.deepEqual(again.hits.map((h) => h.ref), localDense.hits.map((h) => h.ref));
    core.log.assertNoText?.('烧烤', '老街口', '海底捞');
  } finally { await cleanup(); }
});

test('线程挂了：降级（稠密 L3、词法主线程限量），冷却后嵌入队列顺手重起', async () => {
  const ports = fakePorts({ embedding: new FakeEmbedding() });
  const { core, cleanup } = await workerCore({ name: 'worker-crash', ports });
  try {
    owner(core, 'assertion', 1);
    addText(core, 'assertion', 1, '一条记忆');
    await drainQueue(core);
    assert.equal((await W(core).start(core)).ok, true);
    await core.state.worker.threads.search.worker.terminate();   // 模拟线程崩溃
    await waitFor(() => W(core).health(core).mode === 'fallback');
    assert.equal(W(core).health(core).mode, 'fallback');
    assert.equal(W(core).health(core).dense, false);
    // 嵌入服务是好的：查询向量照给（外发初筛、对账要用），只是稠密扫描做不了
    const eq = await W(core).embedQuery(core, ['一条记忆'], { deadlineMs: 500 });
    assert.ok(eq && eq.vectors.length === 1);
    const qv = new FakeEmbedding().vector('一条记忆');
    assert.deepEqual(await W(core).denseSearch(core, { vectors: [qv], spaceId: W(core).activeSpaceId(core), layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 500 }),
      { hits: [], timedOut: false });
    // 冷却期内不重起
    await W(core).runEmbedQueue(core, {});
    assert.equal(W(core).health(core).mode, 'fallback');
    ports.clock.advance(61_000);
    await W(core).runEmbedQueue(core, {});
    assert.equal(W(core).health(core).mode, 'thread');
    const r = await W(core).denseSearch(core, { vectors: [qv], spaceId: W(core).activeSpaceId(core), layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 2000 });
    assert.equal(r.hits[0].ref, 'a1');
    await W(core).stop(core);
    assert.equal(W(core).health(core).mode, 'fallback');
    assert.deepEqual((await W(core).denseSearch(core, { vectors: [qv], layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 500 })).hits, []);
  } finally { await cleanup(); }
});

test('运维在临时线程里跑：完整性检查只跑在副本上；FTS 小步合并；增量 vacuum', async () => {
  const { core, dir, cleanup } = await workerCore({ name: 'worker-maint' });
  try {
    core.store.tx((db) => { for (let i = 1; i <= 50; i++) ftsInsert(db, 'episodes_fts', i, [`词${i}`, '共同']); });
    for (let i = 51; i <= 60; i++) ftsInsert(core.store, 'episodes_fts', i, [`词${i}`]);   // 多几个段
    const copy = path.join(dir, 'copy.db');
    core.store.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    assert.deepEqual(await W(core).maintenance(core, { kind: 'quick-check', file: copy }), { ok: true, detail: 'ok' });
    assert.deepEqual(await W(core).maintenance(core, { kind: 'integrity-check', file: copy }), { ok: true, detail: 'ok' });
    assert.deepEqual(await W(core).maintenance(core, { kind: 'integrity-check', file: core.store.file }), { ok: false, detail: 'live-db' });
    assert.deepEqual(await W(core).maintenance(core, { kind: 'quick-check', file: path.join(dir, 'nope.db') }), { ok: false, detail: 'missing-file' });
    assert.deepEqual(await W(core).maintenance(core, { kind: 'quick-check' }), { ok: false, detail: 'missing-file' });
    // 坏掉的副本
    const broken = path.join(dir, 'broken.db');
    fs.writeFileSync(broken, Buffer.alloc(8192, 7));
    assert.equal((await W(core).maintenance(core, { kind: 'quick-check', file: broken })).ok, false);
    const m = await W(core).maintenance(core, { kind: 'fts-merge' });
    assert.equal(m.ok, true);
    assert.match(m.detail, /^tables=\d+ more=\d+$/);
    // 合并之后照样查得到
    assert.equal((await W(core).lexicalSearch(core, { terms: ['共同'], tables: ['episodes_fts'], limit: 100 }, { deadlineMs: 1000 })).hits.length, 50);
    const v = await W(core).maintenance(core, { kind: 'vacuum', pages: 10 });
    assert.equal(v.ok, true);
    assert.match(v.detail, /^freed=\d+ left=\d+$/);
    assert.equal((await W(core).maintenance(core, { kind: 'vacuum', file: core.vectors.file })).ok, true);
    assert.deepEqual(await W(core).maintenance(core, { kind: 'optimize' }), { ok: false, detail: 'unknown-task' });
    assert.ok(core.store.get('SELECT count(*) AS n FROM metrics WHERE name LIKE ?', 'worker.maint.%').n >= 1);
  } finally { await cleanup(); }
});

test('没有向量库（打不开）：线程照起，稠密路空，词法照常', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-novec' });
  try {
    const vec = core.vectors;
    core.vectors = null;
    try {
      assert.equal((await W(core).start(core)).ok, true);
      assert.deepEqual(await W(core).denseSearch(core, { vectors: [new Float32Array(256).fill(0.1)], layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 500 }),
        { hits: [], timedOut: false });
      ftsInsert(core.store, 'episodes_fts', 1, ['词']);
      assert.equal((await W(core).lexicalSearch(core, { terms: ['词'], tables: ['episodes_fts'], limit: 5 }, { deadlineMs: 1000 })).hits.length, 1);
      assert.deepEqual(await W(core).runEmbedQueue(core, {}), { embedded: 0, failed: 0 });
    } finally { await W(core).stop(core); core.vectors = vec; }
  } finally { await cleanup(); }
});
