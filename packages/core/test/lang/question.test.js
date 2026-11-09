// questionCue（§6.6「看起来在问过去」在嵌入不可用时的退路：时间表达 + 句式线索，判别从宽）。
// 句式线索是汉语问句的语法（问号、句末疑问语气词、正反问、疑问代词），不是话题词表；「是不是在问过去」由 retrieve
// 用示例问法的嵌入相似度和时间表达判断。这里只锁住语法本身：疑问代词的任指用法（「什么都」「谁也」）不算在问。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZhAnalyzer } from '../../src/lang/index.js';

test('questionCue：疑问代词的任指 / 遍指用法（后面跟「都 / 也」）不算在问', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  for (const s of ['我什么都不想吃', '谁都可以', '哪儿都行', '他谁也不认识', '多少钱都行', '什么时候都可以', '怎么也想不起来', '怎么都行']) {
    assert.equal(zh.questionCue(s), 0, s);
  }
  // 「怎么也」后面不是否定、让步：是在问（「你怎么也来了」）
  assert.ok(zh.questionCue('你怎么也来了') >= 0.5);
  // 问原因的「为什么」没有任指用法
  assert.ok(zh.questionCue('为什么都不说话') >= 0.5);
  // 「都」在疑问代词前面：照样是在问
  assert.ok(zh.questionCue('你们都去哪儿了') >= 0.5);
  // 任指 + 句末「吗」、问号：照样是在问
  assert.ok(zh.questionCue('你什么都知道吗') >= 0.9);
  assert.equal(zh.questionCue('谁都可以？'), 1);
  // 一句里先任指、后面又有真正的疑问代词
  assert.ok(zh.questionCue('什么都别管，你去哪') >= 0.5);
});

test('questionCue：疑问代词的读法看结构——「也」要接否定、让步才是任指；紧挨着否定是虚指；句末「么」只在不是代词的一部分时算', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  // 「也」后面不是否定、让步：在问（「什么时候也……了」= 什么时候也开始……）
  assert.ok(zh.questionCue('他什么时候也学会做饭了') >= 0.5);
  // 「都」跟在疑问代词后面：任指（肯定句也是）
  for (const s of ['他什么都吃', '谁都知道', '哪儿都去过']) assert.equal(zh.questionCue(s), 0, s);
  // 虚指：紧挨着否定
  for (const s of ['没什么', '我不怎么喜欢他', '没多少钱', '没有多少人', '不为什么']) assert.equal(zh.questionCue(s), 0, s);
  // 否定不紧挨着的照样是在问；虚指 + 句末「吗」照样是在问
  assert.ok(zh.questionCue('你为什么不来') >= 0.5);
  assert.ok(zh.questionCue('你没什么要说的吗') >= 0.9);
  // 让步只看「也 / 都」紧后面：后一个分句里的「好」不算
  assert.ok(zh.questionCue('你怎么也来了，好开心') >= 0.5);
  // 句末「么」：语气词算，「什么 / 这么 / 那么 / 要么」里的不算（「说什么」照样是疑问代词）
  assert.ok(zh.questionCue('这样好么') >= 0.9);
  assert.equal(zh.questionCue('就这么'), 0);
  assert.equal(zh.questionCue('原来那么'), 0);
  assert.equal(zh.questionCue('你说什么'), 0.6);
});

test('questionCue 和示例问法一致：pastQuestionExemplars 里的每一句在 L3 退路上都算在问（≥ recall.past.cueMin）', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  const { DEFAULTS } = await import('../../src/config/defaults.js');
  for (const s of zh.pastQuestionExemplars()) assert.ok(zh.questionCue(s) >= DEFAULTS.recall.past.cueMin, s);
  // 陈述句不算（示例问法不按字面比：「快递到了」和「快递拿了没」字面很近，但不是在问）
  for (const s of ['快递到了', '那件事办完了', '他后来去上海了']) assert.ok(zh.questionCue(s) < DEFAULTS.recall.past.lenientCueMin, s);
});

test('questionCue：「干嘛 / 干啥」是疑问代词；句末「来着」（想不起来、在回想）算句式线索', async () => {
  const zh = await createZhAnalyzer({ jieba: false });
  assert.ok(zh.questionCue('你在干嘛') >= 0.5);
  assert.ok(zh.questionCue('你干吗去') >= 0.5);
  assert.ok(zh.questionCue('明天干啥') >= 0.5);
  // retrieve 的请求（L3 时唯一的「在问过去」信号）：「来着」够得着 recall.past.cueMin（0.5）
  assert.ok(zh.questionCue('我上周说要干嘛来着') >= 0.5);
  assert.ok(zh.questionCue('他叫啥来着') >= 0.5);
  assert.ok(zh.questionCue('那家店来着') >= 0.5);
});
