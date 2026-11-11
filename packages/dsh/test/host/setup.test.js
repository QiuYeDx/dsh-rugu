// 公开版的三件事（D127–D129）：嵌入三档（没有服务 / 本机 Ollama / 外部服务）、QQ 桥接接入、首次设置。
// 全部在 .tmp 下的合成目录里，假的 fetch，不碰网络和本机的 DSH。L3 那条在真核心上跑（没有嵌入是常态，不是故障）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHost } from '../../src/host/index.js';
import { createEmbeddingPort, tierInfo } from '../../src/ports/embedding.js';
import { createEmbeddingSetup, recommendTier, normalizeBase, isPrivateUrl, createKeyReader, OLLAMA_DOWNLOAD_URL } from '../../src/host/embedding-setup.js';
import { createBridgeSetup, findBridgeDirs, bridgeDirOf, isBridgeDir, bridgeGroups } from '../../src/host/bridge-setup.js';
import { rid, inMsg, socialFile, atomicWrite, waitFor } from '../adapters/helpers.js';
import { HOST_DEFAULTS } from '../../src/host/config.js';
import { RESTRICT_REL } from '../../scripts/bridge-whitelist-patch.mjs';
import { createAdminHandlers, TOKEN_HEADER, registerAdmin, ROUTES } from '../../src/admin/index.js';
import { FakeDshCtx, fakeAgent, userMessage, tmpDir, rmDir } from '../fakes/index.js';
import { offlineFetch } from './helpers.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ecfg = (over = {}) => ({ ...HOST_DEFAULTS, embedding: { ...HOST_DEFAULTS.embedding, ...over, tiers: { ...HOST_DEFAULTS.embedding.tiers, ...(over.tiers ?? {}) } } });
const unit = (d) => Array.from({ length: d }, (_, i) => (i === 0 ? 1 : 0));

test('嵌入端口：外部服务带 Authorization（有 Key 才带，健康检查也带）；Ollama 从不带', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, auth: init.headers?.authorization ?? init.headers?.Authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/v1/models')) return json(200, { data: [{ id: 'm1' }] });
    if (String(url).endsWith('/v1/embeddings')) return json(200, { data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: unit(4) })) });
    if (String(url).endsWith('/api/embed')) return json(200, { embeddings: JSON.parse(init.body).input.map(() => unit(4)) });
    return json(200, {});
  };
  const cfg = ecfg({ provider: 'openai-compat', url: 'https://api.example.com', tier: 'custom', tiers: { custom: { model: 'm1', dim: 4, quant: '', vramMb: 0 } } });
  let key = 'sk-secret-value';
  const port = createEmbeddingPort({ hostConfig: () => cfg, fetchImpl, apiKey: () => key });
  const r = await port.embed(['你好'], 'query');
  assert.equal(r.vectors.length, 1);
  assert.equal(seen.at(-1).auth, 'Bearer sk-secret-value');
  assert.equal(seen.at(-1).body.dimensions, 4);
  await port.checkHealth();
  assert.equal(seen.at(-1).auth, 'Bearer sk-secret-value', '健康检查也带');
  assert.equal(port.health().modelPresent, true);
  key = '';
  await port.embed(['你好'], 'query');
  assert.equal(seen.at(-1).auth, null, '没 Key 不带');
  // 不认 dimensions 的服务：不带这个参数
  const noDim = createEmbeddingPort({ hostConfig: () => ecfg({ ...cfg.embedding, sendDimensions: false }), fetchImpl, apiKey: () => '' });
  await noDim.embed(['你好'], 'query');
  assert.equal('dimensions' in seen.at(-1).body, false);
  const ollama = createEmbeddingPort({ hostConfig: () => ecfg({ tiers: { standard: { model: 'x', dim: 4, quant: '', vramMb: 0 } } }), fetchImpl, apiKey: () => 'sk-should-not-leak' });
  await ollama.embed(['你好'], 'query');
  assert.match(seen.at(-1).url, /\/api\/embed$/);
  assert.equal(seen.at(-1).auth, null, '发给 Ollama 的请求不带 Key');
});

test('嵌入端口：外部服务没有 /v1/models 只是清单拿不到（模型在不在未知）；401 才算不通', async () => {
  const cfg = ecfg({ provider: 'openai-compat', url: 'https://x.test', tier: 'custom', tiers: { custom: { model: 'm1', dim: 4, quant: '', vramMb: 0 } } });
  let status = 404;
  const port = createEmbeddingPort({ hostConfig: () => cfg, fetchImpl: async () => new Response('', { status }), apiKey: () => '' });
  let h = await port.checkHealth();
  assert.equal(h.ok, true);
  assert.equal(h.modelPresent, null, '不知道，别当成不在');
  status = 401;
  h = await port.checkHealth();
  assert.equal(h.ok, false);
  assert.equal(h.error, 'HTTP_401');
});

