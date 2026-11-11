// 指回去（D146）：别人直接对她说的话开启的一轮，回想排在最前面的条目这个周期已经给过时，给一行「指回去」，不是整条再发一遍。
// 内容、名字都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecallLayers } from '../../src/contract/index.js';
import { pointBackOf } from '../../src/context/pack.js';
import { budgetState, loadSession, pointBackCounts } from '../../src/context/ledger.js';
import { withWorld, percept, DM, GROUP, ADAPTER } from './world.js';

const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };
const DELIB = { mode: 'deliberate', deadlineMs: 3000, budgetChars: 900 };
const sit = (sid, o = {}) => ({ settingId: sid, trigger: 'message', sessionId: 's1', ...o });
const ids = (out, layer) => out.items.filter((i) => !layer || i.layer === layer).map((i) => i.id);
const metric = (core, name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
// 群里那段原话（编的）：比指回去的截断长度长
const QUOTE = '〔在一个群里，阿明说〕周六下午三点在东门集合，记得带上折叠凳和那个蓝色的保温壶，迟到的人请大家喝奶茶，地点要是改了我再在群里说一声，大家别忘了，另外记得看天气预报，下雨就改到下周六同一个时间，还是东门见';

/** 集成层的做法：每条带自己的字数（D133），记进注入日志并确认。recordInjection 对不上判定会抛错。 */
function deliver(core, out, nonce = `n-${Math.random().toString(36).slice(2)}`) {
  core.mods.context.recordInjection(core, {
    sessionId: 's1', nonce, layer: 'block', mode: 'live',
    items: out.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef, chars: Array.from(i.rendered).length })),
    chars: out.items.reduce((n, i) => n + Array.from(i.rendered).length, 0),
  });
  core.mods.context.confirmInjection(core, 's1', nonce);
  return nonce;
}

function setup(core, w) {
  core.mods.context.bindSession(core, { sessionId: 's1', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  w.texts.set('p1', QUOTE).set('a2', '你喜欢喝热的乌龙茶').set('a3', '上周说过想换个新键盘');
}

test('D146：第一轮给过的那段原话，第二轮被直接追问、它还是最相关的——给一行指回去（那一条渲染的开头），别的照常；注入日志记得下来', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  setup(core, w);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '刚才群里说的那个你看到没' });
  w.candidates = ['p1', 'a2'];
  const first = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(first, 'recalled'), ['p1', 'a2']);
  assert.deepEqual(ids(first, 'pointBack'), [], '第一轮什么都没给过，不指');
  deliver(core, first);

  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '你知道我说的是哪个吗' });
  w.candidates = ['p1', 'a3', 'a2'];
  const out = await ctx.recall(core, sit(DM), INVOL);
  const v = validateRecallLayers(out);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(ids(out, 'recalled'), ['a3'], '新的照常给');
  const pb = out.items.filter((i) => i.layer === 'pointBack');
  assert.deepEqual(pb.map((i) => i.id), ['p1']);
  const orig = first.items.find((i) => i.id === 'p1').rendered;
  assert.equal(Array.from(pb[0].rendered).length, core.config.get().context.pointBack.chars, '截到配置的字数');
  assert.ok(orig.startsWith(pb[0].rendered.slice(0, -1)) && pb[0].rendered.endsWith('…'), '沿用原来的渲染（来源说法 + 内容的开头）');
  // 对得上这一轮的判定：同一条记忆、同一个结论
  const row = core.store.get('SELECT memory_kind, memory_id, verdict FROM appraisals WHERE id = ?', Number(pb[0].appraisalRef.slice(2)));
  assert.deepEqual([row.memory_kind, row.memory_id, row.verdict], ['percept', 1, 'share']);
  assert.notEqual(pb[0].appraisalRef, first.items.find((i) => i.id === 'p1').appraisalRef, '是这一轮的判定，不是上一轮的');
  // 展示顺序：紧跟在工作记忆后面，在想起来的前面
  assert.ok(out.items.indexOf(pb[0]) < out.items.findIndex((i) => i.layer === 'recalled'));
  assert.equal(metric(core, 'context.pointBack'), 1);

  // 记进注入日志：不抛「对不上判定」；层名是 pointBack，和新给的分得开
  const before = budgetState(core, loadSession(core, 's1'), core.now()).dayUsed;
  deliver(core, out, 'n-2');
  const logged = JSON.parse(core.store.get("SELECT items_json FROM injections WHERE nonce = 'n-2'").items_json);
  assert.deepEqual(logged.find((i) => i.layer === 'pointBack'), { id: 'p1', layer: 'pointBack', verdict: 'share', appraisalRef: pb[0].appraisalRef, chars: 80 });
  // 预算只按这一行的字数记
  const after = budgetState(core, loadSession(core, 's1'), core.now()).dayUsed;
  assert.equal(after - before, out.items.reduce((n, i) => n + Array.from(i.rendered).length, 0));
  // 污点账本照旧（那一条早就在里面）；本周期指回过一次
  assert.ok(ctx.taintLedger(core, 's1').includes('p1'));
  assert.deepEqual([...pointBackCounts(core, loadSession(core, 's1'))], [['p1', 1]]);
}));

