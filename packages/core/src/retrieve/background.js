// 提炼用的背景（§7.3，评审:SC-04、PS-03）：用同一套混合召回（有意模式）取出，按「本场合的人是不是本来就知道」分成两组。
//   known：这条记忆的已知圈（discretion.knownCircle）覆盖本场合的受众——场合级的知道（当时就在这里或它的上级场合当众说的，
//          而且可见范围从那以后没有变大），或者成员能列全时每个成员都在已知圈里；
//   private：其余的（只供提炼时理解，不许写进上下文头和叙述；污点检查由 encode 做）。
// 本段自己的感知和覆盖它们的原文窗口不算背景。出错只返回空的两组（提炼照常做，只是少了背景）。
// 还没结案的计划一律以事实（'a<id>'）的形式给，两组都一样：模型只能对背景里的事实写 plan_status。「还没结案」包括到点没下文的
// unknown（§5.5 第 5 条：不是过期，之后的完成证据照样能把它变成 done）。本段说话的人（含她自己）还没结案的计划先想到
// （人就是线索，S2b：「拿到了」和「去拿快递」没有共同的词、向量也不一定近，D58），连召回里已有的一共最多 recall.background.plans 条；
// 召回到的原始感知、窗口、情节是哪条计划的证据，那条计划跟在它后面。
// 召回照常给出的已经结案、被取代的计划不删（渲染写明「后来做完了」「后来有了新的说法」，模型据此不会再标它）。
import { reachGrew } from '../contract/setting.js';
import { buildCues } from './cues.js';
import { runRecall } from './pipeline.js';
import { render } from './render.js';
import { params } from './params.js';
import { clip, errKind, log, metric, mrefOf, parseJson, rowsByIds, safe, selfId } from './util.js';

/** 还没结案、也没被取代的计划（a 是表别名前缀，如 'a.'）。unknown 也算：到点没下文不是结案（§5.5 第 3、5 条）。 */
const openPlan = (a) => `${a}plan_status IN ('planned','in_progress','unknown') AND ${a}superseded_by IS NULL`;

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {{settingKey: string, perceptIds: number[]}} seg
 * @param {{signal?: AbortSignal}} [opt]
 * @returns {Promise<{known: {ref: string, text: string}[], private: {ref: string, text: string}[]}>}
 */
