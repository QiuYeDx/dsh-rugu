// retrieve 接到别的模块的那几处（阶段 B 交付说明里的请求）：
//   - L3 以 worker.health 为准（D40：线程挂了 embedQuery 照样给向量，只有稠密扫描降级）；
//   - 提炼背景里，还没结案的计划以事实（'a<id>'）给出，私下那组也一样（S2b）；
//   - 整体恢复后补不回的空白（backup.replayStatus），有意回想碰到时「记不太清」（§12.4.5 第 8 步）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedSource, T0, MIN, HOUR, DAY } from './fixtures.js';
import { withPlans } from '../../src/retrieve/background.js';

const R = (core, s, o) => core.mods.retrieve.recall(core, { trigger: 'simulate', ...s }, { deadlineMs: o.mode === 'deliberate' ? 3000 : 800, ...o });

test('L3 以 worker.health 为准：线程挂了（fallback）→ 标 L3、稠密路直接缺席（不白嵌查询）；worker 那边熔断 → L3，伪查询向量照样扫；拿不到 health 照旧', async () => {
  let health = { dense: false, mode: 'fallback' };
  let asked = 0;
  const w = await retrieveCore({ mods: { worker: { health: () => { asked += 1; if (health instanceof Error) throw health; return health; } } } });
  try {
    const { core, calls, worker } = w;
    const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
    seedSetting(core, 'D', { label: '私聊' });
    const a1 = seedAssertion(core, { text: '老板今晚加班', subjects: [boss] });
    worker.addDoc(`a${a1}`, '老板今晚加班');
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: boss, text: '今晚加班吗', addressed: 'to-her' });
    const fresh = () => { core.state.retrieve.health = null; };
    // 线程挂了：embedQuery 还能用（worker 的契约），但这一轮仍然是 L3，而且不去嵌查询、不去扫
    assert.equal(core.mods.retrieve.degradeLevel(core), 3);
    let set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '加班' });
    assert.equal(set.degradeLevel, 3);
    assert.equal(calls.embedQuery?.length ?? 0, 0, '不白嵌查询');
    assert.equal(calls.denseSearch?.length ?? 0, 0, '不白扫');
    assert.ok(set.stats.routes.find((r) => r.route === 'dense').hits === 0);
    assert.ok(set.items.some((c) => c.ref === `a${a1}`), '词法 / 实体路照样给出');
    // worker 自己的嵌入熔断（扫描本身还能跑）：L3，伪查询向量照样扫
    health = { dense: false, mode: 'thread' };
    fresh();
    set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '加班' });
    assert.equal(set.degradeLevel, 3);
    assert.equal(calls.embedQuery?.length ?? 0, 0);
    assert.ok((calls.denseSearch?.length ?? 0) >= 1, '伪查询向量照样扫');
    // 好了：回到 L2（CPU）
    health = { dense: true, mode: 'thread' };
    fresh();
    assert.equal(core.mods.retrieve.degradeLevel(core), 2);
    set = await R(core, { settingKey: 'D' }, { mode: 'deliberate', query: '加班' });
    assert.equal(set.degradeLevel, 2);
    assert.ok(calls.embedQuery.length >= 1);
    // health 拿不到（出错）：不知道，照别的条件判断
    health = new Error('down');
    fresh();
    assert.equal(core.mods.retrieve.degradeLevel(core), 2);
    // 结果缓存一小会儿（health 会数嵌入队列，聊天路径上不每轮都问）
    health = { dense: true, mode: 'thread' };
    fresh();
    asked = 0;
    core.mods.retrieve.degradeLevel(core);
    core.mods.retrieve.degradeLevel(core);
    assert.equal(asked, 1, '两秒内只问一次');
    core.state.retrieve.health = { t: performance.now(), v: { dense: false, scan: true } };
    assert.equal(core.mods.retrieve.degradeLevel(core), 3, '用缓存的结果');
    core.state.retrieve.health.t = performance.now() - 60_000;   // 过期了：重新问
    assert.equal(core.mods.retrieve.degradeLevel(core), 2);
    assert.equal(asked, 2);
  } finally { await w.cleanup(); }
});

