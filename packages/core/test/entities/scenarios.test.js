// entities 牵头的场景（§14.3、契约 §4.14）：S7、S8、S8b、S9；外加参与的 S19、S19b 里属于 entities 的那一段（权利层、B3 规范）。
// 全部跑在假平台上（随机命名空间、随机场合属性，§2.2、S18）：断言只针对属性和档案，不针对某个入口。
// 依赖的模块（dynamics、discretion、worker、intake、admin、lang）用 helpers.js 里按契约写的替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { fakePorts, FakeSelfProfile } from '../fakes/index.js';
import { entitiesCore, percept, fact, DAY, T0 } from './helpers.js';

/** 假平台 + entities 核心：注册适配器的身份 claim，返回说话人实体和场合键。 */
async function world(name, { principalLabel } = {}) {
  const fp = createFakePlatform({ startAt: T0 });
  const ports = fakePorts(principalLabel ? { selfProfile: new FakeSelfProfile({ principalLabel }) } : {});
  const t = await entitiesCore({ name, ports });
  const { core } = t;
  const E = core.mods.entities;
  E.registerAdapterClaims(core, fp.namespace, { selfClaims: fp.adapter.selfClaims(), principalClaims: fp.adapter.principalClaims() });
  const key = (where) => core.keys.settingKey(fp.namespace, fp.settings[where].id);
  // 群友说话时带着本群的名片（假平台给的随机名字；群名片只在本群算数）
  const actorOf = (w, where, at) => (w === 'principal' || w === 'her' ? fp.people[w].actor
    : { claims: [...fp.people[w].actor.claims, { kind: 'display-name', name: fp.people[w].name, scope: fp.settings[where].id, observedAt: at }] });
  const who = (w, where = 'smallGroup', at = T0) => E.resolveActor(core, actorOf(w, where, at), { adapterId: fp.namespace, settingKey: key(where), at }).entityId;
  /** 一个提炼批次：某人在某场合说了一句（msgRefs 指向真的感知行），ent 行交给 resolveExtracted。 */
  const said = (w, where, at, ents, wEnc = 1) => {
    const speaker = who(w, where, at);
    const pid = percept(core, { settingKey: key(where), actor: speaker, at, wEnc });
    const out = E.resolveExtracted(core, ents.map((e) => ({ msgRefs: ['m1'], kind: 'person', ...e })),
      { speakers: new Map([['U2', speaker], ['我', E.ensureSelf(core)]]), settingKey: key(where), at, jobId: at, msgRefs: new Map([['m1', pid]]) });
    return { out, speaker, pid };
  };
  t.diagnostic = `fake platform seed=${fp.seed}`;
  return { ...t, fp, E, key, who, said };
}

test('S7：群友对她说「我表哥开网约车」，一个月后问「我表哥干啥的你还记得吗」——线索直接落到那份档案上，也知道是这位群友说的', async (t) => {
  const w = await world('s7');
  t.diagnostic(w.diagnostic);
  try {
    const { core, E, rec, said, who } = w;
    // 第 0 天：对她说（w_att = 1.0）
    const { out, speaker: friend } = said('friend', 'smallGroup', T0, [{ local: 'E1', name: null, descriptor: { anchor: 'U2', relation: '表哥' } }], 1.0);
    const cousin = out.get('E1');
    assert.ok(Number.isInteger(cousin) && cousin !== friend, '没有账号也建档（「群友的表哥」）');
    const desc = E.profile(core, cousin).descriptors;
    assert.deepEqual(desc.map((d) => [d.anchor, d.text, d.basis]), [[friend, '表哥', 'first-person']], '知道是这位群友（的表哥），是他自己说的');
    assert.equal(core.store.get('SELECT speaker_entity_id AS s FROM entity_descriptors WHERE entity_id = ?', cousin).s, friend, '来源：这位群友');
    const tr = rec.traces.filter((x) => x.ref === `n${cousin}`);
    assert.deepEqual(tr.map((x) => [x.t, x.w, x.reason]), [[T0, 1.0, 'mention']], '直接对她说的听说：档案痕迹的编码强度不打折（dynamics 据此算 30 天后 ≥ 0.7）');
    // 第 30 天：同一个群友问
    const at = T0 + 30 * DAY;
    const asker = who('friend', 'smallGroup', at);
    assert.equal(asker, friend);
    const cues = E.nameMatcher(core).scan('我表哥干啥的你还记得吗', { settingKey: w.key('smallGroup'), anchors: [asker], at });
    assert.deepEqual(cues.map((c) => [c.entityId, c.via]), [[cousin, 'relation']], '「我」+「表哥」沿关系路径直接落到这份档案');
    const cands = await E.candidates(core, { name: null, context: '我表哥干啥的你还记得吗', anchorEntityId: asker, relation: '表哥' });
    assert.equal(cands[0].entityId, cousin);
    // 另一个群友问「我表哥」：落不到这份档案上（不是他的表哥）
    const other = who('other', 'smallGroup', at);
    assert.equal(E.nameMatcher(core).scan('我表哥干啥的', { anchors: [other] }).length, 0);
  } finally { await w.cleanup(); }
});

