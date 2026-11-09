// 稠密路（§8.2、§8.7）：二值粗排 → int8 精排、两条查询向量取大、多块合并、预过滤、冷层、空间隔离、MRL 截断、伪查询向量。
// S24（换个说法也能想起）的稠密部分在这里；完整的五路场景由 retrieve 牵头。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, FakeEmbedding } from './_helpers.js';
import { PARAPHRASE_PAIRS } from '../fixtures/paraphrase-pairs.js';
import { Engine, wrapDatabase } from '../../src/worker/engine.js';
import { wallNow } from '../../src/worker/vindex.js';
import { dot } from '../../src/worker/quant.js';
import { DatabaseSync } from 'node:sqlite';

const W = (core) => core.mods.worker;
async function search(core, text, extra = {}, opt = {}) {
  const qv = await W(core).embedQuery(core, Array.isArray(text) ? text : [text], { deadlineMs: 2000 });
  assert.ok(qv, '查询嵌入应该成功');
  return W(core).denseSearch(core, {
    vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory', 'raw'], topK: { memory: 10, raw: 10 }, includeCold: false, ...extra,
  }, { deadlineMs: 5000, ...opt });
}

test('S24（稠密部分）：「快递拿了没」想起「去驿站把包裹取回来了」', async () => {
  const emb = new FakeEmbedding({ synonyms: [['快递', '包裹'], ['拿', '取'], ['没', '了吗']] });
  const { core, cleanup } = await workerCore({ name: 'worker-s24', embedding: emb });
  try {
    PARAPHRASE_PAIRS.forEach(([, memory], i) => addText(core, 'assertion', i + 1, memory));
    await drainQueue(core);
    const r = await search(core, '快递拿了没');
    assert.equal(r.timedOut, false);
    assert.equal(r.hits[0].ref, 'a1');
    assert.equal(r.hits[0].layer, 'memory');
    // 其余换说法的问法：索引给出的第一名和 f32 精确扫描的第一名一致（召回质量是模型的事，索引不能把它弄丢）
    const mem = PARAPHRASE_PAIRS.map(([, m]) => emb.vector(m));
    for (const [q] of PARAPHRASE_PAIRS) {
      const qv = emb.vector(q);
      const exact = mem.map((v, i) => [i, dot(qv, v)]).sort((a, b) => b[1] - a[1]);
      if (exact[0][1] - exact[1][1] < 0.02) continue;   // 前两名几乎一样近，int8 的误差可能换位
      const h = await search(core, q);
      assert.equal(h.hits[0]?.ref, `a${exact[0][0] + 1}`, q);
    }
  } finally { await cleanup(); }
});

test('两条查询向量每条记忆取较大的相似度；一条记忆的多个块合并成一个命中', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-multi' });
  try {
    core.store.tx(() => W(core).enqueueEmbed(core, { kind: 'episode', id: 1 }, [
      { chunkNo: 0, kind: 'text', text: '主人周六去爬了香山，回来说腿都酸了' },
      { chunkNo: 1, kind: 'text', text: '晚上大家约好下周五在海底捞聚餐' },
    ], { layer: 'memory', priority: 2 }));
    addText(core, 'assertion', 2, '阿杰说他发烧了，请了两天假');
    await drainQueue(core);
    const r = await search(core, ['下周五聚餐定在哪', '阿杰是不是病了']);
    const refs = r.hits.map((h) => h.ref);
    assert.deepEqual(refs.sort(), ['a2', 'e1']);
    const e1 = r.hits.find((h) => h.ref === 'e1');
    assert.equal(e1.chunkNo, 1);
    // 只用第一条查询：e1 的分数和两条一起时一样（取的是较大的那条）
    const r1 = await search(core, ['下周五聚餐定在哪']);
    assert.ok(Math.abs(r1.hits.find((h) => h.ref === 'e1').score - e1.score) < 1e-6);
  } finally { await cleanup(); }
});

test('预过滤 exclude、按层取、topK', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-exclude' });
  try {
    addText(core, 'assertion', 1, '小雨上周末从朝阳搬到了海淀');
    addText(core, 'assertion', 2, '小雨说她搬家以后离公司近了');
    addText(core, 'window', 7, '[11/01 09:00] 小雨：搬家累死了', { layer: 'raw' });
    await drainQueue(core);
    const all = await search(core, '小雨搬家');
    assert.deepEqual(all.hits.map((h) => h.ref).sort(), ['a1', 'a2', 'w7']);
    const ex = await search(core, '小雨搬家', { exclude: new Set(['a1']) });
    assert.deepEqual(ex.hits.map((h) => h.ref).sort(), ['a2', 'w7']);
    const raw = await search(core, '小雨搬家', { layers: ['raw'] });
    assert.deepEqual(raw.hits.map((h) => [h.ref, h.layer]), [['w7', 'raw']]);
    const one = await search(core, '小雨搬家', { layers: ['memory'], topK: { memory: 1, raw: 0 } });
    assert.equal(one.hits.length, 1);
  } finally { await cleanup(); }
});

