// 新管理页「记忆」这一路（D171）：集成层的合并列表 / 按天计数 / 人物三个视图；memory.js 里能脱离浏览器测的纯函数（筛选参数、请求、
// 行的元信息、状态标签、路由参数）；彻底删除「连备份一起删」默认勾上；星图两种挂载（旧页面自己带工具条和详情、新页面交给页面）都能用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setup } from './helpers.js';
import { makeFakePm, NOW } from './fixtures.js';
import { starmapSnapshot, feedQuery } from '../../src/admin/views.js';
import { renderNextPage, UI_SCRIPTS } from '../../src/admin/page.js';

const DAY = 86_400_000;
/** vm 里建的数组、对象和这里的不是同一个领域：比之前先拍平。 */
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, m);
const BASE = fs.readFileSync(new URL('../../src/admin/ui/base.js', import.meta.url), 'utf8');
const MEMORY = fs.readFileSync(new URL('../../src/admin/ui/memory.js', import.meta.url), 'utf8');
const STARMAP = fs.readFileSync(new URL('../../src/admin/starmap.client.js', import.meta.url), 'utf8');

/** 在 node 里加载 base.js + memory.js，拿到记忆模块（工厂只定义东西，不碰 DOM）。 */
function memoryModule() {
  const ctx = { console, URLSearchParams, Date, Math, JSON, Intl };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BASE, ctx);
  let factory = null;
  const real = ctx.Rugu.define;
  ctx.Rugu.define = (name, f) => { if (name === 'memory') factory = f; return real(name, f); };
  vm.runInContext(MEMORY, ctx);
  return factory(ctx.Rugu);
}

// ── 集成层的视图 ─────────────────────────────────────────────────────────
test('feed：合并的列表（四种混排、新的在前）；meta=1 才带下拉要的场合和人；游标翻页不重不漏', async () => {
  const s = setup();
  const r = await s.view('feed', { meta: '1', limit: '20' });
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.items.length, 20);
  assert.ok(new Set(d.items.map((x) => x.kind)).size >= 3, '几种混在一起');
  for (let i = 1; i < d.items.length; i++) assert.ok(d.items[i - 1].at >= d.items[i].at, '新的在前');
  assert.ok(d.allSettings && typeof d.allSettings === 'object' && !Array.isArray(d.allSettings));
  assert.ok(Object.keys(d.allSettings).length >= 3, '下拉场合至少多个');
  assert.ok(Array.isArray(d.pickable));
  assert.equal(typeof d.readOnly, 'boolean');
  const seen = new Set(d.items.map((x) => x.ref));
  let next = d.next;
  while (next) {
    const p = (await s.view('feed', { limit: '20', next })).body.data;
    assert.equal(p.allSettings, undefined, '翻页不带下拉的东西');
    for (const x of p.items) { assert.ok(!seen.has(x.ref), `重复了 ${x.ref}`); seen.add(x.ref); }
    next = p.next;
  }
  assert.equal(seen.size, d.total);
});

test('feed：筛选——种类、人（连同同一个人的另一个档案）、场合、状态、旧版本、搜索；参数不对是 400', async () => {
  const s = setup();
  const get = async (q) => (await s.view('feed', { limit: '200', ...q })).body.data.items;
  assert.ok((await get({ kinds: 'episode' })).every((x) => x.kind === 'episode'));
  const ming = await get({ entityId: '44' });
  assert.deepEqual(ming.map((x) => x.ref), (await get({ entityId: '10' })).map((x) => x.ref), '44 和 10 是同一个人');
  assert.ok((await get({ settingKey: 'sk-group-small' })).every((x) => x.settingKey === 'sk-group-small' && x.kind !== 'intent'));
  assert.ok((await get({ state: 'hidden' })).every((x) => x.state === 'hidden'));
  assert.ok((await get({})).every((x) => x.state !== 'forgotten'), '默认不列忘掉的');
  assert.ok((await get({ versions: 'old' })).every((x) => x.supersededBy != null));
  assert.ok((await get({ q: '快递' })).every((x) => x.text.includes('快递')));
  for (const bad of [{ kinds: 'percept' }, { state: 'gone' }, { versions: 'x' }, { entityId: 'abc' }, { order: 'rank' }, { from: '2', to: '1' }]) {
    assert.equal((await s.view('feed', bad)).status, 400, JSON.stringify(bad));
  }
  // 字符串参数 → 核心的查询
  assert.deepEqual(feedQuery({ kinds: 'fact,lesson', state: 'all', entityId: '12', tz: '480', order: 'asc' }, { paging: false }),
    { kinds: ['fact', 'lesson'], state: 'all', entityId: 12, order: 'asc', tzOffsetMin: 480 });
});

