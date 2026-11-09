// 实体扩散路（§8.2，评审:FE-14）：「实体—事实—情节」图上的局部推送 PPR。
// 「群友阿明的表哥」（P2）：表哥没有账号，靠关系描述挂在阿明下面，从阿明扩散能想起表哥的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { workerCore, insertRow } from './_helpers.js';
import { Engine, wrapDatabase } from '../../src/worker/engine.js';
import { wallNow } from '../../src/worker/vindex.js';

const W = (core) => core.mods.worker;

/** 图的夹具（直接写行：这些表归 entities / encode，这里只是测试数据）。 */
function graph(core) {
  const t = core.now();
  const db = core.store;
  const ent = (id, name, extra = {}) => insertRow(db, 'entities', {
    id, kind: extra.kind ?? 'person', status: extra.status ?? 'established', display_name: name, created_at: t, updated_at: t,
  });
  const fact = (id, text, roles) => {
    insertRow(db, 'assertions', { id, predicate: 'p', text, certainty: 'stated', recorded_at: t, created_at: t, updated_at: t });
    for (const [e, role] of roles) db.run('INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, ?)', id, e, role);
  };
  db.tx(() => {
    ent(1, '阿明');
    ent(2, null);                 // 阿明的表哥：没有名字、没有账号
    ent(3, '小雨');
    ent(4, '团子', { kind: 'pet' });
    ent(9, '假的', { status: 'retracted' });
    insertRow(db, 'entity_descriptors', { entity_id: 2, anchor_entity_id: 1, relation: '表哥', text: '表哥', first_at: t, last_at: t, created_at: t });
    fact(10, '阿明和女朋友吵架了，后来又和好了', [[1, 'subject']]);
    fact(11, '阿明的表哥开网约车，前阵子被乘客投诉', [[2, 'subject'], [1, 'mention']]);
    fact(12, '阿明的表哥又换了一辆新能源车', [[2, 'subject']]);
    fact(13, '小雨搬到了海淀', [[3, 'subject']]);
    fact(14, '团子拉肚子去了宠物医院', [[4, 'subject']]);
    fact(15, '假的实体的事', [[9, 'subject']]);
    fact(16, '阿明提到过一个不存在的人', [[1, 'mention'], [9, 'mention']]);
    insertRow(db, 'episodes', { id: 20, setting_key: 'k', narrative: '阿明说他表哥的事', t_start: t, t_end: t, participants_json: '[1,3]', sealed_at: t, created_at: t });
    insertRow(db, 'intentions', {
      id: 30, target_entity_id: 1, act: '追问', text: '问问阿明和好了没', origin: 'self-care', formed_at: t, created_at: t, updated_at: t, about_kind: 'assertion', about_id: 10,
    });
  });
}

test('从阿明扩散：想起阿明的事、阿明的表哥（没有账号）和表哥的事；无关的人的事不出现', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-ppr' });
  try {
    graph(core);
    const r = await W(core).pprSearch(core, { seeds: [{ entityId: 1, weight: 1 }], maxHops: 3, limit: 50 }, { deadlineMs: 2000 });
    assert.equal(r.timedOut, false);
    const refs = r.hits.map((h) => h.ref);
    for (const want of ['a10', 'a11', 'a12', 'n2', 'e20', 't30']) assert.ok(refs.includes(want), `${want} 应该在里面：${refs.join(' ')}`);
    assert.ok(!refs.includes('a14'), '团子的事和阿明没有关系');
    assert.ok(!refs.includes('n1'), '种子本身不算命中');
    assert.ok(!refs.includes('a15'), '撤销的实体不往外扩散');
    const score = Object.fromEntries(r.hits.map((h) => [h.ref, h.score]));
    assert.ok(score.a10 > score.a12, '阿明自己的事比表哥的事更近');
    for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i - 1].score >= r.hits[i].score);
    // 跳数限制：一跳只到阿明直接连着的
    const one = await W(core).pprSearch(core, { seeds: [{ entityId: 1, weight: 1 }], maxHops: 1, limit: 50 }, { deadlineMs: 2000 });
    const oneRefs = one.hits.map((h) => h.ref);
    assert.ok(oneRefs.includes('a10') && oneRefs.includes('n2'));
    assert.ok(!oneRefs.includes('a12'), '表哥的事要两跳');
    // 多个种子按权重
    const two = await W(core).pprSearch(core, { seeds: [{ entityId: 1, weight: 0.2 }, { entityId: 3, weight: 1 }], maxHops: 2, limit: 3 }, { deadlineMs: 2000 });
    assert.equal(two.hits[0].ref, 'a13');
    assert.equal(two.hits.length, 3);
    assert.deepEqual((await W(core).pprSearch(core, { seeds: [], maxHops: 2, limit: 5 }, { deadlineMs: 500 })).hits, []);
    assert.deepEqual((await W(core).pprSearch(core, { seeds: [{ entityId: 999, weight: 1 }], maxHops: 2, limit: 5 }, { deadlineMs: 500 })).hits, []);
  } finally { await cleanup(); }
});

