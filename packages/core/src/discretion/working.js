// 工作记忆的准入（§8.10、§9.2，D100 / D101 / D106 / D113）：「知道 ≠ 说」——眼前这个人跟她说的话、她回他的话，感知一落库就在她心里。
// D113「功能优先」：知道的事带着来源标签进来，说不说、说多少由她回话时看着标签自己掂量；代码只挡少数几种底线，不分说出口的档位。
// 只跑第一段（同步、零 LLM、不调第二段、不等第一眼）：
//   - 整批不进：没有触发者、目标是 publicLike（B2 的场合）、说出去就是最终的渠道（preSendGate:false）而对方不是管理者、批量提示词；
//   - 逐条不进（excluded，discretion_log 记 wm-excluded:<rule>）：第一段 block（隐藏 / 忘掉 / 撤回 / missing / error、B1 strict 和叮嘱里
//     被点名的人在场、B3、B4 block、B5），叮嘱里被点名的人的关系人确实在这里（named-deny；「可能在」不算，定叮嘱的人自己在问的不算），
//     以及给第三方的敏感私事（sensitive-other：敏感度 ≥ b5Sensitivity——还没提炼的用第一眼的 sens——、不是他自己的事、
//     听的不只是管理者、这里有人当时没听到而且不在同一场合）。
//     例外（B1 豁免，D106，原样）：触发者自己的一句（A4）因为 B1 被挡，而这句话跟眼前的事有关（第一眼的 asks，卡片上只有他和她；他还开着的
//     意图的来源行；在叮嘱他前面一句要她照着做的话（applies）；或者他就在这里提起了它）、限制是他自己的话定的（第一眼核对过原话，
//     或者 restricted_by 是他）、这里也没有被点名不许知道的人——这时她照样记得（「我说个数你乘3」「别告诉他们规则哈」），带着叮嘱进来。
//   - 其余一律进来：第一段放行的、封顶的（B1 soft / relation / 可能在场、B4 封顶（标签「主人定过」）、还没评估、敏感 < 0.7、晚到的成员、她自己的猜测……）都给原文，
//     每条带一份 label（代码拼的事实，不是判语）：origin（一对一 / 多人场合 / 她自己 / 素材）、place、at、tellerId、limit（只来自
//     norms.explicitLimit：核对过原话的叮嘱、点了名的名单、主人收紧过的）、ownerVague（主人定过在这里最多说个大概）、mentions（正文里
//     讲到的别的人）、selfOnly（她自己的猜测 / 私下读到的）、hearsay（听别人说的）、open（他托她、还没办的）。
//     第一眼「是别人的事」、正文点了别人的名字都不再挡（改成标签「讲到了X」）；没有清晰度（gist）这一说。
// 每条放进来的都对得上一行 appraisals（stage = 1，rule A4 / A5 / A1… / 第一段的规则，verdict share；reason 'working:<rule>:<origin>[:l]'），
// 满足 §9.3.6「每条都对得上一次判定」；同样的情形沿用上一行，不每一轮都写一行新的。
import { refOf, parseRef } from '../store/index.js';
import { logRetentionDays } from '../config/defaults.js';

const DAY = 86_400_000;
import { metric, soft, parseJson } from './util.js';
import { selfId, memoryFacts, rightsEquivalents, isIndividual, previousOther } from './facts.js';
import { managerOnly, audiencePeople } from './knowledge.js';
import { evaluate } from './stage1.js';
import { writeAppraisal, triggerClass } from './stage2.js';
import { logDecision } from './told.js';
import { glancesOf, glanceState, glanceLimited, ensureGlances } from './glance.js';
import { explicitLimit } from './norms.js';

const TRIGGER_KINDS = new Set(['utterance', 'action']);
const SELF_KINDS = new Set(['self-utterance', 'self-action']);

/** 她自己的名字（entity_names），规范化前的原样（找「@名字」用）。 */
function ownNames(core, memo) {
  const key = 'wm:ownNames';
  if (memo?.has(key)) return memo.get(key);
  const me = selfId(core, memo);
  const out = new Set();
  if (me != null) {
    for (const r of core.store.all('SELECT text_raw FROM entity_names WHERE entity_id = ?', me)) {
      const n = String(r.text_raw ?? '').trim();
      if (n) out.add(n);
    }
  }
  memo?.set(key, out);
  return out;
}

