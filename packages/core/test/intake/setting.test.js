// 场合（§4.3 SettingDescriptor、§5.3 快照、§5.6 场合规矩、§5.8 场合实体）和 D3 的 SettingId → 场合键。
import test from 'node:test';
import assert from 'node:assert/strict';
import { exposureRank } from '../../src/contract/setting.js';
import { readMetrics } from '../../src/store/kv.js';
import {
  withIntake, ingest, obs, descriptor, oneOnOne, people, sid, makeAdapter, ADAPTER, PRINCIPAL_ID, T0, M,
} from './helpers.js';

const snaps = (t, name) => t.core.store.all('SELECT * FROM setting_snapshots WHERE setting_key = ? ORDER BY id', t.key(name));

test('describe：存场合和快照；SettingId、parent、账号都换成键 / 哈希，只有称呼可读', () => withIntake((t) => {
  const d = descriptor('g', {
    parent: sid('parent'),
    ownership: { owner: people.friend, herRole: '普通成员' },
    norms: { register: '轻松', notes: [{ text: '群里不聊工作', author: people.friend }] },
    purpose: '朋友闲聊',
  });
  t.describe(d);
  const s = t.core.mods.intake.settingByKey(t.core, t.key('g'));
  assert.equal(s.key, t.key('g'));
  assert.equal(s.adapter, ADAPTER);
  assert.equal(s.label, '场合-g');
  assert.equal(s.parentKey, t.core.keys.settingKey(ADAPTER, sid('parent')));
  assert.equal(s.attending, true);
  assert.equal(s.exposureRank, exposureRank(d));
  assert.equal(s.persistenceRank, 1);
  assert.equal(s.descriptor.id, t.key('g'));
  assert.equal(s.descriptor.ownership.owner.claims[0].idHash, t.core.keys.identityHash(ADAPTER, undefined, 'ufriend001'));
  const blob = JSON.stringify(t.core.store.all('SELECT * FROM settings')) + JSON.stringify(t.core.store.all('SELECT * FROM setting_snapshots'));
  for (const raw of [sid('g'), sid('parent'), 'ufriend001']) assert.ok(!blob.includes(raw), `库里出现了原值 ${raw.slice(0, 8)}`);
  const snap = t.core.mods.intake.snapshotById(t.core, s.snapshotId);
  assert.equal(snap.settingKey, t.key('g'));
  assert.equal(snap.audienceSize, 8);
  assert.equal(snap.descriptor.purpose, '朋友闲聊');
}, { settings: {} }));

test('描述没变不新建快照；变了才存新快照，感知指向当时的快照', () => withIntake((t) => {
  t.describe(descriptor('g'));
  t.describe(descriptor('g'));
  assert.equal(snaps(t, 'g').length, 1);
  ingest(t, [obs('g', 'friend', '变之前')]);
  t.clock.advance(M);
  t.describe(descriptor('g', {
    audience: { size: 'unbounded', entry: 'open', unknownObservers: true, membersKnown: 'unknown' },
    disclosure: { visibleTo: 'anyone', persistence: 'public-permanent', searchable: true },
  }));
  assert.equal(snaps(t, 'g').length, 2);
  ingest(t, [obs('g', 'friend', '变之后', { at: T0 + M })]);
  const [a, b] = t.rows();
  assert.notEqual(a.snapshot_id, b.snapshot_id);
  assert.equal(t.core.mods.intake.snapshotById(t.core, a.snapshot_id).exposureRank, 1);
  assert.equal(t.core.mods.intake.snapshotById(t.core, b.snapshot_id).exposureRank, 3);
  assert.equal(t.core.mods.intake.settingByKey(t.core, t.key('g')).exposureRank, 3);
  assert.equal(t.core.mods.intake.snapshotById(t.core, 99999), null);
  assert.equal(t.core.mods.intake.settingByKey(t.core, 'nope'), null);
}, { settings: {} }));

test('§5.8：稳定的场合建 kind=setting 的实体，一次性的不建；称呼变了再告诉 entities', () => withIntake((t) => {
  t.describe(descriptor('g'));
  t.describe(descriptor('once', { stability: 'transient' }));
  const calls = t.calls['entities.ensureSettingEntity'];
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], t.key('g'));
  assert.equal(calls[0][1].label, '场合-g');
  const s = t.core.mods.intake.settingByKey(t.core, t.key('g'));
  assert.ok(s.entityId > 0);
  assert.equal(t.core.mods.intake.settingByKey(t.core, t.key('once')).entityId, null);
  t.describe(descriptor('g', { capabilities: { canHold: true } }));
  assert.equal(t.calls['entities.ensureSettingEntity'].length, 1);   // 称呼没变
  t.describe(descriptor('g', { label: '新名字' }));
  assert.equal(t.calls['entities.ensureSettingEntity'].length, 2);
}, { settings: {} }));

