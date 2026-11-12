// LLMPort 对别家模型的兼容（D169）：拒收 temperature 的立刻不带重试一次并记住；关不掉思考的模型（输出 token 远多于正文）记住、之后 maxTokens 乘余量。
// 用假的 ctx.llm（FakeDshCtx），不发真实请求。DeepSeek flash 思考关的正常情形：请求参数逐项不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmPort, PARAM_REJECT_CODES } from '../../src/ports/llm.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';
import { FakeDshCtx } from '../fakes/index.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const hostWith = (patch = {}) => {
  const h = clone(HOST_DEFAULTS);
  for (const [k, v] of Object.entries(patch)) h[k] = { ...h[k], ...v };
  return () => h;
};
const ok = (text = 'ok', out = 2) => [{ type: 'text-delta', text }, { type: 'usage', usage: { inputTokens: 10, outputTokens: out } }, { type: 'finish', reason: { kind: 'stop' } }];
const rejected = (code = 'INVALID_REQUEST') => [{ type: 'finish', reason: { kind: 'error', failure: { code, message: 'Unsupported parameter: temperature' } } }];
const port = (ctx, o = {}) => {
  const recorded = [];
  const logs = [];
  const llm = createLlmPort({ getLlm: () => ctx.llm, getDefaultSelection: () => ctx.agentDefaultModel.currentSelection(), hostConfig: hostWith(o.host ?? {}), budget: { record: (use, u, m) => recorded.push({ use, u, m }) },
    log: { warn() {}, info: (ev, f) => logs.push({ ev, f }) } });
  return { llm, recorded, logs };
};

test('D169 LLMPort：DeepSeek flash 思考关的正常情形，请求参数逐项和以前一样（temperature 0.2、maxTokens 原样、思考关）', async () => {
  const ctx = new FakeDshCtx();
  const { llm } = port(ctx);
  for (let i = 0; i < 3; i++) await llm.complete({ use: 'glance', system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 600 });
  await llm.complete({ use: 'review', system: 's', messages: [], maxTokens: 260 });
  assert.equal(ctx.llmCalls.length, 4, '不重试');
  for (const o of ctx.llmCalls) {
    assert.equal(o.temperature, 0.2);
    assert.equal(o.reasoningEffort, 'off');
    assert.equal(o.provider, 'deepseek-official');
    assert.equal(o.model, 'deepseek-flash');
  }
  assert.deepEqual(ctx.llmCalls.map((o) => o.maxTokens), [600, 600, 600, 260]);
  assert.deepEqual(Object.keys(ctx.llmCalls[0]).sort(), ['maxTokens', 'messages', 'model', 'provider', 'reasoningEffort', 'signal', 'system', 'temperature']);
});

test('D169 LLMPort：temperature 被拒（INVALID_REQUEST / UNSUPPORTED_OPTION）→ 立刻不带重试一次，成了就记住这一对，之后直接不带', async () => {
  assert.deepEqual([...PARAM_REJECT_CODES], ['INVALID_REQUEST', 'UNSUPPORTED_OPTION']);
  for (const code of PARAM_REJECT_CODES) {
    const ctx = new FakeDshCtx();
    ctx.llmScript = (o) => ('temperature' in o ? rejected(code) : ok('{"verdict":"speak"}', 8));
    const { llm, recorded, logs } = port(ctx);
    const r = await llm.complete({ use: 'review', system: '', messages: [], maxTokens: 260, meta: { sourceKey: 'k' } });
    assert.equal(r.text, '{"verdict":"speak"}');
    assert.equal(ctx.llmCalls.length, 2, `${code}：重试一次`);
    assert.equal(ctx.llmCalls[0].temperature, 0.2);
    assert.equal('temperature' in ctx.llmCalls[1], false);
    assert.equal(ctx.llmCalls[1].maxTokens, 260, '别的参数不变');
    // 被拒的那一次也报给预算（失败的调用），成功的那次照常记
    assert.deepEqual(recorded.map((x) => [x.use, !!x.m.failed]), [['review', true], ['review', false]]);
    assert.ok(logs.some((l) => l.ev === 'llm.noTemperature'));
    // 之后这一对直接不带（别的用途、同一对也一样）
    await llm.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
    assert.equal(ctx.llmCalls.length, 3);
    assert.equal('temperature' in ctx.llmCalls[2], false);
  }
});