test('feed / feedDays / people：只读库照样能读（不写）；老核心没有合并列表 → unsupported', async () => {
  const pm = makeFakePm({ scenario: 'readonly' });
  const s = setup({ pm });
  const r = await s.view('feed', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.data.readOnly, true);
  assert.equal((await s.view('people', {})).body.data.readOnly, true);
  assert.ok(!pm.calls.some((c) => /hide|forget|restore|purge/.test(c.name)));
  const old = makeFakePm();
  delete old.admin.feed; delete old.admin.feedDays; delete old.admin.people;
  const o = setup({ pm: old });
  assert.deepEqual((await o.view('feed', {})).body.data, { unsupported: true });
  assert.deepEqual((await o.view('people', {})).body.data, { unsupported: true });
});

test('feedDays：月历按天计数（和列表同样的条件）；month 不对是 400', async () => {
  const s = setup();
  const r = await s.view('feedDays', { month: '2026-11', tz: '480' });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.items.length > 0 && r.body.data.items.every((x) => /^2026-11-\d\d$/.test(x.day) && x.n > 0));
  assert.ok(r.body.data.first < r.body.data.last);
  const ep = (await s.view('feedDays', { month: '2026-11', kinds: 'episode' })).body.data.items.reduce((n, x) => n + x.n, 0);
  const all = r.body.data.items.reduce((n, x) => n + x.n, 0);
  assert.ok(ep > 0 && ep < all);
  assert.equal((await s.view('feedDays', { month: '2026-13' })).status, 400);
});

test('people：一个人一项，主人在前，名下几条、印象；id=… 带详情（各场合的叫法、关系、印象、链接）', async () => {
  const s = setup();
  const d = (await s.view('people', {})).body.data;
  assert.ok(d.items[0].principal);
  assert.ok(!d.items.some((p) => p.id === 44), '认成同一个人的档案并进了 10');
  const ming = d.items.find((p) => p.id === 10);
  assert.deepEqual(ming.aliases, ['明哥']);
  assert.ok(ming.n > 0 && ming.impression);
  const one = (await s.view('people', { id: '44' })).body.data;
  assert.equal(one.items[0].id, 10);
  assert.ok(one.detail.names.some((n) => n.scope) && one.detail.links.some((l) => l.rel === 'same'));
  assert.ok(one.allSettings, '详情带场合的名字');
  assert.equal((await s.view('people', { id: 'x' })).status, 400);
});

// ── memory.js 的纯函数 ──────────────────────────────────────────────────
test('memory.js：地址栏参数 ⇄ 筛选条件（不认识的值退回默认；默认值不写进地址）；同一组条件认得出来', () => {
  const { lib } = memoryModule();
  const f = lib.filtersOf({ type: 'quote', who: '12', place: 'sk-a', time: 'range', from: '1000', to: '2000', q: '火锅', order: 'rank', at: '1500', open: 'a1' });
  assert.deepEqual({ ...f }, { type: 'quote', who: '12', place: 'sk-a', time: 'range', from: 1000, to: 2000, q: '火锅', order: 'rank', at: 1500 });
  assert.deepEqual({ ...lib.filtersOf({ type: 'nope', who: '0x', time: 'week', order: 'rank' }) },
    { type: 'all', who: '', place: '', time: 'all', from: null, to: null, q: '', order: 'desc', at: null });
  assert.equal(lib.filtersOf({ type: 'all', order: 'rank', q: 'x' }).order, 'desc', '合并列表没有「最相关」');
  assert.deepEqual({ ...lib.paramsOf(lib.filtersOf({})) }, { type: '', who: '', place: '', time: '', from: '', to: '', q: '', order: '', at: '' });
  assert.deepEqual({ ...lib.filtersOf(lib.paramsOf(f)) }, { ...f });
  assert.ok(lib.sameFilters(lib.filtersOf({ type: 'fact' }), lib.filtersOf({ type: 'fact', open: 'a9' })), '只是打开详情不算换了列表');
  assert.ok(!lib.sameFilters(lib.filtersOf({ type: 'fact' }), lib.filtersOf({ type: 'fact', at: '5' })));
});