const AT_SIGNS = /[@＠]/gu;
/**
 * 去掉一句对她说的话里「叫她」的那一处 @（discretion.withoutAddress 的实现）：只去掉 @ 后面紧跟的、确定是在叫她的那个名字——
 * 她自己的名字；这条感知的提及里认成她的那个名字；整句只有一处 @、这句话又是在叫她时，提及里记下的那个名字（她的群名片可能被
 * 认成了别人，实测）。别的 @、别的字一个都不动：「@她阿明欠了一屁股债」去掉的只是「@她」，「阿明」照样扫得出来。
 * 不是对她说的、没有 @ 的，原样返回。
 * @param {{text?: string|null, addressed?: string, mentions_json?: string|null, id?: number}} p  感知行（没带 mentions_json 就按 id 读）
 * @returns {string}
 */
export function withoutAddress(core, p, memo) {
  const text = String(p?.text ?? '');
  if (!text || !(p.addressed === 'to-her' || p.addressed === 'mentions-her')) return text;
  const ats = [...text.matchAll(AT_SIGNS)].map((m) => m.index);
  if (!ats.length) return text;
  let mj = p.mentions_json;
  if (mj === undefined && Number.isSafeInteger(p.id)) mj = core.store.get('SELECT mentions_json FROM percepts WHERE id = ?', p.id)?.mentions_json ?? null;
  const me = selfId(core, memo);
  const ments = parseJson(mj, []);
  const list = Array.isArray(ments) ? ments : [];
  const hers = new Set(ownNames(core, memo));
  const claimed = new Set();
  let selfMentioned = p.addressed === 'mentions-her';
  for (const m of list) {
    const isMe = m?.self === true || (me != null && m?.entityId === me);
    if (isMe) selfMentioned = true;
    for (const c of Array.isArray(m?.actor?.claims) ? m.actor.claims : []) {
      const n = typeof c?.name === 'string' ? c.name.trim() : '';
      if (n) (isMe ? hers : claimed).add(n);
    }
  }
  if (ats.length === 1 && selfMentioned) for (const n of claimed) hers.add(n);
  const names = [...hers].sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  let out = text;
  for (const at of [...ats].reverse()) {
    const n = names.find((x) => out.startsWith(x, at + 1));
    if (n) out = `${out.slice(0, at)} ${out.slice(at + 1 + n.length)}`;
  }
  return out;
}

/**
 * 正文里点到的具体的人（她自己除外）：entities.nameMatcher，零 LLM。读不到匹配器按「点了不认识的人」（不放进工作记忆，更严）。
 * 对她说的话里叫她的那一处 @ 先去掉（withoutAddress，只去掉那个名字，别的字照样扫）。matcher 由调用方在事务外先取好（事务里建的不缓存）。
 */
function namedInText(core, p, text, memo, matcher) {
  try {
    if (!matcher) throw new Error('no matcher');
    const plain = withoutAddress(core, { ...p, text }, memo);
    const hits = matcher.scan(plain, { settingKey: p.setting_key }) ?? [];
    const me = selfId(core, memo);
    // 同一处名字也认得出是她（她的群名片被早先的提及立成了「另一个人」，评审）：那一处就是在叫她，不算点了别人
    const mine = hits.filter((h) => h?.entityId === me);
    const over = (h) => mine.some((x) => Number.isFinite(x.start) && x.start < h.end && h.start < x.end);
    const kept = hits.filter((h) => !over(h) && h?.entityId != null && h.entityId !== me && isIndividual(core, h.entityId, memo));
    return { ok: true, ids: [...new Set(kept.map((h) => h.entityId))], hits: kept };
  } catch {
    return { ok: false, ids: [], hits: [] };
  }
}

/**
 * A4 / A5（D100）：这一行是触发者亲口说的（K1；他要她做的事 K3 也是他亲口说的那一句），或者是她回触发者的那一句（K2）。
 * D113：涉及别人不再让它不成立——正文里扫出来的别的人（她和触发者除外）记进 mentions，渲染成「（讲到了X）」。mentions 是正文里
 * 原样出现的那个称呼（不是档案上的名字：标签不能透露正文里没有的东西，比如另一个平台上的叫法，B3）。
 * 返回 {rule: 'A4'|'A5'|null, tellerId, why, mentions: string[], selfOnly: 'guess'|'read'|null, material}。
 */
