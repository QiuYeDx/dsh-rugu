// consolidate 的参数：每次用都从 core.config.get() 取（热加载）。数值都在 config/defaults.js 的 sleep、today 两段
// （唯一的来源，【建议】，beta 用诊断区的数据再调）；这里只把别的段里要用的几个值一起摆成方便用的形状。
import { budgetLimits } from '../config/defaults.js';

const HOUR = 3_600_000;

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
  return {
    at: s.at,
    catchUpH: s.catchUpH,
    retryMin: s.retryMin,                               // 上次开始了但没跑完（进程崩了）：至少隔这么久才重跑
    maxLlmCalls: s.maxLlmCalls,
    depth,                                              // 'full' | 'essential'（节省预设：夜间整理只做必要项，§10.6）
    llmTimeoutMs: cfg.extract.timeoutMs,
    extract: s.extract,                                 // 第 1 步顺手跑的提炼、补跑失败批次（防「毒批次」每晚重试）、复核
    replay: {
      ...s.replay,
      withinDays: cfg.activation.events.replayWithinDays,
      w: cfg.activation.events.replay,
    },
    correct: s.correct,                                 // 第 2 步的对照原话纠错（D122）
    keep: cfg.extract.keep,                             // 提炼的「只记需要的」封顶（D123）：改正后的版本也按它
    generalize: s.generalize,
    reflection: {
      ...s.reflection,
      deadlineMs: s.reflection.deadlineMs ?? cfg.recall.deliberate.deadlineMs,   // null = 有意回想的截止时间
    },
    impressions: s.impressions,
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
