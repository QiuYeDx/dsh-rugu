// recall 的主流程（§8.2、§8.3、§8.8、§6.5、§6.6）：五路、融合、预过滤、激活打分的输入、抽样、重排、MMR、版本、发生次、每个实体最多 3 条。
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEmbedding, FakeRerank } from '../fakes/embedding.js';
import {
  retrieveCore, seedEntity, addName, seedPercept, seedSetting, seedAssertion, seedEpisode, seedSource, seedWindow, seedPresence, supersede, sameType,
  T0, MIN, HOUR, DAY,
} from './fixtures.js';

const R = (core, s, opt) => core.mods.retrieve.recall(core, { trigger: 'message', ...s }, { deadlineMs: 800, ...opt });

async function world(o = {}) {
  const env = await retrieveCore(o);
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明' });
  const cousin = seedEntity(core, { name: '小刚' });
  seedSetting(core, 'G', { label: '游戏群' });
  seedSetting(core, 'D', { label: '私聊' });
  seedSetting(core, 'W', { label: '工作群' });
  return { ...env, me, boss, ming, cousin };
}

test('五路：稠密找到换了说法的记忆，词法 ≤ 12 个词、按 IDF 排、剔掉常见词；不自主回想只查最近 3 个月的原文分表', async () => {
  const w = await world({ embedding: new FakeEmbedding({ synonyms: [['快递', '包裹'], ['拿', '取']] }) });
  try {
    const { core, worker, calls } = w;
    const a = seedAssertion(core, { text: '老板下午去驿站取了包裹', subjects: [w.boss], sources: [{ speaker: w.boss, perceivedIn: 'D', at: T0 - 3 * HOUR }] });
    worker.addDoc(`a${a}`, '老板下午去驿站取了包裹');
    seedPercept(core, { settingKey: 'G', at: T0 - 200 * DAY, actor: w.ming, text: '很久以前的快递' });   // 旧分表
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, addressed: 'to-her',
      text: '快递拿了没 我们 一二 三四 五六 七八 九十 甲乙 丙丁 戊己 庚辛 壬癸 子丑' });
    calls.common = new Set(['我们']);
    const set = await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    assert.ok(set.items.some((c) => c.ref === `a${a}`), '稠密路找回了换说法的那条');
    const hit = set.items.find((c) => c.ref === `a${a}`);
    assert.ok(hit.ranks.dense >= 1);
    const lq = calls.lexicalSearch.at(-1);
    assert.ok(lq.terms.length <= 12);
    assert.ok(!lq.terms.includes('我们'), '出现在超过 1% 行里的常见词剔掉');
    const shards = lq.tables.filter((t) => t.startsWith('percepts_fts_'));
    assert.deepEqual(shards, ['percepts_fts_202610'], '200 天前那个月的分表不在热路径上');
    assert.ok(lq.tables.includes('episodes_fts') && lq.tables.includes('assertions_fts'));
    // 查询向量 1–2 条，带通用的查询指令
    const emb = calls.embedQuery.at(-1);
    assert.ok(emb.length >= 1 && emb.length <= 4);
    assert.ok(emb.every((t) => t.startsWith('Instruct: ')));
    // 有意回想查全部原文分表、冷层
    await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '快递' });
    const lq2 = calls.lexicalSearch.at(-1);
    assert.ok(lq2.tables.filter((t) => t.startsWith('percepts_fts_')).length >= 2);
    assert.equal(calls.denseSearch.at(-1).includeCold, true);
  } finally { await w.cleanup(); }
});

