// 插件自己的 Agent 预设（D112，src/preset/）和「会话现在的预设」怎么进认领（claim.js makeSessionInfoOf、host 的 agent-preset/selected 钩子）。
// 全部用 FakeDshCtx 的假预设注册表（照 dsh-agent-preset-registry 的源码：definitions、register 返回撤销函数、重复 id 抛错、
// select 记 agent-preset/selected、会话头不变）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPersonaPreset, buildPresetRows, presetSettings, PERSONA_PRESET_ID, DEFAULT_PRESET_NAME } from '../../src/preset/index.js';
import { fallbackRows, FROM_DSH } from '../../src/preset/fallback-rows.js';
import { makeSessionInfoOf, sessionInfoOf, createClaims } from '../../src/host/claim.js';
import * as plugin from '../../src/index.js';
import { FakeDshCtx, FAKE_STANDARD_ROWS, fakeAgent, userMessage, fakeBinding, tmpDir, rmDir } from '../fakes/index.js';
import { makeHost } from './helpers.js';

/** 假计时器：sleep(ms) 立刻往前拨时钟（等标准模式的轮询不真的等）。 */
function fakeTime() {
  let t = 1_000_000;
  return { now: () => t, setTimer: (fn, ms) => { t += ms; setImmediate(fn); return 0; } };
}
const mkPreset = (ctx, cfg = {}, extra = {}) => {
  const ft = fakeTime();
  let host = { preset: cfg };
  const p = createPersonaPreset({ ctx, hostConfig: () => host, now: ft.now, setTimer: ft.setTimer, waitMs: 1000, pollMs: 100, retryMs: 50, ...extra });
  return { p, set: (c) => { host = { preset: c }; } };
};

test('预设照抄标准模式现在的行（!!js 条件原样保留），名字和说明来自配置、默认是通用名；注册在预设服务出现之后', async () => {
  const ctx = new FakeDshCtx();
  const { p } = mkPreset(ctx);
  p.start();
  assert.equal(p.status().registered, false, '还没有预设服务：什么都不做');
  const reg = ctx.installPresets();
  await p.settled();
  const def = reg.definitions.get(PERSONA_PRESET_ID)?.config;
  assert.ok(def, '注册上了');
  assert.equal(def.name, DEFAULT_PRESET_NAME);
  assert.equal(def.order, 5);
  assert.deepEqual(def.plugins, structuredClone(FAKE_STANDARD_ROWS), '和标准模式一样');
  assert.notEqual(def.plugins, reg.definitions.get('standard').config.plugins, '是拷贝，不是同一个数组');
  assert.deepEqual(def.plugins[1].disabled, { __jsExpr: "process.platform === 'win32'" });
  const s = p.status();
  assert.equal(s.registered, true);
  assert.equal(s.source, 'standard');
  assert.equal(s.rows, FAKE_STANDARD_ROWS.length);
  assert.equal(s.baseUrl, true);
  // 名单（下拉）里有它
  await p.refreshRoster();
  assert.equal(p.nameOf(PERSONA_PRESET_ID), DEFAULT_PRESET_NAME);
  assert.equal(p.available(PERSONA_PRESET_ID), true);
  assert.equal(p.available('nope'), false);
  await p.stop();
  assert.equal(reg.definitions.has(PERSONA_PRESET_ID), false, '插件卸载：撤掉');
  assert.ok(reg.definitions.has('standard'), '标准模式不动');
});

test('personaPrefix 只改人设行的开头（原来的行不动）；没有人设行就加一行；设置的类型不对按默认', () => {
  const rows = structuredClone(FAKE_STANDARD_ROWS);
  const out = buildPresetRows(rows, '你是她。');
  assert.equal(out[0].config.prefix, '你是她。');
  assert.equal(rows[0].config.prefix, FAKE_STANDARD_ROWS[0].config.prefix, '原来的行没被改');
  assert.deepEqual(out.slice(1), rows.slice(1));
  const none = buildPresetRows([{ id: 'x', name: 'y' }], 'P');
  assert.equal(none[0].name, '@deepseek-ai/dsh-persona');
  assert.deepEqual(buildPresetRows(rows, ''), rows);
  assert.deepEqual(presetSettings({ preset: { name: 5, order: 'x', personaPrefix: 'a'.repeat(3000), enabled: 'no' } }),
    { enabled: true, name: DEFAULT_PRESET_NAME, description: presetSettings({}).description, order: 5, personaPrefix: '' });
  assert.equal(presetSettings({ preset: { name: '  某某  ' } }).name, '某某');
});

