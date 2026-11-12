// 【D163】记忆星图的数据（admin.starmap）：快照的形状和每一列的规则、隐藏 / 忘掉 / 彻底删除的不出现、人和场合、痕迹 / 想起 / 说起 /
// 心境 / 听到多少话 / 夜间整理、maxStars、实时增量、看一眼、空库、参数。名字、场合都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../../src/contract/errors.js';
import { adminCore, seedSetting, seedEntity, seedPercept, seedAssertion, seedEpisode, descriptors } from './fixtures.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const COLS = ['ref', 'k', 'sub', 't', 't2', 'place', 'who', 'st', 'sup', 'imp', 'cert', 'val', 'b'];

const withCore = (name, fn) => async () => {
  const t = await adminCore(name);
  try { await fn(t.core, t); } finally { await t.cleanup(); }
};
const S = (core, q) => core.mods.admin.starmap(core, q);
/** 快照里一颗星的列 → 对象。 */
const starOf = (snap, ref) => {
  const r = snap.stars.rows.find((x) => x[0] === ref);
  return r ? Object.fromEntries(COLS.map((c, i) => [c, r[i]])) : null;
};
const idx = (snap, ref) => snap.stars.rows.findIndex((x) => x[0] === ref);
const run = (core, sql, ...p) => core.store.run(sql, ...p);

function addSource(core, kind, id, { at, settingKey = null, speaker = null }) {
  run(core, "INSERT INTO sources(owner_kind, owner_id, perceived_in, speaker, mode, confidence, at) VALUES (?, ?, ?, ?, 'told_to_her', 0.8, ?)", kind, id, settingKey, speaker, at);
}
function seedIntention(core, { target = null, state = 'formed', at, sources = [], text = '下次问问她编的那本书看完没' }) {
  return Number(run(core, `INSERT INTO intentions(target_entity_id, act, text, origin, state, formed_at, sources_json, created_at, updated_at)
    VALUES (?, '追问', ?, 'self-care', ?, ?, ?, ?, ?)`, target, text, state, at, JSON.stringify(sources), core.now(), core.now()).lastInsertRowid);
}
function inject(core, { at, settingKey = null, layer = 'recalled', items }) {
  return Number(run(core, 'INSERT INTO injections(ts, session_id, cycle, setting_key, layer, nonce, items_json, chars) VALUES (?, ?, 1, ?, ?, ?, ?, 10)',
    at, 'sess-x', settingKey, layer, `n-${Math.random()}`, JSON.stringify(items)).lastInsertRowid);
}
function tell(core, { kind = 'assertion', id, at, settingKey, level = 'full', pid = 1 }) {
  return Number(run(core, 'INSERT INTO told_log(owner_kind, owner_id, at, setting_key, utterance_percept_id, level) VALUES (?, ?, ?, ?, ?, ?)', kind, id, at, settingKey, pid, level).lastInsertRowid);
}
function trace(core, { kind = 'assertion', id, t, w = 1, d = 0.5, reason = 'mention' }) {
  return Number(run(core, 'INSERT INTO traces(owner_kind, owner_id, t, w, d, reason) VALUES (?, ?, ?, ?, ?, ?)', kind, id, t, w, d, reason).lastInsertRowid);
}

