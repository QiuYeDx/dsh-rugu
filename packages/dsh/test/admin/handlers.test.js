// 管理接口的 HTTP 层（§13.1、§12.3）：DSH 的鉴权之外再加的两道（页面令牌、Sec-Fetch-Site），请求体的限制，
// 错误到状态码的映射，下载路由只认导出目录里的导出文件，日志只有路由、状态码和操作名，不带任何内容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { renderPage, pageCsp, pageTemplate } from '../../src/admin/page.js';
import { setup, TOKEN, ORIGIN } from './helpers.js';

const post = (h, body, headers = {}) => h.act(new Request(`${ORIGIN}${ROUTES.act}`, { method: 'POST', headers, body }));

test('数据、操作、下载都要页面令牌；页面本身不要（它就是发令牌的地方）', async () => {
  const s = setup();
  for (const [fn, req] of [
    [s.h.data, new Request(`${ORIGIN}${ROUTES.data}?view=overview`)],
    [s.h.data, new Request(`${ORIGIN}${ROUTES.data}?view=overview`, { headers: { [TOKEN_HEADER]: 'wrong-token-of-same-length!' } })],
    [s.h.act, new Request(`${ORIGIN}${ROUTES.act}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"backup.now"}' })],
    [s.h.file, new Request(`${ORIGIN}${ROUTES.file}?name=pm-export-x.jsonl`)],
  ]) {
    const res = await fn(req);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'FORBIDDEN');
  }
  assert.equal(s.callsOf('admin.backup.now').length, 0);
  const page = await s.h.page(new Request(`${ORIGIN}${ROUTES.page}`));
  assert.equal(page.status, 200);
});

test('跨站请求一律 403（即使带着令牌）；同源和直接打开的放行', async () => {
  const s = setup();
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await s.view('overview', {}, { 'sec-fetch-site': site })).status, 403);
    assert.equal((await s.act('backup.now', {}, { 'sec-fetch-site': site })).status, 403);
    assert.equal((await s.h.page(new Request(`${ORIGIN}${ROUTES.page}`, { headers: { 'sec-fetch-site': site } }))).status, 403);
  }
  assert.equal(s.callsOf('admin.backup.now').length, 0);
  assert.equal((await s.view('overview', {}, { 'sec-fetch-site': 'none' })).status, 200);
});

test('方法不对 405；POST 只收 JSON、≤ 64 KB、对象、带 action', async () => {
  const s = setup();
  assert.equal((await s.h.data(new Request(`${ORIGIN}${ROUTES.data}?view=overview`, { method: 'POST', headers: s.headers(), body: '{}' }))).status, 405);
  assert.equal((await s.h.act(new Request(`${ORIGIN}${ROUTES.act}`, { headers: s.headers() }))).status, 405);
  const cases = [
    [{ 'content-type': 'text/plain' }, '{"action":"backup.now"}', 415, 'MEDIA_TYPE'],
    [{ 'content-type': 'application/json' }, JSON.stringify({ action: 'rules.add', note: 'x'.repeat(70_000) }), 413, 'TOO_LARGE'],
    [{ 'content-type': 'application/json' }, '{not json', 400, 'BAD_INPUT'],
    [{ 'content-type': 'application/json' }, '[1,2]', 400, 'BAD_INPUT'],
    [{ 'content-type': 'application/json' }, '{"x":1}', 400, 'BAD_INPUT'],
    [{ 'content-type': 'application/json' }, '{"action":"drop.everything"}', 400, 'BAD_INPUT'],
    [{ 'content-type': 'application/json' }, '{"action":"__proto__"}', 400, 'BAD_INPUT'],
  ];
  for (const [hd, body, status, code] of cases) {
    const res = await post(s.h, body, s.headers(hd));
    assert.equal(res.status, status, body.slice(0, 40));
    assert.equal((await res.json()).code, code);
  }
  const v = await s.view('nope');
  assert.equal(v.status, 400);
  assert.equal(v.body.path, 'view');
});

test('响应头：no-store、nosniff、不带 referrer；页面带 nonce 的 CSP，只许被 DSH 自己的页面嵌入', async () => {
  const s = setup();
  const r = await s.view('overview');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const page = await s.h.page(new Request(`${ORIGIN}${ROUTES.page}`));
  const csp = page.headers.get('content-security-policy');
  const html = await page.text();
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`));
  assert.ok(html.includes(`content="${TOKEN}"`));
  assert.ok(!html.includes('__PM_NONCE__') && !html.includes('__PM_TOKEN__'));
  // 两次打开的 nonce 不同
  const csp2 = (await s.h.page(new Request(`${ORIGIN}${ROUTES.page}`))).headers.get('content-security-policy');
  assert.notEqual(csp2, csp);
});

test('页面脚本只用文本节点渲染别人可控的字符串：没有 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval', () => {
  const html = pageTemplate();
  const script = html.slice(html.indexOf('<script nonce='), html.lastIndexOf('</script>'));
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!script.includes(bad), bad);
  assert.throws(() => renderPage({ nonce: 'a"b', token: 'x' }), TypeError);
  assert.throws(() => renderPage({ nonce: 'abc', token: '<script>' }), TypeError);
  assert.match(pageCsp('abc'), /style-src 'nonce-abc'/);
});

test('页面在 DSH 设置面板的 iframe 里：只滚自己的容器（不用 scrollIntoView，它会连外层面板一起滚），滚动条样式不被 scrollbar-color 盖掉', () => {
  const html = pageTemplate();
  const script = html.slice(html.indexOf('<script nonce='), html.lastIndexOf('</script>'));
  const css = html.slice(html.indexOf('<style nonce='), html.indexOf('</style>'));
  assert.ok(!script.includes('.scrollIntoView('));
  // Chrome 121+ 见到 scrollbar-color / scrollbar-width 就不认 ::-webkit-scrollbar：只许出现在「不支持 webkit 滚动条」的兜底里，或用来藏掉页签条的滚动条
  const outside = css.replace(/@supports not selector\(::-webkit-scrollbar\)\{[^}]*\{[^}]*\}\}/g, '');
  for (const m of outside.matchAll(/scrollbar-(?:color|width):([^;}]+)/g)) assert.equal(m[1].trim(), 'none', m[0]);
  assert.match(css, /::-webkit-scrollbar-button\{display:none/);
});

