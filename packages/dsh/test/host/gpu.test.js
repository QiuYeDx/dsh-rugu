// 资源管家（§8.6.2、§10.7）：显卡策略「关 / 开 / 自适应」、六个让出条件、回差、让出时也让 CPU；采样器的解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernor, inSchedule, reasonText } from '../../src/host/gpu/governor.js';
import { createSystemSampler, parseNvidiaSmi, resolveKoffiPath } from '../../src/host/gpu/sampler.js';
import path from 'node:path';
import { HOST_DEFAULTS } from '../../src/host/config.js';

const MIN = 60_000;
function env(gpu = {}, { features = {} } = {}) {
  const cfg = JSON.parse(JSON.stringify(HOST_DEFAULTS));
  Object.assign(cfg.gpu, gpu);
  Object.assign(cfg.features, features);
  let t = new Date(2026, 10, 4, 10, 0).getTime();
  let sample = { procHits: [], fullscreen: false, gpu: { usedMb: 1000, totalMb: 12_288, freeMb: 11_000, utilPct: 5 } };
  const changes = [];
  const g = createGovernor({
    hostConfig: () => cfg, now: () => t, sampler: { sample: async () => sample }, ownVramMb: () => 4200,
    onChange: (next, prev) => changes.push([prev.device, next.device]), setTimer: () => null, clearTimer: () => {},
  });
  return { g, cfg, changes, advance: (ms) => { t += ms; }, setSample: (s) => { sample = { ...sample, ...s }; }, now: () => t };
}

test('自适应（默认）：没采样就 CPU；启动后第一次采样全部解除直接上 GPU；真让出过以后，条件全解除要稳定 cooldown（15 分钟）才回 GPU——回差，避免反复卸载加载', async () => {
  const e = env();
  assert.equal(e.g.status().policy, 'adaptive');
  assert.equal(e.g.decision().device, 'cpu');
  assert.deepEqual(e.g.decision().reasons, ['no-sample']);
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu', '启动以来没让出过：不用等回差（实测问题 #1：不在 CPU 上白跑 15 分钟再重新加载一次）');
  assert.equal(e.g.decision().rerankAllowed, true, 'GPU 有空才能启动重排');
  // 有全屏程序在前台，让出；解除以后要等回差
  e.setSample({ fullscreen: true });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'cpu');
  e.setSample({ fullscreen: false });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'cpu');
  assert.deepEqual(e.g.decision().reasons, ['cooldown']);
  assert.equal(e.g.decision().nextGpuAt, e.now() + 15 * MIN);
  e.advance(15 * MIN);
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu');
  assert.deepEqual(e.changes.filter(([a, b]) => a !== b), [['cpu', 'gpu'], ['gpu', 'cpu'], ['cpu', 'gpu']]);
});

