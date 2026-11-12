// entities 模块（§5.2、§5.8、§8.1 名字匹配）：开放世界的实体档案。
//   - 账号只是「这是谁」的一种证据；没有账号的人（「阿明的表哥」）凭关系描述立档。
//   - 认人五步：身份证据 → 关系路径 → 带作用域的别名 → 名字 + 上下文的向量候选 → LLM 批量裁决（和提炼合在同一次调用里）。
//   - 拿不准时不合并：建临时档案 + maybe_same。中文名不按字符串模糊匹配。
//   - 认得 ≠ 权利：权利层只认 decided_by ∈ {platform, mutual-claim, anchor-confirmed, owner}。
// 拥有的表：entities、entity_names、entity_descriptors、identity_evidence、entity_links、entity_impressions。
// 用到的端口：clock、embedding（经 worker）。
// 契约细节：docs/实现/模块与接口.md §4.3。
// 内部文件：records.js（表的底层读写）、own.js（她自己、主人）、resolve.js（认人）、links.js（链接两层）、
//   matcher.js（Aho-Corasick）、impressions.js（分层印象）、normalize.js（名字规范化）、params.js（参数）、
//   repair.js（把认人的规矩用到已经存下来的档案上：假人、重复档案）。
import {
  state, getEntity, createEntity, addName, identityKeys, findEvidence, attachEvidence, moveEvidence,
  flushEmbeds, namesChanged, bump, warn, errName, RIGHTS_DECIDERS, markDirty,
} from './records.js';
import { ensureSelf as ensureSelfImpl, ensurePrincipal as ensurePrincipalImpl, reclaimOwnAccount } from './own.js';
import {
  resolveActor as resolveActorImpl, resolveExtracted as resolveExtractedImpl, candidates as candidatesImpl,
  noteMentionInternal, corroboration, descriptorRowsFor,
} from './resolve.js';
import { repairMentionGhosts as repairGhostsImpl } from './repair.js';
import { link as linkImpl, belief as beliefImpl, rightsHolder as rightsHolderImpl, linksOf } from './links.js';
import { compilePatterns, findAll, dropContained } from './matcher.js';
import { writeImpression as writeImpressionImpl, impressionSources as impressionSourcesImpl } from './impressions.js';
import { normalizeName as normalizeNameImpl, charLength } from './normalize.js';
import { entityParams } from './params.js';
import { refOf } from '../store/index.js';

export { SELF_ANCHOR } from './resolve.js';
export { ENTITY_DEFAULTS } from './params.js';

/**
 * 名字匹配器（Aho-Corasick，零 LLM、亚毫秒级，§5.2、§8.1）。
 * @typedef {object} NameMatcher
 * @property {number} version
 * @property {(text: string, opt?: {settingKey?: string, anchors?: number[], at?: number}) => {entityId: number, name: string, start: number, end: number, score: number, via?: 'name'|'relation', anchor?: number}[]} scan
 *           同名的几个档案都返回（score 按作用域和激活加权），由融合打分区分。
 *           【补】anchors：可选的锚点（通常是这句话的说话人）——正文里的关系词（数据里学到的「表哥」）挂在紧挨着的名字
 *           （「阿明的表哥」，也可以接着上一个关系词：「阿明的表哥的女儿」）下面的档案也返回；前面没有挨着的名字时才挂在
 *           anchors 下面（「我表哥」）。via='relation'，§1.2 第 4 步的关系路径线索。
 *           start / end 是原文里的下标（end 不含）。
 */
/**
 * 提炼输出里的一个 ent 行（encode 解析后交过来）。
 * @typedef {object} ExtractedEntity
 * @property {string} local              本批里的编号（'E1'）
 * @property {string|null} name
 * @property {string} kind
 * @property {{anchor: string|number, relation: string}|null} descriptor   anchor 是本批的说话人编号（'U3'）、'我' 或另一个 local；
 *                                        【补】也可以是候选档案的编号（'c2'，要在 ctx.candidateCodes 里）或已经换好的实体 id
 * @property {string[]} msgRefs
 * @property {{match: number|null, fullName?: string, confidence: number}} [verdict]   LLM 的裁决（第 5 步）
 * @property {string} [speaker]          【补】这一行说的就是本批的某个说话人（值是 'U5'）。分量看是谁说的（msgRefs 的说话人）：
 *                                        他自己（「我是阿明的表哥」「我 B站 就是 xxx」）→ 自称，只挂 maybe_same，对方也自称过是他 → mutual-claim；
 *                                        锚点本人当面说（阿明说「对，他就是我表哥」）→ anchor-confirmed；别人说的 → maybe_same
 * @property {boolean} [individual]      【补】是不是具体的个人（不给就按 kind 推，见 normalize.js）
 */
