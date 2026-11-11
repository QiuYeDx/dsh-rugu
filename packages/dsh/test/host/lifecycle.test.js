import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as plugin from '../../src/index.js';
import { createHost, splitAdapter } from '../../src/host/index.js';
import { FakeDshCtx, createFakePm, fakeAgent, userMessage, fakeBinding, tmpDir, rmDir } from '../fakes/index.js';
import { makeHost, offlineFetch } from './helpers.js';

const baseDeps = (dir, extra = {}) => ({
  dshHome: dir, adapterFactories: {}, registerAdmin: null, defineTool: (d) => d, sampler: null,
  skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch, ...extra,
});
const adapterOf = (id) => ({ id, protocol: 2, describeSetting: () => ({}), selfClaims: () => [], principalClaims: () => [] });

test('插件形状：Cordis 行、服务名；空的 ctx 不打开任何东西', async () => {
  assert.equal(plugin.name, 'dsh-rugu');
  assert.equal(plugin.SERVICE_NAME, 'personaMemory');
  assert.deepEqual(plugin.inject, ['tools', 'connection']);
  const dispose = plugin.apply({}, {});
  assert.equal(typeof dispose, 'function');
  await dispose();
});

test('启动：provide 外壳、挂全部钩子、常驻区 context 的选项照 §10.4；数据目录在 DSH 家目录下（§12.1）', async () => {
  const dir = tmpDir('life');
  const ctx = new FakeDshCtx();
  const pm = createFakePm();
  let opts = null;
  const host = createHost(ctx, {}, baseDeps(dir, { coreFactory: async (o) => { opts = o; return pm; } }));
  // 同步阶段就已经 provide、挂好钩子（核心没开之前钩子一律放行）
  assert.ok(ctx.get('personaMemory'), '同步 provide personaMemory');
  for (const ev of ['agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'session/event', 'agent/created', 'agent/disposed']) assert.equal(ctx.count(ev), 1, ev);
  const c = ctx.systemPrompt.contexts.get('persona-memory:core');
  assert.ok(c);
  assert.equal(c.order, 300);
  assert.equal(c.required, true);
  assert.equal(c.interpolate, false, 'F2：一律 interpolate:false');
  assert.equal(ctx.tools.guards.length, 1, '冻结的兜底守卫');
  assert.equal(await host.ready, true);
  assert.equal(opts.dataDir, path.join(dir, 'persona-memory'));
  assert.equal(opts.keyFile, path.join(dir, 'persona-memory.key'));
  assert.equal(opts.startWorker, true, '§10.1 第 2 步：起 worker');
  assert.equal(typeof opts.config.get, 'function', '交给核心的是热加载句柄');
  assert.equal(opts.config.get().backup.keyFile, path.join(dir, 'persona-memory-backup.key'), '备份密钥默认在 DSH 家目录（§12.4.3）');
  for (const k of ['clock', 'llm', 'embedding', 'budget', 'selfProfile', 'sanitizer', 'logger']) assert.ok(opts.ports[k], `端口 ${k}`);
  assert.equal(opts.ports.rerank, undefined, '没配重排 → 没有这个端口');
  assert.equal(ctx.get('personaMemory').ready, true);
  const st = host.status();
  assert.equal(st.ready, true);
  assert.ok(st.selfCheck, '启动自检跑过');
  await host.dispose();
  assert.equal(pm.closed, true, '卸载时关库');
  for (const ev of ['agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'session/event']) assert.equal(ctx.count(ev), 0, `${ev} 已注销`);
  assert.equal(ctx.systemPrompt.contexts.size, 0);
  assert.equal(ctx.tools.guards.length, 0);
  rmDir(dir);
});

test('打开失败：插件不可用但 DSH 照常——不注入、常驻区空串、冻结照样生效；外发审不了：不是公开目标就放行（D113 fail open），外壳 appraise（公开评论那条路）照旧改口', async () => {
  const { ctx, host, cleanup } = await makeHost({ pm: null, name: 'openfail' });
  assert.equal(await host.ready, false);
  assert.equal(host.status().error, 'STORE_LOCKED');
  const agent = fakeAgent({ preset: 'zz-chat' });
  const d = await ctx.preStep(agent, [userMessage('在吗')]);
  assert.equal(d.messages.length, 2, '原样返回');
  assert.equal(ctx.resolveContexts(agent)[0].text, '');
  const ok = await ctx.preExecute({ name: 'zz_send', callId: 'c1', agent, arguments: { text: 'hi' } });
  assert.equal(ok.decision.kind, 'allow', '原地说话不受影响（插件坏了不能让她在原来的对话里说不了话）');
  // 往别的场合说的话审不了：宿主认不出那是公开场合 → 放行（D113 fail open；只有公开目标才改口）
  const away = await ctx.preExecute({ name: 'zz_send', callId: 'c1b', agent, arguments: { text: '今晚大家几点开黑', target: 'set-group' } });
  assert.equal(away.decision.kind, 'allow');
  const unresolved = await ctx.preExecute({ name: 'zz_send', callId: 'c1c', agent, arguments: {} });
  assert.equal(unresolved.decision.kind, 'allow', '目标解析不出来：也放行');
  assert.equal(host.status().egress.coreDownDenied, 0);
  assert.equal(host.status().egress.coreDownPassed, 3);
  const frozen = await ctx.preExecute({ name: 'mcp__snowluma__qq_memory_append', callId: 'c2', agent, arguments: {} });
  assert.equal(frozen.decision.kind, 'deny', '冻结不需要核心（§15.2）');
  const svc = ctx.get('personaMemory');
  assert.equal(svc.ready, false);
  assert.deepEqual(await svc.expression.appraise({ channel: {}, text: ['x'], origin: { path: 'background' } }), { verdict: 'reconsider', reflection: '这次先不说了', token: 'unavailable' },
    '外来适配器（bili-eyes 的公开评论）在核心打不开时拿到的是改口，不是放行');
  assert.equal((await svc.recall({ settingId: 's', trigger: 'message' }, {})).items.length, 0);
  await assert.rejects(() => svc.note({}), (e) => e.code === 'NOT_READY');
  // 只给主人看的状态页（同一个路径），带出错的代码；没有正式管理页的数据接口
  const page = ctx.connection.fetch.routes.find((r) => r.path === '/api/persona-memory/admin');
  assert.ok(page, '注册了状态页');
  const res = await page.fetch(new Request('http://127.0.0.1/api/persona-memory/admin'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /记忆插件没有启动（<code>STORE_LOCKED<\/code>）/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const data = ctx.connection.fetch.routes.find((r) => r.path === '/api/persona-memory/admin.data');
  assert.equal((await data.fetch(new Request('http://127.0.0.1/api/persona-memory/admin.data?view=overview'))).status, 503);
  assert.equal(ctx.connection.fetch.routes.some((r) => r.path === '/api/persona-memory/admin.do'), false, '状态页不能做任何操作');
  await cleanup();
  assert.equal(ctx.connection.fetch.routes.length, 0, '卸载时撤掉');
});

test('只读的核心（插件被回退、库比代码新）：modeOf 全是 off，外发按审不了处理——不是公开目标就放行（D113），不问只读的核心', async () => {
  const pm = createFakePm();
  pm.readOnly = true;
  pm.modeOf = () => 'off';
  pm.expression.appraise = async () => ({ verdict: 'speak', token: 'read-only' });
  const { ctx, host, cleanup } = await makeHost({ pm, name: 'readonly' });
  const agent = fakeAgent({ preset: 'zz-chat' });
  await ctx.preStep(agent, [userMessage('在吗')]);
  assert.equal((await ctx.preExecute({ name: 'zz_send', callId: 'a', agent, arguments: { text: '嗯' } })).decision.kind, 'allow');
  assert.equal((await ctx.preExecute({ name: 'zz_send', callId: 'b', agent, arguments: { text: '晚上好', target: 'set-group' } })).decision.kind, 'allow');
  assert.equal(host.status().egress.coreDownPassed, 2);
  assert.equal(pm.named('appraise').length, 0, '只读的核心一律答 speak：不问它');
  const svc = ctx.get('personaMemory');
  assert.equal((await svc.expression.appraise({ channel: {}, text: ['x'], origin: { path: 'background' } })).verdict, 'reconsider');
  await cleanup();
});

test('核心还没打开（启动的那一会儿）：内置适配器的绑定已经在了，会话认得出来；审不了、不是公开目标 → 放行（D113）', async () => {
  const dir = tmpDir('opening');
  const ctx = new FakeDshCtx();
  const pm = createFakePm();
  let release;
  const gate = new Promise((r) => { release = r; });
  const qqBinding = fakeBinding({ adapterId: 'qq', preset: 'qq-chat' });
  const host = createHost(ctx, { host: { adapters: { qq: { bridgeDir: path.join(dir, 'bridge') } } } },
    baseDeps(dir, { coreFactory: async () => { await gate; return pm; }, adapterFactories: { qq: () => ({ adapter: adapterOf('qq'), binding: qqBinding }) } }));
  // 等适配器建好（核心还卡在打开那一步）
  for (let i = 0; i < 50 && !host.claims.binding('qq'); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(host.claims.binding('qq'), '绑定先登记');
  assert.equal(host.status().adapters.find((a) => a.id === 'qq').pending, true);
  const agent = fakeAgent({ id: 's-q', preset: 'qq-chat' });
  const r = await ctx.preExecute({ name: 'qq_send', callId: 'x', agent, arguments: { text: '主人的私事', target: 'set-group' } });
  assert.equal(r.decision.kind, 'allow', '认得出是她的会话：审不了，不是公开目标 → 放行');
  assert.equal(pm.adapters.length, 0, '核心没开之前不交给核心');
  release();
  assert.equal(await host.ready, true);
  assert.deepEqual(pm.adapters.map((a) => a.id), ['qq']);
  assert.equal(host.status().adapters.find((a) => a.id === 'qq').pending, false);
  await host.dispose();
  rmDir(dir);
});

test('外来适配器（bili-eyes 那种）在核心打开之前注册：先排队，开了再补上；卸载外壳时注销', async () => {
  const dir = tmpDir('queue');
  const ctx = new FakeDshCtx();
  const pm = createFakePm();
  let release;
  const gate = new Promise((r) => { release = r; });
  const host = createHost(ctx, {}, baseDeps(dir, { coreFactory: async () => { await gate; return pm; } }));
  const svc = ctx.get('personaMemory');
  const ext = adapterOf('ext');
  const binding = fakeBinding({ adapterId: 'ext', preset: 'ext-chat' });
  const unreg = svc.registerAdapter(ext, { binding });
  assert.equal(pm.adapters.length, 0);
  release();
  await host.ready;
  assert.deepEqual(pm.adapters.map((a) => a.id), ['ext']);
  assert.ok(host.claims.binding('ext'), 'DSH 绑定进了认领表');
  const sc = await host.selfCheck();
  assert.equal(sc.items.find((x) => x.id === 'adapter.ext').status, 'ok', '自检看得到外来适配器（协议握手）');
  assert.deepEqual(host.status().service.ids, ['ext']);
  unreg();
  assert.equal(pm.adapters.length, 0);
  assert.equal(host.claims.binding('ext'), null);
  await host.dispose();
  rmDir(dir);
});

test('内置适配器：工厂拿到 deps（日志、时间、路径、会话订阅）；停用的进拒认名单；没实现的在总览标出来', async () => {
  const dir = tmpDir('adapters');
  const ctx = new FakeDshCtx();
  const pm = createFakePm();
  const got = {};
  const qqBinding = fakeBinding({ adapterId: 'qq', preset: 'qq-chat' });
  const factories = {
    qq: (deps) => { got.qq = deps; return { adapter: adapterOf('qq'), binding: qqBinding }; },
    web: (deps) => { got.web = deps; return { ...adapterOf('dsh-web'), dshBinding: fakeBinding({ adapterId: 'dsh-web', preset: 'web-chat', confidence: 'fallback' }) }; },
  };
  const host = createHost(ctx, { host: { adapters: { qq: { bridgeDir: path.join(dir, 'bridge') } } } }, baseDeps(dir, { coreFactory: async () => pm, adapterFactories: factories }));
  await host.ready;
  assert.deepEqual(pm.adapters.map((a) => a.id).sort(), ['dsh-web', 'qq']);
  assert.equal(got.qq.paths.bridgeDir, path.join(dir, 'bridge'));
  assert.equal(typeof got.qq.log.warn, 'function');
  assert.equal(typeof got.qq.now(), 'number');
  assert.equal(typeof got.web.sessions.onMessage, 'function');
  assert.equal(typeof got.web.sessions.onSession, 'function');
  assert.ok(host.claims.binding('qq') && host.claims.binding('dsh-web'));
  await host.dispose();

  // 停用 qq：不注册进核心，但它的会话特征进拒认名单——网页适配器想认领 qq 的会话也不行
  const pm2 = createFakePm();
  const ctx2 = new FakeDshCtx();
  const greedyWeb = { ...adapterOf('dsh-web'), dshBinding: fakeBinding({ adapterId: 'dsh-web', claimSession: () => ({ settingId: 'w', confidence: 'fallback' }) }) };
  const host2 = createHost(ctx2, { host: { adapters: { qq: { enabled: false } } } }, baseDeps(dir, { coreFactory: async () => pm2, adapterFactories: { qq: () => ({ adapter: adapterOf('qq'), binding: qqBinding }), web: () => greedyWeb } }));
  await host2.ready;
  assert.deepEqual(pm2.adapters.map((a) => a.id), ['dsh-web']);
  assert.equal(host2.claims.resolve({ id: 'q1', preset: 'qq-chat', header: {} }), null, '拒认名单（§10.3）');
  assert.ok(host2.claims.resolve({ id: 'w1', preset: 'other', header: {} }));
  await host2.dispose();

  // 工厂抛错 / 没有工厂 / 没配必填项（桥接目录）：都在总览标出来，插件照常
  const ctx3 = new FakeDshCtx();
  const host3 = createHost(ctx3, { host: { adapters: { qq: { bridgeDir: path.join(dir, 'bridge') } } } },
    baseDeps(dir, { coreFactory: async () => createFakePm(), adapterFactories: { qq: () => { throw Object.assign(new Error('x'), { code: 'NOT_IMPLEMENTED' }); } } }));
  await host3.ready;
  const st = host3.status().adapters;
  assert.deepEqual(st.find((a) => a.id === 'qq'), { id: 'qq', name: null, ok: false, disabled: false, error: 'NOT_IMPLEMENTED', pending: false, denied: false, tools: 0, status: null });
  assert.equal(st.find((a) => a.id === 'web').error, 'NO_FACTORY');
  await host3.dispose();
  let called = false;
  const ctx4 = new FakeDshCtx();
  const host4 = createHost(ctx4, {}, baseDeps(dir, { coreFactory: async () => createFakePm(), adapterFactories: { qq: () => { called = true; return adapterOf('qq'); } } }));
  await host4.ready;
  assert.equal(called, false, '没配桥接目录就不建 QQ 适配器（公开仓库里不写本机路径，§11.6）');
  assert.equal(host4.status().adapters.find((a) => a.id === 'qq').error, 'NOT_CONFIGURED');
  const sc = await host4.selfCheck();
  assert.equal(sc.items.find((x) => x.id === 'adapter.qq').level, 'info', '新用户没接 QQ 是常态，不当问题');
  await host4.dispose();
  rmDir(dir);
});

test('splitAdapter 认两种形状', () => {
  const a = adapterOf('x');
  const b = fakeBinding({ adapterId: 'x' });
  assert.deepEqual(splitAdapter({ adapter: a, binding: b }), { adapter: a, binding: b });
  assert.deepEqual(splitAdapter({ ...a, dshBinding: b }).binding, b);
  assert.deepEqual(splitAdapter(null), { adapter: null, binding: null });
});

test('管理页：registerAdmin(ctx, {pm, host}) 拿到固定的 host 接口；卸载时调它返回的 dispose', async () => {
  let args = null;
  let disposed = false;
  const { host, pm, cleanup } = await makeHost({ name: 'admin', deps: { registerAdmin: (ctx, a) => { args = { ctx, ...a }; return () => { disposed = true; }; } } });
  assert.equal(args.pm, pm);
  const h = args.host;
  for (const fn of [h.status, h.selfCheck, h.gpu.status, h.gpu.setPolicy, h.budget.status, h.config.get, h.config.set]) assert.equal(typeof fn, 'function');
  assert.equal(h.paths.dataDir, host.paths.dataDir);
  assert.equal(h.paths.exportDir, path.join(host.paths.dataDir, 'backup', 'export'));
  const st = h.status();
  assert.equal(st.ready, true);
  assert.equal(st.degrade.length, 5, '降级级别分布在顶层（管理页的诊断区）');
  // 自检：管理页认的 status 字段（ok / warn / fail / skip）和中文分区
  const sc = await h.selfCheck();
  assert.ok(sc.items.length > 5);
  for (const x of sc.items) { assert.ok(['ok', 'warn', 'fail', 'skip'].includes(x.status), x.id); assert.equal(typeof x.area, 'string'); }
  assert.equal(await h.selfCheck(), sc, '不 force 就给上一次的结果');
  assert.notEqual(await h.selfCheck({ force: true }), sc);
  // 显卡：管理页传字符串（主人在只给主人的页面上点的，页面自己提示风险）；程序里调要带 confirm
  assert.equal(h.gpu.status().policy, 'adaptive');
  assert.throws(() => h.gpu.setPolicy({ policy: 'on' }), (e) => e.code === 'CONFIRM_REQUIRED' && e.needsConfirm.length === 1);
  assert.equal(h.gpu.setPolicy('on').ok, true);
  assert.equal(h.config.get().host.gpu.policy, 'on');
  assert.equal(h.gpu.setPolicy({ gameMode: { on: true, hours: 2 } }).ok, true);
  const g = h.gpu.status();
  assert.equal(g.device, 'cpu', '游戏模式让出');
  assert.equal(g.yielding, true);
  assert.match(g.reason, /游戏模式/);
  assert.throws(() => h.gpu.setPolicy({}), (e) => e.code === 'CONTRACT');
  // 配置：核心的参数表在顶层（管理页读 mode、budget、sleep、backup、retention）
  const cfg = h.config.get();
  assert.equal(cfg.mode.global, 'live');
  assert.equal(cfg.budget.preset, 'loose', '§17 Q10：默认宽松');
  assert.equal(cfg.retention.coolingOffDays, 7);
  assert.deepEqual(cfg.mode.byAttributes, { principalOneOnOne: 'live', closed: 'live', public: 'live' }, '每类场合默认都开着（§15.2，没有影子档）');
  assert.throws(() => h.config.set({ mode: { global: 'off' } }, { confirm: false }), (e) => e.code === 'CONFIRM_REQUIRED');
  assert.equal(h.config.set({ mode: { global: 'off' } }, { confirm: true }).ok, true);
  assert.equal(h.config.get().mode.global, 'off', '热加载');
  assert.equal(h.config.set({ budget: { preset: 'saving' } }, { confirm: false }).ok, true);
  assert.throws(() => h.config.set({ retention: { raw: '1y' } }, { confirm: true }), (e) => e.code === 'CONTRACT', '保留期只能走 admin.retention（D56）');
  const b = h.budget.status();
  assert.equal(b.preset, 'saving');
  assert.equal(typeof b.today.calls, 'number');
  assert.deepEqual(b.egressReserve, { used: 0, total: 100 }, '外发审视的独立预留（D113：只有公开目标还送审，调回 100）');
  await cleanup();
  assert.equal(disposed, true);
});

test('插件启动时已经活着的 agent：符合绑定的会话特征就补注册记忆工具；agent/created 同步、不抛错', async () => {
  const ctx = new FakeDshCtx();
  const live = fakeAgent({ id: 'live-1', preset: 'zz-chat' });
  const other = fakeAgent({ id: 'dev-1', preset: 'coding' });
  ctx.agents.map.set(live.id, live);
  ctx.agents.map.set(other.id, other);
  const pm = createFakePm();
  // 绑定在核心打开之前由外壳登记（bili-eyes 那条路），启动后补注册要看得到它的特征
  let release;
  const gate = new Promise((r) => { release = r; });
  const dir = tmpDir('existing');
  const host = createHost(ctx, {}, baseDeps(dir, { coreFactory: async () => { await gate; return pm; } }));
  host.service.dsh.registerBinding(fakeBinding());
  release();
  await host.ready;
  assert.deepEqual(live.ctx.tools.registered.map((t) => t.name).sort(), ['memory_fix', 'memory_look', 'memory_note', 'memory_recall']);
  assert.equal(other.ctx.tools.registered.length, 0, '不是她的会话不给工具');
  const created = fakeAgent({ id: 'new-1', preset: 'zz-chat' });
  await ctx.agentCreated(created);
  assert.equal(created.ctx.tools.registered.length, 4);
  const sub = fakeAgent({ id: 'sub-1', preset: 'zz-chat', origin: 'subagent', delegationDepth: 1 });
  await ctx.agentCreated(sub);
  assert.equal(sub.ctx.tools.registered.length, 0, '子代理一律排除（F20）');
  ctx.agentDisposed(created);
  assert.equal(created.ctx.tools.registered.length, 0, '卸掉 agent 时撤工具');
  await host.dispose();
  assert.equal(live.ctx.tools.registered.length, 0, '插件卸载时撤掉全部工具（自己维护 disposer 表，F14）');
  rmDir(dir);
});
