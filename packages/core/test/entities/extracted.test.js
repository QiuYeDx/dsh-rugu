// resolveExtracted：关系路径（第 2 步）、别名（第 3 步）、LLM 裁决（第 5 步）、θ_hi / θ_lo / maybe_same、锚点冲突、自我介绍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesCore, percept, person, DAY, T0 } from './helpers.js';

const NS = 'zq';

/** 一个场合里的一次提炼批次：说话人表 + msgRefs → 感知。 */
function batch(core, { settingKey = 'G1', at, speakers, lines }) {
  const msgRefs = new Map();
  lines.forEach(([ref, actor, wEnc = 1], i) => msgRefs.set(ref, percept(core, { settingKey, actor, at: at + i * 1000, wEnc })));
  return { speakers: new Map(Object.entries(speakers)), settingKey, at, jobId: Math.floor(at / 1000), msgRefs };
}

test('关系路径：「我表哥」立档（没有名字也行）；之后「我表哥小刚」挂到同一个档案；痕迹按感知的编码强度加（听说不打折）', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'ext-rel' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const c1 = batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming, 1.0]] });
    const r1 = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c1);
    const e = r1.get('E1');
    assert.ok(Number.isInteger(e));
    const prof = E.profile(core, e);
    assert.equal(prof.displayName, null, '没有名字也能立档');
    assert.deepEqual(prof.descriptors.map((d) => [d.anchor, d.text, d.basis]), [[aming, '表哥', 'first-person']]);
    assert.equal(prof.status, 'provisional');
    const tr = rec.traces.find((t) => t.ref === `n${e}`);
    assert.equal(tr.w, 1.0, '对她说的听说：痕迹权重不打折');
    assert.equal(tr.reason, 'mention');
    assert.equal(tr.sourceKey, `n${aming}`);
    // 两天后：「我表哥小刚又换车了」
    const c2 = batch(core, { at: T0 + 2 * DAY, speakers: { U3: aming }, lines: [['m1', aming, 0.35]] });
    const r2 = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c2);
    assert.equal(r2.get('E1'), e, '挂到同一个档案');
    const p2 = E.profile(core, e);
    assert.equal(p2.displayName, '小刚');
    assert.equal(p2.status, 'established', '在 ≥ 2 个不同的日子被提到');
    assert.equal(rec.traces.filter((t) => t.ref === `n${e}`).at(-1).w, 0.35, '旁听的编码强度照传');
  } finally { await cleanup(); }
});

test('同一锚点可以有多个同关系的档案：名字对不上 → 新档案；「另一个表哥」LLM 说新建 → 新档案', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-two' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const c = (at) => batch(core, { at, speakers: { U3: aming }, lines: [['m1', aming]] });
    const xg = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c(T0)).get('E1');
    const xl = E.resolveExtracted(core, [{ local: 'E1', name: '小李', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c(T0 + DAY)).get('E1');
    assert.notEqual(xl, xg, '阿明的两个表哥：小刚 ≠ 小李');
    assert.equal(E.belief(core, xl, xg), null, '名字冲突不挂 maybe_same');
    const third = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'],
      verdict: { match: null, confidence: 0.9 } }], c(T0 + 2 * DAY)).get('E1');
    assert.ok(![xg, xl].includes(third), 'LLM 判「新建」');
    // 两个都没名字的同关系档案之外再来一次无名提及：拿不准 → 新建 + maybe_same（不硬合并）
    const fourth = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c(T0 + 3 * DAY)).get('E1');
    assert.ok(![xg, xl, third].includes(fourth));
    assert.equal(E.belief(core, fourth, third)?.rel, 'maybe_same');
    // 带名字的那次能挑出对的那个
    const again = E.resolveExtracted(core, [{ local: 'E1', name: '小李', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c(T0 + 4 * DAY)).get('E1');
    assert.equal(again, xl);
  } finally { await cleanup(); }
});

