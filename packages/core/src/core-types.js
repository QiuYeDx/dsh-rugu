// 核心内部、跨模块传递的类型（只有 JSDoc）。对外的契约类型在 contract/types.js。
// 一个类型在这里出现，说明至少两个模块要用它：改字段之前先看 docs/实现/模块与接口.md 里谁在用。
export {};

/**
 * 每个模块函数的第一个参数。api.js 在 createPersonaMemory 里组装。
 * state 按模块分：每个模块只读写 state.<自己的名字>（在自己的 init 里建）。
 * @typedef {object} CoreContext
 * @property {import('./store/db.js').Store} store                 主库（单写者）
 * @property {import('./store/db.js').Store|null} vectors          向量缓存库（只读模式下为 null）
 * @property {ReturnType<typeof import('./ports/index.js').normalizePorts>} ports
 * @property {import('./config/defaults.js').ConfigHandle} config  每次用都 config.get()，别缓存
 * @property {import('./store/keys.js').Keyring} keys
 * @property {string} [keyFile]                                    身份哈希密钥文件（opt.keyFile ?? <dataDir>/persona-memory.key）；
 *                                                                 backup 打包和恢复时读写它。没有时按默认位置
 * @property {Map<string, import('./contract/types.js').PerceptionAdapter>} adapters   已注册的适配器（api.js 维护）
 * @property {string} dataDir
 * @property {boolean} readOnly                                    库比代码新、或以只读方式打开（§12.5）
 * @property {Record<string, any>} state
 * @property {import('./ports/index.js').Logger} log
 * @property {() => number} now
 * @property {Map<string, import('./maintenance.js').JobHandler>} jobHandlers   任务种类 → 处理函数（模块在 init 里登记，如 'extract'）
 * @property {Modules} mods      全部业务模块。模块之间互相调用一律 core.mods.<模块>.<函数>(core, …)，不 static import
 *                               （单测里用 test/fakes/test-core.js 换掉依赖）
 * @property {(swap: (files: {main: string, vectors: string}) => Promise<void>) => Promise<void>} reopen
 *           关库 → 执行 swap（换文件）→ 重新打开、迁移、各模块重新 init。只给 backup 的整体恢复用
 */

/**
 * @typedef {object} Modules
 * @property {typeof import('./lang/index.js')} lang
 * @property {typeof import('./admin/index.js')} admin
 * @property {typeof import('./intake/index.js')} intake
 * @property {typeof import('./entities/index.js')} entities
 * @property {typeof import('./dynamics/index.js')} dynamics
 * @property {typeof import('./discretion/index.js')} discretion
 * @property {typeof import('./encode/index.js')} encode
 * @property {typeof import('./worker/index.js')} worker
 * @property {typeof import('./retrieve/index.js')} retrieve
 * @property {typeof import('./context/index.js')} context
 * @property {typeof import('./consolidate/index.js')} consolidate
 * @property {typeof import('./backup/index.js')} backup
 */

/** @typedef {import('./store/refs.js').MemoryRef} MemoryRef */
/** @typedef {string} RefString  refOf() 的结果，如 'a123' */
/** @typedef {string} SettingKey HMAC(adapter, SettingId)，settings.key */

/**
 * 场合的当前状态（intake.settingByKey）。
 * @typedef {object} SettingRecord
 * @property {SettingKey} key
 * @property {string} adapter
 * @property {string} label                     生效的称呼：主人起的名字，没有就是适配器给的（D111）
 * @property {'name'|'description'} [labelKind] 【D111】label 是真名还是一句说法（主人起的一定是真名）
 * @property {'owner'|'adapter'} [labelSource]  【D111】label 从哪来
 * @property {'config'|'platform'|null} [labelOrigin] 【D111 评审】适配器给的真名从哪来（配置里写的 / 平台上的）；说法是 null
 * @property {string} [adapterLabel]            【D111】适配器最近一次给的称呼
 * @property {string|null} [ownerLabel]         【D111】主人起的名字
 * @property {string|null} [hint]               【D111】只给管理页的区分提示，不进提示词
 * @property {'persistent'|'transient'} stability
 * @property {SettingKey|null} parentKey
 * @property {number|null} entityId
 * @property {number|null} snapshotId
 * @property {import('./contract/types.js').SettingDescriptor|null} descriptor   当前快照里的描述（账号 id 已哈希）
 * @property {0|1|2|3} exposureRank
 * @property {0|1|2} persistenceRank
 * @property {string} reachHash
 * @property {boolean} [attending]               【阶段 B】false = 她不在这个房间里（之后的感知丢弃）
 * @property {number|null} [checkpointPercept]   【阶段 B】sealBuffers 记下的检查点（感知 id）
 * @property {number} [firstSeen]                【阶段 B】
 * @property {number} [lastSeen]                 【阶段 B】
 */

/**
 * 认出的说话人（entities.resolveActor）。
 * @typedef {object} ResolvedActor
 * @property {number|null} entityId
 * @property {boolean} isSelf
 * @property {boolean} isPrincipal       authority = principal
 * @property {'identity'|'scoped-name'|'principal-claim'|'self'|'mention-self'|'mention-authority'|'none'} via
 */

