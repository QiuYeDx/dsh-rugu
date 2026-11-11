// recall() / recallCached()（§3「读」、§10.4、§9.3.4–§9.3.6、§6.6）：召回 → 目标 → 关口① → 分层 → 渲染 → 去掉已发过的 → 按预算打包。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecallLayers } from '../../src/contract/index.js';
import {
  withWorld, percept, episode, rawWindow, storyline, impression, entityName, intention, dueRow, entity,
  GROUP, DM, DM2, OTHER, ADAPTER, H, D, M,
} from './world.js';
import { budgetState, loadSession } from '../../src/context/ledger.js';

const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };
const DELIB = { mode: 'deliberate', deadlineMs: 3000, budgetChars: 900 };
const sit = (sid, o = {}) => ({ settingId: sid, trigger: 'message', ...o });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const ids = (out, layer) => out.items.filter((i) => !layer || i.layer === layer).map((i) => i.id);

/** §9.3.6：返回的每一条都过契约校验，而且对得上一条判定记录（集成层拿去 recordInjection 不会被拒）。 */
function assertGated(core, out) {
  const v = validateRecallLayers(out);
  assert.ok(v.ok, JSON.stringify(v.errors));
  for (const it of out.items) {
    const row = core.store.get('SELECT memory_kind, memory_id, verdict FROM appraisals WHERE id = ?', Number(it.appraisalRef.slice(2)));
    assert.ok(row, `${it.id} 的判定记录不在`);
    assert.equal(row.verdict, it.verdict);
  }
}
/** 把这一块当真注入并确认（集成层：injected → 会话事件里看到 nonce → confirm）。 */
function deliver(core, sessionId, out, nonce = `n-${Math.random().toString(36).slice(2)}`) {
  core.mods.context.recordInjection(core, {
    sessionId, nonce, layer: 'block', items: out.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })),
    chars: out.items.reduce((n, i) => n + i.rendered.length, 0), mode: 'live',
  });
  core.mods.context.confirmInjection(core, sessionId, nonce);
  return nonce;
}

test('关口①的四种结论：能说的给内容，说个大概的给含糊版本，心里有数的给一行不含内容的暗示，omit 的不出现；每条都有判定记录', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '你还记得上次团建吗' });
  w.candidates = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
  w.texts.set('a1', '上次团建去了湖边').set('a3', '阿明私下说他在找工作').set('a4', '小红的秘密');
  w.verdicts.set('a2', { verdict: 'share_vague', vagueText: '有人提过最近工作不太好找' })
    .set('a3', { verdict: 'aware_private', hintOk: true }).set('a4', { verdict: 'aware_private', hintOk: false })
    .set('a5', 'omit').set('a6', 'pending');
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assertGated(core, out);
  assert.deepEqual(ids(out, 'recalled').sort(), ['a1', 'a2']);
  assert.equal(out.items.find((i) => i.id === 'a1').rendered, '上次团建去了湖边');
  assert.equal(out.items.find((i) => i.id === 'a2').rendered, '有人提过最近工作不太好找');
  const hint = out.items.filter((i) => i.layer === 'awarePrivate');
  assert.deepEqual(hint.map((i) => i.id), ['a3']);
  assert.ok(!hint[0].rendered.includes('阿明') && !hint[0].rendered.includes('工作'), '暗示不含内容、不点名');
  assert.ok(!out.items.some((i) => ['a4', 'a5', 'a6'].includes(i.id)), '不能暗示的、omit 的、不自主回想里没判完的都不给');
  assert.equal(out.degradeLevel, 0);
  assert.ok(out.traceId);
  // 判定的目标就是这个场合，触发者是说话的人
  assert.equal(w.calls.targetFor.at(-1).settingKey, w.key(GROUP));
  assert.equal(w.calls.targetFor.at(-1).triggerEntityId, w.ids.ming);
  assert.equal(w.calls.targetFor.at(-1).settingId, GROUP);
}));

