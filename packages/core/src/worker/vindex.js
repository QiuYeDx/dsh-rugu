// 内存里的向量索引（§8.7）：按块追加的定长数组（每块 chunkRows 行），删掉的槽位进空闲表复用，不整体搬家。
//   - 记忆层热温层：int8 + 二值常驻；原文窗口层：只有二值常驻，int8 在磁盘（向量库），精排时按 id 取；
//   - 冷层（activation.tier = 'cold'）不进内存，只记 id，有意回想时从磁盘扫（§6.8）。
// 一行 = embed_texts 的一行（一个文本块）；同一条记忆的多个块在搜索结果里按记忆合并，取最高分。
import { OWNER_KINDS } from '../store/refs.js';
import { binWords, hamming, dotQ8 } from './quant.js';

/** owner_kind ↔ 小整数（数组里存它）。 */
export const KIND_LIST = Object.freeze(Object.keys(OWNER_KINDS));
export const KIND_INDEX = Object.freeze(Object.fromEntries(KIND_LIST.map((k, i) => [k, i])));
const PREFIX = KIND_LIST.map((k) => OWNER_KINDS[k]);

/** (kind, id) → 一个数字键（kindIdx < 16，id < 2^32，合起来 < 2^53）。 */
export const ownerKey = (kindIdx, ownerId) => kindIdx * 4294967296 + ownerId;
export const refOfKey = (key) => `${PREFIX[Math.floor(key / 4294967296)]}${key % 4294967296}`;
export const refOfOwner = (kindIdx, ownerId) => `${PREFIX[kindIdx]}${ownerId}`;

export class VectorLayer {
  /**
   * @param {number} dim
   * @param {{withQ8: boolean, chunkRows?: number}} opt
   */
  constructor(dim, { withQ8, chunkRows = 8192 }) {
    this.dim = dim;
    this.words = binWords(dim);
    this.withQ8 = withQ8;
    this.C = Math.max(64, chunkRows | 0);
    /** @type {{ids: Int32Array, kinds: Uint8Array, owners: Float64Array, chunkNos: Int32Array, alive: Uint8Array, scales: Float32Array, bins: Uint32Array, q8: Int8Array|null}[]} */
    this.chunks = [];
    this.used = 0;          // 分配过的槽位数（含删掉的）
    this.free = [];         // 空闲槽位
    this.slotOf = new Map();   // embed_text_id → 槽位
  }

  get size() { return this.slotOf.size; }

  #chunk(slot) { return this.chunks[Math.floor(slot / this.C)]; }

