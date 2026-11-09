// 嵌入的三档（D127）：管理页「设置 → 嵌入」和首次设置共用。
//   none      不用嵌入：什么都不用装，回想走 L3（字面、人和事、时间、在场的人，再用已有的向量找近邻）；
//   ollama    本机 Ollama：自动探测，按硬件推荐 4B / 0.6B，用 Ollama 的 /api/pull 下载模型并报进度。不替主人装 Ollama，只给下载链接；
//   external  外部服务（OpenAI 兼容的 /v1/embeddings）：页面填地址、模型、维度、可选 API Key，能「测试连接」。
// Key 单独存一个文件（<DSH 家目录>/persona-memory-embedding.key，权限 0600），配置、日志、导出、备份里都没有它；页面上只能看到「存过 / 没存过」。
// 这里不碰核心：换模型之后核心按端口的 info() 自己建影子空间、后台重嵌（§8.6.1）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { parseNvidiaSmi } from './gpu/sampler.js';

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';
const KEY_MAX = 512;
/** 下载多久一点进度都没有就算卡住（Ollama 偶尔会停在半路）。 */
const STALL_MS = 120_000;
/** 大约的下载体积（给人看的，以 Ollama 报的为准）。 */
const TIER_SIZE = Object.freeze({ standard: '约 2.5 GB', light: '约 0.6 GB' });

/** 地址规范化：只收 http(s)，去掉结尾的 /、/v1、/embeddings。不合法返回 null。 */
export function normalizeBase(u) {
  const s = String(u ?? '').trim();
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;   // 账号密码不许放在地址里（地址会进配置文件）
  const p = url.pathname.replace(/\/+$/, '').replace(/\/embeddings$/, '').replace(/\/v1$/, '').replace(/\/+$/, '');
  return `${url.origin}${p}`;
}

