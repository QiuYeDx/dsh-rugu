// 第一眼（D106）：合格的话感知落库后排队看一眼；没有定时器（不在看就马上看，在看就排着、下一次一起看）；代码核对原话、改掉了哪一条、
// 不带细节的说法；失败、预算不给 → failed，下一次合格的事件再试；重启后留下的 pending 轮到它被想起时重新排上；级联删除和原文到期。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, platformSeeds, FakeLLM, glancer, deferred, readGlanceCard } from '../scenarios/presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const G = (w, o) => w.core.mods.discretion.glancesOf(w.core, [w.perceptOf(o).id]).get(w.perceptOf(o).id) ?? null;

test('合格：一对一里的、对她说的、她刚回过的人说的、她回那样一句的；不合格：旁边的人随口说的、回填的', async () => {
  const w = await openWorld({ seed: SEED, name: 'gl-elig', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer() } }) });
  try {
    const dm = w.say('oneOnOne', 'principal', '在吗', { addressed: 'to-her', attention: 'attended' });
    const to = w.say('smallGroup', 'friend', '@她 你好', { addressed: 'mentions-her', attention: 'attended' });
    const reply = w.say('smallGroup', 'her', '你好呀');
    const next = w.say('smallGroup', 'friend', '今天好热', { addressed: 'ambient', attention: 'peripheral' });
    const amb = w.say('smallGroup', 'other', '路过', { addressed: 'ambient', attention: 'peripheral' });
    const old = w.say('oneOnOne', 'principal', '以前的话', { addressed: 'to-her', attention: 'attended', historical: true });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(G(w, dm)?.state, 'done', '一对一');
    assert.equal(G(w, to)?.state, 'done', '对她说的');
    assert.equal(G(w, reply)?.state, 'done', '她回的那一句');
    assert.equal(G(w, next)?.state, 'done', '她刚回过的人接着说的');
    assert.equal(G(w, amb), null, '旁边的人随口说的：不看');
    assert.equal(G(w, old), null, '回填的：不看');
  } finally { await w.close(); }
});

test('排队没有定时器：这个场合在看时排着，看完马上把排着的一起看；全局最多 concurrency 个同时在看', async () => {
  const gates = [];
  const calls = [];
  const llm = new FakeLLM({ fallback: { glance: async (req) => { const g = deferred(); gates.push(g); calls.push(readGlanceCard(req).targets.length); await g.promise; return glancer()(req); } } });
  const w = await openWorld({ seed: SEED, name: 'gl-queue', config: { ...LIVE, discretion: { glance: { concurrency: 1 } } }, llm });
  try {
    w.say('oneOnOne', 'principal', '第一句', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    assert.equal(calls.length, 1, '不在看：马上看（不等防抖）');
    w.say('oneOnOne', 'principal', '第二句', { addressed: 'to-her', attention: 'attended' });
    w.say('oneOnOne', 'principal', '第三句', { addressed: 'to-her', attention: 'attended' });
    w.say('smallGroup', 'friend', '@她 你好', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    assert.equal(calls.length, 1, '在看：排着；另一个场合也等（concurrency 1）');
    gates.shift().resolve();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls.length, 2, '看完马上看下一批');
    assert.ok(calls[1] === 2 || calls[1] === 1, `排着的一起看：${calls}`);
    while (gates.length) { gates.shift().resolve(); await new Promise((r) => setTimeout(r, 5)); }
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.ok(calls.length <= 4, `没有一条一次：${calls}`);
  } finally { for (const g of gates) g.resolve(); await w.close(); }
});

test('代码核对：原话不在他的话里不收紧；只认同一个人更早的一行算「改掉了」；不带细节的说法里有数字就不要', async () => {
  const judge = (t) => {
    if (/搬家/.test(t.text)) return { limit: 'strict', quote: '千万保密', vague: '他要搬到3号楼' };
    if (/改成/.test(t.text)) return { replaces: 1 };
    return {};
  };
  const w = await openWorld({ seed: SEED, name: 'gl-check', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer(judge) } }) });
  try {
    const a = w.say('oneOnOne', 'principal', '我下周搬家', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const ga = G(w, a);
    assert.equal(ga.quoteOk, false, '编出来的原话');
    assert.equal(ga.vague, null, '带数字的「大概」不要');
    assert.equal(w.core.mods.discretion.normOf(w.core, { kind: 'percept', id: w.perceptOf(a).id }).restriction, 'none', '没核对上：不收紧');
    const r1 = w.say('oneOnOne', 'principal', '我说一个数你乘2', { addressed: 'to-her', attention: 'attended' });
    const r2 = w.say('oneOnOne', 'principal', '不对，改成乘3', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const g2 = G(w, r2);
    // 卡片上第 1 行是更早的「我下周搬家」（同一个人、更早）：代码只核对「同一个人、更早」，认它；真模型会指向乘2 那一行
    assert.ok(g2.replaces == null || [w.perceptOf(a).id, w.perceptOf(r1).id].includes(g2.replaces));
  } finally { await w.close(); }
});

