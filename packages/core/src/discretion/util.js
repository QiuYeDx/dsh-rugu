// discretion 内部的小工具：参数、排序、JSON、跨模块调用的兜底、清洗和围栏。
import crypto from 'node:crypto';
import { bumpMetric } from '../store/index.js';
import { DEFAULTS } from '../config/defaults.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MIN = 60_000;

/** 限制的严格程度：none < soft < strict。 */
export const RESTRICTION_RANK = Object.freeze({ none: 0, soft: 1, strict: 2 });
export const RESTRICTION_BY_RANK = Object.freeze(['none', 'soft', 'strict']);
/**
 * 这一轮带按轮污点（§9.6）的标记：她在这一轮里的每次外发（utterances.reasons_json）都带上它，
 * 夜间整理据此不拿这些话当成长的依据（§5.7）。
 */
export const TURN_TAINT_MARK = 'turn-tainted';

/** 关口①结论的严格程度：share < share_vague < aware_private < omit。 */
export const VERDICT_RANK = Object.freeze({ share: 0, share_vague: 1, aware_private: 2, omit: 3 });
export const VERDICTS = Object.freeze(['share', 'share_vague', 'aware_private', 'omit']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 当前的 discretion 参数（每次都从 config.get() 取，热加载）。数值都在 config/defaults.js 的 discretion 段，
 * mergeConfig 保证快照里的键是全的；快照里整段都没有（手搭的测试 core）才用默认值。
 * @param {import('../core-types.js').CoreContext} core
 * @returns {typeof DEFAULTS.discretion}
 */
export function dcfg(core) {
  return core.config.get().discretion ?? DEFAULTS.discretion;
}

export function rRank(r) { return RESTRICTION_RANK[r] ?? RESTRICTION_RANK.strict; }
export function stricterRestriction(a, b) { return rRank(a) >= rRank(b) ? (a ?? 'strict') : b; }
export function vRank(v) { return VERDICT_RANK[v] ?? VERDICT_RANK.omit; }
/** 两个结论里更严的那个。 */
export function stricterVerdict(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return vRank(a) >= vRank(b) ? a : b;
}

export function parseJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}

/** 正整数 id 的数组：去重、升序；不是数组返回 null。 */
export function idList(v) {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0))];
  return out.sort((a, b) => a - b);
}

export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

export function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t;
}

/** 不透明的随机令牌（appraise 每次新生成）。 */
export function newToken() { return crypto.randomBytes(18).toString('base64url'); }

/** 内部的不透明键（缓存键、来源键……），一律经 keyring 的 HMAC。 */
export function hkey(core, ...parts) { return core.keys.hash('discretion', ...parts); }

export function sha16(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

/** 计数（只读库不计）。 */
export function metric(core, name, by = 1) {
  try { if (!core.readOnly && core.store && !core.store.closed) bumpMetric(core.store, `discretion.${name}`, by); } catch { /* 计数失败不影响主流程 */ }
}

/** 记一条只有 id / 类型 / 计数的日志（§12.3）。 */
export function warn(core, event, fields = {}) {
  try { core.log.warn(`discretion.${event}`, fields); } catch { /* 忽略 */ }
}
export function info(core, event, fields = {}) {
  try { core.log.info(`discretion.${event}`, fields); } catch { /* 忽略 */ }
}
export const errCode = (e) => String(e?.code ?? e?.name ?? 'Error').slice(0, 40);

/**
 * 调别的模块：出错时记日志、计数，返回 fallback（降级，不往上抛）。
 * @template T
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} what
 * @param {() => T} fn
 * @param {T} fallback
 * @returns {T}
 */
export function soft(core, what, fn, fallback) {
  try { return fn(); } catch (e) {
    warn(core, 'dep', { what, error: errCode(e) });
    metric(core, `dep.${what}.error`);
    return fallback;
  }
}
/** soft 的异步版。 */
export async function softAsync(core, what, fn, fallback) {
  try { return await fn(); } catch (e) {
    warn(core, 'dep', { what, error: errCode(e) });
    metric(core, `dep.${what}.error`);
    return fallback;
  }
}

/**
 * 给 LLM 的文字：先过 intake.sanitizeForPrompt（通用清洗 + 宿主的 Sanitizer），再中和我们自己的围栏标记。
 * 清洗不可用时返回 null：调用方据此 fail closed（不把没清洗过的内容交给模型）。
 */
export function promptText(core, text, max) {
  if (text == null) return '';
  let t;
  try { t = core.mods.intake.sanitizeForPrompt(core, String(text)); } catch (e) {
    warn(core, 'sanitize', { error: errCode(e) });
    return null;
  }
  t = String(t ?? '').replace(/<<<|>>>/g, '〈〈').replace(/[\r\n]+/g, ' ').trim();
  return max ? clip(t, max) : t;
}

/**
 * 【D111 评审】判断提示词里的场合称呼：真名写「X」（名字里自带的引号换成空格，免得提前合上引号），一句说法（「一个 QQ 群」）不加引号、
 * 后面注明不知道名字——不然模型会把说法当成名字写回去。info 是 facts.settingInfo 的结果（带 labelKind）；没有就写「（不清楚）」。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{label?: string, labelKind?: string}|null} info
 * @param {number} [max]
 * @returns {string}
 */
export function placeText(core, info, max = 30) {
  const t = String(promptText(core, info?.label ?? '', max) ?? '').replace(/[「」『』“”"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return info ? '「」' : '（不清楚）';
  return info?.labelKind === 'description' ? `${t}（不知道名字）` : `「${t}」`;
}

/** 围栏：里面的东西只是数据。 */
export function fence(label, body) {
  return `<<<${label}\n${body}\n${label}>>>`;
}

/**
 * Promise 和截止时间赛跑：到点没完成返回 {done:false}，不取消原 Promise（它在后台继续，结果进缓存）。
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @returns {Promise<{done: true, value: T}|{done: false}>}
 */
export function raceDeadline(p, ms) {
  if (!(ms > 0)) return Promise.resolve({ done: false });
  let timer;
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); });
  return Promise.race([p.then((value) => ({ done: true, value })), t]).finally(() => clearTimeout(timer));
}

/** 一个带超时的 AbortSignal（并上外部的 signal）。 */
export function timeoutSignal(ms, outer) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), Math.max(1, ms));
  const onAbort = () => ctl.abort(outer.reason);
  if (outer) {
    if (outer.aborted) ctl.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ctl.signal, done: () => { clearTimeout(timer); outer?.removeEventListener?.('abort', onAbort); }, abort: () => ctl.abort() };
}

/** 很小的信号量（第二段评估并发 2，§10.6）。 */
export function semaphore(n) {
  let active = 0;
  const waiting = [];
  return {
    async run(fn) {
      if (active >= n) await new Promise((r) => waiting.push(r));
      active += 1;
      try { return await fn(); } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}

/** JSONL 宽进严出：逐行解析，坏行跳过。 */
export function parseJsonlObjects(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim().replace(/^```(?:json|jsonl)?/i, '').replace(/```$/, '').trim();
    if (!s || s[0] !== '{') continue;
    try { const o = JSON.parse(s); if (isPlain(o)) out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out;
}

export const setOf = (xs) => new Set((xs ?? []).filter((x) => x != null));
export function intersect(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}
