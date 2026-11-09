// entities 自己几张表的底层读写（只在本模块里用）。所有写入都在调用方的事务里（同步）。
// 账号只存 HMAC：这里拿到的账号 id 只用来算 core.keys.identityHash，不存、不记日志、不往外传（§12.3）。
import { bumpMetric, refOf } from '../store/index.js';
import { normalizeName, cleanRaw, charLength } from './normalize.js';
import { entityParams, localDay } from './params.js';

/** 身份证据的强度：platform < owner < config。 */
export const STRENGTH_RANK = Object.freeze({ platform: 1, owner: 2, config: 3 });
/** display_name 的来源优先级（高的可以覆盖低的）。 */
export const DISPLAY_RANK = Object.freeze({ platform: 1, extract: 2, label: 3, config: 4, owner: 5 });
/** 权利层只认这几种决定（§5.2「认得 ≠ 权利」）。 */
export const RIGHTS_DECIDERS = Object.freeze(new Set(['platform', 'mutual-claim', 'anchor-confirmed', 'owner']));
/** 链接决定的优先级：低的不推翻高的。 */
export const DECIDER_RANK = Object.freeze({ extractor: 1, sleep: 2, 'anchor-confirmed': 3, 'mutual-claim': 3, platform: 4, owner: 5 });
/** 自动的决定（maybe_same 永远不会被它们变成 not_same）。 */
export const AUTO_DECIDERS = Object.freeze(new Set(['extractor', 'sleep']));

/** 计数（只有数字，§13.3）。失败不影响业务。 */
export function bump(core, name, by = 1) {
  try { if (!core.readOnly && core.store && !core.store.closed) bumpMetric(core.store, name, by, core.now()); } catch { /* 计数失败就算了 */ }
}
/** 日志只记 id、类型、计数（§12.3）。 */
export function warn(core, event, fields = {}) {
  try { core.log.warn(event, fields); } catch { /* 日志失败就算了 */ }
}
const errName = (e) => e?.code ?? e?.name ?? 'Error';
export { errName };

export function state(core) {
  if (!core.state.entities) core.state.entities = {};
  const st = core.state.entities;
  st.namesVersion ??= 0;
  st.dirtyEmbeds ??= new Set();
  return st;
}

// ── entities ─────────────────────────────────────────────────────────────

/** @returns {any|null} */
export function getEntity(core, id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return core.store.get('SELECT * FROM entities WHERE id = ?', id) ?? null;
}

/**
 * @param {{kind: string, status?: string, displayName?: string|null, displaySource?: string|null, isSelf?: boolean,
 *          closeness?: number, authority?: string, settingKey?: string|null, individual: boolean, at: number}} f
 * @returns {number}
 */
export function createEntity(core, f) {
  const now = core.now();
  const r = core.store.run(`INSERT INTO entities(kind, status, display_name, display_source, is_self, closeness, authority, setting_key,
      individual, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  f.kind, f.status ?? 'provisional', f.displayName || null, f.displayName ? (f.displaySource ?? null) : null,
  f.isSelf ? 1 : 0, f.closeness ?? 0, f.authority ?? 'none', f.settingKey ?? null, f.individual ? 1 : 0, now, now);
  const id = Number(r.lastInsertRowid);
  bump(core, 'entities.created');
  markDirty(core, id);
  return id;
}

/** 档案又被看到 / 提到了一天：更新 mention_day_set / mention_days，够了就升 established（§5.2）。返回新的天数。 */
export function markDay(core, e, at) {
  const P = entityParams(core);
  const day = localDay(core, at);
  let set;
  try { set = JSON.parse(e.mention_day_set || '[]'); } catch { set = []; }
  if (!Array.isArray(set)) set = [];
  let days = e.mention_days;
  if (!set.includes(day)) {
    set.push(day);
    set.sort((a, b) => a - b);
    while (set.length > P.mentionDaySetMax) set.shift();
    days += 1;
  }
  const establish = e.status === 'provisional' && days >= P.establishedDays;
  core.store.run(`UPDATE entities SET mention_day_set = ?, mention_days = ?, status = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(set), days, establish ? 'established' : e.status, core.now(), e.id);
  if (establish) bump(core, 'entities.established');
  return days;
}

/** 换 display_name（来源优先级不低于现在的才换；名片撞了别人的保留名的不当显示名）。 */
export function setDisplay(core, id, raw, source) {
  const text = cleanRaw(raw);
  if (!text) return false;
  const e = getEntity(core, id);
  if (!e) return false;
  if (e.display_name === text) return false;
  const cur = e.display_name ? (DISPLAY_RANK[e.display_source] ?? 0) : -1;
  if ((DISPLAY_RANK[source] ?? 0) < cur) return false;
  if (source === 'platform' && reservedOwnerOf(core, normalizeName(text), id)) return false;
  core.store.run('UPDATE entities SET display_name = ?, display_source = ?, updated_at = ? WHERE id = ?', text, source, core.now(), id);
  markDirty(core, id);
  return true;
}

