// 管理页「记忆」的合并列表和人物（D171）：口径（和单种列表同一套）、筛选、游标翻页（不重不漏、同一时刻的次序稳定）、按天计数、走索引、只读不写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY } from '../fakes/index.js';
import { adminCore, seedSetting, seedEntity, seedPercept, seedAssertion, seedEpisode } from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};
const HOUR = 3_600_000;
const intent = (core, { text, target = null, at, state = 'formed' }) => Number(core.store.run(`INSERT INTO intentions(act, text, origin, state, target_entity_id, formed_at, created_at, updated_at)
  VALUES ('ask', ?, 'self-care', ?, ?, ?, ?, ?)`, text, state, target, at, core.now(), core.now()).lastInsertRowid);
const lesson = (core, { text, at }) => {
  const id = seedAssertion(core, { text, at });
  core.store.run("UPDATE assertions SET kind_hint = 'lesson', updated_at = ? WHERE id = ?", at, id);
  return id;
};

/** 一个小世界：两个人（阿明有两个档案，认成同一个人）、两个场合；四种记忆各几条，时间交错。 */
function world(core) {
  const now = core.now();
  const sk1 = seedSetting(core, { label: '读书会' });
  const sk2 = seedSetting(core, { label: '球队' });
  const A = seedEntity(core, { name: '阿明' });
  const A2 = seedEntity(core, { name: '明哥' });
  const B = seedEntity(core, { name: '小满' });
  core.store.run("INSERT INTO entity_links(a, b, rel, confidence, evidence_json, decided_by, cross_namespace, at, created_at) VALUES (?, ?, 'same', 1, '[]', 'owner', 0, ?, ?)", A, A2, now, now);
  const p = seedPercept(core, { settingKey: sk1, actor: A, text: '我下个月搬家' });
  const ids = {
    f1: seedAssertion(core, { text: '阿明要搬家', subjects: [A], speaker: A, perceptIds: [p], settingKey: sk1, at: now - 10 * HOUR }),
    f2: seedAssertion(core, { text: '明哥喜欢火锅', subjects: [A2], speaker: A2, settingKey: sk2, at: now - 6 * HOUR }),
    f3: seedAssertion(core, { text: '小满在学车', subjects: [B], speaker: B, settingKey: sk2, at: now - 2 * HOUR }),
    e1: seedEpisode(core, { settingKey: sk1, narrative: '大家聊了搬家', participants: [A, B], at: now - 8 * HOUR }),
    e2: seedEpisode(core, { settingKey: sk2, narrative: '球队约了周六', participants: [B], at: now - 4 * HOUR }),
    t1: intent(core, { text: '问问阿明搬好了没有', target: A, at: now - 3 * HOUR }),
    l1: lesson(core, { text: '长消息先分段再发', at: now - 5 * HOUR }),
  };
  return { now, sk1, sk2, A, A2, B, ...ids };
}

test('feed：四种按时间混排（新的在前），每条带种类、时间、谁、在哪儿；名字和场合只给用到的', withCore('feed-mix', (core) => {
  const w = world(core);
  const r = core.mods.admin.feed(core, {});
  assert.deepEqual(r.items.map((x) => x.ref), [`a${w.f3}`, `t${w.t1}`, `e${w.e2}`, `a${w.l1}`, `a${w.f2}`, `e${w.e1}`, `a${w.f1}`]);
  assert.deepEqual(r.items.map((x) => x.kind), ['fact', 'intent', 'episode', 'lesson', 'fact', 'episode', 'fact']);
  assert.equal(r.total, 7);
  const f1 = r.items.find((x) => x.ref === `a${w.f1}`);
  assert.equal(f1.who, w.A);
  assert.equal(f1.settingKey, w.sk1);
  assert.equal(r.settings[w.sk1].label, '读书会');
  assert.equal(r.names[w.A].name, '阿明');
  assert.equal(r.readOnly, false);
  // 旧的在前
  assert.deepEqual(core.mods.admin.feed(core, { order: 'asc' }).items.map((x) => x.ref), r.items.map((x) => x.ref).reverse());
}));

