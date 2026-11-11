// 线索窗口的边界、沿链接带出、五路的细节（§8.1、§8.2、§8.3、§6.6、§5.2、§5.5）：
//   眼前的对话不算回想；很长的空白之前的话不算眼下的线索（S20b 的召回部分）；关系路径的线索；实体路的种子；
//   随机用户文本拼出的词法查询永不报错（§14.2「检索」）；计划的结果跟着计划走（S1 的召回部分）；同一类事的几次；
//   「可能是同一个人」的内容带「好像」；别的场合说的事照样想得起（S25 的召回部分）；预取的改写给有意回想做查询扩展。
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEmbedding } from '../fakes/embedding.js';
import { FakeLLM } from '../fakes/llm.js';
import { fakePorts } from '../fakes/ports.js';
import { windowCaps } from '../../src/retrieve/cues.js';
import { relevanceScale } from '../../src/retrieve/pipeline.js';
import {
  retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedWindow, seedPresence, seedDescriptor, supersede, sameType, insertRow,
  T0, MIN, HOUR, DAY,
} from './fixtures.js';

const R = (core, s, opt) => core.mods.retrieve.recall(core, { trigger: 'simulate', ...s }, { deadlineMs: 3000, ...opt });

async function world(o = {}) {
  const env = await retrieveCore(o);
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明', closeness: 0.3 });
  const cousin = seedEntity(core, { name: null });
  seedDescriptor(core, cousin, ming, '表哥');
  seedSetting(core, 'G', { label: '游戏群' });
  seedSetting(core, 'W', { label: '工作群' });
  seedSetting(core, 'D', { label: '私聊' });
  seedPresence(core, 'D', [me, boss], 'exact');
  return { ...env, me, boss, ming, cousin };
}

test('windowCaps：最新的 minMsgs 条一定都在（注水平分，短的不截）；有余量再往前补，最后一条放不下就截短', () => {
  assert.deepEqual(windowCaps([10, 10, 10], 6, 400), [10, 10, 10]);
  assert.deepEqual(windowCaps([300, 300, 20], 6, 400), [190, 190, 20], '两条长的截到同一个水位，短的照原样');
  assert.deepEqual(windowCaps(new Array(12).fill(50), 6, 400), [...new Array(8).fill(50), 0, 0, 0, 0]);
  assert.deepEqual(windowCaps(new Array(7).fill(50), 6, 330), [50, 50, 50, 50, 50, 50, 30]);
  assert.deepEqual(windowCaps([], 6, 400), []);
  const caps = windowCaps([500, 500, 500, 500, 500, 500, 500], 6, 400);
  assert.equal(caps.filter((c) => c > 0).length, 6);
  assert.ok(caps.reduce((a, b) => a + b, 0) <= 400);
});

test('relevanceScale：MMR 的相关度是这一批里归一化的 A（有意回想时 P 全都接近 1，不能拿来排）', () => {
  const f = relevanceScale([{ A: 3 }, { A: 1 }, { A: -1 }]);
  assert.equal(f({ A: 3 }), 1);
  assert.equal(f({ A: -1 }), 0);
  assert.equal(f({ A: 1 }), 0.5);
  assert.equal(relevanceScale([{ A: 2 }])({ A: 2 }), 1);
  assert.equal(relevanceScale([])({ A: 2 }), 1);
});

test('眼前的对话不算回想：线索窗口里的感知、整段落在窗口里的原文窗口不进候选；更早的原话照样想得起', async () => {
  const w = await world();
  try {
    const { core } = w;
    // 两天前的私聊：说过显卡的事（已经有原文窗口）
    const o1 = seedPercept(core, { settingKey: 'D', at: T0 - 2 * DAY, actor: w.boss, text: '我想换一块显卡', addressed: 'to-her' });
    const o2 = seedPercept(core, { settingKey: 'D', at: T0 - 2 * DAY + MIN, self: true, actor: w.me, kind: 'self-utterance', text: '显卡最近在涨价' });
    const oldWin = seedWindow(core, { settingKey: 'D', first: o1, last: o2, tStart: T0 - 2 * DAY, tEnd: T0 - 2 * DAY + MIN, text: '老板：我想换一块显卡 / 我：显卡最近在涨价' });
    // 现在
    const n1 = seedPercept(core, { settingKey: 'D', at: T0 - 2 * MIN, actor: w.boss, text: '显卡降价了吗', addressed: 'to-her' });
    const n2 = seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '显卡还是贵', addressed: 'to-her' });
    const nowWin = seedWindow(core, { settingKey: 'D', first: n1, last: n2, tStart: T0 - 2 * MIN, tEnd: T0 - MIN, text: '老板：显卡降价了吗 / 老板：显卡还是贵' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '显卡' });
    const refs = set.items.map((c) => c.ref);
    assert.ok(!refs.includes(`p${n1}`) && !refs.includes(`p${n2}`), '眼前这两句不是「想起来的」');
    assert.ok(!refs.includes(`w${nowWin}`));
    assert.ok(refs.includes(`p${o1}`) || refs.includes(`w${oldWin}`), '两天前说过的照样想得起');
    // 稠密路也把它们排除在外（worker 的 exclude）
    const dq = w.calls.denseSearch?.at(-1);
    if (dq) assert.ok(dq.exclude?.has(`p${n2}`));
  } finally { await w.cleanup(); }
});

