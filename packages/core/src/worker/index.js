// worker 模块（§8.2、§8.7、§7.6、§7.7 第 9–10 步、§8.9、§12.8 向量清扫）：慢活都不在主线程上做（H1）。
//   - worker_threads 里用各自的只读连接（WAL 允许并发读）做：稠密扫描（二值粗排前 200 → int8 精排；热温层常驻内存，
//     冷层只在有意回想时查）、FTS 词法查询（≤ 12 个词）、局部推送式 PPR、维护（副本上的 quick_check / integrity_check、
//     FTS 小步合并、增量 vacuum）。向量冷加载也在 worker 里（10 万 × 1024 在主线程同步读要 547 ms）。
//     线程分工：search（向量索引，常驻）、db（词法、词频、图扩散、已存向量，常驻）、maint（一次一个运维任务，用完就退）。
//   - 主线程这边：嵌入队列（查询 > 原文窗口 > 新记忆单元 > 补嵌重嵌，有查询在等时不发文档批）、写向量库、
//     向 worker 发布新向量（按块追加：写完向量库提交之后把新行发过去）、嵌入熔断（连续 2 次失败 60 秒不调，之后放一次探测）。
//   - 没起线程（测试、startWorker:false）时同一份引擎（engine.js）在主线程里跑，结果一样；起线程失败（start 返回 ok:false）时
//     稠密路降到 L3，词法和图扩散改在主线程以更小的上限做。
//   - 向量库是纯缓存（D15）：主库 embed_texts 是真相源；清扫（sweepVectors）在启动和恢复备份后做。
//   - 向量空间（§8.9）：查询只和同一个空间的向量比，永远不混用；换档走影子空间，新写入两边都嵌，旧空间保留 14 天。
// 拥有的表：embed_texts、vector_spaces；向量库 persona-vectors.db 的全部表（store/vectors.js 的 schema）。
// 用到的端口：embedding、clock、logger。
// 契约细节：docs/实现/模块与接口.md §4.10。
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bumpMetric, sweepVectorCache, parseRef, refOf, OWNER_KINDS, OWNER_TABLES, normalizeToken, getMeta, setMeta } from '../store/index.js';
import { Engine, wrapDatabase } from './engine.js';
import { ThreadClient } from './client.js';
import { runTask } from './maint.js';
import { PROBE_SENTENCES } from './probes.js';
import { fitVector, encodeVector, blobToF32, dot } from './quant.js';
import { wallNow } from './vindex.js';

export { HOT_SHARDS, ALL_SHARDS } from './engine.js';

/**
 * 一个命中（稠密 / 词法 / 图扩散）。
 * @typedef {object} Hit
 * @property {string} ref     记忆引用
 * @property {number} score   越大越相关（词法路把 bm25 取反；稠密路是近似余弦；图扩散是 PPR 质量）
 * @property {number} [chunkNo]   稠密路：分最高的那个文本块
 * @property {'memory'|'raw'} [layer]  稠密路：来自哪一层
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LAYERS = new Set(['memory', 'raw']);

// ── 参数（每次用都从 config.get() 取，热加载）。数值都在 config/defaults.js（embedding、recall、worker 三段）──────────────
function params(core) {
  const cfg = core.config.get();
  const e = cfg.embedding;
  const r = cfg.recall;
  const w = cfg.worker;
  return {
    batch: e.batch,
    dims: e.dims,
    maxAttempts: e.maxAttempts,
    retryFailedAfterMs: e.retryFailedAfterH * HOUR,
    backlogDeferMs: e.backlogDeferH * HOUR,
    nightGraceMs: e.nightGraceH * HOUR,
    oldSpaceKeepMs: e.oldSpaceKeepDays * DAY,
    probeCount: Math.min(PROBE_SENTENCES.length, e.probeCount),
    probeMinCos: e.probeMinCos,
    queryCacheMax: e.queryCacheMax ?? 512,
    queryInflightMaxMs: e.queryInflightMaxMs ?? 30_000,
    queryRetries: Math.max(0, Math.floor(e.queryRetries ?? 1)),
    queryRetryBackoffMs: Math.max(0, e.queryRetryBackoffMs ?? 150),
    queryRetryMinLeftMs: Math.max(0, e.queryRetryMinLeftMs ?? 300),
    queryYieldMaxMs: e.queryYieldMaxMs,
    shadowDayBatches: e.shadowDayBatches,
    msPerText: e.msPerText,
    breaker: r.embedBreaker,
    dense: r.dense,
    lexical: r.lexical,
    ppr: r.ppr,
    maxHops: r.entity.maxHops,         // 调用方没给 maxHops / limit / deadlineMs 时（热路径的默认）
    pprLimit: r.fuseKeep,              // 图扩散的命中多于融合留下的条数也没用
    deadlineMs: r.involuntary.deadlineMs,
    worker: w,
  };
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const errKind = (e) => String(e?.code ?? e?.name ?? 'Error').slice(0, 60);
function log(core, level, event, fields) { try { core.log[level](event, fields); } catch { /* 日志失败不影响 */ } }
function metric(core, name, by = 1) {
  try { if (!core.readOnly && core.store && !core.store.closed) bumpMetric(core.store, name, by); } catch { /* 计数失败不影响 */ }
}
const textHash = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
/** MemoryRef 对象或记忆引用字符串 → {kind, id}。 */
function toMref(ref) {
  if (typeof ref === 'string') return parseRef(ref);
  if (ref && OWNER_KINDS[ref.kind] && Number.isInteger(ref.id) && ref.id > 0) return { kind: ref.kind, id: ref.id };
  return null;
}
const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');
function chunked(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
const st = (core) => core.state.worker;

// ── 状态 ──────────────────────────────────────────────────────────────────
/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.worker = {
    mode: 'local',             // local：没起线程，引擎在主线程 / thread：线程在跑 / fallback：起线程失败或线程挂了
    reason: null,
    threads: { search: null, db: null },
    local: null,               // 主线程里的引擎（本地模式、降级时的词法 / 图扩散）
    breaker: { failures: 0, openUntil: 0, probing: false, probingAt: 0 },
    queries: 0,                // 正在等的查询嵌入
    queryWaiters: [],          // 文档批等查询让路
    maintGate: null,           // 运维写入期间嵌入队列暂停写
    queueRunning: null,        // 正在跑的那一轮嵌入队列（Promise）；白天的一轮撞上就返回 busy，夜里那一轮等它跑完
    shadowRunning: new Map(),  // 影子空间 → 正在跑的那一轮重嵌（Promise）：同一个空间同一时间只有一轮（游标、覆盖率只有一个写者）
    termCache: new Map(),      // 规范化的词 → {idf, rowFraction, docs, rows, at}
    msPerText: null,           // 文档嵌入的实测耗时（指数平均），估积压用
    counters: { query: 0, queryFail: 0, queryTimeout: 0, queryError: 0, queryLate: 0, queryCached: 0, queryUnavailable: 0, queryRetry: 0, queryRetryOk: 0 },
    // 查询向量（实测问题 #1）：同一个空间、同一段文字的查询向量永远一样。按「端口空间 id + 文字」缓存（LRU），
    // 正在嵌的同一段文字不再发第二次；调用方等到截止就先走，端口那次照样做完、结果放进缓存，下一次回想直接用上
    queryCache: new Map(),     // `${portSpaceId}\u0000${text}` → Float32Array（端口给的原始向量，用时再按空间维数截断）
    queryInflight: new Map(),  // 同上的键 → {promise: Promise<{v}|{e}|{mismatch}>, at: 墙钟}
    queryStats: { ok: 0, cached: 0, timeout: 0, late: 0, error: 0, unavailable: 0, lastCause: null, lastAt: null, lastMs: null, lastError: null },
    warming: null,             // 端口正在预热（warm() 还没返回）：{at}。已经热着的 warm() 当场就返回，所以这一项在的时候多半是在冷加载
    lastProbe: null,           // 最近一次启动探针：{at, device, meanCos, crossDevice, ok, reason}（只有数字和状态）
    ensuring: null,
    autoEnsureAt: null,
    activeUnproducible: false, // 端口已经产不出活动空间的向量了（换了模型却不支持按空间嵌），只能等影子空间补齐
    restarts: 0,
    lastCrashAt: 0,
    threadInfo: null,          // 线程 ready 时报上来的：{search: {readOnly}, db: {readOnly}}（§13.2「worker 能打开只读连接」）
    noActiveEnsureAt: null,    // 没有活动空间（可疑、端口不可用）时上次在队列里重试 ensureSpace 的时间
    embedEpoch: 0,             // embed_texts 每变一次加一（影子空间覆盖率要不要重新整表核对）
    shadowChecked: new Map(),  // 影子空间 → {epoch, at}：上次精确核对出 100% 时的 embedEpoch 和时间
  };
}

/** @param {import('../core-types.js').CoreContext} core */
export async function dispose(core) {
  const s = st(core);
  if (!s) return;
  await stop(core);
  try { s.local?.close(); } catch { /* 尽力 */ }
  s.local = null;
  for (const w of s.queryWaiters.splice(0)) w();
}

// ── 引擎（线程或本地）──────────────────────────────────────────────────────
/** 主线程里的引擎：用自己的只读连接（和线程里一样，fts5vocab 的 temp 表才建得了），内存库只好借用 store。 */
function localEngine(core) {
  const s = st(core);
  if (s.local) return s.local;
  const p = params(core);
  const open = (store) => {
    if (!store) return null;
    if (store.file && store.file !== ':memory:') {
      try { return wrapDatabase(new DatabaseSync(store.file, { readOnly: true, timeout: p.worker.busyMs })); } catch { /* 退回借用 */ }
    }
    return { get: (q, ...a) => store.get(q, ...a), all: (q, ...a) => store.all(q, ...a), exec: (q) => store.exec(q) };
  };
  s.local = new Engine({ main: open(core.store), vec: open(core.vectors), chunkRows: p.worker.chunkRows, loadBatch: p.worker.loadBatch });
  return s.local;
}

/**
 * 跑引擎的一个操作：线程在跑就发给线程（超时带部分结果返回），否则在主线程里同步跑。永不抛错。
 * @returns {Promise<{result?: any, error?: {code: string}, partials: any[], timedOut: boolean, aborted?: boolean}>}
 */
async function call(core, role, op, args, { deadlineMs = 60_000, signal } = {}) {
  const s = st(core);
  const deadlineAt = wallNow() + Math.max(1, deadlineMs);
  const a = { ...args, deadlineAt };
  const t = s.mode === 'thread' ? s.threads[role] : null;
  if (t?.alive) {
    const r = await t.request(op, a, { deadlineAt, signal });
    if (!r.error || r.error.code !== 'THREAD_DOWN') return r;
    // 线程刚挂：词法、图扩散这一次在主线程里补做；稠密路不在主线程冷加载向量（L3）
    if (role === 'search') return r;
  }
  if (signal?.aborted) return { partials: [], timedOut: true, aborted: true };
  const partials = [];
  try {
    const result = localEngine(core)[op](a, (d) => partials.push(d));
    return { result, partials, timedOut: !!result?.timedOut };
  } catch (e) {
    return { error: { code: errKind(e) }, partials, timedOut: false };
  }
}

/**
 * 改索引的操作：发给 search 线程；本地模式（没起线程）时主线程引擎也同步改。
 * 降级（fallback）时主线程不放向量索引（稠密路 L3），也就不在主线程冷加载。
 * 'loadSpace' 默认只在还没加载过这个空间时才加载（ifMissing）；要整体重建用 'reload'。
 */
function publish(core, op, args) {
  const s = st(core);
  const a = op === 'loadSpace' ? { ifMissing: true, ...args } : args;
  if (s.threads.search?.alive) s.threads.search.post(op, a);
  if (s.local && s.mode === 'local') { try { s.local[op](a); } catch { /* 本地索引坏了下次重建 */ } }
}

function onThreadExit(core, role, info) {
  const s = st(core);
  if (!s || s.mode !== 'thread') return;
  s.mode = 'fallback';
  s.reason = `thread-exit:${role}`;
  s.lastCrashAt = core.now();
  log(core, 'warn', 'worker.thread.exit', { role, code: info?.code ?? null, error: info?.error ?? null });
  metric(core, 'worker.thread.exit');
  for (const k of ['search', 'db']) { const x = s.threads[k]; s.threads[k] = null; if (x?.alive) x.terminate().catch(() => {}); }
}

