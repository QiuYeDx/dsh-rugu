// LLMPort（§3.3、§10.6）：自己包宿主的 ctx.llm.stream。宿主没有 purpose 字段（H4），用途、模型选择、排队、计数全在这里。
//   - 后台用哪一对「服务商 + 模型」（D168）：配置里钉住的那一对（host.llm.target；第一眼、提炼可以在「高级」里单独指定，perUse）；
//     还没选的（升级前的配置）照以前解析——服务商：配置 → DSH 当前默认的服务商；模型：各用途的 models，要在允许清单里——第一次成功就把
//     那一对自动钉住（host-llm.json），之后不再跟着 DSH 的默认服务商变。没有写死的兜底：一对都选不出来就报 NO_PROVIDER（配置类）；
//   - 推理强度取模型支持的最低档，temperature 0.2；超时：提炼 60 秒，评估和审视 8 秒；
//   - 四条队列：提炼和夜间整理（并发 1、两次至少隔 5 秒、连续失败按 1 / 4 / 16 分钟退避），第二段评估（并发 2），外发审视（单独一条），
//     第一眼（use='glance'，并发 2，D106）；
//   - 用量从 usage 块取（未命中 / 命中 / 输出分开），报给 BudgetPort；失败的调用（超时、中止、报错）也报一次（D120），宿主报了用量就带上；宿主报余额用完（402：API key 提供方是 QUOTA，
//     DeepSeek 账号提供方改写成 ACCOUNT_QUOTA）时通知预算进余额保护（H5）。
//   - 健康状态（D168，llm-health.js）：每一对记成功和错误；配置类的错一次就判「不工作」，之后不再白调（直接抛 LLM_DOWN），
//     每 probeMs 拿一次真实的调用去试原来那一对；开着「不工作时用聊天模型顶上」（fallbackToChat，默认开）时，这段时间改用 DSH 当前聊天的那一对，
//     通了就换回。错误上带通用的类别 kind（'config' / 'off' / 'quota' / 'transient' / 'output'），核心只看它（提炼不为配置类的错计重试）；
//     恢复（不工作 → 通了、关 → 开、试一下通了）时调 onRecover，宿主叫核心把推迟的提炼提到现在补。
// 失败一律抛错（带 code），核心按 fail closed / 降级处理。
import { llmTrial } from 'rugu-core';
import { TaskQueue } from './queue.js';
import { anySignal, abortError } from '../host/util.js';
import { HOST_DEFAULTS } from '../host/config.js';
import { createLlmState, errorKind, pairKey, CONFIG_CODES, QUOTA_CODES } from './llm-health.js';

export { CONFIG_CODES, QUOTA_CODES, errorKind, pairKey };

// perceive（D116：她看过的媒体摘一句）和第一眼一样又小又快，排在第一眼那条队列里；test 是管理页的「试一下」（D168），不排队
const QUEUE_OF = { extract: 'bg', sleep: 'bg', summary: 'bg', appraise: 'appraise', rewrite: 'appraise', review: 'review', glance: 'glance', perceive: 'glance' };
/** 能在「高级」里单独指定一对的用途（D168）：第一眼要快，提炼要好；别的跟着 target。 */
export const PER_USE = Object.freeze(['glance', 'extract']);
const LOW_EFFORTS = ['off', 'none', 'minimal', 'low'];
/** 宿主 finish.reason.kind → 端口的 stopReason（D141）。 */
const STOP_OF = { stop: 'end', 'max-tokens': 'length', 'tool-calls': 'other' };
/** 内置价目认识的那几对（host.budget.prices 是 DeepSeek flash 的价，附录 G）：别的对管理页不显示元（D168）。 */
const PRICED_PROVIDERS = new Set(['deepseek-account', 'deepseek-official']);
const PRICED_MODELS = new Set(['deepseek-flash']);
/** DeepSeek 自己的两条通道（新装时的建议值：有它、目录里有 deepseek-flash 就建议这一对）。 */
const DEEPSEEK_PROVIDERS = ['deepseek-account', 'deepseek-official'];
const SUGGEST_MODEL = 'deepseek-flash';
/** 试一下：第一眼超过这么久就算「太慢」（回话前等第一眼最多 1.5–8 秒）；提炼超过这么久算慢。 */
const SLOW_GLANCE_MS = 3000;
const SLOW_EXTRACT_MS = 45_000;

