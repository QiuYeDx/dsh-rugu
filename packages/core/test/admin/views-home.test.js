// 管理页首页的数据（D170）：今天的计数口径、要紧的待处理、最近记住的、各入口；只读库也能读；查询走索引。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY } from '../fakes/index.js';
import { adminCore, seedSetting, seedEntity, seedPercept, seedAssertion, seedEpisode } from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};
const HOUR = 3_600_000;

test('home：空库——全是 0，没有待处理、没有最近记住的', withCore('adm-home-empty', (core) => {
  const h = core.mods.admin.home(core, {});
  assert.deepEqual(h.today, { heard: { others: 0, hers: 0, total: 0 }, noted: { facts: 0, episodes: 0, total: 0 } });
  assert.deepEqual(h.pending, { total: 0, needToKnow: 0, review: 0, top: [] });
  assert.deepEqual(h.recent, []);
  assert.ok(h.dayStart <= h.now && h.dayStart > h.now - DAY);
  assert.equal(h.readOnly, false);
}));

test('home：今天的口径——按说话的时间算今天；别人的话和她的话分开；回填的历史、动作不算；事实不含经验，经历只算 event', withCore('adm-home-today', (core) => {
  const now = core.now();
  const dayStart = now - 2 * HOUR;
  const sk = seedSetting(core, { label: '读书会' });
  const A = seedEntity(core, { name: '阿明' });
  seedPercept(core, { settingKey: sk, actor: A, text: '昨天的话', at: dayStart - HOUR });
  const p1 = seedPercept(core, { settingKey: sk, actor: A, text: '今天的话' });
  seedPercept(core, { settingKey: sk, actor: A, text: '今天第二句', at: now - HOUR });
  const mine = seedPercept(core, { settingKey: sk, text: '她说的' });
  core.store.run("UPDATE percepts SET kind = 'self-utterance', actor_self = 1 WHERE id = ?", mine);
  const hist = seedPercept(core, { settingKey: sk, actor: A, text: '回填的' });
  core.store.run('UPDATE percepts SET historical = 1 WHERE id = ?', hist);
  const act = seedPercept(core, { settingKey: sk, actor: A, text: '戳了戳她' });
  core.store.run("UPDATE percepts SET kind = 'action' WHERE id = ?", act);
  // 昨天写的事实（created_at 在今天以前）、今天写的两条、一条经验；经历：今天一条 event、一条日记
  const old = seedAssertion(core, { text: '旧的事', subjects: [A], speaker: A, perceptIds: [p1], settingKey: sk, at: dayStart - DAY });
  core.store.run('UPDATE assertions SET created_at = ? WHERE id = ?', dayStart - DAY, old);
  seedAssertion(core, { text: '阿明下个月搬家', subjects: [A], speaker: A, perceptIds: [p1], settingKey: sk });
  seedAssertion(core, { text: '阿明喜欢火锅', subjects: [A], speaker: A, perceptIds: [p1], settingKey: sk });
  const lesson = seedAssertion(core, { text: '长消息先分段' });
  core.store.run("UPDATE assertions SET kind_hint = 'lesson' WHERE id = ?", lesson);
  seedEpisode(core, { settingKey: sk, narrative: '大家聊了搬家', participants: [A] });
  seedEpisode(core, { settingKey: sk, narrative: '今天的日记', kind: 'diary' });
  const h = core.mods.admin.home(core, { dayStart });
  assert.deepEqual(h.today.heard, { others: 2, hers: 1, total: 3 });
  assert.deepEqual(h.today.noted, { facts: 2, episodes: 1, total: 3 });
  assert.equal(h.dayStart, dayStart);
  // 给的 dayStart 不合理（未来、两天以前）就按时区自己算
  assert.notEqual(core.mods.admin.home(core, { dayStart: now + HOUR }).dayStart, now + HOUR);
  assert.notEqual(core.mods.admin.home(core, { dayStart: now - 3 * DAY }).dayStart, now - 3 * DAY);
  // 时区：东八区的 0 点
  const z = core.mods.admin.home(core, { tzOffsetMin: 480 });
  assert.equal((z.dayStart + 8 * HOUR) % DAY, 0);
}));

