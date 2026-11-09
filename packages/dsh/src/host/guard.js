// 钩子防护（§10.10，沿用 v1:819-824）：
//   - 所有监听器整个包在 try/catch 里，永不外抛（F9：post-execute 抛错会把工具结果变成错误；F12：agent/created 抛错会让会话创建失败）；
//   - 按会话熔断：同一会话连续 3 次内部出错，这个钩子在该会话关 10 分钟，管理页标红；
//   - 同步部分 p95 ≤ 20 ms；超过 100 ms 记慢日志（只有钩子名和毫秒数）。
import { Durations, errCode } from './util.js';

/**
 * @param {{hostConfig: () => object, now?: () => number, log?: object}} opt
 */
export function createHookGuard({ hostConfig, now = () => Date.now(), log = { warn() {} } }) {
  const cfg = () => hostConfig().guards ?? { breakerErrors: 3, breakerMs: 600_000, slowMs: 100 };
  /** hook → {calls, errors, slow, durations, sessions: Map<sid, {fails, openUntil}>, opened} */
  const hooks = new Map();
  const H = (hook) => {
    let h = hooks.get(hook);
    if (!h) { h = { calls: 0, errors: 0, slow: 0, skipped: 0, opened: 0, lastError: null, durations: new Durations(), sessions: new Map() }; hooks.set(hook, h); }
    return h;
  };
  const key = (sid) => (typeof sid === 'string' && sid ? sid : '_');
  const isOpen = (hook, sid) => {
    const s = H(hook).sessions.get(key(sid));
    return !!s && s.openUntil > now();
  };
  const ok = (h, sid, t0) => {
    const ms = now() - t0;
    h.durations.add(ms);
    if (ms > cfg().slowMs) { h.slow += 1; log.warn('hook.slow', { hook: hookName(h), ms }); }
    const s = h.sessions.get(key(sid));
    if (s) s.fails = 0;
  };
  const fail = (hook, h, sid, e, t0) => {
    h.errors += 1;
    h.lastError = errCode(e);
    h.durations.add(now() - t0);
    const k = key(sid);
    const s = h.sessions.get(k) ?? { fails: 0, openUntil: 0 };
    s.fails += 1;
    if (s.fails >= cfg().breakerErrors) {
      s.openUntil = now() + cfg().breakerMs;
      s.fails = 0;
      h.opened += 1;
      log.warn('hook.breaker', { hook, minutes: Math.round(cfg().breakerMs / 60_000) });
    }
    h.sessions.set(k, s);
    if (h.sessions.size > 500) { for (const [kk, v] of h.sessions) { if (v.openUntil <= now()) h.sessions.delete(kk); if (h.sessions.size <= 400) break; } }
    log.warn('hook.error', { hook, error: h.lastError });
  };
  const hookName = (h) => { for (const [n, x] of hooks) if (x === h) return n; return '?'; };

  return {
    isOpen,
    /**
     * 跑一个异步监听器体：熔断中 → fallback('open')；出错 → fallback('error', e)。永不抛错。
     * @template T
     * @param {string} hook
     * @param {string|undefined} sid
     * @param {() => Promise<T>|T} fn
     * @param {(why: 'open'|'error', e?: unknown) => T} fallback
     * @returns {Promise<T>}
     */
    async run(hook, sid, fn, fallback) {
      const h = H(hook);
      if (isOpen(hook, sid)) { h.skipped += 1; try { return fallback('open'); } catch { return undefined; } }
      h.calls += 1;
      const t0 = now();
      try { const r = await fn(); ok(h, sid, t0); return r; } catch (e) {
        fail(hook, h, sid, e, t0);
        try { return fallback('error', e); } catch { return undefined; }
      }
    },
    /** 同步版（systemPrompt.context 的 provider、tools.guard 都是同步的，F1、F15）。 */
    runSync(hook, sid, fn, fallback) {
      const h = H(hook);
      if (isOpen(hook, sid)) { h.skipped += 1; try { return fallback('open'); } catch { return undefined; } }
      h.calls += 1;
      const t0 = now();
      try { const r = fn(); ok(h, sid, t0); return r; } catch (e) {
        fail(hook, h, sid, e, t0);
        try { return fallback('error', e); } catch { return undefined; }
      }
    },
    /** 管理页：每个钩子的调用数、错误数、p95、熔断中的会话数（只有数字）。 */
    status() {
      const out = {};
      for (const [n, h] of hooks) {
        let open = 0;
        for (const s of h.sessions.values()) if (s.openUntil > now()) open += 1;
        out[n] = { calls: h.calls, errors: h.errors, slow: h.slow, skipped: h.skipped, breakerOpened: h.opened, openSessions: open,
          p50Ms: h.durations.pct(50), p95Ms: h.durations.pct(95), lastError: h.lastError };
      }
      return out;
    },
  };
}
