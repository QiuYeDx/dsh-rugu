// 工作记忆的候选（§8.10，D100 / D110）：眼前这个人（这一轮的触发者，和权利层确认的同一个人）在别的场合亲口跟她说的话、
// 她在别的场合回他的话（紧挨着的上一条不是她的感知就是他说的，按 id 判）、他要她做而还没了结的事（formed / armed 的意图）的来源行。
// 这一层不抽样：每一行算一个确定的活跃度
//   A = B（dynamics.baseActivations：编码强度 × 幂律衰减）+ triggerBoost + cueWeight × 话题相似度 +（还开着的意图的来源行）openBoost，
// 没有任何「最近 N 小时」的时间窗：淡忘靠 B 随时间渐弱，没了结的事靠 openBoost 一直留在心里（主人：「不应该做成固定的一到一个小时
// 就遗忘的机制」）。candidatePool 只是一次往回看多少行（按 id 倒序走索引）。
// 话题相似度只拿触发者这一句和他自己在这里最近的几行算（别人的话不参与：第三方带不偏她心里装什么）；那几行按激活加权
// min(1, exp(B − B_焦点))（D110：一小时前的提醒带不偏话题，这不是时间窗）。
// 段（units，D110）：在全部候选上按内容和结构切——开着的事（一件意图一段，成员是它的来源行）、约定的一串（thread：他定的玩法 / 约定是根，
// 照着它做的一步经第一眼的 follows 追到根；第一眼 glance-2 以前的旧行、还在看的，按「接着的几句宽松 asks」逐句退回切，一句不算约定的话就断开）、
// 其余的闲聊（talk）。每段带 core（根、她接下来的一两句、最后一步和她的回答；闲聊是最新的一两句）、段的激活 B_unit、两件代码比出来的事实：
// newerThanHere（这一段比他在这里跟你说过的都晚）、latestRoot（他最近一次跟你定的就是这一段的根：有自己后续的最新的根，后来的话题相似的
// 一句才拿得走）。不认任何词。每段另带 hereAt（他在这里这一句之前最后一句话的时间，D113：context 按显示出来的行算「比他在这里说过的都晚」）。
// 话题词里方括号的占位（［图片］［视频］［表情包:…］）不算（D113：媒体占位不是话题，原来两张图片「同一个话题」）；有看过的媒体的说明时
// 拿说明的文字来比（row.note：她看过的媒体的说明，D116 的 intake.seenMedia）。
// 这里从不看「这里能不能说」（§8.2）：能不能放进心里、说出口是哪一档，由 discretion.admitWorking 判；装哪几段由 context 按软预算定。同步、零 LLM。
// 她自己开口的一轮（D132）没有「眼前这个人」：context 按「这里的听众」取——recentPartners 给出她最近在别处来往过、又在这里的人，
// 每个人照样走 workingSet（focusPerceptId 为空：话题只拿他在这里最近的几句算）。
import { safe, selfId, metric } from './util.js';

const COLS = 'id, setting_key, at, actor_entity_id, actor_self, kind, text, w_enc, visible_to, addressed, mentions_json, media_json';
const TRIGGER_KINDS = ['utterance', 'action'];
const SELF_KINDS = ['self-utterance', 'self-action'];
// 编码强度为 0（没有痕迹）的那一行的 B：排在有痕迹的后面，但仍是可比较的数（和 routes.js 的 STRENGTH_FLOOR 同一个哨兵值，不是可调的参数）
const STRENGTH_FLOOR = -10;
// 沿 follows 往回追最多几跳（防环；不是可调的参数）
const MAX_HOPS = 8;

/**
 * @typedef {object} WorkingLine
 * @property {string} ref                 'p<id>'
 * @property {number} perceptId
 * @property {string} settingKey
 * @property {number} at
 * @property {'trigger'|'reply'} role     他亲口说的 / 她回他的
 * @property {number|null} actorEntityId
 * @property {string} text
 * @property {number} A
 * @property {{B: number, trigger: number, topic: number, open: number}} parts
 * @property {number} topicSim            0–1（他这一句 + 他在这里最近几句，按激活加权）
 * @property {number} focusSim            0–1（只拿他这一句：段的激活用）
 * @property {boolean} open               还开着的意图的来源行
 * @property {number[]} intentionIds
 * @property {string[]} context           同一段里紧挨在它前面的一来一回（最多 contextLines 条）
 * @property {boolean} primary            A ≥ tau 而且在按 A 的预选里（单行补满、接续计数用）
 * @property {boolean} anchor             是某一段的 core
 * @property {string} exchange            同一段一来一回的粗分标识（场合 + 开头那一行的 id）
 * @property {string|null} unitKey        所在的段（WorkingUnit.key）
 */

/**
 * @typedef {object} WorkingUnit
 * @property {string} key                 'thread:<根的 id>' / 'talk:<第一行的 id>' / 'open:i<意图 id>'（不含场合键）
 * @property {string} settingKey
 * @property {'thread'|'talk'|'open'} kind
 * @property {string[]} members           按 id 排好的引用
 * @property {string|null} root           thread 的根（他定的那一句）；talk 是开头那句他的话
 * @property {string[]} core              这一段最少要有的几行（装预算时整段的意思靠它）
 * @property {number} B                   段的激活：成员 B 的最大值 + cueWeight × 他这一句和成员的话题相似度的最大值（openBoost 不算）
 * @property {number} newestAt
 * @property {boolean} newerThanHere      这一段最新的一行比他在这里（这一句之前）的最后一句还晚
 * @property {number|null} hereAt         他在这里（这一句之前）最后一句话的时间（D113；从没在这里说过是 null）
 * @property {boolean} latestRoot         他最近一次跟你定的就是这一段的根（所有段的根和他在这里最新的约定一起比；最新的在这里时谁都不带）
 * @property {string|null} replacedRef    根改掉了的那一句（第一眼的 replaces）
 * @property {boolean} replacedHere       被改掉的那一句就在这里
 * @property {boolean} fallback           根不是第一眼 glance-2 看完了的，按退回的切法切的
 * @property {boolean} [strong]           thread：有自己的后续（根之后他照着做了一步，或者改掉了前面一句）
 * @property {boolean} replaced           thread：根被他后来的一句改掉了（第一眼的 replaces；context 不单独装这一段，根作为「后来改了」进新的那一段）
 * @property {string[]} [sources]         open：这件意图的来源行（准入时有一行被挡，这一件就不出现）；members 另含她回这几句的话（不逐行出现）
 * @property {number[]} [intentionIds]    open：这一件意图
 * @property {number|null} [due]          open：到点的时刻（window_start）
 * @property {number} [overdue]           open：过了点多少（encode.intentionOverdue）
 */

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null}} q
 * @param {{triggerEntityId: number|null, at?: number}} opt
 * @returns {{triggerEntityId: number|null, people: number[], lines: WorkingLine[], units: WorkingUnit[], candidates: number, aboveTau: number,
 *   lastHereAt: number|null}}  lastHereAt：他在这里（这一句之前）最后一句话的时间（D113）
 */
