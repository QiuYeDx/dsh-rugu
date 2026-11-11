// 范围内检索（D153）：retrieve.scopeOf 圈范围（时间窗 / 关于谁 / 场合，交集、并集、截断、已经不在的不算），
// worker 的稠密、字面检索「只看这些」（only），线程和主线程本地引擎一致，没给 only 时和原来一样。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, insertRow } from '../worker/_helpers.js';
import { ftsInsert, ensurePerceptShard } from '../../src/store/index.js';
import { rowRanges } from '../../src/worker/engine.js';

const H = 3_600_000;
const DAY = 24 * H;
const W = (core) => core.mods.worker;
const R = (core) => core.mods.retrieve;
const sorted = (s) => [...(s ?? [])].sort();

/**
 * 一个编出来的小世界。D 是「那一天」的开头（现在往前两天）。
 * 人：她自己 self、主人 OWNER、朋友 FRIEND。场合：k-one、k-two。
 */
function seed(core) {
  const now = core.now();
  const D = now - 2 * DAY;
  const db = core.store;
  let self = db.get('SELECT id FROM entities WHERE is_self = 1')?.id;
  db.tx(() => {
    if (!self) { insertRow(db, 'entities', { id: 1, kind: 'self', is_self: 1, created_at: now - 30 * DAY, updated_at: now }); self = 1; }
    insertRow(db, 'entities', { id: 102, kind: 'person', created_at: now - 30 * DAY, updated_at: now });
    insertRow(db, 'entities', { id: 103, kind: 'person', created_at: now - 30 * DAY, updated_at: now });
  });
  const OWNER = 102;
  const FRIEND = 103;
  const ep = (id, key, t0, t1, parts, created = t1) => {
    insertRow(db, 'episodes', { id, setting_key: key, t_start: t0, t_end: t1, participants_json: JSON.stringify(parts), sealed_at: created, created_at: created,
      narrative: `n${id}` });
    ftsInsert(db, 'episodes_fts', id, [`n${id}`, ...parts.map((p) => `ent_${p}`)]);
  };
  const shard = ensurePerceptShard(db, D);
  const pc = (id, key, at, actor, kind, windowId) => insertRow(db, 'percepts', {
    id, adapter: 'fake', ext_key: `x${id}`, setting_key: key, perceived_in: key, visible_to: 'setting-audience', at, perceived_at: at,
    actor_entity_id: actor, actor_self: actor === self ? 1 : 0, actor_json: '{}', kind, text: `t${id}`, text_hash: `h${id}`,
    addressed: 'ambient', attention: 'attended', attention_class: 'x', evidential: 1, standing: 'first-hand', window_id: windowId,
    fts_shard: shard, created_at: at,
  });
  const win = (id, key, members, t0, t1, text = 'x') => insertRow(db, 'raw_windows', {
    id, setting_key: key, members_json: JSON.stringify(members), first_percept: members[0], last_percept: members.at(-1), n_percepts: members.length,
    t_start: t0, t_end: t1, text, created_at: t1,
  });
  const fact = (id, { ev = null, from = null, rec, sup = null, ents = [], src = null }) => {
    insertRow(db, 'assertions', { id, predicate: 'p', text: `f${id}`, certainty: 'stated', event_start: ev, valid_from: from, recorded_at: rec,
      superseded_by: sup, expired_at: sup ? rec : null, created_at: rec, updated_at: rec });
    for (const [e, role] of ents) db.run('INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, ?)', id, e, role);
    if (src) insertRow(db, 'sources', { owner_kind: 'assertion', owner_id: id, percept_id: src.percept ?? null, perceived_in: src.key ?? null, mode: 'told_to_her', at: rec });
  };
  db.tx(() => {
    ep(1, 'k-one', D + 1 * H, D + 2 * H, [self, OWNER]);
    ep(2, 'k-two', D + 3 * H, D + 4 * H, [self, FRIEND]);
    ep(3, 'k-one', D - 1 * H, D + 0.5 * H, [OWNER]);           // 从前一天晚上跨进来
    ep(4, 'k-one', D - 3 * DAY, D - 3 * DAY + H, [OWNER]);     // 窗外
    ep(5, 'k-one', D + 5 * H, D + 6 * H, [OWNER]);              // 被隐藏
    ep(6, 'k-one', D + 7 * H, D + 8 * H, [OWNER], now + H);     // 「现在」之后才记下
    insertRow(db, 'suppressions', { owner_kind: 'episode', owner_id: 5, state: 'hidden', by: 'owner', at: now });

    pc(10, 'k-one', D + 1 * H, OWNER, 'utterance', 1);
    pc(11, 'k-one', D + 1 * H + 60_000, self, 'self-utterance', 1);
    pc(12, 'k-two', D + 3 * H, FRIEND, 'utterance', 2);
    pc(13, 'k-one', D + 9 * H, FRIEND, 'utterance', 3);
    pc(14, 'k-one', D + 10 * H, OWNER, 'utterance', 8);         // 在 w7、w8 两个窗口里（相邻窗口重叠），window_id 是后一个
    pc(15, 'k-one', D + 10 * H + 60_000, FRIEND, 'utterance', 8);
    pc(16, 'k-one', D + 10 * H + 120_000, FRIEND, 'utterance', 8);
    pc(17, 'k-one', D + 9.5 * H, FRIEND, 'utterance', 7);
    pc(18, 'k-one', D - 3 * DAY, OWNER, 'utterance', 5);
    pc(19, 'k-one', D + 11 * H, OWNER, 'utterance', 4);
    win(1, 'k-one', [10, 11], D + 1 * H, D + 1 * H + 60_000);
    win(2, 'k-two', [12], D + 3 * H, D + 3 * H);
    win(3, 'k-one', [13], D + 9 * H, D + 9 * H);
    win(4, 'k-one', [19], D + 11 * H, D + 11 * H, null);       // 原文到期了
    win(5, 'k-one', [18], D - 3 * DAY, D - 3 * DAY);
    win(7, 'k-one', [17, 14], D + 9.5 * H, D + 10 * H);
    win(8, 'k-one', [14, 15, 16], D + 10 * H, D + 10 * H + 120_000);

    fact(1, { ev: D + 2 * H, rec: D + 2 * H, ents: [[OWNER, 'subject']], src: { percept: 10 } });
    fact(2, { from: D + 5 * H, rec: D + 5 * H, ents: [[FRIEND, 'subject']], src: { percept: 12 } });
    fact(3, { ev: D + 6 * H, rec: D + 6 * H, sup: 9, ents: [[OWNER, 'subject']], src: { percept: 10 } });   // 被取代了
    fact(4, { rec: D + 7 * H, ents: [[OWNER, 'mention']], src: { key: 'k-two' } });                     // 只有记下的时间、没有消息
    fact(5, { ev: D - 3 * DAY, rec: D - 3 * DAY, ents: [[OWNER, 'subject']], src: { percept: 18 } });
    fact(6, { ev: D + 8 * H, rec: D + 8 * H, ents: [[FRIEND, 'speaker']], src: { percept: 13 } });     // 他只是说的人，不算「关于他」
    fact(9, { ev: D + 6 * H, rec: D + 6 * H, ents: [[OWNER, 'subject']], src: { percept: 10 }, sup: null });
  });
  return { D, self, OWNER, FRIEND, day: { start: D, end: D + DAY - 1 } };
}

