// 【D159】管理页按时间看记忆：时间筛选（from / to）、顺序（新的在前 / 旧的在前 / 最相关）、跳到某个时间或某一条（around / aroundRef）、
// 往两头翻（keyset 游标 next / prev）、按天计数（月历用），以及带着条件下推的搜索（先圈范围再搜，旧的命中不被条数上限截掉）。
// 只读；SQL 一律参数化。列表的种类、时间列、筛选条件由 views.js 的各个视图给（spec），这里不认识具体的表。
import { ContractError } from '../contract/errors.js';
import { parseRef } from '../store/refs.js';
import { matchQuery, matchQueryAll, listPerceptShards, monthOf } from '../store/fts.js';
import { param } from './params.js';

const DAY = 86_400_000;
const bad = (what, path, message) => new ContractError(what, [{ path, message }]);

/** 每一档最多取多少条（搜索结果再多主人也翻不完；分页照常）。 */
export const SEARCH_MAX = 1000;
const likeOf = (text) => `%${String(text).replace(/[%_\\]/g, '\\$&')}%`;
/** 规范化后比（全角半角、大小写、标点、空白不算差别）：「收不到群里的消息」和「收不到群里的消息。」是同一句。 */
const flat = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** 一页多少条（admin.page.limit / max）。 */
export function limitOf(core, q) {
  const max = param(core, 'admin.page.max');
  return Math.max(1, Math.min(max, Number.isInteger(q.limit) ? q.limit : param(core, 'admin.page.limit')));
}

// ── 游标 ─────────────────────────────────────────────────────────────────
// 按时间翻的游标：{v: 1, t, i, d}——边界那一条的时间和 id（不含它本身），d 是列表的顺序（换了顺序的旧游标不认）。
// 按相关排、不按时间的列表照旧用 offset 游标 {o}；两种靠 v 区分，认不出的一律从头开始，不抛错。
const enc = (t, i, d) => Buffer.from(JSON.stringify({ v: 1, t, i, d })).toString('base64url');
function dec(s, d) {
  if (typeof s !== 'string' || !s || s.length > 400) return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return c && c.v === 1 && c.d === d && Number.isFinite(c.t) && Number.isFinite(c.i) ? { t: c.t, i: c.i } : null;
  } catch { return null; }
}

// ── 搜索（条件下推） ──────────────────────────────────────────────────────

/** 原话的全文索引是按 UTC 月分表的：时间范围给了就只查范围里的那几个月。 */
function perceptShards(core, lo, hi) {
  const from = lo != null ? monthOf(lo) : null;
  const to = hi != null ? monthOf(hi) : null;
  return listPerceptShards(core.store).filter((name) => {
    const m = name.slice(-6);
    return (from == null || m >= from) && (to == null || m <= to);
  });
}

/**
 * 主人在管理页搜（D114，D159 起带着条件下推）：先按这个列表现在的条件（时间、场合、人、状态……）圈范围，再在范围里搜。分三档：
 *   1. 原文里有这句话（子串；规范化后也算：标点、空白、全角半角不同照样认）——新的在前；
 *   2. 查询的词全都在（FTS 的 AND；多字词够用时只用多字词）——按 bm25；
 *   3. 前两档一条都没有时才退回任意一个多字词（OR），还没有才退回单字也算的 OR——按 bm25。
 * 返回 rank（按相关排好的 id，最多 SEARCH_MAX 条，「最相关」用）和 cond / args（按时间排时当作 WHERE 条件用：第 1 档是 SQL 的子串条件，
 * 不受条数上限；第 2、3 档是全文索引命中的 id）。没有全文索引的列表（原文片段）只有第 1 档；语言分析器不可用时也只有第 1 档。
 * @param {object} core
 * @param {{from: string, textSql: string, fts: string|null, time: string}} s   主表（别名 t）、原文的 SQL 表达式、FTS 表（'percepts' = 原话分表）、时间列
 * @param {string} text
 * @param {string[]} where
 * @param {unknown[]} params
 * @param {{lo: number|null, hi: number|null}} range
 */
