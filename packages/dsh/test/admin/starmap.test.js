// 星图（D163）：集成层的三个只读视图、页面把星图脚本塞进去、假数据合 §3.1 的形状、页面里的纯函数（亮度和核心同一个式子、布局确定）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setup, TOKEN, ORIGIN } from './helpers.js';
import { makeFakePm, NOW } from './fixtures.js';
import { makeStarmap } from './starmap-fixtures.js';
import { checkStarmapSnapshot, checkStarmapLive, checkStarmapPeek, STAR_COLS } from './starmap-shape.js';
import { createAdminHandlers, ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { renderPage, pageCsp, pageTemplate, starmapScript, STARMAP_SLOT } from '../../src/admin/page.js';
import { traceSum } from '../../../core/src/dynamics/actr.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SRC = fs.readFileSync(new URL('../../src/admin/starmap.client.js', import.meta.url), 'utf8');
/** 把页面脚本放进一个只有 window 的沙箱里跑：纯函数在 window.__pmStarmap.lib 上，加载时不碰 DOM。 */
function loadLib() {
  const ctx = { window: {} };
  vm.runInNewContext(SRC, ctx);
  return ctx.window.__pmStarmap.lib;
}

// ── 假数据 ─────────────────────────────────────────────────────────────────
test('假数据合 §3.1 的形状：快照、增量、看一眼（normal 和 2 万颗星的 big）', () => {
  for (const size of ['normal', 'big']) {
    const sky = makeStarmap({ now: NOW, size });
    const snap = sky.snapshot();
    assert.deepEqual(checkStarmapSnapshot(snap), [], size);
    assert.equal(snap.stars.rows.length, size === 'big' ? 20_000 : 2000);
    const live = sky.live(snap.cursor, NOW + 5000);
    assert.deepEqual(checkStarmapLive(live), [], size);
    const refs = snap.stars.rows.slice(0, 30).map((r) => r[0]);
    assert.deepEqual(checkStarmapPeek(sky.peek(refs.slice(0, 24)), refs), [], size);
  }
});

test('假数据像真的：长尾的人、全是 0 的 closeness、跨场合的想起、夜间整理、被取代和过时的、没到点的意图；同一个种子每次一样', () => {
  const s = makeStarmap({ now: NOW }).snapshot();
  const rows = s.stars.rows;
  assert.equal(s.people[0].self, true);
  assert.ok(s.people.length >= 20, '她自己、主人和二十多个别人');
  assert.ok(s.people.slice(2).every((p) => p.closeness === 0), '除了她和主人，closeness 全是 0（真实库就是这样）');
  assert.ok(s.people[0].n + s.people[1].n > rows.length * 0.6, '她自己和主人的星占大头');
  assert.ok(s.people.some((p) => p.n > 0 && p.n <= 3), '有只有一两颗星的人');
  assert.equal(s.places.length, 5);
  for (let i = 1; i < s.places.length; i++) assert.ok(s.places[i - 1].n >= s.places[i].n, '场合按星数降序');
  assert.ok(rows.some((r) => r[5] === -1) && rows.some((r) => r[6].length === 0), '有没记下场合的、没认出是谁的');
  assert.ok(rows.filter((r) => r[7] === 1 && r[8] >= 0).length >= 30, '几十对被取代的');
  assert.ok(rows.some((r) => r[7] === 2), '有过时的');
  assert.ok(rows.some((r) => r[2] === 'intention' && r[7] === 0), '有没到点的意图');
  assert.ok(s.recalls.length >= 1000, '上千条想起');
  const items = s.recalls.flatMap((r) => r[2].map(([i]) => rows[i][5] !== r[1]));
  assert.ok(items.filter(Boolean).length > items.length * 0.2, '很多想起是跨场合的');
  assert.deepEqual(new Set(s.recalls.flatMap((r) => r[2].map((x) => x[1]))), new Set([0, 1, 2]), '三种层都有');
  assert.ok(s.tells.length > s.recalls.length, '说起比想起多（真实库就是这样）');
  assert.ok(s.nights.length >= 9 && s.traces.some((t) => t[4] === 7), '每晚有 replay');
  assert.ok(s.nights.every((t) => new Date(t + 8 * HOUR).getUTCHours() === 4), '夜间整理在北京时间 4 点多');
  assert.ok(s.traces.some((t) => t[4] === 9), '有折叠掉的老痕迹');
  assert.ok(s.mood.length > 100 && s.heard.length > 100);
  assert.deepEqual(makeStarmap({ now: NOW }).snapshot(), s, '确定性');
  // 增量：每次调用给出一两条新的想起，游标往前走
  const sky = makeStarmap({ now: NOW });
  let cur = sky.snapshot().cursor; let got = 0;
  for (let k = 0; k < 12; k++) { const l = sky.live(cur, NOW + k * 3000); got += l.recalls.length; assert.ok(l.cursor.inj >= cur.inj); cur = l.cursor; }
  assert.ok(got >= 3, '预览里「此刻」看得到新的想起');
});

test('形状检查挑得出毛病（核心的真实现以后也拿它验）', () => {
  const s = makeStarmap({ now: NOW }).snapshot();
  const bad = structuredClone(s);
  bad.stars.cols = STAR_COLS.slice(1);
  bad.stars.rows[0][1] = 7;
  bad.stars.rows[1][6] = [0, 0];
  bad.traces[0][0] = 999_999;
  bad.recalls.reverse();
  bad.people[2].self = true;
  const out = checkStarmapSnapshot(bad);
  for (const want of ['stars.cols', 'stars.rows[0].k', 'stars.rows[1].who', 'traces[0][0]', 'recalls', 'people']) assert.ok(out.some((x) => x.startsWith(want)), want);
  assert.ok(checkStarmapLive({ now: NOW, rev: 'x', cursor: { inj: -1, trace: 0, told: 0 }, traces: [[1, NOW, 1, 0.5, 0]], recalls: [], tells: [] }).length >= 2);
  assert.ok(checkStarmapPeek({ items: [{ ref: 'p1', title: null, text: 'x', at: NOW }] }).length >= 1, '原话不是星');
});

// ── 集成层的视图 ───────────────────────────────────────────────────────────
test('starmap：场合换成管理页的叫法，人名截短，数字数组原样给', async () => {
  const s = setup();
  const r = await s.view('starmap');
  assert.equal(r.status, 200);
  const d = r.body.data;
  const raw = makeStarmap({ now: NOW }).snapshot();
  assert.equal(d.stars.rows.length, raw.stars.rows.length);
  assert.deepEqual(d.stars.cols, STAR_COLS);
  assert.deepEqual(d.traces, raw.traces);
  assert.deepEqual(d.recalls, raw.recalls);
  assert.deepEqual(Object.keys(d.places[0]).sort(), ['adapter', 'key', 'n', 'oneOnOne', 'title']);
  assert.ok(d.places.some((p) => p.title === '周末开黑群'), '主人起的名字优先');
  assert.ok(d.places.some((p) => p.title === '和你的私聊'));
  assert.ok(d.places.every((p) => !('label' in p) && !('hint' in p)));
  assert.ok(d.people.every((p) => [...p.name].length <= 61));
  assert.equal(d.people[0].self, true);
  assert.deepEqual(d.params, { ageFloorMs: 180_000, timeUnitMs: HOUR });
});

test('starmap：15 秒内同一份缓存（now 换成新的），过了再问核心；增量里 rev 变了缓存作废', async () => {
  const s = setup();
  const a = (await s.view('starmap')).body.data;
  s.clock.t += 5000;
  const b = (await s.view('starmap')).body.data;
  assert.equal(s.callsOf('admin.starmap').length, 1);
  assert.equal(b.now, a.now + 5000);
  s.clock.t += 11_000;
  await s.view('starmap');
  assert.equal(s.callsOf('admin.starmap').length, 2);
  // rev 变了：下一次快照重算
  const pm = s.pm; const orig = pm.admin.starmap;
  pm.admin.starmap = (q) => (q.since ? { ...orig(q), rev: 'changed' } : orig(q));
  await s.view('starmapLive', { inj: '0', trace: '0', told: '0' });
  await s.view('starmap');
  assert.equal(s.callsOf('admin.starmap').length, 4, '快照、快照、增量、（rev 变了）快照');
});

test('starmapLive：游标三个都要是非负整数；给出增量', async () => {
  const s = setup();
  const snap = (await s.view('starmap')).body.data;
  const r = await s.view('starmapLive', { inj: String(snap.cursor.inj), trace: String(snap.cursor.trace), told: String(snap.cursor.told) });
  assert.equal(r.status, 200);
  assert.deepEqual(checkStarmapLive(r.body.data), []);
  const q = s.callsOf('admin.starmap').at(-1).args[0];
  assert.deepEqual(q, { since: snap.cursor });
  for (const bad of [{ inj: '-1', trace: '0', told: '0' }, { inj: '1', trace: 'x', told: '0' }, { inj: '1', trace: '0' }]) {
    const e = await s.view('starmapLive', bad);
    assert.equal(e.status, 400, JSON.stringify(bad));
  }
});

test('starmapPeek：引用逐个过 opaque、最多 24 个；标题和正文截短', async () => {
  const s = setup();
  const ok = await s.view('starmapPeek', { refs: 'a101,e3,t2' });
  assert.equal(ok.status, 200);
  assert.deepEqual(checkStarmapPeek(ok.body.data, ['a101', 'e3', 't2']), []);
  assert.deepEqual(s.callsOf('admin.starmap').at(-1).args[0], { peek: ['a101', 'e3', 't2'] });
  assert.equal((await s.view('starmapPeek', { refs: Array.from({ length: 25 }, (_, i) => `a${i + 1}`).join(',') })).status, 400);
  assert.equal((await s.view('starmapPeek', { refs: 'a1,<x>' })).status, 400);
  assert.equal((await s.view('starmapPeek', {})).status, 400);
  // 截短
  const pm = makeFakePm();
  pm.admin.starmap = () => ({ items: [{ ref: 'a1', title: '题'.repeat(300), text: '字'.repeat(500), at: NOW }] });
  const s2 = setup({ pm });
  const d = (await s2.view('starmapPeek', { refs: 'a1' })).body.data.items[0];
  assert.ok([...d.title].length <= 81 && [...d.text].length <= 201);
});

test('老核心（没有 admin.starmap）：三个视图都给 {unsupported: true}；读不出来照常报错', async () => {
  const s = setup({ scenario: 'old' });
  assert.deepEqual((await s.view('starmap')).body.data, { unsupported: true });
  assert.deepEqual((await s.view('starmapLive', { inj: '0', trace: '0', told: '0' })).body.data, { unsupported: true });
  assert.deepEqual((await s.view('starmapPeek', { refs: 'a1' })).body.data, { unsupported: true });
  const e = setup({ scenario: 'errors' });
  const r = await e.view('starmap');
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'INTERNAL');
  const empty = (await setup({ scenario: 'empty' }).view('starmap')).body.data;
  assert.equal(empty.stars.rows.length, 0);
  assert.equal(empty.people[0].name, '', '她自己的档案没名字时给空（页面写「她」）');
});

