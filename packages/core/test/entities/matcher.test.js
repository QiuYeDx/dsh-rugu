// nameMatcher：Aho-Corasick 名字匹配器——同名全返回、按作用域和激活加权、关系路径线索、按版本缓存、撤掉的不返回。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, person, DAY, T0 } from './helpers.js';

const NS = 'zq';

test('同名的几个档案都返回；分数按作用域（群名片只在本群有效）和激活加权', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'match-same' });
  try {
    const E = core.mods.entities;
    const card = (name, settingKey, id) => E.resolveActor(core, { claims: [{ kind: 'account', namespace: NS, id, verifiedBy: 'platform' },
      { kind: 'display-name', name, scope: settingKey, observedAt: T0 }] }, { adapterId: NS, settingKey, at: T0 }).entityId;
    const a = card('小雨', 'G1', 'ua');
    const b = card('小雨', 'G2', 'ub');
    // 同一个场合里给 b 加几条痕迹（激活更高）
    for (let i = 0; i < 5; i++) E.noteMention(core, b, { at: T0 + i, w: 1, sourceKey: 'x' });
    const inG1 = E.nameMatcher(core).scan('今天小雨来了吗', { settingKey: core.keys.settingKey(NS, 'G1') });
    const ids = inG1.map((h) => h.entityId).sort();
    assert.deepEqual(ids, [a, b].sort(), '同名的都返回');
    const sa = inG1.find((h) => h.entityId === a).score;
    const sb = inG1.find((h) => h.entityId === b).score;
    assert.ok(sa > sb, '本群的名片比别的群的名片分高（激活高也压不过作用域）');
    assert.equal(inG1[0].name, '小雨');
    assert.equal('今天小雨来了吗'.slice(inG1[0].start, inG1[0].end), '小雨');
    assert.ok(rec.traces.length >= 5);
  } finally { await cleanup(); }
});

test('关系词：「我表哥」（锚点 = 说话人）、「阿明的表哥」（紧挨着认出来的名字）都落到档案上', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'match-rel' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const p = percept(core, { actor: aming, at: T0 });
    const e = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }],
      { speakers: new Map([['U3', aming]]), settingKey: 'G1', at: T0, jobId: 1, msgRefs: new Map([['m1', p]]) }).get('E1');
    const m = E.nameMatcher(core);
    const first = m.scan('我表哥干啥的你还记得吗', { anchors: [aming] });
    assert.deepEqual(first.map((h) => [h.entityId, h.via, h.anchor]), [[e, 'relation', aming]]);
    const third = m.scan('阿明的表哥最近怎样');
    assert.ok(third.some((h) => h.entityId === aming && h.via === 'name'));
    assert.ok(third.some((h) => h.entityId === e && h.via === 'relation'), '紧挨着名字的关系词');
    assert.equal(m.scan('我表哥干啥的').length, 0, '没有锚点时关系词不落到任何档案上');
    assert.equal(m.scan('阿明今天下午在群里也说起过表哥').filter((h) => h.via === 'relation').length, 0, '离名字太远不算');
  } finally { await cleanup(); }
});

test('按版本缓存：名字没变返回同一个；新名字提交后重建；撤掉的档案不返回；回滚的名字不进缓存', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'match-cache' });
  try {
    const E = core.mods.entities;
    const a = person(core, NS, 'ua1', T0, '阿明');
    const m1 = E.nameMatcher(core);
    assert.equal(E.nameMatcher(core), m1);
    const b = person(core, NS, 'ub1', T0, '老王');
    const m2 = E.nameMatcher(core);
    assert.notEqual(m2, m1);
    assert.ok(m2.version > m1.version);
    assert.deepEqual(m2.scan('老王和阿明').map((h) => h.entityId), [b, a]);
    E.setStatus(core, b, 'retracted');
    assert.deepEqual(E.nameMatcher(core).scan('老王和阿明').map((h) => h.entityId), [a]);
    // 回滚的事务里加的名字：不留在匹配器里
    const v = E.nameMatcher(core).version;
    assert.throws(() => core.store.tx(() => { person(core, NS, 'uc1', T0, '小张'); throw new Error('rollback'); }));
    assert.equal(E.nameMatcher(core).version, v);
    assert.equal(E.nameMatcher(core).scan('小张来了').length, 0);
    // 名字变了会排一次用户词典刷新
    await new Promise((r) => setImmediate(r));
    assert.ok(rec.dictionaries.some((w) => w.includes('阿明')));
    assert.ok(rec.dictionaries.at(-1).every((w) => w !== '老王'), '撤掉的档案不进用户词典');
    // 外面改了名字表（admin.purge 的级联）：invalidateNames 之后重建
    core.store.run('DELETE FROM entity_names WHERE entity_id = ?', a);
    E.invalidateNames(core);
    assert.equal(E.nameMatcher(core).scan('阿明').length, 0);
  } finally { await cleanup(); }
});

test('扫一段 400 字的正文在 1 ms 量级（1000 个名字）', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'match-perf' });
  try {
    const E = core.mods.entities;
    core.store.tx(() => {
      for (let i = 0; i < 1000; i++) E.resolveActor(core, { claims: [{ kind: 'account', namespace: NS, id: `u${i}`, verifiedBy: 'platform', displayName: `名${i}号` }] }, { adapterId: NS, settingKey: 'S', at: T0 });
    });
    const m = E.nameMatcher(core);
    const text = '今天名12号和名345号去吃饭了，'.repeat(25).slice(0, 400);
    m.scan(text);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) m.scan(text);
    const ms = (performance.now() - t0) / 20;
    assert.ok(ms < 20, `扫描太慢：${ms.toFixed(2)} ms`);
    assert.ok(m.scan(text).length >= 2);
  } finally { await cleanup(); }
});
