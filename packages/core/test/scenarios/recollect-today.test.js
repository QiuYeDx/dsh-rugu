// 回忆（D155）的集成场景：「我今天吃了哪些东西」这一形状。十二个真模块一起跑，假平台，数据全是编的。
//   一个人一天里早、中、晚各说过吃了什么，散在两个群里（问的是私聊：都不在眼前这段对话里）；午饭那一顿只有「她看到的图」那一句（D116 写进原文窗口的「我看到的：……」）；
//   同一天她自己有几十句关于吃的闲聊、旁边的人几百句闲聊，切成一百多段（原文窗口 + 情节）。晚上他问「我今天吃了哪些东西」。
//   新路（recall.recollect.enabled 开着）：三顿都在回忆那一层里，按时间从早到晚排，结果带「找了哪儿」那一行；
//   关掉开关（原来的有意回想）：至少缺一顿——证明测的是这个机制，不是碰巧。
// 失败时看输出里的 seed，用 FAKE_PLATFORM_SEED=<seed> 复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, MINUTE, HOUR, DAY } from './recall-world.js';

const TZ = 480;
const localMidnight = (t) => Math.floor((t + TZ * MINUTE) / DAY) * DAY - TZ * MINUTE;

// 她自己关于吃的闲聊（和三顿饭用的词错开：不出现小笼包、牛肉面、咖喱）
const SELF_FOOD = ['今天中午吃什么好呢', '好饿啊想吃点东西', '下午茶喝什么', '晚饭吃什么还没想好', '想吃火锅了', '冰箱里还有半个西瓜',
  '外卖要等好久', '今天想吃点清淡的', '零食吃完了', '奶茶要不要少糖', '食堂今天人好多', '我那份白饭还没着落'];

/**
 * 编一天：08:00 他在小群说早饭，12:10 在小群发一张午饭的图（她看过，只有「我看到的」那一句），18:40 大群说晚饭；
 * 中间夹着她自己关于吃的话、旁人的闲聊，每隔一阵安静下来切一段。21:00 他在私聊里问。
 */
async function foodDay(t, name, config, seed) {
  const w = await makeWorld(name, { config, ...(seed != null ? { seed } : {}) });
  t.diagnostic(`fake-platform seed=${w.fp.seed}`);
  const day = localMidnight(w.clock.now()) + DAY;
  const at = (h, m = 0) => day + h * HOUR + m * MINUTE;
  // 切段、跑提炼会把时钟往后拨一点：排在前面的那一段拖过了点就从现在接着（顺序不变）
  const goto = (x) => w.clock.set(Math.max(x, w.clock.now()));
  const filler = async (where, n) => { w.chatter(where, n); };
  const selfFood = (where, n, k0) => {
    for (let i = 0; i < n; i++) w.say(where, 'her', `${SELF_FOOD[(k0 + i) % SELF_FOOD.length]}～${i}`);
  };
  goto(at(7, 30));
  await filler('bigGroup', 40);
  goto(at(8, 0));
  const breakfast = w.say('smallGroup', 'principal', '早饭吃了两个小笼包配豆浆', { addressed: 'ambient', attention: 'attended' });
  w.say('smallGroup', 'her', '小笼包听起来不错');
  await w.settle();
  for (const [h, where] of [[9, 'bigGroup'], [10, 'smallGroup'], [11, 'bigGroup']]) {
    goto(at(h, 0));
    selfFood(where, 4, h);
    await filler(where, 30);
    await w.settle();
  }
  // 午饭：只有一张图，她看过（D116：她看到的写进那条消息的 media_json，by: 'self'；原文窗口里是「我看到的：……」）
  goto(at(12, 10));
  const lunch = w.say('smallGroup', 'principal', '[图片]', { media: [{ kind: 'image' }], addressed: 'ambient', attention: 'attended' });
  const row = w.core.store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', w.fp.namespace, w.core.keys.obsKey(w.fp.namespace, lunch.id));
  w.core.store.run('UPDATE percepts SET media_json = ? WHERE id = ?',
    JSON.stringify([{ kind: 'image', summary: '一大碗红烧牛肉面，上面撒着香菜', by: 'self', at: w.clock.now() }]), row.id);
  w.say('smallGroup', 'her', '看起来好香');
  await w.settle();
  for (const [h, where] of [[13, 'bigGroup'], [14, 'smallGroup'], [15, 'bigGroup'], [16, 'smallGroup'], [17, 'bigGroup']]) {
    goto(at(h, 0));
    selfFood(where, 5, h);
    await filler(where, 30);
    await w.settle();
  }
  goto(at(18, 40));
  const dinner = w.say('bigGroup', 'principal', '晚饭是咖喱鸡肉饭，有点辣', { addressed: 'ambient', attention: 'attended' });
  await w.settle();
  for (const [h, where] of [[19, 'smallGroup'], [20, 'bigGroup']]) {
    goto(at(h, 0));
    selfFood(where, 5, h);
    await filler(where, 30);
    await w.settle();
  }
  goto(at(21, 0));
  return { w, refs: { breakfast, lunch: row.id, dinner } };
}