/**
 * 起 worker 线程（打开只读连接、冷加载热温层向量和原文层二值索引）。失败不抛：稠密路降级（L3），词法改在主线程以更小的上限查。
 * 启动时先做一次 sweepVectors（§12.8）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function start(core) {
  const s = st(core);
  if (s.mode === 'thread' && s.threads.search?.alive && s.threads.db?.alive) return { ok: true };
  if (core.readOnly) return { ok: false, reason: 'read-only' };
  const p = params(core);
  try { sweepVectors(core); } catch (e) { log(core, 'warn', 'worker.sweep.error', { error: errKind(e) }); }
  const fail = (reason) => {
    s.mode = 'fallback';
    s.reason = reason;
    if (s.local) s.local.spaces.clear();   // 降级时主线程不放向量索引
    log(core, 'warn', 'worker.start.failed', { reason });
    metric(core, 'worker.start.failed');
    return { ok: false, reason };
  };
  if (!p.worker.enabled) return fail('disabled');
  if (!core.store?.file || core.store.file === ':memory:') return fail('memory-db');
  const vecFile = core.vectors?.file && core.vectors.file !== ':memory:' ? core.vectors.file : null;
  const spaces = core.vectors ? loadableSpaces(core) : [];
  const base = { mainFile: path.resolve(core.store.file), vecFile, opts: { chunkRows: p.worker.chunkRows, loadBatch: p.worker.loadBatch, busyMs: p.worker.busyMs } };
  let search;
  let db;
  let ready;
  try {
    search = new ThreadClient({ role: 'search', workerData: { ...base, spaces }, onExit: (i) => onThreadExit(core, 'search', i) });
    db = new ThreadClient({ role: 'db', workerData: base, onExit: (i) => onThreadExit(core, 'db', i) });
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'START_TIMEOUT' })), p.worker.startTimeoutMs); timer.unref?.(); });
    try { ready = await Promise.race([Promise.all([search.ready, db.ready]), timeout]); } finally { clearTimeout(timer); }
  } catch (e) {
    await Promise.all([search?.terminate(), db?.terminate()].filter(Boolean));
    return fail(errKind(e));
  }
  s.threadInfo = { search: { readOnly: !!ready?.[0]?.readOnly }, db: { readOnly: !!ready?.[1]?.readOnly } };
  if (!s.threadInfo.search.readOnly || !s.threadInfo.db.readOnly) {
    // 只读连接打不开成只读（不该发生）：照样能查，但在总览标出来（§13.2）
    log(core, 'warn', 'worker.thread.not-readonly', { search: s.threadInfo.search.readOnly, db: s.threadInfo.db.readOnly });
    metric(core, 'worker.thread.notReadOnly');
  }
  s.threads = { search, db };
  s.mode = 'thread';
  s.reason = null;
  if (s.local) s.local.spaces.clear();   // 索引搬到线程里了，主线程不再占内存
  log(core, 'info', 'worker.started', { spaces: spaces.length });
  return { ok: true };
}

/** @param {import('../core-types.js').CoreContext} core @returns {Promise<void>} */
export async function stop(core) {
  const s = st(core);
  if (!s) return;
  const ts = [s.threads.search, s.threads.db].filter(Boolean);
  s.threads = { search: null, db: null };
  if (s.mode === 'thread') { s.mode = 'fallback'; s.reason = 'stopped'; }
  await Promise.all(ts.map((t) => t.terminate()));
}

/** 线程挂了之后隔一阵再试着重起（嵌入队列每次被调时顺便检查，最多 maxRestarts 次）。 */
async function maybeRestart(core) {
  const s = st(core);
  const p = params(core);
  if (s.mode !== 'fallback' || !s.reason?.startsWith('thread-exit')) return;
  if (s.restarts >= p.worker.maxRestarts || core.now() - s.lastCrashAt < p.worker.restartCooldownMs) return;
  s.restarts += 1;
  await start(core);
}

// ── 向量空间（§8.9）────────────────────────────────────────────────────────
function spaceRow(core, spaceId) { return core.store.get('SELECT * FROM vector_spaces WHERE space_id = ?', spaceId) ?? null; }
function activeRow(core) { return core.store.get("SELECT * FROM vector_spaces WHERE status = 'active'") ?? null; }
function shadowRow(core) { return core.store.get("SELECT * FROM vector_spaces WHERE status = 'shadow' ORDER BY created_at DESC LIMIT 1") ?? null; }
/** 要冷加载进内存的空间：活动的 + 影子的。 */
function loadableSpaces(core) {
  try {
    return core.store.all("SELECT space_id AS spaceId, dim FROM vector_spaces WHERE status IN ('active','shadow')");
  } catch { return []; }
}

/**
 * 当前活动空间的 id（查询向量、伪查询向量都在这个空间里）。没有（还没建、可疑、端口不可用）返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {string|null}
 */
export function activeSpaceId(core) {
  try { return activeRow(core)?.space_id ?? null; } catch { return null; }
}

/**
 * 全部向量空间（管理页总览：模型、维数、状态、覆盖率）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{spaceId: string, model: string, dim: number, status: string, coverage: number, createdAt: number, activatedAt: number|null, retiredAt: number|null}[]}
 */
export function spaces(core) {
  return core.store.all('SELECT * FROM vector_spaces ORDER BY created_at').map((r) => ({
    spaceId: r.space_id, model: r.model, dim: r.dim, status: r.status, coverage: r.coverage,
    createdAt: r.created_at, activatedAt: r.activated_at ?? null, retiredAt: r.retired_at ?? null,
  }));
}

/** 端口描述 → 本库里的空间（MRL：配置的维数比端口的小就截断，空间 id 带上维数）。 */
function effectiveSpace(core, info) {
  const dims = params(core).dims;
  const dim = Number.isInteger(dims) && dims > 0 && dims < info.dim ? dims : info.dim;
  return {
    spaceId: dim === info.dim ? info.spaceId : `${info.spaceId}~d${dim}`,
    portSpaceId: info.spaceId, model: String(info.model ?? ''), quant: info.quant ?? null, dim, docTplVer: String(info.docTplVer ?? ''),
  };
}
function portInfo(core) {
  try {
    const info = core.ports.embedding?.info?.();
    if (!info || typeof info.spaceId !== 'string' || !info.spaceId || !(Number(info.dim) > 0)) return null;
    return { ...info, dim: Number(info.dim) };
  } catch { return null; }
}

/** 嵌一批文本（向端口要某个空间的向量；端口不支持按空间嵌就会给它自己的空间，调用方核对 spaceId）。 */
async function portEmbed(core, texts, kind, { priority, portSpaceId, signal }) {
  const port = core.ports.embedding;
  const res = await port.embed(texts, kind, { priority, signal, ...(portSpaceId ? { spaceId: portSpaceId } : {}) });
  if (!res || typeof res.spaceId !== 'string' || !Array.isArray(res.vectors) || res.vectors.length !== texts.length) {
    throw Object.assign(new Error('嵌入端口返回的形状不对'), { code: 'EMBED_SHAPE' });
  }
  return res;
}

async function embedProbes(core, portSpaceId, dim) {
  const texts = PROBE_SENTENCES.slice(0, params(core).probeCount);
  const res = await portEmbed(core, texts, 'doc', { priority: 3, portSpaceId });
  const vecs = res.vectors.map((v) => fitVector(v, dim));
  return { spaceId: res.spaceId, vecs: vecs.every(Boolean) ? vecs : null };
}
function packProbes(vecs) {
  const dim = vecs[0].length;
  const all = new Float32Array(vecs.length * dim);
  vecs.forEach((v, i) => all.set(v, i * dim));
  return new Uint8Array(all.buffer);
}
function meanProbeCos(stored, vecs, dim) {
  const f = blobToF32(stored);
  if (!f || f.length !== vecs.length * dim) return 0;
  let s = 0;
  for (let i = 0; i < vecs.length; i++) s += dot(f.subarray(i * dim, (i + 1) * dim), vecs[i]);
  return s / vecs.length;
}

// ── 探针：模型的身份 + 数值容差（§13.2，实测问题 #1）──────────────────────────
// 同一个模型换个算法后端，向量就有一点数值差（实测 qwen3-embedding:4b Q4_K_M：CPU 建的探针和全部放 GPU 重嵌的平均余弦 0.998；
// 部分层放 GPU 和全部放 GPU 之间 0.9988；Ollama 升级也会有）。哪些层放 GPU 是 Ollama 按当时空闲的显存自己定的，资源管家宣称的
// 设备说明不了实际的放法，所以不能按设备定一个 0.999 的严格门槛：主人在打游戏、显存紧的时候重启一次，空间就又被判可疑，回想全部 L3。
// 「模型被悄悄换过」靠两样判断：
//   - 身份：端口给了模型文件的指纹（EmbeddingInfo.digest，Ollama /api/tags 的 digest）就比指纹，记下来的和现在的不一样就是换了；
//   - 探针：重嵌的探针和存下的任何一份基线（建空间 / 主人确认时那份，加上每个设备第一次跑时存的那份）平均余弦 ≥ embedding.probeMinCos
//     就算对得上。门槛按「同一模型、不同后端」的数值差定，真换了模型（别的权重）差得远。
// 设备的基线只是多留一份对照（health() 里看得出是不是跨设备比的），不再有更严的门槛。
const probeDeviceKey = (spaceId) => `worker.probeDevice.${spaceId}`;
const probeExtraKey = (spaceId, device) => `worker.probe.${spaceId}.${device}`;
const probeDigestKey = (spaceId) => `worker.modelDigest.${spaceId}`;
const DEVICES = ['cpu', 'gpu'];
const deviceNow = (core) => (portInfo(core)?.device === 'gpu' ? 'gpu' : 'cpu');
const digestNow = (core) => { const d = portInfo(core)?.digest; return typeof d === 'string' && d ? d.slice(0, 128) : null; };
function metaOr(core, key) { try { return getMeta(core.store, key); } catch { return null; } }
function metaSet(core, key, value) { try { setMeta(core.store, key, value); } catch { /* 记不下来下次再比一次 */ } }

/** 新存了主基线（建空间、主人确认）：记下设备和模型指纹，别的设备的基线作废。 */
function resetProbeBaseline(core, spaceId) {
  metaSet(core, probeDeviceKey(spaceId), deviceNow(core));
  metaSet(core, probeDigestKey(spaceId), digestNow(core));
  for (const d of DEVICES) if (metaOr(core, probeExtraKey(spaceId, d)) != null) metaSet(core, probeExtraKey(spaceId, d), null);
}

/**
 * 重嵌的探针和这个空间的基线比（见上面的说明）。
 * @returns {{ok: boolean, meanCos: number, device: 'cpu'|'gpu', crossDevice: boolean, reason: 'ok'|'digest'|'probe'}}
 */
function judgeProbes(core, row, vecs) {
  const p = params(core);
  const device = deviceNow(core);
  const digest = digestNow(core);
  const base = metaOr(core, probeDeviceKey(row.space_id));
  const known = metaOr(core, probeDigestKey(row.space_id));
  const own = metaOr(core, probeExtraKey(row.space_id, device));
  const crossDevice = base !== device && !own;   // 这个设备还没有自己的对照（旧库没记设备的按「可能换过设备」算）
  const done = (ok, meanCos, reason) => {
    st(core).lastProbe = { at: core.now(), device, meanCos: Math.round(meanCos * 10_000) / 10_000, crossDevice, ok, reason };
    return { ok, meanCos, device, crossDevice, reason };
  };
  if (digest && known && digest !== known) {
    metric(core, 'worker.space.digestChanged');
    return done(false, 0, 'digest');
  }
  const baselines = [row.probe_vectors];
  for (const d of DEVICES) {
    const b = metaOr(core, probeExtraKey(row.space_id, d));
    if (b) baselines.push(new Uint8Array(Buffer.from(b, 'base64')));
  }
  let best = 0;
  for (const b of baselines) if (b) best = Math.max(best, meanProbeCos(b, vecs, row.dim));
  if (best < p.probeMinCos) return done(false, best, 'probe');
  if (digest && !known) metaSet(core, probeDigestKey(row.space_id), digest);
  if (!base) metaSet(core, probeDeviceKey(row.space_id), device);
  else if (crossDevice) {
    // 这个设备第一次跑：存一份它自己的对照
    metaSet(core, probeExtraKey(row.space_id, device), Buffer.from(packProbes(vecs)).toString('base64'));
    metric(core, 'worker.space.probeCrossDevice');
    log(core, 'info', 'worker.space.probeCrossDevice', { device, meanCos: Math.round(best * 10_000) / 10_000 });
  }
  return done(true, best, 'ok');
}

/**
 * 某个空间要成为活动空间：原来的活动空间退役（开始算 oldSpaceKeepDays）；可疑的空间也从现在开始算保留期
 * （主人换了档而不是确认可疑的模型，它的向量过了保留期就删，行留着当历史）。在调用方的事务里。
 */
function retireOthers(db, spaceId, now) {
  db.run("UPDATE vector_spaces SET status = 'retired', retired_at = ? WHERE status = 'active' AND space_id <> ?", now, spaceId);
  db.run("UPDATE vector_spaces SET retired_at = ? WHERE status = 'suspect' AND retired_at IS NULL AND space_id <> ?", now, spaceId);
}

function insertSpace(core, eff, status, probes) {
  const now = core.now();
  // 以前被判为可疑的空间重新建：它的旧向量来自一个说不清的模型，不能当成已经覆盖了（退役的空间是同一个模型，向量照用）
  const prev = spaceRow(core, eff.spaceId);
  if (prev?.status === 'suspect' && core.vectors) {
    core.vectors.run('DELETE FROM vectors WHERE space_id = ?', eff.spaceId);
    publish(core, 'unloadSpace', { spaceId: eff.spaceId });
  }
  core.store.tx((db) => {
    if (status === 'active') retireOthers(db, eff.spaceId, now);
    if (status === 'shadow') db.run("UPDATE vector_spaces SET status = 'retired', retired_at = ? WHERE status = 'shadow' AND space_id <> ?", now, eff.spaceId);
    db.run(`INSERT INTO vector_spaces(space_id, port_space_id, model, quant, dim, doc_tpl_ver, status, coverage, cursor, probe_vectors, created_at, activated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
            ON CONFLICT(space_id) DO UPDATE SET status = excluded.status, probe_vectors = COALESCE(excluded.probe_vectors, vector_spaces.probe_vectors),
              activated_at = COALESCE(excluded.activated_at, vector_spaces.activated_at), retired_at = NULL, cursor = 0`,
    eff.spaceId, eff.portSpaceId, eff.model, eff.quant, eff.dim, eff.docTplVer, status, probes ? packProbes(probes) : null, now,
    status === 'active' ? now : null);
  });
  if (probes) resetProbeBaseline(core, eff.spaceId);
  if (prev?.status === 'suspect') st(core).queryCache.clear();
}

/**
 * 确保活动空间存在（按 EmbeddingPort.info() 建 vector_spaces 行，存 20 条探针句子的向量），并做启动探针：
 * 重嵌探针比较，平均余弦 < embedding.probeMinCos 就标 suspect、降到 L3 并报警（§13.2）。
 * 门槛按同一模型在不同后端（CPU、GPU、部分层放 GPU）之间的数值差定，和任何一份存下的基线对得上就算；端口给了模型指纹的，
 * 指纹变了直接算可疑。以前只因为换了设备被判可疑的空间，重新确认得上就启用，旧向量照用（实测问题 #1）。
 * 端口的空间和活动空间不同（换了档）→ 新空间建成 shadow，后台影子重嵌（shadowReembed），召回期间仍用旧空间。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {Promise<{spaceId: string|null, status: 'active'|'suspect'|'unavailable', meanCos?: number, shadow?: string}>}
 */
