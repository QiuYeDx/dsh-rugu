// EmbeddingPort（§3.3、§8.6、§10.7）：Ollama /api/embed（ollama-native），或 OpenAI 兼容的 /v1/embeddings（llama-server、TEI）。
//   - 模型档位（§8.6.1）：standard = Qwen3-Embedding-4B（默认，§17 Q1）/ light = 0.6B / custom；换档 = 换向量空间，
//     核心按端口的 info() 建影子空间、后台重嵌；影子期间核心会带 spaceId 来要旧空间的向量，这里按档位找回对应的模型（§8.9）；
//   - space_id = hash(模型, 量化档, 维数, 文档端模板版本)；CPU / GPU 之间切换不改空间（§8.6.2 末尾）；
//   - 每次请求固定 options.num_ctx；资源管家说走 CPU 时带 num_gpu: 0，并按它给的线程数设 num_thread；让出 GPU 时发 keep_alive: 0 卸掉；
//     GPU 上不带 num_thread（实测问题 #1）：Ollama 把 num_thread 当成加载参数，值一变就整个重新加载模型（4B 约 3 秒）；
//   - 模型常驻（实测问题 #1）：Ollama 闲 keep_alive 就卸模型，下一次查询要先加载约 3 秒，正好错过 800 毫秒的回想截止。
//     keep_alive 默认 2 小时；warm()（有人说话时核心调）在模型可能已经被卸掉时先发一个空请求把它加载上，
//     启动、换设备之后也预热一次。已经热着（最近用过、或者健康检查看到它在）就什么都不发；
//   - 前面一条带优先级的队列：查询（有人在等）永远排在文档批前面（§7.6）；文档批再切成小片（embedding.docSlice，CPU 上一片很少几条），
//     查询最多等一小片，不用等整批；
//   - 健康检查每 30 秒一次；连续 2 次失败熔断 60 秒，熔断期间直接报错（核心降到 L3）；只有 HTTP 5xx 才算显卡出错
//     （连不上是服务没开，超时多半是 CPU 上慢，都不该把显卡判坏、退回更慢的 CPU）；
//   - info() 带上模型文件的指纹（/api/tags 的 digest，健康检查读到以后才有）：核心靠它判断「同名的模型被换过」，
//     探针的数值容差只管同一模型不同后端之间的差（实测问题 #1）；
//   - status() 里有冷加载次数、最近一次加载耗时、按错误类型的计数、最近一次错误：查「为什么没有查询向量」用；
//   - 云端兜底默认关（§8.6：记忆正文会离开本机），这里不实现；主人在管理页明确选了外部服务时（D127）走 openai-compat，
//     带 Authorization（Key 只从单独的密钥文件读，不进配置、日志和备份）；
//   - provider 'none'（D127）：主人选了「不用嵌入」，不发任何请求，info() 给空空间，核心走 L3；选了以后热切回别的也行。
import { TaskQueue } from './queue.js';
import { anySignal, sha } from '../host/util.js';

const embedError = (code) => Object.assign(new Error(code), { code });
const COLD_LOAD_MS = 500;   // Ollama 回的 load_duration 超过这么久，算一次冷加载

function l2(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Ollama 的 keep_alive（'30m'、'2h'、秒数、负数 = 一直留着）→ 毫秒；认不出来按 5 分钟（Ollama 的默认）。 */
export function keepAliveMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 0 ? Infinity : v * 1000;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(v ?? ''));
  if (!m) return 5 * 60_000;
  const n = Number(m[1]);
  if (n < 0) return Infinity;
  const unit = (m[2] ?? 's').toLowerCase();
  return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
}

/** 某个档位的模型说明（custom 档没填全就是 null）。 */
export function tierInfo(ecfg, tierName = ecfg.tier) {
  const t = ecfg.tiers?.[tierName];
  if (!t || !t.model || !(Number(t.dim) > 0)) return null;
  const quant = String(t.quant ?? '');
  const dim = Number(t.dim);
  const docTplVer = String(ecfg.docTplVer ?? '1');
  return { tier: tierName, model: String(t.model), quant, dim, docTplVer, spaceId: `emb-${sha(`${t.model}\u0000${quant}\u0000${dim}\u0000${docTplVer}`, 16)}`, vramMb: Number(t.vramMb) || 0, url: t.url || ecfg.url };
}

