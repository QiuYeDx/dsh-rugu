// 插件配置（§3.3 Config、§12.1）：一个文件 ~/.dsh/persona-memory.json。
//   顶层的键是核心的参数表（mode、budget、retention……，见 rugu-core 的 DEFAULTS），交给核心的 createConfig 热加载；
//   `host` 这一个键是集成层自己的设置（模型服务、显卡策略、适配器、功能开关），只在这里用。
// 规矩：
//   - 配置写错只给 warning，绝不让插件起不来；文件坏了就用默认值，并且不覆盖那个文件；
//   - 「只有主人在管理页能改」的项（保留期、预算预设……）只走管理页的 set()，聊天和工具没有任何改它的路（§9.6）；
//   - 保留期不能经配置改（D56：配置里的 retention.raw 只是初始值，之后以库里为准，改要走 admin.retention.request）；
//   - 有风险的改动要 {confirm: true}（关掉冻结、显卡「开」、总开关……），否则返回 needsConfirm，不写；
//   - 运行中热加载时，配置文件里出现的有风险的改动先不生效（沿用原来的值），等主人在管理页确认（applyPending）或丢弃（discardPending）：
//     文件谁都能改，工具也碰得到它（tools/pre-execute 另有一道拦），确认只能在主人专用的管理页里做。
import fs from 'node:fs';
import { createConfig } from 'rugu-core';
import { readJson, writeJsonAtomic, isPlain, deepFreeze } from './util.js';
import { PERSONA_PRESET_ID } from '../preset/index.js';

const MIN = 60_000;

