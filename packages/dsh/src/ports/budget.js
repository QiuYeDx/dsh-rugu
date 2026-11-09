// BudgetPort（§10.6）：效果优先，花费是可配置的护栏。只防两件事：
//   1. 程序失控（死循环、刷屏群把调用量放大几十倍）——每天调用次数 / 未命中输入 / 输出的失控上限、单个来源的份额上限；
//   2. 余额被后台吃光、连她的聊天都停掉（H5：402 → QUOTA）——余额保护：剩余不够 N 天的预计花费时停后台（宽松档 1 天，可设 0 关闭）。
// 三档预设（宽松默认 / 节省 / 不设上限）的数在核心的配置里（budget.presets、budgetLimits()），主人单独改的在 budget.overrides（D121），执行在这里。
//   - 上限写 null = 不设（这里按无穷大）；每天输出的上限按宿主每档的数（host.budget.dailyOutputTokens），主人改过就用 overrides 里的；
//   - 「不设上限」档：次数、token、比例都不拦，余额保护照留；
//   - 外发审视（use='review'）永远单独预留（每天 egressReservePerDay 次），不受预设、失控上限和余额保护影响（评审:PS-14）；
//   - 对她说的一对一内容的提炼（meta.reserved）超了失控上限之后还有一点预留份额，不会因为大群刷屏而停（§7.2）；
//   - 余额保护触发时只剩外发审视的预留：提炼、夜间整理、第二段评估都停；充值后自动恢复（有余额来源：读到余额大于 0；
//     没有余额来源：停 quotaProbeMs 之后放一次试试，成功就恢复，再报 402 再停）；
//   - 「余额还能撑几天」按整个账户的花费估：后台 + 所有会话（不只是她的会话：主人写代码、子代理、桥接的辅助会话花的是同一份余额），
//     有连续的余额读数时再和「余额每天掉多少」取大的那个。她的会话的花费（main）只用来算后台和主聊天的比例。
// 计数只有数字，按本机的日子存在 <数据目录>/host-budget.json，重启不丢（D120：最近 90 天的历史，每天按用途分开）。
//   - 准的：次数和 token 数（宿主 usage 块报的未命中 / 命中 / 输出；宿主没报用量的按字数估，单独记 estimated）；
//   - 估的：元（按配置的价目 host.budget.prices 和峰谷时段折算；DeepSeek 法定节假日全天按空闲价，这里不认节假日，会略高估）。
//   - 每个用途（byUse）：真正发出去的调用次数、其中失败的（超时、中止、报错）、未命中 / 命中 / 输出 token、估算元；
//     失败的调用宿主报了用量也照记（结果丢了，钱照样花了）。
//   - 节省档的 stage2Scope='direct'：第二段评估只在这一轮直接对她说（或她自己要回想）时放行——核心在 allow 的 meta.direct 里告诉这里；
//     不带 direct 的调用（常驻区、管理页的模拟）不受这一条限制。
import fs from 'node:fs';
import { budgetLimits } from 'rugu-core';
import { localDay, readJson, writeJsonAtomic } from '../host/util.js';

const M = 1_000_000;
/** 插件自己的后台调用的全部用途（管理页按这个顺序列）。 */
export const BG_USES = Object.freeze(['glance', 'extract', 'sleep', 'summary', 'appraise', 'review', 'rewrite', 'perceive']);
export const HISTORY_DAYS = 90;
const USE_KEY = /^[a-z][\w-]{0,31}$/;

const emptyUse = () => ({ calls: 0, failed: 0, estimated: 0, in: 0, cached: 0, out: 0, yuan: 0 });
const emptyDay = (day) => ({
  day, calls: 0, uncached: 0, cached: 0, out: 0, review: 0, reservedCalls: 0, glanceReserved: 0,
  byUse: {}, bySource: {}, bgYuan: 0, bgPeakYuan: 0, failed: 0, main: { in: 0, cached: 0, out: 0, yuan: 0 }, acctYuan: 0, denied: {},
});
const n0 = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
/**
 * 一个用途一天的计数。D120 以前的文件里 byUse 只有放行的次数（数字）：换成 {calls, partial:true}，那天的 token 和元没按用途分开记。
 * @param {any} v
 * @returns {{calls: number, failed: number, estimated: number, in: number, cached: number, out: number, yuan: number, partial?: boolean}}
 */