test('scopeOf：一样都没给 → 不圈；给的全不合法也算没给', async () => {
  const { core, cleanup } = await workerCore({ name: 'scope-none' });
  try {
    seed(core);
    for (const spec of [{}, { timeWindows: [] }, { timeWindows: [{ start: 5, end: 1 }, { start: NaN, end: 3 }], aboutEntityIds: [0, -1, 1.5], settingKeys: [''] }]) {
      const s = R(core).scopeOf(core, spec);
      assert.deepEqual(s, { given: false, refs: null, rows: [], counts: { episodes: 0, assertions: 0, windows: 0 }, clipped: false });
    }
  } finally { await cleanup(); }
});

test('scopeOf：时间窗——情节、窗口按起止重叠，事实按事件时间（没有就成立时间、再没有记下的时间）；已经不在的不算', async () => {
  const { core, cleanup } = await workerCore({ name: 'scope-time' });
  try {
    const w = seed(core);
    const s = R(core).scopeOf(core, { timeWindows: [w.day] });
    assert.equal(s.given, true);
    assert.equal(s.clipped, false);
    // e4 窗外、e5 隐藏、e6 现在之后才记下；a3 被取代、a5 窗外；w4 原文到期、w5 窗外
    assert.deepEqual(sorted(s.refs), ['a1', 'a2', 'a4', 'a6', 'a9', 'e1', 'e2', 'e3', 'w1', 'w2', 'w3', 'w7', 'w8']);
    assert.deepEqual(s.counts, { episodes: 3, assertions: 5, windows: 5 });
    assert.deepEqual(s.rows.map((r) => r.ref), [...s.rows].sort((x, y) => x.tStart - y.tStart || x.tEnd - y.tEnd || (x.ref < y.ref ? -1 : 1)).map((r) => r.ref));
    assert.equal(s.rows[0].ref, 'e3');   // 从前一天跨进来的排最前
    const row = (ref) => s.rows.find((r) => r.ref === ref);
    assert.deepEqual(row('e1'), { ref: 'e1', tStart: w.D + H, tEnd: w.D + 2 * H, settingKey: 'k-one' });
    assert.deepEqual(row('a2'), { ref: 'a2', tStart: w.D + 5 * H, tEnd: w.D + 5 * H, settingKey: 'k-two' });
    assert.equal(row('a4').settingKey, 'k-two');   // 没有消息的按来源记的场合
    // 几个窗取并集（重叠的并起来）；at 之前的才算
    const two = R(core).scopeOf(core, { timeWindows: [{ start: w.D - 3 * DAY - H, end: w.D - 3 * DAY + 2 * H }, { start: w.D + 2.5 * H, end: w.D + 3.5 * H }] });
    assert.deepEqual(sorted(two.refs), ['a5', 'e2', 'e4', 'w2', 'w5']);
    const later = R(core).scopeOf(core, { timeWindows: [w.day] }, { at: core.now() + 2 * H });
    assert.ok(later.refs.has('e6'));
    const early = R(core).scopeOf(core, { timeWindows: [w.day] }, { at: w.D + 2.5 * H });
    assert.deepEqual(sorted(early.refs), ['a1', 'e1', 'e3', 'w1']);
  } finally { await cleanup(); }
});

