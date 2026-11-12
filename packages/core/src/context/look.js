// 翻看（D156，memory_look；设计「回忆」§3.5「可以往下翻」）：回忆的结果里每一行前面有记号（〔e840〕），她可以
//   - open：展开一条——情节给完整的叙述和这段经历里的原话（按时间，带她看到的图 / 视频说明；太长时给开头、结尾和中间最对题的几句，
//     说明省了多少）；事实给它本身、它是从哪句话来的、旧的说法；原文窗口给它本身和前后各一个窗口；
//   - when（可选 where、about）：看某一段时间的经过——一段经历一行，整块字数都给它。
// 所有内容照常过关口①（目标和回想同一套：discretion.targetFor），场合的名字照工作记忆段头的放行规则；展开的那一条这一轮不能说，
// 就什么都不给（集成层说「这会儿想不起更具体的了」）。记号对不上、已经不在了、时间看不懂，结果带 reason，集成层说成人话。
import { parseRef } from '../store/index.js';
import { activateExtras } from './people.js';
import { shared } from './recall.js';
import { markOf } from './recall.js';
import { isRestoring } from './resident.js';
import { charLen, newTraceId } from './text.js';

const CONTENT = new Set(['share', 'share_vague']);
const KINDS = new Set(['episode', 'assertion', 'window', 'percept']);
// 展开一段经历时，开头、结尾各留几句（其余从中间挑最对题的）
const EDGE_LINES = 8;
// 一条展开的正文最多多少字（情节的完整叙述、原文窗口）；每句原话最多多少字
const MAIN_CHARS = 1200;
const LINE_CHARS = 200;

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {object} s     SituationRef（或回放用的 {settingKey, focusPerceptId, sessionId, trigger}，配 pin）
 * @param {{open?: string, when?: string, where?: string, about?: string, deadlineMs: number, budgetChars?: number, signal?: AbortSignal}} opt
 * @param {{pin?: {settingKey: string, focusPerceptId: number|null}|null}} [o]
 * @returns {Promise<import('../contract/types.js').RecallLayers>}
 */
export async function look(core, s, opt, { pin = null } = {}) {
  const traceId = newTraceId();
  const kind = typeof opt?.open === 'string' && opt.open.trim() ? 'open' : 'when';
  const out = (items, look) => ({ items, degradeLevel: shared.degrade(core), traceId, look: { kind, ...look } });
  try {
    if (isRestoring(core)) return { items: [], degradeLevel: 4, traceId };
    try { core.mods.intake.drain(core); } catch { /* 按库里现有的算 */ }
    const set = pin ? core.mods.intake.settingByKey(core, pin.settingKey) : core.mods.intake.resolveSetting(core, s.settingId);
    if (!set) return out([], { reason: 'unavailable' });
    const key = set.key;
    if (shared.modeOf(core, key) === 'off') return out([], { reason: 'unavailable' });
    const at = core.now();
    const cfg = core.config.get();
    const selfTurn = s.trigger === 'idle' || s.trigger === 'reminder';
    let focus = null;
    if (pin?.focusPerceptId != null) focus = shared.perceptById(core, key, pin.focusPerceptId);
    else if (s.focusObsId) focus = shared.perceptByObs(core, set.adapter, s.focusObsId);
    if (!focus && !selfTurn) focus = shared.lastToHer(core, key);
    const triggerEntityId = !selfTurn && focus && !focus.actor_self ? (focus.actor_entity_id ?? null) : null;
    const homeKey = s.homeSettingId && s.settingId && s.homeSettingId !== s.settingId ? (core.mods.intake.resolveSetting(core, s.homeSettingId)?.key ?? key) : key;
    let target;
    try {
      target = core.mods.discretion.targetFor(core, /** @type {any} */ ({
        settingKey: key, homeSettingKey: homeKey, sessionId: s.sessionId ?? null, triggerEntityId, mode: 'deliberate', egress: s.egress, at,
        ...(s.settingId ? { settingId: s.settingId } : {}), adapterId: set.adapter, direct: true,
        ...(Number.isSafeInteger(focus?.id) ? { focusPerceptId: focus.id } : {}),
      }));
    } catch {
      return out([], { reason: 'withheld' });   // 判断不了能不能说：什么都不给（fail closed）
    }
    const placeOk = shared.placeGate(core, target, key);
    const tier = core.mods.retrieve.recollectTier(core, 'tool');
    const budget = Math.max(200, Math.min(Number.isFinite(opt.budgetChars) && opt.budgetChars > 0 ? opt.budgetChars : tier.totalChars, tier.totalChars));
    const ctx = { core, key, at, cfg, target, placeOk, budget, opt, focus, deadlineMs: Number(opt.deadlineMs) || 8000,
      tz: cfg.time?.tzOffsetMin ?? null, cues: core.state.context.lookCues?.get(s.sessionId ?? key) ?? [] };
    if (kind === 'open') return await openOne(ctx, out);
    return await openSpan(ctx, out);
  } catch (e) {
    core.log.warn('context.look.error', { error: e?.code ?? e?.name ?? 'Error' });
    return out([], { reason: 'error' });
  }
}

