// 「这之后他的事」（D164，用户反馈第 38 轮，实测问题 #69）：重新在一个场合接上话的时候，对眼前这个人（有人对她说话时是触发者；
// 她自己开口时是她要对着说的人，和工作记忆同一批），确定地给一小栏——她和他上次在这里说完话以后，她在别处知道的关于他的事，一件一行，
// 按要紧排。同步、零 LLM、不抽样；能不能说照常由关口①判（这里只挑候选，不放宽任何底线）。
// 为什么要这一层：工作记忆和「在场的人最近」给的是他在别处最近说的那些**话**（按行、按新旧），他在别处一聊得多，半小时前的要紧事就被最新的
// 闲聊挤掉；这里给的是这之后**他的事**有了什么变化（按事、按要紧）。D132 解决的是「别处的事一点不知道」，这一层解决「知道的不是要紧的那部分」。
// 不给「主动开口」单写规矩：有人对她说话的轮也一样算，只是「上次在这里说完话」离现在很近时自然是空的。
//
// 「上次在这里说完话」since（每个人各算，他的几个档案——权利层确认的同一个人，retrieve.samePeople——都算他）= max(herAt, hisAt)：
//   - herAt：她在这里最后一次开口。一对一是她在这里的任何一句；别处（群）只算她「接着回他」的那一句（她那一句前面最近一条别人亲口说的
//     是他；和 retrieve.recentPartners、recall.js 的 elsewhereSince 同一个口径）。一次只往回看 recall.working.candidatePool 句她的话；
//   - hisAt：他在这里最后一句话，但不算「眼前还没回的这一串」——她在这里最后一次开口（任何一句）之后他说的都不算（那是这一轮正要回的）；
//   - 两个都没有（他们没在这里说过话）：这个人没有这一层（没有「上次」可言）。没有任何时间窗。
// 候选：
//   (a) 这之后知道的关于他的事：现行的事实（没被取代、没过时——撤回也是标过时、不是她的经验、不是她自己的猜测），他是主体（或者是他的计划），
//       她知道它的时间（来源那句话的时间，最新的一条；查不到来源退回 recorded_at）在 since 之后，来源不全在这个场合（全在这里的，这里的聊天记录本来就有）；
//   (b) 这之后有了结果的计划：关于他的计划，状态历史里有一条在 since 之后、不是 planned / unknown 的变化（done、cancelled、missed、in_progress），
//       证据那句话不在这个场合。计划本身什么时候记下的都算。它的结果是一条事实（plan_outcome_ref 指向 assertion）时跟它成一组、只占一个名额；
//       指向一段经历时不带（经历截到开头几十个字，多半和这件事无关；计划自己的状态说法「（后来做完了，今晚 18:01）」就够了）。
// 排序（平滑的打分，没有硬的时间窗）：分数 = 重要度 + （有了结果的计划 ? resolvedBoost : 0）− log2(1 + 距现在的小时数 / ageScaleH)，
//   分数高的在前，相同时新的在前。「距现在」：事实按她知道的时间，计划按状态变化的时间。刚发生的事里要紧的先说、有了结果的计划稍占先
//   （她不知道就会去问的正是这种）；隔了几天的事让位给今天的事（原来「有结果的计划一律最前」时，四天前做完的计划排在了今天的事前面）。
// 名额：context.sinceHere.maxItems；几个人时主触发者 / 第一个要对着说的人优先，后面的人（有候选的）至少各留 1 条。
// 本周期已经给过她的不挑（计划和结果都给过的整组不挑）：名额留给没给过的。例外是有了结果的计划：一个周期可能有好几天，几天前给过
//   「打算做 X」、后来才做完时，她心里的还是旧状态——它上次给她的时间（givenAt，context 从这个周期的注入记录里查）早于这次状态变化的，
//   算没给过、再给一次（regive，带新的状态说法）；状态没再变就照旧不给。普通事实照旧按引用去重。
import { refOf, parseRef } from '../store/index.js';

const SELF_KINDS = ['self-utterance', 'self-action'];
const HIS_KINDS = ['utterance', 'action'];
// 算「有了结果」的计划状态（planned 是还没结果；unknown 是维护任务到点没听说下文标的，不是别处来的消息）
const RESOLVED = ['done', 'cancelled', 'missed', 'in_progress'];

