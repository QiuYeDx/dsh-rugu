// encode 内部的小工具：参数、时间、文字规范化、来源方式、规范合并。纯函数为主，不碰别的模块的表。
import { defaultAt } from '../config/defaults.js';
import { refOf } from '../store/refs.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ── 参数 ─────────────────────────────────────────────────────────────────
// 数值都在 config/defaults.js（唯一的来源）。用的时候一律 param(core, 'a.b')。
/**
 * 读一个参数（热加载：每次都从 core.config.get() 取）。快照里缺这一项（手搭的测试 core）时用 DEFAULTS 里的值。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} path  'segment.gapMin'
 */
export function param(core, path) {
  let v = core.config.get();
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') return defaultAt(path);
    v = v[k];
  }
  return v ?? defaultAt(path);
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x) => clamp(Number.isFinite(x) ? x : 0, 0, 1);
export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function jsonParse(s, fallback) {
  if (s == null) return fallback;
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}

// ── 时间（库里一律 UTC 毫秒；「今天」「晚上八点」按 config.time.tzOffsetMin 的本地时间算，D19） ──────────
/** 本地时区相对 UTC 的分钟数（东八区 = 480）。 */
export function tzOffsetMin(core, at) {
  const v = core.config.get().time?.tzOffsetMin;
  return isNum(v) ? v : -new Date(at).getTimezoneOffset();
}
/** at 的本地年月日时分（用 UTC 的 getter 读平移后的时间）。 */
export function localParts(core, at) {
  const d = new Date(at + tzOffsetMin(core, at) * MIN);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
}
const p2 = (n) => String(n).padStart(2, '0');
/** 本地日期 'YYYY-MM-DD'（配额、发生次的「哪一天」都按它）。 */
export function localDay(core, at) {
  const t = localParts(core, at);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}`;
}
/** 本地 ISO 周 'YYYY-Www'。 */
export function localWeek(core, at) {
  const t = localParts(core, at);
  const d = new Date(Date.UTC(t.y, t.mo - 1, t.d));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - y0.getTime()) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${p2(week)}`;
}
export function localMonth(core, at) {
  const t = localParts(core, at);
  return `${t.y}-${p2(t.mo)}`;
}
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 提示词里的日期行：'2026-10-31（周六）'。 */
export function fmtDate(core, at) {
  const t = localParts(core, at);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}（${WEEKDAYS[t.wd]}）`;
}
/** 提示词里每条消息的时间：'10-31 20:15'。 */
export function fmtStamp(core, at) {
  const t = localParts(core, at);
  return `${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}`;
}
/** 本地 'YYYY-MM-DDTHH:mm'（给模型看、也是模型写回来的格式）。 */
export function fmtLocalIso(core, at) {
  const t = localParts(core, at);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}T${p2(t.h)}:${p2(t.mi)}`;
}

const LOCAL_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/**
 * 模型写回来的时间 → UTC 毫秒。认：本地 'YYYY-MM-DD[THH:mm[:ss]]'（按本地时区）、带时区的 ISO、毫秒数。认不出返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {unknown} v
 * @param {number} base   用来算时区偏移的参考时刻（感知时间）
 */
export function parseTimeValue(core, v, base) {
  if (v == null || v === '') return null;
  if (isNum(v)) return v > 1e11 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const m = s.match(LOCAL_RE);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
    if (!Number.isFinite(utc)) return null;
    return utc - tzOffsetMin(core, base) * MIN;
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const PRECISIONS = new Set(['exact', 'day', 'week', 'month', 'fuzzy']);
/**
 * 模型给的时间窗 {start, end, precision} → {start, end, precision}（毫秒）。start 认不出返回 null。
 * 只给了日期没给钟点时 precision 默认 day，end 默认这一天结束。
 */
export function parseWindow(core, w, base) {
  if (w == null) return null;
  if (typeof w === 'string' || isNum(w)) w = { start: w };
  if (typeof w !== 'object') return null;
  const start = parseTimeValue(core, w.start ?? w.at, base);
  if (start == null) return null;
  let end = parseTimeValue(core, w.end, base);
  const dateOnly = typeof (w.start ?? w.at) === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(w.start ?? w.at).trim());
  let precision = PRECISIONS.has(w.precision) ? w.precision : (dateOnly ? 'day' : 'exact');
  if (end == null || end < start) end = precision === 'day' || dateOnly ? start + DAY - 1 : start;
  if (precision === 'exact' && end - start > DAY) precision = 'fuzzy';
  return { start, end, precision };
}

