// 核心契约的全部类型（设计 §4.2–§4.5），只有 JSDoc，没有运行时代码。
// 规矩：
//   - 这里的类型不含任何宿主概念（会话 id 只是一个不透明字符串）。DSH 绑定的类型在 packages/dsh/src/binding/。
//   - 所有 id（AdapterId 以外）都是不透明字符串：只能整体比较是否相等，不许拆、不许拼、不许猜格式（§2.2）。
//   - 时间一律是 UTC 毫秒（number）。
//   - 和设计文档相比多出来的字段都标了【补】，理由写在 docs/实现/模块与接口.md 的「对设计的补充」。
export {};

// ── §4.2 基本类型和身份 ─────────────────────────────────────────────────────

/** @typedef {string} AdapterId  适配器自取；也是它的默认账号命名空间。 */
/** @typedef {string} SettingId  适配器命名、稳定、不透明。核心只存 HMAC(adapterId, SettingId)。 */
/** @typedef {string} ObsId      适配器给的稳定去重键；核心按 (adapterId, ObsId) 唯一，存的也是 HMAC。 */

/**
 * 账号证据。namespace / id / scope 三个字段分开，不拼成一个字符串（评审:AR-04）。
 * 核心入库前对 id 做 HMAC，只存哈希（§12.3）。
 * @typedef {object} AccountClaim
 * @property {'account'} kind
 * @property {string} namespace          通常就是 AdapterId
 * @property {string} id                 平台上的账号 id（原值只在内存里停留到算完哈希）
 * @property {string} [scope]            只在某个应用或场合里有效的 id（例：按应用分配的 openid）
 * @property {'platform'|'config'|'owner'} verifiedBy
 * @property {string} [displayName]
 */
/**
 * 显示名证据。群名片这类只在本场合有效（scope = 那个场合）。
 * @typedef {object} DisplayNameClaim
 * @property {'display-name'} kind
 * @property {string} name
 * @property {SettingId} [scope]
 * @property {number} observedAt
 */
/**
 * 自我介绍（「我是阿明的表哥」）。只能产生 maybe_same，不产生权利（§5.2）。
 * @typedef {object} SelfIntroductionClaim
 * @property {'self-introduction'} kind
 * @property {string} text
 * @property {ObsId} obs
 */
/**
 * 在某个场合里的身份。role 是开放字符串，只给模型看；核心只读两个布尔。
 * @typedef {object} RoleInSettingClaim
 * @property {'role-in-setting'} kind
 * @property {SettingId} setting
 * @property {string} role
 * @property {boolean} [moderates]
 * @property {boolean} [isOwner]
 */
/**
 * 「这就是我服务的人」。只能来自配置（strength 恒为 'config'）。
 * @typedef {object} PrincipalClaim
 * @property {'principal'} kind
 * @property {'config'} strength
 */
/** @typedef {AccountClaim|DisplayNameClaim|SelfIntroductionClaim|RoleInSettingClaim|PrincipalClaim} IdentityClaim */

/**
 * 「这是谁」的证据集合。self:true 表示是她自己。
 * @typedef {object} ActorRef
 * @property {true} [self]
 * @property {IdentityClaim[]} claims
 */

// ── §4.3 感知和场合 ──────────────────────────────────────────────────────────

/** @typedef {'setting-audience'|'her-only'|'participants'} VisibleTo */
/**
 * @typedef {'utterance'|'action'|'presence'|'content'
 *   |'self-utterance'|'self-action'|'self-thought'
 *   |'on-my-behalf'|'reminder'|'internal-notice'
 *   |'retract'|'edit'} ObservationKind
 */
/** @typedef {'to-her'|'mentions-her'|'ambient'|'by-her'} Addressed */
/** @typedef {'attended'|'peripheral'} Attention */
/** @typedef {'first-hand'|'platform'|'material'} Standing  material = 别人贴的素材、她读到的内容，永远不是指令 */

/**
 * @typedef {object} MediaRef
 * @property {string} kind
 * @property {string} [summary]
 * @property {string} [ref]
 */

