// 按预算打包（§10.4）：去掉本周期已发过的 → 各层的条数和字数上限 → 单块 ≤ blockMaxChars、≤ 调用方的 budgetChars、
// 每会话每天 ≤ 档位的 injectPerSessionPerDay、最近 context.rolling.steps 步 ≤ 上下文增量 × 档位的 injectShare（D133，
// 额度由 ledger.budgetState 算）；超了以后只保留「你想着的」、工作记忆和被直接问到时的有意回想。
// 条目按组分配：人物卡（卡头 + 印象）、意图（意图 + 它指向的事实）、新版本 +「之前那一版」、计划 + 它的结果是一组，
// 组长放不下整组都不放，组员放不下只丢组员；绑在组长上的组员（bound：它的内容已经写进组长那条里了）放不下整组都不放。
import { charLen } from './text.js';

// 组长发过了整组就不再发的层：卡头 / 意图本身是这一组的意思所在。别的层（想起来的……）组长发过了，没发过的组员照样可以发
// （例：计划本周期已经提过，后来它的结果才想起来）
const LEAD_DECIDES = new Set(['people', 'intentions']);

/**
 * 不受每天额度和滚动窗口限制、也不记进「已注入」的层（D100、D133）：「你想着的」和工作记忆。pack 的 exempt 和
 * ledger.budgetState 的记账都用这一份：它们放进去的字数要是也算「已注入」，会挤掉别的层的额度。
 */
export const UNMETERED_LAYERS = Object.freeze(['intentions', 'working']);

/** 输出（展示）顺序：先交代背景，再是想起来的，最后是她想着要做的。 */
// 工作记忆（眼前这个人刚在别处跟她说的、她回他的）紧跟在时间间隔后面：这是这一轮最要紧的上下文
// 她的经验（D124）放在「你想着的」前面：做事的时候用得上
export const DISPLAY_ORDER = ['gap', 'working', 'warmStart', 'people', 'recentFromPresent', 'todaySoFar', 'recalled', 'awarePrivate', 'lessons', 'intentions'];
// 预算紧时谁先拿到：你想着的 > 工作记忆 > 时间间隔 > 她的经验（D124）> （被直接问到时）想起来的和在场者近况 > 人物卡 > 想起来的和在场者近况 > 心里有数
// > 今天到目前为止 > 暖启动。工作记忆有自己的预算（recall.working.budgetChars），不受每天额度和滚动窗口限制（D100）。
// 「想起来的」和「在场者近况」是同一次回想按同一个激活排出来的（retrieve 给两组各自的名额，再按 A 合并），放在同一档里
// 按回想的先后（order）一起分：谁更活跃谁先拿到，各自的条数和字数上限照旧。原来在场者近况排在最后，人物卡 + 五条想起来的
// 就把 900 字用完，主人两分钟前在别处说的话永远轮不到（实测问题 #5）。
const RECALL_TIER = Object.freeze(['recalled', 'recentFromPresent']);
// 她的经验（D124）：按范围对上才有、最多两三行，排在时间间隔后面（做事时用得上，又不多占）
const PRIORITY_DELIBERATE = ['intentions', 'working', 'gap', 'lessons', RECALL_TIER, 'people', 'awarePrivate', 'todaySoFar', 'warmStart'];
const PRIORITY_INVOLUNTARY = ['intentions', 'working', 'gap', 'lessons', 'people', RECALL_TIER, 'awarePrivate', 'todaySoFar', 'warmStart'];

