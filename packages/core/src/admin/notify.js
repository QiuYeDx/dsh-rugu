// 主人改了会影响她上下文的东西之后，通知别的模块（只标脏、只让缓存失效，不抛错，提交之后才做）。
//   - 常驻区（context.markResidentDirty）：只标脏，等下一条真实消息或压缩结束才换文本（§10.4 的冻结规则不变）；
//     context 不在时，常驻区过了 context.residentStaleMin 也会当脏处理。
//   - 名字表（entities.invalidateNames）：彻底删除的级联删了档案、名字或身份证据之后，名字匹配器要重建。

function afterCommit(core, fn) {
  const run = () => { try { fn(); } catch { /* 通知失败不影响主人的操作 */ } };
  try { core.store.afterCommit(run); } catch { run(); }
}

/**
 * 常驻区标脏。settingKey 不给 = 全部场合。
 * @param {object} core
 * @param {string|null} [settingKey]
 */
export function residentDirty(core, settingKey = null) {
  afterCommit(core, () => {
    if (typeof settingKey === 'string' && settingKey) core.mods.context.markResidentDirty(core, settingKey);
    else core.mods.context.markResidentDirty(core);
  });
}

/** 名字表被 admin 改过（彻底删除、墓碑重删）。 */
export function namesChanged(core) {
  afterCommit(core, () => core.mods.entities.invalidateNames(core));
}
