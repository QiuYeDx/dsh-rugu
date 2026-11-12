// 后台模型（D168）：选定一对钉住、升级前配置的迁移、健康状态和错误分类、不工作时用聊天模型顶上、「试一下」、恢复时补积压、列出可选的、自检两项。
// 全部用假的 ctx.llm（test/fakes/fake-llm.js），绝不调真的模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLlmPort, errorKind, suggestFrom, verdictOf, pricedPair, CONFIG_CODES } from '../../src/ports/llm.js';
import { createBudget } from '../../src/ports/budget.js';
import { HOST_DEFAULTS, mergeHost, createConfigStore } from '../../src/host/config.js';
import { createConfig } from 'rugu-core';
import { createFakeLlm, llmOk, llmFail, GOOD_GLANCE, GOOD_EXTRACT, tmpDir, rmDir } from '../fakes/index.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const USES = ['glance', 'extract', 'sleep', 'summary', 'appraise', 'review', 'rewrite', 'perceive'];
const clockAt = (t0 = Date.UTC(2026, 10, 13, 2, 0)) => { let t = t0; return { now: () => t, advance: (ms) => { t += ms; } }; };
const req = (use, extra = {}) => ({ use, system: `系统-${use}`, messages: [{ role: 'user', content: `内容-${use}` }], ...extra });
const DS = { 'deepseek-account': { name: 'DeepSeek Account', models: ['deepseek-flash', 'deepseek-v4-pro'] }, 'deepseek-official': { name: 'DeepSeek', models: ['deepseek-flash', 'deepseek-v4-pro'] } };

/** 一个端口：llm 配置按 patch 改，健康状态存在 dir 里（给了的话）。 */
function env(o = {}) {
  const cfg = clone(HOST_DEFAULTS);
  cfg.llm.bgMinSpacingMs = 0;
  Object.assign(cfg.llm, o.llm ?? {});
  const fake = o.fake ?? createFakeLlm({ providers: o.providers ?? DS, ...(o.defaultSelection !== undefined ? { defaultSelection: o.defaultSelection } : {}), ...(o.script ? { script: o.script } : {}) });
  const clock = o.clock ?? clockAt();
  const recovered = [];
  const recorded = [];
  const budget = o.budget ?? { record: (use, u, m) => recorded.push({ use, u, m }), notifyQuota() {}, allow: () => true };
  const port = createLlmPort({ getLlm: fake.getLlm, getDefaultSelection: fake.getDefaultSelection, hostConfig: () => cfg, budget, now: clock.now,
    stateFile: o.dir ? path.join(o.dir, 'host-llm.json') : null, onRecover: (why) => recovered.push(why) });
  return { cfg, fake, clock, port, recovered, recorded, last: () => fake.state.calls.at(-1) };
}

// ── 选择和迁移 ──────────────────────────────────────────────────────────

test('主人现在的情形（DSH 默认 deepseek-account / deepseek-flash，配置里没有 host.llm）：8 个用途发出去的请求和改动前逐项相同', async () => {
  const dir = tmpDir('llm-owner');
  const e = env({ dir, defaultSelection: { provider: 'deepseek-account', model: 'deepseek-flash' } });
  // 改动前（a6e9dd7）的端口在这个情形下发出去的就是这些（.tmp 里拿旧代码逐项比过，8 / 8 相同）：服务商跟着默认选择、模型一律 deepseek-flash、
  // 思考取最低档 off、temperature 0.2、maxTokens 照传、system 和消息照传，没有别的字段
  for (const use of USES) {
    const r = await e.port.complete(req(use, { maxTokens: 321 }));
    const o = e.last();
    assert.deepEqual({ provider: o.provider, model: o.model, temperature: o.temperature, reasoningEffort: o.reasoningEffort, maxTokens: o.maxTokens, system: o.system },
      { provider: 'deepseek-account', model: 'deepseek-flash', temperature: 0.2, reasoningEffort: 'off', maxTokens: 321, system: `系统-${use}` }, use);
    assert.deepEqual(o.messages, [{ role: 'user', content: [{ type: 'text', text: `内容-${use}` }] }]);
    assert.deepEqual(Object.keys(o).sort(), ['maxTokens', 'messages', 'model', 'provider', 'reasoningEffort', 'signal', 'system', 'temperature'], `${use}：没有多出来的参数`);
    assert.deepEqual(r, { text: 'ok', usage: { in: 100, cached: 50, out: 20 }, model: 'deepseek-flash', stopReason: 'end' });
  }
  // 第一次成功就钉住了当时那一对（存在插件自己的状态文件里，不改配置文件）；之后 DSH 的默认换了也不跟着变
  e.port.dispose();
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'host-llm.json'), 'utf8'));
  assert.deepEqual([st.pinned.provider, st.pinned.model], ['deepseek-account', 'deepseek-flash']);
  const e2 = env({ dir, defaultSelection: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } });
  await e2.port.complete(req('extract'));
  assert.deepEqual([e2.last().provider, e2.last().model], ['deepseek-account', 'deepseek-flash'], '钉住以后不跟着 DSH 的默认服务商变');
  assert.equal(e2.port.target('extract').source, 'pinned');
  assert.equal(e2.port.health().pinned.provider, 'deepseek-account', '管理页能看到「后台模型定为 X」');
  e2.port.dispose();
  rmDir(dir);
});