test('S2b 提炼背景：大群里「拿到了」（和「去拿快递」没有共同的词）→ 说话人在私聊里说的、还没结案的计划以 a<id> 进私下那组', async () => {
  const w = await retrieveCore();
  try {
    const { core, hidden } = w;
    seedEntity(core, { name: '小鱼', isSelf: true });
    const owner = seedEntity(core, { name: '阿杰', authority: 'principal', closeness: 1 });
    const other = seedEntity(core, { name: '群友' });
    seedSetting(core, 'G', { label: '大群' });
    seedSetting(core, 'D', { label: '私聊' });
    const planP = seedPercept(core, { settingKey: 'D', at: T0 - 2 * HOUR, actor: owner, text: '等下去拿快递', addressed: 'to-her' });
    const plan = seedAssertion(core, { text: '阿杰要去拿快递', subjects: [owner], kindHint: 'plan', planStatus: 'planned', recordedAt: T0 - 2 * HOUR,
      sources: [{ speaker: owner, perceivedIn: 'D', at: T0 - 2 * HOUR, perceptId: planP }] });
    core.store.run('UPDATE assertions SET plan_agent = ? WHERE id = ?', owner, plan);
    const done = seedAssertion(core, { text: '阿杰上周去拿快递', subjects: [owner], kindHint: 'plan', planStatus: 'done', recordedAt: T0 - 7 * DAY });
    const old = seedAssertion(core, { text: '阿杰要去拿外卖', subjects: [owner], kindHint: 'plan', planStatus: 'planned', recordedAt: T0 - 3 * DAY });
    core.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', plan, old);
    seedPercept(core, { settingKey: 'G', at: T0 - 5 * MIN, actor: other, text: '今天谁收到双十一的东西了' });
    const heard = seedPercept(core, { settingKey: 'G', at: T0 - 4 * MIN, actor: owner, text: '拿到了' });
    const bg = await core.mods.retrieve.backgroundForExtraction(core, { settingKey: 'G', perceptIds: [heard - 1, heard] });
    const p = bg.private.find((b) => b.ref === `a${plan}`);
    assert.ok(p, JSON.stringify(bg));
    assert.match(p.text, /阿杰要去拿快递/);
    assert.match(p.text, /还没听说结果/);
    assert.ok(!bg.known.some((b) => b.ref === `a${plan}`), '私聊里说的，大群的人本来不知道');
    // 召回照常带出的已经结案、被取代的计划可以在，但写明了，模型不会把「拿到了」标到它们身上
    const all = [...bg.known, ...bg.private];
    const d = all.find((b) => b.ref === `a${done}`);
    if (d) assert.match(d.text, /后来做完了/);
    const o = all.find((b) => b.ref === `a${old}`);
    if (o) assert.match(o.text, /后来有了新的说法/);
    // 隐藏了的不加
    hidden.add(`a${plan}`);
    const bg2 = await core.mods.retrieve.backgroundForExtraction(core, { settingKey: 'G', perceptIds: [heard] });
    assert.ok(![...bg2.known, ...bg2.private].some((b) => b.ref === `a${plan}`));
  } finally { await w.cleanup(); }
});

