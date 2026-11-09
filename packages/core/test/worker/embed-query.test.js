// 查询向量为什么大多拿不到（实测问题 #1）：
//   - 启动探针按「同一模型、不同后端」的数值差定门槛：换了设备（CPU ↔ GPU）、部分层放 GPU 都有一点差，不再被当成「模型被悄悄换过」；
//     真换了模型照样可疑（差得远，或者端口给的模型指纹变了）；
//     旧库已经被误判成可疑的空间，换上新代码后重新确认就启用，旧向量照用；
//   - 晚到的查询向量照样有用：调用方到点先走，端口那次做完进缓存，下一次直接用；同一段文字正在嵌就不再发第二次；
//   - 慢、状态性的「用不上」都不算失败，不叠熔断；原因分开计数，health() 里看得见；
//   - 有人说话时预热（端口有 warm() 才调）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, WrapPort, FakeEmbedding } from './_helpers.js';
import { fakePorts } from '../fakes/index.js';
import { getMeta, setMeta } from '../../src/store/index.js';
import { embedQueryTracked } from '../../src/retrieve/level.js';

const W = (core) => core.mods.worker;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个固定方向的小扰动：v → normalize(v + eps·u)。eps = 0.063 时余弦约 0.998（实测 CPU 和 GPU 之间的差）。 */
function nudge(eps, seed = 7) {
  let u = null;
  return (v) => {
    if (!u || u.length !== v.length) {
      u = new Float32Array(v.length);
      let x = seed;
      for (let i = 0; i < v.length; i++) { x = (x * 1103515245 + 12345) % 2147483648; u[i] = x / 2147483648 - 0.5; }
      let n = 0; for (const a of u) n += a * a; n = Math.sqrt(n); for (let i = 0; i < u.length; i++) u[i] /= n;
    }
    const out = new Float32Array(v.length);
    let n = 0;
    for (let i = 0; i < v.length; i++) { out[i] = v[i] + eps * u[i]; n += out[i] * out[i]; }
    n = Math.sqrt(n);
    for (let i = 0; i < v.length; i++) out[i] /= n;
    return out;
  };
}

test('探针：CPU 上建的空间换到 GPU（平均余弦约 0.998）照样启用，并存下 GPU 自己的一份对照；同一个设备上又有一点差（部分层放 GPU）也照样启用', async () => {
  const emb = new FakeEmbedding({ device: 'cpu' });
  const port = new WrapPort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-probe-device', ports: fakePorts({ embedding: port }) });
  try {
    assert.equal((await W(core).ensureSpace(core)).status, 'active');
    const sid = emb.spaceId;
    assert.equal(getMeta(core.store, `worker.probeDevice.${sid}`), 'cpu');
    // 重启以后在 GPU 上：同一个模型，数值差一点
    emb.device = 'gpu';
    port.mapVectors = nudge(0.063);
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'active');
    assert.ok(r.meanCos < 0.999 && r.meanCos > 0.995, `meanCos=${r.meanCos}`);
    assert.ok(getMeta(core.store, `worker.probe.${sid}.gpu`), 'GPU 的基线存下来了');
    assert.equal(W(core).health(core).probe.crossDevice, true);
    assert.equal(W(core).health(core).dense, true);
    // 再重启一次，还在 GPU：和 GPU 自己的基线比，一模一样
    const again = await W(core).ensureSpace(core);
    assert.equal(again.status, 'active');
    assert.ok(again.meanCos > 0.9999);
    assert.equal(W(core).health(core).probe.crossDevice, false);
    // 还是「GPU」，但显存紧、Ollama 只把一部分层放上了 GPU：和两份基线都差一点（实测 0.9984–0.9988），同一个模型，照样启用
    port.mapVectors = nudge(0.05, 99);
    const partial = await W(core).ensureSpace(core);
    assert.equal(partial.status, 'active');
    assert.ok(partial.meanCos < 0.999 && partial.meanCos > 0.995, `meanCos=${partial.meanCos}`);
    assert.equal(W(core).health(core).dense, true);
  } finally { await cleanup(); }
});

test('探针：换了设备、同时真换了模型（差得远）→ 照样可疑', async () => {
  const emb = new FakeEmbedding({ device: 'cpu' });
  const port = new WrapPort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-probe-swap', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    emb.device = 'gpu';
    port.mapVectors = (v) => Float32Array.from(v).reverse();
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'suspect');
    assert.equal(getMeta(core.store, `worker.probe.${emb.spaceId}.gpu`), null, '没过就不存基线');
  } finally { await cleanup(); }
});

