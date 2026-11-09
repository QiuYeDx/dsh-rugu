// 她自己的经验（D124，docs/调研/anthropic-agent-memory.md 第 3 项）：做事学到的东西——一条规则、怎么知道它是对的（证据）、
// 要避开的坑，标「验证过 / 还没验证」。经验是她自己做事的办法，不是对别人的看法，也不授予任何权限。
//   存法：关于她自己的事实（主体是她，kind_hint='lesson'，属性键 lesson），这样来源、规范、谁知道、激活、全文检索、向量、
//   隐藏 / 忘掉 / 彻底删除、备份、版本历史、管理页都照现有的走，不加表、不加迁移。范围是结构化字段：value 里的 JSON
//   （tool：哪个工具；setting：只在哪个场合；trap：要避开的坑；status / origin / how：验证过没有、从哪来、怎么知道的），
//   提到的人是 mention 角色。话题不写词表，靠词（按全文检索的 IDF 加权）和五路回想。
//   隐藏、忘掉的经验（suppressions）哪儿都不用：不想起、不常驻、不并进、不计数、不给夜里回顾看；忘掉的同一件事也不再记（评审 H1）。
//   怎么算验证过（全部由代码按证据定，不信她自己说）：
//     - 主人（有管理权限的人）的原话撑得住：evidence_quote 在主人那条消息里，规则的词大部分在那条消息里；
//     - 宿主看到这个工具在这个会话里先没成、换了做法以后成了（lessons.proofMin 分钟内），她这时记下的这个工具的经验——
//       只在这一轮是主人开的头或她自己开的头、而且这一轮没有别人的话撑得住这条时（评审 H3：群友口授的不因为工具成了就算验证过）；
//     - 主人在管理页确认，或者主人发起的 memory_fix confirm / correct；
//     - 夜里回顾（consolidate/lessons.js）引用了主人的纠正、而且主人那句话撑得住这条（评审 H2）。
//   其余（她自己琢磨的、别人告诉她的、夜里从反复没成里总结的）都是还没验证；这一轮读过来路不明的东西（按轮污点），或者读不到这一轮
//   的污点（fail closed）时记下的也是，而且不会被放进常驻区。别人告诉她的记成「听说」（hearsay），只在听到的那个场合用，
//   也不挂到任何人身上（评审 M1：经验不是对人的判断；「别理某某」这种，管理页里看得到，不会在那个人在场时被想起）。
//   同一件事不另记：同一个工具、同一个范围、意思差不多的并进那一条——还没验证的只加一个来源，不改验证过的那一条（评审 M2）；
//   新的验证过、旧的没有时写成新版本，旧的留着。
//   工具记录（toolOutcome）：只记工具名（带服务前缀，评审：不同服务的同名工具不混）、成没成、一小段出错类别（引号里的内容、数字、
//   网址都去掉，评审：不落别人的原话）、时间、会话的哈希；没成的和「换了做法后成了」的落库（meta，最近 toolLog.max 条，夜里回顾用），
//   这个会话最近用过哪些工具只在内存里。
import { getMetaJson, setMetaJson, bumpMetric } from '../store/kv.js';
import { refOf } from '../store/refs.js';
import { clip, jsonParse, modeOfPercept, tzOffsetMin, DAY, MIN } from './util.js';
import { writeAssertion, addSource, reviseAssertion, assertionRow, selfIdOf, ensurePredicate } from './write.js';
import { pickTrigger, supportedBy, targetSim, resolveName, findTrigger, triggerProblem } from './tools.js';

export const LESSON_KIND = 'lesson';
const PREDICATE = 'lesson';
const TOOL_LOG = 'lessons.toolLog';
const STATUS_TEXT = Object.freeze({ verified: '（验证过）', unverified: '（还没验证）' });
/** 「怎么知道的」：按来源由代码写，给管理页和她自己看。 */
export const HOW = Object.freeze({
  owner: '主人教的', tool: '试过：先没成，换了做法以后成了', confirmed: '主人确认过', self: '自己琢磨的，还没试过',
  told: '听别人说的', nightly: '夜里回顾时总结的', correction: '主人纠正过',
});
/** 主人做的（主人教的、确认过、纠正过）：夜里不合并、不降级，管理页不再给「确认」。 */
export const OWNER_ORIGINS = Object.freeze(['owner', 'confirmed', 'correction']);

const errCode = (e) => e?.code ?? e?.name ?? 'Error';
const cfgOf = (core) => core.config.get().lessons ?? {};
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, n) => (typeof v === 'string' && v.trim() ? clip(v.replace(/\s+/g, ' ').trim(), n) : null);

/** 工具名：去空白、截断；服务前缀（「mcp__服务__工具」）留着，不同服务的同名工具不混（评审）。不认任何具体的工具。 */
export function normTool(name) {
  const s = String(name ?? '').trim();
  return s ? clip(s, 120) || null : null;
}
/** 给她看的工具名：去掉服务前缀。 */
export function toolLabel(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}
/**
 * 经验记的工具和正在用的工具是不是同一个：一模一样；或者经验里只写了工具本名（她自己记时常这么写），正在用的去掉服务前缀后是它。
 * 经验里带了服务前缀的只认同一个服务的。
 */
