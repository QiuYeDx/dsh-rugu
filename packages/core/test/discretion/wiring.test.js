// discretion 接到真模块的那几处（阶段 B 交付说明里的缺口）：
//   - 告诉过谁的全库比对任务（§5.6、§9.5）用真的 lang（查询词、区分性词）和真的 worker（termStats、词法、查询嵌入、稠密扫描），
//     不只是对着替身；
//   - 外发初筛（§9.4.2）的整句向量那一步用真的 worker（查询嵌入、存好的向量）；
//   - IDF 统计里带了 docs 时交给 lang.distinctiveTerms（库还小的时候「只在一条文字里出现过」也算区分性词）。
// 别的模块（实体、上下文、管理……）照旧用 world.js 里照契约写的替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './world.js';
import { FakeLLM, FakeEmbedding } from '../fakes/index.js';
import { MODULES } from '../../src/api.js';
import { runJobs } from '../../src/maintenance.js';
import { JOB_TOLD_SCAN } from '../../src/discretion/index.js';
import { features, idfFor } from '../../src/discretion/match.js';
import { ftsInsert } from '../../src/store/index.js';

const L = MODULES.lang;
const WK = MODULES.worker;
const realLang = { queryTerms: L.queryTerms, distinctiveTerms: L.distinctiveTerms };
const realWorker = { termStats: WK.termStats, embedQuery: WK.embedQuery, storedVectors: WK.storedVectors, lexicalSearch: WK.lexicalSearch, denseSearch: WK.denseSearch };

/** 事实写进 FTS 和嵌入队列（像 encode 写事实那样：lang.indexTokens + 实体词元、worker.enqueueEmbed）。 */
function indexFact(W, m, text, entityIds) {
  const core = W.core;
  core.store.tx(() => {
    ftsInsert(core.store, 'assertions_fts', m.id, core.mods.lang.indexTokens(core, text, { entityIds }));
    core.mods.worker.enqueueEmbed(core, m, [{ chunkNo: 0, kind: 'text', text }], { layer: 'memory', priority: 2 });
  });
}