/**
 * @typedef {object} EntityProfile
 * @property {number} id
 * @property {string} kind
 * @property {string} status
 * @property {string|null} displayName
 * @property {boolean} isSelf
 * @property {{closeness: number, authority: 'none'|'principal'|'delegated'}} bond
 * @property {{text: string, usedBy: number, scopeSettingKey: string, count: number, last: number}[]} names
 * @property {{anchor: number, relation: string, text: string, basis?: string}[]} descriptors
 * @property {{namespace: string, scope: string, strength: string}[]} identities     不含哈希值以外的东西
 * @property {{other: number, rel: string, confidence: number, decidedBy: string, rights: boolean}[]} links
 * @property {{layer: 'shared'|'private', id: number, text: string, version: number}[]} impressions
 */

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.entities = {
    matcher: null,          // {version, cfgKey, api}
    namesVersion: 0,        // 名字表（含关系词）每次提交了变化就 + 1
    dirtyEmbeds: new Set(), // 这次操作里档案文本可能变了的实体
    dictTimer: null,
    dictionarySynced: false, // 这个进程里用户词典交给语言分析器过没有（启动时、第一次建匹配器时补一次）
    principalLabelSynced: null,
    onNamesChanged: () => scheduleDictionary(core),
  };
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) {
  const st = core.state.entities;
  if (st?.dictTimer) { clearImmediate(st.dictTimer); st.dictTimer = null; }
  if (st) st.matcher = null;
}

/**
 * 她自己的实体（is_self=1，kind='self'）；没有就建。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {number}
 */
export function ensureSelf(core) { return ensureSelfImpl(core); }

/**
 * 主人的实体（authority='principal'，closeness=1）；没有就建。各适配器从配置给出的主人账号都挂到这一个实体上（§5.2）。
 * 她对主人的称呼（selfProfile.principalLabel）登记成主人的保留名。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {number}
 */
export function ensurePrincipal(core) {
  const id = ensurePrincipalImpl(core);
  syncDictionaryOnce(core);   // 启动步骤（api 的 runStartup）里调：重启后名字表没变，语言分析器也要拿到一次用户词典
  return id;
}

const VERIFIED = new Set(['platform', 'config', 'owner']);

/**
 * 适配器注册时：selfClaims 的账号挂到她自己，principalClaims 的账号挂到主人（strength='config'）。
 * 保留名（她的名字、主人的称呼）标 reserved。可重复调用（幂等）。
 * 配置里的账号之前已经按普通说话人建过档案的（适配器晚注册、主人后来才配上）：证据改挂到她自己 / 主人，旧档案链接成同一个人
 * （主人的是主人亲手写的配置 → decided_by='owner'；她自己的 → 'platform'）。
 * 【D162】她自己的账号：只从没有管理权限的档案上拿（有的算冲突）；拿走以后那个档案什么都没有了（没说过话、没别的证据和关系描述）就不挂 same，
 * 最后跑一遍修复把它撤掉（「@她的平台名」被当成普通群友立出来的档案就是这样）；计数 entities.identity.selfReclaimed。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {{selfClaims: import('../contract/types.js').IdentityClaim[], principalClaims: import('../contract/types.js').IdentityClaim[]}} claims
 */
export function registerAdapterClaims(core, adapterId, claims) {
  if (typeof adapterId !== 'string' || !adapterId) throw new TypeError('entities.registerAdapterClaims：需要 adapterId');
  core.store.tx(() => {
    const selfId = ensureSelfImpl(core);
    const principalId = ensurePrincipalImpl(core);
    const reclaimed = applyOwnClaims(core, adapterId, selfId, claims?.selfClaims, null, principalId, 'platform', { self: true });
    applyOwnClaims(core, adapterId, principalId, claims?.principalClaims, 'config', selfId, 'owner');
    // 【D162】她的账号从别的档案那里拿回来了：名字都记完以后跑一遍修复（那个档案没了证据、名字又都是她的就撤掉）
    if (reclaimed > 0) repairMentionGhosts(core);
    flushEmbeds(core);
  });
}

function applyOwnClaims(core, adapterId, ownerId, list, strengthOverride, otherOwnId, linkDecider, { self = false } = {}) {
  const at = core.now();
  let reclaimed = 0;
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    if (c.kind === 'account' && typeof c.namespace === 'string' && typeof c.id === 'string') {
      const k = identityKeys(core, c);
      const strength = strengthOverride ?? (VERIFIED.has(c.verifiedBy) ? c.verifiedBy : 'platform');
      const ex = findEvidence(core, k);
      if (!ex || ex.entity_id === ownerId) attachEvidence(core, ownerId, k, strength, { adapter: adapterId, via: 'claims' });
      else if (ex.entity_id === otherOwnId) {
        bump(core, 'entities.identity.conflict');                       // 同一个账号既配成她又配成主人：不动，报警
        warn(core, 'entities.identity.conflict', { entity: ownerId, other: otherOwnId });
      } else if (self) {
        // 【D162】她的账号在别的档案上：和 resolve.js 的 attachOwnAccounts 同一条规矩（own.js 的 reclaimOwnAccount）——
        // 有管理权限的不动、算冲突；拿回来以后那个档案还有自己的东西就和她挂 same，什么都没有了的交给修复（registerAdapterClaims 最后跑）
        const r = reclaimOwnAccount(core, ownerId, ex, strength);
        if (r.moved) reclaimed += 1;
        else {
          bump(core, 'entities.identity.conflict');
          warn(core, 'entities.identity.conflict', { entity: ownerId });
        }
      } else {
        moveEvidence(core, ex.id, ownerId, strength);
        linkImpl(core, ownerId, ex.entity_id, { rel: 'same', confidence: 1, evidence: ['adapter-claims'], decidedBy: linkDecider, at });
        markDirty(core, ownerId);
        bump(core, 'entities.identity.claimedFromProvisional');
      }
      if (typeof c.displayName === 'string' && c.displayName.trim()) addName(core, ownerId, { raw: c.displayName, kind: 'config', reserved: true, at });
    } else if (c.kind === 'display-name' && typeof c.name === 'string' && c.name.trim()) {
      const scope = c.scope ? core.keys.settingKey(adapterId, c.scope) : '';
      addName(core, ownerId, { raw: c.name, kind: 'config', scope, reserved: true, at: Number.isFinite(c.observedAt) ? c.observedAt : at });
    }
  }
  return reclaimed;
}

