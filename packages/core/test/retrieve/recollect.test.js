// 回忆（D155）在 retrieve 这一层：有意回想走新路——读懂问题、圈范围、范围内找 + 全库照跑一次、盖住时间、名额两档；出错退回全库那一份；
// 时间那一路换成「时间窗当范围、在里面按话题找」。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedEpisode, seedWindow, T0, MIN, HOUR, DAY } from './fixtures.js';
import { arrange, recollectTier, segOf } from '../../src/retrieve/recollect.js';
import { spreadOver } from '../../src/retrieve/routes.js';
import { focusOn } from '../../src/retrieve/render.js';
import { DEFAULTS, mergeConfig } from '../../src/config/defaults.js';

const R = (core, s, opt) => core.mods.retrieve.recall(core, { trigger: 'message', ...s }, { deadlineMs: 2000, ...opt });
const Y = Math.floor(T0 / DAY) * DAY - DAY;   // 昨天 0 点（测试里时区偏移是 0）

async function world(o = {}) {
  const env = await retrieveCore(o);
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明' });
  seedSetting(core, 'G', { label: '游戏群' });
  seedSetting(core, 'D', { label: '私聊' });
  return { ...env, me, boss, ming };
}

/** 昨天一整天：早、中、晚各一段说吃了什么，晚上另有一堆和吃沾边的闲聊（老路的时间那一路只看最晚的几十段）。 */
function seedYesterday(w) {
  const { core, worker } = w;
  const ep = (h, text, parts = [w.boss]) => {
    const id = seedEpisode(core, { settingKey: 'G', narrative: text, tStart: Y + h * HOUR, tEnd: Y + h * HOUR + 10 * MIN, participants: parts });
    worker.addDoc(`e${id}`, text);
    return `e${id}`;
  };
  const meals = { breakfast: ep(8, '老板早饭吃了煎饼果子'), lunch: ep(12, '老板午饭吃了一碗拉面'), dinner: ep(19, '老板晚饭吃了烤鱼') };
  for (let i = 0; i < 60; i++) ep(20 + (i % 3), `晚上大家聊零食和夜宵第${i}回`, [w.ming]);
  return meals;
}

test('没有时间、人、场合的问题：回忆退回全库那一份，候选和老路逐条一样；带上「没有限定」的事实', async () => {
  const w = await world();
  try {
    const { core, worker } = w;
    for (const t of ['游戏的新版本更新了', '那个副本很难打', '版本更新以后掉线了']) worker.addDoc(`a${seedAssertion(core, { text: t, subjects: [w.ming] })}`, t);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '新版本怎么样', addressed: 'to-her' });
    const off = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '新版本怎么样', recollect: false });
    const on = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '新版本怎么样' });
    assert.ok(off.items.length > 0);
    assert.deepEqual(on.items.map((c) => c.ref), off.items.map((c) => c.ref), '和老路逐条一样');
    assert.equal(on.recollect.scope, null, '没有圈范围');
    assert.equal(on.recollect.fallback, null);
    assert.equal(on.recollect.tier.kind, 'tool');
    assert.equal(off.recollect, undefined, '老路不带回忆的摘要');
    assert.ok(on.items.every((c) => Number.isFinite(c.recollect?.pick)), '每条带名额的先后');
  } finally { await w.cleanup(); }
});

test('关掉 recall.recollect.enabled：有意回想完全走原来的路；不自主回想（浮现）从来不走回忆', async () => {
  const w = await world({ config: { recall: { recollect: { enabled: false } } } });
  try {
    const { core } = w;
    seedYesterday(w);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我昨天吃了什么', addressed: 'to-her' });
    const off = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '老板昨天吃了什么', time: '昨天' });
    assert.equal(off.recollect, undefined);
    assert.ok(off.items.every((c) => c.recollect === undefined && c.scopeRank === undefined));
  } finally { await w.cleanup(); }
  const w2 = await world();
  try {
    seedYesterday(w2);
    seedPercept(w2.core, { settingKey: 'D', at: T0 - MIN, actor: w2.boss, text: '我昨天吃了什么', addressed: 'to-her' });
    const inv = await R(w2.core, { settingKey: 'D' }, { mode: 'involuntary' });
    assert.equal(inv.recollect, undefined, '浮现不走回忆');
  } finally { await w2.cleanup(); }
});