test('二值粗排 → int8 精排的召回率：对 f32 精确扫描的 recall@10 ≥ 0.9（两层都走粗排）', async () => {
  const emb = new FakeEmbedding({ dim: 256 });
  const { core, cleanup } = await workerCore({ name: 'worker-recall', embedding: emb });
  try {
    // 120 个话题 × 20 种说法（两层各 10 条）：同一话题的几条共享大部分字，所以精确扫描的前 10 名就是这个话题的那 10 条；
    // 查询是这个话题的另一种说法
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
    const pool = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府南第'.split('');
    const docs = [];
    const topics = 120;
    for (let t = 0; t < topics; t++) {
      const core8 = Array.from({ length: 14 }, () => pool[Math.floor(rnd() * pool.length)]).join('');
      for (let v = 0; v < 20; v++) {
        const tail = Array.from({ length: 4 }, () => pool[Math.floor(rnd() * pool.length)]).join('');
        docs.push({ t, text: core8.slice(0, 10 + (v % 4)) + tail });
      }
    }
    core.store.tx(() => {
      docs.forEach((d, i) => W(core).enqueueEmbed(core, { kind: i % 2 ? 'assertion' : 'window', id: i + 1 }, [{ chunkNo: 0, kind: 'text', text: d.text }],
        { layer: i % 2 ? 'memory' : 'raw', priority: 2 }));
    });
    await drainQueue(core);
    const vecs = docs.map((d) => emb.vector(d.text));
    let recall = 0;
    const Q = 20;
    for (let qi = 0; qi < Q; qi++) {
      const t = Math.floor(rnd() * topics);
      const base = docs.find((d) => d.t === t).text;
      const qtext = `${base.slice(0, 11)}的`;
      const qv = emb.vector(qtext);
      for (const layer of ['memory', 'raw']) {
        const exact = docs.map((d, i) => ({ ref: `${i % 2 ? 'a' : 'w'}${i + 1}`, layer: i % 2 ? 'memory' : 'raw', s: dot(qv, vecs[i]) }))
          .filter((x) => x.layer === layer).sort((a, b) => b.s - a.s).slice(0, 10).map((x) => x.ref);
        const got = (await W(core).denseSearch(core, { vectors: [qv], spaceId: emb.spaceId, layers: [layer], topK: { memory: 10, raw: 10 }, includeCold: false },
          { deadlineMs: 5000 })).hits.map((h) => h.ref);
        recall += exact.filter((x) => got.includes(x)).length / 10;
      }
    }
    recall /= Q * 2;
    assert.ok(recall >= 0.9, `recall@10 = ${recall.toFixed(3)}`);
  } finally { await cleanup(); }
});

test('冷层不进内存：不自主回想找不到，有意回想（includeCold）从磁盘扫到', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-cold' });
  try {
    addText(core, 'assertion', 1, '主人提过他的生日在三月十二号');
    addText(core, 'assertion', 2, '主人说他公司在望京');
    await drainQueue(core);
    // dynamics 夜里把 a1 分到冷层（这里直接写 activation 当夹具），然后重建索引
    core.store.run("INSERT INTO activation(owner_kind, owner_id, tier) VALUES ('assertion', 1, 'cold')");
    W(core).reloadIndex(core);
    const hot = await search(core, '我生日是哪天你记得吗');
    assert.ok(!hot.hits.some((h) => h.ref === 'a1'));
    const deep = await search(core, '我生日是哪天你记得吗', { includeCold: true });
    assert.equal(deep.hits[0].ref, 'a1');
  } finally { await cleanup(); }
});

