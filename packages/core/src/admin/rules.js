// 规则（§12.2 rules、§12.7「别记这里」、§9.3.2 B4 主人的披露规则、§10.1 / §15.2 按场合的开 / 关）。
// 规则是数据不是代码：目标是实体、记忆引用、场合（场合键）或场合属性，不是入口名。读得很频繁（intake 每批问「别记」、
// 注入前问模式），所以按种类缓存；事务里不缓存（回滚后缓存不会留下没提交的规则）。
import { ContractError } from '../contract/errors.js';
import { isOneOnOne, isPublicLike } from '../contract/setting.js';
import { MODE_RANK } from '../config/defaults.js';
import { parseRef } from '../store/refs.js';
import { residentDirty } from './notify.js';

export const RULE_KINDS = Object.freeze(['do_not_remember', 'disclosure', 'mode']);
/** 只有关 / 开两档（用户反馈第 6 轮：不要影子模式）。库里旧的 'shadow' 规则不再生效，按没有覆盖算（见 modeFor）。 */
export const MODES = Object.freeze(['off', 'live']);
export const RESTRICTIONS = Object.freeze(['none', 'soft', 'strict']);
/** 谁加的：owner 管理页 / tool 经授权的工具 / subject:<实体 id> 本人（经权利层确认）/ system 核心自己（忘掉时连带的规则）。 */
const BY_RE = /^(owner|tool|system|subject:[1-9]\d{0,15})$/;
const SETTING_ATTRS = new Set(['exposureRankMin', 'exposureRankMax', 'persistenceRankMin', 'oneOnOne', 'publicLike']);
const MODE_TTL_MS = 60_000;

function adminState(core) {
  core.state.admin ??= {};
  const s = core.state.admin;
  s.rules ??= new Map();
  s.dnr ??= null;
  s.modes ??= new Map();
  return s;
}
export function invalidateRules(core) {
  const s = adminState(core);
  s.rules.clear();
  s.dnr = null;
  s.modes.clear();
}

const bad = (what, path, message) => new ContractError(what, [{ path, message }]);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

function rowToRule(r) {
  const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
  return Object.freeze({ id: r.id, kind: r.kind, target: Object.freeze(parse(r.target_json) ?? {}), value: parse(r.value_json), createdBy: r.created_by,
    at: r.at, note: r.note ?? null, revokedAt: r.revoked_at ?? null });
}

/** 校验并规范化一条规则的目标和值（未知字段丢掉）。 */
export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') throw bad('rule', 'rule', '应为对象');
  if (!RULE_KINDS.includes(rule.kind)) throw bad('rule', 'kind', `应为 ${RULE_KINDS.join(' / ')}`);
  if (typeof rule.createdBy !== 'string' || !BY_RE.test(rule.createdBy)) throw bad('rule', 'createdBy', '不认识的来源');
  if (!Number.isFinite(rule.at)) throw bad('rule', 'at', '应为时间');
  const t = rule.target && typeof rule.target === 'object' ? rule.target : null;
  if (!t) throw bad('rule', 'target', '应为对象');
  let target;
  let value = null;
  if (rule.kind === 'do_not_remember') {
    // 「别记」：一个场合、一个人，或者一条被忘掉的记忆（之后再遇到同样的内容不再记成新的）
    const opts = [typeof t.settingKey === 'string' && t.settingKey ? { settingKey: t.settingKey } : null, isPosInt(t.entityId) ? { entityId: t.entityId } : null,
      typeof t.ref === 'string' && parseRef(t.ref) ? { ref: t.ref } : null].filter(Boolean);
    if (opts.length !== 1) throw bad('rule', 'target', '「别记」的目标是 settingKey / entityId / ref 之一');
    target = opts[0];
  } else if (rule.kind === 'disclosure') {
    target = {};
    if (t.entityId != null) { if (!isPosInt(t.entityId)) throw bad('rule', 'target.entityId', '应为实体 id'); target.entityId = t.entityId; }
    if (t.attribute != null) { if (typeof t.attribute !== 'string' || !t.attribute || t.attribute.length > 200) throw bad('rule', 'target.attribute', '应为信息类型'); target.attribute = t.attribute; }
    if (t.settingKey != null) { if (typeof t.settingKey !== 'string' || !t.settingKey) throw bad('rule', 'target.settingKey', '应为场合键'); target.settingKey = t.settingKey; }
    if (t.settingAttrs != null) {
      if (typeof t.settingAttrs !== 'object') throw bad('rule', 'target.settingAttrs', '应为对象');
      target.settingAttrs = {};
      for (const [k, v] of Object.entries(t.settingAttrs)) {
        if (!SETTING_ATTRS.has(k)) throw bad('rule', `target.settingAttrs.${k}`, '只能按场合属性写，不能按入口');
        if ((k === 'oneOnOne' || k === 'publicLike') ? typeof v !== 'boolean' : !Number.isInteger(v)) throw bad('rule', `target.settingAttrs.${k}`, '类型不对');
        target.settingAttrs[k] = v;
      }
    }
    if (!Object.keys(target).length) throw bad('rule', 'target', '披露规则的目标至少要有实体、信息类型或场合属性之一');
    const v = rule.value && typeof rule.value === 'object' ? rule.value : {};
    if (!RESTRICTIONS.includes(v.restriction)) throw bad('rule', 'value.restriction', `应为 ${RESTRICTIONS.join(' / ')}`);
    value = { restriction: v.restriction };
    for (const k of ['allow', 'deny']) {
      if (v[k] == null) continue;
      if (!Array.isArray(v[k]) || !v[k].every(isPosInt) || v[k].length > 64) throw bad('rule', `value.${k}`, '应为实体 id 列表');
      value[k] = [...new Set(v[k])].sort((a, b) => a - b);
    }
  } else {
    if (typeof t.settingKey !== 'string' || !t.settingKey) throw bad('rule', 'target.settingKey', '模式规则要指定场合');
    if (!MODES.includes(rule.value)) throw bad('rule', 'value', `应为 ${MODES.join(' / ')}`);
    if (rule.createdBy !== 'owner') throw bad('rule', 'createdBy', '模式只能由主人在管理页改（§9.6）');
    target = { settingKey: t.settingKey };
    value = rule.value;
  }
  if (rule.kind === 'disclosure' && rule.createdBy !== 'owner') throw bad('rule', 'createdBy', '披露规则只能由主人在管理页写');
  const note = typeof rule.note === 'string' ? rule.note.slice(0, 200) : null;
  return { kind: rule.kind, target, value, createdBy: rule.createdBy, at: rule.at, note };
}