/**
 * 回想时的线索（retrieve.buildCues，§8.1）。
 * @typedef {object} Cues
 * @property {SettingKey} settingKey
 * @property {number|null} focusPerceptId
 * @property {number} latestPerceptId    预取缓存键的一半
 * @property {{perceptId: number, speaker: number|null, at: number, text: string}[]} window
 * @property {number[]} present          有共同在场证据的实体（含她自己）
 * @property {number[]} mentioned        只是线索，不算在场
 * @property {{entityId: number, name: string, score: number, focus?: boolean}[]} names   focus：出现在焦点那一句或有意回想的 query 里（D149）
 * @property {import('./ports/index.js').TimeWindow[]} timeWindows
 * @property {string[]} queryTexts       1–2 条：窗口一条，最新对她说的那句一条
 * @property {string} lang
 * @property {boolean} pastQuestion      看起来在问过去（§6.6）
 * @property {string} hash               线索为空或和上次相同就跳过（§8.1）
 * 【阶段 B】retrieve 内部另带的字段（别的模块不要依赖）：
 * @property {string|null} [directedText]   最新一条直接对她说的话
 * @property {number|null} [focusSpeaker]
 * @property {number[]} [aboutEntityIds]    memory_recall 的 about 认出的实体
 * @property {string} [windowText]          「名字：文字」的窗口
 * @property {string} [windowPlain]         不带名字的窗口（词法路用：说话人的名字不是话题）
 * @property {string[]} [rewrites]          预取时的指代改写（有意回想复用）
 */

/**
 * 召回的一条候选（还没过关口①）。
 * @typedef {object} Candidate
 * @property {RefString} ref
 * @property {MemoryRef} mref
 * @property {Record<'dense'|'lexical'|'entity'|'time'|'present', number>} ranks   各路名次（没命中的路不出现）
 * @property {number} rrf
 * @property {{dense?: number, bm25?: number, ppr?: number, timeHit?: number, contextSim?: number, rerank?: number, rerankRank?: number}} signals
 *           rerank：重排分（归一化到 0–1）；rerankRank：重排名次（调参前按它给 C 的名次分，§8.3 第 4 步）
 * 【阶段 B】可选字段（retrieve 填，context / discretion 读；每条照样单独过关口①）：
 * @property {RefString} [previousRef]   最近被取代的旧版本（渲染成「之前……，后来……」）
 * @property {RefString} [versionOf]     自己是哪条的旧版本
 * @property {{group: RefString, index: number, count: number, latest: boolean, ambiguous: boolean}} [occurrence]
 *           同类事的第几次；ambiguous = 几次时间接近，「可能指多次」（§8.3 第 6 步）
 * @property {RefString} [outcomeOf]     计划的结果，跟着那条计划走
 * @property {{rel: 'maybe_same', confidence: number}} [belief]   关于的人只是「可能是同一个人」：渲染带「好像」，置信度封顶
 * @property {boolean} [fok]             知道感：只说想不起细节（§6.6）
 * @property {{from: number, to: number, settingKey: string, here: boolean}} [blank]
 *           和 fok 一起出现：有意回想碰到整体恢复后没补回来的那段时间（§12.4.5 第 8 步）；渲染只写那几天「记不太清」，排在最前
 * @property {RefString} [attachedTo]    顺着链接带出来的，跟着哪条走
 * @property {RefString[]} [duplicates]  【补】MMR 合并进这一条的、几乎一样的文字（同一种记忆、同一批场合；不另占名额，不另过关口①）
 */
/**
 * 打完激活分的候选（dynamics.activate）。
 * @typedef {Candidate & {A: number, P: number, parts: {B: number, S: number, C: number, I: number, Psup: number, eps: number}}} ScoredCandidate
 */
/**
 * retrieve.recall 的结果（未过关口①）。
 * @typedef {object} CandidateSet
 * @property {ScoredCandidate[]} items
 * @property {Cues} cues
 * @property {0|1|2|3|4} degradeLevel
 * @property {Record<string, number>} routeMs
 * @property {string} traceId
 */

/**
 * 一条记忆的流动规范（discretion.normOf）。没写过规范的是 unassessed，按最严处理（§5.6）。
 * @typedef {object} Norm
 * @property {boolean} unassessed
 * @property {number} version
 * @property {{exposureRank: number, persistenceRank: number, visibleTo?: string, settingKey?: SettingKey}} originExposure
 * @property {SettingKey|null} settingRuleRef
 * @property {number|null} settingRuleVersion
 * @property {'none'|'soft'|'strict'} restriction
 * @property {number[]|null} allow       只能告诉谁
 * @property {number[]|null} deny        不能让谁知道
 * @property {string|null} restrictionQuote
 * @property {string|null} attribute
 * @property {number|null} sensitivity
 * @property {boolean} involvesOthers
 * @property {boolean} identityLink
 * @property {string|null} summary
 */
/**
 * 写规范时给的内容（discretion.writeNorm）。没给的字段按「来源场合 + 无限制」补。
 * @typedef {Partial<Omit<Norm, 'unassessed'|'version'>> & {reason?: string}} NormInput
 */