test('大家都提到过的人（扇出很大）被稀释，不会把整张图拖进来；耗时有界', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-ppr-hub', config: { recall: { ppr: { fanCap: 50 } } } });
  try {
    const t = core.now();
    core.store.tx((db) => {
      insertRow(db, 'entities', { id: 1, kind: 'person', status: 'established', display_name: '大家都认识的人', created_at: t, updated_at: t });
      insertRow(db, 'entities', { id: 2, kind: 'person', status: 'established', display_name: '小众', created_at: t, updated_at: t });
      for (let i = 1; i <= 2000; i++) {
        insertRow(db, 'assertions', { id: i, predicate: 'p', text: 'x', certainty: 'stated', recorded_at: t, created_at: t, updated_at: t });
        db.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, 1, 'mention')", i);
      }
      insertRow(db, 'assertions', { id: 5000, predicate: 'p', text: 'y', certainty: 'stated', recorded_at: t, created_at: t, updated_at: t });
      db.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (5000, 2, 'subject')");
      db.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (5000, 1, 'mention')");
    });
    const t0 = performance.now();
    const r = await W(core).pprSearch(core, { seeds: [{ entityId: 1, weight: 1 }, { entityId: 2, weight: 1 }], maxHops: 2, limit: 10 }, { deadlineMs: 5000 });
    assert.ok(performance.now() - t0 < 3000);
    assert.equal(r.hits[0].ref, 'a5000', '小众那个人唯一的事排第一（大人物的 2000 条每条只分到很少）');
    assert.ok(r.hits.length <= 10);
  } finally { await cleanup(); }
});

test('截止时间到了：带着已有的结果返回 timedOut', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-ppr-deadline' });
  try {
    graph(core);
    const eng = new Engine({ main: wrapDatabase(new DatabaseSync(core.store.file, { readOnly: true })), vec: null });
    try {
      const r = eng.ppr({ seeds: [{ entityId: 1, weight: 1 }], maxHops: 2, limit: 10, deadlineAt: wallNow() - 1 });
      assert.equal(r.timedOut, true);
      const ok = eng.ppr({ seeds: [{ entityId: 1, weight: 1 }], maxHops: 2, limit: 10, deadlineAt: wallNow() + 5000 });
      assert.equal(ok.timedOut, false);
      assert.ok(ok.hits.length > 0);
      // 新加的情节：参与者倒排按 id 增量补上
      insertRow(core.store, 'episodes', { id: 21, setting_key: 'k', narrative: '小雨和阿明', t_start: 1, t_end: 1, participants_json: '[1]', sealed_at: 1, created_at: 1 });
      const again = eng.ppr({ seeds: [{ entityId: 1, weight: 1 }], maxHops: 1, limit: 50, deadlineAt: wallNow() + 5000 });
      assert.ok(again.hits.some((h) => h.ref === 'e21'));
    } finally { eng.close(); }
  } finally { await cleanup(); }
});