const marks = (xs) => xs.map(() => '?').join(',');

/**
 * 他的几个档案（retrieve.samePeople；没有这个函数、出错时只有他自己）。
 * @returns {number[]}
 */
function peopleOf(core, entityId) {
  let ids = null;
  try { ids = core.mods.retrieve.samePeople?.(core, entityId) ?? null; } catch { ids = null; }
  const out = [entityId, ...(Array.isArray(ids) ? ids : [])].filter((x) => Number.isSafeInteger(x));
  return [...new Set(out)];
}

/**
 * 她和他上次在这里说完话的时间（见文件头）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{key: string, people: number[], oneOnOne: boolean, at: number, pool: number}} p
 * @returns {{since: number|null, herAt: number|null, hisAt: number|null}}
 */
export function sinceOf(core, { key, people, oneOnOne, at, pool }) {
  const none = { since: null, herAt: null, hisAt: null };
  if (!people.length) return none;
  const ph = marks(people);
  const sk = marks(SELF_KINDS);
  const hk = marks(HIS_KINDS);
  // 她在这里最后一次开口（任何一句）：「眼前还没回的这一串」从它之后算起
  const lastHer = core.store.get(`SELECT id, at FROM percepts WHERE setting_key = ? AND actor_self = 1 AND kind IN (${sk}) AND at <= ?
                                   ORDER BY id DESC LIMIT 1`, key, ...SELF_KINDS, at) ?? null;
  let herAt = null;
  if (lastHer) {
    if (oneOnOne) herAt = lastHer.at;
    else {
      // 群里：她接着回他的那一句（她那一句前面最近一条别人亲口说的是他）。一次只看她最近 pool 句
      const r = core.store.get(`SELECT MAX(s.at) AS at FROM percepts s
          WHERE s.id IN (SELECT id FROM percepts WHERE setting_key = ? AND actor_self = 1 AND kind IN (${sk}) AND at <= ? ORDER BY id DESC LIMIT ?)
            AND (SELECT o.actor_entity_id FROM percepts o WHERE o.setting_key = s.setting_key AND o.id < s.id AND o.actor_self = 0 AND o.kind IN (${hk})
                 ORDER BY o.id DESC LIMIT 1) IN (${ph})`, key, ...SELF_KINDS, at, Math.max(1, Math.floor(pool)), ...HIS_KINDS, ...people);
      herAt = Number.isFinite(r?.at) ? r.at : null;
    }
  }
  // 他在这里最后一句：只算她最后一次开口之前的（之后的是这一轮正要回的）；她从没在这里开过口，他说的都还没回
  const his = lastHer ? core.store.get(`SELECT MAX(at) AS at FROM percepts WHERE setting_key = ? AND actor_self = 0 AND actor_entity_id IN (${ph})
                                         AND kind IN (${hk}) AND id < ?`, key, ...people, ...HIS_KINDS, lastHer.id) : null;
  const hisAt = Number.isFinite(his?.at) ? his.at : null;
  const since = herAt == null && hisAt == null ? null : Math.max(herAt ?? -Infinity, hisAt ?? -Infinity);
  return { since, herAt, hisAt };
}

/** 排序的分数（见文件头）。at：这一轮的时间。 */
export function scoreOf(g, at, { resolvedBoost = 2, ageScaleH = 6 } = {}) {
  const ageH = Math.max(0, (at - g.knownAt) / 3_600_000);
  return (Number(g.imp) || 0) + (g.resolved ? resolvedBoost : 0) - Math.log2(1 + ageH / Math.max(1e-6, ageScaleH));
}

/**
 * 一个人的候选（见文件头 (a)(b)），已排好序。每件是一组：{lead, outcome?, resolved, imp, knownAt, regive?}。
 * givenAt(ref)：这条本周期最后一次给她的时间（查不到返回 null）；只用来判有了结果的计划要不要再给一次。
 * @returns {{lead: string, outcome: string|null, resolved: boolean, imp: number, knownAt: number, score: number, regive?: boolean}[]}
 */
