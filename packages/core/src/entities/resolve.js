// 认人（§5.2 的五步、§7.1 第 5 步）。
//   resolveActor：入库时只做确定性的部分——她自己、主人的 claim、账号证据精确匹配（第 1 步）、场合内的显示名（第 3 步的确定部分）。
//   resolveExtracted：提炼的 ent 行——关系路径（第 2 步）、别名（第 3 步）、LLM 裁决（第 5 步，和提炼同一次调用），
//     综合得分 ≥ θ_hi 挂到已有档案，≤ θ_lo 新建，中间新建临时档案 + maybe_same。
//   candidates：名字连同上下文的向量候选（第 4 步），给提炼提示词的「候选档案」一栏。
// 几条不变式（§5.2、§14.2「实体」）：
//   - 同命名空间、同作用域、同 id → 同一个人；同命名空间同作用域不同 id 默认不同的人（显示名一样也不合并）；
//   - 中文名只做规范化后的完全相等，不做模糊匹配；拿不准不合并；
//   - 保留名不能被名片冒用；和主人同名的第三方不会被认成主人（只靠名字永远到不了主人 / 她自己身上，带关系描述而主人没有这层关系的直接排除）；
//   - 锚点冲突：阿明的表哥和 B 的表哥，除非已知阿明和 B 有关系，默认不是同一个人；
//   - 自我介绍只产生 maybe_same；权利层只来自锚点本人当面确认（anchor-confirmed）、双向自认（mutual-claim）、
//     平台（同一个 ActorRef 里的几个账号）或主人批准——这几种都只认结构（谁说的、对谁、两边是不是都有账号），不看措辞。
import { refOf, parseRef } from '../store/index.js';
import { normalizeName, cleanRaw, normalizeKind, individualOf } from './normalize.js';
import { entityParams } from './params.js';
import {
  getEntity, createEntity, markDay, setDisplay, addName, addDescriptor, identityKeys, findEvidence, attachEvidence,
  nameNorms, identityNames, claimedNames, accountsClash, namespacesOf, flushEmbeds, bump, warn, errName, STRENGTH_RANK, namesChanged,
} from './records.js';
import { ensureSelf, ensurePrincipal, isReservedOwner } from './own.js';
import { link, sameGroup } from './links.js';
import { repairMentionGhosts } from './repair.js';

/** 提炼提示词里她自己那一行的说话人标记（encode 的 §7.3 输入格式：`[我]`）。ent 行的 descriptor.anchor 也可以是它。 */
export const SELF_ANCHOR = '我';

const round = (x) => Math.round(x * 1000) / 1000;
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

// ── resolveActor ─────────────────────────────────────────────────────────

/** @returns {import('../core-types.js').ResolvedActor} */
function result(core, entityId, via) {
  if (!entityId) return { entityId: null, isSelf: false, isPrincipal: false, via: 'none' };
  const e = getEntity(core, entityId);
  return { entityId, isSelf: e?.is_self === 1, isPrincipal: e?.authority === 'principal', via };
}

/** 一个 ActorRef 带的名字证据都记到 id 上（群名片只在它的场合里算数）。 */
function recordActorNames(core, id, actor, ctx, { nameOnly }) {
  for (const c of actor.claims) {
    if (c?.kind === 'account' && typeof c.displayName === 'string' && c.displayName.trim()) {
      const r = addName(core, id, { raw: c.displayName, kind: 'account', at: ctx.at });
      if (r && !r.spoof) setDisplay(core, id, c.displayName, 'platform');
    } else if (c?.kind === 'display-name' && typeof c.name === 'string' && c.name.trim()) {
      const scope = c.scope ? core.keys.settingKey(ctx.adapterId, c.scope) : (nameOnly ? ctx.settingKey : '');
      const at = Number.isFinite(c.observedAt) ? c.observedAt : ctx.at;
      const r = addName(core, id, { raw: c.name, kind: 'card', scope, at });
      if (r && !r.spoof) {
        const e = getEntity(core, id);
        if (e && !e.display_name) setDisplay(core, id, c.name, 'platform');
      }
    }
  }
}

/** 说话人又出现了一天（established 的依据之一；不加痕迹——痕迹由 noteMention 按编码强度加）。 */
function markSeen(core, id, at) {
  const e = getEntity(core, id);
  if (e) markDay(core, e, at);
}

