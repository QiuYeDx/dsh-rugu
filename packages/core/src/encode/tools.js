// 工具和导入（§10.8、§4.5）。授权全部由代码判定，依据是库里存的那条感知，不是工具参数：
//   1. 这一轮必须是由一条带身份证据的消息直接触发的（triggerObsId → keys.obsKey，按已注册的每个适配器找；两个都有 → fail closed）；
//      【D114】调用方可以多给几条（triggerObsIds：这一轮她看到的、别人对她说的，读消息工具的结果里来的也算）：按库里的时间从新到旧，
//      取第一条合格、含有 evidence_quote、还没做过操作的那条——授权照样只看那一条感知自己的说话人（主人的权限只能来自主人自己的消息）；
//   2. evidence_quote 必须能在那条消息里找到（规范化后比：全角半角、标点、空白不算差别）；text / new_text 也要在那条消息里有依据；
//   3. 一条消息只执行一个操作（meta 'encode.toolOp.<感知 id>'，和操作本身同一个事务）；
//   4. 主人：直接生效；当事人本人（权利层确认）：可以要求忘掉关于自己的事（立即对别人隐藏 + 进审核）；其他人：一律只进审核队列。
// 导入：来源方式 imported，不加激活痕迹（§6.4）；名字按名字表认人，认不出建 provisional（entities.resolveExtracted）。
import { getMeta, setMeta, bumpMetric } from '../store/kv.js';
import { parseRef } from '../store/refs.js';
import { ftsSearch } from '../store/fts.js';
import { param, isNum, clip, quoteMatches, jaccard, normText, mref, rstr, modeOfPercept, normToInput, jsonParse, HOUR } from './util.js';
import {
  writeAssertion, writeEpisode, supersede, addSource, assertionRow, assertionSubjects, assertionEntities, perceptRow, selfIdOf,
} from './write.js';
import { formIntention } from './plans.js';
import { reconcileSync } from './reconcile.js';
import { LESSON_KIND, confirmLesson, correctedLessonValue } from './lessons.js';

const errCode = (e) => e?.code ?? e?.name ?? 'Error';
const rejected = (reason) => ({ status: 'rejected', reason });

class Abort extends Error { constructor(reason) { super(reason); this.reason = reason; } }

function terms(core, text) {
  try { return [...new Set(core.mods.lang.queryTerms(core, String(text ?? '')))]; } catch { return []; }
}
function authorityOf(core, id) {
  if (!id) return 'none';
  try { return core.mods.entities.bondOf(core, id)?.authority ?? 'none'; } catch { return 'none'; }
}

// ── 触发消息 ──────────────────────────────────────────────────────────────

/** triggerObsId → 库里那条感知。按已注册的每个适配器算 obsKey；两个适配器都有（撞车）→ 'ambiguous'。 */
export function findTrigger(core, triggerObsId) {
  const found = [];
  for (const adapterId of core.adapters.keys()) {
    const key = core.keys.obsKey(adapterId, triggerObsId);
    const row = core.store.get('SELECT * FROM percepts WHERE adapter = ? AND ext_key = ?', adapterId, key);
    if (row) found.push(row);
  }
  if (found.length > 1) return 'ambiguous';
  return found[0] ?? null;
}

/** 这条感知能不能授权一次工具操作（§10.8 第 1 条）。 */
export function triggerProblem(core, p) {
  if (!p) return 'trigger-not-found';
  if (p === 'ambiguous') return 'trigger-ambiguous';
  if (p.actor_self) return 'trigger-by-her';
  if (p.kind !== 'utterance') return 'trigger-not-a-message';   // 定时任务、系统提示、素材都不算
  if (p.relay_of) return 'trigger-relayed';
  if (p.historical) return 'trigger-historical';
  if (!p.evidential) return 'trigger-not-evidential';
  if (p.text == null || p.text_state === 'retracted') return 'trigger-text-gone';
  if (!p.actor_entity_id) return 'trigger-speaker-unknown';
  if (!core.store.get('SELECT 1 FROM identity_evidence WHERE entity_id = ? LIMIT 1', p.actor_entity_id)) return 'trigger-no-identity';
  return null;
}