test('预过滤只看能不能访问：隐藏 / 忘掉 / 墓碑的剔掉；从不读规范、从不做分寸判定', async () => {
  const w = await world();
  try {
    const { core, hidden } = w;
    const a1 = seedAssertion(core, { text: '阿明的表哥小刚开网约车', subjects: [w.cousin], sources: [{ speaker: w.ming, perceivedIn: 'G', hop: 1 }] });
    const a2 = seedAssertion(core, { text: '阿明的表哥小刚住在杭州', subjects: [w.cousin], sources: [{ speaker: w.ming, perceivedIn: 'G', hop: 1 }] });
    hidden.add(`a${a2}`);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚是干啥的', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate' });   // fakeDiscretion.normOf 被调用会抛错
    assert.ok(set.items.some((c) => c.ref === `a${a1}`));
    assert.ok(!set.items.some((c) => c.ref === `a${a2}`));
    assert.ok(w.calls.suppressedRefs.length >= 1);
  } finally { await w.cleanup(); }
});

test('预过滤拿不到结果就 fail closed：一条都不给', async () => {
  const w = await world({ mods: { admin: { suppressedRefs: () => { throw new Error('admin down'); } } } });
  try {
    const { core } = w;
    seedAssertion(core, { text: '阿明的表哥小刚开网约车', subjects: [w.cousin] });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚是干啥的', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate' });
    assert.equal(set.items.length, 0);
    assert.equal(set.failed, 'suppression');
  } finally { await w.cleanup(); }
});

test('激活打分的输入：S = max（PPR 归一化 × 最强线索的强度，扇出项 S_max × 专门程度）；C 用 RRF 名次分；被取代的标 superseded；种子可复现', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    const a1 = seedAssertion(core, { text: '小刚开网约车', subjects: [w.cousin] });
    const a2 = seedAssertion(core, { text: '小刚住在杭州', subjects: [w.cousin] });
    const a3 = seedAssertion(core, { text: '小刚以前送外卖', subjects: [w.cousin] });
    supersede(core, a3, a1);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚最近干嘛呢', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const inputs = calls.activate[0].inputs;
    const by = Object.fromEntries(inputs.map((i) => [i.candidate.ref, i]));
    const act = core.config.get().activation;
    const Smax = act.fanSMax;
    // D149：小刚名下 3 条事实，库还小（N 按 fanMinTotal 算）：专门程度 ln(N/3)/ln N；问句里点到了他，名义权重 1
    const spec = Math.log(act.fanMinTotal / 3) / Math.log(act.fanMinTotal);
    assert.ok(Math.abs(by[`a${a1}`].S - Smax * spec) < 1e-9, `关于他的事实拿扇出项 ${by[`a${a1}`].S}`);
    assert.ok(Math.abs(by[`n${w.cousin}`].S - Smax * spec) < 1e-9, '种子本身 PPR 最高，乘这一批最强线索的强度');
    assert.equal(by[`a${a3}`].superseded, true);
    assert.equal(by[`a${a1}`].superseded, false);
    assert.ok(by[`a${a1}`].C > 0, '词法路命中给 C');
    assert.deepEqual(calls.activate[0].ctx.seed, ['D', String(set.cues.latestPerceptId), 'involuntary']);
    assert.equal(calls.sample[0].mode, 'involuntary');
    // 同样的线索，结果一样（可复现）
    const again = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary' });
    assert.deepEqual(again.items.map((c) => c.ref), set.items.map((c) => c.ref));
  } finally { await w.cleanup(); }
});

test('扇出项的 fan 连他在场的情节一起数（§6.5「这个实体名下的记忆条数」）：聊得多的人每段经历不再都拿满 S_max', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    const a1 = seedAssertion(core, { text: '小刚开网约车', subjects: [w.cousin] });
    const eps = [];
    for (let i = 0; i < 6; i++) eps.push(seedEpisode(core, { settingKey: 'G', narrative: `小刚聊了第${i}件事`, participants: [w.cousin], tStart: T0 - (i + 2) * HOUR }));
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚最近干嘛呢', addressed: 'to-her' });
    await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const by = Object.fromEntries(calls.activate[0].inputs.map((i) => [i.candidate.ref, i]));
    const act = core.config.get().activation;
    const Smax = act.fanSMax;
    // 1 条事实 + 6 段情节：fan = 7（只数事实时 fan = 1，每段情节都拿满 S_max）；D149 起扇出项 = S_max × ln(N/fan)/ln N
    const fan = Smax * Math.log(act.fanMinTotal / 7) / Math.log(act.fanMinTotal);
    const ep = eps.map((e) => by[`e${e}`]).find(Boolean);
    assert.ok(ep, '情节进了候选');
    assert.ok(Math.abs(ep.S - fan) < 1e-9 && ep.S < Smax, `情节的扇出项按 fan = 7 算：S = ${ep.S}`);
    assert.ok(Math.abs(by[`a${a1}`].S - fan) < 1e-9);
  } finally { await w.cleanup(); }
});