test('探针：端口给了模型指纹（Ollama 的 digest），指纹变了就是换了模型，探针再像也可疑；没给指纹的照旧只看探针', async () => {
  const emb = new FakeEmbedding({ device: 'gpu' });
  const port = new WrapPort(emb);
  let digest = 'sha256:aaaa';
  const info = port.info.bind(port);
  port.info = () => ({ ...info(), ...(digest ? { digest } : {}) });
  const { core, cleanup } = await workerCore({ name: 'worker-probe-digest', ports: fakePorts({ embedding: port }) });
  try {
    assert.equal((await W(core).ensureSpace(core)).status, 'active');
    const sid = emb.spaceId;
    assert.equal(getMeta(core.store, `worker.modelDigest.${sid}`), 'sha256:aaaa');
    assert.equal((await W(core).ensureSpace(core)).status, 'active');
    // 这次端口没报指纹（健康检查还没跑）：只看探针
    digest = null;
    assert.equal((await W(core).ensureSpace(core)).status, 'active');
    // 同名的模型被重新拉过、权重变了（向量碰巧几乎一样）：指纹对不上就可疑
    digest = 'sha256:bbbb';
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'suspect');
    assert.equal(W(core).health(core).probe.reason, 'digest');
  } finally { await cleanup(); }
});

test('旧库里只因换了设备就被判成可疑的空间（没记设备）：重新确认得上就启用，已经存好的向量照用', async () => {
  const emb = new FakeEmbedding({ device: 'cpu' });
  const port = new WrapPort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-probe-heal', ports: fakePorts({ embedding: port }) });
  try {
    addText(core, 'assertion', 1, '主人说他最近总是失眠');
    await drainQueue(core);
    const sid = emb.spaceId;
    // 线上的样子：建空间时没记设备，换到 GPU 重启后被老规则（只有 0.999 一道门槛）标成了可疑
    setMeta(core.store, `worker.probeDevice.${sid}`, null);
    core.store.run("UPDATE vector_spaces SET status = 'suspect'");
    emb.device = 'gpu';
    port.mapVectors = nudge(0.063);
    assert.equal(await W(core).embedQuery(core, ['睡得好吗'], { deadlineMs: 500 }), null);
    const r = await W(core).ensureSpace(core);
    assert.equal(r.status, 'active');
    assert.equal(core.store.get('SELECT status FROM vector_spaces').status, 'active');
    assert.equal(core.store.get('SELECT status FROM embed_texts').status, 'done', '旧向量照用，不重嵌');
    assert.ok(core.vectors.get('SELECT count(*) AS n FROM vectors').n >= 1);
    const qv = await W(core).embedQuery(core, ['主人最近睡得好吗'], { deadlineMs: 500 });
    assert.ok(qv);
    const hits = (await W(core).denseSearch(core, { vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false }, { deadlineMs: 1000 })).hits;
    assert.equal(hits[0].ref, 'a1');
  } finally { await cleanup(); }
});

test('晚到的查询向量照样有用：调用方到点先走（不算失败），端口那次做完进缓存，下一次直接用，不再调端口', async () => {
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-query-late', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    emb.delayMs = 120;   // 冷模型第一次加载
    assert.equal(await W(core).embedQuery(core, ['5'], { deadlineMs: 20 }), null);
    const n = port.calls.filter((c) => c.kind === 'query').length;
    await sleep(200);
    const h = W(core).health(core);
    assert.equal(h.query.timeout, 1);
    assert.equal(h.query.late, 1);
    assert.equal(h.breakerOpen, false, '慢不算失败');
    const r = await W(core).embedQuery(core, ['5'], { deadlineMs: 20 });
    assert.ok(r && r.vectors.length === 1, '缓存里有，截止再短也拿得到');
    assert.equal(port.calls.filter((c) => c.kind === 'query').length, n, '没再调端口');
    assert.equal(W(core).health(core).query.cached, 1);
    assert.equal(W(core).health(core).query.lastCause, 'cached');
  } finally { await cleanup(); }
});

test('同一段文字正在嵌就等那一次：并发的查询只调一次端口；部分命中缓存只嵌缺的那几段', async () => {
  const emb = new FakeEmbedding({ delayMs: 30 });
  const port = new WrapPort(emb);
  const { core, cleanup } = await workerCore({ name: 'worker-query-dedupe', ports: fakePorts({ embedding: port }) });
  try {
    await W(core).ensureSpace(core);
    const before = port.calls.length;
    const [a, b] = await Promise.all([
      W(core).embedQuery(core, ['数字游戏'], { deadlineMs: 1000 }),
      W(core).embedQuery(core, ['数字游戏'], { deadlineMs: 1000 }),
    ]);
    assert.ok(a && b);
    assert.deepEqual(Array.from(a.vectors[0]), Array.from(b.vectors[0]));
    assert.equal(port.calls.length - before, 1);
    const r = await W(core).embedQuery(core, ['数字游戏', '比这个数大一'], { deadlineMs: 1000 });
    assert.equal(r.vectors.length, 2);
    assert.equal(port.calls.at(-1).n, 1, '只嵌缺的那一段');
    // 向量和直接算的一样（缓存没有串）
    const direct = emb.vector('比这个数大一');
    let dot = 0; for (let i = 0; i < direct.length; i++) dot += direct[i] * r.vectors[1][i];
    assert.ok(dot > 0.9999);
  } finally { await cleanup(); }
});

