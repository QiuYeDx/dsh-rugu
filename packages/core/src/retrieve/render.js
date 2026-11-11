// 按目标场合渲染一条记忆（§5.3「存储比人精确，表达像人」、§5.4 时态、§6.6 措辞、§8.5 来源说法、F25 绝对时间）。
//   - 来源在写入时就精确记录；「像人」只在措辞上：激活低时「我是听谁说的」说成「好像是听那边谁提过」（来源比内容忘得快）；
//   - 时态由 dynamics.pHold + tense 决定；计划带状态；被取代的旧版本、同类事的哪一次都写明；
//   - share_vague 只用第二段写好的含糊版本，来源也含糊；
//   - 时间按人感觉的写（D148，lang.describeTime）：「今晚 21:39 · 20 分钟前」「昨天晚上 22:14」「周日（11/8）下午」，不让她自己和「现在」做减法。
//     会冻结一段时间的文字（常驻区）传 timeStyle 'day'，不带「多久以前」；钟点和日子照样写着，留在会话里也认得出是什么时候（F25）；
//   - 文字过 intake.sanitizeForPrompt，整条 ≤ itemChars。
// 渲染出来的文字是给她自己看的（注入块整体对她说，§10.4），所以她自己写成「你」；provenance 是不带人称的短说法。
import { charLen, clip, parseJson, safe } from './util.js';
import { parseRef } from '../store/refs.js';
import { nameOf, principalLabelOf } from './names.js';
import { params } from './params.js';