export function resolveActor(core, actor, ctx) {
  if (!actor || !Array.isArray(actor.claims) || !ctx) return result(core, null, 'none');
  const at = Number.isFinite(ctx.at) ? ctx.at : core.now();
  const c2 = { ...ctx, at };
  return core.store.tx(() => {
    const claims = actor.claims.filter((c) => c && typeof c === 'object');
    const accounts = claims.filter((c) => c.kind === 'account' && typeof c.namespace === 'string' && typeof c.id === 'string');
    // 她自己
    if (actor.self === true) {
      const id = ensureSelf(core);
      attachOwnAccounts(core, id, accounts, ctx.adapterId, null);
      const before = core.store.get('SELECT COUNT(*) AS n FROM entity_names WHERE entity_id = ?', id)?.n ?? 0;
      recordActorNames(core, id, { claims }, c2, { nameOnly: false });
      // 她有了一个新名字（第一次在某个群里说话，带着她的群名片）：顺手撤掉用这个名字造出来的「假人」（评审：原来只在启动时撤，
      // 撤之前那些假人一直让带着她名片的话被当成「点了别人」）；撤了的名字匹配器随之重建
      if ((core.store.get('SELECT COUNT(*) AS n FROM entity_names WHERE entity_id = ?', id)?.n ?? 0) > before) {
        try { if (repairMentionGhosts(core).retracted) namesChanged(core); } catch { /* 下次启动再撤 */ }
      }
      markSeen(core, id, at);
      flushEmbeds(core);
      return result(core, id, 'self');
    }
    // 配置给的「这就是主人」
    if (claims.some((c) => c.kind === 'principal')) {
      const id = ensurePrincipal(core);
      attachOwnAccounts(core, id, accounts, ctx.adapterId, 'config');
      recordActorNames(core, id, { claims }, c2, { nameOnly: false });
      markSeen(core, id, at);
      flushEmbeds(core);
      return result(core, id, 'principal-claim');
    }
    // 第 1 步：账号证据精确匹配
    if (accounts.length) {
      const keys = accounts.map((c) => ({ claim: c, k: identityKeys(core, c) }));
      const owned = keys.map((x) => ({ ...x, ev: findEvidence(core, x.k) }));
      const owners = [...new Set(owned.filter((x) => x.ev).map((x) => x.ev.entity_id))].map((eid) => getEntity(core, eid)).filter(Boolean);
      let id;
      if (!owners.length) {
        id = createEntity(core, { kind: 'person', status: 'provisional', individual: true, at });
        bump(core, 'entities.actor.new');
      } else {
        // 同一个 ActorRef 里的几个账号属于同一个人（适配器说的）。几个档案都对上时：她自己 > 主人 > 证据最强的 > 最早的
        owners.sort((p, q) => (q.is_self - p.is_self) || ((q.authority === 'principal') - (p.authority === 'principal'))
          || (bestStrength(core, q.id) - bestStrength(core, p.id)) || (p.id - q.id));
        id = owners[0].id;
        for (const o of owners.slice(1)) {
          // 适配器在同一个 ActorRef 里给了这几个账号（都经过核实）= 平台说是同一个人
          const allVerified = accounts.every((c) => STRENGTH_RANK[c.verifiedBy] !== undefined);
          link(core, id, o.id, { rel: allVerified ? 'same' : 'maybe_same', confidence: allVerified ? 0.95 : 0.7,
            evidence: ['actor-claims'], decidedBy: allVerified ? 'platform' : 'extractor', at });
        }
      }
      for (const x of owned) if (!x.ev) attachEvidence(core, id, x.k, strengthOf(x.claim), { adapter: ctx.adapterId, via: 'actor' });
      recordActorNames(core, id, { claims }, c2, { nameOnly: false });
      markSeen(core, id, at);
      flushEmbeds(core);
      return result(core, id, 'identity');
    }
    // 第 3 步的确定部分：只有显示名的说话人，在本场合里按显示名认（群名片只在本场合有效）
    const names = claims.filter((c) => c.kind === 'display-name' && typeof c.name === 'string' && c.name.trim());
    if (!names.length) return result(core, null, 'none');
    // 她自己的名字（任何场合记下的）：只靠名字永远不新建一个叫她名字的「人」（D108：她的群名片被认成了两个别的人）。
    // 提及（role = 'mention'，话里点到了谁）只认人、不给权利：对上她自己的名字就是她，对上这里有管理权限的人（主人的群名片）就是他，
    // 都不记名字；名字太短（< 2 字，「@我」）的提及不认；只有名字的提及永远不新建（D160，见下面）
    const norms = names.map((c) => ({ c, norm: normalizeName(cleanRaw(c.name)), scope: c.scope ? core.keys.settingKey(ctx.adapterId, c.scope) : ctx.settingKey }));
    const selfHit = norms.some((x) => x.norm && core.store.get(`SELECT 1 AS x FROM entity_names n JOIN entities e ON e.id = n.entity_id
        WHERE e.is_self = 1 AND n.text_norm = ? LIMIT 1`, x.norm));
    if (ctx.role === 'mention') {
      if (selfHit) { bump(core, 'entities.mention.self'); return result(core, ensureSelf(core), 'mention-self'); }
      for (const x of norms) {
        const r = x.norm ? core.store.get(`SELECT DISTINCT n.entity_id AS id FROM entity_names n JOIN entities e ON e.id = n.entity_id
            WHERE n.text_norm = ? AND (n.scope_setting_key = ? OR n.scope_setting_key = '') AND e.authority <> 'none' AND e.is_self = 0 AND e.status <> 'retracted'
            AND n.spoof = 0 LIMIT 2`, x.norm, x.scope) : null;
        if (r) { bump(core, 'entities.mention.authority'); return result(core, r.id, 'mention-authority'); }
      }
      if (norms.every((x) => [...String(x.c.name).trim()].length < 2)) { bump(core, 'entities.mention.tooShort'); return result(core, null, 'none'); }
    }
    const found = new Map();
    for (const c of names) {
      const scope = c.scope ? core.keys.settingKey(ctx.adapterId, c.scope) : ctx.settingKey;
      const norm = normalizeName(cleanRaw(c.name));
      for (const r of core.store.all(`SELECT DISTINCT n.entity_id AS id, e.is_self, e.authority FROM entity_names n JOIN entities e ON e.id = n.entity_id
          WHERE n.scope_setting_key = ? AND n.text_norm = ? AND n.name_kind IN ('card', 'account') AND e.status <> 'retracted'`, scope, norm)) {
        found.set(r.id, r);
      }
    }
    // 保留名不能被名片冒用：只靠显示名永远认不到她自己或有管理权限的人身上
    const cands = [...found.values()].filter((r) => !r.is_self && r.authority === 'none');
    // 提及（D160）：「@名字」只是一个名字，不是这个人存在的证据。这个场合里正好一个人的平台名（群名片 / 账号昵称）是它 → 就是他；
    // 几个人都叫这个 → 拿不准；谁都不叫这个 → 不认、也不新建（名字留在原文里，提炼看上下文再定）。
    // 认出来了也不记名字、不记「又出现了一天」：提及不是起名的证据，intake 对认出的提及调 noteMention（记日子和痕迹）
    if (ctx.role === 'mention') {
      if (cands.length === 1) { bump(core, 'entities.mention.byName'); return result(core, cands[0].id, 'mention-name'); }
      if (cands.length > 1) { bump(core, 'entities.mention.ambiguous'); return result(core, null, 'none'); }
      bump(core, 'entities.mention.unresolved');
      return result(core, null, 'none');
    }
    // 这个适配器给过账号的人，适配器本该带账号来；只有名字的说话人对上他 → 拿不准，留给提炼
    // （命名空间通常就是适配器 id；也认证据上记的来源适配器）。只管说话人：提及本来就不带账号
    const withAccount = cands.filter((r) => core.store.get(`SELECT 1 AS x FROM identity_evidence WHERE entity_id = ?
        AND (namespace = ? OR json_extract(source_json, '$.adapter') = ?) LIMIT 1`, r.id, ctx.adapterId, ctx.adapterId));
    let id = null;
    if (withAccount.length) { bump(core, 'entities.actor.ambiguous'); return result(core, null, 'none'); }
    if (cands.length === 1) id = cands[0].id;
    else if (cands.length > 1) { bump(core, 'entities.actor.ambiguous'); return result(core, null, 'none'); }
    else {
      if (selfHit) { bump(core, 'entities.actor.selfNameRefused'); return result(core, null, 'none'); }
      id = createEntity(core, { kind: 'person', status: 'provisional', individual: true, at });
      bump(core, 'entities.actor.newByName');
    }
    recordActorNames(core, id, { claims: names }, c2, { nameOnly: true });
    markSeen(core, id, at);
    flushEmbeds(core);
    return result(core, id, 'scoped-name');
  });
}

/** 账号证据的强度（契约校验过的只有 platform / config / owner；别的值按最弱的 platform 记，不让一条坏 claim 弄坏整批）。 */
const strengthOf = (c) => (STRENGTH_RANK[c?.verifiedBy] !== undefined ? c.verifiedBy : 'platform');

function bestStrength(core, id) {
  let best = 0;
  for (const r of core.store.all('SELECT strength FROM identity_evidence WHERE entity_id = ?', id)) best = Math.max(best, STRENGTH_RANK[r.strength] ?? 0);
  return best;
}

/** 她自己 / 主人的 ActorRef 里带的账号：还没归属的挂上去；已经属于别人的不动（记一笔冲突）。 */
function attachOwnAccounts(core, id, accounts, adapterId, strengthOverride) {
  for (const c of accounts) {
    const k = identityKeys(core, c);
    const r = attachEvidence(core, id, k, strengthOverride ?? strengthOf(c), { adapter: adapterId, via: 'actor' });
    if (r === 'conflict') { bump(core, 'entities.identity.conflict'); warn(core, 'entities.identity.conflict', { entity: id }); }
  }
}

