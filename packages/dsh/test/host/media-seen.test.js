// 她看过的媒体（D116，主人：「按简单的做」）——宿主这一半：认出她用工具看了一条消息里的媒体（结果带图片，或者配置里声明的看媒体工具），
// 认出是哪一条（QQ 适配器的 resolveViewedMedia；对不上就什么都不做），等她看完之后的想法和回话，交给核心一次（pm.media.noteViewed）。
// 宿主接真的 QQ 适配器（.tmp 下合成的桥接目录，账号、群号运行时随机生成），核心是录音替身；看媒体的工具是假的名字。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFakePm, fakeAgent, userMessage, FakeDshCtx, tmpDir, rmDir } from '../fakes/index.js';
import { rid, inMsg, socialFile } from '../adapters/helpers.js';
import { offlineFetch } from './helpers.js';
import { createHost } from '../../src/host/index.js';
import { runPatch } from '../../scripts/bridge-whitelist-patch.mjs';
import { hasImageContent, isDeclaredViewer, pickViewed } from '../../src/host/media.js';
import { uniqueViewed } from '../../src/binding/index.js';
import { placeholderMedia } from '../../src/adapters/qq/messages.js';

const PREFIX = 'mcp__snowluma__';
const RESTRICT = `// 合成的白名单文件（形状照桥接的 qq-tool-restrict.mjs）
const SAFE_PREFIXES = ['mcp__snowluma__']
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])
export default SAFE_EXACT
`;
const VIEWER = 'fake_watch_video';
const IMAGE = { type: 'image', attachment: { attachmentId: 'sha256:00', mediaType: 'image/png', width: 10, height: 10, bytes: 1, name: 'frames.png' } };
const compactOf = (m) => ({ seq: m.seq, messageId: m.messageId, sender: m.sender, userId: m.userId, text: m.text, isOwner: m.isOwner, ownerLabel: m.ownerLabel, time: m.time,
  ...(m.media?.length ? { media: m.media, hasMedia: true } : {}), ...(m.hasForward ? { hasForward: true, forwardIds: m.forwardIds } : {}) });