test('锚点冲突：阿明的表哥和 B 的表哥默认不是同一个人（同名也不挂、LLM 也推翻不了）；已知有关系时不算冲突', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-anchor' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const bb = person(core, NS, 'ub1', T0, '小B');
    const ca = batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] });
    const ea = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], ca).get('E1');
    const cb = batch(core, { at: T0 + DAY, speakers: { U4: bb }, lines: [['m1', bb]] });
    const eb = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U4', relation: '表哥' }, msgRefs: ['m1'],
      verdict: { match: ea, confidence: 0.99 } }], cb).get('E1');
    assert.notEqual(eb, ea);
    assert.equal(E.belief(core, ea, eb), null, '默认 not_same：连 maybe_same 都不挂');
    // candidates 里是负分
    const cands = await E.candidates(core, { name: '小刚', context: '我表哥小刚', anchorEntityId: bb, relation: '表哥' });
    const forA = cands.find((c) => c.entityId === ea);
    assert.ok(forA && forA.score < 0.5 && forA.why.includes('anchor-conflict'));
    // 已知阿明和小 C 是亲戚（小 C 是阿明的弟弟）：小 C 的表哥小刚不算冲突
    const cc = person(core, NS, 'uc1', T0, '小C');
    const c3 = batch(core, { at: T0 + 2 * DAY, speakers: { U3: aming, U5: cc }, lines: [['m1', aming]] });
    E.resolveExtracted(core, [{ local: 'E2', name: '小C', kind: 'person', descriptor: { anchor: 'U3', relation: '弟弟' }, msgRefs: ['m1'], verdict: { match: cc, confidence: 0.95 } }], c3);
    const c4 = batch(core, { at: T0 + 3 * DAY, speakers: { U5: cc }, lines: [['m1', cc]] });
    const ec = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U5', relation: '表哥' }, msgRefs: ['m1'] }], c4).get('E1');
    const b = ec === ea ? { rel: 'same' } : E.belief(core, ec, ea);
    assert.ok(b && b.rel !== 'not_same', '有关系的锚点：可能是同一个人（交给证据）');
  } finally { await cleanup(); }
});

test('别名：同名只是中等证据 → 新建 + maybe_same；同一个人在同一个场合又这样叫 → 挂上；LLM 同意 → 挂上', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-name' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const wang = person(core, NS, 'uw1', T0, '老王');
    const c = (speaker, settingKey, at) => batch(core, { settingKey, at, speakers: { U1: speaker }, lines: [['m1', speaker]] });
    const e = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U1', relation: '表哥' }, msgRefs: ['m1'] }], c(aming, 'G1', T0)).get('E1');
    // 另一个群里有人提到「小刚」：名字对得上，但场合不同、也没有阿明 → 新建临时档案 F + maybe_same
    const f = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: null, msgRefs: ['m1'] }], c(wang, 'G2', T0 + 14 * DAY)).get('E1');
    assert.notEqual(f, e);
    const b = E.belief(core, f, e);
    assert.equal(b.rel, 'maybe_same');
    assert.ok(b.confidence > 0.5 && b.confidence < 0.85);
    assert.equal(E.rightsHolder(core, f, e), false, '认得 ≠ 权利');
    // 阿明自己在 G1 又说「小刚」（没带关系）：同一个人在同一个场合这样叫过他 → 挂上
    const g = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: null, msgRefs: ['m1'] }], c(aming, 'G1', T0 + 15 * DAY)).get('E1');
    assert.equal(g, e);
    // G2 里再提「小刚」，LLM 看了上下文说就是 F
    const h = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: null, msgRefs: ['m1'], verdict: { match: f, confidence: 0.95, fullName: '刘小刚' } }], c(wang, 'G2', T0 + 16 * DAY)).get('E1');
    assert.equal(h, f);
    assert.equal(E.profile(core, f).displayName, '刘小刚', 'LLM 给的「最完整的名字」');
  } finally { await cleanup(); }
});

