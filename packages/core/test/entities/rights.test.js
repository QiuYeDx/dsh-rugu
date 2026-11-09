// 权利层的几条来路（§5.2「链接分两层」、§1.2 第 5 步）：锚点本人当面确认（anchor-confirmed）、双向自认（mutual-claim）；
// 单方面的说法永远只到 maybe_same；主人和她自己永远不会被说法挂上。外加本批编号的几种锚点、名字匹配器的关系链。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakePorts, FakeSelfProfile } from '../fakes/index.js';
import { entitiesCore, percept, person, DAY, T0 } from './helpers.js';

const NS = 'zq';

/** 一个提炼批次：说话人表 + 每条消息是谁说的（msgRefs → 真的感知行）。 */
function batch(core, { settingKey = 'G1', at, speakers, lines, candidateCodes }) {
  const msgRefs = new Map();
  lines.forEach(([ref, actor], i) => msgRefs.set(ref, percept(core, { settingKey, actor, at: at + i * 1000 })));
  return { speakers: new Map(Object.entries(speakers)), settingKey, at, jobId: Math.floor(at / 1000), msgRefs, ...(candidateCodes ? { candidateCodes } : {}) };
}
const linkOf = (core, a, b) => {
  const r = core.store.get('SELECT rel, decided_by, cross_namespace FROM entity_links WHERE a = ? AND b = ?', Math.min(a, b), Math.max(a, b));
  return r ? { ...r } : null;
};

/** 阿明说过「我表哥小刚」；十天后一个账号进群自称「我是阿明的表哥小刚」。 */
function cousinAndClaimant(core, E) {
  const aming = person(core, NS, 'ua1', T0, '阿明');
  const cousin = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
    batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] })).get('E1');
  const at = T0 + 10 * DAY;
  const s = person(core, NS, 'us1', at, 'gx');
  const r = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
    batch(core, { at, speakers: { U2: s, U3: aming }, lines: [['m1', s]] }));
  assert.equal(r.get('E1'), s, '自我介绍的那一行就是说话人自己');
  return { aming, cousin, s, at };
}

test('锚点当面确认：自称 → maybe_same；旁人附和 → 还是 maybe_same；阿明本人说「对，他就是我表哥」→ same（anchor-confirmed），有权利', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-anchor' });
  try {
    const E = core.mods.entities;
    const { aming, cousin, s, at } = cousinAndClaimant(core, E);
    assert.equal(E.belief(core, s, cousin).rel, 'maybe_same', '口吻上认得出');
    assert.equal(E.rightsHolder(core, s, cousin), false, '自称不给权利');
    assert.deepEqual(E.profile(core, s).descriptors.map((d) => [d.anchor, d.basis]), [[aming, 'self-claim']]);
    // 旁人（第三个人）说「他就是阿明的表哥」：旁人的说法，不是锚点本人
    const c = person(core, NS, 'uc1', at, 'cc');
    E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: at + 1000, speakers: { U2: s, U3: aming, U4: c }, lines: [['m1', c]] }));
    assert.equal(E.rightsHolder(core, s, cousin), false, '旁人说的不算');
    assert.equal(linkOf(core, s, cousin).decided_by, 'extractor');
    // 阿明本人当面：「对，他就是我表哥」（这一行说的是 U2，证据消息是阿明的）
    E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: at + 2000, speakers: { U2: s, U3: aming }, lines: [['m1', aming]] }));
    assert.deepEqual(linkOf(core, s, cousin), { rel: 'same', decided_by: 'anchor-confirmed', cross_namespace: 0 });
    assert.equal(E.rightsHolder(core, s, cousin), true, '锚点本人确认 → 权利层');
    assert.ok(E.profile(core, s).descriptors.some((d) => d.anchor === aming && d.basis === 'first-person'));
    // 之后阿明又说「我表哥小刚又换车了」：同一个人的两个档案不互相变得「分不清」，还挂到原来的档案
    const again = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: at + 3 * DAY, speakers: { U3: aming }, lines: [['m1', aming]] })).get('E1');
    assert.equal(again, cousin);
  } finally { await cleanup(); }
});

