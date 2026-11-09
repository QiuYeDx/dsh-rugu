// dynamics 牵头的场景（docs/实现/模块与接口.md §4.14：S3、S5、S7b、S22；期望照设计 §14.3 原文）。
// 都走真实的写入路径：attentionClass → encodingWeight → addTrace（来源窗口照常生效），回想走 activate / sample（带种子噪声）。
// 别的模块的部分（提炼给的 imp / t50、实体扩散给的 S）在这里直接给数值：dynamics 只负责「拿到这些量以后想不想得起、说成什么时态」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { refOf } from '../../src/store/refs.js';
import { withCore, insertEntity, insertAssertion, askedP, H, D, M, T0 } from './helpers.js';

const a = (id) => ({ kind: 'assertion', id });
const n = (id) => ({ kind: 'entity', id });

/** 一条感知的编码强度（§6.2），和 intake / encode 算的一样。 */
function weightOf(core, { kind = 'utterance', addressed, attention = 'attended', herSpokeRecently = false, ...f }) {
  const dyn = core.mods.dynamics;
  const { wAtt } = dyn.attentionClass(core, { kind, addressed, attention }, { herSpokeRecently });
  return dyn.encodingWeight(core, { wAtt, ...f });
}

/**
 * 同一个问题在 n 个不同的回合里被问到（种子 = 回合），有多少次想得起来：sample 的抽样频率，应该接近 P。
 * @returns {number}
 */
function recallRate(core, ref, at, S, { mode = 'deliberate', turns = 400 } = {}) {
  const dyn = core.mods.dynamics;
  let hit = 0;
  for (let i = 0; i < turns; i++) {
    const seed = ['会话', `回合${i}`];
    const scored = dyn.activate(core, [{ candidate: { ref: refOf(ref.kind, ref.id), mref: ref, ranks: {}, rrf: 0, signals: {} }, S, C: 0, superseded: false }],
      { at, mode, seed });
    if (dyn.sample(core, scored, { mode, seed }).length) hit += 1;
  }
  return hit / turns;
}

test('S3：「等下去拿快递」→ 两小时后「拿到了」→ 60 天后问「快递拿了没」：多数能答，但不是必然（§6）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const owner = insertEntity(core, { closeness: 1, authority: 'principal' });
  const said = T0 + 18 * H;                 // 本地 18:00，私聊里对她说的
  const done = said + 2 * H;
  // 拿快递是琐事：提炼器按内容给 imp = 4（不是代码按类别给的）
  const w = weightOf(core, { addressed: 'to-her', closeness: 1, imp: 4 });
  const plan = insertAssertion(core, { text: '主人要去拿快递', at: said, valid_from: said, t50_h: 2, shape: 1 });
  const outcome = insertAssertion(core, { text: '主人拿到了快递', at: done, valid_from: done });
  assert.equal(dyn.addTrace(core, a(plan), { t: said, w, sourceKey: `p${owner}`, reason: 'encode' }).added, true);
  assert.equal(dyn.addTrace(core, a(outcome), { t: done, w, sourceKey: `p${owner}`, reason: 'encode' }).added, true);
  // 「拿到了」对账成同一次计划：又遇到了一次，但和上一条在同一个 6 小时格里，不再加（防刷屏的来源窗口）
  assert.deepEqual(dyn.addTrace(core, a(plan), { t: done, w, sourceKey: `p${owner}x`, reason: 'mention' }), { added: false, why: 'memory-window' });
  // 计划结案：成立概率归零（说成过去时），可及性不受影响
  core.store.run('UPDATE assertions SET valid_to_known = ?, plan_status = ? WHERE id = ?', done, 'done', plan);

  const ask = said + 60 * D;
  const S = 1.0;                             // 「快递拿了没」直接命中（§6.7 的线索强度口径）
  const pOutcome = askedP(core, a(outcome), ask, S);
  const pPlan = askedP(core, a(plan), ask, S);
  // 多数能答（§14.3：期望区间按调参后定，例如 0.6–0.8）；不是 1：她也会有想不起来的时候
  for (const [what, p] of [['拿到了', pOutcome], ['要去拿', pPlan]]) {
    assert.ok(p >= 0.6 && p <= 0.95, `${what}：P = ${p.toFixed(3)}`);
  }
  // 按回合抽样（种子 = 会话 + 回合）：命中的频率接近 P，同一回合可复现
  const rate = recallRate(core, a(outcome), ask, S);
  assert.ok(Math.abs(rate - pOutcome) < 0.07, `抽样 ${rate} vs P ${pOutcome}`);
  assert.equal(recallRate(core, a(outcome), ask, S, { turns: 50 }), recallRate(core, a(outcome), ask, S, { turns: 50 }));
  // 时态：结案的计划是过去时（「那天晚上说拿到的」）；「拿到了」这件事本身没有 t50，一直成立
  const row = (id) => core.store.get('SELECT valid_from, valid_to_known, t50_h, shape, change_known, recorded_at FROM assertions WHERE id = ?', id);
  assert.equal(dyn.tense(core, dyn.pHold(core, row(plan), ask)), 'past');
  assert.equal(dyn.tense(core, dyn.pHold(core, row(outcome), ask)), 'present');
  // 拿到之后不会再主动提醒（S1 的 dynamics 部分）：指向它的意图 obsolete，完成后短暂抑制，而不是加成
  const it = { state: 'obsolete', suppressed_at: done };
  assert.ok(dyn.intentionBias(core, it, { at: done + 10 * M, cueHit: true }) < -0.5);
  assert.ok(dyn.intentionBias(core, it, { at: ask, cueHit: true }) > -0.01 && dyn.intentionBias(core, it, { at: ask, cueHit: true }) <= 0);
}));

