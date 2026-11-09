// 015 · intake：场合的名字（D111）。只加列，不建表。
//   settings.label        生效的称呼（她心里、管理页、提示词都读它）= owner_label，没有就是 adapter_label；
//   adapter_label         适配器最近一次给的 label（快照里也有，这里是当前那份，好在主人清掉自己的名字时退回）；
//   label_kind            'name' 真名 / 'description' 一句说法（不当名字认，她心里不加引号）；NULL = 这一列出现之前写的，
//                         下一次描述到来时 intake 按「旧的 label 不知道是不是名字」把实体上旧的 label 名字清掉重记（entities.ensureSettingEntity 的 resetLabels）；
//   label_hint            只给管理页的区分提示（短码、人数），不进快照、不进任何提示词；
//   owner_label / _at     主人在管理页起的名字和时间：优先于一切，适配器改不了，清掉退回自动。
// 回填：adapter_label = label（迁移之前 label 就是适配器给的）。备份是整库快照，新列跟着走（§12.4.1）。
export default {
  version: 15,
  name: 'intake-setting-names',
  owner: 'intake',
  tables: [],
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN adapter_label TEXT;
      ALTER TABLE settings ADD COLUMN label_kind TEXT CHECK (label_kind IN ('name','description'));
      ALTER TABLE settings ADD COLUMN label_hint TEXT;
      ALTER TABLE settings ADD COLUMN owner_label TEXT;
      ALTER TABLE settings ADD COLUMN owner_label_at INTEGER;
      UPDATE settings SET adapter_label = label;
    `);
  },
};
