// 工作记忆的预算（D108）：working 只占它自己的 budgetChars，不占整块的 blockMaxChars（原来意图先占了一块，最新的几行工作记忆被挤掉）；
// 同一层里最新的一组先分预算（alloc），展示顺序不变（最新的一组在最后）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, budgetLimits } from '../../src/config/defaults.js';
import { pack } from '../../src/context/pack.js';

const cfg = DEFAULTS;
const free = { dayUsed: 0, dayLimit: budgetLimits(cfg).injectPerSessionPerDay, rollingLeft: Infinity };
const W = (ref, gi, i, n, chars) => ({
  ref, layer: 'working', verdict: 'share', rendered: '字'.repeat(chars), provenance: '', confidence: 1, appraisalRef: `ap-${ref}`,
  group: `wm:${gi}`, order: gi * 1000 + i * 10, alloc: (n - 1 - gi) * 1000 + i * 10, prio: i, speak: 'careful',
});

test('working 不占整块的上限：意图和别的层把 900 字用满了，工作记忆照样全在', () => {
  const entries = [
    { ref: 'i1', layer: 'intentions', verdict: 'share', rendered: '字'.repeat(400), provenance: '', confidence: 1, appraisalRef: 'ap-i1', group: 'it:1', order: 1 },
    { ref: 'r1', layer: 'recalled', verdict: 'share', rendered: '字'.repeat(300), provenance: '', confidence: 1, appraisalRef: 'ap-r1', group: 'r:1', order: 2 },
    { ref: 'r2', layer: 'recalled', verdict: 'share', rendered: '字'.repeat(190), provenance: '', confidence: 1, appraisalRef: 'ap-r2', group: 'r:2', order: 3 },
    W('w1', 0, 0, 2, 150), W('w2', 0, 1, 2, 150), W('w3', 1, 0, 2, 150), W('w4', 1, 1, 2, 150),
  ];
  const items = pack(entries, { cfg, mode: 'involuntary', sent: new Set(), budgetChars: 900, budget: free });
  const ids = items.map((i) => i.id);
  for (const w of ['w1', 'w2', 'w3', 'w4']) assert.ok(ids.includes(w), `${w}：${ids}`);
  assert.ok(ids.includes('i1'));
});

test('工作记忆自己的预算紧时，最新的一组先拿到；展示顺序还是旧的在前', () => {
  const small = { ...cfg, recall: { ...cfg.recall, working: { ...cfg.recall.working, budgetChars: 320 } } };
  const entries = [W('old1', 0, 0, 2, 150), W('old2', 0, 1, 2, 150), W('new1', 1, 0, 2, 150), W('new2', 1, 1, 2, 150)];
  const items = pack(entries, { cfg: small, mode: 'involuntary', sent: new Set(), budgetChars: 900, budget: free });
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('new1') && ids.includes('new2'), `最新的一组先分：${ids}`);
  assert.ok(!ids.includes('old2'), ids.join());
});