test('home：最近记住的——事实、经历、打算按时间混排；被取代、隐藏、忘掉、经验、取消的打算不要；带场合和人的名字', withCore('adm-home-recent', (core) => {
  const now = core.now();
  const sk = seedSetting(core, { label: '读书会' });
  const A = seedEntity(core, { name: '阿明' });
  const B = seedEntity(core, { name: '小红' });
  const p = seedPercept(core, { settingKey: sk, actor: A, text: '我下个月搬家' });
  const a1 = seedAssertion(core, { text: '阿明要搬家', subjects: [A], speaker: A, perceptIds: [p], settingKey: sk, at: now - 5 * HOUR });
  const a2 = seedAssertion(core, { text: '阿明下个月搬去杭州', subjects: [A], speaker: A, perceptIds: [p], settingKey: sk, at: now - 4 * HOUR, supersedes: a1 });
  const hid = seedAssertion(core, { text: '藏起来的', subjects: [B], speaker: B, settingKey: sk, at: now - 3 * HOUR });
  core.mods.admin.suppress(core, `a${hid}`, { state: 'hidden', by: 'owner', at: now });
  const les = seedAssertion(core, { text: '经验', at: now - 2 * HOUR });
  core.store.run("UPDATE assertions SET kind_hint = 'lesson' WHERE id = ?", les);
  const e = seedEpisode(core, { settingKey: sk, narrative: '大家聊了搬家', participants: [A, B], at: now - HOUR });
  const t1 = Number(core.store.run(`INSERT INTO intentions(act, text, origin, state, target_entity_id, formed_at, created_at, updated_at)
    VALUES ('ask', '问问阿明搬好了没有', 'self-care', 'formed', ?, ?, ?, ?)`, A, now - 30 * 60_000, now, now).lastInsertRowid);
  core.store.run(`INSERT INTO intentions(act, text, origin, state, formed_at, created_at, updated_at)
    VALUES ('ask', '取消了的', 'self-care', 'cancelled', ?, ?, ?)`, now - 10 * 60_000, now, now);
  const h = core.mods.admin.home(core, {});
  assert.deepEqual(h.recent.map((x) => x.ref), [`t${t1}`, `e${e}`, `a${a2}`]);
  const fact = h.recent.find((x) => x.kind === 'fact');
  assert.equal(fact.settingKey, sk);
  assert.equal(fact.who, A);
  assert.equal(fact.certainty, 'stated');
  assert.equal(h.settings[sk].label, '读书会');
  assert.equal(h.names[A].name, '阿明');
  assert.equal(h.names[B].name, '小红');
  assert.equal(h.recent.find((x) => x.kind === 'intent').state, 'formed');
  // recent 的条数可以调，最多 10
  assert.equal(core.mods.admin.home(core, { recent: 1 }).recent.length, 1);
}));

test('home：需要你看一眼——总数 = 需要你知道（开着的）+ 审核（等着的）；要紧的在前，再按新旧', withCore('adm-home-pending', (core) => {
  const now = core.now();
  const sk = seedSetting(core, { label: '读书会' });
  const A = seedEntity(core, { name: '阿明' });
  const p = seedPercept(core, { settingKey: sk, actor: A, text: '这件事别告诉你主人' });
  core.mods.admin.notifyNeedToKnow(core, { kind: 'T1', reason: 'secrecy-request', perceptId: p, sourceEntityId: A, severity: 1, at: now - HOUR });
  core.mods.admin.notifyNeedToKnow(core, { kind: 'T2', reason: 'harm', perceptId: p, severity: 2, at: now - 5 * HOUR });
  const read = core.mods.admin.notifyNeedToKnow(core, { kind: 'T1', reason: 'directive', severity: 3, at: now - 2 * HOUR });
  core.mods.admin.markNeedToKnowRead(core, read);
  core.mods.admin.enqueueReview(core, { kind: 'merge', payload: { a: A, b: A + 100 }, reason: 'maybe-same-uncertain' });
  core.mods.admin.enqueueReview(core, { kind: 'growth', payload: { change: { op: 'add', after: '偶尔主动开个话头' } }, reason: 'approve-mode', expiresAt: now + HOUR });
  const h = core.mods.admin.home(core, {});
  assert.equal(h.pending.needToKnow, 2);
  assert.equal(h.pending.review, 2);
  assert.equal(h.pending.total, 4);
  assert.equal(h.pending.top.length, 3);
  // 要紧的两条（严重程度 2 的需要你知道、一小时后过期的审核）在前，同样要紧的新的在前
  assert.deepEqual(h.pending.top.slice(0, 2).map((x) => [x.source, x.kind, x.urgent]), [['review', 'growth', true], ['needToKnow', 'T2', true]]);
  assert.equal(h.pending.top[0].quote, '偶尔主动开个话头');
  assert.ok(h.pending.top.every((x) => !(x.source === 'needToKnow' && x.reason === 'directive')), '已读的不在里面');
  const t2 = h.pending.top.find((x) => x.kind === 'T2');
  assert.equal(t2.settingKey, sk);
  assert.equal(t2.quote, '这件事别告诉你主人');
  assert.equal(h.settings[sk].label, '读书会');
}));

