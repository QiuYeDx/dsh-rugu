// 回放评测（D152）的嵌入端口：只算查询向量（文档向量用库副本里线上当时算好的），请求参数和 DSH 的 Ollama 端口一致
// （packages/dsh/src/ports/embedding.js：/api/embed、truncate、dimensions、options.num_ctx、keep_alive）。
// 向量按「空间 + 文本哈希」缓存在输出目录里（缓存里只有哈希和向量，没有文字）：同一批用例第二次跑不碰 Ollama。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const l2 = (v) => {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / n);
};

/**
 * @param {{space: {space_id: string, port_space_id?: string, model: string, quant?: string, dim: number, doc_tpl_ver: string},
 *          url: string, cacheFile: string, numCtx?: number, fetchImpl?: typeof fetch}} opt
 * @returns {Promise<{port: object|null, reason: string|null, stats: {hits: number, calls: number}}>}  连不上 Ollama 时 port 为 null
 */
export async function ollamaQueryPort({ space, url, cacheFile, numCtx = 1024, fetchImpl = globalThis.fetch }) {
  const stats = { hits: 0, calls: 0 };
  const spaceId = space.port_space_id || space.space_id;
  let digest = null;
  try {
    const r = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { port: null, reason: `Ollama /api/tags HTTP ${r.status}`, stats };
    const j = await r.json();
    const m = (j?.models ?? []).find((x) => x.name === space.model || x.model === space.model);
    if (!m) return { port: null, reason: `Ollama 里没有模型 ${space.model}`, stats };
    digest = m.digest ?? null;
  } catch (e) {
    return { port: null, reason: `连不上 Ollama（${e?.code ?? e?.name ?? 'Error'}）`, stats };
  }
  const cache = new Map();
  try {
    for (const line of fs.readFileSync(cacheFile, 'utf8').split('\n')) {
      if (!line) continue;
      const o = JSON.parse(line);
      cache.set(o.k, o.v);
    }
  } catch { /* 还没有缓存 */ }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const keyOf = (t) => crypto.createHash('sha256').update(`${spaceId}\u0000${t}`).digest('hex');
  const toB64 = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
  const fromB64 = (s) => { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const port = {
    info: () => ({ spaceId, model: space.model, quant: space.quant ?? undefined, dim: space.dim, docTplVer: space.doc_tpl_ver, device: 'gpu', ...(digest ? { digest } : {}) }),
    async embed(texts, kind) {
      if (!texts.length) return { spaceId, vectors: [] };
      if (kind !== 'query') throw Object.assign(new Error('回放只算查询向量'), { code: 'EMBED_OFF' });
      const out = new Array(texts.length);
      const miss = [];
      texts.forEach((t, i) => {
        const v = cache.get(keyOf(t));
        if (v) { out[i] = fromB64(v); stats.hits += 1; } else miss.push(i);
      });
      if (miss.length) {
        stats.calls += 1;
        const r = await fetchImpl(`${url}/api/embed`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60_000),
          body: JSON.stringify({ model: space.model, input: miss.map((i) => texts[i]), truncate: true, dimensions: space.dim, options: { num_ctx: numCtx }, keep_alive: '2h' }),
        });
        if (!r.ok) throw Object.assign(new Error(`HTTP_${r.status}`), { code: `HTTP_${r.status}` });
        const vs = (await r.json())?.embeddings;
        if (!Array.isArray(vs) || vs.length !== miss.length) throw Object.assign(new Error('EMBED_SHAPE'), { code: 'EMBED_SHAPE' });
        const lines = [];
        miss.forEach((i, k) => {
          if (!Array.isArray(vs[k]) || vs[k].length !== space.dim) throw Object.assign(new Error('EMBED_DIM'), { code: 'EMBED_DIM' });
          const f = l2(vs[k]);
          out[i] = f;
          const key = keyOf(texts[i]);
          cache.set(key, toB64(f));
          lines.push(JSON.stringify({ k: key, v: cache.get(key) }));
        });
        fs.appendFileSync(cacheFile, `${lines.join('\n')}\n`);
      }
      return { spaceId, vectors: out };
    },
  };
  return { port, reason: null, stats };
}