test('norms.notes：新出现的规矩当场交给 discretion.writeSettingRule；作者权限按 role-in-setting / 主人 / 场合主人', () => withIntake((t) => {
  const mod = { claims: [...people.other.claims, { kind: 'role-in-setting', setting: sid('g'), role: '管理员', moderates: true }] };
  const elsewhere = { claims: [acctOnly('uxx'), { kind: 'role-in-setting', setting: sid('other-room'), role: '群主', isOwner: true }] };
  t.describe(descriptor('g', {
    ownership: { owner: people.stranger },
    norms: { notes: [
      { text: '群公告：内部事务别外传', author: mod },
      { text: '主人说：这里别聊私事', author: people.principal },
      { text: '路人说：都可以说', author: people.friend },
      { text: '别的群的群主说的', author: elsewhere },
      { text: '群主说：禁止广告', author: people.stranger },
      { text: '没有署名的规矩' },
    ] },
  }));
  const rules = t.calls['discretion.writeSettingRule'].map(([key, rule, ctx]) => ({ key, text: rule.text, ...ctx }));
  assert.equal(rules.length, 6);
  for (const r of rules) {
    assert.equal(r.key, t.key('g'));
    assert.equal(r.source, 'adapter-notes');
  }
  const auth = Object.fromEntries(rules.map((r) => [r.text, r.authority]));
  assert.equal(auth['群公告：内部事务别外传'], 'moderator');
  assert.equal(auth['主人说：这里别聊私事'], 'principal');
  assert.equal(auth['路人说：都可以说'], 'none');
  assert.equal(auth['别的群的群主说的'], 'none');
  assert.equal(auth['群主说：禁止广告'], 'moderator');   // ownership.owner 认出是同一个人
  assert.equal(auth['没有署名的规矩'], 'none');
  assert.equal(rules.find((r) => r.text.startsWith('主人')).authorEntityId, PRINCIPAL_ID);
  // 再描述一次：没有新规矩就不再写；加了一条只写新的那条
  t.describe(descriptor('g', {
    ownership: { owner: people.stranger },
    norms: { notes: [{ text: '群公告：内部事务别外传', author: mod }, { text: '新公告', author: mod }] },
  }));
  const after = t.calls['discretion.writeSettingRule'].slice(6).map(([, rule]) => rule.text);
  assert.deepEqual(after, ['新公告']);
}, { settings: {} }));

test('norms.notes 里的一条没了（公告撤下）：按适配器这次给的完整清单交给 discretion.withdrawSettingRules（keep）；没给 notes 不算撤下', () => withIntake((t) => {
  const mod = { claims: [...people.other.claims, { kind: 'role-in-setting', setting: sid('g'), role: '管理员', moderates: true }] };
  const withdrawn = () => t.calls['discretion.withdrawSettingRules'] ?? [];
  t.describe(descriptor('g', { norms: { notes: [{ text: '内部事务别外传', author: mod }, { text: '禁止广告', author: mod }] } }));
  assert.equal(withdrawn().length, 1);
  const [key, q0] = withdrawn()[0];
  assert.equal(key, t.key('g'));
  assert.deepEqual(q0, { source: 'adapter-notes', keep: ['内部事务别外传', '禁止广告'] }, '给了 notes 就是完整清单：清单里的留着');
  // 描述变了（改了称呼）但没给 notes：不知道公告怎样了，不问
  t.describe(descriptor('g', { label: '改名后的群' }));
  assert.equal(withdrawn().length, 1, '没给 notes = 不知道，不是没了');
  // 中间那次没带 notes 之后：撤下一条、另一条换了作者（文字还在）——按这次的完整清单问，不靠和上一次描述比
  t.describe(descriptor('g', { norms: { notes: [{ text: '禁止广告', author: people.friend }] } }));
  assert.deepEqual(withdrawn().at(-1)[1], { source: 'adapter-notes', keep: ['禁止广告'] });
  // 全撤了（notes 是空数组）
  t.describe(descriptor('g', { norms: { notes: [] } }));
  assert.deepEqual(withdrawn().at(-1)[1], { source: 'adapter-notes', keep: [] });
}, { settings: {} }));

test('撤下规矩出错（discretion 抛错）：只记一笔，场合描述照常写下', () => withIntake((t) => {
  t.describe(descriptor('g', { label: '出错也照常', norms: { notes: [{ text: '禁止广告' }] } }));
  assert.equal((t.calls['discretion.withdrawSettingRules'] ?? []).length, 1);
  assert.equal(t.core.store.get('SELECT label FROM settings WHERE key = ?', t.key('g')).label, '出错也照常');
}, { settings: {}, throwOn: new Set(['discretion.withdrawSettingRules']) }));

function acctOnly(id) { return { kind: 'account', namespace: ADAPTER, id, verifiedBy: 'platform' }; }

test('场合实体上次没建成（entities 出错）：同样的描述再来一次时补上', () => {
  const throwOn = new Set(['entities.ensureSettingEntity']);
  return withIntake((t) => {
    t.describe(descriptor('g'));
    assert.equal(t.core.mods.intake.settingByKey(t.core, t.key('g')).entityId, null);
    assert.equal(snaps(t, 'g').length, 1);
    throwOn.clear();
    t.describe(descriptor('g'));
    assert.ok(t.core.mods.intake.settingByKey(t.core, t.key('g')).entityId > 0);
    assert.equal(snaps(t, 'g').length, 1);   // 描述没变，不新建快照
  }, { settings: {}, throwOn });
});