test('嵌入端口：provider none 不发任何请求、空空间、健康里标 disabled；换服务商后旧档位不去新地址要向量', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json(200, {}); };
  const off = createEmbeddingPort({ hostConfig: () => ecfg({ provider: 'none' }), fetchImpl });
  assert.equal(off.info().spaceId, '');
  const h = await off.checkHealth();
  assert.equal(h.disabled, true);
  assert.equal(h.ok, false);
  await assert.rejects(off.embed(['x'], 'query'), (e) => e.code === 'NO_MODEL');
  assert.equal(await off.warm(), false);
  assert.equal(calls, 0);
  // 外部服务：查旧的 Ollama 空间时给的是现在这个地址的向量（spaceId 对不上，核心走「旧空间产不出」，建影子重嵌）
  const cfg = ecfg({ provider: 'openai-compat', url: 'https://api.example.com', tier: 'custom', tiers: { custom: { model: 'cloud', dim: 4, quant: '', vramMb: 0 } } });
  const models = [];
  const port = createEmbeddingPort({ hostConfig: () => cfg, fetchImpl: async (u, init) => { const b = JSON.parse(init.body); models.push(b.model); return json(200, { data: b.input.map((_, index) => ({ index, embedding: unit(4) })) }); } });
  const oldSpace = tierInfo(cfg.embedding, 'standard').spaceId;
  const r = await port.embed(['x'], 'doc', { spaceId: oldSpace });
  assert.deepEqual(models, ['cloud'], '没拿旧模型的名字去问外部服务');
  assert.notEqual(r.spaceId, oldSpace);
});

test('地址规范化、是不是第三方、按硬件推荐', () => {
  assert.equal(normalizeBase('https://api.example.com/v1/'), 'https://api.example.com');
  assert.equal(normalizeBase('https://api.example.com/v1/embeddings'), 'https://api.example.com');
  assert.equal(normalizeBase('https://api.example.com/proxy/v1'), 'https://api.example.com/proxy');
  assert.equal(normalizeBase('ftp://x'), null);
  assert.equal(normalizeBase('https://user:pw@x.com'), null, '账号密码不许放在地址里');
  for (const u of ['http://127.0.0.1:8080', 'http://localhost:11434', 'http://192.168.1.5:80', 'http://10.0.0.2', 'http://[::1]:80']) assert.equal(isPrivateUrl(u), true, u);
  for (const u of ['https://api.openai.com', 'http://8.8.8.8', 'http://172.32.0.1']) assert.equal(isPrivateUrl(u), false, u);
  assert.equal(recommendTier({ vramMb: 8192 }).tier, 'standard');
  assert.equal(recommendTier({ vramMb: 4096 }).tier, 'light');
  assert.equal(recommendTier({ vramMb: null, ramMb: 65536 }).tier, 'light', '只有 CPU 用 0.6B');
});

function setupDeps(dir, fetchImpl, over = {}) {
  const state = { cfg: structuredClone(ecfg()), patches: [] };
  const keyFile = path.join(dir, 'persona-memory-embedding.key');
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k]) merge(a[k], v); else a[k] = v; } };
  const s = createEmbeddingSetup({
    hostConfig: () => state.cfg,
    setConfig: (p, o) => { state.patches.push({ p, o }); merge(state.cfg, p.host); return { ok: true }; },
    keyFile, fetchImpl,
    execFile: (_c, _a, _o, cb) => cb(null, '1000, 8192, 7192, 3\n'),
    totalmem: () => 32 * 1024 ** 3,
    ...over,
  });
  return { s, state, keyFile };
}

test('本机 Ollama：探测版本和模型，按显存推荐；没连上时给下载链接；不替主人安装', async () => {
  const dir = tmpDir('embed-setup');
  const up = async (url) => {
    if (String(url).endsWith('/api/version')) return json(200, { version: '0.40.0' });
    if (String(url).endsWith('/api/tags')) return json(200, { models: [{ name: 'qwen3-embedding:0.6b' }] });
    return json(404, {});
  };
  const { s } = setupDeps(dir, up);
  const d = await s.status();
  assert.equal(d.ollama.reachable, true);
  assert.equal(d.ollama.version, '0.40.0');
  assert.equal(d.tiers.light.present, true);
  assert.equal(d.tiers.standard.present, false);
  assert.equal(d.recommended.tier, 'standard');
  assert.equal(d.hardware.vramMb, 8192);
  const down = setupDeps(dir, offlineFetch).s;
  const d2 = await down.status();
  assert.equal(d2.ollama.reachable, false);
  assert.equal(d2.downloadUrl, OLLAMA_DOWNLOAD_URL);
  rmDir(dir);
});