test('锚点用这个人自己的账号名指认他（「gx 就是我表哥」，gx 正在这段对话里）：确认他的自称；不在场不算', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-anchor-name' });
  try {
    const E = core.mods.entities;
    const { aming, cousin, s, at } = cousinAndClaimant(core, E);
    // 不在场（这一批只有阿明）：挂到 gx 的档案上，但不算当面确认
    const r1 = E.resolveExtracted(core, [{ local: 'E1', name: 'gx', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: at + DAY, speakers: { U3: aming }, lines: [['m1', aming]] })).get('E1');
    assert.equal(r1, s, '锚点本人用他自己的账号名叫他：就是这个自称者');
    assert.equal(E.rightsHolder(core, s, cousin), false, '不在场：不是当面确认');
    // 当面
    const r2 = E.resolveExtracted(core, [{ local: 'E1', name: 'gx', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: at + 2 * DAY, speakers: { U2: s, U3: aming }, lines: [['m1', aming]] })).get('E1');
    assert.equal(r2, s);
    assert.equal(E.rightsHolder(core, s, cousin), true);
    assert.equal(linkOf(core, s, cousin).decided_by, 'anchor-confirmed');
  } finally { await cleanup(); }
});

test('锚点确认分不清是哪一个（两个表哥都没名字）→ 只挂 maybe_same；名字冲突的不挂；主人永远不会被这样挂上', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-anchor-ambig' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const ctx = (at, speakers, who) => batch(core, { at, speakers, lines: [['m1', who]] });
    const c1 = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], ctx(T0, { U3: aming }, aming)).get('E1');
    const c2 = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'], verdict: { match: null, confidence: 0.9 } }],
      ctx(T0 + DAY, { U3: aming }, aming)).get('E1');
    assert.notEqual(c1, c2, '「另一个表哥」');
    // 主人恰好也记着是阿明的表哥（主人在管理页写的关系描述）
    const principal = E.ensurePrincipal(core);
    core.store.run(`INSERT INTO entity_descriptors(entity_id, anchor_entity_id, relation, text, basis, speaker_entity_id, first_at, last_at, created_at)
      VALUES (?, ?, ?, '表哥', 'owner', 0, ?, ?, ?)`, principal, aming, E.normalizeName('表哥'), T0, T0, T0);
    const s = person(core, NS, 'us1', T0 + 5 * DAY, 'gx');
    E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      ctx(T0 + 5 * DAY, { U2: s, U3: aming }, aming));
    assert.equal(E.rightsHolder(core, s, c1), false);
    assert.equal(E.rightsHolder(core, s, c2), false);
    assert.equal(E.belief(core, s, c1).rel, 'maybe_same');
    assert.equal(E.belief(core, s, c2).rel, 'maybe_same');
    assert.equal(E.belief(core, s, principal), null, '主人不会被任何说法挂上');
    assert.equal(E.rightsHolder(core, s, principal), false);
    // 另一个自称者报的名字和两个表哥都对不上（一个叫小刚）：冲突的不挂
    E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], ctx(T0 + 6 * DAY, { U3: aming }, aming));
    const t = person(core, NS, 'ut1', T0 + 7 * DAY, 'tt');
    E.resolveExtracted(core, [{ local: 'E1', name: '小李', kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      ctx(T0 + 7 * DAY, { U2: t, U3: aming }, t));
    const named = core.store.get("SELECT e.id FROM entities e JOIN entity_names n ON n.entity_id = e.id WHERE n.text_raw = '小刚' LIMIT 1").id;
    assert.equal(E.belief(core, t, named), null, '自称小李，和叫小刚的表哥对不上');
  } finally { await cleanup(); }
});

