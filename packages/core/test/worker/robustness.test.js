// 嵌入队列和向量缓存的边角（§8.8 熔断、§12.8 清扫、§8.9 空间不混用、§13.2 可疑空间）：
// 探测权不会卡死、放弃的不算失败、可疑空间不每分钟重嵌探针、换空间和队列撞上、墓碑不误删重新用上的 id、
// 恢复后属主对不上的向量、不认识的空间、影子覆盖率的估计和失败行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, owner, WrapPort, MultiSpacePort, FakeEmbedding } from './_helpers.js';
import { fakePorts } from '../fakes/index.js';
import { getMeta } from '../../src/store/index.js';
import { Engine, wrapDatabase } from '../../src/worker/engine.js';
import { DatabaseSync } from 'node:sqlite';

const W = (core) => core.mods.worker;
const MIN = 60_000;

test('熔断的探测权：拿到探测权的那次没调端口（队列是空的）就交回去，之后的查询照样能探测，不会永远熔断', async () => {
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb);
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-probe-lease', ports });
  try {
    await W(core).ensureSpace(core);
    emb.setFailing(true);
    assert.equal(await W(core).embedQuery(core, ['一'], { deadlineMs: 500 }), null);
    assert.equal(await W(core).embedQuery(core, ['二'], { deadlineMs: 500 }), null);
    assert.equal(W(core).health(core).breakerOpen, true);
    emb.setFailing(false);
    ports.clock.advance(61_000);
    // 冷却期过了：嵌入队列先拿到探测权，但队列是空的，一次端口都没调
    const n = port.calls.length;
    const r = await W(core).runEmbedQueue(core, {});
    assert.deepEqual(r, { embedded: 0, failed: 0 });
    assert.equal(port.calls.length, n);
    // 查询来探测：成功，熔断解除
    const q = await W(core).embedQuery(core, ['恢复了吗'], { deadlineMs: 500 });
    assert.ok(q && q.vectors.length === 1);
    assert.equal(W(core).health(core).breakerOpen, false);
  } finally { await cleanup(); }
});

test('熔断的探测权只租一个冷却期：拿了探测权的调用卡住了，过了冷却期放下一个探测', async () => {
  const emb = new FakeEmbedding();
  let hang = false;
  const port = new WrapPort(emb, { before: () => (hang ? new Promise(() => {}) : null) });
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-probe-hang', ports });
  try {
    await W(core).ensureSpace(core);
    emb.setFailing(true);
    await W(core).embedQuery(core, ['一'], { deadlineMs: 300 });
    await W(core).embedQuery(core, ['二'], { deadlineMs: 300 });
    assert.equal(W(core).health(core).breakerOpen, true);
    ports.clock.advance(61_000);
    hang = true;   // 探测的那次永远不回来（超时只是这次查询返回 null）
    assert.equal(await W(core).embedQuery(core, ['探测'], { deadlineMs: 50 }), null);
    hang = false;
    emb.setFailing(false);
    assert.equal(await W(core).embedQuery(core, ['还在探测中'], { deadlineMs: 300 }), null);   // 同一个冷却期里不放第二个探测
    ports.clock.advance(61_000);
    assert.ok(await W(core).embedQuery(core, ['下一个探测'], { deadlineMs: 300 }));
  } finally { await cleanup(); }
});