test('scopeOf：关于谁、场合，和时间取交集；同一样里几个值取并集；她自己也可以是「关于谁」', async () => {
  const { core, cleanup } = await workerCore({ name: 'scope-about' });
  try {
    const w = seed(core);
    const S = (spec) => sorted(R(core).scopeOf(core, spec).refs);
    // 时间 + 主人：参与者里有他的情节、主体 / 宾语 / 提到他的事实、成员里有他亲口说的话的窗口（w7、w8 都含 p14）
    assert.deepEqual(S({ timeWindows: [w.day], aboutEntityIds: [w.OWNER] }), ['a1', 'a4', 'a9', 'e1', 'e3', 'w1', 'w7', 'w8']);
    // 只给人：不限时间（e4、a5、w5 也在）；按人取窗口时相邻的前一个窗口也要找出来（w7）
    assert.deepEqual(S({ aboutEntityIds: [w.OWNER] }), ['a1', 'a4', 'a5', 'a9', 'e1', 'e3', 'e4', 'w1', 'w5', 'w7', 'w8']);
    // 她自己
    assert.deepEqual(S({ aboutEntityIds: [w.self] }), ['e1', 'e2', 'w1']);
    assert.deepEqual(S({ timeWindows: [w.day], aboutEntityIds: [w.self] }), ['e1', 'e2', 'w1']);
    // 只是说话人的不算「关于他」（a6）；两个人取并集
    assert.deepEqual(S({ aboutEntityIds: [w.FRIEND] }), ['a2', 'e2', 'w2', 'w3', 'w7', 'w8']);
    assert.deepEqual(S({ aboutEntityIds: [w.FRIEND, w.self] }), ['a2', 'e1', 'e2', 'w1', 'w2', 'w3', 'w7', 'w8']);
    // 场合
    assert.deepEqual(S({ timeWindows: [w.day], settingKeys: ['k-two'] }), ['a2', 'a4', 'e2', 'w2']);
    assert.deepEqual(S({ settingKeys: ['k-two'] }), ['a2', 'e2', 'w2']);   // 只给场合：事实只认来源有消息的（a4 没有消息）
    assert.deepEqual(S({ settingKeys: ['k-one', 'k-two'], aboutEntityIds: [w.FRIEND] }), ['a2', 'e2', 'w2', 'w3', 'w7', 'w8']);
    // 三样一起；交集为空时是空集合，不是「不圈」
    assert.deepEqual(S({ timeWindows: [w.day], aboutEntityIds: [w.OWNER], settingKeys: ['k-two'] }), ['a4']);
    const none = R(core).scopeOf(core, { timeWindows: [w.day], aboutEntityIds: [w.FRIEND], settingKeys: ['k-none'] });
    assert.equal(none.given, true);
    assert.equal(none.refs.size, 0);
  } finally { await cleanup(); }
});