async function setup(name, { media = {} } = {}) {
  const dir = tmpDir(name);
  const bridgeDir = path.join(dir, 'bridge');
  const state = path.join(bridgeDir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const ids = { owner: rid('u'), g: rid('g'), g2: rid('g') };
  const K = { g: `group:${ids.g}`, g2: `group:${ids.g2}` };
  fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify({ ownerQQ: ids.owner, allow: { private: [ids.owner], groups: [ids.g, ids.g2] }, socialV2: { agentPreset: 'qq-chat-v2' } }));
  fs.writeFileSync(path.join(state, 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
  fs.writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ sessions: { [K.g]: 'sess-g', [K.g2]: 'sess-g2' } }));
  fs.mkdirSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'presets'), { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), RESTRICT);
  assert.equal(runPatch({ bridgeDir, apply: true }).applied, true);
  const social = path.join(state, 'social-v2.json');
  const writeSocial = (convs) => fs.writeFileSync(social, JSON.stringify(socialFile(convs)));
  writeSocial({ [K.g]: { recent: [] }, [K.g2]: { recent: [] } });
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({
    host: { adapters: { qq: { bridgeDir, selfNames: ['小雪'] } }, self: { principalLabel: '主人' }, media },
  }));
  const pm = createFakePm();
  const ctx = new FakeDshCtx();
  const host = createHost(ctx, {}, { dshHome: dir, coreFactory: async () => pm, registerAdmin: null, defineTool: (d) => d, sampler: null,
    skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch });
  await host.ready;
  const agents = { g: fakeAgent({ id: 'sess-g', preset: 'qq-chat-v2' }), g2: fakeAgent({ id: 'sess-g2', preset: 'qq-chat-v2' }) };
  await ctx.agentCreated(agents.g);
  await ctx.agentCreated(agents.g2);
  let seq = 0;
  let callN = 0;
  /** 她用 qq_wait_for_messages 读到这几条（形状照桥接的工具结果）。 */
  const read = async (agent, key, msgs) => {
    const call = { name: `${PREFIX}qq_wait_for_messages`, callId: `w${++callN}`, agent, arguments: { key, timeoutMs: 180_000 } };
    await ctx.postExecute(call, { content: [{ type: 'text', text: JSON.stringify({ ok: true, key, purpose: 'messages', arrived: true, newMessages: msgs.map(compactOf), readThroughSeq: msgs.at(-1)?.seq ?? 0, unreadCount: 0 }) }], isError: false });
    return pm.named('observe').at(-1)?.args[0] ?? [];
  };
  /** 她调了一个工具（结果 content 原样）。 */
  const callTool = (agent, name, args, content) => ctx.postExecute({ name, callId: `t${++callN}`, agent, arguments: args }, { content, isError: false });
  /** 她这一步的 assistant/message（想法 + 说话的工具调用）。 */
  const step = (agent, { reasoning = '', text = '', send = null, key = K.g }) => {
    const content = [{ type: 'reasoning', text: reasoning }];
    if (text) content.push({ type: 'text', text });
    if (send) content.push({ type: 'tool-call', id: `c${++callN}`, name: `${PREFIX}qq_send_message`, arguments: JSON.stringify({ key, messages: send, token: 'x' }) });
    ctx.sessionEvent(agent.session, { type: 'assistant/message', seq: ++seq, data: { turn: 1, step: seq, message: { role: 'assistant', content } } });
  };
  const wakeUp = (agent, key) => ctx.preStep(agent, [userMessage(`【唤醒】${key}\n原因：收到消息`, { id: rid('m') })]);
  const endTurn = (agent) => ctx.sessionEvent(agent.session, { type: 'turn/end', seq: ++seq, data: { turn: 1, reason: { kind: 'completed' } } });
  const settle = () => new Promise((r) => setImmediate(r));
  return { dir, ids, K, ctx, pm, host, agents, writeSocial, read, callTool, step, wakeUp, endTurn, settle, cleanup: async () => { await host.dispose(); rmDir(dir); } };
}

const msgs = (w, T) => ({
  video: inMsg({ seq: 34, userId: w.ids.owner, sender: '老周', text: '[视频]', time: T - 20_000, isOwner: true }),
  pup: inMsg({ seq: 35, userId: w.ids.owner, sender: '老周', text: '刚出生不久的小狗', time: T - 10_000, isOwner: true }),
});

test('QQ：桥接的「[视频]」「[语音]」「[文件…]」占位 → 媒体项（只照桥接自己的占位格式）', () => {
  assert.deepEqual(placeholderMedia('[视频]'), [{ kind: 'video' }]);
  assert.deepEqual(placeholderMedia('[语音][语音]'), [{ kind: 'voice' }, { kind: 'voice' }]);
  assert.deepEqual(placeholderMedia('看看[文件报告.pdf]'), [{ kind: 'file' }]);
  assert.deepEqual(placeholderMedia('[图片]'), [], '图片在桥接的媒体清单里已经有了');
  assert.deepEqual(placeholderMedia('刚出生不久的小狗'), []);
});