test('硬截止：不自主回想 800 ms 到点，慢的那一路丢掉，用已完成的几路', async () => {
  const w = await world({ delays: { dense: 3000, embed: 0 } });
  try {
    const { core } = w;
    const a1 = seedAssertion(core, { text: '小刚开网约车', subjects: [w.cousin] });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚是干啥的', addressed: 'to-her' });
    const t0 = performance.now();
    const set = await R(core, { settingKey: 'D' }, { mode: 'involuntary', deadlineMs: 800 });
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `用了 ${Math.round(ms)} ms`);
    assert.ok(set.items.some((c) => c.ref === `a${a1}`), '词法 / 实体路照样给出');
    assert.equal(set.stats.routes.find((r) => r.route === 'dense').timedOut, true);
  } finally { await w.cleanup(); }
});

test('L3：嵌入服务挂了 → 伪查询向量（词法和实体路前 3 条已经存好的向量），只在记忆层找；连续 2 次很快失败就熔断 60 秒', async () => {
  const emb = new FakeEmbedding();
  const w = await world({ embedding: emb });
  try {
    const { core, worker, calls, ports } = w;
    const a1 = seedAssertion(core, { text: '小刚开网约车', subjects: [w.cousin] });
    const a2 = seedAssertion(core, { text: '网约车司机经常被投诉', subjects: [] });
    worker.addDoc(`a${a1}`, '小刚开网约车');
    worker.addDoc(`a${a2}`, '网约车司机经常被投诉');
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚是干啥的', addressed: 'to-her' });
    emb.setFailing(true);
    const s1 = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    assert.equal(s1.degradeLevel, 3);
    const dq = calls.denseSearch.at(-1);
    assert.deepEqual(dq.layers, ['memory']);
    assert.equal(dq.vectors.length, 1);
    assert.ok(s1.items.some((c) => c.ref === `a${a2}` && c.ranks.dense), '伪查询向量找到了只有向量才连得上的那条');
    await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    const n = calls.embedQuery.length;
    assert.equal(core.mods.retrieve.degradeLevel(core), 3, '熔断打开');
    await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    assert.equal(calls.embedQuery.length, n, '熔断期间不调嵌入');
    ports.clock.advance(61_000);
    emb.setFailing(false);
    const s4 = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    assert.equal(calls.embedQuery.length, n + 1, '冷却后探测一次');
    assert.ok(s4.degradeLevel <= 2);
  } finally { await w.cleanup(); }
});

test('降级级别：GPU + 可重排 → L0；重排不可用 → L1；CPU → L2；没有嵌入端口 / 空间可疑 → L3；库坏了 → L4', async () => {
  const gpu = await world({ gpu: true });
  try {
    const { core, ports } = gpu;
    assert.equal(core.mods.retrieve.degradeLevel(core), 0);
    ports.rerank.setAvailable(false);
    assert.equal(core.mods.retrieve.degradeLevel(core), 1);
    core.store.run("UPDATE vector_spaces SET status = 'suspect'");
    assert.equal(core.mods.retrieve.degradeLevel(core), 3);
  } finally { await gpu.cleanup(); }
  const cpu = await world();
  try { assert.equal(cpu.core.mods.retrieve.degradeLevel(cpu.core), 2); } finally { await cpu.cleanup(); }
  const none = await world({ embedding: null });
  try {
    const { core } = none;
    assert.equal(core.mods.retrieve.degradeLevel(core), 3);
    core.store.close();
    assert.equal(core.mods.retrieve.degradeLevel(core), 4);
    const set = await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    assert.equal(set.degradeLevel, 4);
    assert.deepEqual(set.items, []);
  } finally { await none.cleanup(); }
});