export function useEntry(v) {
  if (typeof v === 'number') return { ...emptyUse(), calls: n0(v), partial: true };
  if (!v || typeof v !== 'object') return emptyUse();
  const e = { calls: n0(v.calls), failed: n0(v.failed), estimated: n0(v.estimated), in: n0(v.in), cached: n0(v.cached), out: n0(v.out), yuan: n0(v.yuan) };
  return v.partial ? { ...e, partial: true } : e;
}
const byUseOf = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => USE_KEY.test(k)).map(([k, v]) => [k, useEntry(v)]));
/** 宿主的用量 → {in, cached, out}。in 是未命中缓存的输入；写缓存的 token（cacheWrite，DeepSeek 没有单独的价）也按未命中算。 */
const usageNums = (u) => ({ in: n0(u?.in) + n0(u?.cacheWrite), cached: n0(u?.cached), out: n0(u?.out) });
const roundUse = (e) => ({ calls: e.calls, failed: e.failed, estimated: e.estimated, in: e.in, cached: e.cached, out: e.out, yuan: round(e.yuan), ...(e.partial ? { partial: true } : {}) });
/** 一天收进历史的样子（D120）。 */
function historyOf(d) {
  const byUse = Object.fromEntries(Object.entries(d.byUse ?? {}).map(([k, v]) => [k, roundUse(useEntry(v))]));
  const calls = Object.values(byUse).reduce((a, x) => a + x.calls, 0);
  const denied = Object.values(d.denied ?? {}).reduce((a, x) => a + n0(x), 0);
  return { day: d.day, calls, failed: n0(d.failed), in: n0(d.uncached), cached: n0(d.cached), out: n0(d.out), bgYuan: round(d.bgYuan), bgPeakYuan: round(d.bgPeakYuan),
    byUse, denied, mainYuan: round(d.main?.yuan), acctYuan: round(d.acctYuan) };
}
/** 价目里的高峰时段（北京时间工作日 9–12、14–18 点，附录 G）。 */
function isPeak(prices, at) {
  const p = prices ?? {};
  const local = new Date(at + (p.peakTzOffsetMin ?? 480) * 60_000);
  const h = local.getUTCHours();
  const wd = local.getUTCDay();
  return wd >= 1 && wd <= 5 && (p.peakHours ?? []).some(([a, b]) => h >= a && h < b);
}

/**
 * 按价目折算（元）。峰谷按北京时间工作日 9–12、14–18 点（附录 G）；peakTzOffsetMin 可配。
 * @param {{in: number, cached: number, out: number}} u
 */
export function priceOf(u, prices, at) {
  const p = prices ?? {};
  const f = isPeak(p, at) ? (p.peakFactor ?? 1) : 1;
  return ((u.cached || 0) * (p.hit ?? 0) + (u.in || 0) * (p.miss ?? 0) + (u.out || 0) * (p.out ?? 0)) * f / M;
}

/** 从 JSON 里按 a.b.c 取数字。 */
function pick(obj, p) {
  let v = obj;
  for (const k of String(p || '').split('.').filter(Boolean)) { if (v == null || typeof v !== 'object') return NaN; v = v[k]; }
  return Number(v);
}

/**
 * @param {{coreConfig: {get: () => object}, hostConfig: () => object, file?: string|null, now: () => number,
 *          log?: {warn: Function, info: Function}, fsImpl?: typeof fs, providerOf?: () => (string|null)}} opt
 *   providerOf：后台用的是哪个提供方（只把同一个提供方的会话用量算进账户花费）
 */