test('S20b（召回部分）：隔了三周再说「在吗」，三周前的话不算眼下的线索——窗口在长空白处截断，旧话题的词不进查询', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    seedPercept(core, { settingKey: 'D', at: T0 - 21 * DAY, actor: w.boss, text: '周末去爬山的装备买好了吗', addressed: 'to-her' });
    seedPercept(core, { settingKey: 'D', at: T0 - 21 * DAY + MIN, self: true, actor: w.me, kind: 'self-utterance', text: '登山鞋还没到' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '在吗', addressed: 'to-her' });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'D' });
    assert.equal(cues.window.length, 1);
    assert.equal(cues.window[0].text, '在吗');
    assert.ok(!/爬山|登山/.test(cues.windowText));
    await R(core, { settingKey: 'D' }, { mode: 'involuntary', deadlineMs: 800 });
    const terms = calls.lexicalSearch.at(-1)?.terms ?? [];
    assert.ok(!terms.some((t) => /爬山|登山/.test(t)), '旧话题的词不进词法查询');
    assert.ok(calls.embedQuery.at(-1).every((t) => !t.includes('爬山')), '也不进查询向量');
    // 空白不长（同一晚上的对话）就不截
    seedPercept(core, { settingKey: 'G', at: T0 - 3 * HOUR, actor: w.ming, text: '晚上一起打游戏吗' });
    seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: w.ming, text: '人呢' });
    assert.equal(core.mods.retrieve.buildCues(core, { settingKey: 'G' }).window.length, 2);
  } finally { await w.cleanup(); }
});

test('关系路径：「我表哥」挂在这句话的说话人下面，「阿明的表哥」挂在紧挨着的名字下面——表哥的档案进线索，关于他的事想得起', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    const fact = seedAssertion(core, { text: '开网约车', subjects: [w.cousin], certainty: 'hearsay', confidence: 0.6,
      sources: [{ speaker: w.ming, mode: 'told_to_her', hop: 1, perceivedIn: 'G', at: T0 - 10 * DAY }] });
    seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: w.ming, text: '我表哥最近又换车了', addressed: 'to-her' });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'G' });
    assert.ok(cues.names.some((n) => n.entityId === w.cousin), '「我」= 说话人阿明，表哥是阿明的表哥');
    const set = await R(core, { settingKey: 'G' }, { mode: 'deliberate' });
    const c = set.items.find((x) => x.ref === `a${fact}`);
    assert.ok(c, '关于表哥的事想起来了（一个词都不重合，靠实体路）');
    assert.ok(c.ranks.entity);
    assert.ok(calls.pprSearch.at(-1).seeds.some((s) => s.entityId === w.cousin && s.weight > 0.5));
    // 别人说「阿明的表哥」也认得出
    seedPercept(core, { settingKey: 'D', at: T0, actor: w.boss, text: '阿明的表哥是干啥的', addressed: 'to-her' });
    assert.ok(core.mods.retrieve.buildCues(core, { settingKey: 'D' }).names.some((n) => n.entityId === w.cousin));
  } finally { await w.cleanup(); }
});