/**
 * @typedef {object} Entry   渲染好、还没去重和打包的一条
 * @property {string} ref
 * @property {import('../contract/types.js').Layer} layer
 * @property {'share'|'share_vague'|'aware_private'|'pending'} verdict
 * @property {string} rendered
 * @property {string} provenance
 * @property {number} confidence
 * @property {string} appraisalRef
 * @property {string} group          同组的条目一起分配；组里 order 最小的是组长
 * @property {number} order          层内顺序（小的在前）
 * @property {boolean} [bound]       绑在组长上：组长没放进去它也不放，它放不下组长也不放（内容已经写进组长那条里了）
 * @property {string[]} [duplicates] retrieve 的 MMR 合并进这一条的几乎一样的文字（Candidate.duplicates）：其中哪条本周期发过，这条也算发过
 * @property {number} [prio]         组里放不下时谁先留（小的先留；组长和绑在组长上的不看它）。没有就按 order。
 *                                   工作记忆按 A 的名次给：整块超了时先丢不活跃的，不是先丢最新的（组员按时间排，最新的在最后）
 * @property {'thread'|'talk'|'open'} [unit]  工作记忆的条目：所在的段是哪一种（D110，只给注入日志和管理页用）
 * @property {string} [unitKey]      工作记忆的条目：所在的段（'thread:<根的 id>' 这样的，不含场合键）
 * @property {number} [alloc]        同一层里各组分预算的先后（小的先分；没有就按 order）。工作记忆最新的一组先分（D108；展示顺序不变）
 */

function capsOf(cfg, mode) {
  const L = cfg.context.layers;
  const rc = mode === 'deliberate' ? cfg.recall.deliberate : cfg.recall.involuntary;
  const recalledChars = mode === 'deliberate' ? rc.maxItems * rc.itemChars : cfg.recall.involuntary.maxChars;
  // groups：每层几组；chars：每层多少字；groupChars：每组多少字（人物卡 ≤ 180 字一张）；pending：「还在想」的提示另算几行
  return {
    gap: { groups: L.gapLines, chars: Infinity },
    warmStart: { groups: Infinity, chars: L.warmStart },
    people: { groups: L.peopleCards, chars: L.peopleCards * L.peopleCardChars, groupChars: L.peopleCardChars },
    recentFromPresent: { groups: cfg.recall.present.maxItems, chars: L.presentRecent },
    todaySoFar: { groups: Infinity, chars: L.todaySoFar },
    recalled: { groups: rc.maxItems, chars: recalledChars, pending: L.pendingLines },
    awarePrivate: { groups: L.awareLines, chars: Infinity },
    intentions: { groups: Math.min(L.intentions, cfg.intention.maxPerBlock), chars: Infinity },
    // 她的经验（D124）：lessons.recallMax 条、lessons.chars 字
    lessons: { groups: cfg.lessons?.recallMax ?? 2, chars: cfg.lessons?.chars ?? 220 },
    // 工作记忆：条数和字数在 context/working.js 里按 A 装好了（maxLines、budgetChars 按渲染好的字数，含场合说明和来源说明）；
    // 只受它自己的 budgetChars，不占整块的 blockMaxChars（D108：原来意图先占了 900 字里的一块，最新的几行工作记忆被挤掉）
    working: { groups: Infinity, chars: cfg.recall.working?.budgetChars ?? 800, ownBudget: true },
  };
}

/**
 * 这一周期已经给过她的条目（本周期已确认发过，或几乎一样的文字发过；时间间隔、待审提示不算）。
 * @param {Set<string>} sent
 * @returns {(e: Entry) => boolean}
 */
function sentTest(sent) {
  const sentRef = (ref, aware) => sent.has(ref) || (aware && sent.has(`${ref}~aware`));
  return (e) => {
    if (e.layer === 'gap' || e.verdict === 'pending') return false;
    const aware = e.verdict === 'aware_private';
    return [e.ref, ...(e.duplicates ?? [])].some((r) => sentRef(r, aware));
  };
}

/**
 * 过了关口①、和这次回想有关、但本周期已经给过她的条目数（D95）。有意回想什么都没给出来时，集成层据此告诉她
 * 「有关的前面已经给过了」，而不是「想不起来」（她上下文里明明有）。
 * @param {Entry[]} entries
 * @param {Set<string>} sent
 * @returns {number}
 */