/** 记号 → 记忆引用（「〔e840〕」「e840」都认）；认不出返回 null。 */
export function refOfMark(text) {
  const t = String(text ?? '').trim().replace(/^〔/u, '').replace(/〕$/u, '').trim();
  const m = parseRef(t);
  return m && KINDS.has(m.kind) ? { ref: t, m } : null;
}

// ── open：展开一条 ──────────────────────────────────────────────────────

async function openOne(ctx, out) {
  const { core, key, opt } = ctx;
  const r = refOfMark(opt.open);
  if (!r) return out([], { reason: 'bad-ref' });
  const { ref, m } = r;
  const table = { episode: 'episodes', assertion: 'assertions', window: 'raw_windows', percept: 'percepts' }[m.kind];
  const row = core.store.get(`SELECT * FROM ${table} WHERE id = ?`, m.id);
  if (!row || (m.kind === 'window' && row.text == null) || (m.kind === 'percept' && (row.text_state === 'retracted' || row.text_state === 'expired'))) {
    return out([], { ref, reason: 'not-found' });
  }
  if (shared.suppressed(core, [ref]).has(ref)) return out([], { ref, reason: 'not-found' });
  // 跟着它一起给的
  let related = [];
  let omitted = 0;
  let total = 0;
  if (m.kind === 'episode') {
    const ids = core.store.all('SELECT id FROM percepts WHERE episode_id = ? ORDER BY at, id', m.id).map((x) => x.id);
    const src = core.store.all("SELECT DISTINCT percept_id AS id FROM sources WHERE owner_kind = 'episode' AND owner_id = ? AND percept_id IS NOT NULL", m.id).map((x) => x.id);
    const all = [...new Set([...ids, ...src])];
    const rows = all.length ? core.store.all(`SELECT id, at, text FROM percepts WHERE id IN (${all.map(() => '?').join(',')}) ORDER BY at, id`, ...all) : [];
    total = rows.length;
    const max = Math.max(4, Math.floor(ctx.cfg.recall.recollect?.look?.openPercepts ?? 40));
    const picked = pickLines(core, rows, max, ctx.cues);
    omitted = total - picked.length;
    related = picked.map((x) => `p${x.id}`);
  } else if (m.kind === 'assertion') {
    related = core.store.all("SELECT DISTINCT percept_id AS id FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? AND percept_id IS NOT NULL ORDER BY at", m.id)
      .slice(0, 6).map((x) => `p${x.id}`);
    // 旧的说法（往回 3 版）
    let cur = row;
    for (let i = 0; i < 3 && cur?.supersedes; i++) {
      related.push(`a${cur.supersedes}`);
      cur = core.store.get('SELECT id, supersedes FROM assertions WHERE id = ?', cur.supersedes);
    }
  } else if (m.kind === 'window') {
    // 相邻的窗口有几句重叠：前一个取完全在它之前的、后一个取完全在它之后的（真正的「前后」，不是重叠的那一个）
    const prev = core.store.get(`SELECT id FROM raw_windows WHERE setting_key = ? AND visible_to = ? AND last_percept < ? AND text IS NOT NULL
                                 ORDER BY last_percept DESC LIMIT 1`, row.setting_key, row.visible_to, row.first_percept);
    const next = core.store.get(`SELECT id FROM raw_windows WHERE setting_key = ? AND visible_to = ? AND first_percept > ? AND text IS NOT NULL
                                 ORDER BY first_percept LIMIT 1`, row.setting_key, row.visible_to, row.last_percept);
    related = [prev && `w${prev.id}`, next && `w${next.id}`].filter(Boolean);
  } else if (m.kind === 'percept' && Number.isSafeInteger(row.window_id)) {
    related = [`w${row.window_id}`];
  }
  const hidden = shared.suppressed(core, related);
  related = related.filter((x) => !hidden.has(x));
  const gated = await gateAll(ctx, [ref, ...related]);
  const g0 = gated.get(ref);
  if (!g0 || !CONTENT.has(g0.verdict)) return out([], { ref, reason: 'withheld' });
  const items = [];
  let used = 0;
  let withheld = 0;
  const add = (x, chars, more = {}) => {
    const g = gated.get(x);
    if (!g || !CONTENT.has(g.verdict)) { withheld += 1; return; }
    const cand = ctx.cands.get(x);
    const r0 = shared.renderContent(core, cand, g, { at: ctx.at, tz: ctx.tz, key, chars, placeOk: ctx.placeOk, told: false, ...more });
    if (!r0?.rendered) return;
    const text = `${markOf(x)}${r0.rendered}`;
    if (used + charLen(text) > ctx.budget) { omitted += 1; return; }
    used += charLen(text) + 1;
    items.push({ id: x, layer: 'look', rendered: text, verdict: g.verdict, confidence: Math.min(1, Math.max(0, r0.confidence ?? 0)),
      provenance: r0.provenance ?? '', appraisalRef: g.appraisalRef });
  };
  add(ref, MAIN_CHARS);
  for (const x of related) add(x, x.startsWith('w') ? MAIN_CHARS / 2 : LINE_CHARS);
  const note = openNote(m.kind, { ref, total, given: items.length - 1, omitted, withheld });
  return out(items, { ref, note });
}

