// 提炼任务（§7.3–§7.5，§3「写」的主流程）：背景 → 提示词 → LLM（use='extract'）→ parseJsonl → verify → taintCheck →
// 对账（异步部分：向量相似度）→ 在 store.completeJob 的一个事务里写完全部输出（§12.8 第 3 条：任务已完成就跳过，重跑幂等）。
// 预算不允许、没有 LLM：任务推迟（不花钱、不写东西，感知照常在缓冲里、原文照常可检索）。LLM 失败：按 1 / 4 / 16 分钟退避重排；
// 重试用完了，这一段搁置（D136，stalled.js）：不挡后面的段，按更长的退避再试，什么都不替它编。
// 输出被上限截断（D141）：这一次什么都不写，这一段对半拆成两段各自重做；一条消息还截断的走失败 / 搁置。
import { enqueueJob, cancelJob, completeJob, failJob } from '../store/jobs.js';
import { bumpMetric, registerPromptVersion } from '../store/kv.js';
import { parseRef } from '../store/refs.js';
import {
  param, isNum, jsonParse, clip, mref, rstr, HOUR, clamp, mergeNorms, normToInput, restrictionRank, stricterRestriction,
  modeOfPercept, isOccurrenceKind, quoteMatches, TERMINAL_PLAN, TRUST,
} from './util.js';
import {
  selfIdOf, writeEpisode, writeAssertion, addSource, noteConfirmed, supersede, markChanged, linkSameType, sameTypeOf, assertionRow, assertionSubjects,
  exposureOfSources, involvesOthers, quotaAdd,
} from './write.js';
import { transitionPlan, formIntention } from './plans.js';
import { buildExtractPrompt, EXTRACT_STATIC } from './prompt.js';
import { parseJsonl } from './parse.js';
import { verify } from './verify.js';
import { taintCheck } from './taint.js';
import { reconcile, reconcileSync } from './reconcile.js';
import { segment, splitPoint, extractDedupeKey } from './segment.js';
import { markStalled, clearStalled } from './stalled.js';

const FACTISH = new Set(['fact', 'plan', 'self', 'rel']);

