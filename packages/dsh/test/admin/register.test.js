// 管理页的注册（§13.1）：只用 ctx.connection.fetch.register 的主人专用路由，绝不用 webServer.register（F19、附录 G）；
// 没有 connection 服务就什么都不注册（fail closed）；dispose 撤掉全部路由。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { registerAdmin, ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { makeFakePm, makeFakeHost, makeFakeCtx, dispatch } from './fixtures.js';

const ORIGIN = 'http://127.0.0.1:41234';
const tokenOf = (html) => /<meta name="pm-admin-token" content="([^"]+)">/.exec(html)?.[1];

test('只注册四条精确的 Fetch 路由（GET 页面 / 数据 / 下载，POST 操作），不碰 webServer', () => {
  const ctx = makeFakeCtx();
  const dispose = registerAdmin(ctx, { pm: makeFakePm(), host: makeFakeHost() });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual([...ctx.routes.keys()].sort(), Object.values(ROUTES).sort());
  for (const p of Object.values(ROUTES)) assert.match(p, /^\/api\/persona-memory\/[A-Za-z.]+$/, '要在 /api 下（DSH 的 /api 围栏和 Cookie 先过一遍）');
  assert.deepEqual(ctx.routes.get(ROUTES.page).methods, ['GET']);
  assert.deepEqual(ctx.routes.get(ROUTES.data).methods, ['GET']);
  assert.deepEqual(ctx.routes.get(ROUTES.act).methods, ['POST']);
  assert.deepEqual(ctx.routes.get(ROUTES.file).methods, ['GET']);
  for (const r of ctx.routes.values()) assert.equal(r.requestBody, 'buffered');
  assert.equal(ctx.webServerCalls.length, 0, 'webServer.register 不鉴权、还会绕过 /api 的围栏，管理页绝不能用');
  dispose();
});

