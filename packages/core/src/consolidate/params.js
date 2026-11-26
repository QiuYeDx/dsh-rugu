// consolidate 的参数：每次用都从 core.config.get() 取（热加载）。数值都在 config/defaults.js 的 sleep、today 两段
// （唯一的来源，【建议】，beta 用诊断区的数据再调）；这里只把别的段里要用的几个值一起摆成方便用的形状。
import { budgetLimits, SLEEP_SCALE_MIN, SLEEP_SCALE_MAX } from '../config/defaults.js';

const HOUR = 3_600_000;

/**
 * 夜里整理做多少的倍数（D176）：花费档位的 sleepScale（预设 + 自定义）；读不到、不合法按 1，夹在 SLEEP_SCALE_MIN–SLEEP_SCALE_MAX。
 * @param {object} cfg  core.config.get()
 * @returns {number}
 */
export function sleepScaleOf(cfg) {
  let r = 1;
  try { r = Number(budgetLimits(cfg).sleepScale); } catch { r = 1; }
  if (!Number.isFinite(r) || r <= 0) r = 1;
  return Math.min(SLEEP_SCALE_MAX, Math.max(SLEEP_SCALE_MIN, r));
}

/**
 * mergeConfig 保证快照里的键是全的。
 * @param {import('../core-types.js').CoreContext} core
 */
export function params(core) {
  const cfg = core.config.get();
  const s = cfg.sleep;
  const t = cfg.today;
  let depth = 'full';
  try { depth = budgetLimits(cfg).sleepDepth ?? 'full'; } catch { /* 预算配置坏了按完整做 */ }
  // 一晚做多少（D176）：纠错、泛化的调用次数和一晚更新几个人的印象乘 sleepScale（取整、至少 1；本来就是 0 的还是 0 = 关着）
  const scale = sleepScaleOf(cfg);
  const times = (n) => (n > 0 ? Math.max(1, Math.round(n * scale)) : 0);
  return {
    at: s.at,
    catchUpH: s.catchUpH,
    retryMin: s.retryMin,                               // 上次开始了但没跑完（进程崩了）：至少隔这么久才重跑
    maxLlmCalls: s.maxLlmCalls,
    depth,                                              // 'full' | 'essential'（节省预设：夜间整理只做必要项，§10.6）
    scale,                                              // 夜里整理做多少的倍数（D176）
    llmTimeoutMs: cfg.extract.timeoutMs,
    extract: s.extract,                                 // 第 1 步顺手跑的提炼、补跑失败批次（防「毒批次」每晚重试）、复核
    replay: {
      ...s.replay,
      withinDays: cfg.activation.events.replayWithinDays,
      w: cfg.activation.events.replay,
    },
    correct: { ...s.correct, maxCalls: times(s.correct.maxCalls) },   // 第 2 步的对照原话纠错（D122）
    keep: cfg.extract.keep,                             // 提炼的「只记需要的」封顶（D123）：改正后的版本也按它
    generalize: { ...s.generalize, maxCalls: times(s.generalize.maxCalls) },
    reflection: {
      ...s.reflection,
      deadlineMs: s.reflection.deadlineMs ?? cfg.recall.deliberate.deadlineMs,   // null = 有意回想的截止时间
    },
    impressions: { ...s.impressions, perCall: times(s.impressions.perCall) },
    thetaHi: cfg.entities.thetaHi,
    thetaLo: cfg.entities.thetaLo,
    followUp: s.followUp,                               // 「回头问问」的时间窗：之后没机会就 lapsed
    storyline: s.storyline,
    communities: s.communities,
    selfConcept: s.selfConcept,
    lessons: s.lessons,                                 // 第 11 步：回顾做事的经验（D124）
    growth: {
      ...s.growth,
      mode: s.growth.mode === 'approve' ? 'approve' : 'auto',   // 只认配置（§5.7、§9.6）
    },
    diary: s.diary,
    maintenance: s.maintenance,
    retierBatch: cfg.activation.retierBatch,            // dynamics.retier 每批多少个（第 9 步按它估一整轮要几批）
    today: t,
    planGraceH: s.planGraceH,                           // 计划的时间点过了多久没下文才算「不确定」
    chunk: cfg.segment.chunk,
    factTextMax: cfg.extract.factTextMax,
    attention: cfg.activation.attention,
    defaultImp: cfg.activation.defaultImp,
    hourMs: HOUR,
  };
}
