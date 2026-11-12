// 【D163】记忆星图（管理页「星图」）的数据：每颗星是一条记忆（事实、经历 / 日记 / 导入、意图），亮度由痕迹按 ACT-R 算。
// 三种调用：快照（全部星 + 痕迹 + 想起 + 说起 + 心境 + 听到多少话 + 夜间整理的时刻）、实时增量（某个游标之后的痕迹 / 想起 / 说起）、
// 看一眼（≤ 24 颗星的一句内容）。同步、只读、不调模型、不写任何表，只读库也能用。
// 读别的模块的表直接写 SQL（schema 就是契约），参数一律绑定。思路是每张表按需要的列扫一遍，在内存里用 Map 拼，不对每颗星单独查。
// 快照里没有记忆的正文（只有「看一眼」给正文）。隐藏、忘掉的（suppressions）和彻底删除的（墓碑）不出现，它们的痕迹、想起、说起也不出现。
import { ContractError } from '../contract/errors.js';
import { isOneOnOne } from '../contract/setting.js';
import { parseRef, refOf } from '../store/refs.js';
import { getMeta } from '../store/kv.js';
import { tombstonedIds } from './suppress.js';
import { personGroups } from './views.js';
import { param } from './params.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const STAR_KINDS = ['assertion', 'episode', 'intention'];
/** 当星的情节（小结、lapse 不当星）。 */
const STAR_EP_KINDS = ['event', 'diary', 'import'];
const PLAN_HINTS = new Set(['plan', 'commitment', 'rule']);
const PLAN_DONE = new Set(['done', 'cancelled', 'missed']);
const INTENT_DONE = new Set(['executed', 'cancelled', 'obsolete', 'lapsed']);
const CERT = { stated: 's', confirmed: 'c', self_said: 'm', hearsay: 'h', inferred: 'i' };
/** 痕迹原因的代号；9 = 折叠进聚合箱的老痕迹（伪痕迹）。不认识的原因按 1（被提起）算。 */
const REASON = { encode: 0, mention: 1, reread: 2, confirm: 3, asked: 4, reply: 5, retell: 6, replay: 7, inherit: 8 };
const OLD = 9;
const reasonCode = (r) => REASON[r] ?? 1;
const TIER = { cold: 0, warm: 1, hot: 2 };

const MAX_STARS_DEFAULT = 20_000;
const MAX_STARS_CAP = 50_000;
const RECALL_DAYS_DEFAULT = 60;
const RECALL_ROWS = 8000;
const TELL_DAYS = 60;
const TELL_ROWS = 8000;
const MOOD_POINTS = 2000;
const HEARD_DAYS = 90;
const LIVE_ROWS = 500;
const PEEK_MAX = 24;
const PEEK_TEXT = 160;
const WHO_MAX = 4;

const bad = (path, message) => new ContractError('admin.starmap', [{ path, message }]);
const j = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? a.slice(0, n).join('') : a.join(''); };
const ph = (ids) => JSON.stringify(ids);

/**
 * 读多行，每行是按 SELECT 次序的数组（大表扫一遍时比每行一个对象快一倍左右）。node:sqlite 有 setReturnArrays 就用它，
 * 没有就把对象转成数组。语句是 store 缓存的同一个：这里的 SQL 都带着 starmap 标记，别处不会用到同一条。
 */
function A(db, sql, ...params) {
  const st = db.prepare(`/* starmap */ ${sql}`);
  if (typeof st.setReturnArrays === 'function') { st.setReturnArrays(true); return st.all(...params); }
  return st.all(...params).map((r) => Object.values(r));
}

/** 想起的层 → 0 眼前的事 / 1 自己浮上来的 / 2 被问到去找的。 */
function layerCode(layer) {
  const l = String(layer ?? '');
  if (l === 'working' || l === 'pointBack' || l === 'sinceHere') return 0;   // 这之后他的事（D164）也是眼前这个人的事
  if (l === 'recollect' || l === 'outline' || l.startsWith('memory_')) return 2;
  return 1;
}

// ── 参数 ──────────────────────────────────────────────────────────────────

