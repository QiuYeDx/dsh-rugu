// 编码强度（§6.2）、回想时的激活和抽样（§6.5、§6.6）、意图项、心境（§5.7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCore, insertIntention, insertPercept, H, D, M, T0 } from './helpers.js';

const cand = (ref) => ({ ref, mref: { kind: { a: 'assertion', e: 'episode', t: 'intention' }[ref[0]], id: Number(ref.slice(1)) }, ranks: {}, rrf: 0, signals: {} });

test('注意力类别和 w_att（§6.2 的表）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const W = core.config.get().activation.attention;
  const cases = [
    [{ kind: 'self-utterance', addressed: 'by-her', attention: 'attended' }, {}, 'self'],
    [{ kind: 'self-action', addressed: 'by-her', attention: 'attended' }, {}, 'self'],
    [{ kind: 'utterance', addressed: 'by-her', attention: 'attended' }, {}, 'self'],
    [{ kind: 'self-thought', addressed: 'by-her', attention: 'attended' }, {}, 'selfThought'],
    [{ kind: 'utterance', addressed: 'to-her', attention: 'peripheral' }, {}, 'toHer'],
    [{ kind: 'utterance', addressed: 'mentions-her', attention: 'attended' }, {}, 'mentionsHer'],
    [{ kind: 'utterance', addressed: 'ambient', attention: 'attended' }, { herSpokeRecently: true }, 'participating'],
    [{ kind: 'utterance', addressed: 'ambient', attention: 'attended' }, { herSpokeRecently: false }, 'attendedAmbient'],
    [{ kind: 'utterance', addressed: 'ambient', attention: 'peripheral' }, { herSpokeRecently: true }, 'peripheral'],
    [{ kind: 'content', addressed: 'ambient', attention: 'peripheral' }, {}, 'contentSkimmed'],
    [{ kind: 'content', addressed: 'ambient', attention: 'peripheral' }, { opened: true }, 'contentOpened'],
    [{ kind: 'content', addressed: 'ambient', attention: 'attended' }, { opened: false }, 'contentSkimmed'],
  ];
  for (const [p, ctx, cls] of cases) assert.deepEqual(dyn.attentionClass(core, p, ctx), { cls, wAtt: W[cls] }, JSON.stringify(p));
  assert.equal(W.self, 1.0); assert.equal(W.peripheral, 0.35); assert.equal(W.contentSkimmed, 0.15);
}));

test('编码强度 w = w_att × w_self × w_sal × w_rel × w_emo；缺的因子按 1；没有给听说打折的参数', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.equal(dyn.encodingWeight(core, { wAtt: 1 }), 1);
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 1, imp: 10 }) - Math.pow(2, 2)) < 1e-12);
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 1, imp: 1 }) - Math.pow(2, -1.6)) < 1e-12);
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 1, closeness: 1 }) - 1.5) < 1e-12);   // 主人只是亲密度最高的那个人
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 1, closeness: 0 }) - 0.8) < 1e-12);
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 1, emotionIntensity: 1 }) - 1.5) < 1e-12);
  assert.equal(dyn.encodingWeight(core, { wAtt: 1, selfRelevance: 5 }), 2);                 // 夹在 1.0–2.0
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 0.35, selfRelevance: 1.2, imp: 5, closeness: 0.3, emotionIntensity: 0 }) - 0.35 * 1.2 * 1.01) < 1e-12);
  assert.equal(dyn.encodingWeight(core, { wAtt: 1, hearsay: true, certainty: 'hearsay' }), 1);
  // 热加载：改了参数下一次就生效
  core.config.update({ activation: { relation: { span: 0.5 } } });
  assert.ok(Math.abs(dyn.encodingWeight(core, { wAtt: 1, closeness: 1 }) - 1.3) < 1e-12);
}));

