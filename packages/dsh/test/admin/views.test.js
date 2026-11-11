// 管理页的只读视图（§13.1、§13.2、§13.3）：只经核心的公开 API 和 host.*；宿主的状态只给数字和短状态；
// 某一块读不出来只影响那一块；宿主的形状（配置 {host, core}、自检 {level, group}、预算、显卡）照 host/ 的实现读。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChecks, budgetSummary, gpuSummary, configParts, hostSummary, budgetConfigView, budgetValue, budgetRisks } from '../../src/admin/views.js';
import { setup } from './helpers.js';
import { makeFakeHost, NOW } from './fixtures.js';

test('总览：只有数字和短状态；宿主状态里的路径、长字符串、内部对象不往页面送', async () => {
  const s = setup();
  const r = await s.view('overview');
  assert.equal(r.status, 200);
  const o = r.body.data;
  assert.deepEqual(o.pending, { review: 6, needToKnow: 6, holds: 1, growth: 1 });
  assert.deepEqual(o.mode, { global: 'live', byAttributes: { principalOneOnOne: 'live', closed: 'live', public: 'live' } });
  assert.equal(o.store.schemaVersion, 12);
  assert.equal(o.backup.last.path, 'pm-daily-20261104T0430Z-rs.pmpack', '备份路径只留文件名');
  assert.equal(o.host.ready, true);
  assert.equal(o.host.breakersOpen, 0);
  assert.equal(o.host.hookErrors, 3);
  assert.equal(o.host.recentErrors[0].event, 'embed.request');
  const text = JSON.stringify(o);
  for (const leak of ['secretLooking', 'xxxxxxxxxx', 'persona-memory.json', 'someone', 'E:\\\\data']) assert.ok(!text.includes(leak), leak);
  assert.ok(o.budget.today.calls > 0, '假 host 用的是真的 BudgetPort（D120）');
  assert.equal(o.budget.limits.dailyCalls, 3000);
  assert.equal(o.budget.balance.days, 9.5);
  assert.equal(o.gpu.device, 'gpu');
  assert.deepEqual(o.gpu.vram, { freeMb: 6388, totalMb: 12_288, usedMb: 5900, utilPct: 12 });
  // 自检：总览用宿主状态里上次的结果，不为了总览重跑一遍（会探嵌入服务）
  assert.deepEqual({ failed: o.selfCheck.failed, warned: o.selfCheck.warned }, { failed: 1, warned: 1 });
  assert.equal(s.hostCallsOf('selfCheck').length, 0);
});

test('总览的提醒按严重程度排；每一块各自兜错：读不出来的只标那一块', async () => {
  const s = setup({ scenario: 'errors' });
  const o = (await s.view('overview')).body.data;
  assert.deepEqual(o.backup, { error: 'EACCES' });
  assert.deepEqual(o.host, { error: 'Error' });
  assert.equal(o.selfCheck.error, 'Error');
  assert.equal(o.store.readOnly, true);
  const levels = o.alerts.map((a) => a.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => ['bad', 'warn', 'info'].indexOf(a) - ['bad', 'warn', 'info'].indexOf(b)));
  assert.match(o.alerts[0].text, /只读/);
  const n = setup().view('overview');
  const alerts = (await n).body.data.alerts;
  assert.ok(alerts.some((a) => /没通过验证/.test(a.text)));
  assert.ok(alerts.every((a) => typeof a.text === 'string' && ['bad', 'warn', 'info'].includes(a.level)));
  const e = (await setup({ scenario: 'empty' }).view('overview')).body.data;
  assert.ok(e.alerts.some((a) => /备份只在这块盘上/.test(a.text)));
  assert.ok(e.alerts.some((a) => /盘剩余空间不足/.test(a.text)));
  assert.ok(e.alerts.some((a) => /熔断/.test(a.text)));
});