const errCode = (e) => e?.code ?? e?.name ?? 'Error';
// 两次调用之间的间隔（§10.6）：调用方在等这次提炼的结果，定时器不 unref——进程里只剩它在等时（命令行工具、批量补提炼），
// unref 的定时器撑不住事件循环，runJobs 的 Promise 就悬空了。要停就靠 signal
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const aborted = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
  if (signal?.aborted) { reject(aborted()); return; }
  const onAbort = () => { clearTimeout(t); reject(aborted()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

// ── 推迟、失败 ────────────────────────────────────────────────────────────

/** 推迟：这个任务作废，同一个范围另排一个，到点再跑（不消耗重试次数）。 */
function defer(core, job, payload, reason) {
  const n = (payload.deferrals ?? 0) + 1;
  const base = param(core, 'extract.deferMs');
  const delay = Math.min(6 * HOUR, base * 2 ** Math.min(n - 1, 6));
  core.store.tx(() => {
    cancelJob(core.store, job.id);
    enqueueJob(core.store, {
      kind: job.kind, use: job.use ?? 'extract', priority: job.priority, dedupeKey: `${payload.baseKey ?? job.dedupe_key}#d${job.id}`,
      scopeKey: job.scope_key, epFrom: job.ep_from, epTo: job.ep_to, payload: { ...payload, deferrals: n }, runAfter: core.now() + delay,
    });
  });
  bumpMetric(core.store, `encode.extract.deferred.${reason}`);
  core.log.info('encode.extract.deferred', { jobId: job.id, reason });
  return { status: 'deferred', reason };
}

/**
 * 失败：任务自己按 1 / 4 / 16 分钟退避重排；重试用完了，这一段搁置起来（D136，stalled.js：不挡后面的段，按退避再试）。
 * 搁置段的重试任务（payload.stalledRound）一轮只试一次，失败了直接记下一轮——轮与轮之间的退避由 stalled.js 管。
 */
function fail(core, job, code, usage, retry = true) {
  const payload = jsonParse(job.payload_json, {});
  const stalledRound = Number.isInteger(payload.stalledRound);
  const st = core.store.tx(() => {
    const s = failJob(core.store, job.id, { errorCode: code, retry: retry && !stalledRound, usage });
    if (s === 'failed') markStalled(core, { settingKey: payload.settingKey ?? job.scope_key, from: job.ep_from, to: job.ep_to, code });
    return s;
  });
  bumpMetric(core.store, 'encode.extract.failed');
  core.log.warn('encode.extract.failed', { jobId: job.id, error: code, next: st });
  return { status: 'failed', reason: code };
}

// ── 背景、候选档案 ────────────────────────────────────────────────────────

function terms(core, text) {
  try { return [...new Set(core.mods.lang.queryTerms(core, String(text ?? '')))]; } catch { return []; }
}

/** 一条记忆涉及的实体的名字（污点检查的「实体名」）。 */
function namesOfRef(core, ref) {
  const r = parseRef(ref);
  let ids = [];
  if (r?.kind === 'assertion') ids = core.store.all('SELECT DISTINCT entity_id FROM assertion_entities WHERE assertion_id = ?', r.id).map((x) => x.entity_id);
  else if (r?.kind === 'episode') ids = jsonParse(core.store.get('SELECT participants_json FROM episodes WHERE id = ?', r.id)?.participants_json, []);
  else if (r?.kind === 'entity') ids = [r.id];
  const self = selfIdOf(core);
  ids = ids.filter((x) => x && x !== self).slice(0, 8);
  if (!ids.length) return [];
  return core.store.all(`SELECT DISTINCT text_raw FROM entity_names WHERE entity_id IN (${ids.map(() => '?').join(',')}) AND reserved = 0 LIMIT 24`, ...ids)
    .map((x) => x.text_raw).filter((t) => [...t].length >= 2);
}

/** 第二组背景的区分性词（预先算好，交给 taintCheck）：本段原文和第一组背景里本来就有的词不算。 */
async function privateTerms(core, items, allowedText) {
  if (!items.length) return;
  const toks = new Set();
  for (const b of items) for (const t of terms(core, b.text)) toks.add(t);
  let stats = null;
  try { stats = await core.mods.worker.termStats(core, [...toks]); } catch { stats = null; }
  // 只给 IDF，不给 docs：「docs ≤ 1 也算区分性词」在库还小的时候几乎对每个二元组都成立（跨词的「递拿」也算），
  // 会把正常的叙述整句删掉（S1：「晚上主人说快递拿到了。」）。库小时只靠数字和名字拦，见模块与接口 D74
  const idf = stats instanceof Map && stats.size ? (t) => stats.get(t)?.idf ?? 0 : undefined;
  const exclude = new Set(terms(core, allowedText));
  for (const b of items) {
    try { b.terms = core.mods.lang.distinctiveTerms(core, String(b.text ?? ''), { idf, names: namesOfRef(core, b.ref), exclude }); } catch { b.terms = undefined; }
  }
}

/** 候选档案（§5.2 第 2–4 步，给提示词的「候选档案」一栏）：正文里的名字 + 向量候选、说话人名下的关系档案、有管理权限的人。 */
async function gatherCandidates(core, seg, rows, opt) {
  const self = selfIdOf(core);
  const speakerIds = new Set(rows.map((p) => p.actor_entity_id).filter(Boolean));
  const found = new Map();
  const add = (id, score) => {
    if (!id || id === self || speakerIds.has(id)) return;
    found.set(id, Math.max(found.get(id) ?? -Infinity, score));
  };
  try {
    // 逐条扫：说话人是这条消息里「我表哥」的锚点（名字匹配器的 anchors）；「阿明的表哥」挂在紧挨着的名字下面
    const matcher = core.mods.entities.nameMatcher(core);
    const hits = [];
    for (const p of rows) {
      if (!p.text) continue;
      const anchors = p.actor_self ? [self] : p.actor_entity_id ? [p.actor_entity_id] : [];
      for (const h of matcher.scan(p.text, { settingKey: seg.settingKey, anchors }) ?? []) hits.push({ h, p });
    }
    for (const { h } of hits) add(h.entityId, 1 + (h.score ?? 0));
    // 第 4 步的向量候选：名字按名字找；关系词按（锚点，关系）找（同一个锚点下的同关系档案、锚点冲突是负分）
    const queries = new Map();
    for (const { h, p } of hits) {
      const q = h.via === 'relation'
        ? (Number.isInteger(h.anchor) ? { name: null, relation: h.name, anchorEntityId: h.anchor } : null)
        : { name: h.name, anchorEntityId: null, relation: null };
      if (!q) continue;
      const k = JSON.stringify(q);
      if (!queries.has(k) && queries.size < 5) queries.set(k, { ...q, context: clip(p.text, 200), settingKey: seg.settingKey });
    }
    for (const q of queries.values()) {
      try {
        const cs = await core.mods.entities.candidates(core, q, { signal: opt.signal });
        for (const c of cs ?? []) add(c.entityId, c.score ?? 0);
      } catch { /* 嵌入不可用：只用名字表 */ }
    }
  } catch (e) { core.log.debug('encode.extract.names', { error: errCode(e) }); }
  if (speakerIds.size) {
    const ids = [...speakerIds];
    for (const d of core.store.all(`SELECT entity_id FROM entity_descriptors WHERE anchor_entity_id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 30`, ...ids)) add(d.entity_id, 0.5);
  }
  try { for (const id of core.mods.entities.principals(core)) add(id, 0.4); } catch { /* 没有 */ }
  const max = param(core, 'extract.maxCandidates');
  const ids = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([id]) => id);
  return ids.map((id) => {
    const e = core.store.get('SELECT kind, display_name, authority FROM entities WHERE id = ?', id) ?? {};
    const name = core.store.get('SELECT text_raw FROM entity_names WHERE entity_id = ? AND (scope_setting_key = ? OR scope_setting_key = \'\') ORDER BY count DESC LIMIT 1', id, seg.settingKey)?.text_raw
      ?? e.display_name ?? null;
    // 只有本人自称的关系标成「自称」（认得 ≠ 权利，§5.2：模型不该把自称当成别人确认过的事）
    const desc = core.store.all(`SELECT d.relation, a.display_name, a.is_self, MIN(d.basis = 'self-claim') AS claimed FROM entity_descriptors d
                                   LEFT JOIN entities a ON a.id = d.anchor_entity_id WHERE d.entity_id = ? GROUP BY d.anchor_entity_id, d.relation
                                   ORDER BY MAX(d.last_at) DESC LIMIT 2`, id)
      .map((d) => `${d.claimed ? '自称是' : ''}${d.is_self ? '你' : (d.display_name ?? '某人')}的${d.relation}`);
    const bits = [e.kind, ...desc];
    if (e.authority === 'principal') bits.push('对你有管理权限');
    const label = name ?? desc[0] ?? `某个${e.kind ?? '人'}`;
    return { entityId: id, label, text: `${label}（${bits.filter(Boolean).join('；')}）` };
  });
}

async function gatherBackground(core, seg, rows, opt) {
  let bg = { known: [], private: [] };
  try {
    const r = await core.mods.retrieve.backgroundForExtraction(core, { settingKey: seg.settingKey, perceptIds: seg.perceptIds }, { signal: opt.signal });
    if (r) bg = { known: [...(r.known ?? [])], private: [...(r.private ?? [])] };
  } catch (e) {
    bumpMetric(core.store, 'encode.degraded.background');
    core.log.info('encode.extract.background', { error: errCode(e) });
  }
  let candidates = [];
  try { candidates = await gatherCandidates(core, seg, rows, opt); } catch (e) { core.log.info('encode.extract.candidates', { error: errCode(e) }); }
  const maxBg = param(core, 'extract.maxBackground');
  bg.known = bg.known.slice(0, maxBg);
  bg.private = bg.private.slice(0, maxBg).map((b) => ({ ...b }));
  await privateTerms(core, bg.private, [rows.map((p) => p.text ?? '').join('\n'), ...bg.known.map((k) => k.text)].join('\n'));
  return { known: bg.known, private: bg.private, candidates };
}

// ── LLM ──────────────────────────────────────────────────────────────────

async function callLlm(core, prompt, signal) {
  const cfg = core.config.get();
  const st = core.state.encode;
  const min = cfg.extract.minSpacingMs;
  const wait = st.lastCallAt ? st.lastCallAt + min - core.now() : 0;
  if (wait > 0) await sleep(Math.min(wait, min), signal);   // 两次调用至少隔 minSpacingMs（§10.6）
  st.lastCallAt = core.now();
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => ac.abort(), cfg.extract.timeoutMs);
  t.unref?.();
  try {
    return await core.ports.llm.complete({ use: 'extract', system: prompt.system, messages: prompt.messages, maxTokens: param(core, 'extract.maxTokens'), signal: ac.signal });
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}
const estimateTokens = (s) => {
  const t = String(s ?? '');
  const cjk = (t.match(/[㐀-鿿]/g) ?? []).length;
  return cjk + Math.ceil((t.length - cjk) / 4);
};

// ── 输出被截断（D141） ──────────────────────────────────────────────────────

/**
 * 这次输出是不是被 maxTokens 截断了。端口给了停止原因（stopReason）就照它；没给的退路：最后一行不是一条完整的 JSONL、
 * 而且输出量到了上限的 extract.truncationNearRatio，才算截断——输出远没到上限的坏行是模型自己写坏的，照旧只跳过那一行。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{text?: string, usage?: {out?: number}, stopReason?: string}|null|undefined} res
 * @param {number} maxTokens
 * @returns {boolean}
 */
function outputTruncated(core, res, maxTokens) {
  const why = res?.stopReason;
  if (why === 'length') return true;
  if (why != null) return false;
  const rows = String(res?.text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^```/.test(s) && s !== '[' && s !== ']');
  const last = rows.at(-1);
  if (!last || parseJsonl(last).errors === 0) return false;
  const out = isNum(res?.usage?.out) && res.usage.out > 0 ? res.usage.out : estimateTokens(res?.text);
  return isNum(maxTokens) && maxTokens > 0 && out >= maxTokens * param(core, 'extract.truncationNearRatio');
}

/**
 * 截断了：这一次什么都不写（写了半截的话，前半段的事实已经进库、重做时再出现一次只能靠对账去重，保证不了），
 * 这一段按消息数对半拆成两段各排一个任务（拆的位置见 segment.splitPoint），本任务记成完成（用量照记）；
 * 只剩一条消息拆不了，走失败：直接搁置（D136，TRUNCATED 算稳定被拒）——原样重试只会再截断一次。
 * 拆出的前一段的结尾是我们切的，算确定的边界；后一段的结尾就是原来那段的结尾，原来拿不准、模型又没来得及确认的，仍拿不准。
 */
function splitTruncated(core, job, payload, rows, { res, usage, tailCertain }) {
  const k = rows.length >= 2 ? splitPoint(rows) : null;
  if (k == null) return fail(core, job, 'TRUNCATED', usage, false);
  const settingKey = payload.settingKey ?? job.scope_key;
  const halves = [rows.slice(0, k), rows.slice(k)];
  const depth = (payload.splitDepth ?? 0) + 1;
  completeJob(core.store, job.id, () => {
    // 这一段（如果是搁置着在重试的）由拆出的两段接手：各自失败了各自搁置
    clearStalled(core, settingKey, job.ep_from, job.ep_to);
    for (const [i, h] of halves.entries()) {
      const ids = h.map((p) => p.id);
      const base = `${extractDedupeKey(settingKey, ids[0], ids.at(-1))}#t${job.id}`;
      enqueueJob(core.store, {
        kind: job.kind, use: job.use ?? 'extract', priority: job.priority, dedupeKey: base, scopeKey: job.scope_key, epFrom: ids[0], epTo: ids.at(-1),
        payload: { settingKey, perceptIds: ids, boundaryCertain: i === 0 ? true : tailCertain, historical: h.every((p) => p.historical === 1),
          reserved: !!payload.reserved, baseKey: base, splitDepth: depth },
      });
    }
    return null;
  }, { model: res?.model, ...usage });
  bumpMetric(core.store, 'encode.extract.split');
  core.log.warn('encode.extract.split', { jobId: job.id, percepts: rows.length, at: k, depth });
  return { status: 'split', reason: 'truncated' };
}

