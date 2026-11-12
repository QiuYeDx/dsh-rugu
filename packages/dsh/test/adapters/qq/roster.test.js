// 群成员名单（D160）：桥接只存渲染后的「@<群名片或昵称>」，适配器从 SnowLuma 的缓存库被动地读 group_members，才认得出「@」点的是谁——
// 包括从没在这里说过话的人和她自己（真的桥接把她的行写成「我」，她在平台上的名字只有名单里有）。
//   - 读名单：表结构核对、对不上就当没有（群名照读）、读坏了留着已经知道的、文件变了才重读、状态里只有数字；
//   - 「@名字你好」（没有空格）切出认得的名字；从没说过话的人 → 账号 + 名字；「@她在平台上的名字」→ 她，带着这个名字；
//     她自己的行带上这个名字；两个人同名 → 只有名字；没有名单 → 照旧。
// 账号、群号运行时随机生成；名字都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateObservation, opaqueFrom } from 'rugu-core/contract';
import { createPlatformNames } from '../../../src/adapters/qq/names.js';
import { projectMessage } from '../../../src/adapters/qq/files.js';
import { toObservation, knownNames, atNames, selfCardOf } from '../../../src/adapters/qq/messages.js';
import { createQqBridgeAdapter } from '../../../src/adapters/qq-bridge.js';
import { rid, randomDigits, salt as mkSalt, inMsg, selfMsg, fakeTimers, fakeFs, fakeSink, fakeLog, socialFile } from '../helpers.js';

const T0 = Date.UTC(2026, 10, 12, 3, 0, 0);
const ok = (o) => { const r = validateObservation(o); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };
const MEMBER_COLS = ['id', 'group_id', 'uid', 'uin', 'nickname', 'card', 'role', 'level', 'title', 'join_time', 'last_sent_time', 'shut_up_time', 'is_robot', 'active', 'updated_at'];
const GROUP_COLS = ['group_id', 'group_name', 'remark', 'member_count', 'updated_at'];

/** 假的只读库：按 SQL 里的表名回 PRAGMA 列和行；group_id、uin 是整数（和 SnowLuma 一样）。 */
function fakeDb(st) {
  return () => {
    if (st.broken) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    st.opens = (st.opens ?? 0) + 1;
    const table = (sql) => (/group_members/.test(sql) ? 'members' : 'groups');
    return {
      prepare(sql) {
        return {
          all() {
            const t = table(sql);
            if (sql.startsWith('PRAGMA')) return (t === 'members' ? st.memberCols : st.groupCols).map((name) => ({ name }));
            return t === 'members' ? st.members : st.groups;
          },
        };
      },
      close() {},
    };
  };
}
function namesOver(st, t = { now: 0 }) {
  return createPlatformNames({
    dir: () => 'X:/sl', now: () => t.now, minIntervalMs: 0, memberIntervalMs: st.memberInterval ?? 0, listDirs: () => ['bot'],
    stat: () => ({ size: 1, mtimeMs: st.mtime ?? 1 }), openDb: fakeDb(st),
  });
}