test('设置视图读宿主配置里的核心那一半（{host, core}）；也认直接给核心参数表的宿主', async () => {
  const s = setup();
  const d = (await s.view('config')).body.data;
  assert.equal(d.budgetPreset, 'loose');
  assert.equal(d.growthMode, 'auto');
  assert.equal(d.mode.global, 'live');
  assert.equal(d.coolingOffDays, 7);
  assert.equal(d.canWrite, true);
  assert.equal(d.gpu.policy, 'adaptive');
  assert.equal(d.gpu.canSet, true);
  assert.deepEqual(configParts({ config: { get: () => ({ budget: { preset: 'saving' } }) } }).core, { budget: { preset: 'saving' } });
  assert.deepEqual(configParts({ config: { get: () => { throw new Error('x'); } } }), { core: {}, host: null, warnings: 0, loadError: null, pendingRisky: [] });
  assert.deepEqual(configParts(null).core, {});
  // DSH 宿主的形状（host/index.js 的 hostApi.config.get）：核心参数表在顶层，host 和 meta 另放
  const flat = configParts({ config: { get: () => ({ mode: { global: 'live' }, budget: { preset: 'loose' }, host: { gpu: { policy: 'on' } }, meta: { file: 'x.json', warnings: ['w1', 'w2'], loadError: 'EACCES' } }) } });
  assert.deepEqual(flat.core, { mode: { global: 'live' }, budget: { preset: 'loose' } }, 'host、meta 不混进核心那一半');
  assert.deepEqual(flat.host, { gpu: { policy: 'on' } });
  assert.equal(flat.warnings, 2);
  assert.equal(flat.loadError, 'EACCES');
  // 热加载时扣下的有风险的改动（只有路径和理由）
  const held = configParts({ config: { get: () => ({ host: {}, meta: { warnings: [], loadError: null, pendingRisky: [{ path: 'host.features.egress', reason: '关掉外发审视', value: false }] } }) } });
  assert.deepEqual(held.pendingRisky, [{ path: 'host.features.egress', reason: '关掉外发审视' }]);
  const b = (await s.view('backups')).body.data;
  assert.equal(b.offsiteDir, 'D:\\备份\\记忆');
  assert.equal(b.keep.daily, 7);
  assert.equal(b.packs.items[0].name, 'pm-daily-20261104T0430Z-rs.pmpack');
  assert.equal(b.packs.items[0].path, undefined, '包的整条路径不给页面');
});

test('诊断：自检统一成 {status, area}；结果缓存一分钟，「重新检查」才重跑；降级分布从宿主的注入统计来', async () => {
  const s = setup();
  const d = (await s.view('diagnostics')).body.data;
  const unc = d.selfCheck.items.find((c) => c.id === 'tools.unclassified');
  assert.deepEqual({ status: unc.status, area: unc.area, disables: unc.disables }, { status: 'fail', area: 'adapters', disables: 'egress:unclassified' });
  assert.match(unc.detail, /egress\.extraTools/);
  assert.equal(d.selfCheck.items.find((c) => c.id === 'rerank').status, 'info');
  assert.deepEqual(d.degrade, [812, 96, 31, 12, 0]);
  assert.equal(d.host.hooks.length, 4);
  assert.equal(d.host.hooks[0].name, 'agent/pre-step');
  assert.equal(d.host.llm.byUse.appraise, 290);
  assert.deepEqual(d.host.claims.byAdapter, { QQ: 3, 'DSH 网页': 1 }, '入口用管理页上的名字，不是原始 id（D111）');
  assert.equal(d.host.embedPort.version, '0.12.5');
  assert.equal(d.host.unclassifiedTools[0].tool, 'mcp__some_server__post_message');
  assert.deepEqual(d.store.sleep.capped, ['generalize'], '夜间整理：到上限少做了的步（D138）');
  assert.equal(d.store.sleep.generalize.skippedAsked, 4);
  assert.equal(s.hostCallsOf('selfCheck').length, 1);
  await s.view('diagnostics');
  assert.equal(s.hostCallsOf('selfCheck').length, 1, '一分钟内用缓存');
  await s.view('diagnostics', { refresh: '1' });
  assert.equal(s.hostCallsOf('selfCheck').length, 2);
  assert.deepEqual(s.hostCallsOf('selfCheck')[1].args, [{ force: true }]);
  s.clock.t += 61_000;
  await s.view('diagnostics');
  assert.equal(s.hostCallsOf('selfCheck').length, 3);
  const none = (await setup({ host: null }).view('diagnostics')).body.data;
  assert.deepEqual(none.selfCheck, { error: 'UNAVAILABLE' });
  assert.equal(none.host, null);
});

