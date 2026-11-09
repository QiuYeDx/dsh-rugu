// 读记忆的小帮手（只读 SQL，schema 就是契约）：她自己是谁、实体怎么称呼、来源链、隐藏 / 删除、「需要你知道」里的标记、
// 派生内容的初始规范。所有派生内容（泛化、反思、印象、故事线、小结、日记、成长）都从这里取证据。
import { parseRef, refOf } from '../store/index.js';
import { safeJson, metric, warn, errCode } from './util.js';

const RESTRICTION_RANK = { none: 0, soft: 1, strict: 2 };

/** 她自己的实体 id（没有就让 entities 建）。 */
export function selfId(core) {
  const row = core.store.get('SELECT id FROM entities WHERE is_self = 1');
  if (row) return row.id;
  try { return core.mods.entities.ensureSelf(core); } catch { return null; }
}

/** 有管理权限的实体。 */
export function principalIds(core) {
  return core.store.all("SELECT id FROM entities WHERE authority = 'principal' ORDER BY closeness DESC, id").map((r) => r.id);
}

/**
 * 实体的基本信息（按 id 批量取）。
 * @returns {Map<number, {id: number, kind: string, status: string, display_name: string|null, closeness: number, authority: string, is_self: number, setting_key: string|null}>}
 */
export function entityRows(core, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter((x) => Number.isInteger(x)))];
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const rows = core.store.all(`SELECT id, kind, status, display_name, closeness, authority, is_self, setting_key FROM entities WHERE id IN (${part.map(() => '?').join(',')})`, ...part);
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

/**
 * 给提示词看的称呼：她自己 =「我」；有名字用名字；没名字用关系描述（「阿明的表哥」）。主人只按属性标「你最亲近的人」。
 * 账号、哈希永远不出现。
 */
export function entityLabeler(core) {
  const cache = new Map();
  let principalLabel = '';
  try { principalLabel = String(core.ports.selfProfile.principalLabel() ?? ''); } catch { /* 没有就用名字 */ }
  const label = (id, depth = 0) => {
    if (!Number.isInteger(id)) return '某人';
    if (cache.has(id)) return cache.get(id);
    const e = core.store.get('SELECT id, kind, display_name, authority, is_self, closeness FROM entities WHERE id = ?', id);
    let text = '某人';
    if (e) {
      if (e.is_self) text = '我';
      else if (e.kind === 'setting') text = '这个地方（一个场合）';   // 场合名不给模型（和故事线、小结一样）
      else if (e.authority === 'principal') text = `${principalLabel || e.display_name || '主人'}（你最亲近的人）`;
      else if (e.display_name) text = e.display_name;
      else {
        const name = core.store.get('SELECT text_raw FROM entity_names WHERE entity_id = ? ORDER BY count DESC, last DESC LIMIT 1', id);
        if (name) text = name.text_raw;
        else if (depth < 2) {
          const d = core.store.get('SELECT anchor_entity_id, relation FROM entity_descriptors WHERE entity_id = ? ORDER BY id LIMIT 1', id);
          if (d) text = `${label(d.anchor_entity_id, depth + 1).replace(/（你最亲近的人）$/, '')}的${d.relation}`;
          else text = e.kind === 'setting' ? '一个场合' : '某人';
        }
      }
    }
    cache.set(id, text);
    return text;
  };
  return label;
}

/** 亲密度换成给模型看的词（只读连续值，不做特例）。 */
export function closenessWord(c) {
  if (c >= 0.8) return '很亲近';
  if (c >= 0.5) return '熟悉';
  if (c >= 0.2) return '认识';
  return '不太熟';
}

/**
 * 一批记忆引用里哪些被隐藏 / 忘掉 / 彻底删除了。优先问 admin；admin 不可用就直接读 suppressions 和 tombstones（只读）。
 * 派生内容不用这些记忆当证据：隐藏的写进印象、故事线，就等于绕过了隐藏。
 * @returns {Set<string>}
 */
