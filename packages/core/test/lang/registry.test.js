// 注册表（§3.3 LanguageAnalyzer）：语言检测、随机语言标签退回 und（S18 的 lang 部分）、ports.languages 覆盖同名、
// 外来分析器出错退回 und；问句线索、「看起来在问过去」的示例问法（§6.6）；区分性词（§7.3、§9.4.2、§5.6）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZhAnalyzer, createUnicodeAnalyzer } from '../../src/lang/index.js';
import { fakePorts } from '../fakes/ports.js';
import { withLang, AT } from './helpers.js';

test('detect：中文 → zh；其他文字、日文（有假名）、没把握 → und', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  assert.equal(reg.detect('今天天气不错'), 'zh');
  assert.equal(reg.detect('我用iPhone拍的'), 'zh');
  assert.equal(reg.detect('hello world'), 'und');
  assert.equal(reg.detect('こんにちは、今日はいい天気ですね'), 'und');
  assert.equal(reg.detect(''), 'und');
  assert.equal(reg.detect('12345 !!!'), 'und');
}));

test('S18（lang 部分）：随机的语言标签退回 und，照样能分词、能解析通用时间写法', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  for (const tag of ['x-qwzt', 'qz', 'qz-Latn-XX', '', undefined]) {
    const a = reg.get(tag);
    if (tag === '' || tag === undefined) assert.equal(a.lang, 'und');
    else assert.equal(a.lang, 'und', String(tag));
  }
  assert.equal(reg.get('zh-Hans-CN').lang, 'zh');
  assert.equal(reg.get('ZH').lang, 'zh');
  const toks = core.mods.lang.indexTokens(core, 'nqvx 说 你好世界', { lang: 'x-qwzt' });
  assert.ok(toks.includes('nqvx') && toks.includes('世界'), toks.join(' '));
  assert.equal(reg.parseTime('2026-10-30', AT, 'x-qwzt').length, 1);
  assert.equal(reg.questionCue('nqvx?', 'x-qwzt'), 1);
}));

test('认不出的语言标签按文字选分析器：随机标签的中文和不带标签时切出同样的词、句式线索一样（§14.2：随机标签和真实适配器一致）', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  const { lang } = core.mods;
  for (const text of ['那个快递拿了没来着', '我家猫昨天又跑了', '用 iPhone15 拍的照片']) {
    const tagged = new Set(lang.indexTokens(core, text, { lang: 'x-qwzt' }));
    const plain = new Set(lang.queryTerms(core, text));
    assert.deepEqual([...tagged].sort(), [...plain].sort(), text);
    assert.deepEqual([...new Set(lang.indexTokens(core, text, { lang: 'und' }))].sort(), [...plain].sort(), `${text}（und 标签）`);
  }
  // 单字词：随机标签入库的「猫」查得到（以前 und 只切二元组，查询用 zh 切出的单字对不上）
  assert.ok(lang.indexTokens(core, '我家猫昨天又跑了', { lang: 'x-qwzt' }).includes('猫'));
  // 问句线索：随机标签下「拿了没来着」照样算问（以前 und 只认问号）
  assert.ok(reg.questionCue('那个快递拿了没来着', 'x-qwzt') >= 0.5);
  assert.equal(reg.questionCue('那个快递拿了没来着', 'x-qwzt'), reg.questionCue('那个快递拿了没来着'));
  assert.equal(reg.questionCue('我今天很开心', 'x-qwzt'), 0);
  // 时间表达：随机标签下中文的「昨天」也解析得出来
  assert.equal(reg.parseTime('昨天说的', AT, 'x-qwzt').length, reg.parseTime('昨天说的', AT).length);
  assert.ok(reg.parseTime('昨天说的', AT, 'x-qwzt').length >= 1);
  // resolve：认得的标签照用；认不出的按文字
  assert.equal(reg.resolve('那个快递拿了没', 'x-qwzt'), 'zh');
  assert.equal(reg.resolve('hello there', 'x-qwzt'), 'und');
  assert.equal(reg.resolve('hello there', 'zh-Hans'), 'zh');
  assert.equal(reg.resolve('随便', undefined), 'zh');
}));