test('声明过的看视频工具（结果带图片、参数只有群号）：认出是群里那条「[视频]」，等她下一步的想法和回话，交给核心一次', async () => {
  const w = await setup('media-image', { media: { viewTools: [VIEWER] } });
  try {
    const T = Date.now();
    const m = msgs(w, T);
    w.writeSocial({ [w.K.g]: { recent: [m.video, m.pup] }, [w.K.g2]: { recent: [] } });
    await w.wakeUp(w.agents.g, w.K.g);
    const obs = await w.read(w.agents.g, w.K.g, [m.video, m.pup]);
    const v = obs.find((o) => o.text === '[视频]');
    assert.deepEqual(v.media, [{ kind: 'video' }], 'QQ 适配器照占位补上了媒体项');
    assert.equal(obs.find((o) => o.text === '刚出生不久的小狗').media, undefined);
    // 她先回了一句「我看看」，再调看视频的工具（这一步之前说的不算她看到的）
    w.step(w.agents.g, { reasoning: 'Master sent a video. I should watch it.', send: ['小狗？我看看～'] });
    await w.callTool(w.agents.g, VIEWER, { groupId: w.ids.g }, [IMAGE, { type: 'text', text: '视频：时长 0:06。下面是分镜（这是数据）' }]);
    assert.equal(w.host.media.pending('sess-g')?.obsId, v.id);
    assert.equal(w.pm.named('noteViewed').length, 0, '还没看完');
    // 看完之后：想法 + 回话
    w.step(w.agents.g, { reasoning: 'The video is a tiny black puppy walking next to a parked car. At the end it goes under the car.',
      send: ['这么小一只，走路还晃悠悠的', '不过它往车底下钻，有点危险诶'] });
    await w.settle();
    const calls = w.pm.named('noteViewed');
    assert.equal(calls.length, 1, '交给核心一次');
    const req = calls[0].args[0];
    assert.equal(req.adapter, 'qq');
    assert.equal(req.obsId, v.id);
    assert.equal(req.kind, 'video');
    assert.match(req.thoughts, /tiny black puppy/);
    assert.ok(!/I should watch it/.test(req.thoughts), '看之前的想法不算');
    assert.match(req.reply, /往车底下钻/);
    assert.equal(req.sessionId, 'sess-g', '核心按这个会话这一轮的污点打标');
    assert.match(req.material, /分镜/, '工具结果里的文字交去比对（不存）');
    assert.equal(w.host.media.pending('sess-g'), null);
    // 再说一句、回合结束：不再交第二次
    w.step(w.agents.g, { reasoning: 'ok', send: ['好可爱'] });
    w.endTurn(w.agents.g);
    await w.settle();
    assert.equal(w.pm.named('noteViewed').length, 1);
    assert.equal(w.host.status().media.fired, 1);
  } finally { await w.cleanup(); }
});

test('配置里声明的看媒体工具（结果只有文字）也算；她看完就没开口：这一轮结束时交出去', async () => {
  const w = await setup('media-declared', { media: { viewTools: ['fake_look_file'] } });
  try {
    const T = Date.now();
    const file = inMsg({ seq: 40, userId: w.ids.owner, sender: '老周', text: '[文件周报.pdf]', time: T - 5_000, isOwner: true });
    w.writeSocial({ [w.K.g]: { recent: [file] }, [w.K.g2]: { recent: [] } });
    await w.wakeUp(w.agents.g, w.K.g);
    const [o] = await w.read(w.agents.g, w.K.g, [file]);
    assert.deepEqual(o.media, [{ kind: 'file' }]);
    await w.callTool(w.agents.g, `mcp__x__fake_look_file`, {}, [{ type: 'text', text: '文件内容：……' }]);
    assert.equal(w.host.media.pending('sess-g')?.obsId, o.id);
    w.step(w.agents.g, { reasoning: '这是一份周报，列了三件做完的事' });
    assert.equal(w.pm.named('noteViewed').length, 0, '只有想法没有回话：等到 maxSteps 或回合结束');
    w.endTurn(w.agents.g);
    await w.settle();
    assert.equal(w.pm.named('noteViewed').length, 1);
    assert.equal(w.pm.named('noteViewed')[0].args[0].obsId, o.id);
    assert.equal(w.pm.named('noteViewed')[0].args[0].kind, 'file');
  } finally { await w.cleanup(); }
});

