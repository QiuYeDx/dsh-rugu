// QQ 适配器的纯函数部分：文件投影（白名单、丢掉令牌）、消息 → Observation 的字段映射、场合描述的属性映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservation, validateSettingDescriptor, settingIdLeaksAccount, opaqueFrom } from 'rugu-core/contract';
import {
  projectSocial, projectBridgeConfig, projectSessions, projectMode, projectInitialPrompts, projectScheduler,
  canonicalKey, allowedByBridge, projectMessage,
} from '../../src/adapters/qq/files.js';
import { toObservation, joinHeadTail, scrubAccounts, ownText, parseQuote, knownNames, obsIdOf } from '../../src/adapters/qq/messages.js';
import { describeConversation } from '../../src/adapters/qq/describe.js';
import { rid, salt as mkSalt, randomDigits, inMsg, pokeMsg, noticeMsg, selfMsg, socialFile } from './helpers.js';

const T0 = Date.UTC(2026, 10, 4, 8, 0, 0);
const deepKeys = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v instanceof Map) [...v.values()].forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); deepKeys(x, out); }
  return out;
};

test('social-v2 投影：只留消息流、计数和群规；agentToken、桥接自己的记忆、ownerLabel、媒体定位都丢掉', () => {
  const owner = rid('u');
  const g = `group:${rid('g')}`;
  const raw = socialFile({
    [g]: {
      recent: [inMsg({ seq: 1, userId: owner, sender: '群主', text: 'hi', time: T0, isOwner: true,
        media: [{ kind: 'image', file: 'secret-file', url: 'https://x/?sig=abc', summary: '一张图' }] })],
      ownerRules: [{ id: 1, text: '别刷屏', at: T0 }, { id: 0, text: '坏规则' }],
    },
    'notakey': { recentMessages: [] },
    __proto__: { recentMessages: [] },
  });
  const p = projectSocial(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual([...p.conversations.keys()], [g]);
  const keys = deepKeys(p);
  for (const bad of ['agentToken', 'memberImpressions', 'activeTopics', 'pendingThoughts', 'ownerLabel', 'url', 'file', 'wakeConfig', 'seenForwardIds']) {
    assert.ok(!keys.has(bad), `投影里不应有 ${bad}`);
  }
  assert.ok(!JSON.stringify([...p.conversations.values()]).includes(owner.slice(0, 0) + 'ownerQQ'));
  const c = p.conversations.get(g);
  assert.equal(c.recent[0].media[0].summary, '一张图');
  assert.deepEqual(c.ownerRules.map((r) => r.text), ['别刷屏']);
  assert.equal(projectSocial(null).conversations.size, 0);
  assert.equal(projectSocial({ conversations: [] }).conversations.size, 0);
});

test('会话 key 归一：数字去前导零；不合格的不认', () => {
  assert.equal(canonicalKey('group:00123'), 'group:123');
  assert.equal(canonicalKey(' private:u1a2 '), 'private:u1a2');
  for (const bad of ['group:0', 'internal:黑话学习', 'group:', 'private:a b', 'x:1', '__proto__']) assert.equal(canonicalKey(bad), null, bad);
});

test('桥接 config.json 投影：令牌、端口、模型一概不取；白名单判断和桥接一致', () => {
  const owner = rid('u');
  const g1 = rid('g');
  const g2 = rid('g');
  const raw = {
    dsh: { authToken: 'tok-dsh' }, snowluma: { accessToken: 'tok-ob', httpUrl: 'http://127.0.0.1:1' }, consoleToken: 'tok-console',
    ownerQQ: owner, allow: { private: [owner], groups: [g1] }, deny: { groups: [g2] }, allowAllWhenEmpty: false,
    agentPreset: 'qq-chat', socialV2: { agentPreset: 'qq-chat-v2' }, sessionCwd: '',
    continuity: { groups: { [g1]: { label: '测试群', recordable: false }, __proto__: {} } },
  };
  const c = projectBridgeConfig(raw);
  const blob = JSON.stringify({ ...c, groups: [...c.groups] });
  for (const t of ['tok-dsh', 'tok-ob', 'tok-console', '127.0.0.1']) assert.ok(!blob.includes(t), `不应带出 ${t}`);
  assert.equal(c.ownerId, owner);
  assert.deepEqual(c.presets, ['qq-chat-v2', 'qq-chat']);
  assert.equal(c.groups.get(g1).recordable, false);
  assert.equal(allowedByBridge(c, `group:${g1}`), true);
  assert.equal(allowedByBridge(c, `group:${g2}`), false);
  assert.equal(allowedByBridge(c, `private:${rid('u')}`), false);
  assert.equal(allowedByBridge(null, `group:${g1}`), null, '读不到配置：不知道');
  assert.equal(allowedByBridge(projectBridgeConfig({ allowAllWhenEmpty: true }), `group:${g1}`), true);
});

test('其余几个文件的投影：会话映射（含休眠）、模式别名、环境说明、定时任务', () => {
  const k1 = `private:${rid('u')}`;
  const k2 = `group:${rid('g')}`;
  const s = projectSessions({ sessions: { [k1]: 's-1', bad: 's-x' }, dormantSessions: { [k2]: { sessionId: 's-2', policy: '[]' } } });
  assert.equal(s.get('s-1'), k1);
  assert.equal(s.get('s-2'), k2);
  assert.equal(s.size, 2);
  assert.equal(projectMode({ mode: 'simulation' }).mode, 'reserved2');
  assert.equal(projectMode({ mode: 'chat' }).mode, 'chat');
  assert.equal(projectMode({ mode: 'weird' }).mode, null);
  assert.equal(projectInitialPrompts({ [k2]: { text: ' 这是游戏群 ' }, nope: { text: 'x' } }).get(k2), '这是游戏群');
  const tasks = projectScheduler({ tasks: [{ id: 1, kind: 'text', text: '早安', targets: [k1], createdBy: 'console' }, { id: 2, kind: 'ai', instruction: 'x' }, { id: 3, kind: 'text', text: '晚安', targets: [k1], createdBy: 'owner-chat-ai' }] });
  assert.deepEqual(tasks.map((t) => [t.id, t.kind, t.byHer]), [[1, 'text', false], [2, 'ai', false], [3, 'text', true]], '叫 AI 来说的任务也留着（改任务时按它合并补丁）');
  assert.deepEqual(tasks[1].targets, []);
  assert.equal(tasks[1].instruction, 'x');
  assert.equal(tasks[0].text, '早安');
});

test('头尾拼接：≤200 字原样；200–400 字拼回全文；更长的中间用「…」接上并标截断', () => {
  const short = '短消息';
  assert.deepEqual(joinHeadTail(short, short), { text: short, truncated: false });
  const mid = Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x4e00 + (i % 500))).join('');
  assert.deepEqual(joinHeadTail(mid.slice(0, 200), mid.slice(-200)), { text: mid, truncated: false });
  const long = Array.from({ length: 900 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
  const r = joinHeadTail(long.slice(0, 200), long.slice(-200));
  assert.equal(r.truncated, true);
  assert.equal(r.text, `${long.slice(0, 200)}…${long.slice(-200)}`);
  // 工具结果里压缩掉的 plain / tail 补回来
  assert.deepEqual(ownText({ text: 'abc', time: 1 }), { text: 'abc', truncated: false });
});

test('账号原值不进 text：认识的换成名字，不认识的换成「某人」，桥接渲染的「（QQ …）」去掉', () => {
  const a = rid('u');
  const known = new Map([[a, '阿明']]);
  assert.equal(scrubAccounts(`[拍一拍] 小红 拍了拍 ${a}`, known), '[拍一拍] 小红 拍了拍 阿明');
  assert.equal(scrubAccounts(`[入群] 阿明（QQ ${a}） 加入了本群`, known), '[入群] 阿明 加入了本群');
  const d = randomDigits();
  assert.equal(scrubAccounts(`@${d} 你好`, new Map()), '@某人 你好');
  assert.equal(scrubAccounts(`加我 QQ ${d}`, new Map()), '加我 某人');
  assert.equal(scrubAccounts(`${a}x 不是同一个词`, known), `${a}x 不是同一个词`, '整词替换');
});

function ctxFor(key, msgs, extra = {}) {
  const s = mkSalt();
  const kind = key.startsWith('group:') ? 'group' : 'private';
  const sid = opaqueFrom(s, 'qq/setting', key);
  return {
    key, kind, settingId: sid, salt: s, selfNames: ['小雪'], now: T0 + 5000,
    known: knownNames(msgs, { kind, peerId: kind === 'private' ? key.slice(8) : undefined, principalLabel: '主人', ...extra }),
  };
}
const ok = (o) => { const r = validateObservation(o); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };

test('群消息：账号 + 本群群名片；@她 / 叫她名字 → mentions-her，引用她 → to-her，其余 ambient', () => {
  const g = `group:${rid('g')}`;
  const a = rid('u');
  const m1 = inMsg({ seq: 1, userId: a, sender: '阿明', text: '今天去哪玩', time: T0 });
  const m2 = inMsg({ seq: 2, userId: a, sender: '阿明', text: '@小雪 你觉得呢', time: T0 + 1 });
  const m3 = inMsg({ seq: 3, userId: a, sender: '阿明', text: '[引用 小雪：好呀]对吧', plain: '对吧', time: T0 + 2, quoteSelf: true });
  const ctx = ctxFor(g, [m1, m2, m3]);
  const [o1, o2, o3] = [m1, m2, m3].map((m) => ok(toObservation(projectMessage(m), ctx, { attention: 'peripheral' })));
  assert.deepEqual(o1.actor.claims.map((c) => c.kind), ['account', 'display-name']);
  assert.equal(o1.actor.claims[1].scope, ctx.settingId, '群名片只在本群有效');
  assert.equal(o1.visibleTo, 'setting-audience');
  assert.equal(o1.addressed, 'ambient');
  assert.equal(o2.addressed, 'mentions-her');
  assert.ok(o2.mentions.some((x) => x.self));
  assert.equal(o3.addressed, 'to-her');
  assert.equal(o3.text, '对吧', 'text 只是她这条自己的话，引用的原文进 quote');
  assert.deepEqual(o3.quote, { excerpt: '好呀', author: { self: true, claims: [] } });
  assert.equal(new Set([o1.id, o2.id, o3.id]).size, 3);
  assert.ok(!settingIdLeaksAccount(ctx.settingId, o1.actor.claims));
});

test('私聊：to-her、participants；主人的行带 principal 证据；她自己的行先判 isSelf（isOwner 也是 true，C2）', () => {
  const owner = rid('u');
  const k = `private:${owner}`;
  const m = inMsg({ seq: 1, userId: owner, text: '快递拿了没', time: T0, isOwner: true });
  const me = selfMsg('拿了', T0 + 1000);
  const ctx = ctxFor(k, [m], { ownerId: owner });
  const o = ok(toObservation(projectMessage(m), ctx, { attention: 'peripheral' }));
  assert.equal(o.visibleTo, 'participants');
  assert.equal(o.addressed, 'to-her');
  assert.deepEqual(o.actor.claims.map((c) => c.kind), ['account', 'principal'], '私聊的 sender 是字面量「私聊」，不当名字');
  const s = ok(toObservation(projectMessage(me), ctx, { attention: 'peripheral', appraisalToken: 'tok-1' }));
  assert.equal(s.kind, 'self-utterance');
  assert.equal(s.addressed, 'by-her');
  assert.equal(s.actor.self, true);
  assert.equal(s.appraisalToken, 'tok-1');
  const b = ok(toObservation(projectMessage(selfMsg('（定时任务）早安', T0 + 2000)), ctx, { attention: 'attended', onMyBehalf: true }));
  assert.equal(b.kind, 'on-my-behalf');
  assert.equal(b.appraisalToken, undefined);
});

test('拍一拍、入群提示：evidential:false、standing:platform；文字里的账号换掉；拍她 → to-her', () => {
  const g = `group:${rid('g')}`;
  const a = rid('u');
  const b = rid('u');
  const said = inMsg({ seq: 1, userId: b, sender: '小红', text: '在吗', time: T0 });
  const poke = pokeMsg({ seq: 2, userId: a, sender: '阿明', targetId: b, time: T0 + 1, suffix: '的脑袋' });
  const pokeMe = pokeMsg({ seq: 3, userId: a, sender: '阿明', targetIsSelf: true, time: T0 + 2 });
  const join = noticeMsg({ seq: 4, userId: rid('u'), name: '新人', time: T0 + 3 });
  const ctx = ctxFor(g, [said, poke, pokeMe, join]);
  const [, op, om, oj] = [said, poke, pokeMe, join].map((m) => ok(toObservation(projectMessage(m), ctx, { attention: 'peripheral' })));
  assert.equal(op.kind, 'action');
  assert.equal(op.evidential, false);
  assert.equal(op.standing, 'platform');
  assert.equal(op.text, '[拍一拍] 阿明 拍了拍 小红 的脑袋');
  assert.equal(op.mentions[0].claims[0].id, b, '被拍的人是结构化的账号证据');
  assert.equal(op.addressed, 'ambient');
  assert.equal(om.addressed, 'to-her');
  assert.equal(oj.kind, 'presence');
  assert.equal(oj.evidential, false);
  assert.ok(!oj.text.includes(join.userId), '入群提示里的账号去掉了');
  assert.equal(oj.text, '[入群] 新人 加入了本群：第一次见到的人');
});

test('长消息头尾拼接标 textTruncated；转发只留占位和 media；ObsId 稳定、不同来源同一条消息得到同一个 id', () => {
  const g = `group:${rid('g')}`;
  const a = rid('u');
  const long = '很长'.repeat(400);
  const m = inMsg({ seq: 7, userId: a, sender: '阿明', text: `${long}[转发消息 id=fwd123]`, time: T0, forwardIds: ['fwd123'] });
  const ctx = ctxFor(g, [m]);
  const o = ok(toObservation(projectMessage(m), ctx, { attention: 'peripheral' }));
  assert.equal(o.textTruncated, true);
  assert.ok(o.media.some((x) => x.kind === 'forward'));
  const short = inMsg({ seq: 8, userId: a, sender: '阿明', text: '看这个[转发消息 id=fwd456]', time: T0 + 1, forwardIds: ['fwd456'] });
  const os = ok(toObservation(projectMessage(short), ctx, { attention: 'peripheral' }));
  assert.equal(os.text, '看这个[转发消息]');
  // 工具结果里的消息（压缩过：plain/tail 和 text 相同的被删）→ 同一个 id
  const compact = { seq: 8, messageId: short.messageId, sender: '阿明', userId: a, text: short.text, time: short.time, hasForward: true };
  assert.equal(obsIdOf(ctx.salt, g, projectMessage(compact)), os.id);
  assert.equal(parseQuote({ text: '[引用消息]你好' }).excerpt, '');
});

test('场合描述：私聊 2 人 closed exact / participants logged；群 invite recent-speakers / members logged；规矩带作者', () => {
  const owner = rid('u');
  const other = rid('u');
  const g = rid('g');
  const s = mkSalt();
  const cfg = projectBridgeConfig({ ownerQQ: owner, allow: { private: [owner, other], groups: [g] }, continuity: { groups: { [g]: { label: '游戏群' } } } });
  const sid = (k) => opaqueFrom(s, 'qq/setting', k);
  const dp = describeConversation({ key: `private:${owner}`, settingId: sid(`private:${owner}`), code: 'ab12', bridgeCfg: cfg, ownerId: owner, principalLabel: '主人', initialPrompt: '这是主人' });
  const dq = describeConversation({ key: `private:${other}`, settingId: sid(`private:${other}`), code: 'cd34', bridgeCfg: cfg, ownerId: owner, principalLabel: '主人' });
  const dg = describeConversation({ key: `group:${g}`, settingId: sid(`group:${g}`), code: 'ef56', bridgeCfg: cfg, ownerId: owner, principalLabel: '主人', ownerRules: [{ text: '别刷屏' }] });
  const dgOwned = describeConversation({ key: `group:${g}`, settingId: sid(`group:${g}`), code: 'ef56', bridgeCfg: cfg, ownerId: owner, principalLabel: '主人', override: { ownedByPrincipal: true, size: 12 } });
  for (const d of [dp, dq, dg, dgOwned]) assert.ok(validateSettingDescriptor(d).ok, JSON.stringify(validateSettingDescriptor(d).errors));
  assert.deepEqual(dp.audience, { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' });
  assert.deepEqual(dp.disclosure, { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true });
  assert.equal(dp.ownership.actsOnBehalfOfPrincipal, true);
  assert.equal(dp.label, '和主人的私聊');
  assert.equal(dp.norms.notes[0].author.claims.at(-1).kind, 'principal');
  assert.equal(dq.ownership.actsOnBehalfOfPrincipal, false);
  assert.equal(dq.ownership.herRole, '朋友');
  assert.deepEqual(dg.audience, { size: 'unknown', entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' });
  assert.equal(dg.disclosure.visibleTo, 'members');
  assert.equal(dg.label, '游戏群');
  assert.equal(dg.ownership.herModerates, false);
  assert.deepEqual(dg.norms.notes.map((n) => n.text), ['别刷屏']);
  assert.equal(dgOwned.ownership.herModerates, true);
  assert.equal(dgOwned.audience.size, 12);
  for (const d of [dp, dq, dg]) {
    assert.equal(d.capabilities.preSendGate, true);
    assert.equal(d.capabilities.canHold, false);
    assert.ok(!settingIdLeaksAccount(d.id, [{ kind: 'account', id: owner }, { kind: 'account', id: other }, { kind: 'account', id: g }]));
    assert.ok(!d.label.includes(owner) && !d.label.includes(other) && !d.label.includes(g));
  }
});

test('场合描述：不在白名单、recordable:false、主人说「别记这里」→ attending:false', () => {
  const g = rid('g');
  const s = mkSalt();
  const base = { key: `group:${g}`, settingId: opaqueFrom(s, 'qq/setting', `group:${g}`), code: 'x', principalLabel: '主人' };
  assert.equal(describeConversation({ ...base, bridgeCfg: projectBridgeConfig({ allow: { groups: [rid('g')] } }) }).attending, false);
  assert.equal(describeConversation({ ...base, bridgeCfg: projectBridgeConfig({ allow: { groups: [g] }, continuity: { groups: { [g]: { recordable: false } } } }) }).attending, false);
  assert.equal(describeConversation({ ...base, bridgeCfg: null, override: { doNotRecord: true } }).attending, false);
  assert.equal(describeConversation({ ...base, bridgeCfg: null }).attending, true, '读不到配置：文件里有的会话当作在场');
});

test('她发语音的那一行（桥接用 at 记时间，不是 time）：照样投影成她自己的一行；两样都没有的丢掉', () => {
  const key = `private:${rid('u')}`;
  const voice = { messageId: rid('m'), sender: '我', text: '[语音 3 秒]', plain: '[语音 3 秒]', quoteTargetIsSelf: false, isOwner: true, ownerLabel: '我', isSelf: true, at: T0 + 5 };
  const m = projectMessage(voice);
  assert.equal(m.time, T0 + 5);
  assert.equal(m.isSelf, true);
  assert.equal(projectMessage({ ...voice, at: undefined }), null);
  assert.equal(projectMessage({ ...voice, time: T0 + 9 }).time, T0 + 9, 'time 优先');
  const s = mkSalt();
  const o = toObservation(m, { key, kind: 'private', settingId: opaqueFrom(s, 'qq/setting', key), salt: s, selfNames: [], known: new Map(), now: T0 + 10 }, { attention: 'attended' });
  assert.ok(validateObservation(o).ok);
  assert.equal(o.kind, 'self-utterance');
  assert.equal(o.at, T0 + 5);
});

test('dsh-qq 1.1.2 的撤回记录不是她说的话（kind: recall → 不入库）', () => {
  assert.equal(toObservation({ messageId: null, sender: '我', text: '[已撤回一条消息]', plain: '[已撤回一条消息]', kind: 'recall', isSelf: true, isOwner: true, media: [], hasMedia: false, forwardIds: [], hasForward: false, time: 1 }, { settingId: 's', kind: 'group', selfNames: [], known: new Map() }, {}), null);
});
