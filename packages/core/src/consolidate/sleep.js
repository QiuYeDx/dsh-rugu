// 夜间整理（§7.7 的 10 步；D124 起加第 11 步「回顾做事的经验」，放在最后）。每天 04:30（本地时间，sleep.at）之后跑一次；距上次超过 catchUpH 小时就补跑。
//   - 开始前先让 backup 做日包（backup.runScheduled，第 0 步）；每一步自己 try/catch，失败只跳过这一步，记进报告。
//   - LLM 调用（D138）：每一步一晚最多调几次登记在 stepCalls 里（以各步自己的参数为准）；总上限 sleep.maxLlmCalls 默认 null =
//     各步之和，写成数字就按它封顶。「她自己」（日记、成长）和经验回顾的名额先留出来（RESERVED），前面的步骤用不到——以前
//     前面各步的上限加起来正好等于总上限，越活跃的晚上越轮不到日记。第 1 步的复核也算在内，调用之前先占额度；提炼批次是
//     use='extract'，不算。到了上限的步顺延到下一晚：它们的水位线、上次时间都没推进，下一晚自然接着做；哪一步因为上限少做了
//     记在报告的 capped 里，也有计数（consolidate.sleep.llmCap.<步名>）。预算不允许的那一步整步跳过（§10.6）。
//   - 「节省」预设（sleepDepth='essential'）只做必要项：封口和复核、重放、印象、时间维护、故事线、向量和运维；
//     泛化、反思、社区、日记和自我概念留到宽松的时候。
//   - 第 1 步把原文窗口（intake.flushWindows force）和切分缓冲（encode.segment force）都封口。
//   - 第 2 步先对照原话纠错（correct.js，D122：一晚最多 sleep.correct.maxCalls 次 LLM，算在上限里），再重放。
//   - 第 9 步的嵌入队列按夜里的方式跑（worker.runEmbedQueue night=true：白天推后的积压、失败一天的行），一轮接一轮做到
//     活动空间的队列空了（推到夜里的必须夜里做完，§7.6）；分层（dynamics.retier）一晚做完一整轮，做完让 worker 按新的
//     tier 重建内存索引（worker.reloadIndex，§6.8）。
//   - 第 10 步的维护全在 worker 里（FTS 小步合并、增量 vacuum）；完整性检查由 backup 在刚做好的包上做（verifyPack 在 worker 里
//     解开副本跑 integrity_check），不碰正在用的库。
//   - 跑完给所有场合的常驻区标脏（context.markResidentDirty，§10.4），新文本等下一条真实消息再换上。
//   - 同一时间只跑一个（state.consolidate.running）；dispose 时中止；整体恢复进行中不开始（§12.4.5）。
import { getMeta, setMeta, setMetaJson, claimNextJob, failJob, enqueueJob, refOf, parseRef } from '../store/index.js';
import { params } from './params.js';
import {
  DAY, HOUR, MIN, errCode, localDay, localDayStart, metric, newRun, parseClock, safeJson, unit, warn, info, restoring, yieldLoop, residentDirty,
} from './util.js';
import { selfId, suppressedSet } from './memory.js';
import { timeMaintenanceImpl, followUpUnknownPlans } from './time.js';
import { generalizeStep } from './generalize.js';
import { reflectStep } from './reflect.js';
import { impressionsBatch, entitiesNeedingImpressions, maybeSamePairs } from './impressions.js';
import { storylineBatch, settingsNeedingStoryline } from './storyline.js';
import { rebuildCommunities } from './communities.js';
import { selfStep } from './self.js';
import { correctStep } from './correct.js';
import { lessonsStep } from './lessons.js';