export async function ensureSpace(core) {
  const s = st(core);
  if (s.ensuring) return s.ensuring;
  s.ensuring = ensureSpaceInner(core).catch((e) => {
    log(core, 'warn', 'worker.space.error', { error: errKind(e) });
    return { spaceId: safeActiveId(core), status: /** @type {const} */ ('unavailable') };
  }).finally(() => { s.ensuring = null; });
  return s.ensuring;
}
const safeActiveId = (core) => { try { return activeRow(core)?.space_id ?? null; } catch { return null; } };

async function ensureSpaceInner(core) {
  const s = st(core);
  const p = params(core);
  const active = activeRow(core);
  const info = core.ports.embedding ? portInfo(core) : null;
  if (!info || core.readOnly) return { spaceId: active?.space_id ?? null, status: /** @type {const} */ ('unavailable') };
  const eff = effectiveSpace(core, info);
  if (Number.isInteger(p.dims) && p.dims > info.dim) {
    // 配置的维数比模型给的还大（§13.2「维数和配置一致」）：按模型的维数用，在总览标出来
    log(core, 'warn', 'worker.space.dims', { configured: p.dims, port: info.dim });
    metric(core, 'worker.space.dimsMismatch');
  }
  if (breakerBlocked(core)) return { spaceId: active?.space_id ?? null, status: /** @type {const} */ ('unavailable') };
  const probe = async (portSpaceId, dim) => {
    try { const r = await embedProbes(core, portSpaceId, dim); breakerSuccess(core); return r; } catch (e) { breakerFail(core, e); return null; }
  };

  if (active) {
    const r = await probe(active.port_space_id, active.dim);
    if (!r) return { spaceId: active.space_id, status: /** @type {const} */ ('unavailable') };
    if (r.spaceId !== active.port_space_id) {
      // 端口已经产不出活动空间的向量：只能等影子空间补齐（期间查询嵌入降到 L3，伪查询向量照用旧空间）
      s.activeUnproducible = true;
      const sh = r.spaceId === eff.portSpaceId ? eff : null;
      if (sh && sh.spaceId !== active.space_id) {
        const row = spaceRow(core, sh.spaceId);
        if (!row || row.status === 'retired' || row.status === 'suspect') insertSpace(core, sh, 'shadow', r.vecs?.length && r.vecs[0].length === sh.dim ? r.vecs : null);
        publish(core, 'loadSpace', { spaceId: sh.spaceId, dim: sh.dim });
      }
      const anyDone = core.store.get("SELECT 1 AS x FROM embed_texts WHERE status = 'done' AND space_id = ? LIMIT 1", active.space_id);
      if (!anyDone && sh) {
        // 旧空间里本来就没有向量（刚装好就换了档）：没什么可保留的，直接换
        await activateSpace(core, sh.spaceId, { force: true });
        return { spaceId: sh.spaceId, status: /** @type {const} */ ('active') };
      }
      log(core, 'warn', 'worker.space.unproducible', { shadow: sh?.spaceId ?? null });
      metric(core, 'worker.space.unproducible');
      return { spaceId: active.space_id, status: /** @type {const} */ ('unavailable'), shadow: sh?.spaceId };
    }
    s.activeUnproducible = false;
    if (!r.vecs) return { spaceId: active.space_id, status: /** @type {const} */ ('unavailable') };
    if (!active.probe_vectors) {
      core.store.run('UPDATE vector_spaces SET probe_vectors = ? WHERE space_id = ?', packProbes(r.vecs), active.space_id);
      resetProbeBaseline(core, active.space_id);
    } else {
      const { ok, meanCos, reason } = judgeProbes(core, active, r.vecs);
      if (!ok) {
        core.store.run("UPDATE vector_spaces SET status = 'suspect' WHERE space_id = ?", active.space_id);
        s.queryCache.clear();
        publish(core, 'unloadSpace', { spaceId: active.space_id });
        log(core, 'warn', 'worker.space.suspect', { meanCos: Math.round(meanCos * 10_000) / 10_000, reason });
        metric(core, 'worker.space.suspect');
        s.noActiveEnsureAt = core.now();
        return { spaceId: active.space_id, status: /** @type {const} */ ('suspect'), meanCos };
      }
      if (eff.spaceId === active.space_id) {
        publish(core, 'loadSpace', { spaceId: active.space_id, dim: active.dim });
        return { spaceId: active.space_id, status: /** @type {const} */ ('active'), meanCos };
      }
    }
    if (eff.spaceId === active.space_id) {
      publish(core, 'loadSpace', { spaceId: active.space_id, dim: active.dim });
      return { spaceId: active.space_id, status: /** @type {const} */ ('active') };
    }
    // 主人换了档，端口还能产旧空间：新空间建成影子，后台重嵌，新写入两边都嵌（§8.6.1）
    const row = spaceRow(core, eff.spaceId);
    if (!row || row.status === 'retired' || row.status === 'suspect') {
      const r2 = await probe(eff.portSpaceId, eff.dim);
      insertSpace(core, eff, 'shadow', r2 && r2.spaceId === eff.portSpaceId ? r2.vecs : null);
    }
    publish(core, 'loadSpace', { spaceId: eff.spaceId, dim: eff.dim });
    return { spaceId: active.space_id, status: /** @type {const} */ ('active'), shadow: eff.spaceId };
  }

  // 还没有活动空间：建一个（或者把以前可疑的、影子的、退役的那个重新确认后启用）
  const r = await probe(eff.portSpaceId, eff.dim);
  if (!r || r.spaceId !== eff.portSpaceId || !r.vecs) return { spaceId: null, status: /** @type {const} */ ('unavailable') };
  const row = spaceRow(core, eff.spaceId);
  if (row?.probe_vectors) {
    // 以前可疑的空间（比如只是换了设备，见 judgeProbes）重新确认得上就启用，旧向量照用
    const { ok, meanCos, reason } = judgeProbes(core, { ...row, dim: eff.dim }, r.vecs);
    if (!ok) {
      if (row.status !== 'suspect') core.store.run("UPDATE vector_spaces SET status = 'suspect' WHERE space_id = ?", eff.spaceId);
      log(core, 'warn', 'worker.space.suspect', { meanCos: Math.round(meanCos * 10_000) / 10_000, reason });
      metric(core, 'worker.space.suspect');
      s.noActiveEnsureAt = core.now();
      return { spaceId: eff.spaceId, status: /** @type {const} */ ('suspect'), meanCos };
    }
    await activateSpace(core, eff.spaceId, { force: true });
    log(core, 'info', 'worker.space.active', { reactivated: true });
    return { spaceId: eff.spaceId, status: /** @type {const} */ ('active'), meanCos };
  }
  insertSpace(core, eff, 'active', r.vecs);
  await resyncStatuses(core, eff.spaceId);
  s.activeUnproducible = false;
  publish(core, 'loadSpace', { spaceId: eff.spaceId, dim: eff.dim });
  log(core, 'info', 'worker.space.active', { created: true, dim: eff.dim });
  return { spaceId: eff.spaceId, status: /** @type {const} */ ('active') };
}

/**
 * 换到另一个空间（影子重嵌完成、评测通过之后由管理页 / 集成层调用；端口已经产不出旧空间时由本模块自动调用）。
 * 旧的活动空间退役（向量保留 embedding.oldSpaceKeepDays 天，可以一键切回）。embed_texts 的状态按新空间重算。
 * rebaseline=true：可疑的空间由主人确认「就用现在这个模型」——重新存探针，删掉这个空间的旧向量，全部重嵌。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} spaceId
 * @param {{force?: boolean, rebaseline?: boolean}} [opt]
 * @returns {Promise<{ok: boolean, reason?: string, coverage?: number}>}
 */
export async function activateSpace(core, spaceId, opt = {}) {
  const s = st(core);
  const p = params(core);
  const row = spaceRow(core, spaceId);
  if (!row) return { ok: false, reason: 'unknown-space' };
  if (row.status === 'active' && !opt.rebaseline) return { ok: true };
  if (row.status === 'shadow' && row.coverage < 1 && !opt.force) return { ok: false, reason: 'coverage', coverage: row.coverage };
  if (row.status === 'retired' && row.retired_at != null && core.now() - row.retired_at > p.oldSpaceKeepMs && !opt.force) {
    return { ok: false, reason: 'expired' };
  }
  let probes = null;
  if (opt.rebaseline) {
    try { const r = await embedProbes(core, row.port_space_id, row.dim); if (r.spaceId === row.port_space_id) probes = r.vecs; } catch (e) { breakerFail(core, e); }
    if (!probes) return { ok: false, reason: 'probe-failed' };
    // 重来期间这个空间不是活动的（没人拿它查），旧探针也先留着（并发的 ensureSpace 不会提前把它启用）；
    // 旧向量和 embed_texts 的状态分批改，批与批之间让出事件循环
    core.store.run("UPDATE vector_spaces SET status = 'suspect' WHERE space_id = ? AND status = 'active'", spaceId);
    publish(core, 'unloadSpace', { spaceId });
    if (core.vectors) {
      for (;;) {
        const n = Number(core.vectors.run(`DELETE FROM vectors WHERE space_id = ? AND embed_text_id IN (
          SELECT embed_text_id FROM vectors WHERE space_id = ? LIMIT 2000)`, spaceId, spaceId).changes);
        if (n < 2000) break;
        await tickYield();
      }
    }
    let after = -1;
    for (;;) {
      const ids = core.store.all('SELECT id FROM embed_texts WHERE id > ? ORDER BY id LIMIT 2000', after).map((r) => r.id);
      if (!ids.length) break;
      after = ids.at(-1);
      core.store.run(`UPDATE embed_texts SET status = 'pending', space_id = NULL, attempts = 0, updated_at = ? WHERE id IN (${placeholders(ids.length)})`, core.now(), ...ids);
      await tickYield();
    }
    s.embedEpoch += 1;
  }
  const now = core.now();
  const previous = core.store.all("SELECT space_id FROM vector_spaces WHERE status = 'active' AND space_id <> ?", spaceId).map((r) => r.space_id);
  core.store.tx((db) => {
    retireOthers(db, spaceId, now);
    db.run("UPDATE vector_spaces SET status = 'active', activated_at = ?, retired_at = NULL, probe_vectors = COALESCE(?, probe_vectors) WHERE space_id = ?",
      now, probes ? packProbes(probes) : null, spaceId);
  });
  if (probes) { resetProbeBaseline(core, spaceId); s.queryCache.clear(); }
  if (!opt.rebaseline) await resyncStatuses(core, spaceId);
  s.activeUnproducible = false;
  // 影子空间一直跟着增量发布，已经在索引里；别的（退役的切回来、可疑的重新确认）从磁盘重新冷加载
  publish(core, 'loadSpace', { spaceId, dim: row.dim, ifMissing: row.status === 'shadow' });
  // 退役的旧空间只在磁盘上保留（切回来时再冷加载），不再占内存
  for (const old of previous) publish(core, 'unloadSpace', { spaceId: old });
  log(core, 'info', 'worker.space.activated', { rebaseline: !!opt.rebaseline });
  metric(core, 'worker.space.activated');
  return { ok: true };
}

/**
 * 活动空间换了：embed_texts.status 按新空间重算（向量库里有这个空间、哈希对得上的 → done，否则 stale / pending）。
 * 分批，批与批之间让出事件循环（几十万行时主线程不能一口气卡住）。
 */
async function resyncStatuses(core, spaceId) {
  if (!core.vectors) return;
  let after = -1;
  const now = core.now();
  for (;;) {
    const rows = core.store.all("SELECT id, hash FROM embed_texts WHERE id > ? AND NOT (status = 'done' AND space_id IS ?) ORDER BY id LIMIT 1000", after, spaceId);
    if (!rows.length) break;
    after = rows.at(-1).id;
    const have = new Map(core.vectors.all(`SELECT embed_text_id AS id, text_hash FROM vectors WHERE space_id = ? AND embed_text_id IN (${placeholders(rows.length)})`,
      spaceId, ...rows.map((r) => r.id)).map((r) => [r.id, r.text_hash]));
    core.store.tx((db) => {
      for (const r of rows) {
        // 只按读出来时的哈希改：中间被 enqueueEmbed 改过文本的行留给它自己的状态
        if (have.get(r.id) === r.hash) db.run("UPDATE embed_texts SET status = 'done', space_id = ?, attempts = 0, updated_at = ? WHERE id = ? AND hash = ?", spaceId, now, r.id, r.hash);
        else db.run("UPDATE embed_texts SET status = CASE WHEN status = 'done' THEN 'stale' WHEN status = 'failed' THEN 'pending' ELSE status END, updated_at = ? WHERE id = ?", now, r.id);
      }
    });
    await tickYield();
  }
}

/** 让出一次事件循环（长的分批任务在批与批之间调用）。 */
const tickYield = () => new Promise((resolve) => setImmediate(resolve));

// ── 熔断（§8.8：连续 2 次失败后 60 秒内不调，之后放一次探测）──────────────────────
/**
 * 一次新的调用能不能发出去（冷却期过了就放一次探测，结果出来之前别的调用还等着）。
 * 返回 false 的调用方拿到了探测权：要么真的去调端口（成功 / 失败会结束探测），要么 breakerRelease 交回去。
 * 探测权只租一个冷却期：拿了探测权的调用卡住了（或者忘了交回），过了冷却期再放下一个探测，不会永远熔断。
 */