export function toolMatches(lessonTool, usedTool) {
  if (!lessonTool || !usedTool) return false;
  if (lessonTool === usedTool) return true;
  return !lessonTool.includes('__') && toolLabel(usedTool) === lessonTool;
}

/** 一条经验的结构化部分（value 里的 JSON）；读不出来的按确定程度推（确认过 / 主人说的算验证过）。 */
export function lessonInfo(row) {
  const v = jsonParse(row?.value, null);
  const o = v && typeof v === 'object' ? v : {};
  const status = o.status === 'verified' || o.status === 'unverified' ? o.status
    : (row?.certainty === 'confirmed' || row?.certainty === 'stated' ? 'verified' : 'unverified');
  return {
    status, origin: typeof o.origin === 'string' ? o.origin : 'self', tool: typeof o.tool === 'string' && o.tool ? o.tool : null,
    setting: typeof o.setting === 'string' && o.setting ? o.setting : null, trap: typeof o.trap === 'string' && o.trap ? o.trap : null,
    how: typeof o.how === 'string' && o.how ? o.how : null, tainted: !!o.tainted, promotedAt: Number.isFinite(o.promotedAt) ? o.promotedAt : null,
  };
}
const valueOf = (info) => JSON.stringify({
  v: 1, status: info.status, origin: info.origin, ...(info.tool ? { tool: info.tool } : {}), ...(info.setting ? { setting: info.setting } : {}),
  ...(info.trap ? { trap: info.trap } : {}), ...(info.how ? { how: info.how } : {}), ...(info.tainted ? { tainted: true } : {}),
  ...(Number.isFinite(info.promotedAt) ? { promotedAt: info.promotedAt } : {}),
});
/** 主人做的、验证过的经验（夜里不能把它并进还没验证的里，评审 M3）。 */
export function ownerMade(row) {
  const i = lessonInfo(row);
  return row?.certainty === 'confirmed' || !!row?.pinned || (i.status === 'verified' && OWNER_ORIGINS.includes(i.origin));
}

/**
 * 给她看的一行：「（验证过）用 X 时：规则（要避开：坑）」。vague：关口①只让说个大概时用它代替正文；provenance：听来的、主人教的，
 * 后面带一句是谁、在哪儿说的（评审 M7）。
 * @param {object} core @param {object|number} rowOrId @param {{chars?: number, vague?: string|null, provenance?: string|null}} [opt]
 */
export function lessonLine(core, rowOrId, { chars, vague = null, provenance = null } = {}) {
  const row = typeof rowOrId === 'object' ? rowOrId : assertionRow(core, rowOrId);
  if (!row) return '';
  const info = lessonInfo(row);
  const max = num(chars, num(cfgOf(core).itemChars, 110));
  const body = vague ? String(vague) : `${info.tool ? `用 ${toolLabel(info.tool)} 时：` : ''}${String(row.text ?? '').replace(/[。.]+$/u, '')}${info.trap ? `（要避开：${info.trap}）` : ''}`;
  const prov = provenance ? `〔${clip(String(provenance), 30)}〕` : '';
  let s = `${STATUS_TEXT[info.status]}${body}`;
  try { s = core.mods.intake.sanitizeForPrompt(core, s); } catch { /* 用原样 */ }
  // 来源说法放在最后、放得下才带（正文优先）
  return prov && [...s].length + [...prov].length <= max ? `${s}${prov}` : clip(s, max);
}

/** 这条经验现在是不是被隐藏 / 忘掉了。 */
function suppressedState(core, id) {
  return core.store.get("SELECT state FROM suppressions WHERE owner_kind = 'assertion' AND owner_id = ?", id)?.state ?? null;
}

/**
 * 现在这一版的经验（没被取代、没失效），新的在前。隐藏、忘掉的默认不算（评审 H1：哪儿都不用）；withSuppressed 给要处理它们的地方
 * （夜里把它们从常驻区拿出来、认出「忘掉的同一件事」）。
 */
export function currentLessons(core, limit = 500, { withSuppressed = false } = {}) {
  return core.store.all(`SELECT * FROM assertions a WHERE kind_hint = ? AND superseded_by IS NULL AND expired_at IS NULL
      ${withSuppressed ? '' : "AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.owner_kind = 'assertion' AND s.owner_id = a.id)"}
      ORDER BY id DESC LIMIT ?`, LESSON_KIND, limit);
}

/** 这条经验提到的人（mention 角色）。 */
function mentionsOf(core, id) {
  return core.store.all("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role = 'mention'", id).map((r) => r.entity_id);
}

function terms(core, text) {
  try { return [...new Set(core.mods.lang.queryTerms(core, String(text ?? '')))]; } catch { return []; }
}
/** 只要多字的词（单字几乎每句都有）。 */
const multiTerms = (list) => list.filter((t) => [...t].length >= 2);