export function workingSet(core, q, opt = {}) {
  const cfg = core.config.get();
  const W = cfg.recall.working;
  const at = Number.isFinite(opt.at) ? opt.at : core.now();
  const trig = Number.isSafeInteger(opt.triggerEntityId) ? opt.triggerEntityId : null;
  const out = { triggerEntityId: trig, people: [], lines: [], units: [], candidates: 0, aboveTau: 0, lastHereAt: null };
  if (!W?.enabled || trig == null || typeof q?.settingKey !== 'string' || !q.settingKey) return out;
  const me = selfId(core);
  if (trig === me) return out;
  const people = equivalents(core, trig);
  out.people = people;
  const ph = people.map(() => '?').join(',');
  const pool = Math.max(1, Math.floor(W.candidatePool));
  const here = q.settingKey;

  // 1. 他亲口说的话（别的场合）：按时间倒序走 percepts_actor 索引，只看条数，没有时间下限
  const own = safe(core, 'workingOwn', () => core.store.all(
    `SELECT ${COLS} FROM percepts WHERE actor_entity_id IN (${ph}) AND setting_key <> ? AND kind IN (${TRIGGER_KINDS.map(() => '?').join(',')})
        AND standing <> 'material' AND visible_to <> 'her-only' AND text IS NOT NULL AND text_state NOT IN ('retracted','expired')
      ORDER BY at DESC, id DESC LIMIT ?`, ...people, here, ...TRIGGER_KINDS, pool), []) ?? [];
  const rows = new Map(own.map((r) => [r.id, r]));

  // 2. 他要她做、还没了结的事：formed / armed 的意图，对象是他，或者来源行是他说的。不受 candidatePool 和 tau 限制
  const openOf = new Map();   // 感知 id → 意图 id[]
  const intents = safe(core, 'workingIntents', () => core.store.all(
    "SELECT id, target_entity_id, sources_json, window_start, window_end FROM intentions WHERE state IN ('formed','armed') ORDER BY formed_at DESC, id DESC"), []) ?? [];
  const overdueOf = new Map(intents.map((it) => [it.id, safe(core, 'workingOverdue', () => core.mods.encode.intentionOverdue(core, it, at), 0) ?? 0]));
  const srcIds = new Set();
  for (const it of intents) for (const pid of parseIds(it.sources_json)) srcIds.add(pid);
  const srcRows = srcIds.size ? (safe(core, 'workingIntentSrc', () => core.store.all(
    `SELECT ${COLS}, standing, text_state FROM percepts WHERE id IN (${[...srcIds].map(() => '?').join(',')})`, ...srcIds), []) ?? []) : [];
  const srcById = new Map(srcRows.map((r) => [r.id, r]));
  const openIntents = [];
  for (const it of intents) {
    const srcs = parseIds(it.sources_json).map((id) => srcById.get(id)).filter(Boolean);
    const forHim = people.includes(it.target_entity_id) || srcs.some((r) => people.includes(r.actor_entity_id));
    if (!forHim) continue;
    const mine = [];
    for (const r of srcs) {
      if (r.setting_key === here || !people.includes(r.actor_entity_id) || !TRIGGER_KINDS.includes(r.kind)) continue;
      if (r.text == null || r.standing === 'material' || r.visible_to === 'her-only' || ['retracted', 'expired'].includes(r.text_state)) continue;
      if (!rows.has(r.id)) rows.set(r.id, r);
      if (!openOf.has(r.id)) openOf.set(r.id, []);
      openOf.get(r.id).push(it.id);
      mine.push(r.id);
    }
    // 来源行在这里的不算（这个会话自己的历史里已经有了）；她自己的那几句来源（「八点提醒：……」）只在它们也是她回他的话时跟着进来
    if (mine.length) openIntents.push({ it, srcIds: parseIds(it.sources_json) });
  }
  if (!rows.size) return out;

  // 3. 她在那些场合回他的话：对他的每一行，按 id 往后看同一场合紧跟着的几条（setting_key, id 索引，recall.working.replyScan 条），
  //    她说的、紧挨着的上一条不是她的感知是他说的，就是回他的；碰到别人说的话就停。
  const scan = Math.max(1, Math.floor(W.replyScan ?? 8));
  const lines = new Map();     // 感知 id → line
  for (const r of rows.values()) lines.set(r.id, mk(core, r, 'trigger'));
  for (const r of rows.values()) {
    const after = safe(core, 'workingReplies', () => core.store.all(
      `SELECT ${COLS}, standing, text_state FROM percepts WHERE setting_key = ? AND id > ? ORDER BY id LIMIT ?`, r.setting_key, r.id, scan), []) ?? [];
    for (const x of after) {
      if (x.actor_self) {
        if (!SELF_KINDS.includes(x.kind) || x.text == null || ['retracted', 'expired'].includes(x.text_state)) continue;
        if (!lines.has(x.id)) lines.set(x.id, mk(core, x, 'reply'));
        continue;
      }
      if (x.visible_to === 'her-only' && x.kind === 'content') continue;   // 她私下读到的材料不算「上一条」
      if (!['utterance', 'action', 'content'].includes(x.kind)) continue;
      if (!people.includes(x.actor_entity_id)) break;   // 别人接了话：再往后她说的不是回他的
    }
  }
  const seq = new Map();       // 场合 → 按 id 排好的这一层的行（trigger / reply）
  for (const l of lines.values()) {
    if (!seq.has(l.settingKey)) seq.set(l.settingKey, []);
    seq.get(l.settingKey).push(l);
  }
  for (const list of seq.values()) list.sort((x, y) => x.perceptId - y.perceptId);
  out.candidates = lines.size;

  // 4. 话题相似度：触发者这一句 + 他在这里最近的几行（按激活加权；别人的话不参与）；另算只拿他这一句的（段的激活用）
  const herNames = ownNames(core);
  const topic = topicTerms(core, here, people, q.focusPerceptId, herNames, W, at);
  const focusOnly = focusTerms(core, here, people, q.focusPerceptId, herNames);
  for (const l of lines.values()) {
    l.topicSim = topic.size ? similarity(core, topic, l.row, herNames) : 0;
    l.focusSim = focusOnly.size ? similarity(core, focusOnly, l.row, herNames) : 0;
  }

  // 5. 活跃度：基础激活 B + 各项（确定的，不抽样）。openBoost 只给意图的来源行（D110：她回他的那一句不再沾光——一小时前的提醒
  //    连带她的七八句回话占满了名额）；过了时间窗的按 encode.intentionOverdue 平滑减掉，不在某个钟点一刀切
  const B = strengths(core, [...lines.values()], at);
  for (const l of lines.values()) {
    const b = B.get(l.ref) ?? STRENGTH_FLOOR;
    l.intentionIds = openOf.get(l.perceptId) ?? [];
    l.open = l.intentionIds.length > 0;
    const over = l.open ? Math.min(...l.intentionIds.map((i) => overdueOf.get(i) ?? 0)) : 0;
    l.parts = { B: b, trigger: W.triggerBoost, topic: W.cueWeight * l.topicSim, open: l.open ? Math.max(0, W.openBoost - over) : 0 };
    l.A = l.parts.B + l.parts.trigger + l.parts.topic + l.parts.open;
  }

  // 5b. 一来一回粗分（D108，按条数不按时间）：同一场合这一层相邻的两行之间，别人插的话不超过 exchangeGapLines 条，就是同一段
  const gapLines = Math.max(0, Math.floor(W.exchangeGapLines ?? 20));
  const exch = new Map();      // 感知 id → {key, members}
  const exchanges = [];
  for (const [sk, list] of seq) {
    let cur = null;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const prev = list[i - 1];
      const same = prev && othersBetween(core, sk, prev.perceptId, l.perceptId, people, gapLines) <= gapLines;
      if (!same) { cur = { key: `${sk}#${l.perceptId}`, settingKey: sk, members: [] }; exchanges.push(cur); }
      cur.members.push(l);
      exch.set(l.perceptId, cur);
    }
  }
  for (const l of lines.values()) l.exchange = exch.get(l.perceptId)?.key ?? `${l.settingKey}#${l.perceptId}`;
  const rg = safe(core, 'workingGlance', () => core.mods.discretion.glancesOf(core, [...lines.keys()]), null);
  const gl = (id) => (rg instanceof Map ? rg.get(id) ?? null : null);

  // 6. 预选：A ≥ tau 的按 A 从高到低，最多 maxLines 的两倍，每行带上同一段里前面最多 contextLines 条（单行补满、接续计数用）
  const above = [...lines.values()].filter((l) => l.A >= W.tau).sort((x, y) => y.A - x.A || y.perceptId - x.perceptId);
  out.aboveTau = above.length;
  const want = Math.max(1, Math.floor(W.maxLines)) * 2;
  const pick = new Map();
  let nPrimary = 0;
  for (const l of above) {
    if (nPrimary >= want) break;
    l.primary = true;
    nPrimary += 1;
    const list = seq.get(l.settingKey) ?? [];
    const i = list.indexOf(l);
    l.context = [];
    for (let k = i - 1; k >= 0 && l.context.length < Math.max(0, W.contextLines); k--) {
      const prev = list[k];
      l.context.unshift(prev.ref);
      if (!pick.has(prev.perceptId)) { prev.context = prev.context ?? []; pick.set(prev.perceptId, prev); }
    }
    pick.set(l.perceptId, l);
  }

  // 7. 段（D110）
  // 任何状态的意图（含 lapsed、executed）的来源行：第一眼上线以前的旧约定（没排过第一眼）靠它认出是约定
  // （只看这一层最早一行以后形成的意图：来源总在形成之前；评审：不再每轮扫全部意图）
  const everSrc = new Set();
  const since = Math.min(...[...lines.values()].map((l) => l.at));
  for (const r of safe(core, 'workingEverSrc', () => core.store.all(
    'SELECT DISTINCT CAST(j.value AS INTEGER) AS id FROM intentions i, json_each(i.sources_json) j WHERE i.formed_at >= ?', since), []) ?? []) {
    if (lines.has(r.id)) everSrc.add(r.id);
  }
  const units = buildUnits(core, { lines, exchanges, openIntents, overdueOf, gl, W, here, people, focusId: q.focusPerceptId, at, everSrc, own: herNames, meta: out });
  const kept = units.filter((u) => u.kind === 'open' || u.members.some((r) => (lines.get(Number(r.slice(1)))?.A ?? -Infinity) >= W.tau));
  for (const u of kept) {
    for (const r of u.members) {
      const l = lines.get(Number(r.slice(1)));
      if (!l) continue;
      if (!l.unitKey) l.unitKey = u.key;
      if (!pick.has(l.perceptId)) { l.context = l.context ?? []; pick.set(l.perceptId, l); }
    }
    for (const r of u.core) { const l = lines.get(Number(r.slice(1))); if (l) { l.anchor = true; if (!pick.has(l.perceptId)) { l.context = l.context ?? []; pick.set(l.perceptId, l); } } }
  }
  out.units = kept;
  out.lines = [...pick.values()].map(({ row, ...l }) => ({ ...l, context: l.context ?? [], primary: !!l.primary, anchor: !!l.anchor, unitKey: l.unitKey ?? null }));
  if (kept.some((u) => u.fallback)) metric(core, 'retrieve.working.unitFallback');
  metric(core, 'retrieve.working.sets');
  return out;
}

