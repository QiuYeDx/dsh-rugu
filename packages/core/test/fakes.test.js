import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, FakeLLM, FakeEmbedding, FakeRerank, FakeBudget, FakeSelfProfile, FakeLogger, cosine, fakePorts, createTestCore, DAY } from './fakes/index.js';
import { normalizePorts } from '../src/ports/index.js';
import { MODULES } from '../src/api.js';
import { PARAPHRASE_PAIRS } from './fixtures/paraphrase-pairs.js';

test('FakeClock 只能往后拨', () => {
  const c = new FakeClock('2026-10-31T10:00:00Z');
  const t0 = c.now();
  c.days(30);
  assert.equal(c.now() - t0, 30 * DAY);
  assert.throws(() => c.advance(-1));
  assert.throws(() => c.set(t0));
});

test('FakeLLM：按 use 取脚本；对象数组变 JSONL；函数、错误、fallback', async () => {
  const llm = new FakeLLM({
    script: { extract: [[{ type: 'header', text: '10/31 晚上' }, { type: 'fact', text: '主人今晚加班' }], (req) => `echo:${req.messages[0].content}`] },
    fallback: { appraise: [{ ref: 'a1', verdict: 'omit' }] },
  });
  const r1 = await llm.complete({ use: 'extract', system: 's', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(r1.text.split('\n').map((l) => JSON.parse(l).type), ['header', 'fact']);
  assert.ok(r1.usage.in > 0 && r1.usage.out > 0);
  const r2 = await llm.complete({ use: 'extract', system: 's', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r2.text, 'echo:hi');
  await assert.rejects(llm.complete({ use: 'extract', system: 's', messages: [] }), /没有准备回复/);
  assert.equal(JSON.parse((await llm.complete({ use: 'appraise', system: '', messages: [] })).text).verdict, 'omit');
  llm.fail('review');
  await assert.rejects(llm.complete({ use: 'review', system: '', messages: [] }), (e) => e.code === 'LLM_DOWN');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(llm.complete({ use: 'appraise', system: '', messages: [], signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(llm.callsFor('extract').length, 3);
});

test('FakeEmbedding：确定、归一化、换个说法更近、同义词、故障', async () => {
  const e = new FakeEmbedding({ dim: 256, synonyms: [['快递', '包裹'], ['拿', '取']] });
  const v1 = e.vector('快递拿了没');
  assert.deepEqual(e.vector('快递拿了没'), v1, '同一段文字同一个向量');
  assert.ok(Math.abs(cosine(v1, v1) - 1) < 1e-5, 'L2 归一化');
  const para = cosine(e.vector('下午去驿站取了包裹'), v1);
  const unrelated = cosine(e.vector('今晚又要加班'), v1);
  assert.ok(para > unrelated + 0.1, `换个说法应该更近：${para} vs ${unrelated}`);
  const plain = new FakeEmbedding({ dim: 256 });
  assert.ok(cosine(plain.vector('我表哥开网约车'), plain.vector('阿明的表哥开网约车')) > cosine(plain.vector('我表哥开网约车'), plain.vector('主人在玩新游戏')));
  const { spaceId, vectors } = await e.embed(['a', 'b'], 'doc');
  assert.equal(spaceId, e.info().spaceId);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, 256);
  assert.notEqual(new FakeEmbedding({ dim: 128 }).info().spaceId, plain.info().spaceId, '维数不同 = 不同的空间');
  e.setFailing(true);
  await assert.rejects(e.embed(['a'], 'query'), (x) => x.code === 'EMBED_DOWN');
  await assert.rejects(e.embed(['a'], 'sideways'));
  assert.equal(e.vector('').length, 256);
  const rr = new FakeRerank(plain);
  const scores = await rr.rerank('表哥开网约车', ['阿明的表哥开网约车', '今晚加班']);
  assert.ok(scores[0] > scores[1]);
  rr.setAvailable(false);
  assert.equal(rr.available(), false);
});

test('FakeBudget：外发审视有独立预留；暂停时只剩预留', () => {
  const b = new FakeBudget({ perUse: { extract: 1 }, reserve: 2 });
  assert.equal(b.allow('extract', 100), true);
  assert.equal(b.allow('extract', 100), false);
  b.pause();
  assert.equal(b.allow('appraise', 10), false);
  assert.equal(b.allow('review', 10), true);
  assert.equal(b.allow('review', 10), true);
  assert.equal(b.allow('review', 10), false);
  assert.equal(b.state().reserveLeft, 0);
  b.resume().resetDay();
  assert.equal(b.allow('extract', 1), true);
});

test('FakeSelfProfile 和 FakeLogger', () => {
  const p = new FakeSelfProfile();
  const h1 = p.coreSelf().hash;
  p.setText('别的性格');
  assert.notEqual(p.coreSelf().hash, h1);
  assert.equal(p.principalLabel(), '主人');
  const log = new FakeLogger();
  log.info('recall.done', { ms: 12, items: 3 });
  assert.doesNotThrow(() => log.assertNoText('今晚又要加班'));
  log.warn('oops', { text: '今晚又要加班' });
  assert.throws(() => log.assertNoText('今晚又要加班'), /不该有的内容/);
});

test('createTestCore：真库 + 可替换的 core.mods', async () => {
  const { core, cleanup } = await createTestCore({
    name: 'testcore',
    mods: { discretion: { writeNorm: () => 7 } },
  });
  try {
    assert.equal(core.mods.discretion.writeNorm(core, { kind: 'assertion', id: 1 }, {}), 7, '替换的函数生效');
    assert.equal(core.mods.discretion.normOf, MODULES.discretion.normOf, '没换的照用真模块');
    assert.equal(core.mods.discretion.normOf(core, { kind: 'assertion', id: 1 }).unassessed, true, '真模块：没写过规范的按 unassessed（§5.6）');
    assert.ok(core.store.get("SELECT name FROM sqlite_schema WHERE name = 'assertions'"));
    assert.ok(core.vectors);
    assert.equal(typeof core.state.intake, 'object', '各模块 init 跑过');
    assert.equal(core.now(), new FakeClock().now());
    assert.throws(() => { core.mods.discretion.writeNorm = null; }, TypeError, 'mods 是冻结的，测试之间不会互相污染');
  } finally { await cleanup(); }
  await assert.rejects(createTestCore({ mods: { nope: {} } }), /没有这个模块/);
});

test('替身是确定的：两次 createTestCore 的场合键、两个 FakeEmbedding 的向量、两次 FakeLLM 的回复都一样', async () => {
  const a = await createTestCore({ name: 'det-a' });
  const b = await createTestCore({ name: 'det-b' });
  try {
    assert.equal(a.core.keys.settingKey('zz', 'S1'), b.core.keys.settingKey('zz', 'S1'), '默认用固定的测试密钥');
    assert.equal(a.core.now(), b.core.now());
  } finally { await a.cleanup(); await b.cleanup(); }
  const c = await createTestCore({ name: 'det-c', key: Buffer.alloc(32, 7) });
  try {
    assert.notEqual(c.core.keys.settingKey('zz', 'S1'), a.core.keys.settingKey('zz', 'S1'), '传了 key 就用它');
  } finally { await c.cleanup(); }
  assert.deepEqual(new FakeEmbedding().vector('阿明的表哥开网约车'), new FakeEmbedding().vector('阿明的表哥开网约车'));
  const run = async () => {
    const llm = new FakeLLM({ script: { extract: [[{ type: 'fact', text: 'x' }]] } });
    return llm.complete({ use: 'extract', system: 's', messages: [{ role: 'user', content: 'u' }] });
  };
  assert.deepEqual(await run(), await run());
});

test('FakeEmbedding 合理性：V0 探针里换说法的句子对，平均余弦高于随便配的一对', () => {
  for (const dim of [128, 256, 512]) {
    const e = new FakeEmbedding({ dim });
    let para = 0;
    let rand = 0;
    let n = 0;
    PARAPHRASE_PAIRS.forEach(([q, m], i) => {
      const qv = e.vector(q);
      para += cosine(qv, e.vector(m));
      PARAPHRASE_PAIRS.forEach(([, other], j) => { if (j !== i) { rand += cosine(qv, e.vector(other)); n += 1; } });
    });
    para /= PARAPHRASE_PAIRS.length;
    rand /= n;
    // dim 256 时实测约 0.21 vs 0.12。字符 n-gram 抓不住真正的同义改写，所以只要求平均更近，不要求每对都排第一
    assert.ok(para > rand + 0.05, `dim ${dim}：换说法 ${para.toFixed(3)} 应该明显高于随便配 ${rand.toFixed(3)}`);
  }
});

test('fakePorts 能通过端口检查；null 表示没有这个端口', () => {
  const ports = normalizePorts(fakePorts());
  assert.equal(typeof ports.llm.complete, 'function');
  const noEmbed = normalizePorts(fakePorts({ embedding: null }));
  assert.equal(noEmbed.embedding, undefined);
  assert.equal(noEmbed.rerank, undefined);
  assert.throws(() => normalizePorts({ llm: {} }), /缺少方法 complete/);
  assert.throws(() => normalizePorts({ languages: [{ lang: 'xx', detect() {} }] }), /缺少方法/);
});
