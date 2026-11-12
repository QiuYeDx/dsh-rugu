// 021 · discretion：第一眼 glance-3（D158）——一句话是不是在跟她说，按意思判断，不只按有没有 @。只加两列，不回填
// （旧行两列都是 NULL：没判断过，结构上是什么就是什么）。
//   addressee：第一眼判断这句话是对谁说的——her（对她说的）/ all（对包括她在内的大家说的）/ others（对别人说的）/ unclear（看不出来）；
//              她自己的行、模型没给或给得不合法的是 NULL；
//   raised：第一眼据此把这句话的 percepts.addressed 抬到了什么（to-her / mentions-her）；没抬是 NULL。结构上本来就是对她说的
//           （@、引用、一对一）不抬也不降；抬只从 ambient 往上（intake.raiseAddressed）。管理页据此标「按意思判断」，
//           discretion.withoutAddress 据此知道这句话里的 @ 不是在叫她。
// 级联：跟着 glances 的行走（admin.purge 删感知时一起删）。
export default {
  version: 21,
  name: 'discretion-glance-addressee',
  owner: 'discretion',
  tables: [],
  up(db) {
    db.exec(`
      ALTER TABLE glances ADD COLUMN addressee TEXT CHECK (addressee IS NULL OR addressee IN ('her','all','others','unclear'));
      ALTER TABLE glances ADD COLUMN raised TEXT CHECK (raised IS NULL OR raised IN ('to-her','mentions-her'));
    `);
  },
};
