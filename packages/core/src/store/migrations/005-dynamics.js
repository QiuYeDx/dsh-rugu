// 005 · dynamics：激活痕迹、聚合项和激活缓存、心境（§6、§5.7）。
// 设计 §12.2 写的是「聚合项作为各主表的列」；这里改成单独一张 activation 表，归 dynamics 一个模块写，
// 主表（assertions、episodes……）就不必被两个模块同时改。b_cache / tier 也在这里，不在主表上。
const OWNER_KINDS = "'percept','window','episode','assertion','entity','impression','intention','storyline','community','link'";

export default {
  version: 5,
  name: 'dynamics',
  owner: 'dynamics',
  tables: ['traces', 'activation', 'mood'],
  up(db) {
    db.exec(`
      -- 最近 K=8 条精确痕迹（§6.3）；更早的并进 activation 的聚合项（Petrov 2006）
      CREATE TABLE traces (
        id         INTEGER PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id   INTEGER NOT NULL,
        t          INTEGER NOT NULL,                 -- 证据消息的时间，不是处理时间（§6.4）
        w          REAL NOT NULL,                    -- 编码强度 w_att × w_self × w_sal × w_rel × w_emo（× 事件系数）
        d          REAL NOT NULL,                    -- 这条痕迹自己的衰减率（Pavlik & Anderson 2005）
        source_key TEXT NOT NULL DEFAULT '',         -- 来源窗口用：同一来源同一天最多一条（§6.4）
        reason     TEXT NOT NULL                     -- encode / mention / reread / confirm / asked / reply / retell / replay / inherit
      ) STRICT;
      CREATE INDEX traces_owner ON traces(owner_kind, owner_id, t);

      CREATE TABLE activation (
        owner_kind    TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id      INTEGER NOT NULL,
        agg_n         INTEGER NOT NULL DEFAULT 0,    -- 并进聚合项的痕迹条数
        agg_w         REAL NOT NULL DEFAULT 0,       -- 它们的权重和
        agg_first     INTEGER,                       -- 最早一条的时间
        agg_last      INTEGER,                       -- 最晚一条的时间
        agg_d         REAL,                          -- 平均衰减率（按权重）
        agg_bins_json TEXT NOT NULL DEFAULT '[]',    -- 聚合项按衰减率分箱：[{k, n, w, first, last, d}]（每箱各自用 Petrov 近似）
        trace_count   INTEGER NOT NULL DEFAULT 0,    -- 精确 + 聚合的总条数
        last_trace_at INTEGER,
        replay_count  INTEGER NOT NULL DEFAULT 0,    -- 夜间重放加过几次（≤ 3）
        retell_count  INTEGER NOT NULL DEFAULT 0,    -- 讲给新听众加过几次（≤ 5）
        inherited_json TEXT NOT NULL DEFAULT '[]',   -- 从哪些旧版本继承过激活（记忆引用；inheritActivation 重跑不重复计数）
        b_cache       REAL,                          -- 夜间算好的基础激活
        b_at          INTEGER,
        tier          TEXT NOT NULL DEFAULT 'hot' CHECK (tier IN ('hot','warm','cold')),  -- 只决定索引放哪（§6.8）
        PRIMARY KEY (owner_kind, owner_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX activation_tier ON activation(tier, owner_kind);

      -- 跨场合、慢慢衰减的心境（§5.7）：每次情绪反应一行（一次冲量），当前心境按半衰期把它们叠起来。
      -- 原因是记忆引用，按分寸渲染；行不删（衰减到几乎为零的冲量自然不再参与）
      CREATE TABLE mood (
        id             INTEGER PRIMARY KEY,
        at             INTEGER NOT NULL,
        valence        REAL NOT NULL CHECK (valence >= -1 AND valence <= 1),
        intensity      REAL NOT NULL CHECK (intensity >= 0 AND intensity <= 1),
        cause_ids_json TEXT NOT NULL DEFAULT '[]'
      ) STRICT;
      CREATE INDEX mood_at ON mood(at);
    `);
  },
};