test('认不出是哪一条就什么都不做：没看到带媒体的消息、参数点的是另一个群、没图片也没声明的工具、没有她写的字', async () => {
  const w = await setup('media-none', { media: { viewTools: [VIEWER] } });
  try {
    const T = Date.now();
    const m = msgs(w, T);
    w.writeSocial({ [w.K.g]: { recent: [m.pup] }, [w.K.g2]: { recent: [m.video] } });
    await w.wakeUp(w.agents.g, w.K.g);
    await w.read(w.agents.g, w.K.g, [m.pup]);
    // 1. 这一轮没看到带媒体的消息
    await w.callTool(w.agents.g, VIEWER, { groupId: w.ids.g }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null);
    // 2. 别的群里有视频（另一个会话看到的），这个会话的工具参数点的是那个群：不跨会话猜
    await w.wakeUp(w.agents.g2, w.K.g2);
    await w.read(w.agents.g2, w.K.g2, [m.video]);
    await w.callTool(w.agents.g, VIEWER, { groupId: w.ids.g2 }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null, '另一个群的视频不是这个会话看到的');
    // 3. 没图片、没声明的工具
    await w.callTool(w.agents.g2, 'fake_weather', {}, [{ type: 'text', text: '晴' }]);
    assert.equal(w.host.media.pending('sess-g2'), null);
    // 4. 记忆工具不算
    await w.callTool(w.agents.g2, 'memory_recall', {}, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g2'), null);
    // 5. 认出来了，但她之后一个字都没写（想法是空的、没说话）：丢掉
    await w.callTool(w.agents.g2, VIEWER, {}, [IMAGE]);
    assert.ok(w.host.media.pending('sess-g2'));
    w.step(w.agents.g2, { reasoning: '' , key: w.K.g2 });
    w.step(w.agents.g2, { reasoning: '', key: w.K.g2 });
    await w.settle();
    assert.equal(w.pm.named('noteViewed').length, 0);
    assert.equal(w.host.media.pending('sess-g2'), null);
    assert.ok(w.host.status().media.unresolved >= 2);
    assert.equal(w.host.status().media.dropped, 1);
  } finally { await w.cleanup(); }
});

test('参数里给了消息 id：就是那一条（取消息图片的工具不用声明）；没给 id、两个视频分不清：不写；再看一次同一条照样交', async () => {
  const w = await setup('media-pick', { media: { viewTools: [VIEWER] } });
  try {
    const T = Date.now();
    const a = inMsg({ seq: 1, userId: w.ids.owner, sender: '老周', text: '[视频]', time: T - 60_000, isOwner: true });
    const b = inMsg({ seq: 2, userId: w.ids.owner, sender: '老周', text: '[视频]', time: T - 30_000, isOwner: true });
    const pic = inMsg({ seq: 3, userId: w.ids.owner, sender: '老周', text: '[图片]', time: T - 20_000, isOwner: true, media: [{ kind: 'image' }] });
    w.writeSocial({ [w.K.g]: { recent: [a, b, pic] }, [w.K.g2]: { recent: [] } });
    await w.wakeUp(w.agents.g, w.K.g);
    const obs = await w.read(w.agents.g, w.K.g, [a, b, pic]);
    const [oa, ob, op] = [obs.find((o) => o.at === a.time), obs.find((o) => o.at === b.time), obs.find((o) => o.at === pic.time)];
    // 1. 桥接取消息图片的工具：参数里有 key + messageId，没声明也认
    await w.callTool(w.agents.g, `${PREFIX}qq_get_message_images`, { key: w.K.g, messageId: pic.messageId, token: 'x' }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g')?.obsId, op.id, '消息 id 点明了那张图');
    w.step(w.agents.g, { reasoning: 'a cat on a sofa', send: ['猫猫'] });
    // 2. 声明的工具 + 消息 id：较早的那个视频
    await w.callTool(w.agents.g, VIEWER, { key: w.K.g, messageId: a.messageId }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g')?.obsId, oa.id);
    w.step(w.agents.g, { reasoning: 'a dog', send: ['狗狗'] });
    await w.settle();
    assert.deepEqual(w.pm.named('noteViewed').map((c) => c.args[0].obsId), [op.id, oa.id]);
    // 3. 没给 id：两个视频（图片不算，视频优先）分不清 → 不写
    await w.callTool(w.agents.g, VIEWER, { key: w.K.g }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null, '两个视频分不清是哪一个');
    // 4. 同一条再看一次（给了 id）：照样交（核心那边更晚的一次替换更早的），不会挪到别的消息上
    await w.callTool(w.agents.g, VIEWER, { key: w.K.g, messageId: a.messageId }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g')?.obsId, oa.id);
    w.step(w.agents.g, { reasoning: 'the dog again', send: ['再看一遍'] });
    await w.settle();
    assert.deepEqual(w.pm.named('noteViewed').map((c) => c.args[0].obsId), [op.id, oa.id, oa.id]);
    void ob;
  } finally { await w.cleanup(); }
});

test('结果带图片、但看的不是别人分享的那条：收藏表情、头像、合并转发、网址 → 不写进别人的消息', async () => {
  const w = await setup('media-other');
  try {
    const T = Date.now();
    const pic = inMsg({ seq: 1, userId: w.ids.owner, sender: '老周', text: '[图片]', time: T - 20_000, isOwner: true, media: [{ kind: 'image' }] });
    const fwd = inMsg({ seq: 2, userId: w.ids.owner, sender: '老周', text: '[转发消息]', time: T - 10_000, isOwner: true, forwardIds: ['f1'] });
    w.writeSocial({ [w.K.g]: { recent: [pic, fwd] }, [w.K.g2]: { recent: [] } });
    await w.wakeUp(w.agents.g, w.K.g);
    await w.read(w.agents.g, w.K.g, [pic, fwd]);
    await w.callTool(w.agents.g, `${PREFIX}qq_get_sticker_image`, { key: w.K.g, token: 'x', stickerId: 's1' }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null, '她自己的收藏表情');
    await w.callTool(w.agents.g, `${PREFIX}qq_get_self_image`, { key: w.K.g, token: 'x' }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null, '她自己的头像');
    await w.callTool(w.agents.g, `${PREFIX}qq_get_forward_msg`, { key: w.K.g, token: 'x', id: 'f1' }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null, '合并转发的 id 不是消息 id');
    await w.callTool(w.agents.g, 'fake_page_look', { url: 'https://example.invalid/v' }, [IMAGE]);
    assert.equal(w.host.media.pending('sess-g'), null, '网页、视频网站的链接');
    w.step(w.agents.g, { reasoning: '这个收藏表情是一只橘猫捂着脸', send: ['嘿嘿'] });
    w.endTurn(w.agents.g);
    await w.settle();
    assert.equal(w.pm.named('noteViewed').length, 0);
    assert.ok(w.host.status().media.detected >= 4 && w.host.status().media.resolved === 0);
  } finally { await w.cleanup(); }
});

test('同一步里并排看了两条（两个不同的消息 id）：分不清她的想法说的是哪一条，两条都不写', async () => {
  const w = await setup('media-parallel');
  try {
    const T = Date.now();
    const p1 = inMsg({ seq: 1, userId: w.ids.owner, sender: '老周', text: '[图片]', time: T - 20_000, isOwner: true, media: [{ kind: 'image' }] });
    const p2 = inMsg({ seq: 2, userId: w.ids.owner, sender: '老周', text: '[图片]', time: T - 10_000, isOwner: true, media: [{ kind: 'image' }] });
    w.writeSocial({ [w.K.g]: { recent: [p1, p2] }, [w.K.g2]: { recent: [] } });
    await w.wakeUp(w.agents.g, w.K.g);
    await w.read(w.agents.g, w.K.g, [p1, p2]);
    await w.callTool(w.agents.g, `${PREFIX}qq_get_message_images`, { key: w.K.g, messageId: p1.messageId, token: 'x' }, [IMAGE]);
    await w.callTool(w.agents.g, `${PREFIX}qq_get_message_images`, { key: w.K.g, messageId: p2.messageId, token: 'x' }, [IMAGE]);
    w.step(w.agents.g, { reasoning: '第一张是猫，第二张是狗', send: ['都好可爱'] });
    await w.settle();
    assert.equal(w.pm.named('noteViewed').length, 0);
    assert.equal(w.host.status().media.ambiguous, 1);
    assert.equal(w.host.status().media.dropped, 1);
  } finally { await w.cleanup(); }
});

test('小工具：认图片内容块、声明的工具名、兜底只在这个场合里恰好一条才算', () => {
  assert.equal(hasImageContent([{ type: 'text', text: 'x' }, IMAGE]), true);
  assert.equal(hasImageContent([{ type: 'text', text: 'x' }]), false);
  assert.equal(hasImageContent(null), false);
  assert.equal(isDeclaredViewer('mcp__abc__look', ['look']), true);
  assert.equal(isDeclaredViewer('look', ['look']), true);
  assert.equal(isDeclaredViewer('looks', ['look']), false);
  assert.equal(isDeclaredViewer('look', []), false);
  const ring = [{ obsId: 'a', settingId: 'S', at: 1, seenAt: 100, kinds: ['image'] }, { obsId: 'b', settingId: 'S', at: 2, seenAt: 100, kinds: ['image'] },
    { obsId: 'c', settingId: 'X', at: 3, seenAt: 100, kinds: ['video'] }];
  assert.equal(pickViewed(ring, { settingId: 'S', floor: 0 }), null, '两张图分不清');
  assert.equal(pickViewed(ring, { settingId: 'X', floor: 0 }), 'c');
  assert.equal(pickViewed(ring, { settingId: 'X', floor: 200 }), null, '太早看到的不算这一轮');
  assert.equal(pickViewed(ring, { settingId: 'Y', floor: 0 }), null);
  // 视频优先；小黄脸、表情、合并转发不算要看的
  assert.equal(uniqueViewed([...ring, { obsId: 'v', settingId: 'S', kinds: ['video'] }], 'S'), 'v');
  assert.equal(uniqueViewed([{ obsId: 'p', settingId: 'S', kinds: ['image'] }, { obsId: 's', settingId: 'S', kinds: ['sticker'] }, { obsId: 'f', settingId: 'S', kinds: ['face', 'forward'] }], 'S'), 'p');
  assert.equal(uniqueViewed([{ obsId: 'v1', settingId: 'S', kinds: ['video'] }, { obsId: 'v2', settingId: 'S', kinds: ['voice'] }], 'S'), null);
});

test('补录脚本（D116）：从会话日志认出看过的那条、她之后的想法和回话；默认只预演', async () => {
  const { viewsIn } = await import('../../scripts/backfill-media-seen.mjs');
  const T = Date.UTC(2026, 10, 6, 1, 33);
  const SEND = 'mcp__snowluma__qq_send_message';
  const wait = { ok: true, key: 'group:100001', newMessages: [{ seq: 1, messageId: 'm1', sender: '老周', userId: 'u1', text: '[视频]', time: T }, { seq: 2, messageId: 'm2', sender: '老周', userId: 'u1', text: '刚出生不久的小狗', time: T + 9000 },
    { seq: 3, messageId: 'm3', sender: '老周', userId: 'u1', text: '[图片]', time: T + 9500, media: [{ kind: 'image' }] }] };
  const events = [
    { type: 'session', id: 'session-fake-0001' },
    { type: 'tool/result', time: T + 10_000, data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: JSON.stringify(wait) }] } } },
    { type: 'assistant/message', time: T + 11_000, data: { message: { content: [{ type: 'reasoning', text: 'I should watch it' }, { type: 'tool-call', id: 'c2', name: SEND, arguments: JSON.stringify({ key: 'k', messages: ['我看看'] }) }] } } },
    { type: 'tool/call', time: T + 12_000, data: { callId: 'c3', name: VIEWER, arguments: JSON.stringify({ groupId: '100001' }) } },
    { type: 'tool/result', time: T + 60_000, data: { message: { role: 'tool', toolCallId: 'c3', content: [IMAGE, { type: 'text', text: '元数据' }] } } },
    { type: 'assistant/message', time: T + 62_000, data: { message: { content: [{ type: 'reasoning', text: 'a tiny black puppy under a car' },
      { type: 'tool-call', id: 'c4', name: SEND, arguments: JSON.stringify({ key: 'k', token: 'zzz', messages: ['好小一只', '往车底下钻了'] }) },
      { type: 'tool-call', id: 'c5', name: 'mcp__x__web_search', arguments: JSON.stringify({ text: '小狗 钻车底' }) }] } } },
    { type: 'tool/call', time: T + 63_000, data: { callId: 'c6', name: 'mcp__snowluma__qq_get_message_images', arguments: JSON.stringify({ key: 'group:100001', messageId: 'm3', token: 'x' }) } },
    { type: 'tool/result', time: T + 64_000, data: { message: { role: 'tool', toolCallId: 'c6', content: [IMAGE] } } },
    { type: 'assistant/message', time: T + 65_000, data: { message: { content: [{ type: 'reasoning', text: 'a cat' }] } } },
    { type: 'tool/call', time: T + 66_000, data: { callId: 'c7', name: 'mcp__snowluma__qq_get_sticker_image', arguments: JSON.stringify({ key: 'group:100001', stickerId: 's1' }) } },
    { type: 'tool/result', time: T + 67_000, data: { message: { role: 'tool', toolCallId: 'c7', content: [IMAGE] } } },
    { type: 'tool/result', time: T + 70_000, data: { message: { role: 'tool', toolCallId: 'c9', content: [IMAGE] } } },
    { type: 'turn/end', time: T + 80_000, data: {} },
  ];
  const v = viewsIn(events, { viewTools: [VIEWER] });
  assert.equal(v.length, 4);
  assert.deepEqual(v[0].message, { time: T, text: '[视频]', kind: 'video' }, '声明的工具没给 id：视频优先、恰好一条');
  assert.equal(v[0].thoughts, 'a tiny black puppy under a car');
  assert.equal(v[0].reply, '好小一只\n往车底下钻了', '参数里的 key / token、不是说话类工具的参数不算她说的话');
  assert.deepEqual(v[1].message, { time: T + 9500, text: '[图片]', kind: 'image' }, '消息 id 点明的那张图');
  assert.equal(v[1].thoughts, 'a cat');
  assert.equal(v[2].message, null, '收藏表情：没点明是哪条消息');
  assert.equal(v[3].message, null);
  assert.equal(viewsIn(events).filter((x) => x.message).length, 1, '没声明那个看视频的工具：只认给了消息 id 的');
  assert.equal(viewsIn(events, { viewTools: [VIEWER], since: T + 65_000 }).length, 2);
});

