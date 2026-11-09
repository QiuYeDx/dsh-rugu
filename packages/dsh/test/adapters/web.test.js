// DSH 网页适配器（§11.3）：认领要正面证据（fallback）；主人 / 远程访客 / 提醒 / 她说的话；场合属性；宿主会话钩子。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservation, validateSettingDescriptor, validatePerceptionAdapter } from 'rugu-core/contract';
import { validateBinding } from '../../src/binding/index.js';
import { createWebAdapter, ADAPTER_ID } from '../../src/adapters/web.js';
import { fakeSink, fakeLog, salt as mkSalt, rid } from './helpers.js';

function fakeSessions() {
  const msgCbs = new Set();
  const sesCbs = new Set();
  const rebinds = [];
  return {
    onMessage(cb) { msgCbs.add(cb); return () => msgCbs.delete(cb); },
    onSession(cb) { sesCbs.add(cb); return () => sesCbs.delete(cb); },
    rebind(sessionId, settingId) { rebinds.push({ sessionId, settingId }); },
    emit(e) { for (const cb of msgCbs) cb(e); },
    session(info) { for (const cb of sesCbs) cb(info); },
    rebinds,
    listeners: () => msgCbs.size + sesCbs.size,
  };
}
const userMsg = (text, source = { kind: 'user', rpcId: 'r1' }, seq = 1) => ({ type: 'user/message', seq, data: { message: { role: 'user', content: [{ type: 'text', text }], source } } });
const assistantMsg = (text, seq = 2) => ({ type: 'assistant/message', seq, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'thinking', text: '内心' }, { type: 'text', text }, { type: 'tool-call', name: 'x' }] } } });
const ok = (o) => { const r = validateObservation(o); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };

function setup(config = { presets: ['her-web'], excludeCwdPrefixes: ['X:/bridge/state/agents'] }, { gate = () => true } = {}) {
  const sessions = fakeSessions();
  const log = fakeLog();
  const adapter = createWebAdapter({ salt: mkSalt(), sessions, config, log, now: () => Date.UTC(2026, 10, 4, 9, 0, 0), ...(gate ? { gate } : {}) });
  return { adapter, sessions, log, b: adapter.binding };
}
/** pre-step 里 claimed 的一条消息（宿主放进 SessionInfo.messages）。 */
const claimedMsg = (source) => ({ id: rid('m'), role: 'user', content: [{ type: 'text', text: '在吗' }], source });

test('契约：适配器和绑定的形状；没有说话类工具（模型文本本身就是发言）', () => {
  const { adapter, b } = setup();
  assert.ok(validatePerceptionAdapter(adapter).ok);
  assert.equal(adapter.id, ADAPTER_ID);
  assert.deepEqual(validateBinding(b), { ok: true, errors: [] });
  assert.deepEqual(b.tools, []);
  assert.deepEqual(adapter.principalClaims(), [{ kind: 'principal', strength: 'config' }]);
  assert.throws(() => createWebAdapter({ salt: 'x' }), TypeError);
});

