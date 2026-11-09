// discretion 读别的模块的数据（只读 SQL，schema 就是契约；语义在别的模块的，调它们的读函数）。
// 每次判定用一个 memo（Map）缓存同一批里重复读的东西，免得一轮 gate 里同一行读几十遍。
import { parseJson, setOf, soft } from './util.js';
import { exposureRank, persistenceRank, isOneOnOne, isPublicLike } from '../contract/index.js';
import { refOf } from '../store/index.js';

/** 权利层认的链接（§5.2「认得 ≠ 权利」）。 */
export const RIGHTS_DECIDERS = Object.freeze(['platform', 'mutual-claim', 'anchor-confirmed', 'owner']);
/**
 * 「别告诉主人」这类请求本身报 T1 时用的理由（§9.3.7）。它不让内容本身变成 T1。encode 核验时发现 deny 里有管理者也用它
 *（同一件事同一个原因，admin 合成一条）；admin 按原因分开记，同一条消息既是设定、又带着「别告诉主人」时两件都留着（S28、S29）。
 */
export const SECRECY_REQUEST_REASON = 'secrecy-request';

const memoGet = (memo, key, fn) => {
  if (!memo) return fn();
  if (memo.has(key)) return memo.get(key);
  const v = fn();
  memo.set(key, v);
  return v;
};

// ── 她自己、管理者、关系 ────────────────────────────────────────────────

export function selfId(core, memo) {
  return memoGet(memo, 'self', () => core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null);
}

/** 有管理权限的实体（authority ≠ none）。只读属性，不认名字。 */
export function managerIds(core, memo) {
  return memoGet(memo, 'managers', () => setOf(core.store.all("SELECT id FROM entities WHERE authority IN ('principal','delegated')").map((r) => r.id)));
}

export function entityRow(core, id, memo) {
  if (id == null) return null;
  return memoGet(memo, `ent:${id}`, () => core.store.get(
    'SELECT id, kind, status, display_name, is_self, closeness, authority, setting_key FROM entities WHERE id = ?', id) ?? null);
}

export function bond(core, id, memo) {
  const r = entityRow(core, id, memo);
  return { closeness: r?.closeness ?? 0, authority: r?.authority ?? 'none', isSelf: !!r?.is_self, known: !!r };
}

/** 是不是「具体的个人」（entities 的语义；读不到时按是处理——涉及别人是更严的一边）。 */
export function isIndividual(core, id, memo) {
  if (id == null) return false;
  return memoGet(memo, `ind:${id}`, () => {
    const r = entityRow(core, id, memo);
    if (r?.is_self) return false;
    return soft(core, 'entities.isIndividual', () => !!core.mods.entities.isIndividual(core, id), true);
  });
}

/**
 * 权利层的等价：同一个实体，或者 rel='same' 且 decided_by 在权利集合里的直接链接（§5.2）。
 * @returns {Map<number, Set<number>>} 每个 id → 包含它自己在内的等价集合
 */
export function rightsEquivalents(core, ids, memo) {
  const out = new Map();
  const need = [];
  for (const id of ids) {
    if (id == null) continue;
    const k = `req:${id}`;
    if (memo?.has(k)) out.set(id, memo.get(k));
    else need.push(id);
  }
  if (need.length) {
    const ph = need.map(() => '?').join(',');
    const deciders = RIGHTS_DECIDERS.map(() => '?').join(',');
    const rows = core.store.all(
      `SELECT a, b FROM entity_links WHERE rel = 'same' AND decided_by IN (${deciders}) AND (a IN (${ph}) OR b IN (${ph}))`,
      ...RIGHTS_DECIDERS, ...need, ...need);
    for (const id of need) {
      const s = new Set([id]);
      for (const r of rows) { if (r.a === id) s.add(r.b); if (r.b === id) s.add(r.a); }
      out.set(id, s);
      memo?.set(`req:${id}`, s);
    }
  }
  return out;
}

/** claimant 能不能以 subject 本人的身份行使权利（entities.rightsHolder；读不到时退回同样语义的 SQL）。 */
export function rightsHolder(core, claimant, subject, memo) {
  if (claimant == null || subject == null) return false;
  if (claimant === subject) return true;
  return memoGet(memo, `rh:${claimant}:${subject}`, () => {
    try { return !!core.mods.entities.rightsHolder(core, claimant, subject); } catch {
      return rightsEquivalents(core, [claimant], memo).get(claimant)?.has(subject) ?? false;
    }
  });
}