test('自检结果的几种形状都认：数组、{checks}、{items}、ok 布尔、level 字段；不认识的状态当提醒', () => {
  const a = normalizeChecks([{ id: 'x', ok: true }, { id: 'y', ok: false }, { id: 'z', ok: false, severity: 'warn' }, { name: 'w', skipped: true }]);
  assert.deepEqual(a.items.map((c) => c.status), ['ok', 'fail', 'warn', 'skip']);
  const b = normalizeChecks({ at: 5, level: 'warn', items: [{ id: 'q', group: 'bridge', level: 'info', label: 'L', hint: 'H', disables: ['a', 'b'] }, { id: 'r', level: 'weird' }] });
  assert.deepEqual(b.items[0], { id: 'q', area: 'bridge', label: 'L', status: 'info', detail: 'H', disables: 'a、b' });
  assert.equal(b.items[1].status, 'warn');
  assert.equal(b.at, 5);
  assert.equal(normalizeChecks({ checks: [{ id: 'c', status: 'ok' }] }).items[0].status, 'ok');
  assert.deepEqual(normalizeChecks({ error: 'TIMEOUT' }), { error: 'TIMEOUT' });
});

test('预算和显卡的摘要只取认得的数；游戏模式看配置里的截止时间', () => {
  const host = makeFakeHost();
  const raw = host.budget.status();
  const b = budgetSummary(raw);
  assert.equal(b.today.uncached, raw.today.uncachedTokens);
  assert.equal(b.today.review, raw.today.reviews);
  assert.equal(b.limits.egressReservePerDay, 100);
  assert.equal(b.history.length, 14);
  assert.equal(budgetSummary(null), null);
  assert.deepEqual(budgetSummary('x'), { error: 'SHAPE' });
  assert.equal(budgetSummary({ balance: { days: 'inf' } }).balance.days, 'inf');
  // DSH 的 BudgetPort（ports/budget.js 的 status()）用长名字
  const real = budgetSummary({ preset: 'loose', today: { calls: 3, uncachedTokens: 1200, cachedTokens: 800, outputTokens: 90, reviews: 2 }, balance: { known: true, daysLeft: 12.5, unlimited: false } });
  assert.deepEqual([real.today.uncached, real.today.cached, real.today.out, real.today.review, real.balance.days], [1200, 800, 90, 2, 12.5]);
  assert.equal(budgetSummary({ balance: { known: true, daysLeft: null, unlimited: true } }).balance.days, 'inf');
  const g = gpuSummary(host.gpu.status(), { gpu: { gameMode: { until: NOW + 3_600_000 } } }, NOW, true);
  assert.deepEqual(g.gameMode, { on: true, until: NOW + 3_600_000 });
  assert.equal(gpuSummary(host.gpu.status(), { gpu: { gameMode: { until: NOW - 1 } } }, NOW, true).gameMode.on, false);
  assert.deepEqual(gpuSummary(host.gpu.status(), { gpu: { gameMode: { until: -1 } } }, NOW, false).gameMode, { on: true, until: -1 });
  const sum = hostSummary({ hooks: { a: { openSessions: 2, errors: 1 }, b: { openSessions: 1, errors: 0 } }, claims: { conflicts: [1], live: { claimed: 3 } }, startedAt: NOW - 1000 }, NOW);
  assert.deepEqual({ open: sum.breakersOpen, err: sum.hookErrors, c: sum.conflicts, up: sum.uptimeMs }, { open: 3, err: 1, c: 1, up: 1000 });
});

