// worker 测试的小工具（不是测试文件）。
import { DEFAULTS } from '../../src/config/defaults.js';
import { createTestCore, fakePorts, FakeEmbedding } from '../fakes/index.js';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (isPlain(v) && isPlain(a[k])) deepMerge(a[k], v);
    else a[k] = v;
  }
  return a;
}

/**
 * 一个配置句柄：默认参数表 + 本模块新加的键（defaults.js 里还没有，createConfig 会把未知键丢掉，所以测试里直接造句柄）。
 * @param {object} [extra]
 */
export function cfgHandle(extra = {}) {
  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), extra);
  return { get: () => cfg, version: () => 0, update: () => [], replace: () => [], onChange: () => () => {} };
}

/**
 * 测试用的核心：真库 + 真向量库 + FakeEmbedding。
 * @param {{name?: string, embedding?: object|null, config?: object, mods?: object, ports?: object}} [opt]
 */
export async function workerCore({ name = 'worker', embedding, config = {}, mods, ports } = {}) {
  const emb = embedding === undefined ? new FakeEmbedding() : embedding;
  const p = ports ?? fakePorts({ embedding: emb });
  const t = await createTestCore({ name, ports: p, config: cfgHandle(config), mods });
  return { ...t, emb, ports: p };
}

/** 登记一条记忆的嵌入文本（在一个事务里，像写记忆的模块那样）。 */
export function addText(core, kind, id, text, { layer = 'memory', priority = layer === 'raw' ? 1 : 2, chunkNo = 0, kindOf = 'text' } = {}) {
  core.store.tx(() => core.mods.worker.enqueueEmbed(core, { kind, id }, [{ chunkNo, kind: kindOf, text }], { layer, priority }));
}

/** 跑完嵌入队列。 */
export async function drainQueue(core, opt = {}) {
  let total = { embedded: 0, failed: 0 };
  for (let i = 0; i < 1000; i++) {
    const r = await core.mods.worker.runEmbedQueue(core, { batchSize: 64, ...opt });
    total = { embedded: total.embedded + r.embedded, failed: total.failed + r.failed };
    if (!r.embedded && !r.failed) break;
  }
  return total;
}

/** 一个按空间嵌入的端口（支持 opt.spaceId，换档测试用）：spaces = {spaceId: FakeEmbedding}，current 是 info() 给的。 */
export class MultiSpacePort {
  constructor(embs, current) {
    this.embs = embs;
    this.current = current;
    this.calls = [];
  }
  info() { return this.embs[this.current].info(); }
  async embed(texts, kind, opt = {}) {
    const want = opt.spaceId && this.byPortId(opt.spaceId) ? opt.spaceId : this.embs[this.current].spaceId;
    this.calls.push({ kind, n: texts.length, spaceId: want });
    return this.byPortId(want).embed(texts, kind, opt);
  }
  byPortId(id) { return Object.values(this.embs).find((e) => e.spaceId === id) ?? null; }
}

/** 一个包装端口：可以改写返回的 spaceId、在调用时做点事、记录调用。 */
export class WrapPort {
  constructor(inner, { spaceId, before, mapVectors } = {}) {
    this.inner = inner;
    this.spaceIdOverride = spaceId;
    this.before = before;
    this.mapVectors = mapVectors;
    this.calls = [];
  }
  info() { const i = this.inner.info(); return this.spaceIdOverride ? { ...i, spaceId: this.spaceIdOverride } : i; }
  async embed(texts, kind, opt = {}) {
    this.calls.push({ kind, n: texts.length, at: this.calls.length });
    if (this.before) await this.before(texts, kind, opt);
    const r = await this.inner.embed(texts, kind, opt);
    return {
      spaceId: this.spaceIdOverride ?? r.spaceId,
      vectors: this.mapVectors ? r.vectors.map((v, i) => this.mapVectors(v, i, texts[i])) : r.vectors,
    };
  }
}

export { FakeEmbedding };

/**
 * 写一行夹具数据（别的模块的表：schema 在并行开发中会加列，这里按 PRAGMA table_info 把没给的 NOT NULL 列补上 0 / ''）。
 * @param {import('../../src/store/db.js').Store} db
 * @param {string} table
 * @param {Record<string, unknown>} values
 */
export function insertRow(db, table, values) {
  const cols = db.all(`PRAGMA table_info(${table})`);
  const row = { ...values };
  for (const c of cols) {
    if (c.name in row || !c.notnull || c.dflt_value != null || c.pk) continue;
    row[c.name] = /INT|REAL/i.test(c.type) ? 0 : '';
  }
  const keys = Object.keys(row);
  db.run(`INSERT INTO ${table}(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
}

const OWNER_TABLE = { assertion: 'assertions', episode: 'episodes', window: 'raw_windows', entity: 'entities', impression: 'entity_impressions', intention: 'intentions' };

/** 给一个记忆引用建主表里的行（清扫会删掉主表里没有的记忆的嵌入）。 */
export function owner(core, kind, id, extra = {}) {
  const t = core.now();
  const base = {
    assertion: { predicate: 'p', text: 'x', certainty: 'stated', recorded_at: t, created_at: t, updated_at: t },
    episode: { setting_key: 'k', t_start: t, t_end: t, sealed_at: t, created_at: t },
    window: { setting_key: 'k', first_percept: 1, last_percept: 1, n_percepts: 1, t_start: t, t_end: t, text: 'x', created_at: t },
    entity: { kind: 'person', created_at: t, updated_at: t },
    impression: { entity_id: 1, layer: 'shared', text: 'x', version: 1, built_at: t },
    intention: { act: 'x', origin: 'self-care', formed_at: t, created_at: t, updated_at: t },
  }[kind];
  insertRow(core.store, OWNER_TABLE[kind], { id, ...base, ...extra });
}