/**
 * 她最近在别的场合来往过的人里，哪几个在这里（D132，retrieve.recentPartners 的实现）：别处对她说话的人、她在别处接着回的那个人
 * （她那一句前面最近一条别人亲口说的话，同一场合），按最近一次来往从新到旧；among 是这里的听众（权利层确认的同一个人也算在这里）。
 * 没有时间窗：一次只往回看 recall.working.candidatePool 条；隔得久了的由 workingSet 的 A / tau 自然淡掉（返回了也装不进东西）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string}} q
 * @param {{among: number[], max?: number}} opt
 * @returns {number[]}  听众里的实体 id（among 里的那个），最近来往的在前，最多 max 个
 */
export function recentPartners(core, q, opt = {}) {
  const W = core.config.get().recall.working;
  const here = q?.settingKey;
  const among = new Set((opt.among ?? []).filter((x) => Number.isSafeInteger(x)));
  const max = Math.max(1, Math.floor(opt.max ?? W?.maxTriggers ?? 3));
  if (!W?.enabled || typeof here !== 'string' || !here || !among.size) return [];
  const me = selfId(core);
  const pool = Math.max(1, Math.floor(W.candidatePool));
  const kinds = TRIGGER_KINDS.map(() => '?').join(',');
  // 别处对她说的话
  const toHer = safe(core, 'partnersToHer', () => core.store.all(
    `SELECT id, actor_entity_id AS e FROM percepts WHERE setting_key <> ? AND actor_self = 0 AND actor_entity_id IS NOT NULL AND kind IN (${kinds})
        AND addressed IN ('to-her','mentions-her') AND standing <> 'material' ORDER BY id DESC LIMIT ?`, here, ...TRIGGER_KINDS, pool), []) ?? [];
  // 她在别处说的话各自接的是谁（前面最近一条别人亲口说的，同一场合）
  const replied = safe(core, 'partnersReplied', () => core.store.all(
    `SELECT s.id AS id, (SELECT o.actor_entity_id FROM percepts o WHERE o.setting_key = s.setting_key AND o.id < s.id AND o.actor_self = 0
                           AND o.kind IN (${kinds}) ORDER BY o.id DESC LIMIT 1) AS e
       FROM percepts s WHERE s.setting_key <> ? AND s.actor_self = 1 AND s.kind IN (${SELF_KINDS.map(() => '?').join(',')}) ORDER BY s.id DESC LIMIT ?`,
    ...TRIGGER_KINDS, here, ...SELF_KINDS, pool), []) ?? [];
  const rows = [...toHer, ...replied].filter((r) => Number.isSafeInteger(r.e) && r.e !== me).sort((x, y) => y.id - x.id);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (out.length >= max) break;
    if (seen.has(r.e)) continue;
    seen.add(r.e);
    // 在这里的是他本人，或者权利层确认的同一个人（另一个平台上的他）
    const hereId = among.has(r.e) ? r.e : equivalents(core, r.e).find((x) => among.has(x)) ?? null;
    if (hereId == null || out.includes(hereId)) continue;
    out.push(hereId);
  }
  return out;
}

