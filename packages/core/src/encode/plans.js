// 计划和意图（§5.5）：计划的状态机（每一次变化都有出处、都留在历史里）、她自己的意图（形成 → 到时间窗 → 执行 / 撤掉 / 没顾上）、
// 触发前的复核（评审:SC-08）。代码只执行数量上限和「谁能让她有意图」的核验，形不形成由提炼模型判断（评审:UV-19）。
import { listPerceptShards, monthOf } from '../store/fts.js';
import { parseRef } from '../store/refs.js';
import { bumpMetric } from '../store/kv.js';
import {
  param, isNum, jsonParse, clip, mref, rstr, TERMINAL_PLAN, PLAN_STATUSES, localDay, fmtDate, normToInput, HOUR, modeOfPercept,
} from './util.js';
import {
  assertionRow, assertionSubjects, insertSource, writeEpisode, perceptRow, selfIdOf, currentSnapshot, inheritHidden,
} from './write.js';
import { prioritizeExtraction } from './segment.js';

// ── 计划 ─────────────────────────────────────────────────────────────────

/** 实现 encode.transitionPlan。 */
export function transitionPlan(core, assertionId, status, ctx = {}) {
  if (!PLAN_STATUSES.has(status)) throw new TypeError(`不认识的计划状态：${status}`);
  core.store.tx(() => {
    const row = assertionRow(core, assertionId);
    if (!row) throw new Error('transitionPlan：事实不存在');
    const cur = row.plan_status;
    if (cur === status) return;
    // 结案了的计划不会因为「到点没下文」变回不确定（迟到的时间维护）
    if (cur && TERMINAL_PLAN.has(cur) && status === 'unknown') return;
    const at = isNum(ctx.at) ? ctx.at : core.now();
    core.store.run('INSERT INTO plan_status_history(assertion_id, status, at, evidence_percept, source_json) VALUES (?, ?, ?, ?, ?)',
      assertionId, status, at, ctx.evidencePerceptId ?? null, JSON.stringify(ctx.source ?? {}));
    const terminal = TERMINAL_PLAN.has(status);
    core.store.run(`UPDATE assertions SET plan_status = ?, plan_outcome_ref = COALESCE(?, plan_outcome_ref),
                      valid_to_known = CASE WHEN ? = 1 AND valid_to_known IS NULL THEN ? ELSE valid_to_known END, updated_at = ? WHERE id = ?`,
    status, ctx.outcomeRef ?? null, terminal ? 1 : 0, at, core.now(), assertionId);
    if (terminal) {
      // 指向它的意图撤掉，并开始短暂的抑制（她不会事后还去提醒，§5.5 第 3、4 条）
      const open = core.store.all("SELECT id FROM intentions WHERE about_kind = 'assertion' AND about_id = ? AND state IN ('formed','armed')", assertionId);
      for (const i of open) transitionIntention(core, i.id, 'obsolete', { at, reason: `plan-${status}` });
    }
  });
}

/** 一条计划的状态历史（读）。 */
export function planHistory(core, assertionId) {
  return core.store.all('SELECT status, at, evidence_percept, source_json FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id', assertionId)
    .map((r) => ({ status: r.status, at: r.at, evidencePercept: r.evidence_percept, source: jsonParse(r.source_json, {}) }));
}

// ── 意图 ─────────────────────────────────────────────────────────────────

const OPEN = new Set(['formed', 'armed']);
const NEXT = {
  formed: new Set(['armed', 'executed', 'cancelled', 'obsolete', 'lapsed']),
  armed: new Set(['executed', 'cancelled', 'obsolete', 'lapsed']),
};

function authorityOf(core, entityId) {
  if (!entityId) return 'none';
  try { return core.mods.entities.bondOf(core, entityId)?.authority ?? 'none'; } catch { return 'none'; }
}
function principalSet(core) {
  try { return new Set(core.mods.entities.principals(core)); } catch { return new Set(); }
}

/**
 * 「谁能让她有意图」（§5.5 第 2 条、§7.4 第 11 条，评审:PS-15），只看证据的结构：
 *   - self-commitment：证据里必须有她自己的话；
 *   - principal-request：证据里必须有有管理权限的人说的话；
 *   - self-care：内容围绕对方自己的计划或事（about 的主体 / 当事人是对方），或者是对方自己告诉她的；
 *   - act='verify'（核实，§5.5 第 12 条）：对象必须是有管理权限的人。
 * @returns {string|null} 不通过的理由
 */