test('检测不出语言的混合文字按段分派：汉字段给 zh、其余给 Unicode 回退；不带标签和带随机标签一样', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  const { lang } = core.mods;
  const text = 'this is a rather long english sentence about my lovely little cat 小咪咪';
  assert.equal(reg.detect(text), 'und');
  const toks = lang.indexTokens(core, text);
  // 汉字段按 zh 切：二元组 + 单字（以前 und 只有二元组）
  for (const t of ['小咪', '咪咪', '咪', 'lovely', 'cat']) assert.ok(toks.includes(t), `缺 ${t}：${toks.join(' ')}`);
  assert.deepEqual([...new Set(lang.indexTokens(core, text, { lang: 'x-qwzt' }))].sort(), [...new Set(toks)].sort());
  // 日文（有假名）不交给 zh：按 Unicode 回退切二元组
  const ja = lang.indexTokens(core, 'こんにちは、今日はいい天気ですね', { lang: 'x-qwzt' });
  assert.ok(ja.includes('天気') && !ja.includes('天'), ja.join(' '));
  // 问句线索：英文问号、汉字段的句式都认
  assert.equal(reg.questionCue('did you get it?', 'x-qwzt'), 1);
  assert.ok(reg.questionCue('ok so 那个拿了没来着', 'x-qwzt') >= 0.5);
}));

test('ports.languages：同名覆盖内置分析器；出错的分析器退回 und，不抛错', async () => {
  const custom = {
    lang: 'zh',
    detect: () => 0.9,
    tokenize: () => ['custom'],
    parseTime: () => [{ start: 1, end: 2, precision: 'exact' }, { start: 5, end: 1, precision: 'exact' }],
    pastQuestionExemplars: () => ['示例', 42],
    questionCue: () => 7,
  };
  const broken = {
    lang: 'qx',
    detect: () => { throw new Error('boom'); },
    tokenize: () => { throw new Error('boom'); },
    parseTime: () => { throw new Error('boom'); },
    pastQuestionExemplars: () => { throw new Error('boom'); },
    questionCue: () => { throw new Error('boom'); },
  };
  await withLang((core) => {
    const reg = core.mods.lang.registry(core);
    assert.deepEqual(reg.tokenize('随便', { lang: 'zh' }), ['custom']);
    assert.deepEqual(reg.parseTime('随便', AT, 'zh'), [{ start: 1, end: 2, precision: 'exact' }]);   // 不合法的窗口丢掉
    assert.equal(reg.questionCue('随便', 'zh'), 1);                                                  // 夹到 0–1
    assert.deepEqual(reg.pastQuestionExemplars('zh'), ['示例']);
    // 出错的：退回 und
    assert.deepEqual(reg.tokenize('hello 世界', { lang: 'qx' }), ['hello', '世界']);
    assert.deepEqual(reg.parseTime('昨天', AT, 'qx'), []);
    assert.equal(reg.questionCue('?', 'qx'), 0);
    assert.deepEqual(reg.pastQuestionExemplars('qx'), []);
    assert.equal(reg.detect('hello'), 'zh');   // broken 的 detect 出错当 0，custom 的 0.9 胜出
    assert.ok(reg.info.langs.includes('qx'));
  }, { ports: fakePorts({ languages: [custom, broken] }) });
});

test('questionCue：句末的「吗 / 呢 / 了没 / 没有 / ？」、X 不 X、疑问词；陈述句为 0', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  assert.equal(zh.questionCue('你吃饭了吗？'), 1);
  assert.ok(zh.questionCue('你吃饭了吗') >= 0.9);
  assert.ok(zh.questionCue('快递拿了没') >= 0.8);
  assert.ok(zh.questionCue('那件事办完了没有') >= 0.8);
  assert.ok(zh.questionCue('你去不去') >= 0.8);
  assert.ok(zh.questionCue('他是谁') >= 0.5);
  assert.ok(zh.questionCue('上次说的那个地方叫什么来着') >= 0.5);
  assert.ok(zh.questionCue('你呢') >= 0.5);
  assert.equal(zh.questionCue('我今天很开心'), 0);
  assert.equal(zh.questionCue('好的。'), 0);
  assert.equal(zh.questionCue(''), 0);
  // 只看最后一句
  assert.equal(zh.questionCue('你吃了吗？我吃过了。'), 0);
  const und = createUnicodeAnalyzer();
  assert.equal(und.questionCue('did you get it?'), 1);
  assert.equal(und.questionCue('¿qué? no sé'), 0.5);
  assert.equal(und.questionCue('ok'), 0);
});

test('pastQuestionExemplars：zh 是中文示例问法，und 是多语言模型能比的英文示例；registry 缺省按 selfProfile.locale', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  const zh = reg.pastQuestionExemplars('zh');
  assert.ok(zh.length >= 5 && zh.every((s) => /\p{Script=Han}/u.test(s)));
  assert.ok(reg.pastQuestionExemplars('und').every((s) => /^[\x20-\x7e]+$/.test(s)));
  assert.deepEqual(reg.pastQuestionExemplars(), zh);   // FakeSelfProfile.locale = 'zh'
  // 返回的是副本，改了不影响下次
  zh.length = 0;
  assert.ok(reg.pastQuestionExemplars('zh').length >= 5);
}));