/**
 * 切段（D110，按内容和结构，不按时间、不认任何词）。见文件头。返回全部段（还没按 tau 筛）。
 */
function buildUnits(core, { lines, exchanges, openIntents, overdueOf, gl, W, here, people, focusId, everSrc, own, meta }) {
  const acceptN = Math.max(0, Math.floor(W.thread?.acceptLines ?? 2));
  const units = [];
  const byId = (id) => lines.get(id) ?? null;
  const ref = (l) => l.ref;
  const done = (g) => g?.state === 'done';
  const v2 = (g) => done(g) && (g.version ?? 0) >= 2;

  // 1. 开着的事：一件意图一段，成员是它的来源行（这一层里有的），从别的段里拿出来
  const claimed = new Set();
  const openOfLine = new Map();   // 来源行的感知 id → 开着的事那一段（她回这一句的话也归它，不逐行出现）
  for (const { it, srcIds } of openIntents) {
    const ms = srcIds.map(byId).filter(Boolean).sort((x, y) => x.perceptId - y.perceptId);
    if (!ms.length) continue;
    for (const l of ms) claimed.add(l.perceptId);
    const rep = representative(ms);
    const u = {
      key: `open:i${it.id}`, settingKey: rep.settingKey, kind: 'open', members: ms.map(ref), sources: ms.map(ref), root: rep.ref, core: [rep.ref],
      intentionIds: [it.id], due: Number.isFinite(it.window_start) ? it.window_start : null, overdue: overdueOf.get(it.id) ?? 0,
      replacedRef: null, replacedHere: false, fallback: false,
    };
    units.push(u);
    for (const l of ms) if (!openOfLine.has(l.perceptId)) openOfLine.set(l.perceptId, u);
  }

  // 2. 约定的一串和闲聊：在每一段粗分里切
  const unitOf = new Map();    // 感知 id → unit（thread / talk）
  const threads = new Map();   // 根的感知 id → unit
  const newThread = (root, fallback) => {
    if (threads.has(root.perceptId)) return threads.get(root.perceptId);
    const u = { key: `thread:${root.perceptId}`, settingKey: root.settingKey, kind: 'thread', members: [], root: root.ref, core: [], replacedRef: null,
      replacedHere: false, fallback, _lines: [] };
    threads.set(root.perceptId, u);
    units.push(u);
    return u;
  };
  const newTalk = (first) => {
    const u = { key: `talk:${first.perceptId}`, settingKey: first.settingKey, kind: 'talk', members: [], root: null, core: [], replacedRef: null,
      replacedHere: false, fallback: false, _lines: [] };
    units.push(u);
    return u;
  };
  const put = (u, l) => { if (!unitOf.has(l.perceptId)) { unitOf.set(l.perceptId, u); u._lines.push(l); } };
  for (const ex of exchanges) {
    const ms = ex.members.filter((l) => !claimed.has(l.perceptId));
    if (!ms.length) continue;
    // a. 照着做的一步（第一眼 glance-2 的 follows）：沿 follows 追到根（同一场合、最多 MAX_HOPS 跳），根和这一步都进那一串
    for (const l of ms) {
      if (l.role !== 'trigger') continue;
      const g = gl(l.perceptId);
      if (!done(g) || g.follows == null) continue;
      let cur = l;
      for (let h = 0; h < MAX_HOPS; h++) {
        const nx = byId(gl(cur.perceptId)?.follows ?? -1);
        if (!nx || nx.role !== 'trigger' || nx.settingKey !== l.settingKey || claimed.has(nx.perceptId) || nx.perceptId >= cur.perceptId) break;
        cur = nx;
        if (gl(cur.perceptId)?.follows == null) break;
      }
      if (cur === l || gl(cur.perceptId)?.follows != null) continue;
      const u = newThread(cur, false);
      put(u, cur);
      put(u, l);
    }
    // b. 他剩下的话按时间往后走，每一句按它自己的第一眼定（评审：不再看整段是不是都 glance-2 看完了——一句没排过第一眼的闲聊不该把
    //    一整天推进退回的切法）。cur 是正在接着的那一串（只在这一段粗分里接）；一句不算约定的话把它断开，后面的归闲聊
    //    （评审：早上的「乘3」把后面七个小时他说的不相干的话都收成了自己的「后续」，还被标成比这里说过的都晚）。
    //    - 第一眼 glance-2 看完了的：asks（宽松：不看 mixed）而且 follows 为空的是根；其余（不是照着做的一步）是闲聊。
    //    - 退回的切法（glance-1 的旧行、还在看、看失败、没排过第一眼）：宽松 asks 的、没排过第一眼而是某件意图（任何状态）的来源的、
    //      还在看的（pending / failed）算约定的一串；接在 cur 后面，除非它改掉了前面一句（replaces），或者是对她说的、自己带着话的一句
    //      （去掉叫她的那一处以后超过 thread.stepChars 个字：「@她 99」是照着做的一步，「@她 换一个 我说一个数字你回复乘3的值」是新的开头）。
    //      没有 cur 时：旧行和旧约定是根；还在看的、对她说的话是根（D108 的开头那句兜底），没对她说的归闲聊。
    //      看完了而不是约定的话、没排过第一眼的别的话是闲聊。没排过第一眼的旧话不当开头（安静的群里一天前的一句「@她」不是约定）
    const stepChars = Math.max(0, Math.floor(W.thread?.stepChars ?? 4));
    let cur = null;
    let talk = null;
    for (const l of ms) {
      if (l.role !== 'trigger') continue;
      if (unitOf.has(l.perceptId)) { const u0 = unitOf.get(l.perceptId); if (u0.kind === 'thread') { cur = u0; talk = null; } continue; }
      const g = gl(l.perceptId);
      const d = done(g);
      const asTalk = () => { if (!talk) talk = newTalk(l); put(talk, l); cur = null; };
      const asRoot = (fallback) => { cur = newThread(l, fallback); put(cur, l); talk = null; };
      if (v2(g)) {
        if (g.asks && g.follows == null) asRoot(false);
        else asTalk();
        continue;
      }
      const unknown = !!g && !d;
      const chain = (d && g.asks) || (!g && everSrc.has(l.perceptId)) || unknown;
      if (!chain) { asTalk(); continue; }
      const addressed = !!l.row?.addressed && l.row.addressed !== 'ambient';
      const fresh = !cur || (d && g.replaces != null) || (addressed && ownChars(core, l.row) > stepChars);
      if (!fresh) { put(cur, l); talk = null; continue; }
      if (unknown && !addressed) { asTalk(); continue; }
      asRoot(true);
    }
    // c. 她的话跟着她前面最近的一句他的话走（A5 口径；他那一句是开着的事的来源时，她的回话也归那件事，不逐行出现）；
    //    前面没有他的话的，自成一段闲聊
    let lastHis = null;
    let lead = null;
    for (const l of ex.members) {
      if (l.role === 'trigger') { lastHis = l; continue; }
      if (unitOf.has(l.perceptId) || claimed.has(l.perceptId)) continue;
      const ou = lastHis ? openOfLine.get(lastHis.perceptId) : null;
      if (ou) { ou.members.push(l.ref); unitOf.set(l.perceptId, ou); continue; }
      const u = lastHis ? unitOf.get(lastHis.perceptId) : null;
      if (u) { put(u, l); continue; }
      if (!lead) lead = newTalk(l);
      put(lead, l);
    }
  }

  // 3. 每段的 core、激活、两件事实
  const lastHereAt = lastHere(core, here, people, focusId);
  if (meta) meta.lastHereAt = lastHereAt;
  const replaced = new Set();
  for (const l of lines.values()) { const g = gl(l.perceptId); if (done(g) && g.replaces != null) replaced.add(g.replaces); }
  for (const u of units) {
    const ls = u._lines ?? [...new Set(u.members)].map((r) => byId(Number(r.slice(1)))).filter(Boolean);
    ls.sort((x, y) => x.perceptId - y.perceptId);
    delete u._lines;
    u.members = ls.map(ref);
    u.newestAt = Math.max(...ls.map((l) => l.at));
    u.B = Math.max(...ls.map((l) => l.parts.B)) + W.cueWeight * Math.max(0, ...ls.map((l) => l.focusSim ?? 0));
    u.newerThanHere = lastHereAt != null && u.newestAt > lastHereAt;
    u.hereAt = lastHereAt;
    u.latestRoot = false;
    if (u.kind === 'open') continue;
    if (u.kind === 'talk') {
      // 闲聊的 core 是最新的一两句（他最后一句和最新那一行）：开头那句可能是几个小时前的一张图（评审：「［图片］ …（中间又来回了 72 句）」占名额）
      const first = ls.find((l) => l.role === 'trigger') ?? ls[0];
      const lastHis = [...ls].reverse().find((l) => l.role === 'trigger') ?? ls.at(-1);
      u.root = first.role === 'trigger' ? first.ref : null;
      u.core = [...new Set([lastHis.ref, ls.at(-1).ref])];
      continue;
    }
    // thread：根；根之后她的前 acceptLines 句；最后一步和她紧接着的回答；根改掉了的那一句（准入了才出现，见 context）
    const rootL = byId(Number(u.root.slice(1)));
    const after = (l0) => {
      const outL = [];
      for (const l of ls) {
        if (l.perceptId <= l0.perceptId) continue;
        if (l.role === 'trigger') break;
        if (outL.length >= acceptN) break;
        outL.push(l);
      }
      return outL;
    };
    const last = [...ls].reverse().find((l) => l.role === 'trigger') ?? rootL;
    const core0 = [rootL, ...after(rootL), last, ...after(last)];
    const g = gl(rootL.perceptId);
    if (done(g) && Number.isSafeInteger(g.replaces)) {
      u.replacedRef = `p${g.replaces}`;
      const old = byId(g.replaces);
      if (old) core0.push(old);
      else u.replacedHere = isHere(core, g.replaces, here);
    }
    u.core = [...new Set(core0.map(ref))];
    // 有自己的后续：根之后他照着做了至少一步，或者它改掉了前面的一句（latestRoot 用）
    u.strong = ls.some((l) => l.role === 'trigger' && l.perceptId > rootL.perceptId) || u.replacedRef != null;
  }
  for (const u of units) u.replaced = u.kind === 'thread' && replaced.has(Number(u.root.slice(1)));

  // latestRoot（「他最近一次跟你定的」）：不是「他最新的一句 asks」（评审：后来在别处随口托她办一件事、一件新的提醒，游戏就丢了标记）。
  //   候选：所有没被改掉的段的根、开着的事的来源、他在这里最新的一句约定。先取最新的一个有自己后续的根 S（照着做过一步，或改掉了
  //   前面一句；他在这里的那一句和开着的事不算有后续）；没有就取最新的一个。比 S 新的候选只有和 S 的话题相似度到了 thread.sameTopic
  //   才把标记拿走（换个地方重新定了同一件事，第一眼没看见旧的那句）：最新的这样一句是别处的段就给它，在这里或是一件开着的事就谁都不带。
  //   这一段至少要有一个成员 A ≥ tau（跟着 B 渐渐淡掉，没有窗口）。只比代码看得到的结构和话题词，不认任何词
  const cands = [];
  for (const u of units) {
    if (u.kind === 'thread') {
      const r = byId(Number(u.root.slice(1)));
      if (r && !u.replaced) cands.push({ at: r.at, id: r.perceptId, row: r.row, u, strong: !!u.strong });
    } else if (u.kind === 'open') {
      const ls = u.members.map((x) => byId(Number(x.slice(1)))).filter((l) => l?.role === 'trigger');
      for (const l of ls) cands.push({ at: l.at, id: l.perceptId, row: l.row, u: null, strong: false });
    }
  }
  const hereRoot = lastHereRoot(core, here, people, focusId);
  if (hereRoot) cands.push({ at: hereRoot.at, id: hereRoot.id, row: hereRoot, u: null, strong: false });
  cands.sort((x, y) => y.at - x.at || y.id - x.id);
  const S = cands.find((c) => c.strong) ?? cands[0] ?? null;
  let win = S;
  if (S) {
    const sameMin = Number.isFinite(W.thread?.sameTopic) ? W.thread.sameTopic : 0.3;
    const sTerms = termsOf(core, S.row, own);
    for (const c of cands) {
      if (c === S || c.at < S.at || (c.at === S.at && c.id < S.id)) break;
      if (sTerms.size && similarity(core, sTerms, c.row, own) >= sameMin) { win = c; break; }
    }
  }
  const wu = win?.u ?? null;
  if (wu && wu.members.some((r) => (byId(Number(r.slice(1)))?.A ?? -Infinity) >= W.tau)) wu.latestRoot = true;
  return units;
}

