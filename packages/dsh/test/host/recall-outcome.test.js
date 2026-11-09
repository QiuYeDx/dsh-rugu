// 等回想的结果（D117，实测问题 #28）：宿主等核心回想时，等到 / 超时 / 报错 / 取消都交回核心记下来（重启也留得下、管理页看得到）；
// 报错和超时一样退回 recallCached（核心把工作记忆第一步就写进缓存）；回想的健康进启动自检的一行和管理页的诊断。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePm, fakeAgent, userMessage, FakeDshCtx } from '../fakes/index.js';
import { makeHost } from './helpers.js';
import { runSelfCheck } from '../../src/host/selfcheck.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';
import { resolvePaths } from '../../src/host/paths.js';
import { recallHealthRow } from '../../src/admin/views.js';
import { tmpDir } from '../fakes/index.js';

const WM = { id: 'p77', layer: 'working', rendered: '〔你们俩私聊时 · 20 分钟前〕主人：我下周去杭州出差', verdict: 'share', confidence: 1, provenance: '', appraisalRef: 'ap77' };
const cachedWm = () => ({ items: [WM], degradeLevel: 1, traceId: 'cached' });

test('回想报错（rejected）：退回 recallCached，工作记忆照样注入；报 error（带错误类型、退回缓存给了几条），计 recallErrors', async () => {
  const pm = createFakePm({ recall: async () => { throw Object.assign(new TypeError("Cannot read properties of undefined (reading 'l')"), { code: undefined }); }, cached: cachedWm });
  const h = await makeHost({ pm, name: 'ro-error' });
  try {
    const d = await h.ctx.preStep(fakeAgent({ id: 's-err', preset: 'zz-chat' }), [userMessage('在吗', { id: 'u1' })], { step: 1 });
    assert.equal(d.messages.length, 3, '工作记忆照样插进来了');
    assert.ok(d.messages[1].content[0].text.includes('杭州'));
    const o = pm.named('recallOutcome').at(-1).args;
    assert.equal(o[0], 's-err');
    assert.equal(o[1].outcome, 'error');
    assert.equal(o[1].code, 'TypeError');
    assert.equal(o[1].served, 1);
    assert.equal(o[1].trigger, 'message');
    assert.ok(Number.isFinite(o[1].waitedMs));
    assert.equal(h.host.status().context.recallErrors, 1);
    assert.equal(h.host.status().context.recallCachedServed, 1);
  } finally { await h.cleanup(); }
});

test('等超时：退回缓存，报 timeout（等了多久、给了几条）；按时等到的报 ok', async () => {
  const pm = createFakePm({ recall: () => new Promise(() => {}), cached: cachedWm });
  const h = await makeHost({ pm, name: 'ro-timeout', config: { recall: { deliberate: { deadlineMs: 60 } }, host: { inject: { deadlineMs: 30, graceMs: 20 } } } });
  try {
    const d = await h.ctx.preStep(fakeAgent({ id: 's-to', preset: 'zz-chat' }), [userMessage('在吗', { id: 'u1' })], { step: 1 });
    assert.equal(d.messages.length, 3);
    const o = pm.named('recallOutcome').at(-1).args[1];
    assert.equal(o.outcome, 'timeout');
    assert.equal(o.served, 1);
    assert.ok(o.waitedMs >= 70, `按 60 + 20 等：${o.waitedMs}`);
  } finally { await h.cleanup(); }
  const ok = createFakePm();
  const h2 = await makeHost({ pm: ok, name: 'ro-ok' });
  try {
    await h2.ctx.preStep(fakeAgent({ id: 's-ok', preset: 'zz-chat' }), [userMessage('在吗', { id: 'u1' })], { step: 1 });
    assert.equal(ok.named('recallOutcome').at(-1).args[1].outcome, 'ok');
    assert.equal(ok.named('recallCached').length, 0);
  } finally { await h2.cleanup(); }
});

test('pm.recall 同步抛错（契约校验之类）：不让钩子出错，照样退回缓存', async () => {
  const pm = createFakePm({ cached: cachedWm });
  pm.recall = (s) => { pm.calls.push({ name: 'recall', args: [s] }); throw Object.assign(new Error('SituationRef 不合契约'), { code: 'CONTRACT', name: 'ContractError' }); };
  const h = await makeHost({ pm, name: 'ro-sync' });
  try {
    const d = await h.ctx.preStep(fakeAgent({ id: 's-sync', preset: 'zz-chat' }), [userMessage('在吗', { id: 'u1' })], { step: 1 });
    assert.equal(d.messages.length, 3);
    assert.equal(pm.named('recallOutcome').at(-1).args[1].code, 'CONTRACT');
  } finally { await h.cleanup(); }
});