test('有意回想：还没判完的先给一行不含内容的暂定提示（只给一行）；对她说的话看起来在问过去，就切到有意回想（拿不准也切）', () => withWorld(async ({ core, w }) => {
  w.candidates = ['a1', 'a2', 'a3'];
  w.verdicts.set('a1', 'pending').set('a2', 'pending');
  let out = await core.mods.context.recall(core, sit(GROUP), DELIB);
  assertGated(core, out);
  const pend = out.items.filter((i) => i.verdict === 'pending');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].layer, 'recalled');
  assert.ok(!pend[0].rendered.includes('记忆'));
  assert.deepEqual(ids(out).filter((x) => x === 'a3'), ['a3']);
  // 看起来在问过去 → τ_del、可以等到 3 秒
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '快递拿了没' });
  w.past = true;
  out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(w.calls.retrieve.at(-1).o.mode, 'deliberate');
  assert.equal(w.calls.gate.at(-1).mode, 'deliberate');
  assert.equal(out.items.filter((i) => i.verdict === 'pending').length, 1);
  // 判别出错：从宽，也切（评审:SC-22）
  w.past = false;
  w.throws['retrieve.looksLikePast'] = true;
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(w.calls.retrieve.at(-1).o.mode, 'deliberate');
  // 旁听的消息不切
  w.throws['retrieve.looksLikePast'] = false;
  w.past = true;
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'ambient', text: '快递拿了没' });
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(w.calls.retrieve.at(-1).o.mode, 'involuntary');
}));

test('本周期已确认发过的不再发；没确认的块回合中止后丢弃，下次照常可以发；压缩以后又可以发', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = ['a1', 'a2'];
  let out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  deliver(core, 's1', out);
  w.candidates = ['a1', 'a2', 'a3'];
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out, 'recalled'), ['a3']);
  // 记了但没确认（回合中止）：下一轮之前它还占着名额；中止以后又可以发
  ctx.recordInjection(core, { sessionId: 's1', nonce: 'n-x', layer: 'block', items: out.items.map(({ id, layer, verdict, appraisalRef }) => ({ id, layer, verdict, appraisalRef })), chars: 10, mode: 'live' });
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL), 'recalled'), []);
  ctx.abortPending(core, 's1');
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL), 'recalled'), ['a3']);
  ctx.compaction(core, 's1', 'end');
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL), 'recalled').sort(), ['a1', 'a2', 'a3']);
  // 没有会话 id 的调用方：不去重
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP), INVOL), 'recalled').sort(), ['a1', 'a2', 'a3']);
  // 有意回想：有关的都给过了 → 不给内容，但告诉集成层「给过了几条」（D95：她别说成不记得）；不自主回想不带这个字段
  deliver(core, 's1', await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL));
  const again = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), DELIB);
  assert.deepEqual(ids(again, 'recalled'), []);
  assert.equal(again.alreadySent, 3);
  assert.equal('alreadySent' in (await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL)), false);
}));

test('几乎一样的两段（retrieve 的 MMR 合并成一条，Candidate.duplicates）：上一轮发的是一段，这一轮另一段当代表也不再发', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.texts.set('e1', '阿明说他表哥换了新车').set('e2', '阿明说他表哥换了新车。');
  w.candidates = [{ ref: 'e1', duplicates: ['e2'] }, 'a3'];
  const first = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(first, 'recalled').sort(), ['a3', 'e1']);
  deliver(core, 's1', first);
  // 这一轮 e2 分高、当了代表（e1 合并进它）：e1 本周期发过了，e2 不再当新鲜事给
  w.candidates = [{ ref: 'e2', duplicates: ['e1'] }, 'a4'];
  const second = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assertGated(core, second);
  assert.deepEqual(ids(second, 'recalled'), ['a4']);
  // 压缩以后又可以发
  ctx.compaction(core, 's1', 'end');
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL), 'recalled').sort(), ['a4', 'e2']);
}));

test('隐藏 / 忘掉的不渲染；admin 查不了就一条都不给；场合关着（off）什么都不给，影子模式照常给', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  w.candidates = ['a1', 'a2'];
  w.hidden.add('a2');
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP), INVOL)), ['a1']);
  w.throws['admin.suppressedRefs'] = true;
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP), INVOL)), []);
  w.throws['admin.suppressedRefs'] = false;
  w.mode = 'off';
  const before = w.calls.gate.length + w.calls.retrieve.length;
  const off = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(off.items, []);
  assert.equal(w.calls.gate.length + w.calls.retrieve.length, before, 'off 的场合不召回、不去判');
  w.mode = 'shadow';
  assert.deepEqual(ids(await ctx.recall(core, sit(GROUP), INVOL)), ['a1']);
  // 不认识的场合
  assert.deepEqual((await ctx.recall(core, sit('room-nowhere'), INVOL)).items, []);
}));

