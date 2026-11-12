// 023 · admin：管理页「记忆」的合并列表（D171，admin/feed.js）按时间翻页用的三个索引。只加索引，不建表、不改列；表照旧归 encode。
//   assertions_recorded         事实按记下的时间翻页（D159 时判断事实表小、不加；混排以后「全部」每一页都要按它取，几千条时不想每页整表排序）。
//   assertions_lesson_updated   经验按最近改过的时间翻页：只建在 kind_hint = 'lesson' 的行上（经验很少，不用为它扫整张事实表）。
//   intentions_formed           打算按想起的时间翻页。
// 经历用现有的 episodes_t_end（020）。
export default {
  version: 23,
  name: 'admin-feed-indexes',
  owner: 'admin',
  tables: [],
  up(db) {
    db.exec(`
      CREATE INDEX assertions_recorded ON assertions(recorded_at);
      CREATE INDEX assertions_lesson_updated ON assertions(updated_at) WHERE kind_hint = 'lesson';
      CREATE INDEX intentions_formed ON intentions(formed_at);
    `);
  },
};
