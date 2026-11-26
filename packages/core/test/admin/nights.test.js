// 管理页「记忆 → 做梦」（D175）：夜间整理按晚列出来——每一晚写下的东西按本地日归类、运行报告按晚留底、翻页不重不漏、忘掉的不列、只读不写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY } from '../fakes/index.js';
import { setMetaJson } from '../../src/store/index.js';
import { adminCore, seedEntity, seedAssertion, seedEpisode, seedImpression } from './fixtures.js';

const HOUR = 3_600_000;
const TZ = 480;
const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};
/** 本地（UTC+8）某天的 0 点；n = 离今天几天（0 = 今天）。 */
const dayStart = (core, n) => Math.floor((core.now() + TZ * 60_000) / DAY) * DAY - TZ * 60_000 - n * DAY;

/** 一个小世界：昨晚做了一整套（日记、改正、规律、想法、印象、性格、经验），三天前的晚上只归纳了一条、而且有两步没做成。 */
function world(core) {
  const A = seedEntity(core, { name: '阿明' });
  const night1 = dayStart(core, 1) + 4.5 * HOUR;
  const night3 = dayStart(core, 3) + 4.5 * HOUR;
  const at = (t, x) => { core.store.run('UPDATE assertions SET recorded_at = ?, updated_at = ? WHERE id = ?', t, t, x); return x; };
  const diary = seedEpisode(core, { settingKey: '', narrative: '今天她和大家聊了搬家，也答应了周六一起打球。', kind: 'diary', at: night1 });
  core.store.run("UPDATE episodes SET created_at = ?, title = '11月25日' WHERE id = ?", night1, diary);
  const before = at(night1 - DAY, seedAssertion(core, { text: '她不会做饭', subjects: [A] }));
  const after = at(night1, seedAssertion(core, { text: '她会做几个家常菜', subjects: [A], supersedes: before }));
  const kept = at(night1 - 2 * DAY, seedAssertion(core, { text: '阿明爱吃火锅', subjects: [A] }));
  const check = (a, verdict, result) => Number(core.store.run(`INSERT INTO memory_checks(assertion_id, at, verdict, result_id, why, before_conf, after_conf)
    VALUES (?, ?, ?, ?, ?, 0.5, 0.8)`, a, night1, verdict, result, verdict === 'confirmed' ? null : '之后她做过饭').lastInsertRowid);
  const c1 = check(before, 'corrected', after);
  const c2 = check(kept, 'confirmed', null);
  const pattern = at(night1, seedAssertion(core, { text: '阿明常在周末约人打球', subjects: [A] }));
  core.store.run("UPDATE assertions SET kind_hint = 'pattern' WHERE id = ?", pattern);
  const insight = at(night1, seedAssertion(core, { text: '大家聊到搬家时她话变多了', subjects: [] }));
  core.store.run("UPDATE assertions SET kind_hint = 'insight' WHERE id = ?", insight);
  const lesson = at(night1, seedAssertion(core, { text: '发长消息前先分段', subjects: [] }));
  core.store.run("UPDATE assertions SET kind_hint = 'lesson', value = ? WHERE id = ?", JSON.stringify({ status: 'unverified', origin: 'nightly' }), lesson);
  // 不是夜里总结的经验（主人教的）不算
  const taught = at(night1, seedAssertion(core, { text: '要先问再答', subjects: [] }));
  core.store.run("UPDATE assertions SET kind_hint = 'lesson', value = ? WHERE id = ?", JSON.stringify({ status: 'verified', origin: 'owner' }), taught);
  const imp = seedImpression(core, { entityId: A, text: '阿明爱热闹，常张罗大家' });
  core.store.run('UPDATE entity_impressions SET built_at = ? WHERE id = ?', night1, imp);
  core.store.run("INSERT INTO core_blocks(name, text, version, char_limit) VALUES ('growth', '她更愿意主动接话', 1, 400)");
  core.store.run(`INSERT INTO core_block_versions(name, version, text, change_json, evidence_ids, created_at, created_by)
    VALUES ('growth', 1, '她更愿意主动接话', ?, '["e1","e2","e3","e4","e5"]', ?, 'sleep')`, JSON.stringify({ op: 'add', after: '她更愿意主动接话' }), night1);
  const old = at(night3, seedAssertion(core, { text: '周三晚上大家常聊游戏', subjects: [A] }));
  core.store.run("UPDATE assertions SET kind_hint = 'pattern' WHERE id = ?", old);
  setMetaJson(core.store, 'sleep.history', [{ startedAt: night3, finishedAt: night3 + 120_000, llmCalls: 4, llmMax: 6, capped: ['generalize'],
    steps: [{ step: 1, name: 'seal-review', ok: true, llmCalls: 1 }, { step: 3, name: 'generalize', ok: true, llmCalls: 2, capped: true },
      { step: 4, name: 'reflect', ok: false, llmCalls: 0, skipped: 'error:Boom' }, { step: 7, name: 'settings', ok: true, llmCalls: 0, skipped: 'saving-preset' },
      { step: 8, name: 'self', ok: true, llmCalls: 1, detail: { diaries: 0, diaryPending: 2 } }] },
  { startedAt: night1, finishedAt: night1 + 90_000, llmCalls: 5, llmMax: 14, capped: [], steps: [{ step: 8, name: 'self', ok: true, llmCalls: 1, detail: { diaries: 1, diaryPending: 0 } }] }]);
  return { A, night1, night3, diary, before, after, kept, c1, c2, pattern, insight, lesson, taught, imp, old };
}

