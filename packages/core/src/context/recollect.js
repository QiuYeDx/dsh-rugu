// 回忆的结果在上下文这一层（D155）：「找了哪儿」那一行、回忆这一层的先后。
// 「找了哪儿」由代码用事实拼出来，不含任何记忆内容：找的是什么范围（时间说法用 lang.describeRange，人用她对他的叫法，
// 场合名照工作记忆段头同样的放行规则：那个场合的档案卡在这一轮的目标上过了关口①才写，说不出名字就不写）、范围里有多少、下面给了多少、
// 哪些时段还有没给的。有了这一行，「没有」和「没找到」她分得清，也知道往哪儿接着想。
import { bestName } from './people.js';
import { charLen, clip, dayStart, sanitize } from './text.js';

/** 「找了哪儿」那一行最多多少字。 */
export const NOTE_MAX = 200;
/** 「还有 n 条没展开」最多点几个时段。 */
const REST_SEGMENTS = 2;

/**
 * 回忆这一层的条目怎么排（D155）：名额的先后（alloc）按 retrieve 给的 pick（范围内的名次、盖住时间之后的次序）；展示的先后（order）
 * 在有时间窗时按时间从早到晚（同一时刻按 pick），否则按 pick。
 * @param {{ref: string, layer: string}[]} routed  分好层的召回条目（按 retrieve 给的先后）
 * @param {Map<string, object>} byRef               ref → 候选（带 recollect: {pick, t}）
 * @param {{timed: boolean}} o
 * @returns {Map<string, {order: number, alloc: number}>}
 */
