// entities 和别的模块的接线（阶段 B 交付说明里的请求）：
//   - 用户词典交给语言分析器：名字表变了排一次，启动和第一次建匹配器时也补一次（§8.2、D51）；
//   - 双向自认 / 锚点确认把一对定成同一个人之后，撤掉还在等主人批的 merge 审核（§5.2「审核队列只放低把握的」）；
//   - 名字匹配器一次扫描只批量读一次激活（dynamics.baseActivations）；
//   - 入库时没认出来的说话人：按 ctx.actorCodes 认出这一行是他说的（第一人称的关系描述、自称）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, person, DAY, T0 } from './helpers.js';
import * as admin from '../../src/admin/index.js';

const NS = 'zq';
const tick = () => new Promise((r) => setImmediate(r));

test('用户词典：重启后名字表没变，启动（ensurePrincipal）时也交一次；同一个进程里不重复交；只读模式在第一次建匹配器时交', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'wiring-dict' });
  try {
    const E = core.mods.entities;
    E.ensurePrincipal(core);
    person(core, NS, 'ua1', T0, '阿明');
    await tick();
    const before = rec.dictionaries.length;
    assert.ok(before >= 1 && rec.dictionaries.at(-1).includes('阿明'));
    // 重启：内存状态重建，名字表没变（不会有 namesChanged）
    E.dispose(core); E.init(core);
    E.ensurePrincipal(core);
    await tick();
    assert.equal(rec.dictionaries.length, before + 1, '启动时补交一次');
    assert.ok(rec.dictionaries.at(-1).includes('阿明'));
    E.nameMatcher(core).scan('阿明');
    E.ensurePrincipal(core);
    await tick();
    assert.equal(rec.dictionaries.length, before + 1, '交过了就不再交（名字表再变由 namesChanged 排）');
    person(core, NS, 'ub1', T0, '老王');
    await tick();
    assert.equal(rec.dictionaries.length, before + 2);
    assert.ok(rec.dictionaries.at(-1).includes('老王'));
    // 只读模式不跑启动步骤：第一次建匹配器时交
    E.dispose(core); E.init(core);
    assert.equal(E.nameMatcher(core).scan('老王').length, 1);
    await tick();
    assert.equal(rec.dictionaries.length, before + 3);
  } finally { await cleanup(); }
});

test('用户词典：语言分析器不可用时不抛错，下次（建匹配器、启动）再试', async () => {
  let fail = true;
  const { core, cleanup, rec } = await entitiesCore({
    name: 'wiring-dict-fail',
    mods: { lang: { registry: () => { if (fail) throw new Error('lang down'); return { setUserDictionary: (w) => { rec.dictionaries.push(w); } }; } } },
  });
  try {
    const E = core.mods.entities;
    person(core, NS, 'ua1', T0, '阿明');
    await tick();
    assert.equal(rec.dictionaries.length, 0);
    fail = false;
    E.ensurePrincipal(core);
    await tick();
    assert.equal(rec.dictionaries.length, 1, '没交成功的，启动步骤里再交');
  } finally { await cleanup(); }
});

/** 一个提炼批次（说话人表 + 每条消息是谁说的）。 */
function batch(core, { settingKey = 'G1', at, speakers, lines, actorCodes }) {
  const msgRefs = new Map();
  const codes = new Map();
  lines.forEach(([ref, actor, code], i) => {
    const pid = percept(core, { settingKey, actor, at: at + i * 1000 });
    msgRefs.set(ref, pid);
    if (code) codes.set(pid, code);
  });
  return { speakers: new Map(Object.entries(speakers)), settingKey, at, jobId: 1, msgRefs, ...(actorCodes === false ? {} : { actorCodes: codes }) };
}

