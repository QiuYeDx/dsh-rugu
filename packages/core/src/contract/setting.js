// 从场合描述推出来的几个量（纯函数）。核心只按这些属性推理，不按场合的类别名（§2.2、§9.3.1）。
import crypto from 'node:crypto';

/**
 * 公开程度（§9.3.1）：0 一对一 < 1 封闭群 < 2 开放群或有不认识的旁观者 < 3 任何人可见。
 * @param {import('./types.js').SettingDescriptor} d
 * @returns {0|1|2|3}
 */
export function exposureRank(d) {
  if (d.disclosure.visibleTo === 'anyone') return 3;
  if (d.audience.entry === 'open' || d.audience.unknownObservers) return 2;
  if (isOneOnOne(d)) return 0;
  return 1;
}

/** 留存程度：0 不留存 < 1 参与者可翻记录 < 2 公开留存。 */
export function persistenceRank(d) {
  return /** @type {0|1|2} */ ({ ephemeral: 0, logged: 1, 'public-permanent': 2 }[d.disclosure.persistence] ?? 1);
}

/** 一对一：只有两个人，内容只对参与者可见。 */
export function isOneOnOne(d) {
  return d.audience.size === 2 && d.disclosure.visibleTo === 'participants';
}

/** 任何人可见或公开留存（§9.3.2 B2、§9.4.3 的「公开场合」）。 */
export function isPublicLike(d) {
  return d.disclosure.visibleTo === 'anyone' || d.disclosure.persistence === 'public-permanent';
}

/**
 * 「可见范围」的指纹：只含决定谁能看到、留多久的属性，不含人数和称呼。
 * 两份快照的指纹不同，再用 exposureRank / persistenceRank 比较是不是变大了（§9.3.2 A1(b)）。
 */
export function reachHash(d) {
  const reach = [d.disclosure.visibleTo, d.disclosure.persistence, d.disclosure.searchable ? 1 : 0,
    d.audience.entry, d.audience.unknownObservers ? 1 : 0, d.audience.membersKnown];
  return crypto.createHash('sha256').update(JSON.stringify(reach)).digest('hex').slice(0, 16);
}

/** b 的可见范围比 a 大吗（任何一个维度变大都算）。 */
export function reachGrew(a, b) {
  return exposureRank(b) > exposureRank(a) || persistenceRank(b) > persistenceRank(a)
    || (!a.disclosure.searchable && b.disclosure.searchable);
}
