// 011 · backup：备份包登记和恢复演练记录（§12.4）。
// 这张表只是缓存：真相是备份目录里每个包自带的 manifest。整体恢复会把这张表换回旧的，
// 所以恢复后 backup 模块要重新扫一遍备份目录（见 docs/实现/模块与接口.md 的 backup 一节）。
export default {
  version: 11,
  name: 'backup',
  owner: 'backup',
  tables: ['backups', 'restore_drills'],
  up(db) {
    db.exec(`
      CREATE TABLE backups (
        id               INTEGER PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN ('daily','weekly','monthly','pre-op','manual')),
        reason           TEXT,                       -- pre-op 的原因：migrate / restore / reembed-switch / withdraw / purge / retention
        location         TEXT NOT NULL CHECK (location IN ('local','offsite')),
        path             TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        size             INTEGER,
        sha256           TEXT,
        schema_version   INTEGER,
        includes_vectors INTEGER NOT NULL DEFAULT 0,
        encrypted        INTEGER NOT NULL DEFAULT 0,
        manifest_json    TEXT,
        verify_status    TEXT NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','ok','failed')),
        verified_at      INTEGER,
        deleted_at       INTEGER
      ) STRICT;
      CREATE INDEX backups_kind ON backups(kind, created_at) WHERE deleted_at IS NULL;

      -- 每周恢复演练（§12.4.4）
      CREATE TABLE restore_drills (
        id        INTEGER PRIMARY KEY,
        at        INTEGER NOT NULL,
        backup_id INTEGER,
        status    TEXT NOT NULL CHECK (status IN ('ok','failed')),
        sampled   INTEGER NOT NULL DEFAULT 0,
        found     INTEGER NOT NULL DEFAULT 0,
        error     TEXT                               -- 只记错误类型
      ) STRICT;
    `);
  },
};
