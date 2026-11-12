// 每轮上下文（§10.4）、会话事件（§10.5）、钩子防护（§10.10）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePm, fakeAgent, userMessage, fakeBinding } from '../fakes/index.js';
import { makeHost } from './helpers.js';
import { insertAfterClaimed, recallWaitMs } from '../../src/host/context.js';

const rt = (m) => m.source?.kind === 'runtime-context';

test('没认领的会话：不召回、不插、常驻区空串（不是她的会话不注入）', async () => {
  const { ctx, pm, cleanup } = await makeHost({ name: 'ctx-unclaimed' });
  const agent = fakeAgent({ preset: 'coding' });
  const msgs = [userMessage('帮我看看这个 bug')];
  const d = await ctx.preStep(agent, msgs);
  assert.equal(d.messages.length, 2);
  assert.equal(pm.named('recall').length, 0);
  assert.equal(pm.named('bind').length, 0);
  assert.equal(ctx.resolveContexts(agent)[0].text, '');
  await cleanup();
});

test('记忆开着（live）+ 真实新消息：当场入库 → 召回 → 记待确认 → 插在最后一条 claimed 后面；看到 nonce 才确认，回合结束丢弃', async () => {
  const { ctx, pm, cleanup } = await makeHost({ name: 'ctx-live' });
  const agent = fakeAgent({ id: 's-live', preset: 'zz-chat' });
  const m1 = userMessage('前天说的团建定了吗', { id: 'u1' });
  const d = await ctx.preStep(agent, [m1], { step: 1 });
  // 认领一次、交给核心绑定
  assert.deepEqual(pm.named('bind')[0].args[0], { sessionId: 's-live', settingId: 'set-zz-1', adapterId: 'zz', confidence: 'specific' });
  // 唤醒消息当场入库（E 路），来源是认领它的适配器
  const obs = pm.named('observe')[0];
  assert.equal(obs.args[0][0].id, 'obs-u1');
  assert.deepEqual(obs.args[1], { adapter: 'zz' });
  // 召回：只给指针（Situation 由核心组装，AR-03）
  const [s, opt] = pm.named('recall')[0].args;
  assert.deepEqual(s, { settingId: 'set-zz-1', sessionId: 's-live', trigger: 'message', homeSettingId: 'set-zz-1', focusObsId: 'obs-u1' });
  assert.equal(opt.mode, 'involuntary');
  assert.equal(opt.deadlineMs, 1500, 'D117：不自主回想的截止 800 → 1500');
  assert.equal(opt.budgetChars, 2000, 'D165：主人没手写时跟着核心的 context.blockMaxChars（平衡档 2000）');
  // 待确认：只记 id / layer / verdict / appraisalRef，加这一条自己的字数（D133：核心按条目的层记注入预算），不记正文
  const inj = pm.named('injected')[0].args[0];
  assert.equal(inj.mode, 'live');
  assert.equal(inj.sessionId, 's-live');
  assert.deepEqual(inj.items.map(({ chars, ...rest }) => rest), [{ id: 'a1', layer: 'recalled', verdict: 'share', appraisalRef: 'ap1' }]);
  assert.ok(Number.isInteger(inj.items[0].chars) && inj.items[0].chars > 0 && inj.items[0].chars < inj.chars, '一条的字数比整块（带块头）少');
  assert.equal(inj.items[0].chars, Array.from('前天这里聊到团建去哪，还没定').length);
  assert.ok(!JSON.stringify(inj.items).includes('团建'), '不记正文');
  assert.ok(inj.chars > 10);
  // 插在最后一条 claimed 后面，运行时上下文之前
  assert.equal(d.messages.length, 3);
  assert.equal(d.messages[0], m1);
  const block = d.messages[1];
  assert.equal(block.role, 'user');
  assert.equal(block.source.kind, 'persona-memory', 'F21：自定义 source.kind');
  assert.equal(block.source.form, `recalled:${inj.nonce}`);
  assert.ok(block.content[0].text.startsWith('【记忆·内部参考】'));
  assert.ok(block.content[0].text.includes('团建'));
  assert.ok(Object.isFrozen(block));
  assert.ok(rt(d.messages[2]));
  // 这一轮由没有主人证据的人开启：不清按轮污点（§9.6「从最近一条有权限的说话人的消息开始」）
  assert.equal(pm.named('markTurnTaint').length, 0);
  // 第一次认领成功时补注册记忆工具
  assert.equal(agent.ctx.tools.registered.length, 4);   // D156 起四个：recall、note、look、fix
  // 会话事件里看到这个 nonce 才算发过
  ctx.sessionEvent(agent.session, { type: 'user/message', seq: 5, data: block });
  assert.deepEqual(pm.named('confirm')[0].args, ['s-live', inj.nonce]);
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.deepEqual(pm.named('abort')[0].args, ['s-live']);
  await cleanup();
});