/**
 * 一次感知（§4.3）。适配器只给事实，不做判断。
 * @typedef {object} Observation
 * @property {ObsId} id
 * @property {SettingId} settingId                 事情发生的场合
 * @property {SettingId} [perceivedInSettingId]    她在哪个场合知道的（默认同 settingId）
 * @property {VisibleTo} visibleTo                 这条内容当时谁看得到（不是「当时谁在群里」）
 * @property {number} at                           事情发生的时间
 * @property {number} perceivedAt                  她感知到的时间
 * @property {ActorRef} actor
 * @property {ObservationKind} kind
 * @property {ObsId} [target]                      retract / edit 指向的原消息
 * @property {string} text
 * @property {boolean} [textTruncated]
 * @property {string} [lang]                       适配器知道就给，不知道由核心检测
 * @property {MediaRef[]} [media]
 * @property {{obs?: ObsId, author?: ActorRef, excerpt?: string}} [quote]
 * @property {ObsId} [replyTo]
 * @property {ActorRef[]} [mentions]
 * @property {Addressed} addressed
 * @property {Attention} attention
 * @property {boolean} evidential                  false = 动作行、系统行，永远不能当作事实的证据
 * @property {{claimedAuthor?: ActorRef, relayedBy: ActorRef, authorVerified: false}} [forwarded]
 * @property {{relayedBy: ActorRef, originalSetting?: SettingId}} [via]
 * @property {{adapter: AdapterId, obsId: ObsId}} [derivedFrom]
 * @property {Standing} standing
 * @property {{sessionId: string, seq?: number, callId?: string}} [sessionRef]
 * @property {string} [appraisalToken]             self-utterance 带上，用于对账（§9.5）
 * @property {boolean} [historical]                回填旧日志时为 true
 */

/**
 * 场合描述（§4.3）。只填属性，不出现平台名。label 是她心里对这个地方的称呼。
 * 【补 D111】labelKind：'name' = label 是这个地方真正的名字（平台上的群名、配置里写的名字），会被当成这个场合的名字认；
 * 'description' = 适配器不知道名字，label 只是一句说法（「一个 QQ 群」），不当名字认，她心里不加引号。不给 = 'name'（老的适配器）。
 * labelOrigin（只对真名有意义）：'config' = 部署的人写在配置里的（不给就是它，老的适配器）；'platform' = 平台上的名字（群名、机器人的备注：
 * 场合里的人起的，主人和部署的人都没过目）。平台上的名字是那个场合的人知道的事：核心只在那里的成员、管理者面前说出它（关口①），
 * 别处写成「在另一个群里」；主人起了名字就按主人的。
 * hint：只给管理页的区分提示（≤ 24 字，例如短码、人数），不进快照、绝不进任何提示词。
 * 主人在管理页起的名字优先于这两者（核心存在 settings.owner_label，适配器改不了）。
 * @typedef {object} SettingDescriptor
 * @property {SettingId} id
 * @property {string} label
 * @property {'name'|'description'} [labelKind]
 * @property {'config'|'platform'} [labelOrigin]
 * @property {string} [hint]
 * @property {SettingId} [parent]
 * @property {'persistent'|'transient'} stability
 * @property {{size: number|'unbounded'|'unknown', entry: 'closed'|'invite'|'open',
 *             unknownObservers: boolean, membersKnown: 'exact'|'recent-speakers'|'unknown'}} audience
 * @property {{visibleTo: 'participants'|'members'|'anyone',
 *             persistence: 'ephemeral'|'logged'|'public-permanent',
 *             searchable: boolean, attributedToHer: boolean}} disclosure
 * @property {{owner: ActorRef|'platform'|'unknown', herRole: string,
 *             herModerates: boolean, actsOnBehalfOfPrincipal: boolean}} ownership
 * @property {{register?: string, notes?: {text: string, author?: ActorRef}[]}} [norms]
 * @property {{preSendGate: boolean, canHold: boolean}} capabilities
 * @property {string} [purpose]
 * @property {boolean} attending                   false = 她不在这个房间里（或主人设了「别记这里」）
 */

// ── §4.4 表达渠道和发言 ─────────────────────────────────────────────────────

/**
 * 话会传到哪（§4.4）。核心只按「目标场合的受众 × 留存方式 × 延时」推理。
 * @typedef {object} ExpressionChannel
 * @property {SettingId} targetSettingId
 * @property {'once'|'recurring-context'} persistence
 * @property {number} [delayMs]
 * @property {ActorRef} [addressee]
 * @property {ActorRef[]} [notifies]
 * @property {string} [formHint]                   开放字符串（「评论」「私信」……），只用于措辞和日志
 */
/**
 * 她要说的一句（或一组）话。
 * @typedef {object} Utterance
 * @property {ExpressionChannel} channel
 * @property {string[]} text
 * @property {{kind: string, summary?: string}[]} [media]
 * @property {{path: 'tool'|'background'|'ui'|'owner-approved', sessionId?: string, callId?: string,
 *             homeSettingId?: SettingId, holdToken?: string}} origin
 */
