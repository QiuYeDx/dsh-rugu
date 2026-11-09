// 监视一个被「写临时文件 + rename」整份重写的文件，读得不拖累写的一方（§11.1、H2）：
//   - 监视所在目录（rename 覆盖之后直接监视文件本身未必还有事件），按文件名过滤，临时文件的事件不理；
//   - 收到事件后等文件安静 quietMs（300 ms）再读一次；连续刷屏时，从这一波的第一个事件起最长 maxWaitMs（2 秒）也读一次；
//   - 轮询兜底每 pollMs（5 秒）只比较大小和修改时间，变了才读；监视器坏了（目录被删、句柄失效）在轮询时重新挂上；
//   - 一次只读一遍：读不动（占用）不立刻重试，不记指纹，等下一次事件或轮询；内容坏了记下指纹，等文件变了再读。
// 读文件本身由调用方做（onChange），这里只决定什么时候读。

/**
 * @typedef {object} DebouncedWatch
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => void} poke          当作收到了一次文件事件（测试和「马上看一眼」用）
 * @property {() => void} flush         立刻读一次（不等防抖）
 * @property {() => {events: number, reads: number, ignored: number, watching: boolean, rearmed: number}} stats
 */

/**
 * @param {object} o
 * @param {string} o.dir                       监视的目录
 * @param {string} o.name                      目录里那个文件的名字
 * @param {string} o.file                      完整路径（stat 用）
 * @param {ReturnType<import('./util.js').ioOf>} o.io
 * @param {(stamp: string|null) => ('ok'|'parse'|'busy'|'missing')} o.onChange   读一次；返回 'busy' 时不记指纹
 * @param {number} [o.quietMs]
 * @param {number} [o.maxWaitMs]
 * @param {number} [o.pollMs]
 * @param {ReturnType<import('./util.js').mkLog>} [o.log]
 * @returns {DebouncedWatch}
 */
export function createDebouncedWatch({ dir, name, file, io, onChange, quietMs = 300, maxWaitMs = 2000, pollMs = 5000, log }) {
  const T = io.timers;
  let watcher = null;
  let quiet = null;
  let maxWait = null;
  let poll = null;
  let running = false;
  let lastStamp;               // 上一次读过（或确认坏了）的指纹
  const st = { events: 0, reads: 0, ignored: 0, rearmed: 0 };

  function arm() {
    if (watcher || !running) return;
    try {
      watcher = io.watch(dir, (_event, fname) => {
        if (fname && fname !== name) { st.ignored += 1; return; }   // social-v2.json.<pid>.<hex>.tmp 之类
        schedule();
      });
      if (watcher && typeof watcher.on === 'function') {
        const w = watcher;
        const drop = () => { if (watcher === w) { try { w.close(); } catch { /* 已关 */ } watcher = null; } };
        w.on('close', drop);
        w.on('error', drop);      // 目录被删、句柄失效：下一次轮询重新挂
      }
    } catch {
      watcher = null;   // 目录还不在：只靠轮询，轮询时再试
    }
  }
  function disarm() {
    try { watcher?.close(); } catch { /* 已经关了 */ }
    watcher = null;
  }
  function clearPending() {
    if (quiet) { T.clearTimeout(quiet); quiet = null; }
    if (maxWait) { T.clearTimeout(maxWait); maxWait = null; }
  }
  function schedule() {
    if (!running) return;
    st.events += 1;
    if (quiet) T.clearTimeout(quiet);
    quiet = T.setTimeout(fire, quietMs);
    if (!maxWait) maxWait = T.setTimeout(fire, maxWaitMs);
  }
  function fire() {
    clearPending();
    if (!running) return;
    let stamp;
    try { stamp = stampOfSafe(); } catch { return; }   // stat 都读不动：等轮询
    if (stamp !== null && stamp === lastStamp) return;   // 事件来了但内容没变（例如只是临时文件的事件）
    st.reads += 1;
    let r = 'parse';
    try { r = onChange(stamp); } catch (e) { log?.warn('adapter.watch.onChange-threw', { code: String(e?.code ?? e?.name ?? 'error') }); r = 'parse'; }
    if (r !== 'busy') lastStamp = stamp;
  }
  function stampOfSafe() {
    const s = io.stat(file);
    return s ? `${s.size}:${s.mtimeMs}` : null;
  }
  function tick() {
    if (!running) return;
    if (!watcher) { arm(); if (watcher) st.rearmed += 1; }
    if (quiet || maxWait) return;              // 这一波已经排上了
    let stamp;
    try { stamp = stampOfSafe(); } catch { return; }
    if (stamp !== lastStamp) fire();
  }

  return {
    start() {
      if (running) return;
      running = true;
      arm();
      poll = T.setInterval(tick, pollMs);
    },
    stop() {
      running = false;
      clearPending();
      if (poll) { T.clearInterval(poll); poll = null; }
      disarm();
    },
    poke: schedule,
    flush() { if (running) fire(); },
    stats: () => ({ ...st, watching: !!watcher }),
  };
}
