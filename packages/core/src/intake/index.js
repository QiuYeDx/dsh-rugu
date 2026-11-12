// intake 模块（§7.1、§5.3、§4.5 observe / describe / sealBuffers / expectRelay、§12.8 第 1 条）：感知入库。
//   同步入队、不调 LLM、不抛错；在 setImmediate 里批量处理：校验 → 清洗 → 去重和注意力升级 → 撤回 / 编辑 / 转达 →
//   确定性认说话人 → 场合快照和出现集合 → 感知行 + FTS 词元 + 适配器游标在同一个事务里提交 → 原文窗口 → 通知预取。
// 拥有的表：settings、setting_snapshots、percepts、percepts_fts_YYYYMM（经 store.ensurePerceptShard）、raw_windows、relays。
//   cursors 表归 store，但适配器游标只由 intake 在感知的事务里推进。
// 用到的端口：clock、sanitizer、logger。
// 契约细节：docs/实现/模块与接口.md §4.2。
//
// 失败的分寸（§7.1「任何错误都不往外抛」、§12.8）：
//   - 一批一个事务（含游标）。事务边界出错（崩溃、磁盘满）→ 感知和游标都没写，这一批留在队列头上稍后重试，几次都不行才丢；
//   - 每条感知一个保存点：这一条自己的数据让代码出错，只回滚这一条（计数），别的照常入库；存储出错不算这一条的错，整批重试；
//   - 富化步骤（认人、注意力、出现集合、提及）出错只降级（计数、记日志），原话照样入库——原文一定要能被直接检索（评审:AR-05）；
//   - 「别记」规则、墓碑查不了 → 整批不提交（宁可晚点记，也不记下主人不让记的、彻底删掉的）。
//
// 和备份恢复的配合（§12.4.5、§12.7）：
//   - 彻底删除过的消息（admin.tombstonedObs）重投、恢复后从来源补回时不再入库；指向它的撤回 / 编辑、声明是它的副本的
//     （derivedFrom）也不入库，引用它的新消息只留引用、不留它的原话；
//   - 整体恢复期间（backup.isRestoring）什么都不写：感知留在队列里，describe / sealBuffers / expectRelay / observeInternal
//     挂起；换库时（reopen 重新 init）队列接着用，恢复完按到达的先后补上（D27「聊天照常，不写新记忆」）；
//   - 恢复后的补回窗口（backup.replayWindow）里交来的、发生在恢复之前的消息按历史模式入库（historical=1）；
//     有 start() 的适配器重启一次，让它从恢复出来的游标重读快照之后的经历；重启之前排队的批次不再推进游标。
//     没有 start() 的适配器核心叫不动：它的游标先停在恢复出来的位置，等它自己读过一次游标（api.cursor）才接着推进。
import {
  validateObservations, validateObserveOptions, validateSettingDescriptor, validateRelayExpectation, validateIdentityClaim,
  textHash, exposureRank, persistenceRank, reachHash, isOneOnOne, isOpaqueId, sameId, SELF_KINDS, LIMITS, ContractError,
} from '../contract/index.js';
import { ensurePerceptShard, ftsInsert, ftsDelete } from '../store/fts.js';
import { setCursor, getCursor, adapterCursorSource, bumpMetric } from '../store/kv.js';
import { refOf } from '../store/refs.js';
import { DEFAULTS } from '../config/defaults.js';
import { genericForStore, genericForPrompt, cleanLabel, stripInvisible } from './sanitize.js';
import { hashActor, storableDescriptor, descriptorHash, noteKey } from './hash.js';
import { cutGroup, pendingGroups, nextDue, windowsContaining, rebuildWindows, WINDOW_KINDS } from './windows.js';
import { perceive, writeSeen, withSeen, seenOf, SEEN_BY } from './media.js';

/**
 * 一行感知（percepts 表），各模块读它时的形状（列名照表）。
 * @typedef {object} PerceptRow
 * @property {number} id
 * @property {string} adapter
 * @property {string} setting_key
 * @property {string} perceived_in
 * @property {number|null} snapshot_id
 * @property {number|null} presence_set_id
 * @property {'setting-audience'|'her-only'|'participants'} visible_to
 * @property {number} at
 * @property {number|null} actor_entity_id
 * @property {0|1} actor_self
 * @property {string} kind
 * @property {string|null} text
 * @property {string} text_state
 * @property {string} text_hash
 * @property {string} addressed
 * @property {string} attention
 * @property {string} attention_class
 * @property {0|1} evidential
 * @property {string} standing
 * @property {number} w_enc
 * @property {number|null} episode_id
 * @property {string} norm_state
 * @property {number|null} relay_of
 * @property {0|1} historical
 */
/**
 * @typedef {object} DrainReport
 * @property {number} accepted     新写入的感知
 * @property {number} upgraded     已存在、注意力升级的
 * @property {number} duplicates   已存在、没变化的
 * @property {number} rejected     不合契约丢弃的（只计数，§7.1 第 1 步）
 * @property {number} dropped      场合 attending=false、命中「别记」规则等丢弃的
 * @property {number} [failed]     【补】处理出错的（单条回滚；或整批重试几次后丢掉）
 * @property {number} [waiting]    【补】还在等适配器给场合描述的批次
 */

const MIN_MS = 60_000;
/** 撤回、编辑本身也带着原消息的内容或指向它：原消息被彻底删除过，这两种也不入库。 */
const TARGETED_KINDS = Object.freeze(['retract', 'edit']);
/** 「在场」的证据：亲自说话、做事、进出（§8.1「亲自发过言」，评审:PS-13）。 */
const PRESENT_KINDS = Object.freeze(['utterance', 'action', 'presence', 'self-utterance', 'self-action', 'on-my-behalf', 'edit', 'retract']);
const ATTENTION_RANK = { peripheral: 0, attended: 1 };
const ADDRESSED_RANK = { ambient: 0, 'mentions-her': 1, 'to-her': 2, 'by-her': 3 };

/** 回滚这一条感知用（「别记」命中在认人之后才知道，认人时写下的名字证据也要撤掉）。 */
const DROP = Symbol('intake.drop');
/** 整批不提交（「别记」规则查不了）。 */
class BatchAbort extends Error {
  constructor(why) { super(`intake: batch aborted (${why})`); this.code = 'INTAKE_BATCH_ABORT'; }
}

// ── 状态和小工具 ──────────────────────────────────────────────────────────
/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  // 整体恢复换库时 reopen 会重新 init：还没写的队列、挂起的操作、适配器的注册接着用（dispose 时标了 carry）
  const prev = core.state.intake;
  const carry = prev?.carry === true;
  core.state.intake = {
    queues: carry ? prev.queues : new Map(),   // adapterId → 批次（FIFO；同一个适配器按顺序提交，游标才不会跳过没提交的）
    seq: carry ? prev.seq : 0,                 // 批次的到达序号（挂起的操作按它排先后；没有 start() 的适配器重读游标前后按它分）
    scheduled: false,
    immediate: null,
    settingIds: new Map(),      // resolveSetting 的缓存：SettingId → {key, adapter}（只在内存里）
    idByKey: new Map(),         // 【D111】describe 见过的 场合键 → SettingId（只在内存里；管理页问适配器「这里为什么收不到」用）
    describing: new Map(),      // 场合键 → 正在向适配器要描述 {status, at, timer}
    windowTimer: null,
    windowDueAt: null,
    windowsRestored: false,     // 启动后第一次 drain 时，给库里还在等的原文窗口分组定时
    cursorHold: carry ? prev.cursorHold : new Map(),   // adapterId → 丢过批次的游标键（见 holdCursor）
    retryTimer: null,
    held: carry ? prev.held : [],                      // 恢复期间挂起的写操作 {op, …}（按到达顺序，恢复完补上）
    holdTimer: null,
    holding: carry,                                    // 正在等恢复结束（结束后的第一次 drain 记一笔）
    registrations: carry ? prev.registrations : new Map(),   // adapterId → 注册（恢复后重启适配器用）
    carry: false,
    disposed: false,
  };
  // 换库之后接着等：恢复一结束就把队列补上、让适配器从恢复出来的游标重读（这里只排一次 setImmediate，不做别的）
  if (carry) schedule(core);
}
const S = (core) => core.state.intake ?? (init(core), core.state.intake);
// 参数都在 config/defaults.js 的 intake 段；快照里缺键（手搭的测试 core）才用默认值
const cfgIntake = (core) => core.config.get().intake ?? DEFAULTS.intake;
const opt = (core, key) => cfgIntake(core)[key] ?? DEFAULTS.intake[key];
const param = opt;   // 参数名叫 opt 的函数里用它
/** 别的段的参数（快照里缺键时用 defaults.js 的值）。 */
const cfgAt = (core, section, key) => core.config.get()[section]?.[key] ?? DEFAULTS[section][key];
const errCode = (e) => String(e?.code ?? e?.name ?? 'Error').slice(0, 40);
const writable = (core) => !!core.store && !core.store.closed && !core.readOnly;

