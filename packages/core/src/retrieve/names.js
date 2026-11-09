// 怎么称呼一个实体（窗口文字、渲染用）。只读档案（entities.profile），不认人、不合并。
//   - 她自己：渲染给她看的文字里是「你」（注入块整体是对她说的，§10.4）；窗口文字里写「我」；
//   - 有管理权限、而且只有这一位的人：她对他的称呼（selfProfile.principalLabel，§3.3「只用于渲染」）；
//   - 其余：这个场合里大家怎么叫他（群名片只在本场合有效）→ 档案上最完整的名字 → 最常用的名字 → 关系描述（「阿明的表哥」）。

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {number|null} entityId
 * @param {{settingKey?: string|null, self?: string, someone?: string, cache?: Map<number, string>, principalLabel?: string|null, depth?: number}} [o]
 * @returns {string}
 */
export function nameOf(core, entityId, o = {}) {
  const someone = o.someone ?? '某人';
  if (entityId == null) return someone;
  const key = entityId;
  if (o.cache?.has(key)) return o.cache.get(key);
  let prof = null;
  try { prof = core.mods.entities.profile(core, entityId); } catch { prof = null; }
  let name = someone;
  if (prof) {
    if (prof.isSelf) name = o.self ?? '我';
    else if (prof.bond?.authority === 'principal' && o.principalLabel) name = o.principalLabel;
    else {
      const names = Array.isArray(prof.names) ? prof.names : [];
      const scoped = names.filter((n) => o.settingKey && n.scopeSettingKey === o.settingKey && n.text)
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.last ?? 0) - (a.last ?? 0))[0];
      const common = [...names].filter((n) => n.text && !n.scopeSettingKey)
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.last ?? 0) - (a.last ?? 0))[0]
        ?? [...names].filter((n) => n.text).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
      name = scoped?.text || prof.displayName || common?.text || '';
      if (!name && (o.depth ?? 0) < 1) {
        const d = (prof.descriptors ?? [])[0];
        if (d?.relation || d?.text) {
          const anchor = nameOf(core, d.anchor, { ...o, cache: undefined, depth: (o.depth ?? 0) + 1 });
          name = `${anchor}的${d.text || d.relation}`;
        }
      }
      if (!name) name = someone;
    }
  }
  o.cache?.set(key, name);
  return name;
}

/**
 * 只有一位主体有管理权限时，她对他的称呼；否则 null（多位管理者时不能混用同一个称呼）。
 * @param {import('../core-types.js').CoreContext} core
 */
export function principalLabelOf(core) {
  try {
    const label = core.ports.selfProfile?.principalLabel?.() || '';
    if (!label) return null;
    const ps = core.mods.entities.principals(core);
    return Array.isArray(ps) && ps.length === 1 ? label : null;
  } catch { return null; }
}
