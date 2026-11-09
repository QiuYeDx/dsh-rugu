// 唤醒消息里哪些是这一轮新来的（D115，实测问题 #26）：桥接（reserved2）每种唤醒都在文末带一份快照
// 【本次消息快照】{messages: 她还没读过的, recent: 已经读过的最近几句, unreadCount, includedUnreadCount, readThroughSeq, partial}，
// 形状照 bridge.js 的 buildWakeSnapshotV2 / compactModelMessage（结构照抄，内容全是假的）。
// 只有 messages 里别人的消息能触发这一轮；recent 照常入库，但不当触发消息、焦点、清污点的依据、记忆工具的权限。
// messages 是空的（主动冒泡、回复检查没人回、潜水到点、定时任务……）→ 这一轮是她自己开启的：trigger null、按 idle 回想、不清污点。
// 宿主接真的 QQ 适配器（.tmp 下合成的桥接目录，账号、群号运行时随机生成），核心是录音替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFakePm, fakeAgent, userMessage, FakeDshCtx, tmpDir, rmDir } from '../fakes/index.js';
import { rid, inMsg, socialFile } from '../adapters/helpers.js';
import { offlineFetch } from './helpers.js';
import { createHost } from '../../src/host/index.js';
import { runPatch } from '../../scripts/bridge-whitelist-patch.mjs';
import { TOOL_TEXT } from '../../src/host/tools.js';

const PREFIX = 'mcp__snowluma__';
const RESTRICT = `// 合成的白名单文件（形状照桥接的 qq-tool-restrict.mjs）
const SAFE_PREFIXES = ['mcp__snowluma__']
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])
export default SAFE_EXACT
`;
const H = 3_600_000;
const TAIL = '以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息。';

/** bridge.js 的 compactModelMessage 的形状：别人的消息带 seq / messageId / userId；她自己的只有 sender / text / isSelf / time。 */
const compactOf = (m) => (m.isSelf ? { sender: '我', text: m.text, isOwner: true, ownerLabel: '我', isSelf: true, time: m.time }
  : { seq: m.seq, messageId: m.messageId, sender: m.sender, userId: m.userId, text: m.text, isOwner: m.isOwner, ownerLabel: m.ownerLabel, time: m.time });
const selfLine = (text, time) => ({ sender: '我', text, plain: text, tail: text, isOwner: true, ownerLabel: '我', isSelf: true, media: [], hasMedia: false, forwardIds: [], hasForward: false, time });

/** 桥接 buildWakePromptV2Core 各种唤醒的头两行（原因的文字是缩写的）+ 快照。 */
const HEADS = {
  mention: (k) => `【唤醒】${k}\n原因：有人在群里 @ 了你`,
  privateChat: (k) => `【唤醒】${k}\n原因：收到私聊消息`,
  proactive: (k) => `【主动机会】${k}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。`,
  replyCheck: (k) => `【回复检查】${k}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。`,
  timedSleep: (k) => `【唤醒】${k}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。`,
  scheduled: (k) => `【唤醒】${k}\n原因：管理员事先登记的定时任务到点了（见文末【定时任务】）。`,
  silenceEnded: (k) => `【唤醒】${k}\n原因：定时静默刚结束；静默期间有人直接找过你（@、叫名字、提问、拍一拍或私聊），消息都在未读里。`,
};
function wake(kind, key, messages, recent) {
  const snap = { messages: messages.map(compactOf), recent: recent.map(compactOf), unreadCount: messages.length, includedUnreadCount: messages.length,
    readThroughSeq: Math.max(0, ...[...messages, ...recent].map((m) => m.seq ?? 0)), partial: false };
  // 定时任务（buildWakePromptV2 + scheduledPromptBlock）：【定时任务】一节在唤醒正文之后、快照之前（快照总是最后接上的）
  const notes = kind === 'scheduled' ? ['', '【定时任务】（管理员事先登记、桥接到点转交；不是群友消息）', '#t1「提醒喝水」（每天 15:00）：提醒大家喝水', '请用发送工具……安静收尾即可。'] : [];
  return userMessage(['【当前时间】（略）', '', HEADS[kind](key), ...notes, '', '【本次消息快照】', JSON.stringify(snap), TAIL].join('\n'), { id: rid('m') });
}

