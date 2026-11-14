// 「设置」七个小节和首次设置向导要的只读视图（D173，管理页重做的「设置 + 关于 + 首次设置」这一路）。
// 和 views.js 同一个规矩：只给页面要的字段；没有聊天内容；账号、Key、地址只在主人自己配置过的地方出现（数据目录、配置文件的路径只在「关于」里）。
// 几个纯函数单独导出给测试：costCeiling（花费档位的「上限」）、recentAverage（最近 7 天平均）、checkupItems（诊断页顶上的「自查」）、
// diagSummary（「复制诊断信息」）。
// views.js 和这个文件互相引用：这里用到的都只在函数里调（不在模块加载时取值），ESM 的循环引用没有问题。
import { budgetSummary, budgetConfigView, llmHealthRow, adapterTitle, RETENTION_ORDER } from './views.js';
import { DEFAULT_PRESET_NAME } from '../preset/index.js';
import { pluginVersion } from '../host/llm-setup.js';
import { HOST_DEFAULTS } from '../host/config.js';
import { DEFAULTS } from 'rugu-core';

const DAY = 86_400_000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

/** 首次设置模式（还没有核心）下也能用的视图：向导要它们。 */
export const SETUP_MODE_VIEWS = Object.freeze(['wizard']);

/** 人设开头最多多少字（和 preset/index.js 的 PREFIX_MAX 一致：超过的预设不用它）。 */
export const PREFIX_MAX = 2000;
/** 仓库和文档（「关于」里的链接；外部链接在页面里用新窗口打开，DSH 交给系统浏览器）。 */
export const LINKS = Object.freeze({
  repo: 'https://github.com/QiuYeDx/dsh-rugu',
  issues: 'https://github.com/QiuYeDx/dsh-rugu/issues',
  license: 'https://github.com/QiuYeDx/dsh-rugu/blob/main/LICENSE',
  docs: 'https://github.com/QiuYeDx/dsh-rugu#readme',
  cost: 'https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/%E8%8A%B1%E8%B4%B9.md',
  bridge: 'https://github.com/h-D-ACE/dsh-qq',
});

// ════════════════════════════════════════════════════════════════════════
// 花费档位的「上限」（设计说明 8.3 第 5 条：不编数）
// ════════════════════════════════════════════════════════════════════════
/**
 * 每次调用最多用多少 token（按 docs/花费.md 第 1 节的表取偏大的那头）：
 *   提炼一次输入最多约 8000（固定前缀约 3.6k + 一段对话最多 4000 字和背景）、输出上限 4000；
 *   第一眼输入约 2700、输出上限 600；外发审视输入约 1500、输出上限 260；
 *   任何一次调用的输入都不到 1 万 token（夜间整理一次最多约 10k），用它给「命中缓存的输入」封顶。
 */
export const PER_CALL = Object.freeze({ extract: { in: 8000, out: 4000 }, glance: { in: 2700, out: 600 }, review: { in: 1500, out: 260 }, maxIn: 10_000 });
const finiteCap = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * 一档每天最坏花多少钱（元）。按 ports/budget.js 的护栏推：
 *   - 未命中缓存的输入不超过 dailyUncachedTokens、输出不超过 dailyOutputTokens（到了上限之后的调用一律挡下）；
 *   - 命中缓存的输入没有单独的上限：按 dailyCalls × 每次最多 1 万 token 封顶（调用次数也不设上限时说不出来，cachedOpen = true）；
 *   - 超了上限以后还有三小份预留不受 token 上限管：对她说的一对一提炼最多 dailyCalls × reservedExtractShare 次、
 *     第一眼 glanceReservePerDay 次、外发审视 egressReservePerDay 次（审视本来就不受预设管），每次按上面 PER_CALL 的最大量算；
 *   - 全按空闲价算一个数，全按高峰价（× peakFactor）算一个数。
 * 每天未命中输入或输出不设上限（「效果优先」、自定义去掉了上限）→ capped: false（「不设每天的上限」）。
 * @param {{dailyCalls?: number|null, dailyUncachedTokens?: number|null, dailyOutputTokens?: number|null, egressReservePerDay?: number, glanceReservePerDay?: number}} L
 *   null / Infinity = 不设
 * @param {{hit: number, miss: number, out: number, peakFactor?: number}} prices  元 / 百万 token
 * @param {{reservedExtractShare?: number}} [o]
 */