const numMeta = (core, key) => {
  const v = getMeta(core.store, key);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 最近一次（不晚于 at 的）本地 sleep.at 时刻。 */
function lastBoundary(core, at, clock) {
  const t = localDayStart(core, at) + parseClock(clock) * MIN;
  return t <= at ? t : t - DAY;
}

export function shouldSleepImpl(core, at) {
  if (core.readOnly || core.state.consolidate?.running || restoring(core)) return false;
  const p = params(core);
  const last = numMeta(core, 'sleep.lastAt');
  const attempt = numMeta(core, 'sleep.attemptAt');
  // 上次开始了但没跑完（进程中途退出）：隔一会儿再试，免得每分钟一次地重跑
  if (attempt != null && (last == null || attempt > last) && at - attempt < p.retryMin * MIN) return false;
  if (last == null) return true;
  if (last < lastBoundary(core, at, p.at)) return true;
  return at - last >= p.catchUpH * HOUR;
}

/** 必要项（节省预设下也做）。第 2 步的对照原话纠错也算（D122 评审：记错的认知每一轮都被注入，一晚最多 2 次、几分钱，见 docs/花费.md）。
 * 第 11 步（D124）节省档只做纯代码的那一半（定哪些经验放进常驻区），不调模型。 */
const ESSENTIAL = new Set([0, 1, 2, 5, 6, 7, 9, 10, 11]);

// ── 第 1 步：封口、补跑失败批次、复核 ─────────────────────────────────────────
const RETRY_TAG = '#sleep-retry-';

/** 最近几天失败了的提炼批次：它们的感知还都在缓冲里、也没有别的任务在处理同一段，就重排一次（最多 retryMax 次）。
 * 搁置着的段（D136，encode 记的）不在这里补：它们有自己的退避。 */
function retryFailedExtracts(core, at, p) {
  let n = 0;
  const rows = core.store.all("SELECT * FROM jobs WHERE kind = 'extract' AND status = 'failed' AND updated_at >= ? ORDER BY id LIMIT 200", at - p.extract.retryFailedDays * DAY);
  for (const j of rows) {
    const key = j.dedupe_key ?? `job${j.id}`;
    const i = key.lastIndexOf(RETRY_TAG);
    const base = i >= 0 ? key.slice(0, i) : key;
    const tries = i >= 0 ? Number(key.slice(i + RETRY_TAG.length)) || 0 : 0;
    if (tries >= p.extract.retryMax) continue;
    if (j.scope_key && Number.isInteger(j.ep_from) && Number.isInteger(j.ep_to)) {
      const assigned = core.store.get('SELECT COUNT(*) AS n FROM percepts WHERE setting_key = ? AND id BETWEEN ? AND ? AND episode_id IS NOT NULL', j.scope_key, j.ep_from, j.ep_to).n;
      if (assigned > 0) continue;
      const busy = core.store.get(`SELECT 1 AS ok FROM jobs WHERE kind = 'extract' AND status IN ('queued','running') AND scope_key = ?
          AND ep_from <= ? AND ep_to >= ? LIMIT 1`, j.scope_key, j.ep_to, j.ep_from);
      if (busy) continue;
      // 搁置着的段（D136）由 encode 按退避重试（切段时到点就排），这里不另外补跑：每晚补一次等于绕过退避
      const stalled = core.store.get('SELECT 1 AS ok FROM extract_stalled WHERE setting_key = ? AND ep_from <= ? AND ep_to >= ? LIMIT 1', j.scope_key, j.ep_to, j.ep_from);
      if (stalled) continue;
    }
    const r = enqueueJob(core.store, {
      kind: 'extract', use: j.use ?? 'extract', priority: j.priority, dedupeKey: `${base}${RETRY_TAG}${tries + 1}`,
      scopeKey: j.scope_key, epFrom: j.ep_from, epTo: j.ep_to, payload: safeJson(j.payload_json, {}),
    });
    if (r.created) n += 1;
  }
  return n;
}

/** 把排着的提炼任务跑掉一部分（今天的经历先变成事实，后面的步才有东西整理）。 */
async function runExtractJobs(core, p, signal) {
  const handler = core.jobHandlers.get('extract');
  if (!handler) return 0;
  const t0 = performance.now();
  let ran = 0;
  while (ran < p.extract.maxJobs && performance.now() - t0 < p.extract.maxMs && !signal?.aborted) {
    const job = claimNextJob(core.store, { kinds: ['extract'] });
    if (!job) break;
    try { await handler(core, job, { signal }); } catch (e) {
      failJob(core.store, job.id, { errorCode: errCode(e), retry: e?.code !== 'NOT_IMPLEMENTED' });
      warn(core, 'sleep.extract', { id: job.id, error: errCode(e) });
    }
    ran += 1;
  }
  return ran;
}

/** encode.reviewFlagged 的契约：一批复核用一次 LLM（use='sleep'）。 */
const REVIEW_CALLS = 1;

/**
 * 每一步一晚最多调几次模型（D138）。以各步自己的参数和写法为准：
 * 复核 1；纠错 correct.maxCalls；泛化 generalize.maxCalls；反思 2（先问问题、再写洞见）；印象 2（公开的一层、私下的一层）；
 * 回头问问 1；故事线 1 + 社区 1；她自己 1（日记和自我概念一次调用）；经验回顾 lessons.maxCalls。
 * 节省档（essential）不做的部分记 0。新加要调模型的步，先在这里登记，否则它一次也调不到（编排按这张表给每一步封顶）。
 * @returns {Map<number, number>}
 */
export function stepCalls(p) {
  const full = (n) => (p.depth === 'essential' ? 0 : Math.max(0, Number(n) || 0));
  return new Map([
    [1, REVIEW_CALLS],
    [2, Math.max(0, Number(p.correct?.maxCalls) || 0)],
    [3, full(p.generalize.maxCalls)],
    [4, full(2)],
    [5, 2],
    [6, full(1)],
    [7, 1 + full(1)],
    [8, full(1)],
    [11, full(p.lessons.maxCalls)],
  ]);
}
/** 前面的步骤无论怎么用都要轮得到的步：她自己（日记、心境、成长块）、经验回顾。名额按这个顺序先留出来。 */
const RESERVED = [8, 11];

/**
 * 一晚的调用计划：total = 总上限（sleep.maxLlmCalls，null = 各步之和）；reserve = 给 RESERVED 留的名额
 * （总上限比它们的和还小时，排在前面的先拿）。
 * @returns {{total: number, sum: number, steps: Map<number, number>, reserve: Map<number, number>}}
 */
export function sleepCallPlan(p) {
  const steps = stepCalls(p);
  const sum = [...steps.values()].reduce((a, n) => a + n, 0);
  const total = Number.isFinite(p.maxLlmCalls) ? Math.max(0, Math.floor(p.maxLlmCalls)) : sum;
  const reserve = new Map();
  let left = total;
  for (const n of RESERVED) {
    const k = Math.min(steps.get(n) ?? 0, left);
    reserve.set(n, k);
    left -= k;
  }
  return { total, sum, steps, reserve };
}

/** 第 n 步这次能用到第几次（run.max）：不超过它自己登记的次数，也不动后面保留的名额。 */
function stepLimit(plan, n, calls) {
  let later = 0;
  for (const [m, k] of plan.reserve) if (m > n) later += k;
  return Math.max(calls, Math.min(calls + (plan.steps.get(n) ?? 0), plan.total - later));
}

/** 一步的结果里有没有「到上限了」（整步跳过，或者里面某一段，比如复核、纠错、回头问问、社区）。 */
function hitCap(v, depth = 0) {
  if (v === 'llm-cap') return true;
  if (!v || typeof v !== 'object' || depth > 3) return false;
  return Object.values(v).some((x) => hitCap(x, depth + 1));
}

async function stepSeal(core, ctx) {
  const { p, at, signal, run } = ctx;
  const detail = {};
  const errors = [];
  const part = async (name, fn) => { try { detail[name] = await fn(); } catch (e) { errors.push(`${name}:${errCode(e)}`); } };
  // 原文窗口不等空闲 2 分钟，有几条切几条（第 9 步要嵌它们）；切分缓冲同样全部封口
  await part('windows', () => core.mods.intake.flushWindows(core, { at, force: true })?.windows ?? 0);
  await part('retried', () => retryFailedExtracts(core, at, p));
  await part('ranBefore', () => runExtractJobs(core, p, signal));
  await part('sealed', () => core.mods.encode.segment(core, { force: true, at })?.jobs ?? 0);
  await part('ran', () => runExtractJobs(core, p, signal));
  if (run.max - run.calls >= REVIEW_CALLS) {
    // 先把复核的额度占上，免得它在上限边上多调；做完按实际的多退少补（没东西可复核时退回去）。出错按占了算
    run.calls += REVIEW_CALLS;
    await part('review', async () => {
      let used = REVIEW_CALLS;
      try {
        const r = await core.mods.encode.reviewFlagged(core, { limit: p.extract.reviewLimit, signal });
        used = Math.max(0, Number(r?.llmCalls) || 0);
        return r?.reviewed ?? 0;
      } finally { run.calls += used - REVIEW_CALLS; }
    });
  } else detail.review = 'llm-cap';
  return { detail, errors };
}

// ── 第 2 步：分诊和重放 ─────────────────────────────────────────────────────
/** recurrence 的下一次（宽进：{next} 或 {freq|every|period: year/month/week/day, anchor|at}）。 */
export function nextRecurrence(rec, anchor, at) {
  if (!rec || typeof rec !== 'object') return null;
  if (Number.isFinite(rec.next)) return rec.next;
  const unitName = String(rec.freq ?? rec.every ?? rec.period ?? '').toLowerCase();
  const base = Number.isFinite(rec.anchor) ? rec.anchor : Number.isFinite(rec.at) ? rec.at : anchor;
  if (!Number.isFinite(base)) return null;
  const d = new Date(base);
  const step = (k) => {
    const x = new Date(d);
    if (/^y/.test(unitName)) x.setUTCFullYear(d.getUTCFullYear() + k);
    else if (/^mo/.test(unitName)) x.setUTCMonth(d.getUTCMonth() + k);
    else if (/^w/.test(unitName)) x.setUTCDate(d.getUTCDate() + 7 * k);
    else if (/^d/.test(unitName)) x.setUTCDate(d.getUTCDate() + k);
    else return null;
    return x.getTime();
  };
  for (let k = 0; k < 400; k++) { const t = step(k); if (t == null) return null; if (t >= at) return t; }
  return null;
}

/**
 * 重放（§7.7 第 2 步，认知:617-620）：优先级 = 将来用得上（挂着的意图或计划、recurrence 临近、涉及最近常出现的实体、
 * 有未解决的矛盾或 maybe_same）+ 显著性 + 情绪强度 + 意外程度。选中的加一条重放痕迹（30 天内、每条 ≤ 3 次由 dynamics 执行），其余照常衰减。
 */
export function replayStep(core, ctx) {
  const { p, at } = ctx;
  const since = at - p.replay.withinDays * DAY;
  const hot = new Set(core.store.all('SELECT id FROM entities WHERE is_self = 0 AND last_mention_at >= ? ORDER BY mention_days DESC, last_mention_at DESC LIMIT ?',
    at - p.replay.hotWindowDays * DAY, p.replay.hotEntities).map((r) => r.id));
  const maybe = new Set(core.store.all("SELECT a, b FROM entity_links WHERE rel = 'maybe_same'").flatMap((r) => [r.a, r.b]));
  const openAbout = new Set(core.store.all("SELECT about_kind, about_id FROM intentions WHERE state IN ('formed','armed') AND about_id IS NOT NULL")
    .map((r) => `${r.about_kind}:${r.about_id}`));
  const cands = [];
  for (const a of core.store.all(`SELECT id, imp, recorded_at, plan_status, recurrence, supersedes, change_known, needs_reconcile, event_start, valid_from
      FROM assertions WHERE recorded_at >= ? AND superseded_by IS NULL`, since)) {
    const ents = core.store.all('SELECT entity_id FROM assertion_entities WHERE assertion_id = ?', a.id).map((r) => r.entity_id);
    let future = 0;
    if (openAbout.has(`assertion:${a.id}`)) future += 1;
    if (a.plan_status && ['planned', 'in_progress', 'unknown'].includes(a.plan_status)) future += 1;
    const next = nextRecurrence(safeJson(a.recurrence, null), a.event_start ?? a.valid_from ?? a.recorded_at, at);
    if (next != null && next - at <= p.replay.recurrenceSoonDays * DAY) future += 1;
    if (ents.some((e) => hot.has(e))) future += 0.5;
    if (a.needs_reconcile || ents.some((e) => maybe.has(e))) future += 0.5;
    const surprise = a.supersedes || a.change_known || a.plan_status === 'cancelled' || a.plan_status === 'missed' ? 1 : 0;
    cands.push({ ref: refOf('assertion', a.id), score: future + (Number(a.imp) - 1) / 9 + surprise });
  }
  for (const e of core.store.all(`SELECT id, emotion_json, participants_json FROM episodes WHERE t_end >= ? AND ep_kind IN ('event','diary')`, since)) {
    const parts = safeJson(e.participants_json, []);
    const emo = unit(safeJson(e.emotion_json, {})?.intensity, 0);
    const future = parts.some((x) => hot.has(x)) ? 0.5 : 0;
    cands.push({ ref: refOf('episode', e.id), score: future + emo + 0.3 });
  }
  const hidden = suppressedSet(core, cands.map((c) => c.ref));
  const picked = cands.filter((c) => !hidden.has(c.ref)).sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : 1)).slice(0, p.replay.maxItems);
  let added = 0;
  const day = localDay(core, at);
  const errors = [];
  core.store.tx(() => {
    for (const c of picked) {
      try {
        // 每条一个 SAVEPOINT：一条出错只回滚它自己
        const r = core.store.tx(() => core.mods.dynamics.addTrace(core, parseRef(c.ref), { t: at, w: p.replay.w, sourceKey: `sleep-replay:${day}`, reason: 'replay' }));
        if (r?.added) added += 1;
      } catch (e) { if (errors.length < 3) errors.push(`trace:${errCode(e)}`); }
    }
  });
  return { detail: { candidates: cands.length, picked: picked.length, added }, errors };
}