test('依赖出错只降级、不抛错：召回挂了照样给本模块的层；判不了（目标、关口①出错）一条都不给；渲染挂了丢那一条', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  const sl = storyline(core, w, { sid: GROUP });
  w.texts.set(`s${sl}`, '这个群最近在聊团建');
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  w.candidates = ['a1'];
  w.throws['retrieve.recall'] = true;
  w.degrade = 3;
  let out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assertGated(core, out);
  // 新会话的暖启动、在场人物卡（从最近亲自发过言的人推）都不靠召回
  assert.deepEqual(ids(out).sort(), [`n${w.ids.ming}`, `s${sl}`].sort());
  assert.equal(out.degradeLevel, 3);
  w.throws['retrieve.recall'] = false;
  for (const k of ['discretion.gate', 'discretion.targetFor']) {
    w.throws[k] = true;
    out = await ctx.recall(core, sit(GROUP), INVOL);
    assert.deepEqual(out.items, [], k);
    assert.ok(validateRecallLayers(out).ok);
    w.throws[k] = false;
  }
  w.throws['retrieve.render'] = true;
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(ids(out, 'recalled'), [], '渲染挂了：那一条不给');
  assert.deepEqual(ids(out, 'people'), [`n${w.ids.ming}`], '卡头是本模块自己渲染的');
  assertGated(core, out);
  w.throws['intake.resolveSetting'] = true;
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(out.items, []);
  assert.ok(validateRecallLayers(out).ok);
}));

test('在场人物卡：本周期第一次出现的人；称呼用这个场合的名字（冒用的名片不用）；关系、认识多久；印象选能通过评估的那层；发过就不再发', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  const cousin = entity(core, { name: null, at: core.now() - 40 * D });
  core.store.run(`INSERT INTO entity_descriptors(entity_id, anchor_entity_id, relation, text, basis, speaker_entity_id, first_at, last_at, created_at)
    VALUES (?, ?, 'biaoge', '表哥', 'first-person', ?, ?, ?, ?)`, cousin, w.ids.ming, w.ids.ming, core.now(), core.now(), core.now());
  core.store.run('UPDATE entities SET first_mention_at = ? WHERE id = ?', core.now() - 60 * D, w.ids.ming);
  entityName(core, w.ids.ming, '明哥', { scope: w.key(GROUP), count: 5 });
  entityName(core, w.ids.ming, '小秋', { scope: w.key(GROUP), count: 50, spoof: 1 });   // 名片冒用主人的称呼
  entityName(core, w.ids.ming, '阿明在别的群', { scope: w.key(OTHER), count: 99 });
  const shared = impression(core, w.ids.ming, { layer: 'shared', text: '爱玩梗' });
  const priv = impression(core, w.ids.ming, { layer: 'private', text: '私下说过在找工作' });
  w.texts.set(`i${shared}`, '爱玩梗').set(`i${priv}`, '私下说过在找工作');
  w.verdicts.set(`i${priv}`, 'omit');
  w.present = [w.ids.self, w.ids.ming, cousin];
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '在吗' });
  clock.minutes(1);
  let out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assertGated(core, out);
  const people = out.items.filter((i) => i.layer === 'people');
  const card = people.find((i) => i.id === `n${w.ids.ming}`);
  assert.ok(card.rendered.startsWith('明哥'), card.rendered);
  assert.ok(!card.rendered.includes('小秋') && !card.rendered.includes('别的群'));
  assert.ok(card.rendered.includes('认识 '));
  assert.ok(people.some((i) => i.id === `i${shared}` && i.rendered.includes('爱玩梗')));
  assert.ok(!people.some((i) => i.id === `i${priv}`));
  const cc = people.find((i) => i.id === `n${cousin}`);
  assert.ok(cc.rendered.includes('明哥的表哥'), cc.rendered);
  assert.ok(cc.rendered.includes('你没见过，是听明哥说的') && !cc.rendered.includes('认识'), '只在别人话里出现过的人：说清楚是听谁说的');
  assert.ok(people.every((i) => Array.from(i.rendered).length <= core.config.get().context.layers.peopleCardChars));
  assert.ok(!people.some((i) => i.id === `n${w.ids.self}`), '她自己没有人物卡');
  deliver(core, 's1', out);
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out, 'people'), []);
  // 卡头不能说：整张卡（含印象）都不出现
  ctx.compaction(core, 's1', 'end');
  w.verdicts.set(`n${w.ids.ming}`, 'omit');
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.ok(!ids(out, 'people').includes(`i${shared}`));
}));