test('F7：claimed 里没有真实新消息（只有运行时上下文、工具带来的上下文）就不召回、不插', async () => {
  const { ctx, pm, cleanup } = await makeHost({ name: 'ctx-f7' });
  const agent = fakeAgent({ preset: 'zz-chat' });
  const tc = { id: 'tc', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'repeat-tool-reminder' } };
  const d = await ctx.preStep(agent, [tc], { step: 3 });
  assert.equal(d.messages.length, 2);
  assert.equal(pm.named('recall').length, 0);
  const d2 = await ctx.preStep(agent, [], { step: 4, runtimeContext: false });
  assert.equal(d2.messages.length, 0, '回合将结束时绝不插');
  await cleanup();
});

test('没有影子档：读不到档位（核心出错、旧版本的 shadow）就不插、不记注入日志、常驻区也不给（fail closed）；记忆关着（off）连回想都不做', async () => {
  const pm = createFakePm({ modes: { 'set-zz-1': new Error('坏了') } });
  const { ctx, host, cleanup } = await makeHost({ pm, name: 'ctx-withheld' });
  const agent = fakeAgent({ preset: 'zz-chat' });
  const d = await ctx.preStep(agent, [userMessage('在吗')]);
  assert.equal(d.messages.length, 2);
  assert.equal(pm.named('recall').length, 1);
  assert.equal(pm.named('injected').length, 0, '没进她的上下文的块不记注入日志');
  assert.equal(host.status().context.withheldBlocks, 1);
  assert.equal(ctx.resolveContexts(agent)[0].text, '');
  // 核心报出不认识的档（旧版本的 shadow）：当读不到
  pm.modes['set-zz-1'] = 'shadow';
  const d1 = await ctx.preStep(agent, [userMessage('还在吗', { id: 'u-s' })], { turn: 2 });
  assert.equal(d1.messages.some((m) => m.source?.kind === 'persona-memory'), false);
  assert.equal(pm.named('injected').length, 0);
  // 主人把这里的记忆关掉：不回想
  pm.modes['set-zz-1'] = 'off';
  const d2 = await ctx.preStep(agent, [userMessage('再问一句', { id: 'u-off' })], { turn: 3 });
  assert.equal(d2.messages.some((m) => m.source?.kind === 'persona-memory'), false);
  assert.equal(pm.named('recall').length, 2, '关着的场合不回想');
  await cleanup();
});