export function createBudget({ coreConfig, hostConfig, file = null, now, log = { warn() {}, info() {} }, fsImpl = fs, providerOf = () => null }) {
  let d = null;
  let history = [];               // 最近 90 天（D120）：historyOf() 的样子；更早的文件里只有 {day, bgYuan, mainYuan, acctYuan}
  let dirty = false;
  let saveTimer = null;
  let quotaHitAt = 0;             // 宿主报了 QUOTA（402）：按余额用完处理，直到余额来源说恢复了
  let balance = { value: null, at: 0, error: null };
  /** 最近 48 小时的余额读数（只在内存里）：余额每天掉多少 */
  let readings = [];

  const load = () => {
    if (!file) return;
    try {
      const v = readJson(file, null);
      if (v && typeof v === 'object') {
        if (v.today && typeof v.today.day === 'string') {
          d = { ...emptyDay(v.today.day), ...v.today, byUse: byUseOf(v.today.byUse) };
          d.main = { ...emptyDay('').main, ...(v.today.main && typeof v.today.main === 'object' ? v.today.main : {}) };
        }
        if (Array.isArray(v.history)) history = v.history.filter((h) => h && typeof h.day === 'string').slice(-HISTORY_DAYS);
      }
    } catch (e) { log.warn('budget.load', { error: e?.code ?? 'Error' }); }
  };
  const flush = () => {
    if (!file || !dirty) return;
    dirty = false;
    try { writeJsonAtomic(file, { today: d, history }); } catch (e) { log.warn('budget.save', { error: e?.code ?? 'Error' }); }
  };
  const touch = () => {
    dirty = true;
    if (file && !saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 5000);
      saveTimer.unref?.();
    }
  };
  const today = () => {
    const key = localDay(now());
    if (!d || d.day !== key) {
      if (d) history = [...history.filter((h) => h.day !== d.day), historyOf(d)].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-HISTORY_DAYS);
      d = emptyDay(key);
      touch();
    }
    return d;
  };
  load();

  const limits = () => {
    const cfg = coreConfig.get();
    const L = budgetLimits(cfg);
    const h = hostConfig().budget ?? {};
    const preset = cfg.budget?.preset ?? 'loose';
    const overridden = Object.keys(cfg.budget?.overrides ?? {});
    // null / 没有 = 不设上限
    const cap = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : Infinity);
    const out = Object.hasOwn(L, 'dailyOutputTokens') ? L.dailyOutputTokens : h.dailyOutputTokens?.[preset];
    return { ...L, preset, overridden, dailyCalls: cap(L.dailyCalls), dailyUncachedTokens: cap(L.dailyUncachedTokens), dailyOutputTokens: cap(out),
      perSourceShare: typeof L.perSourceShare === 'number' ? L.perSourceShare : 1, reservedExtractShare: h.reservedExtractShare ?? 0.2 };
  };
  /** 一天的账户花费：后台 + 所有会话（老的记录没有 acctYuan，用她的会话的花费兜底）。 */
  const spentOf = (bg, acct, main) => (bg || 0) + Math.max(acct || 0, main || 0);
  /** 余额每天掉多少（元）：最近一段没有充值（读数一直不涨）、跨度至少 6 小时的读数。不够就是 0。 */
  const balanceDrop = () => {
    if (readings.length < 2) return 0;
    let i = readings.length - 1;
    while (i > 0 && readings[i - 1].value >= readings[i].value) i -= 1;
    const a = readings[i];
    const b = readings[readings.length - 1];
    const span = b.at - a.at;
    return span >= 6 * 3_600_000 && a.value > b.value ? ((a.value - b.value) / span) * 86_400_000 : 0;
  };
  /** 平均每天花多少元：最近 7 天，不够就用今天按时间外推；和余额每天掉多少取大的。 */
  const dailySpend = () => {
    const recent = history.slice(-7).map((h) => spentOf(h.bgYuan, h.acctYuan, h.mainYuan)).filter((x) => x > 0);
    let model = 0;
    if (recent.length) model = recent.reduce((a, b) => a + b, 0) / recent.length;
    else {
      const t = today();
      const start = new Date(now()); start.setHours(0, 0, 0, 0);
      const frac = Math.max(1 / 24, (now() - start.getTime()) / 86_400_000);
      const spent = spentOf(t.bgYuan, t.acctYuan, t.main.yuan);
      model = spent > 0 ? spent / frac : 0;
    }
    return Math.max(model, balanceDrop());
  };
  const daysOfBalance = () => {
    if (!(Number.isFinite(balance.value))) return null;
    const per = dailySpend();
    return per > 0 ? balance.value / per : Infinity;
  };
  /** 余额保护（§10.6）：剩余不够 balanceProtectDays 天的预计花费；宿主报过 QUOTA 也算。 */
  const protectState = () => {
    const L = limits();
    const days = daysOfBalance();
    // 402 之后没有可信的余额读数（没配余额来源、或者读不到）：停一阵再放一次试试，不然充了值也永远停着
    const probeMs = Number(hostConfig().budget?.quotaProbeMs) > 0 ? Number(hostConfig().budget.quotaProbeMs) : 20 * 60_000;
    if (quotaHitAt && !Number.isFinite(balance.value) && now() - quotaHitAt >= probeMs) { quotaHitAt = 0; log.info('budget.quotaProbe', {}); }
    const quota = quotaHitAt > 0;
    const low = L.balanceProtectDays > 0 && days != null && days < L.balanceProtectDays;
    return { paused: quota || low, reason: quota ? 'quota' : low ? 'balance' : null, days };
  };

  const deny = (use, why) => {
    const t = today();
    t.denied[`${use}:${why}`] = (t.denied[`${use}:${why}`] ?? 0) + 1;
    touch();
    return false;
  };

  return {
    /**
     * 放行一次后台调用（放行就算占用了一次：核心在 allow 之后马上调 llm.complete）。
     * @param {string} use
     * @param {number} estTokens  估计的未命中输入
     * @param {{sourceKey?: string, reserved?: boolean, direct?: boolean}} [meta]
     */
    allow(use, estTokens = 0, meta = {}) {
      const t = today();
      const L = limits();
      const est = Math.max(0, Number(estTokens) || 0);
      if (use === 'review') {
        if (t.review >= L.egressReservePerDay) return deny(use, 'reserve');
        t.review += 1;
        touch();
        return true;
      }
      if (use === 'appraise' && L.stage2Scope === 'direct' && meta?.direct === false) return deny(use, 'scope');
      if (protectState().paused) return deny(use, 'balance');
      let over = null;
      if (t.calls >= L.dailyCalls) over = 'calls';
      else if (t.uncached + est > L.dailyUncachedTokens) over = 'tokens';
      else if (t.out >= L.dailyOutputTokens) over = 'output';
      else if (L.mainChatRatioCap != null && t.main.yuan > 0 && t.bgYuan > L.mainChatRatioCap * t.main.yuan) over = 'ratio';
      else if (meta.sourceKey && L.perSourceShare < 1 && (t.bySource[meta.sourceKey] ?? 0) + est > L.perSourceShare * L.dailyUncachedTokens) over = 'source';
      if (over) {
        // 第一眼（D106）超了以后还有自己的一小份预留（budget.glanceReservePerDay），大群刷屏也不让她听不懂私聊里刚说的话；余额保护照样挡
        if (use === 'glance' && meta.reserved && (t.glanceReserved ?? 0) < (L.glanceReservePerDay ?? 0)) {
          t.glanceReserved = (t.glanceReserved ?? 0) + 1;
        } else {
          // 调用次数不设上限时（只有 token 或比例到了）：对她说的一对一提炼的预留也不按次数限
          const room = Number.isFinite(L.dailyCalls) ? Math.ceil(L.dailyCalls * L.reservedExtractShare) : Infinity;
          if (!(use === 'extract' && meta.reserved && over !== 'source' && t.reservedCalls < room)) return deny(use, over);
          t.reservedCalls += 1;
        }
      }
      t.calls += 1;
      if (meta.sourceKey) t.bySource[meta.sourceKey] = (t.bySource[meta.sourceKey] ?? 0) + est;
      touch();
      return true;
    },
    /** BudgetState（§3.3）。spentToday 是后台今天折算的元。 */
    state() {
      const t = today();
      const L = limits();
      const p = protectState();
      return {
        spentToday: round(t.bgYuan),
        baseline: round(t.main.yuan),
        reserveLeft: Math.max(0, L.egressReservePerDay - t.review),
        ...(p.days != null ? { daysOfBalance: Number.isFinite(p.days) ? Math.round(p.days * 10) / 10 : p.days } : {}),
        paused: p.paused,
      };
    },
    /**
     * LLM 端口每次真正发出去的调用之后报一次（只有数字）：成功的、失败的（超时、中止、报错）都报。
     * usage 是宿主报的用量（失败时多半没有，就只记一次失败）；estimated = 宿主没报用量、端口按字数估的。
     * @param {string} use
     * @param {{in?: number, cached?: number, out?: number, cacheWrite?: number}|null} usage
     * @param {{sourceKey?: string, failed?: boolean, estimated?: boolean}} [meta]
     */
    record(use, usage, { sourceKey, failed = false, estimated = false } = {}) {
      const t = today();
      const key = USE_KEY.test(String(use)) ? String(use) : 'other';
      const e = (t.byUse[key] = useEntry(t.byUse[key]));
      e.calls += 1;
      if (failed) { e.failed += 1; t.failed = n0(t.failed) + 1; }
      if (usage) {
        const u = usageNums(usage);
        const prices = hostConfig().budget?.prices;
        const yuan = priceOf(u, prices, now());
        if (estimated) e.estimated += 1;
        e.in += u.in; e.cached += u.cached; e.out += u.out; e.yuan += yuan;
        t.uncached += u.in;
        t.cached += u.cached;
        t.out += u.out;
        t.bgYuan += yuan;
        if (isPeak(prices, now())) t.bgPeakYuan = n0(t.bgPeakYuan) + yuan;
        if (sourceKey) t.bySource[sourceKey] = (t.bySource[sourceKey] ?? 0) + u.in;
      }
      touch();
    },
    /**
     * 账户上所有会话的用量（她的会话、主人写代码的会话、子代理……）：只用来估「余额还能撑几天」。
     * 别的提供方的会话（花的不是这份余额）不算。
     * @param {{in?: number, cached?: number, out?: number}} usage
     * @param {{provider?: string}} [meta]
     */
    recordAccountChat(usage, meta = {}) {
      let mine = null;
      try { mine = providerOf(); } catch { mine = null; }
      if (meta?.provider && mine && meta.provider !== mine) return;
      const t = today();
      t.acctYuan = (t.acctYuan || 0) + priceOf(usageNums(usage), hostConfig().budget?.prices, now());
      touch();
    },
    /** 她的会话里主聊天的用量（诊断区的基线，宽松档只用来观察，§10.6）。 */
    recordMainChat(usage) {
      const t = today();
      const u = usageNums(usage);
      t.main.in += u.in; t.main.cached += u.cached; t.main.out += u.out;
      t.main.yuan += priceOf(u, hostConfig().budget?.prices, now());
      touch();
    },
    /** 宿主报了 QUOTA（余额用完，H5）。 */
    notifyQuota() { if (!quotaHitAt) { quotaHitAt = now(); log.warn('budget.quota', {}); } },
    /** 余额来源（配置在私有 kit 里：一个 JSON 文件和字段路径）。读到大于 0 的余额就清掉 QUOTA 标记（充值后自动恢复）。 */
    refreshBalance() {
      const b = hostConfig().budget?.balance ?? {};
      if (!b.file) { balance = { value: null, at: now(), error: null }; return balance; }
      if (balance.at && now() - balance.at < (b.everyMs ?? 600_000)) return balance;
      try {
        const v = pick(JSON.parse(fsImpl.readFileSync(b.file, 'utf8').replace(/^﻿/, '')), b.path);
        balance = { value: Number.isFinite(v) ? v : null, at: now(), error: Number.isFinite(v) ? null : 'NO_FIELD' };
        if (Number.isFinite(v)) {
          readings = [...readings.filter((r) => now() - r.at < 48 * 3_600_000), { value: v, at: now() }].slice(-400);
        }
        if (Number.isFinite(v) && v > 0 && quotaHitAt) { quotaHitAt = 0; log.info('budget.resumed', {}); }
      } catch (e) { balance = { value: balance.value, at: now(), error: e?.code ?? 'READ_FAILED' }; }
      return balance;
    },
    /** 管理页总览（只有数字）。 */
    status() {
      const t = today();
      const L = limits();
      const p = protectState();
      const days = p.days == null ? null : Number.isFinite(p.days) ? Math.round(p.days * 10) / 10 : null;
      return {
        preset: L.preset,
        // 主人在预设之上单独改过的项（D121；键名，没有值）。上限是 Infinity = 不设
        custom: L.overridden.length > 0,
        overridden: [...L.overridden],
        limits: { dailyCalls: L.dailyCalls, dailyUncachedTokens: L.dailyUncachedTokens, dailyOutputTokens: L.dailyOutputTokens, perSourceShare: L.perSourceShare,
          mainChatRatioCap: L.mainChatRatioCap, balanceProtectDays: L.balanceProtectDays, egressReservePerDay: L.egressReservePerDay },
        // calls：放行的次数（失控上限按它算，不含外发审视）；byUse：真正发出去的调用（含外发审视），按用途分开
        today: { day: t.day, calls: t.calls, uncachedTokens: t.uncached, cachedTokens: t.cached, outputTokens: t.out, reviews: t.review, reservedCalls: t.reservedCalls,
          byUse: Object.fromEntries(Object.entries(t.byUse).map(([k, v]) => [k, roundUse(useEntry(v))])), failed: n0(t.failed),
          sources: Object.keys(t.bySource).length, bgYuan: round(t.bgYuan), bgPeakYuan: round(t.bgPeakYuan), mainYuan: round(t.main.yuan), acctYuan: round(t.acctYuan), denied: { ...t.denied } },
        main: { uncachedTokens: t.main.in, cachedTokens: t.main.cached, outputTokens: t.main.out },
        egressReserve: { used: t.review, total: L.egressReservePerDay },
        ratioToMain: t.main.yuan > 0 ? Math.round((t.bgYuan / t.main.yuan) * 1000) / 1000 : null,
        balance: { known: Number.isFinite(balance.value), daysLeft: days, unlimited: p.days === Infinity, protecting: p.paused, error: balance.error,
          dailySpend: round(dailySpend()), dropPerDay: round(balanceDrop()) },
        paused: p.paused, pausedReason: p.reason,
        history: history.map((h) => ({ ...h, ...(h.byUse ? { byUse: { ...h.byUse } } : {}) })),
        historyDays: HISTORY_DAYS,
        uses: BG_USES,
        // 元是按这份价目估的（元 / 百万 token；改在 ~/.dsh/persona-memory.json 的 host.budget.prices）
        prices: pricesView(hostConfig().budget?.prices),
      };
    },
    flush,
    dispose() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } flush(); },
  };
}

const round = (x) => Math.round((Number(x) || 0) * 10000) / 10000;
function pricesView(p) {
  if (!p || typeof p !== 'object') return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
  return { hit: num(p.hit), miss: num(p.miss), out: num(p.out), peakFactor: num(p.peakFactor) ?? 1,
    peakHours: Array.isArray(p.peakHours) ? p.peakHours.filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [num(a), num(b)]) : [] };
}
