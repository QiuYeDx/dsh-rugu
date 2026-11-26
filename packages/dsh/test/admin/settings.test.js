// 「设置」和首次设置（D173）：新的视图和动作（权限、参数校验、写到了对的地方、配置文件坏了时拒绝）、花费档位的「上限」算法、
// 诊断页「自查」的每一项结论、桥接模式的检查、首次设置的草稿和新旧开关、没装 Ollama 时向导的默认、没走完设置时预设的提醒、自检文案不再有内部说法。
// 真实的模型「试一下」一次都不调（假的宿主）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DEFAULTS } from 'rugu-core';
import { ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { costCeiling, recentAverage, checkupItems, diagSummary, costTiers, PER_CALL } from '../../src/admin/settings-views.js';
import { renderNextPage } from '../../src/admin/page.js';
import { createAdminHandlers } from '../../src/admin/index.js';
import { HOST_DEFAULTS, createConfigStore } from '../../src/host/config.js';
import { bridgeMode } from '../../src/host/bridge-setup.js';
import { presetSettings, SETUP_NAME_SUFFIX, SETUP_NOTICE } from '../../src/preset/index.js';
import { lexJs } from '../../../../scripts/check-boundaries.mjs';
import { makeFakeHost, NOW, wizardPreviewDraft, WIZARD_VARIANTS } from './fixtures.js';
import { setup, ORIGIN, TOKEN } from './helpers.js';

const PRICES = HOST_DEFAULTS.budget.prices;
const presetLimits = (k) => ({ ...DEFAULTS.budget.presets[k], dailyOutputTokens: HOST_DEFAULTS.budget.dailyOutputTokens[k] ?? null,
  egressReservePerDay: DEFAULTS.budget.egressReservePerDay, glanceReservePerDay: DEFAULTS.budget.glanceReservePerDay });

test('花费档位的「上限」：按每天的用量上限和价目算最坏一天（空闲 / 高峰），预留另算；和 docs/花费.md 第 5 节的预设表对得上', () => {
  // 预设表：平衡 3000 次 / 500 万 / 100 万；节省 600 次 / 100 万 / 30 万；效果优先不设
  assert.deepEqual([DEFAULTS.budget.presets.loose.dailyCalls, DEFAULTS.budget.presets.loose.dailyUncachedTokens, HOST_DEFAULTS.budget.dailyOutputTokens.loose], [3000, 5_000_000, 1_000_000]);
  assert.deepEqual([DEFAULTS.budget.presets.saving.dailyCalls, DEFAULTS.budget.presets.saving.dailyUncachedTokens, HOST_DEFAULTS.budget.dailyOutputTokens.saving], [600, 1_000_000, 300_000]);
  // 价目：命中 0.02、未命中 1、输出 4 元 / 百万，高峰 ×2
  assert.deepEqual([PRICES.hit, PRICES.miss, PRICES.out, PRICES.peakFactor], [0.02, 1, 4, 2]);
  const loose = costCeiling(presetLimits('loose'), PRICES);
  // 500 万 × 1 + 100 万 × 4 + 3000 次 × 1 万 × 0.02 = 5 + 4 + 0.6
  assert.equal(loose.capped, true);
  assert.equal(loose.offPeak, 9.6);
  assert.equal(loose.peak, 19.2);
  // 预留：提炼 600 次 × (8000 × 1 + 4000 × 4) + 第一眼 150 × (2700 + 600 × 4) + 审视 100 × (1500 + 260 × 4)，单位百万 token
  const reserve = (600 * (8000 + 4000 * 4) + 150 * (2700 + 600 * 4) + 100 * (1500 + 260 * 4)) / 1e6;
  assert.equal(loose.reserveOffPeak, Math.round(reserve * 100) / 100);
  assert.deepEqual(loose.reserveCalls, { extract: 600, glance: 150, review: 100 });
  const saving = costCeiling(presetLimits('saving'), PRICES);
  assert.equal(saving.offPeak, 2.32);   // 1 + 1.2 + 600 × 1 万 × 0.02
  assert.equal(saving.peak, 4.64);
  assert.equal(saving.reserveCalls.extract, 120);
  assert.equal(costCeiling(presetLimits('unlimited'), PRICES).capped, false, '效果优先不设每天的上限');
  // 自定义：去掉调用次数的上限 → 命中缓存那部分封不了顶，如实标出来
  const open = costCeiling({ ...presetLimits('loose'), dailyCalls: null }, PRICES);
  assert.equal(open.cachedOpen, true);
  assert.equal(open.offPeak, 9);
  // 价目读不出来就不算
  assert.equal(costCeiling(presetLimits('loose'), {}).capped, null);
  assert.ok(PER_CALL.extract.out === 4000 && PER_CALL.glance.out === 600 && PER_CALL.review.out === 260, '每次的输出上限和花费.md 的表一致');
});

test('花费档位卡：不认识价目的模型只说「按次数和用量管」；最近 7 天平均只取今天之前 7 天里有记账的日子', () => {
  const bc = { preset: 'loose', custom: false, presets: { saving: presetLimits('saving'), loose: presetLimits('loose'), unlimited: presetLimits('unlimited') } };
  const bud = { priceKnown: false, prices: PRICES, limits: { egressReservePerDay: 100 }, today: { day: '2026-11-13' }, history: [{ day: '2026-11-12', bgYuan: 0.4, calls: 100 }] };
  const t = costTiers(bc, bud, HOST_DEFAULTS);
  assert.ok(t.tiers.every((x) => x.ceiling.unpriced === true));
  assert.equal(t.recent.yuan, null, '不认识价目时不说钱');
  assert.equal(t.recent.calls, 100);
  const r = recentAverage({ today: { day: '2026-11-13' }, history: [
    { day: '2026-11-13', bgYuan: 9, calls: 9 }, { day: '2026-11-12', bgYuan: 0.3, calls: 10 }, { day: '2026-11-10', bgYuan: 0.5, calls: 30 }, { day: '2026-11-05', bgYuan: 0.1, calls: 1 }, { day: '2026-11-04', bgYuan: 50, calls: 1 }] });
  assert.deepEqual(r, { days: 2, yuan: 0.4, calls: 20 }, '今天、8 天前（11/5）和更早的不算；没有记账的日子不算 0');
  assert.equal(recentAverage({ today: { day: '2026-11-13' }, history: [] }), null, '没有数据就不显示');
  assert.equal(recentAverage({ today: { day: '2026-01-02' }, history: [{ day: '2025-12-31', bgYuan: 1, calls: 1 }] }).days, 1, '跨年也对');
});

test('自查：各种状态下每一项的结论和去哪儿修；有问题的排在前面', () => {
  const base = { store: { readOnly: false }, mode: { global: 'live', byAttributes: { principalOneOnOne: 'live', closed: 'live', public: 'live' } }, places: { total: 3, off: 0 },
    entries: [{ adapter: 'qq', connected: true, lastAt: 1, injectedAt: 2 }, { adapter: 'dsh-web', connected: true, lastAt: null }],
    preset: { enabled: true, registered: true, listed: true, name: '人设聊天' }, qq: { configured: true, isBridge: true, secondGen: true, whitelist: { readable: true, patched: true } },
    embedding: { off: false, dense: true }, llm: { state: 'ok' }, budget: { paused: false, capped: 0 }, selfCheck: { failed: 0 } };
  const by = (x) => Object.fromEntries(checkupItems(x).map((i) => [i.key, i]));
  const ok = by(base);
  assert.equal(ok.store.state, 'ok');
  assert.equal(ok['entry.qq'].state, 'ok');
  assert.equal(ok['entry.qq'].heardAt, 1);
  assert.equal(ok['entry.dsh-web'].state, 'warn');
  assert.match(ok['entry.dsh-web'].text, /人设聊天/);
  assert.equal(checkupItems(base)[0].key, 'entry.dsh-web', '有问题的在最前');
  const cases = [
    [{ setup: { needed: true } }, 'setup', 'bad', 'wizard'],
    [{ store: { readOnly: true, newer: true } }, 'store', 'bad', 'settings/diag?dev=1'],
    [{ store: { error: 'X' } }, 'store', 'bad', 'settings/diag?dev=1'],
    [{ mode: { global: 'off' } }, 'master', 'bad', 'settings/basic'],
    [{ mode: { global: 'live', byAttributes: { public: 'off' } } }, 'master', 'warn', 'settings/basic'],
    [{ places: { total: 2, off: 2 } }, 'places', 'warn', 'places/list'],
    [{ places: { total: 5, off: 1 } }, 'places', 'dim', 'places/list'],
    [{ preset: { enabled: true, registered: false } }, 'preset', 'bad', 'settings/diag?dev=1'],
    [{ preset: { enabled: true, registered: true, broken: true } }, 'preset', 'bad', 'settings/diag?dev=1'],
    [{ qq: { configured: false } }, 'qq', 'dim', 'settings/connect'],
    [{ qq: { configured: true, isBridge: true, secondGen: false } }, 'qq', 'bad', 'settings/connect'],
    [{ qq: { configured: true, isBridge: true, secondGen: true, whitelist: { readable: true, patched: false } } }, 'qq', 'warn', 'settings/connect'],
    [{ qq: { configured: true, isBridge: false } }, 'qq', 'bad', 'settings/connect'],
    [{ embedding: { off: true } }, 'embedding', 'dim', 'settings/models'],
    [{ embedding: { dense: false, breakerOpen: true } }, 'embedding', 'warn', 'settings/models'],
    [{ embedding: { dense: true, suspect: true } }, 'embedding', 'bad', 'settings/models'],
    [{ llm: { state: 'down', reason: '连不上' } }, 'llm', 'bad', 'settings/models'],
    [{ llm: { state: 'down', fallback: { provider: 'p', model: 'm' } } }, 'llm', 'warn', 'settings/models'],
    [{ llm: { state: 'off' } }, 'llm', 'dim', 'settings/models'],
    [{ llm: { state: 'flaky' } }, 'llm', 'warn', 'settings/models'],
    [{ budget: { paused: true } }, 'budget', 'bad', 'settings/cost'],
    [{ budget: { capped: 12 } }, 'budget', 'warn', 'settings/cost'],
    [{ budget: { capped: 0, sourceCapped: 3 } }, 'budget', 'dim', 'settings/cost'],
    [{ selfCheck: { failed: 2 } }, 'selfcheck', 'warn', 'settings/diag?dev=1'],
  ];
  for (const [patch, key, state, to] of cases) {
    const it = by({ ...base, ...patch })[key];
    assert.equal(it?.state, state, `${key} ${JSON.stringify(patch)}`);
    assert.equal(it.fix?.to, to, `${key} 去哪儿修`);
  }
  assert.match(by({ ...base, qq: { configured: true, isBridge: true, secondGen: false } }).qq.title, /不是二代模式/);
  // 结论里没有内部说法、英文的配置值
  const all = cases.flatMap(([p]) => checkupItems({ ...base, ...p })).map((i) => `${i.title}${i.text ?? ''}`).join('\n');
  for (const bad of ['L3', 'off', 'live', 'fail closed', '第一眼', '提炼', '嵌入', '§']) assert.ok(!all.includes(bad), bad);
});

test('诊断视图：自查、复制诊断信息不含任何聊天内容、名字、群名、账号、路径', async () => {
  const s = setup();
  const r = await s.view('setDiag');
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.ok(d.checkup.length > 5);
  assert.ok(d.checkup.find((x) => x.key === 'entry.qq')?.injectedAt, '最近一次把记忆放进对话的时间（不算常驻区）');
  const text = JSON.stringify(d.summary);
  for (const bad of ['阿明', '摸鱼小群', 'persona-memory', 'C:\\\\', 'D:\\\\', 'someone', '云云']) assert.ok(!text.includes(bad), bad);
  assert.equal(d.summary.kind, 'rugu-diagnostics');
  assert.equal(diagSummary({ checkup: [{ key: 'a', state: 'ok', title: '不应该出现' }] }).checkup[0].title, undefined);
});

test('人设和称呼：读、写到宿主配置的对的地方、校验；配置文件读不了时拒绝；没有写接口时 503', async () => {
  const s = setup();
  const v = (await s.view('setBasic')).body.data;
  assert.equal(v.who.principalLabel, '主人');
  assert.deepEqual(v.who.selfNames, ['云云', '小云']);
  assert.equal(v.who.presetDefault, '人设聊天');
  assert.equal(v.who.prefixMax, 2000);
  const r = await s.act('persona.save', { principalLabel: '老板', selfNames: '阿云、 云宝,小云', presetName: '和她聊', personaPrefix: '第一行\r\n第二行' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const patch = s.hostCallsOf('config.set').at(-1).args[0];
  assert.deepEqual(patch, { host: { self: { principalLabel: '老板' }, adapters: { qq: { selfNames: ['阿云', '云宝', '小云'] } }, preset: { name: '和她聊', personaPrefix: '第一行\n第二行' } } });
  const v2 = (await s.view('setBasic')).body.data;
  assert.deepEqual(v2.who.selfNames, ['阿云', '云宝', '小云'], '名字列表整个换掉，不和原来的合并');
  // 清空 = 回到默认
  assert.equal((await s.act('persona.save', { presetName: '' })).status, 200);
  assert.equal(s.hostCallsOf('config.set').at(-1).args[0].host.preset.name, '');
  // 校验
  for (const [body, p] of [[{}, 'body'], [{ personaPrefix: 'x'.repeat(2001) }, 'personaPrefix'], [{ personaPrefix: 'a\u0007b' }, 'personaPrefix'], [{ principalLabel: 'x'.repeat(21) }, 'principalLabel'],
    [{ selfNames: Array.from({ length: 17 }, (_, i) => `名${i}`) }, 'selfNames'], [{ nope: 1 }, 'body.nope']]) {
    const e = await s.act('persona.save', body);
    assert.equal(e.status, 400, JSON.stringify(body));
    assert.equal(e.body.path, p);
  }
  // 配置文件读不了：不往里写
  const host = makeFakeHost();
  const get0 = host.config.get;
  host.config.get = () => ({ ...get0(), loadError: 'SyntaxError' });
  const s2 = setup({ host });
  const bad = await s2.act('persona.save', { principalLabel: '老板' });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'CONFIG_WRITE');
  assert.equal(s2.hostCallsOf('config.set').length, 0);
  assert.equal((await s2.view('setBasic')).body.data.canWrite, false);
  const host3 = makeFakeHost();
  delete host3.config.set;
  assert.equal((await setup({ host: host3 }).act('persona.save', { principalLabel: '老板' })).status, 503);
  // 没有管理页令牌：403
  const res = await s.h.act(new Request(`${ORIGIN}${ROUTES.act}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ action: 'persona.save', principalLabel: 'x' }) }));
  assert.equal(res.status, 403);
});

test('她自己的 QQ 号、评估不了时怎么办：校验、写到对的地方', async () => {
  const s = setup();
  assert.equal((await s.act('qq.selfAccount', { account: '12345678' })).status, 200);
  assert.deepEqual(s.hostCallsOf('config.set').at(-1).args[0], { host: { adapters: { qq: { selfAccount: '12345678' } } } });
  assert.equal((await s.act('qq.selfAccount', { account: '' })).status, 200, '清空 = 让插件自己认');
  for (const a of ['0123456', '1234', 'abc12345', '1234567890123', 12345678]) assert.equal((await s.act('qq.selfAccount', { account: a })).status, 400, String(a));
  const c = (await s.view('setConnect')).body.data;
  assert.equal(c.qq.selfAccount.recognized, true);
  assert.equal(c.qq.bridge.current.mode.secondGen, true);
  assert.ok(!JSON.stringify(c).includes('12345678'), '认出来的账号不往页面上送（只有配置里写的才显示）');
  assert.equal((await s.view('setModels')).body.data.onFailure, 'give', '默认照给');
  assert.equal((await s.act('discretion.onFailure', { value: 'omit' })).status, 200);
  assert.deepEqual(s.hostCallsOf('config.set').at(-1).args[0], { discretion: { stage2: { onFailure: 'omit' } } });
  assert.equal((await s.view('setModels')).body.data.onFailure, 'omit');
  assert.equal((await s.act('discretion.onFailure', { value: 'never' })).status, 400);
});

test('桥接的模式：读 state/mode.json（和 QQ 适配器同一个投影）；不是二代模式时说出来；读不到 = 说不准', () => {
  const dir = fs.mkdtempSync(path.join(process.env.PM_TEST_TMP ?? os.tmpdir(), 'pm-bridge-mode-'));
  try {
    assert.deepEqual(bridgeMode(dir), { value: null, secondGen: null, readable: false });
    fs.mkdirSync(path.join(dir, 'state'));
    for (const [raw, want] of [['reserved2', true], ['simulation', true], ['chat', false], ['reserved', false], ['closed-agent', false]]) {
      fs.writeFileSync(path.join(dir, 'state', 'mode.json'), JSON.stringify({ mode: raw }));
      assert.equal(bridgeMode(dir).secondGen, want, raw);
    }
    fs.writeFileSync(path.join(dir, 'state', 'mode.json'), '{坏了');
    assert.equal(bridgeMode(dir).readable, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('首次设置的草稿：只在设置模式下存、写进 host.setup.draft；设置完了拒绝；参数校验', async () => {
  // 设置模式：只开向导要的那几条
  const host = makeFakeHost({ scenario: 'wiz' });
  const h = createAdminHandlers({ pm: null, host, setupMode: true, token: TOKEN, now: () => NOW });
  const hdr = { [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'same-origin' };
  const act = async (action, body) => { const r = await h.act(new Request(`${ORIGIN}${ROUTES.act}`, { method: 'POST', headers: { ...hdr, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) })); return { status: r.status, body: await r.json() }; };
  const view = async (v) => { const r = await h.data(new Request(`${ORIGIN}${ROUTES.data}?view=${v}`, { headers: hdr })); return { status: r.status, body: await r.json() }; };
  const w = await view('wizard');
  assert.equal(w.status, 200);
  assert.equal(w.body.data.needed, true);
  const draft = { step: 3, ack: true, principalLabel: '老板', selfNames: ['阿云'], personaPrefix: '一段人设', embed: 'none', offGroups: ['10002'], selfAccount: '12345678', llmSkipped: false };
  const r = await act('setup.draft', { draft });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(host.calls.find((c) => c.name === 'setup.saveDraft').args[0], draft);
  assert.deepEqual((await view('wizard')).body.data.draft, draft, '重新打开回到上次那一步');
  for (const bad of [{ step: 9 }, { embed: 'x' }, { offGroups: ['a b'] }, { selfAccount: '12' }, { nope: 1 }, { personaPrefix: 'x'.repeat(2001) }]) {
    assert.equal((await act('setup.draft', { draft: bad })).status, 400, JSON.stringify(bad));
  }
  // 设置模式下别的设置视图和动作都不开
  assert.equal((await view('setBasic')).status, 503);
  assert.equal((await act('persona.save', { principalLabel: 'x' })).status, 503);
  // 向导：页面带首次设置的标记；新装的用户（没配置）直接进它；D176 起只有这一版，?ui=… 忽略
  const page = await (await h.page(new Request(`${ORIGIN}${ROUTES.page}?ui=next`))).text();
  assert.ok(page.includes('<meta name="rugu-setup-mode" content="1">'));
  assert.ok(page.includes("Rugu.define('wizard'"));
  const dflt = await (await h.page(new Request(`${ORIGIN}${ROUTES.page}`))).text();
  assert.ok(dflt.includes('<meta name="rugu-setup-mode" content="1">') && dflt.includes("Rugu.define('wizard'"), '新装的用户（没配置、没点过切换）直接进新版的向导');
  const classic = await (await h.page(new Request(`${ORIGIN}${ROUTES.page}?ui=classic`))).text();
  assert.ok(classic.includes("Rugu.define('wizard'"), '老地址上的 ?ui=classic 不再有旧版可去');
  assert.ok(!renderNextPage({ nonce: 'n', token: 't' }).includes('<meta name="rugu-setup-mode"'), '平时不带标记');
  // 设置完了：草稿不再存
  const s = setup();
  const done = await s.act('setup.draft', { draft: { step: 2 } });
  assert.equal(done.status, 422);
  assert.equal(s.hostCallsOf('setup.saveDraft').length, 0);
});

test('宿主配置：草稿是开放的对象（键名不报警告），整个换掉；写它时不算设置完了', () => {
  const dir = fs.mkdtempSync(path.join(process.env.PM_TEST_TMP ?? os.tmpdir(), 'pm-draft-'));
  try {
    const file = path.join(dir, 'persona-memory.json');
    const st = createConfigStore({ file });
    const r = st.set({ host: { setup: { inProgress: true, draft: { step: 2, personaPrefix: '一段', offGroups: ['1'] } } } }, { confirm: true });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(st.host().setup.draft, { step: 2, personaPrefix: '一段', offGroups: ['1'] });
    st.set({ host: { setup: { draft: { step: 3 } } } }, { confirm: true, replace: ['host.setup.draft'] });
    assert.deepEqual(st.host().setup.draft, { step: 3 }, '整个换掉');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).host.setup.inProgress, true);
    // 总开关关掉的确认理由不写 off
    const c = st.set({ mode: { global: 'off' } });
    assert.ok(c.needsConfirm[0].includes('总开关') && !/\boff\b/.test(c.needsConfirm[0]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('没走完首次设置时：「人设聊天」的名字和说明带提醒（现在选了也不记）；走完就没有', () => {
  const a = presetSettings({ preset: { name: '和她聊' } }, { setupPending: true });
  assert.equal(a.name, `和她聊${SETUP_NAME_SUFFIX}`);
  assert.ok(a.description.startsWith(SETUP_NOTICE));
  assert.match(SETUP_NOTICE, /暂时不记/);
  const b = presetSettings({ preset: { name: '和她聊' } });
  assert.equal(b.name, '和她聊');
  assert.ok(!b.description.includes(SETUP_NOTICE));
  const src = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('setupPending: () => host?.dormant?.() === true'), '入口把宿主的「休眠」交给预设');
});

test('预览分步向导：wizardPreviewDraft 预置 ack，配合 wiz-step 场景直链 #/wizard/N（产品仍要求未勾知情不能进第 2 步）', () => {
  assert.deepEqual(wizardPreviewDraft('wiz'), { step: 1 });
  assert.deepEqual(wizardPreviewDraft('wiz-step2'), { ack: true, step: 2 });
  assert.deepEqual(wizardPreviewDraft('wiz-step3'), { ack: true, step: 3 });
  assert.deepEqual(wizardPreviewDraft('wiz-step4'), { ack: true, step: 4 });
  assert.deepEqual(wizardPreviewDraft('wiz-step5'), { ack: true, step: 4 });
  assert.deepEqual(wizardPreviewDraft('wiz-noollama'), { ack: true, step: 3, embed: 'none' });
  for (const v of ['wiz-step2', 'wiz-step3', 'wiz-step4', 'wiz-step5', 'wiz-noollama']) assert.ok(WIZARD_VARIANTS.includes(v), v);
  const host = makeFakeHost({ scenario: 'wiz-step3' });
  assert.deepEqual(host.setup.draft(), { ack: true, step: 3 });
});

test('向导：检测不到 Ollama 时想起来的方式默认「先不用」（乙2）；草稿里记的优先；设置页照现在配的', () => {
  const ctx = { console, URLSearchParams, setTimeout, clearTimeout };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../../src/admin/ui/base.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(new URL('../../src/admin/ui/settings.js', import.meta.url), 'utf8'), ctx);
  const P = ctx.Rugu.settingsParts(ctx.Rugu);
  const noOllama = { mode: 'ollama', ollama: { reachable: false } };
  const withOllama = { mode: 'ollama', ollama: { reachable: true } };
  assert.equal(P.defaultChoice(noOllama, { wizard: true }), 'none');
  assert.equal(P.defaultChoice(withOllama, { wizard: true }), 'ollama');
  assert.equal(P.defaultChoice(noOllama, { wizard: true, initial: 'ollama' }), 'ollama', '草稿里选过的');
  assert.equal(P.defaultChoice({ mode: 'external', ollama: { reachable: false } }, { wizard: true }), 'external');
  assert.equal(P.defaultChoice(noOllama, {}), 'ollama', '设置页照现在配的显示');
  assert.equal(P.verdictText('能用，第一眼 0.9 秒，提炼 7.0 秒'), '能用，听到时的判断 0.9 秒，整理 7.0 秒');
  assert.equal(ctx.Rugu.moduleStates().settings, 'pending');
});

test('自检的文案：标题里不再有内部说法（L3、§、附录、私有 kit、配置键名当标题）', () => {
  const src = fs.readFileSync(new URL('../../src/host/selfcheck.js', import.meta.url), 'utf8');
  const { strings } = lexJs(src);
  const bad = strings.map((s) => s.value).filter((v) => /L3|§\d|附录|私有 kit|core-self\.md|agent\/pre-step 已挂上|systemPrompt\.context 可用（/.test(v));
  // 剩下的只能出现在 hint（技术细节）里：逐条看是不是 hint
  const labels = bad.filter((v) => !/已挂上$|没挂上$|可用$|^DSH 的 systemPrompt/.test(v));
  assert.deepEqual(labels, []);
});

test('设置的每个视图都给得出来（正常、空、出错几种假数据），只读时写操作的入口知道要置灰', async () => {
  for (const scenario of ['normal', 'empty', 'errors', 'readonly', 'llmoff', 'qqgen1', 'noqq']) {
    const s = setup({ scenario });
    for (const v of ['setHead', 'setBasic', 'setModels', 'setConnect', 'setCost', 'setDiag', 'setAbout']) {
      const r = await s.view(v);
      assert.equal(r.status, 200, `${scenario} ${v} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }
  const ro = (await setup({ scenario: 'readonly' }).view('setHead')).body.data;
  assert.equal(ro.store.readOnly, true);
  assert.equal((await setup({ scenario: 'qqgen1' }).view('setConnect')).body.data.qq.bridge.current.mode.secondGen, false);
  const diag = (await setup({ scenario: 'qqgen1' }).view('setDiag')).body.data.checkup;
  assert.equal(diag.find((x) => x.key === 'qq').state, 'bad');
  assert.equal((await setup({ scenario: 'llmoff' }).view('setDiag')).body.data.checkup.find((x) => x.key === 'llm').state, 'dim');
});
