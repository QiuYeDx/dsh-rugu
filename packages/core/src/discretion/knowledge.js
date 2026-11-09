// 出现集合、谁知道、已知圈、知情圈、新知情者（§5.6、§9.3.1）。全部由代码按数据维护，不交给模型推断。
import crypto from 'node:crypto';
import { reachGrew } from '../contract/index.js';
import { dcfg, idList, parseJson, intersect, metric, warn, errCode } from './util.js';
import {
  selfId, managerIds, settingInfo, snapshotAt, settingChain, descriptorTraits, memoryFacts, rightsEquivalents, actorEntity, oneOnOneParties, platformNamed,
} from './facts.js';

const COMPLETENESS = ['exact', 'recent-speakers', 'unknown'];
const WHO_KINDS = ['entity', 'presence_set', 'setting'];
const BASES = ['presence', 'setting', 'subject', 'told_by_her', 'public', 'claimed'];
/**
 * 能证明「说话人在这个场合里」的感知（SQL 条件）：她在这里私下读到的（her-only、就是在这个场合读的：工具结果、素材）
 * 作者不在这里，不算；内容原属这个场合的（替主人看了这个群：setting_key ≠ perceived_in）作者确实在这里说过话，算（§5.3）。
 */
const IN_SETTING = "NOT (visible_to = 'her-only' AND perceived_in = setting_key)";

// ── 出现集合 ──────────────────────────────────────────────────────────────

/**
 * 记一个出现集合（§5.6 第 1 条）。和这个场合上一个同类的出现集合相同（名单、完整程度、旁观者）就复用那一行。同步，在调用方的事务里。
 * 完整名单里除了她没有别人（她私下读到的、心里想的：intake 记在她知道的那个场合），或者调用方明说 private：
 * 这是「这条只有她看到」，不是「这个场合里只有她」，记成 private，算场合的知情圈和谁在场时跳过。
 */
