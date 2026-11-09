// 后台任务的调度胶水（§4.5 maintenance）。核心是被动的库：什么时候跑由集成层的调度决定（§3.3 末尾），
// 这里只负责「被叫到时按顺序跑哪些模块函数」，每一步都 try/catch，一个模块出错不影响别的。
import { claimNextJob, failJob, requeueStale } from './store/jobs.js';

/**
 * 任务种类 → 处理函数。模块在自己的 init 里登记：core.jobHandlers.set('extract', (core, job, opt) => ...)。
 * 处理函数自己负责 completeJob（在事务里写结果并标 done）；抛错 = 失败，按 1 / 4 / 16 分钟退避重排。
 * @typedef {(core: import('./core-types.js').CoreContext, job: import('./store/jobs.js').JobRow, opt: {signal?: AbortSignal}) => Promise<unknown>} JobHandler
 */

/**
 * maintenance.runJobs()：按优先级跑队列里的任务，直到没有、或超出 budget（任务数 / 毫秒数）。没有处理函数的种类留在队列里。
 * @param {import('./core-types.js').CoreContext} core
 * @param {import('./contract/types.js').JobBudget} [budget]
 * @returns {Promise<{ran: number, failed: number}>}
 */
export async function runJobs(core, budget = {}) {
  if (core.readOnly) return { ran: 0, failed: 0 };
  const t0 = Date.now();
  const kinds = [...core.jobHandlers.keys()].filter((k) => !budget.kinds || budget.kinds.includes(k));
  let ran = 0;
  let failed = 0;
  while (kinds.length && (budget.maxJobs == null || ran + failed < budget.maxJobs)) {
    if (budget.signal?.aborted) break;
    if (budget.maxMs != null && Date.now() - t0 > budget.maxMs) break;
    const job = claimNextJob(core.store, { kinds });
    if (!job) break;
    try {
      await core.jobHandlers.get(job.kind)(core, job, { signal: budget.signal });
      ran += 1;
    } catch (e) {
      failed += 1;
      failJob(core.store, job.id, { errorCode: e?.code ?? e?.name ?? 'Error', retry: e?.code !== 'NOT_IMPLEMENTED' });
      core.log.warn('job.failed', { kind: job.kind, id: job.id, error: e?.code ?? e?.name ?? 'Error' });
    }
  }
  return { ran, failed };
}

/** 启动时：上次崩溃时还在跑的任务放回队列（§12.8 第 3 条）。 */
export function recoverJobs(core) {
  if (core.readOnly) return 0;
  return requeueStale(core.store);
}

/**
 * maintenance.tick()【补】：集成层每分钟左右调一次的轻量维护。每一步独立 try/catch，返回各步的结果或错误类型。
 *   到点的原文窗口切掉（§7.1 第 8 步：空闲 2 分钟；intake 自己的定时器只在内存里，重启后靠这里）→
 *   切分缓冲找边界并排提炼任务 → 时间维护（计划 unknown、意图 armed / lapsed）→ 审核项过期（挂起的发言 14 天）→
 *   今天到目前为止 → 嵌入队列跑一小批（刚切的窗口）→ 保留期冷静期到点就生效 →
 *   到点了就开始夜间整理（夜间整理开始前 backup.runScheduled 做日包）。
 * 夜间整理可能跑十几分钟，tick 不等它（返回 'started'），之后的 tick 照常跑前面这些步；要等它跑完就调
 * api.maintenance.sleep()（正在跑时拿到的是同一次）。它不跟 tick 的 signal 走，关库时由 consolidate.dispose 中止。
 * @param {import('./core-types.js').CoreContext} core
 * @param {{at?: number, signal?: AbortSignal, sleep?: boolean}} [opt]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function tick(core, opt = {}) {
  const at = opt.at ?? core.now();
  const out = {};
  if (core.readOnly) return { skipped: 'read-only' };
  const step = async (name, fn) => {
    try { out[name] = await fn(); } catch (e) { out[name] = { error: e?.code ?? e?.name ?? 'Error' }; }
  };
  await step('windows', () => core.mods.intake.flushWindows(core, { at }));
  await step('segment', () => core.mods.encode.segment(core, { at }));
  await step('time', () => core.mods.consolidate.timeMaintenance(core, at));
  await step('reviews', () => core.mods.admin.expireReviews(core, at));
  await step('today', () => core.mods.consolidate.todaySoFar(core, { at, signal: opt.signal }));
  await step('embed', () => core.mods.worker.runEmbedQueue(core, { maxBatches: 1, signal: opt.signal }));
  await step('retention', () => core.mods.admin.applyRetention(core, at));
  if (opt.sleep !== false) await step('sleep', () => startSleep(core, at));
  return out;
}

/** 到点了就开始夜间整理，不等它跑完。 */
function startSleep(core, at) {
  if (!core.mods.consolidate.shouldSleep(core, at)) return 'not-due';
  Promise.resolve(core.mods.consolidate.sleep(core, { at })).catch((e) => {
    try { core.log.warn('sleep.failed', { error: e?.code ?? e?.name ?? 'Error' }); } catch { /* 日志也失败就算了 */ }
  });
  return 'started';
}
