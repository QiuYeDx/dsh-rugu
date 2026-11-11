// 会话账本（§10.3–§10.5、§9.4.1、§9.6；D4）：sessions、injections 两张表只在这里写。
//   - 「已发过」：注入块先记成待确认（pending），会话事件里看到 nonce 才算发过（confirmInjection），条目进本周期的已发名单；
//     回合中止没发出去的丢掉（abortPending），下次照常可以发。
//   - 污点账本 = 本周期已确认送达、带内容的注入条目 + 本周期常驻区放进过这个会话的条目（推出来，不另存）。
//   - 压缩周期：compaction end / restart 时 cycle + 1，已发名单清空。
//   - 预算：每会话每天的字数从注入日志算；滚动窗口按 recordStep 记下的上下文 token 算（§10.4）。
import { bumpMetric, parseRef } from '../store/index.js';
import { ContractError, LAYERS, ITEM_VERDICTS, SPEAK_LEVELS, WORKING_UNITS, isOpaqueId } from '../contract/index.js';
import { safeJson, dayStart } from './text.js';
import { UNMETERED_LAYERS } from './pack.js';
import { budgetLimits } from '../config/defaults.js';

const CONTENT = new Set(['share', 'share_vague']);
const AWARE_TAG = '~aware';

/** 已发名单里的标记：带内容的记 id，只给了暗示的记 id~aware（之后同一条若能说了，仍然可以发内容）。 */
export function sentTag(item) {
  if (CONTENT.has(item.verdict)) return item.id;
  if (item.verdict === 'aware_private') return `${item.id}${AWARE_TAG}`;
  return null;   // pending 不进名单：下一轮要用缓存补上内容
}

/** @returns {object|null} */
export function loadSession(core, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const row = core.store.get('SELECT * FROM sessions WHERE session_id = ?', sessionId);
  if (!row) return null;
  return {
    ...row,
    sent: safeJson(row.sent_items_json, []),
    pending: safeJson(row.pending_json, []),
    residentItems: safeJson(row.resident_items_json, []),
    window: safeJson(row.inject_window_json, {}),
    taint: safeJson(row.turn_taint_json, null),
  };
}

function ensureRow(core, sessionId, at) {
  core.store.run(`INSERT INTO sessions(session_id, updated_at, cycle_started_at) VALUES (?, ?, ?)
                  ON CONFLICT(session_id) DO NOTHING`, sessionId, at, at);
}

/** 不抛错的写：出错只记日志和计数（钩子里调用，账本写失败不能让她的回合失败）。 */
function quiet(core, what, fn) {
  try { return fn(); } catch (e) {
    try {
      core.log.warn('context.ledger.error', { op: what, error: e?.code ?? e?.name ?? 'Error' });
      if (!core.readOnly) bumpMetric(core.store, `context.${what}.error`);
    } catch { /* 日志也失败就算了 */ }
    return undefined;
  }
}

// ── 绑定 ──────────────────────────────────────────────────────────────────

/**
 * @param {(key: string) => string[]} [residentItemsOf]  这个场合当前冻结的常驻区条目：会话一绑定，它的上下文里就有它们（污点账本）
 */
export function bindSession(core, b, residentItemsOf = () => []) {
  const errors = [];
  if (!b || !isOpaqueId(b.sessionId)) errors.push({ path: 'sessionId', message: '应为不透明 id' });
  if (!b || !isOpaqueId(b.settingId)) errors.push({ path: 'settingId', message: '应为不透明 id' });
  if (!b || typeof b.adapterId !== 'string' || !b.adapterId) errors.push({ path: 'adapterId', message: '必填' });
  if (!b || !['specific', 'fallback'].includes(b.confidence)) errors.push({ path: 'confidence', message: '应为 specific / fallback' });
  if (errors.length) throw new ContractError('SessionBinding', errors);
  const at = core.now();
  const key = core.keys.settingKey(b.adapterId, b.settingId);
  core.store.tx(() => {
    ensureRow(core, b.sessionId, at);
    const prev = loadSession(core, b.sessionId);
    const items = new Set([...(prev?.residentItems ?? []), ...residentItemsOf(key)]);
    core.store.run(`UPDATE sessions SET setting_key = ?, adapter = ?, confidence = ?, bound_at = COALESCE(bound_at, ?),
                    resident_items_json = ?, status = 'active', updated_at = ? WHERE session_id = ?`,
    key, b.adapterId, b.confidence, at, JSON.stringify([...items]), at, b.sessionId);
  });
  // SettingId 只放内存（常驻区渲染时给 discretion.targetFor 刷新成员）；库里永远只有场合键（§12.3）
  core.state.context.settingIds.set(key, { settingId: b.settingId, adapterId: b.adapterId });
}