function parseQuery(q) {
  if (q == null) q = {};
  if (typeof q !== 'object' || Array.isArray(q)) throw bad('q', '应为对象');
  const has = (k) => q[k] !== undefined;
  const modes = ['since', 'peek'].filter(has);
  if (modes.length > 1) throw bad('since/peek', 'since 和 peek 只能给一个');
  if (has('since')) {
    if (has('maxStars') || has('recallDays')) throw bad('since', '增量不认 maxStars / recallDays');
    const s = q.since;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('since', '应为 {inj, trace, told}');
    for (const k of ['inj', 'trace', 'told']) if (!Number.isSafeInteger(s[k]) || s[k] < 0) throw bad(`since.${k}`, '应为非负整数');
    return { mode: 'live', since: { inj: s.inj, trace: s.trace, told: s.told } };
  }
  if (has('peek')) {
    if (has('maxStars') || has('recallDays')) throw bad('peek', '看一眼不认 maxStars / recallDays');
    if (!Array.isArray(q.peek)) throw bad('peek', '应为记忆引用的数组');
    if (q.peek.length > PEEK_MAX) throw bad('peek', `最多 ${PEEK_MAX} 个`);
    if (q.peek.some((r) => typeof r !== 'string')) throw bad('peek', '每一项应为字符串');
    return { mode: 'peek', refs: q.peek };
  }
  let maxStars = MAX_STARS_DEFAULT;
  if (has('maxStars')) {
    if (!Number.isSafeInteger(q.maxStars) || q.maxStars < 1 || q.maxStars > MAX_STARS_CAP) throw bad('maxStars', `应为 1–${MAX_STARS_CAP} 的整数`);
    maxStars = q.maxStars;
  }
  let recallDays = RECALL_DAYS_DEFAULT;
  if (has('recallDays')) {
    if (!Number.isSafeInteger(q.recallDays) || q.recallDays < 1 || q.recallDays > 3650) throw bad('recallDays', '应为 1–3650 的整数');
    recallDays = q.recallDays;
  }
  return { mode: 'snapshot', maxStars, recallDays };
}

// ── 公共的几样 ────────────────────────────────────────────────────────────

/** 指纹：星的集合或状态变了它就变（新增、取代、过时、计划和意图的状态、隐藏 / 恢复、彻底删除）。一条 SQL。 */
function revOf(db) {
  const r = db.get(`SELECT
      (SELECT coalesce(max(id), 0) FROM assertions) AS a, (SELECT coalesce(max(id), 0) FROM episodes) AS e,
      (SELECT coalesce(max(id), 0) FROM intentions) AS t, (SELECT coalesce(max(updated_at), 0) FROM assertions) AS au,
      (SELECT coalesce(max(updated_at), 0) FROM intentions) AS tu,
      (SELECT count(*) || '-' || coalesce(sum(owner_id), 0) || '-' || coalesce(max(at), 0) FROM suppressions) AS s,
      (SELECT coalesce(max(id), 0) FROM tombstones) AS x`);
  return [r.a, r.e, r.t, r.au, r.tu, r.s, r.x].join('.');
}

/** 这几张表现在的最大 id（快照的 cursor）。 */
function cursorNow(db) {
  const r = db.get(`SELECT (SELECT coalesce(max(id), 0) FROM injections) AS inj, (SELECT coalesce(max(id), 0) FROM traces) AS trace,
                           (SELECT coalesce(max(id), 0) FROM told_log) AS told`);
  return { inj: Number(r.inj), trace: Number(r.trace), told: Number(r.told) };
}

/** 隐藏 / 忘掉的星：Set<'kind:id'>。 */
function suppressedSet(db) {
  const out = new Set();
  for (const r of db.all("SELECT owner_kind AS k, owner_id AS id FROM suppressions WHERE owner_kind IN ('assertion','episode','intention')")) out.add(`${r.k}:${r.id}`);
  return out;
}

/** 彻底删除的星（墓碑按时间生效，D42）：Set<'kind:id'>。 */
function tombSet(db) {
  const ids = { assertion: [], episode: [], intention: [] };
  for (const r of db.all("SELECT kind, ref FROM tombstones WHERE kind IN ('assertion','episode','intention')")) {
    const m = parseRef(r.ref);
    if (m && m.kind === r.kind) ids[r.kind].push(m.id);
  }
  const out = new Set();
  for (const k of STAR_KINDS) for (const id of tombstonedIds(db, k, ids[k])) out.add(`${k}:${id}`);
  return out;
}

/** 本地日（time.tzOffsetMin；null = 本机时区），夜间整理聚簇用。 */
function localDay(core, at) {
  const tz = param(core, 'time.tzOffsetMin');
  const off = (tz == null ? -new Date(at).getTimezoneOffset() : tz) * 60_000;
  return Math.floor((at + off) / DAY);
}