/** 集成层的默认值。数值都是【建议】，beta 用诊断区的数据再调。 */
export const HOST_DEFAULTS = deepFreeze({
  enabled: true,
  dataDir: '',                       // 空 = <DSH 家目录>/persona-memory（§12.1）
  // 首次设置（D128）：配置文件不存在时插件等主人在管理页走完设置才开库、开始记；completedAt 是走完的时间（毫秒），0 = 没走过（手写配置的也算设置过）
  // offGroups（D131）：向导里取消的群号，开库后写成「这个场合关」（之后在「场合与规则」里改），写完清空，不留在配置里
  setup: { completedAt: 0, acknowledged: false, inProgress: false, offGroups: [] },
  // 功能开关（§15：一次交付 beta，按功能开关）
  features: {
    observe: true,                   // 会话事件和工具结果当场入库
    resident: true,                  // 常驻区 systemPrompt.context
    inject: true,                    // pre-step / post-execute 的增量块
    tools: true,                     // memory_recall / memory_note / memory_fix
    egress: true,                    // tools/pre-execute 外发审视
    freeze: true,                    // 冻结桥接自带的记忆（§15.2：装上就拒绝写入）
    compaction: true,
    scheduler: true,                 // 每分钟的维护 tick + 任务队列
    gpu: true,                       // 资源管家（§8.6.2）；关掉 = 永远 CPU
    rerank: true,
    selfCheck: true,
  },
  // suspendOnAlarms：绑定报这些一致性告警时停掉那个会话的感知和注入（C1：唤醒头和绑定的场合对不上、不止一个）
  // signatureRetryMs：符合某个绑定的会话特征、这一步却没认上的会话（例：选了插件预设、消息不是网页界面发的）多久再问一次，不算进 maxAttempts（D112）
  claim: { excludePresets: [], excludeCwdPrefixes: [], negativeTtlMs: 60_000, signatureRetryMs: 5000, maxAttempts: 5, suspendOnAlarms: ['mismatch', 'multiple'] },
  // graceMs：等核心回想时在截止时间之外多等的余量；「在问过去」时按核心的 recall.deliberate.deadlineMs 等（实测问题 #2）
  // D117：deadlineMs 800 → 1500、graceMs 200 → 300（主人「哪怕提高一些允许的等待时长」；平常几十毫秒就回来，上限只在慢的时候用上）
  // recollectChars（D155）：被判成回忆的那一轮（结果里有回忆那一层），整块的上限在 blockMaxChars 上再加这么多（核心回忆那一层自动触发的一档约 2000 字）；
  // 浮现的轮不变
  // sinceHereChars（D164）：块里有「这之后他的事」那一层时，整块的上限再加这一层实际占的字数（最多这么多；核心那一层默认 4 件 × 100 字）。
  // 它和工作记忆一样在核心里有自己的预算，到这里也不该挤掉工作记忆和「想起来的」
  inject: { deadlineMs: 1500, graceMs: 300, budgetChars: 900, blockMaxChars: 1400, recollectChars: 2400, sinceHereChars: 400, onToolResults: true },
  // seenFreshMs：读消息工具读到的、别人对她说的，最多早于这一轮开始多久还算她这一轮新看到的（记忆工具的触发消息候选，D114）
  // recollectChars（D155）：记忆工具的结果里有回忆那一层时，整个结果最多这么多字（核心工具那一档约 4000 字）；没有时照旧 1600
  tools: { presets: [], recallDeadlineMs: 8000, recallBudgetChars: 1200, recollectChars: 4600, seenFreshMs: 10 * MIN },
  // 她看过的媒体（D116）：认领的会话里，工具结果带图片、或者是 viewTools 里的工具，就算她在看一条消息里的媒体；
  //   viewTools：主人补的「看媒体的工具」（精确名或 MCP 去掉前缀的名字；私有插件的名字写在主人自己的配置里，默认空）；
  //   maxSteps：最多等她几步（看完以后的想法和回话），到了就把有的交给核心
  media: { enabled: true, viewTools: [], maxSteps: 2 },
  // 她自己的经验（D124）：enabled 关掉就不把工具结果交给核心、不按工具想起经验；nudge：工具先没成、换了做法成了时，下一步提醒她一句可以记成经验
  lessons: { enabled: true, nudge: true },
  egress: {
    appraiseTimeoutMs: 12_000,       // 审视的总时限（LLM 自己 8 秒，§10.6）；超时 = 审不了 → 公开目标改口，其余放行（D113）
    unclassifiedMinChars: 40,        // 没分类的工具，参数里有这么长的自由文本才算「可能在说话」（§9.4.2 第 6 条）
    extraTools: {},                  // 主人补的分类：{工具名: 'speak'|'read'|'none'…}（适配器声明过的工具不认；标成 none / read 要确认）
    maxTargets: 64,                  // 一次调用最多审几个目标场合；更多 = 审不了（D113：公开目标改口，其余放行）
    finalReflection: '这次先不说了',
  },
  // §15.2：桥接自带的记忆先冻结、不退役。精确名或「MCP 前缀 + __ + 名字」都算
  freeze: {
    tools: ['qq_memory_append', 'qq_memory_remove', 'qq_memory_clear', 'qq_note_person'],
    reason: '桥接自带的记忆已经冻结，现在由记忆插件负责：这条不用记，聊过的事会自己记得；主人明确要你记住的，用 memory_note。',
  },
  guards: { breakerErrors: 3, breakerMs: 10 * MIN, slowMs: 100 },   // §10.10
  scheduler: { tickMs: MIN, startDelayMs: 15_000, jobsIdleMs: 5000, jobsBusyMs: 250, jobsMaxMs: 20_000, selfProfileCheckMs: MIN },
  llm: {
    provider: '',                    // 空 = 跟主聊天同一个提供方（宿主默认选择的提供方），都没有就 deepseek-official
    models: { extract: 'deepseek-flash', appraise: 'deepseek-flash', review: 'deepseek-flash', rewrite: 'deepseek-flash', sleep: 'deepseek-flash', summary: 'deepseek-flash', glance: 'deepseek-flash', perceive: 'deepseek-flash' },
    allow: ['deepseek-flash'],       // 允许清单（§10.6：不跟随宿主的默认模型）；附录 G：精确 id，思考关
    effort: 'lowest',                // 'lowest' = 模型支持的最低档（V0 定的是关闭思考）；也可以写死一个档位
    temperature: 0.2,
    timeoutMs: { extract: 60_000, sleep: 60_000, summary: 20_000, rewrite: 8000, appraise: 8000, review: 8000, glance: 6000, perceive: 8000 },
    concurrency: { bg: 1, appraise: 2, review: 1, glance: 2 },   // glance：第一眼（D106）单独一条队列，不和第二段抢
    bgMinSpacingMs: 5000,
    backoffMin: [1, 4, 16],          // 后台队列连续失败的退避
  },
  embedding: {
    provider: 'ollama-native',       // ollama-native / openai-compat（外部服务，管理页可填，D127）/ none（不用嵌入，走 L3）
    url: 'http://127.0.0.1:11434',
    sendDimensions: true,            // openai-compat 请求带 dimensions；不支持这个参数的服务由「测试连接」探出来关掉
    tier: 'standard',                // standard 4B（默认，§17 Q1）/ light 0.6B / custom
    tiers: {
      standard: { model: 'qwen3-embedding:4b', dim: 1024, quant: 'Q4_K_M', vramMb: 4200 },
      light: { model: 'qwen3-embedding:0.6b', dim: 1024, quant: 'Q8_0', vramMb: 1900 },
      custom: { model: '', dim: 0, quant: '', vramMb: 0 },
    },
    numCtx: 1024,
    keepAlive: '2h',                 // 模型闲这么久才卸（实测问题 #1：5 分钟时大多数查询都碰上冷加载，4B 约 3 秒）
    docTplVer: '1',
    timeoutMs: { query: 10_000, doc: 120_000, warm: 60_000, health: 5000 },
    healthMs: 30_000,
    breaker: { failures: 2, coolMs: 60_000 },   // §10.7：连续 2 次失败熔断 60 秒
    docSlice: { cpu: 1, gpu: 16 },   // 文档批切成这么大的小片排队，查询最多等一片（CPU 上一条长文本就要 0.3–0.7 秒，一片一条）
    warmMinGapMs: 20_000,            // 预热最密多久一次
  },
  rerank: { url: '', model: '', command: '', args: [], idleMs: 2 * MIN, timeoutMs: 3000, startTimeoutMs: 60_000 },
  gpu: {
    policy: 'adaptive',              // off / on / adaptive（§8.6.2，默认自适应）
    sampleMs: 15_000,
    processes: [],                   // 主人自己维护的进程名清单（游戏、TTS），是配置数据，不写在代码里
    fullscreen: true,
    vram: { minFreeMb: 1500, returnExtraMb: 2000 },
    busy: { utilPct: 80, seconds: 60 },
    schedule: { enabled: false, from: '20:00', to: '02:00' },
    cooldownMin: 15,
    cpuThreads: { normal: 4, yield: 2 },
    gameMode: { until: 0 },          // 0 = 关；-1 = 直到手动关掉；其余 = 到这个时间（UTC 毫秒）
    gpuErrorHoldMin: 30,             // 「开」档加载失败退回 CPU 后多久再试
    koffiPath: '',                   // 采样器用的 koffi（空 = 自己找宿主自带的那份，见 gpu/sampler.js）
  },
  budget: {
    // 价目报告【建议】另加的输出上限，按预设分；「不设上限」档没有这一项（不设）。主人单独改用核心的 budget.overrides.dailyOutputTokens（D121）
    dailyOutputTokens: { loose: 1_000_000, saving: 300_000 },
    reservedExtractShare: 0.2,       // 超了失控上限之后，对她说的一对一提炼还能用的份额（§10.6）
    // 价目（元 / 百万 token，附录 G）：只用来折算「花了多少」，不做别的判断
    prices: { hit: 0.02, miss: 1, out: 4, peakFactor: 2, peakHours: [[9, 12], [14, 18]], peakTzOffsetMin: 480 },
    balance: { file: '', path: 'balance', everyMs: 10 * MIN },   // 余额来源（配置在私有 kit 里；默认没有）
    quotaProbeMs: 20 * MIN,          // 宿主报了余额用完（402）、又没有余额来源时：停这么久再试一次（成功就恢复，再失败再停）
  },
  self: { coreSelfFile: '', principalLabel: '', locale: 'zh' },
  // 插件自己的 Agent 预设（D112，preset/）：DSH「新建任务」下拉里的一项，选了它就是在跟她聊。id 固定（写进会话记录），这里只配显示。
  //   name 空 = 通用的默认名（人设的名字写在私有 kit 的配置里，scripts/preset-config.mjs）；personaPrefix 空 = 人设行照标准模式；
  //   enabled:false 会让用它开过的旧会话打不开（要确认）
  preset: { enabled: true, name: '', description: '', order: 5, personaPrefix: '' },
  adapters: {
    qq: { enabled: true, bridgeDir: '' },
    // presets：选了这些预设的网页会话算「和主人的 DSH 聊天」。默认就是插件自己的预设；写 [] 关掉，写别的预设要确认
    web: { enabled: true, presets: [PERSONA_PRESET_ID] },
  },
});