test('「老板昨天吃了什么」：时间窗和人是范围，范围内找到的在前，早、中、晚三顿都在；结果带意图和范围的事实', async () => {
  const w = await world();
  try {
    const { core } = w;
    const meals = seedYesterday(w);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我昨天都吃了啥', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '老板昨天吃了什么', about: '老板', time: '昨天' });
    const pos = Object.fromEntries(Object.entries(meals).map(([k, r]) => [k, set.items.findIndex((c) => c.ref === r)]));
    for (const [k, i] of Object.entries(pos)) assert.ok(i >= 0, `${k} 在候选里：${JSON.stringify(pos)}`);
    const rc = set.recollect;
    assert.deepEqual(rc.scope.given, { time: true, about: true, where: false });
    assert.equal(rc.intent.from.time, 'tool');
    assert.equal(rc.intent.from.about, 'tool');
    assert.ok(rc.scope.total >= 3 && rc.scope.counts.episodes >= 3, JSON.stringify(rc.scope));
    assert.ok(rc.segments.length > 1, '有时间窗：把有记忆的跨度切成几段');
    // 范围内找到的在前（带 scopeRank），排序不看 B 和 S
    const firstGlobal = set.items.findIndex((c) => !c.scopeRank);
    assert.ok(firstGlobal < 0 || set.items.slice(firstGlobal).every((c) => !c.scopeRank), '范围内的都排在全库的前面');
    for (const r of Object.values(meals)) assert.ok(set.items.find((c) => c.ref === r).scopeRank > 0);
    // 范围内的稠密、字面检索都带 only（只看范围里的）
    assert.ok(w.calls.denseSearch.some((q) => Array.isArray(q.only) && q.only.includes(meals.lunch)));
    assert.ok(w.calls.lexicalSearch.some((q) => Array.isArray(q.only)));
    // 名额的先后、时间都给 context
    assert.ok(set.items.every((c) => Number.isFinite(c.recollect.pick)));
    assert.equal(set.items.find((c) => c.ref === meals.lunch).recollect.t, Y + 12 * HOUR);
  } finally { await w.cleanup(); }
});

test('范围是空的：退回全库那一份，范围的事实照实写（0 条）', async () => {
  const w = await world();
  try {
    const { core, worker } = w;
    worker.addDoc(`a${seedAssertion(core, { text: '老板喜欢吃拉面', subjects: [w.boss] })}`, '老板喜欢吃拉面');
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我上周吃了啥', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '吃拉面', time: '上周' });
    assert.equal(set.recollect.scope.total, 0);
    assert.equal(set.recollect.scope.searched, false);
    assert.ok(set.items.every((c) => !c.scopeRank));
  } finally { await w.cleanup(); }
});

test('范围内检索超时：退回只有全库那一份，记哪一步，回想不失败', async () => {
  const w = await world({ delays: { lexical: 3000, dense: 3000 } });
  try {
    const { core } = w;
    seedYesterday(w);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我昨天吃了啥', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '老板昨天吃了什么', time: '昨天', deadlineMs: 600 });
    assert.equal(set.recollect.fallback, 'timeout');
    assert.ok(set.items.every((c) => !c.scopeRank));
    const m = core.store.get("SELECT SUM(value) AS n FROM metrics WHERE name = 'retrieve.recollect.fallback.timeout'");
    assert.ok(Number(m?.n) >= 1);
  } finally { await w.cleanup(); }
});

test('圈范围出错（查隐藏查不了）：退回全库那一份，记 scope', async () => {
  let n = 0;
  // 第一次（范围）出错，之后（全库那一次的预过滤）照常
  const w = await world({ mods: { admin: { suppressedRefs: (core, refs) => { n += 1; if (n === 1) throw new Error('down'); return new Set(); } } } });
  try {
    const { core } = w;
    seedYesterday(w);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我昨天吃了啥', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '老板昨天吃了什么', time: '昨天' });
    assert.equal(set.recollect.fallback, 'scope');
    assert.equal(set.recollect.scope, null);
    assert.ok(set.items.length > 0, '全库那一份照给');
  } finally { await w.cleanup(); }
});

test('盖住时间（arrange）：timeline 每段先各取一条再按名次；point 只按名次；null 一半一半；没有时间段只按名次', () => {
  const segs = [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 20, end: 30 }];
  // 名次 1–6 全在最后一段，7 在第一段，8 在第二段
  const mk = () => [25, 26, 27, 28, 29, 21, 5, 15].map((t, i) => ({ ref: `e${i + 1}`, meta: { tStart: t } }));
  const refs = (xs) => xs.map((c) => c.ref);
  assert.deepEqual(refs(arrange(mk(), { shape: 'timeline', segments: segs, n: 4 })).slice(0, 4), ['e7', 'e8', 'e1', 'e2'], '每段都有代表');
  assert.deepEqual(refs(arrange(mk(), { shape: 'point', segments: segs, n: 4 })).slice(0, 4), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(refs(arrange(mk(), { shape: null, segments: segs, n: 4 })).slice(0, 4), ['e7', 'e8', 'e1', 'e2'], 'null：前一半盖住');
  assert.deepEqual(refs(arrange(mk(), { shape: null, segments: segs, n: 8 })).slice(0, 4), ['e7', 'e8', 'e1', 'e2']);
  assert.deepEqual(refs(arrange(mk(), { shape: 'timeline', segments: [], n: 4 })).slice(0, 4), ['e1', 'e2', 'e3', 'e4']);
  assert.equal(segOf(segs, -5), 0);
  assert.equal(segOf(segs, 99), 2);
});