function breakerBlocked(core) { return breakerGate(core) === null; }
/** 同 breakerBlocked，但返回凭据：null = 熔断中；0 = 没熔断；> 0 = 拿到了探测权（交回时要带上它）。 */
function breakerGate(core) {
  const b = st(core).breaker;
  if (!b.openUntil) return 0;
  const now = core.now();
  if (now < b.openUntil) return null;
  if (b.probing && now - b.probingAt < params(core).breaker.coolMs) return null;
  b.probing = true;
  b.probingAt = now;
  b.probeToken = (b.probeToken ?? 0) + 1;
  return b.probeToken;
}
/** 拿了探测权却没调端口（队列是空的、没有活动空间……）：交回去，让下一个调用来探测。只交自己拿的那一次。 */
function breakerRelease(core, token) {
  const b = st(core).breaker;
  if (token && b.probing && b.probeToken === token) b.probing = false;
}
/** 已经放行的调用（批处理循环里）：熔断是不是又打开了。 */
const breakerOpenNow = (core) => st(core).breaker.openUntil > core.now();
function breakerFail(core, e) {
  if (e?.name === 'AbortError') return;   // 调用方自己放弃的不算服务失败
  const s = st(core);
  const b = s.breaker;
  const p = params(core);
  b.failures += 1;
  if (b.probing || b.failures >= p.breaker.failures) {
    const wasOpen = b.openUntil > 0;
    b.openUntil = core.now() + p.breaker.coolMs;
    b.probing = false;
    if (!wasOpen) {
      log(core, 'warn', 'worker.embed.breaker', { coolMs: p.breaker.coolMs, error: errKind(e) });
      metric(core, 'embed.breaker.open');
    }
  }
}
function breakerSuccess(core) {
  const b = st(core).breaker;
  b.failures = 0;
  b.openUntil = 0;
  b.probing = false;
}

// ── 查询嵌入 ──────────────────────────────────────────────────────────────
/**
 * 查询嵌入（最高优先级）。端口缺失、熔断、超时都返回 null（调用方降到 L3）。
 * 有查询在等时文档批让路（runEmbedQueue 会等它）。
 * 端口已经产不出活动空间的向量（换了模型，影子空间还没补齐）也返回 null：查询只和同一个空间比，宁可降级也不混用。
 * worker 线程挂了（降级）不影响这里：嵌入服务是好的，只是稠密扫描做不了（denseSearch 返回空）；
 * 别的用途（外发初筛的整句向量、对账、告诉过谁的比对）照样用得上查询向量。
 * 晚到的向量照样有用（实测问题 #1）：每段文字的向量按空间缓存（embedding.queryCacheMax 条，LRU），正在嵌的同一段文字不再发第二次；
 * 端口调用不跟着调用方的截止和 signal 取消（端口自己有超时），调用方到点先返回 null，结果回来后放进缓存，
 * 下一次回想（预取之后的 pre-step、有意回想、外发审视）直接用上。冷模型第一次加载要好几秒，这样只吃一次亏。
 * 慢（到截止没回来）不算失败，也不熔断；端口真报错才算。端口很快就报错（不是慢）、截止时间还够时，在截止时间里再试
 * embedding.queryRetries 次（每次先等 queryRetryBackoffMs × 次数，剩下不到 queryRetryMinLeftMs 就不试；D117），计 embed.query.retry / retryOk。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} texts
 * @param {{deadlineMs: number, signal?: AbortSignal}} opt
 * @returns {Promise<{spaceId: string, vectors: Float32Array[]}|null>}
 */
export async function embedQuery(core, texts, opt = { deadlineMs: 800 }) {
  const s = st(core);
  if (!core.ports.embedding || !Array.isArray(texts) || !texts.length || texts.some((t) => typeof t !== 'string')) return null;
  if (opt?.signal?.aborted) return null;
  const t0 = wallNow();
  if (s.activeUnproducible) return queryDone(core, 'unavailable', t0);
  let space;
  try { space = activeRow(core); } catch { return null; }
  if (!space) { autoEnsure(core, true); return queryDone(core, 'unavailable', t0); }
  const p = params(core);
  const keyOf = (t) => `${space.port_space_id}\u0000${t}`;
  // 先看缓存（端口给的原始向量）；缺的文字：正在嵌的就等那一次，其余的一起发一次
  const got = new Map();
  let waits = [];     // {text, promise, flight}
  const missing = [];
  const now = wallNow();
  for (const t of new Set(texts)) {
    const v = cacheGet(s, keyOf(t));
    if (v) { got.set(t, v); continue; }
    const f = s.queryInflight.get(keyOf(t));
    if (f && now - f.at < p.queryInflightMaxMs) waits.push({ text: t, promise: f.promise, flight: f.flight });
    else missing.push(t);
  }
  const assemble = () => {
    const vectors = texts.map((t) => fitVector(got.get(t), space.dim));
    return vectors.every(Boolean) ? { spaceId: space.space_id, vectors } : null;
  };
  if (!waits.length && !missing.length) {
    const r = assemble();
    return r ? queryDone(core, 'cached', t0, r) : queryDone(core, 'error', t0, null, { code: 'EMBED_BAD_VECTOR' });
  }
  if (missing.length) {
    const gate = breakerGate(core);
    if (gate === null) return queryDone(core, 'unavailable', t0);
    // 拿到探测权（或者没熔断）就真的调端口：成功 / 失败会结束探测
    const flight = startQueryCall(core, space, missing);
    for (const t of missing) waits.push({ text: t, promise: flight.promise, flight });
  }
  s.queries += 1;
  let timer = null;
  let onAbort = null;
  try {
    const ms = Math.max(1, Number(opt?.deadlineMs) || p.deadlineMs);
    const stopper = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), ms);
      if (opt?.signal) { onAbort = () => resolve({ aborted: true }); opt.signal.addEventListener('abort', onAbort, { once: true }); }
    });
    // 很快就报错的（连接被重置、模型正在重载……；不是慢）在截止时间里再试（D117，embedding.queryRetries 次、每次先等 backoff × 次数）
    let tries = 0;
    for (;;) {
      const all = Promise.all(waits.map((w) => w.promise)).then((xs) => ({ xs }));
      const out = await Promise.race([all, stopper]);
      if (out.timeout || out.aborted) {
        // 慢不算失败（冷模型、CPU 上排队）：那一次照样做完，结果进缓存（回来时记一次 queryLate）；真失败了回来再记熔断
        for (const w of waits) if (!w.flight.settled) w.flight.gaveUp = true;
        return queryDone(core, out.aborted ? 'aborted' : 'timeout', t0);
      }
      let failed = null;
      for (let i = 0; i < waits.length; i++) {
        const x = out.xs[i];
        if (x.mismatch) return queryDone(core, 'unavailable', t0);
        if (x.e) { failed = x.e; continue; }
        const v = x.vectors?.get(waits[i].text);
        if (v) got.set(waits[i].text, v);
      }
      if (!failed) {
        const r = assemble();
        if (tries && r) s.counters.queryRetryOk += 1;
        return r ? queryDone(core, 'ok', t0, r) : queryDone(core, 'error', t0, null, { code: 'EMBED_BAD_VECTOR' });
      }
      const backoff = p.queryRetryBackoffMs * (tries + 1);
      const leftMs = ms - (wallNow() - t0);
      if (tries >= p.queryRetries || failed?.code === 'EMBED_BAD_VECTOR' || opt?.signal?.aborted || leftMs < p.queryRetryMinLeftMs + backoff) {
        return queryDone(core, 'error', t0, null, failed);
      }
      tries += 1;
      s.counters.queryRetry += 1;
      let sleepTimer = null;
      const slept = await Promise.race([new Promise((resolve) => { sleepTimer = setTimeout(() => resolve({ slept: true }), backoff); }), stopper]);
      clearTimeout(sleepTimer);
      if (slept.timeout || slept.aborted) return queryDone(core, slept.aborted ? 'aborted' : 'timeout', t0);
      // 还缺的文字：这期间别的调用可能已经把它放进缓存或者正在嵌，先看那两处，其余的再发一次（熔断开了就不发）
      waits = [];
      const again = [];
      for (const t of new Set(texts)) {
        if (got.has(t)) continue;
        const v = cacheGet(s, keyOf(t));
        if (v) { got.set(t, v); continue; }
        const f = s.queryInflight.get(keyOf(t));
        if (f && wallNow() - f.at < p.queryInflightMaxMs) waits.push({ text: t, promise: f.promise, flight: f.flight });
        else again.push(t);
      }
      if (again.length) {
        if (breakerGate(core) === null) return queryDone(core, 'error', t0, null, failed);
        const flight = startQueryCall(core, space, again, { countFail: false });
        for (const t of again) waits.push({ text: t, promise: flight.promise, flight });
      }
    }
  } catch (e) {
    return queryDone(core, 'error', t0, null, e);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opt.signal.removeEventListener('abort', onAbort);
    s.queries -= 1;
    if (s.queries <= 0) { s.queries = 0; for (const w of s.queryWaiters.splice(0)) w(); }
  }
}

/**
 * 发一次端口调用（不带调用方的 signal：调用方到点走了，这一次也做完，结果进缓存）。
 * flight.promise 落定成 {vectors: Map<文字, Float32Array>} 成功 / {e} 报错 / {mismatch} 端口给了别的空间，从不 reject。
 * 熔断在这里记一次（不是每个等的人各记一次）。countFail=false：同一次查询的重试（D117）——报错不再记一次熔断失败
 * （一次查询最多算一次失败：第一次加重试两次失败就打开熔断，接下来一分钟的回想全降到 L3，D117 评审），成功照样关熔断。
 */
function startQueryCall(core, space, texts, { countFail = true } = {}) {
  const s = st(core);
  const flight = { promise: null, settled: false, gaveUp: false };
  const keys = texts.map((t) => `${space.port_space_id}\u0000${t}`);
  flight.promise = portEmbed(core, texts, 'query', { priority: 0, portSpaceId: space.port_space_id }).then((res) => {
    if (res.spaceId !== space.port_space_id) {
      // 端口给的是别的空间：查询只和同一个空间比，宁可降级也不混用（§8.9）。端口本身是好的，不算失败
      breakerSuccess(core);
      autoEnsure(core, false);
      return { mismatch: true };
    }
    if (res.vectors.some((v) => !fitVector(v, space.dim))) { const e = { code: 'EMBED_BAD_VECTOR' }; if (countFail) breakerFail(core, e); return { e }; }
    breakerSuccess(core);
    // 缓存端口给的原始向量（截断前的）：同一个端口空间不同维数的空间也能用
    const vectors = new Map();
    texts.forEach((t, i) => { const v = Float32Array.from(res.vectors[i]); vectors.set(t, v); cachePut(core, keys[i], v); });
    return { vectors };
  }, (e) => { if (countFail) breakerFail(core, e); return { e }; }).then((x) => {
    flight.settled = true;
    for (const k of keys) if (s.queryInflight.get(k)?.flight === flight) s.queryInflight.delete(k);
    // 等的人到点走了、结果后来才回来：这次没赶上，下一次回想直接用缓存
    if (x.vectors && flight.gaveUp) { s.counters.queryLate += 1; s.queryStats.late += 1; }
    return x;
  });
  const at = wallNow();
  for (const k of keys) s.queryInflight.set(k, { promise: flight.promise, at, flight });
  return flight;
}

function cacheGet(s, key) {
  const v = s.queryCache.get(key);
  if (!v) return null;
  s.queryCache.delete(key);
  s.queryCache.set(key, v);
  return v;
}
function cachePut(core, key, v) {
  const s = st(core);
  s.queryCache.delete(key);
  s.queryCache.set(key, v);
  const max = Math.max(0, params(core).queryCacheMax);
  while (s.queryCache.size > max) s.queryCache.delete(s.queryCache.keys().next().value);
}

/** 记下这一次查询嵌入的结果（计数、最近一次的原因和耗时；只有数字和错误类型）。 */
function queryDone(core, cause, t0, value = null, err = null) {
  const s = st(core);
  const q = s.queryStats;
  const c = s.counters;
  if (cause === 'ok') { c.query += 1; q.ok += 1; }
  else if (cause === 'cached') { c.queryCached += 1; q.cached += 1; }
  else if (cause === 'timeout') { c.queryFail += 1; c.queryTimeout += 1; q.timeout += 1; }
  else if (cause === 'error') { c.queryFail += 1; c.queryError += 1; q.error += 1; q.lastError = errKind(err); }
  else if (cause === 'unavailable') { c.queryUnavailable += 1; q.unavailable += 1; }
  q.lastCause = cause;
  q.lastAt = core.now();
  q.lastMs = Math.round(wallNow() - t0);
  return value;
}

/**
 * 有人在她在的地方说话了（她可能马上要回想）：让嵌入端口先把查询模型备好（端口有可选的 warm() 才做；
 * 节流和「已经热着就不发」由端口自己管）。不等、不抛错。冷模型第一次加载要好几秒，这几秒在她开口之前花掉。
 * @param {import('../core-types.js').CoreContext} core
 */
export function warmQuery(core) {
  try {
    const port = core.ports.embedding;
    if (!port || typeof port.warm !== 'function' || breakerOpenNow(core)) return;
    const s = st(core);
    const mark = { at: wallNow() };
    s.warming = mark;
    Promise.resolve(port.warm()).catch(() => {}).finally(() => { if (s.warming === mark) s.warming = null; });
  } catch { /* 预热失败不影响任何事 */ }
}

/**
 * 查询模型是不是正在加载（warmQuery 发出的预热还没回来，最多算 embedding.queryInflightMaxMs）。
 * context 据此让这一轮的不自主回想多等一会儿（等到有意回想的截止时间）：闲了很久以后的第一句话，冷加载要两三秒，
 * 按 800 毫秒的截止走这一轮必然没有查询向量（实测问题 #1）。只是个提示，读不到就当没在加载。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {boolean}
 */
export function queryWarming(core) {
  try {
    const w = st(core).warming;
    return !!w && wallNow() - w.at < params(core).queryInflightMaxMs;
  } catch { return false; }
}

/**
 * 后台补一次 ensureSpace（不等它）：还从来没建过空间时（onlyIfNone），或者端口给的空间对不上时。
 * 可疑的空间不自动重试（等主人处理或下次启动），同一个冷却期里最多一次。
 */