test('双向自认：A 说「我在那边就是 xxx」→ maybe_same（B3 规范已经写上）；B 也认了 A → same（mutual-claim），当事人进「谁知道」', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'rights-mutual' });
  try {
    const E = core.mods.entities;
    const ra = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'na', id: 'u1aa', verifiedBy: 'platform', displayName: 'yyy' }] }, { adapterId: 'na', settingKey: 'SA', at: T0 });
    const rb = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'nb', id: 'u2bb', verifiedBy: 'platform', displayName: 'xxx' }] }, { adapterId: 'nb', settingKey: 'SB', at: T0 });
    const [a, b] = [ra.entityId, rb.entityId];
    const say = (who, code, settingKey, at, name) => E.resolveExtracted(core, [{ local: 'E1', name, kind: 'person', speaker: code, descriptor: null, msgRefs: ['m1'] }],
      batch(core, { settingKey, at, speakers: { [code]: who }, lines: [['m1', who]] }));
    say(a, 'U1', 'SA', T0 + DAY, 'xxx');
    assert.equal(E.belief(core, a, b).rel, 'maybe_same', '单方面的自我介绍：认得出');
    assert.equal(E.rightsHolder(core, a, b), false);
    const l1 = linkOf(core, a, b);
    assert.equal(l1.cross_namespace, 1);
    const lid = core.store.get('SELECT id FROM entity_links WHERE a = ? AND b = ?', Math.min(a, b), Math.max(a, b)).id;
    assert.ok(rec.norms.some((n) => n.ref === `l${lid}` && n.norm.identityLink), '跨平台的对应本身是隐私（B3），maybe_same 也一样');
    assert.equal(rec.knowledge.filter((k) => k.ref === `l${lid}`).length, 0, '还没确认：谁知道里不记当事人');
    assert.deepEqual(rec.reviews.map((r) => [r.kind, r.payload]), [['merge', { a: Math.min(a, b), b: Math.max(a, b) }]], '主人可以直接批准（§5.2）');
    say(a, 'U1', 'SA', T0 + DAY + 5000, 'xxx');
    assert.equal(rec.reviews.length, 1, '同一对只排一条');
    say(b, 'U1', 'SB', T0 + 2 * DAY, 'yyy');
    assert.deepEqual(linkOf(core, a, b), { rel: 'same', decided_by: 'mutual-claim', cross_namespace: 1 });
    assert.equal(E.rightsHolder(core, a, b), true);
    assert.equal(E.rightsHolder(core, b, a), true);
    const k = rec.knowledge.find((x) => x.ref === `l${lid}`);
    assert.deepEqual(k.entries.map((e) => e.whoRef).sort(), [String(a), String(b)].sort());
    assert.equal(rec.norms.filter((n) => n.ref === `l${lid}`).length, 1, 'B3 规范只写一次');
  } finally { await cleanup(); }
});

test('单方面说自己是同一平台的另一个账号：默认不同的人，不挂；两个账号互相认了（小号）才 same', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'rights-alt' });
  try {
    const E = core.mods.entities;
    const a = person(core, NS, 'u1a', T0, 'yyy');
    const c = person(core, NS, 'u3c', T0, 'zzz');
    const say = (who, at, name) => E.resolveExtracted(core, [{ local: 'E1', name, kind: 'person', speaker: 'U1', descriptor: null, msgRefs: ['m1'] }],
      batch(core, { at, speakers: { U1: who }, lines: [['m1', who]] }));
    say(a, T0 + DAY, 'zzz');
    assert.equal(E.belief(core, a, c), null, '同命名空间同作用域不同 id：只凭一面之词不挂');
    assert.equal(rec.reviews.length, 0, '同一个平台里的说法不算跨平台的对应，不排审核');
    say(c, T0 + 2 * DAY, 'yyy');
    assert.equal(linkOf(core, a, c).decided_by, 'mutual-claim');
    assert.equal(E.rightsHolder(core, a, c), true);
  } finally { await cleanup(); }
});

test('自我介绍冒用主人的称呼（「我是小林」）：名字记成冒用，不进名字匹配器，也不和主人挂链接', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-spoof', ports: fakePorts({ selfProfile: new FakeSelfProfile({ principalLabel: '小林' }) }) });
  try {
    const E = core.mods.entities;
    const principal = E.ensurePrincipal(core);
    const s = person(core, NS, 'us1', T0, 'gx');
    E.resolveExtracted(core, [{ local: 'E1', name: '小林', kind: 'person', speaker: 'U2', descriptor: null, msgRefs: ['m1'] }],
      batch(core, { at: T0, speakers: { U2: s }, lines: [['m1', s]] }));
    assert.equal(E.belief(core, s, principal), null);
    assert.equal(core.store.get("SELECT spoof FROM entity_names WHERE entity_id = ? AND text_raw = '小林'", s).spoof, 1);
    assert.deepEqual(E.nameMatcher(core).scan('小林在吗').map((h) => h.entityId), [principal]);
    assert.equal(E.profile(core, s).names.some((n) => n.text === '小林'), false, '人物卡上也不显示冒用的名字');
  } finally { await cleanup(); }
});