  #alloc() {
    if (this.free.length) return this.free.pop();
    const slot = this.used++;
    if (Math.floor(slot / this.C) >= this.chunks.length) {
      const C = this.C;
      this.chunks.push({
        ids: new Int32Array(C), kinds: new Uint8Array(C), owners: new Float64Array(C), chunkNos: new Int32Array(C),
        alive: new Uint8Array(C), scales: new Float32Array(C), bins: new Uint32Array(C * this.words),
        q8: this.withQ8 ? new Int8Array(C * this.dim) : null,
      });
    }
    return slot;
  }

  /**
   * 写入或覆盖一行（同一个 embed_text_id 再来一次就原地覆盖：发布和冷加载撞在一起时是幂等的）。
   * @param {{id: number, kindIdx: number, ownerId: number, chunkNo: number, scale: number, b: Uint32Array, q?: Int8Array|null}} r
   */
  upsert(r) {
    if (!r || r.b?.length !== this.words) return false;
    if (this.withQ8 && r.q?.length !== this.dim) return false;
    let slot = this.slotOf.get(r.id);
    if (slot === undefined) { slot = this.#alloc(); this.slotOf.set(r.id, slot); }
    const c = this.#chunk(slot);
    const i = slot % this.C;
    c.ids[i] = r.id;
    c.kinds[i] = r.kindIdx;
    c.owners[i] = r.ownerId;
    c.chunkNos[i] = r.chunkNo;
    c.scales[i] = r.scale;
    c.alive[i] = 1;
    c.bins.set(r.b, i * this.words);
    if (c.q8) c.q8.set(r.q, i * this.dim);
    return true;
  }

  remove(id) {
    const slot = this.slotOf.get(id);
    if (slot === undefined) return false;
    this.slotOf.delete(id);
    this.#chunk(slot).alive[slot % this.C] = 0;
    this.free.push(slot);
    return true;
  }

  /** 删掉一批记忆的所有块。keys = ownerKey 的集合。返回删掉的行数。 */
  removeOwners(keys) {
    if (!keys.size) return 0;
    let n = 0;
    for (let slot = 0; slot < this.used; slot++) {
      const c = this.#chunk(slot);
      const i = slot % this.C;
      if (c.alive[i] && keys.has(ownerKey(c.kinds[i], c.owners[i]))) { this.remove(c.ids[i]); n++; }
    }
    return n;
  }

  /**
   * 二值粗排：每条查询取汉明距离最小的 k 个槽位，返回并集。行数不多（≤ 2k）时直接返回全部（粗排没有意义）。
   * @param {Uint32Array[]} qbins
   * @param {number} k
   * @param {Set<number>|null} exclude ownerKey
   * @param {number} deadlineAt 墙钟毫秒（performance.timeOrigin + now）
   * @param {Set<number>|null} [include] 【D153】只看这些记忆（ownerKey）；不给 = 全部
   * @returns {{slots: number[], timedOut: boolean, scanned: number}}
   */
  coarse(qbins, k, exclude, deadlineAt, include = null) {
    const all = this.size <= k * 2;
    const heaps = all ? null : qbins.map(() => new MaxHeap(k));
    const slots = [];
    let timedOut = false;
    let scanned = 0;
    for (let slot = 0; slot < this.used; slot++) {
      if ((slot & 4095) === 4095 && wallNow() > deadlineAt) { timedOut = true; break; }
      const c = this.#chunk(slot);
      const i = slot % this.C;
      if (!c.alive[i]) continue;
      if (exclude && exclude.has(ownerKey(c.kinds[i], c.owners[i]))) continue;
      if (include && !include.has(ownerKey(c.kinds[i], c.owners[i]))) continue;
      scanned++;
      if (all) { slots.push(slot); continue; }
      const off = i * this.words;
      for (let qi = 0; qi < qbins.length; qi++) heaps[qi].offer(hamming(c.bins, off, qbins[qi], this.words), slot);
    }
    if (!all) {
      const seen = new Set();
      for (const h of heaps) for (const s of h.values()) if (!seen.has(s)) { seen.add(s); slots.push(s); }
    }
    return { slots, timedOut, scanned };
  }

  /**
   * 【D153】这些记忆（ownerKey）的全部槽位，不粗排（「只看这些」、条数不大时逐条精确比）。
   * @param {Set<number>} include
   * @param {Set<number>|null} exclude
   * @param {number} deadlineAt
   * @returns {{slots: number[], timedOut: boolean, scanned: number}}
   */
  select(include, exclude, deadlineAt) {
    const slots = [];
    let timedOut = false;
    for (let slot = 0; slot < this.used; slot++) {
      if ((slot & 4095) === 4095 && wallNow() > deadlineAt) { timedOut = true; break; }
      const c = this.#chunk(slot);
      const i = slot % this.C;
      if (!c.alive[i]) continue;
      const key = ownerKey(c.kinds[i], c.owners[i]);
      if (!include.has(key) || (exclude && exclude.has(key))) continue;
      slots.push(slot);
    }
    return { slots, timedOut, scanned: slots.length };
  }

  /** 槽位上的元数据。 */
  meta(slot) {
    const c = this.#chunk(slot);
    const i = slot % this.C;
    return { id: c.ids[i], kindIdx: c.kinds[i], ownerId: c.owners[i], chunkNo: c.chunkNos[i], scale: c.scales[i] };
  }

  /** 常驻 int8 的精排分：max over queries (Σ q·q' × s × s')。 */
  scoreQ8(slot, queries) {
    const c = this.#chunk(slot);
    const i = slot % this.C;
    const s = c.scales[i];
    let best = -Infinity;
    for (const q of queries) {
      const v = dotQ8(c.q8, i * this.dim, q.q, this.dim) * s * q.s;
      if (v > best) best = v;
    }
    return best;
  }
}

/** 保留最小的 k 个距离（堆顶是当前第 k 小的）。 */
class MaxHeap {
  constructor(k) { this.k = k; this.d = new Float64Array(k); this.v = new Int32Array(k); this.n = 0; }
  offer(dist, val) {
    if (this.n < this.k) {
      let i = this.n++;
      this.d[i] = dist; this.v[i] = val;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.d[p] >= this.d[i]) break;
        this.#swap(i, p); i = p;
      }
      return;
    }
    if (dist >= this.d[0]) return;
    this.d[0] = dist; this.v[0] = val;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1; const r = l + 1;
      let m = i;
      if (l < this.n && this.d[l] > this.d[m]) m = l;
      if (r < this.n && this.d[r] > this.d[m]) m = r;
      if (m === i) break;
      this.#swap(i, m); i = m;
    }
  }
  #swap(a, b) {
    const d = this.d[a]; this.d[a] = this.d[b]; this.d[b] = d;
    const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v;
  }
  values() { return Array.from(this.v.subarray(0, this.n)); }
}

/** 跨线程可比的墙钟毫秒（只用来算截止时间，不是记忆里的时间）。 */
export const wallNow = () => performance.timeOrigin + performance.now();
