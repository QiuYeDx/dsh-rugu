// 词法路（§8.2、F29）：FTS5 BM25 over 情节 / 事实 / 原文分表；表名白名单和别名；裸 AND 不报错；IDF 统计和缓存；降级时的上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore } from './_helpers.js';
import { ftsInsert, ensurePerceptShard } from '../../src/store/index.js';

const W = (core) => core.mods.worker;
const DAY = 86_400_000;

/** 词法夹具：几条情节、事实，和两个月的原文分表（词元直接给，分析器的事在 lang）。 */
function seed(core) {
  const now = core.now();
  const old = ensurePerceptShard(core.store, now - 40 * DAY);
  const cur = ensurePerceptShard(core.store, now);
  core.store.tx((db) => {
    ftsInsert(db, 'episodes_fts', 1, ['快递', '驿站', '包裹', '晚上']);
    ftsInsert(db, 'episodes_fts', 2, ['加班', '晚上', '公司']);
    ftsInsert(db, 'assertions_fts', 5, ['快递', '拿了', 'ent_3']);
    ftsInsert(db, 'assertions_fts', 6, ['表哥', '网约车', 'ent_7']);
    ftsInsert(db, cur, 100, ['快递', '到了', '驿站']);
    ftsInsert(db, cur, 101, ['今天', '晚上', '吃啥']);
    ftsInsert(db, old, 50, ['快递', '上个月']);
    for (let i = 0; i < 20; i++) ftsInsert(db, cur, 200 + i, ['晚上', `闲聊${i}`]);
  });
  return { old, cur };
}

test('lexicalSearch：三类表一起查，ref 按表映射（情节 e / 事实 a / 原文 p），score = −bm25 降序', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-lex' });
  try {
    const { old, cur } = seed(core);
    const r = await W(core).lexicalSearch(core, { terms: ['快递', '驿站'], tables: [cur, old, 'episodes_fts', 'assertions_fts'], limit: 50 }, { deadlineMs: 2000 });
    assert.equal(r.timedOut, false);
    const refs = r.hits.map((h) => h.ref);
    assert.deepEqual([...refs].sort(), ['a5', 'e1', 'p100', 'p50']);
    for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i - 1].score >= r.hits[i].score);
    assert.ok(r.hits.every((h) => h.score > 0 && Object.keys(h).sort().join() === 'ref,score'));
    // 实体词元
    const e = await W(core).lexicalSearch(core, { terms: ['ent_7'], tables: ['assertions_fts'], limit: 5 }, { deadlineMs: 1000 });
    assert.deepEqual(e.hits.map((h) => h.ref), ['a6']);
    // limit
    const l = await W(core).lexicalSearch(core, { terms: ['晚上'], tables: [cur, 'episodes_fts'], limit: 3 }, { deadlineMs: 1000 });
    assert.equal(l.hits.length, 3);
  } finally { await cleanup(); }
});

test('表名白名单和别名：不认识的表丢掉；percepts_fts = 最近 hotMonths 个月，percepts_fts_all = 全部', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-lex-tables', config: { recall: { lexical: { hotMonths: 1 } } } });
  try {
    seed(core);
    const bad = await W(core).lexicalSearch(core, { terms: ['快递'], tables: ['episodes_fts; DROP TABLE episodes', 'sqlite_schema', 'percepts_fts_209901', 'episodes'], limit: 10 }, { deadlineMs: 1000 });
    assert.deepEqual(bad.hits, []);
    assert.ok(core.store.get("SELECT 1 AS x FROM sqlite_schema WHERE name = 'episodes'"));
    const hot = await W(core).lexicalSearch(core, { terms: ['快递'], tables: [W(core).HOT_SHARDS], limit: 10 }, { deadlineMs: 1000 });
    assert.deepEqual(hot.hits.map((h) => h.ref), ['p100']);
    const all = await W(core).lexicalSearch(core, { terms: ['快递'], tables: [W(core).ALL_SHARDS], limit: 10 }, { deadlineMs: 1000 });
    assert.deepEqual(all.hits.map((h) => h.ref).sort(), ['p100', 'p50']);
  } finally { await cleanup(); }
});

