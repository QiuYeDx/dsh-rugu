// 管理页的只读视图（GET，§13.1）。全部只经核心的公开 API（pm.status / pm.admin.*，§3.5）和宿主给的 host.*，不碰表。
// 主人看得到全部记忆（§9.3.7 第 3 条），所以记忆列表照原样给；宿主的状态、预算、显卡只给数字和短状态（§13.3）。
// 每个视图各自兜错：某一块出错只让那一块显示「读不出来」，别的照常（总览不能因为备份目录读不了就整页空白）。
import { DEFAULTS, BUDGET_OVERRIDE_KEYS, checkBudgetOverride, mergeConfig, recallCaps } from 'rugu-core';
import { InputError, nonNegInt, numbersOnly, oneOf, opaque, posInt, text, timeMs } from './check.js';

const DAY = 86_400_000;
/** 今天 0 点（北京时间，UTC+8；管理页的「今天」只用来数次数）。 */
const dayStartOf = (t) => { const off = 8 * 3_600_000; return Math.floor((t + off) / DAY) * DAY - off; };
export const MEMORY_VIEWS = Object.freeze(['assertions', 'episodes', 'entities', 'intentions', 'lessons', 'percepts', 'windows', 'checks', 'suppressed', 'forgotten', 'tombstones']);
/** 评测结果给页面的形状（只有用例名、对错和数字）。 */
function evalRow(r) {
  const cases = Array.isArray(r?.cases) ? r.cases.slice(0, 50).map((c) => ({ id: String(c.id ?? ''), name: String(c.name ?? ''), on: c.on == null ? null : c.on === true, off: c.off == null ? null : c.off === true,
    ...(typeof c.guard === 'boolean' ? { guard: c.guard } : {}) })) : [];
  return { at: Number.isFinite(r?.at) ? r.at : null, version: String(r?.version ?? ''), ms: Number.isFinite(r?.ms) ? r.ms : null, total: cases.filter((c) => c.on !== null).length,
    on: cases.filter((c) => c.on === true).length, off: cases.filter((c) => c.off === true).length, guards: cases.filter((c) => typeof c.guard === 'boolean').length,
    guardsHeld: cases.filter((c) => c.guard === true).length, cases };
}
export const RETENTION_ORDER = Object.freeze(['1y', '2y', '5y', 'forever']);
const STATES = ['all', 'active', 'hidden', 'forgotten'];
const NTK_STATUS = ['open', 'read', 'all'];
const REVIEW_KINDS = ['forget_request', 'owner_op', 'merge', 'growth', 'held_utterance', 'norm_change', 'setting_rule_relax', 'withdraw'];
const RULE_KINDS = ['do_not_remember', 'disclosure', 'mode'];
/** 哪些列表能按场合 / 按人筛（核心 views.js 认的筛选条件）。 */
const BY_SETTING = new Set(['assertions', 'episodes', 'percepts', 'windows']);
const BY_ENTITY = new Set(['assertions', 'episodes', 'percepts', 'intentions']);
/** 哪些列表能搜（D159 起原话、原文片段也能搜）。 */
const SEARCHABLE = new Set(['assertions', 'episodes', 'entities', 'percepts', 'windows']);
/** 按时间的列表（D159）：能按时间筛、换顺序、跳到某个时间、往两头翻、按天计数。人与物不按时间。 */
const TIME_VIEWS = new Set(['assertions', 'episodes', 'intentions', 'lessons', 'percepts', 'windows', 'checks', 'suppressed', 'forgotten']);
/** 顺序：新的在前 / 旧的在前 / 最相关（只在搜索时有意义）。aroundRef 只查字符集，种类不对的核心会拒（CONTRACT → 400）。 */
const ORDERS = ['desc', 'asc', 'rank'];

/** 浏览器的时区偏移（分钟，东正）：-840 … 840。 */
function tzMin(v, path) {
  const n = typeof v === 'string' && /^-?\d{1,3}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || Math.abs(n) > 840) throw new InputError(path, '应为 -840 到 840 之间的整数（分钟）');
  return n;
}

/**
 * 记忆列表的查询（页面传来的都是字符串）→ 核心 admin.list 的查询。memories 和 memoryDays 共用；paging=false 时不收分页和定位。
 * @param {Record<string, string>} q
 * @param {{paging: boolean}} o
 */
function memoryQuery(q, { paging }) {
  const view = q.list == null || q.list === '' ? 'assertions' : oneOf(q.list, MEMORY_VIEWS, 'list');
  const state = q.state == null || q.state === '' ? 'all' : oneOf(q.state, STATES, 'state');
  const query = { view, ...(paging ? pageOf(q) : {}) };
  if (q.q != null && q.q !== '' && SEARCHABLE.has(view)) query.q = text(q.q, 'q', { max: 100 });
  if (state !== 'all' && ['assertions', 'episodes', 'entities'].includes(view)) query.state = state;
  if (q.settingKey && BY_SETTING.has(view)) query.settingKey = opaque(q.settingKey, 'settingKey');
  if (q.entityId && BY_ENTITY.has(view)) query.entityId = posInt(q.entityId, 'entityId');
  // 夜里核对过的（D122）：默认只列改了的，all=1 连没问题的也列
  if (view === 'checks') query.changed = !(q.all === '1' || q.all === 1 || q.all === true);
  // 她的经验（D124）：默认只列现在这一版；按验证过没有筛
  if (view === 'lessons') {
    if (q.all === '1' || q.all === 1 || q.all === true) query.all = true;
    if (q.status === 'verified' || q.status === 'unverified') query.status = q.status;
  }
  // 【D159】按时间：时间筛选（毫秒，闭区间）、顺序、跳到某个时间 / 某一条、往前翻、时区
  if (TIME_VIEWS.has(view)) {
    if (q.from != null && q.from !== '') query.from = timeMs(q.from, 'from');
    if (q.to != null && q.to !== '') query.to = timeMs(q.to, 'to');
    if (query.from != null && query.to != null && query.from > query.to) throw new InputError('to', '结束不能早于开始');
    if (q.order != null && q.order !== '') query.order = oneOf(q.order, ORDERS, 'order');
    if (q.tz != null && q.tz !== '') query.tzOffsetMin = tzMin(q.tz, 'tz');
    if (paging) {
      if (q.around != null && q.around !== '') query.around = timeMs(q.around, 'around');
      if (q.near != null && q.near !== '') query.near = oneOf(q.near, ['before', 'after'], 'near');
      if (q.aroundRef != null && q.aroundRef !== '') query.aroundRef = opaque(q.aroundRef, 'aroundRef');
      if (q.prev) query.prev = text(q.prev, 'prev', { max: 200 });
    }
  }
  return query;
}
/** 星图（D163）的快照缓存多久：同一个 rev 在这段时间里直接给缓存（now 换成新的），快照不在每次打开页签时重算。 */
export const STARMAP_TTL_MS = 15_000;
/** 看一眼（starmapPeek）一次最多几条。 */
export const STARMAP_PEEK_MAX = 24;
/** 自检结果缓存多久（宿主的自检会探一次嵌入服务，不在每次打开页面时重跑）。 */
const SELFCHECK_TTL_MS = 60_000;

/** 错误只留类型（日志和页面都不带内容）。 */
export const codeOf = (e) => String(e?.code ?? e?.name ?? 'Error').slice(0, 64);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── 花费护栏的预设和自定义（D121）────────────────────────────────────────
/** 预算预设（管理页的顺序）。 */
export const BUDGET_PRESETS = Object.freeze(['loose', 'saving', 'unlimited']);
/**
 * 管理页「自定义」里每一项能填的范围（比核心的类型检查窄：挡掉明显的误填，例如每天只给 3 次调用）。
 * cap：整数或 null（不设上限）；share / ratio：0–1 的比例（ratio 可以超过 1，也可以 null = 不设）；days：整数。
 */
export const BUDGET_RANGES = Object.freeze({
  dailyCalls: { kind: 'cap', min: 50, max: 1_000_000 },
  dailyUncachedTokens: { kind: 'cap', min: 100_000, max: 2_000_000_000 },
  dailyOutputTokens: { kind: 'cap', min: 20_000, max: 500_000_000 },
  perSourceShare: { kind: 'share', min: 0.05, max: 1 },
  mainChatRatioCap: { kind: 'ratio', min: 0.05, max: 10 },
  balanceProtectDays: { kind: 'days', min: 0, max: 30 },
  stage2Scope: { kind: 'enum', values: ['all', 'direct'] },
  prefetchRewrite: { kind: 'bool' },
  rerank: { kind: 'bool' },
  sleepDepth: { kind: 'enum', values: ['full', 'essential'] },
  // 注入预算（D133）：比例 1%–100% 或不限；每个会话每天 1000 字起（再少回想几乎给不出东西）或不限
  injectShare: { kind: 'ratio', min: 0.01, max: 1 },
  injectPerSessionPerDay: { kind: 'cap', min: 1000, max: 10_000_000 },
  // 记忆给多少（D165）：回想各层的条数和总字数乘它；管理页建议 0.5–3（核心的校验更宽，留给手改文件）
  room: { kind: 'room', min: 0.5, max: 3 },
});
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/**
 * 校验「自定义」的一项（页面传来的值），合格就返回规范化的值，不合格抛 InputError（看得懂的范围）。
 * @param {string} key
 * @param {unknown} v
 * @param {string} path
 */
