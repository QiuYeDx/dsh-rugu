// 「有记忆 / 没记忆」对比评测（D126）在 DSH 里跑一次：管理页「诊断 → 记忆评测 → 跑一次」。
//   评测本身在核心包里（rugu-core 随包发布的 test/eval/memory-eval.js：真模块 + 替身端口 + 假平台，不调模型、不花钱），
//   这里只在一个 worker 线程里跑它（和线上的核心各用各的库、各用各的状态），临时库建在数据目录下的 .eval-tmp 里、跑完删掉；
//   结果（只有用例名、对错和数字）交给核心存下（admin.evalResult），诊断页显示「N/M 个用例在有记忆时拿到了关键内容」。
//   不碰线上库，不调模型；一次几秒。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);

/** 核心包里评测模块的位置（找不到返回 null：老版本的核心没带它）。 */
export function evalModuleUrl() {
  try {
    const dir = path.dirname(require.resolve('rugu-core/package.json'));
    const file = path.join(dir, 'test', 'eval', 'memory-eval.js');
    return fs.existsSync(file) ? pathToFileURL(file).href : null;
  } catch { return null; }
}

// worker 里跑的代码（CommonJS 的 eval worker 里用动态 import 载入 ES 模块）
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then((m) => m.runMemoryEval({ tmpRoot: workerData.tmpRoot }))
  .then((r) => parentPort.postMessage({ ok: true, r }), (e) => parentPort.postMessage({ ok: false, error: String(e && (e.code || e.message) || e).slice(0, 200) }));
`;

/**
 * 跑一次评测。同一时间只跑一个（第二次调用拿到同一个进行中的 Promise）。
 * @param {{dataDir: string, timeoutMs?: number}} opt
 * @returns {Promise<{version: string, at: number, ms: number, total: number, on: number, off: number, guards: number, guardsHeld: number, cases: object[]}>}
 */
let running = null;
export function runMemoryEvalInWorker({ dataDir, timeoutMs = 60_000 }) {
  if (running) return running;
  const url = evalModuleUrl();
  if (!url) return Promise.reject(Object.assign(new Error('这个版本的记忆核心没带评测'), { code: 'UNAVAILABLE' }));
  const tmpRoot = path.join(dataDir, '.eval-tmp');
  // 结束一律先等 worker 真的停下（它手里的临时库关了）再删临时目录；没交结果就退出的也算出错（评审）
  running = (async () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { url, tmpRoot } });
    let timer = null;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('评测超时'), { code: 'TIMEOUT' })), timeoutMs);
        w.once('message', (m) => { if (m?.ok) resolve(m.r); else reject(Object.assign(new Error(m?.error ?? '评测出错'), { code: 'EVAL_FAILED' })); });
        w.once('error', (e) => reject(e));
        w.once('exit', (code) => reject(Object.assign(new Error(`评测线程没交结果就退出了（${code}）`), { code: 'EVAL_FAILED' })));
      });
    } finally {
      clearTimeout(timer);
      try { await w.terminate(); } catch { /* 已经停了 */ }
    }
  })().finally(() => {
    running = null;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 删不掉下次再删 */ }
  });
  return running;
}
