// 参数表（§6.9）和散在设计各处的默认值。全部可配置、热加载。
// 数值都是【建议】默认值，不是文献结论；beta 用诊断区的数据回放拟合后再改（§6.9 末尾、§15.4）。
// 规矩：
//   - 模块每次用参数都从 core.config.get() 取当前快照，不要在模块加载时缓存数值（否则热加载不生效）。
//   - 快照是深冻结的；改配置只能经 createConfig().update()。
//   - 用户配置里的未知键、类型不对的值会被忽略并给出 warning，绝不因为配置写错而让核心起不来。
//   - 「只能由主人在管理页改」的项（保留期、成长方式、预算……）在这里只是默认值；聊天和工具改不了它们，
//     这条由 admin / 集成层保证（§9.6），不由配置层保证。

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIN = 60_000;

export const DEFAULTS = deepFreeze({
  // ── 总开关（§10.1、§15.2）：只有 off / live 两档；按场合属性给默认档，管理页可以按场合覆盖（rules.kind='mode'）。
  // 每类场合默认都是 live：她在哪儿都记得、都会想起来；一件事在这里说不说、说多细，由关口①（第一段、第二段）和关口②逐条判断，
  // 不按场合一刀切（用户反馈第 6 轮：不要「影子模式」这种过渡档，测的就是最终效果）。off = 主人把这里的记忆关掉（不感知、不注入）。
  mode: {
    global: 'live',                      // 总开关；生效档 = min(global, 场合覆盖 ?? 按属性的默认档)
    byAttributes: {
      principalOneOnOne: 'live',         // 和有管理权限的人一对一
      closed: 'live',                    // 封闭的小群、大群
      public: 'live',                    // 任何人可见、公开留存（评论区之类）
    },
  },

  // ── §3.3 语言分析器
  lang: {
    detectMinScore: 0.2,                 // detect 的得分低于它 → 'und'
    distinctiveMinIdf: 5,                // 「高 IDF」的门槛（污点检查 §7.3、外发初筛 §9.4.2、告诉过谁 §5.6）；按 worker.termStats 的 BM25 idf 算
    time: { fuzzyPastDays: 30, recentDays: 7 },   // 「那天、上次、前阵子」往回看多久；「最近、前几天」
  },

  // ── §6.2–§6.5 激活 ────────────────────────────────────────────────────
  activation: {
    a: 0.30, c: 0.30, dMax: 1.0,         // d_j = a + c·e^min(m, 3)，上限 dMax（§6.3）
    exactTraces: 8,                      // K：每个记忆单元保留的精确痕迹数
    ageFloorMin: 3,                      // age 下限（分钟）
    timeUnitMs: HOUR,                    // B_i 的时间单位：小时
    s: 0.4,                              // P = σ((A − τ)/s)
    tauInvoluntary: 0.0,
    tauDeliberate: -1.6,
    noise: true,                         // ε：logistic 噪声，种子 = hash(场合, 最新一条感知, 模式, 记忆)，可复现（D33：预取没有会话）
    attention: {                         // w_att（§6.2）
      self: 1.0,                         // by-her，或 self-utterance / self-action
      toHer: 1.0,
      mentionsHer: 0.9,
      participating: 0.8,                // attended + ambient，且她最近 participatingWindowMin 分钟在这个场合说过话
      attendedAmbient: 0.6,
      peripheral: 0.35,                  // 在场旁听（没被叫醒）
      contentSkimmed: 0.15,              // content，只在信息流里扫过
      contentOpened: 0.6,                // content，点开看了
      selfThought: 0.5,
    },
    participatingWindowMin: 10,
    selfRelevance: { min: 1.0, max: 2.0, social: 1.2 },   // w_self；社交信息从 1.2 起
    salience: { pivot: 5, scale: 2.5 },  // w_sal = 2^((imp − pivot)/scale)，imp 1–10
    relation: { base: 0.8, span: 0.7 },  // w_rel = base + span × closeness
    emotion: { span: 0.5 },              // w_emo = 1 + span × 强度
    defaultImp: 5,                       // 入库时还不知道重要度
    hearsayConfidenceCap: 0.6,           // 听说只影响可信度，不影响记忆强度（评审:UV-01）
    fanSMax: 1.5,                        // 扇出项 S_max − ln(fan)
    supersededPenalty: 0.8,              // P_sup
    events: {                            // §6.4 各种「又遇到了一次」的系数
      confirm: 1.2,
      askedAndRecalled: 0.6,
      retellNewAudience: 0.3,            // 讲给新听众：每个听众一次
      retellMaxPerUnit: 5,
      replay: 0.2,                       // 夜间重放
      replayWithinDays: 30,
      replayMaxPerUnit: 3,
    },
    sourceWindow: { sameMemoryH: 6, sameSourcePerDay: 1 },   // 防刷屏、防慢性灌输（v1:623）
    tiers: { hotMinB: 0.0, warmMinB: -2.5 },                 // 夜间按 B 分热 / 温 / 冷（§6.8）【本实现的初值】
    untracedWeight: null,                // 没有痕迹行的单元（导入的、迁移来的）按来源时间算一次这么强的编码；null = attention.peripheral
    retierBatch: 500,                    // §6.8 分层每批多少个（可续跑）
  },

  // ── §5.4 有效性（现在还成不成立）
  validity: {
    presentAbove: 0.7,                   // p_hold > 0.7 用现在时
    pastBelow: 0.3,                      // < 0.3 用过去时；中间带不确定
    changeKnownFactor: 0.3,              // 「据说已变」的下调系数
  },

  // ── §5.5 意图
  intention: {
    boost: 1.0, cueBoost: 0.5,           // 未完成 +1.0，线索命中再 +0.5
    suppression: -0.6, suppressionTauH: 12,   // 完成 / 取消 / 错过后的短暂抑制
    cooldownH: 48,                       // 对同一个人问过以后的冷却（不管在哪个场合）；主人要她做的事（origin='principal-request'）不受它限制（D103）
    maxPerPersonPerDay: 4,
    maxPerBlock: 1,
    preTriggerRecheck: true,             // 触发前先复核有没有完成证据（评审:SC-08）
    lapseW: 0.3,                         // 第 11 条：没问成写的那段情节的编码强度
    // 第 6 条触发前复核：向量命中的余弦、词法命中至少几个共同的词、每一路最多等多久、
    // 对象本人还没提炼的旁听发言多近才算「可能完成了」【均未校准，§14.4】
    recheckCos: 0.6, recheckMinTerms: 2, recheckDeadlineMs: 1500, recheckOverheardH: 12,
    // 过了时间窗（window_end）的意图不再过滤掉，按超时的多少平滑减分：overdueWeight × log1p(超时 / 窗口长度)，
    // 渲染成「本来打算……，已经过了时间」（D103：没有硬到期，淡忘是渐进的）
    overdueWeight: 0.5,
    // 什么时候「放下」（lapsed）：过了时间窗、这件事最活跃的那条痕迹的 B（意图本身、来源原话、主人要她做的事还看他最近一次对她说的话）
    // 减去超时的减分，低于它才放下。活跃度阈值，不是到期时间：他一直在跟她说话就淡得慢（D103）【未校准，§14.4】
    lapseBelowA: -3,
  },

  // ── §5.7 心境、今天到目前为止、自我概念
  mood: {
    halfLifeH: 3,
    floor: 0.05,                         // 衰减后的强度低于它 = 没什么特别的心情
    horizonHalfLives: 12,                // 往回读几个半衰期的心境冲量
    maxCauses: 3,                        // currentMood 返回的原因条数
  },
  today: {
    idleMin: 10,                         // 对话空闲 10 分钟后生成一句话小结
    summaryChars: 80,
    maxPercepts: 80,                     // 一次小结最多读多少条感知（取最新的，加上她最后一次参与前后的一段）
    lookbackH: 24,
    minPercepts: 2,
    renormWithinH: 48,                   // 证据后来才评估完：这段时间内的小结重算规范
  },

  // ── §7.1 感知入库
  intake: {
    rawWindow: { minMsgs: 5, maxMsgs: 8, maxChars: 400, overlap: 2, idleMs: 2 * MIN },
    longTokenChars: 32,                  // ≥ 32 位的 hex / base64 串当成令牌删掉
    prefetchDebounceMs: 2000,            // 对她说的消息：按场合防抖 2 秒做完整召回
    describeTimeoutMs: 10_000,           // drain 向适配器要场合描述最多等多久
    describeRetryMs: MIN,                // 要描述失败后，隔多久再要
    batchMaxAttempts: 3,                 // 存储出错时一批最多重试几次（§12.8 第 1 条：在事务边界上重试）
    relayLookbackMs: 10 * MIN,           // expectRelay：转进来的副本比预告先到，往回找多久
    relayKeepMs: DAY,                    // 过期的转达预告留多久
    expireBatch: 500,                    // expireRawText 没给 limit 时每批多少行
    presenceScanMax: 500,                // 出现集合、最近说话人往回扫多少条
    maxQueuedBatches: 5000,              // 每个适配器内存里最多排多少批（observe 永不阻塞，存储坏了也不无限涨）
    drainBudgetMs: 50,                   // drain 每次最多占用主线程多久，做不完让出事件循环（§8.8）
    restorePollMs: 1000,                 // 整体恢复期间 drain 不写（§12.4.5 第 2 步、D27），隔这么久再看一次恢复结束了没有
    // 她看过的媒体（D116）：宿主交来她看完之后的想法和回话，一次纯文字调用（use='perceive'）摘出她看到了什么，写进那条消息的 media_json。
    // maxChars：存下的说明最多几个字；inputChars：交给模型的想法最多几个字（回话一半）；失败、超时、预算不允许都只是这次不写
    mediaSeen: { enabled: true, maxChars: 80, inputChars: 1500, timeoutMs: 8000, maxTokens: 200 },
  },

  // ── §7.2 情节切分
  segment: {
    gapMin: 20,
    maxMsgs: 25,
    maxChars: 4000,
    llmBoundaryConfidence: 0.7,
    chunk: { minChars: 200, maxChars: 400 },   // 超过 400 字的情节按 200–400 字带重叠切块
    freshnessHalfLifeH: 24,              // 提炼优先级 w_att × w_rel × 新鲜度 里新鲜度的半衰期
    driftCos: 0.5,                       // 相邻原文窗口向量的余弦低于它 = 可能的话题边界
    minMsgs: 3,                          // 拿不准的边界（漂移、换人）至少攒够这么多条才切
    participantWindow: 5,                // 参与者大换：前后各比多少条
    participantJaccardMax: 0.2,          // 前后说话人集合的 Jaccard ≤ 它 = 可能的边界
    scanLimit: 2000,                     // 每个场合每次最多扫多少条缓冲（§12.8 第 2 条）
  },

  // ── §7.3–§7.5 提炼、核验、对账
  extract: {
    temperature: 0.2,
    timeoutMs: 60_000,
    minSpacingMs: 5000,                  // 两次调用至少隔 5 秒
    concurrency: 1,
    factTextMax: 120,
    quoteMax: 60,
    futureQMax: 3,
    miniCardChars: 120,
    quota: { base: 10, closenessFactor: 4, hearsayShare: 0.5 },   // 每人每天 10 × (1 + 4 × closeness)，听说占一半
    reservedOneOnOne: true,              // 对她说的一对一内容的提炼有预留，不因每日预算用完而停（§7.2）
    deferMs: 10 * MIN,                   // 预算不让跑时推迟多久（每次翻倍，最多 6 小时）
    // D136：重试次数用完的段搁置起来（不挡后面的段），按退避再试：第 n 轮隔 base × 2^(n−1)，最长 max。
    // 一时的（超时、连不上）隔得短；稳定被拒的（输出不合格、供应商拒绝这段内容）隔得长——再试多半还是一样，只是不永久放弃
    stalled: { transientMs: 30 * MIN, transientMaxMs: 12 * HOUR, rejectedMs: 6 * HOUR, rejectedMaxMs: 7 * DAY },
    maxBackground: 12,                   // 提示词里每组背景最多几条（§7.3）
    maxCandidates: 15,                   // §5.2 第 4 步的候选档案（照 Graphiti 最多 15 个）
    maxTokens: 4000,                     // 提炼输出的 token 上限
    // D141：端口没给停止原因时，最后一行不是一条完整的 JSONL、而且输出量到了上限的这个比例，就按「被上限截断」算（拆小重做）；
    // 输出远没到上限的坏行是模型自己写坏的，照旧只跳过那一行
    truncationNearRatio: 0.9,
    stableMinT50H: 24,                   // §7.4 第 5 条：偏好 / 身份 / 关系的 t50 短于它 → 改判为状态
    timeSanityDays: 400,                 // §7.4 第 5 条：时间离消息超过这么多天 → 标待复核
    // 模型没给 confidence 时按代码核定的 certainty 给（听说的取 activation.hearsayConfidenceCap）：照实记下的 > recall.render.sureAbove，
    // 能直接说（S1「拿了，那天晚上说拿到的」）；推断的落在「好像」那一档
    defaultConfidence: { stated: 0.9, confirmed: 0.9, self_said: 0.9, inferred: 0.5, other: 0.7 },
    // §7.4 第 14 条（D123）：只记以后的她不翻聊天记录也需要知道的。原话一直留着、随时搜得到，一时的事不另成事实。
    //   没挂着计划、意图、确认、叮嘱、伤害、op 引用、future_q、也不是还没发生的状态 / 事件：她自己说的 imp 低于 selfMinImp、别人的低于 minImp 的不成事实。
    //   她自己说的关于自己的断言（fact / identity / state）把握、重要度封顶；说自己能 / 不能做什么（ability）封得更低，等夜里核对（D122）。
    keep: {
      minImp: 3, selfMinImp: 5,
      selfClaimConfidenceMax: 0.6, selfClaimImpMax: 4,
      selfAbilityConfidenceMax: 0.4, selfAbilityImpMax: 3,
    },
  },
  reconcile: {                           // §7.5
    maxCandidates: 30,                   // 重复 / 矛盾候选（只是条数上限，不设分数门槛）
    dupCos: 0.92, midCos: 0.75,          // 相似度高 → 当重复看；落在中间 → 先新增、标待对账【未校准】
    dupJaccard: 0.85, midJaccard: 0.45,  // 没有向量时的词元 Jaccard 两档
    embedDeadlineMs: 2000,
  },
  review: {                              // §7.7 第 1 步：夜间复核标了「待复核 / 待对账」的事实
    maxItems: 40,                        // 每次 LLM 调用最多几条
    candidatesPerItem: 5,                // 每条带几条相关的旧事实
    poolPerItem: 60,                     // 候选从多少条里挑
    embedDeadlineMs: 5000,
    maxTokens: 2000,                     // 一次复核调用的输出上限（maxItems 条的结论）
  },
  predicates: { synonymCos: 0.95 },      // §5.4 属性键是数据：夜间按向量合并同义的属性键

  // ── §10.8 工具（note、fix）
  tools: {
    noteImp: 8,                          // 钉住的笔记的重要度（§6.2）
    textSupportMin: 0.6,                 // 第 2 条：text / new_text 的词至少这么大比例出现在触发消息里
    targetMinSim: 0.3,                   // memory_fix 自由文本找目标的最低相似度
    targetSureSim: 0.5,                  // 没照抄原话时，主人 / 当事人的 fix 要直接生效至少要这么像；不够就把那条给她问清楚（D114）
    searchDeadlineMs: 1500,
  },

  // ── 她自己的经验（D124）：做事学到的「规则 + 怎么知道它是对的 + 要避开的坑」，标验证过 / 还没验证。
  // 存成关于她自己的事实（kind_hint='lesson'），范围（工具、场合、人）是结构化字段，话题靠词和回想。
  lessons: {
    enabled: true,
    textMax: 120, trapMax: 60, howMax: 60, toolMax: 64,
    sameSim: 0.5,                        // 和已有的一条（同一个工具、同一个范围）这么像就并进那一条，不另记
    perDay: 12,                          // 她一天（本地日）最多新记几条（并进已有的不算；主人教的不受这个限制）
    proofMin: 30,                        // 这个工具这么多分钟内「先没成、换了做法后成了」：她这时记下的这个工具的经验算验证过（宿主看到的工具结果）
    recallMax: 2, itemChars: 110, chars: 220,   // 每轮「你的经验」最多几条、每条和一共多少字
    topicMin: 0.34,                      // 只靠话题对上时：经验正文的多字词（按全文检索的 IDF 加权）至少这么大比例出现在眼前这句里，而且至少两个词
    topicCommon: 0.02, topicCommonDocs: 5, topicHits: 3,   // 出现在这么大比例以上、而且至少这么多条原话里的词算到处都有的词：话题对上至少要有一个不是这种词（评审 M4）
    toolLog: { max: 300, errorChars: 40 },     // 工具没成 / 换了做法后成了的记录（只有工具名、出错类别——引号里的内容、网址、数字都去掉——、时间），留最近 max 条
    sessionTools: { max: 12, windowMin: 180 }, // 这个会话最近用过的工具（只在内存里）：用过的工具的经验算「眼前要用的」
    promote: { max: 3, minDays: 3, windowDays: 30 },   // 验证过、最近 windowDays 天里在 ≥ minDays 天被想起过的，最多 max 条放进常驻区
  },

  // ── §5.2 实体
  entities: {
    thetaHi: 0.85, thetaLo: 0.5,         // ≥ θ_hi 挂到已有档案；≤ θ_lo 新建；中间建临时档案 + maybe_same
    vectorCandidates: { minCos: 0.6, max: 15 },   // 起点参数照 Graphiti
    establishedDays: 2,                  // 在 ≥ 2 个不同的日子被独立提到
    independentDescriptors: { minSpeakers: 2, minDays: 2 },
    matcher: {                           // §8.1 名字匹配器：按作用域和激活加权（评审:SC-16）
      minChars: 2,                       // 少于 2 个字符的名字 / 关系不进匹配器（单字到处都是）
      relationGap: 2,                    // 「阿明的表哥」：锚点名字结束到关系开始之间最多隔几个字符
      scope: {                           // 名字证据的作用域权重
        cardHere: 1.0,                   // 群名片，正是这个场合的
        cardGlobal: 0.8,                 // 不限场合的显示名
        cardElsewhere: 0.4,              // 别的场合的群名片（只在那里算数）
        account: 0.85,                   // 账号昵称
        mentionHere: 0.95,               // 在这个场合里被这样叫过
        mention: 0.85,                   // 在别处被这样叫过
        fixed: 0.9,                      // 配置 / 主人 / 场合称呼
      },
      countBase: 0.6, countSlope: 0.1,   // 用得越多越可信：min(1, base + slope·ln(1 + count))
      activationBase: 0.5,               // 激活权重：base + (1 − base)·σ(B)
      relationNamed: 0.9,                // 关系词紧挨着一个认出来的名字（「阿明的表哥」）
      relationAnchor: 0.8,               // 关系词 + 调用方给的锚点（说话人：「我表哥」）
      selfClaimFactor: 0.7,              // 只是当事人自称的关系
    },
    scores: {                            // §5.2 五步的综合得分（和 θ_hi / θ_lo 比）
      relationStrong: 0.9,               // 关系路径唯一命中，且描述可靠（锚点本人说的、或多条独立描述吻合）
      relationWeak: 0.75,                // 关系路径唯一命中，但两边都只是旁人说的
      relationAmbiguous: 0.6,            // 同一锚点同一关系有好几个档案
      relationNameConflict: 0.35,        // 同关系，但名字对不上（阿明的两个表哥）
      selfClaimCap: 0.8,                 // 只靠当事人自称的描述，最多到 maybe_same
      name: 0.6,                         // 同名只算中等证据
      nameOtherScope: 0.55,              // 同名，但名字证据来自别的场合 / 群名片只在别处有效
      nameSameSpeaker: 0.25,             // 同一个说话人用同一个名字叫过他（加分）
      nameSameScope: 0.05,               // 名字证据来自同一个场合（加分）
      reservedOwnerName: 0.5,            // 只靠保留名对上：不建 maybe_same（保留名不把同名的人认成主人）
      descriptorMismatch: 0.1,           // 提及带关系描述，而同名的档案没有这层关系
      verdictWeight: 0.75,               // 第 5 步 LLM 同意时：1 − (1 − s)(1 − w·c)
      verdictNewPenalty: 0.5,            // 第 5 步 LLM 说「新建」时：s × (1 − p·c)
      attachMargin: 0.1,                 // 前两名都 ≥ θ_hi 时，要拉开这么多才挂
      candidateRelation: 0.8,            // candidates()：关系路径
      candidateName: 0.6,                // candidates()：名字表
      candidateMultiBonus: 0.1,          // candidates()：多路都命中，每多一路加
      anchorConflict: -0.5,              // 锚点冲突是负分（阿明的表哥 vs B 的表哥）
      anchorConfirmed: 0.95,             // 锚点本人当面确认：same，权利层
      mutualClaim: 0.95,                 // 双向自认：same，权利层
    },
    maxMaybeLinks: 3,                    // 一次提及最多挂几条 maybe_same
    candidateDeadlineMs: 3000,           // candidates() 的嵌入和稠密扫描最多等多久（后台）
    dictionary: { maxWords: 5000, minChars: 2, maxChars: 16 },   // jieba 用户词典（§8.2）
    mentionDaySetMax: 64,                // 「在几个不同的日子被提到」最多记多少个日子
    embed: { names: 8, descriptors: 5 }, // 档案嵌入文本里最多几个名字、几条关系描述（§2.2）
    linkEvidenceMax: 32,                 // 一条链接最多记多少条证据
    identityLinkSensitivity: 0.9,        // 身份对应链接本身的敏感度（§9.3.2 B3）
    sameSearchDepth: 4,                  // 信念层 / 权利层沿链接找的最大跳数
  },

  // ── §8 回想
  recall: {
    // 截止时间（D117 起放宽：主人「哪怕提高一些允许的等待时长」；11-06 实测 Ollama 查询嵌入 1290 次里 105 次 > 800 ms、40 次 > 3 s，
    // 多半是冷加载和换参数重载。不自主 800 → 1500 接住大部分慢的那一截，有意 3000 → 4000；都是上限，平常几十毫秒就回来）
    involuntary: { maxItems: 5, itemChars: 120, maxChars: 600, deadlineMs: 1500 },
    deliberate: { maxItems: 8, itemChars: 120, deadlineMs: 4000, toolDeadlineMs: 8000 },
    // 窗口：最近 6–10 条、≤ 400 字；往回取时遇到 ≥ maxGapH 小时的空白就停（隔了几周再说话，几周前的话题不算眼下的线索，S20b）
    window: { minMsgs: 6, maxMsgs: 10, maxChars: 400, maxGapH: 12 },
    presentSpeakerWindowMin: 30,         // 最近 30 分钟在本场合亲自发过言的人算在场（评审:PS-13）
    // §8.1 查询端指令：通用的一句；文档端不加，所以改它只作废查询缓存（§8.9）。空串 = 不加
    queryInstruct: 'Instruct: Given an ongoing conversation, retrieve related past experiences, people, facts and plans\nQuery:',
    maxQueryVectors: 4,                  // 窗口一条 + 最新对她说的一条 + 预取改写的线索（§8.1）
    rrfK: 60,
    fuseKeep: 200,
    poolFactor: 3,                       // 交给关口①的候选 = maxItems × poolFactor（有的会被判 omit）
    mmrLambda: 0.7,
    // MMR 里合并几乎一样的文字（同一种记忆、同一批场合，词元 Jaccard ≥ 它）：只留分高的一条，另一条跟在它后面不占名额（§8.3 第 5 步）
    mmrDupJaccard: 0.8,
    perEntityMax: 3,
    useRrfForC: true,                    // 调参前 C_i 用各路的 RRF 名次分代替（§6.5）
    cRankDepth: 50,                      // 名次分在这个深度降到 0
    routeReserveMs: 30,                  // 五路之后留给融合、激活、MMR 的时间
    linkDecay: 0.5,                      // 顺着链接带出来的（旧版本、计划的结果、同类的另一次）继承锚点 S / C 的比例
    weights: { dense: 1.0, bm25: 1.0, time: 0.5, context: 0.3, present: 0.5 },   // β_d、β_b、β_t、γ，加上在场者近况路
    contextSim: { sameSetting: 0.5, participants: 0.5 },   // γ 项：编码情境相似度的两部分（§6.5）
    dense: { memoryTopK: 100, rawTopK: 50, coarseTopK: 200 },
    lexical: {
      topK: 50, maxTerms: 12, commonRowFraction: 0.01, hotMonths: 3,
      commonMinDocs: 20,                 // 「常见词」还要求含它的行数超过这么多：刚装上、库里只有几十行时出现一次就过了 1%（S24、D72）
      fallback: { maxTerms: 6, limit: 20, hotMonths: 1 },   // worker 线程起不来时在主线程上查：更少的词、更少的行（§8.8）
    },
    entity: {
      seedFacts: 5,                      // 查询匹配到的前 5 条事实的实体也当种子（§8.2）
      maxHops: 2,                        // 局部 PPR 的邻域
      factWaitShare: 0.4,                // 实体路等词法前 5 条事实最多用掉剩余时间的这么多
      seedWeights: { name: 1.0, mentioned: 1.0, focus: 1.0, present: 0.5, fact: 0.5 },
    },
    ppr: {                               // §8.2 局部推送式 PPR（评审:FE-14）
      alpha: 0.5, eps: 1e-4, maxPushes: 20_000, maxExpand: 3000, fanCap: 200,
      fallbackScale: 0.25,               // 稠密路缺席时 PPR 分的折扣
      weights: {                         // 边的权重
        subject: 1.0, object: 0.8, mention: 0.5, speaker: 0.3, asserter: 0.3,   // 事实 ↔ 实体（assertion_entities.role）
        participant: 0.6,                // 情节 ↔ 参与者
        derived: 0.7,                    // 事实 ↔ 它来源感知所在的情节
        descriptor: 0.6,                 // 实体 ↔ 关系描述的锚点
        same: 1.0, maybeSame: 0.5,       // 实体链接（乘置信度）
        impression: 1.0, intention: 0.6, storyline: 0.6, community: 0.4,
        supersede: 0.6, sameType: 0.4, outcome: 0.8,
      },
    },
    time: { topK: 50 },
    // 在场者近况：相关度之外，这条记忆现在有多活跃（基础激活 B，对数尺度）占的分量（评审:SC-07、实测问题 #5）；
    // maxItems 也是召回结果里这一路自己的名额（不和别的几路抢不自主回想的那 15 条）
    // 没有「最近 N 小时」的时间窗（D103）：基础激活 B 低于 floorB 的不算近况（编码强度 1、衰减 0.3 时约 12 小时，强的记得更久、
    // 弱的更快淡出）；withHalfLifeMin：她在那边说话时这里的人在不在跟前，按 1/(1 + Δt/h) 渐弱，不是 ±30 分钟的二值
    present: { floorB: -0.75, withHalfLifeMin: 30, maxItems: 15, timeWeight: 1.0, poolFactor: 4 },
    // 工作记忆（§8.10，D100）：眼前这个人在别处亲口跟她说的话、她回他的话、他要她做还没了结的事，每一轮确定地在她心里，不抽样。
    // 没有任何时间窗：A = 基础激活 B + triggerBoost + cueWeight × 话题相似度 +（还开着的意图和它的来源行）openBoost，A < tau 的不进；
    // candidatePool 只是一次看多少行（按 id 倒序走索引），maxLines / budgetChars / lineChars 是软的上下文预算
    // budgetChars 按渲染好的字数算（含每组第一行的场合说明、careful / not-here 的来源说明），pack 不再另加余量
    working: {
      enabled: true, candidatePool: 300, maxLines: 12, budgetChars: 800, lineChars: 80, contextLines: 3,
      tau: -0.5, triggerBoost: 1.0, cueWeight: 1.0, openBoost: 1.0,
      // B1 豁免（D106）的「他就在这里提起了它」：和眼前这句话的话题相似度 ≥ 它。D113 起没有清晰度（gist）这一说，不再管别的
      onTopicMin: 0.35,
      replyScan: 8,                      // 找她回他的话：他每一行之后往后看几条（条数，不是时间）
      // 话题相似度：触发者这一句之外，再加他在这里最近的几句（条数上限）；那几句按激活加权 min(1, exp(B − B_焦点))（D110：一小时前的提醒带不偏话题）
      topicOwnLines: 3,
      contextShare: 0.25,                // 已弃用（D110）：读到了也忽略（选取改成按段装，见 thread / open）；留着只是不让旧的覆盖报未知字段
      absentSample: 30,                  // 已弃用（D113）：段头不再写「这里的人当时都不在 / 大多不在」；读到了也忽略
      mediaNoteChars: 40,                // 她看过的媒体的说明（D116）在工作记忆里最多显示几个字
      exchangeGapLines: 20,              // 同一场合这一层的两行之间别人插了不超过这么多条感知，算同一段一来一回（条数，不是时间；D108 / D110 的粗分）
      // 按段装（D110，全是软的条数，没有时间）：带「他最近一次跟你定的」那一段和最活跃的那一段，core 以外的成员最多装到 thread.maxLines 行，
      // 中间省掉的写「（中间又来回了 n 句）」；根之后她的前 acceptLines 句算 core。开着的事一件一行，最多 open.maxItems 件，多的写「还有 n 件」
      // admitLines：这两段一次最多判几句（准入有成本，新的先）。stepChars：退回的切法（第一眼 glance-2 没看完的）里，他一句话去掉叫她的那一处以后
      // 只剩这么几个字（报一个数、一两个字），就算照着前面定好的做的一步，不另起一段（评审：「@她 99」每一步都成了开头）。
      // sameTopic：他后来的一句没有自己的后续（没有照着做的一步、没改掉什么），只有和「他最近一次跟你定的」那一句的话题相似度到了它，
      // 才把这个标记拿走（评审：后来随口托她办的一件事、一件新的提醒不该让游戏丢了「最近一次定的」）。都是软的，没有时间
      thread: { maxLines: 7, acceptLines: 2, admitLines: 21, stepChars: 4, sameTopic: 0.3 },
      open: { maxItems: 3 },
      maxTriggers: 3,                    // 一批里有几个人都在对她说话：最多按几个触发者各算一份工作记忆（D108，预算主触发者优先）
      memoMax: 2000,                     // 进程内去重集合（提过的感知、记过的排除）的上限，满了清空
    },
    rerank: { topN: 30, budgetMs: 2000, minMs: 100 },   // 剩余时间不到 minMs 就不重排（L1）
    embedBreaker: { failures: 2, coolMs: 60_000 },   // 连续 2 次失败后 60 秒内不调嵌入（L3）
    deliberateMaxHops: 2,
    // 两次的间隔 < closeRatio × 最近那次距今 → 标「可能指多次」（§8.3 第 6 步）；有意回想带出同一类事的其他几次（§6.6）
    occurrence: { closeRatio: 2, maxSiblings: 5, deliberateSiblings: 3 },
    past: { simMin: 0.72, simWithCue: 0.5, cueMin: 0.5, lenientCueMin: 0.2, deadlineMs: 550 },   // §6.6「看起来在问过去」；L3 从宽
    render: { sureAbove: 0.8, hedgeAbove: 0.4, sourceVagueBelowP: 0.4 },   // §6.6 > 0.8 直接说、0.4–0.8「好像」；§5.3 激活低时来源说得含糊
    fok: { maxItems: 1, margin: 1.0 },   // §6.6 知道感：线索很强、A 只差 margin 没过 τ_del 的
    rewrite: { timeoutMs: 2000, maxCues: 3, maxTokens: 200 },   // §8.1 预取时改写指代，生成 1–3 条线索（use='rewrite'）
    background: { known: 12, private: 8, plans: 3 },   // §7.3 提炼背景两组的条数；plans：本段说话人还开着的计划最多几条（和召回带出的合计，S2b）
    prefetchCacheMax: 256,
    // 候选缓存（预取 / 上一次回想算好的那一份）最多沿用多久（D132）：过了就重新回想。这只是缓存的新鲜度，不是记忆的时间窗——
    // 原来只看「这个场合有没有新消息」，一个安静了一夜的私聊里她自己开口时，拿到的还是昨晚那一刻算好的候选
    prefetchTtlMin: 10,
  },

  // ── §9 分寸
  discretion: {
    stage2: {
      maxItemsPerCall: 8, windowMsgs: 10, perSettingPerHour: 20, timeoutMs: 8000, concurrency: 2,
      cardChars: 300, reasonChars: 120, vagueChars: 120,   // 卡片里的记忆、一句话理由、「说个大概」的长度
      deliberateMaxCalls: 2,             // 有意回想每轮最多几次第二段调用，再多的先给 pending（§9.3.5）
      neighborChars: 80,                 // 还没评估的感知带上的前后几条，每条多长（§5.6）
    },
    unassessedNeighbors: 3,              // 还没评估的感知带上同一场合前后各 3 条（§5.6）
    thresholds: {                        // §9.3.2，模型标的敏感度只用来收紧
      b2OmitSensitivity: 0.5,            // B2：≥ 0.5 直接不提
      b5Sensitivity: 0.7,                // B5：一对一面对陌生人，≥ 0.7 不提
      b5MaxCloseness: 0.3,
      a2MaxSensitivity: 0.6,             // A2：< 0.6
      a3MaxSensitivity: 0.3,             // A3：< 0.3
      lateMemberSensitivity: 0.5,        // A1(b) 晚到的成员：内容敏感度 ≥ 它才单独交给第二段
      // 还没评估的原话离开当时的受众：第二段替提炼报的敏感度 < 它才可以原样说，否则最多说个大概（D99，实测问题 #5）
      unassessedShareMaxSensitivity: 0.5,
      // 已评估的敏感事离开当时的受众、问的人不是说的人：敏感度 ≥ 它最多说个大概（D102；上限在调用第二段之前写在卡片上）
      notTellerShareMaxSensitivity: 0.5,
    },
    // 已弃用（D113）：工作记忆不再分说出口的三档（free / careful / not-here），读到了也忽略；留着只是不让旧的覆盖报未知字段
    knowing: { freeMaxSensitivity: 0.5 },
    derivedRelaxK: 5,                    // 派生内容放宽：证据至少来自 k 个主体、目标受众 > k（§5.6）
    cache: { strictTtlDays: 7, shareTtlH: 6 },   // shareTtlH 只对公开目标还有用（D113：非公开目标不调第二段）
    hint: {                              // 已弃用（D113）：只有公开路径还有暗示，非公开目标读到了也忽略
      maxDenialsPerAskerPerDay: 3,       // 逐个打听「谁有秘密」的限速【本实现的初值】
      maxNewKnowers: 5,                  // 新知情者多于这么多人 → aware_private 降为 omit（§9.3.4）
    },
    egress: {
      // D113「功能优先」：公开目标（publicLike）走原来的初筛 + 审视；其余目标只有两条外发守护（G1 核对过原话的叮嘱、G2 一对一里别人私下
      // 说的话），只认「几乎原样」的复述：共有 ≥ minOverlap 个区分性词，并且覆盖率 ≥ told.fullCoverage 或整句余弦 ≥ vectorSim
      maxRejectsPerSentence: 2,          // 同一句话被拒两次 → 最终拒绝（只在公开路径）
      relayMinTerms: 4,                  // G2：一对一里别人说的话至少有这么多个区分性词才算候选（「好～」「哈哈」不算）
      guardScan: 200,                    // 账本最多看几项（新注入的在前）；公开路径重跑第一段也到这里为止
      vectorWaitMs: 400,                 // 守护：字面上共有好几个区分性词、覆盖率还不够时，一次 embedQuery 最多等这么久；候选原话注入时已预热进查询缓存
      timeoutMs: 8000,
      publicHoldAllDays: 14,             // 上线头 14 天，能存草稿的公开渠道只要送审一律挂起（§17 Q2）
      holdExpiryDays: 14,
      minOverlap: 2,                     // 共有的区分性词 / 实体至少这么多才算命中（公开初筛、守护）
      vectorSim: 0.82,                   // 整句向量和记忆的相似度（公开初筛、守护）
      prescreenMs: 40,                   // 最多等 IDF 和整句向量这么久（等不到按 L3：有实体名就送审；守护等不到只剩数字和名字算区分性词）
      rejectWindowH: 24,                 // 「同一句话被拒两次」的时间窗（只在公开路径）
      reflectionChars: 80,               // 她的一句转念
      entityMemories: 40,                // 话里提到的实体：最多拿多少条关于它们的记忆来比（公开初筛）
      // 已弃用（D113）：同一场合工作记忆的分级（D107）整个删掉了，这些读到了也忽略；留着只是不让旧的覆盖报未知字段
      sameSetting: true, gistSim: 0.72, nearSim: 0.55, nearSimTainted: 0.45, nearMargin: 0.08, contrastLines: 6, glanceWaitMs: 2500,
      broughtUpMin: 0.35, encodedRunMin: 24, maxWatched: 24, ledgerMax: 200, tinyTerms: 3,
    },
    told: {                              // §5.6 告诉过谁、§9.5 关口③
      matchWindowMs: 10 * MIN,           // （场合、文本哈希、时间窗）对账
      minOverlap: 2,
      vectorSim: 0.8,
      scanMinCos: 0.85,                  // 全库比对的稠密门槛
      recentToolResults: 20,             // 拿最近多少条工具结果比
      scanLimit: 5,                      // 全库比对最多认几条
      scanMinTerms: 4,                   // 对不上的发言至少有这么多个词才排全库比对（IDF 在任务里查）
      fullCoverage: 0.6,                 // 「讲全了」：这句话讲到了记忆内容（不算名字）的这么大比例（§5.6「说得多细」，S14）
      scanMs: { idf: 500, vector: 2000, search: 1500 },   // 异步比对任务里查 IDF、取向量、全库检索各等多久
    },
    members: { refreshMs: 10 * MIN },    // adapter.members() 多久刷新一次（§9.3.1）
    // 第一眼（D106，use='glance'）：感知落库后按场合排队，没有在跑的就马上看，在跑的话下一次把排着的一起看（没有定时器、没有防抖）；
    // 全局最多 concurrency 个同时在看，一对一和对她说的先看。只让分寸更准，从不决定她知不知道；失败的下一次有合格的事件再试 retries 次
    glance: {
      enabled: true, maxLinesPerCall: 12, contextLines: 6, timeoutMs: 6000, concurrency: 2, retries: 1,
      gistChars: 60, vagueChars: 30, quoteChars: 40, maxTokens: 600,
      lineChars: 160,                    // 卡片上每一行最多多少字
      replyScan: 8,                      // 「她回过他」：这一行之前看几条（条数），她回过这个人的话就算合格
      // 卡片上「他更早跟你说过的」（D110，glance-2）最多几句：只用来认 replaces / follows；别的场合的只上一对一的卡片（软上限，条数）
      priorAsks: 3,
    },
  },

  // ── §10.4 每轮上下文
  context: {
    // 用法说明和记忆工具说明的写法（D125，用户反馈第 22 轮）：guided「详细指引」= 规矩写得具体（默认；适合 DeepSeek 这类模型）/
    // purpose「只讲目的」= 讲记忆是拿来干什么的和标签的意思，规矩少、让模型自己判断（适合更强的模型）。热加载；集成层的块头、小标题、
    // 三个记忆工具的说明也跟着它（工具说明在新的会话里生效）。主人在管理页「设置」里切
    usageStyle: 'guided',
    // 常驻区各部分的字数预算；peopleMax：重要的人最多看几位（字数预算照样管）；autobiographyDays：「现在的我」的自传要点看几天
    resident: { coreSelf: 400, usage: 240, people: 400, me: 300, upcoming: 200, lessons: 200, peopleMax: 3, autobiographyDays: 2 },
    layers: {
      gapH: 12, warmStart: 500, peopleCards: 3, peopleCardChars: 180, presentRecent: 600, todaySoFar: 300, awareLines: 2, intentions: 1,
      gapLines: 2,                       // 时间间隔 1–2 行
      pendingLines: 1,                   // 「还在想」的暂定提示行（§9.3.5），不占想起来的条数
      warmEpisodes: 2,                   // 暖启动：最近几段情节
      warmWindows: 2,                    // 暖启动：还没成段的原文窗口（§10.5 没封口的对话）
      todayItems: 3,                     // 有意回想时「今天到目前为止」给几条小结
    },
    blockMaxChars: 900,
    // 注入预算（§10.4）：上限跟着花费档位走（D133，budget.presets 的 injectShare / injectPerSessionPerDay，生效值从 budgetLimits() 取）。
    // rolling.steps 照旧有效：滚动窗口看最近多少步。
    // rolling.maxShare、perSessionPerDay 已弃用（D133）：读到了也忽略，改看档位；留着只是不让旧的覆盖报未知字段
    rolling: { steps: 50, maxShare: 0.05 },
    perSessionPerDay: 8000,
    pendingTtlMin: 30,                   // 注入后一直没确认、也没中止的块，过了这么久不再挡着它的条目（§10.4「已发过」）
    cacheTtlMin: 10,                     // recallCached 用的已过关口①的条目缓存多久
    residentStaleMin: 60,                // 常驻区过了这么久算脏（下一条真实消息时重新渲染，冻结规则不变）
    deliberateRetrieveShare: 0.6,        // 有意回想的截止时间里分给 retrieve 的份额，其余留给第二段（§9.3.5）
    pastCheckMs: 600,                    // 热路径上「看起来在问过去」最多等多久，超时按「在问」算（评审:SC-22）；D117：300 → 600（嵌入慢时少把普通的话误切成有意回想）
    stageGraceMs: 250,                   // D117：回想的一步（retrieve、关口①）超过它自己的截止时间这么久还没回来，按超时算、不再等（不卡住这一轮）
    retrieveRetryMinLeftMs: 400,         // D117：retrieve 抛错（不是到点）时，剩下的时间还有这么多就再试一次
    errorLogMax: 50,                     // D117：「最近的出错」留几条（只有时刻、步骤、错误类型、代码位置，没有内容；管理页的诊断）
    intentionTries: 3,                   // 每块最多复核几条到点的意图（§5.5 第 6 条）
    // 按轮污点（§9.3.7、§9.6）。notify：带污点的一轮里读到的素材要不要进「需要你知道」——D118 起默认不进（合并转发、引用、工具结果
    // 每轮都有，主人分不出该看哪条；污点本身照常标，关口①、成长的依据照旧用它），打开时同时让这类旧条目重新显示；
    // notifyMax：打开时每轮最多报几个来源；scanRows：往回扫多少条感知
    taint: { notify: false, notifyMax: 5, scanRows: 500 },
  },

  // ── §7.7 夜间整理、§5.7 自我概念
  sleep: {
    at: '04:30',                         // 本地时间（time.tzOffsetMin）
    catchUpH: 24,                        // 距上次超过 24 小时，启动时补跑
    retryMin: 60,                        // 上次开始了没跑完（进程崩了）：至少隔这么久才重跑
    // 一晚的 LLM 调用总上限（D138）。null = 各步上限之和（sleep.js 的 stepCalls：复核 1 + 纠错 correct.maxCalls + 泛化 generalize.maxCalls
    // + 反思 2 + 印象 2 + 回头问问 1 + 故事线和社区 2 + 她自己 1 + 经验回顾 lessons.maxCalls；完整做 14 次，节省档只做必要项 6 次）。
    // 写成数字就按它封顶；不管多少，「她自己」和经验回顾的名额先留出来，前面的步骤用不到
    maxLlmCalls: null,
    planGraceH: 6,                       // 计划的时间点过了多久没下文才标 unknown（§5.5 第 5 条、第 6 步）
    extract: { maxJobs: 100, maxMs: 10 * MIN, retryFailedDays: 7, retryMax: 3, reviewLimit: 40 },   // 第 1 步：顺手跑的提炼、补跑失败批次、复核
    replay: { maxItems: 50, hotEntities: 20, hotWindowDays: 7, recurrenceSoonDays: 14 },   // 第 2 步：分诊和重放
    // 第 2 步（D122）：对照原话纠错。每晚挑最可能错、或最常被想起的事实，回到来源原话和之后的话核对；一次调用核 perCall 条，
    // 一晚最多 maxCalls 次（也算在 maxLlmCalls 里）。再次核对的间隔 = recheckDays × 2^连续确认次数 ÷ (1 + 最近用到的程度)，
    // 至少 minRecheckDays（不是硬窗口，只决定哪天再挑它）。用到的程度看最近 usageDays 天的注入和被提起。
    correct: {
      perCall: 4, maxCalls: 2, poolMax: 3000,
      usageDays: 14, recheckDays: 7, minRecheckDays: 1, maxStreak: 8,
      sourceLines: 3, contextLines: 2, laterLines: 5, laterFacts: 3, behaviorSamples: 2,
      lineChars: 120, whyChars: 80,
      doubtConfidence: 0.4,              // 原话撑不住（只是她自己随口一句、没有依据）→ 把握降到这么多（新版本，旧的留着；只对断言）
      raiseStep: 0.1, raiseMax: 0.75,    // 她说自己能做什么（ability）被她做过的事反复确认：每次升这么多，最多到这里（永远不变成 confirmed）
      herWordsAboutOthersMax: 0.5,       // 关于别人的事，按她自己的话改正时的把握上限（和提炼时她说别人的事一样）
      correctedConfidence: { stated: 0.9, self_said: 0.6, hearsay: 0.6 },   // 改正后的新版本按证据定的确定程度给把握
      maxTokens: 900,
    },
    generalize: {                        // 第 3 步：≥ 3 段、跨 ≥ 2 天
      minEpisodes: 3, minDays: 2,
      windowDays: 60,
      maxEpisodes: 400,                  // 情节聚类一次最多看多少段：窗口里最近的这些（D138）
      minCos: 0.78, minJaccard: 0.3,     // 情节聚类：向量余弦；没有向量时用词元 Jaccard
      groupsPerCall: 6, maxCalls: 2, itemsPerGroup: 8,   // 1–3 次调用
      confidenceCap: 0.7,
      coveredShare: 0.5,                 // 已有泛化覆盖了这么多证据就不重新泛化，只追加来源
    },
    reflection: {                        // 第 4 步（Generative Agents）
      confidenceCap: 0.7,
      impThreshold: 150,                 // 近期重要度累计超过它才反思
      maxQuestions: 3,
      recentItems: 60,
      evidencePerQuestion: 8,
      minEvidence: 2,                    // 洞见至少引用这么多条证据
      sameSim: 0.6,                      // 和已有洞见这么像就不再写
      deadlineMs: null,                  // 取证据的有意回想最多等多久；null = recall.deliberate.deadlineMs
    },
    impressions: { perCall: 6, factsPerLayer: 30, maxChars: 160, maybeSamePerCall: 6, factsPerSide: 6 },   // 第 5 步
    followUp: { windowH: 72, perCall: 10 },   // §5.5 第 5 条「回头问问」的时间窗（之后没机会就 lapsed）
    storyline: { maxChars: 600, perCall: 5, episodesPerSetting: 12, rebuildEvery: 10, rebuildEpisodes: 20 },   // §5.8；每 10 个版本整体重写一次
    communities: {                       // 第 7 步（标签传播）
      windowDays: 30, minMembers: 3, maxMembers: 12, perCall: 6, factsPerCommunity: 12, summaryChars: 200, rounds: 20,
      dominantShare: 0.6,                // 证据 ≥ 60% 来自同一个场合 → 社区挂在这个场合下
    },
    selfConcept: { minEvidence: 5, minDays: 3, windowDays: 30, poolItems: 60 },
    // 第 11 步（D124）：回顾做事的经验。有新的「工具反复没成」或主人纠正她对自己的认知时才调一次（maxCalls），最多新记 maxNew 条，
    // 能把说同一件事的几条合并；没有新东西不调。工具没成要 ≥ minFailures 次、跨 ≥ minSessions 个会话才算「反复」
    lessons: { maxCalls: 1, maxNew: 3, minFailures: 2, minSessions: 2, existingMax: 30, lookbackDays: 7, maxTokens: 500, lineChars: 120 },
    growth: {
      mode: 'auto', minDistinctSources: 2, charLimit: 300,   // auto 自动生效、可撤销 / approve 逐条批准（§17 Q4）
      lineChars: 80,
      maxChangesPerNight: 1,             // 每次只改一点（§5.7）
      sameChangeSim: 0.5,                // 换个说法的同一变化也绕不过撤销
    },
    // minGapH：两晚的日记至少隔这么久（同一晚补跑不重写）；maxDaysPerNight：一晚最多写几天的日记（D138：前几晚没写成的那几天
    // 一起补，最近的先写；缺得更多的下一晚接着补。不是记忆的时间窗，只是一次补多少）；backfillDays：只补最近这么多天里缺的
    // （更早的、升级以前就没写的日子不回头重写：补日记是为了不因为一两晚没跑成就缺掉，不是重写历史）
    diary: { maxChars: 300, minGapH: 12, maxDaysPerNight: 3, backfillDays: 7 },
    // 第 9、10 步：embedBatches 是每一轮的批数上限（一轮接一轮，直到活动空间的队列清空，§7.6 白天推迟的夜里做完）；
    // retierRounds 是重排层级跑完一整遍之外多给的批数（一整遍 = ceil(行数 / activation.retierBatch)）
    maintenance: { embedBatches: 50, shadowBatches: 50, retierRounds: 20, ftsMergeSteps: 4, vacuumPages: 2000 },
  },

  // ── §7.6、§8.9 嵌入和向量空间
  embedding: {
    batch: { cpu: 4, gpu: 32 },          // 文档每批：CPU ≤ 4，GPU 16–64（§7.6）
    dims: null,                          // MRL 截断到的维数；null = 端口给的维数（§8.6）
    maxAttempts: 5,
    retryFailedAfterH: 24,               // 失败的行隔一天在夜间重试（§7.7 第 9 步）
    backlogDeferH: 1,                    // 积压超过 1 小时推到夜间
    nightGraceH: 36,                     // 这么久没有夜间整理，推到夜间的积压白天照样嵌
    queryYieldMaxMs: 10_000,             // 有查询在等时文档批最多让多久
    shadowDayBatches: 1,                 // 白天的影子重嵌限速（§8.9）
    msPerText: { cpu: 300, gpu: 20 },    // 估算积压用（CPU 每条 0.3–0.7 秒）
    oldSpaceKeepDays: 14,
    probeCount: 20,
    probeMinCos: 0.995,                  // 启动探针和任何一份基线的平均余弦都低于它 → 空间可疑，降到 L3。同一模型换后端的数值差
                                         // 实测 0.998（CPU ↔ GPU）、0.9988（部分层放 GPU）；换了模型靠指纹，或者差得远（实测问题 #1）
    queryCacheMax: 512,                  // 查询向量缓存（按空间和文字，LRU）：晚到的向量留给下一次回想
    queryInflightMaxMs: 30_000,          // 同一段文字正在嵌、超过这么久还没回来就不再等那一次，重新发
    // 查询嵌入很快就报错（连接被重置、模型正在重载返回 5xx……；不是慢）时重试（D117）：最多 queryRetries 次，每次先等 queryRetryBackoffMs × 次数，
    // 截止时间还剩不到 queryRetryMinLeftMs 就不试了。慢（到截止没回来）照旧不重试：那一次照样做完，结果进缓存给下一次
    queryRetries: 1,
    queryRetryBackoffMs: 150,
    queryRetryMinLeftMs: 300,
  },

  // ── §8.7 worker 线程
  worker: {
    enabled: true,                       // false = 不起线程，全在主线程按降级做（H1）
    startTimeoutMs: 20_000,
    termStatsTtlMs: 10 * MIN,            // IDF 缓存
    countTtlMs: MIN,                     // FTS 行数缓存
    chunkRows: 8192,                     // 内存索引按块分配
    loadBatch: 4000,                     // 冷加载每批
    maintTimeoutMs: 10 * MIN,
    ftsMerge: { pages: 200, segments: 8 },   // §7.7 第 10 步 merge=200,8
    vacuumPages: 1000,                   // incremental_vacuum 没给页数时
    restartCooldownMs: MIN,              // 线程崩了以后重启
    maxRestarts: 3,
    busyMs: 1000,                        // 只读连接的 busy timeout
    reprobeMs: 30 * MIN,                 // 可疑的空间多久重新探测一次（§13.2）
    yieldEvery: 2000,                    // 长扫描每这么多行让一次事件循环
    coverageRecheckMs: 10 * MIN,         // 影子空间覆盖率到 100% 后多久复查一次（§8.9）
  },

  // ── §10.6 预算：三档预设，默认宽松（§17 Q10）。核心只读这些数，执行在集成层的 BudgetPort
  //   调用次数、未命中输入的上限写 null = 不设上限；perSourceShare 1 = 一个来源不单独限；mainChatRatioCap null = 不设比例上限
  //   不设上限（unlimited，D121）：给重度用户——次数、token、比例都不拦，其余和宽松一样全开；余额保护照留（1 天）
  //   注入预算（D133）：回想注入她上下文的字数，花的是她聊天的输入 token。injectShare：最近 context.rolling.steps 步里受限的注入字数
  //   ≤ 同期上下文增量 × 它；injectPerSessionPerDay：每个会话每天受限的注入字数。null = 不限。「你想着的」和工作记忆不受限、也不记账。
  //   宽松给得松（记忆效果优先）；节省是 D133 之前的数（5%、8000 字）
  budget: {
    preset: 'loose',
    presets: {
      loose: { mainChatRatioCap: null, dailyCalls: 3000, dailyUncachedTokens: 5_000_000, perSourceShare: 0.5,
        stage2Scope: 'all', prefetchRewrite: true, rerank: true, sleepDepth: 'full', balanceProtectDays: 1,
        injectShare: 0.25, injectPerSessionPerDay: 40_000 },
      saving: { mainChatRatioCap: 0.25, dailyCalls: 600, dailyUncachedTokens: 1_000_000, perSourceShare: 0.3,
        stage2Scope: 'direct', prefetchRewrite: false, rerank: true, sleepDepth: 'essential', balanceProtectDays: 3,
        injectShare: 0.05, injectPerSessionPerDay: 8000 },
      unlimited: { mainChatRatioCap: null, dailyCalls: null, dailyUncachedTokens: null, perSourceShare: 1,
        stage2Scope: 'all', prefetchRewrite: true, rerank: true, sleepDepth: 'full', balanceProtectDays: 1,
        injectShare: null, injectPerSessionPerDay: null },
    },
    // 主人单独改过的项（管理页「花费护栏 → 自定义」或手改文件），覆盖预设。能写的键和取值见 BUDGET_OVERRIDE_KEYS / checkBudgetOverride；
    // 其中 dailyOutputTokens（每天输出的上限，null = 不设）不在预设里：不改时按宿主每档的数（host.budget.dailyOutputTokens）
    overrides: {},
    egressReservePerDay: 100,             // 外发审视每天单独预留的次数（D113：只有公开目标还送审，从 300 调回 100）
    glanceReservePerDay: 150,             // 第一眼（use='glance'，meta.reserved）超了每天的总上限以后还能用的次数（D106）
  },

  // ── §12.4 备份
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 12, preOp: 10, export: 12 },   // 手动备份不自动删；export = 月度 JSONL 导出
    weeklyOnDay: 0,                      // 周包在本地的星期几（0 = 周日，D19）
    monthlyOnDay: 1,
    vectorsIn: ['weekly', 'monthly'],
    offsiteKinds: ['daily', 'weekly', 'monthly'],   // 复制（加密）到异地目录的种类
    exportMonthly: true,                 // §12.4.7 每月一份 JSONL 导出
    compressLevel: 6,                    // .pmpack 的 zlib 压缩级别
    lowDiskGb: 5,
    drill: { everyDays: 7, sample: 20 },
    replayWindowDays: 7,                 // 整体恢复后多久之内补回来的消息按历史模式存（§12.4.5 第 6 步）
    offsiteDir: '',                      // 异地目录（空 = 没设置，总览一直提示）
    keyFile: '',                         // 本机的备份密钥文件；空 = <dataDir>/persona-memory-backup.key（不是身份哈希密钥 core.keyFile）
    configFile: '',                      // 一起打进包、换机恢复时放回去的插件配置文件；空 = 不带
    scrypt: { N: 32768, r: 8, p: 1 },
  },

  // ── §12.6 保留期（只能在管理页改，缩短要确认语 + 7 天冷静期）
  retention: {
    raw: '2y',                           // 1y / 2y / 5y / forever
    coolingOffDays: 7,
    evidenceChars: 60,                   // 过期的原文只留情节叙述和 ≤ 60 字证据
    // 日志表到期清理（D139，夜间整理第 10 步）：实际天数和读它们的步骤要看的天数取大的（logRetentionDays）；0 或负数 = 不清理。
    // 还在用的行多旧都不删（当前周期的注入、挂起的发言、还被引用的判定、切口还没定下来的提炼……见 admin/retention.js）
    logs: { injectionsDays: 14, jobsDays: 30, appraisalsDays: 7, utterancesDays: 365 },
    forgetRestoreDays: 30,
    batch: 500,                          // 到期删除每批多少行（§12.8）
    requireBackupWithinH: 48,            // 删原文之前要有这么近的、验证过的本机包
    backupRetryMin: 60,                  // 删除前备份失败的重试间隔
  },

  // ── §13.1 管理页
  admin: {
    purgeBatch: 200,                     // 彻底删除分批做（可中断、可重跑）
    inheritBatch: 200,                   // §12.7 隐藏的继承：tick 兜底扫新写出的派生内容，每张表每次最多几行
    growthRecentDays: 7,                 // 待审提示里「最近有 N 处成长变化」看几天
    page: { limit: 50, max: 200 },       // 列表分页
  },

  // ── 存储
  store: { slowMs: 50, busyTimeoutMs: 5000 },

  // ── 时间：库里一律 UTC 毫秒；「昨天」「晚上」「04:30」这类本地时间按这个偏移算
  time: { tzOffsetMin: null },           // null = 本机时区（new Date().getTimezoneOffset() 的相反数）
});