test('S5（含 S4）：主人在群里说「今晚加班」（她没被叫醒）→ 两分钟后现在时；第二天私聊是过去时，而且仍然想得起（§5.4）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  insertEntity(core, { closeness: 1, authority: 'principal' });
  const said = T0 + 20 * H + 15 * M;         // 本地 20:15
  // 旁听（peripheral）× 关系最亲：在场即感知，注意力决定强度（§6.2 P6）
  const { cls } = dyn.attentionClass(core, { kind: 'utterance', addressed: 'ambient', attention: 'peripheral' }, { herSpokeRecently: false });
  assert.equal(cls, 'peripheral');
  const w = weightOf(core, { addressed: 'ambient', attention: 'peripheral', closeness: 1 });
  // 提炼器按语境给的 t50 ≈ 5 小时、衰减快（shape 2）：§6.7「今晚加班」的那条曲线
  const id = insertAssertion(core, { text: '主人今晚加班', at: said, valid_from: said, t50_h: 5, shape: 2 });
  dyn.addTrace(core, a(id), { t: said, w, sourceKey: 'g', reason: 'encode' });
  const fact = () => core.store.get('SELECT valid_from, valid_to_known, t50_h, shape, change_known, recorded_at FROM assertions WHERE id = ?', id);

  // S4：两分钟后私聊——现在时（「听你在群里说今晚加班」），而且想得起（主人本人就是强线索）
  const soon = said + 2 * M;
  assert.equal(dyn.tense(core, dyn.pHold(core, fact(), soon)), 'present');
  assert.ok(askedP(core, a(id), soon) > 0.95);
  // 四小时后：带不确定（「他之前说在加班，现在不知道」）
  assert.equal(dyn.tense(core, dyn.pHold(core, fact(), said + 4 * H)), 'uncertain');
  // S5：第二天中午私聊——过去时（「昨晚加班到挺晚吧」），可及性照样高：两条曲线互不相干
  const next = T0 + D + 12 * H;
  assert.equal(dyn.tense(core, dyn.pHold(core, fact(), next)), 'past');
  const p = askedP(core, a(id), next);
  assert.ok(p > 0.9, `第二天被问到想得起的概率 ${p}`);
  // 有效性的字段不影响可及性：把 t50 改成「几年」，激活一点不变
  const before = dyn.baseActivation(core, a(id), next);
  core.store.run('UPDATE assertions SET t50_h = 20000 WHERE id = ?', id);
  assert.equal(dyn.baseActivation(core, a(id), next), before);
  assert.equal(dyn.tense(core, dyn.pHold(core, fact(), next)), 'present');
}));