function metric(core, name, by = 1) {
  try { if (writable(core)) bumpMetric(core.store, name, by, core.now()); } catch { /* 计数失败不影响 */ }
}
function report(core, event, e) {
  try { core.log.warn(event, { error: errCode(e) }); } catch { /* 日志失败不影响 */ }
  metric(core, `${event}.error`);
}
/** 富化步骤：出错只降级。 */
function soft(core, what, fn, fallback) {
  try { return fn(); } catch (e) {
    try { core.log.warn('intake.degraded', { step: what, error: errCode(e) }); } catch { /* 忽略 */ }
    metric(core, `intake.degraded.${what}`);
    return fallback;
  }
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** SQLite / 存储层的错误（node:sqlite 的 ERR_SQLITE_*、带 errcode 的、只读）。 */
const isStorageError = (e) => (typeof e?.code === 'string' && e.code.startsWith('ERR_SQLITE')) || e?.errcode !== undefined
  || e?.name === 'ReadOnlyError';
const uniqInts = (xs) => [...new Set(xs.filter((x) => Number.isInteger(x)))];
const clampInt = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d);
function parseJson(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * 停掉定时器，把队列里剩下的同步处理掉（尽力）。
 * 整体恢复期间（换库前 reopen 会先 dispose）：不往要被换掉的库里写，队列和挂起的操作留给重新 init 之后接着用。
 * @param {import('../core-types.js').CoreContext} core
 */
export function dispose(core) {
  const st = core.state.intake;
  if (!st) return;
  try { if (st.immediate) clearImmediate(st.immediate); } catch { /* 忽略 */ }
  st.immediate = null;
  st.scheduled = false;
  for (const t of [st.windowTimer, st.retryTimer, st.holdTimer]) { try { if (t) clearTimeout(t); } catch { /* 忽略 */ } }
  st.windowTimer = null;
  st.retryTimer = null;
  st.holdTimer = null;
  for (const e of st.describing.values()) { try { if (e.timer) clearTimeout(e.timer); } catch { /* 忽略 */ } }
  if (restoringNow(core)) {
    st.carry = true;   // 不标 disposed：换库的这一小段里 observe 照样入队（setImmediate 里的 drain 会看到还在恢复，接着等）
    return;
  }
  try { if (writable(core) && (st.queues.size || st.held.length)) drain(core); } catch { /* 尽力 */ }
  st.disposed = true;
  st.queues.clear();
  st.held.length = 0;
}

// ── 整体恢复期间（§12.4.5 第 2 步、D27） ──────────────────────────────────
/** 正在整体恢复吗。查不了就当没在恢复（和 api 的回想一样）。 */
function restoringNow(core) {
  try { return !!core.mods.backup.isRestoring(core); } catch { return false; }
}
/** 恢复后的补回窗口（没有在补回、或查不了 → null）。 */
function replayWindowNow(core) {
  const w = soft(core, 'replayWindow', () => core.mods.backup.replayWindow(core), null);
  return w && Number.isFinite(w.until) && Number.isFinite(w.restoredAt) ? w : null;
}
/**
 * 恢复期间挂起一个写操作（恢复完按到达顺序补上）。同一个场合的描述只留最新的一份。
 * 记下挂起时已经到达的最后一批（seq）：在它之前到达的批次都写完了才补这一个，先后和到达时一致。
 * 恢复期间不碰库（计数也不写），超过上限的只记日志丢掉。
 */
function holdOp(core, op) {
  const st = S(core);
  if (op.op === 'describe') {
    const i = st.held.findIndex((h) => h.op === 'describe' && h.adapterId === op.adapterId && sameId(h.descriptor.id, op.descriptor.id));
    if (i >= 0) st.held.splice(i, 1);
  }
  if (st.held.length >= param(core, 'maxQueuedBatches')) {
    try { core.log.warn('intake.restore.heldFull', { op: op.op }); } catch { /* 忽略 */ }
    return;
  }
  st.held.push({ ...op, seq: st.seq });
  schedule(core);
}
/** 挂起的操作里，之前到达的批次都已经写完的那些（按挂起的先后）；从 held 里拿走。 */
function takeReadyHeld(st) {
  let oldest = Infinity;
  for (const q of st.queues.values()) if (q.length && q[0].seq < oldest) oldest = q[0].seq;   // 每个队列 FIFO，队头最早
  const ready = st.held.filter((h) => h.seq < oldest);
  if (ready.length) st.held = st.held.filter((h) => h.seq >= oldest);
  return ready;
}
/**
 * drain 遇到正在恢复：什么都不写，队列里的批次标上「不推进游标」（恢复出来的库里是快照时的游标，适配器要从那里重读），
 * 隔一会儿再看。返回在等的批次数。
 */
function holdForRestore(core) {
  const st = S(core);
  let waiting = 0;
  for (const q of st.queues.values()) {
    for (const b of q) b.noCursor = true;
    waiting += q.length;
  }
  if (!st.holding) {
    st.holding = true;
    try { core.log.info('intake.restore.holding', { batches: waiting, ops: st.held.length }); } catch { /* 忽略 */ }
  }
  if (!st.holdTimer && !st.disposed) {
    st.holdTimer = setTimeout(() => { st.holdTimer = null; schedule(core); }, opt(core, 'restorePollMs'));   // 恢复期间隔多久再看一次
    st.holdTimer.unref?.();
  }
  return waiting;
}
/**
 * 恢复结束后的第一次 drain：先补上挂起的场合描述（排着的批次要用），再让适配器从恢复出来的游标重读。
 * 别的挂起操作（检查点、转达预告、她的话）等在它之前到达的批次写完再补（drain 末尾，takeReadyHeld），和到达的先后一致。
 */
function resumeAfterRestore(core) {
  const st = S(core);
  if (st.holding) {
    st.holding = false;
    metric(core, 'intake.restore.resumed');
  }
  if (st.held.some((h) => h.op === 'describe')) {
    applyHeld(core, st.held.filter((h) => h.op === 'describe'));
    st.held = st.held.filter((h) => h.op !== 'describe');
  }
  restartForReplay(core);
}
/** 补上挂起的写操作（各自走原来的函数；一个出错不影响别的）。 */
function applyHeld(core, ops) {
  for (const h of ops) {
    try {
      if (h.op === 'describe') describe(core, h.adapterId, h.descriptor);
      else if (h.op === 'seal') sealBuffers(core, h.settingId);
      else if (h.op === 'sealKey') sealBuffersByKey(core, h.settingKey);
      else if (h.op === 'relay') expectRelay(core, h.relay);
      else if (h.op === 'internal') writeInternal(core, h.p);
    } catch (e) {
      report(core, 'intake.held', e);
    }
  }
}
/**
 * 补回窗口开了（刚恢复完）：有 start() 的适配器各重启一次，让它从恢复出来的游标重读快照之后的经历（§12.4.5 第 6 步）。
 * 每个补回窗口（按恢复时刻）只重启一次；注册时已经在补回窗口里的不重启（它刚从库里的游标开始读）。
 * 没有 start() 的适配器（直接调 api.observe 的）核心叫不动它重读：它的游标先停在恢复出来的位置（resync），
 * 哪个键它读过一次（api.cursor，读到的就是恢复出来的值），读之后交来的批次才接着推进那个键；一直不读的，
 * 这次运行里都不推进，它下次注册时从恢复出来的游标重读（重复的去重）——快照之后的经历照样补得回来。
 */
function restartForReplay(core) {
  const st = S(core);
  if (!st.registrations.size) return;
  const w = replayWindowNow(core);
  if (!w) return;
  for (const reg of st.registrations.values()) {
    if (reg.replayAck === w.restoredAt) continue;
    reg.replayAck = w.restoredAt;
    if (typeof reg.restart !== 'function') {
      reg.resync = { read: new Map() };   // 游标键 → 它读游标时已经到达的最后一批（seq）
      metric(core, 'intake.adapter.replayResync');
      continue;
    }
    st.cursorHold.delete(reg.id);
    try {
      if (reg.restart()) metric(core, 'intake.adapter.replayRestart');
    } catch (e) {
      report(core, 'intake.adapter.restart', e);
    }
  }
}

// ── 适配器 ────────────────────────────────────────────────────────────────
/**
 * 适配器注册（api.registerAdapter 校验过契约、放进 core.adapters 之后调用）：
 *   - selfClaims / principalClaims → entities.registerAdapterClaims；
 *   - 有 start() 就调用 start(sink)，sink = {observe, describe, cursor}（都转到本模块，带上 adapter.id）。
 *   - 【补】整体恢复之后（backup.replayWindow 开了）intake 会把它停掉再 start(sink) 一次，让它从恢复出来的游标重读（§12.4.5 第 6 步）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').PerceptionAdapter} adapter
 * @returns {() => void}   停掉 start() 返回的东西
 */
export function registerAdapter(core, adapter) {
  const st = S(core);
  st.disposed = false;
  st.settingIds.clear();
  st.cursorHold.delete(adapter.id);   // 重新注册的适配器会从游标重读：之前丢掉的批次补得回来
  const claims = (fn) => {
    const list = typeof fn === 'function' ? fn.call(adapter) : [];
    return (Array.isArray(list) ? list : []).map((c) => validateIdentityClaim(c)).filter((r) => r.ok).map((r) => r.value);
  };
  const c = { selfClaims: claims(adapter.selfClaims), principalClaims: claims(adapter.principalClaims) };
  core.store.tx(() => core.mods.entities.registerAdapterClaims(core, adapter.id, c));
  let alive = true;
  let stop = null;
  // 注册时已经在补回窗口里：它马上从库里的游标开始读，不用再为这次恢复重启
  const reg = { id: adapter.id, gen: 0, replayAck: replayWindowNow(core)?.restoredAt ?? null, restart: null, resync: null };
  if (typeof adapter.start === 'function') {
    // 每次 start 一个新的 sink，记着自己是第几代：停掉之后还在路上的回调（比如 stop 之前发出去的读取）交来的批次
    // 照常入库（重复的去重），但带着旧的一代，不推进游标
    const sinkOf = (gen) => Object.freeze({
      observe: (o, ob) => { if (alive) enqueueAs(core, adapter.id, o, { ...(isObj(ob) ? ob : {}), adapter: adapter.id }, gen); },
      describe: (d) => { if (alive) describe(core, adapter.id, d); },
      cursor: (key) => { try { return alive ? cursor(core, adapter.id, key) : null; } catch { return null; } },
    });
    stop = adapter.start(sinkOf(reg.gen));
    // 重启：停掉再 start(新 sink)。之前排队的批次属于上一代（gen），提交时不再推进游标（适配器从库里的游标重读，重复的去重）
    reg.restart = () => {
      if (!alive) return false;
      if (typeof stop === 'function') { try { stop(); } catch { /* 适配器自己的停止出错不影响重启 */ } }
      stop = null;
      reg.gen += 1;
      stop = adapter.start(sinkOf(reg.gen));
      return true;
    };
  }
  st.registrations.set(adapter.id, reg);
  return () => {
    if (!alive) return;
    alive = false;
    const cur = S(core);
    cur.settingIds.clear();
    if (cur.registrations.get(adapter.id) === reg) cur.registrations.delete(adapter.id);
    if (typeof stop === 'function') { try { stop(); } catch { /* 适配器自己的停止出错不影响注销 */ } }
  };
}
/** 这个适配器现在是第几代（重启一次加一）。 */
const genOf = (core, adapterId) => S(core).registrations.get(adapterId)?.gen ?? 0;

/**
 * observe() 的实现：只入队，安排一次 setImmediate(drain)。**同步、不阻塞、不抛错**（坏数据在 drain 里计数丢弃）。
 * adapterId 必填（核心按 HMAC(adapterId, id) 存键）：api.observe 从 opt.adapter 取，start(sink) 的 sink 自动带上；
 * 缺失或不是已注册的适配器 → 整批计数丢弃。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {import('../contract/types.js').Observation[]} observations
 * @param {import('../contract/types.js').ObserveOptions} [opt]
 * @returns {void}
 */
export function enqueue(core, adapterId, observations, opt) {
  enqueueAs(core, adapterId, observations, opt, null);
}
/** enqueue 的实现；gen = 交来这批的 sink 是适配器的第几代（null = 当前这一代，api.observe 直接调的）。 */
function enqueueAs(core, adapterId, observations, opt, gen) {
  try {
    const st = S(core);
    if (st.disposed || core.readOnly) return;
    const n = Array.isArray(observations) ? observations.length : 1;
    if (typeof adapterId !== 'string' || !core.adapters.has(adapterId)) { metric(core, 'intake.dropped.adapter', n); return; }
    if (!Array.isArray(observations)) { metric(core, 'intake.rejected', 1); return; }
    const ov = validateObserveOptions(opt);
    if (!ov.ok) { metric(core, 'intake.rejected', n); return; }
    if (!observations.length && !ov.value.cursor) return;
    let q = st.queues.get(adapterId);
    if (!q) { q = []; st.queues.set(adapterId, q); }
    if (q.length >= param(core, 'maxQueuedBatches')) {
      // 队列积压（存储一直写不进去）：新来的丢掉计数；它的游标键本次运行不再推进，适配器以后从旧游标重读补回
      metric(core, 'intake.dropped.queueFull', n);
      if (ov.value.cursor) holdCursor(core, adapterId, ov.value.cursor.key);
      return;
    }
    st.seq += 1;
    q.push({ adapterId, raw: observations.slice(), valid: null, rejected: 0, opt: ov.value, attempts: 0, seq: st.seq,
      gen: gen ?? genOf(core, adapterId), noCursor: false });
    schedule(core);
  } catch (e) {
    report(core, 'intake.enqueue', e);
  }
}

function schedule(core) {
  const st = S(core);
  if (st.scheduled || st.disposed) return;
  st.scheduled = true;
  st.immediate = setImmediate(() => {
    st.scheduled = false;
    st.immediate = null;
    try { drain(core); } catch (e) { report(core, 'intake.drain', e); }
  });
}
function scheduleRetry(core, attempts) {
  const st = S(core);
  if (st.retryTimer || st.disposed) return;
  st.retryTimer = setTimeout(() => { st.retryTimer = null; schedule(core); }, 1000 * Math.max(1, attempts));
  st.retryTimer.unref?.();
}

// ── drain ─────────────────────────────────────────────────────────────────
/**
 * 立刻处理队列（setImmediate 里调；测试里直接调）。§7.1 的 1–9 步，每批一个事务（含游标，§12.8 第 1 条）。
 * 提交后（store.afterCommit）通知：retrieve.onPercepts（预取）、discretion.onSelfUtterance（她自己的发言）、
 * encode.onPerceptRetracted / onPerceptEdited（撤回 / 编辑）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {DrainReport}
 */
export function drain(core) {
  const out = { accepted: 0, upgraded: 0, duplicates: 0, rejected: 0, dropped: 0, failed: 0, waiting: 0 };
  const st = core.state.intake;
  if (!st || st.disposed) return out;
  // 整体恢复期间：一条都不写（换库的那一段库是关着的），队列留着，隔一会儿再看（§12.4.5 第 2 步、D27）
  if (restoringNow(core)) { out.waiting = holdForRestore(core); return out; }
  if (!writable(core)) return out;
  if (st.holding || st.held.length) resumeAfterRestore(core);
  const touched = new Map();
  // 一次最多占用 drainBudgetMs（回填一大堆历史时不让聊天等）：做不完的让出事件循环，下一个 setImmediate 接着做
  const t0 = performance.now();
  const budget = opt(core, 'drainBudgetMs');
  let yielded = false;
  let done = 0;
  try {
    for (const [adapterId, q] of st.queues) {
      while (q.length) {
        if (done > 0 && performance.now() - t0 > budget) { yielded = true; out.waiting += q.length; break; }
        done += 1;
        const batch = q[0];
        if (!core.adapters.has(adapterId)) {
          for (const b of q) out.dropped += b.valid ? b.valid.length : (b.raw?.length ?? 0);
          metric(core, 'intake.dropped.adapter', q.length);
          q.length = 0;
          break;
        }
        if (prepareBatch(core, batch) === 'wait') { out.waiting += q.length; break; }
        const r = processBatch(core, batch, touched);
        if (r) {
          for (const k of Object.keys(r)) out[k] += r[k];
          q.shift();
          continue;
        }
        batch.attempts += 1;
        if (batch.attempts < opt(core, 'batchMaxAttempts')) { scheduleRetry(core, batch.attempts); out.waiting += q.length; break; }
        // 几次都提交不了：丢掉这一批（游标没推进，适配器下次从旧游标重读就能补回）。
        // 之后同一个游标键就不再往前推（本次运行里只记感知、不动游标），免得后面的批次把游标推过这一段、这段永远补不回来
        out.failed += batch.valid?.length ?? 0;
        metric(core, 'intake.batch.dropped');
        if (batch.opt.cursor) holdCursor(core, adapterId, batch.opt.cursor.key);
        q.shift();
      }
      if (!q.length) st.queues.delete(adapterId);
    }
  } catch (e) {
    report(core, 'intake.drain', e);
  }
  // 恢复期间挂起的其余写操作：在它之前到达的批次都写完了就补（不用等队列整个空下来，补回大量历史时也不一直拖着）
  if (st.held.length) applyHeld(core, takeReadyHeld(st));
  if (yielded) schedule(core);
  if (!st.windowsRestored) {
    // 启动后第一次：库里还有没切进窗口的（上次退出时还在等的），也给它们定个时（缓冲在库里，不在内存里，§12.8 第 2 条）
    st.windowsRestored = true;
    soft(core, 'windowTimer', () => setWindowTimer(core, nextDue(core, pendingGroups(core))), null);
  }
  if (touched.size) soft(core, 'windowTimer', () => armWindowTimer(core, [...touched.values()]), null);
  return out;
}

/** 校验（只做一次）；场合没描述过就向适配器要。返回 'ready' | 'wait'。 */
function prepareBatch(core, batch) {
  if (!batch.valid) {
    const { accepted, rejected } = validateObservations(batch.raw);
    batch.valid = accepted;
    batch.rejected = rejected.length;
    batch.raw = null;
    if (rejected.length) {
      metric(core, 'intake.rejected', rejected.length);
      try { core.log.warn('intake.rejected', { adapter: batch.adapterId, count: rejected.length }); } catch { /* 忽略 */ }
    }
  }
  batch.failedSettings = new Set();
  const seen = new Map();
  let wait = false;
  for (const o of batch.valid) {
    for (const sid of [o.settingId, o.perceivedInSettingId]) {
      if (seen.has(sid)) continue;
      const key = core.keys.settingKey(batch.adapterId, sid);
      let status = settingExists(core, key) ? 'ready' : null;
      if (!status) status = requestDescribe(core, batch.adapterId, sid, key);
      seen.set(sid, status);
      if (status === 'pending') wait = true;
      else if (status === 'failed') batch.failedSettings.add(key);
    }
  }
  return wait ? 'wait' : 'ready';
}

const settingExists = (core, key) => !!core.store.get('SELECT 1 AS x FROM settings WHERE key = ?', key);

/** 向适配器要一个没描述过的场合的描述（drain 遇到时）。返回 'ready' | 'pending' | 'failed'。 */
function requestDescribe(core, adapterId, settingId, key) {
  const st = S(core);
  const ent = st.describing.get(key);
  if (ent) {
    if (ent.status === 'pending') return 'pending';
    if (core.now() - ent.at < opt(core, 'describeRetryMs')) return 'failed';
    st.describing.delete(key);
  }
  const adapter = core.adapters.get(adapterId);
  const fail = () => { st.describing.set(key, { status: 'failed', at: core.now(), timer: null }); metric(core, 'intake.describe.unavailable'); return 'failed'; };
  let r;
  try { r = adapter?.describeSetting?.(settingId); } catch { return fail(); }
  if (r && typeof r.then === 'function') {
    const e = { status: 'pending', at: core.now(), timer: null };
    st.describing.set(key, e);
    const settle = (d) => {
      if (e.status !== 'pending') return;
      try { clearTimeout(e.timer); } catch { /* 忽略 */ }
      if (st.disposed || !writable(core)) return;
      if (d) describe(core, adapterId, d);
      if (settingExists(core, key)) st.describing.delete(key);
      else { e.status = 'failed'; e.at = core.now(); metric(core, 'intake.describe.unavailable'); }
      schedule(core);
    };
    e.timer = setTimeout(() => {
      if (e.status !== 'pending') return;
      e.status = 'failed';
      e.at = core.now();
      metric(core, 'intake.describe.timeout');
      schedule(core);
    }, opt(core, 'describeTimeoutMs'));
    e.timer.unref?.();
    Promise.resolve(r).then(settle, () => settle(null));
    return 'pending';
  }
  if (r) describe(core, adapterId, r);
  return settingExists(core, key) ? 'ready' : fail();
}

/** 一批：一个事务（感知 + FTS + 窗口 + 游标）。成功返回计数；事务边界出错返回 null（什么都没写）。 */
function processBatch(core, batch, touched) {
  const local = { accepted: 0, upgraded: 0, duplicates: 0, rejected: batch.rejected, dropped: 0, failed: 0 };
  const notes = { inserted: [], reprefetch: [], retracted: [], edited: [], groups: new Map() };
  const flags = { tombstoned: 0, replayed: 0, quoteGone: 0 };
  try {
    core.store.tx(() => {
      // 存储键只算一次：墓碑按它查，写入也用它（这一条自己的数据让它出错，只丢这一条）
      const ad = batch.adapterId;
      const keyed = batch.valid.map((o) => {
        try {
          const da = o.derivedFrom ? (o.derivedFrom.adapter ?? ad) : null;
          return {
            o,
            keys: {
              extKey: core.keys.obsKey(ad, o.id),
              targetKey: o.target != null && TARGETED_KINDS.includes(o.kind) ? core.keys.obsKey(ad, o.target) : null,
              derived: da ? { adapter: da, key: core.keys.obsKey(da, o.derivedFrom.obsId) } : null,
              quoteKey: o.quote?.obs != null ? core.keys.obsKey(ad, o.quote.obs) : null,
            },
          };
        } catch (error) { return { o, error }; }
      });
      const tombstoned = tombstoneLookup(core, keyed.flatMap(({ keys: k, error }) => (error ? [] : [
        [ad, k.extKey],
        ...(k.targetKey ? [[ad, k.targetKey]] : []),
        ...(k.quoteKey ? [[ad, k.quoteKey]] : []),
        ...(k.derived ? [[k.derived.adapter, k.derived.key]] : []),
      ])));
      const ctx = batchContext(core, ad, { historical: batch.opt.historical === true, failedSettings: batch.failedSettings, tombstoned });
      for (const { o, keys, error } of keyed) {
        if (error) {
          local.failed += 1;
          report(core, 'intake.observation', error);
          continue;
        }
        let r;
        try {
          r = core.store.tx(() => writeObservation(core, ctx, o, keys));
        } catch (e) {
          if (e === DROP) { local.dropped += 1; continue; }
          // 存储出错（磁盘、I/O、锁）不是这一条的问题：整批不提交，游标不动，稍后重试（§12.8 第 1 条：感知不丢）
          if (e instanceof BatchAbort || isStorageError(e)) throw e;
          // 这一条自己的数据让代码出错：只丢这一条（计数），别让一条坏数据卡住整个适配器
          local.failed += 1;
          report(core, 'intake.observation', e);
          continue;
        }
        local[r.status] += 1;
        if (r.tombstoned) flags.tombstoned += 1;
        if (r.replayed) flags.replayed += 1;
        if (r.quoteGone) flags.quoteGone += 1;
        mergeNotes(notes, r);
      }
      cutTouched(core, notes.groups);
      if (batch.opt.cursor) {
        // 恢复期间排队的、适配器为补回重启之前排队的、没有 start() 的适配器读过恢复出来的游标之前排队的：
        // 游标是恢复前的位置，不能盖掉恢复出来的游标（感知照样入库，重读时去重）
        const key = batch.opt.cursor.key;
        if (batch.noCursor || batch.gen !== genOf(core, ad) || awaitingResync(core, ad, key, batch.seq)) metric(core, 'intake.cursor.stale');
        else if (cursorHeld(core, ad, key)) metric(core, 'intake.cursor.held');
        else setCursor(core.store, adapterCursorSource(ad), key, batch.opt.cursor.value);
      }
      for (const k of ['accepted', 'upgraded', 'duplicates', 'dropped', 'failed']) if (local[k]) metric(core, `intake.${k}`, local[k]);
      if (flags.tombstoned) metric(core, 'intake.dropped.tombstoned', flags.tombstoned);
      if (flags.replayed) metric(core, 'intake.replayed', flags.replayed);
      if (flags.quoteGone) metric(core, 'intake.quote.tombstoned', flags.quoteGone);
      core.store.afterCommit(() => notifyCommitted(core, notes));
    });
  } catch (e) {
    // 事务边界出错（崩溃注入、磁盘满、「别记」查不了）：感知和游标都没写（§12.8 第 1 条）
    report(core, 'intake.batch', e);
    return null;
  }
  for (const [k, g] of notes.groups) touched.set(k, g);
  local.rejected = batch.rejected;
  return local;
}

/** 丢过批次的游标键：本次运行里不再推进（适配器重新注册时清掉，它会从旧游标重读，重复的按去重处理）。 */
function holdCursor(core, adapterId, key) {
  const st = S(core);
  let set = st.cursorHold.get(adapterId);
  if (!set) { set = new Set(); st.cursorHold.set(adapterId, set); }
  set.add(key);
}
const cursorHeld = (core, adapterId, key) => !!S(core).cursorHold.get(adapterId)?.has(key);
/** 恢复之后，没有 start() 的适配器还没读过这个游标键，或者这一批是它读之前到达的（见 restartForReplay）。 */
function awaitingResync(core, adapterId, key, seq) {
  const rs = S(core).registrations.get(adapterId)?.resync;
  if (!rs) return false;
  const readAt = rs.read.get(key);
  return readAt == null || !(seq > readAt);
}

function mergeNotes(notes, r) {
  if (r.inserted) notes.inserted.push(r.inserted);
  if (r.reprefetch) notes.reprefetch.push(r.reprefetch);
  if (r.retracted) notes.retracted.push(...r.retracted);
  if (r.edited) notes.edited.push(...r.edited);
  if (r.group) notes.groups.set(`${r.group[0]}\u0000${r.group[1]}`, r.group);
}

/** 这批碰过的（场合，visible_to）各切一次窗口；每组一个保存点，出错不影响感知入库（下次再切）。 */
function cutTouched(core, groups) {
  for (const [settingKey, visibleTo] of groups.values()) {
    try {
      core.store.tx(() => cutGroup(core, settingKey, visibleTo, { at: core.now() }));
    } catch (e) {
      report(core, 'intake.window', e);
    }
  }
}

function batchContext(core, adapterId, { historical = false, failedSettings = new Set(), tombstoned = () => false } = {}) {
  const settings = new Map();
  // 她自己的实体在批次事务里先拿到（不在某一条的保存点里建：那一条回滚了，缓存的 id 就指向不存在的行了）
  const selfId = soft(core, 'self', () => core.mods.entities.ensureSelf(core), null);
  // 恢复后的补回窗口：这段时间里交来的、发生在恢复之前的消息按历史模式入库（§12.4.5 第 6 步，不冒出过期的「回头问问」）
  const replay = replayWindowNow(core);
  return {
    adapterId,
    historical,
    failedSettings,
    tombstoned,
    replayUntil: replay ? replay.until : null,
    setting(key) {
      if (!settings.has(key)) settings.set(key, settingByKey(core, key));
      return settings.get(key);
    },
    selfId: () => (Number.isInteger(selfId) ? selfId : null),
  };
}

/**
 * 这些（适配器，存储键 percepts.ext_key）里哪些是彻底删除过的消息（admin.tombstonedObs，§12.7）：按适配器各问一次，
 * 返回查询函数 (adapter, key) => boolean。
 * 查不了 → 整批不提交（和「别记」一样：宁可晚点记，也不让删掉的东西回来）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {[string, string][]} pairs
 * @returns {(adapter: string, key: string) => boolean}
 */
function tombstoneLookup(core, pairs) {
  const byAdapter = new Map();
  for (const [a, k] of pairs) {
    let set = byAdapter.get(a);
    if (!set) { set = new Set(); byAdapter.set(a, set); }
    set.add(k);
  }
  const dead = new Map();
  for (const [a, keys] of byAdapter) {
    let r;
    try { r = core.mods.admin.tombstonedObs(core, a, [...keys]); } catch (e) {
      try { core.log.warn('intake.tombstones.unavailable', { error: errCode(e) }); } catch { /* 忽略 */ }
      throw new BatchAbort('tombstones');
    }
    const got = r instanceof Set ? r : new Set(Array.isArray(r) ? r : []);
    if (got.size) dead.set(a, got);
  }
  return (a, k) => !!k && !!dead.get(a)?.has(k);
}

/**
 * 一条 Observation（已过契约校验）。在这一条自己的保存点里。
 * @param {{extKey: string, targetKey: string|null, derived: {adapter: string, key: string}|null, quoteKey: string|null}} keys
 */
function writeObservation(core, ctx, o, keys) {
  const { extKey, targetKey, derived, quoteKey } = keys;
  const dead = (k) => ctx.tombstoned(ctx.adapterId, k);
  // 彻底删除过的消息：平台重投、恢复后从来源补回都不再入库；指向它的撤回 / 编辑也不入库（编辑带着它改过的原话）；
  // 声明是它的副本的（derivedFrom，别处转进来的同一条）也不入库
  if (dead(extKey) || dead(targetKey) || (derived && ctx.tombstoned(derived.adapter, derived.key))) return { status: 'dropped', tombstoned: true };
  if (ctx.failedSettings.has(core.keys.settingKey(ctx.adapterId, o.settingId))
    || ctx.failedSettings.has(core.keys.settingKey(ctx.adapterId, o.perceivedInSettingId))) {
    return { status: 'dropped' };
  }
  const settingKey = core.keys.settingKey(ctx.adapterId, o.settingId);
  const perceivedIn = sameId(o.perceivedInSettingId, o.settingId) ? settingKey : core.keys.settingKey(ctx.adapterId, o.perceivedInSettingId);
  const replayed = ctx.replayUntil != null && o.at < ctx.replayUntil && !(ctx.historical || o.historical === true);
  const r = writeRecord(core, ctx, {
    o,
    settingKey,
    perceivedIn,
    extKey,
    historical: ctx.historical || o.historical === true || replayed,
    // 引用了彻底删除过的消息：这条新消息照常入库，只是不留被引用的原话和它的作者（只留「引用了一条」）
    quoteGone: dead(quoteKey),
    keyOf: (sid) => core.keys.settingKey(ctx.adapterId, sid),
    obsKeyOf: (obsId) => core.keys.obsKey(ctx.adapterId, obsId),
  });
  if (replayed && r.status === 'accepted') r.replayed = true;
  if (r.status === 'accepted' && dead(quoteKey)) r.quoteGone = true;
  return r;
}

/** 「别记」规则（场合、说话人）。查不了 → 整批不提交。 */
function doNotRemember(core, q) {
  try { return !!core.mods.admin.doNotRemember(core, q); } catch (e) {
    try { core.log.warn('intake.doNotRemember.unavailable', { error: errCode(e) }); } catch { /* 忽略 */ }
    throw new BatchAbort('doNotRemember');
  }
}

/**
 * 写入路径（drain 和 observeInternal 共用）：去重 / 升级 → 别记 → 清洗 → 认人 → 注意力 → 撤回 / 编辑 / 转达 → 出现集合 → 行 + FTS。
 * @returns {{status: 'accepted'|'upgraded'|'duplicates'|'dropped', inserted?: number, retracted?: number[], edited?: [number, number][], group?: [string, string]}}
 */
function writeRecord(core, ctx, rec) {
  const store = core.store;
  const { o, settingKey, perceivedIn } = rec;
  const s = ctx.setting(settingKey);
  const sp = perceivedIn === settingKey ? s : ctx.setting(perceivedIn);
  if (!s || !sp) return { status: 'dropped' };
  if (!s.attending || !sp.attending) return { status: 'dropped' };
  if (doNotRemember(core, { settingKey })) return { status: 'dropped' };
  if (perceivedIn !== settingKey && doNotRemember(core, { settingKey: perceivedIn })) return { status: 'dropped' };

  const existing = store.get(`SELECT id, adapter, kind, at, setting_key, addressed, attention, attention_class, w_enc, actor_entity_id, actor_self, forwarded_json
    FROM percepts WHERE adapter = ? AND ext_key = ?`, s.adapter, rec.extKey);
  if (existing) return upgradeExisting(core, ctx, existing, o);

  const origin = { adapter: s.adapter, kind: o.kind };
  const clean = (t) => sanitizeForStore(core, t, origin);
  const text = clean(o.text);
  const media = (o.media ?? []).map((m) => {
    const x = { kind: cleanLabel(m.kind) };
    if (m.summary != null) x.summary = clean(m.summary);
    return x;   // 只留占位和摘要：ref 可能是带令牌的地址或本机路径，不入库
  });

  // 第 5 步：认说话人（确定性的部分）
  const who = soft(core, 'resolveActor', () => core.mods.entities.resolveActor(core, o.actor, { adapterId: s.adapter, settingKey, at: o.at }), null);
  const isSelf = !!who?.isSelf || o.actor?.self === true;
  let actorId = Number.isInteger(who?.entityId) ? who.entityId : null;
  if (isSelf && actorId == null) actorId = ctx.selfId();
  const mentions = [];
  for (const m of o.mentions ?? []) {
    // 提及只是「话里点到了谁」，不给任何权利（D108）：只有名字的提及对上她自己的名字、或这里有管理权限的人，就认成那个人，
    // 不记名字、不新建一个叫她名字的「人」
    const r = soft(core, 'resolveMention', () => core.mods.entities.resolveActor(core, m, { adapterId: s.adapter, settingKey, at: o.at, role: 'mention' }), null);
    mentions.push({ entityId: Number.isInteger(r?.entityId) ? r.entityId : null, self: !!r?.isSelf, actor: hashActor(core, s.adapter, m, clean) });
  }
  const mentionIds = uniqInts(mentions.filter((m) => !m.self).map((m) => m.entityId));
  const involved = uniqInts([actorId, ...mentions.map((m) => m.entityId)]);
  if (involved.length && doNotRemember(core, { entityIds: involved })) throw DROP;

  // 注意力和编码强度（§6.2；还不知道重要度，按 imp 缺省算）
  const selfId = ctx.selfId();
  const herSpokeRecently = herSpoke(core, settingKey, o.at, selfId);
  const ac = soft(core, 'attention', () => core.mods.dynamics.attentionClass(core, { kind: o.kind, addressed: o.addressed, attention: o.attention },
    { herSpokeRecently, opened: o.kind === 'content' && o.attention === 'attended' }), null);
  const closeness = !isSelf && actorId != null ? soft(core, 'bond', () => core.mods.entities.bondOf(core, actorId)?.closeness, undefined) : undefined;
  const wEnc = ac ? soft(core, 'encodingWeight', () => core.mods.dynamics.encodingWeight(core, { wAtt: ac.wAtt, closeness }), 0) : 0;

  // 第 4 步：撤回、编辑、转进来的
  const targetKey = o.target ? rec.obsKeyOf(o.target) : null;
  const targetId = targetKey ? store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', s.adapter, targetKey)?.id ?? null : null;
  const tHash = textHash(o.text);
  let relayOf = null;
  let derived = null;
  if (o.derivedFrom) {
    const da = o.derivedFrom.adapter ?? s.adapter;
    const dk = core.keys.obsKey(da, o.derivedFrom.obsId);
    derived = { adapter: da, obsKey: dk };
    relayOf = store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', da, dk)?.id ?? null;
  }
  const relay = !derived ? matchRelay(core, s.adapter, rec.extKey, tHash, o.perceivedAt) : null;
  if (relay && relayOf == null) relayOf = relay.originalId;

  // 第 6 步：出现集合（按 visibleTo；她私下读到的不加她所在会话的成员，§5.3）
  const presence = presenceFor(core, ctx, rec, s, actorId, isSelf);
  const presenceId = presence ? soft(core, 'presence', () => core.mods.discretion.recordPresence(core, presence), null) : null;

  const lang = o.lang ?? soft(core, 'lang', () => core.mods.lang.registry(core).detect(text), 'und');
  let quote = null;
  if (o.quote) {
    quote = {};
    if (o.quote.obs) {
      quote.obsKey = rec.obsKeyOf(o.quote.obs);
      const qp = store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', s.adapter, quote.obsKey);
      if (qp) quote.perceptId = qp.id;
    }
    if (rec.quoteGone) quote.gone = true;   // 被引用的那条彻底删除过：原话和作者都不留
    else {
      if (o.quote.author) quote.author = hashActor(core, s.adapter, o.quote.author, clean);
      if (o.quote.excerpt != null) quote.excerpt = clean(o.quote.excerpt);
    }
  }
  const forwarded = o.forwarded ? {
    ...(o.forwarded.claimedAuthor ? { claimedAuthor: hashActor(core, s.adapter, o.forwarded.claimedAuthor, clean) } : {}),
    relayedBy: hashActor(core, s.adapter, o.forwarded.relayedBy, clean),
    authorVerified: false,
  } : null;
  // 【D118】转发人认成实体（和说话人一样按账号证据认；认不出就不记）：主人自己转给她的，和来路不明的素材分得开
  const relayId = o.forwarded ? relayEntity(core, s.adapter, o.forwarded.relayedBy, settingKey, o.at) : null;
  if (relayId != null) forwarded.relayedById = relayId;
  const via = o.via ? {
    relayedBy: hashActor(core, s.adapter, o.via.relayedBy, clean),
    ...(o.via.originalSetting ? { originalSettingKey: rec.keyOf(o.via.originalSetting) } : {}),
  } : null;

  // 第 7 步：行 + FTS 词元（同一个事务：入库后原文立刻能被词法路找到）
  const res = store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, snapshot_id, perceived_in, presence_set_id, visible_to, at, perceived_at,
      actor_entity_id, actor_self, actor_json, kind, target_key, target_id, text, text_state, text_truncated, text_hash, lang, media_json, quote_json,
      reply_to_key, mentions_json, addressed, attention, attention_class, evidential, forwarded_json, derived_from_json, derived_key, via_json,
      relay_of, w_enc, standing, session_ref_json, appraisal_token, historical, created_at)
    VALUES (:adapter, :ext, :setting, :snap, :pin, :presence, :vis, :at, :pat, :actor, :self, :actorJson, :kind, :tkey, :tid, :text, 'normal', :trunc,
      :hash, :lang, :media, :quote, :reply, :mentions, :addr, :att, :cls, :evid, :fwd, :derived, :dkey, :via, :relay, :w, :standing, :sref, :token,
      :hist, :now)`, {
    adapter: s.adapter, ext: rec.extKey, setting: settingKey, snap: s.snapshotId, pin: perceivedIn, presence: Number.isInteger(presenceId) ? presenceId : null,
    vis: o.visibleTo, at: o.at, pat: o.perceivedAt, actor: actorId, self: isSelf ? 1 : 0,
    actorJson: JSON.stringify(hashActor(core, s.adapter, o.actor, clean) ?? { claims: [] }),
    kind: o.kind, tkey: targetKey, tid: targetId, text, trunc: o.textTruncated ? 1 : 0, hash: tHash, lang: String(lang).slice(0, 35),
    media: media.length ? JSON.stringify(media) : null, quote: quote ? JSON.stringify(quote) : null,
    reply: o.replyTo ? rec.obsKeyOf(o.replyTo) : null, mentions: mentions.length ? JSON.stringify(mentions) : null,
    addr: o.addressed, att: o.attention, cls: ac?.cls ?? 'unclassified', evid: o.evidential ? 1 : 0,
    fwd: forwarded ? JSON.stringify(forwarded) : null, derived: derived ? JSON.stringify(derived) : null, dkey: derived?.obsKey ?? null,
    via: via ? JSON.stringify(via) : null, relay: relayOf, w: Number.isFinite(wEnc) ? wEnc : 0, standing: o.standing,
    sref: o.sessionRef ? JSON.stringify(o.sessionRef) : null, token: o.appraisalToken ?? null, hist: rec.historical ? 1 : 0, now: core.now(),
  });
  const id = Number(res.lastInsertRowid);
  const shard = ensurePerceptShard(store, o.at);
  const indexed = [text, ...media.map((m) => m.summary ?? ''), quote?.excerpt ?? ''].filter(Boolean).join('\n');
  const toks = soft(core, 'tokens', () => core.mods.lang.indexTokens(core, indexed, { lang, entityIds: involved }), []);
  ftsInsert(store, shard, id, toks);
  store.run('UPDATE percepts SET fts_shard = ? WHERE id = ?', shard, id);
  if (relay) store.run('UPDATE relays SET matched_percept = ? WHERE id = ?', id, relay.id);

  const retracted = [];
  const edited = [];
  // 这一条就是撤回 / 编辑：目标已经在库里
  if (targetId != null) {
    if (o.kind === 'retract' && applyRetract(core, targetId)) retracted.push(targetId);
    if (o.kind === 'edit' && applyEdit(core, targetId)) edited.push([targetId, id]);
  }
  // 后到的原消息：先到的撤回 / 编辑、转达都挂上它
  for (const e of store.all('SELECT id, kind FROM percepts WHERE adapter = ? AND target_key = ? AND target_id IS NULL AND id <> ?', s.adapter, rec.extKey, id)) {
    store.run('UPDATE percepts SET target_id = ? WHERE id = ?', id, e.id);
    if (e.kind === 'retract' && applyRetract(core, id)) retracted.push(id);
    if (e.kind === 'edit' && applyEdit(core, id)) edited.push([id, e.id]);
  }
  store.run('UPDATE percepts SET relay_of = ? WHERE derived_key = ? AND relay_of IS NULL AND id <> ?', id, rec.extKey, id);
  for (const r of store.all('SELECT matched_percept AS p FROM relays WHERE adapter = ? AND obs_key = ? AND matched_percept IS NOT NULL', s.adapter, rec.extKey)) {
    if (r.p !== id) store.run('UPDATE percepts SET relay_of = ? WHERE id = ? AND relay_of IS NULL', id, r.p);
  }

  // 结构化的 @：档案上加「又被提到了一次」（来源 = 说这句话的人，同一来源同一天只算一次，§6.4）
  const sourceKey = actorId != null ? refOf('entity', actorId) : refOf('percept', id);
  for (const eid of mentionIds) {
    soft(core, 'mention', () => core.mods.entities.noteMention(core, eid, { at: o.at, w: Number.isFinite(wEnc) ? wEnc : 0, sourceKey }), null);
  }
  return {
    status: 'accepted',
    inserted: id,
    retracted,
    edited,
    group: WINDOW_KINDS.includes(o.kind) ? [settingKey, o.visibleTo] : null,
  };
}

/** 同一条消息又来了一次：注意力取较高的（升级 = 改 attention / attention_class、w_enc 取较大值，给包含它的原文窗口补一条更强的痕迹）。 */
/**
 * 【D118】转发人（forwarded.relayedBy）→ 实体 id，存进 forwarded_json.relayedById。适配器没给证据（不知道是谁转的）、认不出、出错 → null。
 * 只是「谁转来的」这件事实：作者照旧未经核实（authorVerified:false），转发人不会因此变成内容的说话人。
 */
function relayEntity(core, adapterId, actor, settingKey, at) {
  if (!Array.isArray(actor?.claims) || !actor.claims.length) return null;
  const r = soft(core, 'resolveRelay', () => core.mods.entities.resolveActor(core, actor, { adapterId, settingKey, at, role: 'relay' }), null);
  return Number.isInteger(r?.entityId) && !r.isSelf ? r.entityId : null;
}

function upgradeExisting(core, ctx, ex, o) {
  // 【D118】同一份转发再读一次时才认出是谁转来的（第一次读的时候适配器还不知道）：补上转发人
  if (o.forwarded && ex.forwarded_json) {
    const f = parseJson(ex.forwarded_json, null);
    if (f && !Number.isInteger(f.relayedById)) {
      const relayId = relayEntity(core, ex.adapter, o.forwarded.relayedBy, ex.setting_key, o.at);
      if (relayId != null) {
        const clean = (t) => sanitizeForStore(core, t, { adapter: ex.adapter, kind: ex.kind });
        core.store.run('UPDATE percepts SET forwarded_json = ? WHERE id = ?',
          JSON.stringify({ ...f, relayedBy: hashActor(core, ex.adapter, o.forwarded.relayedBy, clean), relayedById: relayId }), ex.id);
      }
    }
  }
  const attention = (ATTENTION_RANK[o.attention] ?? 0) > (ATTENTION_RANK[ex.attention] ?? 0) ? o.attention : ex.attention;
  const addressed = ex.addressed === 'by-her' || (ADDRESSED_RANK[o.addressed] ?? 0) <= (ADDRESSED_RANK[ex.addressed] ?? 0) ? ex.addressed : o.addressed;
  if (attention === ex.attention && addressed === ex.addressed) return { status: 'duplicates' };
  return applyUpgrade(core, ctx.selfId(), ex, attention, addressed, o.perceivedAt);
}

/**
 * 升级一条已经在库里的感知（同一条消息又来了一次档更高的、第一眼按意思判断出是对她说的，D158）：改 attention / addressed，
 * 注意力档和 w_enc 取较强的，给包含它的原文窗口补一条痕迹；新变成对她说的 / 提到她的，提交后做完整预取（reprefetch）。
 */
function applyUpgrade(core, selfId, ex, attention, addressed, t) {
  const ac = soft(core, 'attention', () => core.mods.dynamics.attentionClass(core, { kind: ex.kind, addressed, attention },
    { herSpokeRecently: herSpoke(core, ex.setting_key, ex.at, selfId), opened: ex.kind === 'content' && attention === 'attended' }), null);
  const closeness = !ex.actor_self && ex.actor_entity_id != null ? soft(core, 'bond', () => core.mods.entities.bondOf(core, ex.actor_entity_id)?.closeness, undefined) : undefined;
  const w = ac ? soft(core, 'encodingWeight', () => core.mods.dynamics.encodingWeight(core, { wAtt: ac.wAtt, closeness }), 0) : 0;
  const stronger = Number.isFinite(w) && w > ex.w_enc;
  core.store.run('UPDATE percepts SET attention = ?, addressed = ?, attention_class = ?, w_enc = ? WHERE id = ?',
    attention, addressed, stronger && ac ? ac.cls : ex.attention_class, stronger ? w : ex.w_enc, ex.id);
  if (stronger) {
    // 感知本身没有 traces 行（§2.2）：又读到一次的痕迹加在包含它的原文窗口上；还没切进窗口的，切的时候按新的 w_enc 算
    for (const win of windowsContaining(core, [ex.id])) {
      soft(core, 'trace', () => core.mods.dynamics.addTrace(core, { kind: 'window', id: win.id }, { t, w, sourceKey: refOf('percept', ex.id), reason: 'reread' }), null);
    }
  }
  // 同一条消息后来被标成对她说的 / @ 她的（唤醒的那条路径交上来的）：要做完整预取（§7.1 第 9 步）
  const nowAddressed = addressed !== ex.addressed && (addressed === 'to-her' || addressed === 'mentions-her');
  return { status: 'upgraded', reprefetch: nowAddressed ? ex.id : null };
}

function applyRetract(core, targetId) {
  const r = core.store.run("UPDATE percepts SET text_state = 'retracted' WHERE id = ? AND text_state IN ('normal','edited')", targetId);
  if (!r.changes) return false;
  // 原话不再展示：包含它的窗口重新渲染（「撤回了一条消息」），向量随后重嵌
  soft(core, 'windowRebuild', () => core.store.tx(() => rebuildWindows(core, [targetId])), null);
  return true;
}
function applyEdit(core, targetId) {
  core.store.run("UPDATE percepts SET text_state = 'edited' WHERE id = ? AND text_state = 'normal'", targetId);
  return true;
}

/** expectRelay 的预告：文本哈希相同、还没过期的（不是原消息自己）。 */
function matchRelay(core, adapter, extKey, tHash, perceivedAt) {
  const rows = core.store.all('SELECT id, adapter, obs_key FROM relays WHERE text_hash = ? AND until >= ? AND matched_percept IS NULL ORDER BY id LIMIT 8', tHash, perceivedAt);
  for (const r of rows) {
    if (r.adapter === adapter && r.obs_key === extKey) continue;
    const orig = core.store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', r.adapter, r.obs_key);
    return { id: r.id, originalId: orig?.id ?? null };
  }
  return null;
}

/** 她最近 activation.participatingWindowMin 分钟在这个场合说过话吗（§6.2「她在参与的对话」）。 */
function herSpoke(core, settingKey, at, selfId) {
  const win = cfgAt(core, 'activation', 'participatingWindowMin') * MIN_MS;
  const row = selfId != null
    ? core.store.get("SELECT 1 AS x FROM percepts WHERE actor_entity_id = ? AND at BETWEEN ? AND ? AND setting_key = ? AND kind IN ('self-utterance','self-action') LIMIT 1", selfId, at - win, at, settingKey)
    : core.store.get("SELECT 1 AS x FROM percepts WHERE setting_key = ? AND actor_self = 1 AND at BETWEEN ? AND ? AND kind IN ('self-utterance','self-action') LIMIT 1", settingKey, at - win, at);
  return !!row;
}

/** 最近 recall.presentSpeakerWindowMin 分钟在这个场合亲自说过话、做过事的人（新的在前）。 */
function recentSpeakers(core, settingKey, at) {
  const win = cfgAt(core, 'recall', 'presentSpeakerWindowMin') * MIN_MS;
  const rows = core.store.all('SELECT actor_entity_id AS e, at, kind FROM percepts WHERE setting_key = ? ORDER BY id DESC LIMIT ?', settingKey, opt(core, 'presenceScanMax'));
  const out = [];
  for (const r of rows) {
    if (r.e == null || !PRESENT_KINDS.includes(r.kind) || r.at > at || r.at < at - win) continue;
    if (!out.includes(r.e)) out.push(r.e);
  }
  return out;
}

/**
 * 这条感知的出现集合（§5.6 第 1 条）：
 *   her-only → 只有她（记在她知道的那个场合）；participants → 对话双方；
 *   setting-audience → 她 + 说话人 + 最近亲自说过话的人；能确定只有两个人的一对一给 exact，否则 recent-speakers / unknown。
 */
function presenceFor(core, ctx, rec, s, actorId, isSelf) {
  const { o } = rec;
  const selfId = ctx.selfId();
  if (o.visibleTo === 'her-only') {
    return selfId != null ? { settingKey: rec.perceivedIn, at: o.at, members: [selfId], completeness: 'exact', unknownObservers: false } : null;
  }
  const recent = recentSpeakers(core, rec.settingKey, o.at);
  // 对话的另一方：这条的说话人；她自己说的，就是最近说过话的别人，再不行就是这个场合里最后一个说过话的别人（一对一的对方是固定的）
  const otherParty = () => (!isSelf && actorId != null ? actorId
    : recent.find((id) => id !== selfId) ?? lastOtherSpeaker(core, rec.settingKey, selfId, o.at));
  if (o.visibleTo === 'participants') {
    const members = uniqInts([selfId, otherParty()]);
    return { settingKey: rec.settingKey, at: o.at, members, completeness: members.length >= 2 ? 'exact' : 'recent-speakers', unknownObservers: false };
  }
  const d = s.descriptor;
  if (d && isOneOnOne(d)) {
    const members = uniqInts([selfId, otherParty()]);
    return { settingKey: rec.settingKey, at: o.at, members, completeness: members.length >= 2 ? 'exact' : 'recent-speakers', unknownObservers: false };
  }
  const speaker = PRESENT_KINDS.includes(o.kind) && actorId != null ? [actorId] : [];
  const members = uniqInts([selfId, ...speaker, ...recent]);
  const completeness = d?.audience?.membersKnown === 'unknown' ? 'unknown' : 'recent-speakers';
  return { settingKey: rec.settingKey, at: o.at, members, completeness, unknownObservers: !!d?.audience?.unknownObservers };
}

/** 这个场合里在 at 之前最后一个亲自说过话、做过事的别人（不限时间）。 */
function lastOtherSpeaker(core, settingKey, selfId, at) {
  const row = core.store.get(`SELECT actor_entity_id AS e FROM percepts WHERE setting_key = ? AND actor_self = 0 AND actor_entity_id IS NOT NULL
    AND at <= ? AND kind IN (${PRESENT_KINDS.map((k) => `'${k}'`).join(',')}) ORDER BY id DESC LIMIT 1`, settingKey, at);
  return row && row.e !== selfId ? row.e : null;
}

/** 提交之后：预取、她自己的发言回流、撤回 / 编辑。每个通知自己兜错。 */
function notifyCommitted(core, notes) {
  const call = (what, fn) => { try { fn(); } catch (e) { report(core, `intake.notify.${what}`, e); } };
  const ids = [...new Set([...notes.inserted, ...notes.reprefetch])];
  if (ids.length) {
    const fresh = new Set(notes.inserted);
    const rows = core.store.all('SELECT * FROM percepts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', JSON.stringify(ids));
    const bySetting = new Map();
    for (const r of rows) {
      // historical 的不预取（retrieve.onPercepts 收到也会跳过，这里直接不通知更省）
      if (!r.historical) {
        let list = bySetting.get(r.setting_key);
        if (!list) { list = []; bySetting.set(r.setting_key, list); }
        list.push(r);
      }
    }
    for (const r of rows) {
      if (!fresh.has(r.id)) continue;   // 升级的那条以前已经对过 told_log 了
      if (r.kind === 'self-utterance' || r.kind === 'on-my-behalf') call('selfUtterance', () => core.mods.discretion.onSelfUtterance(core, r));
    }
    for (const [key, list] of bySetting) call('percepts', () => core.mods.retrieve.onPercepts(core, key, list));
    // 第一眼（D106）：新落库的话按场合排进 discretion 的队列（只看新插入的；升级的那条以前已经排过）
    for (const [key, list] of bySetting) {
      const news = list.filter((r) => fresh.has(r.id));
      if (news.length) call('glance', () => core.mods.discretion.onPercepts(core, key, news));
    }
  }
  for (const id of notes.retracted) call('retracted', () => core.mods.encode.onPerceptRetracted(core, id));
  for (const [oldId, newId] of notes.edited) call('edited', () => core.mods.encode.onPerceptEdited(core, oldId, newId));
}

/**
 * 先把某一条观察落库（回想的焦点还在队列里时，D108）：反复 drain，直到这条落了库、队列空了，或者用掉 2 × drainBudgetMs。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {string} obsId
 * @returns {boolean} 这条已经在库里
 */
export function drainFor(core, adapterId, obsId) {
  try {
    if (!adapterId || !obsId) return false;
    const k = core.keys.obsKey(adapterId, obsId);
    const has = () => !!core.store.get('SELECT 1 AS x FROM percepts WHERE adapter = ? AND ext_key = ?', adapterId, k);
    if (has()) return true;
    const st = S(core);
    const t0 = performance.now();
    const limit = 2 * opt(core, 'drainBudgetMs');
    while (performance.now() - t0 < limit) {
      const pending = [...st.queues.values()].some((q) => q.length);
      if (!pending) break;
      const r = drain(core);
      if (has()) return true;
      if (!r.accepted && !r.upgraded && !r.duplicates && !r.rejected && !r.dropped && !r.failed) break;
    }
    return has();
  } catch (e) {
    report(core, 'intake.drainFor', e);
    return false;
  }
}

// ── 原文窗口的空闲切分 ────────────────────────────────────────────────────
/** 还在等的分组到点了再切（定时器只负责「到点叫一声」，时间判断一律用 core.now()）。 */
function armWindowTimer(core, groups) {
  const st = S(core);
  if (st.disposed) return;
  const stats = [];
  for (const [settingKey, visibleTo] of groups) {
    const g = core.store.get(`SELECT COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at FROM percepts
      WHERE setting_key = ? AND visible_to = ? AND window_id IS NULL AND kind IN (${WINDOW_KINDS.map((k) => `'${k}'`).join(',')})`, settingKey, visibleTo);
    if (g?.n) stats.push(g);
  }
  setWindowTimer(core, nextDue(core, stats));
}
function setWindowTimer(core, due) {
  const st = S(core);
  if (due == null || st.disposed) return;
  if (st.windowTimer && st.windowDueAt != null && st.windowDueAt <= due) return;
  if (st.windowTimer) clearTimeout(st.windowTimer);
  st.windowDueAt = due;
  st.windowTimer = setTimeout(() => {
    st.windowTimer = null;
    st.windowDueAt = null;
    try { flushWindows(core); } catch (e) { report(core, 'intake.window', e); }
  }, Math.max(1000, due - core.now()));
  st.windowTimer.unref?.();
}

/**
 * 【补】把到点的原文窗口切掉（空闲 idleMs、或者凑够 minMsgs 条且最早那条已等了 idleMs）。intake 自己的定时器到点时调用；
 * 集成层的 maintenance.tick 和夜间整理第 1 步（force=true，有几条切几条）也可以调。不抛错。
 * 整体恢复期间不切（不写新记忆）；队列里还有没处理的批次时顺便安排一次 drain（tick 是定时器丢了之后的兜底）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at?: number, force?: boolean, settingKey?: string}} [o]
 * @returns {{windows: number, pending: number}}
 */
export function flushWindows(core, o = {}) {
  const out = { windows: 0, pending: 0 };
  const st = S(core);
  if (st.queues.size || st.held.length) schedule(core);
  if (restoringNow(core) || !writable(core)) return out;
  const at = Number.isFinite(o.at) ? o.at : core.now();
  let groups;
  try { groups = pendingGroups(core); } catch (e) { report(core, 'intake.window', e); return out; }
  if (o.settingKey) groups = groups.filter((g) => g.setting_key === o.settingKey);
  for (const g of groups) {
    try { out.windows += core.store.tx(() => cutGroup(core, g.setting_key, g.visible_to, { at, force: !!o.force })); } catch (e) { report(core, 'intake.window', e); }
  }
  try {
    const left = pendingGroups(core);
    out.pending = left.length;
    setWindowTimer(core, nextDue(core, left));
  } catch (e) { report(core, 'intake.window', e); }
  return out;
}

/**
 * 【补】彻底删除的级联（§2.3，admin.purge 在它的事务里调用）：把这些感知从原文窗口的成员里拿掉，窗口重新渲染；
 * 一个成员都不剩的窗口整个删掉。删之前先让 worker 删掉这些窗口的向量和嵌入文本。不删感知行本身（那是 admin 的级联）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 * @returns {{rebuilt: number, deleted: number}}
 */
export function dropFromWindows(core, perceptIds) {
  const ids = uniqInts(Array.isArray(perceptIds) ? perceptIds : []);
  if (!ids.length) return { rebuilt: 0, deleted: 0 };
  return core.store.tx(() => rebuildWindows(core, ids, { drop: true }));
}

// ── 场合 ──────────────────────────────────────────────────────────────────
/**
 * describe() 的实现：校验描述（contract.validateSettingDescriptor），账号 id 换成哈希，描述变了就存新快照；
 * persistent 的场合确保有 kind=setting 的实体（entities.ensureSettingEntity）；norms.notes 变了就交给
 * discretion.writeSettingRule（source='adapter-notes'，authority 按作者在这个场合的身份：moderates → 'moderator'、
 * 主人 → 'principal'、否则 'none'；没有权限的只能让规矩更严）。attending=false 记下来，之后这个场合的感知丢弃。不抛错。
 * 存下来的描述里 id、parent 是场合键（不存 SettingId 原值），ActorRef 里的账号是哈希。
 * 【补】整体恢复期间先挂起（同一个场合只留最新的），恢复完再写进恢复出来的库。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {import('../contract/types.js').SettingDescriptor} descriptor
 * @returns {void}
 */
export function describe(core, adapterId, descriptor) {
  try {
    const restoring = restoringNow(core);
    if (!restoring && !writable(core)) return;
    const st = S(core);
    if (typeof adapterId !== 'string' || !core.adapters.has(adapterId)) { if (!restoring) metric(core, 'intake.describe.noAdapter'); return; }
    const v = validateSettingDescriptor(descriptor);
    if (!v.ok) {
      if (!restoring) metric(core, 'intake.describe.rejected');
      try { core.log.warn('intake.describe.rejected', { adapter: adapterId, errors: v.errors.length }); } catch { /* 忽略 */ }
      return;
    }
    if (restoring) { holdOp(core, { op: 'describe', adapterId, descriptor: v.value }); return; }
    const d = v.value;
    const clean = (t) => sanitizeForStore(core, t, { adapter: adapterId, kind: 'setting' });
    const stored = storableDescriptor(core, adapterId, d, clean);
    const key = stored.id;
    if (st.idByKey.size > 10_000) st.idByKey.clear();
    st.idByKey.set(key, d.id);
    const hash = descriptorHash(stored);
    const now = core.now();
    // 【D111】名字还是说法、给管理页的提示：存在 settings 的列上，不进快照（hint 绝不进任何提示词）
    const kind = d.labelKind === 'description' ? 'description' : 'name';
    // 真名从哪来（016）：平台上的名字是那里的人起的，关口①按「那里的人知道的事」管它（discretion，§5.8）；说法没有来源
    const origin = kind === 'name' ? (d.labelOrigin === 'platform' ? 'platform' : 'config') : null;
    const hint = d.hint ? (cleanLabel(d.hint).slice(0, 24) || null) : null;
    let isNew = false;
    core.store.tx((db) => {
      const row = db.get(`SELECT s.key, s.entity_id, s.label, s.adapter_label, s.label_kind, s.label_origin, s.owner_label, ss.descriptor_hash, ss.descriptor_json
        FROM settings s LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id WHERE s.key = ?`, key);
      // label_kind 为 NULL：这一行是有 labelKind 之前写的，实体上那时记的 label 名字不知道是不是真名，清掉按现在的重记（只这一次）
      // label_origin 为 NULL 而这次是平台上的名字：016 之前写的，那时平台名记成了 kind 'label'，同样清掉按现在的重记（只这一次）
      const legacy = !!row && (row.label_kind == null || (origin === 'platform' && row.label_origin == null));
      const ensureEntity = () => {
        const eid = soft(core, 'settingEntity', () => core.mods.entities.ensureSettingEntity(core, key,
          { label: stored.label, labelKind: kind, labelOrigin: origin, ownerLabel: row?.owner_label ?? null, resetLabels: legacy, at: now }), null);
        if (Number.isInteger(eid)) db.run('UPDATE settings SET entity_id = ? WHERE key = ?', eid, key);
      };
      const namesStale = !!row && (legacy || row.label_kind !== kind || (row.label_origin ?? null) !== origin || (row.adapter_label ?? row.label) !== stored.label);
      if (row && row.descriptor_hash === hash) {
        db.run('UPDATE settings SET last_seen = ?, label_kind = ?, label_origin = ?, label_hint = ? WHERE key = ?', now, kind, origin, hint, key);
        // 上次没建成（entities 出错）的补上；名字的种类变了（旧行第一次带上 labelKind）也重记
        if (stored.stability === 'persistent' && (row.entity_id == null || namesStale)) ensureEntity();
        return;
      }
      const snap = db.run(`INSERT INTO setting_snapshots(setting_key, at, descriptor_json, descriptor_hash, reach_hash, exposure_rank, persistence_rank, audience_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, key, now, JSON.stringify(stored), hash, reachHash(stored), exposureRank(stored), persistenceRank(stored),
      typeof stored.audience.size === 'number' ? stored.audience.size : null);
      const snapId = Number(snap.lastInsertRowid);
      if (!row) {
        db.run(`INSERT INTO settings(key, adapter, label, adapter_label, label_kind, label_origin, label_hint, stability, parent_key, current_snapshot_id, attending,
          first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, key, adapterId, stored.label, stored.label, kind, origin, hint, stored.stability, stored.parent ?? null, snapId,
        stored.attending ? 1 : 0, now, now);
        isNew = true;
      } else {
        // 生效的称呼：主人起过名字就一直是它（适配器改不了），否则跟着适配器
        db.run(`UPDATE settings SET label = ?, adapter_label = ?, label_kind = ?, label_origin = ?, label_hint = ?, stability = ?, parent_key = ?, current_snapshot_id = ?,
          attending = ?, last_seen = ? WHERE key = ?`, row.owner_label || stored.label, stored.label, kind, origin, hint, stored.stability, stored.parent ?? null, snapId,
        stored.attending ? 1 : 0, now, key);
      }
      // 稳定的场合对应一个 kind=setting 的实体（§5.8）；一次性的场合不建
      if (stored.stability === 'persistent' && (row?.entity_id == null || namesStale)) ensureEntity();
      // 新出现的规矩（群公告、运营说明）当场生效，不等夜里（评审:UV-09）
      const prevNotes = parseJson(row?.descriptor_json)?.norms?.notes ?? [];
      const before = new Set(prevNotes.map(noteKey));
      const rawNotes = d.norms?.notes ?? [];
      (stored.norms?.notes ?? []).forEach((note, i) => {
        if (before.has(noteKey(note))) return;
        const { entityId, authority } = noteAuthority(core, adapterId, key, d, rawNotes[i]?.author, now);
        soft(core, 'settingRule', () => core.mods.discretion.writeSettingRule(core, key, { text: note.text },
          { source: 'adapter-notes', authorEntityId: entityId, authority, at: now }), null);
      });
      // 撤下的规矩（公告里那条没了）：只在适配器这次明确给了 notes 时才算（没给 = 不知道，不是没了）。给了就是完整清单：
      // 按清单问（keep），清单里没有的公告规矩都撤下——不和上一次描述比，中间哪次描述没带 notes 也不会漏撤；
      // 同一段文字换了作者（还在）不算撤下。之后才知道的内容不再受它约束，撤下之前知道的照旧（discretion.withdrawSettingRules）
      if (Array.isArray(d.norms?.notes)) {
        const keep = (stored.norms?.notes ?? []).map((n) => n.text);
        soft(core, 'settingRuleWithdraw', () => core.mods.discretion.withdrawSettingRules(core, key, { source: 'adapter-notes', keep }, { at: now }), 0);
      }
    });
    if (isNew) st.settingIds.clear();
    if (st.queues.size) schedule(core);
  } catch (e) {
    report(core, 'intake.describe', e);
  }
}

/** 规矩作者的权限：主人 → principal；在这个场合管事（moderates）或是这里的主人（isOwner、ownership.owner）→ moderator；否则 none。 */
function noteAuthority(core, adapterId, settingKey, d, author, at) {
  if (!author) return { entityId: null, authority: 'none' };
  const who = soft(core, 'resolveActor', () => core.mods.entities.resolveActor(core, author, { adapterId, settingKey, at }), null);
  const entityId = Number.isInteger(who?.entityId) ? who.entityId : null;
  if (who?.isPrincipal) return { entityId, authority: 'principal' };
  const role = (author.claims ?? []).find((c) => c.kind === 'role-in-setting' && sameId(c.setting, d.id));
  if (role && (role.moderates || role.isOwner)) return { entityId, authority: 'moderator' };
  if (entityId != null && isObj(d.ownership.owner)) {
    const owner = soft(core, 'resolveActor', () => core.mods.entities.resolveActor(core, d.ownership.owner, { adapterId, settingKey, at }), null);
    if (owner?.entityId === entityId) return { entityId, authority: 'moderator' };
  }
  return { entityId, authority: 'none' };
}

/**
 * sealBuffers() 的实现：只记检查点（settings.checkpoint_percept = 这个场合最新的感知 id），不切断情节（§7.2、评审:SC-23）。不抛错。
 * 【补】也接受场合键（context.compaction 手里只有场合键）；只有场合键时用 sealBuffersByKey 更明确。整体恢复期间先挂起。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingId
 */
export function sealBuffers(core, settingId) {
  try {
    if (!isOpaqueId(settingId)) return;
    if (restoringNow(core)) { holdOp(core, { op: 'seal', settingId }); return; }
    if (!writable(core)) return;
    const key = settingExists(core, settingId) ? settingId : resolveSetting(core, settingId)?.key;
    if (!key) { metric(core, 'intake.seal.unknown'); return; }
    checkpoint(core, key);
  } catch (e) {
    report(core, 'intake.seal', e);
  }
}

/**
 * 【补】sealBuffers 的场合键版本：DSH 重启后会话还没重新绑定时，context.compaction 只有场合键
 * （SettingId 只放内存、不落库，§12.3）。同样只记检查点、不切断情节；整体恢复期间先挂起。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {void}
 */
export function sealBuffersByKey(core, settingKey) {
  try {
    if (typeof settingKey !== 'string' || !settingKey) return;
    if (restoringNow(core)) { holdOp(core, { op: 'sealKey', settingKey }); return; }
    if (!writable(core)) return;
    if (!settingExists(core, settingKey)) { metric(core, 'intake.seal.unknown'); return; }
    checkpoint(core, settingKey);
  } catch (e) {
    report(core, 'intake.seal', e);
  }
}
/** 检查点 = 这个场合现在最新的感知 id（§7.2「压缩不封口」）。 */
function checkpoint(core, key) {
  core.store.run('UPDATE settings SET checkpoint_percept = (SELECT MAX(id) FROM percepts WHERE setting_key = ?) WHERE key = ?', key, key);
}

/**
 * expectRelay() 的实现：存进 relays；之后 until 之前到达、文本哈希相同的感知标 relay_of（不作为新的事实来源）。不抛错。
 * 转进来的那条已经先到了（预告晚了一步）的，也在这里补上。整体恢复期间先挂起。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').RelayExpectation} relay
 */
export function expectRelay(core, relay) {
  try {
    const restoring = restoringNow(core);
    if (!restoring && !writable(core)) return;
    const v = validateRelayExpectation(relay);
    if (!v.ok) { if (!restoring) metric(core, 'intake.relay.rejected'); return; }
    if (restoring) { holdOp(core, { op: 'relay', relay: v.value }); return; }
    const { adapter, obsId, textHash: th, until } = v.value;
    const obsKey = core.keys.obsKey(adapter, obsId);
    const now = core.now();
    core.store.tx((db) => {
      db.run('DELETE FROM relays WHERE until < ?', now - opt(core, 'relayKeepMs'));
      const res = db.run('INSERT INTO relays(adapter, obs_key, text_hash, until, created_at) VALUES (?, ?, ?, ?, ?)', adapter, obsKey, th, until, now);
      const relayId = Number(res.lastInsertRowid);
      const orig = db.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', adapter, obsKey);
      const copies = db.all('SELECT id, adapter, ext_key, perceived_at FROM percepts WHERE text_hash = ? AND at >= ? AND relay_of IS NULL ORDER BY id DESC LIMIT 8',
        th, now - opt(core, 'relayLookbackMs'));
      const copy = copies.find((c) => !(c.adapter === adapter && c.ext_key === obsKey) && c.id !== orig?.id && c.perceived_at <= until);
      if (copy) {
        db.run('UPDATE relays SET matched_percept = ? WHERE id = ?', copy.id, relayId);
        if (orig) db.run('UPDATE percepts SET relay_of = ? WHERE id = ?', orig.id, copy.id);
      }
    });
  } catch (e) {
    report(core, 'intake.relay', e);
  }
}

/**
 * 读回适配器自己上次提交的游标（cursors 表，source = store.adapterCursorSource(adapterId)）。
 * 【补】整体恢复之后，没有 start() 的适配器读一次游标 = 它知道了恢复出来的位置：这之后交来的批次才接着推进这个键
 * （见 restartForReplay）。恢复还没结束时读到的不算（库可能还没换完）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {string} key
 * @returns {string|null}
 */
export function cursor(core, adapterId, key) {
  if (typeof adapterId !== 'string' || typeof key !== 'string' || !core.store || core.store.closed) return null;
  const v = getCursor(core.store, adapterCursorSource(adapterId), key);
  const st = core.state.intake;
  const rs = st?.registrations.get(adapterId)?.resync;
  if (rs && !restoringNow(core)) rs.read.set(key, st.seq);
  return v;
}

/**
 * SettingId（不透明）→ 场合键。API 的 resident(settingId)、recall({settingId}) 没带 adapterId，所以按已注册的每个适配器算一遍
 * keys.settingKey(adapter, settingId)，看哪个在 settings 表里；两个适配器都有同一个 SettingId → 返回 null 并报警（fail closed）。
 * 结果缓存在 state.intake.settingIds。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingId
 * @returns {{key: string, adapter: string}|null}
 */
export function resolveSetting(core, settingId) {
  if (!isOpaqueId(settingId) || !core.store || core.store.closed) return null;
  const st = S(core);
  const hit = st.settingIds.get(settingId);
  if (hit && core.adapters.has(hit.adapter)) return hit;
  const found = [];
  for (const adapterId of core.adapters.keys()) {
    const key = core.keys.settingKey(adapterId, settingId);
    if (settingExists(core, key)) found.push({ key, adapter: adapterId });
  }
  if (found.length === 1) {
    if (st.settingIds.size > 10_000) st.settingIds.clear();
    st.settingIds.set(settingId, found[0]);
    return found[0];
  }
  if (found.length > 1) {
    try { core.log.warn('intake.setting.collision', { adapters: found.length }); } catch { /* 忽略 */ }
    metric(core, 'intake.setting.collision');
  }
  return null;
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {import('../core-types.js').SettingRecord|null}  【补】另有 attending、checkpointPercept、firstSeen、lastSeen
 */
export function settingByKey(core, settingKey) {
  if (typeof settingKey !== 'string' || !core.store || core.store.closed) return null;
  const r = core.store.get(`SELECT s.*, ss.descriptor_json, ss.exposure_rank, ss.persistence_rank, ss.reach_hash FROM settings s
    LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id WHERE s.key = ?`, settingKey);
  if (!r) return null;
  return {
    key: r.key,
    adapter: r.adapter,
    label: r.label,
    ...labelFields(r),
    stability: r.stability,
    parentKey: r.parent_key ?? null,
    entityId: r.entity_id ?? null,
    snapshotId: r.current_snapshot_id ?? null,
    descriptor: parseJson(r.descriptor_json),
    exposureRank: r.exposure_rank ?? 0,
    persistenceRank: r.persistence_rank ?? 1,
    reachHash: r.reach_hash ?? '',
    attending: r.attending === 1,
    checkpointPercept: r.checkpoint_percept ?? null,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

/**
 * 【D111】一行 settings 的名字字段：生效的称呼是不是真名（主人起的一定是）、从哪来、适配器给的那个、管理页的提示。
 * @param {any} r   settings 的一行
 * labelOrigin：适配器给的真名从哪来（'config' / 'platform'；说法、旧行是 null）。主人起了名字时生效的是主人的，这一项只说适配器那份。
 * @returns {{labelKind: 'name'|'description', labelSource: 'owner'|'adapter', labelOrigin: 'config'|'platform'|null, adapterLabel: string, ownerLabel: string|null, hint: string|null}}
 */
function labelFields(r) {
  const owner = typeof r?.owner_label === 'string' && r.owner_label ? r.owner_label : null;
  return {
    labelKind: owner ? 'name' : r?.label_kind === 'description' ? 'description' : 'name',
    labelSource: owner ? 'owner' : 'adapter',
    labelOrigin: r?.label_origin === 'platform' || r?.label_origin === 'config' ? r.label_origin : null,
    adapterLabel: r?.adapter_label ?? r?.label ?? '',
    ownerLabel: owner,
    hint: r?.label_hint ?? null,
  };
}

/**
 * 【D111】主人在管理页给场合起名字（label = null / 空串：清掉，退回适配器给的）。存在 settings.owner_label，适配器之后的描述改不了它；
 * settings.label（她心里、提示词、管理页都读它）当场换掉；场合实体上记成 kind 'owner' 的名字、换显示名；清掉时旧名字不再当名字认。
 * 名字和适配器给的一模一样也照存（主人确认过的名字，适配器以后换了也不跟着换）。返回改完的 SettingRecord；不认识的场合返回 null。
 * 给了字却清洗成空的（只有不可见字符）、超过 LIMITS.settingNameMax 个字：抛 ContractError，不当成「清掉」（评审：别悄悄清掉主人的名字）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {string|null} label
 * @param {{at?: number}} [opt]
 * @returns {import('../core-types.js').SettingRecord|null}
 */
export function renameSetting(core, settingKey, label, opt = {}) {
  if (typeof settingKey !== 'string' || !settingKey) return null;
  const at = Number.isFinite(opt.at) ? opt.at : core.now();
  let next = null;
  if (typeof label === 'string' && label.trim()) {
    const t = cleanLabel(sanitizeForStore(core, label, { adapter: '', kind: 'setting' })).replace(/\s+/g, ' ').trim();
    if (!t) throw new ContractError('admin.renameSetting', [{ path: 'label', message: '名字里没有能显示的字' }]);
    if ([...t].length > LIMITS.settingNameMax) throw new ContractError('admin.renameSetting', [{ path: 'label', message: `名字不超过 ${LIMITS.settingNameMax} 个字` }]);
    next = t;
  }
  let found = false;
  core.store.tx((db) => {
    const row = db.get('SELECT key, label, adapter_label, label_kind, label_origin, owner_label, stability, entity_id FROM settings WHERE key = ?', settingKey);
    if (!row) return;
    found = true;
    const adapterLabel = row.adapter_label ?? row.label;
    if ((row.owner_label ?? null) === next) return;
    db.run('UPDATE settings SET owner_label = ?, owner_label_at = ?, label = ? WHERE key = ?', next, next ? at : null, next ?? adapterLabel, settingKey);
    if (row.stability !== 'persistent') return;
    const eid = soft(core, 'settingEntity', () => core.mods.entities.ensureSettingEntity(core, settingKey, {
      label: adapterLabel, labelKind: row.label_kind === 'description' ? 'description' : 'name', labelOrigin: row.label_origin ?? null, ownerLabel: next,
      dropOwner: row.owner_label ?? null, at,
    }), null);
    if (Number.isInteger(eid) && row.entity_id !== eid) db.run('UPDATE settings SET entity_id = ? WHERE key = ?', eid, settingKey);
  });
  if (!found) return null;
  metric(core, next ? 'intake.setting.renamed' : 'intake.setting.renameCleared');
  return settingByKey(core, settingKey);
}

/**
 * 【D111】管理页用：这个场合的入口在管理页上叫什么（适配器的 displayName）、入口现在有没有接着、入口说这里为什么可能收不到东西
 * （适配器的 quietReason，只问这个进程里描述过的场合）。只给管理页，不进任何提示词。不认识的场合返回 null。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @returns {{adapter: string, adapterName: string|null, connected: boolean, quiet: string|null}|null}
 */
export function adapterInfo(core, settingKey) {
  if (typeof settingKey !== 'string' || !core.store || core.store.closed) return null;
  const r = core.store.get('SELECT adapter FROM settings WHERE key = ?', settingKey);
  if (!r) return null;
  const a = core.adapters.get(r.adapter);
  const name = typeof a?.displayName === 'string' && a.displayName.trim() ? a.displayName.trim().slice(0, 40) : null;
  let quiet = null;
  const sid = S(core).idByKey.get(settingKey);
  if (a && sid && typeof a.quietReason === 'function') {
    try {
      const q = a.quietReason(sid);
      if (typeof q === 'string' && q.trim()) quiet = q.trim().slice(0, 200);
    } catch { metric(core, 'intake.quietReason.error'); }
  }
  return { adapter: r.adapter, adapterName: name, connected: !!a, quiet };
}

/**
 * 某一份历史快照（来源指向当时的快照）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} snapshotId
 * @returns {{id: number, settingKey: string, at: number, descriptor: import('../contract/types.js').SettingDescriptor,
 *            exposureRank: number, persistenceRank: number, reachHash: string, audienceSize: number|null}|null}
 */
export function snapshotById(core, snapshotId) {
  if (!Number.isInteger(snapshotId) || !core.store || core.store.closed) return null;
  const r = core.store.get('SELECT * FROM setting_snapshots WHERE id = ?', snapshotId);
  if (!r) return null;
  return {
    id: r.id, settingKey: r.setting_key, at: r.at, descriptor: parseJson(r.descriptor_json),
    exposureRank: r.exposure_rank, persistenceRank: r.persistence_rank, reachHash: r.reach_hash, audienceSize: r.audience_size ?? null,
  };
}

// ── 核心自己生成的感知 ────────────────────────────────────────────────────
/**
 * 核心自己生成的感知（不经适配器）：outcome(token,'sent') 时生成她在不回流的渠道里说过的话（§5.6、§9.5）。
 * 走和 drain 一样的写入路径（FTS、窗口、通知），adapter = 场合的 adapter，ext_key = keys.hash('core', origin.dedupeKey)。
 * 必须在调用方的事务之外调用（自己开事务）。
 * 【补】整体恢复期间先挂起、恢复完再写（这次返回 0；写的时候照常通知 discretion.onSelfUtterance，按令牌对上）；
 * 同一个 dedupeKey 被彻底删除过的不再写（返回 0）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, kind: 'self-utterance'|'self-action'|'self-thought', text: string, at: number,
 *          visibleTo: 'setting-audience'|'her-only'|'participants', appraisalToken?: string, dedupeKey: string}} p
 * @returns {number} 感知 id（已存在就返回已有的；场合不记（attending=false、「别记」、彻底删除过）或恢复期间挂起时返回 0）
 */
export function observeInternal(core, p) {
  if (!p || typeof p.settingKey !== 'string' || typeof p.dedupeKey !== 'string' || !p.dedupeKey) throw new TypeError('intake.observeInternal：settingKey、dedupeKey 必填');
  if (!['self-utterance', 'self-action', 'self-thought'].includes(p.kind)) throw new TypeError('intake.observeInternal：kind 只能是她自己的感知');
  if (typeof p.text !== 'string' || p.text.length > LIMITS.textMax) throw new TypeError('intake.observeInternal：text 不合法');
  if (!Number.isFinite(p.at)) throw new TypeError('intake.observeInternal：at 不合法');
  if (restoringNow(core)) {
    holdOp(core, { op: 'internal', p: { ...p } });
    return 0;
  }
  if (!writable(core)) throw new Error('intake.observeInternal：库不可写');
  return writeInternal(core, p);
}

/** observeInternal 的写入部分（参数已经校验过；恢复完补上挂起的也走这里）。 */
function writeInternal(core, p) {
  const s = settingByKey(core, p.settingKey);
  if (!s) throw new Error('intake.observeInternal：没有这个场合');
  const extKey = core.keys.hash('core', p.dedupeKey);
  const prior = core.store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', s.adapter, extKey);
  if (prior) return prior.id;
  const visibleTo = p.kind === 'self-thought' ? 'her-only' : (['setting-audience', 'her-only', 'participants'].includes(p.visibleTo) ? p.visibleTo : 'her-only');
  /** @type {any} */
  const o = {
    kind: p.kind, text: p.text, at: p.at, perceivedAt: p.at, visibleTo,
    actor: { self: true, claims: [] }, addressed: 'by-her', attention: 'attended', evidential: true, standing: 'first-hand',
    appraisalToken: typeof p.appraisalToken === 'string' && p.appraisalToken ? p.appraisalToken.slice(0, 512) : undefined,
  };
  const notes = { inserted: [], reprefetch: [], retracted: [], edited: [], groups: new Map() };
  let r;
  core.store.tx(() => {
    // 她说过、后来被彻底删除的那句（同一个 dedupeKey）不再写回来
    if (tombstoneLookup(core, [[s.adapter, extKey]])(s.adapter, extKey)) {
      r = { status: 'dropped' };
      metric(core, 'intake.dropped.tombstoned');
      return;
    }
    const ctx = batchContext(core, s.adapter);
    try {
      r = core.store.tx(() => writeRecord(core, ctx, {
        o, settingKey: s.key, perceivedIn: s.key, extKey, historical: false,
        keyOf: () => s.key, obsKeyOf: (x) => core.keys.hash('core', x),
      }));
    } catch (e) {
      if (e === DROP) { r = { status: 'dropped' }; return; }
      throw e;
    }
    mergeNotes(notes, r);
    cutTouched(core, notes.groups);
    core.store.afterCommit(() => notifyCommitted(core, notes));
  });
  if (notes.groups.size) soft(core, 'windowTimer', () => armWindowTimer(core, [...notes.groups.values()]), null);
  if (r?.status === 'accepted') return r.inserted;
  if (r?.status === 'duplicates' || r?.status === 'upgraded') return core.store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', s.adapter, extKey)?.id ?? 0;
  return 0;
}

/**
 * 【D158】按意思抬高一句话的 addressed（第一眼判断出它是对她说的 / 对包括她在内的大家说的）。只从 ambient 往上抬：结构上已经是
 * 对她说的（@、引用、一对一）、她自己说的、回填的都不动，也从不降低。走和「同一条消息又来了一次、档更高」同一条路（applyUpgrade）：
 * 注意力档和编码权重跟着变，提交后按「现在是对她说的了」通知 retrieve 做完整预取；工作记忆、回想里「被直接问到」的判断读的都是
 * 这一列，自然跟上。恢复期间、只读时不抬。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} perceptId
 * @param {'to-her'|'mentions-her'} addressed
 * @returns {boolean} 抬了
 */
export function raiseAddressed(core, perceptId, addressed) {
  if (addressed !== 'to-her' && addressed !== 'mentions-her') return false;
  if (!Number.isSafeInteger(perceptId) || !writable(core) || restoringNow(core)) return false;
  const notes = { inserted: [], reprefetch: [], retracted: [], edited: [], groups: new Map() };
  let raised = false;
  core.store.tx(() => {
    const ex = core.store.get('SELECT * FROM percepts WHERE id = ?', perceptId);
    if (!ex || ex.actor_self || ex.historical || ex.addressed !== 'ambient') return;
    const selfId = core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null;
    const r = applyUpgrade(core, selfId, ex, ex.attention, addressed, core.now());
    raised = true;
    mergeNotes(notes, r);
    metric(core, 'intake.addressed.raised');
    core.store.afterCommit(() => notifyCommitted(core, notes));
  });
  return raised;
}

// ── encode 在批次事务里调的两个写函数 ─────────────────────────────────────
/**
 * 把感知归进情节（encode 在提炼批次的事务里调用；只改 episode_id）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 * @param {number} episodeId
 */
export function assignEpisode(core, perceptIds, episodeId) {
  const ids = uniqInts(Array.isArray(perceptIds) ? perceptIds : []);
  if (!ids.length) return;
  if (!Number.isInteger(episodeId) || episodeId <= 0) throw new TypeError('intake.assignEpisode：episodeId 应为正整数');
  core.store.run('UPDATE percepts SET episode_id = ? WHERE id IN (SELECT value FROM json_each(?))', episodeId, JSON.stringify(ids));
}

/**
 * 提炼已经给这些感知写好规范（encode 在批次事务里调用）：norm_state → assessed。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 */
export function markAssessed(core, perceptIds) {
  const ids = uniqInts(Array.isArray(perceptIds) ? perceptIds : []);
  if (!ids.length) return;
  core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
}

// ── 原文到期 ──────────────────────────────────────────────────────────────
/**
 * 原文过了保留期（admin 在冷静期满、备份完成后调用，§12.6）：分批把感知原文和原文窗口的 text 置 NULL、
 * text_state='expired'，删掉对应的 FTS 行，并让 worker 删掉原文窗口的嵌入文本和向量（worker.dropEmbeddings）。可中断、可重跑。
 * 顺序照 §2.3：先删向量（窗口），再清主库。情节、事实和 ≤ 60 字的来源证据都不动。
 * 窗口只要有一条成员过期（t_start < before）整个窗口的原文就清掉；感知引用里的摘录和平台给的媒体摘要一起清掉（只留媒体的种类）；
 * 她自己看到的（D116，by:'self'）留着、重新进 FTS。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{before: number, limit?: number}} o
 * @returns {{percepts: number, windows: number, done: boolean}}
 */
export function expireRawText(core, o) {
  if (!o || !Number.isFinite(o.before)) throw new TypeError('intake.expireRawText：before 必填');
  const limit = clampInt(o.limit, 1, 10_000, opt(core, 'expireBatch'));
  const store = core.store;
  const wins = store.all('SELECT id FROM raw_windows WHERE text IS NOT NULL AND t_start < ? ORDER BY t_start LIMIT ?', o.before, limit);
  if (wins.length) core.mods.worker.dropEmbeddings(core, wins.map((w) => ({ kind: 'window', id: w.id })));
  const ps = store.all('SELECT id, fts_shard, quote_json, media_json FROM percepts WHERE text IS NOT NULL AND at < ? ORDER BY at LIMIT ?', o.before, limit);
  store.tx(() => {
    for (const w of wins) store.run('UPDATE raw_windows SET text = NULL WHERE id = ?', w.id);
    for (const p of ps) {
      if (p.fts_shard) ftsDelete(store, p.fts_shard, p.id);
      const quote = parseJson(p.quote_json);
      if (quote) delete quote.excerpt;
      const media = parseJson(p.media_json, null);
      // 平台给的说明随原文清掉、只留种类；她自己看到的（D116）是她的记忆不是原话，留着，也还搜得到
      const mediaKinds = Array.isArray(media) ? media.map((m) => (m?.by === SEEN_BY && typeof m.summary === 'string'
        ? { kind: m.kind ?? 'media', summary: m.summary, by: SEEN_BY, at: m.at, ...(m.tainted === true ? { tainted: true } : {}) } : { kind: m?.kind ?? 'media' })) : null;
      store.run(`UPDATE percepts SET text = NULL, text_state = 'expired', quote_json = ?, media_json = ?, window_id = COALESCE(window_id, 0) WHERE id = ?`,
        quote ? JSON.stringify(quote) : null, mediaKinds?.length ? JSON.stringify(mediaKinds) : null, p.id);
      const kept = seenOf(mediaKinds);
      if (kept && p.fts_shard) {
        const toks = soft(core, 'tokens', () => core.mods.lang.indexTokens(core, kept.summary, {}), []);
        if (toks?.length) ftsInsert(store, p.fts_shard, p.id, toks);
      }
      // 第一眼里抄下的原话、大概也是原文的一部分（§2.3 级联）
      store.run('UPDATE glances SET quote = NULL, gist = NULL, vague = NULL WHERE percept_id = ?', p.id);
    }
    if (ps.length) metric(core, 'intake.expired.percepts', ps.length);
    if (wins.length) metric(core, 'intake.expired.windows', wins.length);
  });
  return { percepts: ps.length, windows: wins.length, done: ps.length < limit && wins.length < limit };
}

// ── 清洗 ──────────────────────────────────────────────────────────────────
/**
 * 入库前的清洗：核心的通用部分（删令牌、cookie、≥ 32 位 hex/base64 串、本机路径；URL 去 query；去不可见字符；媒体只留占位和摘要），
 * 然后是注入的 ports.sanitizer.forStore（平台相关的转义）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {{adapter: string, kind?: string}} origin
 * @returns {string}
 */
export function sanitizeForStore(core, text, origin) {
  let s;
  try {
    s = genericForStore(String(text ?? ''), { longTokenChars: core.config.get().intake?.longTokenChars });
  } catch {
    s = stripInvisible(text);
  }
  const port = core.ports?.sanitizer;
  if (port && typeof port.forStore === 'function') {
    try {
      const r = port.forStore(s, isObj(origin) ? origin : { adapter: '' });
      if (typeof r === 'string') s = r;
    } catch (e) { report(core, 'intake.sanitizer.store', e); }
  }
  return s;
}

/**
 * 调 LLM 前、注入前的清洗（§7.1、§10.4）：通用部分 + ports.sanitizer.forPrompt；【】换「」、折叠换行、中和 [m12] / [U1] 这类编号。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForPrompt(core, text) {
  let s;
  try {
    s = genericForPrompt(String(text ?? ''), { longTokenChars: core.config.get().intake?.longTokenChars });
  } catch {
    s = stripInvisible(text).replace(/[[\]【】{}]/g, ' ');
  }
  const port = core.ports?.sanitizer;
  if (port && typeof port.forPrompt === 'function') {
    try {
      const r = port.forPrompt(s);
      if (typeof r === 'string') s = r;
    } catch (e) { report(core, 'intake.sanitizer.prompt', e); }
  }
  return s;
}

/**
 * 【D111 评审】场合的称呼放进提示词时用：先按 sanitizeForPrompt 清洗（【】已换成「」），再把引号类括号（「」『』“”"）换成空格——
 * 称呼会被写在「…」里，名字里自带的 」 能把引号提前合上、伪造后面的话（群名是群里的人起的）；最后按字符数截到 max（默认 20）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} label
 * @param {number} [max]
 * @returns {string}
 */
export function labelForPrompt(core, label, max = 20) {
  const s = sanitizeForPrompt(core, String(label ?? '')).replace(/[「」『』“”"]/g, ' ').replace(/\s+/g, ' ').trim();
  const n = Number.isSafeInteger(max) && max > 0 ? max : 20;
  const cs = [...s];
  return cs.length > n ? `${cs.slice(0, n).join('')}…` : s;
}

/**
 * 一个场合最近的几条感知（窗口、第二段卡片、提炼输入都用它），按 id 升序。
 * limit 缺省取 recall.window.maxMsgs；maxChars 从最新的往回数，超了就停（至少给一条）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{limit?: number, beforeId?: number, maxChars?: number, kinds?: string[]}} [opt]
 * @returns {PerceptRow[]}
 */
export function recentPercepts(core, settingKey, opt) {
  if (typeof settingKey !== 'string' || !core.store || core.store.closed) return [];
  const o = opt ?? {};
  const limit = clampInt(o.limit, 1, 1000, core.config.get().recall?.window?.maxMsgs ?? DEFAULTS.recall.window.maxMsgs);
  let sql = 'SELECT * FROM percepts WHERE setting_key = ?';
  const params = [settingKey];
  if (Number.isInteger(o.beforeId)) { sql += ' AND id < ?'; params.push(o.beforeId); }
  if (Array.isArray(o.kinds) && o.kinds.length) { sql += ' AND kind IN (SELECT value FROM json_each(?))'; params.push(JSON.stringify(o.kinds.filter((k) => typeof k === 'string'))); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  let rows = core.store.all(sql, ...params);
  if (Number.isFinite(o.maxChars) && o.maxChars > 0) {
    const kept = [];
    let total = 0;
    for (const r of rows) {
      const n = [...(r.text ?? '')].length;
      if (kept.length && total + n > o.maxChars) break;
      kept.push(r);
      total += n;
    }
    rows = kept;
  }
  return rows.reverse();
}

// 只给测试和自检看的内部量（不在契约里）
// ── 她看过的媒体（D116） ────────────────────────────────────────────────
/**
 * 【D116】她用工具看了一条消息里的媒体、看完以后有了想法和回话：一次纯文字调用（use='perceive'，预算、超时照 intake.mediaSeen）
 * 摘出她看到了什么，写进那条消息的 media_json（{kind, summary, by:'self', at}），重建 FTS、重渲染包含它的原文窗口。不抛错。
 * 找不到那条消息（还在队列里的先落库）、是她自己的、预算不允许、模型出错 / 超时、模型说没看出什么（NONE）→ 不写，reason 说明。
 * @param {import('../core-types.js').CoreContext} core
 * material：工具结果里的文字（只拿来挡照抄，不存）；tainted：这一轮带按轮污点（这一项标 tainted，所在感知不当成长的依据）。
 * @param {{adapterId: string, obsId: string, thoughts?: string, reply?: string, material?: string, tainted?: boolean, kind?: string, at?: number, signal?: AbortSignal}} req
 * @returns {Promise<{ok: boolean, reason: string, perceptId?: number, summary?: string}>}
 */
export async function perceiveMedia(core, req) {
  if (!req || typeof req.adapterId !== 'string' || !isOpaqueId(req.obsId)) return { ok: false, reason: 'bad-request' };
  if (!writable(core)) return { ok: false, reason: 'read-only' };
  drainFor(core, req.adapterId, req.obsId);
  const row = core.store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', req.adapterId, core.keys.obsKey(req.adapterId, req.obsId));
  if (!row) { metric(core, 'media.seen.no-percept'); return { ok: false, reason: 'no-percept' }; }
  return perceive(core, { perceptId: row.id, thoughts: req.thoughts, reply: req.reply, material: req.material, tainted: req.tainted === true,
    kind: req.kind, at: req.at, signal: req.signal,
    sanitize: (t) => sanitizeForPrompt(core, t), sanitizeStore: (t) => sanitizeForStore(core, t, { adapter: req.adapterId }) });
}

/**
 * 【D116】直接写她看到的（不调模型；补录脚本、测试用）：清洗、按字数截断，只被更晚的一次替换；平台给的说明不改。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{perceptId: number, summary: string, kind?: string, at?: number}} req
 * @returns {{ok: boolean, reason: string, perceptId?: number}}
 */
export function writeSeenMedia(core, req) {
  if (!req || !Number.isSafeInteger(req.perceptId)) return { ok: false, reason: 'bad-request' };
  const r = writeSeen(core, { perceptId: req.perceptId, summary: sanitizeForStore(core, String(req.summary ?? ''), { adapter: '' }), kind: req.kind, at: req.at });
  metric(core, `media.seen.${r.reason}`);
  return r;
}

/**
 * 【D116】一条消息的文字带上她看到的：正好一个方括号占位就写进去（「［视频，你看到的：…］」），否则接在后面；没有就原样。
 * 给她看的地方 who='你'，原文窗口里 '我'，管理页 '她'；max：说明最多显示几个字（0 = 不截）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string|null} text
 * @param {string|null} mediaJson
 * @param {{who?: string, max?: number}} [opt]
 * @returns {string}
 */
export function mediaText(core, text, mediaJson, opt) {
  try { return withSeen(text, mediaJson, opt); } catch { return String(text ?? ''); }
}

/**
 * 【D116】media_json 里她看到的那一项（最晚的一项）；没有返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string|null} mediaJson
 * @returns {{kind: string, summary: string, at: number}|null}
 */
export function seenMedia(core, mediaJson) {
  try { return seenOf(mediaJson); } catch { return null; }
}

export const _internal = Object.freeze({ WINDOW_KINDS, PRESENT_KINDS, SELF_KINDS });
