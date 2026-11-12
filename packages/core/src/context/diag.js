// 回想的稳定性和可观测性（D117，实测问题 #28）：回想的每一步都单独兜住，出错只丢那一步，其余照给；出了什么错都留得下、看得见。
//   - 计数（metrics，按 UTC 日）：context.recall.fault（每一处出错记一次）、.fault.<步骤>、.fault.<步骤>.<错误类型>；
//     （不沿用旧名 context.recall.error：D117 之前它是「整轮丢了一次」、没有任何明细，同一天里两种口径加在一起就又是一个说不清的数——
//     旧名只读不写，诊断里单独显示成「升级前（没有明细）」）；
//     context.recall.partial（这一轮有一步出错、其余照给了）、context.recall.lost（这一轮因为出错什么都没给出来）；
//     context.recall.count、context.recall.ms.<档>（前台回想的耗时分布，调等待时长用）；context.recall.aborted（宿主取消了的一轮：不算次数，
//     取消之后的出错不记）、context.recall.skipped（这个场合不注入 / 找不到）；宿主报的 host.recall.<结果>（等超时、出错、退回缓存）。
//   - 最近的出错（meta 'context.recallErrors'，最多 context.errorLogMax 条，重启也在）：只有时刻、步骤、错误类型、代码位置（文件:行号）、
//     触发、降级级别——没有任何内容（§12.3）。管理页的诊断、启动自检读它（recallHealth）。
// 原来（D117 之前）整个回想只有一个 try：任何一步抛错，这一轮连已经算好的工作记忆都丢掉，只记一个 context.recall.error，
// 错误类型只进了不落盘的控制台——11-06 的 37 次就是这样查不出来的（实测问题 #28）。
export const FAULT = 'context.recall.fault';
/** D117 之前的旧计数（每次整轮丢掉记一次，没有明细）：只读。 */
export const LEGACY_ERROR = 'context.recall.error';
import { bumpMetric, readMetrics, getMetaJson, setMetaJson, utcDay } from '../store/index.js';
import { budgetState, loadSession } from './ledger.js';

const RING_KEY = 'context.recallErrors';
// 宿主报来的等超时 / 报错另记一份（同样的上限）：冷加载时一阵超时不会把核心各步的出错（步骤、代码位置）挤出去（D117 评审）
const HOST_RING_KEY = 'context.hostRecallErrors';
// 前台回想耗时的分档（毫秒，上界）：和等待时长的几个默认值对得上（不自主 1500、有意 4000、宿主等 4300）
export const MS_BUCKETS = [300, 800, 1500, 3000, 4500, 8000];
const DAY_MS = 86_400_000;

/** 错误类型（只认 code / name，截短、只留字母数字下划线，可以安全地放进计数名）。 */
export function errCodeOf(e) {
  const raw = String(e?.code ?? e?.name ?? 'Error');
  const s = raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  return s || 'Error';
}

/** 抛错的代码位置：栈里第一帧在本插件源码里的「目录/文件:行号」（只有代码位置，没有内容）。 */
export function frameOf(e) {
  const stack = typeof e?.stack === 'string' ? e.stack : '';
  for (const line of stack.split('\n').slice(1, 12)) {
    const m = line.match(/packages[\\/](core|dsh)[\\/]src[\\/]([\w./\\-]+?\.js):(\d+)(?::\d+)?/);
    if (m) return `${m[1] === 'dsh' ? 'dsh/' : ''}${m[2].replace(/\\/g, '/')}:${m[3]}`.slice(0, 80);
  }
  return null;
}

const msBucket = (ms) => {
  for (const b of MS_BUCKETS) if (ms <= b) return `le${b}`;
  return `gt${MS_BUCKETS.at(-1)}`;
};

function bump(core, name, by = 1) {
  try { if (!core.readOnly && core.store && !core.store.closed) bumpMetric(core.store, name, by); } catch { /* 只是计数 */ }
}

/** 往「最近的出错」里加一条（只有代码事实）。 */
function pushRing(core, entry, key = RING_KEY) {
  if (core.readOnly || !core.store || core.store.closed) return;
  try {
    const max = Math.max(1, Math.floor(core.config.get().context?.errorLogMax ?? 50));
    const list = getMetaJson(core.store, key, []);
    const arr = Array.isArray(list) ? list : [];
    arr.push(entry);
    setMetaJson(core.store, key, arr.slice(-max));
  } catch { /* 记不下就算了，计数还在 */ }
}

/**
 * 一次回想的记录器：每一步出错调 fault(步骤, e)，结束时 done(结果)。后台的（预取时替这一轮先判的）照样记出错，不记耗时和轮数。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{trigger?: string, background?: boolean}} info
 */