// ── 写入（一个事务） ────────────────────────────────────────────────────────

function attentionW(core, p) {
  const att = core.config.get().activation.attention;
  return att[p?.attention_class] ?? att.attendedAmbient;
}
function closenessOf(core, id) {
  if (!id) return 0;
  return core.store.get('SELECT closeness FROM entities WHERE id = ?', id)?.closeness ?? 0;
}
function authorityOf(core, id) {
  if (!id) return 'none';
  try { return core.mods.entities.bondOf(core, id)?.authority ?? 'none'; } catch { return 'none'; }
}
/** 社交信息（她认识的人的亲友、宠物、生活）：主体挂在一个她认识的人名下（§6.2 的 w_self 社交起点）。 */
function socialSubject(core, ids) {
  if (!ids.length) return false;
  return !!core.store.get(`SELECT 1 FROM entity_descriptors d JOIN entities a ON a.id = d.anchor_entity_id
                             WHERE d.entity_id IN (${ids.map(() => '?').join(',')}) AND (a.closeness > 0 OR a.is_self = 1) LIMIT 1`, ...ids);
}
function moderates(p) {
  const actor = jsonParse(p?.actor_json, null);
  return !!actor?.claims?.some((c) => c?.kind === 'role-in-setting' && (c.moderates === true || c.isOwner === true));
}

/**
 * 一批输出的全部写入（在 completeJob 的事务里，同步）。
 * @returns {{episodeId: number, facts: number, dup: number, intentions: number}}
 */
