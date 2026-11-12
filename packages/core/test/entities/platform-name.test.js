// 提炼认人（D160）：平台在这个场合里就用这个名字显示一个有账号的人 → 这里说这个名字就是指他（scores.platformNameHere）；
// 模型说「新建」只是对给它看过的候选档案的判断，没给它看过的不打折。
//   实测的样子：说话人自己的群名片在这个群里，提炼给他也写了一行 ent（没写 "is":"U2"），裁决是 match:null、把握 0.7，
//   他是说话人、不在候选档案里——以前同名只算 0.6，「新建」又把它压到 θ_lo 以下，于是给他自己又立了一个档。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, T0 } from './helpers.js';

const NS = 'zq';
const member = (id, name, scope) => ({ claims: [{ kind: 'account', namespace: NS, id, verifiedBy: 'platform' }, { kind: 'display-name', name, scope, observedAt: T0 }] });

/** 一个场合里的一次提炼批次：说话人表 + msgRefs → 感知。 */
function batch(core, { settingKey, at = T0, speakers, lines, candidateCodes }) {
  const msgRefs = new Map();
  lines.forEach(([ref, actor], i) => msgRefs.set(ref, percept(core, { settingKey, actor, at: at + i * 1000 })));
  return { speakers: new Map(Object.entries(speakers)), settingKey, at, jobId: 1, msgRefs, ...(candidateCodes ? { candidateCodes } : {}) };
}
const ent = (name, confidence = 0.7) => [{ local: 'E1', name, kind: 'person', descriptor: null, msgRefs: ['m1'], verdict: { match: null, confidence } }];
const links = (core, id) => core.store.all('SELECT a, b, rel FROM entity_links WHERE a = ? OR b = ?', id, id).map((r) => ({ ...r }));

test('说话人自己的群名片（他说的话里提炼出一行叫他名片的 ent，模型说「新建」、他不在候选里）→ 认成他，不再给他立一个档', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'pn-speaker' });
  try {
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(NS, 'G1');
    const lin = E.resolveActor(core, member('u-lin-01', '小林', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const other = E.resolveActor(core, member('u-ming-01', '阿明', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const before = core.store.get('SELECT COUNT(*) AS n FROM entities').n;
    const ctx = batch(core, { settingKey: k1, speakers: { U2: lin }, lines: [['m1', lin]], candidateCodes: new Map([['c1', other]]) });
    const id = E.resolveExtracted(core, ent('小林'), ctx).get('E1');
    assert.equal(id, lin);
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM entities').n, before, '没有新建');
    // 别人说起小林（不是他自己说的）也一样：这个群里叫小林的就是他
    const ctx2 = batch(core, { settingKey: k1, speakers: { U3: other }, lines: [['m1', other]] });
    assert.equal(E.resolveExtracted(core, ent('小林', 0.9), ctx2).get('E1'), lin);
  } finally { await cleanup(); }
});

test('模型看过他、说「新建」：照旧打折（新建 + maybe_same）；别的群里的同名：只是同名；没有账号证据的名片：只是同名', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'pn-shown' });
  try {
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(NS, 'G1');
    const k2 = core.keys.settingKey(NS, 'G2');
    const lin = E.resolveActor(core, member('u-lin-01', '小林', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const ming = E.resolveActor(core, member('u-ming-01', '阿明', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    // 给模型看过小林（c1），它说这是另一个人：0.9 × (1 − 0.5 × 0.7) < θ_hi → 新建，留 maybe_same
    const seen = E.resolveExtracted(core, ent('小林'), batch(core, { settingKey: k1, speakers: { U3: ming }, lines: [['m1', ming]], candidateCodes: new Map([['c1', lin]]) })).get('E1');
    assert.notEqual(seen, lin);
    assert.deepEqual(links(core, seen).map((l) => l.rel), ['maybe_same']);
    // 别的群（G2）里有人说「小林」：名片只在 G1 有效，同名只算中等证据 → 新建
    const hong = E.resolveActor(core, member('u-hong-01', '小红', 'G2'), { adapterId: NS, settingKey: k2, at: T0 }).entityId;
    const there = E.resolveExtracted(core, ent('小林', 0.5), batch(core, { settingKey: k2, speakers: { U4: hong }, lines: [['m1', hong]] })).get('E1');
    assert.ok(![lin, seen].includes(there));
    // 只有名字说过话、没有账号的人：名片不是平台对账号的显示，同名只算中等证据
    const bare = E.resolveActor(core, { claims: [{ kind: 'display-name', name: '小周', scope: 'G1', observedAt: T0 }] }, { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const said = E.resolveExtracted(core, ent('小周', 0.5), batch(core, { settingKey: k1, speakers: { U3: ming }, lines: [['m1', ming]] })).get('E1');
    assert.notEqual(said, bare);
    assert.equal(E.belief(core, said, bare)?.rel, 'maybe_same', '没给模型看过：不打折，留一条 maybe_same');
  } finally { await cleanup(); }
});

test('同一个群里两个人的名片一样：谁都不挂（拉不开差距），新建 + 两条 maybe_same', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'pn-twins' });
  try {
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(NS, 'G1');
    const a = E.resolveActor(core, member('u-jie-01', '阿杰', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const b = E.resolveActor(core, member('u-jie-02', '阿杰', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const ming = E.resolveActor(core, member('u-ming-01', '阿明', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    const id = E.resolveExtracted(core, ent('阿杰'), batch(core, { settingKey: k1, speakers: { U3: ming }, lines: [['m1', ming]] })).get('E1');
    assert.ok(![a, b].includes(id));
    assert.equal(E.belief(core, id, a)?.rel, 'maybe_same');
    assert.equal(E.belief(core, id, b)?.rel, 'maybe_same');
  } finally { await cleanup(); }
});

test('导入（没有候选档案一栏）：名字表里唯一的人照样挂上；模型没看过任何档案，match:null 不打折', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'pn-import' });
  try {
    const E = core.mods.entities;
    E.ensureSelf(core);
    const k1 = core.keys.settingKey(NS, 'G1');
    const lin = E.resolveActor(core, member('u-lin-01', '小林', 'G1'), { adapterId: NS, settingKey: k1, at: T0 }).entityId;
    // encode.importRecords 的样子：speakers 为空、没有 msgRefs、没有 candidateCodes，名字认不出时 match:null、把握 0.5
    const id = E.resolveExtracted(core, [{ local: 'S1', name: '小林', kind: 'person', descriptor: null, msgRefs: [], verdict: { match: null, fullName: '小林', confidence: 0.5 } }],
      { speakers: new Map(), settingKey: k1, at: T0, jobId: null }).get('S1');
    assert.equal(id, lin);
  } finally { await cleanup(); }
});