/** 这些对象是「开放」的：主人可以加新键（键名自定），值照原样保留。 */
const OPEN_PATHS = new Set(['adapters', 'egress.extraTools', 'adapters.qq', 'adapters.web']);
const ENUMS = {
  'gpu.policy': ['off', 'on', 'adaptive'],
  'embedding.tier': ['standard', 'light', 'custom'],
  'embedding.provider': ['ollama-native', 'openai-compat', 'none'],
};

/** 把用户的 host 配置合到默认值上：类型不对、未知的键忽略并给 warning（开放对象除外）。 */
export function mergeHost(base, over, p = '', warnings = []) {
  if (over === undefined) return base;
  if (isPlain(base)) {
    if (!isPlain(over)) { warnings.push(`host${p ? `.${p}` : ''}：应为对象，忽略`); return base; }
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      const kp = p ? `${p}.${k}` : k;
      if (!(k in base)) {
        if (OPEN_PATHS.has(p) || OPEN_PATHS.has(kp)) { out[k] = v; continue; }
        warnings.push(`host.${kp}：不认识的配置项，忽略`);
        continue;
      }
      // 开放的对象也按键逐个合（不是整个替换）：文件里只写了 adapters.web 的几项时，默认的其余项（例如 presets）还在（D112）
      out[k] = mergeHost(base[k], v, kp, warnings);
    }
    return out;
  }
  const tn = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (tn(over) !== tn(base)) { warnings.push(`host.${p}：应为 ${tn(base)}，忽略`); return base; }
  if (typeof over === 'number' && !Number.isFinite(over)) { warnings.push(`host.${p}：应为有限数字，忽略`); return base; }
  if (ENUMS[p] && !ENUMS[p].includes(over)) { warnings.push(`host.${p}：应为 ${ENUMS[p].join(' / ')} 之一，忽略`); return base; }
  return Array.isArray(over) ? [...over] : over;
}

