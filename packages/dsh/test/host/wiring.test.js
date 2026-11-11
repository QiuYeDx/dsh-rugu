// 宿主接上真的内置适配器（QQ、网页）：工厂拿到的 deps（盐、gate、会话钩子、热加载的配置）、认领、唤醒头对不上时停掉会话（C1）、
// 外发审完告诉适配器令牌（关口③对账，§9.5）、绑定声明的冻结（B13）、网页会话里出现远程访客时改记场合（§11.3）、启动自检。
// 桥接目录是 .tmp 下合成的文件（账号、群号都是运行时随机生成的）；核心是录音替身，不起 worker、不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFakePm, fakeAgent, userMessage, FakeDshCtx, tmpDir, rmDir } from '../fakes/index.js';
import { rid, inMsg, socialFile } from '../adapters/helpers.js';
import { offlineFetch } from './helpers.js';
import { createHost } from '../../src/host/index.js';
import { runPatch } from '../../scripts/bridge-whitelist-patch.mjs';

const hostDeps = (dir, extra = {}) => ({
  dshHome: dir, coreFactory: async () => createFakePm(), adapterFactories: undefined, registerAdmin: null, defineTool: (d) => d,
  sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch, ...extra,
});

const PREFIX = 'mcp__snowluma__';
const RESTRICT = `// 合成的白名单文件（形状照桥接的 qq-tool-restrict.mjs）
const SAFE_PREFIXES = ['mcp__snowluma__']
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])
export default SAFE_EXACT
`;

/** 一个合成的桥接目录：两个群、两个会话映射；social-v2 里带 agentToken（适配器必须丢掉）。 */
function fakeBridge(dir) {
  const bridgeDir = path.join(dir, 'bridge');
  const state = path.join(bridgeDir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const ids = { owner: rid('u'), friend: rid('u'), g: rid('g'), g2: rid('g') };
  const K = { g: `group:${ids.g}`, g2: `group:${ids.g2}` };
  fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify({ ownerQQ: ids.owner, allow: { groups: [ids.g, ids.g2] }, socialV2: { agentPreset: 'qq-chat-v2' } }));
  fs.writeFileSync(path.join(state, 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ sessions: { [K.g]: 'sess-qq', [K.g2]: 'sess-qq2' } }));
  const T = Date.now();
  fs.writeFileSync(path.join(state, 'social-v2.json'), JSON.stringify(socialFile({
    [K.g]: { recent: [inMsg({ seq: 1, userId: ids.friend, sender: '阿明', text: '在吗', time: T - 1000 })] },
    [K.g2]: { recent: [] },
  })));
  fs.mkdirSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'presets'), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), RESTRICT);
  return { bridgeDir, ids, K, T };
}

/** 网页客户端发的消息（带 source.clientTimeZone：网页适配器的辅助证据，附录 G）。 */
const webMessage = (text, o = {}) => userMessage(text, { ...o, extra: { clientTimeZone: 'Asia/Shanghai', ...(o.extra ?? {}) } });
const wakeMessage = (key, compact) => userMessage(`【唤醒】${key}\n原因：有人在群里 @ 了你\n【本次消息快照】\n${JSON.stringify({ messages: [compact], recent: [] })}\n以上消息已提供，无需重复查询。`, { id: rid('m') });

async function wired(name, extra = {}) {
  const dir = tmpDir(name);
  const br = fakeBridge(dir);
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({
    host: { adapters: { qq: { bridgeDir: br.bridgeDir }, web: { presets: ['web-chat'] } }, self: { principalLabel: '主人' }, ...(extra.host ?? {}) },
  }));
  const pm = extra.pm ?? createFakePm();
  const ctx = new FakeDshCtx();
  const host = createHost(ctx, {}, hostDeps(dir, { coreFactory: async () => pm, ...(extra.deps ?? {}) }));
  await host.ready;
  return { ...br, dir, ctx, pm, host, cleanup: async () => { await host.dispose(); rmDir(dir); } };
}