/** 一个小世界：她、主人、三个人（其中一个有两个档案认成同一个人）、一个没有星的人；一个群、一个一对一。 */
function world(core) {
  const now = core.now();
  const sk1 = seedSetting(core, { label: '编的读书会' });
  const sk2 = seedSetting(core, { label: '编的私聊', descriptor: descriptors.oneOnOne });
  const me = seedEntity(core, { name: '编的小雪', isSelf: 1, closeness: 0 });
  const owner = seedEntity(core, { name: '编的主人', authority: 'principal', closeness: 0.9 });
  const ming = seedEntity(core, { name: '编的阿木', closeness: 0.3 });
  const ming2 = seedEntity(core, { name: '编的木哥', closeness: 0.2 });
  run(core, "INSERT INTO entity_links(a, b, rel, confidence, decided_by, at, created_at) VALUES (?, ?, 'same', 0.9, 'owner', ?, ?)", ming, ming2, now, now);
  run(core, "INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'zz', '', 'ihx', 'platform', ?)", ming, now);
  const hong = seedEntity(core, { name: '编的小禾', closeness: 0.5 });
  const lonely = seedEntity(core, { name: '编的路人', closeness: 0.8 });
  const p1 = seedPercept(core, { settingKey: sk2, actor: owner, text: '编的一句话', at: now - 10 * DAY });
  const p2 = seedPercept(core, { settingKey: sk1, actor: hong, text: '编的又一句', at: now - 9 * DAY });

  // a1：阿木的「木哥」档案是主语；两条来源，最早的在私聊
  const a1 = seedAssertion(core, { text: '编的阿木喜欢下棋', subjects: [ming2], settingKey: sk1, at: now - 5 * DAY });
  addSource(core, 'assertion', a1, { at: now - 8 * DAY, settingKey: sk2 });
  run(core, "UPDATE assertions SET imp = 7, certainty = 'confirmed', expired_at = ? WHERE id = ?", now - DAY, a1);
  // a2：她自己的计划（主语是她，宾语小禾），做完了
  const a2 = seedAssertion(core, { text: '编的周末和小禾去爬山', subjects: [me], settingKey: sk1, at: now - 7 * DAY });
  run(core, "INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'object')", a2, hong);
  run(core, "UPDATE assertions SET kind_hint = 'plan', plan_status = 'done' WHERE id = ?", a2);
  // a3：经验，没有主语，说话人是主人；她自己说的
  const a3 = seedAssertion(core, { text: '编的查天气要先问城市', speaker: owner, settingKey: sk2, at: now - 6 * DAY });
  run(core, "UPDATE assertions SET kind_hint = 'lesson', certainty = 'self_said', imp = 8 WHERE id = ?", a3);
  // a4 取代 a1
  const a4 = seedAssertion(core, { text: '编的阿木改喜欢围棋了', subjects: [ming], settingKey: sk1, at: now - 2 * DAY, supersedes: a1 });
  // a5：过时；没有任何来源（时间用 recorded_at，场合 -1）；提到的人对不上（mention 不算）
  const a5 = seedAssertion(core, { text: '编的天气很冷', mentions: [hong], at: now - 4 * DAY });
  run(core, "DELETE FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", a5);
  run(core, "UPDATE assertions SET expired_at = ?, kind_hint = 'state', certainty = 'hearsay' WHERE id = ?", now - DAY, a5);
  // 经历：她、阿木、小禾一起（她不当家）；只有她的日记；小结不当星
  const e1 = seedEpisode(core, { settingKey: sk1, participants: [me, ming2, hong], at: now - 3 * DAY });
  run(core, 'UPDATE episodes SET t_end = ?, emotion_json = ? WHERE id = ?', now - 3 * DAY + HOUR, JSON.stringify({ valence: -0.5, intensity: 0.7, text: 'x' }), e1);
  const e2 = seedEpisode(core, { settingKey: sk1, participants: [me], at: now - 2 * DAY, kind: 'diary' });
  const e3 = seedEpisode(core, { settingKey: sk1, participants: [ming], at: now - 2 * DAY, kind: 'summary' });
  // 意图：对小禾的（场合 = 第一条原话的场合）；没有对象、已经做完的
  const t1 = seedIntention(core, { target: hong, at: now - DAY, sources: [p1, p2] });
  const t2 = seedIntention(core, { state: 'executed', at: now - 12 * HOUR });
  run(core, "UPDATE activation SET b_cache = -1.25, tier = 'warm' WHERE owner_kind = 'assertion' AND owner_id = ?", a1);
  return { now, sk1, sk2, me, owner, ming, ming2, hong, lonely, p1, p2, a1, a2, a3, a4, a5, e1, e2, e3, t1, t2 };
}

