// 一条小的任务队列：并发上限、两次之间的最小间隔、按优先级取（数字越小越先）。可取消；排队中的任务被取消时直接拒绝。
import { abortError } from '../host/util.js';

export class TaskQueue {
  /** @param {{concurrency?: number, minSpacingMs?: number, now?: () => number}} [opt] */
  constructor({ concurrency = 1, minSpacingMs = 0, now = () => Date.now() } = {}) {
    this.concurrency = concurrency;
    this.minSpacingMs = minSpacingMs;
    this.now = now;
    this.running = 0;
    this.waiting = [];
    this.lastStart = 0;
    this.timer = null;
    this.seq = 0;
  }
  get size() { return this.waiting.length; }
  /**
   * @template T
   * @param {(signal?: AbortSignal) => Promise<T>} fn
   * @param {{priority?: number, signal?: AbortSignal}} [opt]
   * @returns {Promise<T>}
   */
  run(fn, { priority = 5, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? abortError()); return; }
      const item = { fn, priority, seq: this.seq++, resolve, reject, signal, onAbort: null };
      item.onAbort = () => {
        const i = this.waiting.indexOf(item);
        if (i >= 0) { this.waiting.splice(i, 1); reject(signal.reason ?? abortError()); }
      };
      signal?.addEventListener?.('abort', item.onAbort, { once: true });
      this.waiting.push(item);
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }
  pump() {
    if (this.timer) return;
    while (this.running < this.concurrency && this.waiting.length) {
      const wait = this.lastStart + this.minSpacingMs - this.now();
      if (this.minSpacingMs > 0 && this.lastStart > 0 && wait > 0) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
        return;
      }
      const item = this.waiting.shift();
      item.signal?.removeEventListener?.('abort', item.onAbort);
      this.running += 1;
      this.lastStart = this.now();
      Promise.resolve()
        .then(() => item.fn(item.signal))
        .then(item.resolve, item.reject)
        .finally(() => { this.running -= 1; this.pump(); });
    }
  }
  clear(reason = abortError('queue closed')) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const item of this.waiting.splice(0)) item.reject(reason);
  }
}