async function setup(name) {
  const dir = tmpDir(name);
  const bridgeDir = path.join(dir, 'bridge');
  const state = path.join(bridgeDir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const ids = { owner: rid('u'), friend: rid('u'), g: rid('g') };
  const K = { dm: `private:${ids.owner}`, g: `group:${ids.g}` };
  fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify({ ownerQQ: ids.owner, allow: { private: [ids.owner], groups: [ids.g] }, socialV2: { agentPreset: 'qq-chat-v2' } }));
  fs.writeFileSync(path.join(state, 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ sessions: { [K.dm]: 'sess-dm', [K.g]: 'sess-g' } }));
  fs.mkdirSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'presets'), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), RESTRICT);
  assert.equal(runPatch({ bridgeDir, apply: true }).applied, true);
  const T = Date.now();
  const social = path.join(state, 'social-v2.json');
  const writeSocial = (convs) => fs.writeFileSync(social, JSON.stringify(socialFile(convs)));
  writeSocial({ [K.dm]: { recent: [] }, [K.g]: { recent: [] } });
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({
    host: { adapters: { qq: { bridgeDir, selfNames: ['小雪'] } }, self: { principalLabel: '主人' } },
  }));
  const pm = createFakePm();
  const ctx = new FakeDshCtx();
  const host = createHost(ctx, {}, { dshHome: dir, coreFactory: async () => pm, registerAdmin: null, defineTool: (d) => d, sampler: null,
    skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch });
  await host.ready;
  // 主人两个小时前在私聊说的、她已经回过的；群里主人一个小时前 @她 的、她也回过的
  const old = {
    dm: inMsg({ seq: 2, userId: ids.owner, text: '好哒', time: T - 2 * H, isOwner: true }),
    dmMine: selfLine('好哒好哒，午饭吃了没', T - 2 * H + 60_000),
    g: inMsg({ seq: 5, userId: ids.owner, sender: '老周', text: '@小雪 晚上开黑吗', time: T - H, isOwner: true }),
    gMine: selfLine('来呀来呀', T - H + 30_000),
  };
  const agents = { dm: fakeAgent({ id: 'sess-dm', preset: 'qq-chat-v2' }), g: fakeAgent({ id: 'sess-g', preset: 'qq-chat-v2' }) };
  await ctx.agentCreated(agents.dm);
  await ctx.agentCreated(agents.g);
  const lastRecall = () => pm.named('recall').at(-1)?.args[0];
  const lastObserve = () => pm.named('observe').at(-1)?.args[0] ?? [];
  const taintClears = () => pm.named('markTurnTaint').filter((c) => c.args[1]?.tainted === false).length;
  const tool = (agent, n) => agent.ctx.tools.registered.find((d) => d.name === n);
  const endTurn = (agent) => ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 99, data: { turn: 1, reason: { kind: 'completed' } } });
  return { dir, ids, K, T, ctx, pm, host, old, agents, writeSocial, lastRecall, lastObserve, taintClears, tool, endTurn,
    cleanup: async () => { await host.dispose(); rmDir(dir); } };
}