test('失败、预算不给 → failed；下一次这个场合有合格的事件时再试一次；重启后留下的 pending 轮到被想起时重新排上', async () => {
  const llm = new FakeLLM({ script: { glance: [new Error('down')] }, fallback: { glance: glancer() } });
  const w = await openWorld({ seed: SEED, name: 'gl-fail', config: LIVE, llm });
  try {
    const a = w.say('oneOnOne', 'principal', '第一句', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(G(w, a).state, 'failed');
    w.say('oneOnOne', 'principal', '第二句', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(G(w, a).state, 'done', '下一次合格的事件：再试一次');
    // 预算不给
    w.ports.budget.setLimit('glance', 0);
    const b = w.say('oneOnOne', 'principal', '第三句', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(G(w, b).state, 'failed');
    assert.ok(Number(w.core.store.get("SELECT SUM(value) AS v FROM metrics WHERE name = 'discretion.glance.budget'")?.v ?? 0) >= 1);
    // 「重启后」：库里是 pending、这个进程里没有在看它的 → 轮到它被想起时重新排上
    w.ports.budget.setLimit('glance', 1000);
    w.core.store.run("UPDATE glances SET state = 'pending' WHERE percept_id = ?", w.perceptOf(b).id);
    const t = w.core.mods.discretion.targetFor(w.core, { settingKey: w.keyOf('oneOnOne'), homeSettingKey: w.keyOf('oneOnOne'), sessionId: null,
      triggerEntityId: w.perceptOf(b).actor_entity_id, mode: 'involuntary', at: w.clock.now() });
    w.core.mods.discretion.admitWorking(w.core, [{ ref: `p${w.perceptOf(b).id}` }], t);
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(G(w, b).state, 'done', '重新排上、看完了');
  } finally { await w.close(); }
});

test('级联：彻底删除感知时它的第一眼一起删；原文到期时第一眼抄下的原话和大概清掉', async () => {
  const w = await openWorld({ seed: SEED, name: 'gl-cascade', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer() } }) });
  try {
    const a = w.say('oneOnOne', 'principal', '别外传，我要辞职了', { addressed: 'to-her', attention: 'attended' });
    const b = w.say('oneOnOne', 'principal', '我体检血糖偏高', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.ok(G(w, a)?.quote && G(w, b)?.gist);
    const bid = w.perceptOf(b).id;
    w.core.mods.intake.expireRawText(w.core, { before: w.clock.now() + 1 });
    const row = w.core.store.get('SELECT quote, gist, vague FROM glances WHERE percept_id = ?', bid);
    assert.deepEqual([row.quote, row.gist, row.vague], [null, null, null]);
    const { deleteUnit } = await import('../../src/admin/purge.js');
    w.core.store.tx(() => deleteUnit(w.core.store, { kind: 'percept', id: bid }));
    assert.equal(w.core.store.get('SELECT COUNT(*) AS n FROM glances WHERE percept_id = ?', bid).n, 0);
  } finally { await w.close(); }
});
