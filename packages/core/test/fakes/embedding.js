// FakeEmbedding：确定性的假嵌入。把文字切成字符 1 / 2 / 3 元组，哈希进 dim 个桶（带符号），再 L2 归一化。
//   - 共享字和词越多的两句话越近，所以「换个说法」的测试有意义（配合 synonyms 还能模拟同义词：
//     new FakeEmbedding({ synonyms: [['快递', '包裹'], ['拿', '取']] }) 会把「包裹」「取」先换成「快递」「拿」）；
//   - 同一段文字永远得到同一个向量；query 和 doc 在同一个空间里；
//   - setFailing(true) 模拟嵌入服务挂了（L3 降级测试）。
// FakeRerank 用同一套向量的余弦当重排分。
import crypto from 'node:crypto';

/** FNV-1a 32 位。 */
function fnv1a(s, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class FakeEmbedding {
  /**
   * @param {{dim?: number, model?: string, synonyms?: string[][], delayMs?: number, device?: 'cpu'|'gpu', docTplVer?: string}} [opt]
   *        synonyms：每组第一个是规范词，其余的都换成它
   */
  constructor({ dim = 256, model = 'fake-ngram', synonyms = [], delayMs = 0, device = 'cpu', docTplVer = '1' } = {}) {
    this.dim = dim;
    this.model = model;
    this.delayMs = delayMs;
    this.device = device;
    this.docTplVer = docTplVer;
    this.failing = false;
    this.calls = { query: 0, doc: 0, texts: 0 };
    // 长的同义词先替换，免得「包裹」被「包」先吃掉
    this.synonyms = synonyms.flatMap(([canon, ...alts]) => alts.map((a) => [a, canon])).sort((a, b) => b[0].length - a[0].length);
    this.spaceId = `fake-${crypto.createHash('sha256').update(JSON.stringify([model, dim, docTplVer, this.synonyms])).digest('hex').slice(0, 12)}`;
  }

  info() {
    return { spaceId: this.spaceId, model: this.model, quant: 'none', dim: this.dim, docTplVer: this.docTplVer, device: this.device };
  }

  setFailing(v = true) { this.failing = !!v; return this; }

  /** 同步算一条向量（测试里直接用）。 */
  vector(text) {
    let t = String(text ?? '').normalize('NFKC').toLowerCase();
    for (const [alt, canon] of this.synonyms) t = t.split(alt).join(canon);
    const chars = [...t.replace(/[^\p{L}\p{N}]+/gu, '')];
    const v = new Float32Array(this.dim);
    const add = (feat, w) => {
      const h = fnv1a(feat);
      const sign = (fnv1a(feat, 0x9747b28c) & 1) ? 1 : -1;
      v[h % this.dim] += sign * w;
    };
    for (let i = 0; i < chars.length; i++) {
      add(`1:${chars[i]}`, 0.5);
      if (i + 1 < chars.length) add(`2:${chars[i]}${chars[i + 1]}`, 1.0);
      if (i + 2 < chars.length) add(`3:${chars[i]}${chars[i + 1]}${chars[i + 2]}`, 0.5);
    }
    let n = 0;
    for (const x of v) n += x * x;
    if (n === 0) { v[0] = 1; return v; }   // 空文本：一个固定的单位向量
    const inv = 1 / Math.sqrt(n);
    for (let i = 0; i < v.length; i++) v[i] *= inv;
    return v;
  }

  /**
   * @param {string[]} texts
   * @param {'query'|'doc'} kind
   * @param {{priority?: number, signal?: AbortSignal}} [opt]
   */
  async embed(texts, kind, opt = {}) {
    if (!Array.isArray(texts)) throw new TypeError('FakeEmbedding.embed 需要字符串数组');
    if (kind !== 'query' && kind !== 'doc') throw new TypeError("kind 只能是 'query' 或 'doc'");
    if (opt.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failing) throw Object.assign(new Error('fake embedding down'), { code: 'EMBED_DOWN' });
    this.calls[kind] += 1;
    this.calls.texts += texts.length;
    return { spaceId: this.spaceId, vectors: texts.map((t) => this.vector(t)) };
  }
}

/** 两个归一化向量的余弦（就是点积）。 */
export function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export class FakeRerank {
  /** @param {FakeEmbedding} [embedding] */
  constructor(embedding = new FakeEmbedding()) {
    this.embedding = embedding;
    this.on = true;
    this.calls = 0;
  }
  available() { return this.on; }
  setAvailable(v) { this.on = !!v; return this; }
  async rerank(query, docs) {
    if (!this.on) throw Object.assign(new Error('rerank unavailable'), { code: 'RERANK_OFF' });
    this.calls += 1;
    const q = this.embedding.vector(query);
    return docs.map((d) => cosine(q, this.embedding.vector(d)));
  }
}
