// 【D171】管理页「记忆」这一路的两个只读视图：
//   - feed：事实、经历、打算、经验按时间混排的一个列表（「全部」类型），游标翻页，筛选和单种列表同一套口径；
//   - people：人物卡片（一个人一项，D161 的分组；名下有多少条、最近一次出现、一句印象），给 id 时是一个人的详情（各档案的名字、关系、印象、链接）。
// 口径不另起一套：每一种的条件、时间列、搜索、取出来的形状都直接用 views.js 里那个列表的 spec（assertions / episodes / intentions / lessons，
// 带 SPEC_ONLY 拿条件不取行），时间筛选和搜索用 timeline.js 的 scopeOf（D159），按人筛用 entityFilter（D161，连同他名下全部档案）。
// 只读：只有 SELECT，只读库也能用。SQL 一律参数化。
import { ContractError } from '../contract/errors.js';
import { scopeOf, dayCounts, limitOf, tzOf } from './timeline.js';
import { LIST_VIEWS, SPEC_ONLY, entityFilter, personGroups } from './views.js';

const bad = (path, message) => new ContractError('admin.feed', [{ path, message }]);

/** 混排的四种（页面的「全部」）。顺序也是同一时刻里的次序。 */
export const FEED_KINDS = Object.freeze(['fact', 'episode', 'intent', 'lesson']);
const RANK = { fact: 0, episode: 1, intent: 2, lesson: 3 };
const OWNER = { fact: 'assertion', episode: 'episode', intent: 'intention', lesson: 'assertion' };
/** 状态：shown = 没忘掉的（隐藏的照列，带标记；默认）/ active = 没隐藏也没忘掉 / hidden / forgotten / all。 */
export const FEED_STATES = Object.freeze(['shown', 'active', 'hidden', 'forgotten', 'all']);
/** 版本（事实和经验才有）：current = 现在这一版（默认）/ all = 连旧版本 / old = 只看被取代的旧版本（只剩事实和经验两种）。 */
export const FEED_VERSIONS = Object.freeze(['current', 'all', 'old']);

function optsOf(q) {
  const kinds = q.kinds == null ? [...FEED_KINDS] : Array.isArray(q.kinds) ? [...new Set(q.kinds)] : null;
  if (!kinds || !kinds.length || kinds.some((k) => !FEED_KINDS.includes(k))) throw bad('kinds', `应为 ${FEED_KINDS.join(' / ')} 的非空数组`);
  const state = q.state == null ? 'shown' : q.state;
  if (!FEED_STATES.includes(state)) throw bad('state', `应为 ${FEED_STATES.join(' / ')}`);
  const versions = q.versions == null ? 'current' : q.versions;
  if (!FEED_VERSIONS.includes(versions)) throw bad('versions', `应为 ${FEED_VERSIONS.join(' / ')}`);
  const order = q.order == null ? 'desc' : q.order;
  if (order !== 'desc' && order !== 'asc') throw bad('order', '应为 desc / asc');
  return {
    kinds, state, versions, order,
    lessonStatus: q.lessonStatus === 'verified' || q.lessonStatus === 'unverified' ? q.lessonStatus : null,
    entityId: Number.isSafeInteger(q.entityId) ? q.entityId : null,
    settingKey: typeof q.settingKey === 'string' && q.settingKey ? q.settingKey : null,
  };
}

/** 状态条件（suppressions 的主键是 (owner_kind, owner_id)：一次主键查找）。 */
function stateWhere(spec, okind, state) {
  const sub = `SELECT 1 FROM suppressions s WHERE s.owner_kind = '${okind}' AND s.owner_id = t.id`;
  if (state === 'shown') spec.where.push(`NOT EXISTS (${sub} AND s.state = 'forgotten')`);
  else if (state === 'active') spec.where.push(`NOT EXISTS (${sub})`);
  else if (state === 'hidden' || state === 'forgotten') { spec.where.push(`EXISTS (${sub} AND s.state = ?)`); spec.params.push(state); }
}