const PACK_KINDS = ['daily', 'weekly', 'monthly', 'manual', 'pre-op'];
/** 取值只能是这几个的项（类型检查之外再查一遍）；数组的项逐个查。 */
export const ENUMS = Object.freeze({
  // 旧配置里写的 'shadow' 不再认：按不合法的值忽略、给 warning，用默认档（live）
  'mode.global': ['off', 'live'],
  'mode.byAttributes.principalOneOnOne': ['off', 'live'],
  'mode.byAttributes.closed': ['off', 'live'],
  'mode.byAttributes.public': ['off', 'live'],
  'sleep.growth.mode': ['auto', 'approve'],
  'context.usageStyle': ['guided', 'purpose'],
  'budget.preset': ['loose', 'saving', 'unlimited'],
  'retention.raw': ['1y', '2y', '5y', 'forever'],
  'backup.vectorsIn': PACK_KINDS,
  'backup.offsiteKinds': PACK_KINDS,
});
/** 保留期选项 → 毫秒（forever = Infinity）。 */
export const RETENTION_MS = Object.freeze({ '1y': 365 * DAY, '2y': 730 * DAY, '5y': 1826 * DAY, forever: Infinity });
/** off < live。不认识的值（库里旧的 'shadow' 规则之类）调用方按 live 算。 */
export const MODE_RANK = Object.freeze({ off: 0, live: 1 });