test('实体路的种子：正文里的名字、被提到的人、正在对她说话的人、在场的人（权重低一些）、查询匹配到的前几条事实的实体；不含她自己', async () => {
  const w = await world();
  try {
    const { core, calls } = w;
    const jie = seedEntity(core, { name: '阿杰' });
    const lurker = seedEntity(core, { name: '潜水员' });
    const third = seedEntity(core, { name: null });
    seedPresence(core, 'W', [w.me, w.boss, lurker], 'exact');
    seedAssertion(core, { text: '周报下周一交', subjects: [third] });
    seedPercept(core, { settingKey: 'W', at: T0 - MIN, actor: w.boss, text: '阿明说周报的事 @阿杰', addressed: 'mentions-her', mentions: [{ entityId: jie }] });
    await R(core, { settingKey: 'W' }, { mode: 'involuntary', deadlineMs: 800 });
    const q = calls.pprSearch.at(-1);
    const seed = Object.fromEntries(q.seeds.map((s) => [s.entityId, s.weight]));
    assert.equal(seed[w.ming], 1, '正文里的名字');
    assert.equal(seed[jie], 1, '被 @ 的人是线索');
    assert.equal(seed[w.boss], 0.5, '正在对她说话的人是情境不是内容，只当弱种子（D149）');
    assert.equal(seed[lurker], 0.5, '在场的人');
    assert.equal(seed[third], 0.5, '词法命中的事实的主体');
    assert.equal(seed[w.me], undefined, '她自己不是种子（关于她的事太多，稀释一切）');
    assert.equal(q.maxHops, 2);
  } finally { await w.cleanup(); }
});

test('§14.2：随机用户文本（AND、NOT、NEAR、x:y、c++、引号、括号、星号）拼出的词法查询永不报错', async () => {
  // lang 替身直接按空白切词（不去标点），让各种 FTS 语法字符原样到达 store.matchQuery
  const w = await world({ mods: { lang: { queryTerms: (core, text) => String(text).split(/\s+/).filter(Boolean) } } });
  try {
    const { core, calls, ports } = w;
    seedAssertion(core, { text: '老板 喜欢 c++ 和 rust', subjects: [w.boss] });
    const parts = ['AND', 'OR', 'NOT', 'NEAR', 'NEAR(', 'x:y', 'c++', '"', "'", '(', ')', '*', '^', '-', '+', 'col:', '{a b}', 'AND"', 'ent_1', '老板', '显卡', ':', 'NEAR/3'];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 25; i++) {
      const n = 1 + Math.floor(rnd() * 8);
      const text = Array.from({ length: n }, () => parts[Math.floor(rnd() * parts.length)]).join(' ');
      seedPercept(core, { settingKey: 'D', at: T0 + i, actor: w.boss, text, addressed: 'to-her' });
      ports.clock.set(T0 + i + 1);
      const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: text });
      assert.ok(Array.isArray(set.items), text);
    }
    assert.ok(calls.lexicalSearch.length >= 25);
    assert.ok(calls.lexicalSearch.every((q) => q.terms.length <= 12));
    assert.equal(ports.logger.events('retrieve.route.error').filter((e) => e.fields.route === 'lexical').length, 0, '词法路一次都没出错');
  } finally { await w.cleanup(); }
});