// ── 工具记录 ──────────────────────────────────────────────────────────────

function lstate(core) {
  const st = core.state.encode ?? (core.state.encode = {});
  st.lessons ??= { tools: new Map() };
  return st.lessons;
}
const sessionHash = (core, sessionId) => (typeof sessionId === 'string' && sessionId ? core.keys.hash('lesson-session', sessionId) : null);

/**
 * 出错类别（评审：工具记录不落别人的原话）：第一行，去掉引号括起来的内容、网址、数字，清洗、截断到 errorChars。
 * 剩下的多半是「消息太长」「timeout」「权限不够」这类工具自己的话。
 */
export function errorClass(core, e) {
  let s = String(e ?? '').split(/\r?\n/).find((x) => x.trim()) ?? '';
  s = s.replace(/[「『“"'‘][^」』”"'’]*[」』”"'’]/gu, '…').replace(/https?:\/\/\S+/g, '…').replace(/\d+/g, '#');
  try { s = core.mods.intake.sanitizeForStore(core, s); } catch { /* 用原样 */ }
  s = s.replace(/\s+/g, ' ').trim();
  return s ? clip(s, num(cfgOf(core).toolLog?.errorChars, 40)) : null;
}

/** 落库的工具记录（没成的、换了做法后成了的）。 */
export function toolLog(core) {
  const v = getMetaJson(core.store, TOOL_LOG, []);
  return Array.isArray(v) ? v.filter((x) => x && typeof x.t === 'string' && Number.isFinite(x.at)) : [];
}

/**
 * 宿主交来一次工具调用的结果（D124）。不抛错。
 *   recovered：这个工具在这个会话里 proofMin 分钟内先没成、这次成了（换了做法）；
 *   lessons：现在有几条这个工具的经验（隐藏、忘掉的不算；宿主据此决定要不要按这个工具再想一次）。
 * @param {object} core
 * @param {{sessionId?: string, tool: string, ok: boolean, error?: string, at?: number}} o
 * @returns {{recorded: boolean, recovered: boolean, lessons: number}}
 */
export function toolOutcome(core, o) {
  const out = { recorded: false, recovered: false, lessons: 0 };
  try {
    const c = cfgOf(core);
    if (c.enabled === false) return out;
    const t = normTool(o?.tool);
    if (!t) return out;
    const at = Number.isFinite(o?.at) ? o.at : core.now();
    const ok = o?.ok !== false;
    const sh = sessionHash(core, o?.sessionId);
    const L = lstate(core);
    if (sh) {
      const win = num(c.sessionTools?.windowMin, 180) * MIN;
      const proof = num(c.proofMin, 30) * MIN;
      const list = (L.tools.get(sh) ?? []).filter((x) => at - x.at <= win);
      // 换了做法后成了：这个工具最近一次成功之后、proofMin 之内有过没成的
      if (ok) {
        let lastOk = -Infinity;
        for (const x of list) if (x.t === t && x.ok) lastOk = Math.max(lastOk, x.at);
        out.recovered = list.some((x) => x.t === t && !x.ok && x.at > lastOk && at - x.at <= proof);
      }
      list.push({ t, at, ok });
      L.tools.set(sh, list.slice(-num(c.sessionTools?.max, 12)));
      if (L.tools.size > 500) L.tools.delete(L.tools.keys().next().value);
    }
    if (!ok || out.recovered) {
      const log = toolLog(core);
      const e = !ok ? errorClass(core, o?.error) : null;
      log.push({ at, t, ok: ok ? 1 : 0, ...(sh ? { s: sh } : {}), ...(e ? { e } : {}), ...(out.recovered ? { r: 1 } : {}) });
      setMetaJson(core.store, TOOL_LOG, log.slice(-num(c.toolLog?.max, 300)));
      out.recorded = true;
      bumpMetric(core.store, out.recovered ? 'lessons.tool.recovered' : 'lessons.tool.failed');
    }
    out.lessons = currentLessons(core).filter((r) => toolMatches(lessonInfo(r).tool, t)).length;
  } catch (e) {
    try { core.log.warn('encode.lessons.toolOutcome', { error: errCode(e) }); } catch { /* 日志也失败就算了 */ }
  }
  return out;
}

/** 这个会话最近用过的工具（新的在前，只在内存里）。 */
export function sessionTools(core, sessionId, at = core.now()) {
  const sh = sessionHash(core, sessionId);
  if (!sh) return [];
  const win = num(cfgOf(core).sessionTools?.windowMin, 180) * MIN;
  const list = (lstate(core).tools.get(sh) ?? []).filter((x) => at - x.at <= win);
  return [...new Set(list.reverse().map((x) => x.t))];
}