test('distinctiveTerms：没有 idf 时只给数字和命中的名字', () => withLang((core) => {
  const { lang } = core.mods;
  assert.deepEqual(lang.distinctiveTerms(core, '他的电话是13812345678，住在3号楼'), ['13812345678']);
  const names = lang.distinctiveTerms(core, '昨天阿明和tommy去了', { names: ['阿明', 'Tom', '明', '小红'] });
  assert.deepEqual(names, ['阿明']);   // 字母名按整词比（tommy ≠ tom）；单字名不算
  assert.deepEqual(lang.distinctiveTerms(core, 'Tom 说的', { names: ['tom'] }), ['tom']);
  assert.deepEqual(lang.distinctiveTerms(core, ''), []);
}));

test('distinctiveTerms：有 idf 时加高 IDF 的词（≥ minIdf；Infinity 算、NaN 不算）；exclude 先去掉', () => withLang((core) => {
  const { lang } = core.mods;
  const idf = (t) => ({ 网约: 9, 约车: 8, 表哥: 2, 开网: Number.NaN, 司机: Infinity }[t] ?? 1);
  const got = lang.distinctiveTerms(core, '表哥开网约车，当司机，车牌88', { idf });
  for (const t of ['网约', '约车', '司机', '88']) assert.ok(got.includes(t), `缺 ${t}：${got.join(' ')}`);
  for (const t of ['表哥', '开网', '车', '网']) assert.ok(!got.includes(t), `不该有 ${t}`);
  assert.deepEqual(lang.distinctiveTerms(core, '表哥开网约车', { idf, minIdf: 8.5 }), ['网约']);
  assert.ok(!lang.distinctiveTerms(core, '表哥开网约车，车牌88', { idf, exclude: ['网约', '88'] }).some((t) => t === '网约' || t === '88'));
  // idf 回调出错：当作不知道
  assert.deepEqual(lang.distinctiveTerms(core, '表哥开网约车', { idf: () => { throw new Error('x'); } }), []);
  // 英文词：≥ 3 个字母才算
  const en = lang.distinctiveTerms(core, 'go to Zanzibar', { idf: () => 10 });
  assert.ok(en.includes('zanzibar') && !en.includes('go') && !en.includes('to'));
}));

test('distinctiveTerms：idf 给统计 {idf, docs} 时，只在一条文字里出现过（docs ≤ 1）的也算——库还小、IDF 到不了门槛时', () => withLang((core) => {
  const { lang } = core.mods;
  // 库里只有几十行：BM25 的 idf 最大也就 ln(1 + (N − 0.5) / 1.5) ≈ 3，到不了 5
  const N = 40;
  const bm25 = (n) => Math.log(1 + (N - n + 0.5) / (n + 0.5));
  const docs = { 网约: 1, 约车: 1, 表哥: 6, 开网: 1, 司机: 3 };
  const stats = (t) => (t in docs ? { idf: bm25(docs[t]), docs: docs[t] } : undefined);
  assert.ok(bm25(1) < 5);
  const got = lang.distinctiveTerms(core, '表哥开网约车，当司机', { idf: stats });
  for (const t of ['网约', '约车', '开网']) assert.ok(got.includes(t), `缺 ${t}：${got.join(' ')}`);
  for (const t of ['表哥', '司机']) assert.ok(!got.includes(t), `不该有 ${t}`);
  // 统计里的 idf 过了门槛就算（docs 不知道也行）；docs 不是数字、或 > 1 且 idf 不够：不算
  assert.deepEqual(lang.distinctiveTerms(core, '表哥', { idf: () => ({ idf: 6 }) }), ['表哥']);
  assert.deepEqual(lang.distinctiveTerms(core, '表哥', { idf: () => ({ idf: 1, docs: Number.NaN }) }), []);
  assert.deepEqual(lang.distinctiveTerms(core, '表哥', { idf: () => ({ idf: 1, docs: 2 }) }), []);
  // 统计拿不到（undefined / null）= 不知道，不算；exclude 照样先去掉
  assert.deepEqual(lang.distinctiveTerms(core, '表哥', { idf: () => null }), []);
  assert.ok(!lang.distinctiveTerms(core, '表哥开网约车', { idf: stats, exclude: ['网约'] }).includes('网约'));
}));
