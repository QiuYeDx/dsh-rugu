// 提及和「假人」（D108，实测问题 #17；D160：认人只凭证据——名字不凭空立人）。
//   - resolveActor(role = 'mention')：只有名字的提及对上她自己的名字（任何场合）→ 她；对上这里有管理权限的人 → 他；
//     名字不到 2 个字的不认；这个场合里正好一个人的平台名（名片 / 昵称）是它 → 他（他有账号也一样）；几个人 → 不认；谁都不是 → 不认、不新建。
//     认出来的也不记名字、不记日子（提及不是起名的证据；日子和痕迹由 intake 的 noteMention 记）；
//   - 带账号的提及（平台从成员列表里认出来的）：第一次就立档、记账号证据和名片；之后他说话，还是同一个档案；
//   - 她自己的 ActorRef 带着名片（说话或被 @）：名片记成她的，之后「@这个名字」认成她，以前用这个名字造出来的假人当场撤掉；
//   - repairMentionGhosts：见 repair.js（撤掉的、挂 same 的、幂等、有东西指着就不撤）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, fact, insertRow, T0 } from './helpers.js';

const ADAPTER = 'zq';
const ctx = (settingKey) => ({ adapterId: ADAPTER, settingKey, at: T0 });
const mention = (settingKey) => ({ ...ctx(settingKey), role: 'mention' });
const named = (name, scope) => ({ claims: [{ kind: 'display-name', name, ...(scope ? { scope } : {}), observedAt: T0 }] });
/** 平台认得出的群成员：账号 + 这个群里的名片（账号 id 是现编的）。 */
const member = (id, name, scope) => ({ claims: [{ kind: 'account', namespace: ADAPTER, id, verifiedBy: 'platform' }, { kind: 'display-name', name, scope, observedAt: T0 }] });
const count = (core, sql, ...a) => core.store.get(sql, ...a).n;
const rows = (core, sql, ...a) => core.store.all(sql, ...a).map((r) => ({ ...r }));
const metric = (core, name) => Number(core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0);

