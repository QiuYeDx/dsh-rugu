// admin 读参数：每次读当前快照（热加载）；数值只在 config/defaults.js（D25），这里不写第二份。
import { defaultAt } from '../config/defaults.js';

/**
 * 参数快照里的一项（'retention.coolingOffDays'）。快照由 mergeConfig 合出来，键是全的；只有测试里手搭的 core 缺键时退回 DEFAULTS。
 * @param {object} core
 * @param {string} path
 * @returns {any}
 */
export function param(core, path) {
  let v = core.config.get();
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') { v = undefined; break; }
    v = v[k];
  }
  return v ?? defaultAt(path);
}