test('提炼背景（withPlans）：说话人还没结案的计划连召回里已有的一共最多 max 条，最近更新的补在最前；结案的、被取代的、隐藏的不补', async () => {
  const w = await retrieveCore();
  try {
    const { core, hidden } = w;
    seedEntity(core, { name: '小鱼', isSelf: true });
    const hong = seedEntity(core, { name: '小红' });
    const ming = seedEntity(core, { name: '阿明' });
    const plans = [];
    for (let k = 0; k < 5; k++) {
      const a = seedAssertion(core, { text: `小红的计划${k}`, subjects: [hong], kindHint: 'plan', planStatus: 'planned', recordedAt: T0 - (k + 1) * HOUR });
      plans.push(`a${a}`);
    }
    const done = seedAssertion(core, { text: '小红的旧计划', subjects: [hong], kindHint: 'plan', planStatus: 'done', recordedAt: T0 });
    const sup = seedAssertion(core, { text: '小红被取代的计划', subjects: [hong], kindHint: 'plan', planStatus: 'planned', recordedAt: T0 });
    core.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', Number(plans[0].slice(1)), sup);
    // 执行者是她、但主体不是她的计划也算（plan_agent）
    const agent = seedAssertion(core, { text: '帮阿明搬家', subjects: [ming], kindHint: 'plan', planStatus: 'in_progress', recordedAt: T0 - 30 * MIN });
    core.store.run('UPDATE assertions SET plan_agent = ? WHERE id = ?', hong, agent);
    const rows = [{ actor_entity_id: hong }, { actor_entity_id: null }];
    const refs = (list) => list.map((c) => c.ref);
    // 召回里什么都没有：补最近更新的 3 条
    assert.deepEqual(refs(withPlans(core, [], { rows, max: 3 })), [`a${agent}`, plans[0], plans[1]]);
    // 召回里已经有她的一条（较旧的），补 2 条，排在召回的前面；召回给的不删
    const other = { ref: 'n9', mref: { kind: 'entity', id: 9 } };
    assert.deepEqual(refs(withPlans(core, [other, { ref: plans[4] }], { rows, max: 3 })), [`a${agent}`, plans[0], 'n9', plans[4]]);
    // 召回里已经有 3 条：不补
    assert.deepEqual(refs(withPlans(core, [{ ref: plans[2] }, { ref: plans[3] }, { ref: plans[4] }], { rows, max: 3 })), [plans[2], plans[3], plans[4]]);
    // 结案的、被取代的不补；max 0 不补
    const many = refs(withPlans(core, [], { rows, max: 20 }));
    assert.ok(!many.includes(`a${done}`) && !many.includes(`a${sup}`));
    assert.equal(many.length, 6);
    assert.deepEqual(withPlans(core, [], { rows, max: 0 }), []);
    // 隐藏了的不补（也不拿别的顶上：宁可少一条）；查不了隐藏就一条都不补
    hidden.add(`a${agent}`);
    assert.deepEqual(refs(withPlans(core, [], { rows, max: 3 })), [plans[0], plans[1]]);
    core.mods.admin.suppressedRefs = () => { throw new Error('down'); };
    assert.deepEqual(refs(withPlans(core, [other], { rows, max: 3 })), ['n9']);
  } finally { await w.cleanup(); }
});

test('提炼背景：召回到的原始感知是哪条计划的证据，那条计划（a<id>）跟在它后面；说话人的计划够数、都写明还开着', async () => {
  const w = await retrieveCore();
  try {
    const { core } = w;
    seedEntity(core, { name: '小鱼', isSelf: true });
    const ming = seedEntity(core, { name: '阿明' });
    const hong = seedEntity(core, { name: '小红' });
    seedSetting(core, 'G', { label: '群' });
    seedSetting(core, 'D', { label: '私聊' });
    const ev = seedPercept(core, { settingKey: 'D', at: T0 - DAY, actor: ming, text: '明天去取包裹', addressed: 'to-her' });
    const plan = seedAssertion(core, { text: '阿明要去驿站', subjects: [ming], kindHint: 'plan', planStatus: 'planned', recordedAt: T0 - DAY });
    seedSource(core, 'assertion', plan, { speaker: ming, perceivedIn: 'D', at: T0 - DAY, perceptId: ev });
    const seg = seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: hong, text: '包裹到了吗' });
    const bg = await core.mods.retrieve.backgroundForExtraction(core, { settingKey: 'G', perceptIds: [seg] });
    const all = [...bg.known, ...bg.private].map((b) => b.ref);
    const i = all.indexOf(`p${ev}`);
    assert.ok(i >= 0, JSON.stringify(bg));
    assert.equal(all[i + 1], `a${plan}`, '计划跟在它的证据后面');
    // 小红自己有 5 条还没结案的计划：召回给的加上补的至少 recall.background.plans 条，每条都写明还没结果
    for (let k = 0; k < 5; k++) {
      const a = seedAssertion(core, { text: `小红的计划${k}`, subjects: [hong], kindHint: 'plan', planStatus: 'planned', recordedAt: T0 - (k + 1) * HOUR });
      core.store.run('UPDATE assertions SET updated_at = ? WHERE id = ?', T0 - (k + 1) * HOUR, a);
    }
    const bg2 = await core.mods.retrieve.backgroundForExtraction(core, { settingKey: 'G', perceptIds: [seg] });
    const hers = [...bg2.known, ...bg2.private].filter((b) => /小红的计划/.test(b.text));
    assert.ok(hers.length >= 3, JSON.stringify(hers));
    assert.ok(hers.every((b) => /还没听说结果/.test(b.text)));
  } finally { await w.cleanup(); }
});