/**
 * 关口②的结论。token 用于之后的 outcome() 和自身发言回流对账。
 * @typedef {object} Appraisal
 * @property {'speak'|'reconsider'|'hold'} verdict
 * @property {string} [reflection]                 她自己的一句转念（reconsider / hold 时）
 * @property {string} token
 */

// ── §4.5 核心 API 的参数和返回值 ───────────────────────────────────────────

/**
 * @typedef {object} ObserveOptions
 * @property {AdapterId} [adapter]                 【补】这批感知来自哪个适配器。直接调 api.observe() / api.describe() 时必填
 *                                                 （核心按 (adapterId, id) 算存储键）；经 start(sink) 提交时由 sink 自动填
 * @property {boolean} [historical]                回填：不预取、不形成意图、过期的计划直接结案
 * @property {{key: string, value: string}} [cursor]  【补】适配器的读取游标，和这批感知在同一个事务里提交（§12.8 第 1 条）
 */
/**
 * start(sink) 收到的 sink。
 * @typedef {object} PerceptionSink
 * @property {(o: Observation[], opt?: ObserveOptions) => void} observe
 * @property {(d: SettingDescriptor) => void} describe
 * @property {(key: string) => (string|null)} cursor   【补】读回自己上次提交的游标
 */
/**
 * 核心契约里的适配器（不含宿主概念）。
 * @typedef {object} PerceptionAdapter
 * @property {AdapterId} id
 * @property {2} protocol
 * @property {(id: SettingId) => SettingDescriptor|Promise<SettingDescriptor>} describeSetting
 * @property {(id: SettingId) => Promise<ActorRef[]|null>} [members]
 * @property {(sink: PerceptionSink) => (() => void)} [start]
 * @property {() => IdentityClaim[]} selfClaims
 * @property {() => IdentityClaim[]} principalClaims
 * @property {string} [displayName]               【补 D111】入口在管理页上的名字（「QQ」「DSH 网页」）；不给就显示 id。只给管理页，不进提示词
 * @property {(id: SettingId) => string|null} [quietReason]
 *           【补 D111】这个场合现在为什么可能收不到东西（「没有配置……」）；接得上就返回 null。只给管理页，同步、不抛错
 * @property {(token: string, approve: boolean, detail?: {text: string}) => Promise<void>} [onHoldDecision]
 *           主人在管理页批准 / 驳回挂起的发言、或挂起过期时由核心调用（§9.4.4）。【补】批准时第三个参数带要发出去的原文
 *           （Utterance.text 按 '\n' 连起来）：适配器那边只存令牌和文本哈希，拿它带着令牌以 origin.path='owner-approved'
 *           再发一次（还会过一遍 appraise，不会再被挂起）
 */

/**
 * 「这件事会从别的入口转进来」的预告（§7.1 第 4 步）。textHash 用 contract 的 textHash() 算。
 * @typedef {object} RelayExpectation
 * @property {AdapterId} adapter
 * @property {ObsId} obsId
 * @property {string} textHash
 * @property {number} until
 */

/**
 * 回想的场合指针。窗口、在场者都由核心从自己的感知库里取（评审:AR-03）。
 * @typedef {object} SituationRef
 * @property {SettingId} settingId
 * @property {ObsId} [focusObsId]
 * @property {ObsId[]} [focusObsIds]               【补，D108】这一批里对她说话的几条（不同的人，最多 8 条，主触发者那条用 focusObsId）：每个人各算一份工作记忆
 * @property {'message'|'reminder'|'idle'|'relay'} trigger
 * @property {ExpressionChannel[]} [egress]        这个会话本轮可能写到的渠道（§9.4.1）
 * @property {SettingId} [homeSettingId]
 * @property {string} [sessionId]                  【补】哪个会话在问；核心据此去掉本周期已发过的条目、读按轮污点
 * @property {string[]} [tools]                    【补，D124】她这一步正在用的工具名（最多 4 个）：「经验」那一层据此想起用这个工具的经验
 */
