// D158：一句话是不是在跟她说，按意思判断（第一眼的 to），不按有没有 @。
//   - 结构上是旁听、第一眼判成对她说的 → 抬成 to-her，走「现在是对她说的了」的路（完整预取），这一轮回想当成直接问她的；
//   - 判成对大家说的 → mentions-her；判成对别人说的 → 不抬（asks 也不算数）；结构上已经是对她说的 → 不动、不降；
//   - 回想开始时第一眼还在看：等一小会儿，等到了用上，等不到照结构上的值走、下一次回想用上；
//   - 第一眼出错、输出不合法 → 不抬，别的字段照常。
// 第一眼的替身按词判断（真模型自己看）；人名、话都是编的；账号、群号是假平台随机生成的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, platformSeeds, FakeLLM, glancer, deferred, readGlanceCard, recallAt } from '../scenarios/presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const row = (w, o) => w.perceptOf(o);
const G = (w, o) => w.core.mods.discretion.glancesOf(w.core, [row(w, o).id]).get(row(w, o).id) ?? null;
const metricOf = (w, name) => Number(w.core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0);

/** 第一眼的替身：「几点关门」接着问她、「老陈你」转去问别人、「大家」对全群、其余看不出来。 */
const toJudge = (t) => {
  if (t.who === '你') return {};
  if (/几点关门|还记得/.test(t.text)) return { to: 'her' };
  if (/老陈你/.test(t.text)) return { to: 'others', asks: true };
  if (/大家/.test(t.text)) return { to: 'all' };
  return { to: 'unclear' };
};

/** 换掉 core.mods 里的几个函数（看回想交给关口①的 direct、通知 retrieve 的行）；返回还原函数。 */
function spy(w, rec) {
  const real = w.core.mods;
  w.core.mods = Object.freeze({
    ...real,
    discretion: Object.freeze({ ...real.discretion, targetFor: (core, p) => { rec.targets.push(p); return real.discretion.targetFor(core, p); } }),
    retrieve: Object.freeze({ ...real.retrieve, onPercepts: (core, key, rows) => { rec.notified.push(...rows); return real.retrieve.onPercepts(core, key, rows); } }),
  });
  return () => { w.core.mods = real; };
}

/** 群里：他先 @ 她问一句、她答了；然后他不带 @ 接着问。 */
function followUp(w, text = '那家面馆几点关门来着') {
  const ask = w.say('smallGroup', 'principal', '@她 上周我们说的那家面馆叫什么', { addressed: 'to-her', attention: 'attended' });
  w.say('smallGroup', 'her', '叫老林面馆呀');
  const next = w.say('smallGroup', 'principal', text, { addressed: 'ambient', attention: 'peripheral' }, 2000);
  return { ask, next };
}

test('接着问她（没带 @）：第一眼判成对她说的 → 抬成 to-her、记下是第一眼抬的；完整预取；这一轮当成直接问她的', async () => {
  const seen = [];
  const w = await openWorld({ seed: SEED, name: 'addr-follow', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer(toJudge, seen) } }) });
  const rec = { targets: [], notified: [] };
  const undo = spy(w, rec);
  try {
    const { ask, next } = followUp(w);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(row(w, next).addressed, 'to-her', '按意思抬高');
    assert.equal(G(w, next).addressee, 'her');
    assert.equal(G(w, next).raised, 'to-her', '记下是第一眼抬的');
    assert.equal(row(w, ask).addressed, 'to-her', '结构上的不动');
    assert.ok(rec.notified.some((r) => r.id === row(w, next).id && r.addressed === 'to-her'), '走「现在是对她说的了」那条路：retrieve 收到抬高以后的行（完整预取）');
    assert.ok(metricOf(w, 'intake.addressed.raised') >= 1);
    // 卡片上：结构上对她说的那一行标了〔对你说〕，要看的这一行没标
    const card = seen.find((c) => c.targets.some((t) => /几点关门/.test(t.text)));
    assert.equal(card.lines.find((l) => /叫什么/.test(l.text))?.mark, '对你说');
    assert.equal(card.targets.find((t) => /几点关门/.test(t.text)).mark, null);
    // 这一轮回想：当成直接问她的（交给关口①的 direct = true）
    await recallAt(w, 'smallGroup', next);
    const t = rec.targets.find((x) => x.focusPerceptId === row(w, next).id);
    assert.equal(t?.direct, true, '被直接问到');
    // 第一眼抬上来的：话里的 @ 不是在叫她，一个都不去掉
    assert.equal(w.core.mods.discretion.withoutAddress(w.core, row(w, next)), row(w, next).text);
  } finally { undo(); await w.close(); }
});

