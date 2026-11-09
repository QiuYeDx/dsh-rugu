// 常驻区（§10.4）和 self.coreBlock（§5.7）：冻结规则、逐条过关口①、心境一行不含原因、待审提示只在和管理者一对一时、出错给上一次的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withWorld, entity, episode, plan, impression, GROUP, DM, DM2, OTHER, ADAPTER, H, D, M } from './world.js';
import { DEFAULT_CORE_SELF } from '../fakes/self-profile.js';
import { USAGE_TEXT } from '../../src/context/resident.js';

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const ask = (sid, sessionId = 'sess', trigger = 'message') => ({ settingId: sid, trigger, sessionId });
const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };

test('第一次：同步给只含核心自我和用法说明的版本，同时安排一次重新渲染；渲染完以后是完整的常驻区，每一条都过了关口①', () => withWorld(async ({ core, w, clock }) => {
  const ctx = core.mods.context;
  core.store.run('UPDATE entities SET first_mention_at = ?, created_at = ? WHERE id = ?', core.now() - 60 * D, core.now() - 60 * D, w.ids.owner);
  const imp = impression(core, w.ids.owner, { layer: 'private', text: '最近在忙毕业设计' });
  const diary = episode(core, w, { sid: OTHER, kind: 'diary', at: core.now() - 5 * H, title: '日记' });
  const p = plan(core, { text: '明天下午去拿快递', start: core.now() + D, agent: w.ids.owner });
  w.texts.set(`i${imp}`, '最近在忙毕业设计').set(`e${diary}`, '今天在游戏群聊了显卡').set(`a${p}`, '11-01 下午主人要去拿快递');

  const first = ctx.resident(core, DM);
  assert.ok(first.text.includes(DEFAULT_CORE_SELF));
  assert.ok(first.text.includes(USAGE_TEXT));
  assert.deepEqual(first.itemIds, []);
  await settle();
  const full = ctx.resident(core, DM);
  assert.notEqual(full.version, first.version);
  assert.ok(full.text.includes('小秋'), full.text);
  assert.ok(full.text.includes('你的主人'));
  assert.ok(full.text.includes('认识 '));
  assert.ok(full.text.includes('最近在忙毕业设计'));
  assert.ok(full.text.includes('今天在游戏群聊了显卡'));
  assert.ok(full.text.includes('11-01 下午主人要去拿快递'));
  assert.deepEqual(full.itemIds.sort(), [`n${w.ids.owner}`, `i${imp}`, `e${diary}`, `a${p}`].sort());
  // 每一条都对得上一次判定（§9.3.6）
  const gatedRefs = new Set(w.calls.gate.flatMap((g) => g.refs));
  assert.ok(full.itemIds.every((r) => gatedRefs.has(r)));
  assert.ok(Array.from(full.text).length <= 400 + 240 + 400 + 300 + 200 + 200);
  // 没描述过的场合：只有核心自我（所有场合都一样），不安排渲染
  const unknown = ctx.resident(core, 'room-nowhere');
  assert.deepEqual(unknown.itemIds, []);
  assert.ok(unknown.text.includes(DEFAULT_CORE_SELF));
  clock.minutes(1);
}));

test('冻结：数据变了、标脏了都不换文本；真实新消息到来时（recall 的 trigger=message）或压缩结束后才换', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  ctx.bindSession(core, { sessionId: 'sess', settingId: DM, adapterId: ADAPTER, confidence: 'specific' });
  await ctx.refreshResident(core, w.key(DM));
  const v1 = ctx.resident(core, DM);
  core.mods.dynamics.pushMood(core, { at: core.now(), valence: 0.9, intensity: 0.9, causeRefs: [] });
  ctx.markResidentDirty(core, w.key(DM));
  ctx.markResidentDirty(core);
  await settle();
  assert.equal(ctx.resident(core, DM).version, v1.version, '定时器、夜间整理、主人编辑只标脏');
  // 提醒、空闲唤醒不是真实的新消息
  await ctx.recall(core, ask(DM, 'sess', 'reminder'), INVOL);
  assert.equal(ctx.resident(core, DM).version, v1.version);
  await ctx.recall(core, ask(DM), INVOL);
  const v2 = ctx.resident(core, DM);
  assert.notEqual(v2.version, v1.version);
  assert.ok(v2.text.includes('心情很好'));
  // 压缩结束后换
  core.mods.dynamics.pushMood(core, { at: core.now(), valence: -1, intensity: 1, causeRefs: [] });
  await settle();
  assert.equal(ctx.resident(core, DM).version, v2.version);
  ctx.compaction(core, 'sess', 'end');
  await settle();
  const v3 = ctx.resident(core, DM);
  assert.notEqual(v3.version, v2.version);
  // 压缩结束时冻结的条目就是新周期一开始就在上下文里的那些（污点账本）
  assert.deepEqual(ctx.taintLedger(core, 'sess').sort(), [...v3.itemIds].sort());
}));

