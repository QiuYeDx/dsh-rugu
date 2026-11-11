// 回放评测（D152）的判定：用例的 need 每一组命中没有、avoid 出现了几条。
// 命中自动算上等价的（都在拨回之后的副本上查，所以只算那一刻已经存在的）：
//   p…  那句原话本身、含它的原文窗口（percepts.window_id，或同一场合 first_percept ≤ id ≤ last_percept 的窗口）、
//       它所在的情节（percepts.episode_id）、由它提炼出的情节和事实（sources.percept_id）
//   w…  这个窗口本身、它里面的原话（同一场合、id 在窗口范围里的感知）
//   e… / a… / 别的  只认它自己
// 组可以带 min（至少命中几条，默认 1）：数的是组里写的那几条里有几条（连同各自等价的）进了块。
const KIND = { p: 'percepts', w: 'raw_windows', e: 'episodes', a: 'assertions', n: 'entities', i: 'entity_impressions', t: 'intentions' };

/**
 * 一条引用在那一刻存不存在。
 * @param {import('node:sqlite').DatabaseSync} db   拨回之后的副本
 */
export function exists(db, ref) {
  const m = /^([a-z])(\d+)$/.exec(String(ref));
  if (!m || !KIND[m[1]]) return false;
  return !!db.prepare(`SELECT 1 AS x FROM ${KIND[m[1]]} WHERE id = ?`).get(Number(m[2]));
}

/**
 * 一条引用 → 和它等价的引用（含它自己）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ref
 * @returns {Set<string>}
 */
export function expand(db, ref) {
  const out = new Set([ref]);
  const m = /^([a-z])(\d+)$/.exec(String(ref));
  if (!m) return out;
  const id = Number(m[2]);
  if (m[1] === 'p') {
    const p = db.prepare('SELECT id, setting_key, episode_id, window_id FROM percepts WHERE id = ?').get(id);
    if (!p) return out;
    if (p.window_id != null) out.add(`w${p.window_id}`);
    if (p.episode_id != null) out.add(`e${p.episode_id}`);
    for (const r of db.prepare('SELECT id FROM raw_windows WHERE setting_key = ? AND first_percept <= ? AND last_percept >= ?').all(p.setting_key, id, id)) out.add(`w${r.id}`);
    for (const r of db.prepare("SELECT DISTINCT owner_kind, owner_id FROM sources WHERE percept_id = ? AND owner_kind IN ('episode', 'assertion')").all(id)) {
      out.add(`${r.owner_kind === 'episode' ? 'e' : 'a'}${r.owner_id}`);
    }
  } else if (m[1] === 'w') {
    const w = db.prepare('SELECT setting_key, first_percept, last_percept FROM raw_windows WHERE id = ?').get(id);
    if (w) for (const r of db.prepare('SELECT id FROM percepts WHERE setting_key = ? AND id BETWEEN ? AND ?').all(w.setting_key, w.first_percept, w.last_percept)) out.add(`p${r.id}`);
  }
  // 只留那一刻存在的
  for (const r of [...out]) if (r !== ref && !exists(db, r)) out.delete(r);
  return out;
}

/**
 * 判一例。block：渲染进块的条目（按块里的顺序）；core：核心给出的全部条目（渲染之前）。
 * missingRefs：need 里那一刻还不在库里的（用例写错了，这一例不算全中）；avoid 里那一刻还不在的只记在 avoid.missing。
 * @returns {{groups: object[], avoid: {refs: string[], hits: string[], missing: string[]}, ok: boolean, missingRefs: string[]}}
 */
export function judge(db, c, block, core) {
  const blockIds = block.map((it) => it.id);
  const coreIds = core.map((it) => it.id);
  const missingRefs = [];
  const groups = (c.need ?? []).map((g, gi) => {
    const any = Array.isArray(g.any) ? g.any : [];
    const min = Math.max(1, Number(g.min) || 1);
    let first = null;
    let n = 0;
    let coreOnly = false;
    for (const ref of any) {
      if (!exists(db, ref)) { missingRefs.push(ref); continue; }
      const eq = expand(db, ref);
      const pos = blockIds.findIndex((x) => eq.has(x));
      if (pos >= 0) {
        n += 1;
        if (!first || pos < first.pos) first = { pos, via: blockIds[pos], layer: block[pos].layer };
      } else if (coreIds.some((x) => eq.has(x))) coreOnly = true;
    }
    const hit = n >= min;
    return { name: g.name ?? `#${gi + 1}`, min, matched: n, hit, rank: first ? first.pos + 1 : null, via: first?.via ?? null, layer: first?.layer ?? null,
      ...(!hit && coreOnly ? { cutByRender: true } : {}) };
  });
  const avoidRefs = Array.isArray(c.avoid) ? c.avoid : [];
  const hits = new Set();
  const avoidMissing = [];
  for (const ref of avoidRefs) {
    if (!exists(db, ref)) { avoidMissing.push(ref); continue; }
    const eq = expand(db, ref);
    for (const x of blockIds) if (eq.has(x)) hits.add(x);
  }
  return { groups, avoid: { refs: avoidRefs, hits: [...hits], missing: avoidMissing }, ok: groups.every((g) => g.hit), missingRefs };
}