export function budgetValue(key, v, path = key) {
  const r = BUDGET_RANGES[key];
  if (!r) throw new InputError(path, '不认识的字段');
  if (r.kind === 'cap') {
    if (v === null) return null;
    if (!Number.isSafeInteger(v) || v < r.min || v > r.max) throw new InputError(path, `应为 ${fmtInt(r.min)}–${fmtInt(r.max)} 的整数，或不设上限`);
    return v;
  }
  if (r.kind === 'share' || r.kind === 'ratio') {
    if (v === null && r.kind === 'ratio') return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min - 1e-9 || v > r.max + 1e-9) {
      throw new InputError(path, `应为 ${Math.round(r.min * 100)}%–${Math.round(r.max * 100)}%${r.kind === 'ratio' ? '，或不设' : ''}`);
    }
    return Math.round(v * 1000) / 1000;
  }
  if (r.kind === 'room') {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < r.min - 1e-9 || v > r.max + 1e-9) throw new InputError(path, `应为 ${r.min}–${r.max} 的数（1 = 平衡档）`);
    return Math.round(v * 100) / 100;
  }
  if (r.kind === 'days') {
    if (!Number.isSafeInteger(v) || v < r.min || v > r.max) throw new InputError(path, `应为 ${r.min}–${r.max} 的整数（0 = 关掉）`);
    return v;
  }
  if (r.kind === 'bool') {
    if (typeof v !== 'boolean') throw new InputError(path, '应为 true / false');
    return v;
  }
  return oneOf(v, r.values, path);
}
/**
 * 配置 → 花费护栏要的预设和自定义：每一档每一项的值（null = 不设上限）、主人改过的项、现在生效的值。
 * 每天输出的上限不在核心的预设里，按宿主每档的数（host.budget.dailyOutputTokens；没有 = 不设）。
 * @param {any} core   核心的参数表（顶层的 budget）
 * @param {any} hostCfg 宿主配置的 host 部分
 */
export function budgetConfigView(core, hostCfg) {
  const b = isObj(core?.budget) ? core.budget : {};
  const preset = BUDGET_PRESETS.includes(b.preset) ? b.preset : 'loose';
  const outs = isObj(hostCfg?.budget?.dailyOutputTokens) ? hostCfg.budget.dailyOutputTokens : {};
  const presets = {};
  for (const name of BUDGET_PRESETS) {
    const src = { ...DEFAULTS.budget.presets[name], ...(isObj(b.presets?.[name]) ? b.presets[name] : {}), dailyOutputTokens: num(outs[name]) };
    presets[name] = Object.fromEntries(BUDGET_OVERRIDE_KEYS.map((k) => [k, src[k] === undefined ? null : src[k]]));
  }
  const overrides = {};
  if (isObj(b.overrides)) for (const k of BUDGET_OVERRIDE_KEYS) if (Object.hasOwn(b.overrides, k) && checkBudgetOverride(k, b.overrides[k]) === null) overrides[k] = b.overrides[k];
  // 记忆给多少（D165）：每一档（和现在生效的）各层生效的上限，从核心的 recallCaps 算（页面不写死数字）
  const memoryOf = (name, ov) => {
    try {
      const { config } = mergeConfig(DEFAULTS, { ...core, budget: { ...b, preset: name, overrides: ov } });
      return memorySummary(recallCaps(config));
    } catch { return null; }
  };
  const memory = Object.fromEntries(BUDGET_PRESETS.map((name) => [name, memoryOf(name, {})]));
  return { preset, custom: Object.keys(overrides).length > 0, overrides, presets, effective: { ...presets[preset], ...overrides }, keys: [...BUDGET_OVERRIDE_KEYS], ranges: BUDGET_RANGES,
    memory, memoryEffective: memoryOf(preset, overrides) };
}
/**
 * 「记忆给多少」（D165）给页面的几个数：想起来的最多几条、工作记忆最多几行、被问到以前的事时最多约多少字、她调记忆工具时最多约多少字、
 * 这之后他的事最多几件、整块最多约多少字（不含有自己预算的几层）。都是核心生效的上限，不是每轮都给满。
 * @param {ReturnType<typeof recallCaps>} K
 */
export function memorySummary(K) {
  return { room: K.room, recalled: K.involuntary.maxItems, recalledDeliberate: K.deliberate.maxItems, working: K.working.maxLines,
    recollectAuto: K.recollect.auto.totalChars, recollectTool: K.recollect.tool.totalChars, sinceHere: K.sinceHere.maxItems,
    block: K.blockMaxChars, itemChars: K.involuntary.itemChars };
}
const CAP_NAMES = { dailyCalls: '每天后台调用次数', dailyUncachedTokens: '每天未命中缓存的输入', dailyOutputTokens: '每天输出' };
/**
 * 一次花费护栏的改动有哪些风险（和现在生效的比；已经是这样的不再提）：换成不设上限、关掉余额保护、去掉某一项的上限。
 * @param {ReturnType<typeof budgetConfigView>} cur
 * @param {{preset: string, overrides: object}} next
 * @returns {string[]}
 */
export function budgetRisks(cur, next) {
  const eff = { ...cur.presets[next.preset], ...next.overrides };
  const out = [];
  if (next.preset === 'unlimited' && cur.preset !== 'unlimited') out.push('换成「效果优先」：后台的调用次数、token 和比例都不设上限，程序失控时也不会被拦住，只剩余额保护（余额不够 1 天时停后台）；记忆给得最多，她的上下文长得更快、压缩得更早');
  else for (const k of Object.keys(CAP_NAMES)) if (eff[k] === null && cur.effective[k] !== null) out.push(`去掉${CAP_NAMES[k]}的上限：程序失控时不会被拦住`);
  if (eff.balanceProtectDays === 0 && cur.effective.balanceProtectDays !== 0) out.push('关掉余额保护：余额被后台用完时她的聊天也会停');
  return out;
}

/** 宿主的调用：可能同步、可能异步、可能挂住。超时当作读不出来。 */
export async function within(ms, fn) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** 一块数据：成功给值，失败给 {error: 类型}。 */
async function part(fn, ms = 5000) {
  try { return await within(ms, fn); } catch (e) { return { error: codeOf(e) }; }
}

const pageOf = (q) => ({
  limit: q.limit == null ? 50 : Math.min(200, posInt(q.limit, 'limit')),
  ...(q.next ? { next: text(q.next, 'next', { max: 200 }) } : {}),
});

/**
 * 宿主的配置快照。DSH 宿主（host/index.js 的 hostApi.config.get）给的是「核心参数表在顶层 + host + meta: {file, warnings, loadError}」；
 * 也认配置存储自己的形状 {host, core, warnings, loadError}（host/config.js 的 get()，别的宿主可以直接转交它）。
 * @param {any} host
 * @returns {{core: any, host: any, warnings: number, loadError: string|null, pendingRisky: {path: string, reason: string}[]}}
 */
export function configParts(host) {
  let c = null;
  try { c = host && typeof host === 'object' ? host.config?.get?.() ?? null : null; } catch { c = null; }
  if (!isObj(c)) return { core: {}, host: null, warnings: 0, loadError: null, pendingRisky: [] };
  const wrapped = isObj(c.core);
  const meta = isObj(c.meta) ? c.meta : c;
  let core = c.core;
  if (!wrapped) { const { host: _h, meta: _m, ...rest } = c; core = rest; }
  return {
    core,
    host: isObj(c.host) ? c.host : null,
    warnings: Array.isArray(meta.warnings) ? meta.warnings.length : 0,
    loadError: typeof meta.loadError === 'string' ? meta.loadError.slice(0, 64) : null,
    // 配置文件被直接改过、宿主先扣下等主人确认的有风险的改动（只有路径和理由）
    pendingRisky: (Array.isArray(meta.pendingRisky) ? meta.pendingRisky : Array.isArray(c.pendingRisky) ? c.pendingRisky : [])
      .filter(isObj).slice(0, 20).map((x) => ({ path: String(x.path ?? '').slice(0, 80), reason: String(x.reason ?? '').slice(0, 200) })),
  };
}

/**
 * @param {{pm: any, host: any, now: () => number, exportDir: () => string|null}} deps
 */