test('迁移：手写过 models 的照写的用（只钉服务商）；拿不到默认选择时报 NO_PROVIDER，不去用 deepseek-official', async () => {
  const hand = env({ llm: { models: { ...HOST_DEFAULTS.llm.models, extract: 'deepseek-v4-pro' }, allow: ['deepseek-flash', 'deepseek-v4-pro'] }, defaultSelection: { provider: 'deepseek-account', model: 'deepseek-flash' } });
  await hand.port.complete(req('extract'));
  assert.deepEqual([hand.last().provider, hand.last().model], ['deepseek-account', 'deepseek-v4-pro']);
  await hand.port.complete(req('glance'));
  assert.equal(hand.last().model, 'deepseek-flash');
  const none = env({ defaultSelection: null });
  await assert.rejects(() => none.port.complete(req('extract')), (e) => e.code === 'NO_PROVIDER' && e.kind === 'config');
  assert.equal(none.fake.state.calls.length, 0, '没有猜一个服务商发出去');
  assert.equal(none.port.ready('extract'), false);
  assert.equal(none.port.health().state, 'down');
  // 配置里写了服务商的照旧用它
  const fixed = env({ llm: { provider: 'deepseek-official' }, defaultSelection: null });
  await fixed.port.complete(req('review'));
  assert.equal(fixed.last().provider, 'deepseek-official');
});

test('选定一对（target）：所有用途都用它，不看 models / allow；高级里第一眼、提炼可以单独一对，别的用途跟着 target', async () => {
  const providers = { ...DS, 'my-openai': { models: ['small-1', 'big-1'], strict: true } };
  const e = env({ providers, llm: { target: { provider: 'my-openai', model: 'small-1' }, perUse: { glance: null, extract: { provider: 'deepseek-account', model: 'deepseek-v4-pro' } } } });
  for (const use of USES) {
    await e.port.complete(req(use));
    const want = use === 'extract' ? ['deepseek-account', 'deepseek-v4-pro'] : ['my-openai', 'small-1'];
    assert.deepEqual([e.last().provider, e.last().model], want, use);
  }
  assert.equal(e.port.target('perceive').source, 'target', '看过的媒体不单独开放，跟着 target');
});

