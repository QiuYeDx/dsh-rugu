// 按预算打包（§10.4）：去掉本周期已发过的、按组分配、各层上限、单块 ≤ 900 字、每天和滚动窗口的额度、超了只留「你想着的」、工作记忆和有意回想。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, budgetLimits } from '../../src/config/defaults.js';
import { validateRecallLayers } from '../../src/contract/index.js';
import { pack, DISPLAY_ORDER, UNMETERED_LAYERS } from '../../src/context/pack.js';
import { recallCaps } from '../../src/config/caps.js';

const cfg = DEFAULTS;
const free = { dayUsed: 0, dayLimit: budgetLimits(cfg).injectPerSessionPerDay, rollingLeft: Infinity };
let seq = 0;
/** 一条渲染好的条目。 */
const E = (ref, layer, { verdict = 'share', chars = 20, group = `${layer}:${ref}`, order = (seq += 1) } = {}) => ({
  ref, layer, verdict, rendered: '字'.repeat(chars), provenance: '', confidence: 0.8, appraisalRef: `ap${seq}`, group, order,
});
const run = (entries, o = {}) => pack(entries, { cfg, mode: o.mode ?? 'involuntary', sent: o.sent ?? new Set(), budgetChars: o.budgetChars ?? 900, budget: o.budget ?? free });
const total = (items) => items.reduce((n, i) => n + Array.from(i.rendered).length, 0);

test('本周期已发过的不再发：带内容的按 id；只给过暗示的之后能说了照样可以发内容；时间间隔不按条目去重', () => {
  const entries = [E('a1', 'recalled'), E('a2', 'recalled'), E('a3', 'awarePrivate', { verdict: 'aware_private' }), E('a4', 'recalled'), E('e5', 'gap')];
  const items = run(entries, { sent: new Set(['a1', 'a3~aware', 'a4~aware', 'e5']) });
  assert.deepEqual(items.map((i) => i.id), ['e5', 'a2', 'a4']);
});

test('MMR 合并进来的几乎一样的文字（duplicates）本周期发过了，这一条也算发过：上一轮代表是另一段，这一轮不再当新鲜事给一遍', () => {
  const dup = (ref, dups, o) => ({ ...E(ref, 'recalled', o), duplicates: dups });
  const items = run([dup('e2', ['e1']), dup('e4', ['e3']), E('a5', 'recalled'), dup('a6', ['a7'], { verdict: 'aware_private' })],
    { sent: new Set(['e1', 'a7~aware']) });
  assert.deepEqual(items.map((i) => i.id), ['e4', 'a5'], '代表 e2 的副本 e1 发过了；只给过暗示的副本 a7 让这条暗示也算发过');
  assert.ok(items.every((i) => !('duplicates' in i)), '输出的条目形状不变（契约里没有 duplicates）');
  // 只给过暗示的副本不挡带内容的这一条（和按 id 去重一样：暗示过之后能说了照样可以说）
  assert.deepEqual(run([dup('e8', ['e9'])], { sent: new Set(['e9~aware']) }).map((i) => i.id), ['e8']);
});

test('组：组长放不下整组都不放；组员放不下只丢组员；组长发过了整组不再发', () => {
  const card = [E('n1', 'people', { group: 'p:1', chars: 60 }), E('i1', 'people', { group: 'p:1', chars: 100 })];
  let items = run(card);
  assert.deepEqual(items.map((i) => i.id), ['n1', 'i1']);
  // 每张人物卡 ≤ peopleCardChars（D165：240）字：第二张卡的印象放不下，只丢印象
  const cards = [...card, E('n2', 'people', { group: 'p:2', chars: 150 }), E('i2', 'people', { group: 'p:2', chars: 150 })];
  items = run(cards);
  assert.deepEqual(items.map((i) => i.id), ['n1', 'i1', 'n2']);
  // 组长放不下（整块只剩 100 字）：整组不放
  items = run([E('n3', 'people', { group: 'p:3', chars: 200 }), E('i3', 'people', { group: 'p:3', chars: 10 })], { budgetChars: 100 });
  assert.deepEqual(items, []);
  // 卡头发过了：印象也不单独出现
  items = run(card, { sent: new Set(['n1']) });
  assert.deepEqual(items, []);
});

