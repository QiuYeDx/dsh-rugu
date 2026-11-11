// 词法路挑词（D150）：虚词不当查询词、跨词边界的碎片不占名额、常见词降权不剔除、焦点的词比对话其余部分重。
// 数据都是编的；形状照实测里那种问句：「你还记得群里有过哪些X吗」，X 恰好也是库里一个常被叫到的外号里的字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLexicalTerms } from '../../src/retrieve/routes.js';
import { ensurePerceptShard, ftsInsert } from '../../src/store/fts.js';
import { workerCore } from '../worker/_helpers.js';

const st = (docs, rows) => ({ idf: Math.log(1 + (rows - docs + 0.5) / (docs + 0.5)), rowFraction: rows ? docs / rows : 0, docs, rows });
const OPT = { maxTerms: 12, cohesionMin: 1, cohesionRivalRatio: 0.5, skipRowFraction: 0.5, commonMinDocs: 20, maxPostings: 100_000 };
const FN = new Set(['你', '还', '得', '过', '哪', '些', '哪些', '吗', '你还', '过哪']);
const classOf = (t) => (FN.has(t) ? 'function' : null);
const gramsAndChars = (text) => {
  const c = [...text];
  const out = [];
  for (let i = 0; i < c.length; i++) { if (i + 1 < c.length) out.push(c[i] + c[i + 1]); out.push(c[i]); }
  return [...new Set(out)];
};

test('挑词：问句的框架（虚词）不进、跨词边界的碎片不占名额、凝聚的二元组是词、没被词盖住的单字自己当词、常见词留着', () => {
  const text = '你还记得群里有过哪些猫吗';
  const N = 5000;
  // 「记得」「群里」凝聚；「些猫」「得群」「有过」「猫吗」都是碎片（稀有，但两个字各自常见）；「猫」常见（> 1%，外号里也有这个字）
  const stats = new Map(Object.entries({
    你: st(900, N), 还: st(1000, N), 记: st(500, N), 得: st(800, N), 群: st(650, N), 里: st(800, N), 有: st(750, N), 过: st(450, N),
    哪: st(130, N), 些: st(65, N), 猫: st(800, N), 吗: st(220, N),
    你还: st(27, N), 还记: st(20, N), 记得: st(124, N), 得群: st(3, N), 群里: st(560, N), 里有: st(21, N), 有过: st(4, N),
    过哪: st(1, N), 哪些: st(5, N), 些猫: st(2, N), 猫吗: st(9, N),
  }));
  const r = pickLexicalTerms([{ text, terms: gramsAndChars(text), weight: 1 }], stats, { ...OPT, classOf });
  assert.deepEqual(r.terms, ['记得', '群里', '有', '猫'], JSON.stringify(r));
  assert.ok(r.weights.every((w) => w === 1));
  for (const t of ['些猫', '得群', '有过', '猫吗', '还记', '里有']) assert.ok(r.dropped.fragments.includes(t), t);
  for (const t of ['你还', '哪些', '吗']) assert.ok(r.dropped.functions.includes(t), t);
  // 「记」「群」被词盖住了，不单独当词
  assert.ok(!r.terms.includes('记') && !r.terms.includes('群'));
});

test('挑词：几个字都少见时碎片的凝聚度也会过 1——夹在两个词中间、比它们弱得多的二元组还是碎片', () => {
  const text = '检测指令';
  const N = 7000;
  const stats = new Map(Object.entries({
    检: st(37, N), 测: st(72, N), 指: st(35, N), 令: st(17, N),
    检测: st(16, N), 测指: st(3, N), 指令: st(8, N),
  }));
  // 测指：3·7000/(72·35) ≈ 8.3 > 1，但两边的「检测」≈ 42、「指令」≈ 94
  const r = pickLexicalTerms([{ text, terms: gramsAndChars(text), weight: 1 }], stats, OPT);
  assert.deepEqual(r.terms.sort(), ['指令', '检测']);
  assert.deepEqual(r.dropped.fragments, ['测指']);
  // 三个字的词（两个二元组都凝聚、强弱相近）两个都留着
  const s2 = new Map(Object.entries({ 大: st(700, N), 橘: st(450, N), 猫: st(480, N), 大橘: st(430, N), 橘猫: st(440, N) }));
  assert.deepEqual(pickLexicalTerms([{ text: '大橘猫', terms: gramsAndChars('大橘猫'), weight: 1 }], s2, OPT).terms.sort(), ['大橘', '橘猫']);
});

test('挑词：常见词降权不剔除；只有出现在一半以上的行里（而且行数也多）才跳过；小库不跳；没统计、统计不全的照旧留着', () => {
  const N = 100_000;
  const tier = (text, terms) => [{ text, terms, weight: 1 }];
  const stats = new Map([['包裹', st(5, N)], ['取件', st(4000, N)], ['今天', st(60_000, N)]]);
  const r = pickLexicalTerms(tier('今天包裹取件', ['包裹', '取件', '今天']), stats, OPT);
  assert.deepEqual(r.terms, ['包裹', '取件'], '4% 的词留着、排在稀有的后面');
  assert.deepEqual(r.dropped.skipped, ['今天'], '60% 的词（BM25 的 IDF 到 0）跳过');
  // 小库：13 行里 8 行也不跳（D72）
  const small = new Map([['包裹', st(8, 13)]]);
  assert.deepEqual(pickLexicalTerms(tier('包裹', ['包裹']), small, OPT).terms, ['包裹']);
  // 没有统计：按出现顺序，只去掉虚词
  assert.deepEqual(pickLexicalTerms(tier('你还记得', ['你还', '还记', '记得']), null, { ...OPT, classOf }).terms, ['还记', '记得']);
  // 单字没入库（比如分词带 jieba）：凝聚度判断不了，二元组照旧当词
  const partial = new Map([['还记', st(20, N)], ['记得', st(124, N)]]);
  assert.deepEqual(pickLexicalTerms(tier('还记得', ['还记', '记得']), partial, OPT).terms.sort(), ['记得', '还记'].sort());
});

