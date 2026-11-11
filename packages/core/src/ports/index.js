// 核心需要外面提供的「端口」（§3.3）。核心是被动的库：时间、模型、调度、语言知识、平台相关的清洗都从外面注入，
// 换宿主时只需重写这些端口（评审:AR-16）。这里只有接口说明、默认实现和检查；DSH 上的实现在 packages/dsh/src/host/。
// 测试替身在 packages/core/test/fakes/。

/**
 * 时钟。所有「现在」都从这里取，测试里换成 FakeClock。
 * @typedef {object} Clock
 * @property {() => number} now   UTC 毫秒
 */

/**
 * LLM 用途标签（插件内部的，宿主不认识，评审:FE-15）。
 * @typedef {'extract'|'appraise'|'review'|'rewrite'|'sleep'|'summary'|'glance'|'perceive'} LlmUse
 */
/**
 * @typedef {object} LlmMessage
 * @property {'user'|'assistant'} role
 * @property {string} content
 */
/**
 * @typedef {object} LlmUsage
 * @property {number} in       未命中缓存的输入 token
 * @property {number} cached   命中缓存的输入 token
 * @property {number} out
 */
/**
 * 模型为什么停下（可选，D141）：'end' 自己说完了；'length' 输出到了 maxTokens 的上限，后面的被截掉了；'other' 别的（如要调工具）。
 * 宿主给了才带，给不了就不带——核心另有退路（最后一行不完整、输出量接近上限就按截断算）。
 * @typedef {'end'|'length'|'other'} LlmStopReason
 */
/**
 * 后台 LLM。集成层自己包 ctx.llm.stream：按 use 选模型（必须在允许清单里，不跟随宿主默认模型）、排队、计数，
 * 从 finish 块取用量（§10.6）。DSH 没有 JSON 模式，核心要的结构化输出一律是 JSONL（§7.3）。
 * 失败抛错（AbortError / 超时 / 额度），核心按 fail closed 处理。
 * @typedef {object} LLMPort
 * @property {(req: {use: LlmUse, system: string, messages: LlmMessage[], maxTokens?: number, signal?: AbortSignal})
 *            => Promise<{text: string, usage: LlmUsage, model?: string, stopReason?: LlmStopReason}>} complete
 */

/**
 * 嵌入。kind='query' 时有人在等（最高优先级）；'doc' 是文档批。向量必须 L2 归一化。
 * spaceId = hash(模型, 量化档, 维数, 文档端模板版本)；查询只和同一个空间比（§8.9）。
 * @typedef {object} EmbeddingInfo
 * @property {string} spaceId
 * @property {string} model
 * @property {string} [quant]
 * @property {number} dim
 * @property {string} docTplVer
 * @property {'cpu'|'gpu'} [device]            现在跑在哪（降级级别 L0–L2 的依据，§8.8）；核心不管显卡，只看这个字段
 * @property {string} [digest]                模型文件的指纹（如 Ollama 的 digest），知道就给：同名的模型被换过（权重变了）靠它认出来，
 *                                            启动探针的数值容差只管同一模型换后端的差（§13.2，实测问题 #1）
 */
/**
 * @typedef {object} EmbeddingPort
 * @property {(texts: string[], kind: 'query'|'doc', opt?: {priority?: number, signal?: AbortSignal})
 *            => Promise<{spaceId: string, vectors: Float32Array[]}>} embed
 * @property {() => EmbeddingInfo} info          当前活动空间的描述（建 vector_spaces 行用）
 * @property {() => Promise<boolean>} [warm]     可选：有人说话了、马上可能要查询，先把模型备好（已经热着就什么都不做；不抛错）
 */

/**
 * 重排（可选）。只在集成层的资源管家允许时可用；不可用时 available() 为 false，核心跳过重排（§8.4）。
 * @typedef {object} RerankPort
 * @property {() => boolean} available
 * @property {(query: string, docs: string[], signal?: AbortSignal) => Promise<number[]>} rerank
 */

/**
 * 后台花费的护栏（§10.6）。allow() 为 false 时这次调用不做（按各用途的降级处理）；
 * 外发审视（use='review'）有独立预留，别的用途不能占用。
 * @typedef {object} BudgetState
 * @property {number} spentToday
 * @property {number} [baseline]
 * @property {number} reserveLeft           外发审视今天还剩几次
 * @property {number} [daysOfBalance]       余额还够几天（接了余额来源才有）
 * @property {boolean} [paused]             余额保护触发，后台暂停
 */
/**
 * @typedef {object} BudgetPort
 * @property {(use: LlmUse, estTokens: number, meta?: {sourceKey?: string, reserved?: boolean}) => boolean} allow
 * @property {() => BudgetState} state
 */

/**
 * 她自己（§5.7）：核心自我只放性格、口吻和价值观，是配置不是记忆。
 * @typedef {object} SelfProfilePort
 * @property {() => {text: string, hash: string}} coreSelf
 * @property {() => string} principalLabel      她怎么称呼主人（只用于渲染，核心不靠它认人）
 * @property {string} locale                    她的主要语言（'zh'）
 */

/**
 * 时间表达解析出的时间窗。
 * @typedef {object} TimeWindow
 * @property {number} start
 * @property {number} end
 * @property {'exact'|'day'|'week'|'month'|'fuzzy'} precision
 * @property {string} [text]                    命中的那段文字
 */