/** 开着的事那一行用哪一句来源原话：他自己的话里最长、最自足的那句（方括号里的占位不算字数）。 */
function representative(ms) {
  const his = ms.filter((l) => l.role === 'trigger');
  const list = his.length ? his : ms;
  const score = (l) => String(l.text ?? '').replace(PLACEHOLDER, '').trim().length;
  return [...list].sort((x, y) => score(y) - score(x) || y.perceptId - x.perceptId)[0];
}

function isHere(core, id, here) {
  return safe(core, 'workingReplacedHere', () => core.store.get('SELECT setting_key AS k FROM percepts WHERE id = ?', id)?.k === here, false) ?? false;
}

/** 他在这里（这一句之前）最后一句话的时间；从没在这里说过返回 null。 */
function lastHere(core, here, people, focusId) {
  const ph = people.map(() => '?').join(',');
  const before = Number.isSafeInteger(focusId) ? focusId : Number.MAX_SAFE_INTEGER;
  const r = safe(core, 'workingLastHere', () => core.store.get(`SELECT MAX(at) AS at FROM percepts WHERE setting_key = ? AND actor_entity_id IN (${ph})
      AND id < ? AND kind IN ('utterance','action')`, here, ...people, before), null);
  return Number.isFinite(r?.at) ? r.at : null;
}

