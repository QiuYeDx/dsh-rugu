// LLMPort（§3.3、§10.6）：自己包宿主的 ctx.llm.stream。宿主没有 purpose 字段（H4），用途、模型选择、排队、计数全在这里。
//   - 每个用途的模型在配置里写明、必须在允许清单里，不跟随宿主的默认模型；后台模型是精确 id deepseek-flash，思考关（附录 G）；
//   - 推理强度取模型支持的最低档，temperature 0.2；超时：提炼 60 秒，评估和审视 8 秒；
//   - 四条队列：提炼和夜间整理（并发 1、两次至少隔 5 秒、连续失败按 1 / 4 / 16 分钟退避），第二段评估（并发 2），外发审视（单独一条），
//     第一眼（use='glance'，并发 2，D106）；
//   - 用量从 usage 块取（未命中 / 命中 / 输出分开），报给 BudgetPort；失败的调用（超时、中止、报错）也报一次（D120），宿主报了用量就带上；宿主报余额用完（402：API key 提供方是 QUOTA，
//     DeepSeek 账号提供方改写成 ACCOUNT_QUOTA）时通知预算进余额保护（H5）。
// 失败一律抛错（带 code），核心按 fail closed / 降级处理。
import { TaskQueue } from './queue.js';
import { anySignal, abortError } from '../host/util.js';

// perceive（D116：她看过的媒体摘一句）和第一眼一样又小又快，排在第一眼那条队列里
const QUEUE_OF = { extract: 'bg', sleep: 'bg', summary: 'bg', appraise: 'appraise', rewrite: 'appraise', review: 'review', glance: 'glance', perceive: 'glance' };
const LOW_EFFORTS = ['off', 'none', 'minimal', 'low'];

const llmError = (code, message = code) => Object.assign(new Error(message), { code });
/** @deepseek-ai/dsh-llm 的 QUOTA_EXCEEDED_CODE 和 ACCOUNT_QUOTA_EXCEEDED_CODE。 */
export const QUOTA_CODES = Object.freeze(['QUOTA', 'ACCOUNT_QUOTA']);

/** 核心给的消息（{role, content: string}）→ 宿主的消息格式。 */
function toHostMessages(messages, target) {
  return (messages ?? []).map((m) => (m.role === 'assistant'
    ? { role: 'assistant', content: [{ type: 'text', text: String(m.content ?? '') }], source: { kind: 'model', provider: target.provider, model: target.model } }
    : { role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] }));
}

/**
 * @param {{getLlm: () => any, getDefaultSelection?: () => ({provider?: string}|null), hostConfig: () => object,
 *          budget?: {record?: Function, notifyQuota?: Function}, log?: object, now?: () => number}} opt
 */