test('F29：裸 AND / NOT / NEAR / x:y 当普通词，不报错；没有可用的词就是空结果', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-lex-f29' });
  try {
    seed(core);
    const r = await W(core).lexicalSearch(core, { terms: ['AND', 'NOT', 'NEAR', 'a:b', '"', '快递'], tables: ['episodes_fts'], limit: 10 }, { deadlineMs: 1000 });
    assert.deepEqual(r.hits.map((h) => h.ref), ['e1']);
    assert.deepEqual((await W(core).lexicalSearch(core, { terms: ['  ', '!!'], tables: ['episodes_fts'], limit: 10 }, { deadlineMs: 1000 })).hits, []);
    assert.deepEqual((await W(core).lexicalSearch(core, { terms: [], tables: ['episodes_fts'], limit: 10 }, { deadlineMs: 1000 })).hits, []);
  } finally { await cleanup(); }
});

test('termStats：IDF、rowFraction 和条数（docs、rows）按三类表的总行数算；键是原词；按 TTL 缓存', async () => {
  const { core, ports, cleanup } = await workerCore({ name: 'worker-terms', config: { worker: { countTtlMs: 0 } } });
  try {
    seed(core);
    const N = 2 + 2 + 22 + 1;   // 情节 2、事实 2、本月原文 2 + 20、上月 1
    const m = await W(core).termStats(core, ['快递', '晚上', '从没出现过', 'KUAI', '!!']);
    const idf = (n) => Math.log(1 + (N - n + 0.5) / (n + 0.5));
    assert.ok(Math.abs(m.get('快递').idf - idf(4)) < 1e-9);
    assert.ok(Math.abs(m.get('快递').rowFraction - 4 / N) < 1e-9);
    assert.ok(Math.abs(m.get('晚上').rowFraction - 23 / N) < 1e-9);
    assert.ok(m.get('晚上').idf < m.get('快递').idf);
    assert.ok(m.get('从没出现过').idf > m.get('快递').idf);
    assert.equal(m.get('从没出现过').rowFraction, 0);
    assert.equal(m.get('KUAI').rowFraction, 0);
    assert.deepEqual(m.get('!!'), { idf: 0, rowFraction: 1 });
    // 绝对条数也给（库还小的时候比例说明不了什么；docs = 0 的词哪一行都匹配不上）
    assert.deepEqual([m.get('快递').docs, m.get('快递').rows], [4, N]);
    assert.deepEqual([m.get('晚上').docs, m.get('从没出现过').docs, m.get('从没出现过').rows], [23, 0, N]);
    // 加了新行：TTL 之内还是缓存的结果，过了 TTL 才更新
    core.store.tx((db) => { for (let i = 0; i < 5; i++) ftsInsert(db, 'assertions_fts', 300 + i, ['快递']); });
    assert.equal((await W(core).termStats(core, ['快递'])).get('快递').rowFraction, 4 / N);
    assert.equal((await W(core).termStats(core, ['快递'])).get('快递').docs, 4, '缓存里的也带条数');
    // 库里还没有的词只缓存 countTtlMs（这里是 0）：一出现就查得到，不用等 termStatsTtlMs
    core.store.tx((db) => ftsInsert(db, 'assertions_fts', 400, ['从没出现过']));
    ports.clock.advance(1);
    const now = await W(core).termStats(core, ['快递', '从没出现过']);
    assert.deepEqual([now.get('快递').docs, now.get('从没出现过').docs], [4, 1]);
    ports.clock.advance(11 * 60_000);
    const fresh = (await W(core).termStats(core, ['快递'])).get('快递');
    assert.ok(Math.abs(fresh.rowFraction - 9 / (N + 6)) < 1e-9);
    assert.deepEqual([fresh.docs, fresh.rows], [9, N + 6]);
  } finally { await cleanup(); }
});

