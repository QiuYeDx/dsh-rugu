// DSH 插件入口（§10.1）：一个全局 Cordis 插件 dsh-rugu（行 id persona-memory），服务名 personaMemory。
// 宿主集成全部在 host/：apply 同步挂好钩子、提供服务外壳，数据库在后台打开（打开之前钩子一律放行）；返回的函数在插件卸载时关库。
// 别的插件里的适配器（bili-eyes）必须在 ctx.inject(['personaMemory'], (sub) => sub.personaMemory.registerAdapter(a)) 里注册：
// 记忆插件重载后服务重新提供，回调会再跑一次，注册不会丢（评审:AR-18）。
// 插件自己的 Agent 预设（D112，preset/）和集成层分开起：集成层起不来、核心打不开时预设也照样注册——
// 用它开过的旧会话要靠它才打得开（DSH 恢复会话时找不到预设 id 就拒绝）。
import { createHost, SERVICE_NAME } from './host/index.js';
import { createPersonaPreset } from './preset/index.js';

export const name = 'dsh-rugu';
export const inject = ['tools', 'connection'];
export { SERVICE_NAME };

/**
 * @param {object} ctx     Cordis 上下文
 * @param {object} [config]  Cordis 行的 config（配置文件 ~/.dsh/persona-memory.json 优先）
 * @returns {() => Promise<void>}
 */
export function apply(ctx, config) {
  let host = null;
  const plog = (level) => (event, fields) => {
    try {
      if (host?.log?.[level]) { host.log[level](event, fields); return; }
      ctx?.logger?.[level]?.(`[persona-memory] ${event}${fields?.error ? `：${fields.error}` : ''}`);
    } catch { /* 忽略 */ }
  };
  let preset = null;
  try {
    preset = createPersonaPreset({ ctx, hostConfig: () => host?.configStore?.host?.() ?? {}, log: { warn: plog('warn'), info: plog('info') } });
  } catch { preset = null; }
  try { host = createHost(ctx, config ?? {}, { preset, firstRun: true }); } catch (e) {
    // 插件出错只让插件不可用，不能让 DSH 起不来
    try { ctx?.logger?.error?.(`[persona-memory] 启动失败：${e?.code ?? e?.name ?? 'Error'}`); } catch { /* 忽略 */ }
    host = null;
  }
  try { preset?.start(); } catch { /* 预设注册不上只在自检里报 */ }
  return async () => {
    await Promise.allSettled([Promise.resolve().then(() => host?.dispose?.()), Promise.resolve().then(() => preset?.stop?.())]);
  };
}