test('视图名单里有星图的三个；设置模式下不开', async () => {
  const s = setup();
  for (const v of ['starmap', 'starmapLive', 'starmapPeek']) assert.ok(s.h.views.names.includes(v), v);
  const h = createAdminHandlers({ setupMode: true, host: null, token: TOKEN, log: { info() {}, warn() {}, error() {} } });
  const r = await h.data(new Request(`${ORIGIN}${ROUTES.data}?view=starmap`, { headers: { [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'same-origin' } }));
  assert.equal(r.status, 503);
});

// ── 页面 ───────────────────────────────────────────────────────────────────
test('renderPage 把星图脚本塞进主脚本前面的占位处；没有残留的占位符；CSP 没变', () => {
  const html = renderPage({ nonce: 'abc123', token: 'tok' });
  assert.ok(pageTemplate().includes(`<script nonce="__PM_NONCE__">${STARMAP_SLOT}</script>`));
  assert.ok(html.includes(`<script nonce="abc123">${starmapScript()}</script>`));
  assert.ok(html.indexOf('window.__pmStarmap = { mount, lib }') < html.indexOf("const TOKEN = document.querySelector('meta[name=\"pm-admin-token\"]')"), '在主脚本前面');
  assert.ok(!/__PM_[A-Z]+__/.test(html), '没有残留的占位符');
  assert.equal(pageCsp('abc123'), ["default-src 'none'", "script-src 'nonce-abc123'", "style-src 'nonce-abc123'", "connect-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'"].join('; '));
});

test('星图脚本守管理页的规矩：没有 </script、不拼 HTML、不 eval、不起 Worker、不写 style 属性、不用外部资源', () => {
  assert.ok(!/<\/script/i.test(SRC));
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'Worker(', '.scrollIntoView(', "setAttribute('style'", 'https://', 'fetch(', 'import(']) {
    assert.ok(!SRC.includes(bad), bad);
  }
  assert.ok(!/__PM_/.test(SRC), '脚本里不能有占位符的字样');
  // 页面里的星图页签和样式
  const page = pageTemplate();
  assert.ok(page.includes("['starmap', '星图', Starmap]"));
  assert.ok(/\.pm-sm-sky\{/.test(page));
});