export function originProblem(core, p, evidence) {
  const target = p.targetEntityId;
  if (p.act === 'verify') return principalSet(core).has(target) ? null : 'verify-target-not-principal';
  if (p.origin === 'self-commitment') return evidence.some((e) => e.actor_self) ? null : 'no-commitment-by-her';
  if (p.origin === 'principal-request') {
    if (p.requestedByPrincipal) return null;
    return evidence.some((e) => !e.actor_self && authorityOf(core, e.actor_entity_id) !== 'none') ? null : 'request-not-by-principal';
  }
  if (p.origin === 'self-care') {
    if (p.about?.kind === 'assertion') {
      const row = assertionRow(core, p.about.id);
      if (row && (row.plan_agent === target || assertionSubjects(core, p.about.id).includes(target))) return null;
    }
    if (evidence.some((e) => e.actor_entity_id === target)) return null;
    return 'not-about-target';
  }
  return 'unknown-origin';
}

/** 实现 encode.formIntention。 */
export function formIntention(core, p, ctx = {}) {
  if (ctx.historical) return null;   // 回填旧日志时不形成意图（§5.5 第 13 条）
  const target = p.targetEntityId;
  if (!Number.isInteger(target) || target <= 0 || !p.act || !p.origin) return null;
  const at = isNum(ctx.at) ? ctx.at : core.now();
  return core.store.tx(() => {
    const evidence = (p.evidencePerceptIds ?? []).map((id) => perceptRow(core, id)).filter(Boolean);
    const problem = originProblem(core, p, evidence);
    if (problem) {
      core.log.debug('encode.intention.rejected', { reason: problem });
      bumpMetric(core.store, 'encode.intention.rejected');
      return null;
    }
    const aboutKind = p.about?.kind ?? null;
    const aboutId = p.about?.id ?? null;
    // 已经有一条一样的还开着：不重复形成
    const dup = core.store.get(`SELECT id FROM intentions WHERE target_entity_id = ? AND act = ? AND state IN ('formed','armed')
                                  AND COALESCE(about_kind, '') = COALESCE(?, '') AND COALESCE(about_id, 0) = COALESCE(?, 0)`,
    target, p.act, aboutKind, aboutId);
    if (dup) return dup.id;
    // 每人每天自动形成的上限（§5.5 第 10 条）；主人明确要求的不算「自动」
    if (p.origin !== 'principal-request') {
      const day = localDay(core, at);
      const n = core.store.all("SELECT formed_at FROM intentions WHERE target_entity_id = ? AND origin <> 'principal-request' AND formed_at >= ?", target, at - 2 * 24 * HOUR)
        .filter((r) => localDay(core, r.formed_at) === day).length;
      if (n >= core.config.get().intention.maxPerPersonPerDay) {
        bumpMetric(core.store, 'encode.intention.capped');
        return null;
      }
    }
    const win = p.trigger?.timeWindow;
    const wStart = isNum(win?.start) ? win.start : null;
    const wEnd = isNum(win?.end) ? win.end : null;
    const state = wStart != null && wStart > at ? 'formed' : 'armed';
    const r = core.store.run(`INSERT INTO intentions(about_kind, about_id, target_entity_id, act, text, origin, trigger_json, state, formed_at, armed_at,
                                window_start, window_end, executions_json, sources_json, job_id, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
    aboutKind, aboutId, target, clip(p.act, 32), clip(p.text ?? '', 120), p.origin,
    JSON.stringify({ timeWindow: wStart != null ? { start: wStart, end: wEnd } : null, cues: (p.trigger?.cues ?? []).slice(0, 8) }),
    state, at, state === 'armed' ? at : null, wStart, wEnd, JSON.stringify(evidence.map((e) => e.id)), ctx.jobId ?? null, core.now(), core.now());
    const id = Number(r.lastInsertRowid);
    const ref = mref('intention', id);
    for (const e of evidence) {
      insertSource(core, { kind: 'intention', id }, {
        perceptId: e.id, speaker: e.actor_entity_id, asserter: e.actor_entity_id, mode: modeOfPercept(e), hop: 0, quote: null,
        confidence: 0.8, at: e.at, jobId: ctx.jobId ?? null,
      });
    }
    // 规范继承 about 和形成证据里最严的（评审:PS-15）；她自己的打算只有她自己知道（推断类）
    const evidenceRefs = [...(aboutId ? [mref(aboutKind, aboutId)] : []), ...evidence.map((e) => mref('percept', e.id))];
    core.mods.discretion.inheritNorm(core, ref, evidenceRefs, { derivation: 'inference', at });
    if (evidence.length) inheritHidden(core, rstr('intention', id), core.now());   // 只靠隐藏了的消息形成的意图一形成就对别人隐藏（§12.7）
    if (p.text) core.mods.worker.enqueueEmbed(core, ref, [{ chunkNo: 0, kind: 'text', text: clip(p.text, 120) }], { layer: 'memory', priority: 2 });
    bumpMetric(core.store, 'encode.intention.formed');
    return id;
  });
}

/** 实现 encode.transitionIntention。不合法的转换（已经结束的意图）什么都不做。 */
export function transitionIntention(core, intentionId, state, ctx = {}) {
  core.store.tx(() => {
    const row = core.store.get('SELECT * FROM intentions WHERE id = ?', intentionId);
    if (!row) throw new Error('transitionIntention：意图不存在');
    if (!NEXT[row.state]?.has(state)) return;
    const at = isNum(ctx.at) ? ctx.at : core.now();
    core.store.run(`UPDATE intentions SET state = ?, armed_at = CASE WHEN ? = 'armed' THEN ? ELSE armed_at END,
                      suppressed_at = CASE WHEN ? IN ('obsolete','cancelled') THEN ? ELSE suppressed_at END, updated_at = ? WHERE id = ?`,
    state, state, at, state, at, core.now(), intentionId);
    if (state === 'lapsed') writeLapse(core, row, at);
  });
}

/** 没顾上（§5.5 第 11 条）：一条低强度的情节，只有她自己知道，自然淡忘。 */
function writeLapse(core, row, at) {
  const evidenceIds = jsonParse(row.sources_json, []);
  const first = evidenceIds.map((id) => perceptRow(core, id)).find(Boolean);
  let settingKey = first?.setting_key ?? null;
  if (!settingKey && row.about_kind === 'assertion') {
    settingKey = core.store.get("SELECT p.setting_key FROM sources s JOIN percepts p ON p.id = s.percept_id WHERE s.owner_kind = 'assertion' AND s.owner_id = ? LIMIT 1", row.about_id)?.setting_key ?? null;
  }
  settingKey ??= core.keys.hash('encode', 'inner');
  let norm = null;
  try { norm = normToInput(core.mods.discretion.normOf(core, mref('intention', row.id))); } catch { norm = null; }
  const text = clip(row.text || row.act, 60);
  writeEpisode(core, {
    settingKey,
    kind: 'lapse',
    title: clip(`没顾上：${text}`, 40),
    header: `${fmtDate(core, row.formed_at)} 起想${text}，到 ${fmtDate(core, at)} 也没顾上`,
    narrative: `那阵子想${text}，没顾上。`,
    tStart: row.formed_at,
    tEnd: at,
    participants: [row.target_entity_id].filter(Boolean),
    sources: [{ perceptId: null, speaker: selfIdOf(core), asserter: selfIdOf(core), mode: 'inferred', hop: 0, quote: null, confidence: 1, at }],
    norm: { ...(norm ?? {}), originExposure: { exposureRank: 0, persistenceRank: 1, visibleTo: 'her-only' } },
    noKnowledge: true,
    w: param(core, 'intention.lapseW'),
  });
}

/** 实现 encode.recordExecution（以人为单位，§5.5 第 8 条）。 */
export function recordExecution(core, intentionId, exec) {
  core.store.tx(() => {
    const row = core.store.get('SELECT * FROM intentions WHERE id = ?', intentionId);
    if (!row) throw new Error('recordExecution：意图不存在');
    const list = jsonParse(row.executions_json, []);
    list.push({ at: exec.at, settingKey: exec.settingKey, targetEntityId: exec.targetEntityId, utteranceRef: exec.utteranceRef ?? null });
    core.store.run(`UPDATE intentions SET executions_json = ?, state = CASE WHEN state IN ('formed','armed') THEN 'executed' ELSE state END,
                      updated_at = ? WHERE id = ?`, JSON.stringify(list.slice(-20)), core.now(), intentionId);
  });
}

/** 这个人最近一次被她「问过 / 说过」是什么时候（所有意图的执行记录，不管哪个场合）。 */
function lastExecutionAt(core, targetEntityId) {
  let last = -Infinity;
  for (const r of core.store.all("SELECT executions_json FROM intentions WHERE target_entity_id = ? AND executions_json <> '[]'", targetEntityId)) {
    for (const e of jsonParse(r.executions_json, [])) if (isNum(e.at) && e.at > last) last = e.at;
  }
  return last;
}

/** 意图的场合属性条件（「下次和主人一对一时」）：{settingAttrs: {maxExposureRank}}。条件不满足就不浮上来。 */
function settingAttrsOk(core, cues, settingKey) {
  const conds = cues.filter((c) => c && typeof c === 'object' && c.settingAttrs);
  if (!conds.length) return true;
  const snap = currentSnapshot(core, settingKey);
  const rank = snap?.exposure_rank;
  return conds.every((c) => {
    const max = c.settingAttrs.maxExposureRank;
    if (isNum(max)) return isNum(rank) && rank <= max;
    return true;
  });
}

/** 过了时间窗多少（≥ 0）：weight × log1p(超时 / 窗口长度)，窗口长度不知道时按 1 天算。 */
function overdueOf(r, at, weight) {
  if (!isNum(r?.window_end) || !(at > r.window_end)) return 0;
  const span = isNum(r.window_start) && r.window_end > r.window_start ? r.window_end - r.window_start : 24 * HOUR;
  return weight * Math.log1p((at - r.window_end) / span);
}

/** 实现 encode.intentionOverdue。 */
export function intentionOverdue(core, row, at) {
  const w = core.config.get().intention.overdueWeight;
  return overdueOf(row, isNum(at) ? at : core.now(), isNum(w) ? w : 0.5);
}

/**
 * 实现 encode.dueIntentions。没有硬到期（D103）：过了 window_end 的照样到点，只是按超时的多少平滑减分
 * （overdue = intention.overdueWeight × log1p(超时 / 窗口长度)，调用方从激活里减掉，渲染成「本来打算……，已经过了时间」）；
 * 对同一个人的冷却不管主人要她做的事（origin = 'principal-request'：他让她做，不是她自己找话说）；新形成的排在前面。
 */
export function dueIntentions(core, q) {
  const at = isNum(q.at) ? q.at : core.now();
  const present = new Set(q.presentEntityIds ?? []);
  const cueIds = new Set(q.cueEntityIds ?? []);
  const icfg = core.config.get().intention;
  const cooldownMs = icfg.cooldownH * HOUR;
  const overdueW = isNum(icfg.overdueWeight) ? icfg.overdueWeight : 0.5;
  const rows = core.store.all(`SELECT * FROM intentions WHERE state IN ('armed','formed') ORDER BY formed_at DESC, id DESC`);
  const out = [];
  const lastExec = new Map();
  for (const r of rows) {
    if (r.state === 'formed' && !(isNum(r.window_start) && r.window_start <= at)) continue;   // 还没到时间窗
    const trigger = jsonParse(r.trigger_json, {});
    const cues = Array.isArray(trigger.cues) ? trigger.cues : [];
    if (!settingAttrsOk(core, cues, q.settingKey)) continue;
    const entityCues = cues.filter((c) => c && Number.isInteger(c.entity)).map((c) => c.entity);
    const targetHere = present.has(r.target_entity_id);
    const cueHit = entityCues.some((e) => cueIds.has(e) || (e !== r.target_entity_id && present.has(e))) || cueIds.has(r.target_entity_id);
    if (!targetHere && !cueHit) continue;
    if (r.origin !== 'principal-request') {
      if (!lastExec.has(r.target_entity_id)) lastExec.set(r.target_entity_id, lastExecutionAt(core, r.target_entity_id));
      if (at - lastExec.get(r.target_entity_id) < cooldownMs) continue;   // 对同一个人问过以后的冷却（她自己找话说的才有）
    }
    // 过了时间窗：不丢掉，按超时占窗口长度的比例平滑减分（窗口长度不知道时按 1 天算）
    const overdue = overdueOf(r, at, overdueW);
    out.push({ ...r, ref: rstr('intention', r.id), trigger, executions: jsonParse(r.executions_json, []), cueHit, overdue });
  }
  out.sort((a, b) => (Number(b.cueHit) - Number(a.cueHit)) || (a.overdue - b.overdue) || (b.formed_at - a.formed_at) || (b.id - a.id));
  return out;
}

// ── 触发前的复核（§5.5 第 6 条，评审:SC-08） ────────────────────────────────
//   要找的是「还没细想过的完成证据」：意图形成以来、提炼还没看过的原始感知（不限场合）。提炼过的感知已经由提炼按背景判过
//   （是完成证据的话计划早就结案、意图早就撤掉了），再拿来压意图只会让「快递还没拿到」这种话永远压住追问。
//   三种命中：
//     - 向量：原文窗口和意图（加它指向的事、将来可能被问的问题）语义相近（换个说法也认得出：「快递」↔「取了包裹」）；
//     - 词法：和这些文字有足够多的共同词（OR 查询里单个常见词不算）；
//     - 旁听到当事人自己说的话：当事人（意图对象、计划的主人）后来在她只是旁听的地方说过话、还没提炼——
//       「拿到了」这种话没有共同词，也不一定和「去拿快递」向量相近，只有放进上下文才看得懂，所以先当可能的证据，
//       提到提炼队列最前，等提炼看过再说（对她说的话本来就在她眼前的对话里，不算这一种）。

/** 意图要核对的文字：意图本身、它指向的事（计划 / 事实 / 情节）、那条事实的 future_q（「快递拿了没」）。 */
function aboutTexts(core, row) {
  const out = [row.text];
  if (row.about_kind === 'assertion' && row.about_id) {
    const a = assertionRow(core, row.about_id);
    if (a) out.push(a.text, a.value);
    for (const r of core.store.all("SELECT text FROM embed_texts WHERE owner_kind = 'assertion' AND owner_id = ? AND kind = 'fq'", row.about_id)) out.push(r.text);
  } else if (row.about_kind === 'episode' && row.about_id) {
    const e = core.store.get('SELECT title, header, narrative FROM episodes WHERE id = ?', row.about_id);
    if (e) out.push(e.title, e.header, e.narrative);
  }
  return out.filter((t) => typeof t === 'string' && t.trim());
}

/** 实现 encode.intentionTexts：一条意图要核对的文字（和触发前复核同一份，aboutTexts）。意图不存在返回 []。 */
export function intentionTexts(core, intentionId) {
  const row = core.store.get('SELECT * FROM intentions WHERE id = ?', intentionId);
  return row ? aboutTexts(core, row) : [];
}

/** 这件事的当事人：意图对象，加上它指向的计划的主人和主体（不含她自己）。 */
function peopleOf(core, row) {
  const ids = new Set([row.target_entity_id]);
  if (row.about_kind === 'assertion' && row.about_id) {
    const a = assertionRow(core, row.about_id);
    if (a?.plan_agent) ids.add(a.plan_agent);
    for (const s of assertionSubjects(core, row.about_id)) ids.add(s);
  }
  ids.delete(selfIdOf(core));
  return [...ids].filter((x) => Number.isInteger(x) && x > 0);
}

function terms(core, text) {
  try { return [...new Set(core.mods.lang.queryTerms(core, text))]; } catch { return []; }
}

/** 实现 encode.recheckIntention：命中可能的完成证据就先压住（她不会追问一件对方刚说过的事）。复核本身出错只降级，不抛错。 */
export async function recheckIntention(core, intentionId, opt = {}) {
  const none = { suppress: false, perceptIds: [] };
  try {
    const row = core.store.get('SELECT * FROM intentions WHERE id = ?', intentionId);
    if (!row || !OPEN.has(row.state)) return none;
    if (core.config.get().intention.preTriggerRecheck === false) return none;
    const now = core.now();
    const since = row.formed_at;
    const own = new Set(jsonParse(row.sources_json, []));
    const texts = aboutTexts(core, row);
    const joined = texts.join(' / ');
    const qTerms = terms(core, joined);
    const people = new Set(peopleOf(core, row));
    const minHits = param(core, 'intention.recheckMinTerms');
    const deadlineMs = param(core, 'intention.recheckDeadlineMs');
    const overheardMs = param(core, 'intention.recheckOverheardH') * HOUR;
    const candidates = new Map();
    const consider = (p) => {
      if (!p || p.at <= since || p.actor_self || own.has(p.id) || p.text == null || p.episode_id != null) return;
      if (p.kind === 'retract' || p.text_state === 'retracted') return;
      candidates.set(p.id, p);
    };
    // 1) 词法：意图形成以来的原文分表（不限场合）
    if (qTerms.length) {
      try {
        const sinceMonth = monthOf(since);
        const tables = listPerceptShards(core.store).filter((t) => t.slice(-6) >= sinceMonth);
        if (tables.length) {
          const r = await core.mods.worker.lexicalSearch(core, { terms: qTerms.slice(0, 12), tables, limit: 50 }, { deadlineMs, signal: opt.signal });
          for (const h of r?.hits ?? []) {
            const r1 = parseRef(h.ref);
            if (r1?.kind === 'percept') consider(perceptRow(core, r1.id));
          }
        }
      } catch { /* 词法路不可用：下面照样查当事人自己的话 */ }
    }
    // 2) 当事人自那以后说过、还没提炼的话（任何场合；也是词法路的退路）
    if (people.size) {
      const ids = [...people];
      for (const p of core.store.all(`SELECT * FROM percepts WHERE actor_entity_id IN (${ids.map(() => '?').join(',')}) AND at > ? AND episode_id IS NULL
                                       ORDER BY id DESC LIMIT 200`, ...ids, since)) consider(p);
    }
    // 3) 向量：原文窗口层
    const semantic = new Set();
    try {
      // 每段文字一条查询向量（意图、指向的事、future_q），每个窗口取较大的相似度（§8.1 的做法）
      const q = await core.mods.worker.embedQuery(core, texts.slice(0, 4), { deadlineMs, signal: opt.signal });
      if (q?.vectors?.length) {
        const r = await core.mods.worker.denseSearch(core, { vectors: q.vectors, spaceId: q.spaceId, layers: ['raw'], topK: { memory: 0, raw: 20 }, includeCold: true },
          { deadlineMs, signal: opt.signal });
        const minCos = param(core, 'intention.recheckCos');
        for (const h of r?.hits ?? []) {
          const wr = parseRef(h.ref);
          if (!(h.score >= minCos) || wr?.kind !== 'window') continue;
          const w = core.store.get('SELECT * FROM raw_windows WHERE id = ?', wr.id);
          if (!w || w.t_end <= since) continue;
          const members = jsonParse(w.members_json, null);
          const rows = Array.isArray(members) && members.length
            ? core.store.all(`SELECT * FROM percepts WHERE id IN (${members.map(() => '?').join(',')})`, ...members)
            : core.store.all('SELECT * FROM percepts WHERE setting_key = ? AND id BETWEEN ? AND ?', w.setting_key, w.first_percept, w.last_percept);
          for (const p of rows) {
            consider(p);
            if (candidates.has(p.id)) semantic.add(p.id);
          }
        }
      }
    } catch { /* 嵌入不可用（L3）：只靠词法和当事人的话 */ }
    const hits = [];
    for (const p of candidates.values()) {
      if (semantic.has(p.id)) { hits.push(p.id); continue; }
      const pt = terms(core, p.text);
      const shared = qTerms.filter((t) => pt.includes(t)).length;
      if (shared >= minHits || (qTerms.length < minHits && shared === qTerms.length && shared > 0)) { hits.push(p.id); continue; }
      if (people.has(p.actor_entity_id) && p.addressed === 'ambient' && now - p.at <= overheardMs) hits.push(p.id);
    }
    if (!hits.length) return none;
    hits.sort((a, b) => a - b);
    try { prioritizeExtraction(core, hits, { at: now }); } catch (e) { core.log.warn('encode.recheck.prioritize', { error: e?.code ?? e?.name ?? 'Error' }); }
    bumpMetric(core.store, 'encode.intention.recheckSuppressed');
    return { suppress: true, perceptIds: hits };
  } catch (e) {
    try { bumpMetric(core.store, 'encode.errors.recheck'); } catch { /* 只读库 */ }
    core.log.warn('encode.recheck.failed', { intentionId, error: e?.code ?? e?.name ?? 'Error' });
    return none;
  }
}
