// D168 小修：后台模型这一刻用不了（端口的可选 ready(use) 为 false：配错了又没有顶上的、主人关了后台模型）时，
// 第一眼、第二段评估、外发审视在要预算之前就按「没有模型」处理，不白占当天的放行名额；
// 第二段评估走和「评估没成」同一条路（D169 的 onFailure：默认照给）；外发审视审不了，公开目标照旧不发（fail closed）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, appraiseReply } from './world.js';
import { FakeLLM } from '../fakes/index.js';
import { openWorld, platformSeeds, glancer } from '../scenarios/presence-world.js';
import { llmReady } from '../../src/discretion/util.js';

const usesAsked = (budget) => budget.metas.map((m) => m.use);

test('llmReady：没有端口 → false；端口没有 ready → 能用；ready 说不行 → false；ready 出错按能用算', () => {
  assert.equal(llmReady({ ports: {} }, 'glance'), false);
  assert.equal(llmReady({ ports: { llm: { complete() {} } } }, 'glance'), true);
  const seen = [];
  assert.equal(llmReady({ ports: { llm: { complete() {}, ready: (u) => { seen.push(u); return false; } } } }, 'appraise'), false);
  assert.deepEqual(seen, ['appraise'], '按用途问');
  assert.equal(llmReady({ ports: { llm: { complete() {}, ready: () => { throw new Error('x'); } } } }, 'review'), true);
});

test('第二段评估：端口说用不了 → 不要预算、不调模型，照「评估没成」处理（D169 默认照给：主人的上限照旧、带来源标签）', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply('share') } });
  llm.ready = () => false;
  const W = await makeWorld({ name: 'd168-s2', llm });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const pal = W.person('小刚', { closeness: 0.4 });
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const y = W.setting('群Y', 'group');
    W.presence(y.key, [W.me, owner, pal], W.now(), 'recent-speakers', true);
    const p = W.percept({ settingKey: dm.key, actor: owner, text: '我下个月要换工作了', addressed: 'to-her' });
    // 她第一眼看过（有一句不带细节的说法），照给时说个大概用它（同 D169 的场景）
    W.core.store.run(`INSERT INTO glances(percept_id, setting_key, state, sens, limit_kind, quote, quote_ok, about, asks, mixed, vague, created_at)
                      SELECT id, setting_key, 'done', 0.3, 'none', '', 0, 'speaker', 0, 0, '他最近工作上有变动', ? FROM percepts WHERE id = ?`, W.now(), p);
    W.assess(p, { restriction: 'none', sensitivity: 0.3, involvesOthers: false, attribute: '工作' });
    W.ownerRule({ attribute: '工作' }, 'share_vague');
    const items = await W.gate([{ kind: 'percept', id: p }], W.target(y.key, { trigger: pal }), { deadlineMs: 3000 });
    assert.ok(!usesAsked(W.budget).includes('appraise'), '没占第二段评估的名额');
    assert.equal(llm.callsFor('appraise').length, 0);
    const row = W.appraisals().find((r) => r.stage === 2);
    assert.equal(row.reason, 'unavailable:no-llm:give', '和「没有模型」同一个原因码、同一条路');
    assert.equal(items.length, 1, '照给（onFailure 默认 give）');
    assert.equal(items[0].verdict, 'share_vague', '主人定的上限照旧');
  } finally { await W.cleanup(); }
});

test('外发审视：端口说用不了 → 不动外发审视的预留，审不了，公开目标照旧不发', async () => {
  const llm = new FakeLLM({ fallback: { review: [{ verdict: 'speak', reflection: '', reason: '测试' }] } });
  llm.ready = () => false;
  const W = await makeWorld({ name: 'd168-review', llm });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const post = W.setting('公开帖子（不能存草稿）', 'public', { capabilities: { preSendGate: true, canHold: false } });
    const fact = W.assertion({ text: '主人在找新工作，下周三去面试', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, fact, { sensitivity: 0.6, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
    W.session('s-dm', dm.key, { ledger: [W.ref(fact)] });
    W.adapter();
    const reserve = W.budget.reserve;
    const a = await W.D.appraise(W.core, { channel: { targetSettingId: post.sid, persistence: 'once' }, text: ['大家晚上好'], origin: { path: 'tool', sessionId: 's-dm', homeSettingId: dm.sid } });
    assert.notEqual(a.verdict, 'speak', '审不了：公开目标不发（fail closed）');
    assert.equal(llm.callsFor('review').length, 0);
    assert.ok(!usesAsked(W.budget).includes('review'));
    assert.equal(W.budget.reserve, reserve, '外发审视的预留一次都没动');
  } finally { await W.cleanup(); }
});

test('第一眼：端口说用不了 → 不要预算、不调模型，这一次按没看成算（glance.unavailable）', async () => {
  const llm = new FakeLLM({ fallback: { glance: glancer() } });
  llm.ready = () => false;
  const w = await openWorld({ seed: platformSeeds()[0], name: 'd168-glance', config: { mode: { byAttributes: { closed: 'live', public: 'live' } } }, llm });
  try {
    const a = w.say('oneOnOne', 'principal', '周六一起去骑车吗', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.equal(llm.callsFor('glance').length, 0);
    assert.ok(!w.ports.budget.metas.map((m) => m.use).includes('glance'), '没占第一眼的名额');
    assert.equal(w.core.store.get('SELECT state FROM glances WHERE percept_id = ?', w.perceptOf(a).id)?.state, 'failed');
    assert.ok(Number(w.core.store.get("SELECT SUM(value) AS v FROM metrics WHERE name = 'discretion.glance.unavailable'")?.v ?? 0) >= 1);
    // 恢复了：下一次合格的事件照常看
    llm.ready = () => true;
    w.say('oneOnOne', 'principal', '九点桥头见', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    assert.ok(llm.callsFor('glance').length >= 1);
  } finally { await w.close(); }
});
