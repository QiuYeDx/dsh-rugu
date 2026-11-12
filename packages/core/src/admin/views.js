// 管理页的数据面（§13.1）：各类列表和一条记忆的详情。只给主人（鉴权在集成层）：主人看得到全部，包括隐藏的（§9.3.7 第 3 条），
// 每条都带它的隐藏状态。这里只读；读别的模块的表直接写 SQL（schema 就是契约），过滤条件一律参数化。
import { ContractError } from '../contract/errors.js';
import { parseRef, refOf, OWNER_TABLES } from '../store/refs.js';
import { matchQuery, matchQueryAll } from '../store/fts.js';
import { activeRules, modeFor, doNotRemember } from './rules.js';
import { listReview, listNeedToKnow } from './review.js';
import { param } from './params.js';

/** 拦下过话的目标场合里，现在是公开的（publicLike）那些（「被拦下的话」按它分公开路径和旧规则；读不到属性的不算公开）。 */
function publicKeys(core) {
  const out = [];
  for (const r of core.store.all("SELECT DISTINCT setting_key AS k FROM utterances WHERE verdict <> 'speak' AND setting_key IS NOT NULL LIMIT 2000")) {
    let a = null;
    try { a = core.mods.discretion.audienceOf(core, r.k, core.now()); } catch { a = null; }
    if (a?.known && a.publicLike) out.push(r.k);
  }
  return out;
}

const bad = (what, path, message) => new ContractError(what, [{ path, message }]);
const j = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

function pageArgs(core, q) {
  const max = param(core, 'admin.page.max');
  const limit = Math.max(1, Math.min(max, Number.isInteger(q.limit) ? q.limit : param(core, 'admin.page.limit')));
  let offset = 0;
  if (typeof q.next === 'string' && q.next) {
    try { offset = Math.max(0, Number(JSON.parse(Buffer.from(q.next, 'base64url').toString('utf8')).o) || 0); } catch { offset = 0; }
  }
  return { limit, offset };
}
const nextOf = (offset, limit, total) => (offset + limit < total ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : undefined);

function supOf(core, kind, id) {
  const r = core.store.get('SELECT state, restore_until FROM suppressions WHERE owner_kind = ? AND owner_id = ?', kind, id);
  return r ? r.state : null;
}

/** 这条感知的 addressed 是不是第一眼按意思抬上来的（D158，glances.raised）：是 → 'glance'，否则 null。 */
function raisedBy(core, id) {
  try { return core.store.get('SELECT raised FROM glances WHERE percept_id = ?', id)?.raised != null ? 'glance' : null; } catch { return null; }
}

/** 每一档最多取多少条（搜索结果再多主人也翻不完；分页照常）。 */
const SEARCH_MAX = 1000;
const likeOf = (text) => `%${String(text).replace(/[%_\\]/g, '\\$&')}%`;
/** 规范化后比（全角半角、大小写、标点、空白不算差别）：「收不到群里的消息」和「收不到群里的消息。」是同一句。 */
const flat = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/**
 * 主人在管理页搜（D114）：按相关程度排好的 id，最相关的在前。不再把查询拆成单字、单词 OR 起来（那样几乎每条都命中，
 * 再按时间新的在前分页，原话一模一样的旧记忆反而沉到后面几页）。分三档，前一档有的不再出现在后一档：
 *   1. 原文里有这句话（子串；规范化后也算：标点、空白、全角半角不同照样认）——新的在前；
 *   2. 查询的词全都在（FTS 的 AND；多字词够用时只用多字词）——按 bm25；
 *   3. 前两档一条都没有时才退回任意一个多字词（OR，全部多字词）——按 bm25；还没有才退回单字也算的 OR。
 * 语言分析器不可用时只有第 1 档。
 * @param {object} core
 * @param {{table: string, from: string, textSql: string, timeCol: string}} t   FTS 表、主表、原文的 SQL 表达式、时间列
 * @param {string} text
 * @returns {number[]}
 */
function searchIds(core, { table, from, textSql, timeCol }, text) {
  const q = String(text ?? '').trim();
  const out = [];
  const seen = new Set();
  const push = (ids) => { for (const id of ids) if (!seen.has(id) && out.length < SEARCH_MAX) { seen.add(id); out.push(id); } };
  push(core.store.all(`SELECT id FROM ${from} WHERE ${textSql} LIKE ? ESCAPE '\\' ORDER BY ${timeCol} DESC, id DESC LIMIT ${SEARCH_MAX}`, likeOf(q)).map((r) => r.id));
  let terms = null;
  try { terms = [...new Set(core.mods.lang.queryTerms(core, q))]; } catch { terms = null; }
  if (!terms?.length) return out;
  const multi = terms.filter((x) => [...x].length >= 2);
  const key = multi.length ? multi : terms;
  const all = matchQueryAll(key);
  const both = all ? core.store.all(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT ${SEARCH_MAX}`, all).map((r) => r.rowid) : [];
  // 第 2 档里规范化以后其实含着整句的（只是标点、空白不同），提到第 1 档的末尾
  const fq = flat(q);
  if (fq && both.length) {
    const textOf = core.store.prepare(`SELECT ${textSql} AS t FROM ${from} WHERE id = ?`);
    push(both.filter((id) => flat(textOf.get(id)?.t).includes(fq)));
  }
  push(both);
  if (out.length) return out;
  // 第 3 档：任意一个多字词（全部多字词，不只是前 12 个：查询词是单字、二元组交错排的，前 12 个多半是开头的单字和虚的二元组，
  // 后面那几个真正要找的词根本没进查询——集成复核）；连多字词都一条不中才退回单字也算的 OR
  const run = (m) => (m ? core.store.all(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT ${SEARCH_MAX}`, m).map((r) => r.rowid) : []);
  if (multi.length) push(run(matchQuery(multi, 32)));
  if (!out.length) push(run(matchQuery(terms)));
  return out;
}