/**
 * @param {{hostConfig: () => object, fetchImpl?: typeof fetch, governor?: {decision: () => object, reportGpuError?: Function}|null,
 *          log?: object, now?: () => number}} opt
 */
export function createEmbeddingPort({ hostConfig, fetchImpl = globalThis.fetch, governor = null, log = { warn() {}, info() {} }, now = () => Date.now(), apiKey = () => '' }) {
  const cfg = () => hostConfig().embedding;
  const q = new TaskQueue({ concurrency: 1, now });
  const breaker = { failures: 0, openUntil: 0 };
  const health = { ok: null, at: 0, version: null, models: [], error: null, vramMb: 0, loaded: null, digests: new Map() };
  const stats = {
    requests: 0, texts: 0, failures: 0, byKind: { query: 0, doc: 0 }, lastMs: null, lastQueryMs: null,
    coldLoads: 0, lastLoadMs: null, lastLoadAt: null, warms: 0, errors: {}, lastError: null,
  };
  let lastDevice = null;
  let lastThreads = null;
  let healthTimer = null;
  let lastUseAt = 0;           // 最近一次请求成功（模型这之后至少热 keep_alive 那么久）
  let lastUseModel = null;
  let warmAt = 0;              // 最近一次预热的时间（节流）
  let warming = null;
  // 换了加载参数（设备）以后还没按新参数成功请求过一次：/api/ps 只按模型名报「在内存里」，看到的可能是按旧参数（比如 CPU 上）
  // 加载的那一份，下一次请求还是要整个重新加载，所以这时候不信它
  let optsStale = false;

  const decision = () => {
    try { return governor?.decision?.() ?? { device: 'cpu', cpuThreads: 4 }; } catch { return { device: 'cpu', cpuThreads: 4 }; }
  };
  const findTier = (spaceId) => {
    const c = cfg();
    // 换了服务商以后，旧档位的模型在新地址上不存在：只认现在这个地址产得出来的档位，其余的返回 null，核心走「旧空间产不出」的流程（建影子、重嵌）
    const usable = c.provider === 'openai-compat' ? [c.tier] : Object.keys(c.tiers ?? {}).filter((n) => n !== 'custom' || c.tier === 'custom');
    for (const name of usable) { const t = tierInfo(c, name); if (t && t.spaceId === spaceId) return t; }
    return null;
  };
  const off = () => cfg().provider === 'none';
  const current = () => (off() ? null : tierInfo(cfg()));
  const baseOf = (t) => String(t.url).replace(/\/+$/, '');
  /** 外部服务的鉴权头（只有 openai-compat 且配了 Key 时才有；Key 不进任何日志和错误）。 */
  const authHeaders = () => {
    if (cfg().provider !== 'openai-compat') return {};
    let k = '';
    try { k = String(apiKey() ?? '').trim(); } catch { k = ''; }
    return k ? { authorization: `Bearer ${k}` } : {};
  };
  /** 每次请求的加载参数：值要稳定，变了 Ollama 就重新加载模型。 */
  const optionsFor = (c, d) => ({
    num_ctx: c.numCtx ?? 1024,
    ...(d.device === 'cpu' ? { num_gpu: 0, ...(d.cpuThreads ? { num_thread: d.cpuThreads } : {}) } : {}),
  });

  async function post(url, body, signal) {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body), signal });
    if (!r.ok) throw Object.assign(embedError(`HTTP_${r.status}`), { status: r.status });
    return r.json();
  }

  function noteLoad(j) {
    const ms = Number(j?.load_duration) / 1e6;
    if (Number.isFinite(ms) && ms >= COLD_LOAD_MS) { stats.coldLoads += 1; stats.lastLoadMs = Math.round(ms); stats.lastLoadAt = now(); }
  }

  async function rawEmbed(t, texts, kind, signal) {
    const c = cfg();
    const d = decision();
    const timeout = AbortSignal.timeout(kind === 'query' ? (c.timeoutMs?.query ?? 10_000) : (c.timeoutMs?.doc ?? 120_000));
    const sig = anySignal([signal, timeout]);
    let vectors;
    if (c.provider === 'openai-compat') {
      const j = await post(`${baseOf(t)}/v1/embeddings`, { model: t.model, input: texts, ...(c.sendDimensions === false ? {} : { dimensions: t.dim }) }, sig);
      vectors = (j?.data ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => x.embedding);
    } else {
      const j = await post(`${baseOf(t)}/api/embed`, { model: t.model, input: texts, truncate: true, dimensions: t.dim, options: optionsFor(c, d), keep_alive: c.keepAlive ?? '2h' }, sig);
      noteLoad(j);
      vectors = j?.embeddings;
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw embedError('EMBED_SHAPE');
    return vectors.map((v) => {
      if (!Array.isArray(v) || v.length !== t.dim) throw embedError('EMBED_DIM');
      return l2(v);
    });
  }

  function noteFailure(e, callerAborted) {
    if (e?.name === 'AbortError' && callerAborted) return;   // 调用方自己放弃的不算
    const code = String(e?.code ?? e?.name ?? 'Error').slice(0, 40);
    stats.failures += 1;
    stats.errors[code] = (stats.errors[code] ?? 0) + 1;
    stats.lastError = { code, at: now() };
    breaker.failures += 1;
    const bc = cfg().breaker ?? { failures: 2, coolMs: 60_000 };
    if (breaker.failures >= bc.failures) { breaker.openUntil = now() + bc.coolMs; log.warn('embed.breaker', { coolMs: bc.coolMs, error: code }); }
    // 只有服务端报错（5xx：加载失败、显存不够、CUDA 出错）才算显卡的问题；连不上、超时、形状不对都和显卡无关
    if (decision().device === 'gpu' && e?.status >= 500) { try { governor?.reportGpuError?.(); } catch { /* 忽略 */ } }
  }

  /** 一次端口请求（经队列）。 */
  function runOne(t, texts, kind, priority, signal) {
    return q.run(async (sig) => {
      const t0 = now();
      stats.requests += 1; stats.texts += texts.length;
      try {
        const vectors = await rawEmbed(t, texts, kind, sig);
        breaker.failures = 0;
        stats.lastMs = now() - t0;
        if (kind === 'query') stats.lastQueryMs = stats.lastMs;
        lastUseAt = now(); lastUseModel = t.model; optsStale = false;
        return vectors;
      } catch (e) {
        noteFailure(e, !!signal?.aborted);
        throw e;
      }
    }, { priority, signal });
  }

  /** 模型现在可能不在内存里（闲过了 keep_alive、或者健康检查看到它不在）。 */
  function maybeCold(t) {
    const c = cfg();
    if (optsStale) return true;
    const recentCheck = health.at > 0 && now() - health.at < 2 * (c.healthMs ?? 30_000);
    if (recentCheck && health.loaded === false && health.at >= lastUseAt) return true;   // 用过之后查过一次，已经不在了
    if (lastUseModel === t.model && now() - lastUseAt < keepAliveMs(c.keepAlive ?? '2h') - 60_000) return false;
    return !(recentCheck && health.loaded === true);
  }

  const port = {
    /** 当前活动档位的空间（建 vector_spaces 行用）。device 是降级级别的依据（§8.8）。 */
    info() {
      const t = current();
      if (!t) return { spaceId: '', model: '', dim: 0, docTplVer: '' };
      const digest = health.digests.get(t.model) ?? null;   // 模型文件的指纹（健康检查从 /api/tags 读到的）：核心据此判断模型有没有被悄悄换过
      return { spaceId: t.spaceId, model: t.model, quant: t.quant, dim: t.dim, docTplVer: t.docTplVer, device: decision().device === 'gpu' ? 'gpu' : 'cpu',
        ...(digest ? { digest } : {}) };
    },
    /**
     * @param {string[]} texts
     * @param {'query'|'doc'} kind
     * @param {{priority?: number, signal?: AbortSignal, spaceId?: string}} [opt]
     */
    async embed(texts, kind, opt = {}) {
      if (!Array.isArray(texts) || !texts.length) return { spaceId: current()?.spaceId ?? '', vectors: [] };
      if (off()) throw embedError('NO_MODEL');
      const t = (opt.spaceId && findTier(opt.spaceId)) || current();
      if (!t) throw embedError('NO_MODEL');
      if (breaker.openUntil > now()) throw embedError('EMBED_BREAKER');
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      const input = texts.map((x) => String(x ?? ''));
      if (kind === 'query') return { spaceId: t.spaceId, vectors: await runOne(t, input, kind, 0, opt.signal) };
      // 文档批切成小片，每片单独排队：中途来的查询只等手上这一片
      const priority = Number.isFinite(opt.priority) ? 1 + opt.priority : 5;
      const ds = cfg().docSlice ?? { cpu: 1, gpu: 16 };
      const size = Math.max(1, Number(decision().device === 'gpu' ? ds.gpu : ds.cpu) || input.length);
      const vectors = [];
      for (let i = 0; i < input.length; i += size) {
        if (i > 0 && breaker.openUntil > now()) throw embedError('EMBED_BREAKER');
        vectors.push(...await runOne(t, input.slice(i, i + size), kind, priority, opt.signal));
      }
      return { spaceId: t.spaceId, vectors };
    },
    /**
     * 预热（可选的端口方法，核心在有人说话时调）：模型可能已经被卸掉时，发一个空的 /api/embed 让 Ollama 先把它加载上，
     * 带和查询一样的加载参数和 keep_alive。已经热着、刚预热过、熔断中、不是 Ollama 就什么都不发。从不抛错。
     * @returns {Promise<boolean>} 这次有没有真的发预热请求
     */
    async warm() {
      try {
        const c = cfg();
        const t = current();
        if (!t || c.provider === 'openai-compat' || breaker.openUntil > now()) return false;
        if (warming) return warming;
        if (now() - warmAt < (c.warmMinGapMs ?? 20_000)) return false;
        if (!maybeCold(t)) return false;
        warmAt = now();
        warming = q.run(async () => {
          const t0 = now();
          await post(`${baseOf(t)}/api/embed`, { model: t.model, input: [], options: optionsFor(c, decision()), keep_alive: c.keepAlive ?? '2h' },
            AbortSignal.timeout(c.timeoutMs?.warm ?? 60_000));
          const ms = now() - t0;
          stats.warms += 1;
          if (ms >= COLD_LOAD_MS) { stats.coldLoads += 1; stats.lastLoadMs = ms; stats.lastLoadAt = now(); }
          lastUseAt = now(); lastUseModel = t.model; health.loaded = true; optsStale = false;
          return true;
        }, { priority: 0 }).catch((e) => {
          stats.lastError = { code: String(e?.code ?? e?.name ?? 'Error').slice(0, 40), at: now(), warm: true };
          return false;
        }).finally(() => { warming = null; });
        return warming;
      } catch { return false; }
    },
    /** 健康检查（§10.7：每 30 秒）：服务可达、版本、模型在不在、我们的模型在不在内存里、占了多少显存。 */
    async checkHealth() {
      const c = cfg();
      if (c.provider === 'none') {
        health.ok = false; health.at = now(); health.error = null; health.models = []; health.version = null; health.loaded = null; health.vramMb = 0;
        return port.health();
      }
      const base = String(current()?.url ?? c.url).replace(/\/+$/, '');
      try {
        if (c.provider === 'openai-compat') {
          const r = await fetchImpl(`${base}/v1/models`, { headers: authHeaders(), signal: AbortSignal.timeout(c.timeoutMs?.health ?? 5000) });
          // 不少服务没有 /v1/models（或不列嵌入模型）：404 / 405 只说明清单拿不到，服务本身是通的；401 / 403 是 Key 不对
          const noList = r.status === 404 || r.status === 405;
          health.ok = r.ok || noList;
          health.version = null;
          health.models = r.ok ? ((await r.json())?.data ?? []).map((m) => m.id).filter(Boolean) : [];
          health.loaded = null;
          if (!health.ok) { health.at = now(); health.error = `HTTP_${r.status}`; return port.health(); }
        } else {
          const [v, tags, ps] = await Promise.all([
            fetchImpl(`${base}/api/version`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)),
            fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)),
            fetchImpl(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          ]);
          health.ok = !!v;
          health.version = v?.version ?? null;
          health.models = (tags?.models ?? []).map((m) => m.name ?? m.model).filter(Boolean);
          if (tags) {
            health.digests = new Map();
            for (const m of tags.models ?? []) {
              const name = m?.name ?? m?.model;
              if (name && typeof m.digest === 'string' && m.digest) health.digests.set(name, m.digest.slice(0, 128));
            }
          }
          const mine = (ps?.models ?? []).find((m) => (m.name ?? m.model) === current()?.model);
          health.vramMb = mine?.size_vram ? Math.round(mine.size_vram / 1048576) : 0;
          health.loaded = ps ? !!mine : null;
        }
        health.error = null;
        if (health.ok && breaker.openUntil > now()) { breaker.openUntil = 0; breaker.failures = 0; }
      } catch (e) {
        health.ok = false; health.error = e?.code ?? e?.name ?? 'Error';
        breaker.failures += 1;
        const bc = cfg().breaker ?? { failures: 2, coolMs: 60_000 };
        if (breaker.failures >= bc.failures) breaker.openUntil = now() + bc.coolMs;
      }
      health.at = now();
      return port.health();
    },
    health() {
      const t = current();
      const external = cfg().provider === 'openai-compat';
      return { ok: health.ok, at: health.at, version: health.version, model: t?.model ?? null,
        // 外部服务没列出模型清单时不知道在不在（null），别当成「不在」
        modelPresent: t ? (external && !health.models.length ? null : health.models.includes(t.model)) : false,
        provider: cfg().provider, disabled: off(), tier: cfg().tier, dim: t?.dim ?? null, spaceId: t?.spaceId ?? null, breakerOpen: breaker.openUntil > now(), error: health.error, ownVramMb: health.vramMb,
        loaded: health.loaded };
    },
    /** 我们的模型现在占了多少显存（资源管家扣掉它）。 */
    ownVramMb: () => health.vramMb || current()?.vramMb || 0,
    /** 让出 GPU：对 GPU 上的实例发 keep_alive: 0 卸掉，之后的请求带 num_gpu: 0（§8.6.2「切换怎么执行」）。 */
    async unloadGpu() {
      const t = current();
      if (!t || cfg().provider === 'openai-compat') return false;
      try {
        await post(`${baseOf(t)}/api/embed`, { model: t.model, input: [], keep_alive: 0 }, AbortSignal.timeout(5000));
        health.vramMb = 0; health.loaded = false; lastUseAt = 0;
        return true;
      } catch { return false; }
    },
    /**
     * 资源管家的决定变了：从 GPU 退回 CPU 时先卸掉；设备变了以后，最近有人用过就按新设备预热一次
     * （否则下一条消息的查询要替换设备付加载的钱）。
     */
    onDeviceChange(next) {
      const prev = lastDevice;
      const prevThreads = lastThreads;
      lastDevice = next?.device ?? null;
      lastThreads = next?.cpuThreads ?? null;
      // 还在 GPU 上只是 CPU 线程数变了：GPU 上不带 num_thread，模型不用重新加载
      if (prev === lastDevice && (lastDevice !== 'cpu' || prevThreads === lastThreads)) return;
      const active = lastUseAt > 0 && now() - lastUseAt < keepAliveMs(cfg().keepAlive ?? '2h');
      lastUseAt = 0;   // 加载参数变了，原来热着的那份不算数
      optsStale = true;   // 健康检查看到的「在内存里」也不算数（按名字认的，可能是旧参数那一份）
      warmAt = 0;
      const after = prev === 'gpu' && lastDevice === 'cpu' ? port.unloadGpu() : Promise.resolve(false);
      after.catch(() => false).then(() => (active ? port.warm() : false)).catch(() => {});
    },
    startHealth() {
      if (healthTimer) return;
      // 启动：先查一次健康，服务在就把模型加载上（第一条消息不用等冷加载）
      port.checkHealth().then((h) => (h.ok ? port.warm() : false)).catch(() => {});
      healthTimer = setInterval(() => { port.checkHealth().catch(() => {}); }, cfg().healthMs ?? 30_000);
      healthTimer.unref?.();
    },
    status() {
      return { ...port.health(), queue: q.size, ...stats, byKind: { ...stats.byKind }, errors: { ...stats.errors },
        lastError: stats.lastError ? { ...stats.lastError } : null, keepAlive: cfg().keepAlive ?? '2h', device: decision().device === 'gpu' ? 'gpu' : 'cpu' };
    },
    dispose() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } q.clear(); },
  };
  lastDevice = decision().device;
  lastThreads = decision().cpuThreads ?? null;
  return port;
}