test('启动自检的一行：今天出错几处（按步骤）、整轮什么都没给几次、宿主等超时几次；最近一次出错的步骤、错误类型、代码位置', async () => {
  const pm = createFakePm();
  pm.health = {
    days: [
      { day: '2026-11-06', recalls: 153, errors: 37, partial: 37, lost: 0, byStage: { 'working-select': 37 }, byCode: { 'working-select.TypeError': 37 }, ms: {}, host: { timeout: 2 }, embed: {} },
      { day: '2026-11-05', recalls: 100, errors: 5, partial: 5, lost: 0, byStage: {}, byCode: {}, ms: {}, host: {}, embed: {} },
    ],
    recent: [{ at: Date.UTC(2026, 10, 6, 6, 0), stage: 'working-select', code: 'TypeError', frame: 'context/working.js:391', trigger: 'message', level: 3 }],
    buckets: [],
  };
  const cfg = JSON.parse(JSON.stringify(HOST_DEFAULTS));
  const r = await runSelfCheck({
    ctx: new FakeDshCtx(), ctxGet: () => null, getPm: () => pm, hostConfig: () => cfg, paths: resolvePaths({ dshHome: tmpDir('ro-sc') }),
    ports: { embedding: null, rerank: null, selfProfile: { status: () => ({ configured: false }) } }, claims: null, tooltable: { status: () => ({ unclassified: [] }) },
    registered: {}, defineToolAvailable: true, adapters: [], skipNetwork: true, now: () => 1000,
  });
  const it = r.items.find((x) => x.id === 'store.recall');
  assert.equal(it.status, 'warn');
  assert.match(it.label, /今天 153 次，出错 37 处（working-select 37），整轮什么都没给 0 次；宿主等超时 2 次（昨天出错 5 处）/);
  assert.match(it.detail, /working-select · TypeError @ context\/working\.js:391/);
  // 升级前的旧计数（D117 之前的 context.recall.error，没有明细）：写出来，但不当成现在的出错提醒
  pm.health = { days: [{ recalls: 10, errors: 0, legacyErrors: 37, lost: 0, byStage: {}, host: {} }], recent: [], buckets: [] };
  const r2 = await runSelfCheck({
    ctx: new FakeDshCtx(), ctxGet: () => null, getPm: () => pm, hostConfig: () => cfg, paths: resolvePaths({ dshHome: tmpDir('ro-sc2') }),
    ports: { embedding: null, rerank: null, selfProfile: { status: () => ({ configured: false }) } }, claims: null, tooltable: { status: () => ({ unclassified: [] }) },
    registered: {}, defineToolAvailable: true, adapters: [], skipNetwork: true, now: () => 1000,
  });
  const it2 = r2.items.find((x) => x.id === 'store.recall');
  assert.equal(it2.status, 'ok');
  assert.match(it2.label, /升级前的旧计数 37 次（没有明细）/);
});

test('管理页的诊断（recallHealthRow）：只留数字、步骤名、错误类型和代码位置；多给的字段（万一带了内容）不出去', () => {
  const row = recallHealthRow({
    days: [{ day: '2026-11-06', recalls: 3, errors: 1, legacyErrors: 37, partial: 1, lost: 0, byStage: { render: 1, '坏 键': 2 }, byCode: { 'render.TypeError': 1 }, ms: { le300: 3 },
      host: { timeout: 1, wait: { le4500: 1 } }, embed: { retry: 1 }, text: '不该出现的内容' }],
    recent: [{ at: 1, stage: 'render', code: 'TypeError', frame: 'context/recall.js:700', layer: 'recalled', rendered: '不该出现的内容' }],
    buckets: ['le300'],
  });
  assert.deepEqual(row.days[0].byStage, { render: 1 });
  assert.equal(row.days[0].legacyErrors, 37);
  assert.equal(row.days[0].host.wait.le4500, 1);
  assert.equal(row.recent[0].frame, 'context/recall.js:700');
  assert.doesNotMatch(JSON.stringify(row), /不该出现的内容/);
});
