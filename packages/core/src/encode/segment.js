// 情节切分（§7.2）：每个场合的缓冲 = 这个场合里 episode_id 还是空的感知（§12.8 第 2 条，启动时从库里重建，不在内存里另存）。
//   - 确定的边界：间隔 ≥ gapMin、缓冲满（条数 / 字数）、回填和实时混在一起、中间夹着已经封口的感知、对话空闲了、force；
//   - 拿不准的边界（原文窗口向量的话题漂移、参与者大换）：交给提炼的那次 LLM 调用判断，置信度 > 0.7 才封口；
//     没确认的那一刀记在任务上（done 且感知还没归进情节），下次不会再在同一处切。
//   - 一个场合同一时间最多一个「拿不准」的段在排队：它没定下来之前，后面的不切（否则会切出重叠的段）。
//   - 优先级只按 w_att × w_rel × 新鲜度（评审:UV-17）；对她说的一对一内容标 reserved（预算有预留，§7.2）。
import { enqueueJob, cancelJob } from '../store/jobs.js';
import { SEGMENT_BUFFER_SQL, openBufferSettings } from '../store/invariants.js';
import { bumpMetric } from '../store/kv.js';
import { param, isNum, jsonParse, MIN, HOUR, cosine } from './util.js';

export const EXTRACT_KIND = 'extract';
/** 复核发现可能的完成证据时，相关提炼任务提到最前（§5.5 第 6 条）。 */
export const BOOST_PRIORITY = 1_000_000;

function extractJobs(core, settingKey, statuses) {
  return core.store.all(`SELECT * FROM jobs WHERE kind = ? AND scope_key = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY ep_from`,
    EXTRACT_KIND, settingKey, ...statuses);
}

/** 提炼任务的去重键（场合 + 感知 id 范围）。 */
export const extractDedupeKey = (settingKey, from, to) => `extract:${settingKey}:${from}-${to}`;