export function createViews(deps) {
  const { pm, host, now } = deps;
  const hostOf = (k) => (host && typeof host === 'object' ? host[k] : undefined);
  let selfCheckCache = null;
  /** 星图快照的缓存：{at, rev, data}。 */
  let starmapCache = null;
  const hasStarmap = () => typeof pm?.admin?.starmap === 'function';

  /** 全部场合的键 → 名字（列表页把场合键翻成名字用；最多 1000 个）。 */
  function settingLabels() {
    const out = {};
    try {
      let next;
      for (let i = 0; i < 5; i++) {
        const p = pm.admin.list({ view: 'settings', limit: 200, ...(next ? { next } : {}) });
        for (const s of p.items ?? []) out[s.key] = settingTitle(s);
        next = p.next;
        if (!next) break;
      }
    } catch { /* 读不出来就显示「某个场合」 */ }
    return out;
  }
  /**
   * 最常提到的一批人 → 名字：只用来把记忆里出现的实体 id 翻成名字（什么状态的都翻，收回的也翻）。选人用 pickable()。
   * 同一个人的几个档案（D161）各自的 id 也翻成那个人的名字（档案自己没名字时）。
   */
  function entityNames(pick = null) {
    const out = {};
    try {
      for (const e of pm.admin.list({ view: 'entities', limit: 200 }).items ?? []) out[e.id] = e.name || null;
    } catch { /* 读不出来就只显示编号 */ }
    for (const p of pick ?? []) {
      out[p.id] = p.name;
      for (const m of p.members) if (!out[m]) out[m] = p.name;
    }
    return out;
  }
  /**
   * 【D161】能选的人（core 的 pickable 列表）：不含收回的、不含场合，认成同一个人的几个档案并成一项。
   * 【D162】每项带 stored（名下有没有事实、情节、原话、意图）。
   * 只往页面交它要的字段；读不出来返回 null（页面退回旧的做法）。
   */
  function pickable() {
    try {
      const items = pm.admin.list({ view: 'pickable', limit: 500 }).items;
      if (!Array.isArray(items)) return null;
      return items.filter((e) => isObj(e) && Number.isSafeInteger(e.id) && typeof e.name === 'string' && e.name).map((e) => ({
        id: e.id, name: clip(e.name, 60), kind: typeof e.kind === 'string' ? e.kind.slice(0, 32) : 'person', isSelf: !!e.isSelf,
        status: typeof e.status === 'string' ? e.status : null,
        members: Array.isArray(e.members) ? e.members.filter(Number.isSafeInteger).slice(0, 64) : [e.id],
        aliases: Array.isArray(e.aliases) ? e.aliases.filter((x) => typeof x === 'string' && x).slice(0, 8).map((x) => clip(x, 60)) : [],
        place: typeof e.place === 'string' && e.place ? e.place : null,
        // 【D162】名下有没有东西（记忆页签的「全部的人」只列有的）；核心没给就当有
        stored: e.stored !== false,
      }));
    } catch { return null; }
  }
  /** 有名字的人（不含她自己）：披露规则「特别别告诉谁」只列这些，不列地方、宠物。和选择器是同一份列表（D161）。 */
  function peopleIds(pick = pickable()) {
    return (pick ?? []).filter((e) => e.kind === 'person' && !e.isSelf).map((e) => e.id);
  }
  /** 喂选择器的那几样：id → 名字、能选的人。 */
  function pickerParts() {
    const pick = pickable();
    return { names: entityNames(pick), pickable: pick };
  }
  const config = () => configParts(host);
  /** 宿主状态：只留管理页要的数字和短状态（§13.3）。 */
  async function hostStatus() {
    const fn = hostOf('status');
    if (typeof fn !== 'function') return null;
    return part(() => fn.call(host));
  }
  /** 启动自检的结果（缓存一分钟；「重新检查」会刷新）。 */
  async function selfCheck(force = false) {
    if (!force && selfCheckCache && now() - selfCheckCache.at < SELFCHECK_TTL_MS) return selfCheckCache.value;
    const fn = hostOf('selfCheck');
    if (typeof fn !== 'function') return { error: 'UNAVAILABLE' };
    const value = normalizeChecks(await part(() => fn.call(host, force ? { force: true } : undefined), 15_000));
    selfCheckCache = { at: now(), value };
    return value;
  }
  const countOf = (q) => { try { return Number(pm.admin.list({ ...q, limit: 1 }).total ?? 0); } catch { return null; } };
  function gpuView(cfgHost) {
    return part(async () => {
      const g = hostOf('gpu');
      if (typeof g?.status !== 'function') return null;
      return gpuSummary(await g.status(), cfgHost, now(), typeof g.setPolicy === 'function');
    });
  }

  const VIEWS = {
    // ── 首次设置（D128）和两张接入卡片（D127、D129）：设置模式下也能用 ─────────
    setup() { return hostOf('setup')?.status?.() ?? { needed: false }; },
    async embeddingSetup(q) { return part(() => hostOf('embeddingSetup').status({ url: typeof q?.url === 'string' ? q.url : '' }), 8000); },
    bridge(q) { return part(() => hostOf('bridgeSetup').status({ dir: typeof q?.dir === 'string' && q.dir ? q.dir : undefined })); },
    // ── 总览：只有数字和状态（§13.1、§13.3） ──────────────────────────────
    async overview() {
      const st = await part(() => pm.status());
      const cfg = config();
      const pending = {
        review: countOf({ view: 'review', status: 'pending' }),
        needToKnow: countOf({ view: 'needToKnow', status: 'open' }),
        holds: countOf({ view: 'holds' }),
        growth: null,
      };
      // 误拦观察（D113）：今天外发守护挡下了几句、公开渠道挂起了几句（只有数字，原文不在这里）
      const today = dayStartOf(now());
      const misblock = {
        guard: countOf({ view: 'blocked', basis: 'guard', from: today }),
        publicHold: countOf({ view: 'blocked', basis: 'public', verdict: 'hold', from: today }),
        legacy: countOf({ view: 'blocked', basis: 'legacy', from: today }),
      };
      try {
        const since = now() - 7 * DAY;
        pending.growth = (pm.admin.growth.versions() ?? []).filter((v) => v.createdAt >= since && !v.revokedAt && v.createdBy !== 'owner').length;
      } catch { pending.growth = null; }
      const [backup, embedding, spaces, retention, budget, gpu, hs] = await Promise.all([
        part(() => pm.admin.backup.overview()),
        part(() => pm.admin.embedding.health()),
        part(() => pm.admin.embedding.spaces()),
        part(() => pm.admin.retention.get()),
        part(async () => budgetSummary(await hostOf('budget')?.status?.(), { embedding: cfg.host?.embedding })),
        gpuView(cfg.host),
        hostStatus(),
      ]);
      // 自检：宿主状态里已经有上次的结果就用它（不为总览重跑一遍自检）；没有再读缓存 / 跑一次
      let checks = hs && !hs.error && isObj(hs.selfCheck) ? selfCheckSummaryOf(hs.selfCheck) : null;
      if (!checks) {
        const c = await selfCheck();
        checks = c?.error ? c : { at: c.at, total: c.items.length, failed: c.items.filter((x) => x.status === 'fail').length, warned: c.items.filter((x) => x.status === 'warn').length };
      }
      const out = {
        now: now(),
        mode: modeConfig(cfg.core),
        store: st.error ? st : {
          readOnly: !!st.readOnly, readOnlyReason: st.readOnlyReason ?? null, schemaVersion: st.schemaVersion ?? null,
          codeSchemaVersion: st.codeSchemaVersion ?? null, adapters: Array.isArray(st.adapters) ? st.adapters.map(adapterTitle) : [],
          startup: startupSummary(st.startup), vectors: numbersOnly(st.vectors ?? null),
        },
        pending,
        misblock,
        backup: backup?.error ? backup : trimBackupOverview(backup),
        embedding: embedding?.error ? embedding : healthRow(embedding),
        spaces: Array.isArray(spaces) ? spaces.map(spaceRow) : spaces,
        retention, budget, gpu,
        host: hs == null ? null : hs.error ? hs : hostSummary(hs, now()),
        config: { warnings: cfg.warnings, loadError: cfg.loadError, pendingRisky: cfg.pendingRisky.length },
        embeddingOff: cfg.host?.embedding?.provider === 'none',
        selfCheck: checks,
      };
      out.alerts = alertsOf(out);
      return out;
    },

    // ── 需要你知道（§9.3.7） ────────────────────────────────────────────
    needToKnow(q) {
      const status = q.status == null || q.status === '' ? 'open' : oneOf(q.status, NTK_STATUS, 'status');
      const p = pm.admin.list({ view: 'needToKnow', ...(status === 'all' ? {} : { status }), ...pageOf(q) });
      return { ...p, settings: settingLabels() };
    },

    // ── 审核队列 ────────────────────────────────────────────────────────
    review(q) {
      const kind = q.kind == null || q.kind === '' ? null : oneOf(q.kind, REVIEW_KINDS, 'kind');
      const p = pm.admin.list({ view: 'review', status: 'pending', ...(kind ? { kind } : {}), ...pageOf(q) });
      // 挂起的发言：原文只在 utterances 里（§9.4.4），这里按令牌对上，给主人看全文、理由和要说到哪儿
      const holds = new Map();
      if ((p.items ?? []).some((r) => r.kind === 'held_utterance')) {
        try {
          for (const u of pm.admin.list({ view: 'holds', limit: 200 }).items ?? []) holds.set(u.token, u);
        } catch { /* 读不出来就只显示令牌 */ }
      }
      const items = (p.items ?? []).map((r) => {
        if (r.kind !== 'held_utterance') return r;
        const u = holds.get(r.payload?.token);
        return u ? { ...r, hold: { text: u.heldText ?? null, reasons: Array.isArray(u.reasons) ? u.reasons : [], reflection: u.reflection ?? null,
          formHint: u.formHint ?? u.channel?.formHint ?? null, settingKey: u.settingKey ?? null, homeSettingKey: u.homeSettingKey ?? null, at: u.at ?? null } } : r;
      });
      return { ...p, items, settings: settingLabels(), names: entityNames() };
    },

    // ── 场合（属性、模式、别记这里） ────────────────────────────────────
    settings(q) {
      const p = pm.admin.list({ view: 'settings', ...pageOf(q) });
      const overrides = {};
      const dnr = {};
      try {
        // 只认关 / 开：旧版本留下的 'shadow' 覆盖核心已经不认了（按默认档算），这里也当没有覆盖
        for (const r of pm.admin.rules.list('mode') ?? []) if (r.target?.settingKey && (r.value === 'off' || r.value === 'live')) overrides[r.target.settingKey] = { ruleId: r.id, mode: r.value };
        for (const r of pm.admin.rules.list('do_not_remember') ?? []) if (r.target?.settingKey) (dnr[r.target.settingKey] ??= []).push(r.id);
      } catch { /* 规则读不出来就只显示生效档 */ }
      const items = (p.items ?? []).map((s) => ({
        key: s.key, label: s.label, adapter: s.adapter, stability: s.stability, mode: s.mode ?? null,
        // 【D111】名字：生效的称呼、是不是真名、从哪来（主人起的 / 入口给的）、入口给的那个、区分提示；入口的名字（不显示原始 id）
        title: settingTitle(s), labelKind: s.labelKind === 'description' ? 'description' : 'name', labelSource: s.labelSource === 'owner' ? 'owner' : 'adapter',
        adapterLabel: s.adapterLabel ?? s.label ?? '', adapterLabelKind: s.adapterLabelKind === 'description' ? 'description' : 'name',
        ownerLabel: s.ownerLabel ?? null, hint: s.hint ?? null,
        adapterName: s.adapterName || ADAPTER_NAMES[s.adapter] || s.adapter || null,
        // 【D111】收没收到过东西：「生效：开」只说档位，不说有没有东西进来（从没收到过的场合如实标出来，带入口说的原因）
        reception: receptionOf(s),
        override: overrides[s.key] ?? null, doNotRemember: !!s.doNotRemember, dnrRules: dnr[s.key] ?? [],
        audience: describeAudience(s.descriptor), oneOnOne: isOneOnOne(s.descriptor),
        firstSeen: s.firstSeen ?? null, lastSeen: s.lastSeen ?? null, rulesVersion: s.rulesVersion ?? null,
      }));
      return { ...p, items, defaults: modeConfig(config().core) };
    },

    // ── 规则（别记、披露规则） ──────────────────────────────────────────
    rules(q) {
      const kind = q.kind == null || q.kind === '' ? null : oneOf(q.kind, RULE_KINDS, 'kind');
      const p = pm.admin.list({ view: 'rules', ...(kind ? { kind } : {}), ...pageOf(q) });
      const pk = pickerParts();
      return { ...p, settings: settingLabels(), ...pk, people: peopleIds(pk.pickable) };
    },

    // ── 分寸（D113）：被拦下的话（只写依据、不显示原文）、她在守的叮嘱（可以解除）────────────────
    discretion(q) {
      // 默认只列现在的规则拦下的（D119）：D113 以前旧规则拦下的折成一行摘要（legacy），主人点开才列
      const basis = q.basis ? oneOf(q.basis, ['guard', 'public', 'legacy', 'error', 'current'], 'basis') : 'current';
      const blocked = pm.admin.list({ view: 'blocked', basis, ...pageOf(q) });
      let legacy = null;
      if (basis !== 'legacy') {
        try {
          const l = pm.admin.list({ view: 'blocked', basis: 'legacy', limit: 1 });
          const total = Number(l?.total ?? l?.items?.length ?? 0);
          if (total > 0) legacy = { total, lastAt: l.items?.[0]?.at ?? null };
        } catch { legacy = null; }
      }
      const limits = pm.admin.list({ view: 'limits', limit: 100 });
      return { blocked, basis, legacy, limits, settings: settingLabels(), names: entityNames() };
    },

    // ── 记忆浏览 ────────────────────────────────────────────────────────
    memories(q) {
      const query = memoryQuery(q, { paging: true });
      const view = query.view;
      const p = pm.admin.list(query);
      // 隐藏 / 忘掉的列表只有引用：给每条补上种类和开头一段文字，主人才认得出是哪条
      if (view === 'suppressed' || view === 'forgotten') {
        p.items = (p.items ?? []).map((x) => {
          try {
            const d = pm.admin.get(x.ref);
            const row = d?.row ?? {};
            return { ...x, kind: d?.kind ?? null, preview: clip(row.text ?? row.narrative ?? row.title ?? row.display_name ?? null, 160) };
          } catch { return x; }
        });
      }
      return { ...p, view, settings: settingLabels(), ...pickerParts() };
    },
    /**
     * 【D159】「跳到」的月历：某个月每天有几条（和列表相同的条件：列表种类、场合、人、状态、搜索、时间筛选），
     * 以及这个条件下最早、最晚一条的时间。month = YYYY-MM，tz = 浏览器的时区偏移（分钟，东正，±840 内）。
     */
    memoryDays(q) {
      const query = memoryQuery(q, { paging: false });
      if (!TIME_VIEWS.has(query.view)) throw new InputError('list', '这个列表不按时间');
      if (typeof q.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw new InputError('month', '应为 YYYY-MM');
      const { view, ...rest } = query;
      const d = pm.admin.list({ ...rest, view: 'days', of: view, month: q.month });
      return { items: Array.isArray(d?.items) ? d.items.map((x) => ({ day: String(x.day), n: Number(x.n) || 0 })) : [], first: num(d?.first), last: num(d?.last), view };
    },
    memory(q) {
      const ref = opaque(q.ref, 'ref');
      const d = pm.admin.get(ref);
      if (!d) throw Object.assign(new Error('没有这条记忆'), { code: 'NOT_FOUND' });
      // 身份证据只留种类和哈希的开头（账号本来就只存 HMAC，§12.3；页面不需要整条哈希）
      const detail = Array.isArray(d.identity) ? { ...d, identity: d.identity.map((x) => ({ namespace: x.namespace ?? null, scope: x.scope ?? null, strength: x.strength ?? null,
        hash: typeof x.idHash === 'string' ? x.idHash.slice(0, 8) : null, at: x.at ?? null })) } : d;
      return { detail, settings: settingLabels(), names: entityNames() };
    },

    // ── 她的成长块（§5.7） ──────────────────────────────────────────────
    growth() {
      const versions = (pm.admin.growth.versions() ?? []).slice().sort((a, b) => b.version - a.version);
      const current = versions.find((v) => !v.revokedAt) ?? null;
      return { versions, current: current ? current.version : 0, mode: config().core?.sleep?.growth?.mode ?? null };
    },

    // ── 备份与恢复（§12.4） ─────────────────────────────────────────────
    async backups(q) {
      const [overview, packs, drills, retention] = await Promise.all([
        part(() => pm.admin.backup.overview()),
        part(() => pm.admin.list({ view: 'backups', ...pageOf(q) })),
        part(() => pm.admin.list({ view: 'drills', limit: 5 })),
        part(() => pm.admin.retention.get()),
      ]);
      const core = config().core;
      return {
        overview: overview?.error ? overview : trimBackupOverview(overview),
        packs: packs?.error ? packs : { ...packs, items: (packs.items ?? []).map(packRow) },
        drills, retention,
        offsiteDir: typeof core?.backup?.offsiteDir === 'string' ? core.backup.offsiteDir : '',
        keep: isObj(core?.backup?.retention) ? numbersOnly(core.backup.retention) : null,
        exportReady: !!deps.exportDir?.(),
        // 部分恢复选人用（D161）
        ...pickerParts(),
      };
    },

    // ── 设置（模式、保留期、预算预设、成长块方式、显卡策略） ────────────
    async config() {
      const cfg = config();
      const [gpu, retention, budget] = await Promise.all([
        gpuView(cfg.host),
        part(() => pm.admin.retention.get()),
        part(async () => budgetSummary(await hostOf('budget')?.status?.(), { embedding: cfg.host?.embedding })),
      ]);
      return {
        mode: modeConfig(cfg.core),
        budgetPreset: cfg.core?.budget?.preset ?? null,
        // 花费护栏的三档预设和「自定义」（D121）：每档每一项的值、主人改过的项、能填的范围
        budgetConfig: isObj(cfg.core?.budget) ? budgetConfigView(cfg.core, cfg.host) : null,
        growthMode: cfg.core?.sleep?.growth?.mode ?? null,
        // D125：用法说明和记忆工具说明的写法（没写过按默认的「详细指引」）
        usageStyle: cfg.core ? (cfg.core.context?.usageStyle === 'purpose' ? 'purpose' : 'guided') : null,
        gpu, budget, retention,
        coolingOffDays: num(cfg.core?.retention?.coolingOffDays) ?? 7,
        retentionOptions: RETENTION_ORDER,
        canWrite: typeof hostOf('config')?.set === 'function',
        warnings: cfg.warnings, loadError: cfg.loadError, pendingRisky: cfg.pendingRisky,
      };
    },

    // ── 星图（D163）：三个只读视图，数字数组原样过，只把场合和人名换成页面要的样子 ─────────
    /** 快照：全部星、痕迹、想起、说起、心境、听到的话。老核心没有 admin.starmap → {unsupported: true}。 */
    starmap() {
      if (!hasStarmap()) return { unsupported: true };
      const t = now();
      if (starmapCache && t - starmapCache.at < STARMAP_TTL_MS) {
        const c = starmapCache;
        return { ...c.data, now: (num(c.data.now) ?? c.at) + (t - c.at) };
      }
      const data = starmapSnapshot(pm.admin.starmap({}));
      starmapCache = { at: t, rev: data.rev, data };
      return data;
    },
    /** 实时增量：从游标之后的痕迹、想起、说起。 */
    starmapLive(q) {
      if (!hasStarmap()) return { unsupported: true };
      const since = { inj: nonNegInt(q.inj, 'inj'), trace: nonNegInt(q.trace, 'trace'), told: nonNegInt(q.told, 'told') };
      const r = pm.admin.starmap({ since });
      // 星的集合变了（rev 不同），下一次快照不能再给缓存
      if (starmapCache && typeof r?.rev === 'string' && r.rev !== starmapCache.rev) starmapCache = null;
      return {
        now: num(r?.now), rev: typeof r?.rev === 'string' ? r.rev.slice(0, 200) : null, cursor: cursorOf(r?.cursor),
        traces: arr(r?.traces), recalls: arr(r?.recalls), tells: arr(r?.tells),
      };
    },
    /** 看一眼：几颗星的一句话内容（悬停、详情卡用）。 */
    starmapPeek(q) {
      if (!hasStarmap()) return { unsupported: true };
      if (typeof q.refs !== 'string' || !q.refs) throw new InputError('refs', '应为逗号分隔的记忆引用');
      const parts = q.refs.split(',');
      if (parts.length > STARMAP_PEEK_MAX) throw new InputError('refs', `一次最多 ${STARMAP_PEEK_MAX} 条`);
      const refs = [...new Set(parts.map((x, i) => opaque(x, `refs[${i}]`)))];
      const r = pm.admin.starmap({ peek: refs });
      return {
        items: arr(r?.items).filter(isObj).slice(0, STARMAP_PEEK_MAX).map((x) => ({
          ref: typeof x.ref === 'string' ? x.ref.slice(0, 128) : null, title: clip(x.title, 80), text: clip(x.text, 200), at: num(x.at),
        })),
      };
    },

    // ── 诊断（§13.2 启动自检、§13.3 数字） ──────────────────────────────
    async diagnostics(q) {
      const force = q.refresh === '1';
      const cfg = config();
      const [st, health, spaces, gpu, budget, hs, checks, recall, memoryEval] = await Promise.all([
        part(() => pm.status()),
        part(() => pm.admin.embedding.health()),
        part(() => pm.admin.embedding.spaces()),
        gpuView(cfg.host),
        part(async () => budgetSummary(await hostOf('budget')?.status?.(), { embedding: cfg.host?.embedding })),
        hostStatus(),
        selfCheck(force),
        part(() => pm.admin.recallHealth?.() ?? null),
        part(() => pm.admin.evalResult?.get?.() ?? null),
      ]);
      return {
        now: now(),
        // 【D117】回想的稳定性：出错按步骤 / 错误类型、整轮丢掉 / 部分给出、耗时、宿主等待的结果、最近的出错（只有代码事实）
        recall: recall == null ? null : recall.error ? recall : recallHealthRow(recall),
        store: st.error ? st : { readOnly: !!st.readOnly, readOnlyReason: st.readOnlyReason ?? null, schemaVersion: st.schemaVersion ?? null,
          codeSchemaVersion: st.codeSchemaVersion ?? null, schema: numbersOnly(st.schema), migration: numbersOnly(st.migration),
          adapters: Array.isArray(st.adapters) ? st.adapters.map(adapterTitle) : [], startup: startupSummary(st.startup), files: numbersOnly(st.files ?? null), vectors: numbersOnly(st.vectors ?? null),
          // 【D138】上一次夜间整理：模型调用用了多少、哪几步因为上限少做了、泛化问了几组、日记写了几天还缺几天（只有数字和步名）
          sleep: numbersOnly(st.sleep ?? null),
          // 【D136】提炼一直不成、搁置着的段：几段、各类原因、最多失败了几轮、最早从什么时候起、下次什么时候试
          extract: numbersOnly(st.extract ?? null) },
        embedding: health?.error ? health : healthRow(health),
        spaces: Array.isArray(spaces) ? spaces.map(spaceRow) : spaces,
        gpu, budget, selfCheck: checks,
        host: hs == null ? null : hs.error ? hs : hostDiag(hs, now()),
        degrade: hs && !hs.error ? degradeOf(hs) : null,
        // 【D126】「有记忆 / 没记忆」评测的最近一次结果；canRun：宿主能不能在这里跑
        memoryEval: memoryEval == null || memoryEval.error ? (memoryEval ?? null) : evalRow(memoryEval),
        memoryEvalCanRun: typeof hostOf('memoryEval')?.run === 'function',
      };
    },
  };

  return {
    names: Object.keys(VIEWS),
    /**
     * @param {string} view
     * @param {Record<string, string>} q   查询串（都是字符串）
     */
    async run(view, q) {
      if (!Object.hasOwn(VIEWS, view)) throw new InputError('view', '不认识的视图');
      return VIEWS[view](q);
    },
    selfCheck,
    settingLabels,
    config,
  };
}

// ── 星图（D163） ──────────────────────────────────────────────────────────
const arr = (v) => (Array.isArray(v) ? v : []);
const cursorOf = (c) => ({ inj: num(c?.inj) ?? 0, trace: num(c?.trace) ?? 0, told: num(c?.told) ?? 0 });
/**
 * 核心的星图快照 → 页面要的样子：场合换成 {key, title, adapter, oneOnOne}（名字照管理页别处的叫法），人名截到 60 字，
 * 其余的数字数组原样给（页面按 §3.1 的列读）。
 * @param {any} r
 */
export function starmapSnapshot(r) {
  if (!isObj(r)) return { unsupported: false, now: null, rev: null, stars: { cols: [], rows: [] }, people: [], places: [] };
  const stars = isObj(r.stars) ? { cols: arr(r.stars.cols).map(String).slice(0, 32), rows: arr(r.stars.rows) } : { cols: [], rows: [] };
  return {
    now: num(r.now), rev: typeof r.rev === 'string' ? r.rev.slice(0, 200) : String(r.rev ?? ''), cursor: cursorOf(r.cursor),
    params: { ageFloorMs: num(r.params?.ageFloorMs) ?? 180_000, timeUnitMs: num(r.params?.timeUnitMs) ?? 3_600_000 },
    t0: num(r.t0),
    people: arr(r.people).filter(isObj).map((p) => ({
      // 她自己的档案没名字时核心给 ''（页面显示「她」）
      id: num(p.id), name: typeof p.name === 'string' && p.name ? clip(p.name, 60) : p.self === true ? '' : '（没有名字）', self: p.self === true, principal: p.principal === true,
      closeness: num(p.closeness), n: num(p.n) ?? 0,
    })),
    places: arr(r.places).filter(isObj).map((s) => ({
      key: typeof s.key === 'string' ? s.key.slice(0, 128) : '',
      title: settingTitle(s.ownerLabel ? { label: s.ownerLabel, labelKind: 'name' } : s),
      adapter: typeof s.adapter === 'string' ? s.adapter.slice(0, 40) : null,
      oneOnOne: typeof s.oneOnOne === 'boolean' ? s.oneOnOne : null,
      n: num(s.n) ?? 0,
    })),
    stars,
    traces: arr(r.traces), recalls: arr(r.recalls), tells: arr(r.tells), mood: arr(r.mood), heard: arr(r.heard), nights: arr(r.nights).filter((x) => num(x) != null),
    dropped: num(r.dropped) ?? 0,
    counts: isObj(r.counts) ? numbersOnly(r.counts) : {},
  };
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function clip(s, max) {
  if (typeof s !== 'string') return null;
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
const short = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));

function modeConfig(core) {
  const m = core?.mode;
  if (!isObj(m)) return null;
  return { global: m.global ?? null, byAttributes: { principalOneOnOne: m.byAttributes?.principalOneOnOne ?? null, closed: m.byAttributes?.closed ?? null, public: m.byAttributes?.public ?? null } };
}

/** 启动步骤：只留状态（'ok' 或错误类型）。 */
function startupSummary(s) {
  if (!isObj(s)) return {};
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = isObj(v) && v.error ? { error: short(v.error, 64) } : (typeof v === 'string' ? short(v, 40) : 'ok');
  return out;
}

/** 备份总览：路径只留文件名（页面不需要整条路径）。 */
function trimBackupOverview(o) {
  if (!isObj(o)) return o;
  const base = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : p);
  return { ...o, last: isObj(o.last) ? { ...o.last, path: base(o.last.path) } : null };
}