export function createLlmPort({ getLlm, getDefaultSelection = () => null, hostConfig, budget = {}, log = { warn() {}, info() {} }, now = () => Date.now() }) {
  const cfg = () => hostConfig().llm;
  const queues = {
    bg: new TaskQueue({ concurrency: cfg().concurrency?.bg ?? 1, minSpacingMs: cfg().bgMinSpacingMs ?? 5000, now }),
    appraise: new TaskQueue({ concurrency: cfg().concurrency?.appraise ?? 2, now }),
    review: new TaskQueue({ concurrency: cfg().concurrency?.review ?? 1, now }),
    // 第一眼（D106）：单独一条，不和第二段、提炼抢；它只让分寸更准，排不上、失败了她照样知道
    glance: new TaskQueue({ concurrency: cfg().concurrency?.glance ?? 2, now }),
  };
  const efforts = new Map();       // provider/model → 档位（undefined = 不传）
  const stats = { calls: 0, failures: 0, byUse: {}, lastError: null, backoffUntil: 0, bgFailures: 0 };
  let closed = false;

  const providerOf = () => {
    const c = cfg();
    if (c.provider) return c.provider;
    try { const sel = getDefaultSelection(); if (sel?.provider) return sel.provider; } catch { /* 拿不到就用默认 */ }
    return 'deepseek-official';
  };
  const modelFor = (use) => {
    const c = cfg();
    const model = c.models?.[use];
    if (!model) throw llmError('NO_MODEL', `用途 ${use} 没有配置模型`);
    if (!(c.allow ?? []).includes(model)) throw llmError('MODEL_NOT_ALLOWED', `模型不在允许清单里（用途 ${use}）`);
    return model;
  };
  async function effortFor(llm, target) {
    const want = cfg().effort ?? 'lowest';
    if (want && want !== 'lowest') return want;
    const k = `${target.provider}/${target.model}`;
    if (efforts.has(k)) return efforts.get(k);
    let e;
    try {
      const info = await llm.resolveModelInfo?.(target.provider, target.model);
      const ids = (info?.reasoning?.efforts ?? []).map((x) => x?.id ?? x);
      e = LOW_EFFORTS.find((x) => ids.includes(x));
      if (!e && ids.length === 0 && info) e = undefined;
    } catch { e = undefined; }
    efforts.set(k, e);
    return e;
  }

  /** 宿主的 usage 块 → {in, cached, out}。in 是未命中缓存的输入（DSH 的 inputTokens 不含命中的那部分）；写缓存的也按未命中算。 */
  const usageOf = (usage) => ({
    in: (Number(usage?.inputTokens ?? usage?.input ?? 0) || 0) + (Number(usage?.cacheWriteTokens ?? 0) || 0),
    cached: Number(usage?.cacheReadTokens ?? usage?.cached ?? 0) || 0,
    out: Number(usage?.outputTokens ?? usage?.output ?? 0) || 0,
  });

  /**
   * @param {object} req
   * @param {string} use
   * @param {AbortSignal} signal
   * @param {{sent: boolean}} state  真正发给宿主了就置 true（失败的调用也要报给预算：钱可能已经花了）
   */
  async function callOnce(req, use, signal, state) {
    const llm = getLlm();
    if (!llm?.stream) throw llmError('NO_LLM', '宿主没有模型服务');
    const target = { provider: providerOf(), model: modelFor(use) };
    const effort = await effortFor(llm, target);
    const timeoutMs = cfg().timeoutMs?.[use] ?? 20_000;
    const sig = anySignal([signal, AbortSignal.timeout(timeoutMs)]);
    const opts = {
      provider: target.provider, model: target.model, system: String(req.system ?? ''), messages: toHostMessages(req.messages, target),
      maxTokens: req.maxTokens ?? 2000, temperature: cfg().temperature ?? 0.2, signal: sig, ...(effort ? { reasoningEffort: effort } : {}),
    };
    let text = '';
    let usage = null;
    let finish = null;
    const timedOut = () => sig.aborted && signal?.aborted !== true;
    // 失败时宿主报过用量就带上（结果丢了，钱照样花了）
    const fail = (e) => (usage ? Object.assign(e, { usage: usageOf(usage) }) : e);
    state.sent = true;
    try {
      for await (const ch of llm.stream(opts)) {
        if (ch?.type === 'text-delta' && typeof ch.text === 'string') text += ch.text;
        else if (ch?.type === 'usage') usage = ch.usage;
        else if (ch?.type === 'finish') finish = ch;
      }
    } catch (e) {
      if (timedOut()) throw fail(llmError('TIMEOUT'));
      throw fail(e && typeof e === 'object' ? e : llmError('LLM_ERROR'));
    }
    const kind = finish?.reason?.kind;
    if (kind === 'error' || kind === 'aborted') {
      const code = finish.reason.failure?.code ?? (kind === 'aborted' ? 'ABORTED' : 'LLM_ERROR');
      throw fail(llmError(timedOut() ? 'TIMEOUT' : code));
    }
    if (!finish && timedOut()) throw fail(llmError('TIMEOUT'));
    const u = usageOf(usage);
    // 宿主没报用量：按字数估（约 1.5 字一个 token），预算里单独记成 estimated
    if (!usage) { u.in = Math.round((String(req.system ?? '').length + JSON.stringify(req.messages ?? []).length) / 1.5); u.out = Math.round(text.length / 1.5); }
    return { text, usage: u, model: target.model, estimated: !usage };
  }

  return {
    /**
     * @param {{use: string, system: string, messages: {role: string, content: string}[], maxTokens?: number, signal?: AbortSignal, meta?: {sourceKey?: string}}} req
     * @returns {Promise<{text: string, usage: {in: number, cached: number, out: number}, model: string}>}
     */
    async complete(req) {
      if (closed) throw llmError('CLOSED');
      const use = req?.use;
      const qn = QUEUE_OF[use];
      if (!qn) throw llmError('BAD_USE', `不认识的用途 ${use}`);
      if (qn === 'bg' && stats.backoffUntil > now()) throw llmError('LLM_BACKOFF');
      const q = queues[qn];
      return q.run(async (signal) => {
        if (signal?.aborted) throw abortError();
        stats.calls += 1;
        stats.byUse[use] = (stats.byUse[use] ?? 0) + 1;
        const state = { sent: false };
        try {
          const { estimated, ...r } = await callOnce(req, use, signal, state);
          if (qn === 'bg') { stats.bgFailures = 0; stats.backoffUntil = 0; }
          try { budget.record?.(use, r.usage, { sourceKey: req.meta?.sourceKey, ...(estimated ? { estimated: true } : {}) }); } catch { /* 计数失败不影响结果 */ }
          return r;
        } catch (e) {
          stats.failures += 1;
          stats.lastError = e?.code ?? e?.name ?? 'Error';
          // 真正发出去了的才算一次调用（没配模型、没有模型服务这类没发出去的不算）；宿主报了用量就照记
          if (state.sent) { try { budget.record?.(use, e?.usage ?? null, { sourceKey: req.meta?.sourceKey, failed: true }); } catch { /* 忽略 */ } }
          if (QUOTA_CODES.includes(e?.code)) { try { budget.notifyQuota?.(); } catch { /* 忽略 */ } }
          if (qn === 'bg' && e?.code !== 'ABORTED' && e?.name !== 'AbortError') {
            const steps = cfg().backoffMin ?? [1, 4, 16];
            const m = steps[Math.min(stats.bgFailures, steps.length - 1)] ?? 1;
            stats.bgFailures += 1;
            stats.backoffUntil = now() + m * 60_000;
          }
          log.warn('llm.failed', { use, error: stats.lastError });
          throw e;
        }
      }, { priority: use === 'review' ? 0 : use === 'appraise' ? 1 : 5, signal: req.signal });
    },
    /** 现在会用哪个提供方和模型（自检、管理页）。 */
    target(use = 'extract') { return { provider: providerOf(), model: cfg().models?.[use] ?? null, allowed: (cfg().allow ?? []).includes(cfg().models?.[use]) }; },
    status() {
      return { calls: stats.calls, failures: stats.failures, byUse: { ...stats.byUse }, lastError: stats.lastError,
        backoffUntil: stats.backoffUntil || null, queued: { bg: queues.bg.size, appraise: queues.appraise.size, review: queues.review.size, glance: queues.glance.size } };
    },
    dispose() { closed = true; for (const q of Object.values(queues)) q.clear(); },
  };
}