// ── §12.4.5 第 8 步：补不回的空白 ──────────────────────────────────────────

/** 一个群 G（和别的群 H）：空白之前老板说过两句，群友对她说了 focus。box.status 是 backup.replayStatus 的返回（可以换）。 */
async function blankWorld({ focus, focusAt = T0 - MIN, after = [] }) {
  const box = { status: null };
  const w = await retrieveCore({ mods: { backup: { replayStatus: () => { if (box.status instanceof Error) throw box.status; return box.status; } } } });
  const { core } = w;
  seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const mate = seedEntity(core, { name: '群友' });
  seedSetting(core, 'G', { label: '群' });
  seedSetting(core, 'H', { label: '别的群' });
  const ids = {
    early: seedPercept(core, { settingKey: 'G', at: T0 - 6 * DAY, actor: boss, text: '今天下雨' }),
    anchor: seedPercept(core, { settingKey: 'G', at: T0 - 5 * DAY, actor: boss, text: '周末去爬山' }),
  };
  for (const a of after) seedPercept(core, { settingKey: 'G', actor: mate, ...a });
  ids.focus = seedPercept(core, { settingKey: 'G', at: focusAt, actor: mate, text: focus, addressed: 'to-her' });
  return { ...w, box, ids };
}
const GAP = { settingKey: 'G', from: T0 - 3 * DAY, to: T0 - DAY, count: 40, missing: 12 };
const blankOf = (set) => set.items.find((c) => c.blank);
// 想起来的经历（原话、窗口、情节、事实）；在场的人的档案不算
const events = (set) => set.items.filter((c) => !c.blank && ['percept', 'window', 'episode', 'assertion'].includes(c.mref?.kind)).map((c) => c.ref);
const DEL = (q) => ({ mode: 'deliberate', query: q });

test('§12.4.5 第 8 步：问到的时间落在补不回的空白里 → 一行「那几天有些事记不太清」（锚在空白之前的感知上，不给它的内容）', async () => {
  const w = await blankWorld({ focus: '上周我们聊了啥' });
  try {
    const { core, box, ids } = w;
    box.status = { active: false, gaps: [GAP] };
    const set = await R(core, { settingKey: 'G' }, DEL('上周我们聊了啥'));
    const b = blankOf(set);
    assert.ok(b, JSON.stringify(set.items.map((c) => c.ref)));
    assert.equal(b.fok, true);
    assert.ok([`p${ids.anchor}`, `p${ids.early}`].includes(b.ref), b.ref);
    assert.ok(!set.items.some((c) => !c.blank && c.ref === b.ref), '锚点不和想起来的那条重复');
    assert.deepEqual({ from: b.blank.from, to: b.blank.to, here: b.blank.here }, { from: GAP.from, to: GAP.to, here: true });
    const r = core.mods.retrieve.render(core, b, { verdict: 'share', at: T0, itemChars: 120, settingKey: 'G' });
    assert.equal(r.rendered, '（在这里，10/28–10/30 那几天有些事你记不太清了：好像有点印象，细节想不起来）');
    assert.ok(!/爬山|下雨/.test(r.rendered), '不给锚点的内容');
    assert.ok(!/恢复|备份/.test(r.rendered), '她不会被告知「你被恢复了」');
    const rv = core.mods.retrieve.render(core, b, { verdict: 'share_vague', vagueText: '老板说了周末的安排', at: T0, itemChars: 120, settingKey: 'H' });
    assert.equal(rv.rendered, '（10/28–10/30 那几天有些事你记不太清了：好像有点印象，细节想不起来）', '说个大概也一样；别的场合不说「在这里」');
    assert.equal(core.mods.retrieve.render(core, b, { verdict: 'aware_private', at: T0, itemChars: 120 }).rendered, '', '不能说的不给');
    // 已经补回来了（missing 0）、不自主回想、replayStatus 出错：都不提，也不抛错
    box.status = { active: true, gaps: [{ ...GAP, missing: 0 }] };
    assert.equal(blankOf(await R(core, { settingKey: 'G' }, DEL('上周我们聊了啥'))), undefined);
    box.status = { active: false, gaps: [GAP] };
    assert.equal(blankOf(await R(core, { settingKey: 'G' }, { mode: 'involuntary', query: '上周我们聊了啥' })), undefined);
    box.status = new Error('down');
    assert.equal(blankOf(await R(core, { settingKey: 'G' }, DEL('上周我们聊了啥'))), undefined);
    // 别的场合的空白，时间也落在里面：照样有这一行（能不能提由关口①看锚点），只是不说「在这里」
    box.status = { active: false, gaps: [{ ...GAP, settingKey: 'H' }] };
    seedPercept(core, { settingKey: 'H', at: T0 - 4 * DAY, text: '那边的事' });
    const bh = blankOf(await R(core, { settingKey: 'G' }, DEL('上周我们聊了啥')));
    assert.ok(bh && bh.blank.here === false && bh.blank.settingKey === 'H');
  } finally { await w.cleanup(); }
});