function autoEnsure(core, onlyIfNone) {
  const s = st(core);
  if (core.readOnly || s.ensuring) return;
  if (core.now() - (s.autoEnsureAt ?? -Infinity) < params(core).breaker.coolMs) return;
  try { if (onlyIfNone && core.store.get('SELECT 1 AS x FROM vector_spaces LIMIT 1')) return; } catch { return; }
  s.autoEnsureAt = core.now();
  ensureSpace(core).catch(() => {});
}

/** 有查询在等时让路（最多等 maxMs）。 */
function yieldToQueries(core, maxMs) {
  const s = st(core);
  if (s.queries <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(fin, maxMs);
    s.queryWaiters.push(fin);
  });
}

// ── 嵌入文本（embed_texts）────────────────────────────────────────────────
/**
 * 登记要嵌入的文本块（写 embed_texts；文本和哈希没变就不动，变了标 stale）。在调用方的事务里调用（同步）。
 * priority：1 原文窗口 / 2 新的记忆单元 / 3 补嵌和重嵌。
 * 给出的块是这条记忆这几种 kind 的完整集合：同一 kind 里没再出现的旧块（比如情节变短了）连同向量一起删掉。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {{chunkNo: number, kind: 'text'|'fq', text: string, headerVer?: string|null}[]} chunks
 * @param {{layer: 'memory'|'raw', priority: 1|2|3}} opt
 */