/** 措辞模板（按 selfProfile.locale 选，没有的语言用 zh）。只是输出的说法，不参与任何判断。 */
const PHRASES = {
  zh: {
    you: '你', someone: '某人', here: '在这里', inPlace: (l) => `在「${l}」`, inDescribed: (l) => `在${l}里`,
    selfSaid: (w) => `你自己${w}说的`, selfDid: (w) => `你自己${w}做的`, selfThought: '你心里想过的', guess: '你自己的猜测，没人说过',
    toldYou: (s, w) => `${s}${w}跟你说的`, ownWords: (s, w) => `${s}${w}自己说的`, heard: (s, w) => `听${s}${w}说的`,
    heardVia: (s, w, a) => `听${s}${w}说的（最初是${a}说的）`, overheard: (s, w) => `${w}听到${s}说的`,
    read: (w) => `${w}看到的`, readFrom: (s, w) => `${w}看到${s}发的`, observed: (w) => `${w}亲眼看到的`,
    relayed: '转过来的消息里看到的', imported: '以前记下来的', vagueSource: '听人说的', vagueHeard: (w) => (w ? `好像是${w}听谁提过` : '好像听谁提过'),
    others: (n) => `，还有${n}个人也提过`,
    experienced: (w) => `你${w}经历的`, summary: '你自己记下的小结', diary: '你的日记', lapse: '你自己的经历',
    impressionShared: '大家都看得到的那些事攒下的印象', impressionPrivate: '私下了解到的印象', mostlyHearsay: '，多半是听别人说的',
    intention: '你自己想着要做的', storyline: (w) => `${w}最近在聊的`, community: '大家最近在聊的', known: '你认识的',
    maybe: '好像', faint: '（印象很模糊，别主动提）',
    stillTrue: '（现在大概还是这样）', uncertain: '（当时是这样，现在不知道了）', past: '（是那时候的事了）',
    changedUnknown: '（听说后来变了，变成什么不清楚）',
    plan: { planned: '（还没听说结果）', plannedDue: '（到时候了，还没听说结果）', in_progress: '（正在做）', done: '（后来做完了）',
      cancelled: '（后来取消了）', missed: '（后来没做成）', unknown: '（后来怎么样没听说）' },
    superseded: '（后来有了新的说法）', before: '之前', after: '，后来', olderOccurrence: '（这是更早的一次）',
    ambiguous: '（这类事有好几次，时间挨得近，可能指别的那次）',
    fok: '和这有关的事，但想不起细节了', fokFrom: (s, w) => `好像听${s}${w}提过`, retracted: (s) => `${s}发过一条消息，后来撤回了`, said: (s, t) => `${s}：「${t}」`,
    blank: (span, here) => `${here ? '在这里，' : ''}${span}有些事你记不太清了：好像有点印象，细节想不起来`,
    blankDay: (d) => `${d} 那天`, blankDays: (a, b) => `${a}–${b} 那几天`, blankSource: '记不太清',
    relation: (a, r) => `${a}的${r}`, sep: '，',
    inPrivate: '私聊时', inOtherGroup: '在另一个群里',
    limitTag: (s, q) => (q ? `（${s}叮嘱过别外传：「${q}」）` : `（${s}叮嘱过别外传）`),
  },
  en: {
    you: 'you', someone: 'someone', here: 'here', inPlace: (l) => `in "${l}"`, inDescribed: (l) => `in ${l}`,
    selfSaid: (w) => `you said it yourself ${w}`.trim(), selfDid: (w) => `you did it yourself ${w}`.trim(), selfThought: 'your own thought',
    guess: 'your own guess; nobody said it',
    toldYou: (s, w) => `${s} told you ${w}`.trim(), ownWords: (s, w) => `${s} said so ${w}`.trim(), heard: (s, w) => `heard from ${s} ${w}`.trim(),
    heardVia: (s, w, a) => `heard from ${s} ${w} (originally from ${a})`.replace('  ', ' '), overheard: (s, w) => `overheard ${s} ${w}`.trim(),
    read: (w) => `read ${w}`.trim(), readFrom: (s, w) => `saw ${s}'s post ${w}`.trim(), observed: (w) => `saw it ${w}`.trim(),
    relayed: 'from a relayed message', imported: 'from old records', vagueSource: 'heard it somewhere', vagueHeard: (w) => `heard someone mention it ${w}`.trim(),
    others: (n) => `; ${n} others mentioned it too`,
    experienced: (w) => `you were there ${w}`.trim(), summary: 'your own note', diary: 'your diary', lapse: 'your own experience',
    impressionShared: 'impression from what everyone could see', impressionPrivate: 'impression from private talks', mostlyHearsay: ', mostly hearsay',
    intention: 'something you mean to do', storyline: (w) => `what people have been talking about ${w}`.trim(), community: 'recent topics', known: 'someone you know',
    maybe: 'maybe ', faint: ' (very faint; do not bring it up)',
    stillTrue: ' (probably still true)', uncertain: ' (true back then; not sure now)', past: ' (that was in the past)',
    changedUnknown: ' (heard it changed later; not sure to what)',
    plan: { planned: ' (no news yet)', plannedDue: ' (it is due; no news yet)', in_progress: ' (in progress)', done: ' (done later)',
      cancelled: ' (cancelled later)', missed: ' (did not happen)', unknown: ' (never heard how it went)' },
    superseded: ' (later replaced by a newer account)', before: 'before: ', after: '; later: ', olderOccurrence: ' (an earlier occurrence)',
    ambiguous: ' (this happened several times close together; it may mean another one)',
    fok: 'something related, but cannot recall the details', fokFrom: (s, w) => `maybe heard ${s} mention ${w}`.trim() + ' ', retracted: (s) => `${s} posted something and then retracted it`, said: (s, t) => `${s}: "${t}"`,
    blank: (span, here) => `some things from ${span}${here ? ' here' : ''} are hazy: a vague impression, no details`,
    blankDay: (d) => d, blankDays: (a, b) => `${a}–${b}`, blankSource: 'hazy',
    relation: (a, r) => `${a}'s ${r}`, sep: ', ',
    inPrivate: 'in a private chat', inOtherGroup: 'in another group',
    limitTag: (s, q) => (q ? ` (${s} asked you not to pass it on: "${q}")` : ` (${s} asked you not to pass it on)`),
  },
};
export function phrasesFor(core) {
  const loc = String(core.ports.selfProfile?.locale ?? 'zh').toLowerCase().split(/[-_]/)[0];
  return PHRASES[loc] ?? PHRASES.zh;
}

/**
 * 绝对时间（F25；D148 起只是 lang.describeTime 不可用时的退路）：本地时区按 config.time.tzOffsetMin（null = 本机）。
 * 同一年写「10/31 20:15」，跨年带年份；dateOnly 只写日期。
 * @param {number} ms @param {number|null} tzOffsetMin @param {number} now @param {boolean} [dateOnly]
 */