test('§12.4.5 第 8 步：问到的时间不在空白里 → 不提', async () => {
  const w = await blankWorld({ focus: '昨天我们聊了啥' });
  try {
    const { core, box } = w;
    box.status = { active: false, gaps: [{ ...GAP, to: T0 - 2 * DAY }] };   // 空白到 10/29 为止，「昨天」是 10/30
    assert.equal(blankOf(await R(core, { settingKey: 'G' }, DEL('昨天我们聊了啥'))), undefined);
    box.status = { active: false, gaps: [GAP] };                            // 到 10/30：和昨天重叠
    assert.ok(blankOf(await R(core, { settingKey: 'G' }, DEL('昨天我们聊了啥'))));
  } finally { await w.cleanup(); }
});

test('§12.4.5 第 8 步：没给时间、什么都没想起来 → 只有眼下的对话是接着空白那段聊下来的才提（隔了长沉默的新对话不提），别的场合的空白不提', async () => {
  // 刚恢复完：空白一直到 40 分钟前，之后群里接着在聊
  const w = await blankWorld({ focus: '那个叫什么来着', after: [{ at: T0 - 20 * MIN, text: '嗯嗯' }] });
  try {
    const { core, box } = w;
    box.status = { active: false, gaps: [{ ...GAP, to: T0 - 40 * MIN }] };
    let set = await R(core, { settingKey: 'G' }, DEL('那个叫什么来着'));
    assert.equal(set.cues.timeWindows.length, 0);
    assert.deepEqual(events(set), [], '什么都没想起来');
    assert.ok(blankOf(set));
    // 空白在别的场合：不提
    box.status = { active: false, gaps: [{ ...GAP, settingKey: 'H', to: T0 - 40 * MIN }] };
    seedPercept(core, { settingKey: 'H', at: T0 - 4 * DAY, text: '那边的事' });
    assert.equal(blankOf(await R(core, { settingKey: 'G' }, DEL('那个叫什么来着'))), undefined);
    // 空白之后隔了一天才又聊起来（≥ recall.window.maxGapH 的沉默）：这是新的一场对话，想不起来就是想不起来
    box.status = { active: false, gaps: [GAP] };
    set = await R(core, { settingKey: 'G' }, DEL('那个叫什么来着'));
    assert.equal(blankOf(set), undefined);
  } finally { await w.cleanup(); }
  // 中间一直没断（每隔几小时都有人说话）：还是接着的
  const steady = [];
  for (let t = T0 - DAY + 4 * HOUR; t < T0 - 10 * MIN; t += 4 * HOUR) steady.push({ at: t, text: '……' });
  const w2 = await blankWorld({ focus: '那个叫什么来着', after: steady });
  try {
    w2.box.status = { active: false, gaps: [GAP] };
    const set = await R(w2.core, { settingKey: 'G' }, DEL('那个叫什么来着'));
    assert.deepEqual(events(set), [], '什么都没想起来');
    assert.ok(blankOf(set), '接着聊下来的对话里什么都没想起来 → 提');
  } finally { await w2.cleanup(); }
});

