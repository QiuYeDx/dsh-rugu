// 查询引擎：稠密扫描、词法、词频统计、图扩散、已存向量。worker 线程里用自己的只读连接跑它（thread.js）；
// 没起线程时（测试、startWorker:false）主线程里也是同一份代码（index.js 的本地引擎）。所有方法都是同步的，
// 截止时间（deadlineAt，墙钟毫秒）在循环里检查，到点就带着已有的结果返回（timedOut）。
import { matchQuery, MAX_MATCH_TERMS, normalizeToken } from '../store/fts.js';
import { parseRef } from '../store/refs.js';
import { VectorLayer, KIND_INDEX, KIND_LIST, ownerKey, refOfKey, refOfOwner, wallNow } from './vindex.js';
import { blobToI8, blobToU32, blobToF32, dequantizeQ8, dotQ8, quantizeQ8, binarize, fitVector } from './quant.js';
import { GraphReader, localPush } from './graph.js';
import { DEFAULTS } from '../config/defaults.js';

const TABLE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SHARD_RE = /^percepts_fts_\d{6}$/;
/** 词法路能查的表和它们的记忆种类。 */
const FIXED_TABLES = Object.freeze({ episodes_fts: 'e', assertions_fts: 'a' });
/** 表名别名：热路径的原文分表（最近 hotMonths 个月）/ 全部原文分表。 */
export const HOT_SHARDS = 'percepts_fts';
export const ALL_SHARDS = 'percepts_fts_all';

/**
 * 只读的数据库句柄（DatabaseSync 或 Store 都行）。
 * @typedef {{get: (sql: string, ...p: any[]) => any, all: (sql: string, ...p: any[]) => any[], exec: (sql: string) => void}} DbHandle
 */

/** 把 node:sqlite 的 DatabaseSync 包成 DbHandle（语句缓存）。 */
export function wrapDatabase(db) {
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    get: (sql, ...p) => prep(sql).get(...p),
    all: (sql, ...p) => prep(sql).all(...p),
    exec: (sql) => db.exec(sql),
    close: () => { cache.clear(); db.close(); },
  };
}

/** 【D153】记忆引用 → ownerKey 的集合（认不出的丢掉）。 */
function ownerKeys(refs) {
  const out = new Set();
  for (const ref of refs) {
    const m = parseRef(ref);
    const k = m ? KIND_INDEX[m.kind] : undefined;
    if (k !== undefined) out.add(ownerKey(k, m.id));
  }
  return out;
}

/**
 * 【D153】一组 rowid 切成几段区间（按最大的几个空隙切，最多 maxRanges 段；空隙不到总跨度的 1/maxRanges 不切）。
 * FTS5 的「MATCH + rowid IN (很多值)」很慢（每个值一次查找，1400 个值约 75 ms），按区间查再在 JS 里按集合筛只要零点几毫秒。
 * @param {number[]} sorted 升序
 * @returns {[number, number][]}
 */
export function rowRanges(sorted, maxRanges = 4) {
  if (!sorted.length) return [];
  const lo = sorted[0];
  const hi = sorted.at(-1);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push([sorted[i] - sorted[i - 1], i]);
  const minGap = (hi - lo) / maxRanges;
  const cuts = gaps.filter(([g]) => g > minGap && g > 1).sort((x, y) => y[0] - x[0]).slice(0, maxRanges - 1).map(([, i]) => i).sort((x, y) => x - y);
  const out = [];
  let start = 0;
  for (const c of [...cuts, sorted.length]) { out.push([sorted[start], sorted[c - 1]]); start = c; }
  return out;
}

export class Engine {
  /**
   * @param {{main: DbHandle, vec: DbHandle|null, chunkRows?: number, loadBatch?: number}} opt
   */
  constructor({ main, vec, chunkRows = 8192, loadBatch = 4000 }) {
    this.main = main;
    this.vec = vec;
    this.chunkRows = chunkRows;
    this.loadBatch = loadBatch;
    /** @type {Map<string, {dim: number, memory: VectorLayer, raw: VectorLayer, cold: Map<number, {key: number, chunkNo: number}>, loadedAt: number}>} */
    this.spaces = new Map();
    this.graph = new GraphReader(main);
    this.docCounts = new Map();   // FTS 表 → {n, at}
    this.vocab = new Set();       // 已经建好的 temp fts5vocab 表
  }