test('没有 resolveViewedMedia 钩子的适配器（例：网页会话）：结果带图片的工具不往她直接看到的上传里写；声明过的工具恰好一条才算', async () => {
  const { createMediaSeen } = await import('../../src/host/media.js');
  const { createSessionStates } = await import('../../src/host/session-state.js');
  const states = createSessionStates();
  const sent = [];
  let cfg = { media: {} };
  const ms = createMediaSeen({ getPm: () => ({ media: { noteViewed: async (r) => { sent.push(r); return { ok: true, reason: 'written' }; } } }), states, hostConfig: () => cfg, log: { warn() {} } });
  const claim = { sessionId: 's1', settingId: 'S', adapterId: 'web', binding: {} };
  ms.noteObserved(claim, [{ id: 'up1', settingId: 'S', at: 1, media: [{ kind: 'image' }] }]);
  assert.equal(ms.onToolResult(claim, { name: 'browser_screenshot', arguments: {} }, [IMAGE]), false, '截图、读图片文件：不是她看的那张上传');
  assert.equal(ms.pending('s1'), null);
  cfg = { media: { viewTools: ['look_upload'] } };
  assert.equal(ms.onToolResult(claim, { name: 'look_upload', arguments: {} }, [IMAGE]), true, '声明过的工具、这个场合恰好一条');
  ms.onAssistant('s1', { message: { content: [{ type: 'reasoning', text: '一张猫的照片' }, { type: 'text', text: '好可爱' }] } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((r) => r.obsId), ['up1']);
  ms.noteObserved(claim, [{ id: 'up2', settingId: 'S', at: 2, media: [{ kind: 'image' }] }]);
  assert.equal(ms.onToolResult(claim, { name: 'look_upload', arguments: {} }, [IMAGE]), false, '两张上传分不清');
});