function packRow(b) {
  return { id: b.id, kind: b.kind, reason: b.reason ?? null, location: b.location, name: typeof b.path === 'string' ? b.path.split(/[\\/]/).pop() : null,
    createdAt: b.createdAt, size: b.size ?? null, schemaVersion: b.schemaVersion ?? null, includesVectors: !!b.includesVectors, encrypted: !!b.encrypted,
    verifyStatus: b.verifyStatus ?? null, verifiedAt: b.verifiedAt ?? null };
}

function spaceRow(s) {
  return { spaceId: s.spaceId, model: s.model ?? null, dim: s.dim ?? null, status: s.status ?? null, coverage: s.coverage ?? null,
    createdAt: s.createdAt ?? null, activatedAt: s.activatedAt ?? null, retiredAt: s.retiredAt ?? null };
}

/** 核心的嵌入健康（worker.health）：只有状态和计数。 */
function healthRow(h) {
  if (!isObj(h)) return h ?? null;
  return { mode: short(h.mode, 20), reason: short(h.reason, 80), dense: !!h.dense, breakerOpen: !!h.breakerOpen, activeSpace: short(h.activeSpace, 128),
    activeUnproducible: !!h.activeUnproducible, shadow: isObj(h.shadow) ? { spaceId: short(h.shadow.spaceId, 128), coverage: num(h.shadow.coverage) } : null,
    queue: isObj(h.queue) ? numbersOnly(h.queue) : {}, device: short(h.device, 20), readOnlyThreads: typeof h.readOnlyThreads === 'boolean' ? h.readOnlyThreads : null };
}