/**
 * 和某个人有已知关系的实体：关系描述（两个方向）、同一个人的其他身份（same / maybe_same 链接）。
 * 用于 B1 的「他的已知关系人」和 B5 的「接收者和主体没有已知关系」。
 */
export function relatedEntities(core, id, memo) {
  if (id == null) return new Set();
  return memoGet(memo, `rel:${id}`, () => {
    const s = new Set();
    for (const r of core.store.all('SELECT entity_id, anchor_entity_id FROM entity_descriptors WHERE entity_id = ? OR anchor_entity_id = ?', id, id)) {
      s.add(r.entity_id === id ? r.anchor_entity_id : r.entity_id);
    }
    for (const r of core.store.all("SELECT a, b FROM entity_links WHERE rel IN ('same','maybe_same') AND (a = ? OR b = ?)", id, id)) {
      s.add(r.a === id ? r.b : r.a);
    }
    s.delete(id);
    return s;
  });
}

/**
 * 经确认的关系（用来**放松**一条底线时只认它，例如 B5「接收者和主体有已知关系」）：别人给出的关系描述（不含当事人自称的），
 * 以及权利层认的同一个人。自称的关系、拿不准的 maybe_same 只能用来收紧（认得 ≠ 权利，§5.2、§9.6「冒充没有账号的人」）。
 */
export function confirmedRelations(core, id, memo) {
  if (id == null) return new Set();
  return memoGet(memo, `crel:${id}`, () => {
    const s = new Set();
    for (const r of core.store.all("SELECT entity_id, anchor_entity_id FROM entity_descriptors WHERE (entity_id = ? OR anchor_entity_id = ?) AND basis <> 'self-claim'", id, id)) {
      s.add(r.entity_id === id ? r.anchor_entity_id : r.entity_id);
    }
    for (const x of rightsEquivalents(core, [id], memo).get(id) ?? []) s.add(x);
    s.delete(id);
    return s;
  });
}

/**
 * 这些感知是哪些跨命名空间身份链接（same / maybe_same）的证据（entity_links.evidence_json 里的感知引用）。
 * 这样的感知说的就是那层对应（「我在另一个平台上叫明明」），含它们的原文窗口、情节、事实也带着这层对应（B3，§5.2）。
 * @returns {number[]} 链接 id
 */
export function identityEvidenceLinks(core, perceptIds, memo) {
  const ids = [...new Set(perceptIds ?? [])].filter((x) => Number.isSafeInteger(x)).slice(0, 200);
  if (!ids.length) return [];
  return memoGet(memo, `idlinks:${ids.join(',')}`, () => core.store.all(
    `SELECT DISTINCT l.id FROM entity_links l, json_each(l.evidence_json) j
      WHERE l.cross_namespace = 1 AND l.rel IN ('same','maybe_same') AND j.value IN (${ids.map(() => '?').join(',')}) ORDER BY l.id`,
    ...ids.map((id) => refOf('percept', id))).map((r) => r.id));
}

/**
 * 这条记忆来自哪一侧（来源场合的适配器：原场合、每条来源的感知场合）。读不到来源场合的返回空集合（调用方不据此判断）。
 * @returns {Set<string>}
 */
export function memorySides(core, f, memo) {
  return memoGet(memo, `sides:${f.kind}:${f.id}`, () => {
    const keys = new Set([f.settingKey, ...(f.sources ?? []).map((s) => s.perceived_in)].filter(Boolean));
    const pids = (f.sources ?? []).map((s) => s.percept_id).filter((x) => x != null).slice(0, 200);
    if (pids.length) {
      for (const r of core.store.all(`SELECT DISTINCT setting_key FROM percepts WHERE id IN (${pids.map(() => '?').join(',')})`, ...pids)) keys.add(r.setting_key);
    }
    const out = new Set();
    for (const k of keys) { const s = settingInfo(core, k, memo); if (s?.adapter) out.add(s.adapter); }
    return out;
  });
}