export function candidatesFor(core, { key, people, since, at = core.now(), sent = new Set(), givenAt = () => null, resolvedBoost = 2, ageScaleH = 6 }) {
  if (!people.length || !Number.isFinite(since)) return [];
  const ph = marks(people);
  // 关于他的现行事实：他是主体，或者是他的计划。没被取代、没过时（撤回也是标过时）、不是经验、不是她自己的猜测
  const live = `a.superseded_by IS NULL AND a.expired_at IS NULL AND a.kind_hint <> 'lesson' AND a.certainty <> 'inferred'`;
  const about = `(a.plan_agent IN (${ph}) OR a.id IN (SELECT assertion_id FROM assertion_entities WHERE role = 'subject' AND entity_id IN (${ph})))`;
  // 她知道它的时间：来源那句话的时间（最新的一条）；查不到来源退回 recorded_at。来源在哪儿：记下的场合，没有就按那句话的场合
  const facts = core.store.all(`SELECT a.id, a.imp, a.recorded_at,
        (SELECT MAX(COALESCE(p.at, s.at)) FROM sources s LEFT JOIN percepts p ON p.id = s.percept_id
          WHERE s.owner_kind = 'assertion' AND s.owner_id = a.id) AS src_at,
        (SELECT COUNT(*) FROM sources s WHERE s.owner_kind = 'assertion' AND s.owner_id = a.id) AS n_src,
        (SELECT COUNT(*) FROM sources s LEFT JOIN percepts p ON p.id = s.percept_id
          WHERE s.owner_kind = 'assertion' AND s.owner_id = a.id AND COALESCE(s.perceived_in, p.setting_key) = ?) AS n_here,
        (SELECT COUNT(*) FROM sources s WHERE s.owner_kind = 'assertion' AND s.owner_id = a.id AND s.mode = 'inferred') AS n_guess
      FROM assertions a WHERE ${live} AND ${about} AND a.updated_at > ?`,
  // updated_at ≥ recorded_at，追加来源（又听到一次）也会更新它：since 之后没动过的事实不可能是这之后知道的，先按它筛掉，再逐条按来源的时间算
  key, ...people, ...people, since);
  const known = new Map();
  for (const f of facts) {
    const knownAt = Number.isFinite(f.src_at) ? f.src_at : f.recorded_at;
    if (!(knownAt > since)) continue;
    if (f.n_src > 0 && f.n_here >= f.n_src) continue;   // 来源全在这里
    if (f.n_guess > 0 && f.n_guess >= f.n_src) continue; // 全是她自己猜的
    known.set(refOf('assertion', f.id), { imp: Number(f.imp) || 0, knownAt });
  }
  // 这之后有了结果的计划：最新一条在 since 之后、不是 planned / unknown 的状态变化，证据不在这里
  const plans = core.store.all(`SELECT a.id, a.imp, a.plan_status, a.plan_outcome_ref, MAX(h.at) AS h_at
      FROM assertions a JOIN plan_status_history h ON h.assertion_id = a.id
      LEFT JOIN percepts ep ON ep.id = h.evidence_percept
      WHERE a.superseded_by IS NULL AND a.expired_at IS NULL AND a.kind_hint <> 'lesson' AND ${about} AND a.plan_status IN (${marks(RESOLVED)})
        AND h.status IN (${marks(RESOLVED)}) AND h.at > ? AND (ep.id IS NULL OR ep.setting_key <> ?)
      GROUP BY a.id`, ...people, ...people, ...RESOLVED, ...RESOLVED, since, key);
  const out = [];
  const used = new Set();
  for (const p of plans) {
    const lead = refOf('assertion', p.id);
    // 结果只认一条事实（见文件头）
    const m = typeof p.plan_outcome_ref === 'string' ? parseRef(p.plan_outcome_ref) : null;
    const outcome = m?.kind === 'assertion' && p.plan_outcome_ref !== lead ? refOf('assertion', m.id) : null;
    const oRow = outcome ? core.store.get('SELECT imp, expired_at FROM assertions WHERE id = ?', m.id) : null;
    const o = outcome && oRow && oRow.expired_at == null ? outcome : null;
    // 计划本周期给过：上次给的时间早于这次状态变化的，再给一次（她心里的还是旧状态）
    let regive = false;
    if (sent.has(lead)) {
      let g = null;
      try { g = givenAt(lead); } catch { g = null; }
      regive = Number.isFinite(g) && g < p.h_at;
    }
    used.add(lead);
    if (o) used.add(o);
    if (sent.has(lead) && !regive && (!o || sent.has(o))) continue;
    out.push({ lead, outcome: o, resolved: true, imp: Math.max(Number(p.imp) || 0, Number(oRow?.imp) || 0, known.get(o)?.imp ?? 0), knownAt: p.h_at,
      ...(regive ? { regive: true } : {}) });
  }
  for (const [ref, f] of known) {
    if (used.has(ref) || sent.has(ref)) continue;
    out.push({ lead: ref, outcome: null, resolved: false, imp: f.imp, knownAt: f.knownAt });
  }
  for (const g of out) g.score = scoreOf(g, at, { resolvedBoost, ageScaleH });
  return out.sort((x, y) => (y.score - x.score) || (y.knownAt - x.knownAt) || (x.lead < y.lead ? -1 : 1));
}