test('S1（召回部分）：三天后问「快递拿了没」——想起那条计划，结果跟着带出来；渲染写明「后来做完了」和结案的绝对时间', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    const told = T0 - 3 * DAY;
    const outcome = seedAssertion(core, { text: '东西到手了', subjects: [w.boss], kindHint: 'event', eventStart: told + 2 * HOUR,
      sources: [{ speaker: w.boss, mode: 'told_to_her', perceivedIn: 'D', at: told + 2 * HOUR }] });
    const plan = seedAssertion(core, { text: '老板说等下去拿快递', subjects: [w.boss], kindHint: 'plan', eventStart: told, planStatus: 'done',
      sources: [{ speaker: w.boss, mode: 'told_to_her', perceivedIn: 'D', at: told }] });
    core.store.run('UPDATE assertions SET plan_outcome_ref = ? WHERE id = ?', `a${outcome}`, plan);
    insertRow(core, 'plan_status_history', { assertion_id: plan, status: 'planned', at: told });
    insertRow(core, 'plan_status_history', { assertion_id: plan, status: 'done', at: told + 2 * HOUR });
    B[`a${outcome}`] = -10;   // 结果那条自己想不起来（和问话一个词都不重合），只能跟着计划带出
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '快递拿了没', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate' });
    const refs = set.items.map((c) => c.ref);
    assert.ok(refs.includes(`a${plan}`));
    const o = set.items.find((c) => c.ref === `a${outcome}`);
    assert.ok(o, '结果跟着计划带出来了');
    assert.equal(o.outcomeOf, `a${plan}`);
    assert.equal(refs.indexOf(`a${outcome}`), refs.indexOf(`a${plan}`) + 1);
    const r = core.mods.retrieve.render(core, set.items.find((c) => c.ref === `a${plan}`), { verdict: 'share', at: T0, itemChars: 120, settingKey: 'D' });
    assert.match(r.rendered, /^（10\/28 12:00，主人在这里自己说的）老板说等下去拿快递（后来做完了，10\/28 14:00）$/);
    // 不自主回想不沿链接多跳（结果那条照常要靠自己想起）
    const inv = await R(core, { settingKey: 'D' }, { mode: 'involuntary', deadlineMs: 800 });
    assert.ok(!inv.items.some((c) => c.ref === `a${outcome}`));
    // 还没结案的计划：时间过了写「到时候了，还没听说结果」；没听说结果的不写时间
    const due = seedAssertion(core, { text: '老板说下午去取快递', subjects: [w.boss], kindHint: 'plan', eventStart: T0 - 4 * HOUR, planStatus: 'planned' });
    const unk = seedAssertion(core, { text: '老板说要去银行', subjects: [w.boss], kindHint: 'plan', eventStart: T0 - 2 * DAY, planStatus: 'unknown' });
    insertRow(core, 'plan_status_history', { assertion_id: unk, status: 'unknown', at: T0 - DAY });
    const rd = core.mods.retrieve.render(core, { ref: `a${due}`, mref: { kind: 'assertion', id: due }, P: 0.95 }, { verdict: 'share', at: T0, itemChars: 120 });
    assert.match(rd.rendered, /（到时候了，还没听说结果）$/);
    const ru = core.mods.retrieve.render(core, { ref: `a${unk}`, mref: { kind: 'assertion', id: unk }, P: 0.95 }, { verdict: 'share', at: T0, itemChars: 120 });
    assert.match(ru.rendered, /（后来怎么样没听说）$/);
  } finally { await w.cleanup(); }
});

test('同一类事的几次：有意回想把同一类事最近的几次都带出来（最多 deliberateSiblings 次）；不自主回想只带最近的一次', async () => {
  const w = await world();
  try {
    const { core, B } = w;
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const id = seedAssertion(core, { text: `老板第${i}次去体检`, subjects: [w.boss], kindHint: 'event', eventStart: T0 - (40 - i * 10) * DAY });
      ids.push(id);
      if (i) sameType(core, ids[i - 1], id);
    }
    for (const id of ids) B[`a${id}`] = -10;
    B[`a${ids[0]}`] = 2;   // 只想起了最早的那次
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我上次体检是什么时候', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate' });
    const got = set.items.filter((c) => c.occurrence).map((c) => c.ref);
    assert.deepEqual(got.slice(0, 3), [`a${ids[3]}`, `a${ids[2]}`, `a${ids[1]}`], '最近的几次按时间倒序排在前面');
    assert.ok(got.includes(`a${ids[0]}`));
    assert.equal(set.items.find((c) => c.ref === `a${ids[3]}`).occurrence.latest, true);
    const inv = await R(core, { settingKey: 'D' }, { mode: 'involuntary', deadlineMs: 800 });
    const g2 = inv.items.filter((c) => c.occurrence).map((c) => c.ref);
    assert.deepEqual(g2, [`a${ids[3]}`, `a${ids[0]}`]);
  } finally { await w.cleanup(); }
});

test('可能是同一个人（§5.2 信念层）：经 maybe_same 链接想起来的事标 belief，渲染带「好像」、把握不超过链接的置信度', async () => {
  const w = await world();
  try {
    const { core } = w;
    const other = seedEntity(core, { name: '明哥' });
    insertRow(core, 'entity_links', { a: Math.min(w.ming, other), b: Math.max(w.ming, other), rel: 'maybe_same', confidence: 0.6, decided_by: 'extractor', at: T0, created_at: T0 });
    const f = seedAssertion(core, { text: '在杭州上班', subjects: [other], confidence: 0.95,
      sources: [{ speaker: other, mode: 'told_to_her', perceivedIn: 'W', at: T0 - 5 * DAY }] });
    const own = seedAssertion(core, { text: '养了一只柯基', subjects: [w.ming], confidence: 0.95,
      sources: [{ speaker: w.ming, mode: 'told_to_her', perceivedIn: 'G', at: T0 - 5 * DAY }] });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '阿明是做什么的', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate' });
    const c = set.items.find((x) => x.ref === `a${f}`);
    assert.ok(c, '沿 maybe_same 链接想起来了');
    assert.deepEqual(c.belief, { rel: 'maybe_same', confidence: 0.6 });
    assert.equal(set.items.find((x) => x.ref === `a${own}`)?.belief, undefined, '直接关于阿明的不标');
    const r = core.mods.retrieve.render(core, c, { verdict: 'share', at: T0, itemChars: 120, settingKey: 'D' });
    assert.match(r.rendered, /）好像在杭州上班$/);
    assert.ok(r.confidence <= 0.6);
  } finally { await w.cleanup(); }
});