// ── resolveExtracted ─────────────────────────────────────────────────────

/** ent 行的证据消息（ctx.msgRefs：本批消息编号 → 感知 id）。 */
function evidenceIds(e, ctx) {
  const ids = [];
  for (const r of Array.isArray(e.msgRefs) ? e.msgRefs : []) {
    const pid = ctx.msgRefs instanceof Map ? ctx.msgRefs.get(r) : undefined;
    if (Number.isInteger(pid) && pid > 0 && !ids.includes(pid)) ids.push(pid);
  }
  return ids.slice(0, 16);
}

/** 证据消息的说话人编号（ctx.actorCodes：感知 id → 本批说话人编号）。 */
function evidenceSpeakerCodes(e, ctx) {
  if (!(ctx.actorCodes instanceof Map)) return [];
  return [...new Set(evidenceIds(e, ctx).map((pid) => ctx.actorCodes.get(pid)).filter((c) => typeof c === 'string' && c))];
}

/** ent 行的证据：哪几条感知、谁说的、什么时候、编码强度（听说不打折，§6.2）。 */
function evidenceOf(core, e, ctx, out) {
  const ids = evidenceIds(e, ctx);
  const rows = ids.map((pid) => core.store.get('SELECT id, actor_entity_id, at, w_enc FROM percepts WHERE id = ?', pid)).filter(Boolean);
  let speaker = null;
  const speakers = [...new Set(rows.map((r) => r.actor_entity_id).filter((x) => Number.isInteger(x) && x > 0))];
  if (speakers.length) speaker = rows.find((r) => r.actor_entity_id)?.actor_entity_id ?? speakers[0];
  else {
    // 入库时没认出来的说话人（只有名字、拿不准）：encode 把他也作为一行交过来，本批里已经立了档（拓扑序保证先处理他）
    for (const code of evidenceSpeakerCodes(e, ctx)) {
      const id = code === e.local ? null : codeEntity(core, code, ctx, out);
      if (id) { speaker = id; break; }
    }
  }
  const at = rows.length ? Math.max(...rows.map((r) => r.at)) : (Number.isFinite(ctx.at) ? ctx.at : core.now());
  const wEnc = rows.length ? Math.max(...rows.map((r) => r.w_enc || 0)) : 0;
  const w = wEnc > 0 ? wEnc : (Number.isFinite(ctx.w) && ctx.w > 0 ? ctx.w : 1);
  return { perceptIds: rows.map((r) => r.id), speaker, at, w, known: rows.length > 0 };
}

const liveId = (core, v) => Number.isInteger(v) && v > 0 && !!getEntity(core, v);

/** 本批编号（说话人 'U3'、本批的另一行 'E1'、候选档案 'c2'）→ 实体 id；认不出返回 null。 */
function codeEntity(core, code, ctx, out) {
  if (Number.isInteger(code)) return liveId(core, code) ? code : null;   // 【补】调用方已经换成了实体 id
  if (typeof code !== 'string' || !code) return null;
  if (ctx.speakers instanceof Map && ctx.speakers.has(code)) {
    const v = ctx.speakers.get(code);
    if (liveId(core, v)) return v;
    // 入库时没认出来的说话人（只有名字）：encode 会把他也作为一行 ent 交过来，本批里可能刚立了档
    return out.get(code) ?? null;
  }
  if (out.has(code)) return out.get(code);
  const c = ctx.candidateCodes instanceof Map ? ctx.candidateCodes.get(code) : undefined;
  return liveId(core, c) ? c : null;
}

function resolveAnchor(core, desc, ctx, out, selfId) {
  if (!desc || typeof desc.relation !== 'string' || !desc.relation.trim()) return null;
  if (desc.anchor === SELF_ANCHOR && !(ctx.speakers instanceof Map && ctx.speakers.has(SELF_ANCHOR))) return selfId;
  return codeEntity(core, desc.anchor, ctx, out);
}

/** 锚点的「关系人」：认成同一个人的（含 maybe_same），以及和它之间有关系描述的（「已知阿明和 B 是亲戚」）。 */
function relatedTo(core, anchor) {
  const group = sameGroup(core, anchor, { includeMaybe: true });
  const out = new Set(group);
  for (const a of group) {
    for (const r of core.store.all('SELECT anchor_entity_id AS x FROM entity_descriptors WHERE entity_id = ? UNION SELECT entity_id AS x FROM entity_descriptors WHERE anchor_entity_id = ?', a, a)) out.add(r.x);
  }
  return out;
}

/** 某个档案在（这组锚点，这种关系）下的描述是谁给的、哪几天。 */
function descriptorRows(core, entityId, anchors, rel) {
  const list = [...anchors];
  const ph = list.map(() => '?').join(',');
  return core.store.all(`SELECT basis, speaker_entity_id AS speaker, first_at, last_at FROM entity_descriptors
    WHERE entity_id = ? AND relation = ? AND anchor_entity_id IN (${ph})`, entityId, rel, ...list);
}

/** 一组档案按信念层的 same 归簇：id → 簇的代表（簇里在 ids 中最先出现的那个）。 */
function clustersOf(core, ids) {
  const rep = new Map();
  for (const id of ids) {
    if (rep.has(id)) continue;
    const g = sameGroup(core, id);
    for (const o of ids) if (g.has(o) && !rep.has(o)) rep.set(o, id);
  }
  return rep;
}

/** （这组锚点，这种关系）下除了自称以外有描述的档案（锚点本人、旁人或主人说过的）。 */
function relationProfiles(core, anchors, rel, { includeSelfClaims = false } = {}) {
  const list = [...anchors];
  const ph = list.map(() => '?').join(',');
  return [...new Set(core.store.all(`SELECT DISTINCT d.entity_id AS id FROM entity_descriptors d JOIN entities e ON e.id = d.entity_id
      WHERE d.relation = ? AND d.anchor_entity_id IN (${ph}) AND e.status <> 'retracted' ${includeSelfClaims ? '' : "AND d.basis <> 'self-claim'"}`,
  rel, ...list).map((r) => r.id))].filter((id) => !anchors.has(id));
}

/** descriptorSupport 用：按（锚点，关系原文）取某个档案的描述行（锚点按信念层的 same 展开）。 */
export function descriptorRowsFor(core, entityId, anchorId, relation) {
  const rel = normalizeName(cleanRaw(typeof relation === 'string' ? relation : '', 32));
  if (!rel || !Number.isInteger(anchorId) || anchorId <= 0 || !Number.isInteger(entityId)) return [];
  return descriptorRows(core, entityId, sameGroup(core, anchorId), rel);
}

/**
 * 「多条独立描述吻合」（§5.2）：来自不同的、established 的说话人，而且跨 ≥ minDays 天。防几个小号凑出来。
 * @param {{speaker: number, at: number}[]} [extra] 这次提及也算一条（说话人 established 才算）
 */
