// 场合的故事线（§5.8）、学到的场合规矩（单调性，§5.6）、实体社区和主题摘要（§7.7 第 7 步）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, reply, tagsIn, T0, MIN, HOUR, DAY } from './world.js';
import { FakeLLM } from '../fakes/index.js';
import { partition, rebuildCommunities } from '../../src/consolidate/communities.js';
import { settingsNeedingStoryline } from '../../src/consolidate/storyline.js';
import { newRun } from '../../src/consolidate/util.js';

test('updateStoryline：从水位线之后的情节接着写，写完推进水位线；带规范、嵌入和痕迹；一次性的场合不做', async () => {
  const seen = [];
  // 每个场合的编号在【s1】里，经历的编号是 [s1e1]
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => {
    seen.push(text);
    assert.deepEqual(tagsIn(text, 's1e'), tagsIn(text, 's1e').map((_, i) => `s1e${i + 1}`));
    return [...text.matchAll(/【(s\d+)】/g)].map((m) => ({ type: 'storyline', setting: m[1], text: `故事线 ${seen.length}` }));
  }) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting({ label: '某游戏群' });
    const a = w.entity({ name: '阿明' });
    const e1 = w.episode(G, [[a, '团建去哪', T0], ['self', '去爬山吧', T0 + MIN]], { header: '10-31 大家在商量团建' });
    const e2 = w.episode(G, [[a, '那就周六', T0 + HOUR]], { header: '10-31 定了周六' });
    assert.deepEqual(await core.mods.consolidate.updateStoryline(core, G.key), { updated: true });
    const row = core.store.get('SELECT * FROM storylines WHERE setting_key = ?', G.key);
    assert.equal(row.text, '故事线 1');
    assert.equal(row.version, 1);
    assert.equal(row.watermark_percept, Math.max(...e2.pids));
    assert.ok(seen[0].includes('大家在商量团建') && seen[0].includes('（从头写）'));
    assert.ok(!seen[0].includes('某游戏群'), '场合名不给模型');
    const inh = w.rec.inheritNorm.at(-1);
    assert.equal(inh.ref, `s${row.id}`);
    assert.equal(inh.derivation, 'quote');
    assert.deepEqual(inh.evidence, [e1.ref, e2.ref]);
    assert.equal(w.rec.enqueueEmbed.at(-1).ref, `s${row.id}`);
    assert.equal(w.rec.enqueueEmbed.at(-1).o.layer, 'memory');
    assert.equal(w.rec.addTrace.at(-1).ref, `s${row.id}`);
    // 没有新情节：不调 LLM
    assert.deepEqual(await core.mods.consolidate.updateStoryline(core, G.key), { updated: false });
    assert.equal(seen.length, 1);
    // 新情节：带着原来的故事线增量写，旧版本自己也算证据
    const e3 = w.episode(G, [[a, '周六下雨了改周日', T0 + DAY]], { header: '11-01 改到周日' });
    await core.mods.consolidate.updateStoryline(core, G.key);
    assert.ok(seen[1].includes('原来的故事线：故事线 1') && seen[1].includes('改到周日') && !seen[1].includes('商量团建'));
    assert.deepEqual(w.rec.inheritNorm.at(-1).evidence, [`s${row.id}`, e3.ref]);
    assert.equal(core.store.get('SELECT version FROM storylines WHERE id = ?', row.id).version, 2);
    // 一次性的场合
    const T = w.setting({ stability: 'transient' });
    w.episode(T, [[a, '一条评论', T0]]);
    assert.deepEqual(await core.mods.consolidate.updateStoryline(core, T.key), { updated: false });
    assert.equal(seen.length, 2);
  } finally { await w.cleanup(); }
});

