// 启动自检（§13.2）：每一项只有状态、计数和提示；失败的写明关掉了什么；绝不影响聊天。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSelfCheck, whitelistState, normalizeAdapterCheck, failedAdapters, PATCH_MARK } from '../../src/host/selfcheck.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';
import { resolvePaths } from '../../src/host/paths.js';
import { createFakePm, fakeBinding, tmpDir, rmDir, FakeDshCtx } from '../fakes/index.js';

const allRegistered = { resident: true, preStep: true, preExecute: true, postExecute: true, guard: true, sessionEvent: true, agentCreated: true };
const ports = (o = {}) => ({
  embedding: { checkHealth: async () => o.health ?? { ok: true, version: '0.40.13', model: 'qwen3-embedding:4b', modelPresent: true, dim: 1024, tier: 'standard' } },
  rerank: null,
  selfProfile: { status: () => o.self ?? { configured: true, present: true, chars: 20 }, coreSelf: () => ({ text: o.selfText ?? '说话温和，偶尔调皮。', hash: 'h' }) },
});

function deps(o = {}) {
  const dir = o.dir;
  const ctx = new FakeDshCtx();
  const cfg = JSON.parse(JSON.stringify(HOST_DEFAULTS));
  if (o.cfg) o.cfg(cfg);
  return {
    ctx, ctxGet: (n) => (o.services ? o.services[n] : ctx.get(n)), getPm: () => (o.pm === undefined ? createFakePm() : o.pm), hostConfig: () => cfg,
    paths: resolvePaths({ dshHome: dir }), ports: ports(o), claims: null, tooltable: { status: () => ({ unclassified: o.unclassified ?? [] }) },
    governor: { status: () => ({ policy: 'adaptive', device: 'cpu', reason: '还没采样', sampler: false }) },
    registered: { ...allRegistered, ...(o.registered ?? {}) }, defineToolAvailable: o.defineTool !== false, adapters: o.adapters ?? [],
    skipNetwork: o.skipNetwork ?? false, now: () => 1000,
  };
}
const byId = (r) => Object.fromEntries(r.items.map((x) => [x.id, x]));

test('一切正常：宿主、运行时（node:sqlite、模块级 backup、FTS5 带引号查询）、库、模型都过；每项有管理页认的 status 和中文分区', async () => {
  const dir = tmpDir('sc-ok');
  const r = await runSelfCheck(deps({ dir }));
  const m = byId(r);
  for (const id of ['host.systemPrompt', 'host.preStep', 'host.preExecute', 'host.postExecute', 'host.guard', 'host.sessionEvent', 'host.agents', 'host.llm', 'host.defineTool', 'runtime.sqlite', 'store.open', 'llm.allowlist', 'embed.service', 'embed.model', 'self.coreSelf', 'bridge.freeze']) {
    assert.equal(m[id]?.status, 'ok', id);
  }
  assert.equal(m['host.preExecute'].area, '宿主');
  assert.equal(m.rerank.status, 'ok', 'info 算 ok');
  assert.equal(r.level, 'ok');
  // Ollama 版本记下来，下次变了就提示（它会自动升级，附录 G.1）
  const st = JSON.parse(fs.readFileSync(resolvePaths({ dshHome: dir }).hostStateFile, 'utf8'));
  assert.equal(st.ollamaVersion, '0.40.13');
  const r2 = await runSelfCheck(deps({ dir, health: { ok: true, version: '0.41.0', model: 'qwen3-embedding:4b', modelPresent: true, dim: 1024, tier: 'standard' } }));
  assert.equal(byId(r2)['embed.version'].status, 'warn');
  rmDir(dir);
});