test('「在问过去」时核心放宽到有意回想的截止时间：集成层要等到那么久，结果照样注入（实测问题 #2）', async () => {
  // 核心 1.5 秒才返回：比不自主回想的 800 + 200 久，但在有意回想的 3000 之内
  const item = { id: 'p461', layer: 'recalled', rendered: '主人说过两天要玩时之笛', verdict: 'share', confidence: 1, provenance: '', appraisalRef: 'ap975' };
  const late = createFakePm({ recall: () => new Promise((r) => setTimeout(() => r({ items: [item], degradeLevel: 1, traceId: 't' }), 1500)) });
  const a = await makeHost({ pm: late, name: 'ctx-past' });
  const d = await a.ctx.preStep(fakeAgent({ id: 's-past', preset: 'zz-chat' }), [userMessage('你还记得我过几天要玩什么游戏吗')], { step: 1 });
  assert.equal(d.messages.length, 3, '结果没被丢掉');
  assert.ok(d.messages[1].content[0].text.includes('时之笛'));
  assert.equal(a.host.status().context.recallTimeouts, 0);
  assert.equal(late.named('recallCached').length, 0);
  await a.cleanup();

  // 核心配置调短了就按配置的等：max(30, 60) + 20
  const never = createFakePm({ recall: () => new Promise(() => {}) });
  const b = await makeHost({ pm: never, name: 'ctx-past-short', config: { recall: { deliberate: { deadlineMs: 60 } }, host: { inject: { deadlineMs: 30, graceMs: 20 } } } });
  const t0 = Date.now();
  await b.ctx.preStep(fakeAgent({ preset: 'zz-chat' }), [userMessage('还记得吗')]);
  const waited = Date.now() - t0;
  assert.ok(waited >= 70 && waited < 500, `按 60 + 20 等，实际 ${waited}ms`);
  assert.equal(b.host.status().context.recallTimeouts, 1);
  await b.cleanup();
});

test('recallWaitMs：和核心同样的规则取大的那个，读不到核心配置按 4000（D117），非正数按不自主回想的截止时间，最多 10 秒', () => {
  assert.equal(recallWaitMs(800, { recall: { deliberate: { deadlineMs: 3000 } } }, {}), 3200);
  assert.equal(recallWaitMs(800, null, {}), 4200, '读不到核心配置（按核心默认的 4000）');
  assert.equal(recallWaitMs(800, {}, { graceMs: 50 }), 4050, '核心配置里没有这一项');
  assert.equal(recallWaitMs(800, { recall: { deliberate: { deadlineMs: 0 } } }, {}), 1000, '0：核心按 800 算');
  assert.equal(recallWaitMs(800, { recall: { deliberate: { deadlineMs: -5 } } }, { graceMs: -10 }), 800);
  assert.equal(recallWaitMs(800, { recall: { deliberate: { deadlineMs: 60_000 } } }, {}), 10_000, '封顶');
  assert.equal(recallWaitMs(1500, { recall: { deliberate: { deadlineMs: 1000 } } }, { graceMs: 0 }), 1500);
});