export function countSent(entries, sent) {
  const isSent = sentTest(sent);
  return new Set(entries.filter(isSent).map((e) => e.ref)).size;
}

/**
 * opt.report（可选，D133）：传一个对象进来，pack 填上这一次预算的情况（返回值不变）——
 *   over：null = 没超；'day' = 今天的额度用完了；'rolling' = 滚动窗口的额度用完了（两样都超时记 'day'）；
 *   budgetDropped：没发过的受限条目里，因为预算没放进去的条数（超了时是整层丢掉的那些；没超时是额度剩得不够放的那些）。
 * @param {Entry[]} entries
 * @param {{cfg: object, mode: 'involuntary'|'deliberate', sent: Set<string>, budgetChars: number,
 *          budget: {dayUsed: number, dayLimit: number, rollingLeft: number}, report?: object}} opt
 * @returns {import('../contract/types.js').RecallItem[]}
 */
export function pack(entries, opt) {
  const { cfg, mode, sent } = opt;
  const blockCap = Math.max(0, Math.min(Number.isFinite(opt.budgetChars) ? opt.budgetChars : cfg.context.blockMaxChars, cfg.context.blockMaxChars));
  const b = opt.budget ?? { dayUsed: 0, dayLimit: Infinity, rollingLeft: Infinity };
  const dayLeft = b.dayLimit - b.dayUsed;
  const overDay = dayLeft <= 0;
  const over = overDay || b.rollingLeft <= 0;
  // 「你想着的」、工作记忆和被直接问到时的有意回想不受每天和滚动窗口的限制，只受单块上限；超了以后只留它们（§10.4）。
  // 有意回想的结果是整档（想起来的 + 在场者近况）：同一次回想按同一个 A 排出来的，不能因为分到了近况那层就在预算用完时丢掉
  const exempt = new Set(mode === 'deliberate' ? [...UNMETERED_LAYERS, ...RECALL_TIER] : UNMETERED_LAYERS);
  const allowed = over ? exempt : null;
  const budgetCap = over ? 0 : Math.max(0, Math.min(dayLeft, b.rollingLeft));   // 其余各层合计
  const report = opt.report && typeof opt.report === 'object' ? opt.report : null;
  let budgetDropped = 0;

  // 1. 去掉本周期已发过的（时间间隔不按条目去重：它的「只提示一次」由 gap_ack_at 管）。
  // 几乎一样的文字（MMR 合并进来的 duplicates）发过了也算这条发过：两段几乎一样的情节这一轮谁分高谁当代表，
  // 上一轮发的是另一段时不能把同样的话当新鲜事再给一遍
  const isSent = sentTest(sent);
  const groups = new Map();
  for (const e of entries) {
    if (allowed && !allowed.has(e.layer)) {
      if (report && !isSent(e)) budgetDropped += 1;
      continue;
    }
    if (!groups.has(e.group)) groups.set(e.group, []);
    groups.get(e.group).push(e);
  }
  const live = [];
  for (const g of groups.values()) {
    const [lead, ...rest] = [...g].sort((x, y) => x.order - y.order);
    if (isSent(lead)) {
      if (LEAD_DECIDES.has(lead.layer)) continue;   // 卡头 / 意图本身发过了：整组不再发
      // 组长发过了：绑在它上面的跟着它不发，其余没发过的组员自成一组（第一条当组长）
      const left = rest.filter((e) => !e.bound && !isSent(e));
      if (left.length) live.push({ layer: left[0].layer, order: left[0].order, alloc: left[0].alloc, members: left });
      continue;
    }
    live.push({ layer: lead.layer, order: lead.order, alloc: lead.alloc, members: [lead, ...rest.filter((e) => !isSent(e))] });
  }

  // 2. 按优先级分配
  const caps = capsOf(cfg, mode);
  const used = Object.fromEntries(DISPLAY_ORDER.map((l) => [l, { groups: 0, chars: 0, pending: 0 }]));
  let total = 0;      // 整块（≤ blockCap）
  let budgeted = 0;   // 受每天和滚动窗口限制的那部分（≤ budgetCap）
  const chosen = [];
  const prio = mode === 'deliberate' ? PRIORITY_DELIBERATE : PRIORITY_INVOLUNTARY;
  const seenRefs = new Set();
  for (const tier of prio) {
    const layers = Array.isArray(tier) ? tier : [tier];
    const allocOf = (g) => (Number.isFinite(g.alloc) ? g.alloc : g.order);
    const list = live.filter((g) => layers.includes(g.layer)).sort((x, y) => allocOf(x) - allocOf(y) || x.order - y.order);
    for (const g of list) {
      const layer = g.layer;
      const cap = caps[layer];
      const free = exempt.has(layer);
      const own = !!cap.ownBudget;
      const isPending = cap.pending != null && g.members[0].verdict === 'pending';
      if (isPending ? used[layer].pending >= cap.pending : used[layer].groups >= cap.groups) continue;
      const take = [];
      let chars = 0;
      // 组长、绑在组长上的先放；别的组员按 prio（没有就按原来的先后）
      const tries = [...g.members.entries()].sort(([i, x], [j, y]) => {
        const vx = i === 0 || !!x.bound;
        const vy = j === 0 || !!y.bound;
        if (vx !== vy) return vx ? -1 : 1;
        if (vx) return i - j;
        return (Number.isFinite(x.prio) ? x.prio : i) - (Number.isFinite(y.prio) ? y.prio : j) || i - j;
      });
      for (const [i, e] of tries) {
        // 组长、绑在组长上的放不下 → 整组不放；别的组员放不下只丢它自己
        const vital = i === 0 || !!e.bound;
        if (seenRefs.has(`${e.ref}|${e.verdict}`) && e.layer !== 'gap') { if (vital) { take.length = 0; break; } continue; }
        const n = charLen(e.rendered);
        const fits = !((!own && total + chars + n > blockCap) || used[layer].chars + chars + n > cap.chars || chars + n > (cap.groupChars ?? Infinity));
        const budgetOk = free || budgeted + chars + n <= budgetCap;
        if (!fits || !budgetOk) {
          // 只有单块、层的上限都放得下、卡在预算上的才算「因为预算没放进去」（组长卡住了整组都算）
          if (fits && !budgetOk) budgetDropped += vital ? g.members.length : 1;
          if (vital) { take.length = 0; break; }
          continue;
        }
        take.push(e);
        chars += n;
      }
      if (!take.length) continue;
      if (isPending) used[layer].pending += 1; else used[layer].groups += 1;
      used[layer].chars += chars;
      if (!own) total += chars;
      if (!free) budgeted += chars;
      for (const e of take) { chosen.push(e); seenRefs.add(`${e.ref}|${e.verdict}`); }
    }
  }

  if (report) {
    report.over = !over ? null : overDay ? 'day' : 'rolling';
    report.budgetDropped = budgetDropped;
  }

  // 3. 按展示顺序输出
  const pos = (l) => DISPLAY_ORDER.indexOf(l);
  return chosen
    .sort((x, y) => pos(x.layer) - pos(y.layer) || x.order - y.order)
    .map((e) => ({
      id: e.ref, layer: e.layer, rendered: e.rendered, verdict: e.verdict,
      confidence: Math.min(1, Math.max(0, Number.isFinite(e.confidence) ? e.confidence : 0)),
      provenance: e.provenance ?? '', appraisalRef: e.appraisalRef,
      ...(e.layer === 'working' && typeof e.group === 'string' ? { group: e.group } : {}),
      ...(e.layer === 'working' && typeof e.unit === 'string' ? { unit: e.unit } : {}),
      ...(e.layer === 'working' && typeof e.unitKey === 'string' ? { unitKey: e.unitKey } : {}),
    }));
}