test('你想着的：到期的意图浮上来前先复核；意图和它指向的事实都要过关口①；每块最多 1 条；没过关口的记一笔分寸日志', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  const fact = core.store.run(`INSERT INTO assertions(predicate, text, certainty, recorded_at, created_at, updated_at) VALUES ('p', '阿明在考驾照', 'stated', ?, ?, ?)`,
    core.now(), core.now(), core.now()).lastInsertRowid;
  const t1 = intention(core, { target: w.ids.ming, aboutKind: 'assertion', aboutId: Number(fact), text: '问问阿明驾照考得怎样' });
  const t2 = intention(core, { target: w.ids.ming, text: '跟阿明说声生日快乐' });
  w.texts.set(`t${t1}`, '问问阿明驾照考得怎样').set(`a${fact}`, '阿明在考驾照（他上周在私聊里说的）').set(`t${t2}`, '跟阿明说声生日快乐');
  w.due = [dueRow(core, t1, true)];
  percept(core, w, { sid: DM2, actor: w.ids.ming, addressed: 'to-her', text: '在吗' });
  let out = await ctx.recall(core, sit(DM2), INVOL);
  assertGated(core, out);
  assert.deepEqual(ids(out, 'intentions'), [`t${t1}`, `a${fact}`]);
  assert.deepEqual(w.calls.recheck, [t1]);
  // 两条都到期：按激活（I 项 + 种子噪声）挑一条，每块最多 1 条
  w.due = [dueRow(core, t1, true), dueRow(core, t2)];
  out = await ctx.recall(core, sit(DM2), INVOL);
  assert.equal(out.items.filter((i) => i.id.startsWith('t')).length, 1, '每块最多 1 条');
  // 指向的事实在这里不能说（私聊里说的考驾照，群里不问）：意图本身也先不提
  w.verdicts.set(`a${fact}`, (target) => (target.audience.settingKey === w.key(GROUP) ? 'omit' : 'share'));
  w.due = [dueRow(core, t1, true)];
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '在吗' });
  out = await ctx.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(ids(out, 'intentions'), []);
  assert.ok(w.calls.logDecision.some((e) => e.ref === `t${t1}` && e.kind === 'omit'));
  // 复核发现了完成证据（她旁听到「考过了」）：压住，换下一条（S2b 的 context 部分）
  w.recheck = (id) => ({ suppress: id === t1, perceptIds: [] });
  w.due = [dueRow(core, t1, true), dueRow(core, t2)];
  out = await ctx.recall(core, sit(DM2), INVOL);
  assert.deepEqual(ids(out, 'intentions'), [`t${t2}`]);
  // 复核不了（出错）：这一轮不提
  w.recheck = () => { throw new Error('x'); };
  out = await ctx.recall(core, sit(DM2), INVOL);
  assert.deepEqual(ids(out, 'intentions'), []);
  // 召回里直接冒出来的意图引用不走这条路（必须先复核）
  w.recheck = () => ({ suppress: false, perceptIds: [] });
  w.due = [];
  w.candidates = [`t${t2}`];
  out = await ctx.recall(core, sit(DM2), INVOL);
  assert.deepEqual(ids(out, 'intentions'), []);
  assert.deepEqual(ids(out, 'recalled'), []);
}));