/** 规则改了：常驻区标脏（规则指向一个场合时只标那个场合；其余全部，§10.4 只标脏不换文本）。 */
function rulesChanged(core, target) {
  invalidateRules(core);
  residentDirty(core, typeof target?.settingKey === 'string' ? target.settingKey : null);
}

/** 加一条规则（写一行；在调用方的事务里调用也行）。按场合的模式：同一个场合的旧模式规则一并撤销（最新的为准）。 */
export function addRule(core, rule) {
  const r = normalizeRule(rule);
  const id = core.store.tx((db) => {
    if (r.kind === 'mode') {
      for (const old of db.all("SELECT id, target_json FROM rules WHERE kind = 'mode' AND revoked_at IS NULL")) {
        let tk = null;
        try { tk = JSON.parse(old.target_json).settingKey; } catch { tk = null; }
        if (tk === r.target.settingKey) db.run('UPDATE rules SET revoked_at = ? WHERE id = ?', r.at, old.id);
      }
    }
    const res = db.run('INSERT INTO rules(kind, target_json, value_json, created_by, at, note) VALUES (?, ?, ?, ?, ?, ?)',
      r.kind, JSON.stringify(r.target), r.value == null ? null : JSON.stringify(r.value), r.createdBy, r.at, r.note);
    return Number(res.lastInsertRowid);
  });
  rulesChanged(core, r.target);
  core.log.info('admin.rule-added', { id, kind: r.kind });
  return id;
}

export function revokeRule(core, id, ctx) {
  if (!isPosInt(id)) throw bad('revokeRule', 'id', '应为正整数');
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  const row = core.store.get('SELECT target_json FROM rules WHERE id = ? AND revoked_at IS NULL', id);
  const n = core.store.run('UPDATE rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', at, id).changes;
  if (!n) { invalidateRules(core); return; }
  let target = null;
  try { target = JSON.parse(row?.target_json ?? 'null'); } catch { target = null; }
  rulesChanged(core, target);
  core.log.info('admin.rule-revoked', { id });
}

export function activeRules(core, kind) {
  if (!RULE_KINDS.includes(kind)) throw bad('activeRules', 'kind', `应为 ${RULE_KINDS.join(' / ')}`);
  const s = adminState(core);
  const cached = core.store.inTransaction ? null : s.rules.get(kind);
  if (cached) return cached.slice();
  const list = Object.freeze(core.store.all('SELECT * FROM rules WHERE kind = ? AND revoked_at IS NULL ORDER BY id', kind).map(rowToRule));
  if (!core.store.inTransaction) s.rules.set(kind, list);
  return list.slice();
}

function dnrSets(core) {
  const s = adminState(core);
  if (s.dnr && !core.store.inTransaction) return s.dnr;
  const sets = { settings: new Set(), entities: new Set(), refs: new Set() };
  for (const r of activeRules(core, 'do_not_remember')) {
    if (r.target.settingKey) sets.settings.add(r.target.settingKey);
    if (r.target.entityId) sets.entities.add(r.target.entityId);
    if (r.target.ref) sets.refs.add(r.target.ref);
  }
  if (!core.store.inTransaction) s.dnr = sets;
  return sets;
}

/**
 * 「别记」命中吗：场合、说话人（intake 入库前问），或者一条被忘掉的记忆（encode 对账时问：别把同样的内容又记回去）。
 * @param {{settingKey?: string, entityIds?: number[], ref?: string}} q
 */
