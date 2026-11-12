// 契约里的枚举值（运行时版本）。和 types.js 的 JSDoc 一一对应；校验器和各模块都从这里取，别各写一份。
const f = (a) => Object.freeze(a);

export const PROTOCOL = 2;

export const CLAIM_KINDS = f(['account', 'display-name', 'self-introduction', 'role-in-setting', 'principal']);
export const VERIFIED_BY = f(['platform', 'config', 'owner']);

export const VISIBLE_TO = f(['setting-audience', 'her-only', 'participants']);
export const OBSERVATION_KINDS = f([
  'utterance', 'action', 'presence', 'content',
  'self-utterance', 'self-action', 'self-thought',
  'on-my-behalf', 'reminder', 'internal-notice',
  'retract', 'edit',
]);
/** 她自己的感知（actor 必须是 self，addressed 必须是 by-her）。 */
export const SELF_KINDS = f(['self-utterance', 'self-action', 'self-thought', 'on-my-behalf']);
/** 需要 target 的感知。 */
export const TARGET_KINDS = f(['retract', 'edit']);
export const ADDRESSED = f(['to-her', 'mentions-her', 'ambient', 'by-her']);
export const ATTENTION = f(['attended', 'peripheral']);
export const STANDING = f(['first-hand', 'platform', 'material']);

export const STABILITY = f(['persistent', 'transient']);
/** 【D111】场合的 label 是名字还是一句说法。 */
export const LABEL_KIND = f(['name', 'description']);
/** 【D111】真名从哪来：部署的人写在配置里的 / 平台上的（群里的人起的，主人没过目）。 */
export const LABEL_ORIGIN = f(['config', 'platform']);
export const AUDIENCE_ENTRY = f(['closed', 'invite', 'open']);
export const MEMBERS_KNOWN = f(['exact', 'recent-speakers', 'unknown']);
export const DISCLOSURE_VISIBLE_TO = f(['participants', 'members', 'anyone']);
export const PERSISTENCE = f(['ephemeral', 'logged', 'public-permanent']);

export const CHANNEL_PERSISTENCE = f(['once', 'recurring-context']);
export const UTTERANCE_PATHS = f(['tool', 'background', 'ui', 'owner-approved']);
export const APPRAISAL_VERDICTS = f(['speak', 'reconsider', 'hold']);
export const OUTCOMES = f(['sent', 'failed', 'held', 'hidden']);

export const SITUATION_TRIGGERS = f(['message', 'reminder', 'idle', 'relay']);
export const RECALL_MODES = f(['involuntary', 'deliberate']);
export const LAYERS = f(['people', 'recentFromPresent', 'todaySoFar', 'gap', 'warmStart', 'recalled', 'awarePrivate', 'intentions', 'working', 'sinceHere', 'lessons', 'pointBack', 'recollect', 'outline', 'look']);
/** 工作记忆里一条「说出口」的档位（D101）：free 照常说 / careful 说之前关口②看一眼 / not-here 这里不替他说（只在话题上时才放进心里）。 */
export const SPEAK_LEVELS = f(['free', 'careful', 'not-here']);
// 工作记忆的段（D110）：约定的一串 / 闲聊 / 开着的事
export const WORKING_UNITS = f(['thread', 'talk', 'open']);
/** RecallItem 允许的结论。omit 的条目根本不出现（§9.3.4）。 */
export const ITEM_VERDICTS = f(['share', 'share_vague', 'aware_private', 'pending']);
/** 关口①的完整结论集合（含 omit）。 */
export const DISCLOSURE_VERDICTS = f(['share', 'share_vague', 'aware_private', 'omit']);

export const NOTE_OPS = f(['remember', 'todo']);
export const FIX_OPS = f(['forget', 'correct', 'confirm']);
export const RESTRICTIONS = f(['none', 'soft', 'strict']);

/** 降级级别（§8.8）：0 完整、1 不重排、2 CPU 稠密、3 无嵌入、4 存储故障。 */
export const DEGRADE = f({ FULL: 0, NO_RERANK: 1, CPU_DENSE: 2, NO_EMBED: 3, STORE_DOWN: 4 });
