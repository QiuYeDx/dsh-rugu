// 【D175】管理页「记忆 → 做梦」：夜间整理按晚列出来，每一晚做了什么（只读，只读库也能用）。
//   - 一晚 = 一个本地日：这一天里夜间整理写下的东西（日记、改正、归纳的规律、反思的想法、对人的印象、性格的变化、总结的经验）
//     按写下的时刻归到那一天；这一天的运行报告（调了几次模型、哪几步没做成）来自 meta 'sleep.history'（D175 起每晚留底，最多 30 晚），
//     没有留底的旧晚（升级前）只有产出、没有报告；最近一次的 'sleep.lastReport' 也算（升级前跑的最后一次）。
//   - 不另起一套口径：产出直接查它们自己的表（和 views.js 的 checks、lessons 同样的字段），不抄文字进新表；没有迁移。
//     每一路都按时间列走已有的索引（memory_checks_at、assertions_recorded、assertions_lesson_updated、episodes_kind）；
//     impressions、成长版本表很小，直接扫。
//   - 翻页：before（毫秒）= 只看这个时刻之前的晚；一次最多 limit（默认 7）晚；more 说前面是不是还有更早的。
// 只有 SELECT。SQL 一律参数化。
import { getMeta, getMetaJson, refOf } from '../store/index.js';
import { ContractError } from '../contract/errors.js';
import { tzOf } from './timeline.js';
import { namesOf } from './feed.js';

const DAY = 86_400_000;
/** 一晚里每一类最多列几条（总数另给）。 */
const PER_CAT = 20;
/** 找「有哪些晚」时每一路最多取多少个时刻（只取一个整数，很轻）。 */
const SCAN = 600;
const MAX_NIGHTS = 30;

const bad = (path, message) => new ContractError('admin.nights', [{ path, message }]);
const clip = (s, n) => { const c = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return c.length > n ? `${c.slice(0, n).join('')}…` : c.join(''); };
const safeJson = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

/** 没忘掉的（隐藏的照列）：suppressions 的主键是 (owner_kind, owner_id)。 */
const alive = (kind) => `NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.owner_kind = '${kind}' AND s.owner_id = t.id AND s.state = 'forgotten')`;

/** 每一路「夜里写下的东西」：时间列、表、条件（t 是表别名）。找晚和取产出共用，口径只有这一份。 */
const SOURCES = {
  diary: { from: 'episodes t', time: 't.created_at', where: `t.ep_kind = 'diary' AND ${alive('episode')}` },
  check: { from: 'memory_checks t', time: 't.at', where: '1' },
  pattern: { from: 'assertions t', time: 't.recorded_at', where: `t.kind_hint = 'pattern' AND ${alive('assertion')}` },
  insight: { from: 'assertions t', time: 't.recorded_at', where: `t.kind_hint = 'insight' AND ${alive('assertion')}` },
  impression: { from: 'entity_impressions t', time: 't.built_at', where: '1' },
  growth: { from: 'core_block_versions t', time: 't.created_at', where: "t.name = 'growth' AND t.created_by = 'sleep'" },
  lesson: { from: 'assertions t', time: 't.updated_at',
    where: `t.kind_hint = 'lesson' AND json_valid(t.value) AND json_extract(t.value, '$.origin') = 'nightly' AND ${alive('assertion')}` },
};

/** 留底的每一晚报告（升级前只有最近一次）。 */
function runsOf(core) {
  const out = [];
  const hist = getMetaJson(core.store, 'sleep.history');
  for (const r of Array.isArray(hist) ? hist : []) if (r && Number.isFinite(r.startedAt)) out.push(r);
  const last = getMetaJson(core.store, 'sleep.lastReport');
  if (last && Number.isFinite(last.startedAt) && !out.some((r) => r.startedAt === last.startedAt)) out.push(last);
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

const STEP_DETAIL = (steps, name) => steps.find((s) => s?.name === name)?.detail ?? null;
/** 一份报告 → 管理页要的：时间、调用、哪几步没做成（failed 出错 / capped 到上限 / preset 节省档没做 / aborted 被中止）、日记缺几天。 */
function runView(r) {
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const problems = [];
  for (const s of steps) {
    if (!s || typeof s.name !== 'string') continue;
    if (s.capped) problems.push({ name: s.name, kind: 'capped' });
    else if (s.skipped === 'saving-preset') problems.push({ name: s.name, kind: 'preset' });
    else if (s.skipped === 'aborted') problems.push({ name: s.name, kind: 'aborted' });
    else if (s.ok === false || /^error:/.test(String(s.skipped ?? ''))) problems.push({ name: s.name, kind: 'failed' });
  }
  const self = STEP_DETAIL(steps, 'self');
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    at: num(r.startedAt), finishedAt: num(r.finishedAt), llmCalls: num(r.llmCalls) ?? 0, llmMax: num(r.llmMax),
    problems, diaryPending: num(self?.diaryPending) ?? 0,
  };
}

