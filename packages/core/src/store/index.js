// store 模块：node:sqlite 存储、迁移、崩溃安全、公共表（§12）。
// 业务表的 schema 也在这里（migrations/），但每张表的**数据**归一个模块：只有拥有者写，别的模块调拥有者的写函数
// （TABLE_OWNERS，docs/实现/模块与接口.md §2）。读可以直接 SQL。
import path from 'node:path';
import { openDatabase } from './db.js';
import { migrate, schemaVersionOf } from './migrate.js';
import { MIGRATIONS, SCHEMA_VERSION } from './migrations/index.js';

export { Store, StoreLockedError, openDatabase, DEFAULT_SLOW_MS } from './db.js';
export { migrate, checkMigrations, schemaVersionOf } from './migrate.js';
export { MIGRATIONS, SCHEMA_VERSION, TABLE_OWNERS } from './migrations/index.js';
export * from './fts.js';
export * from './refs.js';
export * from './kv.js';
export * from './jobs.js';
export * from './expire.js';
export * from './keys.js';
export * from './invariants.js';
export { openVectorStore, sweepVectorCache, mainDbIdOf, VECTORS_SCHEMA_VERSION } from './vectors.js';

export const MAIN_DB_FILE = 'persona-memory.db';
export const VECTORS_DB_FILE = 'persona-vectors.db';

/**
 * 打开主库并迁到最新（§10.1 第 1 步）。
 *   - 迁移前自动备份：backup 钩子（通常是 backup.preOperationSnapshot）；钩子失败就不迁移，抛错。
 *   - 库比代码新：以只读方式重新打开，store.readOnly = true，readOnlyReason = 'newer-schema'（§12.5）。
 *   - verify（可选）：打开之后、迁移之前调；抛错就关库、原样抛出，什么都不迁移（api 用它核对身份哈希密钥，D140）。
 * @param {{file: string, clock?: object, logger?: object, slowMs?: number, busyTimeoutMs?: number, readOnly?: boolean,
 *          migrations?: readonly import('./migrate.js').Migration[], verify?: (store: import('./db.js').Store) => void,
 *          backup?: (info: {reason: 'migrate', from: number, to: number, file: string, store: import('./db.js').Store}) => Promise<string|null>|string|null}} opt
 * @returns {Promise<import('./db.js').Store>}
 */
export async function openStore(opt) {
  const migrations = opt.migrations ?? MIGRATIONS;
  const base = { file: opt.file, clock: opt.clock, logger: opt.logger, slowMs: opt.slowMs, busyTimeoutMs: opt.busyTimeoutMs };
  if (opt.readOnly) {
    const ro = openDatabase({ ...base, readOnly: true });
    try { opt.verify?.(ro); } catch (e) { ro.close(); throw e; }
    ro.migration = { from: schemaVersionOf(ro), to: schemaVersionOf(ro), applied: [], readOnly: true, backup: null };
    return ro;
  }
  const store = openDatabase(base);
  let result;
  try {
    opt.verify?.(store);   // 迁移之前：核对不过就原样关上，库不动（D140 的身份密钥核对）
    result = await migrate(store, migrations, { backup: opt.backup ? (info) => opt.backup({ ...info, file: opt.file, store }) : undefined });
  } catch (e) {
    store.close();
    throw e;
  }
  if (!result.readOnly) { store.migration = result; return store; }
  // 库比代码新：换成真正的只读连接，SQLite 自己也会拒绝写入
  store.close();
  const ro = openDatabase({ ...base, readOnly: true });
  ro.readOnlyReason = 'newer-schema';
  ro.migration = result;
  return ro;
}

/** 主库和向量库在数据目录里的路径。 */
export function dataFiles(dataDir) {
  return { main: path.join(dataDir, MAIN_DB_FILE), vectors: path.join(dataDir, VECTORS_DB_FILE) };
}

/** 代码支持的 schema 版本（别名，给自检用）。 */
export const CODE_SCHEMA_VERSION = SCHEMA_VERSION;