/**
 * 确定性地认说话人（§7.1 第 5 步）：self → 她自己；principal claim → 主人；账号证据精确匹配（第 1 步）；
 * 场合内的显示名（作用域 = 本场合，第 3 步的确定部分）。新账号建一个 provisional 实体并记身份证据。
 * 同时记名字证据（count、last）。拿不准的不认（entityId=null），留给提炼时的实体解析。在调用方的事务里调用。
 * 只靠显示名永远认不到她自己或有管理权限的人身上（保留名不能被名片冒用）。说话人在新的一天出现也算一天（established 的依据），
 * 但不加痕迹（编码强度要 intake 算完才知道；要给档案加痕迹就调 noteMention）。
 * 只靠名字永远不新建一个和她自己的名字（任何场合记下的）同名的「人」（D108）。ctx.role = 'mention'（话里点到的人，intake 认提及时传）：
 * 只有名字的提及对上她自己的名字 → 她（via 'mention-self'）；对上这里（或不限场合）有管理权限的人的名字 → 他（'mention-authority'）；
 * 都不记名字（提及不给任何权利）；名字都不到 2 个字的不认、不新建。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../contract/types.js').ActorRef} actor   原始 ActorRef（账号 id 在这里算哈希，不往外传原值）
 * @param {{adapterId: string, settingKey: string, at: number, role?: 'actor'|'mention'}} ctx
 * @returns {import('../core-types.js').ResolvedActor}
 */
export function resolveActor(core, actor, ctx) { return resolveActorImpl(core, actor, ctx); }

/**
 * 稳定场合对应的 kind=setting 实体（§5.8）；没有就建。transient 场合不建（调用方保证）。
 * 【D111】名字证据只记真名：labelKind='name' 的 label（她怎么称呼这里）记成 kind 'label'，主人起的名字记成 kind 'owner'；
 * labelKind='description'（适配器不知道名字，只是一句说法）不记名字、不进匹配器。显示名就是生效的称呼（主人起的 > 适配器给的）：
 * 场合的显示名只由这里写，所以直接换，不走「来源不降档」（主人清掉自己起的名字时要能退回去）。
 * 【D111 评审】平台上的名字（labelOrigin='platform'：群名、机器人的备注，是场合里的人起的）记成 kind 'account'——和账号昵称一样
 * 是平台上显示的名字、会被保留名冒用检查（群改名成她或主人的保留名：记下来但标 spoof，不进匹配器）；配置里写的照旧是 'label'。
 * resetLabels：这个场合在有 labelKind / labelOrigin 之前记的 label 名字（当时不知道是不是真名）全部清掉，按现在的重记；
 * dropOwner：主人清掉 / 换掉的旧名字不再当名字认。适配器给过的旧真名照旧留着当别名（群改过名，别人还会用旧名字说起它）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {{label: string, at: number, labelKind?: 'name'|'description', labelOrigin?: 'config'|'platform'|null, ownerLabel?: string|null, resetLabels?: boolean,
 *          dropOwner?: string|null}} info
 * @returns {number}
 */
export function ensureSettingEntity(core, settingKey, info) {
  if (typeof settingKey !== 'string' || !settingKey) throw new TypeError('entities.ensureSettingEntity：需要场合键');
  const at = Number.isFinite(info?.at) ? info.at : core.now();
  const label = typeof info?.label === 'string' ? info.label.trim() : '';
  const isName = info?.labelKind !== 'description';
  const owner = typeof info?.ownerLabel === 'string' ? info.ownerLabel.trim() : '';
  return core.store.tx(() => {
    const ex = core.store.get('SELECT id, display_name, display_source FROM entities WHERE setting_key = ?', settingKey);
    const id = ex?.id ?? createEntity(core, { kind: 'setting', status: 'established', individual: false, settingKey, at });
    let removed = 0;
    if (info?.resetLabels) removed += core.store.run("DELETE FROM entity_names WHERE entity_id = ? AND name_kind = 'label'", id).changes;
    const drop = typeof info?.dropOwner === 'string' ? normalizeNameImpl(info.dropOwner) : '';
    if (drop && drop !== normalizeNameImpl(owner)) {
      removed += core.store.run("DELETE FROM entity_names WHERE entity_id = ? AND name_kind = 'owner' AND text_norm = ?", id, drop).changes;
    }
    if (removed > 0) { namesChanged(core); markDirty(core, id); }
    if (label && isName) addName(core, id, { raw: label, kind: info?.labelOrigin === 'platform' ? 'account' : 'label', at });
    if (owner) addName(core, id, { raw: owner, kind: 'owner', at });
    const display = owner || label;
    const source = owner ? 'owner' : 'label';
    if (display && (ex?.display_name !== display || ex?.display_source !== source)) {
      core.store.run('UPDATE entities SET display_name = ?, display_source = ?, updated_at = ? WHERE id = ?', display, source, core.now(), id);
      markDirty(core, id);
    }
    flushEmbeds(core);
    return id;
  });
}

