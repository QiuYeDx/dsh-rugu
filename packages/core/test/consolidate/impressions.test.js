// 分层印象（§5.2、§7.7 第 5 步）：从事实重新生成，两层分开，八卦只进被说的人名下；maybe_same 裁决（认得 ≠ 权利，永不自动 not_same）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, reply, T0, MIN, HOUR, DAY } from './world.js';
import { FakeLLM } from '../fakes/index.js';
import { impressionsBatch, entitiesNeedingImpressions, maybeSamePairs, layerEvidence } from '../../src/consolidate/impressions.js';
import { newRun } from '../../src/consolidate/util.js';

/** 阿明在群里自己说在玩某游戏；私聊里跟她说失恋了；群里有人说「小刚很抠」。 */
function people(w) {
  const G = w.setting({ label: '群', exposure: 1 });
  const D = w.setting({ label: '私聊', exposure: 0 });
  const ming = w.entity({ name: '阿明', closeness: 0.5 });
  const gang = w.entity({ name: '小刚' });
  const say = (s, who, text, at) => w.percept(s, { at, actor: who, text });
  const pub = w.fact({ subjects: [ming], text: '阿明在玩某游戏新版本', certainty: 'stated', recordedAt: T0,
    sources: [{ perceptId: say(G, ming, '我在玩某游戏新版本', T0), speaker: ming, asserter: ming, mode: 'overheard', at: T0 }] });
  const priv = w.fact({ subjects: [ming], text: '阿明最近失恋了', certainty: 'stated', recordedAt: T0 + HOUR,
    sources: [{ perceptId: say(D, ming, '我失恋了', T0 + HOUR), speaker: ming, asserter: ming, mode: 'told_to_her', at: T0 + HOUR }] },
  { norm: { restriction: 'strict' } });
  const gossip = w.fact({ subjects: [gang], text: '小刚很抠', certainty: 'hearsay', recordedAt: T0 + 2 * HOUR,
    sources: [{ perceptId: say(G, ming, '小刚很抠', T0 + 2 * HOUR), speaker: ming, asserter: ming, mode: 'overheard', hop: 1, at: T0 + 2 * HOUR }] });
  return { G, D, ming, gang, pub, priv, gossip };
}

test('两层分开：shared 只用本人当众说的、规范无限制的；private 是其余的；写 shared 的那次调用看不到私下的事实', async () => {
  const prompts = [];
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => {
    prompts.push({ system: req.system, text });
    return [...text.matchAll(/【(P\d+)】/g)].map((m) => ({ type: 'impression', entity: m[1], text: `${req.system.includes('私下') ? '私下' : '公开'}印象` }));
  }) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const x = people(w);
    const ev = layerEvidence(core, x.ming, { factsPerLayer: 30, at: T0 + DAY });
    assert.deepEqual(ev.shared.map((f) => f.ref), [x.pub.ref]);
    assert.deepEqual(ev.private.map((f) => f.ref), [x.priv.ref]);
    const r = await impressionsBatch(core, [x.ming], { run: newRun(2), at: T0 + DAY });
    assert.equal(r.written, 2);
    const shared = prompts.find((p) => !p.system.includes('私下'));
    assert.ok(shared.text.includes('某游戏新版本'));
    assert.ok(!shared.text.includes('失恋'), '私下的内容不可能混进大家都能看到的那层');
    assert.ok(!shared.text.includes('小刚'));
    const byLayer = Object.fromEntries(w.rec.writeImpression.map((x2) => [x2.layer, x2.imp]));
    assert.deepEqual(byLayer.shared.evidenceRefs, [x.pub.ref]);
    assert.deepEqual(byLayer.private.evidenceRefs, [x.priv.ref]);
    assert.equal(byLayer.shared.firstHand, 1);
    for (const p of prompts) assert.ok(!p.text.includes('上次的印象'), '不给旧印象');
  } finally { await w.cleanup(); }
});

