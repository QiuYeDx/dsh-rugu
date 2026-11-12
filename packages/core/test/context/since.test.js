// 「这之后他的事」的选取（D164，context/since.js）：since 的几种算法、候选的口径、排序和名额。内容都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withWorld, percept, plan, refOf, M, H, GROUP, DM, OTHER } from './world.js';
import { sinceOf, candidatesFor, sinceHereFor } from '../../src/context/since.js';

/** 一条关于 subject 的事实，来源是 percept（来源那句话的时间就是那条感知的时间）。 */
function fact(core, { subject, text = '一件事', imp = 5, src = null, at = core.now(), kindHint = 'fact', certainty = 'stated', sources = null }) {
  const id = Number(core.store.run(`INSERT INTO assertions(predicate, text, kind_hint, certainty, imp, recorded_at, created_at, updated_at)
    VALUES ('p', ?, ?, ?, ?, ?, ?, ?)`, text, kindHint, certainty, imp, at, at, at).lastInsertRowid);
  core.store.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')", id, subject);
  for (const s of sources ?? (src ? [{ percept: src }] : [])) {
    const p = s.percept ? core.store.get('SELECT at, setting_key FROM percepts WHERE id = ?', s.percept) : null;
    core.store.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, speaker, mode, at) VALUES ('assertion', ?, ?, ?, ?, ?, ?)`,
      id, s.percept ?? null, p?.setting_key ?? null, subject, s.mode ?? 'told_to_her', p?.at ?? at);
  }
  return id;
}
const cfgOf = (core, over = {}) => {
  const c = core.config.get();
  return { ...c, context: { ...c.context, sinceHere: { ...c.context.sinceHere, ...over } } };
};

test('since：一对一按她在这里的任何一句；他在这里的话只算她最后一次开口之前的（眼前还没回的这一串不算）；没说过话就没有', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const owner = w.ids.owner;
    const key = w.key(DM);
    const p = { key, people: [owner], oneOnOne: true, pool: 300 };
    assert.equal(sinceOf(core, { ...p, at: core.now() }).since, null, '还没在这里说过话');
    // 他先说了两句（她还没回）：都算「眼前还没回的这一串」，还是没有「上次」
    percept(core, w, { sid: DM, actor: owner, addressed: 'to-her', text: '在吗' });
    clock.advance(M);
    percept(core, w, { sid: DM, actor: owner, addressed: 'to-her', text: '有空吗' });
    assert.equal(sinceOf(core, { ...p, at: core.now() }).since, null);
    clock.advance(M);
    const herAt = core.now();
    percept(core, w, { sid: DM, self: true, text: '在的' });
    clock.advance(H);
    // 隔了一小时他又连说两句：since 照旧是她回的那一句
    percept(core, w, { sid: DM, actor: owner, addressed: 'to-her', text: '又来了' });
    percept(core, w, { sid: DM, actor: owner, addressed: 'to-her', text: '还在吗' });
    const r = sinceOf(core, { ...p, at: core.now() });
    assert.equal(r.since, herAt);
    assert.equal(r.herAt, herAt);
    assert.ok(r.hisAt < herAt, '他在她回话之前的那句算 hisAt');
  });
});

test('since：群里只算她接着回他的那一句（她回别人的不算）；他在她最后一次开口之前说的算 hisAt，取两者较晚的', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner, ming } = w.ids;
    const key = w.key(GROUP);
    const p = { key, people: [owner], oneOnOne: false, pool: 300 };
    percept(core, w, { actor: owner, addressed: 'to-her', text: '下午去不去' });
    clock.advance(M);
    const replyAt = core.now();
    percept(core, w, { self: true, text: '去呀' });
    clock.advance(10 * M);
    const hisAt = core.now();
    percept(core, w, { actor: owner, text: '那我先出门了' });
    clock.advance(M);
    percept(core, w, { actor: ming, addressed: 'to-her', text: '你们去哪' });
    clock.advance(M);
    percept(core, w, { self: true, text: '附近公园' });   // 回的是阿明：不算她和主人说完话
    clock.advance(H);
    const r = sinceOf(core, { ...p, at: core.now() });
    assert.equal(r.herAt, replyAt);
    assert.equal(r.hisAt, hisAt);
    assert.equal(r.since, hisAt);
    // 阿明：她回过他
    assert.ok(sinceOf(core, { ...p, people: [ming], at: core.now() }).herAt > hisAt);
  });
});

test('候选：since 之后知道的、来源不全在这里的、关于他的现行事实；之前就知道的、全在这里说的、被取代 / 过时 / 经验 / 她的猜测都不要', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner, ming } = w.ids;
    const key = w.key(DM);
    const early = percept(core, w, { sid: OTHER, actor: owner, text: '我在学吉他' });
    const old = fact(core, { subject: owner, text: '主人在学吉他', src: early });
    clock.advance(10 * M);
    const since = core.now();
    clock.advance(10 * M);
    const p1 = percept(core, w, { sid: OTHER, actor: owner, text: '我买到票了' });
    const got = fact(core, { subject: owner, text: '主人买到票了', imp: 6, src: p1 });
    const here = percept(core, w, { sid: DM, actor: owner, text: '我换了新手机' });
    const inHere = fact(core, { subject: owner, text: '主人换了新手机', src: here });
    const mixed = fact(core, { subject: owner, text: '主人周末加班', sources: [{ percept: here }, { percept: p1 }] });
    const sup = fact(core, { subject: owner, text: '旧说法', src: p1 });
    core.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', got, sup);
    const exp = fact(core, { subject: owner, text: '收回了的', src: p1 });
    core.store.run('UPDATE assertions SET expired_at = ? WHERE id = ?', core.now(), exp);
    fact(core, { subject: owner, text: '一条经验', src: p1, kindHint: 'lesson' });
    fact(core, { subject: owner, text: '她猜的', src: p1, certainty: 'inferred' });
    fact(core, { subject: ming, text: '阿明的事', src: p1 });
    const refs = candidatesFor(core, { key, people: [owner], since }).map((g) => g.lead);
    assert.ok(refs.includes(refOf('assertion', got)) && refs.includes(refOf('assertion', mixed)), JSON.stringify(refs));
    for (const id of [old, inHere, sup, exp]) assert.ok(!refs.includes(refOf('assertion', id)), `a${id} 不该在 ${refs}`);
    assert.equal(refs.length, 2);
    // 本周期给过的不挑
    assert.deepEqual(candidatesFor(core, { key, people: [owner], since, sent: new Set([refOf('assertion', got)]) }).map((g) => g.lead), [refOf('assertion', mixed)]);
  });
});

test('排序：有了结果的计划最前（和它的结果成一组），然后重要度、知道的时间从新到旧；证据在这里的计划不算', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner } = w.ids;
    const key = w.key(DM);
    // 两条计划都是 since 之前记下的（计划本身什么时候记下的都算，看的是结果）
    const pl = plan(core, { text: '今晚抢演出票', agent: owner, start: core.now() + H });
    const plHere = plan(core, { text: '明天交报告', agent: owner, start: core.now() + H });
    clock.advance(M);
    const since = core.now();
    clock.advance(M);
    clock.advance(M);
    const a = percept(core, w, { sid: OTHER, actor: owner, text: '一件小事' });
    const low = fact(core, { subject: owner, text: '小事', imp: 3, src: a });
    clock.advance(M);
    const b = percept(core, w, { sid: OTHER, actor: owner, text: '一件大事' });
    const high = fact(core, { subject: owner, text: '大事', imp: 8, src: b });
    clock.advance(M);
    const c = percept(core, w, { sid: OTHER, actor: owner, text: '又一件小事' });
    const low2 = fact(core, { subject: owner, text: '又一件小事', imp: 3, src: c });
    const d = percept(core, w, { sid: OTHER, actor: owner, text: '抢到了' });
    const out = fact(core, { subject: owner, text: '主人抢到票了', imp: 6, src: d });
    core.mods.encode.transitionPlan(core, pl, 'done', { at: core.now(), evidencePerceptId: d, outcomeRef: refOf('assertion', out) });
    const e = percept(core, w, { sid: DM, actor: owner, text: '报告交了' });
    core.mods.encode.transitionPlan(core, plHere, 'done', { at: core.now(), evidencePerceptId: e });
    const gs = candidatesFor(core, { key, people: [owner], since });
    assert.deepEqual(gs.map((g) => g.lead), [pl, high, low2, low].map((id) => refOf('assertion', id)), JSON.stringify(gs));
    assert.equal(gs[0].outcome, refOf('assertion', out), '结果跟着计划，不单独占一个名额');
    assert.equal(gs[0].resolved, true);
    // since 推到结果之后：计划不算这之后有了结果
    clock.advance(M);
    assert.deepEqual(candidatesFor(core, { key, people: [owner], since: core.now() }), []);
  });
});

test('名额：多于 maxItems 时按排好的先后留；几个人时第一个人优先、后面的人至少各留 1 件；没有「上次」的人没有这一层', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner, ming, hong } = w.ids;
    // 群里她回过主人、回过阿明；小红在这里没和她说过话
    percept(core, w, { actor: owner, addressed: 'to-her', text: '在吗' });
    percept(core, w, { self: true, text: '在' });
    percept(core, w, { actor: ming, addressed: 'to-her', text: '我也在' });
    percept(core, w, { self: true, text: '好' });
    clock.advance(H);
    for (let i = 0; i < 6; i++) {
      const p = percept(core, w, { sid: OTHER, actor: owner, text: `主人的事${i}` });
      fact(core, { subject: owner, text: `主人的事${i}`, imp: 2 + i, src: p });
    }
    for (let i = 0; i < 2; i++) {
      const p = percept(core, w, { sid: OTHER, actor: ming, text: `阿明的事${i}` });
      fact(core, { subject: ming, text: `阿明的事${i}`, imp: 2, src: p });
    }
    const p = percept(core, w, { sid: OTHER, actor: hong, text: '小红的事' });
    fact(core, { subject: hong, text: '小红的事', imp: 9, src: p });
    const run = (persons, over) => sinceHereFor(core, { key: w.key(GROUP), persons, oneOnOne: false, at: core.now(), cfg: cfgOf(core, over), selfId: w.ids.self, sent: new Set() });
    let r = run([owner]);
    assert.equal(r.groups.length, 4);
    const texts = (gs) => gs.map((g) => core.store.get('SELECT text FROM assertions WHERE id = ?', Number(g.lead.slice(1))).text);
    assert.deepEqual(texts(r.groups), ['主人的事5', '主人的事4', '主人的事3', '主人的事2'], '重要度高的留下');
    r = run([owner, ming, hong]);
    assert.deepEqual(r.groups.map((g) => g.person), [owner, owner, owner, ming], '后面的人至少留 1 件；小红没有「上次」');
    assert.equal(r.empty, 1);
    r = run([owner], { maxItems: 2 });
    assert.equal(r.groups.length, 2);
    assert.deepEqual(run([owner], { enabled: false }).groups, []);
  });
});

test('排序是平滑的打分：四天前做完的计划排在今天的事后面；半小时内重要度 6 的事排在 15 分钟前重要度 5 的事前面', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner } = w.ids;
    const key = w.key(DM);
    const since = core.now();
    clock.advance(M);
    const old = plan(core, { text: '去看牙', agent: owner, start: core.now() });
    const ev = percept(core, w, { sid: OTHER, actor: owner, text: '牙看完了' });
    core.mods.encode.transitionPlan(core, old, 'done', { at: core.now(), evidencePerceptId: ev });
    clock.advance(4 * 24 * H);
    const a = percept(core, w, { sid: OTHER, actor: owner, text: '今天发工资' });
    const today = fact(core, { subject: owner, text: '主人今天发工资', imp: 5, src: a });
    clock.advance(15 * M);
    const b = percept(core, w, { sid: OTHER, actor: owner, text: '晚上看电影' });
    const five = fact(core, { subject: owner, text: '主人晚上看电影', imp: 5, src: b });
    clock.advance(15 * M);
    const c = percept(core, w, { sid: OTHER, actor: owner, text: '明天去面试' });
    const six = fact(core, { subject: owner, text: '主人明天去面试', imp: 6, src: c });
    clock.advance(15 * M);
    const gs = candidatesFor(core, { key, people: [owner], since, at: core.now() });
    const ids = gs.map((g) => g.lead);
    assert.deepEqual(ids, [six, five, today, old].map((id) => refOf('assertion', id)), JSON.stringify(gs));
    // 同样的四天前的计划，要是刚做完：有了结果的稍占先，排最前
    assert.ok(gs.find((g) => g.lead === refOf('assertion', old)).score < gs.find((g) => g.lead === refOf('assertion', today)).score);
  });
});

test('计划的结果只认一条事实：plan_outcome_ref 指向一段经历时不带结果，只给计划', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner } = w.ids;
    const since = core.now();
    clock.advance(M);
    const pl = plan(core, { text: '订酒店', agent: owner, start: core.now() });
    const ep = Number(core.store.run(`INSERT INTO episodes(setting_key, ep_kind, title, narrative, t_start, t_end, sealed_at, created_at)
      VALUES (?, 'event', '一段经历', '一段和这件事无关的开头', ?, ?, ?, ?)`, w.key(OTHER), core.now(), core.now(), core.now(), core.now()).lastInsertRowid);
    const ev = percept(core, w, { sid: OTHER, actor: owner, text: '订好了' });
    core.mods.encode.transitionPlan(core, pl, 'done', { at: core.now(), evidencePerceptId: ev, outcomeRef: refOf('episode', ep) });
    const gs = candidatesFor(core, { key: w.key(DM), people: [owner], since, at: core.now() });
    assert.equal(gs[0].lead, refOf('assertion', pl));
    assert.equal(gs[0].outcome, null);
  });
});

test('有了结果的计划：本周期给过、状态是在那之后才变的，再给一次（regive）；状态没再变就不给；普通事实照旧按引用去重', async () => {
  await withWorld(async ({ core, w, clock }) => {
    const { owner } = w.ids;
    const key = w.key(DM);
    const since = core.now();
    clock.advance(M);
    const pl = plan(core, { text: '抢演出票', agent: owner, start: core.now() + H });
    const p0 = percept(core, w, { sid: OTHER, actor: owner, text: '买了新键盘' });
    const kb = fact(core, { subject: owner, text: '主人买了新键盘', src: p0 });
    const givenTime = core.now();   // 这时给过她：计划还是「打算」
    clock.advance(30 * M);
    const ev = percept(core, w, { sid: OTHER, actor: owner, text: '抢到了' });
    core.mods.encode.transitionPlan(core, pl, 'done', { at: core.now(), evidencePerceptId: ev });
    const sent = new Set([refOf('assertion', pl), refOf('assertion', kb)]);
    let gs = candidatesFor(core, { key, people: [owner], since, at: core.now(), sent, givenAt: () => givenTime });
    assert.deepEqual(gs.map((g) => [g.lead, !!g.regive]), [[refOf('assertion', pl), true]], '计划再给一次；键盘照旧不给');
    // 新状态给过了（给的时间晚于状态变化）：不再给
    gs = candidatesFor(core, { key, people: [owner], since, at: core.now(), sent, givenAt: () => core.now() + 1 });
    assert.deepEqual(gs, []);
    // 查不到上次给的时间：按给过算（不重复）
    assert.deepEqual(candidatesFor(core, { key, people: [owner], since, at: core.now(), sent }), []);
  });
});