test('下载模型：/api/pull 的流报进度、一次只下一个、可以取消；出错如实报', async () => {
  const dir = tmpDir('embed-pull');
  let release;
  const gate = new Promise((r) => { release = r; });
  let body = null;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/pull')) {
      body = JSON.parse(init.body);
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode('{"status":"pulling manifest"}\n{"status":"downloading","total":1000,"completed":250}\n'));
          await gate;
          c.enqueue(enc.encode('{"status":"verifying sha256 digest"}\n{"status":"success"}\n'));
          c.close();
        },
      }), { status: 200 });
    }
    return json(404, {});
  };
  const { s } = setupDeps(dir, fetchImpl);
  const started = s.startPull({ tier: 'light' });
  assert.equal(started.state, 'running');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(body.model, HOST_DEFAULTS.embedding.tiers.light.model);
  assert.equal(body.stream, true);
  const mid = (await s.status()).pull;
  assert.equal(mid.pct, 25);
  assert.throws(() => s.startPull({ tier: 'standard' }), (e) => e.code === 'BUSY');
  release();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal((await s.status()).pull.state, 'done');

  const failing = setupDeps(dir, async (url) => (String(url).endsWith('/api/pull') ? new Response('{"error":"pull model manifest: file does not exist"}\n', { status: 200 }) : json(404, {}))).s;
  failing.startPull({ tier: 'light' });
  await new Promise((r) => setTimeout(r, 40));
  const f = (await failing.status()).pull;
  assert.equal(f.state, 'error');
  assert.equal(f.error, 'PULL_FAILED');

  const cancel = setupDeps(dir, async (u, init) => (String(u).endsWith('/api/pull') ? new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))); }) : json(404, {}))).s;
  cancel.startPull({ tier: 'light' });
  cancel.cancelPull();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await cancel.status()).pull.state, 'cancelled');
  rmDir(dir);
});

test('外部服务：测试连接（不认 dimensions 的自动退掉、维度不对报出来）；Key 只进单独的文件', async () => {
  const dir = tmpDir('embed-ext');
  const reqs = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    reqs.push({ auth: init.headers.authorization, b });
    if (b.dimensions) return json(400, { error: 'unsupported' });
    return json(200, { data: [{ embedding: unit(768) }] });
  };
  const { s, state, keyFile } = setupDeps(dir, fetchImpl);
  const ok = await s.test({ url: 'https://api.example.com/v1', model: 'm', dim: 768, apiKey: 'sk-typed' });
  assert.equal(ok.ok, true);
  assert.equal(ok.dim, 768);
  assert.equal(ok.sendDimensions, false, '这个服务不认 dimensions');
  assert.equal(ok.thirdParty, true);
  assert.equal(reqs[0].auth, 'Bearer sk-typed');
  assert.ok(!('apiKey' in ok));
  const bad = await s.test({ url: 'https://api.example.com', model: 'm', dim: 1024, apiKey: '' });
  assert.equal(bad.error, 'EMBED_DIM');
  assert.equal(bad.got, 768);
  assert.equal((await s.test({ url: 'nope', model: 'm', dim: 1 })).error, 'BAD_URL');

  s.save({ mode: 'external', url: 'https://api.example.com/v1', model: 'm', dim: 768, sendDimensions: false, apiKey: 'sk-saved-key' });
  assert.equal(state.cfg.embedding.provider, 'openai-compat');
  assert.equal(state.cfg.embedding.url, 'https://api.example.com');
  assert.equal(state.cfg.embedding.tier, 'custom');
  assert.equal(state.cfg.embedding.sendDimensions, false);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), 'sk-saved-key');
  assert.ok(!JSON.stringify(state.patches).includes('sk-saved-key'), 'Key 不进配置');
  assert.equal(createKeyReader(keyFile)(), 'sk-saved-key');
  assert.equal((await s.status()).hasKey, true);
  assert.ok(!JSON.stringify(await s.status()).includes('sk-saved-key'), 'Key 不回传给页面');
  s.save({ mode: 'external', url: 'https://api.example.com', model: 'm', dim: 768, clearKey: true });
  assert.equal(fs.existsSync(keyFile), false);
  rmDir(dir);
});