test('同一句话没有第一眼的判断（unclear）：照结构上的值走，这一轮不当成直接问她的', async () => {
  const w = await openWorld({ seed: SEED, name: 'addr-unclear', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer(() => ({ to: 'unclear' })) } }) });
  const rec = { targets: [], notified: [] };
  const undo = spy(w, rec);
  try {
    const { next } = followUp(w);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(row(w, next).addressed, 'ambient');
    assert.equal(G(w, next).addressee, 'unclear');
    assert.equal(G(w, next).raised, null);
    await recallAt(w, 'smallGroup', next);
    assert.equal(rec.targets.find((x) => x.focusPerceptId === row(w, next).id)?.direct, false);
  } finally { undo(); await w.close(); }
});

test('转去问别人 → 不抬（asks 也不算数）；对着全群问 → mentions-her；结构上 @ 她的、替身说是对别人 → 不降', async () => {
  const judge = (t) => (/@她/.test(t.text) ? { to: 'others' } : toJudge(t));
  const w = await openWorld({ seed: SEED, name: 'addr-kinds', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer(judge) } }) });
  try {
    const { ask } = followUp(w, '老陈你周末去不去爬山');
    const turned = w.perceptOf.bind(w);
    const others = w.say('smallGroup', 'principal', '老陈你周末去不去爬山，帮我记着', { addressed: 'ambient', attention: 'peripheral' }, 2000);
    const all = w.say('smallGroup', 'principal', '今晚大家吃什么', { addressed: 'ambient', attention: 'peripheral' }, 2000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(turned(others).addressed, 'ambient', '对别人说的：不抬');
    assert.equal(G(w, others).addressee, 'others');
    assert.equal(G(w, others).asks, false, '对别人说的话不是在要她做什么');
    assert.equal(G(w, others).raised, null);
    assert.equal(turned(all).addressed, 'mentions-her', '对包括她在内的大家说的');
    assert.equal(G(w, all).raised, 'mentions-her');
    assert.equal(turned(ask).addressed, 'to-her', '结构上 @ 她的：判成对别人也不降');
    assert.equal(G(w, ask).raised, null);
  } finally { await w.close(); }
});

test('一对一：结构上就是对她说的，不抬也不降', async () => {
  const w = await openWorld({ seed: SEED, name: 'addr-dm', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer(() => ({ to: 'others' })) } }) });
  try {
    const a = w.say('oneOnOne', 'principal', '老陈你去不去', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(row(w, a).addressed, 'to-her');
    assert.equal(G(w, a).raised, null);
  } finally { await w.close(); }
});

