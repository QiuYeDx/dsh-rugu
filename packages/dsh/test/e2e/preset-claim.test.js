// 端到端（D112，用户反馈第 11 轮）：主人在 DSH「新建任务」里选插件自己的预设 = 在跟她聊，记忆照常生效。
// FakeDshCtx（带假的预设注册表和会话投影）+ 真的核心（脚本化的模型、假的 Ollama）+ 真的 QQ 和网页适配器 + 真的插件预设。
// 配置和本机现在的一样：host.adapters.web 里只有 enabled 和 excludeCwdPrefixes（没写 presets）——靠默认值认插件预设。
//   1. 今晚在 QQ 私聊里跟她说了事；
//   2a. 下拉流程：新建任务的空白会话先按标准模式建好（会话头 standard），主人在下拉里换成插件预设（DSH 只追加 agent-preset/selected）
//       → 认领成「和主人的 DSH 聊天」、马上有记忆工具、第一轮的块里有 QQ 私聊的事；
//   2b. 先选好预设再建会话（会话头就是插件预设）→ 一样；
//   3. 不带网页客户端时区的消息（以主人身份连进来的 API 客户端）不认；几秒后来一条网页界面发的就认上（不用等一分钟）；
//   4. 从她的会话里派出去的子代理：自己不认领、没有记忆，但它往 QQ 群里说话照样按父会话送审；
//   4b. 主人从菜单里「分叉会话」分出来的（DSH 的 SessionController.fork：parentSession + isSeeded、没有 origin）是普通会话：照样认领；
//   5. 标准模式（写代码）的会话：什么都没有；
//   6. 插件重载、会话恢复：同一个场合重新认领。
// 账号、群号都是运行时随机生成的；不调真的模型、不碰网络；临时目录在仓库的 .tmp/ 下。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHost } from '../../src/host/index.js';
import { createPersonaPreset, PERSONA_PRESET_ID } from '../../src/preset/index.js';
import { ADAPTER_ID as WEB } from '../../src/adapters/web.js';
import { runPatch } from '../../scripts/bridge-whitelist-patch.mjs';
import { FakeDshCtx, fakeAgent, userMessage, tmpDir, rmDir } from '../fakes/index.js';
import { rid, inMsg, socialFile, atomicWrite } from '../adapters/helpers.js';

