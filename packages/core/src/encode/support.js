// 一条关于别人的事实落不落得到「谁说了能支撑它的话」上（D157）。提炼的核验（verify 第 15 条）和库里已有事实的清查（echoCheck）
// 用同一把尺子。
//   她凭记忆答别人的话是复述，不是新的证据：答错一次就被记成「对方说的」事实，下次照着它答，越答越错。所以：
//   - 对方那一侧（不是她说的证据消息）分几种：
//       material  图片、转发、素材这类内容（她看到的东西；她对图的描述是她看到的，照旧算）；
//       states    有陈述的部分（不是问句的分句里有实词）；
//       reply     接在她的话后面、自己没在问的应答（「嗯呢」「好」）：对她那句话的确认或答应；
//       asks      只是在问：问句里有实词，陈述的部分没有；
//       none      排在她的话前面、没有实词的（「唉」「1」）。
//     前三种撑得住；asks、none 撑不住——一句问话不是证据。
//   - 对方那一侧全都撑不住时，看事实正文的实词从哪来（主体的名字不算）：问句里有的算对方说的（问话带着的预设，
//     「你还记得你把老鼠认成猫吗」）；只在她的话里有的是她的。她的部分比对方的多 = 这条的内容出自她自己的话，讲的却是别人的事：
//     是她的复述或猜测，不是关于那个人的事实（echo）。
//   - 只引了她自己的话的：她的第一条证据前面最近一条别人的话是只在问、问的又是这件事（问句的实词在正文里），同样按上面比；
//     模型只引了她的回答、没引那句问话时也认得出来。
// 判断用语言层已有的东西：问句线索（lang.questionCue，按分句看）、查询词和词类（D150：虚词不算实词），没有话题词表。
// 认不出否定（「不对」和「对」一样是没有实词的应答）：被否定的说法由提炼的提示词管（不写成事实）。
import { clamp01 } from './util.js';
import { selfIdOf } from './write.js';

const SUPPORTING = new Set(['material', 'states', 'reply']);
export const supports = (kind) => SUPPORTING.has(kind);

/** 读参数（extract.support）；缺了用这里的兜底。 */
function opts(core) {
  const s = core.config?.get?.().extract?.support ?? {};
  return { questionMin: clamp01(s.questionMin ?? 0.6) };
}

/** 表情（平台自带的小表情、表情包）：是语气，不是她能看到的内容。 */
const EXPRESSION_MEDIA = new Set(['face', 'sticker', 'emoji']);

/** 这条消息里有没有图片、转发、文件、素材这类内容。 */
function hasMaterial(p) {
  if (p.kind === 'content' || p.standing === 'material' || p.forwarded_json) return true;
  if (typeof p.media_json === 'string' && p.media_json.trim().startsWith('[')) {
    try { return JSON.parse(p.media_json).some((m) => !EXPRESSION_MEDIA.has(String(m?.kind ?? ''))); } catch { return false; }
  }
  return false;
}

/** 去掉 @ 某人、平台占位（[图片] [表情277] [转发消息]），剩下真正说的话。 */
export function spokenText(text) {
  return String(text ?? '').normalize('NFKC')
    .replace(/@\S+/gu, ' ')
    .replace(/\[[^[\]\s]{1,16}\]/gu, ' ')
    .trim();
}

/**
 * 切成分句：句末标点、逗号顿号（问句线索按分句看：「最后没撤出来，也不知道为什么」前一句是在陈述）；
 * 聊天里常用空格当标点（「我刚才说了 我给你接入了一个模块 你忘了吗」），非拉丁字母两边的空格也切。
 */
export function clausesOf(text) {
  return String(text ?? '').split(/(?<=[。！!？?；;…～~\n，,、])|(?<=[^\x00-\x7F])\s+|\s+(?=[^\x00-\x7F])/u).map((s) => s.trim()).filter(Boolean);
}

/**
 * 一段话的实词（查询词去掉虚词，D150）。只取两个字（字母、数字）以上的：单个汉字（「天」「人」「吃」）到处都对得上，
 * 拿它比「对不对得上」等于没比。
 */