/** 一段经历里的原话太多时挑哪几句：开头、结尾各 EDGE_LINES 句，其余从中间挑和线索的词对得上最多的，按时间排回去。 */
function pickLines(core, rows, max, cues) {
  if (rows.length <= max) return rows;
  const edge = Math.min(EDGE_LINES, Math.floor(max / 3));
  const head = rows.slice(0, edge);
  const tail = rows.slice(rows.length - edge);
  const mid = rows.slice(edge, rows.length - edge);
  const terms = new Set();
  for (const q of cues ?? []) {
    let ts = [];
    try { ts = core.mods.lang.queryTerms(core, q) ?? []; } catch { ts = []; }
    for (const t of ts) { const n = String(t).normalize('NFKC').toLowerCase(); if (n && !/^ent_\d+$/u.test(n)) terms.add(n); }
  }
  const score = (r) => { const t = String(r.text ?? '').toLowerCase(); let n = 0; for (const w of terms) if (t.includes(w)) n += [...w].length; return n; };
  const want = max - head.length - tail.length;
  const chosen = new Set(mid.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, want).map((x) => x.r.id));
  return [...head, ...mid.filter((r) => chosen.has(r.id)), ...tail];
}

/** 展开那一条的说明（不含记忆内容）：一共几句、给了几句、省了几句、这里不便说的几句。 */
function openNote(kind, { ref, total, given, omitted, withheld }) {
  const parts = [`展开${markOf(ref)}`];
  if (kind === 'episode') parts.push(total ? `这段经历里有 ${total} 句原话，下面给了 ${Math.max(0, given)} 句` : '这段经历没有留下原话');
  if (omitted > 0) parts.push(`中间省了 ${omitted} 句`);
  if (withheld > 0) parts.push(`有 ${withheld} 条这里不便说，没给`);
  return parts.join('；');
}

// ── when：一段时间的经过 ─────────────────────────────────────────────────

