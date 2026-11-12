// 回想各层生效的上限（D165，用户反馈第 39 轮）：花费档位的 room 乘条数和总字数、不乘每条的字数；每条的字数管的是正文，来源说法不挤占它；
// 截断在词或句子的边界上；打包按新的预算；按层的计数。内容、名字都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeConfig } from '../../src/config/defaults.js';
import { recallCaps, clipBody, roomOf, META_CHARS } from '../../src/config/caps.js';
import { pack } from '../../src/context/pack.js';
import { parseRef } from '../../src/store/refs.js';
import { retrieveCore, seedEntity, seedSetting, seedAssertion, T0, HOUR } from '../retrieve/fixtures.js';
import { withWorld, percept, GROUP } from './world.js';

const cfgOf = (budget) => mergeConfig(DEFAULTS, { budget }).config;
const len = (s) => Array.from(String(s)).length;

test('生效的上限：三档各层的数（平衡是基线，节省 0.6、效果优先 2 乘条数和总字数，每条的字数不乘）', () => {
  const b = recallCaps(DEFAULTS);
  assert.equal(b.room, 1);
  assert.deepEqual(b.involuntary, { maxItems: 8, itemChars: 240, maxChars: 1600 });
  assert.deepEqual(b.deliberate, { maxItems: 12, itemChars: 240 });
  assert.deepEqual(b.working, { maxLines: 16, budgetChars: 1600, lineChars: 160, threadMaxLines: 10 });
  assert.equal(b.blockMaxChars, 2000);
  assert.deepEqual(b.layers, { warmStart: 800, todaySoFar: 450, presentRecent: 600, todayItems: 3, peopleCards: 3, peopleCardChars: 240 });
  assert.deepEqual(b.sinceHere, { maxItems: 4, itemChars: 200, chars: 800 });
  assert.deepEqual(b.recollect, { tool: { maxItems: 36, itemChars: 480, totalChars: 6000 }, auto: { maxItems: 18, itemChars: 360, totalChars: 3000 } });
  assert.deepEqual(b.pointBack, { max: 2, chars: 120 });
  assert.deepEqual(b.lessons, { recallMax: 2, itemChars: 220, chars: 480 });
  assert.equal(b.present.maxItems, 15);
  assert.equal(b.gapChars, 280, '时间间隔那一行 = 不自主回想一条的正文 + 40');

  const s = recallCaps(cfgOf({ preset: 'saving' }));
  assert.equal(s.room, 0.6);
  assert.deepEqual([s.involuntary.maxItems, s.involuntary.maxChars, s.deliberate.maxItems], [5, 960, 7]);
  assert.deepEqual([s.working.maxLines, s.working.budgetChars, s.blockMaxChars], [10, 960, 1200]);
  assert.deepEqual([s.layers.warmStart, s.layers.todaySoFar, s.layers.presentRecent, s.layers.todayItems], [480, 270, 360, 2]);
  assert.deepEqual([s.sinceHere.maxItems, s.sinceHere.chars, s.present.maxItems], [2, 480, 9]);
  assert.deepEqual([s.recollect.auto.maxItems, s.recollect.auto.totalChars], [11, 1800]);

  const u = recallCaps(cfgOf({ preset: 'unlimited' }));
  assert.equal(u.room, 2);
  assert.deepEqual([u.involuntary.maxItems, u.involuntary.maxChars, u.deliberate.maxItems], [16, 3200, 24]);
  assert.deepEqual([u.working.maxLines, u.working.budgetChars, u.blockMaxChars], [32, 3200, 4000]);
  assert.deepEqual([u.recollect.tool.maxItems, u.recollect.tool.totalChars], [72, 12000]);

  // 不随 room 变的：每条的字数、工作记忆一段的行数、指回去、人物卡、她的经验
  for (const k of [s, u]) {
    assert.deepEqual([k.involuntary.itemChars, k.deliberate.itemChars, k.working.lineChars, k.sinceHere.itemChars, k.recollect.tool.itemChars, k.recollect.auto.itemChars],
      [240, 240, 160, 200, 480, 360]);
    assert.deepEqual([k.working.threadMaxLines, k.pointBack.max, k.pointBack.chars, k.layers.peopleCards, k.layers.peopleCardChars, k.lessons.recallMax], [10, 2, 120, 3, 240, 2]);
  }
  assert.ok(Object.isFrozen(b) && Object.isFrozen(b.involuntary), '深冻结');
  assert.equal(recallCaps(DEFAULTS), b, '按快照缓存');
});