export function corroboration(core, rows, extra = [], exclude = new Set()) {
  const P = entityParams(core);
  const speakers = new Set();
  const days = new Set();
  const dayOf = (t) => Math.floor(t / 86_400_000);
  const ok = (sp) => {
    if (!Number.isInteger(sp) || sp <= 0 || exclude.has(sp)) return false;
    const e = getEntity(core, sp);
    return !!e && e.status === 'established' && !e.is_self;
  };
  for (const r of rows) {
    if (r.basis === 'self-claim' || !ok(r.speaker)) continue;
    speakers.add(r.speaker);
    days.add(dayOf(r.first_at)); days.add(dayOf(r.last_at));
  }
  for (const x of extra) if (ok(x.speaker)) { speakers.add(x.speaker); days.add(dayOf(x.at)); }
  return {
    speakers: speakers.size,
    days: days.size,
    qualifies: speakers.size >= P.independentDescriptors.minSpeakers && days.size >= P.independentDescriptors.minDays,
  };
}

/**
 * 一条 ent 行的候选打分（第 2、3、5 步）。返回 Map<entityId, {s, why: string[], hard: 'cap'|'exclude'|null}>。
 */
function scoreCandidates(core, e, x, P) {
  /** @type {Map<number, {s: number, why: string[], hard: 'cap'|'exclude'|null}>} */
  const cands = new Map();
  const put = (id, s, why) => {
    const c = cands.get(id);
    if (!c) cands.set(id, { s, why: [why], hard: null });
    else { if (s > c.s) c.s = s; if (!c.why.includes(why)) c.why.push(why); }
  };
  const skip = (id) => id === x.anchor || (x.anchors && x.anchors.has(id));
  // 种类对不上（叫「咪咪」的人和叫「咪咪」的猫、场合和人）：只靠名字或裁决不合并
  const kindClash = (ent) => x.kind !== 'unknown' && ent.kind !== 'unknown' && !ent.is_self
    && (individualOf(x.kind, e.individual) !== (ent.individual === 1) || (x.kind === 'setting') !== (ent.kind === 'setting'));
  // ── 第 2 步：关系路径（先认出锚点，再在锚点的关系里找）
  if (x.anchor && x.rel) {
    const ph = [...x.anchors].map(() => '?').join(',');
    const ids = [...new Set(core.store.all(`SELECT DISTINCT d.entity_id AS id FROM entity_descriptors d JOIN entities e ON e.id = d.entity_id
        WHERE d.relation = ? AND d.anchor_entity_id IN (${ph}) AND e.status <> 'retracted'`, x.rel, ...x.anchors).map((r) => r.id))]
      .filter((id) => !skip(id));
    const nameMatched = ids.filter((id) => x.name && nameNorms(core, id).has(x.name));
    const rowsOf = new Map(ids.map((id) => [id, descriptorRows(core, id, x.anchors, x.rel)]));
    const selfClaimOnly = (id) => rowsOf.get(id).every((r) => r.basis === 'self-claim');
    // 已经认成同一个人（same）的几个档案算一个：锚点确认过的自称者和原来的档案不互相变得「分不清」
    const cluster = clustersOf(core, ids);
    const count = (list) => new Set(list.map((id) => cluster.get(id))).size;
    // 只有当事人自称的档案不让别的档案变得「分不清」（自称是弱证据）
    const solid = ids.filter((id) => !selfClaimOnly(id));
    for (const id of ids) {
      const rows = rowsOf.get(id);
      const bases = new Set(rows.map((r) => r.basis));
      const names = nameNorms(core, id);
      const conflict = !!x.name && names.size > 0 && !names.has(x.name);
      const unique = selfClaimOnly(id) ? count(ids) === 1 : count(solid) === 1;
      let s;
      if (conflict) s = P.scores.relationNameConflict;                 // 阿明的两个表哥：小刚 ≠ 小李
      else if (unique || nameMatched.includes(id)) {
        const reliable = x.firstPerson || bases.has('first-person') || bases.has('owner')
          || corroboration(core, rows, x.speaker ? [{ speaker: x.speaker, at: x.at }] : [], new Set([id])).qualifies;
        s = reliable ? P.scores.relationStrong : P.scores.relationWeak;
      } else s = P.scores.relationAmbiguous;
      // 只有当事人自称：最多 maybe_same。例外：锚点本人用这个人自己的账号名 / 名片叫他（「xxx 就是我表哥」）——这是在确认他的自称
      const confirmsClaim = x.firstPerson && !!x.name && identityNames(core, id).has(x.name);
      if (selfClaimOnly(id) && !confirmsClaim) s = Math.min(s, P.scores.selfClaimCap);
      put(id, s, 'relation');
    }
  }
  // ── 第 3 步：别名（同名只算中等证据）
  if (x.name) {
    const rows = core.store.all(`SELECT n.entity_id AS id, n.name_kind, n.scope_setting_key AS scope, n.used_by, n.reserved
        FROM entity_names n JOIN entities e ON e.id = n.entity_id WHERE n.text_norm = ? AND n.spoof = 0 AND e.status <> 'retracted'`, x.name);
    const byId = new Map();
    for (const r of rows) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
    for (const [id, rs] of byId) {
      if (skip(id) || cands.get(id)?.why.includes('relation')) continue;
      const ent = getEntity(core, id);
      if (!ent) continue;
      const here = rs.some((r) => r.scope === x.settingKey || (r.scope === '' && r.name_kind !== 'card'));
      const globalish = rs.some((r) => r.name_kind !== 'card');
      let s = here || globalish ? P.scores.name : P.scores.nameOtherScope;
      if (x.speaker && rs.some((r) => r.used_by === x.speaker)) s += P.scores.nameSameSpeaker;   // 同一个人这样叫过他
      if (rs.some((r) => r.scope === x.settingKey)) s += P.scores.nameSameScope;
      // 平台在这个场合里就是用这个名字显示他的账号（D160）：这里的人说这个名字就是指他，除非上下文另有所指
      if (x.settingKey && rs.some((r) => r.scope === x.settingKey && (r.name_kind === 'card' || r.name_kind === 'account'))
        && core.store.get('SELECT 1 AS x FROM identity_evidence WHERE entity_id = ? LIMIT 1', id)) {
        s = Math.max(s, P.scores.platformNameHere);
      }
      const reservedOwner = isReservedOwner(ent);
      if (reservedOwner) s = Math.min(s, P.scores.reservedOwnerName);   // 只靠保留名到不了主人 / 她自己
      let hard = null;
      if (kindClash(ent)) { s = Math.min(s, P.thetaLo); hard = 'cap'; }
      if (x.anchor && x.rel) {
        // 提及带关系描述（「我表妹小林」），而这个同名的档案不在这条关系路径上
        const other = core.store.all('SELECT DISTINCT anchor_entity_id AS a FROM entity_descriptors WHERE entity_id = ? AND relation = ?', id, x.rel).map((r) => r.a);
        if (other.length && other.some((a) => !x.related.has(a))) { s = Math.min(s, P.thetaLo); hard ??= 'cap'; }   // 锚点冲突
        else {
          s -= P.scores.descriptorMismatch;
          if (reservedOwner) hard = 'exclude';                          // 和主人同名的第三方不会被认成主人
        }
      }
      put(id, round(s), 'name');
      if (hard) cands.get(id).hard = hard;
    }
  }
  // ── 第 5 步：LLM 批量裁决（和提炼同一次调用）。代码定下的硬约束（锚点冲突、保留名）推翻不了
  const v = e.verdict;
  if (v && typeof v === 'object') {
    const c = clamp01(v.confidence);
    const m = Number.isInteger(v.match) ? v.match : null;
    if (m != null && m > 0 && !skip(m) && !cands.has(m)) {
      const ent = getEntity(core, m);
      if (ent && ent.status !== 'retracted') {
        // 模型挑了一个名字和关系路径都没找到的档案（比如向量候选）：从中等偏下起步
        put(m, P.thetaLo, 'verdict');
        if (isReservedOwner(ent)) cands.get(m).hard = x.rel ? 'exclude' : 'cap';
        else if (kindClash(ent)) cands.get(m).hard = 'cap';
        else if (x.anchor && x.rel) {
          const other = core.store.all('SELECT DISTINCT anchor_entity_id AS a FROM entity_descriptors WHERE entity_id = ? AND relation = ?', m, x.rel).map((r) => r.a);
          if (other.some((a) => !x.related.has(a))) cands.get(m).hard = 'cap';
        }
      }
    }
    const picked = m != null && cands.has(m) && cands.get(m).hard !== 'exclude';
    for (const [id, cand] of cands) {
      if (cand.hard === 'exclude') continue;
      if (picked && id === m) cand.s = 1 - (1 - cand.s) * (1 - P.scores.verdictWeight * c);
      // 模型挑了别的；或者说「新建」——那是对给它看过的候选档案的判断（D160）：只凭名字表找到、没给它看过的，谈不上被它否了。
      // 关系路径找到的照旧打折：「我另一个表哥」说「新建」是在说这条关系下又多了一个人，不管那个档案有没有排进候选栏
      else if (picked || (v.match === null && (x.shown.has(id) || cand.why.includes('relation')))) cand.s = cand.s * (1 - P.scores.verdictNewPenalty * c);
      if (cand.hard === 'cap') cand.s = Math.min(cand.s, P.thetaLo);
      cand.s = round(cand.s);
      if (picked && id === m && !cand.why.includes('verdict')) cand.why.push('verdict');
    }
  }
  for (const [id, cand] of cands) if (cand.hard === 'exclude') cands.delete(id);
  return cands;
}