test('锚点可以是候选档案的编号（ctx.candidateCodes，§7.4 第 12 条「已知」）或实体 id；入库时没认出来的说话人在本批立档后也能当锚点', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-codes' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const b = person(core, NS, 'ub1', T0, '阿杰');
    // 阿杰说「阿明的表哥」，阿明不在这一批里：锚点是候选档案 c2
    const viaCode = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'c2', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: T0, speakers: { U1: b }, lines: [['m1', b]], candidateCodes: new Map([['c2', aming]]) })).get('E1');
    assert.deepEqual(E.profile(core, viaCode).descriptors.map((d) => [d.anchor, d.basis]), [[aming, 'third-party']]);
    // 没给 candidateCodes：认不出锚点，描述去掉（没名字、没关系的行不建档）
    const none = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'c9', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: T0, speakers: { U1: b }, lines: [['m1', b]] }));
    assert.equal(none.has('E1'), false);
    // 实体 id 当锚点
    const viaId = E.resolveExtracted(core, [{ local: 'E1', name: '小美', kind: 'person', descriptor: { anchor: aming, relation: '妹妹' }, msgRefs: ['m1'] }],
      batch(core, { at: T0 + DAY, speakers: { U1: b }, lines: [['m1', b]] })).get('E1');
    assert.equal(E.profile(core, viaId).descriptors[0].anchor, aming);
    // 只有名字的说话人（U4 → null），encode 把他也作为一行交过来；另一行的锚点是 U4（排在前面也没关系）
    const r = E.resolveExtracted(core, [
      { local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U4', relation: '女儿' }, msgRefs: ['m1'] },
      { local: 'U4', name: '老王', kind: 'person', descriptor: null, msgRefs: ['m1'], verdict: { match: null, confidence: 0.5 } },
    ], batch(core, { at: T0 + 2 * DAY, speakers: { U4: null }, lines: [['m1', null]] }));
    const wang = r.get('U4');
    assert.ok(Number.isInteger(wang));
    assert.equal(E.profile(core, r.get('E1')).descriptors[0].anchor, wang);
  } finally { await cleanup(); }
});

test('名字匹配器：「阿明的表哥」挂在阿明下面（不挂说话人自己的表哥）；关系可以接着往下走（「阿明的表哥的女儿」）', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-chain' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const b = person(core, NS, 'ub1', T0, '阿杰');
    const r = E.resolveExtracted(core, [
      { local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] },
      { local: 'E2', name: null, kind: 'person', descriptor: { anchor: 'E1', relation: '女儿' }, msgRefs: ['m1'] },
    ], batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] }));
    const [cousin, niece] = [r.get('E1'), r.get('E2')];
    const bCousin = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U1', relation: '表哥' }, msgRefs: ['m1'] }],
      batch(core, { at: T0, speakers: { U1: b }, lines: [['m1', b]] })).get('E1');
    const m = E.nameMatcher(core);
    const hits = m.scan('阿明的表哥的女儿考上了', { anchors: [b] });
    assert.deepEqual(hits.map((h) => [h.entityId, h.via]), [[aming, 'name'], [cousin, 'relation'], [niece, 'relation']]);
    assert.ok(!hits.some((h) => h.entityId === bCousin), '阿杰说「阿明的表哥」：不是阿杰自己的表哥');
    assert.deepEqual(m.scan('我表哥最近怎样', { anchors: [b] }).map((h) => h.entityId), [bCousin]);
  } finally { await cleanup(); }
});

test('resolveActor：只有显示名的说话人对上一个这个适配器给过账号的人（命名空间不等于适配器 id 也算）→ 拿不准，不认', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-nameonly' });
  try {
    const E = core.mods.entities;
    const ctx = { adapterId: 'adp', settingKey: core.keys.settingKey('adp', 'G1'), at: T0 };
    const a = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'nsx', id: 'u9q', verifiedBy: 'platform' },
      { kind: 'display-name', name: '阿强', scope: 'G1', observedAt: T0 }] }, ctx).entityId;
    const r = E.resolveActor(core, { claims: [{ kind: 'display-name', name: '阿强', scope: 'G1', observedAt: T0 }] }, ctx);
    assert.equal(r.entityId, null, '适配器本该带账号来：只靠名片对上他，拿不准');
    assert.notEqual(a, null);
  } finally { await cleanup(); }
});

test('主人确认是同一个人：两个档案都 established（§5.2「或主人确认」）', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'rights-owner' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const mk = (name) => E.resolveExtracted(core, [{ local: 'E1', name, kind: 'person', descriptor: null, msgRefs: ['m1'], verdict: { match: null, confidence: 0.9 } }],
      batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] })).get('E1');
    const x = mk('大刘');
    const y = mk('刘哥');
    assert.equal(E.profile(core, x).status, 'provisional');
    E.link(core, x, y, { rel: 'same', confidence: 1, evidence: ['review'], decidedBy: 'owner', at: T0 + DAY });
    assert.equal(E.profile(core, x).status, 'established');
    assert.equal(E.profile(core, y).status, 'established');
    assert.equal(E.rightsHolder(core, x, y), true);
  } finally { await cleanup(); }
});
