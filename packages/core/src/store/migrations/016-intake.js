// 016 · intake：场合的名字从哪来（D111 评审）。只加列，不建表。
//   settings.label_origin  适配器给的真名（label_kind='name'）从哪来：'config' 部署的人写在配置里的 / 'platform' 平台上的（群名、
//                          机器人的备注：群里的人起的，主人没过目）。说法（description）是 NULL。平台上的名字是那个场合的人知道的事：
//                          关口①把它当涉及别人的、圈子是那里的成员和管理者（discretion，§5.8），名字证据记成 kind 'account'（会被保留名冒用检查）。
//                          NULL 且这一次是平台上的名字：这一行是 016 之前写的（015 把平台名记成了 kind 'label'），
//                          intake 下一次描述时清掉那时记的 label 名字按现在的重记（entities.ensureSettingEntity 的 resetLabels，只这一次）。
// 015 已经在真实安装上跑过，不改它（§12.5）：要改 schema 只往后加。
export default {
  version: 16,
  name: 'intake-label-origin',
  owner: 'intake',
  tables: [],
  up(db) {
    db.exec(`ALTER TABLE settings ADD COLUMN label_origin TEXT CHECK (label_origin IN ('config','platform'));`);
  },
};