test('保存前要告诉主人的：发给第三方、换模型要重建向量、关掉嵌入', () => {
  const dir = tmpDir('embed-reasons');
  const { s, state } = setupDeps(dir, offlineFetch);
  assert.deepEqual(s.reasonsFor({ mode: 'ollama', tier: 'standard', url: '' }).reasons, [], '没变不用确认');
  assert.match(s.reasonsFor({ mode: 'ollama', tier: 'light', url: '' }).reasons.join(), /重新算一遍向量/);
  const cloud = s.reasonsFor({ mode: 'external', url: 'https://api.example.com', model: 'm', dim: 4 });
  assert.equal(cloud.thirdParty, true);
  assert.match(cloud.reasons.join(), /发给 api\.example\.com/);
  assert.equal(s.reasonsFor({ mode: 'external', url: 'http://127.0.0.1:8080', model: 'm', dim: 4 }).thirdParty, false);
  assert.match(s.reasonsFor({ mode: 'none' }).reasons.join(), /不再算新的向量/);
  state.cfg.embedding.provider = 'none';
  assert.deepEqual(s.reasonsFor({ mode: 'ollama', tier: 'standard', url: '' }).reasons, [], '从没有嵌入到有嵌入：没有旧向量要重建');
  rmDir(dir);
});

function makeBridge(dir, name = 'bridge') {
  const b = path.join(dir, name);
  fs.mkdirSync(path.join(b, 'plugins', 'qq-agent-presets'), { recursive: true });
  fs.mkdirSync(path.join(b, 'state', 'agents', 'x'), { recursive: true });
  fs.writeFileSync(path.join(b, RESTRICT_REL), ['const SAFE_EXACT = new Set([', "  'todo_write',", '])', ''].join('\n'));
  fs.writeFileSync(path.join(b, 'state', 'social-v2.json'), '{}');
  return b;
}

test('QQ 桥接：从 DSH 会话的工作目录找出桥接（只读会话头）；预览不写；打补丁、还原；记进配置', () => {
  const dir = tmpDir('bridge-setup');
  const b = makeBridge(dir);
  const sessions = path.join(dir, 'sessions');
  const one = path.join(sessions, 'proj', 'sess1');
  fs.mkdirSync(one, { recursive: true });
  fs.writeFileSync(path.join(one, 'session.v1.jsonl'), `${JSON.stringify({ cwd: path.join(b, 'state', 'agents', 'x') })}\n{"not":"read"}\n`);
  const other = path.join(sessions, 'other', 'sess2');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'session.jsonl'), `${JSON.stringify({ cwd: path.join(dir, 'elsewhere') })}\n`);
  if (typeof zlib.zstdCompressSync === 'function') {
    const c = makeBridge(dir, 'bridge2');
    const z = path.join(sessions, 'zproj', 'sess3');
    fs.mkdirSync(z, { recursive: true });
    fs.writeFileSync(path.join(z, 'session.v1.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ cwd: path.join(c, 'state', 'agents', 'x') })}\n`)));
    assert.equal(findBridgeDirs(sessions).length, 2, 'zstd 的会话头也读');
  }
  assert.ok(findBridgeDirs(sessions).includes(path.resolve(b)));
  assert.equal(bridgeDirOf(path.join(b, 'state', 'agents', 'x')), path.resolve(b));
  assert.equal(isBridgeDir(dir), false);

  const patches = [];
  const cfg = structuredClone(HOST_DEFAULTS);
  const s = createBridgeSetup({ hostConfig: () => cfg, setConfig: (p) => { patches.push(p); cfg.adapters.qq.bridgeDir = p.host.adapters.qq.bridgeDir; return { ok: true }; }, sessionsDir: sessions });
  const st = s.status();
  assert.ok(st.candidates.some((x) => x.dir === path.resolve(b) && x.isBridge && x.hasSocial && x.whitelist.applicable && !x.whitelist.patched));
  const before = fs.readFileSync(path.join(b, RESTRICT_REL), 'utf8');
  const pv = s.preview({ dir: b });
  assert.equal(pv.ok, true);
  assert.equal(pv.changes.length, 4);
  assert.equal(pv.restart, true);
  assert.equal(fs.readFileSync(path.join(b, RESTRICT_REL), 'utf8'), before, '预览不写');
  const a = s.apply({ dir: b });
  assert.equal(a.applied, true);
  assert.equal(a.changed, 4);
  assert.equal(a.restart, true);
  assert.equal(s.status({ dir: b }).manual.whitelist.patched, true);
  assert.equal(fs.existsSync(path.join(b, `${RESTRICT_REL}.bak-persona-memory`)), true);
  assert.equal(s.apply({ dir: b, revert: true }).changed, 4);
  assert.equal(fs.readFileSync(path.join(b, RESTRICT_REL), 'utf8'), before, '还原成原样');
  // 手填的不是桥接：拒绝，不写配置
  assert.throws(() => s.setDir(path.join(dir, 'nope')), (e) => e.code === 'REJECTED');
  assert.equal(patches.length, 0);
  s.setDir(b);
  assert.equal(cfg.adapters.qq.bridgeDir, path.resolve(b));
  assert.deepEqual(patches[0].host.adapters.web.excludeCwdPrefixes, [path.join(path.resolve(b), 'state', 'agents')], '网页适配器不认桥接的会话');
  rmDir(dir);
});