/** 这个身份在这一侧（适配器）露过面吗：在那边的场合说过话，或者那边有人这样叫过他。 */
export function seenOnSide(core, entityId, adapter, memo) {
  if (entityId == null || !adapter) return false;
  return memoGet(memo, `side:${entityId}:${adapter}`, () => !!(
    core.store.get('SELECT 1 AS x FROM percepts p JOIN settings s ON s.key = p.setting_key WHERE p.actor_entity_id = ? AND s.adapter = ? LIMIT 1', entityId, adapter)
    ?? core.store.get('SELECT 1 AS x FROM entity_names n JOIN settings s ON s.key = n.scope_setting_key WHERE n.entity_id = ? AND s.adapter = ? LIMIT 1', entityId, adapter)));
}

/** 「多半是同一个人」的其他身份（maybe_same 也算，B3 推断用）。 */
export function sameishLinks(core, id, memo) {
  if (id == null) return [];
  return memoGet(memo, `same:${id}`, () => core.store.all(
    "SELECT id, a, b, rel, decided_by, cross_namespace FROM entity_links WHERE rel IN ('same','maybe_same') AND cross_namespace = 1 AND (a = ? OR b = ?)", id, id)
    .map((r) => ({ linkId: r.id, other: r.a === id ? r.b : r.a, rel: r.rel, rights: r.rel === 'same' && RIGHTS_DECIDERS.includes(r.decided_by) })));
}

export function displayName(core, id, memo) {
  const r = entityRow(core, id, memo);
  if (!r) return null;
  if (r.display_name) return r.display_name;
  const d = core.store.get(
    `SELECT d.relation, e.display_name AS anchor FROM entity_descriptors d LEFT JOIN entities e ON e.id = d.anchor_entity_id
      WHERE d.entity_id = ? ORDER BY d.id LIMIT 1`, id);
  if (d) return d.anchor ? `${d.anchor}的${d.relation}` : d.relation;
  return null;
}

// ── 场合 ────────────────────────────────────────────────────────────────

function snapshotOut(row) {
  if (!row) return null;
  const descriptor = parseJson(row.descriptor_json, null);
  return {
    id: row.id, settingKey: row.setting_key, at: row.at, descriptor,
    exposureRank: row.exposure_rank, persistenceRank: row.persistence_rank, reachHash: row.reach_hash,
  };
}

/**
 * 一对一场合（当前快照的公开程度是最低的一档，contract.exposureRank = 0）里她以外的参与者：最近的出现集合，
 * 没有就看最近的感知的说话人。不是一对一、不认识的场合返回 []。
 * @returns {number[]}
 */
export function oneOnOneParties(core, settingKey, memo) {
  if (!settingKey) return [];
  return memoGet(memo, `1on1:${settingKey}`, () => {
    const snap = settingInfo(core, settingKey, memo)?.snapshot;
    if (!snap || snap.exposureRank !== 0) return [];
    const me = core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null;
    const out = new Set();
    const ps = core.store.get('SELECT members_json FROM presence_sets WHERE setting_key = ? ORDER BY at DESC, id DESC LIMIT 1', settingKey);
    for (const id of parseJson(ps?.members_json, []) ?? []) if (Number.isInteger(id) && id !== me) out.add(id);
    if (!out.size) {
      for (const r of core.store.all('SELECT actor_entity_id AS e FROM percepts WHERE setting_key = ? AND actor_self = 0 ORDER BY id DESC LIMIT 50', settingKey)) {
        if (Number.isInteger(r.e) && r.e !== me) out.add(r.e);
      }
    }
    return [...out];
  });
}

/** 场合的当前状态（settings + 当前快照）。不认识的场合返回 null（调用方 fail closed）。 */
export function settingInfo(core, key, memo) {
  if (!key) return null;
  return memoGet(memo, `set:${key}`, () => {
    const s = core.store.get('SELECT * FROM settings WHERE key = ?', key);
    if (!s) return null;
    const snap = snapshotOut(s.current_snapshot_id
      ? core.store.get('SELECT * FROM setting_snapshots WHERE id = ?', s.current_snapshot_id)
      : core.store.get('SELECT * FROM setting_snapshots WHERE setting_key = ? ORDER BY at DESC, id DESC LIMIT 1', key));
    // 【D111】labelKind：生效的称呼是真名还是一句说法（主人起的一定是真名）；platformName：生效的是平台上的名字（见 platformNamed）
    const owner = typeof s.owner_label === 'string' && s.owner_label !== '';
    return { key: s.key, adapter: s.adapter, label: s.label, labelKind: owner || s.label_kind !== 'description' ? 'name' : 'description',
      platformName: !owner && s.label_kind === 'name' && s.label_origin === 'platform',
      stability: s.stability, parentKey: s.parent_key ?? null, entityId: s.entity_id ?? null, snapshot: snap };
  });
}