// ── 快照 ──────────────────────────────────────────────────────────────────

function snapshot(core, o) {
  const db = core.store;
  const now = core.now();
  const rev = revOf(db);
  const cursor = cursorNow(db);
  const ageFloorMs = Number(param(core, 'activation.ageFloorMin')) * 60_000;
  const timeUnitMs = Number(param(core, 'activation.timeUnitMs'));
  // 隐藏 / 忘掉 / 删掉的：每种一个 id 的集合（扫星时只做数字查找）
  const goneIds = { assertion: new Set(), episode: new Set(), intention: new Set() };
  for (const key of [...suppressedSet(db), ...tombSet(db)]) { const [k, id] = key.split(':'); goneIds[k].add(Number(id)); }
  const gone = (k, id) => goneIds[k].has(id);

  // 人：pickable 的分组；档案 id → 代表
  const groups = personGroups(core);
  /** @type {Map<number, any>} 代表 id → 人 */
  const personByRep = new Map();
  /** @type {Map<number, number>} 任一档案 id → 代表 id */
  const repOf = new Map();
  let selfRep = null;
  for (const g of groups) {
    const self = g.alive.some((r) => !!r.is_self);
    const p = { id: g.rep.id, name: g.name, self, principal: g.alive.some((r) => r.authority === 'principal'),
      closeness: Math.max(0, Math.min(1, Math.max(...g.alive.map((r) => Number(r.closeness) || 0)))), n: 0 };
    personByRep.set(p.id, p);
    for (const id of g.members) repOf.set(id, p.id);
    if (self && selfRep == null) selfRep = p.id;
  }
  if (selfRep == null) {
    // 她自己的档案没有名字（不在 pickable 里）：照样列出来，名字留空
    const s = db.get("SELECT id, closeness, authority FROM entities WHERE is_self = 1 AND status <> 'retracted' LIMIT 1");
    if (s) {
      personByRep.set(s.id, { id: s.id, name: '', self: true, principal: s.authority === 'principal', closeness: Math.max(0, Math.min(1, Number(s.closeness) || 0)), n: 0 });
      repOf.set(s.id, s.id);
      selfRep = s.id;
    }
  }
  const rep = (id) => (id == null ? undefined : repOf.get(Number(id)));
  /** 档案 id 列表 → 去重的代表 id（最多 4 个，对不上的丢掉）。 */
  const whoOf = (ids) => {
    const out = [];
    for (const id of ids) {
      const r = rep(id);
      if (r != null && !out.includes(r)) out.push(r);
      if (out.length >= WHO_MAX) break;
    }
    return out;
  };

  /** 候选星：{kind, id, k, sub, t, t2, place(key), who(rep ids), st, supId, imp, cert, val} */
  const stars = [];
  /** @type {Record<string, Map<number, any>>} */
  const byKind = { assertion: new Map(), episode: new Map(), intention: new Map() };

  // 事实：最早一条来源（SQLite 的 min() 带出同一行的裸列）
  /** @type {Map<number, any[]>} 事实 id → [id, at, 场合键, speaker] */
  const firstSrc = new Map();
  for (const r of A(db, "SELECT owner_id, min(at), perceived_in, speaker FROM sources WHERE owner_kind = 'assertion' GROUP BY owner_id")) firstSrc.set(r[0], r);
  const roles = new Map();
  const ROLE = { subject: 0, object: 1, speaker: 2 };
  for (const [a, e, role] of A(db, "SELECT assertion_id, entity_id, role FROM assertion_entities WHERE role IN ('subject','object','speaker')")) {
    let x = roles.get(a);
    if (!x) { x = [[], [], []]; roles.set(a, x); }
    x[ROLE[role]].push(e);
  }
  for (const [id, hint, certainty, imp, recordedAt, expiredAt, supBy, planStatus] of
    A(db, 'SELECT id, kind_hint, certainty, imp, recorded_at, expired_at, superseded_by, plan_status FROM assertions')) {
    if (gone('assertion', id)) continue;
    const src = firstSrc.get(id);
    const ro = roles.get(id);
    const ids = ro ? [...ro[0], ...ro[1]] : [];
    if (!ro?.[0].length) ids.push(...(ro?.[2].length ? ro[2] : src?.[3] != null ? [src[3]] : []));
    const s = { kind: 'assertion', id, k: hint === 'lesson' ? 3 : PLAN_HINTS.has(hint) ? 2 : 1, sub: hint,
      t: src?.[1] ?? recordedAt, t2: null, place: src?.[2] ?? null, who: whoOf(ids),
      st: supBy != null ? 1 : (expiredAt != null || PLAN_DONE.has(planStatus)) ? 2 : 0, supId: supBy,
      imp: num(imp) == null ? null : imp / 10, cert: CERT[certainty] ?? null, val: null };
    stars.push(s);
    byKind.assertion.set(id, s);
  }
  // 经历、日记、导入的
  for (const e of db.all(`SELECT id, ep_kind, setting_key, t_start, t_end, participants_json, emotion_json FROM episodes WHERE ep_kind IN (${STAR_EP_KINDS.map(() => '?').join(',')})`, ...STAR_EP_KINDS)) {
    if (gone('episode', e.id)) continue;
    const parts = j(e.participants_json, []);
    const list = Array.isArray(parts) ? parts : [];
    let who = whoOf(list.filter((x) => rep(x) !== selfRep || selfRep == null));
    if (!who.length && selfRep != null && list.some((x) => rep(x) === selfRep)) who = [selfRep];
    const emo = j(e.emotion_json, null);
    const s = { kind: 'episode', id: e.id, k: 0, sub: e.ep_kind, t: e.t_start, t2: e.t_end, place: e.setting_key, who, st: 0, supId: null,
      imp: num(emo?.intensity), cert: null, val: num(emo?.valence) };
    stars.push(s);
    byKind.episode.set(e.id, s);
  }
  // 意图：场合是第一条原话的场合
  const intents = db.all('SELECT id, target_entity_id, state, formed_at, sources_json FROM intentions').filter((t) => !gone('intention', t.id));
  const firstPercept = new Map();
  for (const t of intents) {
    const s = j(t.sources_json, []);
    const pid = Array.isArray(s) && Number.isSafeInteger(s[0]) ? s[0] : null;
    if (pid != null) firstPercept.set(t.id, pid);
  }
  const perceptKey = new Map();
  if (firstPercept.size) {
    for (const r of db.all('SELECT id, setting_key AS k FROM percepts WHERE id IN (SELECT value FROM json_each(?))', ph([...new Set(firstPercept.values())]))) perceptKey.set(r.id, r.k);
  }
  for (const t of intents) {
    const who = t.target_entity_id == null ? (selfRep != null ? [selfRep] : []) : whoOf([t.target_entity_id]);
    const s = { kind: 'intention', id: t.id, k: 2, sub: 'intention', t: t.formed_at, t2: null, place: perceptKey.get(firstPercept.get(t.id)) ?? null, who,
      st: INTENT_DONE.has(t.state) ? 2 : 0, supId: null, imp: null, cert: null, val: null };
    stars.push(s);
    byKind.intention.set(t.id, s);
  }

  const counts = { percepts: Number(db.get('SELECT count(*) AS n FROM percepts').n), episode: 0, fact: 0, plan: 0, lesson: 0 };
  for (const s of stars) { if (s.k === 0) counts.episode++; else if (s.k === 1) counts.fact++; else if (s.k === 2) counts.plan++; else counts.lesson++; }

  // 激活：b_cache、层级、聚合箱
  // 每颗星的 act = [kind, id, b_cache, tier, agg_n, agg_w, agg_first, agg_last, agg_d, agg_bins_json]
  for (const r of A(db, `SELECT owner_kind, owner_id, b_cache, tier, agg_n, agg_w, agg_first, agg_last, agg_d, agg_bins_json
                          FROM activation WHERE owner_kind IN ('assertion','episode','intention')`)) {
    const s = byKind[r[0]]?.get(r[1]);
    if (s) s.act = r;
  }

  // 超过 maxStars：先省 cold 里 b_cache 最低的（再不够依次 warm、hot；没有激活行的算 cold；同分省早的）
  let dropped = 0;
  let kept = stars;
  if (stars.length > o.maxStars) {
    const key = (s) => { const a = s.act; return [a ? (TIER[a[3]] ?? 2) : 0, a?.[2] ?? -Infinity, s.t]; };
    const order = stars.map((s) => ({ s, key: key(s) })).sort((x, y) => x.key[0] - y.key[0] || x.key[1] - y.key[1] || x.key[2] - y.key[2]);
    const out = new Set(order.slice(0, stars.length - o.maxStars).map((x) => x.s));
    dropped = out.size;
    kept = stars.filter((s) => !out.has(s));
    for (const s of out) byKind[s.kind].delete(s.id);
  }
  const KORD = { assertion: 0, episode: 1, intention: 2 };
  kept.sort((a, b) => a.t - b.t || KORD[a.kind] - KORD[b.kind] || a.id - b.id);
  kept.forEach((s, i) => { s.idx = i; });
  const idxOf = (kind, id) => byKind[kind]?.get(id)?.idx;

  // 痕迹（精确的 + 聚合箱的伪痕迹）；顺带收集 replay 的时刻（夜间整理）
  const traces = [];
  const replayAt = [];
  // 扫整张表（不走 traces_owner：按索引回表比顺着表读慢）
  const trRows = A(db, "SELECT owner_kind, owner_id, t, w, d, reason FROM traces NOT INDEXED WHERE owner_kind IN ('assertion','episode','intention')");
  for (let n = 0; n < trRows.length; n++) {
    const r = trRows[n];
    if (r[5] === 'replay') replayAt.push(r[2]);
    const s = byKind[r[0]].get(r[1]);
    if (s !== undefined && s.idx !== undefined) traces.push([s.idx, r[2], r[3], r[4], REASON[r[5]] ?? 1]);
  }
  for (const s of kept) {
    const a = s.act;
    if (!a || (a[9] === '[]' && !(a[4] > 0))) continue;
    const bins = j(a[9], []);
    if (Array.isArray(bins) && bins.length) {
      for (const b of bins) {
        if (!(b?.w > 0) || !Number.isFinite(b.first)) continue;
        const last = Number.isFinite(b.last) ? b.last : b.first;
        traces.push([s.idx, b.n === 1 ? b.first : Math.round((b.first + last) / 2), b.w, num(b.d) ?? 0.3, OLD]);
      }
    } else if (a[4] > 0 && a[5] > 0 && a[6] != null) {
      // 老数据（没有分箱）：整个聚合项一条
      const last = a[7] ?? a[6];
      traces.push([s.idx, a[4] === 1 ? a[6] : Math.round((a[6] + last) / 2), a[5], num(a[8]) ?? 0.3, OLD]);
    }
  }
  traces.sort((x, y) => x[1] - y[1]);   // 稳定排序：同一时刻按读出来的次序

  // 想起：注入日志（不含常驻区），最近 recallDays 天、最多 8000 行
  const isStarRef = (m) => m && (m.kind === 'assertion' || m.kind === 'intention' || m.kind === 'episode');
  const epKind = new Map(db.all('SELECT id, ep_kind FROM episodes').map((r) => [r.id, r.ep_kind]));
  const starKindUnit = (m) => m.kind !== 'episode' || STAR_EP_KINDS.includes(epKind.get(m.id));
  const recallRows = A(db, "SELECT ts, setting_key, layer, items_json FROM injections WHERE layer <> 'resident' AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?",
    now - o.recallDays * DAY, RECALL_ROWS).reverse().map(([ts, k, layer, items]) => ({ ts, k, layer, items_json: items }));
  const recallsRaw = [];
  for (const r of recallRows) {
    const items = j(r.items_json, []);
    if (!Array.isArray(items)) continue;
    const hits = [];
    let rawN = 0;
    for (const it of items) {
      if (!it || it.verdict === 'omit') continue;
      const m = parseRef(it.id);
      if (isStarRef(m) && starKindUnit(m)) {
        const i = idxOf(m.kind, m.id);
        if (i != null) hits.push([i, layerCode(it.layer ?? r.layer)]);
        // 隐藏 / 删掉 / 省掉的星：不算进任何一样
      } else rawN++;
    }
    if (hits.length || rawN) recallsRaw.push([r.ts, r.k, hits, rawN]);
  }

  // 说起
  const tellsRaw = [];
  for (const [at, k, ok, id, level] of A(db, `SELECT at, setting_key, owner_kind, owner_id, level FROM told_log
                          WHERE owner_kind IN ('assertion','episode','intention') AND at >= ? ORDER BY at DESC, id DESC LIMIT ?`, now - TELL_DAYS * DAY, TELL_ROWS).reverse()) {
    const i = idxOf(ok, id);
    if (i != null) tellsRaw.push([at, k, i, level === 'full' ? 1 : 0]);
  }

  const mood = db.all('SELECT at, valence, intensity FROM mood ORDER BY at DESC, id DESC LIMIT ?', MOOD_POINTS).reverse().map((r) => [r.at, r.valence, r.intensity]);

  // 听到多少话：别人的话（不含她自己的），按场合、整点。percepts 没有覆盖这几列的索引：按 percepts_at 走要逐行回表（很慢），
  // 所以先用 percepts_at（覆盖）找出窗口里最小的 id，再顺着主键从那里往后读（感知只追加，id 大致按时间），在内存里计数
  const heardFrom = now - HEARD_DAYS * DAY;
  const minId = A(db, 'SELECT min(id) FROM percepts INDEXED BY percepts_at WHERE at >= ?', heardFrom)[0]?.[0];
  /** @type {Map<string, Map<number, number[]>>} 场合 → 整点 → [n, nToHer] */
  const heardMap = new Map();
  if (minId != null) {
    for (const [k, at, toHer] of A(db, `SELECT setting_key, at, addressed IN ('to-her','mentions-her') FROM percepts
                                        WHERE id >= ? AND +at >= ? AND actor_self = 0 AND kind IN ('utterance','action','content')`, minId, heardFrom)) {
      const h = at - (at % HOUR);
      let byH = heardMap.get(k);
      if (!byH) { byH = new Map(); heardMap.set(k, byH); }
      const c = byH.get(h);
      if (c) { c[0]++; if (toHer) c[1]++; } else byH.set(h, [1, toHer ? 1 : 0]);
    }
  }
  const heardRaw = [];
  for (const [k, byH] of heardMap) for (const [h, c] of byH) heardRaw.push({ k, h, n: c[0], toHer: c[1] });

  // 场合：被星、想起、说起、听到引用到的（settings 里有的）；按星数多的在前
  const used = new Map();
  const touch = (k, add) => { if (typeof k === 'string' && k) used.set(k, (used.get(k) ?? 0) + add); };
  for (const s of kept) touch(s.place, 1);
  for (const r of recallsRaw) touch(r[1], 0);
  for (const r of tellsRaw) touch(r[1], 0);
  for (const r of heardRaw) touch(r.k, 0);
  const places = [];
  const placeIdx = new Map();
  if (used.size) {
    const rows = db.all(`SELECT s.key, s.label, s.adapter, s.label_kind, s.label_hint, s.owner_label, ss.descriptor_json FROM settings s
                         LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id WHERE s.key IN (SELECT value FROM json_each(?))`, ph([...used.keys()]));
    rows.sort((a, b) => used.get(b.key) - used.get(a.key) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const s of rows) {
      const owner = typeof s.owner_label === 'string' && s.owner_label ? s.owner_label : null;
      let one = null;
      const d = j(s.descriptor_json, null);
      if (d) { try { one = !!isOneOnOne(d); } catch { one = null; } }
      placeIdx.set(s.key, places.length);
      places.push({ key: s.key, label: s.label ?? '', ownerLabel: owner, labelKind: owner ? 'name' : s.label_kind === 'description' ? 'description' : 'name',
        adapter: s.adapter, hint: s.label_hint ?? null, oneOnOne: one, n: used.get(s.key) });
    }
  }
  const pIdx = (k) => placeIdx.get(k) ?? -1;

  // 人：只列至少是一颗星的 who 的、和她自己；她自己第一，其后 principal、closeness 高、n 多的在前
  const inWho = new Set();
  for (const s of kept) {
    for (const r of s.who) inWho.add(r);
    const home = s.who[0];
    if (home != null) personByRep.get(home).n++;
  }
  const people = [...personByRep.values()].filter((p) => p.self || inWho.has(p.id))
    .sort((a, b) => (b.self - a.self) || (b.principal - a.principal) || (b.closeness - a.closeness) || (b.n - a.n) || (a.id - b.id));
  const personIdx = new Map(people.map((p, i) => [p.id, i]));

  const rows = kept.map((s) => [
    refOf(/** @type {any} */ (s.kind), s.id), s.k, s.sub, s.t, s.t2, pIdx(s.place), s.who.map((r) => personIdx.get(r)), s.st,
    s.supId != null ? (idxOf('assertion', s.supId) ?? -1) : -1, s.imp, s.cert, s.val, s.act?.[2] ?? null,
  ]);

  // 夜间整理：replay 痕迹按本地日聚簇取每簇最早的时刻，加上 meta 'sleep.lastAt'（最近一次跑完的）
  const lastSleep = Number(getMeta(db, 'sleep.lastAt'));
  if (Number.isFinite(lastSleep) && lastSleep > 0) replayAt.push(lastSleep);
  const nightByDay = new Map();
  for (const t of replayAt) {
    const d = localDay(core, t);
    if (!nightByDay.has(d) || t < nightByDay.get(d)) nightByDay.set(d, t);
  }
  const nights = [...nightByDay.values()].sort((a, b) => a - b);

  const firstPerceptAt = db.get('SELECT min(at) AS t FROM percepts')?.t;
  let t0 = kept.length ? kept[0].t : Infinity;
  if (firstPerceptAt != null && firstPerceptAt < t0) t0 = firstPerceptAt;

  return {
    now, rev, cursor, params: { ageFloorMs, timeUnitMs }, t0: Number.isFinite(t0) ? t0 : now,
    people: people.map((p) => ({ id: p.id, name: p.name, self: p.self, principal: p.principal, closeness: p.closeness, n: p.n })),
    places,
    stars: { cols: ['ref', 'k', 'sub', 't', 't2', 'place', 'who', 'st', 'sup', 'imp', 'cert', 'val', 'b'], rows },
    traces,
    recalls: recallsRaw.map((r) => [r[0], pIdx(r[1]), r[2], r[3]]),
    tells: tellsRaw.map((r) => [r[0], pIdx(r[1]), r[2], r[3]]),
    mood,
    heard: heardRaw.filter((r) => placeIdx.has(r.k)).map((r) => [placeIdx.get(r.k), Number(r.h), Number(r.n), Number(r.toHer)])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    nights, dropped, counts,
  };
}