export function costCeiling(L, prices, { reservedExtractShare = 0.2 } = {}) {
  if (!isObj(prices) || ![prices.hit, prices.miss, prices.out].every((x) => typeof x === 'number' && Number.isFinite(x))) return { capped: null };
  if (!finiteCap(L?.dailyUncachedTokens) || !finiteCap(L?.dailyOutputTokens)) return { capped: false };
  const f = typeof prices.peakFactor === 'number' && prices.peakFactor > 0 ? prices.peakFactor : 1;
  const yuan = (miss, hit, out) => (miss * prices.miss + hit * prices.hit + out * prices.out) / 1e6;
  const calls = finiteCap(L.dailyCalls) ? L.dailyCalls : null;
  const cachedMax = calls != null ? calls * PER_CALL.maxIn : 0;
  const base = yuan(L.dailyUncachedTokens, cachedMax, L.dailyOutputTokens);
  const extract = calls != null ? Math.ceil(calls * reservedExtractShare) : null;
  const glance = Number.isFinite(L.glanceReservePerDay) ? L.glanceReservePerDay : 0;
  const review = Number.isFinite(L.egressReservePerDay) ? L.egressReservePerDay : 0;
  const reserve = (extract ?? 0) * yuan(PER_CALL.extract.in, 0, PER_CALL.extract.out)
    + glance * yuan(PER_CALL.glance.in, 0, PER_CALL.glance.out) + review * yuan(PER_CALL.review.in, 0, PER_CALL.review.out);
  return {
    capped: true,
    offPeak: round2(base), peak: round2(base * f),
    reserveOffPeak: round2(reserve), reservePeak: round2(reserve * f),
    reserveCalls: { extract, glance, review },
    // 调用次数不设上限：命中缓存的输入和一对一提炼的预留都封不了顶，数字是不含它们的
    cachedOpen: calls == null,
  };
}

/** YYYY-MM-DD 往前推 n 天（按日历算，不管时区）。 */
function dayBefore(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - n * DAY;
  return new Date(t).toISOString().slice(0, 10);
}
/**
 * 「最近 7 天平均一天」（真实的记账）：今天之前的 7 个日历日里，记账文件有那一天的行就算进去（插件没开着的日子没有行，不算 0），
 * 后台元按天加起来除以有行的天数。一行都没有 → null（页面不显示这一行）。
 * @param {{day: string|null, history: {day: string, bgYuan: number|null, calls: number|null}[]}} b  budgetSummary 的 today.day 和 history
 */
export function recentAverage(b) {
  const today = b?.today?.day ?? b?.day ?? null;
  if (!today) return null;
  const want = new Set(Array.from({ length: 7 }, (_, i) => dayBefore(today, i + 1)).filter(Boolean));
  const rows = (Array.isArray(b?.history) ? b.history : []).filter((h) => h && want.has(h.day));
  if (!rows.length) return null;
  const yuan = rows.reduce((a, h) => a + (num(h.bgYuan) ?? 0), 0);
  const calls = rows.reduce((a, h) => a + (num(h.calls) ?? 0), 0);
  return { days: rows.length, yuan: Math.round((yuan / rows.length) * 10000) / 10000, calls: Math.round(calls / rows.length) };
}

/**
 * 三档卡片要的数（页面照着画，不自己算）：每档的上限（costCeiling）、这一档的意思；现在选的那一档再带最近 7 天平均。
 * 每档的上限按核心那一档的预设（不含主人的自定义）+ 宿主每档的输出上限算；现在是自定义时，现在那一档另算一份 effective。
 * @param {ReturnType<typeof budgetConfigView>} bc
 * @param {ReturnType<typeof budgetSummary>} bud
 * @param {any} hostCfg
 */