export function suppressedSet(core, refs) {
  const list = [...new Set(refs)];
  if (!list.length) return new Set();
  try {
    const s = core.mods.admin.suppressedRefs(core, list);
    if (s instanceof Set) return s;
  } catch { /* 退回直接读 */ }
  const out = new Set();
  for (const r of core.store.all('SELECT owner_kind, owner_id FROM suppressions')) {
    try { out.add(refOf(r.owner_kind, r.owner_id)); } catch { /* 坏行跳过 */ }
  }
  for (const r of core.store.all('SELECT ref FROM tombstones')) out.add(r.ref);
  return new Set(list.filter((x) => out.has(x)));
}

/**
 * 新写出来的派生内容（小结、日记）继承隐藏（§12.7）：证据里有被隐藏的（消息、含它的经历），一写出来就对别人隐藏，
 * 不等 tick 的兜底扫描（admin.sweepInherited）。在写入的事务里调；admin 出错不挡写入，兜底扫描照样会补上。
 * @param {string} ref
 * @param {number} at
 */
export function inheritHidden(core, ref, at) {
  try { core.mods.admin.inheritSuppression(core, ref, { at }); } catch (e) {
    metric(core, 'inheritHidden.error');
    warn(core, 'inheritHidden.failed', { error: errCode(e) });
  }
}

/**
 * 这些记忆里被「忘掉」的 id（忘掉 = 谁都不提 + 别记：不再拿来写新的记忆，§12.7）。只读 suppressions。
 * @param {string} kind
 * @param {number[]} ids
 * @returns {Set<number>}
 */
export function forgottenIds(core, kind, ids) {
  const list = [...new Set(ids)].filter((x) => Number.isInteger(x));
  if (!list.length) return new Set();
  return new Set(core.store.all("SELECT owner_id FROM suppressions WHERE owner_kind = ? AND state = 'forgotten' AND owner_id IN (SELECT value FROM json_each(?))",
    kind, JSON.stringify(list)).map((r) => r.owner_id));
}

/**
 * 「需要你知道」里被标过的东西（T1 指令和设定、taint 污染、poison 投毒、foreign_write）：它们不能作为成长的依据（§5.7），
 * 也不进泛化和反思。按感知 id 和记忆引用两种方式记。
 * @returns {{percepts: Set<number>, refs: Set<string>}}
 */
export function flaggedSets(core) {
  const percepts = new Set();
  const refs = new Set();
  // 主人在管理页撤回（判为误报）的标记不再算
  const rows = core.store.all(`SELECT owner_kind, owner_id, percept_id FROM need_to_know
      WHERE kind IN ('T1','taint','poison','foreign_write') AND status <> 'withdrawn'`);
  for (const r of rows) {
    if (Number.isInteger(r.percept_id)) percepts.add(r.percept_id);
    if (r.owner_kind && Number.isInteger(r.owner_id)) { try { refs.add(refOf(r.owner_kind, r.owner_id)); } catch { /* 跳过 */ } }
  }
  return { percepts, refs };
}

/**
 * 带按轮污点（§9.6）的轮里她说出去的话：这些感知不能作为成长的依据（§5.7）。
 * 依据是关口②的记录：回流对上的发言（utterances.matched_percept）在审视时标了这一轮带污点（reasons 里的 taint 标记）。
 * 另外：她在带污点的轮里看过、写进了「她看到的」的那条消息（D116，media_json 里 by:'self' 那一项标 tainted:true）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 * @returns {Set<number>}
 */
export function taintedTurnPercepts(core, perceptIds) {
  const ids = [...new Set(perceptIds.filter((x) => Number.isInteger(x)))];
  const out = new Set();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = core.store.all(`SELECT matched_percept AS pid FROM utterances
        WHERE matched_percept IN (${part.map(() => '?').join(',')}) AND reasons_json LIKE '%taint%'`, ...part);
    for (const r of rows) out.add(r.pid);
    // 她在带污点的轮里看过、写下了她看到的（D116，media_json 里那一项标 tainted）：这条感知也不当成长的依据
    const seen = core.store.all(`SELECT id AS pid FROM percepts
        WHERE id IN (${part.map(() => '?').join(',')}) AND media_json LIKE '%"tainted":true%'`, ...part);
    for (const r of seen) out.add(r.pid);
  }
  return out;
}