test('【主动机会】快照只有旧的上下文（现场 11-06 14:26 的形状）：旧话照常入库，但这一轮没有触发消息——idle 回想、不清污点、记忆工具没有权限', async () => {
  const w = await setup('wake-proactive');
  try {
    const d = await w.ctx.preStep(w.agents.dm, [wake('proactive', w.K.dm, [], [w.old.dm, w.old.dmMine])]);
    assert.equal(w.host.claims.get('sess-dm')?.adapterId, 'qq');
    const obs = w.lastObserve();
    const oldObs = obs.find((o) => o.text === '好哒');
    assert.ok(oldObs, '快照里的旧上下文照常入库（去重照旧由核心按 ObsId 做）');
    assert.equal(oldObs.addressed, 'to-her');
    const st = w.host.assembler.turnState('sess-dm');
    assert.equal(st.trigger, null, '两个小时前的「好哒」不是这一轮的触发消息');
    assert.equal(st.selfTurn, true);
    assert.deepEqual(st.seen, []);
    const sit = w.lastRecall();
    assert.equal(sit.trigger, 'idle', '她自己开启的一轮按空闲唤醒回想（核心不把主人当「眼前这个人」）');
    assert.equal(sit.focusObsId, undefined);
    assert.equal(sit.focusObsIds, undefined);
    assert.equal(w.taintClears(), 0, '主人的旧话不算主人开启了这一轮：不清污点');
    assert.ok(d.messages.some((m) => m.source?.kind === 'persona-memory'), '回想照常（焦点是这里最近的对话）');
    assert.equal(await w.tool(w.agents.dm, 'memory_note').execute({ text: '主人说好', evidence_quote: '好哒' }, { agent: w.agents.dm, callId: 'n1' }), TOOL_TEXT.noTrigger);
    assert.equal(w.pm.named('note').length, 0, '旧话不给记忆工具权限');
    // 有意回想也按 idle
    await w.tool(w.agents.dm, 'memory_recall').execute({ query: '上次聊到哪了' }, { agent: w.agents.dm, callId: 'r1' });
    assert.equal(w.lastRecall().trigger, 'idle');
    assert.equal(w.lastRecall().focusObsId, undefined);

    // 之后她用 qq_wait_for_messages 读到主人的新消息（D114 noteSeen）：从「没有触发消息」换成这一条
    const fresh = inMsg({ seq: 3, userId: w.ids.owner, text: '你记得我昨天说的那家店吗', time: Date.now() - 5_000, isOwner: true });
    w.writeSocial({ [w.K.dm]: { recent: [w.old.dm, w.old.dmMine, fresh] }, [w.K.g]: { recent: [] } });
    const call = { name: `${PREFIX}qq_wait_for_messages`, callId: 'w1', agent: w.agents.dm, arguments: { key: w.K.dm, timeoutMs: 300_000 } };
    await w.ctx.preExecute(call);
    await w.ctx.postExecute(call, { content: [{ type: 'text', text: JSON.stringify({ ok: true, key: w.K.dm, purpose: 'messages', arrived: true, newMessages: [compactOf(fresh)], readThroughSeq: 3, unreadCount: 1 }) }], isError: false });
    const freshObs = w.lastObserve().find((o) => o.text === fresh.text);
    assert.ok(freshObs);
    const st2 = w.host.assembler.turnState('sess-dm');
    assert.equal(st2.trigger?.obsId, freshObs.id, '读到的新消息成了触发消息');
    assert.deepEqual(st2.seen.map((x) => x.obsId), [freshObs.id], '旧的「好哒」不在她这一轮看到的里面');
    assert.equal(await w.tool(w.agents.dm, 'memory_note').execute({ text: '那家店', evidence_quote: '那家店' }, { agent: w.agents.dm, callId: 'n2' }), '记下了。');
    assert.equal(w.pm.named('note').at(-1).args[0].triggerObsId, freshObs.id);
    assert.equal(w.pm.named('note').at(-1).args[0].triggerObsIds, undefined);
    await w.tool(w.agents.dm, 'memory_recall').execute({ query: '那家店' }, { agent: w.agents.dm, callId: 'r2' });
    assert.equal(w.lastRecall().trigger, 'message');
    assert.equal(w.lastRecall().focusObsId, freshObs.id);
    // 回合结束：下一轮重新算
    w.endTurn(w.agents.dm);
    assert.equal(w.host.assembler.turnState('sess-dm').selfTurn, false);
  } finally { await w.cleanup(); }
});

