// 回忆（D155）在集成层的渲染：被判成回忆的那一轮整块上限加大、回忆那一节开头是「找了哪儿」那一行；浮现的轮照旧；
// 记忆工具的结果同理。线上（context.js、tools.js）和回放评测走的是同一个函数。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInjectBlock, renderRecallResult, renderBlock, RECOLLECT_TITLE } from '../../src/host/render.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';

const item = (i, layer, chars = 200) => ({ id: `e${i}`, layer, rendered: `第${i}条${'某'.repeat(chars)}`, verdict: 'share', confidence: 1, provenance: '', appraisalRef: `ap${i}` });

test('浮现的轮：和原来的 renderBlock 一模一样（上限 blockMaxChars，没有「找了哪儿」）', () => {
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1, 'recalled', 100));
  const layers = { items, degradeLevel: 1, traceId: 't' };
  const a = renderInjectBlock(layers, { inject: HOST_DEFAULTS.inject });
  const b = renderBlock(items, { maxChars: HOST_DEFAULTS.inject.blockMaxChars });
  assert.equal(a.text, b.text);
  assert.equal(a.recollect, null);
});

test('回忆的轮：整块上限加 recollectChars，回忆那一节第一行是「找了哪儿」，摘要交回注入记录', () => {
  const items = Array.from({ length: 14 }, (_, i) => item(i + 1, 'recollect', 200));
  const log = { kind: 'auto', given: 14 };
  const layers = { items, degradeLevel: 1, traceId: 't', recollect: { note: '找的是：今天（11/11） · 所有场合；范围里 80 条记忆，下面给了 14 条', log } };
  const r = renderInjectBlock(layers, { inject: HOST_DEFAULTS.inject });
  const lines = r.text.split('\n');
  const at = lines.indexOf(RECOLLECT_TITLE);
  assert.ok(at > 0, r.text.slice(0, 200));
  assert.match(lines[at + 1], /^找的是：/u);
  assert.ok(r.used.length > 6, `放得下的比浮现多：${r.used.length}`);
  assert.ok([...r.text].length > HOST_DEFAULTS.inject.blockMaxChars);
  assert.ok([...r.text].length <= HOST_DEFAULTS.inject.blockMaxChars + HOST_DEFAULTS.inject.recollectChars);
  assert.deepEqual(r.recollect, log);
  // 每条 ≤ 320（核心已经按这一档截过）
  assert.ok(r.text.split('\n').filter((l) => l.startsWith('- ')).every((l) => [...l].length <= 322));
});

test('记忆工具：结果里有回忆那一层时上限放开、开头带「找了哪儿」；没有时照旧 1600', () => {
  const rc = Array.from({ length: 20 }, (_, i) => item(i + 1, 'recollect', 280));
  const r = renderRecallResult({ items: rc, recollect: { note: '没有限定时间和人，是按话题在全部记忆里找的', log: { kind: 'tool' } } }, { tools: HOST_DEFAULTS.tools });
  const lines = r.text.split('\n');
  assert.equal(lines[1], '没有限定时间和人，是按话题在全部记忆里找的');
  assert.ok([...r.text].length > 1600 && [...r.text].length <= HOST_DEFAULTS.tools.recollectChars + 200);
  assert.ok(lines.slice(2).some((l) => [...l].length > 200), '回忆的条目每条上限放宽');
  const old = renderRecallResult({ items: Array.from({ length: 20 }, (_, i) => item(i + 1, 'recalled', 150)) }, { tools: HOST_DEFAULTS.tools });
  assert.ok([...old.text].length <= 1700);
  assert.equal(old.recollect, null);
});