test('scopeOf：超过 maxRefs 留最近的（按结束时间），标 clipped；配置里的默认值', async () => {
  const { core, cleanup } = await workerCore({ name: 'scope-clip', config: { recall: { scope: { maxRefs: 3 } } } });
  try {
    const w = seed(core);
    const s = R(core).scopeOf(core, { timeWindows: [w.day] });
    assert.equal(s.clipped, true);
    assert.deepEqual(s.rows.map((r) => r.ref), ['w3', 'w7', 'w8']);
    const s2 = R(core).scopeOf(core, { timeWindows: [w.day] }, { maxRefs: 4 });
    assert.deepEqual(sorted(s2.refs), ['a6', 'w3', 'w7', 'w8']);
    assert.equal(R(core).scopeOf(core, { timeWindows: [w.day] }, { maxRefs: 100 }).clipped, false);
  } finally { await cleanup(); }
});

test('scopeOf：查隐藏出错 → 什么都不能看（fail closed）', async () => {
  const { core, cleanup } = await workerCore({ name: 'scope-fail', mods: { admin: { suppressedRefs: () => { throw new Error('boom'); } } } });
  try {
    const w = seed(core);
    const s = R(core).scopeOf(core, { timeWindows: [w.day] });
    assert.equal(s.given, true);
    assert.equal(s.failed, 'suppression');
    assert.equal(s.refs.size, 0);
  } finally { await cleanup(); }
});

test('rowRanges：按大空隙切成几段', () => {
  assert.deepEqual(rowRanges([]), []);
  assert.deepEqual(rowRanges([5]), [[5, 5]]);
  assert.deepEqual(rowRanges([1, 2, 3, 4]), [[1, 4]]);
  // 跨度 4999、最多 4 段：只有大于 1/4 跨度的空隙才切
  assert.deepEqual(rowRanges([1, 2, 1000, 1001, 5000]), [[1, 1001], [5000, 5000]]);
  assert.deepEqual(rowRanges([1, 2, 3000, 3001, 9000]), [[1, 2], [3000, 3001], [9000, 9000]]);
  assert.deepEqual(rowRanges([1, 100, 200, 300, 400, 500], 2), [[1, 500]]);
});

// ── worker：只看这些 ─────────────────────────────────────────────────────