test('等核心回想时回合被取消：马上结束等待，不记待确认、不插', async () => {
  const slow = createFakePm({ recall: () => new Promise((r) => setTimeout(() => r({ items: [{ id: 'a1', layer: 'recalled', rendered: '某件事', verdict: 'share', confidence: 1, provenance: '', appraisalRef: 'ap1' }], degradeLevel: 0, traceId: 't' }), 2000)) });
  const a = await makeHost({ pm: slow, name: 'ctx-abort' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const d = await a.ctx.preStep(fakeAgent({ preset: 'zz-chat' }), [userMessage('你还记得吗')], { step: 1, signal: ac.signal });
  assert.ok(Date.now() - t0 < 1000, '不等满');
  assert.equal(d.messages.length, 2);
  assert.equal(slow.named('injected').length, 0);
  await a.cleanup();
});

test('召回超时或出错：退回 recallCached，不插；注入日志对不上判定（缺 appraisalRef）：整块不注入', async () => {
  const slow = createFakePm({ recall: () => new Promise(() => {}) });
  // 集成层按核心的有意回想截止时间等（实测问题 #2），这里把它也调短
  const a = await makeHost({ pm: slow, name: 'ctx-slow', config: { recall: { deliberate: { deadlineMs: 60 } }, host: { inject: { deadlineMs: 30 } } } });
  const t0 = Date.now();
  const d = await a.ctx.preStep(fakeAgent({ preset: 'zz-chat' }), [userMessage('在吗')]);
  assert.ok(Date.now() - t0 < 1500, '聊天永远不等（§8.8）');
  assert.equal(d.messages.length, 2);
  assert.equal(slow.named('recallCached').length, 1);
  assert.equal(a.host.status().context.recallTimeouts, 1);
  await a.cleanup();

  const bad = createFakePm({ recall: async () => ({ items: [{ id: 'a9', layer: 'recalled', rendered: '某件事', verdict: 'share', confidence: 1, provenance: '', appraisalRef: '' }], degradeLevel: 0, traceId: 't' }) });
  const b = await makeHost({ pm: bad, name: 'ctx-unappraised' });
  const d2 = await b.ctx.preStep(fakeAgent({ preset: 'zz-chat' }), [userMessage('在吗')]);
  assert.equal(d2.messages.length, 2, '§9.3.6 / D47');
  assert.equal(b.host.status().context.unappraised, 1);
  await b.cleanup();
});

test('常驻区冻结（§10.4）：provider 只返回冻结的文本；真实新消息到来时和压缩结束后才换；出错返回上一次的', async () => {
  const { ctx, pm, cleanup } = await makeHost({ name: 'ctx-resident' });
  const agent = fakeAgent({ id: 's-r', preset: 'zz-chat' });
  assert.equal(ctx.resolveContexts(agent)[0].text, '', '认领之前（第一次 pre-step 之前）是空串');
  await ctx.preStep(agent, [userMessage('早')]);
  const t1 = ctx.resolveContexts(agent)[0].text;
  assert.match(t1, /常驻区 set-zz-1 v1/);
  const n = pm.named('resident').length;
  for (let i = 0; i < 5; i++) assert.equal(ctx.resolveContexts(agent)[0].text, t1, 'F3/F6：每次请求前重跑也不变');
  assert.equal(pm.named('resident').length, n, '不重复向核心要');
  await ctx.preStep(agent, [], { step: 2 });
  assert.equal(ctx.resolveContexts(agent)[0].text, t1, '没有真实新消息不换');
  await ctx.preStep(agent, [userMessage('又来了')], { step: 1 });
  const t2 = ctx.resolveContexts(agent)[0].text;
  assert.notEqual(t2, t1, '真实新消息到来时换');
  ctx.sessionEvent(agent.session, { type: 'compaction/start', seq: 20, data: {} });
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 21, data: {} });
  assert.deepEqual(pm.named('compaction').map((c) => c.args), [['s-r', 'start'], ['s-r', 'end']]);
  const t3 = ctx.resolveContexts(agent)[0].text;
  assert.notEqual(t3, t2, '压缩结束后换');
  assert.equal(ctx.resolveContexts(agent)[0].text, t3);
  // provider 出错：返回上一次的冻结文本
  pm.modes['set-zz-1'] = new Error('boom');
  pm.modeOf = () => { throw new Error('boom'); };
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 22, data: {} });
  pm.resident = () => { throw new Error('db down'); };
  pm.modeOf = () => 'live';
  assert.equal(ctx.resolveContexts(agent)[0].text, t3);
  await cleanup();
});

test('会话事件：她每一步之后的上下文 token 进滚动窗口；主聊天用量进基线；普通消息交给绑定翻译成感知', async () => {
  const { ctx, pm, host, cleanup } = await makeHost({ name: 'ctx-events' });
  const agent = fakeAgent({ id: 's-e', preset: 'zz-chat' });
  await ctx.preStep(agent, [userMessage('在吗', { id: 'u0' })]);
  ctx.sessionEvent(agent.session, { type: 'assistant/message', seq: 3, data: { message: {}, usage: { inputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 50 } } });
  const st = pm.named('step')[0].args;
  assert.equal(st[0], 's-e');
  assert.equal(st[1].contextTokens, 2150);
  assert.equal(host.status().budget.today.mainYuan > 0, true, '主聊天的基线只用来观察（§10.6）');
  const before = pm.named('observe').length;
  ctx.sessionEvent(agent.session, { type: 'user/message', seq: 4, data: userMessage('第二条', { id: 'u2' }) });
  assert.equal(pm.named('observe').length, before + 1);
  assert.equal(pm.named('observe').at(-1).args[0][0].id, 'obs-u2');
  // 没认领的会话的事件不进记忆
  ctx.sessionEvent({ id: 'other', header: {} }, { type: 'user/message', seq: 1, data: userMessage('别人的') });
  assert.equal(pm.named('observe').length, before + 1);
  await cleanup();
});