test('下载：只认导出目录里、名字形如 pm-export-….jsonl / .pmpack 的文件，不收路径', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-admin-file-'));
  try {
    fs.writeFileSync(path.join(dir, 'pm-export-20261104T063000Z.jsonl'), '{"type":"header"}\n');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
    const s = setup({ exportDir: dir });
    const get = (name) => s.h.file(new Request(`${ORIGIN}${ROUTES.file}?${new URLSearchParams({ name })}`, { headers: s.headers() }));
    const ok = await get('pm-export-20261104T063000Z.jsonl');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-disposition'), /^attachment; filename="pm-export-20261104T063000Z\.jsonl"$/);
    assert.equal(ok.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(await ok.text(), '{"type":"header"}\n');
    for (const name of ['secret.txt', '../secret.txt', 'pm-export-../../x.jsonl', `pm-export-x.jsonl${path.sep}..`, 'pm-export-a/b.jsonl', '']) {
      const r = await get(name);
      assert.equal(r.status, 400, name);
    }
    assert.equal((await get('pm-export-missing.jsonl')).status, 404);
    const none = setup({ exportDir: null, host: null });
    const r = await none.h.file(new Request(`${ORIGIN}${ROUTES.file}?name=pm-export-x.jsonl`, { headers: none.headers() }));
    assert.equal(r.status, 503);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('错误映射：只读 409、找不到 404、核心契约 400；意外的错误 500，不带原始信息', async () => {
  const ro = setup({ scenario: 'errors' });
  const r1 = await ro.act('memory.hide', { ref: 'a1' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'READ_ONLY');
  const s = setup();
  assert.equal((await s.view('memory', { ref: 'a99999' })).status, 404);
  const r2 = await s.act('review.decide', { id: 999, decision: 'reject' });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.code, 'CONTRACT');
  s.pm.admin.list = () => { throw new Error('数据库里那句话：阿明的秘密'); };
  const r3 = await s.view('needToKnow');
  assert.equal(r3.status, 500);
  assert.equal(r3.body.code, 'INTERNAL');
  assert.ok(!JSON.stringify(r3.body).includes('阿明'));
});

test('日志只记路由、状态码、耗时、操作名和错误类型：没有参数、预览、记忆内容，也没有恢复码', async () => {
  const s = setup();
  await s.view('memories', { list: 'assertions', q: '快递' });
  await s.view('memory', { ref: 'a1' });
  await s.view('review');
  await s.prepare('memory.purge', { refs: ['a6'] });
  await s.act('memory.purge', { refs: ['a6'], confirm: { token: 'bogus' } });
  await s.act('rules.add', { kind: 'disclosure', target: { attribute: '健康' }, value: { restriction: 'soft' }, note: '阿明的事别跟小雨说' });
  const enc = await s.confirmAct('backup.encryption', {});
  assert.equal(enc.status, 200);
  const code = enc.body.result.recoveryCode;
  assert.ok(code);
  const text = JSON.stringify(s.logs);
  for (const leak of ['快递', '阿明', '小雨', '健康', code, 'a6', '彻底删除', TOKEN]) assert.ok(!text.includes(leak), `日志里不该有：${leak}`);
  const fields = new Set(s.logs.flatMap(([, , f]) => Object.keys(f ?? {})));
  for (const k of fields) assert.ok(['route', 'status', 'ms', 'action', 'for', 'error'].includes(k), k);
  assert.ok(s.logs.every(([, ev]) => ev === 'admin.request'));
  assert.ok(s.logs.some(([, , f]) => f.action === 'memory.purge' && f.status === 428 && f.error === 'CONFIRM_REQUIRED'));
});

test('按天计数（D159）走同一条只读路由，鉴权照旧：没有令牌、跨站的 403', async () => {
  const s = setup();
  const url = `${ORIGIN}${ROUTES.data}?view=memoryDays&list=percepts&month=2026-11&tz=480`;
  assert.equal((await s.h.data(new Request(url, { headers: { 'sec-fetch-site': 'same-origin' } }))).status, 403);
  assert.equal((await s.h.data(new Request(url, { headers: { [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'cross-site' } }))).status, 403);
  const ok = await s.h.data(new Request(url, { headers: { [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'same-origin' } }));
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((await ok.json()).data.items));
  assert.ok(s.h.views.names.includes('memoryDays'));
});