// ── 第 9、10 步 ──────────────────────────────────────────────────────────
/** 活动空间的队列里还有没有要嵌的（worker.health 的 pending + stale）。读不了按「没有了」：最多少嵌一点，下一晚接着做。 */
function queueLeft(core) {
  try {
    const q = core.mods.worker.health(core)?.queue ?? {};
    return (Number(q.pending) || 0) + (Number(q.stale) || 0) > 0;
  } catch { return false; }
}

/**
 * 夜里的嵌入（§7.6、§7.7 第 9 步）：白天推到夜里的积压（CPU 上超过 embedding.backlogDeferH 小时的工作量）、失败了一天的行，
 * 都在这时做。一轮最多 sleep.maintenance.embedBatches 批，一轮接一轮做到活动空间的队列空了为止：推到夜里的必须夜里做完，
 * 否则积压一旦过了门槛，白天一直往后推、夜里每晚只消化一轮，永远追不上。查询照样插队（worker 让路），关库、换库时经 signal 中止。
 * 一轮什么都没嵌成（熔断、没有活动空间、剩下的都在失败）就停，失败的行留给下一晚。
 */
async function nightEmbed(core, p, signal) {
  const out = { embedded: 0, failed: 0, rounds: 0 };
  while (!signal?.aborted) {
    const r = await core.mods.worker.runEmbedQueue(core, { night: true, maxBatches: p.maintenance.embedBatches, signal });
    out.rounds += 1;
    const n = Number(r?.embedded) || 0;
    out.embedded += n;
    out.failed += Number(r?.failed) || 0;
    if (r?.breaker) out.breaker = true;
    if (n <= 0 || r?.breaker || r?.busy || !queueLeft(core)) break;
    await yieldLoop();   // 轮与轮之间让聊天路径（和 tick 的一轮）插进来
  }
  return out;
}

