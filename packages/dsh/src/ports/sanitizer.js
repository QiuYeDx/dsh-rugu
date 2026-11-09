// Sanitizer 端口（§3.3、§7.1 第 2 步）：核心先做通用的清洗（令牌、长串、本机路径、不可见字符），再调这里。
// 这里只放宿主相关的：插值语法 {{ }}（F2）、注入块和唤醒头用的【】。平台相关的转义由适配器提供，按适配器 id 叠加进来（评审:UV-03）。
import { sanitizeForPrompt } from '../host/util.js';

export function createSanitizer() {
  /** @type {Map<string, {forStore?: (t: string, o: object) => string, forPrompt?: (t: string) => string}>} */
  const extra = new Map();
  const safe = (fn, text, ...args) => { try { const r = fn(text, ...args); return typeof r === 'string' ? r : text; } catch { return text; } };
  return {
    /** 入库前：存原文（要可检索），宿主这一层不改；适配器的入库清洗按来源叠加。 */
    forStore(text, origin) {
      let s = String(text ?? '');
      const a = origin?.adapter ? extra.get(origin.adapter) : null;
      if (a?.forStore) s = safe(a.forStore, s, origin);
      return s;
    },
    /** 进提示词前（注入、给 LLM）：【】换成「」、拆开 {{ }}、去不可见字符；再叠加各适配器的转义。 */
    forPrompt(text) {
      let s = sanitizeForPrompt(text, { keepNewlines: true });
      for (const a of extra.values()) if (a.forPrompt) s = safe(a.forPrompt, s);
      return s;
    },
    /** 适配器（或它的 DSH 绑定）带来的平台转义。返回注销函数。 */
    register(adapterId, s) {
      if (!s || (typeof s.forStore !== 'function' && typeof s.forPrompt !== 'function')) return () => {};
      extra.set(adapterId, s);
      return () => { if (extra.get(adapterId) === s) extra.delete(adapterId); };
    },
  };
}
