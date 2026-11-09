// 实体扩散路（§8.2，HippoRAG 2 风格，评审:FE-14）：「实体—事实—情节」图上的局部推送式个性化 PageRank。
//   - 图不预先建好：从种子出发，碰到哪个节点才去库里取它的邻居（每次查询一个缓存），只在种子的几跳邻域里算；
//   - 局部推送（Andersen–Chung–Lang）：残差 r 超过 eps 的节点把 α·r 留下，其余 (1−α)·r 按边权分给邻居；
//     残差太小的节点不再展开，所以「大家都提到过的人」（她自己、主人……）的大量邻居自然被稀释，不需要特判；
//   - 超过 maxHops 的节点只收不发；扇出很大的节点只取最近的 fanCap 条边，但按真实的边数归一化（被稀释，不被放大）。
// 节点是记忆引用（'n12'、'a5'、'e3'、'i2'、't7'、's1'、'c4'），边和边权都是通用的结构关系，不看内容、不看入口。
import { parseRef } from '../store/refs.js';
import { wallNow } from './vindex.js';
import { DEFAULTS } from '../config/defaults.js';

/** 边的默认权重：就是 config/defaults.js 的 recall.ppr.weights（线程里直接调 pprLocal 时用）。 */
export const DEFAULT_EDGE_WEIGHTS = DEFAULTS.recall.ppr.weights;
const ROLES = ['subject', 'object', 'mention', 'speaker', 'asserter'];

/**
 * 按需取邻居的图读取器。参与者和社区成员存在 JSON 列里没有索引，所以在内存里建倒排（按 id 增量补，定时整体重建）。
 */
export class GraphReader {
  /**
   * @param {{get: Function, all: Function}} db 主库的只读连接
   * @param {{rebuildMs?: number}} [opt]
   */
  constructor(db, { rebuildMs = 10 * 60_000 } = {}) {
    this.db = db;
    this.rebuildMs = rebuildMs;
    this.participants = new Map();   // entityId → episodeId[]（升序）
    this.epMax = 0;
    this.epCount = 0;
    this.communities = new Map();    // entityId → communityId[]
    this.comSig = '';
    this.builtAt = 0;
  }

  /** 倒排补到最新（新情节按 id 增量；行数变少或到了重建时间就整体重建）。 */
  refresh() {
    const now = wallNow();
    const ep = this.db.get('SELECT max(id) AS m, count(*) AS n FROM episodes');
    const m = Number(ep?.m ?? 0);
    const n = Number(ep?.n ?? 0);
    if (now - this.builtAt > this.rebuildMs || n < this.epCount || m < this.epMax) {
      this.participants = new Map();
      this.epMax = 0;
      this.epCount = 0;
      this.builtAt = now;
      this.comSig = '';
    }
    if (m > this.epMax) {
      let from = this.epMax;
      for (;;) {
        const rows = this.db.all('SELECT id, participants_json FROM episodes WHERE id > ? ORDER BY id LIMIT 5000', from);
        if (!rows.length) break;
        for (const r of rows) {
          for (const e of parseIds(r.participants_json)) {
            let a = this.participants.get(e);
            if (!a) { a = []; this.participants.set(e, a); }
            a.push(r.id);
          }
        }
        from = rows.at(-1).id;
      }
      this.epMax = m;
    }
    this.epCount = n;
    const cs = this.db.get('SELECT count(*) AS n, max(id) AS m, max(built_at) AS b FROM communities WHERE is_current = 1');
    const sig = `${cs?.n ?? 0}:${cs?.m ?? 0}:${cs?.b ?? 0}`;
    if (sig !== this.comSig) {
      this.communities = new Map();
      for (const r of this.db.all('SELECT id, members_json FROM communities WHERE is_current = 1')) {
        for (const e of parseIds(r.members_json)) {
          let a = this.communities.get(e);
          if (!a) { a = []; this.communities.set(e, a); }
          a.push(r.id);
        }
      }
      this.comSig = sig;
    }
  }