test('八卦只进被说的人名下：「阿明说小刚很抠」进小刚的私下层（听说），阿明的印象里没有它（S9 的 consolidate 部分）', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(P\d+)】/g)].map((m) => ({ type: 'impression', entity: m[1], text: '印象' }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const x = people(w);
    await impressionsBatch(core, [x.ming, x.gang], { run: newRun(2), at: T0 + DAY });
    const mingRefs = w.rec.writeImpression.filter((i) => i.entityId === x.ming).flatMap((i) => i.imp.evidenceRefs);
    assert.ok(!mingRefs.includes(x.gossip.ref));
    const gang = w.rec.writeImpression.filter((i) => i.entityId === x.gang);
    assert.deepEqual(gang.map((g) => g.layer), ['private']);
    assert.deepEqual(gang[0].imp.evidenceRefs, [x.gossip.ref]);
    assert.equal(gang[0].imp.hearsay, 1);
    const priv = llm.calls.find((c) => c.system.includes('私下')).messages[0].content;
    assert.match(priv, /听阿明说/, '听说的标出来源，模型写成「听说……」');
  } finally { await w.cleanup(); }
});

test('哪些实体要重建：事实在上次生成之后变过的；她自己和场合不建；主人排前面', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(P\d+)】/g)].map((m) => ({ type: 'impression', entity: m[1], text: '印象' }))) } });
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const x = people(w);
    const owner = w.entity({ name: '主人', authority: 'principal', closeness: 1 });
    w.fact({ subjects: [owner], text: '主人在加班', recordedAt: T0 });
    w.fact({ subjects: [w.self], text: '我喜欢猫', certainty: 'self_said', recordedAt: T0 });
    w.fact({ subjects: [x.G.entityId], text: '这个群爱玩梗', recordedAt: T0 });
    assert.deepEqual(entitiesNeedingImpressions(core), [owner, x.ming, x.gang]);
    clock.set(T0 + DAY);
    await impressionsBatch(core, [owner, x.ming, x.gang], { run: newRun(2), at: T0 + DAY });
    assert.deepEqual(entitiesNeedingImpressions(core), []);
    w.fact({ subjects: [x.ming], text: '阿明换了工作', recordedAt: T0 + 2 * DAY, updatedAt: T0 + 2 * DAY });
    assert.deepEqual(entitiesNeedingImpressions(core), [x.ming]);
  } finally { await w.cleanup(); }
});

test('证据全被隐藏：写一个空版本，旧的印象文字不再当成现在的', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(P\d+)】/g)].map((m) => ({ type: 'impression', entity: m[1], text: '印象' }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const x = people(w);
    await impressionsBatch(core, [x.ming], { run: newRun(2), at: T0 + DAY });
    w.hidden.add(x.priv.ref);
    const r = await impressionsBatch(core, [x.ming], { run: newRun(2), at: T0 + 2 * DAY });
    assert.equal(r.cleared, 1);
    const cur = core.store.get("SELECT text FROM entity_impressions WHERE entity_id = ? AND layer = 'private' AND is_current = 1", x.ming);
    assert.equal(cur.text, '');
  } finally { await w.cleanup(); }
});

