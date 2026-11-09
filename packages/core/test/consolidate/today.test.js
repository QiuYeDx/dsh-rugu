// 今天到目前为止（§5.7，评审:UV-07）。牵头 S23b：十分钟前她在群里聊过一件事，主人私聊问「你刚才在群里跟他们聊啥呢」→ 答得上（按分寸）。
// 这里测 consolidate 的那一段：对话空闲 10 分钟后有一条小结，它是普通的记忆单元（来源 = 那段对话的每条感知、规范经
// inheritNorm 复述类继承 → 「谁知道」= 那个场合的受众），之后 context 的 todaySoFar 层取它、discretion 判能不能讲。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, reply, T0, MIN, HOUR } from './world.js';
import { FakeLLM, FakeBudget } from '../fakes/index.js';

function chat(w, s, people, at) {
  const [a, b] = people;
  return [
    w.percept(s, { at, actor: a, text: '显卡又涨价了' }),
    w.percept(s, { at: at + MIN, actor: b, text: '我想买新显卡，太贵了' }),
    w.percept(s, { at: at + 2 * MIN, self: true, text: '等双十一再看看吧' }),
    w.percept(s, { at: at + 3 * MIN, actor: a, text: '有道理' }),
  ];
}

test('S23b：群里聊完十分钟后有一句小结，主人在私聊问「刚才在群里聊啥」时能想起来', async () => {
  const llm = new FakeLLM({ script: { summary: [reply((req, text) => {
    assert.ok(text.includes('显卡又涨价了') && text.includes('我：等双十一再看看吧'), '提示词里有这段对话，她自己的话标成「我」');
    return [{ type: 'summary', text: '和大家聊显卡涨价，我建议等双十一再看看' }];
  })] } });
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const G = w.setting({ label: '某游戏群', exposure: 1 });
    const a = w.entity({ name: '阿明' });
    const b = w.entity({ name: '小红' });
    const pids = chat(w, G, [a, b], T0);
    // 还在聊（最后一条 3 分钟前）：不写
    clock.set(T0 + 8 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 0);
    // 空闲满 10 分钟
    clock.set(T0 + 14 * MIN);
    const r = await core.mods.consolidate.todaySoFar(core, { at: core.now() });
    assert.equal(r.written, 1);
    const [{ id, ep }] = w.rec.writeEpisode;
    assert.equal(ep.kind, 'summary');
    assert.equal(ep.settingKey, G.key);
    assert.equal(ep.narrative, '和大家聊显卡涨价，我建议等双十一再看看');
    assert.ok(!ep.narrative.includes('某游戏群') && !ep.header.includes('某游戏群'), '场合名不进小结（不进嵌入文本，§7.2）');
    assert.deepEqual(ep.sources.map((s) => s.perceptId), pids, '来源是这段对话的每一条感知');
    assert.deepEqual(ep.sources.map((s) => s.mode), ['overheard', 'overheard', 'self_generated', 'overheard']);
    assert.deepEqual([...ep.participants].sort(), [w.self, a, b].sort());
    assert.equal(ep.tStart, T0);
    assert.equal(ep.tEnd, T0 + 3 * MIN);
    const inh = w.rec.inheritNorm.at(-1);
    assert.equal(inh.ref, `e${id}`);
    assert.equal(inh.derivation, 'quote', '复述类：「谁知道」= 证据的交集 = 这个场合的受众');
    assert.deepEqual(inh.evidence, pids.map((p) => `p${p}`));
    // LLM：用途 summary，第一句是数据声明，提示词里没有场合名和场合键
    const call = llm.callsFor('summary')[0];
    assert.ok(call.system.startsWith('以下全部是数据'));
    const prompt = call.system + call.messages[0].content;
    assert.ok(!prompt.includes('某游戏群') && !prompt.includes(G.key));
    assert.equal(w.budget.used.summary, 1);
    // 小结在库里：t_end 在十分钟前，归在那个群下面（context 的 todaySoFar 层从这里取）
    const row = core.store.get("SELECT setting_key, ep_kind, t_end FROM episodes WHERE ep_kind = 'summary'");
    assert.equal(row.setting_key, G.key);
    assert.ok(core.now() - row.t_end <= 11 * MIN);
    // 再跑一次不重复
    clock.minutes(1);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 0);
    // 后来又聊了一段：新的小结只覆盖新的感知
    llm.push('summary', [{ type: 'summary', text: '又聊了几句' }]);
    const more = [w.percept(G, { at: T0 + 30 * MIN, actor: a, text: '周末开黑吗' }), w.percept(G, { at: T0 + 31 * MIN, self: true, text: '来呀' })];
    clock.set(T0 + 45 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    assert.deepEqual(w.rec.writeEpisode[1].ep.sources.map((s) => s.perceptId), more);
    w.logger.assertNoText('显卡', '双十一', '阿明', '开黑');
  } finally { await w.cleanup(); }
});