test('名额两档随花费档位：节省档条数和总字数减半，每条字数不变', () => {
  const loose = recollectTier(DEFAULTS, 'tool');
  assert.deepEqual(loose, { kind: 'tool', maxItems: 36, itemChars: 300, totalChars: 4000 });
  assert.deepEqual(recollectTier(DEFAULTS, 'auto'), { kind: 'auto', maxItems: 18, itemChars: 240, totalChars: 2000 });
  const saving = mergeConfig(DEFAULTS, { budget: { preset: 'saving' } }).config;
  assert.deepEqual(recollectTier(saving, 'tool'), { kind: 'tool', maxItems: 18, itemChars: 300, totalChars: 2000 });
  assert.deepEqual(recollectTier(saving, 'auto'), { kind: 'auto', maxItems: 9, itemChars: 240, totalChars: 1000 });
  const custom = mergeConfig(DEFAULTS, { budget: { overrides: { recollectScale: 0.25 } } }).config;
  assert.equal(recollectTier(custom, 'tool').maxItems, 9);
});

test('时间那一路：时间窗当范围（只看范围里的），有查询向量时按话题排；没有向量时在跨度上均匀取，不是只取最晚的', async () => {
  const w = await world();
  try {
    const { core } = w;
    const meals = seedYesterday(w);
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '我昨天吃了啥', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'D' }, { mode: 'involuntary' });
    const tr = set.stats.routes.find((r) => r.route === 'time');
    assert.ok(tr.hits > 0);
    const q = w.calls.denseSearch.find((x) => Array.isArray(x.only));
    assert.ok(q, '时间路的稠密检索带 only');
    assert.ok(q.only.includes(meals.breakfast) && q.only.includes(meals.dinner));
  } finally { await w.cleanup(); }
  // 均匀取：64 条按时间排好，取 8 条——从早到晚都有，名次靠前的不是全在一头
  const rows = Array.from({ length: 64 }, (_, i) => ({ ref: `e${i}`, tStart: i }));
  const got = spreadOver(rows, 8).map((r) => Number(r.slice(1)));
  assert.equal(got.length, 8);
  assert.ok(Math.min(...got) < 8 && Math.max(...got) > 56, `盖住两头：${got}`);
  assert.ok(Math.abs(got[0] - 32) <= 8, `第一名在中间：${got}`);
  assert.deepEqual(spreadOver(rows.slice(0, 3), 8).length, 3);
});

test('对着问题截取（focusOn）：放不下时截和线索最对得上的那一段，两头带「…」；对不上就从头截；放得下原样', async () => {
  const w = await world();
  try {
    const { core } = w;
    const text = `${'前面是一大段不相干的闲聊，'.repeat(8)}然后老板发了午饭的图，我看到的：一碗拉面配卤蛋。${'后面又是闲聊，'.repeat(6)}`;
    const out = focusOn(core, text, 40, ['老板午饭吃了拉面']);
    assert.ok([...out].length <= 40, out);
    assert.match(out, /^…/u);
    assert.match(out, /拉面/u);
    assert.equal(focusOn(core, text, 40, ['完全对不上的词组合']), [...text].slice(0, 40).join(''));
    assert.equal(focusOn(core, '短的', 40, ['拉面']), '短的');
  } finally { await w.cleanup(); }
});

test('预取缓存重存时带上结构化的改写（D154 留下的）：她自己开口的轮重算以后，读懂问题照样拿得到它', async () => {
  const w = await world();
  try {
    const { core } = w;
    const p = seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '那个游戏还玩吗', addressed: 'to-her' });
    const rw = { cues: ['老板说的那个游戏'], about: ['老板'], time: null, where: null, shape: 'point', structured: true };
    core.state.retrieve.prefetch.set('D', { key: p, cueHash: 'x', full: true, set: { items: [] }, queryVectors: null, rewrites: rw.cues, rewrite: rw, at: core.now(), any: -1 });
    assert.deepEqual(core.mods.retrieve.cachedRewrite(core, 'D'), rw);
    await R(core, { settingKey: 'D', trigger: 'idle' }, { mode: 'involuntary' });   // 别处有新的事：重算、重存
    assert.notEqual(core.state.retrieve.prefetch.get('D').cueHash, 'x', '重算过');
    assert.deepEqual(core.mods.retrieve.cachedRewrite(core, 'D'), rw, '结构化的改写还在');
  } finally { await w.cleanup(); }
});