export function recallDiag(core, { trigger = null, background = false, signal = null } = {}) {
  const t0 = performance.now();
  const faults = [];
  let level = null;
  let aborted = false;
  const d = {
    faults,
    /** 这一步出错了：记下来，调用方自己用退路接着算。 */
    fault(stage0, e, extra = {}) {
      // 宿主已经取消了这一轮：之后各步的出错（多半就是取消本身）不算出错
      if (signal?.aborted) { aborted = true; return; }
      const stage = String(stage0).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24) || 'unknown';
      const code = errCodeOf(e);
      const frame = frameOf(e);
      faults.push({ stage, code });
      try { core.log.warn('context.recall.fault', { stage, error: code, ...(frame ? { frame } : {}), ...(extra.layer ? { layer: extra.layer } : {}) }); } catch { /* 日志失败不影响 */ }
      bump(core, FAULT);
      bump(core, `${FAULT}.${stage}`);
      bump(core, `${FAULT}.${stage}.${code}`);
      pushRing(core, { at: core.now(), stage, code, frame, trigger: trigger ? String(trigger).slice(0, 16) : null, level,
        ...(extra.layer ? { layer: String(extra.layer).slice(0, 20) } : {}), ...(background ? { bg: true } : {}) });
    },
    setLevel(l) { if (Number.isInteger(l)) level = l; },
    /** 结束：items 给出来几条；lost = 因为出错整轮什么都没给。 */
    done({ items = 0, lost = false } = {}) {
      if (background) return items;   // 后台的（预取时替这一轮先判的）只记出错，不算轮数
      if (aborted || signal?.aborted) { bump(core, 'context.recall.aborted'); return items; }
      bump(core, 'context.recall.count');
      bump(core, `context.recall.ms.${msBucket(performance.now() - t0)}`);
      if (lost) bump(core, 'context.recall.lost');
      else if (faults.length) bump(core, 'context.recall.partial');
      if (lost && !faults.length) bump(core, `${FAULT}.unknown`);
      return items;
    },
    /** 这个场合不注入（档位 off）、找不到：不算一次回想。 */
    skip() { if (!background) bump(core, 'context.recall.skipped'); },
  };
  return d;
}

/**
 * 宿主报来的这一轮等回想的结果（D117）：等到了 / 等超时 / 回想报错（宿主那边拿到的 rejected）/ 被取消，等了多久、退回缓存后给了几条。
 * 只有数字和错误类型。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string|null} sessionId
 * @param {{outcome: string, code?: string, waitedMs?: number, trigger?: string, served?: number}} o
 */
export function noteHostRecall(core, sessionId, o) {
  if (core.readOnly) return;
  const outcome = ['ok', 'timeout', 'error', 'aborted'].includes(o?.outcome) ? o.outcome : 'other';
  bump(core, `host.recall.${outcome}`);
  if (Number.isFinite(o?.waitedMs) && o.waitedMs >= 0) bump(core, `host.recall.wait.${msBucket(o.waitedMs)}`);
  if (outcome === 'timeout' || outcome === 'error') {
    const code = outcome === 'error' ? errCodeOf({ code: o?.code }) : 'Timeout';
    if (outcome === 'error') bump(core, `host.recall.error.${code}`);
    const served = Number.isInteger(o?.served) && o.served > 0 ? o.served : 0;
    if (served) bump(core, 'host.recall.cachedServed');
    pushRing(core, { at: core.now(), stage: `host.${outcome}`, code, frame: null, trigger: o?.trigger ? String(o.trigger).slice(0, 16) : null, level: null,
      waitedMs: Number.isFinite(o?.waitedMs) ? Math.round(o.waitedMs) : null, served }, HOST_RING_KEY);
  }
}

/**
 * 回想的健康（管理页的诊断、启动自检）：今天和昨天（UTC 日）的计数、按步骤 / 错误类型的分布、耗时分布、宿主等待的结果，
 * 加最近的出错（新的在前）。只有数字和代码事实。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{days?: number, recent?: number}} [opt]
 */