export function formatTime(ms, tzOffsetMin, now, dateOnly = false) {
  if (!Number.isFinite(ms)) return '';
  const off = tzOffsetMin ?? -new Date(ms).getTimezoneOffset();
  const d = new Date(ms + off * 60_000);
  const n = new Date(now + off * 60_000);
  const date = d.getUTCFullYear() === n.getUTCFullYear()
    ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (dateOnly) return date;
  return `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 时间说法（D148）：lang.describeTime（style：full / day / date）；不可用时退回绝对时间。 */
function whenOf(core, ms, at, style, tzOffsetMin) {
  if (!Number.isFinite(ms)) return '';
  const s = safe(core, 'describeTime', () => core.mods.lang.describeTime(core, ms, { now: at, style }), '');
  return typeof s === 'string' && s ? s : formatTime(ms, tzOffsetMin, at, style === 'date');
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').ScoredCandidate & {fok?: boolean, occurrence?: object, meta?: object}} c
 * @param {{verdict: 'share'|'share_vague', vagueText?: string|null, at: number, itemChars: number, settingKey?: string|null,
 *          previous?: {candidate: object, verdict: 'share'|'share_vague', vagueText?: string|null}|null,
 *          label?: {limit?: {quote: string|null, by: number|null}|null}|null}} opt
 *        label（D113）：关口①在非公开目标上原文放进来的条目带的来源标签——说不出名字的别处来源按结构写，核对过原话的叮嘱写在后面
 *        timeStyle【补】（D148）：时间的写法，'full'（缺省：几个小时以内带「多久以前」）/ 'day'（不带「多久以前」：常驻区这种会冻结一段时间的文字用）
 *        excerpt【补】（D155）：几句线索（回忆这条路才给）；正文放不下时截和它们最对得上的那一段（focusOn），不是从头截
 * @returns {{rendered: string, provenance: string, confidence: number}}
 */
export function render(core, c, opt) {
  const none = { rendered: '', provenance: '', confidence: 0 };
  try {
    const { x, tzOffsetMin } = params(core);
    const L = phrasesFor(core);
    const at = Number.isFinite(opt?.at) ? opt.at : core.now();
    const timeStyle = opt?.timeStyle === 'day' ? 'day' : 'full';
    const max = Number.isFinite(opt?.itemChars) && opt.itemChars > 0 ? opt.itemChars : core.config.get().recall.involuntary.itemChars;
    const target = opt?.settingKey ?? null;
    const san = (t) => safe(core, 'sanitize', () => core.mods.intake.sanitizeForPrompt(core, String(t ?? '')), String(t ?? '').replace(/\s+/g, ' '));
    // 只有「能说」「说个大概」两种结论才有文字；别的（aware_private / omit / pending / 没给）一律不给内容（fail closed，§9.3.4）
    if (opt?.verdict !== 'share' && opt?.verdict !== 'share_vague') return none;
    const mref = c?.mref ?? (typeof c?.ref === 'string' ? parseRef(c.ref) : null);
    if (!mref) return none;
    const m = load(core, mref);
    if (!m) return none;
    const names = new Map();
    const pl = principalLabelOf(core);
    const who = (id) => san(nameOf(core, id, { settingKey: target, cache: names, self: L.you, someone: L.someone, principalLabel: pl }));
    const where = (key) => {
      if (!key) return '';
      if (target && key === target) return L.here;
      // 别的场合的名字也是记忆（场合的档案卡，§5.8）：调用方给了判定时，只有那张卡在目标这里过了关口①才写名字，否则不写在哪儿
      if (typeof opt?.placeAllowed === 'function' && !safe(core, 'placeAllowed', () => !!opt.placeAllowed(key), false)) {
        // 说不出名字：非公开目标上原文放进来的（opt.label，D113）按结构写「私聊时 / 在另一个群里」——她得知道这是私下说的还是当着一群人说的；
        // 不含场合的名字。别的照旧不写在哪儿
        if (!opt?.label) return '';
        const rank = safe(core, 'audienceOf', () => core.mods.discretion.audienceOf(core, key, at)?.exposureRank ?? null, null);
        return rank === 0 ? L.inPrivate : rank == null ? '' : L.inOtherGroup;
      }
      // 【D111】称呼只是一句说法（适配器不知道名字）时写成「在一个 QQ 群里」；名字照旧「在 X」
      const s = safe(core, 'settingLabel', () => core.mods.intake.settingByKey(core, key), null);
      // 称呼过 labelForPrompt：截到 20 字、去掉名字里自带的引号（群名是群里的人起的，评审）；名字加引号，和工作记忆一个写法
      const label = s?.label
        ? safe(core, 'placeLabel', () => core.mods.intake.labelForPrompt(core, s.label, 20), null) ?? [...san(s.label).replace(/[「」『』“”"]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 20).join('')
        : '';
      return label ? (s.labelKind === 'description' ? L.inDescribed(label) : L.inPlace(label)) : '';
    };
    const P = Number.isFinite(c.P) ? c.P : 1;

    // ── 补不回的空白（§12.4.5 第 8 步）：只写那几天有些事记不清（那几天别的事可能照常记得），像人记不清一样；
    //    锚点那条的内容（含糊版本也一样）不给，也不提「恢复」 ──
    if (c.fok && c.blank && Number.isFinite(c.blank.from) && Number.isFinite(c.blank.to)) {
      const a = whenOf(core, c.blank.from, at, 'date', tzOffsetMin);
      const b = whenOf(core, c.blank.to, at, 'date', tzOffsetMin);
      const span = a === b ? L.blankDay(a) : L.blankDays(a, b);
      const here = target ? c.blank.settingKey === target : !!c.blank.here;
      return { rendered: clip(`（${L.blank(span, here)}）`, max), provenance: L.blankSource, confidence: round2(Math.min(P, m.confidence)) };
    }

    // ── 说个大概：只用第二段写好的含糊版本，来源也含糊，只写日期 ──
    if (opt?.verdict === 'share_vague') {
      const vague = san(opt.vagueText ?? '').trim();
      if (!vague) return { ...none, provenance: L.vagueSource };
      const date = whenOf(core, m.time, at, 'date', tzOffsetMin);
      const prefix = `（${[date, L.vagueSource].filter(Boolean).join(L.sep)}）`;
      return { rendered: fit(prefix, vague, '', max), provenance: L.vagueSource, confidence: round2(Math.min(P, m.confidence)) };
    }

    // ── 来源说法 ──
    const vagueSrc = P < x.render.sourceVagueBelowP;
    const prov = provenanceOf(core, m, { L, who, where, vagueSrc });
    // 关于的人只是「可能是同一个人」（maybe_same，§5.2 信念层）：把握不超过那条链接的置信度，而且一定带「好像」
    const maybeSame = c.belief?.rel === 'maybe_same';
    const sure = Math.min(P, m.confidence, maybeSame && Number.isFinite(c.belief.confidence) ? c.belief.confidence : 1);

    // ── 知道感：只说想不起细节，不给内容 ──
    if (c.fok) {
      const speaker = m.kind === 'percept' ? (m.row.actor_self ? null : m.row.actor_entity_id) : m.sources[0]?.speaker ?? null;
      let src;
      if (m.selfOwned) src = `${L.maybe}${prov.text}${L.sep}`;
      else if (speaker != null && !isSelf(core, speaker)) src = L.fokFrom(who(speaker), prov.whereText);
      else src = L.vagueHeard(prov.whereText);
      return { rendered: clip(`（${src}${L.fok}）`, max), provenance: src, confidence: round2(sure) };
    }

    // ── 内容 ──
    let content = san(contentOf(core, m, { L, who }));
    if (!content) return { ...none, provenance: prov.text };
    if (opt?.previous && opt.previous.candidate?.mref) {
      const pm = load(core, opt.previous.candidate.mref);
      const prevText = opt.previous.verdict === 'share_vague' ? san(opt.previous.vagueText ?? '') : pm ? san(contentOf(core, pm, { L, who })) : '';
      if (prevText) content = `${L.before}${prevText}${L.after}${content}`;
    }
    let notes = notesOf(core, m, c, { L, at, previous: !!opt?.previous, tzOffsetMin, timeStyle });
    // 核对过原话的叮嘱（D113：非公开目标上原文放进来的条目带着它，和工作记忆同一个标签；说不说由她看着标签判断，外发守护只挡原样复述）
    const lim = opt?.label?.limit;
    if (lim) notes = `${L.limitTag(lim.by != null ? who(lim.by) : L.someone, lim.quote ? clip(san(lim.quote), 40) : '')}${notes}`;
    let hedge = '';
    let faint = '';
    if (sure < x.render.hedgeAbove) { hedge = L.maybe; faint = L.faint; } else if (sure <= x.render.sureAbove || maybeSame) hedge = L.maybe;
    const time = m.time != null ? whenOf(core, m.time, at, timeStyle, tzOffsetMin) : '';
    const prefix = `（${[time, prov.text].filter(Boolean).join(L.sep)}）${hedge}`;
    // 对着问题截取（D155，只在回忆这条路上给 excerpt）：放不下时截和问题最对得上的那一段，不是从头截
    if (Array.isArray(opt?.excerpt) && opt.excerpt.length) {
      const room = max - charLen(prefix) - charLen(`${notes}${faint}`);
      content = focusOn(core, content, room >= 4 ? room : max - charLen(prefix), opt.excerpt);
    }
    return { rendered: fit(prefix, content, `${notes}${faint}`, max), provenance: prov.text, confidence: round2(sure) };
  } catch (e) {
    safe(core, 'render', () => { throw e; }, null);
    return none;
  }
}

const round2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

/**
 * 对着问题截取（D155）：文字放不下 room 个字时，取和问题（几句线索）的词对得上最多的那一段——词按 lang.queryTerms 挑（实体词元不算），
 * 每个词只算一次、按字数加权（单字算半个）；一段从对上的那个词往前带 room 的 FOCUS_LEAD 作上文。最好的一段就是开头时照旧从头截；
 * 不是开头时前面加「…」，后面还有字也加「…」，整段 ≤ room。一个词都对不上也从头截。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} text
 * @param {number} room
 * @param {string[]} cues
 * @returns {string}
 */
export function focusOn(core, text, room, cues) {
  const chars = Array.from(String(text ?? ''));
  if (!(room >= 8) || chars.length <= room) return String(text ?? '');
  const terms = new Map();
  for (const q of cues) {
    if (typeof q !== 'string' || !q.trim()) continue;
    for (const t of safe(core, 'focusTerms', () => core.mods.lang.queryTerms(core, q) ?? [], []) ?? []) {
      const n = String(t).normalize('NFKC').toLowerCase();
      if (!n || /^ent_\d+$/u.test(n)) continue;
      const len = Array.from(n).length;
      terms.set(n, len === 1 ? 0.5 : len);
    }
  }
  if (!terms.size) return chars.slice(0, room).join('');
  const low = chars.map((c) => { const l = c.toLowerCase(); return Array.from(l).length === 1 ? l : c; });
  const lowText = low.join('');
  // 每个词出现在第几个字（按码点数）
  const hits = [];
  for (const [t, w] of terms) {
    let from = 0;
    for (;;) {
      const i = lowText.indexOf(t, from);
      if (i < 0) break;
      hits.push({ at: Array.from(lowText.slice(0, i)).length, t, w, len: Array.from(t).length });
      from = i + t.length;
    }
  }
  if (!hits.length) return chars.slice(0, room).join('');
  const lead = Math.floor(room * FOCUS_LEAD);
  const scoreOf = (s) => {
    const got = new Map();
    for (const h of hits) if (h.at >= s && h.at + h.len <= s + room) got.set(h.t, h.w);
    let n = 0;
    for (const w of got.values()) n += w;
    return n;
  };
  let best = 0;
  let bestScore = scoreOf(0);
  for (const h of hits) {
    const s = Math.max(0, Math.min(chars.length - room, h.at - lead));
    const sc = scoreOf(s);
    if (sc > bestScore || (sc === bestScore && s < best)) { best = s; bestScore = sc; }
  }
  if (best === 0) return chars.slice(0, room).join('');
  const head = '…';
  const end = best + room - 1;
  const tail = end < chars.length ? '…' : '';
  return `${head}${chars.slice(best + 1, best + room - (tail ? 1 : 0)).join('')}${tail}`;
}
/** 对着问题截取时，对上的词前面带多少上文（占这一条字数的比例）。 */
const FOCUS_LEAD = 0.25;

/** prefix + content + suffix ≤ max：先截内容，还放不下就丢后缀，最后整条截断。 */
function fit(prefix, content, suffix, max) {
  const room = max - charLen(prefix) - charLen(suffix);
  if (room >= 4) return `${prefix}${clip(content, room)}${suffix}`;
  const room2 = max - charLen(prefix);
  if (room2 >= 4) return `${prefix}${clip(content, room2)}`;
  return clip(`${prefix}${content}`, max);
}

/** 渲染要的东西：主表行 + 来源。 */
function load(core, mref) {
  const st = core.store;
  const one = (sql, id) => safe(core, 'renderRow', () => st.get(sql, id), null);
  const sourcesOf = (kind, id) => safe(core, 'renderSources', () => st.all(
    'SELECT speaker, asserter, mode, hop, perceived_in, confidence, at FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY hop, confidence DESC, at',
    kind, id), []) ?? [];
  switch (mref.kind) {
    case 'assertion': {
      const r = one('SELECT * FROM assertions WHERE id = ?', mref.id);
      if (!r) return null;
      const subjects = (safe(core, 'subjects', () => st.all("SELECT entity_id AS e FROM assertion_entities WHERE assertion_id = ? AND role = 'subject'", r.id), []) ?? []).map((x) => x.e);
      const sources = sourcesOf('assertion', r.id);
      return { kind: 'assertion', row: r, subjects, sources, time: sources[0]?.at ?? r.recorded_at, confidence: clampConf(r.confidence) };
    }
    case 'episode': {
      const r = one('SELECT * FROM episodes WHERE id = ?', mref.id);
      if (!r) return null;
      const sources = sourcesOf('episode', r.id);
      const selfOwned = ['summary', 'diary', 'lapse'].includes(r.ep_kind);
      return { kind: 'episode', row: r, subjects: [], sources, time: r.t_start, confidence: sources.length ? clampConf(Math.max(...sources.map((s) => s.confidence ?? 0.8))) : 0.9, selfOwned };
    }
    case 'percept': {
      const r = one('SELECT id, setting_key, perceived_in, at, actor_entity_id, actor_self, kind, text, text_state, addressed, standing, visible_to, media_json FROM percepts WHERE id = ?', mref.id);
      if (!r) return null;
      // 她看过的媒体（D116）：文字带上她看到的（原文到期以后只剩她看到的那一句）
      if (r.media_json && r.text_state !== 'retracted') {
        const seen = core.mods.intake.seenMedia(core, r.media_json);
        if (seen) r.text = core.mods.intake.mediaText(core, r.text, r.media_json, { who: '你' });
      }
      return { kind: 'percept', row: r, subjects: [], sources: [], time: r.at, confidence: 1, selfOwned: !!r.actor_self };
    }
    case 'window': {
      const r = one('SELECT * FROM raw_windows WHERE id = ?', mref.id);
      if (!r) return null;
      return { kind: 'window', row: r, subjects: [], sources: [], time: r.t_start, confidence: 1 };
    }
    case 'entity': {
      const r = one('SELECT id, kind, display_name, is_self FROM entities WHERE id = ?', mref.id);
      if (!r) return null;
      return { kind: 'entity', row: r, subjects: [r.id], sources: [], time: null, confidence: 1, selfOwned: true };
    }
    case 'impression': {
      const r = one('SELECT * FROM entity_impressions WHERE id = ?', mref.id);
      if (!r) return null;
      return { kind: 'impression', row: r, subjects: [r.entity_id], sources: [], time: null, confidence: 0.8, selfOwned: true };
    }
    case 'intention': {
      const r = one('SELECT * FROM intentions WHERE id = ?', mref.id);
      if (!r) return null;
      return { kind: 'intention', row: r, subjects: [], sources: [], time: null, confidence: 1, selfOwned: true };
    }
    case 'storyline': {
      const r = one('SELECT * FROM storylines WHERE id = ?', mref.id);
      if (!r) return null;
      return { kind: 'storyline', row: r, subjects: [], sources: [], time: null, confidence: 0.9, selfOwned: true };
    }
    case 'community': {
      const r = one('SELECT * FROM communities WHERE id = ?', mref.id);
      if (!r) return null;
      return { kind: 'community', row: r, subjects: [], sources: [], time: null, confidence: 0.8, selfOwned: true };
    }
    default:
      return null;   // 身份链接（link）不渲染成文字：它本身就是 B3 级的隐私记忆，人物卡由 context 组
  }
}
const clampConf = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

/**
 * 来源说法（§5.3、§8.5「他自己说的 / 听阿明说 / 我猜」）。只依据精确记录的来源；vagueSrc（激活低）时只说在哪听谁提过。
 * @returns {{text: string, whereText: string}}
 */
function provenanceOf(core, m, { L, who, where, vagueSrc }) {
  const r = m.row;
  if (m.kind === 'percept') {
    const w = where(r.perceived_in ?? r.setting_key);
    if (r.actor_self) {
      if (r.kind === 'self-thought') return { text: L.selfThought, whereText: w };
      return { text: r.kind === 'self-action' ? L.selfDid(w) : L.selfSaid(w), whereText: w };
    }
    if (vagueSrc) return { text: L.vagueHeard(w), whereText: w };
    const s = who(r.actor_entity_id);
    if (r.standing === 'material' || r.kind === 'content') return { text: L.readFrom(s, w), whereText: w };
    if (r.addressed === 'to-her' || r.addressed === 'mentions-her') return { text: L.toldYou(s, w), whereText: w };
    return { text: L.overheard(s, w), whereText: w };
  }
  if (m.kind === 'window') {
    const w = where(r.setting_key);
    return { text: L.read(w), whereText: w };
  }
  if (m.kind === 'impression') return { text: (r.layer === 'private' ? L.impressionPrivate : L.impressionShared) + (r.hearsay > r.first_hand ? L.mostlyHearsay : ''), whereText: '' };
  if (m.kind === 'intention') return { text: L.intention, whereText: '' };
  if (m.kind === 'storyline') { const w = where(r.setting_key); return { text: L.storyline(w), whereText: w }; }
  if (m.kind === 'community') return { text: L.community, whereText: '' };
  if (m.kind === 'entity') return { text: L.known, whereText: '' };
  if (m.kind === 'episode') {
    const w = where(r.setting_key);
    if (r.ep_kind === 'summary') return { text: L.summary, whereText: w };
    if (r.ep_kind === 'diary') return { text: L.diary, whereText: w };
    if (r.ep_kind === 'lapse') return { text: L.lapse, whereText: w };
    if (r.ep_kind === 'import' || m.sources.every((s) => s.mode === 'imported') && m.sources.length) return { text: L.imported, whereText: w };
    if (m.sources.length && m.sources.every((s) => s.mode === 'read')) return { text: L.read(w), whereText: w };
    return { text: L.experienced(w), whereText: w };
  }
  // 事实
  const src = m.sources[0] ?? null;
  const w = where(src?.perceived_in ?? null);
  if (r.certainty === 'inferred' || src?.mode === 'inferred') return { text: L.guess, whereText: w };
  if (!src) return { text: L.imported, whereText: w };
  const me = isSelf(core, src.speaker);
  if (src.mode === 'self_generated' || r.certainty === 'self_said' || me) return { text: L.selfSaid(w), whereText: w };
  if (src.mode === 'imported') return { text: L.imported, whereText: w };
  if (src.mode === 'relayed') return { text: L.relayed, whereText: w };
  if (vagueSrc) return { text: L.vagueHeard(w), whereText: w };
  const s = who(src.speaker);
  let text;
  if (src.mode === 'read') text = src.speaker != null ? L.readFrom(s, w) : L.read(w);
  else if (src.mode === 'observed') text = L.observed(w);
  else if ((src.hop ?? 0) === 0 && src.speaker != null && m.subjects.includes(src.speaker)) text = L.ownWords(s, w);
  else if ((src.hop ?? 0) >= 1 && src.asserter != null && src.asserter !== src.speaker) text = L.heardVia(s, w, who(src.asserter));
  else if (src.mode === 'told_to_her') text = (src.hop ?? 0) >= 1 || r.certainty === 'hearsay' ? L.heard(s, w) : L.toldYou(s, w);
  else if (src.mode === 'overheard') text = L.overheard(s, w);
  else text = L.heard(s, w);
  const others = new Set(m.sources.map((x) => x.speaker).filter((x) => x != null && x !== src.speaker)).size;
  if (others > 0) text += L.others(others);
  return { text, whereText: w };
}
function isSelf(core, id) {
  if (id == null) return false;
  return !!safe(core, 'isSelf', () => core.store.get('SELECT is_self FROM entities WHERE id = ?', id)?.is_self, 0);
}

/** 记忆本身的文字。 */
function contentOf(core, m, { L, who }) {
  const r = m.row;
  switch (m.kind) {
    case 'assertion': return r.text ?? '';
    case 'episode': return r.narrative || r.header || r.title || '';
    case 'percept':
      if (r.text_state === 'retracted') return L.retracted(r.actor_self ? L.you : who(r.actor_entity_id));   // 撤回的原话不再展示（§5.6）
      if (!r.text) return '';
      return r.actor_self ? r.text : L.said(who(r.actor_entity_id), r.text);
    case 'window': return r.text ?? '';
    case 'entity': {
      const name = who(r.id);
      const prof = safe(core, 'profile', () => core.mods.entities.profile(core, r.id), null);
      const d = (prof?.descriptors ?? []).slice(0, 2).map((x) => L.relation(who(x.anchor), x.text || x.relation)).filter((t) => t && t !== name);
      return [name, ...d].join(L.sep);
    }
    case 'impression': return r.text ? `${who(r.entity_id)}：${r.text}` : '';
    case 'intention': return r.text ?? '';
    case 'storyline': return r.text ?? '';
    case 'community': return [r.label, r.summary].filter(Boolean).join('：');
    default: return '';
  }
}

/** 时态、计划状态（变到这个状态是什么时候）、版本、哪一次（§5.4、§5.5、§8.3 第 6 步）。 */
function notesOf(core, m, c, { L, at, previous, tzOffsetMin, timeStyle = 'full' }) {
  let out = '';
  if (m.kind === 'assertion') {
    const r = m.row;
    if (r.plan_status && L.plan[r.plan_status]) {
      let k = r.plan_status;
      let note = '';
      if (k === 'planned') {
        const pt = parseJson(r.planned_time_json, null);
        const due = [r.event_end, pt?.end, r.event_start, pt?.start, pt?.at].find((v) => Number.isFinite(v));
        if (Number.isFinite(due) && due < at) k = 'plannedDue';
        note = L.plan[k];
      } else if (k === 'unknown') {
        note = L.plan[k];   // 「没听说结果」的时间是维护任务标的，不是事情的时间，不写
      } else {
        // 「拿了，那天晚上说拿到的」（S1）：结案的时间来自状态历史（证据消息的时间）
        const h = safe(core, 'planHistory', () => core.store.get(
          'SELECT at FROM plan_status_history WHERE assertion_id = ? AND status = ? ORDER BY at DESC, id DESC LIMIT 1', r.id, k), null);
        note = L.plan[k];
        if (Number.isFinite(h?.at)) note = withTime(note, whenOf(core, h.at, at, timeStyle, tzOffsetMin), L.sep);
      }
      out += note;
    } else if (r.change_known) {
      out += L.changedUnknown;
    } else {
      const timeBound = r.t50_h != null || r.valid_to_known != null;
      if (timeBound) {
        const p = safe(core, 'pHold', () => core.mods.dynamics.pHold(core, r, at), null);
        const tense = Number.isFinite(p) ? safe(core, 'tense', () => core.mods.dynamics.tense(core, p), null) : null;
        if (tense === 'present') out += L.stillTrue;
        else if (tense === 'uncertain') out += L.uncertain;
        else if (tense === 'past') out += L.past;
      }
    }
    if (r.superseded_by != null && !previous) out += L.superseded;
  }
  if (c.occurrence && c.occurrence.count >= 2) {
    if (c.occurrence.ambiguous) out += L.ambiguous;
    else if (!c.occurrence.latest) out += L.olderOccurrence;
  }
  return out;
}

/** 「（后来做完了）」→「（后来做完了，昨天晚上 20:15）」：时间放进括号里。 */
function withTime(note, time, sep) {
  if (!time) return note;
  const m = /([）)])\s*$/u.exec(note);
  return m ? `${note.slice(0, m.index)}${sep}${time}${note.slice(m.index)}` : `${note}${sep}${time}`;
}