/**
 * evidence_quote 够不够当证据（D114 集成复核）：规范化后能在消息里找到（quoteMatches），而且不是随手一两个字——
 * 规范化后至少 2 个字（消息本身只有 1 个字时照抄整条）；用「…」省略中间的，每一段至少 2 个字（「你…记…错」这种拼出来的不算）。
 */
export function quoteOk(quote, text) {
  if (!quoteMatches(quote, text)) return false;
  const parts = String(quote ?? '').split(/…+|\.{3,}/).map(normText).filter(Boolean);
  const total = parts.reduce((n, x) => n + [...x].length, 0);
  if (total < Math.min(2, [...normText(text)].length)) return false;
  if (parts.length > 1 && parts.some((x) => [...x].length < 2)) return false;
  return true;
}

/**
 * 这次操作的触发消息（D114）：triggerObsId 和 triggerObsIds 里合格的感知，按库里的时间从新到旧，取第一条含有 evidenceQuote 的；
 * 同一条已经做过操作的往后让（都做过了照样交出去，由事务里的登记报 one-op-per-message）。
 * 一条合格的都没有 → 第一个候选的问题；有合格的但都不含原话 → quote-not-in-message。
 * mixed：合格的候选里还有别人（不是这条的说话人）也在对她说话——这时她可能是在替那个人办事、只是引用了这个人的一句话，
 * 调用方据此要求这条消息本身讲的就是这件事（fix 的 forget / confirm 核对 target，D114 集成复核）。
 * @returns {{p: object, obsId: string, mixed: boolean, problem?: undefined}|{problem: string}}
 */
export function pickTrigger(core, req) {
  const ids = [...new Set([req.triggerObsId, ...(Array.isArray(req.triggerObsIds) ? req.triggerObsIds : [])].filter((x) => typeof x === 'string' && x))].slice(0, 9);
  const ok = [];
  let first = null;
  for (const obsId of ids) {
    const p = findTrigger(core, obsId);
    const problem = triggerProblem(core, p);
    if (problem) { first ??= problem; continue; }
    if (!ok.some((x) => x.p.id === p.id)) ok.push({ p, obsId });
  }
  if (!ok.length) return { problem: first ?? 'trigger-not-found' };
  ok.sort((a, b) => (b.p.at - a.p.at) || (b.p.id - a.p.id));
  const hits = ok.filter((x) => quoteOk(req.evidenceQuote, x.p.text));
  if (!hits.length) return { problem: 'quote-not-in-message' };
  const pick = hits.find((x) => getMeta(core.store, opKey(x.p.id)) == null) ?? hits[0];
  return { ...pick, mixed: ok.some((x) => x.p.actor_entity_id !== pick.p.actor_entity_id) };
}

/** text 在那条消息里有没有依据：规范化后是子串，或它的词大部分出现在消息里。 */
export function supportedBy(core, text, message) {
  if (!text) return false;
  if (quoteMatches(text, message)) return true;
  const t = terms(core, text);
  if (!t.length) return normText(message).includes(normText(text));
  const m = new Set(terms(core, message));
  const covered = t.filter((x) => m.has(x)).length / t.length;
  return covered >= param(core, 'tools.textSupportMin');
}

const opKey = (perceptId) => `encode.toolOp.${perceptId}`;
/** 一条消息只执行一个操作：在调用方的事务里登记；已经登记过返回 false。 */
function claimOp(core, perceptId, op) {
  if (getMeta(core.store, opKey(perceptId)) != null) return false;
  setMeta(core.store, opKey(perceptId), JSON.stringify({ op, at: core.now() }));
  return true;
}

/** 原话在消息里的位置（审核队列的 payload 只放引用和位置，不放原文）。 */
function spanOf(text, quote) {
  const i = String(text ?? '').indexOf(String(quote ?? ''));
  return i >= 0 && quote ? [i, i + quote.length] : null;
}

/** about（名字）→ 实体：名字表里唯一完整命中才算；拿不准不认。 */
export function resolveName(core, name, settingKey) {
  if (!name) return null;
  let hits = [];
  try { hits = core.mods.entities.nameMatcher(core).scan(name, { settingKey }) ?? []; } catch { hits = []; }
  const full = [...new Set(hits.filter((h) => normText(h.name) === normText(name)).map((h) => h.entityId))];
  return full.length === 1 ? full[0] : null;
}

