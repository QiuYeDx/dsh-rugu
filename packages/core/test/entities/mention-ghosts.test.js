// 提及造出来的「假人」（D108，实测问题 #17）：她的群名片、「@我」被认成了别的人，主人 @她 定的规则因此被当成「点了别人的名」。
//   - resolveActor(role = 'mention')：只有名字的提及对上她自己的名字（任何场合）→ 她；对上这里有管理权限的人 → 他；不记名字（提及不给权利）；
//     名字不到 2 个字的不认、不新建；只靠名字永远不新建一个和她同名的人；
//   - repairMentionGhosts：从没说过话、除了名字没有身份证据、名字全是她 / 主人的名字或都不到 2 个字的 → 撤掉（幂等，不写死 id）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, T0 } from './helpers.js';

const ADAPTER = 'zq';
const ctx = (settingKey) => ({ adapterId: ADAPTER, settingKey, at: T0 });
const named = (name, scope) => ({ claims: [{ kind: 'display-name', name, ...(scope ? { scope } : {}), observedAt: T0 }] });

test('提及：她的群名片 → 她自己（不记名字、不新建）；主人的群名片 → 主人；「我」不认；说话人用她的名字也不新建一个她', async () => {
  const t = await entitiesCore({ name: 'ghost-mention' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    const me = E.ensureSelf(core);
    const boss = E.ensurePrincipal(core);
    // 她在群 G1 的群名片、主人在 G1 的群名片（各自说话时记下的）
    E.resolveActor(core, { self: true, claims: [{ kind: 'display-name', name: '星野小满', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    E.resolveActor(core, { claims: [{ kind: 'principal' }, { kind: 'display-name', name: '老周', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    const before = core.store.get('SELECT COUNT(*) AS n FROM entities').n;
    const r1 = E.resolveActor(core, named('星野小满', 'G1'), { ...ctx('k1'), role: 'mention' });
    assert.equal(r1.entityId, me);
    assert.equal(r1.via, 'mention-self');
    // 在别的群里也认得（她的名字不限场合）
    assert.equal(E.resolveActor(core, named('星野小满', 'G2'), { ...ctx('k2'), role: 'mention' }).entityId, me);
    assert.equal(E.resolveActor(core, named('老周', 'G1'), { ...ctx('k1'), role: 'mention' }).entityId, boss, '主人的群名片 → 主人');
    assert.equal(E.resolveActor(core, named('我', 'G1'), { ...ctx('k1'), role: 'mention' }).entityId, null, '「@我」不认、不新建');
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM entities').n, before, '没有新建任何人');
    assert.equal(core.store.get("SELECT COUNT(*) AS n FROM entity_names WHERE text_raw = '星野小满' AND entity_id <> ?", me).n, 0, '提及不记名字');
    // 说话人（不是提及）只有她的名字：不认成她（保留名不能被冒用），也不新建一个叫她名字的人
    const r2 = E.resolveActor(core, named('星野小满', 'G3'), ctx('k3'));
    assert.equal(r2.entityId, null);
    // 普通的名字照常新建
    const r3 = E.resolveActor(core, named('阿明', 'G1'), { ...ctx('k1'), role: 'mention' });
    assert.ok(r3.entityId && r3.entityId !== me && r3.entityId !== boss);
  } finally { await t.cleanup(); }
});

test('修复：撤掉以前造出来的假人（她的名字、主人的名字、不到 2 个字的），说过话的、有账号的、有关系描述的不动；再跑一遍什么都不做', async () => {
  const t = await entitiesCore({ name: 'ghost-repair' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    E.ensureSelf(core);
    E.resolveActor(core, { self: true, claims: [{ kind: 'display-name', name: '星野小满', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    E.resolveActor(core, { claims: [{ kind: 'principal' }, { kind: 'display-name', name: '老周', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    // 旧版本留下的假人：直接写库（模拟修好以前的那几行）
    const mk = (name, scope) => {
      const id = Number(core.store.run("INSERT INTO entities(kind, status, individual, created_at, updated_at) VALUES ('person', 'provisional', 1, ?, ?)", T0, T0).lastInsertRowid);
      core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, first, last)
                      VALUES (?, ?, ?, ?, 'card', ?, ?)`, id, name, E.normalizeName(name), scope, T0, T0);
      return id;
    };
    const g1 = mk('星野小满', core.keys.settingKey(ADAPTER, 'G1'));
    const g2 = mk('我', '');
    const g3 = mk('老周', core.keys.settingKey(ADAPTER, 'G1'));
    const real = mk('阿明', core.keys.settingKey(ADAPTER, 'G1'));
    const spoke = mk('星野小满', core.keys.settingKey(ADAPTER, 'G9'));
    percept(core, { actor: spoke, at: T0 });
    const r = E.repairMentionGhosts(core);
    assert.equal(r.retracted, 3);
    const st = (id) => core.store.get('SELECT status FROM entities WHERE id = ?', id).status;
    assert.deepEqual([st(g1), st(g2), st(g3)], ['retracted', 'retracted', 'retracted']);
    assert.equal(st(real), 'provisional', '普通的名字不动');
    assert.equal(st(spoke), 'provisional', '说过话的不动');
    assert.equal(E.repairMentionGhosts(core).retracted, 0, '幂等');
    assert.ok(Number(core.store.get("SELECT SUM(value) AS v FROM metrics WHERE name = 'entities.ghost.retracted'")?.v ?? 0) >= 3);
  } finally { await t.cleanup(); }
});

test('修复（实测库的样子）：她自己的档案里还没有这个群名片——每个名字出现的地方全是「@名字」叫她的，就是她的名片造出来的假人，撤掉；她第一次带着这个名片说话时当场撤（不等重启）', async () => {
  const t = await entitiesCore({ name: 'ghost-card' });
  try {
    const { core } = t;
    const E = core.mods.entities;
    const me = E.ensureSelf(core);
    const card = '星野小满';
    const mk = (name) => {
      const id = Number(core.store.run("INSERT INTO entities(kind, status, individual, created_at, updated_at) VALUES ('person', 'established', 1, ?, ?)", T0, T0).lastInsertRowid);
      core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, first, last)
                      VALUES (?, ?, ?, '', 'card', ?, ?)`, id, name, E.normalizeName(name), T0, T0);
      return id;
    };
    const ghost = mk(card);
    const lurker = mk('阿明');
    // 每条「@她的名片」都是对她说的、提及里认成了她
    const at = (text, mentions, addressed = 'mentions-her') => {
      const id = percept(core, { at: T0, text });
      core.store.run('UPDATE percepts SET addressed = ?, mentions_json = ? WHERE id = ?', addressed, JSON.stringify(mentions), id);
    };
    at(`@${card} 我说一个数字你回复乘3的值`, [{ self: true, actor: { claims: [] } }]);
    at(`@${card} 7`, [{ self: true, actor: { claims: [{ kind: 'display-name', name: card }] } }]);
    // 「阿明」只在一句叫她的话里被顺带 @ 了一下：那一处提及认成她的不是「阿明」，不撤
    at(`@${card} @阿明 你们俩聊`, [{ self: true, actor: { claims: [{ kind: 'display-name', name: card }] } }, { actor: { claims: [{ kind: 'display-name', name: '阿明' }] } }]);
    const r = E.repairMentionGhosts(core);
    assert.equal(r.retracted, 1, JSON.stringify(r));
    const st = (id) => core.store.get('SELECT status FROM entities WHERE id = ?', id).status;
    assert.equal(st(ghost), 'retracted');
    assert.equal(st(lurker), 'established', '只是被顺带 @ 的人不动');
    // 另一个假人：她第一次带着这个名片在群里说话时当场撤
    const ghost2 = mk('月见');
    at('@月见 在吗', [{ self: true, actor: { claims: [] } }]);
    // 名字在别的地方被当成普通的名字说过（不是叫她）：不撤
    const other = percept(core, { at: T0, text: '月见今天没来' });
    void other;
    assert.equal(E.repairMentionGhosts(core).retracted, 0, '有一处不是在叫她：不撤');
    core.store.run("DELETE FROM percepts WHERE text = '月见今天没来'");
    E.resolveActor(core, { self: true, claims: [{ kind: 'display-name', name: '月见', scope: 'G1', observedAt: T0 }] }, ctx('k1'));
    assert.equal(st(ghost2), 'retracted', '她有了这个名字：当场撤掉同名的假人');
    void me;
  } finally { await t.cleanup(); }
});