test('重排：GPU 有空、端口可用时对前 30 条重排，用重排分替换 C 里稠密和 BM25 的部分；做不了就是 L1', async () => {
  const emb = new FakeEmbedding({ device: 'gpu' });
  const rr = new FakeRerank(emb);
  const w = await world({ embedding: emb, gpu: true, ports: undefined, rerank: rr });
  try {
    const { core, worker, B } = w;
    const ids = [];
    for (const t of ['小刚开网约车', '小刚喜欢吃面', '小刚养了一只猫']) {
      const id = seedAssertion(core, { text: t, subjects: [w.cousin] });
      worker.addDoc(`a${id}`, t);
      B[`a${id}`] = 1;
      ids.push(id);
    }
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚开什么车', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', query: '小刚开网约车' });
    assert.equal(set.stats.reranked, true);
    assert.equal(set.degradeLevel, 0);
    assert.ok(rr.calls >= 1);
    const top = set.items.find((c) => c.meta?.kind === 'assertion');
    assert.equal(top.ref, `a${ids[0]}`);
    assert.ok(Number.isFinite(top.signals.rerank));
    rr.setAvailable(false);
    const s2 = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', query: '小刚开网约车' });
    assert.equal(s2.stats.reranked, false);
    assert.equal(s2.degradeLevel, 1);
  } finally { await w.cleanup(); }
});

test('重排（调参前）：重排分按名次进 C，和被换掉的稠密、BM25 名次分同一种口径——分数整体偏低的重排模型不会把问题本身的匹配抹平', async () => {
  const emb = new FakeEmbedding({ device: 'gpu' });
  // 一个「分数整体偏低」的重排模型：顺序对，分数都在 0.05–0.3
  const rr = new FakeRerank(emb);
  const raw = rr.rerank.bind(rr);
  rr.rerank = async (q, docs) => (await raw(q, docs)).map((x) => 0.05 + 0.25 * Math.max(0, x));
  const w = await world({ embedding: emb, gpu: true, ports: undefined, rerank: rr });
  try {
    const { core, worker, B } = w;
    const ids = [];
    for (const t of ['小刚开网约车', '小刚喜欢吃面', '小刚养了一只猫']) {
      const id = seedAssertion(core, { text: t, subjects: [w.cousin] });
      worker.addDoc(`a${id}`, t);
      B[`a${id}`] = 1;
      ids.push(id);
    }
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚开什么车', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', query: '小刚开网约车' });
    assert.equal(set.stats.reranked, true);
    const top = set.items.find((c) => c.meta?.kind === 'assertion');
    assert.equal(top.ref, `a${ids[0]}`);
    assert.equal(top.signals.rerankRank, 1, '重排第一');
    const w8 = core.config.get().recall.weights;
    // 稠密那一份照样乘这一轮的倍数（有意回想，D149 matchWeight）
    const bd = w8.dense * core.config.get().recall.matchWeight.deliberate;
    assert.equal(top.cParts.boost, core.config.get().recall.matchWeight.deliberate);
    assert.ok(Math.abs(top.parts.C - (top.cParts.total - top.cParts.dense - top.cParts.lexical) - (bd + w8.bm25)) < 1e-9,
      `重排第一拿满 β_d + β_b，不是 (β_d + β_b) × 原始分 ${top.signals.rerank}`);
    // 调参后（useRrfForC = false）换回 β 加权的原始分数
    core.config.update({ recall: { useRrfForC: false } });
    const s2 = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', query: '小刚开网约车' });
    const t2 = s2.items.find((c) => c.ref === top.ref);
    assert.ok(Math.abs(t2.parts.C - (t2.cParts.total - t2.cParts.dense - t2.cParts.lexical) - (bd + w8.bm25) * t2.signals.rerank) < 1e-9);
  } finally { await w.cleanup(); }
});

