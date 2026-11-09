// link / belief / rightsHolder：认得 ≠ 权利；maybe_same 永远不自动变 not_same；身份对应的链接带 B3 规范。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, person, T0 } from './helpers.js';

test('link：a、b 顺序无关；低一级的决定不推翻高一级的；maybe_same 永远不被自动变成 not_same', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'link-rank' });
  try {
    const E = core.mods.entities;
    const a = person(core, 'zq', 'u1', T0);
    const b = person(core, 'zq', 'u2', T0);
    // 只有一边有账号也能链（不是身份对应）
    const id = E.link(core, b, a, { rel: 'maybe_same', confidence: 0.6, evidence: ['p1'], decidedBy: 'extractor', at: T0 });
    assert.equal(E.link(core, a, b, { rel: 'maybe_same', confidence: 0.7, evidence: ['p2'], decidedBy: 'extractor', at: T0 + 1 }), id);
    const row = () => core.store.get('SELECT * FROM entity_links WHERE id = ?', id);
    assert.ok(row().a < row().b);
    assert.deepEqual(JSON.parse(row().evidence_json), ['p1', 'p2']);
    // 夜间整理说 not_same：保持 maybe_same（只并证据）
    E.link(core, a, b, { rel: 'not_same', confidence: 0.9, evidence: ['p3'], decidedBy: 'sleep', at: T0 + 2 });
    assert.equal(row().rel, 'maybe_same');
    E.link(core, a, b, { rel: 'not_same', confidence: 0.9, evidence: [], decidedBy: 'extractor', at: T0 + 3 });
    assert.equal(row().rel, 'maybe_same');
    // 主人可以判 not_same
    E.link(core, a, b, { rel: 'not_same', confidence: 1, evidence: [], decidedBy: 'owner', at: T0 + 4 });
    assert.equal(row().rel, 'not_same');
    assert.deepEqual(E.belief(core, a, b), { rel: 'not_same', confidence: 1 });
    // 主人的决定之后，提炼再说 maybe_same 也推翻不了
    E.link(core, a, b, { rel: 'maybe_same', confidence: 0.8, evidence: [], decidedBy: 'extractor', at: T0 + 5 });
    assert.equal(row().rel, 'not_same');
    assert.throws(() => E.link(core, a, a, { rel: 'same', confidence: 1, evidence: [], decidedBy: 'owner', at: T0 }), TypeError);
    assert.throws(() => E.link(core, a, 99999, { rel: 'same', confidence: 1, evidence: [], decidedBy: 'owner', at: T0 }), TypeError);
    assert.throws(() => E.link(core, a, b, { rel: 'same', confidence: 1, evidence: [], decidedBy: 'whoever', at: T0 }), TypeError);
  } finally { await cleanup(); }
});

test('认得 ≠ 权利：只有 decided_by ∈ {platform, mutual-claim, anchor-confirmed, owner} 的 same 才给权利；沿权利链可传递', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'link-rights' });
  try {
    const E = core.mods.entities;
    const [a, b, c, d] = ['u1', 'u2', 'u3', 'u4'].map((u) => person(core, 'zq', u, T0));
    for (const decidedBy of ['extractor', 'sleep']) {
      E.link(core, a, b, { rel: 'same', confidence: 0.99, evidence: [], decidedBy, at: T0 });
      assert.equal(E.belief(core, a, b).rel, 'same', '心里认得');
      assert.equal(E.rightsHolder(core, a, b), false, `${decidedBy} 的 same 不给权利`);
    }
    E.link(core, a, b, { rel: 'maybe_same', confidence: 0.6, evidence: [], decidedBy: 'owner', at: T0 });
    assert.equal(E.rightsHolder(core, a, b), false, 'maybe_same 不给权利');
    for (const decidedBy of ['platform', 'mutual-claim', 'anchor-confirmed', 'owner']) {
      const x = person(core, 'zq', `ux-${decidedBy}`, T0);
      E.link(core, c, x, { rel: 'same', confidence: 1, evidence: [], decidedBy, at: T0 });
      assert.equal(E.rightsHolder(core, x, c), true, decidedBy);
    }
    E.link(core, c, d, { rel: 'same', confidence: 1, evidence: [], decidedBy: 'owner', at: T0 });
    const x = core.store.get("SELECT b AS id FROM entity_links WHERE a = ? AND decided_by = 'platform'", c)?.id
      ?? core.store.get("SELECT a AS id FROM entity_links WHERE b = ? AND decided_by = 'platform'", c).id;
    assert.equal(E.rightsHolder(core, x, d), true, '权利链可传递');
    assert.equal(E.rightsHolder(core, a, a), true);
    assert.equal(E.rightsHolder(core, a, d), false);
  } finally { await cleanup(); }
});

