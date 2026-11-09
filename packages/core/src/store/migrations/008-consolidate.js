// 008 · consolidate：场合故事线、实体社区和主题摘要、成长块及其版本（§5.7、§5.8、§7.7）。
// 夜间整理产出的情节（日记、lapse、今天到目前为止）和事实（泛化、反思）照常写进 episodes / assertions，
// 通过 encode 的写函数，不在这里。
export default {
  version: 8,
  name: 'consolidate',
  owner: 'consolidate',
  tables: ['storylines', 'communities', 'core_blocks', 'core_block_versions'],
  up(db) {
    db.exec(`
      -- 每个稳定场合一条故事线（参照 Graphiti 的 Saga）：增量摘要 + 水位线。带规范的记忆单元（owner_kind='storyline'）
      CREATE TABLE storylines (
        id                INTEGER PRIMARY KEY,
        setting_key       TEXT NOT NULL UNIQUE,
        text              TEXT NOT NULL DEFAULT '',
        version           INTEGER NOT NULL DEFAULT 0,
        watermark_percept INTEGER,                   -- 摘要覆盖到哪条感知
        updated_at        INTEGER
      ) STRICT;

      -- 实体社区和主题摘要（§7.7 第 7 步），回答「最近大家在聊什么」。带规范（owner_kind='community'）
      CREATE TABLE communities (
        id           INTEGER PRIMARY KEY,
        setting_key  TEXT,
        label        TEXT NOT NULL DEFAULT '',
        summary      TEXT NOT NULL,
        members_json TEXT NOT NULL DEFAULT '[]',     -- 实体 id
        built_at     INTEGER NOT NULL,
        is_current   INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE INDEX communities_setting ON communities(setting_key, is_current);

      -- 成长块（§5.7）。默认自动生效：每次变化存一个版本；pending_text 只在「逐条批准」方式下用
      CREATE TABLE core_blocks (
        name         TEXT PRIMARY KEY,               -- 'growth'
        text         TEXT NOT NULL DEFAULT '',
        version      INTEGER NOT NULL DEFAULT 0,
        char_limit   INTEGER NOT NULL,
        updated_at   INTEGER,
        updated_by   TEXT,                           -- sleep / owner
        pending_text TEXT
      ) STRICT;

      -- 成长块的版本历史。change_json 记「这次改了什么」（规范化后的变化签名），撤销后同样的变化不会第二天又写回，
      -- 除非之后又有新的证据（evidence_ids 比较）
      CREATE TABLE core_block_versions (
        name         TEXT NOT NULL,
        version      INTEGER NOT NULL,
        text         TEXT NOT NULL,
        change_json  TEXT NOT NULL DEFAULT '{}',
        evidence_ids TEXT NOT NULL DEFAULT '[]',     -- 依据的经历（记忆引用）
        created_at   INTEGER NOT NULL,
        created_by   TEXT NOT NULL,
        revoked_at   INTEGER,
        revoked_by   TEXT,
        PRIMARY KEY (name, version)
      ) STRICT, WITHOUT ROWID;
    `);
  },
};