/** 这一次要合并的几路：{kind, spec}。spec 就是那个单种列表的 spec，再加上混排要的条件。 */
function sourcesOf(core, o) {
  const base = { [SPEC_ONLY]: true };
  const who = o.entityId != null ? { entityId: o.entityId } : {};
  const out = [];
  const want = (k) => o.kinds.includes(k);
  if (want('fact')) {
    const s = LIST_VIEWS.assertions(core, { ...base, ...who, ...(o.settingKey ? { settingKey: o.settingKey } : {}), ...(o.versions === 'current' ? { current: true } : {}) });
    s.where.push("(t.kind_hint IS NULL OR t.kind_hint <> 'lesson')");
    if (o.versions === 'old') s.where.push('t.superseded_by IS NOT NULL');
    stateWhere(s, 'assertion', o.state);
    out.push({ kind: 'fact', spec: s });
  }
  if (want('episode') && o.versions !== 'old') {
    const s = LIST_VIEWS.episodes(core, { ...base, ...who, ...(o.settingKey ? { settingKey: o.settingKey } : {}) });
    stateWhere(s, 'episode', o.state);
    out.push({ kind: 'episode', spec: s });
  }
  // 打算没有场合（intentions 表不记）：按场合筛时不列
  if (want('intent') && o.versions !== 'old' && !o.settingKey) {
    const s = LIST_VIEWS.intentions(core, { ...base, ...who });
    s.search = { textSql: "coalesce(t.text, '')", fts: null };
    stateWhere(s, 'intention', o.state);
    out.push({ kind: 'intent', spec: s });
  }
  if (want('lesson')) {
    const s = LIST_VIEWS.lessons(core, { ...base, all: o.versions !== 'current', ...(o.lessonStatus ? { status: o.lessonStatus } : {}) });
    if (o.versions === 'old') s.where.push('t.superseded_by IS NOT NULL');
    entityFilter(core, s.where, s.params, who, (ph) => `t.id IN (SELECT assertion_id FROM assertion_entities WHERE entity_id IN (${ph}))`);
    if (o.settingKey) { s.where.push("t.id IN (SELECT owner_id FROM sources WHERE owner_kind = 'assertion' AND perceived_in = ?)"); s.params.push(o.settingKey); }
    s.search = { textSql: 't.text', fts: 'assertions_fts' };
    stateWhere(s, 'assertion', o.state);
    out.push({ kind: 'lesson', spec: s });
  }
  return out;
}

/** 一路在时间范围、搜索之下的全部条件（timeline 的 scopeOf；按时间排时搜索命中当 WHERE 条件）。 */
function scoped(core, q, src) {
  const sc = scopeOf(core, q, src.spec);
  if (sc.found) { sc.where.push(sc.found.cond); sc.params.push(...sc.found.args); }
  return { ...src, where: sc.where, params: sc.params };
}

/**
 * 一路往一个方向取的 SQL：up = 时间变大的方向。bound = {t, k, i}（合并后的次序是 (时间, 种类次序, id)，不含 bound 本身）。
 * 种类次序在一路里是常数，所以条件化成只比时间和 id 的形式，时间那一半能走索引。
 */
function seekSql(src, up, bound, n) {
  const T = src.spec.time;
  const conds = [...src.where];
  const args = [...src.params];
  if (bound) {
    const k = RANK[src.kind];
    const gt = up ? '>' : '<';
    if (k === bound.k) { conds.push(`${T} ${gt}= ? AND (${T} ${gt} ? OR t.id ${gt} ?)`); args.push(bound.t, bound.t, bound.i); }
    // 比边界那一条种类次序「靠后」的：同一时刻的都算在边界之后
    else if ((k > bound.k) === up) { conds.push(`${T} ${gt}= ?`); args.push(bound.t); }
    else { conds.push(`${T} ${gt} ?`); args.push(bound.t); }
  }
  const d = up ? 'ASC' : 'DESC';
  return { sql: `SELECT ${src.spec.select ?? '*'}, ${T} AS _t, t.id AS _k FROM ${src.spec.from} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${T} ${d}, t.id ${d} LIMIT ?`, args: [...args, n] };
}

