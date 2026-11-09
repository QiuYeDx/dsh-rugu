// 崩溃安全的三条不变式（§12.8，评审:FE-16）和启动时的结构自检。
//
//   1. 适配器的读取游标只和对应的感知在**同一个事务**里推进：要么都写进去，要么都没写。
//      → intake 写感知时用 withCursor()（或者在自己的 tx 里调 setCursor）。
//   2. 切分缓冲不在内存里单独保存，它就是「episode_id 还是空的感知」，启动时从库里重建。
//      → 读缓冲一律用 SEGMENT_BUFFER_SQL / openBufferSettings()，不在内存里另存一份「待切分列表」。
//   3. 一批提炼的全部输出（情节、事实、来源、规范、意图、实体变化）在**一个事务**里写入，用 job_id 去重；
//      LLM 结果还没提交就崩了，重跑时幂等。
//      → 用 jobs.completeJob(store, jobId, write)。
//   另外：向量库是缓存，每次启动和每次恢复备份后清扫一次（vectors.sweepVectorCache），不依赖 ATTACH。
import { setCursor } from './kv.js';

/** 某个场合的切分缓冲（不变式 2）：这个场合里还没归进情节的感知，按序号。 */
export const SEGMENT_BUFFER_SQL = 'SELECT * FROM percepts WHERE setting_key = ? AND episode_id IS NULL ORDER BY id';

/** 有未封口缓冲的场合（启动时据此重建全部缓冲）。 */
export function openBufferSettings(store) {
  return store.all('SELECT setting_key, COUNT(*) AS n, MIN(id) AS first_id, MAX(id) AS last_id, MAX(at) AS last_at FROM percepts WHERE episode_id IS NULL GROUP BY setting_key');
}

/**
 * 不变式 1：fn 的写入和游标推进在同一个事务里。fn 必须同步。
 * @template T
 * @param {import('./db.js').Store} store
 * @param {{source: string, key: string, value: string}|null|undefined} cursor
 * @param {(db: import('./db.js').Store) => T} fn
 * @returns {T}
 */
export function withCursor(store, cursor, fn) {
  return store.tx((db) => {
    const r = fn(db);
    if (cursor) setCursor(db, cursor.source, cursor.key, cursor.value);
    return r;
  });
}

/**
 * 结构自检（§13.2「库版本不比代码新」之外的一项）：迁移声明的表都在。
 * @param {import('./db.js').Store} store
 * @param {readonly import('./migrate.js').Migration[]} migrations
 * @returns {{ok: boolean, missing: string[]}}
 */
export function checkSchema(store, migrations) {
  const have = new Set(store.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((r) => r.name));
  const version = Number(store.pragma('user_version')) || 0;
  const missing = migrations.filter((m) => m.version <= version).flatMap((m) => m.tables).filter((t) => !have.has(t));
  return { ok: missing.length === 0, missing };
}
