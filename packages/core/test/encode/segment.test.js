// encode.segment（§7.2、§12.8 第 2 条）：缓冲就是 episode_id 为空的感知；便宜信号找边界；优先级只按 w_att × w_rel × 新鲜度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, insertRow, MINUTE, HOUR } from './harness.js';

const payload = (j) => JSON.parse(j.payload_json);

test('间隔 ≥ 20 分钟是确定的边界；最后一段要空闲够了（或 force）才封口；重复调用不重复排任务', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('群', { exposure: 2 });
    const a = w.entity('甲');
    const b = w.entity('乙');
    const ids1 = [w.percept(g, a, '今晚打本吗'), w.percept(g, b, '打'), w.percept(g, a, '八点上线')];
    w.clock.minutes(30);
    const ids2 = [w.percept(g, b, '刚吃完饭'), w.percept(g, a, '好的')];
    let r = w.core.mods.encode.segment(w.core, {});
    assert.equal(r.jobs, 1, '第一段封口；第二段还在说，不封');
    let jobs = w.jobs();
    assert.deepEqual(payload(jobs[0]).perceptIds, ids1);
    assert.equal(payload(jobs[0]).boundaryCertain, true);
    r = w.core.mods.encode.segment(w.core, {});
    assert.equal(r.jobs, 0, '同一个范围不重复排');
    w.clock.minutes(25);
    r = w.core.mods.encode.segment(w.core, {});
    assert.equal(r.jobs, 1, '空闲 ≥ 20 分钟：最后一段也封口');
    jobs = w.jobs();
    assert.deepEqual(payload(jobs.find((j) => j.ep_from === ids2[0])).perceptIds, ids2);
  } finally { await w.cleanup(); }
});

test('force（夜间整理第 1 步）把全部缓冲封口；满 25 条切一刀；回填和实时不混在一段', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('群', { exposure: 2 });
    const a = w.entity('甲');
    for (let i = 0; i < 30; i++) { w.percept(g, a, `消息${i}`); w.clock.minutes(0.5); }
    const r = w.core.mods.encode.segment(w.core, { settingKey: g.key, force: true });
    assert.equal(r.jobs, 2);
    const sizes = w.jobs().map((j) => payload(j).perceptIds.length).sort((x, y) => y - x);
    assert.deepEqual(sizes, [25, 5]);
  } finally { await w.cleanup(); }
  const w2 = await makeWorld();
  try {
    const g = w2.setting('群', { exposure: 2 });
    const a = w2.entity('甲');
    w2.percept(g, a, '旧的一条', { historical: true, at: w2.clock.now() - 2 * HOUR });
    w2.percept(g, a, '新的一条');
    w2.core.mods.encode.segment(w2.core, { force: true });
    const jobs = w2.jobs();
    assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map((j) => payload(j).historical).sort(), [false, true]);
  } finally { await w2.cleanup(); }
});

test('优先级只按 w_att × w_rel × 新鲜度：对她说的、亲近的人说的、刚发生的排前；大群旁听排后但照样排', async () => {
  const w = await makeWorld();
  try {
    const owner = w.entity('阿杰', { closeness: 1, authority: 'principal' });
    const stranger = w.entity('路人', { closeness: 0 });
    const dm = w.setting('私聊', { exposure: 0 });
    const big = w.setting('大群', { exposure: 2, size: 500 });
    w.percept(big, stranger, '有人吗', { addressed: 'ambient', attention: 'peripheral' });
    w.percept(dm, owner, '在吗', { addressed: 'to-her' });
    w.core.mods.encode.segment(w.core, { force: true });
    const jobs = w.jobs();
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].scope_key, dm.key, '对她说的、主人说的排在前面');
    assert.ok(jobs[0].priority > jobs[1].priority);
    assert.ok(jobs[1].priority > 0);
    assert.equal(payload(jobs[0]).reserved, true, '对她说的一对一内容有预留的预算');
    assert.equal(payload(jobs[1]).reserved, false);
    // 新鲜度：同样的话，一天前的排得比刚才的低
    const w2 = await makeWorld();
    try {
      const o = w2.entity('阿杰', { closeness: 1, authority: 'principal' });
      const s1 = w2.setting('私聊1', { exposure: 0 });
      const s2 = w2.setting('私聊2', { exposure: 0 });
      w2.percept(s1, o, '在吗', { addressed: 'to-her', at: w2.clock.now() - 24 * HOUR });
      w2.percept(s2, o, '在吗', { addressed: 'to-her' });
      w2.core.mods.encode.segment(w2.core, { force: true });
      const [first, second] = w2.jobs();
      assert.equal(first.scope_key, s2.key);
      assert.ok(Math.abs(second.priority * 2 - first.priority) <= 1, '半衰期 24 小时');
    } finally { await w2.cleanup(); }
  } finally { await w.cleanup(); }
});

test('参与者大换是拿不准的边界：交给 LLM（boundaryCertain=false），它没定下来之前后面不再切', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('群', { exposure: 2 });
    const [a, b, c, d] = ['甲', '乙', '丙', '丁'].map((n) => w.entity(n));
    for (const who of [a, b, a, b, a, b]) { w.percept(g, who, '聊游戏'); w.clock.minutes(1); }
    for (const who of [c, d, c, d, c, d]) { w.percept(g, who, '聊做饭'); w.clock.minutes(1); }
    w.clock.minutes(30);
    const r = w.core.mods.encode.segment(w.core, { settingKey: g.key });
    assert.equal(r.jobs, 1);
    const [j] = w.jobs();
    assert.equal(payload(j).boundaryCertain, false);
    assert.equal(payload(j).perceptIds.length, 6, '在参与者换掉的地方切（前后各 5 条比较）');
    assert.equal(w.core.mods.encode.segment(w.core, { settingKey: g.key }).jobs, 0, '拿不准的段还没定下来，后面不切');
  } finally { await w.cleanup(); }
});