test('生效的上限：自定义的 room 覆盖档位；recollectScale 已弃用（读到了也忽略）；room 超出范围的覆盖不认', () => {
  const c = recallCaps(cfgOf({ preset: 'saving', overrides: { room: 1.5 } }));
  assert.equal(c.room, 1.5);
  assert.deepEqual([c.involuntary.maxItems, c.working.maxLines, c.recollect.auto.totalChars], [12, 24, 4500]);
  const old = mergeConfig(DEFAULTS, { budget: { overrides: { recollectScale: 0.25 } } });
  assert.deepEqual(old.warnings, [], '旧配置不报错');
  assert.equal(recallCaps(old.config).recollect.tool.maxItems, 36, '但不起作用');
  const bad = mergeConfig(DEFAULTS, { budget: { overrides: { room: 9 } } });
  assert.equal(bad.warnings.length, 1);
  assert.equal(roomOf(bad.config), 1);
  // 改了基线（手写的条数）照样乘 room
  const custom = mergeConfig(DEFAULTS, { budget: { preset: 'unlimited' }, recall: { involuntary: { maxItems: 3 } } }).config;
  assert.equal(recallCaps(custom).involuntary.maxItems, 6);
  // 宿主自动时的块上限的底数：整块 + 工作记忆 + 这之后他的事 + 回忆这一档
  const b = recallCaps(DEFAULTS);
  assert.equal(b.ceiling.inject, 2000 + 1600 + 800 + 3000);
  assert.equal(b.ceiling.tool, 2000 + 1600 + 800 + 6000);
  assert.equal(b.itemMax.recalled, 240 + META_CHARS);
});

test('在边界上截：句末标点、逗号之后断开，往回不超过三成；补齐没配对的引号括号；找不到边界就硬截；整条一定 ≤ 上限', () => {
  const s = '今天下午去了趟东门，买了一把折叠凳。晚上又去吃了烧烤，喝了两瓶汽水，回来已经快十二点了';
  const a = clipBody(s, 30);
  assert.ok(a.clipped && len(a.text) <= 30);
  assert.equal(a.text, '今天下午去了趟东门，买了一把折叠凳。晚上又去吃了烧烤…');
  assert.deepEqual(clipBody(s, 200), { text: s, clipped: false });
  // 引号里截断：补上收尾，不让「只剩半边
  const q = clipBody('阿明：「说得用几天感受一下再决定要不要换，反正也不急」', 16);
  assert.ok(len(q.text) <= 16, q.text);
  assert.ok(q.text.endsWith('…」'), q.text);
  // 一长串没有标点的：硬截
  const h = clipBody('长'.repeat(50), 20);
  assert.equal(h.text, `${'长'.repeat(19)}…`);
  assert.deepEqual(clipBody('', 10), { text: '', clipped: false });
  assert.equal(clipBody('abcdef', 1).text, '…');
  // 英文在空白处断
  assert.equal(clipBody('the quick brown fox jumps over the lazy dog', 22).text, 'the quick brown fox…');
});

test('正文不被来源说法挤占：一条 200 字的事实在平衡档完整给出，来源说法照样在；超过上限的正文在边界上截、标出截短了', async () => {
  const env = await retrieveCore();
  try {
    const { core } = env;
    const boss = seedEntity(core, { name: '大王', authority: 'principal', closeness: 1 });
    seedEntity(core, { name: '小鱼', isSelf: true });
    seedSetting(core, 'G', { label: '一个编出来的群' });
    const body = `周六下午三点在东门集合，${'记得带上折叠凳和保温壶，迟到的人请大家喝奶茶。'.repeat(9)}`.slice(0, 200);
    assert.equal(len(body), 200);
    const id = seedAssertion(core, { text: body, subjects: [boss], confidence: 0.95, sources: [{ speaker: boss, mode: 'overheard', perceivedIn: 'G', at: T0 - 2 * HOUR }] });
    const cand = { ref: `a${id}`, mref: parseRef(`a${id}`), ranks: {}, rrf: 0, signals: {}, A: 1, P: 0.95, parts: {} };
    const K = recallCaps(core.config.get());
    const r = core.mods.retrieve.render(core, cand, { verdict: 'share', at: T0, bodyChars: K.involuntary.itemChars, settingKey: 'D' });
    assert.ok(r.rendered.includes(body), '正文完整');
    assert.match(r.rendered, /^（[^）]*主人在「一个编出来的群」自己说的）/u, '来源说法照样在');
    assert.ok(!r.clipped);
    // 正文的上限正好 200：正文一个字不少，整条比 200 长（来源说法不占正文的字数；原来一起算，正文只剩一百六十来字）
    const tight = core.mods.retrieve.render(core, cand, { verdict: 'share', at: T0, bodyChars: 200, settingKey: 'D' });
    assert.ok(tight.rendered.includes(body) && !tight.clipped && len(tight.rendered) > 200, tight.rendered);
    assert.ok(len(r.rendered) <= K.itemMax.recalled);
    // 正文超过上限：在边界上截、标出截短了；来源说法还在
    const long = seedAssertion(core, { text: `${body}${body}`, subjects: [boss], confidence: 0.95, sources: [{ speaker: boss, mode: 'overheard', perceivedIn: 'G', at: T0 - HOUR }] });
    const r2 = core.mods.retrieve.render(core, { ...cand, ref: `a${long}`, mref: parseRef(`a${long}`) }, { verdict: 'share', at: T0, bodyChars: 240, settingKey: 'D' });
    assert.ok(r2.clipped);
    assert.match(r2.rendered, /。…|…$/u, r2.rendered);
    assert.match(r2.rendered, /自己说的）/u);
    // 没给 bodyChars（常驻区、提炼背景）：照旧整条 ≤ itemChars
    const r3 = core.mods.retrieve.render(core, cand, { verdict: 'share', at: T0, itemChars: 120, settingKey: 'D' });
    assert.ok(len(r3.rendered) <= 120);
  } finally { await env.cleanup(); }
});