// ── 合并和热加载 ──────────────────────────────────────────────────────────
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const capV = (v) => (v === null || (Number.isInteger(v) && v >= 0) ? null : '应为不小于 0 的整数，或 null（不设上限）');
const oneOfV = (xs) => (v) => (xs.includes(v) ? null : `应为 ${xs.join(' / ')} 之一`);
const boolV = (v) => (typeof v === 'boolean' ? null : '应为 true / false');
/** budget.overrides 能写的键和每个键的检查（类型和取值；管理页另有更窄的范围）。返回 null = 合法，否则是原因。 */
const BUDGET_OVERRIDE_CHECKS = Object.freeze({
  dailyCalls: capV,
  dailyUncachedTokens: capV,
  dailyOutputTokens: capV,
  perSourceShare: (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1 ? null : '应为大于 0、不超过 1 的数（1 = 不单独限）'),
  mainChatRatioCap: (v) => (v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0) ? null : '应为大于 0 的数，或 null（不设）'),
  balanceProtectDays: (v) => (Number.isInteger(v) && v >= 0 && v <= 365 ? null : '应为 0–365 的整数（0 = 关）'),
  stage2Scope: oneOfV(['all', 'direct']),
  prefetchRewrite: boolV,
  rerank: boolV,
  sleepDepth: oneOfV(['full', 'essential']),
  // 注入预算（D133）：null = 不限
  injectShare: (v) => (v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1) ? null : '应为大于 0、不超过 1 的数，或 null（不限）'),
  injectPerSessionPerDay: capV,
});
/** budget.overrides 能写的键（顺序就是管理页「自定义」里的顺序）。 */
export const BUDGET_OVERRIDE_KEYS = Object.freeze(Object.keys(BUDGET_OVERRIDE_CHECKS));
/**
 * 检查 budget.overrides 的一项（D121）。
 * @param {string} key
 * @param {unknown} value
 * @returns {string|null}  null = 合法；否则是看得懂的原因
 */
