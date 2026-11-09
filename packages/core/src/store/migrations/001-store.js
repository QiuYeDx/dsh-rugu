// 001 · store 自己的公共表：元数据、任务、游标、计数、提示词版本、FTS 分表登记。
// 迁移文件按「表归哪个模块」拆分（docs/实现/模块与接口.md §2）。beta 第一次真实安装之前，
// 模块实现者可以直接改自己那份迁移；装上之后迁移只追加新编号，不再改旧文件（§12.5）。
import crypto from 'node:crypto';

export default {
  version: 1,
  name: 'store',
  owner: 'store',
  tables: ['meta', 'jobs', 'cursors', 'metrics', 'prompt_versions', 'fts_shards'],
  up(db) {
    db.exec(`
      -- 键值元数据：schema_version、db_id、上次夜间整理时间、保留期待生效的改动……键名按模块加前缀（'sleep.lastAt'）
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      ) STRICT;

      -- 后台任务（提炼、夜间整理、导入、嵌入补跑……）和用量。last_error 只记错误类型和 id，不记内容（§12.3）
      CREATE TABLE jobs (
        id            INTEGER PRIMARY KEY,
        kind          TEXT NOT NULL,                 -- extract / sleep / import / reembed / ...
        use           TEXT,                          -- LLM 用途标签（§10.6）：extract / appraise / review / rewrite / sleep / summary
        priority      INTEGER NOT NULL DEFAULT 0,    -- 大的先跑
        dedupe_key    TEXT UNIQUE,                   -- 同一件事只排一次；重跑幂等（§12.8 第 3 条）
        scope_key     TEXT,                          -- 通常是场合键
        ep_from       INTEGER,                       -- 提炼批次覆盖的感知 id 范围
        ep_to         INTEGER,
        payload_json  TEXT NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        run_after     INTEGER NOT NULL DEFAULT 0,
        model         TEXT,
        tokens_in     INTEGER NOT NULL DEFAULT 0,    -- 未命中缓存的输入
        tokens_cached INTEGER NOT NULL DEFAULT 0,
        tokens_out    INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        done_at       INTEGER
      ) STRICT;
      CREATE INDEX jobs_runnable ON jobs(status, priority DESC, run_after);
      CREATE INDEX jobs_kind ON jobs(kind, status);

      -- 读取游标和导入水位。适配器游标和对应的感知在同一个事务里推进（§12.8 第 1 条）
      CREATE TABLE cursors (
        source     TEXT NOT NULL,                    -- 'adapter:<id>'、'import:<来源>' ……
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source, key)
      ) STRICT, WITHOUT ROWID;

      -- 诊断区的计数（§13.3），只有数字，没有内容
      CREATE TABLE metrics (
        day   TEXT NOT NULL,                         -- UTC 'YYYY-MM-DD'
        name  TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, name)
      ) STRICT, WITHOUT ROWID;

      -- 提示词版本（§8.9）：评测回放时可以钉住版本
      CREATE TABLE prompt_versions (
        use        TEXT NOT NULL,
        version    TEXT NOT NULL,
        hash       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (use, version)
      ) STRICT, WITHOUT ROWID;

      -- 原文 FTS 按月分表（评审:FE-01）：percepts_fts_YYYYMM，由 store/fts.js 按需创建并登记在这里
      CREATE TABLE fts_shards (
        name       TEXT PRIMARY KEY,
        month      TEXT NOT NULL UNIQUE,             -- 'YYYYMM'（UTC）
        created_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
    // 这个库的身份：向量缓存库靠它认出「是不是同一个主库」（§12.8）
    db.run("INSERT INTO meta(key, value) VALUES ('db_id', ?)", crypto.randomBytes(16).toString('hex'));
  },
};