test('快照：形状、每一列的规则（k / sub / t / place / who / st / sup / imp / cert / val / b）', withCore('sm-cols', (core) => {
  const w = world(core);
  const s = S(core, {});
  assert.deepEqual(Object.keys(s).sort(), ['counts', 'cursor', 'dropped', 'heard', 'mood', 'nights', 'now', 'params', 'people', 'places', 'recalls', 'rev', 'stars', 't0', 'tells', 'traces'].sort());
  assert.equal(s.now, core.now());
  assert.deepEqual(s.params, { ageFloorMs: 3 * 60_000, timeUnitMs: HOUR });
  assert.deepEqual(s.stars.cols, COLS);
  assert.equal(typeof s.rev, 'string');
  assert.equal(s.dropped, 0);
  const refs = s.stars.rows.map((r) => r[0]).sort();
  assert.deepEqual(refs, [`a${w.a1}`, `a${w.a2}`, `a${w.a3}`, `a${w.a4}`, `a${w.a5}`, `e${w.e1}`, `e${w.e2}`, `t${w.t1}`, `t${w.t2}`].sort(), '小结不当星');
  for (let i = 1; i < s.stars.rows.length; i++) assert.ok(s.stars.rows[i][3] >= s.stars.rows[i - 1][3], '星按 t 升序');
  for (const r of s.stars.rows) assert.equal(r.length, COLS.length);
  assert.ok(!JSON.stringify(s).includes('编的阿木喜欢下棋'), '快照里没有正文');

  const P = (id) => s.people.findIndex((p) => p.id === id);
  const pl = (k) => s.places.findIndex((p) => p.key === k);
  const a1 = starOf(s, `a${w.a1}`);
  assert.deepEqual([a1.k, a1.sub, a1.t, a1.t2, a1.place], [1, 'fact', w.now - 8 * DAY, null, pl(w.sk2)], 't / place 取最早的来源');
  assert.deepEqual(a1.who, [P(w.ming)], '木哥并进阿木（代表档案）');
  assert.deepEqual([a1.st, a1.sup, a1.imp, a1.cert, a1.val, a1.b], [1, idx(s, `a${w.a4}`), 0.7, 'c', null, -1.25], '被取代优先于过时');
  const a2 = starOf(s, `a${w.a2}`);
  assert.deepEqual([a2.k, a2.sub, a2.st, a2.who], [2, 'plan', 2, [P(w.me), P(w.hong)]], '她是主语就以她为家；计划做完了是过时');
  const a3 = starOf(s, `a${w.a3}`);
  assert.deepEqual([a3.k, a3.who, a3.cert, a3.imp, a3.place], [3, [P(w.owner)], 'm', 0.8, pl(w.sk2)], '没有主语用说话人');
  const a4 = starOf(s, `a${w.a4}`);
  assert.deepEqual([a4.st, a4.sup, a4.b], [0, -1, null]);
  const a5 = starOf(s, `a${w.a5}`);
  const rec5 = core.store.get('SELECT recorded_at AS r FROM assertions WHERE id = ?', w.a5).r;
  assert.deepEqual([a5.k, a5.t, a5.place, a5.who, a5.st, a5.cert], [1, rec5, -1, [], 2, 'h'], '没有来源：recorded_at、场合 -1；只被提到不算 who');
  const e1 = starOf(s, `e${w.e1}`);
  assert.deepEqual([e1.k, e1.sub, e1.t, e1.t2, e1.place, e1.who, e1.st, e1.sup, e1.imp, e1.cert, e1.val],
    [0, 'event', w.now - 3 * DAY, w.now - 3 * DAY + HOUR, pl(w.sk1), [P(w.ming), P(w.hong)], 0, -1, 0.7, null, -0.5], '她参与的经历不以她为家');
  const e2 = starOf(s, `e${w.e2}`);
  assert.deepEqual([e2.sub, e2.who, e2.imp, e2.val], ['diary', [P(w.me)], null, null], '只有她自己时是她');
  const t1 = starOf(s, `t${w.t1}`);
  assert.deepEqual([t1.k, t1.sub, t1.t, t1.place, t1.who, t1.st, t1.imp, t1.cert], [2, 'intention', w.now - DAY, pl(w.sk2), [P(w.hong)], 0, null, null]);
  const t2 = starOf(s, `t${w.t2}`);
  assert.deepEqual([t2.who, t2.st, t2.place], [[P(w.me)], 2, -1], '没有对象的意图是她自己的');

  // 人：她第一，其后主人（principal）、亲近的在前；没有星的人不列；两个档案并成一个人
  assert.deepEqual(s.people.map((p) => p.id), [w.me, w.owner, w.hong, w.ming]);
  assert.deepEqual(s.people[0], { id: w.me, name: '编的小雪', self: true, principal: false, closeness: 0, n: 3 });
  assert.deepEqual(s.people[1], { id: w.owner, name: '编的主人', self: false, principal: true, closeness: 0.9, n: 1 });
  assert.equal(s.people.find((p) => p.id === w.ming).n, 3, 'a1、a4、e1 以阿木为家');
  assert.equal(s.people.find((p) => p.id === w.hong).n, 1);
  // 场合
  const p2 = s.places[pl(w.sk2)];
  assert.deepEqual(p2, { key: w.sk2, label: '编的私聊', ownerLabel: null, labelKind: 'name', adapter: 'zz', hint: null, oneOnOne: true, n: 3 });
  assert.equal(s.places[pl(w.sk1)].oneOnOne, false);
  assert.equal(s.places[pl(w.sk1)].n, 4);
  assert.deepEqual(s.counts, { percepts: 2, episode: 2, fact: 3, plan: 3, lesson: 1 });
  assert.equal(s.t0, w.now - 10 * DAY, '最早的一句原话');
}));