export function checkBudgetOverride(key, value) {
  if (!Object.hasOwn(BUDGET_OVERRIDE_CHECKS, key)) return '不认识的配置项';
  return BUDGET_OVERRIDE_CHECKS[key](value);
}

/**
 * 把用户配置合到默认值上。数组整体替换；对象逐键合并；类型和默认值不一致的、未知的键都忽略并记 warning。
 * null 默认值的项（比如 mainChatRatioCap、embedding.dims，含义是「跟着别的值走」）接受 null 或有限数字。
 * 所以合并出来的快照一定有 DEFAULTS 的全部键：模块读参数不需要再写兜底的数。
 * @param {object} base
 * @param {object} override
 * @returns {{config: object, warnings: string[]}}
 */
export function mergeConfig(base, override) {
  const warnings = [];
  const walk = (b, o, p) => {
    if (o === undefined) return b;
    if (isPlain(b)) {
      if (!isPlain(o)) { warnings.push(`${p || '(根)'}：应为对象，忽略`); return b; }
      // 主人单独改的预算项（D121）：键是固定的那几个，每个按自己的规则查；不合法的那一项忽略，其余照用
      if (p === 'budget.overrides') {
        const out = {};
        for (const [k, v] of Object.entries(o)) {
          const why = checkBudgetOverride(k, v);
          if (why) warnings.push(`${p}.${k}：${why}，忽略`); else out[k] = v;
        }
        return out;
      }
      const out = { ...b };
      for (const [k, v] of Object.entries(o)) {
        const kp = p ? `${p}.${k}` : k;
        if (!(k in b)) {
          warnings.push(`${kp}：不认识的配置项，忽略`);
          continue;
        }
        out[k] = walk(b[k], v, kp);
      }
      return out;
    }
    if (b === null) {
      if (o === null || (typeof o === 'number' && Number.isFinite(o))) return o;
      warnings.push(`${p}：应为有限数字或 null，忽略`);
      return b;
    }
    if (typeName(o) !== typeName(b)) { warnings.push(`${p}：应为 ${typeName(b)}，忽略`); return b; }
    if (typeof o === 'number' && !Number.isFinite(o)) { warnings.push(`${p}：应为有限数字，忽略`); return b; }
    const allowed = ENUMS[p];
    if (allowed && !(Array.isArray(o) ? o.every((x) => allowed.includes(x)) : allowed.includes(o))) {
      warnings.push(`${p}：应为 ${allowed.join(' / ')}${Array.isArray(o) ? ' 里的值' : ' 之一'}，忽略`);
      return b;
    }
    return Array.isArray(o) ? [...o] : o;
  };
  return { config: deepFreeze(walk(base, override, '')), warnings };
}

