// 一处预算（D165，用户反馈第 39 轮）：核心是唯一做预算的地方。宿主的字数上限默认跟着核心走——核心打包出来的每一条都在渲染出来的块里，
// 三档各测一次（构造一个把各层都装满的结果：用核心自己的 pack 按这一档的上限装）；主人手写了更小的上限时照他的截、按条计数。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeConfig, recallCaps } from 'rugu-core';
import { pack } from '../../../core/src/context/pack.js';
import { renderInjectBlock, renderRecallResult, renderLookResult, coreBudgetChars } from '../../src/host/render.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';

const len = (s) => Array.from(String(s)).length;
let seq = 0;
/** 一条渲染好的条目（来源说法 + 正文，正文按这一层每条的上限写满）。 */
const E = (layer, chars, o = {}) => {
  seq += 1;
  return { ref: `a${seq}`, layer, verdict: 'share', rendered: `（今晚 18:01 · 36 分钟前，某人在「某群」自己说的）${'字'.repeat(chars - 1)}。`, provenance: '某人说的',
    confidence: 0.8, appraisalRef: `ap${seq}`, group: `${layer}:${seq}`, order: seq, ...o };
};
/** 每一层都给比上限多得多的候选，让核心的 pack 按这一档装满。 */
function fullEntries(K) {
  const many = (layer, n, chars, o) => Array.from({ length: n }, () => E(layer, chars, o));
  return [
    E('gap', 200), E('intentions', 120),
    ...many('working', 60, K.working.lineChars),
    ...many('sinceHere', 12, K.sinceHere.itemChars),
    ...many('pointBack', 4, 60),
    ...many('lessons', 5, K.lessons.itemChars),
    ...many('people', 5, 150),
    ...many('recalled', 40, K.involuntary.itemChars),
    ...many('recentFromPresent', 40, 120),
    ...many('awarePrivate', 4, 30, { verdict: 'aware_private' }),
    ...many('todaySoFar', 10, 200),
    ...many('warmStart', 10, 300),
  ];
}
const cfgOf = (preset) => mergeConfig(DEFAULTS, { budget: { preset } }).config;
const free = { dayUsed: 0, dayLimit: Infinity, rollingLeft: Infinity };

for (const preset of ['saving', 'loose', 'unlimited']) {
  test(`自动（${preset}）：核心把各层都装满的结果，每一条都在宿主渲染出来的块里，宿主一条都不截`, () => {
    const cfg = cfgOf(preset);
    const K = recallCaps(cfg);
    const budgetChars = coreBudgetChars(cfg, HOST_DEFAULTS.inject, 'inject');
    assert.equal(budgetChars, K.blockMaxChars, '交给核心的整块字数 = 核心这一档的整块');
    const items = pack(fullEntries(K), { cfg, mode: 'involuntary', sent: new Set(), budgetChars, budget: free });
    assert.ok(items.filter((i) => i.layer === 'working').length >= 5 && new Set(items.map((i) => i.layer)).size >= 6, '各层都装了东西');
    const total = items.reduce((n, i) => n + len(i.rendered), 0);
    assert.ok(total > 2400, `装得满（${total} 字，比原来宿主的 1400 + 400 大）`);
    const r = renderInjectBlock({ items, degradeLevel: 0, traceId: 't' }, { inject: HOST_DEFAULTS.inject, coreConfig: cfg });
    assert.equal(r.used.length, items.length, '每一条都在');
    assert.equal(r.truncated, 0);
    for (const it of items) assert.ok(r.text.includes(it.rendered), `${it.layer} 那一条完整`);
    // 回忆的轮（自动触发那一档）：回忆的细节也全在
    const rc = pack([...fullEntries(K), ...Array.from({ length: 40 }, () => E('recollect', K.recollect.auto.itemChars))],
      { cfg, mode: 'deliberate', sent: new Set(), budgetChars, budget: free, recollectTier: K.recollect.auto });
    assert.ok(rc.some((i) => i.layer === 'recollect'));
    const rr = renderInjectBlock({ items: rc, degradeLevel: 0, traceId: 't', recollect: { note: '找的是：编出来的范围', log: {} } }, { inject: HOST_DEFAULTS.inject, coreConfig: cfg });
    assert.equal(rr.used.length, rc.length);
    assert.equal(rr.truncated, 0);
  });

  test(`记忆工具（${preset}）：自动时核心给的每一条都在结果里`, () => {
    const cfg = cfgOf(preset);
    const K = recallCaps(cfg);
    const items = pack([...fullEntries(K), ...Array.from({ length: 80 }, () => E('recollect', K.recollect.tool.itemChars))],
      { cfg, mode: 'deliberate', sent: new Set(), budgetChars: coreBudgetChars(cfg, HOST_DEFAULTS.tools, 'tool'), budget: free, recallFirst: true, recollectTier: K.recollect.tool });
    const r = renderRecallResult({ items, degradeLevel: 0, traceId: 't', recollect: { note: '找的是：编出来的范围', log: {} } }, { tools: HOST_DEFAULTS.tools, coreConfig: cfg });
    assert.equal(r.used.length, items.length);
    assert.equal(r.truncated, 0);
    // 翻看：工具那一档的总字数以内的都在
    const look = Array.from({ length: 30 }, () => ({ id: `l${(seq += 1)}`, layer: 'look', rendered: '原'.repeat(150), verdict: 'share', confidence: 1, provenance: '', appraisalRef: 'x' }))
      .slice(0, Math.floor(K.recollect.tool.totalChars / 150));
    const lr = renderLookResult({ items: look, look: { kind: 'when', note: '翻看：编出来的一段时间' } }, { tools: HOST_DEFAULTS.tools, coreConfig: cfg });
    assert.equal(lr.used.length, look.length);
    assert.equal(lr.truncated, 0);
  });
}