test('定时任务唤醒：trigger 是 reminder，这一轮没有触发消息（memory_note 做不了）；她这一轮自己想（memory_recall）也按她自己开启的轮（idle，D144）', async () => {
  const { ctx, pm, host, cleanup } = await makeHost({ name: 'ctx-reminder' });
  const agent = fakeAgent({ id: 's-rem', preset: 'zz-chat' });
  await ctx.preStep(agent, [userMessage('提醒：喝水', { kind: 'schedule' })]);
  assert.equal(pm.named('recall')[0].args[0].trigger, 'reminder');
  assert.equal(host.assembler.turnState('s-rem').selfTurn, true);
  const note = agent.ctx.tools.registered.find((t) => t.name === 'memory_note');
  const out = await note.execute({ text: 'x', evidence_quote: 'x' }, { agent, callId: 'n1' });
  assert.match(out, /还没看到别人对你说的话/);
  const recall = agent.ctx.tools.registered.find((t) => t.name === 'memory_recall');
  await recall.execute({ query: '喝水' }, { agent, callId: 'r1' });
  const sit = pm.named('recall').at(-1).args[0];
  assert.equal(sit.trigger, 'idle', '不按 message 想：核心不会退回这里最后一个对她说话的人');
  assert.equal(sit.focusObsId, undefined);
  await cleanup();
});

test('两个 specific 同时认领：不认领、报警（fail closed，§10.3）', async () => {
  const b1 = fakeBinding({ adapterId: 'aa', preset: 'shared' });
  const b2 = fakeBinding({ adapterId: 'bb', preset: 'shared' });
  const { ctx, pm, host, cleanup } = await makeHost({ name: 'ctx-conflict', bindings: [b1, b2] });
  const d = await ctx.preStep(fakeAgent({ preset: 'shared' }), [userMessage('在吗')]);
  assert.equal(d.messages.length, 2);
  assert.equal(pm.named('bind').length, 0);
  assert.equal(host.status().claims.conflicts.length, 1);
  await cleanup();
});

test('钩子防护：pre-step 里出错永不外抛；同一会话连续 3 次出错，这个钩子在该会话关 10 分钟', async () => {
  const pm = createFakePm();
  pm.observe = () => { throw new Error('boom'); };
  const { ctx, host, cleanup } = await makeHost({ pm, name: 'ctx-breaker' });
  const agent = fakeAgent({ id: 's-b', preset: 'zz-chat' });
  for (let i = 0; i < 3; i++) {
    const d = await ctx.preStep(agent, [userMessage(`第${i}条`)]);
    assert.equal(d.messages.length, 2, '出错返回原结果');
  }
  const recalls = pm.named('recall').length;
  await ctx.preStep(agent, [userMessage('第4条')]);
  assert.equal(pm.named('recall').length, recalls, '熔断中：直接放行');
  const hs = host.status().hooks['pre-step'];
  assert.equal(hs.errors, 3);
  assert.equal(hs.openSessions, 1);
  assert.equal(hs.skipped, 1);
  // 别的会话不受影响
  await ctx.preStep(fakeAgent({ id: 's-b2', preset: 'zz-chat' }), [userMessage('你好')]);
  assert.equal(host.status().hooks['pre-step'].errors, 4);
  await cleanup();
});

test('insertAfterClaimed：插在最后一条 claimed 后面；找不到就放最后', () => {
  const a = { id: 'a' }; const b = { id: 'b' }; const r = { id: 'rt' }; const m = { id: 'mine' };
  assert.deepEqual(insertAfterClaimed([a, b, r], [a, b], m).map((x) => x.id), ['a', 'b', 'mine', 'rt']);
  assert.deepEqual(insertAfterClaimed([r], [a], m).map((x) => x.id), ['rt', 'mine']);
});

