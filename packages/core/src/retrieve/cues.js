// 线索（§8.1）：热路径确定性、零 LLM、只读几条 SQL。核心自己从感知库里组装 Situation（评审:AR-03）：
//   窗口（最近 6–10 条，「名字：文字」，≤ 400 字）、在场者（成员能列全时是成员——名单拉到了的，或者场合本身定得出来的（一对一，D132）；
//   否则最近 30 分钟在本场合亲自发过言的人；再加上正在对她说话的人和她自己，评审:PS-13）、被提到的人（@、引用、回复：只是线索，不算在场）、正文里的名字（entities.nameMatcher）、时间表达（lang）、
//   查询文本（1–2 条：窗口一条，最新对她说的那句一条；有意回想的 query 放最前）、「看起来在问过去」的同步部分。
import { charLen, clip, latestPerceptOf, parseJson, rowsByIds, safe, selfId, sha } from './util.js';
import { nameOf } from './names.js';
import { params } from './params.js';

/** 算进窗口的感知种类：有文字、是这个场合里发生的事。 */
export const WINDOW_KINDS = Object.freeze(['utterance', 'action', 'content', 'self-utterance', 'self-action', 'self-thought',
  'on-my-behalf', 'reminder', 'edit']);
/** 「亲自发过言」：本人在这个场合说的、做的（素材的作者、转发内容的原作者不算在场）。 */
const SPEAKING_KINDS = new Set(['utterance', 'action', 'edit', 'self-utterance', 'self-action']);
const DIRECTED = new Set(['to-her', 'mentions-her']);

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, focusPerceptId?: number|null, query?: string|null, about?: string|null, time?: string|null,
 *          extraQueries?: string[]}} s
 * @returns {import('../core-types.js').Cues & {directedText: string|null, focusSpeaker: number|null, aboutEntityIds: number[],
 *          windowText: string, windowPlain: string, rewrites: string[], contentCue: boolean, focusDirected: boolean, focusContent: boolean}}
 */