test('她没参与（只是旁听）的场合不写小结', async () => {
  const w = await world();
  try {
    const { core, clock } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    w.percept(G, { at: T0, actor: a, text: '今天好热' });
    w.percept(G, { at: T0 + MIN, actor: a, text: '是啊' });
    clock.set(T0 + 30 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 0);
    assert.equal(w.llm.calls.length, 0);
  } finally { await w.cleanup(); }
});

test('§12.7：隐藏之后才写出来的小结一写出来就跟着对别人隐藏（不等 tick 的兜底扫描）；被「忘掉」的消息不写进小结', async () => {
  const llm = new FakeLLM({ script: { summary: [reply((req, text) => {
    assert.ok(!text.includes('别记住这句'), '忘掉的消息不进小结的提示词');
    return [{ type: 'summary', text: '和大家聊了显卡，我建议等双十一' }];
  })] } });
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const G = w.setting({ label: '某游戏群', exposure: 1 });
    const a = w.entity({ name: '阿明' });
    const b = w.entity({ name: '小红' });
    const pids = chat(w, G, [a, b], T0);
    const gone = w.percept(G, { at: T0 + 4 * MIN, actor: b, text: '别记住这句' });
    // 主人把一条消息对别人隐藏、另一条（本人要求、主人批准）忘掉：这时还没有小结
    core.store.run("INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES ('percept', ?, 'hidden', 'owner', ?)", pids[1], T0 + 5 * MIN);
    core.store.run("INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES ('percept', ?, 'forgotten', 'owner', ?)", gone, T0 + 5 * MIN);
    clock.set(T0 + 20 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    const [{ id, ep }] = w.rec.writeEpisode;
    assert.deepEqual(ep.sources.map((x) => x.perceptId), pids, '隐藏的照样写进小结（她还记得）；忘掉的不写');
    const sup = core.store.get("SELECT state, reason FROM suppressions WHERE owner_kind = 'episode' AND owner_id = ?", id);
    assert.equal(sup?.state, 'hidden', '汇总了被隐藏的消息的小结：一写出来就对别人隐藏');
    assert.equal(sup.reason, `cascade:p${pids[1]}`, '记着是从哪条来的（那条恢复时一起恢复）');
  } finally { await w.cleanup(); }
});