// ── 实时增量 ──────────────────────────────────────────────────────────────

/** 一批（kind, id）里哪些是现在看得见的星：存在、情节是当星的那几种、没隐藏、没删。返回 Set<'kind:id'>。 */
function visibleStars(db, pairs) {
  const ids = { assertion: new Set(), episode: new Set(), intention: new Set() };
  for (const [k, id] of pairs) ids[k]?.add(id);
  const out = new Set();
  for (const k of STAR_KINDS) {
    const list = [...ids[k]];
    if (!list.length) continue;
    const sql = k === 'assertion' ? 'SELECT id FROM assertions WHERE id IN (SELECT value FROM json_each(?))'
      : k === 'intention' ? 'SELECT id FROM intentions WHERE id IN (SELECT value FROM json_each(?))'
        : `SELECT id FROM episodes WHERE id IN (SELECT value FROM json_each(?)) AND ep_kind IN ('event','diary','import')`;
    const exist = db.all(sql, ph(list)).map((r) => r.id);
    if (!exist.length) continue;
    const hid = new Set(db.all('SELECT owner_id AS id FROM suppressions WHERE owner_kind = ? AND owner_id IN (SELECT value FROM json_each(?))', k, ph(exist)).map((r) => r.id));
    const dead = tombstonedIds(db, k, exist);
    for (const id of exist) if (!hid.has(id) && !dead.has(id)) out.add(`${k}:${id}`);
  }
  return out;
}