/** 一个段的优先级：max(w_att × w_rel) × 新鲜度（半衰期 segment.freshnessHalfLifeH）。 */
export function segmentPriority(core, rows, at) {
  const cfg = core.config.get();
  const att = cfg.activation.attention;
  const rel = cfg.activation.relation;
  const ids = [...new Set(rows.map((r) => r.actor_entity_id).filter(Boolean))];
  const closeness = new Map(ids.length
    ? core.store.all(`SELECT id, closeness FROM entities WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((r) => [r.id, r.closeness]) : []);
  let best = 0;
  for (const r of rows) {
    const wAtt = att[r.attention_class] ?? att.attendedAmbient;
    const wRel = rel.base + rel.span * (r.actor_self ? 0 : (closeness.get(r.actor_entity_id) ?? 0));
    best = Math.max(best, wAtt * wRel);
  }
  const last = rows.reduce((m, r) => Math.max(m, r.at), 0);
  const halfH = param(core, 'segment.freshnessHalfLifeH');
  const fresh = 2 ** (-Math.max(0, at - last) / (halfH * HOUR));
  return Math.max(1, Math.round(1000 * best * fresh));
}

/** 对她说的一对一内容（预算有预留，§7.2、§10.6）。 */
function isReserved(core, settingKey, rows) {
  if (!core.config.get().extract.reservedOneOnOne) return false;
  if (!rows.some((r) => r.addressed === 'to-her')) return false;
  const snaps = [...new Set(rows.map((r) => r.snapshot_id).filter(Boolean))];
  const snap = snaps.length ? core.store.get('SELECT exposure_rank FROM setting_snapshots WHERE id = ?', snaps.at(-1)) : null;
  return snap?.exposure_rank === 0;
}

/**
 * 原文窗口向量的话题漂移（复用 §7.1 第 8 步已经嵌好的向量，不另外嵌入）：返回「在这条感知之前可能是边界」的感知 id。
 * 向量在 worker 的活动空间里（worker.activeSpaceId；向量库的表照 schema 直接读，切分是同步的，用不了异步的 storedVectors）。
 * 窗口按（场合，visible_to）分别切（D53）：只比同一组里前后相邻的两个窗口，她私下读到的不和公开的发言比。
 */
function driftCuts(core, settingKey, minId) {
  const cuts = new Set();
  if (!core.vectors) return cuts;
  try {
    const space = core.mods.worker.activeSpaceId(core);
    if (!space) return cuts;
    const wins = core.store.all(`SELECT id, visible_to, first_percept, last_percept FROM raw_windows WHERE setting_key = ? AND last_percept >= ?
                                   ORDER BY first_percept, id LIMIT 200`, settingKey, minId);
    if (wins.length < 2) return cuts;
    const vecs = new Map(core.vectors.all(`SELECT owner_id, f32, q8 FROM vectors WHERE space_id = ? AND owner_kind = 'window' AND chunk_no = 0
                                             AND owner_id IN (${wins.map(() => '?').join(',')})`, space, ...wins.map((w) => w.id))
      .map((r) => [r.owner_id, toVector(r)]));
    const maxCos = param(core, 'segment.driftCos');
    const prevOf = new Map();   // visible_to → 这一组的上一个窗口
    for (const w of wins) {
      const prev = prevOf.get(w.visible_to);
      prevOf.set(w.visible_to, w);
      if (!prev) continue;
      const a = vecs.get(prev.id);
      const b = vecs.get(w.id);
      const c = a && b ? cosine(a, b) : null;
      if (c != null && c < maxCos) {
        const next = core.store.get('SELECT MIN(id) AS id FROM percepts WHERE setting_key = ? AND id > ?', settingKey, prev.last_percept)?.id;
        if (next) cuts.add(next);
      }
    }
  } catch (e) {
    core.log.debug('encode.segment.drift', { error: e?.code ?? e?.name ?? 'Error' });
  }
  return cuts;
}
/** 向量库的一行 → 数组（余弦和缩放无关，int8 直接用；有 f32 用 f32）。 */
function toVector(r) {
  if (r.f32) return new Float32Array(r.f32.buffer, r.f32.byteOffset, Math.floor(r.f32.byteLength / 4));
  if (r.q8) return new Int8Array(r.q8.buffer, r.q8.byteOffset, r.q8.byteLength);
  return null;
}

const speakerKey = (r) => (r.actor_self ? 'self' : r.actor_entity_id ? `e${r.actor_entity_id}` : `a:${r.actor_json ?? ''}`);

/** 参与者大换：前后各 k 条的说话人集合几乎不重叠（两边都至少 2 个人）。 */
function participantChange(rows, i, segStart, k, maxJ) {
  if (i - segStart < k || i + k > rows.length) return false;
  const prev = new Set(rows.slice(i - k, i).map(speakerKey));
  const next = new Set(rows.slice(i, i + k).map(speakerKey));
  prev.delete('self'); next.delete('self');
  if (prev.size < 2 || next.size < 2) return false;
  let inter = 0;
  for (const x of prev) if (next.has(x)) inter += 1;
  return inter / (prev.size + next.size - inter) <= maxJ;
}

/**
 * 切一个场合的缓冲，返回排了几个任务。
 * @param {{at: number, force?: boolean, boost?: boolean, retryFailed?: boolean}} opt
 */
export function segmentSetting(core, settingKey, opt) {
  const cfg = core.config.get();
  const at = opt.at;
  const inflight = extractJobs(core, settingKey, ['queued', 'running']);
  if (inflight.some((j) => jsonParse(j.payload_json, {}).boundaryCertain === false)) return 0;   // 一个拿不准的段还没定下来
  const limit = param(core, 'segment.scanLimit');
  let rows = core.store.all(`${SEGMENT_BUFFER_SQL} LIMIT ${Math.max(1, Math.floor(limit))}`, settingKey);
  const covered = (id) => inflight.some((j) => id >= j.ep_from && id <= j.ep_to);
  rows = rows.filter((r) => !covered(r.id));
  if (!rows.length) return 0;
  // 没确认的「拿不准」切口：done 了但感知还在缓冲里的任务的 ep_to
  const rejected = new Set(core.store.all(`SELECT j.ep_to AS id FROM jobs j JOIN percepts p ON p.id = j.ep_to
                                             WHERE j.kind = ? AND j.scope_key = ? AND j.status = 'done' AND p.episode_id IS NULL`, EXTRACT_KIND, settingKey).map((r) => r.id));
  // 中间夹着已经封口（或在排队）的感知 = 确定的边界
  const assigned = core.store.all('SELECT id FROM percepts WHERE setting_key = ? AND id BETWEEN ? AND ? AND episode_id IS NOT NULL',
    settingKey, rows[0].id, rows.at(-1).id).map((r) => r.id);
  const gapBetween = (a, b) => assigned.some((x) => x > a && x < b) || inflight.some((j) => j.ep_from > a && j.ep_from < b);
  const drift = driftCuts(core, settingKey, rows[0].id);
  const gapMs = cfg.segment.gapMin * MIN;
  const maxMsgs = cfg.segment.maxMsgs;
  const maxChars = cfg.segment.maxChars;
  const minMsgs = param(core, 'segment.minMsgs');
  const pk = param(core, 'segment.participantWindow');
  const pj = param(core, 'segment.participantJaccardMax');
  const segs = [];
  let start = 0;
  let chars = [...String(rows[0].text ?? '')].length;
  let stop = false;
  for (let i = 1; i < rows.length && !stop; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    const len = [...String(b.text ?? '')].length;
    const count = i - start;
    let cut = null;
    if (b.at - a.at >= gapMs || a.historical !== b.historical || gapBetween(a.id, b.id)) cut = 'certain';
    else if (count >= maxMsgs || chars + len > maxChars) cut = 'size';
    // force（夜间整理封口、复核提前）时不在拿不准的地方切：段大一些，但一次就能全部封口
    else if (!opt.force && count >= minMsgs && !rejected.has(a.id) && (drift.has(b.id) || participantChange(rows, i, start, pk, pj))) cut = 'uncertain';
    if (cut) {
      segs.push({ rows: rows.slice(start, i), certain: cut !== 'uncertain' });
      if (cut === 'uncertain') stop = true;
      start = i;
      chars = len;
    } else chars += len;
  }
  if (!stop && start < rows.length) {
    const tail = rows.slice(start);
    const idle = at - tail.at(-1).at >= gapMs;
    if (opt.force || idle) segs.push({ rows: tail, certain: true });
  }
  let n = 0;
  for (const s of segs) if (enqueueSegment(core, settingKey, s, opt)) n += 1;
  return n;
}

function enqueueSegment(core, settingKey, seg, opt) {
  const ids = seg.rows.map((r) => r.id);
  const from = ids[0];
  const to = ids.at(-1);
  const priority = opt.boost ? BOOST_PRIORITY : segmentPriority(core, seg.rows, opt.at);
  const payload = {
    settingKey, perceptIds: ids, boundaryCertain: seg.certain, historical: seg.rows.every((r) => r.historical === 1),
    reserved: isReserved(core, settingKey, seg.rows),
  };
  const base = extractDedupeKey(settingKey, from, to);
  payload.baseKey = base;
  let r = enqueueJob(core.store, { kind: EXTRACT_KIND, use: 'extract', priority, dedupeKey: base, scopeKey: settingKey, epFrom: from, epTo: to, payload });
  if (!r.created && (r.status === 'failed' || r.status === 'cancelled') && (opt.retryFailed || opt.force || opt.boost)) {
    // 补跑失败批次（夜间整理第 1 步）/ 复核要求提前：同一个范围另起一个任务
    r = enqueueJob(core.store, { kind: EXTRACT_KIND, use: 'extract', priority, dedupeKey: `${base}#r${r.id}`, scopeKey: settingKey, epFrom: from, epTo: to, payload });
  }
  if (r.created) bumpMetric(core.store, 'encode.segment.jobs');
  return r.created;
}

/**
 * 实现 encode.segment。
 * @param {{settingKey?: string, force?: boolean, at?: number, boost?: boolean}} [opt]
 */
export function segment(core, opt = {}) {
  if (core.readOnly) return { jobs: 0 };
  const at = isNum(opt.at) ? opt.at : core.now();
  const keys = opt.settingKey ? [opt.settingKey] : openBufferSettings(core.store).map((r) => r.setting_key);
  let jobs = 0;
  for (const key of keys) {
    try {
      jobs += core.store.tx(() => segmentSetting(core, key, { at, force: !!opt.force, boost: !!opt.boost, retryFailed: !!opt.force }));
    } catch (e) {
      try { bumpMetric(core.store, 'encode.errors.segment'); } catch { /* 只读库 */ }
      core.log.warn('encode.segment.failed', { error: e?.code ?? e?.name ?? 'Error' });
    }
  }
  return { jobs };
}

/**
 * 把这些感知的提炼提到最前（复核发现可能的完成证据，§5.5 第 6 条）：还在缓冲里的强制封口并以最高优先级排队；
 * 已经在排队的，换成最高优先级的同一个任务。
 */
export function prioritizeExtraction(core, perceptIds, { at = core.now() } = {}) {
  if (!perceptIds?.length) return 0;
  const rows = core.store.all(`SELECT id, setting_key, episode_id FROM percepts WHERE id IN (${perceptIds.map(() => '?').join(',')})`, ...perceptIds);
  const settings = new Set(rows.filter((r) => r.episode_id == null).map((r) => r.setting_key));
  let n = 0;
  for (const key of settings) {
    n += core.store.tx(() => {
      let m = 0;
      for (const j of extractJobs(core, key, ['queued'])) {
        if (j.priority >= BOOST_PRIORITY) continue;
        if (!rows.some((r) => r.setting_key === key && r.id >= j.ep_from && r.id <= j.ep_to)) continue;
        cancelJob(core.store, j.id);
        // 提到最前的这一段直接封口（不再等模型确认边界），这批感知马上就能被提炼
        const payload = { ...jsonParse(j.payload_json, {}), boundaryCertain: true };
        const r = enqueueJob(core.store, { kind: EXTRACT_KIND, use: 'extract', priority: BOOST_PRIORITY, dedupeKey: `${payload.baseKey ?? j.dedupe_key}#p${j.id}`,
          scopeKey: key, epFrom: j.ep_from, epTo: j.ep_to, payload, runAfter: 0 });
        if (r.created) m += 1;
      }
      return m + segmentSetting(core, key, { at, force: true, boost: true });
    });
  }
  return n;
}
