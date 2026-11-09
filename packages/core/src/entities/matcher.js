// 名字匹配器（§5.2、§8.1）：用实体名字表建一个多模式匹配器（Aho-Corasick），零 LLM、亚毫秒级。
//   - 同名的几个档案全都返回，按作用域和激活加权，由融合打分区分（评审:SC-16）；
//   - 「保留名」不让文中同名的人被强制认成主人：主人和同名的人一起返回，分数照常算；
//   - 关系词（「表哥」）也是从数据里来的模式（关系描述表），只在有锚点时才落到档案上：
//     正文里紧挨着某个名字（「阿明的表哥」），或者调用方给了锚点（说话人「我表哥」）。
//   - 互相包含的名字取最长的那个（「小鱼干」里不报「小鱼」）；拉丁字母开头或结尾的名字按整词匹配。
import { normalizeWithMap, isAsciiAlnum, charLength } from './normalize.js';

/**
 * Aho-Corasick 自动机（纯数据结构）。keys 是规范化后的字符串。
 * @param {string[]} keys
 */
export function buildAutomaton(keys) {
  /** @type {Map<string, number>[]} */ const next = [new Map()];
  const fail = [0];
  /** @type {number[][]} */ const out = [[]];
  const dict = [-1];          // 最近的、自己有输出的失败祖先（输出链）
  const lens = [];
  keys.forEach((k, idx) => {
    let s = 0;
    let n = 0;
    for (const c of k) {
      n++;
      let t = next[s].get(c);
      if (t === undefined) {
        t = next.length;
        next.push(new Map()); fail.push(0); out.push([]); dict.push(-1);
        next[s].set(c, t);
      }
      s = t;
    }
    lens[idx] = n;
    if (n > 0) out[s].push(idx);
  });
  // BFS 建失败链接
  const queue = [];
  for (const t of next[0].values()) { fail[t] = 0; queue.push(t); }
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const [c, v] of next[u]) {
      let f = fail[u];
      while (f > 0 && !next[f].has(c)) f = fail[f];
      const g = next[f].get(c);
      fail[v] = g !== undefined && g !== v ? g : 0;
      dict[v] = out[fail[v]].length ? fail[v] : dict[fail[v]];
      queue.push(v);
    }
  }
  return {
    size: next.length,
    /**
     * @param {string[]} chars 规范化后的码点数组
     * @returns {{start: number, end: number, key: number}[]} 规范化坐标，end 不含
     */
    search(chars) {
      const hits = [];
      let s = 0;
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        while (s > 0 && !next[s].has(c)) s = fail[s];
        s = next[s].get(c) ?? 0;
        for (let t = out[s].length ? s : dict[s]; t > 0; t = dict[t]) {
          for (const k of out[t]) hits.push({ start: i + 1 - lens[k], end: i + 1, key: k });
        }
      }
      return hits;
    },
  };
}

/**
 * 在一段文字里找模式（规范化 + 原文位置 + 整词检查）。
 * @param {ReturnType<typeof buildAutomaton>} ac
 * @param {string[]} keys
 * @param {string} text
 * @returns {{start: number, end: number, origStart: number, origEnd: number, key: number}[]}
 */
export function findAll(ac, keys, text) {
  const { chars, map } = normalizeWithMap(text);
  if (!chars.length) return [];
  const res = [];
  for (const h of ac.search(chars)) {
    const origStart = map[h.start][0];
    const origEnd = map[h.end - 1][1];
    const first = chars[h.start];
    const last = chars[h.end - 1];
    // 拉丁字母数字开头 / 结尾的模式按整词：原文里紧挨着的也是字母数字就不算
    if (isAsciiAlnum(first) && isAsciiAlnum(text[origStart - 1])) continue;
    if (isAsciiAlnum(last) && isAsciiAlnum(text[origEnd])) continue;
    res.push({ ...h, origStart, origEnd });
  }
  return res;
}

/** 去掉被更长的命中完全包含的命中（「小鱼干」里的「小鱼」）。输入同一类命中。 */
export function dropContained(hits) {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const h of sorted) {
    const covered = sorted.some((o) => o !== h && o.start <= h.start && o.end >= h.end && (o.end - o.start) > (h.end - h.start));
    if (!covered) kept.push(h);
  }
  return kept;
}

/**
 * 名字表 + 关系词 → 匹配器的静态部分（不含打分，打分要读当前激活）。
 * @param {{names: {entity_id: number, text_norm: string, name_kind: string, scope_setting_key: string, count: number, used_by: number}[],
 *          relations: string[], minChars: number}} src
 */
export function compilePatterns({ names, relations, minChars }) {
  /** @type {Map<string, {names: object[], relation: boolean}>} */
  const byKey = new Map();
  const entry = (k) => { let e = byKey.get(k); if (!e) { e = { names: [], relation: false }; byKey.set(k, e); } return e; };
  for (const n of names) {
    if (!n.text_norm || charLength(n.text_norm) < minChars) continue;
    entry(n.text_norm).names.push(n);
  }
  for (const r of relations) {
    if (!r || charLength(r) < minChars) continue;
    entry(r).relation = true;
  }
  const keys = [...byKey.keys()];
  return { keys, info: keys.map((k) => byKey.get(k)), ac: buildAutomaton(keys) };
}