test('标准模式晚到：轮询等它；等不到就用插件自带的精简副本（自检会标出来），之后读得到了，同步时换成标准模式', async () => {
  const ctx = new FakeDshCtx();
  const reg = ctx.installPresets({ standardLater: true });
  const { p } = mkPreset(ctx);
  p.start();
  await new Promise((r) => setImmediate(r));
  reg.addStandard();
  await p.settled();
  assert.equal(p.status().source, 'standard', '在等的时间里出现了');
  await p.stop();

  const ctx2 = new FakeDshCtx();
  const reg2 = ctx2.installPresets({ standardLater: true });
  const { p: p2 } = mkPreset(ctx2);
  p2.start();
  await p2.settled();
  assert.equal(p2.status().source, 'fallback');
  assert.equal(reg2.definitions.get(PERSONA_PRESET_ID).config.plugins.length, fallbackRows().length);
  assert.equal(FROM_DSH, '0.2.1-rc.3');
  reg2.addStandard();
  await p2.sync();
  assert.equal(p2.status().source, 'standard');
  assert.equal(reg2.registerCalls.length, 2, '撤掉精简副本、重新注册');
  await p2.stop();
});

test('配置：enabled:false 不注册 / 撤掉，再打开又注册；改名重新注册；没变就不动', async () => {
  const ctx = new FakeDshCtx();
  const reg = ctx.installPresets();
  const { p, set } = mkPreset(ctx, { enabled: false });
  p.start();
  await p.settled();
  assert.equal(reg.definitions.has(PERSONA_PRESET_ID), false);
  assert.equal(p.status().enabled, false);
  assert.equal(p.available(PERSONA_PRESET_ID), false);
  set({ enabled: true, name: '某个名字' });
  await p.sync();
  assert.equal(reg.definitions.get(PERSONA_PRESET_ID).config.name, '某个名字');
  await p.sync();
  assert.equal(reg.registerCalls.length, 1, '没变：不重新注册');
  set({ name: '另一个名字', description: '说明' });
  await p.sync();
  assert.equal(reg.registerCalls.length, 2);
  assert.equal(reg.definitions.get(PERSONA_PRESET_ID).config.description, '说明');
  set({ enabled: false });
  await p.sync();
  assert.equal(reg.definitions.has(PERSONA_PRESET_ID), false);
  await p.stop();
});

test('同 id 已经有一个（插件热重载时上一个实例还没撤完）：等一会儿再试；一直有就记错误码，绝不抛错；激活失败（broken）进状态', async () => {
  const ctx = new FakeDshCtx();
  const reg = ctx.installPresets();
  const stale = await reg.register({ id: PERSONA_PRESET_ID, name: '旧的', plugins: [] });
  const { p } = mkPreset(ctx, {}, { retries: 3 });
  p.start();
  await new Promise((r) => setImmediate(r));
  await stale();
  await p.settled();
  assert.equal(p.status().registered, true, '旧的撤掉后注册上了');
  await p.stop();

  const ctx2 = new FakeDshCtx();
  const reg2 = ctx2.installPresets();
  await reg2.register({ id: PERSONA_PRESET_ID, name: '别人的', plugins: [] });
  const { p: p2 } = mkPreset(ctx2, {}, { retries: 2 });
  p2.start();
  await p2.settled();
  assert.equal(p2.status().registered, false);
  assert.equal(p2.status().error, 'DUPLICATE');
  assert.equal(p2.available(PERSONA_PRESET_ID), null, '名单里有一个同 id 的（不是我们的）：不说它不在');
  await p2.stop();
  assert.equal(reg2.definitions.get(PERSONA_PRESET_ID).config.name, '别人的', '不是我们注册的不撤');

  const ctx3 = new FakeDshCtx();
  const reg3 = ctx3.installPresets();
  reg3.brokenIds.add(PERSONA_PRESET_ID);
  const { p: p3 } = mkPreset(ctx3);
  p3.start();
  await p3.settled();
  await p3.refreshRoster();
  assert.match(p3.status().broken, /Cannot find/);
  assert.equal(p3.available(PERSONA_PRESET_ID), false);
  await p3.stop();
});

