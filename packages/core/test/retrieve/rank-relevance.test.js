// D149：排序里相关度说了算。一对一被直接问到时，噪声、「关于眼前这个人」的联想项不再压过和问题的匹配；
// 弱线索（在场的人、名下几百件事的人）不靠归一拿满联想分；在场的人不占「每人 3 条」；稠密路以对她说的那句为主。
// 数据是编的，形状照一次实测：对方名下很多条近来的琐事，一条相关的旧事只有稠密路找得到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedPresence, T0, MIN } from './fixtures.js';

const R = (core, s, opt) => core.mods.retrieve.recall(core, { trigger: 'message', ...s }, { deadlineMs: 800, ...opt });

async function world(o = {}) {
  const env = await retrieveCore(o);
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明' });
  const jie = seedEntity(core, { name: '阿杰' });
  const cousin = seedEntity(core, { name: '小刚' });
  seedSetting(core, 'D', { label: '私聊' });
  seedSetting(core, 'G', { label: '游戏群' });
  seedPresence(core, 'D', [me, boss], 'exact');
  return { ...env, me, boss, ming, jie, cousin };
}

const CHORES = ['周一午饭吃了面条', '周二加班到很晚', '买了一把新椅子', '下班路上堵车', '周三换了手机壳', '早上没吃早饭', '晚上打了会儿游戏',
  '打算周末去理发', '中午点了盖浇饭', '说今天有点困', '把闹钟调早了', '下午开了个长会'];

test('一对一被直接问到：相关的旧事排在「关于对方的随便一条近事」前面；对方是弱线索，联想项不再人人拿满', async () => {
  const w = await world({ rerank: false });
  try {
    const { core, worker, B, calls } = w;
    const chores = [];
    for (let i = 0; i < 30; i++) {
      const id = seedAssertion(core, { text: `老板${CHORES[i % CHORES.length]}（${i}）`, subjects: [w.boss] });
      B[`a${id}`] = i < 10 ? 0.8 : 0;   // 前 10 条是这两天的
      chores.push(id);
    }
    const fish = seedAssertion(core, { text: '老板说自己养了两条金鱼', subjects: [w.boss] });
    B[`a${fish}`] = -0.8;                // 好几天前的事
    worker.addDoc(`a${fish}`, '老板说自己养了两条金鱼');
    seedPercept(core, { settingKey: 'D', at: T0 - 3 * MIN, actor: w.boss, text: '今晚想吃夜宵', addressed: 'to-her' });
    seedPercept(core, { settingKey: 'D', at: T0 - 2 * MIN, self: true, kind: 'self-utterance', text: '吃点热的吧', addressed: 'by-her' });
    const q = seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '你还记得群里有哪些金鱼吗', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', focusPerceptId: q });
    const facts = set.items.filter((c) => c.meta?.kind === 'assertion');
    assert.equal(facts[0]?.ref, `a${fish}`, `相关的旧事排第一 ${JSON.stringify(facts.map((c) => [c.ref, c.A]))}`);
    // 对方是情境：只当弱种子，权重再乘专门程度（名下 31 条）
    const act = core.config.get().activation;
    const spec = Math.log(act.fanMinTotal / 31) / Math.log(act.fanMinTotal);
    const seed = calls.pprSearch.at(-1).seeds.find((s) => s.entityId === w.boss);
    assert.ok(Math.abs(seed.weight - core.config.get().recall.entity.seedWeights.focus * spec) < 1e-9, JSON.stringify(seed));
    const by = Object.fromEntries(calls.activate.at(-1).inputs.map((i) => [i.candidate.ref, i]));
    const chore = by[`a${chores[0]}`];
    assert.ok(chore, '琐事照样是候选（实体路找得到）');
    assert.ok(chore.S < 0.5 * act.fanSMax * spec + 1e-9, `琐事的联想项 ${chore.S}：不靠归一拿满 S_max`);
    // 被直接问到：C 里和线索匹配的几项按 directed 的倍数放大
    assert.equal(set.items.find((c) => c.ref === `a${fish}`).cParts.boost, core.config.get().recall.matchWeight.directed);
  } finally { await w.cleanup(); }
});

test('C 的倍数按线索有多直接：有意回想 > 有一句对她说的话 > 只是旁听（D149）', async () => {
  const w = await world();
  try {
    const { core, worker } = w;
    const a = seedAssertion(core, { text: '小刚开网约车', subjects: [w.cousin] });
    worker.addDoc(`a${a}`, '小刚开网约车');
    const mw = core.config.get().recall.matchWeight;
    const boostOf = (set) => set.items.find((c) => c.ref === `a${a}`)?.cParts.boost;
    const amb = seedPercept(core, { settingKey: 'G', at: T0 - 3 * MIN, actor: w.ming, text: '小刚最近在开车', addressed: 'ambient' });
    assert.equal(boostOf(await R(core, { settingKey: 'G', focusPerceptId: amb })), mw.overheard);
    const dir = seedPercept(core, { settingKey: 'G', at: T0 - 2 * MIN, actor: w.ming, text: '小刚开的什么车', addressed: 'mentions-her' });
    assert.equal(boostOf(await R(core, { settingKey: 'G', focusPerceptId: dir })), mw.directed);
    assert.equal(boostOf(await R(core, { settingKey: 'G', focusPerceptId: dir, trigger: 'simulate' }, { mode: 'deliberate', query: '小刚开什么车' })), mw.deliberate);
    assert.ok(mw.deliberate > mw.directed && mw.directed > mw.overheard);
  } finally { await w.cleanup(); }
});