/** 地址是不是在这台电脑或局域网里（false = 记忆文本会离开你的网络）。 */
export function isPrivateUrl(u) {
  let host;
  try { host = new URL(String(u)).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.endsWith('.local')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * 按硬件推荐档位。显卡够用就 4B；显存小或只有 CPU 用 0.6B（CPU 上 4B 单条要 0.3–0.7 秒以上，常错过回想的时限）。
 * @param {{vramMb?: number|null, ramMb?: number|null}} hw
 * @returns {{tier: 'standard'|'light', reason: string}}
 */
export function recommendTier({ vramMb = null, ramMb = null } = {}) {
  const gb = (mb) => `${Math.round(mb / 102.4) / 10} GB`;
  if (Number.isFinite(vramMb) && vramMb >= 6000) return { tier: 'standard', reason: `显卡显存 ${gb(vramMb)}，跑 4B 没问题` };
  if (Number.isFinite(vramMb)) return { tier: 'light', reason: `显卡显存 ${gb(vramMb)}，4B 放不下，用 0.6B` };
  return { tier: 'light', reason: `没读到独立显卡${Number.isFinite(ramMb) ? `（内存 ${gb(ramMb)}）` : ''}，CPU 上用 0.6B 回想才跟得上` };
}

/** 读 Key 文件（带 mtime 缓存：每次嵌入请求都要它）。没有就是 ''。 */
export function createKeyReader(file, fsImpl = fs) {
  let cached = { mtime: -1, value: '' };
  return () => {
    let st = null;
    try { st = fsImpl.statSync(file, { throwIfNoEntry: false }); } catch { st = null; }
    if (!st) { cached = { mtime: -1, value: '' }; return ''; }
    if (st.mtimeMs !== cached.mtime) {
      try { cached = { mtime: st.mtimeMs, value: fsImpl.readFileSync(file, 'utf8').trim() }; } catch { return ''; }
    }
    return cached.value;
  };
}
function writeKeyFile(file, key, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  try { fsImpl.renameSync(tmp, file); } catch (e) { try { fsImpl.rmSync(tmp, { force: true }); } catch { /* 尽力 */ } throw e; }
}
const codeOf = (e) => String(e?.cause?.code ?? e?.code ?? e?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'Error';

/**
 * @param {{hostConfig: () => any, setConfig: (patch: object, o: {confirm: boolean}) => any, keyFile: string, fetchImpl?: typeof fetch,
 *          log?: {info: Function, warn: Function}, now?: () => number, execFile?: Function, fsImpl?: typeof fs, totalmem?: () => number}} deps
 */
export function createEmbeddingSetup({ hostConfig, setConfig, keyFile, fetchImpl = globalThis.fetch, log = { info() {}, warn() {} }, now = () => Date.now(),
  execFile = execFileCb, fsImpl = fs, totalmem = () => os.totalmem(), noVectorsYet = () => false }) {
  const cfg = () => hostConfig().embedding;
  const readKey = createKeyReader(keyFile, fsImpl);
  const modeOf = (c = cfg()) => (c.provider === 'none' ? 'none' : c.provider === 'openai-compat' ? 'external' : 'ollama');
  /** @type {{state: 'idle'|'running'|'done'|'error'|'cancelled', tier: string|null, model: string|null, status: string, completed: number, total: number, error: string|null, at: number, controller?: AbortController}} */
  let pull = { state: 'idle', tier: null, model: null, status: '', completed: 0, total: 0, error: null, at: 0 };

  function vramMb() {
    return new Promise((resolve) => {
      try {
        execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 3000, windowsHide: true }, (err, stdout) => {
          if (err) return resolve(null);
          const g = parseNvidiaSmi(String(stdout ?? ''));
          resolve(g?.totalMb ?? null);
        });
      } catch { resolve(null); }
    });
  }
  /** 探测一个地址上的 Ollama：连得上、版本、有哪些模型。不抛错。 */
  async function probeOllama(base) {
    try {
      const [v, tags] = await Promise.all([
        fetchImpl(`${base}/api/version`, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)),
        fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      return { url: base, reachable: !!v?.version, version: v?.version ? String(v.version).slice(0, 32) : null, models: (tags?.models ?? []).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean).slice(0, 200), error: v ? null : 'NO_VERSION' };
    } catch (e) { return { url: base, reachable: false, version: null, models: [], error: codeOf(e) }; }
  }
  const pullView = () => ({
    state: pull.state, tier: pull.tier, model: pull.model, status: pull.status, completed: pull.completed, total: pull.total, error: pull.error, at: pull.at,
    pct: pull.total > 0 ? Math.min(100, Math.round((pull.completed / pull.total) * 100)) : null,
  });

  async function status(q = {}) {
    const c = cfg();
    const mode = modeOf(c);
    const asked = q.url ? normalizeBase(q.url) : null;
    const ollamaBase = asked ?? (mode === 'ollama' ? normalizeBase(c.url) ?? DEFAULT_OLLAMA : DEFAULT_OLLAMA);
    const [ollama, vram] = await Promise.all([probeOllama(ollamaBase), vramMb()]);
    const ramMb = Math.round(totalmem() / 1048576);
    const tiers = {};
    for (const t of ['standard', 'light']) {
      const row = c.tiers?.[t] ?? {};
      tiers[t] = { model: row.model ?? '', dim: row.dim ?? 0, size: TIER_SIZE[t], present: ollama.models.includes(row.model) };
    }
    const custom = c.tiers?.custom ?? {};
    return {
      mode,
      url: mode === 'none' ? '' : String(c.url ?? ''),
      tier: c.tier,
      external: mode === 'external' ? { url: String(c.url ?? ''), model: custom.model ?? '', dim: custom.dim ?? 0, thirdParty: !isPrivateUrl(c.url) } : null,
      hasKey: !!readKey(),
      ollama,
      tiers,
      hardware: { vramMb: vram, ramMb },
      recommended: recommendTier({ vramMb: vram, ramMb }),
      pull: pullView(),
      downloadUrl: OLLAMA_DOWNLOAD_URL,
    };
  }

  /** 开始下载一个档位的模型（后台跑，进度看 status().pull）。一次只下一个。 */
  function startPull({ tier, url }) {
    if (pull.state === 'running') throw Object.assign(new Error('已经有一个模型在下载'), { code: 'BUSY' });
    const c = cfg();
    const model = c.tiers?.[tier]?.model;
    if (!model || (tier !== 'standard' && tier !== 'light')) throw Object.assign(new Error('没有这个档位'), { code: 'CONTRACT' });
    const base = normalizeBase(url) ?? (modeOf(c) === 'ollama' ? normalizeBase(c.url) : null) ?? DEFAULT_OLLAMA;
    const controller = new AbortController();
    pull = { state: 'running', tier, model, status: '准备下载', completed: 0, total: 0, error: null, at: now(), controller };
    const job = pull;
    runPull(job, base).catch((e) => {
      if (job !== pull || job.state !== 'running') return;
      Object.assign(job, { state: 'error', error: codeOf(e), at: now() });
      log.warn('embed.pull', { error: job.error });
    });
    return pullView();
  }
  async function runPull(job, base) {
    let stall = null;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => job.controller.abort(Object.assign(new Error('STALLED'), { name: 'STALLED', code: 'STALLED' })), STALL_MS); stall.unref?.(); };
    arm();
    try {
      const r = await fetchImpl(`${base}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: job.model, stream: true }), signal: job.controller.signal });
      if (!r.ok || !r.body) throw Object.assign(new Error('HTTP'), { code: `HTTP_${r.status}` });
      const decoder = new TextDecoder();
      let buf = '';
      let success = false;
      for await (const chunk of r.body) {
        arm();
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch { continue; }
          if (j.error) throw Object.assign(new Error('PULL'), { code: 'PULL_FAILED', detail: String(j.error).slice(0, 200) });
          if (typeof j.status === 'string') job.status = j.status.slice(0, 80);
          if (Number.isFinite(j.total) && j.total > 0) { job.total = j.total; job.completed = Number.isFinite(j.completed) ? j.completed : 0; }
          if (j.status === 'success') success = true;
        }
      }
      if (job !== pull) return;
      if (!success) throw Object.assign(new Error('INCOMPLETE'), { code: 'PULL_INCOMPLETE' });
      Object.assign(job, { state: 'done', status: '下载完成', completed: job.total, at: now() });
      log.info('embed.pull.done', {});
    } catch (e) {
      if (job !== pull || job.state === 'cancelled') return;
      Object.assign(job, { state: 'error', error: codeOf(e?.name === 'AbortError' && job.controller.signal.reason ? job.controller.signal.reason : e), status: e?.detail ?? job.status, at: now() });
      log.warn('embed.pull', { error: job.error });
    } finally { clearTimeout(stall); }
  }
  function cancelPull() {
    if (pull.state !== 'running') return pullView();
    pull.state = 'cancelled';
    pull.at = now();
    try { pull.controller?.abort(); } catch { /* 尽力 */ }
    return pullView();
  }

  /** 测试外部服务（不保存）。key 不给就用存过的。返回值里没有 Key，错误只有状态码。 */
  async function test({ url, model, dim, apiKey }) {
    const base = normalizeBase(url);
    if (!base) return { ok: false, error: 'BAD_URL' };
    const key = String(apiKey ?? '').trim() || readKey();
    const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const call = async (withDim) => {
      const body = { model, input: ['连接测试'], ...(withDim ? { dimensions: dim } : {}) };
      const r = await fetchImpl(`${base}/v1/embeddings`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      return { status: r.status, ok: r.ok, vec: j?.data?.[0]?.embedding };
    };
    const t0 = now();
    try {
      let sendDimensions = Number(dim) > 0;
      let res = await call(sendDimensions);
      // 有些服务不认 dimensions 参数：不带再试一次，能行就记下来以后不带
      if (!res.ok && sendDimensions && (res.status === 400 || res.status === 422)) { sendDimensions = false; res = await call(false); }
      if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, base };
      if (!Array.isArray(res.vec) || !res.vec.length) return { ok: false, error: 'EMBED_SHAPE', base };
      if (Number(dim) > 0 && res.vec.length !== Number(dim)) return { ok: false, error: 'EMBED_DIM', got: res.vec.length, base };
      return { ok: true, dim: res.vec.length, sendDimensions, ms: Math.max(0, now() - t0), base, thirdParty: !isPrivateUrl(base) };
    } catch (e) { return { ok: false, error: codeOf(e), base }; }
  }

  /**
   * 现在的配置 → 要保存的配置，算出这次保存有什么要先告诉主人（给页面的确认框）。
   * @returns {{reasons: string[], changesSpace: boolean, thirdParty: boolean}}
   */
  function reasonsFor(p) {
    const c = cfg();
    const now_ = modeOf(c);
    const reasons = [];
    const curModel = now_ === 'none' ? null : c.tiers?.[c.tier]?.model ?? null;
    const curDim = now_ === 'none' ? null : Number(c.tiers?.[c.tier]?.dim) || null;
    const nextModel = p.mode === 'none' ? null : p.mode === 'ollama' ? c.tiers?.[p.tier]?.model ?? null : p.model;
    const nextDim = p.mode === 'none' ? null : p.mode === 'ollama' ? Number(c.tiers?.[p.tier]?.dim) || null : p.dim;
    const thirdParty = p.mode === 'external' && !isPrivateUrl(p.url);
    if (thirdParty) reasons.push(`记忆文本（聊天里提炼的事实、经历和原话片段）会发给 ${hostOf(p.url)} 算向量。只有你信任这个服务才选它。`);
    // 首次设置时一条向量都没有：换档不用重建，也不用问
    const changesSpace = !noVectorsYet() && !!curModel && !!nextModel && (curModel !== nextModel || curDim !== nextDim);
    if (changesSpace) reasons.push('换了模型，所有记忆要重新算一遍向量：记忆多的时候要几个小时，外部服务按量收费的话会产生费用。算完之前回想照旧用原来的向量，到「诊断 → 向量空间」切换。');
    if (p.mode === 'none' && now_ !== 'none' && !noVectorsYet()) reasons.push('不再算新的向量，回想退回字面、人和事、时间、在场的人这几路：意思相近但说法不同的事不容易想起来。已有的向量留着，以后选回同一个模型还能接着用。');
    return { reasons, changesSpace, thirdParty };
  }

  /**
   * 保存（热加载：不用重启）。apiKey 给了就写进密钥文件，clearKey 删掉。
   * @param {{mode: 'none'|'ollama'|'external', tier?: string, url?: string, model?: string, dim?: number, sendDimensions?: boolean, apiKey?: string, clearKey?: boolean}} p
   */
  function save(p) {
    if (p.mode === 'none') {
      setConfig({ host: { embedding: { provider: 'none' } } }, { confirm: true });
    } else if (p.mode === 'ollama') {
      setConfig({ host: { embedding: { provider: 'ollama-native', tier: p.tier, url: normalizeBase(p.url) ?? DEFAULT_OLLAMA } } }, { confirm: true });
    } else {
      const base = normalizeBase(p.url);
      if (!base) throw Object.assign(new Error('地址不对'), { code: 'CONTRACT' });
      setConfig({ host: { embedding: { provider: 'openai-compat', url: base, tier: 'custom', sendDimensions: p.sendDimensions !== false,
        tiers: { custom: { model: p.model, dim: p.dim, quant: '', vramMb: 0 } } } } }, { confirm: true });
    }
    if (p.clearKey) { try { fsImpl.rmSync(keyFile, { force: true }); } catch { /* 尽力 */ } }
    else if (typeof p.apiKey === 'string' && p.apiKey.trim()) writeKeyFile(keyFile, p.apiKey.trim(), fsImpl);
    log.info('embed.setup.saved', { mode: p.mode });
    return { saved: true };
  }

  /**
   * 首次设置走完时：主人没选、又用不了本机 Ollama（没装、没开、模型没下载）→ 落到「不用嵌入」，而不是停在一个报错的默认档上（什么都不配也能用）。
   * 正在下载的不算：等它下完。
   */
  async function settleDefault() {
    const c = cfg();
    if (modeOf(c) !== 'ollama' || pull.state === 'running') return false;
    const o = await probeOllama(normalizeBase(c.url) ?? DEFAULT_OLLAMA);
    if (o.reachable && o.models.includes(c.tiers?.[c.tier]?.model)) return false;
    setConfig({ host: { embedding: { provider: 'none' } } }, { confirm: true });
    log.info('embed.setup.defaultNone', {});
    return true;
  }

  return { status, startPull, cancelPull, test, save, reasonsFor, readKey, settleDefault, KEY_MAX };
}

const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return '第三方服务'; } };
