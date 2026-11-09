// 流动规范和场合规矩（§5.6）：写入时给出；之后只能收紧，放宽只认有权限的来源；场合规矩单调（没权限只能更严）。
import { RESTRICTIONS, isOpaqueId } from '../contract/index.js';
import { OWNER_KINDS, parseRef, refOf } from '../store/index.js';
import {
  rRank, stricterRestriction, idList, clamp01, clip, parseJson, sha16, metric, soft, warn,
} from './util.js';
import {
  memoryFacts, isIndividual, selfId, managerIds, settingInfo, snapshotAt, rightsHolder, SECRECY_REQUEST_REASON, platformNamed,
} from './facts.js';
import { circleOf, intersectCircles } from './knowledge.js';

const HISTORY_MAX = 50;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function assertRef(m) {
  if (!m || !OWNER_KINDS[m.kind] || !Number.isSafeInteger(m.id) || m.id <= 0) throw new TypeError('discretion：记忆引用不对（应为 {kind, id}）');
}

export function normRow(core, m) {
  return core.store.get('SELECT * FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id) ?? null;
}

function rowToNorm(r) {
  return {
    unassessed: false, version: r.version,
    originExposure: parseJson(r.origin_exposure_json, {}),
    settingRuleRef: r.setting_rule_ref ?? null, settingRuleVersion: r.setting_rule_version ?? null,
    restriction: RESTRICTIONS.includes(r.restriction) ? r.restriction : 'strict',
    allow: idList(parseJson(r.allow_json, null)), deny: idList(parseJson(r.deny_json, null)),
    restrictionQuote: r.restriction_quote ?? null, restrictedBy: r.restricted_by ?? null,
    attribute: r.attribute ?? null, sensitivity: r.sensitivity ?? null,
    involvesOthers: !!r.involves_others, identityLink: !!r.identity_link,
    derivation: r.derivation ?? null, relaxK: r.relax_k ?? null,
    summary: r.summary ?? null,
  };
}

/** 来源场合当时的公开程度（originExposure 没给时从来源推）。 */
function originFromFacts(core, f, memo) {
  if (!f?.settingKey) return {};
  const snap = snapshotAt(core, f.settingKey, f.at ?? core.now(), memo);
  return {
    settingKey: f.settingKey,
    exposureRank: snap?.exposureRank ?? 3, persistenceRank: snap?.persistenceRank ?? 2,
    ...(f.visibleTo ? { visibleTo: f.visibleTo } : {}),
    ...(snap ? { snapshotId: snap.id } : {}),
  };
}

/** 没评估过的规范：按最严处理（只能经 A1；离开 visible_to 最多「说个大概」，§5.6）。涉及别人按「是」。 */
function unassessedNorm(core, f, memo) {
  const origin = originFromFacts(core, f, memo);
  return {
    unassessed: true, version: 0, originExposure: origin,
    settingRuleRef: origin.settingKey ?? null, settingRuleVersion: null,
    restriction: 'none', allow: null, deny: null, restrictionQuote: null, restrictedBy: null,
    attribute: null, sensitivity: null, involvesOthers: true, identityLink: false,
    derivation: f?.derivedSelf ? 'inference' : null, relaxK: null, summary: null,
  };
}

function mergeLists(a, b, mode) {
  if (!a) return b ? [...b] : null;
  if (!b) return [...a];
  if (mode === 'union') return idList([...a, ...b]);
  const s = new Set(b);
  return a.filter((x) => s.has(x));
}

/** 几条规范里最严的合成一条（派生内容、原文窗口、合并行和推出来的规范）。 */
export function combineStrictest(list) {
  const norms = list.filter(Boolean);
  if (!norms.length) return null;
  const narrowest = norms.reduce((m, n) => {
    const ra = (n.originExposure?.exposureRank ?? 3) * 10 + (n.originExposure?.persistenceRank ?? 2);
    const rb = (m.originExposure?.exposureRank ?? 3) * 10 + (m.originExposure?.persistenceRank ?? 2);
    return ra < rb ? n : m;
  });
  const strictest = norms.reduce((m, n) => (rRank(n.restriction) > rRank(m.restriction) ? n : m));
  const sens = norms.reduce((m, n) => ((n.sensitivity ?? -1) > (m.sensitivity ?? -1) ? n : m));
  const relaxKs = norms.map((n) => n.relaxK).filter((x) => x != null);
  return {
    unassessed: norms.some((n) => n.unassessed),
    version: Math.max(...norms.map((n) => n.version ?? 0)),
    originExposure: { ...narrowest.originExposure },
    settingRuleRef: narrowest.settingRuleRef ?? null, settingRuleVersion: narrowest.settingRuleVersion ?? null,
    restriction: strictest.restriction,
    allow: norms.reduce((acc, n) => mergeLists(acc, n.allow, 'intersect'), null),
    deny: norms.reduce((acc, n) => mergeLists(acc, n.deny, 'union'), null),
    restrictionQuote: strictest.restrictionQuote ?? norms.find((n) => n.restrictionQuote)?.restrictionQuote ?? null,
    restrictedBy: strictest.restrictedBy ?? null,
    attribute: sens.attribute ?? norms.find((n) => n.attribute)?.attribute ?? null,
    sensitivity: sens.sensitivity ?? null,
    involvesOthers: norms.some((n) => n.involvesOthers),
    identityLink: norms.some((n) => n.identityLink),
    derivation: norms.some((n) => n.derivation === 'inference') ? 'inference' : norms.find((n) => n.derivation)?.derivation ?? null,
    relaxK: relaxKs.length ? Math.min(...relaxKs) : null,
    summary: norms.find((n) => n.summary)?.summary ?? null,
  };
}

/** 一个场合当前生效的规矩（active、没被取代的版本链）。 */
export function effectiveRules(core, settingKey, memo, asOf) {
  if (!settingKey) return { version: 0, restriction: 'none', allow: null, deny: null, rules: [] };
  // asOf：这条记忆是什么时候知道的。来源撤下的规矩（withdrawn_at）只管撤下之前就知道的内容；不给时间 = 眼下（撤下的不算）
  const t = Number.isFinite(asOf) ? asOf : null;
  const k = `rules:${settingKey}:${t ?? 'now'}`;
  if (memo?.has(k)) return memo.get(k);
  const rows = core.store.all(`SELECT version, rule_json, author_entity_id, authority, source FROM setting_rules
                               WHERE setting_key = ? AND status = 'active' AND superseded_at IS NULL
                                 AND (withdrawn_at IS NULL OR (? IS NOT NULL AND withdrawn_at > ?)) ORDER BY version`, settingKey, t, t);
  let restriction = 'none';
  let allow = null;
  let deny = null;
  const rules = [];
  for (const r of rows) {
    const rule = parseJson(r.rule_json, {});
    const rr = RESTRICTIONS.includes(rule.restriction) ? rule.restriction : 'none';
    restriction = stricterRestriction(restriction, rr);
    allow = mergeLists(allow, idList(rule.scope?.allow), 'intersect');
    deny = mergeLists(deny, idList(rule.scope?.deny), 'union');
    rules.push({ version: r.version, text: String(rule.text ?? ''), restriction: rr, author: r.author_entity_id ?? null, authority: r.authority, source: r.source });
  }
  const out = { version: rows.length ? rows[rows.length - 1].version : 0, restriction, allow, deny, rules };
  memo?.set(k, out);
  return out;
}

/** 规范本身（不含场合规矩的合并）。 */
export function baseNorm(core, m, memo) {
  const k = `bnorm:${m.kind}:${m.id}`;
  if (memo?.has(k)) return memo.get(k);
  const f = memoryFacts(core, m, memo);
  const row = normRow(core, m);
  let n;
  switch (m.kind) {
    case 'percept': {
      if (row && f.normState === 'assessed') n = rowToNorm(row);
      else {
        // 还没提炼：unassessed；有过收紧（撤回、污点）的，一并取最严
        n = combineStrictest([unassessedNorm(core, f, memo), row ? rowToNorm(row) : null]);
        n.unassessed = true;
      }
      break;
    }
    case 'window': {
      // 窗口不写行：取窗口内感知规范里最严的（有任何 unassessed 就是 unassessed，D10）
      const members = f.perceptIds.map((id) => baseNorm(core, { kind: 'percept', id }, memo));
      n = combineStrictest([...members, row ? rowToNorm(row) : null]) ?? unassessedNorm(core, f, memo);
      if (!members.length) n.unassessed = true;
      break;
    }
    case 'entity': {
      // 实体不写行：按名字证据和关系描述的来源推出（在哪些场合、当着谁被提到过）
      const c = circleOf(core, m, memo);
      let exposure = -1;
      let persistence = -1;
      let originKey = null;
      for (const [key] of c.settings) {
        const s = settingInfo(core, key, memo)?.snapshot;
        if (s && s.exposureRank > exposure) { exposure = s.exposureRank; persistence = s.persistenceRank; originKey = key; }
      }
      if (c.publicAvailable) { exposure = 3; persistence = 2; }
      const derived = {
        unassessed: false, version: row?.version ?? 0,
        originExposure: exposure >= 0 ? { exposureRank: exposure, persistenceRank: persistence, settingKey: originKey } : { exposureRank: 0, persistenceRank: 0 },
        settingRuleRef: null, settingRuleVersion: null, restriction: 'none', allow: null, deny: null, restrictionQuote: null, restrictedBy: null,
        // 涉及别人：档案卡本身是个人，或者卡上有她以外的具体的人（关系描述的锚点、一对一场合的对方，§5.6 involves_others 由代码算）
        // 场合的名字是平台上的（群里的人起的、没人过目，D111 评审）：它是那里的人的东西，按涉及别人算——A2 不放行，只有已知圈覆盖（A1）
        // 或第二段判过才说得出来；别处的来源说法写成「在另一个群里」
        attribute: null, sensitivity: null,
        involvesOthers: [...f.involved].some((e) => e !== selfId(core, memo) && isIndividual(core, e, memo)) || platformNamed(core, f.settingKey, memo),
        identityLink: false, derivation: null, relaxK: null, summary: null,
      };
      n = row ? combineStrictest([derived, rowToNorm(row)]) : derived;
      n.unassessed = false;
      break;
    }
    default:
      n = row ? rowToNorm(row) : unassessedNorm(core, f, memo);
      // 派生内容的证据还没提炼（例如空闲 10 分钟就写的小结）：和证据一样按 unassessed（§5.6 派生内容继承证据里最严的）。
      // 存下来的行只是当时的继承结果，不能让它看着像评估过；证据评估完、重新继承后自然恢复
      if (row && !n.unassessed && hasUnassessedSource(core, f)) {
        n = combineStrictest([unassessedNorm(core, f, memo), n]);
        n.unassessed = true;
      }
  }
  memo?.set(k, n);
  return n;
}

/** 来源感知里有没有还没提炼过的（norm_state = 'unassessed'；已经删掉的感知不算）。 */
function hasUnassessedSource(core, f) {
  const ids = (f.perceptIds ?? []).slice(0, 500);
  if (!ids.length) return false;
  return !!core.store.get(`SELECT 1 AS x FROM percepts WHERE norm_state = 'unassessed' AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, ...ids);
}

/**
 * 读规范：规范本身 + 它引用的场合规矩（最新 active 链；规矩更严时按更严的算，§5.6、评审:UV-09）。
 * 返回的 ruleVersion 是引用的规矩现在的版本（第二段缓存键用）。
 */
export function normOf(core, m, memo) {
  const k = `norm:${m.kind}:${m.id}`;
  if (memo?.has(k)) return memo.get(k);
  const base = baseNorm(core, m, memo);
  const n = { ...base, allow: base.allow ? [...base.allow] : null, deny: base.deny ? [...base.deny] : null, originExposure: { ...base.originExposure } };
  const ruleKey = n.settingRuleRef ?? n.originExposure?.settingKey ?? null;
  // 这条记忆最早是什么时候知道的（来源里最早的那一刻）：那时还在的规矩照样管它，哪怕来源后来撤下了；不知道时间就都算（fail closed）
  const f = memoryFacts(core, m, memo);
  const times = [f.at, ...(f.sources ?? []).map((s) => s.at)].filter(Number.isFinite);
  const eff = effectiveRules(core, ruleKey, memo, times.length ? Math.min(...times) : Number.MIN_SAFE_INTEGER);
  n.ruleVersion = eff.version;
  n.settingRules = eff.rules;
  if (rRank(eff.restriction) > rRank(n.restriction)) { n.restriction = eff.restriction; n.ruleRaised = true; }
  if (eff.allow) n.allow = mergeLists(n.allow, eff.allow, 'intersect');
  if (eff.deny) n.deny = mergeLists(n.deny, eff.deny, 'union');
  memo?.set(k, n);
  return n;
}

// ── 写 ───────────────────────────────────────────────────────────────────

/** 规范的历史里「收紧过的」底线：之后整体重写也不会被冲掉（单调；只有有权限的放宽能清掉）。 */
function stickyFloor(history) {
  let restriction = 'none';
  let deny = null;
  let sensitivity = null;
  for (const h of history) {
    if (h.kind === 'relax') { restriction = 'none'; deny = null; sensitivity = null; continue; }
    if (h.kind !== 'tighten') continue;
    restriction = stricterRestriction(restriction, h.restriction ?? 'none');
    deny = mergeLists(deny, idList(h.deny), 'union');
    if (h.sensitivity != null) sensitivity = Math.max(sensitivity ?? 0, h.sensitivity);
  }
  return { restriction, deny, sensitivity };
}

/** 让和这条记忆有关的第二段缓存失效（规范变了，§9.3.3）。 */
export function expireMemoryCache(core, m) {
  const now = core.now();
  core.store.run('UPDATE appraisals SET expires_at = ? WHERE memory_kind = ? AND memory_id = ? AND cache_key IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)',
    now, m.kind, m.id, now);
}

function computeInvolves(core, m, memo) {
  const f = memoryFacts(core, m, memo);
  if (!f.exists) return true;
  const me = selfId(core, memo);
  for (const e of f.involved) if (e !== me && isIndividual(core, e, memo)) return true;
  return false;
}

/** 新出现在 deny 里的管理者：「别告诉主人」这类请求本身报 T1（§9.3.7）。 */
function reportSecrecy(core, m, newDeny, oldDeny, by, perceptId) {
  if (!newDeny?.length) return;
  const mgr = managerIds(core, null);
  const added = newDeny.filter((x) => mgr.has(x) && !(oldDeny ?? []).includes(x));
  if (!added.length) return;
  soft(core, 'admin.notifyNeedToKnow', () => core.mods.admin.notifyNeedToKnow(core, {
    kind: 'T1', ref: m ? refOf(m.kind, m.id) : null, perceptId: perceptId ?? null, sourceEntityId: by ?? null,
    reason: SECRECY_REQUEST_REASON, severity: 1, at: core.now(),
  }), null);
}

/**
 * 写（整体替换）一条规范。没给的字段按「来源场合 + 无限制」补；涉及别人没给时由代码从实体算（读不到按「是」）。
 * 历史里收紧过的底线保留（单调），除非 input.authorizedRelax。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} m
 * @param {import('../core-types.js').NormInput & {restrictedBy?: number|null, derivation?: 'quote'|'inference'|null, relaxK?: number|null,
 *         authorizedRelax?: boolean, historyKind?: string, by?: number|null}} input
 * @returns {number}
 */
export function writeNorm(core, m, input = {}) {
  assertRef(m);
  const memo = new Map();
  return core.store.tx((db) => {
    const now = core.now();
    const old = normRow(core, m);
    const history = old ? parseJson(old.history_json, []) : [];
    const f = memoryFacts(core, m, memo);
    const origin = isPlain(input.originExposure) && Object.keys(input.originExposure).length ? { ...input.originExposure } : originFromFacts(core, f, memo);
    let restriction = input.restriction == null ? 'none' : RESTRICTIONS.includes(input.restriction) ? input.restriction : 'strict';
    if (input.restriction != null && !RESTRICTIONS.includes(input.restriction)) warn(core, 'norm.badRestriction', { kind: m.kind });
    let deny = idList(input.deny);
    const allow = idList(input.allow);
    let sensitivity = input.sensitivity == null ? null : clamp01(input.sensitivity);
    if (!input.authorizedRelax) {
      const floor = stickyFloor(history);
      restriction = stricterRestriction(restriction, floor.restriction);
      deny = mergeLists(deny, floor.deny, 'union');
      if (floor.sensitivity != null) sensitivity = Math.max(sensitivity ?? 0, floor.sensitivity);
    }
    // 涉及别人由代码从实体算（评审:PS-19）：调用方给的值只能把它变成「是」，不能把代码算出的「是」改成「否」
    const computed = computeInvolves(core, m, memo);
    const involvesOthers = input.involvesOthers === true || computed;
    if (input.involvesOthers === false && computed) metric(core, 'norm.involvesOverridden');
    const ruleRef = input.settingRuleRef ?? origin.settingKey ?? null;
    const ruleVer = input.settingRuleVersion ?? (ruleRef ? effectiveRules(core, ruleRef, null).version : null);
    const restricted = rRank(restriction) > 0 || !!allow || !!deny?.length;
    const restrictedBy = input.restrictedBy ?? (restricted ? (old?.restricted_by ?? firstSpeaker(f)) : null);
    const derivation = input.derivation === 'quote' || input.derivation === 'inference' ? input.derivation : (f.derivedSelf ? 'inference' : null);
    const relaxK = Number.isSafeInteger(input.relaxK) && input.relaxK > 0 ? input.relaxK : null;
    const version = (old?.version ?? 0) + 1;
    if (old) {
      history.push({ kind: input.historyKind ?? 'write', v: old.version, at: now, reason: clip(input.reason ?? '', 80) || undefined, by: input.by ?? undefined,
        restriction, deny: deny ?? undefined, sensitivity: sensitivity ?? undefined, prev: { restriction: old.restriction, sensitivity: old.sensitivity } });
    } else if (input.historyKind && input.historyKind !== 'write') {
      history.push({ kind: input.historyKind, v: 0, at: now, reason: clip(input.reason ?? '', 80) || undefined, by: input.by ?? undefined, restriction, deny: deny ?? undefined, sensitivity: sensitivity ?? undefined });
    }
    db.run(`INSERT INTO flow_norms(owner_kind, owner_id, version, origin_exposure_json, setting_rule_ref, setting_rule_version, restriction,
              allow_json, deny_json, restriction_quote, restricted_by, attribute, sensitivity, involves_others, identity_link, derivation, relax_k,
              summary, history_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(owner_kind, owner_id) DO UPDATE SET version = excluded.version, origin_exposure_json = excluded.origin_exposure_json,
              setting_rule_ref = excluded.setting_rule_ref, setting_rule_version = excluded.setting_rule_version, restriction = excluded.restriction,
              allow_json = excluded.allow_json, deny_json = excluded.deny_json, restriction_quote = excluded.restriction_quote,
              restricted_by = excluded.restricted_by, attribute = excluded.attribute, sensitivity = excluded.sensitivity,
              involves_others = excluded.involves_others, identity_link = excluded.identity_link, derivation = excluded.derivation,
              relax_k = excluded.relax_k, summary = excluded.summary, history_json = excluded.history_json, updated_at = excluded.updated_at`,
    m.kind, m.id, version, JSON.stringify(origin), ruleRef, ruleVer, restriction,
    allow ? JSON.stringify(allow) : null, deny?.length ? JSON.stringify(deny) : null,
    input.restrictionQuote == null ? null : clip(input.restrictionQuote, 120), restrictedBy,
    input.attribute == null ? null : clip(input.attribute, 64), sensitivity,
    involvesOthers, !!input.identityLink, derivation, relaxK,
    input.summary == null ? null : clip(input.summary, 200), JSON.stringify(history.slice(-HISTORY_MAX)), now);
    expireMemoryCache(core, m);
    reportSecrecy(core, m, deny, idList(parseJson(old?.deny_json, null)), restrictedBy, f.perceptIds?.[0]);
    return version;
  });
}

function firstSpeaker(f) {
  for (const s of f.sources ?? []) { if (s.asserter != null) return s.asserter; if (s.speaker != null) return s.speaker; }
  for (const s of f.speakers ?? []) return s;
  return null;
}

/** 规范对象 → writeNorm 的输入（保留全部字段）。 */
function toInput(n) {
  const { unassessed, version, ruleVersion, settingRules, ruleRaised, ...rest } = n;
  return rest;
}

/**
 * 收紧（撤回 → 至少 soft；被标了污点；主人的纠正）。不需要权限。收紧记进历史，之后整体重写也冲不掉。
 */
export function tightenNorm(core, m, t = {}) {
  assertRef(m);
  core.store.tx(() => {
    const memo = new Map();
    const base = baseNorm(core, m, memo);
    const r = t.restriction && RESTRICTIONS.includes(t.restriction) ? stricterRestriction(base.restriction, t.restriction) : base.restriction;
    const sIn = t.sensitivity == null ? null : clamp01(t.sensitivity);
    const s = sIn == null ? base.sensitivity : Math.max(base.sensitivity ?? 0, sIn);
    const row = normRow(core, m);
    if (row && r === base.restriction && s === base.sensitivity) return;
    // 第一眼（D106）收紧时带上叮嘱的原话和说那句话的人（只在这次真的从「没有限制」收紧时记，不改别人早先记下的）
    const fresh = rRank(r) > rRank(base.restriction) && rRank(base.restriction) === 0;
    const extra = fresh ? {
      ...(typeof t.restrictionQuote === 'string' && t.restrictionQuote ? { restrictionQuote: clip(t.restrictionQuote, 80) } : {}),
      ...(Number.isSafeInteger(t.restrictedBy) ? { restrictedBy: t.restrictedBy } : {}),
    } : {};
    writeNorm(core, m, { ...toInput(base), involvesOthers: base.involvesOthers, restriction: r, sensitivity: s, ...extra, reason: t.reason ?? 'tighten', historyKind: 'tighten' });
  });
}

/**
 * 派生内容的规范（§5.6）：继承证据里最严的；复述原话的「谁知道」取交集，推断类固定只有她自己。
 * 「放宽一级」不在这里做：记下证据来自几个不同的主体（relax_k），由第一段在目标受众够大、没有具体个人时执行（不能用于公开场合）。
 */
export function inheritNorm(core, m, evidence, ctx = {}) {
  assertRef(m);
  const memo = new Map();
  core.store.tx((db) => {
    const ev = (evidence ?? []).filter((e) => e && OWNER_KINDS[e.kind] && Number.isSafeInteger(e.id));
    const norms = ev.map((e) => normOf(core, e, memo));
    const merged = combineStrictest(norms) ?? {
      originExposure: {}, restriction: 'soft', allow: null, deny: null, sensitivity: null, involvesOthers: true, identityLink: false,
    };
    const input = toInput(merged);
    if (merged.unassessed || !norms.length) {
      input.restriction = stricterRestriction(input.restriction, 'soft');
      input.involvesOthers = true;
    }
    const me = selfId(core, memo);
    const subjects = new Set();
    for (const e of ev) {
      const f = memoryFacts(core, e, memo);
      for (const s of [...f.subjects, ...f.speakers]) if (s !== me) subjects.add(s);
    }
    const derivation = ctx.derivation === 'inference' ? 'inference' : 'quote';
    writeNorm(core, m, { ...input, derivation, relaxK: subjects.size || null, reason: 'inherit', historyKind: 'inherit' });
    // 谁知道：替换以前推出来的（她说出去的、听说的留着）
    db.run("DELETE FROM known_by WHERE owner_kind = ? AND owner_id = ? AND basis IN ('presence','setting','subject','public')", m.kind, m.id);
    if (derivation === 'inference' || !ev.length) return;   // 推断类：只有她自己
    const inter = intersectCircles(ev.map((e) => circleOf(core, e, memo)));
    const at = ctx.at ?? core.now();
    const rows = [];
    for (const e of inter.entities) if (e !== me) rows.push({ whoKind: 'entity', whoRef: String(e), since: at, basis: 'presence' });
    for (const [key, since] of inter.settings) rows.push({ whoKind: 'setting', whoRef: key, since, basis: 'setting' });
    if (inter.publicAvailable) rows.push({ whoKind: 'setting', whoRef: 'public', since: at, basis: 'public' });
    for (const r of rows) {
      db.run('INSERT INTO known_by(owner_kind, owner_id, who_kind, who_ref, since, basis, at) VALUES (?, ?, ?, ?, ?, ?, ?)', m.kind, m.id, r.whoKind, r.whoRef, r.since, r.basis, core.now());
    }
  });
}

// ── 规范的变化请求 ───────────────────────────────────────────────────────

function speakerAuthority(core, speaker, ctx) {
  if (ctx?.authority === 'principal' || ctx?.authority === 'config') return ctx.authority;
  if (speaker != null && managerIds(core, null).has(speaker)) return 'principal';
  if (ctx?.authority === 'moderator') return 'moderator';
  return 'none';
}

/** 放宽的权限（§7.4 第 9 条）：管理者、经权利层确认的主体本人（每个具体的主体）、当初提出限制的人。 */
function mayRelax(core, m, speaker, base, authority, memo) {
  if (authority === 'principal' || authority === 'config') return 'manager';
  if (speaker == null) return null;
  // 当初提出限制的人：写入时的 restricted_by，加上之后每次收紧的提出者（历史里记着 by）
  const restrictors = new Set(base.restrictedBy != null ? [base.restrictedBy] : []);
  for (const h of parseJson(normRow(core, m)?.history_json, [])) if (h?.kind === 'tighten' && Number.isSafeInteger(h.by)) restrictors.add(h.by);
  if ([...restrictors].some((r) => rightsHolder(core, speaker, r, memo))) return 'restrictor';
  const f = memoryFacts(core, m, memo);
  const me = selfId(core, memo);
  const subjects = [...f.subjects].filter((s) => s !== me && isIndividual(core, s, memo));
  if (subjects.length && subjects.every((s) => rightsHolder(core, speaker, s, memo))) return 'subject';
  return null;
}

function pendingReviewExists(core, kind, field, value) {
  try {
    return !!core.store.get(`SELECT id FROM review_queue WHERE status = 'pending' AND kind = ? AND json_extract(payload_json, '$.${field}') = ?`, kind, value);
  } catch { return false; }
}

/**
 * 规范或场合规矩的变化请求。收紧直接生效；放宽只认有权限的人，否则只记成听来的「有人说可以说了」，并进审核队列（同一目标只排一条）。
 * ctx.authority（可选）：admin 审核通过时传 'principal'。
 */
export function applyNormUpdate(core, update, ctx = {}) {
  const dir = update?.direction;
  if (dir !== 'relax' && dir !== 'tighten') return { applied: false, queued: false, reason: 'bad-direction' };
  const change = isPlain(update.change) ? update.change : {};
  const speaker = Number.isSafeInteger(ctx.speakerEntityId) ? ctx.speakerEntityId : null;
  const at = Number.isFinite(ctx.at) ? ctx.at : core.now();
  const authority = speakerAuthority(core, speaker, ctx);
  const target = update.target;
  if (target?.kind === 'setting') {
    if (!isOpaqueId(target.settingKey)) return { applied: false, queued: false, reason: 'bad-target' };
    const restriction = RESTRICTIONS.includes(change.restriction) ? change.restriction : (dir === 'tighten' ? 'soft' : 'none');
    const r = writeSettingRule(core, target.settingKey, {
      text: update.quote ?? change.summary ?? '', restriction, scope: { allow: change.allow, deny: change.deny },
    }, { source: ctx.source ?? 'learned', authorEntityId: speaker, authority, at, relax: dir === 'relax', perceptId: ctx.perceptId ?? null });
    return r.status === 'active' ? { applied: true, queued: false } : { applied: false, queued: r.status === 'pending', reason: r.status === 'rejected' ? 'unauthorized' : 'pending' };
  }
  const m = target?.kind === 'memory' ? parseRef(target.ref) : null;
  if (!m) return { applied: false, queued: false, reason: 'bad-target' };
  return core.store.tx((db) => {
    const memo = new Map();
    const base = baseNorm(core, m, memo);
    if (dir === 'tighten') {
      const deny = mergeLists(base.deny, idList(change.deny), 'union');
      const allow = change.allow ? mergeLists(base.allow, idList(change.allow), 'intersect') : base.allow;
      const restriction = RESTRICTIONS.includes(change.restriction) ? stricterRestriction(base.restriction, change.restriction) : base.restriction;
      const sens = change.sensitivity == null ? base.sensitivity : Math.max(base.sensitivity ?? 0, clamp01(change.sensitivity) ?? 0);
      writeNorm(core, m, {
        ...toInput(base), restriction, deny, allow, sensitivity: sens,
        restrictionQuote: update.quote ?? base.restrictionQuote, restrictedBy: base.restrictedBy ?? speaker,
        attribute: change.attribute ?? base.attribute, reason: 'norm_update', historyKind: 'tighten', by: speaker,
      });
      return { applied: true, queued: false };
    }
    const who = mayRelax(core, m, speaker, base, authority, memo);
    if (who) {
      const restriction = RESTRICTIONS.includes(change.restriction) && rRank(change.restriction) < rRank(base.restriction) ? change.restriction : base.restriction;
      const allow = 'allow' in change ? idList(change.allow) : base.allow;
      const deny = 'deny' in change ? idList(change.deny) : base.deny;
      writeNorm(core, m, {
        ...toInput(base), restriction, allow, deny, reason: `relax:${who}`, historyKind: 'relax', authorizedRelax: true, by: speaker,
        restrictionQuote: rRank(restriction) === 0 && !allow && !deny?.length ? null : base.restrictionQuote,
      });
      return { applied: true, queued: false };
    }
    // 没有权限：只记成听来的「有人说可以说了」，不生效（§9.6）
    const row = normRow(core, m);
    if (row) {
      const h = parseJson(row.history_json, []);
      h.push({ kind: 'relax-claim', at, by: speaker ?? undefined, applied: false, perceptId: ctx.perceptId ?? undefined });
      db.run('UPDATE flow_norms SET history_json = ? WHERE owner_kind = ? AND owner_id = ?', JSON.stringify(h.slice(-HISTORY_MAX)), m.kind, m.id);
    }
    metric(core, 'norm.relaxDenied');
    const ref = refOf(m.kind, m.id);
    let queued = false;
    if (!pendingReviewExists(core, 'norm_change', 'ref', ref)) {
      queued = soft(core, 'admin.enqueueReview', () => {
        core.mods.admin.enqueueReview(core, {
          kind: 'norm_change',
          payload: { ref, direction: 'relax', change: { restriction: change.restriction ?? null, allow: idList(change.allow), deny: idList(change.deny) },
            speakerEntityId: speaker, perceptId: ctx.perceptId ?? null },
          reason: 'unauthorized-relax',
        });
        return true;
      }, false);
    }
    return { applied: false, queued, reason: 'unauthorized' };
  });
}

// ── 场合规矩 ─────────────────────────────────────────────────────────────

/**
 * 写场合规矩的新版本。规矩是「带来源的事实」：没给 restriction 的只是说明（给第二段的卡片看，不改变结论）；
 * 比现在生效的更松的部分只认管理者（moderator 进审核队列，其他人丢弃，§5.6 单调性）。当场生效，相关缓存失效。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{text: string, restriction?: 'none'|'soft'|'strict', scope?: {allow?: number[], deny?: number[]}}} rule
 * @param {{source: 'adapter-notes'|'learned'|'owner', authorEntityId: number|null, authority: 'none'|'moderator'|'principal'|'config', at: number,
 *          relax?: boolean, perceptId?: number|null}} ctx
 * @returns {{version: number, status: 'active'|'pending'|'rejected'}}
 */
export function writeSettingRule(core, settingKey, rule, ctx) {
  if (!isOpaqueId(settingKey)) throw new TypeError('writeSettingRule：场合键不对');
  const source = ['adapter-notes', 'learned', 'owner'].includes(ctx?.source) ? ctx.source : 'learned';
  let authority = ['none', 'moderator', 'principal', 'config'].includes(ctx?.authority) ? ctx.authority : 'none';
  if (source === 'owner' && authority === 'none') authority = 'principal';
  const author = Number.isSafeInteger(ctx?.authorEntityId) ? ctx.authorEntityId : null;
  const at = Number.isFinite(ctx?.at) ? Math.trunc(ctx.at) : core.now();
  const text = clip(String(rule?.text ?? ''), 500);
  const given = RESTRICTIONS.includes(rule?.restriction);
  const restriction = given ? rule.restriction : 'none';
  const scope = { allow: idList(rule?.scope?.allow), deny: idList(rule?.scope?.deny) };
  if (!scope.deny?.length) scope.deny = null;
  const info = !given && !scope.allow && !scope.deny;
  const hash = sha16(JSON.stringify([text, restriction, scope, source, author, info]));
  const content = ruleContent({ text, restriction, scope, info });
  return core.store.tx((db) => {
    // 撤下过的那一版不算「已经有了」：同一条公告又贴回来，就是新的一版
    const same = db.get(`SELECT version, status, authority FROM setting_rules WHERE setting_key = ? AND rule_hash = ? AND superseded_at IS NULL AND withdrawn_at IS NULL
                         ORDER BY version DESC LIMIT 1`, settingKey, hash);
    if (same?.status === 'active') return { version: same.version, status: 'active' };
    const eff = effectiveRules(core, settingKey, null);
    const allowLooser = !!scope.allow && (!!eff.allow ? scope.allow.some((x) => !eff.allow.includes(x)) : false);
    const looser = (given && rRank(restriction) < rRank(eff.restriction)) || allowLooser;
    const managerOk = authority === 'principal' || authority === 'config';
    const status = !looser || managerOk ? 'active' : authority === 'moderator' ? 'pending' : 'rejected';
    // 同一个人以同样的权限再提一遍同一条：还在等审核的不重复排队；已经被驳回（主人驳回，或没有权限被代码拒绝）的不再新建、不再报一次
    if (same && status !== 'active' && same.authority === authority && (same.status === 'pending' || same.status === 'rejected')) {
      return { version: same.version, status: same.status };
    }
    const version = (db.get('SELECT MAX(version) AS v FROM setting_rules WHERE setting_key = ?', settingKey)?.v ?? 0) + 1;
    db.run(`INSERT INTO setting_rules(setting_key, version, rule_json, rule_hash, source, author_entity_id, authority, stricter, status, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    settingKey, version, JSON.stringify({ text, restriction, scope, info }), hash, source, author, authority, looser ? 0 : 1, status, at);
    if (status === 'active') {
      for (const r of db.all("SELECT version, rule_json, status FROM setting_rules WHERE setting_key = ? AND version < ? AND superseded_at IS NULL AND status IN ('active','pending')", settingKey, version)) {
        const old = parseJson(r.rule_json, {});
        const sameContent = ruleContent(old) === content;
        // 还在等审核的那一版：内容一样的规矩生效了（主人批准了它，或者有权限的人自己写了同一条），这一版就结了；
        // 内容不一样的照旧等主人决定
        // 有权限的放宽：取代比它严的旧规矩
        const supersede = r.status === 'pending' ? sameContent && managerOk
          : looser && (rRank(old.restriction ?? 'none') > rRank(restriction) || !!(scope.allow && old.scope?.allow) || sameContent);
        if (supersede) db.run('UPDATE setting_rules SET superseded_at = ? WHERE setting_key = ? AND version = ?', at, settingKey, r.version);
      }
    }
    if (status === 'pending') {
      soft(core, 'admin.enqueueReview', () => core.mods.admin.enqueueReview(core, {
        kind: 'setting_rule_relax', payload: { settingKey, version, authorEntityId: author }, reason: 'moderator-relax',
      }), null);
    }
    if (status === 'rejected') metric(core, 'settingRule.relaxRejected');
    // 准备写进她的规矩、来源不是管理者的：让主人知道（§9.3.7 第 3 条）。只是说明的不报
    if (!managerOk && !info) {
      soft(core, 'admin.notifyNeedToKnow', () => core.mods.admin.notifyNeedToKnow(core, {
        kind: 'foreign_write', ref: null, perceptId: ctx?.perceptId ?? null, sourceEntityId: author,
        reason: `setting-rule:${status}`, severity: looser ? 2 : 1, at,
      }), null);
    }
    if (scope.deny) reportSecrecy(core, null, scope.deny, null, author, ctx?.perceptId ?? null);
    // 规矩变了：引用它的记忆和这个场合的原文，评估缓存失效（缓存键里也带规矩版本）
    const now = core.now();
    db.run(`UPDATE appraisals SET expires_at = ? WHERE cache_key IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) AND (
              (memory_kind, memory_id) IN (SELECT owner_kind, owner_id FROM flow_norms WHERE setting_rule_ref = ?)
              OR (memory_kind = 'percept' AND memory_id IN (SELECT id FROM percepts WHERE setting_key = ?)))`, now, now, settingKey, settingKey);
    return { version, status };
  });
}

/** 一条规矩的内容（不含来源和作者）：用来认出「主人批准的就是还在等审核的那一版」。 */
function ruleContent(r) {
  const scope = { allow: idList(r?.scope?.allow), deny: idList(r?.scope?.deny) };
  if (!scope.deny?.length) scope.deny = null;
  return sha16(JSON.stringify([String(r?.text ?? ''), RESTRICTIONS.includes(r?.restriction) ? r.restriction : 'none', scope, !!r?.info]));
}

/**
 * 主人对一条还在等审核的场合规矩（setting_rule_relax 审核项指向的那一版）的决定（admin.decideReview 调用）。
 *   - 批准：按那一版的内容和原作者写一版主人认可的（authority='principal'，当场生效、缓存失效），那一版标成被取代；
 *   - 驳回：那一版标 rejected，不生效；同一个人以同样的权限再提同一条不再排队（writeSettingRule 认得出）。
 * 那一版已经不在等审核（批准过、驳回过、被同样内容的规矩取代了）时什么都不做，返回 'not-pending'。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {number} version
 * @param {boolean} approve
 * @param {{at?: number}} [ctx]
 * @returns {{version: number|null, status: 'active'|'rejected'|'not-pending'}}
 */
export function decideSettingRule(core, settingKey, version, approve, ctx = {}) {
  if (!isOpaqueId(settingKey) || !Number.isSafeInteger(version)) throw new TypeError('decideSettingRule：场合键或版本不对');
  const at = Number.isFinite(ctx.at) ? Math.trunc(ctx.at) : core.now();
  return core.store.tx((db) => {
    const row = db.get('SELECT version, rule_json, source, author_entity_id, status, superseded_at FROM setting_rules WHERE setting_key = ? AND version = ?', settingKey, version);
    if (!row || row.status !== 'pending' || row.superseded_at != null) {
      metric(core, 'settingRule.decideNotPending');
      return { version: row ? row.version : null, status: 'not-pending' };
    }
    if (!approve) {
      db.run("UPDATE setting_rules SET status = 'rejected' WHERE setting_key = ? AND version = ?", settingKey, version);
      metric(core, 'settingRule.ownerRejected');
      return { version, status: 'rejected' };
    }
    const rule = parseJson(row.rule_json, {});
    const res = writeSettingRule(core, settingKey, {
      text: String(rule.text ?? ''), ...(rule.info ? {} : { restriction: RESTRICTIONS.includes(rule.restriction) ? rule.restriction : 'none' }),
      scope: { allow: rule.scope?.allow ?? undefined, deny: rule.scope?.deny ?? undefined },
    }, { source: row.source, authorEntityId: row.author_entity_id ?? null, authority: 'principal', at });
    db.run('UPDATE setting_rules SET superseded_at = ? WHERE setting_key = ? AND version = ? AND superseded_at IS NULL', at, settingKey, version);
    metric(core, 'settingRule.ownerApproved');
    return { version: res.version, status: res.status === 'active' ? 'active' : 'not-pending' };
  });
}

/**
 * 来源撤下了的场合规矩（群公告里那条没了，§5.6「规矩是带来源的事实」）：
 *   - 只撤从这个来源来的（source = adapter-notes，按公告的文字认）；她自己学到的、主人在管理页写的不动；
 *     作者是主人或配置（authority principal / config）的公告也不动——主人写的规矩只由主人在管理页撤；
 *   - 生效中的：记下撤下的时间（withdrawn_at）。之后才知道的内容不再受它约束；撤下之前就知道的照旧
 *     （当时是在这条规矩下听到的，effectiveRules 的 asOf），所以撤下永远不会让她已经知道的事变松；
 *   - 还在等审核的：那一版作废（superseded_at），审核项随之不再算数。
 * 两种问法：q.texts = 撤下这几条；q.keep = 来源现在的完整清单（适配器这次给的全部 notes），清单里没有的都撤下。
 * 适配器给 notes 时给的就是完整清单，按 keep 问不依赖「上一次描述里有什么」（中间有一次描述没带 notes 也不会漏撤）。
 * 同步，在调用方的事务里调用也行。返回撤下了几条。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{source: 'adapter-notes', texts?: string[], keep?: string[]}} q
 * @param {{at?: number}} [ctx]
 * @returns {number}
 */
export function withdrawSettingRules(core, settingKey, q, ctx = {}) {
  if (!isOpaqueId(settingKey)) throw new TypeError('withdrawSettingRules：场合键不对');
  if (q?.source !== 'adapter-notes') return 0;
  // 和 writeSettingRule 存的文字同一个口径（截到 500 字）
  const textSet = (list) => new Set((Array.isArray(list) ? list : []).filter((t) => typeof t === 'string').map((t) => clip(t, 500)));
  const keep = Array.isArray(q.keep) ? textSet(q.keep) : null;
  const texts = keep ? null : textSet(q.texts);
  if (!keep && !texts.size) return 0;
  const at = Number.isFinite(ctx.at) ? Math.trunc(ctx.at) : core.now();
  return core.store.tx((db) => {
    let n = 0;
    for (const r of db.all(`SELECT version, rule_json, authority, status FROM setting_rules WHERE setting_key = ? AND source = 'adapter-notes'
                            AND status IN ('active','pending') AND superseded_at IS NULL AND withdrawn_at IS NULL`, settingKey)) {
      if (r.authority === 'principal' || r.authority === 'config') continue;
      const text = String(parseJson(r.rule_json, {}).text ?? '');
      if (keep ? keep.has(text) : !texts.has(text)) continue;
      if (r.status === 'active') db.run('UPDATE setting_rules SET withdrawn_at = ? WHERE setting_key = ? AND version = ?', at, settingKey, r.version);
      else db.run('UPDATE setting_rules SET superseded_at = ? WHERE setting_key = ? AND version = ?', at, settingKey, r.version);
      n += 1;
    }
    if (n) metric(core, 'settingRule.withdrawn');
    return n;
  });
}

/** 场合当前生效的规矩。 */
export function settingRules(core, settingKey) {
  const eff = effectiveRules(core, settingKey, null);
  return { version: eff.version, rules: eff.rules.map((r) => ({ text: r.text, restriction: r.restriction, author: r.author, authority: r.authority })) };
}

// ── 核对过原话的叮嘱（D113）────────────────────────────────────────────────

/** 比对叮嘱原话用的规范化：NFKC、小写、去掉空白和标点（「别外传哈！」和「别外传哈」算同一句）。 */
function plainQuote(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 「他叮嘱过别外传」——只认核对过原话、或者主人定过的（D113）。返回 {kind: 'soft'|'strict', quote, by, deny[]}，不是叮嘱的返回 null。
 * 认的只有这几种（全是代码看得到的事实）：
 *   (a) 第一眼 limit_kind 是 soft / strict、quote_ok（原话在他的话里），而且这一行不是她自己说的；
 *   (b) 规范的 restriction 不是 none、restriction_quote 不空，而且这句原话（规范化以后）出现在这条记忆某一条来源感知的原文里，
 *       那条感知的说话人不是她；
 *   (c) 有 deny / allow 名单，而且 restricted_by 不是她自己；
 *   (d) 规范的历史里有管理者收紧过的记录（管理页、审核通过的收紧）。
 * 没有原话的 soft（提炼、撤回、提炼失败时按 soft 记下的）不算：不出标签、外发守护也不认。她自己话里的「别外传」不算任何人的叮嘱。
 * 第一段（stage1）照旧按自己的方式读规范，不看这里。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} m
 * @param {object|null} [g]  这一行的第一眼（glancesOf 的一项；不是感知或没有就不给）
 * @param {Map} [memo]
 * @returns {{kind: 'soft'|'strict', quote: string|null, by: number|null, deny: number[], source: 'glance'|'quote'|'list'|'manager'}|null}  source：认的是 (a)–(d) 哪一种
 */
export function explicitLimit(core, m, g = null, memo = new Map()) {
  const k = `xlimit:${m?.kind}:${m?.id}:${g?.state ?? ''}`;
  if (memo?.has(k)) return memo.get(k);
  let out = null;
  try { out = readExplicitLimit(core, m, g, memo); } catch { out = null; }
  memo?.set(k, out);
  return out;
}

function readExplicitLimit(core, m, g, memo) {
  const f = memoryFacts(core, m, memo);
  if (!f?.exists) return null;
  const me = selfId(core, memo);
  const p = f.percept ?? null;
  // (a) 第一眼核对过的叮嘱，说这句话的不是她
  if (g?.state === 'done' && g.quoteOk && (g.limit === 'soft' || g.limit === 'strict') && p && !p.actor_self) {
    return { kind: g.limit, quote: g.quote ? clip(g.quote, 80) : null, by: p.actor_entity_id ?? null, deny: [], source: 'glance' };
  }
  const row = normRow(core, m);
  if (!row) return null;
  const n = rowToNorm(row);
  const deny = n.deny ?? [];
  // (b) 规范里的叮嘱原话真在来源原文里，说那句原文的不是她
  if (rRank(n.restriction) > 0 && n.restrictionQuote && plainQuote(n.restrictionQuote)) {
    const q = plainQuote(n.restrictionQuote);
    const ids = [...new Set([...(f.perceptIds ?? []), ...(p ? [p.id] : [])])].filter((x) => Number.isSafeInteger(x)).slice(0, 50);
    if (ids.length) {
      for (const r of core.store.all(`SELECT id, actor_self, actor_entity_id, text FROM percepts WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
        if (r.actor_self || r.text == null) continue;
        if (plainQuote(r.text).includes(q)) {
          return { kind: n.restriction === 'strict' ? 'strict' : 'soft', quote: clip(n.restrictionQuote, 80), by: n.restrictedBy ?? r.actor_entity_id ?? null, deny, source: 'quote' };
        }
      }
    }
  }
  // (c) 点了名不让谁知道 / 只让谁知道，而定这条限制的不是她自己
  if ((deny.length || n.allow) && n.restrictedBy != null && n.restrictedBy !== me) {
    return { kind: rRank(n.restriction) >= 2 || deny.length ? 'strict' : 'soft', quote: n.restrictionQuote ? clip(n.restrictionQuote, 80) : null, by: n.restrictedBy, deny, source: 'list' };
  }
  // (d) 管理者收紧过（管理页、审核通过的收紧：历史里 kind = 'tighten'、by 是管理者）
  const mgr = managerIds(core, memo);
  const hist = parseJson(row.history_json, []);
  const byMgr = (Array.isArray(hist) ? hist : []).filter((h) => h?.kind === 'tighten' && h.by != null && mgr.has(h.by));
  if (byMgr.length && (rRank(n.restriction) > 0 || deny.length || n.allow)) {
    return { kind: rRank(n.restriction) >= 2 || deny.length ? 'strict' : 'soft', quote: n.restrictionQuote ? clip(n.restrictionQuote, 80) : null, by: byMgr.at(-1).by, deny, source: 'manager' };
  }
  return null;
}

/**
 * 主人解除一条叮嘱（D113 管理页「她在守的叮嘱」）：规范按有权限的放宽（authorizedRelax，restriction 回到 none、清掉名单），
 * 第一眼核对过的限制也一并清掉（limit_kind = 'none'）。之后 explicitLimit 不再认它；第一段照旧按新的规范判。
 * @returns {{applied: boolean}}
 */
export function relaxLimit(core, m, ctx = {}) {
  assertRef(m);
  return core.store.tx(() => {
    const r = applyNormUpdate(core, { target: { kind: 'memory', ref: refOf(m.kind, m.id) }, direction: 'relax', change: { restriction: 'none', allow: null, deny: [] }, quote: null },
      { speakerEntityId: Number.isSafeInteger(ctx.speakerEntityId) ? ctx.speakerEntityId : null, at: Number.isFinite(ctx.at) ? ctx.at : core.now(), authority: 'principal' });
    let glance = 0;
    if (m.kind === 'percept') glance = Number(core.store.run("UPDATE glances SET limit_kind = 'none' WHERE percept_id = ? AND limit_kind IN ('soft','strict')", m.id)?.changes ?? 0);
    metric(core, 'limit.relaxed');
    return { applied: !!r?.applied || glance > 0 };
  });
}