/**
 * 拓扑序：descriptor.anchor（或 speaker）指向本批另一个 local 的，先处理被指向的；有环就去掉后面那条描述。
 * 说话人编号本身也可能是一行 local（入库时没认出来的说话人），这时同样先处理它。
 */
function topoOrder(ents, ctx) {
  const byLocal = new Map();
  for (const e of ents) if (e && typeof e.local === 'string' && !byLocal.has(e.local)) byLocal.set(e.local, e);
  const known = (a) => ctx.speakers instanceof Map && Number.isInteger(ctx.speakers.get(a)) && ctx.speakers.get(a) > 0;
  const order = [];
  const state = new Map();   // 1 访问中，2 完成
  const visit = (local) => {
    const e = byLocal.get(local);
    if (!e || state.get(local) === 2) return;
    state.set(local, 1);
    const a = e.descriptor?.anchor;
    if (typeof a === 'string' && byLocal.has(a) && !known(a)) {
      if (state.get(a) === 1 || a === local) byLocal.set(local, { ...e, descriptor: null });   // 环：这条描述不要了
      else visit(a);
    }
    const sp = byLocal.get(local).speaker;
    if (typeof sp === 'string' && sp !== local && byLocal.has(sp) && !known(sp) && state.get(sp) !== 1) visit(sp);
    // 证据消息的说话人入库时没认出来、本批里有他那一行的：也先处理他（才知道这一行是谁说的）
    for (const c of evidenceSpeakerCodes(e, ctx)) if (c !== local && byLocal.has(c) && !known(c) && state.get(c) !== 1) visit(c);
    state.set(local, 2);
    order.push(byLocal.get(local));
  };
  for (const local of byLocal.keys()) visit(local);
  return order;
}

/**
 * 把一批 ent 行落成实体。见 index.js 的 resolveExtracted()。
 * @returns {Map<string, number>}
 */
export function resolveExtracted(core, ents, ctx) {
  const out = new Map();
  if (!Array.isArray(ents) || !ents.length || !ctx) return out;
  return core.store.tx(() => {
    const selfId = ensureSelf(core);
    const batchSpeakers = new Set([...(ctx.speakers instanceof Map ? ctx.speakers.values() : [])].filter((v) => Number.isInteger(v) && v > 0));
    for (const e of topoOrder(ents, ctx)) {
      try {
        const id = core.store.tx(() => resolveOne(core, e, ctx, out, selfId, batchSpeakers));
        if (id) out.set(e.local, id);
        // 入库时没认出来的说话人在本批立了档：他也在这段对话里（「当面」确认要看他在不在场）
        if (id && ctx.speakers instanceof Map && ctx.speakers.has(e.local) && e.local !== SELF_ANCHOR) batchSpeakers.add(id);
      } catch (err) {
        // 一行坏了只丢这一行（它在自己的 SAVEPOINT 里，写了一半的都回滚了）
        bump(core, 'entities.extracted.error');
        warn(core, 'entities.extracted.error', { job: ctx.jobId ?? null, error: errName(err) });
      }
    }
    flushEmbeds(core);
    return out;
  });
}