function whenWindow(core, when, at) {
  if (!when) return null;
  try {
    const w = core.mods.lang.registry(core).parseTime(when, at)?.[0];
    if (w && isNum(w.start)) return { start: w.start, end: isNum(w.end) ? w.end : w.start + HOUR };
  } catch { /* 解析不了：没有时间窗，靠线索触发 */ }
  return null;
}

// ── memory_note ──────────────────────────────────────────────────────────

function applyNote(core, { op, p, text, about, when, quote, by }) {
  const cfg = core.config.get();
  const subject = about ?? by;
  if (op === 'todo') {
    const id = formIntention(core, {
      about: null, targetEntityId: subject, act: 'remind', text: clip(text, 120), origin: 'principal-request', requestedByPrincipal: true,
      trigger: { timeWindow: when, cues: [{ entity: subject }] }, evidencePerceptIds: [p.id],
    }, { at: p.at });
    if (!id) throw new Abort('intention-not-formed');
    return rstr('intention', id);
  }
  const att = cfg.activation.attention[p.attention_class] ?? cfg.activation.attention.toHer;
  const closeness = core.store.get('SELECT closeness FROM entities WHERE id = ?', by)?.closeness ?? 0;
  const imp = param(core, 'tools.noteImp');
  const self = selfIdOf(core);
  const id = writeAssertion(core, {
    subjects: [subject], predicate: '记住的事', value: null, text: clip(text, cfg.extract.factTextMax), kindHint: 'fact',
    certainty: subject === by || subject === self ? 'stated' : 'hearsay', confidence: 0.9, imp, pinned: true,
    sources: [{ perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: by, asserter: by, mode: modeOfPercept(p),
      hop: subject === by ? 0 : 1, quote, confidence: 0.9, at: p.at }],
    norm: {}, w: core.mods.dynamics.encodingWeight(core, { wAtt: att, imp, closeness }),
  });
  return rstr('assertion', id);
}

/** 实现 encode.note。 */
export async function note(core, req) {
  const trig = pickTrigger(core, req);
  if (trig.problem) return rejected(trig.problem);
  const { p, obsId } = trig;
  if (!supportedBy(core, req.text, p.text)) return rejected('text-not-supported');
  const by = p.actor_entity_id;
  const about = resolveName(core, req.about, p.setting_key);
  const when = whenWindow(core, req.when, p.at);
  try {
    return core.store.tx(() => {
      if (!claimOp(core, p.id, `note:${req.op}`)) throw new Abort('one-op-per-message');
      if (authorityOf(core, by) !== 'principal') {
        const id = core.mods.admin.enqueueReview(core, {
          kind: 'owner_op', payload: { tool: 'note', op: req.op, perceptId: p.id, span: spanOf(p.text, req.evidenceQuote), about, when }, reason: 'tool-by-non-principal',
        });
        bumpMetric(core.store, 'encode.tool.review');
        return { status: 'review', refs: [`review:${id}`], triggerObsId: obsId };
      }
      const ref = applyNote(core, { op: req.op, p, text: req.text, about, when, quote: req.evidenceQuote, by });
      bumpMetric(core.store, 'encode.tool.note');
      return { status: 'done', refs: [ref], triggerObsId: obsId };
    });
  } catch (e) {
    if (e instanceof Abort) return rejected(e.reason);
    core.log.warn('encode.note.failed', { error: errCode(e) });
    throw e;
  }
}

// ── memory_fix ───────────────────────────────────────────────────────────

/** 多字的词（二元组、词典词）够用时只用它们：单字（「的」「我」「群」）几乎每条都有，只会稀释（D114）。 */
function keyTerms(list) {
  const multi = list.filter((t) => [...t].length >= 2);
  return multi.length >= 2 ? multi : list;
}
/** target 里用引号括起来的几段（「…」『…』“…”"…"）：她照着那条记忆原来的说法引用的。 */
const QUOTED = /[「『“"]([^「『“"」』”"]{1,200})[」』”"]/gu;
/**
 * target 的描述和一条记忆有多像（0–1，D114 集成复核后）。两种看法：
 *   fuzzy：词的 Jaccard（单字、二元组、词典词，和 D114 之前一样保守）；
 *   literal：照抄的原话——整个 target 就是这条记忆的一段（或者整条记忆就在 target 里），或者 target 里引号括起来的一段（至少 4 个字）
 *            整段出现在这条记忆里（「你记的『收不到群里的消息』是错的」）；分数是这一段占这条记忆的比例。
 *   只共用一段开头（「我不喜欢」「主人说过」「我只能翻自己的」）不算照抄：那只是同一种说法，不是同一件事。
 * @returns {{s: number, literal: number}}
 */