const llmError = (code, message = code, kind = undefined) => Object.assign(new Error(message), { code, ...(kind ? { kind } : {}) });
const isPair = (v) => !!v && typeof v === 'object' && typeof v.provider === 'string' && v.provider !== '' && typeof v.model === 'string' && v.model !== '';
const samePair = (a, b) => isPair(a) && isPair(b) && a.provider === b.provider && a.model === b.model;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codeOf = (e) => e?.code ?? e?.name ?? 'Error';
/** 一对的定价认不认得（D168：不认得的管理页不显示元，只记用量）。 */
export const pricedPair = (p) => isPair(p) && PRICED_PROVIDERS.has(p.provider) && PRICED_MODELS.has(p.model);
/** 服务商的类型（诊断摘要里用：别的服务商的 id 可能是主人自己起的名字，只说是别的）。 */
export const providerKind = (id) => (id === 'deepseek-account' ? 'deepseek-account' : id === 'deepseek-official' ? 'deepseek-api-key' : id ? 'other' : null);

/** 核心给的消息（{role, content: string}）→ 宿主的消息格式。 */
function toHostMessages(messages, target) {
  return (messages ?? []).map((m) => (m.role === 'assistant'
    ? { role: 'assistant', content: [{ type: 'text', text: String(m.content ?? '') }], source: { kind: 'model', provider: target.provider, model: target.model } }
    : { role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] }));
}
/** 等一个 Promise，最多 ms（宿主的目录查询可能要联网）。 */
async function within(ms, fn) {
  let t;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => { t = setTimeout(() => rej(llmError('TIMEOUT')), ms); t.unref?.(); })]);
  } finally { clearTimeout(t); }
}

/**
 * @param {{getLlm: () => any, getDefaultSelection?: () => ({provider?: string, model?: string, reasoningEffort?: string}|null), hostConfig: () => object,
 *          budget?: {record?: Function, notifyQuota?: Function, allow?: Function}, log?: object, now?: () => number,
 *          stateFile?: string|null, onRecover?: (why: string) => void}} opt
 *   stateFile：健康状态和自动钉住的那一对存在哪（host-llm.json；null = 只在内存里）；onRecover：后台模型恢复了（宿主叫核心补积压）
 */
