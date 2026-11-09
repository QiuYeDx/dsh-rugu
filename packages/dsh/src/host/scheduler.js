// 调度（§3.3 末尾、§7.7）：核心是被动的库，什么时候跑由这里决定。
//   - 每分钟左右一次 maintenance.tick()（切原文窗口、切分、时间维护、审核过期、今天到目前为止、嵌入一小批、保留期、到点开始夜间整理）；
//     上一次还没跑完就跳过这一次；顺带：配置文件热加载、核心自我文件热加载、余额来源刷新；
//   - 不停地跑 maintenance.runJobs()（提炼、整理……）：有活就紧接着再跑，没活歇几秒；每一轮有时间上限，让出事件循环；
//   - 夜间整理（04:30）由核心的 tick 到点自己开始（D26），这里不另外排。
import { delay, errCode } from './util.js';

/**
 * @param {{getPm: () => any, hostConfig: () => object, log: object, onTick?: () => void, now?: () => number,
 *          setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} opt
 */
export function createScheduler({ getPm, hostConfig, log, onTick = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const cfg = () => hostConfig().scheduler ?? {};
  const enabled = () => hostConfig().features?.scheduler !== false && hostConfig().enabled !== false;
  const ac = new AbortController();
  let tickTimer = null;
  let ticking = false;
  let jobsRunning = false;
  let started = false;
  const stats = { ticks: 0, tickErrors: 0, skippedTicks: 0, lastTickAt: null, lastTickMs: null, lastTick: null, jobsRan: 0, jobsFailed: 0, jobLoops: 0, jobErrors: 0 };

  async function tickOnce() {
    if (ticking) { stats.skippedTicks += 1; return null; }
    ticking = true;
    const t0 = now();
    try {
      try { onTick(); } catch { /* 热加载出错不影响维护 */ }
      const pm = getPm();
      if (!pm || !enabled()) return null;
      const r = await pm.maintenance.tick({ signal: ac.signal });
      stats.ticks += 1;
      stats.lastTick = summarize(r);
      return r;
    } catch (e) {
      stats.tickErrors += 1;
      log.warn('scheduler.tick', { error: errCode(e) });
      return null;
    } finally {
      stats.lastTickAt = now();
      stats.lastTickMs = now() - t0;
      ticking = false;
    }
  }

  async function jobsLoop() {
    if (jobsRunning) return;
    jobsRunning = true;
    try {
      while (!ac.signal.aborted) {
        const pm = getPm();
        let worked = false;
        if (pm && enabled()) {
          try {
            const r = await pm.maintenance.runJobs({ maxMs: cfg().jobsMaxMs ?? 20_000, signal: ac.signal });
            stats.jobLoops += 1;
            stats.jobsRan += r?.ran ?? 0;
            stats.jobsFailed += r?.failed ?? 0;
            worked = (r?.ran ?? 0) + (r?.failed ?? 0) > 0;
          } catch (e) {
            stats.jobErrors += 1;
            log.warn('scheduler.jobs', { error: errCode(e) });
          }
        }
        try { await delay(worked ? (cfg().jobsBusyMs ?? 250) : (cfg().jobsIdleMs ?? 5000), ac.signal); } catch { break; }
      }
    } finally { jobsRunning = false; }
  }

  const loop = () => {
    tickTimer = setTimer(async () => {
      await tickOnce();
      if (!ac.signal.aborted) loop();
    }, cfg().tickMs ?? 60_000);
    tickTimer?.unref?.();
  };

  return {
    start() {
      if (started) return;
      started = true;
      const first = setTimer(() => {
        if (ac.signal.aborted) return;
        tickOnce().finally(() => { if (!ac.signal.aborted) loop(); });
        jobsLoop().catch(() => {});
      }, cfg().startDelayMs ?? 15_000);
      first?.unref?.();
      tickTimer = first;
    },
    stop() { ac.abort(); if (tickTimer) clearTimer(tickTimer); tickTimer = null; },
    tickOnce,
    status: () => ({ ...stats, running: started && !ac.signal.aborted, ticking, jobsRunning }),
  };
}

/** tick 的结果只留步骤名和状态（不含内容）。 */
function summarize(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k] = v && typeof v === 'object' ? (v.error ? `error:${String(v.error).slice(0, 24)}` : 'ok') : String(v).slice(0, 24);
  return out;
}