function llmScript(opts) {
  const sys = String(opts.system ?? '');
  const user = (opts.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n');
  const reply = (text) => [{ type: 'text-delta', text }, { type: 'usage', usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 50 } }, { type: 'finish', reason: { kind: 'stop' } }];
  if (sys.includes('你正要把下面这段话发出去')) {
    return reply(JSON.stringify(user.includes('复查') ? { verdict: 'reconsider', reflection: '这是主人私下说的，群里不讲', reason: 'private' } : { verdict: 'speak', reflection: '', reason: 'ok' }));
  }
  const cards = (user.match(/卡片 c\d+/g) ?? []).length;
  if (cards) return reply(Array.from({ length: cards }, (_, i) => JSON.stringify({ id: `c${i + 1}`, verdict: 'share', flow: '…', judgement: '…', reason: '测试', hint: false })).join('\n'));
  return reply('ok');
}
function fakeOllama() {
  const vec = (t) => { const h = crypto.createHash('sha256').update(String(t)).digest(); return Array.from({ length: 1024 }, (_, i) => (h[i % 32] - 128) / 128 + (i % 7) / 100); };
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname !== '127.0.0.1') throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    if (u.pathname === '/api/version') return ok({ version: '0.0.0-test' });
    if (u.pathname === '/api/tags') return ok({ models: [{ name: 'qwen3-embedding:4b' }] });
    if (u.pathname === '/api/ps') return ok({ models: [] });
    if (u.pathname === '/api/embed') { const b = JSON.parse(String(init.body ?? '{}')); return ok({ embeddings: (Array.isArray(b.input) ? b.input : [b.input]).map(vec) }); }
    return new Response('nf', { status: 404 });
  };
}
const RESTRICT = `const SAFE_PREFIXES = ['mcp__snowluma__']\nconst SAFE_EXACT = new Set([\n  'ask_user_question',\n  'todo_write',\n])\nexport default SAFE_EXACT\n`;
function makeBridge(root) {
  const bridgeDir = path.join(root, 'bridge');
  const ids = { owner: rid('u'), friend: rid('u'), g: rid('g') };
  const K = { owner: `private:${ids.owner}`, g: `group:${ids.g}` };
  atomicWrite(path.join(bridgeDir, 'config.json'), { ownerQQ: ids.owner, allow: { private: [ids.owner], groups: [ids.g] }, socialV2: { agentPreset: 'qq-chat-v2' } });
  atomicWrite(path.join(bridgeDir, 'state', 'mode.json'), { mode: 'reserved2' });
  atomicWrite(path.join(bridgeDir, 'state', 'sessions.json'), { sessions: { [K.owner]: 'sess-dm', [K.g]: 'sess-g' } });
  const social = path.join(bridgeDir, 'state', 'social-v2.json');
  atomicWrite(social, socialFile({ [K.owner]: { recent: [] }, [K.g]: { recent: [] } }));
  fs.mkdirSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'presets'), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), RESTRICT);
  return { bridgeDir, ids, K, social };
}
const wake = (key, compact, why) => userMessage(`【唤醒】${key}\n原因：${why}\n【本次消息快照】\n${JSON.stringify({ messages: [compact], recent: [] })}\n以上消息已提供，无需重复查询。`, { id: rid('m') });
const compactOf = (m) => ({ seq: m.seq, messageId: m.messageId, sender: m.sender, userId: m.userId, text: m.text, time: m.time });
let seq = 100;
async function step(ctx, agent, messages, opt) {
  const d = await ctx.preStep(agent, messages, opt);
  for (const m of d.messages ?? []) if (m?.source?.kind === 'persona-memory') ctx.sessionEvent(agent.session, { type: 'user/message', seq: seq++, data: m });
  return d;
}
const say = (ctx, agent, text) => ctx.sessionEvent(agent.session, { type: 'assistant/message', seq: seq++, data: { id: rid('a'), role: 'assistant', content: [{ type: 'text', text }] } });
const endTurn = (ctx, agent) => ctx.sessionEvent(agent.session, { type: 'turn/end', seq: seq++, data: {} });
const web = (text, tz = true) => userMessage(text, { id: rid('w'), extra: tz ? { clientTimeZone: 'Asia/Shanghai' } : {} });
const blockOf = (d) => (d.messages ?? []).filter((m) => m.source?.kind === 'persona-memory').map((m) => m.content[0].text).join('\n');
const toolNames = (a) => a.ctx.tools.registered.map((d) => d.name).sort();
const MEMORY_TOOLS = ['memory_fix', 'memory_look', 'memory_note', 'memory_recall'];