test('feed：口径和单种列表一致——事实不含经验；被取代的旧版本、忘掉的默认不列，隐藏的照列带标记；按状态和版本筛', withCore('feed-scope', (core) => {
  const w = world(core);
  const f4 = seedAssertion(core, { text: '阿明下个月搬去杭州', subjects: [w.A], speaker: w.A, settingKey: w.sk1, at: w.now - HOUR, supersedes: w.f1 });
  core.mods.admin.suppress(core, `a${w.f2}`, { state: 'hidden', by: 'owner', at: w.now });
  core.mods.admin.suppress(core, `e${w.e1}`, { state: 'forgotten', by: 'owner', at: w.now, restoreUntil: w.now + 30 * DAY });
  const refs = (q) => core.mods.admin.feed(core, q).items.map((x) => x.ref);
  const all = refs({});
  assert.ok(all.includes(`a${f4}`) && !all.includes(`a${w.f1}`), '只列现在这一版');
  assert.ok(all.includes(`a${w.f2}`), '隐藏的照列');
  assert.equal(core.mods.admin.feed(core, {}).items.find((x) => x.ref === `a${w.f2}`).state, 'hidden');
  assert.ok(!all.includes(`e${w.e1}`), '忘掉的不列');
  assert.deepEqual(refs({ state: 'forgotten' }), [`e${w.e1}`]);
  assert.equal(core.mods.admin.feed(core, { state: 'forgotten' }).items[0].restoreUntil, w.now + 30 * DAY);
  assert.deepEqual(refs({ state: 'hidden' }), [`a${w.f2}`]);
  assert.ok(!refs({ state: 'active' }).includes(`a${w.f2}`));
  assert.deepEqual(refs({ versions: 'old' }), [`a${w.f1}`]);
  assert.ok(refs({ versions: 'all' }).includes(`a${w.f1}`));
  // 单选一种：和单种列表（assertions、current）同一批，只是去掉了经验
  const single = core.mods.admin.list(core, { view: 'assertions', current: true, state: 'all' }).items.map((x) => x.ref).filter((r) => r !== `a${w.l1}`);
  assert.deepEqual(refs({ kinds: ['fact'], state: 'all' }), single);
  assert.deepEqual(refs({ kinds: ['lesson'] }), [`a${w.l1}`]);
  assert.throws(() => core.mods.admin.feed(core, { kinds: ['percept'] }), /kinds/);
  assert.throws(() => core.mods.admin.feed(core, { state: 'gone' }), /state/);
}));

test('feed：按人筛连同他名下全部档案（D161）；按场合筛时打算不列；时间、搜索', withCore('feed-filters', (core) => {
  const w = world(core);
  const refs = (q) => core.mods.admin.feed(core, q).items.map((x) => x.ref);
  // 阿明（两个档案）：两条事实、他参加的经历、对他的打算
  assert.deepEqual(refs({ entityId: w.A2 }), [`t${w.t1}`, `a${w.f2}`, `e${w.e1}`, `a${w.f1}`]);
  assert.deepEqual(refs({ entityId: w.A }), refs({ entityId: w.A2 }));
  assert.deepEqual(refs({ settingKey: w.sk2 }), [`a${w.f3}`, `e${w.e2}`, `a${w.f2}`]);
  assert.deepEqual(refs({ from: w.now - 5 * HOUR, to: w.now - 3 * HOUR }), [`t${w.t1}`, `e${w.e2}`, `a${w.l1}`]);
  const hits = refs({ q: '搬家' });
  assert.ok(hits.includes(`a${w.f1}`) && hits.includes(`e${w.e1}`), hits.join());
  assert.ok(!hits.includes(`a${w.f3}`));
}));

test('feed：游标翻页不重不漏；同一时刻几种混在一起时次序稳定；往回翻（prev）和往下翻对得上；跳到某个时刻', withCore('feed-paging', (core) => {
  const now = core.now();
  const sk = seedSetting(core, { label: '群' });
  const A = seedEntity(core, { name: '阿明' });
  const want = [];
  // 每个时刻四种各一条（同一时刻），共 12 个时刻
  for (let i = 0; i < 12; i++) {
    const at = now - i * HOUR;
    want.push(`a${seedAssertion(core, { text: `事${i}`, subjects: [A], speaker: A, settingKey: sk, at })}`);
    want.push(`e${seedEpisode(core, { settingKey: sk, narrative: `经历${i}`, participants: [A], at })}`);
    want.push(`t${intent(core, { text: `打算${i}`, target: A, at })}`);
    want.push(`a${lesson(core, { text: `经验${i}`, at })}`);
  }
  const all = core.mods.admin.feed(core, { limit: 200 }).items.map((x) => x.ref);
  assert.equal(all.length, 48);
  // 同一时刻：种类次序倒过来（desc：经验、打算、经历、事实）
  assert.deepEqual(core.mods.admin.feed(core, { limit: 4 }).items.map((x) => x.kind), ['lesson', 'intent', 'episode', 'fact']);
  const seen = [];
  let r = core.mods.admin.feed(core, { limit: 7 });
  assert.equal(r.total, 48);
  const pages = [r];
  seen.push(...r.items.map((x) => x.ref));
  while (r.next) {
    r = core.mods.admin.feed(core, { limit: 7, next: r.next });
    assert.equal(r.total, null, '翻页时不再数总数');
    pages.push(r);
    seen.push(...r.items.map((x) => x.ref));
  }
  assert.deepEqual(seen, all);
  assert.equal(new Set(seen).size, 48);
  // 从第三页往回翻一页 = 第二页
  const back = core.mods.admin.feed(core, { limit: 7, prev: pages[2].prev });
  assert.deepEqual(back.items.map((x) => x.ref), pages[1].items.map((x) => x.ref));
  // 旧的在前也一样不重不漏
  const asc = [];
  r = core.mods.admin.feed(core, { limit: 5, order: 'asc' });
  asc.push(...r.items.map((x) => x.ref));
  while (r.next) { r = core.mods.admin.feed(core, { limit: 5, order: 'asc', next: r.next }); asc.push(...r.items.map((x) => x.ref)); }
  assert.deepEqual(asc, [...all].reverse());
  // 换了顺序的旧游标不认（从头开始）
  assert.deepEqual(core.mods.admin.feed(core, { limit: 5, order: 'asc', next: pages[1].next }).items.map((x) => x.ref), asc.slice(0, 5));
  // 跳到 3.5 小时前：desc 从那一刻和更早的开始，能往回翻
  const j = core.mods.admin.feed(core, { limit: 4, around: now - 3.5 * HOUR });
  assert.deepEqual(j.items.map((x) => x.ref), all.slice(16, 20));
  assert.ok(j.prev);
  assert.deepEqual(core.mods.admin.feed(core, { limit: 4, prev: j.prev }).items.map((x) => x.ref), all.slice(12, 16));
  // 跳到比最早还早：退回最早的一页
  const early = core.mods.admin.feed(core, { limit: 4, around: now - 100 * HOUR });
  assert.deepEqual(early.items.map((x) => x.ref), all.slice(44));
}));

