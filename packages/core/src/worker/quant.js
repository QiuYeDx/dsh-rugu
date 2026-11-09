// 向量的截断、归一化、量化（§8.7）。主线程（写向量库）和 worker 线程（扫描）共用，纯函数。
//   - MRL 截断：嵌入模型支持套娃表示（Qwen3-Embedding 原生 2560 维，可截到 32–2560），取前 dim 维再 L2 归一化（向量:77-79）；
//   - int8：每条向量一个对称的尺度 s = max|x| / 127，x ≈ q × s；两条的点积 ≈ Σ q·q' × s × s'（内存 1 字节 / 维）；
//   - 二值：每维一位（x > 0），按 32 位一个字打包；粗排用汉明距离（内存 1 位 / 维）。
// 内存里只放 int8 和二值；f32 只在磁盘（记忆层），给伪查询向量和重新量化用（评审:FE-09）。

/**
 * 截到 dim 维并 L2 归一化。长度不够、含非有限数、全零 → null（这条向量不能用）。
 * @param {ArrayLike<number>} v
 * @param {number} dim
 * @returns {Float32Array|null}
 */
export function fitVector(v, dim) {
  if (!v || typeof v.length !== 'number' || !(dim > 0) || v.length < dim) return null;
  const out = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) {
    const x = Number(v[i]);
    if (!Number.isFinite(x)) return null;
    out[i] = x;
    n += x * x;
  }
  if (!(n > 0)) return null;
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < dim; i++) out[i] *= inv;
  return out;
}

/** 两条等长向量的点积（归一化后就是余弦）。 */
export function dot(a, b) {
  let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i + 3 < n; i += 4) {
    s0 += a[i] * b[i]; s1 += a[i + 1] * b[i + 1]; s2 += a[i + 2] * b[i + 2]; s3 += a[i + 3] * b[i + 3];
  }
  for (; i < n; i++) s0 += a[i] * b[i];
  return s0 + s1 + s2 + s3;
}

/**
 * f32 → int8（对称、每条一个尺度）。
 * @param {Float32Array} v
 * @returns {{q: Int8Array, scale: number}}
 */
export function quantizeQ8(v) {
  let m = 0;
  for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (a > m) m = a; }
  const q = new Int8Array(v.length);
  if (!(m > 0)) return { q, scale: 0 };
  const scale = m / 127;
  const inv = 1 / scale;
  for (let i = 0; i < v.length; i++) {
    const x = Math.round(v[i] * inv);
    q[i] = x > 127 ? 127 : x < -127 ? -127 : x;
  }
  return { q, scale };
}

/** int8 → f32（近似还原，再归一化）。 */
export function dequantizeQ8(q, scale, dim = q.length) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = q[i] * scale;
  return fitVector(v, dim);
}

/** 两条 int8 向量的整数点积（调用方乘两个尺度）。 */
export function dotQ8(a, aOff, b, dim) {
  let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0;
  let i = 0;
  for (; i + 3 < dim; i += 4) {
    s0 += a[aOff + i] * b[i]; s1 += a[aOff + i + 1] * b[i + 1];
    s2 += a[aOff + i + 2] * b[i + 2]; s3 += a[aOff + i + 3] * b[i + 3];
  }
  for (; i < dim; i++) s0 += a[aOff + i] * b[i];
  return s0 + s1 + s2 + s3;
}

/** 二值索引一条要几个 32 位字。 */
export const binWords = (dim) => Math.ceil(dim / 32);

/**
 * f32 → 二值（x > 0 记 1），按 32 位字打包。
 * @param {ArrayLike<number>} v
 * @returns {Uint32Array}
 */
export function binarize(v) {
  const words = binWords(v.length);
  const out = new Uint32Array(words);
  for (let d = 0; d < v.length; d++) if (v[d] > 0) out[d >>> 5] |= (1 << (d & 31));
  return out;
}

/** 32 位整数里 1 的个数。 */
export function popcnt(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** 汉明距离：bits[off .. off+words) 和 q。 */
export function hamming(bits, off, q, words) {
  let h = 0;
  for (let w = 0; w < words; w++) h += popcnt((bits[off + w] ^ q[w]) >>> 0);
  return h;
}

// ── BLOB 转换（node:sqlite 的 BLOB 进出都是 Uint8Array） ──────────────────
/** 任意类型数组 → 同一段内存上的 Uint8Array（写 BLOB 用）。 */
export const asBytes = (arr) => new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

/** BLOB → 对齐好的类型数组（字节偏移不对齐就复制一份）。 */
function viewOf(Ctor, u8) {
  if (!u8) return null;
  const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  const size = Ctor.BYTES_PER_ELEMENT;
  if (bytes.byteOffset % size === 0 && bytes.byteLength % size === 0) return new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / size);
  const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % size));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Ctor(copy.buffer);
}
export const blobToF32 = (u8) => viewOf(Float32Array, u8);
export const blobToI8 = (u8) => viewOf(Int8Array, u8);
export const blobToU32 = (u8) => viewOf(Uint32Array, u8);

/**
 * 一条 f32 向量 → 写进向量库的三种表示。
 * @param {Float32Array} v 已经截断和归一化
 * @param {boolean} keepF32 记忆层存 f32，原文层不存（§8.7）
 */
export function encodeVector(v, keepF32) {
  const { q, scale } = quantizeQ8(v);
  const b = binarize(v);
  return { f32: keepF32 ? asBytes(v) : null, q8: asBytes(q), q8Scale: scale, bin: asBytes(b), q, b };
}
