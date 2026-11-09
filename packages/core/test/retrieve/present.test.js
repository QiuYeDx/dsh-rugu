// 在场者近况（§8.2 第五路）的排序、去重和名额（实测问题 #5、#6）：
//   - 刚才在别处说的话靠「现在有多活跃」（基础激活 B）排在前面，不靠和窗口碰巧重合的一两个字；
//   - 她在别处和这里的人一来一回时说的话，比她和不在这里的人说的话更像「对着这个人想起来的」；
//   - 「这里出现过」只算那句话之后才出现在这里的同样文字；
//   - 正在对她说话的人一定在场；
//   - 召回结果里这一路有自己的名额，不被别的几路按带噪声的 A 挤掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedPresence, T0, MIN, HOUR } from './fixtures.js';
import { mergeByA, viaPresent } from '../../src/retrieve/pipeline.js';

const R = (core, s, opt) => core.mods.retrieve.recall(core, { trigger: 'message', ...s }, { deadlineMs: 800, ...opt });

async function world(o = {}) {
  const env = await retrieveCore(o);
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明' });
  const hong = seedEntity(core, { name: '小红' });
  seedSetting(core, 'A', { label: '游戏群' });
  seedSetting(core, 'B', { label: '另一个群' });
  seedSetting(core, 'D', { label: '私聊' });
  seedSetting(core, 'C', { label: '第三个群' });
  return { ...env, me, boss, ming, hong };
}

/** 这一次回想里在场者近况那一路的名次（ref → 名次，从 1 起）。 */
function presentRanks(w) {
  const inputs = w.calls.activate.at(-1).inputs.map((i) => i.candidate);
  return new Map(inputs.filter((c) => c.ranks.present).map((c) => [c.ref, c.ranks.present]));
}