/**
 * 一页。rank 给了（搜索的结果，最相关的在前）就按它排、只要它里面的；没给按 order。
 */
function paged(core, q, { from, where, params, order, select = '*', map, rank = null }) {
  const { limit, offset } = pageArgs(core, q);
  const conds = [...where];
  const args = [...params];
  let orderSql = order;
  const orderArgs = [];
  if (rank) {
    conds.push('t.id IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(rank));
    orderSql = `(SELECT r.key FROM json_each(?) r WHERE r.value = t.id), ${order}`;
    orderArgs.push(JSON.stringify(rank));
  }
  const w = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = Number(core.store.get(`SELECT count(*) AS n FROM ${from} ${w}`, ...args).n);
  const rows = core.store.all(`SELECT ${select} FROM ${from} ${w} ORDER BY ${orderSql} LIMIT ? OFFSET ?`, ...args, ...orderArgs, limit, offset);
  return { items: rows.map(map), total, next: nextOf(offset, limit, total) };
}

function stateFilter(where, params, kind, q) {
  if (q.state === 'active') { where.push(`NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.owner_kind = '${kind}' AND s.owner_id = t.id)`); }
  else if (q.state === 'hidden' || q.state === 'forgotten') { where.push(`EXISTS (SELECT 1 FROM suppressions s WHERE s.owner_kind = '${kind}' AND s.owner_id = t.id AND s.state = ?)`); params.push(q.state); }
}

const VIEWS = {
  /**
   * 【D124】她自己的经验（管理页「记忆 → 经验」）：现在这一版（all=true 连旧版本也列）。每条带状态（验证过 / 还没验证）、
   * 怎么知道的、工具、只在哪个场合、要避开的坑、提到的人、证据（最多 3 条：原话、或宿主看到的工具结果的一句说明）、
   * 最近 30 天在几天里被想起过、在不在常驻区、隐藏状态；能确认的标 confirmable。
   */
  lessons(core, q) {
    const where = ["t.kind_hint = 'lesson'"];
    const params = [];
    if (q.all !== true) where.push('t.superseded_by IS NULL');
    if (q.status === 'verified' || q.status === 'unverified') {
      where.push("COALESCE(json_extract(t.value, '$.status'), CASE WHEN t.certainty IN ('confirmed','stated') THEN 'verified' ELSE 'unverified' END) = ?");
      params.push(q.status);
    }
    stateFilter(where, params, 'assertion', q);
    let uses = new Map();
    try { uses = core.mods.encode.lessonUses ? core.mods.encode.lessonUses(core, core.now() - 30 * 86_400_000) : new Map(); } catch { uses = new Map(); }
    const src = core.store.prepare(`SELECT s.percept_id, s.mode, s.quote, s.at, s.speaker, p.text AS ptext, p.setting_key, p.actor_self, p.actor_entity_id
        FROM sources s LEFT JOIN percepts p ON p.id = s.percept_id WHERE s.owner_kind = 'assertion' AND s.owner_id = ? ORDER BY s.at DESC LIMIT 3`);
    const ments = core.store.prepare("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role = 'mention'");
    return paged(core, q, {
      from: 'assertions t', where, params, order: 't.updated_at DESC, t.id DESC',
      map: (a) => {
        const info = core.mods.encode.lessonInfo(a);
        return {
          ref: refOf('assertion', a.id), id: a.id, text: a.text, status: info.status, origin: info.origin, how: info.how, tool: info.tool, settingKey: info.setting,
          trap: info.trap, tainted: info.tainted, promoted: info.promotedAt != null, certainty: a.certainty, recordedAt: a.recorded_at, updatedAt: a.updated_at,
          supersededBy: a.superseded_by, supersedes: a.supersedes, about: ments.all(a.id).map((r) => r.entity_id), usedDays: uses.get(refOf('assertion', a.id)) ?? 0,
          evidence: src.all(a.id).map((s) => (s.percept_id != null
            ? { kind: 'percept', ref: refOf('percept', s.percept_id), at: s.at, settingKey: s.setting_key, actorEntityId: s.actor_entity_id, self: !!s.actor_self, text: s.ptext ?? s.quote }
            : { kind: s.mode === 'observed' ? 'tool' : s.mode === 'inferred' ? 'nightly' : 'self', at: s.at, text: s.quote ?? null })),
          // 主人教的、确认过、纠正过的不再给「确认」（评审）
          confirmable: a.superseded_by == null && a.certainty !== 'confirmed' && !core.mods.encode.lessonOwnerMade(a), state: supOf(core, 'assertion', a.id),
        };
      },
    });
  },
  assertions(core, q) {
    const where = [];
    const params = [];
    if (Number.isSafeInteger(q.entityId)) { where.push('t.id IN (SELECT assertion_id FROM assertion_entities WHERE entity_id = ?)'); params.push(q.entityId); }
    if (typeof q.settingKey === 'string') { where.push("t.id IN (SELECT owner_id FROM sources WHERE owner_kind = 'assertion' AND perceived_in = ?)"); params.push(q.settingKey); }
    if (typeof q.certainty === 'string') { where.push('t.certainty = ?'); params.push(q.certainty); }
    if (typeof q.planStatus === 'string') { where.push('t.plan_status = ?'); params.push(q.planStatus); }
    if (q.current === true) where.push('t.superseded_by IS NULL');
    if (q.needsReview === true) where.push('(t.needs_review = 1 OR t.needs_reconcile = 1)');
    stateFilter(where, params, 'assertion', q);
    const rank = typeof q.q === 'string' && q.q.trim()
      ? searchIds(core, { table: 'assertions_fts', from: 'assertions', textSql: 'text', timeCol: 'recorded_at' }, q.q) : null;
    const ents = core.store.prepare('SELECT entity_id AS id, role FROM assertion_entities WHERE assertion_id = ?');
    return paged(core, q, {
      from: 'assertions t', where, params, order: 't.recorded_at DESC, t.id DESC', rank,
      map: (a) => ({ ref: refOf('assertion', a.id), kind: 'assertion', id: a.id, text: a.text, predicate: a.predicate, kindHint: a.kind_hint,
        certainty: a.certainty, confidence: a.confidence, imp: a.imp, recordedAt: a.recorded_at, validFrom: a.valid_from, validToKnown: a.valid_to_known,
        expiredAt: a.expired_at, supersededBy: a.superseded_by, planStatus: a.plan_status, pinned: !!a.pinned, needsReview: !!(a.needs_review || a.needs_reconcile),
        entities: ents.all(a.id).map((r) => ({ entityId: r.id, role: r.role })), state: supOf(core, 'assertion', a.id) }),
    });
  },
  episodes(core, q) {
    const where = [];
    const params = [];
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    if (Number.isSafeInteger(q.entityId)) { where.push('EXISTS (SELECT 1 FROM json_each(t.participants_json) x WHERE x.value = ?)'); params.push(q.entityId); }
    if (typeof q.epKind === 'string') { where.push('t.ep_kind = ?'); params.push(q.epKind); }
    if (Number.isFinite(q.from)) { where.push('t.t_end >= ?'); params.push(q.from); }
    if (Number.isFinite(q.to)) { where.push('t.t_start <= ?'); params.push(q.to); }
    stateFilter(where, params, 'episode', q);
    const rank = typeof q.q === 'string' && q.q.trim()
      ? searchIds(core, { table: 'episodes_fts', from: 'episodes', textSql: "coalesce(title, '') || ' ' || coalesce(narrative, '')", timeCol: 't_end' }, q.q) : null;
    return paged(core, q, {
      from: 'episodes t', where, params, order: 't.t_end DESC, t.id DESC', rank,
      map: (e) => ({ ref: refOf('episode', e.id), kind: 'episode', id: e.id, settingKey: e.setting_key, epKind: e.ep_kind, title: e.title, narrative: e.narrative,
        header: e.header, tStart: e.t_start, tEnd: e.t_end, participants: j(e.participants_json, []), emotion: j(e.emotion_json), state: supOf(core, 'episode', e.id) }),
    });
  },
  entities(core, q) {
    const where = [];
    const params = [];
    if (typeof q.kind === 'string') { where.push('t.kind = ?'); params.push(q.kind); }
    if (typeof q.status === 'string') { where.push('t.status = ?'); params.push(q.status); }
    if (typeof q.q === 'string' && q.q.trim()) {
      where.push("(t.display_name LIKE ? ESCAPE '\\' OR t.id IN (SELECT entity_id FROM entity_names WHERE text_raw LIKE ? ESCAPE '\\'))");
      const like = `%${q.q.replace(/[%_\\]/g, '\\$&')}%`;
      params.push(like, like);
    }
    stateFilter(where, params, 'entity', q);
    return paged(core, q, {
      from: "entities t LEFT JOIN activation act ON act.owner_kind = 'entity' AND act.owner_id = t.id", where, params,
      order: 'act.b_cache IS NULL, act.b_cache DESC, t.last_mention_at DESC, t.id DESC', select: 't.*, act.b_cache AS b, act.tier AS tier',
      map: (e) => ({ ref: refOf('entity', e.id), kind: e.kind, id: e.id, status: e.status, name: e.display_name, isSelf: !!e.is_self, closeness: e.closeness,
        authority: e.authority, lastMentionAt: e.last_mention_at, mentionDays: e.mention_days, b: e.b ?? null, tier: e.tier ?? null, state: supOf(core, 'entity', e.id) }),
    });
  },
  settings(core, q) {
    return paged(core, q, {
      from: 'settings t LEFT JOIN setting_snapshots ss ON ss.id = t.current_snapshot_id', where: [], params: [], order: 't.last_seen DESC',
      select: 't.*, ss.descriptor_json, ss.exposure_rank, ss.persistence_rank',
      map: (s) => {
        let mode = null;
        try { mode = modeFor(core, s.key); } catch { mode = null; }
        const rv = core.store.get('SELECT MAX(version) AS v FROM setting_rules WHERE setting_key = ?', s.key)?.v ?? null;
        // 【D111】名字从哪来、是不是真名；这里收到过多少东西、接上过几个会话（「生效：开」不等于真的有东西进来）
        const owner = typeof s.owner_label === 'string' && s.owner_label ? s.owner_label : null;
        const pc = { n: core.store.get('SELECT COUNT(*) AS n FROM percepts WHERE setting_key = ?', s.key)?.n,
          last: core.store.get('SELECT at FROM percepts WHERE setting_key = ? ORDER BY id DESC LIMIT 1', s.key)?.at };
        const sc = core.store.get('SELECT COUNT(*) AS n, MAX(bound_at) AS last FROM sessions WHERE setting_key = ?', s.key);
        let ai = null;
        try { ai = core.mods.intake.adapterInfo(core, s.key); } catch { ai = null; }
        return { key: s.key, label: s.label, adapter: s.adapter, stability: s.stability, parentKey: s.parent_key, entityId: s.entity_id,
          labelKind: owner ? 'name' : s.label_kind === 'description' ? 'description' : 'name', labelSource: owner ? 'owner' : 'adapter',
          adapterLabel: s.adapter_label ?? s.label, adapterLabelKind: s.label_kind === 'description' ? 'description' : 'name',
          adapterLabelOrigin: s.label_origin === 'platform' || s.label_origin === 'config' ? s.label_origin : null, ownerLabel: owner, ownerLabelAt: owner ? s.owner_label_at ?? null : null, hint: s.label_hint ?? null,
          adapterName: ai?.adapterName ?? null, adapterConnected: ai?.connected ?? false, quiet: ai?.quiet ?? null,
          percepts: Number(pc?.n ?? 0), lastPerceptAt: pc?.last ?? null, sessions: Number(sc?.n ?? 0), lastSessionAt: sc?.last ?? null,
          descriptor: j(s.descriptor_json), exposureRank: s.exposure_rank, persistenceRank: s.persistence_rank, mode, rulesVersion: rv,
          doNotRemember: doNotRemember(core, { settingKey: s.key }), firstSeen: s.first_seen, lastSeen: s.last_seen };
      },
    });
  },
  percepts(core, q) {
    const where = [];
    const params = [];
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    if (Number.isSafeInteger(q.entityId)) { where.push('t.actor_entity_id = ?'); params.push(q.entityId); }
    if (typeof q.kind === 'string') { where.push('t.kind = ?'); params.push(q.kind); }
    if (Number.isFinite(q.from)) { where.push('t.at >= ?'); params.push(q.from); }
    if (Number.isFinite(q.to)) { where.push('t.at <= ?'); params.push(q.to); }
    return paged(core, q, {
      from: 'percepts t', where, params, order: 't.id DESC',
      map: (p) => ({ ref: refOf('percept', p.id), id: p.id, settingKey: p.setting_key, perceivedIn: p.perceived_in, at: p.at, kind: p.kind,
        actorEntityId: p.actor_entity_id, self: !!p.actor_self, text: p.media_json ? core.mods.intake.mediaText(core, p.text, p.media_json, { who: '她' }) || null : p.text, textState: p.text_state, attentionClass: p.attention_class, visibleTo: p.visible_to,
        // addressedBy（D158）：'glance' = 结构上是旁听，第一眼按意思判断出是对她说的 / 对大家说的，抬上来的
        addressed: p.addressed, addressedBy: raisedBy(core, p.id), attention: p.attention, standing: p.standing, episodeId: p.episode_id, windowId: p.window_id, historical: !!p.historical,
        normState: p.norm_state, state: supOf(core, 'percept', p.id) }),
    });
  },
  windows(core, q) {
    const where = [];
    const params = [];
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    return paged(core, q, {
      from: 'raw_windows t', where, params, order: 't.id DESC',
      map: (w) => ({ ref: refOf('window', w.id), id: w.id, settingKey: w.setting_key, firstPercept: w.first_percept, lastPercept: w.last_percept,
        tStart: w.t_start, tEnd: w.t_end, text: w.text, state: supOf(core, 'window', w.id) }),
    });
  },
  intentions(core, q) {
    const where = [];
    const params = [];
    if (typeof q.state === 'string' && !['active', 'hidden', 'forgotten'].includes(q.state)) { where.push('t.state = ?'); params.push(q.state); }
    if (Number.isSafeInteger(q.entityId)) { where.push('t.target_entity_id = ?'); params.push(q.entityId); }
    return paged(core, q, {
      from: 'intentions t', where, params, order: 't.formed_at DESC, t.id DESC',
      map: (t) => ({ ref: refOf('intention', t.id), id: t.id, act: t.act, text: t.text, origin: t.origin, state: t.state, targetEntityId: t.target_entity_id,
        about: t.about_kind ? refOf(t.about_kind, t.about_id) : null, formedAt: t.formed_at, armedAt: t.armed_at, windowStart: t.window_start, windowEnd: t.window_end,
        executions: j(t.executions_json, []), trigger: j(t.trigger_json, {}), suppression: supOf(core, 'intention', t.id) }),
    });
  },
  discretion(core, q) {
    const where = [];
    const params = [];
    if (typeof q.kind === 'string') { where.push('t.kind = ?'); params.push(q.kind); }
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    if (Number.isFinite(q.from)) { where.push('t.at >= ?'); params.push(q.from); }
    return paged(core, q, {
      from: 'discretion_log t', where, params, order: 't.at DESC, t.id DESC',
      map: (d) => ({ id: d.id, at: d.at, kind: d.kind, settingKey: d.setting_key, ref: d.memory_kind && d.memory_id ? refOf(d.memory_kind, d.memory_id) : null,
        appraisalRef: d.appraisal_id ? `ap${d.appraisal_id}` : null, utteranceId: d.utterance_id, triggerEntityId: d.trigger_entity_id,
        subjectEntityId: d.subject_entity_id, reason: d.reason }),
    });
  },
  /** 「这一轮她心里有什么」（§13.3，D100 / D113）：工作记忆放进来的每一条（stage 1、reason working:<rule>:<origin>[:l] 的判定行）：哪条、按哪条规则、从哪儿来、有没有叮嘱。 */
  working(core, q) {
    const where = ['t.stage = 1', "t.reason LIKE 'working:%'"];
    const params = [];
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    if (Number.isFinite(q.from)) { where.push('t.at >= ?'); params.push(q.from); }
    return paged(core, q, {
      from: 'appraisals t', where, params, order: 't.at DESC, t.id DESC',
      map: (a) => {
        const parts = String(a.reason ?? '').split(':');
        const legacy = a.speak != null;
        return { id: a.id, appraisalRef: `ap${a.id}`, at: a.at, ref: refOf(a.memory_kind, a.memory_id), settingKey: a.setting_key, rule: a.rule,
          origin: legacy ? null : parts[2] ?? null, limited: legacy ? parts.at(-1) === 'r' : parts[3] === 'l', legacy,
          taint: !!a.taint, triggerClass: a.trigger_class, reason: a.reason };
      },
    });
  },
  /**
   * 「被拦下的话」（§13.3，D113）：没说出口的每一句（utterances.verdict ≠ speak），只写依据，不显示原文：
   * basis = guard（外发守护 G1 / G2，带条目和类型）/ public（目标现在是公开的：审视、公开底线、挂起……）/ legacy（D113 以前的旧规则：
   * 底线 P1–P3、送审改口……，以及非公开目标上守护以外的一切拒绝——D113 起那里只有守护）/ error。
   * 过滤：basis、from（毫秒）、settingKey。
   */
  blocked(core, q) {
    const where = ["t.verdict <> 'speak'"];
    const params = [];
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    if (Number.isFinite(q.from)) { where.push('t.at >= ?'); params.push(q.from); }
    // 公开不公开按目标场合现在的属性算（评审：D113 以前 QQ 群里审视判的「先不说」不是公开渠道的挂起；D113 起非公开目标只有守护，
    // 那里守护以外的拒绝都是旧规则留下的）。读不到的目标（setting_key 为空）D113 起只有会留下来的才走公开路径，按公开算
    const pub = publicKeys(core);
    const ph = pub.length ? pub.map(() => '?').join(',') : null;
    const isPub = ph ? `(t.setting_key IS NULL OR t.setting_key IN (${ph}))` : 't.setting_key IS NULL';
    const legacyMark = `(t.reasons_json LIKE '%"floor:%' OR t.reasons_json LIKE '%"rewrite"%' OR t.reasons_json LIKE '%"touches"%' OR t.reasons_json LIKE '%"ledger-truncated"%')`;
    const notGuard = `t.reasons_json NOT LIKE '%"guard:%'`;
    const notError = `t.reasons_json NOT LIKE '%"error"%'`;
    if (q.basis === 'guard') where.push(`t.reasons_json LIKE '%"guard:%'`);
    else if (q.basis === 'error') where.push(`${notGuard} AND NOT ${legacyMark} AND t.reasons_json LIKE '%"error"%'`);
    else if (q.basis === 'legacy') { where.push(`${notGuard} AND (${legacyMark} OR (${notError} AND NOT ${isPub}))`); params.push(...pub); }
    else if (q.basis === 'public') { where.push(`${notGuard} AND NOT ${legacyMark} AND ${notError} AND ${isPub}`); params.push(...pub); }
    // current = 除旧规则以外的全部（守护、公开、出错）：管理页默认只列这些，旧规则的折叠成一行（D119）
    else if (q.basis === 'current') { where.push(`(t.reasons_json LIKE '%"guard:%' OR (NOT ${legacyMark} AND (t.reasons_json LIKE '%"error"%' OR ${isPub})))`); params.push(...pub); }
    if (q.verdict === 'hold' || q.verdict === 'reconsider') { where.push('t.verdict = ?'); params.push(q.verdict); }
    const pubSet = new Set(pub);
    return paged(core, q, {
      from: 'utterances t', where, params, order: 't.at DESC, t.id DESC',
      map: (u) => {
        const reasons = j(u.reasons_json, []);
        const rs = Array.isArray(reasons) ? reasons.map(String) : [];
        const guard = rs.find((r) => r.startsWith('guard:')) ?? null;
        const marked = rs.some((r) => r.startsWith('floor:') || ['rewrite', 'touches', 'ledger-truncated'].includes(r));
        const publicTarget = u.setting_key == null || pubSet.has(u.setting_key);
        const basis = guard ? 'guard' : marked ? 'legacy' : rs.includes('error') ? 'error' : publicTarget ? 'public' : 'legacy';
        const ref = rs.find((r) => parseRef(r)) ?? null;
        return { id: u.id, at: u.at, settingKey: u.setting_key, homeSettingKey: u.home_setting_key, verdict: u.verdict, holdStatus: u.hold_status,
          basis, kind: guard ? guard.slice(6) : null, ref, reasons: rs.filter((r) => !parseRef(r)).slice(0, 8), tainted: rs.includes('turn-tainted') };
      },
    });
  },
  /**
   * 「她在守的叮嘱」（§13.3，D113）：discretion.explicitLimit 认的条目（核对过原话的叮嘱、点了名的名单、主人收紧过的）。
   * 主人可以 admin.relaxLimit 解除。只列感知和规范里有限制的行，最多看 500 行。
   */
  limits(core, q) {
    const refs = new Set();
    for (const r of core.store.all("SELECT percept_id AS id FROM glances WHERE state = 'done' AND quote_ok = 1 AND limit_kind IN ('soft','strict') ORDER BY percept_id DESC LIMIT 500")) refs.add(refOf('percept', r.id));
    for (const r of core.store.all("SELECT owner_kind, owner_id FROM flow_norms WHERE restriction <> 'none' OR allow_json IS NOT NULL OR deny_json IS NOT NULL ORDER BY updated_at DESC LIMIT 500")) {
      try { refs.add(refOf(r.owner_kind, r.owner_id)); } catch { /* 不认识的种类 */ }
    }
    const all = [];
    for (const ref of refs) {
      let lim = null;
      try { lim = core.mods.discretion.explicitLimit(core, parseRef(ref)); } catch { lim = null; }
      if (!lim) continue;
      all.push({ ref, kind: lim.kind, quote: lim.quote ?? null, by: lim.by ?? null, deny: lim.deny ?? [], suppressed: supOf(core, parseRef(ref).kind, parseRef(ref).id) });
    }
    all.sort((a, b) => Number(b.ref.slice(1).replace(/\D/g, '')) - Number(a.ref.slice(1).replace(/\D/g, '')));
    const { limit, offset } = pageArgs(core, q);
    return { items: all.slice(offset, offset + limit), total: all.length, next: nextOf(offset, limit, all.length) };
  },
  /** 「想起来但被代码拦下」（§13.3，D102）：第二段模型自己的结论和最后落下的结论不一样的判定（model_verdict ≠ verdict），带每一步底线。 */
  floorOverrides(core, q) {
    const where = ['t.stage = 2', 't.model_verdict IS NOT NULL', 't.model_verdict <> t.verdict'];
    const params = [];
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    if (Number.isFinite(q.from)) { where.push('t.at >= ?'); params.push(q.from); }
    return paged(core, q, {
      from: 'appraisals t', where, params, order: 't.at DESC, t.id DESC',
      map: (a) => ({ id: a.id, appraisalRef: `ap${a.id}`, at: a.at, ref: refOf(a.memory_kind, a.memory_id), settingKey: a.setting_key, rule: a.rule,
        modelVerdict: a.model_verdict, verdict: a.verdict, floors: j(a.floors_json, []), taint: !!a.taint, triggerClass: a.trigger_class, reason: a.reason }),
    });
  },
  injections(core, q) {
    const where = [];
    const params = [];
    if (typeof q.sessionId === 'string') { where.push('t.session_id = ?'); params.push(q.sessionId); }
    if (typeof q.settingKey === 'string') { where.push('t.setting_key = ?'); params.push(q.settingKey); }
    return paged(core, q, {
      from: 'injections t', where, params, order: 't.ts DESC, t.id DESC',
      map: (i) => ({ id: i.id, ts: i.ts, sessionId: i.session_id, cycle: i.cycle, settingKey: i.setting_key, layer: i.layer, items: j(i.items_json, []),
        chars: i.chars, scores: j(i.scores_json), degradeLevel: i.degrade_level, routeMs: j(i.route_ms_json), mode: i.mode, seen: !!i.seen }),
    });
  },
  utterances(core, q) {
    const where = [];
    const params = [];
    if (typeof q.holdStatus === 'string') { where.push('t.hold_status = ?'); params.push(q.holdStatus); }
    if (typeof q.verdict === 'string') { where.push('t.verdict = ?'); params.push(q.verdict); }
    return paged(core, q, {
      from: 'utterances t', where, params, order: 't.at DESC, t.id DESC',
      map: (u) => ({ id: u.id, token: u.token, at: u.at, settingKey: u.setting_key, homeSettingKey: u.home_setting_key, formHint: u.form_hint,
        channel: j(u.channel_json, {}), originPath: u.origin_path, verdict: u.verdict, reflection: u.reflection, reasons: j(u.reasons_json, []),
        heldText: u.held_text, holdStatus: u.hold_status, outcome: u.outcome, attempts: u.attempts }),
    });
  },
  review(core, q) {
    const all = listReview(core, { status: q.status, kind: q.kind });
    const { limit, offset } = pageArgs(core, q);
    return { items: all.slice(offset, offset + limit), total: all.length, next: nextOf(offset, limit, all.length) };
  },
  needToKnow(core, q) {
    const all = listNeedToKnow(core, { status: q.status });
    const { limit, offset } = pageArgs(core, q);
    return { items: all.slice(offset, offset + limit), total: all.length, next: nextOf(offset, limit, all.length) };
  },
  rules(core, q) {
    if (q.includeRevoked !== true) {
      const kinds = typeof q.kind === 'string' ? [q.kind] : ['do_not_remember', 'disclosure', 'mode'];
      const all = kinds.flatMap((k) => activeRules(core, k));
      const { limit, offset } = pageArgs(core, q);
      return { items: all.slice(offset, offset + limit), total: all.length, next: nextOf(offset, limit, all.length) };
    }
    const where = [];
    const params = [];
    if (typeof q.kind === 'string') { where.push('t.kind = ?'); params.push(q.kind); }
    return paged(core, q, {
      from: 'rules t', where, params, order: 't.id DESC',
      map: (r) => ({ id: r.id, kind: r.kind, target: j(r.target_json, {}), value: j(r.value_json), createdBy: r.created_by, at: r.at, revokedAt: r.revoked_at, note: r.note }),
    });
  },
  suppressed(core, q) {
    const where = [];
    const params = [];
    if (q.state === 'hidden' || q.state === 'forgotten') { where.push('t.state = ?'); params.push(q.state); }
    const now = core.now();
    return paged(core, q, {
      from: 'suppressions t', where, params, order: 't.at DESC',
      map: (s) => ({ ref: refOf(s.owner_kind, s.owner_id), state: s.state, by: s.by, reason: s.reason, at: s.at, restoreUntil: s.restore_until,
        restorable: s.state === 'hidden' || s.restore_until == null || now <= s.restore_until }),
    });
  },
  /**
   * 【D122】夜里对照原话核对过的事实（管理页「记忆 → 夜里改过的」）。changed=true（默认）只列改了的（改正、变了、降低把握）。
   * 文字从事实表取（核对表不抄文字）：before = 核对的那一版，after = 改正 / 降低把握之后的那一版；证据只给最多 3 句原话；
   * 主人撤销过的带 reverted（恢复成的那一版），能撤销的标 revertable。
   */
  checks(core, q) {
    const where = [];
    const params = [];
    if (q.changed !== false) where.push("t.verdict IN ('corrected','changed','doubted')");
    const ev = core.store.prepare('SELECT id, at, setting_key, actor_entity_id, actor_self, text FROM percepts WHERE id = ?');
    const fact = core.store.prepare('SELECT id, text, certainty, confidence, superseded_by FROM assertions WHERE id = ?');
    const factOf = (id) => {
      const a = id == null ? null : fact.get(id);
      return a ? { ref: refOf('assertion', a.id), text: a.text, certainty: a.certainty, confidence: a.confidence, current: a.superseded_by == null } : null;
    };
    return paged(core, q, {
      from: 'memory_checks t', where, params, order: 't.at DESC, t.id DESC',
      map: (c) => ({
        id: c.id, at: c.at, verdict: c.verdict, why: c.why, streak: c.streak, nextAt: c.next_at, beforeConf: c.before_conf, afterConf: c.after_conf,
        // D157：清查收回的（她凭记忆答的话被记成别人的事实）：记成降低把握、把握 0、没有新版本
        withdrawn: c.verdict === 'doubted' && c.result_id == null && c.after_conf === 0,
        before: factOf(c.assertion_id), after: factOf(c.result_id),
        // 主人撤销过（D122 评审）：旧版本按确认过恢复成的那一版
        reverted: c.reverted_at != null ? { at: c.reverted_at, by: c.reverted_by, restored: factOf(c.restored_id) } : null,
        revertable: c.reverted_at == null && ['corrected', 'changed', 'doubted'].includes(c.verdict),
        evidence: j(c.evidence_json, []).slice(0, 3).map((pid) => ev.get(pid)).filter(Boolean)
          .map((p) => ({ ref: refOf('percept', p.id), at: p.at, settingKey: p.setting_key, actorEntityId: p.actor_entity_id, self: !!p.actor_self, text: p.text })),
      }),
    });
  },
  tombstones(core, q) {
    return paged(core, q, { from: 'tombstones t', where: [], params: [], order: 't.id DESC', map: (t) => ({ id: t.id, kind: t.kind, ref: t.ref, at: t.at }) });
  },
  backups(core, q) {
    const where = ['t.deleted_at IS NULL'];
    const params = [];
    if (typeof q.kind === 'string') { where.push('t.kind = ?'); params.push(q.kind); }
    return paged(core, q, {
      from: 'backups t', where, params, order: 't.created_at DESC, t.id DESC',
      map: (b) => ({ id: b.id, kind: b.kind, reason: b.reason, location: b.location, path: b.path, createdAt: b.created_at, size: b.size, sha256: b.sha256,
        schemaVersion: b.schema_version, includesVectors: !!b.includes_vectors, encrypted: !!b.encrypted, verifyStatus: b.verify_status, verifiedAt: b.verified_at }),
    });
  },
  drills(core, q) {
    return paged(core, q, { from: 'restore_drills t', where: [], params: [], order: 't.at DESC, t.id DESC',
      map: (d) => ({ id: d.id, at: d.at, backupId: d.backup_id, ok: d.status === 'ok', sampled: d.sampled, found: d.found, error: d.error }) });
  },
};
const ALIASES = { memories: null, people: 'entities', experiences: 'percepts', forgotten: 'suppressed', holds: 'utterances' };

/**
 * @param {object} core
 * @param {{view: string, [k: string]: unknown}} q
 * @returns {import('../contract/types.js').Page}
 */
export function list(core, q) {
  if (!q || typeof q.view !== 'string') throw bad('admin.list', 'view', `应为 ${[...Object.keys(VIEWS), ...Object.keys(ALIASES)].join(' / ')}`);
  let view = q.view;
  if (view === 'memories') view = q.kind === 'episode' ? 'episodes' : 'assertions';
  else if (Object.hasOwn(ALIASES, view)) view = ALIASES[view];
  if (!Object.hasOwn(VIEWS, view)) throw bad('admin.list', 'view', `不认识的列表：${q.view}`);
  const opts = { ...q };
  if (q.view === 'forgotten' && !opts.state) opts.state = 'forgotten';
  if (q.view === 'holds' && !opts.holdStatus) opts.holdStatus = 'pending';
  return VIEWS[view](core, opts);
}

// ── 一条的详情 ────────────────────────────────────────────────────────────

function sourcesOf(core, kind, id) {
  return core.store.all('SELECT * FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY at, id', kind, id).map((s) => {
    const p = s.percept_id ? core.store.get('SELECT text, at, setting_key, text_state, media_json FROM percepts WHERE id = ?', s.percept_id) : null;
    if (p?.media_json) p.text = core.mods.intake.mediaText(core, p.text, p.media_json, { who: '她' }) || null;
    return { perceptId: s.percept_id, settingKey: s.perceived_in, snapshotId: s.snapshot_id, speaker: s.speaker, asserter: s.asserter, mode: s.mode, hop: s.hop,
      quote: s.quote, confidence: s.confidence, usedBackground: j(s.used_bg_json, []), at: s.at, percept: p ? { text: p.text, at: p.at, settingKey: p.setting_key, textState: p.text_state } : null };
  });
}

function versionChain(core, id) {
  const chain = [];
  const seen = new Set();
  let cur = core.store.get('SELECT id, supersedes FROM assertions WHERE id = ?', id);
  while (cur?.supersedes && !seen.has(cur.supersedes)) { seen.add(cur.supersedes); cur = core.store.get('SELECT id, supersedes FROM assertions WHERE id = ?', cur.supersedes); if (cur) chain.unshift(cur.id); }
  chain.push(id);
  cur = core.store.get('SELECT superseded_by FROM assertions WHERE id = ?', id);
  while (cur?.superseded_by && !seen.has(cur.superseded_by)) { seen.add(cur.superseded_by); chain.push(cur.superseded_by); cur = core.store.get('SELECT superseded_by FROM assertions WHERE id = ?', cur.superseded_by); }
  return chain.map((x) => {
    const a = core.store.get('SELECT id, text, recorded_at, valid_from, valid_to_known, expired_at FROM assertions WHERE id = ?', x);
    return a ? { ref: refOf('assertion', a.id), text: a.text, recordedAt: a.recorded_at, validFrom: a.valid_from, validToKnown: a.valid_to_known, expiredAt: a.expired_at } : null;
  }).filter(Boolean);
}

/**
 * 一条的详情：来源链、流动规范、谁知道、告诉过谁、版本链、同类的其他几次、注入过它的会话、隐藏状态、激活。
 * 被彻底删除的返回 {ref, purged: true, at}；没有的返回 null。
 */
export function get(core, ref) {
  const m = parseRef(ref);
  if (!m) throw bad('admin.get', 'ref', '应为记忆引用');
  const row = core.store.get(`SELECT * FROM ${OWNER_TABLES[m.kind]} WHERE id = ?`, m.id);
  if (!row) {
    const t = core.store.get('SELECT at FROM tombstones WHERE kind = ? AND ref = ?', m.kind, ref);
    return t ? { ref, kind: m.kind, purged: true, at: t.at } : null;
  }
  let norm = null;
  try { norm = core.mods.discretion.normOf(core, m); } catch {
    const n = core.store.get('SELECT * FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
    norm = n ? { unassessed: false, version: n.version, restriction: n.restriction, allow: j(n.allow_json), deny: j(n.deny_json), restrictionQuote: n.restriction_quote,
      attribute: n.attribute, sensitivity: n.sensitivity, involvesOthers: !!n.involves_others, identityLink: !!n.identity_link, summary: n.summary,
      originExposure: j(n.origin_exposure_json, {}), settingRuleRef: n.setting_rule_ref, settingRuleVersion: n.setting_rule_version } : { unassessed: true };
  }
  const sup = core.store.get('SELECT state, by, reason, at, restore_until FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
  const act = core.store.get('SELECT * FROM activation WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
  // 她看过的媒体（D116）：管理页显示的文字带上她看到的（「［视频，她看到的：…］」），另给结构化的一项
  const seen = m.kind === 'percept' && row.media_json ? core.mods.intake.seenMedia(core, row.media_json) : null;
  const out = {
    ref, kind: m.kind, id: m.id, row: seen ? { ...row, text: core.mods.intake.mediaText(core, row.text, row.media_json, { who: '她' }) } : row,
    ...(seen ? { mediaSeen: seen } : {}),
    norm,
    knownBy: core.store.all('SELECT who_kind, who_ref, since, basis, at FROM known_by WHERE owner_kind = ? AND owner_id = ? ORDER BY since', m.kind, m.id)
      .map((k) => ({ whoKind: k.who_kind, whoRef: k.who_ref, since: k.since, basis: k.basis, at: k.at })),
    told: core.store.all('SELECT at, setting_key, presence_set_id, utterance_percept_id, level FROM told_log WHERE owner_kind = ? AND owner_id = ? ORDER BY at', m.kind, m.id)
      .map((t) => ({ at: t.at, settingKey: t.setting_key, presenceSetId: t.presence_set_id, utterancePerceptId: t.utterance_percept_id, level: t.level })),
    suppression: sup ? { state: sup.state, by: sup.by, reason: sup.reason, at: sup.at, restoreUntil: sup.restore_until } : null,
    activation: act ? { traceCount: act.trace_count, lastTraceAt: act.last_trace_at, b: act.b_cache, tier: act.tier } : null,
    traces: core.store.all('SELECT t, w, d, reason FROM traces WHERE owner_kind = ? AND owner_id = ? ORDER BY t', m.kind, m.id),
    injectedIn: core.store.all(`SELECT DISTINCT i.session_id AS sessionId, max(i.ts) AS lastAt FROM injections i, json_each(i.items_json) x
                                WHERE json_extract(x.value, '$.id') = ? GROUP BY i.session_id ORDER BY lastAt DESC`, ref),
  };
  if (m.kind === 'assertion' || m.kind === 'episode' || m.kind === 'intention') out.sources = sourcesOf(core, m.kind, m.id);
  if (m.kind === 'assertion') {
    out.entities = core.store.all('SELECT entity_id AS entityId, role FROM assertion_entities WHERE assertion_id = ?', m.id);
    out.versions = versionChain(core, m.id);
    out.sameType = core.store.all('SELECT CASE WHEN a = ? THEN b ELSE a END AS other FROM same_type WHERE a = ? OR b = ?', m.id, m.id, m.id)
      .map((r) => { const a = core.store.get('SELECT id, text, event_start, recorded_at FROM assertions WHERE id = ?', r.other); return a ? { ref: refOf('assertion', a.id), text: a.text, eventStart: a.event_start, recordedAt: a.recorded_at } : null; })
      .filter(Boolean);
    out.planHistory = core.store.all('SELECT status, at, evidence_percept AS evidencePercept FROM plan_status_history WHERE assertion_id = ? ORDER BY at, id', m.id);
  }
  if (m.kind === 'entity') {
    out.names = core.store.all('SELECT text_raw AS text, used_by AS usedBy, scope_setting_key AS scope, reserved, count, first, last FROM entity_names WHERE entity_id = ? ORDER BY count DESC', m.id);
    out.descriptors = core.store.all('SELECT anchor_entity_id AS anchor, relation, text, created_at AS at FROM entity_descriptors WHERE entity_id = ?', m.id);
    out.identity = core.store.all('SELECT namespace, scope, id_hash AS idHash, strength, created_at AS at FROM identity_evidence WHERE entity_id = ?', m.id);
    out.links = core.store.all('SELECT id, a, b, rel, confidence, decided_by AS decidedBy, cross_namespace AS crossNamespace, at FROM entity_links WHERE a = ? OR b = ?', m.id, m.id)
      .map((l) => ({ ...l, ref: refOf('link', l.id), rights: l.rel === 'same' && ['platform', 'mutual-claim', 'anchor-confirmed', 'owner'].includes(l.decidedBy) }));
    out.impressions = core.store.all('SELECT id, layer, text, version, is_current AS isCurrent, built_at AS builtAt FROM entity_impressions WHERE entity_id = ? ORDER BY layer, version DESC', m.id);
  }
  if (m.kind === 'percept') {
    out.derived = core.store.all('SELECT owner_kind AS k, owner_id AS id FROM sources WHERE percept_id = ? GROUP BY owner_kind, owner_id', m.id).map((r) => refOf(r.k, r.id));
    out.windows = core.store.all('SELECT id FROM raw_windows WHERE setting_key = ? AND first_percept <= ? AND last_percept >= ?', row.setting_key, m.id, m.id).map((w) => refOf('window', w.id));
  }
  return out;
}
