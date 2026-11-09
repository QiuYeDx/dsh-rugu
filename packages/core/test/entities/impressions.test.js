// writeImpression / impressionSources：分层印象存储；八卦只进被说的人名下；shared 只用本人当众说的和大家看到的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, person, fact, T0 } from './helpers.js';

const NS = 'zq';

test('writeImpression：新版本 is_current=1、旧版本留作历史；规范继承证据（inheritNorm）；登记嵌入、提交后删旧版本的嵌入', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'imp-write' });
  try {
    const E = core.mods.entities;
    const a = person(core, NS, 'u1', T0, '阿明');
    const i1 = E.writeImpression(core, a, 'shared', { text: '爱玩梗，在玩某游戏', evidenceRefs: ['a1', 'a2', 'bogus'], firstHand: 2, hearsay: 0, at: T0 });
    assert.deepEqual(rec.inherits.at(-1), { ref: `i${i1}`, evidence: ['a1', 'a2'], ctx: { derivation: 'quote', at: T0 } });
    assert.ok(rec.embeds.get(`i${i1}`).chunks[0].text.includes('爱玩梗'));
    assert.ok(rec.embeds.get(`i${i1}`).chunks[0].text.includes('阿明'), '嵌入文本带上是谁的印象');
    assert.equal(rec.embeds.get(`i${i1}`).opt.layer, 'memory');
    // 内容和证据都没变：不新建版本
    assert.equal(E.writeImpression(core, a, 'shared', { text: '爱玩梗，在玩某游戏', evidenceRefs: ['a1', 'a2'], firstHand: 2, hearsay: 0, at: T0 + 1 }), i1);
    const i2 = E.writeImpression(core, a, 'shared', { text: '爱玩梗，最近改玩另一个游戏', evidenceRefs: ['a3'], firstHand: 1, hearsay: 0, at: T0 + 2 });
    assert.notEqual(i2, i1);
    const rows = core.store.all('SELECT id, version, is_current FROM entity_impressions WHERE entity_id = ? ORDER BY version', a);
    assert.deepEqual(rows.map((r) => [r.version, r.is_current]), [[1, 0], [2, 1]]);
    assert.ok(rec.drops.includes(`i${i1}`), '旧版本的嵌入删掉');
    const priv = E.writeImpression(core, a, 'private', { text: '最近心情不太好', evidenceRefs: ['a4'], firstHand: 0, hearsay: 1, at: T0, derivation: 'inference' });
    assert.equal(rec.inherits.at(-1).ctx.derivation, 'inference');
    assert.deepEqual(E.profile(core, a).impressions.map((x) => [x.layer, x.id]), [['private', priv], ['shared', i2]]);
    assert.throws(() => E.writeImpression(core, a, 'public', { text: 'x', evidenceRefs: [], firstHand: 0, hearsay: 0, at: T0 }), TypeError);
    assert.throws(() => E.writeImpression(core, a, 'shared', { text: '  ', evidenceRefs: [], firstHand: 0, hearsay: 0, at: T0 }), TypeError);
    // 规范写不了：整条不写
    const { core: c2, cleanup: cl2 } = await entitiesCore({ name: 'imp-fail', mods: { discretion: { inheritNorm: () => { throw new Error('down'); } } } });
    try {
      const x = person(c2, NS, 'u1', T0);
      assert.throws(() => c2.mods.entities.writeImpression(c2, x, 'shared', { text: '某印象', evidenceRefs: [], firstHand: 0, hearsay: 0, at: T0 }));
      assert.equal(c2.store.get('SELECT COUNT(*) AS n FROM entity_impressions').n, 0);
    } finally { await cl2(); }
  } finally { await cleanup(); }
});

test('impressionSources：主体是他的才算；本人当众说的进 shared，一对一的、听说的、推断的进 private；被取代的、隐藏的不算', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'imp-src' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'u1', T0, '阿明');
    const wang = person(core, NS, 'u2', T0, '老王');
    rec.snapshots.set(11, { id: 11, exposureRank: 1 });   // 封闭群
    rec.snapshots.set(12, { id: 12, exposureRank: 0 });   // 一对一
    const inGroup = (actor) => percept(core, { actor, at: T0, snapshotId: 11, visibleTo: 'setting-audience' });
    const inPrivate = (actor) => percept(core, { actor, at: T0, snapshotId: 12, visibleTo: 'participants' });
    const f1 = fact(core, { subject: aming, speaker: aming, perceptId: inGroup(aming), text: '我在玩某游戏' });
    const f2 = fact(core, { subject: aming, speaker: aming, perceptId: inPrivate(aming), text: '我最近失眠' });
    const f3 = fact(core, { subject: aming, speaker: wang, perceptId: inGroup(wang), text: '阿明很懒' });
    const f4 = fact(core, { subject: aming, speaker: null, asserter: null, mode: 'inferred', text: '阿明可能心情不好' });
    const f5 = fact(core, { subject: aming, speaker: aming, perceptId: inGroup(aming), text: '旧的说法', superseded: 999 });
    const f6 = fact(core, { subject: aming, speaker: aming, perceptId: inGroup(aming), text: '被隐藏的' });
    rec.suppressed.add(`a${f6}`);
    const g = fact(core, { subject: wang, speaker: aming, perceptId: inGroup(aming), text: '老王很抠' });   // 阿明说别人
    const s = E.impressionSources(core, aming);
    assert.deepEqual(s.shared.map((x) => x.ref), [`a${f1}`]);
    assert.deepEqual(s.private.map((x) => x.ref).sort(), [`a${f2}`, `a${f3}`, `a${f4}`].sort());
    assert.ok(!JSON.stringify(s).includes(`a${g}`), '他说别人的话不算他的');
    assert.ok(!JSON.stringify(s).includes(`a${f5}`) && !JSON.stringify(s).includes(`a${f6}`));
    assert.deepEqual(s.counts, { shared: { firstHand: 1, hearsay: 0 }, private: { firstHand: 1, hearsay: 1, inferred: 1 } });
    const w = E.impressionSources(core, wang);
    assert.deepEqual(w.private.map((x) => [x.ref, x.hearsay]), [[`a${g}`, true]], '「阿明说老王很抠」进老王的听说');
    // 快照读不到 → 不当众（宁严）
    rec.snapshots.delete(11);
    assert.equal(E.impressionSources(core, aming).shared.length, 0);
    assert.deepEqual(E.impressionSources(core, 99999).shared, []);
  } finally { await cleanup(); }
});