export function buildCues(core, s) {
  const { recall: rc, x } = params(core);
  const at = core.now();
  const settingKey = s.settingKey;
  const focusPerceptId = Number.isInteger(s.focusPerceptId) ? s.focusPerceptId : null;
  const latestPerceptId = safe(core, 'latest', () => latestPerceptOf(core, settingKey), 0);
  const me = selfId(core);
  const names = new Map();   // 实体 id → 称呼（这一次线索内复用）

  // ── 窗口：最近 6–10 条，≤ 400 字，最新的在最后；遇到很长的空白就停（那之前的是上一次的话题，§10.4 时间间隔）──
  const rows = safe(core, 'window', () => core.mods.intake.recentPercepts(core, settingKey, {
    limit: rc.window.maxMsgs,
    beforeId: focusPerceptId != null ? focusPerceptId + 1 : undefined,
    kinds: WINDOW_KINDS,
  }), []) ?? [];
  const usable = rows.filter((r) => r && typeof r.text === 'string' && r.text.trim() && r.text_state !== 'retracted' && r.text_state !== 'expired')
    .sort((a, b) => a.id - b.id);
  const maxGap = Math.max(0, Number(x.windowMaxGapH) || 0) * 3_600_000;
  if (maxGap > 0) {
    let cut = 0;
    for (let i = usable.length - 1; i > 0; i--) {
      if (Number.isFinite(usable[i].at) && Number.isFinite(usable[i - 1].at) && usable[i].at - usable[i - 1].at >= maxGap) { cut = i; break; }
    }
    if (cut > 0) usable.splice(0, cut);
  }
  // 字数分配：最新的 minMsgs 条一定都在（长的平均截短，短的不截）；还有余量再往前补，补到 maxMsgs 条
  const recent = usable.slice(-rc.window.maxMsgs).reverse().map((r) => {
    const who = r.actor_self ? '我' : nameOf(core, r.actor_entity_id, { settingKey, cache: names, self: '我' });
    const text = r.text.replace(/\s+/g, ' ').trim();
    return { r, who, text, cost: charLen(who) + 1 + charLen(text) };
  });
  const caps = windowCaps(recent.map((l) => l.cost), Math.max(1, rc.window.minMsgs), rc.window.maxChars);
  const window = [];
  const lines = [];
  recent.forEach((l, i) => {
    const cap = caps[i];
    if (!(cap > 0)) return;
    const text = clip(l.text, Math.max(MIN_LINE_TEXT, cap - charLen(l.who) - 1));
    window.unshift({ perceptId: l.r.id, speaker: l.r.actor_self ? me : l.r.actor_entity_id ?? null, at: l.r.at, text });
    lines.unshift(`${l.who}：${text}`);
  });
  const windowText = lines.join('\n');
  const focusRow = focusPerceptId != null ? usable.find((r) => r.id === focusPerceptId) : null;
  const directed = [...usable].reverse().find((r) => !r.actor_self && DIRECTED.has(r.addressed)) ?? null;
  const latest = usable.at(-1) ?? null;
  const focus = focusRow ?? directed ?? latest;
  const directedText = (focusRow && !focusRow.actor_self ? focusRow.text : directed?.text) ?? null;
  const focusSpeaker = focus && !focus.actor_self ? focus.actor_entity_id ?? null : null;
  // 焦点那一句（别人说的）：她正被问的、正在回应的那句话。D149：它里面的名字是内容线索，窗口里更早几行的名字弱一些
  const focusLine = focus && !focus.actor_self ? focus : null;

  // ── 在场者：成员能列全时是成员；否则最近 30 分钟亲自发过言的人；都加上她自己 ──
  const present = new Set();
  const ps = safe(core, 'presence', () => core.store.get(
    'SELECT members_json, completeness FROM presence_sets WHERE setting_key = ? ORDER BY at DESC, id DESC LIMIT 1', settingKey), null);
  // 名单没拉到、但场合本身定得出成员的（一对一：她和唯一在这里说过话的那个人，discretion.audienceOf）：他就是在场的人（D132）。
  // 原来只数「最近 30 分钟在这里说过话的」：隔了一夜她自己开口的一轮，在场的只剩她自己，在场者近况、人物卡、对着他的意图都没有
  const fixed = ps?.completeness === 'exact' ? null
    : safe(core, 'audience', () => { const a = core.mods.discretion.audienceOf(core, settingKey, at); return a?.known && a.completeness === 'exact' && Array.isArray(a.members) ? a.members : null; }, null);
  if (ps?.completeness === 'exact') {
    for (const id of parseJson(ps.members_json, [])) if (Number.isInteger(id)) present.add(id);
  } else if (fixed) {
    for (const id of fixed) if (Number.isInteger(id)) present.add(id);
  } else {
    const since = at - rc.presentSpeakerWindowMin * 60_000;
    const recent = safe(core, 'speakers', () => core.store.all(
      `SELECT actor_entity_id AS e, actor_self AS self, kind, standing, at FROM percepts
        WHERE setting_key = ? ORDER BY id DESC LIMIT 200`, settingKey), []);
    for (const r of recent) {
      if (r.at < since) continue;
      if (!SPEAKING_KINDS.has(r.kind) || r.standing === 'material') continue;
      if (r.e != null) present.add(r.e);
    }
  }
  // 正在对她说话的人当然在场：成员名单可能是一会儿之前拉的（还没刷新），也不靠「最近 30 分钟」碰巧数到他
  // （只算亲自在这里说、做的；内容的作者、转发内容的原作者不算，和上面一样）
  if (focusSpeaker != null && SPEAKING_KINDS.has(focus.kind) && focus.standing !== 'material') present.add(focusSpeaker);
  if (me != null) present.add(me);

  // ── 被提到的人：结构化的 @ / 引用 / 回复（只是线索）──
  const mentioned = new Set();
  const windowIds = window.map((w) => w.perceptId);
  const extra = safe(core, 'mentions', () => rowsByIds(core.store,
    'SELECT id, adapter, mentions_json, quote_json, reply_to_key FROM percepts WHERE id IN (?*)', windowIds), []);
  // D151：@ 的是她（结构化提及里标着她自己；或者同一条消息 @ 了她、另一项的显示名里带着她的名字——她的群名片被认成了别人的时候）。
  // 这样的提及不是线索：不进被提到的人，那个显示名不算正文里的名字，也不算焦点那句的内容
  const selfNames = selfNamesOf(core, me);
  const selfMention = { names: new Set(), ids: new Set() };
  for (const r of extra) {
    const ms = (parseJson(r.mentions_json, []) ?? []).filter((m) => m && typeof m === 'object');
    const toHer = ms.some((m) => m.self === true || (me != null && m.entityId === me));
    for (const m of ms) {
      const shown = mentionNames(m);
      const isSelf = m.self === true || (me != null && m.entityId === me)
        || (toHer && shown.some((n) => selfNames.some((x) => n.includes(x))));
      if (!isSelf) { for (const id of mentionEntityIds(core, m)) mentioned.add(id); continue; }
      for (const n of shown) selfMention.names.add(n);
      if (Number.isInteger(m.entityId) && m.entityId !== me) selfMention.ids.add(m.entityId);
    }
    const q = parseJson(r.quote_json, null);
    if (q) for (const id of mentionEntityIds(core, q.author ?? q)) mentioned.add(id);
    if (r.reply_to_key) {
      const t = safe(core, 'reply', () => core.store.get('SELECT actor_entity_id AS e FROM percepts WHERE adapter = ? AND ext_key = ?',
        r.adapter, r.reply_to_key), null);
      if (t?.e != null) mentioned.add(t.e);
    }
  }
  if (me != null) mentioned.delete(me);

  // ── 正文里的名字（Aho-Corasick，同名的都要）；关系路径：一句话里的「我表哥」挂在这句话的说话人下面（§5.2 第 2 步）──
  const scans = [
    ...[s.query, s.about, ...(s.extraQueries ?? [])].map((t) => ({ text: t, anchors: [], about: t === s.about, focus: true })),
    ...window.map((w) => ({ text: w.text, anchors: w.speaker != null ? [w.speaker] : [], about: false, focus: focusLine != null && w.perceptId === focusLine.id })),
  ].filter((x) => typeof x.text === 'string' && x.text);
  const nameHits = new Map();
  const aboutEntityIds = new Set();
  const matcher = safe(core, 'nameMatcher', () => core.mods.entities.nameMatcher(core), null);
  if (matcher) {
    for (const sc of scans) {
      const hits = safe(core, 'nameScan', () => matcher.scan(sc.text, { settingKey, anchors: sc.anchors, at }), []) ?? [];
      for (const h of Array.isArray(hits) ? hits : []) {
        if (!h || !Number.isInteger(h.entityId)) continue;
        if (selfMention.ids.has(h.entityId) || selfMention.names.has(normName(h.name))) continue;   // @ 她的那个显示名（D151）
        const prev = nameHits.get(h.entityId);
        const focus = !!sc.focus || !!prev?.focus;
        if (!prev || h.score > prev.score) nameHits.set(h.entityId, { entityId: h.entityId, name: h.name, score: Number(h.score) || 0, focus });
        else prev.focus = focus;
        if (sc.about) aboutEntityIds.add(h.entityId);
      }
    }
  }
  const nameList = [...nameHits.values()].sort((a, b) => b.score - a.score || a.entityId - b.entityId).slice(0, 24);

  // ── 语言、时间表达 ──
  const reg = safe(core, 'lang', () => core.mods.lang.registry(core), null);
  const langSample = [s.query, directedText, windowText].find((t) => t) ?? '';
  const lang = (reg && langSample ? safe(core, 'detect', () => reg.detect(langSample), 'und') : 'und') || 'und';
  const timeTexts = [s.time, s.query, directedText ?? latest?.text].filter((t) => typeof t === 'string' && t);
  const timeWindows = [];
  const seenWin = new Set();
  if (reg) {
    for (const t of timeTexts) {
      for (const w of safe(core, 'parseTime', () => reg.parseTime(t, at, lang), []) ?? []) {
        if (!w || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start) continue;
        const k = `${w.start}:${w.end}`;
        if (seenWin.has(k)) continue;
        seenWin.add(k);
        timeWindows.push(w);
      }
    }
  }

  // ── 查询文本：1–2 条（有意回想的 query 在最前）──
  const queryTexts = [];
  const q = [s.query, s.about].filter((t) => typeof t === 'string' && t.trim()).join(' ').trim();
  if (q) queryTexts.push(clip(q, rc.window.maxChars));
  for (const t of s.extraQueries ?? []) if (t && queryTexts.length < 2) queryTexts.push(clip(t, rc.window.maxChars));
  if (windowText && queryTexts.length < 2) queryTexts.push(windowText);
  if (directedText && queryTexts.length < 2 && !queryTexts.includes(directedText)) queryTexts.push(clip(directedText, rc.window.maxChars));

  // ── 「看起来在问过去」的同步部分：时间表达指向过去，或句式像在问（嵌入相似度在 looksLikePast 里补）──
  const cueText = s.query || directedText || '';
  const pastTime = timeWindows.some((w) => w.start < at);
  const qCue = reg && cueText ? Number(safe(core, 'questionCue', () => reg.questionCue(cueText, lang), 0)) || 0 : 0;
  const pastQuestion = pastTime || qCue >= (params(core).x.past.cueMin);

  // ── 焦点那一句（有意回想时是 query）有没有内容（D151）：去掉 @ 她和她自己的名字以后，还有没有不是虚词的词。
  // 「哈喽」「@她 在吗」是打招呼、叫她，不是在说某件事——人听到这种话不会想起哪件具体的事
  const focusText = q || focusLine?.text || '';
  const focusContent = !!focusText && hasContent(core, stripNames(focusText, [...selfMention.names, ...selfNames]), lang);

  const empty = !windowText && !q && !timeWindows.length && !nameList.length;
  const hash = empty ? 'empty' : sha(JSON.stringify([settingKey, windowIds, q, s.time ?? null, (s.extraQueries ?? []).length]));

  return {
    settingKey,
    focusPerceptId,
    latestPerceptId,
    window,
    present: [...present].sort((a, b) => a - b),
    mentioned: [...mentioned].sort((a, b) => a - b),
    names: nameList,
    timeWindows,
    queryTexts,
    lang,
    pastQuestion,
    hash,
    // 以下是 retrieve 内部用的附加字段（Cues 允许多带）
    directedText,
    focusSpeaker,
    aboutEntityIds: [...aboutEntityIds],
    windowText,
    windowPlain: window.map((w) => w.text).join('\n'),   // 不带「名字：」的窗口文字（词法路用：说话人的名字不是话题）
    rewrites: [],
    // D149：这一轮有没有内容线索（有意回想的 query，或者别人说的焦点那一句）；没有的（她自己开口）在场的人就是唯一的线索
    contentCue: !!(q || focusLine),
    // D149：焦点那一句是对她说的（to-her / mentions-her）：被直接问到时，和线索的匹配比「最近」更重要
    focusDirected: !!(focusLine && DIRECTED.has(focusLine.addressed)),
    // D151：焦点那一句（有意回想时是 query）有内容：没有的（寒暄、叫她一声）不放大匹配、不当稠密的主线索
    focusContent,
  };
}