export function createLlmPort({ getLlm, getDefaultSelection = () => null, hostConfig, budget = {}, log = { warn() {}, info() {} }, now = () => Date.now(),
  stateFile = null, onRecover = () => {} }) {
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
  const health = createLlmState({ file: stateFile, now, log });
  let closed = false;
  /** 一对都选不出来（NO_PROVIDER 这类，没有对可以记在名下）：最近一次的错误。 */
  let resolveError = null;
  let lastMode = cfg().target === 'off' ? 'off' : 'on';

  const probeMs = () => (Number(cfg().probeMs) > 0 ? Number(cfg().probeMs) : 30 * 60_000);
  const defaultSel = () => { try { const s = getDefaultSelection(); return s && typeof s === 'object' ? s : null; } catch { return null; } };
  /** 升级前的配置：models / allow 是不是主人手写过的（手写过的照写的用，视为已经钉住）。 */
  const handWritten = () => !sameJson(cfg().models, HOST_DEFAULTS.llm.models) || !sameJson(cfg().allow, HOST_DEFAULTS.llm.allow);

  /**
   * 这个用途现在选定的是哪一对（不看健康状态）。
   * @returns {{off: true, source: 'off'} | {pair: {provider: string, model: string}, source: 'perUse'|'target'|'config'|'pinned'|'legacy'}}
   */
  function selection(use) {
    const c = cfg();
    if (c.target === 'off') return { off: true, source: 'off' };
    const per = PER_USE.includes(use) ? c.perUse?.[use] : null;
    if (isPair(per)) return { pair: { provider: per.provider, model: per.model }, source: 'perUse' };
    if (isPair(c.target)) return { pair: { provider: c.target.provider, model: c.target.model }, source: 'target' };
    // 还没选（升级前的配置）：照以前解析，只是没有写死的兜底
    const model = c.models?.[use];
    if (!model) throw llmError('NO_MODEL', `用途 ${use} 没有配置模型`, 'config');
    if (!(c.allow ?? []).includes(model)) throw llmError('MODEL_NOT_ALLOWED', `模型不在允许清单里（用途 ${use}）`, 'config');
    const pinned = health.pinned();
    const provider = c.provider || pinned?.provider || defaultSel()?.provider || '';
    if (!provider) throw llmError('NO_PROVIDER', '没有选定后台模型，DSH 也没有默认的模型', 'config');
    return { pair: { provider, model }, source: c.provider ? 'config' : pinned?.provider ? 'pinned' : 'legacy' };
  }
  /** 顶上用的那一对：DSH 当前聊天的那一对（服务商和模型一起）。开关关着、拿不到、就是出问题的那一对、它自己也不工作，都不顶。 */
  function fallbackFor(orig) {
    if (cfg().fallbackToChat === false) return null;
    const s = defaultSel();
    if (!isPair(s) || samePair(s, orig)) return null;
    const p = { provider: s.provider, model: s.model };
    const v = health.view(pairKey(p));
    if (v.state === 'down' && now() < v.nextProbeAt) return null;
    return p;
  }
  /**
   * 这一次按什么顺序试：正常 → 选定的那一对；不工作 → 到点了先试原来那一对（不通再顶上），没到点直接顶上；都不行抛 LLM_DOWN。
   * @returns {{pair: {provider: string, model: string}, via: 'target'|'probe'|'fallback'}[]}
   */
  function route(use) {
    let sel;
    try { sel = selection(use); resolveError = null; } catch (e) {
      resolveError = { code: codeOf(e), at: now() };
      health.setWaiting(true);
      throw e;
    }
    if (sel.off) { health.setWaiting(true); throw llmError('LLM_OFF', '主人选了不用后台模型', 'off'); }
    const key = pairKey(sel.pair);
    const v = health.view(key);
    if (v.state !== 'down') return [{ pair: sel.pair, via: 'target' }];
    const fb = fallbackFor(sel.pair);
    if (now() >= v.nextProbeAt) { health.probing(key, probeMs()); return [{ pair: sel.pair, via: 'probe' }, ...(fb ? [{ pair: fb, via: 'fallback' }] : [])]; }
    if (fb) return [{ pair: fb, via: 'fallback' }];
    health.setWaiting(true);
    throw llmError('LLM_DOWN', `后台模型不工作（${v.code ?? '配置有问题'}）`, 'config');
  }

  async function effortFor(llm, target) {
    const want = cfg().effort ?? 'lowest';
    if (want && want !== 'lowest') return want;
    const k = pairKey(target);
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
   * 对一对发一次。
   * @param {object} req
   * @param {{provider: string, model: string}} target
   * @param {number} timeoutMs
   * @param {AbortSignal|undefined} signal
   * @param {{sent: boolean}} state  真正发给宿主了就置 true（失败的调用也要报给预算：钱可能已经花了）
   */
  async function callOnce(req, target, timeoutMs, signal, state) {
    const llm = getLlm();
    if (!llm?.stream) throw llmError('NO_LLM', '宿主没有模型服务');
    const effort = await effortFor(llm, target);
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
    // 为什么停下（D141）：宿主的 finish 块给 stop / max-tokens / tool-calls（各家供应商的 length、max_tokens 都翻成 max-tokens）；
    // 没有 finish 块、或者是不认识的，就不带（核心有退路）
    const stopReason = STOP_OF[kind];
    return { text, usage: u, model: target.model, estimated: !usage, reported: !!usage, ...(stopReason ? { stopReason } : {}) };
  }

  /**
   * 健康状态（D168，管理页、自检、提醒）：选定的那一对 / 各单独指定的那几对现在怎样、是不是在顶着、最近 24 小时按错误码的计数。
   */
  function healthView() {
    const c = cfg();
    if (c.target === 'off') return { state: 'off', mode: 'off', pairs: [], fallback: null, fallbackToChat: c.fallbackToChat !== false, waiting: health.waiting() };
    const rows = [];
    for (const use of ['extract', ...PER_USE.filter((u) => u !== 'extract')]) {
      let s;
      try { s = selection(use); } catch (e) { rows.push({ use, error: codeOf(e) }); continue; }
      if (rows.some((r) => r.pair && samePair(r.pair, s.pair))) continue;
      rows.push({ use, pair: s.pair, source: s.source, ...health.view(pairKey(s.pair)) });
    }
    const fb = health.fallback();
    const down = rows.find((r) => r.error || r.state === 'down');
    const flaky = rows.find((r) => r.state === 'flaky');
    const fallback = isPair(fb) && down?.pair && pairKey(down.pair) === fb.from ? { provider: fb.provider, model: fb.model, since: fb.since } : null;
    const state = down ? 'down' : flaky ? 'flaky' : rows.every((r) => r.state === 'unknown') ? 'unknown' : 'ok';
    return {
      state, mode: isPair(c.target) ? 'chosen' : 'unchosen',
      code: down ? (down.error ?? down.code ?? null) : flaky ? flaky.code ?? null : null,
      since: down?.since ?? null,
      pair: down?.pair ?? rows.find((r) => r.pair)?.pair ?? null,
      pairs: rows, fallback, fallbackToChat: c.fallbackToChat !== false, waiting: health.waiting(),
      pinned: health.pinned(), lastTest: health.lastTest(), resolveError,
    };
  }

  /** 现在会用哪个提供方和模型。 */
  function targetOf(use) {
    try {
      const s = selection(use);
      if (s.off) return { provider: null, model: null, allowed: false, off: true, source: 'off' };
      return { provider: s.pair.provider, model: s.pair.model, allowed: true, source: s.source };
    } catch (e) { return { provider: null, model: null, allowed: false, error: codeOf(e) }; }
  }

  /** 恢复了（D168）：叫宿主补积压。 */
  function recovered(why) {
    health.setWaiting(false);
    log.info('llm.recovered', { why });
    try { onRecover(why); } catch { /* 宿主的事，出错不影响这次调用 */ }
  }
  /** 一对成功了：记健康；原来不工作的（或者有提炼在等）→ 恢复；升级前的配置第一次成功 → 钉住。 */
  function succeeded(pair, via, source) {
    const was = health.ok(pairKey(pair));
    if (via === 'fallback') return;
    if (health.fallback()?.from === pairKey(pair) || via === 'probe') health.setFallback(null);
    if (source === 'legacy' && !health.pinned()) {
      health.pin(pair);
      log.info('llm.pinned', { provider: pair.provider, model: pair.model });
    }
    if (was || health.waiting()) recovered(was ? 'healthy' : 'first-ok');
  }

  return {
    /**
     * @param {{use: string, system: string, messages: {role: string, content: string}[], maxTokens?: number, signal?: AbortSignal, meta?: {sourceKey?: string}}} req
     * @returns {Promise<{text: string, usage: {in: number, cached: number, out: number}, model: string, stopReason?: 'end'|'length'|'other'}>}
     */
    async complete(req) {
      if (closed) throw llmError('CLOSED');
      const use = req?.use;
      const qn = QUEUE_OF[use];
      if (!qn) throw llmError('BAD_USE', `不认识的用途 ${use}`);
      if (qn === 'bg' && stats.backoffUntil > now()) throw llmError('LLM_BACKOFF', 'LLM_BACKOFF', 'transient');
      const q = queues[qn];
      return q.run(async (signal) => {
        if (signal?.aborted) throw abortError();
        stats.calls += 1;
        stats.byUse[use] = (stats.byUse[use] ?? 0) + 1;
        let plan;
        let source = null;
        let origKey = null;
        try {
          try { const s = selection(use); source = s.source; origKey = s.pair ? pairKey(s.pair) : null; } catch { source = null; }
          plan = route(use);
        } catch (e) {
          stats.failures += 1;
          stats.lastError = codeOf(e);
          log.warn('llm.failed', { use, error: stats.lastError });
          throw e;
        }
        const timeoutMs = cfg().timeoutMs?.[use] ?? 20_000;
        let lastErr = null;
        for (let i = 0; i < plan.length; i++) {
          const { pair, via } = plan[i];
          const state = { sent: false };
          try {
            const { estimated, reported, ...r } = await callOnce(req, pair, timeoutMs, signal, state);
            if (qn === 'bg') { stats.bgFailures = 0; stats.backoffUntil = 0; }
            if (via === 'fallback' && origKey) health.setFallback({ from: origKey, ...pair });
            succeeded(pair, via, source);
            try { budget.record?.(use, r.usage, { sourceKey: req.meta?.sourceKey, ...(estimated ? { estimated: true } : {}), ...(via === 'fallback' ? { fallback: true } : {}) }); } catch { /* 计数失败不影响结果 */ }
            return r;
          } catch (e0) {
            const e = e0 && typeof e0 === 'object' ? e0 : llmError('LLM_ERROR');
            const code = codeOf(e);
            const kind = health.fail(pairKey(pair), code, probeMs());
            if (kind && !e.kind) { try { e.kind = kind; } catch { /* 冻结的错误对象 */ } }
            // 真正发出去了的才算一次调用（没有模型服务这类没发出去的不算）；宿主报了用量就照记
            if (state.sent) { try { budget.record?.(use, e?.usage ?? null, { sourceKey: req.meta?.sourceKey, failed: true }); } catch { /* 忽略 */ } }
            if (QUOTA_CODES.includes(code)) { try { budget.notifyQuota?.(); } catch { /* 忽略 */ } }
            lastErr = e;
            // 试原来那一对没通（配置类）、后面还有顶上的那一对：接着用它，这一次不白等
            if (kind === 'config' && i + 1 < plan.length) continue;
            break;
          }
        }
        const e = lastErr;
        stats.failures += 1;
        stats.lastError = codeOf(e);
        if (e?.kind === 'config') health.setWaiting(true);
        // 配置类的错不进退避（它不是一时的：不工作期间不再白调，到点再试由健康状态管）
        if (qn === 'bg' && e?.code !== 'ABORTED' && e?.name !== 'AbortError' && e?.kind !== 'config') {
          const steps = cfg().backoffMin ?? [1, 4, 16];
          const m = steps[Math.min(stats.bgFailures, steps.length - 1)] ?? 1;
          stats.bgFailures += 1;
          stats.backoffUntil = now() + m * 60_000;
        }
        log.warn('llm.failed', { use, error: stats.lastError });
        throw e;
      }, { priority: use === 'review' ? 0 : use === 'appraise' ? 1 : 5, signal: req.signal });
    },

    /**
     * 现在调了会不会一定失败（D168，核心的可选接口）：主人关了后台模型、一对都选不出来、选定的那一对不工作又没有可以顶上的（也没到再试的时候）→ false。
     * @param {string} [use]
     */
    ready(use = 'extract') {
      let sel;
      try { sel = selection(use); } catch { health.setWaiting(true); return false; }
      if (sel.off) { health.setWaiting(true); return false; }
      const v = health.view(pairKey(sel.pair));
      if (v.state !== 'down') return true;
      const ok = now() >= v.nextProbeAt || !!fallbackFor(sel.pair);
      if (!ok) health.setWaiting(true);
      return ok;
    },

    /** 现在会用哪个提供方和模型（自检、管理页、预算）。 */
    target: (use = 'extract') => targetOf(use),

    /** 正在用的各对（各用途选定的、正在顶着的）的价目认不认得（D168：不认得的管理页不显示元）。 */
    pricing() {
      const pairs = [];
      for (const use of Object.keys(QUEUE_OF)) { try { const s = selection(use); if (s.pair && !pairs.some((p) => samePair(p, s.pair))) pairs.push(s.pair); } catch { /* 没选出来 */ } }
      // 正在顶着的（顶的是现在选的、还不工作的那一对；换过选择以后旧的顶上不算）
      const fb = healthView().fallback;
      if (isPair(fb) && !pairs.some((p) => samePair(p, fb))) pairs.push({ provider: fb.provider, model: fb.model });
      return { known: pairs.length > 0 && pairs.every(pricedPair), pairs };
    },

    /**
     * 健康状态（D168，管理页、自检、提醒）：选定的那一对 / 各单独指定的那几对现在怎样、是不是在顶着、最近 24 小时按错误码的计数。
     * @returns {object}
     */
    health: () => healthView(),

    /**
     * DSH 里有哪些服务商和模型（管理页「换一个」的两个下拉、首次设置的建议值）。宿主的目录查询可能要联网：每个服务商最多等 8 秒。
     * @returns {Promise<{available: boolean, providers: {id: string, name: string, models: {id: string, name: string}[], error?: string}[],
     *   current: object, suggest: {provider: string, model: string, why: string}|null, defaultSelection: {provider: string, model: string}|null}>}
     */
    async list() {
      const llm = getLlm();
      const c = cfg();
      const current = { target: c.target ?? null, perUse: { ...(c.perUse ?? {}) }, effective: targetOf('extract'), fallbackToChat: c.fallbackToChat !== false };
      const sel = defaultSel();
      const defaultSelection = isPair(sel) ? { provider: sel.provider, model: sel.model } : null;
      if (typeof llm?.listProviders !== 'function') return { available: false, providers: [], current, suggest: defaultSelection ? { ...defaultSelection, why: 'chat' } : null, defaultSelection };
      let raw = [];
      try { raw = (await within(8000, () => llm.listProviders())) ?? []; } catch { raw = []; }
      const providers = await Promise.all((Array.isArray(raw) ? raw : []).slice(0, 40).filter((p) => typeof p?.id === 'string' && p.id).map(async (p) => {
        const out = { id: p.id, name: typeof p.name === 'string' && p.name ? p.name.slice(0, 80) : p.id, models: [] };
        try {
          const ms = (await within(8000, () => llm.listModels?.(p.id))) ?? [];
          out.models = (Array.isArray(ms) ? ms : []).filter((m) => typeof m?.id === 'string' && m.id).slice(0, 200)
            .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name.slice(0, 80) : m.id }));
        } catch (e) { out.error = codeOf(e); }
        return out;
      }));
      return { available: true, providers, current, suggest: suggestFrom(providers, defaultSelection), defaultSelection };
    },

    /**
     * 这一对在 DSH 里认不认得（不花钱，自检用）：服务商在不在 listProviders() 里、resolveModelInfo 认不认这个模型；
     * 模型目录（只是参考，DSH 不按它拦）有内容却没有这个模型时 inCatalog = false。
     * @param {{provider: string, model: string}} pair
     * @returns {Promise<{ok: boolean, code?: string, inCatalog?: boolean|null}>}
     */
    async recognize(pair) {
      const llm = getLlm();
      if (!isPair(pair)) return { ok: false, code: 'NO_PROVIDER' };
      if (typeof llm?.listProviders !== 'function') return { ok: true, inCatalog: null, code: 'NO_DIRECTORY' };
      let providers = [];
      try { providers = (await within(8000, () => llm.listProviders())) ?? []; } catch (e) { return { ok: true, inCatalog: null, code: codeOf(e) }; }
      if (!providers.some((p) => p?.id === pair.provider)) return { ok: false, code: 'NO_ADAPTER' };
      try { await within(8000, () => llm.resolveModelInfo?.(pair.provider, pair.model)); } catch (e) {
        const code = codeOf(e);
        if (errorKind(code) === 'config') return { ok: false, code };
      }
      let inCatalog = null;
      try {
        const ms = (await within(8000, () => llm.listModels?.(pair.provider))) ?? [];
        if (Array.isArray(ms) && ms.length) inCatalog = ms.some((m) => m?.id === pair.model);
      } catch { inCatalog = null; }
      return { ok: true, inCatalog };
    },

    /**
     * 「试一下」（D168）：对一对发两次很小的真实请求——第一眼的形状、提炼的形状（真实的提示词，内容是编的），用真实的解析器解析。
     * 不给就试当前选定的那一对（提炼用的那一对）。过预算（用途 test），不绕过上限；结果记进健康状态（试通了也算恢复）。
     * @param {{provider: string, model: string}} [pairIn]
     */
    async test(pairIn) {
      let pair = isPair(pairIn) ? { provider: pairIn.provider, model: pairIn.model } : null;
      if (!pair) {
        try { const s = selection('extract'); if (s.off) return testResult(now(), null, { verdict: '现在选的是「不用后台模型」，没有可以试的', level: 'warn', code: 'LLM_OFF' }); pair = s.pair; } catch (e) {
          return testResult(now(), null, { verdict: verdictOf(codeOf(e), null), level: 'bad', code: codeOf(e) });
        }
      }
      const steps = {};
      const run = async (name, trial, timeoutMs) => {
        const reqd = trial.request();
        const est = Math.ceil((reqd.system.length + reqd.messages[0].content.length) / 2);
        let ok = false;
        try { ok = budget.allow ? budget.allow('test', est, {}) !== false : true; } catch { ok = false; }
        if (!ok) { steps[name] = { ok: false, code: 'BUDGET' }; return false; }
        const state = { sent: false };
        const t0 = now();
        const w0 = Date.now();
        try {
          const r = await callOnce({ ...reqd }, pair, timeoutMs, undefined, state);
          const ms = Math.max(now() - t0, Date.now() - w0);
          const parsed = trial.parse(r.text);
          // 输出 token 远多于正文（按约 1.5 字一个 token 估）：多半是关不掉的思考也算进了输出
          const textTokens = Math.ceil(r.text.length / 1.5);
          const thinking = r.reported && r.usage.out > Math.max(200, textTokens * 3);
          steps[name] = { ok: true, ms, reported: r.reported, usage: r.usage, valid: parsed.valid, bad: parsed.bad, ...(parsed.expected ? { expected: parsed.expected } : {}), thinking };
          health.ok(pairKey(pair));
          try { budget.record?.('test', r.usage, r.estimated ? { estimated: true } : {}); } catch { /* 忽略 */ }
          return true;
        } catch (e) {
          const code = codeOf(e);
          const kind = health.fail(pairKey(pair), code, probeMs());
          steps[name] = { ok: false, code, kind, ms: Math.max(now() - t0, Date.now() - w0) };
          if (state.sent) { try { budget.record?.('test', e?.usage ?? null, { failed: true }); } catch { /* 忽略 */ } }
          if (QUOTA_CODES.includes(code)) { try { budget.notifyQuota?.(); } catch { /* 忽略 */ } }
          return false;
        }
      };
      const t = cfg().timeoutMs ?? {};
      // 第一眼平时 6 秒就放弃；试的时候多等一会儿，好知道到底多慢
      const g = await run('glance', llmTrial.glance, Math.max(15_000, Number(t.glance) || 0));
      if (g || steps.glance?.kind !== 'config') await run('extract', llmTrial.extract, Number(t.extract) || 60_000);
      const r = judge(pair, steps);
      const out = testResult(now(), pair, r, steps);
      health.setLastTest({ at: out.at, provider: pair.provider, model: pair.model, ok: out.ok, level: out.level, code: out.code ?? null,
        glanceMs: steps.glance?.ms ?? null, extractMs: steps.extract?.ms ?? null, thinking: !!(steps.glance?.thinking || steps.extract?.thinking) });
      // 试通了（两步都通、格式对）：如果这一对就是现在选定的，原来不工作 / 有提炼在等 → 恢复
      if (out.ok) {
        let cur = null;
        try { cur = selection('extract'); } catch { cur = null; }
        if (cur?.pair && samePair(cur.pair, pair)) { health.setFallback(null); if (health.waiting()) recovered('test'); }
      }
      health.flush();
      return out;
    },

    /** 配置改了（D168）：从「不用」切回来 → 恢复；选定的那一对换了 → 新的一对马上可以试。 */
    configChanged() {
      const mode = cfg().target === 'off' ? 'off' : 'on';
      const was = lastMode;
      lastMode = mode;
      for (const use of PER_USE) { try { const s = selection(use); if (s.pair) health.resetProbe(pairKey(s.pair)); } catch { /* 没选出来 */ } }
      if (was === 'off' && mode === 'on') recovered('on');
      else if (mode === 'off') health.setWaiting(true);
    },

    /** 诊断里「复制后台模型状态」（D168）：不含任何聊天内容、地址、Key。 */
    summary() {
      const h = healthView();
      const p = h.pair;
      const lt = health.lastTest();
      const byCode = {};
      for (const r of h.pairs ?? []) for (const [k, n] of Object.entries(r.byCode ?? {})) byCode[k] = (byCode[k] ?? 0) + n;
      return {
        state: h.state, mode: h.mode, providerKind: providerKind(p?.provider), model: p?.model ?? null,
        effort: p ? efforts.get(pairKey(p)) ?? null : null,
        perUse: Object.fromEntries(PER_USE.map((u) => [u, isPair(cfg().perUse?.[u]) ? { providerKind: providerKind(cfg().perUse[u].provider), model: cfg().perUse[u].model } : null])),
        fallback: h.fallback ? { providerKind: providerKind(h.fallback.provider), model: h.fallback.model } : null, fallbackToChat: h.fallbackToChat,
        lastTest: lt ? { at: lt.at, ok: lt.ok, code: lt.code, glanceMs: lt.glanceMs, extractMs: lt.extractMs, thinking: lt.thinking, providerKind: providerKind(lt.provider), model: lt.model } : null,
        errors24h: byCode, code: h.code ?? null,
        // 学到的兼容开关（参数差异，另一项改动在做）：这一版还没有
        compat: {},
      };
    },

    status() {
      return { calls: stats.calls, failures: stats.failures, byUse: { ...stats.byUse }, lastError: stats.lastError,
        backoffUntil: stats.backoffUntil || null, queued: { bg: queues.bg.size, appraise: queues.appraise.size, review: queues.review.size, glance: queues.glance.size },
        health: healthView() };
    },
    dispose() { closed = true; for (const q of Object.values(queues)) q.clear(); health.dispose(); },
  };
}