test('全库比对任务接真的 lang 和 worker：她在群里换了个说法讲了主人私下说的事 → 全库的词法 / 稠密路找到那条事实，记成「说了个大概」，讲给新听众加痕迹', async () => {
  const seen = { lexical: [], dense: [] };
  const worker = {
    ...realWorker,
    lexicalSearch: async (...args) => { const r = await WK.lexicalSearch(...args); seen.lexical.push(...r.hits); return r; },
    denseSearch: async (...args) => { const r = await WK.denseSearch(...args); seen.dense.push(r); return r; },
  };
  const W = await makeWorld({ name: 'dw-scan', mods: { lang: realLang, worker } });
  try {
    const core = W.core;
    await core.mods.worker.ensureSpace(core);
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const hong = W.person('小红', { closeness: 0.5 });
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const group = W.setting('游戏群', 'group');
    const text = '主人在找新工作，下周三去面试';
    const fact = W.assertion({ text, subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(core, fact, { sensitivity: 0.4, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
    indexFact(W, fact, text, [owner]);
    // 库里别的东西（闲聊）：让 IDF 有意义——只在那条事实里出现过的词才够得上「高 IDF」
    core.store.tx(() => { for (let i = 0; i < 300; i++) ftsInsert(core.store, 'episodes_fts', 1000 + i, ['闲聊', `话题${i}`, '晚上']); });
    let r = { embedded: 1 };
    for (let i = 0; i < 20 && r.embedded; i++) r = await core.mods.worker.runEmbedQueue(core, { batchSize: 64 });
    assert.equal(core.vectors.get('SELECT COUNT(*) AS n FROM vectors').n >= 1, true, '事实的向量建好了');

    // 她在群里说（没有会话、没有注入账本：同步比对对不上 → 排全库比对）
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '听说主人下周三要去面试新工作', presence: [W.me, hong], completeness: 'recent-speakers' });
    W.D.onSelfUtterance(core, core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    assert.equal(core.store.all('SELECT * FROM told_log').length, 0, '同步比对对不上');
    assert.ok(core.store.get('SELECT id FROM jobs WHERE kind = ?', JOB_TOLD_SCAN), '排了全库比对');

    const before = W.calls.traces.length;
    const res = await runJobs(core, { kinds: [JOB_TOLD_SCAN] });
    assert.equal(res.ran, 1);
    assert.equal(res.failed, 0);
    const told = core.store.all('SELECT owner_kind, owner_id, level, utterance_percept_id FROM told_log').map((x) => ({ ...x }));
    assert.deepEqual(told, [{ owner_kind: 'assertion', owner_id: fact.id, level: 'vague', utterance_percept_id: pid }]);
    // 说了个大概不扩充已知圈（told_by_her 只记讲全了的）；讲给新听众（小红）各一次痕迹
    assert.equal(core.store.get("SELECT COUNT(*) AS n FROM known_by WHERE basis = 'told_by_her'").n, 0);
    const traces = W.calls.traces.slice(before);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].reason, 'retell');
    assert.equal(W.ref(traces[0].ref), W.ref(fact));
    // 真的 worker 用 discretion 给的词在事实表里找到了它；稠密扫描也真的跑了（调用的样子对得上 worker 的签名）
    assert.ok(seen.lexical.some((h) => h.ref === W.ref(fact)), '词法路命中');
    assert.equal(seen.dense.length, 1, '稠密路跑了一次');
    assert.ok(Array.isArray(seen.dense[0].hits));
    const errs = core.store.all("SELECT name FROM metrics WHERE name LIKE 'discretion.dep.%' OR name LIKE 'worker.%error%'");
    assert.deepEqual(errs, [], '没有依赖出错的计数');
  } finally { await W.cleanup(); }
});

test('idfFor：统计里带 docs 时连同 docs 交给真的 lang.distinctiveTerms——IDF 不够、但只在一条文字里出现过的词也算区分性词；没有 docs 时照旧只看 IDF', async () => {
  const stats = new Map([['面试', { idf: 1.2, rowFraction: 0.1, docs: 1 }], ['工作', { idf: 1.2, rowFraction: 0.3, docs: 3 }]]);
  const W = await makeWorld({ name: 'dw-idf', mods: { lang: realLang, worker: { termStats: async (core, ts) => new Map(ts.filter((t) => stats.has(t)).map((t) => [t, stats.get(t)])) } } });
  try {
    const core = W.core;
    const idf = await idfFor(core, ['下周三去面试新工作'], 500);
    assert.deepEqual(idf('面试'), { idf: 1.2, docs: 1 });
    assert.equal(idf('没统计到的词'), 0);
    const f = features(core, '下周三去面试新工作', { idf });
    assert.ok(f.distinct.has('面试'), '只在一条文字里出现过：算');
    assert.ok(!f.distinct.has('工作'), '出现在好几条里、IDF 又不够：不算');
    // 统计里没有 docs（只有 idf、rowFraction）：只看 IDF
    stats.set('面试', { idf: 1.2, rowFraction: 0.1 });
    const idf2 = await idfFor(core, ['下周三去面试新工作'], 500);
    assert.equal(idf2('面试'), 1.2);
    assert.ok(!features(core, '下周三去面试新工作', { idf: idf2 }).distinct.has('面试'));
  } finally { await W.cleanup(); }
});

test('外发初筛接真的 worker（公开目标）：把主人私聊里的事换个说法发出去（字面一个区分性词都不共有）→ 整句向量对上账本里对那里不能说的那条，带着它送审', async () => {
  // 换说法：同义词让向量很近、字面很远（替身嵌入的 synonyms）
  const embedding = new FakeEmbedding({ synonyms: [['找', '寻'], ['工作', '差事'], ['下周三', '礼拜三'], ['面试', '应聘'], ['主人', '他']] });
  const llm = new FakeLLM({ fallback: { review: [{ verdict: 'reconsider', reflection: '这是主人私下说的', reason: '测试' }] } });
  const W = await makeWorld({ name: 'dw-egress', llm, embedding, mods: { lang: realLang, worker: realWorker } });
  try {
    const core = W.core;
    await core.mods.worker.ensureSpace(core);
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const ming = W.person('阿明', { closeness: 0.6 });
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const group = W.setting('公开帖子', 'public', { capabilities: { preSendGate: true, canHold: false } });
    W.percept({ settingKey: group.key, actor: ming, text: '晚上开黑吗' });
    const text = '主人在找新工作，下周三去面试';
    const fact = W.assertion({ text, subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(core, fact, { sensitivity: 0.6, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
    W.D.recordKnowledge(core, fact, [{ whoKind: 'entity', whoRef: String(owner), since: W.now(), basis: 'subject' }]);
    indexFact(W, fact, text, [owner]);
    let r = { embedded: 1 };
    for (let i = 0; i < 20 && r.embedded; i++) r = await core.mods.worker.runEmbedQueue(core, { batchSize: 64 });
    W.session('s-dm', dm.key, { ledger: [W.ref(fact)] });
    const a = await W.D.appraise(core, {
      channel: { targetSettingId: group.sid, persistence: 'once' }, text: ['他在寻新差事，礼拜三去应聘'],
      origin: { path: 'tool', sessionId: 's-dm', homeSettingId: dm.sid },
    });
    assert.equal(a.verdict, 'reconsider');
    const reasons = JSON.parse(core.store.get('SELECT reasons_json FROM utterances WHERE token = ?', a.token).reasons_json);
    assert.ok(reasons.includes('cross-circle-ledger'));
    assert.ok(reasons.includes(W.ref(fact)), '整句向量命中了账本里的那条（真的 worker 给的查询向量和存好的向量）');
    // 审视看得到命中的记忆（在围栏里）；日志里没有正文
    assert.match(llm.callsFor('review')[0].messages[0].content, /话里可能用到的记忆[\s\S]*主人在找新工作/);
    W.logger.assertNoText('主人在找新工作', '他在寻新差事');
    const errs = core.store.all("SELECT name FROM metrics WHERE name LIKE 'discretion.dep.%' OR name LIKE 'worker.%error%'");
    assert.deepEqual(errs, []);
  } finally { await W.cleanup(); }
});