const normName = (n) => String(n ?? '').normalize('NFKC').toLowerCase().trim();

/** 她自己名下的名字（两个字以上；规范化）。 */
function selfNamesOf(core, me) {
  if (me == null) return [];
  const rows = safe(core, 'selfNames', () => core.store.all('SELECT text_raw AS t FROM entity_names WHERE entity_id = ?', me), []) ?? [];
  return [...new Set(rows.map((r) => normName(r.t)).filter((t) => [...t].length >= 2))];
}

/** 一项结构化提及带的显示名（规范化）。 */
function mentionNames(m) {
  const out = [];
  for (const c of [...(Array.isArray(m?.actor?.claims) ? m.actor.claims : []), ...(Array.isArray(m?.claims) ? m.claims : [])]) {
    if (c && typeof c.name === 'string' && c.name.trim()) out.push(normName(c.name));
  }
  if (typeof m?.name === 'string' && m.name.trim()) out.push(normName(m.name));
  return out;
}

/** 把这些名字（连同前面的 @）从文字里去掉，剩下的 @ 也去掉。 */
function stripNames(text, names) {
  let t = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const n of [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(`@${n}`).join(' ').split(n).join(' ');
  return t.replaceAll('@', ' ');
}

const LETTER = /[\p{L}\p{N}]/u;
const CONTENT_SCAN_MAX = 80;   // 再长的一句话不会全是虚词：不逐段问词类
const CONTENT_SPAN_MAX = 6;

/**
 * 一句话里有没有内容（D151）：逐段问语言层的词类（lang.termClass）——分析器认得的整词（名字、别名）算内容；
 * 虚词（代词、疑问词、语气词、叹词、寒暄语……这门语言的封闭词类）盖住它的字；还剩没被盖住的字就是有内容。
 * 词类表在各语言的分析器里，核心不放词表；分析器不给词类的语言（null）一律算有内容。
 */
export function hasContent(core, text, lang) {
  const chars = [...String(text ?? '')];
  if (chars.length > CONTENT_SCAN_MAX) return true;
  const cls = (t) => safe(core, 'termClass', () => core.mods.lang.termClass?.(core, t, { lang }) ?? null, null);
  const covered = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    for (let len = 1; len <= CONTENT_SPAN_MAX && i + len <= chars.length; len++) {
      if (!LETTER.test(chars[i + len - 1])) break;
      const c = cls(chars.slice(i, i + len).join(''));
      if (c === 'word' && len >= 2) return true;
      if (c === 'function') covered.fill(1, i, i + len);
    }
  }
  return chars.some((c, i) => LETTER.test(c) && !covered[i]);
}