/**
 * 某个实体又被提到了：更新 last_mention_at / mention_days（可能升 established），并在档案上加一条痕迹（dynamics.addTrace，§6.4）。
 * 在调用方的事务里调用。痕迹的规则（来源窗口、证据时间）全在 dynamics 里；w 照传，听说不打折（§6.2）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {{at: number, w: number, sourceKey: string}} m
 */
export function noteMention(core, entityId, m) {
  core.store.tx(() => noteMentionInternal(core, entityId, m));
}

/**
 * 当前的名字匹配器（名字表变了就重建，按版本缓存）。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {NameMatcher}
 */
export function nameMatcher(core) {
  const st = state(core);
  const P = entityParams(core);
  const cfgKey = JSON.stringify(P.matcher);
  const c = st.matcher;
  if (c && c.version === st.namesVersion && c.cfgKey === cfgKey) return c.api;
  const names = core.store.all(`SELECT n.entity_id, n.text_norm, n.name_kind, n.scope_setting_key, n.count, n.used_by
      FROM entity_names n JOIN entities e ON e.id = n.entity_id WHERE e.status <> 'retracted' AND n.spoof = 0`);
  const relations = core.store.all(`SELECT DISTINCT d.relation FROM entity_descriptors d JOIN entities e ON e.id = d.entity_id
      WHERE e.status <> 'retracted'`).map((r) => r.relation);
  const built = compilePatterns({ names, relations, minChars: P.matcher.minChars });
  const version = st.namesVersion;
  syncDictionaryOnce(core);   // 只读模式不跑启动步骤：第一次建匹配器时也交一次用户词典
  /** @type {NameMatcher} */
  const api = Object.freeze({ version, scan: (text, opt) => scanText(core, built, text, opt ?? {}) });
  // 事务进行中建的可能含有还没提交的名字：不缓存（回滚了就会过时）
  if (!core.store.inTransaction) st.matcher = { version, cfgKey, api };
  return api;
}

function scopeWeight(n, settingKey, S) {
  switch (n.name_kind) {
    case 'card': return n.scope_setting_key === '' ? S.cardGlobal : n.scope_setting_key === settingKey ? S.cardHere : S.cardElsewhere;
    case 'account': return S.account;
    case 'mention': case 'self-intro': return settingKey && n.scope_setting_key === settingKey ? S.mentionHere : S.mention;
    default: return S.fixed;
  }
}

function scanText(core, built, text, opt) {
  if (typeof text !== 'string' || !text || !built.keys.length) return [];
  const P = entityParams(core);
  const M = P.matcher;
  const at = Number.isFinite(opt.at) ? opt.at : core.now();
  const settingKey = typeof opt.settingKey === 'string' ? opt.settingKey : '';
  const all = findAll(built.ac, built.keys, text);
  const nameHits = dropContained(all.filter((h) => built.info[h.key].names.length));
  const relHits = all.filter((h) => built.info[h.key].relation
    && !nameHits.some((n) => n.start <= h.start && n.end >= h.end && n.end - n.start > h.end - h.start));
  const liveCache = new Map();
  const live = (id) => {
    if (!liveCache.has(id)) liveCache.set(id, core.store.get("SELECT 1 AS x FROM entities WHERE id = ? AND status <> 'retracted'", id) != null);
    return liveCache.get(id);
  };
  // 先按名字证据和关系算原始分（raw），最后一次批量读激活再乘上（同一个档案的几处命中激活相同，取大的那条不受影响）
  /** @type {Map<string, any>} */
  const out = new Map();
  const push = (r) => {
    const k = `${r.entityId}:${r.start}:${r.end}`;
    const prev = out.get(k);
    if (!prev || r.raw > prev.raw) out.set(k, r);
  };
  const named = [];
  for (const h of nameHits) {
    const best = new Map();
    for (const n of built.info[h.key].names) {
      const s = scopeWeight(n, settingKey, M.scope) * Math.min(1, M.countBase + M.countSlope * Math.log1p(n.count));
      if (s > (best.get(n.entity_id) ?? 0)) best.set(n.entity_id, s);
    }
    for (const [id, s] of best) {
      if (!live(id)) continue;
      push({ entityId: id, name: text.slice(h.origStart, h.origEnd), start: h.origStart, end: h.origEnd, raw: s, via: 'name' });
      named.push({ id, nEnd: h.end, w: M.relationNamed });
    }
  }
  const given = (Array.isArray(opt.anchors) ? opt.anchors : []).filter((a) => Number.isInteger(a) && a > 0);
  for (const h of [...relHits].sort((a, b) => a.start - b.start || b.end - a.end)) {
    /** @type {Map<number, number>} */
    const anchors = new Map();
    // 紧挨着的名字（「阿明的表哥」）或刚落到档案上的上一个关系词（「阿明的表哥的女儿」）就是锚点；
    // 前面没有挨着的，才用调用方给的锚点（说话人：「我表哥」）
    for (const n of named) if (n.nEnd <= h.start && h.start - n.nEnd <= M.relationGap) anchors.set(n.id, Math.max(anchors.get(n.id) ?? 0, n.w));
    if (!anchors.size) for (const a of given) anchors.set(a, Math.max(anchors.get(a) ?? 0, M.relationAnchor));
    if (!anchors.size) continue;
    const ids = [...anchors.keys()];
    const rows = core.store.all(`SELECT DISTINCT entity_id, anchor_entity_id, basis FROM entity_descriptors
        WHERE relation = ? AND anchor_entity_id IN (${ids.map(() => '?').join(',')})`, built.keys[h.key], ...ids);
    for (const r of rows) {
      if (anchors.has(r.entity_id) || !live(r.entity_id)) continue;
      const base = anchors.get(r.anchor_entity_id) * (r.basis === 'self-claim' ? M.selfClaimFactor : 1);
      push({ entityId: r.entity_id, name: text.slice(h.origStart, h.origEnd), start: h.origStart, end: h.origEnd,
        raw: base, via: 'relation', anchor: r.anchor_entity_id });
      named.push({ id: r.entity_id, nEnd: h.end, w: base });
    }
  }
  if (!out.size) return [];
  const W = activationWeights(core, [...new Set([...out.values()].map((r) => r.entityId))], at, M);
  const hits = [...out.values()].map(({ raw, ...r }) => ({ ...r, score: Math.round(raw * W.get(r.entityId) * 1000) / 1000 }));
  return hits.sort((a, b) => a.start - b.start || b.score - a.score || a.entityId - b.entityId);
}