test('一句没有字面线索的话：对她说话的人两分钟前在别处定下的规则排在最前，几小时前碰巧有一两个字重合的旧话排在后面', async () => {
  const w = await world();
  try {
    const { core } = w;
    // 几个小时前老板在游戏群说的几句话，和这里窗口里的字有重合（「早饭」「零食」）
    const olds = [];
    for (let i = 0; i < 20; i++) {
      olds.push(seedPercept(core, { settingKey: 'A', at: T0 - (3 * HOUR + i * MIN), actor: w.boss, text: `早饭吃了零食第${i}次` }));
    }
    // 两分钟前：老板在游戏群定了个游戏规则，她答应了，老板说了「1」，她回「2」
    const rule = seedPercept(core, { settingKey: 'A', at: T0 - 3 * MIN, actor: w.boss, addressed: 'mentions-her', text: '我们玩个游戏 我说一个数字 你就回复比它大一的' });
    const ok = seedPercept(core, { settingKey: 'A', at: T0 - 3 * MIN + 15_000, self: true, actor: w.me, kind: 'self-utterance', text: '好呀，来吧' });
    const one = seedPercept(core, { settingKey: 'A', at: T0 - 2 * MIN, actor: w.boss, text: '1' });
    const two = seedPercept(core, { settingKey: 'A', at: T0 - 2 * MIN + 15_000, self: true, actor: w.me, kind: 'self-utterance', text: '2' });
    // 这里（另一个群）：先聊了几句早饭，然后老板 @ 她发了个「5」
    seedPercept(core, { settingKey: 'B', at: T0 - 20 * MIN, actor: w.boss, text: '早上开完会吃点零食' });
    seedPercept(core, { settingKey: 'B', at: T0 - 19 * MIN, self: true, actor: w.me, kind: 'self-utterance', text: '零食算哪门子早饭' });
    seedPercept(core, { settingKey: 'B', at: T0 - 10 * 1000, actor: w.boss, addressed: 'mentions-her', text: '5' });
    await R(core, { settingKey: 'B' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    for (const ref of [rule, ok, one, two].map((id) => `p${id}`)) assert.ok(ranks.has(ref), `刚才那段一来一回都在近况里：${ref}`);
    const worstNew = Math.max(...[rule, one].map((id) => ranks.get(`p${id}`)));
    const bestOld = Math.min(...olds.map((id) => ranks.get(`p${id}`) ?? Infinity));
    assert.ok(worstNew < bestOld, `两分钟前的规则和「1」排在几小时前碰巧重合的旧话前面（新 ${worstNew}，旧 ${bestOld}）`);
  } finally { await w.cleanup(); }
});

test('活跃度用 dynamics 给的基础激活 B（同一个量）；dynamics 出错时按单条痕迹的公式现算，顺序一样', async () => {
  const asked = [];
  const B = new Map();
  const w = await world({ mods: { dynamics: { baseActivations: (core, refs, at) => { asked.push(refs); return new Map(refs.map((r) => [r, B.get(r) ?? 0])); } } } });
  try {
    const { core } = w;
    const a = seedPercept(core, { settingKey: 'A', at: T0 - 5 * HOUR, actor: w.boss, text: '甲' });
    const b = seedPercept(core, { settingKey: 'A', at: T0 - 5 * MIN, actor: w.boss, text: '乙' });
    seedPercept(core, { settingKey: 'D', at: T0 - 10 * 1000, actor: w.boss, addressed: 'to-her', text: '在吗' });
    // dynamics 说五小时前那句被反复确认过、比五分钟前那句还活跃：照它排
    B.set(`p${a}`, 2);
    B.set(`p${b}`, 0.5);
    await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    assert.ok(asked.some((refs) => refs.includes(`p${a}`) && refs.includes(`p${b}`)), '问的是 dynamics');
    let ranks = presentRanks(w);
    assert.ok(ranks.get(`p${a}`) < ranks.get(`p${b}`), JSON.stringify([...ranks]));
  } finally { await w.cleanup(); }

  const w2 = await world({ mods: { dynamics: { baseActivations: () => { throw new Error('x'); } } } });
  try {
    const { core } = w2;
    const a = seedPercept(core, { settingKey: 'A', at: T0 - 5 * HOUR, actor: w2.boss, text: '甲' });
    const b = seedPercept(core, { settingKey: 'A', at: T0 - 5 * MIN, actor: w2.boss, text: '乙' });
    seedPercept(core, { settingKey: 'D', at: T0 - 10 * 1000, actor: w2.boss, addressed: 'to-her', text: '在吗' });
    await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const ranks = presentRanks(w2);
    assert.ok(ranks.get(`p${b}`) < ranks.get(`p${a}`), '现算：五分钟前的比五小时前的活跃');
  } finally { await w2.cleanup(); }
});

test('她在别处的话：和这里的人一来一回时说的，排在她和不在这里的人说的前面（同样新、同样没有字面线索）', async () => {
  const w = await world();
  try {
    const { core } = w;
    // 第三个群：她在和小红聊（小红不在这里）；游戏群：她在和老板聊（老板在这里）
    seedPercept(core, { settingKey: 'C', at: T0 - 4 * MIN, actor: w.hong, text: '你看那个视频了吗' });
    const withHong = seedPercept(core, { settingKey: 'C', at: T0 - 3 * MIN, self: true, actor: w.me, kind: 'self-utterance', text: '看了，挺好笑' });
    seedPercept(core, { settingKey: 'A', at: T0 - 4 * MIN, actor: w.boss, text: '你猜我在干嘛' });
    const withBoss = seedPercept(core, { settingKey: 'A', at: T0 - 3 * MIN, self: true, actor: w.me, kind: 'self-utterance', text: '在摸鱼吧' });
    seedPercept(core, { settingKey: 'D', at: T0 - 10 * 1000, actor: w.boss, addressed: 'to-her', text: '嗯' });
    await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    assert.ok(ranks.has(`p${withHong}`), '她自己在别处说的照样是近况（她在场）');
    assert.ok(ranks.get(`p${withBoss}`) < ranks.get(`p${withHong}`), JSON.stringify([...ranks]));
  } finally { await w.cleanup(); }
});

test('「这里出现过」只算那句话之后才出现在这里的同样文字：这里几小时前碰巧也有人说过「1」，别处刚才那句「1」照样是近况', async () => {
  const w = await world();
  try {
    const { core } = w;
    seedPercept(core, { settingKey: 'D', at: T0 - 6 * HOUR, actor: w.boss, addressed: 'to-her', text: '1' });
    const one = seedPercept(core, { settingKey: 'A', at: T0 - 2 * MIN, actor: w.boss, text: '1' });
    // 别处说过、后来又原样贴到这里的：这里已经有了，不算近况
    const pasted = seedPercept(core, { settingKey: 'A', at: T0 - 5 * MIN, actor: w.boss, text: '明天下午三点开会' });
    seedPercept(core, { settingKey: 'D', at: T0 - 4 * MIN, actor: w.boss, addressed: 'to-her', text: '明天下午三点开会' });
    seedPercept(core, { settingKey: 'D', at: T0 - 10 * 1000, actor: w.boss, addressed: 'to-her', text: '3' });
    await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    assert.ok(ranks.has(`p${one}`), JSON.stringify([...ranks]));
    assert.ok(!ranks.has(`p${pasted}`), '那句话后来已经到了这里');
  } finally { await w.cleanup(); }
});

test('正在对她说话的人一定在场：成员名单是一会儿之前拉的、里面还没有他，他刚才在别处说的话照样是近况', async () => {
  const w = await world();
  try {
    const { core } = w;
    seedPresence(core, 'B', [w.me, w.ming], 'exact', T0 - HOUR);
    const said = seedPercept(core, { settingKey: 'A', at: T0 - 2 * MIN, actor: w.boss, text: '今晚又要加班' });
    seedPercept(core, { settingKey: 'B', at: T0 - 10 * 1000, actor: w.boss, addressed: 'mentions-her', text: '在吗' });
    const set = await R(core, { settingKey: 'B' }, { mode: 'involuntary' });
    assert.ok(set.cues.present.includes(w.boss));
    assert.ok(presentRanks(w).has(`p${said}`));
    // 内容的作者不算（她在看的东西是谁写的，不等于谁在这里）
    const w2 = await world();
    try {
      const c = w2.core;
      seedPresence(c, 'B', [w2.me], 'exact', T0 - HOUR);
      seedPercept(c, { settingKey: 'B', at: T0 - 10 * 1000, actor: w2.boss, kind: 'content', standing: 'material', text: '一篇文章' });
      const s2 = await R(c, { settingKey: 'B' }, { mode: 'involuntary' });
      assert.ok(!s2.cues.present.includes(w2.boss));
    } finally { await w2.cleanup(); }
  } finally { await w.cleanup(); }
});

test('召回结果里在场者近况有自己的名额：别的几路有一大堆更活跃的候选，刚才那句也不被挤掉', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    // 四十条和窗口字面相关、很活跃的旧事实（词法路），A 都比那句近况高
    for (let i = 0; i < 40; i++) {
      const id = seedAssertion(core, { text: `早饭零食的第${i}件事`, subjects: [w.ming] });
      B[`a${id}`] = 3;
    }
    const rule = seedPercept(core, { settingKey: 'A', at: T0 - 2 * MIN, actor: w.boss, text: '我说一个数字 你就回复比它大一的' });
    seedPercept(core, { settingKey: 'B', at: T0 - 30 * 1000, actor: w.boss, text: '早饭吃了零食' });
    seedPercept(core, { settingKey: 'B', at: T0 - 10 * 1000, actor: w.boss, addressed: 'mentions-her', text: '5' });
    const set = await R(core, { settingKey: 'B' }, { mode: 'involuntary' });
    const general = set.items.filter((c) => !viaPresent(c));
    assert.ok(general.length > 0 && general.every((c) => c.A > (set.items.find((x) => x.ref === `p${rule}`)?.A ?? Infinity)),
      '别的候选都比它活跃（不分组的话它排不进前 30）');
    assert.ok(set.items.some((c) => c.ref === `p${rule}`), '照样在召回结果里，交给关口①');
    const limit = core.config.get().recall.involuntary.maxItems * core.config.get().recall.poolFactor;
    assert.ok(general.length <= limit, '别的几路照旧最多这么多条');
    assert.ok(set.items.filter(viaPresent).length <= core.config.get().recall.present.maxItems);
  } finally { await w.cleanup(); }
});

