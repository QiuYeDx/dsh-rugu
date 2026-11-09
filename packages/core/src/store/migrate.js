// 迁移执行器（§12.5，沿用 v1:370-374）：
//   - 迁移文件按编号前进，启动时在**一个事务**里依次执行；任何一个失败，整体回滚，库停在原来的版本。
//   - 执行前自动备份：已有数据的库（版本 > 0）先调 backup 钩子做一份「操作前快照」；钩子失败就不迁移。
//   - 库的版本比代码新（主人回退了插件）→ 不迁移，返回 readOnly，调用方以只读方式打开：不注入、不摄入。
//   - 版本号存在 PRAGMA user_version（和迁移在同一个事务里提交），meta.schema_version 是给人看的副本。

/**
 * @typedef {object} Migration
 * @property {number} version     从 1 开始连续编号
 * @property {string} name
 * @property {string} owner       拥有这些表的模块
 * @property {string[]} tables    这份迁移新建的表（启动自检和测试用）
 * @property {(db: import('./db.js').Store) => void} up   同步执行（在事务里）
 */
/**
 * @typedef {object} MigrationResult
 * @property {number} from
 * @property {number} to
 * @property {number[]} applied
 * @property {boolean} readOnly    库比代码新
 * @property {string|null} backup  迁移前快照的位置（没做就是 null）
 */

/** 检查迁移列表：编号从 1 开始、连续、递增，up 是函数。 */
export function checkMigrations(migrations) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`迁移编号不连续：第 ${i + 1} 个是 ${m.version}`);
    if (typeof m.up !== 'function') throw new Error(`迁移 ${m.version} 没有 up()`);
    if (!m.owner || !Array.isArray(m.tables)) throw new Error(`迁移 ${m.version} 缺 owner / tables`);
  });
}

/** 库当前的 schema 版本。 */
export const schemaVersionOf = (store) => Number(store.pragma('user_version')) || 0;

/**
 * 把库迁到 target（默认最新）。
 * @param {import('./db.js').Store} store
 * @param {readonly Migration[]} migrations
 * @param {{backup?: (info: {reason: 'migrate', from: number, to: number}) => Promise<string|null>|string|null,
 *          target?: number}} [opt]
 * @returns {Promise<MigrationResult>}
 */
export async function migrate(store, migrations, opt = {}) {
  checkMigrations(migrations);
  const latest = opt.target ?? migrations.at(-1)?.version ?? 0;
  const from = schemaVersionOf(store);
  if (from > (migrations.at(-1)?.version ?? 0)) return { from, to: from, applied: [], readOnly: true, backup: null };
  const pending = migrations.filter((m) => m.version > from && m.version <= latest);
  if (!pending.length) return { from, to: from, applied: [], readOnly: false, backup: null };

  let backup = null;
  if (from > 0 && opt.backup) {
    // 备份失败就不迁移：宁可这次不升级，也不冒险改一份没有备份的库
    backup = (await opt.backup({ reason: 'migrate', from, to: latest })) ?? null;
  }
  const at = store.now();
  store.tx((db) => {
    for (const m of pending) {
      m.up(db);
      db.exec(`PRAGMA user_version = ${Number(m.version)}`);
    }
    db.run("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(latest));
    db.run("INSERT INTO meta(key, value) VALUES ('migrated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(at));
  });
  return { from, to: latest, applied: pending.map((m) => m.version), readOnly: false, backup };
}