// ── entity_names ─────────────────────────────────────────────────────────

/** 这个规范名是不是别的实体的保留名（返回那个实体 id）。 */
export function reservedOwnerOf(core, norm, exceptId = 0) {
  if (!norm) return null;
  return core.store.get('SELECT entity_id FROM entity_names WHERE text_norm = ? AND reserved = 1 AND entity_id <> ? LIMIT 1', norm, exceptId)?.entity_id ?? null;
}

/** 名字集合变了：提交后让名字匹配器和 jieba 用户词典重建（回滚了就什么都不发生）。 */
export function namesChanged(core) {
  core.store.afterCommit(() => {
    const st = state(core);
    st.namesVersion += 1;
    st.onNamesChanged?.();
  });
}

/**
 * 记一条名字证据（UPSERT：count + 1、first / last 取极值）。
 * @param {{raw: string, usedBy?: number, scope?: string, kind: string, at: number, reserved?: boolean}} n
 * @returns {{id: number, created: boolean, spoof: boolean}|null}
 */
export function addName(core, entityId, n) {
  const text = cleanRaw(n.raw);
  if (!text) return null;
  const norm = normalizeName(text);
  if (!norm) return null;
  const usedBy = Number.isInteger(n.usedBy) && n.usedBy > 0 ? n.usedBy : 0;
  const scope = typeof n.scope === 'string' ? n.scope : '';
  const reserved = n.reserved ? 1 : 0;
  const ex = core.store.get(`SELECT id, reserved, spoof FROM entity_names
    WHERE entity_id = ? AND text_norm = ? AND used_by = ? AND scope_setting_key = ?`, entityId, norm, usedBy, scope);
  if (ex) {
    core.store.run(`UPDATE entity_names SET count = count + 1, first = MIN(first, ?), last = MAX(last, ?), text_raw = ?,
      reserved = MAX(reserved, ?), spoof = CASE WHEN ? = 1 THEN 0 ELSE spoof END WHERE id = ?`, n.at, n.at, text, reserved, reserved, ex.id);
    if (reserved && !ex.reserved) { markSpoofs(core, norm, entityId); namesChanged(core); }
    return { id: ex.id, created: false, spoof: !!ex.spoof && !reserved };
  }
  // 名片 / 账号昵称 / 自称的名字和别人的保留名撞了：记下来（这是证据），但不进匹配器、不当显示名（§5.2「保留名不能被名片冒用」）
  const spoof = !reserved && SPOOFABLE.has(n.kind) && reservedOwnerOf(core, norm, entityId) != null ? 1 : 0;
  const r = core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, used_by, scope_setting_key, reserved, name_kind, spoof,
      count, first, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, entityId, text, norm, usedBy, scope, reserved, n.kind, spoof, n.at, n.at);
  if (spoof) bump(core, 'entities.name.spoof');
  if (reserved) markSpoofs(core, norm, entityId);
  if (!spoof) namesChanged(core);
  markDirty(core, entityId);
  return { id: Number(r.lastInsertRowid), created: true, spoof: !!spoof };
}

/** 新登记了一个保留名：别人已经在用的同名名片 / 昵称 / 自称改标 spoof。 */
function markSpoofs(core, norm, ownerId) {
  const r = core.store.run(`UPDATE entity_names SET spoof = 1 WHERE text_norm = ? AND entity_id <> ? AND reserved = 0 AND spoof = 0
    AND name_kind IN ('card', 'account', 'self-intro')`, norm, ownerId);
  if (r.changes > 0) { bump(core, 'entities.name.spoof', r.changes); namesChanged(core); }
}

/** 本人能给自己起的名字（冒用别人的保留名无效）：群名片、账号昵称、自我介绍里报的名字。 */
const SPOOFABLE = new Set(['card', 'account', 'self-intro']);

/** 一个实体的全部规范名（不含 spoof 的）。 */
export function nameNorms(core, entityId) {
  return new Set(core.store.all('SELECT DISTINCT text_norm FROM entity_names WHERE entity_id = ? AND spoof = 0', entityId).map((r) => r.text_norm));
}

/** 标识这个账号 / 档案本身的名字（账号昵称、群名片、配置和主人给的、场合称呼）；不含别人怎么叫他、他自称什么。 */
export function identityNames(core, entityId) {
  return new Set(core.store.all(`SELECT DISTINCT text_norm FROM entity_names WHERE entity_id = ? AND spoof = 0
    AND name_kind IN ('card', 'account', 'config', 'owner', 'label')`, entityId).map((r) => r.text_norm));
}