test('故事线每 rebuildEvery 个版本整体重写一次：规范只按这次用到的情节重算', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(s\d+)】/g)].map((m) => ({ type: 'storyline', setting: m[1], text: '新故事线' }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    for (let v = 1; v <= 10; v++) {
      w.episode(G, [[a, `第 ${v} 件事`, T0 + v * HOUR]]);
      await core.mods.consolidate.updateStoryline(core, G.key);
    }
    const row = core.store.get('SELECT * FROM storylines WHERE setting_key = ?', G.key);
    assert.equal(row.version, 10);
    const last = w.rec.inheritNorm.at(-1);
    assert.ok(!last.evidence.includes(`s${row.id}`), '第 10 版整体重写：旧版本不再是证据');
    assert.equal(last.evidence.length, 10);
    assert.ok(llm.calls.at(-1).messages[0].content.includes('（从头写）'));
  } finally { await w.cleanup(); }
});

test('学场合的规矩：只收更严的（soft / strict），要能指到经历；source=learned、authority=none；报 foreign_write；重复的不再写', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [
    { type: 'storyline', setting: 's1', text: '工作群，大家在讨论项目' },
    { type: 'rule', setting: 's1', text: '群里的内部事务不外传', restriction: 'strict', evidence: ['s1e1'] },
    { type: 'rule', setting: 's1', text: '这里什么都能说', restriction: 'none', evidence: ['s1e1'] },
    { type: 'rule', setting: 's1', text: '没有依据的规矩', restriction: 'soft', evidence: ['s9e9'] },
  ]) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting({ label: '工作群' });
    const a = w.entity({ name: '同事' });
    w.episode(G, [[a, '这是工作群，内部别外传', T0]]);
    await core.mods.consolidate.updateStoryline(core, G.key);
    assert.equal(w.rec.writeSettingRule.length, 1);
    const [r] = w.rec.writeSettingRule;
    assert.equal(r.key, G.key);
    assert.deepEqual(r.rule, { text: '群里的内部事务不外传', restriction: 'strict' });
    assert.deepEqual({ source: r.ctx.source, authority: r.ctx.authority, author: r.ctx.authorEntityId }, { source: 'learned', authority: 'none', author: null });
    assert.equal(w.rec.notify.filter((n) => n.kind === 'foreign_write').length, 1);
    // 第二次：已有的规矩写进提示词，同样的不再写
    w.episode(G, [[a, '再说一遍别外传', T0 + DAY]]);
    await core.mods.consolidate.updateStoryline(core, G.key);
    assert.ok(llm.calls.at(-1).messages[0].content.includes('已有的规矩：群里的内部事务不外传'));
    assert.equal(w.rec.writeSettingRule.length, 1);
  } finally { await w.cleanup(); }
});

test('故事线：被隐藏的情节不当素材；LLM 失败时不推进水位线', async () => {
  const llm = new FakeLLM().fail('sleep');
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const e1 = w.episode(G, [[a, '秘密的事', T0]]);
    const e2 = w.episode(G, [[a, '普通的事', T0 + HOUR]]);
    w.hidden.add(e1.ref);
    assert.deepEqual(await core.mods.consolidate.updateStoryline(core, G.key), { updated: false });
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM storylines').n, 0);
    assert.ok(!llm.calls[0].messages[0].content.includes('秘密的事'));
    llm.push('sleep', [{ type: 'storyline', setting: 's1', text: '大家聊了普通的事' }]);
    assert.deepEqual(await core.mods.consolidate.updateStoryline(core, G.key), { updated: true });
    assert.deepEqual(w.rec.inheritNorm.at(-1).evidence, [e2.ref]);
  } finally { await w.cleanup(); }
});

