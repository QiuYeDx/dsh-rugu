// noteMention / setBond / setStatus / profile / bondOf / isIndividual / principals / userDictionary。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, person, DAY, T0 } from './helpers.js';

const NS = 'zq';

test('noteMention：last / first、在 ≥ 2 个不同的（本地）日子被提到 → established；每次都在档案上加一条痕迹（证据时间）', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'mention', config: { time: { tzOffsetMin: 480 } } });
  try {
    const E = core.mods.entities;
    const id = E.resolveExtracted(core, [{ local: 'E1', name: '咪咪', kind: 'pet', descriptor: null, msgRefs: [] }],
      { speakers: new Map(), settingKey: 'G', at: T0, jobId: 1 }).get('E1');
    const prov = E.profile(core, id);
    assert.equal(prov.status, 'provisional');
    // 同一个本地日子里再提一次：还是 provisional
    E.noteMention(core, id, { at: T0 + 3_600_000, w: 0.35, sourceKey: 'n9' });
    assert.equal(E.profile(core, id).status, 'provisional');
    // 迟到的旧提及（更早的一天）也算一天；last_mention_at 不倒退
    E.noteMention(core, id, { at: T0 - DAY, w: 0.6, sourceKey: 'n9' });
    const row = core.store.get('SELECT * FROM entities WHERE id = ?', id);
    assert.equal(row.status, 'established');
    assert.equal(row.last_mention_at, T0 + 3_600_000);
    assert.equal(row.first_mention_at, T0 - DAY);
    assert.equal(row.mention_days, 2);
    const tr = rec.traces.filter((t) => t.ref === `n${id}`);
    assert.deepEqual(tr.map((t) => [t.t, t.w, t.reason]), [[T0, 1, 'mention'], [T0 + 3_600_000, 0.35, 'mention'], [T0 - DAY, 0.6, 'mention']]);
    // 不存在的实体：不抛错，只计数
    E.noteMention(core, 99999, { at: T0, w: 1, sourceKey: 'x' });
    // dynamics 挂了也不让调用方的事务失败
    const { core: c2, cleanup: cl2 } = await entitiesCore({ name: 'mention-fail', mods: { dynamics: { addTrace: () => { throw new Error('down'); } } } });
    try {
      const x = person(c2, NS, 'u1', T0);
      c2.mods.entities.noteMention(c2, x, { at: T0, w: 1, sourceKey: 'x' });
      assert.ok(c2.store.get("SELECT value FROM metrics WHERE name = 'entities.trace.error'").value >= 1);
    } finally { await cl2(); }
  } finally { await cleanup(); }
});

test('setBond：亲密度夹在 0–1；权限只给具体的个人；她自己不能有管理权限', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'bond' });
  try {
    const E = core.mods.entities;
    const a = person(core, NS, 'u1', T0);
    E.setBond(core, a, { closeness: 1.7 });
    assert.equal(E.bondOf(core, a).closeness, 1);
    E.setBond(core, a, { closeness: 0.3, authority: 'delegated' });
    assert.deepEqual(E.bondOf(core, a), { closeness: 0.3, authority: 'delegated', isSelf: false });
    assert.throws(() => E.setBond(core, E.ensureSelf(core), { authority: 'principal' }), TypeError);
    const g = E.ensureSettingEntity(core, 'SK', { label: '某群', at: T0 });
    assert.throws(() => E.setBond(core, g, { authority: 'principal' }), TypeError);
    assert.throws(() => E.setBond(core, a, { authority: 'boss' }), TypeError);
    assert.throws(() => E.setBond(core, 99999, { closeness: 0.1 }), TypeError);
    assert.deepEqual(E.bondOf(core, 99999), { closeness: 0, authority: 'none', isSelf: false });
    // principals 只列 authority='principal'
    const p = E.ensurePrincipal(core);
    assert.deepEqual(E.principals(core), [p]);
    E.setBond(core, a, { authority: 'principal', closeness: 0.5 });
    assert.deepEqual(E.principals(core), [p, a], '按亲密度从高到低');
  } finally { await cleanup(); }
});

test('setStatus / isIndividual / profile：不含账号哈希以外的东西；链接带「有没有权利」', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'profile' });
  try {
    const E = core.mods.entities;
    const a = person(core, NS, 'uabc123', T0, '阿明');
    const b = person(core, 'zr', 'vxyz789', T0, '明哥');
    E.link(core, a, b, { rel: 'same', confidence: 1, evidence: [], decidedBy: 'mutual-claim', at: T0 });
    const prof = E.profile(core, a);
    assert.equal(prof.kind, 'person');
    assert.equal(prof.isSelf, false);
    assert.deepEqual(prof.names.map((n) => n.text), ['阿明']);
    assert.equal(prof.identities.length, 1);
    assert.deepEqual(Object.keys(prof.identities[0]).sort(), ['namespace', 'scope', 'strength']);
    assert.ok(!JSON.stringify(prof).includes('uabc123'));
    assert.deepEqual(prof.links, [{ other: b, rel: 'same', confidence: 1, decidedBy: 'mutual-claim', rights: true }]);
    assert.equal(E.isIndividual(core, a), true);
    assert.equal(E.isIndividual(core, E.ensureSelf(core)), false, '她自己不算「她以外的具体的人」');
    assert.equal(E.isIndividual(core, 0), false);
    assert.equal(E.isIndividual(core, 99999), true, '查不到的按「是」算（宁严）');
    E.setStatus(core, a, 'retracted');
    assert.equal(E.profile(core, a).status, 'retracted');
    assert.throws(() => E.setStatus(core, a, 'gone'), TypeError);
    assert.equal(E.profile(core, 99999), null);
  } finally { await cleanup(); }
});

test('userDictionary：实体别名（常用的在前），不含单字、撤掉的、冒用保留名的', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'dict' });
  try {
    const E = core.mods.entities;
    E.ensurePrincipal(core);
    const a = person(core, NS, 'u1', T0, '阿明');
    person(core, NS, 'u1', T0 + 1, '阿明');
    person(core, NS, 'u2', T0, '王');
    const c = person(core, NS, 'u3', T0, '老张');
    person(core, NS, 'u4', T0, '主人');   // 冒用
    E.setStatus(core, c, 'retracted');
    const words = E.userDictionary(core);
    assert.ok(words.includes('阿明'));
    assert.ok(words.includes('主人'), '主人的保留名本身在');
    assert.ok(!words.includes('王'));
    assert.ok(!words.includes('老张'));
    assert.equal(words.filter((w) => w === '主人').length, 1);
    assert.ok(a > 0);
  } finally { await cleanup(); }
});