test('主人手写了更小的上限：照他写的截（整块、每条、工具结果），截掉的按条数报；交给核心的整块字数也照他写的', () => {
  const cfg = cfgOf('loose');
  const K = recallCaps(cfg);
  const items = pack(fullEntries(K), { cfg, mode: 'involuntary', sent: new Set(), budgetChars: K.blockMaxChars, budget: free });
  const inject = { ...HOST_DEFAULTS.inject, blockMaxChars: 1400, sinceHereChars: 400, budgetChars: 900, itemChars: 120 };
  assert.equal(coreBudgetChars(cfg, inject, 'inject'), 900);
  const r = renderInjectBlock({ items, degradeLevel: 0, traceId: 't' }, { inject, coreConfig: cfg });
  assert.ok(len(r.text) <= 1400 + 400);
  assert.ok(r.used.length < items.length);
  assert.ok(r.truncated >= items.length - r.used.length && r.truncated > 0);
  assert.ok(r.text.split('\n').filter((l) => l.startsWith('- ')).every((l) => len(l) <= 122), '每条照手写的截');
  const t = renderRecallResult({ items, degradeLevel: 0, traceId: 't' }, { tools: { recallBudgetChars: 900, recollectChars: 1600 }, coreConfig: cfg });
  assert.equal(coreBudgetChars(cfg, { recallBudgetChars: 900 }, 'tool'), 900);
  assert.ok(len(t.text) <= 1600 && t.truncated > 0);
});

test('宿主配置：字数的上限默认是 null（跟着核心走）；手写的数字照收，写错的忽略', async () => {
  const { mergeHost } = await import('../../src/host/config.js');
  for (const k of ['budgetChars', 'blockMaxChars', 'recollectChars', 'sinceHereChars', 'itemChars']) assert.equal(HOST_DEFAULTS.inject[k], null, k);
  for (const k of ['recallBudgetChars', 'recollectChars', 'itemChars']) assert.equal(HOST_DEFAULTS.tools[k], null, k);
  const w = [];
  const m = mergeHost(HOST_DEFAULTS, { inject: { blockMaxChars: 1400, budgetChars: 'x', itemChars: -1 } }, '', w);
  assert.deepEqual([m.inject.blockMaxChars, m.inject.budgetChars, m.inject.itemChars], [1400, null, null]);
  assert.equal(w.length, 2);
  assert.equal(mergeHost(HOST_DEFAULTS, { inject: { blockMaxChars: 1400 } }).inject.blockMaxChars, 1400);
  assert.equal(mergeHost(HOST_DEFAULTS, { inject: { blockMaxChars: null } }).inject.blockMaxChars, null);
});