test('隐藏、忘掉、彻底删除的不出现，它们的痕迹、想起、说起也不出现；rev 跟着变', withCore('sm-hidden', (core) => {
  const w = world(core);
  const rev0 = S(core, {}).rev;
  core.mods.admin.suppress(core, `a${w.a3}`, { state: 'hidden', by: 'owner', at: core.now() });
  core.mods.admin.suppress(core, `e${w.e2}`, { state: 'forgotten', by: 'owner', at: core.now() });
  // 彻底删除：行删掉、写墓碑；另一条墓碑落在还没删掉的行上（中途停下的删除）
  run(core, 'DELETE FROM intentions WHERE id = ?', w.t2);
  run(core, "INSERT INTO tombstones(kind, ref, at) VALUES ('intention', ?, ?)", `t${w.t2}`, core.now());
  run(core, "INSERT INTO tombstones(kind, ref, at) VALUES ('assertion', ?, ?)", `a${w.a5}`, core.now() + 1);
  for (const [k, id] of [['assertion', w.a3], ['episode', w.e2], ['assertion', w.a5]]) {
    trace(core, { kind: k, id, t: core.now() - HOUR });
    tell(core, { kind: k, id, at: core.now() - HOUR, settingKey: w.sk1 });
  }
  inject(core, { at: core.now() - HOUR, settingKey: w.sk1, items: [{ id: `a${w.a3}` }, { id: `e${w.e2}` }, { id: `t${w.t2}` }, { id: `a${w.a5}` }] });
  const s = S(core, {});
  assert.notEqual(s.rev, rev0);
  const refs = s.stars.rows.map((r) => r[0]);
  for (const gone of [`a${w.a3}`, `e${w.e2}`, `t${w.t2}`, `a${w.a5}`]) assert.ok(!refs.includes(gone), `${gone} 不该出现`);
  assert.equal(s.traces.length, s.stars.rows.filter((r) => r[0][0] !== 't').length, '只剩每颗看得见的星自己的一条 encode 痕迹（意图没有痕迹）');
  assert.deepEqual(s.tells, []);
  assert.deepEqual(s.recalls, [], '一行里一颗星都没有（隐藏 / 删掉的不算进 rawN）就不要');
  assert.ok(!s.people.some((p) => p.id === w.owner), '主人只在被隐藏的那颗星上');
  const live = S(core, { since: { inj: 0, trace: 0, told: 0 } });
  assert.ok(!live.traces.some((t) => [`a${w.a3}`, `e${w.e2}`, `a${w.a5}`].includes(t[0])));
  assert.deepEqual(live.tells, []);
  assert.deepEqual(live.recalls, []);
  assert.deepEqual(S(core, { peek: [`a${w.a3}`, `e${w.e2}`, `a${w.a5}`, `t${w.t2}`] }).items, []);
}));

test('rev：加一颗星、隐藏一颗星、恢复都会变；不变时一样', withCore('sm-rev', (core) => {
  const w = world(core);
  const r0 = S(core, {}).rev;
  assert.equal(S(core, {}).rev, r0);
  const a = seedAssertion(core, { text: '编的新事', at: core.now() });
  const r1 = S(core, {}).rev;
  assert.notEqual(r1, r0);
  core.mods.admin.suppress(core, `a${a}`, { state: 'hidden', by: 'owner', at: core.now() });
  const r2 = S(core, {}).rev;
  assert.notEqual(r2, r1);
  core.mods.admin.restore(core, `a${a}`, { by: 'owner', at: core.now() });
  assert.notEqual(S(core, {}).rev, r2);
  assert.equal(S(core, { since: { inj: 0, trace: 0, told: 0 } }).rev, S(core, {}).rev, '增量和快照的 rev 一样');
  assert.ok(w);
}));

