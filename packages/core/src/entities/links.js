// 可逆链接（§5.2「链接分两层」）：
//   - 信念层（认得）：same / maybe_same / not_same 都算，回想和人物卡按置信度合并；
//   - 权利层：只认 rel='same' 且 decided_by ∈ {platform, mutual-claim, anchor-confirmed, owner}。自我介绍、提炼、夜间整理
//     都只能产生信念，永远产生不了权利。
//   - maybe_same 永远不会被自动的决定（extractor / sleep）变成 not_same；低一级的决定不推翻高一级的，只并证据。
//   - 两边都有账号证据的链接（跨命名空间的对应、小号）本身是一条身份对应类的隐私记忆：写一条 B3 规范（identityLink），
//     「谁知道」只记权利层确认过的当事人（主人看管理页、和主人一对一的例外由 discretion 的 B3 处理）。
import { refOf } from '../store/index.js';
import {
  getEntity, namespacesOf, bump, warn, errName, establish, RIGHTS_DECIDERS, DECIDER_RANK, AUTO_DECIDERS,
} from './records.js';
import { entityParams } from './params.js';

const RELS = new Set(['maybe_same', 'same', 'not_same']);

export function linkRow(core, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return core.store.get('SELECT * FROM entity_links WHERE a = ? AND b = ?', x, y) ?? null;
}

/** 一个实体的全部链接（两个方向）。 */
export function linksOf(core, id) {
  return core.store.all('SELECT * FROM entity_links WHERE a = ? UNION ALL SELECT * FROM entity_links WHERE b = ?', id, id);
}