  /**
   * 一个节点的邻居。total 是按真实边数估的总边权（扇出截断时比 nbrs 的和大）。
   * @param {string} ref
   * @param {{fanCap: number, weights: Record<string, number>}} p
   * @returns {{nbrs: Map<string, number>, total: number}}
   */
  neighbors(ref, p) {
    const m = parseRef(ref);
    const out = new Map();
    let extra = 0;
    const W = p.weights;
    const cap = p.fanCap;
    const add = (r, w) => { if (r && w > 0 && r !== ref) out.set(r, (out.get(r) ?? 0) + w); };
    if (!m) return { nbrs: out, total: 0 };
    const db = this.db;
    switch (m.kind) {
      case 'entity': {
        const row = db.get('SELECT status, setting_key FROM entities WHERE id = ?', m.id);
        if (!row || row.status === 'retracted') break;
        for (const role of ROLES) {
          const rows = db.all('SELECT assertion_id AS a FROM assertion_entities WHERE entity_id = ? AND role = ? ORDER BY assertion_id DESC LIMIT ?', m.id, role, cap + 1);
          const w = W[role] ?? 0;
          for (const r of rows.slice(0, cap)) add(`a${r.a}`, w);
          if (rows.length > cap) {
            const n = Number(db.get('SELECT count(*) AS n FROM assertion_entities WHERE entity_id = ? AND role = ?', m.id, role)?.n ?? 0);
            extra += Math.max(0, n - cap) * w;
          }
        }
        const eps = this.participants.get(m.id);
        if (eps?.length) {
          for (const e of eps.slice(-cap)) add(`e${e}`, W.participant);
          extra += Math.max(0, eps.length - cap) * W.participant;
        }
        for (const r of db.all('SELECT anchor_entity_id AS x FROM entity_descriptors WHERE entity_id = ? LIMIT ?', m.id, cap)) add(`n${r.x}`, W.descriptor);
        const anchored = db.all('SELECT entity_id AS x FROM entity_descriptors WHERE anchor_entity_id = ? ORDER BY id DESC LIMIT ?', m.id, cap + 1);
        for (const r of anchored.slice(0, cap)) add(`n${r.x}`, W.descriptor);
        if (anchored.length > cap) extra += W.descriptor * cap;   // 只是估计：锚点下的档案特别多时按再多一倍算
        for (const r of db.all(`SELECT b AS x, rel, confidence FROM entity_links WHERE a = ? AND rel <> 'not_same'
                                UNION ALL SELECT a AS x, rel, confidence FROM entity_links WHERE b = ? AND rel <> 'not_same'`, m.id, m.id)) {
          add(`n${r.x}`, (r.rel === 'same' ? W.same : W.maybeSame) * clamp01(r.confidence));
        }
        for (const r of db.all('SELECT id FROM entity_impressions WHERE entity_id = ? AND is_current = 1', m.id)) add(`i${r.id}`, W.impression);
        for (const r of db.all('SELECT id FROM intentions WHERE target_entity_id = ? ORDER BY id DESC LIMIT ?', m.id, cap)) add(`t${r.id}`, W.intention);
        if (row.setting_key) for (const r of db.all('SELECT id FROM storylines WHERE setting_key = ?', row.setting_key)) add(`s${r.id}`, W.storyline);
        for (const c of this.communities.get(m.id) ?? []) add(`c${c}`, W.community);
        break;
      }
      case 'assertion': {
        const row = db.get('SELECT supersedes, superseded_by, plan_outcome_ref FROM assertions WHERE id = ?', m.id);
        if (!row) break;
        for (const r of db.all('SELECT entity_id AS x, role FROM assertion_entities WHERE assertion_id = ?', m.id)) add(`n${r.x}`, W[r.role] ?? 0);
        for (const r of db.all(`SELECT DISTINCT p.episode_id AS e FROM sources s JOIN percepts p ON p.id = s.percept_id
                                WHERE s.owner_kind = 'assertion' AND s.owner_id = ? AND p.episode_id IS NOT NULL LIMIT ?`, m.id, cap)) add(`e${r.e}`, W.derived);
        if (row.supersedes) add(`a${row.supersedes}`, W.supersede);
        if (row.superseded_by) add(`a${row.superseded_by}`, W.supersede);
        for (const r of db.all('SELECT b AS x FROM same_type WHERE a = ? UNION SELECT a AS x FROM same_type WHERE b = ?', m.id, m.id)) add(`a${r.x}`, W.sameType);
        for (const r of db.all("SELECT id FROM intentions WHERE about_kind = 'assertion' AND about_id = ?", m.id)) add(`t${r.id}`, W.intention);
        const o = row.plan_outcome_ref ? parseRef(row.plan_outcome_ref) : null;
        if (o) add(row.plan_outcome_ref, W.outcome);
        break;
      }
      case 'episode': {
        const row = db.get('SELECT participants_json FROM episodes WHERE id = ?', m.id);
        if (!row) break;
        for (const e of parseIds(row.participants_json)) add(`n${e}`, W.participant);
        for (const r of db.all(`SELECT DISTINCT s.owner_id AS a FROM percepts p JOIN sources s ON s.percept_id = p.id AND s.owner_kind = 'assertion'
                                WHERE p.episode_id = ? LIMIT ?`, m.id, cap)) add(`a${r.a}`, W.derived);
        for (const r of db.all("SELECT id FROM intentions WHERE about_kind = 'episode' AND about_id = ?", m.id)) add(`t${r.id}`, W.intention);
        break;
      }
      case 'impression': {
        const row = db.get('SELECT entity_id FROM entity_impressions WHERE id = ?', m.id);
        if (row) add(`n${row.entity_id}`, W.impression);
        break;
      }
      case 'intention': {
        const row = db.get('SELECT about_kind, about_id, target_entity_id FROM intentions WHERE id = ?', m.id);
        if (!row) break;
        if (row.target_entity_id) add(`n${row.target_entity_id}`, W.intention);
        const prefix = row.about_kind === 'assertion' ? 'a' : row.about_kind === 'episode' ? 'e' : null;
        if (prefix && row.about_id) add(`${prefix}${row.about_id}`, W.intention);
        break;
      }
      case 'storyline': {
        const row = db.get('SELECT setting_key FROM storylines WHERE id = ?', m.id);
        if (row) for (const r of db.all('SELECT id FROM entities WHERE setting_key = ?', row.setting_key)) add(`n${r.id}`, W.storyline);
        break;
      }
      case 'community': {
        const row = db.get('SELECT members_json FROM communities WHERE id = ?', m.id);
        if (row) for (const e of parseIds(row.members_json)) add(`n${e}`, W.community);
        break;
      }
      default: break;   // 原文窗口、感知、链接不在图里
    }
    let total = extra;
    for (const w of out.values()) total += w;
    return { nbrs: out, total };
  }
}

