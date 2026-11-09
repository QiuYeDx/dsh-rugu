// 009 · worker：实际嵌入过的文本（嵌入队列）和向量空间（§7.6、§8.9）。
// 向量本身在另一个文件 persona-vectors.db（纯缓存，见 store/vectors.js），丢了可以按 embed_texts 重建，不备份。
const OWNER_KINDS = "'percept','window','episode','assertion','entity','impression','intention','storyline','community','link'";

export default {
  version: 9,
  name: 'worker',
  owner: 'worker',
  tables: ['embed_texts', 'vector_spaces'],
  up(db) {
    db.exec(`
      -- 每个记忆单元要嵌入的文本块。status 相对「当前活动空间」：pending 等着嵌 / done 已嵌 / failed 嵌失败 / stale 文本变了要重嵌。
      -- priority 越小越先（§7.6）：1 原文窗口 > 2 新的记忆单元 > 3 补嵌和重嵌（查询不进这张表）
      CREATE TABLE embed_texts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,   -- 不复用 id：向量库靠 embed_text_id 认行，复用会让旧向量冒充新文本
        owner_kind TEXT NOT NULL CHECK (owner_kind IN (${OWNER_KINDS})),
        owner_id   INTEGER NOT NULL,
        chunk_no   INTEGER NOT NULL DEFAULT 0,
        kind       TEXT NOT NULL CHECK (kind IN ('text','fq')),   -- fq = future_q 块（§7.3）
        layer      TEXT NOT NULL CHECK (layer IN ('memory','raw')),
        text       TEXT NOT NULL,                    -- 实际嵌入的文本（上下文头 + 叙述……），保证重嵌可复现
        hash       TEXT NOT NULL,
        header_ver TEXT,
        priority   INTEGER NOT NULL DEFAULT 2,
        status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','stale')),
        space_id   TEXT,                             -- 最后一次嵌进的空间
        attempts   INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner_kind, owner_id, chunk_no, kind)
      ) STRICT;
      CREATE INDEX embed_texts_queue ON embed_texts(status, priority, id);

      -- 向量空间：space_id = hash(模型, 量化档, 维数, 文档端模板版本)；上下文头版本不进 space_id（§8.9）。
      -- shadow 空间重嵌时用 cursor 记到了哪条 embed_texts；suspect = 启动探针发现模型被悄悄换过（§13.2）
      CREATE TABLE vector_spaces (
        space_id      TEXT PRIMARY KEY,
        port_space_id TEXT NOT NULL,                   -- 嵌入端口自己的空间 id（MRL 截断时 space_id = port_space_id + '~d' + 维数）
        model         TEXT NOT NULL,
        quant         TEXT,
        dim           INTEGER NOT NULL,
        doc_tpl_ver   TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('active','shadow','retired','suspect')),
        coverage      REAL NOT NULL DEFAULT 0,
        cursor        INTEGER NOT NULL DEFAULT 0,
        probe_vectors BLOB,                          -- 20 条探针句子的向量（f32 拼接）
        created_at    INTEGER NOT NULL,
        activated_at  INTEGER,
        retired_at    INTEGER
      ) STRICT;
      CREATE UNIQUE INDEX vector_spaces_active ON vector_spaces(status) WHERE status = 'active';
    `);
  },
};