test('按轮污点：主人开启的一轮（说话人带主人证据）才清上一轮的污点；轮中的后续步骤、群友和定时提醒开启的轮都不清', async () => {
  const principalBinding = fakeBinding({
    fromSessionEvent: (ev, setting, sessionId) => (ev.type === 'user/message' && ev.data?.source?.kind === 'user' ? [{
      id: `obs-${ev.data.id}`, settingId: setting, visibleTo: 'setting-audience', at: Date.now(), perceivedAt: Date.now(),
      actor: { claims: [{ kind: 'account', namespace: 'zz', id: 'owner', verifiedBy: 'config' }, { kind: 'principal', strength: 'config' }] },
      kind: 'utterance', text: 'x', addressed: 'to-her', attention: 'attended', evidential: true, standing: 'first-hand', sessionRef: { sessionId },
    }] : []),
  });
  const { ctx, pm, cleanup } = await makeHost({ name: 'ctx-taint', bindings: [principalBinding] });
  const agent = fakeAgent({ id: 's-taint', preset: 'zz-chat' });
  await ctx.preStep(agent, [userMessage('帮我看看这个网页', { id: 'u1' })], { step: 1 });
  assert.deepEqual(pm.named('markTurnTaint').map((c) => c.args[1]), [{ tainted: false, reason: 'turn-start' }]);
  await ctx.preStep(agent, [userMessage('顺便再看一个', { id: 'u2' })], { step: 3 });
  assert.equal(pm.named('markTurnTaint').length, 1, '轮中的后续步骤不清');
  await ctx.preStep(agent, [userMessage('（提醒）', { id: 's1', kind: 'schedule' })], { step: 1, turn: 2 });
  assert.equal(pm.named('markTurnTaint').length, 1, '定时提醒开启的轮不清');
  await cleanup();
});

test('新场合的第一条消息：回想之前场合还没描述进库（生效档读不到），回想之后是开着就照常插块（核心先落库再算，D96）', async () => {
  const pm = createFakePm();
  pm.modes['set-zz-1'] = Object.assign(new Error('not described'), { code: 'CONTRACT' });
  const recall0 = pm.recall;
  pm.recall = async (s, opt) => { pm.modes['set-zz-1'] = 'live'; return recall0(s, opt); };   // 核心在回想里落库、描述场合
  const { ctx, cleanup } = await makeHost({ name: 'ctx-first', pm });
  const agent = fakeAgent({ id: 's-first', preset: 'zz-chat' });
  const d = await ctx.preStep(agent, [userMessage('第一次来', { id: 'u1' })]);
  assert.ok(d.messages.some((m) => m.source?.kind === 'persona-memory'), '回想之后再问一次生效档');
  assert.equal(pm.named('injected')[0].args[0].mode, 'live');
  // 记忆关着的场合不因为这一条变成插块
  pm.modes['set-zz-1'] = 'off';
  pm.recall = recall0;
  const d2 = await ctx.preStep(agent, [userMessage('再来一句', { id: 'u2' })], { turn: 2 });
  assert.equal(d2.messages.some((m) => m.source?.kind === 'persona-memory'), false);
  await cleanup();
});