test('暖启动：新会话、压缩结束后的第一条真实消息给故事线、最近的经历、还没封口的对话；重新开始后只给常驻区，等下一次压缩', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  const sl = storyline(core, w, { sid: GROUP });
  const ep = episode(core, w, { sid: GROUP, at: core.now() - 2 * H });
  clock.minutes(30);
  const p1 = percept(core, w, { sid: GROUP, actor: w.ids.ming, text: '还没封口的对话' });
  const win = rawWindow(core, w, { sid: GROUP, first: p1, last: p1 });
  clock.minutes(1);
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '在吗' });
  w.candidates = [`p${p1}`];
  let out = await ctx.recall(core, sit(GROUP, { sessionId: 's1', trigger: 'reminder' }), INVOL);
  assert.deepEqual(ids(out, 'warmStart'), [], '提醒不是真实消息');
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assertGated(core, out);
  assert.deepEqual(ids(out, 'warmStart'), [`s${sl}`, `e${ep}`, `w${win}`]);
  deliver(core, 's1', out);
  assert.equal(ctx.sessionInfo(core, 's1').warmPending, false);
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out, 'warmStart'), []);
  ctx.compaction(core, 's1', 'end');
  assert.equal(ctx.sessionInfo(core, 's1').warmPending, true);
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out, 'warmStart'), [`s${sl}`, `e${ep}`, `w${win}`]);
  // 主人主动重新开始：不给暖启动，也不给重新开始前不久这里的原话（长期记忆照常能想起）
  ctx.compaction(core, 's1', 'restart');
  w.candidates = [`p${p1}`, 'a77'];
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out, 'warmStart'), []);
  assert.deepEqual(ids(out, 'recalled'), ['a77']);
  ctx.compaction(core, 's1', 'end');
  out = await ctx.recall(core, sit(GROUP, { sessionId: 's1' }), INVOL);
  assert.ok(ids(out, 'warmStart').length > 0);
  assert.ok(ids(out, 'recalled').includes(`p${p1}`));
}));

test('今天到目前为止：被直接问到时给她今天在别的场合的小结（S23b 的 context 部分）；召回里冒出来的今天的小结也归这一层', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  const sum = episode(core, w, { sid: GROUP, kind: 'summary', at: core.now() - 10 * M, title: '在游戏群聊显卡涨价' });
  const old = episode(core, w, { sid: GROUP, kind: 'summary', at: core.now() - 3 * D, title: '三天前的小结' });
  const here = episode(core, w, { sid: DM, kind: 'summary', at: core.now() - 20 * M, title: '就在这里聊的' });
  w.texts.set(`e${sum}`, '下午在游戏群和大家聊显卡涨价，我推荐了一款');
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '你刚才在群里跟他们聊啥呢' });
  let out = await ctx.recall(core, sit(DM), DELIB);
  assertGated(core, out);
  assert.deepEqual(ids(out, 'todaySoFar'), [`e${sum}`]);
  assert.ok(!ids(out).includes(`e${old}`) && !ids(out).includes(`e${here}`));
  out = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(out, 'todaySoFar'), []);
  w.candidates = [`e${sum}`];
  out = await ctx.recall(core, sit(DM), INVOL);
  assert.deepEqual(ids(out, 'todaySoFar'), [`e${sum}`]);
}));

test('预算：这个会话今天的额度用完了，只留「你想着的」；有意回想照常给；前台这一轮超了记计数（D133）', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM2, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: DM2, actor: w.ids.ming, addressed: 'to-her' });
  // 今天已经发了 4 万字（主人在「自定义」里设的每天上限；宽松档本身每天不限，D147）
  for (let i = 0; i < 10; i++) {
    const out = { items: [] };
    ctx.recordInjection(core, { sessionId: 's1', nonce: `old-${i}`, layer: 'block', items: out.items, chars: 4000, mode: 'live' });
    ctx.confirmInjection(core, 's1', `old-${i}`);
  }
  const t = intention(core, { target: w.ids.ming });
  w.due = [dueRow(core, t)];
  w.candidates = ['a1'];
  const metric = (name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
  let out = await ctx.recall(core, sit(DM2, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ids(out), [`t${t}`]);
  assert.equal(metric('context.pack.over.day'), 1);
  assert.ok(metric('context.pack.budgetDropped') >= 1, '想起来的那条因为预算没放进去');
  assert.equal(metric('context.pack.over.rolling'), 0);
  out = await ctx.recall(core, sit(DM2, { sessionId: 's1' }), DELIB);
  assert.deepEqual(ids(out).sort(), ['a1', `t${t}`].sort());
  assert.equal(metric('context.pack.over.day'), 2, '有意回想的这一轮也超了（只是想起来的那一档不受限）');
}, { config: { budget: { overrides: { injectPerSessionPerDay: 40_000 } } } }));