export function enqueueEmbed(core, ref, chunks, opt) {
  const m = toMref(ref);
  if (!m) throw new TypeError('enqueueEmbed：不认识的记忆引用');
  const layer = opt?.layer;
  if (!LAYERS.has(layer)) throw new TypeError('enqueueEmbed：layer 只能是 memory 或 raw');
  const priority = [1, 2, 3].includes(opt?.priority) ? opt.priority : (layer === 'raw' ? 1 : 2);
  const want = new Map();
  for (const c of chunks ?? []) {
    if (!c || (c.kind !== 'text' && c.kind !== 'fq') || !Number.isInteger(c.chunkNo) || c.chunkNo < 0) continue;
    const text = String(c.text ?? '').trim();
    if (!text) continue;
    want.set(`${c.kind}:${c.chunkNo}`, { chunkNo: c.chunkNo, kind: c.kind, text, hash: textHash(text), headerVer: c.headerVer ?? null });
  }
  const kinds = new Set((chunks ?? []).map((c) => c?.kind).filter((k) => k === 'text' || k === 'fq'));
  const now = core.now();
  const dropped = [];
  let changed = false;
  core.store.tx((db) => {
    const old = db.all('SELECT id, chunk_no, kind, hash, status, priority, layer FROM embed_texts WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
    const byKey = new Map(old.map((r) => [`${r.kind}:${r.chunk_no}`, r]));
    for (const [key, c] of want) {
      const r = byKey.get(key);
      if (!r) {
        changed = true;
        db.run(`INSERT INTO embed_texts(owner_kind, owner_id, chunk_no, kind, layer, text, hash, header_ver, priority, status, attempts, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`, m.kind, m.id, c.chunkNo, c.kind, layer, c.text, c.hash, c.headerVer, priority, now, now);
      } else if (r.hash !== c.hash || r.layer !== layer) {
        changed = true;
        db.run(`UPDATE embed_texts SET text = ?, hash = ?, header_ver = ?, layer = ?, priority = ?, attempts = 0, updated_at = ?,
                  status = CASE WHEN status = 'done' THEN 'stale' ELSE 'pending' END WHERE id = ?`,
        c.text, c.hash, c.headerVer, layer, Math.min(priority, r.priority), now, r.id);
      } else if (priority < r.priority && r.status !== 'done') {
        db.run('UPDATE embed_texts SET priority = ?, updated_at = ? WHERE id = ?', priority, now, r.id);
      }
    }
    for (const r of old) {
      if (kinds.has(r.kind) && !want.has(`${r.kind}:${r.chunk_no}`)) { db.run('DELETE FROM embed_texts WHERE id = ?', r.id); dropped.push(r.id); }
    }
    if (changed || dropped.length) st(core).embedEpoch += 1;
    if (dropped.length) {
      db.afterCommit(() => {
        if (core.vectors) for (const part of chunked(dropped, 500)) core.vectors.run(`DELETE FROM vectors WHERE embed_text_id IN (${placeholders(part.length)})`, ...part);
        publish(core, 'remove', { ids: dropped });
      });
    }
  });
}

/**
 * 删掉这些记忆单元的嵌入文本和向量（彻底删除、原文过保留期）。**先删向量，再删主库的行**（§12.7）。可重跑。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef[]} refs
 * @returns {{texts: number, vectors: number}}
 */
export function dropEmbeddings(core, refs) {
  const byKind = new Map();
  const refStrs = [];
  for (const r of refs ?? []) {
    const m = toMref(r);
    if (!m) continue;
    if (!byKind.has(m.kind)) byKind.set(m.kind, new Set());
    byKind.get(m.kind).add(m.id);
    refStrs.push(refOf(m.kind, m.id));
  }
  let vectors = 0;
  let texts = 0;
  if (!byKind.size) return { texts, vectors };
  if (core.vectors) {
    core.vectors.tx((v) => {
      for (const [kind, ids] of byKind) {
        for (const part of chunked([...ids], 500)) {
          vectors += Number(v.run(`DELETE FROM vectors WHERE owner_kind = ? AND owner_id IN (${placeholders(part.length)})`, kind, ...part).changes);
        }
      }
    });
  }
  publish(core, 'removeOwners', { refs: refStrs });
  core.store.tx((db) => {
    for (const [kind, ids] of byKind) {
      for (const part of chunked([...ids], 500)) {
        texts += Number(db.run(`DELETE FROM embed_texts WHERE owner_kind = ? AND owner_id IN (${placeholders(part.length)})`, kind, ...part).changes);
      }
    }
  });
  if (texts || vectors) st(core).embedEpoch += 1;
  if (texts || vectors) log(core, 'info', 'worker.embed.dropped', { refs: refStrs.length, texts, vectors });
  return { texts, vectors };
}

// ── 嵌入队列（§7.6）────────────────────────────────────────────────────────
/** 把向量写进向量库（一个事务），返回要发布给索引的行。 */
function writeVectors(core, spaceId, items) {
  const now = core.now();
  const rows = [];
  core.vectors.tx((v) => {
    for (const { row, vec } of items) {
      const e = encodeVector(vec, row.layer === 'memory');
      v.run(`INSERT INTO vectors(space_id, embed_text_id, owner_kind, owner_id, chunk_no, kind, layer, text_hash, f32, q8, q8_scale, bin, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(space_id, embed_text_id) DO UPDATE SET owner_kind = excluded.owner_kind, owner_id = excluded.owner_id,
               chunk_no = excluded.chunk_no, kind = excluded.kind, layer = excluded.layer, text_hash = excluded.text_hash,
               f32 = excluded.f32, q8 = excluded.q8, q8_scale = excluded.q8_scale, bin = excluded.bin, created_at = excluded.created_at`,
      spaceId, row.id, row.owner_kind, row.owner_id, row.chunk_no, row.kind, row.layer, row.hash, e.f32, e.q8, e.q8Scale, e.bin, now);
      rows.push({ id: row.id, owner_kind: row.owner_kind, owner_id: row.owner_id, chunk_no: row.chunk_no, layer: row.layer, q8: e.q8, q8_scale: e.q8Scale, bin: e.bin });
    }
  });
  return rows;
}

/** 一批行嵌失败：attempts + 1，到上限标 failed。 */
function markAttempt(core, ids, maxAttempts) {
  if (!ids.length) return;
  st(core).embedEpoch += 1;   // 可能变成 failed（影子空间覆盖率的分母会变）
  const now = core.now();
  core.store.tx((db) => {
    for (const part of chunked(ids, 500)) {
      db.run(`UPDATE embed_texts SET attempts = attempts + 1, updated_at = ?,
                status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END WHERE id IN (${placeholders(part.length)})`, now, maxAttempts, ...part);
    }
  });
}

/** 嵌一批文本到某个空间并写向量库。返回 {ok, rows（成功的行）, bad（向量不能用的行 id）} 或抛端口的错。 */
async function embedInto(core, space, rows, { priority, signal }) {
  const res = await portEmbed(core, rows.map((r) => r.text), 'doc', { priority, portSpaceId: space.port_space_id, signal });
  if (res.spaceId !== space.port_space_id) return { ok: false, mismatch: true, rows: [], bad: [] };
  const items = [];
  const bad = [];
  rows.forEach((row, i) => { const v = fitVector(res.vectors[i], space.dim); if (v) items.push({ row, vec: v }); else bad.push(row.id); });
  const published = items.length ? writeVectors(core, space.space_id, items) : [];
  return { ok: true, rows: items.map((x) => x.row), published, bad };
}

/** 等运维写入（FTS 合并、vacuum）做完。 */
async function waitMaint(core) { const g = st(core).maintGate; if (g) await g.catch(() => {}); }

/**
 * 跑嵌入队列（文档批）：按优先级取 pending / stale，调 EmbeddingPort.embed(texts, 'doc')，写向量库（f32 只给记忆层），
 * 标 done，发布给 worker。有查询在等时让路。熔断打开时直接返回。
 * 积压（CPU 上估计超过 embedding.backlogDeferH 小时的工作量）时白天只嵌原文窗口，其余推到夜里（opt.night=true 时全做，
 * 并且重试一天前失败的行；夜里那一轮超过 embedding.nightGraceH 没来过，白天也不再往后推）。
 * 活动空间的队列空了还有余量，就推进影子空间的重嵌（§8.6.1）。没有活动空间时（第一次装好、可疑、端口不可用）顺便重试
 * ensureSpace（有过空间的隔 worker.reprobeMs 一次）。线程挂了过了冷却期也在这里顺手重起。
 * 同一时间只跑一轮：白天（tick）的一轮撞上正在跑的就返回 busy；夜里那一轮（night=true，夜间整理第 9 步）等正在跑的那一轮
 * 做完再跑，不整轮跳过（否则推后的积压和失败行的重试只能等 nightGraceH 的安全网）；等的时候 signal 中止就返回。
 * busy：白天的一轮撞上了正在跑的一轮；breaker：熔断开着，这一轮没调端口。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{maxBatches?: number, batchSize?: number, signal?: AbortSignal, night?: boolean}} [opt]
 * @returns {Promise<{embedded: number, failed: number, busy?: boolean, breaker?: boolean}>}
 */
export async function runEmbedQueue(core, opt = {}) {
  const s = st(core);
  if (core.readOnly || !core.vectors || !core.ports.embedding) return { embedded: 0, failed: 0 };
  if (opt.night) {
    // tick 每分钟跑一两批，跑完了就轮到夜里这一轮；中间又被下一个 tick 抢先就接着等
    while (s.queueRunning && !opt.signal?.aborted) await settledOrAborted(s.queueRunning, opt.signal);
    if (opt.signal?.aborted) return { embedded: 0, failed: 0 };
  }
  if (s.queueRunning) return { embedded: 0, failed: 0, busy: true };
  const run = queueRound(core, opt);   // 同步执行到第一个 await 之前，别人插不进来
  s.queueRunning = run;
  try { return await run; } finally { if (s.queueRunning === run) s.queueRunning = null; }
}

/** 等一个 Promise 落定（成功失败都行），或者 signal 中止，哪个先到算哪个。 */
function settledOrAborted(promise, signal) {
  const settled = Promise.resolve(promise).then(() => {}, () => {});
  if (!signal) return settled;
  return new Promise((resolve) => {
    const done = () => { signal.removeEventListener('abort', done); resolve(); };
    signal.addEventListener('abort', done, { once: true });
    settled.then(done);
  });
}

/** runEmbedQueue 的一轮（调用方保证同一时间只有一轮）。 */
async function queueRound(core, opt) {
  const s = st(core);
  const out = { embedded: 0, failed: 0 };
  let gate = 0;
  try {
    await maybeRestart(core);
    flushCounters(core);
    gate = breakerGate(core);
    if (gate === null) return { ...out, breaker: true };
    let active = activeRow(core);
    if (!active && !s.activeUnproducible && shouldRetryNoActive(core)) {
      breakerRelease(core, gate);   // ensureSpace 自己去拿探测权
      gate = 0;
      await ensureSpace(core);
      active = activeRow(core);
    }
    if (!active) return out;
    const p = params(core);
    const info = portInfo(core);
    const device = info?.device === 'gpu' ? 'gpu' : 'cpu';
    const batchSize = Math.max(1, opt.batchSize ?? p.batch[device]);
    const maxBatches = opt.maxBatches ?? Infinity;
    const now = core.now();
    if (opt.night) {
      core.store.run("UPDATE embed_texts SET status = 'pending', attempts = 0, updated_at = ? WHERE status = 'failed' AND updated_at <= ?", now, now - p.retryFailedAfterMs);
    }
    let maxPriority = 3;
    if (opt.night) {
      try { setMeta(core.store, 'worker.nightRunAt', String(now)); } catch { /* 记不下来只影响下面的安全网 */ }
    } else if (device === 'cpu') {
      const backlog = Number(core.store.get("SELECT count(*) AS n FROM embed_texts WHERE status IN ('pending','stale') AND priority >= 2")?.n ?? 0);
      const per = s.msPerText ?? p.msPerText.cpu;
      // 安全网：夜里那一轮超过 nightGraceH 没跑过（整理被跳过、没传 night），积压就不再往后推，不能永远嵌不上
      if (backlog * per > p.backlogDeferMs) {
        let lastNight = Number(getMeta(core.store, 'worker.nightRunAt') ?? NaN);
        if (!Number.isFinite(lastNight)) {   // 第一次推后：从现在开始算
          lastNight = now;
          try { setMeta(core.store, 'worker.nightRunAt', String(now)); } catch { /* 尽力 */ }
        }
        if (now - lastNight <= p.nightGraceMs) maxPriority = 1;
      }
    }
    let batches = 0;
    const shadow = shadowRow(core);
    const skip = new Set();   // 这一轮已经失败过的行不再重试（下一轮、或者夜里再说）
    while (!s.activeUnproducible && batches < maxBatches) {
      if (opt.signal?.aborted) break;
      await yieldToQueries(core, p.queryYieldMaxMs);
      await waitMaint(core);
      if (breakerOpenNow(core)) break;
      if (activeSpaceId(core) !== active.space_id) break;   // 中途换了空间（管理页切换、影子补齐）：下一轮按新空间来
      const rows = core.store.all(`SELECT id, owner_kind, owner_id, chunk_no, kind, layer, text, hash, priority FROM embed_texts
                                   WHERE status IN ('pending','stale') AND priority <= ? ORDER BY priority, id LIMIT ?`, maxPriority, batchSize + skip.size)
        .filter((x) => !skip.has(x.id)).slice(0, batchSize);
      if (!rows.length) break;
      const t0 = performance.now();
      let r;
      try {
        r = await embedInto(core, active, rows, { priority: rows[0].priority, signal: opt.signal });
      } catch (e) {
        if (opt.signal?.aborted || e?.name === 'AbortError') break;   // 调用方放弃的不算这几行失败了一次
        breakerFail(core, e);
        markAttempt(core, rows.map((x) => x.id), p.maxAttempts);
        for (const x of rows) skip.add(x.id);
        out.failed += rows.length;
        log(core, 'warn', 'worker.embed.fail', { n: rows.length, error: errKind(e) });
        batches++;
        continue;
      }
      if (r.mismatch) {
        breakerSuccess(core);   // 端口是好的，只是产不出这个空间了
        s.activeUnproducible = true;
        log(core, 'warn', 'worker.space.unproducible', { batch: rows.length });
        autoEnsure(core, false);
        break;
      }
      breakerSuccess(core);
      const ms = performance.now() - t0;
      const per = ms / rows.length;
      s.msPerText = s.msPerText == null ? per : s.msPerText * 0.8 + per * 0.2;
      // 嵌的时候文本又变了、行被删了、或者活动空间换了（中间 await 过）：这条向量作废，留给下一轮
      const stale = [];
      const updatedAt = core.now();
      core.store.tx((db) => {
        for (const row of r.rows) {
          const c = db.run(`UPDATE embed_texts SET status = 'done', space_id = ?, attempts = 0, updated_at = ? WHERE id = ? AND hash = ?
                              AND EXISTS (SELECT 1 FROM vector_spaces WHERE space_id = ? AND status = 'active')`,
          active.space_id, updatedAt, row.id, row.hash, active.space_id);
          if (!Number(c.changes)) stale.push(row.id);
        }
      });
      if (stale.length) {
        for (const part of chunked(stale, 500)) core.vectors.run(`DELETE FROM vectors WHERE space_id = ? AND embed_text_id IN (${placeholders(part.length)})`, active.space_id, ...part);
      }
      const staleSet = new Set(stale);
      const pub = r.published.filter((x) => !staleSet.has(x.id));
      if (pub.length) publish(core, 'add', { spaceId: active.space_id, rows: pub });
      if (r.bad.length) { markAttempt(core, r.bad, p.maxAttempts); for (const id of r.bad) skip.add(id); out.failed += r.bad.length; }
      out.embedded += r.rows.length - stale.length;
      // 影子空间：新写入两边都嵌（§8.9）。失败不要紧，影子重嵌会补上
      if (shadow && r.rows.length) {
        try {
          const sr = await embedInto(core, shadow, r.rows, { priority: 3, signal: opt.signal });
          if (sr.ok && sr.published.length) publish(core, 'add', { spaceId: shadow.space_id, rows: sr.published });
        } catch { /* 影子空间的双写失败不影响活动空间 */ }
      }
      batches++;
    }
    // 活动空间的队列空了（或者活动空间已经产不出来）：推进影子重嵌
    if (shadow && batches < maxBatches && !opt.signal?.aborted && !breakerOpenNow(core)) {
      const left = maxBatches - batches;
      const shadowBatches = opt.night || s.activeUnproducible ? left : Math.min(left, p.shadowDayBatches);
      // 这个影子空间正在别处重嵌（夜间整理第 9 步直接调的那一轮）：不再并排跑一轮，免得同一批行嵌两遍、游标被往回写
      if (shadowBatches > 0 && !s.shadowRunning.has(shadow.space_id)) {
        const pending = s.activeUnproducible ? 0 : Number(core.store.get("SELECT count(*) AS n FROM embed_texts WHERE status IN ('pending','stale') AND priority <= ?", maxPriority)?.n ?? 0);
        if (pending === 0) await shadowExclusive(core, { spaceId: shadow.space_id, maxBatches: shadowBatches, signal: opt.signal, batchSize });
      }
    }
    if (out.embedded) metric(core, 'embed.doc', out.embedded);
    if (out.failed) metric(core, 'embed.doc.failed', out.failed);
    return out;
  } catch (e) {
    log(core, 'warn', 'worker.queue.error', { error: errKind(e) });
    return out;
  } finally {
    breakerRelease(core, gate);   // 拿了探测权却一次都没调端口（调过的话成功 / 失败已经结束了探测）
  }
}

/**
 * 没有活动空间时要不要在队列里重试 ensureSpace：从来没建过空间就每次都试（第一次装好、端口刚恢复）；
 * 有过空间（可疑、端口不可用）就隔 worker.reprobeMs 再试一次，不要每分钟都重嵌 20 条探针句子。
 */
function shouldRetryNoActive(core) {
  const s = st(core);
  try { if (!core.store.get('SELECT 1 AS x FROM vector_spaces LIMIT 1')) return true; } catch { return false; }
  const now = core.now();
  if (s.noActiveEnsureAt != null && now - s.noActiveEnsureAt < params(core).worker.reprobeMs) return false;
  s.noActiveEnsureAt = now;
  return true;
}

function flushCounters(core) {
  const c = st(core).counters;
  if (c.query) { metric(core, 'embed.query', c.query); c.query = 0; }
  if (c.queryFail) { metric(core, 'embed.query.failed', c.queryFail); c.queryFail = 0; }
  // failed = timeout + error（和以前的口径一样）；分开记才看得出是「慢」还是「坏」（实测问题 #1）
  for (const [k, name] of [['queryTimeout', 'embed.query.timeout'], ['queryError', 'embed.query.error'], ['queryLate', 'embed.query.late'],
    ['queryCached', 'embed.query.cached'], ['queryUnavailable', 'embed.query.unavailable'], ['queryRetry', 'embed.query.retry'], ['queryRetryOk', 'embed.query.retryOk']]) {
    if (c[k]) { metric(core, name, c[k]); c[k] = 0; }
  }
}

/**
 * 换档的影子重嵌（§8.6.1、§8.9）：新空间 status='shadow'，按 cursor 限速重嵌全部 embed_texts；期间召回用旧空间，新写入两边都嵌。
 * 已经有这个空间、哈希也对得上的向量的行跳过。扫到头时精确核对一遍覆盖率，还没全覆盖（中途有文本变了）就从头再扫一遍。
 * 扫的过程中 coverage 只是进度估计（< 1）；只有扫到头的精确核对才会给出 1。
 * 覆盖到 100% 而旧空间已经产不出来时自动切换；端口还能产旧空间时等评测通过后由 activateSpace 切换。
 * 覆盖率已经是 1、之后嵌入文本又没变过（同一个进程里）就不再整表核对。
 * 同一个空间同一时间只跑一轮（游标、覆盖率只有一个写者）：正在跑（白天嵌入队列顺手推进的那一轮）就等它跑完再接着做自己的
 * maxBatches；等的时候 signal 中止就返回当前的覆盖率。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{spaceId: string, maxBatches?: number, signal?: AbortSignal, batchSize?: number}} opt
 * @returns {Promise<{coverage: number}>}
 */
export async function shadowReembed(core, opt) {
  const s = st(core);
  const id = opt?.spaceId;
  while (s.shadowRunning.has(id) && !opt?.signal?.aborted) await settledOrAborted(s.shadowRunning.get(id), opt?.signal);
  if (opt?.signal?.aborted) {
    try { return { coverage: spaceRow(core, id)?.coverage ?? 0 }; } catch { return { coverage: 0 }; }
  }
  return shadowExclusive(core, opt);
}

/** 跑一轮影子重嵌并登记成这个空间正在跑的那一轮（调用方保证这时没有别的一轮）。 */
function shadowExclusive(core, opt) {
  const s = st(core);
  const id = opt?.spaceId;
  const run = shadowRound(core, opt);   // 同步执行到第一个 await 之前，别人插不进来
  s.shadowRunning.set(id, run);
  const clear = () => { if (s.shadowRunning.get(id) === run) s.shadowRunning.delete(id); };
  run.then(clear, clear);
  return run;
}

/** shadowReembed 的一轮。 */
async function shadowRound(core, opt) {
  const s = st(core);
  const p = params(core);
  let row;
  try { row = spaceRow(core, opt?.spaceId); } catch { return { coverage: 0 }; }
  if (!row) return { coverage: 0 };
  if (row.status !== 'shadow' || core.readOnly || !core.vectors || !core.ports.embedding) return { coverage: row.coverage };
  const last = s.shadowChecked.get(row.space_id);
  if (row.coverage >= 1 && last && (last.epoch === s.embedEpoch || core.now() - last.at < p.worker.coverageRecheckMs)) {
    if (s.activeUnproducible) await activateSpace(core, row.space_id, { force: true });
    return { coverage: row.coverage };
  }
  const info = portInfo(core);
  const batchSize = Math.max(1, opt.batchSize ?? p.batch[info?.device === 'gpu' ? 'gpu' : 'cpu']);
  const maxBatches = opt.maxBatches ?? Infinity;
  let cursor = row.cursor;
  let batches = 0;
  let wrapped = false;
  let exact = null;          // 扫到头时精确核对的结果（之后又嵌过东西就作废）
  let scanned = 0;
  while (batches < maxBatches) {
    if (opt.signal?.aborted || breakerOpenNow(core)) break;
    await yieldToQueries(core, p.queryYieldMaxMs);
    await waitMaint(core);
    const rows = core.store.all('SELECT id, owner_kind, owner_id, chunk_no, kind, layer, text, hash FROM embed_texts WHERE id > ? ORDER BY id LIMIT ?', cursor, batchSize);
    if (!rows.length) {
      const epoch = s.embedEpoch;
      exact = await coverageOf(core, row.space_id);
      if (exact >= 1) { s.shadowChecked.set(row.space_id, { epoch, at: core.now() }); break; }
      if (wrapped) break;
      wrapped = true;
      exact = null;
      cursor = 0;
      continue;
    }
    const have = new Map(core.vectors.all(`SELECT embed_text_id AS id, text_hash FROM vectors WHERE space_id = ? AND embed_text_id IN (${placeholders(rows.length)})`,
      row.space_id, ...rows.map((r) => r.id)).map((r) => [r.id, r.text_hash]));
    const need = rows.filter((r) => have.get(r.id) !== r.hash);
    if (need.length) {
      let r;
      try { r = await embedInto(core, row, need, { priority: 3, signal: opt.signal }); } catch (e) {
        breakerFail(core, e);
        log(core, 'warn', 'worker.shadow.fail', { n: need.length, error: errKind(e) });
        break;
      }
      if (r.mismatch) { breakerSuccess(core); log(core, 'warn', 'worker.shadow.unproducible', {}); break; }
      breakerSuccess(core);
      if (r.published.length) publish(core, 'add', { spaceId: row.space_id, rows: r.published });
      batches++;
    }
    cursor = rows.at(-1).id;
    core.store.run('UPDATE vector_spaces SET cursor = ? WHERE space_id = ?', cursor, row.space_id);
    scanned += rows.length;
    if (scanned >= p.worker.yieldEvery) { scanned = 0; await tickYield(); }   // 整段都已覆盖时别一口气扫完整张表
  }
  const coverage = exact ?? progressOf(core, cursor);
  core.store.run('UPDATE vector_spaces SET coverage = ? WHERE space_id = ?', coverage, row.space_id);
  if (coverage >= 1 && s.activeUnproducible) await activateSpace(core, row.space_id, { force: true });
  return { coverage };
}

/** 扫描中的进度估计：cursor 之前的行数 / 全部行数，封顶 0.999（只有精确核对才给 1）。 */
function progressOf(core, cursor) {
  const total = Number(core.store.get('SELECT count(*) AS n FROM embed_texts')?.n ?? 0);
  if (!total) return 0.999;
  const before = Number(core.store.get('SELECT count(*) AS n FROM embed_texts WHERE id <= ?', cursor)?.n ?? 0);
  return Math.min(0.999, before / total);
}

/**
 * 影子空间的覆盖率（精确）：这个空间里哈希对得上的块 / 全部 embed_texts。
 * 在活动空间里也嵌不出来（failed）的行不拖后腿：只有影子空间嵌出来了才算进分母。分批核对，批与批之间让出事件循环。
 */
async function coverageOf(core, spaceId) {
  let ok = 0;
  let total = 0;
  let after = -1;
  for (;;) {
    const rows = core.store.all('SELECT id, hash, status FROM embed_texts WHERE id > ? ORDER BY id LIMIT 2000', after);
    if (!rows.length) break;
    after = rows.at(-1).id;
    const have = new Map(core.vectors.all(`SELECT embed_text_id AS id, text_hash FROM vectors WHERE space_id = ? AND embed_text_id IN (${placeholders(rows.length)})`,
      spaceId, ...rows.map((r) => r.id)).map((r) => [r.id, r.text_hash]));
    for (const r of rows) {
      const covered = have.get(r.id) === r.hash;
      if (covered) ok++;
      if (covered || r.status !== 'failed') total++;
    }
    await tickYield();
  }
  return total ? ok / total : 1;
}

// ── 查询 ──────────────────────────────────────────────────────────────────
/**
 * 稠密扫描。vectors 是查询向量（1–2 条，每条记忆取较大相似度，§8.1）；只和 spaceId 相同的空间比。超时返回已有结果并标 timedOut。
 * spaceId 不给时用活动空间（伪查询向量来自 storedVectors，它们就在活动空间里）；可疑、退役、不认识的空间一律不查。
 * 记忆层热温层常驻内存，includeCold 时再从磁盘扫冷层；原文层二值常驻、int8 从磁盘取来精排。exclude 是预过滤（记忆引用）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{vectors: Float32Array[], spaceId: string, layers: ('memory'|'raw')[], topK: {memory: number, raw: number},
 *          includeCold: boolean, exclude?: Set<string>}} q
 * @param {{deadlineMs: number, signal?: AbortSignal}} opt
 * @returns {Promise<{hits: Hit[], timedOut: boolean}>}
 */
export async function denseSearch(core, q, opt = { deadlineMs: 800 }) {
  const s = st(core);
  const empty = { hits: [], timedOut: false };
  try {
    if (!core.vectors || s.mode === 'fallback') return empty;   // 降级：稠密路 L3（不在主线程冷加载向量）
    const spaceId = q?.spaceId ?? activeSpaceId(core);
    if (!spaceId) return empty;
    const row = core.store.get('SELECT dim, status FROM vector_spaces WHERE space_id = ?', spaceId);
    if (!row || (row.status !== 'active' && row.status !== 'shadow')) return empty;
    const vectors = (q.vectors ?? []).slice(0, 4).map((v) => fitVector(v, row.dim)).filter(Boolean);
    if (!vectors.length) return empty;
    const p = params(core);
    const layers = (q.layers?.length ? q.layers : ['memory', 'raw']).filter((l) => LAYERS.has(l));
    const args = {
      spaceId, vectors, layers,
      topK: { memory: q.topK?.memory ?? p.dense.memoryTopK, raw: q.topK?.raw ?? p.dense.rawTopK },
      includeCold: !!q.includeCold,
      exclude: q.exclude ? [...q.exclude] : [],
      coarseTopK: p.dense.coarseTopK,
    };
    const r = await call(core, 'search', 'dense', args, { deadlineMs: opt?.deadlineMs ?? p.deadlineMs, signal: opt?.signal });
    if (r.error) { log(core, 'warn', 'worker.dense.error', { error: r.error.code }); return empty; }
    const hits = r.result ? r.result.hits : r.partials.flatMap((x) => x.hits ?? []);
    if (r.timedOut) metric(core, 'worker.dense.timeout');
    return { hits: [...hits].sort((a, b) => b.score - a.score), timedOut: !!r.timedOut };
  } catch (e) {
    log(core, 'warn', 'worker.dense.error', { error: errKind(e) });
    return empty;
  }
}

/**
 * 词法查询：terms 已按 IDF 排好序、≤ 12 个（store.matchQuery 负责安全拼接）；原文分表热路径只查最近 hotMonths 个月。
 * 【D150】weights 可选（和 terms 一一对应，缺省 1）：同一个权重的词一起查，各组的 −bm25 乘权重后按行相加。
 * tables 是 FTS 表名：'episodes_fts'、'assertions_fts'、登记过的原文分表 'percepts_fts_YYYYMM'；
 * 也可以写别名 HOT_SHARDS（'percepts_fts'，最近 recall.lexical.hotMonths 个月的分表）/ ALL_SHARDS（'percepts_fts_all'，全部）。
 * 不认识的表名直接丢掉。命中的 ref：情节 'e'、事实 'a'、原文感知 'p'；score = −bm25。
 * 降级（线程起不来）时在主线程查，词数、条数、分表数都按 recall.lexical.fallback 收小。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{terms: string[], weights?: number[], tables: string[], limit: number}} q
 * @param {{deadlineMs: number, signal?: AbortSignal}} opt
 * @returns {Promise<{hits: Hit[], timedOut: boolean}>}
 */
export async function lexicalSearch(core, q, opt = { deadlineMs: 800 }) {
  const s = st(core);
  const empty = { hits: [], timedOut: false };
  try {
    const p = params(core);
    const fb = s.mode === 'fallback';
    const pairs = (q?.terms ?? []).map((t, i) => [t, Array.isArray(q.weights) ? Number(q.weights[i] ?? 1) : 1])
      .filter(([t, w]) => typeof t === 'string' && w > 0 && Number.isFinite(w));
    const terms = pairs.map(([t]) => t);
    const weights = pairs.map(([, w]) => w);
    if (!terms.length) return empty;
    const limit = Math.max(1, Math.min(q.limit ?? p.lexical.topK, fb ? p.lexical.fallback.limit : Infinity));
    const args = {
      terms: fb ? terms.slice(0, p.lexical.fallback.maxTerms) : terms,
      weights: fb ? weights.slice(0, p.lexical.fallback.maxTerms) : weights,
      maxTerms: fb ? p.lexical.fallback.maxTerms : p.lexical.maxTerms,
      tables: q.tables ?? [],
      limit,
      hotMonths: fb ? p.lexical.fallback.hotMonths : p.lexical.hotMonths,
      maxShards: fb ? p.lexical.fallback.hotMonths : null,
    };
    const r = await call(core, 'db', 'lexical', args, { deadlineMs: opt?.deadlineMs ?? p.deadlineMs, signal: opt?.signal });
    if (r.error) { log(core, 'warn', 'worker.lexical.error', { error: r.error.code }); return empty; }
    if (r.result) return { hits: r.result.hits.map(({ ref, score }) => ({ ref, score })), timedOut: !!r.result.timedOut };
    const best = new Map();
    for (const h of r.partials.flatMap((x) => x.hits ?? [])) { const o = best.get(h.ref); if (!o || h.score > o.score) best.set(h.ref, { ref: h.ref, score: h.score }); }
    metric(core, 'worker.lexical.timeout');
    return { hits: [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit), timedOut: true };
  } catch (e) {
    log(core, 'warn', 'worker.lexical.error', { error: errKind(e) });
    return empty;
  }
}

/**
 * 词的 IDF（给词法路挑词——排序、二元组的凝聚度、跳过一半以上行里都有的词，D150；给 lang.distinctiveTerms 用）。用 fts5vocab 或缓存的统计。
 * IDF = ln(1 + (N − n + 0.5) / (n + 0.5))（N 是情节、事实、原文三类 FTS 行的总数，n 是含这个词的行数）；rowFraction = n / N。
 * 【补】docs = n、rows = N 一起给：库还小的时候比例说明不了什么（N < 100 时出现一次就超过 1%），调用方要看绝对条数
 * （词法路的常见词门槛、lang.distinctiveTerms 的「只在一条文字里出现过」）；docs = 0 的词哪一行都匹配不上。
 * 键是传进来的原词（内部按 store.normalizeToken 规范化后去查）；规范化后为空的词 rowFraction = 1（docs、rows 不给）。
 * 统计拿不到（线程超时、库读不了）的词不在结果里（调用方当作「不知道」）。结果按 worker.termStatsTtlMs 缓存。
 * 【补】opt.excludePercepts：这些感知（词法路的线索窗口，眼前这段对话）不算进统计——只在问题里出现过的词 docs 是 0，
 * 不再因为问题本身被入库就占词法路的名额。缓存里存的是不排除的原始数；排除每次现算（窗口每轮都变），
 * 只减掉统计时就已经在库里的那几条（id 不超过统计那一刻库里最大的感知 id：单写者、同步事务，那之前的都已提交、都被数到了），
 * 缓存比感知旧时不会多减。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} terms
 * @param {{excludePercepts?: number[]}} [opt]
 * @returns {Promise<Map<string, {idf: number, rowFraction: number, docs?: number, rows?: number}>>}
 */
export async function termStats(core, terms, opt = {}) {
  const s = st(core);
  const out = new Map();
  try {
    const p = params(core);
    const now = core.now();
    const list = [...new Set((terms ?? []).filter((t) => typeof t === 'string'))];
    const exclude = [...new Set((opt?.excludePercepts ?? []).filter((x) => Number.isSafeInteger(x) && x > 0))];
    // 这一刻库里最大的感知 id：这次新数的词，id 不超过它的感知都已经数进去了
    const maxPid = Number(core.store.get('SELECT max(id) AS m FROM percepts')?.m ?? 0);
    const missing = new Set();
    const cached = new Map();
    for (const t of list) {
      const n = normalizeToken(t);
      if (!n) { out.set(t, { idf: 0, rowFraction: 1 }); continue; }
      const c = s.termCache.get(n);
      // 库里还没有的词只按行数缓存的时长记（countTtlMs）：新词一出现，词法路很快就能用上它（retrieve 把 docs = 0 的词往后排）
      const ttl = c?.docs === 0 ? Math.min(p.worker.termStatsTtlMs, p.worker.countTtlMs) : p.worker.termStatsTtlMs;
      if (c && now - c.at <= ttl) cached.set(n, c);
      else missing.add(n);
    }
    // 要排除时：缓存里 docs > 0 的词也要问一次「窗口里哪几条含它」（docs = 0 的减不下去，不用问）
    const recheck = exclude.length ? [...cached].filter(([, c]) => c.docs > 0).map(([n]) => n) : [];
    let excluded = null;
    if (missing.size || recheck.length) {
      const r = await call(core, 'db', 'termCounts', {
        terms: [...new Set([...missing, ...recheck])], countTtlMs: p.worker.countTtlMs, ...(exclude.length ? { excludePercepts: exclude } : {}),
      }, { deadlineMs: 5000 });
      if (r.result) {
        const { N, docs } = r.result;
        for (const n of missing) {
          const d = Math.min(N, Number(docs[n] ?? 0));
          const stat = { idf: idfOf(N, d), rowFraction: N > 0 ? d / N : 0, docs: d, rows: N };
          s.termCache.set(n, { ...stat, at: now, maxPid });
          cached.set(n, s.termCache.get(n));
        }
        if (s.termCache.size > 50_000) { for (const k of [...s.termCache.keys()].slice(0, 10_000)) s.termCache.delete(k); }
        excluded = r.result.excluded ?? null;
      } else if (r.error) log(core, 'debug', 'worker.termStats.error', { error: r.error.code });
    }
    for (const t of list) {
      const n = normalizeToken(t);
      const c = n ? cached.get(n) : null;
      if (!c) continue;
      if (!excluded) { out.set(t, statOf(c)); continue; }
      // 只减统计那一刻已经在库里的（id ≤ 那时的最大感知 id）
      const counted = (id) => id <= (c.maxPid ?? 0);
      const hits = (excluded[n] ?? []).filter(counted).length;
      const d = Math.max(0, (c.docs ?? 0) - hits);
      const N = Math.max(d, (c.rows ?? 0) - exclude.filter(counted).length);
      out.set(t, { idf: idfOf(N, d), rowFraction: N > 0 ? d / N : 0, docs: d, rows: N });
    }
  } catch (e) {
    log(core, 'warn', 'worker.termStats.error', { error: errKind(e) });
  }
  return out;
}
const statOf = (c) => ({ idf: c.idf, rowFraction: c.rowFraction, docs: c.docs, rows: c.rows });
const idfOf = (N, d) => Math.log(1 + (N - d + 0.5) / (d + 0.5));

/**
 * 局部推送式个性化 PageRank（「实体—事实—情节」图，只在种子的几跳邻域里算，评审:FE-14）。
 * 图的节点：实体、事实、情节、印象、意图、故事线、社区；边：事实的主体 / 对象 / 提到的人 / 说话人、情节的参与者、
 * 事实和它来源所在的情节、关系描述的锚点、实体链接、取代链、同类事、意图指向的事和人（graph.js）。命中不含种子本身。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{seeds: {entityId: number, weight: number}[], maxHops: number, limit: number}} q
 * @param {{deadlineMs: number, signal?: AbortSignal}} opt
 * @returns {Promise<{hits: Hit[], timedOut: boolean}>}
 */
export async function pprSearch(core, q, opt = { deadlineMs: 800 }) {
  const s = st(core);
  const empty = { hits: [], timedOut: false };
  try {
    if (!q?.seeds?.length) return empty;
    const p = params(core);
    const scale = s.mode === 'fallback' ? p.ppr.fallbackScale : 1;
    const args = {
      seeds: q.seeds.map((x) => ({ entityId: Number(x?.entityId), weight: Number(x?.weight) })),
      maxHops: Math.max(1, Math.floor(q.maxHops ?? p.maxHops)),
      limit: Math.max(1, q.limit ?? p.pprLimit),
      includeSeeds: !!q.includeSeeds,
      alpha: p.ppr.alpha, eps: p.ppr.eps, fanCap: p.ppr.fanCap, weights: p.ppr.weights,
      maxPushes: Math.max(100, Math.floor(p.ppr.maxPushes * scale)), maxExpand: Math.max(50, Math.floor(p.ppr.maxExpand * scale)),
    };
    const r = await call(core, 'db', 'ppr', args, { deadlineMs: opt?.deadlineMs ?? p.deadlineMs, signal: opt?.signal });
    if (r.error) { log(core, 'warn', 'worker.ppr.error', { error: r.error.code }); return empty; }
    if (!r.result) { metric(core, 'worker.ppr.timeout'); return { hits: [], timedOut: true }; }
    return { hits: r.result.hits, timedOut: !!r.result.timedOut };
  } catch (e) {
    log(core, 'warn', 'worker.ppr.error', { error: errKind(e) });
    return empty;
  }
}

/**
 * 已经存好的向量（L3 的伪查询向量用：取词法和实体路前 3 条的向量去记忆层找近邻，§8.8）。
 * 向量来自活动空间（activeSpaceId）：记忆层取第一个正文块的 f32，原文窗口层用 int8 还原；没有向量的引用不在结果里。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} refs
 * @returns {Promise<Map<string, Float32Array>>}
 */
export async function storedVectors(core, refs) {
  const out = new Map();
  try {
    const spaceId = activeSpaceId(core);
    const list = [...new Set((refs ?? []).filter((r) => parseRef(r)))].slice(0, 200);
    if (!spaceId || !core.vectors || !list.length) return out;
    const r = await call(core, 'db', 'stored', { refs: list, spaceId }, { deadlineMs: 3000 });
    for (const [ref, v] of r.result ?? []) out.set(ref, v instanceof Float32Array ? v : new Float32Array(v));
  } catch (e) {
    log(core, 'warn', 'worker.stored.error', { error: errKind(e) });
  }
  return out;
}

// ── 维护 ──────────────────────────────────────────────────────────────────
/**
 * 运维（§7.7 第 10 步，全部在 worker 里）：'quick-check' / 'integrity-check' 跑在 file 指定的**副本**上，不碰正在用的库；
 * 'fts-merge' 每次小步合并（merge=200,8），期间主线程暂停写入；'vacuum' 是 incremental_vacuum(pages)。
 * 每个任务起一个临时线程（用完就退，不占 search / db 线程）；线程起不来时只有本地模式（测试）才在主线程里做。
 * 「暂停写入」指本模块自己的嵌入队列在任务期间不写库；FTS 合并每步只做 pages 页的工作，主线程别的写入最多等一步。
 * vacuum 的 file 给了向量库的路径就整理向量库，否则整理主库。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: 'quick-check'|'integrity-check'|'fts-merge'|'vacuum', file?: string, pages?: number}} task
 * @returns {Promise<{ok: boolean, detail?: string}>}
 */
export async function maintenance(core, task) {
  const s = st(core);
  const p = params(core);
  try {
    const kind = task?.kind;
    if (!['quick-check', 'integrity-check', 'fts-merge', 'vacuum'].includes(kind)) return { ok: false, detail: 'unknown-task' };
    const live = [core.store?.file, core.vectors?.file].filter((f) => f && f !== ':memory:').map((f) => path.resolve(f).toLowerCase());
    const full = {
      kind, ftsMerge: p.worker.ftsMerge, vacuumPages: p.worker.vacuumPages, busyMs: p.worker.busyMs, pages: task.pages ?? p.worker.vacuumPages,
      file: task.file ? path.resolve(task.file) : undefined, target: undefined,
    };
    if (kind === 'quick-check' || kind === 'integrity-check') {
      if (!full.file) return { ok: false, detail: 'missing-file' };
      if (live.includes(full.file.toLowerCase())) return { ok: false, detail: 'live-db' };   // 完整性检查只跑在副本上
    } else {
      if (core.readOnly) return { ok: false, detail: 'read-only' };
      const vecFile = core.vectors?.file ? path.resolve(core.vectors.file) : null;
      full.target = kind === 'vacuum' && full.file && vecFile && full.file.toLowerCase() === vecFile.toLowerCase() ? vecFile : (core.store?.file ? path.resolve(core.store.file) : null);
      if (!full.target || full.target === ':memory:') return { ok: false, detail: 'memory-db' };
    }
    const writes = kind === 'fts-merge' || kind === 'vacuum';
    let release = () => {};
    if (writes) {
      while (s.maintGate) await s.maintGate.catch(() => {});
      s.maintGate = new Promise((res) => { release = res; });
    }
    try {
      const result = await runMaintThread(core, full, p.worker.maintTimeoutMs);
      if (result) { metric(core, `worker.maint.${kind}.${result.ok ? 'ok' : 'fail'}`); return result; }
      if (s.mode !== 'local') return { ok: false, detail: 'no-worker' };
      return runTask(DatabaseSync, full);   // 本地模式（测试）：线程起不来就在这里做
    } finally {
      if (writes) { s.maintGate = null; release(); }
    }
  } catch (e) {
    log(core, 'warn', 'worker.maint.error', { kind: task?.kind ?? null, error: errKind(e) });
    return { ok: false, detail: errKind(e) };
  }
}

/** 起一个临时线程跑运维任务；线程起不来返回 null。 */
async function runMaintThread(core, task, timeoutMs) {
  let t;
  try {
    t = new ThreadClient({ role: 'maint', workerData: { task } });
  } catch { return null; }
  t.worker.ref();
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, detail: 'timeout' }), timeoutMs); });
    const r = await Promise.race([t.ready.then((x) => x ?? { ok: false, detail: 'no-result' }, () => null), timeout]);
    return r;
  } finally {
    clearTimeout(timer);
    await t.terminate();
  }
}