/**
 * @typedef {object} RecallOptions
 * @property {'involuntary'|'deliberate'} mode
 * @property {string} [query]
 * @property {string} [about]                      【补】memory_recall 工具的 about（关于谁 / 什么，§8.5）
 * @property {string} [time]                       【补】memory_recall 工具的 time（「上周」「10/31」）
 * @property {string} [where]                      【补，D154】memory_recall 工具的 where（「这个群」「私聊」、某个群的叫法）；原样往下传给 retrieve，读懂问题用
 * @property {boolean} [includeHistory]            【补】带上被取代的旧版本和同类的其他几次
 * @property {number} deadlineMs
 * @property {number} budgetChars
 * @property {AbortSignal} [signal]
 */
/** @typedef {'people'|'recentFromPresent'|'todaySoFar'|'gap'|'warmStart'|'recalled'|'awarePrivate'|'intentions'|'working'|'sinceHere'|'lessons'|'pointBack'|'recollect'|'outline'|'look'} Layer */
/**
 * 一条已过关口①的记忆（§9.3.6：每条都能对上一次判定）。omit 的不出现。
 * @typedef {object} RecallItem
 * @property {string} id                           记忆引用（核心内部格式，调用方只当不透明字符串）
 * @property {Layer} layer
 * @property {string} rendered                     已按目标场合渲染：时态、来源说法、含糊程度
 * @property {'share'|'share_vague'|'aware_private'|'pending'} verdict
 * @property {number} confidence
 * @property {string} provenance
 * @property {string} appraisalRef
 * @property {'free'|'careful'|'not-here'} [speak]  已弃用（D113）：以前是工作记忆条目说出口的档位（D101）。核心不再给出；集成层交回来的照样校验、不再记下
 * @property {string} [group]  工作记忆的条目：组号（同一段的一组（D110；以前是同一个来源场合），按展示顺序第一条是组长、带着场合和来源说明）。
 *                             集成层截字数时组长放不下整组不要，不能只留组员（D108 评审）；别的层没有
 * @property {'thread'|'talk'|'open'} [unit]  工作记忆的条目：所在的段是哪一种（D110：约定的一串 / 闲聊 / 开着的事）。只给注入日志和管理页用
 * @property {string} [unitKey]  工作记忆的条目：所在的段（'thread:<根的 id>'、'open:i<意图 id>' 这样的，不含场合键）。集成层原样交回 recordInjection
 * @property {string[]} [merged]  【D156】回忆里同一件事合并以后，这一条还代表了哪几条（记忆引用，≤ 10）；本周期给过其中哪条，这一条也算给过
 */
/**
 * @typedef {object} RecallLayers
 * @property {RecallItem[]} items
 * @property {0|1|2|3|4} degradeLevel
 * @property {string} traceId
 * @property {number} [alreadySent]   有意回想：有关、过了关口①、但本周期已经给过她的条数（她上下文里已经有了，D95）；没有就不带
 * @property {{kind: 'open'|'when', ref?: string, note?: string, reason?: 'bad-ref'|'not-found'|'withheld'|'bad-time'|'nothing'|'unavailable'|'error'}} [look]
 *                                    【D156】翻看（memory_look）的结果说明：note 是说明那一行（展开了哪条、一共几句省了几句 / 看的是哪段时间、有几段经历；
 *                                    不含记忆内容）；reason 是什么都没给出来的原因（集成层说成人话）
 * @property {{note: string, log: object}} [recollect]   【D155】这一轮是回忆（有意回想走了新路）：note 是「找了哪儿」那一行（集成层放在回忆那一节的开头，
 *                                    不含记忆内容）；log 是意图和范围的摘要（只有条数、来源、时间窗，集成层原样交回注入记录的 recollect）
 */
/**
 * 【D156】翻看（memory_look）的选项：open（回忆结果里的记号，比如 e840）和 when（一段时间，交给语言层解析）给其一，都给时先 open；
 * where、about 只跟 when 一起用。
 * @typedef {object} LookOptions
 * @property {string} [open]
 * @property {string} [when]
 * @property {string} [where]
 * @property {string} [about]
 * @property {number} deadlineMs
 * @property {number} [budgetChars]
 * @property {AbortSignal} [signal]
 */
/**
 * @typedef {object} ResidentBlock
 * @property {string} text
 * @property {string} version
 * @property {string[]} itemIds
 */

/**
 * @typedef {object} NoteRequest
 * @property {ObsId} triggerObsId
 * @property {ObsId[]} [triggerObsIds]   【补，D114】这一轮她看到的、别人对她说的其他几条（最多 8 条）：核心按库里的时间从新到旧，取第一条
 *                                       含有 evidenceQuote、还没做过操作的当触发消息（读消息工具的结果里来的消息也算她看到了）
 * @property {ActorRef} speaker
 * @property {'remember'|'todo'} op
 * @property {string} text
 * @property {string} [about]
 * @property {string} [when]
 * @property {string} evidenceQuote
 */