function applyBatch(core, b) {
  const { seg, prompt, lines, pre, job, model } = b;
  const cfg = core.config.get();
  const self = selfIdOf(core);
  const rows = prompt.percepts;
  const pById = new Map(rows.map((p) => [p.id, p]));
  const extractVer = prompt.promptVer;
  const now = core.now();
  const counts = { facts: 0, dup: 0, intentions: 0, notified: 0 };

  // 1) 实体（§5.2 第 2、3、5 步）；没认出的说话人也落成档案
  //    speaker（ent 行的 "is"，verify 核过是本段的说话人）：这一行说的就是在场的那个人——自我介绍、锚点当面指认，
  //    分量由 entities 按证据消息是谁说的定（自称 / 锚点确认 / 旁人，§5.2「链接分两层」）
  const ents = lines.filter((l) => l.type === 'ent').map((l) => ({
    local: l.id, name: l.name, kind: l.kind, descriptor: l.anchor ? { anchor: l.anchor, relation: l.relation } : null, msgRefs: l.msgRefs,
    ...(typeof l.individual === 'boolean' ? { individual: l.individual } : {}),
    ...(typeof l.speaker === 'string' ? { speaker: l.speaker } : {}),
    verdict: { match: l.matchCode ? prompt.candidateCodes.get(l.matchCode) ?? null : null, fullName: l.full_name ?? l.name ?? undefined, confidence: l.confidence },
  }));
  for (const [code, id] of prompt.speakers) {
    if (code === '我' || id != null) continue;
    const name = prompt.labels.get(code);
    const refs = [...prompt.msgRefs].filter(([, pid]) => prompt.actorCodes.get(pid) === code).map(([m]) => m);
    ents.push({ local: code, name: name && name !== code ? name : null, kind: 'person', individual: true, descriptor: null, msgRefs: refs, verdict: { match: null, confidence: 0.5 } });
  }
  let entMap = new Map();
  // msgRefs：谁提到的、什么时候、编码强度（S7「知道是这个朋友说的」、第一人称的关系描述）；candidateCodes：锚点可以是候选档案（第 12 条「已知」）；
  // actorCodes：入库时没认出来的说话人，按本批里给他立的档认是谁说的
  if (ents.length) {
    entMap = core.mods.entities.resolveExtracted(core, ents, {
      speakers: prompt.speakers, settingKey: seg.settingKey, at: rows.at(-1).at, jobId: job.id,
      msgRefs: prompt.msgRefs, candidateCodes: prompt.candidateCodes, actorCodes: prompt.actorCodes,
    }) ?? new Map();
  }
  const idOf = (c) => {
    if (!c) return null;
    if (c === '我') return self;
    if (prompt.speakers.has(c)) return prompt.speakers.get(c) ?? entMap.get(c) ?? null;
    if (prompt.candidateCodes.has(c)) return prompt.candidateCodes.get(c);
    return entMap.get(c) ?? null;
  };
  const label = (c) => prompt.labels.get(c) ?? '有人';
  const bgAssertion = (c) => { const r = parseRef(prompt.bgCodes.get(c)); return r?.kind === 'assertion' ? r.id : null; };
  const batchFacts = new Map();
  const targetAssertion = (c) => batchFacts.get(c) ?? bgAssertion(c);

  // 2) 场合规矩：当场生效（评审:UV-09），先于事实写，事实的规范引用的就是新版本
  const notifies = [];
  for (const l of lines.filter((x) => x.type === 'norm_update' && x.target.kind === 'setting')) {
    const byId = idOf(l.by);
    const evidenceP = pById.get(l.evidence[0]);
    const auth = authorityOf(core, byId);
    const authority = auth === 'principal' ? 'principal' : (auth === 'delegated' || moderates(evidenceP)) ? 'moderator' : 'none';
    const change = { restriction: l.change.restriction, allow: l.change.allow.map(idOf).filter(Boolean), deny: l.change.deny.map(idOf).filter(Boolean) };
    if (l.change.rule) {
      core.mods.discretion.writeSettingRule(core, seg.settingKey,
        { text: l.change.rule, restriction: change.restriction ?? (l.direction === 'tighten' ? 'soft' : 'none'), scope: { allow: change.allow, deny: change.deny } },
        { source: 'learned', authorEntityId: byId, authority, at: l.at });
    } else {
      core.mods.discretion.applyNormUpdate(core, { target: { kind: 'setting', settingKey: seg.settingKey }, direction: l.direction, change, quote: l.quote },
        { speakerEntityId: byId, at: l.at, perceptId: l.evidence[0] });
    }
    for (const n of l.notify ?? []) notifies.push({ ...n, ref: null, perceptId: l.evidence[0], sourceEntityId: byId });
  }

  // 3) 事实的输入（先算好：情节的规范取它们本身里最严的；用到的背景只影响用到它的事实）
  const factLines = lines.filter((l) => FACTISH.has(l.type));
  const emotion = lines.find((l) => l.type === 'emotion') ?? null;
  const inputs = [];
  for (const l of factLines) {
    const subjects = [...new Set(l.subjects.map(idOf).filter(Boolean))];
    if (!subjects.length) continue;
    const speakerId = idOf(l.speaker);
    const asserterId = idOf(l.asserter) ?? speakerId;
    const evidence = l.evidence.map((id) => pById.get(id)).filter(Boolean);
    const usedBg = [...new Set((l.used_bg ?? []).map((c) => prompt.bgCodes.get(c) ?? c).filter((r) => parseRef(r)))];
    const sources = evidence.map((p) => ({
      perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in,
      speaker: p.actor_self ? self : (p.actor_entity_id ?? speakerId), asserter: asserterId,
      mode: l.mode === 'inferred' || l.mode === 'self_generated' ? l.mode : modeOfPercept(p), hop: l.hop,
      quote: p.id === l.quotePercept ? l.quote : null, confidence: l.confidence, usedBg, at: p.at,
    }));
    const exp = exposureOfSources(core, sources);
    const retracted = evidence.some((p) => p.text_state === 'retracted');
    const own = {
      ...exp, restriction: retracted ? stricterRestriction(l.norm.restriction, 'soft') : l.norm.restriction,
      allow: l.norm.allow.length ? l.norm.allow.map(idOf).filter(Boolean) : null, deny: l.norm.deny.map(idOf).filter(Boolean),
      restrictionQuote: l.norm.quote, summary: l.norm.summary, attribute: l.attribute, sensitivity: l.sensitivity,
    };
    if (!own.deny.length) delete own.deny;
    if (!own.allow) delete own.allow;
    // 当初提出限制的人（之后能放宽它的人之一，§5.6）：说出这条限制的那个说话人
    const restrictedBy = own.restriction !== 'none' && l.norm.restriction !== 'none' ? speakerId : null;
    let norm = own;
    if (usedBg.length) {
      // 污点：用到了只供理解的背景 → 这条事实的规范取最严（§7.3）
      const bgNorms = usedBg.map((r) => { try { return normToInput(core.mods.discretion.normOf(core, parseRef(r))); } catch { return { restriction: 'soft' }; } });
      norm = mergeNorms([own, ...bgNorms]);
    }
    if (restrictedBy && restrictionRank(norm.restriction) <= restrictionRank(own.restriction)) norm = { ...norm, restrictedBy };
    const subjIds = [...subjects];
    const selfRel = clamp(isNum(l.selfRelevance) ? l.selfRelevance
      : (socialSubject(core, subjIds) ? cfg.activation.selfRelevance.social : cfg.activation.selfRelevance.min), cfg.activation.selfRelevance.min, cfg.activation.selfRelevance.max);
    const w = core.mods.dynamics.encodingWeight(core, {
      wAtt: Math.max(...evidence.map((p) => attentionW(core, p))), selfRelevance: selfRel, imp: l.imp,
      closeness: speakerId === self ? 1 : closenessOf(core, speakerId), emotionIntensity: emotion?.intensity ?? 0,
    });
    let kindHint = l.kind_hint;
    const input = {
      subjects, objectEntityId: idOf(l.object), mentions: (l.mentions ?? []).map(idOf).filter(Boolean),
      predicate: l.predicate ?? (l.type === 'rel' ? l.relation : null) ?? l.attribute ?? kindHint, value: l.value ?? null, text: l.text, kindHint,
      recurrence: l.recurrence ?? null, certainty: l.certainty, confidence: l.confidence, imp: l.imp, eventTime: l.eventTime, plannedTime: l.plannedTime,
      validFrom: l.validFrom, survival: l.survival, plan: l.kind_hint === 'plan' ? { agent: idOf(l.agent) ?? subjects[0], status: l.status } : null,
      futureQ: l.futureQ ?? [], sources, norm, w, jobId: job.id, extractVer, model, cardinality: l.cardinality,
      needsReview: l.needsReview || evidence.some((p) => p.text_state === 'edited'),
    };
    inputs.push({ l, input, own, speakerId });
  }

  // 3b) 档案又被提到了（§5.2「每被提到一次加一条痕迹」、S7b 的档案刷新）：ent 行落到的档案由 resolveExtracted 加过了；
  //     事实里直接用候选档案（c2）或在场的人（U3，被别人说起）指到的，这里补一条。说话人说自己的事不算被提到，她自己不加。
  //     证据时间、编码强度照证据消息（听说不打折）；同一来源同一天、同一档案 6 小时内只算一次由 dynamics 管
  noteMentions(core, { inputs, viaEnt: new Set(entMap.values()), pById, self, speakerOf: (p) => (p.actor_self ? self : p.actor_entity_id ?? entMap.get(prompt.actorCodes.get(p.id)) ?? null) });

  // 4) 情节（每一段都写：没有叙述也封口，免得这些感知永远留在缓冲里）
  const header = lines.find((l) => l.type === 'header');
  const narrative = lines.find((l) => l.type === 'narrative');
  const participants = [...new Set(rows.map((p) => (p.actor_self ? self : p.actor_entity_id ?? entMap.get(prompt.actorCodes.get(p.id)))).filter(Boolean))];
  const epSources = rows.map((p) => ({
    perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: p.actor_self ? self : (p.actor_entity_id ?? entMap.get(prompt.actorCodes.get(p.id)) ?? null),
    asserter: null, mode: modeOfPercept(p), hop: 0, quote: null, confidence: 1, at: p.at,
  }));
  const epExp = exposureOfSources(core, epSources);
  const epMerged = mergeNorms([{ ...epExp }, ...inputs.map((x) => ({ ...x.own, originExposure: undefined }))]);
  const epNorm = { ...epExp, restriction: epMerged.restriction, restrictionQuote: epMerged.restrictionQuote, allow: epMerged.allow, deny: epMerged.deny,
    sensitivity: epMerged.sensitivity, attribute: epMerged.attribute };
  if (rows.some((p) => p.text_state === 'retracted')) epNorm.restriction = stricterRestriction(epNorm.restriction, 'soft');
  const imps = inputs.map((x) => x.input.imp);
  const epW = core.mods.dynamics.encodingWeight(core, {
    wAtt: Math.max(...rows.map((p) => attentionW(core, p))), imp: isNum(header?.imp) ? header.imp : (imps.length ? Math.max(...imps) : cfg.activation.defaultImp),
    closeness: Math.max(0, ...participants.filter((x) => x !== self).map((x) => closenessOf(core, x))), emotionIntensity: emotion?.intensity ?? 0,
  });
  const episodeId = writeEpisode(core, {
    settingKey: seg.settingKey, kind: 'event', title: header?.title ?? '', header: header?.text ?? '', narrative: narrative?.text ?? '',
    headerVer: extractVer, tStart: rows[0].at, tEnd: rows.at(-1).at, participants, snapshotId: rows.at(-1).snapshot_id ?? null,
    emotion: emotion ? { valence: emotion.valence, intensity: emotion.intensity, text: emotion.text ?? undefined } : null,
    sources: epSources, norm: epNorm, w: epW, jobId: job.id, extractVer, model,
    extraEntities: inputs.flatMap((x) => x.input.subjects),
  });
  const episodeRef = rstr('episode', episodeId);

  // 5) 感知：归进情节、写规范（D10：提炼后由 encode 写，norm_state → assessed）
  const ids = rows.map((p) => p.id);
  core.mods.intake.assignEpisode(core, ids, episodeId);
  for (const p of rows) {
    const cites = inputs.filter((x) => x.l.evidence.includes(p.id));
    const exp = exposureOfSources(core, [{ perceptId: p.id }]);
    const merged = mergeNorms([{ ...exp }, ...cites.map((x) => ({ ...x.own, originExposure: undefined }))]);
    const norm = { ...exp, restriction: merged.restriction, restrictionQuote: merged.restrictionQuote, allow: merged.allow, deny: merged.deny,
      sensitivity: merged.sensitivity, attribute: merged.attribute,
      involvesOthers: involvesOthers(core, [p.actor_self ? null : p.actor_entity_id, ...cites.flatMap((x) => x.input.subjects)]) };
    if (!norm.allow) delete norm.allow;
    if (!norm.deny?.length) delete norm.deny;
    if (p.text_state === 'retracted') norm.restriction = stricterRestriction(norm.restriction, 'soft');
    core.mods.discretion.writeNorm(core, mref('percept', p.id), norm);
  }
  core.mods.intake.markAssessed(core, ids);

  // 6) 事实：对账的结论（实体解析之后主体变了的，同步补对一次）
  for (const { l, input, speakerId } of inputs) {
    const op = l.opKind ?? 'new';
    const opTargetId = l.opTarget ? bgAssertion(l.opTarget) : null;
    const p0 = pre.get(l.id);
    let d = p0 && p0.subjects.join(',') === input.subjects.join(',') ? p0.decision : reconcileSync(core, { ...input, op, opTargetId });
    let id = null;
    if (d.op === 'dup' && d.targetId) {
      for (const s of input.sources) addSource(core, { kind: 'assertion', id: d.targetId }, { ...s, jobId: job.id, extractVer }, { w: input.w, reason: pById.get(s.perceptId)?.kind === 'content' ? 'reread' : 'mention' });
      // 新来源带了更严的限制 → 收紧（收紧不需要权限）
      let cur = null;
      try { cur = core.mods.discretion.normOf(core, mref('assertion', d.targetId)); } catch { cur = null; }
      if (restrictionRank(input.norm.restriction) > restrictionRank(cur?.restriction ?? 'none')) {
        core.mods.discretion.tightenNorm(core, mref('assertion', d.targetId), { restriction: input.norm.restriction, reason: 'new-source', at: input.sources[0]?.at ?? now });
      }
      batchFacts.set(l.id, d.targetId);
      counts.dup += 1;
    } else {
      if (d.op === 'changed') {
        // 「变了但新值未知」：这次「换了」本身是一件事；旧值标 change_known，不取代
        if (!isOccurrenceKind(input.kindHint)) {
          input.kindHint = 'event';
          input.eventTime = input.eventTime ?? { start: input.sources[0]?.at ?? now, end: input.sources[0]?.at ?? now, precision: 'fuzzy' };
        }
      }
      if (d.needsReconcile) input.needsReconcile = true;
      id = writeAssertion(core, input);
      batchFacts.set(l.id, id);
      counts.facts += 1;
      if (d.op === 'contradict' && d.targetId) supersede(core, d.targetId, id, { at: now });
      else if (d.op === 'late' && d.targetId) supersede(core, id, d.targetId, { at: now });
      else if (d.op === 'changed' && d.targetId) markChanged(core, d.targetId, { at: now, source: { ...input.sources[0], jobId: job.id, extractVer }, w: input.w });
      else if (d.op === 'occurrence' && d.targetId) {
        linkSameType(core, d.targetId, id);
        for (const o of sameTypeOf(core, d.targetId).slice(0, 20)) linkSameType(core, o, id);
      }
      if (l.quota) quotaAdd(core, l.quota.day, l.quota.entityId, { facts: 1, hearsay: l.quota.hearsay ? 1 : 0 });
    }
    const ref = rstr('assertion', batchFacts.get(l.id));
    for (const n of l.notify ?? []) notifies.push({ ...n, ref, perceptId: l.evidence[0], sourceEntityId: speakerId });
  }

  // 7) 计划状态（完成这件事本身由情节编码；结果指向这段情节）
  for (const l of lines.filter((x) => x.type === 'plan_status')) {
    let id = targetAssertion(l.target);
    let row = id ? assertionRow(core, id) : null;
    if (!row) continue;
    if (!row.plan_status && row.kind_hint !== 'plan') { bumpMetric(core.store, 'encode.extract.planStatusNotPlan'); continue; }   // 只有计划有状态
    // 已经结案的那一次又收到「拿到了」：说的多半是同一类事里最近还开着的那一次（评审:SC-01）
    if (TERMINAL_PLAN.has(row.plan_status)) {
      const siblings = [...new Set([...sameTypeOf(core, id)])].map((x) => assertionRow(core, x)).filter((r) => r && r.plan_status && !TERMINAL_PLAN.has(r.plan_status) && r.recorded_at <= now);
      const open = siblings.sort((a, b) => b.recorded_at - a.recorded_at)[0];
      if (open) { id = open.id; row = open; }
    }
    const byId = idOf(l.speaker);
    const agent = row.plan_agent;
    transitionPlan(core, id, l.status, {
      at: l.at, evidencePerceptId: l.evidence.at(-1), outcomeRef: TERMINAL_PLAN.has(l.status) ? episodeRef : null,
      source: { jobId: job.id, speaker: byId, hop: byId && agent && byId !== agent ? 1 : 0 },
    });
  }

  // 8) 确认（「对，就是这样」）：本人或有权限的人确认 → confirmed + 痕迹 × 1.2；别人附和 → 只是又提到一次
  for (const l of lines.filter((x) => x.type === 'confirm')) {
    const id = targetAssertion(l.target);
    const row = id ? assertionRow(core, id) : null;
    if (!row) continue;
    const byId = idOf(l.by);
    const subs = assertionSubjects(core, id);
    const isSubject = !!byId && (subs.includes(byId) || subs.some((s) => { try { return core.mods.entities.rightsHolder(core, byId, s); } catch { return false; } }));
    const strong = isSubject || authorityOf(core, byId) !== 'none';
    const p = pById.get(l.evidence[0]);
    const base = core.mods.dynamics.encodingWeight(core, { wAtt: attentionW(core, p), imp: row.imp, closeness: closenessOf(core, byId) });
    const src = { perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: byId, asserter: byId, mode: modeOfPercept(p),
      hop: isSubject ? 0 : 1, quote: null, confidence: 0.9, at: l.at, jobId: job.id, extractVer };
    if (strong) {
      if ((TRUST[row.certainty] ?? 0) < TRUST.confirmed) core.store.run('UPDATE assertions SET certainty = ?, updated_at = ? WHERE id = ?', 'confirmed', now, id);
      // 本人重新确认 = 到这时还成立：记在 confirmed_at，状态的成立概率从这时重新算起；「什么时候成立的」（valid_from）不动（D142）
      noteConfirmed(core, id, l.at);
      // 给的是编码强度本身：× events.confirm 由 dynamics.addTrace 按 reason='confirm' 乘（D137：原来这里也乘，实际成了 1.44）
      addSource(core, { kind: 'assertion', id }, src, { w: base, reason: 'confirm' });
    } else addSource(core, { kind: 'assertion', id }, src, { w: base, reason: 'mention' });
  }

  // 9) 记忆和感知的规范变化：收紧直接生效，放宽只认有权限的（discretion 判）；没有权限的放宽只记成听来的
  const verified = new Set();   // 这批已经为谁形成了「核实」意图（模型自己再提一个就不重复）
  for (const l of lines.filter((x) => x.type === 'norm_update' && x.target.kind !== 'setting')) {
    let ref = null;
    if (l.target.kind === 'percept') ref = rstr('percept', prompt.msgRefs.get(l.target.code));
    else {
      const aid = batchFacts.get(l.target.code);
      ref = aid ? rstr('assertion', aid) : (prompt.bgCodes.get(l.target.code) ?? null);
    }
    if (!ref) continue;
    const byId = idOf(l.by);
    const change = { restriction: l.change.restriction ?? undefined, allow: l.change.allow.map(idOf).filter(Boolean), deny: l.change.deny.map(idOf).filter(Boolean) };
    if (!change.allow.length) delete change.allow;
    if (!change.deny.length) delete change.deny;
    if (!change.restriction) delete change.restriction;
    core.mods.discretion.applyNormUpdate(core, { target: { kind: 'memory', ref }, direction: l.direction, change, quote: l.quote },
      { speakerEntityId: byId, at: l.at, perceptId: l.evidence[0] });
    for (const n of l.notify ?? []) notifies.push({ ...n, ref, perceptId: l.evidence[0], sourceEntityId: byId });
    if (l.downgraded) counts.intentions += hearsayRelax(core, { l, ref, byId, label: label(l.by), idOf, pById, seg, job, extractVer, model, self, verified });
  }
  for (const l of lines.filter((x) => x.type === 'norm_update' && x.target.kind === 'setting' && x.downgraded)) {
    const settingEntity = core.store.get('SELECT entity_id FROM settings WHERE key = ?', seg.settingKey)?.entity_id ?? null;
    counts.intentions += hearsayRelax(core, { l, ref: null, settingEntity, byId: idOf(l.by), label: label(l.by), idOf, pById, seg, job, extractVer, model, self, verified });
  }

  // 10) 意图（代码再核一次 origin 和证据，formIntention 里）
  for (const l of lines.filter((x) => x.type === 'intent')) {
    const target = idOf(l.target);
    if (!target) continue;
    if (l.act === 'verify' && verified.has(target)) continue;
    const aboutId = l.about ? targetAssertion(l.about) : null;
    let about = aboutId ? { kind: 'assertion', id: aboutId } : null;
    if (!about && l.about) { const r = parseRef(prompt.bgCodes.get(l.about)); if (r && (r.kind === 'episode' || r.kind === 'assertion')) about = r; }
    const cues = (l.cues ?? []).map((c) => (typeof c === 'string' ? { entity: idOf(c) } : c)).filter((c) => c && (c.entity || c.settingAttrs));
    const at = Math.max(...l.evidence.map((id) => pById.get(id)?.at ?? 0));
    const id = formIntention(core, { about, targetEntityId: target, act: l.act, text: l.text, origin: l.origin,
      trigger: { timeWindow: l.window ? { start: l.window.start, end: l.window.end } : null, cues }, evidencePerceptIds: l.evidence },
    { at, historical: seg.historical, jobId: job.id });
    if (id) counts.intentions += 1;
  }

  // 11) 回填旧日志：时间窗已经过去、这批里又没有下文的计划直接结案为 unknown（§5.5 第 13 条）
  if (seg.historical) {
    const touched = new Set(lines.filter((x) => x.type === 'plan_status').map((x) => targetAssertion(x.target)));
    for (const { l } of inputs) {
      if (l.kind_hint !== 'plan') continue;
      const id = batchFacts.get(l.id);
      const row = id ? assertionRow(core, id) : null;
      const end = jsonParse(row?.planned_time_json, null)?.end;
      if (row && !touched.has(id) && !TERMINAL_PLAN.has(row.plan_status) && isNum(end) && end < now) {
        transitionPlan(core, id, 'unknown', { at: end, source: { historical: true, jobId: job.id } });
      }
    }
  }

  // 12) 需要你知道（T1 想改变她的东西 / T2 伤害、违法、安全）。有管理权限的人自己转给她的那条，admin 不记 T1（D118，返回 null）
  for (const n of notifies) {
    const id = core.mods.admin.notifyNeedToKnow(core, { kind: n.kind, ref: n.ref, perceptId: n.perceptId ?? null, sourceEntityId: n.sourceEntityId ?? null,
      reason: n.reason, severity: n.kind === 'T2' ? 2 : 1, at: pById.get(n.perceptId)?.at ?? now });
    if (id != null) counts.notified += 1;
  }

  // 13) 心境：她对这段经历的情绪反应（回填的旧事不推动现在的心境）
  if (emotion && !seg.historical && emotion.intensity > 0) {
    core.mods.dynamics.pushMood(core, { at: rows.at(-1).at, valence: emotion.valence, intensity: emotion.intensity, causeRefs: [episodeRef] });
  }
  return { episodeId, ...counts };
}