/** 他自我介绍时报过的名字（「我是小刚」「我 B站 就是 xxx」）。 */
export function claimedNames(core, entityId) {
  return new Set(core.store.all(`SELECT DISTINCT text_norm FROM entity_names WHERE entity_id = ? AND spoof = 0 AND name_kind = 'self-intro'`,
    entityId).map((r) => r.text_norm));
}

// ── entity_descriptors ───────────────────────────────────────────────────

/**
 * 记一条关系描述（同一个说话人、同一种方式给出的同一条描述只加计数）。
 * @param {{anchor: number, relationRaw: string, basis: string, speaker?: number|null, settingKey?: string, at: number,
 *          perceptIds?: number[], jobId?: number|null}} d
 * @returns {{id: number, created: boolean}|null}
 */
export function addDescriptor(core, entityId, d) {
  const raw = cleanRaw(d.relationRaw, 32);
  const rel = normalizeName(raw);
  if (!rel || !Number.isInteger(d.anchor) || d.anchor <= 0 || d.anchor === entityId) return null;
  const speaker = Number.isInteger(d.speaker) && d.speaker > 0 ? d.speaker : 0;
  const ex = core.store.get(`SELECT id, source_json FROM entity_descriptors
    WHERE entity_id = ? AND anchor_entity_id = ? AND relation = ? AND speaker_entity_id = ? AND basis = ?`, entityId, d.anchor, rel, speaker, d.basis);
  const perceptIds = (d.perceptIds ?? []).filter((x) => Number.isInteger(x));
  if (ex) {
    let src = {};
    try { src = JSON.parse(ex.source_json) ?? {}; } catch { src = {}; }
    const ids = [...new Set([...(Array.isArray(src.perceptIds) ? src.perceptIds : []), ...perceptIds])].slice(-5);
    core.store.run(`UPDATE entity_descriptors SET count = count + 1, first_at = MIN(first_at, ?), last_at = MAX(last_at, ?), source_json = ?
      WHERE id = ?`, d.at, d.at, JSON.stringify({ ...src, perceptIds: ids, jobId: d.jobId ?? src.jobId ?? null }), ex.id);
    return { id: ex.id, created: false };
  }
  const r = core.store.run(`INSERT INTO entity_descriptors(entity_id, anchor_entity_id, relation, text, basis, speaker_entity_id, setting_key,
      count, first_at, last_at, source_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  entityId, d.anchor, rel, raw, d.basis, speaker, d.settingKey ?? '', d.at, d.at,
  JSON.stringify({ perceptIds: perceptIds.slice(0, 5), jobId: d.jobId ?? null }), core.now());
  namesChanged(core);   // 新的关系词也进匹配器
  markDirty(core, entityId);
  return { id: Number(r.lastInsertRowid), created: true };
}

// ── identity_evidence ────────────────────────────────────────────────────

/**
 * 一条账号 claim → 存储用的键（只有哈希）。scope 本身也可能是不透明 id，同样只存 HMAC。
 * @param {{namespace: string, id: string, scope?: string}} claim
 */
export function identityKeys(core, claim) {
  const namespace = claim.namespace;
  const scope = typeof claim.scope === 'string' && claim.scope ? claim.scope : undefined;
  return {
    namespace,
    scope: scope ? core.keys.hash('identity-scope', namespace, scope) : '',
    idHash: core.keys.identityHash(namespace, scope, claim.id),
  };
}

/** @returns {{id: number, entity_id: number, strength: string}|null} */
export function findEvidence(core, k) {
  return core.store.get('SELECT id, entity_id, strength FROM identity_evidence WHERE namespace = ? AND scope = ? AND id_hash = ?',
    k.namespace, k.scope, k.idHash) ?? null;
}

/**
 * 把一条身份证据挂到实体上（没有就建；同一个实体就按强度升级）。已经属于别的实体时什么都不改，返回 conflict。
 * @returns {'created'|'kept'|'upgraded'|'conflict'}
 */
export function attachEvidence(core, entityId, k, strength, meta = {}) {
  const ex = findEvidence(core, k);
  if (ex) {
    if (ex.entity_id !== entityId) return 'conflict';
    if ((STRENGTH_RANK[strength] ?? 0) > (STRENGTH_RANK[ex.strength] ?? 0)) {
      core.store.run('UPDATE identity_evidence SET strength = ? WHERE id = ?', strength, ex.id);
      if (strength !== 'platform') establish(core, entityId);
      return 'upgraded';
    }
    return 'kept';
  }
  core.store.run(`INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, source_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, entityId, k.namespace, k.scope, k.idHash, strength,
  JSON.stringify({ adapter: meta.adapter ?? null, via: meta.via ?? null }), core.now());
  // 配置或主人确认的身份证据：档案直接 established（§5.2）；平台账号要在 ≥ 2 天出现才算（防小号，见交付说明）
  if (strength !== 'platform') establish(core, entityId);
  markDirty(core, entityId);
  return 'created';
}

