// 后台模型的健康状态（D168）：每一对「服务商 + 模型」最近一次成功、最近的错误、连续失败数、最近 24 小时按错误码的计数。
// 存在数据目录的 host-llm.json（只有服务商 id、模型名、错误码和时间），重启不丢；同一个文件里还有升级前的配置第一次成功时
// 自动钉住的那一对（pinned）和上一次「试一下」的结果（lastTest，不含任何输出内容）。
// 错误分三类（码以 DSH 0.2 的 @deepseek-ai/dsh-llm 和各适配器实际抛的为准，见 docs/实现/模块与接口.md D168）：
//   配置类：出现一次就判「不工作」（INVALID_REQUEST 连着两次也算）——修好之前每次都一样失败，重试没用；
//   额度类：沿用预算的余额保护（H5），这里只记数；
//   暂时类：超时、限流、服务端、网络——看最近 30 分钟的失败率，过半判「不稳定」。
import { readJson, writeJsonAtomic } from '../host/util.js';

/** 配置类：模型名不对、没有这个服务商的适配器、没登录 / 没 Key / Key 无效、模型不可用、参数不支持、配置写错、插件自己选不出一对。 */
export const CONFIG_CODES = Object.freeze([
  'UNKNOWN_MODEL', 'NO_ADAPTER', 'NO_PROVIDER', 'NO_MODEL', 'MODEL_NOT_ALLOWED',
  'MISSING_CREDENTIAL', 'NO_CREDENTIAL_STORE', 'ACCOUNT_SIGN_IN_REQUIRED', 'INVALID_CREDENTIAL', 'AUTH', 'ACCOUNT_TOKEN_INVALID',
  'MODEL_UNSUPPORTED', 'CLIENT_UPGRADE_REQUIRED', 'UNSUPPORTED_REASONING_EFFORT', 'UNSUPPORTED_OPTION', 'INVALID_CONFIG',
  'INVALID_MODEL_INFO', 'INVALID_MODEL_REASONING', 'INVALID_MODEL_CONTEXT', 'INVALID_MODEL_MAX_TOKENS', 'LLM_DOWN',
]);
/** @deepseek-ai/dsh-llm 的 QUOTA_EXCEEDED_CODE 和 ACCOUNT_QUOTA_EXCEEDED_CODE（账号通道把 402 改写成后者）。 */
export const QUOTA_CODES = Object.freeze(['QUOTA', 'ACCOUNT_QUOTA']);
/** 这次请求本身的问题（上下文太长、请求不合格）：不判「不工作」。INVALID_REQUEST 连着两次就当配置类（多半是参数不被接受）。 */
const OUTPUT_CODES = new Set(['CONTEXT_WINDOW_EXCEEDED', 'INVALID_REQUEST', 'IMAGE_OFFLOAD_REQUIRED']);
/** 不是模型的问题（取消、插件自己的退避和排队、预算没放行）：不记。 */
const IGNORED = new Set(['ABORTED', 'AbortError', 'LLM_BACKOFF', 'CLOSED', 'BAD_USE', 'BUDGET', 'LLM_OFF']);
const CONFIG = new Set(CONFIG_CODES);

const DAY = 86_400_000;
const FLAKY_WINDOW_MS = 30 * 60_000;
const FLAKY_MIN_CALLS = 4;
const FLAKY_RATE = 0.5;
const MAX_EVENTS = 400;

/**
 * 一个错误码属于哪一类。prevInvalid：这一对紧挨着的上一次失败是不是也是 INVALID_REQUEST。
 * @param {string|null|undefined} code
 * @param {boolean} [prevInvalid]
 * @returns {'config'|'quota'|'transient'|'output'|null}  null = 不记
 */
export function errorKind(code, prevInvalid = false) {
  const c = String(code ?? '');
  if (!c || IGNORED.has(c)) return null;
  if (CONFIG.has(c)) return 'config';
  if (QUOTA_CODES.includes(c)) return 'quota';
  if (c === 'INVALID_REQUEST') return prevInvalid ? 'config' : 'output';
  if (OUTPUT_CODES.has(c)) return 'output';
  return 'transient';
}

export const pairKey = (p) => `${p.provider}/${p.model}`;
const emptyPair = () => ({ lastOkAt: 0, lastErr: null, consecutive: 0, invalidRun: 0, downSince: 0, downCode: null, nextProbeAt: 0, events: [] });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

/**
 * @param {{file?: string|null, now: () => number, log?: {warn: Function}}} opt
 */