test('名单：读到群成员（名字 = 群名片，没有就昵称），状态里只有数字；表结构不认识就当没有名单，群名照读', () => {
  const g = Number(randomDigits());
  const [a, b, me] = [Number(randomDigits()), Number(randomDigits()), Number(randomDigits())];
  const st = {
    groupCols: GROUP_COLS, memberCols: MEMBER_COLS,
    groups: [{ group_id: g, group_name: '编的群名', remark: '', member_count: 3, updated_at: 1 }],
    members: [
      { group_id: g, uin: a, nickname: '昵称甲', card: '群名片甲', updated_at: 1 },
      { group_id: g, uin: b, nickname: '昵称乙', card: '', updated_at: 1 },
      { group_id: g, uin: me, nickname: '小满同学', card: '', updated_at: 1 },
    ],
  };
  const n = namesOver(st);
  const m = n.members(String(g));
  assert.deepEqual([m.get(String(a)), m.get(String(b)), m.get(String(me))], ['群名片甲', '昵称乙', '小满同学']);
  assert.equal(n.members('424242').size, 0);
  const s = n.status();
  assert.deepEqual([s.ok, s.groups, s.members, s.membersOk], [true, 1, 3, true]);
  const dump = JSON.stringify(s);
  assert.ok(![String(a), String(g), '群名片甲'].some((x) => dump.includes(x)), '状态里没有账号、群号和名字');

  const odd = { ...st, memberCols: ['gid', 'who', 'name'] };
  const n2 = namesOver(odd);
  assert.equal(n2.members(String(g)).size, 0);
  assert.equal(n2.group(String(g)).name, '编的群名', '名单对不上不影响群名');
  assert.deepEqual([n2.status().membersOk, n2.status().membersReason, n2.status().members], [false, 'schema', 0]);
});

test('名单：文件变了才重读；读坏了（被占用）留着已经知道的；没配置就清空', () => {
  const g = randomDigits();
  const a = randomDigits();
  const st = {
    groupCols: GROUP_COLS, memberCols: MEMBER_COLS, mtime: 1, groups: [],
    members: [{ group_id: Number(g), uin: Number(a), nickname: '旧昵称', card: '', updated_at: 1 }],
  };
  const t = { now: 0 };
  const n = namesOver(st, t);
  assert.equal(n.members(g).get(a), '旧昵称');
  const opens = st.opens;
  st.members = [{ group_id: Number(g), uin: Number(a), nickname: '新昵称', card: '', updated_at: 2 }];
  t.now += 1;
  assert.equal(n.members(g).get(a), '旧昵称', '文件没变：不重读');
  assert.equal(st.opens, opens);
  st.mtime = 2;
  t.now += 1;
  assert.equal(n.members(g).get(a), '新昵称', '文件变了：重读');
  st.broken = true;
  st.mtime = 3;
  t.now += 1;
  assert.equal(n.members(g).get(a), '新昵称', '读不出来：留着已经知道的');
  assert.equal(n.status().membersReason, 'unreadable');
  st.broken = false;
  t.now += 1;
  assert.equal(n.status().membersOk, true, '被占用的过一会儿再试');
  let dir = 'X:/sl';
  const off = createPlatformNames({ dir: () => dir, now: () => 0, minIntervalMs: 0, listDirs: () => ['bot'], stat: () => ({ size: 1, mtimeMs: 1 }), openDb: fakeDb(st) });
  assert.equal(off.members(g).size, 1);
  dir = null;
  assert.equal(off.members(g).size, 0);
  assert.equal(off.status().membersReason, 'off');
});

test('名单：库文件一直在变（成员行随消息更新）时最快 memberIntervalMs 重读一次，群名照常跟着文件变', () => {
  const g = randomDigits();
  const a = randomDigits();
  const st = {
    groupCols: GROUP_COLS, memberCols: MEMBER_COLS, mtime: 1, memberInterval: 60_000,
    groups: [{ group_id: Number(g), group_name: '旧群名', remark: '', member_count: 2, updated_at: 1 }],
    members: [{ group_id: Number(g), uin: Number(a), nickname: '旧昵称', card: '', updated_at: 1 }],
  };
  const t = { now: 0 };
  const n = namesOver(st, t);
  assert.equal(n.members(g).get(a), '旧昵称');
  st.groups = [{ group_id: Number(g), group_name: '新群名', remark: '', member_count: 2, updated_at: 2 }];
  st.members = [{ group_id: Number(g), uin: Number(a), nickname: '新昵称', card: '', updated_at: 2 }];
  st.mtime = 2;
  t.now = 1000;
  assert.equal(n.group(g).name, '新群名');
  assert.equal(n.members(g).get(a), '旧昵称', '还没到重读名单的时候');
  st.mtime = 3;
  t.now = 61_000;
  assert.equal(n.members(g).get(a), '新昵称');
});