test('让出条件：清单里的程序（CPU 也降线程）、全屏、显存不足（扣掉我们自己的）、持续很忙、时间表、游戏模式', async () => {
  const e = env({ processes: ['SomeGame.exe', 'tts-engine.exe'], cooldownMin: 0 });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu');
  // 1. 指定程序（清单是主人的配置；进程列表本身不离开采样线程）
  e.setSample({ procHits: [1] });
  await e.g.sampleOnce();
  let d = e.g.status();
  assert.equal(d.device, 'cpu');
  assert.deepEqual(d.reasons, ['process:2']);
  assert.equal(d.cpuThreads, 2, '主人在玩：CPU 线程也降到 2');
  assert.deepEqual(d.games, ['tts-engine.exe']);
  assert.match(d.reason, /清单第 2 项/);
  assert.equal(d.yielding, true);
  assert.equal(d.rerankAllowed, false);
  // 2. 全屏
  e.setSample({ procHits: [], fullscreen: true });
  await e.g.sampleOnce();
  assert.deepEqual(e.g.decision().reasons, ['fullscreen']);
  assert.equal(e.g.decision().cpuThreads, 2);
  e.cfg.gpu.fullscreen = false;
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu', '每一条都能单独关');
  // 3. 显存：在 GPU 上时读数加回我们自己占的（4200），低于 1500 才让出；只让 GPU，不降 CPU
  e.setSample({ fullscreen: false, gpu: { usedMb: 0, totalMb: 12_288, freeMb: 100, utilPct: 5 } });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu', '100 + 4200 ≥ 1500');
  e.setSample({ gpu: { usedMb: 0, totalMb: 12_288, freeMb: 0, utilPct: 5 } });
  e.cfg.gpu.vram.minFreeMb = 5000;
  await e.g.sampleOnce();
  assert.deepEqual(e.g.decision().reasons, ['vram']);
  assert.equal(e.g.decision().cpuThreads, 4, '显存不足只让出 GPU，不降 CPU');
  // 回来要「空闲 ≥ 模型占用 + 2 GB」
  e.cfg.gpu.vram.minFreeMb = 1500;
  e.setSample({ gpu: { usedMb: 0, totalMb: 12_288, freeMb: 6000, utilPct: 5 } });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'cpu', '6000 < 4200 + 2000');
  e.setSample({ gpu: { usedMb: 0, totalMb: 12_288, freeMb: 6300, utilPct: 5 } });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu');
  // 4. 持续很忙：连续 60 秒 > 80%
  e.setSample({ gpu: { usedMb: 0, totalMb: 12_288, freeMb: 8000, utilPct: 95 } });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu', '刚开始忙');
  e.advance(61_000);
  await e.g.sampleOnce();
  assert.deepEqual(e.g.decision().reasons, ['busy']);
  e.setSample({ gpu: { usedMb: 0, totalMb: 12_288, freeMb: 8000, utilPct: 10 } });
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu');
  // 5. 时间表（跨午夜）
  e.cfg.gpu.schedule = { enabled: true, from: '09:00', to: '11:00' };
  await e.g.sampleOnce();
  assert.deepEqual(e.g.decision().reasons, ['schedule']);
  e.cfg.gpu.schedule = { enabled: false, from: '09:00', to: '11:00' };
  // 6. 手动游戏模式：接下来 N 小时 / 直到关掉
  e.cfg.gpu.gameMode = { until: e.now() + 60 * MIN };
  await e.g.sampleOnce();
  assert.deepEqual(e.g.decision().reasons, ['game-mode']);
  assert.equal(e.g.decision().cpuThreads, 2);
  e.advance(61 * MIN);
  await e.g.sampleOnce();
  assert.equal(e.g.decision().device, 'gpu', '到点自动结束');
  e.cfg.gpu.gameMode = { until: -1 };
  assert.equal(e.g.evaluate().device, 'cpu');
});

test('「关」永远 CPU（重排随之停用）；「开」不看条件，只在出错时退回 CPU 一段时间；功能开关关掉 = 关', async () => {
  const off = env({ policy: 'off' });
  await off.g.sampleOnce();
  assert.deepEqual([off.g.decision().device, off.g.decision().reasons, off.g.decision().rerankAllowed], ['cpu', ['policy-off'], false]);
  assert.equal(off.g.status().yielding, false, '「关」不算让出');
  const on = env({ policy: 'on', processes: ['SomeGame.exe'] });
  on.setSample({ procHits: [0], fullscreen: true, gpu: { usedMb: 0, totalMb: 1, freeMb: 0, utilPct: 100 } });
  await on.g.sampleOnce();
  assert.equal(on.g.decision().device, 'gpu', '「开」不看任何条件');
  on.g.reportGpuError();
  assert.equal(on.g.decision().device, 'cpu');
  assert.deepEqual(on.g.decision().reasons, ['gpu-error']);
  on.advance(31 * MIN);
  assert.equal(on.g.evaluate().device, 'gpu', 'gpuErrorHoldMin 之后再试');
  const disabled = env({}, { features: { gpu: false } });
  assert.equal(disabled.g.evaluate().policy, 'off');
});