const cmpUp = (a, b) => (a._t - b._t) || (RANK[a._kind] - RANK[b._kind]) || (a._k - b._k);
/** 几路一起往一个方向取 n 条（每路取 n 条再合并，按那个方向排好）。 */
function take(core, srcs, up, bound, n) {
  const all = [];
  for (const s of srcs) {
    const { sql, args } = seekSql(s, up, bound, n);
    for (const r of core.store.all(sql, ...args)) { r._kind = s.kind; r._src = s; all.push(r); }
  }
  all.sort(up ? cmpUp : (a, b) => cmpUp(b, a));
  return all.slice(0, n);
}
const keyOf = (r) => ({ t: Number(r._t), k: RANK[r._kind], i: Number(r._k) });
const enc = (r, d) => { const k = keyOf(r); return Buffer.from(JSON.stringify({ v: 2, t: k.t, k: k.k, i: k.i, d })).toString('base64url'); };
function dec(s, d) {
  if (typeof s !== 'string' || !s || s.length > 400) return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return c && c.v === 2 && c.d === d && Number.isFinite(c.t) && Number.isInteger(c.k) && Number.isFinite(c.i) ? { t: c.t, k: c.k, i: c.i } : null;
  } catch { return null; }
}

/** 一行 → 页面要的形状（四种同一套字段，各自多几样）。 */
function shape(core, r, stmts) {
  const x = r._src.spec.map(r);
  const kind = r._kind;
  if (kind === 'fact') {
    const s = stmts.firstSource.get(x.id);
    const subjects = (x.entities ?? []).filter((e) => e.role === 'subject').map((e) => e.entityId);
    return { ref: x.ref, kind, id: x.id, text: x.text, at: x.recordedAt, who: s?.speaker ?? subjects[0] ?? null, settingKey: s?.perceived_in ?? null, subjects: subjects.slice(0, 6),
      certainty: x.certainty, confidence: x.confidence, supersededBy: x.supersededBy ?? null, expiredAt: x.expiredAt ?? null, planStatus: x.planStatus ?? null,
      needsReview: !!x.needsReview, pinned: !!x.pinned, kindHint: x.kindHint ?? null, state: x.state ?? null };
  }
  if (kind === 'episode') {
    return { ref: x.ref, kind, id: x.id, text: x.title || x.narrative || '', title: x.title ?? null, narrative: x.narrative ?? null, epKind: x.epKind, at: x.tEnd, tStart: x.tStart,
      settingKey: x.settingKey ?? null, participants: (Array.isArray(x.participants) ? x.participants : []).filter(Number.isSafeInteger).slice(0, 8), state: x.state ?? null };
  }
  if (kind === 'intent') {
    return { ref: x.ref, kind, id: x.id, text: x.text || x.act || '', act: x.act, at: x.formedAt, who: x.targetEntityId ?? null, intentState: x.state, until: x.windowEnd ?? null,
      executions: Array.isArray(x.executions) ? x.executions.length : 0, state: x.suppression ?? null };
  }
  return { ref: x.ref, kind, id: x.id, text: x.text, at: x.updatedAt, status: x.status, origin: x.origin ?? null, how: x.how ?? null, tool: x.tool ?? null, settingKey: x.settingKey ?? null,
    trap: x.trap ?? null, confirmable: !!x.confirmable, supersededBy: x.supersededBy ?? null, about: (x.about ?? []).slice(0, 6), state: x.state ?? null };
}

/** 用到的场合和人的名字（和首页同一种形状：只给用到的，不列全表）。 */
export function namesOf(core, items) {
  const keys = new Set();
  const ids = new Set();
  for (const m of items) {
    if (m.settingKey) keys.add(m.settingKey);
    for (const id of [m.who, ...(m.participants ?? []), ...(m.subjects ?? []), ...(m.about ?? [])]) if (Number.isSafeInteger(id)) ids.add(id);
  }
  const settings = {};
  const sq = core.store.prepare('SELECT key, label, label_kind, label_hint, owner_label FROM settings WHERE key = ?');
  for (const k of keys) {
    const r = sq.get(k);
    if (!r) continue;
    const owner = typeof r.owner_label === 'string' && r.owner_label ? r.owner_label : null;
    settings[k] = { label: owner ?? r.label ?? '', labelKind: owner ? 'name' : r.label_kind === 'description' ? 'description' : 'name', hint: r.label_hint ?? null };
  }
  const names = {};
  const eq = core.store.prepare('SELECT id, display_name, is_self, authority FROM entities WHERE id = ?');
  for (const id of ids) {
    const r = eq.get(id);
    if (r) names[id] = { name: r.display_name ?? null, self: !!r.is_self, principal: r.authority === 'principal' };
  }
  return { settings, names };
}