/**
 * DEFAULTS 里某个路径的值（'recall.past.simMin'），没有这一项返回 undefined。
 * 只给「快照里可能缺键」的地方兜底（测试里手搭的 core）；正常的快照由 mergeConfig 合出来，键是全的。
 * @param {string} p
 */
export function defaultAt(p) {
  let v = DEFAULTS;
  for (const k of p.split('.')) {
    if (!isPlain(v)) return undefined;
    v = v[k];
  }
  return v;
}

/**
 * 当前生效的预算限额：预设 + 主人单独改过的项。null 的上限 = 不设（集成层按无穷大执行）。
 * dailyOutputTokens 只有主人改过时才在这里（没改时集成层按宿主每档的数）。
 */
export function budgetLimits(config) {
  const b = config.budget;
  return Object.freeze({ ...(b.presets[b.preset] ?? b.presets.loose), ...b.overrides, egressReservePerDay: b.egressReservePerDay, glanceReservePerDay: b.glanceReservePerDay });
}

/**
 * 日志表实际的保留天数（D139）：retention.logs 的值，和读这些表的步骤要往回看的天数取大的——删掉它们还要看的行会改变它们的结果：
 *   - injections ≥ sleep.correct.usageDays、lessons.promote.windowDays（夜里按注入日志算「用到的程度」）；
 *   - jobs ≥ sleep.extract.retryFailedDays（夜里补跑这几天里失败的提炼）；
 *   - appraisals ≥ 2 天（工作记忆只沿用比保留期新至少一天的判定，见 discretion/working.js）；
 *   - utterances ≥ discretion.egress.holdExpiryDays、rejectWindowH（挂起审核的期限、「同一句被拒两次」的时间窗）。
 * 配置成 0、负数或不是数 = 这张表不清理（null）。
 * @param {typeof DEFAULTS} cfg
 * @returns {{injections: number|null, jobs: number|null, appraisals: number|null, utterances: number|null}}
 */