test('D169 LLMPort：别的错不重试；不带 temperature 也被拒就记住、以后不再试（不翻倍花钱）', async () => {
  for (const code of ['TIMEOUT_X', 'RATE_LIMIT', 'SERVER', 'AUTH', 'QUOTA']) {
    const ctx = new FakeDshCtx();
    ctx.llmScript = () => rejected(code);
    const { llm } = port(ctx);
    await assert.rejects(() => llm.complete({ use: 'appraise', system: '', messages: [] }), (e) => e.code === code);
    assert.equal(ctx.llmCalls.length, 1, `${code} 不重试`);
  }
  // 抛出来的错（不是 finish 块）也按 code 判
  const thrown = new FakeDshCtx();
  thrown.llmScript = () => [Object.assign(new Error('boom'), { code: 'TRANSPORT' })];
  await assert.rejects(() => port(thrown).llm.complete({ use: 'appraise', system: '', messages: [] }));
  assert.equal(thrown.llmCalls.length, 1);
  // 400 跟 temperature 无关：不带也被拒 → 这一对记成「不带也没用」，之后照旧带 temperature、不再重试
  const ctx = new FakeDshCtx();
  ctx.llmScript = () => rejected('INVALID_REQUEST');
  const { llm, recorded } = port(ctx);
  await assert.rejects(() => llm.complete({ use: 'appraise', system: '', messages: [] }), (e) => e.code === 'INVALID_REQUEST');
  assert.equal(ctx.llmCalls.length, 2);
  assert.equal(recorded.filter((x) => x.m.failed).length, 2, '两次都报给预算');
  await assert.rejects(() => llm.complete({ use: 'appraise', system: '', messages: [] }));
  assert.equal(ctx.llmCalls.length, 3, '不再重试');
  assert.equal(ctx.llmCalls[2].temperature, 0.2);
});

test('D169 LLMPort：关不掉思考——输出 token 远多于正文（> 3 倍）就记住这一对，之后 maxTokens × 3；阈值和余量可配', async () => {
  const ctx = new FakeDshCtx();
  // 第一次：正文 10 个字，输出 token 590（思考吃掉了额度）
  ctx.llmScript = () => ok('{"i":1,"s":0}', 590);
  const { llm, logs } = port(ctx);
  await llm.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  assert.equal(ctx.llmCalls[0].maxTokens, 600, '检测之前不变');
  assert.ok(logs.some((l) => l.ev === 'llm.thinkingHeavy'));
  await llm.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  await llm.complete({ use: 'review', system: '', messages: [], maxTokens: 260 });
  await llm.complete({ use: 'perceive', system: '', messages: [], maxTokens: 200 });
  assert.deepEqual(ctx.llmCalls.slice(1).map((o) => o.maxTokens), [1800, 780, 600]);
  assert.equal(ctx.llmCalls[1].temperature, 0.2, '只动 maxTokens');

  // 正常的输出（token 和字数相当、很短的输出、宿主没报用量）不触发
  for (const [text, out] of [['{"id":"c1","verdict":"share","reason":"日常闲聊"}', 30], ['ok', 40], ['好', 63]]) {
    const c = new FakeDshCtx();
    c.llmScript = () => ok(text, out);
    const p = port(c).llm;
    await p.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
    await p.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
    assert.equal(c.llmCalls[1].maxTokens, 600, `${text}/${out} 不触发`);
  }
  const noUsage = new FakeDshCtx();
  noUsage.llmScript = () => [{ type: 'text-delta', text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }];
  const nu = port(noUsage).llm;
  await nu.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  await nu.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  assert.equal(noUsage.llmCalls[1].maxTokens, 600, '没报用量（按字数估的）不判');

  // 配置：ratio 10、factor 2
  const c2 = new FakeDshCtx();
  c2.llmScript = () => ok('一二三四五六七八九十', 80);
  const p2 = port(c2, { host: { llm: { thinkingHeadroom: { ratio: 10, factor: 2, minTokens: 64 } } } }).llm;
  await p2.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  await p2.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  assert.equal(c2.llmCalls[1].maxTokens, 600, '80 ≤ 10 × 10：不触发');
  c2.llmScript = () => ok('一', 120);
  await p2.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  await p2.complete({ use: 'glance', system: '', messages: [], maxTokens: 600 });
  assert.equal(c2.llmCalls[3].maxTokens, 1200);
});