test('D146：排在这一轮新给的条目后面的已给过的条目不指；这一轮这两层什么都没给出来时，排在最前的指', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  setup(core, w);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her' });
  w.candidates = ['p1', 'a2'];
  deliver(core, await ctx.recall(core, sit(DM), INVOL));
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her' });
  w.candidates = ['a3', 'p1', 'a2'];
  let out = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(out, 'recalled'), ['a3']);
  assert.deepEqual(ids(out, 'pointBack'), [], '新给的 a3 排在它们前面');
  // 只有已经给过的：排在最前的几条（最多 max 条）
  w.candidates = ['a2', 'p1'];
  out = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(out, 'recalled'), []);
  assert.deepEqual(ids(out, 'pointBack'), ['a2', 'p1']);
}));

test('D146：她自己开启的轮、旁听的轮、记忆工具那条路（有意回想）不指；对她说的话被切到有意回想时照样指', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  setup(core, w);
  core.mods.context.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = ['p1', 'a2'];
  deliver(core, await ctx.recall(core, sit(GROUP), INVOL));
  w.candidates = ['p1', 'a3'];
  // 她自己开口（空闲唤醒、提醒到点）
  for (const trigger of ['idle', 'reminder']) {
    assert.deepEqual(ids(await ctx.recall(core, sit(GROUP, { trigger }), INVOL), 'pointBack'), [], trigger);
  }
  // 记忆工具（集成层按有意回想调）：D95 那条路，不动
  const tool = await ctx.recall(core, sit(GROUP), DELIB);
  assert.deepEqual(ids(tool, 'pointBack'), []);
  // 旁听：最新一条不是对她说的
  percept(core, w, { sid: GROUP, actor: w.ids.hong, addressed: 'ambient', text: '今天好热' });
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP), INVOL), 'pointBack'), []);
  // 对她说、看起来在问过去（切到有意回想）：还是别人直接问她，照样指
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '上次说的那个你还记得吗' });
  w.past = true;
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP), INVOL), 'pointBack'), ['p1']);
  assert.equal(metric(core, 'context.pointBack'), 1);
}));

