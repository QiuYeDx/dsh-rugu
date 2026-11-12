// 管理页首页（D170）的视图：各种状态下的字段和一句话状态、口径透传、权限、只读时不写；纯函数 homeView / homeHeadline / homeHealth。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { homeHeadline, homeHealth, homeView } from '../../src/admin/views.js';
import { makeFakePm, makeFakeHost } from './fixtures.js';
import { setup, ORIGIN } from './helpers.js';

const WRITES = /^admin\.(forget|hide|restore|purge|rules\.(add|revoke)|setMode|review\.decide|needToKnow\.markRead|backup\.(now|restore)|relaxLimit|renameSetting|withdrawBySource)/;
const writesOf = (s) => s.pm.calls.filter((c) => WRITES.test(c.name));

test('home：正常——她在记着；今天听到 / 记下的数；待处理总数和最要紧的 3 条；最近记住的；入口；四行健康；今天的花费', async () => {
  const s = setup();
  const r = await s.view('home', { tz: '480' });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.headline.key, 'ok');
  assert.equal(d.headline.level, 'ok');
  assert.equal(d.headline.title, '她在记着。');
  // 句子里中文和数字之间有空格
  assert.match(d.headline.text, /^3 个入口都通着。今天听到 \d+ 句话，记下了 \d+ 件事。$/);
  assert.equal(d.today.heard.total, d.today.heard.others + d.today.heard.hers);
  assert.equal(d.today.noted.total, d.today.noted.facts + d.today.noted.episodes);
  assert.equal(d.pending.total, d.pending.needToKnow + d.pending.review);
  assert.ok(d.pending.top.length <= 3 && d.pending.top.length > 0);
  // 要紧的在前
  const firstPlain = d.pending.top.findIndex((x) => !x.urgent);
  assert.ok(firstPlain < 0 || d.pending.top.slice(firstPlain).every((x) => !x.urgent));
  assert.ok(d.recent.length > 0 && d.recent.length <= 5);
  assert.ok(d.recent.every((m) => ['fact', 'episode', 'intent'].includes(m.kind)), '不含原话、经验');
  for (let i = 1; i < d.recent.length; i++) assert.ok(d.recent[i - 1].at >= d.recent[i].at, '新的在前');
  assert.deepEqual(d.health.map((x) => x.key), ['store', 'llm', 'embedding', 'backup']);
  assert.ok(d.health.every((x) => typeof x.to === 'string' && x.to.includes('/')), '每行都有去处');
  assert.deepEqual(d.entries.map((e) => e.state), ['on', 'on', 'on']);
  assert.equal(d.spend.presetLabel, '平衡档');
  assert.equal(d.spend.priceKnown, true);
  assert.equal(typeof d.spend.daysLeft, 'number');
  // 用到的场合给的是管理页上的称呼（settingTitle）
  for (const t of d.pending.top) if (t.settingKey) assert.equal(typeof d.settings[t.settingKey], 'string');
  // 时区透传给核心
  assert.deepEqual(s.callsOf('admin.home').at(-1).args[0], { tzOffsetMin: 480 });
  // 工程数字不上首页：没有数据版本、维度、覆盖率、认领的会话、熔断……
  const text = JSON.stringify(d);
  for (const bad of ['schemaVersion', 'coverage', '"dim"', 'claimed', 'breakersOpen', 'spaceId']) assert.ok(!text.includes(bad), bad);
  assert.equal(writesOf(s).length, 0);
});

test('home：全新安装——空状态（下一步做什么），入口是「还没有」', async () => {
  const s = setup({ scenario: 'empty' });
  const d = (await s.view('home')).body.data;
  assert.equal(d.fresh, true);
  assert.equal(d.headline.key, 'fresh');
  assert.equal(d.headline.level, 'quiet');
  assert.match(d.headline.text, /人设聊天/);
  assert.deepEqual(d.recent, []);
  assert.equal(d.pending.total, 0);
  assert.ok(d.entries.every((e) => e.state === 'none'));
});