/**
 * 事实直接指到的档案（主体、宾语、提到的）补一条「又被提到了」（entities.noteMention，在批次事务里）。
 * 一批里一个档案一条：时间取最晚的证据，编码强度取最大的，来源是说这句话的人。
 */
function noteMentions(core, { inputs, viaEnt, pById, self, speakerOf }) {
  /** @type {Map<number, {at: number, w: number, sourceKey: string}>} */
  const seen = new Map();
  for (const { l, input } of inputs) {
    const ev = l.evidence.map((id) => pById.get(id)).filter(Boolean);
    if (!ev.length) continue;
    const speakers = new Set(ev.map(speakerOf).filter(Boolean));
    const at = Math.max(...ev.map((p) => p.at));
    const w = Math.max(0, ...ev.map((p) => p.w_enc || 0)) || 1;
    const by = ev.map(speakerOf).find((x) => x && x !== self) ?? speakerOf(ev[0]);
    const sourceKey = by ? rstr('entity', by) : rstr('percept', ev[0].id);
    for (const id of new Set([...input.subjects, input.objectEntityId, ...input.mentions])) {
      if (!Number.isInteger(id) || id === self || viaEnt.has(id) || speakers.has(id)) continue;
      const prev = seen.get(id);
      seen.set(id, prev ? { at: Math.max(prev.at, at), w: Math.max(prev.w, w), sourceKey: at > prev.at ? sourceKey : prev.sourceKey } : { at, w, sourceKey });
    }
  }
  for (const [id, m] of seen) {
    try { core.mods.entities.noteMention(core, id, m); } catch (e) { core.log.debug('encode.extract.mention', { error: errCode(e) }); }
  }
}

