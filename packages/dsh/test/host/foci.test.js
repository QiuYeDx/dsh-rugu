// 一批里几个人都在对她说话（D108）：pickFoci 主触发者在前，其余是她上一次开口之后对她说话的别的人；renderBlock 先按优先级分字数
// （你想着的 > 工作记忆 > 时间间隔，工作记忆里最新的先拿），再按展示顺序排——字数紧时被截掉的不是最新的那几行工作记忆。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFoci, pickFocus } from '../../src/host/util.js';
import { renderBlock } from '../../src/host/render.js';

const A = { claims: [{ kind: 'account', id: 'a' }] };
const B = { claims: [{ kind: 'account', id: 'b' }] };

test('pickFoci：主触发者在前；她开口之前的不算；同一个人只算一次；最多 max 个', () => {
  const obs = [
    { id: 'o1', at: 1, addressed: 'to-her', actor: B },
    { id: 'me', at: 2, addressed: 'by-her', actor: { self: true } },
    { id: 'o2', at: 3, addressed: 'mentions-her', actor: A },
    { id: 'o3', at: 4, addressed: 'ambient', actor: B },
    { id: 'o4', at: 5, addressed: 'mentions-her', actor: B },
    { id: 'o5', at: 6, addressed: 'mentions-her', actor: A },
  ];
  assert.equal(pickFocus(obs, null)?.id, 'o5');
  assert.deepEqual(pickFoci(obs, null).map((o) => o.id), ['o5', 'o4']);
  assert.deepEqual(pickFoci(obs, null, { max: 1 }).map((o) => o.id), ['o5']);
  assert.deepEqual(pickFoci([], null), []);
});

test('renderBlock：字数紧时先保工作记忆（最新的先拿），展示顺序不变', () => {
  const W = (id, t) => ({ id, layer: 'working', rendered: t, verdict: 'share', speak: 'careful' });
  const items = [
    W('w1', `在「群X」（3 分钟前）：主人：${'旧'.repeat(60)}`), W('w2', `主人：${'中'.repeat(60)}`), W('w3', '主人：7 最新的一句'),
    { id: 'p1', layer: 'people', rendered: '人'.repeat(170), verdict: 'share' },
    { id: 'r1', layer: 'recalled', rendered: '想'.repeat(110), verdict: 'share' },
  ];
  const { text, used } = renderBlock(items, { maxChars: 260 });
  const ids = used.map((x) => x.id);
  assert.ok(ids.includes('w3'), `最新的一句在：${ids}`);
  assert.ok(!ids.includes('p1'), '人物卡让位');
  assert.ok(text.indexOf('旧') < 0 || text.indexOf('旧') < text.indexOf('最新的一句'), '展示顺序：旧的在前');
  const full = renderBlock(items, { maxChars: 1400 });
  assert.deepEqual(full.used.map((x) => x.id), ['w1', 'w2', 'w3', 'p1', 'r1'], '放得下时按展示顺序');
});

test('renderBlock：工作记忆按组取舍——组长（带着场合和「私下」的说明）放不下，整组不要，不留下没有来源说明的组员', () => {
  const W = (id, g, t) => ({ id, layer: 'working', rendered: t, verdict: 'share', speak: 'not-here', group: g });
  const items = [
    W('a1', 'wm:0', `你们俩私聊时（5 分钟前）：主人：${'规'.repeat(70)}（他私下跟你说的，这里的人没听到；他叮嘱过别外传：「别告诉他们」）`),
    W('a2', 'wm:0', '你：好（你私下回主人的，这里的人没听到）'),
    W('b1', 'wm:1', '在「群X」（1 分钟前）：主人：@她 6'),
    W('b2', 'wm:1', '你：18'),
  ];
  // 字数够放下块头、小标题和最新的一组（D110 的小标题长了一些：150 → 250），放不下旧的一组的组长
  const { used } = renderBlock(items, { maxChars: 250 });
  const ids = used.map((x) => x.id);
  assert.deepEqual(ids, ['b1', 'b2'], `最新的一组整组在；旧的一组组长放不下 → 组员也不要：${ids}`);
  const full = renderBlock(items, { maxChars: 1400 });
  assert.deepEqual(full.used.map((x) => x.id), ['a1', 'a2', 'b1', 'b2']);
  assert.match(full.text, /他叮嘱过别外传：「别告诉他们」/, '来源说明不被每条的上限截掉');
});