/** 入口没报 displayName 时（老的核心、老的适配器、只给了 id 的列表）的退路：只认内置的两个入口 id，别的照原样显示。 */
const ADAPTER_NAMES = Object.freeze({ qq: 'QQ', 'dsh-web': 'DSH 网页' });
/** 入口 id → 管理页上的名字（D111：不显示原始 id）。 */
export const adapterTitle = (id) => (typeof id === 'string' ? ADAPTER_NAMES[id] ?? id : String(id ?? ''));

/**
 * 【D111】管理页上一个场合的称呼：有名字就是名字；只有一句说法（「一个 QQ 群」）时带上入口给的区分提示（人数、短码），
 * 几个没名字的群也分得开。只给管理页：她的提示词里没有提示。
 * @param {{label?: string, labelKind?: string, hint?: string|null}} s
 */
export function settingTitle(s) {
  const label = typeof s?.label === 'string' && s.label.trim() ? s.label.trim() : '（没有名字的场合）';
  const hint = typeof s?.hint === 'string' && s.hint.trim() ? s.hint.trim() : '';
  return s?.labelKind === 'description' && hint ? `${label}（${hint}）` : label;
}

/**
 * 【D111】这个场合收没收到过东西：never（一条感知、一个会话都没有）/ quiet（入口说现在接不上）/ ok。
 * reason 是入口报的原因（适配器的 quietReason），没有就用一句通用的。
 */