test('本批里的锚点可以是另一个 local（「阿明的表哥的女儿」）；她自己当锚点（「我」）；锚点环被打断', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-local' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const self = E.ensureSelf(core);
    const c = batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] });
    const out = E.resolveExtracted(core, [
      { local: 'E2', name: '妞妞', kind: 'person', descriptor: { anchor: 'E1', relation: '女儿' }, msgRefs: ['m1'] },
      { local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] },
      { local: 'E3', name: '咪咪', kind: 'pet', descriptor: { anchor: '我', relation: '猫' }, msgRefs: ['m1'] },
      { local: 'E4', name: '甲', kind: 'person', descriptor: { anchor: 'E5', relation: '朋友' }, msgRefs: ['m1'] },
      { local: 'E5', name: '乙', kind: 'person', descriptor: { anchor: 'E4', relation: '朋友' }, msgRefs: ['m1'] },
    ], c);
    const e1 = out.get('E1');
    assert.deepEqual(E.profile(core, out.get('E2')).descriptors.map((d) => d.anchor), [e1]);
    assert.deepEqual(E.profile(core, out.get('E3')).descriptors.map((d) => d.anchor), [self]);
    assert.equal(E.isIndividual(core, out.get('E3')), false, '宠物不是具体的个人');
    assert.ok(out.has('E4') && out.has('E5'), '环里的两行都落成了实体');
    const d4 = E.profile(core, out.get('E4')).descriptors.length + E.profile(core, out.get('E5')).descriptors.length;
    assert.equal(d4, 1, '环被打断：只留一条描述');
  } finally { await cleanup(); }
});

test('坏行只丢这一行；空行（没名字、没关系、没裁决）不建档；不认识的锚点去掉描述', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-bad' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const c = batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] });
    const out = E.resolveExtracted(core, [
      { local: 'E1', name: null, kind: 'person', descriptor: null, msgRefs: ['m1'] },
      { local: 'E2', name: '小刚', kind: 'person', descriptor: { anchor: 'U9', relation: '表哥' }, msgRefs: ['m1'] },
      null,
      { local: 'E3', name: '阿花', kind: 'person', descriptor: null, msgRefs: ['m9'] },
    ], c);
    assert.equal(out.has('E1'), false);
    assert.equal(E.profile(core, out.get('E2')).descriptors.length, 0);
    assert.ok(out.has('E3'), '找不到的 msgRef 不影响建档');
    assert.equal(E.resolveExtracted(core, [], c).size, 0);
  } finally { await cleanup(); }
});

test('自我介绍：「我是阿明的表哥」只产生 maybe_same，不给权利；阿明本人确认（anchor-confirmed）后才有权利', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-intro' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const c1 = batch(core, { at: T0, speakers: { U3: aming }, lines: [['m1', aming]] });
    const e = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c1).get('E1');
    const xg = person(core, NS, 'ux1', T0 + 30 * DAY, '刚子');
    const c2 = batch(core, { settingKey: 'G2', at: T0 + 30 * DAY, speakers: { U3: aming, U5: xg }, lines: [['m1', xg]] });
    const r = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', speaker: 'U5', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c2);
    assert.equal(r.get('E1'), xg, '自我介绍这一行就是说话人自己');
    assert.equal(E.belief(core, xg, e).rel, 'maybe_same', '认得出来（口吻上「哦你就是小刚呀」）');
    assert.equal(E.rightsHolder(core, xg, e), false, '但认出来不等于给权利');
    assert.ok(E.profile(core, xg).descriptors.some((d) => d.basis === 'self-claim'));
    // 自称的描述不会让「阿明的表哥」以后被挂到自称者身上
    const c3 = batch(core, { at: T0 + 31 * DAY, speakers: { U3: aming }, lines: [['m1', aming]] });
    assert.equal(E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], c3).get('E1'), e);
    // 阿明当面确认「对，这是我表哥」（encode 的 confirm 行 → link anchor-confirmed）
    E.link(core, xg, e, { rel: 'same', confidence: 1, evidence: ['p1'], decidedBy: 'anchor-confirmed', at: T0 + 32 * DAY });
    assert.equal(E.rightsHolder(core, xg, e), true);
  } finally { await cleanup(); }
});