test('压缩失败（compaction/end 带 error）：不交给核心、不换常驻区；对不上 start 的 end 也不算；成对的成功压缩照常（§10.5）', async () => {
  const { ctx, pm, host, cleanup } = await makeHost({ name: 'ctx-compact-fail' });
  const agent = fakeAgent({ id: 's-cf', preset: 'zz-chat' });
  await ctx.preStep(agent, [userMessage('早')]);
  const t1 = ctx.resolveContexts(agent)[0].text;
  ctx.sessionEvent(agent.session, { type: 'compaction/start', seq: 5, data: { compactionId: 'c1', turn: 1 } });
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 6, data: { compactionId: 'c1', turn: 1, error: 'LlmError: summary request failed' } });
  assert.deepEqual(pm.named('compaction').map((c) => c.args[1]), ['start'], '失败的压缩不开新周期');
  assert.equal(ctx.resolveContexts(agent)[0].text, t1, '上下文没变：常驻区不换');
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 7, data: { compactionId: 'c-x', turn: 1 } });
  assert.deepEqual(pm.named('compaction').map((c) => c.args[1]), ['start'], '对不上 start 的 end 不算');
  ctx.sessionEvent(agent.session, { type: 'compaction/start', seq: 8, data: { compactionId: 'c2', turn: 1 } });
  ctx.sessionEvent(agent.session, { type: 'compaction/end', seq: 9, data: { compactionId: 'c2', turn: 1 } });
  assert.deepEqual(pm.named('compaction').map((c) => c.args[1]), ['start', 'start', 'end']);
  assert.notEqual(ctx.resolveContexts(agent)[0].text, t1, '成功的压缩之后换常驻区');
  const st = host.status().context;
  assert.equal(st.compactionFailed, 1);
  assert.equal(st.compactionUnpaired, 1);
  await cleanup();
});

test('账户花费：所有会话的用量都进「余额还能撑几天」（不只是她的会话），别的提供方的不算；她的会话另记基线', async () => {
  const { ctx, host, cleanup } = await makeHost({ name: 'ctx-acct' });
  const other = fakeAgent({ id: 'dev-1', preset: 'coding' });
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
  ctx.sessionEvent(other.session, { type: 'assistant/message', seq: 1, data: { usage, source: { kind: 'model', provider: 'deepseek-official' } } });
  ctx.sessionEvent(other.session, { type: 'assistant/message', seq: 2, data: { usage, source: { kind: 'model', provider: 'some-other-provider' } } });
  const b = host.status().budget.today;
  assert.ok(b.acctYuan > 0, '没认领的会话（主人写代码）也算进账户花费');
  assert.equal(b.mainYuan, 0, '她的会话的基线只算她的会话');
  const one = b.acctYuan;
  ctx.sessionEvent(other.session, { type: 'assistant/message', seq: 3, data: { usage } });
  const two = host.status().budget.today.acctYuan;
  assert.ok(Math.abs(two - 2 * one) < 1e-6, '不知道提供方的也算（宁可多估）；别的提供方的那条没算进去');
  await cleanup();
});

// ── D115：唤醒消息里带着的旧上下文不能触发这一轮 ──

/** 一条唤醒消息翻译成几条感知（像 QQ 桥接的快照那样新旧混着）；newObsIds 可选（分不分得出新旧）。 */
function batchBinding(make, extra = {}) {
  return fakeBinding({
    fromSessionEvent: (ev, setting, sessionId) => (ev.type === 'user/message' && ev.data?.source?.kind === 'user'
      ? make().map((o) => ({ settingId: setting, visibleTo: 'setting-audience', perceivedAt: o.at ?? Date.now(), kind: 'utterance', text: o.id,
        attention: 'attended', evidential: true, standing: 'first-hand', sessionRef: { sessionId }, ...o })) : []),
    resolveFocus: () => null,
    extra,
  });
}
const OWNER = { claims: [{ kind: 'account', namespace: 'zz', id: 'owner', verifiedBy: 'config' }, { kind: 'principal', strength: 'config' }] };
const PAL = { claims: [{ kind: 'account', namespace: 'zz', id: 'pal', verifiedBy: 'platform' }] };
const ME = { self: true, claims: [] };

