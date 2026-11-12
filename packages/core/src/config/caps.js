// 回想各层生效的上限（D165，用户反馈第 39 轮）：「回想 → 关口① → 打包 → 渲染 → 进上下文」这条路上的条数、字数在这里一处算。
//   - 花费档位的 room（budget.presets[档].room，自定义可以单独改）乘各层的条数和总字数，取整、至少 1；不乘每条的字数——
//     哪一档都不截半句：一条被挑中的记忆尽量完整地给，每条的字数上限只是防个别超长条目的保险；
//   - 每条的字数管的是正文：来源说法、「讲过了」的附注、计划的状态说法这些代码拼的短句不占正文的字数，另有小上限（META_CHARS），
//     一条渲染好的总长 ≤ 正文上限 + META_CHARS（itemMax，pack 按它兜底）；
//   - 宿主（集成层）从这里拿到「核心一次最多给多少」（ceiling），自动时它的块上限不比这个小：核心打包出来的东西宿主一定装得下。
// 读这些数的地方（context/pack、context/recall、context/working、context/since、retrieve 的召回名额、回忆的两档）都经过 recallCaps，
// 不到处手乘。快照是深冻结的，按快照缓存。
import { budgetLimits, ROOM_MIN, ROOM_MAX } from './defaults.js';

/** 来源说法、附注这些代码拼的短句合起来最多占多少字（不占正文的字数；超了它们自己被截，不截正文）。 */
export const META_CHARS = 120;
/** 来源说法那一截（「（今晚 18:01 · 36 分钟前，某人在「某群」自己说的）好像」）的上限。 */
export const PREFIX_CHARS = 72;
/** 正文后面的附注（时态、计划状态、叮嘱、「讲过了」……）的上限。 */
export const NOTE_CHARS = 72;

const cache = new WeakMap();
const int = (v, d) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);
const pos = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/**
 * 这一档的 room（记忆给多少的倍数）：预设 + 自定义；读不到、不合法按 1，夹在 ROOM_MIN–ROOM_MAX。
 * @param {object} cfg  core.config.get()
 * @returns {number}
 */
export function roomOf(cfg) {
  let r = 1;
  try { r = Number(budgetLimits(cfg).room); } catch { r = 1; }
  if (!Number.isFinite(r) || r <= 0) r = 1;
  return Math.min(ROOM_MAX, Math.max(ROOM_MIN, r));
}

/**
 * 回想各层生效的上限（D165）。room 乘条数和总字数（取整，至少 1）；每条的字数（正文）不乘。
 * @param {object} cfg  core.config.get()
 * @returns {Readonly<{room: number,
 *   involuntary: {maxItems: number, itemChars: number, maxChars: number}, deliberate: {maxItems: number, itemChars: number},
 *   present: {maxItems: number}, working: {maxLines: number, budgetChars: number, lineChars: number, threadMaxLines: number},
 *   blockMaxChars: number, layers: {warmStart: number, todaySoFar: number, presentRecent: number, todayItems: number, peopleCards: number, peopleCardChars: number},
 *   sinceHere: {maxItems: number, itemChars: number, chars: number}, recollect: {tool: {maxItems: number, itemChars: number, totalChars: number}, auto: {maxItems: number, itemChars: number, totalChars: number}},
 *   pointBack: {max: number, chars: number}, lessons: {recallMax: number, itemChars: number, chars: number}, gapChars: number,
 *   itemMax: Record<string, number>, ceiling: {inject: number, tool: number, look: number}}>}
 */