test('记忆浏览：按场合 / 按人筛只传给认这些条件的列表；隐藏和忘掉的列表补上种类和开头；身份证据的哈希只留开头', async () => {
  const s = setup();
  await s.view('memories', { list: 'assertions', settingKey: 'sk-web', entityId: '10', q: '快递', state: 'hidden' });
  let q = s.callsOf('admin.list').filter((c) => c.args[0].view === 'assertions').at(-1).args[0];
  assert.deepEqual({ ...q, limit: undefined }, { view: 'assertions', limit: undefined, q: '快递', state: 'hidden', settingKey: 'sk-web', entityId: 10 });
  await s.view('memories', { list: 'windows', settingKey: 'sk-web', entityId: '10', state: 'hidden' });
  q = s.callsOf('admin.list').filter((c) => c.args[0].view === 'windows').at(-1).args[0];
  assert.deepEqual(Object.keys(q).sort(), ['limit', 'settingKey', 'view'], '原文片段不按人筛、没有状态');
  await s.view('memories', { list: 'entities', settingKey: 'sk-web' });
  q = s.callsOf('admin.list').filter((c) => c.args[0].view === 'entities').at(-1).args[0];
  assert.equal(q.settingKey, undefined);
  const sup = (await s.view('memories', { list: 'suppressed' })).body.data;
  assert.ok(sup.items.length > 0);
  assert.ok(sup.items.every((x) => x.kind && 'preview' in x));
  // 夜里改过的（D122）：默认只列改了的，all=1 连没问题的也列；不按场合、按人筛
  await s.view('memories', { list: 'checks', settingKey: 'sk-web', entityId: '10' });
  q = s.callsOf('admin.list').filter((c) => c.args[0].view === 'checks').at(-1).args[0];
  assert.deepEqual({ ...q, limit: undefined }, { view: 'checks', limit: undefined, changed: true });
  await s.view('memories', { list: 'checks', all: '1' });
  assert.equal(s.callsOf('admin.list').filter((c) => c.args[0].view === 'checks').at(-1).args[0].changed, false);
  assert.equal((await s.view('memories', { list: 'nope' })).status, 400);
  assert.equal((await s.view('memories', { list: 'assertions', limit: '0' })).status, 400);
  assert.equal((await s.view('memories', { list: 'assertions', entityId: 'x' })).status, 400);
  const get = s.pm.admin.get;
  s.pm.admin.get = (ref) => ({ ...get(ref), identity: [{ namespace: 'qq', scope: null, idHash: 'abcdef0123456789abcdef', strength: 'platform', at: 1 }] });
  const d = (await s.view('memory', { ref: 'n10' })).body.data.detail;
  assert.deepEqual(d.identity, [{ namespace: 'qq', scope: null, strength: 'platform', hash: 'abcdef01', at: 1 }]);
});

test('审核队列：挂起的发言按令牌对上原文、她的转念和命中的理由；需要你知道默认只看未读', async () => {
  const s = setup();
  const r = (await s.view('review')).body.data;
  const held = r.items.find((x) => x.kind === 'held_utterance');
  assert.match(held.hold.text, /恭喜阿明/);
  assert.ok(held.hold.reasons.includes('public-mentions-person'));
  assert.equal(held.hold.settingKey, 'sk-comments');
  assert.equal(r.settings['sk-comments'], '投稿评论区');
  assert.equal(r.names[13], '小雨');
  assert.equal((await s.view('review', { kind: 'merge' })).body.data.items.length, 1);
  assert.equal((await s.view('review', { kind: 'bogus' })).status, 400);
  const n = (await s.view('needToKnow')).body.data;
  assert.equal(n.total, 6);
  assert.ok(n.items.every((x) => x.status === 'open'));
  assert.equal((await s.view('needToKnow', { status: 'all' })).body.data.total, 7);
});

test('场合视图：给出适配器报上来的属性、生效档和覆盖、别记；不带账号', async () => {
  const s = setup();
  const d = (await s.view('settings')).body.data;
  const big = d.items.find((x) => x.key === 'sk-group-big');
  assert.equal(big.audience.size, 420);
  assert.equal(big.audience.herModerates, true);
  assert.equal(big.oneOnOne, false);
  assert.equal(d.items.find((x) => x.key === 'sk-private-owner').oneOnOne, true);
  assert.deepEqual(d.items.find((x) => x.key === 'sk-group-small').override, { ruleId: 4, mode: 'live' });
  assert.equal(d.items.find((x) => x.key === 'sk-thread').doNotRemember, true);
  assert.equal(d.defaults.byAttributes.public, 'live');
});