test('双向自认定下同一个人：还在等主人批的 merge 审核撤掉（经 admin.withdrawReviews）；主人自己的决定不在这里撤', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'wiring-withdraw' });
  try {
    const E = core.mods.entities;
    const a = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'na', id: 'u1aa', verifiedBy: 'platform', displayName: 'yyy' }] }, { adapterId: 'na', settingKey: 'SA', at: T0 }).entityId;
    const b = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'nb', id: 'u2bb', verifiedBy: 'platform', displayName: 'xxx' }] }, { adapterId: 'nb', settingKey: 'SB', at: T0 }).entityId;
    const say = (who, settingKey, at, name) => E.resolveExtracted(core, [{ local: 'E1', name, kind: 'person', speaker: 'U1', descriptor: null, msgRefs: ['m1'] }],
      batch(core, { settingKey, at, speakers: { U1: who }, lines: [['m1', who]] }));
    say(a, 'SA', T0 + DAY, 'xxx');
    const pair = { a: Math.min(a, b), b: Math.max(a, b) };
    assert.deepEqual(rec.reviews.map((r) => [r.kind, r.payload]), [['merge', pair]], '单方面的跨平台自称：主人可以直接批准');
    assert.equal(rec.withdrawn.length, 0);
    say(b, 'SB', T0 + 2 * DAY, 'yyy');
    assert.equal(E.rightsHolder(core, a, b), true);
    assert.deepEqual(rec.withdrawn.map((w) => [w.q, w.ctx.reason, w.n]), [[{ kind: 'merge', match: pair }, 'decided-by-mutual-claim', 1]], '双方互认：不用再问主人');
    assert.equal(rec.reviews.length, 0);
    // 已经是权利层的 same：再说一遍不重复撤
    say(b, 'SB', T0 + 3 * DAY, 'yyy');
    assert.equal(rec.withdrawn.length, 1);
    // 主人在管理页批准 / 驳回（admin.decideReview 调 link，decidedBy='owner'）：由 admin 自己结案
    const x = person(core, NS, 'ux1', T0, 'p1');
    const y = person(core, 'nc', 'uy1', T0, 'p2');
    E.link(core, x, y, { rel: 'same', confidence: 1, evidence: ['review'], decidedBy: 'owner', at: T0 + 4 * DAY });
    assert.equal(rec.withdrawn.length, 1);
  } finally { await cleanup(); }
});

test('权利层可传递：b–c 双向自认把 {a, b} 和 {c} 并成一个人时，等着主人批的 (a, c) 也撤掉；信念层的链接、已经是权利层的不撤', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'wiring-withdraw-groups' });
  try {
    const E = core.mods.entities;
    const a = person(core, 'na', 'u1aa', T0, 'p1');
    const b = person(core, 'nb', 'u2bb', T0, 'p2');
    const c = person(core, 'nc', 'u3cc', T0, 'p3');
    const d = person(core, 'nd', 'u4dd', T0, 'p4');
    const pair = (x, y) => ({ a: Math.min(x, y), b: Math.max(x, y) });
    E.link(core, a, b, { rel: 'same', confidence: 0.95, evidence: ['actor-claims'], decidedBy: 'platform', at: T0 });
    for (const p of [pair(a, c), pair(b, d)]) core.mods.admin.enqueueReview(core, { kind: 'merge', payload: p, reason: 'cross-namespace-self-claim' });
    const hits = () => rec.withdrawn.filter((w) => w.n > 0).map((w) => [w.q.match, w.ctx.reason]);
    // 只是「可能是」：不撤
    E.link(core, b, c, { rel: 'maybe_same', confidence: 0.6, evidence: ['x'], decidedBy: 'extractor', at: T0 + DAY });
    assert.deepEqual(hits(), []);
    E.link(core, b, c, { rel: 'same', confidence: 0.95, evidence: ['x'], decidedBy: 'mutual-claim', at: T0 + 2 * DAY });
    assert.equal(E.rightsHolder(core, a, c), true);
    assert.deepEqual(hits(), [[pair(a, c), 'decided-by-mutual-claim']], '跨两组的每一对都有了答案');
    assert.deepEqual(rec.reviews.map((r) => r.payload), [pair(b, d)], '和 d 无关的那条还在等着');
    // 已经是权利层的 same：再链一次不再撤（也不再查组）
    const n = rec.withdrawn.length;
    E.link(core, b, c, { rel: 'same', confidence: 0.95, evidence: ['y'], decidedBy: 'mutual-claim', at: T0 + 3 * DAY });
    assert.equal(rec.withdrawn.length, n);
  } finally { await cleanup(); }
});