test('feedDays：四种加起来每天几条；最早、最晚', withCore('feed-days', (core) => {
  const w = world(core);
  const monthOf = (t) => { const d = new Date(t + 8 * HOUR); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  // world 的时间跨度只有 10 小时；碰上月初可能跨两个月：两个月加起来
  const months = [...new Set([monthOf(w.now - 10 * HOUR), monthOf(w.now)])];
  const sum = (q) => months.reduce((n, month) => n + core.mods.admin.feedDays(core, { ...q, month, tzOffsetMin: 480 }).items.reduce((m, x) => m + x.n, 0), 0);
  assert.equal(sum({}), 7);
  assert.equal(sum({ kinds: ['episode'] }), 2);
  assert.equal(sum({ entityId: w.A }), 4);
  const r = core.mods.admin.feedDays(core, { month: months[0], tzOffsetMin: 480 });
  assert.equal(r.first, w.now - 10 * HOUR);
  assert.equal(r.last, w.now - 2 * HOUR);
  assert.throws(() => core.mods.admin.feedDays(core, { month: '2026-13' }), /month/);
}));

test('feed：只读库也能读，不写库', withCore('feed-ro', (core) => {
  world(core);
  const before = core.store.get('SELECT total_changes() AS n').n;
  core.readOnly = true;
  const r = core.mods.admin.feed(core, {});
  assert.equal(r.readOnly, true);
  assert.equal(r.items.length, 7);
  core.mods.admin.people(core, {});
  assert.equal(core.store.get('SELECT total_changes() AS n').n, before, '读列表不写库');
}));

test('性能：每一路按时间翻页走索引，不为排序建临时 B 树（EXPLAIN QUERY PLAN）', withCore('feed-plan', async (core) => {
  world(core);
  const { feedPlan } = await import('../../src/admin/feed.js');
  const plan = (sql, args) => core.store.all(`EXPLAIN QUERY PLAN ${sql}`, ...args).map((r) => r.detail).join(' | ');
  const want = { fact: /assertions_recorded/, episode: /episodes_t_end/, intent: /intentions_formed/, lesson: /assertions_lesson_updated/ };
  for (const order of ['desc', 'asc']) {
    for (const p of feedPlan(core, { order })) {
      const d = plan(p.sql, p.args);
      assert.match(d, want[p.kind], `${p.kind}: ${d}`);
      assert.doesNotMatch(d, /USE TEMP B-TREE FOR ORDER BY/, `${p.kind}: ${d}`);
    }
  }
}));

test('people：一个人一项（认成同一个人的并起来），名下几条、最近一次、一句印象；主人在前；给 id 带详情', withCore('feed-people', (core) => {
  const w = world(core);
  const O = seedEntity(core, { name: '主人', authority: 'principal' });
  core.store.run("INSERT INTO entity_impressions(entity_id, layer, text, version, is_current, built_at) VALUES (?, 'shared', '爱开玩笑', 1, 1, ?)", w.A2, w.now);
  const r = core.mods.admin.people(core, {});
  assert.equal(r.items[0].id, O);
  const a = r.items.find((x) => x.members.includes(w.A));
  assert.ok(a.members.includes(w.A2));
  assert.deepEqual(a.aliases.length, 1);
  assert.equal(a.facts, 2);
  assert.equal(a.episodes, 1);
  assert.equal(a.intents, 1);
  assert.equal(a.n, 4);
  assert.equal(a.impression, '爱开玩笑');
  assert.equal(r.items.filter((x) => x.members.includes(w.A2)).length, 1);
  const one = core.mods.admin.people(core, { id: w.A2 });
  assert.equal(one.items.length, 1);
  assert.ok(one.detail.names.some((n) => n.text === '明哥'));
  assert.ok(one.detail.links.some((l) => l.rel === 'same' && l.decidedBy === 'owner'));
}));