/** 游标：给满一页时停在给出的最后一行；没满时跳到表里现在的最大 id（中间那些不相干的行不必再扫）。 */
const advance = (rows, since, max) => (rows.length >= LIVE_ROWS ? rows[rows.length - 1].id : Math.max(since, Number(max ?? 0)));

function live(core, since) {
  const db = core.store;
  const now = core.now();
  const rev = revOf(db);
  const tr = db.all(`SELECT id, owner_kind AS k, owner_id AS oid, t, w, d, reason FROM traces
                     WHERE id > ? AND +owner_kind IN ('assertion','episode','intention') ORDER BY id LIMIT ?`, since.trace, LIVE_ROWS);
  const inj = db.all("SELECT id, ts, setting_key AS k, layer, items_json FROM injections WHERE id > ? AND layer <> 'resident' ORDER BY id LIMIT ?", since.inj, LIVE_ROWS);
  const told = db.all(`SELECT id, at, setting_key AS k, owner_kind AS ok, owner_id AS oid, level FROM told_log
                       WHERE id > ? AND +owner_kind IN ('assertion','episode','intention') ORDER BY id LIMIT ?`, since.told, LIVE_ROWS);
  const max = cursorNow(db);
  const pairs = [];
  for (const r of tr) pairs.push([r.k, r.oid]);
  for (const r of told) pairs.push([r.ok, r.oid]);
  const injItems = inj.map((r) => { const items = j(r.items_json, []); return Array.isArray(items) ? items : []; });
  const epIds = new Set();
  for (const items of injItems) {
    for (const it of items) {
      const m = it && it.verdict !== 'omit' ? parseRef(it.id) : null;
      if (m && STAR_KINDS.includes(m.kind)) { pairs.push([m.kind, m.id]); if (m.kind === 'episode') epIds.add(m.id); }
    }
  }
  const ok = visibleStars(db, pairs);
  // 想起里不是星的情节（小结、lapse）算进 rawN
  const nonStarEp = new Set(epIds.size ? db.all(`SELECT id FROM episodes WHERE id IN (SELECT value FROM json_each(?)) AND ep_kind NOT IN ('event','diary','import')`, ph([...epIds])).map((r) => r.id) : []);
  const recalls = [];
  inj.forEach((r, n) => {
    const hits = [];
    let rawN = 0;
    for (const it of injItems[n]) {
      if (!it || it.verdict === 'omit') continue;
      const m = parseRef(it.id);
      if (m && STAR_KINDS.includes(m.kind) && !(m.kind === 'episode' && nonStarEp.has(m.id))) {
        if (ok.has(`${m.kind}:${m.id}`)) hits.push([it.id, layerCode(it.layer ?? r.layer)]);
      } else rawN++;
    }
    if (hits.length || rawN) recalls.push([r.ts, r.k ?? null, hits, rawN]);
  });
  return {
    now, rev,
    cursor: { inj: advance(inj, since.inj, max.inj), trace: advance(tr, since.trace, max.trace), told: advance(told, since.told, max.told) },
    traces: tr.filter((r) => ok.has(`${r.k}:${r.oid}`)).map((r) => [refOf(r.k, r.oid), r.t, r.w, r.d, reasonCode(r.reason)]),
    recalls,
    tells: told.filter((r) => ok.has(`${r.ok}:${r.oid}`)).map((r) => [r.at, r.k, refOf(r.ok, r.oid), r.level === 'full' ? 1 : 0]),
  };
}