test('失败的项写明关掉了什么：钩子没挂上、没有模型服务、模型不在允许清单、嵌入不可达、库没开或只读', async () => {
  const dir = tmpDir('sc-fail');
  const r = await runSelfCheck(deps({
    dir, registered: { resident: false, preExecute: false }, services: {}, defineTool: false,
    cfg: (c) => { c.llm.models.sleep = 'deepseek-pro'; },
    health: { ok: false, error: 'ECONNREFUSED' }, pm: null,
  }));
  const m = byId(r);
  assert.equal(m['host.systemPrompt'].status, 'fail');
  assert.deepEqual(m['host.systemPrompt'].disables, ['resident']);
  assert.deepEqual(m['host.preExecute'].disables, ['egress', 'freeze']);
  assert.equal(m['host.llm'].status, 'fail');
  assert.equal(m['host.defineTool'].status, 'warn');
  assert.equal(m['llm.allowlist'].status, 'fail');
  assert.deepEqual(m['llm.allowlist'].disables, ['llm:sleep']);
  assert.equal(m['embed.service'].status, 'fail');
  assert.match(m['embed.service'].label, /L3/);
  assert.equal(m['store.open'].status, 'fail');
  assert.equal(m['bridge.freeze'].status, 'warn', 'pre-execute 没挂上，冻结只剩守卫');
  assert.equal(r.level, 'fail');
  assert.equal(r.ok, false);
  const ro = createFakePm();
  ro.status = () => ({ readOnly: true, readOnlyReason: 'newer-schema', schema: { ok: true }, startup: { worker: { error: 'ERR_WORKER' } } });
  const m2 = byId(await runSelfCheck(deps({ dir, pm: ro, skipNetwork: true })));
  assert.equal(m2['store.open'].status, 'fail');
  assert.match(m2['store.open'].label, /只读/);
  assert.equal(m2['runtime.worker'].status, 'warn');
  rmDir(dir);
});

test('核心自我：没配置是 warn；读不到是 fail；有像账号的长数字、邮箱或链接就提示（只该有性格、口吻、价值观）', async () => {
  const dir = tmpDir('sc-self');
  assert.equal(byId(await runSelfCheck(deps({ dir, skipNetwork: true, self: { configured: false } })))['self.coreSelf'].status, 'warn');
  assert.equal(byId(await runSelfCheck(deps({ dir, skipNetwork: true, self: { configured: true, present: false, error: 'ENOENT' } })))['self.coreSelf'].status, 'fail');
  const bad = byId(await runSelfCheck(deps({ dir, skipNetwork: true, selfText: '我的号是 1234567，见 https://x.example' })))['self.coreSelf'];
  assert.equal(bad.status, 'warn');
  assert.match(bad.label, /长数字/);
  assert.match(bad.label, /链接/);
  assert.ok(!bad.label.includes('1234567'), '提示里不带原文');
  rmDir(dir);
});

test('适配器：没配置 / 起不来 / 停用 / 绑定不合格 / 没声明会话特征；适配器自己的检查项（两种形状）归一', async () => {
  const dir = tmpDir('sc-adapters');
  const good = { id: 'zz', adapter: { selfCheck: () => [{ name: 'files', ok: true }, { name: 'mode', ok: false, detail: '模式不对' }, { id: 'x', level: 'fail', label: '坏了' }, { bogus: 1 }] }, binding: fakeBinding() };
  const noSig = { id: 'yy', adapter: {}, binding: fakeBinding({ adapterId: 'yy', sessionSignature: () => ({}) }) };
  const r = await runSelfCheck(deps({ dir, skipNetwork: true, adapters: [
    good, noSig,
    { id: 'qq', error: 'NOT_CONFIGURED', hint: '桥接目录' },
    { id: 'boom', error: 'TypeError' },
    { id: 'off', disabled: true },
    { id: 'bad', adapter: {}, binding: { adapterId: 'bad', claimSession() {}, sessionSignature: () => ({ presets: ['p'] }), tools: [{ tool: 't' }] } },
  ] }));
  const m = byId(r);
  assert.equal(m['adapter.zz'].status, 'ok');
  assert.equal(m['adapter.zz.files'].status, 'ok');
  assert.equal(m['adapter.zz.mode'].status, 'warn', 'ok:false 默认只是 warn');
  assert.equal(m['adapter.zz.x'].status, 'fail');
  assert.equal(m['adapter.yy.signature'].status, 'warn');
  assert.equal(m['adapter.qq'].status, 'ok', '新用户没接 QQ 不算问题');
  assert.match(m['adapter.qq'].label, /桥接目录/);
  assert.equal(m['adapter.boom'].status, 'fail');
  assert.equal(m['adapter.off'].status, 'ok');
  assert.equal(m['adapter.bad'].status, 'fail');
  assert.deepEqual([...failedAdapters(r)].sort(), ['bad', 'boom'], '宿主据此把它们的会话特征放进拒认名单');
  assert.equal(normalizeAdapterCheck({ name: 'a b!', ok: false, critical: true }).level, 'fail');
  assert.equal(normalizeAdapterCheck(null), null);
  rmDir(dir);
});