/**
 * 这一层的候选（compute 第 0c 步）：每个人算 since、取候选，按名额分好。返回要交给关口①的条目（同一组的计划和结果挨着，计划在前）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{key: string, persons: number[], oneOnOne: boolean, at: number, cfg: object, selfId: number|null, sent: Set<string>,
 *          givenAt?: (ref: string) => number|null}} p
 *        persons：眼前这几个人（主触发者 / 第一个要对着说的人在前）；givenAt：一条本周期最后一次给她的时间（有了结果的计划再给一次用）
 * @returns {{groups: {person: number, since: number, lead: string, outcome: string|null, resolved: boolean, imp: number, knownAt: number,
 *            score: number, regive?: boolean}[],
 *            people: number, empty: number}}  people：算了几个人；empty：其中没有「上次」的几个
 */
export function sinceHereFor(core, { key, persons, oneOnOne, at, cfg, selfId, sent, givenAt = () => null }) {
  const C = cfg.context?.sinceHere ?? {};
  const res = { groups: [], people: 0, empty: 0 };
  if (C.enabled === false) return res;
  const max = Math.max(0, Math.floor(C.maxItems ?? 4));
  if (!max) return res;
  const maxPeople = Math.max(1, Math.floor(cfg.recall?.working?.maxTriggers ?? 3));
  const pool = Math.max(1, Math.floor(cfg.recall?.working?.candidatePool ?? 300));
  const lists = [];
  const seenPerson = new Set();
  for (const id of persons ?? []) {
    if (!Number.isSafeInteger(id) || id === selfId || seenPerson.has(id)) continue;
    seenPerson.add(id);
    if (lists.length >= maxPeople) break;
    const people = peopleOf(core, id);
    res.people += 1;
    const { since } = sinceOf(core, { key, people, oneOnOne: !!oneOnOne, at, pool });
    if (since == null) { res.empty += 1; continue; }
    const cands = candidatesFor(core, { key, people, since, at, sent, givenAt,
      resolvedBoost: Number.isFinite(C.resolvedBoost) ? C.resolvedBoost : 2, ageScaleH: Number.isFinite(C.ageScaleH) ? C.ageScaleH : 6 });
    if (cands.length) lists.push({ person: id, since, cands });
  }
  if (!lists.length) return res;
  // 名额：后面的人（有候选的）至少各留 1 条，其余先给第一个人，还有剩的按人的先后补
  const taken = new Set();
  const take = (l, n) => {
    let k = 0;
    while (k < n && l.cands.length) {
      const g = l.cands.shift();
      if (taken.has(g.lead) || (g.outcome && taken.has(g.outcome))) continue;
      taken.add(g.lead);
      if (g.outcome) taken.add(g.outcome);
      res.groups.push({ person: l.person, since: l.since, ...g });
      k += 1;
    }
  };
  const reserve = Math.min(lists.length - 1, max - 1);
  take(lists[0], max - reserve);
  for (const l of lists.slice(1)) if (res.groups.length < max) take(l, 1);
  for (const l of lists) if (res.groups.length < max) take(l, max - res.groups.length);
  return res;
}