test('S8：表哥后来被说出名字「小刚」——挂到同一个档案；别处的「小刚」只是「可能是他」；阿明的表哥 ≠ 别人的表哥', async (t) => {
  const w = await world('s8');
  t.diagnostic(w.diagnostic);
  try {
    const { core, E, said } = w;
    const { out: o1, speaker: friend } = said('friend', 'smallGroup', T0, [{ local: 'E1', name: null, descriptor: { anchor: 'U2', relation: '表哥' } }]);
    const cousin = o1.get('E1');
    // 周三：「我表哥小刚又换车了」（旁听，w_att 0.35）
    const { out: o2 } = said('friend', 'smallGroup', T0 + 2 * DAY, [{ local: 'E1', name: '小刚', descriptor: { anchor: 'U2', relation: '表哥' } }], 0.35);
    assert.equal(o2.get('E1'), cousin, '挂到同一个档案');
    const prof = E.profile(core, cousin);
    assert.equal(prof.displayName, '小刚');
    assert.ok(prof.names.some((n) => n.text === '小刚' && n.usedBy === friend), '名字证据：谁这样叫他');
    assert.equal(prof.status, 'established', '两个不同的日子被提到');
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM entities WHERE id <> ? AND display_name = ?', cousin, '小刚').n, 0, '没有多出一个「小刚」');
    // 两周后另一个群里有人提到「小刚」：名字对得上，但场合不同、也没有阿明 → 新建 F + maybe_same
    const { out: o3 } = said('other', 'bigGroup', T0 + 16 * DAY, [{ local: 'E1', name: '小刚', descriptor: null }]);
    const f = o3.get('E1');
    assert.notEqual(f, cousin);
    assert.equal(E.belief(core, f, cousin).rel, 'maybe_same');
    assert.equal(E.rightsHolder(core, f, cousin), false);
    // 别人的表哥也叫小刚：锚点冲突，不是同一个人
    const { out: o4 } = said('stranger', 'bigGroup', T0 + 17 * DAY, [{ local: 'E1', name: '小刚', descriptor: { anchor: 'U2', relation: '表哥' } }]);
    assert.ok(![cousin, f].includes(o4.get('E1')));
    assert.equal(E.belief(core, o4.get('E1'), cousin), null);
    // 一个月后「阿明的表哥」：名字 + 关系词落到 E（阿明的名片只在本群算数，所以在本群里问）
    const label = E.profile(core, friend).displayName;
    assert.equal(label, w.fp.people.friend.name);
    const hits = E.nameMatcher(core).scan(`${label}的表哥干啥的`, { settingKey: w.key('smallGroup'), at: T0 + 30 * DAY });
    assert.deepEqual(hits.filter((h) => h.via === 'relation').map((h) => h.entityId), [cousin], '「阿明的表哥」只落到 E（别人的表哥小刚不算）');
    // 阿明自己问「我表哥干啥的」：说话人当锚点，同样落到 E
    assert.deepEqual(E.nameMatcher(core).scan('我表哥干啥的你还记得吗', { anchors: [friend] }).map((h) => h.entityId), [cousin]);
  } finally { await w.cleanup(); }
});