/**
 * 命中档案的激活权重：activationBase + (1 − activationBase) × σ(B)（被提得多、最近被提到的同名档案排前）。
 * 一次扫描只批量读一次（dynamics.baseActivations）；批量读不了退回逐个读，再不行按中间值（激活读不到不影响认名字）。
 * @returns {Map<number, number>}
 */
function activationWeights(core, ids, at, M) {
  const mid = M.activationBase + (1 - M.activationBase) * 0.5;
  const weight = (B) => (Number.isFinite(B) ? M.activationBase + (1 - M.activationBase) / (1 + Math.exp(-B)) : M.activationBase);
  const out = new Map();
  let batch = null;
  try { batch = core.mods.dynamics.baseActivations(core, ids.map((id) => ({ kind: 'entity', id })), at); } catch { batch = null; }
  for (const id of ids) {
    if (batch instanceof Map) { out.set(id, weight(batch.get(refOf('entity', id)) ?? -Infinity)); continue; }
    try { out.set(id, weight(core.mods.dynamics.baseActivation(core, { kind: 'entity', id }, at))); } catch { out.set(id, mid); }
  }
  return out;
}

/**
 * 第 4 步：名字连同上下文的向量候选（余弦 ≥ 0.6，最多 15 个），给提炼提示词里「候选档案」一栏用。
 * 锚点冲突是负分（阿明的表哥和 B 的表哥默认不是同一个人）。嵌入不可用时只用名字表和关系路径。不抛错（嵌入失败只降级）。
 * 带关系描述而主人 / 她自己没有这层关系时，主人 / 她自己不出现在候选里（和主人同名的第三方不会被认成主人）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{name: string|null, context: string, anchorEntityId?: number|null, relation?: string|null, settingKey?: string}} q
 *        settingKey【补】：提及所在的场合（名字证据来自同一个场合的略加分）
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{entityId: number, score: number, why: string}[]>}
 */
export async function candidates(core, q, opt) {
  try { return await candidatesImpl(core, q, opt ?? {}); } catch (err) {
    bump(core, 'entities.candidates.error');
    warn(core, 'entities.candidates.error', { error: errName(err) });
    return [];
  }
}

/**
 * 把一批 ent 行落成实体（第 2、3、5 步）：按关系路径找锚点下的同关系档案；综合得分 ≥ θ_hi 挂到已有档案，
 * ≤ θ_lo 新建，中间新建临时档案并挂 maybe_same（decided_by='extractor'）。写名字、关系描述、提到痕迹。
 * 在 encode 的批次事务里调用（同步）。一行出错只丢这一行（它自己的 SAVEPOINT 回滚）。
 * 锚点冲突、「只靠保留名」这些代码定下的约束，LLM 的裁决推翻不了。
 * @param {import('../core-types.js').CoreContext} core
 * @param {ExtractedEntity[]} ents
 * @param {{speakers: Map<string, number|null>, settingKey: string, at: number, jobId: number, msgRefs?: Map<string, number>,
 *          candidateCodes?: Map<string, number>, actorCodes?: Map<number, string>, w?: number}} ctx
 *        speakers：本批说话人编号 → 实体 id（入库时没认出来的是 null，同一批里有以这个编号为 local 的行时用它的结果）。
 *        【补】msgRefs：本批消息编号 → 感知 id（buildExtractPrompt 返回的那个），有了它才知道是谁提到的、什么时候、
 *        编码强度多少（「我表哥」是锚点本人说的）；candidateCodes：提示词里候选档案的编号 → 实体 id（锚点可以是候选档案，
 *        §7.4 第 12 条「已知」）；actorCodes：感知 id → 本批说话人编号（证据消息的说话人入库时没认出来时，按本批里给他立的档
 *        认是谁说的）；w：没有 msgRefs 时痕迹的权重
 * @returns {Map<string, number>}   local → 实体 id
 */