test('预算（D147）：宽松档每天不设上限——一个会话今天已经注入了 4 万多字，照常给（只受比例限制）', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM2, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: DM2, actor: w.ids.ming, addressed: 'to-her' });
  for (let i = 0; i < 12; i++) {
    ctx.recordInjection(core, { sessionId: 's1', nonce: `old-${i}`, layer: 'block', items: [], chars: 4000, mode: 'live' });
    ctx.confirmInjection(core, 's1', `old-${i}`);
  }
  const b = budgetState(core, loadSession(core, 's1'), core.now());
  assert.equal(b.dayUsed, 48_000);
  assert.equal(b.dayLimit, Infinity);
  const t = intention(core, { target: w.ids.ming });
  w.due = [dueRow(core, t)];
  w.candidates = ['a1'];
  const metric = (name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
  const out = await ctx.recall(core, sit(DM2, { sessionId: 's1' }), INVOL);
  assert.ok(ids(out).includes('a1') && ids(out).includes(`t${t}`), `想起来的照给（${ids(out)}）`);
  assert.equal(metric('context.pack.over.day'), 0);
}));

test('预算（D133）：节省档的 8000 字用完了照样只留「你想着的」；不设上限档再多也照给', async () => {
  for (const preset of ['saving', 'unlimited']) {
    await withWorld(async ({ core, w }) => {
      const ctx = core.mods.context;
      ctx.bindSession(core, { sessionId: 's1', settingId: DM2, adapterId: ADAPTER, confidence: 'specific' });
      percept(core, w, { sid: DM2, actor: w.ids.ming, addressed: 'to-her' });
      for (let i = 0; i < 10; i++) {
        ctx.recordInjection(core, { sessionId: 's1', nonce: `old-${i}`, layer: 'block', items: [], chars: 800, mode: 'live' });
        ctx.confirmInjection(core, 's1', `old-${i}`);
      }
      const t = intention(core, { target: w.ids.ming });
      w.due = [dueRow(core, t)];
      w.candidates = ['a1'];
      const out = await ctx.recall(core, sit(DM2, { sessionId: 's1' }), INVOL);
      if (preset === 'saving') assert.deepEqual(ids(out), [`t${t}`]);
      else assert.ok(ids(out).includes('a1') && ids(out).includes(`t${t}`), `不限：想起来的照给（${ids(out)}）`);
    }, { config: { budget: { preset } } });
  }
});

test('按轮污点：目标里带着这一轮的污点（关口①据此不给能说，§9.6）', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  w.candidates = ['a1'];
  w.verdicts.set('a1', (target) => (target.taint ? { verdict: 'share_vague', vagueText: '有件事' } : 'share'));
  ctx.markTurnTaint(core, 's1', { tainted: true, reason: 'tool-result', at: core.now() });
  let out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.equal(out.items.find((i) => i.id === 'a1').verdict, 'share_vague');
  ctx.markTurnTaint(core, 's1', { tainted: false, reason: 'principal', at: core.now() });
  out = await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.equal(out.items.find((i) => i.id === 'a1').verdict, 'share');
}));

test('recallCached：同步，只读已经过完关口①的结果；没有就给空的，并在后台判一遍（最新一条是对她说的、预取缓存里有候选时）', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: GROUP, adapterId: ADAPTER, confidence: 'specific' });
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'ambient' });
  w.candidates = ['a1'];
  w.cachedSet = { items: [], cues: {}, degradeLevel: 0, routeMs: {}, traceId: 'x' };
  let out = ctx.recallCached(core, sit(GROUP, { sessionId: 's1' }));
  assert.deepEqual(out.items, []);
  assert.ok(validateRecallLayers(out).ok);
  await settle();
  assert.equal(w.calls.gate.length, 0, '旁听的消息不在后台跑关口①');
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her' });
  assert.deepEqual(ctx.recallCached(core, sit(GROUP, { sessionId: 's1' })).items, []);
  await settle();
  out = ctx.recallCached(core, sit(GROUP, { sessionId: 's1' }));
  assertGated(core, out);
  assert.deepEqual(ids(out, 'recalled'), ['a1']);
  // 发过的不再给；新消息进来缓存就作废
  deliver(core, 's1', out);
  assert.deepEqual(ids(ctx.recallCached(core, sit(GROUP, { sessionId: 's1' })), 'recalled'), []);
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'ambient' });
  assert.deepEqual(ctx.recallCached(core, sit(GROUP, { sessionId: 's1' })).items, []);
  w.throws['intake.resolveSetting'] = true;
  assert.deepEqual(ctx.recallCached(core, sit(GROUP)).items, []);
}));