test('home：后台模型不工作（没顶着 / 在顶着）、只读、总开关关着——问题在最前，带一个按钮', async () => {
  const cases = [
    ['llmdown', 'llm.down', 'settings/models', /只记原话/],
    ['fallback', 'llm.fallback', 'settings/models', /顶着/],
    ['readonly', 'store.readOnly', 'settings/diag', /只读/],
    ['off', 'mode.off', 'settings/basic', /总开关/],
  ];
  for (const [scenario, key, to, title] of cases) {
    const s = setup({ scenario });
    const d = (await s.view('home')).body.data;
    assert.equal(d.headline.key, key, scenario);
    assert.equal(d.headline.action.to, to, scenario);
    assert.match(d.headline.title, title, scenario);
    // 标题说过的不再进「需要你看一眼」
    assert.ok(!d.notices.some((n) => n.key === key), scenario);
    assert.equal(writesOf(s).length, 0, `${scenario}：读首页不写`);
  }
  const ro = (await setup({ scenario: 'readonly' }).view('home')).body.data;
  assert.ok(ro.entries.every((e) => e.state === 'paused' && e.pausedBy === 'readOnly'), '只读时入口不说「在记」');
  assert.equal(ro.health.find((x) => x.key === 'store').text, '只读');
  const down = (await setup({ scenario: 'llmdown' }).view('home')).body.data;
  assert.equal(down.health.find((x) => x.key === 'llm').state, 'bad');
  const fb = (await setup({ scenario: 'fallback' }).view('home')).body.data;
  assert.equal(fb.health.find((x) => x.key === 'llm').text, '在用聊天模型顶着');
});

test('home：核心读不出来（老核心没有 admin.home、或者库坏了）——宿主那一半照给，核心那一半标 error', async () => {
  const pm = makeFakePm();
  delete pm.admin.home;
  const d = (await setup({ pm }).view('home')).body.data;
  assert.equal(d.error, 'UNSUPPORTED');
  assert.equal(d.pending, null);
  assert.deepEqual(d.recent, []);
  assert.equal(d.health.length, 4);
  const e = (await setup({ scenario: 'errors' }).view('home')).body.data;
  assert.ok(e.error);
  assert.equal(e.headline.level, 'bad');
});

test('home：和别的视图一样要页面令牌；首次设置模式下不开', async () => {
  const s = setup();
  const res = await s.h.data(new Request(`${ORIGIN}${ROUTES.data}?view=home`));
  assert.equal(res.status, 403);
  assert.equal(s.callsOf('admin.home').length, 0);
  const { createAdminHandlers } = await import('../../src/admin/index.js');
  const sm = createAdminHandlers({ setupMode: true, host: makeFakeHost(), token: 'tok' });
  const r2 = await sm.data(new Request(`${ORIGIN}${ROUTES.data}?view=home`, { headers: { [TOKEN_HEADER]: 'tok' } }));
  assert.equal(r2.status, 503);
  // tz 不合法 → 400
  assert.equal((await s.view('home', { tz: '9999' })).status, 400);
});

test('homeHeadline：先后顺序——记忆库 > 只读 > 插件没启动好 > 总开关 > 后台模型不工作 > 顶着 > 余额保护 > 没有入口在记', () => {
  const on = [{ state: 'on' }];
  const base = { now: 0, store: { readOnly: false }, mode: { global: 'live' }, llm: { state: 'ok' }, budget: { paused: false }, host: { ready: true } };
  const k = (o, entries = on) => homeHeadline({ o: { ...base, ...o }, entries, today: { heard: { total: 1 }, noted: { total: 0 } }, fresh: false }).key;
  assert.equal(k({ store: { error: 'X' }, llm: { state: 'down' } }), 'store.error');
  assert.equal(k({ store: { readOnly: true }, mode: { global: 'off' } }), 'store.readOnly');
  assert.equal(k({ host: { ready: false, error: 'BOOT' }, mode: { global: 'off' } }), 'host.down');
  assert.equal(k({ mode: { global: 'off' }, llm: { state: 'down' } }), 'mode.off');
  assert.equal(k({ llm: { state: 'down', fallback: null }, budget: { paused: true } }), 'llm.down');
  assert.equal(k({ llm: { state: 'down', fallback: { provider: 'p', model: 'm' } } }), 'llm.fallback');
  assert.equal(k({ budget: { paused: true } }), 'budget.paused');
  assert.equal(k({}, [{ state: 'off' }]), 'entries.none');
  assert.equal(k({}), 'ok');
  // 后台模型不稳定不当标题（健康行里说）
  assert.equal(k({ llm: { state: 'flaky' } }), 'ok');
  // 一个入口在记、一个没接上：「1 个入口在记。」
  const h = homeHeadline({ o: base, entries: [{ state: 'on' }, { state: 'none' }], today: { heard: { total: 42 }, noted: { total: 6 } }, fresh: false });
  assert.equal(h.text, '1 个入口在记。今天听到 42 句话，记下了 6 件事。');
});