export function searchFor(core, s, text, where, params, { lo, hi }) {
  const q = String(text ?? '').trim();
  const out = [];
  const seen = new Set();
  const push = (ids) => { for (const id of ids) if (!seen.has(id) && out.length < SEARCH_MAX) { seen.add(id); out.push(id); } };
  const w = where.length ? ` AND ${where.join(' AND ')}` : '';
  push(core.store.all(`SELECT t.id AS id FROM ${s.from} WHERE ${s.textSql} LIKE ? ESCAPE '\\'${w} ORDER BY ${s.time} DESC, t.id DESC LIMIT ${SEARCH_MAX}`,
    likeOf(q), ...params).map((r) => r.id));
  const tier1 = new Set(out);
  const done = (extra) => ({ rank: out, extra, cond: `(${s.textSql} LIKE ? ESCAPE '\\' OR t.id IN (SELECT value FROM json_each(?)))`, args: [likeOf(q), JSON.stringify(extra)] });
  if (!s.fts) return done([]);
  let terms = null;
  try { terms = [...new Set(core.mods.lang.queryTerms(core, q))]; } catch { terms = null; }
  if (!terms?.length) return done([]);
  const tables = s.fts === 'percepts' ? perceptShards(core, lo, hi) : [s.fts];
  const run = (m) => {
    if (!m || !tables.length) return [];
    const hits = [];
    for (const tb of tables) {
      hits.push(...core.store.all(`SELECT t.id AS id, bm25(${tb}) AS score FROM ${tb} JOIN ${s.from} ON t.id = ${tb}.rowid
                                   WHERE ${tb} MATCH ?${w} ORDER BY score LIMIT ${SEARCH_MAX}`, m, ...params));
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, SEARCH_MAX).map((r) => r.id);
  };
  const multi = terms.filter((x) => [...x].length >= 2);
  const both = run(matchQueryAll(multi.length ? multi : terms));
  // 第 2 档里规范化以后其实含着整句的（只是标点、空白不同），提到第 1 档的末尾
  const fq = flat(q);
  if (fq && both.length) {
    const textOf = core.store.prepare(`SELECT ${s.textSql} AS x FROM ${s.from} WHERE t.id = ?`);
    push(both.filter((id) => flat(textOf.get(id)?.x).includes(fq)));
  }
  push(both);
  // 第 3 档：任意一个多字词（全部多字词，不只是前 12 个，D114 集成复核）；连多字词都一条不中才退回单字也算的 OR
  if (!out.length && multi.length) push(run(matchQuery(multi, 32)));
  if (!out.length) push(run(matchQuery(terms)));
  return done(out.filter((id) => !tier1.has(id)));
}

// ── 圈范围 ───────────────────────────────────────────────────────────────

/**
 * 一个按时间的视图在 q 下的全部条件：视图自己的（spec.where）+ 时间筛选 + 搜索（有的话）。
 * 时间筛选：有起止的（经历、原文片段）和 [start, end] 相交；别的按时间列落在 [from, to] 里（闭区间）。
 */
function scopeOf(core, q, spec) {
  const where = [...spec.where];
  const params = [...spec.params];
  const lo = Number.isFinite(q.from) ? q.from : null;
  const hi = Number.isFinite(q.to) ? q.to : null;
  if (lo != null) { where.push(`${spec.time} >= ?`); params.push(lo); }
  if (hi != null) { where.push(`${spec.span ?? spec.time} <= ?`); params.push(hi); }
  const text = spec.search && typeof q.q === 'string' && q.q.trim() ? q.q.trim() : null;
  const found = text ? searchFor(core, { from: spec.from, time: spec.time, ...spec.search }, text, where, params, { lo, hi }) : null;
  return { where, params, lo, hi, found };
}

/**
 * 一页按时间的列表（D159）。q：from / to（毫秒，闭区间）、order（'desc' 默认 | 'asc' | 'rank'，rank 只在有搜索词时有意义，也是搜索时的默认）、
 * around（毫秒）/ aroundRef（这个视图种类的一条记忆的引用）：返回锚点前后各约半页；near（只配 around）：'before' = 取这一刻或之前最近的一条、
 * 'after' = 这一刻或之后最近的（那一边没有就退回另一边；不给 = 两边哪条近取哪条——「跳到某一天」要落在那一天里，用它）；
 * next / prev：往列表后面 / 前面翻。
 * 返回 {items, total, next?, prev?, anchor?, order}；anchor = {ref, index, exact, clamped?}。
 * @param {object} core
 * @param {object} q
 * @param {{from: string, where: string[], params: unknown[], time: string, span?: string, key?: string, kind?: string|null,
 *          select?: string, map: (row: any) => any, search?: {textSql: string, fts: string|null}}} spec
 *        time：排序和跳转用的时间列（SQL 表达式，别名 t）；span：有起止时开头那一列；key：同一时刻的次序（默认 t.id，要唯一）；
 *        kind：aroundRef 必须是的种类（null = 不收 aroundRef）
 */