/**
 * 【D171】合并的记忆列表（管理页「记忆」的「全部」，也用于单选一种：kinds 只给一种）。
 * q：kinds（fact / episode / intent / lesson 的数组，默认四种）、state（FEED_STATES，默认 shown）、versions（FEED_VERSIONS，默认 current）、
 *    lessonStatus、entityId（连同他名下全部档案，D161）、settingKey（打算没有场合，按场合筛时不列）、from / to（毫秒，闭区间，D159 同口径：
 *    经历和 [开始, 结束] 相交）、q（搜索，D159 的三档，按时间排）、order（desc 默认 / asc）、limit、next / prev（游标）、around（毫秒：从这一刻起往
 *    列表方向取，desc 取这一刻和更早的，asc 取这一刻和更晚的；那一边没有就退回另一边最近的）。
 * 次序：(时间, 种类次序, id)，每种用它自己列表的时间列（事实：记下的时间；经历：结束的时间；打算：想起的时间；经验：最近改过的时间）。
 * 翻页：游标是边界那一条的 (时间, 种类次序, id)，每一路按「严格在它之后」取 limit+1 条再合并，所以几种之间、同一时刻之间都不重不漏。
 * 代价：每页每一路一条按时间列走索引的查询（事实 assertions_recorded、经验 assertions_lesson_updated、经历 episodes_t_end、打算
 *    intentions_formed；迁移 023 加的三个），再加每条事实一次 sources 主键查找；total 只在第一页（没有游标）时算，每一路一次 count。
 * @returns {{items: object[], total: number|null, next?: string, prev?: string, anchor?: {at: number, side: 'before'|'after'}, order: string,
 *   kinds: string[], settings: object, names: object, readOnly: boolean}}
 */
export function feed(core, q = {}) {
  const o = optsOf(q);
  const limit = limitOf(core, q);
  const sq = { from: Number.isFinite(q.from) ? q.from : undefined, to: Number.isFinite(q.to) ? q.to : undefined, q: typeof q.q === 'string' ? q.q.slice(0, 200) : undefined };
  if (sq.from != null && sq.to != null && sq.from > sq.to) throw bad('to', '结束不能早于开始');
  const srcs = sourcesOf(core, o).map((s) => scoped(core, sq, s));
  const fwd = o.order === 'asc';   // 列表往下 = 时间变大？
  let rows;
  let next;
  let prev;
  let anchor;
  const pc = dec(q.prev, o.order);
  const nc = dec(q.next, o.order);
  if (Number.isFinite(q.around)) {
    const T = q.around;
    const virt = fwd ? { t: T, k: -1, i: -1 } : { t: T, k: 99, i: Number.MAX_SAFE_INTEGER };
    let r = take(core, srcs, fwd, virt, limit + 1);
    anchor = { at: T, side: fwd ? 'after' : 'before' };
    if (!r.length) {
      // 那一边没有：退回另一边最近的一页
      r = take(core, srcs, !fwd, virt, limit).reverse();
      anchor = { at: T, side: fwd ? 'before' : 'after' };
      rows = r;
      next = undefined;
    } else {
      rows = r.slice(0, limit);
      next = r.length > limit ? enc(rows.at(-1), o.order) : undefined;
    }
    prev = rows.length && take(core, srcs, !fwd, keyOf(rows[0]), 1).length ? enc(rows[0], o.order) : undefined;
  } else if (pc) {
    const r = take(core, srcs, !fwd, pc, limit + 1);
    rows = r.slice(0, limit).reverse();
    prev = r.length > limit ? enc(rows[0], o.order) : undefined;
    next = rows.length && take(core, srcs, fwd, keyOf(rows.at(-1)), 1).length ? enc(rows.at(-1), o.order) : undefined;
  } else {
    const r = take(core, srcs, fwd, nc, limit + 1);
    rows = r.slice(0, limit);
    next = r.length > limit ? enc(rows.at(-1), o.order) : undefined;
    prev = nc && rows.length && take(core, srcs, !fwd, keyOf(rows[0]), 1).length ? enc(rows[0], o.order) : undefined;
  }
  // total：只在第一页算（翻页时页面沿用第一页的数）
  let total = null;
  if (!pc && !nc) {
    total = 0;
    for (const s of srcs) total += Number(core.store.get(`SELECT count(*) AS n FROM ${s.spec.from} ${s.where.length ? `WHERE ${s.where.join(' AND ')}` : ''}`, ...s.params).n);
  }
  const stmts = { firstSource: core.store.prepare("SELECT perceived_in, speaker FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? ORDER BY at, id LIMIT 1") };
  const restore = core.store.prepare('SELECT restore_until FROM suppressions WHERE owner_kind = ? AND owner_id = ?');
  const items = rows.map((r) => {
    const m = shape(core, r, stmts);
    if (m.state === 'forgotten') m.restoreUntil = restore.get(OWNER[m.kind], m.id)?.restore_until ?? null;
    return m;
  });
  return { items, total, ...(next ? { next } : {}), ...(prev ? { prev } : {}), ...(anchor ? { anchor } : {}), order: o.order,
    kinds: srcs.map((s) => s.kind), ...namesOf(core, items), readOnly: !!core.readOnly };
}