test('memory.js：场合下拉缓存——空 pickable 不能挡住 memories.settings；合并不覆盖', () => {
  const { lib } = memoryModule();
  const merged = lib.mergeAllSettings({ sk: '已有' }, { sk: '新来的', sk2: '第二场合' });
  assert.equal(merged.sk, '已有');
  assert.equal(merged.sk2, '第二场合');
  assert.ok(lib.hasPlaceMeta({ allSettings: { a: '场合' }, pickable: [] }));
  assert.ok(!lib.hasPlaceMeta({ allSettings: {}, pickable: [] }));
  assert.ok(!lib.shouldRequestMeta({ meta: false }));
  assert.ok(lib.shouldRequestMeta({}));
  assert.ok(!lib.shouldRequestMeta({}, { meta: { allSettings: { k: '场合' }, pickable: [] } }));
  const bag = { meta: null };
  lib.applyPageMeta({ pickable: [], settings: { k1: '和你的私聊', k2: { label: '一个 QQ 群', labelKind: 'description', hint: '9 人' } } }, 'memories', bag);
  assert.equal(Object.keys(bag.meta.allSettings).length, 2);
  assert.equal(bag.meta.allSettings.k2, '一个 QQ 群（9 人）');
  const locked = { meta: { allSettings: {}, pickable: [] } };
  lib.applyPageMeta({ pickable: [], settings: { k3: '网页对话' } }, 'memories', locked);
  assert.equal(locked.meta.allSettings.k3, '网页对话', '以前会被空 pickable 拦住，现在要从 settings 填进来');
});

test('memories 视图：不依赖 meta 参数也带 settings 场合表', async () => {
  const s = setup();
  const d = (await s.view('memories', { list: 'assertions', limit: '5' })).body.data;
  assert.ok(Object.keys(d.settings).length >= 3);
});

test('memory.js：一页的请求——全部 / 单种走 feed，原话、已隐藏走 memories；只给这一类认的筛选；时间按本地的天', () => {
  const { lib } = memoryModule();
  const now = new Date(2026, 10, 13, 15, 0).getTime();
  const [v1, q1] = lib.requestFor(lib.filtersOf({ who: '10', place: 'sk', q: '搬家', time: 'today' }), { next: 'c1', meta: true }, now);
  assert.equal(v1, 'feed');
  assert.equal(q1.entityId, '10'); assert.equal(q1.settingKey, 'sk'); assert.equal(q1.q, '搬家'); assert.equal(q1.next, 'c1'); assert.equal(q1.meta, '1');
  assert.equal(q1.from, new Date(2026, 10, 13).getTime());
  assert.equal(q1.kinds, undefined, '全部 = 四种');
  assert.equal(lib.requestFor(lib.filtersOf({ type: 'lesson' }))[1].kinds, 'lesson');
  assert.equal(lib.requestFor(lib.filtersOf({ type: 'unverified' }))[1].lessonStatus, 'unverified');
  const [v2, q2] = lib.requestFor(lib.filtersOf({ type: 'quote', who: '10', q: '你好', order: 'rank' }), { around: 123 });
  assert.equal(v2, 'memories'); assert.equal(q2.list, 'percepts'); assert.equal(q2.entityId, '10'); assert.equal(q2.order, 'rank'); assert.equal(q2.around, 123);
  const [, q3] = lib.requestFor(lib.filtersOf({ type: 'hidden', who: '10', q: 'x' }));
  assert.equal(q3.list, 'suppressed'); assert.equal(q3.state, 'hidden'); assert.equal(q3.entityId, ''); assert.equal(q3.q, '', '收起来的不能按人筛、不能搜');
  const [, y] = [0, lib.rangeOf({ time: 'yesterday' }, now)];
  eq(y, [new Date(2026, 10, 12).getTime(), new Date(2026, 10, 13).getTime() - 1]);
  const [dv, dq] = lib.daysRequestFor(lib.filtersOf({ type: 'episode', who: '3' }), '2026-11');
  assert.equal(dv, 'feedDays'); assert.equal(dq.month, '2026-11'); assert.equal(dq.next, undefined);
  assert.equal(lib.daysRequestFor(lib.filtersOf({ type: 'quote' }), '2026-11')[0], 'memoryDays');
  assert.equal(lib.jumpAt(1000, 'asc'), 1000);
  assert.equal(lib.jumpAt(1000, 'desc'), 1000 + DAY - 1);
});

