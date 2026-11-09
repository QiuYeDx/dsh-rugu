// 006 · discretion：出现集合、流动规范、场合规矩、谁知道、告诉过谁、评估缓存、外发记录、分寸日志（§5.6、§9）。
// 这几样都由代码维护，不交给模型推断（认知:280）。
const OWNER_KINDS = "'percept','window','episode','assertion','entity','impression','intention','storyline','community','link'";

export default {
  version: 6,
  name: 'discretion',
  owner: 'discretion',
  tables: ['presence_sets', 'flow_norms', 'setting_rules', 'known_by', 'told_log', 'appraisals', 'utterances', 'discretion_log'],
  up(db) {
    db.exec(`
      -- 出现集合（评审:AR-06）：某一时刻某个场合里有哪些人，名单完整到什么程度。同样的名单复用同一行
      -- private：只有她自己（她私下读到的、心里想的，记在她知道的那个场合）。它说的是「这条只有她看到」，
      --          不是「这个场合里只有她」，算场合的知情圈、谁在场时跳过
      CREATE TABLE presence_sets (
        id                INTEGER PRIMARY KEY,
        setting_key       TEXT NOT NULL,
        at                INTEGER NOT NULL,
        members_json      TEXT NOT NULL DEFAULT '[]', -- 实体 id，升序
        completeness      TEXT NOT NULL CHECK (completeness IN ('exact','recent-speakers','unknown')),
        unknown_observers INTEGER NOT NULL DEFAULT 0,
        members_hash      TEXT NOT NULL,
        private           INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX presence_sets_setting ON presence_sets(setting_key, at);
      CREATE INDEX presence_sets_hash ON presence_sets(setting_key, members_hash);

      -- 流动规范（§5.6），每个记忆单元一行。没有行 = unassessed（按最严处理）。
      -- 改动时 version + 1，旧值和依据追加进 history_json；评估缓存的键里带 version
      CREATE TABLE flow_norms (
        owner_kind           TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id             INTEGER NOT NULL,
        version              INTEGER NOT NULL DEFAULT 1,
        origin_exposure_json TEXT NOT NULL DEFAULT '{}', -- 来源场合当时的 disclosure + audience 快照（含 exposure_rank）
        setting_rule_ref     TEXT,                       -- 引用来源场合（场合键）的规矩，不存拷贝（评审:UV-09）
        setting_rule_version INTEGER,                    -- 引用时的规矩版本
        restriction          TEXT NOT NULL DEFAULT 'none' CHECK (restriction IN ('none','soft','strict')),
        allow_json           TEXT,                       -- 只能告诉谁（实体 id）
        deny_json            TEXT,                       -- 不能让谁知道（实体 id）
        restriction_quote    TEXT,
        restricted_by        INTEGER,                    -- 当初提出限制的人（放宽权限之一，§5.6）
        attribute            TEXT,                       -- 开放词表的信息类型
        sensitivity          REAL CHECK (sensitivity IS NULL OR (sensitivity >= 0 AND sensitivity <= 1)),  -- 只用来收紧
        involves_others      INTEGER NOT NULL DEFAULT 0, -- 代码从实体解析算出：有没有她以外的具体的人（评审:PS-19）
        identity_link        INTEGER NOT NULL DEFAULT 0, -- 身份对应类信息（B3）
        derivation           TEXT CHECK (derivation IS NULL OR derivation IN ('quote','inference')),  -- 派生内容：复述 / 推断（卡片写「这是你自己的猜测」）
        relax_k              INTEGER,                    -- 派生内容的证据来自几个不同的主体（§5.6 放宽一级的条件）
        summary              TEXT,                       -- 一句话的规范
        history_json         TEXT NOT NULL DEFAULT '[]',
        updated_at           INTEGER NOT NULL,
        PRIMARY KEY (owner_kind, owner_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX flow_norms_rule ON flow_norms(setting_rule_ref) WHERE setting_rule_ref IS NOT NULL;

      -- 场合规矩的版本链（单调性检查的依据，§5.6）。没有权限的来源只能让规矩更严。
      -- superseded_at：被有权限的放宽取代的时刻（NULL = 仍在生效链里）
      CREATE TABLE setting_rules (
        setting_key      TEXT NOT NULL,
        version          INTEGER NOT NULL,
        rule_json        TEXT NOT NULL,              -- {text, restriction, scope, info}
        rule_hash        TEXT NOT NULL DEFAULT '',   -- 同一条规矩重复写入不新建版本
        source           TEXT NOT NULL CHECK (source IN ('adapter-notes','learned','owner')),
        author_entity_id INTEGER,
        authority        TEXT NOT NULL CHECK (authority IN ('none','moderator','principal','config')),
        stricter         INTEGER NOT NULL DEFAULT 1, -- 相对上一版是不是只收紧
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','rejected')),
        superseded_at    INTEGER,
        -- 来源撤下了（群公告里那条没了）：之后才知道的内容不再受它约束；之前知道的照旧（当时是在这条规矩下听到的）
        withdrawn_at     INTEGER,
        at               INTEGER NOT NULL,
        PRIMARY KEY (setting_key, version)
      ) STRICT, WITHOUT ROWID;

      -- 谁知道（共同基础，§5.6）。who_kind：entity 某个人 / presence_set 那一刻那批人 / setting 这个场合自 since 起的受众。
      -- basis：presence 当时看到 / setting 场合级 / subject 主体本人（权利层确认过）/ told_by_her 她说出去的 /
      --        public 公开可得（不算已知圈，§9.3.1）/ claimed「X 声称 B 已经知道」（只进卡片，不参与计算；claimant = X）
      CREATE TABLE known_by (
        id         INTEGER PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id   INTEGER NOT NULL,
        who_kind   TEXT NOT NULL CHECK (who_kind IN ('entity','presence_set','setting')),
        who_ref    TEXT NOT NULL,
        since      INTEGER NOT NULL,
        basis      TEXT NOT NULL CHECK (basis IN ('presence','setting','subject','told_by_her','public','claimed')),
        claimant   INTEGER,
        at         INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX known_by_owner ON known_by(owner_kind, owner_id);
      CREATE INDEX known_by_who ON known_by(who_kind, who_ref);

      -- 她告诉过谁（§5.6）。唯一的真相来源是她自己说出去的那条感知
      CREATE TABLE told_log (
        id                   INTEGER PRIMARY KEY,
        owner_kind           TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id             INTEGER NOT NULL,
        at                   INTEGER NOT NULL,
        setting_key          TEXT NOT NULL,
        presence_set_id      INTEGER,
        utterance_percept_id INTEGER NOT NULL,
        level                TEXT NOT NULL CHECK (level IN ('full','vague'))
      ) STRICT;
      CREATE INDEX told_log_owner ON told_log(owner_kind, owner_id, at);
      CREATE INDEX told_log_setting ON told_log(setting_key, at);
      CREATE INDEX told_log_percept ON told_log(utterance_percept_id);

      -- 关口①的判定记录：第一段（stage=1，rule 是 A1/A2/A3/B1…）和第二段（stage=2，有缓存键和过期时间）。
      -- 注入日志里的每一项都要能对上这里的一行（§9.3.6）
      CREATE TABLE appraisals (
        id            INTEGER PRIMARY KEY,
        stage         INTEGER NOT NULL CHECK (stage IN (1,2)),
        rule          TEXT,
        memory_kind   TEXT NOT NULL,
        memory_id     INTEGER NOT NULL,
        setting_key   TEXT,                          -- 目标场合
        norm_version  INTEGER,
        snapshot_id   INTEGER,
        audience_class TEXT,
        trigger_class TEXT,
        taint         INTEGER NOT NULL DEFAULT 0,
        told_ver      INTEGER,
        prompt_ver    TEXT,
        self_hash     TEXT,
        model         TEXT,
        verdict       TEXT NOT NULL CHECK (verdict IN ('share','share_vague','aware_private','omit','pending')),
        vague_text    TEXT,
        hint_ok       INTEGER,
        reason        TEXT,
        cache_key     TEXT,
        at            INTEGER NOT NULL,
        expires_at    INTEGER
      ) STRICT;
      CREATE INDEX appraisals_cache ON appraisals(cache_key, expires_at) WHERE cache_key IS NOT NULL;
      CREATE INDEX appraisals_memory ON appraisals(memory_kind, memory_id, at);

      -- 她的每次外发和关口②的结论（§9.4）。挂起的原文只存在 held_text（§9.4.4），受彻底删除和墓碑约束。
      -- origin_path='unappraised'：没经过关口②就说出去的话（回流时对不上审视记录），只在需要留下标记（按轮污点）时记一行
      CREATE TABLE utterances (
        id               INTEGER PRIMARY KEY,
        token            TEXT NOT NULL UNIQUE,
        setting_key      TEXT,                       -- 目标场合
        home_setting_key TEXT,                       -- 对话所在的场合
        at               INTEGER NOT NULL,
        form_hint        TEXT,
        channel_json     TEXT NOT NULL,              -- 渠道属性（不含正文）
        origin_path      TEXT NOT NULL CHECK (origin_path IN ('tool','background','ui','owner-approved','unappraised')),
        text_hash        TEXT NOT NULL,
        held_text        TEXT,
        verdict          TEXT NOT NULL CHECK (verdict IN ('speak','reconsider','hold')),
        reflection       TEXT,
        reasons_json     TEXT NOT NULL DEFAULT '[]', -- 命中的记忆引用和规则（不含正文）；这一轮带按轮污点的都有 'turn-tainted'（§9.6，成长不拿它当依据）
        outcome          TEXT CHECK (outcome IN ('sent','failed','held','hidden')),
        hold_status      TEXT CHECK (hold_status IN ('pending','approved','rejected','expired')),
        review_id        INTEGER,                    -- 挂起时排进的审核项（review_queue.id）
        session_id       TEXT,
        call_id          TEXT,
        attempts         INTEGER NOT NULL DEFAULT 1, -- 同一句话被拒的次数（两次 → 最终拒绝）
        matched_percept  INTEGER,                    -- 回流后对上的自身发言感知
        decided_at       INTEGER,
        created_at       INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX utterances_setting ON utterances(setting_key, at);
      CREATE INDEX utterances_hash ON utterances(text_hash, at);
      CREATE INDEX utterances_hold ON utterances(hold_status) WHERE hold_status IS NOT NULL;
      CREATE INDEX utterances_matched ON utterances(matched_percept) WHERE matched_percept IS NOT NULL;   -- 回流重复投递、夜间整理按感知查按轮污点

      -- 分寸日志（§9.5）：每次「想起来了但没说」、改口、挂起、未经审视的发言，都带理由记一笔
      CREATE TABLE discretion_log (
        id                INTEGER PRIMARY KEY,
        at                INTEGER NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('aware_private','omit','pending','reconsider','hold','unappraised')),
        setting_key       TEXT,
        memory_kind       TEXT,
        memory_id         INTEGER,
        appraisal_id      INTEGER,
        utterance_id      INTEGER,
        trigger_entity_id INTEGER,                   -- 谁问的（按询问者限速，§9.3.4）
        subject_entity_id INTEGER,
        reason            TEXT
      ) STRICT;
      CREATE INDEX discretion_log_at ON discretion_log(at);
      CREATE INDEX discretion_log_trigger ON discretion_log(trigger_entity_id, at) WHERE trigger_entity_id IS NOT NULL;
    `);
  },
};