/**
 * 【D171】合并列表的按天计数（「跳到某一天」的月历）：同样的条件下某个月每天几条（四种加起来），和最早、最晚一条的时间。
 * 每一路调 timeline.js 的 dayCounts（D159 同口径：有起止的算在结束那天）。
 * @param {object} q  month: 'YYYY-MM'、tzOffsetMin?，其余同 feed
 */
export function feedDays(core, q = {}) {
  const o = optsOf(q);
  if (typeof q.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw bad('month', '应为 YYYY-MM');
  const sq = { month: q.month, ...(Number.isInteger(q.tzOffsetMin) ? { tzOffsetMin: q.tzOffsetMin } : {}),
    from: Number.isFinite(q.from) ? q.from : undefined, to: Number.isFinite(q.to) ? q.to : undefined, q: typeof q.q === 'string' ? q.q.slice(0, 200) : undefined };
  const by = new Map();
  let first = null;
  let last = null;
  for (const s of sourcesOf(core, o)) {
    const d = dayCounts(core, sq, s.spec);
    for (const x of d.items) by.set(x.day, (by.get(x.day) ?? 0) + x.n);
    if (d.first != null && (first == null || d.first < first)) first = d.first;
    if (d.last != null && (last == null || d.last > last)) last = d.last;
  }
  return { items: [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, n]) => ({ day, n })), first, last, tzOffsetMin: tzOf(core, sq, Date.now()) };
}

/** 测试用：第一页每一路的查询（看 EXPLAIN QUERY PLAN 走不走索引）。 */
export function feedPlan(core, q = {}) {
  const o = optsOf(q);
  return sourcesOf(core, o).map((s) => scoped(core, {}, s)).map((s) => ({ kind: s.kind, ...seekSql(s, o.order === 'asc', null, limitOf(core, q) + 1) }));
}

// ── 人物 ─────────────────────────────────────────────────────────────────

/**
 * 【D171】人物卡片：一个人一项（D161 的分组，和选人、按人筛同一套），不含她自己、不含场合。每项：
 *   id（代表档案）、name、aliases（也叫…）、kind、principal（是不是主人）、members、n（名下记忆条数：事实、经历、打算，和按人筛的「全部」同口径，
 *   不含忘掉的）、lastAt（组里最近一次被提到）、impression（一句现在的印象，大家都知道的优先）。
 * 顺序：主人在前，其余名下多的在前。给 q.id 时只给这一个人，另带 detail：每个档案的名字（在哪个场合叫什么）、关系、印象（两层）、
 * 组里的链接（same / maybe_same / not_same 和谁定的）。
 * 代价：一次扫经历的参与者（同 pickable），每组几次按 entity_id 的索引查找；最多 q.limit（默认 300，上限 1000）组。
 */