test('痕迹：原因代号、聚合箱变成伪痕迹、按 t 升序', withCore('sm-traces', (core) => {
  const w = world(core);
  const now = w.now;
  run(core, 'DELETE FROM traces');
  const reasons = ['encode', 'mention', 'reread', 'confirm', 'asked', 'reply', 'retell', 'replay', 'inherit', 'odd-new-reason'];
  reasons.forEach((r, i) => trace(core, { id: w.a4, t: now - (20 - i) * HOUR, w: 1 + i / 10, d: 0.4, reason: r }));
  trace(core, { kind: 'entity', id: w.ming, t: now - HOUR });   // 不是星的痕迹不要
  run(core, "UPDATE activation SET agg_n = 3, agg_w = 2.5, agg_bins_json = ? WHERE owner_kind = 'assertion' AND owner_id = ?",
    JSON.stringify([{ k: 6, n: 2, w: 1.5, first: now - 40 * DAY, last: now - 30 * DAY, d: 0.3 }, { k: 8, n: 1, w: 1, first: now - 50 * DAY, last: now - 50 * DAY, d: 0.4 }]), w.a4);
  run(core, "UPDATE activation SET agg_n = 2, agg_w = 2, agg_first = ?, agg_last = ?, agg_d = 0.35, agg_bins_json = '[]' WHERE owner_kind = 'episode' AND owner_id = ?",
    now - 60 * DAY, now - 58 * DAY, w.e1);
  const s = S(core, {});
  const i4 = idx(s, `a${w.a4}`);
  const mine = s.traces.filter((t) => t[0] === i4);
  assert.deepEqual(mine.map((t) => t[4]), [9, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1], '不认识的原因按 1');
  assert.deepEqual(mine[0], [i4, now - 50 * DAY, 1, 0.4, 9], '只有一条的箱 t = first');
  assert.deepEqual(mine[1], [i4, now - 35 * DAY, 1.5, 0.3, 9], '多条的箱 t = (first + last) / 2');
  assert.deepEqual(mine[3], [i4, now - 19 * HOUR, 1.1, 0.4, 1]);
  assert.deepEqual(s.traces.filter((t) => t[0] === idx(s, `e${w.e1}`)), [[idx(s, `e${w.e1}`), now - 59 * DAY, 2, 0.35, 9]], '没有分箱的老聚合项整个一条');
  for (let i = 1; i < s.traces.length; i++) assert.ok(s.traces[i][1] >= s.traces[i - 1][1]);
  assert.equal(s.traces.length, 12 + 1);
  assert.deepEqual(s.nights, [now - 13 * HOUR], 'replay 痕迹的时刻');
}));