const TEXTS = [
  ['assertion', 1, '主人早上吃了一碗豆浆油条'],
  ['assertion', 2, '主人中午点了一份牛肉面'],
  ['assertion', 3, '朋友说晚上想去吃火锅'],
  ['episode', 4, '大家在群里讨论周末去哪里爬山'],
  ['episode', 5, '主人晚上吃了烤鱼还喝了奶茶'],
  ['window', 6, '[11/01 12:00] 主人：中午吃牛肉面，好辣'],
  ['window', 7, '[11/01 20:00] 主人：晚饭烤鱼'],
];

async function denseWorld(name, config) {
  const t = await workerCore({ name, config });
  for (const [kind, id, text] of TEXTS) addText(t.core, kind, id, text, { layer: kind === 'window' ? 'raw' : 'memory' });
  await drainQueue(t.core);
  return t;
}
async function dense(core, extra = {}) {
  const qv = await W(core).embedQuery(core, ['主人今天吃了什么'], { deadlineMs: 2000 });
  return W(core).denseSearch(core, { vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory', 'raw'], topK: { memory: 10, raw: 10 }, includeCold: false, ...extra },
    { deadlineMs: 5000 });
}

test('denseSearch only：只在这些里比；分数和不限时一样；精确比和粗排两条路一样；空集合没有命中；没给 only 和原来一样', async () => {
  const { core, cleanup } = await denseWorld('scope-dense');
  try {
    const all = await dense(core);
    assert.equal(all.hits.length, TEXTS.length);
    const only = new Set(['a2', 'e5', 'w7', 'a999']);
    const r = await dense(core, { only });
    assert.deepEqual(sorted(r.hits.map((h) => h.ref)), ['a2', 'e5', 'w7']);
    for (const h of r.hits) assert.equal(h.score, all.hits.find((x) => x.ref === h.ref).score);
    // exclude、layers、topK 照旧
    assert.deepEqual(sorted((await dense(core, { only, exclude: new Set(['a2']) })).hits.map((h) => h.ref)), ['e5', 'w7']);
    assert.deepEqual((await dense(core, { only, layers: ['raw'] })).hits.map((h) => h.ref), ['w7']);
    assert.equal((await dense(core, { only, topK: { memory: 1, raw: 0 } })).hits.length, 1);
    assert.deepEqual((await dense(core, { only: [] })).hits, []);
    // only = 全部：和不给 only 一字不差（精确比这条路）
    const allRefs = TEXTS.map(([k, id]) => `${k[0]}${id}`);
    assert.deepEqual(await dense(core, { only: allRefs }), all);
  } finally { await cleanup(); }
  // exactMax = 0：走粗排但只在 only 里，结果一样
  const t2 = await denseWorld('scope-dense-coarse', { recall: { scope: { exactMax: 0 } } });
  try {
    const all = await dense(t2.core);
    const r = await dense(t2.core, { only: ['a2', 'e5', 'w7'] });
    assert.deepEqual(sorted(r.hits.map((h) => h.ref)), ['a2', 'e5', 'w7']);
    assert.deepEqual(await dense(t2.core, { only: TEXTS.map(([k, id]) => `${k[0]}${id}`) }), all);
  } finally { await t2.cleanup(); }
});

function lexSeed(core) {
  const shard = ensurePerceptShard(core.store, core.now());
  core.store.tx((db) => {
    ftsInsert(db, 'episodes_fts', 1, ['烤鱼', '晚上']);
    ftsInsert(db, 'episodes_fts', 2, ['烤鱼', '周末']);
    ftsInsert(db, 'assertions_fts', 3, ['烤鱼', '好吃']);
    ftsInsert(db, 'assertions_fts', 4, ['火锅']);
    for (let i = 0; i < 6; i++) ftsInsert(db, shard, 100 + i, ['烤鱼', `话${i}`]);
    insertRow(db, 'raw_windows', { id: 9, setting_key: 'k', members_json: '[101,103]', first_percept: 101, last_percept: 103, n_percepts: 2,
      t_start: core.now(), t_end: core.now(), text: 'x', created_at: core.now() });
  });
  return shard;
}

test('lexicalSearch only：各表只看这些行；原文窗口按成员感知算；空集合没有命中；没给 only 和原来一样', async () => {
  const { core, cleanup } = await workerCore({ name: 'scope-lex' });
  try {
    const shard = lexSeed(core);
    const q = { terms: ['烤鱼', '晚上'], tables: [shard, 'episodes_fts', 'assertions_fts'], limit: 50 };
    const all = await W(core).lexicalSearch(core, q, { deadlineMs: 2000 });
    assert.equal(all.hits.length, 9);
    const r = await W(core).lexicalSearch(core, { ...q, only: new Set(['e1', 'a3', 'a4', 'w9', 'p105']) }, { deadlineMs: 2000 });
    assert.deepEqual(sorted(r.hits.map((h) => h.ref)), ['a3', 'e1', 'p101', 'p103', 'p105']);
    for (const h of r.hits) assert.equal(h.score, all.hits.find((x) => x.ref === h.ref).score);
    assert.deepEqual((await W(core).lexicalSearch(core, { ...q, only: [] }, { deadlineMs: 2000 })).hits, []);
    assert.deepEqual((await W(core).lexicalSearch(core, { ...q, only: ['e1', 'a3', 'w9'], limit: 2 }, { deadlineMs: 2000 })).hits.length, 2);
    const allRefs = ['e1', 'e2', 'a3', 'a4', ...[0, 1, 2, 3, 4, 5].map((i) => `p${100 + i}`)];
    assert.deepEqual(await W(core).lexicalSearch(core, { ...q, only: allRefs }, { deadlineMs: 2000 }), all);
  } finally { await cleanup(); }
});

test('only：worker 线程和主线程本地引擎结果一致', async () => {
  const { core, cleanup } = await denseWorld('scope-thread');
  try {
    const shard = lexSeed(core);
    // start 先清扫向量：主表里要有这些记忆
    core.store.tx((db) => {
      for (const [kind, id] of TEXTS) {
        const t = core.now();
        if (kind === 'assertion' && !db.get('SELECT 1 AS x FROM assertions WHERE id = ?', id)) insertRow(db, 'assertions', { id, predicate: 'p', text: 'x', certainty: 'stated', recorded_at: t, created_at: t, updated_at: t });
        if (kind === 'episode' && !db.get('SELECT 1 AS x FROM episodes WHERE id = ?', id)) insertRow(db, 'episodes', { id, setting_key: 'k', t_start: t, t_end: t, sealed_at: t, created_at: t });
        if (kind === 'window' && !db.get('SELECT 1 AS x FROM raw_windows WHERE id = ?', id)) insertRow(db, 'raw_windows', { id, setting_key: 'k', first_percept: 1, last_percept: 1, n_percepts: 1, t_start: t, t_end: t, text: 'x', created_at: t });
      }
    });
    const only = ['a2', 'e5', 'w7', 'w9', 'e1', 'a3'];
    const lq = { terms: ['烤鱼'], tables: [shard, 'episodes_fts', 'assertions_fts'], limit: 50, only };
    const localDense = await dense(core, { only });
    const localLex = await W(core).lexicalSearch(core, lq, { deadlineMs: 2000 });
    assert.ok(localDense.hits.length && localLex.hits.length);
    assert.equal((await W(core).start(core)).ok, true);
    assert.equal(W(core).health(core).mode, 'thread');
    const thDense = await dense(core, { only });
    assert.deepEqual(thDense.hits.map((h) => h.ref), localDense.hits.map((h) => h.ref));
    for (let i = 0; i < thDense.hits.length; i++) assert.ok(Math.abs(thDense.hits[i].score - localDense.hits[i].score) < 1e-9);
    assert.deepEqual(await W(core).lexicalSearch(core, lq, { deadlineMs: 2000 }), localLex);
  } finally { await W(core).stop(core); await cleanup(); }
});