/** 有风险、要主人确认的改动：路径 → 判断函数（新值有风险时返回提示）。 */
const RISKY = [
  ['host.enabled', (v) => v === false && '关掉整个记忆插件（她不再记得新的事）'],
  ['host.features.freeze', (v) => v === false && '解除对桥接自带记忆的冻结：不能说的内容可能被写进桥接笔记，再注入别的会话（B13）'],
  ['host.features.egress', (v) => v === false && '关掉外发审视：她发到别处的话不再先看一眼'],
  ['host.gpu.policy', (v) => v === 'on' && '显卡「开」档不看显存：玩游戏、开 TTS 时可能换页卡顿'],
  ['host.dataDir', () => '换数据目录要重启插件，旧目录里的记忆不会自动搬过去'],
  ['mode.global', (v) => v !== 'live' && `总开关改成 ${v}`],
  ['budget.overrides.balanceProtectDays', (v) => v === 0 && '关掉余额保护：余额被后台用完时她的聊天也会停（H5）'],
  // D121：重度用户的「不设上限」和单项去掉上限——程序失控时花费不会被拦住，只剩余额保护
  ['budget.preset', (v) => v === 'unlimited' && '换成「不设上限」：后台的调用次数、token 和比例都不设上限，程序失控时也不会被拦住，只剩余额保护（余额不够 1 天时停后台）'],
  ['budget.overrides.dailyCalls', (v) => v === null && '去掉每天后台调用次数的上限：程序失控时不会被拦住'],
  ['budget.overrides.dailyUncachedTokens', (v) => v === null && '去掉每天未命中缓存输入的上限：程序失控时不会被拦住'],
  ['budget.overrides.dailyOutputTokens', (v) => v === null && '去掉每天输出的上限：程序失控时不会被拦住'],
  // D112：哪些会话算「在跟她聊」——算进去的会话会被记住、会收到她的记忆
  ['host.adapters.web.presets', (v) => Array.isArray(v) && v.some((x) => x !== PERSONA_PRESET_ID)
    && '让别的预设开的会话也算跟她聊：那些会话会被记住、会收到她的记忆（例如写代码的会话）'],
  ['host.adapters.web.sessionIds', (v) => Array.isArray(v) && v.length > 0 && '手动指定的会话也算跟她聊：那些会话会被记住、会收到她的记忆'],
  ['host.adapters.web.requireClientTimeZone', (v) => v === false && '不再要求是 DSH 界面里亲手发的消息（以主人身份连进来的 API 客户端也会被当成主人）'],
  ['host.preset.enabled', (v) => v === false && '新建任务里的预设会消失；用它开过的旧会话在重新打开它之前都打不开'],
  ['host.egress.extraTools', (v) => isPlain(v) && Object.values(v).some((c) => c === 'none' || c === 'read')
    && `把工具标成「不说话」或「只读」（${Object.entries(v).filter(([, c]) => c === 'none' || c === 'read').map(([k]) => k).slice(0, 5).join('、')}）：她用这些工具发出去的话不再先看一眼`],
];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function setPath(o, p, v) {
  const ks = p.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (!isPlain(cur[k])) cur[k] = {}; cur = cur[k]; }
  if (v === undefined) delete cur[ks.at(-1)]; else cur[ks.at(-1)] = structuredClone(v);
}
/**
 * 热加载：文件里有风险、和现在生效的值不一样的改动先扣下（沿用 prev 的值）。allow 里是主人已经确认过的（路径 + 值都对得上才放）。
 * @returns {{next: object, held: {path: string, reason: string, value: unknown}[]}}
 */