// ── 纯函数 ─────────────────────────────────────────────────────────────────
test('亮度：和核心 dynamics/actr.js 的 traceSum 对同样的痕迹给出同样的数', () => {
  const L = loadLib();
  const p = { ageFloorMin: 3, timeUnitMs: HOUR };
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let k = 0; k < 200; k++) {
    const n = 1 + Math.floor(rnd() * 8);
    const traces = Array.from({ length: n }, () => ({ t: NOW - rnd() * 30 * DAY, w: 0.2 + rnd() * 1.5, d: 0.3 + rnd() * 0.7 })).sort((a, b) => a.t - b.t);
    const T = NOW - rnd() * 10 * DAY;
    const core = traceSum({ traces, agg: null }, T, p);
    const page = L.traceSumAt(traces.map((x) => x.t), traces.map((x) => x.w), traces.map((x) => x.d), 0, n, T, 3 * 60_000, HOUR);
    assert.ok(Math.abs(core - page) <= 1e-12 * Math.max(1, Math.abs(core)), `${core} vs ${page}`);
  }
  // 刚记下（不到 3 分钟）按 3 分钟算；还没发生的痕迹不算
  const t0 = NOW;
  assert.equal(L.traceSumAt([t0], [1], [0.5], 0, 1, t0 + 1000, 180_000, HOUR), Math.pow(0.05, -0.5));
  assert.equal(L.traceSumAt([t0], [1], [0.5], 0, 1, t0 - 1, 180_000, HOUR), 0);
});