/** 把一条已有的身份证据改挂到另一个实体（只在配置明说这是她 / 主人的账号时用）。 */
export function moveEvidence(core, evidenceId, toEntityId, strength) {
  core.store.run('UPDATE identity_evidence SET entity_id = ?, strength = ? WHERE id = ?', toEntityId, strength, evidenceId);
  if (strength !== 'platform') establish(core, toEntityId);
}

/** 一个实体的账号证据都在哪些命名空间。 */
export function namespacesOf(core, entityId) {
  return new Set(core.store.all('SELECT DISTINCT namespace FROM identity_evidence WHERE entity_id = ?', entityId).map((r) => r.namespace));
}

/**
 * 两个档案各有一个同命名空间、同作用域的账号（id 一定不同，UNIQUE）：默认是不同的人（§5.2 第 1 步），
 * 只凭单方面的说法、提炼或锚点的话都不自动认成 same（双向自认、平台、主人可以）。
 */
export function accountsClash(core, a, b) {
  return !!core.store.get(`SELECT 1 AS x FROM identity_evidence x JOIN identity_evidence y ON y.namespace = x.namespace AND y.scope = x.scope
    WHERE x.entity_id = ? AND y.entity_id = ? LIMIT 1`, a, b);
}

export function establish(core, entityId) {
  const r = core.store.run(`UPDATE entities SET status = 'established', updated_at = ? WHERE id = ? AND status = 'provisional'`, core.now(), entityId);
  if (r.changes) bump(core, 'entities.established');
}

// ── 嵌入文本（记忆层的「档案文本」，§2.2） ───────────────────────────────

export function markDirty(core, id) { state(core).dirtyEmbeds.add(id); }

/** 档案的嵌入文本：名字 + 关系描述。不含账号、不含场合名以外的元数据。 */
export function profileEmbedText(core, e) {
  const P = entityParams(core);
  const names = core.store.all(`SELECT MAX(text_raw) AS t, SUM(count) AS c FROM entity_names WHERE entity_id = ? AND spoof = 0
    GROUP BY text_norm ORDER BY c DESC, MAX(last) DESC LIMIT ?`, e.id, P.embed.names).map((r) => r.t);
  if (e.display_name && !names.includes(e.display_name)) names.unshift(e.display_name);
  const descs = core.store.all(`SELECT d.anchor_entity_id AS anchor, MAX(d.text) AS t FROM entity_descriptors d
    WHERE d.entity_id = ? AND d.basis <> 'self-claim' GROUP BY d.anchor_entity_id, d.relation ORDER BY MAX(d.last_at) DESC LIMIT ?`,
  e.id, P.embed.descriptors);
  const parts = [];
  if (names.length) parts.push(names.join(' / '));
  for (const d of descs) {
    const a = anchorLabel(core, d.anchor);
    parts.push(a ? `${a} ${d.t}` : d.t);
  }
  return parts.join(' | ');
}

/** 一个实体在别人的描述里怎么称呼（显示名，或者最常用的名字）。 */
export function anchorLabel(core, id) {
  const e = core.store.get('SELECT display_name FROM entities WHERE id = ?', id);
  if (e?.display_name) return e.display_name;
  return core.store.get(`SELECT text_raw FROM entity_names WHERE entity_id = ? AND spoof = 0 ORDER BY count DESC LIMIT 1`, id)?.text_raw ?? '';
}

/**
 * 把这次操作里名字 / 描述变了的档案送进嵌入队列（worker.enqueueEmbed：文本没变就不动）。在调用方的事务里。
 * 嵌入是缓存：登记失败只计数，不让感知或提炼的整批事务失败。
 */
export function flushEmbeds(core) {
  const st = state(core);
  if (!st.dirtyEmbeds.size) return;
  const ids = [...st.dirtyEmbeds];
  st.dirtyEmbeds.clear();
  for (const id of ids) {
    const e = getEntity(core, id);
    if (!e || e.status === 'retracted') continue;
    const text = profileEmbedText(core, e);
    if (!text) continue;
    try {
      core.mods.worker.enqueueEmbed(core, { kind: 'entity', id }, [{ chunkNo: 0, kind: 'text', text }], { layer: 'memory', priority: 2 });
    } catch (err) {
      bump(core, 'entities.embed.error');
      warn(core, 'entities.embed.error', { ref: refOf('entity', id), error: errName(err) });
    }
  }
}

export { charLength };