function workingRule(core, m, ev, trigEq, memo, matcher) {
  const none = { rule: null, tellerId: null, mentions: [], selfOnly: null, material: false };
  if (m.kind !== 'percept') return { ...none, why: 'not-percept' };
  const f = ev.facts ?? memoryFacts(core, m, memo);
  const p = f?.percept;
  if (!p || f.text == null) return { ...none, why: 'missing' };
  const me = selfId(core, memo);
  const ok = (e) => e === me || trigEq.has(e);
  const named = namedInText(core, p, f.text, memo, matcher);
  const mentions = [...new Set((named.hits ?? []).filter((h) => !ok(h.entityId)).map((h) => String(h.name ?? '').trim()).filter(Boolean))];
  const selfOnly = p.visible_to === 'her-only' ? 'read' : ((ev.notes ?? []).includes('own-guess') || f.derivedSelf || ev.circle?.selfOnly) ? 'guess' : null;
  const material = p.standing === 'material';
  const base = { ...none, mentions, selfOnly, material };
  if (selfOnly) return { ...base, why: 'self-only' };
  if (material) return { ...base, why: 'material' };
  if (!p.actor_self && TRIGGER_KINDS.has(p.kind) && trigEq.has(p.actor_entity_id)) return { ...base, rule: 'A4', tellerId: p.actor_entity_id };
  if (p.actor_self && SELF_KINDS.has(p.kind)) {
    const prev = previousOther(core, p);
    if (prev && trigEq.has(prev.actor_entity_id)) return { ...base, rule: 'A5', tellerId: prev.actor_entity_id };
  }
  return { ...base, why: 'not-trigger' };
}

/**
 * 工作记忆的准入（discretion.admitWorking 的实现）。
 * refs 的每一项：ref、topicSim（和眼前这句话的话题相似度：只给 B1 豁免的「他就在这里提起了它」用）、open（他还开着的意图的来源行）。
 * 返回的每一项带 label（见文件头）、glance（done / pending / failed / none）、restricted（有叮嘱）、quote、tellerId、replaces。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{ref: string, topicSim?: number, open?: boolean}[]} refs
 * @param {import('../core-types.js').DisclosureTarget} target
 * @returns {{items: object[], excluded: {ref: string, rule: string}[]}}
 */