/** 他在这里（这一句之前）最新的一句约定（第一眼看过的宽松 asks、不是照着做的一步）。 */
function lastHereRoot(core, here, people, focusId) {
  const ph = people.map(() => '?').join(',');
  const before = Number.isSafeInteger(focusId) ? focusId : Number.MAX_SAFE_INTEGER;
  return safe(core, 'workingHereRoot', () => core.store.get(`SELECT p.id, p.at, p.text, p.addressed, p.mentions_json FROM percepts p JOIN glances g ON g.percept_id = p.id
      WHERE p.setting_key = ? AND p.actor_entity_id IN (${ph}) AND p.id < ? AND g.state = 'done' AND g.asks = 1 AND g.follows IS NULL
      ORDER BY p.id DESC LIMIT 1`, here, ...people, before), null) ?? null;
}

function mk(core, r, role) {
  // 她看过的媒体（D116）：文字里带上她看到的（「［视频，你看到的：…］」），说明另作话题词（row.note）
  const seen = r.media_json ? safe(core, 'workingSeen', () => core.mods.intake.seenMedia(core, r.media_json), null) : null;
  const max = Math.max(0, Math.floor(core.config.get().recall?.working?.mediaNoteChars ?? 40));
  const text = seen ? (safe(core, 'workingSeenText', () => core.mods.intake.mediaText(core, r.text, r.media_json, { who: '你', max }), null) ?? String(r.text ?? '')) : String(r.text ?? '');
  return {
    ref: `p${r.id}`, perceptId: r.id, settingKey: r.setting_key, at: r.at, role, actorEntityId: r.actor_entity_id ?? null,
    text, w: r.w_enc, A: 0, parts: { B: 0, trigger: 0, topic: 0, open: 0 }, topicSim: 0, focusSim: 0, open: false, intentionIds: [],
    context: null, primary: false, anchor: false, exchange: '', unitKey: null,
    row: { id: r.id, text: r.text, addressed: r.addressed, mentions_json: r.mentions_json ?? null, ...(seen ? { note: seen.summary } : {}) },
  };
}