test('activate：A = B + S + C + I − P_sup + ε；ε 可复现；P 用不含噪声的均值', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  dyn.addTrace(core, { kind: 'assertion', id: 1 }, { t: T0, w: 1, sourceKey: 's', reason: 'encode' });
  const at = T0 + 7 * D;
  const inp = [{ candidate: cand('a1'), S: 0.5, C: 0.25, superseded: false }];
  const [x] = dyn.activate(core, inp, { at, mode: 'involuntary', seed: ['会话', '3'] });
  const [y] = dyn.activate(core, inp, { at, mode: 'involuntary', seed: ['会话', '3'] });
  const [z] = dyn.activate(core, inp, { at, mode: 'involuntary', seed: ['会话', '4'] });
  const B = dyn.baseActivation(core, { kind: 'assertion', id: 1 }, at);
  assert.equal(x.parts.B, B);
  assert.ok(Math.abs(x.A - (B + 0.5 + 0.25 + x.parts.eps)) < 1e-12);
  assert.equal(x.A, y.A);
  assert.notEqual(x.parts.eps, z.parts.eps);
  assert.equal(x.parts.eps, dyn.seededNoise(['会话', '3', 'a1'], 0.4));
  assert.equal(x.P, dyn.pRecall(B + 0.75, 0, 0.4));
  assert.equal(x.ref, 'a1');
  // 关掉噪声：ε = 0
  core.config.update({ activation: { noise: false } });
  const [n] = dyn.activate(core, inp, { at, mode: 'deliberate', seed: ['会话', '3'] });
  assert.equal(n.parts.eps, 0);
  assert.equal(n.P, dyn.pRecall(B + 0.75, -1.6, 0.4));
  // 意图项、取代惩罚
  const t = insertIntention(core, { state: 'armed', at: T0 });
  const [it] = dyn.activate(core, [{ candidate: cand(`t${t}`), S: 0, C: 0, superseded: false, cueHit: true }], { at: T0 + H, mode: 'deliberate', seed: [] });
  assert.equal(it.parts.I, 1.5);
  const [sp] = dyn.activate(core, [{ candidate: cand('a1'), S: 0, C: 0, superseded: true }], { at, mode: 'deliberate', seed: [] });
  assert.equal(sp.parts.Psup, 0.8);
}));

test('sample：不自主回想按 P 抽样（不是固定取前 k），同一会话同一回合可复现；有意回想取 A ≥ τ_del 的全部', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  // 一条 P ≈ 0.3 的候选：在很多回合里被想起的比例 ≈ 0.3
  const mean = Math.log(0.3 / 0.7) * 0.4;   // σ(mean / 0.4) = 0.3
  const fake = (seed) => {
    const eps = dyn.seededNoise([...seed, 'a9'], 0.4);
    return { ref: 'a9', mref: { kind: 'assertion', id: 9 }, ranks: {}, rrf: 0, signals: {}, A: mean + eps, P: 0.3, parts: { B: mean, S: 0, C: 0, I: 0, Psup: 0, eps } };
  };
  let hits = 0;
  for (let i = 0; i < 3000; i++) if (dyn.sample(core, [fake(['s', String(i)])], { mode: 'involuntary', seed: ['s', String(i)] }).length) hits += 1;
  assert.ok(Math.abs(hits / 3000 - 0.3) < 0.03, `命中率 ${hits / 3000}`);
  const same = dyn.sample(core, [fake(['s', '7'])], { mode: 'involuntary', seed: ['s', '7'] });
  assert.deepEqual(dyn.sample(core, [fake(['s', '7'])], { mode: 'involuntary', seed: ['s', '7'] }), same);
  // 有意回想：门槛低得多；结果按 A 降序
  const mk = (ref, A) => ({ ref, A, P: 0, parts: { B: A, S: 0, C: 0, I: 0, Psup: 0, eps: 0 } });
  const out = dyn.sample(core, [mk('a1', -1.0), mk('a2', -2.0), mk('a3', 0.5), mk('a4', -1.59)], { mode: 'deliberate', seed: [] });
  assert.deepEqual(out.map((c) => c.ref), ['a3', 'a1', 'a4']);
  assert.deepEqual(dyn.sample(core, [mk('a1', -1.0), mk('a3', 0.5)], { mode: 'involuntary', seed: [] }).map((c) => c.ref), ['a3']);
}));

test('意图项：armed +1.0（线索命中再 +0.5）；完成 / 取消后 −0.6 × e^(−Δt/12h)；还没到时间窗、执行过、lapsed 为 0', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.equal(dyn.intentionBias(core, { state: 'armed' }, { at: T0, cueHit: false }), 1.0);
  assert.equal(dyn.intentionBias(core, { state: 'armed' }, { at: T0, cueHit: true }), 1.5);
  assert.equal(dyn.intentionBias(core, { state: 'obsolete', suppressed_at: T0 }, { at: T0, cueHit: true }), -0.6);
  assert.ok(Math.abs(dyn.intentionBias(core, { state: 'cancelled', suppressed_at: T0 }, { at: T0 + 12 * H }) - (-0.6 * Math.exp(-1))) < 1e-12);
  assert.ok(Math.abs(dyn.intentionBias(core, { state: 'obsolete', suppressed_at: T0 }, { at: T0 + 3 * D })) < 0.01);   // 抑制是短暂的
  for (const state of ['formed', 'executed', 'lapsed']) assert.equal(dyn.intentionBias(core, { state }, { at: T0, cueHit: true }), 0);
  assert.equal(dyn.intentionBias(core, null, { at: T0 }), 0);
  // formed → armed 是「到了时间窗」：状态还没改过来，到了窗口也照样加成；没到、窗口过了都不加
  assert.equal(dyn.intentionBias(core, { state: 'formed', window_start: T0 - H }, { at: T0, cueHit: true }), 1.5);
  assert.equal(dyn.intentionBias(core, { state: 'formed', window_start: T0 + H }, { at: T0, cueHit: true }), 0);
  assert.equal(dyn.intentionBias(core, { state: 'formed', window_start: T0 - 2 * H, window_end: T0 - H }, { at: T0, cueHit: true }), 0);
}));