/**
 * 向量缓存清扫（§12.8）：store.sweepVectorCache 的包装，启动时和恢复备份后调用。
 * 先清主库这边：主表里已经没有的记忆、原文已过期的窗口、墓碑里的记忆（只认墓碑之前就有的嵌入文本：
 * 主表的 id 会被新记忆重新用上，新记忆的嵌入不能跟着删），它们的 embed_texts 和向量一起删；
 * 标 done 却不是活动空间的行改回 stale（换空间时和嵌入队列撞上的极少数情况）；
 * 再清向量库：属主对不上的（恢复备份后 embed_texts 的 id 被重新用了）、没有、文本变了 → 删；活动空间标 done 却没有向量 → 改回 pending；
 * 最后删掉不认识的空间、退役（或可疑）超过 embedding.oldSpaceKeepDays 天的旧空间的向量（vector_spaces 的行留着当历史）。
 * 删了向量就让索引整体重建。全程分批、可以中断、可以重跑。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{removed: number, requeued: number}}
 */
export function sweepVectors(core) {
  if (core.readOnly || !core.store || core.store.closed) return { removed: 0, requeued: 0 };
  try {
    return sweepInner(core);
  } catch (e) {
    // 向量库是缓存：清扫失败不影响别的（下次启动再扫），只记类型和计数
    log(core, 'warn', 'worker.sweep.error', { error: errKind(e) });
    metric(core, 'worker.sweep.error');
    return { removed: 0, requeued: 0 };
  }
}

