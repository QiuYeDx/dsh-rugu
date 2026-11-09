// §7.1 第 4 步：撤回、编辑（§5.6）、转进来的（derivedFrom、expectRelay，评审:AR-13）。到达顺序不定，两种顺序结果一样。
import test from 'node:test';
import assert from 'node:assert/strict';
import { textHash } from '../../src/contract/ids.js';
import { withIntake, ingest, obs, descriptor, ADAPTER, T0, M } from './helpers.js';

test('撤回：原感知 text_state=retracted（她记得，但原话不再展示）；提交后通知 encode.onPerceptRetracted', () => withIntake((t) => {
  const o = obs('g', 'friend', '我其实欠了一笔钱');
  ingest(t, [o]);
  ingest(t, [obs('g', 'friend', '', { kind: 'retract', target: o.id, evidential: false, at: T0 + M })]);
  const [orig, rt] = t.rows();
  assert.equal(orig.text_state, 'retracted');
  assert.equal(orig.text, '我其实欠了一笔钱');   // 只追加：原文还在（保留期到了才清）
  assert.equal(rt.kind, 'retract');
  assert.equal(rt.target_id, orig.id);
  assert.equal(rt.target_key, t.core.keys.obsKey(ADAPTER, o.id));
  assert.deepEqual(t.calls['encode.onPerceptRetracted'], [[orig.id]]);
  // 重复的撤回：不再通知
  ingest(t, [obs('g', 'friend', '', { kind: 'retract', target: o.id, evidential: false, at: T0 + 2 * M })]);
  assert.equal(t.calls['encode.onPerceptRetracted'].length, 1);
}));

test('撤回先到、原消息后到：原消息到的时候挂上并标撤回', () => withIntake((t) => {
  const o = obs('g', 'friend', '后到的原消息');
  ingest(t, [obs('g', 'friend', '', { kind: 'retract', target: o.id, evidential: false })]);
  assert.equal(t.rows()[0].target_id, null);
  ingest(t, [o]);
  const [rt, orig] = t.rows();
  assert.equal(rt.target_id, orig.id);
  assert.equal(orig.text_state, 'retracted');
  assert.deepEqual(t.calls['encode.onPerceptRetracted'], [[orig.id]]);
}));