export function resolveExtracted(core, ents, ctx) { return resolveExtractedImpl(core, ents, ctx); }

/**
 * 建 / 改一条链接（a、b 顺序无关，内部按 a < b 存）。跨命名空间的链接同时写一条 B3 规范（discretion.writeNorm，identityLink=true）。
 * 两边都有账号证据（跨平台的对应、同平台的小号）都算身份对应，都写 B3 规范；权利层确认的，当事人记进「谁知道」。
 * 低一级的决定（extractor < sleep < anchor-confirmed / mutual-claim < platform < owner）不推翻高一级的，只并证据；
 * maybe_same 永远不会被 extractor / sleep 变成 not_same。
 * 【补】自动的权利层决定（platform / mutual-claim / anchor-confirmed）把两组人并成一个人时，跨这两组、还在等主人批的
 * merge 审核经 admin.withdrawReviews 撤掉（问题已经有答案了）；主人自己的决定由 admin.decideReview 结案。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} a
 * @param {number} b
 * @param {{rel: 'maybe_same'|'same'|'not_same', confidence: number, evidence: string[],
 *          decidedBy: 'extractor'|'sleep'|'mutual-claim'|'anchor-confirmed'|'platform'|'owner', at: number}} link
 * @returns {number} 链接 id
 */
export function link(core, a, b, link) { return linkImpl(core, a, b, link); }

/**
 * 改关系（亲密度、权限）。authority 只能由配置（主人）或管理页改，调用方负责权限。
 * 她自己、不是具体个人的实体（群体、场合……）不能有管理权限。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {{closeness?: number, authority?: 'none'|'principal'|'delegated'}} bond
 */