export function admitWorking(core, refs, target) {
  const out = { items: [], excluded: [] };
  const list = (refs ?? []).filter((r) => r && typeof r.ref === 'string' && parseRef(r.ref));
  if (!list.length || !target?.audience) return out;
  const cfg = core.config.get();
  const W = cfg.recall.working;
  const memo = new Map();
  const a = target.audience;
  const trig = Number.isSafeInteger(target.triggerEntityId) ? target.triggerEntityId : null;
  const at = core.now();
  // 第一眼（同步读）：还 pending 而这个进程里没有在看它的（重启后留下的），顺手重新排上——不等它，这一轮照常
  const pids = list.map((r) => parseRef(r.ref)).filter((m) => m.kind === 'percept').map((m) => m.id);
  const glances = glancesOf(core, pids);
  // 失败过的也再排（评审：原来只有那个场合又来一句时才重试；按被想起的次数逐级退让，见 glance.ensureGlances）
  const pending = pids.filter((id) => ['pending', 'failed'].includes(glances.get(id)?.state));
  if (pending.length && !core.readOnly) ensureGlances(core, pending);
  // 整批不进工作记忆的情形（底线，不是 A4 / A5 能越过的）
  let whole = null;
  if (trig == null) whole = 'no-trigger';
  else if (a.publicLike) whole = 'B2';
  else if (a.preSendGate === false && !managerOnly(core, a, memo)) whole = 'final-channel';
  else if ((target.batchTargets ?? []).length) whole = 'batch';
  if (whole) {
    for (const r of list) out.excluded.push({ ref: r.ref, rule: whole });
    metric(core, `wm.excluded.${whole}`, list.length);
    return out;
  }
  const trigEq = rightsEquivalents(core, [trig], memo).get(trig) ?? new Set([trig]);
  const onTopicMin = Number.isFinite(W.onTopicMin) ? W.onTopicMin : 0.35;
  // 名字匹配器在事务外先取好：事务里建的不缓存，每一行都会重建一遍（名字表一变就是这样）
  let matcher = null;
  try { matcher = core.mods.entities.nameMatcher(core); } catch { matcher = null; }
  if (matcher) memo.set('nameMatcher', matcher);   // 第一段的 repliedToTrigger 也用这一个（D110）
  const tc = triggerClass(core, trig, memo);
  const logs = [];
  const exclude = (r, rule, ev, extra = {}) => {
    out.excluded.push({ ref: r.ref, rule, unassessed: !!ev?.norm?.unassessed });
    metric(core, `wm.excluded.${rule}`);
    logs.push({ kind: 'omit', settingKey: a.settingKey, ref: r.ref, triggerEntityId: trig, subjectEntityId: extra.subject ?? null,
      reason: `wm-excluded:${rule}`, at, version: ev?.norm?.version ?? null });
  };
  core.store.tx(() => {
    for (const r of list) {
      const m = parseRef(r.ref);
      const g = m.kind === 'percept' ? glances.get(m.id) ?? null : null;
      let ev;
      try { ev = evaluate(core, m, target, memo); } catch (e) {
        soft(core, 'wm.stage1', () => { throw e; }, null);
        ev = { decision: 'block', rule: 'error', notes: [] };
      }
      const w = ev.rule === 'missing' || ev.rule === 'error' ? null : workingRule(core, m, ev, trigEq, memo, matcher);
      let rule;
      let limit = null;
      if (ev.decision === 'block') {
        // B1 豁免（D106）：他自己的一句、要她做点什么、限制是他自己定的、这里没有被点名不许知道的人
        if (ev.rule === 'B1' && w?.rule === 'A4' && b1Exempt(core, ev, g, r, trigEq, a, memo, glances, onTopicMin)) {
          rule = 'A4';
          const n = ev.norm ?? {};
          limit = explicitLimit(core, m, g, memo) ?? { kind: 'strict', quote: n.restrictionQuote ?? null, by: n.restrictedBy ?? w.tellerId ?? null, deny: n.deny ?? [] };
        } else {
          exclude(r, ev.rule ?? 'error', ev, { subject: (ev.subjects ?? [])[0] ?? null });
          continue;
        }
      } else if (ev.sensitiveOther || ev.namedDeny) {
        exclude(r, ev.sensitiveOther ? 'sensitive-other' : 'named-deny', ev, { subject: (ev.subjects ?? [])[0] ?? null });
        continue;
      } else if (w?.why === 'missing') {
        exclude(r, 'missing', ev);
        continue;
      } else {
        rule = w?.rule ?? ev.rule;
        limit = explicitLimit(core, m, g, memo);
      }
      const n = ev.norm ?? {};
      const f = ev.facts ?? memoryFacts(core, m, memo);
      const p = f?.percept ?? null;
      const tellerId = w?.tellerId ?? (m.kind === 'percept' ? tellerOfRow(core, ev, m, memo) : null);
      const one = (n.originExposure?.exposureRank ?? 0) <= 0;
      const origin = w?.material ? 'material' : p?.actor_self ? 'self' : one ? 'one-on-one' : 'group';
      const speaker = p && !p.actor_self ? p.actor_entity_id ?? null : null;
      const label = {
        origin, place: p?.setting_key ?? f?.settingKey ?? null, at: p?.at ?? f?.at ?? null, tellerId,
        limit: limit ? { kind: limit.kind, quote: limit.quote ?? null, by: limit.by ?? null } : null,
        ownerVague: !!ev.ownerCap && ev.decision === 'cap',
        mentions: (w?.mentions ?? []).slice(0, 3), selfOnly: w?.selfOnly ?? null,
        hearsay: speaker != null && !trigEq.has(speaker) ? speaker : null, open: !!r.open,
      };
      const gs = glanceState(g);
      const row = {
        stage: 1, rule, memoryKind: m.kind, memoryId: m.id, settingKey: a.settingKey, normVersion: n.version ?? null,
        snapshotId: a.snapshotId, taint: target.taint, triggerClass: tc, verdict: 'share',
        reason: `working:${rule}:${origin}${limit ? ':l' : ''}`,
      };
      const id = reuseAppraisal(core, row) ?? writeAppraisal(core, row);
      out.items.push({
        ref: refOf(m.kind, m.id), verdict: 'share', vagueText: null, hintOk: false, appraisalRef: `ap${id}`, stage: 1, rule,
        unassessed: !!n.unassessed, newKnowers: ev.N?.empty ? 0 : (Number.isFinite(ev.N?.count) ? ev.N.count : -1),
        glance: gs, restricted: !!limit, tellerId, originRank: n.originExposure?.exposureRank ?? 0,
        quote: limit?.quote ?? null, replaces: g?.state === 'done' ? g.replaces ?? null : null, label,
      });
      metric(core, `wm.origin.${origin}`);
      if (limit) metric(core, 'wm.limit');
    }
  });
  const fresh = logs.filter((lg) => onceLogged(core, target, lg));
  if (fresh.length && !core.store.closed) soft(core, 'wm.log', () => core.store.tx(() => { for (const { version, ...lg } of fresh) logDecision(core, lg); }), null);
  return out;
}