/** 实体的权限属性（只读属性，不对主人做特例，§0 第 12 条）。 */
export function authorityOf(core, entityId) {
  if (!Number.isInteger(entityId)) return 'none';
  return core.store.get('SELECT authority FROM entities WHERE id = ?', entityId)?.authority ?? 'none';
}

/**
 * 指令类记录（§7.4 第 8 条、§5.7 的第二条防线、S29）：没有权限的人要她以后照做的要求、给她的「设定」，encode 只记成一条
 * kind_hint='request' 的事实（「X 提过一个要求，没采纳」）并报 T1。这条记录本身、它引用的感知，都不能作为成长和自我概念的依据。
 * 只看记录本身和提要求的人的属性，不看「需要你知道」里那条标记：主人把它当误报撤回，只说明他不需要知道，
 * 不说明这个要求该改变她；通知没写成也一样。来源里的说话人（或断言者）是她自己、或者有权限（authority ≠ none）的，
 * 不算指令类（§5.7 只挡无权限者的）；一个说话人都没有的按指令类处理（fail closed）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} assertionIds
 * @returns {Set<number>}
 */
export function directiveAssertions(core, assertionIds) {
  const ids = [...new Set(assertionIds.filter((x) => Number.isInteger(x)))];
  const out = new Set();
  if (!ids.length) return out;
  const self = core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null;
  const auth = new Map();
  const foreign = (id) => {
    if (id === self) return false;
    if (!auth.has(id)) auth.set(id, authorityOf(core, id));
    return auth.get(id) === 'none';
  };
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const parties = new Map();
    for (const r of core.store.all(`SELECT a.id, s.speaker, s.asserter FROM assertions a
        LEFT JOIN sources s ON s.owner_kind = 'assertion' AND s.owner_id = a.id
        WHERE a.id IN (${part.map(() => '?').join(',')}) AND a.kind_hint = 'request'`, ...part)) {
      if (!parties.has(r.id)) parties.set(r.id, []);
      for (const x of [r.speaker, r.asserter]) if (Number.isInteger(x)) parties.get(r.id).push(x);
    }
    for (const [id, who] of parties) if (!who.length || who.some(foreign)) out.add(id);
  }
  return out;
}

/**
 * 一批感知里，哪些被指令类记录引用过（它们所在的情节、以它们为来源的事实，都不算成长的依据）。走 sources 的 percept_id 索引。
 * @param {import('../core-types.js').CoreContext} core
 * @param {(number|null)[]} perceptIds
 * @returns {Set<number>}
 */
export function directivePercepts(core, perceptIds) {
  const ids = [...new Set(perceptIds.filter((x) => Number.isInteger(x)))];
  const out = new Set();
  if (!ids.length) return out;
  const cited = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    cited.push(...core.store.all(`SELECT s.percept_id AS pid, s.owner_id AS aid FROM sources s JOIN assertions a ON a.id = s.owner_id
        WHERE s.owner_kind = 'assertion' AND s.percept_id IN (${part.map(() => '?').join(',')}) AND a.kind_hint = 'request'`, ...part));
  }
  if (!cited.length) return out;
  const directive = directiveAssertions(core, cited.map((r) => r.aid));
  for (const r of cited) if (directive.has(r.aid)) out.add(r.pid);
  return out;
}

/**
 * 一条情节或事实的来源，连同来源感知的属性（谁看得到、在哪个场合、当时的公开程度）。
 * @returns {{percept_id: number|null, speaker: number|null, asserter: number|null, mode: string, hop: number, at: number,
 *           visible_to: string|null, setting_key: string|null, actor_entity_id: number|null, actor_self: number|null,
 *           p_kind: string|null, standing: string|null, historical: number|null, episode_id: number|null, exposure_rank: number|null,
 *           perceived_in: string|null}[]}
 */
