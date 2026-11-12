// 「这之后他的事」（D164）在增量块里的样子：单独一个小标题，紧跟在工作记忆后面；字数紧时排在工作记忆后面先拿到，不被想起来的挤掉。内容是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlock, renderInjectBlock, BLOCK_HEAD, SINCE_HERE_TITLE, WORKING_TITLES } from '../../src/host/render.js';

const len = (s) => Array.from(s).length;
const item = (id, layer, rendered, o = {}) => ({ id, layer, rendered, verdict: 'share', confidence: 0.8, provenance: '', appraisalRef: `ap${id.slice(1)}`, ...o });

test('这之后他的事：小标题 + 一件一行（计划的结果那一行带「结果：」）；排在工作记忆后面、想起来的前面；注入日志照样记它', () => {
  const items = [
    item('p1', 'working', '〔在「群B」当着大家 · 今晚 18:30〕他：夜宵吃什么好呢'),
    item('a1', 'sinceHere', '（今天下午 16:57，他在「群A」自己说的）他今晚六点抢演出票（后来做完了，今晚 18:01）'),
    item('a2', 'sinceHere', '结果：（今晚 18:01 · 36 分钟前，他在「群A」自己说的）他抢到了周六的票'),
    item('a3', 'recalled', '上周说过想换个新键盘'),
  ];
  const { text, used } = renderBlock(items);
  assert.equal(text, [
    BLOCK_HEAD,
    WORKING_TITLES.guided,
    '- 〔在「群B」当着大家 · 今晚 18:30〕他：夜宵吃什么好呢',
    SINCE_HERE_TITLE,
    '- （今天下午 16:57，他在「群A」自己说的）他今晚六点抢演出票（后来做完了，今晚 18:01）',
    '- 结果：（今晚 18:01 · 36 分钟前，他在「群A」自己说的）他抢到了周六的票',
    '想起来的：',
    '- 上周说过想换个新键盘',
  ].join('\n'));
  assert.deepEqual(used.map((i) => i.id), ['p1', 'a1', 'a2', 'a3']);
  assert.match(SINCE_HERE_TITLE, /上次在这里说完话以后/);
  assert.match(SINCE_HERE_TITLE, /已经有结果的就别再问了/);
  // 「只讲目的」的写法也用同一个小标题
  assert.ok(renderBlock(items, { style: 'purpose' }).text.includes(`${SINCE_HERE_TITLE}\n- （今天下午`));
});

test('整块的上限（inject.blockMaxChars）紧时：这一层排在工作记忆后面先拿到字数，挤掉的是想起来的，不是它', () => {
  const since = item('a1', 'sinceHere', '（今晚 18:01，他在「群A」自己说的）他抢到了周六的票');
  const items = [item('a3', 'recalled', '上周说过想换个新键盘，看中了一把带旋钮的'), since];
  const room = len(BLOCK_HEAD) + 1 + len(SINCE_HERE_TITLE) + 1 + len(`- ${since.rendered}`) + 5;
  assert.deepEqual(renderBlock(items, { maxChars: room }).used.map((i) => i.id), ['a1']);
  // 默认的整块上限（1400）：工作记忆写满 12 行、这一层 320 字，照样都放得下
  const wm = Array.from({ length: 12 }, (_, i) => item(`p${i + 1}`, 'working', `〔在「群B」〕他：${'夜宵'.repeat(30)}${i}`));
  const sh = Array.from({ length: 4 }, (_, i) => item(`a${i + 10}`, 'sinceHere', `（今晚，他在「群A」说的）${'事'.repeat(60)}${i}`));
  const r = renderInjectBlock({ items: [...wm, ...sh], degradeLevel: 0, traceId: 't' }, { inject: { blockMaxChars: 1400 } });
  assert.equal(r.used.filter((i) => i.layer === 'sinceHere').length, 4, r.text);
});

test('块里有这一层时整块的上限加大（inject.sinceHereChars）：工作记忆写得很满时，「想起来的」照样在；不加大时它被挤掉', () => {
  const wm = Array.from({ length: 7 }, (_, i) => item(`p${i + 1}`, 'working', `〔在「群B」〕他：${'夜宵'.repeat(52)}${i}`));
  const sh = Array.from({ length: 3 }, (_, i) => item(`a${i + 10}`, 'sinceHere', `（今晚，他在「群A」说的）${'事'.repeat(80)}${i}`));
  const rec = item('a99', 'recalled', `上周说过想换个新键盘，${'看中了一把带旋钮的'.repeat(9)}`);
  const layers = { items: [...wm, ...sh, rec], degradeLevel: 0, traceId: 't' };
  const on = renderInjectBlock(layers, { inject: { blockMaxChars: 1400 } });
  assert.ok(on.used.some((i) => i.id === 'a99'), on.text);
  assert.equal(on.used.filter((i) => i.layer === 'sinceHere').length, 3);
  assert.equal(on.used.filter((i) => i.layer === 'working').length, 7);
  const off = renderInjectBlock(layers, { inject: { blockMaxChars: 1400, sinceHereChars: 0 } });
  assert.ok(!off.used.some((i) => i.id === 'a99'), '不加大时被挤掉（说明上面那条确实靠加大）');
  // 没有这一层：上限不变
  const plain = renderInjectBlock({ items: [...wm, rec], degradeLevel: 0, traceId: 't' }, { inject: { blockMaxChars: 1400 } });
  assert.ok(len(plain.text) <= 1400);
});