test('MMR：原文窗口和它里面的那条感知只留一条在前面（包含关系算重复）', async () => {
  const w = await world();
  try {
    const { core } = w;
    const p1 = seedPercept(core, { settingKey: 'G', at: T0 - 2 * HOUR, actor: w.ming, text: '我表哥小刚又换车了' });
    const p2 = seedPercept(core, { settingKey: 'G', at: T0 - 2 * HOUR + MIN, actor: w.ming, text: '换成新能源的了' });
    const win = seedWindow(core, { settingKey: 'G', first: p1, last: p2, tStart: T0 - 2 * HOUR, tEnd: T0 - 2 * HOUR + MIN, text: '阿明：我表哥小刚又换车了 / 阿明：换成新能源的了' });
    w.worker.addDoc(`w${win}`, '阿明：我表哥小刚又换车了 / 阿明：换成新能源的了', 'raw');
    const other = seedAssertion(core, { text: '小刚住在杭州', subjects: [w.cousin] });
    w.B[`p${p1}`] = 1; w.B[`w${win}`] = 1; w.B[`a${other}`] = 0.5;
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚换车了吗', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    const refs = set.items.map((c) => c.ref);
    const iP = refs.indexOf(`p${p1}`);
    const iW = refs.indexOf(`w${win}`);
    const iA = refs.indexOf(`a${other}`);
    assert.ok(iP >= 0 && iW >= 0 && iA >= 0);
    assert.ok(iA < Math.max(iP, iW), '不相干的那条排在重复的那条前面');
  } finally { await w.cleanup(); }
});

test('MMR 合并几乎一样的情节：同一个场合两段几乎一样的叙述只留分高的一条，另一条不占名额；不同场合的同一件事各留一条', async () => {
  const w = await world();
  try {
    const { core } = w;
    const text = '晚上阿明在游戏群里说他表哥小刚换了一辆新能源车，大家都在问续航';
    const e1 = seedEpisode(core, { settingKey: 'G', narrative: text, participants: [w.ming], tStart: T0 - 5 * HOUR });
    const e2 = seedEpisode(core, { settingKey: 'G', narrative: `${text}。`, participants: [w.ming], tStart: T0 - 5 * HOUR + MIN });
    const e3 = seedEpisode(core, { settingKey: 'W', narrative: text, participants: [w.ming], tStart: T0 - 4 * HOUR });
    for (const e of [e1, e2, e3]) { w.worker.addDoc(`e${e}`, text); w.B[`e${e}`] = 1; }
    w.B[`e${e1}`] = 1.2;
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚换的什么车', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    const refs = set.items.map((c) => c.ref);
    const kept = [`e${e1}`, `e${e2}`].filter((r) => refs.includes(r));
    assert.equal(kept.length, 1, `同一个场合几乎一样的两段只留一条：${refs.join(' ')}`);
    const rep = set.items.find((c) => c.ref === kept[0]);
    assert.deepEqual(rep.duplicates, [kept[0] === `e${e1}` ? `e${e2}` : `e${e1}`], '合并进来的记在留下的那条上');
    assert.ok(refs.includes(`e${e3}`), '别的场合的同一件事另留一条（受众不同，各自过关口①）');
  } finally { await w.cleanup(); }
});