export function recallCaps(cfg) {
  if (cfg && typeof cfg === 'object' && cache.has(cfg)) return cache.get(cfg);
  const room = roomOf(cfg);
  const n = (v, d) => Math.max(1, Math.round(pos(v, d) * room));
  const R = cfg?.recall ?? {};
  const C = cfg?.context ?? {};
  const L = C.layers ?? {};
  const I = R.involuntary ?? {};
  const D = R.deliberate ?? {};
  const W = R.working ?? {};
  const S = C.sinceHere ?? {};
  const RC = R.recollect ?? {};
  const tier = (t, d) => ({
    maxItems: n(t?.maxItems, d.maxItems),
    itemChars: Math.max(40, int(t?.itemChars, d.itemChars)),
    totalChars: Math.max(200, n(t?.totalChars, d.totalChars)),
  });
  const involuntary = { maxItems: n(I.maxItems, 8), itemChars: Math.max(20, int(I.itemChars, 240)), maxChars: n(I.maxChars, 1600) };
  const deliberate = { maxItems: n(D.maxItems, 12), itemChars: Math.max(20, int(D.itemChars, 240)) };
  const sinceItem = Math.max(20, int(S.itemChars, 200));
  const sinceMax = S.enabled === false ? 0 : n(S.maxItems, 4);
  // 这一层的字数：默认 800 = 件数 × 每件的正文（装得下全部挑中的），和件数一起乘 room；主人手写的照他写的乘
  const sinceChars = n(S.chars, 800);
  const working = {
    maxLines: n(W.maxLines, 16), budgetChars: n(W.budgetChars, 1600), lineChars: Math.max(20, int(W.lineChars, 160)),
    threadMaxLines: Math.max(1, int(W.thread?.maxLines, 10)),
  };
  const recollect = { tool: tier(RC.tool, { maxItems: 36, itemChars: 480, totalChars: 6000 }), auto: tier(RC.auto, { maxItems: 18, itemChars: 360, totalChars: 3000 }) };
  const lessons = { recallMax: Math.max(0, int(cfg?.lessons?.recallMax, 2)), itemChars: Math.max(20, int(cfg?.lessons?.itemChars, 220)), chars: Math.max(0, int(cfg?.lessons?.chars, 480)) };
  const pointBack = { max: Math.max(0, int(C.pointBack?.max, 2)), chars: Math.max(8, int(C.pointBack?.chars, 120)) };
  const layers = {
    warmStart: n(L.warmStart, 800), todaySoFar: n(L.todaySoFar, 450), presentRecent: n(L.presentRecent, 600), todayItems: n(L.todayItems, 3),
    peopleCards: Math.max(0, int(L.peopleCards, 3)), peopleCardChars: Math.max(20, int(L.peopleCardChars, 240)),
  };
  const blockMaxChars = n(C.blockMaxChars, 2000);
  const itemChars = Math.max(involuntary.itemChars, deliberate.itemChars);
  // 时间间隔那一行（gapText）：整行 ≤ 不自主回想一条的正文 + 40（说清隔了多久、他在别处最近一次来往，再放得下才带上次聊到的）
  const gapChars = involuntary.itemChars + 40;
  const outlineLine = Math.max(20, int(RC.outline?.lineChars, 80));
  // 每层一条渲染好的最长（正文上限 + 代码拼的短句；pack 按它兜底，超了截短并计数）。宿主自动时不再另截每条
  const itemMax = {
    recalled: itemChars + META_CHARS,
    recentFromPresent: itemChars + META_CHARS,
    todaySoFar: itemChars + META_CHARS,
    warmStart: Math.max(itemChars, Math.min(layers.warmStart, itemChars * 2)) + META_CHARS,
    recollect: Math.max(recollect.tool.itemChars, recollect.auto.itemChars) + META_CHARS + 24,   // 前面的记号、后面的「另外 N 处也提到」
    outline: outlineLine + META_CHARS + 24,
    // 工作记忆一行：〔场合〕谁：正文 + 来源标签（叮嘱的原话 40 字、讲到了谁、私下……）
    working: working.lineChars + 2 * META_CHARS,
    sinceHere: sinceItem + META_CHARS + 8,   // 「结果：」
    pointBack: pointBack.chars,
    people: layers.peopleCardChars,
    gap: gapChars,
    lessons: lessons.itemChars + 48,         // 「（验证过）」「用 X 时：」和〔来源〕
    awarePrivate: 120,
    intentions: itemChars + META_CHARS + 16, // 「本来打算……，已经过了时间」
    look: 1200 + META_CHARS + 24,          // 翻看展开的那一条（context/look.js 的 MAIN_CHARS 是正文）+ 记号
  };
  // 核心一次最多给多少字（宿主自动时块上限的底数）：整块（不含有自己预算的几层）+ 工作记忆 + 这之后他的事 + 回忆这一档
  const ceiling = {
    inject: blockMaxChars + working.budgetChars + sinceChars + recollect.auto.totalChars,
    tool: blockMaxChars + working.budgetChars + sinceChars + recollect.tool.totalChars,
    look: recollect.tool.totalChars,
  };
  const out = deepFreeze({
    room, involuntary, deliberate, present: { maxItems: n(R.present?.maxItems, 15) }, working, blockMaxChars, layers,
    sinceHere: { maxItems: sinceMax, itemChars: sinceItem, chars: sinceChars }, recollect, pointBack, lessons, gapChars, itemMax, ceiling,
  });
  if (cfg && typeof cfg === 'object') cache.set(cfg, out);
  return out;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// 在词或句子的边界上截（D165）：句末标点、逗号顿号、空白之后断开；中文没有空白，找不到合适的边界（往回看不超过三成）就硬截。
// 截下来的那一段里有没配对的「（『“(【《，在省略号后面补上对应的收尾，不让一对标点只剩半边（「某人：「说得用几天感受一…」」）。
const BREAK_AFTER = /[。！？!?；;，,、：:\s）)」』”》\]]/u;
const PAIRS = new Map([['（', '）'], ['(', ')'], ['「', '」'], ['『', '』'], ['“', '”'], ['《', '》'], ['[', ']']]);
const CLOSERS = new Map([...PAIRS].map(([a, b]) => [b, a]));

