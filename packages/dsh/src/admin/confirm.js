// 确认令牌（§12.4.5、§12.6、§12.7、§13.1）：会改掉找不回来的东西、或者把她放到更多人面前的操作，必须分两步走——
//   1. 页面先 prepare：服务端算出预览（会删什么、会恢复成什么样），发一个一次性的令牌，需要时再给一句确认语；
//   2. 主人看过预览、手动输入确认语后，页面带着令牌和输入的确认语再提交一次。
// 令牌绑定「哪个操作 + 哪些参数」：拿着删 A 的令牌删不了 B；用过就作废；10 分钟过期。确认语输错不作废令牌（可以重输），
// 错 5 次作废。令牌只在内存里，DSH 重启就全没了（重新预览即可）。这里不记任何记忆内容，只记参数的哈希。
import crypto from 'node:crypto';
import { samePhrase } from './check.js';

const TTL_MS = 10 * 60_000;
const MAX_TOKENS = 200;
const MAX_TRIES = 5;

/** 参数的规范化 JSON（键排序），用来绑定令牌和参数。 */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const digest = (action, params) => crypto.createHash('sha256').update(action).update('\n').update(canonical(params)).digest('hex');

/** 需要确认、但请求里没带（或令牌不对、过期了）。 */
export class ConfirmError extends Error {
  /**
   * @param {'CONFIRM_REQUIRED'|'CONFIRM_MISMATCH'} code
   * @param {string} message
   * @param {{reasons?: string[]}} [extra]   reasons：宿主说的「为什么要确认」（给主人看的短句，不含记忆内容）
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ConfirmError';
    this.code = code;
    if (Array.isArray(extra.reasons) && extra.reasons.length) this.reasons = extra.reasons.slice(0, 8).map((r) => String(r).slice(0, 200));
  }
}

/**
 * @param {{now?: () => number}} [opt]
 */
export function createConfirmStore(opt = {}) {
  const now = opt.now ?? (() => Date.now());
  /** @type {Map<string, {action: string, digest: string, phrase: string|null, expiresAt: number, tries: number}>} */
  const tokens = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of tokens) if (v.expiresAt <= t) tokens.delete(k);
    while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
  }

  return {
    /**
     * 发一个令牌。phrase 不为 null 时，提交时必须一字不差地输入它。
     * @param {string} action
     * @param {unknown} params   只放决定「操作对象」的参数（不放恢复码这类秘密）
     * @param {{phrase?: string|null}} [o]
     * @returns {{token: string, phrase: string|null, expiresAt: number}}
     */
    issue(action, params, o = {}) {
      sweep();
      const token = crypto.randomBytes(18).toString('base64url');
      const expiresAt = now() + TTL_MS;
      tokens.set(token, { action, digest: digest(action, params), phrase: o.phrase ?? null, expiresAt, tries: 0 });
      return { token, phrase: o.phrase ?? null, expiresAt };
    },
    /**
     * 核对并作废。不对就抛 ConfirmError：没带 / 不认识 / 过期 / 参数对不上 → CONFIRM_REQUIRED（回去重新预览）；确认语不对 → CONFIRM_MISMATCH。
     * @param {string} action
     * @param {unknown} params
     * @param {unknown} confirm   请求里的 {token, typed?}
     */
    consume(action, params, confirm) {
      sweep();
      const token = confirm && typeof confirm === 'object' ? /** @type {any} */ (confirm).token : undefined;
      const typed = confirm && typeof confirm === 'object' ? /** @type {any} */ (confirm).typed : undefined;
      const rec = typeof token === 'string' ? tokens.get(token) : undefined;
      if (!rec || rec.action !== action || rec.expiresAt <= now()) throw new ConfirmError('CONFIRM_REQUIRED', '这个操作要先预览、再确认（确认已过期的话重新预览一次）');
      if (rec.digest !== digest(action, params)) { tokens.delete(token); throw new ConfirmError('CONFIRM_REQUIRED', '确认的对象和要做的对不上，请重新预览'); }
      if (rec.phrase != null && !samePhrase(typed, rec.phrase)) {
        rec.tries += 1;
        if (rec.tries >= MAX_TRIES) tokens.delete(token);
        throw new ConfirmError('CONFIRM_MISMATCH', `确认语不对，请照着输入：${rec.phrase}`);
      }
      tokens.delete(token);
      return { phrase: rec.phrase };
    },
    /** 测试和诊断用：还有几个没用的令牌。 */
    get size() { sweep(); return tokens.size; },
    clear() { tokens.clear(); },
  };
}