test('D146：不能绕过分寸——这一轮关口①判它只能暗示时不指；只让说个大概时只给大概的那句', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  setup(core, w);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her' });
  w.candidates = ['p1', 'a2'];
  deliver(core, await ctx.recall(core, sit(DM), INVOL));
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her' });
  w.candidates = ['p1', 'a3'];
  w.verdicts.set('p1', { verdict: 'aware_private', hintOk: true });
  let out = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(out, 'pointBack'), []);
  assert.ok(!out.items.some((i) => i.rendered.includes('东门')));
  w.verdicts.set('p1', 'omit');
  assert.deepEqual(ids(await ctx.recall(core, sit(DM), INVOL), 'pointBack'), []);
  w.verdicts.set('p1', { verdict: 'share_vague', vagueText: '有人约了周末一起出去' });
  out = await ctx.recall(core, sit(DM), INVOL);
  const pb = out.items.filter((i) => i.layer === 'pointBack');
  assert.deepEqual(pb.map((i) => [i.id, i.verdict]), [['p1', 'share_vague']]);
  assert.ok(pb[0].rendered.includes('有人约了周末一起出去') && !pb[0].rendered.includes('东门'), pb[0].rendered);
  deliver(core, out);   // 结论是 share_vague，对得上这一轮的判定
}));

test('D146：同一条一个周期里最多指回 perCycle 次；压缩以后重新算', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  setup(core, w);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her' });
  w.candidates = ['p1'];
  deliver(core, await ctx.recall(core, sit(DM), INVOL));
  w.candidates = ['p1', 'a2'];
  for (let i = 0; i < 2; i++) {
    const out = await ctx.recall(core, sit(DM), INVOL);
    // a2 只在第一次是新的；第二次它也给过了，排在 p1 后面一起指（max 2）——这里只看 p1
    assert.equal(ids(out, 'pointBack')[0], 'p1', `第 ${i + 1} 次`);
    deliver(core, out);
  }
  let out = await ctx.recall(core, sit(DM), INVOL);
  assert.ok(!ids(out, 'pointBack').includes('p1'), '指回过 2 次了');
  assert.ok(metric(core, 'context.pointBack.capped') >= 1);
  // 记了没确认、回合中止的不算
  core.mods.context.recordInjection(core, { sessionId: 's1', nonce: 'n-x', layer: 'block', mode: 'live',
    items: out.items.map(({ id, layer, verdict, appraisalRef }) => ({ id, layer, verdict, appraisalRef })), chars: 10 });
  ctx.abortPending(core, 's1');
  assert.equal(pointBackCounts(core, loadSession(core, 's1')).get('p1'), 2);
  ctx.compaction(core, 's1', 'end');
  out = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(out, 'recalled').sort(), ['a2', 'p1'], '压缩以后整条重新给');
  assert.deepEqual(ids(out, 'pointBack'), []);
}));

test('D146 pointBackOf（纯函数）：只挑想起来的 / 在场者近况里排在这一轮新给的前面的；绑着的不单独指；max 0 不指', () => {
  const e = (ref, order, o = {}) => ({ ref, layer: 'recalled', verdict: 'share', rendered: `正文${ref}`, provenance: '', confidence: 0.8, appraisalRef: `ap${order + 1}`, group: `r:${ref}`, order, ...o });
  const entries = [e('a1', 0), e('a9', 1, { bound: true }), e('a2', 10, { layer: 'recentFromPresent' }), e('a3', 20), e('a4', 30), e('a5', 5, { layer: 'people' })];
  const items = [{ id: 'a3', layer: 'recalled', verdict: 'share' }];
  const sent = new Set(['a1', 'a9', 'a2', 'a4', 'a5']);
  const r = pointBackOf(entries, items, sent, { max: 3, chars: 80, perCycle: 2 });
  assert.deepEqual(r.entries.map((x) => [x.ref, x.layer, x.appraisalRef, x.group]), [['a1', 'pointBack', 'ap1', 'b:a1'], ['a2', 'pointBack', 'ap11', 'b:a2']]);
  assert.deepEqual(pointBackOf(entries, items, sent, { max: 1, chars: 80, perCycle: 2 }).entries.map((x) => x.ref), ['a1']);
  assert.deepEqual(pointBackOf(entries, items, sent, { max: 0, chars: 80, perCycle: 2 }).entries, []);
  const capped = pointBackOf(entries, items, sent, { max: 3, chars: 80, perCycle: 2, counts: new Map([['a1', 2]]) });
  assert.deepEqual([capped.entries.map((x) => x.ref), capped.capped], [['a2'], 1]);
});