test('社区划分：确定性的标签传播；她自己和场合实体不进图', async () => {
  const w = await world();
  try {
    const { core } = w;
    const G = w.setting();
    const [a, b, c, d, e, f] = ['甲', '乙', '丙', '丁', '戊', '己'].map((n) => w.entity({ name: n }));
    const tri = (x, y, z, k) => w.fact({ subjects: [x], objectEntityId: y, mentions: [z, w.self, G.entityId], text: `事 ${k}`, recordedAt: T0 });
    tri(a, b, c, 1); tri(b, c, a, 2); tri(c, a, b, 3);
    tri(d, e, f, 4); tri(e, f, d, 5); tri(f, d, e, 6);
    const parts = partition(core, { since: T0 - DAY, rounds: 20, minMembers: 3, maxMembers: 12 });
    assert.deepEqual(parts, [[a, b, c], [d, e, f]]);
    assert.deepEqual(partition(core, { since: T0 - DAY, rounds: 20, minMembers: 3, maxMembers: 12 }), parts, '同样的输入同样的结果');
  } finally { await w.cleanup(); }
});

test('社区：变了的才调 LLM；成员没变也没新事实的保留；被取代的旧社区退休并删嵌入', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(c\d+)】/g)].map((m) => ({ type: 'community', id: m[1], label: '团建', summary: '大家在商量团建去哪' }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting();
    const [a, b, c, d] = ['甲', '乙', '丙', '丁'].map((n) => w.entity({ name: n }));
    const src = (at) => [{ perceptId: w.percept(G, { at, actor: a, text: 'x' }), speaker: a, at }];
    w.fact({ subjects: [a], objectEntityId: b, mentions: [c], text: '甲约乙丙去爬山', recordedAt: T0, sources: src(T0) });
    w.fact({ subjects: [b], objectEntityId: c, mentions: [a], text: '乙说丙也去', recordedAt: T0, sources: src(T0) });
    const r1 = await rebuildCommunities(core, { run: newRun(3), at: T0 + HOUR });
    assert.deepEqual(r1, { built: 1, kept: 0, retired: 0 });
    const c1 = core.store.get('SELECT * FROM communities WHERE is_current = 1');
    assert.equal(c1.label, '团建');
    assert.equal(c1.setting_key, G.key, '证据都来自同一个场合');
    assert.deepEqual(JSON.parse(c1.members_json), [a, b, c]);
    assert.equal(w.rec.inheritNorm.at(-1).ref, `c${c1.id}`);
    assert.equal(w.rec.inheritNorm.at(-1).derivation, 'quote');
    // 没变：不调 LLM
    const calls = llm.calls.length;
    assert.deepEqual(await rebuildCommunities(core, { run: newRun(3), at: T0 + 2 * HOUR }), { built: 0, kept: 1, retired: 0 });
    assert.equal(llm.calls.length, calls);
    // 丁加进来了：新社区取代旧的
    w.fact({ subjects: [d], objectEntityId: a, mentions: [b], text: '丁也要去', recordedAt: T0 + 3 * HOUR, sources: src(T0 + 3 * HOUR) });
    w.fact({ subjects: [d], objectEntityId: c, text: '丁和丙一起', recordedAt: T0 + 3 * HOUR, sources: src(T0 + 3 * HOUR) });
    const r3 = await rebuildCommunities(core, { run: newRun(3), at: T0 + 4 * HOUR });
    assert.equal(r3.built, 1);
    assert.equal(core.store.get('SELECT is_current FROM communities WHERE id = ?', c1.id).is_current, 0);
    assert.deepEqual(w.rec.dropEmbeddings.at(-1), [`c${c1.id}`]);
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM communities').n, 2, '旧的行和规范留着');
  } finally { await w.cleanup(); }
});

/** 主人在管理页隐藏一条记忆：admin 的替身记下，suppressions 表里也有一行（consolidate 按隐藏的时间判断旧摘要要不要重写）。 */
function hide(w, ref, at) {
  w.hidden.add(ref);
  const kind = ref[0] === 'e' ? 'episode' : 'assertion';
  w.core.store.run("INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES (?, ?, 'hidden', 'owner', ?)", kind, Number(ref.slice(1)), at);
}

