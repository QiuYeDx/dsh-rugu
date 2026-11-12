// 后台模型（D168）在宿主里的接法：恢复时叫核心补积压（带配置类的错误码）；「不用」→ 开算恢复；首次设置钉在建议的那一对；
// 管理页的 llmSetup（列出、试一下、保存、状态）。全部用假的 ctx.llm。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHost } from '../../src/host/index.js';
import { FakeDshCtx, createFakeLlm, llmOk, GOOD_GLANCE, GOOD_EXTRACT, tmpDir, rmDir } from '../fakes/index.js';
import { makeHost, offlineFetch } from './helpers.js';

/** 把假的 ctx.llm 和默认模型装进 FakeDshCtx。 */
function ctxWith(fake) {
  const ctx = new FakeDshCtx();
  ctx.services.set('llm', fake.llm);
  ctx.services.set('agentDefaultModel', fake.agentDefaultModel);
  return ctx;
}
const resumes = (pm) => pm.calls.filter((c) => c.name === 'resumeExtraction');

test('「不用后台模型」→ 选回一对：算恢复，叫核心把推迟的提炼提到现在补（带配置类的错误码，升级前搁置的也补）', async () => {
  const fake = createFakeLlm();
  const t = await makeHost({ ctx: ctxWith(fake), name: 'llm-off-on' });
  try {
    const api = t.host.api.llmSetup;
    api.save({ target: 'off' });
    assert.equal(t.host.ports.llm.ready('extract'), false);
    assert.equal(api.status().state, 'off');
    api.save({ target: { provider: 'deepseek-account', model: 'deepseek-flash' } });
    const r = resumes(t.pm);
    assert.equal(r.length, 1);
    assert.ok(r[0].args[0].errorCodes.includes('UNKNOWN_MODEL') && r[0].args[0].errorCodes.includes('AUTH'));
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'persona-memory.json'), 'utf8'));
    assert.deepEqual(saved.host.llm.target, { provider: 'deepseek-account', model: 'deepseek-flash' }, '写进配置文件');
  } finally { await t.cleanup(); }
});

test('配错的那一对修好了（到点再试通了）：恢复，叫核心补积压；之前不工作时一直标着在等', async () => {
  const fake = createFakeLlm({ providers: { 'my-openai': { models: ['small-1'], strict: true } }, defaultSelection: null });
  let t0 = Date.UTC(2026, 10, 13, 2);
  const clock = { now: () => t0 };
  const t = await makeHost({ ctx: ctxWith(fake), name: 'llm-heal', config: { host: { llm: { target: { provider: 'my-openai', model: 'small-2' } } } }, deps: { clock } });
  try {
    const llm = t.host.ports.llm;
    await assert.rejects(() => llm.complete({ use: 'extract', system: '', messages: [] }), (e) => e.kind === 'config');
    assert.equal(llm.ready('extract'), false, '提炼推迟等恢复');
    assert.equal(resumes(t.pm).length, 0);
    fake.state.providers['my-openai'].models.push('small-2');
    t0 += 31 * 60_000;
    await llm.complete({ use: 'glance', system: '', messages: [] });
    assert.equal(resumes(t.pm).length, 1);
    assert.equal(t.host.api.llmSetup.status().state, 'ok');
  } finally { await t.cleanup(); }
});

test('管理页的 llmSetup：列出、试一下（试的内容是编的，记成用途 test）、诊断摘要带插件版本', async () => {
  const fake = createFakeLlm({ script: (o) => (/第一眼/.test(o.system) ? llmOk(GOOD_GLANCE) : llmOk(GOOD_EXTRACT)) });
  const t = await makeHost({ ctx: ctxWith(fake), name: 'llm-admin' });
  try {
    const api = t.host.api.llmSetup;
    const l = await api.list();
    assert.deepEqual(l.suggest, { provider: 'deepseek-account', model: 'deepseek-flash', why: 'deepseek' });
    const r = await api.test(null);
    assert.equal(r.ok, true, r.verdict);
    assert.equal(t.host.ports.budget.status().today.byUse.test.calls, 2, '试调记在用途 test 下');
    const s = api.summary();
    assert.match(String(s.plugin), /^\d+\.\d+\.\d+/);
    assert.equal(s.providerKind, 'deepseek-account');
    assert.equal(s.lastTest.ok, true);
  } finally { await t.cleanup(); }
});

test('首次设置：向导里没选后台模型的，完成时钉在建议的那一对（DSH 有 DeepSeek 的通道、目录里有 flash）', async () => {
  const dir = tmpDir('llm-firstrun');
  const fake = createFakeLlm();
  const ctx = ctxWith(fake);
  const pm = { admin: {}, status: () => ({}), registerAdapter: () => () => {}, close: async () => {}, modeOf: () => 'off', sessions: {} };
  const host = createHost(ctx, {}, { dshHome: dir, coreOptions: { startWorker: false }, adapterFactories: {}, registerAdmin: null, defineTool: (d) => d, sampler: null,
    skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch, firstRun: true, coreFactory: async () => pm });
  try {
    await host.api.setup.finish({});
    assert.equal(await host.ready, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'persona-memory.json'), 'utf8'));
    assert.deepEqual(saved.host.llm.target, { provider: 'deepseek-account', model: 'deepseek-flash' });
  } finally { await host.dispose(); rmDir(dir); }
});
