// ensureSelf / ensurePrincipal / registerAdapterClaims / resolveActor / ensureSettingEntity：身份证据和确定性认人。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, acct, DAY, T0 } from './helpers.js';

const NS = 'zq';   // 测试用的命名空间（随便取的）

test('ensureSelf / ensurePrincipal：唯一、可重复调用；主人 closeness=1、authority=principal；称呼是保留名', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'own' });
  try {
    const E = core.mods.entities;
    const self = E.ensureSelf(core);
    assert.equal(E.ensureSelf(core), self);
    const p = E.ensurePrincipal(core);
    assert.equal(E.ensurePrincipal(core), p);
    assert.notEqual(self, p);
    assert.deepEqual(E.bondOf(core, p), { closeness: 1, authority: 'principal', isSelf: false });
    assert.equal(E.bondOf(core, self).isSelf, true);
    assert.equal(E.bondOf(core, self).authority, 'none', '她自己没有管理权限，不会被当成主人');
    assert.deepEqual(E.principals(core), [p]);
    const prof = E.profile(core, p);
    assert.equal(prof.displayName, '主人');   // FakeSelfProfile 的默认称呼
    const reserved = core.store.get('SELECT reserved FROM entity_names WHERE entity_id = ? AND text_raw = ?', p, '主人');
    assert.equal(reserved.reserved, 1);
    assert.equal(prof.status, 'established');
  } finally { await cleanup(); }
});

test('registerAdapterClaims：账号只存哈希；她的 / 主人的账号挂到对应档案；幂等', async () => {
  const { core, cleanup, ports } = await entitiesCore({ name: 'claims' });
  try {
    const E = core.mods.entities;
    const her = { kind: 'account', namespace: NS, id: 'uh8x2k', verifiedBy: 'platform', displayName: '小星' };
    const boss = { kind: 'account', namespace: NS, id: 'up3m9q', verifiedBy: 'config' };
    E.registerAdapterClaims(core, NS, { selfClaims: [her], principalClaims: [boss, { kind: 'principal', strength: 'config' }] });
    E.registerAdapterClaims(core, NS, { selfClaims: [her], principalClaims: [boss] });
    const rows = core.store.all('SELECT entity_id, namespace, id_hash, strength FROM identity_evidence ORDER BY id');
    assert.equal(rows.length, 2, '幂等：重复注册不多出证据');
    const dump = JSON.stringify(core.store.all('SELECT * FROM identity_evidence')) + JSON.stringify(core.store.all('SELECT * FROM entity_names'));
    assert.ok(!dump.includes('uh8x2k') && !dump.includes('up3m9q'), '账号原值不进库');
    const self = E.ensureSelf(core);
    const p = E.ensurePrincipal(core);
    assert.equal(rows[0].entity_id, self);
    assert.equal(rows[1].entity_id, p);
    assert.equal(rows[1].strength, 'config', '主人的账号 strength=config');
    // 认说话人：她自己的账号、主人的账号
    const ctx = { adapterId: NS, settingKey: 'S1', at: T0 };
    assert.deepEqual(E.resolveActor(core, { claims: [{ ...her }] }, ctx), { entityId: self, isSelf: true, isPrincipal: false, via: 'identity' });
    assert.deepEqual(E.resolveActor(core, { claims: [{ ...boss, verifiedBy: 'platform' }] }, ctx), { entityId: p, isSelf: false, isPrincipal: true, via: 'identity' });
    assert.equal(E.resolveActor(core, { self: true, claims: [] }, ctx).via, 'self');
    assert.equal(E.resolveActor(core, { claims: [{ kind: 'principal', strength: 'config' }] }, ctx).entityId, p);
    // 她的名字是保留名
    const n = core.store.get("SELECT reserved FROM entity_names WHERE entity_id = ? AND text_raw = '小星'", self);
    assert.equal(n.reserved, 1);
    ports.logger.assertNoText('uh8x2k', 'up3m9q');
  } finally { await cleanup(); }
});

test('registerAdapterClaims：之前按普通账号建过档案的主人账号，改挂到主人，旧档案链接成同一个人（owner）', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'claims-late' });
  try {
    const E = core.mods.entities;
    const boss = { kind: 'account', namespace: NS, id: 'up3m9q', verifiedBy: 'platform' };
    const ctx = { adapterId: NS, settingKey: 'S1', at: T0 };
    const before = E.resolveActor(core, { claims: [boss] }, ctx).entityId;
    const p = E.ensurePrincipal(core);
    assert.notEqual(before, p);
    E.registerAdapterClaims(core, NS, { selfClaims: [], principalClaims: [boss] });
    assert.equal(E.resolveActor(core, { claims: [boss] }, ctx).entityId, p);
    assert.equal(E.rightsHolder(core, before, p), true, '配置是主人亲手写的：权利层的 same');
  } finally { await cleanup(); }
});