/**
 * 局部推送 PPR。
 * @param {GraphReader} reader
 * @param {{seeds: {entityId: number, weight: number}[], maxHops: number, limit: number, deadlineAt: number,
 *          alpha: number, eps: number, maxPushes: number, maxExpand: number, fanCap: number, weights: Record<string, number>,
 *          includeSeeds?: boolean}} q
 * @returns {{hits: {ref: string, score: number}[], timedOut: boolean, pushes: number, expanded: number}}
 */
export function localPush(reader, q) {
  const seeds = (q.seeds ?? []).filter((s) => Number.isInteger(s?.entityId) && s.entityId > 0 && Number(s.weight) > 0);
  if (!seeds.length) return { hits: [], timedOut: false, pushes: 0, expanded: 0 };
  reader.refresh();
  const alpha = clampRange(q.alpha, 0.05, 0.95, 0.5);
  const eps = q.eps > 0 ? q.eps : 1e-4;
  const maxHops = Math.max(1, Math.floor(q.maxHops ?? DEFAULTS.recall.entity.maxHops));
  const sum = seeds.reduce((s, x) => s + Number(x.weight), 0);
  const r = new Map();
  const p = new Map();
  const hop = new Map();
  const adj = new Map();
  const queue = [];
  const queued = new Set();
  const seedRefs = new Set();
  for (const s of seeds) {
    const ref = `n${s.entityId}`;
    seedRefs.add(ref);
    r.set(ref, (r.get(ref) ?? 0) + Number(s.weight) / sum);
    hop.set(ref, 0);
    if (!queued.has(ref)) { queued.add(ref); queue.push(ref); }
  }
  let head = 0;
  let pushes = 0;
  let timedOut = false;
  const params = { fanCap: Math.max(1, q.fanCap | 0 || DEFAULTS.recall.ppr.fanCap), weights: { ...DEFAULT_EDGE_WEIGHTS, ...(q.weights ?? {}) } };
  while (head < queue.length) {
    if (pushes >= (q.maxPushes ?? DEFAULTS.recall.ppr.maxPushes)) break;
    if ((pushes & 31) === 0 && wallNow() > q.deadlineAt) { timedOut = true; break; }
    const u = queue[head++];
    queued.delete(u);
    const ru = r.get(u) ?? 0;
    if (!(ru > eps)) continue;
    r.set(u, 0);
    p.set(u, (p.get(u) ?? 0) + alpha * ru);
    pushes++;
    const h = hop.get(u) ?? 0;
    if (h >= maxHops) continue;            // 邻域边界：只收不发
    let a = adj.get(u);
    if (!a) {
      if (adj.size >= (q.maxExpand ?? DEFAULTS.recall.ppr.maxExpand)) continue;
      a = reader.neighbors(u, params);
      adj.set(u, a);
    }
    if (!(a.total > 0)) continue;
    const spread = ((1 - alpha) * ru) / a.total;
    for (const [v, w] of a.nbrs) {
      const nv = (r.get(v) ?? 0) + spread * w;
      r.set(v, nv);
      const hv = hop.get(v);
      if (hv === undefined || hv > h + 1) hop.set(v, h + 1);
      if (nv > eps && !queued.has(v)) { queued.add(v); queue.push(v); }
    }
    if (head > 4096 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
  }
  const hits = [];
  for (const [ref, score] of p) {
    if (!q.includeSeeds && seedRefs.has(ref)) continue;
    if (score > 0) hits.push({ ref, score });
  }
  hits.sort((x, y) => y.score - x.score || (x.ref < y.ref ? -1 : 1));
  return { hits: hits.slice(0, Math.max(0, q.limit ?? hits.length)), timedOut, pushes, expanded: adj.size };
}

function parseIds(json) {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  } catch { return []; }
}
const clamp01 = (x) => (Number.isFinite(Number(x)) ? Math.min(1, Math.max(0, Number(x))) : 0);
const clampRange = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d);