/** 这个会话里这个工具 proofMin 分钟内「换了做法后成了」的那一条记录（没有就 null）。 */
function proofFor(core, sessionId, tool, at) {
  const sh = sessionHash(core, sessionId);
  if (!sh || !tool) return null;
  const proof = num(cfgOf(core).proofMin, 30) * MIN;
  const log = toolLog(core);
  const hit = [...log].reverse().find((x) => x.s === sh && toolMatches(tool, x.t) && x.r === 1 && at - x.at <= proof && x.at <= at + MIN);
  if (!hit) return null;
  const fail = [...log].reverse().find((x) => x.s === sh && x.t === hit.t && x.ok === 0 && x.at <= hit.at && hit.at - x.at <= proof);
  return { ...hit, e: fail?.e ?? null };
}

// ── 写 ────────────────────────────────────────────────────────────────────

/** 同一个工具、同一个范围、意思差不多的那一条（没有就 null）。withSuppressed：连隐藏、忘掉的一起找（认出「忘掉的同一件事」）。 */
export function findSame(core, { text, tool = null, setting = null, exclude = [], withSuppressed = false }) {
  const min = num(cfgOf(core).sameSim, 0.5);
  let best = null;
  for (const r of currentLessons(core, 500, { withSuppressed })) {
    if (exclude.includes(r.id)) continue;
    const info = lessonInfo(r);
    if ((info.tool ?? null) !== (tool ?? null) || (info.setting ?? null) !== (setting ?? null)) continue;
    const s = targetSim(core, text, r.text).s;
    if (s >= min && (!best || s > best.s)) best = { row: r, s };
  }
  return best?.row ?? null;
}

const CERTAINTY = Object.freeze({ owner: 'stated', tool: 'stated', confirmed: 'confirmed', correction: 'stated', self: 'self_said', told: 'hearsay', nightly: 'inferred' });

/**
 * 写一条经验，或者并进说同一件事的那一条（实现 encode.writeLesson）。在调用方的事务里或自己开一个。
 *   并进时：新的验证过（没带污点）、旧的没有 → 写新版本；新的还没验证、或者带污点 → 只给那一条加一个来源，不改它的说法和坑（评审 M2）；
 *   都验证过 → 加来源，旧的没写坑时才补上新的坑。
 *   主人忘掉的同一件事（忘掉的那一条）不再记：抛 LESSON_FORGOTTEN。
 * @param {object} core
 * @param {{text: string, trap?: string|null, tool?: string|null, setting?: string|null, about?: number[], status: 'verified'|'unverified',
 *          origin: string, how?: string|null, tainted?: boolean, sources: object[], at?: number, extractVer?: string|null, model?: string|null}} input
 * @returns {{id: number, merged: boolean, upgraded: boolean}}
 */
export function writeLesson(core, input) {
  const c = cfgOf(core);
  const text = str(input.text, num(c.textMax, 120));
  if (!text) throw Object.assign(new Error('lesson-empty'), { code: 'LESSON_EMPTY' });
  const info = {
    status: input.status === 'verified' && !input.tainted ? 'verified' : 'unverified', origin: input.origin ?? 'self',
    tool: normTool(input.tool), setting: typeof input.setting === 'string' && input.setting ? input.setting : null,
    trap: str(input.trap, num(c.trapMax, 60)), how: str(input.how ?? HOW[input.origin] ?? null, num(c.howMax, 60)), tainted: !!input.tainted,
  };
  const at = Number.isFinite(input.at) ? input.at : core.now();
  const self = selfIdOf(core);
  const certainty = info.status === 'verified' ? (CERTAINTY[info.origin] === 'confirmed' ? 'confirmed' : 'stated') : (CERTAINTY[info.origin] ?? 'self_said');
  const confidence = info.status === 'verified' ? 0.9 : info.origin === 'told' ? 0.4 : 0.5;
  const imp = info.status === 'verified' ? 6 : 4;
  return core.store.tx(() => {
    // 主人忘掉的同一件事：不再记（「忘掉」= 隐藏并且以后别再记同样的内容）
    const gone = findSame(core, { text, tool: info.tool, setting: info.setting, withSuppressed: true });
    if (gone && suppressedState(core, gone.id) === 'forgotten') {
      bumpMetric(core.store, 'lessons.forgottenAgain');
      throw Object.assign(new Error('lesson-forgotten'), { code: 'LESSON_FORGOTTEN' });
    }
    const same = findSame(core, { text, tool: info.tool, setting: info.setting });
    if (same) {
      const old = lessonInfo(same);
      if (info.status === 'verified' && old.status !== 'verified') {
        // 新的验证过、旧的没有：写成新版本（新的说法、验证过），旧的被取代、留着
        const nid = reviseAssertion(core, same.id, {
          text, certainty, confidence, value: valueOf({ ...old, ...info, trap: info.trap ?? old.trap, promotedAt: null }),
          extractVer: input.extractVer ?? null, model: input.model ?? null,
        }, { at });
        for (const s of input.sources ?? []) addSource(core, { kind: 'assertion', id: nid }, s, { reason: 'mention', w: 1 });
        bumpMetric(core.store, 'lessons.upgraded');
        return { id: nid, merged: true, upgraded: true };
      }
      for (const s of input.sources ?? []) addSource(core, { kind: 'assertion', id: same.id }, s, { reason: 'mention', w: 1 });
      // 坑只从验证过、没带污点的新说法里补（还没验证的、别人说的不改验证过的那一条，评审 M2）
      if (info.trap && !old.trap && info.status === 'verified' && !info.tainted) {
        core.store.run('UPDATE assertions SET value = ?, updated_at = ? WHERE id = ?', valueOf({ ...old, trap: info.trap }), core.now(), same.id);
      }
      bumpMetric(core.store, 'lessons.merged');
      return { id: same.id, merged: true, upgraded: false };
    }
    let w = 1;
    try { w = core.mods.dynamics.encodingWeight(core, { wAtt: core.config.get().activation.attention.selfThought ?? 0.5, imp }); } catch { w = 1; }
    let predicate = PREDICATE;
    try { predicate = ensurePredicate(core, PREDICATE, { cardinality: 'many', isCurrent: false, createdBy: 'lesson' }) ?? PREDICATE; } catch { /* 用原样的键 */ }
    const id = writeAssertion(core, {
      subjects: Number.isInteger(self) ? [self] : [], mentions: [...new Set((input.about ?? []).filter((x) => Number.isInteger(x) && x !== self))],
      predicate, predicateCreatedBy: 'lesson', cardinality: 'many', isCurrent: false, value: valueOf(info), text, kindHint: LESSON_KIND,
      certainty, confidence, imp, validFrom: at, sources: input.sources ?? [], norm: {}, w,
      extractVer: input.extractVer ?? null, model: input.model ?? null, jobId: null,
    });
    bumpMetric(core.store, info.status === 'verified' ? 'lessons.written.verified' : 'lessons.written.unverified');
    return { id, merged: false, upgraded: false };
  });
}