test('【唤醒】@她（快照 messages 里有新消息）：照旧——触发消息是新来的那条，不是 recent 里主人一个小时前 @她 的那句', async () => {
  const w = await setup('wake-mention');
  try {
    const now = Date.now();
    const ask = inMsg({ seq: 7, userId: w.ids.friend, sender: '阿明', text: '@小雪 你今天去哪玩了', time: now - 2_000 });
    await w.ctx.preStep(w.agents.g, [wake('mention', w.K.g, [ask], [w.old.g, w.old.gMine])]);
    const obs = w.lastObserve();
    const askObs = obs.find((o) => o.text === ask.text);
    assert.ok(obs.find((o) => o.text === w.old.g.text), 'recent 照常入库');
    const st = w.host.assembler.turnState('sess-g');
    assert.equal(st.trigger?.obsId, askObs.id);
    assert.equal(st.selfTurn, false);
    assert.deepEqual(st.seen.map((x) => x.obsId), [askObs.id]);
    assert.equal(w.lastRecall().trigger, 'message');
    assert.equal(w.lastRecall().focusObsId, askObs.id);
    assert.equal(w.taintClears(), 0, '群友开启的一轮不清污点');
    // recent 里主人那句比她最后开口还早——就算 recent 里还有一句没回的主人的话，它也不进触发者
    w.endTurn(w.agents.g);
    const unanswered = inMsg({ seq: 6, userId: w.ids.owner, sender: '老周', text: '@小雪 记得帮我占位', time: now - 30_000, isOwner: true });
    const ask2 = inMsg({ seq: 8, userId: w.ids.friend, sender: '阿明', text: '@小雪 走不走', time: now - 1_000 });
    await w.ctx.preStep(w.agents.g, [wake('mention', w.K.g, [ask2], [w.old.g, w.old.gMine, unanswered])]);
    const ask2Obs = w.lastObserve().find((o) => o.text === ask2.text);
    assert.equal(w.host.assembler.turnState('sess-g').trigger?.obsId, ask2Obs.id);
    assert.deepEqual(w.lastRecall().focusObsIds, undefined, '旧上下文里的主人不算这一批里也在对她说话的人');
    assert.equal(w.taintClears(), 0, 'recent 里主人的话不清污点');
  } finally { await w.cleanup(); }
});

test('私聊唤醒（主人的新消息在 messages 里）：照旧——触发消息是主人这条，按主人开启的一轮清污点', async () => {
  const w = await setup('wake-private');
  try {
    const msg = inMsg({ seq: 3, userId: w.ids.owner, text: '在吗，问你个事', time: Date.now() - 1_000, isOwner: true });
    await w.ctx.preStep(w.agents.dm, [wake('privateChat', w.K.dm, [msg], [w.old.dm, w.old.dmMine])]);
    const o = w.lastObserve().find((x) => x.text === msg.text);
    const st = w.host.assembler.turnState('sess-dm');
    assert.equal(st.trigger?.obsId, o.id);
    assert.ok(st.trigger.actor?.claims?.some((c) => c.kind === 'principal'));
    assert.equal(w.lastRecall().trigger, 'message');
    assert.equal(w.lastRecall().focusObsId, o.id);
    assert.equal(w.taintClears(), 1);
  } finally { await w.cleanup(); }
});

test('定时静默结束（未读里是几个小时前直接找她的话）：未读就是她还没看到的，再旧也算新来的', async () => {
  const w = await setup('wake-silence');
  try {
    const msg = inMsg({ seq: 3, userId: w.ids.owner, text: '醒了跟我说一声', time: Date.now() - 5 * H, isOwner: true });
    await w.ctx.preStep(w.agents.dm, [wake('silenceEnded', w.K.dm, [msg], [w.old.dm, w.old.dmMine])]);
    const o = w.lastObserve().find((x) => x.text === msg.text);
    assert.equal(w.host.assembler.turnState('sess-dm').trigger?.obsId, o.id, '适配器分得出新旧时不按时间兜底');
    assert.equal(w.lastRecall().trigger, 'message');
  } finally { await w.cleanup(); }
});

for (const kind of ['replyCheck', 'timedSleep', 'scheduled']) {
  test(`${kind} 唤醒、快照 messages 是空的：她自己开启的一轮（trigger null、idle、不清污点）`, async () => {
    const w = await setup(`wake-${kind}`);
    try {
      await w.ctx.preStep(w.agents.g, [wake(kind, w.K.g, [], [w.old.g, w.old.gMine])]);
      const st = w.host.assembler.turnState('sess-g');
      assert.equal(st.trigger, null);
      assert.equal(st.selfTurn, true);
      assert.equal(w.lastRecall().trigger, 'idle');
      assert.equal(w.taintClears(), 0);
      assert.ok(w.lastObserve().some((o) => o.text === w.old.g.text), '旧上下文照常入库');
    } finally { await w.cleanup(); }
  });
}