/**
 * 截到 max 个字（按码点）；超了在边界上截、加「…」、补齐没配对的括号引号。整条一定 ≤ max。
 * @param {string} s
 * @param {number} max
 * @returns {{text: string, clipped: boolean}}
 */
export function clipBody(s, max) {
  const a = Array.from(String(s ?? ''));
  const m = Math.floor(Number(max));
  if (!(m > 0)) return { text: '', clipped: a.length > 0 };
  if (a.length <= m) return { text: a.join(''), clipped: false };
  if (m <= 2) return { text: m === 1 ? '…' : `${a[0]}…`, clipped: true };
  const closersFor = (k) => {
    const st = [];
    for (let i = 0; i < k; i++) {
      if (PAIRS.has(a[i])) st.push(a[i]);
      else if (CLOSERS.has(a[i]) && st.length && st[st.length - 1] === CLOSERS.get(a[i])) st.pop();
    }
    return st.reverse().map((o) => PAIRS.get(o)).join('');
  };
  // 留给正文的长度 k：k + 1（省略号）+ 补上的收尾 ≤ m
  let k = m - 1;
  for (let guard = 0; guard < 8; guard++) {
    const need = Array.from(closersFor(k)).length;
    if (k + 1 + need <= m) break;
    k = Math.max(1, m - 1 - need);
  }
  // 往回找边界（不超过三成）：边界字符留在前一段里
  const floor = Math.max(1, Math.floor(k * 0.7));
  let cut = k;
  for (let i = k; i >= floor; i--) {
    if (BREAK_AFTER.test(a[i - 1])) { cut = i; break; }
  }
  let head = a.slice(0, cut).join('').replace(/[\s，,、：:；;]+$/u, '');
  if (!head) head = a.slice(0, k).join('');
  const tail = closersFor(Array.from(head).length);
  const text = `${head}…${tail}`;
  // 兜底：补齐以后仍超（只会是极端的嵌套）就硬截
  return Array.from(text).length <= m ? { text, clipped: true } : { text: `${a.slice(0, m - 1).join('')}…`, clipped: true };
}