/** 被放宽的那件记忆的主体：事实的主体；情节的参与者；一条消息的说话人（都不算她自己）。 */
function subjectsOfTarget(core, r, self) {
  let ids = [];
  if (r?.kind === 'assertion') return assertionSubjects(core, r.id);
  if (r?.kind === 'episode') ids = jsonParse(core.store.get('SELECT participants_json FROM episodes WHERE id = ?', r.id)?.participants_json, []);
  else if (r?.kind === 'percept') ids = [core.store.get('SELECT actor_entity_id FROM percepts WHERE id = ?', r.id)?.actor_entity_id];
  return [...new Set(ids.filter((x) => Number.isInteger(x) && x !== self))];
}

/** 说话人这句话本身（这个场合的人听到的就是这些）：整句不长就用整句，否则用核对得上的原话片段，再不行截一段。撤回的没有。 */
function saidIn(core, p, quote) {
  const max = param(core, 'extract.quoteMax');
  const raw = p?.text_state === 'retracted' ? '' : String(p?.text ?? '').trim();
  if (!raw) return null;
  if ([...raw].length <= max) return raw;
  const q = typeof quote === 'string' ? quote.trim() : '';
  return q && quoteMatches(q, raw) ? clip(q, max) : clip(raw, max);
}

/**
 * 没有权限的放宽（§7.4 第 9 条、§9.6）：只记成听来的「有人说可以说了」，不生效；说话人声称是有管理权限的人允许的，
 * 形成一个「核实」意图，下次和那个人一对一时问一句（§5.5 第 12 条）。返回形成了几个意图。
 * 这条说法只用说话人自己的话写：被放宽的那件事往往是只供理解的背景（别处听来的私事），它的内容不抄进来——
 * 这里的人只听到了这句话（§5.6 派生内容的「谁知道」、§7.3 背景只供理解）。和那件事的联系留在结构里：
 * 同样的主体、来源的 used_bg、按那件事的规范取最严。
 */