function holdRisky(prev, fileUser, allow = []) {
  const next = structuredClone(fileUser);
  const held = [];
  for (const [p, risky] of RISKY) {
    const nv = getPath(fileUser, p);
    const ov = getPath(prev, p);
    if (nv === undefined || sameJson(nv, ov)) continue;
    let why = false;
    try { why = risky(nv); } catch { why = '这项改动没法判断风险'; }
    if (!why) continue;
    if (allow.some((a) => a.path === p && sameJson(a.value, nv))) continue;
    setPath(next, p, ov);
    held.push({ path: p, reason: String(why), value: structuredClone(nv) });
  }
  return { next, held };
}
/** 不能经配置改的项（§12.6、D56）。 */
const FORBIDDEN = [['retention', '保留期只能在管理页「设置 → 保留期」里改（要确认语和 7 天冷静期）']];

function getPath(o, p) {
  let v = o;
  for (const k of p.split('.')) { if (!isPlain(v) || !(k in v)) return undefined; v = v[k]; }
  return v;
}
function deepMergePlain(a, b) {
  if (!isPlain(b)) return b;
  const out = isPlain(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) out[k] = isPlain(v) && isPlain(out[k]) ? deepMergePlain(out[k], v) : v;
  return out;
}

/**
 * @typedef {object} ConfigStore
 * @property {import('rugu-core').ConfigHandle} core   交给核心的热加载句柄
 * @property {() => typeof HOST_DEFAULTS} host                   集成层的当前快照（深冻结）
 * @property {() => {host: object, core: object, file: string, warnings: string[], loadError: string|null}} get
 * @property {(patch: object, opt?: {confirm?: boolean, replace?: string[]}) => {ok: boolean, warnings: string[], needsConfirm?: string[], rejected?: string[]}} set
 *   replace：这些路径整个换成补丁里的值（不和文件里原来的合并；例：budget.overrides 回到预设时清空）
 * @property {() => boolean} reload                              文件改过就重读（每分钟 tick 调一次）；有风险的改动先扣下
 * @property {() => {path: string, reason: string}[]} pending    热加载时扣下、等主人确认的改动
 * @property {(opt?: {confirm?: boolean}) => {ok: boolean, warnings: string[], needsConfirm?: string[], applied?: number}} applyPending
 * @property {() => {ok: boolean, warnings: string[]}} discardPending   丢弃扣下的改动：按现在生效的值重写配置文件
 * @property {(fn: (host: object) => void) => () => void} onHostChange
 */