const baseDeps = (dir, extra = {}) => ({ dshHome: dir, coreOptions: { startWorker: false }, adapterFactories: {}, registerAdmin: null, defineTool: (d) => d, sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch, firstRun: true, ...extra });

test('首次设置（实测问题 #10）：没配置时不建库、不建密钥，管理页在设置模式；走完才打开；桥接自带的记忆照常用', async () => {
  const dir = tmpDir('firstrun');
  const ctx = new FakeDshCtx();
  const regs = [];
  let opens = 0;
  const pm = { admin: {}, status: () => ({}), registerAdapter: () => () => {}, close: async () => {}, modeOf: () => 'off', sessions: {} };
  const host = createHost(ctx, {}, baseDeps(dir, {
    coreFactory: async (o) => { opens += 1; assert.ok(o.dataDir); return pm; },
    registerAdmin: (_c, o) => { regs.push({ setupMode: o.setupMode === true, pm: o.pm }); return () => {}; },
  }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(opens, 0, '不开库');
  assert.equal(fs.existsSync(path.join(dir, 'persona-memory')), false, '没有多余的空库');
  assert.equal(fs.existsSync(path.join(dir, 'persona-memory.key')), false);
  assert.equal(fs.existsSync(path.join(dir, 'persona-memory.json')), false);
  assert.deepEqual(regs, [{ setupMode: true, pm: null }]);
  assert.equal(host.api.setup.status().needed, true);
  // 还没设置时不管事：桥接自带的记忆工具不拒绝
  const agent = fakeAgent({ id: 's1', preset: 'x' });
  const r = await ctx.preExecute({ name: 'qq_memory_append', callId: 'c1', agent, arguments: {} });
  assert.equal(r.decision.kind, 'allow');

  // 向导中途选了「不用嵌入」：写了配置，但还没确认告知 → 还在等
  host.api.embeddingSetup.save({ mode: 'none' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'persona-memory.json'), 'utf8')).host.setup.inProgress, true);
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(opens, 0, '写了一半的配置不算走完');

  await host.api.setup.finish({ principalLabel: '老板', presetName: '聊天', selfNames: ['小名'] });
  assert.equal(await host.ready, true);
  assert.equal(opens, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'persona-memory.json'), 'utf8'));
  assert.equal(saved.host.setup.acknowledged, true);
  assert.equal(saved.host.setup.inProgress, false);
  assert.ok(saved.host.setup.completedAt > 0);
  assert.equal(saved.host.self.principalLabel, '老板');
  assert.equal(saved.host.preset.name, '聊天');
  assert.deepEqual(saved.host.adapters.qq.selfNames, ['小名']);
  assert.equal(saved.host.embedding.provider, 'none');
  assert.equal(regs.length, 2, '完整的管理页接手');
  assert.equal(regs[1].setupMode, false);
  assert.equal(regs[1].pm, pm);
  assert.equal(host.api.setup.status().needed, false);
  await assert.rejects(host.api.setup.finish({}), (e) => e.code === 'CONFLICT');
  await host.dispose();
  rmDir(dir);
});

test('首次设置：主人没选、本机 Ollama 又用不了 → 落到「不用嵌入」；Ollama 在且模型在 → 保持默认；向导里换档不问重建向量', async () => {
  const dir = tmpDir('firstrun-default');
  const pm = { admin: {}, status: () => ({}), registerAdapter: () => () => {}, close: async () => {}, modeOf: () => 'off', sessions: {} };
  const h = createHost(new FakeDshCtx(), {}, baseDeps(dir, { coreFactory: async () => pm }));
  assert.deepEqual(h.api.embeddingSetup.reasonsFor({ mode: 'ollama', tier: 'light', url: '' }).reasons, [], '还没有向量，不用问');
  await h.api.setup.finish({});
  assert.equal(await h.ready, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'persona-memory.json'), 'utf8')).host.embedding.provider, 'none');
  await h.dispose();
  rmDir(dir);
  const dir2 = tmpDir('firstrun-default2');
  const up = async (u) => (String(u).endsWith('/api/version') ? json(200, { version: '1' }) : String(u).endsWith('/api/tags') ? json(200, { models: [{ name: HOST_DEFAULTS.embedding.tiers.standard.model }] }) : json(404, {}));
  const h2 = createHost(new FakeDshCtx(), {}, baseDeps(dir2, { coreFactory: async () => pm, fetchImpl: up }));
  await h2.api.setup.finish({});
  assert.equal(await h2.ready, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir2, 'persona-memory.json'), 'utf8')).host.embedding, undefined, 'Ollama 和模型都在：不写，用默认');
  await h2.dispose();
  rmDir(dir2);
});