test('查询只和同一个空间的向量比：不认识的、可疑的空间一律不查', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-space-iso' });
  try {
    addText(core, 'assertion', 1, '主人养了三条孔雀鱼');
    await drainQueue(core);
    const qv = await W(core).embedQuery(core, ['你记得我养的鱼吗'], { deadlineMs: 1000 });
    const q = { vectors: qv.vectors, layers: ['memory'], topK: { memory: 5, raw: 0 }, includeCold: false };
    assert.equal((await W(core).denseSearch(core, { ...q, spaceId: qv.spaceId }, { deadlineMs: 1000 })).hits.length, 1);
    assert.equal((await W(core).denseSearch(core, { ...q, spaceId: 'some-other-space' }, { deadlineMs: 1000 })).hits.length, 0);
    // spaceId 不给 = 活动空间（伪查询向量用）
    assert.equal((await W(core).denseSearch(core, { ...q, spaceId: undefined }, { deadlineMs: 1000 })).hits.length, 1);
    core.store.run("UPDATE vector_spaces SET status = 'suspect'");
    assert.equal((await W(core).denseSearch(core, { ...q, spaceId: qv.spaceId }, { deadlineMs: 1000 })).hits.length, 0);
    assert.equal(await W(core).embedQuery(core, ['x'], { deadlineMs: 500 }), null);
  } finally { await cleanup(); }
});

test('MRL：embedding.dims 比端口的维数小就截断，空间 id 带上维数；查询向量也截到同样的维数', async () => {
  const emb = new FakeEmbedding({ dim: 256 });
  const { core, cleanup } = await workerCore({ name: 'worker-mrl', embedding: emb, config: { embedding: { dims: 128 } } });
  try {
    addText(core, 'assertion', 1, '主人这周开始玩艾尔登法环的DLC');
    addText(core, 'assertion', 2, '小林的英语六级考了520分');
    await drainQueue(core);
    const sp = core.store.get("SELECT space_id, port_space_id, dim FROM vector_spaces WHERE status = 'active'");
    assert.equal(sp.dim, 128);
    assert.equal(sp.port_space_id, emb.spaceId);
    assert.equal(sp.space_id, `${emb.spaceId}~d128`);
    assert.equal(core.vectors.get('SELECT q8 FROM vectors LIMIT 1').q8.byteLength, 128);
    const qv = await W(core).embedQuery(core, ['主人在玩什么新游戏'], { deadlineMs: 1000 });
    assert.equal(qv.spaceId, sp.space_id);
    assert.equal(qv.vectors[0].length, 128);
    const r = await W(core).denseSearch(core, { vectors: [emb.vector('小林的英语六级考了520分')], spaceId: qv.spaceId, layers: ['memory'], topK: { memory: 2, raw: 0 }, includeCold: false }, { deadlineMs: 1000 });
    assert.equal(r.hits[0].ref, 'a2');   // 256 维的向量传进来也会被截到 128 维
    assert.ok(r.hits[0].score > 0.99);
  } finally { await cleanup(); }
});

test('storedVectors：记忆层给 f32，原文层用 int8 还原；没有向量的不在结果里', async () => {
  const emb = new FakeEmbedding();
  const { core, cleanup } = await workerCore({ name: 'worker-stored', embedding: emb });
  try {
    addText(core, 'assertion', 1, '阿明说他表哥开网约车');
    addText(core, 'window', 2, '[10/30 21:00] 阿明：我表哥又被投诉了', { layer: 'raw' });
    await drainQueue(core);
    const m = await W(core).storedVectors(core, ['a1', 'w2', 'a99', 'not-a-ref']);
    assert.deepEqual([...m.keys()].sort(), ['a1', 'w2']);
    assert.ok(dot(m.get('a1'), emb.vector('阿明说他表哥开网约车')) > 0.9999);
    assert.ok(dot(m.get('w2'), emb.vector('[10/30 21:00] 阿明：我表哥又被投诉了')) > 0.999);
    assert.equal(W(core).activeSpaceId(core), emb.spaceId);
  } finally { await cleanup(); }
});

test('截止时间到了：带着已有的结果返回并标 timedOut', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-deadline' });
  try {
    addText(core, 'assertion', 1, '一条记忆');
    await drainQueue(core);
    const eng = new Engine({ main: wrapDatabase(new DatabaseSync(core.store.file, { readOnly: true })), vec: wrapDatabase(new DatabaseSync(core.vectors.file, { readOnly: true })) });
    try {
      const v = new FakeEmbedding().vector('一条记忆');
      const r = eng.dense({ spaceId: core.mods.worker.activeSpaceId(core), vectors: [v], layers: ['memory', 'raw'], topK: { memory: 5, raw: 5 }, deadlineAt: wallNow() - 1 });
      assert.equal(r.timedOut, true);
      assert.deepEqual(r.hits, []);
      const ok = eng.dense({ spaceId: core.mods.worker.activeSpaceId(core), vectors: [v], layers: ['memory'], topK: { memory: 5 }, deadlineAt: wallNow() + 5000 });
      assert.equal(ok.hits[0].ref, 'a1');
    } finally { eng.close(); }
  } finally { await cleanup(); }
});