function resolveOne(core, e, ctx, out, selfId, batchSpeakers) {
  const P = entityParams(core);
  const ev = evidenceOf(core, e, ctx, out);
  const settingKey = typeof ctx.settingKey === 'string' ? ctx.settingKey : '';
  const sourceKey = ev.speaker ? refOf('entity', ev.speaker) : 'unknown';
  // 这一行说的就是本批的某个说话人（自我介绍「我是阿明的表哥」，或者锚点当面指认「对，他就是我表哥」）
  if (typeof e.speaker === 'string' && ctx.speakers instanceof Map && ctx.speakers.has(e.speaker)) {
    const sid = codeEntity(core, e.speaker, ctx, out);
    if (sid && sid !== selfId) return aboutSpeaker(core, e, sid, ctx, out, selfId, ev, P, settingKey);
  }
  const anchor = resolveAnchor(core, e.descriptor, ctx, out, selfId);
  const relRaw = anchor ? cleanRaw(e.descriptor.relation, 32) : '';
  const rel = relRaw ? normalizeName(relRaw) : '';
  const nameRaw = cleanRaw(typeof e.name === 'string' ? e.name : '');
  const name = nameRaw ? normalizeName(nameRaw) : '';
  const fullRaw = cleanRaw(typeof e.verdict?.fullName === 'string' ? e.verdict.fullName : '');
  if (!name && !(anchor && rel) && !Number.isInteger(e.verdict?.match)) { bump(core, 'entities.extracted.empty'); return null; }
  const anchors = anchor ? sameGroup(core, anchor) : new Set();
  // 锚点本人说的（「我表哥」），或者（不知道是谁说的时）锚点本人就在这段对话里
  const firstPerson = !!anchor && (ev.speaker ? anchors.has(ev.speaker) : batchSpeakers.has(anchor));
  // 给模型看过的候选档案（提示词「候选档案」一栏）；没有这一栏的调用方（导入）没给模型看过任何档案
  const shown = new Set(ctx.candidateCodes instanceof Map ? [...ctx.candidateCodes.values()].filter((v) => Number.isInteger(v)) : []);
  const x = { anchor, anchors, related: anchor ? relatedTo(core, anchor) : new Set(), rel, name, speaker: ev.speaker, at: ev.at, firstPerson, settingKey,
    kind: normalizeKind(e.kind), shown };
  const cands = scoreCandidates(core, e, x, P);
  const list = [...cands.entries()].map(([id, c]) => ({ id, ...c })).sort((p, q) => q.s - p.s || p.id - q.id);
  const top = list[0];
  // 和第一名已经认成同一个人（same）的不算竞争者
  const topGroup = top ? sameGroup(core, top.id) : new Set();
  const second = list.find((c) => c !== top && !topGroup.has(c.id));
  let id;
  const kind = normalizeKind(e.kind);
  if (top && top.s >= P.thetaHi && (!second || second.s < P.thetaHi || top.s - second.s >= P.scores.attachMargin)) {
    id = top.id;
    bump(core, 'entities.extracted.attached');
    const ent = getEntity(core, id);
    if (ent && ent.kind === 'unknown' && kind !== 'unknown') {
      core.store.run('UPDATE entities SET kind = ?, individual = ?, updated_at = ? WHERE id = ?', kind, individualOf(kind, e.individual) ? 1 : 0, core.now(), id);
    }
  } else {
    id = createEntity(core, { kind, status: 'provisional', individual: individualOf(kind, e.individual), at: ev.at });
    bump(core, 'entities.extracted.created');
    const evidence = ev.perceptIds.map((p) => refOf('percept', p));
    if (!evidence.length && Number.isInteger(ctx.jobId)) evidence.push(`job:${ctx.jobId}`);
    // 同一个人的几个档案（same）只挂代表的那一条
    const linked = new Set();
    for (const c of list.filter((c) => c.s > P.thetaLo)) {
      if (linked.size >= P.maxMaybeLinks) break;
      if ([...linked].some((l) => sameGroup(core, l).has(c.id))) continue;
      link(core, id, c.id, { rel: 'maybe_same', confidence: c.s, evidence, decidedBy: 'extractor', at: ev.at });
      linked.add(c.id);
    }
  }
  // 名字、关系描述、提到痕迹
  if (nameRaw) addName(core, id, { raw: nameRaw, usedBy: ev.speaker ?? 0, scope: settingKey, kind: 'mention', at: ev.at });
  if (fullRaw && normalizeName(fullRaw) !== name) addName(core, id, { raw: fullRaw, usedBy: ev.speaker ?? 0, scope: settingKey, kind: 'mention', at: ev.at });
  if (fullRaw) setDisplay(core, id, fullRaw, 'extract');
  else if (nameRaw && !getEntity(core, id)?.display_name) setDisplay(core, id, nameRaw, 'extract');
  if (anchor && rel && anchor !== id) {
    const firstHand = !!ev.speaker && sameGroup(core, anchor, { rights: true }).has(ev.speaker);
    // 锚点本人当面指认一个自称是他「表哥」的人（「xxx 就是我表哥」，xxx 正在这段对话里）：确认他的自称（权利层，§5.2）
    const confirming = firstHand && batchSpeakers.has(id) && descriptorRows(core, id, anchors, rel).some((r) => r.basis === 'self-claim');
    addDescriptor(core, id, {
      anchor, relationRaw: relRaw, basis: ev.speaker && anchors.has(ev.speaker) ? 'first-person' : 'third-party',
      speaker: ev.speaker, settingKey, at: ev.at, perceptIds: ev.perceptIds, jobId: ctx.jobId ?? null,
    });
    if (confirming) confirmByAnchor(core, id, anchors, rel, ev, P, name ? new Set([name]) : new Set());
  }
  noteMentionInternal(core, id, { at: ev.at, w: ev.w, sourceKey });
  return id;
}

/**
 * 一行说的是本批的某个说话人自己（§1.2 第 5 步、§5.2「链接分两层」）。谁说的决定它有多大分量：
 *   - 他自己说的（「我是阿明的表哥」「我 B站 就是 xxx」）：自称。认得出（maybe_same），不给权利；
 *     对方之前也自称是他（双向自认，两边都有账号）→ same，decided_by='mutual-claim'；
 *   - 锚点本人当面说的（阿明说「对，他就是我表哥」）：锚点确认 → 和阿明那个表哥的档案 same，decided_by='anchor-confirmed'；
 *   - 别人说的：旁人的说法，只到 maybe_same。
 * 主人和她自己永远不会被这样挂上（账号证据和说法都不能把别人挂到主人身上）。
 */
function aboutSpeaker(core, e, sid, ctx, out, selfId, ev, P, settingKey) {
  const at = ev.at;
  const anchor = resolveAnchor(core, e.descriptor, ctx, out, selfId);
  const relRaw = anchor ? cleanRaw(e.descriptor.relation, 32) : '';
  const rel = relRaw ? normalizeName(relRaw) : '';
  const nameRaw = cleanRaw(typeof e.name === 'string' ? e.name : '');
  const name = nameRaw ? normalizeName(nameRaw) : '';
  const mine = sameGroup(core, sid, { rights: true });
  // 不知道是谁说的（没有 msgRefs）：按最弱的自称算
  const bySelf = !ev.speaker || mine.has(ev.speaker);
  const byAnchor = !bySelf && !!anchor && sameGroup(core, anchor, { rights: true }).has(ev.speaker);
  const evidence = ev.perceptIds.map((p) => refOf('percept', p));
  if (!evidence.length) evidence.push(bySelf ? 'self-introduction' : 'introduced');
  if (nameRaw) addName(core, sid, { raw: nameRaw, usedBy: ev.speaker ?? sid, scope: settingKey, kind: bySelf ? 'self-intro' : 'mention', at });
  if (anchor && rel && !mine.has(anchor)) {
    const anchors = sameGroup(core, anchor);
    addDescriptor(core, sid, {
      anchor, relationRaw: relRaw, basis: bySelf ? 'self-claim' : byAnchor ? 'first-person' : 'third-party',
      speaker: ev.speaker ?? sid, settingKey, at, perceptIds: ev.perceptIds, jobId: ctx.jobId ?? null,
    });
    if (byAnchor) confirmByAnchor(core, sid, anchors, rel, ev, P, name ? new Set([name]) : new Set());
    else {
      // 自称 / 旁人的说法：和锚点下同关系、名字对得上的档案挂 maybe_same
      const ids = relationProfiles(core, anchors, rel).filter((id) => linkable(core, sid, id));
      const cluster = clustersOf(core, ids);
      const groups = new Set(ids.map((id) => cluster.get(id))).size;
      const scored = [];
      for (const id of ids) {
        if (cluster.get(id) !== id) continue;                           // 同一个人的几个档案只挂一条
        const names = nameNorms(core, id);
        if (name && names.size && !names.has(name)) continue;            // 报的名字和那个档案对不上
        let s = name && names.has(name) ? P.scores.selfClaimCap : (groups === 1 ? P.scores.relationAmbiguous + 0.1 : P.scores.relationAmbiguous);
        if (!bySelf) s = Math.min(s, P.scores.relationWeak);
        scored.push({ id, s });
      }
      scored.sort((p, q) => q.s - p.s || p.id - q.id);
      for (const c of scored.slice(0, P.maxMaybeLinks)) {
        link(core, sid, c.id, { rel: 'maybe_same', confidence: round(Math.min(c.s, P.thetaHi - 0.01)), evidence, decidedBy: 'extractor', at });
        if (bySelf) queueIdentityClaim(core, sid, c.id);
      }
    }
    bump(core, bySelf ? 'entities.selfIntroduction' : byAnchor ? 'entities.anchorIntroduction' : 'entities.thirdPartyIntroduction');
  } else if (name) {
    claimByName(core, sid, name, bySelf, ev, P, evidence);
    bump(core, bySelf ? 'entities.selfIntroduction' : 'entities.thirdPartyIntroduction');
  }
  noteMentionInternal(core, sid, { at, w: ev.w, sourceKey: refOf('entity', ev.speaker ?? sid) });
  return sid;
}