const MIN_LINE_TEXT = 8;

/**
 * 窗口每一行能占多少字（从新到旧）。最新的 minMsgs 条按「注水」平分 total：短的照原样，长的截到同一个水位；
 * 都放得下还有余量，再按原样往前补，最后一条放不下就截短（至少留 MIN_LINE_TEXT 字），再往前的不要。返回 0 表示这一行不进窗口。
 * @param {number[]} costs 每行原样的字数（含「名字：」），从新到旧
 * @param {number} minMsgs
 * @param {number} total
 * @returns {number[]}
 */
export function windowCaps(costs, minMsgs, total) {
  const out = new Array(costs.length).fill(0);
  const k = Math.min(costs.length, minMsgs);
  if (!k || total <= 0) return out;
  // 注水：找水位 level，使 Σ min(cost_i, level) = total
  const sorted = costs.slice(0, k).map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c);
  let left = total;
  let level = Infinity;
  for (let j = 0; j < sorted.length; j++) {
    const share = left / (sorted.length - j);
    if (sorted[j].c <= share) { left -= sorted[j].c; continue; }
    level = Math.floor(share);
    break;
  }
  let used = 0;
  for (let i = 0; i < k; i++) { out[i] = Math.min(costs[i], level); used += out[i]; }
  if (level !== Infinity) return out;
  for (let i = k; i < costs.length; i++) {
    const room = total - used;
    if (room <= 0) break;
    if (costs[i] <= room) { out[i] = costs[i]; used += costs[i]; continue; }
    if (room >= MIN_LINE_TEXT + 4) out[i] = room;
    break;
  }
  return out;
}