test('出错时返回上一次的冻结文本；DSH 重启后（内存清空）从库里重新渲染', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  await ctx.refreshResident(core, w.key(DM));
  const v1 = ctx.resident(core, DM);
  ctx.markResidentDirty(core, w.key(DM));
  w.throws['discretion.targetFor'] = true;
  await ctx.recall(core, ask(DM), INVOL);
  assert.equal(ctx.resident(core, DM).text, v1.text);
  w.throws['discretion.gate'] = true;
  w.throws['discretion.targetFor'] = false;
  await ctx.refreshResident(core, w.key(DM));
  assert.equal(ctx.resident(core, DM).text, v1.text);
  w.throws['discretion.gate'] = false;
  // 重启：内存里没有冻结文本
  ctx.dispose(core);
  ctx.init(core);
  const cold = ctx.resident(core, DM);
  assert.deepEqual(cold.itemIds, []);
  await settle();
  assert.equal(ctx.resident(core, DM).text, v1.text);
  // intake 出错：给一个只含核心自我的版本，不抛错
  w.throws['intake.resolveSetting'] = true;
  assert.ok(ctx.resident(core, DM).text.includes(DEFAULT_CORE_SELF));
}));

test('重要的人按场合过分寸：不能说的不出现；只能说个大概的给含糊版本；一对一时放对方的卡', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  const imp = impression(core, w.ids.owner, { layer: 'private', text: '主人的私事' });
  w.texts.set(`i${imp}`, '主人的私事');
  w.verdicts.set(`n${w.ids.owner}`, (target) => (target.audience.settingKey === w.key(GROUP) ? { verdict: 'share_vague', vagueText: '一个你很熟的人' } : 'share'));
  w.verdicts.set(`i${imp}`, (target) => (target.audience.settingKey === w.key(GROUP) ? 'omit' : 'share'));
  await ctx.refreshResident(core, w.key(GROUP));
  const g = ctx.resident(core, GROUP);
  assert.ok(g.text.includes('一个你很熟的人'));
  assert.ok(!g.text.includes('小秋') && !g.text.includes('主人的私事'));
  assert.ok(!g.itemIds.includes(`i${imp}`));
  // 和阿明一对一：阿明的卡在前
  await ctx.refreshResident(core, w.key(DM2));
  const d2 = ctx.resident(core, DM2);
  assert.ok(d2.text.indexOf('阿明') >= 0 && d2.text.indexOf('阿明') < d2.text.indexOf('小秋'), d2.text);
}));

test('现在的我：心境一行，不含原因（§5.7）；待审提示只在和有管理权限的人一对一时出现（§10.4、§9.3.7）', () => withWorld(async ({ core, w, logger }) => {
  const ctx = core.mods.context;
  const cause = episode(core, w, { sid: GROUP, at: core.now() - H, title: '被小红当众怼了' });
  w.texts.set(`e${cause}`, '被小红当众怼了');
  core.mods.dynamics.pushMood(core, { at: core.now() - 10 * M, valence: -0.7, intensity: 0.8, causeRefs: [`e${cause}`] });
  w.pendingCount = 3;
  w.retention = { current: '2y', pending: { to: '1y', effectiveAt: core.now() + 5 * D, impact: {} } };
  for (const sid of [DM, DM2, GROUP]) await ctx.refreshResident(core, w.key(sid));
  const dm = ctx.resident(core, DM).text;
  assert.ok(dm.includes('低落'));
  assert.ok(!dm.includes('小红'), '心境的原因不进常驻区');
  assert.ok(dm.includes('3 条'));
  assert.ok(dm.includes('保留期'));
  for (const sid of [DM2, GROUP]) {
    const t = ctx.resident(core, sid).text;
    assert.ok(t.includes('低落'), '心境在所有场合都一样');
    assert.ok(!t.includes('3 条') && !t.includes('保留期'), `${sid} 不该有待审提示`);
  }
  logger.assertNoText('被小红当众怼了', '小秋');
}));

test('self.coreBlock：核心自我 + 成长块，所有场合都一样；成长块变了哈希跟着变', () => withWorld(async ({ core, w }) => {
  const ctx = core.mods.context;
  const a = ctx.coreBlock(core, DM);
  assert.deepEqual(ctx.coreBlock(core, GROUP), a);
  assert.equal(a.text, DEFAULT_CORE_SELF);
  w.growth = '最近越来越喜欢看猫的视频。';
  const b = ctx.coreBlock(core, 'room-nowhere');
  assert.ok(b.text.startsWith(DEFAULT_CORE_SELF) && b.text.endsWith(w.growth));
  assert.notEqual(b.hash, a.hash);
  // 成长块拿不到：只用核心自我，不抛错
  w.throws['consolidate.growthBlock'] = true;
  assert.deepEqual(ctx.coreBlock(core, DM), a);
}));