test('撤回：包含原消息的原文窗口重新渲染（原话换成占位），送去重嵌', () => withIntake((t) => {
  const o = obs('g', 'friend', '这句会被撤回');
  ingest(t, [obs('g', 'other', '前一句'), o]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const w0 = t.core.store.get('SELECT * FROM raw_windows');
  assert.match(w0.text, /这句会被撤回/);
  const embeds = t.calls['worker.enqueueEmbed'].length;
  ingest(t, [obs('g', 'friend', '', { kind: 'retract', target: o.id, evidential: false, at: T0 + M })]);
  const w1 = t.core.store.get('SELECT * FROM raw_windows WHERE id = ?', w0.id);
  assert.doesNotMatch(w1.text, /这句会被撤回/);
  assert.match(w1.text, /撤回了一条消息/);
  assert.match(w1.text, /前一句/);
  const re = t.calls['worker.enqueueEmbed'].slice(embeds).filter(([ref]) => ref.kind === 'window' && ref.id === w0.id);
  assert.equal(re.length, 1);
}));

test('编辑：新版本是一条新感知（kind=edit），旧的标 edited；通知 encode.onPerceptEdited(旧, 新)；两种到达顺序一样', () => withIntake((t) => {
  const a = obs('g', 'friend', '周五开会');
  ingest(t, [a]);
  ingest(t, [obs('g', 'friend', '周六开会', { kind: 'edit', target: a.id, at: T0 + M })]);
  const [oa, ea] = t.rows();
  assert.equal(oa.text_state, 'edited');
  assert.equal(ea.target_id, oa.id);
  assert.deepEqual(t.calls['encode.onPerceptEdited'], [[oa.id, ea.id]]);
  // 编辑先到
  const b = obs('g', 'other', '原话B');
  ingest(t, [obs('g', 'other', '改过的B', { kind: 'edit', target: b.id, at: T0 + 2 * M })]);
  ingest(t, [b]);
  const rows = t.rows();
  const eb = rows.find((p) => p.text === '改过的B');
  const ob = rows.find((p) => p.text === '原话B');
  assert.equal(ob.text_state, 'edited');
  assert.equal(eb.target_id, ob.id);
  assert.deepEqual(t.calls['encode.onPerceptEdited'][1], [ob.id, eb.id]);
}));

test('expectRelay：预告之后到达、文本哈希相同的感知标 relay_of = 原感知（不作为新的事实来源）', () => withIntake((t) => {
  const { intake } = t.core.mods;
  const orig = obs('g', 'friend', '明天下午三点开会');
  ingest(t, [orig]);
  intake.expectRelay(t.core, { adapter: ADAPTER, obsId: orig.id, textHash: textHash('明天下午三点开会'), until: T0 + 10 * M });
  ingest(t, [obs('h', 'principal', '明天下午三点开会', { at: T0 + 2 * M })]);
  const [o, copy] = t.rows();
  assert.equal(copy.relay_of, o.id);
  assert.equal(o.relay_of, null);
  assert.equal(t.core.store.get('SELECT matched_percept FROM relays').matched_percept, copy.id);
  // 预告只配一次；过了 until 的不配
  ingest(t, [obs('h', 'principal', '明天下午三点开会', { at: T0 + 3 * M })]);
  assert.equal(t.rows()[2].relay_of, null);
  intake.expectRelay(t.core, { adapter: ADAPTER, obsId: 'x-old', textHash: textHash('过期的'), until: T0 - M });
  ingest(t, [obs('h', 'principal', '过期的')]);
  assert.equal(t.rows()[3].relay_of, null);
}, { settings: { g: descriptor('g'), h: descriptor('h') } }));

test('expectRelay 的几种顺序：转进来的先到（预告晚了一步）、原消息后到', () => withIntake((t) => {
  const { intake } = t.core.mods;
  // 转进来的先到，然后才预告
  ingest(t, [obs('h', 'principal', '先到的转达')]);
  const orig = obs('g', 'friend', '先到的转达');
  ingest(t, [orig]);
  intake.expectRelay(t.core, { adapter: ADAPTER, obsId: orig.id, textHash: textHash('先到的转达'), until: T0 + 10 * M });
  const [copy, o] = t.rows();
  assert.equal(copy.relay_of, o.id);
  // 预告了，转进来的到了，原消息最后才到
  intake.expectRelay(t.core, { adapter: ADAPTER, obsId: 'late-orig', textHash: textHash('原消息最后到'), until: T0 + 10 * M });
  ingest(t, [obs('h', 'principal', '原消息最后到')]);
  const c2 = t.rows().at(-1);
  assert.equal(c2.relay_of, null);
  ingest(t, [{ ...obs('g', 'friend', '原消息最后到'), id: 'late-orig' }]);
  const o2 = t.rows().at(-1);
  assert.equal(t.core.store.get('SELECT relay_of FROM percepts WHERE id = ?', c2.id).relay_of, o2.id);
  // 不合契约的预告：只计数，不抛错
  assert.doesNotThrow(() => intake.expectRelay(t.core, /** @type {any} */ ({ obsId: 'x' })));
}, { settings: { g: descriptor('g'), h: descriptor('h') } }));

test('derivedFrom：从另一个入口转进来的同一件事挂到原感知下；原感知后到时补上', () => withIntake((t) => {
  const orig = obs('g', 'friend', '原始消息');
  ingest(t, [orig]);
  ingest(t, [obs('h', 'principal', '原始消息（转）', { derivedFrom: { adapter: ADAPTER, obsId: orig.id } })]);
  const [o, d] = t.rows();
  assert.equal(d.relay_of, o.id);
  assert.ok(!d.derived_from_json.includes(orig.id));   // ObsId 只存 HMAC
  // 原感知后到
  ingest(t, [obs('h', 'principal', '后到原消息的转达', { derivedFrom: { adapter: ADAPTER, obsId: 'm-later' } })]);
  const d2 = t.rows().at(-1);
  assert.equal(d2.relay_of, null);
  ingest(t, [{ ...obs('g', 'friend', '后到的原消息'), id: 'm-later' }]);
  const o2 = t.rows().at(-1);
  assert.equal(t.core.store.get('SELECT relay_of FROM percepts WHERE id = ?', d2.id).relay_of, o2.id);
}, { settings: { g: descriptor('g'), h: descriptor('h') } }));