test('配置校验：target 是一对 / off / null，perUse 只认 glance 和 extract；写错的给 warning、照默认；换一对是有风险的改动（配置文件被改的先扣下）', () => {
  const w = [];
  const h = mergeHost(HOST_DEFAULTS, { llm: { target: { provider: 'a', model: 'b' }, perUse: { glance: 'off', extract: { provider: ' x ', model: 'y' } }, fallbackToChat: false } }, '', w);
  assert.deepEqual(h.llm.target, { provider: 'a', model: 'b' });
  assert.equal(h.llm.perUse.glance, null, 'perUse 不认 off');
  assert.deepEqual(h.llm.perUse.extract, { provider: 'x', model: 'y' });
  assert.equal(h.llm.fallbackToChat, false);
  assert.equal(w.length, 1);
  const w2 = [];
  assert.equal(mergeHost(HOST_DEFAULTS, { llm: { target: { provider: 'a' } } }, '', w2).llm.target, null);
  assert.match(w2[0], /host\.llm\.target/);
  assert.equal(mergeHost(HOST_DEFAULTS, { llm: { target: 'off' } }, '', []).llm.target, 'off');
  assert.equal(mergeHost(HOST_DEFAULTS, { llm: { perUse: { review: { provider: 'a', model: 'b' } } } }, '', w2).llm.perUse.review, undefined, '别的用途不开放');
  // 有风险：经管理页写要 confirm；配置文件直接被改的先扣下
  const dir = tmpDir('llm-cfg');
  const file = path.join(dir, 'persona-memory.json');
  const store = createConfigStore({ file });
  const r = store.set({ host: { llm: { target: { provider: 'p', model: 'm' } } } });
  assert.equal(r.ok, false);
  assert.match(r.needsConfirm[0], /后台模型换成 p \/ m/);
  assert.equal(store.set({ host: { llm: { target: { provider: 'p', model: 'm' } } } }, { confirm: true }).ok, true);
  assert.deepEqual(store.host().llm.target, { provider: 'p', model: 'm' });
  assert.equal(store.set({ host: { llm: { target: 'off' } } }).ok, true, '关掉不用确认（不会花更多钱）');
  fs.writeFileSync(file, JSON.stringify({ host: { llm: { target: { provider: 'pricey', model: 'huge' } } } }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  store.reload();
  assert.equal(store.host().llm.target, 'off', '文件里换成别的一对：先不生效');
  assert.equal(store.pending().length, 1);
  rmDir(dir);
});

// ── 健康状态 ────────────────────────────────────────────────────────────

test('错误分类：配置类 / 额度类 / 暂时类 / 这次请求的问题；取消和插件自己的排队不记', () => {
  for (const c of ['UNKNOWN_MODEL', 'NO_ADAPTER', 'MISSING_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'INVALID_CREDENTIAL', 'AUTH', 'ACCOUNT_TOKEN_INVALID',
    'MODEL_UNSUPPORTED', 'CLIENT_UPGRADE_REQUIRED', 'UNSUPPORTED_REASONING_EFFORT', 'UNSUPPORTED_OPTION', 'INVALID_CONFIG', 'NO_PROVIDER']) assert.equal(errorKind(c), 'config', c);
  for (const c of ['QUOTA', 'ACCOUNT_QUOTA']) assert.equal(errorKind(c), 'quota', c);
  for (const c of ['TIMEOUT', 'RATE_LIMIT', 'SERVER', 'TRANSPORT', 'MESSAGES_IDLE', 'EMPTY_RESPONSE', 'HTTP_502', 'ECONNRESET', 'PI_AI_ERROR', 'UNKNOWN']) assert.equal(errorKind(c), 'transient', c);
  assert.equal(errorKind('INVALID_REQUEST'), 'output', '第一次只当这次请求的问题');
  assert.equal(errorKind('INVALID_REQUEST', true), 'config', '连着两次：多半是参数不被接受');
  assert.equal(errorKind('CONTEXT_WINDOW_EXCEEDED'), 'output');
  for (const c of ['ABORTED', 'AbortError', 'LLM_BACKOFF', 'BUDGET']) assert.equal(errorKind(c), null, c);
  assert.ok(CONFIG_CODES.includes('UNKNOWN_MODEL'));
});

test('健康：配置类的错一次就判「不工作」，之后不再白调（LLM_DOWN），到点拿一次真实调用去试；恢复后状态消掉；重启后状态还在', async () => {
  const dir = tmpDir('llm-health');
  const providers = { 'my-openai': { models: ['small-1'], strict: true } };
  const clock = clockAt();
  const e = env({ dir, clock, providers, defaultSelection: null, llm: { target: { provider: 'my-openai', model: 'deepseek-flash' } } });
  await assert.rejects(() => e.port.complete(req('extract')), (x) => x.code === 'UNKNOWN_MODEL' && x.kind === 'config');
  assert.equal(e.fake.state.calls.length, 1);
  let h = e.port.health();
  assert.deepEqual([h.state, h.code, h.since], ['down', 'UNKNOWN_MODEL', clock.now()]);
  assert.match(verdictOf(h.code, h.pair), /没有叫 deepseek-flash 的模型/);
  await assert.rejects(() => e.port.complete(req('glance')), (x) => x.code === 'LLM_DOWN' && x.kind === 'config');
  assert.equal(e.fake.state.calls.length, 1, '不工作期间不再白调');
  assert.equal(e.port.ready('extract'), false);
  assert.equal(e.port.status().backoffUntil, null, '配置类的错不进后台队列的退避');
  e.port.dispose();
  // 重启：状态还在
  const e2 = env({ dir, clock, providers, defaultSelection: null, llm: { target: { provider: 'my-openai', model: 'deepseek-flash' } } });
  assert.equal(e2.port.health().state, 'down');
  assert.equal(e2.port.health().pairs[0].byCode.UNKNOWN_MODEL, 1, '最近 24 小时按错误码的计数');
  // 主人在 DSH 里把模型补上了；30 分钟后拿一次真实调用去试原来那一对，通了就恢复
  e2.fake.state.providers['my-openai'].models.push('deepseek-flash');
  clock.advance(31 * 60_000);
  assert.equal(e2.port.ready('extract'), true, '到点了，可以拿去试');
  await e2.port.complete(req('extract'));
  h = e2.port.health();
  assert.deepEqual([h.state, h.code], ['ok', null]);
  assert.deepEqual(e2.recovered, ['healthy'], '恢复了：叫宿主补积压');
  e2.port.dispose();
  rmDir(dir);
});

test('健康：暂时类的错看最近 30 分钟的失败率，过半判「不稳定」；INVALID_REQUEST 连着两次判「不工作」；额度用完通知余额保护', async () => {
  let fail = 'TIMEOUT';
  const e = env({ script: () => (fail ? llmFail(fail) : llmOk('ok')) });
  for (let i = 0; i < 3; i++) await assert.rejects(() => e.port.complete(req('appraise')), (x) => x.kind === 'transient');
  fail = null;
  await e.port.complete(req('appraise'));
  assert.equal(e.port.health().state, 'flaky', '4 次里 3 次失败');
  assert.equal(e.port.ready('extract'), true, '不稳定不挡');
  fail = 'INVALID_REQUEST';
  await assert.rejects(() => e.port.complete(req('appraise')), (x) => x.kind === 'output');
  assert.notEqual(e.port.health().state, 'down');
  await assert.rejects(() => e.port.complete(req('appraise')), (x) => x.kind === 'config');
  assert.equal(e.port.health().state, 'down');
  let quota = 0;
  const q = env({ script: () => llmFail('ACCOUNT_QUOTA'), budget: { record() {}, notifyQuota: () => { quota += 1; }, allow: () => true } });
  await assert.rejects(() => q.port.complete(req('review')), (x) => x.kind === 'quota');
  assert.equal(quota, 1);
  assert.equal(q.port.health().state, 'ok', '额度用完不算不工作（余额保护管）');
});

// ── 顶上 ────────────────────────────────────────────────────────────────

test('顶上：判成不工作后下一次用 DSH 聊天的那一对（服务商和模型一起）；记账照常、标成顶上的；原来那一对到点再试，通了换回', async () => {
  const providers = { ...DS, 'my-openai': { models: ['small-1'], strict: true } };
  const clock = clockAt();
  const e = env({ clock, providers, defaultSelection: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, llm: { target: { provider: 'my-openai', model: 'smal-1' } } });
  await assert.rejects(() => e.port.complete(req('extract')), (x) => x.code === 'UNKNOWN_MODEL');
  assert.equal(e.port.ready('extract'), true, '有可以顶上的');
  await e.port.complete(req('extract'));
  assert.deepEqual([e.last().provider, e.last().model], ['deepseek-account', 'deepseek-v4-pro']);
  assert.equal(e.recorded.at(-1).m.fallback, true, '花费照常记（标成顶上的）');
  let h = e.port.health();
  assert.equal(h.state, 'down');
  assert.deepEqual([h.fallback.provider, h.fallback.model], ['deepseek-account', 'deepseek-v4-pro'], '总览要说「临时在用你聊天的模型」');
  assert.equal(e.port.pricing().known, false, '顶着的是 pro：内置价目不认识，管理页不显示元');
  // 没到点：一直顶着，不去碰原来那一对
  const n = e.fake.state.calls.length;
  await e.port.complete(req('glance'));
  assert.equal(e.fake.state.calls.length, n + 1);
  assert.equal(e.last().provider, 'deepseek-account');
  // 主人修好了（模型名改对）——到点先试原来那一对，通了换回、提醒消掉
  e.cfg.llm.target = { provider: 'my-openai', model: 'small-1' };
  await e.port.complete(req('glance'));
  assert.deepEqual([e.last().provider, e.last().model], ['my-openai', 'small-1'], '换了一对就是新的一对，直接用');
  // 原来那一对（拼错的那个）的不工作状态不再是现在选的，总览按现在选的这一对算
  h = e.port.health();
  assert.deepEqual([h.state, h.fallback], ['ok', null]);
});

test('顶上：到点再试原来那一对——没修好就接着顶（同一次调用里），修好了就换回并恢复', async () => {
  const providers = { ...DS, 'my-openai': { models: ['small-1'], strict: true } };
  const clock = clockAt();
  const e = env({ clock, providers, defaultSelection: { provider: 'deepseek-account', model: 'deepseek-flash' }, llm: { target: { provider: 'my-openai', model: 'small-2' } } });
  await assert.rejects(() => e.port.complete(req('extract')));
  await e.port.complete(req('extract'));
  assert.equal(e.last().provider, 'deepseek-account');
  clock.advance(31 * 60_000);
  const before = e.fake.state.calls.length;
  await e.port.complete(req('extract'));
  const tried = e.fake.state.calls.slice(before).map((o) => `${o.provider}/${o.model}`);
  assert.deepEqual(tried, ['my-openai/small-2', 'deepseek-account/deepseek-flash'], '先试原来的，没通接着顶，这一次不白等');
  e.fake.state.providers['my-openai'].models.push('small-2');
  clock.advance(31 * 60_000);
  await e.port.complete(req('extract'));
  assert.deepEqual([e.last().provider, e.last().model], ['my-openai', 'small-2']);
  assert.equal(e.port.health().state, 'ok');
  assert.equal(e.port.health().fallback, null);
  assert.ok(e.recovered.includes('healthy'));
});

test('顶上：开关关掉时不顶；DSH 默认的那一对就是坏的那一对时不顶；拿不到默认选择时不顶', async () => {
  const providers = { 'my-openai': { models: ['small-1'], strict: true } };
  const off = env({ providers, defaultSelection: { provider: 'my-openai', model: 'small-1' }, llm: { target: { provider: 'my-openai', model: 'x' }, fallbackToChat: false } });
  await assert.rejects(() => off.port.complete(req('extract')));
  await assert.rejects(() => off.port.complete(req('extract')), (x) => x.code === 'LLM_DOWN');
  assert.equal(off.port.ready('extract'), false);
  const same = env({ providers, defaultSelection: { provider: 'my-openai', model: 'x' }, llm: { target: { provider: 'my-openai', model: 'x' } } });
  await assert.rejects(() => same.port.complete(req('extract')));
  await assert.rejects(() => same.port.complete(req('extract')), (x) => x.code === 'LLM_DOWN');
  const none = env({ providers, defaultSelection: null, llm: { target: { provider: 'my-openai', model: 'x' } } });
  await assert.rejects(() => none.port.complete(req('extract')));
  await assert.rejects(() => none.port.complete(req('extract')), (x) => x.code === 'LLM_DOWN');
  assert.equal(none.fake.state.calls.length, 1);
});

test('不用后台模型（off）：调用立即以 LLM_OFF（kind off）失败、不发请求；预算一次都不放行（试一下除外）；切回来算恢复', async () => {
  const e = env({ llm: { target: 'off' } });
  await assert.rejects(() => e.port.complete(req('glance')), (x) => x.code === 'LLM_OFF' && x.kind === 'off');
  assert.equal(e.fake.state.calls.length, 0);
  assert.equal(e.port.ready('extract'), false);
  assert.equal(e.port.health().state, 'off');
  e.cfg.llm.target = { provider: 'deepseek-account', model: 'deepseek-flash' };
  e.port.configChanged();
  assert.deepEqual(e.recovered, ['on']);
  // 预算：off 时不放行（原因记成 off），试一下照放
  const cfg = clone(HOST_DEFAULTS);
  cfg.llm.target = 'off';
  const b = createBudget({ coreConfig: createConfig({}), hostConfig: () => cfg, now: () => Date.UTC(2026, 10, 13, 2), llmOff: () => cfg.llm.target === 'off' });
  assert.equal(b.allow('extract', 10), false);
  assert.equal(b.allow('review', 10), false);
  assert.equal(b.allow('test', 10), true);
  assert.equal(b.status().today.denied['extract:off'], 1);
  assert.equal(b.status().today.calls, 1, '只有试一下算了一次');
});

// ── 试一下 ──────────────────────────────────────────────────────────────

/** 按请求的形状回：第一眼的系统提示词里有「第一眼」，提炼的是提炼提示词。 */
const byShape = (glance, extract) => (opts) => (/第一眼/.test(opts.system) ? glance(opts) : extract(opts));

test('试一下：两次很小的真实请求（第一眼、提炼的形状），用真实的解析器；结构化的结果和一句人话；过预算、记成用途 test', async () => {
  const allows = [];
  const recorded = [];
  const budget = { allow: (use, est) => { allows.push([use, est > 0]); return true; }, record: (use, u, m) => recorded.push([use, m]), notifyQuota() {} };
  let tick = 0;
  const clock = { now: () => tick };
  const e = env({ budget, clock, script: byShape(() => { tick += 900; return llmOk(GOOD_GLANCE, { inputTokens: 900, outputTokens: 120 }); }, () => { tick += 7000; return llmOk(GOOD_EXTRACT, { inputTokens: 5000, outputTokens: 90 }); }) });
  const r = await e.port.test({ provider: 'deepseek-account', model: 'deepseek-flash' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, '能用，第一眼 0.9 秒，提炼 7.0 秒');
  assert.deepEqual([r.steps.glance.valid, r.steps.glance.bad, r.steps.glance.expected, r.steps.extract.valid, r.steps.extract.bad], [2, 0, 2, 2, 0]);
  assert.equal(r.steps.glance.reported, true);
  assert.equal(r.steps.glance.thinking, false);
  assert.deepEqual(allows, [['test', true], ['test', true]], '两次都过预算');
  assert.deepEqual(recorded.map((x) => x[0]), ['test', 'test']);
  const sent = e.fake.state.calls;
  assert.equal(sent.length, 2);
  assert.match(sent[0].system, /第一眼/);
  assert.match(sent[1].system, /JSONL|json/i);
  assert.ok(!sent.some((o) => /deepseek-account/.test(o.messages[0].content[0].text)), '内容是编的，不带任何真实信息');
  assert.equal(e.port.health().lastTest.ok, true);
});

test('试一下：连不上（模型名不对）、格式不对、太慢、关不掉思考、预算不放行，各自的结论', async () => {
  const providers = { ...DS, 'my-openai': { models: ['small-1'], strict: true } };
  const bad = env({ providers });
  const r1 = await bad.port.test({ provider: 'my-openai', model: 'deepseek-flash' });
  assert.deepEqual([r1.ok, r1.level, r1.code], [false, 'bad', 'UNKNOWN_MODEL']);
  assert.equal(r1.verdict, '连不上：「my-openai」没有叫 deepseek-flash 的模型');
  assert.equal(r1.steps.extract, undefined, '第一步就是配置类的错：不再试第二步');
  assert.equal(bad.port.health().state, 'unknown', '试的不是选定的那一对：不影响现在的状态');
  const fmt = env({ script: () => llmOk('好的，下面是我的判断：这句话很私密。') });
  const r2 = await fmt.port.test();
  assert.deepEqual([r2.ok, r2.code], [false, 'BAD_OUTPUT']);
  assert.match(r2.verdict, /通了，但输出不是要的格式/);
  assert.ok(r2.steps.glance.bad > 0);
  let tick = 0;
  const slow = env({ clock: { now: () => tick }, script: byShape(() => { tick += 5200; return llmOk(GOOD_GLANCE); }, () => { tick += 8000; return llmOk(GOOD_EXTRACT); }) });
  const r3 = await slow.port.test();
  assert.deepEqual([r3.ok, r3.level, r3.code], [true, 'warn', 'SLOW']);
  assert.match(r3.verdict, /太慢：第一眼 5\.2 秒.*会让回想变少/);
  const think = env({ script: byShape(() => llmOk(GOOD_GLANCE, { inputTokens: 900, outputTokens: 5000 }), () => llmOk(GOOD_EXTRACT)) });
  const r4 = await think.port.test();
  assert.equal(r4.steps.glance.thinking, true);
  assert.match(r4.verdict, /关不掉的思考/);
  const denied = env({ budget: { allow: () => false, record() {}, notifyQuota() {} } });
  const r5 = await denied.port.test();
  assert.deepEqual([r5.ok, r5.code, denied.fake.state.calls.length], [false, 'BUDGET', 0], '试调不绕过预算');
  assert.match(r5.verdict, /花费到上限/);
});

test('试一下：试通了现在选的那一对，原来有提炼在等 → 恢复（叫宿主补积压）、顶着的换回', async () => {
  const providers = { ...DS, 'my-openai': { models: ['small-1'], strict: true } };
  const e = env({ providers, llm: { target: { provider: 'my-openai', model: 'small-2' } }, script: byShape(() => llmOk(GOOD_GLANCE), () => llmOk(GOOD_EXTRACT)) });
  await assert.rejects(() => e.port.complete(req('extract')));
  e.fake.state.providers['my-openai'].models.push('small-2');
  const r = await e.port.test();
  assert.equal(r.ok, true);
  assert.equal(e.port.health().state, 'ok');
  assert.deepEqual(e.recovered, ['test']);
});

// ── 列出、建议、认不认得 ─────────────────────────────────────────────────

test('列出可选的：服务商和各自的模型目录、现在选的、建议的（DeepSeek 有 flash 就建议它，先挑聊天用的那条通道；否则建议聊天的那一对）', async () => {
  const e = env({ providers: { ...DS, broken: { models: [] } }, defaultSelection: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } });
  e.fake.llm.listModels = async (id) => { if (id === 'broken') throw Object.assign(new Error('x'), { code: 'MISSING_CREDENTIAL' }); return (e.fake.state.providers[id].models).map((m) => ({ id: m, name: m })); };
  const l = await e.port.list();
  assert.equal(l.available, true);
  assert.deepEqual(l.providers.map((p) => p.id), ['deepseek-account', 'deepseek-official', 'broken']);
  assert.equal(l.providers[2].error, 'MISSING_CREDENTIAL');
  assert.deepEqual(l.suggest, { provider: 'deepseek-official', model: 'deepseek-flash', why: 'deepseek' }, '主人聊天用的是 official 那条通道');
  assert.deepEqual(l.current.target, null);
  assert.deepEqual(suggestFrom([{ id: 'my-openai', models: [{ id: 'gpt-x' }] }], { provider: 'my-openai', model: 'gpt-x' }), { provider: 'my-openai', model: 'gpt-x', why: 'chat' });
  assert.deepEqual(suggestFrom([{ id: 'deepseek-account', models: [] }], { provider: 'deepseek-account', model: 'deepseek-flash' }), { provider: 'deepseek-account', model: 'deepseek-flash', why: 'chat' }, '没登录、目录是空的：建议聊天那一对');
  assert.equal(suggestFrom([], null), null);
  assert.ok(pricedPair({ provider: 'deepseek-account', model: 'deepseek-flash' }));
  assert.ok(!pricedPair({ provider: 'deepseek-account', model: 'deepseek-v4-pro' }));
});

test('认不认得（自检用，不花钱）：服务商不在 / 模型不认 / 目录里没有 / 认得', async () => {
  const e = env({ providers: { ...DS, 'my-openai': { models: ['small-1'], strict: true } } });
  assert.deepEqual(await e.port.recognize({ provider: 'nope', model: 'x' }), { ok: false, code: 'NO_ADAPTER' });
  assert.deepEqual(await e.port.recognize({ provider: 'my-openai', model: 'x' }), { ok: false, code: 'UNKNOWN_MODEL' });
  assert.deepEqual(await e.port.recognize({ provider: 'deepseek-account', model: 'deepseek-x' }), { ok: true, inCatalog: false }, 'DeepSeek 的通道什么名字都认，目录里没有只提醒');
  assert.deepEqual(await e.port.recognize({ provider: 'deepseek-account', model: 'deepseek-flash' }), { ok: true, inCatalog: true });
  assert.equal(e.fake.state.calls.length, 0, '没发任何请求');
});

test('诊断摘要（复制后台模型状态）：服务商类型、模型名、思考档、上次试调、最近 24 小时按错误码的计数；不含服务商自己起的名字、地址、Key、内容', async () => {
  const e = env({ providers: { ...DS, 'my-own-gateway': { models: ['m1'], strict: true } }, llm: { target: { provider: 'my-own-gateway', model: 'm2' } } });
  await assert.rejects(() => e.port.complete(req('extract')));
  const s = e.port.summary();
  assert.equal(s.providerKind, 'other', '别的服务商的 id 可能是主人自己起的名字：只说是别的');
  assert.equal(s.model, 'm2');
  assert.equal(s.errors24h.UNKNOWN_MODEL, 1);
  assert.ok(!JSON.stringify(s).includes('my-own-gateway'));
  assert.ok(!JSON.stringify(s).includes('内容-'));
});