/** 这条感知的说话人有没有管理权限。 */
function isPrincipal(core, entityId) {
  if (!entityId) return false;
  try { return core.mods.entities.bondOf(core, entityId)?.authority === 'principal'; } catch { return false; }
}
/** 本地「今天」从什么时候开始（config.time.tzOffsetMin）。 */
function localDayStart(core, at) {
  const off = tzOffsetMin(core, at) * MIN;
  return at - ((((at + off) % DAY) + DAY) % DAY);
}

/**
 * memory_note 的「经验」（D124；集成层的 memory_note kind=lesson）。她自己的知识：不占「一条消息一个操作」，不进审核队列。
 *   triggerObsId / triggerObsIds：这一轮触发她的那条（没有 = 她自己开的头）和她这一轮看到的、别人对她说的。
 *   evidence_quote 给了：照 note 的规矩在这些消息里找原话（找不到照样报 quote-not-in-message）；
 *     是主人的、规则的词大部分在那条消息里 → 验证过（主人教的）；别人的 → 还没验证（听说）。
 *   没给：这一轮别人对她说的话撑得住这条 → 还是听说（评审 H3：群友口授的不因为没引原话就变成她自己的）；
 *     tool 给了、宿主刚看到这个工具先没成后成了、这一轮是主人或她自己开的头 → 验证过（试出来的）；否则是她自己琢磨的，还没验证。
 *   听说的：只在听到的那个场合用，不挂到任何人身上（评审 M1）。
 *   这一轮带按轮污点、或者读不到（fail closed）：除了主人的原话，一律还没验证、不进常驻区。
 * @param {object} core
 * @param {{sessionId?: string, triggerObsId?: string, triggerObsIds?: string[], text: string, trap?: string, tool?: string, about?: string,
 *          here?: boolean, evidenceQuote?: string}} req
 * @returns {{status: 'done'|'rejected', reason?: string, refs?: string[], lessonStatus?: string, merged?: boolean, triggerObsId?: string}}
 */