// ── 看一眼 ────────────────────────────────────────────────────────────────

function peek(core, refs) {
  const db = core.store;
  const ms = [];
  const seen = new Set();
  for (const r of refs) {
    const m = parseRef(r);
    if (!m || !STAR_KINDS.includes(m.kind) || seen.has(r)) continue;
    seen.add(r);
    ms.push(m);
  }
  const ok = visibleStars(db, ms.map((m) => [m.kind, m.id]));
  const items = [];
  for (const m of ms) {
    if (!ok.has(`${m.kind}:${m.id}`)) continue;
    const ref = refOf(m.kind, m.id);
    if (m.kind === 'assertion') {
      const a = db.get('SELECT text, recorded_at FROM assertions WHERE id = ?', m.id);
      const src = db.get("SELECT min(at) AS at FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", m.id);
      items.push({ ref, title: null, text: clip(a.text, PEEK_TEXT), at: src?.at ?? a.recorded_at });
    } else if (m.kind === 'episode') {
      const e = db.get('SELECT title, header, narrative, t_start FROM episodes WHERE id = ?', m.id);
      const text = typeof e.header === 'string' && e.header.trim() ? e.header : e.narrative;
      items.push({ ref, title: e.title || null, text: clip(text, PEEK_TEXT), at: e.t_start });
    } else {
      const t = db.get('SELECT text, formed_at FROM intentions WHERE id = ?', m.id);
      items.push({ ref, title: null, text: clip(t.text, PEEK_TEXT), at: t.formed_at });
    }
  }
  return { items };
}

/**
 * 星图（D163）。q = {} / {maxStars?, recallDays?} → 快照；{since: {inj, trace, told}} → 实时增量；{peek: [ref…]} → 看一眼。
 * @param {object} core
 * @param {object} [q]
 */
export function starmap(core, q) {
  const o = parseQuery(q);
  if (o.mode === 'live') return live(core, o.since);
  if (o.mode === 'peek') return peek(core, o.refs);
  return snapshot(core, o);
}
