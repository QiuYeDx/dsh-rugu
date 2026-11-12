// context 接到别的模块的那几处（阶段 B 交付说明里的请求）：
//   - retrieve.render 收目标场合（settingKey）和旧版本（previous，「之前……，后来……」）；
//   - discretion 的 GatedItem.told（S14，不当新鲜事再讲）、hintSpecific（§9.3.4，暗示可以具体一点）；
//   - discretion.targetFor 收 settingId / adapterId（常驻区也带）；
//   - retrieve 的 outcomeOf（计划和它的结果一组，S1）；
//   - backup.isRestoring（§12.4.5 第 2 步：恢复期间不注入新回想，常驻区给冻结的文本）。
import test from 'node:test';
import { recallCaps } from '../../src/config/caps.js';
import assert from 'node:assert/strict';
import { validateRecallLayers } from '../../src/contract/index.js';
import { withWorld, percept, plan, GROUP, DM, ADAPTER, H } from './world.js';
import { loadSession } from '../../src/context/ledger.js';

const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };
const sit = (sid, o = {}) => ({ settingId: sid, trigger: 'message', ...o });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const ids = (out, layer) => out.items.filter((i) => !layer || i.layer === layer).map((i) => i.id);
const len = (s) => Array.from(s).length;

function assertGated(core, out) {
  const v = validateRecallLayers(out);
  assert.ok(v.ok, JSON.stringify(v.errors));
  for (const it of out.items) {
    const row = core.store.get('SELECT memory_kind, memory_id, verdict FROM appraisals WHERE id = ?', Number(it.appraisalRef.slice(2)));
    assert.ok(row, `${it.id} 的判定记录不在`);
    assert.equal(row.verdict, it.verdict);
  }
}
function deliver(core, sessionId, items, nonce = `n-${Math.random().toString(36).slice(2)}`) {
  core.mods.context.recordInjection(core, {
    sessionId, nonce, layer: 'block', items: items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })),
    chars: items.reduce((n, i) => n + len(i.rendered), 0), mode: 'live',
  });
  core.mods.context.confirmInjection(core, sessionId, nonce);
}

test('retrieve.render 收目标场合：想起来的、时间间隔、常驻区都按正在说话的场合渲染（「在这里」、这里的叫法）', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '还记得吗' });
  w.candidates = ['a1', 'a2'];
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(w.calls.render.length >= 2);
  assert.ok(w.calls.render.every((r) => r.settingKey === w.key(GROUP)), JSON.stringify(w.calls.render));
  // 常驻区
  w.calls.render.length = 0;
  plan(core, { text: '明天去拿快递', start: core.now() + 2 * H, agent: w.ids.owner });
  core.mods.context.resident(core, DM);
  await settle();
  assert.ok(w.calls.render.length >= 1);
  assert.ok(w.calls.render.every((r) => r.settingKey === w.key(DM)));
}));

test('discretion.targetFor 收 settingId / adapterId：回想时、常驻区渲染时都带（能列成员的平台据此刷新名单）', () => withWorld(async ({ core, w }) => {
  core.mods.context.resident(core, DM);
  await settle();
  const res = w.calls.targetFor.find((t) => t.settingKey === w.key(DM) && t.sessionId === null);
  assert.ok(res, '常驻区要了一次目标');
  assert.equal(res.settingId, DM);
  assert.equal(res.adapterId, ADAPTER);
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = ['a1'];
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  const t = w.calls.targetFor.at(-1);
  assert.equal(t.settingId, GROUP);
  assert.equal(t.adapterId, ADAPTER);
  // 只经会话绑定知道的场合（插件重启后先 bind，常驻区后渲染）：也带上
  w.calls.targetFor.length = 0;
  core.state.context.settingIds.clear();
  core.mods.context.bindSession(core, { sessionId: 's9', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  await core.mods.context.refreshResident(core, w.key(GROUP));
  assert.equal(w.calls.targetFor.at(-1).settingId, GROUP);
}));

test('版本：新版本和最近被取代的那一版都过了关口① → 合成一条「之前……，后来……」；旧版本作为绑在它上面的一项交出去（注入日志、已发、污点账本都有它）', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '他现在在哪上班' });
  w.candidates = [{ ref: 'a2', previousRef: 'a1' }, { ref: 'a1', versionOf: 'a2' }, 'a3'];
  w.texts.set('a2', '阿明在B公司上班').set('a1', '阿明在A公司上班').set('a3', '阿明喜欢猫');
  w.provenance.set('a1', '听小红在这里说的');
  let out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assertGated(core, out);
  assert.deepEqual(ids(out, 'recalled'), ['a2', 'a1', 'a3'], '旧版本紧跟在新版本后面');
  const a2 = out.items.find((i) => i.id === 'a2');
  const a1 = out.items.find((i) => i.id === 'a1');
  assert.equal(a2.rendered, '之前阿明在A公司上班，后来阿明在B公司上班');
  assert.equal(a1.rendered, '（之前那一版是听小红在这里说的）', '旧版本那一项只写来源，内容已经在新版本那条里了');
  assert.ok(!a1.rendered.includes('A公司'));
  const r = w.calls.render.find((x) => x.ref === 'a2' && x.previous === 'a1');
  assert.ok(r, 'render 拿到了 opt.previous');
  deliver(core, 's1', out.items);
  assert.ok(ctx.taintLedger(core, 's1').includes('a1') && ctx.taintLedger(core, 's1').includes('a2'));
  assert.ok(loadSession(core, 's1').sent.includes('a1'));
  // 同一周期再想起：都发过了，不再发
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out, 'recalled'), []);
}));

