// 核验（§7.4 的 14 条，纯代码，防「种植记忆」）：只检查提炼输出里各个结构化字段之间是否自洽，不用词表（评审:UV-04）。
// 不通过的丢弃（dropped 里记规则号和理由），能改判的改判（rewritten 计数）。说话人、来源方式、确定程度、转了几手都由代码
// 从证据消息的结构算出来，不信模型自报。读库只为了权限、配额和「告诉过谁」，不写。
import {
  param, isNum, clip, clamp, clamp01, parseWindow, parseTimeValue, quoteMatches, jsonParse, isOccurrenceKind, STABLE_KINDS,
  CERTAINTIES, modeOfPercept, localDay, HOUR, DAY,
} from './util.js';
import { assertionSubjects, assertionRow, quotaUsed, quotaLimit, selfIdOf } from './write.js';
import { parseRef } from '../store/refs.js';

const FACTISH = new Set(['fact', 'plan', 'self', 'rel']);
const SELF_ALIASES = new Set(['我', 'self', 'me']);
const KINDS = new Set(['state', 'plan', 'event', 'fact', 'preference', 'identity', 'relation', 'opinion', 'rule', 'commitment', 'request', 'norm_claim', 'ability']);
/** 第 14 条：一时的（原话留着就够）；她自己说的关于自己的断言（要封顶把握）。 */
const TRANSIENT_KINDS = new Set(['state', 'event']);
const SELF_CLAIM_KINDS = new Set(['fact', 'identity', 'state']);
const PLAN_STATUS_IN = new Set(['in_progress', 'done', 'cancelled', 'missed']);
const ORIGINS = new Set(['self-care', 'self-commitment', 'principal-request']);
const RESTRICTIONS = new Set(['none', 'soft', 'strict']);

const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const code = (c) => (typeof c === 'string' ? (SELF_ALIASES.has(c.trim()) ? '我' : c.trim().replace(/^\[|\]$/g, '')) : null);

function parseOp(op) {
  if (typeof op !== 'string' || !op.trim()) return { kind: 'new', code: null };
  const m = op.trim().match(/^(new|dup|contradict|changed|新增|重复|矛盾|变了未知)\s*(?::\s*(\S+))?$/);
  if (!m) return { kind: 'new', code: null, bad: true };
  const kind = { 新增: 'new', 重复: 'dup', 矛盾: 'contradict', 变了未知: 'changed' }[m[1]] ?? m[1];
  return { kind, code: m[2] ? code(m[2]) : null };
}

/**
 * 第 14 条（D123）的判断，只看结构化字段（提炼时用；scripts/keep-dry-run.mjs 拿库里已有的事实预演同一条规则）。
 * held：挂着别的行（意图、计划状态、确认、规范变化）、在更新已知背景、带叮嘱 / 伤害 / 指令标记、模型预计以后会被问到（future_q）、
 * 事情还没发生（事件 / 计划时间在消息之后）——这些以后用得上，照常写。她自己说的只有 imp 低于 keep.selfMinImp 的才不写。
 * @param {{kind: string, certainty: string, imp: number, confidence: number, aboutHer: boolean, held: boolean}} f
 * @param {{minImp: number, selfClaimConfidenceMax: number, selfClaimImpMax: number, selfAbilityConfidenceMax: number, selfAbilityImpMax: number}|undefined} keep
 * @returns {{drop: 'self-transient'|'transient'|null, confidence: number, imp: number}}
 */
export function keepRule(f, keep) {
  const same = { drop: null, confidence: f.confidence, imp: f.imp };
  if (!keep || f.kind === 'request') return same;
  if (TRANSIENT_KINDS.has(f.kind) && !f.held && f.imp < (f.certainty === 'self_said' ? keep.selfMinImp : keep.minImp)) {
    return { ...same, drop: f.certainty === 'self_said' ? 'self-transient' : 'transient' };
  }
  if (f.certainty === 'self_said' && f.aboutHer) {
    const [cMax, iMax] = f.kind === 'ability' ? [keep.selfAbilityConfidenceMax, keep.selfAbilityImpMax]
      : SELF_CLAIM_KINDS.has(f.kind) ? [keep.selfClaimConfidenceMax, keep.selfClaimImpMax] : [null, null];
    if (cMax != null) return { drop: null, confidence: Math.min(f.confidence, cMax), imp: Math.min(f.imp, iMax) };
  }
  return same;
}

/**
 * 实现 encode.verify。ctx 在约定的字段之外可以带（buildExtractPrompt 的返回值里都有）：
 *   bgCodes（k1 → 记忆引用）、candidateCodes（c1 → 实体 id）、labels（编号 → 显示名）、actorCodes（感知 id → 说话人编号）、selfId。
 */