test('认领：要正面证据（配置的 preset 或手动绑定），返回 fallback；没 principal 字段不算证据；子代理、委派、桥接目录下的不认', () => {
  const { adapter, b } = setup({ presets: ['her-web'], sessionIds: ['bound-1'], excludeCwdPrefixes: ['X:\\bridge\\state\\agents'] });
  assert.deepEqual(b.claimSession({ id: 's1', preset: 'her-web', cwd: 'D:/work', header: {} }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.deepEqual(b.claimSession({ id: 'bound-1', header: {} }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.equal(b.claimSession({ id: 's2', preset: 'standard', header: {} }), null, '普通会话：没有正面证据');
  assert.equal(b.claimSession({ id: 's3', header: {} }), null);
  assert.equal(b.claimSession({ id: 's4', preset: 'her-web', origin: 'subagent', header: {} }), null);
  assert.equal(b.claimSession({ id: 's5', preset: 'her-web', delegationDepth: 2, header: {} }), null);
  assert.equal(b.claimSession({ id: 's6', preset: 'her-web', cwd: 'x:/bridge/state/agents/q', header: {} }), null);
  assert.equal(b.claimSession({ id: 's7', preset: 'her-web', header: { archived: true } }), null);
  assert.equal(setup({}).b.claimSession({ id: 's8', preset: 'her-web', header: {} }), null, '没配置就什么都不认（fail closed）');
  assert.deepEqual(b.sessionSignature(), { presets: ['her-web'] });
  assert.throws(() => createWebAdapter({}), TypeError, '没有盐、也没有地方派生盐');
});

test('认领的辅助证据：网页客户端的 clientTimeZone；以主人身份连进来的 API 客户端（不带它）按 preset 不认；手动绑定的不看这一条', () => {
  const { adapter, b } = setup({ presets: ['her-web'], sessionIds: ['bound-2'] });
  const web = claimedMsg({ kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' });
  const api = claimedMsg({ kind: 'user', rpcId: 'r2' });
  const sched = { id: 'x', role: 'user', content: [{ type: 'text', text: '提醒' }], source: { kind: 'schedule' } };
  assert.deepEqual(b.claimSession({ id: 't1', preset: 'her-web', header: {}, messages: [web] }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.equal(b.claimSession({ id: 't2', preset: 'her-web', header: {}, messages: [api] }), null, '没有时区标记：不是网页客户端');
  assert.deepEqual(b.claimSession({ id: 't3', preset: 'her-web', header: {}, messages: [sched] }), { settingId: adapter.ownerSettingId, confidence: 'fallback' }, '没有真人消息时不据此否定');
  assert.deepEqual(b.claimSession({ id: 't4', preset: 'her-web', header: {} }), { settingId: adapter.ownerSettingId, confidence: 'fallback' }, '没带消息（外发钩子里认领）');
  assert.deepEqual(b.claimSession({ id: 'bound-2', header: {}, messages: [api] }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.equal(adapter.status().claimNoTimeZone, 1);
  const loose = setup({ presets: ['her-web'], requireClientTimeZone: false });
  assert.deepEqual(loose.b.claimSession({ id: 't5', preset: 'her-web', header: {}, messages: [api] }), { settingId: loose.adapter.ownerSettingId, confidence: 'fallback' });
});

test('认领时就看到远程访客：直接认领成「和这位访客」的场合（不先记成主人），之后的事件也记在那里', () => {
  const { adapter, sessions, b } = setup();
  const sink = fakeSink();
  adapter.start(sink);
  const visitor = { kind: 'remote-user', id: rid('v'), displayName: '小李' };
  const r = b.claimSession({ id: 'rv-1', preset: 'her-web', header: {}, messages: [claimedMsg({ kind: 'user', rpcId: 'r', principal: visitor })] });
  assert.notEqual(r.settingId, adapter.ownerSettingId);
  assert.equal(r.confidence, 'fallback');
  assert.deepEqual(sessions.rebinds, [], '认领结果本来就对，不用 rebind');
  assert.ok(sink.described.some((d) => d.id === r.settingId && d.label === '和小李的 DSH 聊天'));
  const [o] = b.fromSessionEvent(assistantMsg('你好'), r.settingId, 'rv-1').map(ok);
  assert.equal(o.settingId, r.settingId);
  // principal.kind === 'owner' 不是访客
  const own = b.claimSession({ id: 'rv-2', preset: 'her-web', header: {}, messages: [claimedMsg({ kind: 'user', rpcId: 'r', clientTimeZone: 'UTC', principal: { kind: 'owner' } })] });
  assert.equal(own.settingId, adapter.ownerSettingId);
});

test('没有总开关（gate）：会话中心的事件不经 sink 提交，交给宿主查过 modeOf 的绑定路；会话归属照样跟踪', () => {
  const { adapter, sessions, b } = setup(undefined, { gate: null });
  const sink = fakeSink();
  adapter.start(sink);
  const hub = (sessionId, claim, ev) => sessions.emit({ sessionId, claim, type: ev.type, data: ev.data, seq: ev.seq, session: {} });
  hub('s-web', { settingId: adapter.ownerSettingId, adapterId: ADAPTER_ID }, userMsg('网页里说的'));
  assert.equal(sink.all().length, 0);
  const visitor = { kind: 'remote-user', id: rid('v') };
  hub('s-web', { settingId: adapter.ownerSettingId, adapterId: ADAPTER_ID }, userMsg('我是访客', { kind: 'user', rpcId: 'x', principal: visitor }, 5));
  assert.equal(sink.all().length, 0);
  assert.equal(sessions.rebinds.length, 1, '访客出现：通知宿主改记');
  // 绑定那条路（宿主在 observe 前查过 modeOf）照常翻译，之后的事件记在访客的场合
  const [o] = b.fromSessionEvent(assistantMsg('欢迎'), adapter.ownerSettingId, 's-web').map(ok);
  assert.equal(o.settingId, sessions.rebinds[0].settingId);
  assert.equal(adapter.status().gated, false);
  assert.ok(adapter.status().ungated >= 2);
});

test('自检：宿主总览的形状；没配置认领证据时提示', () => {
  const none = setup({}).adapter.selfCheck();
  assert.equal(none.find((x) => x.id === 'claim-evidence').level, 'warn');
  const some = setup().adapter.selfCheck();
  assert.equal(some.find((x) => x.id === 'claim-evidence').level, 'ok');
  for (const x of some) { assert.equal(typeof x.id, 'string'); assert.ok(['ok', 'warn', 'fail', 'info'].includes(x.level)); assert.equal(typeof x.label, 'string'); }
});

test('主人的消息、她的回答、她定的提醒；别的 source.kind 不是经历', () => {
  const { adapter, b } = setup();
  const sid = adapter.ownerSettingId;
  const [u] = b.fromSessionEvent(userMsg('帮我记一下明天交报告'), sid, 'sess-1').map(ok);
  assert.equal(u.kind, 'utterance');
  assert.deepEqual(u.actor.claims, [{ kind: 'principal', strength: 'config' }]);
  assert.equal(u.addressed, 'to-her');
  assert.equal(u.visibleTo, 'participants');
  assert.deepEqual(u.sessionRef, { sessionId: 'sess-1', seq: 1 });
  const [a] = b.fromSessionEvent(assistantMsg('好，明天提醒你'), sid, 'sess-1').map(ok);
  assert.equal(a.kind, 'self-utterance');
  assert.equal(a.text, '好，明天提醒你', '只取文字块，思考和工具调用不算她说的话');
  assert.equal(a.addressed, 'by-her');
  const [r] = b.fromSessionEvent(userMsg('提醒：交报告', { kind: 'schedule' }, 3), sid, 'sess-1').map(ok);
  assert.equal(r.kind, 'reminder');
  assert.equal(r.actor.self, true);
  assert.equal(r.evidential, false);
  for (const kind of ['runtime-context', 'agent-instructions', 'compact-checkpoint', 'persona-memory', 'ptc-mode']) {
    assert.deepEqual(b.fromSessionEvent(userMsg('x', { kind }), sid, 'sess-1'), [], kind);
  }
  assert.deepEqual(b.fromSessionEvent({ type: 'tool/result', seq: 9, data: {} }, sid, 'sess-1'), []);
  assert.deepEqual(b.fromSessionEvent(userMsg('   '), sid, 'sess-1'), [], '空消息');
  // 同一条事件两次映射：同一个 ObsId（宿主两条路都走也只会去重）
  assert.equal(b.fromSessionEvent(userMsg('帮我记一下明天交报告'), sid, 'sess-1')[0].id, u.id);
  assert.equal(b.resolveFocus({ sessionId: 'sess-1', event: userMsg('帮我记一下明天交报告') }), u.id);
  assert.equal(b.resolveFocus(userMsg('帮我记一下明天交报告'), 'sess-1'), u.id);
  assert.equal(b.resolveFocus(assistantMsg('x'), 'sess-1'), null);
});

test('宿主两条路交同一条消息（pre-step 的 claimed 消息没有序号、session/event 有序号）：消息 id 相同就是同一个 ObsId', () => {
  const { adapter, b } = setup();
  const sid = adapter.ownerSettingId;
  const m = { id: 'msg-uuid-1', role: 'user', content: [{ type: 'text', text: '今天好累' }], source: { kind: 'user', rpcId: 'r9' } };
  const [viaPreStep] = b.fromSessionEvent({ type: 'user/message', data: m, seq: -1 }, sid, 'sess-1').map(ok);
  const [viaEvent] = b.fromSessionEvent({ type: 'user/message', data: m, seq: 42 }, sid, 'sess-1').map(ok);
  assert.equal(viaPreStep.id, viaEvent.id);
  assert.deepEqual(viaPreStep.sessionRef, { sessionId: 'sess-1' }, '没有序号就不写（契约要求 seq ≥ 0）');
  assert.deepEqual(viaEvent.sessionRef, { sessionId: 'sess-1', seq: 42 });
  assert.equal(b.resolveFocus(m), viaEvent.id, '宿主直接给 claimed 消息也认得出');
  const a = { type: 'assistant/message', seq: 43, data: { turn: 1, step: 1, message: { id: 'msg-uuid-2', role: 'assistant', content: [{ type: 'text', text: '早点睡' }] } } };
  assert.equal(b.fromSessionEvent(a, sid, 'sess-1')[0].id, b.fromSessionEvent({ ...a, seq: 99 }, sid, 'sess-1')[0].id);
});

test('远程访客：带 principal 的消息记在「和这位访客」的场合，会话从此改记过去并通知宿主；身份不存原样', async () => {
  const { adapter, sessions, b } = setup();
  const sink = fakeSink();
  adapter.start(sink);
  const visitor = { kind: 'remote-user', id: rid('v'), displayName: '小王' };
  sessions.emit({ sessionId: 'sess-r', event: userMsg('你好呀', { kind: 'user', rpcId: 'x', principal: visitor }), settingId: adapter.ownerSettingId });
  const [o] = sink.all().map(ok);
  assert.notEqual(o.settingId, adapter.ownerSettingId);
  assert.equal(o.actor.claims[0].kind, 'account');
  assert.equal(o.actor.claims[0].displayName, '小王');
  assert.ok(!o.actor.claims[0].id.includes(visitor.id), '账号 id 是 HMAC，不是原样');
  assert.deepEqual(sessions.rebinds, [{ sessionId: 'sess-r', settingId: o.settingId }]);
  const d = sink.described.find((x) => x.id === o.settingId);
  assert.ok(validateSettingDescriptor(d).ok);
  assert.equal(d.label, '和小王的 DSH 聊天');
  assert.deepEqual((await adapter.members(o.settingId)).length, 2);
  // 之后她在这个会话里的回答也记在访客的场合
  sessions.emit({ sessionId: 'sess-r', event: assistantMsg('你好') });
  assert.equal(sink.all()[1].settingId, o.settingId);
  assert.deepEqual(b.claimSession({ id: 'sess-r', preset: 'her-web', header: {} }), { settingId: o.settingId, confidence: 'fallback' });
  // 主人的会话不受影响
  sessions.emit({ sessionId: 'sess-o', event: userMsg('在吗'), settingId: adapter.ownerSettingId });
  assert.equal(sink.all()[2].settingId, adapter.ownerSettingId);
});

test('场合：2 人、closed、participants、logged；没有发出前的拦截点（preSendGate:false）', async () => {
  const { adapter } = setup();
  const d = adapter.describeSetting(adapter.ownerSettingId);
  assert.ok(validateSettingDescriptor(d).ok);
  assert.deepEqual(d.audience, { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' });
  assert.deepEqual(d.disclosure, { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true });
  assert.deepEqual(d.capabilities, { preSendGate: false, canHold: false });
  assert.equal(d.ownership.actsOnBehalfOfPrincipal, true);
  assert.equal((await adapter.members(adapter.ownerSettingId)).length, 2);
  assert.throws(() => adapter.describeSetting('nope'), /不认识/);
  assert.equal(await adapter.members('nope'), null);
});

test('start / stop：订阅宿主的会话钩子，停掉后取消订阅；坏事件不抛；日志里没有内容', () => {
  const { adapter, sessions, log } = setup();
  const sink = fakeSink();
  const stop = adapter.start(sink);
  assert.equal(sessions.listeners(), 2);
  assert.equal(sink.described[0].id, adapter.ownerSettingId);
  sessions.emit(null);
  sessions.emit({ sessionId: '', event: userMsg('x') });
  sessions.emit({ sessionId: 's', event: { type: 'user/message', data: null } });
  sessions.emit({ sessionId: 's', event: userMsg('秘密内容'), settingId: adapter.ownerSettingId });
  assert.equal(sink.all().length, 1);
  stop();
  assert.equal(sessions.listeners(), 0);
  sessions.emit({ sessionId: 's', event: userMsg('停了以后'), settingId: adapter.ownerSettingId });
  assert.equal(sink.all().length, 1);
  log.assertNoText('秘密内容');
});

test('宿主会话中心的形状（{sessionId, claim, type, data, seq}）：只收认领给网页适配器的会话；总开关 off 的场合不感知', () => {
  const sessions = fakeSessions();
  let off = false;
  const adapter = createWebAdapter({ salt: mkSalt(), sessions, config: { presets: ['her-web'] }, gate: () => !off });
  const sink = fakeSink();
  adapter.start(sink);
  const hub = (sessionId, claim, ev) => sessions.emit({ sessionId, claim, type: ev.type, data: ev.data, seq: ev.seq, session: {} });
  hub('s-web', { settingId: adapter.ownerSettingId, adapterId: ADAPTER_ID }, userMsg('网页里说的'));
  hub('s-qq', { settingId: 'qq-setting', adapterId: 'qq' }, userMsg('QQ 会话的唤醒消息'));
  hub('s-none', null, userMsg('没人认领的会话'));
  sessions.emit({ sessionId: 's-unknown', event: userMsg('不知道是谁的会话') });
  assert.deepEqual(sink.all().map((o) => o.text), ['网页里说的']);
  off = true;
  hub('s-web', { settingId: adapter.ownerSettingId, adapterId: ADAPTER_ID }, assistantMsg('off 的时候说的'));
  assert.equal(sink.all().length, 1);
});

test('插件预设（D112）：管理页的说法、自检用预设在下拉里的名字；预设不在下拉里才说接不上；status 带 presets', () => {
  const roster = { list: [{ id: 'persona-chat', name: '某个名字', broken: false }] };
  const presetRoster = {
    nameOf: (id) => roster.list.find((r) => r.id === id)?.name ?? null,
    available: (id) => (roster.list ? !!roster.list.find((r) => r.id === id && !r.broken) : null),
  };
  const mk = (config) => createWebAdapter({ salt: mkSalt(), config, log: fakeLog(), presetRoster });
  const a = mk({ presets: ['persona-chat'] });
  assert.equal(a.quietReason(a.ownerSettingId), null, '预设在：接得上，不报');
  const ce = a.selfCheck().find((x) => x.id === 'claim-evidence');
  assert.equal(ce.level, 'ok');
  assert.match(ce.label, /选了「某个名字」预设的会话算跟主人聊/);
  assert.match(ce.label, /子代理除外/);
  assert.deepEqual(a.status().presets, ['persona-chat']);
  roster.list[0].broken = true;
  assert.match(a.quietReason(a.ownerSettingId), /「某个名字」预设现在不在新建任务的列表里/);
  roster.list = [];
  assert.match(a.quietReason(a.ownerSettingId), /「persona-chat」预设现在不在/, '名单里没有就用 id');
  roster.list = null;
  assert.equal(a.quietReason(a.ownerSettingId), null, '不知道（还没列出来过）：不乱报');
  roster.list = [];
  const bound = mk({ presets: ['persona-chat'], sessionIds: ['s1'] });
  assert.equal(bound.quietReason(bound.ownerSettingId), null, '有手动绑定的会话：接得上');
  const none = mk({ presets: [] });
  assert.match(none.quietReason(none.ownerSettingId), /一个都没接到这里/);
  // 没有名单（老宿主）：和以前一样
  const old = createWebAdapter({ salt: mkSalt(), config: { presets: ['persona-chat'] }, log: fakeLog() });
  assert.equal(old.quietReason(old.ownerSettingId), null);
  assert.match(old.selfCheck()[0].label, /「persona-chat」/);
});

test('认领（D112）：因为不带时区被拒过的会话，之后不带用户消息的续步也不认；来一条带时区的就认上', () => {
  const { adapter, b } = setup({ presets: ['her-web'] });
  const api = claimedMsg({ kind: 'user', rpcId: 'r2' });
  const web = claimedMsg({ kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' });
  assert.equal(b.claimSession({ id: 'n1', preset: 'her-web', header: {}, messages: [api] }), null);
  assert.equal(b.claimSession({ id: 'n1', preset: 'her-web', header: {}, messages: [] }), null, '工具结果之后的续步：照旧不认');
  assert.equal(b.claimSession({ id: 'n1', preset: 'her-web', header: {} }), null, '外发钩子里（不带消息）也不认');
  assert.deepEqual(b.claimSession({ id: 'n1', preset: 'her-web', header: {}, messages: [web] }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.deepEqual(b.claimSession({ id: 'n1', preset: 'her-web', header: {} }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.equal(adapter.status().claimNoTimeZone, 1, '只按真的被拒的那条消息计数');
});

test('认领（集成复查）：从菜单里「分叉会话」分出来的（parentSession + isSeeded、没有 origin）是普通会话，按它自己的预设认；子代理照旧不认', () => {
  const { adapter, b } = setup({ presets: ['her-web'] });
  const web = claimedMsg({ kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' });
  const forkHeader = { id: 'f1', parentSession: 'p1', isSeeded: true, agentPreset: 'her-web' };
  assert.deepEqual(b.claimSession({ id: 'f1', preset: 'her-web', parentSession: 'p1', header: forkHeader, messages: [web] }), { settingId: adapter.ownerSettingId, confidence: 'fallback' });
  assert.equal(b.claimSession({ id: 'f2', preset: 'standard', parentSession: 'p1', header: { ...forkHeader, id: 'f2', agentPreset: 'standard' }, messages: [web] }), null, '分叉的是标准模式的会话：不认');
  assert.equal(b.claimSession({ id: 'k1', preset: 'her-web', parentSession: 'p1', header: { id: 'k1', parentSession: 'p1', origin: 'subagent', delegationDepth: 1 }, messages: [web] }), null, '子代理');
  assert.equal(b.claimSession({ id: 'k2', preset: 'her-web', header: { id: 'k2', delegationDepth: 1 }, messages: [web] }), null, '委派深度 > 0');
  assert.equal(b.retryOnSignature, true, '网页声明了快速重试（宿主只对声明了的绑定这么做）');
});

test('自检（集成复查）：配置放宽了「哪些会话算跟她聊」（别的预设、手动绑定、不要求时区）时标成 warn——停着 DSH 改文件、重启时不经确认就生效', () => {
  const presetRoster = { nameOf: (id) => (id === 'persona-chat' ? '某个名字' : null), available: () => true, own: () => 'persona-chat' };
  const mk = (config) => createWebAdapter({ salt: mkSalt(), config, log: fakeLog(), presetRoster }).selfCheck().find((x) => x.id === 'claim-evidence');
  assert.equal(mk({ presets: ['persona-chat'] }).level, 'ok');
  const wide = mk({ presets: ['persona-chat', 'standard'] });
  assert.equal(wide.level, 'warn');
  assert.match(wide.label, /配置放宽了——「standard」预设开的会话也算/);
  assert.match(mk({ presets: ['persona-chat'], sessionIds: ['s1'] }).label, /1 个手动指定的会话也算/);
  assert.equal(mk({ presets: ['persona-chat'], requireClientTimeZone: false }).level, 'warn');
});