/** 给一个原文窗口放一条活动空间里的向量（worker 的向量库，按 schema 直接写测试数据）。 */
function windowVector(w, winId, vec, { space = 'sp-test', int8 = false } = {}) {
  const f = Float32Array.from(vec);
  const q8 = Buffer.from(Int8Array.from(vec.map((x) => Math.round(x * 127))).buffer);
  w.core.vectors.run(`INSERT INTO vectors(space_id, embed_text_id, owner_kind, owner_id, chunk_no, kind, layer, text_hash, q8, q8_scale, bin, created_at, f32)
    VALUES (?, ?, 'window', ?, 0, 'text', 'raw', 'h', ?, 1, ?, ?, ?)`, space, 1000 + winId, winId, q8, Buffer.alloc(1), w.clock.now(), int8 ? null : Buffer.from(f.buffer));
}

test('原文窗口的话题漂移是拿不准的边界（只比同一 visible_to 组里相邻的窗口）；没有活动空间时没有漂移切口', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('群', { exposure: 2 });
    const [a, b] = ['甲', '乙'].map((n) => w.entity(n));
    const game = [];
    const food = [];
    for (let i = 0; i < 4; i++) { game.push(w.percept(g, i % 2 ? b : a, '聊游戏')); w.clock.minutes(1); }
    const priv = w.percept(g, a, '私下看到的', { visibleTo: 'her-only' });
    w.clock.minutes(1);
    for (let i = 0; i < 4; i++) { food.push(w.percept(g, i % 2 ? b : a, '聊做饭')); w.clock.minutes(1); }
    const w1 = w.rawWindow(g, game);
    const wp = w.rawWindow(g, [priv]);
    w.core.store.run("UPDATE raw_windows SET visible_to = 'her-only' WHERE id = ?", wp);
    const w2 = w.rawWindow(g, food);
    // 同一组的两个窗口话题相近（cos 0.99），中间夹着一个私下读到的、话题完全不同的窗口：不算漂移
    windowVector(w, w1, [1, 0, 0, 0]);
    windowVector(w, wp, [0, 0, 1, 0]);
    windowVector(w, w2, [0.99, 0.14, 0, 0], { int8: true });
    w.clock.minutes(30);
    insertRow(w.core, 'vector_spaces', { space_id: 'sp-test', port_space_id: 'sp-test', model: 'fake', dim: 4, doc_tpl_ver: 'v1', status: 'active', created_at: w.clock.now() });
    assert.equal(w.core.mods.encode.segment(w.core, { settingKey: g.key }).jobs, 1);
    assert.equal(payload(w.jobs()[0]).boundaryCertain, true, '没有漂移：整段在空闲时确定封口');
    assert.equal(payload(w.jobs()[0]).perceptIds.length, 9);
  } finally { await w.cleanup(); }

  const w3 = await makeWorld();
  try {
    const g = w3.setting('群', { exposure: 2 });
    const [a, b] = ['甲', '乙'].map((n) => w3.entity(n));
    const game = [];
    const food = [];
    for (let i = 0; i < 4; i++) { game.push(w3.percept(g, i % 2 ? b : a, '聊游戏')); w3.clock.minutes(1); }
    for (let i = 0; i < 4; i++) { food.push(w3.percept(g, i % 2 ? b : a, '聊做饭')); w3.clock.minutes(1); }
    const w1 = w3.rawWindow(g, game);
    const w2 = w3.rawWindow(g, food);
    windowVector(w3, w1, [1, 0, 0, 0]);
    windowVector(w3, w2, [0, 1, 0, 0], { int8: true });
    w3.clock.minutes(30);
    // 还没有活动空间：漂移这一路缺席，不切
    assert.equal(w3.core.mods.encode.segment(w3.core, { settingKey: g.key }).jobs, 1);
    assert.equal(payload(w3.jobs()[0]).perceptIds.length, 8);
    w3.core.store.run('DELETE FROM jobs');   // 当作还没排过（只为了在同一份缓冲上再切一次）
    insertRow(w3.core, 'vector_spaces', { space_id: 'sp-test', port_space_id: 'sp-test', model: 'fake', dim: 4, doc_tpl_ver: 'v1', status: 'active', created_at: w3.clock.now() });
    // 同一组相邻的两个窗口话题不同（cos 0）：在第二个窗口的第一条之前切，交给 LLM 判断
    assert.equal(w3.core.mods.encode.segment(w3.core, { settingKey: g.key }).jobs, 1);
    const [j] = w3.jobs();
    assert.equal(payload(j).boundaryCertain, false);
    assert.deepEqual(payload(j).perceptIds, game);
  } finally { await w3.cleanup(); }
});

test('只读库什么都不做', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('群', { exposure: 2 });
    const a = w.entity('甲');
    w.percept(g, a, '你好');
    w.core.readOnly = true;
    assert.deepEqual(w.core.mods.encode.segment(w.core, { force: true }), { jobs: 0 });
    w.core.readOnly = false;
    assert.equal(w.core.mods.encode.segment(w.core, { force: true, at: w.clock.now() }).jobs, 1);
  } finally { await w.cleanup(); }
});