test('场合视图（D111）：名字从哪来、没名字的带区分提示（几个没名字的群分得开）、入口名不是原始 id、从没收到过东西的如实标出来', async () => {
  const s = setup();
  const d = (await s.view('settings')).body.data;
  const by = (k) => d.items.find((x) => x.key === k);
  const a = by('sk-group-noname');
  const b = by('sk-group-noname2');
  assert.deepEqual([a.label, a.labelKind, a.labelSource, a.adapterName], ['一个 QQ 群', 'description', 'adapter', 'QQ']);
  assert.notEqual(a.title, b.title, '两个没名字的群在管理页上分得开');
  assert.equal(a.title, '一个 QQ 群（9 人 · Hk4p）');
  assert.equal(by('sk-group-small').title, '摸鱼小群', '有名字的不带提示');
  const r = by('sk-group-renamed');
  assert.deepEqual([r.label, r.labelSource, r.ownerLabel, r.adapterLabel, r.adapterLabelKind], ['数字游戏群', 'owner', '数字游戏群', '一个 QQ 群', 'description']);
  const web = by('sk-web');
  assert.equal(web.adapterName, 'DSH 网页');
  // D112：网页这一行由选了插件预设的会话接上（会话数只在这一行显示，页面那边按 adapter 判断）
  assert.deepEqual([web.adapter, web.reception.state, web.reception.sessions, web.reception.percepts], ['dsh-web', 'ok', 3, 26]);
  // 插件预设不在下拉里、从没收到过：「生效：开」不等于真的有东西进来，原因是入口报的那句
  const bad = (await setup({ scenario: 'errors' }).view('settings')).body.data.items.find((x) => x.key === 'sk-web');
  assert.equal(bad.reception.state, 'never', '「生效：开」不等于真的有东西进来');
  assert.match(bad.reception.reason, /预设现在不在新建任务的列表里/);
  assert.equal(by('sk-group-small').reception.state, 'ok');
  assert.equal(by('sk-comments').adapterName, 'bili', '不认识的入口照原样');
  // 别的列表页的场合名字表也用带提示的那个
  const rules = (await s.view('rules')).body.data;
  assert.equal(rules.settings['sk-group-noname'], '一个 QQ 群（9 人 · Hk4p）');
});

test('分寸（D113）：被拦下的话只有依据不含原文、按依据筛；她在守的叮嘱可以解除；总览的「误拦观察」有数字', async () => {
  const s = setup();
  const r = await s.view('discretion');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  // 默认只列现在的规则拦下的（D119）；旧规则的折成一行摘要，点开才列
  assert.equal(d.basis, 'current');
  assert.ok(!d.blocked.items.some((x) => x.basis === 'legacy'), '默认不列旧规则');
  assert.deepEqual([...new Set(d.blocked.items.map((x) => x.basis))].sort(), ['guard', 'public']);
  assert.ok(d.legacy && d.legacy.total > 0, '旧规则只给条数');
  const lg = (await s.view('discretion', { basis: 'legacy' })).body.data;
  assert.ok(lg.blocked.items.length > 0 && lg.blocked.items.every((x) => x.basis === 'legacy'));
  assert.equal(lg.legacy, null);
  for (const x of d.blocked.items) assert.ok(!('text' in x) && !('heldText' in x), '不显示原文');
  const g = await s.view('discretion', { basis: 'guard' });
  assert.deepEqual(g.body.data.blocked.items.map((x) => x.kind), ['relay', 'secret']);
  assert.equal((await s.view('discretion', { basis: 'nope' })).status, 400);
  assert.deepEqual(d.limits.items.map((x) => x.ref), ['p12', 'a15']);
  const rel = await s.act('limit.relax', { ref: 'p12' });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.equal(rel.body.result.applied, true);
  assert.deepEqual(s.callsOf('admin.relaxLimit').map((c) => c.args[0]), ['p12']);
  assert.deepEqual((await s.view('discretion')).body.data.limits.items.map((x) => x.ref), ['a15']);
  const o = (await s.view('overview')).body.data;
  assert.equal(o.misblock.guard, 2, '今天外发守护挡下的两句');
  assert.equal(typeof o.misblock.legacy, 'number');
});