test('S8b：群友说「我表妹小林考上研究生了」，而主人的称呼恰好也是「小林」——不会记到主人身上', async (t) => {
  const w = await world('s8b', { principalLabel: '小林' });
  t.diagnostic(w.diagnostic);
  try {
    const { core, E, said, who, fp } = w;
    const principal = E.ensurePrincipal(core);
    assert.equal(who('principal', 'oneOnOne'), principal, '主人的账号（配置给的）认得出主人');
    // 没有 LLM 裁决
    const { out: o1 } = said('friend', 'smallGroup', T0, [{ local: 'E1', name: '小林', descriptor: { anchor: 'U2', relation: '表妹' } }]);
    const cousin = o1.get('E1');
    assert.notEqual(cousin, principal);
    assert.equal(E.belief(core, cousin, principal), null, '连 maybe_same 都不挂');
    // LLM 裁决错把她认成主人（被内容误导）：代码的约束推翻它
    const { out: o2 } = said('friend', 'smallGroup', T0 + DAY, [{ local: 'E1', name: '小林', descriptor: { anchor: 'U2', relation: '表妹' }, verdict: { match: principal, confidence: 0.99 } }]);
    assert.notEqual(o2.get('E1'), principal);
    assert.equal(o2.get('E1'), cousin, '还是那个表妹');
    // 候选档案里也不给主人
    const cands = await E.candidates(core, { name: '小林', context: '我表妹小林考上研究生了', anchorEntityId: who('friend'), relation: '表妹' });
    assert.ok(!cands.some((c) => c.entityId === principal));
    assert.equal(cands[0].entityId, cousin);
    // 名字匹配器：同名的都返回（交给融合打分），表妹不会被并进主人
    const hits = E.nameMatcher(core).scan('小林考上研究生了');
    assert.deepEqual(hits.map((h) => h.entityId).sort(), [principal, cousin].sort());
    // 有人把名片改成「小林」：冒用保留名无效
    const imp = E.resolveActor(core, { claims: [{ kind: 'display-name', name: '小林', scope: fp.settings.smallGroup.id, observedAt: T0 }] },
      { adapterId: fp.namespace, settingKey: w.key('smallGroup'), at: T0 });
    assert.notEqual(imp.entityId, principal);
    assert.equal(imp.isPrincipal, false);
    // 账号证据不能把别人挂到主人身上：另一个账号带着「小林」的昵称，还是另一个人
    const other = E.resolveActor(core, { claims: [{ kind: 'account', namespace: fp.namespace, id: 'uk2j3h4', verifiedBy: 'platform', displayName: '小林' }] },
      { adapterId: fp.namespace, settingKey: w.key('smallGroup'), at: T0 });
    assert.notEqual(other.entityId, principal);
    assert.equal(E.profile(core, other.entityId).displayName, null);
  } finally { await w.cleanup(); }
});

test('S9：「阿明说小刚很抠」——这是关于小刚的听说，不形成「阿明很抠」的印象', async (t) => {
  const w = await world('s9');
  t.diagnostic(w.diagnostic);
  try {
    const { core, E, rec, said } = w;
    const { out: o1, speaker: aming } = said('friend', 'smallGroup', T0, [{ local: 'E1', name: '小刚', descriptor: { anchor: 'U2', relation: '表哥' } }]);
    const xg = o1.get('E1');
    // 阿明又说「小刚很抠」（没带关系）：同一个人在同一个场合这样叫过他 → 认成小刚，不是说话人自己
    const { out: o2, pid } = said('friend', 'smallGroup', T0 + DAY, [{ local: 'E1', name: '小刚', descriptor: null }]);
    assert.equal(o2.get('E1'), xg);
    assert.notEqual(o2.get('E1'), aming);
    // encode 据此写的事实：主体小刚、说话人阿明、转了一手（这里直接造这一行）
    rec.snapshots.set(1, { id: 1, exposureRank: 1 });
    core.store.run('UPDATE percepts SET snapshot_id = 1 WHERE id = ?', pid);
    const f = fact(core, { subject: xg, speaker: aming, perceptId: pid, text: '小刚很抠' });
    // 阿明自己当众说的自己的事
    const own = fact(core, { subject: aming, speaker: aming, perceptId: pid, text: '我周末在家打游戏' });
    const forAming = E.impressionSources(core, aming);
    const all = [...forAming.shared, ...forAming.private].map((x) => x.ref);
    assert.ok(!all.includes(`a${f}`), '「小刚很抠」不进阿明的印象证据');
    assert.deepEqual(forAming.shared.map((x) => x.ref), [`a${own}`]);
    const forXg = E.impressionSources(core, xg);
    assert.deepEqual(forXg.private.map((x) => [x.ref, x.hearsay]), [[`a${f}`, true]], '进小刚的「听说」那部分');
    assert.equal(forXg.shared.length, 0, '别人背后说的不是小刚本人当众说的，不进大家都看得到的那层');
    // 夜里重新生成的印象：小刚有一条听说，阿明的印象不受影响
    E.writeImpression(core, xg, 'private', { text: '听阿明说有点抠', evidenceRefs: [`a${f}`], firstHand: 0, hearsay: 1, at: T0 + 2 * DAY });
    assert.equal(E.profile(core, aming).impressions.length, 0);
    assert.equal(E.profile(core, xg).impressions[0].text, '听阿明说有点抠');
  } finally { await w.cleanup(); }
});