test('想起：不含常驻区、去掉 omit、layerCode 三类、rawN、最近 recallDays 天；说起、心境、听到多少话、夜间整理', withCore('sm-recalls', (core) => {
  const w = world(core);
  const now = w.now;
  inject(core, { at: now - 70 * DAY, settingKey: w.sk1, items: [{ id: `a${w.a1}` }] });                     // 太早
  inject(core, { at: now - 5 * HOUR, settingKey: w.sk1, layer: 'resident', items: [{ id: `a${w.a1}` }] });   // 常驻区
  inject(core, { at: now - 4 * HOUR, settingKey: w.sk1, layer: 'block', items: [
    { id: `a${w.a1}`, layer: 'working' }, { id: `a${w.a2}`, layer: 'pointBack' }, { id: `e${w.e1}`, layer: 'recalled' }, { id: `t${w.t1}`, layer: 'intentions' },
    { id: `a${w.a3}`, layer: 'recollect' }, { id: `a${w.a4}`, layer: 'memory_look' }, { id: `a${w.a5}`, layer: 'outline' },
    { id: `a${w.a1}`, layer: 'recalled', verdict: 'omit' }, { id: `p${w.p1}`, layer: 'recalled' }, { id: 'w3', layer: 'recalled' }, { id: `e${w.e3}`, layer: 'todaySoFar' },
  ] });
  inject(core, { at: now - 3 * HOUR, settingKey: w.sk2, layer: 'memory_recall', items: [{ id: `a${w.a2}` }] });
  inject(core, { at: now - 2 * HOUR, settingKey: w.sk2, items: [{ id: `p${w.p2}` }] });                     // 只有原话
  inject(core, { at: now - HOUR, settingKey: w.sk2, items: [{ id: `a${w.a2}`, verdict: 'omit' }] });         // 什么都不剩
  const s = S(core, {});
  const I = (r) => idx(s, r);
  const pl = (k) => s.places.findIndex((p) => p.key === k);
  assert.deepEqual(s.recalls, [
    [now - 4 * HOUR, pl(w.sk1), [[I(`a${w.a1}`), 0], [I(`a${w.a2}`), 0], [I(`e${w.e1}`), 1], [I(`t${w.t1}`), 1], [I(`a${w.a3}`), 2], [I(`a${w.a4}`), 2], [I(`a${w.a5}`), 2]], 3],
    [now - 3 * HOUR, pl(w.sk2), [[I(`a${w.a2}`), 2]], 0],
    [now - 2 * HOUR, pl(w.sk2), [], 1],
  ]);
  assert.equal(S(core, { recallDays: 1 }).recalls.length, 3);
  assert.equal(S(core, { recallDays: 365 }).recalls.length, 4);

  // 说起（最近 60 天）
  tell(core, { id: w.a4, at: now - 61 * DAY, settingKey: w.sk1 });
  tell(core, { id: w.a4, at: now - 2 * HOUR, settingKey: w.sk2, level: 'vague' });
  tell(core, { kind: 'episode', id: w.e1, at: now - HOUR, settingKey: w.sk1 });
  tell(core, { kind: 'percept', id: w.p1, at: now - HOUR, settingKey: w.sk1 });
  // 心境
  run(core, 'INSERT INTO mood(at, valence, intensity) VALUES (?, 0.5, 0.2), (?, -0.3, 0.6)', now - 2 * DAY, now - DAY);
  // 听到多少话：同一个整点三条（一条对她说的、一条提到她），她自己说的不算，太早的不算
  const h = Math.floor((now - 30 * DAY) / HOUR) * HOUR;
  const ps = [0, 1, 2].map((i) => seedPercept(core, { settingKey: w.sk1, actor: w.hong, at: h + i * 60_000 }));
  run(core, "UPDATE percepts SET addressed = 'to-her' WHERE id = ?", ps[0]);
  run(core, "UPDATE percepts SET addressed = 'mentions-her' WHERE id = ?", ps[1]);
  const mine = seedPercept(core, { settingKey: w.sk1, at: h + 5 * 60_000 });
  run(core, "UPDATE percepts SET actor_self = 1, kind = 'self-utterance', addressed = 'by-her' WHERE id = ?", mine);
  seedPercept(core, { settingKey: w.sk1, actor: w.hong, at: now - 100 * DAY });
  // 夜间整理：两晚的 replay（同一晚多条取最早的）+ 最近一次的 meta
  trace(core, { id: w.a4, t: now - 3 * DAY, reason: 'replay' });
  trace(core, { kind: 'episode', id: w.e1, t: now - 3 * DAY + 1000, reason: 'replay' });
  trace(core, { id: w.a2, t: now - 2 * DAY, reason: 'replay' });
  run(core, "INSERT INTO meta(key, value) VALUES ('sleep.lastAt', ?)", String(now - 6 * HOUR));
  const s2 = S(core, {});
  const J = (r) => idx(s2, r);
  const pl2 = (k) => s2.places.findIndex((p) => p.key === k);
  assert.deepEqual(s2.tells, [[now - 2 * HOUR, pl2(w.sk2), J(`a${w.a4}`), 0], [now - HOUR, pl2(w.sk1), J(`e${w.e1}`), 1]]);
  assert.deepEqual(s2.mood, [[now - 2 * DAY, 0.5, 0.2], [now - DAY, -0.3, 0.6]]);
  const heard = s2.heard.filter((x) => x[1] === h);
  assert.deepEqual(heard, [[pl2(w.sk1), h, 3, 2]]);
  assert.ok(s2.heard.every((x) => x[1] >= now - 90 * DAY - HOUR));
  assert.equal(s2.t0, now - 100 * DAY);
  const tz = core.config.get().time?.tzOffsetMin;
  assert.equal(tz ?? null, null);
  assert.deepEqual(s2.nights, [now - 3 * DAY, now - 2 * DAY, now - 6 * HOUR].filter((x, i, a) => {
    const d = (t) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / DAY);
    return a.findIndex((y) => d(y) === d(x)) === i;
  }), '按本地日聚簇、取最早的');
}));

