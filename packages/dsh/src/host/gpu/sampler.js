// 资源管家的采样器（§8.6.2，附录 G.4：Toolhelp 枚举进程 + nvidia-smi 约 77–95 ms，不用 tasklist）。
//   - 进程枚举（kernel32 Toolhelp）和全屏状态（shell32 SHQueryUserNotificationState）在一个常驻的 worker 线程里用 koffi 调，不占主线程；
//     进程名只在 worker 里和清单比对，传回主线程的只有命中的序号；
//   - nvidia-smi 用 execFile 异步跑（windowsHide），只取空闲 / 已用 / 总显存和整卡占用率四个数字。
// koffi 用宿主自带的那份（@deepseek-ai/dsh-win32-process 的依赖，3.1.1）；拿不到就只有显卡读数，进程和全屏视为「不成立」。
import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/**
 * 找宿主自带的 koffi（3.1.1，宿主 dsh-win32-process 的依赖）。按顺序：配置里写的路径 → 和 dsh-win32-process 同一种解析方式 →
 * 插件自己能解析到的 → 安装目录里解包出来的那份（<安装目录>/resources/app.asar.unpacked/dsh/node_modules/koffi，附录 G.4）。
 * 找不到返回 null：只有显卡读数，进程和全屏视为「不成立」。
 * @param {{configured?: string, execPath?: string, resourcesPath?: string, exists?: (p: string) => boolean}} [o]
 */
export function resolveKoffiPath({ configured = '', execPath = process.execPath, resourcesPath = process.resourcesPath, exists = existsSync } = {}) {
  const unpacked = (res) => (res ? path.join(res, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs') : null);
  const tries = [
    () => (configured && exists(configured) ? configured : null),
    () => createRequire(import.meta.resolve('@deepseek-ai/dsh-win32-process')).resolve('koffi'),
    () => createRequire(import.meta.url).resolve('koffi'),
    () => { const p = unpacked(resourcesPath); return p && exists(p) ? p : null; },
    () => { const p = unpacked(execPath ? path.join(path.dirname(execPath), 'resources') : null); return p && exists(p) ? p : null; },
  ];
  for (const t of tries) { try { const p = t(); if (p) return p; } catch { /* 下一个 */ } }
  return null;
}

/** 解析 nvidia-smi 的一行：memory.used, memory.total, memory.free, utilization.gpu（MiB / %）。多卡取第一张。 */
export function parseNvidiaSmi(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).find((l) => /\d/.test(l));
  if (!line) return null;
  const [used, total, free, util] = line.split(',').map((x) => Number(String(x).trim()));
  if (![used, total, free, util].every(Number.isFinite)) return null;
  return { usedMb: used, totalMb: total, freeMb: free, utilPct: util };
}

function runNvidiaSmi(execFile, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : parseNvidiaSmi(stdout)));
  });
}

/**
 * @param {{koffiPath?: string|null, execFile?: typeof execFileCb, platform?: string}} [opt]
 */
export function createSystemSampler({ platform = process.platform, koffiPath = platform === 'win32' ? resolveKoffiPath() : null, execFile = execFileCb } = {}) {
  let worker = null;
  let workerDead = false;
  let seq = 0;
  const pending = new Map();
  const ensureWorker = () => {
    if (worker || workerDead || !koffiPath || platform !== 'win32') return worker;
    try {
      worker = new Worker(new URL('./sampler-worker.js', import.meta.url), { workerData: { koffiPath } });
      worker.unref();
      worker.on('message', (m) => { const p = pending.get(m?.id); if (p) { pending.delete(m.id); p(m); } });
      worker.on('error', () => { workerDead = true; worker = null; for (const p of pending.values()) p({}); pending.clear(); });
      worker.on('exit', () => { worker = null; });
    } catch { workerDead = true; worker = null; }
    return worker;
  };
  const askWorker = (processes) => new Promise((resolve) => {
    const w = ensureWorker();
    if (!w) { resolve({}); return; }
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); resolve({}); }, 3000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    w.postMessage({ id, processes });
  });
  return {
    available: () => ({ native: !!koffiPath && platform === 'win32' && !workerDead }),
    async sample({ processes = [] } = {}) {
      const t0 = Date.now();
      const [w, gpu] = await Promise.all([askWorker(processes), runNvidiaSmi(execFile)]);
      return {
        procHits: Array.isArray(w.procHits) ? w.procHits : [],
        fullscreen: typeof w.fullscreen === 'boolean' ? w.fullscreen : null,
        gpu,
        ms: Date.now() - t0,
      };
    },
    dispose() { try { worker?.terminate(); } catch { /* 忽略 */ } worker = null; },
  };
}