test('版本：旧版本不能说（或新版本只能说个大概）就不合并，各自照常；绑着的旧版本放不下时新版本那条也不放（不让旧内容没记账就进上下文）', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = [{ ref: 'a2', previousRef: 'a1' }, { ref: 'a1', versionOf: 'a2' }];
  w.texts.set('a2', '阿明在B公司上班').set('a1', '阿明在A公司上班');
  w.verdicts.set(`n${w.ids.ming}`, 'omit');   // 人物卡不占预算，只看想起来的
  w.verdicts.set('a1', { verdict: 'aware_private', hintOk: true });
  let out = await ctx.recall(core, sit(GROUP), INVOL);
  assertGated(core, out);
  assert.equal(out.items.find((i) => i.id === 'a2').rendered, '阿明在B公司上班');
  assert.equal(out.items.find((i) => i.id === 'a1').layer, 'awarePrivate');
  assert.ok(!w.calls.render.some((x) => x.previous), '没合并');
  // 新版本只能说个大概：含糊版本放不进旧内容，不合并
  w.verdicts.set('a1', 'share').set('a2', { verdict: 'share_vague', vagueText: '他换了工作' });
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(out.items.map((i) => i.rendered).sort(), ['他换了工作', '阿明在A公司上班'].sort());
  // 旧版本说个大概：合并，用它的含糊版本
  w.verdicts.set('a2', 'share').set('a1', { verdict: 'share_vague', vagueText: '他以前在别处上班' });
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.equal(out.items.find((i) => i.id === 'a2').rendered, '之前他以前在别处上班，后来阿明在B公司上班');
  assert.equal(out.items.find((i) => i.id === 'a1').verdict, 'share_vague');
  // 预算只够新版本那一条：整组不放
  w.verdicts.set('a1', 'share');
  const merged = '之前阿明在A公司上班，后来阿明在B公司上班';
  out = await ctx.recall(core, sit(GROUP), { ...INVOL, budgetChars: len(merged) + 2 });
  assert.deepEqual(ids(out), []);
}));

test('计划和它的结果（outcomeOf）是一组：挨着出现；计划本周期已经提过，后来才想起来的结果照样给', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '快递拿了没' });
  w.texts.set('a5', '小秋要去拿快递（后来做完了）').set('e7', '小秋说拿到快递了').set('a6', '小秋最近在忙毕设');
  w.candidates = ['a5'];
  let out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  deliver(core, 's1', out.items);
  w.candidates = ['a5', 'a6', { ref: 'e7', outcomeOf: 'a5', attachedTo: 'a5' }];
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assertGated(core, out);
  assert.deepEqual(ids(out, 'recalled'), ['e7', 'a6'], '计划发过了，结果照样给');
  // 新会话：计划、结果挨着，结果排在下一条想起来的前面
  ctx.bindSession(core, { sessionId: 's2', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  out = await ctx.recall(core, sit(DM, { sessionId: 's2' }), INVOL);
  assert.deepEqual(ids(out, 'recalled'), ['a5', 'e7', 'a6']);
  // 计划不能说：结果自成一条
  w.verdicts.set('a5', 'omit');
  out = await ctx.recall(core, sit(DM, { sessionId: 's2' }), INVOL);
  assert.deepEqual(ids(out, 'recalled'), ['a6', 'e7'], '按它自己被想起的顺序');
}));