test('S19（entities 的一段）：两个平台的账号其实是同一个人——对应关系本身带 B3 规范，「谁知道」只有当事人', async (t) => {
  const w = await world('s19');
  t.diagnostic(w.diagnostic);
  try {
    const { core, E, rec, who } = w;
    const here = who('friend');
    const there = E.resolveActor(core, { claims: [{ kind: 'account', namespace: 'zz-other', id: 'v8f7g6', verifiedBy: 'platform' }] },
      { adapterId: 'zz-other', settingKey: 'OTHER', at: T0 }).entityId;
    const id = E.link(core, here, there, { rel: 'same', confidence: 1, evidence: ['mutual'], decidedBy: 'mutual-claim', at: T0 });
    assert.equal(core.store.get('SELECT cross_namespace AS c FROM entity_links WHERE id = ?', id).c, 1);
    const n = rec.norms.find((x) => x.ref === `l${id}`);
    assert.equal(n.norm.identityLink, true, 'B3：身份对应类信息');
    const k = rec.knowledge.find((x) => x.ref === `l${id}`);
    assert.deepEqual(k.entries.map((e) => e.whoRef).sort(), [String(here), String(there)].sort(), '谁知道：只有当事人（主人一对一的例外归 B3）');
    assert.equal(E.belief(core, here, there).rel, 'same');
    // 人物卡读档案时只有命名空间和强度，没有任何账号值
    assert.ok(E.profile(core, here).identities.every((x) => Object.keys(x).sort().join() === 'namespace,scope,strength'));
  } finally { await w.cleanup(); }
});

test('S19b（entities 的一段）：有人在群里自称「我是阿明的表哥」——认得出，但不是权利层的本人（不能要求忘掉、不算本人在场）', async (t) => {
  const w = await world('s19b');
  t.diagnostic(w.diagnostic);
  try {
    const { core, E, said, who } = w;
    const { out } = said('friend', 'smallGroup', T0, [{ local: 'E1', name: '小刚', descriptor: { anchor: 'U2', relation: '表哥' } }]);
    const cousin = out.get('E1');
    const aming = who('friend');
    // 陌生人进群自称：说话人编号 U2 是他，锚点是阿明（U3）
    const stranger = who('stranger', 'smallGroup', T0 + 10 * DAY);
    const pid = percept(core, { settingKey: w.key('smallGroup'), actor: stranger, at: T0 + 10 * DAY });
    const r = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', speaker: 'U2', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      { speakers: new Map([['U2', stranger], ['U3', aming]]), settingKey: w.key('smallGroup'), at: T0 + 10 * DAY, jobId: 9, msgRefs: new Map([['m1', pid]]) });
    assert.equal(r.get('E1'), stranger);
    assert.equal(E.belief(core, stranger, cousin).rel, 'maybe_same', '口吻上认得出（「哦你就是小刚呀」）');
    assert.equal(E.rightsHolder(core, stranger, cousin), false, '不能以表哥本人的身份放宽规范、要求忘掉、算本人在场');
    // 主人在管理页批准合并：才有权利
    E.link(core, stranger, cousin, { rel: 'same', confidence: 1, evidence: ['review'], decidedBy: 'owner', at: T0 + 11 * DAY });
    assert.equal(E.rightsHolder(core, stranger, cousin), true);
  } finally { await w.cleanup(); }
});