function receptionOf(s) {
  const percepts = Number.isSafeInteger(s?.percepts) ? s.percepts : null;
  const sessions = Number.isSafeInteger(s?.sessions) ? s.sessions : null;
  const quiet = typeof s?.quiet === 'string' && s.quiet ? s.quiet.slice(0, 200) : null;
  if (percepts === null) return { state: quiet ? 'quiet' : 'unknown', percepts: null, sessions, lastAt: null, reason: quiet };
  if (percepts === 0 && !sessions) {
    return { state: 'never', percepts: 0, sessions: sessions ?? 0, lastAt: null,
      reason: quiet ?? (s?.adapterConnected === false ? '还没有消息记在这里：这个入口现在没接上（插件里没有启用它）' : '还没有消息记在这里：入口还没把这里的任何消息交过来') };
  }
  return { state: quiet ? 'quiet' : 'ok', percepts, sessions, lastAt: s?.lastPerceptAt ?? null, reason: quiet };
}

function isOneOnOne(d) {
  const size = d?.audience?.size;
  return typeof size === 'number' && size <= 2 && d?.audience?.unknownObservers !== true;
}

/** 场合属性的一句话（给主人核对适配器描述得对不对，§13.1「场合」）。 */
function describeAudience(d) {
  if (!isObj(d)) return null;
  const a = d.audience ?? {};
  const disc = d.disclosure ?? {};
  return {
    size: a.size ?? null, entry: a.entry ?? null, unknownObservers: !!a.unknownObservers, membersKnown: a.membersKnown ?? null,
    visibleTo: disc.visibleTo ?? null, persistence: disc.persistence ?? null, attributedToHer: !!disc.attributedToHer,
    herRole: typeof d.ownership?.herRole === 'string' ? d.ownership.herRole.slice(0, 40) : null, herModerates: !!d.ownership?.herModerates,
    stability: d.stability ?? null, attending: d.attending !== false,
  };
}

/**
 * 预算（ports/budget.js 的 status()）→ 管理页要的那几个数。也认少几项的形状（别的宿主）。
 * @param {any} b
 */
export function budgetSummary(b, { embedding = null } = {}) {
  if (b == null) return null;
  if (!isObj(b)) return { error: 'SHAPE' };
  const t = isObj(b.today) ? b.today : {};
  const L = isObj(b.limits) ? b.limits : {};
  const bal = isObj(b.balance) ? b.balance : {};
  // DSH 的 BudgetPort 给 uncachedTokens / cachedTokens / outputTokens / reviews、balance.daysLeft / unlimited；也认短名字（别的宿主）
  const pick = (...vs) => { for (const v of vs) { const n = num(v); if (n != null) return n; } return null; };
  const days = bal.days === 'inf' || bal.unlimited === true ? 'inf' : pick(bal.daysLeft, bal.days);
  const today = {
    day: short(t.day, 10),
    calls: num(t.calls), uncached: pick(t.uncachedTokens, t.uncached), cached: pick(t.cachedTokens, t.cached), out: pick(t.outputTokens, t.out),
    review: pick(t.reviews, t.review), bgYuan: num(t.bgYuan), bgPeakYuan: num(t.bgPeakYuan), mainYuan: num(t.mainYuan), acctYuan: num(t.acctYuan), failed: num(t.failed),
    denied: isObj(t.denied) ? Object.values(t.denied).reduce((n, v) => n + (num(v) ?? 0), 0) : null,
    // 被护栏挡下的按用途和原因分开（键是 `用途:原因`）
    deniedBy: isObj(t.denied) ? Object.entries(t.denied).filter(([k, v]) => /^[\w-]{1,32}:[\w-]{1,32}$/.test(k) && num(v) > 0).slice(0, 40)
      .map(([k, v]) => { const [use, why] = k.split(':'); return { use, why, n: v }; }) : [],
    byUse: useRows(t.byUse),
  };
  const history = Array.isArray(b.history) ? b.history.filter(isObj).slice(-HISTORY_DAYS).map((h) => ({
    day: short(h.day, 10), calls: num(h.calls), failed: num(h.failed), in: num(h.in), cached: num(h.cached), out: num(h.out),
    bgYuan: num(h.bgYuan), bgPeakYuan: num(h.bgPeakYuan), mainYuan: num(h.mainYuan), acctYuan: num(h.acctYuan), denied: num(h.denied),
    ...(isObj(h.byUse) ? { byUse: useRows(h.byUse) } : {}) })) : [];
  const p = isObj(b.prices) ? b.prices : null;
  // 上限是 Infinity（不设上限的档、主人去掉的那一项）→ 'none'，页面写「不设上限」
  const cap = (v) => (v === Infinity ? 'none' : num(v));
  return {
    preset: short(b.preset, 20),
    custom: b.custom === true,
    today,
    limits: { dailyCalls: cap(L.dailyCalls), dailyUncachedTokens: cap(L.dailyUncachedTokens), dailyOutputTokens: cap(L.dailyOutputTokens),
      egressReservePerDay: num(L.egressReservePerDay), perSourceShare: num(L.perSourceShare), mainChatRatioCap: num(L.mainChatRatioCap), balanceProtectDays: num(L.balanceProtectDays) },
    ratioToMain: num(b.ratioToMain),
    // 后台占整个账户（后台 + 所有同一提供方的会话）的多少；老的记录没有账户数，用她的会话兜底
    shareOfAccount: shareOf(today.bgYuan, today.acctYuan, today.mainYuan),
    balance: { known: !!bal.known, days, error: short(bal.error, 64), dailySpend: num(bal.dailySpend) },
    paused: !!b.paused, pausedReason: short(b.pausedReason, 64),
    history,
    recent: recentOf(history, today),
    prices: p && { hit: num(p.hit), miss: num(p.miss), out: num(p.out), peakFactor: num(p.peakFactor),
      peakHours: Array.isArray(p.peakHours) ? p.peakHours.slice(0, 6).filter((x) => Array.isArray(x) && x.length === 2 && num(x[0]) != null && num(x[1]) != null) : [] },
    uses: Array.isArray(b.uses) ? b.uses.filter((u) => typeof u === 'string' && /^[\w-]{1,32}$/.test(u)).slice(0, 20) : [],
    // 向量（嵌入）：本机的 Ollama 不花钱；配成别的地址的（云端接口）这里如实说不是本机
    embedding: embeddingCost(embedding),
  };
}