/**
 * 目标场合的知情圈（discretion.audienceOf，§9.3.1）。
 * @typedef {object} Audience
 * @property {SettingKey} settingKey
 * @property {number|null} snapshotId
 * @property {number[]|null} members     能列全时的成员（实体 id）；否则 null
 * @property {number[]} recentSpeakers
 * @property {'exact'|'recent-speakers'|'unknown'} completeness
 * @property {boolean} unknownObservers
 * @property {0|1|2|3} exposureRank
 * @property {0|1|2} persistenceRank
 * @property {number|'unbounded'|'unknown'} size
 * @property {boolean} preSendGate
 * @property {boolean} canHold
 * 【阶段 B】audienceOf 另外给的字段（不认识的场合按最公开、最不确定填，fail closed）：
 * @property {boolean} [known]            有这个场合的描述
 * @property {boolean} [publicLike]       任何人可见或公开留存（contract.isPublicLike）
 * @property {boolean} [oneOnOne]
 * @property {'participants'|'members'|'anyone'} [visibleTo]
 * @property {'ephemeral'|'logged'|'public-permanent'} [persistence]
 * @property {boolean} [attributedToHer]
 * @property {boolean} [herModerates]
 * @property {string} [label]
 * @property {string|null} [adapter]
 * @property {SettingKey|null} [parentKey]
 */
/**
 * 一条记忆的已知圈（discretion.knownCircle，§5.6）。claimed 只进卡片，不参与计算。
 * @typedef {object} KnownCircle
 * @property {Set<number>} entities
 * @property {{settingKey: SettingKey, since: number}[]} settings
 * @property {number[]} presenceSets
 * @property {boolean} selfOnly          只有她自己知道（心里想的、推断的、私下读到的）
 * @property {boolean} publicAvailable   公开可得（不算已知，§9.3.1）
 * @property {{claimant: number|null, who: number|null}[]} claimed
 */
/**
 * 关口①要判定的「目标」。
 * @typedef {object} DisclosureTarget
 * @property {Audience} audience
 * @property {SettingKey} homeSettingKey
 * @property {string|null} sessionId
 * @property {number|null} triggerEntityId
 * @property {boolean} taint             按轮污点（§9.6）
 * @property {'involuntary'|'deliberate'} mode
 * @property {Audience[]} [batchTargets] 批量提示词：全部目标的并集按这里算（§9.4.1 第 4 条）
 */
/**
 * 第一段的结论（discretion.stage1）。
 * @typedef {object} Stage1Decision
 * @property {'pass'|'block'|'cap'|'stage2'} decision   pass 放行 / block 不提 / cap 封顶（最多给到 cap 的结论，仍可能进第二段）/ stage2 交给第二段
 * @property {string} rule               A1 / A2 / A3 / B1 … B5 / T1 / T2 / unassessed / self-only / late-member / stage2，
 *                                       【阶段 B】还有 suppressed（隐藏、忘掉、删了）、missing（记忆不在了）、error（判不了，按 block）
 * @property {'share'|'share_vague'|'aware_private'|'omit'} [cap]
 * @property {string[]} [notes]          【阶段 B】给第二段卡片的提示代码（own-guess、manager、deny-relation、late-member……），不含内容
 */
/**
 * 过完关口①的一条（discretion.gate）。omit 的不返回。
 * @typedef {object} GatedItem
 * @property {RefString} ref
 * @property {'share'|'share_vague'|'aware_private'|'pending'} verdict
 * @property {string|null} vagueText     share_vague 时由第二段写好
 * @property {boolean} hintOk            aware_private 时能不能暗示自己知道
 * @property {string} appraisalRef       appraisals 表的行（'ap<id>'）；context.recordInjection 核对它对得上同一条记忆、同一个结论（§9.3.6）
 * @property {1|2} stage
 * @property {string} rule
 * @property {boolean} [hintSpecific]    【阶段 B】aware_private：只有主体本人或当初告诉她的人在场时为 true，
 *                                       暗示才可以点出主体或「是私下说的」；默认只给不点名的提示（§9.3.4）
 * @property {{at: number, level: 'full'|'vague'}} [told]   【阶段 B】她已经跟这个受众讲过（told_log，S14）：别当新鲜事讲
 * @property {boolean} [cached]          【阶段 B】结论来自第二段的缓存
 * @property {'free'|'careful'|'not-here'} [speak]   已弃用（D113）：以前是工作记忆的说出口档位，admitWorking 不再给出
 * @property {object} [label]            工作记忆（discretion.admitWorking，D113）：来源标签的事实（origin / place / at / tellerId / limit / ownerVague /
 *                                       mentions / selfOnly / hearsay / open），context 据此拼段头和行尾的标签；
 *                                       关口①在非公开目标上原文放进来的（gate 的 open 分支）：{limit, open: true, rule}，retrieve.render 据此
 *                                       把说不出名字的别处来源按结构写（私聊时 / 在另一个群里）、在后面写核对过原话的叮嘱
 */
