// 014 · discretion：第一眼 glance-2（D110）。只加一列、一个索引，不回填（旧行的 follows 是 NULL，按「第一眼 glance-1 看过的旧行」退回切段）。
//   follows：这句话是在照着他前面跟她定好的哪一句做（按定好的玩法报的一步），那一句的感知 id（代码核对过：同一个人、同一场合、更早）；
//   glances_replaces：反查「哪一句被后来的哪一句改掉了」（discretion.supersededBy，普通回想的「（后来换了新的）」）。
// 级联：admin.purge 删感知时把指向它的 replaces / follows 一起清掉（§2.3）。
export default {
  version: 14,
  name: 'discretion-glance-follows',
  owner: 'discretion',
  tables: [],
  up(db) {
    db.exec(`
      ALTER TABLE glances ADD COLUMN follows INTEGER;
      CREATE INDEX glances_replaces ON glances(replaces) WHERE replaces IS NOT NULL;
    `);
  },
};