test('真报错照样记熔断，原因分开计数（timeout / error / unavailable），flush 进 metrics', async () => {
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb);
  const ports = fakePorts({ embedding: port });
  // 这里只看计数的口径：不重试（D117 的重试见 embed-retry.test.js）
  const { core, cleanup } = await workerCore({ name: 'worker-query-causes', ports, config: { embedding: { queryRetries: 0 } } });
  try {
    await W(core).ensureSpace(core);
    emb.setFailing(true);
    assert.equal(await W(core).embedQuery(core, ['一'], { deadlineMs: 500 }), null);
    assert.equal(await W(core).embedQuery(core, ['二'], { deadlineMs: 500 }), null);
    const h = W(core).health(core);
    assert.equal(h.breakerOpen, true);
    assert.equal(h.query.error, 2);
    assert.equal(h.query.lastError, 'EMBED_DOWN');
    assert.equal(await W(core).embedQuery(core, ['三'], { deadlineMs: 500 }), null);
    assert.equal(W(core).health(core).query.unavailable, 1, '熔断中：用不上，不是又失败了一次');
    emb.setFailing(false);
    ports.clock.advance(61_000);
    await W(core).runEmbedQueue(core, {});   // 每一轮先把计数记进 metrics
    const m = Object.fromEntries(core.store.all("SELECT name, value FROM metrics WHERE name LIKE 'embed.query%'").map((x) => [x.name, x.value]));
    assert.equal(m['embed.query.failed'], 2);
    assert.equal(m['embed.query.error'], 2);
    assert.equal(m['embed.query.unavailable'], 1);
  } finally { await cleanup(); }
});

test('回想这边的熔断：空间可疑、没有活动空间时的「很快空手回来」是状态，不叠一层熔断', async () => {
  const emb = new FakeEmbedding();
  const { core, cleanup } = await workerCore({ name: 'worker-query-tracked', embedding: emb });
  try {
    await W(core).ensureSpace(core);
    core.store.run("UPDATE vector_spaces SET status = 'suspect'");
    for (let i = 0; i < 5; i++) assert.equal(await embedQueryTracked(core, [`问 ${i}`], { deadlineMs: 300 }), null);
    assert.equal(core.state.retrieve.breaker.openUntil, 0);
    assert.equal(core.store.get("SELECT value FROM metrics WHERE name = 'retrieve.embed.breakerOpen'"), undefined);
  } finally { await cleanup(); }
});

test('有人说话时预热：端口有 warm() 就调（不等它），没有就什么都不做；熔断中不调', async () => {
  const emb = new FakeEmbedding();
  let warms = 0;
  const port = new WrapPort(emb);
  port.warm = async () => { warms += 1; return true; };
  const { core, cleanup } = await workerCore({ name: 'worker-warm', ports: fakePorts({ embedding: port }) });
  try {
    W(core).warmQuery(core);
    await sleep(5);
    assert.equal(warms, 1);
    port.warm = () => { throw new Error('坏了'); };
    assert.doesNotThrow(() => W(core).warmQuery(core));
  } finally { await cleanup(); }
  const { core: c2, cleanup: cl2 } = await workerCore({ name: 'worker-warm-none', embedding: new FakeEmbedding() });
  try { assert.doesNotThrow(() => W(c2).warmQuery(c2)); } finally { await cl2(); }
});

test('queryWarming：预热请求还没回来（冷加载中）时为真，回来了、已经热着当场返回的都为假', async () => {
  const emb = new FakeEmbedding();
  const port = new WrapPort(emb);
  let release;
  port.warm = () => new Promise((r) => { release = r; });
  const { core, cleanup } = await workerCore({ name: 'worker-warming', ports: fakePorts({ embedding: port }) });
  try {
    assert.equal(W(core).queryWarming(core), false);
    W(core).warmQuery(core);
    assert.equal(W(core).queryWarming(core), true);
    release(true);
    await sleep(5);
    assert.equal(W(core).queryWarming(core), false);
    port.warm = async () => false;   // 已经热着：端口当场返回
    W(core).warmQuery(core);
    await sleep(5);
    assert.equal(W(core).queryWarming(core), false);
  } finally { await cleanup(); }
});