test('S7b：旁听到「我表哥开网约车」，后来群友又提过一次表哥 → 一个月后多数能答；答不上时也知道「好像听你提过」（§6.4、§6.6）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const friend = insertEntity(core, { closeness: 0.3 });
  const cousin = insertEntity(core, { kind: 'person', at: T0 });
  const mon = T0 + 21 * H;                   // 周一晚上，群里，她没被叫醒
  const wed = mon + 2 * D;
  // 社交信息（熟人的亲友）w_self 从 1.2 起；听说不打折（评审:UV-01）：encodingWeight 根本没有这个参数
  const w = weightOf(core, { addressed: 'ambient', attention: 'peripheral', selfRelevance: core.config.get().activation.selfRelevance.social, closeness: 0.3 });
  const job = insertAssertion(core, { text: '群友的表哥开网约车', at: mon });
  dyn.addTrace(core, a(job), { t: mon, w, sourceKey: `p${friend}`, reason: 'encode' });
  // 档案（表哥这个人）：周一被提到、周三又被提到——加在实体档案上（§6.4「某个人或物又被提到」）
  assert.equal(dyn.addTrace(core, n(cousin), { t: mon, w, sourceKey: `p${friend}`, reason: 'mention' }).added, true);
  assert.equal(dyn.addTrace(core, n(cousin), { t: wed, w, sourceKey: `p${friend}`, reason: 'mention' }).added, true);

  const ask = mon + 30 * D;                  // 一个月后：「我表哥干啥的你还记得吗」
  // 问题直接认出了表哥（关系路径）：关于他的每条记忆加扇出项 S_max − ln(fan)，档案下 3 条事实
  const S = 1.0 + dyn.fanTerm(core, 3);
  const pJob = askedP(core, a(job), ask, S);
  assert.ok(pJob > 0.5, `事实：P = ${pJob.toFixed(3)}（多数能答）`);
  assert.ok(pJob < 0.95, '旁听来的事不是必然想得起');
  // 人本身（档案）被直接点名，扩散分取满 S_max，而且有两次提到：比那条事实更容易想起——答不上细节时，知道「好像听你提过」
  const pCousin = askedP(core, n(cousin), ask, core.config.get().activation.fanSMax);
  assert.ok(pCousin > pJob && pCousin > 0.85, `档案：P = ${pCousin.toFixed(3)}`);
  // 按回合抽样：两样都想不起（会装作没听过）的回合很少
  let neither = 0;
  let jobHits = 0;
  for (let i = 0; i < 400; i++) {
    const seed = ['会话', `回合${i}`];
    const sc = dyn.activate(core, [
      { candidate: { ref: refOf('assertion', job), mref: a(job), ranks: {}, rrf: 0, signals: {} }, S, C: 0, superseded: false },
      { candidate: { ref: refOf('entity', cousin), mref: n(cousin), ranks: {}, rrf: 0, signals: {} }, S: core.config.get().activation.fanSMax, C: 0, superseded: false },
    ], { at: ask, mode: 'deliberate', seed });
    const got = new Set(dyn.sample(core, sc, { mode: 'deliberate', seed }).map((c) => c.ref));
    if (got.has(refOf('assertion', job))) jobHits += 1;
    if (!got.size) neither += 1;
  }
  assert.ok(jobHits / 400 > 0.5, `事实被想起的回合 ${jobHits}/400`);
  assert.ok(neither / 400 < 0.1, `两样都想不起的回合 ${neither}/400`);

  // 周三那次如果对账成「又说了同一件事」（加在事实上）：和 §6.7「旁听，档案被提到两次，加扇出项」那一行一致（30 天 0.87）
  const job2 = insertAssertion(core, { text: '群友的表哥开网约车（又说了一次）', at: mon });
  dyn.addTrace(core, a(job2), { t: mon, w, sourceKey: `p${friend}`, reason: 'encode' });
  dyn.addTrace(core, a(job2), { t: wed, w, sourceKey: `p${friend}`, reason: 'mention' });
  const p2 = askedP(core, a(job2), ask, S);
  assert.ok(Math.abs(p2 - 0.87) <= 0.03, `两次 + 扇出：${p2.toFixed(3)}`);
}));