test('预设服务被撤掉再提供（DSH 重组）：跟着撤、跟着重新注册', async () => {
  const ctx = new FakeDshCtx();
  const reg = ctx.installPresets();
  const { p } = mkPreset(ctx);
  p.start();
  await p.settled();
  ctx.setService('agentPresets', undefined);
  await p.settled();
  assert.equal(reg.definitions.has(PERSONA_PRESET_ID), false);
  assert.equal(p.status().registry, false);
  const reg2 = ctx.installPresets();
  await p.settled();
  assert.ok(reg2.definitions.has(PERSONA_PRESET_ID));
  await p.stop();
});

test('插件入口：集成层起不来（这里是没有 ctx.on）也照样注册预设——用它开过的旧会话要靠它打开；卸载时撤掉', async () => {
  const ctx = new FakeDshCtx();
  const reg = ctx.installPresets();
  const bare = { inject: ctx.inject.bind(ctx), get: ctx.get.bind(ctx), logger: ctx.logger };
  const dispose = plugin.apply(bare, {});
  for (let i = 0; i < 20 && !reg.definitions.has(PERSONA_PRESET_ID); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(reg.definitions.get(PERSONA_PRESET_ID)?.config.name, DEFAULT_PRESET_NAME);
  await dispose();
  assert.equal(reg.definitions.has(PERSONA_PRESET_ID), false);
});

test('插件入口：正常起来时预设名来自配置文件；配置热加载改名，预设跟着改', async () => {
  const dir = tmpDir('preset-entry');
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { enabled: false, preset: { name: '配置里的名字' } } }));
    const ctx = new FakeDshCtx();
    const reg = ctx.installPresets();
    const dispose = plugin.apply(ctx, {});
    for (let i = 0; i < 40 && !reg.definitions.has(PERSONA_PRESET_ID); i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(reg.definitions.get(PERSONA_PRESET_ID)?.config.name, '配置里的名字', '记忆总开关关着也注册');
    await dispose();
    assert.equal(reg.definitions.has(PERSONA_PRESET_ID), false);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmDir(dir);
  }
});

test('会话现在的预设：会话投影优先，其次预设服务报的组合，会话头最后；读出错就退回会话头', () => {
  const agent = fakeAgent({ id: 's1', preset: 'standard' });
  assert.equal(sessionInfoOf(agent).preset, 'standard');
  assert.equal(makeSessionInfoOf(() => PERSONA_PRESET_ID)(agent).preset, PERSONA_PRESET_ID);
  assert.equal(makeSessionInfoOf(() => undefined)(agent).preset, 'standard');
  assert.equal(makeSessionInfoOf(() => { throw new Error('x'); })(agent).preset, 'standard');
  assert.equal(makeSessionInfoOf(() => '')(agent).preset, 'standard');
  assert.deepEqual(makeSessionInfoOf(() => 'p')(agent, { messages: [1] }).messages, [1]);
});

