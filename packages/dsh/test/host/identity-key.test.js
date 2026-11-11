// 身份密钥丢了（D140）：宿主不崩、不新建密钥，插件停在「没开库」，管理页的状态页说清原因；她在原来的对话里照常聊天。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createHost } from '../../src/host/index.js';
import { FakeDshCtx, fakeAgent, userMessage, tmpDir, rmDir } from '../fakes/index.js';
import { offlineFetch } from './helpers.js';

const deps = (dir) => ({
  dshHome: dir, coreOptions: { startWorker: false }, adapterFactories: undefined, registerAdmin: null, defineTool: (d) => d,
  sampler: null, skipSelfCheckNetwork: true, startServices: false, fetchImpl: offlineFetch,
});
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('库在、密钥文件不在：不新建密钥，核心拒绝打开（IDENTITY_KEY_MISSING），状态页说明原因；聊天照常', async () => {
  const dir = tmpDir('host-idkey');
  fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify({ host: { adapters: { web: { presets: ['web-chat'] } } } }));
  const keyFile = path.join(dir, 'persona-memory.key');
  const db = path.join(dir, 'persona-memory', 'persona-memory.db');
  try {
    const ctx1 = new FakeDshCtx();
    const first = createHost(ctx1, {}, deps(dir));
    assert.equal(await first.ready, true, JSON.stringify(first.status().error));
    await first.dispose();
    assert.ok(fs.existsSync(keyFile) && fs.existsSync(db));

    fs.rmSync(keyFile);
    const before = sha(db);
    const ctx = new FakeDshCtx();
    const host = createHost(ctx, {}, deps(dir));
    assert.equal(await host.ready, false);
    assert.equal(host.status().error, 'IDENTITY_KEY_MISSING');
    assert.equal(fs.existsSync(keyFile), false, '宿主和核心都没有新建密钥');
    assert.equal(sha(db), before, '库没被改动');
    // 状态页（只给主人）说清楚是什么、数据动没动、该怎么办
    const page = ctx.connection.fetch.routes.find((r) => r.path === '/api/persona-memory/admin');
    const html = await (await page.fetch(new Request('http://127.0.0.1/api/persona-memory/admin'))).text();
    assert.match(html, /IDENTITY_KEY_MISSING/);
    assert.match(html, /persona-memory\.key/);
    assert.match(html, /没有改动任何数据/);
    // 她在原来的对话里照常聊天
    const agent = fakeAgent({ preset: 'web-chat' });
    const d = await ctx.preStep(agent, [userMessage('在吗')]);
    assert.ok(Array.isArray(d.messages));
    assert.equal(d.messages.some((m) => m.source?.kind === 'persona-memory'), false, '不注入');
    await host.dispose();
  } finally { rmDir(dir); }
});