const cat = (n, c) => n.groups.find((g) => g.cat === c);

test('nights：一晚的产出按本地日归在一起，每一类各自的总数和条目；不是夜里写的不算', withCore('nights-day', (core) => {
  const w = world(core);
  const r = core.mods.admin.nights(core, { tzOffsetMin: TZ });
  assert.deepEqual(r.items.map((n) => n.dayStart), [dayStart(core, 1), dayStart(core, 3)], '新的在前；没有产出也没有报告的天不列');
  const n = r.items[0];
  assert.deepEqual(n.groups.map((g) => g.cat).sort(), ['changed', 'diary', 'growth', 'impression', 'insight', 'lesson', 'pattern']);
  assert.equal(cat(n, 'diary').items[0].ref, `e${w.diary}`);
  assert.equal(cat(n, 'diary').items[0].title, '11月25日');
  assert.match(cat(n, 'diary').items[0].text, /聊了搬家/);
  // 对照原话：改了的列出来，没改的只数个数
  assert.equal(n.counts.checked, 2);
  assert.equal(cat(n, 'changed').total, 1);
  const ch = cat(n, 'changed').items[0];
  assert.equal(ch.id, w.c1);
  assert.equal(ch.verdict, 'corrected');
  assert.equal(ch.before.text, '她不会做饭');
  assert.equal(ch.after.text, '她会做几个家常菜');
  assert.equal(ch.revertable, true);
  assert.equal(cat(n, 'pattern').items[0].text, '阿明常在周末约人打球');
  assert.deepEqual(cat(n, 'pattern').items[0].subjects, [w.A]);
  assert.equal(cat(n, 'insight').items[0].text, '大家聊到搬家时她话变多了');
  assert.equal(cat(n, 'lesson').total, 1, '主人教的经验不算夜里总结的');
  assert.equal(cat(n, 'lesson').items[0].ref, `a${w.lesson}`);
  assert.equal(cat(n, 'impression').items[0].who, w.A);
  assert.equal(cat(n, 'impression').items[0].first, true);
  assert.deepEqual(cat(n, 'growth').items[0], { version: 1, op: 'add', before: null, after: '她更愿意主动接话', evidence: 5, revokedAt: null, at: w.night1 });
  assert.equal(r.names[w.A].name, '阿明');
  assert.equal(r.readOnly, false);
  // 另一晚：只有一条归纳
  assert.deepEqual(r.items[1].groups.map((g) => g.cat), ['pattern']);
  assert.equal(r.items[1].counts.diary, 0);
}));