test('宿主：在空白会话上从下拉里换成插件预设（会话头还是 standard）→ 认得出、马上有记忆工具；换回去拿掉', async () => {
  const ctx = new FakeDshCtx();
  const reg = ctx.installPresets();
  await reg.register({ id: PERSONA_PRESET_ID, name: 'x', plugins: [] });
  const web = fakeBinding({ adapterId: 'dsh-web', preset: PERSONA_PRESET_ID, confidence: 'fallback', settingId: 'set-web' });
  const env = await makeHost({ name: 'preset-sel', ctx, bindings: [web] });
  const agent = fakeAgent({ id: 'blank', preset: 'standard' });
  await ctx.agentCreated(agent);
  assert.equal(agent.ctx.tools.registered.length, 0, '标准模式：没有记忆工具');
  await reg.select(agent, PERSONA_PRESET_ID);
  assert.deepEqual(agent.ctx.tools.registered.map((d) => d.name).sort(), ['memory_fix', 'memory_look', 'memory_note', 'memory_recall']);
  assert.equal(agent.session.header.agentPreset, 'standard', '会话头没变（DSH 也不改）');
  await ctx.preStep(agent, [userMessage('在吗', { id: 'u1' })]);
  assert.equal(env.host.claims.get('blank')?.adapterId, 'dsh-web');
  // 只靠 composedPreset（没有投影的宿主）也认得出
  const ctx2 = new FakeDshCtx();
  ctx2.services.delete('sessionProjections');
  const reg2 = ctx2.installPresets();
  const env2 = await makeHost({ name: 'preset-comp', ctx: ctx2, bindings: [fakeBinding({ adapterId: 'dsh-web', preset: PERSONA_PRESET_ID, settingId: 'set-web' })] });
  const a2 = fakeAgent({ id: 'comp', preset: 'standard' });
  reg2.bind(a2, PERSONA_PRESET_ID);
  await ctx2.agentCreated(a2);
  assert.equal(a2.ctx.tools.registered.length, 4);
  await env2.cleanup();
  // 另一个空白会话：先换进来、再换回标准模式 → 工具拿掉
  const b = fakeAgent({ id: 'blank2', preset: 'standard' });
  await ctx.agentCreated(b);
  await reg.select(b, PERSONA_PRESET_ID);
  assert.equal(b.ctx.tools.registered.length, 4);
  await reg.select(b, 'standard');
  assert.equal(b.ctx.tools.registered.length, 0);
  await env.cleanup();
});

test('认领：符合会话特征却没认上的会话 5 秒后再问、不算次数；别的不认的照旧 60 秒、最多 5 次', () => {
  let t = 0;
  let accept = false;
  const b = { adapterId: 'w', claimSession: () => (accept ? { settingId: 'sw', confidence: 'fallback' } : null), sessionSignature: () => ({ presets: ['p'] }), retryOnSignature: true, tools: [] };
  const claims = createClaims({ hostConfig: () => ({ claim: { negativeTtlMs: 60_000, signatureRetryMs: 5000, maxAttempts: 2 } }), getPm: () => null, now: () => t });
  claims.addBinding(b);
  const step = (id, preset) => ({ id, preset, header: {}, messages: [] });   // pre-step 带这一步的消息
  for (let i = 0; i < 4; i += 1) { assert.equal(claims.resolve(step('s', 'p')), null); t += 5000; }
  accept = true;
  assert.equal(claims.resolve(step('s', 'p'))?.settingId, 'sw', '次数没用完（符合特征的不算次数）');
  accept = false;
  assert.equal(claims.resolve(step('o', 'q')), null);
  t += 5000;
  accept = true;
  assert.equal(claims.resolve(step('o', 'q')), null, '不符合特征：还在 60 秒的缓存里');
  t += 60_000;
  assert.ok(claims.resolve(step('o', 'q')));
  assert.equal(claims.status().signatureRetries, 4);
  // 不带消息的问法（工具调用）没认上不记缓存：紧接着带消息的 pre-step 不被 5 秒的缓存挡住
  accept = false;
  assert.equal(claims.resolve({ id: 'm', preset: 'p', header: {} }), null);
  accept = true;
  assert.equal(claims.resolve(step('m', 'p'))?.settingId, 'sw');
});

test('认领（集成复查）：只有声明了 retryOnSignature 的绑定（网页）才快速重试；别的绑定（QQ：桥接的辅助会话永远不在映射里）照旧最多 5 次', () => {
  let t = 0;
  let calls = 0;
  const qq = { adapterId: 'qq', claimSession: () => { calls += 1; return null; }, sessionSignature: () => ({ presets: ['qq-chat'], cwdPrefixes: ['X:/bridge/state/agents'] }), tools: [] };
  const claims = createClaims({ hostConfig: () => ({ claim: { negativeTtlMs: 60_000, signatureRetryMs: 5000, maxAttempts: 5 } }), getPm: () => null, now: () => t });
  claims.addBinding(qq);
  for (let i = 0; i < 720; i += 1) { claims.resolve({ id: 'helper', cwd: 'X:/bridge/state/agents/slang', header: {}, messages: [] }); t += 5000; }
  assert.equal(calls, 5, '一小时的 pre-step 里只问了 5 次');
  assert.equal(claims.status().signatureRetries ?? 0, 0);
});