test('内置适配器接上：盐从身份密钥派生（稳定、按适配器分开）、gate 问核心的生效档、配置热加载；两个都注册进核心', async () => {
  const w = await wired('wire-basic');
  assert.deepEqual(w.pm.adapters.map((a) => a.id).sort(), ['dsh-web', 'qq']);
  const st = w.host.status();
  assert.ok(st.adapters.every((a) => a.ok), JSON.stringify(st.adapters.map((a) => [a.id, a.error])));
  assert.ok(fs.existsSync(path.join(w.dir, 'persona-memory.key')), '身份密钥（核心打开时建；替身下由宿主按同样的格式建）');
  assert.equal(fs.existsSync(path.join(w.host.paths.dataDir, 'adapter-salt')), false, '盐从身份密钥派生，不另存盐文件（跟着备份走）');
  const qqClaim = w.host.claims.resolve({ id: 'sess-qq', preset: 'qq-chat-v2', header: {} });
  assert.equal(qqClaim.adapterId, 'qq');
  assert.equal(qqClaim.confidence, 'specific');
  assert.ok(!qqClaim.settingId.includes(w.ids.g), 'SettingId 里不含群号原值（§4.2）');
  // 网页：preset 在配置里才认（正面证据，F24），fallback
  const webClaim = w.host.claims.resolve({ id: 'sess-web', preset: 'web-chat', header: {}, messages: [webMessage('在吗')] });
  assert.equal(webClaim.adapterId, 'dsh-web');
  assert.equal(webClaim.confidence, 'fallback');
  assert.equal(w.host.claims.resolve({ id: 'sess-dev', preset: 'coding', header: {} }), null, '都不认 → 不是她（fail closed）');
  // 配置热加载：网页 preset 改了马上生效（让插件预设以外的预设也算跟她聊，要主人确认，D112）
  assert.throws(() => w.host.api.config.set({ host: { adapters: { web: { presets: ['web-chat', 'web-2'] } } } }), (e) => e.code === 'CONFIRM_REQUIRED');
  w.host.api.config.set({ host: { adapters: { web: { presets: ['web-chat', 'web-2'] } } } }, { confirm: true });
  assert.equal(w.host.claims.resolve({ id: 'sess-web2', preset: 'web-2', header: {}, messages: [webMessage('在吗')] })?.adapterId, 'dsh-web');
  await w.cleanup();
});

test('同一个 DSH 家目录重开：QQ 的 SettingId 不变（她还认得这些地方）', async () => {
  const w = await wired('wire-stable');
  const a = w.host.claims.resolve({ id: 'sess-qq', preset: 'qq-chat-v2', header: {} }).settingId;
  await w.host.dispose();
  const host2 = createHost(new FakeDshCtx(), {}, hostDeps(w.dir));
  await host2.ready;
  assert.equal(host2.claims.resolve({ id: 'sess-qq', preset: 'qq-chat-v2', header: {} }).settingId, a);
  await host2.dispose();
  rmDir(w.dir);
});

test('唤醒消息：对得上就当场入库、召回、注入；唤醒头和绑定的场合对不上（C1）→ 停掉这个会话的感知和注入，总览报警', async () => {
  const w = await wired('wire-wake');
  const compact = { seq: 2, messageId: rid('m'), sender: '阿明', userId: w.ids.friend, text: '@她 晚上一起吗', time: w.T };
  const good = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  const d = await w.ctx.preStep(good, [wakeMessage(w.K.g, compact)]);
  assert.equal(w.host.claims.get('sess-qq').adapterId, 'qq');
  const obs = w.pm.named('observe').at(-1);
  assert.equal(obs.args[1].adapter, 'qq');
  assert.equal(obs.args[0][0].attention, 'attended');
  assert.equal(w.pm.named('recall').length, 1);
  assert.equal(w.pm.named('recall')[0].args[0].focusObsId, obs.args[0][0].id, '触发这一轮的那条消息（resolveFocus）');
  assert.ok(d.messages.some((m) => m.source?.kind === 'persona-memory'));
  // sess-qq2 绑的是 g2，唤醒头却写着 g：停
  const bad = fakeAgent({ id: 'sess-qq2', preset: 'qq-chat-v2' });
  const before = w.pm.named('observe').length;
  const d2 = await w.ctx.preStep(bad, [wakeMessage(w.K.g, compact)]);
  assert.equal(d2.messages.some((m) => m.source?.kind === 'persona-memory'), false);
  assert.equal(w.pm.named('observe').length, before, '不感知');
  assert.equal(w.pm.named('recall').length, 1, '不召回');
  assert.equal(w.host.assembler.isSuspended('sess-qq2'), true);
  assert.equal(w.ctx.resolveContexts(bad)[0].text, '', '常驻区也不给');
  const sus = w.host.status().context.suspendedSessions;
  assert.deepEqual(sus.map((s) => [s.adapterId, s.reason]), [['qq', 'mismatch']]);
  // 停掉之后再来对的唤醒也不恢复（插件重载后重新认领才恢复）；会话事件也不感知
  await w.ctx.preStep(bad, [wakeMessage(w.K.g2, compact)]);
  assert.equal(w.pm.named('recall').length, 1);
  // 不是唤醒消息（没有唤醒头）只是不算唤醒，不停会话
  const plain = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  await w.ctx.preStep(plain, [userMessage('普通的一句话')]);
  assert.equal(w.host.assembler.isSuspended('sess-qq'), false);
  await w.cleanup();
});