// ── 注入、确认、中止 ────────────────────────────────────────────────────────

export function recordInjection(core, inj) {
  const errors = [];
  if (!inj || !isOpaqueId(inj.sessionId)) errors.push({ path: 'sessionId', message: '应为不透明 id' });
  if (!inj || !isOpaqueId(inj.nonce)) errors.push({ path: 'nonce', message: '应为不透明 id' });
  if (!inj || typeof inj.layer !== 'string' || !inj.layer || inj.layer.length > 64) errors.push({ path: 'layer', message: '必填，≤ 64 字符' });
  if (!inj || !Array.isArray(inj.items) || inj.items.length > 500) errors.push({ path: 'items', message: '应为数组（≤ 500 项）' });
  if (!inj || !Number.isInteger(inj.chars) || inj.chars < 0) errors.push({ path: 'chars', message: '应为非负整数' });
  if (!inj || !['shadow', 'live'].includes(inj.mode)) errors.push({ path: 'mode', message: '应为 shadow / live' });
  const items = [];
  (Array.isArray(inj?.items) ? inj.items : []).forEach((it, i) => {
    const p = `items[${i}]`;
    if (!it || typeof it.id !== 'string' || !it.id || it.id.length > 200) errors.push({ path: `${p}.id`, message: '必填' });
    else if (!LAYERS.includes(it.layer)) errors.push({ path: `${p}.layer`, message: '不认识的层' });
    else if (!ITEM_VERDICTS.includes(it.verdict)) errors.push({ path: `${p}.verdict`, message: '不认识的结论' });
    // §9.3.6：注入日志里的每一项都必须能对上一次判定
    else if (typeof it.appraisalRef !== 'string' || !it.appraisalRef || it.appraisalRef.length > 200) errors.push({ path: `${p}.appraisalRef`, message: '必填（每条都要对上一次判定）' });
    else if (it.speak !== undefined && !SPEAK_LEVELS.includes(it.speak)) errors.push({ path: `${p}.speak`, message: '应为 free / careful / not-here' });
    else if (it.unit !== undefined && !WORKING_UNITS.includes(it.unit)) errors.push({ path: `${p}.unit`, message: '应为 thread / talk / open' });
    else if (it.unitKey !== undefined && (typeof it.unitKey !== 'string' || !it.unitKey || it.unitKey.length > 40)) errors.push({ path: `${p}.unitKey`, message: '应为 ≤ 40 字的字符串' });
    else if (it.chars !== undefined && (!Number.isInteger(it.chars) || it.chars < 0 || it.chars > 1_000_000)) errors.push({ path: `${p}.chars`, message: '应为非负整数' });
    // 只记这几项，不记正文（§12.3）；工作记忆的条目另记所在的段（D110，排查用）；chars：这一条自己的字数（可选，D133：
    // 预算按条目的层记账，「你想着的」和工作记忆不算）。speak（D101 的说出口档位）已弃用（D113）：
    // 旧宿主交来的照样校验、不再记下；旧行里的照样读得出来
    else {
      items.push({ id: it.id, layer: it.layer, verdict: it.verdict, appraisalRef: it.appraisalRef,
        ...(it.unit ? { unit: it.unit } : {}), ...(it.unitKey ? { unitKey: it.unitKey } : {}), ...(it.chars !== undefined ? { chars: it.chars } : {}) });
    }
  });
  if (errors.length) throw new ContractError('Injection', errors);
  const at = core.now();
  return core.store.tx(() => {
    const dup = core.store.get('SELECT id, session_id FROM injections WHERE nonce = ?', inj.nonce);
    if (dup) {
      if (dup.session_id !== inj.sessionId) throw new ContractError('Injection', [{ path: 'nonce', message: '已被别的会话用过' }]);
      return dup.id;
    }
    // §9.3.6 的代码层断言：注入日志里的每一项都要对上一条判定记录（同一条记忆、同一个结论）。对不上就整块不记，集成层也就不该注入
    const bad = unmatchedAppraisals(core, items);
    if (bad.length) {
      bumpMetric(core.store, 'context.inject.unappraised');
      throw new ContractError('Injection', bad.map((i) => ({ path: `items[${i}].appraisalRef`, message: '对不上一条判定记录（§9.3.6）' })));
    }
    ensureRow(core, inj.sessionId, at);
    const s = loadSession(core, inj.sessionId);
    if (!s.setting_key) core.log.warn('context.inject.unbound', { layer: inj.layer });
    const r = core.store.run(`INSERT INTO injections(ts, session_id, cycle, setting_key, layer, nonce, items_json, chars, degrade_level,
                                route_ms_json, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    at, inj.sessionId, s.cycle, s.setting_key, inj.layer, inj.nonce, JSON.stringify(items), inj.chars,
    Number.isInteger(inj.degradeLevel) ? inj.degradeLevel : null, inj.routeMs ? JSON.stringify(numbersOnly(inj.routeMs)) : null, inj.mode);
    const id = Number(r.lastInsertRowid);
    const pending = [...s.pending, { nonce: inj.nonce, id, at, live: inj.mode === 'live' }];
    core.store.run('UPDATE sessions SET pending_json = ?, updated_at = ? WHERE session_id = ?', JSON.stringify(pending), at, inj.sessionId);
    return id;
  });
}

/**
 * 哪些条目对不上判定记录：appraisalRef 必须是 'ap<id>'，那一行的记忆就是这一项（item.id），结论相同，而且不是 omit。
 * @returns {number[]} 对不上的下标
 */
function unmatchedAppraisals(core, items) {
  const ids = [];
  const want = items.map((it) => {
    const m = /^ap([1-9]\d{0,15})$/.exec(it.appraisalRef);
    const mref = parseRef(it.id);
    if (!m || !mref) return null;
    const id = Number(m[1]);
    ids.push(id);
    return { id, kind: mref.kind, memoryId: mref.id, verdict: it.verdict };
  });
  const rows = new Map();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 400) {
    const part = uniq.slice(i, i + 400);
    for (const r of core.store.all(`SELECT id, memory_kind, memory_id, verdict FROM appraisals WHERE id IN (${part.map(() => '?').join(',')})`, ...part)) rows.set(r.id, r);
  }
  const bad = [];
  want.forEach((w, i) => {
    const r = w ? rows.get(w.id) : null;
    if (!r || r.memory_kind !== w.kind || r.memory_id !== w.memoryId || r.verdict === 'omit' || r.verdict !== w.verdict) bad.push(i);
  });
  return bad;
}

export function confirmInjection(core, sessionId, nonce) {
  quiet(core, 'confirm', () => core.store.tx(() => {
    const inj = core.store.get('SELECT * FROM injections WHERE nonce = ?', nonce);
    if (!inj || inj.session_id !== sessionId) { bumpMetric(core.store, 'context.confirm.unknown'); return; }
    if (inj.seen) return;
    const at = core.now();
    core.store.run('UPDATE injections SET seen = 1, seen_at = ? WHERE id = ?', at, inj.id);
    const s = loadSession(core, sessionId);
    if (!s) return;
    const pending = s.pending.filter((p) => p.nonce !== nonce);
    let { warm_pending: warm, gap_ack_at: gapAck } = s;
    const sent = new Set(s.sent);
    // 旧版本记下的 mode='shadow' 块没有真的进上下文；压缩之前记下、压缩之后才确认的块属于旧周期
    if (inj.mode === 'live' && inj.cycle === s.cycle) {
      const items = safeJson(inj.items_json, []);
      for (const it of items) { const tag = sentTag(it); if (tag) sent.add(tag); }
      if (items.some((it) => it.layer === 'warmStart')) warm = 0;
      if (items.some((it) => it.layer === 'gap')) gapAck = inj.ts;
    }
    core.store.run(`UPDATE sessions SET sent_items_json = ?, pending_json = ?, warm_pending = ?, gap_ack_at = ?, updated_at = ?
                    WHERE session_id = ?`, JSON.stringify([...sent]), JSON.stringify(pending), warm, gapAck, at, sessionId);
  }));
}

export function abortPending(core, sessionId) {
  quiet(core, 'abort', () => {
    core.store.run(`UPDATE sessions SET pending_json = '[]', updated_at = ? WHERE session_id = ?`, core.now(), sessionId);
  });
}

// ── 压缩周期 ──────────────────────────────────────────────────────────────

/**
 * @param {(key: string) => string[]} residentItemsOf  当前冻结的常驻区条目（新周期一开始上下文里就有它）
 * @param {(key: string) => void} onResidentDirty      标脏并安排重新渲染
 */
export function compaction(core, sessionId, phase, { residentItemsOf, onResidentDirty }) {
  quiet(core, 'compaction', () => {
    const s = loadSession(core, sessionId);
    if (!s) { bumpMetric(core.store, 'context.compaction.unknown'); return; }
    if (phase === 'start') { seal(core, sessionId, s); return; }
    if (phase !== 'end' && phase !== 'restart') { bumpMetric(core.store, 'context.compaction.badPhase'); return; }
    const at = core.now();
    const residentNow = s.setting_key ? residentItemsOf(s.setting_key) : [];
    core.store.run(`UPDATE sessions SET cycle = cycle + 1, cycle_started_at = ?, sent_items_json = '[]', pending_json = '[]',
                    resident_items_json = ?, warm_pending = ?, restart_marker = ?, updated_at = ? WHERE session_id = ?`,
    at, JSON.stringify(residentNow), phase === 'end' ? 1 : 0, phase === 'restart' ? at : null, at, sessionId);
    if (s.setting_key) onResidentDirty(s.setting_key);
  });
}

/**
 * compaction/start：只记检查点（intake.sealBuffers），不切断情节（评审:SC-23）。intake.sealBuffers 也接受场合键（D53）：
 * 用库里的绑定，插件重启后还没重新 bind 的会话照样记得上（SettingId 只在内存里）。
 */
function seal(core, sessionId, s) {
  if (!s.setting_key) {
    bumpMetric(core.store, 'context.seal.unbound');
    core.log.info('context.seal.skipped', { reason: 'unbound' });
    return;
  }
  core.mods.intake.sealBuffers(core, s.setting_key);
}

// ── 按轮污点、步数 ─────────────────────────────────────────────────────────

/**
 * 标上 / 清掉按轮污点。打开 context.taint.notify 时（D118 起默认关），带污点的这一轮里进了上下文的不可信内容进「需要你知道」
 * （§9.3.7、§9.6，kind='taint'），见 noteTainted；
 * 清掉之前再扫一遍（集成层标污点时，那条工具结果可能还在 intake 的队列里没落库）。
 * turn_taint_json：{tainted, since, reasons, turnStart, ntk: {upTo, sources}} / {tainted: false, clearedAt}。
 */
export function markTurnTaint(core, sessionId, m) {
  // 集成层往往刚把那条工具结果交给 observe（还在 intake 的队列里）就来标污点：先落库，「需要你知道」当场就扫得到（D96）
  if (m?.tainted && !core.store.inTransaction) quiet(core, 'taint.drain', () => core.mods.intake.drain(core));
  quiet(core, 'taint', () => core.store.tx(() => {
    const at = Number.isFinite(m?.at) ? m.at : core.now();
    ensureRow(core, sessionId, at);
    const s = loadSession(core, sessionId);
    const prev = s.taint?.tainted ? s.taint : null;
    const reason = typeof m?.reason === 'string' ? m.reason.slice(0, 64) : '';
    let next;
    if (m?.tainted) {
      next = {
        tainted: true, since: prev?.since ?? at, reasons: [...new Set([...(prev?.reasons ?? []), reason].filter(Boolean))].slice(-8),
        turnStart: Number.isFinite(prev?.turnStart) ? prev.turnStart : turnStartOf(core, s, at),
        ntk: prev?.ntk ?? { upTo: 0, sources: [] },
      };
      next.ntk = noteTainted(core, s, next, at);
    } else {
      if (prev) noteTainted(core, s, { ...prev, turnStart: Number.isFinite(prev.turnStart) ? prev.turnStart : prev.since }, at);
      next = { tainted: false, since: null, reasons: [], clearedAt: at };
    }
    core.store.run('UPDATE sessions SET turn_taint_json = ?, updated_at = ? WHERE session_id = ?', JSON.stringify(next), at, sessionId);
  }));
}

/**
 * 这一轮从什么时候算起（§9.6「从最近一条有权限的说话人的消息开始」）：上次清掉污点的时刻（有权限的人开启新一轮时集成层清的）、
 * 这个场合里最近一条有权限的人的话、本周期的开始，取最晚的；都没有就是现在。
 */
function turnStartOf(core, s, at) {
  const marks = [s.taint && !s.taint.tainted ? s.taint.clearedAt : null, s.cycle_started_at];
  if (s.setting_key) {
    try {
      // 有权限的人只有几位：各自按 (actor_entity_id, at) 的索引往回找这个场合里的最近一条
      for (const e of core.store.all("SELECT id FROM entities WHERE authority <> 'none'")) {
        marks.push(core.store.get(`SELECT perceived_at AS t FROM percepts WHERE actor_entity_id = ? AND perceived_in = ? AND at <= ?
                                   ORDER BY at DESC LIMIT 1`, e.id, s.setting_key, at)?.t);
      }
    } catch { /* 查不了：只用上次清掉的时刻和本周期的开始 */ }
  }
  const ok = marks.filter((t) => Number.isFinite(t) && t <= at);
  return ok.length ? Math.max(...ok) : at;
}

/**
 * 带污点的一轮里进了上下文的不可信内容 → 「需要你知道」（kind='taint'，§9.3.7）。「进了上下文」：在这个会话的场合里感知到的
 * （perceived_in）、这一轮开始以后的、不是她自己也不是有权限的人写的、经「读」进来的文字——素材、内容、她私下读到的、转发的
 * （工具结果、引用、转发，§9.6）；场合里大家照常说的话不算。每个来源记一条（管理页按来源撤回），一轮最多
 * context.taint.notifyMax 个来源；只往后看最近 context.taint.scanRows 条感知（这一轮的东西都是刚落库的）。
 * 返回新的 ntk：upTo（看到哪一条了）、sources（这一轮记过的来源，0 = 不知道是谁）。在调用方的事务里调用；
 * 出错只记计数，污点照常标上（「需要你知道」少一条，不能让关口①少知道这一轮带污点）。
 * 【D118】默认不记（context.taint.notify = false）：合并转发、引用、工具结果几乎每轮都有，主人自己转给她的聊天记录也在里面，
 * 列出来主人分不出该看哪条（实测问题 #29）。污点本身照常标在这一轮上（关口①、外发守护、成长的依据照旧用它）。
 */
function noteTainted(core, s, t, at) {
  const ntk = { upTo: Number(t.ntk?.upTo) || 0, sources: Array.isArray(t.ntk?.sources) ? [...t.ntk.sources] : [] };
  if (!s.setting_key || typeof core.mods.admin?.notifyNeedToKnow !== 'function') return ntk;
  try {
    const tc = core.config.get().context.taint;
    if (tc.notify !== true) return ntk;
    const maxSources = tc.notifyMax;
    const done = new Set(ntk.sources);
    if (done.size >= maxSources) return ntk;
    const rows = core.store.all(`SELECT p.id, p.actor_entity_id AS who, p.perceived_in, p.perceived_at, p.actor_self, p.kind, p.standing,
                                        p.visible_to, p.forwarded_json, e.authority
                                   FROM (SELECT * FROM percepts WHERE id > ? ORDER BY id DESC LIMIT ?) p
                                   LEFT JOIN entities e ON e.id = p.actor_entity_id
                                  ORDER BY p.id`, ntk.upTo, tc.scanRows);
    if (!rows.length) return ntk;
    const reason = `turn-taint${t.reasons?.length ? `:${t.reasons.join(',')}` : ''}`.slice(0, 200);
    for (const r of rows) {
      if (done.size >= maxSources) break;
      if (r.perceived_in !== s.setting_key || !(r.perceived_at >= t.turnStart) || r.perceived_at > at || r.actor_self) continue;
      if ((r.authority ?? 'none') !== 'none' || !['utterance', 'content'].includes(r.kind)) continue;
      if (!(r.standing === 'material' || r.kind === 'content' || r.visible_to === 'her-only' || r.forwarded_json)) continue;
      const who = Number.isInteger(r.who) ? r.who : 0;
      if (done.has(who)) continue;
      core.store.tx(() => core.mods.admin.notifyNeedToKnow(core, { kind: 'taint', ref: null, perceptId: r.id, sourceEntityId: who || null,
        reason, severity: 1, at: r.perceived_at }));
      done.add(who);
    }
    return { upTo: Math.max(ntk.upTo, rows.at(-1).id), sources: [...done] };
  } catch (e) {
    bumpMetric(core.store, 'context.taint.notify.error');
    core.log.warn('context.taint.notify.error', { error: e?.code ?? e?.name ?? 'Error' });
    return ntk;
  }
}

export function recordStep(core, sessionId, step) {
  quiet(core, 'step', () => core.store.tx(() => {
    const tokens = Number(step?.contextTokens);
    if (!Number.isFinite(tokens) || tokens < 0) { bumpMetric(core.store, 'context.step.bad'); return; }
    const at = Number.isFinite(step?.at) ? step.at : core.now();
    ensureRow(core, sessionId, at);
    const s = loadSession(core, sessionId);
    const keep = core.config.get().context.rolling.steps + 1;
    const steps = [...(Array.isArray(s.window.steps) ? s.window.steps : []), { at, tokens: Math.round(tokens) }].slice(-keep);
    core.store.run('UPDATE sessions SET inject_window_json = ?, updated_at = ? WHERE session_id = ?',
      JSON.stringify({ ...s.window, steps }), at, sessionId);
    // 带污点的轮里每一步顺手再看一眼：标污点之后才落库的工具结果也及时进「需要你知道」
    if (s.taint?.tainted && Number.isFinite(s.taint.turnStart)) {
      const ntk = noteTainted(core, s, s.taint, at);
      core.store.run('UPDATE sessions SET turn_taint_json = ? WHERE session_id = ?', JSON.stringify({ ...s.taint, ntk }), sessionId);
    }
  }));
}

/** 回想用掉的时刻（时间间隔层的参考；只在真实消息触发时写）。 */
export function noteInteraction(core, sessionId, at) {
  quiet(core, 'interaction', () => core.store.run('UPDATE sessions SET last_interaction_at = ?, updated_at = ? WHERE session_id = ?', at, at, sessionId));
}
/** 该补暖启动但没什么可补的：直接清掉标记，免得每一轮都再找一遍。 */
export function clearWarm(core, sessionId) {
  quiet(core, 'warm', () => core.store.run('UPDATE sessions SET warm_pending = 0, updated_at = ? WHERE session_id = ?', core.now(), sessionId));
}

/** 冻结了新的常驻区：绑在这个场合的会话，本周期上下文里多了这些条目（DSH 文本一变就追加一份，旧的还在，F3/F6）。 */
export function noteResidentServed(core, settingKey, itemIds) {
  if (!itemIds.length) return;
  quiet(core, 'resident', () => core.store.tx(() => {
    for (const row of core.store.all(`SELECT session_id, resident_items_json FROM sessions WHERE setting_key = ? AND status = 'active'`, settingKey)) {
      const set = new Set([...safeJson(row.resident_items_json, []), ...itemIds]);
      core.store.run('UPDATE sessions SET resident_items_json = ? WHERE session_id = ?', JSON.stringify([...set]), row.session_id);
    }
  }));
}

// ── 读 ────────────────────────────────────────────────────────────────────

/**
 * 还在等确认的真实注入块（旧版本记下的 mode='shadow' 不算）。回合结束时集成层会确认或丢弃（abortPending）；集成层自己出了事、一直没回音的，
 * 过了 context.pendingTtlMin 就当它没发出去（回合早就结束了），下次照常可以发。
 * @returns {string[]} nonce
 */
export function livePending(core, s) {
  const ttl = core.config.get().context.pendingTtlMin * 60_000;
  const now = core.now();
  return (s?.pending ?? []).filter((p) => p.live !== false && !(Number.isFinite(p.at) && now - p.at > ttl)).map((p) => p.nonce);
}

/** 本周期已发 + 还在等确认的条目标记（真的进了上下文、或马上就要进的，不再发第二遍）。 */
export function sentTags(core, s) {
  const tags = new Set(s?.sent ?? []);
  const live = livePending(core, s);
  if (live.length) {
    const marks = live.map(() => '?').join(',');
    for (const row of core.store.all(`SELECT items_json FROM injections WHERE nonce IN (${marks})`, ...live)) {
      for (const it of safeJson(row.items_json, [])) { const tag = sentTag(it); if (tag) tags.add(tag); }
    }
  }
  return tags;
}

/** 还在等确认的（真的要发的）块里有哪些层：同一个回合里不重复给时间间隔、暖启动。 */
export function pendingLayers(core, s) {
  const out = new Set();
  const live = livePending(core, s);
  if (!live.length) return out;
  for (const row of core.store.all(`SELECT items_json FROM injections WHERE nonce IN (${live.map(() => '?').join(',')})`, ...live)) {
    for (const it of safeJson(row.items_json, [])) out.add(it.layer);
  }
  return out;
}

const UNMETERED = new Set(UNMETERED_LAYERS);
/**
 * 一行注入日志里受限的字数（D133）：「你想着的」和工作记忆（UNMETERED_LAYERS）不受限，也不记账。
 * 集成层给每条带了它自己的字数（items[].chars）时按条目的层求和；旧的行（条目上没有字数）、没有条目的行按整块的 chars 算。
 */
function meteredChars(row) {
  const items = safeJson(row.items_json, []);
  if (!Array.isArray(items) || !items.length || !items.every((it) => Number.isInteger(it?.chars) && it.chars >= 0)) return Number(row.chars) || 0;
  let n = 0;
  for (const it of items) if (!UNMETERED.has(it.layer)) n += it.chars;
  return n;
}

/**
 * 这个会话的预算状态（§10.4，D133）：今天已注入的受限字数、滚动窗口里还能注入多少（窗口没满 context.rolling.steps 步之前不限）。
 * 上限从花费档位来（budgetLimits：injectPerSessionPerDay、injectShare；null = 不限，对应的额度是 Infinity）。
 * 滚动窗口的上下文增量 = 窗口里相邻两步的正增量之和：压缩让上下文变小那一步算 0，不再把整个窗口的增量抵成 0。
 * rollingUsed / rollingLimit 给诊断看（窗口没满、不限时 rollingLimit 是 Infinity）。
 * @returns {{dayUsed: number, dayLimit: number, rollingLeft: number, rollingUsed: number, rollingLimit: number}}
 */
export function budgetState(core, s, at) {
  const cfg = core.config.get();
  const L = budgetLimits(cfg);
  const share = typeof L.injectShare === 'number' && Number.isFinite(L.injectShare) ? L.injectShare : null;
  const perDay = Number.isFinite(L.injectPerSessionPerDay) ? L.injectPerSessionPerDay : Infinity;
  const out = { dayUsed: 0, dayLimit: perDay, rollingLeft: Infinity, rollingUsed: 0, rollingLimit: Infinity };
  if (!s) return out;
  const sum = (rows) => rows.reduce((n, r) => n + meteredChars(r), 0);
  const start = dayStart(at, cfg.time.tzOffsetMin);
  out.dayUsed = sum(core.store.all(`SELECT chars, items_json FROM injections WHERE session_id = ? AND mode = 'live' AND seen = 1 AND ts >= ?`,
    s.session_id, start));
  const live = livePending(core, s);
  if (live.length) {
    out.dayUsed += sum(core.store.all(`SELECT chars, items_json FROM injections WHERE nonce IN (${live.map(() => '?').join(',')}) AND ts >= ?`,
      ...live, start));
  }
  const N = cfg.context.rolling.steps;
  const steps = Array.isArray(s.window.steps) ? s.window.steps : [];
  if (steps.length > N) {
    const win = steps.slice(-(N + 1));
    let delta = 0;
    for (let i = 1; i < win.length; i++) delta += Math.max(0, (Number(win[i].tokens) || 0) - (Number(win[i - 1].tokens) || 0));
    // 注入的 token 按字数估（中文约一字一个 token，偏保守）
    out.rollingUsed = sum(core.store.all(`SELECT chars, items_json FROM injections WHERE session_id = ? AND mode = 'live' AND seen = 1 AND seen_at >= ?`,
      s.session_id, win[0].at));
    if (share != null) {
      out.rollingLimit = share * delta;
      out.rollingLeft = out.rollingLimit - out.rollingUsed;
    }
  }
  return out;
}

/**
 * 污点账本（§9.4.1）：当前周期里已确认送达、带内容的注入条目（injections.seen=1、mode='live'、cycle = sessions.cycle；
 * 只给了暗示或「还在想」的条目没有内容进上下文，不算），加上本周期常驻区放进过这个会话的条目（场合关着时常驻区不注入，不算）。
 */
export function taintLedger(core, sessionId, { residentLive }) {
  const s = loadSession(core, sessionId);
  if (!s) return [];
  const out = new Set();
  // 新注入的在前（关口②的初筛有条数上限时留下的是最近的，评审）
  for (const row of core.store.all(`SELECT items_json FROM injections WHERE session_id = ? AND cycle = ? AND seen = 1 AND mode = 'live' ORDER BY id DESC`,
    sessionId, s.cycle)) {
    for (const it of safeJson(row.items_json, [])) if (CONTENT.has(it.verdict) && parseRef(it.id)) out.add(it.id);
  }
  if (s.setting_key && residentLive(s.setting_key)) for (const id of s.residentItems) if (parseRef(id)) out.add(id);
  return [...out];
}

export function sessionInfo(core, sessionId) {
  const s = loadSession(core, sessionId);
  if (!s) return null;
  const t = core.state.context?.turns?.get(sessionId) ?? null;
  return {
    sessionId: s.session_id,
    settingKey: s.setting_key ?? null,
    adapter: s.adapter ?? null,
    cycle: s.cycle,
    turnTainted: !!s.taint?.tainted,
    warmPending: !!s.warm_pending,
    triggerEntityIds: Array.isArray(t?.triggerEntityIds) ? [...t.triggerEntityIds] : [],
    focusPerceptId: Number.isSafeInteger(t?.focusPerceptId) ? t.focusPerceptId : null,
    selfTurn: t?.self === true,
    turnAt: Number.isFinite(t?.at) ? t.at : null,
  };
}

function numbersOnly(o) {
  const out = {};
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'number' && Number.isFinite(v) && k.length <= 32) out[k] = v;
  return out;
}