function hearsayRelax(core, { l, ref, settingEntity = null, byId, label, idOf, pById, seg, job, extractVer, model, self, verified = new Set() }) {
  const r = ref ? parseRef(ref) : null;
  let subjects = r ? subjectsOfTarget(core, r, self) : [];
  if (!subjects.length) subjects = [r ? byId : (settingEntity ?? byId)].filter(Boolean);
  if (!subjects.length) return 0;
  const p = pById.get(l.evidence[0]);
  const said = saidIn(core, p, l.quote);
  const what = r ? '那件事' : '这里的规矩';
  const text = clip(said ? `${label}说「${said}」（没核实）` : `${label}说${what}可以放开说了（没核实）`, core.config.get().extract.factTextMax);
  let norm = null;
  if (r) { try { norm = normToInput(core.mods.discretion.normOf(core, r)); } catch { norm = { restriction: 'soft' }; } }
  const exp = exposureOfSources(core, [{ perceptId: p.id }]);
  const claimId = writeAssertion(core, {
    subjects, mentions: byId ? [byId] : [], predicate: '规范变化的说法', value: null, text, kindHint: 'norm_claim', certainty: 'hearsay', confidence: 0.4, imp: 3,
    sources: [{ perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker: byId, asserter: byId, mode: modeOfPercept(p), hop: 1,
      quote: l.quote, confidence: 0.4, usedBg: r ? [ref] : [], at: p.at }],
    norm: norm ? mergeNorms([{ ...exp }, norm]) : { ...exp }, w: 0.5, jobId: job.id, extractVer, model,
  });
  const authorityId = l.claimsAuthorityOf ? idOf(l.claimsAuthorityOf) : null;
  if (!authorityId || authorityOf(core, authorityId) === 'none' || authorityId === byId || seg.historical) return 0;
  const id = formIntention(core, {
    about: { kind: 'assertion', id: claimId }, targetEntityId: authorityId, act: 'verify',
    text: clip(said ? `核实一下：${label}说「${said}」，是真的吗` : `核实一下：${label}说你同意把${what}放开说，是真的吗`, 120), origin: 'self-care',
    trigger: { timeWindow: null, cues: [{ entity: authorityId }, { settingAttrs: { maxExposureRank: 0 } }] }, evidencePerceptIds: [p.id],
  }, { at: p.at, historical: seg.historical, jobId: job.id });
  if (id) verified.add(authorityId);
  return id ? 1 : 0;
}

// ── 入口 ─────────────────────────────────────────────────────────────────