test('兜底（适配器分不出新旧）：早于她在这批里最后一次开口的、早于这一轮开始前 seenFreshMs 的对她说的话，都不能触发这一轮', async () => {
  const now = Date.now();
  let batch = [];
  const { ctx, pm, host, cleanup } = await makeHost({ name: 'ctx-d115-fallback', bindings: [batchBinding(() => batch)] });
  const agent = fakeAgent({ id: 's-fb', preset: 'zz-chat' });
  const turn = (n) => ctx.sessionEvent(agent.session, { type: 'turn/end', seq: n, data: { turn: n, reason: { kind: 'completed' } } });
  // ① 主人两个小时前的一句，她之后回过：这一轮没有新来的 → 她自己开启的
  batch = [{ id: 'o-old', at: now - 2 * 3_600_000, actor: OWNER, addressed: 'to-her' }, { id: 'o-me', at: now - 2 * 3_600_000 + 60_000, actor: ME, addressed: 'by-her', kind: 'self-utterance' }];
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w1' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-fb').trigger, null);
  assert.equal(host.assembler.turnState('s-fb').selfTurn, true);
  assert.equal(pm.named('recall').at(-1).args[0].trigger, 'idle');
  assert.equal(pm.named('markTurnTaint').length, 0, '不清污点');
  turn(1);
  // ② 她没回过、但已经是半小时前（早于这一轮开始前 10 分钟）：也不算
  batch = [{ id: 'o-half', at: now - 30 * 60_000, actor: OWNER, addressed: 'to-her' }];
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w2' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-fb').trigger, null);
  turn(2);
  // ③ 新的群友 @她 + 旧的主人那句：触发的是群友（主人的旧话不清污点、不进 foci）
  batch = [{ id: 'o-old', at: now - 2 * 3_600_000, actor: OWNER, addressed: 'to-her' }, { id: 'o-me', at: now - 2 * 3_600_000 + 60_000, actor: ME, addressed: 'by-her', kind: 'self-utterance' },
    { id: 'o-pal', at: now - 2_000, actor: PAL, addressed: 'mentions-her' }];
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w3' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-fb').trigger.obsId, 'o-pal');
  assert.deepEqual(pm.named('recall').at(-1).args[0], { settingId: 'set-zz-1', sessionId: 's-fb', trigger: 'message', homeSettingId: 'set-zz-1', focusObsId: 'o-pal' });
  assert.equal(pm.named('markTurnTaint').length, 0);
  turn(3);
  // ④ 不知道时间的照旧算（看不出旧，不改原来的行为）
  batch = [{ id: 'o-notime', at: undefined, perceivedAt: undefined, actor: OWNER, addressed: 'to-her' }];
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w4' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-fb').trigger.obsId, 'o-notime');
  assert.equal(pm.named('markTurnTaint').length, 1, '主人这一条开启的一轮照常清');
  await cleanup();
});

test('适配器分得出新旧（newObsIds）：只认它说是新的；给 [] = 她自己开启的一轮；给 null = 退回兜底', async () => {
  const now = Date.now();
  let marks = null;
  const batch = () => [{ id: 'o-ctx', at: now - 60_000, actor: OWNER, addressed: 'to-her' }, { id: 'o-new', at: now - 5 * 3_600_000, actor: PAL, addressed: 'mentions-her' }];
  const { ctx, pm, host, cleanup } = await makeHost({ name: 'ctx-d115-marked', bindings: [batchBinding(batch, { newObsIds: () => marks })] });
  const agent = fakeAgent({ id: 's-mk', preset: 'zz-chat' });
  marks = ['o-new'];
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w1' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-mk').trigger.obsId, 'o-new', '五个小时前的未读也是新来的；一分钟前的主人那句是上下文');
  assert.equal(pm.named('markTurnTaint').length, 0);
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } });
  marks = [];
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w2' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-mk').trigger, null);
  assert.equal(pm.named('recall').at(-1).args[0].trigger, 'idle');
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 2, data: { turn: 2, reason: { kind: 'completed' } } });
  marks = null;
  await ctx.preStep(agent, [userMessage('唤醒', { id: 'w3' })], { step: 1 });
  assert.equal(host.assembler.turnState('s-mk').trigger.obsId, 'o-ctx', '分不出时按兜底：一分钟前的还算');
  await cleanup();
});