test('调用方放弃（signal）的文档批不算这几行失败了一次', async () => {
  const emb = new FakeEmbedding();
  const ac = new AbortController();
  const port = new WrapPort(emb, { before: (texts, kind) => { if (kind === 'doc' && texts.length === 1 && texts[0] === '要放弃的') ac.abort(); } });
  const { core, cleanup } = await workerCore({ name: 'worker-abort', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    addText(core, 'assertion', 1, '要放弃的');
    const r = await W(core).runEmbedQueue(core, { signal: ac.signal, batchSize: 1 });
    assert.equal(r.failed, 0);
    const row = core.store.get('SELECT status, attempts FROM embed_texts');
    assert.deepEqual({ ...row }, { status: 'pending', attempts: 0 });
    assert.equal(W(core).health(core).breakerOpen, false);
    assert.equal((await drainQueue(core)).embedded, 1);
  } finally { await cleanup(); }
});

test('可疑空间：嵌入队列不每分钟重嵌探针，隔 worker.reprobeMs 再试；模型换回来就重新启用', async () => {
  const real = new FakeEmbedding();
  const port = new WrapPort(real);
  const ports = fakePorts({ embedding: port });
  const { core, cleanup } = await workerCore({ name: 'worker-reprobe', ports, config: { worker: { reprobeMs: 30 * MIN } } });
  try {
    addText(core, 'assertion', 1, '主人说他最近总是失眠');
    await drainQueue(core);
    port.mapVectors = (v) => Float32Array.from(v).reverse();   // 同一个空间 id，模型被悄悄换了
    assert.equal((await W(core).ensureSpace(core)).status, 'suspect');
    addText(core, 'assertion', 2, '新的一条');
    const probes = () => port.calls.filter((c) => c.n === 20).length;
    const p0 = probes();
    for (let i = 0; i < 5; i++) { ports.clock.advance(MIN); await W(core).runEmbedQueue(core, {}); }
    assert.equal(probes(), p0, '冷静期内不重新探测');
    assert.equal(core.store.get("SELECT status FROM embed_texts WHERE owner_id = 2").status, 'pending');
    port.mapVectors = undefined;   // 模型换回来了
    ports.clock.advance(30 * MIN);
    await W(core).runEmbedQueue(core, {});
    assert.equal(probes(), p0 + 1);
    assert.equal(W(core).activeSpaceId(core), real.spaceId);
    await drainQueue(core);
    assert.ok(core.store.all('SELECT status FROM embed_texts').every((x) => x.status === 'done'));
  } finally { await cleanup(); }
});

test('嵌到一半活动空间换了：这批不标 done、向量作废，下一轮按新空间来（查询永远不和别的空间混）', async () => {
  const emb = new FakeEmbedding();
  let core;
  const port = new WrapPort(emb, {
    before: (texts, kind) => { if (kind === 'doc' && texts[0] === '撞上换空间') core.store.run("UPDATE vector_spaces SET status = 'suspect'"); },
  });
  const t = await workerCore({ name: 'worker-switch-race', ports: fakePorts({ embedding: port }) });
  core = t.core;
  try {
    await W(core).ensureSpace(core);
    addText(core, 'assertion', 1, '撞上换空间');
    const r = await W(core).runEmbedQueue(core, { batchSize: 1 });
    assert.equal(r.embedded, 0);
    assert.equal(core.store.get('SELECT status FROM embed_texts').status, 'pending');
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 0);
  } finally { await t.cleanup(); }
});

test('清扫：墓碑只删墓碑之前就有的嵌入文本（主表 id 被新记忆用上了，新记忆的嵌入不跟着删）', async () => {
  const { core, ports, cleanup } = await workerCore({ name: 'worker-sweep-tomb' });
  try {
    core.store.tx(() => { owner(core, 'assertion', 5); owner(core, 'assertion', 6); });
    addText(core, 'assertion', 6, '被彻底删除过、又从备份里带回来的旧记忆');
    core.store.run("INSERT INTO tombstones(kind, ref, at) VALUES ('assertion', 'a6', ?)", core.now());
    // a5 也被删过，后来这个 id 被一条新记忆用上了（主表 id 不是 AUTOINCREMENT）
    core.store.run("INSERT INTO tombstones(kind, ref, at) VALUES ('assertion', 'a5', ?)", core.now());
    ports.clock.advance(1000);
    addText(core, 'assertion', 5, '用上同一个 id 的新记忆');
    await drainQueue(core);
    W(core).sweepVectors(core);
    assert.deepEqual(core.store.all('SELECT owner_id FROM embed_texts').map((x) => x.owner_id), [5]);
    assert.deepEqual(core.vectors.all('SELECT owner_id FROM vectors').map((x) => x.owner_id), [5]);
  } finally { await cleanup(); }
});