export function noteLesson(core, req) {
  const c = cfgOf(core);
  if (c.enabled === false) return { status: 'rejected', reason: 'lessons-off' };
  const text = str(req?.text, num(c.textMax, 120));
  if (!text) return { status: 'rejected', reason: 'text-not-supported' };
  const at = core.now();
  const self = selfIdOf(core);
  let session = null;
  let tainted = true;
  try {
    session = typeof req.sessionId === 'string' && req.sessionId ? core.mods.context.sessionInfo(core, req.sessionId) : null;
    tainted = session ? !!session.turnTainted : true;   // 读不到这一轮的污点：按带污点（fail closed）
  } catch { session = null; tainted = true; }
  const tool = normTool(req.tool);
  let status = 'unverified';
  let origin = 'self';
  let sources = [{ perceptId: null, snapshotId: null, perceivedIn: session?.settingKey ?? null, speaker: self, asserter: self, mode: 'self_generated', hop: 0, confidence: 0.5, at }];
  let settingKey = session?.settingKey ?? null;
  let triggerObsId;
  const toldBy = (p, quote) => [{ perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: p.actor_entity_id, asserter: p.actor_entity_id,
    mode: modeOfPercept(p), hop: 1, quote: clip(quote ?? p.text ?? '', 60), confidence: 0.5, at: p.at }];
  let toldSetting = null;
  if (typeof req.evidenceQuote === 'string' && req.evidenceQuote.trim()) {
    const trig = pickTrigger(core, { triggerObsId: req.triggerObsId, triggerObsIds: req.triggerObsIds, evidenceQuote: req.evidenceQuote });
    if (trig.problem) return { status: 'rejected', reason: trig.problem };
    const p = trig.p;
    triggerObsId = trig.obsId;
    settingKey ??= p.setting_key;
    const supported = supportedBy(core, text, p.text);
    // 别人借了主人一句话（这一轮还有别人在对她说话、这条消息又撑不住）：照 fix 的规矩，不按主人的算
    const principal = isPrincipal(core, p.actor_entity_id) && supported;
    if (principal) {
      status = 'verified'; origin = 'owner'; tainted = false;
      sources = [{ ...toldBy(p, req.evidenceQuote)[0], confidence: 0.9 }];
    } else {
      origin = 'told';
      toldSetting = p.setting_key;
      sources = toldBy(p, req.evidenceQuote);
    }
  } else {
    // 这一轮看到的、别人（不是主人）对她说的话撑得住这条：是听来的（评审 H3）
    const ids = [...new Set([req.triggerObsId, ...(Array.isArray(req.triggerObsIds) ? req.triggerObsIds : [])].filter((x) => typeof x === 'string' && x))].slice(0, 9);
    const seen = [];
    for (const id of ids) {
      const p = findTrigger(core, id);
      if (!triggerProblem(core, p)) seen.push({ id, p });
    }
    const dictated = seen.find((x) => !isPrincipal(core, x.p.actor_entity_id) && supportedBy(core, text, x.p.text));
    if (dictated) {
      origin = 'told';
      toldSetting = dictated.p.setting_key;
      sources = toldBy(dictated.p);
    } else if (tool) {
      const proof = proofFor(core, req.sessionId, tool, at);
      if (proof) {
        // 这一轮是谁开的头：主人、或者她自己（没有触发消息）才算验证过；别人开的头，试出来的也先标还没验证（评审 H3）
        const trig = req.triggerObsId ? seen.find((x) => x.id === req.triggerObsId)?.p ?? null : null;
        const opener = !req.triggerObsId || (trig && isPrincipal(core, trig.actor_entity_id));
        status = opener ? 'verified' : 'unverified';
        origin = 'tool';
        sources = [{ perceptId: null, snapshotId: null, perceivedIn: settingKey, speaker: self, asserter: self, mode: 'observed', hop: 0,
          quote: clip(`${toolLabel(proof.t)}：先没成${proof.e ? `（${proof.e}）` : ''}，换了做法以后成了`, 60), confidence: opener ? 0.9 : 0.5, at: proof.at }];
      }
    }
  }
  // 她一天新记几条有上限（按本地日；并进已有的不算；主人教的不受这个限制）
  const today = core.store.get('SELECT COUNT(*) AS n FROM assertions WHERE kind_hint = ? AND created_at >= ?', LESSON_KIND, localDayStart(core, at))?.n ?? 0;
  // 听来的：只在听到的那个场合用、不挂到任何人身上（评审 M1）
  const about = [];
  if (req.about && origin !== 'told') { const id = resolveName(core, req.about, settingKey); if (Number.isInteger(id)) about.push(id); }
  const setting = origin === 'told' ? (toldSetting ?? settingKey) : (req.here === true && settingKey ? settingKey : null);
  if (origin !== 'owner' && today >= num(c.perDay, 12) && !findSame(core, { text, tool, setting })) return { status: 'rejected', reason: 'lesson-too-many' };
  try {
    const r = writeLesson(core, { text, trap: req.trap, tool, setting, about, status, origin, tainted: tainted && origin !== 'owner', sources, at });
    const row = assertionRow(core, r.id);
    return { status: 'done', refs: [refOf('assertion', r.id)], lessonStatus: lessonInfo(row).status, merged: r.merged, ...(triggerObsId ? { triggerObsId } : {}) };
  } catch (e) {
    if (e?.code === 'LESSON_FORGOTTEN') return { status: 'rejected', reason: 'lesson-forgotten' };
    core.log.warn('encode.lessons.note', { error: errCode(e) });
    throw e;
  }
}

/** 主人确认一条经验（管理页、memory_fix confirm）：验证过，确认过。in place 改（只改状态，不改说法）。 */
export function confirmLesson(core, id, { at = core.now(), how = HOW.confirmed } = {}) {
  const row = assertionRow(core, id);
  if (!row || row.kind_hint !== LESSON_KIND) return { ok: false, reason: 'not-a-lesson' };
  if (row.superseded_by != null) return { ok: false, reason: 'superseded' };
  const info = lessonInfo(row);
  core.store.run('UPDATE assertions SET certainty = ?, confidence = ?, value = ?, updated_at = ? WHERE id = ?',
    'confirmed', Math.max(0.9, row.confidence ?? 0), valueOf({ ...info, status: 'verified', origin: 'confirmed', how, tainted: false }), at, id);
  bumpMetric(core.store, 'lessons.confirmed');
  return { ok: true, ref: refOf('assertion', id) };
}