/** 一条真的感知行（只填必填列）+ 它在分表里的词元。 */
function seedPercept(core, ext, tokens) {
  const at = core.now();
  const shard = ensurePerceptShard(core.store, at);
  const id = Number(core.store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_json, kind,
      text, text_hash, addressed, attention, attention_class, evidential, standing, fts_shard, created_at)
    VALUES ('zz', ?, 'k', 'k', 'setting-audience', ?, ?, '{}', 'utterance', ?, 'th', 'to-her', 'attended', 'attended', 1, 'first-hand', ?, ?)`,
  ext, at, at, tokens.join(''), shard, at).lastInsertRowid);
  ftsInsert(core.store, shard, id, tokens);
  return id;
}

test('termStats 的 excludePercepts：眼前这段对话不算进统计——只在问题里出现过的词 docs = 0；缓存比感知旧时不多减', async () => {
  const { core, ports, cleanup } = await workerCore({ name: 'worker-terms-live', config: { worker: { countTtlMs: 0 } } });
  try {
    seed(core);
    const N = 2 + 2 + 22 + 1;
    // 先数一次「快递」（进缓存），之后才来了问题：缓存里的数不含问题
    const before = (await W(core).termStats(core, ['快递'])).get('快递');
    assert.equal(before.docs, 4);
    const q = seedPercept(core, 'q1', ['快递', '价格', '涨价']);
    const other = seedPercept(core, 'q2', ['价格', '晚上']);
    const live = [q, other];
    const m = await W(core).termStats(core, ['快递', '价格', '涨价', '晚上'], { excludePercepts: live });
    // 问题里的新词：库里别处没有 → docs = 0（原来是 1 和 2，IDF 最高，占词法路的名额）
    assert.equal(m.get('涨价').docs, 0);
    assert.equal(m.get('价格').docs, 0);
    // 缓存里的「快递」是问题入库之前数的：不减（还是 4）
    assert.equal(m.get('快递').docs, 4);
    // 新数的「晚上」：库里 23 条 + 窗口里的 1 条，减掉窗口的那条
    assert.equal(m.get('晚上').docs, 23);
    assert.equal(m.get('晚上').rows, N);
    // 不排除时照旧（缓存里存的是原始数）
    const raw = await W(core).termStats(core, ['价格', '晚上']);
    assert.deepEqual([raw.get('价格').docs, raw.get('晚上').docs], [2, 24]);
    // 缓存过期之后重新数：问题已经在库里，这次要减
    ports.clock.advance(11 * 60_000);
    const later = await W(core).termStats(core, ['快递'], { excludePercepts: live });
    assert.equal(later.get('快递').docs, 4);
    const rawLater = await W(core).termStats(core, ['快递']);
    assert.equal(rawLater.get('快递').docs, 5);
  } finally { await cleanup(); }
});

test('降级（线程起不来）：词法在主线程以更小的上限查（词数、条数、只查最新的分表）', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-lex-fb', config: { worker: { enabled: false }, recall: { lexical: { fallback: { maxTerms: 1, limit: 2, hotMonths: 1 } } } } });
  try {
    const { old, cur } = seed(core);
    const s = await W(core).start(core);
    assert.deepEqual(s, { ok: false, reason: 'disabled' });
    assert.equal(W(core).health(core).mode, 'fallback');
    const r = await W(core).lexicalSearch(core, { terms: ['驿站', '快递'], tables: [cur, old, 'episodes_fts', 'assertions_fts'], limit: 50 }, { deadlineMs: 1000 });
    // 只用了第一个词「驿站」、只查了最新的原文分表、最多 2 条
    assert.deepEqual(r.hits.map((h) => h.ref).sort(), ['e1', 'p100']);
    const r2 = await W(core).lexicalSearch(core, { terms: ['快递'], tables: [old], limit: 50 }, { deadlineMs: 1000 });
    assert.deepEqual(r2.hits, []);
  } finally { await cleanup(); }
});