test('实体路的种子按来源分强弱：焦点那句里的名字最强，窗口里更早几行的名字弱一些；她自己开口的轮在场的人就是线索', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    const sw = core.config.get().recall.entity.seedWeights;
    seedPresence(core, 'G', [w.me, w.boss, w.ming], 'exact');
    seedPercept(core, { settingKey: 'G', at: T0 - 3 * MIN, actor: w.ming, text: '小刚昨天来过', addressed: 'ambient' });
    const q = seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: w.boss, text: '阿杰呢', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'G', focusPerceptId: q });
    assert.equal(set.cues.contentCue, true);
    assert.equal(set.cues.focusDirected, true);
    const seed = Object.fromEntries(calls.pprSearch.at(-1).seeds.map((s) => [s.entityId, s.weight]));
    assert.equal(seed[w.jie], sw.name, '焦点那句里的名字');
    assert.equal(seed[w.cousin], sw.nameWindow, '窗口里更早几行的名字');
    assert.equal(seed[w.boss], sw.focus, '正在说话的人：情境');
    assert.equal(seed[w.ming], sw.present, '在场的人：情境');

    // 她自己开口（没有对她说的那句、也没有 query）：在场的人就是唯一的线索
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, self: true, kind: 'self-utterance', text: '早上好呀', addressed: 'by-her' });
    const self = await R(core, { settingKey: 'D', trigger: 'idle' });
    assert.equal(self.cues.contentCue, false);
    const s2 = Object.fromEntries(calls.pprSearch.at(-1).seeds.map((s) => [s.entityId, s.weight]));
    assert.equal(s2[w.boss], sw.alone);
  } finally { await w.cleanup(); }
});

test('正在对她说话的人不占「每人最多 3 条」：一对一时关于对方的相关记忆不被挤掉；别人照旧最多 3 条', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    for (let i = 0; i < 6; i++) {
      B[`a${seedAssertion(core, { text: `老板的第${i}件事`, subjects: [w.boss] })}`] = 2 - i * 0.1;
      B[`a${seedAssertion(core, { text: `小刚的第${i}件事`, subjects: [w.cousin] })}`] = 2 - i * 0.1;
    }
    const q = seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚的事', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', focusPerceptId: q, trigger: 'simulate' }, { mode: 'deliberate' });
    const about = (e) => set.items.filter((c) => c.meta?.kind === 'assertion' && c.meta.about.includes(e)).length;
    assert.equal(about(w.cousin), 3);
    assert.ok(about(w.boss) > 3, `关于在场的老板 ${about(w.boss)} 条`);
  } finally { await w.cleanup(); }
});

test('稠密路以对她说的那句为主、窗口为辅：换了话题以后，上一个话题的东西不再和问题平分前几名', async () => {
  // 假嵌入是字的 n 元组哈希：去掉通用指令，免得它在两条查询向量里占了大头
  const w = await world({ config: { recall: { queryInstruct: '' } } });
  try {
    const { core, worker, calls } = w;
    const old = seedAssertion(core, { text: '老板晚上想吃夜宵烧烤', subjects: [w.boss] });
    const fish = seedAssertion(core, { text: '群里养了两条金鱼', subjects: [w.ming] });
    worker.addDoc(`a${old}`, '老板晚上想吃夜宵烧烤');
    worker.addDoc(`a${fish}`, '群里养了两条金鱼');
    for (const t of ['晚上想吃夜宵烧烤', '夜宵吃烧烤还是吃面', '烧烤夜宵走起', '夜宵就吃烧烤吧']) {
      seedPercept(core, { settingKey: 'D', at: T0 - 5 * MIN, actor: w.boss, text: t, addressed: 'to-her' });
    }
    const q = seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '群里有哪些金鱼', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', focusPerceptId: q });
    const dense = calls.denseSearch.slice(-2);
    assert.deepEqual(dense.map((d) => d.vectors.length), [1, 1], '焦点那句和窗口分开查');
    const rank = (ref) => set.items.find((c) => c.ref === ref)?.ranks?.dense ?? Infinity;
    assert.ok(rank(`a${fish}`) < rank(`a${old}`), `问的那件事在前 ${rank(`a${fish}`)} vs ${rank(`a${old}`)}`);
    // 窗口不丢：只和窗口对得上的照样在稠密路里
    assert.ok(Number.isFinite(rank(`a${old}`)) || !set.items.some((c) => c.ref === `a${old}`));
  } finally { await w.cleanup(); }
});

test('门槛和排序分开：sample 用 A + ε 过门槛，过了的按不带噪声的 A 排', async () => {
  const w = await world();
  try {
    const { core } = w;
    const dyn = (await import('../../src/dynamics/index.js'));
    const mk = (ref, A, eps) => ({ ref, A, P: 0.9, parts: { B: A, S: 0, C: 0, I: 0, Psup: 0, eps } });
    core.config.update({ activation: { tauInvoluntary: 0 } });
    const out = dyn.sample(core, [mk('a1', 1.0, -0.5), mk('a2', 0.6, 1.5), mk('a3', 0.3, -0.6)], { mode: 'involuntary', seed: [] });
    assert.deepEqual(out.map((c) => c.ref), ['a1', 'a2'], 'a3 的噪声让它这一回没想起来；a2 的噪声不让它排到 a1 前面');
  } finally { await w.cleanup(); }
});