test('挑词：库里一行都没有的二元组（新词或旧的统计）排在最后、不盖字——它的字还能自己当词；焦点在前，对话其余部分权重轻', () => {
  const N = 5000;
  const stats = new Map(Object.entries({ 小: st(300, N), 黑: st(40, N), 小黑: st(0, N), 奶茶: st(10, N), 奶: st(30, N), 茶: st(11, N) }));
  const r = pickLexicalTerms([
    { text: '小黑', terms: ['小黑', '小', '黑'], weight: 1 },
    { text: '奶茶', terms: ['奶茶', '奶', '茶'], weight: 0.3 },
  ], stats, OPT);
  assert.deepEqual(r.terms, ['黑', '小', '奶茶', '小黑']);
  assert.deepEqual(r.weights, [1, 1, 0.3, 1]);
});

test('挑词：选中的词加起来匹配的行太多时先去掉最常见的（查询的开销和匹配的行数成正比），至少留一个；实体词元不按比例剔', () => {
  const N = 1_000_000;
  const stats = new Map([['猫', st(300_000, N)], ['群里', st(200_000, N)], ['ent_5', st(250_000, N)], ['小黑', st(50, N)]]);
  const r = pickLexicalTerms([{ text: '群里小黑猫', terms: ['群里', '小黑', '猫', 'ent_5'], weight: 1 }], stats, { ...OPT, maxPostings: 500_000 });
  assert.deepEqual(r.terms, ['小黑', '群里', 'ent_5']);
  assert.deepEqual(r.dropped.skipped, ['猫']);
  const one = pickLexicalTerms([{ text: '猫', terms: ['猫'], weight: 1 }], stats, { ...OPT, maxPostings: 10 });
  assert.deepEqual(one.terms, ['猫']);
});

test('真的 lang + worker：问「群里有过哪些猫」，词法路找到的是讲猫的记忆，不是长得像的问句（D150）', async () => {
  const { core, cleanup } = await workerCore({ name: 'lex-terms-real' });
  try {
    const { lang, worker } = core.mods;
    const shard = ensurePerceptShard(core.store, core.now());
    let id = 0;
    const put = (table, text) => { id += 1; ftsInsert(core.store, table, id, lang.indexTokens(core, text)); return id; };
    // 「猫」是常被叫到的外号「大橘猫」里的字，库里到处都是；「群里」「记得」也常见
    for (let i = 0; i < 120; i++) put(shard, `大橘猫今天第${i}次冒泡`);
    for (let i = 0; i < 80; i++) put(shard, `群里第${i}个话题聊完了`);
    for (let i = 0; i < 40; i++) put(shard, `我记得第${i}件事`);
    for (let i = 0; i < 300; i++) put(shard, `有人过来随便说点别的${i}号`);
    // 长得像的问句
    const frames = [put(shard, '你还记得上周谁说了你哪些坏话吗'), put(shard, '你还记得我昨天问过你哪些问题吗'), put(shard, '你还记得他有过哪些外号吗')];
    // 讲猫的
    const topic = [put('assertions_fts', '主人在群里说自己养了两只猫'), put('assertions_fts', '群里的人互相叫猫'), put(shard, '群里现在有三只猫')];
    const text = '你还记得群里有过哪些猫吗';
    const terms = [...new Set(lang.queryTerms(core, text))];
    const parts = [...new Set(terms.filter((t) => [...t].length === 2).flatMap((t) => [...t]))];
    const stats = await worker.termStats(core, [...terms, ...parts]);
    const picked = pickLexicalTerms([{ text, terms, weight: 1 }], stats, { ...core.config.get().recall.lexical, classOf: (t) => lang.termClass(core, t) });
    for (const t of ['群里', '猫']) assert.ok(picked.terms.includes(t), JSON.stringify(picked));
    for (const t of ['你还', '哪些', '有过', '还记']) assert.ok(!picked.terms.includes(t), `${t}：${JSON.stringify(picked.terms)}`);
    // 只在问句里出现过的二元组（库里一行都没有）可以留在最后，但匹配不上任何一行
    assert.ok(picked.terms.slice(0, 3).every((t) => ['记得', '群里', '猫', '有'].includes(t)), JSON.stringify(picked.terms));
    const r = await worker.lexicalSearch(core, { terms: picked.terms, weights: picked.weights, tables: [shard, 'assertions_fts'], limit: 50 }, { deadlineMs: 2000 });
    const rank = (ref) => r.hits.findIndex((h) => h.ref === ref);
    const worstTopic = Math.max(rank(`a${topic[0]}`), rank(`a${topic[1]}`), rank(`p${topic[2]}`));
    assert.ok(worstTopic >= 0 && worstTopic < 5, JSON.stringify(r.hits.slice(0, 8)));
    for (const f of frames) assert.ok(rank(`p${f}`) < 0 || rank(`p${f}`) > worstTopic, `问句 p${f} 排在讲猫的前面`);
  } finally { await cleanup(); }
});