test('mergeByA：两组各自的先后不变，每次取队首 A 大的', () => {
  const a = [{ ref: 'a', A: 3 }, { ref: 'b', A: 1 }, { ref: 'c', A: 2 }];
  const b = [{ ref: 'x', A: 2.5 }, { ref: 'y', A: 0.5 }];
  assert.deepEqual(mergeByA(a, b).map((c) => c.ref), ['a', 'x', 'b', 'c', 'y']);
  assert.deepEqual(mergeByA([], b).map((c) => c.ref), ['x', 'y']);
  assert.deepEqual(mergeByA(a, []).map((c) => c.ref), ['a', 'b', 'c']);
});

test('时间只是几项之一：六小时前真正切题的话（提到了问的那个人）排在三分钟前无关的闲话前面，不是「最近 15 条」', async () => {
  const w = await world();
  try {
    const { core } = w;
    const old = seedPercept(core, { settingKey: 'A', at: T0 - 6 * HOUR, actor: w.boss, text: '阿明说他下午三点过来开会' });
    const fresh = seedPercept(core, { settingKey: 'A', at: T0 - 3 * MIN, actor: w.boss, text: '我去吃饭了' });
    seedPercept(core, { settingKey: 'D', at: T0 - 10 * 1000, actor: w.boss, addressed: 'to-her', text: '阿明几点过来？' });
    await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    assert.ok(ranks.has(`p${old}`) && ranks.has(`p${fresh}`), JSON.stringify([...ranks]));
    assert.ok(ranks.get(`p${old}`) < ranks.get(`p${fresh}`), JSON.stringify([...ranks]));
  } finally { await w.cleanup(); }
});