test('admin 还没有 withdrawReviews / 撤的时候出错：链接照样写上，不影响这一批', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'wiring-withdraw-fail', mods: { admin: { withdrawReviews: () => { throw new Error('boom'); } } } });
  try {
    const E = core.mods.entities;
    const a = person(core, 'na', 'u1aa', T0, 'yyy');
    const b = person(core, 'nb', 'u2bb', T0, 'xxx');
    E.link(core, a, b, { rel: 'same', confidence: 0.95, evidence: ['x'], decidedBy: 'mutual-claim', at: T0 });
    assert.equal(E.rightsHolder(core, a, b), true);
    assert.equal(core.store.get("SELECT SUM(value) AS v FROM metrics WHERE name = 'entities.review.withdrawError'")?.v ?? null, 1);
    assert.equal(rec.withdrawn.length, 0);
  } finally { await cleanup(); }
  const t2 = await entitiesCore({ name: 'wiring-withdraw-none', mods: { admin: { withdrawReviews: undefined } } });
  try {
    const E = t2.core.mods.entities;
    const a = person(t2.core, 'na', 'u1aa', T0, 'yyy');
    const b = person(t2.core, 'nb', 'u2bb', T0, 'xxx');
    E.link(t2.core, a, b, { rel: 'same', confidence: 0.95, evidence: ['x'], decidedBy: 'mutual-claim', at: T0 });
    assert.equal(E.rightsHolder(t2.core, a, b), true, 'admin 没有这个函数：什么都不撤，链接照写');
  } finally { await t2.cleanup(); }
});

test('名字匹配器：一次扫描只批量读一次激活，同名的按激活排；批量读不了退回逐个读，分数一样', async () => {
  const run = async (mods) => {
    const { core, cleanup, rec } = await entitiesCore({ name: 'wiring-act', mods });
    try {
      const E = core.mods.entities;
      const a1 = person(core, NS, 'ua1', T0, '阿明');
      const a2 = person(core, NS, 'ua2', T0, '阿明');
      const w = person(core, NS, 'uw1', T0, '老王');
      for (let i = 0; i < 3; i++) E.noteMention(core, a2, { at: T0 + i * DAY, w: 1, sourceKey: 'x' });
      const m = E.nameMatcher(core);
      const n0 = rec.activationBatches;
      const hits = m.scan('阿明和老王', { at: T0 + 5 * DAY });
      return { hits, batches: rec.activationBatches - n0, a1, a2, w };
    } finally { await cleanup(); }
  };
  const r1 = await run({});
  assert.equal(r1.batches, 1, '一次扫描只读一次');
  assert.deepEqual(r1.hits.map((h) => h.entityId), [r1.a2, r1.a1, r1.w], '被提得多的同名档案排前');
  assert.ok(r1.hits[0].score > r1.hits[1].score);
  const r2 = await run({ dynamics: { baseActivations: () => { throw new Error('no batch'); } } });
  assert.deepEqual(r2.hits.map((h) => [h.entityId, h.score]), r1.hits.map((h) => [h.entityId, h.score]));
});

test('入库时没认出来的说话人（U4 → null）：ctx.actorCodes 告诉 entities 这一行是他说的——「我表哥」是第一人称的描述，自我介绍算他本人的自称', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'wiring-actor-codes' });
  try {
    const E = core.mods.entities;
    const at = T0;
    const ctx = batch(core, { at, speakers: { U4: null }, lines: [['m1', null, 'U4'], ['m2', null, 'U4']] });
    // encode 把没认出来的说话人也作为一行交过来（排在最后）；另一行是他说的「我表哥」
    const r = E.resolveExtracted(core, [
      { local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U4', relation: '表哥' }, msgRefs: ['m1'] },
      { local: 'U4', name: '老王', kind: 'person', individual: true, descriptor: null, msgRefs: ['m1', 'm2'], verdict: { match: null, confidence: 0.5 } },
    ], ctx);
    const wang = r.get('U4');
    const cousin = r.get('E1');
    const d = E.profile(core, cousin).descriptors;
    assert.deepEqual(d.map((x) => [x.anchor, x.basis]), [[wang, 'first-person']], '锚点本人说的（不是旁人说的）');
    const usedBy = core.store.get("SELECT used_by FROM entity_names WHERE entity_id = ? AND text_raw = '小刚'", cousin).used_by;
    assert.equal(usedBy, wang, '知道是谁这样叫他');
    // 没有 actorCodes（旧的调用方）：不知道是谁说的，按旁人的说法记
    const ctx2 = batch(core, { at: at + DAY, speakers: { U4: null }, lines: [['m1', null, 'U4']], actorCodes: false });
    const r2 = E.resolveExtracted(core, [
      { local: 'E1', name: '小李', kind: 'person', descriptor: { anchor: 'U4', relation: '表妹' }, msgRefs: ['m1'] },
      { local: 'U4', name: '老张', kind: 'person', descriptor: null, msgRefs: ['m1'] },
    ], ctx2);
    assert.deepEqual(E.profile(core, r2.get('E1')).descriptors.map((x) => x.basis), ['third-party']);
  } finally { await cleanup(); }
});