export function targetSim(core, target, text) {
  const fuzzy = jaccard(terms(core, target), terms(core, text));
  const nt = normText(target);
  const nx = normText(text);
  const lt = [...nt].length;
  const lx = [...nx].length;
  let literal = 0;
  if (Math.min(lt, lx) >= 4 && (nx.includes(nt) || nt.includes(nx))) literal = Math.min(lt, lx) / Math.max(lt, lx);
  for (const m of String(target ?? '').matchAll(QUOTED)) {
    const seg = normText(m[1]);
    const ls = [...seg].length;
    if (ls >= 4 && lx && nx.includes(seg)) literal = Math.max(literal, ls / lx);
  }
  return { s: Math.max(fuzzy, literal), literal };
}

/**
 * fix 的 target：记忆引用（'a12'），或一段描述（在事实和情节里找最像的）。
 *   找到：{ref, s, literal, candidates}（literal：是不是照抄了那条的原话；candidates：最像的那几条的开头，给「拿不准」时问清楚）；
 *   两条差不多像：{ambiguous: true, candidates}；没有够像的：null。
 * kinds：只在这几种里找（改正、确认只对事实）。excludePercept：这条消息自己记下来的事实不算（忘掉、改正时：提炼刚从这条纠正里
 * 记下的新说法不是要动的那条，11-06 的 a492；情节照常算——一段经历里本来就有这条消息）。
 */