test('首次设置：向导走到一半重启，接着等；手写了配置的直接开；配置文件坏了不卡在向导', async () => {
  const dir = tmpDir('firstrun2');
  const cfgFile = path.join(dir, 'persona-memory.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ host: { setup: { inProgress: true }, embedding: { provider: 'none' } } }));
  let opens = 0;
  const pm = { admin: {}, status: () => ({}), registerAdapter: () => () => {}, close: async () => {}, modeOf: () => 'off', sessions: {} };
  const deps = (extra = {}) => baseDeps(dir, { coreFactory: async () => { opens += 1; return pm; }, setupPollMs: 10, ...extra });
  const keep = setInterval(() => {}, 5);   // 向导的轮询是 unref 的，别让测试进程提前退出
  const h1 = createHost(new FakeDshCtx(), {}, deps());
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(opens, 0, '一半的向导还要接着走');
  assert.equal(h1.api.setup.status().needed, true);
  // 这时主人手写好了配置：不再是「半路」，放行
  fs.writeFileSync(cfgFile, JSON.stringify({ host: { enabled: true } }));
  assert.equal(await h1.ready, true);
  assert.equal(opens, 1);
  await h1.dispose();

  const h2 = createHost(new FakeDshCtx(), {}, deps());
  assert.equal(await h2.ready, true, '手写过配置：直接开');
  assert.equal(opens, 2);
  await h2.dispose();

  fs.writeFileSync(cfgFile, '{坏的');
  const h3 = createHost(new FakeDshCtx(), {}, deps());
  assert.equal(await h3.ready, true, '坏文件：不卡在向导，走原来的路（总览报错）');
  await h3.dispose();

  clearInterval(keep);
  // 卸载时还在等：不挂起
  rmDir(dir);
  const dir2 = tmpDir('firstrun3');
  const h4 = createHost(new FakeDshCtx(), {}, baseDeps(dir2));
  await h4.dispose();
  assert.equal(await h4.ready, false);
  rmDir(dir2);
});

test('L3 是常态（真核心，不用嵌入）：能记、能想起来、自检不报失败、总览不当故障', async () => {
  const dir = tmpDir('l3');
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { embedding: { provider: 'none' }, adapters: { web: { presets: ['web-chat'] } } } }));
  const ctx = new FakeDshCtx();
  let calls = 0;
  let t = Date.now();
  const host = createHost(ctx, {}, { dshHome: dir, clock: { now: () => t }, coreOptions: { startWorker: false }, adapterFactories: undefined, registerAdmin: null, defineTool: (d) => d, sampler: null, startServices: false,
    fetchImpl: async () => { calls += 1; throw new Error('不该有网络请求'); } });
  assert.equal(await host.ready, true, JSON.stringify(host.status().error));
  const pm = host.getPm();
  const web = (text, id) => userMessage(text, { id, extra: { clientTimeZone: 'Asia/Shanghai' } });
  const agent = fakeAgent({ id: 'sess-l3', preset: 'web-chat' });
  ctx.agents.map.set(agent.id, agent);
  await ctx.preStep(agent, [web('我下周要去青岛出差，住在海边那家酒店', 'm-1')]);
  ctx.sessionEvent(agent.session, { type: 'turn/end', seq: 3, data: {} });
  await new Promise((r) => setTimeout(r, 100));
  t += 61_000;
  const d = await ctx.preStep(agent, [web('青岛那边的酒店你还记得吗', 'm-2')], { turn: 2 });
  const block = d.messages.find((m) => m.source?.kind === 'persona-memory');
  assert.ok(block, '没有嵌入也照常注入');
  const p = pm.admin.list({ view: 'percepts', limit: 10 });
  assert.ok(p.items.some((x) => JSON.stringify(x).includes('青岛')), '原话进了记忆（嵌入不影响入库）');
  const recallTool = agent.ctx.tools.registered.find((x) => x.name === 'memory_recall');
  const txt = await recallTool.execute({ query: '青岛 酒店' }, { agent, callId: 'r1', signal: new AbortController().signal });
  assert.equal(typeof txt, 'string', '有意回想照常跑完，不报错（字面路的召回在核心的测试里）');
  assert.equal(pm.admin.embedding.health().dense, false);
  const sc = await host.selfCheck();
  const emb = sc.items.filter((x) => x.id.startsWith('embed.'));
  assert.equal(emb.some((x) => x.level === 'fail' || x.level === 'warn'), false, JSON.stringify(emb));
  assert.equal(emb.find((x) => x.id === 'embed.service').level, 'info');
  assert.match(emb.find((x) => x.id === 'embed.service').label, /说法不同/);
  assert.equal(calls, 0, '一次网络请求都没有');
  await host.dispose();
  rmDir(dir);
});