// ── 文字 ─────────────────────────────────────────────────────────────────
/** 子串核验用的规范化：NFKC、小写，去掉空白、标点和符号。 */
export function normText(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
/**
 * quote 是不是 text 的子串（规范化后）。允许模型用「…」省略中间的部分：每一段都要按顺序出现。
 * 空的 quote 不算通过。
 */
export function quoteMatches(quote, text) {
  const parts = String(quote ?? '').split(/…+|\.{3,}/).map(normText).filter(Boolean);
  if (!parts.length) return false;
  const hay = normText(text);
  let from = 0;
  for (const p of parts) {
    const i = hay.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}
/** 按码点截断，超了加「…」。 */
export function clip(s, n) {
  const a = [...String(s ?? '')];
  if (a.length <= n) return a.join('');
  return `${a.slice(0, Math.max(0, n - 1)).join('')}…`;
}
/** 成员文字的中和（§7.3，v1:491）：折叠换行、方括号换成全角，免得冒充 [m12]、[U1] 这类编号。 */
export function neutralize(s) {
  return String(s ?? '').replace(/\r?\n+/g, ' / ').replace(/\[/g, '［').replace(/\]/g, '］').replace(/\s{2,}/g, ' ').trim();
}
/** 切句（污点检查按句去掉）。保留句末标点。 */
export function sentences(s) {
  const out = [];
  let cur = '';
  for (const ch of String(s ?? '')) {
    cur += ch;
    if (/[。！？!?；;\n]/.test(ch)) { if (cur.trim()) out.push(cur); cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** 两组词的 Jaccard（对账、复核的相似度退路）。 */
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return n / (A.size + B.size - n);
}
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return null;
  return dot / Math.sqrt(na * nb);
}

// ── 记忆单元 ──────────────────────────────────────────────────────────────
export const mref = (kind, id) => ({ kind, id: Number(id) });
export const rstr = (kind, id) => refOf(kind, Number(id));

/** 计划和事件：每一次是独立的一次（occurrence_key），永远不走「重复」快速路径（评审:SC-01）。 */
export const OCCURRENCE_KINDS = new Set(['plan', 'event']);
export const isOccurrenceKind = (k) => OCCURRENCE_KINDS.has(k);
/** 「稳定类」：t50 很短却标成这些的，核验第 5 条改判（§7.4）。 */
export const STABLE_KINDS = new Set(['preference', 'identity', 'relation']);
/** 计划结案的状态。 */
export const TERMINAL_PLAN = new Set(['done', 'cancelled', 'missed']);
export const PLAN_STATUSES = new Set(['planned', 'in_progress', 'done', 'cancelled', 'missed', 'unknown']);
/** 确定程度的信任排序（§5.4 第 6 条：信任度低的说法不能取代信任度高的）。 */
export const TRUST = Object.freeze({ inferred: 0, hearsay: 1, self_said: 2, stated: 3, confirmed: 4 });
export const CERTAINTIES = new Set(Object.keys(TRUST));
export const SOURCE_MODES = new Set(['told_to_her', 'overheard', 'read', 'observed', 'relayed', 'inferred', 'self_generated', 'imported']);

/**
 * 一条感知是怎么被她知道的（来源方式，§5.3）。由感知的结构字段决定，不信模型自报。
 * @param {object} p percepts 行
 */
export function modeOfPercept(p) {
  if (p.actor_self) return 'self_generated';
  if (p.relay_of) return 'relayed';
  if (p.kind === 'content' || p.standing === 'material') return 'read';
  if (p.kind === 'action' || p.kind === 'presence') return 'observed';
  if (p.addressed === 'to-her' || p.addressed === 'mentions-her') return 'told_to_her';
  return 'overheard';
}

// ── 规范 ─────────────────────────────────────────────────────────────────
const RRANK = { none: 0, soft: 1, strict: 2 };
export const restrictionRank = (r) => RRANK[r] ?? 0;
export const stricterRestriction = (a, b) => (restrictionRank(b) > restrictionRank(a) ? b : (a ?? 'none'));

/**
 * 几份规范合成「最严」的一份（污点、派生、情节取它的事实里最严的）：限制取最严、allow 取交集、deny 取并集、
 * 敏感度取最大、来源公开程度取最小（最私密）、involvesOthers / identityLink 取或。
 * @param {Array<import('../core-types.js').NormInput|null|undefined>} list
 * @returns {import('../core-types.js').NormInput}
 */
export function mergeNorms(list) {
  const norms = list.filter(Boolean);
  const out = { restriction: 'none' };
  let allow = null;
  const deny = new Set();
  let origin = null;
  for (const n of norms) {
    if (restrictionRank(n.restriction) > restrictionRank(out.restriction)) {
      out.restriction = n.restriction;
      if (n.restrictionQuote) out.restrictionQuote = n.restrictionQuote;
    } else if (!out.restrictionQuote && n.restrictionQuote) out.restrictionQuote = n.restrictionQuote;
    if (Array.isArray(n.allow)) allow = allow == null ? [...n.allow] : allow.filter((x) => n.allow.includes(x));
    for (const d of n.deny ?? []) deny.add(d);
    if (isNum(n.sensitivity)) out.sensitivity = Math.max(out.sensitivity ?? 0, n.sensitivity);
    if (n.involvesOthers) out.involvesOthers = true;
    if (n.identityLink) out.identityLink = true;
    if (!out.attribute && n.attribute) out.attribute = n.attribute;
    if (!out.summary && n.summary) out.summary = n.summary;
    const ex = n.originExposure;
    if (ex && (!origin || (ex.exposureRank ?? 3) < (origin.exposureRank ?? 3))) {
      origin = ex;
      if (n.settingRuleRef !== undefined) { out.settingRuleRef = n.settingRuleRef; out.settingRuleVersion = n.settingRuleVersion ?? null; }
    }
    if (out.settingRuleRef === undefined && n.settingRuleRef) { out.settingRuleRef = n.settingRuleRef; out.settingRuleVersion = n.settingRuleVersion ?? null; }
  }
  if (allow) out.allow = allow;
  if (deny.size) out.deny = [...deny];
  if (origin) out.originExposure = origin;
  return out;
}

/** discretion.normOf 的结果 → 可以再写回去的 NormInput（去掉 version / unassessed）。 */
export function normToInput(n) {
  if (!n) return null;
  const { unassessed, version, ...rest } = n;
  if (unassessed) return { ...rest, restriction: stricterRestriction(rest.restriction ?? 'none', 'soft') };
  return rest;
}