function parseEvidence(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

/**
 * 建 / 改一条链接。见 index.js 的 link()。
 * @returns {number}
 */
export function link(core, a, b, l) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) throw new TypeError('entities.link：a、b 应为实体 id');
  if (a === b) throw new TypeError('entities.link：不能和自己建链接');
  if (!l || !RELS.has(l.rel)) throw new TypeError('entities.link：rel 应为 maybe_same / same / not_same');
  if (!(l.decidedBy in DECIDER_RANK)) throw new TypeError('entities.link：decidedBy 不认识');
  const P = entityParams(core);
  const at = Number.isFinite(l.at) ? l.at : core.now();
  const confidence = Math.max(0, Math.min(1, Number.isFinite(l.confidence) ? l.confidence : 0));
  const evidence = (Array.isArray(l.evidence) ? l.evidence : []).filter((x) => typeof x === 'string' && x.length <= 128);
  const [x, y] = a < b ? [a, b] : [b, a];
  return core.store.tx(() => {
    if (!getEntity(core, x) || !getEntity(core, y)) throw new TypeError('entities.link：实体不存在');
    const nsX = namespacesOf(core, x);
    const nsY = namespacesOf(core, y);
    const cross = nsX.size > 0 && nsY.size > 0 && new Set([...nsX, ...nsY]).size > 1 ? 1 : 0;
    const ex = core.store.get('SELECT * FROM entity_links WHERE a = ? AND b = ?', x, y);
    // 自动的权利层决定可能把两组人并成一个人：先记下并之前的两组（之后撤掉跨两组的、还在等主人批的 merge）
    const groupsBefore = l.rel === 'same' && RIGHTS_DECIDERS.has(l.decidedBy) && l.decidedBy !== 'owner'
      && !(ex && ex.rel === 'same' && RIGHTS_DECIDERS.has(ex.decided_by))
      ? [sameGroup(core, x, { rights: true }), sameGroup(core, y, { rights: true })] : null;
    let id;
    let rel = l.rel;
    let decided = l.decidedBy;
    let conf = confidence;
    let wasRights = false;
    if (!ex) {
      const r = core.store.run(`INSERT INTO entity_links(a, b, rel, confidence, evidence_json, decided_by, cross_namespace, at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, x, y, rel, conf, JSON.stringify([...new Set(evidence)].slice(-P.linkEvidenceMax)), decided, cross, at, core.now());
      id = Number(r.lastInsertRowid);
      bump(core, `entities.link.${rel}`);
    } else {
      id = ex.id;
      wasRights = ex.rel === 'same' && RIGHTS_DECIDERS.has(ex.decided_by);
      const merged = [...new Set([...parseEvidence(ex.evidence_json), ...evidence])].slice(-P.linkEvidenceMax);
      rel = ex.rel; decided = ex.decided_by; conf = ex.confidence;
      if (DECIDER_RANK[l.decidedBy] >= DECIDER_RANK[ex.decided_by]) {
        if (l.rel === 'not_same' && ex.rel === 'maybe_same' && AUTO_DECIDERS.has(l.decidedBy)) {
          bump(core, 'entities.link.autoNotSameKept');   // 只并证据，保持 maybe_same（§5.2、§12.7）
        } else {
          rel = l.rel; decided = l.decidedBy; conf = confidence;
        }
      } else {
        bump(core, 'entities.link.lowerRankKept');        // 低一级的决定不推翻高一级的
      }
      core.store.run(`UPDATE entity_links SET rel = ?, confidence = ?, evidence_json = ?, decided_by = ?, cross_namespace = ?, at = ?
        WHERE id = ?`, rel, conf, JSON.stringify(merged), decided, cross, at, id);
    }
    // 主人确认是同一个人：两个档案都算 established（§5.2「或主人确认」）
    if (rel === 'same' && decided === 'owner') { establish(core, x); establish(core, y); }
    // 身份对应（两边都有账号证据）：链接本身带 B3 规范
    const identity = rel !== 'not_same' && nsX.size > 0 && nsY.size > 0;
    if (identity) {
      const ref = { kind: /** @type {'link'} */ ('link'), id };
      const hasNorm = core.store.get("SELECT 1 AS x FROM flow_norms WHERE owner_kind = 'link' AND owner_id = ? LIMIT 1", id);
      if (!hasNorm) {
        core.mods.discretion.writeNorm(core, ref, {
          identityLink: true,
          involvesOthers: true,
          restriction: 'none',
          attribute: 'identity-link',
          sensitivity: P.identityLinkSensitivity,
          originExposure: { exposureRank: 0, persistenceRank: 0, visibleTo: 'her-only' },
          reason: 'identity-link',
        });
      }
      const isRights = rel === 'same' && RIGHTS_DECIDERS.has(decided);
      if (isRights && !wasRights) {
        // 当事人自己知道自己的账号对应；只在权利层确认过时这样记（§5.6 第 3 条）
        core.mods.discretion.recordKnowledge(core, ref, [x, y].map((e) => ({ whoKind: 'entity', whoRef: String(e), since: at, basis: 'subject' })));
      }
    }
    // 自动的权利层决定（双向自认、锚点当面确认、平台）把这一对定成了同一个人：还在等主人批的「可能是同一个」不用再问了
    // （§5.2「审核队列只放低把握的」）——不只这一对，并之前两组之间的每一对都有了答案（权利层可传递）。
    // 主人自己的决定由 admin.decideReview 结案，这里不碰
    if (groupsBefore && rel === 'same' && RIGHTS_DECIDERS.has(decided) && decided !== 'owner' && !wasRights) {
      withdrawMergeReviews(core, groupsBefore[0], groupsBefore[1], decided, at);
    }
    return id;
  });
}

/**
 * 撤掉跨两组（并之前的 gx、gy）还在等着的 merge 审核（review_queue 是 admin 的表，经 admin.withdrawReviews 撤，
 * 标 withdrawn、不执行决定）。两组都是 sameGroup 找出来的（有上限），通常各只有一两个档案。
 * 拿不到这个函数（单测里的替身）时什么都不做：admin 的过期处理也会把已经有答案的 merge 撤掉。在 link 的事务里调用，失败只计数。
 */
function withdrawMergeReviews(core, gx, gy, decidedBy, at) {
  let fn;
  try { fn = core.mods.admin?.withdrawReviews; } catch { fn = null; }
  if (typeof fn !== 'function') return;
  const done = new Set();
  for (const p of gx) {
    for (const q of gy) {
      if (p === q) continue;
      const k = p < q ? `${p}:${q}` : `${q}:${p}`;
      if (done.has(k)) continue;
      done.add(k);
      try {
        fn(core, { kind: 'merge', match: { a: Math.min(p, q), b: Math.max(p, q) } }, { reason: `decided-by-${decidedBy}`, at });
      } catch (err) {
        bump(core, 'entities.review.withdrawError');
        warn(core, 'entities.review.withdrawError', { error: errName(err) });
        return;
      }
    }
  }
}

/**
 * 沿链接找和 id 认成同一个人的实体（含 id 自己）。
 * @param {{rights?: boolean, includeMaybe?: boolean, depth?: number}} opt
 *        rights=true：只走权利层的 same；否则走 same（includeMaybe 时也走 maybe_same）
 * @returns {Set<number>}
 */
export function sameGroup(core, id, opt = {}) {
  const depth = opt.depth ?? entityParams(core).sameSearchDepth;
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const nextF = [];
    for (const n of frontier) {
      for (const r of linksOf(core, n)) {
        const ok = opt.rights ? (r.rel === 'same' && RIGHTS_DECIDERS.has(r.decided_by))
          : (r.rel === 'same' || (opt.includeMaybe && r.rel === 'maybe_same'));
        if (!ok) continue;
        const o = r.a === n ? r.b : r.a;
        if (!seen.has(o)) { seen.add(o); nextF.push(o); }
      }
      if (seen.size > 64) return seen;
    }
    frontier = nextF;
  }
  return seen;
}

/** 权利层：见 index.js 的 rightsHolder()。 */
export function rightsHolder(core, claimant, subject) {
  if (!Number.isInteger(claimant) || !Number.isInteger(subject) || claimant <= 0 || subject <= 0) return false;
  if (claimant === subject) return true;
  return sameGroup(core, claimant, { rights: true }).has(subject);
}

/**
 * 信念层：见 index.js 的 belief()。直接的链接优先；否则沿 same / maybe_same 找置信度乘积最大的路径。
 * 一条路径上最多一段 maybe_same：「可能是」的「可能是」太弱，不当成信念（也不会绕过两个档案之间的锚点冲突）。
 */
export function belief(core, a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) return null;
  if (a === b) return getEntity(core, a) ? { rel: 'same', confidence: 1 } : null;
  const direct = linkRow(core, a, b);
  if (direct) return { rel: direct.rel, confidence: direct.confidence };
  const depth = entityParams(core).sameSearchDepth;
  /** @type {Map<string, {conf: number, maybe: boolean}>} 键 = 实体 id + 走过 maybe_same 没有 */
  const best = new Map([[`${a}:0`, { conf: 1, maybe: false }]]);
  let frontier = [[a, false]];
  for (let d = 0; d < depth && frontier.length; d++) {
    const nextF = [];
    for (const [n, m] of frontier) {
      const cur = best.get(`${n}:${m ? 1 : 0}`);
      for (const r of linksOf(core, n)) {
        if (r.rel === 'not_same') continue;
        if (m && r.rel === 'maybe_same') continue;
        const o = r.a === n ? r.b : r.a;
        const conf = cur.conf * (r.rel === 'same' ? Math.max(r.confidence, 0.5) : r.confidence);
        const maybe = m || r.rel === 'maybe_same';
        const key = `${o}:${maybe ? 1 : 0}`;
        const prev = best.get(key);
        if (!prev || conf > prev.conf) { best.set(key, { conf, maybe }); nextF.push([o, maybe]); }
      }
    }
    frontier = nextF;
    if (best.size > 128) break;
  }
  const hits = [best.get(`${b}:0`), best.get(`${b}:1`)].filter(Boolean);
  if (!hits.length) return null;
  const hit = hits.find((h) => !h.maybe) ?? hits[0];
  return { rel: hit.maybe ? 'maybe_same' : 'same', confidence: Math.round(hit.conf * 1000) / 1000 };
}

export const linkRef = (id) => refOf('link', id);
