// 019 · encode：事实最近一次被确认的时间（D142）。只加列，不建表。
//   assertions.confirmed_at  本人或有权限的人最近一次确认「这件事（还）是这样」的时间（证据消息的时间）；没确认过是 NULL。
//                            状态类事实的成立概率（dynamics.pHold）从 valid_from 和它当中较晚的那个开始衰减：
//                            确认等于「到这时还成立」，不等于「从这时才成立」。
//   以前确认是直接把 valid_from 改成确认的时刻（「三年前搬来的」被再确认一次，成立时间就成了今天），这里不修旧数据：
//   原来的 valid_from 可能是模型从原话里读出来的时间，库里没有别处记着它（改写没留历史，来源只记消息的时间），恢复不了。
//   受影响的只是有 t50 的状态类事实里被确认过的那些（旧代码只改了这些）。
export default {
  version: 19,
  name: 'encode-confirmed-at',
  owner: 'encode',
  tables: [],
  up(db) {
    db.exec('ALTER TABLE assertions ADD COLUMN confirmed_at INTEGER;');
  },
};