/**
 * 一个结构化提及（ActorRef 或引用作者）认得出的实体 id。只认两种不需要解析账号的形状：
 * intake 已经认出来的 entityId，或者身份证据的哈希（identity_evidence 精确匹配）。认不出就不算。
 */
function mentionEntityIds(core, m) {
  const out = [];
  if (!m || typeof m !== 'object') return out;
  for (const k of ['entityId', 'entity_id', 'authorEntityId']) if (Number.isInteger(m[k])) out.push(m[k]);
  for (const c of Array.isArray(m.claims) ? m.claims : []) {
    const h = c?.idHash ?? c?.id_hash;
    if (c?.kind !== 'account' || typeof h !== 'string' || typeof c.namespace !== 'string') continue;
    const row = safe(core, 'mentionId', () => core.store.get(
      'SELECT entity_id AS e FROM identity_evidence WHERE namespace = ? AND scope = ? AND id_hash = ?', c.namespace, c.scope ?? '', h), null);
    if (row?.e != null) out.push(row.e);
  }
  return out;
}

/** 线索里「直接认出」的实体：正文里的名字、被提到的人、正在对她说话的人（扇出项用，§6.5）。不含她自己。 */
export function directEntities(cues, me) {
  const out = new Set();
  for (const n of cues.names) out.add(n.entityId);
  for (const e of cues.mentioned) out.add(e);
  if (cues.focusSpeaker != null) out.add(cues.focusSpeaker);
  if (me != null) out.delete(me);
  return out;
}

export const cuesEmpty = (cues) => cues.hash === 'empty';
