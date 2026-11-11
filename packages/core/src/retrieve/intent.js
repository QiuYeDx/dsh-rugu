// 读懂问题（D154，「回忆」的第一步）：把一句问话变成一份很小的「意图」——关于谁、什么时候、在哪儿、要一条还是要一串、几句改写好的线索。
// 三个来源，按有什么用什么，每一项各自取第一个算得出的来源：
//   1. 工具参数（她自己调 memory_recall 时写的 query / about / time / where）——她自己读懂以后写的；
//   2. 预取时改写的结构化结果（retrieve/prefetch.js 的 parseRewrite，后台模型 use='rewrite'）；
//   3. 语言层的确定性部分：人称（对她说的话里「我」是说话人、「你」是她，lang.personView）、时间表达（lang.parseTime）。
// 名字经已有的名字匹配器（entities.nameMatcher）认成实体，时间词交给语言层算成时间窗（模型不算日期），场合的说法交给 lang.placeRef。
// 只产出意图，不改检索（接进回想的流水线是 D155）。同步、不调模型、只读几条小查询；出错不抛，哪一项算不出就空着。
import { nameOf, principalLabelOf } from './names.js';
import { REWRITE_SHAPES } from './prefetch.js';
import { clip, safe, selfId } from './util.js';

const CUE_MAX = 3;
const QUERY_MAX = 200;
/** 场合名字只部分对上（包含关系）时，超过这么多个就算对不上（太泛），不圈。 */
const WHERE_PARTIAL_MAX = 3;
/** 找「私下」那个一对一场合时最多看他说过话的多少个场合。 */
const PRIVATE_SCAN_MAX = 200;

/**
 * @typedef {'tool'|'rewrite'|'lang'|null} IntentSource
 * @typedef {object} Intent
 * @property {number[]} aboutEntityIds                       关于谁（不含她自己）
 * @property {{start: number, end: number}[]} timeWindows     UTC 毫秒；几个窗取并集
 * @property {string[]} settingKeys                          在哪些场合（空 = 不圈场合）
 * @property {'point'|'timeline'|'roster'|'profile'|null} shape
 * @property {string[]} cues                                 1–3 句自足的话（工具的 query 原样在最前）
 * @property {{about: IntentSource, time: IntentSource, where: IntentSource, shape: IntentSource, cues: IntentSource}} from   每一项哪来的（诊断用）
 */

/**
 * 读懂问题（D154，设计「回忆」§3.1）。合并的先后：工具参数 > 改写 > 语言层；每一项各自取第一个算得出东西的来源
 * （例：工具给了 about 但一个人都认不出，就看改写的 about）。shape 只来自改写（语言层不猜）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object|null} cues   buildCues 的结果（用 settingKey、focusSpeaker、directedText、lang、window）
 * @param {{query?: string|null, about?: string|null, time?: string|null, where?: string|null,
 *          rewrite?: import('./prefetch.js').RewriteResult|null}} [given]  工具参数（原样的字符串）和预取改写的结构化结果
 * @returns {Intent}
 */