/** 同一场合两行之间，她和他（们）以外的人说了几条（最多数到 cap + 1 就停）。 */
function othersBetween(core, sk, a, b, people, cap) {
  if (b - a <= 1) return 0;
  const ph = people.map(() => '?').join(',');
  const r = safe(core, 'workingGap', () => core.store.get(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM percepts WHERE setting_key = ? AND id > ? AND id < ? AND actor_self = 0
      AND (actor_entity_id IS NULL OR actor_entity_id NOT IN (${ph})) LIMIT ?)`, sk, a, b, ...people, cap + 1), null);
  return Number(r?.n ?? 0);
}

/**
 * 话题相似度（retrieve.workingSimilarity 的实现，关口②的「他自己提起的」也用它，D107）：触发者这一句 + 他在这里最近的 topicOwnLines 句
 * （按激活加权；别人的话不参与）和每一段文字的相似度（0–1）。
 * @param {{settingKey: string, people: number[], focusPerceptId?: number|null}} q
 * @param {string[]} texts
 * @returns {number[]}
 */
export function topicSimilarity(core, q, texts) {
  const people = (q?.people ?? []).filter((x) => Number.isSafeInteger(x));
  if (!people.length || typeof q?.settingKey !== 'string') return (texts ?? []).map(() => 0);
  const W = core.config.get().recall.working;
  const own = ownNames(core);
  const topic = topicTerms(core, q.settingKey, people, q.focusPerceptId, own, W, core.now());
  return (texts ?? []).map((t) => (topic.size && t ? similarity(core, topic, { text: t }, own) : 0));
}

function parseIds(json) {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0) : []; } catch { return []; }
}

/** 触发者本人 + 权利层确认的同一个人（和 discretion 的 rightsEquivalents 同一个口径；读不到权利层的口径就只有他自己）。 */
function equivalents(core, trig) {
  const deciders = (() => { try { return [...(core.mods.discretion.RIGHTS_DECIDERS ?? [])]; } catch { return []; } })();
  const out = [trig];
  if (!deciders.length) return out;
  const rows = safe(core, 'workingEq', () => core.store.all(
    `SELECT a, b FROM entity_links WHERE rel = 'same' AND decided_by IN (${deciders.map(() => '?').join(',')}) AND (a = ? OR b = ?)`,
    ...deciders, trig, trig), []) ?? [];
  for (const r of rows) { const o = r.a === trig ? r.b : r.a; if (Number.isSafeInteger(o) && !out.includes(o)) out.push(o); }
  return out;
}

/**
 * 一段话的词（话题相似度用）。叫她的那部分不算话题：对她说的话里「@她」那一处先去掉（discretion.withoutAddress，只去掉那个名字），
 * 她自己的名字也不算——不然每一句 @她 的话都和别处每一句 @她 的话「同一个话题」。
 */
function termsOf(core, row, own = new Set()) {
  // 方括号里的占位（［图片］［视频］［表情包:…］）不是话题（D113）；她看过的媒体的说明（row.note，D116）照样是话题
  const plain = `${plainOf(core, row).replace(PLACEHOLDER, ' ')} ${row?.note ?? ''}`;
  try {
    return new Set((core.mods.lang.queryTerms(core, plain) ?? []).map((w) => String(w).normalize('NFKC').toLowerCase()).filter((w) => w && !own.has(w)));
  } catch { return new Set(); }
}

/** 去掉叫她的那一处（discretion.withoutAddress）和认不出名字的「@某某 」以后的字（只用在话题和「一步」上：扫名字（隐私）那边不这样猜）。 */
function plainOf(core, row) {
  let plain = String(row?.text ?? '');
  try { plain = core.mods.discretion.withoutAddress(core, row) ?? plain; } catch { /* 原样 */ }
  return plain.replace(/[@＠]\S+(?=\s)/gu, ' ');
}

/** 方括号里的占位（［图片］、[视频]、［表情包:…］）：不算字数、不算话题。 */
const PLACEHOLDER = /[［[][^］\]]*[］\]]/gu;

/** 一句话自己带着几个字（去掉叫她的那一处、空白、方括号里的占位）：退回的切法里认「照着做的一步」用（W.thread.stepChars）。 */
function ownChars(core, row) {
  return Array.from(plainOf(core, row).replace(PLACEHOLDER, '').replace(/\s+/gu, '')).length;
}

/** 她自己的名字（entity_names），规范化成小写；话题里不算。 */
function ownNames(core) {
  const me = selfId(core);
  if (me == null) return new Set();
  const rows = safe(core, 'workingOwnNames', () => core.store.all('SELECT text_raw FROM entity_names WHERE entity_id = ?', me), []) ?? [];
  const out = new Set();
  for (const r of rows) {
    const n = String(r.text_raw ?? '').normalize('NFKC').toLowerCase().trim();
    if (n) out.add(n);
    try { for (const w of core.mods.lang.queryTerms(core, n) ?? []) out.add(String(w).normalize('NFKC').toLowerCase()); } catch { /* 没有语言模块 */ }
  }
  return out;
}

function focusRow(core, here, people, focusId) {
  if (!Number.isSafeInteger(focusId)) return null;
  const f = safe(core, 'workingFocus', () => core.store.get('SELECT id, setting_key, actor_entity_id, at, w_enc, text, addressed, mentions_json FROM percepts WHERE id = ?', focusId), null);
  return f?.text && f.setting_key === here && people.includes(f.actor_entity_id) ? f : null;
}

/** 只拿触发者这一句的词（权重都是 1）。 */
function focusTerms(core, here, people, focusId, own) {
  const out = new Map();
  const f = focusRow(core, here, people, focusId);
  if (f) for (const w of termsOf(core, f, own)) out.set(w, 1);
  return out;
}

/**
 * 话题：触发者这一句（权重 1）+ 他在这里最近的几句（recall.working.topicOwnLines 条，不是时间窗），那几句按激活加权
 * min(1, exp(B − B_焦点))：刚说的和这一句一样重，一小时前的提醒只占一小部分（D110）。别人的话不参与。返回 词 → 权重。
 */
function topicTerms(core, here, people, focusId, own, W, at) {
  const out = new Map();
  const f = focusRow(core, here, people, focusId);
  const ph = people.map(() => '?').join(',');
  const n = Math.max(0, Math.floor(W.topicOwnLines ?? 3));
  const recent = (safe(core, 'workingTopic', () => core.store.all(
    `SELECT id, at, w_enc, text, addressed, mentions_json FROM percepts WHERE setting_key = ? AND actor_entity_id IN (${ph}) AND text IS NOT NULL ORDER BY id DESC LIMIT ?`,
    here, ...people, n), []) ?? []).filter((r) => r.id !== f?.id);
  const all = [...(f ? [f] : []), ...recent];
  if (!all.length) return out;
  const Bs = strengths(core, all.map((r) => ({ ref: `p${r.id}`, at: r.at, w: r.w_enc })), at);
  const bF = f ? Bs.get(`p${f.id}`) : Math.max(...all.map((r) => Bs.get(`p${r.id}`) ?? STRENGTH_FLOOR));
  for (const r of all) {
    const w = r === f ? 1 : Math.min(1, Math.exp((Bs.get(`p${r.id}`) ?? STRENGTH_FLOOR) - (bF ?? 0)));
    for (const t of termsOf(core, r, own)) out.set(t, Math.max(out.get(t) ?? 0, w));
  }
  return out;
}

/**
 * 话题相似度：共有的词的权重占较短一边的比例（0–1；话题一边按权重算有多少词）。一句很短的「7」和什么都不像，长句里碰巧有一个常见词
 * 也不算多像。topic 可以是 词 → 权重 的 Map，也可以是词的 Set（权重都是 1）。
 */
export function similarity(core, topic, row, own) {
  const t = termsOf(core, row, own);
  if (!t.size || !topic.size) return 0;
  const weight = (w) => (topic instanceof Map ? topic.get(w) ?? 0 : topic.has(w) ? 1 : 0);
  let n = 0;
  for (const w of t) n += weight(w);
  const eff = topic instanceof Map ? [...topic.values()].reduce((s, x) => s + x, 0) : topic.size;
  const m = Math.min(t.size, eff);
  if (!(m > 0)) return 0;
  return Math.min(1, n / m * Math.min(1, Math.sqrt(m / 2)));
}

/** 每一行现在的基础激活 B（ref → B）：先问 dynamics；它出错或没给的，按单条痕迹的同一个公式现算。 */
function strengths(core, lines, at) {
  const got = safe(core, 'workingB', () => core.mods.dynamics.baseActivations(core, lines.map((l) => l.ref), at), null);
  const act = core.config.get().activation;
  const unit = Number(act.timeUnitMs) > 0 ? act.timeUnitMs : 3_600_000;
  const floor = Math.max(1, (Number(act.ageFloorMin) || 0) * 60_000);
  const d = Number.isFinite(act.a) ? act.a : 0.3;
  const out = new Map();
  for (const l of lines) {
    const b = got instanceof Map ? got.get(l.ref) : undefined;
    if (Number.isFinite(b)) { out.set(l.ref, b); continue; }
    if (b === -Infinity) { out.set(l.ref, STRENGTH_FLOOR); continue; }
    const w = l.w == null ? 1 : Number(l.w);
    if (!(w > 0)) { out.set(l.ref, STRENGTH_FLOOR); continue; }
    out.set(l.ref, Math.log(w) - d * Math.log(Math.max(at - l.at, floor) / unit));
  }
  return out;
}
