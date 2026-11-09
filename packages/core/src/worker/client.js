// 主线程这边的 worker 线程客户端：请求 / 应答按 id 配对，支持「部分结果」（稠密的每一层、词法的每一张表）和截止时间：
// 到点还没做完就带着已有的部分结果返回（timedOut），线程后来送回的结果直接丢掉（§8.8「到点没完成的那一路直接丢掉」）。
// 线程只在有请求在等时才 ref()，平时 unref()，不会因为忘了关而拖住宿主退出。
import { Worker } from 'node:worker_threads';
import { wallNow } from './vindex.js';

const THREAD_URL = new URL('./thread.js', import.meta.url);

export class ThreadClient {
  /**
   * @param {{role: 'search'|'db'|'maint', workerData: object, onExit?: (info: {code: number|null, error: string|null}) => void}} opt
   */
  constructor({ role, workerData, onExit }) {
    this.role = role;
    this.alive = true;
    this.pending = new Map();
    this.seq = 0;
    this.onExit = onExit;
    this.worker = new Worker(THREAD_URL, { workerData: { role, ...workerData } });
    this.worker.unref();
    this.ready = new Promise((resolve, reject) => { this.readyRes = resolve; this.readyRej = reject; });
    this.ready.catch(() => {});
    this.worker.on('message', (m) => this.#onMessage(m));
    this.worker.on('error', (e) => this.#down(null, e?.code ?? e?.name ?? 'Error'));
    this.worker.on('exit', (code) => this.#down(code, null));
  }

  #onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'ready') { this.readyRes(m.data); return; }
    if (m.kind === 'fatal') { this.readyRej(Object.assign(new Error('worker 线程启动失败'), { code: m.error?.code ?? 'WORKER_INIT' })); return; }
    const p = this.pending.get(m.id);
    if (!p) return;   // 已经超时放弃了
    if (m.kind === 'partial') { p.partials.push(m.data); return; }
    this.#settle(m.id, m.kind === 'done' ? { result: m.data, partials: p.partials, timedOut: !!m.data?.timedOut } : { error: m.error ?? { code: 'Error' }, partials: p.partials, timedOut: false });
  }

  #settle(id, value) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
    if (!this.pending.size && this.alive) this.worker.unref();
    p.resolve(value);
  }

  #down(code, error) {
    if (!this.alive) return;
    this.alive = false;
    this.readyRej(Object.assign(new Error('worker 线程退出了'), { code: 'THREAD_DOWN' }));
    for (const id of [...this.pending.keys()]) this.#settle(id, { error: { code: 'THREAD_DOWN' }, partials: this.pending.get(id)?.partials ?? [], timedOut: false });
    try { this.onExit?.({ code, error }); } catch { /* 回调出错不影响别人 */ }
  }

  /**
   * 发一个请求。永不 reject：线程挂了返回 {error: {code: 'THREAD_DOWN'}}，超时返回 {timedOut: true, partials}。
   * @param {string} op
   * @param {object} args
   * @param {{deadlineAt?: number, graceMs?: number, signal?: AbortSignal, transfer?: ArrayBuffer[]}} [opt]
   * @returns {Promise<{result?: any, error?: {code: string}, partials: any[], timedOut: boolean, aborted?: boolean}>}
   */
  request(op, args, { deadlineAt = Infinity, graceMs = 25, signal, transfer } = {}) {
    if (!this.alive) return Promise.resolve({ error: { code: 'THREAD_DOWN' }, partials: [], timedOut: false });
    if (signal?.aborted) return Promise.resolve({ partials: [], timedOut: true, aborted: true });
    const id = ++this.seq;
    return new Promise((resolve) => {
      const p = { resolve, partials: [], timer: null, signal, onAbort: null };
      this.pending.set(id, p);
      if (this.pending.size === 1) this.worker.ref();
      if (Number.isFinite(deadlineAt)) {
        p.timer = setTimeout(() => this.#settle(id, { partials: p.partials, timedOut: true }), Math.max(0, deadlineAt - wallNow()) + graceMs);
      }
      if (signal) {
        p.onAbort = () => this.#settle(id, { partials: p.partials, timedOut: true, aborted: true });
        signal.addEventListener('abort', p.onAbort, { once: true });
      }
      try { this.worker.postMessage({ id, op, args }, transfer ?? []); } catch (e) {
        this.#settle(id, { error: { code: e?.code ?? e?.name ?? 'Error' }, partials: [], timedOut: false });
      }
    });
  }

  /** 只发不等（发布新向量、删向量、重载索引）。 */
  post(op, args) {
    if (!this.alive) return false;
    try { this.worker.postMessage({ id: null, op, args }); return true; } catch { return false; }
  }

  async terminate() {
    if (!this.alive) return;
    this.alive = false;
    this.readyRej(Object.assign(new Error('worker 线程已停止'), { code: 'THREAD_DOWN' }));
    for (const id of [...this.pending.keys()]) this.#settle(id, { error: { code: 'THREAD_DOWN' }, partials: this.pending.get(id)?.partials ?? [], timedOut: false });
    try { await this.worker.terminate(); } catch { /* 尽力 */ }
  }
}
