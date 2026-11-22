// 新管理页（D170）：page.js 拼出来的页面（nonce、没有外部资源、没有 innerHTML、每个模块都在、缺了 / 坏了的表现）、新旧开关、
// base.js 里能脱离浏览器测的纯函数（路由、格式、出错的说法、主题消息的校验）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ROUTES } from '../../src/admin/index.js';
import { renderNextPage, uiParts, pickUi, UI_SCRIPTS, UI_STYLES, UI_BOOT, pageCsp } from '../../src/admin/page.js';
import { HOST_DEFAULTS, mergeHost } from '../../src/host/config.js';
import { makeFakeHost } from './fixtures.js';
import { setup, ORIGIN } from './helpers.js';

const BASE_SRC = fs.readFileSync(new URL('../../src/admin/ui/base.js', import.meta.url), 'utf8');
const UI_DIR = new URL('../../src/admin/ui/', import.meta.url);
const MODULES = ['home', 'memory', 'pending', 'places', 'settings', 'wizard'];

/** vm 里的对象换成本 realm 的（deepStrictEqual 会比原型）。 */
const plain = (x) => JSON.parse(JSON.stringify(x));
/** 在 vm 里加载 base.js（不碰 DOM：加载时只定义东西），返回 Rugu。 */
function loadBase(extra = {}) {
  const ctx = { console, URLSearchParams, setTimeout, clearTimeout, ...extra };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(BASE_SRC, ctx, { filename: 'base.js' });
  return { R: ctx.Rugu, ctx };
}

test('拼出来的新页面：每个 <script> / <style> 都带同一个 nonce；占位符没有残留；每个模块和样式都在；CSP 照旧', () => {
  const html = renderNextPage({ nonce: 'abc123', token: 'tok_1' });
  // 只数真的脚本标签（注释里提到的 <script> 不算：标签都在行首，带 nonce）
  const scripts = html.match(/^<script\b[^>]*>/gm);
  const styles = html.match(/^<style\b[^>]*>/gm);
  assert.equal(scripts.length, UI_SCRIPTS.length + 1, '每个模块一个，加上启动');
  assert.ok(scripts.every((t) => t === '<script nonce="abc123">'));
  assert.ok(styles.every((t) => /^<style nonce="abc123"/.test(t)));
  assert.equal(styles.length, 1 + UI_STYLES.length, 'shell 的 + 各模块的');
  for (const ph of ['__PM_NONCE__', '__PM_TOKEN__', '__RUGU_STYLES__', '__RUGU_SCRIPTS__']) assert.ok(!html.includes(ph), ph);
  assert.ok(html.includes('<meta name="pm-admin-token" content="tok_1">'));
  for (const m of MODULES) assert.ok(html.includes(`Rugu.define('${m}'`), m);
  for (const m of ['base', ...MODULES]) assert.ok(html.includes(`//# sourceURL=rugu-ui/${m}.js`), m);
  // base 在最前、启动在最后
  assert.ok(html.indexOf('rugu-ui/base.js') < html.indexOf("Rugu.define('home'"));
  assert.ok(html.trimEnd().endsWith('</html>'));
  assert.ok(html.lastIndexOf('Rugu.start') > html.lastIndexOf('rugu-ui/wizard.js'));
  assert.match(pageCsp('abc123'), /script-src 'nonce-abc123'/);
  assert.throws(() => renderNextPage({ nonce: 'a"b', token: 'x' }), TypeError);
  assert.throws(() => renderNextPage({ nonce: 'abc', token: '<script>' }), TypeError);
});