test('回想开始时第一眼还在看：等它，等到了这一轮就用上', async () => {
  const gates = [];
  const glance = glancer(toJudge);
  const llm = new FakeLLM({ fallback: { glance: async (req) => {
    if (readGlanceCard(req).targets.some((t) => /几点关门/.test(t.text))) { const g = deferred(); gates.push(g); await g.promise; }
    return glance(req);
  } } });
  const w = await openWorld({ seed: SEED, name: 'addr-wait', config: LIVE, llm });
  const rec = { targets: [], notified: [] };
  const undo = spy(w, rec);
  try {
    const { next } = followUp(w);
    await w.flush();
    for (let i = 0; i < 50 && !gates.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(G(w, next)?.state, 'pending', '还在看');
    setTimeout(() => { for (const g of gates.splice(0)) g.resolve(); }, 60);
    await recallAt(w, 'smallGroup', next);
    assert.equal(rec.targets.find((x) => x.focusPerceptId === row(w, next).id)?.direct, true, '等到了：这一轮当成直接问她的');
    assert.equal(metricOf(w, 'context.addresseeWait.done'), 1);
  } finally { for (const g of gates) g.resolve(); undo(); await w.close(); }
});

test('等不到（上限内没看完）：照结构上的值走；看完以后下一次回想用上', async () => {
  const gates = [];
  const glance = glancer(toJudge);
  const llm = new FakeLLM({ fallback: { glance: async (req) => {
    const card = readGlanceCard(req);
    if (card.targets.some((t) => /几点关门/.test(t.text))) { const g = deferred(); gates.push(g); await g.promise; }
    return glance(req);
  } } });
  const w = await openWorld({ seed: SEED, name: 'addr-timeout', config: { ...LIVE, discretion: { glance: { recallWaitMs: 80 } } }, llm });
  const rec = { targets: [], notified: [] };
  const undo = spy(w, rec);
  try {
    const { next } = followUp(w);
    await w.flush();
    for (let i = 0; i < 50 && !gates.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(G(w, next)?.state, 'pending');
    await recallAt(w, 'smallGroup', next);
    assert.equal(rec.targets.find((x) => x.focusPerceptId === row(w, next).id)?.direct, false, '等不到：照结构上的值（旁听）');
    assert.equal(metricOf(w, 'context.addresseeWait.timeout'), 1);
    for (const g of gates.splice(0)) g.resolve();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(row(w, next).addressed, 'to-her', '看完了：抬上去');
    rec.targets.length = 0;
    await recallAt(w, 'smallGroup', next);
    assert.equal(rec.targets.find((x) => x.focusPerceptId === row(w, next).id)?.direct, true, '下一次回想用上');
  } finally { for (const g of gates) g.resolve(); undo(); await w.close(); }
});

test('第一眼出错 → 不抬；输出不合法（to 不认得）→ 不抬，别的字段照常写', async () => {
  const llm = new FakeLLM({ script: { glance: [] }, fallback: { glance: glancer((t) => (/几点关门/.test(t.text) ? { to: 'boss', gist: '问面馆几点关门' } : {})) } });
  const w = await openWorld({ seed: SEED, name: 'addr-bad', config: LIVE, llm });
  try {
    const { next } = followUp(w);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const g = G(w, next);
    assert.equal(g.state, 'done');
    assert.equal(g.addressee, null, '不认得的值：没判断');
    assert.equal(g.gist, '问面馆几点关门', '别的字段照常');
    assert.equal(row(w, next).addressed, 'ambient');
  } finally { await w.close(); }
  const w2 = await openWorld({ seed: SEED, name: 'addr-err', config: LIVE, llm: new FakeLLM({ fallback: { glance: new Error('down') } }) });
  try {
    const { next } = followUp(w2);
    await w2.flush();
    await w2.core.mods.discretion.glancesIdle(w2.core);
    assert.equal(G(w2, next).state, 'failed');
    assert.equal(row(w2, next).addressed, 'ambient', '出错：不抬');
  } finally { await w2.close(); }
});

test('她没在说话、也没回过他：这句话不排第一眼，回想不等', async () => {
  const w = await openWorld({ seed: SEED, name: 'addr-quiet', config: LIVE, llm: new FakeLLM({ fallback: { glance: glancer(toJudge) } }) });
  try {
    const a = w.say('smallGroup', 'other', '你还记得上周那件事吗', { addressed: 'ambient', attention: 'peripheral' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(G(w, a), null);
    await recallAt(w, 'smallGroup', a);
    assert.equal(metricOf(w, 'context.addresseeWait.done') + metricOf(w, 'context.addresseeWait.timeout'), 0);
  } finally { await w.close(); }
});
