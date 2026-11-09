// 记忆引用：核心内部用来指一个记忆单元的字符串（RecallItem.id、appraisalRef、evidence_ids……）。
// 格式是核心自己定的（一个字母 + 主表 id），所以核心可以解析它；对调用方它是不透明的。
// 注意：这和适配器给的 SettingId / ObsId 不同，那些核心永远不解析（§2.2）。

/** owner_kind → 前缀字母。所有 owner_kind 列的 CHECK 都是这几个值。 */
export const OWNER_KINDS = Object.freeze({
  percept: 'p',
  window: 'w',
  episode: 'e',
  assertion: 'a',
  entity: 'n',
  impression: 'i',
  intention: 't',
  storyline: 's',
  community: 'c',
  link: 'l',
});
const BY_PREFIX = Object.freeze(Object.fromEntries(Object.entries(OWNER_KINDS).map(([k, p]) => [p, k])));
/** owner_kind → 主表。 */
export const OWNER_TABLES = Object.freeze({
  percept: 'percepts',
  window: 'raw_windows',
  episode: 'episodes',
  assertion: 'assertions',
  entity: 'entities',
  impression: 'entity_impressions',
  intention: 'intentions',
  storyline: 'storylines',
  community: 'communities',
  link: 'entity_links',
});

/** @typedef {{kind: keyof typeof OWNER_KINDS, id: number}} MemoryRef */

/**
 * (kind, id) → 'a123'。
 * @param {keyof typeof OWNER_KINDS} kind
 * @param {number} id
 */
export function refOf(kind, id) {
  const p = OWNER_KINDS[kind];
  if (!p) throw new Error(`不认识的记忆种类：${kind}`);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`记忆 id 应为正整数：${id}`);
  return `${p}${id}`;
}

/**
 * 'a123' → {kind: 'assertion', id: 123}；格式不对返回 null。
 * @returns {MemoryRef|null}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.length < 2 || ref.length > 24) return null;
  const kind = BY_PREFIX[ref[0]];
  const id = Number(ref.slice(1));
  if (!kind || !Number.isInteger(id) || id <= 0 || String(id) !== ref.slice(1)) return null;
  return { kind: /** @type {keyof typeof OWNER_KINDS} */ (kind), id };
}

export const isRef = (ref) => parseRef(ref) !== null;
