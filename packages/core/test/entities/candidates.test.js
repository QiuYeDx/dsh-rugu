// candidates（第 4 步）：名字连同上下文的向量候选；关系路径；锚点冲突负分；嵌入不可用时退化；带关系时主人不是候选。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, person, T0, DAY } from './helpers.js';

const NS = 'zq';

async function setup(name, opt) {
  const t = await entitiesCore({ name, ...opt });
  const { core } = t;
  const E = core.mods.entities;
  const aming = person(core, NS, 'ua1', T0, '阿明');
  const bb = person(core, NS, 'ub1', T0, '小B');
  const ctx = (speaker, at) => ({ speakers: new Map([['U1', speaker]]), settingKey: 'G1', at, jobId: 1, msgRefs: new Map([['m1', percept(core, { actor: speaker, at })]]) });
  const cousin = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U1', relation: '表哥' }, msgRefs: ['m1'] }], ctx(aming, T0)).get('E1');
  const otherCousin = E.resolveExtracted(core, [{ local: 'E1', name: '大壮', kind: 'person', descriptor: { anchor: 'U1', relation: '表哥' }, msgRefs: ['m1'] }], ctx(bb, T0 + DAY)).get('E1');
  return { ...t, E, aming, bb, cousin, otherCousin };
}

test('candidates：关系路径 + 名字 + 向量，多路命中的排前；分数和理由不含内容', async () => {
  const t = await setup('cand-basic');
  try {
    const { core, E, aming, cousin, otherCousin, rec } = t;
    const c = await E.candidates(core, { name: '小刚', context: '我表哥小刚又换车了', anchorEntityId: aming, relation: '表哥', settingKey: 'G1' });
    assert.equal(c[0].entityId, cousin);
    assert.ok(c[0].why.includes('relation') && c[0].why.includes('name'));
    assert.ok(c[0].score <= 1);
    const other = c.find((x) => x.entityId === otherCousin);
    if (other) assert.ok(other.score < c[0].score);
    assert.ok(rec.embedQueries >= 1 && rec.denseSearches >= 1, '用了查询嵌入和稠密扫描');
    assert.ok(c.length <= 15);
    assert.ok(!c.some((x) => x.entityId === aming), '锚点自己不是候选');
  } finally { await t.cleanup(); }
});

test('candidates：只有向量对得上（档案文本相似）也能当候选；余弦 < 0.6 的不要', async () => {
  const t = await setup('cand-vec');
  try {
    const { core, E, cousin } = t;
    const c = await E.candidates(core, { name: null, context: '阿明 表哥 小刚' });
    const hit = c.find((x) => x.entityId === cousin);
    assert.ok(hit && hit.why.includes('vector'), '名字没给，靠档案文本的向量');
    const none = await E.candidates(core, { name: null, context: 'zzzz qqqq xxxx' });
    assert.equal(none.length, 0);
  } finally { await t.cleanup(); }
});

test('candidates：嵌入不可用（L3）时只用名字表和关系路径，不抛错', async () => {
  const t = await setup('cand-l3', { embedding: null });
  try {
    const { core, E, aming, cousin, rec } = t;
    const c = await E.candidates(core, { name: '小刚', context: '我表哥小刚', anchorEntityId: aming, relation: '表哥' });
    assert.equal(c[0].entityId, cousin);
    assert.equal(rec.denseSearches, 0);
    // worker 直接抛错也一样
    const t2 = await setup('cand-throw', { mods: { worker: { embedQuery: async () => { throw new Error('down'); } } } });
    try {
      const c2 = await t2.E.candidates(t2.core, { name: '小刚', context: '……', anchorEntityId: t2.aming, relation: '表哥' });
      assert.equal(c2[0].entityId, t2.cousin);
    } finally { await t2.cleanup(); }
  } finally { await t.cleanup(); }
});

test('candidates：带关系描述时，和主人同名的主人不是候选；不带关系时主人可以是候选（交给 LLM 看上下文）', async () => {
  const t = await setup('cand-principal');
  try {
    const { core, E, aming } = t;
    const p = E.ensurePrincipal(core);
    const withRel = await E.candidates(core, { name: '主人', context: '我表妹主人', anchorEntityId: aming, relation: '表妹' });
    assert.ok(!withRel.some((x) => x.entityId === p));
    const noRel = await E.candidates(core, { name: '主人', context: '主人今天来了吗' });
    assert.ok(noRel.some((x) => x.entityId === p));
  } finally { await t.cleanup(); }
});