test('"is" 的那一行（ExtractedEntity.speaker）是入库时没认出来的说话人：他自己说的 → 自称；锚点本人当面说的 → anchor-confirmed', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'wiring-is-unresolved' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const cousin = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming, 'U3']] })).get('E1');
    // 一个只有名片的新人（U2 → null）自称「我是阿明的表哥」，阿明接着说「对，他就是我表哥」
    const at = T0 + 3 * DAY;
    const ctx = batch(core, { at, speakers: { U2: null, U3: aming }, lines: [['m1', null, 'U2'], ['m2', aming, 'U3']] });
    const r = E.resolveExtracted(core, [
      { local: 'E1', name: null, kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] },
      { local: 'E2', name: null, kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m2'] },
      { local: 'U2', name: 'gx', kind: 'person', descriptor: null, msgRefs: ['m1'] },
    ], ctx);
    const s = r.get('U2');
    assert.equal(r.get('E1'), s);
    assert.equal(r.get('E2'), s);
    assert.deepEqual(E.profile(core, s).descriptors.map((d) => [d.anchor, d.basis]), [[aming, 'first-person']], '自称之后锚点本人确认了');
    assert.ok(core.store.get("SELECT 1 AS x FROM entity_descriptors WHERE entity_id = ? AND basis = 'self-claim'", s), '他自己说的那句是自称');
    assert.equal(E.rightsHolder(core, s, cousin), true, '锚点本人当面确认（他在这段对话里）');
  } finally { await cleanup(); }
});

test('和真的 admin 接上：双向自认之后，review_queue 里那条 merge 标 withdrawn（不是主人批的，也不再等着）', async () => {
  const { core, cleanup } = await entitiesCore({
    name: 'wiring-withdraw-real',
    mods: { admin: { enqueueReview: admin.enqueueReview, withdrawReviews: admin.withdrawReviews } },
  });
  try {
    const E = core.mods.entities;
    const a = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'na', id: 'u1aa', verifiedBy: 'platform', displayName: 'yyy' }] }, { adapterId: 'na', settingKey: 'SA', at: T0 }).entityId;
    const b = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'nb', id: 'u2bb', verifiedBy: 'platform', displayName: 'xxx' }] }, { adapterId: 'nb', settingKey: 'SB', at: T0 }).entityId;
    const say = (who, settingKey, at, name) => E.resolveExtracted(core, [{ local: 'E1', name, kind: 'person', speaker: 'U1', descriptor: null, msgRefs: ['m1'] }],
      batch(core, { settingKey, at, speakers: { U1: who }, lines: [['m1', who]] }));
    say(a, 'SA', T0 + DAY, 'xxx');
    const q = () => core.store.all("SELECT status, decided_by FROM review_queue WHERE kind = 'merge'");
    assert.deepEqual(q().map((r) => r.status), ['pending']);
    say(b, 'SB', T0 + 2 * DAY, 'yyy');
    assert.deepEqual(q().map((r) => ({ ...r })), [{ status: 'withdrawn', decided_by: 'system:decided-by-mutual-claim' }]);
  } finally { await cleanup(); }
});
