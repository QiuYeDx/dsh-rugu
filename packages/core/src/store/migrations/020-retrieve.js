// 020 · retrieve：圈范围用的三个索引（D153）。只加索引，不建表、不改列；表照旧归 encode / intake。
//   assertions_when   事实的「事件时间」：有事件时间用事件时间，没有就按成立时间，再没有按记下的时间（retrieve/scope.js 的口径）。
//                     库里约三分之二的事实没有 event_start，原来按时间圈事实要扫整张表；
//   episodes_t_end    情节和时间窗有重叠 = t_end ≥ 窗的开头 且 t_start ≤ 窗的结尾。原来只有 (t_start, t_end)：问「今天」这种
//                     靠近现在的窗，按 t_start ≤ 结尾要从最早的一段走到今天；按 t_end 走只走今天这一截；
//   raw_windows_t_end 原文窗口同一个道理（只建在还有原文的窗口上，和 raw_windows_t_start 一样）。
// 离现在远的窗（去年某天）照旧走 t_start 那个索引，scope.js 按窗离库里最早、最晚的时间哪头近挑一个。
export default {
  version: 20,
  name: 'retrieve-scope-indexes',
  owner: 'retrieve',
  tables: [],
  up(db) {
    db.exec(`
      CREATE INDEX assertions_when ON assertions(COALESCE(event_start, valid_from, recorded_at));
      CREATE INDEX episodes_t_end ON episodes(t_end);
      CREATE INDEX raw_windows_t_end ON raw_windows(t_end) WHERE text IS NOT NULL;
    `);
  },
};