test('memory.js：行的小字（谁说的 · 在哪儿 · 什么时候 · 把握）和状态标签；「忘掉」不用红色', () => {
  const { lib } = memoryModule();
  const now = new Date(2026, 10, 13, 15, 0).getTime();
  const ctx = { names: { 10: { name: '阿明' }, 2: { name: '主人', principal: true }, 1: { name: null, self: true } }, settings: { sk: { label: '摸鱼小群' } } };
  const at = now - 3600_000;
  eq(lib.metaParts({ _t: 'fact', who: 10, certainty: 'stated', settingKey: 'sk', at, confidence: 0.92 }, ctx, now).filter(Boolean), ['阿明亲口说的', '摸鱼小群', '今天 14:00', '把握 92%']);
  assert.equal(lib.metaParts({ _t: 'fact', who: 10, certainty: 'hearsay', at }, ctx, now)[0], '听阿明说的');
  assert.equal(lib.metaParts({ _t: 'fact', who: 2, certainty: 'stated', at }, ctx, now)[0], '你说的');
  assert.equal(lib.metaParts({ _t: 'fact', who: 1, certainty: 'self_said', at }, ctx, now)[0], '她自己说的');
  const ep = lib.metaParts({ _t: 'episode', epKind: 'event', participants: [10, 2], settingKey: 'sk', tStart: at - 1800_000, at }, ctx, now).filter(Boolean);
  eq(ep, ['经历', '阿明、你', '摸鱼小群', '13:30–14:00']);
  eq(lib.metaParts({ _t: 'intent', who: 10, intentState: 'formed', until: now + 2 * DAY, at }, ctx, now).filter(Boolean).slice(0, 2), ['她打算做的', '对阿明']);
  assert.equal(lib.metaParts({ _t: 'lesson', origin: 'tool', tool: 'read_file', at }, ctx, now)[2], '用 read_file 时');
  const long = { names: {}, settings: { k: { label: '一个名字特别特别长的群聊名字用来看截断的' } } };
  assert.ok([...lib.placeName(long, 'k')].length <= 15);
  const forgot = lib.tagsOf({ state: 'forgotten', restoreUntil: now + 22 * DAY + 1 }, now);
  eq(forgot, [['已忘掉 · 还剩 23 天能恢复', '']]);
  assert.ok(!lib.tagsOf({ state: 'hidden', supersededBy: 3, _t: 'lesson', status: 'unverified' }, now).some(([, tone]) => tone === 'bad'), '没有红色的');
  eq(lib.tagsOf({ _t: 'lesson', status: 'unverified' }, now), [['还没验证', 'warn']]);
  assert.equal(lib.titleOf({ _t: 'check', before: { text: '收不到' }, after: { text: '收得到' } }), '「收不到」→「收得到」');
});