export function verify(core, lines, ctx) {
  const dropped = [];
  const accepted = [];
  let rewritten = 0;
  const drop = (line, rule, reason) => { dropped.push({ line, rule, reason }); };
  const percepts = new Map((ctx.percepts ?? []).map((p) => [p.id, p]));
  const speakers = ctx.speakers ?? new Map();
  const msgRefs = ctx.msgRefs ?? new Map();
  const bgCodes = ctx.bgCodes ?? new Map();
  const cands = ctx.candidateCodes ?? new Map();
  const labels = new Map(ctx.labels ?? []);
  const selfId = ctx.selfId ?? selfIdOf(core);
  const historical = !!ctx.seg?.historical;
  const cfg = core.config.get();

  // 感知 → 说话人编号
  const actorCodes = new Map(ctx.actorCodes ?? []);
  const byEntity = new Map();
  for (const [c, id] of speakers) if (c !== '我' && id != null && !byEntity.has(id)) byEntity.set(id, c);
  const codeOfPercept = (p) => {
    if (p.actor_self) return '我';
    return actorCodes.get(p.id) ?? (p.actor_entity_id != null ? byEntity.get(p.actor_entity_id) : null) ?? null;
  };

  // ── 第一遍：ent（第 12 条：锚点必须在本段出现过或已知） ─────────────────
  const ents = new Map();
  // 【补】带 "is" 的 ent 行说的就是本段的某个说话人：后面的行里它的编号（E2）一律当成那个说话人的编号（U2）——
  // 「我是阿明的表哥，我开网约车」是本人说自己的事（第 2 条），不是听说
  const alias = new Map();
  const cc = (c) => { const k = code(c); return k != null && alias.has(k) ? alias.get(k) : k; };
  const entLines = lines.filter((l) => l.type === 'ent');
  const entIds = new Set(entLines.map((l, i) => code(l.id) ?? `E#${i + 1}`));
  entLines.forEach((l, i) => {
    const id = code(l.id) ?? `E#${i + 1}`;
    const refs = arr(l.msgRefs).map(code);
    if (refs.some((r) => !msgRefs.has(r))) { drop(l, 1, 'foreign-msgRef'); return; }
    const out = { ...l, id, msgRefs: refs, name: typeof l.name === 'string' && l.name.trim() ? clip(l.name.trim(), 40) : null, kind: typeof l.kind === 'string' && l.kind ? l.kind : 'person' };
    delete out.speaker; delete out.is; delete out.individual;
    const anchor = code(l.anchor);
    if (anchor && l.relation) {
      const known = anchor === '我' || speakers.has(anchor) || cands.has(anchor) || (entIds.has(anchor) && anchor !== id);
      if (!known) { delete out.anchor; delete out.relation; rewritten += 1; dropped.push({ line: l, rule: 12, reason: 'anchor-unknown(descriptor-removed)' }); }
      else { out.anchor = anchor; out.relation = clip(String(l.relation), 20); }
    } else { delete out.anchor; delete out.relation; }
    // "is"：只认本段在场的说话人编号（不能是她自己）。这句话是谁说的（本人自称 / 锚点当面确认 / 旁人）由 entities 按证据消息的说话人定，不信模型
    const is = code(l.is);
    if (is && is !== '我' && speakers.has(is)) {
      out.speaker = is;
      alias.set(id, is);
      if (out.anchor === is || out.anchor === id) { delete out.anchor; delete out.relation; rewritten += 1; }   // 自己不是自己的锚点
    } else if (l.is != null) rewritten += 1;
    if (typeof l.individual === 'boolean') out.individual = out.speaker ? true : l.individual;
    else if (out.speaker) out.individual = true;
    const m = code(l.match);
    out.matchCode = m && cands.has(m) ? m : null;
    if (m && !cands.has(m)) rewritten += 1;
    out.confidence = clamp01(isNum(l.confidence) ? l.confidence : 0.6);
    ents.set(id, out);
    labels.set(id, out.speaker ? (labels.get(out.speaker) ?? out.name ?? id)
      : out.name ?? (out.anchor ? `${labels.get(out.anchor) ?? '某人'}的${out.relation}` : id));
    accepted.push(out);
  });

  const known = (c) => c === '我' || speakers.has(c) || ents.has(c) || cands.has(c);
  const entityOf = (c) => {
    if (c === '我') return selfId;
    if (speakers.has(c)) return speakers.get(c);
    if (cands.has(c)) return cands.get(c);
    const e = ents.get(c);
    if (e?.speaker) return speakers.get(e.speaker) ?? null;
    if (e?.matchCode) return cands.get(e.matchCode);
    return null;
  };
  const authority = (c) => {
    const id = entityOf(c);
    if (!id || c === '我') return 'none';
    try { return core.mods.entities.bondOf(core, id)?.authority ?? 'none'; } catch { return 'none'; }
  };
  const individual = (c) => {
    if (c === '我') return false;
    const e = ents.get(c);
    if (e && !e.matchCode) return e.individual !== false;
    const id = entityOf(c);
    if (!id) return true;
    try { return !!core.mods.entities.isIndividual(core, id); } catch { return true; }
  };
  const label = (c) => labels.get(c) ?? '有人';
  const delabel = (s) => {
    if (typeof s !== 'string') return s;
    const t = s.replace(/\[([kpm]\d{1,3})\]/g, '').replace(/\[?\b([UEc]\d{1,3}|E#\d{1,3})\b\]?/g, (m0, c) => (labels.has(c) ? labels.get(c) : m0));
    if (t !== s) rewritten += 1;
    return t;
  };

  function evidence(l) {
    const refs = arr(l.msgRefs ?? l.msgRef).map(code).filter(Boolean);
    if (!refs.length) return { ok: false, reason: 'no-msgRefs' };
    if (refs.some((r) => !msgRefs.has(r))) return { ok: false, reason: 'foreign-msgRef' };
    const rows = refs.map((r) => percepts.get(msgRefs.get(r))).filter(Boolean);
    // 从别的入口转进来的同一件事（relay_of）挂在原来那条感知下，不作为新的事实来源（§7.1 第 4 步，评审:AR-13）
    const ev = rows.filter((p) => p.evidential && !p.relay_of);
    if (!ev.length) return { ok: false, reason: rows.some((p) => p.relay_of) ? 'relayed' : 'non-evidential' };
    return { ok: true, rows: ev, refs };
  }
  const retold = (rows) => {
    const ids = rows.filter((p) => p.actor_self).map((p) => p.id);
    if (!ids.length) return false;
    return !!core.store.get(`SELECT 1 FROM told_log WHERE utterance_percept_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, ...ids);
  };
  /** norm 对象的规范化（代码层面的字段，编号留着，写入时再换成实体 id）。 */
  function normOfLine(l) {
    const n = l.norm && typeof l.norm === 'object' ? l.norm : {};
    const scope = n.restriction_scope ?? l.restriction_scope ?? {};
    const out = {
      restriction: RESTRICTIONS.has(n.restriction) ? n.restriction : 'none',
      allow: arr(scope.allow).map(cc).filter(known),
      deny: arr(scope.deny).map(cc).filter(known),
      quote: typeof n.quote === 'string' ? clip(n.quote, 60) : null,
      summary: typeof n.summary === 'string' ? clip(n.summary, 80) : null,
    };
    return out;
  }
  const denyAuthority = (n) => n.deny.some((c) => authority(c) !== 'none');
  // deny 里有管理者 = 「别告诉主人」这类请求本身（§9.3.7）：和 discretion 写规范时报的是同一件事，用同一个原因，
  // admin 按（消息 / 记忆、原因）合成一条；请求本身不让内容变成 T1（S28）
  const SECRECY = core.mods.discretion.SECRECY_REQUEST_REASON;

  // 本批的事实编号（计划状态、意图、确认可以引用它们，不分先后）
  const batch = new Map();
  let auto = 0;
  for (const l of lines) if (FACTISH.has(l.type)) { const id = code(l.id) ?? `f#${++auto}`; l.__id = id; batch.set(id, l); }
  // 第 14 条要知道：哪些事实挂着别的行（意图、计划状态、确认、规范变化指着它）——挂着的照常写，不算一时的
  const linked = new Set();
  for (const l of lines) {
    if (l.type === 'intent' && l.about) linked.add(code(l.about));
    if ((l.type === 'plan_status' || l.type === 'confirm' || l.type === 'future_q') && (l.target ?? l.for)) linked.add(code(l.target ?? l.for));
    if (l.type === 'norm_update' && l.target && typeof l.target === 'object' && l.target.ref) linked.add(code(l.target.ref));
  }

  // ── 第二遍：事实类 ─────────────────────────────────────────────────────
  const factOut = new Map();
  for (const l of lines) {
    if (!FACTISH.has(l.type)) continue;
    const ev = evidence(l);
    if (!ev.ok) { drop(l, 1, ev.reason); continue; }
    if (l.quote != null && l.quote !== '' && !ev.rows.some((p) => quoteMatches(l.quote, p.text))) { drop(l, 1, 'quote-not-in-message'); continue; }
    const text = typeof l.text === 'string' ? l.text.trim() : '';
    if (!text) { drop(l, 0, 'no-text'); continue; }
    let type = l.type;
    const evCodes = ev.rows.map(codeOfPercept);
    const allHer = evCodes.every((c) => c === '我');
    const claimed = cc(l.speaker);
    let speaker = claimed && evCodes.includes(claimed) ? claimed : evCodes[0];
    if (claimed && claimed !== speaker) rewritten += 1;
    // 第 6 条：self 只能来自她的行
    if (type === 'self' && !allHer) { drop(l, 6, 'self-not-her-line'); continue; }
    let subjects = arr(l.subjects).map(cc).filter(Boolean);
    if (type === 'rel') subjects = [cc(l.a)].filter(Boolean);
    const unknownSubj = subjects.filter((c) => !known(c));
    if (unknownSubj.length) { subjects = subjects.filter(known); rewritten += 1; }
    if (type === 'self' && !subjects.length) subjects = ['我'];
    if (!subjects.length) { drop(l, 7, 'no-known-subject'); continue; }
    const object = type === 'rel' ? cc(l.b) : cc(l.object);
    const out = {
      ...l, type, id: l.__id, text: delabel(clip(text, cfg.extract.factTextMax)), subjects, object: object && known(object) ? object : null,
      mentions: arr(l.mentions).map(cc).filter(known), evidence: ev.rows.map((p) => p.id), msgRefs: ev.refs,
      quotePercept: l.quote ? (ev.rows.find((p) => quoteMatches(l.quote, p.text))?.id ?? null) : null,
      notify: [], needsReview: false,
    };
    delete out.__id;
    let certainty = CERTAINTIES.has(l.certainty) ? l.certainty : 'stated';
    let asserter = cc(l.asserter);
    if (asserter && !known(asserter)) asserter = null;
    let hop = 0;
    if (type === 'self' || (allHer && subjects.includes('我'))) {
      // 她自己的看法、计划、承诺：本人说
      if (type !== 'self') rewritten += 1;
      type = 'self'; speaker = '我'; asserter = '我'; certainty = 'self_said'; hop = 0;
    } else if (allHer) {
      // 第 13 条：她复述已有记忆的话不新建（来源继承原记忆，确定程度不升）
      if (retold(ev.rows)) { drop(l, 13, 'retell'); continue; }
      speaker = '我'; asserter = '我'; certainty = certainty === 'inferred' ? 'inferred' : 'self_said'; hop = 1;
      out.confidence = Math.min(clamp01(isNum(l.confidence) ? l.confidence : 0.5), 0.5);
      rewritten += 1;
    } else {
      const forwarded = ev.rows.some((p) => p.forwarded_json);
      asserter = asserter ?? speaker;
      if (subjects.includes('我')) {
        // 第 3 条：关于她自己的事实，说话人对她有权限才算数；否则是「U3 说……」的听说（也是 T1：想改变她的东西）
        if (authority(speaker) !== 'none' && !forwarded) { certainty = 'stated'; asserter = speaker; hop = 1; }
        else {
          if (certainty !== 'hearsay') rewritten += 1;
          certainty = 'hearsay'; asserter = speaker; hop = 1;
          out.text = clip(`${label(speaker)}说：${out.text}`, cfg.extract.factTextMax);
          // 想改她的「设定」的那种由第 8 条（directive）报 T1；单纯说起她的事只是听说
        }
      } else if (subjects.includes(speaker) && asserter === speaker && !forwarded) {
        // 第 2 条：本人说自己的事
        if (certainty !== 'inferred') { if (certainty !== 'stated') rewritten += 1; certainty = 'stated'; }
        hop = 0;
      } else {
        // 第 2 条：主体不是说话人（或转发的内容）→ 听说，断言者 = 实际说话人（或它转述的人）
        if (certainty === 'stated' || certainty === 'confirmed' || certainty === 'self_said') { rewritten += 1; certainty = 'hearsay'; }
        if (forwarded) asserter = speaker;
        hop = asserter === speaker ? 1 : Math.max(2, isNum(l.hop) ? Math.round(l.hop) : 2);
      }
      // 第 4 条：关于群体、组织、话题、作品这些非人物实体的，存成「某人觉得……」，带断言者
      if (subjects.every((c) => !individual(c)) && !subjects.includes('我')) {
        if (certainty === 'stated' && !subjects.includes(speaker)) certainty = 'hearsay';
        const k = String(l.kind_hint ?? '');
        if ((k === 'opinion' || k === 'preference') && !out.text.includes(label(asserter))) {
          out.text = clip(`${label(asserter)}觉得${out.text}`, cfg.extract.factTextMax);
          rewritten += 1;
        }
      }
    }
    out.speaker = speaker; out.asserter = asserter ?? speaker; out.certainty = certainty; out.hop = hop;
    out.mode = type === 'self' ? 'self_generated' : (certainty === 'inferred' ? 'inferred' : modeOfPercept(ev.rows[0]));
    // 第 5 条：时间自洽
    const base = ev.rows[0].at;
    let kind = typeof l.kind_hint === 'string' && KINDS.has(l.kind_hint) ? l.kind_hint : (type === 'rel' ? 'relation' : 'fact');
    if (type === 'plan') kind = 'plan';
    let eventTime = parseWindow(core, l.event_time, base);
    let plannedTime = parseWindow(core, l.planned_time ?? (type === 'plan' ? l.time : null), base);
    const validFrom = parseTimeValue(core, l.valid_from, base);
    const t50 = Number(l.survival?.t50_h ?? l.survival?.t50h ?? l.survival?.t50);
    const survival = t50 > 0 ? { t50h: t50, shape: Number(l.survival?.shape) > 0 ? Number(l.survival.shape) : 1 } : null;
    if (isOccurrenceKind(kind) && !(plannedTime || eventTime)) {
      if (kind === 'plan') plannedTime = { start: base, end: base + 12 * HOUR, precision: 'fuzzy' };
      else eventTime = { start: base, end: base, precision: 'fuzzy' };
      out.needsReview = true; rewritten += 1;
    }
    if (STABLE_KINDS.has(kind) && survival && survival.t50h < param(core, 'extract.stableMinT50H')) {
      kind = 'state'; out.needsReview = true; rewritten += 1;   // t50 只有几个小时的「偏好」其实是一时的状态
    }
    const far = param(core, 'extract.timeSanityDays') * DAY;
    for (const t of [eventTime?.start, plannedTime?.start, validFrom]) if (isNum(t) && Math.abs(t - base) > far) out.needsReview = true;
    if (kind === 'plan' && plannedTime && plannedTime.end < base - HOUR && !historical) out.needsReview = true;
    out.kind_hint = kind; out.eventTime = eventTime; out.plannedTime = plannedTime; out.validFrom = validFrom; out.survival = survival;
    out.imp = clamp(isNum(l.imp) ? l.imp : cfg.activation.defaultImp, 1, 10);
    // 模型没给把握（confidence）时按代码核定的确定程度给默认值（extract.defaultConfidence）：本人说的、被确认的、她自己说的，
    // 照实记下来的就该能直接说（§6.6 措辞 > 0.8 直接说、§1.1 被问能答上）；推断的只到「好像」那一档；听说的取写入时的上限
    out.confidence = clamp01(isNum(out.confidence) ? out.confidence
      : certainty === 'hearsay' ? cfg.activation.hearsayConfidenceCap : cfg.extract.defaultConfidence[certainty] ?? cfg.extract.defaultConfidence.other);
    out.norm = normOfLine(l);
    out.attribute = typeof l.attribute === 'string' ? clip(l.attribute, 30) : null;
    out.sensitivity = isNum(l.sensitivity) ? clamp01(l.sensitivity) : null;
    if (kind === 'plan') {
      // 任何人的计划（含她自己的 self 行里的打算）都带状态（§5.5）
      const agent = type === 'self' ? '我' : cc(l.agent);
      out.agent = agent && known(agent) ? agent : subjects[0];
      out.status = l.status === 'in_progress' ? 'in_progress' : 'planned';
    }
    // 第 7 条：op 引用的编号只能是输入里给过的背景
    const op = parseOp(l.op);
    if (op.code && !bgCodes.has(op.code)) { op.kind = 'new'; op.code = null; rewritten += 1; dropped.push({ line: l, rule: 7, reason: 'op-ref-unknown(op→new)' }); }
    else if (op.kind !== 'new' && !op.code) { op.kind = 'new'; rewritten += 1; }
    if (op.bad) rewritten += 1;
    out.opKind = op.kind; out.opTarget = op.code;
    // 第 8 条：指令类内容，说话人没有权限 → 永远不成为规则或意图，最多记一条「U3 提过一个要求，没采纳」（T1）
    if (l.directive === true && speaker !== '我' && authority(speaker) === 'none') {
      Object.assign(out, directiveRecord(out, speaker, label(speaker), text, cfg));
      rewritten += 1;
    }
    if (l.harm === true) out.notify.push({ kind: 'T2', reason: 'harm' });
    // 第 14 条（D123）：只记以后的她不翻聊天记录也需要知道的。原话一直留着、随时搜得到：没挂着别的行、没有叮嘱和伤害、
    // 不是在更新已知背景的状态 / 事件——她自己说的一律不成事实，别人的重要度低于 keep.minImp 的不成事实（留在叙述和原话里）。
    // 她自己说的关于自己的断言封顶把握和重要度；说自己能 / 不能做什么（ability）封得更低：要她真做到 / 没做到、或主人说过才算数，
    // 夜里对照原话核对（D122）。只看结构化字段，不看文字。
    const askedLater = arr(l.future_q).some((q) => typeof q === 'string' && q.trim());
    const ahead = [eventTime?.start, plannedTime?.start].some((t) => isNum(t) && t > base);
    const held = linked.has(out.id) || out.opKind !== 'new' || out.norm.restriction !== 'none' || l.harm === true || l.directive === true || askedLater || ahead;
    const k14 = keepRule({ kind: out.kind_hint, certainty, imp: out.imp, confidence: out.confidence, aboutHer: subjects.includes('我'), held }, cfg.extract.keep);
    if (k14.drop) { drop(l, 14, k14.drop); continue; }
    if (k14.confidence !== out.confidence || k14.imp !== out.imp) { out.confidence = k14.confidence; out.imp = k14.imp; rewritten += 1; }
    if (denyAuthority(out.norm)) out.notify.push({ kind: 'T1', reason: SECRECY });
    out.selfRelevance = isNum(l.self_relevance) ? l.self_relevance : null;
    out.futureQ = arr(l.future_q).filter((q) => typeof q === 'string' && q.trim()).map((q) => delabel(clip(q.trim(), 60)));
    out.cardinality = l.cardinality === 'many' || l.cardinality === 'one' ? l.cardinality : null;
    factOut.set(out.id, out);
    accepted.push(out);
  }

  // ── 第三遍：其余的行 ───────────────────────────────────────────────────
  const factTarget = (c) => (c && (bgCodes.has(c) || factOut.has(c)) ? c : null);
  const subjectsOfTarget = (c) => {
    if (factOut.has(c)) return factOut.get(c).subjects.map(entityOf).filter(Boolean);
    const r = parseRef(bgCodes.get(c));
    if (r?.kind === 'assertion') {
      const row = assertionRow(core, r.id);
      return [...assertionSubjects(core, r.id), ...(row?.plan_agent ? [row.plan_agent] : [])];
    }
    return [];
  };
  const speakersOfTarget = (c) => {
    if (factOut.has(c)) return [entityOf(factOut.get(c).speaker)].filter(Boolean);
    const r = parseRef(bgCodes.get(c));
    if (!r) return [];
    return core.store.all('SELECT DISTINCT speaker FROM sources WHERE owner_kind = ? AND owner_id = ? AND speaker IS NOT NULL', r.kind, r.id).map((x) => x.speaker);
  };
  const futureQ = new Map();
  for (const l of lines) {
    if (FACTISH.has(l.type) || l.type === 'ent') continue;
    switch (l.type) {
      case 'header':
      case 'narrative': {
        const text = typeof l.text === 'string' ? delabel(l.text.trim()) : '';
        if (!text) { drop(l, 0, 'no-text'); break; }
        accepted.push({ ...l, text, title: typeof l.title === 'string' ? delabel(clip(l.title.trim(), 40)) : undefined });
        break;
      }
      case 'boundary':
        accepted.push({ ...l, confidence: clamp01(Number(l.confidence)) });
        break;
      case 'emotion':
        if (!isNum(l.valence) && !isNum(l.intensity)) { drop(l, 0, 'no-values'); break; }
        accepted.push({ ...l, valence: clamp(Number(l.valence) || 0, -1, 1), intensity: clamp01(Number(l.intensity) || 0), text: typeof l.text === 'string' ? clip(l.text, 60) : null });
        break;
      case 'future_q': {
        const f = cc(l.for ?? l.target);
        const text = typeof l.text === 'string' ? l.text.trim() : '';
        if (!f || !factOut.has(f) || !text) { drop(l, 7, 'future_q-target-unknown'); break; }
        (futureQ.get(f) ?? futureQ.set(f, []).get(f)).push(delabel(clip(text, 60)));
        break;
      }
      case 'plan_status': {
        const ev = evidence(l);
        if (!ev.ok) { drop(l, 1, ev.reason); break; }
        const target = factTarget(cc(l.target));
        if (!target) { drop(l, 7, 'plan-target-unknown'); break; }
        if (!PLAN_STATUS_IN.has(l.status)) { drop(l, 0, 'bad-status'); break; }
        accepted.push({ ...l, target, evidence: ev.rows.map((p) => p.id), msgRefs: ev.refs, speaker: codeOfPercept(ev.rows[0]), at: ev.rows.at(-1).at });
        break;
      }
      case 'confirm': {
        const ev = evidence(l);
        if (!ev.ok) { drop(l, 1, ev.reason); break; }
        const target = factTarget(cc(l.target));
        const by = ev.rows.map(codeOfPercept).find((c) => c && c !== '我') ?? null;
        if (!target) { drop(l, 7, 'confirm-target-unknown'); break; }
        if (!by) { drop(l, 7, 'confirm-by-her'); break; }   // 确认者不能是她自己
        accepted.push({ ...l, target, by, evidence: ev.rows.map((p) => p.id), msgRefs: ev.refs, at: ev.rows.at(-1).at });
        break;
      }
      case 'norm_update': {
        const ev = evidence(l);
        if (!ev.ok) { drop(l, 1, ev.reason); break; }
        const by = codeOfPercept(ev.rows[0]);
        const t = l.target && typeof l.target === 'object' ? l.target : { kind: l.target === 'setting' ? 'setting' : 'memory', ref: l.target };
        let target;
        if (t.kind === 'setting') target = { kind: 'setting' };
        else {
          const c = cc(t.ref);
          if (c && (bgCodes.has(c) || factOut.has(c))) target = { kind: 'memory', code: c };
          else if (c && msgRefs.has(c)) target = { kind: 'percept', code: c };
          else { drop(l, 7, 'norm-target-unknown'); break; }
        }
        const direction = l.direction === 'relax' ? 'relax' : 'tighten';
        const change = l.change && typeof l.change === 'object' ? l.change : {};
        const scope = change.restriction_scope ?? {};
        const out = {
          ...l, target, direction, by, evidence: ev.rows.map((p) => p.id), msgRefs: ev.refs, at: ev.rows[0].at, notify: [],
          change: {
            restriction: RESTRICTIONS.has(change.restriction) ? change.restriction : null,
            allow: arr(scope.allow).map(cc).filter(known), deny: arr(scope.deny).map(cc).filter(known),
            rule: typeof change.rule === 'string' ? delabel(clip(change.rule.trim(), 120)) : null,
          },
          quote: typeof l.quote === 'string' ? clip(l.quote, 60) : null,
          claimsAuthorityOf: (() => { const c = cc(l.claims_authority_of); return c && known(c) ? c : null; })(),
        };
        if (by === '我') { drop(l, 9, 'norm-update-by-her'); break; }
        // 第 9 条：放宽要权限：经权利层确认的主体本人、当初提出限制的人、有管理权限的人；否则只记成听来的「有人说可以说了」
        if (direction === 'relax') {
          const byId = entityOf(by);
          let ok = authority(by) !== 'none';
          if (!ok && target.kind === 'setting') ok = ev.rows.some((p) => moderates(p));
          if (!ok && target.kind === 'memory' && byId) {
            const subs = subjectsOfTarget(target.code);
            ok = subs.includes(byId) || subs.some((s) => { try { return core.mods.entities.rightsHolder(core, byId, s); } catch { return false; } })
              || speakersOfTarget(target.code).includes(byId);
          }
          if (!ok) { out.downgraded = true; rewritten += 1; dropped.push({ line: l, rule: 9, reason: 'relax-without-authority(downgraded)' }); }
        }
        if (out.change.deny.some((c) => authority(c) !== 'none')) out.notify.push({ kind: 'T1', reason: SECRECY });
        accepted.push(out);
        break;
      }
      case 'intent': {
        if (historical) { drop(l, 11, 'historical'); break; }
        const ev = evidence(l);
        if (!ev.ok) { drop(l, 1, ev.reason); break; }
        const target = cc(l.target);
        if (!target || target === '我' || !known(target) || !entityOf(target)) { drop(l, 11, 'target-unknown'); break; }
        const evCodes = ev.rows.map(codeOfPercept);
        const by = evCodes.find((c) => c !== '我') ?? '我';
        // 第 8 条：没有权限的人给的指令不成为意图
        if (l.directive === true && by !== '我' && authority(by) === 'none') {
          const rec = directiveRecord({ subjects: [by], notify: [] }, by, label(by), String(l.text ?? ''), cfg);
          accepted.push({ ...rec, type: 'fact', id: `f#d${++auto}`, evidence: ev.rows.map((p) => p.id), msgRefs: ev.refs, speaker: by, asserter: by, hop: 0,
            mode: modeOfPercept(ev.rows[0]), opKind: 'new', opTarget: null, needsReview: false, eventTime: null, plannedTime: null, validFrom: null, survival: null,
            imp: 3, confidence: 0.9, norm: { restriction: 'none', allow: [], deny: [], quote: null, summary: null }, mentions: [], object: null, futureQ: [] });
          rewritten += 1;
          break;
        }
        const about = factTarget(cc(l.about));
        const act = typeof l.act === 'string' && l.act.trim() ? clip(l.act.trim(), 32) : null;
        if (!act) { drop(l, 0, 'no-act'); break; }
        let origin = ORIGINS.has(l.origin) ? l.origin : null;
        // 第 11 条：origin 必须和证据一致
        let problem = null;
        if (act === 'verify') { if (authority(target) === 'none') problem = 'verify-target-not-principal'; origin = origin ?? 'self-care'; }
        else if (origin === 'self-commitment') { if (!evCodes.includes('我')) problem = 'no-commitment-by-her'; }
        else if (origin === 'principal-request') { if (!evCodes.some((c) => c !== '我' && authority(c) !== 'none')) problem = 'request-not-by-principal'; }
        else if (origin === 'self-care') {
          const tid = entityOf(target);
          const aboutTarget = about && subjectsOfTarget(about).includes(tid);
          const fromTarget = evCodes.includes(target);
          const fact = about && factOut.get(about);
          const agentMatch = fact && fact.agent === target;
          if (!aboutTarget && !fromTarget && !agentMatch) problem = 'not-about-target';
        } else problem = 'unknown-origin';
        if (problem) { drop(l, 11, problem); break; }
        const win = parseWindow(core, l.trigger?.window ?? l.trigger?.time_window, ev.rows[0].at);
        const cues = arr(l.trigger?.cues).map((c) => (typeof c === 'string' ? cc(c) : c)).filter((c) => typeof c === 'string' ? known(c) : c && typeof c === 'object');
        accepted.push({ ...l, target, about, act, origin, text: delabel(clip(String(l.text ?? act), 120)), window: win, cues, evidence: ev.rows.map((p) => p.id), msgRefs: ev.refs });
        break;
      }
      default:
        break;
    }
  }
  for (const [f, qs] of futureQ) {
    const out = factOut.get(f);
    if (out) out.futureQ = [...new Set([...out.futureQ, ...qs])].slice(0, cfg.extract.futureQMax);
  }

  // ── 第 10 条：配额（每个说话人每天新事实 10 × (1 + 4 × closeness)，听说占一半，principal 不限） ──────
  const share = cfg.extract.quota.hearsayShare;
  const tally = new Map();
  for (let i = 0; i < accepted.length; i++) {
    const l = accepted[i];
    if (!FACTISH.has(l.type) || l.type === 'self' || l.opKind === 'dup' || l.kindHint === 'request') continue;
    const id = entityOf(l.speaker);
    if (!id || id === selfId) continue;
    const day = localDay(core, percepts.get(l.evidence[0])?.at ?? core.now());
    const key = `${day}|${id}`;
    let t = tally.get(key);
    if (!t) {
      let bond = null;
      try { bond = core.mods.entities.bondOf(core, id); } catch { bond = null; }
      const used = quotaUsed(core, day, id);
      t = { facts: used.facts, hearsay: used.hearsay, limit: quotaLimit(core, bond) };
      tally.set(key, t);
    }
    const hearsay = l.certainty === 'hearsay';
    if (t.facts + 1 > t.limit || (hearsay && t.hearsay + 1 > t.limit * share)) {
      accepted.splice(i, 1); i -= 1;
      drop(l, 10, 'quota');
      continue;
    }
    t.facts += 1; if (hearsay) t.hearsay += 1;
    l.quota = { day, entityId: id, hearsay };
  }
  return { accepted, dropped, rewritten };
}

/** 说话人在那个场合是不是管理者（感知的 actor_json 里的 role-in-setting 证据，适配器给的事实）。 */
function moderates(p) {
  const actor = jsonParse(p.actor_json, null);
  return !!actor?.claims?.some((c) => c?.kind === 'role-in-setting' && (c.moderates === true || c.isOwner === true));
}

/** 没采纳的要求（§7.4 第 8 条）：只记「U3 提过一个要求，没采纳」，报 T1。 */
function directiveRecord(out, speaker, speakerLabel, text, cfg) {
  return {
    subjects: [speaker], object: null, mentions: [], predicate: '提过的要求', value: null, kind_hint: 'request', kindHint: 'request',
    text: clip(`${speakerLabel}提过一个要求，没采纳：${clip(text, 70)}`, cfg.extract.factTextMax),
    certainty: 'stated', hop: 0, imp: 3, directiveRejected: true, opKind: 'new', opTarget: null,
    notify: [...(out.notify ?? []), { kind: 'T1', reason: 'directive' }],
    norm: { ...(out.norm ?? {}), restriction: out.norm?.restriction ?? 'none', allow: [], deny: out.norm?.deny ?? [] },
  };
}
