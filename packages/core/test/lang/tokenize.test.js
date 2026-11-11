// 分词、FTS 词元、查询词（§8.2、F29）：zh = jieba 搜索模式（可选）+ 中文二元组 + ASCII 词；und = CJK 二元组 + 字母数字词。
// 没有 jieba 时照常工作；index 和 query 两种模式用同一套规范化，词一定对得上；用户文字伪造不出实体词元。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZhAnalyzer, createUnicodeAnalyzer } from '../../src/lang/index.js';
import { ensurePerceptShard, ftsInsert, ftsSearch, normalizeToken, entityToken } from '../../src/store/fts.js';
import { withLang, AT } from './helpers.js';

test('zh（没有 jieba）：中文二元组 + 单字 + 字母数字词，字母数字交界处再切开', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  assert.equal(zh.jieba, false);
  const toks = zh.tokenize('我昨天去了北京大学看iPhone15');
  for (const t of ['北京', '大学', '昨天', '北', 'iphone15', 'iphone', '15']) assert.ok(toks.includes(t), `缺 ${t}：${toks.join(' ')}`);
  // 去重、按出现顺序
  assert.equal(new Set(toks).size, toks.length);
  assert.ok(toks.indexOf('北京') < toks.indexOf('大学'));
  // 标点、空白都是分隔符；全角字母数字经 NFKC 变半角
  assert.deepEqual(zh.tokenize('ＡＢＣ，１２３'), ['abc', '123']);
  assert.deepEqual(zh.tokenize(''), []);
});

test('und：CJK 连续段切二元组（单字段保留单字），其他文字按词并小写', () => {
  const und = createUnicodeAnalyzer();
  assert.deepEqual(und.tokenize('Hello World'), ['hello', 'world']);
  assert.deepEqual(und.tokenize('日本語'), ['日本', '本語']);
  assert.deepEqual(und.tokenize('猫'), ['猫']);
  assert.deepEqual(und.tokenize('Привет мир'), ['привет', 'мир']);
  // 泰文这类不用空格分词的文字也切二元组
  assert.ok(und.tokenize('สวัสดี').length >= 2);
});

test('下划线是分隔符：用户文字伪造不出 ent_<id>，实体词元只能按 id 加', () => withLang((core) => {
  const toks = core.mods.lang.indexTokens(core, '看这个 ent_5 和 ent_6', { entityIds: [7, 7, -1, 1.5] });
  assert.ok(!toks.includes('ent_5') && !toks.includes('ent_6'), toks.join(' '));
  assert.ok(toks.includes(entityToken(7)));
  assert.equal(toks.filter((t) => t === entityToken(7)).length, 1);
  assert.ok(!toks.some((t) => t === 'ent_-1' || t === 'ent_1.5'));
  // 每个词元都已经是 FTS 规范化后的样子
  for (const t of toks) assert.equal(normalizeToken(t), t);
}));

test('F29：两字词能匹配；index 和 query 用同一套切法；裸 AND / NOT 不报错', () => withLang((core) => {
  const { lang } = core.mods;
  const shard = ensurePerceptShard(core.store, AT);
  ftsInsert(core.store, shard, 1, lang.indexTokens(core, '我昨天去了北京大学'));
  ftsInsert(core.store, shard, 2, lang.indexTokens(core, '今天下雨了，在家打游戏'));
  ftsInsert(core.store, shard, 3, lang.indexTokens(core, '新买的 iPhone15 到了', { entityIds: [42] }));
  ftsInsert(core.store, shard, 4, lang.indexTokens(core, 'AND OR NOT NEAR "x:y"'));
  const hit = (q, opt) => ftsSearch(core.store, shard, lang.queryTerms(core, q, opt)).map((r) => r.rowid);
  assert.deepEqual(hit('北京'), [1]);
  assert.deepEqual(hit('游戏'), [2]);
  assert.deepEqual(hit('iphone'), [3]);
  assert.deepEqual(hit('有人提到', { entityIds: [42] }), [3]);
  assert.deepEqual(hit('AND NOT'), [4]);
  assert.deepEqual(hit('x:y'), [4]);
  // 同一段文字：查询词都在索引词里
  for (const text of ['阿明的表哥开网约车', 'Tom 说 3 点到', '日本語のテキスト']) {
    const idx = new Set(lang.indexTokens(core, text));
    for (const q of lang.queryTerms(core, text)) assert.ok(idx.has(q), `${text}：查询词 ${q} 不在索引里`);
  }
}));

test('S24（词法部分）：换个说法时，共有的词（快递、取了）照样能在词法路上对上；说法完全不同的交给稠密路', () => withLang((core) => {
  const { lang } = core.mods;
  const shard = ensurePerceptShard(core.store, AT);
  ftsInsert(core.store, shard, 1, lang.indexTokens(core, '下午去驿站取了快递'));
  ftsInsert(core.store, shard, 2, lang.indexTokens(core, '下午去驿站取了包裹'));
  ftsInsert(core.store, shard, 3, lang.indexTokens(core, '今天天气真好'));
  const hit = (q) => ftsSearch(core.store, shard, lang.queryTerms(core, q)).map((r) => r.rowid).sort();
  assert.deepEqual(hit('快递拿了没'), [1, 2]);   // 「快递」「了」都算（IDF 挑词由 retrieve 做）
  // 只按两字词查：「快递」只命中说了快递的那条；「驿站取了」两条都命中
  const two = (q) => ftsSearch(core.store, shard, lang.queryTerms(core, q).filter((t) => [...t].length >= 2)).map((r) => r.rowid).sort();
  assert.deepEqual(two('快递拿了没'), [1]);
  assert.deepEqual(two('驿站取了东西'), [1, 2]);
}));

