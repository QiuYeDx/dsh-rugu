// context 牵头的场景 S20b（§14.3：「同一个会话隔了三周，主人说『在吗』→ 先意识到很久没聊了，不接着三周前的话题问」，§10.4 时间间隔），
// 以及时间间隔这一层的细节：只在第一条真实消息时提示一次、写绝对时间、上次聊的内容不能说时只给时间、按人的间隔。
// retrieve 参与（它把三周前那段经历当候选交上来），这里用替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecallLayers } from '../../src/contract/index.js';
import { withWorld, percept, episode, storyline, GROUP, DM, ADAPTER } from './world.js';

const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };
const sit = (sid, o = {}) => ({ settingId: sid, trigger: 'message', ...o });
function deliver(core, sessionId, out, nonce = `n-${Math.random().toString(36).slice(2)}`) {
  core.mods.context.recordInjection(core, {
    sessionId, nonce, layer: 'block', items: out.items.map(({ id, layer, verdict, appraisalRef }) => ({ id, layer, verdict, appraisalRef })),
    chars: out.items.reduce((n, i) => n + i.rendered.length, 0), mode: 'live',
  });
  core.mods.context.confirmInjection(core, sessionId, nonce);
}

test('S20b：同一个会话隔了三周，主人说「在吗」→ 先意识到很久没聊了（时间间隔排在最前，「现在」写全年月日，D148），不接着三周前的话题问', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  // 三周前：在这个私聊里约了周末去爬山
  const t0 = core.now();
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '周末去爬山吧' });
  clock.minutes(1);
  percept(core, w, { sid: DM, self: true, text: '好呀' });
  const old = episode(core, w, { sid: DM, at: core.now(), title: '约了周末去爬山' });
  w.texts.set(`e${old}`, '10/31 和主人约了周末去爬山');
  w.candidates = [`e${old}`];
  let out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(!out.items.some((i) => i.layer === 'gap'), '一直在聊：没有时间间隔');
  deliver(core, 's1', out);

  // 三周后，同一个会话（期间没有压缩），主人只说了一句「在吗」
  clock.days(21);
  // 这三周里夜间整理给这个私聊写了故事线（新的记忆单元）
  const sl = storyline(core, w, { sid: DM, text: '最近在聊爬山' });
  w.texts.set(`s${sl}`, '这个私聊最近在聊周末爬山');
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '在吗' });
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(validateRecallLayers(out).ok);
  const gap = out.items.filter((i) => i.layer === 'gap');
  assert.equal(gap.length, 1);
  assert.equal(out.items[0].layer, 'gap', '先意识到很久没聊了');
  const text = gap[0].rendered;
  assert.ok(text.includes('已经 3 周了'), text);
  assert.match(text, /现在是 2026-11-21（周.）\S\S \d{1,2}:\d\d；/u, '「现在」那一句写全年月日、星期几和时段（F25：留在会话里也认得出是哪天）');
  assert.ok(text.includes('上次在这里聊是 10/31，'), text);
  assert.ok(text.includes('上次聊到：10/31 和主人约了周末去爬山'), text);
  assert.ok(text.includes('别直接接着那时的话题'));
  assert.ok(gap[0].appraisalRef.startsWith('ap'));
  // 三周前那段经历不会被当成新鲜的「想起来的」再塞一遍（本周期发过，而且就在时间间隔那一行里）
  assert.ok(!out.items.some((i) => i.layer === 'recalled' && i.id === `e${old}`));
  // 时间间隔同时触发暖启动
  assert.deepEqual(out.items.filter((i) => i.layer === 'warmStart').map((i) => i.id), [`s${sl}`]);
  deliver(core, 's1', out);

  // 两分钟后接着聊：不再提示
  clock.minutes(2);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '最近忙啥呢' });
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(!out.items.some((i) => i.layer === 'gap'));
  assert.ok(t0 < core.now());
}));