export function buildIntent(core, cues, given = {}) {
  const out = emptyIntent();
  try {
    const at = core.now();
    const c = cues && typeof cues === 'object' ? cues : {};
    const settingKey = typeof c.settingKey === 'string' && c.settingKey ? c.settingKey : null;
    const lang = typeof c.lang === 'string' ? c.lang : undefined;
    const me = safe(core, 'self', () => selfId(core), null);
    const speaker = Number.isInteger(c.focusSpeaker) && c.focusSpeaker !== me ? c.focusSpeaker : null;
    const g = given && typeof given === 'object' ? given : {};
    const tool = { query: str(g.query), about: str(g.about), time: str(g.time), where: str(g.where) };
    const rw = g.rewrite && typeof g.rewrite === 'object' ? g.rewrite : null;
    const directed = str(c.directedText);
    const ctx = { core, at, settingKey, lang, me, speaker, window: Array.isArray(c.window) ? c.window : [], names: null };

    // ── 语言层：人称换成她的视角（说话人的「我」→ 他的称呼，对她说的「你」→「我」）──
    const label = safe(core, 'principalLabel', () => principalLabelOf(core), null);
    const speakerName = speaker != null ? safe(core, 'speakerName', () => nameOf(core, speaker, { settingKey, principalLabel: label, someone: '' }), '') : '';
    const view = directed && speakerName
      ? safe(core, 'personView', () => core.mods.lang.personView(core, directed, { speaker: speakerName, self: '我', lang }), null)
      : null;

    // ── 关于谁 ──
    const aboutSources = [
      ['tool', () => { const a = entitiesIn(ctx, [tool.about]); return a.length ? a : entitiesIn(ctx, [tool.query]); }],
      ['rewrite', () => entitiesIn(ctx, Array.isArray(rw?.about) ? rw.about : [])],
      ['lang', () => {
        const ids = view?.speaker && speaker != null ? [speaker] : [];
        for (const id of entitiesIn(ctx, [directed])) if (!ids.includes(id)) ids.push(id);
        return ids;
      }],
    ];
    for (const [src, fn] of aboutSources) {
      const ids = safe(core, `about.${src}`, fn, []) ?? [];
      if (ids.length) { out.aboutEntityIds = ids; out.from.about = src; break; }
    }

    // ── 什么时候：时间词都交给语言层算（工具的 time，没有就看她写的 query；改写照抄的；原话）──
    const timeSources = [
      ['tool', () => { const w = windowsOf(ctx, tool.time); return w.length ? w : windowsOf(ctx, tool.query); }],
      ['rewrite', () => windowsOf(ctx, str(rw?.time))],
      ['lang', () => windowsOf(ctx, directed)],
    ];
    for (const [src, fn] of timeSources) {
      const w = safe(core, `time.${src}`, fn, []) ?? [];
      if (w.length) { out.timeWindows = w; out.from.time = src; break; }
    }

    // ── 在哪儿 ──
    for (const [src, text] of [['tool', tool.where], ['rewrite', str(rw?.where)]]) {
      if (!text) continue;
      const keys = safe(core, `where.${src}`, () => settingsFor(ctx, text), []) ?? [];
      if (keys.length) { out.settingKeys = keys; out.from.where = src; break; }
    }

    // ── 要一条还是一串：只来自改写 ──
    if (rw && REWRITE_SHAPES.includes(rw.shape)) { out.shape = rw.shape; out.from.shape = 'rewrite'; }

    // ── 线索：工具的 query 原样在最前；再是改写的；没有改写时用换过人称的那一句 ──
    const list = [];
    const add = (t, src) => {
      const s = clip(str(t).replace(/\s+/gu, ' '), QUERY_MAX);
      if (!s || list.includes(s) || list.length >= CUE_MAX) return;
      list.push(s);
      out.from.cues ??= src;
    };
    if (tool.query) add(tool.query, 'tool');
    const rwCues = Array.isArray(rw?.cues) ? rw.cues.filter((x) => typeof x === 'string' && x.trim()) : [];
    if (rwCues.length) for (const t of rwCues) add(t, 'rewrite');
    else if (directed) add(view?.text || directed, 'lang');
    out.cues = list;
    return out;
  } catch {
    return out;
  }
}

function emptyIntent() {
  return { aboutEntityIds: [], timeWindows: [], settingKeys: [], shape: null, cues: [],
    from: { about: null, time: null, where: null, shape: null, cues: null } };
}
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

/**
 * 几段文字里认得出的人（不含她自己）。先和这段对话里说话人的称呼整句比（改写照对话里的写法写名字），
 * 再交给名字匹配器（同 cues.js：说话人当关系路径的锚，「我表哥」挂在他下面）。
 */
function entitiesIn(ctx, texts) {
  const { core, settingKey, at, me, speaker } = ctx;
  const out = [];
  const push = (id) => { if (Number.isInteger(id) && id !== me && !out.includes(id)) out.push(id); };
  const list = texts.map(str).filter(Boolean);
  if (!list.length) return out;
  const known = speakersByName(ctx);
  const matcher = safe(core, 'nameMatcher', () => core.mods.entities.nameMatcher(core), null);
  for (const t of list) {
    const exact = known.get(norm(t));
    if (exact != null) { push(exact); continue; }
    if (!matcher) continue;
    const hits = safe(core, 'nameScan', () => matcher.scan(t, { settingKey, anchors: speaker != null ? [speaker] : [], at }), []) ?? [];
    const sorted = (Array.isArray(hits) ? hits : []).filter((h) => h && Number.isInteger(h.entityId))
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    for (const h of sorted) push(h.entityId);
  }
  return out;
}