test('S14 告诉过谁：对这里的人讲过的带一句「讲过了」（什么时候讲的按人感觉的写，D148），不当新鲜事再讲；D165：附注不占正文的字数', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  const itemChars = core.config.get().recall.involuntary.itemChars;
  w.candidates = ['a1', 'a2', 'a3'];
  w.texts.set('a1', '阿明下周去成都').set('a2', '小红养了只猫').set('a3', '长'.repeat(300));
  w.verdicts.set('a1', { verdict: 'share', told: { at: core.now() - 2 * H, level: 'full' } })
    .set('a2', { verdict: 'share', told: { at: core.now() - 3 * H, level: 'vague' } })
    .set('a3', { verdict: 'share', told: { at: core.now() - H, level: 'full' } });
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assertGated(core, out);
  const a1 = out.items.find((i) => i.id === 'a1').rendered;
  assert.match(a1, /^阿明下周去成都（你(今天|今晚|昨天)\S* \d{1,2}:\d\d 已经对这里的人讲过，别当新鲜事再讲）$/u);
  assert.match(out.items.find((i) => i.id === 'a2').rendered, /提过个大概/);
  const a3 = out.items.find((i) => i.id === 'a3').rendered;
  // D165：正文照样截到上限，「讲过了」接在后面、不挤占正文（原来附注一起算，正文只剩几十个字）
  assert.ok(a3.startsWith('长'.repeat(itemChars)) && !a3.startsWith('长'.repeat(itemChars + 1)), '正文 = 上限');
  assert.ok(a3.endsWith('别当新鲜事再讲）'));
  assert.ok(len(a3) <= recallCaps(core.config.get()).itemMax.recalled, '整条仍在这一层的 itemMax 以内');
  // 两小时前的钟点（测试时区 +8）；附注会留在会话里一阵，不带「多久以前」（D148）
  const local = new Date(core.now() - 2 * H + 8 * H).toISOString();
  assert.ok(a1.includes(` ${Number(local.slice(11, 13))}:${local.slice(14, 16)} `), a1);
  assert.ok(!a1.includes('前'), a1);
}));

test('§9.3.4 暗示：默认不点名；discretion 说可以具体一点（hintSpecific）时写出关于谁（这里的叫法），仍然不含内容', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '你知道阿明最近怎么了吗' });
  const a = plan(core, { text: '阿明私下说在找工作', start: core.now() + H, agent: w.ids.ming });
  const ref = `a${a}`;
  w.candidates = [ref];
  w.texts.set(ref, '阿明私下说在找工作');
  w.verdicts.set(ref, { verdict: 'aware_private', hintOk: true, hintSpecific: false });
  let out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assertGated(core, out);
  let hint = out.items.find((i) => i.id === ref);
  assert.equal(hint.layer, 'awarePrivate');
  assert.ok(!hint.rendered.includes('阿明') && !hint.rendered.includes('工作'));
  w.verdicts.set(ref, { verdict: 'aware_private', hintOk: true, hintSpecific: true });
  out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  hint = out.items.find((i) => i.id === ref);
  assert.equal(hint.rendered, '你记得阿明的一件和这个话题有关的事，这里不适合提');
  assert.ok(!hint.rendered.includes('工作'), '具体一点也只是关于谁，不给内容');
  // 关于她自己的、找不到主体的：不点名
  w.candidates = ['e9'];
  w.verdicts.set('e9', { verdict: 'aware_private', hintOk: true, hintSpecific: true });
  out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(out.items.find((i) => i.id === 'e9').rendered, '你记得一件和这个话题有关的事，这里不适合提');
}));