export function people(core, q = {}) {
  const cap = Math.max(1, Math.min(1000, Number.isInteger(q.limit) ? q.limit : 300));
  const groups = personGroups(core).filter((g) => !g.alive.some((r) => r.is_self));
  const ep = new Map();
  for (const r of core.store.all(`SELECT CAST(x.value AS INTEGER) AS pid, count(*) AS n FROM episodes t, json_each(t.participants_json) x
                                  WHERE NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.owner_kind = 'episode' AND s.owner_id = t.id AND s.state = 'forgotten') GROUP BY pid`)) ep.set(r.pid, Number(r.n));
  const notForgot = (k) => `NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.owner_kind = '${k}' AND s.owner_id = x.id AND s.state = 'forgotten')`;
  const one = (ids) => {
    const ph = ids.map(() => '?').join(', ');
    const facts = Number(core.store.get(`SELECT count(*) AS n FROM assertions x WHERE x.superseded_by IS NULL AND x.id IN (SELECT assertion_id FROM assertion_entities WHERE entity_id IN (${ph})) AND ${notForgot('assertion')}`, ...ids).n);
    const intents = Number(core.store.get(`SELECT count(*) AS n FROM intentions x WHERE x.target_entity_id IN (${ph}) AND ${notForgot('intention')}`, ...ids).n);
    const eps = ids.reduce((n, id) => n + (ep.get(id) ?? 0), 0);
    const lastAt = core.store.get(`SELECT max(last_mention_at) AS t FROM entities WHERE id IN (${ph})`, ...ids)?.t ?? null;
    const imp = core.store.get(`SELECT text FROM entity_impressions WHERE entity_id IN (${ph}) AND is_current = 1 ORDER BY layer = 'shared' DESC, built_at DESC LIMIT 1`, ...ids);
    return { n: facts + intents + eps, facts, episodes: eps, intents, lastAt: lastAt == null ? null : Number(lastAt), impression: imp?.text ?? null };
  };
  let rows = groups;
  if (Number.isSafeInteger(q.id)) rows = groups.filter((g) => g.members.includes(q.id));
  const items = rows.map((g) => ({ id: g.rep.id, name: g.name, aliases: g.aliases, kind: g.rep.kind, status: g.rep.status, principal: g.alive.some((r) => r.authority === 'principal'),
    members: g.members, ...one(g.members) }));
  items.sort((a, b) => Number(b.principal) - Number(a.principal) || b.n - a.n || (b.lastAt ?? 0) - (a.lastAt ?? 0) || a.id - b.id);
  const out = { items: items.slice(0, cap), total: items.length, readOnly: !!core.readOnly };
  if (Number.isSafeInteger(q.id) && items[0]) {
    const ids = items[0].members;
    const ph = ids.map(() => '?').join(', ');
    const scopes = new Set();
    const names = core.store.all(`SELECT entity_id AS entityId, text_raw AS text, scope_setting_key AS scope, count, last FROM entity_names WHERE entity_id IN (${ph}) ORDER BY count DESC, last DESC LIMIT 40`, ...ids)
      .map((r) => { if (r.scope) scopes.add(r.scope); return { entityId: r.entityId, text: r.text, scope: r.scope || null, count: Number(r.count ?? 0), last: r.last ?? null }; });
    const descriptors = core.store.all(`SELECT entity_id AS entityId, anchor_entity_id AS anchor, relation, text FROM entity_descriptors WHERE entity_id IN (${ph}) LIMIT 30`, ...ids);
    const impressions = core.store.all(`SELECT entity_id AS entityId, layer, text, version, built_at AS builtAt FROM entity_impressions WHERE entity_id IN (${ph}) AND is_current = 1 ORDER BY layer, built_at DESC LIMIT 10`, ...ids);
    const links = core.store.all(`SELECT a, b, rel, confidence, decided_by AS decidedBy, at FROM entity_links WHERE (a IN (${ph}) OR b IN (${ph})) AND rel IN ('same', 'maybe_same', 'not_same') LIMIT 40`, ...ids, ...ids);
    const memberRows = core.store.all(`SELECT id, kind, status, display_name AS name, mention_days AS mentionDays, last_mention_at AS lastMentionAt FROM entities WHERE id IN (${ph})`, ...ids);
    const anchorIds = [...new Set([...descriptors.map((d) => d.anchor), ...links.flatMap((l) => [l.a, l.b])].filter(Number.isSafeInteger))];
    const nm = namesOf(core, [...[...scopes].map((settingKey) => ({ settingKey })), { subjects: anchorIds }]);
    out.detail = { names, descriptors, impressions, links, members: memberRows, settings: nm.settings, who: nm.names };
  }
  return out;
}