export function logRetentionDays(cfg) {
  const L = cfg?.retention?.logs ?? {};
  const n = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const keep = (days, ...floors) => (typeof days === 'number' && Number.isFinite(days) && days > 0 ? Math.max(days, ...floors.map((f) => n(f))) : null);
  return {
    injections: keep(L.injectionsDays, cfg?.sleep?.correct?.usageDays, cfg?.lessons?.promote?.windowDays),
    jobs: keep(L.jobsDays, cfg?.sleep?.extract?.retryFailedDays),
    appraisals: keep(L.appraisalsDays, 2),
    utterances: keep(L.utterancesDays, cfg?.discretion?.egress?.holdExpiryDays, n(cfg?.discretion?.egress?.rejectWindowH) / 24),
  };
}

/**
 * @typedef {object} ConfigHandle
 * @property {() => typeof DEFAULTS} get              当前快照（深冻结）
 * @property {() => number} version                   每次生效的改动 + 1
 * @property {(patch: object) => string[]} update     合并一个补丁，返回 warnings；有效改动才通知
 * @property {(overrides: object) => string[]} replace 用一份新的用户配置整体替换（热加载配置文件时用）
 * @property {(fn: (cfg: typeof DEFAULTS) => void) => () => void} onChange
 */

/**
 * 可热加载的配置。overrides 是用户配置（比如 ~/.dsh/persona-memory.json 的内容）。
 * @param {object} [overrides]
 * @param {{onWarn?: (warnings: string[]) => void}} [opt]
 * @returns {ConfigHandle}
 */
