// 宿主 + 真的核心（rugu-core，不起 worker、嵌入离线 → L3）+ 真的网页适配器：确认集成层交给核心的形状都合契约
// （端口、sessions.bind / injected / confirm / abort / markTurnTaint / step、observe、modeOf、resident、recall、appraise / outcome），
// 出错时钩子照样放行。数据都在 .tmp 下；不调 LLM、不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHost } from '../../src/host/index.js';
import { FakeDshCtx, fakeAgent, userMessage, tmpDir, rmDir } from '../fakes/index.js';
import { offlineFetch } from './helpers.js';

const webMessage = (text, id) => userMessage(text, { id, extra: { clientTimeZone: 'Asia/Shanghai' } });

test('真核心：打开库（数据目录在 DSH 家目录下）、网页适配器注册并描述场合；认领 → 当场入库 → 召回 → 常驻区；外发审视；卸载时关库', async () => {
  const dir = tmpDir('realcore');
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { adapters: { web: { presets: ['web-chat'] } } } }));
  const ctx = new FakeDshCtx();
  let t = Date.now();
  const host = createHost(ctx, {}, {
    dshHome: dir, clock: { now: () => t }, coreOptions: { startWorker: false }, adapterFactories: undefined, registerAdmin: null, defineTool: (d) => d,
    sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch,
  });
  assert.equal(await host.ready, true, JSON.stringify(host.status().error));
  const pm = host.getPm();
  assert.ok(fs.existsSync(path.join(dir, 'persona-memory')), '数据目录');
  assert.ok(fs.existsSync(path.join(dir, 'persona-memory.key')), '身份哈希密钥（§12.3）');
  assert.deepEqual(pm.status().adapters, ['dsh-web']);
  assert.equal(host.status().adapters.find((a) => a.id === 'qq').error, 'NOT_CONFIGURED');

  const agent = fakeAgent({ id: 'sess-web-1', preset: 'web-chat' });
  ctx.agents.map.set(agent.id, agent);
  const d = await ctx.preStep(agent, [webMessage('还记得我上周说的那家店吗', 'm-1')]);
  assert.ok(Array.isArray(d.messages));
  const claim = host.claims.get('sess-web-1');
  assert.equal(claim.adapterId, 'dsh-web');
  assert.equal(pm.modeOf(claim.settingId), 'live', '描述过的场合有生效档；每类场合默认都开着（§15.2）');
  assert.equal(pm.sessions.get('sess-web-1')?.settingKey != null, true, 'sessions.bind 落库了');
  // 常驻区（同步、冻结）：开着时是核心渲染好的文本；关着是空串
  const resident = ctx.resolveContexts(agent)[0];
  assert.equal(resident.name, 'persona-memory:core');
  assert.equal(typeof resident.text, 'string');
  // 和主人一对一：主人的第一条消息落库之后马上按主人一对一那一档算（不等生效档缓存过期）；第一条消息就可能插块（D96）。
  // 这一轮结束、块没被确认（DSH 里会话事件没写回）：回合结束时丢弃，下一轮照常可以再给
  assert.equal(pm.modeOf(claim.settingId), 'live', '§15.2：和主人的一对一默认开着');
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 3, data: {} });
  await new Promise((r) => setTimeout(r, 100));
  t += 61_000;
  const d2 = await ctx.preStep(agent, [webMessage('我下周去哪来着', 'm-2')], { turn: 2 });
  const block = d2.messages.find((m) => m.source?.kind === 'persona-memory');
  assert.ok(block, '插了增量块');
  assert.match(block.content[0].text, /^【记忆·内部参考】/);
  ctx.sessionEvent(agent.session, { type: 'user/message', seq: 4, data: block });
  assert.equal(host.status().context.confirmed, 1);
  assert.ok(ctx.resolveContexts(agent)[0].text.length > 0, '开着：常驻区有核心渲染好的文本');
  // 她的回答回流成她说的话（会话事件 → 绑定翻译 → observe）
  ctx.sessionEvent(agent.session, { type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, message: { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: '记得呀，是街角那家' }] }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } } });
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 6, data: {} });
  // 外发：网页没有说话类工具；DSH 自带的 bash 不审；没分类的长文本工具（D113）放行、提示补分类
  assert.equal((await ctx.preExecute({ name: 'bash', callId: 'b1', agent, arguments: { command: 'echo 1' } })).decision.kind, 'allow');
  const r = await ctx.preExecute({ name: 'mystery_post', callId: 'p1', agent, arguments: { text: '这是一段足够长的自由文本，用来模拟她要说出去的一整句话，至少四十个字才算数呢，对吧对吧。' } });
  assert.equal(r.decision.kind, 'allow');
  assert.equal(host.status().egress.unclassifiedPassed, 1);
  // 外壳上的 appraise 走真核心（bili-eyes 那条路）
  const a = await host.service.expression.appraise({ channel: { targetSettingId: claim.settingId, persistence: 'once' }, text: ['好的'], origin: { path: 'background' } });
  assert.equal(a.verdict, 'speak');
  host.service.expression.outcome(a.token, 'sent', {});
  // 记忆工具：认领时补注册；有意回想在真核心上跑（L3，嵌入离线）
  const recallTool = agent.ctx.tools.registered.find((t) => t.name === 'memory_recall');
  assert.ok(recallTool);
  const txt = await recallTool.execute({ query: '那家店' }, { agent, callId: 'r1', signal: new AbortController().signal });
  assert.equal(typeof txt, 'string');
  await ctx.postExecute({ name: 'memory_recall', callId: 'r1', agent, arguments: {} }, { content: [{ type: 'text', text: txt }], isError: false });
  // 维护 tick 在真核心上跑一次（不起调度器）
  const tick = await host.scheduler.tickOnce();
  assert.ok(tick && typeof tick === 'object');
  // 状态里没有内容
  const st = JSON.stringify(host.status());
  assert.ok(!st.includes('那家店') && !st.includes('街角'), '总览只有数字和状态');
  assert.deepEqual(host.status().hooks['pre-step'].errors, 0);
  assert.equal(host.status().hooks['session-event'].errors, 0);
  const sc = await host.selfCheck();
  assert.equal(sc.items.find((x) => x.id === 'store.open').status, 'ok');
  assert.equal(sc.items.find((x) => x.id === 'runtime.sqlite').status, 'ok');
  await host.dispose();
  assert.equal(host.getPm(), null);
  // 重开：同一个库、同一份密钥
  const host2 = createHost(new FakeDshCtx(), {}, { dshHome: dir, coreOptions: { startWorker: false }, adapterFactories: undefined, registerAdmin: null, defineTool: (d) => d, sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch });
  assert.equal(await host2.ready, true);
  assert.equal(host2.getPm().sessions.get('sess-web-1')?.settingKey != null, true, '会话绑定还在库里');
  await host2.dispose();
  rmDir(dir);
});