export async function backgroundForExtraction(core, seg, opt = {}) {
  const out = { known: [], private: [] };
  try {
    const { recall: rc, x, cfg } = params(core);
    const ids = [...new Set((seg?.perceptIds ?? []).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
    if (!seg?.settingKey || !ids.length) return out;
    const rows = rowsByIds(core.store, 'SELECT id, text, at, window_id, actor_entity_id FROM percepts WHERE id IN (?*) ORDER BY id', ids).sort((a, b) => a.id - b.id);
    if (!rows.length) return out;
    const text = rows.map((r) => r.text).filter(Boolean).join('\n');
    const lo = rows[0].id;
    const hi = rows.at(-1).id;
    const at = Math.max(...rows.map((r) => r.at));
    const exclude = new Set(rows.map((r) => `p${r.id}`));
    for (const w of safe(core, 'segWindows', () => core.store.all(
      'SELECT id FROM raw_windows WHERE setting_key = ? AND last_percept >= ? AND first_percept <= ?', seg.settingKey, lo, hi), []) ?? []) {
      exclude.add(`w${w.id}`);
    }
    const head = clip(text, rc.window.maxChars);
    const tail = Array.from(text).length > rc.window.maxChars ? Array.from(text).slice(-rc.window.maxChars).join('') : null;
    const cues = buildCues(core, { settingKey: seg.settingKey, focusPerceptId: hi, query: head, extraQueries: tail ? [tail] : [] });
    const { set } = await runRecall(core, { settingKey: seg.settingKey, focusPerceptId: hi, trigger: 'extract' },
      { mode: 'deliberate', deadlineMs: rc.deliberate.deadlineMs, signal: opt.signal }, { cues, exclude });
    const recalled = set.items.filter((c) => !c.fok && !exclude.has(c.ref));
    const items = withPlans(core, recalled, { rows, max: x.background.plans });
    if (!items.length) return out;
    // 受众或已知圈拿不到：一律算「不是本来就知道」（进 private：最多少写一点，不会把私事写进群的情节）
    const audience = safe(core, 'audience', () => core.mods.discretion.audienceOf(core, seg.settingKey, at), null);
    const setting = safe(core, 'setting', () => core.mods.intake.settingByKey(core, seg.settingKey), null);
    const itemChars = cfg.extract.miniCardChars;
    for (const c of items) {
      if (out.known.length >= x.background.known && out.private.length >= x.background.private) break;
      const known = safe(core, 'covers', () => covers(core, c.mref, audience, setting, at), false);
      const group = known ? out.known : out.private;
      if (group.length >= (known ? x.background.known : x.background.private)) continue;
      const r = render(core, c, { verdict: 'share', at: core.now(), itemChars, settingKey: seg.settingKey });
      if (r.rendered) group.push({ ref: c.ref, text: r.rendered });
    }
    metric(core, 'retrieve.background');
    return out;
  } catch (e) {
    metric(core, 'retrieve.background.error');
    log(core, 'warn', 'retrieve.background.error', { error: errKind(e) });
    return { known: [], private: [] };
  }
}

/**
 * 背景的顺序：本段说话的人还没结案的计划（最近更新的在前）→ 召回的结果，每条后面跟着以它为证据、还没结案的计划。
 * 说话人的计划一共最多 max 条：召回里已经有的先算上（召回自己的排序可信），不够的用最近更新的补，补的排在最前面
 * （背景每组有条数上限，排后面可能被挤掉）。召回本身给出的不删。
 * 加进来的计划照常过预过滤（隐藏 / 忘掉 / 墓碑；查不了就一条都不加，fail closed），不重复。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object[]} recalled  召回的候选（已经去掉本段自己和知道感）
 * @param {{rows: {actor_entity_id: number|null}[], max: number}} opt  rows：本段的感知（说话人从这里来）
 * @returns {object[]}
 */
export function withPlans(core, recalled, { rows, max }) {
  const speakers = [...new Set(rows.map((r) => r.actor_entity_id).filter((e) => Number.isInteger(e) && e > 0))];
  const have = new Set(recalled.map((c) => c.ref));
  let byPerson = [];
  if (speakers.length && max > 0) {
    const marks = speakers.map(() => '?').join(',');
    const ofSpeakers = `(plan_agent IN (${marks}) OR id IN (SELECT assertion_id FROM assertion_entities WHERE role = 'subject' AND entity_id IN (${marks})))`;
    // 召回里已经有几条说话人的、还没结案的计划
    const recalledIds = [...new Set(recalled.map((c) => c.mref ?? mrefOf(c.ref)).filter((m) => m?.kind === 'assertion').map((m) => m.id))];
    const already = recalledIds.length ? (safe(core, 'recalledPlans', () => core.store.all(
      `SELECT id FROM assertions WHERE id IN (${recalledIds.map(() => '?').join(',')}) AND ${openPlan('')} AND ${ofSpeakers}`,
      ...recalledIds, ...speakers, ...speakers), null)) : [];
    const room = already ? max - already.length : 0;   // 查不了：不补（召回给的照常）
    if (room > 0) {
      byPerson = (safe(core, 'speakerPlans', () => core.store.all(
        `SELECT id FROM assertions WHERE ${openPlan('')} AND ${ofSpeakers} ORDER BY updated_at DESC, id DESC LIMIT ?`,
        ...speakers, ...speakers, max), []) ?? []).map((r) => `a${r.id}`).filter((ref) => !have.has(ref)).slice(0, room);
    }
  }
  // 召回到的原始单元（感知、窗口、情节）是哪些计划的证据：计划 → 证据单元的引用（第一条）
  const evidence = new Map();
  const raw = recalled.map((c) => ({ ref: c.ref, m: c.mref ?? mrefOf(c.ref) })).filter((x) => ['percept', 'window', 'episode'].includes(x.m?.kind));
  if (raw.length) {
    const unitOf = new Map();   // 感知 id → 召回到的单元的引用
    for (const x of raw) if (x.m.kind === 'percept' && !unitOf.has(x.m.id)) unitOf.set(x.m.id, x.ref);
    const wIds = raw.filter((x) => x.m.kind === 'window').map((x) => x.m.id);
    const eIds = raw.filter((x) => x.m.kind === 'episode').map((x) => x.m.id);
    for (const r of safe(core, 'windowPercepts', () => rowsByIds(core.store, 'SELECT id, window_id FROM percepts WHERE window_id IN (?*)', wIds), []) ?? []) {
      if (!unitOf.has(r.id)) unitOf.set(r.id, `w${r.window_id}`);
    }
    for (const r of safe(core, 'episodePercepts', () => rowsByIds(core.store, 'SELECT id, episode_id FROM percepts WHERE episode_id IN (?*)', eIds), []) ?? []) {
      if (!unitOf.has(r.id)) unitOf.set(r.id, `e${r.episode_id}`);
    }
    for (const r of safe(core, 'planSources', () => rowsByIds(core.store,
      `SELECT s.owner_id AS id, s.percept_id AS p FROM sources s JOIN assertions a ON a.id = s.owner_id
        WHERE s.owner_kind = 'assertion' AND s.percept_id IN (?*) AND ${openPlan('a.')} ORDER BY s.owner_id`, [...unitOf.keys()]), []) ?? []) {
      const ref = `a${r.id}`;
      if (!evidence.has(ref)) evidence.set(ref, unitOf.get(r.p));
    }
  }
  const want = [...new Set([...byPerson, ...evidence.keys()])].filter((ref) => !have.has(ref));
  if (!want.length) return recalled;
  let blocked;
  try { blocked = core.mods.admin.suppressedRefs(core, want); } catch { return recalled; }   // 查不了：一条都不加（fail closed）
  const hidden = blocked instanceof Set ? blocked : new Set(blocked ?? []);
  const ok = new Set(want.filter((ref) => !hidden.has(ref)));
  const cand = (ref) => ({ ref, mref: mrefOf(ref), ranks: {}, rrf: 0, signals: {} });
  const out = byPerson.filter((ref) => ok.has(ref)).map(cand);
  const placed = new Set(out.map((c) => c.ref));
  for (const c of recalled) {
    if (!placed.has(c.ref)) { out.push(c); placed.add(c.ref); }
    for (const [ref, unit] of evidence) {
      if (unit === c.ref && ok.has(ref) && !placed.has(ref)) { out.push(cand(ref)); placed.add(ref); }
    }
  }
  return out;
}

/**
 * 这条记忆，本场合的人是不是本来就知道。拿不准一律算不知道（进 private：最多只是少写一点，不会把私事写进群的情节）。
 * @param {import('../core-types.js').CoreContext} core
 */
export function covers(core, mref, audience, setting, at) {
  const circle = core.mods.discretion.knownCircle(core, mref, at);
  if (!circle || circle.selfOnly) return false;
  const here = setting?.key;
  const parent = setting?.parentKey ?? null;
  for (const s of circle.settings ?? []) {
    if (!(s.settingKey === here || (parent && s.settingKey === parent))) continue;
    if (!(s.since <= at)) continue;
    if (!reachGrewSince(core, setting, s.since)) return true;
  }
  if (audience?.completeness === 'exact' && Array.isArray(audience.members) && audience.members.length) {
    const knownIds = new Set(circle.entities ?? []);
    const ps = (circle.presenceSets ?? []).filter((n) => Number.isInteger(n));
    if (ps.length) {
      for (const r of safe(core, 'presence', () => rowsByIds(core.store, 'SELECT members_json FROM presence_sets WHERE id IN (?*)', ps), []) ?? []) {
        for (const e of parseJson(r.members_json, []) ?? []) knownIds.add(e);
      }
    }
    const me = selfId(core);
    return audience.members.every((e) => e === me || knownIds.has(e));
  }
  return false;
}

/** 这个场合的可见范围从 since 以后变大了没有（§9.3.2 A1(b)）。拿不到快照就当变大了。 */
function reachGrewSince(core, setting, since) {
  if (!setting?.descriptor) return true;
  // 那时候的快照；比最早的快照还早（描述晚到了一点）就用最早的那份
  const snap = safe(core, 'snapAt', () => core.store.get(
    'SELECT id FROM setting_snapshots WHERE setting_key = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1', setting.key, since)
    ?? core.store.get('SELECT id FROM setting_snapshots WHERE setting_key = ? ORDER BY at, id LIMIT 1', setting.key), null);
  if (!snap) return true;
  const old = safe(core, 'snapshot', () => core.mods.intake.snapshotById(core, snap.id), null);
  if (!old?.descriptor) return true;
  try { return reachGrew(old.descriptor, setting.descriptor); } catch { return true; }
}