/** 这段对话里说话的人：称呼（窗口里的写法；主人另有她对他的称呼）→ 实体。 */
function speakersByName(ctx) {
  if (ctx.names) return ctx.names;
  const { core, settingKey, me, speaker } = ctx;
  const map = new Map();
  const label = safe(core, 'principalLabel', () => principalLabelOf(core), null);
  const ids = [...new Set([speaker, ...ctx.window.map((w) => w?.speaker)])];
  for (const id of ids) {
    if (!Number.isInteger(id) || id === me) continue;
    for (const pl of [null, label]) {
      const n = safe(core, 'nameOf', () => nameOf(core, id, { settingKey, principalLabel: pl, someone: '' }), '');
      if (n && !map.has(norm(n))) map.set(norm(n), id);
    }
  }
  ctx.names = map;
  return map;
}

/** 一段文字里的时间表达 → 时间窗（语言层现有的解析），去重。 */
function windowsOf(ctx, text) {
  if (!text) return [];
  const reg = ctx.core.mods.lang.registry(ctx.core);
  const out = [];
  const seen = new Set();
  for (const w of reg.parseTime(text, ctx.at, ctx.lang) ?? []) {
    if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start) continue;
    const k = `${w.start}:${w.end}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ start: w.start, end: w.end });
  }
  return out;
}

/**
 * 一个场合的说法 → 场合键。「这里」是当前场合；光说「群里」：当前场合不是一对一就是这里，否则不圈；
 * 「私下」：她和说话人的一对一场合（受众恰好是他们两个，discretion.audienceOf）；别的按场合的名字比
 * （主人起的名字、生效的称呼、适配器给的名字；「一句说法」的称呼不当名字）。对不上就不圈。
 */
function settingsFor(ctx, text) {
  const { core, settingKey, lang, at } = ctx;
  const ref = core.mods.lang.placeRef(core, text, { lang });
  if (ref.kind === 'here') return settingKey ? [settingKey] : [];
  if (ref.kind === 'group') {
    if (!settingKey) return [];
    const a = core.mods.discretion.audienceOf(core, settingKey, at);
    return a?.known && !a.oneOnOne ? [settingKey] : [];
  }
  if (ref.kind === 'private') return privateSettings(ctx);
  return settingsNamed(core, ref.names);
}

/** 她和说话人的一对一场合：他说过话的场合里，受众（名单完整）恰好是她和他的。 */
function privateSettings(ctx) {
  const { core, speaker, me, at } = ctx;
  if (speaker == null) return [];
  const rows = core.store.all(
    'SELECT setting_key AS k FROM percepts WHERE actor_entity_id = ? GROUP BY setting_key ORDER BY MAX(id) DESC LIMIT ?', speaker, PRIVATE_SCAN_MAX);
  const out = [];
  for (const r of rows) {
    const a = safe(core, 'audience', () => core.mods.discretion.audienceOf(core, r.k, at), null);
    if (!a?.known || !a.oneOnOne || a.completeness !== 'exact' || !Array.isArray(a.members)) continue;
    const others = a.members.filter((x) => x !== me);
    if (others.length === 1 && others[0] === speaker) out.push(r.k);
  }
  return out;
}

/** 按名字找场合：整个名字对上的优先；只有包含关系对上的，不超过 WHERE_PARTIAL_MAX 个才算。 */
function settingsNamed(core, names) {
  const wants = [...new Set((names ?? []).map(norm).filter((n) => [...n].length >= 2))];
  if (!wants.length) return [];
  const rows = core.store.all('SELECT key, label, owner_label, adapter_label, label_kind FROM settings');
  const exact = [];
  const partial = [];
  for (const r of rows) {
    const labels = [r.owner_label, ...(r.label_kind === 'description' ? [] : [r.label, r.adapter_label])]
      .map(norm).filter((l) => [...l].length >= 2);
    if (!labels.length) continue;
    if (labels.some((l) => wants.includes(l))) exact.push(r.key);
    else if (labels.some((l) => wants.some((w) => l.includes(w) || w.includes(l)))) partial.push(r.key);
  }
  if (exact.length) return exact;
  return partial.length <= WHERE_PARTIAL_MAX ? partial : [];
}