test('故事线写好之后有情节被隐藏：整体重写（只用没被隐藏的），旧版本不再当证据；能用的全被隐藏了就清空并删嵌入', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(s\d+)】/g)].map((m) => ({ type: 'storyline', setting: m[1], text: `故事线 ${llm.calls.length}` }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const e1 = w.episode(G, [[a, '甲说了件私事', T0]]);
    const e2 = w.episode(G, [[a, '大家约饭', T0 + HOUR]]);
    await core.mods.consolidate.updateStoryline(core, G.key);
    const row = core.store.get('SELECT * FROM storylines WHERE setting_key = ?', G.key);
    assert.equal(settingsNeedingStoryline(core).length, 0);
    hide(w, e1.ref, row.updated_at + 1);
    assert.deepEqual(settingsNeedingStoryline(core), [G.key], '没有新情节也要重写');
    w.clock.set(T0 + DAY);
    assert.deepEqual(await core.mods.consolidate.updateStoryline(core, G.key), { updated: true });
    const prompt = llm.calls.at(-1).messages[0].content;
    assert.ok(prompt.includes('（从头写）') && !prompt.includes('私事'));
    assert.deepEqual(w.rec.inheritNorm.at(-1).evidence, [e2.ref], '旧版本带着被隐藏的内容，不再是证据');
    assert.equal(settingsNeedingStoryline(core).length, 0, '重写之后不再重复');
    // 剩下的也被隐藏了：清空
    hide(w, e2.ref, core.now() + 1);
    w.clock.set(T0 + 2 * DAY);
    const calls = llm.calls.length;
    await core.mods.consolidate.updateStoryline(core, G.key);
    assert.equal(llm.calls.length, calls, '没有素材就不调 LLM');
    const after = core.store.get('SELECT text, version FROM storylines WHERE setting_key = ?', G.key);
    assert.equal(after.text, '');
    assert.equal(after.version, row.version + 2);
    assert.deepEqual(w.rec.dropEmbeddings.at(-1), [`s${row.id}`]);
  } finally { await w.cleanup(); }
});

test('社区写好之后有事实被隐藏：不再原样保留，重写；重写不成（LLM 挂了）就退休，不让隐藏的内容留在主题摘要里', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => [...text.matchAll(/【(c\d+)】/g)].map((m) => ({ type: 'community', id: m[1], label: '爬山', summary: text.includes('私事') ? '有私事' : '大家约爬山' }))) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    const G = w.setting();
    const [a, b, c] = ['甲', '乙', '丙'].map((n) => w.entity({ name: n }));
    const f1 = w.fact({ subjects: [a], objectEntityId: b, mentions: [c], text: '甲约乙丙去爬山', recordedAt: T0 });
    const f2 = w.fact({ subjects: [b], objectEntityId: c, mentions: [a], text: '乙和丙说了件私事', recordedAt: T0 });
    await rebuildCommunities(core, { run: newRun(3), at: T0 + HOUR });
    const c1 = core.store.get('SELECT * FROM communities WHERE is_current = 1');
    hide(w, f2.ref, T0 + 2 * HOUR);
    const r = await rebuildCommunities(core, { run: newRun(3), at: T0 + 3 * HOUR });
    assert.equal(r.kept, 0);
    assert.equal(r.built, 1);
    const c2 = core.store.get('SELECT * FROM communities WHERE is_current = 1');
    assert.notEqual(c2.id, c1.id);
    assert.equal(c2.summary, '大家约爬山');
    assert.ok(!llm.calls.at(-1).messages[0].content.includes('私事'));
    // 又隐藏了一条，这次 LLM 挂了：旧的退休
    hide(w, f1.ref, T0 + 4 * HOUR);
    w.fact({ subjects: [a], objectEntityId: c, mentions: [b], text: '甲和丙又聊了', recordedAt: T0 + 4 * HOUR });
    llm.fail('sleep');
    const r2 = await rebuildCommunities(core, { run: newRun(3), at: T0 + 5 * HOUR });
    assert.equal(r2.skipped, 'llm-failed');
    assert.equal(r2.retired, 1);
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM communities WHERE is_current = 1').n, 0);
  } finally { await w.cleanup(); }
});