test('档案卡要有线索：她自己、没被提到的场合和人的档案卡不进召回（不占名额、不把别的场合的名字带进来）；被点名的照常', async () => {
  const w = await world({ embedding: new FakeEmbedding() });
  try {
    const { core } = w;
    const work = seedEntity(core, { name: '工作群', kind: 'setting' });
    core.store.run("UPDATE entities SET setting_key = 'W' WHERE id = ?", work);
    // 档案卡都在稠密路上（短文字和什么都有点像），关于阿明的事实也在
    for (const [id, t] of [[w.me, '小鱼周末'], [work, '工作群周末'], [w.cousin, '小刚周末'], [w.ming, '阿明']]) w.worker.addDoc(`n${id}`, t);
    const a = seedAssertion(core, { text: '阿明周末去爬山', subjects: [w.ming] });
    w.worker.addDoc(`a${a}`, '阿明周末去爬山');
    // 问的是阿明：名字匹配器只认出阿明
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '阿明周末干嘛了', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    const refs = set.items.map((c) => c.ref);
    assert.ok(!refs.includes(`n${w.me}`), `她自己的档案卡不算想起来的：${refs.join(' ')}`);
    assert.ok(!refs.includes(`n${work}`), `没被点到的场合档案卡不进来：${refs.join(' ')}`);
    assert.ok(!refs.includes(`n${w.cousin}`), `没被点到的人的档案卡不进来：${refs.join(' ')}`);
    assert.ok(refs.includes(`a${a}`));
    // 被点名的场合：档案卡照常能想起来
    addName(core, work, { text: '那个工作群' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN + 1000, actor: w.boss, text: '那个工作群周末有人加班吗', addressed: 'to-her' });
    const named = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    assert.ok(named.items.some((c) => c.ref === `n${work}`), `点了名的场合档案卡照常：${named.items.map((c) => c.ref).join(' ')}`);
  } finally { await w.cleanup(); }
});

test('版本：新版本一定在、最近被取代的跟在后面；只想起旧版本时把新版本放到前面', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    const old = seedAssertion(core, { text: '小刚的职业是外卖员', subjects: [w.cousin], recordedAt: T0 - 30 * DAY });
    const neu = seedAssertion(core, { text: '小刚现在开网约车', subjects: [w.cousin], recordedAt: T0 - DAY });
    supersede(core, old, neu);
    B[`a${old}`] = 2;
    B[`a${neu}`] = -10;   // 新版本自己想不起来
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚是外卖员吗', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary' });
    const refs = set.items.map((c) => c.ref);
    assert.ok(refs.indexOf(`a${neu}`) >= 0 && refs.indexOf(`a${neu}`) < refs.indexOf(`a${old}`));
    const n = set.items.find((c) => c.ref === `a${neu}`);
    const o = set.items.find((c) => c.ref === `a${old}`);
    assert.equal(n.previousRef, `a${old}`);
    assert.equal(o.versionOf, `a${neu}`);
  } finally { await w.cleanup(); }
});

test('发生次（S1b 的召回部分）：同一类事最近的那次排前，就算它自己没被想起来；几次时间接近标「可能指多次」', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    const lastWeek = seedAssertion(core, { text: '老板去驿站拿到了快递', subjects: [w.boss], kindHint: 'event', eventStart: T0 - 7 * DAY, planStatus: 'done' });
    const today = seedAssertion(core, { text: '老板说下午要去拿快递', subjects: [w.boss], kindHint: 'plan', eventStart: T0 - 4 * HOUR, planStatus: 'planned' });
    sameType(core, lastWeek, today);
    B[`a${lastWeek}`] = 2;
    B[`a${today}`] = -10;
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '驿站拿到了吗', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary' });
    const refs = set.items.map((c) => c.ref);
    assert.ok(refs.includes(`a${today}`), '最近的一次带出来了');
    assert.ok(refs.indexOf(`a${today}`) < refs.indexOf(`a${lastWeek}`));
    const t = set.items.find((c) => c.ref === `a${today}`);
    const l = set.items.find((c) => c.ref === `a${lastWeek}`);
    assert.equal(t.occurrence.latest, true);
    assert.equal(l.occurrence.latest, false);
    assert.equal(t.occurrence.ambiguous, false, '一周前和今天，分得清');
    // 两次挨得很近：上午一次、下午一次，晚上问
    const am = seedAssertion(core, { text: '老板上午拿了一个快递', subjects: [w.boss], kindHint: 'event', eventStart: T0 - 5 * HOUR });
    sameType(core, am, today);
    B[`a${am}`] = 2;
    const s2 = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary' });
    assert.equal(s2.items.find((c) => c.ref === `a${today}`).occurrence.ambiguous, true);
  } finally { await w.cleanup(); }
});