test('queryTerms 不排序不截断（IDF 排序和 12 个上限是调用方的事）', () => withLang((core) => {
  const long = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  const q = core.mods.lang.queryTerms(core, long);
  assert.ok(q.length > 12);
  assert.equal(q[0], '一二');   // 按出现顺序
}));

test('用户词典（实体别名）：没有 jieba 时整词也出一个词元，按位置插回', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  zh.setUserDictionary(['小鱼干', '阿明', 'x']);
  const toks = zh.tokenize('我家小鱼干和阿明');
  assert.ok(toks.includes('小鱼干'), toks.join(' '));
  assert.ok(toks.includes('阿明'));
  assert.ok(toks.indexOf('小鱼干') < toks.indexOf('阿明'));
  // 换词典：旧词不再整词出现
  zh.setUserDictionary([]);
  assert.ok(!zh.tokenize('我家小鱼干').includes('小鱼干'));
});

test('registry.setUserDictionary 转给支持的分析器', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  reg.setUserDictionary(['网约车司机']);
  assert.ok(reg.tokenize('他是网约车司机', { lang: 'zh' }).includes('网约车司机'));
  assert.doesNotThrow(() => reg.setUserDictionary(/** @type {any} */ (null)));
}));

test('有 jieba 时：搜索模式的词 + 二元组；词典交给 jieba', async () => {
  const dicts = [];
  const fakeJieba = {
    cutForSearch: (t) => (t === '北京大学' ? ['北京', '大学', '北京大学'] : [t]),
    loadDict: (buf) => dicts.push(buf.toString('utf8')),
  };
  const zh = await createZhAnalyzer({ jieba: fakeJieba });
  assert.equal(zh.jieba, true);
  const toks = zh.tokenize('北京大学');
  assert.ok(toks.includes('北京大学') && toks.includes('北京') && toks.includes('京大'), toks.join(' '));
  assert.ok(!toks.includes('北'), '有 jieba 时不加单字');
  zh.setUserDictionary(['小鱼干']);
  assert.equal(dicts.length, 1);
  assert.match(dicts[0], /小鱼干/);
  // jieba 自己出错：退回二元组，不抛错
  const broken = await createZhAnalyzer({ jieba: { cutForSearch: () => { throw new Error('boom'); } } });
  assert.deepEqual(broken.tokenize('北京'), ['北京']);
  // 认不出的形态：当作没有
  assert.equal((await createZhAnalyzer({ jieba: { foo: 1 } })).jieba, false);
});

test('没有 @node-rs/jieba 时：init 不抛错，只记一条 info；zh 只用二元组', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  assert.deepEqual([...reg.info.langs], ['und', 'zh']);
  if (!reg.info.jieba) {
    const ev = core.log.events('lang.jieba.unavailable');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].level, 'info');
  }
  assert.ok(reg.tokenize('北京大学', { lang: 'zh' }).includes('北京'));
}));

test('init 之前用到 registry：同步建一个不带 jieba 的，不抛错', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  assert.equal(reg.info.jieba, false);
  assert.ok(core.mods.lang.indexTokens(core, '你好世界').includes('世界'));
}, { init: false }));

test('termClass（D150）：虚词是汉语的封闭词类（代词、疑问词、语气词、助词……），两个虚字连成的二元组也算；实词交给统计；词典里的名字优先', () => withLang((core) => {
  const { lang } = core.mods;
  for (const t of ['你', '我们', '哪些', '什么', '吗', '呢', '的', '了', '过', '还', '或者', '有没有', '你还', '过哪', '给我']) {
    assert.equal(lang.termClass(core, t), 'function', t);
  }
  for (const t of ['记得', '知道', '群里', '有', '猫', '昨天', '还记', '些猫', 'hello', 'ent_5']) assert.equal(lang.termClass(core, t), null, t);
  // 用户词典里的整词（名字、别名）优先：有人就叫这个
  lang.registry(core).setUserDictionary(['那些']);
  assert.equal(lang.termClass(core, '那些'), 'word');
  assert.equal(lang.termClass(core, '这些'), 'function');
  // 随机语言标签、混合文字照样按文字分派到 zh
  assert.equal(lang.termClass(core, '吗', { lang: 'x-abc' }), 'function');
}));

test('termClass（D151）：叹词和寒暄语也是封闭词类（整词）；单字「早」「好」不算，「早饭」「好吃」「早上」是实词', () => withLang((core) => {
  const { lang } = core.mods;
  for (const t of ['喂', '嗨', '嘿', '哎', '唉', '呃', '哼', '哈喽', '哈啰', '你好', '您好', '大家好', '早安', '晚安', '早上好', '晚上好', '拜拜', '再见', '在吗', '哈哈', '喂喂']) {
    assert.equal(lang.termClass(core, t), 'function', t);
  }
  for (const t of ['早', '好', '早饭', '好吃', '早上', '喂猫', '活着']) assert.equal(lang.termClass(core, t), null, t);
}));
