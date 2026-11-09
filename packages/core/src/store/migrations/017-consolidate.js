// 017 · consolidate：夜里对照原话核对过的记忆（D122，§7.7 第 2 步「对照原话纠错」）。
//   每核对一条事实写一行：结论、引用的证据（感知 id）、模型的一句理由、下次该什么时候再核对。
//   - 不抄记忆的文字：核对时的旧文字就是 assertion_id 那一行（被取代的版本照样留着），改正后的是 result_id 那一行；
//     彻底删除事实时这里跟着删（admin.purge，§2.3）；给模型看过的任何一句原话被彻底删除时，这一行也删（理由可能转述了它，不只看引用的）。
//   - 主人可以撤销一次改正（管理页「记忆 → 夜里改过的」）：旧版本按「确认过」恢复成新的一版（restored_id），这一行记下撤销的时间和人。
//   - 间隔不是硬窗口：next_at 按「连续确认的次数翻倍、用得越多越勤」算出来（consolidate/correct.js），只决定哪天再挑它。
export default {
  version: 17,
  name: 'consolidate-memory-checks',
  owner: 'consolidate',
  tables: ['memory_checks'],
  up(db) {
    db.exec(`
      CREATE TABLE memory_checks (
        id            INTEGER PRIMARY KEY,
        assertion_id  INTEGER NOT NULL,              -- 核对的那条（当时的版本）
        at            INTEGER NOT NULL,
        verdict       TEXT NOT NULL CHECK (verdict IN ('confirmed','corrected','changed','doubted','unclear')),
        result_id     INTEGER,                       -- 改正 / 降低把握之后的新版本（assertion id）；没改是 NULL
        evidence_json TEXT NOT NULL DEFAULT '[]',    -- 引用的感知 id（代码核过：都是给模型看过的、属于这一条的）
        shown_json    TEXT NOT NULL DEFAULT '[]',    -- 给模型看过的全部感知 id（彻底删除的级联按它）
        why           TEXT,                          -- 模型的一句理由（≤ 80 字，管理页「夜里改过的」给主人看）
        before_conf   REAL,                          -- 改之前 / 之后的把握（只有数字）
        after_conf    REAL,
        streak        INTEGER NOT NULL DEFAULT 0,    -- 连续确认了几次（间隔按它翻倍）
        next_at       INTEGER,                       -- 下次该核对的时刻（改过的那条看新版本）
        prompt_ver    TEXT,
        reverted_at   INTEGER,                       -- 主人撤销了这次改正
        reverted_by   TEXT,
        restored_id   INTEGER                        -- 撤销时按旧版本恢复出的那一版（certainty confirmed，夜里不再挑）
      ) STRICT;
      CREATE INDEX memory_checks_assertion ON memory_checks(assertion_id, at);
      CREATE INDEX memory_checks_result ON memory_checks(result_id) WHERE result_id IS NOT NULL;
      CREATE INDEX memory_checks_at ON memory_checks(at);
      CREATE INDEX memory_checks_restored ON memory_checks(restored_id) WHERE restored_id IS NOT NULL;
    `);
  },
};