// ── 后台花费（D120） ────────────────────────────────────────────────────

test('预算摘要接的是真的 BudgetPort 的形状：页面读的每个字段都有值（以前长名字 / 短名字对不上也看不出来）', async () => {
  const { makeRealBudget } = await import('./fixtures.js');
  const real = makeRealBudget({ core: { budget: { preset: 'loose' } }, now: NOW, days: 14 });
  const b = budgetSummary(JSON.parse(JSON.stringify(real.status())), { embedding: { provider: 'ollama-native', url: 'http://127.0.0.1:11434' } });
  // page.html 的 budgetBlock / costCard / guardCard 读的字段
  for (const k of ['calls', 'uncached', 'cached', 'out', 'review', 'bgYuan', 'bgPeakYuan', 'mainYuan', 'acctYuan', 'failed', 'denied', 'day']) assert.notEqual(b.today[k], null, `today.${k}`);
  for (const k of ['dailyCalls', 'dailyUncachedTokens', 'dailyOutputTokens', 'egressReservePerDay', 'perSourceShare', 'balanceProtectDays']) assert.notEqual(b.limits[k], null, `limits.${k}`);
  for (const k of ['ratioToMain', 'shareOfAccount', 'prices']) assert.notEqual(b[k], null, k);
  assert.ok(b.today.uncached > 0 && b.today.out > 0);
  const ex = b.today.byUse.extract;
  assert.ok(ex.calls > 0 && ex.failed === 1 && ex.in > 0 && ex.yuan > 0, '每个用途：次数、失败、token、元');
  assert.deepEqual(b.today.deniedBy, [{ use: 'extract', why: 'source', n: 2 }]);
  assert.equal(b.history.length, 14);
  assert.ok(b.history.every((h) => h.bgYuan > 0 && h.mainYuan > 0 && h.byUse?.sleep?.calls === 8));
  assert.equal(b.recent.days.length, 15, '最近 30 天：14 天历史 + 今天');
  assert.equal(b.recent.days.at(-1).today, true);
  const t = b.recent.total;
  assert.ok(Math.abs(t.bgYuan - b.recent.days.reduce((a, d) => a + d.bgYuan, 0)) < 0.001);
  assert.ok(t.ratioToMain > 0 && t.ratioToMain < 1 && t.shareOfAccount > 0 && t.shareOfAccount < t.ratioToMain);
  assert.deepEqual(b.embedding, { provider: 'ollama-native', local: true });
  assert.equal(budgetSummary(real.status(), { embedding: { provider: 'openai-compat', url: 'https://api.example.com/v1' } }).embedding.local, false);
});

test('预算摘要也认 D120 以前的形状：byUse 只有次数、历史只有元', () => {
  const b = budgetSummary({ today: { day: '2026-11-08', calls: 3, uncachedTokens: 1002, byUse: { glance: 3, 'bad key!': 1 }, bgYuan: 0.0017, mainYuan: 0.0359, acctYuan: 0.0359 },
    history: [{ day: '2026-11-07', bgYuan: 0.4842, mainYuan: 3.7229, acctYuan: 4.2259 }] });
  assert.deepEqual(b.today.byUse, { glance: { calls: 3, failed: 0, estimated: 0, in: null, cached: null, out: null, yuan: null, partial: true } });
  assert.deepEqual(b.history[0], { day: '2026-11-07', calls: null, failed: null, in: null, cached: null, out: null, bgYuan: 0.4842, bgPeakYuan: null, mainYuan: 3.7229, acctYuan: 4.2259, denied: null });
  assert.equal(b.recent.total.bgYuan, 0.4859);
  assert.equal(b.recent.total.acctYuan, 4.2618);
  assert.equal(b.prices, null);
  assert.equal(b.embedding, null);
});

