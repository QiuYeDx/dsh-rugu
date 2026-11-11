// 关口①第一段（§9.3.2）：同步、纯代码、只读抽象属性。先查底线（B1–B5、T1/T2），再看放行（A1–A3）；底线命中的任何放行都推翻不了。
// 结论：pass 放行 / block 不提 / cap 封顶（仍进第二段，最多给到 cap）/ stage2 交给第二段。
// 还没评估的内容（unassessed）离开 visible_to 时带 notes 'unassessed'：第二段替提炼报敏感度和限制，再用 evaluateWithNorm
// 按同一套底线复核一遍（D99）。只有这件事就是触发者自己说的、或者听的人只有管理者时才不封顶；别人问起、她自己私下想的 / 读到的，
// 照旧最多说个大概（代码看得到的事实，不靠第二段自己报的分寸）。工作记忆（A4 / A5）的准入在 working.js（D100）。
import { dcfg, stricterVerdict, rRank, RESTRICTION_BY_RANK, parseJson, soft } from './util.js';
import {
  memoryFacts, selfId, managerIds, isIndividual, rightsEquivalents, relatedEntities, confirmedRelations, sameishLinks, needToKnowKinds, bond,
  identityEvidenceLinks, memorySides, seenOnSide, repliedToTrigger,
} from './facts.js';
import { circleOf, newKnowers, managerOnly, audiencePeople, firstSeen, unionCircles } from './knowledge.js';
import { normOf } from './norms.js';
import { glancesOf } from './glance.js';

/** stage1 的 rule 取值（§4.7 的约定）。 */
// A4 / A5 只出现在工作记忆的准入里（discretion.admitWorking，D100）：A4 这一行是触发者亲口说的（他要她做的事也是），
// A5 是她回触发者的那一句；涉及的人只有触发者和她。evaluateOne 自己不给这两条
export const STAGE1_RULES = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'T1', 'T2', 'A1a', 'A1b', 'A2', 'A3', 'A4', 'A5', 'self-only', 'unassessed', 'sensitive', 'late-member', 'stage2',
  'suppressed', 'missing', 'error']);

const DECISION_RANK = { pass: 0, stage2: 1, cap: 2, block: 3 };

const normAttr = (s) => String(s ?? '').normalize('NFKC').trim().toLowerCase();

/** 主人的披露规则（rules.kind='disclosure'，admin 的表）。读不到 admin 的函数时直接读表。 */
function ownerRules(core, memo) {
  if (memo?.has('ownerRules')) return memo.get('ownerRules');
  let rows;
  try { rows = core.mods.admin.activeRules(core, 'disclosure'); } catch {
    rows = core.store.all("SELECT id, target_json, value_json FROM rules WHERE kind = 'disclosure' AND revoked_at IS NULL");
  }
  const out = (Array.isArray(rows) ? rows : []).map((r) => ({
    target: r.target ?? parseJson(r.target_json, {}),
    value: r.value !== undefined ? r.value : parseJson(r.value_json, null),
  })).filter((r) => r.target && typeof r.target === 'object');
  memo?.set('ownerRules', out);
  return out;
}

function ruleAction(v) {
  const x = typeof v === 'string' ? v : v && typeof v === 'object' ? (v.verdict ?? v.max ?? v.restriction ?? v.action) : null;
  switch (x) {
    case 'omit': case 'block': case 'strict': case 'never': return 'block';
    case 'aware_private': return 'aware_private';
    case 'share_vague': case 'vague': case 'soft': return 'share_vague';
    case 'share': case 'allow': case 'none': return 'allow';
    default: return 'block';   // 认不出的主人规则按最严处理
  }
}