/** 主人改正一条经验之后（memory_fix correct）：新版本的 value 照旧版本的范围，状态是验证过。 */
export function correctedLessonValue(oldRow) {
  const info = lessonInfo(oldRow);
  return valueOf({ ...info, status: 'verified', origin: 'owner', how: HOW.correction, tainted: false, promotedAt: null });
}

// ── 想起 ──────────────────────────────────────────────────────────────────

/**
 * 话题对不对得上（评审 M4）：经验正文的多字词，按全文检索的 IDF 加权——眼前这句里出现的那几个词的权重占经验全部词的 topicMin 以上，
 * 而且至少两个词、其中至少一个不是到处都有的词；或者不是到处都有的词命中了 topicHits 个以上（长一点的经验覆盖率天然低）（rowFraction ≥ topicCommon 且至少 topicCommonDocs 条原话里有的算到处都有）。「回答一下」这种到处都有的词凑不够。
 * stats 读不到时每个词权重 1（只按覆盖率）。
 */
function topicScore(lt, focus, stats, c) {
  if (!lt.length || !focus?.size) return 0;
  const w = (t) => { const s = stats?.get?.(t); return Number.isFinite(s?.idf) && s.idf > 0 ? s.idf : 1; };
  // 到处都有的词：出现在 topicCommon 比例以上的原话里，而且至少 topicCommonDocs 条（库很小时比例没有意义：经验自己那一条也算一条）
  const common = (t) => { const s = stats?.get?.(t); return Number.isFinite(s?.rowFraction) && s.rowFraction >= num(c.topicCommon, 0.02) && num(s.docs, Infinity) >= num(c.topicCommonDocs, 5); };
  const hits = lt.filter((t) => focus.has(t));
  const rare = hits.filter((t) => !common(t)).length;
  if (hits.length < 2 || !rare) return 0;
  const cov = hits.reduce((n, t) => n + w(t), 0) / lt.reduce((n, t) => n + w(t), 0);
  // 长一点的经验覆盖率天然低：不是到处都有的词命中了 topicHits 个以上也算对上
  if (cov >= num(c.topicMin, 0.34)) return cov;
  return rare >= num(c.topicHits, 3) ? Math.max(cov, num(c.topicMin, 0.34)) : 0;
}

/**
 * 这一轮该想起的经验（D124）：按范围对上——这个工具正在用 / 这个会话刚用过、提到的人在场或在跟她说话、只属于这个场合的在这里、
 * 一个新会话（周期）的第一轮时她有经验的工具（startOfCycle：验证过的工具经验先给她，免得第一次用之前想不起来，评审 M5）、
 * 话题的词对得上（topicScore）。别的场合专属的、隐藏忘掉的、已经常驻的不给。返回 [{id, scoped}]：scoped=false 的是只靠话题对上的
 * （回想里排在「想起来的」那一档，评审 M4）。
 * @param {object} core
 * @param {{settingKey: string, people?: number[], tools?: string[], text?: string|null, focusPerceptId?: number|null, sessionId?: string|null, at?: number, max?: number,
 *          startOfCycle?: boolean}} q
 * @returns {Promise<{id: number, scoped: boolean}[]>}
 */