test('设置、总览、诊断都带后台花费；页面给每个后台用途起了名字（不显示代码）', async () => {
  const s = setup();
  const c = (await s.view('config')).body.data;
  assert.equal(c.budgetPreset, 'loose');
  assert.ok(c.budget.recent.days.length > 1);
  assert.ok(Object.keys(c.budget.today.byUse).length >= 5);
  assert.deepEqual(c.budget.embedding, { provider: 'ollama-native', local: true });
  const o = (await s.view('overview')).body.data;
  assert.ok(o.budget.today.bgYuan > 0 && o.budget.ratioToMain > 0);
  const d = (await s.view('diagnostics')).body.data;
  assert.ok(d.budget.limits.dailyCalls > 0);
  const e = (await setup({ scenario: 'empty' }).view('config')).body.data;
  assert.deepEqual(e.budget.today.byUse, {});
  assert.equal(e.budget.recent.days.length, 1);
  const fs = await import('node:fs');
  const page = fs.readFileSync(new URL('../../src/admin/page.html', import.meta.url), 'utf8');
  const { BG_USES } = await import('../../src/ports/budget.js');
  const m = page.match(/const USE = \{([^}]*)\}/);
  assert.ok(m, 'page.html 里有 USE 表');
  for (const u of BG_USES) assert.match(m[1], new RegExp(`(?:^|[\\s,])${u}: '[^']+'`), `用途 ${u} 有中文名`);
  assert.ok(page.includes('调用都走 DSH 的模型通道、用的是 DSH 账号余额；向量在本机算，不花钱'));
});

// ── 花费护栏：三档预设和自定义（D121） ──────────────────────────────────

test('花费护栏的数据：三档每一项的值（每天输出按宿主每档的数）、改过的项、生效的值；不合法的改动不算', () => {
  const v = budgetConfigView({ budget: { preset: 'saving', overrides: { dailyCalls: 1200, rerank: false, bogus: 1, perSourceShare: 7 } } },
    { budget: { dailyOutputTokens: { loose: 1_000_000, saving: 300_000 } } });
  assert.equal(v.preset, 'saving');
  assert.equal(v.custom, true);
  assert.deepEqual(v.overrides, { dailyCalls: 1200, rerank: false }, '不认识的键、越界的值不算改过');
  assert.deepEqual(v.keys, ['dailyCalls', 'dailyUncachedTokens', 'dailyOutputTokens', 'perSourceShare', 'mainChatRatioCap', 'balanceProtectDays', 'stage2Scope', 'prefetchRewrite', 'rerank', 'sleepDepth',
    'injectShare', 'injectPerSessionPerDay']);
  assert.deepEqual(v.presets.loose, { dailyCalls: 3000, dailyUncachedTokens: 5_000_000, dailyOutputTokens: 1_000_000, perSourceShare: 0.5, mainChatRatioCap: null,
    balanceProtectDays: 1, stage2Scope: 'all', prefetchRewrite: true, rerank: true, sleepDepth: 'full', injectShare: 0.25, injectPerSessionPerDay: 40_000 });
  assert.deepEqual(v.presets.unlimited, { dailyCalls: null, dailyUncachedTokens: null, dailyOutputTokens: null, perSourceShare: 1, mainChatRatioCap: null,
    balanceProtectDays: 1, stage2Scope: 'all', prefetchRewrite: true, rerank: true, sleepDepth: 'full', injectShare: null, injectPerSessionPerDay: null });
  // 注入预算（D133）：节省档是原来的数
  assert.deepEqual([v.presets.saving.injectShare, v.presets.saving.injectPerSessionPerDay], [0.05, 8000]);
  assert.deepEqual([v.effective.injectShare, v.effective.injectPerSessionPerDay], [0.05, 8000]);
  assert.equal(v.effective.dailyCalls, 1200);
  assert.equal(v.effective.dailyOutputTokens, 300_000);
  assert.equal(v.effective.rerank, false);
  assert.equal(v.ranges.dailyCalls.min, 50);
  // 没有配置：按宽松、没改过
  const d = budgetConfigView({}, null);
  assert.equal(d.preset, 'loose');
  assert.equal(d.custom, false);
  assert.equal(d.presets.loose.dailyOutputTokens, null, '宿主没给每天输出的上限 = 不设');
});