test('shell：内联 favicon，窄屏仍显示「回旧版」全文（不隐藏 span）', () => {
  const shell = fs.readFileSync(new URL('../../src/admin/ui/shell.html', import.meta.url), 'utf8');
  assert.match(shell, /rel="icon"[^>]+data:image\/svg\+xml/);
  assert.ok(!/\.uiswitch span\s*\{\s*display:\s*none/.test(shell));
  assert.ok(shell.includes('flex-shrink: 0') && shell.includes('.uiswitch'));
});

test('新页面的源文件：没有 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval；不加载外部资源；没有本机路径', () => {
  const files = fs.readdirSync(UI_DIR).filter((f) => /\.(js|css|html)$/.test(f));
  assert.ok(files.length >= 13);
  for (const f of files) {
    let src = fs.readFileSync(new URL(f, UI_DIR), 'utf8');
  if (f === 'shell.html') src = src.replace(/<link rel="icon"[^>]*>\n?/, '');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', "setAttribute('style'"]) assert.ok(!src.includes(bad), `${f}: ${bad}`);
    assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(src), `${f}: 外部地址`);
    const noExt = src;
    assert.ok(!/<link\b|@import|url\(\s*['"]?(?!#)/.test(noExt), `${f}: 外部样式 / 字体`);
    assert.ok(!/[A-Z]:\\\\|[A-Z]:\\[^\\]/.test(src), `${f}: 本机路径`);
  }
  // 拼出来的整页也一样（启动脚本里的回旧版只用 textContent）
  const html = renderNextPage({ nonce: 'n', token: 't' });
  assert.ok(!/innerHTML|<link\b(?!\s+rel="icon")|src="http/.test(html));
  assert.ok(!UI_BOOT.includes('innerHTML') && UI_BOOT.includes('textContent'));
});

test('某个模块的文件读不到：放一行 Rugu.missing，别的模块照常；脚本里有 </script 的当读不到', () => {
  const parts = uiParts();
  const broken = { ...parts, scripts: parts.scripts.map(([n, s]) => [n, n === 'memory' ? null : s]) };
  const html = renderNextPage({ nonce: 'n', token: 't' }, broken);
  assert.ok(html.includes('window.Rugu && window.Rugu.missing("memory"'));
  assert.ok(!html.includes("Rugu.define('memory'"));
  assert.ok(html.includes("Rugu.define('home'"));
});

test('每个模块一个 <script>：一个出语法错只坏它自己，别的照样登记；读不到的登记成 missing', () => {
  const { R, ctx } = loadBase();
  const parts = uiParts();
  const errors = [];
  for (const [name, src] of parts.scripts) {
    if (name === 'base') continue;
    const code = name === 'pending' ? `${src}\n}}}` : name === 'places' ? null : src;
    if (code == null) { vm.runInContext(`window.Rugu && window.Rugu.missing("places", 'x');`, ctx); continue; }
    try { vm.runInContext(code, ctx, { filename: `${name}.js` }); } catch (e) { errors.push([name, e.name]); }
  }
  assert.deepEqual(errors, [['pending', 'SyntaxError']]);
  const st = R.moduleStates();
  assert.equal(st.places, 'missing');
  assert.equal(st.pending, undefined, '语法坏了的没登记上（画的时候显示「这一块没打开」）');
  for (const m of ['home', 'memory', 'settings', 'wizard']) assert.equal(st[m], 'pending', m);
});

test('新旧开关：?ui= 优先，没给按 host.admin.ui（D174：默认新版，只有明确写 classic 才是旧版）；首次设置也跟着开关走（D173：新版有自己的向导）', async () => {
  assert.equal(pickUi(null, undefined), 'next', '没配置：新版');
  assert.equal(pickUi(null, null), 'next', '配置读不出来：新版');
  assert.equal(pickUi(null, 'weird'), 'next', '配置写了别的：新版');
  assert.equal(pickUi(null, 'next'), 'next');
  assert.equal(pickUi(null, 'classic'), 'classic');
  assert.equal(pickUi('classic', 'next'), 'classic');
  assert.equal(pickUi('next', 'classic'), 'next');
  assert.equal(pickUi('weird', 'classic'), 'classic', '地址上的值不认识：回头看配置');
  assert.equal(pickUi('weird', undefined), 'next');
  assert.equal(pickUi('next', 'next', true), 'next');
  assert.equal(pickUi(null, 'next', true), 'next');
  assert.equal(pickUi(null, undefined, true), 'next', '首次设置：默认也是新版的向导');
  assert.equal(pickUi(null, 'classic', true), 'classic');
  const s = setup();
  const get = async (q) => (await s.h.page(new Request(`${ORIGIN}${ROUTES.page}${q}`))).text();
  const dflt = await get('');
  assert.ok(dflt.includes("Rugu.define('home'"), '默认是新版');
  const classicPage = await get('?ui=classic');
  assert.ok(classicPage.includes('__pmStarmap') || classicPage.includes('class="pm"'), '?ui=classic 是旧版');
  assert.ok(!classicPage.includes("Rugu.define('home'"));
  assert.ok((await get('?ui=next&theme=dark')).includes("Rugu.define('home'"));
  // 默认配置本身就是新版（新装的用户没有任何配置、也没点过切换）
  assert.equal(HOST_DEFAULTS.admin.ui, 'next');
  assert.equal(mergeHost(HOST_DEFAULTS, {}).admin.ui, 'next');
  assert.equal(mergeHost(HOST_DEFAULTS, { admin: { ui: 'classic' } }).admin.ui, 'classic', '主人写 classic 仍然尊重');
  // 配置里写 classic：没给 ui 时是旧版，?ui=next 仍然能看新版
  const host = makeFakeHost();
  const get0 = host.config.get;
  host.config.get = () => { const c = get0(); c.host.admin = { ui: 'classic' }; return c; };
  const s2 = setup({ host });
  const page2 = (q) => s2.h.page(new Request(`${ORIGIN}${ROUTES.page}${q}`)).then((r) => r.text());
  assert.ok(!(await page2('')).includes("Rugu.define('home'"));
  assert.ok((await page2('?ui=next')).includes("Rugu.define('home'"));
  // 日志里记下开的是哪一版
  assert.ok(s.logs.some(([, ev, f]) => ev === 'admin.request' && f.route === 'page' && f.ui === 'next'));
  assert.ok(s2.logs.some(([, ev, f]) => ev === 'admin.request' && f.route === 'page' && f.ui === 'classic'));
});

test('旧页面：认 ?tab= 直达页签，页头有回新版的链接', () => {
  const page = fs.readFileSync(new URL('../../src/admin/page.html', import.meta.url), 'utf8');
  assert.ok(page.includes("new URLSearchParams(location.search).get('tab')"));
  assert.ok(page.includes("href: 'admin?ui=next'"));
});

test('路由：parseHash / buildHash（不认识的去处回首页，不认识的分段用默认的；参数来回一致）', () => {
  const { R } = loadBase();
  const p = (h) => { const r = R.parseHash(h); return [r.dest, r.sub, r.path, { ...r.params }]; };
  assert.deepEqual(p(''), ['home', null, 'home', {}]);
  assert.deepEqual(p('#/memory'), ['memory', 'list', 'memory/list', {}]);
  assert.deepEqual(p('#/memory/people?open=a12&q=%E9%98%BF'), ['memory', 'people', 'memory/people', { open: 'a12', q: '阿' }]);
  assert.deepEqual(p('#/memory/nope'), ['memory', 'list', 'memory/list', {}]);
  assert.deepEqual(p('#/nowhere/x'), ['home', null, 'home', {}]);
  assert.deepEqual(p('#/settings/cost'), ['settings', 'cost', 'settings/cost', {}]);
  assert.deepEqual(p('#/wizard/3'), ['wizard', '3', 'wizard/3', {}]);
  assert.equal(R.buildHash('memory/list', { open: 'a1', empty: '', no: null, off: false }), '#/memory/list?open=a1');
  assert.equal(R.buildHash('home'), '#/home');
  const h = R.buildHash('pending/approve', { q: '一 & 二' });
  assert.deepEqual(p(h)[3], { q: '一 & 二' });
  // 旧版对应的页签
  assert.equal(R.classicTab('memory/starmap'), 'starmap');
  assert.equal(R.classicTab('pending/approve'), 'review');
  assert.equal(R.classicTab('settings/backup'), 'backups');
  assert.equal(R.classicTab('nowhere'), 'overview');
  assert.equal(R.classicHref('settings/diag', 'dark'), 'admin?ui=classic&tab=diagnostics&theme=dark');
  assert.equal(R.classicHref('home', null), 'admin?ui=classic&tab=overview');
});

test('主题消息：只认同源、来自父窗口、{type: "rugu:theme", theme: light|dark}；别的一律不认', () => {
  const { R } = loadBase();
  const o = 'http://127.0.0.1:1';
  const ok = { type: 'rugu:theme', theme: 'dark' };
  assert.equal(R.themeFromMessage(ok, o, o, true), 'dark');
  assert.equal(R.themeFromMessage({ type: 'rugu:theme', theme: 'light' }, o, o, true), 'light');
  assert.equal(R.themeFromMessage(ok, 'http://evil.invalid', o, true), null, '别的来源');
  assert.equal(R.themeFromMessage(ok, o, o, false), null, '不是父窗口发的');
  assert.equal(R.themeFromMessage({ type: 'rugu:theme', theme: 'purple' }, o, o, true), null);
  assert.equal(R.themeFromMessage({ type: 'rugu:go', theme: 'dark' }, o, o, true), null, '别的消息类型');
  assert.equal(R.themeFromMessage('rugu:theme', o, o, true), null);
  assert.equal(R.themeFromMessage(null, o, o, true), null);
  assert.equal(R.themeFromMessage([ok], o, o, true), null);
  // 外壳用同一个消息类型
  const client = fs.readFileSync(new URL('../../src/admin/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes(`THEME_MESSAGE = '${R.THEME_MESSAGE}'`));
  assert.ok(client.includes('postMessage({ type: THEME_MESSAGE, theme: themeNow() }, window.location.origin)'), '只发给同源');
});

test('格式：今天 14:32 / 昨天 / 11/3 / 跨年；数、比例、钱；中文和数字之间补空格', () => {
  const { R } = loadBase();
  const now = new Date(2026, 10, 13, 15, 20).getTime();
  const at = (d, h, m = 0) => new Date(2026, 10, 13 - d, h, m).getTime();
  assert.equal(R.fmt.when(at(0, 14, 32), now), '今天 14:32');
  assert.equal(R.fmt.when(at(1, 9, 5), now), '昨天 09:05');
  assert.equal(R.fmt.when(at(10, 8), now), '11/3 08:00');
  assert.equal(R.fmt.when(new Date(2025, 0, 2).getTime(), now), '2025/1/2');
  assert.equal(R.fmt.when(null, now), '—');
  assert.equal(R.fmt.day(at(1, 1), now), '昨天');
  assert.deepEqual(plain(R.fmt.dayLabel(at(0, 1), now)), ['今天', '11月13日 周五']);
  assert.deepEqual(plain(R.fmt.dayLabel(at(2, 1), now)), ['11月11日 周三', '']);
  assert.equal(R.fmt.ago(now - 30_000, now), '刚刚');
  assert.equal(R.fmt.ago(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(R.fmt.num(1234), '1234');
  assert.equal(R.fmt.num(12_345), '1.2 万');
  assert.equal(R.fmt.num(null), '—');
  assert.equal(R.fmt.pct(0.923), '92%');
  assert.equal(R.fmt.yuan(0.08), '¥0.08');
  assert.equal(R.fmt.yuan(0.001), '不到 ¥0.01');
  assert.equal(R.fmt.yuan(0), '¥0.00');
  assert.equal(R.fmt.spaced('今天听到42句，用了DSH的模型'), '今天听到 42 句，用了 DSH 的模型');
  assert.equal(R.fmt.spaced('已经有 42 句'), '已经有 42 句');
});

test('出错的说法：只读、读不出来、500、403、连不上各有人话；服务端给了看得懂的说明就用它', () => {
  const { R } = loadBase();
  const e = (status, code, error) => new R.ApiError(status, { code, error });
  assert.equal(R.errorText(e(409, 'READ_ONLY', '数据库现在是只读的，不能改')), '记忆库现在是只读的，改不了。');
  assert.equal(R.errorText(e(409, 'READ_ONLY', 'x'), 'read'), '记忆库现在是只读的，改不了。', '只读不加「读不出来」');
  assert.match(R.errorText(e(500, 'INTERNAL', '内部错误')), /^出错了/);
  assert.match(R.errorText(e(500, 'INTERNAL', '内部错误'), 'read'), /^读不出来：出错了/);
  assert.match(R.errorText(e(403, 'FORBIDDEN', '缺少管理页令牌')), /从 DSH 的设置里打开/);
  assert.match(R.errorText(e(0, 'NETWORK', 'x')), /连不上 DSH/);
  assert.equal(R.errorText(e(400, 'BAD_INPUT', '应为 1–30 的整数')), '应为 1–30 的整数');
  assert.equal(R.errorText(e(422, 'HTTP', 'HTTP 422')), '出错了。');
  assert.match(R.errorText(e(503, 'UNAVAILABLE', '导出目录没有配置')), /导出目录没有配置/);
});

test('base.js 加载时不碰 DOM（模块在 Rugu.start 之前就能登记）；define 的模块第一次用到才初始化', () => {
  const { R } = loadBase();
  let made = 0;
  R.define('x', () => { made++; return { render() {} }; });
  assert.equal(made, 0);
  assert.deepEqual(plain(R.moduleStates()), { x: 'pending' });
  R.missing('y', '读不到');
  R.missing('x', '不会覆盖已经登记的');
  assert.deepEqual(plain(R.moduleStates()), { x: 'pending', y: 'missing' });
  assert.equal(R.DESTS.map(([k]) => k).join(','), 'home,memory,pending,places,settings');
});