test('彻底删除：「同时从本机备份里删掉」默认勾上，没动它也照样带上 alsoBackups: true；删完的人话', () => {
  const { lib } = memoryModule();
  assert.equal(lib.PURGE_ALSO_BACKUPS_DEFAULT, true);
  assert.match(MEMORY, /R\.api\.confirmed\('memory\.purge', \{ refs, alsoBackups: PURGE_ALSO_BACKUPS_DEFAULT \}/);
  assert.match(MEMORY, /state\.params = \{ alsoBackups: PURGE_ALSO_BACKUPS_DEFAULT \}/);
  assert.match(MEMORY, /type: 'checkbox', checked: PURGE_ALSO_BACKUPS_DEFAULT/);
  const lines = lib.purgeSummary({ growth: { lines: 1 }, backups: { rewritten: 2, unchanged: 1, failed: 1, failures: [{ reason: 'no-key' }] }, wal: { main: 'busy' }, sessions: 2 });
  assert.equal(lines.length, 5);
  assert.ok(lines.some((l) => l.includes('缺少解密的钥匙')));
});

test('页面拼装：记忆模块和星图脚本都在新页面里（星图在 UI_SCRIPTS 里登记）；记忆模块的源文件守规矩', () => {
  assert.ok(UI_SCRIPTS.some(([n, u]) => n === 'starmap' && String(u).endsWith('/starmap.client.js')));
  const html = renderNextPage({ nonce: 'n1', token: 't1' });
  assert.ok(html.includes("Rugu.define('memory'"));
  assert.ok(html.includes('window.__pmStarmap = { mount, lib }'));
  assert.ok(html.includes('//# sourceURL=rugu-ui/starmap.js'));
  for (const src of [MEMORY, fs.readFileSync(new URL('../../src/admin/ui/memory.css', import.meta.url), 'utf8')]) {
    assert.ok(!src.includes('inner' + 'HTML') && !src.includes('outer' + 'HTML') && !/https?:\/\//.test(src));
  }
  assert.ok(!/\bwindow\.[A-Za-z_$]+\s*=(?!=)/.test(MEMORY), '记忆模块不新增全局名字');
});

// ── 星图的两种挂载（一个够用的假 DOM：星图在 node 里能建节点、读快照、回调） ──────────────
function fakeDom() {
  const noop = () => {};
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop), set: (t, k, v) => { t[k] = v; return true; } });
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.parentNode = null; this.hidden = false; this.listeners = {};
      this.style = { setProperty: noop, removeProperty: noop };
      const cls = new Set();
      this.classList = { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), toggle: (c, on) => { if (on ?? !cls.has(c)) cls.add(c); else cls.delete(c); }, contains: (c) => cls.has(c) };
      Object.defineProperty(this, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); } });
      this.clientWidth = 900; this.clientHeight = 560; this.offsetWidth = 900; this.offsetHeight = 560; this.scrollTop = 0; this.value = ''; this.options = [];
    }
    get isConnected() { return true; }
    get lastChild() { return this.children.at(-1) ?? null; }
    get firstChild() { return this.children[0] ?? null; }
    set textContent(v) { this.children = [String(v)]; }
    get textContent() { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    append(...xs) { for (const x of xs) { if (x && typeof x === 'object') x.parentNode = this; this.children.push(x); } }
    appendChild(x) { this.append(x); return x; }
    replaceChildren(...xs) { this.children = []; this.append(...xs); }
    replaceWith(x) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); p.children[i] = x; x.parentNode = p; }
    remove() { const p = this.parentNode; if (p) p.children = p.children.filter((c) => c !== this); }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    removeEventListener() {}
    dispatch(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ preventDefault: noop, stopPropagation: noop, target: this, ...e }); }
    click() { this.dispatch('click'); }
    getContext(kind) { return kind === '2d' ? ctx2d : null; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 900, bottom: 560, width: 900, height: 560 }; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    contains(x) { return x === this || this.children.some((c) => c && typeof c === 'object' && c.contains(x)); }
    focus() {} setPointerCapture() {}
    find(pred) { if (pred(this)) return this; for (const c of this.children) { if (c && typeof c === 'object') { const r = c.find(pred); if (r) return r; } } return null; }
  }
  const document = { createElement: (t) => new El(t), createElementNS: (_n, t) => new El(t), createTextNode: (t) => String(t), documentElement: new El('html'), body: new El('body'),
    addEventListener: noop, fullscreenEnabled: false, fullscreenElement: null, hidden: false, activeElement: null };
  const frames = [];
  const window = { document, matchMedia: () => ({ matches: false, addEventListener: noop }), requestAnimationFrame: (f) => { frames.push(f); return frames.length; }, cancelAnimationFrame: noop,
    location: { search: '' }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, innerHeight: 900, innerWidth: 1280, scrollY: 0, devicePixelRatio: 1, addEventListener: noop };
  const sandbox = { window, document, matchMedia: window.matchMedia, requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: noop, location: window.location,
    localStorage: window.localStorage, performance: { now: () => 1000 }, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, console, Math, Date, JSON,
    Float32Array, Float64Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Map, Set, Array, Object, Number, String, Promise, Symbol, Error, TypeError, Intl, isFinite, parseInt };
  vm.createContext(sandbox);
  vm.runInContext(STARMAP, sandbox);
  const h = (tag, attrs, ...kids) => {
    const el = new El(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v); else if (['hidden', 'value'].includes(k)) el[k] = v; else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
    return el;
  };
  const clear = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false)); return el; };
  return { window, h, clear, El };
}