test('S22：一小时里刷屏十遍 vs 隔几天提一次：前者很快淡忘，后者记得牢（§6.3、§6.4）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const start = T0 + 9 * H;                  // 本地 09:00
  const w = weightOf(core, { addressed: 'ambient', attention: 'attended', closeness: 0.3 });
  const spam = insertAssertion(core, { text: '刷屏的那件事', at: start });
  const spaced = insertAssertion(core, { text: '隔几天提一次的那件事', at: start });
  // 刷屏：一小时内十遍，好几个人轮着说
  const res = [];
  for (let i = 0; i < 10; i++) res.push(dyn.addTrace(core, a(spam), { t: start + i * 6 * M, w, sourceKey: `p${i % 3}`, reason: i ? 'mention' : 'encode' }).added);
  assert.deepEqual(res, [true, ...Array(9).fill(false)], '同一条记忆 6 小时内只算一次');
  // 隔几天提一次：第 0、3、6、9 天
  for (const d of [0, 3, 6, 9]) assert.equal(dyn.addTrace(core, a(spaced), { t: start + d * D, w, sourceKey: 'p0', reason: d ? 'mention' : 'encode' }).added, true);
  assert.equal(core.store.get('SELECT trace_count AS n FROM activation WHERE owner_kind = ? AND owner_id = ?', 'assertion', spam).n, 1);
  assert.equal(core.store.get('SELECT trace_count AS n FROM activation WHERE owner_kind = ? AND owner_id = ?', 'assertion', spaced).n, 4);

  for (const days of [30, 90]) {
    const at = start + days * D;
    const ps = askedP(core, a(spam), at);
    const pd = askedP(core, a(spaced), at);
    assert.ok(pd - ps > 0.25, `${days} 天：隔开 ${pd.toFixed(3)} vs 刷屏 ${ps.toFixed(3)}`);
  }
  assert.ok(askedP(core, a(spam), start + 90 * D) < 0.5, '刷屏的事三个月后多半想不起');
  assert.ok(askedP(core, a(spaced), start + 90 * D) > 0.8, '隔开提的事三个月后还记得');
  // 没有线索时：刷屏的事一周后就不会无端想起
  assert.ok(dyn.pRecall(dyn.baseActivation(core, a(spam), start + 7 * D), core.config.get().activation.tauInvoluntary, core.config.get().activation.s) < 0.05);

  // 就算十遍都算数（不经来源窗口），集中重复也事倍功半：衰减率顶到上限
  const P = { ...core.config.get().activation, ageFloorMin: 3, timeUnitMs: H };
  const massed = dyn.stateFromEvents(Array.from({ length: 10 }, (_, i) => ({ t: i * 6 * M, w })), P);
  const spread = dyn.stateFromEvents([0, 3, 6, 9].map((d) => ({ t: d * D, w })), P);
  assert.ok(massed.traces.slice(2).every((t) => t.d === P.dMax));
  assert.ok(dyn.baseActivationOf(spread, 90 * D, P) > dyn.baseActivationOf(massed, 90 * D, P), '四次隔开胜过十次集中');
}));

test('S8c：阿明说「我表哥换工作了」→ 旧的「职业」标 change_known：成立概率 × 据说已变系数，说成「之前……听说换了」；没变的「所在城市」不受影响；想不想得起不受影响（§5.4、§6.1）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const said = T0 + 20 * H;
  // 表哥的两条稳定属性（没有 t50：不随时间衰减）
  const job = insertAssertion(core, { text: '表哥是开网约车的', at: said });
  const city = insertAssertion(core, { text: '表哥住在杭州', at: said });
  for (const id of [job, city]) dyn.addTrace(core, a(id), { t: said, w: 1, sourceKey: 'ming', reason: 'encode' });
  const row = (id) => core.store.get('SELECT valid_from, valid_to_known, t50_h, shape, change_known, recorded_at FROM assertions WHERE id = ?', id);
  const later = said + 3 * D;
  assert.equal(dyn.pHold(core, row(job), later), 1);
  assert.equal(dyn.tense(core, dyn.pHold(core, row(job), later)), 'present');
  const before = askedP(core, a(job), later + D);

  // 一周后「我表哥换工作了」：encode 标 change_known，不取代（新值未知）
  core.store.run('UPDATE assertions SET change_known = 1 WHERE id = ?', job);
  const f = core.config.get().validity.changeKnownFactor;
  const p = dyn.pHold(core, row(job), later + D);
  assert.equal(p, f, '稳定属性：成立概率就是「据说已变」的系数');
  assert.notEqual(dyn.tense(core, p), 'present', '不再当作现在时说');
  assert.equal(dyn.pHold(core, row(city), later + D), 1, '没变的属性不受影响');
  assert.equal(dyn.tense(core, dyn.pHold(core, row(city), later + D)), 'present');
  // 会衰减的事实：在原来的衰减上再乘系数
  const shift = insertAssertion(core, { text: '表哥这周上夜班', at: said, t50_h: 72, shape: 1, change_known: 1 });
  const decayed = Math.pow(2, -(later - said) / (72 * H));
  assert.ok(Math.abs(dyn.pHold(core, row(shift), later) - decayed * f) < 1e-12);
  // 有效性和可及性互不影响：标了 change_known，想不想得起一点没变
  assert.equal(askedP(core, a(job), later + D), before);
  // 系数热加载
  core.config.update({ validity: { changeKnownFactor: 0.5 } });
  assert.equal(dyn.pHold(core, row(job), later + D), 0.5);
}));