export function recallHealth(core, opt = {}) {
  const days = Math.max(1, Math.min(7, Math.floor(opt.days ?? 2)));
  const now = core.now();
  const out = { days: [], recent: [], buckets: MS_BUCKETS.map((b) => `le${b}`).concat(`gt${MS_BUCKETS.at(-1)}`) };
  for (let i = 0; i < days; i++) {
    const day = utcDay(now - i * DAY_MS);
    let rows = [];
    try { rows = readMetrics(core.store, { day }); } catch { rows = []; }
    const m = new Map(rows.map((r) => [r.name, Number(r.value) || 0]));
    const pick = (prefix) => Object.fromEntries([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    const byStage = {};
    const byCode = {};
    // 步骤名里没有点（working-select、render），所以「步骤」和「步骤.错误类型」分得开
    for (const [k, v] of Object.entries(pick(`${FAULT}.`))) (k.includes('.') ? byCode : byStage)[k] = v;
    out.days.push({
      day,
      recalls: m.get('context.recall.count') ?? 0,
      errors: m.get(FAULT) ?? 0,
      // 升级前（D117 之前）的旧计数：没有步骤、错误类型、代码位置，单独列出来，不混进 errors
      legacyErrors: m.get(LEGACY_ERROR) ?? 0,
      aborted: m.get('context.recall.aborted') ?? 0,
      skipped: m.get('context.recall.skipped') ?? 0,
      partial: m.get('context.recall.partial') ?? 0,
      lost: m.get('context.recall.lost') ?? 0,
      byStage: Object.fromEntries(Object.entries(byStage).filter(([, v]) => v > 0)),
      byCode,
      ms: pick('context.recall.ms.'),
      host: {
        ok: m.get('host.recall.ok') ?? 0, timeout: m.get('host.recall.timeout') ?? 0, error: m.get('host.recall.error') ?? 0,
        aborted: m.get('host.recall.aborted') ?? 0, cachedServed: m.get('host.recall.cachedServed') ?? 0, wait: pick('host.recall.wait.'),
      },
      embed: {
        query: m.get('embed.query') ?? 0, failed: m.get('embed.query.failed') ?? 0, timeout: m.get('embed.query.timeout') ?? 0,
        late: m.get('embed.query.late') ?? 0, retry: m.get('embed.query.retry') ?? 0, retryOk: m.get('embed.query.retryOk') ?? 0,
      },
      // 注入预算（D133）：前台回想超了每天 / 滚动窗口额度的轮数、因为预算没放进去的条数
      inject: {
        overDay: m.get('context.pack.over.day') ?? 0, overRolling: m.get('context.pack.over.rolling') ?? 0,
        budgetDropped: m.get('context.pack.budgetDropped') ?? 0,
        // 指回去（D146）：给了几行；同一条本周期指回的次数到了上限、没再指的条数
        pointBack: m.get('context.pointBack') ?? 0, pointBackCapped: m.get('context.pointBack.capped') ?? 0,
        // 这之后他的事（D164）：给出了至少一条的轮数、一共给了几条
        sinceHereTurns: m.get('context.sinceHere.turns') ?? 0, sinceHereItems: m.get('context.sinceHere.items') ?? 0,
      },
    });
  }
  out.injectBudget = injectBudgetOf(core, now, opt.sessions);
  try {
    const n = Math.max(1, Math.min(50, Math.floor(opt.recent ?? 20)));
    const read = (k) => { const l = getMetaJson(core.store, k, []); return Array.isArray(l) ? l : []; };
    // 两份按时刻合在一起，新的在前（同一时刻核心的在前）
    const all = [...read(RING_KEY).map((e, i) => ({ e, i, h: 0 })), ...read(HOST_RING_KEY).map((e, i) => ({ e, i, h: 1 }))];
    all.sort((a, b) => (Number(b.e?.at) || 0) - (Number(a.e?.at) || 0) || a.h - b.h || b.i - a.i);
    out.recent = all.slice(0, n).map((x) => x.e);
  } catch { out.recent = []; }
  return out;
}

/**
 * 各活跃会话的注入预算（D133，诊断用）：最近一天动过的、还在用的会话（最新的在前，最多 limit 个），今天已用 / 上限、
 * 滚动窗口已用 / 上限（不限、窗口还没满时上限是 null）。会话只给 id 的前 8 位和适配器，没有场合、没有内容。
 */
function injectBudgetOf(core, now, limit = 8) {
  const n = Math.max(0, Math.min(20, Math.floor(Number.isFinite(limit) ? limit : 8)));
  if (!n) return [];
  try {
    const rows = core.store.all(`SELECT session_id FROM sessions WHERE status = 'active' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`, now - DAY_MS, n);
    const fin = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    return rows.map((r) => {
      const s = loadSession(core, r.session_id);
      const b = budgetState(core, s, now);
      const steps = Array.isArray(s?.window?.steps) ? s.window.steps.length : 0;
      return { session: String(r.session_id).slice(0, 8), adapter: s?.adapter ?? null, dayUsed: fin(b.dayUsed), dayLimit: fin(b.dayLimit),
        rollingUsed: fin(b.rollingUsed), rollingLimit: fin(b.rollingLimit), steps };
    });
  } catch { return []; }
}