test('亮度映射：单调、有下限、被取代的 ×0.35；没有痕迹用 b 兜底', () => {
  const L = loadLib();
  assert.equal(L.brightOf(-Infinity), 0);
  let prev = -1;
  for (let B = -6; B <= 3; B += 0.25) { const v = L.brightOf(B); assert.ok(v >= prev && v >= 0.06 && v <= 1); prev = v; }
  assert.ok(Math.abs(L.brightOf(-3.5) - 0.06) < 1e-9);
  assert.equal(L.brightOf(1), 1);
  assert.ok(Math.abs(L.brightOf(0, true) - L.brightOf(0) * 0.35) < 1e-12);
  const snap = makeStarmap({ now: NOW }).snapshot();
  const m = L.buildModel(snap);
  const none = [...Array(m.n).keys()].find((i) => m.trStart[i + 1] === m.trStart[i]);
  assert.ok(none != null);
  assert.equal(L.starB(m, none, NOW), Number.isFinite(m.b[none]) ? m.b[none] : -3.2);
});

test('按人摆：确定、她在正中、圆盘不重叠、两个人的事在两团之间；没有她的档案时补一个「她」', () => {
  const L = loadLib();
  const snap = makeStarmap({ now: NOW }).snapshot();
  const a = L.layoutPeople(L.buildModel(snap));
  const b = L.layoutPeople(L.buildModel(structuredClone(snap)));
  assert.deepEqual([...a.p], [...b.p], '同样的数据永远同样的图');
  assert.deepEqual([a.discs[0].x, a.discs[0].y, a.discs[0].pi], [0, 0, 0]);
  for (let i = 0; i < a.discs.length; i++) for (let j = i + 1; j < a.discs.length; j++) {
    const d = a.discs[i]; const e = a.discs[j];
    assert.ok(Math.hypot(d.x - e.x, d.y - e.y) >= d.r + e.r, `${i} 和 ${j} 重叠了`);
  }
  assert.ok(a.discs.some((d) => d.pi === -1), '没认出是谁的自成一团');
  // closeness 全是 0：按给的顺序（星多的在前）由近到远——排在后面的人整体离她更远（人摆在横向拉长的椭圆上，按椭圆半径比）
  const er = (d) => Math.hypot(d.x / 1.9, d.y);
  const others = a.discs.filter((d) => d.pi > 1);
  const mean = (xs) => xs.reduce((x, y) => x + er(y), 0) / xs.length;
  assert.ok(mean(others.slice(-8)) > mean(others.slice(0, 8)) + 3, '星少的人在外圈');
  // 桥：两个人的星落在两团之间（比家的半径远）
  const m = L.buildModel(snap);
  const i = [...Array(m.n).keys()].find((k) => m.who[k].length >= 2 && m.who[k][0] === 1 && m.who[k][1] === 0);
  const home = a.discOf.get(1);
  assert.ok(Math.hypot(a.p[i * 2] - home.x, a.p[i * 2 + 1] - home.y) > 3);
  // 没有她的档案：people 里没有 self 的项 → 补一个
  const noSelf = structuredClone(snap);
  noSelf.people = noSelf.people.slice(1);
  for (const r of noSelf.stars.rows) r[6] = r[6].filter((w) => w !== 0).map((w) => w - 1);
  const m2 = L.buildModel(noSelf);
  assert.equal(m2.people[0].self, true);
  assert.equal(m2.people[0].virtual, true);
  assert.equal(m2.people[1].principal, true, '下标跟着挪了');
  // 她不在第一个：挪到第一个
  const moved = structuredClone(snap);
  const [self] = moved.people.splice(0, 1); moved.people.splice(2, 0, self);
  for (const r of moved.stars.rows) r[6] = r[6].map((w) => (w === 0 ? 2 : w <= 2 ? w - 1 : w));
  const m3 = L.buildModel(moved);
  assert.equal(m3.people[0].self, true);
  assert.deepEqual(m3.who, m.who);
});