function sweepInner(core) {
  const p = params(core);
  const orphans = findOrphans(core);
  let removed = 0;
  let requeued = 0;
  if (orphans.length) removed += dropEmbeddings(core, orphans).vectors;
  const active = activeSpaceId(core);
  requeued += requeueForeignDone(core, active);
  if (!core.vectors) return { removed, requeued };
  let indexDirty = removed > 0;
  const mismatched = removeMismatchedVectors(core);
  const r = sweepVectorCache(core.store, core.vectors, { activeSpaceId: active });
  removed += mismatched + r.removed;
  requeued += r.requeued;
  indexDirty ||= mismatched + r.removed > 0;
  try {
    const known = new Map(core.store.all('SELECT space_id, status, retired_at FROM vector_spaces').map((x) => [x.space_id, x]));
    const cutoff = core.now() - p.oldSpaceKeepMs;
    for (const { space_id: sid } of core.vectors.all('SELECT DISTINCT space_id FROM vectors')) {
      const sp = known.get(sid);
      const expired = sp && (sp.status === 'retired' || sp.status === 'suspect') && sp.retired_at != null && sp.retired_at <= cutoff;
      if (sp && !expired) continue;
      removed += Number(core.vectors.run('DELETE FROM vectors WHERE space_id = ?', sid).changes);
      publish(core, 'unloadSpace', { spaceId: sid });
    }
  } catch (e) { log(core, 'warn', 'worker.sweep.spaces.error', { error: errKind(e) }); }
  if (indexDirty) publish(core, 'reload', {});
  if (removed || requeued) {
    st(core).embedEpoch += 1;
    log(core, 'info', 'worker.sweep', { removed, requeued, orphans: orphans.length, mismatched });
  }
  return { removed, requeued };
}

/** 主库这边的孤儿：按 embed_texts 分批，主表没有这条记忆、窗口原文已过期、墓碑之前就有的嵌入文本。 */
function findOrphans(core) {
  const out = new Map();
  const add = (kind, id) => out.set(refOf(kind, id), { kind, id });
  let hasTombstones = true;
  try { core.store.get('SELECT 1 AS x FROM tombstones LIMIT 1'); } catch { hasTombstones = false; }
  let after = -1;
  for (;;) {
    const rows = core.store.all('SELECT id, owner_kind, owner_id, created_at FROM embed_texts WHERE id > ? ORDER BY id LIMIT 2000', after);
    if (!rows.length) break;
    after = rows.at(-1).id;
    const byKind = new Map();
    for (const r of rows) {
      if (!byKind.has(r.owner_kind)) byKind.set(r.owner_kind, new Set());
      byKind.get(r.owner_kind).add(r.owner_id);
    }
    for (const [kind, idSet] of byKind) {
      const table = OWNER_TABLES[kind];
      const ids = [...idSet];
      try {
        const cols = kind === 'window' ? 'id, text IS NULL AS expired' : 'id, 0 AS expired';
        const live = new Map(core.store.all(`SELECT ${cols} FROM ${table} WHERE id IN (${placeholders(ids.length)})`, ...ids).map((x) => [x.id, !!x.expired]));
        for (const id of ids) if (!live.has(id) || live.get(id)) add(kind, id);
      } catch { /* 主表读不了：这批不按主表判断 */ }
    }
    if (hasTombstones) {
      const refs = [...new Set(rows.map((r) => refOf(r.owner_kind, r.owner_id)))];
      const tomb = new Map(core.store.all(`SELECT kind, ref, at FROM tombstones WHERE ref IN (${placeholders(refs.length)})`, ...refs)
        .map((t) => [`${t.kind}|${t.ref}`, t.at]));
      if (tomb.size) {
        for (const r of rows) {
          const at = tomb.get(`${r.owner_kind}|${refOf(r.owner_kind, r.owner_id)}`);
          if (at != null && r.created_at <= at) add(r.owner_kind, r.owner_id);
        }
      }
    }
  }
  return [...out.values()];
}

/** 标 done 却不在活动空间里的行 → stale（分批）。没有活动空间时不动。 */
function requeueForeignDone(core, active) {
  if (!active) return 0;
  let n = 0;
  const now = core.now();
  for (;;) {
    const c = Number(core.store.run(`UPDATE embed_texts SET status = 'stale', updated_at = ? WHERE id IN (
      SELECT id FROM embed_texts WHERE status = 'done' AND (space_id IS NULL OR space_id <> ?) LIMIT 2000)`, now, active).changes);
    n += c;
    if (c < 2000) break;
  }
  return n;
}

/**
 * 向量库里属主（owner_kind、owner_id、层、块号、kind）和 embed_texts 对不上的行删掉：恢复备份后 embed_texts 的 id 会被重新用上，
 * 文本碰巧一样时哈希也一样，光比哈希会让旧向量顶着新记忆的引用被搜出来。按空间走主键分批。
 */
function removeMismatchedVectors(core) {
  let n = 0;
  let spacesInVec = [];
  try { spacesInVec = core.vectors.all('SELECT DISTINCT space_id FROM vectors').map((x) => x.space_id); } catch { return 0; }
  for (const sid of spacesInVec) {
    let after = -1;
    for (;;) {
      const rows = core.vectors.all(`SELECT embed_text_id AS id, owner_kind, owner_id, chunk_no, kind, layer FROM vectors
                                     WHERE space_id = ? AND embed_text_id > ? ORDER BY embed_text_id LIMIT 2000`, sid, after);
      if (!rows.length) break;
      after = rows.at(-1).id;
      const et = new Map(core.store.all(`SELECT id, owner_kind, owner_id, chunk_no, kind, layer FROM embed_texts WHERE id IN (${placeholders(rows.length)})`,
        ...rows.map((r) => r.id)).map((r) => [r.id, r]));
      const bad = rows.filter((v) => {
        const e = et.get(v.id);
        return e && (e.owner_kind !== v.owner_kind || e.owner_id !== v.owner_id || e.chunk_no !== v.chunk_no || e.kind !== v.kind || e.layer !== v.layer);
      }).map((v) => v.id);
      if (bad.length) {
        n += Number(core.vectors.run(`DELETE FROM vectors WHERE space_id = ? AND embed_text_id IN (${placeholders(bad.length)})`, sid, ...bad).changes);
      }
    }
  }
  return n;
}

/**
 * 按 activation.tier 重新决定内存里放哪些（§6.8、§7.7 第 9 步）：夜里 dynamics.retier 之后调用，在 worker 线程里整体重建索引。
 * @param {import('../core-types.js').CoreContext} core
 */
export function reloadIndex(core) {
  publish(core, 'reload', {});
}

/**
 * 嵌入和检索的健康状况（管理页总览、retrieve 的降级级别用）。只有数字和状态。
 * @param {import('../core-types.js').CoreContext} core
 * readOnlyThreads：线程里的连接是不是真的只读（§13.2「worker 能打开只读连接」）；没起线程时为 null。
 * query：进程启动以来查询嵌入的结果按原因计数（ok / cached / timeout / late / error / unavailable）和最近一次的原因、耗时、错误类型；
 * probe：最近一次启动探针（设备、平均余弦、是不是跨设备比的、过没过）。
 * @returns {{mode: 'local'|'thread'|'fallback', reason: string|null, dense: boolean, breakerOpen: boolean, activeSpace: string|null,
 *            activeUnproducible: boolean, shadow: {spaceId: string, coverage: number}|null, queue: Record<string, number>, device: string|null,
 *            readOnlyThreads: boolean|null, query: object, probe: object|null}}
 */
export function health(core) {
  const s = st(core);
  let queue = {};
  let shadow = null;
  let active = null;
  try {
    queue = Object.fromEntries(core.store.all('SELECT status, count(*) AS n FROM embed_texts GROUP BY status').map((r) => [r.status, r.n]));
    const sh = shadowRow(core);
    shadow = sh ? { spaceId: sh.space_id, coverage: sh.coverage } : null;
    active = activeSpaceId(core);
  } catch { /* 库读不了 */ }
  const breakerOpen = s.breaker.openUntil > core.now();
  return {
    mode: s.mode, reason: s.reason,
    dense: !!core.vectors && s.mode !== 'fallback' && !!active && !breakerOpen && !s.activeUnproducible,
    breakerOpen, activeSpace: active, activeUnproducible: s.activeUnproducible, shadow, queue,
    device: portInfo(core)?.device ?? null,
    readOnlyThreads: s.threadInfo ? !!(s.threadInfo.search?.readOnly && s.threadInfo.db?.readOnly) : null,
    query: { ...s.queryStats, cacheSize: s.queryCache.size, inflight: s.queryInflight.size },
    probe: s.lastProbe ? { ...s.lastProbe } : null,
  };
}