test('外发：QQ 的说话类工具 resolve → appraise → 放行，并把令牌告诉适配器（她的话回流时对账，§9.5）；冻结按绑定的声明', async () => {
  const w = await wired('wire-egress', { host: { freeze: { tools: [] } } });
  const agent = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  await w.ctx.preStep(agent, [userMessage('普通的一句话')]);
  const qq = w.pm.adapters.find((a) => a.id === 'qq');
  assert.equal(qq.status().pendingAppraisals, 0);
  const r = await w.ctx.preExecute({ name: `${PREFIX}qq_send_message`, callId: 'c1', agent, arguments: { key: w.K.g, messages: '晚上见' } });
  assert.equal(r.decision.kind, 'allow');
  const u = w.pm.named('appraise')[0].args[0];
  assert.deepEqual(u.text, ['晚上见']);
  assert.equal(u.origin.homeSettingId, w.host.claims.get('sess-qq').settingId);
  assert.equal(qq.status().pendingAppraisals, 1, '适配器记下了令牌');
  // 配置里的冻结名单清空了，绑定自己声明的冻结照样生效（B13）
  const f = await w.ctx.preExecute({ name: `${PREFIX}qq_memory_remove`, callId: 'c2', agent, arguments: {} });
  assert.equal(f.decision.kind, 'deny');
  assert.match(f.decision.reason, /记忆插件负责/);
  assert.equal(w.ctx.tools.guardReason({ name: `${PREFIX}qq_note_person` }) !== undefined, true, '守卫兜底也认绑定的声明');
  await w.cleanup();
});

test('网页会话里出现远程访客（带 principal）：适配器改记场合、宿主改认领并重新绑定，常驻区下次重新渲染', async () => {
  const w = await wired('wire-rebind');
  const agent = fakeAgent({ id: 'sess-web', preset: 'web-chat' });
  await w.ctx.preStep(agent, [webMessage('在吗', { id: 'u-1' })]);
  const owner = w.host.claims.get('sess-web').settingId;
  assert.equal(w.ctx.resolveContexts(agent)[0].text.includes(owner), true, '常驻区按主人的场合渲染');
  const binds = w.pm.named('bind').length;
  w.ctx.sessionEvent(agent.session, { type: 'user/message', seq: 3, data: webMessage('你好呀', { id: 'u-2', extra: { principal: { kind: 'remote', id: 'visitor-1', displayName: '访客' } } }) });
  const next = w.host.claims.get('sess-web').settingId;
  assert.notEqual(next, owner);
  assert.equal(w.pm.named('bind').length, binds + 1, '重新交给核心 sessions.bind');
  assert.equal(w.pm.named('bind').at(-1).args[0].settingId, next);
  assert.equal(w.ctx.resolveContexts(agent)[0].text.includes(next), true, '之前给主人的常驻区不再给访客');
  await w.cleanup();
});

test('白名单补丁没打：QQ 会话不给记忆工具（桥接的守卫会拒绝，免得她反复撞）；网页会话照常有；打上补丁、重启后 QQ 也有', async () => {
  const w = await wired('wire-toolgate');
  const qqAgent = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  await w.ctx.agentCreated(qqAgent);
  assert.equal(qqAgent.ctx.tools.registered.length, 0, '创建时按会话特征认出是 QQ，但补丁没打');
  await w.ctx.preStep(qqAgent, [userMessage('普通的一句话')]);
  assert.equal(qqAgent.ctx.tools.registered.length, 0, '认领成功时也不补');
  const web = fakeAgent({ id: 'sess-web', preset: 'web-chat' });
  await w.ctx.agentCreated(web);
  assert.equal(web.ctx.tools.registered.length, 4);
  runPatch({ bridgeDir: w.bridgeDir, apply: true });
  await w.host.dispose();
  // 「重启」：同一个家目录重开（补丁要彻底重启 DSH 才生效，附录 G.4）
  const ctx2 = new FakeDshCtx();
  const again = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  ctx2.agents.map.set(again.id, again);
  const host2 = createHost(ctx2, {}, hostDeps(w.dir));
  await host2.ready;
  assert.equal(again.ctx.tools.registered.length, 4, '插件启动时给已经活着的 agent 补注册');
  await host2.dispose();
  rmDir(w.dir);
});