test('日志里只有 id、类型和计数，没有记忆内容', () => withWorld(async ({ core, w, logger }) => {
  w.candidates = ['a1'];
  w.texts.set('a1', '阿明私下说他失恋了');
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '阿明私下说他失恋了' });
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  w.throws['retrieve.render'] = true;
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  logger.assertNoText('阿明私下说他失恋了', GROUP);
}));


test('交给关口①的顺序：在场者近况和别的想起来的交替排（第二段名额有限，哪一边都不能把它占满），各自内部先后不变', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '5' });
  // 回想按 A 排：前面五条都是近况那一路的（刚说的），后面三条是别的几路的
  w.candidates = [
    ...['p1', 'p2', 'p3', 'p4', 'p5'].map((ref, i) => ({ ref, ranks: { present: i + 1 } })),
    ...['a1', 'a2', 'a3'].map((ref, i) => ({ ref, ranks: { lexical: i + 1 } })),
  ];
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  const refs = w.calls.gate.at(-1).refs.filter((r) => /^[pa]\d$/.test(r));
  assert.deepEqual(refs, ['a1', 'p1', 'a2', 'p2', 'a3', 'p3', 'p4', 'p5']);
}));

test('查询模型正在冷加载（闲了很久以后的第一句话）：这一轮不自主回想等到有意回想的截止时间，模式不变；没在加载、读不到就照常', () => withWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '早' });
  w.candidates = ['a1'];
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(w.calls.retrieve.at(-1).o.deadlineMs <= INVOL.deadlineMs);
  w.warming = true;
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  const o = w.calls.retrieve.at(-1).o;
  assert.equal(o.mode, 'involuntary');
  assert.ok(o.deadlineMs > INVOL.deadlineMs + 1000, `deadlineMs=${o.deadlineMs}`);
  w.throws['worker.queryWarming'] = true;
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(w.calls.retrieve.at(-1).o.deadlineMs <= INVOL.deadlineMs);
}));

test('空闲唤醒（idle，D115）：这一轮没人在对她说话——焦点是这里最近的对话，不退回几个小时前最后一个对她说话的人；没有触发者、外发守护里也没有被回答的人', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 's1', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  // 两个小时前主人一句「好哒」，她回了两句；之后一直没人说话
  percept(core, w, { sid: DM, actor: w.ids.owner, addressed: 'to-her', text: '好哒' });
  clock.minutes(1);
  percept(core, w, { sid: DM, self: true, text: '那你倒是说说午饭吃了没' });
  const last = percept(core, w, { sid: DM, self: true, text: '别告诉我到现在还空着肚子' });
  clock.minutes(120);
  // 原来的口径（message，没有焦点）：退回最后一个对她说话的人 → 主人成了「眼前这个人」
  await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.deepEqual(ctx.sessionInfo(core, 's1').triggerEntityIds, [w.ids.owner]);
  assert.equal(ctx.sessionInfo(core, 's1').selfTurn, false);
  // 她自己开启的一轮：没有触发者，焦点是这里最后一条（她自己刚说的）
  await ctx.recall(core, sit(DM, { sessionId: 's1', trigger: 'idle' }), INVOL);
  const info = ctx.sessionInfo(core, 's1');
  assert.deepEqual(info.triggerEntityIds, [], '主人的旧话不算这一轮在问她');
  assert.equal(info.focusPerceptId, last);
  assert.equal(info.selfTurn, true);
  // 交进来的焦点（focusObsIds）在空闲唤醒里也不算触发者
  await ctx.recall(core, sit(DM, { sessionId: 's1', trigger: 'idle', focusObsIds: ['nope'] }), INVOL);
  assert.deepEqual(ctx.sessionInfo(core, 's1').triggerEntityIds, []);
  // 之后同一个会话里有人真的对她说话（message）：照常认出触发者，不再是 selfTurn
  await ctx.recall(core, sit(DM, { sessionId: 's1' }), INVOL);
  assert.equal(ctx.sessionInfo(core, 's1').selfTurn, false);
}));