/** 新装时的建议值（D168）：DSH 里有 DeepSeek 的通道、目录里有 deepseek-flash → 这一对（先挑主人聊天用的那条通道）；否则 DSH 当前聊天的那一对。 */
export function suggestFrom(providers, defaultSelection) {
  const order = [...DEEPSEEK_PROVIDERS].sort((a, b) => (b === defaultSelection?.provider) - (a === defaultSelection?.provider));
  for (const id of order) {
    const p = providers.find((x) => x.id === id);
    if (p && p.models.some((m) => m.id === SUGGEST_MODEL)) return { provider: id, model: SUGGEST_MODEL, why: 'deepseek' };
  }
  if (defaultSelection) return { ...defaultSelection, why: 'chat' };
  return null;
}

/** 错误码 → 一句人话（试一下、总览提醒）。 */
export function verdictOf(code, pair) {
  const p = pair?.provider ?? '这个服务商';
  const m = pair?.model ?? '这个模型';
  switch (code) {
    case 'UNKNOWN_MODEL': return `连不上：「${p}」没有叫 ${m} 的模型`;
    case 'NO_ADAPTER': return `连不上：DSH 里没有「${p}」这个服务商（被删掉了，或者它的插件没装）`;
    case 'NO_PROVIDER': return '还没选后台模型，DSH 里也没有默认的模型';
    case 'NO_MODEL': case 'MODEL_NOT_ALLOWED': return '配置文件里的后台模型写得不对';
    case 'MISSING_CREDENTIAL': case 'NO_CREDENTIAL_STORE': case 'ACCOUNT_SIGN_IN_REQUIRED': return `连不上：「${p}」还没登录或者没填 Key（在 DSH 的模型设置里补上）`;
    case 'AUTH': case 'INVALID_CREDENTIAL': case 'ACCOUNT_TOKEN_INVALID': return `连不上：「${p}」的 Key 或登录失效了（在 DSH 的模型设置里重新填）`;
    case 'MODEL_UNSUPPORTED': case 'CLIENT_UPGRADE_REQUIRED': return `${m} 要更新 DSH 才能用`;
    case 'UNSUPPORTED_REASONING_EFFORT': case 'UNSUPPORTED_OPTION': case 'INVALID_REQUEST': return `连上了，但 ${m} 不接受插件发的参数`;
    case 'INVALID_CONFIG': return `DSH 里「${p}」的设置有问题`;
    case 'QUOTA': case 'ACCOUNT_QUOTA': return '连上了，但余额用完了';
    case 'TIMEOUT': return '太慢：等到时间还没回';
    case 'RATE_LIMIT': return '服务商说请求太多（限流），过一会儿再试';
    case 'SERVER': case 'TRANSPORT': case 'MESSAGES_IDLE': case 'STREAM_CLOSED': return '暂时连不上（服务端忙或者网络问题），过一会儿再试';
    case 'BUDGET': return '今天的后台花费到上限了，这次没有试';
    case 'LLM_DOWN': return '后台模型不工作';
    case 'LLM_OFF': return '现在选的是「不用后台模型」';
    case 'NO_LLM': return 'DSH 现在没有模型服务';
    default: return `连不上（${code ?? '原因不明'}）`;
  }
}