test('时间间隔：块没发出去（回合中止）下次照样提示；同一回合里正在等确认的不重复给；预取缓存里算好的那一行发过以后也不再给', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '早' });
  clock.days(2);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '在吗' });
  let out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(out.items.some((i) => i.layer === 'gap'));
  ctx.recordInjection(core, { sessionId: 's1', nonce: 'n-1', layer: 'block',
    items: out.items.map(({ id, layer, verdict, appraisalRef }) => ({ id, layer, verdict, appraisalRef })), chars: 50, mode: 'live' });
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(!out.items.some((i) => i.layer === 'gap'), '同一回合正在等确认');
  assert.ok(!ctx.recallCached(core, sit(DM, { sessionId: 's1' })).items.some((i) => i.layer === 'gap'));
  ctx.abortPending(core, 's1');
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(out.items.some((i) => i.layer === 'gap'), '没发出去：下次照样提示');
  deliver(core, 's1', out);
  assert.ok(!ctx.recallCached(core, sit(DM, { sessionId: 's1' })).items.some((i) => i.layer === 'gap'), '缓存里的那一行已经发过');
  // 重新开始之后不给（只给常驻区，§17 Q6）
  ctx.compaction(core, 's1', 'restart');
  clock.days(2);
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '又是我' });
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.ok(!out.items.some((i) => i.layer === 'gap'));
}));

test('时间间隔：上一段经历不能说时，退到上次那条原话；那条也只能暗示时，这一行只有时间、不带内容（结论照实记，不进污点账本）', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  const last = percept(core, w, { sid: GROUP, actor: w.ids.ming, text: '下周团建去湖边' });
  const ep = episode(core, w, { sid: GROUP, at: core.now(), title: '小红私下的事' });
  w.texts.set(`p${last}`, '阿明说下周团建去湖边').set(`e${ep}`, '小红私下的事');
  w.verdicts.set(`e${ep}`, 'omit');
  clock.days(5);
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '在吗' });
  let out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  let gap = out.items.find((i) => i.layer === 'gap');
  assert.equal(gap.id, `p${last}`);
  assert.ok(gap.rendered.includes('5 天') && gap.rendered.includes('阿明说下周团建去湖边'));
  assert.ok(!gap.rendered.includes('小红'));
  // 那条原话也只能暗示：只给时间
  ctx.abortPending(core, 's1');
  w.verdicts.set(`p${last}`, { verdict: 'aware_private', hintOk: true });
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  gap = out.items.find((i) => i.layer === 'gap');
  assert.equal(gap.verdict, 'aware_private');
  assert.ok(gap.rendered.includes('5 天') && !gap.rendered.includes('团建'));
  deliver(core, 's1', out);
  assert.ok(!ctx.taintLedger(core, 's1').includes(`p${last}`));
  // 两条都不能说：连时间也不给（这一行也是记忆派生的文字，必须有判定）
  clock.days(5);
  w.verdicts.set(`p${last}`, 'omit');
  const p2 = percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '又在吗' });
  w.verdicts.set(`p${p2 - 1}`, 'omit');
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.ok(!out.items.some((i) => i.layer === 'gap'));
}));

test('时间间隔：群里一直有人在聊，但这个人很久没和她说过话了——按人的间隔提示；没有会话 id 时只在这一段的第一条提示', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '上次的话' });
  for (let i = 0; i < 20; i++) { clock.hours(4); percept(core, w, { sid: GROUP, actor: w.ids.hong, text: '闲聊' }); }
  clock.minutes(5);
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '我回来了' });
  let out = await ctx.recall(core, sit(GROUP), INVOL);
  const gap = out.items.find((i) => i.layer === 'gap');
  assert.ok(gap, '按人的间隔');
  assert.ok(gap.rendered.includes('正在跟你说话的这个人'));
  assert.ok(gap.rendered.includes('3 天'), gap.rendered);
  // 没有会话：同一段里后面的消息不再提示
  clock.minutes(1);
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '在不在' });
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.ok(!out.items.some((i) => i.layer === 'gap'));
}));