const HISTORY_DAYS = 90;
/** 一天各用途的计数 → {use: {calls, failed, estimated, in, cached, out, yuan, partial}}；D120 以前只有次数（数字），标 partial。 */
function useRows(o) {
  if (!isObj(o)) return {};
  const out = {};
  for (const [k, v] of Object.entries(o).slice(0, 20)) {
    if (!/^[\w-]{1,32}$/.test(k)) continue;
    if (typeof v === 'number') { out[k] = { calls: num(v) ?? 0, failed: 0, estimated: 0, in: null, cached: null, out: null, yuan: null, partial: true }; continue; }
    if (!isObj(v)) continue;
    out[k] = { calls: num(v.calls) ?? 0, failed: num(v.failed) ?? 0, estimated: num(v.estimated) ?? 0, in: num(v.in), cached: num(v.cached), out: num(v.out), yuan: num(v.yuan), ...(v.partial ? { partial: true } : {}) };
  }
  return out;
}
const shareOf = (bg, acct, main) => {
  const others = Math.max(acct ?? 0, main ?? 0);
  return bg != null && bg + others > 0 ? Math.round((bg / (bg + others)) * 1000) / 1000 : null;
};
/** 最近 30 天（含今天）：每天后台 / 她的聊天 / 整个账户，和合计。 */
function recentOf(history, today) {
  const rows = history.filter((h) => h.day && h.day !== today.day).map((h) => ({ day: h.day, bgYuan: h.bgYuan, mainYuan: h.mainYuan, acctYuan: h.acctYuan, calls: h.calls }));
  if (today.day) rows.push({ day: today.day, bgYuan: today.bgYuan, mainYuan: today.mainYuan, acctYuan: today.acctYuan, calls: null, today: true });
  const days = rows.slice(-30);
  const sum = (k) => Math.round(days.reduce((a, d) => a + (d[k] ?? 0), 0) * 10000) / 10000;
  const bg = sum('bgYuan'); const main = sum('mainYuan');
  const acct = Math.round(days.reduce((a, d) => a + Math.max(d.acctYuan ?? 0, d.mainYuan ?? 0), 0) * 10000) / 10000;
  return { days, total: { days: days.length, bgYuan: bg, mainYuan: main, acctYuan: acct, ratioToMain: main > 0 ? Math.round((bg / main) * 1000) / 1000 : null, shareOfAccount: shareOf(bg, acct, main) } };
}
/** 嵌入花不花钱：本机地址（127.0.0.1 / localhost / ::1）上的服务不花钱。 */
function embeddingCost(e) {
  if (!isObj(e)) return null;
  let local = false;
  try { local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(String(e.url ?? '')).hostname); } catch { local = false; }
  return { provider: short(e.provider, 32), local };
}

/**
 * 资源管家（host/gpu/governor.js 的 status()）+ 配置里的游戏模式 → 显卡卡片要的数。
 * @param {any} g
 * @param {any} cfgHost   宿主配置的 host 部分（游戏模式的截止时间在 host.gpu.gameMode.until）
 * @param {number} at
 * @param {boolean} canSet
 */
export function gpuSummary(g, cfgHost, at, canSet) {
  if (g == null) return null;
  if (!isObj(g)) return { error: 'SHAPE' };
  const until = num(cfgHost?.gpu?.gameMode?.until);
  const reasons = Array.isArray(g.reasons) ? g.reasons.slice(0, 12).map((r) => short(r, 40)) : [];
  const game = until === -1 || (until != null && until > at) || reasons.includes('game-mode');
  const last = isObj(g.last) ? g.last : null;
  const card = isObj(last?.gpu) ? last.gpu : null;
  return {
    policy: short(g.policy, 20), device: short(g.device, 10), reasons, cpuThreads: num(g.cpuThreads), rerankAllowed: !!g.rerankAllowed, nextGpuAt: num(g.nextGpuAt),
    sampler: typeof g.sampler === 'boolean' ? g.sampler : null, samples: num(g.samples),
    vram: card ? { freeMb: num(card.freeMb), totalMb: num(card.totalMb), usedMb: num(card.usedMb), utilPct: num(card.utilPct) } : null,
    freeVramP10Mb: num(g.freeVramP10Mb), procHits: num(last?.procHits), fullscreen: typeof last?.fullscreen === 'boolean' ? last.fullscreen : null,
    sampledAt: num(last?.at), gpuErrorAt: num(g.gpuErrorAt),
    gameMode: { on: game, until: until === -1 ? -1 : until != null && until > at ? until : null },
    canSet,
  };
}

/** 宿主状态 → 总览要的几个数（钩子熔断、认领冲突、适配器、未分类工具、最近的错误）。 */
export function hostSummary(s, at) {
  if (!isObj(s)) return null;
  const hooks = isObj(s.hooks) ? Object.values(s.hooks).filter(isObj) : [];
  const recent = Array.isArray(s.log?.recent) ? s.log.recent : [];
  return {
    ready: s.ready === true, error: short(s.error, 64),
    uptimeMs: num(s.startedAt) != null ? Math.max(0, at - s.startedAt) : null,
    breakersOpen: hooks.reduce((n, h) => n + (num(h.openSessions) ?? 0), 0),
    hookErrors: hooks.reduce((n, h) => n + (num(h.errors) ?? 0), 0),
    conflicts: Array.isArray(s.claims?.conflicts) ? s.claims.conflicts.length : 0,
    claimed: num(s.claims?.live?.claimed),
    adapters: Array.isArray(s.adapters) ? s.adapters.slice(0, 20).map((a) => ({ id: short(a?.id, 40), name: short(a?.name, 40) ?? adapterTitle(a?.id), ok: a?.ok === true, disabled: !!a?.disabled, error: short(a?.error, 64), tools: num(a?.tools) })) : [],
    unclassified: Array.isArray(s.tooltable?.unclassified) ? s.tooltable.unclassified.length : 0,
    configWarnings: num(s.configWarnings) ?? 0,
    recentErrors: recent.slice(-8).reverse().map((r) => ({ at: num(r?.at), level: short(r?.level, 8), event: short(r?.event, 80), error: short(r?.error, 64) })),
  };
}

/** 宿主状态 → 诊断区（只有数字和短状态）：钩子、认领、后台模型、嵌入服务、重排、外发审视、注入、调度、工具。 */
export function hostDiag(s, at) {
  if (!isObj(s)) return null;
  const hooks = isObj(s.hooks) ? Object.entries(s.hooks).filter(([, h]) => isObj(h)).slice(0, 20).map(([name, h]) => ({
    name: short(name, 40), calls: num(h.calls), errors: num(h.errors), slow: num(h.slow), skipped: num(h.skipped), breakerOpened: num(h.breakerOpened),
    openSessions: num(h.openSessions), p50Ms: num(h.p50Ms), p95Ms: num(h.p95Ms), lastError: short(h.lastError, 64) })) : [];
  const c = isObj(s.claims) ? s.claims : {};
  const llm = isObj(s.llm) ? s.llm : null;
  const emb = isObj(s.embedding) ? s.embedding : null;
  const rr = isObj(s.rerank) ? s.rerank : null;
  const sch = isObj(s.scheduler) ? s.scheduler : null;
  const unclassified = Array.isArray(s.tooltable?.unclassified) ? s.tooltable.unclassified.slice(0, 20).map((x) => ({ tool: short(x?.tool, 80), count: num(x?.count) })) : [];
  return {
    ...hostSummary(s, at),
    hooks,
    claims: { claimed: num(c.live?.claimed), none: num(c.live?.none), conflicts: Array.isArray(c.conflicts) ? c.conflicts.length : 0,
      // 入口用管理页上的名字（D111：不显示原始 id）
      byAdapter: isObj(c.byAdapter) ? Object.fromEntries(Object.entries(numbersOnly(c.byAdapter)).map(([k, n]) => [adapterTitle(k), n])) : {} },
    llm: llm && { calls: num(llm.calls), failures: num(llm.failures), lastError: short(llm.lastError, 64), backoffUntil: num(llm.backoffUntil),
      queued: isObj(llm.queued) ? numbersOnly(llm.queued) : {}, byUse: isObj(llm.byUse) ? numbersOnly(llm.byUse) : {} },
    embedPort: emb && { ok: emb.ok === true, version: short(emb.version, 32), model: short(emb.model, 80), modelPresent: emb.modelPresent === true, tier: short(emb.tier, 20),
      dim: num(emb.dim), breakerOpen: !!emb.breakerOpen, error: short(emb.error, 64), queue: num(emb.queue), requests: num(emb.requests), failures: num(emb.failures),
      lastMs: num(emb.lastMs), checkedAt: num(emb.at) },
    rerank: rr && { configured: rr.configured === true, running: !!rr.running, allowed: !!rr.allowed, breakerOpen: !!rr.breakerOpen },
    scheduler: sch && { running: !!sch.running, ticks: num(sch.ticks), tickErrors: num(sch.tickErrors), lastTickAt: num(sch.lastTickAt), lastTickMs: num(sch.lastTickMs),
      jobsRan: num(sch.jobsRan), jobsFailed: num(sch.jobsFailed) },
    egress: isObj(s.egress) ? numbersOnly(s.egress) : null,
    context: isObj(s.context) ? numbersOnly({ ...s.context, degrade: undefined }) : null,
    tools: isObj(s.tools) ? numbersOnly(s.tools) : null,
    unclassifiedTools: unclassified,
    features: isObj(s.features) ? numbersOnly(s.features) : null,
    logCounts: isObj(s.log?.counts) ? numbersOnly(s.log.counts) : {},
  };
}

