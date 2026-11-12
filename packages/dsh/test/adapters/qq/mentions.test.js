// QQ 的 @名字（D108，实测问题 #17）：她的账号不再换成「我」（「@我」被认成了一个叫「我」的人）；「@名字」先按这个会话里认得的账号反查——
// 正好一个账号、是她 → 她；是别人 → 那个账号（主人另带主人的声明）；对不上 → 只有名字；不到 2 个字的 @ 不算；她自己那几行带上她的群名片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObservation, opaqueFrom } from 'rugu-core/contract';
import { projectMessage } from '../../../src/adapters/qq/files.js';
import { toObservation, knownNames, atNames, selfCardOf } from '../../../src/adapters/qq/messages.js';
import { rid, salt as mkSalt, inMsg } from '../helpers.js';

const T0 = Date.UTC(2026, 10, 5, 3, 0, 0);
const ok = (o) => { const r = validateObservation(o); assert.ok(r.ok, JSON.stringify(r.errors)); return r.value; };

function ctxFor(key, msgs, { owner, me } = {}) {
  const s = mkSalt();
  const kind = key.startsWith('group:') ? 'group' : 'private';
  const list = [...msgs];
  return {
    key, kind, settingId: opaqueFrom(s, 'qq/setting', key), salt: s, selfNames: ['小雪'], now: T0 + 5000,
    known: knownNames(list, { kind, principalLabel: '主人', ownerId: owner, selfId: me, selfNames: ['小雪'] }),
    selfAccount: me, ownerAccount: owner, selfCard: kind === 'group' ? selfCardOf(list) : '',
  };
}

test('atNames：不到 2 个字的 @ 不算（「@我」不是在点谁的名）', () => {
  assert.deepEqual(atNames('@我 你好 @阿明 @某人 @全体成员'), ['阿明']);
});

test('她的账号换成她现在的群名片（没有就第一个名字），不再是「我」；主人的换成他现在的群名片', () => {
  const owner = rid('u');
  const me = rid('u');
  const g = `group:${rid('g')}`;
  const msgs = [inMsg({ seq: 1, userId: owner, sender: '老周', text: '在吗', time: T0, isOwner: true }),
    { sender: '星野小满', text: '在', plain: '在', isSelf: true, isOwner: true, time: T0 + 1 }];
  const k = knownNames(msgs, { kind: 'group', principalLabel: '主人', ownerId: owner, selfId: me, selfNames: ['小雪'] });
  assert.equal(k.get(me), '星野小满');
  assert.equal(k.get(owner), '老周');
  const k2 = knownNames([], { kind: 'group', principalLabel: '主人', ownerId: owner, selfId: me, selfNames: ['小雪'] });
  assert.equal(k2.get(me), '小雪');
  assert.equal(k2.get(owner), '主人');
});

test('「@名字」按账号反查：她 → self；主人 → 账号 + 主人的声明；认不出的 → 只有名字；她自己的行带群名片', () => {
  const owner = rid('u');
  const me = rid('u');
  const pal = rid('u');
  const g = `group:${rid('g')}`;
  const msgs = [
    inMsg({ seq: 1, userId: owner, sender: '老周', text: '在吗', time: T0, isOwner: true }),
    inMsg({ seq: 2, userId: pal, sender: '阿明', text: '我也在', time: T0 + 1 }),
    { sender: '星野小满', text: '在', plain: '在', isSelf: true, isOwner: true, time: T0 + 2 },
  ];
  const ctx = ctxFor(g, msgs, { owner, me });
  const m = inMsg({ seq: 3, userId: owner, sender: '老周', text: '@星野小满 陪我玩 @老周 @阿明 @路人甲 7', time: T0 + 3, isOwner: true });
  const o = ok(toObservation(projectMessage(m), ctx, { attention: 'attended' }));
  assert.equal(o.addressed, 'mentions-her', '她的群名片也算叫她');
  const kinds = o.mentions.map((x) => (x.self ? 'self' : x.actor?.claims?.[0]?.kind ?? x.claims?.[0]?.kind));
  assert.ok(kinds.includes('self'));
  const claims = o.mentions.filter((x) => !x.self).map((x) => (x.claims ?? []).map((c) => c.kind).join('+'));
  // D160：认出账号的同时带上这个名字（核心把它记成这个账号在这个场合的名字）
  assert.ok(claims.includes('account+display-name+principal'), JSON.stringify(o.mentions));
  assert.ok(claims.includes('account+display-name'), '阿明：账号 + 名字');
  assert.ok(claims.includes('display-name'), '路人甲：只有名字');
  assert.ok(!JSON.stringify(o.mentions).includes('"我"'));
  const mine = ok(toObservation(projectMessage(msgs[2]), ctx, { attention: 'attended' }));
  // D162：知道她的账号时，她自己的行也带上它（核心靠它把这个账号记成她的）
  assert.deepEqual(mine.actor.claims.map((c) => [c.kind, c.name ?? c.id]), [['account', me], ['display-name', '星野小满']]);
});