test('maxStars：超了先省最冷的（cold 里 b_cache 最低的），被省的星的痕迹 / 想起 / 说起不带、不留悬空下标', withCore('sm-max', (core) => {
  const w = world(core);
  run(core, "UPDATE activation SET tier = 'hot', b_cache = 1 WHERE owner_kind IN ('assertion','episode','intention')");
  for (const t of [w.t1, w.t2]) run(core, "INSERT INTO activation(owner_kind, owner_id, tier, b_cache) VALUES ('intention', ?, 'hot', 1)", t);
  run(core, "UPDATE activation SET tier = 'cold', b_cache = -5 WHERE owner_kind = 'assertion' AND owner_id = ?", w.a4);   // 最冷：取代 a1 的那颗
  run(core, "UPDATE activation SET tier = 'cold', b_cache = -2 WHERE owner_kind = 'episode' AND owner_id = ?", w.e1);
  run(core, "UPDATE activation SET tier = 'warm', b_cache = -9 WHERE owner_kind = 'assertion' AND owner_id = ?", w.a3);   // warm 再冷也在 cold 之后
  inject(core, { at: w.now - HOUR, settingKey: w.sk1, items: [{ id: `a${w.a4}` }] });
  tell(core, { id: w.a4, at: w.now - HOUR, settingKey: w.sk1 });
  const s = S(core, { maxStars: 7 });
  assert.equal(s.dropped, 2);
  assert.equal(s.stars.rows.length, 7);
  const refs = s.stars.rows.map((r) => r[0]);
  assert.ok(!refs.includes(`a${w.a4}`) && !refs.includes(`e${w.e1}`) && refs.includes(`a${w.a3}`));
  assert.equal(starOf(s, `a${w.a1}`).sup, -1, '取代它的那颗被省了：-1');
  for (const t of s.traces) assert.ok(t[0] >= 0 && t[0] < 7);
  for (const r of s.stars.rows) { assert.ok(r[8] < 7); for (const p of r[6]) assert.ok(p >= 0 && p < s.people.length); assert.ok(r[5] < s.places.length); }
  assert.deepEqual(s.recalls, [], '只想起了被省的那颗：这一行不要');
  assert.deepEqual(s.tells, []);
  s.people.forEach((p, i) => assert.equal(p.n, s.stars.rows.filter((r) => r[6][0] === i).length, '人的 n 是留下的星里以他为家的'));
  assert.throws(() => S(core, { maxStars: 50_001 }), ContractError);
  assert.throws(() => S(core, { maxStars: 0 }), ContractError);
  assert.throws(() => S(core, { maxStars: 1.5 }), ContractError);
  assert.equal(S(core, { maxStars: 50_000 }).dropped, 0);
}));

test('实时增量：只给 since 之后的、用引用和场合键；每样最多 500 行，cursor 只前进到给出的最后一行', withCore('sm-live', (core) => {
  const w = world(core);
  const snap = S(core, {});
  const c = snap.cursor;
  assert.deepEqual(S(core, { since: c }).traces, []);
  const tr = trace(core, { id: w.a4, t: w.now, w: 0.8, d: 0.45, reason: 'retell' });
  trace(core, { kind: 'entity', id: w.ming, t: w.now });
  inject(core, { at: w.now, settingKey: w.sk2, layer: 'recalled', items: [{ id: `a${w.a4}` }, { id: `e${w.e1}`, layer: 'working' }, { id: `p${w.p1}` }, { id: `e${w.e3}` }] });
  inject(core, { at: w.now, settingKey: w.sk2, layer: 'resident', items: [{ id: `a${w.a4}` }] });
  tell(core, { id: w.a4, at: w.now, settingKey: w.sk1, level: 'vague' });
  const l = S(core, { since: c });
  assert.deepEqual(Object.keys(l).sort(), ['cursor', 'now', 'recalls', 'rev', 'tells', 'traces']);
  assert.deepEqual(l.traces, [[`a${w.a4}`, w.now, 0.8, 0.45, 6]]);
  assert.deepEqual(l.recalls, [[w.now, w.sk2, [[`a${w.a4}`, 1], [`e${w.e1}`, 0]], 2]], '小结不是星，算进 rawN');
  assert.deepEqual(l.tells, [[w.now, w.sk1, `a${w.a4}`, 0]]);
  assert.ok(l.cursor.trace > tr, '没给满时跳到表里最大的 id（不是星的那条也越过）');
  assert.deepEqual(S(core, { since: l.cursor }), { now: l.now, rev: l.rev, cursor: l.cursor, traces: [], recalls: [], tells: [] });

  // 每样最多 500 行：多了取最早的
  const ids = [];
  core.store.tx(() => { for (let i = 0; i < 520; i++) ids.push(trace(core, { id: w.a2, t: w.now + i })); });
  const p1 = S(core, { since: l.cursor });
  assert.equal(p1.traces.length, 500);
  assert.equal(p1.cursor.trace, ids[499]);
  assert.equal(p1.traces[0][1], w.now);
  const p2 = S(core, { since: p1.cursor });
  assert.equal(p2.traces.length, 20);
  assert.equal(p2.traces[0][1], w.now + 500);
  for (const bad of [{ since: { inj: 0, trace: 0 } }, { since: { inj: -1, trace: 0, told: 0 } }, { since: { inj: 0, trace: 0, told: 0 }, maxStars: 5 }, { since: [] },
    { since: { inj: 0, trace: 0, told: 0 }, peek: [] }]) assert.throws(() => S(core, bad), ContractError, JSON.stringify(bad));
}));