test('各层上限（D165 平衡档）：想起来的 ≤ 8 条且 ≤ 1600 字（有意回想 ≤ 12 条）；心里有数 ≤ 2 行；你想着的 ≤ 1 条', () => {
  const rec = Array.from({ length: 20 }, (_, i) => E(`a${i + 1}`, 'recalled', { chars: 50 }));
  assert.equal(run(rec, { budgetChars: 2000 }).filter((i) => i.layer === 'recalled').length, 8);
  assert.equal(run(rec, { mode: 'deliberate', budgetChars: 2000 }).filter((i) => i.layer === 'recalled').length, 12);
  // 「还在想」的暂定提示另算一行，不占想起来的名额（§9.3.5）
  const withPending = [...rec, E('a50', 'recalled', { verdict: 'pending', chars: 30 }), E('a51', 'recalled', { verdict: 'pending', chars: 30 })];
  const d = run(withPending, { mode: 'deliberate', budgetChars: 2000 });
  assert.equal(d.filter((i) => i.verdict === 'share').length, 12);
  assert.equal(d.filter((i) => i.verdict === 'pending').length, 1);
  const long = Array.from({ length: 10 }, (_, i) => E(`e${i + 1}`, 'recalled', { chars: 300 }));
  assert.ok(total(run(long, { budgetChars: 2000 })) <= recallCaps(cfg).involuntary.maxChars);
  const aware = Array.from({ length: 4 }, (_, i) => E(`a${i + 20}`, 'awarePrivate', { verdict: 'aware_private' }));
  assert.equal(run(aware).length, cfg.context.layers.awareLines);
  const its = [E('t1', 'intentions'), E('t2', 'intentions')];
  assert.equal(run(its).length, 1);
});

test('单块 ≤ 900 字、≤ 调用方的 budgetChars；预算紧时你想着的、时间间隔先拿到', () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => E(`a${i + 1}`, 'recalled', { chars: 110 })),
    E('w1', 'warmStart', { chars: 400 }), E('n1', 'people', { chars: 170, group: 'p:1' }), E('e1', 'gap', { chars: 80 }),
    E('t1', 'intentions', { chars: 100 }),
  ];
  const items = run(entries);
  assert.ok(total(items) <= cfg.context.blockMaxChars);
  assert.ok(items.some((i) => i.id === 't1') && items.some((i) => i.id === 'e1'));
  const small = run(entries, { budgetChars: 200 });
  assert.ok(total(small) <= 200);
  assert.deepEqual(small.map((i) => i.id), ['e1', 't1']);
});

test('每天、滚动窗口的额度用完：只留「你想着的」（有意回想时再加想起来的），它们只受单块上限；差一点没用完时它们也照样放得下', () => {
  const entries = [E('a1', 'recalled', { chars: 100 }), E('n1', 'people', { group: 'p:1', chars: 50 }), E('t1', 'intentions', { chars: 120 })];
  const over = { dayUsed: 8000, dayLimit: 8000, rollingLeft: Infinity };
  assert.deepEqual(run(entries, { budget: over }).map((i) => i.id), ['t1']);
  assert.deepEqual(run(entries, { budget: over, mode: 'deliberate' }).map((i) => i.id), ['a1', 't1']);
  assert.deepEqual(run(entries, { budget: { ...free, rollingLeft: -5 } }).map((i) => i.id), ['t1']);
  // 只剩 60 字：人物卡（50）放得下，想起来的（100）放不下，你想着的（120）不受这 60 字的限制
  const tight = { dayUsed: 7940, dayLimit: 8000, rollingLeft: Infinity };
  assert.deepEqual(run(entries, { budget: tight }).map((i) => i.id), ['n1', 't1']);
});

test('同一条记忆在两层出现时只给一次（时间间隔和暖启动都指向上一段经历）；输出按展示顺序，形状过契约校验', () => {
  const entries = [E('t1', 'intentions'), E('a1', 'recalled'), E('e1', 'warmStart'), E('e1', 'gap'), E('n1', 'people', { group: 'p:1' }),
    E('a2', 'recentFromPresent'), E('e9', 'todaySoFar'), E('a3', 'awarePrivate', { verdict: 'aware_private' }), E('a4', 'recalled', { verdict: 'pending' })];
  const items = run(entries, { mode: 'deliberate' });
  assert.equal(items.filter((i) => i.id === 'e1').length, 1);
  assert.equal(items.find((i) => i.id === 'e1').layer, 'gap');
  const pos = items.map((i) => DISPLAY_ORDER.indexOf(i.layer));
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b));
  const v = validateRecallLayers({ items, degradeLevel: 0, traceId: 't' });
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.ok(items.every((i) => i.appraisalRef.startsWith('ap')));
});