test('花费护栏的校验：范围、整数、枚举；不设上限只给上限类和比例上限', () => {
  assert.equal(budgetValue('dailyCalls', null), null);
  assert.equal(budgetValue('dailyCalls', 50), 50);
  assert.throws(() => budgetValue('dailyCalls', 49), /50–1,000,000 的整数/);
  assert.throws(() => budgetValue('dailyCalls', 100.5), /整数/);
  assert.throws(() => budgetValue('dailyUncachedTokens', 99_999), /100,000/);
  assert.equal(budgetValue('perSourceShare', 0.333333), 0.333);
  assert.throws(() => budgetValue('perSourceShare', null), /5%–100%/);
  assert.throws(() => budgetValue('perSourceShare', 0.01), /5%–100%/);
  assert.equal(budgetValue('mainChatRatioCap', null), null);
  assert.equal(budgetValue('mainChatRatioCap', 2.5), 2.5);
  assert.throws(() => budgetValue('mainChatRatioCap', 11), /1000%/);
  assert.equal(budgetValue('balanceProtectDays', 0), 0);
  assert.throws(() => budgetValue('balanceProtectDays', 31), /0–30/);
  assert.throws(() => budgetValue('balanceProtectDays', null), /0–30/);
  assert.equal(budgetValue('sleepDepth', 'essential'), 'essential');
  assert.throws(() => budgetValue('sleepDepth', 'half'), /full \/ essential/);
  assert.throws(() => budgetValue('rerank', 1), /true \/ false/);
  assert.throws(() => budgetValue('egressReservePerDay', 5), /不认识/);
  // 注入预算（D133）：比例 1%–100% 或不限；每天的字数 1000 起或不限
  assert.equal(budgetValue('injectShare', null), null);
  assert.equal(budgetValue('injectShare', 0.25), 0.25);
  assert.throws(() => budgetValue('injectShare', 0), /1%–100%，或不设/);
  assert.throws(() => budgetValue('injectShare', 1.2), /1%–100%/);
  assert.equal(budgetValue('injectPerSessionPerDay', null), null);
  assert.equal(budgetValue('injectPerSessionPerDay', 20_000), 20_000);
  assert.throws(() => budgetValue('injectPerSessionPerDay', 999), /1,000–10,000,000 的整数/);
  assert.throws(() => budgetValue('injectPerSessionPerDay', 1500.5), /整数/);
});

test('花费护栏的风险：和现在生效的比，只提真的变了的', () => {
  const cur = budgetConfigView({ budget: { preset: 'loose', overrides: {} } }, { budget: { dailyOutputTokens: { loose: 1_000_000, saving: 300_000 } } });
  assert.deepEqual(budgetRisks(cur, { preset: 'saving', overrides: { dailyCalls: 900 } }), []);
  assert.equal(budgetRisks(cur, { preset: 'unlimited', overrides: {} }).length, 1, '换成不设上限只说一句（不再逐项说去掉了哪些上限）');
  assert.deepEqual(budgetRisks(cur, { preset: 'loose', overrides: { dailyOutputTokens: null, balanceProtectDays: 0 } }),
    ['去掉每天输出的上限：程序失控时不会被拦住', '关掉余额保护：余额被后台用完时她的聊天也会停']);
  const already = budgetConfigView({ budget: { preset: 'unlimited', overrides: { balanceProtectDays: 0 } } }, null);
  assert.deepEqual(budgetRisks(already, { preset: 'unlimited', overrides: { balanceProtectDays: 0, rerank: false } }), []);
});

test('预算摘要：不设上限的项写 none（页面写「不设上限」，不画进度条）；自定义标出来', () => {
  const b = budgetSummary({ preset: 'unlimited', custom: true, limits: { dailyCalls: Infinity, dailyUncachedTokens: Infinity, dailyOutputTokens: 2_000_000, perSourceShare: 1, mainChatRatioCap: null, balanceProtectDays: 1 } });
  assert.equal(b.custom, true);
  assert.deepEqual([b.limits.dailyCalls, b.limits.dailyUncachedTokens, b.limits.dailyOutputTokens, b.limits.perSourceShare, b.limits.mainChatRatioCap], ['none', 'none', 2_000_000, 1, null]);
  assert.equal(budgetSummary({ limits: { dailyCalls: NaN } }).limits.dailyCalls, null, '读不出来的还是 null');
});