export function recordPresence(core, p) {
  const members = idList(p.members) ?? [];
  const completeness = COMPLETENESS.includes(p.completeness) ? p.completeness : 'unknown';
  const unknownObservers = !!p.unknownObservers;
  // 她自己的实体 id 建好以后不会变（intake 每条感知都调这里，省一次查询）；换库时 init 会清掉
  const st = core.state.discretion;
  const me = st?.selfId ?? selfId(core, null);
  if (st && me != null) st.selfId = me;
  const priv = p.private === true || (completeness === 'exact' && !unknownObservers && me != null && members.every((x) => x === me));
  const hash = crypto.createHash('sha256').update(JSON.stringify([members, completeness, unknownObservers, priv])).digest('hex').slice(0, 24);
  const last = core.store.get('SELECT id, members_hash FROM presence_sets WHERE setting_key = ? AND private = ? ORDER BY id DESC LIMIT 1', p.settingKey, priv ? 1 : 0);
  if (last && last.members_hash === hash) return last.id;
  const r = core.store.run(`INSERT INTO presence_sets(setting_key, at, members_json, completeness, unknown_observers, members_hash, private)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`, p.settingKey, Math.trunc(p.at), JSON.stringify(members), completeness, unknownObservers, hash, priv ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function presenceMembers(core, id, memo) {
  if (id == null) return null;
  const k = `ps:${id}`;
  if (memo?.has(k)) return memo.get(k);
  const row = core.store.get('SELECT id, setting_key, at, members_json, completeness, unknown_observers, private FROM presence_sets WHERE id = ?', id);
  const v = row ? { ...row, private: !!row.private, members: parseJson(row.members_json, []) } : null;
  memo?.set(k, v);
  return v;
}

/** 那个场合在某一时刻的出现集合（之前最新的一个；只有她自己的 private 集合不算场合里有谁）。 */
function presenceAt(core, settingKey, at, memo) {
  const k = `psAt:${settingKey}:${at}`;
  if (memo?.has(k)) return memo.get(k);
  const row = core.store.get(`SELECT id, at, members_json, completeness, unknown_observers FROM presence_sets
                              WHERE setting_key = ? AND at <= ? AND private = 0 ORDER BY at DESC, id DESC LIMIT 1`, settingKey, at);
  const v = row ? { ...row, members: parseJson(row.members_json, []) } : null;
  memo?.set(k, v);
  return v;
}

// ── 谁知道 ────────────────────────────────────────────────────────────────

/**
 * 写「谁知道」（§5.6）。同一条（记忆、谁、依据）已有就只把 since 提前，不重复写。在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {{whoKind: string, whoRef: string|number, since: number, basis: string, claimant?: number|null}[]} entries
 */
export function recordKnowledge(core, ref, entries) {
  const now = core.now();
  core.store.tx((db) => {
    for (const e of entries ?? []) {
      if (!e || !WHO_KINDS.includes(e.whoKind) || !BASES.includes(e.basis)) { metric(core, 'knowledge.badEntry'); continue; }
      const whoRef = String(e.whoRef ?? '');
      if (!whoRef) continue;
      const since = Number.isFinite(e.since) ? Math.trunc(e.since) : now;
      const old = db.get('SELECT id, since FROM known_by WHERE owner_kind = ? AND owner_id = ? AND who_kind = ? AND who_ref = ? AND basis = ? AND COALESCE(claimant, 0) = ?',
        ref.kind, ref.id, e.whoKind, whoRef, e.basis, e.claimant ?? 0);
      if (old) {
        if (since < old.since) db.run('UPDATE known_by SET since = ? WHERE id = ?', since, old.id);
        continue;
      }
      db.run('INSERT INTO known_by(owner_kind, owner_id, who_kind, who_ref, since, basis, claimant, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ref.kind, ref.id, e.whoKind, whoRef, since, e.basis, e.claimant ?? null, now);
    }
  });
}

/** 一个空的已知圈。 */
function emptyCircle() {
  return { entities: new Set(), settings: new Map(), presenceSets: new Set(), publicAvailable: false, claimed: [], derivedInference: false };
}

function addSetting(core, c, key, since, memo) {
  if (!key) return;
  // 任何人可见的场合：记为「公开可得」，不进已知圈（§5.6 第 7 条）
  const snap = snapshotAt(core, key, since, memo);
  if (!snap || snap.descriptor?.disclosure?.visibleTo === 'anyone') { if (snap) c.publicAvailable = true; return; }
  const prev = c.settings.get(key);
  if (prev == null || since < prev) c.settings.set(key, since);
}

function addPresence(core, c, id, memo) {
  const ps = presenceMembers(core, id, memo);
  if (!ps) return;
  c.presenceSets.add(id);
  for (const m of ps.members) c.entities.add(m);
}

function addRows(core, c, kind, id, memo) {
  for (const r of core.store.all('SELECT who_kind, who_ref, since, basis, claimant FROM known_by WHERE owner_kind = ? AND owner_id = ?', kind, id)) {
    if (r.basis === 'claimed') { c.claimed.push({ claimant: r.claimant ?? null, who: r.who_kind === 'entity' ? Number(r.who_ref) : null }); continue; }
    if (r.basis === 'public') { c.publicAvailable = true; continue; }
    if (r.who_kind === 'entity') c.entities.add(Number(r.who_ref));
    else if (r.who_kind === 'presence_set') addPresence(core, c, Number(r.who_ref), memo);
    else if (r.who_kind === 'setting') addSetting(core, c, r.who_ref, r.since, memo);
  }
}

/** 她自己发出、做出、想到的（不是别处原有的内容）。 */
const SELF_KINDS = new Set(['self-utterance', 'self-action', 'self-thought', 'on-my-behalf']);

/**
 * 一条感知的已知圈：直接从感知行推（visible_to + 出现集合 + 场合级，§2.2），不写 known_by 行。
 * her-only 的出现集合是她知道的那个场合（perceived_in）里只有她自己，不加那里的人；内容原属另一个场合
 *（setting_key ≠ perceived_in，例如替主人看了另一个群）时，那个场合的受众和原作者本来就看到了：场合级算进来（§5.3）。
 */
function perceptCircle(core, p, memo) {
  const c = emptyCircle();
  if (!p) return c;
  if (p.visible_to === 'setting-audience') {
    addSetting(core, c, p.setting_key, p.at, memo);
    if (p.presence_set_id != null) addPresence(core, c, p.presence_set_id, memo);
  } else if (p.visible_to === 'participants') {
    if (p.presence_set_id != null) addPresence(core, c, p.presence_set_id, memo);
  }
  const elsewhere = p.visible_to === 'her-only' && p.setting_key && p.perceived_in && p.setting_key !== p.perceived_in
    && !p.actor_self && !SELF_KINDS.has(p.kind);
  if (elsewhere) addSetting(core, c, p.setting_key, p.at, memo);
  // her-only 而且是她自己这边的（心里想的、工具结果、她在这里私下读到的）：只有她自己
  if ((p.visible_to !== 'her-only' || elsewhere) && p.actor_entity_id != null) c.entities.add(p.actor_entity_id);
  addRows(core, c, 'percept', p.id, memo);
  return c;
}

/** 几个已知圈的并集（知道其中任何一样的人：例如听到「我在另一个平台上叫明明」的人和知道那条链接的人都知道这层对应）。 */
export function unionCircles(list) {
  const out = emptyCircle();
  for (const c of list) {
    for (const e of c.entities) out.entities.add(e);
    for (const [k, since] of c.settings) { const prev = out.settings.get(k); if (prev == null || since < prev) out.settings.set(k, since); }
    for (const s of c.presenceSets ?? []) out.presenceSets.add(s);
    out.publicAvailable ||= !!c.publicAvailable;
    out.claimed.push(...(c.claimed ?? []));
  }
  return out;
}

/** 几个已知圈的交集（原文窗口、复述原话的派生内容）。 */
export function intersectCircles(list) {
  if (!list.length) return emptyCircle();
  const out = emptyCircle();
  out.entities = new Set(list[0].entities);
  out.settings = new Map(list[0].settings);
  out.publicAvailable = list.every((c) => c.publicAvailable);
  for (const c of list.slice(1)) {
    out.entities = intersect(out.entities, c.entities);
    for (const [k, since] of [...out.settings]) {
      if (!c.settings.has(k)) out.settings.delete(k);
      else out.settings.set(k, Math.max(since, c.settings.get(k)));
    }
  }
  // 交集里按场合级知道的，名单也按场合级算（窗口里各条的出现集合不同，不能逐 id 求交）
  out.claimed = list.flatMap((c) => c.claimed);
  return out;
}

/**
 * 一条记忆的已知圈（内部形式：settings 是 Map，entities 已展开出现集合）。
 * @returns {{entities: Set<number>, settings: Map<string, number>, presenceSets: Set<number>, publicAvailable: boolean,
 *            claimed: {claimant: number|null, who: number|null}[], selfOnly: boolean}}
 */
export function circleOf(core, m, memo) {
  const key = `circle:${m.kind}:${m.id}`;
  if (memo?.has(key)) return memo.get(key);
  const me = selfId(core, memo);
  let c;
  switch (m.kind) {
    case 'percept':
      c = perceptCircle(core, memoryFacts(core, m, memo).percept, memo);
      break;
    case 'window': {
      const f = memoryFacts(core, m, memo);
      const ps = f.perceptIds.map((id) => core.store.get('SELECT * FROM percepts WHERE id = ?', id)).filter(Boolean);
      c = intersectCircles(ps.map((p) => perceptCircle(core, p, memo)));
      addRows(core, c, 'window', m.id, memo);
      break;
    }
    case 'entity': {
      c = emptyCircle();
      addRows(core, c, 'entity', m.id, memo);
      // 名字证据和关系描述的来源：谁这样叫他、在哪些场合提到过他；他自己在哪儿说过话
      c.entities.add(m.id);
      // 场合的档案卡（§5.8）：这个场合的名字，这个场合的受众自它第一条感知起都知道；一对一的对方也知道
      const own = core.store.get('SELECT setting_key FROM entities WHERE id = ?', m.id)?.setting_key ?? null;
      if (own) {
        const first = core.store.get('SELECT at FROM percepts WHERE setting_key = ? ORDER BY id LIMIT 1', own)?.at;
        if (Number.isFinite(first)) addSetting(core, c, own, first, memo);
        for (const e of oneOnOneParties(core, own, memo)) c.entities.add(e);
        // 平台上的名字（D111 评审）：管理者也知道（机器人在哪些群、群叫什么，管理页上都看得到），对他说出来不是新的泄露
        if (platformNamed(core, own, memo)) for (const e of managerIds(core, memo)) c.entities.add(e);
      }
      for (const r of core.store.all('SELECT used_by, scope_setting_key, first FROM entity_names WHERE entity_id = ?', m.id)) {
        if (r.used_by) c.entities.add(r.used_by);
        if (r.scope_setting_key) addSetting(core, c, r.scope_setting_key, r.first, memo);
      }
      for (const r of core.store.all("SELECT setting_key, MIN(at) AS at FROM percepts WHERE actor_entity_id = ? AND visible_to = 'setting-audience' GROUP BY setting_key LIMIT 50", m.id)) {
        addSetting(core, c, r.setting_key, r.at, memo);
      }
      for (const d of core.store.all('SELECT anchor_entity_id, source_json FROM entity_descriptors WHERE entity_id = ?', m.id)) {
        const src = parseJson(d.source_json, {});
        if (Number.isSafeInteger(src.perceptId)) {
          const p = core.store.get('SELECT * FROM percepts WHERE id = ?', src.perceptId);
          if (p) {
            const pc = perceptCircle(core, p, memo);
            for (const e of pc.entities) c.entities.add(e);
            for (const [k, s] of pc.settings) addSetting(core, c, k, s, memo);
          }
        }
      }
      break;
    }
    case 'link': {
      // 跨平台的对应关系：「谁知道」默认只有管理者和当事人自己（§5.2、B3）
      c = emptyCircle();
      addRows(core, c, 'link', m.id, memo);
      const f = memoryFacts(core, m, memo);
      for (const e of f.involved) c.entities.add(e);
      for (const e of managerIds(core, memo)) c.entities.add(e);
      break;
    }
    default:
      c = emptyCircle();
      addRows(core, c, m.kind, m.id, memo);
  }
  const others = [...c.entities].filter((e) => e !== me);
  c.selfOnly = others.length === 0 && c.settings.size === 0 && !c.publicAvailable;
  memo?.set(key, c);
  return c;
}

/** knownCircle 的对外形式（KnownCircle）。 */
export function knownCircle(core, ref, at) {
  const c = circleOf(core, ref, new Map());
  return {
    entities: new Set(c.entities),
    settings: [...c.settings].map(([settingKey, since]) => ({ settingKey, since })),
    presenceSets: [...c.presenceSets],
    selfOnly: c.selfOnly,
    publicAvailable: c.publicAvailable,
    claimed: c.claimed.map((x) => ({ ...x })),
  };
}

// ── 知情圈 ────────────────────────────────────────────────────────────────

/** 不认识的场合：按最公开、最不确定处理（fail closed）。 */
export function unknownAudience(settingKey) {
  return {
    settingKey, snapshotId: null, members: null, recentSpeakers: [], completeness: 'unknown', unknownObservers: true,
    exposureRank: 3, persistenceRank: 2, size: 'unknown', preSendGate: false, canHold: false,
    known: false, publicLike: true, oneOnOne: false, visibleTo: 'anyone', persistence: 'public-permanent', parentKey: null, adapter: null, label: '',
    attributedToHer: true,
  };
}

/**
 * 目标场合的知情圈（§9.3.1）：当前快照 + 最近的出现集合（含 adapter.members() 写进来的）+ 最近亲自发过言的人。
 * @returns {import('../core-types.js').Audience & {known: boolean, publicLike: boolean, oneOnOne: boolean, visibleTo: string}}
 */
export function audienceOf(core, settingKey, at, memo) {
  const k = `aud:${settingKey}:${at}`;
  if (memo?.has(k)) return memo.get(k);
  const info = settingInfo(core, settingKey, memo);
  const d = info?.snapshot?.descriptor;
  const t = descriptorTraits(d);
  if (!info || !t) { const a = unknownAudience(settingKey); memo?.set(k, a); return a; }
  const cfg = core.config.get();
  const me = selfId(core, memo);
  const windowMs = cfg.recall.presentSpeakerWindowMin * 60_000;
  const recentSpeakers = core.store.all(
    `SELECT DISTINCT actor_entity_id AS id FROM percepts WHERE setting_key = ? AND at >= ? AND at <= ? AND actor_entity_id IS NOT NULL
       AND actor_self = 0 AND kind IN ('utterance','action','content','reminder') AND ${IN_SETTING} ORDER BY id`,
    settingKey, at - windowMs, at).map((r) => r.id).filter((id) => id !== me);
  let members = null;
  let completeness = t.membersKnown === 'exact' ? 'exact' : t.membersKnown === 'recent-speakers' ? 'recent-speakers' : 'unknown';
  const ps = presenceAt(core, settingKey, at, memo);
  if (completeness === 'exact') {
    if (ps && ps.completeness === 'exact') members = idList(ps.members);
    else if (t.size === 2) {
      // 一对一：成员就是她和唯一一个在这里说过话的人（代码可核验）
      const others = core.store.all(`SELECT DISTINCT actor_entity_id AS id FROM percepts WHERE setting_key = ? AND actor_entity_id IS NOT NULL AND actor_self = 0 AND ${IN_SETTING} LIMIT 3`, settingKey)
        .map((r) => r.id).filter((id) => id !== me);
      if (others.length === 1) members = idList([me, others[0]].filter((x) => x != null));
    }
    if (!members) completeness = 'recent-speakers';
  }
  const a = {
    settingKey, snapshotId: info.snapshot?.id ?? null, members, recentSpeakers, completeness,
    unknownObservers: t.unknownObservers || !!ps?.unknown_observers,
    exposureRank: t.exposureRank, persistenceRank: t.persistenceRank, size: t.size,
    preSendGate: t.preSendGate, canHold: t.canHold,
    known: true, publicLike: t.publicLike, oneOnOne: t.oneOnOne, visibleTo: t.visibleTo, persistence: t.persistence,
    parentKey: info.parentKey, adapter: info.adapter, label: info.label ?? '', herModerates: t.herModerates, attributedToHer: t.attributedToHer,
  };
  memo?.set(k, a);
  return a;
}

/** 知情圈里能点得出来的人（不含她自己）。 */
export function audiencePeople(core, a, memo) {
  const me = selfId(core, memo);
  const base = a.members ?? a.recentSpeakers ?? [];
  return [...new Set(base)].filter((x) => x != null && x !== me);
}

/** 知情圈是不是只有有管理权限的人（和管理者一对一，或在场的全是管理者，名单完整）。 */
export function managerOnly(core, a, memo) {
  if (!a.known || a.unknownObservers || a.completeness !== 'exact' || !a.members) return false;
  const people = audiencePeople(core, a, memo);
  if (!people.length) return false;
  const mgr = managerIds(core, memo);
  return people.every((p) => mgr.has(p));
}

/** 某个人第一次出现在这个场合的时间（出现集合或亲自发言）；没有记录返回 null。 */
export function firstSeen(core, entityId, settingKey, memo) {
  const k = `first:${entityId}:${settingKey}`;
  if (memo?.has(k)) return memo.get(k);
  const a = core.store.get(`SELECT MIN(at) AS at FROM presence_sets WHERE setting_key = ? AND private = 0 AND EXISTS (SELECT 1 FROM json_each(members_json) WHERE value = ?)`, settingKey, entityId)?.at;
  const b = core.store.get(`SELECT MIN(at) AS at FROM percepts WHERE setting_key = ? AND actor_entity_id = ? AND ${IN_SETTING}`, settingKey, entityId)?.at;
  const v = [a, b].filter((x) => x != null).reduce((m, x) => Math.min(m, x), Infinity);
  const out = Number.isFinite(v) ? v : null;
  memo?.set(k, out);
  return out;
}

/**
 * 这个人是不是在 since 之后才加入这个场合的（§5.6 第 2 条「时间 t 之后才加入的新成员」）。只认证据，不靠猜：
 *   - 那一刻的出现集合是完整名单（exact）：不在名单里（同一个人经权利层确认的其他身份也不在）→ 后来加入的；
 *   - 名单不完整（只看得到最近说话的人）：只有「入群」这类 presence 感知证明他是 since 之后才来的，才算；
 *     只是 since 之后才第一次开口的人，多半一直在场没说话，仍按场合级的知道覆盖。
 */
export function joinedAfter(core, entityId, settingKey, since, memo) {
  const k = `joined:${entityId}:${settingKey}:${since}`;
  if (memo?.has(k)) return memo.get(k);
  const eq = [...(rightsEquivalents(core, [entityId], memo).get(entityId) ?? new Set([entityId]))];
  let out = false;
  const ps = presenceAt(core, settingKey, since, memo);
  if (ps && ps.completeness === 'exact') {
    out = !eq.some((x) => ps.members.includes(x));
  } else {
    const ph = eq.map(() => '?').join(',');
    const before = core.store.get(`SELECT 1 AS x FROM percepts WHERE setting_key = ? AND actor_entity_id IN (${ph}) AND at <= ? AND ${IN_SETTING} LIMIT 1`, settingKey, ...eq, since)
      ?? core.store.get(`SELECT 1 AS x FROM presence_sets WHERE setting_key = ? AND at <= ? AND private = 0 AND EXISTS (SELECT 1 FROM json_each(members_json) WHERE value IN (${ph})) LIMIT 1`,
        settingKey, since, ...eq);
    if (!before) {
      out = !!core.store.get(`SELECT 1 AS x FROM percepts WHERE setting_key = ? AND kind = 'presence' AND actor_entity_id IN (${ph}) AND at > ? LIMIT 1`,
        settingKey, ...eq, since);
    }
  }
  memo?.set(k, out);
  return out;
}

/** 一个场合级的「知道」展开成那一刻在场的人（下限：名单不全时只算看得见的）。 */
function settingKnowers(core, key, since, memo) {
  const ps = presenceAt(core, key, since, memo);
  const s = new Set(ps?.members ?? []);
  // 同一时刻亲自发过言的人（名单不全的场合）
  for (const r of core.store.all(`SELECT DISTINCT actor_entity_id AS id FROM percepts WHERE setting_key = ? AND at <= ? AND at >= ? AND actor_entity_id IS NOT NULL AND ${IN_SETTING}`,
    key, since, since - 30 * 60_000)) s.add(r.id);
  return s;
}

/**
 * 新知情者 N = 知情圈(目标) − 已知圈(这条记忆)（§9.3.1）。
 * 已知判断走权利层：同一个人的另一个经确认的身份也算知道（§5.2「计算谁已经知道」）。
 * @returns {{people: number[], unknown: number[], unknownRemainder: boolean, empty: boolean, count: number,
 *            sameSetting: {settingKey: string, since: number, reachGrew: boolean}|null, lateMembers: number[], knownCount: number}}
 */
export function newKnowers(core, circle, a, memo) {
  const people = audiencePeople(core, a, memo);
  const chain = a.known ? settingChain(core, a.settingKey, memo) : [];
  let same = null;
  for (const key of chain) {
    if (circle.settings.has(key)) {
      const since = circle.settings.get(key);
      if (!same || since < same.since) same = { settingKey: key, since };
    }
  }
  if (same) {
    // 场合的可见范围从那以后变大了吗（§9.3.2 A1(b)）
    const then = snapshotAt(core, same.settingKey, same.since, memo)?.descriptor;
    const nowD = settingInfo(core, a.settingKey, memo)?.snapshot?.descriptor;
    same.reachGrew = !then || !nowD ? true : (() => { try { return reachGrew(then, nowD); } catch { return true; } })();
  }
  const known = new Set(circle.entities);
  for (const [key, since] of circle.settings) {
    if (same && key === same.settingKey && !same.reachGrew) continue;
    for (const e of settingKnowers(core, key, since, memo)) known.add(e);
  }
  const eq = rightsEquivalents(core, people, memo);
  const lateMembers = [];
  const unknown = [];
  for (const p of people) {
    if (known.has(p) || [...(eq.get(p) ?? [])].some((x) => known.has(x))) continue;
    if (same && !same.reachGrew) {
      // 场合级的知道覆盖这个场合的受众；只有有证据是之后才加入的人单独算（晚到的成员，§5.6 第 2 条）
      if (joinedAfter(core, p, same.settingKey, same.since, memo)) lateMembers.push(p);
      continue;
    }
    unknown.push(p);
  }
  const coveredAsWhole = !!(same && !same.reachGrew);
  const unknownRemainder = !coveredAsWhole && (!a.known || a.completeness !== 'exact' || a.unknownObservers || !a.members);
  const knownCount = people.length - unknown.length - lateMembers.length;
  let count = unknown.length + lateMembers.length;
  if (unknownRemainder) count = typeof a.size === 'number' ? Math.max(count + 1, a.size - 1 - knownCount) : Infinity;
  return {
    people, unknown, unknownRemainder, lateMembers, sameSetting: same,
    empty: unknown.length === 0 && lateMembers.length === 0 && !unknownRemainder,
    count, knownCount,
  };
}

// ── adapter.members()（能列成员的平台） ─────────────────────────────────────

/**
 * 后台刷新一个场合的成员名单（targetFor 调；结果进出现集合，下一次 audienceOf 就用得上）。
 * 需要适配器自己的 SettingId（核心只存 HMAC，推不回来），所以只有调用方给了 settingId 才能做。
 */
export function refreshMembers(core, { settingKey, settingId, adapterId, at }) {
  const st = core.state.discretion;
  const cfg = dcfg(core);
  const adapter = adapterId ? core.adapters.get(adapterId) : null;
  if (!adapter || typeof adapter.members !== 'function' || !settingId || core.readOnly) return;
  const last = st.membersAt.get(settingKey);
  if (last != null && at - last < cfg.members.refreshMs) return;
  st.membersAt.set(settingKey, at);
  Promise.resolve().then(() => adapter.members(settingId)).then((list) => {
    if (!Array.isArray(list) || core.store.closed) return;
    core.store.tx(() => {
      const ids = [];
      let unresolved = 0;
      for (const actor of list) {
        let id = actorEntity(core, actor, null);
        if (id == null) {
          try { id = core.mods.entities.resolveActor(core, actor, { adapterId, settingKey, at })?.entityId ?? null; } catch { id = null; }
        }
        if (id != null) ids.push(id); else unresolved += 1;
      }
      const me = selfId(core, null);
      if (me != null) ids.push(me);
      const info = settingInfo(core, settingKey, null);
      // 有认不出的成员：名单不算完整（认不出的人按新知情者算）
      recordPresence(core, { settingKey, at, members: ids, completeness: unresolved === 0 ? 'exact' : 'recent-speakers',
        unknownObservers: !!info?.snapshot?.descriptor?.audience?.unknownObservers || unresolved > 0 });
    });
  }).catch((e) => { warn(core, 'members', { error: errCode(e) }); metric(core, 'members.error'); });
}
