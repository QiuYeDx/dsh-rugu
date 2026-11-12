// 新管理页的「待处理」「场合」（D172）：两个视图（inbox、places）、每种待处理条目「卡片 → 后端动作」的映射（并真的交给后端跑一遍）、
// 延迟提交在这里的用法（撤销不提交、超时提交、失败放回、离开时立刻提交）、场合的一个开关到两个动作的映射和失败回滚、
// 数字的口径和首页一致、页面拼装里两个模块都在且不是占位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderNextPage } from '../../src/admin/page.js';
import { setup } from './helpers.js';

const UI = new URL('../../src/admin/ui/', import.meta.url);
const src = (f) => fs.readFileSync(new URL(f, UI), 'utf8');

// ── 在 vm 里加载 base.js 和模块（一个够 toast / deferred 用的假 DOM、能手动走的计时器） ──────────────
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.listeners = {}; this.className = ''; this.parent = null; this.text = ''; }
  append(...k) { for (const c of k) { c.parent = this; this.children.push(c); } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  replaceChildren() { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  click() { for (const f of this.listeners.click ?? []) f({}); }
  get textContent() { return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join(''); }
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const x = c.find(pred); if (x) return x; } return null; }
}
function loadUi() {
  const timers = [];
  let tid = 0;
  const body = new FakeNode('body');
  const ctx = {
    console, URLSearchParams, Node: FakeNode,
    setTimeout: (fn, ms) => { const id = ++tid; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    document: { body, createElement: (t) => new FakeNode(t), createElementNS: (_n, t) => new FakeNode(t), createTextNode: (s) => Object.assign(new FakeNode('#text'), { text: String(s) }) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src('base.js'), ctx, { filename: 'base.js' });
  const R = ctx.Rugu;
  const factories = {};
  const define0 = R.define;
  R.define = (name, f) => { factories[name] = f; define0(name, f); };
  vm.runInContext(src('pending.js'), ctx, { filename: 'pending.js' });
  vm.runInContext(src('places.js'), ctx, { filename: 'places.js' });
  return {
    R, body, timers,
    pending: factories.pending(R).logic, places: factories.places(R).logic,
    /** 让 6 秒的计时器到点（toast 自己收起的计时器一起跑掉）。 */
    tick: () => { for (const t of timers.splice(0)) t.fn(); },
  };
}
const settle = () => new Promise((r) => setImmediate(r));
const plain = (x) => JSON.parse(JSON.stringify(x));

// ── 视图 ──────────────────────────────────────────────────────────────────
test('inbox 视图：需要你知道（开着的、读过的）、等你批准、被拦下的话一次给全；数字和首页、主导航同一个口径', async () => {
  const s = setup();
  const r = await s.view('inbox', { tz: '480' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  const home = (await s.view('home', { tz: '480' })).body.data;
  assert.equal(d.counts.total, home.pending.total, '和首页「需要你看一眼」的总数一样');
  assert.equal(d.counts.needToKnow, home.pending.needToKnow);
  assert.equal(d.counts.review, home.pending.review);
  assert.equal(d.needToKnow.items.length, d.counts.needToKnow);
  assert.ok(d.read.items.every((x) => x.status === 'read') && d.read.total === 1);
  assert.ok(d.blocked.items.length > 0 && d.blocked.items.every((x) => x.basis !== 'legacy'), '旧规则拦下的折成一行');
  assert.ok(d.blocked.legacy.total > 0);
  assert.equal(typeof d.today.guard, 'number');
  // 忘掉请求、分寸要改、只有你能做的操作：带着那条记忆 / 那条消息的一句话
  for (const id of [15, 17, 18]) assert.ok(d.review.items.find((x) => x.id === id).memo?.text, `审核 ${id} 带着那件事`);
  assert.match(d.review.items.find((x) => x.kind === 'held_utterance').hold.text, /恭喜/);
  assert.equal(d.readOnly, false);
  assert.equal((await setup({ scenario: 'readonly' }).view('inbox')).body.data.readOnly, true);
  const e = (await setup({ scenario: 'empty' }).view('inbox')).body.data;
  assert.deepEqual([e.counts.total, e.blocked.items.length], [0, 0]);
  assert.equal((await s.view('inbox', { tz: '99999' })).status, 400);
});

test('places 视图：场合（生效档、覆盖、别记、属性、收没收到过）、规则（不含模式覆盖）、叮嘱（在哪儿说的）、新场合的默认、原话保留期', async () => {
  const s = setup();
  const d = (await s.view('places')).body.data;
  assert.equal(d.places.items.length, d.places.total);
  const by = (k) => d.places.items.find((x) => x.key === k);
  assert.equal(by('sk-group-noname2').mode, 'off');
  assert.deepEqual(by('sk-group-noname2').override, { ruleId: 6, mode: 'off' });
  assert.equal(by('sk-thread').doNotRemember, true);
  assert.ok(d.rules.items.length > 0 && d.rules.items.every((r) => r.kind !== 'mode'));
  assert.deepEqual(d.defaults.byAttributes, { principalOneOnOne: 'live', closed: 'live', public: 'live' });
  const p12 = d.limits.items.find((x) => x.ref === 'p12');
  assert.ok(p12.settingKey && p12.at, '叮嘱带着在哪儿、什么时候');
  assert.equal(d.retention, '2y');
  assert.ok(Array.isArray(d.pickable) && Array.isArray(d.people));
  assert.equal((await setup({ scenario: 'empty' }).view('places')).body.data.places.items.length, 0);
});

// ── 待处理：卡片 → 动作 ──────────────────────────────────────────────────
/** 每种待处理条目：一句话的类型（cap）、主次按钮的文字、动作、能不能撤销（deferred = 能；server = 走确认框、不给撤销）。 */
const EXPECT = {
  'ntk-1': ['有人想改她的设定', ['知道了', 'deferred', 'ntk.read'], ['按来源撤回…', 'server', 'source.withdraw']],
  'ntk-2': ['有人要她瞒着你', ['知道了', 'deferred', 'ntk.read'], ['按来源撤回…', 'server', 'source.withdraw']],
  'ntk-3': ['聊到了安全', ['知道了', 'deferred', 'ntk.read'], ['按来源撤回…', 'server', 'source.withdraw']],
  'ntk-4': ['她的性格有了变化', ['知道了', 'deferred', 'ntk.read'], ['去成长里看', 'go']],
  'ntk-5': ['有人反复说同一件事', ['知道了', 'deferred', 'ntk.read'], ['按来源撤回…', 'server', 'source.withdraw']],
  'ntk-6': ['她的性格想改一处', ['知道了', 'deferred', 'ntk.read'], ['去批准', 'sub']],
  'ntk-8': ['新规矩', ['知道了', 'deferred', 'ntk.read'], ['去场合看看', 'go']],
  'rv-11': ['她想说一句话，先停下来问你', ['批准发出', 'server', 'review.decide', 'approve'], ['不发', 'deferred', 'review.decide', 'reject']],
  'rv-12': ['可能是同一个人', ['是同一个人', 'deferred', 'review.decide', 'approve'], ['不是', 'deferred', 'review.decide', 'reject']],
  'rv-13': ['她的性格想改一处', ['同意', 'deferred', 'review.decide', 'approve'], ['不同意', 'deferred', 'review.decide', 'reject']],
  'rv-14': ['按来源撤回', ['批准删除…', 'server', 'review.decide', 'approve'], ['驳回', 'deferred', 'review.decide', 'reject']],
  'rv-15': ['有人要求忘掉', ['忘掉', 'deferred', 'review.decide', 'approve'], ['留着', 'deferred', 'review.decide', 'reject']],
  'rv-16': ['场合的规矩要放宽', ['同意放宽', 'deferred', 'review.decide', 'approve'], ['不同意', 'deferred', 'review.decide', 'reject']],
  'rv-17': ['一件事能对谁说要改', ['同意', 'deferred', 'review.decide', 'approve'], ['不同意', 'deferred', 'review.decide', 'reject']],
  'rv-18': ['只有你能做的事', ['照做', 'deferred', 'review.decide', 'approve'], ['不照做', 'deferred', 'review.decide', 'reject']],
};
const shape = (op) => (op ? [op.label, op.type, ...(op.action ? [op.action] : []), ...(op.body?.decision ? [op.body.decision] : [])] : null);

test('待处理的每种条目：类型、一句话、主次按钮的文字和动作对得上（旧页面的每种类型都有自己的卡）', async () => {
  const { pending } = loadUi();
  const d = (await setup().view('inbox')).body.data;
  const { ntk, approve, blocked } = pending.cardsOf(d);
  const all = new Map([...ntk, ...approve].map((c) => [c.key, c]));
  assert.deepEqual([...all.keys()].sort(), Object.keys(EXPECT).sort());
  for (const [key, [cap, primary, secondary]] of Object.entries(EXPECT)) {
    const c = all.get(key);
    assert.equal(c.cap, cap, key);
    assert.ok(c.title && !/undefined|null/.test(c.title), `${key}：${c.title}`);
    assert.deepEqual(shape(c.primary), primary, `${key} 主按钮`);
    assert.deepEqual(shape(c.secondary), secondary, `${key} 次按钮`);
  }
  // 旧页面把「别告诉你主人」贴成了「想改变她」：两种现在各有各的说法
  assert.notEqual(all.get('ntk-2').cap, all.get('ntk-1').cap);
  // 每种审核都有自己的卡（不落到「等你批准」的兜底）
  for (const kind of ['forget_request', 'owner_op', 'merge', 'growth', 'held_utterance', 'norm_change', 'setting_rule_relax', 'withdraw']) {
    const c = pending.reviewCard(d, { id: 1, kind, payload: {}, createdAt: d.now });
    assert.notEqual(c.cap, '等你批准', kind);
  }
  // 「可能是同一个人」：先问一句（普通确认框），说清后果
  assert.match(all.get('rv-12').primary.confirm.text, /合在一起/);
  assert.match(all.get('rv-12').desc, /两边记得的事会合在一起/);
  // 不可恢复的两种：危险确认（彻底删除）、普通确认（发出去收不回）
  assert.equal(all.get('rv-14').primary.danger, true);
  assert.equal(all.get('rv-11').primary.danger, false);
  assert.match(all.get('rv-11').primary.consequence, /收不回/);
  // 要紧的排在前面（挂起的发言快过期、严重程度 ≥ 2）
  assert.equal(approve[0].key, 'rv-11');
  assert.ok(ntk.filter((c) => c.urgent).every((c, i) => ntk[i].urgent));
  // 被拦下的话：只是记录，没有按钮
  assert.ok(blocked.length && blocked.every((c) => !c.primary && !c.secondary));
  // 只是 T2 有记忆、也能撤回：次按钮看那条记忆，撤回挪到小字里的链接
  const t2 = pending.ntkCard(d, { ...d.needToKnow.items.find((x) => x.id === 3), ref: 'a7' });
  assert.deepEqual(plain([t2.secondary.label, t2.links.map((l) => l.label)]), ['看那条记忆', ['按来源撤回…']]);
});

test('卡片上的每个动作交给真的后端：能撤销的直接提交成功；不可恢复的要确认令牌，确认后成功', async () => {
  const { pending } = loadUi();
  const d = (await setup().view('inbox')).body.data;
  const { ntk, approve } = pending.cardsOf(d);
  // 主按钮一套假数据、次按钮另一套（同一条审核批准了就不能再驳回）
  const sets = { primary: setup(), secondary: setup() };
  for (const c of [...ntk, ...approve]) {
    for (const [which, op] of Object.entries({ primary: c.primary, secondary: c.secondary }).filter(([, o]) => o && (o.type === 'deferred' || o.type === 'server'))) {
      const s = sets[which];
      const r = await s.act(op.action, op.body);
      if (op.type === 'deferred') assert.equal(r.status, 200, `${c.key} ${op.label}：${JSON.stringify(r.body)}`);
      else {
        assert.equal(r.status, 428, `${c.key} ${op.label} 要确认`);
        assert.equal((await s.confirmAct(op.action, op.body)).status, 200, `${c.key} ${op.label} 确认后`);
      }
    }
  }
});

test('数字：处理掉的那几张从各分段和总数里减掉；被拦下的话不算进总数', async () => {
  const { pending } = loadUi();
  const d = (await setup().view('inbox')).body.data;
  const c0 = pending.countsOf(d);
  assert.deepEqual(plain(c0), { all: d.counts.total, ntk: d.counts.needToKnow, approve: d.counts.review, blocked: d.blocked.total });
  const c1 = pending.countsOf(d, new Set(['ntk-1', 'rv-12', 'rv-999']));
  assert.deepEqual([c1.all, c1.ntk, c1.approve], [c0.all - 2, c0.ntk - 1, c0.approve - 1], '不在数据里的不减');
  assert.equal(pending.cardsOf(d, new Set(['ntk-1'])).ntk.some((c) => c.key === 'ntk-1'), false);
  assert.deepEqual([pending.subOfKey('ntk-3'), pending.subOfKey('rv-12'), pending.subOfKey('bl-40'), pending.subOfKey('x')], ['ntk', 'approve', 'blocked', null]);
});

// ── 延迟提交 ──────────────────────────────────────────────────────────────
function harness(ui, actImpl) {
  const log = [];
  const deps = {
    deferred: ui.R.deferred,
    act: async (a, b) => { log.push(['act', a, plain(b)]); return actImpl ? actImpl(a, b) : {}; },
    confirmSimple: async () => { log.push(['confirm']); return deps.yes; },
    hide: (k) => { log.push(['hide', k]); },
    show: (k) => { log.push(['show', k]); },
    committed: (k) => { log.push(['committed', k]); },
    yes: true,
  };
  return { deps, log };
}
const toastOf = (ui) => ui.body.find((n) => n.tag === 'div' && /toast/.test(n.className));

test('延迟提交：点了先收起、6 秒后才提交；撤销就不提交、卡片放回来', async () => {
  const ui = loadUi();
  const op = { type: 'deferred', label: '知道了', action: 'ntk.read', body: { id: 1 }, toast: '已标为已读' };
  // 超时提交
  let { deps, log } = harness(ui);
  await ui.pending.startDeferred(op, 'ntk-1', deps);
  assert.deepEqual(log, [['hide', 'ntk-1']], '6 秒内不提交');
  assert.match(toastOf(ui).textContent, /已标为已读.*撤销/);
  ui.tick(); await settle();
  assert.deepEqual(log, [['hide', 'ntk-1'], ['act', 'ntk.read', { id: 1 }], ['committed', 'ntk-1']]);
  // 撤销
  ({ deps, log } = harness(ui));
  await ui.pending.startDeferred(op, 'ntk-2', deps);
  toastOf(ui).find((n) => n.tag === 'button').click();
  ui.tick(); await settle();
  assert.deepEqual(log, [['hide', 'ntk-2'], ['show', 'ntk-2']], '撤销了就不提交');
});

test('延迟提交：提交失败把卡片放回去并说明；要确认的先问，取消就什么都不做；离开页面时立刻提交', async () => {
  const ui = loadUi();
  const op = { type: 'deferred', label: '忘掉', action: 'review.decide', body: { id: 15, decision: 'approve' }, toast: '已忘掉' };
  let { deps, log } = harness(ui, () => { throw new ui.R.ApiError(409, { code: 'READ_ONLY', error: 'x' }); });
  await ui.pending.startDeferred(op, 'rv-15', deps);
  ui.tick(); await settle();
  assert.deepEqual(log.map((x) => x[0]), ['hide', 'act', 'show'], '失败了放回去');
  assert.match(toastOf(ui).textContent, /只读/);
  // 要确认（「是同一个人」）：取消
  ({ deps, log } = harness(ui));
  deps.yes = false;
  const merge = { ...op, body: { id: 12, decision: 'approve' }, confirm: { title: 't', text: 'x', okText: 'ok' } };
  assert.equal(await ui.pending.startDeferred(merge, 'rv-12', deps), null);
  assert.deepEqual(log, [['confirm']]);
  // 离开页面（换去处、页面藏起来）：base 的 flushPending 立刻提交
  ({ deps, log } = harness(ui));
  await ui.pending.startDeferred(merge, 'rv-12', deps);
  ui.R.flushPending(); await settle();
  assert.deepEqual(log.map((x) => x[0]), ['confirm', 'hide', 'act', 'committed']);
});

// ── 场合：一个开关 ────────────────────────────────────────────────────────
test('场合的一个开关：状态的说法；开 = 模式开 + 记这里开，关 = 模式关；每一步带着退回去的那一步', async () => {
  const { places } = loadUi();
  const d = (await setup().view('places')).body.data;
  const by = (k) => d.places.items.find((x) => x.key === k);
  const st = (k) => places.stateOf(by(k), d.defaults);
  assert.deepEqual([st('sk-private-owner').status, st('sk-thread').status, st('sk-group-noname2').status], ['on', 'recall', 'off']);
  assert.deepEqual([st('sk-private-owner').text, st('sk-thread').text, st('sk-group-noname2').text], ['在记', '只想起、不记新的', '没在记']);
  assert.equal(st('sk-thread').on, true, '只想起不记新的：开关是开的');
  assert.deepEqual([st('sk-private-owner').follow, st('sk-group-small').follow], [true, false]);
  assert.deepEqual([st('sk-private-owner').cls, st('sk-comments').cls, st('sk-group-small').cls], ['principalOneOnOne', 'public', 'closed']);
  assert.equal(places.stateOf(by('sk-private-owner'), { ...d.defaults, global: 'off' }).status, 'master', '总开关关着');
  const plan = (p, on) => plain(places.planSwitch(p, on));
  assert.deepEqual(plan(by('sk-thread'), true), [
    { action: 'setting.mode', body: { settingKey: 'sk-thread', mode: 'live' }, undo: { settingKey: 'sk-thread', mode: 'default' } },
    { action: 'setting.remember', body: { settingKey: 'sk-thread', remember: true }, undo: { settingKey: 'sk-thread', remember: false } }]);
  assert.deepEqual(plan(by('sk-group-small'), false), [{ action: 'setting.mode', body: { settingKey: 'sk-group-small', mode: 'off' }, undo: { settingKey: 'sk-group-small', mode: 'live' } }]);
  assert.deepEqual(plain(places.planFollow(by('sk-group-small'), true))[0].body, { settingKey: 'sk-group-small', mode: 'default' });
  assert.deepEqual(plain(places.planFollow(by('sk-private-owner'), false))[0].body, { settingKey: 'sk-private-owner', mode: 'live' });
  assert.deepEqual(plain(places.planRecall(by('sk-private-owner'), true))[0].body, { settingKey: 'sk-private-owner', remember: false });
  // 交给真的后端跑：关、开、跟着默认
  const s = setup();
  const act = async (a, b) => { const r = await s.act(a, b); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); return r.body.result; };
  const now = async (k) => (await s.view('places')).body.data.places.items.find((x) => x.key === k);
  assert.equal((await places.runSteps(act, places.planSwitch(await now('sk-thread'), true))).ok, true);
  assert.deepEqual([(await now('sk-thread')).mode, (await now('sk-thread')).doNotRemember], ['live', false]);
  await places.runSteps(act, places.planSwitch(await now('sk-private-owner'), false));
  assert.equal((await now('sk-private-owner')).mode, 'off');
  await places.runSteps(act, places.planFollow(await now('sk-private-owner'), true));
  assert.equal((await now('sk-private-owner')).override, null);
});

test('场合的一个开关：两个动作之间失败了一个，把做了的那一步退回去（退不回去也如实说）', async () => {
  const { places } = loadUi();
  const p = { key: 'k1', mode: 'off', override: { mode: 'off' }, doNotRemember: true };
  const steps = places.planSwitch(p, true);
  const calls = [];
  const fail2 = async (a, b) => { calls.push([a, plain(b)]); if (a === 'setting.remember') throw new Error('boom'); };
  const r = await places.runSteps(fail2, steps);
  assert.deepEqual([r.ok, r.failedAt, r.reverted, r.error.message], [false, 1, true, 'boom']);
  assert.deepEqual(calls, [['setting.mode', { settingKey: 'k1', mode: 'live' }], ['setting.remember', { settingKey: 'k1', remember: true }], ['setting.mode', { settingKey: 'k1', mode: 'off' }]]);
  const stuck = await places.runSteps(async (a, b) => { if (a === 'setting.remember' || b.mode === 'off') throw new Error('x'); }, steps);
  assert.deepEqual([stuck.ok, stuck.reverted], [false, false]);
  const first = await places.runSteps(async () => { throw new Error('y'); }, steps);
  assert.deepEqual([first.failedAt, first.reverted], [0, true], '第一步就失败：什么都没做');
});

test('规则和告知：说人话（不说「披露」）；加规则的表单到 rules.add 的参数，后端收得下', async () => {
  const { places } = loadUi();
  const d = (await setup().view('places')).body.data;
  const text = Object.fromEntries(d.rules.items.map((r) => [r.id, places.ruleText(d, r)]));
  assert.equal(text[1], '别记「一条评论串」');
  assert.equal(text[2], '阿明的事别提，尤其别告诉小雨、小鹿');
  assert.equal(text[3], '「健康」这类事最多说个大概');
  assert.equal(text[5], '别再记一条忘掉的事');
  assert.equal(places.ruleText(d, { kind: 'disclosure', target: { entityId: 10 }, value: { restriction: 'none', deny: [13] } }), '阿明的事别告诉小雨');
  assert.match(places.ruleBody({ kind: 'deny', targetType: 'entity', entityId: '10', deny: new Set() }).error, /别告诉的人/);
  assert.match(places.ruleBody({ kind: 'dnr', targetType: 'attribute', attribute: '健康' }).error, /场合或一个人/);
  const s = setup();
  for (const f of [{ kind: 'dnr', targetType: 'setting', settingKey: 'sk-web', note: ' 备注 ' }, { kind: 'strict', targetType: 'attribute', attribute: '住址', deny: new Set([13]) },
    { kind: 'soft', targetType: 'setting', settingKey: 'sk-group-small' }, { kind: 'deny', targetType: 'entity', entityId: '10', deny: new Set([10, 13]) }]) {
    const body = places.ruleBody(f);
    assert.ok(!body.error, JSON.stringify(body));
    const r = await s.act('rules.add', body);
    assert.equal(r.status, 200, `${f.kind}：${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(s.callsOf('admin.rules.add').at(-1).args[0].value, { restriction: 'none', deny: [13] }, '自己不在「别告诉谁」里');
  assert.match(places.noticeText('2y'), /她所在的群里每个人说的话都会被记下，原话默认保留 2 年；群友不知道的，请你告诉他们/);
  assert.match(places.noticeText('5y'), /原话现在保留 5 年/);
  assert.equal(places.attrsText(d.places.items.find((x) => x.key === 'sk-group-small')), '8 人 · 邀请才能进 · 成员看得到 · 有记录 · 她是普通成员');
});

test('页面拼装：两个模块都在、不再是占位；源文件里没有内部说法和 HTML 解析', () => {
  const html = renderNextPage({ nonce: 'n', token: 't' });
  for (const m of ['pending', 'places']) {
    assert.ok(html.includes(`Rugu.define('${m}'`), m);
    const s = src(`${m}.js`);
    assert.ok(!s.includes('placeholderPage'), `${m} 不再是占位`);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function']) assert.ok(!s.includes(bad), `${m}: ${bad}`);
    // 界面文字里不出现内部说法（设计说明第 7 节的对照表）
    const strings = (s.match(/'[^'\n]*'|`[^`\n]*`/g) ?? []).join('\n');
    for (const w of ['披露', '审核', '第一眼', '污点', '注入', '成长块', '熔断', '关口', 'fail closed']) assert.ok(!strings.includes(w), `${m}: ${w}`);
  }
});