test('§12.4.5 第 8 步：锚点已经被想起来了 / 被隐藏了 → 往前换一条；这个场合找不到能用的锚点 → 不提', async () => {
  const w = await blankWorld({ focus: '上周爬山的事还记得吗' });
  try {
    const { core, box, ids, hidden } = w;
    box.status = { active: false, gaps: [GAP] };
    let set = await R(core, { settingKey: 'G' }, DEL('上周爬山的事还记得吗'));
    let b = blankOf(set);
    assert.ok(b);
    assert.ok(set.items.some((c) => !c.blank && c.ref === `p${ids.anchor}`), '爬山那条照常想起来');
    assert.equal(b.ref, `p${ids.early}`, '空白锚在更早的一条上');
    hidden.add(`p${ids.early}`);
    set = await R(core, { settingKey: 'G' }, DEL('上周爬山的事还记得吗'));
    assert.equal(blankOf(set), undefined, '空白之前能用的都用掉了，之后只有眼前这句：找不到锚点');
    hidden.delete(`p${ids.early}`);
    hidden.add(`p${ids.anchor}`);
    set = await R(core, { settingKey: 'G' }, DEL('上周爬山的事还记得吗'));
    b = blankOf(set);
    assert.ok(b);
    assert.equal(b.ref, `p${ids.early}`, '隐藏的不当锚点（也不会被想起来）');
  } finally { await w.cleanup(); }
});

test('§12.4.5 第 8 步：这一行排在最前——想起来的经历再多（≥ 上下文的条数上限），问那几天时它也不会被挤掉', async () => {
  const w = await retrieveCore({ mods: { backup: { replayStatus: () => ({ active: false, gaps: [GAP] }) } } });
  try {
    const { core } = w;
    seedEntity(core, { name: '小鱼', isSelf: true });
    seedSetting(core, 'G', { label: '群' });
    const max = core.config.get().recall.deliberate.maxItems;
    // 空白之前好些人说过爬山的事（每人最多 recall.perEntityMax 条：换不同的人说）
    for (let k = 0; k < max + 4; k++) {
      const who = seedEntity(core, { name: `山友${k}` });
      seedPercept(core, { settingKey: 'G', at: T0 - 6 * DAY + (k + 1) * MIN, actor: who, text: `爬山那天的事${k}` });
    }
    const mate = seedEntity(core, { name: '群友' });
    const anchor = seedPercept(core, { settingKey: 'G', at: T0 - 4 * DAY, actor: mate, text: '今天下雨' });   // 空白之前最近的一条（锚点）
    seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: mate, text: '上周爬山的事还记得吗', addressed: 'to-her' });
    const set = await R(core, { settingKey: 'G' }, DEL('上周爬山的事还记得吗'));
    assert.ok(events(set).length >= max, `想起来的经历够多：${JSON.stringify(set.items.map((c) => c.ref))}`);
    assert.ok(set.items[0]?.blank, JSON.stringify(set.items.map((c) => [c.ref, !!c.blank])));
    assert.equal(set.items[0].ref, `p${anchor}`);
    assert.equal(set.items.filter((c) => c.blank).length, 1);
  } finally { await w.cleanup(); }
});

