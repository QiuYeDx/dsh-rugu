// FTS5 的帮手（§8.2、F29）。
//   - 词元由 JS（语言分析器）生成，写进无内容表（content=''）的 tokens 列，空格分隔；SQLite 只按空格切开。
//     tokenchars '_' 让实体词元 ent_<id> 保持一个整词。unicode61 不切中文，所以中文必须由分析器先切好（二元组 / jieba）。
//   - 查询一律逐词加引号再 OR（裸 AND、NOT、NEAR、x:y 会报语法错误，F29）；每次最多 12 个词（评审:FE-01），
//     词的挑选（按 IDF 排序、剔掉常见词）由 retrieve / worker 做，这里只负责把词安全地拼成 MATCH 串。
//   - 原文表按月分表：percepts_fts_YYYYMM（UTC 月），第一次写到某个月时创建并登记进 fts_shards。
//   - 改 FTS_TOKENIZE 必须配一份重建全部 FTS 表的迁移。

export const FTS_TOKENIZE = "unicode61 remove_diacritics 0 tokenchars '_'";
export const MAX_MATCH_TERMS = 12;
const TABLE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SHARD_PREFIX = 'percepts_fts_';

/** 实体词元：词法路用它把「提到了某个实体」也变成可检索的词。 */
export const entityToken = (entityId) => `ent_${Number(entityId)}`;

/**
 * 把一个词规范化成 FTS 里存的样子：NFKC、小写，只留字母、数字和下划线。规范化后为空返回 ''。
 * 分析器给出的词和查询的词都要过它，两边才对得上。
 */
export function normalizeToken(t) {
  return String(t ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '');
}

/** 一组词 → tokens 列的值（规范化、去空、去重，保持顺序）。 */
export function tokensValue(tokens) {
  const seen = new Set();
  const out = [];
  for (const t of tokens ?? []) {
    const n = normalizeToken(t);
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.join(' ');
}

/**
 * 一组查询词 → 安全的 MATCH 串：'"a" OR "b"'。最多 max 个（超出的丢掉，调用方应先按 IDF 排好序）。
 * 没有可用的词返回 null（调用方跳过词法路，别拿空串去查）。
 */
export function matchQuery(terms, max = MAX_MATCH_TERMS) {
  const seen = new Set();
  const out = [];
  for (const t of terms ?? []) {
    const n = normalizeToken(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(`"${n.replaceAll('"', '""')}"`);
    if (out.length >= max) break;
  }
  return out.length ? out.join(' OR ') : null;
}

/**
 * 一组词 → 「全都要有」的 MATCH 串：'"a" AND "b"'（D114，管理页搜索：先找词全在的，OR 只作最后的退路）。
 * 每个词照样加引号（F29）；最多 max 个。没有可用的词返回 null。
 */
export function matchQueryAll(terms, max = 32) {
  const q = matchQuery(terms, max);
  return q ? q.split(' OR ').join(' AND ') : null;
}

function assertTable(name) {
  if (!TABLE_RE.test(name)) throw new Error(`不合法的 FTS 表名：${name}`);
  return name;
}

/** UTC 月份 'YYYYMM'。 */
export function monthOf(at) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** 某个时间的感知该进哪张分表。 */
export const perceptShardName = (at) => `${SHARD_PREFIX}${monthOf(at)}`;

/**
 * 确保某个月的原文分表存在（不存在就建并登记）。可以在调用方的事务里调用。
 * @param {import('./db.js').Store} store
 * @param {number} at
 * @returns {string} 表名
 */
export function ensurePerceptShard(store, at) {
  const month = monthOf(at);
  const name = `${SHARD_PREFIX}${month}`;
  const known = store.get('SELECT name FROM fts_shards WHERE month = ?', month);
  if (known) return known.name;
  store.tx((db) => {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${assertTable(name)} USING fts5(tokens, content='', contentless_delete=1, tokenize="${FTS_TOKENIZE}")`);
    db.run('INSERT OR IGNORE INTO fts_shards(name, month, created_at) VALUES (?, ?, ?)', name, month, db.now());
  });
  return name;
}

/**
 * 已有的原文分表，新的在前。months 给了就只要最近几个月（热路径只查最近 3 个月，§8.2）。
 * @returns {string[]}
 */
export function listPerceptShards(store, { months } = {}) {
  const rows = store.all('SELECT name FROM fts_shards ORDER BY month DESC');
  const names = rows.map((r) => r.name);
  return months ? names.slice(0, months) : names;
}

/** 写一行词元。table 是 FTS 表名（分表名、episodes_fts、assertions_fts），rowid = 主表 id。 */
export function ftsInsert(store, table, rowid, tokens) {
  const value = Array.isArray(tokens) ? tokensValue(tokens) : tokensValue(String(tokens ?? '').split(/\s+/));
  store.run(`INSERT INTO ${assertTable(table)}(rowid, tokens) VALUES (?, ?)`, rowid, value);
}

/** 删一行词元（无内容表靠 contentless_delete=1 支持按 rowid 删除）。 */
export function ftsDelete(store, table, rowid) {
  store.run(`DELETE FROM ${assertTable(table)} WHERE rowid = ?`, rowid);
}

/** 替换一行词元（先删后插）。 */
export function ftsReplace(store, table, rowid, tokens) {
  store.tx((db) => { ftsDelete(db, table, rowid); ftsInsert(db, table, rowid, tokens); });
}

/**
 * 在一张 FTS 表里查（主线程只在测试和管理页用；热路径在 worker 里用只读连接查，§8.2）。
 * @returns {{rowid: number, score: number}[]} score 越小越相关（bm25）
 */
export function ftsSearch(store, table, terms, { limit = 50 } = {}) {
  const q = matchQuery(terms);
  if (!q) return [];
  return store.all(`SELECT rowid, bm25(${assertTable(table)}) AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY score LIMIT ?`, q, limit);
}