test('每个实体最多 3 条（她自己、这次问的那个人不限）', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    for (let i = 0; i < 6; i++) { const id = seedAssertion(core, { text: `小刚的第${i}件事`, subjects: [w.cousin] }); B[`a${id}`] = 2 - i * 0.1; }
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '小刚的事', addressed: 'to-her' });
    // 测的是全库流水线（D155 的回忆把问到的人当范围，范围里的不受这个上限）
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', recollect: false });
    assert.equal(set.items.filter((c) => c.meta?.kind === 'assertion' && c.meta.about.includes(w.cousin)).length, 3);
    const asked = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', about: '小刚' });
    assert.ok(asked.items.filter((c) => c.meta?.kind === 'assertion').length > 3);
  } finally { await w.cleanup(); }
});

test('知道感（有意回想）：线索命中很强、A 只差一点没过 τ_del 的带 fok 标记；差得远的、不自主回想都不给', async () => {
  const near = new Set();
  const far = new Set();
  const env = await world({
    mods: {
      dynamics: {
        activate: (core, inputs, ctx) => {
          const tau = core.config.get().activation.tauDeliberate;
          return inputs.map((i) => {
            const A = near.has(i.candidate.ref) ? tau - 0.5 : far.has(i.candidate.ref) ? tau - 5 : tau + 1;
            return { ...i.candidate, A, P: 1 / (1 + Math.exp(-(A - tau) / 0.4)), parts: { B: 0, S: i.S, C: i.C, I: 0, Psup: 0, eps: 0 } };
          });
        },
        sample: (core, scored, ctx) => scored.filter((c) => (ctx.mode === 'deliberate' ? c.A >= core.config.get().activation.tauDeliberate : c.P >= 0.5)),
        pRecall: (A, t, s) => 1 / (1 + Math.exp(-(A - t) / s)), pHold: () => 1, tense: () => 'present',
      },
    },
  });
  try {
    const { core } = env;
    const a = seedAssertion(core, { text: '小刚开网约车', subjects: [env.cousin] });
    const b = seedAssertion(core, { text: '小刚以前在工地', subjects: [env.cousin] });
    near.add(`a${a}`);
    far.add(`a${b}`);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: env.boss, text: '小刚是干啥的', addressed: 'to-her' });
    // 测的是全库流水线的知道感；回忆（D155）里范围内找到的不看激活进不进（太淡的渲染成「印象很模糊」），这里关掉回忆
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', recollect: false });
    assert.equal(set.items.find((x) => x.ref === `a${a}`)?.fok, true);
    assert.ok(!set.items.some((x) => x.ref === `a${b}`), '差得远的就是想不起来');
    assert.equal(set.items.filter((x) => x.fok).length, 1, '最多 fok.maxItems（默认 1）条');
    const inv = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary' });
    assert.ok(!inv.items.some((x) => x.fok));
  } finally { await env.cleanup(); }
});