export function timeline(core, q, spec) {
  const { from, time, key = 't.id', kind = null, select = '*', map } = spec;
  const { where, params, lo, hi, found } = scopeOf(core, q, spec);
  let order = q.order === 'asc' || q.order === 'desc' ? q.order : found ? 'rank' : 'desc';
  if (order === 'rank' && !found) order = 'desc';
  const limit = limitOf(core, q);
  if (order === 'rank') {
    // 最相关的在前：照旧 offset 分页（rank 已经是在范围里搜出来的）
    let offset = 0;
    try { offset = Math.max(0, Math.floor(Number(JSON.parse(Buffer.from(String(q.next ?? ''), 'base64url').toString('utf8')).o)) || 0); } catch { offset = 0; }
    const conds = [...where, 't.id IN (SELECT value FROM json_each(?))'];
    const args = [...params, JSON.stringify(found.rank)];
    const W = `WHERE ${conds.join(' AND ')}`;
    const total = Number(core.store.get(`SELECT count(*) AS n FROM ${from} ${W}`, ...args).n);
    const rows = core.store.all(`SELECT ${select} FROM ${from} ${W} ORDER BY (SELECT r.key FROM json_each(?) r WHERE r.value = t.id), ${time} DESC, ${key} DESC LIMIT ? OFFSET ?`,
      ...args, JSON.stringify(found.rank), limit, offset);
    return { items: rows.map(map), total, next: offset + limit < total ? Buffer.from(JSON.stringify({ o: offset + limit })).toString('base64url') : undefined, order };
  }
  if (found) { where.push(found.cond); params.push(...found.args); }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(core.store.get(`SELECT count(*) AS n FROM ${from} ${W}`, ...params).n);
  const asc = order === 'asc';
  /** 从 bound（不含它；incl 时含）往 up 方向（true = 时间变大）取 n 条，按那个方向排好。 */
  const seek = (up, bound, incl, n) => {
    const conds = [...where];
    const args = [...params];
    if (bound && bound.i == null) {
      // 只按时刻（找离某个时间最近的一条）：含这一刻
      conds.push(`${time} ${up ? '>' : '<'}= ?`);
      args.push(bound.t);
    } else if (bound) {
      const op = up ? '>' : '<';
      // 写成「时间 ≥ 且（时间 > 或 id ≥）」：时间那一半能走索引
      conds.push(`${time} ${op}= ? AND (${time} ${op} ? OR ${key} ${op}${incl ? '=' : ''} ?)`);
      args.push(bound.t, bound.t, bound.i);
    }
    const d = up ? 'ASC' : 'DESC';
    return core.store.all(`SELECT ${select}, ${time} AS _t, ${key} AS _k FROM ${from} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
                           ORDER BY ${time} ${d}, ${key} ${d} LIMIT ?`, ...args, n);
  };
  const fwd = (b, incl, n) => seek(asc, b, incl, n);                     // 列表往后（往下）
  const back = (b, incl, n) => seek(!asc, b, incl, n).reverse();         // 列表往前（往上），按列表顺序返回
  const at = (r) => ({ t: r._t, i: r._k });
  const cursor = (r) => enc(r._t, r._k, order);
  const out = (rows, { next, prev, anchor } = {}) => ({ items: rows.map(map), total, ...(next ? { next } : {}), ...(prev ? { prev } : {}), ...(anchor ? { anchor } : {}), order });

  if (Number.isFinite(q.around) || (typeof q.aroundRef === 'string' && q.aroundRef)) {
    let T = q.around;
    let hit = null;
    let exact = false;
    let clamped = null;
    if (typeof q.aroundRef === 'string' && q.aroundRef) {
      const m = parseRef(q.aroundRef);
      if (!m || !kind || m.kind !== kind) throw bad('admin.list', 'aroundRef', kind ? `应为这个列表那一类的记忆引用（${kind}）` : '这个列表不按某一条记忆定位，用 around');
      hit = core.store.get(`SELECT ${time} AS _t, ${key} AS _k FROM ${from} ${W ? `${W} AND` : 'WHERE'} t.id = ?`, ...params, m.id) ?? null;
      if (hit) exact = true;
      else {
        // 不在现在的条件里（被筛掉了）：按它的时间找最近的
        const row = core.store.get(`SELECT ${time} AS _t FROM ${from} WHERE t.id = ?`, m.id);
        if (!row) throw bad('admin.list', 'aroundRef', '没有这条记忆');
        T = row._t;
      }
    }
    if (!hit) {
      if (lo != null && T < lo) { T = lo; clamped = 'from'; } else if (hi != null && T > hi) { T = hi; clamped = 'to'; }
      const later = seek(true, { t: T, i: null }, true, 1)[0] ?? null;
      const earlier = seek(false, { t: T, i: null }, true, 1)[0] ?? null;
      const near = typeof q.aroundRef === 'string' ? null : q.near;
      hit = near === 'before' ? earlier ?? later : near === 'after' ? later ?? earlier
        : !later ? earlier : !earlier ? later : (T - earlier._t <= later._t - T ? earlier : later);
      if (hit && typeof q.aroundRef !== 'string') exact = hit._t === T;
    }
    if (!hit) return out([]);
    const half = Math.floor(limit / 2);
    const before = back(at(hit), false, half + 1);
    const moreBefore = before.length > half;
    const head = moreBefore ? before.slice(1) : before;
    const room = limit - head.length;
    const after = fwd(at(hit), true, room + 1);
    const moreAfter = after.length > room;
    const rows = [...head, ...(moreAfter ? after.slice(0, room) : after)];
    const mapped = rows.map(map);
    return { items: mapped, total, ...(moreAfter ? { next: cursor(rows.at(-1)) } : {}), ...(moreBefore ? { prev: cursor(rows[0]) } : {}),
      anchor: { ref: mapped[head.length]?.ref ?? null, index: head.length, exact, ...(clamped ? { clamped } : {}) }, order };
  }
  const pc = dec(q.prev, order);
  if (pc) {
    const r = back(pc, false, limit + 1);
    const more = r.length > limit;
    const rows = more ? r.slice(1) : r;
    if (!rows.length) return out([]);
    return out(rows, { prev: more ? cursor(rows[0]) : undefined, next: fwd(at(rows.at(-1)), false, 1).length ? cursor(rows.at(-1)) : undefined });
  }
  const nc = dec(q.next, order);
  const r = fwd(nc, false, limit + 1);
  const more = r.length > limit;
  const rows = more ? r.slice(0, limit) : r;
  return out(rows, { next: more ? cursor(rows.at(-1)) : undefined, prev: nc && rows.length && back(at(rows[0]), false, 1).length ? cursor(rows[0]) : undefined });
}

