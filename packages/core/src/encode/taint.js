// 污点检查（§7.3，评审:PS-03，纯代码，写入前做）：第二组背景（只供理解的）里的区分性词（lang.distinctiveTerms：
// 高 IDF 的二元组、数字、实体名）出现在 header / narrative 里就去掉那一句；出现在某条事实里、却没记进 used_bg 的，补记进去，
// 这条事实的规范取最严（写入时按 used_bg 合并背景的规范）。不靠模型自报。
// 本段原文和「本场合的人本来就知道」的背景里本来就有的词不算（runExtract 预先算 terms 时用 exclude 去掉）。
import { normText, sentences } from './util.js';

const FACTISH = new Set(['fact', 'plan', 'self', 'rel']);
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function usable(t) {
  const n = normText(t);
  if (!n) return null;
  if (/^\d+$/.test(n)) return n.length >= 2 ? n : null;   // 一位数太常见
  return [...n].length >= 2 ? n : null;
}

function hit(hay, term) {
  if (/^\d+$/.test(term)) return new RegExp(`(?<!\\d)${term}(?!\\d)`).test(hay);
  return hay.includes(term);
}

/**
 * 实现 encode.taintCheck。privateBackground 的每一项可以带 code（提示词里的编号 p1…，记进 used_bg 的就是它）
 * 和预先算好的 terms；没有 terms 时按 lang.distinctiveTerms(text)（不给 idf：只有数字和名字）现算。
 * 返回新的行数组（被改动的行带 tainted: true）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('./index.js').ExtractLine[]} lines
 * @param {{text: string, ref: string, code?: string, terms?: string[]}[]} privateBackground
 */
export function taintCheck(core, lines, privateBackground) {
  const items = [];
  for (const b of privateBackground ?? []) {
    let terms = b.terms;
    if (!terms) {
      try { terms = core.mods.lang.distinctiveTerms(core, String(b.text ?? ''), {}); } catch { terms = []; }
    }
    const norm = [...new Set(arr(terms).map(usable).filter(Boolean))];
    if (norm.length) items.push({ code: b.code ?? b.ref, terms: norm });
  }
  if (!items.length) return lines.map((l) => ({ ...l }));
  const leaks = (text) => {
    const hay = normText(text);
    return items.filter((i) => i.terms.some((t) => hit(hay, t)));
  };
  return lines.map((l) => {
    if (l.type === 'header' || l.type === 'narrative') {
      const parts = sentences(l.text);
      const kept = parts.filter((s) => leaks(s).length === 0);
      let title = l.title;
      if (title && leaks(title).length) title = '';
      if (kept.length === parts.length && title === l.title) return { ...l };
      return { ...l, text: kept.join('').trim(), title, tainted: true, removed: parts.length - kept.length };
    }
    if (FACTISH.has(l.type)) {
      const found = leaks([l.text, l.value].filter(Boolean).join(' '));
      if (!found.length) return { ...l };
      const used = new Set(arr(l.used_bg));
      let added = false;
      for (const i of found) if (!used.has(i.code)) { used.add(i.code); added = true; }
      return added ? { ...l, used_bg: [...used], tainted: true } : { ...l };
    }
    return { ...l };
  });
}