test('§9.3.4 暗示具体到谁：只点在场的那一个——告诉她的人在场就说「X 说过的」、不点不在场的主体；主体不在、告诉她的人也不在就不点名', () => withWorld(async ({ core, w }) => {
  // 阿明私下告诉过她小红的事；现在阿明在群里问，小红不在
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '你知道小红最近怎么了吗' });
  const a = plan(core, { text: '小红在找工作', start: core.now() + H, agent: w.ids.hong });
  core.store.run(`INSERT INTO sources(owner_kind, owner_id, speaker, asserter, mode, at) VALUES ('assertion', ?, ?, ?, 'told_to_her', ?)`,
    a, w.ids.ming, w.ids.ming, core.now() - H);
  const ref = `a${a}`;
  w.candidates = [ref];
  w.verdicts.set(ref, { verdict: 'aware_private', hintOk: true, hintSpecific: true });
  let out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assertGated(core, out);
  let hint = out.items.find((i) => i.id === ref).rendered;
  assert.equal(hint, '你记得阿明说过的一件和这个话题有关的事，这里不适合提');
  assert.ok(!hint.includes('小红') && !hint.includes('工作'), '主体不在场：不点她的名，也不给内容');
  // 问的人换成小红（主体本人在场，告诉她的人不在）：可以说是关于她的
  percept(core, w, { sid: GROUP, actor: w.ids.hong, addressed: 'to-her', text: '我最近怎么了' });
  w.present = [w.ids.hong];
  out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  hint = out.items.find((i) => i.id === ref).rendered;
  assert.equal(hint, '你记得小红的一件和这个话题有关的事，这里不适合提');
  // discretion 说可以具体，但这一轮的在场名单里两个人都没有：不点名
  percept(core, w, { sid: GROUP, actor: w.ids.owner, addressed: 'to-her', text: '怎么了' });
  w.present = [w.ids.owner];
  out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(out.items.find((i) => i.id === ref).rendered, '你记得一件和这个话题有关的事，这里不适合提');
}));

test('§12.4.5 第 8 步：retrieve 给的「补不回的空白」（fok + blank）照常过关口①、进想起来的那一层，不带「讲过了」附注', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '上周我们聊了啥' });
  const blank = { from: core.now() - 3 * 24 * H, to: core.now() - 24 * H, settingKey: w.key(GROUP), here: true };
  w.candidates = [{ ref: 'p1', fok: true, blank }];
  w.texts.set('p1', '（在这里，那几天有些事你记不太清了）');
  w.verdicts.set('p1', { verdict: 'share', told: { at: core.now() - 2 * H, level: 'full' } });
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assertGated(core, out);
  const it = out.items.find((i) => i.id === 'p1');
  assert.ok(it, JSON.stringify(out.items));
  assert.equal(it.layer, 'recalled');
  assert.equal(it.rendered, '（在这里，那几天有些事你记不太清了）');
  assert.ok(w.calls.render.some((r) => r.ref === 'p1' && r.settingKey === w.key(GROUP)));
}));

test('§12.4.5 整体恢复期间：不注入新回想（空层，degradeLevel 4），常驻区给冻结的文本、不重新渲染；算到一半开始恢复的这一轮也不给', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = ['a1'];
  ctx.resident(core, GROUP);
  await settle();
  const frozen = ctx.resident(core, GROUP);
  w.restoring = true;
  const before = w.calls.retrieve.length;
  let out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(out.items, []);
  assert.equal(out.degradeLevel, 4);
  assert.equal(w.calls.retrieve.length, before, '恢复期间不回想');
  assert.deepEqual(ctx.recallCached(core, sit(GROUP)).items, []);
  assert.equal(ctx.recallCached(core, sit(GROUP)).degradeLevel, 4);
  ctx.markResidentDirty(core, w.key(GROUP));
  const gates = w.calls.gate.length;
  await ctx.refreshResident(core, w.key(GROUP));
  assert.equal(w.calls.gate.length, gates, '不重新渲染');
  assert.equal(ctx.resident(core, GROUP).version, frozen.version, '冻结的文本照给');
  // 算到一半开始恢复（关口①判着判着，管理页点了整体恢复）：这一轮不给，也不进缓存
  w.restoring = false;
  core.state.context.cache.clear();
  const gate0 = w.calls.gate.length;
  let flip = true;
  w.verdicts.set('a1', () => { if (flip) w.restoring = true; return 'share'; });
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.ok(w.calls.gate.length > gate0, '确实算到了关口①');
  assert.deepEqual(out.items, []);
  assert.equal(out.degradeLevel, 4);
  assert.equal(core.state.context.cache.size, 0);
  // isRestoring 查不了：当没在恢复（和 api 层一致）
  w.restoring = false;
  flip = false;
  w.throws['backup.isRestoring'] = true;
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(ids(out, 'recalled'), ['a1']);
}));