// ── 「@」的映射 ──
function groupCtx({ roster, msgs = [], me, owner, selfNames = ['小雪'] } = {}) {
  const s = mkSalt();
  const key = `group:${rid('g')}`;
  const list = [...msgs];
  const selfCard = (me && roster?.get(me)) || selfCardOf(list);
  return {
    key, kind: 'group', settingId: opaqueFrom(s, 'qq/setting', key), salt: s, selfNames, now: T0 + 5000,
    known: knownNames(list, { kind: 'group', principalLabel: '主人', ownerId: owner, selfId: me, selfNames, selfCard, roster }),
    selfAccount: me, ownerAccount: owner, selfCard, roster, principalLabel: '主人',
  };
}
const said = (ctx, userId, text, sender = '路过的人') => ok(toObservation(projectMessage(inMsg({ seq: 9, userId, sender, text, time: T0 + 9 })), ctx, { attention: 'attended' }));
const shape = (x) => (x.self ? `self:${x.claims.map((c) => c.name).join(',')}` : x.claims.map((c) => (c.kind === 'display-name' ? `name:${c.name}` : c.kind)).join('+'));

test('从没在这里说过话的人：按名单认出账号，带上名字；「@名字你好」没有空格也切得出认得的名字', () => {
  const [me, quiet, talker] = [rid('u'), rid('u'), rid('u')];
  const roster = new Map([[me, '小满同学'], [quiet, '阿明'], [talker, '路过的人']]);
  const ctx = groupCtx({ roster, me });
  const o = said(ctx, talker, '@阿明你好呀 @不认识的人 看看');
  assert.deepEqual(o.mentions.map(shape), ['account+name:阿明', 'name:不认识的人']);
  assert.equal(o.mentions[0].claims[0].id, quiet);
  assert.deepEqual(atNames('@阿明你好', ['阿明', '阿明白']), ['阿明']);
  assert.deepEqual(atNames('@阿明白了吗', ['阿明', '阿明白']), ['阿明白'], '最长的认得的名字');
  assert.deepEqual(atNames('@阿明你好'), ['阿明你好'], '不认得：照旧取到空白为止');
});

test('「@她在平台上的名字」→ 她，带着这个名字；她自己的行（桥接写成「我」）带上这个名字；点她配置里的名字不带', () => {
  const [me, talker] = [rid('u'), rid('u')];
  const roster = new Map([[me, '小满同学'], [talker, '路过的人']]);
  const ctx = groupCtx({ roster, me });
  const o = said(ctx, talker, '@小满同学在吗');
  assert.equal(o.addressed, 'mentions-her');
  assert.deepEqual(o.mentions.map(shape), ['self:小满同学']);
  assert.equal(o.mentions[0].claims[0].scope, ctx.settingId);
  assert.deepEqual(said(ctx, talker, '@小雪 在吗').mentions.map(shape), ['self:'], '配置里的名字已经在 selfClaims 里了');
  const mine = ok(toObservation(projectMessage(selfMsg('在的', T0 + 10)), ctx, { attention: 'attended' }));
  assert.deepEqual(mine.actor.claims.map((c) => [c.kind, c.name, c.scope]), [['display-name', '小满同学', ctx.settingId]]);
  // 她的账号出现在文字里（「@<她的账号>」）换成的也是这个名字
  assert.equal(ctx.known.get(me), '小满同学');
});

test('两个人同名 → 只有名字；没有名单 → 照旧（她的行不带名字，从没说过话的人只有名字）', () => {
  const [me, a, b, talker] = [rid('u'), rid('u'), rid('u'), rid('u')];
  const twins = groupCtx({ roster: new Map([[a, '阿明'], [b, '阿明'], [talker, '路过的人']]), me });
  assert.deepEqual(said(twins, talker, '@阿明 吃了吗').mentions.map(shape), ['name:阿明']);

  const bare = groupCtx({ me, msgs: [] });
  assert.deepEqual(said(bare, talker, '@阿明你好').mentions.map(shape), ['name:阿明你好'], '没有名单：照旧');
  const mine = ok(toObservation(projectMessage(selfMsg('在的', T0 + 10)), bare, { attention: 'attended' }));
  assert.deepEqual(mine.actor.claims, []);
});