test('resolveActor：同命名空间同作用域同 id → 同一个人；不同 id → 不同的人（显示名一样也不合并）', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'actor-id' });
  try {
    const E = core.mods.entities;
    const ctx = { adapterId: NS, settingKey: 'S1', at: T0 };
    const a = E.resolveActor(core, acct(NS, 'ua1b2c3', { displayName: '阿明' }), ctx);
    assert.equal(a.via, 'identity');
    assert.equal(E.profile(core, a.entityId).status, 'provisional', '新账号先是 provisional');
    const again = E.resolveActor(core, acct(NS, 'ua1b2c3'), { ...ctx, at: T0 + 60_000 });
    assert.equal(again.entityId, a.entityId);
    const other = E.resolveActor(core, acct(NS, 'uz9y8x7', { displayName: '阿明' }), ctx);
    assert.notEqual(other.entityId, a.entityId, '同名不同账号：不同的人');
    // 作用域不同的同一个 id（按应用分配的 openid）是不同的证据
    const scoped = E.resolveActor(core, acct(NS, 'ua1b2c3', { scope: 'app-x' }), ctx);
    assert.notEqual(scoped.entityId, a.entityId);
    // 第二天又出现：established
    E.resolveActor(core, acct(NS, 'ua1b2c3'), { ...ctx, at: T0 + DAY });
    assert.equal(E.profile(core, a.entityId).status, 'established');
    // 名字证据记了 count / last
    const n = core.store.get("SELECT count, last FROM entity_names WHERE entity_id = ? AND text_raw = '阿明'", a.entityId);
    assert.equal(n.count, 1);
    assert.equal(E.profile(core, a.entityId).displayName, '阿明');
  } finally { await cleanup(); }
});

test('resolveActor：只有显示名的说话人，在本场合里按名片认；名片冒用保留名无效', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'actor-name' });
  try {
    const E = core.mods.entities;
    const p = E.ensurePrincipal(core);
    const ctx = { adapterId: NS, settingKey: 'S1', at: T0 };
    const card = (name) => ({ claims: [{ kind: 'display-name', name, observedAt: T0 }] });
    const x = E.resolveActor(core, card('路人甲'), ctx);
    assert.equal(x.via, 'scoped-name');
    assert.equal(E.resolveActor(core, card('路人甲'), ctx).entityId, x.entityId, '同一个场合的同一张名片 → 同一个人');
    const y = E.resolveActor(core, card('路人甲'), { ...ctx, settingKey: 'S2' });
    assert.notEqual(y.entityId, x.entityId, '名片只在本场合有效');
    // 冒用主人的称呼：不会认成主人
    const fake = E.resolveActor(core, card('主人'), ctx);
    assert.notEqual(fake.entityId, p);
    assert.equal(fake.isPrincipal, false);
    // 带账号冒用：新档案，名字记成 spoof，不当显示名、不进匹配器
    const fake2 = E.resolveActor(core, acct(NS, 'uq7w6e5', { displayName: '主人' }), ctx);
    assert.notEqual(fake2.entityId, p);
    assert.equal(E.profile(core, fake2.entityId).displayName, null);
    const spoof = core.store.get('SELECT spoof FROM entity_names WHERE entity_id = ?', fake2.entityId);
    assert.equal(spoof.spoof, 1);
    const hits = E.nameMatcher(core).scan('主人今天来了吗', { settingKey: 'S1' });
    assert.deepEqual(hits.map((h) => h.entityId), [p], '名字匹配器只认主人的保留名，不认冒用的名片');
    // 没有任何 claim → 不认
    assert.equal(E.resolveActor(core, { claims: [] }, ctx).entityId, null);
  } finally { await cleanup(); }
});

test('resolveActor：同一个 ActorRef 里的两个账号已经分属两个档案 → 平台说是同一个人', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'actor-two' });
  try {
    const E = core.mods.entities;
    const ctx = { adapterId: NS, settingKey: 'S1', at: T0 };
    const a = E.resolveActor(core, acct(NS, 'uo1'), ctx).entityId;
    const b = E.resolveActor(core, acct(NS, 'uo2'), ctx).entityId;
    const both = { claims: [...acct(NS, 'uo1').claims, ...acct(NS, 'uo2').claims] };
    const r = E.resolveActor(core, both, ctx);
    assert.ok([a, b].includes(r.entityId));
    assert.equal(E.belief(core, a, b).rel, 'same');
  } finally { await cleanup(); }
});

test('ensureSettingEntity：一个场合一个 kind=setting 的档案，不是具体的个人；称呼变了换显示名', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'setting' });
  try {
    const E = core.mods.entities;
    const id = E.ensureSettingEntity(core, 'SK1', { label: '游戏群', at: T0 });
    assert.equal(E.ensureSettingEntity(core, 'SK1', { label: '游戏群', at: T0 }), id);
    const prof = E.profile(core, id);
    assert.equal(prof.kind, 'setting');
    assert.equal(E.isIndividual(core, id), false);
    E.ensureSettingEntity(core, 'SK1', { label: '新游戏群', at: T0 + 1 });
    assert.equal(E.profile(core, id).displayName, '新游戏群');
    assert.notEqual(E.ensureSettingEntity(core, 'SK2', { label: '工作群', at: T0 }), id);
    assert.ok(rec.embeds.get(`n${id}`).chunks[0].text.includes('新游戏群'), '档案文本进嵌入队列');
  } finally { await cleanup(); }
});
