// RerankPort（可选，§8.4、§10.7）：llama-server 的 /v1/rerank（Qwen3-Reranker-4B GGUF）。
//   - 没配地址也没配启动命令 → 没有这个端口（返回 null），核心跳过重排；beta 默认就是这样（§15.2：装好、校验通过才启用）；
//   - 只在资源管家允许（GPU 有空）时可用；配了启动命令的，按需启动、空闲 2 分钟退出、资源管家收回 GPU 时直接结束进程；
//   - 只给分数，不改候选（核心用重排分替换融合里的稠密和词法部分，D73）。
import { spawn as spawnCb } from 'node:child_process';
import { anySignal, delay } from '../host/util.js';

const rerankError = (code) => Object.assign(new Error(code), { code });

/**
 * @param {{hostConfig: () => object, governor?: {decision: () => object}|null, fetchImpl?: typeof fetch, spawn?: typeof spawnCb,
 *          log?: object, now?: () => number}} opt
 * @returns {null|{available: () => boolean, rerank: (q: string, docs: string[], signal?: AbortSignal) => Promise<number[]>, status: Function, onDeviceChange: Function, dispose: Function}}
 */
export function createRerankPort({ hostConfig, governor = null, fetchImpl = globalThis.fetch, spawn = spawnCb, log = { warn() {}, info() {} }, now = () => Date.now() }) {
  const c0 = hostConfig().rerank ?? {};
  if (!c0.url && !c0.command) return null;
  const cfg = () => hostConfig().rerank ?? {};
  let proc = null;
  let starting = null;
  let lastUse = 0;
  let idleTimer = null;
  let failures = 0;
  let openUntil = 0;
  const stats = { calls: 0, failures: 0, starts: 0 };

  const allowed = () => {
    if (hostConfig().features?.rerank === false) return false;
    try { return governor ? governor.decision().rerankAllowed === true : true; } catch { return false; }
  };
  const base = () => String(cfg().url || 'http://127.0.0.1:8081').replace(/\/+$/, '');
  const stop = () => { if (proc) { try { proc.kill(); } catch { /* 忽略 */ } proc = null; } };
  const armIdle = () => {
    if (!cfg().command) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; if (now() - lastUse >= (cfg().idleMs ?? 120_000)) stop(); }, cfg().idleMs ?? 120_000);
    idleTimer.unref?.();
  };
  async function ensureServer(signal) {
    if (!cfg().command || proc) return;
    if (starting) return starting;
    starting = (async () => {
      stats.starts += 1;
      proc = spawn(cfg().command, cfg().args ?? [], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => { proc = null; });
      const until = now() + (cfg().startTimeoutMs ?? 60_000);
      while (now() < until) {
        try { const r = await fetchImpl(`${base()}/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch { /* 还没起来 */ }
        await delay(500, signal);
      }
      stop();
      throw rerankError('RERANK_START_TIMEOUT');
    })().finally(() => { starting = null; });
    return starting;
  }

  return {
    available: () => allowed() && openUntil <= now(),
    async rerank(query, docs, signal) {
      if (!allowed()) throw rerankError('RERANK_NOT_ALLOWED');
      if (openUntil > now()) throw rerankError('RERANK_BREAKER');
      lastUse = now();
      stats.calls += 1;
      try {
        await ensureServer(signal);
        const sig = anySignal([signal, AbortSignal.timeout(cfg().timeoutMs ?? 3000)]);
        const r = await fetchImpl(`${base()}/v1/rerank`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: sig,
          body: JSON.stringify({ ...(cfg().model ? { model: cfg().model } : {}), query: String(query ?? ''), documents: docs.map((d) => String(d ?? '')), top_n: docs.length }),
        });
        if (!r.ok) throw rerankError(`HTTP_${r.status}`);
        const j = await r.json();
        const scores = new Array(docs.length).fill(0);
        for (const x of j?.results ?? j?.data ?? []) if (Number.isInteger(x?.index) && x.index < docs.length) scores[x.index] = Number(x.relevance_score ?? x.score ?? 0);
        failures = 0;
        armIdle();
        return scores;
      } catch (e) {
        stats.failures += 1;
        failures += 1;
        if (failures >= 2) { openUntil = now() + 60_000; log.warn('rerank.breaker', {}); }
        throw e;
      }
    },
    /** 资源管家收回 GPU：结束按需启动的进程。 */
    onDeviceChange(next) { if (next && !next.rerankAllowed) stop(); },
    status: () => ({ configured: true, managed: !!cfg().command, running: !!proc, allowed: allowed(), breakerOpen: openUntil > now(), ...stats }),
    dispose() { if (idleTimer) clearTimeout(idleTimer); stop(); },
  };
}