// 打包：每条 = 正文 240 字 + 来源说法约 40 字（真实的样子：正文截到上限、带着来源说法）
let seq = 0;
const E = (ref, layer, chars, o = {}) => ({ ref, layer, verdict: 'share', rendered: `（今晚 18:01 · 36 分钟前，某人在「某群」自己说的）${'字'.repeat(chars)}`, provenance: '',
  confidence: 0.8, appraisalRef: `ap${(seq += 1)}`, group: `${layer}:${ref}`, order: seq, ...o });
const free = { dayUsed: 0, dayLimit: Infinity, rollingLeft: Infinity };
const packAt = (cfg, entries, o = {}) => {
  const report = {};
  const items = pack(entries, { cfg, mode: o.mode ?? 'involuntary', sent: new Set(), budgetChars: o.budgetChars ?? recallCaps(cfg).blockMaxChars, budget: o.budget ?? free, report });
  return { items, report };
};

test('打包按新的预算：平衡档 8 条整条的想起来的都在；节省档少、效果优先档多；整块不超过这一档的上限', () => {
  const rec = Array.from({ length: 20 }, (_, i) => E(`a${i + 1}`, 'recalled', 160));
  const n = (cfg) => packAt(cfg, rec).items.filter((i) => i.layer === 'recalled').length;
  assert.equal(n(DEFAULTS), 8, '平衡档：8 条都在（原来 5 条、600 字时只放得下 3 条）');
  assert.equal(n(cfgOf({ preset: 'saving' })), 5);
  assert.equal(n(cfgOf({ preset: 'unlimited' })), 16);
  const r = packAt(DEFAULTS, rec);
  assert.equal(r.report.capDropped.recalled, 12, '按层记下因为条数上限没装进去的');
  // 一条比这一层的 itemMax 还长（正常渲染不会有）：在这里截短、照样装，按层记
  const huge = packAt(DEFAULTS, [E('a99', 'recalled', 900)]);
  assert.equal(huge.items.length, 1);
  assert.ok(len(huge.items[0].rendered) <= recallCaps(DEFAULTS).itemMax.recalled);
  assert.deepEqual([huge.report.clipped, huge.report.overMax], [{ recalled: 1 }, { recalled: 1 }]);
  // 额度用完：按层记因为额度没装进去的
  const over = packAt(DEFAULTS, rec.slice(0, 3), { budget: { dayUsed: 1, dayLimit: 1, rollingLeft: Infinity } });
  assert.deepEqual(over.report.dropped, { recalled: 3 });
});

test('计数：context.clip.<层>（正文被截短、真给出去的）、context.pack.budgetDropped.<层>、context.pack.capDropped.<层>', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = Array.from({ length: 12 }, (_, i) => `a${i + 1}`);
  for (let i = 1; i <= 12; i++) w.texts.set(`a${i}`, i === 1 ? '长'.repeat(400) : `一件编出来的事 ${i}`);
  const out = await core.mods.context.recall(core, { settingId: GROUP, trigger: 'message', sessionId: 's1' }, { mode: 'involuntary', deadlineMs: 800, budgetChars: 2000 });
  assert.equal(out.items.filter((i) => i.layer === 'recalled').length, 8);
  const m = (name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
  assert.equal(m('context.clip.recalled'), 1, '那条 400 字的正文截到上限');
  assert.equal(m('context.pack.capDropped.recalled'), 4, '多出来的 4 条因为条数上限没装进去');
  const h = core.mods.context.recallHealth(core);
  assert.equal(h.days[0].inject.clipped.recalled, 1);
  assert.equal(h.days[0].inject.capDropped.recalled, 4);
  // 宿主报来的截掉的条数
  core.mods.context.noteHostRecall(core, 's1', { outcome: 'truncated', count: 3 });
  assert.equal(m('host.inject.truncated'), 3);
  assert.equal(m('host.recall.other'), 0, '不算一次等回想');
}));