test('管理接口（设置模式）：没有核心时只开向导、嵌入、桥接；其余 503；确认语照常绑定；finish 要勾选', async () => {
  const dir = tmpDir('admin-setup');
  const host = {
    setup: { status: () => ({ needed: true, dataDir: 'x' }), finish: () => ({ ok: true }) },
    embeddingSetup: { status: async () => ({ mode: 'ollama' }), reasonsFor: (p) => ({ reasons: p.mode === 'external' ? ['发给第三方'] : [] }), save: (p) => ({ saved: true, had: !!p.apiKey }), test: async () => ({ ok: true }), startPull: () => ({ state: 'running' }), cancelPull: () => ({}) },
    bridgeSetup: { status: () => ({ candidates: [] }), preview: () => ({ ok: true, changes: [] }), apply: () => ({ applied: true }), setDir: (d) => ({ dir: d }) },
  };
  const h = createAdminHandlers({ pm: null, host, setupMode: true });
  const headers = { [TOKEN_HEADER]: h.token, 'content-type': 'application/json' };
  const get = async (q) => (await h.data(new Request(`http://x/d?${q}`, { headers }))).json();
  const post = async (b) => { const r = await h.act(new Request('http://x/a', { method: 'POST', headers, body: JSON.stringify(b) })); return { status: r.status, body: await r.json() }; };
  assert.equal((await get('view=setup')).data.needed, true);
  assert.equal((await get('view=embeddingSetup')).data.mode, 'ollama');
  assert.equal((await get('view=overview')).code, 'NOT_READY');
  assert.equal((await post({ action: 'memory.hide', ref: 'x' })).body.code, 'NOT_READY');
  assert.equal((await post({ action: 'prepare', for: 'memory.purge', params: {} })).body.code, 'NOT_READY');
  assert.equal((await post({ action: 'setup.finish' })).body.code, 'BAD_INPUT', '没勾选不让完成');
  assert.equal((await post({ action: 'setup.finish', ack: true })).body.ok, true);
  // 不用确认的（Ollama）直接保存；要确认的（第三方）不带令牌拒绝，Key 不进确认令牌
  assert.equal((await post({ action: 'embedding.save', mode: 'ollama', tier: 'light' })).body.ok, true);
  const noToken = await post({ action: 'embedding.save', mode: 'external', url: 'https://a.com', model: 'm', dim: 4, apiKey: 'sk-1' });
  assert.equal(noToken.status, 428);
  const pr = await post({ action: 'prepare', for: 'embedding.save', params: { mode: 'external', url: 'https://a.com', model: 'm', dim: 4, apiKey: 'sk-1' } });
  assert.deepEqual(pr.body.result.preview.reasons, ['发给第三方']);
  const done = await post({ action: 'embedding.save', mode: 'external', url: 'https://a.com', model: 'm', dim: 4, apiKey: 'sk-1', confirm: { token: pr.body.result.token } });
  assert.equal(done.body.result.had, true);
  // 打补丁永远要确认
  const pa = await post({ action: 'bridge.apply', dir: 'D:\\b' });
  assert.equal(pa.status, 428);
  rmDir(dir);
});

test('registerAdmin：设置模式注册同一组路由，pm 为 null 不抛错', () => {
  const ctx = new FakeDshCtx();
  const d = registerAdmin(ctx, { pm: null, host: {}, setupMode: true });
  assert.deepEqual(ctx.connection.fetch.routes.map((r) => r.path).sort(), Object.values(ROUTES).sort());
  d();
  assert.equal(ctx.connection.fetch.routes.length, 0);
  assert.throws(() => registerAdmin(new FakeDshCtx(), { pm: null, host: {} }), TypeError);
});