test('没有 msgRefs 时：锚点本人在这段对话里也算可靠；痕迹权重用 ctx.w', async () => {
  const { core, cleanup, rec } = await entitiesCore({ name: 'ext-nomsg' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const ctx = { speakers: new Map([['U3', aming]]), settingKey: 'G1', at: T0, jobId: 1, w: 0.6 };
    const e = E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], ctx).get('E1');
    const e2 = E.resolveExtracted(core, [{ local: 'E1', name: '小刚', kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], { ...ctx, at: T0 + DAY }).get('E1');
    assert.equal(e2, e);
    assert.equal(rec.traces.find((t) => t.ref === `n${e}`).w, 0.6);
  } finally { await cleanup(); }
});

test('多条独立描述吻合：要不同的、established 的说话人，跨 ≥ 2 天（几个小号凑不出来）', async () => {
  const { core, cleanup } = await entitiesCore({ name: 'ext-corrob' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const s1 = person(core, NS, 'us1', T0, '甲');
    const s2 = person(core, NS, 'us2', T0, '乙');
    // 旁人说「阿明的表哥」（阿明不在这段对话里）：第一次立档
    const third = (speaker, at) => batch(core, { at, speakers: { U1: speaker, U3: aming }, lines: [['m1', speaker]] });
    const mk = (speaker, at) => E.resolveExtracted(core, [{ local: 'E1', name: null, kind: 'person', descriptor: { anchor: 'U3', relation: '表哥' }, msgRefs: ['m1'] }], third(speaker, at)).get('E1');
    const e = mk(s1, T0);
    // 两个刚出现的小号（provisional）在同一天说：凑不出来
    assert.equal(E.descriptorSupport(core, e, aming, '表哥').qualifies, false);
    // 甲、乙都在不同的日子出现过（established），再在不同的日子各说一次：吻合
    person(core, NS, 'us1', T0 + DAY, '甲');
    person(core, NS, 'us2', T0 + DAY, '乙');
    mk(s2, T0 + 2 * DAY);
    const sup = E.descriptorSupport(core, e, aming, '表哥');
    assert.equal(sup.speakers >= 2 && sup.days >= 2, true);
    assert.equal(sup.qualifies, true);
  } finally { await cleanup(); }
});

test('中文短名不按字符串合并（「小鱼干」≠「小鱼」）；种类对不上（人 vs 宠物）只靠名字不合并', async () => {
  const { core, cleanup, ports } = await entitiesCore({ name: 'ext-short' });
  try {
    const E = core.mods.entities;
    const aming = person(core, NS, 'ua1', T0, '阿明');
    const c = (at) => batch(core, { at, speakers: { U3: aming }, lines: [['m1', aming]] });
    const fish = E.resolveExtracted(core, [{ local: 'E1', name: '小鱼', kind: 'pet', descriptor: { anchor: 'U3', relation: '猫' }, msgRefs: ['m1'] }], c(T0)).get('E1');
    const snack = E.resolveExtracted(core, [{ local: 'E1', name: '小鱼干', kind: 'object', descriptor: null, msgRefs: ['m1'] }], c(T0 + DAY)).get('E1');
    assert.notEqual(snack, fish);
    assert.equal(E.belief(core, snack, fish), null, '二元组再像也不是同一个');
    // 一个也叫「小鱼」的人：种类不同，LLM 说是同一个也只到 θ_lo（不合并、不挂 maybe_same）
    const man = E.resolveExtracted(core, [{ local: 'E1', name: '小鱼', kind: 'person', descriptor: null, msgRefs: ['m1'], verdict: { match: fish, confidence: 0.95 } }], c(T0 + 2 * DAY)).get('E1');
    assert.notEqual(man, fish);
    assert.equal(E.belief(core, man, fish), null);
    // 同种类、同名、同一个人在同一个场合又提起：挂上
    const again = E.resolveExtracted(core, [{ local: 'E1', name: '小鱼', kind: 'pet', descriptor: null, msgRefs: ['m1'] }], c(T0 + 3 * DAY)).get('E1');
    assert.equal(again, fish);
    ports.logger.assertNoText('小鱼', '小鱼干', '猫');
  } finally { await cleanup(); }
});