export function createLlmState({ file = null, now, log = { warn() {} } }) {
  let s = { pinned: null, pairs: {}, lastTest: null, waiting: false, fallback: null };
  let timer = null;
  let dirty = false;
  if (file) {
    try {
      const v = readJson(file, null);
      if (isObj(v)) {
        if (isObj(v.pinned) && str(v.pinned.provider, 120)) s.pinned = { provider: str(v.pinned.provider, 120), model: str(v.pinned.model, 200), at: Number(v.pinned.at) || 0 };
        for (const [k, e] of Object.entries(isObj(v.pairs) ? v.pairs : {}).slice(0, 50)) {
          if (!isObj(e)) continue;
          s.pairs[k.slice(0, 330)] = { ...emptyPair(), ...e, events: Array.isArray(e.events) ? e.events.filter((x) => Array.isArray(x) && Number.isFinite(x[0])).slice(-MAX_EVENTS) : [] };
        }
        if (isObj(v.lastTest)) s.lastTest = v.lastTest;
        s.waiting = v.waiting === true;
        if (isObj(v.fallback)) s.fallback = v.fallback;
      }
    } catch (e) { log.warn('llm.state.load', { error: e?.code ?? 'Error' }); }
  }
  const flush = () => {
    if (!file || !dirty) return;
    dirty = false;
    try { writeJsonAtomic(file, s); } catch (e) { log.warn('llm.state.save', { error: e?.code ?? 'Error' }); }
  };
  const touch = () => {
    dirty = true;
    if (file && !timer) { timer = setTimeout(() => { timer = null; flush(); }, 2000); timer.unref?.(); }
  };
  const entry = (key) => (s.pairs[key] ??= emptyPair());
  const prune = (e) => { const cut = now() - DAY; e.events = e.events.filter((x) => x[0] >= cut).slice(-MAX_EVENTS); };

  return {
    /** 成功一次。返回这一对原来是不是「不工作」（是 = 刚恢复）。 */
    ok(key) {
      const e = entry(key);
      const was = e.downSince > 0;
      e.lastOkAt = now(); e.consecutive = 0; e.invalidRun = 0; e.downSince = 0; e.downCode = null; e.nextProbeAt = 0;
      e.events.push([now(), null]);
      prune(e);
      touch();
      return was;
    },
    /**
     * 失败一次（只记要记的类）。返回这次的类别；配置类一次就判「不工作」，从 probeMs 之后才再试。
     * @returns {'config'|'quota'|'transient'|'output'|null}
     */
    fail(key, code, probeMs) {
      const e = entry(key);
      const kind = errorKind(code, e.invalidRun > 0);
      if (!kind) return null;
      e.lastErr = { code: String(code).slice(0, 64), kind, at: now() };
      e.consecutive += 1;
      e.invalidRun = code === 'INVALID_REQUEST' ? e.invalidRun + 1 : 0;
      if (kind === 'config') {
        if (!e.downSince) e.downSince = now();
        e.downCode = String(code).slice(0, 64);
        e.nextProbeAt = now() + probeMs;
      }
      e.events.push([now(), String(code).slice(0, 64)]);
      prune(e);
      touch();
      return kind;
    },
    /** 不工作的一对这一次拿去试（试的这一下算掉，下一次再试等 probeMs）。 */
    probing(key, probeMs) { const e = entry(key); e.nextProbeAt = now() + probeMs; touch(); },
    /** 改了选择（换了一对、从关切回来）：原来那一对立刻可以再试。 */
    resetProbe(key) { const e = s.pairs[key]; if (e?.downSince) { e.nextProbeAt = 0; touch(); } },
    /**
     * 一对现在的状态（给端口、自检、管理页）：down 不工作 / flaky 不稳定 / ok / unknown 还没调过。
     * @returns {{state: 'down'|'flaky'|'ok'|'unknown', since: number|null, code: string|null, lastOkAt: number|null,
     *            lastErr: {code: string, kind: string, at: number}|null, nextProbeAt: number, byCode: Record<string, number>, recent: {calls: number, failed: number}}}
     */
    view(key) {
      const e = s.pairs[key] ?? emptyPair();
      const t = now();
      const day = e.events.filter((x) => x[0] >= t - DAY);
      const byCode = {};
      for (const [, c] of day) if (c) byCode[c] = (byCode[c] ?? 0) + 1;
      const recent = day.filter((x) => x[0] >= t - FLAKY_WINDOW_MS);
      const failed = recent.filter((x) => x[1] && errorKind(x[1]) === 'transient').length;
      let state = 'unknown';
      if (e.downSince) state = 'down';
      else if (recent.length >= FLAKY_MIN_CALLS && failed / recent.length >= FLAKY_RATE) state = 'flaky';
      else if (e.lastOkAt || day.length) state = 'ok';
      return { state, since: e.downSince || null, code: e.downCode ?? (state === 'flaky' ? e.lastErr?.code ?? null : null), lastOkAt: e.lastOkAt || null,
        lastErr: e.lastErr, nextProbeAt: e.nextProbeAt || 0, byCode, recent: { calls: recent.length, failed } };
    },
    pinned: () => s.pinned,
    pin(pair) { s.pinned = { provider: pair.provider, model: pair.model, at: now() }; touch(); flush(); },
    lastTest: () => s.lastTest,
    setLastTest(r) { s.lastTest = r; touch(); },
    /** 有提炼因为后台模型不工作在等（恢复时要叫核心补）。 */
    waiting: () => s.waiting,
    setWaiting(v) { if (s.waiting !== !!v) { s.waiting = !!v; touch(); } },
    /** 正在顶着的聊天那一对（from：出问题的那一对的键）。 */
    fallback: () => s.fallback,
    setFallback(v) { const nv = v ? { from: v.from, provider: v.provider, model: v.model, since: s.fallback?.from === v.from ? s.fallback.since : now() } : null;
      if (JSON.stringify(nv) !== JSON.stringify(s.fallback)) { s.fallback = nv; touch(); } },
    flush,
    dispose() { if (timer) { clearTimeout(timer); timer = null; } flush(); },
  };
}