test('清扫：属主对不上的向量（恢复后 id 被重新用了、文本碰巧一样）、不认识的空间的向量删掉；done 却不在活动空间的改回 stale', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-sweep-mismatch' });
  try {
    core.store.tx(() => { owner(core, 'assertion', 1); owner(core, 'assertion', 2); owner(core, 'episode', 3); });
    addText(core, 'assertion', 1, '一样的一句话');
    addText(core, 'assertion', 2, '另一条');
    await drainQueue(core);
    const id1 = core.store.get('SELECT id FROM embed_texts WHERE owner_id = 1').id;
    // 向量库里这一行记的属主是 e3（恢复之前的另一条记忆，文本碰巧一样）
    core.vectors.run("UPDATE vectors SET owner_kind = 'episode', owner_id = 3 WHERE embed_text_id = ?", id1);
    // 一个早就没有了的空间留下的向量
    const row = core.vectors.get('SELECT * FROM vectors LIMIT 1');
    core.vectors.run(`INSERT INTO vectors(space_id, embed_text_id, owner_kind, owner_id, chunk_no, kind, layer, text_hash, f32, q8, q8_scale, bin, created_at)
      VALUES ('ghost-space', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.embed_text_id, row.owner_kind, row.owner_id, row.chunk_no, row.kind, row.layer,
    row.text_hash, row.f32, row.q8, row.q8_scale, row.bin, row.created_at);
    // a2 标着 done，space_id 却是别的空间
    core.store.run("UPDATE embed_texts SET space_id = 'old-space' WHERE owner_id = 2");
    const r = W(core).sweepVectors(core);
    assert.ok(r.removed >= 2);
    assert.equal(core.vectors.get("SELECT count(*) AS n FROM vectors WHERE space_id = 'ghost-space'").n, 0);
    assert.equal(core.vectors.get("SELECT count(*) AS n FROM vectors WHERE owner_kind = 'episode'").n, 0);
    const st = Object.fromEntries(core.store.all('SELECT owner_id, status FROM embed_texts').map((x) => [x.owner_id, x.status]));
    assert.deepEqual(st, { 1: 'pending', 2: 'stale' });
    await drainQueue(core);
    const qv = await W(core).embedQuery(core, ['一样的一句话'], { deadlineMs: 500 });
    const hits = (await W(core).denseSearch(core, { vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 1000 })).hits;
    assert.equal(hits[0].ref, 'a1');
    assert.ok(!hits.some((h) => h.ref === 'e3'));
  } finally { await cleanup(); }
});

test('向量库整个丢了（D15 清空重建）：清扫把全部改回 pending，队列重嵌回来', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-sweep-wiped' });
  try {
    core.store.tx(() => { for (const id of [1, 2, 3]) owner(core, 'assertion', id); });
    for (const id of [1, 2, 3]) addText(core, 'assertion', id, `事实 ${id}`);
    await drainQueue(core);
    core.vectors.run('DELETE FROM vectors');
    assert.deepEqual(W(core).sweepVectors(core), { removed: 0, requeued: 3 });
    assert.equal((await drainQueue(core)).embedded, 3);
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 3);
  } finally { await cleanup(); }
});

test('影子覆盖率：扫描中只是进度估计（< 1），扫到头精确核对才给 1；活动空间里也嵌不出来（failed）的行不拖后腿', async () => {
  const a = new FakeEmbedding({ dim: 32, model: 'a' });
  const b = new FakeEmbedding({ dim: 32, model: 'b' });
  const port = new MultiSpacePort({ a, b }, 'a');
  const { core, cleanup } = await workerCore({ name: 'worker-coverage', ports: fakePorts({ embedding: port }) });
  try {
    core.store.tx(() => { for (let i = 1; i <= 8; i++) owner(core, 'assertion', i); });
    for (let i = 1; i <= 8; i++) addText(core, 'assertion', i, `记忆 ${i}`);
    await drainQueue(core);
    // 第 8 条在活动空间里一直嵌不出来
    core.store.run("UPDATE embed_texts SET status = 'failed', space_id = NULL WHERE owner_id = 8");
    const id8 = core.store.get('SELECT id FROM embed_texts WHERE owner_id = 8').id;
    core.vectors.run('DELETE FROM vectors WHERE embed_text_id = ?', id8);
    port.current = 'b';
    await W(core).ensureSpace(core);
    // 影子空间里它也嵌不出来（坏向量）
    const inner = port.embed.bind(port);
    port.embed = async (texts, kind, opt) => {
      const r = await inner(texts, kind, opt);
      return { ...r, vectors: r.vectors.map((v, i) => (texts[i] === '记忆 8' ? new Float32Array(v.length) : v)) };
    };
    const part = await W(core).shadowReembed(core, { spaceId: b.spaceId, maxBatches: 1, batchSize: 3 });
    assert.ok(part.coverage > 0 && part.coverage < 1, `进度估计 ${part.coverage}`);
    const full = await W(core).shadowReembed(core, { spaceId: b.spaceId, batchSize: 3 });
    assert.equal(full.coverage, 1);
    assert.equal(core.store.get('SELECT coverage FROM vector_spaces WHERE space_id = ?', b.spaceId).coverage, 1);
    // 覆盖率已经是 1、嵌入文本没变过：不再整表核对，也不调端口
    const n = port.calls.length;
    assert.deepEqual(await W(core).shadowReembed(core, { spaceId: b.spaceId }), { coverage: 1 });
    assert.equal(port.calls.length, n);
    assert.deepEqual(await W(core).activateSpace(core, b.spaceId), { ok: true });
  } finally { await cleanup(); }
});

test('引擎：loadSpace ifMissing 不重复冷加载；readOnlyCheck 认得出只读连接', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-engine-misc' });
  try {
    core.store.tx(() => owner(core, 'assertion', 1));
    addText(core, 'assertion', 1, '一条记忆');
    await drainQueue(core);
    const sid = W(core).activeSpaceId(core);
    const ro = new Engine({ main: wrapDatabase(new DatabaseSync(core.store.file, { readOnly: true })), vec: wrapDatabase(new DatabaseSync(core.vectors.file, { readOnly: true })) });
    try {
      assert.equal(ro.readOnlyCheck(), true);
      assert.equal(ro.loadSpace({ spaceId: sid }).loaded, 1);
      assert.deepEqual(ro.loadSpace({ spaceId: sid, ifMissing: true }), { loaded: 0, skipped: true });
      assert.equal(ro.loadSpace({ spaceId: sid }).loaded, 1);   // 不带 ifMissing：整体重建
    } finally { ro.close(); }
    const rw = new Engine({ main: wrapDatabase(new DatabaseSync(core.store.file)), vec: null });
    try { assert.equal(rw.readOnlyCheck(), false); } finally { rw.close(); }
    assert.equal(W(core).health(core).readOnlyThreads, null);   // 没起线程
  } finally { await cleanup(); }
});

test('积压推到夜里的安全网：夜里那一轮超过 embedding.nightGraceH 没跑（没传 night），白天就不再往后推', async () => {
  const { core, ports, cleanup } = await workerCore({ name: 'worker-night-grace', config: { embedding: { msPerText: { cpu: 7_200_000 }, nightGraceH: 36 } } });
  try {
    await W(core).ensureSpace(core);
    core.store.tx(() => { owner(core, 'assertion', 1); owner(core, 'assertion', 2); });
    addText(core, 'assertion', 1, '新记忆一');
    assert.equal((await W(core).runEmbedQueue(core, {})).embedded, 0);   // 推后（从现在开始算宽限）
    ports.clock.advance(37 * 3_600_000);
    core.state.worker.msPerText = null;   // 还是按配置估计的慢 CPU
    assert.equal((await W(core).runEmbedQueue(core, {})).embedded, 1);
    // 夜里跑过之后重新开始算
    await W(core).runEmbedQueue(core, { night: true });
    addText(core, 'assertion', 2, '新记忆二');
    core.state.worker.msPerText = null;
    assert.equal((await W(core).runEmbedQueue(core, {})).embedded, 0);
  } finally { await cleanup(); }
});

/** 一个能把文档批卡在端口里的包装：hold() 之后下一次文档批停在端口前，entered 落定；release() 放行。 */
function holdablePort(emb) {
  let gate = null;
  const ctl = {
    entered: null,
    hold() { let enter; ctl.entered = new Promise((r) => { enter = r; }); gate = { enter, wait: null, open: null }; gate.wait = new Promise((r) => { gate.open = r; }); },
    release() { const g = gate; gate = null; g?.open(); },
  };
  ctl.port = new WrapPort(emb, { before: (texts, kind) => { if (kind !== 'doc' || !gate || gate.used) return null; gate.used = true; gate.enter(); return gate.wait; } });
  return ctl;
}

test('夜里那一轮撞上白天（tick）正在跑的一轮：等它跑完再跑，不整轮跳过（推后的积压、失败行的重试照做）；白天的撞上返回 busy', async () => {
  const emb = new FakeEmbedding();
  const h = holdablePort(emb);
  const { core, ports, cleanup } = await workerCore({ name: 'worker-night-wait', ports: fakePorts({ embedding: h.port }) });
  try {
    await W(core).ensureSpace(core);
    addText(core, 'assertion', 1, '第一条');
    addText(core, 'assertion', 2, '第二条');
    addText(core, 'assertion', 3, '失败过的那条');
    core.store.run("UPDATE embed_texts SET status = 'failed', attempts = 5, updated_at = ? WHERE owner_id = 3", core.now() - 25 * 3_600_000);
    h.hold();
    const day = W(core).runEmbedQueue(core, { maxBatches: 1, batchSize: 1 });
    await h.entered;   // 白天那一轮卡在端口里
    assert.deepEqual(await W(core).runEmbedQueue(core, {}), { embedded: 0, failed: 0, busy: true }, '白天的撞上直接返回');
    let nightDone = false;
    const night = W(core).runEmbedQueue(core, { night: true, batchSize: 8 }).then((r) => { nightDone = true; return r; });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(nightDone, false, '夜里那一轮在等');
    h.release();
    assert.equal((await day).embedded, 1);
    const n = await night;
    assert.equal(n.busy, undefined);
    assert.equal(n.embedded, 2, '剩下的一条和失败了一天的那条');
    assert.ok(core.store.all('SELECT status FROM embed_texts').every((r) => r.status === 'done'));
    assert.equal(Number(getMeta(core.store, 'worker.nightRunAt')), ports.clock.now());
    assert.equal(core.state.worker.queueRunning, null);
  } finally { await cleanup(); }
});

test('夜里那一轮在等的时候被中止（关库、换库）：马上返回，什么都不做；白天那一轮照常跑完', async () => {
  const emb = new FakeEmbedding();
  const h = holdablePort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-night-abort', ports: fakePorts({ embedding: h.port }) });
  try {
    await W(core).ensureSpace(core);
    addText(core, 'assertion', 1, '第一条');
    addText(core, 'assertion', 2, '第二条');
    h.hold();
    const day = W(core).runEmbedQueue(core, { maxBatches: 1, batchSize: 1 });
    await h.entered;
    const ac = new AbortController();
    const night = W(core).runEmbedQueue(core, { night: true, signal: ac.signal });
    ac.abort();
    assert.deepEqual(await night, { embedded: 0, failed: 0 });
    assert.equal(getMeta(core.store, 'worker.nightRunAt'), null, '夜里那一轮没开始');
    h.release();
    assert.equal((await day).embedded, 1);
    assert.equal(core.store.get("SELECT count(*) AS n FROM embed_texts WHERE status = 'pending'").n, 1);
  } finally { await cleanup(); }
});

/** 按空间嵌入的端口，能把影子空间的下一次文档批卡在端口里，并记下影子空间同时在嵌的批数。 */
class GatedShadowPort extends MultiSpacePort {
  constructor(embs, current, shadowPortId) {
    super(embs, current);
    this.shadowPortId = shadowPortId;
    this.gate = null;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.shadowTexts = 0;
  }
  hold() {
    const g = {};
    g.entered = new Promise((r) => { g.enter = r; });
    g.wait = new Promise((r) => { g.open = r; });
    this.gate = g;
    return g;
  }
  async embed(texts, kind, opt = {}) {
    const shadow = kind === 'doc' && opt.spaceId === this.shadowPortId && texts.length < 20;   // 探针（20 条）不算
    if (shadow) { this.inFlight += 1; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight); this.shadowTexts += texts.length; }
    try {
      if (shadow && this.gate) { const g = this.gate; this.gate = null; g.enter(); await g.wait; }
      return await super.embed(texts, kind, opt);
    } finally { if (shadow) this.inFlight -= 1; }
  }
}

test('影子重嵌同一个空间同一时间只有一轮：夜里直接调的那一轮等白天队列顺手推进的那一轮做完再接着做（不重复嵌、游标不往回写）；它在跑时白天的队列不再并排推进；等的时候中止就返回', async () => {
  const small = new FakeEmbedding({ dim: 32, model: 'small' });
  const big = new FakeEmbedding({ dim: 32, model: 'big' });
  const port = new GatedShadowPort({ small, big }, 'small', big.spaceId);
  const { core, cleanup } = await workerCore({ name: 'worker-shadow-lock', ports: fakePorts({ embedding: port }) });
  try {
    for (let i = 1; i <= 12; i++) addText(core, 'assertion', i, `旧记忆 ${i}：第 ${i} 件事`);
    await drainQueue(core);
    port.current = 'big';
    assert.equal((await W(core).ensureSpace(core)).shadow, big.spaceId);
    // 白天（tick）的一轮：活动空间的队列是空的，顺手推进影子（shadowDayBatches=1 批），卡在端口里
    const g = port.hold();
    const day = W(core).runEmbedQueue(core, { batchSize: 4 });
    await g.entered;
    // 夜里直接调的那一轮：等着，不并排嵌
    let nightDone = false;
    const night = W(core).shadowReembed(core, { spaceId: big.spaceId, batchSize: 4 }).then((r) => { nightDone = true; return r; });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(nightDone, false, '夜里那一轮在等');
    assert.equal(port.inFlight, 1);
    // 中止的等待：马上返回当前的覆盖率，不嵌
    const ac = new AbortController();
    const aborted = W(core).shadowReembed(core, { spaceId: big.spaceId, signal: ac.signal });
    ac.abort();
    assert.ok((await aborted).coverage < 1);
    g.open();
    await day;
    const r = await night;
    assert.equal(r.coverage, 1);
    assert.equal(port.maxInFlight, 1, '同一个影子空间从来没有两批同时在嵌');
    assert.equal(port.shadowTexts, 12, '每条只嵌了一遍');
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors WHERE space_id = ?', big.spaceId).n, 12);
    assert.equal(core.state.worker.shadowRunning.size, 0);
  } finally { await cleanup(); }
});

test('直接调的影子重嵌在跑时，白天的嵌入队列不并排推进同一个空间（队列空了也只是返回）', async () => {
  const small = new FakeEmbedding({ dim: 32, model: 'small' });
  const big = new FakeEmbedding({ dim: 32, model: 'big' });
  const port = new GatedShadowPort({ small, big }, 'small', big.spaceId);
  const { core, cleanup } = await workerCore({ name: 'worker-shadow-lock-day', ports: fakePorts({ embedding: port }) });
  try {
    for (let i = 1; i <= 8; i++) addText(core, 'assertion', i, `旧记忆 ${i}`);
    await drainQueue(core);
    port.current = 'big';
    await W(core).ensureSpace(core);
    const g = port.hold();
    const night = W(core).shadowReembed(core, { spaceId: big.spaceId, batchSize: 4 });
    await g.entered;
    const before = port.shadowTexts;
    assert.deepEqual(await W(core).runEmbedQueue(core, { batchSize: 4 }), { embedded: 0, failed: 0 });
    assert.equal(port.shadowTexts, before, '白天那一轮没碰影子空间');
    g.open();
    assert.equal((await night).coverage, 1);
    assert.equal(port.maxInFlight, 1);
    assert.equal(port.shadowTexts, 8);
  } finally { await cleanup(); }
});