test('S25（召回部分）：在工作群说过的、不敏感的事，第一次在游戏群被直接 @ 问起也想得起——召回从不按场合过滤', async () => {
  const w = await world();
  try {
    const { core } = w;
    const fact = seedAssertion(core, { text: '团建定在下周六去爬山', subjects: [], confidence: 0.9,
      sources: [{ speaker: w.boss, mode: 'overheard', perceivedIn: 'W', at: T0 - 2 * DAY }] });
    seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: w.ming, text: '@小鱼 团建去哪爬山来着', addressed: 'mentions-her' });
    // 有意还是不自主由 context 定（看起来在问过去 → 有意，§9.3.5 的时机也在 context）；两种都想得起
    for (const mode of ['involuntary', 'deliberate']) {
      const s = await R(core, { settingKey: 'G' }, { mode, deadlineMs: mode === 'deliberate' ? 3000 : 800 });
      assert.ok(s.items.some((c) => c.ref === `a${fact}`), `${mode}：工作群里的事在游戏群也想得起（能不能说留给关口①）`);
    }
    const set = await R(core, { settingKey: 'G' }, { mode: 'deliberate' });
    const r = core.mods.retrieve.render(core, set.items.find((c) => c.ref === `a${fact}`), { verdict: 'share', at: T0, itemChars: 120, settingKey: 'G' });
    assert.match(r.rendered, /在「工作群」/, '来源说得出是在哪个场合');
  } finally { await w.cleanup(); }
});

test('有意回想的查询扩展：预取时（对她说的消息）做过的指代改写，同一份线索的有意回想接着用', async () => {
  const llm = new FakeLLM({ script: { rewrite: ['老板上周说要去体检'] } });
  const emb = new FakeEmbedding();
  const w = await world({ ports: fakePorts({ embedding: emb, llm }), embedding: emb });
  try {
    const { core, calls } = w;
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '那事你还记得吗', addressed: 'to-her' });
    await core.mods.retrieve.prefetch(core, 'D', { full: true });
    assert.equal(llm.callsFor('rewrite').length, 1);
    await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'message' }, { mode: 'deliberate', deadlineMs: 3000 });
    assert.ok(calls.embedQuery.at(-1).some((t) => t.endsWith('老板上周说要去体检')), '改写出的线索也嵌了');
    assert.equal(llm.callsFor('rewrite').length, 1, '回想本身不调 LLM');
    // 有了新消息，旧的改写就不用了
    seedPercept(core, { settingKey: 'D', at: T0, actor: w.boss, text: '算了不说这个', addressed: 'to-her' });
    await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'message' }, { mode: 'deliberate', deadlineMs: 3000 });
    assert.ok(!calls.embedQuery.at(-1).some((t) => t.endsWith('老板上周说要去体检')));
  } finally { await w.cleanup(); }
});

test('版本：要求带历史时往回追 deliberateMaxHops 版；平时只带最近被取代的那一版', async () => {
  const w = await world();
  try {
    const { core } = w;
    const v1 = seedAssertion(core, { text: '阿明的工作是送外卖', subjects: [w.ming], recordedAt: T0 - 90 * DAY });
    const v2 = seedAssertion(core, { text: '阿明的工作是开网约车', subjects: [w.ming], recordedAt: T0 - 30 * DAY });
    const v3 = seedAssertion(core, { text: '阿明的工作是做程序员', subjects: [w.ming], recordedAt: T0 - DAY });
    supersede(core, v1, v2);
    supersede(core, v2, v3);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '阿明是做什么工作的', addressed: 'to-her' });
    const hist = await R(core, { settingKey: 'D' }, { mode: 'deliberate', includeHistory: true });
    const refs = hist.items.map((c) => c.ref);
    assert.ok(refs.indexOf(`a${v3}`) < refs.indexOf(`a${v2}`) && refs.indexOf(`a${v2}`) < refs.indexOf(`a${v1}`));
    assert.equal(hist.items.find((c) => c.ref === `a${v3}`).previousRef, `a${v2}`);
    assert.equal(hist.items.find((c) => c.ref === `a${v2}`).previousRef, `a${v1}`);
    const plain = await R(core, { settingKey: 'D' }, { mode: 'involuntary', deadlineMs: 800 });
    assert.equal(plain.items.find((c) => c.ref === `a${v3}`)?.previousRef, `a${v2}`);
    assert.equal(plain.items.find((c) => c.ref === `a${v2}`)?.previousRef, undefined, '平时只带一版');
  } finally { await w.cleanup(); }
});