async function starmapApi() {
  const pm = makeFakePm({ now: NOW });
  const snap = starmapSnapshot(pm.admin.starmap({}));
  return { get: async (view) => (view === 'starmap' ? snap : view === 'starmapPeek' ? { items: [] } : { now: NOW, rev: snap.rev, cursor: snap.cursor, traces: [], recalls: [], tells: [] }) };
}

test('星图：旧页面的挂载照旧——自己带工具条（按人 / 按时间、种类、场合、搜索、演示、放大）和详情卡', async () => {
  const { window, h, clear, El } = fakeDom();
  const el = new El('div');
  const opened = [];
  const inst = window.__pmStarmap.mount(el, { h, clear, api: await starmapApi(), openMemory: (r) => opened.push(r), go: () => {} });
  inst.show();
  await new Promise((r) => setImmediate(r));
  const root = el.children[0];
  assert.ok(root.classList.contains('pm-sm') && !root.classList.contains('pm-sm-ext'));
  assert.ok(root.find((x) => x.classList?.contains('pm-sm-bar')), '有自己的工具条');
  assert.ok(root.find((x) => x.classList?.contains('pm-sm-sky')));
  const card = root.find((x) => x.classList?.contains('pm-sm-card'));
  assert.ok(card.hidden, '还没选星时详情卡藏着');
  inst.control.select(0);
  assert.equal(card.hidden, false, '选了一颗星：详情卡出来');
  const openBtn = card.find((x) => x.tagName === 'BUTTON' && x.textContent === '打开这条记忆');
  openBtn.click();
  assert.equal(opened.length, 1);
  inst.control.select(-1);
  assert.equal(card.hidden, true);
  inst.hide();
});

test('星图：新页面的挂载——不画工具条和详情卡，种类、场合、选中的星经回调交给页面；页面经 control 改', async () => {
  const { window, h, clear, El } = fakeDom();
  const el = new El('div');
  const maxRoot = new El('div');
  const got = { model: [], select: [], state: [] };
  const opened = [];
  const inst = window.__pmStarmap.mount(el, { h, clear, api: await starmapApi(), openMemory: (r) => opened.push(r), go: () => {},
    external: { maxRoot, onModel: (m) => got.model.push(m), onSelect: (i) => got.select.push(i), onState: (s) => got.state.push(s), onSearch: () => {} } });
  inst.show();
  await new Promise((r) => setImmediate(r));
  const root = el.children[0];
  assert.ok(root.classList.contains('pm-sm-ext'));
  assert.equal(root.find((x) => x.classList?.contains('pm-sm-bar')), null, '工具条由页面画');
  assert.ok(root.find((x) => x.classList?.contains('pm-sm-sky')), '星空还是它画');
  assert.deepEqual(got.state, ['ready']);
  const m = got.model.at(-1);
  assert.equal(m.kinds.length, 4);
  assert.ok(m.kinds.every((k) => k.on && typeof k.n === 'number' && /^rgba\(/.test(k.color)));
  assert.equal(m.places[0].value, 'all');
  assert.equal(m.view, 'people');
  inst.control.setKind(1, false);
  assert.equal(got.model.at(-1).kinds[1].on, false);
  inst.control.setPlace('0');
  assert.equal(got.model.at(-1).place, '0');
  inst.control.setDemo(true);
  assert.equal(got.model.at(-1).demo, true);
  inst.control.setDemo(false);
  inst.control.select(3);
  const info = got.select.at(-1);
  assert.ok(info && typeof info.ref === 'string' && info.kindName && info.curve, '选中的星交给页面（带亮度曲线的画布）');
  info.open();
  assert.deepEqual(opened, [info.ref]);
  info.close();
  assert.equal(got.select.at(-1), null, '取消选中：页面关掉小卡');
  inst.control.toggleMax();
  await new Promise((r) => setImmediate(r));
  assert.ok(maxRoot.classList.contains('mem-sky-max'), '放大的是页面给的那一块');
  assert.equal(got.model.at(-1).max, true);
  inst.control.escape();
  assert.ok(!maxRoot.classList.contains('mem-sky-max'));
  inst.hide();
});