export function setBond(core, entityId, bond) {
  if (!bond || typeof bond !== 'object') throw new TypeError('entities.setBond：需要 bond');
  core.store.tx(() => {
    const e = getEntity(core, entityId);
    if (!e) throw new TypeError('entities.setBond：实体不存在');
    let closeness = e.closeness;
    let authority = e.authority;
    if (bond.closeness !== undefined) {
      if (typeof bond.closeness !== 'number' || !Number.isFinite(bond.closeness)) throw new TypeError('entities.setBond：closeness 应为 0–1');
      closeness = Math.max(0, Math.min(1, bond.closeness));
    }
    if (bond.authority !== undefined) {
      if (!['none', 'principal', 'delegated'].includes(bond.authority)) throw new TypeError('entities.setBond：authority 不认识');
      if (bond.authority !== 'none' && (e.is_self || !e.individual)) throw new TypeError('entities.setBond：她自己 / 非个人实体不能有管理权限');
      authority = bond.authority;
    }
    core.store.run('UPDATE entities SET closeness = ?, authority = ?, updated_at = ? WHERE id = ?', closeness, authority, core.now(), entityId);
    if (authority !== e.authority) bump(core, 'entities.authority.changed');
  });
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {'provisional'|'established'|'retracted'} status
 */
export function setStatus(core, entityId, status) {
  if (!['provisional', 'established', 'retracted'].includes(status)) throw new TypeError('entities.setStatus：status 不认识');
  core.store.tx(() => {
    const e = getEntity(core, entityId);
    if (!e) throw new TypeError('entities.setStatus：实体不存在');
    if (e.status === status) return;
    core.store.run('UPDATE entities SET status = ?, updated_at = ? WHERE id = ?', status, core.now(), entityId);
    if (e.status === 'retracted' || status === 'retracted') namesChanged(core);   // 撤掉的档案不进名字匹配器
    if (status !== 'retracted') { markDirty(core, entityId); flushEmbeds(core); }
  });
}

/**
 * 写一层新的印象（consolidate 夜里从事实重新生成，不在旧摘要上改写，§7.7 第 5 步）。旧版本 is_current=0。
 * 同时写规范（discretion.writeNorm：shared 层继承它的证据里最严的规范，private 层同理）和嵌入文本（worker.enqueueEmbed）。
 * 实现：规范用 discretion.inheritNorm（契约 §4.3 表）；内容和证据都没变时不新建版本；旧版本的嵌入在提交后删掉。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {'shared'|'private'} layer
 * @param {{text: string, evidenceRefs: string[], firstHand: number, hearsay: number, at: number, derivation?: 'quote'|'inference'}} imp
 *        derivation【补】：默认 'quote'（印象是证据的汇总，「谁知道」取交集）；纯推断的写 'inference'（只有她自己知道）
 * @returns {number} 印象 id
 */
export function writeImpression(core, entityId, layer, imp) { return writeImpressionImpl(core, entityId, layer, imp); }

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @returns {EntityProfile|null}
 */
export function profile(core, entityId) {
  const e = getEntity(core, entityId);
  if (!e) return null;
  const names = core.store.all(`SELECT text_raw, used_by, scope_setting_key, count, last FROM entity_names
      WHERE entity_id = ? AND spoof = 0 ORDER BY count DESC, last DESC LIMIT 50`, entityId)
    .map((r) => ({ text: r.text_raw, usedBy: r.used_by, scopeSettingKey: r.scope_setting_key, count: r.count, last: r.last }));
  const BASIS_RANK = { owner: 4, 'first-person': 3, 'third-party': 2, 'self-claim': 1 };
  const descMap = new Map();
  for (const r of core.store.all(`SELECT anchor_entity_id, relation, text, basis, last_at FROM entity_descriptors WHERE entity_id = ?
      ORDER BY last_at DESC`, entityId)) {
    const k = `${r.anchor_entity_id}:${r.relation}`;
    const prev = descMap.get(k);
    if (!prev) descMap.set(k, { anchor: r.anchor_entity_id, relation: r.relation, text: r.text, basis: r.basis });
    else if ((BASIS_RANK[r.basis] ?? 0) > (BASIS_RANK[prev.basis] ?? 0)) prev.basis = r.basis;
  }
  const identities = core.store.all('SELECT namespace, scope, strength FROM identity_evidence WHERE entity_id = ? ORDER BY id', entityId)
    .map((r) => ({ namespace: r.namespace, scope: r.scope, strength: r.strength }));
  const links = linksOf(core, entityId).map((r) => ({
    other: r.a === entityId ? r.b : r.a, rel: r.rel, confidence: r.confidence, decidedBy: r.decided_by,
    rights: r.rel === 'same' && RIGHTS_DECIDERS.has(r.decided_by),
  }));
  const impressions = core.store.all(`SELECT id, layer, text, version FROM entity_impressions WHERE entity_id = ? AND is_current = 1
      ORDER BY layer`, entityId).map((r) => ({ layer: r.layer, id: r.id, text: r.text, version: r.version }));
  return {
    id: e.id,
    kind: e.kind,
    status: e.status,
    displayName: e.display_name ?? null,
    isSelf: e.is_self === 1,
    bond: { closeness: e.closeness, authority: e.authority },
    names,
    descriptors: [...descMap.values()],
    identities,
    links,
    impressions,
  };
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @returns {{closeness: number, authority: 'none'|'principal'|'delegated', isSelf: boolean}}
 */
export function bondOf(core, entityId) {
  const r = Number.isInteger(entityId) && entityId > 0
    ? core.store.get('SELECT closeness, authority, is_self FROM entities WHERE id = ?', entityId) : null;
  if (!r) return { closeness: 0, authority: 'none', isSelf: false };
  return { closeness: r.closeness, authority: r.authority, isSelf: r.is_self === 1 };
}

/**
 * 是不是「具体的个人」（§5.6 involves_others、§9.3.2 B2 由它判断；群体、话题、作品、场合都不是）。
 * 她自己返回 false（这两处都只关心「她以外的具体的人」）；不认识的种类、查不到的 id 按「是」算（宁严）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @returns {boolean}
 */
export function isIndividual(core, entityId) {
  if (!Number.isInteger(entityId) || entityId <= 0) return false;
  const r = core.store.get('SELECT individual, is_self, authority FROM entities WHERE id = ?', entityId);
  if (!r) return true;
  if (r.is_self) return false;
  if (r.authority !== 'none') return true;
  return r.individual === 1;
}

/**
 * 权利层：claimant 能不能以 subject 本人的身份行使权利（放宽关于他的规范、要求忘掉、算「本人在场」）。
 * 同一个实体，或者有 rel='same' 且 decided_by ∈ {platform, mutual-claim, anchor-confirmed, owner} 的链接（沿这种链接可传递）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} claimantId
 * @param {number} subjectId
 * @returns {boolean}
 */
export function rightsHolder(core, claimantId, subjectId) { return rightsHolderImpl(core, claimantId, subjectId); }

/**
 * 信念层：心里认不认得 a 和 b 是同一个人（回想和人物卡按置信度合并用）。
 * 直接的链接优先；没有就沿 same / maybe_same 找置信度乘积最大的路径（经过 maybe_same 的结果是 maybe_same）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} a
 * @param {number} b
 * @returns {{rel: 'same'|'maybe_same'|'not_same', confidence: number}|null}
 */
export function belief(core, a, b) { return beliefImpl(core, a, b); }

/**
 * 有管理权限的实体（authority='principal'，以后也可能有 delegated）。按亲密度从高到低。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {number[]}
 */
export function principals(core) {
  return core.store.all(`SELECT id FROM entities WHERE authority = 'principal' AND is_self = 0 ORDER BY closeness DESC, id ASC`).map((r) => r.id);
}

/**
 * jieba 用户词典（实体别名，§8.2）。最常用的在前；撤掉的档案、冒用别人保留名的名片不在里面。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {string[]}
 */
export function userDictionary(core) {
  const D = entityParams(core).dictionary;
  const rows = core.store.all(`SELECT MAX(n.text_raw) AS t, SUM(n.count) AS c FROM entity_names n JOIN entities e ON e.id = n.entity_id
      WHERE e.status <> 'retracted' AND n.spoof = 0 GROUP BY n.text_norm ORDER BY c DESC LIMIT ?`, D.maxWords * 2);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const t = typeof r.t === 'string' ? r.t.trim() : '';
    const n = charLength(t);
    if (n < D.minChars || n > D.maxChars || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= D.maxWords) break;
  }
  return out;
}

// ── 【补】额外的导出 ──────────────────────────────────────────────────────

/**
 * 名字（也用于关系词）的规范化：逐码点 NFKC + 小写，只留字母、数字和组合符；中文名不会变成空串。纯函数。
 * @param {string} text
 * @returns {string}
 */
export function normalizeName(text) { return normalizeNameImpl(text); }

/**
 * 重新生成印象时该用哪些事实（consolidate.regenerateImpressions 用，§5.2「八卦的来源分开」）：只看主体是他的事实；
 * shared = 他本人当众说的、大家当场看到的；private = 一对一得到的、听说的、她自己推断的。他说别人的话不算他的。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {{limit?: number}} [opt]
 * @returns {{shared: {ref: string, firstHand: boolean, hearsay: boolean, inferred: boolean}[],
 *            private: {ref: string, firstHand: boolean, hearsay: boolean, inferred: boolean}[],
 *            counts: {shared: {firstHand: number, hearsay: number}, private: {firstHand: number, hearsay: number, inferred: number}}}}
 */
export function impressionSources(core, entityId, opt) { return impressionSourcesImpl(core, entityId, opt); }

/**
 * 「多条独立描述吻合」（§5.2）：某个档案在（锚点，关系）下的描述来自几个不同的 established 说话人、跨几天。
 * 夜间整理裁决 maybe_same 时用（要求 ≥ entities.independentDescriptors 的人数和天数，防几个小号凑出来）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {number} anchorEntityId
 * @param {string} relation
 * @returns {{speakers: number, days: number, qualifies: boolean}}
 */
export function descriptorSupport(core, entityId, anchorEntityId, relation) {
  return corroboration(core, descriptorRowsFor(core, entityId, anchorEntityId, relation), [], new Set([entityId]));
}

/**
 * 把认人的规矩用到已经存下来的档案上（D108、D160；启动时和她有了新名字时跑，幂等、有上限）。只看从没说过话、没有身份证据和关系描述的档案：
 * 每个名字都不到 2 个字的、每个名字都是她自己或有管理权限的人的名字的，撤掉；只有名字的提及造出来的，没有任何东西指着就撤掉，
 * 有东西指着而名字正好是同一场合里一个有账号的人的平台名，就不撤、和他挂 same（信念层）；提炼造出来的重复档案（名字全是别人叫的，
 * 正好是同一场合里一个有账号的人的平台名）也和他挂 same，不撤。不按 id 写死任何一个。撤掉的计 entities.ghost.retracted、
 * 挂上的计 entities.ghost.linked；撤了的话名字匹配器随之重建。见 repair.js。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {{retracted: number, linked: number}}
 */
export function repairMentionGhosts(core) {
  const r = repairGhostsImpl(core);
  if (r.retracted) invalidateNames(core);
  return r;
}

/**
 * 名字表被本模块以外的路径改过（admin.purge 的级联、backup.restorePartial）之后调用：让名字匹配器重建、刷新用户词典。
 * @param {import('../core-types.js').CoreContext} core
 */
export function invalidateNames(core) {
  const st = state(core);
  st.namesVersion += 1;
  st.matcher = null;
  scheduleDictionary(core);
}

/**
 * 把当前的用户词典交给语言分析器（lang.registry().setUserDictionary；没有 jieba 时 zh 用它出整词，D51）。名字表变了会自动排一次，
 * 启动（ensurePrincipal）和第一次建名字匹配器时也各补一次（重启后名字表没变，分析器里的词典是空的）。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 */
export function refreshUserDictionary(core) {
  try {
    if (!core.store || core.store.closed) return;
    const reg = core.mods.lang.registry(core);
    if (reg && typeof reg.setUserDictionary === 'function') {
      reg.setUserDictionary(userDictionary(core));
      if (core.state.entities) core.state.entities.dictionarySynced = true;
    }
  } catch (err) {
    bump(core, 'entities.dictionary.error');
    warn(core, 'entities.dictionary.error', { error: errName(err) });
  }
}

function scheduleDictionary(core) {
  const st = core.state.entities;
  if (!st || st.dictTimer) return;
  st.dictTimer = setImmediate(() => { st.dictTimer = null; refreshUserDictionary(core); });
}

/** 这个进程里还没把用户词典交给语言分析器过：排一次（名字表之后再变由 namesChanged 排）。 */
function syncDictionaryOnce(core) {
  const st = core.state.entities;
  if (st && !st.dictionarySynced) scheduleDictionary(core);
}