test('预算紧：不调 LLM，直接拼接她自己说的话和话题词', async () => {
  const w = await world({ budget: new FakeBudget({ perUse: { summary: 0 } }) });
  try {
    const { core, clock } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const b = w.entity({ name: '乙' });
    chat(w, G, [a, b], T0);
    clock.set(T0 + 20 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    assert.equal(w.llm.calls.length, 0);
    const text = w.rec.writeEpisode[0].ep.narrative;
    assert.match(text, /显卡/, '在 ≥ 2 条里出现的词是话题词');
    assert.match(text, /我说「等双十一再看看吧」/);
    assert.ok([...text].length <= 80);
  } finally { await w.cleanup(); }
});

test('LLM 挂了、清洗不可用：照样写，用退路；清洗不可用时一个字都不发给模型', async () => {
  const llm = new FakeLLM().fail('summary');
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const b = w.entity({ name: '乙' });
    chat(w, G, [a, b], T0);
    clock.set(T0 + 20 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    assert.equal(llm.calls.length, 1);
  } finally { await w.cleanup(); }
  const w2 = await world({ mods: { intake: { sanitizeForPrompt: () => { throw new Error('down'); } } } });
  try {
    const { core, clock } = w2;
    const G = w2.setting();
    const a = w2.entity({ name: '甲' });
    const b = w2.entity({ name: '乙' });
    chat(w2, G, [a, b], T0);
    clock.set(T0 + 20 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    assert.equal(w2.llm.calls.length, 0, 'fail closed：不清洗就不发');
  } finally { await w2.cleanup(); }
});

test('私下读到的内容单独一条小结；心里想的、撤回的、系统行不进小结', async () => {
  const llm = new FakeLLM({ fallback: { summary: [{ type: 'summary', text: '小结' }] } });
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const up = w.entity({ name: '作者' });
    const shared = [
      w.percept(G, { at: T0, actor: a, text: '看到那个视频没' }),
      w.percept(G, { at: T0 + MIN, self: true, text: '还没看' }),
    ];
    w.percept(G, { at: T0 + MIN, actor: a, text: '撤回的话', textState: 'retracted' });
    w.percept(G, { at: T0 + MIN, actor: a, text: '拍了拍我', kind: 'action', evidential: false });
    w.percept(G, { at: T0 + 2 * MIN, self: true, kind: 'self-thought', visibleTo: 'her-only', text: '他今天好像不开心' });
    const priv = [
      w.percept(G, { at: T0 + 3 * MIN, actor: up, kind: 'content', visibleTo: 'her-only', standing: 'material', text: '视频：新版本玩法讲解' }),
      w.percept(G, { at: T0 + 4 * MIN, actor: up, kind: 'content', visibleTo: 'her-only', standing: 'material', text: '视频简介：三种新角色' }),
    ];
    clock.set(T0 + 20 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 2);
    const [s1, s2] = w.rec.writeEpisode.map((x) => x.ep);
    assert.deepEqual(s1.sources.map((s) => s.perceptId), shared);
    assert.deepEqual(s2.sources.map((s) => s.perceptId), priv);
    assert.deepEqual(s2.sources.map((s) => s.mode), ['read', 'read']);
    const prompts = llm.calls.map((c) => c.messages[0].content).join('\n');
    assert.ok(!prompts.includes('不开心') && !prompts.includes('撤回的话') && !prompts.includes('拍了拍'));
  } finally { await w.cleanup(); }
});

test('一次性的场合归到它的 parent 下面一起小结', async () => {
  const llm = new FakeLLM({ fallback: { summary: [{ type: 'summary', text: '在评论区回了几条' }] } });
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const P = w.setting({ label: '评论区', exposure: 3 });
    const t1 = w.setting({ stability: 'transient', parentKey: P.key, exposure: 3 });
    const t2 = w.setting({ stability: 'transient', parentKey: P.key, exposure: 3 });
    const a = w.entity({ name: '网友' });
    w.percept(t1, { at: T0, actor: a, text: '这个好看' });
    w.percept(t1, { at: T0 + MIN, self: true, text: '谢谢喜欢' });
    w.percept(t2, { at: T0 + 2 * MIN, actor: a, text: '下一期呢' });
    w.percept(t2, { at: T0 + 3 * MIN, self: true, text: '在做啦' });
    clock.set(T0 + 30 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    assert.equal(w.rec.writeEpisode[0].ep.settingKey, P.key);
    assert.equal(w.rec.writeEpisode[0].ep.sources.length, 4);
  } finally { await w.cleanup(); }
});

test('证据后来才评估完：小结的规范重算一次；证据的规范又变了再算一次', async () => {
  const llm = new FakeLLM({ fallback: { summary: [{ type: 'summary', text: '小结' }] } });
  const w = await world({ llm });
  try {
    const { core, clock } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const b = w.entity({ name: '乙' });
    const pids = chat(w, G, [a, b], T0);
    clock.set(T0 + 20 * MIN);
    await core.mods.consolidate.todaySoFar(core, { at: core.now() });
    assert.equal(w.rec.inheritNorm.length, 1);
    // 证据还没评估：不重算
    clock.minutes(1);
    await core.mods.consolidate.todaySoFar(core, { at: core.now() });
    assert.equal(w.rec.inheritNorm.length, 1);
    // 提炼写了规范
    for (const p of pids) core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", p);
    clock.minutes(1);
    await core.mods.consolidate.todaySoFar(core, { at: core.now() });
    assert.equal(w.rec.inheritNorm.length, 2);
    clock.minutes(1);
    await core.mods.consolidate.todaySoFar(core, { at: core.now() });
    assert.equal(w.rec.inheritNorm.length, 2, '没变就不再算');
    // 其中一条被收紧（撤回 → soft）：规范的版本变了
    core.store.run("INSERT INTO flow_norms(owner_kind, owner_id, version, restriction, updated_at) VALUES ('percept', ?, 2, 'soft', ?)", pids[0], core.now());
    clock.minutes(1);
    await core.mods.consolidate.todaySoFar(core, { at: core.now() });
    assert.equal(w.rec.inheritNorm.length, 3);
    assert.deepEqual(w.rec.inheritNorm.at(-1).evidence, pids.map((p) => `p${p}`));
  } finally { await w.cleanup(); }
});

test('超过回看时长（24 小时）的旧感知不写小结；只读库不做', async () => {
  const w = await world();
  try {
    const { core, clock } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const b = w.entity({ name: '乙' });
    chat(w, G, [a, b], T0);
    clock.set(T0 + 30 * HOUR);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 0);
    core.readOnly = true;
    assert.deepEqual(await core.mods.consolidate.todaySoFar(core, { at: core.now() }), { written: 0 });
    core.readOnly = false;
  } finally { await w.cleanup(); }
});

