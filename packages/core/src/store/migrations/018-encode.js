// 018 · encode：提炼一直不成的段（D136）。
//   一段对话的提炼任务把重试次数用完了（模型一直超时、输出不合格、供应商拒绝这段内容……），这段就「搁置」在这里：
//   - 切段时跳过它（不再从头扫到它、也不和前后的对话拼成一段），后面的对话照常切段、提炼；
//   - 按退避再试（next_at；次数越多隔得越久，有上限；稳定被拒的那类隔得更久，encode/stalled.js），试成了这一行就删掉；
//   - 这些感知不编造任何东西：不写情节、不写规范（仍是「没评估」），原话照常能被搜到、能进工作记忆。
//   不抄内容：只有场合键、感知 id 范围、原因类别和错误类型。
export default {
  version: 18,
  name: 'encode-extract-stalled',
  owner: 'encode',
  tables: ['extract_stalled'],
  up(db) {
    db.exec(`
      CREATE TABLE extract_stalled (
        id          INTEGER PRIMARY KEY,
        setting_key TEXT NOT NULL,
        ep_from     INTEGER NOT NULL,              -- 这一段的感知 id 范围（同一个场合里）
        ep_to       INTEGER NOT NULL,
        reason      TEXT NOT NULL CHECK (reason IN ('transient','rejected')),   -- 一时的（超时、连不上）/ 稳定被拒（输出不合格、内容被拒）
        last_error  TEXT,                          -- 最后一次的错误类型（不是内容）
        rounds      INTEGER NOT NULL DEFAULT 1,    -- 搁置以后又失败了几轮（退避按它翻倍）
        first_at    INTEGER NOT NULL,              -- 第一次搁置
        last_at     INTEGER NOT NULL,              -- 最近一次失败
        next_at     INTEGER NOT NULL,              -- 下次什么时候再试
        UNIQUE (setting_key, ep_from, ep_to)
      ) STRICT;
      CREATE INDEX extract_stalled_next ON extract_stalled(next_at);
    `);
  },
};