test('belief：沿 same / maybe_same 找；经过 maybe_same 的是 maybe_same；not_same 不走', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'link-belief' });
  try {
    const E = core.mods.entities;
    const [a, b, c, d] = ['u1', 'u2', 'u3', 'u4'].map((u) => person(core, 'zq', u, T0));
    E.link(core, a, b, { rel: 'same', confidence: 1, evidence: [], decidedBy: 'owner', at: T0 });
    E.link(core, b, c, { rel: 'maybe_same', confidence: 0.6, evidence: [], decidedBy: 'extractor', at: T0 });
    E.link(core, c, d, { rel: 'not_same', confidence: 1, evidence: [], decidedBy: 'owner', at: T0 });
    assert.deepEqual(E.belief(core, a, c), { rel: 'maybe_same', confidence: 0.6 });
    assert.equal(E.belief(core, a, d), null);
    assert.deepEqual(E.belief(core, a, a), { rel: 'same', confidence: 1 });
    assert.equal(E.belief(core, a, 0), null);
  } finally { await cleanup(); }
});

test('身份对应（两边都有账号、跨命名空间）：链接写 B3 规范（identityLink），只写一次；权利层确认后当事人记进「谁知道」', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'link-b3' });
  try {
    const E = core.mods.entities;
    const qa = person(core, 'nsa', 'u1', T0);
    const qb = person(core, 'nsb', 'v1', T0);
    const noAcct = E.resolveExtracted(core, [{ local: 'E1', name: '某人', kind: 'person', descriptor: null, msgRefs: [] }],
      { speakers: new Map(), settingKey: 'G', at: T0, jobId: 1 }).get('E1');
    const id = E.link(core, qa, qb, { rel: 'maybe_same', confidence: 0.6, evidence: ['self-introduction'], decidedBy: 'extractor', at: T0 });
    assert.equal(core.store.get('SELECT cross_namespace FROM entity_links WHERE id = ?', id).cross_namespace, 1);
    const norms = rec.norms.filter((n) => n.ref === `l${id}`);
    assert.equal(norms.length, 1);
    assert.equal(norms[0].norm.identityLink, true);
    assert.equal(norms[0].norm.involvesOthers, true);
    assert.equal(rec.knowledge.length, 0, '提炼的猜测：只有她自己知道');
    E.link(core, qa, qb, { rel: 'same', confidence: 1, evidence: ['p9'], decidedBy: 'mutual-claim', at: T0 + 1 });
    assert.equal(rec.norms.filter((n) => n.ref === `l${id}`).length, 1, '规范只写一次（discretion 的表里已经有了）');
    const k = rec.knowledge.find((x) => x.ref === `l${id}`);
    assert.deepEqual(k.entries.map((e) => [e.whoKind, e.whoRef, e.basis]), [['entity', String(Math.min(qa, qb)), 'subject'], ['entity', String(Math.max(qa, qb)), 'subject']]);
    // 一边没有账号：不是身份对应，不写规范
    const id2 = E.link(core, qa, noAcct, { rel: 'maybe_same', confidence: 0.6, evidence: [], decidedBy: 'extractor', at: T0 });
    assert.equal(rec.norms.some((n) => n.ref === `l${id2}`), false);
    // writeNorm 失败：链接整条不写（隐私底线比可用性重要）
    const { core: c2, cleanup: cl2 } = await entitiesCore({ name: 'link-b3-fail', mods: { discretion: { writeNorm: () => { throw new Error('down'); } } } });
    try {
      const x = person(c2, 'nsa', 'u1', T0);
      const y = person(c2, 'nsb', 'v1', T0);
      assert.throws(() => c2.mods.entities.link(c2, x, y, { rel: 'maybe_same', confidence: 0.6, evidence: [], decidedBy: 'extractor', at: T0 }));
      assert.equal(c2.store.get('SELECT COUNT(*) AS n FROM entity_links').n, 0);
    } finally { await cl2(); }
  } finally { await cleanup(); }
});