test('想起来的和在场者近况在同一档里按回想的先后分（实测问题 #5）：人物卡 + 五条想起来的不再把近况挤光，各自的上限照旧', () => {
  // 回想的先后（order）：近况 r1 最活跃，其次是几条想起来的，近况 r2 最后
  const entries = [
    E('n1', 'people', { group: 'p:1', chars: 170, order: 1 }),
    E('p1', 'recentFromPresent', { chars: 200, order: 10 }),
    ...Array.from({ length: 5 }, (_, i) => E(`a${i + 1}`, 'recalled', { chars: 110, order: 20 + i })),
    E('p2', 'recentFromPresent', { chars: 130, order: 90 }),
  ];
  const items = run(entries);
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('p1'), `最活跃的那条近况先拿到名额：${ids}`);
  assert.ok(total(items) <= cfg.context.blockMaxChars);
  assert.ok(!ids.includes('p2'), '排在后面的照样可能放不下');
  // 有意回想：同一档排在人物卡前面
  const d = run(entries, { mode: 'deliberate' });
  assert.ok(d.some((i) => i.id === 'p1'));
  // 各层自己的条数上限不变：近况再多也只到 recall.present.maxItems 条
  const many = Array.from({ length: 30 }, (_, i) => E(`q${i}`, 'recentFromPresent', { chars: 10, order: 100 + i }));
  assert.equal(run(many).length, cfg.recall.present.maxItems);
});

test('额度用完时有意回想的整档（想起来的 + 在场者近况）都照样给：分到近况那层的回想结果不会被预算吃掉', () => {
  const entries = [E('p1', 'recentFromPresent', { chars: 120, order: 1 }), E('a1', 'recalled', { chars: 100, order: 2 }),
    E('n1', 'people', { group: 'p:1', chars: 50 })];
  for (const budget of [{ ...free, rollingLeft: 0 }, { dayUsed: 8000, dayLimit: 8000, rollingLeft: Infinity }]) {
    assert.deepEqual(run(entries, { budget, mode: 'deliberate', budgetChars: 1200 }).map((i) => i.id).sort(), ['a1', 'p1']);
    assert.deepEqual(run(entries, { budget }).map((i) => i.id), [], '不自主回想超了照旧什么都不给');
  }
});

test('D133：pack 的 report——超没超（每天 / 滚动窗口）、多少条没发过的受限条目因为预算没放进去；返回值不变', () => {
  const entries = [E('a1', 'recalled', { chars: 100 }), E('a2', 'recalled', { chars: 100 }), E('n1', 'people', { group: 'p:1', chars: 50 }),
    E('t1', 'intentions', { chars: 120 }), E('w1', 'working', { chars: 60 })];
  const go = (budget, o = {}) => {
    const report = {};
    const items = pack(entries, { cfg, mode: o.mode ?? 'involuntary', sent: o.sent ?? new Set(), budgetChars: 900, budget, report });
    return { ids: items.map((i) => i.id), report };
  };
  // 没超、额度够：什么都没丢
  let r = go(free);
  assert.deepEqual(r.report, { over: null, budgetDropped: 0, dropped: {}, capDropped: {}, clipped: {}, overMax: {} });
  assert.equal(r.ids.length, 5);
  // 每天的额度用完：除了「你想着的」和工作记忆整层丢掉；本周期已经发过的那条不算「没放进去」
  r = go({ dayUsed: 10, dayLimit: 10, rollingLeft: -1 }, { sent: new Set(['a2']) });
  assert.deepEqual(r.ids.sort(), ['t1', 'w1']);
  assert.deepEqual([r.report.over, r.report.budgetDropped], ['day', 2], '两样都超时记 day；a1、n1 两条');
  assert.deepEqual(r.report.dropped, { recalled: 1, people: 1 }, 'D165：按层');
  // 滚动窗口用完
  r = go({ ...free, rollingLeft: 0 });
  assert.deepEqual([r.report.over, r.report.budgetDropped], ['rolling', 3]);
  // 有意回想：想起来的那一档也不受限，丢的只有人物卡
  r = go({ ...free, rollingLeft: 0 }, { mode: 'deliberate' });
  assert.deepEqual([r.report.over, r.report.budgetDropped], ['rolling', 1]);
  // 没超但只剩 120 字：放得下一条想起来的（100），另一条和人物卡（50）放不下
  r = go({ ...free, rollingLeft: 120 });
  assert.equal(r.report.over, null);
  assert.equal(r.report.budgetDropped, 2);
  assert.ok(r.ids.includes('t1') && r.ids.includes('w1'));
  // 不传 report 照常
  assert.deepEqual(run(entries).map((i) => i.id).length, 5);
});

