// 审核队列（§13.1）和「需要你知道」（§9.3.7）。
//   - 审核队列只放低把握的、或主人想管的；主人在管理页决定，执行交给各表的拥有者（decideReview 按 kind 分派）。
//   - payload 只放引用和结构化字段，不放原文（挂起的原文只在 utterances.held_text）；过长的字符串截断并计数。
//   - 挂起的发言 14 天没处理 → 不发（discretion.holdDecision(token, false)）；「可能是同一个」**永远不**自动判成不是同一个。
//   - 问题已经由别处回答了的审核项撤回（status='withdrawn'，不执行任何决定）：双向自认 / 平台 / 主人已经把那两个定了、
//     场合规矩的那一版已经不在等审核、要处理的记忆已经被彻底删除。拥有那件事的模块可以直接撤（withdrawReviews），
//     tick 也会顺带扫一遍（withdrawStale）。主人决定得比扫描早的，照主人的决定执行。
//   - 主人的决定会改她上下文里的东西（人物卡、成长块、规矩），执行完常驻区标脏（context.markResidentDirty）。
//   - 「需要你知道」：T1 想改变她的东西（含「别告诉你主人」这类请求本身）、T2 伤害 / 违法 / 安全、被污染的、疑似投毒、
//     准备写进规矩 / 意图 / 成长块而来源不是管理者的。每条带来源（记忆引用、感知、来源实体），管理页可以一键按来源撤回。
//     【D118】有管理权限的人自己转给她的（感知的 forwarded_json.relayedById）不报 T1：那是他分享的，他知道；
//     按轮污点（taint）默认不进（context.taint.notify），以前记下的开着的那些不列、不计数（行还在，成长的依据照旧排除它们）。
import { ContractError } from '../contract/errors.js';
import { parseRef, refOf } from '../store/refs.js';
import { bumpMetric, getMetaJson } from '../store/kv.js';
import { suppress, restore, unitExists, isTombstoned, sweepInherited } from './suppress.js';
import { withdrawRefs } from './purge.js';
import { residentDirty } from './notify.js';
import { param } from './params.js';

const DAY = 86_400_000;
export const REVIEW_KINDS = Object.freeze(['forget_request', 'owner_op', 'merge', 'growth', 'held_utterance', 'norm_change', 'setting_rule_relax', 'withdraw']);
export const NTK_KINDS = Object.freeze(['T1', 'T2', 'taint', 'poison', 'foreign_write']);
const MAX_PAYLOAD_STRING = 200;
/** 权利层的决定（entities 的 RIGHTS_DECIDERS）：这几种定下来的「是不是同一个」，低把握的合并审核就不用再问了。 */
const RIGHTS_DECIDERS = Object.freeze(['platform', 'mutual-claim', 'anchor-confirmed', 'owner']);
const bad = (what, path, message) => new ContractError(what, [{ path, message }]);

/** 【D118】「需要你知道」现在列哪几种：taint 只在打开 context.taint.notify 时列（关着时那些旧行留在库里，只是不列、不计数）。 */
function listedKindsSql(core) {
  let notify = false;
  try { notify = core.config.get().context?.taint?.notify === true; } catch { notify = false; }
  return notify ? '1 = 1' : "kind <> 'taint'";
}

/**
 * 【D118】这条消息是有管理权限的人自己转给她的吗：合并转发的节点、转发人（forwarded_json.relayedById）是主人或代管的人。
 * 作者照旧未经核实；只说明「他转来的，他看过」。读不了按「不是」。
 */
export function sharedByAuthority(core, perceptId) {
  if (!Number.isSafeInteger(perceptId)) return false;
  try {
    const p = core.store.get('SELECT forwarded_json FROM percepts WHERE id = ?', perceptId);
    if (!p?.forwarded_json) return false;
    const by = JSON.parse(p.forwarded_json)?.relayedById;
    if (!Number.isSafeInteger(by)) return false;
    const e = core.store.get('SELECT authority, is_self FROM entities WHERE id = ?', by);
    return !!e && e.is_self !== 1 && (e.authority ?? 'none') !== 'none';
  } catch { return false; }
}