// ── D103：没有「最近 12 小时」的硬窗 ───────────────────────────────────────

test('D103：配置里没有 recentH（写了也只是忽略、给 warning）；B 低于 floorB 的不算近况，强的记得更久', async () => {
  const { DEFAULTS, mergeConfig } = await import('../../src/config/defaults.js');
  assert.equal('recentH' in DEFAULTS.recall.present, false);
  assert.ok(Number.isFinite(DEFAULTS.recall.present.floorB));
  const { warnings } = mergeConfig(DEFAULTS, { recall: { present: { recentH: 12 } } });
  assert.ok(warnings.some((x) => x.includes('recall.present.recentH')), '旧配置里的 recentH：warning、忽略');
  const w = await world();
  try {
    const { core } = w;
    // 13 小时前编码很强的一句（被叫到、关系最亲）和 13 小时前很弱的一句（旁听）：一刀切的 12 小时窗口会把两句都扔掉
    const strong = seedPercept(core, { settingKey: 'A', at: T0 - 13 * HOUR, actor: w.boss, addressed: 'to-her', text: '下周搬家' });
    const weak = seedPercept(core, { settingKey: 'A', at: T0 - 13 * HOUR, actor: w.boss, text: '随便说说' });
    core.store.run('UPDATE percepts SET w_enc = ? WHERE id = ?', 3, strong);
    core.store.run('UPDATE percepts SET w_enc = ? WHERE id = ?', 0.2, weak);
    seedPercept(core, { settingKey: 'B', at: T0 - 10 * 1000, actor: w.boss, addressed: 'mentions-her', text: '在吗' });
    await R(core, { settingKey: 'B' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    assert.ok(ranks.has(`p${strong}`), '编码强的 13 小时后还活跃：照样是近况');
    assert.ok(!ranks.has(`p${weak}`), '编码弱的已经淡了（B < floorB）');
  } finally { await w.cleanup(); }
});

test('D103：活跃度和相关度一起算——淡了（B < floorB）但正切题的旧话照样是近况，淡了又不相干的不是（不是先按 B 一刀切，评审）', async () => {
  const w = await world();
  try {
    const { core } = w;
    const onTopic = seedPercept(core, { settingKey: 'A', at: T0 - 20 * HOUR, actor: w.boss, text: '下周搬家 新家在江边' });
    const offTopic = seedPercept(core, { settingKey: 'A', at: T0 - 20 * HOUR, actor: w.boss, text: '随便说说而已' });
    core.store.run('UPDATE percepts SET w_enc = 1 WHERE id IN (?, ?)', onTopic, offTopic);
    seedPercept(core, { settingKey: 'B', at: T0 - 10 * 1000, actor: w.boss, addressed: 'mentions-her', text: '搬家 江边那套怎么样' });
    await R(core, { settingKey: 'B' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    assert.ok(ranks.has(`p${onTopic}`), '二十小时前、正切题：想得起来');
    assert.ok(!ranks.has(`p${offTopic}`), '二十小时前、不相干：已经淡了');
  } finally { await w.cleanup(); }
});

test('D103 lint：工作记忆和在场者近况的 SQL 里没有以「at >= ?」作时间下限的参数', async () => {
  const fs = await import('node:fs');
  const url = (f) => new URL(`../../src/retrieve/${f}`, import.meta.url);
  const working = fs.readFileSync(url('working.js'), 'utf8');
  assert.doesNotMatch(working, /\bat\s*>=?\s*\?/, 'working.js');
  const routes = fs.readFileSync(url('routes.js'), 'utf8');
  const body = routes.slice(routes.indexOf('export async function presentRoute'), routes.indexOf('const STRENGTH_FLOOR'));
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /\b(at|t_end)\s*>=?\s*\?/, 'presentRoute');
});

test('D103：她在那边说话时这里的人在不在跟前按 1/(1 + Δt/h) 渐弱，不是 ±30 分钟的二值', async () => {
  const w = await world();
  try {
    const { core } = w;
    // 游戏群：老板在 T0-60 分钟说了一句；她在 T0-59 分钟（紧跟着）、T0-29 分钟（隔了半小时出头）各说了一句；都没有字面线索
    seedPercept(core, { settingKey: 'A', at: T0 - 60 * MIN, actor: w.boss, text: '我先下了' });
    const near = seedPercept(core, { settingKey: 'A', at: T0 - 59 * MIN, self: true, actor: w.me, kind: 'self-utterance', text: '拜拜' });
    const far = seedPercept(core, { settingKey: 'A', at: T0 - 29 * MIN, self: true, actor: w.me, kind: 'self-utterance', text: '人呢' });
    seedPercept(core, { settingKey: 'B', at: T0 - 10 * 1000, actor: w.boss, addressed: 'mentions-her', text: '在吗' });
    await R(core, { settingKey: 'B' }, { mode: 'involuntary' });
    const ranks = presentRanks(w);
    assert.ok(ranks.has(`p${near}`) && ranks.has(`p${far}`), '两句都还是近况');
    // 「人呢」更新（活跃度高一点），但「拜拜」是对着老板说的（关联分接近 1，「人呢」只有一半左右）：更像对着这个人想起来的
    assert.ok(ranks.get(`p${near}`) < ranks.get(`p${far}`), `关联渐弱：${ranks.get(`p${near}`)} vs ${ranks.get(`p${far}`)}`);
  } finally { await w.cleanup(); }
});