export function costTiers(bc, bud, hostCfg) {
  const prices = bud?.prices ?? hostCfg?.budget?.prices ?? HOST_DEFAULTS.budget.prices;
  const share = num(hostCfg?.budget?.reservedExtractShare) ?? HOST_DEFAULTS.budget.reservedExtractShare;
  const reserves = { egressReservePerDay: num(bud?.limits?.egressReservePerDay) ?? DEFAULTS.budget.egressReservePerDay, glanceReservePerDay: DEFAULTS.budget.glanceReservePerDay };
  const priceKnown = bud?.priceKnown !== false;
  const recent = bud ? recentAverage(bud) : null;
  const of = (vals) => (priceKnown ? costCeiling({ ...vals, ...reserves }, prices, { reservedExtractShare: share }) : { capped: null, unpriced: true });
  const tiers = ['saving', 'loose', 'unlimited'].map((k) => ({ key: k, ceiling: of(bc?.presets?.[k] ?? {}), current: bc?.preset === k }));
  return {
    tiers,
    custom: !!bc?.custom,
    effective: bc?.custom ? of(bc.effective ?? {}) : null,
    priceKnown,
    recent: recent && priceKnown ? recent : recent ? { days: recent.days, calls: recent.calls, yuan: null } : null,
    prices: priceKnown ? { hit: prices.hit, miss: prices.miss, out: prices.out, peakFactor: prices.peakFactor ?? 1 } : null,
    reservedExtractShare: share,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 诊断页顶上的「自查」（丁1）
// ════════════════════════════════════════════════════════════════════════
const ENTRY_NAME = Object.freeze({ qq: 'QQ', 'dsh-web': 'DSH 桌面', bili: 'B站' });
/**
 * 「她没反应 / 记不住」时自己能找到原因：每项一句结论 + 去哪儿修。纯函数，测试直接喂数据。
 * state：bad（这就是问题）/ warn（要留意）/ ok / dim（不算问题，例如你自己选的「不用」）。有问题的排在前面。
 * fix：{label, to}（to 是新页面的路由；'wizard' 是首次设置）。时间（heardAt / injectedAt）交给页面按本地时间写。
 * @param {object} x
 * @returns {{key: string, state: 'bad'|'warn'|'ok'|'dim', title: string, text?: string|null, heardAt?: number|null, injectedAt?: number|null, fix?: {label: string, to: string}|null}[]}
 */
export function checkupItems(x) {
  const out = [];
  const add = (key, state, title, text = null, fix = null, extra = {}) => out.push({ key, state, title, text, fix, ...extra });
  // 首次设置
  if (x.setup?.needed) add('setup', 'bad', '还没走完首次设置', '走完之前插件不开库，什么都不记、也想不起来。', { label: '去设置', to: 'wizard' });
  // 记忆库
  if (x.store?.error) add('store', 'bad', '记忆库读不出来', '她现在不记新的事、也想不起以前的事。看下面「开发者明细」里的启动步骤。', { label: '看明细', to: 'settings/diag?dev=1' });
  else if (x.store?.readOnly) add('store', 'bad', '记忆库现在是只读的', x.store.newer ? '数据的版本比插件新，可能是插件被换回了旧版本。装回新版本就好。' : '库被别的程序占着，或者数据有问题；她不记新的事。', { label: '看明细', to: 'settings/diag?dev=1' });
  else if (x.store) add('store', 'ok', '记忆库正常');
  // 总开关和场合
  const m = x.mode;
  if (m?.global === 'off') add('master', 'bad', '记忆总开关关着', '她在哪儿都不记新的事、也不把记忆放进对话。', { label: '去打开', to: 'settings/basic' });
  else if (m) {
    const offDefaults = [['principalOneOnOne', '和你一对一'], ['closed', '封闭的群'], ['public', '公开场合']].filter(([k]) => m.byAttributes?.[k] === 'off').map(([, n]) => n);
    if (offDefaults.length) add('master', 'warn', `新场合默认不记：${offDefaults.join('、')}`, '这类场合新出现时她不记，除非在「场合」里单独打开。', { label: '去改', to: 'settings/basic' });
    else add('master', 'ok', '总开关开着');
  }
  const p = x.places;
  if (p && p.total > 0 && p.off >= p.total) add('places', 'warn', '所有场合都关着', '她哪儿都不记。在「场合」里打开要记的那几个。', { label: '去场合', to: 'places/list' });
  else if (p && p.off > 0) add('places', 'dim', `${p.off} 个场合关着`, '你关的那几个她不记、也不想起；别的照常。', { label: '去场合', to: 'places/list' });
  // 各入口：最近一次收到消息、最近一次把记忆放进对话
  for (const e of Array.isArray(x.entries) ? x.entries : []) {
    const name = ENTRY_NAME[e.adapter] ?? e.name ?? adapterTitle(e.adapter);
    const key = `entry.${e.adapter}`;
    const times = { heardAt: num(e.lastAt), injectedAt: num(e.injectedAt) };
    if (!e.connected) { add(key, 'dim', `${name}：没接着`, '这个入口现在没有加载。', e.adapter === 'qq' ? { label: '去接入', to: 'settings/connect' } : null, times); continue; }
    if (e.lastAt == null) {
      add(key, 'warn', `${name}：还没收到过消息`, e.adapter === 'dsh-web' ? '在 DSH 新建任务时选「人设聊天」，在那个对话里说的话才算。' : e.adapter === 'qq' ? '桥接接上以后，她在的群和私聊里有人说话就会出现。' : null,
        e.adapter === 'qq' ? { label: '去接入', to: 'settings/connect' } : e.adapter === 'dsh-web' ? null : { label: '去场合', to: 'places/list' }, times);
      continue;
    }
    add(key, 'ok', `${name}：在收消息`, e.injectedAt == null ? '还没把记忆放进过这里的对话（没有用得上的记忆时就不放）。' : null, null, times);
  }
  // 「人设聊天」预设
  const pr = x.preset;
  if (pr) {
    const nm = `「${pr.name || DEFAULT_PRESET_NAME}」`;
    if (pr.enabled === false) add('preset', 'warn', `${nm}预设关着`, '新建任务的列表里没有它，用它开过的旧对话也打不开。', null);
    else if (pr.broken) add('preset', 'bad', `${nm}在列表里，但 DSH 打不开它`, '选它开不了对话。看下面「开发者明细」里自检的「预设」一项。', { label: '看明细', to: 'settings/diag?dev=1' });
    else if (!pr.registered) add('preset', 'bad', `${nm}不在 DSH 新建任务的列表里`, '在 DSH 桌面里就没法和她聊。彻底重启 DSH 再看；还不行就看「开发者明细」。', { label: '看明细', to: 'settings/diag?dev=1' });
    else if (pr.listed === false) add('preset', 'warn', `DSH 的列表里还看不到${nm}`, '刚启动时可能要等一会儿；一直这样就彻底重启 DSH。');
    else add('preset', 'ok', `${nm}在 DSH 新建任务的列表里`);
  }
  // QQ 桥接
  const q = x.qq;
  if (!q || !q.configured) add('qq', 'dim', '没接 QQ', '不接也能用，只是没有 QQ 这个入口。', { label: '去接入', to: 'settings/connect' });
  else if (!q.isBridge) add('qq', 'bad', 'QQ 桥接的目录不对', '那个目录不像 dsh-qq 桥接，QQ 里的消息她听不到。', { label: '去改', to: 'settings/connect' });
  else if (q.secondGen === false) add('qq', 'bad', 'QQ 桥接不是二代模式', '只有二代模式才会把群里的消息写下来，现在 QQ 里的话她都听不到。在桥接里切到二代模式。', { label: '看说明', to: 'settings/connect' });
  else if (q.whitelist && q.whitelist.readable === false) add('qq', 'warn', '读不到桥接的白名单文件', '没法确认她在 QQ 里能不能用记忆。', { label: '去看看', to: 'settings/connect' });
  else if (q.whitelist && q.whitelist.patched === false) add('qq', 'warn', 'QQ 里她还用不了记忆', '要给桥接打一个小补丁（放行记忆工具），打完彻底重启 DSH。', { label: '去打补丁', to: 'settings/connect' });
  else add('qq', 'ok', q.secondGen == null ? 'QQ 桥接接上了（没读到模式）' : 'QQ 桥接接上了，二代模式');
  // 想起来的方式
  const em = x.embedding;
  if (em?.off) add('embedding', 'dim', '想起来的方式：只按字面找（你选的「不用」）', '换个说法问同一件事时可能想不起来。', { label: '去换', to: 'settings/models' });
  else if (!em || em.error) add('embedding', 'warn', '想起来的方式读不出来', null, { label: '去看看', to: 'settings/models' });
  else if (em.suspect) add('embedding', 'bad', '想起来的方式的模型可能被换过', '现在只按字面找。到「模型 · 技术细节」确认用现在这个模型。', { label: '去看看', to: 'settings/models' });
  else if (em.breakerOpen || !em.dense) add('embedding', 'warn', '想起来的方式连不上，现在只按字面找', '本机 Ollama 没开、或者模型没下载。', { label: '去看看', to: 'settings/models' });
  else add('embedding', 'ok', '想起来的方式正常');
  // 后台模型
  const lm = x.llm;
  if (!lm || lm.error) add('llm', 'warn', '后台模型的状态读不出来', null, { label: '去看看', to: 'settings/models' });
  else if (lm.state === 'off') add('llm', 'dim', '没用后台模型（你选的）', '原话照记，但她不会自己整理出事实和经历。', { label: '去换', to: 'settings/models' });
  else if (lm.state === 'down' && lm.fallback) add('llm', 'warn', '后台模型不工作，在用聊天的模型顶着', lm.reason ? `原因：${lm.reason}。可能更贵；修好以后自动换回。` : '可能更贵；修好以后自动换回。', { label: '去修', to: 'settings/models' });
  else if (lm.state === 'down') add('llm', 'bad', '后台模型不工作', `${lm.reason ? `原因：${lm.reason}。` : ''}她记不住新的事、回想变少，聊天照常。`, { label: '去修', to: 'settings/models' });
  else if (lm.state === 'flaky') add('llm', 'warn', '后台模型最近不稳定', '一半的调用没成，会自己重试；一直这样就换一个。', { label: '去看看', to: 'settings/models' });
  else if (lm.state === 'unknown') add('llm', 'dim', '后台模型还没用过', '可以到「模型」里点「试一下」。', { label: '去试', to: 'settings/models' });
  else add('llm', 'ok', '后台模型正常');
  // 今天的花费
  const b = x.budget;
  if (b?.error) add('budget', 'warn', '花费的记账读不出来', null, { label: '去看看', to: 'settings/cost' });
  else if (b?.paused) add('budget', 'bad', '余额快用完了，后台整理先停了', '聊天照常，原话都存着；余额够了会接着整理。', { label: '看花费', to: 'settings/cost' });
  else if (b && b.capped > 0) add('budget', 'warn', '今天的后台花费到了上限', `今天有 ${b.capped} 次整理没做（零点清零后接着做）。用得多可以换一档。`, { label: '看花费', to: 'settings/cost' });
  else if (b && b.sourceCapped > 0) add('budget', 'dim', '今天没到花费上限', `有一个群或私聊说得太多，${b.sourceCapped} 次整理先让给了别处（防止一个群把额度用完）。`, { label: '看花费', to: 'settings/cost' });
  else if (b) add('budget', 'ok', '今天没到花费上限');
  // 启动自检
  const sc = x.selfCheck;
  if (sc?.error) add('selfcheck', 'warn', '启动自检没跑成', null, { label: '看明细', to: 'settings/diag?dev=1' });
  else if (sc && sc.failed > 0) add('selfcheck', 'warn', `启动自检有 ${sc.failed} 项没通过`, '对应的功能先关了，聊天不受影响。', { label: '看明细', to: 'settings/diag?dev=1' });
  else if (sc) add('selfcheck', 'ok', '启动自检都通过了');
  const rank = { bad: 0, warn: 1, ok: 2, dim: 3 };
  return out.map((it, i) => ({ it, i })).sort((a, z) => rank[a.it.state] - rank[z.it.state] || a.i - z.i).map(({ it }) => it);
}

/**
 * 「复制诊断信息」（提 Issue 用）：版本、自查的结论、后台模型的摘要（D168，不含聊天内容、地址、Key）、各项计数。
 * 不含任何聊天内容、名字、群名、账号、路径。纯函数。
 */
export function diagSummary(x) {
  return {
    kind: 'rugu-diagnostics',
    at: x.now ?? null,
    versions: { plugin: x.plugin ?? null, schema: x.schema ?? null, codeSchema: x.codeSchema ?? null },
    checkup: (x.checkup ?? []).map((c) => ({ key: c.key, state: c.state })),
    selfCheck: x.selfCheck && !x.selfCheck.error ? { total: x.selfCheck.total ?? null, failed: x.selfCheck.failed ?? 0, warned: x.selfCheck.warned ?? 0, failedIds: (x.selfCheck.failedIds ?? []).slice(0, 20) } : { error: x.selfCheck?.error ?? null },
    llm: x.llmSummary ?? null,
    embedding: x.embedding ? { off: !!x.embedding.off, dense: !!x.embedding.dense, breakerOpen: !!x.embedding.breakerOpen } : null,
    budget: x.budget ? { preset: x.budget.preset ?? null, custom: !!x.budget.custom, callsToday: x.budget.calls ?? null, cappedToday: x.budget.capped ?? 0, paused: !!x.budget.paused, priceKnown: x.budget.priceKnown !== false } : null,
    places: x.places ?? null,
    entries: (x.entries ?? []).map((e) => ({ adapter: e.adapter, connected: !!e.connected, places: e.places ?? 0, heard: e.lastAt != null, injected: e.injectedAt != null })),
    backup: x.backup ?? null,
    store: x.store ? { readOnly: !!x.store.readOnly } : null,
  };
}

// ════════════════════════════════════════════════════════════════════════
// 视图
// ════════════════════════════════════════════════════════════════════════
/**
 * @param {{pm: any, host: any, now: () => number, config: () => ReturnType<typeof configParts>, hostStatus: () => Promise<any>,
 *          selfCheck: (force?: boolean) => Promise<any>, gpuView: (cfgHost: any) => Promise<any>, part: (fn: Function, ms?: number) => Promise<any>,
 *          exportDir?: () => string|null}} d
 */
export function createSettingsViews(d) {
  const { pm, host, now, config, part } = d;
  const hostOf = (k) => (host && typeof host === 'object' ? host[k] : undefined);
  const canWrite = () => typeof hostOf('config')?.set === 'function';

  /** 设置页顶上的提示（还没套用的配置改动、配置文件读不了、只读）和小导航上的提醒点。 */
  async function head() {
    const cfg = config();
    const [st, backup, hs] = await Promise.all([
      pm ? part(() => pm.status()) : null,
      pm ? part(() => pm.admin.backup.overview()) : null,
      part(async () => (hostOf('llmSetup') ? llmHealthRow(await hostOf('llmSetup').status()) : null)),
    ]);
    const store = st && !st.error ? { readOnly: !!st.readOnly, newer: st.readOnlyReason === 'newer-schema' || (num(st.schemaVersion) ?? 0) > (num(st.codeSchemaVersion) ?? Infinity) } : st?.error ? { error: st.error } : null;
    return {
      pendingRisky: cfg.pendingRisky, loadError: cfg.loadError, canWrite: canWrite() && !cfg.loadError, store,
      dots: {
        backup: !!(backup && !backup.error && (backup.failed > 0 || backup.lowDisk || (backup.lastDrill && !backup.lastDrill.ok))),
        models: !!(hs && !hs.error && (hs.state === 'down' || hs.state === 'flaky')),
        diag: !!(store?.readOnly || store?.error),
      },
    };
  }

  /** 她是谁：称呼、名字和昵称、预设名、人设开头（都在宿主配置里：host.self、host.adapters.qq、host.preset）。 */
  function persona(cfgHost, hs) {
    const h = isObj(cfgHost) ? cfgHost : {};
    const names = Array.isArray(h.adapters?.qq?.selfNames) ? h.adapters.qq.selfNames.filter((x) => typeof x === 'string' && x.trim()).slice(0, 16) : [];
    const ps = hs && !hs.error && isObj(hs.preset) ? hs.preset : null;
    const roster = Array.isArray(hs?.preset?.roster) ? hs.preset.roster : null;
    return {
      principalLabel: str(h.self?.principalLabel, 20) ?? '', principalDefault: '主人',
      selfNames: names,
      presetName: str(h.preset?.name, 40) ?? '', presetDefault: DEFAULT_PRESET_NAME,
      personaPrefix: typeof h.preset?.personaPrefix === 'string' ? h.preset.personaPrefix.slice(0, PREFIX_MAX) : '', prefixMax: PREFIX_MAX,
      preset: ps ? { enabled: ps.enabled !== false, registered: !!ps.registered, name: str(ps.name, 40), broken: !!ps.broken, listed: roster ? roster.some((r) => r?.id === ps.id) : null } : null,
    };
  }

  /** 各入口最近一次把记忆放进对话：最近 200 次注入里按场合认入口（不含常驻区）。 */
  function injectedAtByAdapter(settings) {
    const out = {};
    try {
      const adapterOf = new Map(settings.map((s) => [s.key, s.adapter]));
      for (const r of pm.admin.list({ view: 'injections', limit: 200 }).items ?? []) {
        if (r.layer === 'resident') continue;
        const a = adapterOf.get(r.settingKey);
        if (a && out[a] == null) out[a] = num(r.ts);
      }
    } catch { /* 读不出来就不写时间 */ }
    return out;
  }
  function allSettings() {
    const items = [];
    try {
      let next;
      for (let i = 0; i < 5; i++) {
        const p = pm.admin.list({ view: 'settings', limit: 200, ...(next ? { next } : {}) });
        items.push(...(p.items ?? []));
        next = p.next;
        if (!next) break;
      }
    } catch { /* 读不出来就当没有 */ }
    return items;
  }
  /** 场合的数：按入口分开的 在记 / 关着。 */
  function placeCounts(settings) {
    const by = {};
    for (const s of settings) {
      const a = String(s.adapter ?? 'other');
      const c = (by[a] ??= { total: 0, live: 0, off: 0 });
      c.total += 1;
      if (s.mode === 'off' || s.doNotRemember) c.off += 1; else c.live += 1;
    }
    const total = Object.values(by).reduce((n, c) => n + c.total, 0);
    const off = Object.values(by).reduce((n, c) => n + c.off, 0);
    return { total, off, live: total - off, byAdapter: by };
  }

  async function bridgeView() {
    const b = hostOf('bridgeSetup');
    if (!b) return null;
    return part(() => b.status({}));
  }

  return {
    names: ['setHead', 'setBasic', 'setModels', 'setConnect', 'setCost', 'setDiag', 'setAbout', 'wizard'],
    views: {
      setHead: head,

      // ── 基本：她是谁、记忆开关、原话保留多久、更多（用法说明的写法、成长怎么生效） ──
      async setBasic() {
        const cfg = config();
        const [retention, hs] = await Promise.all([part(() => pm.admin.retention.get()), d.hostStatus()]);
        const m = isObj(cfg.core?.mode) ? cfg.core.mode : null;
        return {
          who: persona(cfg.host, hs),
          mode: m ? { global: m.global ?? null, byAttributes: { principalOneOnOne: m.byAttributes?.principalOneOnOne ?? null, closed: m.byAttributes?.closed ?? null, public: m.byAttributes?.public ?? null } } : null,
          retention, retentionOptions: RETENTION_ORDER,
          coolingOffDays: num(cfg.core?.retention?.coolingOffDays) ?? 7,
          growthMode: cfg.core?.sleep?.growth?.mode ?? null,
          usageStyle: cfg.core ? (cfg.core.context?.usageStyle === 'purpose' ? 'purpose' : 'guided') : null,
          canWrite: canWrite() && !cfg.loadError,
        };
      },

      // ── 模型：后台模型（状态；换一个要的目录走 llm.list）、评估不了的时候怎么办、想起来的方式（详细的走 embeddingSetup）、显卡、技术细节 ──
      async setModels() {
        const cfg = config();
        const [llm, gpu, spaces, eh] = await Promise.all([
          part(async () => (hostOf('llmSetup') ? llmHealthRow(await hostOf('llmSetup').status()) : null)),
          d.gpuView(cfg.host),
          part(() => pm.admin.embedding.spaces()),
          part(() => pm.admin.embedding.health()),
        ]);
        const onFailure = cfg.core?.discretion?.stage2?.onFailure === 'omit' ? 'omit' : 'give';
        const emb = isObj(cfg.host?.embedding) ? cfg.host.embedding : {};
        return {
          llm, onFailure, canWrite: canWrite() && !cfg.loadError,
          embedding: { provider: str(emb.provider, 32), tier: str(emb.tier, 16), health: eh?.error ? eh : isObj(eh) ? { dense: !!eh.dense, breakerOpen: !!eh.breakerOpen, mode: str(eh.mode, 20), device: str(eh.device, 10), reason: str(eh.reason, 80), queue: isObj(eh.queue) ? { pending: num(eh.queue.pending), stale: num(eh.queue.stale), failed: num(eh.queue.failed) } : null } : null },
          spaces: Array.isArray(spaces) ? spaces.map((s) => ({ spaceId: str(s.spaceId, 128), model: str(s.model, 80), dim: num(s.dim), status: str(s.status, 16), coverage: num(s.coverage), createdAt: num(s.createdAt), activatedAt: num(s.activatedAt), retiredAt: num(s.retiredAt) })) : spaces,
          gpu,
        };
      },

      // ── 接入：QQ（桥接目录、模式、白名单、她自己的账号、记哪些群）、DSH 桌面、B站 ──
      async setConnect() {
        const cfg = config();
        const [bridge, hs] = await Promise.all([bridgeView(), d.hostStatus()]);
        const settings = pm ? allSettings() : [];
        const counts = placeCounts(settings);
        const qqCfg = isObj(cfg.host?.adapters?.qq) ? cfg.host.adapters.qq : {};
        const adapters = hs && !hs.error && Array.isArray(hs.adapters) ? hs.adapters : [];
        const qqAd = adapters.find((a) => a?.id === 'qq');
        const webAd = adapters.find((a) => a?.id === 'dsh-web');
        const ps = hs && !hs.error && isObj(hs.preset) ? hs.preset : null;
        let recognized = null;
        try { recognized = typeof hostOf('bridgeSetup')?.selfKnown === 'function' ? !!hostOf('bridgeSetup').selfKnown() : null; } catch { recognized = null; }
        return {
          canWrite: canWrite() && !cfg.loadError,
          qq: {
            bridge,
            enabled: qqCfg.enabled !== false,
            adapter: qqAd ? { ok: qqAd.ok === true, error: str(qqAd.error, 64), listening: qqAd.status?.listening ?? null, mode: str(qqAd.status?.mode, 20) } : null,
            selfAccount: { configured: typeof qqCfg.selfAccount === 'string' ? qqCfg.selfAccount.slice(0, 64) : '', recognized },
            places: counts.byAdapter.qq ?? { total: 0, live: 0, off: 0 },
            links: { bridge: LINKS.bridge },
          },
          web: { places: counts.byAdapter['dsh-web'] ?? { total: 0, live: 0, off: 0 }, presetName: str(ps?.name, 40) ?? DEFAULT_PRESET_NAME, connected: !!webAd },
          others: Object.entries(counts.byAdapter).filter(([a]) => a !== 'qq' && a !== 'dsh-web').map(([a, c]) => ({ adapter: a, name: adapterTitle(a) === a ? (a === 'bili' ? 'B站' : a) : adapterTitle(a), ...c,
            connected: !!adapters.find((x) => x?.id === a) || settings.some((s) => s.adapter === a && s.adapterConnected !== false) })),
        };
      },

      // ── 花费：三档（意思、最近 7 天平均、上限）、今天、最近 15 天、余额；折叠里的明细 ──
      async setCost() {
        const cfg = config();
        const bud = await part(async () => budgetSummary(await hostOf('budget')?.status?.(), { embedding: cfg.host?.embedding }));
        const bc = isObj(cfg.core?.budget) || cfg.core ? budgetConfigView(cfg.core ?? {}, cfg.host) : null;
        return {
          budget: bud, budgetConfig: bc,
          tiers: bud && !bud.error ? costTiers(bc, bud, cfg.host) : costTiers(bc, null, cfg.host),
          canWrite: canWrite() && !cfg.loadError,
        };
      },

      // ── 诊断：自查（每项一句结论 + 去哪儿修）和「复制诊断信息」；记忆评测和开发者明细用 diagnostics 视图 ──
      async setDiag() {
        const cfg = config();
        const [st, eh, spaces, hs, checks, llmStatus, llmSum, budRaw, backup, bridge, home] = await Promise.all([
          part(() => pm.status()),
          part(() => pm.admin.embedding.health()),
          part(() => pm.admin.embedding.spaces()),
          d.hostStatus(),
          d.selfCheck(),
          part(async () => (hostOf('llmSetup') ? llmHealthRow(await hostOf('llmSetup').status()) : null)),
          part(async () => (hostOf('llmSetup') ? hostOf('llmSetup').summary() : null)),
          part(async () => budgetSummary(await hostOf('budget')?.status?.(), { embedding: cfg.host?.embedding })),
          part(() => pm.admin.backup.overview()),
          bridgeView(),
          typeof pm?.admin?.home === 'function' ? part(() => pm.admin.home({})) : null,
        ]);
        const settings = allSettings();
        const counts = placeCounts(settings);
        const injected = injectedAtByAdapter(settings);
        const entries = (home && !home.error && Array.isArray(home.entries) ? home.entries : []).map((e) => ({ adapter: str(e.adapter, 40), name: str(e.name, 40), connected: !!e.connected,
          places: num(e.places) ?? 0, lastAt: num(e.lastAt), injectedAt: injected[e.adapter] ?? null }));
        const ps = hs && !hs.error && isObj(hs.preset) ? hs.preset : null;
        const roster = Array.isArray(ps?.roster) ? ps.roster : null;
        const cur = bridge && !bridge.error ? bridge.current : null;
        const qqCfg = cfg.host?.adapters?.qq ?? {};
        const deniedBy = (why) => (budRaw && !budRaw.error ? (budRaw.today?.deniedBy ?? []).filter((x) => why.includes(x.why)).reduce((n, x) => n + (num(x.n) ?? 0), 0) : 0);
        const capped = deniedBy(['calls', 'tokens', 'output', 'ratio']);
        const sourceCapped = deniedBy(['source']);
        const embOff = cfg.host?.embedding?.provider === 'none';
        const sc = checks?.error ? { error: checks.error } : { total: checks.items.length, failed: checks.items.filter((c) => c.status === 'fail').length, warned: checks.items.filter((c) => c.status === 'warn').length,
          failedIds: checks.items.filter((c) => c.status === 'fail').map((c) => c.id) };
        const input = {
          setup: null,
          store: st?.error ? { error: st.error } : st ? { readOnly: !!st.readOnly, newer: st.readOnlyReason === 'newer-schema' || (num(st.schemaVersion) ?? 0) > (num(st.codeSchemaVersion) ?? Infinity) } : null,
          mode: isObj(cfg.core?.mode) ? cfg.core.mode : null,
          places: { total: counts.total, off: counts.off },
          entries,
          preset: ps ? { enabled: ps.enabled !== false, registered: !!ps.registered, broken: !!ps.broken, name: str(ps.name, 40), listed: roster ? roster.some((r) => r?.id === ps.id) : null } : null,
          qq: qqCfg.bridgeDir && qqCfg.enabled !== false ? { configured: true, isBridge: cur ? !!cur.isBridge : null, secondGen: cur?.mode ? cur.mode.secondGen : null, whitelist: cur?.whitelist ?? null } : { configured: false },
          embedding: eh?.error ? { error: eh.error } : { off: embOff, dense: !!eh?.dense, breakerOpen: !!eh?.breakerOpen, suspect: Array.isArray(spaces) && spaces.some((s) => s.status === 'suspect') },
          llm: llmStatus?.error ? { error: llmStatus.error } : llmStatus,
          budget: budRaw?.error ? { error: budRaw.error } : budRaw ? { paused: !!budRaw.paused, capped, sourceCapped, preset: budRaw.preset, custom: budRaw.custom, calls: budRaw.today?.calls ?? null, priceKnown: budRaw.priceKnown } : null,
          selfCheck: sc,
        };
        const items = checkupItems(input);
        const summary = diagSummary({
          now: now(), plugin: pluginVersion(), schema: num(st?.schemaVersion), codeSchema: num(st?.codeSchemaVersion), checkup: items, selfCheck: sc,
          llmSummary: llmSum && !llmSum.error ? llmSum : null, embedding: input.embedding.error ? null : input.embedding, budget: input.budget?.error ? null : input.budget,
          places: { total: counts.total, off: counts.off, byAdapter: counts.byAdapter }, entries,
          backup: backup && !backup.error ? { failed: num(backup.failed) ?? 0, unverified: num(backup.unverified) ?? 0, lastOkAgoDays: num(backup.lastOk) != null ? Math.floor((now() - backup.lastOk) / DAY) : null,
            offsite: !!backup.offsite?.configured, encrypted: !!backup.offsite?.encrypted } : null,
          store: input.store,
        });
        // 日志表到期清理的天数（D139；原来在总览的「模式」卡里，现在只在开发者明细里看）
        const logs = isObj(cfg.core?.retention?.logs) ? cfg.core.retention.logs : DEFAULTS.retention.logs;
        return { now: now(), checkup: items, summary, selfCheckAt: checks?.at ?? null,
          logRetention: { injectionsDays: num(logs.injectionsDays), jobsDays: num(logs.jobsDays), appraisalsDays: num(logs.appraisalsDays), utterancesDays: num(logs.utterancesDays) } };
      },

      // ── 关于：版本、数据在哪儿、会发给谁、链接 ──
      async setAbout() {
        const cfg = config();
        // DSH 宿主给 host.paths；别的宿主（和测试的替身）从宿主状态里的 dataDir / configFile 拿
        let paths = hostOf('paths') ?? null;
        if (!paths) { const hs = await d.hostStatus(); paths = hs && !hs.error ? hs : {}; }
        const emb = isObj(cfg.host?.embedding) ? cfg.host.embedding : {};
        let embedHost = null;
        try { embedHost = emb.provider === 'openai-compat' ? new URL(String(emb.url ?? '')).host.slice(0, 120) : null; } catch { embedHost = null; }
        const llm = await part(async () => (hostOf('llmSetup') ? llmHealthRow(await hostOf('llmSetup').status()) : null));
        return {
          version: pluginVersion(),
          dataDir: str(paths.dataDir, 400), configFile: str(paths.configFile, 400), exportDir: str(paths.exportDir, 400),
          embedding: { provider: str(emb.provider, 32), externalHost: embedHost },
          llm: llm && !llm.error ? { state: llm.state, pair: llm.pair, fallback: llm.fallback } : null,
          links: LINKS,
          license: 'MIT',
        };
      },

      // ── 首次设置向导（设置模式下也能用）：设置的状态、草稿、数据在哪儿 ──
      async wizard() {
        const s = hostOf('setup');
        const st = s?.status?.() ?? { needed: false };
        let draft = {};
        try { draft = typeof s?.draft === 'function' ? s.draft() ?? {} : {}; } catch { draft = {}; }
        return { needed: !!st.needed, starting: !!st.starting, dataDir: str(st.dataDir, 400), configFile: str(st.configFile, 400), retention: str(st.retention, 10) ?? '2y',
          draft: isObj(draft) ? draft : {}, links: { bridge: LINKS.bridge, cost: LINKS.cost } };
      },
    },
  };
}