export function doNotRemember(core, q) {
  const s = dnrSets(core);
  if (q?.settingKey && s.settings.has(q.settingKey)) return true;
  for (const id of q?.entityIds ?? []) if (s.entities.has(id)) return true;
  if (q?.ref && s.refs.has(q.ref)) return true;
  return false;
}

// 不认识的档按 live 算（fail closed：生效档读不准时宁可让关口照常审）
const rankOf = (m) => MODE_RANK[m] ?? MODE_RANK.live;
const minMode = (a, b) => (rankOf(a) <= rankOf(b) ? a : b);

function settingDescriptor(core, settingKey) {
  try {
    const s = core.mods.intake.settingByKey(core, settingKey);
    if (s) return s.descriptor ?? null;
    return null;
  } catch {
    const r = core.store.get(`SELECT ss.descriptor_json FROM settings s JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id WHERE s.key = ?`, settingKey);
    if (!r) return null;
    try { return JSON.parse(r.descriptor_json); } catch { return null; }
  }
}

function principalIds(core) {
  try { return core.mods.entities.principals(core); } catch {
    return core.store.all("SELECT id FROM entities WHERE authority = 'principal'").map((r) => r.id);
  }
}

/** 这个场合里有没有「有管理权限的人」在场：最近的出现集合，或最近的发言者。只看属性，不看入口。 */
export function principalPresent(core, settingKey) {
  const ps = new Set(principalIds(core));
  if (!ps.size) return false;
  const set = core.store.get('SELECT members_json FROM presence_sets WHERE setting_key = ? ORDER BY at DESC, id DESC LIMIT 1', settingKey);
  if (set) {
    try { if (JSON.parse(set.members_json).some((id) => ps.has(id))) return true; } catch { /* 坏行当没有 */ }
  }
  return core.store.all('SELECT actor_entity_id AS a FROM percepts WHERE setting_key = ? ORDER BY id DESC LIMIT 200', settingKey).some((r) => ps.has(r.a));
}

/**
 * 这个场合当前的生效档：min(config.mode.global, 场合覆盖 ?? 按属性的默认档)。
 * 按属性：任何人可见或公开留存 → public；和有管理权限的人一对一 → principalOneOnOne；其余 → closed；
 * 还没有描述的场合按最保守的那一档（fail closed）。
 */
export function modeFor(core, settingKey) {
  const cfg = core.config.get().mode;
  const s = adminState(core);
  const now = core.now();
  const hit = s.modes.get(settingKey);
  // 缓存只在一分钟内、配置没变、场合描述没换快照时有效（描述变了——比如变成公开的——马上按新属性算，fail closed）
  const snap = core.store.get('SELECT current_snapshot_id AS s FROM settings WHERE key = ?', settingKey)?.s ?? null;
  // 一对一、还没见到有管理权限的人：这个场合有了新的感知或出现集合就重算（主人第一条消息落库后马上按主人一对一算，
  // 不用等缓存过期——否则刚开的主人私聊头一分钟按「封闭的群」那一档算）
  const marks = hit?.waitPrincipal ? presenceMarks(core, settingKey) : null;
  let mode;
  if (hit && now - hit.at < MODE_TTL_MS && hit.global === cfg.global && hit.cfg === cfg && hit.snap === snap
    && (!hit.waitPrincipal || (marks.p === hit.marks.p && marks.s === hit.marks.s))) mode = hit.mode;
  else {
    // 旧版本留下的 'shadow' 覆盖不再认（主人不要这一档）：当没有覆盖，按属性的默认档
    const override = activeRules(core, 'mode').filter((r) => r.target.settingKey === settingKey && MODES.includes(r.value)).at(-1)?.value ?? null;
    let byAttr;
    let waitPrincipal = false;
    const d = settingDescriptor(core, settingKey);
    const by = cfg.byAttributes;
    if (!d) byAttr = [by.public, by.closed, by.principalOneOnOne].reduce(minMode);
    else if (isPublicLike(d)) byAttr = by.public;
    else if (isOneOnOne(d) && principalPresent(core, settingKey)) byAttr = by.principalOneOnOne;
    else { byAttr = by.closed; waitPrincipal = isOneOnOne(d); }
    mode = minMode(cfg.global, override ?? byAttr);
    if (!core.store.inTransaction) {
      s.modes.set(settingKey, { mode, at: now, global: cfg.global, cfg, snap, waitPrincipal, marks: waitPrincipal ? (marks ?? presenceMarks(core, settingKey)) : null });
    }
  }
  return mode;
}

/** 这个场合最新的感知和出现集合的 id（变了 = 有新的人或新的话进来）。两条走索引的查询。 */
function presenceMarks(core, settingKey) {
  const p = core.store.get('SELECT MAX(id) AS m FROM percepts WHERE setting_key = ?', settingKey)?.m ?? 0;
  let ps = 0;
  try { ps = core.store.get('SELECT MAX(id) AS m FROM presence_sets WHERE setting_key = ?', settingKey)?.m ?? 0; } catch { ps = 0; }
  return { p, s: ps };
}