test('看一眼：三种星各给什么；隐藏的、不是星的不给；超过 24 个抛错', withCore('sm-peek', (core) => {
  const w = world(core);
  run(core, "UPDATE episodes SET title = '编的下棋', header = '' , narrative = ? WHERE id = ?", '长'.repeat(300), w.e1);
  run(core, "UPDATE episodes SET title = '', header = '编的日记头' WHERE id = ?", w.e2);
  core.mods.admin.suppress(core, `a${w.a3}`, { state: 'hidden', by: 'owner', at: core.now() });
  const r = S(core, { peek: [`a${w.a1}`, `e${w.e1}`, `e${w.e2}`, `t${w.t1}`, `a${w.a3}`, `e${w.e3}`, `p${w.p1}`, 'zz', `a${w.a1}`, 'a999999'] });
  assert.deepEqual(r.items, [
    { ref: `a${w.a1}`, title: null, text: '编的阿木喜欢下棋', at: w.now - 8 * DAY },
    { ref: `e${w.e1}`, title: '编的下棋', text: '长'.repeat(160), at: w.now - 3 * DAY },
    { ref: `e${w.e2}`, title: null, text: '编的日记头', at: w.now - 2 * DAY },
    { ref: `t${w.t1}`, title: null, text: '下次问问她编的那本书看完没', at: w.now - DAY },
  ]);
  assert.deepEqual(S(core, { peek: [] }), { items: [] });
  assert.equal(S(core, { peek: Array(24).fill(`a${w.a1}`) }).items.length, 1);
  assert.throws(() => S(core, { peek: Array(25).fill(`a${w.a1}`) }), ContractError);
  assert.throws(() => S(core, { peek: [1] }), ContractError);
  assert.throws(() => S(core, { peek: 'a1' }), ContractError);
  assert.throws(() => S(core, { peek: [], recallDays: 3 }), ContractError);
  assert.throws(() => S(core, 'x'), ContractError);
  assert.throws(() => S(core, { recallDays: 0 }), ContractError);
}));

test('空库（一颗星都没有）也返回完整的形状；她自己的档案在就列她', withCore('sm-empty', (core) => {
  const s = S(core, {});
  assert.deepEqual({ ...s, rev: 'x' }, {
    now: core.now(), rev: 'x', cursor: { inj: 0, trace: 0, told: 0 }, params: { ageFloorMs: 180_000, timeUnitMs: HOUR }, t0: core.now(),
    people: [], places: [], stars: { cols: COLS, rows: [] }, traces: [], recalls: [], tells: [], mood: [], heard: [], nights: [], dropped: 0,
    counts: { percepts: 0, episode: 0, fact: 0, plan: 0, lesson: 0 },
  });
  // 她自己的档案在就列她（哪怕没有星）
  const me = seedEntity(core, { name: '编的小雪', isSelf: 1 });
  assert.deepEqual(S(core, {}).people, [{ id: me, name: '编的小雪', self: true, principal: false, closeness: 0.3, n: 0 }]);
  assert.deepEqual(S(core, { since: { inj: 0, trace: 0, told: 0 } }).traces, []);
  assert.deepEqual(core.mods.admin.starmap(core).stars.rows, []);
}));
