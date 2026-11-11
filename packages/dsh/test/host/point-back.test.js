// 指回去（D146）在增量块里的样子：单独一个小标题，紧跟在工作记忆后面、在想起来的前面；字数紧时排在她的经验后面先拿到。内容是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlock, BLOCK_HEAD, POINT_BACK_TITLE, WORKING_TITLES } from '../../src/host/render.js';

const len = (s) => Array.from(s).length;
const item = (id, layer, rendered, o = {}) => ({ id, layer, rendered, verdict: 'share', confidence: 0.8, provenance: '', appraisalRef: `ap${id.slice(1)}`, ...o });

test('指回去那一行：小标题 + 那一条渲染的开头；排在工作记忆后面、想起来的前面；注入日志照样记它（used 里有）', () => {
  const items = [
    item('w1', 'working', '（私聊，十分钟前）他说：周六记得早点到'),
    item('p7', 'pointBack', '（在一个群里，阿明说）周六下午三点在东门集合，记得带上折叠凳和那个蓝色的…'),
    item('a3', 'recalled', '上周说过想换个新键盘'),
  ];
  const { text, used } = renderBlock(items);
  assert.equal(text, [
    BLOCK_HEAD,
    WORKING_TITLES.guided,
    '- （私聊，十分钟前）他说：周六记得早点到',
    POINT_BACK_TITLE,
    '- （在一个群里，阿明说）周六下午三点在东门集合，记得带上折叠凳和那个蓝色的…',
    '想起来的：',
    '- 上周说过想换个新键盘',
  ].join('\n'));
  assert.deepEqual(used.map((i) => [i.id, i.layer]), [['w1', 'working'], ['p7', 'pointBack'], ['a3', 'recalled']]);
  // 「只讲目的」的写法也用同一个小标题
  assert.ok(renderBlock(items, { style: 'purpose' }).text.includes(`${POINT_BACK_TITLE}\n- （在一个群里`));
});

test('字数紧时指回去先于想起来的拿到位置（它在这一轮回想里排得比新给的靠前）', () => {
  const items = [
    item('a3', 'recalled', '上周说过想换个新键盘，看中了一把带旋钮的'),
    item('p7', 'pointBack', '（在一个群里，阿明说）周六下午三点在东门集合'),
  ];
  const room = len(BLOCK_HEAD) + 1 + len(POINT_BACK_TITLE) + 1 + len('- （在一个群里，阿明说）周六下午三点在东门集合') + 5;
  const { used } = renderBlock(items, { maxChars: room });
  assert.deepEqual(used.map((i) => i.id), ['p7']);
});