/** 两步的结果 → {ok, level, verdict, code}。 */
function judge(pair, steps) {
  const g = steps.glance;
  const e = steps.extract;
  const failed = [g, e].find((x) => x && !x.ok);
  if (failed) return { ok: false, level: failed.code === 'BUDGET' || failed.kind === 'transient' ? 'warn' : 'bad', verdict: verdictOf(failed.code, pair), code: failed.code };
  const s = (ms) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
  if (!(g.valid > 0) || !(e.valid > 0)) return { ok: false, level: 'bad', verdict: '通了，但输出不是要的格式（插件读不懂它的回答）', code: 'BAD_OUTPUT' };
  const think = g.thinking || e.thinking ? '；输出的 token 比正文多很多，像是关不掉的思考：会慢一些、贵一些' : '';
  if (g.ms > SLOW_GLANCE_MS) return { ok: true, level: 'warn', verdict: `能用，但太慢：第一眼 ${s(g.ms)} 秒（回话前等不了这么久，会让回想变少），提炼 ${s(e.ms)} 秒${think}`, code: 'SLOW' };
  if (e.ms > SLOW_EXTRACT_MS) return { ok: true, level: 'warn', verdict: `能用，第一眼 ${s(g.ms)} 秒；提炼很慢（${s(e.ms)} 秒），整理新记忆会跟不上${think}`, code: 'SLOW' };
  return { ok: true, level: think ? 'warn' : 'ok', verdict: `能用，第一眼 ${s(g.ms)} 秒，提炼 ${s(e.ms)} 秒${think}` };
}
function testResult(at, pair, r, steps = {}) {
  return { at, pair, ok: !!r.ok, level: r.level, verdict: r.verdict, ...(r.code ? { code: r.code } : {}), steps };
}
