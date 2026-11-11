// 【D152】recallAt：回放评测的入口（按场合键和感知 id 进入）。和 recall 走同一条路：同一个焦点、同一个触发者、同样的结果；
// 焦点不在这个场合时和交进来的消息 id 找不到一样退回；不登记 SettingId。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withWorld, percept, GROUP, OTHER } from './world.js';

const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };
const strip = (out) => out.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, rendered: i.rendered }));

test('recallAt 按场合键和感知 id 进入：焦点、触发者、给出来的条目和按消息 id 进入的 recall 一样', () => withWorld(async ({ core, w }) => {
  const p1 = percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'to-her', text: '你还记得上次团建吗', obsId: 'o1' });
  percept(core, w, { sid: GROUP, actor: w.ids.hong, addressed: 'to-her', text: '我也想问' });
  w.candidates = ['a1', 'a2'];
  w.texts.set('a1', '上次团建去了湖边').set('a2', '团建那天下雨');
  const a = await core.mods.context.recall(core, { settingId: GROUP, focusObsId: 'o1', trigger: 'message' }, INVOL);
  const ra = w.calls.retrieve.at(-1);
  const ta = w.calls.targetFor.at(-1);
  const b = await core.mods.context.recallAt(core, { settingKey: w.key(GROUP), focusPerceptId: p1, trigger: 'message' }, INVOL);
  const rb = w.calls.retrieve.at(-1);
  const tb = w.calls.targetFor.at(-1);
  assert.equal(ra.s.focusPerceptId, p1);
  assert.equal(rb.s.focusPerceptId, p1);
  assert.equal(rb.s.settingKey, w.key(GROUP));
  assert.equal(ta.triggerEntityId, w.ids.ming);
  assert.equal(tb.triggerEntityId, w.ids.ming);
  assert.equal(tb.settingId, undefined, '回放入口不带 SettingId');
  assert.deepEqual(strip(b), strip(a));
  assert.ok(b.items.some((i) => i.id === 'a1'));
}));

test('recallAt：焦点不在这个场合时退回这里最后一个对她说话的人；场合键找不到时是空的', () => withWorld(async ({ core, w }) => {
  const elsewhere = percept(core, w, { sid: OTHER, actor: w.ids.ming, addressed: 'to-her', text: '别处的一句' });
  const p2 = percept(core, w, { sid: GROUP, actor: w.ids.hong, addressed: 'to-her', text: '这里的一句' });
  w.candidates = ['a1'];
  w.texts.set('a1', '一件事');
  await core.mods.context.recallAt(core, { settingKey: w.key(GROUP), focusPerceptId: elsewhere, trigger: 'message' }, INVOL);
  assert.equal(w.calls.retrieve.at(-1).s.focusPerceptId, p2);
  assert.equal(w.calls.targetFor.at(-1).triggerEntityId, w.ids.hong);
  const n = w.calls.retrieve.length;
  const out = await core.mods.context.recallAt(core, { settingKey: 'no-such-key', focusPerceptId: p2, trigger: 'message' }, INVOL);
  assert.deepEqual(out.items, []);
  assert.equal(w.calls.retrieve.length, n, '找不到场合就不回想');
}));