/**
 * 【D111 评审】这个场合现在叫的是不是平台上的名字（群名、机器人的备注）：那是场合里的人起的，主人和部署的人都没过目，
 * 它本身就是那个场合的人知道的事（像那里说过的话一样）。关口①据此把场合的档案卡当成涉及别人的（A2 不放行）、
 * 圈子是那里的成员和管理者（knowledge.circleOf）：只在知道它的人面前说出名字，别处写成「在另一个群里」，或交给第二段。
 * 主人起了名字（owner_label）、配置里写的名字、一句说法：都不是。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string|null} key
 * @param {Map<string, any>} [memo]
 */
export function platformNamed(core, key, memo) {
  return !!settingInfo(core, key, memo)?.platformName;
}

/** 某个时刻那个场合的快照（at 之前最新的一份；at 比第一份还早就用第一份）。 */
export function snapshotAt(core, key, at, memo) {
  return memoGet(memo, `snapAt:${key}:${at}`, () => snapshotOut(
    core.store.get('SELECT * FROM setting_snapshots WHERE setting_key = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1', key, at)
    ?? core.store.get('SELECT * FROM setting_snapshots WHERE setting_key = ? ORDER BY at, id LIMIT 1', key)));
}

/** 这个场合和它的祖先（评论串 ⊂ 评论区），自己在最前。 */
export function settingChain(core, key, memo) {
  const out = [];
  let k = key;
  for (let i = 0; k && i < 6 && !out.includes(k); i++) {
    out.push(k);
    k = settingInfo(core, k, memo)?.parentKey ?? null;
  }
  return out;
}

/** 描述 → 几个推理用的属性（只读抽象属性，§9.7）。 */
export function descriptorTraits(d) {
  if (!d) return null;
  return {
    exposureRank: exposureRank(d), persistenceRank: persistenceRank(d),
    oneOnOne: isOneOnOne(d), publicLike: isPublicLike(d),
    visibleTo: d.disclosure?.visibleTo, persistence: d.disclosure?.persistence,
    size: d.audience?.size ?? 'unknown', unknownObservers: !!d.audience?.unknownObservers,
    membersKnown: d.audience?.membersKnown ?? 'unknown',
    preSendGate: !!d.capabilities?.preSendGate, canHold: !!d.capabilities?.canHold,
    herModerates: !!d.ownership?.herModerates, attributedToHer: !!d.disclosure?.attributedToHer,
  };
}

// ── 记忆单元本身 ────────────────────────────────────────────────────────

/**
 * 一个记忆单元的事实（判断用，不含规范）：文字、涉及的实体、主体、说话人 / 断言者、来源感知、来源场合。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} m
 * @param {Map} [memo]
 */
export function memoryFacts(core, m, memo) {
  return memoGet(memo, `facts:${m.kind}:${m.id}`, () => readFacts(core, m));
}

function blank(m) {
  return {
    kind: m.kind, id: m.id, exists: false, text: null, settingKey: null, at: null,
    involved: new Set(), subjects: new Set(), speakers: new Set(), asserters: new Set(),
    perceptIds: [], sources: [], visibleTo: null, normState: null, certainty: null, derivedSelf: false,
  };
}

function addSources(core, f, ownerKind, id) {
  const rows = core.store.all(
    'SELECT percept_id, snapshot_id, perceived_in, speaker, asserter, mode, hop, at FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY id',
    ownerKind, id);
  f.sources = rows;
  for (const r of rows) {
    if (r.speaker != null) { f.speakers.add(r.speaker); f.involved.add(r.speaker); }
    if (r.asserter != null) { f.asserters.add(r.asserter); f.involved.add(r.asserter); }
    if (r.percept_id != null) f.perceptIds.push(r.percept_id);
  }
  if (!f.settingKey && rows.length) {
    const p = rows.find((r) => r.percept_id != null);
    const pr = p ? core.store.get('SELECT setting_key, at FROM percepts WHERE id = ?', p.percept_id) : null;
    f.settingKey = pr?.setting_key ?? rows[0].perceived_in ?? null;
    f.at = f.at ?? pr?.at ?? rows[0].at ?? null;
  }
}