export async function lessonsFor(core, q) {
  const c = cfgOf(core);
  if (c.enabled === false) return [];
  const rows = currentLessons(core, 300);
  if (!rows.length) return [];
  const at = Number.isFinite(q.at) ? q.at : core.now();
  const now = (q.tools ?? []).map(normTool).filter(Boolean);
  const recent = q.sessionId ? sessionTools(core, q.sessionId, at) : [];
  const people = new Set((q.people ?? []).filter(Number.isInteger));
  const focus = q.text ? new Set(multiTerms(terms(core, q.text))) : null;
  const lterms = new Map(rows.map((r) => [r.id, multiTerms(terms(core, r.text))]));
  let stats = null;
  if (focus?.size) {
    const want = [...new Set([...lterms.values()].flat().filter((t) => focus.has(t)))];
    if (want.length) {
      const all = [...new Set([...lterms.values()].flat())].slice(0, 400);
      // 眼前这句自己不算进统计（不然它的每个词都至少「出现过一次」，命中的词反而权重低）
      const ex = Number.isSafeInteger(q.focusPerceptId) ? { excludePercepts: [q.focusPerceptId] } : undefined;
      try { stats = await core.mods.worker.termStats(core, all, ex); } catch { stats = null; }
    }
  }
  const out = [];
  for (const r of rows) {
    const info = lessonInfo(r);
    if (info.setting && info.setting !== q.settingKey) continue;
    if (info.promotedAt != null && info.status === 'verified' && !info.tainted) continue;   // 已经在常驻区
    let scope = 0;
    if (info.tool && now.some((t) => toolMatches(info.tool, t))) scope += 4;
    else if (info.tool && recent.some((t) => toolMatches(info.tool, t))) scope += 2.5;
    else if (info.tool && q.startOfCycle && info.status === 'verified') scope += 1;
    if (mentionsOf(core, r.id).some((id) => people.has(id))) scope += 2;
    if (info.setting && info.setting === q.settingKey) scope += 1.5;
    const topic = topicScore(lterms.get(r.id) ?? [], focus, stats, c);
    if (scope <= 0 && topic <= 0) continue;
    out.push({ id: r.id, scoped: scope > 0, score: scope + (topic > 0 ? 1 + topic : 0) + (info.status === 'verified' ? 0.3 : 0) + Math.min(0.2, (r.updated_at ?? 0) / 1e14) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, num(q.max, num(c.recallMax, 2)))).map((x) => ({ id: x.id, scoped: x.scoped }));
}

/** 放进常驻区的经验（夜里定的，promotedAt；验证过、没带污点、没隐藏忘掉、现在这一版），最多 promote.max 条。 */
export function promotedLessons(core) {
  const c = cfgOf(core);
  if (c.enabled === false) return [];
  return currentLessons(core).filter((r) => { const i = lessonInfo(r); return i.promotedAt != null && i.status === 'verified' && !i.tainted && !i.setting; })
    .sort((a, b) => lessonInfo(a).promotedAt - lessonInfo(b).promotedAt).slice(0, num(c.promote?.max, 3)).map((r) => r.id);
}

/** 每条经验最近被想起（注入过）的天数（按注入日志，D122 的「用到的程度」同一个来源）。 */
export function lessonUses(core, since) {
  const ids = new Set(currentLessons(core).map((r) => refOf('assertion', r.id)));
  const days = new Map();
  if (!ids.size) return days;
  for (const r of core.store.all('SELECT ts, items_json FROM injections WHERE ts >= ? ORDER BY id DESC LIMIT 5000', since)) {
    for (const it of jsonParse(r.items_json, [])) {
      if (typeof it?.id !== 'string' || !ids.has(it.id)) continue;
      const set = days.get(it.id) ?? new Set();
      set.add(Math.floor(r.ts / DAY));
      days.set(it.id, set);
    }
  }
  return new Map([...days].map(([k, v]) => [k, v.size]));
}

/**
 * 夜里定哪些经验放进常驻区（consolidate 第 11 步调，纯代码）：验证过、没带污点、不限场合、最近 windowDays 天里在 ≥ minDays 天被想起过的，
 * 按想起的天数取前 max 条；已经在里面的只要还验证过就留着（天数相同时先来的优先），超出的、不再验证过的、被隐藏忘掉的拿出来。
 * @returns {{promoted: number, demoted: number}}
 */
export function promoteLessons(core, at = core.now()) {
  const c = cfgOf(core);
  const p = c.promote ?? {};
  const uses = lessonUses(core, at - num(p.windowDays, 30) * DAY);
  const rows = currentLessons(core, 500, { withSuppressed: true })
    .map((r) => ({ r, i: lessonInfo(r), d: uses.get(refOf('assertion', r.id)) ?? 0, hidden: !!suppressedState(core, r.id) }));
  const ok = (x) => x.i.status === 'verified' && !x.i.tainted && !x.i.setting && !x.hidden;
  const pick = rows.filter((x) => ok(x) && (x.i.promotedAt != null || x.d >= num(p.minDays, 3)))
    .sort((a, b) => (b.d - a.d) || ((a.i.promotedAt ?? Infinity) - (b.i.promotedAt ?? Infinity)))
    .slice(0, num(p.max, 3));
  const keep = new Set(pick.map((x) => x.r.id));
  let promoted = 0;
  let demoted = 0;
  core.store.tx(() => {
    for (const x of rows) {
      const want = keep.has(x.r.id);
      if (want && x.i.promotedAt == null) { core.store.run('UPDATE assertions SET value = ?, updated_at = ? WHERE id = ?', valueOf({ ...x.i, promotedAt: at }), at, x.r.id); promoted += 1; }
      else if (!want && x.i.promotedAt != null) { core.store.run('UPDATE assertions SET value = ?, updated_at = ? WHERE id = ?', valueOf({ ...x.i, promotedAt: null }), at, x.r.id); demoted += 1; }
    }
  });
  return { promoted, demoted };
}

/** 经验的统计（管理页、评测用）：现在有几条（隐藏忘掉的不算）、验证过几条、在常驻区几条、工具记录几条。 */
export function lessonStats(core) {
  const rows = currentLessons(core).map(lessonInfo);
  return { total: rows.length, verified: rows.filter((i) => i.status === 'verified').length, promoted: rows.filter((i) => i.promotedAt != null).length,
    toolLog: toolLog(core).length };
}
