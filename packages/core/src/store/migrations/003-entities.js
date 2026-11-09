// 003 · entities：实体档案、名字证据、关系描述、身份证据、可逆链接、分层印象（§5.2、§5.8）。
// 账号只是身份证据的一种，只存 HMAC（§12.3）。认得 ≠ 权利：链接的 decided_by 决定它能不能用于权利层。
export default {
  version: 3,
  name: 'entities',
  owner: 'entities',
  tables: ['entities', 'entity_names', 'entity_descriptors', 'identity_evidence', 'entity_links', 'entity_impressions'],
  up(db) {
    db.exec(`
      CREATE TABLE entities (
        id               INTEGER PRIMARY KEY,
        kind             TEXT NOT NULL,              -- 开放词表：person / pet / object / place / org / group / work / game / setting / self ……
        status           TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional','established','retracted')),
        display_name     TEXT,                       -- 「最完整的名字」，可以为空（「阿明的表哥」）
        is_self          INTEGER NOT NULL DEFAULT 0, -- 她自己
        closeness        REAL NOT NULL DEFAULT 0 CHECK (closeness >= 0 AND closeness <= 1),
        authority        TEXT NOT NULL DEFAULT 'none' CHECK (authority IN ('none','principal','delegated')),
        setting_key      TEXT,                       -- kind=setting 时对应的场合
        first_mention_at INTEGER,
        last_mention_at  INTEGER,
        mention_days     INTEGER NOT NULL DEFAULT 0, -- 在几个不同的（本地）日子被提到过 / 出现过（established 的依据之一）
        mention_day_set  TEXT NOT NULL DEFAULT '[]', -- 最近这些日子的日序号（JSON，有上限），用来去重 mention_days
        display_source   TEXT,                       -- display_name 从哪来：platform / extract / label / config / owner（优先级递增）
        individual       INTEGER NOT NULL DEFAULT 1, -- 是不是「具体的个人」（§5.6 involves_others、§9.3.2 B2）；未知种类按个人算（宁严勿松）
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX entities_self ON entities(is_self) WHERE is_self = 1;
      CREATE UNIQUE INDEX entities_setting ON entities(setting_key) WHERE setting_key IS NOT NULL;
      CREATE INDEX entities_authority ON entities(authority) WHERE authority <> 'none';
      CREATE INDEX entities_last_mention ON entities(last_mention_at);

      -- 名字证据：谁、在哪里这样叫他（群名片只在本群有效）。也用来生成名字匹配器和 jieba 用户词典
      CREATE TABLE entity_names (
        id                INTEGER PRIMARY KEY,
        entity_id         INTEGER NOT NULL,
        text_raw          TEXT NOT NULL,
        text_norm         TEXT NOT NULL,
        used_by           INTEGER NOT NULL DEFAULT 0,  -- 谁这样叫（实体 id；0 = 平台 / 配置给的）
        scope_setting_key TEXT NOT NULL DEFAULT '',    -- '' = 不限场合
        reserved          INTEGER NOT NULL DEFAULT 0,  -- 保留名（她的名字、主人的称呼）：别人不能用名片冒用
        name_kind         TEXT NOT NULL DEFAULT 'mention'
                          CHECK (name_kind IN ('card','account','mention','self-intro','label','config','owner')),
                                                       -- card 群名片（只在 scope 里算数）/ account 账号昵称 / mention 文中被这样叫 /
                                                       -- self-intro 自我介绍 / label 场合的称呼 / config 配置给的 / owner 主人在管理页写的
        spoof             INTEGER NOT NULL DEFAULT 0,  -- 名片 / 昵称和别人的保留名撞了：记下来，但不进名字匹配器、不当显示名
        count             INTEGER NOT NULL DEFAULT 1,
        first             INTEGER NOT NULL,
        last              INTEGER NOT NULL,
        UNIQUE (entity_id, text_norm, used_by, scope_setting_key)
      ) STRICT;
      CREATE INDEX entity_names_norm ON entity_names(text_norm);
      CREATE INDEX entity_names_scope ON entity_names(scope_setting_key, text_norm);
      CREATE INDEX entity_names_entity ON entity_names(entity_id);

      -- 关系描述：（锚点，关系）。没有名字也能立档；同一锚点同一关系可以有好几个档案（阿明可以有两个表哥）。
      -- 一行 = 某个说话人以某种方式给出的这条描述（「多条独立描述吻合」要数不同的说话人和日子，§5.2）
      CREATE TABLE entity_descriptors (
        id                INTEGER PRIMARY KEY,
        entity_id         INTEGER NOT NULL,
        anchor_entity_id  INTEGER NOT NULL,
        relation          TEXT NOT NULL,              -- 规范化后的关系（和名字同一套规范化），用来比较
        text              TEXT NOT NULL DEFAULT '',   -- 关系的原文（「表哥」）
        basis             TEXT NOT NULL DEFAULT 'third-party'
                          CHECK (basis IN ('first-person','third-party','self-claim','owner')),
                                                       -- first-person 锚点本人说的（「我表哥」）/ third-party 别人说的 /
                                                       -- self-claim 当事人自称（「我是阿明的表哥」，只产生 maybe_same）/ owner 主人写的
        speaker_entity_id INTEGER NOT NULL DEFAULT 0,  -- 谁给出的这条描述（0 = 不知道）
        setting_key       TEXT NOT NULL DEFAULT '',    -- 在哪个场合说的（规范从名字和描述的来源推出，§2.2）
        count             INTEGER NOT NULL DEFAULT 1,
        first_at          INTEGER NOT NULL,
        last_at           INTEGER NOT NULL,
        source_json       TEXT NOT NULL DEFAULT '{}',  -- {perceptIds: [...]（≤ 5）, jobId}
        created_at        INTEGER NOT NULL,
        UNIQUE (entity_id, anchor_entity_id, relation, speaker_entity_id, basis)
      ) STRICT;
      CREATE INDEX entity_descriptors_anchor ON entity_descriptors(anchor_entity_id, relation);
      CREATE INDEX entity_descriptors_relation ON entity_descriptors(relation);
      CREATE INDEX entity_descriptors_entity ON entity_descriptors(entity_id);

      -- 身份证据：同命名空间、同作用域、同 id → 同一个人（§5.2 第 1 步）。scope 用 '' 表示没有作用域（NULL 会让 UNIQUE 失效）
      CREATE TABLE identity_evidence (
        id          INTEGER PRIMARY KEY,
        entity_id   INTEGER NOT NULL,
        namespace   TEXT NOT NULL,
        scope       TEXT NOT NULL DEFAULT '',
        id_hash     TEXT NOT NULL,                   -- keyring.identityHash(namespace, scope, id)
        strength    TEXT NOT NULL CHECK (strength IN ('platform','config','owner')),
        source_json TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        UNIQUE (namespace, scope, id_hash)
      ) STRICT;
      CREATE INDEX identity_evidence_entity ON identity_evidence(entity_id);

      -- 可逆链接。a < b。跨命名空间的链接本身是一条 B3 级的隐私记忆（规范在 flow_norms，owner_kind='link'）
      CREATE TABLE entity_links (
        id              INTEGER PRIMARY KEY,
        a               INTEGER NOT NULL,
        b               INTEGER NOT NULL,
        rel             TEXT NOT NULL CHECK (rel IN ('maybe_same','same','not_same')),
        confidence      REAL NOT NULL DEFAULT 0,
        evidence_json   TEXT NOT NULL DEFAULT '[]',
        decided_by      TEXT NOT NULL CHECK (decided_by IN ('extractor','sleep','mutual-claim','anchor-confirmed','platform','owner')),
        cross_namespace INTEGER NOT NULL DEFAULT 0,   -- 两边的账号证据落在不同的命名空间
        at              INTEGER NOT NULL,             -- 最近一次决定的时间
        created_at      INTEGER NOT NULL,
        CHECK (a < b),
        UNIQUE (a, b)
      ) STRICT;
      CREATE INDEX entity_links_b ON entity_links(b);

      -- 分层印象（§5.2）：shared = 大家都看得到的那层，private = 私下的那层。每层是一个带规范的记忆单元（owner_kind='impression'）
      CREATE TABLE entity_impressions (
        id                INTEGER PRIMARY KEY,
        entity_id         INTEGER NOT NULL,
        layer             TEXT NOT NULL CHECK (layer IN ('shared','private')),
        text              TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]', -- 依据的记忆引用（refs）
        first_hand        INTEGER NOT NULL DEFAULT 0, -- 「我自己见到的」证据条数
        hearsay           INTEGER NOT NULL DEFAULT 0, -- 「听别人说的」证据条数
        derivation        TEXT NOT NULL DEFAULT 'quote' CHECK (derivation IN ('quote','inference')),   -- 规范继承方式（§5.6 派生内容）
        version           INTEGER NOT NULL,
        is_current        INTEGER NOT NULL DEFAULT 1,
        built_at          INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX entity_impressions_current ON entity_impressions(entity_id, layer) WHERE is_current = 1;
      CREATE INDEX entity_impressions_entity ON entity_impressions(entity_id, layer, version);
    `);
  },
};