/**
 * 一个本地日范围里每一类产出：总数 + 最多 PER_CAT 条。
 * @returns {{counts: object, groups: object[]}}
 */
function outputsOf(core, a, b) {
  const cnt = (k) => Number(core.store.get(`SELECT count(*) AS n FROM ${SOURCES[k].from} WHERE ${SOURCES[k].where} AND ${SOURCES[k].time} >= ? AND ${SOURCES[k].time} < ?`, a, b).n);
  const rows = (k, cols, extra = '') => core.store.all(`SELECT ${cols} FROM ${SOURCES[k].from} WHERE ${SOURCES[k].where} AND ${SOURCES[k].time} >= ? AND ${SOURCES[k].time} < ?${extra} LIMIT ${PER_CAT}`, a, b);
  const counts = {};
  const groups = [];
  const add = (cat, total, items) => { counts[cat] = total; if (total > 0) groups.push({ cat, total, items }); };

  // 日记
  add('diary', cnt('diary'), rows('diary', 't.id, t.title, t.narrative, t.t_start, t.t_end, t.created_at', ' ORDER BY t.created_at DESC').map((e) => ({
    ref: refOf('episode', e.id), title: e.title || null, text: clip(e.narrative, 160), tStart: e.t_start, tEnd: e.t_end, at: e.created_at })));

  // 对照原话纠错：改了的列出来（和 views.js 的 checks 同一个口径），没改的只数个数
  const checked = cnt('check');
  const fact = core.store.prepare('SELECT id, text, confidence, superseded_by FROM assertions WHERE id = ?');
  const factOf = (id) => { const x = id == null ? null : fact.get(id); return x ? { ref: refOf('assertion', x.id), text: clip(x.text, 160), current: x.superseded_by == null } : null; };
  const changedWhere = " AND t.verdict IN ('corrected','changed','doubted')";
  const changed = Number(core.store.get(`SELECT count(*) AS n FROM memory_checks t WHERE t.at >= ? AND t.at < ?${changedWhere}`, a, b).n);
  counts.checked = checked;
  const changedItems = changed ? core.store.all(`SELECT t.id, t.at, t.verdict, t.why, t.assertion_id, t.result_id, t.after_conf, t.reverted_at FROM memory_checks t
      WHERE t.at >= ? AND t.at < ?${changedWhere} ORDER BY t.at DESC, t.id DESC LIMIT ${PER_CAT}`, a, b).map((c) => ({
    id: c.id, at: c.at, verdict: c.verdict, why: c.why ? clip(c.why, 80) : null,
    withdrawn: c.verdict === 'doubted' && c.result_id == null && c.after_conf === 0,
    before: factOf(c.assertion_id), after: factOf(c.result_id), reverted: c.reverted_at != null,
    revertable: c.reverted_at == null })) : [];
  add('changed', changed, changedItems);

  // 归纳的规律、反思的想法（她推断的事实）
  for (const k of ['pattern', 'insight']) {
    const subj = core.store.prepare("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role = 'subject' LIMIT 4");
    add(k, cnt(k), rows(k, 't.id, t.text, t.confidence, t.superseded_by, t.recorded_at', ' ORDER BY t.recorded_at DESC, t.id DESC').map((x) => ({
      ref: refOf('assertion', x.id), text: clip(x.text, 160), confidence: x.confidence, current: x.superseded_by == null, at: x.recorded_at,
      subjects: subj.all(x.id).map((r) => r.entity_id) })));
  }

  // 对人的印象：这一晚写下的那一版；version = 1 是第一次有印象
  add('impression', cnt('impression'), rows('impression', 't.id, t.entity_id, t.layer, t.text, t.version, t.is_current, t.built_at', ' ORDER BY t.built_at DESC, t.id DESC').map((x) => ({
    ref: refOf('impression', x.id), who: x.entity_id, layer: x.layer, text: clip(x.text, 160), version: x.version, first: x.version === 1, current: !!x.is_current, at: x.built_at })));

  // 性格（成长块）的变化
  add('growth', cnt('growth'), rows('growth', 't.version, t.change_json, t.evidence_ids, t.created_at, t.revoked_at', ' ORDER BY t.version DESC').map((x) => {
    const c = safeJson(x.change_json, {});
    return { version: x.version, op: typeof c.op === 'string' ? c.op : null, before: typeof c.before === 'string' ? clip(c.before, 120) : null,
      after: typeof c.after === 'string' ? clip(c.after, 120) : null, evidence: safeJson(x.evidence_ids, []).length, revokedAt: x.revoked_at ?? null, at: x.created_at };
  }));

  // 夜里回顾做事时总结的经验
  add('lesson', cnt('lesson'), rows('lesson', 't.id, t.text, t.updated_at, t.certainty, t.value', ' ORDER BY t.updated_at DESC, t.id DESC').map((x) => {
    const v = safeJson(x.value, {});
    return { ref: refOf('assertion', x.id), text: clip(x.text, 160), status: v.status === 'verified' ? 'verified' : 'unverified', at: x.updated_at };
  }));
  return { counts, groups };
}