test('提及：她的群名片 → 她自己；主人的群名片 → 主人；「我」不认；谁都不叫这个名字 → 不认、不新建；说话人用她的名字也不新建一个她', async () => {
  const t = await entitiesCore({ name: 'ghost-mention' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    const me = E.ensureSelf(core);
    const boss = E.ensurePrincipal(core);
    E.resolveActor(core, { self: true, claims: [{ kind: 'display-name', name: '星野小满', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    E.resolveActor(core, { claims: [{ kind: 'principal' }, { kind: 'display-name', name: '老周', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    const before = count(core, 'SELECT COUNT(*) AS n FROM entities');
    const r1 = E.resolveActor(core, named('星野小满', 'G1'), mention('k1'));
    assert.equal(r1.entityId, me);
    assert.equal(r1.via, 'mention-self');
    assert.equal(E.resolveActor(core, named('星野小满', 'G2'), mention('k2')).entityId, me, '她的名字不限场合');
    assert.equal(E.resolveActor(core, named('老周', 'G1'), mention('k1')).entityId, boss, '主人的群名片 → 主人');
    assert.equal(E.resolveActor(core, named('我', 'G1'), mention('k1')).entityId, null, '「@我」不认');
    // D160：「@阿明」——这里没有人叫阿明：只是一个名字，不新建
    const r3 = E.resolveActor(core, named('阿明', 'G1'), mention('k1'));
    assert.equal(r3.entityId, null);
    assert.equal(r3.via, 'none');
    // 名字和问候粘在一起的（「@阿明你好」）也一样
    assert.equal(E.resolveActor(core, named('阿明你好', 'G1'), mention('k1')).entityId, null);
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM entities'), before, '没有新建任何人');
    assert.equal(metric(core, 'entities.mention.unresolved'), 2);
    assert.equal(count(core, "SELECT COUNT(*) AS n FROM entity_names WHERE text_raw = '星野小满' AND entity_id <> ?", me), 0, '提及不记名字');
    // 说话人（不是提及）只有她的名字：不认成她，也不新建一个叫她名字的人
    assert.equal(E.resolveActor(core, named('星野小满', 'G3'), ctx('k3')).entityId, null);
    // 说话人只有名字、谁都不叫这个：照旧立档（他说话了，这就是他存在的证据）
    const sp = E.resolveActor(core, named('小林', 'G1'), ctx('k1'));
    assert.ok(sp.entityId && sp.entityId !== me && sp.entityId !== boss);
  } finally { await t.cleanup(); }
});

test('提及：这个场合里正好一个人的名片是它 → 他（他有这个平台的账号也一样），不记名字、不记日子；两个人都叫这个 → 不认；别的群的名片不算', async () => {
  const t = await entitiesCore({ name: 'mention-card' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(ADAPTER, 'G1');
    const lin = E.resolveActor(core, member('u-lin-01', '小林', 'G1'), ctx(k1)).entityId;
    const days = core.store.get('SELECT mention_days, mention_day_set FROM entities WHERE id = ?', lin);
    const names = count(core, 'SELECT COUNT(*) AS n FROM entity_names WHERE entity_id = ?', lin);
    const nameRow = core.store.get("SELECT count, last FROM entity_names WHERE entity_id = ? AND text_raw = '小林'", lin);
    const r = E.resolveActor(core, named('小林', 'G1'), { ...mention(k1), at: T0 + 3 * 86_400_000 });
    assert.equal(r.entityId, lin, '有账号的人也认得出（提及本来就不带账号）');
    assert.equal(r.via, 'mention-name');
    assert.deepEqual(core.store.get('SELECT mention_days, mention_day_set FROM entities WHERE id = ?', lin), days, '提及不记「又出现了一天」');
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM entity_names WHERE entity_id = ?', lin), names, '不记名字');
    assert.deepEqual(core.store.get("SELECT count, last FROM entity_names WHERE entity_id = ? AND text_raw = '小林'", lin), nameRow);
    // 别的群：小林的名片只在 G1 有效
    assert.equal(E.resolveActor(core, named('小林', 'G2'), mention(core.keys.settingKey(ADAPTER, 'G2'))).entityId, null);
    // G1 里又来一个也叫小林的人：分不清
    E.resolveActor(core, member('u-lin-02', '小林', 'G1'), ctx(k1));
    const before = count(core, 'SELECT COUNT(*) AS n FROM entities');
    assert.equal(E.resolveActor(core, named('小林', 'G1'), mention(k1)).entityId, null);
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM entities'), before);
    assert.equal(metric(core, 'entities.mention.ambiguous'), 1);
  } finally { await t.cleanup(); }
});

test('带账号的提及（平台认得出、他还没说过话）：立一个档、记账号和这个群的名片；他之后说话还是这个档案', async () => {
  const t = await entitiesCore({ name: 'mention-account' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(ADAPTER, 'G1');
    const before = count(core, 'SELECT COUNT(*) AS n FROM entities');
    const r = E.resolveActor(core, member('u-ming-07', '阿明', 'G1'), mention(k1));
    assert.ok(r.entityId);
    assert.equal(r.via, 'identity');
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM entities'), before + 1);
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM identity_evidence WHERE entity_id = ?', r.entityId), 1);
    assert.deepEqual(rows(core, 'SELECT text_raw, name_kind, scope_setting_key AS scope FROM entity_names WHERE entity_id = ?', r.entityId),
      [{ text_raw: '阿明', name_kind: 'card', scope: k1 }]);
    // 再被 @ 一次、然后自己说话：同一个档案
    assert.equal(E.resolveActor(core, member('u-ming-07', '阿明', 'G1'), mention(k1)).entityId, r.entityId);
    assert.equal(E.resolveActor(core, member('u-ming-07', '阿明', 'G1'), ctx(k1)).entityId, r.entityId);
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM entities'), before + 1);
    // 之后只有名字的「@阿明」也认成他
    assert.equal(E.resolveActor(core, named('阿明', 'G1'), mention(k1)).entityId, r.entityId);
  } finally { await t.cleanup(); }
});

test('她自己被 @（self + 名片）：名片记成她在这个群的名字；之后只有名字的「@这个名字」认成她；以前造出来的同名假人当场撤掉', async () => {
  const t = await entitiesCore({ name: 'mention-self-card' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    const me = E.ensureSelf(core);
    const k1 = core.keys.settingKey(ADAPTER, 'G1');
    // 旧版本留下的假人：「@她的名片」造出来的（直接写库，模拟修好以前的那几行）
    const ghost = Number(core.store.run("INSERT INTO entities(kind, status, individual, created_at, updated_at) VALUES ('person', 'established', 1, ?, ?)", T0, T0).lastInsertRowid);
    core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, first, last)
                    VALUES (?, '月见', ?, ?, 'card', ?, ?)`, ghost, E.normalizeName('月见'), k1, T0, T0);
    fact(core, { subject: ghost, speaker: me });   // 就算有事实挂在上面：名字是她的，撤
    const r = E.resolveActor(core, { self: true, claims: [{ kind: 'display-name', name: '月见', scope: 'G1', observedAt: T0 }] }, mention(k1));
    assert.equal(r.entityId, me);
    assert.deepEqual(rows(core, 'SELECT text_raw, name_kind, scope_setting_key AS scope FROM entity_names WHERE entity_id = ? AND text_raw = ?', me, '月见'),
      [{ text_raw: '月见', name_kind: 'card', scope: k1 }]);
    assert.equal(core.store.get('SELECT status FROM entities WHERE id = ?', ghost).status, 'retracted', '她有了这个名字：当场撤掉同名的假人');
    assert.equal(E.resolveActor(core, named('月见', 'G1'), mention(k1)).entityId, me);
    assert.equal(E.resolveActor(core, named('月见', 'G5'), mention(core.keys.settingKey(ADAPTER, 'G5'))).entityId, me, '她的名字不限场合');
  } finally { await t.cleanup(); }
});

/** 旧版本留下的档案（直接写库）：名字行全是 kind。 */
function mk(core, names, { kind = 'card', status = 'provisional' } = {}) {
  const id = Number(core.store.run("INSERT INTO entities(kind, status, individual, created_at, updated_at) VALUES ('person', ?, 1, ?, ?)", status, T0, T0).lastInsertRowid);
  for (const [name, scope] of names) {
    core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, first, last)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`, id, name, core.mods.entities.normalizeName(name), scope, kind, T0, T0);
  }
  return id;
}
const st = (core, id) => core.store.get('SELECT status FROM entities WHERE id = ?', id).status;
const linkOf = (core, a, b) => { const r = core.store.get('SELECT rel, decided_by, confidence, evidence_json FROM entity_links WHERE a = ? AND b = ?', Math.min(a, b), Math.max(a, b)); return r ? { ...r } : null; };

test('修复：她的名字、主人的名字、不到 2 个字的、「@名字」造出来又没人指着的 → 撤；说过话的、有账号的、有关系描述的不动；再跑一遍什么都不做', async () => {
  const t = await entitiesCore({ name: 'ghost-repair' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(ADAPTER, 'G1');
    E.resolveActor(core, { self: true, claims: [{ kind: 'display-name', name: '星野小满', scope: 'G1', observedAt: T0 }] }, ctx(k1));
    E.resolveActor(core, { claims: [{ kind: 'principal' }, { kind: 'display-name', name: '老周', scope: 'G1', observedAt: T0 }] }, ctx(k1));
    const g1 = mk(core, [['星野小满', k1]]);
    const g2 = mk(core, [['我', '']]);
    const g3 = mk(core, [['老周', k1]]);
    const g4 = mk(core, [['阿明你好', k1]]);            // 「@阿明你好」：名字和问候粘在一起
    const g5 = mk(core, [['大家', k1]]);
    const spoke = mk(core, [['小红', k1]]);
    percept(core, { actor: spoke, at: T0 });
    const withAcct = E.resolveActor(core, member('u-gang-03', '小刚', 'G1'), ctx(k1)).entityId;
    const described = mk(core, [['小李', k1]]);
    insertRow(core, 'entity_descriptors', { entity_id: described, anchor_entity_id: withAcct, relation: E.normalizeName('表哥'), text: '表哥', basis: 'third-party', first_at: T0, last_at: T0, created_at: T0 });
    const r = E.repairMentionGhosts(core);
    assert.deepEqual(r, { retracted: 5, linked: 0 });
    assert.deepEqual([g1, g2, g3, g4, g5].map((id) => st(core, id)), Array(5).fill('retracted'));
    assert.equal(st(core, spoke), 'provisional', '说过话的不动');
    assert.equal(st(core, withAcct), 'provisional', '有账号的不动');
    assert.equal(st(core, described), 'provisional', '有关系描述的不动');
    assert.deepEqual(E.repairMentionGhosts(core), { retracted: 0, linked: 0 }, '幂等');
    assert.equal(metric(core, 'entities.ghost.retracted'), 5);
    assert.equal(metric(core, 'entities.ghost.refCheckError'), 0, '「有没有东西指着它」的每一条查询都跑得通');
  } finally { await t.cleanup(); }
});

test('修复：「@名字」造出来的档案有东西指着（事实、情节、意图、印象、谁知道、规则……）→ 不撤；名字正好是这里一个有账号的人的名片 → 和他挂 same（信念层）', async () => {
  const t = await entitiesCore({ name: 'ghost-refs' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    const me = E.ensureSelf(core);
    const k1 = core.keys.settingKey(ADAPTER, 'G1');
    // 每一种「指着它」各造一个
    const refs = {
      fact: (id) => fact(core, { subject: id, speaker: me }),
      object: (id) => insertRow(core, 'assertions', { predicate: 'note', text: '某事', kind_hint: 'fact', certainty: 'stated', confidence: 0.6, imp: 5, object_entity_id: id, recorded_at: T0, created_at: T0, updated_at: T0 }),
      episode: (id) => insertRow(core, 'episodes', { setting_key: k1, participants_json: JSON.stringify([me, id]), created_at: T0, updated_at: T0 }),
      intention: (id) => insertRow(core, 'intentions', { target_entity_id: id, act: '问候', origin: 'self-care', formed_at: T0, created_at: T0, updated_at: T0 }),
      anchor: (id) => insertRow(core, 'entity_descriptors', { entity_id: me, anchor_entity_id: id, relation: E.normalizeName('朋友'), text: '朋友', basis: 'third-party', first_at: T0, last_at: T0, created_at: T0 }),
      impression: (id) => insertRow(core, 'entity_impressions', { entity_id: id, layer: 'shared', text: '印象', version: 1, built_at: T0 }),
      knownBy: (id) => insertRow(core, 'known_by', { owner_kind: 'episode', owner_id: 1, who_kind: 'entity', who_ref: String(id), basis: 'presence', since: T0 }),
      rule: (id) => insertRow(core, 'rules', { kind: 'do_not_remember', target_json: JSON.stringify({ entityId: id }), created_by: 'owner', at: T0 }),
      presence: (id) => insertRow(core, 'presence_sets', { setting_key: k1, at: T0, members_json: JSON.stringify([id]), completeness: 'exact' }),
      suppressed: (id) => insertRow(core, 'suppressions', { owner_kind: 'entity', owner_id: id, state: 'hidden', by: 'owner', at: T0 }),
      maybe: (id) => E.link(core, id, mk(core, [['某人', k1]], { kind: 'mention' }), { rel: 'maybe_same', confidence: 0.6, evidence: [], decidedBy: 'sleep' }),
    };
    const kept = {};
    for (const [k, fn] of Object.entries(refs)) { kept[k] = mk(core, [[`路人${k}`, k1]]); fn(kept[k]); }
    // 被 @ 时还没被平台认出来的小林：「@小林」造了一个档，事实挂在上面；后来小林带着账号和这个群的名片说话了
    const early = mk(core, [['小林', k1]]);
    fact(core, { subject: early, speaker: me });
    const lin = E.resolveActor(core, member('u-lin-01', '小林', 'G1'), ctx(k1)).entityId;
    // 名字是两个有账号的人的名片：分不清，不挂
    const twin = mk(core, [['阿杰', k1]]);
    fact(core, { subject: twin, speaker: me });
    E.resolveActor(core, member('u-jie-01', '阿杰', 'G1'), ctx(k1));
    E.resolveActor(core, member('u-jie-02', '阿杰', 'G1'), ctx(k1));
    const r = E.repairMentionGhosts(core);
    assert.equal(r.retracted, 0, JSON.stringify(Object.fromEntries(Object.entries(kept).map(([k, id]) => [k, st(core, id)]))));
    for (const [k, id] of Object.entries(kept)) assert.notEqual(st(core, id), 'retracted', `有东西指着（${k}）：不撤`);
    assert.equal(st(core, early), 'provisional');
    assert.deepEqual(linkOf(core, early, lin), { rel: 'same', decided_by: 'extractor', confidence: 0.9, evidence_json: '["platform-name"]' });
    assert.equal(E.rightsHolder(core, early, lin), false, '信念层，不给权利');
    assert.equal(E.belief(core, lin, early).rel, 'same');
    assert.equal(r.linked, 1);
    assert.equal(st(core, twin), 'provisional');
    assert.deepEqual(E.repairMentionGhosts(core), { retracted: 0, linked: 0 }, '幂等');
  } finally { await t.cleanup(); }
});

test('修复：提炼造出来的重复档案（名字全是别人叫的，正好是这里一个有账号的人的名片）→ 和他挂 same、不撤；别的群、两个人、夜间整理已经判过的不挂', async () => {
  const t = await entitiesCore({ name: 'ghost-dups' });
  try {
    const { core, rec } = t;
    const E = core.mods.entities;
    const me = E.ensureSelf(core);
    const k1 = core.keys.settingKey(ADAPTER, 'G1');
    const k2 = core.keys.settingKey(ADAPTER, 'G2');
    const lin = E.resolveActor(core, member('u-lin-01', '小林', 'G1'), ctx(k1)).entityId;
    const ming = E.resolveActor(core, member('u-ming-01', '阿明', 'G1'), ctx(k1)).entityId;
    E.resolveActor(core, member('u-jie-01', '阿杰', 'G1'), ctx(k1));
    E.resolveActor(core, member('u-jie-02', '阿杰', 'G1'), ctx(k1));
    const dup = mk(core, [['小林', k1]], { kind: 'mention' });
    fact(core, { subject: dup, speaker: lin });
    const elsewhere = mk(core, [['小林', k2]], { kind: 'mention' });     // 别的群里有人叫「小林」：不一定是他
    const twin = mk(core, [['阿杰', k1]], { kind: 'mention' });
    const judged = mk(core, [['阿明', k1]], { kind: 'mention' });
    E.link(core, judged, ming, { rel: 'maybe_same', confidence: 0.6, evidence: [], decidedBy: 'sleep' });
    // 夜里先把两份重复档案互相认成了同一个，却都没挂到本人身上：两份都挂到本人
    const hua = E.resolveActor(core, member('u-hua-01', '小花', 'G1'), ctx(k1)).entityId;
    const d1 = mk(core, [['小花', k1]], { kind: 'mention' });
    const d2 = mk(core, [['小花', k1]], { kind: 'mention' });
    E.link(core, d1, d2, { rel: 'same', confidence: 0.9, evidence: [], decidedBy: 'sleep' });
    // 「@名字」造出来的档案后来又被提炼接着用（名片 + 别人叫的两种名字），上面没挂东西也不撤：名字正好是本人的名片 → 挂到本人
    const feng = E.resolveActor(core, member('u-feng-01', '阿峰', 'G1'), ctx(k1)).entityId;
    const mixed = mk(core, [['阿峰', k1]]);
    core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, used_by, first, last)
                    VALUES (?, ?, ?, ?, 'mention', ?, ?, ?)`, mixed, '阿峰', E.normalizeName('阿峰'), k1, feng, T0, T0);
    const normsBefore = rec.norms.length;
    const r = E.repairMentionGhosts(core);
    assert.deepEqual(r, { retracted: 0, linked: 4 });
    assert.equal(linkOf(core, d1, hua)?.rel, 'same');
    assert.equal(linkOf(core, d2, hua)?.rel, 'same');
    assert.equal(linkOf(core, d1, d2).decided_by, 'sleep', '两份之间夜里的判断不动');
    assert.equal(linkOf(core, mixed, feng)?.rel, 'same');
    assert.equal(st(core, mixed), 'provisional');
    assert.deepEqual(linkOf(core, dup, lin), { rel: 'same', decided_by: 'extractor', confidence: 0.9, evidence_json: '["platform-name"]' });
    assert.equal(st(core, dup), 'provisional', '不撤（事实挂在上面）');
    assert.equal(linkOf(core, elsewhere, lin), null);
    assert.equal(count(core, 'SELECT COUNT(*) AS n FROM entity_links WHERE a = ? OR b = ?', twin, twin), 0, '两个人都叫阿杰：不挂');
    assert.equal(linkOf(core, judged, ming).decided_by, 'sleep', '夜间整理的判断不被推翻');
    assert.equal(rec.norms.length, normsBefore, '只有一边有账号：不写身份对应的规范');
    assert.deepEqual(E.repairMentionGhosts(core), { retracted: 0, linked: 0 }, '幂等');
    void me;
  } finally { await t.cleanup(); }
});