/** 回想的健康（D117）→ 诊断区：只留数字、步骤名、错误类型和代码位置（核心本来就只给这些，这里再按形状收一遍）。 */
export function recallHealthRow(x) {
  if (!isObj(x)) return null;
  const nums = (o) => (isObj(o) ? Object.fromEntries(Object.entries(o).filter(([k, v]) => /^[\w.-]{1,64}$/.test(k) && Number.isFinite(v)).slice(0, 60)) : {});
  const day = (d) => ({ day: short(d?.day, 10), recalls: num(d?.recalls) ?? 0, errors: num(d?.errors) ?? 0, partial: num(d?.partial) ?? 0, lost: num(d?.lost) ?? 0,
    legacyErrors: num(d?.legacyErrors) ?? 0, aborted: num(d?.aborted) ?? 0, skipped: num(d?.skipped) ?? 0,
    byStage: nums(d?.byStage), byCode: nums(d?.byCode), ms: nums(d?.ms), host: { ...nums(d?.host), wait: nums(d?.host?.wait) }, embed: nums(d?.embed),
    // D165：按层的计数（正文被截短 / 因为额度没装进去 / 因为上限没装进去）是层名 → 条数
    inject: { ...nums(d?.inject), clipped: nums(d?.inject?.clipped), budgetDroppedBy: nums(d?.inject?.budgetDroppedBy), capDropped: nums(d?.inject?.capDropped) } });
  return {
    days: Array.isArray(x.days) ? x.days.slice(0, 7).filter(isObj).map(day) : [],
    // 【D133】各活跃会话的注入预算：会话 id 的前几位、适配器、今天已用 / 上限、滚动窗口已用 / 上限（null = 不限或窗口还没满）、记了几步
    injectBudget: Array.isArray(x.injectBudget) ? x.injectBudget.slice(0, 20).filter(isObj).map((s) => ({ session: short(s.session, 8), adapter: short(s.adapter, 32),
      dayUsed: num(s.dayUsed), dayLimit: num(s.dayLimit), rollingUsed: num(s.rollingUsed), rollingLimit: num(s.rollingLimit), steps: num(s.steps) })) : [],
    buckets: Array.isArray(x.buckets) ? x.buckets.slice(0, 12).map((b) => short(b, 12)) : [],
    recent: Array.isArray(x.recent) ? x.recent.slice(0, 20).filter(isObj).map((r) => ({ at: num(r.at), stage: short(r.stage, 24), code: short(r.code, 32), frame: short(r.frame, 80),
      trigger: short(r.trigger, 16), level: num(r.level), layer: short(r.layer, 20), waitedMs: num(r.waitedMs), served: num(r.served), bg: r.bg === true })) : [],
  };
}

/** 降级级别分布（每轮回想记一次，宿主的注入统计 context.degrade = [L0..L4]）。 */
function degradeOf(s) {
  const d = s?.context?.degrade ?? s?.degrade ?? null;
  if (Array.isArray(d)) return d.slice(0, 5).map((x) => num(x) ?? 0);
  if (isObj(d)) return [0, 1, 2, 3, 4].map((i) => num(d[i]) ?? num(d[`L${i}`]) ?? 0);
  return null;
}

/** 宿主状态里上次自检的摘要（{at, level, fails, warns}）→ 总览的形状。 */
function selfCheckSummaryOf(x) {
  return { at: num(x.at), total: null, failed: num(x.fails) ?? 0, warned: num(x.warns) ?? 0, level: short(x.level, 10) };
}

const CHECK_STATUS = ['ok', 'warn', 'fail', 'info', 'skip'];
/**
 * 宿主的自检结果统一成 {items: [{id, area, label, status: ok|warn|fail|info|skip, detail, disables}], at}。
 * 宿主（host/selfcheck.js）给 {at, level, items: [{id, group, level, label, hint?, disables?: string[]}]}；也认数组、{checks}、{ok: boolean} 的形状。
 */
export function normalizeChecks(r) {
  if (r && r.error) return r;
  const raw = Array.isArray(r) ? r : Array.isArray(r?.checks) ? r.checks : Array.isArray(r?.items) ? r.items : [];
  const items = raw.slice(0, 200).map((c, i) => {
    const st = c?.status ?? c?.level ?? (c?.ok === true ? 'ok' : c?.ok === false ? (c?.severity === 'warn' ? 'warn' : 'fail') : c?.skipped ? 'skip' : 'warn');
    const s = String(st);
    const dis = Array.isArray(c?.disables) ? c.disables.map(String).join('、') : c?.disables;
    const detail = c?.detail ?? c?.message ?? c?.hint;
    return {
      id: String(c?.id ?? c?.name ?? `#${i + 1}`).slice(0, 80),
      area: (c?.area ?? c?.group) != null ? String(c.area ?? c.group).slice(0, 40) : null,
      label: String(c?.label ?? c?.title ?? c?.id ?? c?.name ?? '').slice(0, 200),
      status: CHECK_STATUS.includes(s) ? s : 'warn',
      detail: detail != null ? String(detail).slice(0, 300) : null,
      disables: dis != null && dis !== '' ? String(dis).slice(0, 160) : null,
    };
  });
  return { items, at: typeof r?.at === 'number' ? r.at : null, level: typeof r?.level === 'string' ? r.level.slice(0, 10) : null };
}

/** 总览顶部的提醒（只有状态，不带内容）。level: bad 红 / warn 黄 / info 灰。 */
function alertsOf(o) {
  const out = [];
  const add = (level, text, tab) => out.push({ level, text, tab: tab ?? null });
  if (o.store?.error) add('bad', '记忆库的状态读不出来', 'diagnostics');
  else if (o.store?.readOnly) add('bad', o.store.readOnlyReason === 'newer-schema' || (o.store.schemaVersion ?? 0) > (o.store.codeSchemaVersion ?? Infinity)
    ? '数据库的版本比插件新（插件被回退过）：现在只读，不注入、不记新东西' : '数据库现在是只读的：不注入、不记新东西', 'diagnostics');
  if (o.host?.error) add('warn', '宿主的状态读不出来', 'diagnostics');
  else if (o.host && !o.host.ready && o.host.error) add('bad', `记忆插件没有启动好（${o.host.error}）：这段时间不感知、不注入，聊天照常`, 'diagnostics');
  if (o.host && !o.host.error && o.host.breakersOpen > 0) add('bad', `有 ${o.host.breakersOpen} 个会话的钩子因为连续出错暂时关掉了（10 分钟后自动恢复）`, 'diagnostics');
  if (o.host && !o.host.error && o.host.conflicts > 0) add('warn', `有 ${o.host.conflicts} 个会话两个入口都说是自己的，没有认领（fail closed）`, 'diagnostics');
  if (o.host && !o.host.error && o.host.unclassified > 0) add('warn', `有 ${o.host.unclassified} 个工具没有分类：记忆开着的场合带长文本的调用会被拒绝`, 'diagnostics');
  if (o.config?.loadError) add('bad', `配置文件读不了（${o.config.loadError}）：现在用的是默认值，管理页也改不了设置`, 'config');
  if (o.config?.pendingRisky > 0) add('bad', `配置文件被直接改过，有 ${o.config.pendingRisky} 项有风险的改动还没生效：到「设置」里确认或丢弃`, 'config');
  const b = o.backup;
  if (b && !b.error) {
    if (!b.offsite?.configured) add('warn', '备份只在这块盘上，硬盘坏了会全部丢失。建议在「备份与恢复」里设一个异地目录', 'backups');
    else if (!b.offsite?.encrypted) add('warn', '设了异地目录，但还没开备份加密：异地副本要先设恢复码', 'backups');
    if (b.lowDisk) add('bad', `备份所在的盘剩余空间不足${b.diskFreeGb != null ? `（${b.diskFreeGb} GB）` : ''}`, 'backups');
    if (b.failed > 0) add('bad', `有 ${b.failed} 份备份没通过验证`, 'backups');
    if (!b.lastOk) add('warn', '还没有一份验证过的备份', 'backups');
    else if (o.now - b.lastOk > 2 * DAY) add('warn', '最近两天没有验证过的新备份', 'backups');
    if (b.lastDrill && !b.lastDrill.ok) add('bad', '最近一次恢复演练没通过', 'backups');
    if (Array.isArray(b.replay) && b.replay.length) add('info', '刚恢复过备份，正在从各入口补回快照之后的经历', 'backups');
    if (Array.isArray(b.gaps) && b.gaps.length) add('warn', `恢复后有 ${b.gaps.length} 段经历补不回来`, 'backups');
  } else if (b?.error) add('warn', '备份状态读不出来', 'backups');
  const e = o.embedding;
  if (e && !e.error) {
    if (e.breakerOpen) add('warn', '嵌入服务连续失败，暂时熔断：检索降级（只用词法和实体）', 'diagnostics');
    else if (!e.dense && !o.embeddingOff) add('warn', '向量检索暂时不可用：检索降级（只用词法和实体）', 'diagnostics');
  }
  if (Array.isArray(o.spaces) && o.spaces.some((s) => s.status === 'suspect')) add('bad', '向量空间被标成可疑（嵌入模型可能被悄悄换过）', 'diagnostics');
  const r = o.retention;
  if (r && !r.error && r.pending) add('info', `原文保留期将缩短为 ${retentionLabel(r.pending.to)}：冷静期还剩 ${r.pending.daysLeft} 天，随时可以取消`, 'config');
  if (o.selfCheck && !o.selfCheck.error && o.selfCheck.failed > 0) add('bad', `启动自检有 ${o.selfCheck.failed} 项没通过（对应的功能已关掉，聊天不受影响）`, 'diagnostics');
  const bud = o.budget;
  if (bud && !bud.error && bud.paused) add('warn', '余额保护已启动：后台提炼和整理暂停，聊天照常', 'diagnostics');
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

export const retentionLabel = (v) => ({ '1y': '1 年', '2y': '2 年', '5y': '5 年', forever: '永久' })[v] ?? String(v);