/**
 * 夜间整理按晚列出来。
 * q：limit（几晚，默认 7，最多 30）、before（毫秒，只看这个时刻之前的晚）、tzOffsetMin。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{limit?: number, before?: number, tzOffsetMin?: number}} [q]
 * @returns {{now: number, schedule: {at: string, lastAt: number|null, running: boolean, nights: number},
 *   items: {day: string, dayStart: number, run: object|null, counts: object, groups: object[]}[], more: boolean, next?: number,
 *   names: object, settings: object, readOnly: boolean}}
 */
export function nights(core, q = {}) {
  const now = core.now();
  const limit = Number.isInteger(q.limit) ? Math.max(1, Math.min(MAX_NIGHTS, q.limit)) : 7;
  if (q.before != null && !Number.isFinite(q.before)) throw bad('before', '应为毫秒时间');
  const before = Number.isFinite(q.before) ? q.before : now + DAY;
  const tz = tzOf(core, q, now);
  const off = tz * 60_000;
  const dayOf = (t) => Math.floor((t + off) / DAY);
  const runs = runsOf(core);

  // 有哪些晚：每一路取这个时刻之前最近的 SCAN 个时刻，折成本地日
  const days = new Set();
  for (const k of Object.keys(SOURCES)) {
    const s = SOURCES[k];
    for (const r of core.store.all(`SELECT ${s.time} AS x FROM ${s.from} WHERE ${s.where} AND ${s.time} < ? ORDER BY ${s.time} DESC LIMIT ${SCAN}`, before)) days.add(dayOf(Number(r.x)));
  }
  for (const r of runs) if (r.startedAt < before) days.add(dayOf(r.startedAt));
  const sorted = [...days].sort((x, y) => y - x);
  const pick = sorted.slice(0, limit);
  const more = sorted.length > limit;

  const items = pick.map((d) => {
    const a = d * DAY - off;
    const b = a + DAY;
    const mine = runs.filter((r) => r.startedAt >= a && r.startedAt < b).at(-1) ?? null;
    const { counts, groups } = outputsOf(core, a, b);
    return { day: new Date(d * DAY).toISOString().slice(0, 10), dayStart: a, run: mine ? runView(mine) : null, counts, groups };
  });

  // 名字：印象里的人、规律和想法的主体
  const flat = [];
  for (const n of items) for (const g of n.groups) for (const x of g.items) flat.push({ who: x.who, subjects: x.subjects });
  const { names, settings } = namesOf(core, flat);

  const last = Number(getMeta(core.store, 'sleep.lastAt'));
  return {
    now,
    schedule: { at: String(core.config.get().sleep?.at ?? '04:30'), lastAt: Number.isFinite(last) && last > 0 ? last : null, running: !!core.state?.consolidate?.running, nights: runs.length },
    items, more, ...(more && pick.length ? { next: pick.at(-1) * DAY - off } : {}), names, settings, readOnly: !!core.readOnly,
  };
}