test('不是主人的请求在 DSH 那一层就是 403；主人拿到页面，页面里带每个进程随机的令牌，数据路由要它', async () => {
  const ctx = makeFakeCtx();
  const dispose = registerAdmin(ctx, { pm: makeFakePm(), host: makeFakeHost() });
  const guest = await dispatch(ctx, new Request(`${ORIGIN}${ROUTES.page}`), { principal: 'guest' });
  assert.equal(guest.status, 403);
  const page = await dispatch(ctx, new Request(`${ORIGIN}${ROUTES.page}`, { headers: { 'sec-fetch-site': 'same-origin' } }));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  const token = tokenOf(html);
  assert.ok(token && token.length >= 24 && token !== '__PM_TOKEN__');
  const noToken = await dispatch(ctx, new Request(`${ORIGIN}${ROUTES.data}?view=overview`, { headers: { 'sec-fetch-site': 'same-origin' } }));
  assert.equal(noToken.status, 403);
  const ok = await dispatch(ctx, new Request(`${ORIGIN}${ROUTES.data}?view=overview`, { headers: { 'sec-fetch-site': 'same-origin', [TOKEN_HEADER]: token } }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  // 另一个进程（另一次注册）的令牌不一样
  dispose();
  const ctx2 = makeFakeCtx();
  const d2 = registerAdmin(ctx2, { pm: makeFakePm(), host: makeFakeHost() });
  const html2 = await (await dispatch(ctx2, new Request(`${ORIGIN}${ROUTES.page}`))).text();
  assert.notEqual(tokenOf(html2), token);
  d2();
});

test('没有 connection 服务：什么都不注册，只记一条警告（fail closed，不退回 webServer）', () => {
  const ctx = makeFakeCtx({ connection: false });
  const dispose = registerAdmin(ctx, { pm: makeFakePm(), host: makeFakeHost() });
  assert.equal(typeof dispose, 'function');
  assert.equal(ctx.routes.size, 0);
  assert.equal(ctx.webServerCalls.length, 0);
  assert.ok(ctx.logs.some(([lvl, m]) => lvl === 'warn' && /admin\.unavailable/.test(m)));
  dispose();
});

test('dispose 撤掉全部路由，重复调用没事；注册到一半出错会撤掉已经注册的再抛', () => {
  const ctx = makeFakeCtx();
  const dispose = registerAdmin(ctx, { pm: makeFakePm(), host: makeFakeHost() });
  assert.equal(ctx.routes.size, 4);
  dispose();
  assert.equal(ctx.routes.size, 0);
  dispose();
  // 插件重载：同一个 connection 再注册一次不冲突
  const again = registerAdmin(ctx, { pm: makeFakePm(), host: makeFakeHost() });
  assert.equal(ctx.routes.size, 4);
  again();

  const bad = makeFakeCtx();
  const real = bad.connection.fetch.register;
  let n = 0;
  bad.connection.fetch.register = (r) => { if (++n === 3) throw new Error('boom'); return real(r); };
  assert.throws(() => registerAdmin(bad, { pm: makeFakePm(), host: makeFakeHost() }), /boom/);
  assert.equal(bad.routes.size, 0, '已经注册的两条要撤掉');
});

test('没有 pm 就不注册（registerAdmin 抛 TypeError，宿主那边兜住）', () => {
  const ctx = makeFakeCtx();
  assert.throws(() => registerAdmin(ctx, { pm: null, host: makeFakeHost() }), TypeError);
  assert.equal(ctx.routes.size, 0);
});

test('导出目录：没给就用 <宿主状态里的 dataDir>/backup/export，用到时才查', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-admin-reg-'));
  try {
    const host = makeFakeHost();
    const st = host.status;
    let asked = 0;
    host.status = () => { asked += 1; return { ...st.call(host), dataDir }; };
    const pm = makeFakePm();
    const ctx = makeFakeCtx();
    const dispose = registerAdmin(ctx, { pm, host });
    assert.equal(asked, 0, '注册时不查');
    const html = await (await dispatch(ctx, new Request(`${ORIGIN}${ROUTES.page}`))).text();
    const token = tokenOf(html);
    const res = await dispatch(ctx, new Request(`${ORIGIN}${ROUTES.act}`, { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: token }, body: JSON.stringify({ action: 'backup.export' }) }));
    assert.equal(res.status, 200);
    const call = pm.calls.find((c) => c.name === 'admin.backup.exportJsonl');
    assert.equal(call.args[0].dest, `${path.join(dataDir, 'backup', 'export')}${path.sep}`);
    assert.equal((await res.json()).result.name, 'pm-export-20261104T063000Z.jsonl', '只回文件名，不回路径');
    dispose();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('设置侧边栏的入口（client.js）：「记忆」一节用同源 iframe 打开 ROUTES.page（文档相对路径）', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'admin', 'client.js');
  const src = fs.readFileSync(file, 'utf8');
  let mod = null;
  const sandbox = { window: { __ModuleLoader__: { load: ({ id, factory }) => { mod = { id, exports: factory((n) => { if (n === 'react') return { useEffect() {}, useRef: () => ({ current: null }), useState: (v) => [v, () => {}], createElement: (t, p, ...k) => ({ t, p, k }) }; throw new Error(n); }) }; } } } };
  vm.runInNewContext(src, sandbox, { filename: 'client.js' });
  assert.equal(mod.id, 'dsh-rugu');
  assert.equal(mod.exports.PAGE, ROUTES.page.slice(1), 'DSH 的界面路由是文档相对的（可能挂在子路径下）');
  const regs = [];
  mod.exports.apply({ slots: { inject: (_n, fn) => fn(), register: (def, Comp) => regs.push({ def, Comp }) } });
  assert.equal(regs.length, 1);
  assert.equal(regs[0].def.name, 'settings.section');
  assert.equal(regs[0].def.label(), '记忆');
  assert.deepEqual([...mod.exports.inject], ['slots']);
});
