// 010 · admin：审核队列、规则、隐藏 / 忘掉、墓碑、「需要你知道」（§9.3.7、§12.7、§13.1）。
const OWNER_KINDS = "'percept','window','episode','assertion','entity','impression','intention','storyline','community','link'";

export default {
  version: 10,
  name: 'admin',
  owner: 'admin',
  tables: ['review_queue', 'rules', 'suppressions', 'tombstones', 'need_to_know'],
  up(db) {
    db.exec(`
      -- 审核队列：只放低把握的、或主人想管的。kind：
      --   forget_request 忘掉请求 / owner_op 未授权的主人操作 / merge 低把握的合并 / growth 成长（逐条批准方式）/
      --   held_utterance 挂起的发言 / norm_change 规范变更 / setting_rule_relax 场合规矩放宽 / withdraw 按来源撤回
      -- 挂起的发言 14 天没处理 → expired（不发）；merge 永远不自动判成 not_same。
      -- withdrawn：问题已经由别处回答了（双向自认 / 平台 / 主人已经定了是不是同一个、那一版规矩已不在等审核、记忆已彻底删除），不执行任何决定
      CREATE TABLE review_queue (
        id           INTEGER PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('forget_request','owner_op','merge','growth','held_utterance','norm_change','setting_rule_relax','withdraw')),
        payload_json TEXT NOT NULL DEFAULT '{}',     -- 只放引用和结构化字段；挂起的原文在 utterances.held_text
        reason       TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','withdrawn')),
        created_at   INTEGER NOT NULL,
        decided_at   INTEGER,
        decided_by   TEXT,
        expires_at   INTEGER
      ) STRICT;
      CREATE INDEX review_queue_status ON review_queue(status, kind, created_at);

      -- 规则：do_not_remember「别记」/ disclosure 主人的披露规则 / mode 按场合的 off / shadow / live。
      -- 目标是实体、信息类型或场合（场合键）、场合属性，不是入口名（§2.2）
      CREATE TABLE rules (
        id          INTEGER PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('do_not_remember','disclosure','mode')),
        target_json TEXT NOT NULL,
        value_json  TEXT,
        created_by  TEXT NOT NULL,                   -- owner / subject:<实体 id> / tool
        at          INTEGER NOT NULL,
        revoked_at  INTEGER,
        note        TEXT
      ) STRICT;
      CREATE INDEX rules_kind ON rules(kind) WHERE revoked_at IS NULL;

      -- 隐藏和忘掉（§12.7）：对别人隐藏，主人和审核视图仍可见；forgotten 30 天内可恢复。没有行 = 正常。
      -- 设计 §12.2 的 assertions.status（active / hidden / forgotten）在这里统一表示，适用于所有记忆单元
      CREATE TABLE suppressions (
        owner_kind    TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id      INTEGER NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('hidden','forgotten')),
        by            TEXT NOT NULL,
        reason        TEXT,
        at            INTEGER NOT NULL,
        restore_until INTEGER,
        rule_id       INTEGER,
        PRIMARY KEY (owner_kind, owner_id)
      ) STRICT, WITHOUT ROWID;

      -- 墓碑：被彻底删除的东西。恢复备份后、每次启动时再清一遍（§12.4.5、§12.7）。
      -- ref 是记忆引用或身份哈希这类不含原文的值
      CREATE TABLE tombstones (
        id   INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        ref  TEXT NOT NULL,
        at   INTEGER NOT NULL,
        UNIQUE (kind, ref)
      ) STRICT;

      -- 「需要你知道」（§9.3.7）：T1 想改变她的东西 / T2 伤害、违法、安全 / taint 被污染 / poison 疑似投毒 /
      -- foreign_write 准备写进规矩、意图或成长块而来源不是管理者的内容
      CREATE TABLE need_to_know (
        id               INTEGER PRIMARY KEY,
        kind             TEXT NOT NULL CHECK (kind IN ('T1','T2','taint','poison','foreign_write')),
        owner_kind       TEXT,
        owner_id         INTEGER,
        percept_id       INTEGER,
        source_entity_id INTEGER,
        reason           TEXT NOT NULL,
        severity         INTEGER NOT NULL DEFAULT 1, -- T2 严重的主动列出
        status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','read','withdrawn')),
        created_at       INTEGER NOT NULL,
        read_at          INTEGER
      ) STRICT;
      CREATE INDEX need_to_know_status ON need_to_know(status, created_at);
    `);
  },
};
