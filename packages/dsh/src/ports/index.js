// 核心端口（§3.3）的 DSH 实现。核心是被动的库：时间、模型、调度、平台相关的清洗都从这里注入，换宿主只重写这一层。
//   Clock          系统时钟
//   LLMPort        包宿主的 ctx.llm.stream（llm.js）
//   EmbeddingPort  Ollama /api/embed 或 OpenAI 兼容接口（embedding.js）
//   RerankPort     可选的 llama-server（rerank.js）；没配 → 没有这个端口
//   BudgetPort     宽松 / 节省 / 不设上限三档预设和主人单独改的项、失控上限、余额保护（budget.js）
//   SelfProfile    私有 kit 的 core-self.md（self-profile.js）
//   Sanitizer      宿主的插值语法和【】，加各适配器的平台转义（sanitizer.js）
//   Logger         只记 id 和计数（../host/log.js）
//   Config         ~/.dsh/persona-memory.json，热加载（../host/config.js）
import { systemClock } from 'rugu-core';
import { createLlmPort } from './llm.js';
import { createEmbeddingPort } from './embedding.js';
import { createRerankPort } from './rerank.js';
import { createBudget } from './budget.js';
import { createSelfProfile } from './self-profile.js';
import { createSanitizer } from './sanitizer.js';

export { createLlmPort, createEmbeddingPort, createRerankPort, createBudget, createSelfProfile, createSanitizer };

/**
 * 一次装好全部端口。宿主服务一律懒取（插件重载、宿主服务晚到都不怕）。
 * @param {{
 *   ctxGet: (name: string) => any,
 *   configStore: import('../host/config.js').ConfigStore,
 *   paths: ReturnType<typeof import('../host/paths.js').resolvePaths>,
 *   governor?: object|null,
 *   log: object,
 *   clock?: {now: () => number},
 *   fetchImpl?: typeof fetch,
 * }} opt
 */
export function buildPorts({ ctxGet, configStore, paths, governor = null, log, clock = systemClock, fetchImpl = globalThis.fetch, embeddingKey = () => '' }) {
  const hostConfig = () => configStore.host();
  const now = () => clock.now();
  let llmRef = null;
  const budget = createBudget({
    coreConfig: configStore.core, hostConfig, file: paths?.budgetFile ?? null, now, log,
    providerOf: () => { try { return llmRef?.target?.().provider ?? null; } catch { return null; } },
  });
  const llm = createLlmPort({
    getLlm: () => ctxGet('llm'),
    getDefaultSelection: () => ctxGet('agentDefaultModel')?.currentSelection?.() ?? null,
    hostConfig, budget, log, now,
  });
  llmRef = llm;
  const embedding = createEmbeddingPort({ hostConfig, fetchImpl, governor, log, now, apiKey: embeddingKey });
  const rerank = createRerankPort({ hostConfig, governor, fetchImpl, log, now });
  const selfProfile = createSelfProfile({ hostConfig, log });
  const sanitizer = createSanitizer();
  /** 交给 createPersonaMemory 的那一份（缺的端口不给 = 不可用，核心按降级处理）。 */
  const core = { clock, llm, embedding, budget, selfProfile, sanitizer, logger: log, ...(rerank ? { rerank } : {}) };
  return {
    core, llm, embedding, rerank, budget, selfProfile, sanitizer,
    dispose() {
      for (const p of [llm, embedding, rerank, budget]) { try { p?.dispose?.(); } catch { /* 尽力 */ } }
    },
  };
}
