// entities 的参数（§5.2、§6.9）。数值都在 config/defaults.js 的 entities 段（唯一的来源，【建议】默认值），
// 这里只负责每次现取（热加载）。
import { DEFAULTS } from '../config/defaults.js';

/** entities 段的默认值（就是 DEFAULTS.entities，给想看默认值的地方用）。 */
export const ENTITY_DEFAULTS = DEFAULTS.entities;

/**
 * 当前生效的参数（每次用都现取，热加载）。mergeConfig 保证快照里的键是全的。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {typeof DEFAULTS.entities}
 */
export function entityParams(core) {
  return core.config.get().entities ?? DEFAULTS.entities;
}

/** 本地日序号（「日子」按本地时间算，§6.9 / D19：time.tzOffsetMin，null = 本机时区）。 */
export function localDay(core, at) {
  const off = core.config.get().time?.tzOffsetMin;
  const offMin = typeof off === 'number' ? off : -new Date(at).getTimezoneOffset();
  return Math.floor((at + offMin * 60_000) / 86_400_000);
}