/**
 * 能不能把 sid 和 other 自动认成（可能是）同一个人：不是同一个、不是她自己或主人、都是具体的个人、
 * 不是同命名空间同作用域的两个不同账号（默认不同的人）。
 */
function linkable(core, sid, other, { allowAccountClash = false } = {}) {
  if (sid === other) return false;
  const o = getEntity(core, other);
  if (!o || o.status === 'retracted' || isReservedOwner(o) || o.individual !== 1) return false;
  if (sameGroup(core, sid).has(other)) return false;
  return allowAccountClash || !accountsClash(core, sid, other);
}

/**
 * 锚点本人当面确认 claimant 是他的（rel）：在锚点下同关系的档案里找「就是这个人」的那一个，挂 same（anchor-confirmed，权利层）。
 *   - 名字对得上的那一簇（claimant 的任何名字 ∩ 档案的名字）；
 *   - 或者锚点下这种关系只有一个档案（「阿明的表哥」就这一个），而且名字不冲突；
 *   - 分不清（几个表哥、没名字）就只挂 maybe_same，交给之后的证据或主人。
 * @param {Set<string>} extraClaimed 这次说的名字（不是 claimant 自己的账号名 / 名片时，按「他叫这个」算）
 */
function confirmByAnchor(core, claimant, anchors, rel, ev, P, extraClaimed) {
  const own = identityNames(core, claimant);
  const claimed = new Set([...claimedNames(core, claimant), ...[...extraClaimed].filter((n) => !own.has(n))]);
  const allNames = nameNorms(core, claimant);
  const ids = relationProfiles(core, anchors, rel).filter((id) => linkable(core, claimant, id, { allowAccountClash: true }));
  const cluster = clustersOf(core, ids);
  const verdicts = [];
  for (const rep of new Set(ids.map((id) => cluster.get(id)))) {
    const members = ids.filter((id) => cluster.get(id) === rep);
    const names = new Set(members.flatMap((id) => [...nameNorms(core, id)]));
    const match = [...allNames].some((n) => names.has(n));
    const conflict = !match && claimed.size > 0 && names.size > 0 && ![...claimed].some((n) => names.has(n));
    // 两个不同的账号（同命名空间同作用域）默认不同的人：锚点一句话也不够认成 same
    const clash = members.some((id) => accountsClash(core, claimant, id));
    verdicts.push({ rep, match, conflict, clash });
  }
  const evidence = ev.perceptIds.map((p) => refOf('percept', p));
  if (!evidence.length) evidence.push('anchor-confirmed');
  const usable = verdicts.filter((v) => !v.conflict);
  const matched = usable.filter((v) => v.match);
  const pick = matched.length === 1 ? matched[0] : (!matched.length && verdicts.length === 1 && usable.length === 1 ? usable[0] : null);
  if (pick && !pick.clash) {
    link(core, claimant, pick.rep, { rel: 'same', confidence: P.scores.anchorConfirmed, evidence, decidedBy: 'anchor-confirmed', at: ev.at });
    bump(core, 'entities.anchorConfirmed');
  }
  for (const v of usable.filter((u) => u !== pick || u.clash).slice(0, P.maxMaybeLinks)) {
    link(core, claimant, v.rep, { rel: 'maybe_same', confidence: v.match ? P.scores.selfClaimCap : P.scores.relationAmbiguous, evidence, decidedBy: 'extractor', at: ev.at });
  }
}

/**
 * 只报了名字的自我介绍（「我是小刚」「我 B站 就是 xxx」）或旁人的指认（「他就是小刚」）：
 * 和叫这个名字的档案（不算别人的自称）挂 maybe_same。自称的名字正是对方的账号名 / 名片，而对方也自称过是 sid 的
 * 账号名 / 名片（两边都有账号）——双向自认 → same（mutual-claim，权利层，§5.2）。
 */
function claimByName(core, sid, name, bySelf, ev, P, evidence) {
  const rows = core.store.all(`SELECT DISTINCT n.entity_id AS id FROM entity_names n JOIN entities e ON e.id = n.entity_id
      WHERE n.text_norm = ? AND n.spoof = 0 AND n.name_kind <> 'self-intro' AND e.status <> 'retracted'`, name).map((r) => r.id);
  const sidAccounts = namespacesOf(core, sid).size > 0;
  const sidOwn = identityNames(core, sid);
  const ids = rows.filter((id) => linkable(core, sid, id, { allowAccountClash: true }));
  const cluster = clustersOf(core, ids);
  const reps = [...new Set(ids.map((id) => cluster.get(id)))];
  let maybes = 0;
  for (const rep of reps) {
    const members = ids.filter((id) => cluster.get(id) === rep);
    const target = members.find((id) => identityNames(core, id).has(name));
    const mutual = bySelf && sidAccounts && target != null && namespacesOf(core, target).size > 0
      && [...claimedNames(core, target)].some((n) => sidOwn.has(n));
    if (mutual) {
      link(core, sid, target, { rel: 'same', confidence: P.scores.mutualClaim, evidence, decidedBy: 'mutual-claim', at: ev.at });
      bump(core, 'entities.mutualClaim');
      continue;
    }
    // 单方面的说法：同命名空间同作用域的另一个账号默认是另一个人，不挂
    if (members.every((id) => accountsClash(core, sid, id)) || maybes >= P.maxMaybeLinks) continue;
    const s = reps.length === 1 ? P.scores.name : P.scores.nameOtherScope;
    const other = target ?? rep;
    link(core, sid, other, { rel: 'maybe_same', confidence: bySelf ? s : Math.min(s, P.scores.nameOtherScope), evidence, decidedBy: 'extractor', at: ev.at });
    if (bySelf) queueIdentityClaim(core, sid, other);
    maybes += 1;
  }
}