test('真核心：压缩失败（compaction-basic 失败时也写一条带 error 的 compaction/end）不开新周期——已发名单和污点账本照旧；成对的成功压缩才 +1', async () => {
  const dir = tmpDir('realcore-compact');
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { adapters: { web: { presets: ['web-chat'] } } } }));
  const ctx = new FakeDshCtx();
  let t = Date.now();
  const host = createHost(ctx, {}, {
    dshHome: dir, clock: { now: () => t }, coreOptions: { startWorker: false }, adapterFactories: undefined, registerAdmin: null, defineTool: (d) => d,
    sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch,
  });
  assert.equal(await host.ready, true);
  const pm = host.getPm();
  const agent = fakeAgent({ id: 'sess-web-c', preset: 'web-chat' });
  ctx.agents.map.set(agent.id, agent);
  await ctx.preStep(agent, [webMessage('我跟你说个秘密，我打算下个月辞职，先别告诉别人', 'm-1')]);
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 3, data: {} });
  await new Promise((r) => setTimeout(r, 100));
  t += 61_000;
  const d2 = await ctx.preStep(agent, [webMessage('我之前说要辞职的事你还记得吗', 'm-2')], { turn: 2 });
  const block = d2.messages.find((m) => m.source?.kind === 'persona-memory');
  if (block) ctx.sessionEvent(agent.session, { type: 'user/message', seq: 4, data: block });
  const before = pm.sessions.get('sess-web-c');
  assert.ok(before, '会话绑定落库了');
  // 会话里有没有早先注入的记忆（外发钩子在场合被关掉以后据此决定还审不审）
  assert.equal(pm.sessions.holdsMemory('sess-no-such'), false);
  if (block) assert.equal(pm.sessions.holdsMemory('sess-web-c'), true, '注入并确认过的条目在污点账本里');
  ctx.sessionEvent(agent.session, { type: 'compaction/start', seq: 5, data: { compactionId: 'c1', turn: 2 } });
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 6, data: { compactionId: 'c1', turn: 2, error: 'LlmError: summary request failed' } });
  const failed = pm.sessions.get('sess-web-c');
  assert.equal(failed.cycle, before.cycle, '失败的压缩不开新周期');
  assert.equal(failed.warmPending, before.warmPending, '不标「待暖启动」（不会把同样的条目再注入一遍）');
  assert.equal(host.status().context.compactionFailed, 1);
  // 对不上 start 的 end：不知道成没成，按没成
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 7, data: { compactionId: 'c-unknown', turn: 2 } });
  assert.equal(pm.sessions.get('sess-web-c').cycle, before.cycle);
  assert.equal(host.status().context.compactionUnpaired, 1);
  // 成对的成功压缩
  ctx.sessionEvent(agent.session, { type: 'compaction/start', seq: 8, data: { compactionId: 'c2', turn: 2 } });
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 9, data: { compactionId: 'c2', turn: 2 } });
  assert.equal(pm.sessions.get('sess-web-c').cycle, before.cycle + 1);
  assert.equal(pm.sessions.get('sess-web-c').warmPending, true);
  await host.dispose();
  rmDir(dir);
});
