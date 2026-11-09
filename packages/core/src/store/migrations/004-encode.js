// 004 · encode：情节、事实、事实和实体的边、同类事、来源、计划状态史、属性键注册表、意图、说话人配额。
// 事实失效但不删除（§5.4）：没有 expired 状态；「忘掉 / 隐藏」在 suppressions 表（admin），不在这里。
// 激活痕迹在 traces / activation（dynamics），嵌入状态在 embed_texts（worker），规范在 flow_norms（discretion）。
import { FTS_TOKENIZE } from '../fts.js';

export default {
  version: 4,
  name: 'encode',
  owner: 'encode',
  tables: ['episodes', 'episodes_fts', 'assertions', 'assertions_fts', 'assertion_entities', 'same_type', 'sources',
    'plan_status_history', 'predicates', 'intentions', 'speaker_quota'],
  up(db) {
    db.exec(`
      -- 情节（§5.1、§7.2）。ep_kind：event 切分出来的经历 / summary「今天到目前为止」的一句话小结 /
      -- diary 每天的自传回顾 / lapse「那阵子想问他，没顾上」/ import 导入的
      CREATE TABLE episodes (
        id                INTEGER PRIMARY KEY,
        setting_key       TEXT NOT NULL,
        ep_kind           TEXT NOT NULL DEFAULT 'event' CHECK (ep_kind IN ('event','summary','diary','lapse','import')),
        title             TEXT NOT NULL DEFAULT '',
        narrative         TEXT NOT NULL DEFAULT '',  -- 第三人称叙述
        header            TEXT NOT NULL DEFAULT '',  -- 上下文头：代词换成实体、绝对时间
        header_ver        TEXT,                      -- 上下文头提示词版本（不进 space_id，§8.9）
        t_start           INTEGER NOT NULL,
        t_end             INTEGER NOT NULL,
        participants_json TEXT NOT NULL DEFAULT '[]', -- 实体 id
        snapshot_id       INTEGER,
        sealed_at         INTEGER NOT NULL,
        emotion_json      TEXT,                      -- {valence, intensity, text}
        extract_ver       TEXT,
        model             TEXT,
        job_id            INTEGER,                   -- 哪个提炼任务写的（重跑幂等）
        created_at        INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX episodes_setting ON episodes(setting_key, t_end);
      CREATE INDEX episodes_kind ON episodes(ep_kind, t_end);
      CREATE INDEX episodes_time ON episodes(t_start, t_end);       -- 时间路（§8.2）：跨场合按时间窗取
      CREATE INDEX episodes_job ON episodes(job_id) WHERE job_id IS NOT NULL;

      -- 事实（§5.4）。两套时间：世界时间（event_*、planned_time、valid_from、valid_to_known、t50/shape）和系统时间（recorded_at、expired_at）
      CREATE TABLE assertions (
        id               INTEGER PRIMARY KEY,
        predicate        TEXT NOT NULL,              -- 原子属性键（predicates.key）
        value            TEXT,                       -- 值（文本或 JSON），或者用 object_entity_id
        object_entity_id INTEGER,
        text             TEXT NOT NULL,              -- 一句自足的话，≤ 120 字
        kind_hint        TEXT NOT NULL DEFAULT 'fact', -- 状态 / 计划 / 事件 / 事实 / 偏好 / 关系 / 看法 / 规矩……只影响措辞和去重方式
        recurrence       TEXT,                       -- 周期性（JSON）
        occurrence_key   TEXT,                       -- 计划和事件：身份里包含发生的时间窗（§5.4「发生次」）
        certainty        TEXT NOT NULL CHECK (certainty IN ('stated','confirmed','self_said','hearsay','inferred')),
        confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        imp              REAL NOT NULL DEFAULT 5 CHECK (imp >= 1 AND imp <= 10),
        event_start      INTEGER,
        event_end        INTEGER,
        event_precision  TEXT,
        planned_time_json TEXT,
        valid_from       INTEGER,
        valid_to_known   INTEGER,
        change_known     INTEGER NOT NULL DEFAULT 0, -- 「变了但新值未知」
        t50_h            REAL,                       -- 预计持续的中位时长（小时），由提炼模型按语境给
        shape            REAL,
        recorded_at      INTEGER NOT NULL,
        expired_at       INTEGER,                    -- 系统认定它过时的时刻
        supersedes       INTEGER,
        superseded_by    INTEGER,
        plan_agent       INTEGER,                    -- 谁的计划（实体 id）
        plan_status      TEXT CHECK (plan_status IN ('planned','in_progress','done','cancelled','missed','unknown')),
        plan_outcome_ref TEXT,                       -- 指向「拿到了」那条情节或事实（记忆引用，见 store/refs.js）
        pinned           INTEGER NOT NULL DEFAULT 0, -- 被明确要求「记住」
        needs_review     INTEGER NOT NULL DEFAULT 0, -- 时间自洽拿不准，夜里复核（§7.4 第 5 条）
        needs_reconcile  INTEGER NOT NULL DEFAULT 0, -- 相似度落在中间，夜里批量对账（§7.5）
        extract_ver      TEXT,
        model            TEXT,
        job_id           INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX assertions_predicate ON assertions(predicate);
      CREATE INDEX assertions_occurrence ON assertions(occurrence_key) WHERE occurrence_key IS NOT NULL;
      CREATE INDEX assertions_plan ON assertions(plan_agent, plan_status) WHERE plan_status IS NOT NULL;
      CREATE INDEX assertions_event ON assertions(event_start) WHERE event_start IS NOT NULL;   -- 时间路（§8.2）
      CREATE INDEX assertions_object ON assertions(object_entity_id) WHERE object_entity_id IS NOT NULL;   -- 实体图（§8.2 实体扩散）
      CREATE INDEX assertions_superseded ON assertions(superseded_by) WHERE superseded_by IS NOT NULL;
      CREATE INDEX assertions_flags ON assertions(needs_review, needs_reconcile) WHERE needs_review = 1 OR needs_reconcile = 1;
      CREATE INDEX assertions_job ON assertions(job_id) WHERE job_id IS NOT NULL;

      -- 实体图的边，也是「涉及哪些人」的代码依据（§5.6 involves_others、§9.3.2 B2）
      CREATE TABLE assertion_entities (
        assertion_id INTEGER NOT NULL,
        entity_id    INTEGER NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('subject','object','mention','speaker','asserter')),
        PRIMARY KEY (assertion_id, entity_id, role)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX assertion_entities_entity ON assertion_entities(entity_id, role);

      -- 同一类事的不同几次（评审:SC-01），互不取代。a < b
      CREATE TABLE same_type (
        a INTEGER NOT NULL,
        b INTEGER NOT NULL,
        CHECK (a < b),
        PRIMARY KEY (a, b)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX same_type_b ON same_type(b);

      -- 来源（§5.3），情节和事实共用；一条记忆可以有多个来源。owner_kind 只会是 episode / assertion / intention
      CREATE TABLE sources (
        id           INTEGER PRIMARY KEY,
        owner_kind   TEXT NOT NULL CHECK (owner_kind IN ('episode','assertion','intention')),
        owner_id     INTEGER NOT NULL,
        percept_id   INTEGER,                        -- 导入的记忆可以没有
        snapshot_id  INTEGER,
        perceived_in TEXT,                           -- 场合键
        speaker      INTEGER,                        -- 实体 id（可以是她自己）
        asserter     INTEGER,                        -- 最初断言的人
        mode         TEXT NOT NULL CHECK (mode IN ('told_to_her','overheard','read','observed','relayed','inferred','self_generated','imported')),
        hop          INTEGER NOT NULL DEFAULT 0,
        quote        TEXT,                           -- ≤ 60 字原话；撤回的消息不再展示
        confidence   REAL NOT NULL DEFAULT 0.5,
        used_bg_json TEXT NOT NULL DEFAULT '[]',     -- 提炼时用了哪些背景（污点检查，§7.3）
        at           INTEGER NOT NULL,
        extract_ver  TEXT,
        job_id       INTEGER
      ) STRICT;
      CREATE INDEX sources_owner ON sources(owner_kind, owner_id);
      CREATE INDEX sources_percept ON sources(percept_id) WHERE percept_id IS NOT NULL;
      CREATE INDEX sources_speaker ON sources(speaker, at);

      CREATE TABLE plan_status_history (
        id               INTEGER PRIMARY KEY,
        assertion_id     INTEGER NOT NULL,
        status           TEXT NOT NULL CHECK (status IN ('planned','in_progress','done','cancelled','missed','unknown')),
        at               INTEGER NOT NULL,
        evidence_percept INTEGER,
        source_json      TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX plan_status_history_assertion ON plan_status_history(assertion_id, at);

      -- 开放属性键注册表（§5.4：属性键是数据，不是代码）
      CREATE TABLE predicates (
        key           TEXT PRIMARY KEY,
        canonical     TEXT NOT NULL,                 -- 同义键合并到的规范名
        cardinality   TEXT NOT NULL DEFAULT 'one' CHECK (cardinality IN ('one','many')),
        is_current    INTEGER NOT NULL DEFAULT 0,    -- 是不是「当前状态」类
        synonyms_json TEXT NOT NULL DEFAULT '[]',
        created_by    TEXT NOT NULL,                 -- extractor / owner / seed
        created_at    INTEGER NOT NULL
      ) STRICT;

      -- 她自己的意图（§5.5）。规范在 flow_norms（owner_kind='intention'），继承 about 和形成证据里最严的
      CREATE TABLE intentions (
        id               INTEGER PRIMARY KEY,
        about_kind       TEXT,                       -- 指向的计划或事实（可以为空：「下次见到他说句生日快乐」）
        about_id         INTEGER,
        target_entity_id INTEGER,                    -- 对谁做（执行记录、冷却以人为单位）
        act              TEXT NOT NULL,              -- 问候 / 追问 / 提醒 / 祝贺 / 分享 / verify ……（开放）
        text             TEXT NOT NULL DEFAULT '',   -- 一句话的意图
        origin           TEXT NOT NULL CHECK (origin IN ('self-care','self-commitment','principal-request')),
        trigger_json     TEXT NOT NULL DEFAULT '{}', -- {timeWindow?, cues: [...]}
        state            TEXT NOT NULL DEFAULT 'formed' CHECK (state IN ('formed','armed','executed','cancelled','obsolete','lapsed')),
        formed_at        INTEGER NOT NULL,
        armed_at         INTEGER,
        window_start     INTEGER,
        window_end       INTEGER,
        suppressed_at    INTEGER,                    -- 完成 / 取消 / 错过后的短暂抑制从这一刻算（§5.5 第 3 条）
        executions_json  TEXT NOT NULL DEFAULT '[]', -- [{at, settingKey, targetEntityId, utteranceRef}]
        sources_json     TEXT NOT NULL DEFAULT '[]', -- 形成证据的感知 id
        job_id           INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX intentions_state ON intentions(state, window_end);
      CREATE INDEX intentions_target ON intentions(target_entity_id, state);
      CREATE INDEX intentions_about ON intentions(about_kind, about_id) WHERE about_id IS NOT NULL;

      -- 每个说话人每天的新事实配额（§7.4 第 10 条）
      CREATE TABLE speaker_quota (
        day       TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        facts     INTEGER NOT NULL DEFAULT 0,
        hearsay   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, entity_id)
      ) STRICT, WITHOUT ROWID;

      -- 词法路（§8.2）：情节（上下文头 + 叙述）和事实的词元。无内容表，rowid = 主表 id；词元由语言分析器给
      CREATE VIRTUAL TABLE episodes_fts USING fts5(tokens, content='', contentless_delete=1, tokenize="${FTS_TOKENIZE}");
      CREATE VIRTUAL TABLE assertions_fts USING fts5(tokens, content='', contentless_delete=1, tokenize="${FTS_TOKENIZE}");
    `);
  },
};