/** 实现 encode.runExtract。 */
export async function runExtract(core, job, opt = {}) {
  const payload = jsonParse(job.payload_json, {});
  const settingKey = payload.settingKey ?? job.scope_key;
  let usage;
  try {
    const want = Array.isArray(payload.perceptIds) && payload.perceptIds.length ? payload.perceptIds : null;
    const rows = want
      ? core.store.all(`SELECT * FROM percepts WHERE id IN (${want.map(() => '?').join(',')}) AND episode_id IS NULL ORDER BY id`, ...want)
      : core.store.all('SELECT * FROM percepts WHERE setting_key = ? AND id BETWEEN ? AND ? AND episode_id IS NULL ORDER BY id', settingKey, job.ep_from, job.ep_to);
    if (!rows.length) {
      completeJob(core.store, job.id, () => { clearStalled(core, settingKey, job.ep_from, job.ep_to); return null; });
      return { status: 'skipped', reason: 'nothing-left' };
    }
    const seg = { settingKey, perceptIds: rows.map((p) => p.id), boundaryCertain: payload.boundaryCertain !== false, historical: !!payload.historical };
    if (!core.ports.llm) return defer(core, job, payload, 'no-llm');
    const background = await gatherBackground(core, seg, rows, opt);
    const prompt = buildExtractPrompt(core, seg, background);
    try { registerPromptVersion(core.store, 'extract', prompt.promptVer, EXTRACT_STATIC); } catch { /* 只读或版本已登记 */ }
    const est = estimateTokens(prompt.system) + estimateTokens(prompt.messages[0].content);
    let allowed = false;
    try { allowed = core.ports.budget.allow('extract', est, { sourceKey: settingKey, reserved: !!payload.reserved }); } catch { allowed = false; }
    if (!allowed) return defer(core, job, payload, 'budget');
    let res;
    try { res = await callLlm(core, prompt, opt.signal); } catch (e) { return fail(core, job, errCode(e)); }
    usage = { tokensIn: res?.usage?.in ?? 0, tokensCached: res?.usage?.cached ?? 0, tokensOut: res?.usage?.out ?? 0 };
    const parsed = parseJsonl(res?.text ?? '');
    // 输出被上限截断（D141）：不当成功——前面的照写、封口的话，后半段该提炼出的东西就永远丢了
    const truncated = outputTruncated(core, res, param(core, 'extract.maxTokens'));
    if (truncated) {
      bumpMetric(core.store, 'encode.extract.truncated');
      core.log.warn('encode.extract.truncated', { jobId: job.id, percepts: rows.length, stopReason: res?.stopReason ?? null, out: usage.tokensOut });
    }
    if (parsed.errors) bumpMetric(core.store, 'encode.extract.badLines', parsed.errors);
    if (!parsed.lines.length && !truncated) return fail(core, job, 'BAD_OUTPUT', usage);
    // 拿不准的边界：置信度 > 0.7 才封口；没确认就什么都不写（下次段落延长后再提炼）。
    // 截断了、又没来得及给边界那一行：还不知道，拆开重做时由后一段接着判断
    let boundaryOk = seg.boundaryCertain;
    if (!seg.boundaryCertain) {
      const b = parsed.lines.find((l) => l.type === 'boundary');
      boundaryOk = !!b && Number(b.confidence) > core.config.get().segment.llmBoundaryConfidence;
      if (!boundaryOk && !(truncated && !b)) {
        completeJob(core.store, job.id, () => null, { model: res?.model, ...usage });
        bumpMetric(core.store, 'encode.segment.boundaryRejected');
        return { status: 'skipped', reason: 'boundary-unconfirmed' };
      }
    }
    if (truncated) return splitTruncated(core, job, payload, rows, { res, usage, tailCertain: boundaryOk });
    const selfId = selfIdOf(core);
    const v = verify(core, parsed.lines, {
      seg, percepts: prompt.percepts, speakers: prompt.speakers, msgRefs: prompt.msgRefs, bgCodes: prompt.bgCodes,
      candidateCodes: prompt.candidateCodes, labels: prompt.labels, actorCodes: prompt.actorCodes, selfId,
    });
    for (const d of v.dropped) bumpMetric(core.store, `encode.verify.rule${d.rule}`);
    const privateBg = background.private.map((b, i) => ({ ...b, code: `p${i + 1}` }));
    const lines = taintCheck(core, v.accepted, privateBg);
    // 对账的异步部分（向量相似度）：主体都已经认得出的先做；实体解析之后主体才定下来的在事务里同步补对
    const pre = new Map();
    for (const l of lines) {
      if (!FACTISH.has(l.type) || l.directiveRejected) continue;
      const subjects = l.subjects.map((c) => (c === '我' ? selfId : prompt.speakers.get(c) ?? prompt.candidateCodes.get(c) ?? null));
      if (subjects.some((x) => x == null)) continue;
      const opTarget = l.opTarget ? parseRef(prompt.bgCodes.get(l.opTarget)) : null;
      const fact = { subjects: [...new Set(subjects)], predicate: l.predicate ?? l.attribute ?? l.kind_hint, text: l.text, kindHint: l.kind_hint,
        certainty: l.certainty, validFrom: l.validFrom, eventTime: l.eventTime, plannedTime: l.plannedTime,
        plan: l.kind_hint === 'plan' ? { agent: l.agent === '我' ? selfId : prompt.speakers.get(l.agent) ?? null } : null,
        op: l.opKind, opTargetId: opTarget?.kind === 'assertion' ? opTarget.id : null };
      try { pre.set(l.id, { subjects: fact.subjects, decision: await reconcile(core, fact, { at: core.now(), signal: opt.signal }) }); } catch { /* 事务里同步补对 */ }
    }
    const ids = seg.perceptIds;
    const out = completeJob(core.store, job.id, () => {
      // 搁置的段（D136）这次有了结果：不再搁置（和写入在同一个事务里）
      clearStalled(core, settingKey, job.ep_from, job.ep_to);
      // 等 LLM 的这段时间里，别的任务（复核提前的那一个）已经把其中的感知归进了情节：这批结果作废，不写两份
      const taken = core.store.get(`SELECT COUNT(*) AS n FROM percepts WHERE id IN (${ids.map(() => '?').join(',')}) AND episode_id IS NOT NULL`, ...ids).n;
      if (taken) return null;
      return applyBatch(core, { seg, prompt, lines, pre, job, model: res?.model ?? null });
    }, { model: res?.model, ...usage });
    if (out.skipped) return { status: 'skipped', reason: 'already-done' };
    if (!out.result) {
      bumpMetric(core.store, 'encode.extract.overlap');
      return { status: 'skipped', reason: 'already-extracted' };
    }
    bumpMetric(core.store, 'encode.extract.written');
    core.log.info('encode.extract.done', {
      jobId: job.id, percepts: rows.length, facts: out.result.facts, dup: out.result.dup, intentions: out.result.intentions,
      dropped: v.dropped.length, rewritten: v.rewritten, badLines: parsed.errors,
    });
    // 同一个场合后面可能还有排着的段（回填积压时一段接一段）
    core.store.afterCommit(() => { try { segment(core, { settingKey }); } catch { /* 下次 tick 再切 */ } });
    return { status: 'written' };
  } catch (e) {
    try { return fail(core, job, errCode(e), usage, e?.code !== 'NOT_IMPLEMENTED'); } catch { return { status: 'failed', reason: errCode(e) }; }
  }
}