test('home：入口——注册了的适配器和场合表里出现过的；几个场合、几个在记、最近一条话的时间', withCore('adm-home-entries', (core) => {
  const now = core.now();
  core.adapters ??= new Map();
  core.adapters.set('zz', { id: 'zz', displayName: '编的入口' });
  core.adapters.set('yy', { id: 'yy' });
  const s1 = seedSetting(core, { label: '一个群' });
  const s2 = seedSetting(core, { label: '另一个群' });
  seedPercept(core, { settingKey: s1, text: '早', at: now - 3 * HOUR });
  seedPercept(core, { settingKey: s2, text: '晚', at: now - HOUR });
  core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { settingKey: s2 }, createdBy: 'owner', at: now });
  core.store.run("INSERT INTO settings(key, adapter, label, stability, first_seen, last_seen) VALUES ('sk-gone', 'xx', '走了的', 'persistent', ?, ?)", now, now);
  const h = core.mods.admin.home(core, {});
  const by = Object.fromEntries(h.entries.map((e) => [e.adapter, e]));
  assert.deepEqual(by.zz, { adapter: 'zz', name: '编的入口', connected: true, places: 2, live: by.zz.live, lastAt: now - HOUR });
  assert.ok(by.zz.live <= 1, '别记的场合不算在记');
  assert.deepEqual(by.yy, { adapter: 'yy', name: null, connected: true, places: 0, live: 0, lastAt: null });
  assert.equal(by.xx.connected, false);
  assert.equal(h.entries.at(-1).adapter, 'xx', '没接着的排在后面');
}));

test('home：只读库也能读；不写任何表', withCore('adm-home-ro', (core) => {
  const sk = seedSetting(core, { label: '读书会' });
  seedPercept(core, { settingKey: sk, text: '你好' });
  const before = core.store.get('SELECT total_changes() AS n').n;
  core.readOnly = true;
  const h = core.mods.admin.home(core, {});
  assert.equal(h.readOnly, true);
  assert.equal(h.today.heard.total, 1);
  assert.equal(core.store.get('SELECT total_changes() AS n').n, before, '读首页不写库');
}));

test('home：今天的计数走索引、不扫全表（percepts 走 percepts_at；事实和经历按主键找今天的第一行）', withCore('adm-home-plan', (core) => {
  const plan = (sql, ...p) => core.store.all(`EXPLAIN QUERY PLAN ${sql}`, ...p).map((r) => r.detail).join(' | ');
  const heard = plan("SELECT actor_self AS self, count(*) AS n FROM percepts WHERE at >= ? AND historical = 0 AND kind IN ('utterance', 'self-utterance') GROUP BY actor_self", 0);
  assert.match(heard, /USING INDEX percepts_at|USING COVERING INDEX percepts_at/);
  const facts = plan("SELECT count(*) AS n FROM assertions WHERE id >= ? AND created_at >= ? AND kind_hint <> 'lesson'", 1, 0);
  assert.match(facts, /USING INTEGER PRIMARY KEY/);
  const last = plan('SELECT max(at) AS at FROM percepts WHERE setting_key = ?', 'x');
  assert.match(last, /percepts_setting_at/);
}));