test('桥接放行的群：去掉 deny，备注优先、再用平台群名、都没有只给群号；放行全部时只列有聊天的；读不到配置如实说', () => {
  const dir = tmpDir('bridge-groups');
  const b = makeBridge(dir);
  const [a, c, d, e] = [rid('g'), rid('g'), rid('g'), rid('g')];
  atomicWrite(path.join(b, 'config.json'), { allow: { groups: [a, c, d, e] }, deny: { groups: [e] }, continuity: { groups: { [a]: { label: '备注名' } } } });
  const names = { group: (id) => (id === c ? { name: '平台群名', source: 'name', memberCount: 3 } : null) };
  const r = bridgeGroups(b, { names });
  assert.equal(r.readable, true);
  assert.equal(r.allowAll, false);
  assert.deepEqual(r.groups, [{ id: a, name: '备注名' }, { id: c, name: '平台群名' }, { id: d, name: null }], '没名字的排后面，deny 的不列');
  atomicWrite(path.join(b, 'config.json'), { allow: { groups: [] }, allowAllWhenEmpty: true });
  atomicWrite(path.join(b, 'state', 'social-v2.json'), socialFile({ [`group:${d}`]: { recent: [] }, 'private:u1': { recent: [] } }));
  const all = bridgeGroups(b, { names });
  assert.equal(all.allowAll, true);
  assert.deepEqual(all.groups.map((x) => x.id), [d], '只列有聊天的群，不列私聊');
  fs.rmSync(path.join(b, 'config.json'));
  assert.deepEqual(bridgeGroups(b, { names }), { readable: false, allowAll: false, groups: [] });
  rmDir(dir);
});

test('向导取消的群（真核心 + 真 QQ 适配器）：一条都不进库、不感知；留下的照常；规则在「场合与规则」能改回来；群号不留在配置里', async (t) => {
  const dir = tmpDir('first-run-off');
  const b = makeBridge(dir);
  const [keep, off, owner] = [rid('g'), rid('g'), rid('u')];
  atomicWrite(path.join(b, 'config.json'), { ownerQQ: owner, allow: { private: [owner], groups: [keep, off] }, socialV2: { agentPreset: 'qq-chat-v2' }, continuity: { groups: { [keep]: { label: '留下的群' }, [off]: { label: '取消的群' } } } });
  atomicWrite(path.join(b, 'state', 'mode.json'), { mode: 'reserved2' });
  atomicWrite(path.join(b, 'state', 'sessions.json'), { sessions: {} });
  const T = Date.now();
  const msg = (text, seq) => inMsg({ seq, userId: rid('u'), sender: '群友', text, time: T - 1000 });
  atomicWrite(path.join(b, 'state', 'social-v2.json'), socialFile({
    [`group:${keep}`]: { recent: [msg('留下的群里说的话', 1)] },
    [`group:${off}`]: { recent: [msg('取消的群里说的话', 1)] },
  }));
  const host = createHost(new FakeDshCtx(), {}, baseDeps(dir, { adapterFactories: undefined }));
  t.after(async () => { await host.dispose(); rmDir(dir); });
  host.api.bridgeSetup.setDir(b);
  assert.deepEqual(new Set(host.api.bridgeSetup.status().groups.groups.map((x) => x.name)), new Set(['留下的群', '取消的群']));
  await host.api.setup.finish({ offGroups: [off] });
  assert.equal(await host.ready, true, JSON.stringify(host.status().error));
  const pm = host.getPm();
  const percepts = () => JSON.stringify(pm.admin.list({ view: 'percepts', limit: 50 }).items);
  assert.ok(await waitFor(() => percepts().includes('留下的群里说的话')), '留下的群照常感知');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(percepts().includes('取消的群里说的话'), false, '取消的群一条都没进库');
  const rows = pm.admin.list({ view: 'settings', limit: 50 }).items;
  const row = rows.find((x) => x.label === '取消的群' || JSON.stringify(x).includes('取消的群'));
  assert.ok(row, '「场合与规则」里看得到取消的群，才能改回来');
  const rule = pm.admin.rules.list('mode').find((r) => r.target?.settingKey === row.key);
  assert.equal(rule?.value, 'off');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'persona-memory.json'), 'utf8')).host.setup.offGroups, [], '写成规则后群号不留在配置里');
  assert.equal(JSON.stringify(rows).includes(off), false, '场合列表里不出现群号原值');
  pm.admin.rules.revoke(rule.id);
  assert.equal(pm.admin.rules.list('mode').some((r) => r.target?.settingKey === row.key), false, '撤掉规则就开回来了');
});

test('已有配置（线上那种）：不走向导、不碰场合规则', async (t) => {
  const dir = tmpDir('no-off');
  const b = makeBridge(dir);
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { adapters: { qq: { bridgeDir: b } } } }));
  const host = createHost(new FakeDshCtx(), {}, baseDeps(dir, { adapterFactories: undefined }));
  t.after(async () => { await host.dispose(); rmDir(dir); });
  assert.equal(await host.ready, true, JSON.stringify(host.status().error));
  assert.equal(host.api.setup.status().needed, false);
  assert.deepEqual(host.getPm().admin.rules.list('mode'), []);
});
