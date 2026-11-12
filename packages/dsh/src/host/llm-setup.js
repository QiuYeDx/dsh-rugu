// 后台模型的设置（D168，管理页「设置 → 后台模型」和首次设置向导里的同一张卡片）：
//   list   DSH 里有哪些服务商和模型、现在选的是哪一对、建议的是哪一对（不花钱：只读 DSH 的目录）；
//   test   「试一下」：两次很小的真实请求（编造的内容），结果说人话；过预算（用途 test）；
//   save   选定一对 / 「不用后台模型」/ 「高级」里第一眼、提炼单独的一对 / 「不工作时用聊天模型顶上」的开关——写进配置文件 host.llm；
//          管理页只给主人，主人点「用这个」就是确认（允许清单的原意：后台不能被悄悄换成贵的模型——配置文件被别的东西改了照样先扣下）；
//   status 健康状态、是不是在顶着、正在补的积压；summary 诊断里「复制后台模型状态」的那一段（不含聊天内容、地址、Key）。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLlmPair } from './config.js';

/** 插件版本（诊断摘要里用）。读不到就是 null。 */
export function pluginVersion() {
  try { return JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version ?? null; } catch { return null; }
}

/**
 * @param {{llm: any, setConfig: (patch: object, opt?: object) => any, hostConfig: () => any, getPm: () => any}} d
 */
export function createLlmSetup({ llm, setConfig, hostConfig, getPm }) {
  /** 正在补之前没整理的几段（核心的 waitingLlm；库没开就是 null）。 */
  const catchUp = () => {
    try { const n = getPm()?.status?.()?.extract?.waitingLlm; return Number.isFinite(n) ? n : null; } catch { return null; }
  };
  return {
    list: () => llm.list(),
    /** @param {{provider: string, model: string}|null} pair */
    test: (pair) => llm.test(isLlmPair(pair) ? pair : undefined),
    status: () => ({ ...llm.health(), catchUp: catchUp() }),
    summary: () => ({ plugin: pluginVersion(), ...llm.summary() }),
    /**
     * @param {{target?: {provider: string, model: string}|'off', perUse?: {glance?: object|null, extract?: object|null}, fallbackToChat?: boolean}} p
     */
    save(p) {
      const patch = {};
      if (p.target !== undefined) patch.target = p.target === 'off' ? 'off' : { provider: p.target.provider, model: p.target.model };
      if (p.perUse) {
        patch.perUse = {};
        for (const u of ['glance', 'extract']) if (p.perUse[u] !== undefined) patch.perUse[u] = p.perUse[u] ? { provider: p.perUse[u].provider, model: p.perUse[u].model } : null;
      }
      if (typeof p.fallbackToChat === 'boolean') patch.fallbackToChat = p.fallbackToChat;
      const r = setConfig({ host: { llm: patch } }, { confirm: true });
      return { ok: true, warnings: r?.warnings ?? [], llm: { target: hostConfig().llm?.target ?? null, perUse: { ...(hostConfig().llm?.perUse ?? {}) }, fallbackToChat: hostConfig().llm?.fallbackToChat !== false } };
    },
  };
}