test('时间路：「昨天」只把昨天的情节和事实加进来，时间窗命中算进 C', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    const yday = seedEpisode(core, { settingKey: 'G', narrative: '大家在群里聊团建去哪', tStart: T0 - DAY, tEnd: T0 - DAY + HOUR });
    const old = seedEpisode(core, { settingKey: 'G', narrative: '大家在群里聊过年回不回家', tStart: T0 - 20 * DAY, tEnd: T0 - 20 * DAY + HOUR });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '昨天群里聊啥了', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    const y = set.items.find((c) => c.ref === `e${yday}`);
    assert.ok(y && y.ranks.time === 1);
    const inputs = calls.activate.at(-1).inputs;
    assert.ok(!inputs.some((i) => i.candidate.ref === `e${old}` && i.candidate.ranks.time));
    assert.equal(inputs.find((i) => i.candidate.ref === `e${yday}`).candidate.signals.timeHit > 0, true);
  } finally { await w.cleanup(); }
});

test('在场者近况：present 里每个人（含她自己）最近 12 小时在别的场合说过的、这里没出现过的；被 @ 的人的不带', async () => {
  const w = await world();
  try {
    const { core } = w;
    seedPresence(core, 'D', [w.boss, w.me], 'exact');
    const said = seedPercept(core, { settingKey: 'G', at: T0 - 2 * MIN, actor: w.boss, text: '今晚又要加班', attention: 'peripheral' });
    const old = seedPercept(core, { settingKey: 'G', at: T0 - 13 * HOUR, actor: w.boss, text: '昨晚也加班' });
    const mine = seedPercept(core, { settingKey: 'G', at: T0 - 30 * MIN, self: true, actor: w.me, kind: 'self-utterance', text: '我推荐了一款显卡' });
    const ming = seedPercept(core, { settingKey: 'G', at: T0 - 5 * MIN, actor: w.ming, text: '阿明在群里说的近况' });
    const sum = seedEpisode(core, { settingKey: 'G', epKind: 'summary', narrative: '下午在游戏群和大家聊显卡涨价', tStart: T0 - 3 * HOUR, tEnd: T0 - HOUR });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '@阿明 你在吗', addressed: 'to-her', mentions: [{ entityId: w.ming }] });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary' });
    const pres = set.stats.routes.find((r) => r.route === 'present');
    assert.ok(pres.hits >= 3);
    const inputs = w.calls.activate.at(-1).inputs.map((i) => i.candidate);
    const has = (ref) => inputs.some((c) => c.ref === ref && c.ranks.present);
    assert.ok(has(`p${said}`), '主人两分钟前在群里说的（S4 的召回部分）');
    assert.ok(has(`p${mine}`), '她自己在别处说的');
    assert.ok(has(`e${sum}`), '她自己的「今天到目前为止」');
    assert.ok(!has(`p${old}`), '超过 12 小时');
    assert.ok(!has(`p${ming}`), '被 @ 的人不在场，不带他的近况');
  } finally { await w.cleanup(); }
});

test('出错不抛到聊天路径：dynamics 坏了退回 S + C，worker 全坏了只剩主线程的两路', async () => {
  const w = await world({
    mods: {
      dynamics: { activate: () => { throw new Error('x'); }, sample: () => { throw new Error('x'); }, pRecall: () => 0.5, pHold: () => 1, tense: () => 'present' },
      worker: {
        embedQuery: async () => { throw new Error('x'); }, denseSearch: async () => { throw new Error('x'); },
        lexicalSearch: async () => { throw new Error('x'); }, termStats: async () => { throw new Error('x'); },
        pprSearch: async () => { throw new Error('x'); }, storedVectors: async () => { throw new Error('x'); },
      },
    },
  });
  try {
    const { core } = w;
    seedPresence(core, 'D', [w.boss, w.me], 'exact');
    const said = seedPercept(core, { settingKey: 'G', at: T0 - 2 * MIN, actor: w.boss, text: '今晚又要加班' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '在吗', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate' });
    assert.ok(set.items.some((c) => c.ref === `p${said}`));
    assert.ok(w.ports.logger.events('retrieve.dynamics.fallback').length >= 1);
    w.ports.logger.assertNoText('今晚又要加班', '在吗');
  } finally { await w.cleanup(); }
});