test('扇出项 S_max − ln(fan)，不小于 0', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.equal(dyn.fanTerm(core, 1), 1.5);
  assert.ok(Math.abs(dyn.fanTerm(core, 3) - (1.5 - Math.log(3))) < 1e-12);
  assert.equal(dyn.fanTerm(core, 100), 0);
}));

test('时态阈值：> 0.7 现在时；< 0.3 过去时；中间不确定', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.equal(dyn.tense(core, 0.71), 'present');
  assert.equal(dyn.tense(core, 0.7), 'uncertain');
  assert.equal(dyn.tense(core, 0.3), 'uncertain');
  assert.equal(dyn.tense(core, 0.29), 'past');
}));

test('她最近在这个场合说过话吗（attentionClass 的 herSpokeRecently）', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  const id = insertPercept(core, { at: T0, settingKey: 'g1' });
  assert.equal(dyn.herSpokeRecently(core, 'g1', T0 + M), false);
  core.store.run(`UPDATE percepts SET actor_self = 1, kind = 'self-utterance', addressed = 'by-her' WHERE id = ?`, id);
  assert.equal(dyn.herSpokeRecently(core, 'g1', T0 + 5 * M), true);
  assert.equal(dyn.herSpokeRecently(core, 'g1', T0 + 11 * M), false);
  assert.equal(dyn.herSpokeRecently(core, 'g2', T0 + 5 * M), false);
}));

test('心境：按 3 小时半衰期衰减；原因是记忆引用、按贡献排序；没有就 null', () => withCore((core) => {
  const dyn = core.mods.dynamics;
  assert.equal(dyn.currentMood(core, T0), null);
  dyn.pushMood(core, { at: T0, valence: -0.8, intensity: 0.8, causeRefs: ['e1', 'not-a-ref'] });
  const now = dyn.currentMood(core, T0);
  assert.ok(Math.abs(now.valence + 0.8) < 1e-12);
  assert.ok(Math.abs(now.intensity - 0.8) < 1e-12);
  assert.deepEqual(now.causes, ['e1']);
  assert.ok(Math.abs(dyn.currentMood(core, T0 + 3 * H).intensity - 0.4) < 1e-9);
  dyn.pushMood(core, { at: T0 + 3 * H, valence: 0.6, intensity: 0.9, causeRefs: ['e2'] });
  const mixed = dyn.currentMood(core, T0 + 3 * H);
  assert.ok(mixed.valence > 0 && mixed.valence < 0.6);
  assert.deepEqual(mixed.causes, ['e2', 'e1']);
  assert.equal(dyn.currentMood(core, T0 + 3 * D), null);   // 衰减完了：没什么特别的心情
  // 越界的值被夹住；强度为 0 的不记
  dyn.pushMood(core, { at: T0 + 4 * D, valence: 3, intensity: 7, causeRefs: [] });
  dyn.pushMood(core, { at: T0 + 4 * D, valence: 1, intensity: 0, causeRefs: [] });
  assert.equal(core.store.get('SELECT COUNT(*) AS n FROM mood').n, 3);
  assert.deepEqual(dyn.currentMood(core, T0 + 4 * D), { valence: 1, intensity: 1, causes: [] });
  // 在调用方的事务里调用
  assert.throws(() => core.store.tx(() => { dyn.pushMood(core, { at: T0 + 5 * D, valence: 0, intensity: 1, causeRefs: [] }); throw new Error('x'); }));
  assert.equal(core.store.get('SELECT COUNT(*) AS n FROM mood').n, 3);
}));

test('日志里只有类型和计数，没有内容', () => withCore((core, ports) => {
  const dyn = core.mods.dynamics;
  dyn.addTrace(core, { kind: 'assertion', id: 1 }, { t: T0, w: NaN, sourceKey: '表哥开网约车', reason: 'mention' });
  dyn.inheritActivation(core, { kind: 'assertion', id: 1 }, { kind: 'assertion', id: 2 }, { at: T0 });
  ports.logger.assertNoText('表哥开网约车');
}));