test('maybe_same：把握高且没有锚点冲突 → same（decided_by=sleep，只是认得）；中间地带进审核；不像的保持 maybe_same', async () => {
  const verdicts = { m1: ['same', 0.95], m2: ['same', 0.7], m3: ['different', 0.9], m4: ['same', 0.97] };
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => Object.entries(verdicts).filter(([m]) => text.includes(`[${m}]`))
    .map(([m, [v, c]]) => ({ type: 'same', pair: m, verdict: v, confidence: c }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const mk = (n) => w.entity({ name: n });
    const [a1, b1, a2, b2, a3, b3, a4, b4] = ['小刚', '刚子', '小林', '林林', '老王', '王哥', '表哥甲', '表哥乙'].map(mk);
    const ming = mk('阿明');
    const hong = mk('小红');
    // 两个不同锚点的表哥：锚点冲突
    core.store.run(`INSERT INTO entity_descriptors(entity_id, anchor_entity_id, relation, text, first_at, last_at, created_at)
        VALUES (?, ?, '表哥', '表哥', 0, 0, 0), (?, ?, '表哥', '表哥', 0, 0, 0)`, a4, ming, b4, hong);
    const pairs = [[a1, b1], [a2, b2], [a3, b3], [a4, b4]];
    let at = T0;
    for (const [x, y] of pairs) {
      at -= MIN;
      core.store.run("INSERT INTO entity_links(a, b, rel, confidence, decided_by, at, created_at) VALUES (?, ?, 'maybe_same', 0.6, 'extractor', ?, ?)", Math.min(x, y), Math.max(x, y), at, at);
    }
    const ps = maybeSamePairs(core, { limit: 6, at: T0 });
    assert.equal(ps.length, 4);
    const r = await impressionsBatch(core, [], { run: newRun(2), at: T0, pairs: ps });
    assert.equal(r.linked, 1);
    assert.equal(r.queued, 2, '中间地带一条 + 锚点冲突一条');
    const rel = (x, y) => ({ ...core.store.get('SELECT rel, decided_by FROM entity_links WHERE a = ? AND b = ?', Math.min(x, y), Math.max(x, y)) });
    assert.deepEqual(rel(a1, b1), { rel: 'same', decided_by: 'sleep' });
    assert.equal(rel(a2, b2).rel, 'maybe_same');
    assert.equal(rel(a3, b3).rel, 'maybe_same', '永远不自动变 not_same');
    assert.equal(rel(a4, b4).rel, 'maybe_same', '锚点冲突不自动合并');
    assert.deepEqual(w.rec.enqueueReview.map((x) => x.kind), ['merge', 'merge']);
    // 刚问过的、已经在审的不再问
    assert.equal(maybeSamePairs(core, { limit: 6, at: T0 + HOUR }).length, 0);
  } finally { await w.cleanup(); }
});

test('到了 LLM 上限：一层都不写，不抛错', async () => {
  const w = await world({ llm: new FakeLLM() });
  try {
    const { core } = w;
    const x = people(w);
    const r = await impressionsBatch(core, [x.ming], { run: { calls: 2, max: 2 }, at: T0 + DAY });
    assert.equal(r.written, 0);
    assert.equal(r.skipped, 'llm-cap');
    // 单独调用（管理页「重新生成」）
    w.llm.fallback.sleep = reply((req, text) => [...text.matchAll(/【(P\d+)】/g)].map((m) => ({ type: 'impression', entity: m[1], text: '印象' })));
    await core.mods.consolidate.regenerateImpressions(core, x.ming);
    assert.equal(w.rec.writeImpression.length, 2);
  } finally { await w.cleanup(); }
});

test('印象写好之后有事实被隐藏：这个人要重新生成；重新看过之后不再每晚重复（即使 entities 因为内容没变不新建版本）', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(P\d+)】/g)].map((m) => ({ type: 'impression', entity: m[1], text: '印象' }))) } });
  // entities 内容和证据都没变时不新建版本（built_at 不动）：替身照这个契约写
  const w = await world({ llm, mods: { entities: { writeImpression: (c, id, layer, imp) => {
    const cur = c.store.get('SELECT id, text, evidence_ids_json FROM entity_impressions WHERE entity_id = ? AND layer = ? AND is_current = 1', id, layer);
    if (cur && cur.text === imp.text && cur.evidence_ids_json === JSON.stringify(imp.evidenceRefs)) return cur.id;
    c.store.run('UPDATE entity_impressions SET is_current = 0 WHERE entity_id = ? AND layer = ? AND is_current = 1', id, layer);
    return Number(c.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, evidence_ids_json, first_hand, hearsay, version, is_current, built_at)
        VALUES (?, ?, ?, ?, 0, 0, 1, 1, ?)`, id, layer, imp.text, JSON.stringify(imp.evidenceRefs), imp.at).lastInsertRowid);
  } } } });
  try {
    const { core } = w;
    const x = people(w);
    await impressionsBatch(core, [x.ming, x.gang], { run: newRun(2), at: T0 + DAY });
    assert.deepEqual(entitiesNeedingImpressions(core), []);
    // 一条没进印象证据的旧事实被隐藏（印象文字不会变）：也要重新看一次，看过就不再重复
    const old = w.fact({ subjects: [x.ming], text: '很早的事', recordedAt: T0 - 400 * DAY, updatedAt: T0 - 400 * DAY });
    w.hidden.add(old.ref);
    core.store.run("INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES ('assertion', ?, 'hidden', 'owner', ?)", old.id, T0 + 2 * DAY);
    assert.deepEqual(entitiesNeedingImpressions(core), [x.ming]);
    await impressionsBatch(core, [x.ming], { run: newRun(2), at: T0 + 3 * DAY });
    assert.deepEqual(entitiesNeedingImpressions(core), [], '重新看过了，即使没有新版本');
  } finally { await w.cleanup(); }
});