test('没分类的工具在自检里提示补分类；桥接白名单状态只认带标记的行', async () => {
  const dir = tmpDir('sc-misc');
  const m = byId(await runSelfCheck(deps({ dir, skipNetwork: true, unclassified: [{ tool: 'mystery', count: 2 }] })));
  assert.equal(m['tools.unclassified'].status, 'warn');
  assert.match(m['tools.unclassified'].detail, /extraTools/);
  const src = (lines) => `const SAFE_EXACT = new Set([\n  'todo_write',\n${lines.join('\n')}\n])\n`;
  assert.deepEqual(whitelistState('nothing'), { found: false, missing: ['memory_recall', 'memory_note', 'memory_fix', 'memory_look'], patched: [] });
  const half = whitelistState(src([`  'memory_recall', ${PATCH_MARK}`]));
  assert.deepEqual(half.missing, ['memory_note', 'memory_fix', 'memory_look']);
  assert.deepEqual(half.patched, ['memory_recall']);
  const all = whitelistState(src(['memory_recall', 'memory_note', 'memory_fix', 'memory_look'].map((t) => `  '${t}', ${PATCH_MARK}`)));
  assert.deepEqual(all.missing, []);
  rmDir(dir);
});

test('插件预设（D112）：照标准模式注册上是 ok；精简副本、关着、还没注册上是 warn；注册失败、激活失败是 fail（不关任何东西）', async () => {
  const dir = tmpDir('sc-preset');
  const base = { id: 'persona-chat', enabled: true, registered: true, name: '某个名字', source: 'standard', rows: 25, broken: null, error: null, registry: true, baseUrl: true };
  const roster = [{ id: 'standard', name: '', broken: false }, { id: 'persona-chat', name: '某个名字', broken: false }];
  const run = async (status, r = roster) => byId(await runSelfCheck({ ...deps({ dir }), preset: { status, roster: r } }))['host.preset'];
  let x = await run(base);
  assert.equal(x.level, 'ok');
  assert.match(x.label, /新建任务里有「某个名字」预设（照标准模式，25 个插件行）/);
  assert.equal(x.disables, undefined);
  assert.equal((await run({ ...base, source: 'fallback', rows: 12 })).level, 'warn');
  assert.match((await run({ ...base, source: 'fallback', rows: 12 })).label, /精简副本/);
  assert.equal((await run({ ...base, enabled: false, registered: false })).level, 'warn');
  assert.equal((await run({ ...base, registered: false, registry: false })).level, 'warn');
  x = await run({ ...base, registered: false, error: 'DUPLICATE' });
  assert.equal(x.level, 'fail');
  assert.match(x.label, /没注册上（DUPLICATE）/);
  x = await run({ ...base, broken: 'Cannot find package', baseUrl: false });
  assert.equal(x.level, 'fail');
  assert.match(x.detail, /Cannot find package.*baseUrl/);
  assert.equal((await run(base, [{ id: 'standard', name: '', broken: false }])).level, 'warn', '注册了但 DSH 的列表里看不到');
  assert.equal(byId(await runSelfCheck(deps({ dir })))['host.preset'], undefined, '没有预设（别的宿主）：不报');
  rmDir(dir);
});
