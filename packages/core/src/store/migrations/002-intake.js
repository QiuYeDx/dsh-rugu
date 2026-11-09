// 002 · intake：场合、场合快照、原始感知、原文窗口、转达预告。
// 感知只追加（§5.1）；原文过了保留期只清 text，不删行（§12.6）。
// 原文的 FTS 按月分表，不在这里建（store/fts.js 的 ensurePerceptShard），表名登记在 fts_shards。
export default {
  version: 2,
  name: 'intake',
  owner: 'intake',
  tables: ['settings', 'setting_snapshots', 'percepts', 'raw_windows', 'relays'],
  up(db) {
    db.exec(`
      -- 场合。key = HMAC(adapter, SettingId)，只有 label 可读（评审:AR-04）。
      -- 「别记这里」和按场合的影子 / 正式开关都在 rules 表里（admin），这里不存。
      -- 场合规矩的当前版本 = MAX(setting_rules.version)（discretion），这里也不重复存。
      CREATE TABLE settings (
        key                 TEXT PRIMARY KEY,
        adapter             TEXT NOT NULL,
        label               TEXT NOT NULL DEFAULT '',
        stability           TEXT NOT NULL CHECK (stability IN ('persistent','transient')),
        parent_key          TEXT,                     -- 描述里的 parent（评论串 ⊂ 评论区）
        entity_id           INTEGER,                  -- kind=setting 的实体（只有 persistent 的场合才有，§5.8）
        current_snapshot_id INTEGER,
        checkpoint_percept  INTEGER,                  -- sealBuffers() 记的检查点：压缩开始时这个场合最新的感知 id（§7.2）
        attending           INTEGER NOT NULL DEFAULT 1, -- 当前描述的 attending（0 = 她不在这个房间里，之后这里的感知丢弃）
        first_seen          INTEGER NOT NULL,
        last_seen           INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX settings_parent ON settings(parent_key) WHERE parent_key IS NOT NULL;

      -- 场合属性的历史快照（场合属性会变，来源指向当时的快照）。
      -- descriptor_json 是校验后的描述，里面的账号 id 已经换成哈希。
      CREATE TABLE setting_snapshots (
        id               INTEGER PRIMARY KEY,
        setting_key      TEXT NOT NULL,
        at               INTEGER NOT NULL,
        descriptor_json  TEXT NOT NULL,
        descriptor_hash  TEXT NOT NULL,              -- 描述没变就不新建快照
        reach_hash       TEXT NOT NULL,              -- contract.reachHash()：可见范围的指纹
        exposure_rank    INTEGER NOT NULL,           -- contract.exposureRank()：0 一对一 … 3 任何人可见
        persistence_rank INTEGER NOT NULL,           -- contract.persistenceRank()：0 不留存 … 2 公开留存
        audience_size    INTEGER                     -- 人数已知时
      ) STRICT;
      CREATE INDEX setting_snapshots_setting ON setting_snapshots(setting_key, at);

      -- 原始感知，只追加（§5.3）。id 就是序号：FTS 的 rowid、预取缓存键（场合 + 最新感知 id，§8.1）。
      -- ext_key = HMAC(adapter, ObsId)；target_key / reply_to_key 同样是 HMAC。
      -- actor_json 是校验后的 ActorRef，账号 id 换成了哈希；actor_entity_id 是确定性认出的说话人（§7.1 第 5 步）。
      CREATE TABLE percepts (
        id               INTEGER PRIMARY KEY,
        adapter          TEXT NOT NULL,
        ext_key          TEXT NOT NULL,
        setting_key      TEXT NOT NULL,              -- 事情发生的场合
        snapshot_id      INTEGER,                    -- 当时那个场合的快照
        perceived_in     TEXT NOT NULL,              -- 她在哪个场合知道的（场合键）
        presence_set_id  INTEGER,                    -- 出现集合（discretion.recordPresence）
        visible_to       TEXT NOT NULL CHECK (visible_to IN ('setting-audience','her-only','participants')),
        at               INTEGER NOT NULL,
        perceived_at     INTEGER NOT NULL,
        actor_entity_id  INTEGER,
        actor_self       INTEGER NOT NULL DEFAULT 0,
        actor_json       TEXT NOT NULL,
        kind             TEXT NOT NULL CHECK (kind IN ('utterance','action','presence','content','self-utterance','self-action',
                           'self-thought','on-my-behalf','reminder','internal-notice','retract','edit')),
        target_key       TEXT,
        target_id        INTEGER,                    -- 认得出时：被撤回 / 编辑的那条感知
        text             TEXT,                       -- 过了保留期置 NULL（text_state='expired'）
        text_state       TEXT NOT NULL DEFAULT 'normal' CHECK (text_state IN ('normal','edited','retracted','expired')),
        text_truncated   INTEGER NOT NULL DEFAULT 0,
        text_hash        TEXT NOT NULL,              -- contract.textHash(text)
        lang             TEXT,
        media_json       TEXT,
        quote_json       TEXT,
        reply_to_key     TEXT,
        mentions_json    TEXT,
        addressed        TEXT NOT NULL CHECK (addressed IN ('to-her','mentions-her','ambient','by-her')),
        attention        TEXT NOT NULL CHECK (attention IN ('attended','peripheral')),
        attention_class  TEXT NOT NULL,              -- §6.2 的注意力类别（dynamics.attentionClass）
        evidential       INTEGER NOT NULL,
        forwarded_json   TEXT,
        derived_from_json TEXT,
        via_json         TEXT,
        relay_of         INTEGER,                    -- 从别的入口转进来的同一件事：指向原感知（mode relayed，§7.1 第 4 步）
        derived_key      TEXT,                       -- derivedFrom 指向的原消息：HMAC(原适配器, ObsId)；原消息后到时据此补上 relay_of
        w_enc            REAL NOT NULL DEFAULT 0,    -- 入库时的编码强度（还不知道重要度，按 imp=5 算）
        standing         TEXT NOT NULL CHECK (standing IN ('first-hand','platform','material')),
        session_ref_json TEXT,
        appraisal_token  TEXT,
        historical       INTEGER NOT NULL DEFAULT 0,
        episode_id       INTEGER,                    -- NULL = 还在切分缓冲里（§12.8 第 2 条）；由 encode 调 intake.assignEpisode 写
        window_id        INTEGER,                    -- 最后一个包含它的原文窗口（0 = 不会再进窗口：原文已到期）
        norm_state       TEXT NOT NULL DEFAULT 'unassessed' CHECK (norm_state IN ('unassessed','assessed')),
        fts_shard        TEXT,                       -- 词元在哪张 percepts_fts_YYYYMM 里
        created_at       INTEGER NOT NULL,
        UNIQUE (adapter, ext_key)
      ) STRICT;
      CREATE INDEX percepts_setting ON percepts(setting_key, id);
      CREATE INDEX percepts_buffer ON percepts(setting_key, id) WHERE episode_id IS NULL;
      CREATE INDEX percepts_actor ON percepts(actor_entity_id, at);
      CREATE INDEX percepts_at ON percepts(at);
      CREATE INDEX percepts_target ON percepts(adapter, target_key) WHERE target_key IS NOT NULL;
      CREATE INDEX percepts_text_hash ON percepts(text_hash, at);
      CREATE INDEX percepts_token ON percepts(appraisal_token) WHERE appraisal_token IS NOT NULL;
      CREATE INDEX percepts_episode ON percepts(episode_id) WHERE episode_id IS NOT NULL;
      CREATE INDEX percepts_derived ON percepts(derived_key) WHERE derived_key IS NOT NULL;
      -- 还没切进原文窗口的感知（只有会进窗口的几种，intake/windows.js 的 WINDOW_KINDS）
      CREATE INDEX percepts_unwindowed ON percepts(setting_key, visible_to, id)
        WHERE window_id IS NULL AND kind IN ('utterance','action','content','self-utterance','self-action','self-thought','on-my-behalf','edit');

      -- 原文窗口（§5.1、§7.1 第 8 步）：同一场合连续 5–8 条原话，≤ 400 字，带说话人和绝对时间，入库就送嵌入。
      -- 按（场合，visible_to）分开切：她心里想的、私下读到的不和当众的话混在一个窗口里（窗口的规范取成员里最严的，D10）。
      -- 成员以 members_json 为准（相邻窗口重叠 2 条；同一段 id 里别的种类、别的 visible_to 的感知不是成员）。
      CREATE TABLE raw_windows (
        id            INTEGER PRIMARY KEY,
        setting_key   TEXT NOT NULL,
        visible_to    TEXT NOT NULL DEFAULT 'setting-audience' CHECK (visible_to IN ('setting-audience','her-only','participants')),
        members_json  TEXT NOT NULL DEFAULT '[]',   -- 成员感知 id，按 id 升序
        first_percept INTEGER NOT NULL,
        last_percept  INTEGER NOT NULL,
        n_percepts    INTEGER NOT NULL,
        t_start       INTEGER NOT NULL,
        t_end         INTEGER NOT NULL,
        text          TEXT,                          -- 过了保留期置 NULL
        created_at    INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX raw_windows_setting ON raw_windows(setting_key, last_percept);
      CREATE INDEX raw_windows_group ON raw_windows(setting_key, visible_to, last_percept);
      CREATE INDEX raw_windows_t_start ON raw_windows(t_start) WHERE text IS NOT NULL;

      -- expectRelay() 的预告（§4.5）：命中的感知标 relay_of，不作为新的事实来源
      CREATE TABLE relays (
        id              INTEGER PRIMARY KEY,
        adapter         TEXT NOT NULL,
        obs_key         TEXT NOT NULL,               -- HMAC(adapter, ObsId)
        text_hash       TEXT NOT NULL,
        until           INTEGER NOT NULL,
        matched_percept INTEGER,
        created_at      INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX relays_hash ON relays(text_hash, until);
      CREATE INDEX relays_until ON relays(until);
    `);
  },
};