function ruleMatches(rule, f, norm, a) {
  const t = rule.target;
  let any = false;
  if (t.entity != null || Array.isArray(t.entities)) {
    any = true;
    const ids = [t.entity, ...(t.entities ?? [])].filter((x) => x != null).map(Number);
    if (!ids.some((id) => f.involved.has(id))) return false;
  }
  if (t.attribute != null) {
    any = true;
    if (!norm.attribute || normAttr(norm.attribute) !== normAttr(t.attribute)) return false;
  }
  if (t.settingKey != null) {
    any = true;
    if (t.settingKey !== a.settingKey) return false;
  }
  const s = t.settingAttrs;
  if (s && typeof s === 'object') {
    any = true;
    for (const [k, v] of Object.entries(s)) {
      if (k === 'minExposureRank') { if (!(a.exposureRank >= v)) return false; continue; }
      if (k === 'maxExposureRank') { if (!(a.exposureRank <= v)) return false; continue; }
      if (k === 'minPersistenceRank') { if (!(a.persistenceRank >= v)) return false; continue; }
      if (['visibleTo', 'persistence', 'oneOnOne', 'publicLike', 'exposureRank', 'persistenceRank', 'preSendGate', 'canHold'].includes(k)) {
        if (a[k] !== v) return false;
      }
    }
  }
  return any;
}