test('回复检查、有人回了（messages 里有新消息）：触发消息是回她的那条', async () => {
  const w = await setup('wake-replycheck-new');
  try {
    const reply = inMsg({ seq: 6, userId: w.ids.friend, sender: '阿明', text: '@小雪 好啊几点', time: Date.now() - 3_000 });
    await w.ctx.preStep(w.agents.g, [wake('replyCheck', w.K.g, [reply], [w.old.g, w.old.gMine])]);
    const o = w.lastObserve().find((x) => x.text === reply.text);
    assert.equal(w.host.assembler.turnState('sess-g').trigger?.obsId, o.id);
    assert.equal(w.lastRecall().trigger, 'message');
  } finally { await w.cleanup(); }
});

test('QQ 绑定的 newObsIds：只数快照 messages 里别人的消息；不是唤醒消息、没有快照 → null（分不出）', async () => {
  const w = await setup('wake-newobsids');
  try {
    await w.ctx.preStep(w.agents.dm, [wake('proactive', w.K.dm, [], [w.old.dm])]);
    const b = w.host.claims.get('sess-dm').binding;
    const msg = inMsg({ seq: 3, userId: w.ids.owner, text: '在吗', time: Date.now(), isOwner: true });
    const ids = b.newObsIds(wake('privateChat', w.K.dm, [msg, w.old.dmMine], [w.old.dm]));
    assert.equal(ids.length, 1, '她自己的话不算新来的');
    assert.deepEqual(b.newObsIds(wake('proactive', w.K.dm, [], [w.old.dm, w.old.dmMine])), []);
    assert.equal(b.newObsIds(userMessage('普通的一句话')), null);
    assert.equal(b.newObsIds(userMessage(`【唤醒】${w.K.dm}\n原因：没有快照`)), null);
    assert.equal(b.newObsIds({ type: 'user/message', data: wake('proactive', w.K.dm, [], [w.old.dm]) }).length, 0, '会话事件的形状也认');
  } finally { await w.cleanup(); }
});

test('轮中又来一条没有新消息的唤醒（第 2 步以后）：这一轮已经读到的触发消息留着，不当成她重新开启的', async () => {
  const w = await setup('wake-midturn');
  try {
    await w.ctx.preStep(w.agents.dm, [wake('proactive', w.K.dm, [], [w.old.dm, w.old.dmMine])], { step: 1 });
    const fresh = inMsg({ seq: 3, userId: w.ids.owner, text: '帮我记一下明天交房租', time: Date.now() - 2_000, isOwner: true });
    w.writeSocial({ [w.K.dm]: { recent: [w.old.dm, w.old.dmMine, fresh] }, [w.K.g]: { recent: [] } });
    const call = { name: `${PREFIX}qq_wait_for_messages`, callId: 'w1', agent: w.agents.dm, arguments: { key: w.K.dm, timeoutMs: 300_000 } };
    await w.ctx.preExecute(call);
    await w.ctx.postExecute(call, { content: [{ type: 'text', text: JSON.stringify({ ok: true, key: w.K.dm, arrived: true, newMessages: [compactOf(fresh)], readThroughSeq: 3 }) }], isError: false });
    const id = w.host.assembler.turnState('sess-dm').trigger?.obsId;
    assert.ok(id);
    await w.ctx.preStep(w.agents.dm, [wake('replyCheck', w.K.dm, [], [w.old.dm, w.old.dmMine, fresh])], { step: 3 });
    assert.equal(w.host.assembler.turnState('sess-dm').trigger?.obsId, id);
    assert.equal(w.lastRecall().trigger, 'message');
    assert.equal(w.lastRecall().focusObsId, id);
  } finally { await w.cleanup(); }
});