test('白名单补丁是旧的（D156 以前打的三行，没有 memory_look）：自检说补丁是旧的、怎么做；QQ 会话只少 memory_look；重打一次补上缺的那一行、重启后有', async () => {
  const w = await wired('wire-stale');
  const file = path.join(w.bridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  const MARK = '// persona-memory patch';
  const oldLines = ['memory_recall', 'memory_note', 'memory_fix'].map((t) => `  '${t}', ${MARK}`).join('\n');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("  'todo_write',", `  'todo_write',\n${oldLines}`));
  const sc = await w.host.selfCheck();
  const item = sc.items.find((x) => x.id === 'bridge.whitelist');
  assert.equal(item.status, 'warn');
  const said = JSON.stringify(item);
  assert.match(said, /补丁是旧的[^"]*memory_look/u);
  assert.match(said, /再打一次补丁/u);
  const qq = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  await w.ctx.agentCreated(qq);
  assert.deepEqual(qq.ctx.tools.registered.map((t) => t.name).sort(), ['memory_fix', 'memory_note', 'memory_recall'], '只少 memory_look');
  const r = runPatch({ bridgeDir: w.bridgeDir, apply: true });
  assert.deepEqual(r.changes.map((c) => /'([^']+)'/.exec(c.line)?.[1]), ['memory_look'], '只补缺的那一行');
  assert.equal(runPatch({ bridgeDir: w.bridgeDir, apply: true }).changes.length, 0, '再打一次什么都不改');
  await w.host.dispose();
  const ctx2 = new FakeDshCtx();
  const again = fakeAgent({ id: 'sess-qq', preset: 'qq-chat-v2' });
  ctx2.agents.map.set(again.id, again);
  const host2 = createHost(ctx2, {}, hostDeps(w.dir));
  await host2.ready;
  assert.equal(again.ctx.tools.registered.length, 4);
  await host2.dispose();
  rmDir(w.dir);
});

test('启动自检接上适配器：QQ 适配器自己的检查项归一成管理页的形状；白名单补丁没打 → 提示；打上之后通过', async () => {
  const w = await wired('wire-selfcheck');
  let sc = await w.host.selfCheck();
  const byId = Object.fromEntries(sc.items.map((x) => [x.id, x]));
  assert.equal(byId['adapter.qq'].status, 'ok');
  assert.equal(byId['adapter.dsh-web'].status, 'ok');
  assert.ok(byId['adapter.qq.bridge-mode'], 'QQ 适配器的 {name, ok} 检查项');
  assert.equal(byId['adapter.qq.bridge-mode'].status, 'ok');
  assert.equal(byId['bridge.whitelist'].status, 'warn');
  assert.match(byId['bridge.whitelist'].detail, /QQ 桥接/);
  assert.equal(byId['bridge.freeze'].status, 'ok');
  const r = runPatch({ bridgeDir: w.bridgeDir, apply: true });
  assert.equal(r.applied, true);
  sc = await w.host.selfCheck();
  assert.equal(sc.items.find((x) => x.id === 'bridge.whitelist').status, 'ok');
  await w.cleanup();
});

test('适配器的绑定不合格：自检标红，它的会话特征进拒认名单（别的适配器也不能认领），修好后放出来', async () => {
  const dir = tmpDir('wire-bad');
  let broken = true;
  const binding = {
    adapterId: 'qq',
    claimSession: (s) => (s.preset === 'qq-chat-v2' ? { settingId: 'set-q', confidence: 'specific' } : null),
    sessionSignature: () => ({ presets: ['qq-chat-v2'] }),
    get tools() { return broken ? [{ tool: 'qq_x' }] : [{ tool: 'qq_x', class: 'none' }]; },
  };
  const web = { adapterId: 'dsh-web', claimSession: () => ({ settingId: 'set-w', confidence: 'fallback' }), sessionSignature: () => ({ presets: ['web-chat'] }), tools: [] };
  const adapterOf = (id, b) => ({ id, protocol: 2, describeSetting: () => ({}), selfClaims: () => [], principalClaims: () => [], binding: b });
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { adapters: { qq: { bridgeDir: path.join(dir, 'nowhere') } } } }));
  // validateBinding 在登记时就会拒绝不合格的绑定：这里让它第一次合格、之后变坏（模拟桥接升级后多出没分类的工具）
  broken = false;
  const host = createHost(new FakeDshCtx(), {}, hostDeps(dir, { adapterFactories: { qq: () => adapterOf('qq', binding), web: () => adapterOf('dsh-web', web) } }));
  await host.ready;
  assert.equal(host.claims.resolve({ id: 'a', preset: 'qq-chat-v2', header: {} })?.adapterId, 'qq');
  broken = true;
  const sc = await host.selfCheck();
  assert.equal(sc.items.find((x) => x.id === 'adapter.qq').status, 'fail');
  assert.equal(host.claims.resolve({ id: 'b', preset: 'qq-chat-v2', header: {} }), null, '拒认名单：网页的 fallback 也不能认领');
  assert.equal(host.status().adapters.find((a) => a.id === 'qq').denied, true);
  broken = false;
  await host.selfCheck();
  assert.equal(host.claims.resolve({ id: 'c', preset: 'qq-chat-v2', header: {} })?.adapterId, 'qq', '修好了：下一次自检放出来');
  await host.dispose();
  rmDir(dir);
});