  // ── 向量索引 ────────────────────────────────────────────────────────────
  /** 冷层的实体集合（activation.tier = 'cold'，记忆层用）。 */
  #coldOwners() {
    const set = new Set();
    try {
      for (const r of this.main.all("SELECT owner_kind, owner_id FROM activation WHERE tier = 'cold'")) {
        const k = KIND_INDEX[r.owner_kind];
        if (k !== undefined) set.add(ownerKey(k, r.owner_id));
      }
    } catch { /* activation 表读不了就全当热层 */ }
    return set;
  }

  /**
   * 从向量库冷加载一个空间（热温层 int8 + 二值、原文层二值；冷层只记 id）。可以重复调用（整体重建）。
   * ifMissing：已经加载过、维数也对得上就什么都不做（启动后 ensureSpace 再发一次 loadSpace 时不重复冷加载）。
   * @param {{spaceId: string, dim?: number, ifMissing?: boolean}} a
   */
  loadSpace({ spaceId, dim, ifMissing = false }) {
    if (!this.vec) return { loaded: 0 };
    const d = dim ?? Number(this.main.get('SELECT dim FROM vector_spaces WHERE space_id = ?', spaceId)?.dim ?? 0);
    if (!(d > 0)) { this.spaces.delete(spaceId); return { loaded: 0 }; }
    const cur = this.spaces.get(spaceId);
    if (ifMissing && cur && cur.dim === d) return { loaded: 0, skipped: true };
    const sp = {
      dim: d,
      memory: new VectorLayer(d, { withQ8: true, chunkRows: this.chunkRows }),
      raw: new VectorLayer(d, { withQ8: false, chunkRows: this.chunkRows }),
      cold: new Map(),
      loadedAt: wallNow(),
    };
    const cold = this.#coldOwners();
    let after = -1;
    let loaded = 0;
    for (;;) {
      const rows = this.vec.all(`SELECT embed_text_id AS id, owner_kind, owner_id, chunk_no, layer, q8, q8_scale, bin FROM vectors
                                 WHERE space_id = ? AND embed_text_id > ? ORDER BY embed_text_id LIMIT ?`, spaceId, after, this.loadBatch);
      if (!rows.length) break;
      after = rows.at(-1).id;
      for (const r of rows) if (this.#place(sp, r, cold)) loaded++;
    }
    this.spaces.set(spaceId, sp);
    return { loaded, memory: sp.memory.size, raw: sp.raw.size, cold: sp.cold.size };
  }

  #place(sp, r, coldSet) {
    const kindIdx = KIND_INDEX[r.owner_kind];
    if (kindIdx === undefined) return false;
    const b = blobToU32(r.bin);
    const key = ownerKey(kindIdx, r.owner_id);
    if (r.layer === 'raw') return sp.raw.upsert({ id: r.id, kindIdx, ownerId: r.owner_id, chunkNo: r.chunk_no, scale: r.q8_scale, b });
    if (coldSet.has(key)) {
      sp.memory.remove(r.id);
      sp.cold.set(r.id, { key, chunkNo: r.chunk_no });
      return true;
    }
    sp.cold.delete(r.id);
    return sp.memory.upsert({ id: r.id, kindIdx, ownerId: r.owner_id, chunkNo: r.chunk_no, scale: r.q8_scale, b, q: blobToI8(r.q8) });
  }

  unloadSpace({ spaceId }) { this.spaces.delete(spaceId); return { ok: true }; }
  /** 全部重建（清扫删了很多行之后、夜里重新分层之后）。 */
  reload() {
    const ids = [...this.spaces.keys()];
    const out = {};
    for (const id of ids) out[id] = this.loadSpace({ spaceId: id }).loaded;
    return out;
  }

  /**
   * 主线程写完向量库之后发布的新向量（按块追加）。没加载过的空间忽略（以后冷加载时从磁盘读）。
   * @param {{spaceId: string, rows: {id: number, owner_kind: string, owner_id: number, chunk_no: number, layer: string, q8: Uint8Array, q8_scale: number, bin: Uint8Array}[]}} a
   */
  add({ spaceId, rows }) {
    const sp = this.spaces.get(spaceId);
    if (!sp) return { added: 0 };
    let cold = null;
    const memRows = rows.filter((r) => r.layer === 'memory');
    if (memRows.length) {
      cold = new Set();
      for (const r of memRows) {
        try {
          const t = this.main.get('SELECT tier FROM activation WHERE owner_kind = ? AND owner_id = ?', r.owner_kind, r.owner_id);
          if (t?.tier === 'cold') { const k = KIND_INDEX[r.owner_kind]; if (k !== undefined) cold.add(ownerKey(k, r.owner_id)); }
        } catch { /* 当热层 */ }
      }
    }
    let added = 0;
    for (const r of rows) if (this.#place(sp, r, cold ?? new Set())) added++;
    return { added };
  }

  /** 删掉 embed_texts 行对应的向量（全部空间）。 */
  remove({ ids }) {
    let n = 0;
    for (const sp of this.spaces.values()) {
      for (const id of ids) { if (sp.memory.remove(id) || sp.raw.remove(id) || sp.cold.delete(id)) n++; }
    }
    return { removed: n };
  }

  /** 删掉这些记忆的全部向量（refs 是记忆引用字符串）。 */
  removeOwners({ refs }) {
    const keys = new Set();
    for (const ref of refs) { const m = parseRef(ref); if (m) keys.add(ownerKey(KIND_INDEX[m.kind], m.id)); }
    let n = 0;
    for (const sp of this.spaces.values()) {
      n += sp.memory.removeOwners(keys) + sp.raw.removeOwners(keys);
      for (const [id, c] of sp.cold) if (keys.has(c.key)) { sp.cold.delete(id); n++; }
    }
    return { removed: n };
  }

  stats() {
    const out = {};
    for (const [id, sp] of this.spaces) out[id] = { dim: sp.dim, memory: sp.memory.size, raw: sp.raw.size, cold: sp.cold.size };
    return out;
  }

  /**
   * 主库连接是不是只读的（§13.2「worker 能打开只读连接」）：试一条什么都不改的写语句，只读连接会报 SQLITE_READONLY。
   * 借用主线程 store 的本地引擎（内存库）这里是 false。
   */
  readOnlyCheck() {
    try {
      this.main.get("INSERT INTO meta(key, value) SELECT 'worker.readonly-check', NULL WHERE 0");
      return false;
    } catch (e) {
      return e?.errcode === 8 || /readonly/i.test(String(e?.message));
    }
  }

  /**
   * 稠密扫描（§8.7）：每层二值粗排前 coarseTopK → int8 精排；每条记忆取各查询向量、各块里的最高分。
   * 【D153】only（记忆引用的数组）：只在这些记忆里比；条数 ≤ exactMax 时不走二值粗排，逐条用存的 int8 精确比
   * （记忆层常驻内存的 int8、原文层从磁盘取的 int8、冷层同样从磁盘取），多了照常粗排但只在 only 里。没给 only 和原来一样。
   * @param {{spaceId: string, vectors: Float32Array[], layers: string[], topK: {memory?: number, raw?: number}, includeCold?: boolean,
   *          exclude?: string[], coarseTopK?: number, only?: string[], exactMax?: number, deadlineAt: number}} a
   * @param {(partial: {layer: string, hits: object[]}) => void} [onPartial]
   */
  dense(a, onPartial) {
    let sp = this.spaces.get(a.spaceId);
    if (!sp && this.vec) { this.loadSpace({ spaceId: a.spaceId }); sp = this.spaces.get(a.spaceId); }
    if (!sp) return { hits: [], timedOut: false, scanned: 0 };
    const queries = [];
    for (const v of a.vectors ?? []) {
      const f = fitVector(v, sp.dim);
      if (!f) continue;
      const { q, scale } = quantizeQ8(f);
      queries.push({ f, q, s: scale, b: binarize(f) });
    }
    if (!queries.length) return { hits: [], timedOut: false, scanned: 0 };
    const exclude = new Set();
    for (const ref of a.exclude ?? []) { const m = parseRef(ref); if (m) exclude.add(ownerKey(KIND_INDEX[m.kind], m.id)); }
    const k = Math.max(1, a.coarseTopK ?? DEFAULTS.recall.dense.coarseTopK);
    const only = Array.isArray(a.only) ? ownerKeys(a.only) : null;
    if (only && !only.size) return { hits: [], timedOut: false, scanned: 0 };
    const exact = !!only && only.size <= Math.max(0, a.exactMax ?? DEFAULTS.recall.scope.exactMax);
    const hits = [];
    let timedOut = false;
    let scanned = 0;
    for (const layer of a.layers ?? ['memory', 'raw']) {
      if (layer !== 'memory' && layer !== 'raw') continue;
      if (wallNow() > a.deadlineAt) { timedOut = true; break; }
      const topK = Math.max(0, a.topK?.[layer] ?? (layer === 'memory' ? DEFAULTS.recall.dense.memoryTopK : DEFAULTS.recall.dense.rawTopK));
      if (!topK) continue;
      const L = sp[layer];
      const c = exact
        ? L.select(only, exclude.size ? exclude : null, a.deadlineAt)
        : L.coarse(queries.map((x) => x.b), k, exclude.size ? exclude : null, a.deadlineAt, only);
      scanned += c.scanned;
      if (c.timedOut) timedOut = true;
      const best = new Map();   // ownerKey → {score, chunkNo}
      const offer = (key, score, chunkNo) => {
        const o = best.get(key);
        if (!o || score > o.score) best.set(key, { score, chunkNo });
      };
      if (layer === 'memory') {
        for (const slot of c.slots) {
          const m = L.meta(slot);
          offer(ownerKey(m.kindIdx, m.ownerId), L.scoreQ8(slot, queries), m.chunkNo);
        }
        if (a.includeCold && sp.cold.size && !timedOut) {
          const r = this.#scanCold(a.spaceId, sp, queries, exclude, a.deadlineAt, offer, only);
          scanned += r.scanned;
          if (r.timedOut) timedOut = true;
        }
      } else if (c.slots.length) {
        // 原文层：int8 在磁盘，按 id 取回来精排
        const metas = new Map(c.slots.map((s) => { const m = L.meta(s); return [m.id, m]; }));
        const ids = [...metas.keys()];
        for (let i = 0; i < ids.length; i += 400) {
          const part = ids.slice(i, i + 400);
          const rows = this.vec.all(`SELECT embed_text_id AS id, q8, q8_scale FROM vectors WHERE space_id = ? AND embed_text_id IN (${part.map(() => '?').join(',')})`, a.spaceId, ...part);
          for (const r of rows) {
            const m = metas.get(r.id);
            const q8 = blobToI8(r.q8);
            if (!m || q8?.length !== sp.dim) continue;
            let s = -Infinity;
            for (const q of queries) { const v = dotQ8(q8, 0, q.q, sp.dim) * r.q8_scale * q.s; if (v > s) s = v; }
            offer(ownerKey(m.kindIdx, m.ownerId), s, m.chunkNo);
          }
        }
      }
      const layerHits = [...best].map(([key, o]) => ({ ref: refOfKey(key), score: o.score, chunkNo: o.chunkNo, layer }))
        .sort((x, y) => y.score - x.score || (x.ref < y.ref ? -1 : 1)).slice(0, topK);
      hits.push(...layerHits);
      onPartial?.({ layer, hits: layerHits });
      if (c.timedOut) break;
    }
    return { hits, timedOut, scanned };
  }

  /** 冷层从磁盘扫（只在有意回想时）：直接 int8 精排。 */
  #scanCold(spaceId, sp, queries, exclude, deadlineAt, offer, only = null) {
    const ids = only ? [...sp.cold].filter(([, c]) => only.has(c.key)).map(([id]) => id) : [...sp.cold.keys()];
    let scanned = 0;
    for (let i = 0; i < ids.length; i += 500) {
      if (wallNow() > deadlineAt) return { scanned, timedOut: true };
      const part = ids.slice(i, i + 500);
      const rows = this.vec.all(`SELECT embed_text_id AS id, owner_kind, owner_id, chunk_no, q8, q8_scale FROM vectors
                                 WHERE space_id = ? AND embed_text_id IN (${part.map(() => '?').join(',')})`, spaceId, ...part);
      for (const r of rows) {
        const kindIdx = KIND_INDEX[r.owner_kind];
        if (kindIdx === undefined) continue;
        const key = ownerKey(kindIdx, r.owner_id);
        if (exclude.has(key)) continue;
        const q8 = blobToI8(r.q8);
        if (q8?.length !== sp.dim) continue;
        scanned++;
        let s = -Infinity;
        for (const q of queries) { const v = dotQ8(q8, 0, q.q, sp.dim) * r.q8_scale * q.s; if (v > s) s = v; }
        offer(key, s, r.chunk_no);
      }
    }
    return { scanned, timedOut: false };
  }

  /**
   * 已经存好的向量（L3 的伪查询向量用，§8.8）：每条记忆取它的第一个正文块；记忆层有 f32 用 f32，原文层用 int8 还原。
   * @param {{refs: string[], spaceId: string}} a
   * @returns {[string, Float32Array][]}
   */
  stored({ refs, spaceId }) {
    if (!this.vec) return [];
    const out = [];
    for (const ref of refs ?? []) {
      const m = parseRef(ref);
      if (!m) continue;
      const rows = this.vec.all(`SELECT chunk_no, kind, f32, q8, q8_scale FROM vectors WHERE space_id = ? AND owner_kind = ? AND owner_id = ?
                                 ORDER BY (kind = 'text') DESC, chunk_no LIMIT 1`, spaceId, m.kind, m.id);
      const r = rows[0];
      if (!r) continue;
      const f = r.f32 ? blobToF32(r.f32) : null;
      const v = f ? fitVector(f, f.length) : dequantizeQ8(blobToI8(r.q8), r.q8_scale);
      if (v) out.push([ref, v]);
    }
    return out;
  }

  // ── 词法 ────────────────────────────────────────────────────────────────
  #shards() {
    try { return this.main.all('SELECT name FROM fts_shards ORDER BY month DESC').map((r) => r.name).filter((n) => SHARD_RE.test(n)); } catch { return []; }
  }

  /** 表名（含别名）→ [表名, 记忆引用前缀]。不认识的表丢掉（不拼进 SQL）。maxShards：原文分表最多只要最新的几张（降级时）。 */
  resolveTables(tables, hotMonths = 3, maxShards = null) {
    const shards = this.#shards();
    const known = new Set(Number.isInteger(maxShards) && maxShards >= 0 ? shards.slice(0, maxShards) : shards);
    const out = [];
    const seen = new Set();
    const push = (t, prefix) => { if (!seen.has(t)) { seen.add(t); out.push([t, prefix]); } };
    for (const t of tables ?? []) {
      if (t === HOT_SHARDS) { for (const s of shards.slice(0, Math.max(0, hotMonths))) if (known.has(s)) push(s, 'p'); continue; }
      if (t === ALL_SHARDS) { for (const s of shards) if (known.has(s)) push(s, 'p'); continue; }
      if (typeof t !== 'string' || !TABLE_RE.test(t)) continue;
      if (FIXED_TABLES[t]) push(t, FIXED_TABLES[t]);
      else if (known.has(t)) push(t, 'p');
    }
    return out;
  }

  /**
   * BM25 词法查询（§8.2）：逐词加引号再 OR（store.matchQuery），每张表取前 limit，按 −bm25 合并。
   * 【D150】weights（和 terms 一一对应，缺省都是 1）：同一个权重的词一起查一次，各组的 −bm25 乘上权重再按行加起来
   * （焦点的词权重 1、对话其余部分的词轻一些）。FTS5 的 bm25 给不了逐词的权重，分组查是最直接的办法。
   * 【D153】only（记忆引用的数组）：各表只看这些行——情节表看 e…、事实表看 a…、原文分表看 p…；原文窗口 w… 换成它的成员感知
   * （词法路上原文是按一条条感知查的，命中照旧是 p…）。按 rowid 区间查、再按集合筛（不用 rowid IN，见 rowRanges）。没给 only 和原来一样。
   * @param {{terms: string[], weights?: number[], tables: string[], limit: number, maxTerms?: number, hotMonths?: number, maxShards?: number|null,
   *          only?: string[], deadlineAt: number}} a
   * @param {(partial: {table: string, hits: object[]}) => void} [onPartial]
   */
  lexical(a, onPartial) {
    const max = Math.min(MAX_MATCH_TERMS, Math.max(1, a.maxTerms ?? MAX_MATCH_TERMS));
    const groups = new Map();
    (a.terms ?? []).slice(0, max).forEach((t, i) => {
      const w = Number(a.weights?.[i] ?? 1);
      if (!(w > 0) || !Number.isFinite(w)) return;
      if (!groups.has(w)) groups.set(w, []);
      groups.get(w).push(t);
    });
    const queries = [...groups].map(([w, ts]) => ({ w, q: matchQuery(ts, max) })).filter((g) => g.q);
    if (!queries.length) return { hits: [], timedOut: false };
    const limit = Math.max(1, a.limit ?? DEFAULTS.recall.lexical.topK);
    const only = Array.isArray(a.only) ? this.#onlyRows(a.only) : null;
    const all = [];
    let timedOut = false;
    for (const [t, prefix] of this.resolveTables(a.tables, a.hotMonths, a.maxShards ?? null)) {
      if (wallNow() > a.deadlineAt) { timedOut = true; break; }
      const want = only ? only[prefix] : null;
      if (only && !want?.ids.size) continue;
      const score = new Map();
      for (const { w, q } of queries) {
        let rows = [];
        try {
          if (!want) rows = this.main.all(`SELECT rowid AS id, bm25(${t}) AS s FROM ${t} WHERE ${t} MATCH ? ORDER BY s LIMIT ?`, q, limit);
          else {
            for (const [lo, hi] of want.ranges) {
              for (const r of this.main.all(`SELECT rowid AS id, bm25(${t}) AS s FROM ${t} WHERE ${t} MATCH ? AND rowid >= ? AND rowid <= ?`, q, lo, hi)) {
                if (want.ids.has(r.id)) rows.push(r);
              }
            }
            rows = rows.sort((x, y) => x.s - y.s || x.id - y.id).slice(0, limit);
          }
        } catch { rows = []; }   // 某张表坏了只丢这一张
        for (const r of rows) score.set(r.id, (score.get(r.id) ?? 0) - w * r.s);
      }
      const hits = [...score].map(([id, sc]) => ({ ref: `${prefix}${id}`, score: sc, table: t }));
      all.push(...hits);
      onPartial?.({ table: t, hits });
    }
    const best = new Map();
    for (const h of all) { const o = best.get(h.ref); if (!o || h.score > o.score) best.set(h.ref, h); }
    const hits = [...best.values()].sort((x, y) => y.score - x.score || (x.ref < y.ref ? -1 : 1)).slice(0, limit);
    return { hits, timedOut };
  }

  /**
   * 【D153】only → 各前缀（e / a / p）要看的 rowid 集合和区间。原文窗口 w… 换成成员感知（members_json）。
   * @param {string[]} refs
   * @returns {Record<'e'|'a'|'p', {ids: Set<number>, ranges: [number, number][]}>}
   */
  #onlyRows(refs) {
    const ids = { e: new Set(), a: new Set(), p: new Set() };
    const wins = [];
    for (const ref of refs) {
      const m = parseRef(ref);
      if (!m) continue;
      if (m.kind === 'episode') ids.e.add(m.id);
      else if (m.kind === 'assertion') ids.a.add(m.id);
      else if (m.kind === 'percept') ids.p.add(m.id);
      else if (m.kind === 'window') wins.push(m.id);
    }
    for (let i = 0; i < wins.length; i += 500) {
      const part = wins.slice(i, i + 500);
      let rows = [];
      try { rows = this.main.all(`SELECT members_json AS m FROM raw_windows WHERE id IN (${part.map(() => '?').join(',')})`, ...part); } catch { rows = []; }
      for (const r of rows) {
        let members = [];
        try { members = JSON.parse(r.m); } catch { members = []; }
        for (const x of Array.isArray(members) ? members : []) if (Number.isSafeInteger(x) && x > 0) ids.p.add(x);
      }
    }
    const out = {};
    for (const [k, set] of Object.entries(ids)) out[k] = { ids: set, ranges: rowRanges([...set].sort((x, y) => x - y)) };
    return out;
  }

  /**
   * 词的文档数（§8.2 挑词、lang.distinctiveTerms 的 IDF）：fts5vocab('row') 在 temp 库里，按表加总。
   * @param {{terms: string[], countTtlMs?: number}} a
   * @returns {{N: number, docs: Record<string, number>}}
   */
  termCounts({ terms, countTtlMs = 60_000, excludePercepts = null }) {
    const tables = ['episodes_fts', 'assertions_fts', ...this.#shards()];
    const norm = [...new Set((terms ?? []).map((t) => normalizeToken(t)).filter(Boolean))];
    const docs = Object.fromEntries(norm.map((t) => [t, 0]));
    const excluded = this.#excludedHits(norm, excludePercepts);
    let N = 0;
    const now = wallNow();
    for (const t of tables) {
      if (!TABLE_RE.test(t)) continue;
      let c = this.docCounts.get(t);
      if (!c || now - c.at > countTtlMs) {
        let n = 0;
        try { n = Number(this.main.get(`SELECT count(*) AS n FROM "${t}_docsize"`)?.n ?? 0); } catch { n = 0; }
        c = { n, at: now };
        this.docCounts.set(t, c);
      }
      N += c.n;
      if (!c.n || !norm.length) continue;
      const v = `${t}_vocab`;
      try {
        if (!this.vocab.has(v)) {
          this.main.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp."${v}" USING fts5vocab(main, '${t}', 'row')`);
          this.vocab.add(v);
        }
        for (const term of norm) docs[term] += Number(this.main.get(`SELECT doc FROM temp."${v}" WHERE term = ?`, term)?.doc ?? 0);
      } catch { /* 这张表的统计拿不到：当没有 */ }
    }
    return excluded ? { N, docs, excluded } : { N, docs };
  }

  /**
   * 眼前这段对话（线索窗口里的感知）里，每个词出现在哪几条：词法路的统计要去掉它们（问题本身不是「库里有的」）。
   * 不缓存（窗口每轮都变）；按分表的 rowid 范围查（FTS5 的 rowid 范围约束走索引），再按 id 集合筛。
   * @returns {Record<string, number[]>|null} 词 → 含它的被排除感知 id；没给排除集合返回 null
   */
  #excludedHits(norm, excludePercepts) {
    if (!Array.isArray(excludePercepts)) return null;
    const ids = [...new Set(excludePercepts.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 64);
    const out = {};
    if (!ids.length || !norm.length) return out;
    const byShard = new Map();
    try {
      for (const r of this.main.all(`SELECT id, fts_shard FROM percepts WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)) {
        if (typeof r.fts_shard !== 'string' || !SHARD_RE.test(r.fts_shard)) continue;
        if (!byShard.has(r.fts_shard)) byShard.set(r.fts_shard, new Set());
        byShard.get(r.fts_shard).add(r.id);
      }
    } catch { return out; }
    for (const [shard, set] of byShard) {
      const lo = Math.min(...set);
      const hi = Math.max(...set);
      for (const term of norm) {
        let rows = [];
        try {
          rows = this.main.all(`SELECT rowid AS id FROM "${shard}" WHERE "${shard}" MATCH ? AND rowid >= ? AND rowid <= ?`,
            `"${term.replaceAll('"', '""')}"`, lo, hi);
        } catch { rows = []; }
        for (const r of rows) if (set.has(r.id)) (out[term] ??= []).push(r.id);
      }
    }
    return out;
  }

  // ── 图扩散 ──────────────────────────────────────────────────────────────
  ppr(a) { return localPush(this.graph, a); }

  close() {
    this.spaces.clear();
    try { this.main.close?.(); } catch { /* 尽力 */ }
    try { this.vec?.close?.(); } catch { /* 尽力 */ }
  }
}

export { KIND_LIST, refOfOwner };