export function createConfig(overrides = {}, { onWarn } = {}) {
  let user = {};
  let current = DEFAULTS;
  let version = 0;
  const listeners = new Set();
  const apply = (nextUser) => {
    const { config, warnings } = mergeConfig(DEFAULTS, nextUser);
    if (warnings.length) { try { onWarn?.(warnings); } catch { /* 忽略 */ } }
    const changed = JSON.stringify(config) !== JSON.stringify(current);
    user = nextUser;
    current = config;
    if (changed) {
      version += 1;
      for (const fn of listeners) { try { fn(current); } catch { /* 监听器出错不影响别人 */ } }
    }
    return warnings;
  };
  apply(isPlain(overrides) ? overrides : {});
  return Object.freeze({
    get: () => current,
    version: () => version,
    update: (patch) => apply(mergePlain(user, patch)),
    replace: (next) => apply(isPlain(next) ? next : {}),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  });
}

/** 两份用户配置的深合并（不做校验，校验在 mergeConfig）。 */
function mergePlain(a, b) {
  if (!isPlain(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isPlain(v) && isPlain(a?.[k]) ? mergePlain(a[k], v) : v;
  return out;
}

/** 接受一个现成的 ConfigHandle 或一份用户配置对象。 */
export function toConfigHandle(config) {
  if (config && typeof config.get === 'function' && typeof config.onChange === 'function') return config;
  return createConfig(config ?? {});
}