/** payload 里只留结构化的值：字符串截到 200 字（引用、id、键都远短于此），函数之类的丢掉。 */
function cleanPayload(v, depth = 0, stats = { cut: 0 }) {
  if (depth > 6) return null;
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  if (typeof v === 'string') { if (v.length > MAX_PAYLOAD_STRING) { stats.cut += 1; return v.slice(0, MAX_PAYLOAD_STRING); } return v; }
  if (Array.isArray(v)) return v.slice(0, 20_000).map((x) => cleanPayload(x, depth + 1, stats));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (typeof x !== 'function' && x !== undefined) out[k] = cleanPayload(x, depth + 1, stats);
    return out;
  }
  return null;
}

function rowToItem(r) {
  let payload = {};
  try { payload = JSON.parse(r.payload_json); } catch { payload = {}; }
  return { id: r.id, kind: r.kind, reason: r.reason, status: r.status, createdAt: r.created_at, payload, expiresAt: r.expires_at ?? null,
    decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null };
}

/**
 * 排一条审核。同样的 kind + payload 还在等着的，不重复排，返回原来那条。在调用方的事务里调用也行。
 * @returns {number}
 */
export function enqueueReview(core, item) {
  if (!REVIEW_KINDS.includes(item?.kind)) throw bad('enqueueReview', 'kind', `应为 ${REVIEW_KINDS.join(' / ')}`);
  if (!item.payload || typeof item.payload !== 'object') throw bad('enqueueReview', 'payload', '应为对象');
  const stats = { cut: 0 };
  const payload = JSON.stringify(cleanPayload(item.payload, 0, stats));
  const at = core.now();
  let expires = item.expiresAt ?? null;
  if (item.kind === 'held_utterance' && expires == null) expires = at + param(core, 'discretion.egress.holdExpiryDays') * DAY;
  if (item.kind === 'merge') expires = null;   // 「可能是同一个」等多久都不会被自动否掉（§17 Q9）
  const reason = String(item.reason ?? '').slice(0, MAX_PAYLOAD_STRING);
  const old = core.store.get("SELECT id FROM review_queue WHERE kind = ? AND status = 'pending' AND payload_json = ?", item.kind, payload);
  if (old) return old.id;
  const id = Number(core.store.run('INSERT INTO review_queue(kind, payload_json, reason, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    item.kind, payload, reason, 'pending', at, expires).lastInsertRowid);
  if (stats.cut) { core.log.warn('admin.review-payload-cut', { kind: item.kind, strings: stats.cut }); bumpMetric(core.store, 'review.payload.cut', stats.cut); }
  bumpMetric(core.store, `review.enqueued.${item.kind}`);
  core.log.info('admin.review-queued', { id, kind: item.kind });
  return id;
}

/** @returns {import('../contract/types.js').ReviewItem[]} */
export function listReview(core, q = {}) {
  const where = [];
  const p = [];
  if (q.status) { where.push('status = ?'); p.push(q.status); }
  if (q.kind) { where.push('kind = ?'); p.push(q.kind); }
  return core.store.all(`SELECT * FROM review_queue ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`, ...p).map(rowToItem);
}

function principalEntity(core) {
  try { const ids = core.mods.entities.principals(core); if (ids?.length) return ids[0]; } catch { /* 退回 SQL */ }
  return core.store.get("SELECT id FROM entities WHERE authority = 'principal' ORDER BY closeness DESC, id LIMIT 1")?.id ?? null;
}

/** 规范变更的审核项 → discretion 的 NormUpdate（payload 可以直接带 update，也可以是 {ref | settingKey, direction, change}）。 */
function normUpdateOf(p) {
  if (p.update && typeof p.update === 'object') return p.update;
  const target = typeof p.ref === 'string' && parseRef(p.ref) ? { kind: 'memory', ref: p.ref }
    : typeof p.settingKey === 'string' && p.settingKey ? { kind: 'setting', settingKey: p.settingKey } : null;
  if (!target) return null;
  return { target, direction: p.direction === 'tighten' ? 'tighten' : 'relax', change: p.change && typeof p.change === 'object' ? p.change : {}, quote: null };
}

/** 场合规矩放宽的审核项要的那条规矩：payload 直接带 rule，或者指向 setting_rules 里挂起的那一版（读别的模块的表只读）。 */
function settingRuleOf(core, p) {
  if (p.rule && typeof p.rule === 'object' && typeof p.rule.text === 'string') return p.rule;
  if (typeof p.settingKey !== 'string' || !Number.isSafeInteger(p.version)) return null;
  const r = core.store.get('SELECT rule_json FROM setting_rules WHERE setting_key = ? AND version = ?', p.settingKey, p.version);
  let rule = null;
  try { rule = r ? JSON.parse(r.rule_json) : null; } catch { rule = null; }
  if (!rule || typeof rule.text !== 'string') return null;
  return { text: rule.text, ...(rule.restriction ? { restriction: rule.restriction } : {}), ...(rule.scope ? { scope: rule.scope } : {}) };
}

const ID_RE = /^[1-9]\d{0,15}$/;

/**
 * 主人的决定，按 kind 交给拥有者执行；执行成功之后才标成 approved / rejected（执行失败就还在队列里，可以再决定一次）。
 * 各 kind 认的 payload（只有引用和结构化字段）：
 *   forget_request {ref, entityId?, perceptId?, hidden?}；merge {a, b, evidence?}；growth {change, evidenceRefs, text?}；
 *   held_utterance {token}；norm_change {update} 或 {ref | settingKey, direction, change}；
 *   setting_rule_relax {settingKey, rule} 或 {settingKey, version}；withdraw {entityId, from, to, refs}；owner_op {tool, op, perceptId, …}。
 * @param {object} core
 * @param {number} id   也接受十进制数字字符串（D23）
 * @param {'approve'|'reject'} decision
 * @param {{by: string}} [ctx]
 */
export async function decideReview(core, id, decision, ctx = {}) {
  if (typeof id === 'string' && ID_RE.test(id)) id = Number(id);
  if (!Number.isSafeInteger(id) || id <= 0 || (decision !== 'approve' && decision !== 'reject')) throw bad('review.decide', 'id/decision', 'id 应为正整数，结论只能是 approve / reject');
  const row = core.store.get('SELECT * FROM review_queue WHERE id = ?', id);
  if (!row) throw Object.assign(new Error('没有这条审核'), { code: 'NOT_FOUND' });
  if (row.status !== 'pending') throw Object.assign(new Error(`这条审核已经是 ${row.status}`), { code: 'REVIEW_NOT_PENDING' });
  const at = core.now();
  const by = String(ctx.by ?? 'owner').slice(0, 40);
  if (row.expires_at != null && row.expires_at <= at) {
    expireOne(core, row, at);
    throw Object.assign(new Error('这条审核已经过期'), { code: 'REVIEW_EXPIRED' });
  }
  const item = rowToItem(row);
  const p = item.payload;
  const approve = decision === 'approve';
  switch (item.kind) {
    case 'forget_request': {
      const m = parseRef(p.ref);
      if (!m) throw bad('review.decide', 'payload.ref', '忘掉请求没有指向记忆');
      if (approve) {
        // 只有主人能让她忘（§17 Q5）：批准 = 主人的「忘掉」（隐藏 + 别记 + 30 天内可恢复）
        if (unitExists(core.store, m)) suppress(core, p.ref, { state: 'forgotten', by: 'owner', reason: 'forget_request', at });
      } else {
        // 本人要求时先对别人隐藏了（§17 Q5）；主人驳回就恢复原样——只恢复这次请求加的隐藏，主人自己的隐藏不动
        const s = core.store.get('SELECT by, state FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id);
        if (s && s.state === 'hidden' && s.by !== 'owner') restore(core, p.ref, { by, at });
      }
      break;
    }
    case 'merge':
      // 主人的裁决：批准 = 同一个；驳回 = 不是同一个（只有主人能判 not_same，过期永远不会）
      core.mods.entities.link(core, p.a, p.b, { rel: approve ? 'same' : 'not_same', confidence: 1, evidence: Array.isArray(p.evidence) ? p.evidence : [], decidedBy: 'owner', at });
      break;
    case 'growth':
      if (approve) {
        // 审核项只带结构化的变化（{name, baseVersion, change, evidenceRefs}），consolidate 把它应用到现在的文本上；
        // 应用不上（文本已经变了、太长）就是执行失败：留在队列里，主人可以驳回
        const r = await core.mods.consolidate.applyGrowth(core, { text: p.text, change: p.change ?? {}, evidenceRefs: p.evidenceRefs ?? [] }, { by: 'owner', at });
        if (r && r.version == null && !r.queued && r.reason && r.reason !== 'no-change') {
          throw Object.assign(new Error(`这处成长变化应用不上（${r.reason}）`), { code: 'GROWTH_NOT_APPLIED', reason: r.reason });
        }
      }
      break;
    case 'held_utterance':
      if (typeof p.token !== 'string' || !p.token) throw bad('review.decide', 'payload.token', '挂起的发言没有令牌');
      await core.mods.discretion.holdDecision(core, p.token, approve);
      break;
    case 'norm_change':
      if (approve) {
        const update = normUpdateOf(p);
        if (!update) throw bad('review.decide', 'payload', '规范变更没有目标');
        // 主人批准 = 有管理权限的人亲自放宽（权利层认它）
        core.mods.discretion.applyNormUpdate(core, update, { speakerEntityId: principalEntity(core), at, perceptId: p.perceptId ?? null });
      }
      break;
    case 'setting_rule_relax':
      decideSettingRule(core, id, p, approve, { by, at });
      break;
    case 'withdraw':
      if (approve) {
        // 批准时按同一个人、同一段时间重新算一遍（审核期间新派生的记忆一起删），并上当时列出来的
        const again = Number.isSafeInteger(p.entityId) ? withdrawRefs(core, { entityId: p.entityId, from: p.from, to: p.to }) : [];
        const refs = [...new Set([...(Array.isArray(p.refs) ? p.refs : []), ...again])].filter((r) => parseRef(r));
        if (refs.length) await core.mods.admin.purge(core, refs, /** @type {any} */ ({ by, at, reason: 'withdraw' }));
      } else core.mods.admin.undoWithdrawHide(core, id, at);
      break;
    case 'owner_op':
      // 未经核实的「主人操作」（例如名片冒充主人让她记住什么）：批准后交给 encode 照主人的请求执行（文字从感知取，不信当初的参数）
      if (approve) {
        if (typeof core.mods.encode.applyToolOp === 'function') await core.mods.encode.applyToolOp(core, p, { by: 'owner', at });
        else core.log.warn('admin.review-owner-op-unhandled', { id });
      }
      break;
    default: break;
  }
  core.store.run("UPDATE review_queue SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", approve ? 'approved' : 'rejected', at, by, id);
  bumpMetric(core.store, `review.${approve ? 'approved' : 'rejected'}.${item.kind}`);
  core.log.info('admin.review-decided', { id, kind: item.kind, approve });
  // 人物卡、成长块、规矩、隐藏的记忆都可能变了：常驻区标脏（挂起的发言不进常驻区）
  if (item.kind !== 'held_utterance') residentDirty(core, item.kind === 'setting_rule_relax' && typeof p.settingKey === 'string' ? p.settingKey : null);
}

/**
 * 场合规矩放宽（§5.6 单调性：放宽只认管理者）的审核：payload 指向 setting_rules 里挂起的那一版（{settingKey, version}，
 * discretion.writeSettingRule 排的），或者直接带着规矩（{settingKey, rule}）。
 *   - 指向挂起的那一版：交给 discretion.decideSettingRule——批准按那一版的内容和原作者写一版主人认可的、那一版标成被取代；
 *     驳回把那一版标成 rejected（不会一直挂着）。那一版已经不在等审核（被取代了、处理过了）：审核项撤回，抛 REVIEW_WITHDRAWN。
 *   - 直接带着规矩：批准 = 主人写一版（writeSettingRule，authority='principal'）；驳回什么都不写。
 */
function decideSettingRule(core, reviewId, p, approve, { at }) {
  if (typeof p.settingKey !== 'string' || !p.settingKey) throw bad('review.decide', 'payload.settingKey', '场合规矩放宽没有场合');
  const settled = () => {
    withdrawOne(core, reviewId, at, 'setting-rule-settled');
    return Object.assign(new Error('这一版场合规矩已经不在等审核了'), { code: 'REVIEW_WITHDRAWN' });
  };
  if (Number.isSafeInteger(p.version) && !(p.rule && typeof p.rule === 'object')) {
    const row = core.store.get('SELECT status, superseded_at FROM setting_rules WHERE setting_key = ? AND version = ?', p.settingKey, p.version);
    if (!row || row.status !== 'pending' || row.superseded_at != null) throw settled();
    const r = core.mods.discretion.decideSettingRule(core, p.settingKey, p.version, approve, { at });
    if (r?.status === 'not-pending') throw settled();
    return;
  }
  if (!approve) return;
  const rule = settingRuleOf(core, p);
  if (!rule) throw bad('review.decide', 'payload', '场合规矩放宽没有规矩内容');
  core.mods.discretion.writeSettingRule(core, p.settingKey, rule, { source: 'owner', authorEntityId: principalEntity(core), authority: 'principal', at });
}

// ── 撤回已经有答案的审核项 ────────────────────────────────────────────────

function withdrawOne(core, id, at, why) {
  const n = Number(core.store.run("UPDATE review_queue SET status = 'withdrawn', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
    at, `system:${String(why).slice(0, 40)}`, id).changes);
  if (n) bumpMetric(core.store, 'review.withdrawn');
  return n;
}

/** payload 和匹配条件：merge 的 a / b 不分先后；其余字段逐个相等（对象按 JSON 比）。 */
function payloadMatches(kind, p, match) {
  const same = (x, y) => (x !== null && typeof x === 'object' ? JSON.stringify(x) === JSON.stringify(y) : x === y);
  const rest = { ...match };
  if (kind === 'merge' && match.a != null && match.b != null) {
    const want = [match.a, match.b].sort((x, y) => x - y);
    const got = [p.a, p.b].sort((x, y) => x - y);
    if (want[0] !== got[0] || want[1] !== got[1]) return false;
    delete rest.a;
    delete rest.b;
  }
  return Object.entries(rest).every(([k, v]) => same(p[k], v));
}

/**
 * 【补】撤回还在等着的审核项：问题已经由拥有那件事的模块回答了（例：双向自认把「可能是同一个」定成了同一个）。
 * 不执行任何决定，只标 withdrawn。在调用方的事务里调用也行。
 * @param {object} core
 * @param {{kind: string, match: object}} q   match：payload 里要相等的字段（merge 的 a / b 不分先后）
 * @param {{reason?: string, at?: number}} [ctx]
 * @returns {number} 撤回了几条
 */
export function withdrawReviews(core, q, ctx = {}) {
  if (!REVIEW_KINDS.includes(q?.kind)) throw bad('withdrawReviews', 'kind', `应为 ${REVIEW_KINDS.join(' / ')}`);
  if (!q.match || typeof q.match !== 'object' || !Object.keys(q.match).length) throw bad('withdrawReviews', 'match', '至少要按一个字段匹配');
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  const why = typeof ctx?.reason === 'string' && ctx.reason ? ctx.reason : 'superseded';
  let n = 0;
  for (const row of core.store.all("SELECT id, payload_json FROM review_queue WHERE kind = ? AND status = 'pending' ORDER BY id", q.kind)) {
    let p = {};
    try { p = JSON.parse(row.payload_json); } catch { p = {}; }
    if (payloadMatches(q.kind, p, q.match)) n += withdrawOne(core, row.id, at, why);
  }
  if (n) core.log.info('admin.reviews-withdrawn', { kind: q.kind, n });
  return n;
}

/** 一条还在等着的审核项是不是已经有了答案；有就返回原因。 */
function staleReason(core, kind, p) {
  const db = core.store;
  switch (kind) {
    case 'merge': {
      if (!Number.isSafeInteger(p.a) || !Number.isSafeInteger(p.b)) return null;
      const gone = db.get('SELECT count(*) AS n FROM entities WHERE id IN (?, ?)', p.a, p.b).n < (p.a === p.b ? 1 : 2);
      if (gone) return 'entity-gone';
      const l = db.get(`SELECT decided_by FROM entity_links WHERE a = ? AND b = ? AND rel IN ('same','not_same')
                        AND decided_by IN (SELECT value FROM json_each(?))`, Math.min(p.a, p.b), Math.max(p.a, p.b), JSON.stringify(RIGHTS_DECIDERS));
      return l ? `decided-by-${l.decided_by}` : null;
    }
    case 'setting_rule_relax': {
      if (typeof p.settingKey !== 'string' || !Number.isSafeInteger(p.version) || (p.rule && typeof p.rule === 'object')) return null;
      const r = db.get('SELECT status, superseded_at FROM setting_rules WHERE setting_key = ? AND version = ?', p.settingKey, p.version);
      return !r || r.status !== 'pending' || r.superseded_at != null ? 'setting-rule-settled' : null;
    }
    case 'forget_request':
    case 'norm_change': {
      const m = typeof p.ref === 'string' ? parseRef(p.ref) : null;
      return m && isTombstoned(db, m.kind, p.ref) ? 'purged' : null;
    }
    default: return null;
  }
}

/** 扫一遍还在等着的审核项，已经有答案的撤回（tick 经 expireReviews 每分钟顺带做）。 */
export function withdrawStale(core, at) {
  let n = 0;
  for (const row of core.store.all(`SELECT id, kind, payload_json FROM review_queue WHERE status = 'pending'
                                    AND kind IN ('merge','setting_rule_relax','forget_request','norm_change') ORDER BY id`)) {
    let p = {};
    try { p = JSON.parse(row.payload_json); } catch { continue; }
    const why = staleReason(core, row.kind, p);
    if (why) n += withdrawOne(core, row.id, at, why);
  }
  if (n) core.log.info('admin.reviews-withdrawn', { n });
  return n;
}

function expireOne(core, row, at) {
  const n = core.store.run("UPDATE review_queue SET status = 'expired', decided_at = ?, decided_by = 'expiry' WHERE id = ? AND status = 'pending'", at, row.id).changes;
  if (!n) return false;
  if (row.kind === 'held_utterance') {
    let token = null;
    try { token = JSON.parse(row.payload_json).token; } catch { token = null; }
    if (token) {
      // 过期视为不发：让适配器清掉占位（异步，失败只记日志；库里已经是 expired，不会再发）
      Promise.resolve().then(() => core.mods.discretion.holdDecision(core, token, false)).catch((e) => {
        core.log.warn('admin.hold-expire-notify-failed', { id: row.id, error: e?.code ?? e?.name ?? 'Error' });
      });
    }
  }
  return true;
}

/**
 * 过期处理：到期的审核标 expired；挂起的发言 = 不发。merge 不设过期时间，永远不会走到这里。
 * 顺带撤回已经有答案的（withdrawStale）、给隐藏之后才写出来的派生内容补上隐藏（sweepInherited）；都不算在返回的条数里。
 * @returns {number}   过期的条数
 */
export function expireReviews(core, at) {
  const now = Number.isFinite(at) ? at : core.now();
  let n = 0;
  for (const row of core.store.all("SELECT * FROM review_queue WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ? AND kind <> 'merge' ORDER BY id", now)) {
    if (expireOne(core, row, now)) n += 1;
  }
  if (n) core.log.info('admin.reviews-expired', { n });
  try { withdrawStale(core, now); } catch (e) { core.log.warn('admin.reviews-withdraw-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
  // 隐藏之后才写出来的派生内容（小结、日记、窗口……）补上隐藏：写的模块没调 inheritSuppression 时的兜底
  try { sweepInherited(core, now); } catch (e) { core.log.warn('admin.inherit-sweep-failed', { error: e?.code ?? e?.name ?? 'Error' }); }
  return n;
}

/**
 * 待审提示的各项（常驻区和总览，§10.4）：审核队列、需要你知道、最近的成长变化、原文保留期缩短的冷静期倒计时。
 */
export function pendingSummary(core) {
  const at = core.now();
  const reviews = Number(core.store.get("SELECT count(*) AS n FROM review_queue WHERE status = 'pending'").n);
  const needToKnow = Number(core.store.get(`SELECT count(*) AS n FROM need_to_know WHERE status = 'open' AND ${listedKindsSql(core)}`).n);
  let growth = 0;
  try {
    growth = Number(core.store.get(`SELECT count(*) AS n FROM core_block_versions WHERE created_at >= ? AND revoked_at IS NULL AND created_by <> 'owner'`,
      at - param(core, 'admin.growthRecentDays') * DAY).n);
  } catch { growth = 0; }
  const pending = getMetaJson(core.store, 'retention.pending', null);
  const retention = pending ? { to: pending.to, effectiveAt: pending.effectiveAt, daysLeft: Math.max(0, Math.ceil((pending.effectiveAt - at) / DAY)) } : null;
  return { reviews, needToKnow, growth, retention };
}

/**
 * 待审提示的条数。principalOnly=true 时只算需要主人本人处理的（审核队列 + 需要你知道）；false 时再加上最近的成长变化
 * （自动生效的，主人不看也不影响，只是让他知道）。保留期的冷静期倒计时不算条数，见 pendingSummary。
 */
export function pendingCount(core, principalOnly) {
  const s = pendingSummary(core);
  return s.reviews + s.needToKnow + (principalOnly ? 0 : s.growth);
}

/**
 * 记一条「需要你知道」。同一件事还开着的不重复记（严重程度只升不降）。「同一件事」= 同一种、同一个原因，再加上：
 *   - 有感知：同一条消息，记忆引用相同或有一边没带（各模块各报一次，一个带着记忆、一个没带）——补上记忆引用；
 *   - 只有记忆：同一条记忆；
 *   - 都没有（例：成长块的提议）：只看种类和原因。
 * 原因不同的是不同的事，分开记：同一条消息既是一条设定（指令），又带着「别告诉你主人」的请求时，两件主人都该知道，
 * 而且读的一方（discretion 判内容本身是不是 T1）要靠原因区分——并到一行里就丢了其中一件。
 * 在调用方的事务里调用也行。
 * 【D118】T1 的那条消息是有管理权限的人自己转给她的（sharedByAuthority）：不记，返回 null——他转来的东西他看过，
 * 转发里有人「下指令」「要她瞒着你」，她照旧不照做（提炼第 8 条），只是不再告诉转发它的人一遍。T2 照记。
 * @returns {number|null}
 */
export function notifyNeedToKnow(core, item) {
  if (!NTK_KINDS.includes(item?.kind)) throw bad('notifyNeedToKnow', 'kind', `应为 ${NTK_KINDS.join(' / ')}`);
  const m = item.ref ? parseRef(item.ref) : null;
  if (item.ref && !m) throw bad('notifyNeedToKnow', 'ref', '应为记忆引用');
  const pid = Number.isSafeInteger(item.perceptId) ? item.perceptId : null;
  if (item.kind === 'T1' && pid != null && sharedByAuthority(core, pid)) {
    bumpMetric(core.store, 'ntk.T1.sharedByAuthority');
    return null;
  }
  const src = Number.isSafeInteger(item.sourceEntityId) ? item.sourceEntityId : null;
  const at = Number.isFinite(item.at) ? item.at : core.now();
  const severity = Number.isFinite(item.severity) ? Math.max(1, Math.min(3, Math.round(item.severity))) : 1;
  const reason = String(item.reason ?? '').slice(0, MAX_PAYLOAD_STRING);
  let old;
  if (pid != null) {
    old = core.store.get(`SELECT id, severity, owner_kind FROM need_to_know WHERE kind = ? AND status = 'open' AND percept_id = ? AND reason = ?
                           AND ((owner_kind IS ? AND owner_id IS ?) OR owner_kind IS NULL OR ? IS NULL)
                         ORDER BY (owner_kind IS ? AND owner_id IS ?) DESC, id LIMIT 1`, item.kind, pid, reason, m?.kind ?? null, m?.id ?? null, m?.kind ?? null, m?.kind ?? null, m?.id ?? null);
  } else if (m) {
    old = core.store.get(`SELECT id, severity, owner_kind FROM need_to_know WHERE kind = ? AND status = 'open' AND owner_kind = ? AND owner_id = ? AND percept_id IS NULL AND reason = ?`,
      item.kind, m.kind, m.id, reason);
  } else {
    old = core.store.get(`SELECT id, severity, owner_kind FROM need_to_know WHERE kind = ? AND status = 'open' AND owner_kind IS NULL AND percept_id IS NULL AND reason = ?`,
      item.kind, reason);
  }
  if (old) {
    if (severity > old.severity) core.store.run('UPDATE need_to_know SET severity = ? WHERE id = ?', severity, old.id);
    if (m && old.owner_kind == null) core.store.run('UPDATE need_to_know SET owner_kind = ?, owner_id = ? WHERE id = ?', m.kind, m.id, old.id);
    if (src != null) core.store.run('UPDATE need_to_know SET source_entity_id = COALESCE(source_entity_id, ?) WHERE id = ?', src, old.id);
    return old.id;
  }
  const id = Number(core.store.run(`INSERT INTO need_to_know(kind, owner_kind, owner_id, percept_id, source_entity_id, reason, severity, status, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  item.kind, m?.kind ?? null, m?.id ?? null, pid, src, reason, severity, at).lastInsertRowid);
  bumpMetric(core.store, `ntk.${item.kind}`);
  core.log.info('admin.need-to-know', { id, kind: item.kind, severity });
  return id;
}

/**
 * 「需要你知道」列表（管理页）：带来源（记忆引用、感知原话、来源实体的名字）和一键按来源撤回要用的参数。只给主人看。
 * 【D118】还带着看懂这一条要的东西：转发进来的那条消息是谁转的（forwardedBy）；成长块的那一版（growth：第几版、写进去的变化、
 * 写完以后的整块文字、依据几条、撤销了没有、是不是当前这一版）。按轮污点（taint）只在打开 context.taint.notify 时列。
 * @param {{status?: string}} [q]   不给时：没撤回的全部（开着的在前）
 */
export function listNeedToKnow(core, q = {}) {
  const kinds = listedKindsSql(core);
  const rows = q.status
    ? core.store.all(`SELECT * FROM need_to_know WHERE status = ? AND ${kinds} ORDER BY severity DESC, created_at DESC, id DESC`, q.status)
    : core.store.all(`SELECT * FROM need_to_know WHERE status <> 'withdrawn' AND ${kinds} ORDER BY status = 'open' DESC, severity DESC, created_at DESC, id DESC`);
  const nameOf = (id) => (id ? core.store.get('SELECT display_name FROM entities WHERE id = ?', id)?.display_name ?? null : null);
  return rows.map((r) => {
    const p = r.percept_id ? core.store.get('SELECT text, at, setting_key, actor_entity_id, forwarded_json FROM percepts WHERE id = ?', r.percept_id) : null;
    const who = r.source_entity_id ?? p?.actor_entity_id ?? null;
    let forwardedBy = null;
    if (p?.forwarded_json) {
      let by = null;
      try { by = JSON.parse(p.forwarded_json)?.relayedById ?? null; } catch { by = null; }
      forwardedBy = Number.isSafeInteger(by) ? { entityId: by, name: nameOf(by) } : { entityId: null, name: null };
    }
    return {
      id: r.id, kind: r.kind, status: r.status, severity: r.severity, reason: r.reason, createdAt: r.created_at, readAt: r.read_at ?? null,
      ref: r.owner_kind ? refOf(r.owner_kind, r.owner_id) : null, perceptId: r.percept_id ?? null,
      quote: p?.text ? String(p.text).slice(0, 500) : null, quoteAt: p?.at ?? null, settingKey: p?.setting_key ?? null,
      sourceEntityId: who, sourceName: nameOf(who), forwardedBy,
      growth: growthOf(core, r.reason),
      withdraw: who ? { entityId: who, from: (p?.at ?? r.created_at) - DAY, to: p?.at ?? r.created_at } : null,
    };
  });
}

/** 【D118】原因是 growth-v<N> 的那一版成长块（core_block_versions 里 name='growth'）。不是、找不到、读不了 → null。 */
function growthOf(core, reason) {
  const m = /^growth-v([1-9]\d{0,8})$/.exec(String(reason ?? ''));
  if (!m) return null;
  try {
    const v = core.store.get("SELECT version, text, change_json, evidence_ids, created_at, created_by, revoked_at FROM core_block_versions WHERE name = 'growth' AND version = ?", Number(m[1]));
    if (!v) return null;
    const cur = core.store.get("SELECT version FROM core_blocks WHERE name = 'growth'")?.version ?? null;
    let change = null;
    let evidence = [];
    try { change = JSON.parse(v.change_json); } catch { change = null; }
    try { evidence = JSON.parse(v.evidence_ids); } catch { evidence = []; }
    return {
      version: v.version, text: String(v.text ?? '').slice(0, 2000), change: change && typeof change === 'object' ? change : null,
      evidenceRefs: Array.isArray(evidence) ? evidence.filter((x) => typeof x === 'string').slice(0, 50) : [],
      createdAt: v.created_at, createdBy: v.created_by, revokedAt: v.revoked_at ?? null, current: cur === v.version,
    };
  } catch { return null; }
}

export function markNeedToKnowRead(core, id) {
  const n = typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : id;
  if (!Number.isSafeInteger(n) || n <= 0) throw bad('needToKnow.markRead', 'id', '应为正整数');
  core.store.run("UPDATE need_to_know SET status = 'read', read_at = ? WHERE id = ? AND status = 'open'", core.now(), n);
}
