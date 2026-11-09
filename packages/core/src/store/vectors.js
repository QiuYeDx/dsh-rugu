// 向量库 persona-vectors.db：**纯缓存**（§12.1、评审:FE-12）。
//   - 只放向量和二值索引，丢了可以按主库的 embed_texts 重建；不备份（周包、月包可选带上，省掉重嵌的降级期）。
//   - 不做迁移：版本不对、或者不是同一个主库的缓存（meta.main_db_id 对不上），整个清空重来。
//   - 不用 ATTACH 和主库放进一个事务（WAL 下跨文件事务不是原子的），一致性靠启动时和恢复后的清扫（§12.8）。
//   - 写者是主线程的嵌入队列（worker 模块的 runEmbedQueue）；worker 线程用只读连接冷加载。
import { openDatabase } from './db.js';
import { getMeta } from './kv.js';

// 版本 2：f32 挪到最后（冷加载只读 q8 / bin，不用穿过 4 KB 的 f32 溢出页）；加 vectors_etid（清扫按 embed_text_id 分页）
export const VECTORS_SCHEMA_VERSION = 2;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vmeta (
    key   TEXT PRIMARY KEY,
    value TEXT
  ) STRICT;
  -- 一行 = 某个空间里的一个文本块（embed_texts 的一行）。
  -- 记忆层存 f32 + int8 + 二值；原文层存 int8 + 二值（f32 为 NULL，§8.7）。大的 f32 放最后
  CREATE TABLE IF NOT EXISTS vectors (
    space_id      TEXT NOT NULL,
    embed_text_id INTEGER NOT NULL,
    owner_kind    TEXT NOT NULL,
    owner_id      INTEGER NOT NULL,
    chunk_no      INTEGER NOT NULL,
    kind          TEXT NOT NULL,                 -- text / fq
    layer         TEXT NOT NULL CHECK (layer IN ('memory','raw')),
    text_hash     TEXT NOT NULL,                 -- 嵌入时 embed_texts.hash；对不上 = 过期
    q8            BLOB NOT NULL,
    q8_scale      REAL NOT NULL,
    bin           BLOB NOT NULL,
    created_at    INTEGER NOT NULL,
    f32           BLOB,
    PRIMARY KEY (space_id, embed_text_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS vectors_owner ON vectors(owner_kind, owner_id);
  CREATE INDEX IF NOT EXISTS vectors_layer ON vectors(space_id, layer);
  -- 按 embed_text_id 找（清扫分页、按嵌入文本删）：主键是 (space_id, embed_text_id)，单按 embed_text_id 用不上它
  CREATE INDEX IF NOT EXISTS vectors_etid ON vectors(embed_text_id);
`;

/**
 * 打开（或重建）向量缓存库。
 * @param {{file: string, mainDbId: string, readOnly?: boolean, clock?: object, logger?: object, slowMs?: number}} opt
 * @returns {import('./db.js').Store & {wiped?: string|null}}
 */
export function openVectorStore(opt) {
  const store = openDatabase({ file: opt.file, readOnly: opt.readOnly, clock: opt.clock, logger: opt.logger, slowMs: opt.slowMs });
  /** @type {any} */ (store).wiped = null;
  if (opt.readOnly) return store;
  const version = Number(store.pragma('user_version')) || 0;
  let mainId = null;
  if (version > 0) { try { mainId = store.get("SELECT value FROM vmeta WHERE key = 'main_db_id'")?.value ?? null; } catch { mainId = null; } }
  const reason = version === 0 ? null
    : version !== VECTORS_SCHEMA_VERSION ? 'schema-version'
      : mainId !== opt.mainDbId ? 'other-main-db' : null;
  if (reason || version === 0) {
    store.tx((db) => {
      if (reason) {
        db.exec('DROP TABLE IF EXISTS vectors');
        db.exec('DROP TABLE IF EXISTS vmeta');
      }
      db.exec(SCHEMA);
      db.run("INSERT INTO vmeta(key, value) VALUES ('main_db_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", opt.mainDbId);
      db.exec(`PRAGMA user_version = ${VECTORS_SCHEMA_VERSION}`);
    });
    /** @type {any} */ (store).wiped = reason;
  }
  return store;
}

/** 主库的 db_id（向量库靠它认主库）。 */
export const mainDbIdOf = (main) => getMeta(main, 'db_id');

/**
 * 清扫向量缓存（§12.8）：删掉主库里已经没有、或者文本已经变了的块；
 * 主库标 done、向量库里却没有的块改回 pending，让嵌入队列补上。
 * 分批做，每批一个小事务，可以中断、可以重跑。
 * @param {import('./db.js').Store} main
 * @param {import('./db.js').Store} vec
 * @param {{batch?: number, activeSpaceId?: string|null}} [opt]
 * @returns {{removed: number, requeued: number}}
 */
export function sweepVectorCache(main, vec, { batch = 2000, activeSpaceId = null } = {}) {
  let removed = 0;
  let requeued = 0;
  let after = -1;
  for (;;) {
    const rows = vec.all('SELECT DISTINCT embed_text_id AS id FROM vectors WHERE embed_text_id > ? ORDER BY embed_text_id LIMIT ?', after, batch);
    if (!rows.length) break;
    after = rows.at(-1).id;
    const ids = rows.map((r) => r.id);
    const live = new Map(main.all(`SELECT id, hash FROM embed_texts WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
      .map((r) => [r.id, r.hash]));
    const stale = vec.all(`SELECT space_id, embed_text_id, text_hash FROM vectors WHERE embed_text_id IN (${ids.map(() => '?').join(',')})`, ...ids)
      .filter((v) => live.get(v.embed_text_id) !== v.text_hash);
    if (stale.length) {
      vec.tx((db) => {
        for (const v of stale) db.run('DELETE FROM vectors WHERE space_id = ? AND embed_text_id = ?', v.space_id, v.embed_text_id);
      });
      removed += stale.length;
    }
  }
  if (activeSpaceId) {
    let from = -1;
    for (;;) {
      const done = main.all("SELECT id FROM embed_texts WHERE status = 'done' AND space_id = ? AND id > ? ORDER BY id LIMIT ?", activeSpaceId, from, batch);
      if (!done.length) break;
      from = done.at(-1).id;
      const ids = done.map((r) => r.id);
      const have = new Set(vec.all(`SELECT embed_text_id AS id FROM vectors WHERE space_id = ? AND embed_text_id IN (${ids.map(() => '?').join(',')})`, activeSpaceId, ...ids).map((r) => r.id));
      const missing = ids.filter((x) => !have.has(x));
      if (missing.length) {
        main.tx((db) => {
          for (const x of missing) db.run("UPDATE embed_texts SET status = 'pending', updated_at = ? WHERE id = ?", db.now(), x);
        });
        requeued += missing.length;
      }
    }
  }
  return { removed, requeued };
}