test('S23b（按分寸）：群里那段的小结只归在那个群下；里面有人说了「别外传」的，小结的规范跟着最严；主人在私聊问的那句不混进群的小结', async () => {
  const llm = new FakeLLM({ fallback: { summary: (req) => [{ type: 'summary', text: req.messages[0].content.includes('刚才在群里') ? '主人私聊问我刚才聊了啥' : '和大家聊了团建的安排，我说想去爬山' }] } });
  const w = await world({ llm });
  try {
    const { core, clock, norms } = w;
    const G = w.setting({ label: '某工作群', exposure: 1 });
    const D = w.setting({ label: '私聊', exposure: 0 });
    const owner = w.entity({ name: '主人', authority: 'principal', closeness: 1 });
    const a = w.entity({ name: '同事甲' });
    const pids = [
      w.percept(G, { at: T0, actor: a, text: '团建去哪，先别外传，还没定', assessed: true }),
      w.percept(G, { at: T0 + MIN, self: true, text: '我想去爬山', assessed: true }),
      w.percept(G, { at: T0 + 2 * MIN, actor: a, text: '好主意', assessed: true }),
    ];
    norms.set(`p${pids[0]}`, { unassessed: false, version: 1, restriction: 'soft', involvesOthers: true, allow: null, deny: null, sensitivity: 0.4, originExposure: { exposureRank: 1, persistenceRank: 1 } });
    // 十分钟后：群里那段空闲了 → 小结；主人这时在私聊问
    clock.set(T0 + 12 * MIN);
    const ask = w.percept(D, { at: core.now(), actor: owner, text: '你刚才在群里跟他们聊啥呢', addressed: 'to-her' });
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1, '私聊还在进行（也还没她参与），只写群的');
    const [{ id, ep }] = w.rec.writeEpisode;
    assert.equal(ep.settingKey, G.key);
    assert.deepEqual(ep.sources.map((s) => s.perceptId), pids);
    assert.ok(!ep.sources.some((s) => s.perceptId === ask));
    assert.equal(w.norms.get(`e${id}`).restriction, 'soft', '写入时的规范先取证据里最严的（之后 inheritNorm 定最终的）');
    assert.equal(w.norms.get(`e${id}`).involvesOthers, true);
    const inh = w.rec.inheritNorm.find((x) => x.ref === `e${id}`);
    assert.equal(inh.derivation, 'quote');
    // 她在私聊回了一句之后私聊也空闲了：私聊另写一条，归在私聊下
    w.percept(D, { at: core.now() + MIN, self: true, text: '在聊团建呢' });
    clock.set(T0 + 30 * MIN);
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: core.now() })).written, 1);
    assert.equal(w.rec.writeEpisode[1].ep.settingKey, D.key);
    assert.ok(!w.rec.writeEpisode[1].ep.sources.some((s) => pids.includes(s.perceptId)));
  } finally { await w.cleanup(); }
});