test('describe 不抛错：不合契约、没有适配器 id 的只计数', () => withIntake((t) => {
  assert.doesNotThrow(() => t.describe({ id: sid('x'), label: '' }));
  assert.doesNotThrow(() => t.core.mods.intake.describe(t.core, 'nobody', descriptor('y')));
  assert.doesNotThrow(() => t.core.mods.intake.describe(t.core, ADAPTER, /** @type {any} */ (null)));
  assert.equal(t.core.store.get('SELECT COUNT(*) AS n FROM settings').n, 0);
  const m = readMetrics(t.core.store).map((r) => r.name);
  assert.ok(m.includes('intake.describe.rejected') && m.includes('intake.describe.noAdapter'));
}, { settings: {} }));

test('D3：resolveSetting 按每个已注册的适配器算键；两个适配器有同一个 SettingId → null（fail closed）', () => withIntake((t) => {
  const { intake } = t.core.mods;
  t.describe(descriptor('g'));
  assert.deepEqual(intake.resolveSetting(t.core, sid('g')), { key: t.key('g'), adapter: ADAPTER });
  assert.equal(intake.resolveSetting(t.core, sid('never')), null);
  assert.equal(intake.resolveSetting(t.core, /** @type {any} */ (42)), null);
  // 第二个适配器描述了同一个 SettingId
  const b = makeAdapter({}, { id: 'tfake2' });
  t.core.adapters.set(b.id, b);
  const stopB = intake.registerAdapter(t.core, b);
  intake.describe(t.core, b.id, descriptor('g'));
  assert.equal(intake.resolveSetting(t.core, sid('g')), null);
  assert.ok(t.core.log.events('intake.setting.collision').length >= 1);
  t.core.log.assertNoText(sid('g'));
  // 第二个适配器注销以后，又只剩一个
  stopB();
  t.core.adapters.delete(b.id);
  assert.deepEqual(intake.resolveSetting(t.core, sid('g')), { key: t.key('g'), adapter: ADAPTER });
}, { settings: {} }));

test('sealBuffers 只记检查点（最新的感知 id），不切断情节；也接受场合键；不抛错', () => withIntake((t) => {
  const { intake } = t.core.mods;
  ingest(t, [obs('g', 'friend', '一'), obs('g', 'friend', '二')]);
  intake.sealBuffers(t.core, sid('g'));
  const last = t.rows().at(-1).id;
  assert.equal(intake.settingByKey(t.core, t.key('g')).checkpointPercept, last);
  assert.ok(t.rows().every((p) => p.episode_id === null));
  ingest(t, [obs('g', 'friend', '三')]);
  intake.sealBuffers(t.core, t.key('g'));
  assert.equal(intake.settingByKey(t.core, t.key('g')).checkpointPercept, t.rows().at(-1).id);
  assert.doesNotThrow(() => intake.sealBuffers(t.core, sid('unknown')));
  assert.doesNotThrow(() => intake.sealBuffers(t.core, /** @type {any} */ (null)));
}));

test('registerAdapter：claims 交给 entities；start(sink) 的 observe / describe 自动带适配器 id；注销后 sink 失效', () => withIntake((t) => {
  const a = makeAdapter({ g: descriptor('g') }, { selfClaims: () => [...people.her.claims, { kind: 'bogus' }] });
  t.core.adapters.set(a.id, a);
  const stop = t.core.mods.intake.registerAdapter(t.core, a);
  const [adapterId, claims] = t.calls['entities.registerAdapterClaims'][0];
  assert.equal(adapterId, a.id);
  assert.equal(claims.selfClaims.length, 1);   // 不合契约的 claim 丢掉
  assert.equal(claims.principalClaims[0].verifiedBy, 'config');
  a.sink.describe(descriptor('g'));
  a.sink.observe([obs('g', 'friend', '经 sink 来的')], { cursor: { key: 'x', value: '1' } });
  t.drain();
  assert.equal(t.rows().length, 1);
  assert.equal(a.sink.cursor('x'), '1');
  const sink = a.sink;
  stop();
  assert.equal(a.stopped, true);
  sink.observe([obs('g', 'friend', '注销以后')]);
  t.drain();
  assert.equal(t.rows().length, 1);
  assert.equal(sink.cursor('x'), null);
}, { register: false }));

test('registerAdapter：entities 出错时抛出（api 据此不留下半注册的适配器）', () => withIntake((t) => {
  const a = makeAdapter({});
  t.core.adapters.set(a.id, a);
  assert.throws(() => t.core.mods.intake.registerAdapter(t.core, a));
  assert.equal(a.sink, null);
}, { register: false, throwOn: new Set(['entities.registerAdapterClaims']) }));

test('一对一场合（size 2 + participants）的快照：exposureRank 0', () => withIntake((t) => {
  t.describe(oneOnOne('dm'));
  assert.equal(t.core.mods.intake.settingByKey(t.core, t.key('dm')).exposureRank, 0);
}, { settings: {} }));
