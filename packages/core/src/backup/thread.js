// 备份模块自己的短命 worker 线程：完整性检查、各表条数、VACUUM INTO、预览对比、恢复演练的抽样和检索、部分恢复的挑选、JSONL 导出。
// 这些都是 > 50 ms 的数据库调用，不能放在主线程（§7.7 第 10 步、§13.3 慢日志）。每个任务开一个线程、用自己的连接
// （对正在用的库只开只读连接，WAL 允许并发读），做完就退出。
// 不借用 worker 模块的常驻线程：备份是「丢不起」的那一层，worker 降级（L3）或没起来时备份和验证照样要能做，
// 也不和热路径的检索抢同一个线程。
import { Worker } from 'node:worker_threads';

const SCRIPT = new URL('./sqlite-task.js', import.meta.url);

export class DbTaskError extends Error {
  constructor(task, code, message) {
    super(`${task}：${message ?? code}`);
    this.name = 'DbTaskError';
    this.code = code || 'DB_TASK';
    this.task = task;
  }
}

/**
 * 在新线程里跑一个数据库任务（任务表见 sqlite-task.js）。
 * @param {string} task
 * @param {object} args   只能是可结构化克隆的数据（路径、数字、数组……）
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opt]
 * @returns {Promise<any>}
 */
export function runDbTask(task, args, opt = {}) {
  return new Promise((resolve, reject) => {
    if (opt.signal?.aborted) { reject(new DbTaskError(task, 'ABORTED')); return; }
    let settled = false;
    const w = new Worker(SCRIPT, { workerData: { task, args }, execArgv: ['--no-warnings'] });
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opt.signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => { w.terminate(); finish(reject, new DbTaskError(task, 'ABORTED')); };
    const timer = setTimeout(() => { w.terminate(); finish(reject, new DbTaskError(task, 'TIMEOUT')); }, opt.timeoutMs ?? 6 * 3_600_000);
    opt.signal?.addEventListener('abort', onAbort, { once: true });
    w.once('message', (m) => {
      if (m?.ok) finish(resolve, m.out);
      else finish(reject, new DbTaskError(task, m?.code, m?.message));
    });
    w.once('error', (e) => finish(reject, new DbTaskError(task, e?.code ?? 'WORKER', e?.message)));
    w.once('exit', (code) => { if (!settled) finish(reject, new DbTaskError(task, 'WORKER_EXIT', `退出码 ${code}`)); });
  });
}