async function openSpan(ctx, out) {
  const { core, key, opt, at } = ctx;
  const when = String(opt.when ?? '').trim();
  if (!when) return out([], { reason: 'bad-time' });
  const cues = core.mods.retrieve.buildCues(core, { settingKey: key, focusPerceptId: ctx.focus?.id ?? null });
  const intent = core.mods.retrieve.buildIntent(core, cues, { time: when, where: opt.where ?? null, about: opt.about ?? null });
  if (!intent.timeWindows.length || intent.from?.time !== 'tool') return out([], { reason: 'bad-time' });
  // 只认她自己写的 where、about（工具参数）：不从眼前那句话里猜人和场合（她要看的是那段时间的全部经过）
  const about = intent.from?.about === 'tool' ? intent.aboutEntityIds : [];
  const where = intent.from?.where === 'tool' ? intent.settingKeys : [];
  intent.aboutEntityIds = about;
  intent.settingKeys = where;
  const scope = core.mods.retrieve.scopeOf(core, { timeWindows: intent.timeWindows, aboutEntityIds: about, settingKeys: where }, { at });
  if (scope.failed) return out([], { reason: 'error' });
  const lineChars = Math.max(20, Number(ctx.cfg.recall.recollect?.outline?.lineChars) || 80);
  const max = Math.max(4, Math.ceil(ctx.budget / Math.max(30, lineChars * 0.6)));
  const rows = await core.mods.retrieve.outlineOf(core, scope, { max, signal: opt.signal });
  const note = spanNote(core, intent, scope, rows.length, at);
  if (!rows.length) return out([], { reason: 'nothing', note });
  const gated = await gateAll(ctx, rows.map((r) => r.ref));
  const items = [];
  let used = 0;
  let withheld = 0;
  for (const r of rows) {
    const g = gated.get(r.ref);
    if (!g || !CONTENT.has(g.verdict)) { withheld += 1; continue; }
    const tail = r.merged.length ? `（另外 ${r.merged.length} 处也提到）` : '';
    const r0 = shared.renderContent(core, ctx.cands.get(r.ref), g, { at, tz: ctx.tz, key, chars: lineChars, placeOk: ctx.placeOk, told: false, outline: true });   // D165：lineChars 是正文，记号和尾巴不占
    if (!r0?.rendered) continue;
    const text = `${markOf(r.ref)}${r0.rendered}${tail}`;
    if (used + charLen(text) > ctx.budget) break;
    used += charLen(text) + 1;
    items.push({ id: r.ref, layer: 'outline', rendered: text, verdict: g.verdict, confidence: Math.min(1, Math.max(0, r0.confidence ?? 0)),
      provenance: r0.provenance ?? '', appraisalRef: g.appraisalRef, ...(r.merged.length ? { merged: r.merged.slice(0, 10) } : {}) });
  }
  if (!items.length) return out([], { reason: withheld ? 'withheld' : 'nothing', note });
  return out(items, { note: withheld ? `${note}；有 ${withheld} 段这里不便说，没给` : note });
}

/** when 的说明（不含记忆内容）：看的是哪段时间、关于谁、在哪儿，有多少段经历。 */
function spanNote(core, intent, scope, n, at) {
  const range = (w) => { try { return core.mods.lang.describeRange(core, w.start, Math.max(w.start, Math.min(w.end, at)), { now: at, day: true }); } catch { return ''; } };
  const when = intent.timeWindows.slice(0, 3).map(range).filter(Boolean).join('、');
  const eps = scope.counts?.episodes ?? 0;
  return `翻看：${when || '那段时间'}${intent.aboutEntityIds.length ? ' · 只看和问到的人有关的' : ''}${intent.settingKeys.length ? ' · 只看问到的场合' : ''}；这段时间有 ${eps} 段经历，下面按时间排了 ${n} 段`;
}

/** 一批记忆一起过关口①（和回想同一个目标）；没判出来的不给。结果按引用放在 Map 里，候选放在 ctx.cands。 */
async function gateAll(ctx, refs) {
  const { core, target, at } = ctx;
  const cands = activateExtras(core, refs.map((ref) => ({ ref })), { at, mode: 'deliberate', seed: ['look', ...refs.slice(0, 3)] });
  ctx.cands = new Map(cands.map((c) => [c.ref, c]));
  let gated = [];
  try {
    gated = await shared.bounded(core.mods.discretion.gate(core, cands, target, { mode: 'deliberate', deadlineMs: ctx.deadlineMs, waitMs: ctx.deadlineMs, signal: ctx.opt.signal }),
      ctx.deadlineMs + 250, ctx.opt.signal);
  } catch { gated = []; }
  const m = new Map();
  for (const g of Array.isArray(gated) ? gated : []) if (g?.ref && typeof g.appraisalRef === 'string' && g.appraisalRef) m.set(g.ref, g);
  return m;
}