/**
 * @param {{file: string, initial?: object, defaults?: {core?: object, host?: object}, fsImpl?: typeof fs, onWarn?: (w: string[]) => void}} opt
 *   initial：Cordis 行的 config（比文件优先级低）；defaults：集成层给核心配置补的默认值（备份密钥文件之类的路径）
 * @returns {ConfigStore}
 */
export function createConfigStore({ file, initial = {}, defaults = {}, fsImpl = fs, onWarn = () => {} }) {
  let user = {};
  let warnings = [];
  let loadError = null;
  let mtime = 0;
  let host = HOST_DEFAULTS;
  /** @type {{path: string, reason: string, value: unknown}[]} */
  let pending = [];
  const hostListeners = new Set();
  const coreHandle = createConfig({}, { onWarn: (w) => { warnings = [...warnings, ...w]; try { onWarn(w); } catch { /* 忽略 */ } } });

  const split = (u) => {
    const { host: h, ...core } = isPlain(u) ? u : {};
    return { host: isPlain(h) ? h : {}, core };
  };
  const apply = (nextUser) => {
    const w = [];
    const merged = deepMergePlain(deepMergePlain({}, initial), nextUser);
    const parts = split(merged);
    const nextHost = deepFreeze(mergeHost(HOST_DEFAULTS, deepMergePlain(defaults.host ?? {}, parts.host), '', w));
    warnings = w;
    const coreUser = deepMergePlain(defaults.core ?? {}, parts.core);
    coreHandle.replace(coreUser);
    const changed = JSON.stringify(nextHost) !== JSON.stringify(host);
    host = nextHost;
    user = nextUser;
    if (w.length) { try { onWarn(w); } catch { /* 忽略 */ } }
    if (changed) for (const fn of hostListeners) { try { fn(host); } catch { /* 监听器出错不影响别人 */ } }
  };
  const readFile = () => {
    try {
      const st = fsImpl.statSync(file, { throwIfNoEntry: false });
      mtime = st ? st.mtimeMs : 0;
      if (!st) return {};
      const v = readJson(file, {});
      loadError = null;
      return isPlain(v) ? v : {};
    } catch (e) {
      loadError = e?.code ?? 'READ_FAILED';
      return null;   // 坏了：保持当前值
    }
  };
  const first = readFile();
  apply(first ?? {});

  return Object.freeze({
    core: coreHandle,
    host: () => host,
    get: () => ({ host, core: coreHandle.get(), file, warnings: [...warnings], loadError, pendingRisky: pending.map(({ path, reason }) => ({ path, reason })) }),
    set(patch, opt = {}) {
      if (!isPlain(patch)) return { ok: false, warnings: ['补丁应为对象'] };
      const rejected = FORBIDDEN.filter(([p]) => getPath(patch, p) !== undefined).map(([, why]) => why);
      if (rejected.length) return { ok: false, warnings: [], rejected };
      // 和现在已经生效的值一样的不算改动（例：余额保护已经是 0，这次只是改了别的项），不用再确认
      const needsConfirm = RISKY.map(([p, risky]) => { const v = getPath(patch, p); return v === undefined || sameJson(v, getPath(user, p)) ? null : risky(v); }).filter(Boolean);
      if (needsConfirm.length && opt.confirm !== true) return { ok: false, warnings: [], needsConfirm };
      if (loadError) return { ok: false, warnings: [`配置文件读不了（${loadError}），先修好它再在这里改`] };
      const next = deepMergePlain(user, patch);
      for (const p of Array.isArray(opt.replace) ? opt.replace : []) {
        if (typeof p === 'string' && p) setPath(next, p, getPath(patch, p));
      }
      try { writeJsonAtomic(file, next); } catch (e) { return { ok: false, warnings: [`写配置文件失败：${e?.code ?? 'Error'}`] }; }
      try { mtime = fsImpl.statSync(file).mtimeMs; } catch { /* 忽略 */ }
      // 配置文件按现在生效的值（加这次的补丁）重写了：热加载时扣下的改动就此丢弃
      const dropped = pending.filter((x) => getPath(patch, x.path) === undefined).length;
      pending = [];
      apply(next);
      return { ok: true, warnings: [...warnings, ...(dropped ? [`配置文件里有 ${dropped} 项待确认的改动没有生效，已按现在的设置重写`] : [])] };
    },
    reload() {
      let st;
      try { st = fsImpl.statSync(file, { throwIfNoEntry: false }); } catch { return false; }
      const m = st ? st.mtimeMs : 0;
      if (m === mtime) return false;
      const v = readFile();
      if (v === null) return false;
      // user 里是现在生效的值（扣着的那几项还是旧值），每次都拿文件和它比：扣着的、文件里没变回去的继续扣着
      const { next, held } = holdRisky(user, v);
      const fresh = held.filter((h) => !pending.some((x) => x.path === h.path && sameJson(x.value, h.value)));
      pending = held;
      if (fresh.length) { try { onWarn(fresh.map((x) => `配置文件里的改动要先在管理页确认：${x.reason}`)); } catch { /* 忽略 */ } }
      apply(next);
      return true;
    },
    pending: () => pending.map(({ path, reason }) => ({ path, reason })),
    applyPending(opt = {}) {
      if (!pending.length) return { ok: true, warnings: [], applied: 0 };
      if (opt.confirm !== true) return { ok: false, warnings: [], needsConfirm: pending.map((x) => x.reason) };
      const v = readFile();
      if (v === null) return { ok: false, warnings: [`配置文件读不了（${loadError}）`] };
      const confirmed = pending;
      const { next, held } = holdRisky(user, v, confirmed);
      const applied = confirmed.filter((x) => sameJson(getPath(v, x.path), x.value)).length;
      pending = held;
      apply(next);
      return { ok: true, warnings: [...warnings], applied };
    },
    discardPending() {
      if (!pending.length) return { ok: true, warnings: [] };
      if (loadError) return { ok: false, warnings: [`配置文件读不了（${loadError}），先修好它`] };
      try { writeJsonAtomic(file, user); } catch (e) { return { ok: false, warnings: [`写配置文件失败：${e?.code ?? 'Error'}`] }; }
      try { mtime = fsImpl.statSync(file).mtimeMs; } catch { /* 忽略 */ }
      pending = [];
      return { ok: true, warnings: [] };
    },
    onHostChange(fn) { hostListeners.add(fn); return () => hostListeners.delete(fn); },
  });
}