test('时间表跨午夜；原因的说法；nvidia-smi 的解析（多卡取第一张、坏输出返回 null）', () => {
  const at = (h, m = 0) => new Date(2026, 10, 4, h, m).getTime();
  const sch = { enabled: true, from: '20:00', to: '02:00' };
  assert.equal(inSchedule(sch, at(21)), true);
  assert.equal(inSchedule(sch, at(1, 59)), true);
  assert.equal(inSchedule(sch, at(2)), false);
  assert.equal(inSchedule(sch, at(12)), false);
  assert.equal(inSchedule({ ...sch, enabled: false }, at(21)), false);
  assert.equal(inSchedule({ enabled: true, from: 'x', to: '02:00' }, at(21)), false);
  assert.equal(reasonText('process:3'), '清单第 3 项在运行');
  assert.equal(reasonText('vram'), '空闲显存不足');
  assert.deepEqual(parseNvidiaSmi('1200, 12288, 11088, 7\r\n300, 8192, 7892, 0\r\n'), { usedMb: 1200, totalMb: 12288, freeMb: 11088, utilPct: 7 });
  assert.equal(parseNvidiaSmi('NVIDIA-SMI has failed'), null);
  assert.equal(parseNvidiaSmi(''), null);
});

// 真的 koffi（宿主自带的 3.1.1）：PM_KOFFI_PATH 指向它的 index.cjs 时才跑。只看「node.exe 在不在清单命中里」，进程列表不离开采样线程
test('采样器（真 koffi，可选）：Toolhelp 枚举进程只回命中的序号；全屏状态是布尔', { skip: !process.env.PM_KOFFI_PATH || process.platform !== 'win32' }, async () => {
  const s = createSystemSampler({ koffiPath: process.env.PM_KOFFI_PATH });
  const r = await s.sample({ processes: ['node.exe', 'definitely-not-running-persona-memory.exe'] });
  assert.deepEqual(r.procHits, [0]);
  assert.equal(typeof r.fullscreen, 'boolean');
  assert.ok(r.ms < 2000);
  s.dispose();
});

test('采样器：非 Windows 或没有 koffi 时只有显卡读数（进程和全屏视为「不成立」）；nvidia-smi 用 execFile、windowsHide', async () => {
  const calls = [];
  const execFile = (cmd, args, opt, cb) => { calls.push({ cmd, args, opt }); cb(null, '100, 1000, 900, 3\n'); };
  const s = createSystemSampler({ koffiPath: null, execFile, platform: 'linux' });
  assert.equal(s.available().native, false);
  const r = await s.sample({ processes: ['a.exe'] });
  assert.deepEqual(r.procHits, []);
  assert.equal(r.fullscreen, null);
  assert.deepEqual(r.gpu, { usedMb: 100, totalMb: 1000, freeMb: 900, utilPct: 3 });
  assert.equal(calls[0].cmd, 'nvidia-smi');
  assert.equal(calls[0].opt.windowsHide, true);
  const broken = createSystemSampler({ koffiPath: null, execFile: (c, a, o, cb) => cb(new Error('ENOENT')), platform: 'win32' });
  assert.equal((await broken.sample({})).gpu, null, '没有 nvidia-smi：读不到显卡');
  s.dispose();
});

test('找宿主自带的 koffi：配置里写的优先；否则在安装目录的 resources/app.asar.unpacked 里找（附录 G.4）', () => {
  const seen = new Set();
  const exists = (p) => seen.has(path.normalize(p));
  seen.add(path.normalize('X:/cfg/koffi/index.cjs'));
  assert.equal(resolveKoffiPath({ configured: 'X:/cfg/koffi/index.cjs', exists, execPath: '', resourcesPath: '' }), 'X:/cfg/koffi/index.cjs');
  const viaExe = path.join('X:/App', 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs');
  seen.add(path.normalize(viaExe));
  const r = resolveKoffiPath({ configured: 'X:/missing.cjs', exists, execPath: path.join('X:/App', 'DeepSeek Harness.exe'), resourcesPath: '' });
  assert.ok(r === viaExe || /koffi/.test(r ?? ''), '装在插件旁边的 koffi 也认');
});