test('homeHealth：每行一句人话和去处；嵌入没开、熔断、可疑；备份的几种问题', () => {
  const base = { now: 10 * 86_400_000, store: {}, llm: { state: 'ok' }, embedding: { dense: true }, spaces: [], backup: { last: { at: 1 }, lastOk: 10 * 86_400_000 - 1000, offsite: { configured: true, encrypted: true } } };
  const row = (o, key, cfg) => homeHealth({ ...base, ...o }, cfg).find((x) => x.key === key);
  assert.equal(row({}, 'embedding', { embedding: { url: 'http://127.0.0.1:11434', tier: 'standard' } }).text, '本机 · 4B');
  assert.equal(row({}, 'embedding', { embedding: { url: 'https://example.invalid/v1', tier: 'custom' } }).text, '在线服务');
  assert.equal(row({ embeddingOff: true }, 'embedding').state, 'dim');
  assert.equal(row({ embedding: { dense: false, breakerOpen: true } }, 'embedding').state, 'warn');
  assert.equal(row({ spaces: [{ status: 'suspect' }] }, 'embedding').state, 'bad');
  assert.equal(row({}, 'backup').text, '正常');
  assert.equal(row({ backup: { last: null } }, 'backup').text, '今晚第一次');
  assert.equal(row({ backup: { ...base.backup, failed: 2 } }, 'backup').text, '2 份没通过验证');
  assert.equal(row({ backup: { ...base.backup, offsite: { configured: false } } }, 'backup').text, '只在这块盘上');
  assert.equal(row({ llm: { state: 'off' } }, 'llm').state, 'dim');
  assert.equal(row({ llm: { state: 'ok', catchUp: 3 } }, 'llm').text, '正常 · 在补 3 段');
});

test('homeView：总览的提醒按 key 分——健康行和标题说过的不再进「需要你看一眼」，别的换成短的人话', () => {
  const o = { now: 0, store: {}, mode: { global: 'live' }, llm: { state: 'ok' }, host: { ready: true, unclassified: 2 }, selfCheck: { failed: 1 }, budget: null, backup: null };
  const core = { dayStart: 0, today: { heard: { total: 1, others: 1, hers: 0 }, noted: { total: 0, facts: 0, episodes: 0 } }, pending: { total: 0, needToKnow: 0, review: 0, top: [] },
    recent: [], entries: [{ adapter: 'qq', name: 'QQ', connected: true, places: 1, live: 1, lastAt: 1 }], settings: { k: { label: '一个 QQ 群', labelKind: 'description', hint: 'Ab1c' } }, names: {} };
  const alerts = [
    { level: 'bad', key: 'selfCheck.failed', tab: 'diagnostics', text: '启动自检有 1 项没通过' },
    { level: 'warn', key: 'host.unclassified', tab: 'diagnostics', text: '有 2 个工具没有分类' },
    { level: 'warn', key: 'backup.offsite', tab: 'backups', text: '备份只在这块盘上' },
    { level: 'warn', key: 'llm.flaky', tab: 'config', text: '后台模型最近不稳定' },
    { level: 'info', key: 'retention.pending', tab: 'config', text: '保留期将缩短' },
  ];
  const v = homeView({ core, o, alerts, hostCfg: null });
  assert.deepEqual(v.notices.map((n) => n.key), ['selfCheck.failed', 'host.unclassified']);
  assert.equal(v.notices[1].text, '有 2 个工具还没分类，用它们说的话没经过检查');
  assert.equal(v.notices[0].to, 'settings/diag');
  assert.equal(v.settings.k, '一个 QQ 群（Ab1c）', '没名字的群带区分提示');
  assert.equal(v.entries[0].state, 'on');
});