test('按时间摆：河道铺满 0..1、按星数排、道高有下限；x 是离 t0 的小时数；刻度按时间升序', () => {
  const L = loadLib();
  const snap = makeStarmap({ now: NOW }).snapshot();
  const m = L.buildModel(snap);
  const t = L.layoutTime(m);
  assert.ok(t.lanes[0].y0 === 0 && Math.abs(t.lanes.at(-1).y1 - 1) < 1e-9);
  const withN = t.lanes.filter((l) => l.place !== -1);
  for (let i = 1; i < withN.length; i++) assert.ok(withN[i - 1].n >= withN[i].n);
  const hs = t.lanes.map((l) => l.y1 - l.y0);
  assert.ok(Math.min(...hs) >= Math.max(...hs) * 0.3, '星很少的场合（桌面会话）也有一条看得见的河道');
  assert.ok(Math.abs(t.p[0] - (m.t[0] - m.t0) / HOUR) < 1e-3);
  for (let i = 0; i < m.n; i++) { const ln = t.laneOf.get(m.place[i]); assert.ok(t.p[i * 2 + 1] >= ln.y0 && t.p[i * 2 + 1] <= ln.y1); }
  const ticks = L.timeTicks(NOW - 3 * DAY, NOW, 1000 / (3 * DAY));
  assert.ok(ticks.length >= 2);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].t > ticks[i - 1].t);
});

test('演示模式的名字：她、主人、甲乙丙…；场合：私聊 / 群 A…', () => {
  const L = loadLib();
  const d = L.demoNames([{ self: true, name: 'x' }, { principal: true, name: 'y' }, { name: 'z' }, { name: 'w' }], [{ oneOnOne: true }, { oneOnOne: false }, { oneOnOne: null }, { oneOnOne: true }]);
  assert.deepEqual(d.people, ['她', '主人', '甲', '乙']);
  assert.deepEqual(d.places, ['私聊', '群 A', '群 B', '私聊 2']);
});