function suppressionOf(core, m, memo) {
  const k = `sup:${m.kind}:${m.id}`;
  if (memo?.has(k)) return memo.get(k);
  const v = core.store.get('SELECT state FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id)?.state ?? null;
  memo?.set(k, v);
  return v;
}

/** 敏感度事实最多看一条记忆的几条来源原话（和 facts.js 里原文窗口成员的上限一样）。 */
const SENS_SOURCES_MAX = 50;

/** 这条记忆的来源原话（感知 id）：感知是它自己；原文窗口是成员；情节是来源加上归进它的感知；事实是来源感知。别的种类没有。 */
function sourcePercepts(core, m, f, memo) {
  switch (m.kind) {
    case 'percept': return [m.id];
    case 'window': case 'assertion': return (f.perceptIds ?? []).slice(0, SENS_SOURCES_MAX);
    case 'episode': {
      const ids = new Set((f.perceptIds ?? []).slice(0, SENS_SOURCES_MAX));
      if (ids.size < SENS_SOURCES_MAX) {
        for (const r of core.store.all('SELECT id FROM percepts WHERE episode_id = ? ORDER BY id LIMIT ?', m.id, SENS_SOURCES_MAX - ids.size)) ids.add(r.id);
      }
      return [...ids];
    }
    default: return [];
  }
}

/**
 * 【D135】这条记忆的敏感度事实 = 规范的敏感度（有的话）和来源原话第一眼 sens 的最大值。第一眼还没看完的不算（不等它）。
 * 规范是提炼出来的，常比第一眼低（「他私下说自己欠了一笔钱」第一眼 0.9，提炼完规范只有 0.3），只看规范的话提炼一完成底线就没了；
 * 原文窗口、情节、事实自己没有第一眼，看的是它们的来源原话。结果在这一次判定的 memo 里缓存。
 * @returns {{value: number|null, byGlance: boolean}}  value：都读不到时 null；byGlance：第一眼比规范高（这个量是靠第一眼定的）
 */
export function sensitivityFact(core, m, memo) {
  const k = `sensFact:${m.kind}:${m.id}`;
  if (memo?.has(k)) return memo.get(k);
  const norm = normOf(core, m, memo);
  const base = Number.isFinite(norm?.sensitivity) ? norm.sensitivity : null;
  let glance = null;
  const ids = sourcePercepts(core, m, memoryFacts(core, m, memo), memo);
  if (ids.length) {
    const gs = soft(core, 'stage1.glance', () => glancesOf(core, ids), new Map()) ?? new Map();
    for (const g of gs.values()) if (g?.state === 'done' && Number.isFinite(g.sens) && (glance == null || g.sens > glance)) glance = g.sens;
  }
  const value = base == null ? glance : glance == null ? base : Math.max(base, glance);
  const out = { value, byGlance: glance != null && (base == null || glance > base) };
  memo?.set(k, out);
  return out;
}

/**
 * 对一个受众判一条记忆。返回的东西第二段的卡片也要用（规范、已知圈、新知情者、备注）。
 * ctx.triggerEntityId：这一轮的触发者（判断「这件事是不是他自己说的」，D99）。
 * @param {{triggerEntityId?: number|null}} [ctx]
 * @returns {{decision: 'pass'|'block'|'cap'|'stage2', rule: string, cap?: string, notes: string[], N: any, norm: any, circle: any, facts: any,
 *            managerOnly: boolean, subjectPresent: boolean, subjects: number[], ntk: Set<string>, audience: any, hintBlocked: boolean, toldByTrigger: boolean,
 *            repliedToTrigger: boolean, sensitiveOther?: boolean}}  repliedToTrigger：她回这一轮的触发者的那一句（facts.repliedToTrigger，D110），和 toldByTrigger 一样不按「别人问起」封顶；
 *            sensitiveOther：给第三方的敏感私事（D113：敏感度 ≥ b5Sensitivity、不是他自己的、听的不只是管理者、这里有人没听到且不在同一场合；
 *            D135 起敏感度用 sensitivityFact：规范的和来源原话第一眼的取大，感知、原文窗口、情节、事实都看，评估过的也照样）
 */
export function evaluateOne(core, m, a, memo, ctx = {}) {
  const cfg = dcfg(core);
  const th = cfg.thresholds;
  const f = memoryFacts(core, m, memo);
  const base = { notes: [], managerOnly: false, subjectPresent: false, subjects: [], ntk: new Set(), audience: a, facts: f, hintBlocked: false, toldByTrigger: false,
    repliedToTrigger: false };
  if (!f.exists) return { ...base, decision: 'block', rule: 'missing', N: null, norm: null, circle: null };
  const norm = normOf(core, m, memo);
  const circle = circleOf(core, m, memo);
  const N = newKnowers(core, circle, a, memo);
  const me = selfId(core, memo);
  const mgr = managerIds(core, memo);
  const mgrOnly = managerOnly(core, a, memo);
  const ntk = needToKnowKinds(core, m, f, memo);
  const people = audiencePeople(core, a, memo);
  const peopleEq = rightsEquivalents(core, people, memo);
  const present = (e) => people.some((p) => p === e || peopleEq.get(p)?.has(e));
  // 在这个场合里出现过（在场，或者以前在这里出现过；同一个人经权利层确认的其他身份也算）
  const member = (e) => {
    if (present(e)) return true;
    if (!a.known) return false;
    const eq = rightsEquivalents(core, [e], memo).get(e) ?? new Set([e]);
    return [...eq].some((x) => firstSeen(core, x, a.settingKey, memo) != null);
  };
  const individuals = [...f.involved].filter((e) => e !== me && isIndividual(core, e, memo));
  let subjects = [...f.subjects].filter((e) => e !== me && isIndividual(core, e, memo));
  if (!subjects.length) subjects = individuals;
  const out = { ...base, N, norm, circle, managerOnly: mgrOnly, subjectPresent: subjects.some(present), subjects, ntk, ownerCap: false, sensitiveOther: false, namedDeny: false };
  const notes = out.notes;
  let cap = null;
  let capRule = null;
  const capTo = (v, rule) => { const nc = stricterVerdict(cap, v); if (nc !== cap) { cap = nc; capRule = rule; } else if (!capRule) capRule = rule; };
  const done = (decision, rule) => Object.assign(out, { decision, rule, ...(cap && decision !== 'pass' && decision !== 'block' ? { cap } : {}) });
  if (norm.derivation === 'inference' || f.derivedSelf) notes.push('own-guess');
  if (mgrOnly) notes.push('manager');
  out.toldByTrigger = toldByTrigger(core, f, notes.includes('own-guess'), ctx.triggerEntityId, memo);
  // 她回这一轮的触发者的那一句（D110 C7，和工作记忆 A5 同一个口径）：和他自己说的一样，不按「别人问起」封顶。
  // 但只在这句话说的不是别人的事时（评审：「她说她怀孕了，还没告诉家里」是她回他的话，转述的却是第三个人的敏感事；扫名字认不出
  // 代词和没登记的称呼）：评估过、涉及别人（involvesOthers）或者主体里有他和她以外的人的，照旧按「别人的敏感事」「污点」封顶。
  // 还没评估的（18:03 那一轮的「9801」）仍然只靠扫名字——普通回想这一路没有 P1–P3 的出口底线，第二段和关口②照常把关
  const trigEq = ctx.triggerEntityId != null ? (rightsEquivalents(core, [ctx.triggerEntityId], memo).get(ctx.triggerEntityId) ?? new Set([ctx.triggerEntityId])) : new Set();
  const othersMatter = !norm.unassessed && (!!norm.involvesOthers || subjects.some((e) => e !== ctx.triggerEntityId && !trigEq.has(e)));
  out.repliedToTrigger = !out.toldByTrigger && !notes.includes('own-guess') && !othersMatter && repliedToTrigger(core, f, ctx.triggerEntityId, memo);
  const hisOwn = out.toldByTrigger || out.repliedToTrigger;

  // 隐藏 / 忘掉（admin 的表）：隐藏 = 对别人隐藏，只对管理者可见；忘掉 = 谁都不提
  const sup = suppressionOf(core, m, memo);
  if (sup === 'forgotten' || (sup === 'hidden' && !mgrOnly)) return done('block', 'suppressed');

  // 派生内容的放宽：证据来自 ≥ k 个不同的主体、自己不涉及具体的个人、目标受众规模 > k，最多放宽一级，永远不用于公开场合（§5.6）
  let restriction = norm.restriction;
  const k = cfg.derivedRelaxK;
  if (norm.relaxK != null && norm.relaxK >= k && !individuals.length && !a.publicLike && typeof a.size === 'number' && a.size > k && rRank(restriction) > 0) {
    restriction = RESTRICTION_BY_RANK[rRank(restriction) - 1];
    notes.push('relaxed-derived');
  }

  // ── 底线 ──
  // B3 身份对应：流向不知道这层对应的人 → 不提；只在和有权限的人一对一时例外
  let linkIssue = false;
  if (norm.identityLink) linkIssue = !N.empty;
  else {
    const direct = new Set(people);
    let sides = null;
    for (const e of individuals) {
      // 这个身份本人就在场：说的是他自己这边的事。只有「另一个身份」在场时，说出来才会暴露对应
      if (direct.has(e)) continue;
      for (const l of sameishLinks(core, e, memo)) {
        if (direct.has(l.other)) {
          // 受众里有他的另一个身份：把这边的事说给那边，就是说出了这层对应
          const lc = circleOf(core, { kind: 'link', id: l.linkId }, memo);
          if (!newKnowers(core, lc, a, memo).empty) { linkIssue = true; break; }
          continue;
        }
        // 他的另一个身份在受众这一侧露过面，这条记忆却只来自另一侧：是经由链接才连上的，
        // 受众不知道这层对应时只用和受众同一侧来源的那部分（§5.2）——那个身份在不在场都一样
        sides ??= memorySides(core, f, memo);
        if (!a.adapter || !sides.size || sides.has(a.adapter) || !seenOnSide(core, l.other, a.adapter, memo)) continue;
        const lc = unionCircles([circle, circleOf(core, { kind: 'link', id: l.linkId }, memo)]);
        if (!newKnowers(core, lc, a, memo).empty) { linkIssue = true; notes.push('other-side'); break; }
      }
      if (linkIssue) break;
    }
    // 内容本身说的就是这层对应：来源感知是跨命名空间链接的证据（自我介绍、含这句话的原文窗口和情节）。
    // 知道这层对应的 = 知道这条记忆的人 ∪ 知道那条链接的人；流向这以外的人就是说出了对应——在不在场都一样
    if (!linkIssue) {
      for (const linkId of identityEvidenceLinks(core, f.perceptIds, memo)) {
        const lc = unionCircles([circle, circleOf(core, { kind: 'link', id: linkId }, memo)]);
        if (!newKnowers(core, lc, a, memo).empty) { linkIssue = true; notes.push('identity-evidence'); break; }
      }
    }
  }
  if (linkIssue) {
    if (!mgrOnly) return done('block', 'B3');
    notes.push('identity-link');
  }

  // B4 主人的披露规则
  let b4Allow = false;
  for (const r of ownerRules(core, memo)) {
    if (!ruleMatches(r, f, norm, a)) continue;
    const act = ruleAction(r.value);
    if (act === 'block') return done('block', 'B4');
    if (act === 'allow') b4Allow = true;
    else { capTo(act, 'B4'); out.ownerCap = true; }   // 主人定的上限（D113：非公开目标上也照旧由代码执行，不只是标签）
  }

  // T1 / T2：管理者的知情底线，第二段推翻不了（§9.3.7）
  const t12 = ntk.has('T1') ? 'T1' : ntk.has('T2') ? 'T2' : null;
  if (t12 && mgrOnly) return cap ? done('cap', 'B4') : done('pass', t12);

  // B1 明确限制（deny / allow / strict）
  const deny = (norm.deny ?? []).filter((d) => !(t12 && mgr.has(d)));   // deny 的对象是管理者而内容属于 T1/T2：不受约束
  // 几种情况各自判，取最严的：strict 不提；relation（关系人在场 / 可能在场）和 soft 进第二段并封顶
  const b1Hits = [];
  if (deny.length) {
    if (deny.some((d) => member(d))) b1Hits.push('strict');
    else if (deny.some((d) => [...relatedEntities(core, d, memo)].some((r) => r !== me && member(r)))) { b1Hits.push('relation'); notes.push('deny-relation'); }
    else if (N.unknownRemainder && !mgrOnly) {
      // 受众看不全（只看得到最近说话的人、有不认识的旁观者）：被禁止的人可能就在里面，和「关系人在场」一样交给第二段、不暗示
      b1Hits.push('relation');
      notes.push('deny-maybe-present');
    }
  }
  if (norm.allow) {
    const allowed = new Set(norm.allow);
    const allowedEq = rightsEquivalents(core, norm.allow, memo);
    for (const s of allowedEq.values()) for (const x of s) allowed.add(x);
    const violators = [...N.unknown, ...N.lateMembers].filter((p) => !allowed.has(p));
    if (violators.length || N.unknownRemainder) b1Hits.push(restriction === 'soft' ? 'soft' : 'strict');
  }
  if (restriction === 'strict' && !N.empty) b1Hits.push('strict');
  const b1 = b1Hits.includes('strict') ? 'strict' : b1Hits[0] ?? null;
  if (b1) {
    if (mgrOnly) { capTo('share_vague', 'B1'); notes.push('restricted'); }   // 对管理者：她自己判断，最多说个大概（S28）
    else if (b1 === 'strict') return done('block', 'B1');
    else { capTo('share_vague', 'B1'); if (b1Hits.includes('relation')) out.hintBlocked = true; }
  }
  // 叮嘱里被点名不让知道的人的关系人确实在这里（D113 非公开目标的上下文底线 named-deny）：只认「确实在 / 在这里出现过」，
  // 不认「受众看不全、可能在」（QQ 群永远看不全，那样等于有名单的事在所有群里都想不起来）；定这条叮嘱的人自己就在这里问的不算
  const byTrigger = norm.restrictedBy != null && ctx.triggerEntityId != null && present(ctx.triggerEntityId)
    && (norm.restrictedBy === ctx.triggerEntityId || trigEq.has(norm.restrictedBy));
  out.namedDeny = !mgrOnly && notes.includes('deny-relation') && !byTrigger;

  // B2 公开场合：来源更窄、涉及她以外的具体的人 → 最多不点名的说个大概；敏感的不提
  const oe = norm.originExposure ?? {};
  const narrower = (oe.exposureRank ?? 3) < a.exposureRank || (oe.persistenceRank ?? 2) < a.persistenceRank;
  if (a.publicLike && narrower && (norm.involvesOthers || norm.unassessed || individuals.length)) {
    if ((norm.sensitivity ?? 0) >= th.b2OmitSensitivity) return done('block', 'B2');
    capTo('share_vague', 'B2');
    notes.push('unnamed');
  }

  // B5 一对一面对陌生人：主体不在场、没有已知关系、亲密度低，内容敏感 → 不提（和场合公不公开无关）
  if (a.oneOnOne || (a.exposureRank === 0 && people.length === 1)) {
    const receivers = people.length ? people : [];
    const sens = norm.sensitivity;
    if (sens != null && sens >= th.b5Sensitivity) {
      for (const r of receivers) {
        if (mgr.has(r) || bond(core, r, memo).closeness >= th.b5MaxCloseness) continue;
        const rEq = peopleEq.get(r) ?? new Set([r]);
        const absent = subjects.filter((s) => !rEq.has(s));
        // 放松底线只认经确认的关系：自称「我是阿明的表哥」不算（§9.6）
        const unrelated = absent.filter((s) => ![...rEq].some((x) => confirmedRelations(core, s, memo).has(x)));
        if (unrelated.length) return done('block', 'B5');
      }
    }
  }

  // 别人的敏感事、问的人不是说的人（D102）：已评估、敏感度 ≥ notTellerShareMaxSensitivity、离开了原来的场合、这里有人当时没听到、这一轮的触发者
  // 不是说这件事的人、听的人也不只是管理者 → 最多说个大概（上限在调用第二段之前写在卡片上）。和还没评估的原话「别人问起最多说个大概」
  // 同一个道理：看的是代码看得到的事实（谁说的、谁在问、多敏感），不靠第二段自己报的分寸（它可能被提问的人带偏）
  // 敏感度用「这条记忆的敏感度事实」（D135）：规范的和来源原话第一眼的取大
  const sf = sensitivityFact(core, m, memo);
  if (!norm.unassessed && !hisOwn && !mgrOnly && !N.empty && !N.sameSetting && (sf.value ?? 0) >= (th.notTellerShareMaxSensitivity ?? 0.5)) {
    capTo('share_vague', 'sensitive');
  }
  // 给第三方的敏感私事（D113，非公开目标的一条上下文底线）：和上面同一组事实，只是阈值用 b5Sensitivity——敏感度 ≥ 0.7、
  // 不是他自己的事、听的人不只是管理者、这里有人当时没听到而且不在同一场合。只多导出这一个量，第一段别的规则不因它改变。
  // D135：不再限「还没评估的单条感知」——感知、原文窗口、情节、事实都看，评估过的也照样看来源原话的第一眼
  //（提炼出来的规范常比第一眼低：一句第一眼判成 0.9 的私事，提炼一完成底线就没了；含它的原文窗口、情节原来从不触发）
  out.sensitiveOther = sf.value != null && !hisOwn && !mgrOnly && !N.empty && !N.sameSetting && sf.value >= th.b5Sensitivity;
  out.sensitiveByGlance = out.sensitiveOther && sf.byGlance;

  // ── 放行 ──
  const selfOnly = circle.selfOnly || norm.derivation === 'inference' || f.visibleTo === 'her-only' || f.derivedSelf;
  const originPublic = (oe.exposureRank ?? 0) >= 3 && (oe.persistenceRank ?? 0) >= 2;
  // 她自己的猜测：断言者是她，不是主体本人（涉及别人时 A3 的「断言者就是主体本人」不成立）
  const guess = norm.derivation === 'inference' || f.derivedSelf;
  const asserterIsSubject = guess ? subjects.length === 0 : assertedBySubject(core, f, norm, subjects, me, memo);
  const publicHearsay = originPublic && (norm.involvesOthers || norm.unassessed) && !asserterIsSubject;
  const noLists = !norm.allow && !(norm.deny ?? []).length;
  let pass = null;
  let late = false;
  // A1：心里想的、推断的、私下读到的永远不经 A1；陌生人在公开场合贴出的别人的事也不走 A1、A3（§9.3.2）
  if (!selfOnly && !publicHearsay) {
    if (N.sameSetting && !N.sameSetting.reachGrew && N.unknown.length === 0 && !N.unknownRemainder) {
      // (b) 同一个场合（或子场合）当众说的，可见范围没变大；晚到的成员遇到敏感内容单独交给第二段
      if (N.lateMembers.length && (norm.unassessed || (norm.sensitivity ?? 0) >= th.lateMemberSensitivity || rRank(restriction) > 0)) { late = true; notes.push('late-member'); }
      else pass = 'A1b';
    } else if (a.completeness === 'exact' && a.members && !a.unknownObservers && N.empty) pass = 'A1a';
  }
  if (!pass && !norm.unassessed) {
    if (!norm.involvesOthers && !individuals.length && (norm.sensitivity ?? 0) < th.a2MaxSensitivity && restriction === 'none' && noLists && !norm.identityLink) pass = 'A2';
    else if (originPublic && restriction === 'none' && noLists && (norm.sensitivity ?? 0) < th.a3MaxSensitivity && !norm.identityLink && !publicHearsay) pass = 'A3';
  }
  if (pass) return cap ? done('cap', capRule) : done('pass', pass);
  if (b4Allow && !cap && !b1 && !late && !norm.unassessed && !selfOnly) return done('pass', 'B4');
  // 还没评估的原话（感知、原文窗口）离开 visible_to：只能经第二段，卡片上有原话和前后几句，它替提炼报出敏感度和有没有人说过
  // 别外传，代码按同一套底线收紧（stage2.js 的 finalizeVerdict）；报不出的最多说个大概，跑不了的不给（D99）。
  // 不封顶只在代码看得到的两种情形：这件事就是这一轮的触发者自己说的（他自己把话头带到这里）、听的人只有管理者（没有泄露面）。
  // 别人问起、她自己私下想的 / 读到的，照旧最多说个大概——不管第二段自己报多不敏感（它可能判错、被带偏）。
  // 派生的（情节、事实、小结……）来源还没提炼时：说的人就是触发者（或听的人只有管理者）时也不再封顶（D102「封顶缩到触发者不是说的人」），
  // 同样带 'unassessed' 让第二段替提炼报分寸、代码按同一套底线复核；别人问起的照旧封顶（D80）
  if (norm.unassessed) {
    notes.push('unassessed');
    if (selfOnly || !(hisOwn || mgrOnly)) capTo('share_vague', 'unassessed');
  }
  const rule = capRule ?? (late ? 'late-member' : selfOnly ? 'self-only' : norm.unassessed ? 'unassessed' : 'stage2');
  return cap ? done('cap', rule) : done('stage2', rule);
}

/**
 * 这件事是不是这一轮的触发者自己说的（D99）：原话的说话人、事实的说话人 / 断言者里，除了她自己全是触发者本人
 *（同一个人经权利层确认的其他身份也算）。她自己的猜测、只有她自己说过的、没有触发者的 → false。
 * @param {any} f memoryFacts
 * @param {boolean} ownGuess
 * @param {number|null|undefined} trig
 */
export function toldByTrigger(core, f, ownGuess, trig, memo) {
  if (trig == null || ownGuess || !f) return false;
  const me = selfId(core, memo);
  const tellers = [...(f.speakers ?? []), ...(f.asserters ?? [])].filter((x) => x != null && x !== me);
  if (!tellers.length) return false;
  const eq = rightsEquivalents(core, [trig], memo).get(trig) ?? new Set([trig]);
  return tellers.every((t) => t === trig || eq.has(t));
}

/** 断言者就是主体本人吗（A3「断言者就是主体本人」；没评估过的别人的话按「不是」）。 */
function assertedBySubject(core, f, norm, subjects, me, memo) {
  if (!subjects.length) return true;
  if (norm.unassessed || f.kind === 'percept' || f.kind === 'window') return [...f.speakers].every((s) => s === me);
  const srcs = f.sources ?? [];
  if (!srcs.length) return false;
  const eq = rightsEquivalents(core, subjects, memo);
  const subj = new Set();
  for (const s of eq.values()) for (const x of s) subj.add(x);
  return srcs.every((s) => { const who = s.asserter ?? s.speaker; return who != null && subj.has(who); });
}

/**
 * 对一个目标判一条记忆（批量提示词：全部目标的并集按最严的算，§9.4.1 第 4 条）。
 */
export function evaluate(core, m, target, memo = new Map()) {
  const audiences = [target.audience, ...(target.batchTargets ?? [])].filter(Boolean);
  let primary = null;
  let worst = null;
  for (const a of audiences) {
    let e;
    try { e = evaluateOne(core, m, a, memo, { triggerEntityId: target.triggerEntityId }); } catch (err) {
      soft(core, 'stage1', () => { throw err; }, null);
      e = { decision: 'block', rule: 'error', notes: [], N: null, norm: null, circle: null, facts: null, audience: a, ntk: new Set(), subjects: [] };
    }
    if (!primary) primary = e;
    if (!worst || DECISION_RANK[e.decision] > DECISION_RANK[worst.decision]
      || (e.decision === worst.decision && e.cap && stricterVerdict(worst.cap, e.cap) === e.cap && e.cap !== worst.cap)) worst = e;
  }
  if (!primary) return { decision: 'block', rule: 'error', notes: [], N: null, ntk: new Set(), subjects: [] };
  if (worst === primary) return primary;
  // 合成：结论取最严，卡片用主目标的上下文，但带上最严的那个目标的新知情者
  const caps = [primary.cap, worst.cap].filter(Boolean);
  const cap = caps.reduce((x, y) => stricterVerdict(x, y), null);
  const decision = worst.decision === 'pass' && cap ? 'cap' : worst.decision;
  return { ...primary, decision, rule: worst.rule, ...(cap && decision !== 'pass' && decision !== 'block' ? { cap } : {}),
    notes: [...new Set([...primary.notes, ...worst.notes, 'batch'])], worstAudience: worst.audience, hintBlocked: primary.hintBlocked || worst.hintBlocked,
    sensitiveOther: !!(primary.sensitiveOther || worst.sensitiveOther), sensitiveByGlance: !!(primary.sensitiveByGlance || worst.sensitiveByGlance),
    ownerCap: !!(primary.ownerCap || worst.ownerCap), namedDeny: !!(primary.namedDeny || worst.namedDeny),
    N: worst.N ?? primary.N };
}

/**
 * 把第二段替还没评估的条目报出的分寸（敏感度、有没有人说过别外传）当成它的规范，按同一套第一段底线再判一次（D99）。
 * 只用来收紧：敏感度取原有的和报出的大的那个，限制取更严的；allow / deny、涉及别人、来源场合都照原样。
 * @param {{sensitivity: number, restriction: 'none'|'soft'|'strict'}} assessed
 */
export function evaluateWithNorm(core, m, target, memo, assessed) {
  const k = `norm:${m.kind}:${m.id}`;
  const base = normOf(core, m, memo);
  const scratch = new Map(memo);
  scratch.set(k, {
    ...base, unassessed: false,
    sensitivity: Math.max(Number.isFinite(base.sensitivity) ? base.sensitivity : 0, assessed.sensitivity),
    restriction: rRank(assessed.restriction) > rRank(base.restriction) ? assessed.restriction : base.restriction,
  });
  return evaluate(core, m, target, scratch);
}

/** 对外的第一段结论（Stage1Decision）。 */
export function stage1Public(core, m, target) {
  const e = evaluate(core, m, target, new Map());
  return { decision: e.decision, rule: e.rule, ...(e.cap ? { cap: e.cap } : {}), notes: [...(e.notes ?? [])] };
}