test('render 只给「能说」「说个大概」出文字：别的结论、没给结论一律不给内容（fail closed）', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '阿明下周要搬家', subjects: [w.ming], sources: [{ speaker: w.ming, perceivedIn: 'G', at: T0 - DAY }] });
    const c = { ref: `a${a}`, mref: { kind: 'assertion', id: a }, P: 0.95 };
    for (const verdict of ['aware_private', 'omit', 'pending', undefined, 'SHARE']) {
      assert.equal(core.mods.retrieve.render(core, c, { verdict, at: T0, itemChars: 120 }).rendered, '', String(verdict));
    }
    assert.match(core.mods.retrieve.render(core, { ref: `a${a}` }, { verdict: 'share', at: T0, itemChars: 120 }).rendered, /阿明下周要搬家/, '只给 ref 也认得');
  } finally { await w.cleanup(); }
});

test('截止时间的硬上限（D137）：调用方给得再长，也只到配置里回想的几种截止时间里最大的那个；慢的那一路到点丢掉', async () => {
  const w = await world({ delays: { dense: 5000 }, config: { recall: { involuntary: { deadlineMs: 300 }, deliberate: { deadlineMs: 600, toolDeadlineMs: 600 } } } });
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '阿明下周要搬家', subjects: [w.ming] });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '阿明什么时候搬家', addressed: 'to-her' });
    const t0 = performance.now();
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', deadlineMs: 3000 });
    const ms = performance.now() - t0;
    assert.ok(ms < 1300, `用了 ${Math.round(ms)} ms`);
    assert.equal(set.stats.routes.find((r) => r.route === 'dense').timedOut, true);
    assert.ok(set.items.some((c) => c.ref === `a${a}`), '已完成的几路照样给出');
  } finally { await w.cleanup(); }
});

test('调用方放宽的截止时间算数（D137）：不自主回想给 4000 毫秒时，不会在 1500 就截止（真的 retrieve，查询模型冷加载那种慢）', async () => {
  const w = await world({ delays: { dense: 2000 } });
  try {
    const { core } = w;
    assert.equal(core.config.get().recall.involuntary.deadlineMs, 1500, '用的是默认配置');
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '阿明什么时候搬家', addressed: 'to-her' });
    const t0 = performance.now();
    const set = await R(core, { settingKey: 'D' }, { mode: 'involuntary', deadlineMs: 4000 });
    const ms = performance.now() - t0;
    assert.ok(ms >= 1900, `等到了慢的那一路（用了 ${Math.round(ms)} ms）`);
    assert.equal(set.stats.routes.find((r) => r.route === 'dense').timedOut, false, '稠密路没有在 1500 毫秒被截掉');
    // 没给截止时间：照模式的默认值（不自主 1500）
    const t1 = performance.now();
    const plain = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary', query: '搬家' });
    assert.ok(performance.now() - t1 < 1900, '没给就按 1500');
    assert.equal(plain.stats.routes.find((r) => r.route === 'dense').timedOut, true);
  } finally { await w.cleanup(); }
});

test('recall 不抛错：场合缺失、参数坏了都返回空的候选集', async () => {
  const w = await world();
  try {
    const { core } = w;
    for (const s of [null, {}, { settingKey: '' }, { settingKey: 42 }]) {
      const set = await core.mods.retrieve.recall(core, s, { mode: 'involuntary', deadlineMs: 800 });
      assert.deepEqual(set.items, []);
      assert.ok(Number.isInteger(set.degradeLevel));
    }
    const set = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'message' }, undefined);
    assert.deepEqual(set.items, [], '没有感知：线索为空');
    assert.equal(core.mods.retrieve.cached(core, 'nope'), null);
  } finally { await w.cleanup(); }
});