/**
 * 分层（§6.8）：按 dynamics 自己的批大小（activation.retierBatch）一批一批做，一晚做完一整轮（每批一个同步事务，批与批之间
 * 让出事件循环），做完让 worker 按新的 tier 重建内存索引。批数上限按表的大小算（每批至少推进一批行），再加
 * sleep.maintenance.retierRounds 批余量（做的过程中新写进来的行）；游标万一不前进也不会一直转，没做完的下一晚接着做。
 */
async function retierAll(core, p, at, signal) {
  let rows = 0;
  try { rows = Number(core.store.get('SELECT count(*) AS n FROM activation')?.n) || 0; } catch { rows = 0; }
  const maxRounds = Math.ceil(rows / Math.max(1, p.retierBatch)) + Math.max(1, p.maintenance.retierRounds);
  let updated = 0;
  let done = false;
  let rounds = 0;
  while (rounds < maxRounds && !signal?.aborted) {
    if (rounds > 0) await yieldLoop();
    const r = core.mods.dynamics.retier(core, { at });
    rounds += 1;
    updated += Number(r?.updated) || 0;
    if (!r || r.done) { done = !!r?.done; break; }
  }
  return { updated, done, rounds };
}

async function stepVectors(core, ctx) {
  const { p, at, signal } = ctx;
  const detail = {};
  const errors = [];
  try { detail.embed = await nightEmbed(core, p, signal); } catch (e) { errors.push(`embed:${errCode(e)}`); }
  try {
    const shadows = core.store.all("SELECT space_id FROM vector_spaces WHERE status = 'shadow'");
    detail.shadow = [];
    for (const s of shadows) {
      if (signal?.aborted) break;
      detail.shadow.push((await core.mods.worker.shadowReembed(core, { spaceId: s.space_id, maxBatches: p.maintenance.shadowBatches, signal }))?.coverage ?? null);
    }
  } catch (e) { errors.push(`shadow:${errCode(e)}`); }
  let retiered = false;
  try {
    const r = await retierAll(core, p, at, signal);
    retiered = r.done;
    detail.retier = r.updated;
    detail.retierRounds = r.rounds;
    detail.retierDone = r.done;
  } catch (e) { errors.push(`retier:${errCode(e)}`); }
  // 分层一轮做完了：内存里放哪些（热温层常驻、冷层只记 id）按新的 tier 整体重建（§6.8）。没做完的游标留到下一晚，那时再重建
  if (retiered && !signal?.aborted) {
    try { core.mods.worker.reloadIndex(core); detail.reindexed = true; } catch (e) { errors.push(`reindex:${errCode(e)}`); }
  }
  return { detail, errors };
}