function readFacts(core, m) {
  const f = blank(m);
  const st = core.store;
  switch (m.kind) {
    case 'percept': {
      const p = st.get(`SELECT id, setting_key, perceived_in, snapshot_id, presence_set_id, visible_to, at, actor_entity_id, actor_self, addressed,
                               kind, text, text_state, norm_state, standing, evidential FROM percepts WHERE id = ?`, m.id);
      if (!p) return f;
      Object.assign(f, { exists: true, settingKey: p.setting_key, at: p.at, visibleTo: p.visible_to, normState: p.norm_state, percept: p });
      f.text = p.text_state === 'retracted' ? null : p.text;
      if (p.actor_entity_id != null) { f.involved.add(p.actor_entity_id); f.speakers.add(p.actor_entity_id); }
      f.perceptIds = [p.id];
      f.derivedSelf = p.kind === 'self-thought';
      break;
    }
    case 'window': {
      const w = st.get('SELECT * FROM raw_windows WHERE id = ?', m.id);
      if (!w) return f;
      Object.assign(f, { exists: true, settingKey: w.setting_key, at: w.t_start, text: w.text, visibleTo: w.visible_to ?? null });
      // 成员以 members_json 为准（同一段 id 里别的 visible_to、别的种类的感知不是成员，D10）；老数据没有就退回 id 范围
      const ids = (parseJson(w.members_json, null) ?? []).map(Number).filter((x) => Number.isSafeInteger(x) && x > 0).slice(0, 50);
      const ps = ids.length
        ? st.all(`SELECT id, actor_entity_id FROM percepts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ...ids)
        : st.all('SELECT id, actor_entity_id FROM percepts WHERE setting_key = ? AND id BETWEEN ? AND ? ORDER BY id',
          w.setting_key, w.first_percept, w.last_percept);
      f.perceptIds = ps.map((r) => r.id);
      for (const r of ps) if (r.actor_entity_id != null) { f.involved.add(r.actor_entity_id); f.speakers.add(r.actor_entity_id); }
      break;
    }
    case 'episode': {
      const e = st.get('SELECT id, setting_key, ep_kind, title, header, narrative, t_start, participants_json FROM episodes WHERE id = ?', m.id);
      if (!e) return f;
      Object.assign(f, { exists: true, settingKey: e.setting_key, at: e.t_start, epKind: e.ep_kind });
      f.text = [e.header, e.narrative].filter(Boolean).join(' ') || e.title || '';
      for (const id of parseJson(e.participants_json, [])) { f.involved.add(id); f.subjects.add(id); }
      addSources(core, f, 'episode', m.id);
      break;
    }
    case 'assertion': {
      const a = st.get('SELECT id, text, kind_hint, certainty, predicate, superseded_by, recorded_at FROM assertions WHERE id = ?', m.id);
      if (!a) return f;
      Object.assign(f, { exists: true, text: a.text, at: a.recorded_at, certainty: a.certainty, kindHint: a.kind_hint });
      for (const r of st.all('SELECT entity_id, role FROM assertion_entities WHERE assertion_id = ?', m.id)) {
        f.involved.add(r.entity_id);
        if (r.role === 'subject') f.subjects.add(r.entity_id);
        if (r.role === 'speaker') f.speakers.add(r.entity_id);
        if (r.role === 'asserter') f.asserters.add(r.entity_id);
      }
      addSources(core, f, 'assertion', m.id);
      f.derivedSelf = a.certainty === 'inferred';
      break;
    }
    case 'entity': {
      const e = st.get('SELECT id, kind, display_name, is_self, setting_key FROM entities WHERE id = ?', m.id);
      if (!e) return f;
      const ds = st.all('SELECT anchor_entity_id, relation, source_json FROM entity_descriptors WHERE entity_id = ?', m.id);
      Object.assign(f, { exists: true, settingKey: e.setting_key ?? null, descriptors: ds });
      f.involved.add(e.id);
      f.subjects.add(e.id);
      for (const d of ds) f.involved.add(d.anchor_entity_id);
      // 场合的档案卡（§5.8）：一对一的场合（公开程度最低的一档）就是她和对方的关系，它的名字说出去就是在说「她私下和谁聊」，
      // 对方也算这张卡涉及的人（A2 不放行，involves_others 为真）。群的档案卡只涉及群本身
      for (const id of oneOnOneParties(core, e.setting_key)) f.involved.add(id);
      f.text = [e.display_name, ...ds.map((d) => d.relation)].filter(Boolean).join(' / ');
      break;
    }
    case 'impression': {
      const i = st.get('SELECT id, entity_id, layer, text, built_at FROM entity_impressions WHERE id = ?', m.id);
      if (!i) return f;
      Object.assign(f, { exists: true, text: i.text, at: i.built_at, layer: i.layer });
      f.involved.add(i.entity_id);
      f.subjects.add(i.entity_id);
      break;
    }
    case 'intention': {
      const t = st.get('SELECT id, target_entity_id, act, text, about_kind, about_id, formed_at FROM intentions WHERE id = ?', m.id);
      if (!t) return f;
      Object.assign(f, { exists: true, text: t.text || t.act, at: t.formed_at, intention: t });
      if (t.target_entity_id != null) { f.involved.add(t.target_entity_id); f.subjects.add(t.target_entity_id); }
      addSources(core, f, 'intention', m.id);
      break;
    }
    case 'storyline': {
      const s = st.get('SELECT id, setting_key, text, updated_at FROM storylines WHERE id = ?', m.id);
      if (!s) return f;
      Object.assign(f, { exists: true, text: s.text, settingKey: s.setting_key, at: s.updated_at });
      break;
    }
    case 'community': {
      const c = st.get('SELECT id, setting_key, label, summary, members_json, built_at FROM communities WHERE id = ?', m.id);
      if (!c) return f;
      Object.assign(f, { exists: true, text: [c.label, c.summary].filter(Boolean).join('：'), settingKey: c.setting_key, at: c.built_at });
      for (const id of parseJson(c.members_json, [])) f.involved.add(id);
      break;
    }
    case 'link': {
      const l = st.get('SELECT id, a, b, rel, decided_by, cross_namespace, at FROM entity_links WHERE id = ?', m.id);
      if (!l) return f;
      Object.assign(f, { exists: true, text: '（两个身份之间的对应关系）', at: l.at, link: l });
      f.involved.add(l.a); f.involved.add(l.b);
      f.subjects.add(l.a); f.subjects.add(l.b);
      break;
    }
    default:
      return f;
  }
  return f;
}

/**
 * 这条记忆的内容本身属于 T1 / T2 吗（§9.3.7）：need_to_know 里指向它或它的来源感知的条目。
 * 「别告诉主人」这类请求本身（SECRECY_REQUEST_REASON）不算——它让主人知道有这个请求，不让内容变成 T1。
 */
export function needToKnowKinds(core, m, facts, memo) {
  return memoGet(memo, `ntk:${m.kind}:${m.id}`, () => {
    const kinds = new Set();
    const rows = core.store.all(
      "SELECT kind, reason FROM need_to_know WHERE kind IN ('T1','T2') AND status <> 'withdrawn' AND owner_kind = ? AND owner_id = ?", m.kind, m.id);
    const pids = (facts?.perceptIds ?? []).slice(0, 200);
    if (pids.length) {
      rows.push(...core.store.all(
        `SELECT kind, reason FROM need_to_know WHERE kind IN ('T1','T2') AND status <> 'withdrawn' AND percept_id IN (${pids.map(() => '?').join(',')})`, ...pids));
    }
    for (const r of rows) if (r.reason !== SECRECY_REQUEST_REASON) kinds.add(r.kind);
    return kinds;
  });
}

/** 一批引用的隐藏状态（suppressions，admin 的表）：ref → 'hidden' | 'forgotten'。 */
export function suppressionStates(core, refs) {
  const out = new Map();
  const by = new Map();
  for (const r of refs) {
    if (!r?.mref) continue;
    const k = r.mref.kind;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  for (const [kind, list] of by) {
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      const rows = core.store.all(`SELECT owner_id, state FROM suppressions WHERE owner_kind = ? AND owner_id IN (${part.map(() => '?').join(',')})`,
        kind, ...part.map((x) => x.mref.id));
      for (const row of rows) {
        const hit = part.find((x) => x.mref.id === row.owner_id);
        if (hit) out.set(hit.ref, row.state);
      }
    }
  }
  return out;
}

/** 说话人账号证据 → 实体（只读查身份证据，不新建）。 */
export function actorEntity(core, actor, memo) {
  if (!actor || typeof actor !== 'object') return null;
  if (actor.self) return selfId(core, memo);
  for (const c of actor.claims ?? []) {
    if (c?.kind === 'principal') {
      const p = core.store.get("SELECT id FROM entities WHERE authority = 'principal' ORDER BY closeness DESC, id LIMIT 1");
      if (p) return p.id;
    }
    if (c?.kind === 'account' && typeof c.namespace === 'string' && typeof c.id === 'string') {
      const h = core.keys.identityHash(c.namespace, c.scope, c.id);
      const r = core.store.get('SELECT entity_id FROM identity_evidence WHERE namespace = ? AND scope = ? AND id_hash = ?', c.namespace, c.scope ?? '', h);
      if (r) return r.entity_id;
    }
  }
  return null;
}

// ── 她回的那一句（D110 C7）──────────────────────────────────────────────

const SELF_REPLY_KINDS = new Set(['self-utterance', 'self-action']);

/**
 * 这一行紧挨着的上一条不是她的感知（同一场合、按 id）是谁说的。她私下读到的材料不算「上一条」。
 * 工作记忆的 A5、普通回想的 repliedToTrigger、关口①的污点封顶都按这一个口径。
 * @param {{id: number, setting_key: string}} p
 * @returns {{id: number, actor_entity_id: number|null}|null}
 */
export function previousOther(core, p) {
  return core.store.get(`SELECT id, actor_entity_id FROM percepts WHERE setting_key = ? AND id < ? AND actor_self = 0
                           AND kind IN ('utterance','action','content') AND NOT (visible_to = 'her-only' AND kind = 'content')
                         ORDER BY id DESC LIMIT 1`, p.setting_key, p.id) ?? null;
}

/**
 * 这一条是不是她回这一轮的触发者的话（D110 C7，和工作记忆 A5 同一个口径，全是代码看得到的事实）：是她说的一句（感知）；同一场合紧挨着的
 * 上一条不是她的感知、是触发者（或权利层确认的同一个人）说的；涉及的人只有他和她；正文扫名字是干净的（entities.nameMatcher，零 LLM、
 * 不用词表；匹配器读不到按「点了人」）；不是她自己的猜测、私下读到的、材料。问的人不是他时 false（D80 照旧封顶）。
 * @param {any} f memoryFacts
 * @param {number|null|undefined} trig
 * @returns {boolean}
 */
export function repliedToTrigger(core, f, trig, memo) {
  if (trig == null || !f?.exists || f.kind !== 'percept' || !f.percept || f.text == null) return false;
  const p = f.percept;
  if (!p.actor_self || !SELF_REPLY_KINDS.has(p.kind) || p.visible_to === 'her-only' || p.standing === 'material' || f.derivedSelf) return false;
  return memoGet(memo, `replied:${p.id}:${trig}`, () => {
    const me = selfId(core, memo);
    const eq = rightsEquivalents(core, [trig], memo).get(trig) ?? new Set([trig]);
    const ok = (e) => e === me || e === trig || eq.has(e);
    const prev = previousOther(core, p);
    if (!prev || !ok(prev.actor_entity_id) || prev.actor_entity_id === me) return false;
    if ([...(f.involved ?? [])].some((e) => !ok(e))) return false;
    let hits;
    try {
      const m = memo?.get('nameMatcher') ?? core.mods.entities.nameMatcher(core);
      memo?.set('nameMatcher', m);
      hits = m.scan(String(f.text), { settingKey: p.setting_key }) ?? [];
    } catch { return false; }
    // 同一处名字也认得出是她（她的群名片被立成了「另一个人」）：那一处是在说她自己，不算点了别人
    const mine = hits.filter((h) => h?.entityId === me);
    const over = (h) => mine.some((x) => Number.isFinite(x.start) && x.start < h.end && h.start < x.end);
    return !hits.some((h) => h?.entityId != null && !over(h) && !ok(h.entityId) && isIndividual(core, h.entityId, memo));
  });
}