export function recollectOrder(routed, byRef, { timed }) {
  const list = routed.filter((x) => x.layer === 'recollect').map((x, i) => {
    const r = byRef.get(x.ref)?.recollect ?? {};
    return { ref: x.ref, pick: Number.isFinite(r.pick) ? r.pick : 10_000 + i, t: Number.isFinite(r.t) ? r.t : null };
  });
  const shown = [...list].sort(timed
    ? (a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.pick - b.pick
    : (a, b) => a.pick - b.pick);
  const out = new Map();
  shown.forEach((x, i) => out.set(x.ref, { order: i * 10, alloc: x.pick }));
  return out;
}

/**
 * 「找了哪儿」那一行（D155，见文件头）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object} rc   CandidateSet.recollect（retrieve 给的意图、范围、时间段）
 * @param {{given: {ref: string, t: number|null}[], key: string, at: number, placeOk: (k: string) => boolean}} o
 *        given：这一轮真的给了她的回忆条目（打包之后）和它们的时间
 * @returns {string}
 */
export function recollectNote(core, rc, { given, key, at, placeOk }) {
  if (!rc) return '';
  const lang = core.mods.lang;
  const range = (a, b, day = false) => { try { return lang.describeRange(core, a, b, { now: at, day }) || ''; } catch { return ''; } };
  const sc = rc.scope;
  const it = rc.intent;
  const n = given.length;
  if (!sc) {
    if (rc.fallback && it && (it.timeWindows?.length || it.aboutEntityIds?.length || it.settingKeys?.length)) {
      return finish(core, `这次没能按时间、人在范围里细找，下面 ${n} 条是按话题在全部记忆里找的`);
    }
    return finish(core, '没有限定时间和人，是按话题在全部记忆里找的');
  }
  const parts = [];
  const wins = (it?.timeWindows ?? []).slice(0, 3).map((w) => range(w.start, Math.max(w.start, Math.min(w.end, at)), true)).filter(Boolean);
  if (wins.length) parts.push(wins.join('、'));
  const names = (it?.aboutEntityIds ?? []).slice(0, 3).map((id) => nameFor(core, id, key)).filter(Boolean);
  if (names.length) parts.push(`和${names.join('、')}有关的`);
  if (it?.settingKeys?.length) {
    const places = it.settingKeys.slice(0, 3).map((k) => placeName(core, k, key, placeOk)).filter(Boolean);
    if (places.length) parts.push(`在${places.join('、')}`);
  } else {
    parts.push('所有场合');
  }
  const head = parts.length ? `找的是：${parts.join(' · ')}` : '找的是：指定的范围';
  if (!sc.total) return finish(core, `${head}；范围里没有记忆，下面是按话题在全部记忆里找的`);
  const eps = sc.counts?.episodes ?? 0;
  let text = `${head}；范围里 ${sc.total} 条记忆${eps ? `（${eps} 段经历）` : ''}${sc.clipped ? '（太多了，只看了最近的）' : ''}`;
  if (!sc.searched) return finish(core, `${text}，这次没能在里面细找，下面 ${n} 条是按话题在全部记忆里找的`);
  text += `，下面给了 ${n} 条`;
  const segs = Array.isArray(rc.segments) ? rc.segments : [];
  if (segs.length > 1) {
    const got = segs.map(() => 0);
    for (const g of given) {
      const i = segIndex(segs, g.t);
      if (i != null) got[i] += 1;
    }
    const multiDay = !sameDay(core, segs[0].start, segs.at(-1).end);
    const rest = segs.map((s, i) => ({ s, i, left: Math.max(0, (s.total ?? 0) - got[i]) }))
      .filter((x) => x.left > 0).sort((a, b) => b.left - a.left || a.i - b.i).slice(0, REST_SEGMENTS)
      .sort((a, b) => a.i - b.i);
    const said = rest.map((x) => { const l = range(x.s.start, x.s.end, multiDay); return l ? `${l}${/\d$/u.test(l) ? ' ' : ''}还有 ${x.left} 条` : ''; }).filter(Boolean);
    if (said.length) text += `；${said.join('，')}没展开`;
  }
  return finish(core, text);
}

const finish = (core, text) => clip(sanitize(core, text), NOTE_MAX);

/** 一个时刻落在第几段（早于第一段算第一段，晚于最后一段算最后一段）。 */
function segIndex(segs, t) {
  if (!Number.isFinite(t)) return null;
  for (let i = 0; i < segs.length; i++) if (t < segs[i].end) return i;
  return segs.length - 1;
}

/** 两个时刻是不是本地的同一天（时区按 config.time.tzOffsetMin）。 */
function sameDay(core, a, b) {
  try {
    const tz = core.config.get().time?.tzOffsetMin ?? null;
    return dayStart(a, tz) === dayStart(Math.max(a, b - 1), tz);
  } catch { return true; }
}

/** 她对这个人的叫法：主人用她对主人的称呼，别人用最常见的名字；说不出给空字符串。 */
function nameFor(core, id, key) {
  try {
    const e = core.store.get('SELECT authority, is_self FROM entities WHERE id = ?', id);
    if (!e || e.is_self) return '';
    if (e.authority === 'principal') {
      let label = '';
      try { label = core.ports.selfProfile?.principalLabel?.() ?? ''; } catch { label = ''; }
      if (label) return clip(sanitize(core, label), 20);
    }
    const n = bestName(core, id, key);
    return n ? clip(sanitize(core, n), 20).replace(/[「」『』“”"]/gu, ' ').trim() : '';
  } catch { return ''; }
}

/** 场合的名字：这里说「这里」；别的场合照工作记忆段头的放行规则（placeOk），说不出名字就不写。 */
function placeName(core, sk, key, placeOk) {
  if (sk === key) return '这里';
  try {
    if (!placeOk(sk)) return '';
    const s = core.mods.intake.settingByKey(core, sk);
    if (!s?.label || s.labelKind === 'description') return '';
    let t = '';
    try { t = core.mods.intake.labelForPrompt(core, s.label, 20); } catch { t = clip(sanitize(core, s.label), 20).replace(/[「」『』“”"]/g, ' ').trim(); }
    return t && charLen(t) ? `「${t}」` : '';
  } catch { return ''; }
}