async function stepOps(core, ctx) {
  const { p, at, signal } = ctx;
  const detail = { integrity: 'by-backup-verify' };
  const errors = [];
  try {
    let merged = 0;
    for (let i = 0; i < p.maintenance.ftsMergeSteps && !signal?.aborted; i++) {
      const r = await core.mods.worker.maintenance(core, { kind: 'fts-merge' });
      if (!r?.ok) break;
      merged += 1;
    }
    detail.ftsMerge = merged;
  } catch (e) { errors.push(`fts:${errCode(e)}`); }
  try { detail.vacuum = !!(await core.mods.worker.maintenance(core, { kind: 'vacuum', pages: p.maintenance.vacuumPages }))?.ok; } catch (e) { errors.push(`vacuum:${errCode(e)}`); }
  try { detail.retention = await core.mods.admin.applyRetention(core, at); } catch (e) { errors.push(`retention:${errCode(e)}`); }
  return { detail, errors };
}

// ── 编排 ─────────────────────────────────────────────────────────────────
const short = (d) => {
  // 报告只留数字和状态（§13.3），不留内容
  if (d == null || typeof d !== 'object') return d;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v === 'number' || typeof v === 'boolean' || v == null) out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 40);
    else if (Array.isArray(v)) out[k] = v.length;
    else if (typeof v === 'object') out[k] = short(v);
  }
  return out;
};