export function sourcesOf(core, kind, id) {
  return core.store.all(`
    SELECT s.percept_id, s.speaker, s.asserter, s.mode, s.hop, s.at, s.perceived_in,
           p.visible_to, p.setting_key, p.actor_entity_id, p.actor_self, p.kind AS p_kind, p.standing, p.historical, p.episode_id,
           ss.exposure_rank
    FROM sources s
    LEFT JOIN percepts p ON p.id = s.percept_id
    LEFT JOIN setting_snapshots ss ON ss.id = COALESCE(s.snapshot_id, p.snapshot_id)
    WHERE s.owner_kind = ? AND s.owner_id = ? ORDER BY s.id`, kind, id);
}

/** 一批记忆引用背后的全部来源感知 id（派生内容的来源链就指向它们，彻底删除时 encode.derivedFrom 能找到派生物）。 */
export function evidencePerceptIds(core, refs) {
  const out = new Set();
  for (const ref of refs) {
    const m = parseRef(ref);
    if (!m) continue;
    if (m.kind === 'percept') { out.add(m.id); continue; }
    if (m.kind !== 'episode' && m.kind !== 'assertion') continue;
    for (const r of core.store.all('SELECT percept_id FROM sources WHERE owner_kind = ? AND owner_id = ? AND percept_id IS NOT NULL', m.kind, m.id)) out.add(r.percept_id);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 一条记忆的可读内容和时间（只给后台提示词用，用之前还要过 forPrompt）。
 * @returns {{ref: string, kind: string, id: number, text: string, at: number, settingKey: string|null}|null}
 */
export function memoryText(core, ref) {
  const m = parseRef(ref);
  if (!m) return null;
  if (m.kind === 'episode') {
    const e = core.store.get('SELECT id, setting_key, header, narrative, title, t_start, t_end FROM episodes WHERE id = ?', m.id);
    if (!e) return null;
    const text = [e.header, e.narrative].filter(Boolean).join(' ') || e.title;
    return { ref, kind: m.kind, id: m.id, text, at: e.t_end, settingKey: e.setting_key || null };
  }
  if (m.kind === 'assertion') {
    const a = core.store.get('SELECT id, text, recorded_at, event_start FROM assertions WHERE id = ?', m.id);
    if (!a) return null;
    return { ref, kind: m.kind, id: m.id, text: a.text, at: a.event_start ?? a.recorded_at, settingKey: null };
  }
  if (m.kind === 'window') {
    const w = core.store.get('SELECT id, setting_key, text, t_end FROM raw_windows WHERE id = ?', m.id);
    if (!w || w.text == null) return null;
    return { ref, kind: m.kind, id: m.id, text: w.text, at: w.t_end, settingKey: w.setting_key };
  }
  if (m.kind === 'storyline') {
    const s = core.store.get('SELECT id, setting_key, text, updated_at FROM storylines WHERE id = ?', m.id);
    return s ? { ref, kind: m.kind, id: m.id, text: s.text, at: s.updated_at ?? 0, settingKey: s.setting_key } : null;
  }
  if (m.kind === 'community') {
    const c = core.store.get('SELECT id, setting_key, summary, built_at FROM communities WHERE id = ?', m.id);
    return c ? { ref, kind: m.kind, id: m.id, text: c.summary, at: c.built_at, settingKey: c.setting_key } : null;
  }
  return null;
}

/** 读规范；discretion 不可用时按 unassessed 处理（最严）。 */
export function normOfSafe(core, ref) {
  const m = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!m) return { unassessed: true, restriction: 'none' };
  try { return core.mods.discretion.normOf(core, m); } catch { return { unassessed: true, restriction: 'none' }; }
}

/**
 * 派生条目写入时先给的规范：证据里最严的（限制取最严、敏感度取最大、涉及别人取或、deny 取并、allow 取交、来源公开程度取最窄）。
 * 写入后紧接着在同一个事务里调 discretion.inheritNorm，由它按 §5.6 定最终的规范和「谁知道」；这里只是保证中间状态不比证据松。
 * 证据里有还没评估的（unassessed），敏感度至少按 0.5 算，并在 reason 里写明，等证据评估完再重算（todaySoFar 的重算）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} refs
 * @returns {import('../core-types.js').NormInput}
 */
export function strictestNorm(core, refs) {
  let restriction = 'none';
  let sensitivity = null;
  let attribute = null;
  let involvesOthers = false;
  let identityLink = false;
  let unassessed = false;
  let settingRuleRef = null;
  let settingRuleVersion = null;
  let allow = null;
  const deny = new Set();
  let exposure = null;
  for (const ref of refs) {
    const n = normOfSafe(core, ref);
    if (n.unassessed) { unassessed = true; continue; }
    if ((RESTRICTION_RANK[n.restriction] ?? 0) > RESTRICTION_RANK[restriction]) restriction = n.restriction;
    if (Number.isFinite(n.sensitivity) && (sensitivity == null || n.sensitivity > sensitivity)) { sensitivity = n.sensitivity; attribute = n.attribute ?? attribute; }
    involvesOthers ||= !!n.involvesOthers;
    identityLink ||= !!n.identityLink;
    if (n.settingRuleRef && !settingRuleRef) { settingRuleRef = n.settingRuleRef; settingRuleVersion = n.settingRuleVersion ?? null; }
    if (Array.isArray(n.allow)) allow = allow == null ? new Set(n.allow) : new Set([...allow].filter((x) => n.allow.includes(x)));
    for (const d of n.deny ?? []) deny.add(d);
    const ex = n.originExposure;
    if (ex && Number.isFinite(ex.exposureRank) && (exposure == null || ex.exposureRank < exposure.exposureRank)) exposure = ex;
  }
  if (unassessed) sensitivity = Math.max(sensitivity ?? 0, 0.5);
  /** @type {import('../core-types.js').NormInput} */
  const norm = {
    restriction: /** @type {'none'|'soft'|'strict'} */ (restriction),
    involvesOthers,
    identityLink,
    allow: allow ? [...allow] : null,
    deny: deny.size ? [...deny] : null,
    reason: unassessed ? 'derived:unassessed-evidence' : 'derived',
  };
  if (sensitivity != null) norm.sensitivity = sensitivity;
  if (attribute != null) norm.attribute = attribute;
  if (settingRuleRef) { norm.settingRuleRef = settingRuleRef; norm.settingRuleVersion = settingRuleVersion; }
  if (exposure) norm.originExposure = exposure;
  return norm;
}

/** 情节的参与者（实体 id）。 */
export function participantsOf(row) {
  const v = safeJson(row?.participants_json, []);
  return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
}

/** 事实涉及的实体（按角色）。 */
export function assertionEntities(core, id) {
  return core.store.all('SELECT entity_id, role FROM assertion_entities WHERE assertion_id = ?', id);
}

/** 有没有 intake 的场合记录（stability、parent、对应的实体）。intake 不可用时直接读 settings 表。 */
export function settingInfo(core, settingKey) {
  if (!settingKey) return null;
  try {
    const s = core.mods.intake.settingByKey(core, settingKey);
    if (s) return { key: s.key, label: s.label, stability: s.stability, parentKey: s.parentKey ?? null, entityId: s.entityId ?? null, exposureRank: s.exposureRank ?? null };
  } catch { /* 退回直接读 */ }
  const r = core.store.get(`SELECT s.key, s.label, s.stability, s.parent_key, s.entity_id, ss.exposure_rank
    FROM settings s LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id WHERE s.key = ?`, settingKey);
  return r ? { key: r.key, label: r.label, stability: r.stability, parentKey: r.parent_key, entityId: r.entity_id, exposureRank: r.exposure_rank } : null;
}
