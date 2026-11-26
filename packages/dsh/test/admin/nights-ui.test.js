// 管理页「记忆 → 做梦」「记忆 → 日记」和首页「夜里整理」那一行（D175）：集成层的 nights 视图（参数透传、老核心、坏参数、只读不写）、
// memories 认 epKind（日记单独一页的来源）、首页多带最近一晚的几个数（nightSummary）、新页面的分段和脱离浏览器能测的文字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup } from './helpers.js';
import { makeFakePm, NOW } from './fixtures.js';
import { nightSummary } from '../../src/admin/views.js';

const BASE = fs.readFileSync(new URL('../../src/admin/ui/base.js', import.meta.url), 'utf8');
const MEMORY = fs.readFileSync(new URL('../../src/admin/ui/memory.js', import.meta.url), 'utf8');
const HOME = fs.readFileSync(new URL('../../src/admin/ui/home.js', import.meta.url), 'utf8');

test('nights 视图：limit / before / tz 透传给核心；每一晚带产出和运行报告；没有数据也是空列表', async () => {
  const s = setup();
  const r = await s.view('nights', { limit: '3', before: String(NOW), tz: '480' });
  assert.equal(r.status, 200);
  const c = s.callsOf('admin.nights').at(-1).args[0];
  assert.equal(c.limit, 3);
  assert.equal(c.before, NOW);
  assert.equal(c.tzOffsetMin, 480);
  const d = r.body.data;
  assert.ok(d.items.length >= 2);
  assert.ok(d.items[0].run && d.items[0].run.problems.length, '最近一晚有运行报告，里面有没做成的步骤');
  assert.equal(d.items[1].run, null, '升级前的晚没有运行报告');
  assert.ok(d.items.every((n) => n.groups.every((g) => g.total >= g.items.length)));
  // 空库
  const e = setup({ scenario: 'empty' });
  const re = (await e.view('nights', {})).body.data;
  assert.deepEqual(re.items, []);
  assert.equal(re.more, false);
});

test('nights 视图：老核心没有这个函数 → unsupported；参数不对 → 400；只读，不写', async () => {
  const pm = makeFakePm({ now: NOW });
  delete pm.admin.nights;
  assert.deepEqual((await setup({ pm }).view('nights', {})).body.data, { unsupported: true });
  const s = setup();
  assert.equal((await s.view('nights', { limit: 'x' })).status, 400);
  assert.equal((await s.view('nights', { before: 'x' })).status, 400);
  assert.equal((await s.view('nights', { tz: '9999' })).status, 400);
  assert.ok(!s.pm.calls.some((c) => /hide|forget|restore|purge|revert|revoke/.test(c.name)));
});

test('memories：episodes 认 epKind（日记单独一页），别的值 400', async () => {
  const s = setup();
  const r = await s.view('memories', { list: 'episodes', epKind: 'diary', order: 'desc', limit: '14' });
  assert.equal(r.status, 200);
  const q = s.callsOf('admin.list').find((c) => c.args[0].view === 'episodes')?.args[0];
  assert.equal(q?.epKind, 'diary');
  assert.equal(q?.view, 'episodes');
  assert.equal((await s.view('memories', { list: 'episodes', epKind: 'bogus' })).status, 400);
});

test('nightSummary：首页只要最近一晚的几个数和没做成的步骤个数；读不出来、老核心 → null', () => {
  assert.equal(nightSummary(null), null);
  assert.equal(nightSummary({ unsupported: true }), null);
  assert.equal(nightSummary({ error: 'X' }), null);
  const n = nightSummary({ schedule: { at: '04:30', lastAt: 5, running: false, nights: 2 }, items: [{ dayStart: 10, counts: { diary: 1, changed: 2, checked: 6 },
    run: { at: 11, llmCalls: 9, problems: [{ kind: 'failed' }, { kind: 'capped' }, { kind: 'preset' }] } }] });
  assert.deepEqual(n.night.counts, { diary: 1, changed: 2, checked: 6, pattern: 0, insight: 0, impression: 0, growth: 0, lesson: 0 });
  assert.equal(n.night.run.problems, 1, '到上限、省钱档不做的不算没做成');
  assert.equal(n.lastAt, 5);
  const empty = nightSummary({ schedule: {}, items: [] });
  assert.equal(empty.night, null);
  assert.equal(empty.at, '04:30');
});

test('home 视图多带 night；核心没有 nights 时是 null，首页其余照旧', async () => {
  const s = setup();
  const d = (await s.view('home', {})).body.data;
  assert.ok(d.night && d.night.night, '有最近一晚');
  assert.ok(d.night.night.counts.diary >= 1);
  const pm = makeFakePm({ now: NOW });
  delete pm.admin.nights;
  const o = (await setup({ pm }).view('home', {})).body.data;
  assert.equal(o.night ?? null, null);
  assert.ok(o.headline, '其余的照旧');
});

test('新页面：「记忆」的分段多了日记、做梦；老地址 memory/diary、memory/dream 在旧版里对应记忆页签', () => {
  assert.match(BASE, /\['diary', '日记'\]/);
  assert.match(BASE, /\['dream', '做梦'\]/);
  assert.match(BASE, /'memory\/diary': 'memory'/);
  assert.match(BASE, /'memory\/dream': 'memory'/);
});

test('新页面的文字：做梦页和首页都只描述发生了什么，不替它下判断；用到的图标和路径都存在', () => {
  for (const ic of ['book', 'pen', 'stars', 'sun', 'user', 'sprout', 'file', 'moon', 'undo']) assert.ok(new RegExp(`\\n    ${ic}: \\[`).test(BASE), `图标 ${ic}`);
  assert.match(MEMORY, /renderDiary/);
  assert.match(MEMORY, /renderDream/);
  assert.match(MEMORY, /R\.api\.get\('nights'/);
  assert.match(MEMORY, /epKind: 'diary'/);
  assert.match(HOME, /memory\/dream/);
  // 做梦页引用的设置分段都存在
  for (const sub of ['models', 'cost', 'diag']) assert.match(BASE, new RegExp(`\\['${sub}', `));
});
