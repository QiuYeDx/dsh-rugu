// 真文件系统上的 QQ 适配器：照桥接的写法（唯一名临时文件 + renameSync 覆盖）写 social-v2.json，
// 用真的 fs.watch 监视目录（§11.1：rename 覆盖之后仍能收到事件），确认读得到、只交一次、坏文件不崩。
// 另外：PM_QQ_BRIDGE_DIR 指向桥接目录时，逐个核对桥接 MCP 服务器里的工具都已分类（只读桥接代码）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createQqBridgeAdapter, QQ_TOOL_CLASSES, HOST_TOOL_CLASSES } from '../../src/adapters/qq-bridge.js';
import { fakeSink, rid, salt as mkSalt, inMsg, socialFile } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TMP = path.join(ROOT, '.tmp');

let renameRetries = 0;
function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      renameRetries += 1;      // 桥接的 renameWithRetry 在这里会同步忙等（H2）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
  fs.renameSync(tmp, file);
}
const waitFor = async (pred, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return pred();
};

test('真文件系统：rename 覆盖写入后 fs.watch 收到事件、防抖读一次；坏文件不崩；停掉后不再读', async (t) => {
  fs.mkdirSync(TMP, { recursive: true });
  const bridgeDir = fs.mkdtempSync(path.join(TMP, 'qq-bridge-'));
  t.after(() => fs.rmSync(bridgeDir, { recursive: true, force: true }));
  const state = path.join(bridgeDir, 'state');
  fs.mkdirSync(state);
  const friend = rid('u');
  const key = `group:${rid('g')}`;
  fs.writeFileSync(path.join(bridgeDir, 'config.json'), JSON.stringify({ allowAllWhenEmpty: true }));
  fs.writeFileSync(path.join(state, 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
  const file = path.join(state, 'social-v2.json');
  let reads = 0;
  const adapter = createQqBridgeAdapter({
    paths: { bridgeDir }, salt: mkSalt(),
    readFile: (p) => { if (p === file) reads += 1; return fs.readFileSync(p, 'utf8'); },
    config: { timing: { quietMs: 60, maxWaitMs: 300, pollMs: 400 } },
  });
  const sink = fakeSink();
  const stop = adapter.start(sink);
  const T = Date.now();
  const recent = [];
  const wrote = [];
  for (let i = 1; i <= 10; i++) {
    recent.push(inMsg({ seq: i, userId: friend, sender: '阿明', text: `第${i}条`, time: T + i }));
    atomicWriteJson(file, socialFile({ [key]: { recent: [...recent] } }));
    wrote.push(Date.now());
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(await waitFor(() => sink.all().length === 10), `收到了 ${sink.all().length} 条`);
  // 防抖把一阵写合成一次读：机器忙的时候 10 毫秒的间隔会被拉长到超过 quietMs，那几次本来就该各读一次（全量测试时偶发，评审）——
  // 上限按真实的写入间隔算：间隔超过 quietMs 的才算新的一阵
  const bursts = 1 + wrote.slice(1).filter((x, i) => x - wrote[i] >= 60).length;
  assert.ok(reads <= Math.max(4, bursts + 3), `10 次写（${bursts} 阵）只读了 ${reads} 次`);
  t.diagnostic(`rename 重试 ${renameRetries} 次，读 ${reads} 次`);
  assert.ok(renameRetries <= 2, `写的一方被读拖累：rename 重试 ${renameRetries} 次`);
  assert.equal(new Set(sink.all().map((o) => o.text)).size, 10);
  // 半截文件：不崩，什么都不交
  fs.writeFileSync(file, '{"conversations": {');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sink.all().length, 10);
  atomicWriteJson(file, socialFile({ [key]: { recent: [...recent, inMsg({ seq: 11, userId: friend, sender: '阿明', text: '好了', time: T + 20 })] } }));
  assert.ok(await waitFor(() => sink.all().length === 11));
  assert.equal(sink.all().at(-1).text, '好了');
  stop();
  const r0 = reads;
  atomicWriteJson(file, socialFile({ [key]: { recent: [] } }));
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(reads, r0, '停掉后不再读');
});

const BRIDGE = process.env.PM_QQ_BRIDGE_DIR;
test('桥接 MCP 服务器里的工具全部已分类（PM_QQ_BRIDGE_DIR 指向桥接目录时才跑；只读桥接代码）', { skip: !BRIDGE && '没设 PM_QQ_BRIDGE_DIR' }, () => {
  const names = (file, re) => {
    const src = fs.readFileSync(path.join(BRIDGE, 'src', file), 'utf8');
    return [...new Set([...src.matchAll(re)].map((m) => m[1]))];
  };
  const qq = names('mcp-snowluma-safe.js', /server\.tool\(\s*'([a-z0-9_]+)'/g);
  const host = names('mcp-host-server.js', /server\.tool\(\s*'([a-z0-9_]+)'/g);
  assert.ok(qq.length > 10);
  const missing = [...qq.filter((n) => !QQ_TOOL_CLASSES[n]), ...host.filter((n) => !HOST_TOOL_CLASSES[n])];
  assert.deepEqual(missing, [], `没分类的工具：${missing.join(', ')}`);
  const stale = Object.keys(QQ_TOOL_CLASSES).filter((n) => !qq.includes(n));
  assert.deepEqual(stale, [], `桥接里已经没有的工具：${stale.join(', ')}`);
});
