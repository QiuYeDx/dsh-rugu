// 007 · context：会话和场合的绑定、本周期的已发条目、注入日志（§10.3–§10.5、§9.4.1）。
// 会话 id 是宿主给的不透明字符串（核心不认识宿主，只知道「有一段对话」）。
// 污点账本 = 这个会话当前周期里已确认送达的注入条目（injections.seen=1 且 cycle = sessions.cycle）+ 这个周期里
// 常驻区放进过它上下文的条目（resident_items_json），按需推出，不另存 taint_ledger_json。
export default {
  version: 7,
  name: 'context',
  owner: 'context',
  tables: ['sessions', 'injections'],
  up(db) {
    db.exec(`
      CREATE TABLE sessions (
        session_id         TEXT PRIMARY KEY,
        setting_key        TEXT,
        adapter            TEXT,
        confidence         TEXT CHECK (confidence IN ('specific','fallback')),
        bound_at           INTEGER,
        cycle              INTEGER NOT NULL DEFAULT 0,  -- 压缩周期序号：compaction 结束（或重新开始）一次 + 1
        cycle_started_at   INTEGER,
        last_event_seq     INTEGER,
        sent_items_json    TEXT NOT NULL DEFAULT '[]',  -- 本周期已确认发过的 RecallItem.id（只给了暗示的记成 'a12~aware'）
        pending_json       TEXT NOT NULL DEFAULT '[]',  -- 发了但还没在会话事件里看到 nonce 的块：[{nonce, id, at}]
        warm_pending       INTEGER NOT NULL DEFAULT 0,  -- 下一条真实消息到来时补暖启动
        restart_marker     INTEGER,                     -- 主人在这个场合「重新开始」的时刻（§10.5）；下一次压缩结束时清掉
        gap_ack_at         INTEGER,                     -- 最近一次「时间间隔」提示送达的时刻：同一段间隔只提示一次（§10.4）
        resident_items_json TEXT NOT NULL DEFAULT '[]', -- 本周期常驻区放进过这个会话上下文的条目（污点账本的一部分）
        inject_window_json TEXT NOT NULL DEFAULT '{}',  -- 滚动窗口预算：{steps: [{at, tokens}]}（最近 50 步的上下文 token，§10.4）
        turn_taint_json    TEXT,                        -- 按轮污点（§9.6）：{tainted, since, reasons}
        last_interaction_at INTEGER,                    -- 最近一次真实消息触发的回想（时间间隔层的参考）
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','excluded')),
        updated_at         INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX sessions_setting ON sessions(setting_key) WHERE setting_key IS NOT NULL;

      -- 注入日志（§12.2、§13.1）：每一项都带它对应的判定（items_json 里的 appraisalRef）
      CREATE TABLE injections (
        id            INTEGER PRIMARY KEY,
        ts            INTEGER NOT NULL,
        session_id    TEXT NOT NULL,
        cycle         INTEGER NOT NULL,
        setting_key   TEXT,
        layer         TEXT NOT NULL,                 -- resident / 各 Layer / 'block'（一个增量块含多层）
        nonce         TEXT NOT NULL UNIQUE,
        items_json    TEXT NOT NULL,                 -- [{id, layer, verdict, appraisalRef}]（不含渲染后的正文）
        chars         INTEGER NOT NULL,
        scores_json   TEXT,
        degrade_level INTEGER,
        route_ms_json TEXT,
        mode          TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('shadow','live')),
        seen          INTEGER NOT NULL DEFAULT 0,    -- 会话事件里看到了 nonce 才算发过
        seen_at       INTEGER
      ) STRICT;
      CREATE INDEX injections_session ON injections(session_id, cycle, seen);
      CREATE INDEX injections_ts ON injections(ts);
    `);
  },
};