/**
 * 语言分析器（按语言注册，评审:UV-16）。核心自带 zh 和 Unicode 回退（lang 模块）；以后加 en 等不改核心。
 * @typedef {object} LanguageAnalyzer
 * @property {string} lang                                       'zh'、'und' ……
 * @property {(text: string) => number} detect                   0–1：这段文字是这种语言的把握
 * @property {(text: string, opt?: {mode?: 'index'|'query'}) => string[]} tokenize   词元（未经 FTS 规范化也行，store.normalizeToken 会再过一遍）
 * @property {(text: string, at: number) => TimeWindow[]} parseTime
 * @property {() => string[]} pastQuestionExemplars              「还记得……吗」这类示例问法（§6.6）
 * @property {(text: string) => number} questionCue              0–1：句式上像不像在问（嵌入不可用时的退路）
 * @property {(words: string[]) => void} [setUserDictionary]     jieba 用户词典（实体别名，§8.2）
 */

/**
 * 清洗（§7.1 第 2 步）。核心有通用部分（去令牌、长 hex/base64、本机路径、URL query、不可见字符）；
 * 平台相关的转义（唤醒头的方括号、宿主的插值语法）由集成层和适配器注入，核心不知道这些格式（评审:UV-03）。
 * 注入的 Sanitizer 在核心的通用清洗**之后**运行。
 * @typedef {object} Sanitizer
 * @property {(text: string, origin: {adapter: string, kind?: string}) => string} forStore
 * @property {(text: string) => string} forPrompt
 */

/**
 * 日志：只记 id、类型和计数，**不记内容**（§12.3）。fields 的值只能是数字、布尔或短字符串（id、错误类型）。
 * @typedef {object} Logger
 * @property {(event: string, fields?: Record<string, string|number|boolean|null>) => void} debug
 * @property {(event: string, fields?: Record<string, string|number|boolean|null>) => void} info
 * @property {(event: string, fields?: Record<string, string|number|boolean|null>) => void} warn
 * @property {(event: string, fields?: Record<string, string|number|boolean|null>) => void} error
 */

/**
 * 全部端口。clock、logger、selfProfile、budget 没给就用默认值；llm / embedding / rerank 没给就是「不可用」，
 * 核心按降级处理（不提炼、L3、不重排），绝不因此抛错。config 不是端口对象，见 config/defaults.js 的 createConfig。
 * @typedef {object} Ports
 * @property {Clock} [clock]
 * @property {LLMPort} [llm]
 * @property {EmbeddingPort} [embedding]
 * @property {RerankPort} [rerank]
 * @property {BudgetPort} [budget]
 * @property {SelfProfilePort} [selfProfile]
 * @property {LanguageAnalyzer[]} [languages]   额外注册的语言分析器（覆盖同名的内置分析器）
 * @property {Sanitizer} [sanitizer]
 * @property {Logger} [logger]
 */

export const systemClock = Object.freeze({ now: () => Date.now() });
export const nullLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
/** 没接预算时：全部放行（核心单独使用的场景）。 */
export const unlimitedBudget = Object.freeze({
  allow: () => true,
  state: () => ({ spentToday: 0, reserveLeft: Infinity }),
});
export const emptySelfProfile = Object.freeze({
  coreSelf: () => ({ text: '', hash: 'empty' }),
  principalLabel: () => '',
  locale: 'und',
});
export const identitySanitizer = Object.freeze({ forStore: (t) => t, forPrompt: (t) => t });

const REQUIRED_METHODS = {
  clock: ['now'],
  llm: ['complete'],
  embedding: ['embed', 'info'],
  rerank: ['available', 'rerank'],
  budget: ['allow', 'state'],
  selfProfile: ['coreSelf', 'principalLabel'],
  sanitizer: ['forStore', 'forPrompt'],
  logger: ['debug', 'info', 'warn', 'error'],
};
const ANALYZER_METHODS = ['detect', 'tokenize', 'parseTime', 'pastQuestionExemplars', 'questionCue'];

/**
 * 检查端口并补上默认值。缺方法的端口直接报错（这是集成层的编程错误，启动时就该发现）。
 * @param {Ports} [ports]
 * @returns {Required<Pick<Ports, 'clock'|'budget'|'selfProfile'|'sanitizer'|'logger'>> & Ports & {languages: LanguageAnalyzer[]}}
 */
export function normalizePorts(ports = {}) {
  const out = { ...ports };
  for (const [name, methods] of Object.entries(REQUIRED_METHODS)) {
    const p = ports[name];
    if (p == null) continue;
    for (const m of methods) {
      if (typeof p[m] !== 'function') throw new TypeError(`端口 ${name} 缺少方法 ${m}()`);
    }
  }
  for (const [i, a] of (ports.languages ?? []).entries()) {
    if (!a || typeof a.lang !== 'string') throw new TypeError(`languages[${i}] 缺少 lang`);
    for (const m of ANALYZER_METHODS) if (typeof a[m] !== 'function') throw new TypeError(`语言分析器 ${a.lang} 缺少方法 ${m}()`);
  }
  out.clock = ports.clock ?? systemClock;
  out.logger = ports.logger ?? nullLogger;
  out.budget = ports.budget ?? unlimitedBudget;
  out.selfProfile = ports.selfProfile ?? emptySelfProfile;
  out.sanitizer = ports.sanitizer ?? identitySanitizer;
  out.languages = [...(ports.languages ?? [])];
  return Object.freeze(out);
}