test('主人：认出账号带主人的声明；顶替用的称呼不当他的名字记', () => {
  const [me, owner, talker] = [rid('u'), rid('u'), rid('u')];
  const withCard = groupCtx({ roster: new Map([[owner, '老周'], [talker, '路过的人']]), me, owner });
  assert.deepEqual(said(withCard, talker, '@老周 来').mentions.map(shape), ['account+name:老周+principal']);
  const noCard = groupCtx({ me, owner });
  assert.deepEqual(said(noCard, talker, '@主人 来').mentions.map(shape), ['account+principal']);
});

test('QQ 适配器：群里按平台名单认「@」；她的行（真的桥接写「我」）带上她在平台上的名字；名单不给账号以外的东西出去', () => {
  const timers = fakeTimers();
  const ffs = fakeFs(timers);
  const bridgeDir = path.join('X:', 'fake-bridge');
  const state = path.join(bridgeDir, 'state');
  const ids = { owner: rid('u'), me: rid('u'), quiet: rid('u'), talker: rid('u'), g: rid('g') };
  const K = `group:${ids.g}`;
  ffs.write(path.join(bridgeDir, 'config.json'), { ownerQQ: ids.owner, allow: { groups: [ids.g] }, socialV2: { agentPreset: 'qq-chat-v2' } }, { events: false });
  ffs.write(path.join(state, 'mode.json'), { mode: 'reserved2' }, { events: false });
  ffs.write(path.join(state, 'sessions.json'), { sessions: {} }, { events: false });
  const roster = new Map([[ids.me, '小满同学'], [ids.quiet, '阿明'], [ids.talker, '路过的人']]);
  const s = mkSalt();
  const adapter = createQqBridgeAdapter({
    paths: { bridgeDir }, salt: s, readFile: ffs.readFile, stat: ffs.stat, watch: ffs.watch, timers, now: timers.now, log: fakeLog(),
    config: { selfAccount: ids.me, selfNames: ['小雪'] },
    platformNames: {
      group: () => null,
      members: (id) => (id === ids.g ? new Map(roster) : new Map()),
      status: () => ({ ok: true, groups: 1, members: roster.size, reason: null }),
    },
  });
  const sink = fakeSink();
  const now = timers.now();
  ffs.write(path.join(state, 'social-v2.json'), socialFile({
    [K]: { recent: [
      inMsg({ seq: 1, userId: ids.talker, sender: '路过的人', text: `@小满同学在吗 @阿明你也来 @${ids.me}`, time: now - 1000 }),
      selfMsg('在的', now - 500),
    ] },
  }), { events: false });
  adapter.start(sink);
  timers.advance(300);
  const obs = sink.batches.flatMap((b) => b.o);
  const heard = obs.find((o) => o.kind === 'utterance');
  assert.ok(heard, '收到了那句话');
  assert.ok(!heard.text.includes(ids.me), '她的账号不进文字');
  assert.equal(heard.addressed, 'mentions-her');
  assert.deepEqual(heard.mentions.map(shape), ['self:小满同学', 'account+name:阿明']);
  const mine = obs.find((o) => o.kind === 'self-utterance');
  assert.deepEqual(mine.actor.claims.map((c) => [c.kind, c.name]), [['display-name', '小满同学']]);
  const pn = adapter.selfCheck().find((c) => c.id === 'platform-names');
  assert.ok(!pn.label.includes('阿明') && !pn.label.includes(ids.quiet), '自检里没有名字和账号');
});