/** 本地时间的偏移（分钟，东正）：页面给的（±840 内），否则 time.tzOffsetMin，再否则本机时区。 */
function tzOf(core, q, at) {
  if (Number.isInteger(q.tzOffsetMin) && Math.abs(q.tzOffsetMin) <= 840) return q.tzOffsetMin;
  const v = core.config.get().time?.tzOffsetMin;
  return typeof v === 'number' ? v : -new Date(at).getTimezoneOffset();
}

/**
 * 按天计数（D159，管理页「跳到」的月历）：在和列表相同的条件下（不含 around / 游标），某个月每天有几条；first / last 是这个条件下
 * 最早、最晚一条的时间（「最早」「最新」和月历能翻到哪儿）。天的边界按 tzOffsetMin；有起止的（经历、原文片段）算在结束那天。
 * @param {object} core
 * @param {object} q        month: 'YYYY-MM'，tzOffsetMin?，其余和列表相同
 * @param {object} spec     同 timeline
 * @returns {{items: {day: string, n: number}[], first: number|null, last: number|null, tzOffsetMin: number}}
 */
export function dayCounts(core, q, spec) {
  const m = typeof q.month === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(q.month) : null;
  if (!m) throw bad('admin.list', 'month', '应为 YYYY-MM');
  const y = Number(m[1]); const mo = Number(m[2]);
  const tz = tzOf(core, q, Date.UTC(y, mo - 1, 15));
  const off = tz * 60_000;
  const start = Date.UTC(y, mo - 1, 1) - off;
  const end = Date.UTC(y, mo, 1) - off;
  const { where, params, found } = scopeOf(core, q, spec);
  if (found) { where.push(found.cond); params.push(...found.args); }
  const W = where.length ? ` AND ${where.join(' AND ')}` : '';
  const rows = core.store.all(`SELECT CAST((${spec.time} + ?) / ${DAY} AS INTEGER) AS d, count(*) AS n FROM ${spec.from}
                               WHERE ${spec.time} >= ? AND ${spec.time} < ?${W} GROUP BY d ORDER BY d`, off, start, end, ...params);
  const edge = (d) => core.store.get(`SELECT ${spec.time} AS t FROM ${spec.from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                                      ORDER BY ${spec.time} ${d}, ${spec.key ?? 't.id'} ${d} LIMIT 1`, ...params)?.t ?? null;
  return { items: rows.map((r) => ({ day: new Date(Number(r.d) * DAY).toISOString().slice(0, 10), n: Number(r.n) })), first: edge('ASC'), last: edge('DESC'), tzOffsetMin: tz };
}