/**
 * 自称是另一个平台上的某个账号（「我 B站 就是 xxx」）：那边的账号自己也认之前只是 maybe_same，但主人可以直接批准（§5.2）——
 * 两边都有账号、而且在不同的命名空间时，排一条「可能是同一个」的审核（payload 只有两个实体 id；不会过期，§17 Q9）。
 */
function queueIdentityClaim(core, a, b) {
  const na = namespacesOf(core, a);
  const nb = namespacesOf(core, b);
  if (!na.size || !nb.size || new Set([...na, ...nb]).size < 2) return;
  try {
    core.mods.admin.enqueueReview(core, { kind: 'merge', payload: { a: Math.min(a, b), b: Math.max(a, b) }, reason: 'cross-namespace-self-claim' });
  } catch (err) {
    bump(core, 'entities.review.error');
    warn(core, 'entities.review.error', { error: errName(err) });
  }
}

/** noteMention 的实现（index.js 也用它）。 */
export function noteMentionInternal(core, entityId, m) {
  const e = getEntity(core, entityId);
  if (!e) { bump(core, 'entities.mention.unknown'); return; }
  const at = Number.isFinite(m?.at) ? m.at : core.now();
  core.store.run(`UPDATE entities SET last_mention_at = MAX(COALESCE(last_mention_at, ?), ?),
      first_mention_at = MIN(COALESCE(first_mention_at, ?), ?), updated_at = ? WHERE id = ?`, at, at, at, at, core.now(), entityId);
  markDay(core, getEntity(core, entityId), at);
  // 档案也会被「刷新」：每被提到一次加一条痕迹（§6.4，规则全在 dynamics 里执行）
  try {
    core.mods.dynamics.addTrace(core, { kind: 'entity', id: entityId },
      { t: at, w: Number.isFinite(m?.w) && m.w > 0 ? m.w : 1, sourceKey: typeof m?.sourceKey === 'string' && m.sourceKey ? m.sourceKey : 'unknown', reason: 'mention' });
  } catch (err) {
    bump(core, 'entities.trace.error');
    warn(core, 'entities.trace.error', { ref: refOf('entity', entityId), error: errName(err) });
  }
}

// ── candidates（第 4 步） ────────────────────────────────────────────────

/**
 * 见 index.js 的 candidates()。
 * @returns {Promise<{entityId: number, score: number, why: string}[]>}
 */
export async function candidates(core, q, opt = {}) {
  const P = entityParams(core);
  if (!q || typeof q !== 'object') return [];
  /** @type {Map<number, {sig: Map<string, number>, conflict: boolean}>} */
  const acc = new Map();
  const add = (id, sig, s) => {
    let a = acc.get(id);
    if (!a) { a = { sig: new Map(), conflict: false }; acc.set(id, a); }
    a.sig.set(sig, Math.max(a.sig.get(sig) ?? -Infinity, s));
  };
  const anchor = Number.isInteger(q.anchorEntityId) && q.anchorEntityId > 0 ? q.anchorEntityId : null;
  const relRaw = typeof q.relation === 'string' ? cleanRaw(q.relation, 32) : '';
  const rel = anchor && relRaw ? normalizeName(relRaw) : '';
  const name = typeof q.name === 'string' && q.name.trim() ? normalizeName(cleanRaw(q.name)) : '';
  const anchors = anchor ? sameGroup(core, anchor) : new Set();
  const related = anchor ? relatedTo(core, anchor) : new Set();
  const live = (id) => { const e = getEntity(core, id); return e && e.status !== 'retracted' && !anchors.has(id) ? e : null; };
  // 关系路径
  if (anchor && rel) {
    const ph = [...anchors].map(() => '?').join(',');
    for (const r of core.store.all(`SELECT DISTINCT entity_id AS id FROM entity_descriptors WHERE relation = ? AND anchor_entity_id IN (${ph})`, rel, ...anchors)) {
      if (live(r.id)) add(r.id, 'relation', P.scores.candidateRelation);
    }
  }
  // 名字表
  if (name) {
    for (const r of core.store.all('SELECT DISTINCT entity_id AS id, scope_setting_key AS scope FROM entity_names WHERE text_norm = ? AND spoof = 0', name)) {
      const e = live(r.id);
      if (!e) continue;
      add(r.id, 'name', P.scores.candidateName + (q.settingKey && r.scope === q.settingKey ? P.scores.nameSameScope : 0));
    }
  }
  // 向量（嵌入不可用时跳过，只用名字表和关系路径）
  const text = [typeof q.name === 'string' ? q.name : '', typeof q.context === 'string' ? q.context : ''].join(' ').trim().slice(0, 400);
  if (text && !opt.signal?.aborted) {
    try {
      const qv = await core.mods.worker.embedQuery(core, [text], { deadlineMs: P.candidateDeadlineMs, signal: opt.signal });
      if (qv && Array.isArray(qv.vectors) && qv.vectors.length) {
        const res = await core.mods.worker.denseSearch(core, {
          vectors: qv.vectors, spaceId: qv.spaceId, layers: ['memory'],
          topK: { memory: P.vectorCandidates.max * 4, raw: 0 }, includeCold: true,
        }, { deadlineMs: P.candidateDeadlineMs, signal: opt.signal });
        let n = 0;
        for (const h of res?.hits ?? []) {
          if (!(h.score >= P.vectorCandidates.minCos)) continue;
          const ref = parseRef(h.ref);
          let id = null;
          if (ref?.kind === 'entity') id = ref.id;
          else if (ref?.kind === 'impression') id = core.store.get('SELECT entity_id FROM entity_impressions WHERE id = ?', ref.id)?.entity_id ?? null;
          if (!id || !live(id)) continue;
          add(id, 'vector', h.score);
          if (++n >= P.vectorCandidates.max) break;
        }
      } else bump(core, 'entities.candidates.noEmbedding');
    } catch (err) {
      bump(core, 'entities.candidates.vectorError');
      warn(core, 'entities.candidates.vectorError', { error: errName(err) });
    }
  }
  // 锚点冲突是负分：阿明的表哥和 B 的表哥默认不是同一个人
  if (anchor && rel) {
    for (const [id, a] of acc) {
      if (a.sig.has('relation')) continue;
      const other = core.store.all('SELECT DISTINCT anchor_entity_id AS x FROM entity_descriptors WHERE entity_id = ? AND relation = ?', id, rel).map((r) => r.x);
      if (other.some((x) => !related.has(x))) a.conflict = true;
    }
  }
  const outList = [];
  for (const [id, a] of acc) {
    // 带关系描述、而主人 / 她自己不在这条关系路径上：不管哪一路找到的都不给（和主人同名的第三方不会被认成主人）
    if (rel && !a.sig.has('relation') && isReservedOwner(getEntity(core, id))) continue;
    const vals = [...a.sig.values()];
    let score = Math.min(1, Math.max(...vals) + P.scores.candidateMultiBonus * (vals.length - 1));
    const why = [...a.sig.keys()];
    if (a.conflict) { score += P.scores.anchorConflict; why.push('anchor-conflict'); }
    outList.push({ entityId: id, score: round(score), why: why.join('+') });
  }
  outList.sort((p, q2) => q2.score - p.score || p.entityId - q2.entityId);
  return outList.slice(0, P.vectorCandidates.max);
}