test('D133：pack 的 exempt 和预算记账用同一份不受限的层（「你想着的」、工作记忆；D156 起还有回忆的细节、经过、翻看；D164 这之后他的事）', () => {
  assert.deepEqual([...UNMETERED_LAYERS].sort(), ['intentions', 'look', 'outline', 'recollect', 'sinceHere', 'working']);
  // 额度为 0 时这两层照给
  const items = run([E('t1', 'intentions', { chars: 50 }), E('w1', 'working', { chars: 50 }), E('a1', 'recalled', { chars: 10 })],
    { budget: { dayUsed: 0, dayLimit: 0, rollingLeft: Infinity } });
  assert.deepEqual(items.map((i) => i.id).sort(), ['t1', 'w1']);
});

test('D164：这之后他的事有自己的预算——不占整块的上限，不挤想起来的，也不被它挤；条数、字数按 context.sinceHere；额度用完照给', () => {
  const C = cfg.context.sinceHere;
  // 想起来的五条把整块（900）用到快满：这一层照样放得下，想起来的一条不少
  const rec = Array.from({ length: 5 }, (_, i) => E(`a${i + 1}`, 'recalled', { chars: 110, order: 10 + i }));
  const since = Array.from({ length: 6 }, (_, i) => E(`a${i + 50}`, 'sinceHere', { chars: 70, order: i }));
  const items = run([...rec, E('n1', 'people', { group: 'p:1', chars: 170 }), ...since]);
  const got = (l) => items.filter((i) => i.layer === l).map((i) => i.id);
  assert.equal(got('recalled').length, 5, '想起来的一条没被挤掉');
  assert.equal(got('sinceHere').length, Math.min(C.maxItems, Math.floor(C.chars / 70)), `这一层按自己的条数和字数：${got('sinceHere')}`);
  assert.deepEqual(got('sinceHere'), since.slice(0, got('sinceHere').length).map((e) => e.ref), '按挑好的先后');
  const own = items.filter((i) => i.layer !== 'sinceHere');
  assert.ok(total(own) <= cfg.context.blockMaxChars, '其余各层照旧 ≤ 整块的上限');
  // 反过来：这一层满了也不占想起来的名额（不带这一层时想起来的给出的完全一样）
  assert.deepEqual(run([...rec, E('n1', 'people', { group: 'p:1', chars: 170 })]).filter((i) => i.layer === 'recalled').map((i) => i.id), got('recalled'));
  // 计划和它的结果一组，只占一个名额：四组（第一组两条）都放得下
  const grouped = [E('a70', 'sinceHere', { group: 'h:a70', chars: 40, order: 0 }), E('a71', 'sinceHere', { group: 'h:a70', chars: 40, order: 1 }),
    ...[2, 3, 4].map((k) => E(`a7${k}`, 'sinceHere', { chars: 40, order: k * 10 }))];
  assert.deepEqual(run(grouped).map((i) => i.id), ['a70', 'a71', 'a72', 'a73', 'a74']);
  // 每天和滚动窗口的额度用完：这一层和工作记忆一样照给
  const over = run([...since.slice(0, 2), E('a1', 'recalled', { chars: 10 })], { budget: { dayUsed: 0, dayLimit: 0, rollingLeft: Infinity } });
  assert.deepEqual(over.map((i) => i.id), ['a50', 'a51']);
  // 展示紧跟在工作记忆后面
  const shown = run([E('a1', 'recalled'), E('a60', 'sinceHere'), E('w1', 'working')]).map((i) => i.layer);
  assert.deepEqual(shown, ['working', 'sinceHere', 'recalled']);
  const v = validateRecallLayers({ items, degradeLevel: 0, traceId: 't' });
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test('D164：resend 里的计划在「这之后他的事」这一层不算给过（状态变了再给一次）；别的层、别的条目照旧按已发过去掉', () => {
  const entries = [E('a80', 'sinceHere'), E('a81', 'sinceHere'), E('a80', 'recalled')];
  const sent = new Set(['a80', 'a81']);
  assert.deepEqual(run(entries, { sent }).map((i) => i.id), []);
  const items = pack(entries, { cfg, mode: 'involuntary', sent, budgetChars: 900, budget: free, resend: new Set(['a80']) });
  assert.deepEqual(items.map((i) => [i.id, i.layer]), [['a80', 'sinceHere']]);
});
