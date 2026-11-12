// 022 · admin：管理页按时间看记忆用的三个索引（D159）。只加索引，不建表、不改列；表照旧归 intake。
//   percepts_setting_at    原话按场合、按说话的时间翻页 / 跳转 / 按天计数（「前后」就是这个场合里按时间往两头翻）。原来只有 (setting_key, id)：
//                          回填的历史消息 id 和 at 不同序，按 at 排要把整个场合的原话取出来再排一遍；单靠 percepts_at 走、边走边按场合筛，
//                          场合小的时候要走过大半张表。
//   raw_windows_t_end_all  原文片段按结束时间翻页。现有的 raw_windows_t_end 只建在还有原文的窗口上（WHERE text IS NOT NULL），
//                          管理页连过了保留期的也列，用不上它。
//   raw_windows_setting_t_end  同上，按场合。
// 经历（episodes_setting / episodes_t_end）、事实（表小）、意图、核对、隐藏的现有索引够用，不加。
export default {
  version: 22,
  name: 'admin-timeline-indexes',
  owner: 'admin',
  tables: [],
  up(db) {
    db.exec(`
      CREATE INDEX percepts_setting_at ON percepts(setting_key, at);
      CREATE INDEX raw_windows_t_end_all ON raw_windows(t_end);
      CREATE INDEX raw_windows_setting_t_end ON raw_windows(setting_key, t_end);
    `);
  },
};