const MEALS = [['早饭', /小笼包/u], ['午饭', /牛肉面/u], ['晚饭', /咖喱/u]];
const show = (items) => items.map((i) => `${i.layer}:${String(i.rendered).slice(0, 40)}`).join(' | ');

test('回忆（D155）：「我今天吃了哪些东西」——三顿都在、按时间排、开头有「找了哪儿」；关掉开关时至少缺一顿', async (t) => {
  const on = await foodDay(t, 'recollect-on', {});
  const seed = on.w.fp.seed;
  let found;
  try {
    const { w } = on;
    const segs = w.core.store.get('SELECT (SELECT count(*) FROM raw_windows) + (SELECT count(*) FROM episodes) AS n').n;
    t.diagnostic(`这一天切成 ${segs} 段（原文窗口 + 情节）`);
    assert.ok(segs >= 100, `一百多段：${segs}`);
    const { layers } = await w.ask('oneOnOne', 'principal', '我今天吃了哪些东西');
    const rc = layers.items.filter((i) => i.layer === 'recollect');
    assert.ok(!layers.items.some((i) => i.layer === 'recalled' && i.verdict !== 'pending'), '新路：想起来的都在回忆那一层');
    found = MEALS.map(([n, re]) => [n, rc.findIndex((i) => re.test(i.rendered))]);
    t.diagnostic(`新路：${JSON.stringify(found)}；${show(rc)}`);
    for (const [n, i] of found) assert.ok(i >= 0, `${n}在回忆那一层里：${show(layers.items)}`);
    const idx = found.map(([, i]) => i);
    assert.ok(idx[0] < idx[1] && idx[1] < idx[2], `按时间从早到晚：${idx}`);
    assert.match(String(layers.recollect?.note ?? ''), /^找的是：今天（\d+\/\d+）/u, '开头一行说找的是什么范围');
    assert.match(layers.recollect.note, /范围里 \d+ 条记忆/u);
    assert.doesNotMatch(layers.recollect.note, /小笼包|牛肉面|咖喱/u, '这一行不含记忆内容');
    assert.equal(layers.recollect.log?.kind, 'auto');
  } finally { await on.w.cleanup(); }

  // 同一个种子、同样的一天，关掉开关：原来的有意回想至少缺一顿
  const off = await foodDay(t, 'recollect-off', { recall: { recollect: { enabled: false } } }, seed);
  try {
    const { layers } = await off.w.ask('oneOnOne', 'principal', '我今天吃了哪些东西');
    assert.ok(!layers.items.some((i) => i.layer === 'recollect'), '关掉开关：没有回忆那一层');
    assert.equal(layers.recollect, undefined);
    // 比的是回想那一层（原来的「想起来的」）：工作记忆（他在别处亲口跟她说的）是另一层，D155 不动它，两边一样
    const recalled = layers.items.filter((i) => i.layer === 'recalled');
    const got = MEALS.filter(([, re]) => recalled.some((i) => re.test(i.rendered))).map(([n]) => n);
    t.diagnostic(`老路「想起来的」：${got.join('、') || '一顿都没有'}；${show(recalled)}`);
    assert.ok(got.length < 3, `老路至少缺一顿（证明测的是这个机制）：${show(layers.items)}`);
  } finally { await off.w.cleanup(); }
});