async function runSleep(core, at, signal) {
  const p = params(core);
  const plan = sleepCallPlan(p);
  const run = newRun(plan.total);
  const report = { startedAt: at, finishedAt: at, steps: [], llmCalls: 0, llmMax: plan.total, capped: [] };
  setMeta(core.store, 'sleep.attemptAt', at);
  info(core, 'sleep.start', { maxLlmCalls: plan.total, depth: p.depth });
  const ctx = { p, at, signal, run };
  const push = (entry) => {
    if (hitCap(entry.skipped) || hitCap(entry.detail)) {
      // 因为上限少做了（整步或其中一段）：报告里看得到，计数按步累计
      entry.capped = true;
      report.capped.push(entry.name);
      metric(core, `sleep.llmCap.${entry.name}`);
    }
    report.steps.push(entry);
  };
  const step = async (n, name, fn, { llm = false } = {}) => {
    const before = run.calls;
    run.max = stepLimit(plan, n, run.calls);   // 这一步的额度：各步自己的次数，后面保留的名额不动
    const entry = { step: n, name, ok: true, llmCalls: 0 };
    if (signal?.aborted) { entry.ok = false; entry.skipped = 'aborted'; push(entry); return; }
    if (p.depth === 'essential' && !ESSENTIAL.has(n)) { entry.skipped = 'saving-preset'; push(entry); return; }
    if (llm && run.calls >= run.max) { entry.skipped = 'llm-cap'; push(entry); return; }
    try {
      const r = (await fn()) ?? {};
      if (r.skipped) entry.skipped = r.skipped;
      if (r.errors?.length) { entry.ok = false; entry.errors = r.errors.slice(0, 8); }
      if (r.detail) entry.detail = short(r.detail);
    } catch (e) {
      entry.ok = false;
      entry.skipped = `error:${errCode(e)}`;
      metric(core, `sleep.step${n}.error`);
      warn(core, 'sleep.step', { step: n, error: errCode(e) });
    }
    entry.llmCalls = run.calls - before;
    push(entry);
  };
  const wrap = (r) => {
    // 各步的结果：skipped 单独拿出来，其余当 detail
    if (!r || typeof r !== 'object') return {};
    const { skipped, errors, ...rest } = r;
    return { skipped, errors, detail: rest };
  };

  await step(0, 'backup', async () => ({ detail: { packs: (await core.mods.backup.runScheduled(core, { at, signal }))?.length ?? 0 } }));
  await step(1, 'seal-review', () => stepSeal(core, ctx));
  await step(2, 'replay', async () => {
    // 先对照原话纠错（D122；有 LLM 调用，额度和预算不够就只做重放），再重放：改正后的新版本继承了旧的激活，重放挑的是现在这一版
    let correct;
    try { correct = await correctStep(core, { run, signal, at }); } catch (e) { correct = { skipped: `error:${errCode(e)}` }; }
    const r = replayStep(core, ctx);
    return { detail: { ...r.detail, correct }, errors: r.errors };
  });
  await step(3, 'generalize', async () => wrap(await generalizeStep(core, { run, signal, at })), { llm: true });
  await step(4, 'reflect', async () => wrap(await reflectStep(core, { run, signal, at })), { llm: true });
  await step(5, 'entities', async () => {
    const ids = entitiesNeedingImpressions(core).slice(0, p.impressions.perCall);
    const pairs = maybeSamePairs(core, { limit: p.impressions.maybeSamePerCall, at });
    if (!ids.length && !pairs.length) return { skipped: 'nothing-new' };
    if (run.calls >= run.max) return { skipped: 'llm-cap' };
    return wrap(await impressionsBatch(core, ids, { run, signal, at, pairs }));
  });
  await step(6, 'time', async () => {
    const t = timeMaintenanceImpl(core, at);
    let follow = { skipped: 'saving-preset' };
    if (p.depth !== 'essential') {
      try { follow = await followUpUnknownPlans(core, { run, signal, at }); } catch (e) { follow = { skipped: `error:${errCode(e)}` }; }
    }
    return { detail: { ...t, followUps: follow.formed ?? 0, followUpSkipped: follow.skipped ?? null } };
  });
  await step(7, 'settings', async () => {
    const detail = {};
    const errors = [];
    try {
      const keys = settingsNeedingStoryline(core);
      const s = keys.length ? await storylineBatch(core, keys, { run, signal, at, learnRules: true }) : { updated: [], rules: 0, skipped: 'nothing-new' };
      detail.storylines = s.updated.length;
      detail.rules = s.rules;
      if (s.skipped) detail.storylineSkipped = s.skipped;
    } catch (e) { errors.push(`storyline:${errCode(e)}`); }
    if (p.depth !== 'essential') {
      try {
        const c = await rebuildCommunities(core, { run, signal, at });
        Object.assign(detail, { communitiesBuilt: c.built, communitiesKept: c.kept, communitiesRetired: c.retired, communitiesSkipped: c.skipped ?? null });
      } catch (e) { errors.push(`communities:${errCode(e)}`); }
    }
    return { detail, errors };
  });
  await step(8, 'self', async () => wrap(await selfStep(core, { run, signal, at })), { llm: true });
  await step(9, 'vectors', () => stepVectors(core, ctx));
  await step(10, 'ops', () => stepOps(core, ctx));
  // 第 11 步（D124）：回顾做事的经验（放进常驻区的是纯代码；回顾只在有新东西时调一次模型）。放在最后：前面各步的编号、报告的顺序不变
  await step(11, 'lessons', async () => wrap(await lessonsStep(core, { run, signal, at, essential: p.depth === 'essential' })));

  // 印象、日记、成长、故事线都可能变了：所有场合的常驻区标脏（§10.4，只标脏，不换文本）。中止的那次前面几步也可能写过
  residentDirty(core);
  run.max = plan.total;
  report.finishedAt = Math.max(at, core.now());
  report.llmCalls = run.calls;
  if (!signal?.aborted) {
    setMeta(core.store, 'sleep.lastAt', at);
    try { setMetaJson(core.store, 'sleep.lastReport', report); } catch { /* 报告存不下不影响 */ }
  }
  metric(core, 'sleep.runs');
  metric(core, 'sleep.llmCalls', run.calls);
  info(core, 'sleep.done', { llmCalls: run.calls, failed: report.steps.filter((s) => !s.ok).length });
  return report;
}

/**
 * sleep 的实现：同一时间只跑一个；第二次调用拿到同一个进行中的 Promise。
 * @returns {Promise<import('../contract/types.js').SleepReport>}
 */
export function sleepImpl(core, opt = {}) {
  const st = core.state.consolidate;
  if (st.running) return st.running;
  const at = Number.isFinite(opt.at) ? opt.at : core.now();
  if (core.readOnly || restoring(core)) return Promise.resolve({ startedAt: at, finishedAt: at, steps: [] });
  const ctrl = new AbortController();
  const signal = opt.signal ? AbortSignal.any([opt.signal, ctrl.signal]) : ctrl.signal;
  st.abort = ctrl;
  selfId(core);   // 先确保她自己的实体在（后面各步都要用）
  const promise = runSleep(core, at, signal).finally(() => { st.running = null; st.abort = null; });
  st.running = promise;
  return promise;
}