test('提炼背景：到点没下文的计划（unknown）不是结案——说话人的、证据被召回到的都照样给，写明「后来怎么样没听说」（S2 续，§5.5 第 3、5 条）', async () => {
  const w = await retrieveCore();
  try {
    const { core } = w;
    seedEntity(core, { name: '小鱼', isSelf: true });
    const hong = seedEntity(core, { name: '小红' });
    const ming = seedEntity(core, { name: '阿明' });
    seedSetting(core, 'G', { label: '群' });
    seedSetting(core, 'D', { label: '私聊' });
    const unk = seedAssertion(core, { text: '小红要去拿快递', subjects: [hong], kindHint: 'plan', planStatus: 'unknown', recordedAt: T0 - DAY });
    const closed = ['done', 'cancelled', 'missed'].map((st) =>
      seedAssertion(core, { text: `小红的${st}计划`, subjects: [hong], kindHint: 'plan', planStatus: st, recordedAt: T0 - HOUR }));
    const rows = [{ actor_entity_id: hong }];
    const refs = (list) => list.map((c) => c.ref);
    // 召回里全是她后来说的别的事（占满了每人的条数）：unknown 的计划照样补在最前；结案的不补
    const newer = [0, 1, 2].map((k) => ({ ref: `a${seedAssertion(core, { text: `小红说的第${k}件事`, subjects: [hong], recordedAt: T0 - MIN })}` }));
    const out = refs(withPlans(core, newer, { rows, max: 3 }));
    assert.deepEqual(out, [`a${unk}`, ...newer.map((c) => c.ref)]);
    assert.ok(!closed.some((id) => out.includes(`a${id}`)));
    // 证据路：阿明那条到点没下文的计划，它的证据被召回到了 → 跟在证据后面
    const ev = seedPercept(core, { settingKey: 'D', at: T0 - DAY, actor: ming, text: '明天去驿站', addressed: 'to-her' });
    const mUnk = seedAssertion(core, { text: '阿明要去驿站', subjects: [ming], kindHint: 'plan', planStatus: 'unknown', recordedAt: T0 - DAY,
      sources: [{ speaker: ming, perceivedIn: 'D', at: T0 - DAY, perceptId: ev }] });
    const viaEv = refs(withPlans(core, [{ ref: `p${ev}`, mref: { kind: 'percept', id: ev } }], { rows: [{ actor_entity_id: null }], max: 3 }));
    assert.deepEqual(viaEv, [`p${ev}`, `a${mUnk}`]);
    // 走整条提炼背景：渲染写明后来怎么样没听说（模型据此能写 plan_status=done）
    const seg = seedPercept(core, { settingKey: 'G', at: T0 - MIN, actor: hong, text: '拿到了，昨晚就拿了' });
    const bg = await core.mods.retrieve.backgroundForExtraction(core, { settingKey: 'G', perceptIds: [seg] });
    const b = [...bg.known, ...bg.private].find((x) => x.ref === `a${unk}`);
    assert.ok(b, JSON.stringify(bg));
    assert.match(b.text, /后来怎么样没听说/);
  } finally { await w.cleanup(); }
});

test('词法路挑词：库还小（几十行）时出现过一两次的词不算常见；库里一行都没有的词排在能匹配上的词后面；库大了常见词照样剔掉', async () => {
  let stats = new Map();
  const w = await retrieveCore({ mods: { worker: { termStats: async (core, ts) => new Map(ts.filter((t) => stats.has(t)).map((t) => [t, stats.get(t)])) } } });
  try {
    const { core, calls } = w;
    const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
    seedSetting(core, 'D', { label: '私聊' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: boss, text: '包裹取了吗', addressed: 'to-her' });
    const st = (docs, rows) => ({ idf: Math.log(1 + (rows - docs + 0.5) / (docs + 0.5)), rowFraction: rows ? docs / rows : 0, docs, rows });
    const lexTerms = async () => { await R(core, { settingKey: 'D' }, DEL('包裹取了吗')); return calls.lexicalSearch.at(-1).terms; };
    // 刚装上：13 行，「包裹」在 4 行里（31%）、「取了」在 2 行里——都不是常见词；单字在入库的分词里没有（docs 0）
    const small = { 包裹: st(4, 13), 取了: st(2, 13), 了吗: st(1, 13) };
    const max = core.config.get().recall.lexical.maxTerms;
    const zeros = Array.from({ length: max + 2 }, (_, k) => `零${k}`);
    stats = new Map([...Object.entries(small), ...zeros.map((t) => [t, st(0, 13)])]);
    const terms0 = await lexTerms();
    for (const t of ['包裹', '取了']) assert.ok(terms0.includes(t), `${t} 留着：${JSON.stringify(terms0)}`);
    const firstZero = terms0.findIndex((t) => stats.get(t)?.docs === 0);
    const lastLive = terms0.findLastIndex((t) => (stats.get(t)?.docs ?? 1) > 0);
    assert.ok(firstZero < 0 || lastLive < firstZero, `一行都没有的词排在后面：${JSON.stringify(terms0)}`);
    // 库大了：同样的比例、行数也多 → 常见，剔掉；只给比例的统计（没有 docs）照旧按比例剔
    stats = new Map([['包裹', st(5, 100_000)], ['取了', st(4000, 100_000)], ['了吗', { idf: 0.1, rowFraction: 0.5 }]]);
    const terms1 = await lexTerms();
    assert.ok(terms1.includes('包裹'));
    assert.ok(!terms1.includes('取了') && !terms1.includes('了吗'), JSON.stringify(terms1));
  } finally { await w.cleanup(); }
});
