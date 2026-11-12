// 回忆（D155）在集成层的渲染：被判成回忆的那一轮整块上限加大、回忆那一节开头是「找了哪儿」那一行；浮现的轮照旧；
// 记忆工具的结果同理。线上（context.js、tools.js）和回放评测走的是同一个函数。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInjectBlock, renderRecallResult, renderBlock, RECOLLECT_TITLE } from '../../src/host/render.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';

const item = (i, layer, chars = 200) => ({ id: `e${i}`, layer, rendered: `第${i}条${'某'.repeat(chars)}`, verdict: 'share', confidence: 1, provenance: '', appraisalRef: `ap${i}` });

test('浮现的轮（D165：上限跟着核心走）：主人没手写数字时，块的上限 = 核心的整块 + 工作记忆 + 宿主自己加的字；没有「找了哪儿」', () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1, 'recalled', 100));
  const layers = { items, degradeLevel: 1, traceId: 't' };
  const a = renderInjectBlock(layers, { inject: HOST_DEFAULTS.inject });
  const b = renderBlock(items);
  assert.equal(a.text, b.text, '核心给的都装得下（宿主不另截）');
  assert.equal(a.truncated, 0);
  assert.equal(a.recollect, null);
  // 主人手写了整块的上限：照他写的截，截掉的按条数报
  const m = renderInjectBlock(layers, { inject: { ...HOST_DEFAULTS.inject, blockMaxChars: 600 } });
  assert.ok([...m.text].length <= 600);
  assert.equal(m.truncated, 10 - m.used.length);
  assert.ok(m.truncated > 0);
});

test('回忆的轮：整块上限再加回忆那一档（自动 = 核心回忆自动触发那一档的总字数），回忆那一节第一行是「找了哪儿」，摘要交回注入记录', () => {
  const items = Array.from({ length: 14 }, (_, i) => item(i + 1, 'recollect', 200));
  const log = { kind: 'auto', given: 14 };
  const layers = { items, degradeLevel: 1, traceId: 't', recollect: { note: '找的是：今天（11/11） · 所有场合；范围里 80 条记忆，下面给了 14 条', log } };
  const r = renderInjectBlock(layers, { inject: HOST_DEFAULTS.inject });
  const lines = r.text.split('\n');
  const at = lines.indexOf(RECOLLECT_TITLE);
  assert.ok(at > 0, r.text.slice(0, 200));
  assert.match(lines[at + 1], /^找的是：/u);
  assert.equal(r.used.length, 14, '自动：全装得下');
  assert.equal(r.truncated, 0);
  assert.deepEqual(r.recollect, log);
  // 主人手写了：整块 1400 + 回忆 2400，照写的截
  const many = { ...layers, items: Array.from({ length: 24 }, (_, i) => item(i + 1, 'recollect', 200)) };
  const m = renderInjectBlock(many, { inject: { blockMaxChars: 1400, recollectChars: 2400 } });
  assert.ok([...m.text].length <= 1400 + 2400);
  assert.ok(m.used.length < 24 && m.truncated === 24 - m.used.length, `${m.used.length} / ${m.truncated}`);
  // 手写了每条的上限：照它截，截短的也算宿主截掉的
  const c = renderInjectBlock(layers, { inject: { itemChars: 100 } });
  assert.ok(c.text.split('\n').filter((l) => l.startsWith('- ')).every((l) => [...l].length <= 102));
  assert.equal(c.truncated, 14);
});

test('记忆工具：结果里有回忆那一层时开头带「找了哪儿」；自动时核心给的都装得下，手写了 tools.recollectChars 时照写的（没有回忆那一层时照旧 1600）', () => {
  const rc = Array.from({ length: 20 }, (_, i) => item(i + 1, 'recollect', 280));
  const r = renderRecallResult({ items: rc, recollect: { note: '没有限定时间和人，是按话题在全部记忆里找的', log: { kind: 'tool' } } }, { tools: HOST_DEFAULTS.tools });
  const lines = r.text.split('\n');
  assert.equal(lines[1], '没有限定时间和人，是按话题在全部记忆里找的');
  assert.equal(r.used.length, 20);
  assert.equal(r.truncated, 0);
  assert.ok(lines.slice(2).some((l) => [...l].length > 280), '每条不另截');
  const m = renderRecallResult({ items: rc, recollect: { note: 'x', log: { kind: 'tool' } } }, { tools: { recollectChars: 2000 } });
  assert.ok([...m.text].length <= 2000 && m.truncated === 20 - m.used.length && m.truncated > 0);
  const old = renderRecallResult({ items: Array.from({ length: 20 }, (_, i) => item(i + 1, 'recalled', 150)) }, { tools: { recollectChars: 4600 } });
  assert.ok([...old.text].length <= 1700);
  assert.equal(old.recollect, null);
});