export function contentTerms(core, text) {
  let terms = [];
  try { terms = core.mods.lang.queryTerms(core, String(text ?? '')) ?? []; } catch { terms = []; }
  const out = new Set();
  for (const t of terms) {
    if (!t || t.startsWith('ent_') || [...t].length < 2) continue;
    let cls = null;
    try { cls = core.mods.lang.termClass(core, t); } catch { cls = null; }
    if (cls !== 'function') out.add(t);
  }
  return out;
}

/** 一句话像不像在问（0–1）。 */
function questionCue(core, text) {
  try { return Number(core.mods.lang.registry(core).questionCue(text)) || 0; } catch { return /[?？]\s*$/u.test(text) ? 1 : 0; }
}

/**
 * 一条话的结构：陈述的分句里的实词、问句里的实词、全部实词。
 * @returns {{material: boolean, stated: Set<string>, asked: Set<string>, all: Set<string>}}
 */
export function analyzeMessage(core, p) {
  const qMin = opts(core).questionMin;
  const stated = new Set();
  const asked = new Set();
  for (const s of clausesOf(spokenText(p.text))) {
    const terms = contentTerms(core, s);
    if (!terms.size) continue;   // 没有实词的分句（「嗯呢」「对」「哈哈」）：不在陈述什么，也不在问什么
    const into = questionCue(core, s) >= qMin ? asked : stated;
    for (const t of terms) into.add(t);
  }
  return { material: hasMaterial(p), stated, asked, all: new Set([...stated, ...asked]) };
}

/**
 * 别人说的一条证据消息算哪一种（见文件头）。
 * @param {{afterHer: boolean}} pos   这条排在她的某条证据消息后面（在应答她）
 * @returns {'material'|'states'|'reply'|'asks'|'none'}
 */
export function supportKind(core, p, { afterHer }, a = analyzeMessage(core, p)) {
  if (a.material) return 'material';
  if (a.stated.size) return 'states';
  if (a.asked.size) return 'asks';
  return afterHer ? 'reply' : 'none';
}

const before = (a, b) => a.at < b.at || (a.at === b.at && a.id < b.id);

/**
 * 一条事实的证据撑不撑得住它（见文件头）。只对主体里没有她的事实有意义（她说自己的事照旧，§7.4 第 6 条和 D123）。
 * @param {object} q
 * @param {string} q.text              事实正文
 * @param {string[]} [q.names]         主体的名字（正文里本来就有，不算谁说的内容）
 * @param {object[]} q.rows            证据消息（感知行）
 * @param {object[]} [q.segment]       这一段的全部感知（只引了她的话时，找她在答的那句问话）
 * @returns {{echo: boolean, kinds: {id: number, kind: string}[], herOnly: number, fromOthers: number, asked: object|null, unsupported: number[]}}
 *   echo：内容出自她自己的话、对方那一侧撑不住；unsupported：撑不住的别人的证据消息（问话等，不该当来源）；
 *   asked：只引了她的话时，她在答的那句问话
 */
export function echoOf(core, { text, names = [], rows, segment = [] }) {
  const her = rows.filter((p) => p.actor_self);
  const others = rows.filter((p) => !p.actor_self);
  const exclude = new Set(names.flatMap((n) => [...contentTerms(core, n)]));
  const fact = new Set([...contentTerms(core, text)].filter((t) => !exclude.has(t)));
  const out = { echo: false, kinds: [], herOnly: 0, fromOthers: 0, asked: null, unsupported: [] };
  if (!her.length) return out;
  let side = others;
  if (others.length) {
    const analyses = others.map((p) => analyzeMessage(core, p));
    out.kinds = others.map((p, i) => ({ id: p.id, kind: supportKind(core, p, { afterHer: her.some((h) => before(h, p)) }, analyses[i]) }));
    out.unsupported = out.kinds.filter((k) => !supports(k.kind)).map((k) => k.id);
    if (out.kinds.some((k) => supports(k.kind))) return out;
  } else {
    // 只引了她的话：她的第一条证据前面，最近一条别人的话（非证据的动作、她心里想的不算）
    const first = her.reduce((m, p) => (before(p, m) ? p : m));
    const prev = segment.filter((p) => !p.actor_self && p.evidential && before(p, first)).at(-1);
    if (!prev) return out;
    const a = analyzeMessage(core, prev);
    if (supportKind(core, prev, { afterHer: false }, a) !== 'asks' || ![...a.asked].some((t) => fact.has(t))) return out;
    out.asked = prev;
    side = [prev];
  }
  const theirs = new Set(side.flatMap((p) => [...analyzeMessage(core, p).all]));
  const mine = new Set(her.flatMap((p) => [...contentTerms(core, spokenText(p.text))]));
  for (const t of fact) {
    if (theirs.has(t)) out.fromOthers += 1;
    else if (mine.has(t)) out.herOnly += 1;
  }
  out.echo = out.herOnly > out.fromOthers;
  return out;
}