/**
 * @typedef {object} FixRequest
 * @property {ObsId} triggerObsId
 * @property {ObsId[]} [triggerObsIds]   【补，D114】同 NoteRequest.triggerObsIds
 * @property {ActorRef} speaker
 * @property {'forget'|'correct'|'confirm'} op
 * @property {string} target
 * @property {string} [newText]
 * @property {string} evidenceQuote
 */
/**
 * 工具类请求的结果。status：done 已生效 / review 进了审核队列 / rejected 不执行（reason 说明）。
 * @typedef {object} ToolResult
 * @property {'done'|'review'|'rejected'} status
 * @property {string} [reason]
 * @property {string[]} [refs]
 * @property {ObsId} [triggerObsId]   【补，D114】done / review 时：实际当作触发消息的那一条（调用方据此记「这条已经做过操作」）
 * @property {string[]} [candidates]  【补，D114】target-ambiguous / target-unsure 且触发者是主人时：像的那几条记忆的开头（给她问清是哪一条）
 */
/** @typedef {ToolResult} NoteResult */
/** @typedef {ToolResult} FixResult */

/**
 * @typedef {object} ImportRecord
 * @property {string[]} subjects
 * @property {string} text
 * @property {{speaker?: string, at?: number, settingLabel?: string}} sourceMeta
 * @property {{restriction?: 'none'|'soft'|'strict', scope?: unknown}} [norm]
 */
/**
 * @typedef {object} ImportReport
 * @property {number} accepted
 * @property {number} skipped
 * @property {{index: number, reason: string}[]} errors
 */

/**
 * @typedef {object} Page
 * @property {object[]} items
 * @property {string} [next]
 * @property {number} [total]
 */
/**
 * @typedef {object} SimResult
 * @property {RecallItem[]} items
 * @property {{id: string, stage: 1|2, rule?: string, verdict: string, reason?: string}[]} decisions
 * @property {number} degradeLevel
 */
/**
 * @typedef {object} ReviewItem
 * @property {number} id
 * @property {string} kind
 * @property {string} reason
 * @property {'pending'|'approved'|'rejected'|'expired'|'withdrawn'} status
 *           withdrawn：等着的时候问题自己没了（比如两份档案已经由权利层的证据自动合并），不再需要主人决定
 * @property {number} createdAt
 * @property {object} payload
 * @property {number|null} [expiresAt]
 * @property {number|null} [decidedAt]
 * @property {string|null} [decidedBy]
 */
/**
 * 管理接口（§4.5 的 AdminApi，加上管理页要用的几组【补】）。只给主人（§13.1），授权由集成层负责。
 * @typedef {object} AdminApi
 * @property {(q: object) => Page} list
 * @property {(id: string) => object} get
 * @property {(s: {settingId: SettingId, as: ActorRef, text: string}) => Promise<SimResult>} simulate   异步（D22）
 * @property {{list: () => ReviewItem[], decide: (id: number|string, d: 'approve'|'reject') => Promise<void>}} review
 *           decide 的 id 是 ReviewItem.id（整数），也接受十进制数字字符串（D23）
 * @property {(principalOnly: boolean) => number} pendingCount
 * @property {(q?: {maxStars?: number, recallDays?: number}|{since: {inj: number, trace: number, told: number}}|{peek: string[]}) => object} starmap
 *           【D163】记忆星图（只读）：快照 / 实时增量 / 看一眼，返回的形状见 admin/index.js 的 starmap
 */

/**
 * @typedef {object} JobBudget
 * @property {number} [maxJobs]
 * @property {number} [maxMs]
 * @property {string[]} [kinds]                    只跑这几类任务（默认全部）
 * @property {AbortSignal} [signal]
 */
/**
 * @typedef {object} SleepReport
 * @property {number} startedAt
 * @property {number} finishedAt
 * @property {{step: number, name: string, ok: boolean, llmCalls: number, skipped?: string, capped?: boolean}[]} steps
 * @property {number} [llmCalls]                   这一晚调了几次模型
 * @property {number} [llmMax]                     【D138】这一晚的总上限（sleep.maxLlmCalls，null = 各步之和）
 * @property {string[]} [capped]                   【D138】因为调用上限少做了的步（整步或其中一段）
 */