/**
 * B1 豁免（D106）的三个条件，全是代码看得到的事实：
 *   - 这句话跟眼前的事有关：第一眼的 asks（卡片上只有他和她，mixed = 0）；这一行是他还开着的意图的来源行；它是在叮嘱他前面一句
 *     要她照着做的话（第一眼的 applies 指到的那一句 asks，「我说个数你乘3」+「别告诉他们规则哈」）；或者他就在这里提起了它
 *     （话题相似度 ≥ onTopicMin：他提起时细节回来，和清晰度同一个口径）。都不是的——他叮嘱过、又跟眼前无关的一句——照旧是底线；
 *   - 限制是他自己的话定的：第一眼核对过原话（quote_ok，原话在他的话里），或者规范的 restricted_by 是他（同一个人也算）；不是场合规矩抬上去的；
 *   - 这里没有被点名不许知道的人（deny 的人和他们的同一个人都不在；受众看不全而有 deny 的，按「可能在」）。
 */
function b1Exempt(core, ev, g, r, trigEq, a, memo, glances, onTopicMin) {
  const n = ev.norm ?? {};
  const done = g?.state === 'done';
  const appliesAsks = done && !g.mixed && (g.applies ?? []).some((id) => {
    let x = glances?.get(id);
    if (!x) x = glancesOf(core, [id]).get(id);
    return x?.state === 'done' && x.asks && !x.mixed;
  });
  const asks = (done && g.asks && !g.mixed) || !!r.open || appliesAsks || (r.topicSim ?? 0) >= onTopicMin;
  if (!asks) return false;
  if (n.ruleRaised) return false;
  const byHim = glanceLimited(g) || (n.restrictedBy != null && trigEq.has(n.restrictedBy));
  if (!byHim) return false;
  const deny = n.deny ?? [];
  if (deny.length) {
    if (ev.N?.unknownRemainder || a.unknownObservers) return false;
    const people = new Set(audiencePeople(core, a, memo));
    const eq = rightsEquivalents(core, deny, memo);
    for (const d of deny) for (const x of eq.get(d) ?? [d]) if (people.has(x)) return false;
  }
  if (n.allow && !(n.restrictedBy != null && trigEq.has(n.restrictedBy))) return false;
  return true;
}

/** 这一行是谁的话：他说的就是他；她说的，是她回的那个人（紧挨着的上一条不是她说的感知）。 */
function tellerOfRow(core, ev, m, memo) {
  const p = (ev.facts ?? memoryFacts(core, m, memo))?.percept;
  if (!p) return null;
  if (!p.actor_self) return p.actor_entity_id ?? null;
  return previousOther(core, p)?.actor_entity_id ?? null;
}

/**
 * 同一条、同一个目标、同样的规范版本 / 快照 / 污点 / 触发者 / 规则 / 来源 / 有没有叮嘱的工作记忆判定，沿用上一行（不每一轮都写一行新的）。
 * 来源和有没有叮嘱写在 reason 里（working:<rule>:<origin>[:l]，D113），按 reason 对（speak 列只为兼容旧行，新行都是 NULL）。找不到返回 null。
 */
function reuseAppraisal(core, row) {
  // 只沿用比判定的保留期新至少一天的行（D139）：夜里的到期清理删不到这一轮刚沿用、还没记进注入日志的那一行
  const days = logRetentionDays(core.config.get()).appraisals;
  const since = days == null ? 0 : core.now() - (days - 1) * DAY;
  const r = core.store.get(`SELECT id FROM appraisals WHERE memory_kind = ? AND memory_id = ? AND stage = 1 AND setting_key IS ? AND norm_version IS ?
                              AND snapshot_id IS ? AND taint = ? AND trigger_class IS ? AND rule IS ? AND speak IS ? AND verdict = ? AND reason IS ?
                              AND at >= ?
                            ORDER BY at DESC, id DESC LIMIT 1`,
  row.memoryKind, row.memoryId, row.settingKey ?? null, row.normVersion ?? null, row.snapshotId ?? null, row.taint ? 1 : 0, row.triggerClass ?? null,
  row.rule ?? null, row.speak ?? null, row.verdict, row.reason ?? null, since);
  return r ? Number(r.id) : null;
}

/** 挡在工作记忆之外的同一条、同一个原因（规范版本不变），每个会话只记一次（不是每一轮都写一行）。 */
function onceLogged(core, target, lg) {
  const st = core.state.discretion;
  st.wmLogged ??= new Set();
  const k = `${target.sessionId ?? target.audience?.settingKey ?? ''}|${lg.ref}|${lg.reason}|${lg.version ?? ''}|${lg.triggerEntityId ?? ''}`;
  if (st.wmLogged.has(k)) return false;
  const cap = core.config.get().recall.working?.memoMax ?? 2000;
  if (st.wmLogged.size >= cap) st.wmLogged.clear();
  st.wmLogged.add(k);
  return true;
}