async function resolveTarget(core, target, { kinds = ['assertion', 'episode'], excludePercept = null } = {}) {
  const r = parseRef(String(target ?? '').trim());
  if (r && kinds.includes(r.kind)) {
    const ok = r.kind === 'assertion' ? assertionRow(core, r.id) : core.store.get('SELECT id FROM episodes WHERE id = ?', r.id);
    return ok ? { ref: r, s: 1, literal: 1, candidates: [] } : null;
  }
  const all = terms(core, target);
  if (!all.length) return null;
  // 查询词：多字词在前（单字太常见，前 12 个全是它们就查不到要找的那条）
  const key = keyTerms(all);
  const qt = [...key, ...all.filter((x) => !key.includes(x))];
  const tables = [...(kinds.includes('assertion') ? ['assertions_fts'] : []), ...(kinds.includes('episode') ? ['episodes_fts'] : [])];
  let refs = [];
  try {
    const res = await core.mods.worker.lexicalSearch(core, { terms: qt.slice(0, 12), tables, limit: 20 }, { deadlineMs: param(core, 'tools.searchDeadlineMs') });
    refs = (res?.hits ?? []).map((h) => parseRef(h.ref)).filter((x) => x && kinds.includes(x.kind));
  } catch { refs = []; }
  // 事实表再直接查（表小，管理和工具调用才用）：词法路的前 20 名可能被情节占满；后面的词也给一次机会；照抄的原话按字面再找一次
  if (kinds.includes('assertion')) {
    for (const part of [qt.slice(0, 12), qt.slice(12, 24)]) {
      if (!part.length) continue;
      try { refs.push(...ftsSearch(core.store, 'assertions_fts', part, { limit: 20 }).map((h) => ({ kind: 'assertion', id: h.rowid }))); } catch { /* 查不了就算了 */ }
    }
    const lits = [String(target ?? '').trim(), ...[...String(target ?? '').matchAll(QUOTED)].map((m) => m[1].trim())].filter((x) => [...x].length >= 4).slice(0, 6);
    for (const lit of lits) {
      const like = `%${lit.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      try { refs.push(...core.store.all("SELECT id FROM assertions WHERE text LIKE ? ESCAPE '!' ORDER BY id DESC LIMIT 20", like).map((x) => ({ kind: 'assertion', id: x.id }))); } catch { /* 查不了就算了 */ }
    }
  }
  const seen = new Set();
  refs = refs.filter((x) => { const k = `${x.kind}:${x.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (excludePercept != null) {
    refs = refs.filter((x) => x.kind !== 'assertion' || !core.store.get("SELECT 1 FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? AND percept_id = ? LIMIT 1", x.id, excludePercept));
  }
  const scored = refs.map((x) => {
    const row = x.kind === 'assertion' ? assertionRow(core, x.id) : core.store.get('SELECT title, narrative FROM episodes WHERE id = ?', x.id);
    const text = x.kind === 'assertion' ? row?.text : row?.narrative;
    const sim = text ? targetSim(core, target, text) : { s: 0, literal: 0 };
    return { ref: x, text, s: sim.s, literal: sim.literal, cur: x.kind === 'assertion' ? row?.superseded_by == null : true };
  }).sort((a, b) => (b.s - a.s) || (Number(b.cur) - Number(a.cur)));
  if (!scored.length || scored[0].s < param(core, 'tools.targetMinSim')) return null;
  const close = scored.filter((x) => scored[0].s - x.s < 0.05);
  const candidates = close.slice(0, 3).map((x) => clip(String(x.text ?? ''), 40));
  if (close.length > 1) return { ambiguous: true, candidates };
  const top = scored[0];
  return { ref: top.ref, s: top.s, literal: top.literal >= param(core, 'tools.targetMinSim') ? top.literal : 0, candidates };
}

function subjectsOf(core, ref) {
  if (ref.kind === 'assertion') return assertionSubjects(core, ref.id);
  return jsonParse(core.store.get('SELECT participants_json FROM episodes WHERE id = ?', ref.id)?.participants_json, []);
}
function isSubjectOf(core, by, ref) {
  const subs = subjectsOf(core, ref).filter((x) => x !== selfIdOf(core));
  return subs.includes(by) || subs.some((s) => { try { return !!core.mods.entities.rightsHolder(core, by, s); } catch { return false; } });
}

function applyCorrect(core, { ref, p, newText, quote, by }) {
  if (ref.kind !== 'assertion') throw new Abort('target-not-a-fact');
  const old = assertionRow(core, ref.id);
  if (!old) throw new Abort('target-gone');
  const roles = assertionEntities(core, ref.id);
  let norm = {};
  try { norm = normToInput(core.mods.discretion.normOf(core, mref('assertion', ref.id))) ?? {}; } catch { norm = {}; }
  const cfg = core.config.get();
  const att = cfg.activation.attention[p.attention_class] ?? cfg.activation.attention.toHer;
  const isSub = (roles.subject ?? []).includes(by);
  const id = writeAssertion(core, {
    subjects: roles.subject ?? [], objectEntityId: old.object_entity_id, mentions: roles.mention ?? [], predicate: old.predicate,
    // 经验（D124）：主人改正的那一版照旧的范围（工具、场合），算验证过
    value: old.kind_hint === LESSON_KIND ? correctedLessonValue(old) : null,
    text: clip(newText, cfg.extract.factTextMax), kindHint: old.kind_hint, certainty: 'confirmed', confidence: 0.9, imp: old.imp,
    eventTime: old.event_start != null ? { start: old.event_start, end: old.event_end, precision: old.event_precision } : null,
    plannedTime: jsonParse(old.planned_time_json, null), validFrom: old.valid_from,
    survival: old.t50_h ? { t50h: old.t50_h, shape: old.shape ?? 1 } : null,
    plan: old.plan_status ? { agent: old.plan_agent, status: old.plan_status } : null,
    sources: [{ perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: by, asserter: by, mode: modeOfPercept(p),
      hop: isSub ? 0 : 1, quote, confidence: 0.9, at: p.at }],
    norm, w: core.mods.dynamics.encodingWeight(core, { wAtt: att, imp: old.imp, closeness: core.store.get('SELECT closeness FROM entities WHERE id = ?', by)?.closeness ?? 0 }),
  });
  // 纠正：新的说法和旧的覆盖同一段时间（旧的等于从来没成立过），两条都保留
  supersede(core, ref.id, id, { at: core.now() });
  return rstr('assertion', id);
}

function applyConfirm(core, { ref, p, by }) {
  if (ref.kind !== 'assertion') throw new Abort('target-not-a-fact');
  const row = assertionRow(core, ref.id);
  if (!row) throw new Abort('target-gone');
  const cfg = core.config.get();
  const now = core.now();
  core.store.run('UPDATE assertions SET certainty = ?, updated_at = ? WHERE id = ?', 'confirmed', now, ref.id);
  if (row.t50_h) core.store.run('UPDATE assertions SET valid_from = ?, updated_at = ? WHERE id = ?', p.at, now, ref.id);   // 本人确认 = 重置
  // 经验（D124）：主人确认的（applyConfirm 只在主人或本人发起时走到；经验的主体是她，本人确认走不到这里）算验证过
  if (row.kind_hint === LESSON_KIND) confirmLesson(core, ref.id, { at: now });
  const att = cfg.activation.attention[p.attention_class] ?? cfg.activation.attention.toHer;
  const closeness = core.store.get('SELECT closeness FROM entities WHERE id = ?', by)?.closeness ?? 0;
  // 编码强度本身：× events.confirm 由 dynamics.addTrace 按 reason='confirm' 乘（D137：原来这里也乘，实际成了 1.44）
  const w = core.mods.dynamics.encodingWeight(core, { wAtt: att, imp: row.imp, closeness });
  addSource(core, { kind: 'assertion', id: ref.id }, {
    perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: by, asserter: by, mode: modeOfPercept(p), hop: 0, quote: null,
    confidence: 0.95, at: p.at,
  }, { w, reason: 'confirm' });
  return rstr('assertion', ref.id);
}

/** 实现 encode.fix。 */
export async function fix(core, req) {
  const trig = pickTrigger(core, req);
  if (trig.problem) return rejected(trig.problem);
  const { p, obsId } = trig;
  if (req.op === 'correct' && !supportedBy(core, req.newText, p.text)) return rejected('text-not-supported');
  const by = p.actor_entity_id;
  // 这一轮还有别人也在对她说话、而这条消息本身没讲到要忘掉 / 确认的是哪件事：她可能是在替别人办事、只借了这个人的一句话——
  // 按这个人的权限直接生效不对，交给主人看（D114 集成复核；correct 的 new_text、note 的 text 本来就要在这条消息里有依据）
  const borrowed = trig.mixed && (req.op === 'forget' || req.op === 'confirm') && !supportedBy(core, req.target, p.text);
  const principal = !borrowed && authorityOf(core, by) === 'principal';
  // 改正、确认只对事实（情节改不了）：只在事实里找；忘掉、改正时这条消息自己刚记下的事实不算要动的那条
  const found = await resolveTarget(core, req.target, { kinds: req.op === 'forget' ? ['assertion', 'episode'] : ['assertion'], excludePercept: req.op === 'confirm' ? null : p.id });
  if (found?.ambiguous) {
    // 主人问的：把像的那几条的开头给她，好问清是哪一条（别人问的不给：那几条未必是能在这里说的）
    return principal ? { ...rejected('target-ambiguous'), candidates: found.candidates } : rejected('target-ambiguous');
  }
  if (!found) return rejected('target-not-found');
  const ref = found.ref;
  const subject = !principal && !borrowed && isSubjectOf(core, by, ref);
  // 只是「有点像」（没照抄那条的原话，词的相似度也不高）又要直接生效（主人、当事人本人）：先不动，把那条给她问清楚（主人问的才给）。
  // 进审核的照常进（主人会看到是哪一条）
  if ((principal || subject) && !found.literal && found.s < param(core, 'tools.targetSureSim')) {
    return principal ? { ...rejected('target-unsure'), candidates: found.candidates } : rejected('target-unsure');
  }
  const refStr = rstr(ref.kind, ref.id);
  const at = core.now();
  try {
    return core.store.tx(() => {
      if (!claimOp(core, p.id, `fix:${req.op}`)) throw new Abort('one-op-per-message');
      const review = (kind, payload, reason) => {
        const id = core.mods.admin.enqueueReview(core, { kind, payload, reason });
        bumpMetric(core.store, 'encode.tool.review');
        return { status: 'review', refs: [refStr, `review:${id}`], triggerObsId: obsId };
      };
      if (req.op === 'forget') {
        if (principal) {
          core.mods.admin.suppress(core, refStr, { state: 'forgotten', by: 'owner', reason: 'memory_fix', at });
          return { status: 'done', refs: [refStr], triggerObsId: obsId };
        }
        if (subject) {
          // 当事人本人：立即对别人隐藏（主人和审核视图仍看得到），再等主人确认（§17 Q5，评审:PS-04）
          core.mods.admin.suppress(core, refStr, { state: 'hidden', by: `subject:${by}`, reason: 'forget-request', at });
          return review('forget_request', { ref: refStr, entityId: by, perceptId: p.id, hidden: true }, 'subject-forget-request');
        }
        return review('forget_request', { ref: refStr, entityId: by, perceptId: p.id, hidden: false }, 'forget-request');
      }
      if (req.op === 'correct') {
        if (!principal) return review('owner_op', { tool: 'fix', op: 'correct', ref: refStr, perceptId: p.id, span: spanOf(p.text, req.newText) ?? spanOf(p.text, req.evidenceQuote) }, 'tool-by-non-principal');
        return { status: 'done', refs: [refStr, applyCorrect(core, { ref, p, newText: req.newText, quote: req.evidenceQuote, by })], triggerObsId: obsId };
      }
      // confirm：主人或本人
      if (!principal && !subject) return review('owner_op', { tool: 'fix', op: 'confirm', ref: refStr, perceptId: p.id, span: spanOf(p.text, req.evidenceQuote) }, 'tool-by-non-principal');
      return { status: 'done', refs: [applyConfirm(core, { ref, p, by })], triggerObsId: obsId };
    });
  } catch (e) {
    if (e instanceof Abort) return rejected(e.reason);
    core.log.warn('encode.fix.failed', { error: errCode(e) });
    throw e;
  }
}

/**
 * 审核队列里 owner_op（非主人发起的 note / correct / confirm）被主人批准后执行（admin.decideReview 调用）。
 * payload 只有引用和位置：文字从库里那条感知取（不信当初的工具参数）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{tool: 'note'|'fix', op: string, perceptId: number, span?: [number, number]|null, ref?: string, about?: number|null, when?: {start: number, end: number}|null}} payload
 * @param {{by?: string, at?: number}} [ctx]
 * @returns {Promise<import('../contract/types.js').ToolResult>}
 */
export async function applyToolOp(core, payload, ctx = {}) {
  const p = perceptRow(core, payload?.perceptId);
  if (!p || p.text == null) return rejected('trigger-gone');
  const span = Array.isArray(payload.span) ? payload.span : null;
  const text = span ? p.text.slice(span[0], span[1]) : p.text;
  const by = p.actor_entity_id;
  try {
    return core.store.tx(() => {
      if (payload.tool === 'note') {
        return { status: 'done', refs: [applyNote(core, { op: payload.op, p, text, about: payload.about ?? null, when: payload.when ?? null, quote: span ? text : null, by })] };
      }
      const ref = parseRef(payload.ref);
      if (!ref) throw new Abort('target-gone');
      if (payload.op === 'correct') return { status: 'done', refs: [applyCorrect(core, { ref, p, newText: text, quote: clip(text, 60), by })] };
      if (payload.op === 'confirm') return { status: 'done', refs: [applyConfirm(core, { ref, p, by })] };
      throw new Abort('unknown-op');
    });
  } catch (e) {
    if (e instanceof Abort) return rejected(e.reason);
    throw e;
  }
}

// ── 导入（ingest.import） ──────────────────────────────────────────────────

/** 名字 → 已有实体（名字表里唯一完整命中）；拿不准给 null，交给 entities.resolveExtracted 新建 provisional。 */
function matchName(core, name) {
  let hits = [];
  try { hits = core.mods.entities.nameMatcher(core).scan(name, {}) ?? []; } catch { hits = []; }
  const ids = [...new Set(hits.filter((h) => normText(h.name) === normText(name)).map((h) => h.entityId))];
  return ids.length === 1 ? ids[0] : null;
}

/** 实现 encode.importRecords。 */
export async function importRecords(core, records, opt) {
  const report = { accepted: 0, skipped: 0, errors: [] };
  const cfg = core.config.get();
  const now = core.now();
  const source = String(opt?.source ?? 'import');
  core.store.tx(() => {
    records.forEach((rec, index) => {
      try {
        core.store.tx(() => {
          // 认人：subjects 和说话人都是名字
          const names = [...new Set([...(rec.subjects ?? []), ...(rec.sourceMeta?.speaker ? [rec.sourceMeta.speaker] : [])])];
          const ents = names.map((name, i) => {
            const m = matchName(core, name);
            return { local: `S${i + 1}`, name, kind: 'person', descriptor: null, msgRefs: [], verdict: { match: m, fullName: name, confidence: m ? 0.9 : 0.5 } };
          });
          const map = core.mods.entities.resolveExtracted(core, ents, { speakers: new Map(), settingKey: '', at: rec.sourceMeta?.at ?? now, jobId: null }) ?? new Map();
          const idOfName = (name) => map.get(`S${names.indexOf(name) + 1}`) ?? null;
          const subjects = [...new Set((rec.subjects ?? []).map(idOfName).filter(Boolean))];
          if (!subjects.length) throw new Abort('subjects-unresolved');
          const speaker = rec.sourceMeta?.speaker ? idOfName(rec.sourceMeta.speaker) : null;
          const at = isNum(rec.sourceMeta?.at) ? rec.sourceMeta.at : now;
          const scope = rec.norm?.scope && typeof rec.norm.scope === 'object' ? rec.norm.scope : {};
          const scopeIds = (list) => (Array.isArray(list) ? list.map((n) => (typeof n === 'string' ? matchName(core, n) : null)).filter(Boolean) : []);
          const allow = scopeIds(scope.allow);
          const deny = scopeIds(scope.deny);
          const label = rec.sourceMeta?.settingLabel ? clip(rec.sourceMeta.settingLabel, 40) : null;
          const norm = {
            originExposure: { exposureRank: 0, persistenceRank: 1 }, settingRuleRef: null, settingRuleVersion: null,
            restriction: rec.norm?.restriction ?? 'none', ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}),
            summary: label ? `导入自「${label}」` : '导入的记录',
          };
          const src = { perceptId: null, snapshotId: null, perceivedIn: null, speaker, asserter: speaker, mode: 'imported',
            hop: speaker && subjects.includes(speaker) ? 0 : 1, quote: null, confidence: 0.6, at };
          const text = String(rec.text);
          if ([...text].length > cfg.extract.factTextMax) {
            // 长的记录是一段经历：写成导入的情节
            if (core.store.get("SELECT id FROM episodes WHERE ep_kind = 'import' AND narrative = ?", text)) throw new Abort('duplicate');
            writeEpisode(core, {
              settingKey: core.keys.hash('import', source), kind: 'import', title: clip(text, 30), header: `${label ? `「${label}」` : ''}${rec.subjects.join('、')}`,
              narrative: text, tStart: at, tEnd: at, participants: subjects, sources: [src], norm, w: 1,
            });
          } else {
            const fact = { subjects, predicate: '记录', text, kindHint: 'fact', certainty: speaker && !subjects.includes(speaker) ? 'hearsay' : 'stated' };
            const d = reconcileSync(core, fact);
            if (d.op === 'dup' && core.store.get("SELECT 1 FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? AND mode = 'imported'", d.targetId)) throw new Abort('duplicate');
            const id = writeAssertion(core, {
              ...fact, value: null, confidence: 0.6, imp: cfg.activation.defaultImp, sources: [src], norm, needsReconcile: d.op !== 'new' || !!d.needsReconcile,
              predicateCreatedBy: 'import',
            });
            if (d.op === 'dup') core.store.run('UPDATE assertions SET needs_reconcile = 1 WHERE id = ?', id);
          }
          report.accepted += 1;
        });
      } catch (e) {
        if (e instanceof Abort && e.reason === 'duplicate') { report.skipped += 1; return; }
        report.skipped += 1;
        report.errors.push({ index, reason: e instanceof Abort ? e.reason : errCode(e) });
      }
    });
  });
  bumpMetric(core.store, 'encode.import.accepted', report.accepted);
  core.log.info('encode.import', { accepted: report.accepted, skipped: report.skipped, errors: report.errors.length });
  return report;
}