/** 不用这一条看的：她的经验、没采纳的要求、她的看法（她说的就是她的看法）、推断出来的、确认过的（主人认过的）。 */
const SKIP_KINDS = new Set(['lesson', 'request', 'opinion']);
const SKIP_CERTAINTY = new Set(['confirmed', 'inferred']);

/**
 * 库里一条有效事实按第 15 条看（D157 清查用，只读）：
 *   'echo'    该收回：关于别人、内容出自她自己的话、对方那一侧只是在问或什么都没说（新提炼的会被第 15 条挡下的那种）；
 *   'unsure'  拿不准：对方那一侧也只是在问，但正文的内容大半在问句里（问话带着的预设，或者是在说「他问了……」），她的话又添了东西；
 *   'ok'      撑得住；'skip' 不归这一条管（关于她自己的、钉住的、确认过的、推断的、经验、看法、没有原话的）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} id
 * @returns {{verdict: 'echo'|'unsure'|'ok'|'skip', her: number[], others: number[], herOnly?: number, fromOthers?: number}}
 */
export function echoCheck(core, id) {
  const skip = { verdict: 'skip', her: [], others: [] };
  const a = core.store.get('SELECT id, text, kind_hint, certainty, pinned, superseded_by, expired_at FROM assertions WHERE id = ?', id);
  if (!a || a.superseded_by != null || a.expired_at != null || a.pinned || SKIP_KINDS.has(a.kind_hint) || SKIP_CERTAINTY.has(a.certainty)) return skip;
  const self = selfIdOf(core);
  const subjects = core.store.all("SELECT entity_id AS id FROM assertion_entities WHERE assertion_id = ? AND role = 'subject'", id).map((r) => r.id);
  if (!subjects.length || subjects.includes(self)) return skip;
  const ids = core.store.all("SELECT DISTINCT percept_id AS id FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? AND percept_id IS NOT NULL", id).map((r) => r.id);
  if (!ids.length) return skip;
  const rows = core.store.all(`SELECT * FROM percepts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY at, id`, ...ids)
    .filter((p) => p.text != null && p.kind !== 'self-thought');
  const her = rows.filter((p) => p.actor_self);
  const others = rows.filter((p) => !p.actor_self);
  const base = { her: her.map((p) => p.id), others: others.map((p) => p.id) };
  if (!her.length) return { verdict: 'ok', ...base };
  const ep = her[0].episode_id;
  const segment = ep ? core.store.all('SELECT * FROM percepts WHERE episode_id = ? ORDER BY at, id', ep) : [];
  const e = echoOf(core, { text: a.text, names: subjects.flatMap((s) => namesOf(core, s)), rows, segment });
  const out = { ...base, herOnly: e.herOnly, fromOthers: e.fromOthers };
  if (e.echo) return { verdict: 'echo', ...out, others: e.asked ? [e.asked.id] : base.others };
  if (e.kinds.length && e.kinds.every((k) => !supports(k.kind)) && e.herOnly > 0) return { verdict: 'unsure', ...out };
  return { verdict: 'ok', ...out };
}

/** 一个实体在正文里可能出现的名字：档案名、用过的名字、主人的称呼。 */
function namesOf(core, entityId) {
  const out = new Set();
  const e = core.store.get('SELECT display_name, authority FROM entities WHERE id = ?', entityId);
  if (e?.display_name) out.add(e.display_name);
  for (const r of core.store.all('SELECT text_raw FROM entity_names WHERE entity_id = ? ORDER BY count DESC LIMIT 5', entityId)) if (r.text_raw) out.add(r.text_raw);
  if (e?.authority === 'principal') {
    try { const pl = core.ports.selfProfile.principalLabel(); if (pl) out.add(pl); } catch { /* 没有就算了 */ }
  }
  return [...out];
}
