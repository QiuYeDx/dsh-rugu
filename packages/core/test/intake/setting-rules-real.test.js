// 场合规矩跟着适配器的描述走（真模块 intake + discretion，§5.6「规矩是带来源的事实」、§9.3）：
// 公告里新出现的当场生效；公告里那条没了就撤下（只管之后才知道的）；没给 notes 不算撤下；主人在管理页写的不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCore } from '../fakes/test-core.js';
import { descriptor, makeAdapter, people, sid, ADAPTER, H } from './helpers.js';

test('真模块：公告撤下 → 规矩撤下（中间有一次描述没带 notes 也不漏）；主人写的、没给 notes 的描述都不动它', async () => {
  const { core, ports, cleanup } = await createTestCore({ name: 'intake-rules-real' });
  try {
    const mod = { claims: [...people.other.claims, { kind: 'role-in-setting', setting: sid('g'), role: '管理员', moderates: true }] };
    const g = descriptor('g', { norms: { notes: [{ text: '内部事务别外传', author: mod }, { text: '禁止广告', author: mod }] } });
    const adapter = makeAdapter({ g });
    core.adapters.set(adapter.id, adapter);
    core.mods.intake.registerAdapter(core, adapter);
    const describe = (d) => core.mods.intake.describe(core, ADAPTER, d);
    const key = core.keys.settingKey(ADAPTER, sid('g'));
    const texts = () => core.mods.discretion.settingRules(core, key).rules.map((r) => r.text).sort();
    describe(g);
    assert.deepEqual(texts(), ['内部事务别外传', '禁止广告'], '公告当场生效');
    core.mods.discretion.writeSettingRule(core, key, { text: '周报别外传', restriction: 'strict' }, { source: 'owner', authorEntityId: null, authority: 'principal', at: core.now() });
    ports.clock.advance(H);
    // 改了称呼、没带 notes：不知道公告怎样了，不撤
    describe(descriptor('g', { label: '改名后的群' }));
    assert.deepEqual(texts(), ['内部事务别外传', '周报别外传', '禁止广告']);
    ports.clock.advance(H);
    // 公告只剩一条：另一条撤下（和上一次没带 notes 的描述比不出来，按这次的完整清单才认得出）
    describe(descriptor('g', { label: '改名后的群', norms: { notes: [{ text: '禁止广告', author: mod }] } }));
    assert.deepEqual(texts(), ['周报别外传', '禁止广告']);
    // 公告全撤：主人在管理页写的照旧
    ports.clock.advance(H);
    describe(descriptor('g', { label: '改名后的群', norms: { notes: [] } }));
    assert.deepEqual(texts(), ['周报别外传']);
    // 又贴回来：新的一版，重新生效
    ports.clock.advance(H);
    describe(descriptor('g', { label: '改名后的群', norms: { notes: [{ text: '内部事务别外传', author: mod }] } }));
    assert.deepEqual(texts(), ['内部事务别外传', '周报别外传']);
  } finally { await cleanup(); }
});