test('选了插件预设就是在跟她聊：下拉换预设、先选再建、时区证据、子代理外发、标准模式不碰、重载后同一个场合', async (t) => {
  const dir = tmpDir('e2e-preset');
  const br = makeBridge(dir);
  assert.equal(runPatch({ bridgeDir: br.bridgeDir, apply: true }).applied, true);
  // 和本机现在的配置同一个形状：网页适配器没写 presets
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({
    activation: { noise: false },
    host: { preset: { name: '测试里的她' }, adapters: { qq: { bridgeDir: br.bridgeDir, selfNames: ['小雪'] }, web: { enabled: true, excludeCwdPrefixes: [path.join(br.bridgeDir, 'state')] } }, self: { principalLabel: '主人' } },
  }));
  let now = Date.now();
  const clock = { now: () => now };
  /** 起一套：假的宿主（带预设注册表）+ 插件预设 + 集成层（真的核心）。 */
  const boot = async () => {
    const ctx = new FakeDshCtx({ llmScript });
    const reg = ctx.installPresets();
    let host = null;
    const preset = createPersonaPreset({ ctx, hostConfig: () => host?.configStore?.host?.() ?? {}, now: () => now });
    host = createHost(ctx, {}, { dshHome: dir, clock, coreOptions: { startWorker: false }, defineTool: (d) => d, sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: fakeOllama(), preset });
    preset.start();
    await preset.settled();
    assert.equal(await host.ready, true);
    return { ctx, reg, host, preset };
  };
  let env = await boot();
  t.after(async () => { try { await env.host.dispose(); await env.preset.stop(); } catch { /* 尽力 */ } rmDir(dir); });
  let { ctx, reg, host } = env;

  // 预设在下拉里，名字来自配置；照抄标准模式
  const def = reg.definitions.get(PERSONA_PRESET_ID)?.config;
  assert.equal(def?.name, '测试里的她');
  assert.deepEqual(def.plugins, reg.definitions.get('standard').config.plugins);
  assert.equal(host.status().preset.source, 'standard');
  const sc = await host.selfCheck({ force: true });
  assert.equal(sc.items.find((x) => x.id === 'host.preset')?.level, 'ok');
  assert.match(sc.items.find((x) => x.id === 'dsh-web.claim-evidence' || x.id.endsWith('claim-evidence') && /网页/.test(x.label))?.label ?? '', /「测试里的她」/);

  // 1. 今晚在 QQ 私聊里跟她说的事
  const dm = fakeAgent({ id: 'sess-dm', preset: 'qq-chat-v2', cwd: path.join(br.bridgeDir, 'state', 'agents') });
  await ctx.agentCreated(dm);
  const m1 = inMsg({ seq: 1, userId: br.ids.owner, sender: '老周', text: '今晚跟阿明吃了火锅，明天下午三点我要去医院复查膝盖', time: now, isOwner: true });
  atomicWrite(br.social, socialFile({ [br.K.owner]: { recent: [m1] }, [br.K.g]: { recent: [] } }));
  await step(ctx, dm, [wake(br.K.owner, compactOf(m1), '主人发来私聊')]);
  say(ctx, dm, '好的，明天三点复查记得带片子');
  endTurn(ctx, dm);
  assert.equal(host.claims.get('sess-dm')?.adapterId, 'qq');
  now += 10 * 60_000;

  // 2a. 下拉流程：空白会话按标准模式建好，再换成插件预设（会话头不变）
  const blank = fakeAgent({ id: 'sess-blank', preset: 'standard', cwd: 'D:/proj/somewhere' });
  reg.bind(blank, 'standard');
  await ctx.agentCreated(blank);
  assert.deepEqual(toolNames(blank), [], '标准模式的空白会话：没有记忆工具');
  await reg.select(blank, PERSONA_PRESET_ID);
  assert.equal(blank.session.header.agentPreset, 'standard', '会话头还是 standard');
  assert.deepEqual(toolNames(blank), MEMORY_TOOLS, '换进插件预设：马上有记忆工具');
  assert.deepEqual(host.status().preset.selections, { seen: 1, intoPlugin: 1, liveAgent: 1 });
  const d2a = await step(ctx, blank, [web('我回来了，明天几点去医院来着？')]);
  const c2a = host.claims.get('sess-blank');
  assert.equal(c2a?.adapterId, WEB);
  const b2a = blockOf(d2a);
  assert.match(b2a, /复查/, '第一轮就想得起 QQ 私聊里说的事');
  assert.ok((ctx.resolveContexts(blank)[0]?.text ?? '').length > 0, '常驻区有她的东西');
  say(ctx, blank, '明天下午三点，复查膝盖');
  endTurn(ctx, blank);

  // 2b. 先选好预设再建会话
  const s2 = fakeAgent({ id: 'sess-web', preset: PERSONA_PRESET_ID, cwd: 'D:/proj/somewhere' });
  reg.bind(s2, PERSONA_PRESET_ID);
  await ctx.agentCreated(s2);
  assert.deepEqual(toolNames(s2), MEMORY_TOOLS);
  const d2b = await step(ctx, s2, [web('明天下午我要干嘛？')]);
  const c2b = host.claims.get('sess-web');
  assert.equal(c2b?.adapterId, WEB);
  assert.equal(c2b.settingId, c2a.settingId, '两个网页会话记在同一个「和主人的 DSH 聊天」');
  assert.match(blockOf(d2b), /复查|火锅|三点/);
  endTurn(ctx, s2);

  // 3. 不带网页客户端时区的消息：不认；工具结果之后的续步也不认；几秒后来一条网页界面发的：认上
  const s3 = fakeAgent({ id: 'sess-api', preset: PERSONA_PRESET_ID, cwd: 'D:/proj/somewhere' });
  await ctx.agentCreated(s3);
  assert.equal(blockOf(await step(ctx, s3, [web('hello from api', false)])), '');
  assert.equal(host.claims.get('sess-api'), null);
  now += 6000;
  await step(ctx, s3, [], { step: 2 });
  assert.equal(host.claims.get('sess-api'), null, '续步（没有用户消息）也不认');
  endTurn(ctx, s3);
  now += 6000;
  await step(ctx, s3, [web('现在是桌面端发的')], { turn: 2 });
  assert.equal(host.claims.get('sess-api')?.adapterId, WEB, '不用等一分钟');
  endTurn(ctx, s3);

  // 4. 子代理：自己不认领、没有记忆；它往 QQ 群里说主人的事 → 按父会话审（D113：非公开目标走外发守护——对话里被回答的就是主人，
  //    他自己的话由她判断，放行）
  const sub = fakeAgent({ id: 'sess-sub', preset: PERSONA_PRESET_ID, origin: 'subagent', delegationDepth: 1, parentSession: 'sess-web', cwd: 'D:/proj/somewhere' });
  await ctx.agentCreated(sub);
  const dsub = await step(ctx, sub, [web('子任务')]);
  assert.equal(host.claims.get('sess-sub'), null);
  assert.deepEqual(toolNames(sub), []);
  assert.equal(blockOf(dsub), '');
  assert.equal(ctx.resolveContexts(sub)[0]?.text ?? '', '');
  const appraisedBefore = host.egress.status().appraised;
  const eSub = await ctx.preExecute({ name: 'mcp__snowluma__qq_send_group_message', callId: 'e-sub', agent: sub, arguments: { groupId: br.ids.g, message: '主人说他明天下午三点去医院复查膝盖' } });
  assert.equal(eSub.decision.kind, 'allow', '子代理的外发按父会话审（主人自己的事、在跟主人说话：守护不管）');
  assert.ok(host.egress.status().appraised > appraisedBefore);
  assert.ok(host.egress.status().inheritedClaims >= 1);
  // 她的会话里用标准模式的工具：照常
  const long = '这是一段很长的计划文字，用来测试计划审批的工具在她的会话里不会被当成没分类的工具拦下来，长度超过四十个字。';
  assert.equal((await ctx.preExecute({ name: 'exit_plan_mode', callId: 'e-plan', agent: s2, arguments: { plan: `# 计划\n${long}` } })).decision.kind, 'allow');
  assert.equal((await ctx.preExecute({ name: 'write', callId: 'e-w', agent: s2, arguments: { path: 'a.txt', content: long } })).decision.kind, 'allow');

  // 4b. 分叉会话（集成复查）：DSH 把它当普通会话（只有 origin 'subagent' 才是子代理）——认领、有记忆工具、记在同一个场合
  const fork = fakeAgent({ id: 'sess-fork', preset: PERSONA_PRESET_ID, parentSession: 'sess-web', cwd: 'D:/proj/somewhere' });
  fork.session.header.isSeeded = true;
  reg.bind(fork, PERSONA_PRESET_ID);
  await ctx.agentCreated(fork);
  assert.deepEqual(toolNames(fork), MEMORY_TOOLS);
  const dFork = await step(ctx, fork, [web('换个思路，明天几点去医院？')]);
  assert.equal(host.claims.get('sess-fork')?.adapterId, WEB, '分叉出来的是普通会话');
  assert.equal(host.claims.get('sess-fork').settingId, c2a.settingId);
  assert.match(blockOf(dFork), /复查|火锅|三点/);
  const recallFork = await fork.ctx.tools.registered.find((d) => d.name === 'memory_recall').execute({ query: '医院' }, { agent: fork, callId: 'r-fork', signal: new AbortController().signal });
  assert.doesNotMatch(String(recallFork ?? ''), /现在用不了记忆工具/, '记忆工具在分叉会话里能用');
  endTurn(ctx, fork);

  // 5. 标准模式（写代码）的会话：什么都没有
  const code = fakeAgent({ id: 'sess-code', preset: 'standard', cwd: 'D:/proj/somewhere' });
  await ctx.agentCreated(code);
  const d5 = await step(ctx, code, [web('帮我改一下这个函数')]);
  assert.equal(host.claims.get('sess-code'), null);
  assert.deepEqual(toolNames(code), []);
  assert.equal(blockOf(d5), '');
  assert.equal(ctx.resolveContexts(code)[0]?.text ?? '', '');
  assert.ok(host.status().claims.byAdapter[WEB] >= 3);

  // 6. 插件重载、会话恢复（DSH 从会话记录重建投影：还是插件预设）
  await env.host.dispose();
  await env.preset.stop();
  env = await boot();
  ({ ctx, reg, host } = env);
  const back = fakeAgent({ id: 'sess-blank', preset: 'standard', cwd: 'D:/proj/somewhere' });
  ctx.selectedPresets.set(back.session, PERSONA_PRESET_ID);
  await ctx.agentCreated(back, { kind: 'resume' });
  assert.deepEqual(toolNames(back), MEMORY_TOOLS);
  now += 3_600_000;
  await step(ctx, back, [web('我复查回来了')], { turn: 3 });
  assert.equal(host.claims.get('sess-blank')?.settingId, c2a.settingId, '同一个场合');
  assert.ok((ctx.resolveContexts(back)[0]?.text ?? '').length > 0);
});