test('nights：每一晚的运行报告——调用、哪几步出错 / 到上限 / 节省档没做、日记缺几天；没有留底的晚 run 是 null', withCore('nights-run', (core) => {
  const w = world(core);
  core.store.run("UPDATE assertions SET recorded_at = recorded_at - 6 * 86400000, updated_at = updated_at - 6 * 86400000 WHERE id = ?", w.old);
  const r = core.mods.admin.nights(core, { tzOffsetMin: TZ });
  const byDay = Object.fromEntries(r.items.map((n) => [n.dayStart, n]));
  const one = byDay[dayStart(core, 1)].run;
  assert.equal(one.llmCalls, 5);
  assert.equal(one.llmMax, 14);
  assert.deepEqual(one.problems, []);
  assert.equal(one.diaryPending, 0);
  const three = byDay[dayStart(core, 3)].run;
  assert.deepEqual(three.problems, [{ name: 'generalize', kind: 'capped' }, { name: 'reflect', kind: 'failed' }, { name: 'settings', kind: 'preset' }]);
  assert.equal(three.diaryPending, 2);
  // 老的那条归纳被挪到更早以后，那一晚只剩报告
  assert.ok(r.items.every((n) => n.run || n.groups.length));
  assert.equal(r.schedule.at, '04:30');
  assert.equal(r.schedule.nights, 2);
  assert.equal(r.schedule.running, false);
}));

test('nights：没有留底的旧晚（升级前）只有产出；最近一次的 lastReport 也算一晚', withCore('nights-old', (core) => {
  const w = world(core);
  setMetaJson(core.store, 'sleep.history', []);
  assert.ok(core.mods.admin.nights(core, { tzOffsetMin: TZ }).items.every((n) => n.run === null));
  setMetaJson(core.store, 'sleep.lastReport', { startedAt: w.night1, finishedAt: w.night1 + 1000, llmCalls: 3, llmMax: 6, capped: [], steps: [] });
  const r = core.mods.admin.nights(core, { tzOffsetMin: TZ });
  assert.equal(r.items.find((n) => n.dayStart === dayStart(core, 1)).run.llmCalls, 3);
}));

test('nights：忘掉的不列（隐藏的照列）；翻页按晚、不重不漏；before 之后的晚才出现', withCore('nights-page', (core) => {
  const w = world(core);
  core.mods.admin.suppress(core, `a${w.pattern}`, { state: 'forgotten', by: 'owner', at: core.now(), restoreUntil: core.now() + 30 * DAY });
  core.mods.admin.suppress(core, `a${w.insight}`, { state: 'hidden', by: 'owner', at: core.now() });
  const all = core.mods.admin.nights(core, { tzOffsetMin: TZ });
  assert.equal(cat(all.items[0], 'pattern'), undefined, '忘掉的不列');
  assert.equal(cat(all.items[0], 'insight').items[0].ref, `a${w.insight}`, '隐藏的照列');
  assert.equal(all.more, false);
  assert.equal(all.next, undefined);
  const p1 = core.mods.admin.nights(core, { tzOffsetMin: TZ, limit: 1 });
  assert.deepEqual(p1.items.map((n) => n.dayStart), [dayStart(core, 1)]);
  assert.equal(p1.more, true);
  assert.equal(p1.next, dayStart(core, 1));
  const p2 = core.mods.admin.nights(core, { tzOffsetMin: TZ, limit: 1, before: p1.next });
  assert.deepEqual(p2.items.map((n) => n.dayStart), [dayStart(core, 3)]);
  assert.equal(p2.more, false);
  assert.throws(() => core.mods.admin.nights(core, { before: 'x' }), /before/);
}));

test('nights：什么都没有时给空列表；只读库照样能读，也不写任何东西', withCore('nights-empty', (core) => {
  const r = core.mods.admin.nights(core, { tzOffsetMin: TZ });
  assert.deepEqual(r.items, []);
  assert.equal(r.more, false);
  assert.equal(r.schedule.lastAt, null);
  const before = core.store.get('SELECT total_changes() AS n').n;
  world(core);
  const mid = core.store.get('SELECT total_changes() AS n').n;
  core.readOnly = true;
  const ro = core.mods.admin.nights(core, { tzOffsetMin: TZ });
  assert.equal(ro.readOnly, true);
  assert.equal(core.store.get('SELECT total_changes() AS n').n, mid, '读不写');
  assert.ok(mid > before);
}));
