// 关口③（§9.5、§5.6 告诉过谁）：她的话回流成感知以后，记下告诉过谁、谁现在知道了；找出没经过审视的发言。
// 「告诉过谁」唯一的真相来源是她自己说出去的那条感知（outcome 'failed' 的从来不会生成感知，所以不算）。
import { parseRef, refOf, enqueueJob, completeJob } from '../store/index.js';
import { dcfg, clip, parseJson, hkey, metric, warn, errCode, soft, softAsync, newToken, TURN_TAINT_MARK, HOUR } from './util.js';
import { memoryFacts, selfId, settingInfo, descriptorTraits } from './facts.js';
import { circleOf, presenceMembers, audienceOf, audiencePeople, recordKnowledge } from './knowledge.js';
import { features, overlapScore, coverage, idfFor, sentenceVector, storedVectors, cosine } from './match.js';
import { expireMemoryCache } from './norms.js';

const LOG_KINDS = ['aware_private', 'omit', 'pending', 'reconsider', 'hold', 'unappraised'];
export const JOB_TOLD_SCAN = 'discretion.told-scan';
export const JOB_POSTCHECK = 'discretion.postcheck';

/** 记一笔分寸日志。 */
export function logDecision(core, e) {
  if (!e || !LOG_KINDS.includes(e.kind)) throw new TypeError('logDecision：kind 不对');
  const m = e.ref ? parseRef(e.ref) : null;
  core.store.run(`INSERT INTO discretion_log(at, kind, setting_key, memory_kind, memory_id, appraisal_id, utterance_id, trigger_entity_id, subject_entity_id, reason)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  Number.isFinite(e.at) ? Math.trunc(e.at) : core.now(), e.kind, e.settingKey ?? null, m?.kind ?? null, m?.id ?? null,
  e.appraisalId ?? null, e.utteranceId ?? null, e.triggerEntityId ?? null, e.subjectEntityId ?? null, clip(e.reason ?? '', 200));
}

function perceptRow(core, id) {
  return core.store.get('SELECT * FROM percepts WHERE id = ?', id) ?? null;
}

/** 这条感知是在哪些会话里说的（审视记录、感知自带的会话引用、绑定到这个场合的会话）。 */
function sessionsFor(core, p, u) {
  const out = new Set();
  if (u?.session_id) out.add(u.session_id);
  const sr = parseJson(p.session_ref_json, null);
  if (sr?.sessionId) out.add(String(sr.sessionId));
  if (!out.size) {
    for (const r of core.store.all("SELECT session_id FROM sessions WHERE setting_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 3", p.setting_key)) out.add(r.session_id);
  }
  return [...out];
}

/** 本周期已确认送达的注入条目（context.taintLedger）和它们当时的结论（injections 里的 verdict）。 */
function ledgerCandidates(core, sessions) {
  const out = new Map();
  for (const sid of sessions) {
    const ids = soft(core, 'context.taintLedger', () => core.mods.context.taintLedger(core, sid), []) ?? [];
    let verdicts = new Map();
    try {
      for (const r of core.store.all('SELECT i.items_json FROM injections i JOIN sessions s ON s.session_id = i.session_id WHERE i.session_id = ? AND i.seen = 1 AND i.cycle = s.cycle', sid)) {
        for (const it of parseJson(r.items_json, [])) if (it?.id) verdicts.set(it.id, it.verdict);
      }
    } catch { verdicts = new Map(); }
    for (const id of ids) {
      const m = parseRef(id);
      if (m && !out.has(id)) out.set(id, { mref: m, verdict: verdicts.get(id) ?? 'share' });
    }
  }
  return out;
}

/** 最近几轮的工具结果、她读到的素材（同一个会话场合里的 her-only / material 感知）。 */
function toolResultCandidates(core, p, n) {
  const out = new Map();
  for (const r of core.store.all(`SELECT id FROM percepts WHERE perceived_in = ? AND id < ? AND at >= ? AND (standing = 'material' OR visible_to = 'her-only')
                                    AND actor_self = 0 ORDER BY id DESC LIMIT ?`, p.setting_key, p.id, p.at - HOUR, n)) {
    out.set(refOf('percept', r.id), { mref: { kind: 'percept', id: r.id }, verdict: 'share' });
  }
  return out;
}

/** 这句话当时的听众（出现集合；没有就用最近亲自发过言的人）。 */
function listenersOf(core, p, memo) {
  const me = selfId(core, memo);
  const ps = presenceMembers(core, p.presence_set_id, memo);
  if (ps && !ps.private) return ps.members.filter((x) => x !== me);
  if (p.visible_to === 'her-only') return [];
  return audiencePeople(core, audienceOf(core, p.setting_key, p.at, memo), memo);
}

/**
 * 她以前讲给过谁这件事（这句之前的每一次，讲全了的和只说了个大概的都算）：每一次的听众，和这一次一样按那句话当时的
 * 出现集合算，没有出现集合的按当时最近亲自发过言的人。只说了个大概不扩充已知圈，但对同一批人再讲一遍也不算「又遇到一次」
 *（§6.4），所以「新听众」要按这里排除——不靠 dynamics 只在保留的精确痕迹里查重。那句话的感知已经删了的，按记下的出现集合。
 */
function earlierListeners(core, mref, p, memo) {
  const out = new Set();
  for (const r of core.store.all(`SELECT utterance_percept_id AS pid, presence_set_id FROM told_log WHERE owner_kind = ? AND owner_id = ? AND utterance_percept_id <> ?
                                    ORDER BY at DESC LIMIT 50`, mref.kind, mref.id, p.id)) {
    const q = r.pid != null ? core.store.get('SELECT * FROM percepts WHERE id = ?', r.pid) : null;
    const who = q ? listenersOf(core, q, memo) : presenceMembers(core, r.presence_set_id, memo)?.members ?? [];
    for (const x of who) out.add(x);
  }
  return out;
}

/**
 * 写告诉过谁：told_log + known_by(told_by_her)，讲给新听众的加一条小痕迹（每个听众一次，dynamics 执行上限），
 * 意图被执行了就记一次执行；相关的评估缓存失效。同一句话对同一条记忆只记一次。
 */
export function writeTold(core, p, matched) {
  if (!matched.length) return 0;
  const cfg = core.config.get();
  let n = 0;
  core.store.tx((db) => {
    const memo = new Map();
    const listeners = listenersOf(core, p, memo);
    for (const { mref, level } of matched) {
      if (db.get('SELECT id FROM told_log WHERE owner_kind = ? AND owner_id = ? AND utterance_percept_id = ?', mref.kind, mref.id, p.id)) continue;
      const before = circleOf(core, mref, new Map());
      const heard = earlierListeners(core, mref, p, memo);
      db.run('INSERT INTO told_log(owner_kind, owner_id, at, setting_key, presence_set_id, utterance_percept_id, level) VALUES (?, ?, ?, ?, ?, ?, ?)',
        mref.kind, mref.id, p.at, p.setting_key, p.presence_set_id ?? null, p.id, level === 'vague' ? 'vague' : 'full');
      n += 1;
      // 只有说得清楚的才扩充已知圈：说了个大概不等于对方知道了细节
      if (level !== 'vague') {
        const entries = [];
        if (p.visible_to === 'setting-audience') entries.push({ whoKind: 'setting', whoRef: p.setting_key, since: p.at, basis: 'told_by_her' });
        if (p.presence_set_id != null && p.visible_to !== 'her-only') entries.push({ whoKind: 'presence_set', whoRef: String(p.presence_set_id), since: p.at, basis: 'told_by_her' });
        if (entries.length) recordKnowledge(core, mref, entries);
      }
      // 讲给新听众：每个听众一次（对同一批人复述不算又遇到一次，§6.4）。以前听她讲过的（哪怕只是个大概）不算新听众
      const fresh = before.settings.has(p.setting_key) ? [] : listeners.filter((x) => !before.entities.has(x) && !heard.has(x));
      for (const who of fresh) {
        soft(core, 'dynamics.addTrace', () => core.mods.dynamics.addTrace(core, mref, {
          t: p.at, w: cfg.activation.events.retellNewAudience, sourceKey: hkey(core, 'retell', mref.kind, mref.id, who), reason: 'retell',
        }), null);
      }
      expireMemoryCache(core, mref);
      expireSubjectCache(core, mref, p.setting_key, memo);
      // 意图被执行了（对象在场才算，以人为单位，§5.5 第 8 条）
      if (mref.kind === 'intention') {
        const f = memoryFacts(core, mref, memo);
        const target = f.intention?.target_entity_id ?? null;
        if (target != null && listeners.includes(target)) {
          soft(core, 'encode.recordExecution', () => core.mods.encode.recordExecution(core, mref.id, {
            at: p.at, settingKey: p.setting_key, targetEntityId: target, utteranceRef: refOf('percept', p.id),
          }), null);
        }
      }
    }
  });
  if (n) metric(core, 'told.written', n);
  return n;
}

/** 任何 told_log 写入，都让同一主体在同一受众下的缓存失效（§9.3.3）。 */
function expireSubjectCache(core, mref, settingKey, memo) {
  const subjects = [...memoryFacts(core, mref, memo).subjects].slice(0, 10);
  if (!subjects.length) return;
  const now = core.now();
  const ph = subjects.map(() => '?').join(',');
  // 关于同一主体的：事实、人物卡（实体本身）、印象
  core.store.run(`UPDATE appraisals SET expires_at = ? WHERE cache_key IS NOT NULL AND (expires_at IS NULL OR expires_at > ?) AND setting_key = ? AND (
                    (memory_kind = 'assertion' AND memory_id IN (SELECT assertion_id FROM assertion_entities WHERE role = 'subject' AND entity_id IN (${ph})))
                    OR (memory_kind = 'entity' AND memory_id IN (${ph}))
                    OR (memory_kind = 'impression' AND memory_id IN (SELECT id FROM entity_impressions WHERE entity_id IN (${ph}))))`,
  now, now, settingKey, ...subjects, ...subjects, ...subjects);
}

/**
 * 把一句话和候选记忆比对（同步：区分性词、实体、词元重合）。是不是同一件事看重合分；说得多细看内容讲到了多少
 *（discretion.told.fullCoverage：这句话讲到了记忆内容的大部分算讲全了，§5.6「说得多细」）
 *（重合分的高低只说明对得上，不说明细节——同步比对拿不到 IDF 和向量，换个代词复述的整句话分数也到不了 2 倍门槛）。
 * 注入时给的是「说个大概」的，照样只算说了个大概。
 */
function matchSync(core, p, cands, memo) {
  const cfg = dcfg(core);
  const uf = features(core, p.text, { settingKey: p.setting_key, memo });
  const matched = [];
  for (const [, c] of cands) {
    const f = memoryFacts(core, c.mref, memo);
    if (!f.exists || !f.text) continue;
    const mf = features(core, f.text, { memo });
    const s = overlapScore(core, uf, mf, { memo });
    if (s < cfg.told.minOverlap) continue;
    const full = c.verdict !== 'share_vague' && (s >= cfg.told.minOverlap * 2 || coverage(uf, mf) >= cfg.told.fullCoverage);
    matched.push({ mref: c.mref, level: full ? 'full' : 'vague' });
  }
  return { uf, matched };
}

/**
 * 这句话说出去的那一轮带不带按轮污点（§9.6）：这句话所在的会话现在的标记（回流一般就在这一轮里）。读不到按带污点
 *（fail closed：最多是这句话不拿来当成长的依据）。返回带污点的那个会话，没有返回 null。
 */
function taintedSession(core, sessions) {
  for (const sid of sessions) {
    let tainted;
    try { tainted = !!core.mods.context.sessionInfo(core, sid)?.turnTainted; } catch { tainted = true; }
    if (tainted) return sid;
  }
  return null;
}

/**
 * 她自己的发言感知回流之后（intake 提交后通知）。同步、不抛错。
 *   - 回填的旧发言（historical=1）：当时没有关口②可对，不算「未经审视」、不补评估；也不和眼下这个会话本周期的注入比对
 *    （那些是现在的，不是那句话说出口之前的），只按内容排全库比对，补回「告诉过谁」；
 *   - 没经过关口②、又是在带按轮污点的一轮里说的：记一行 utterances（origin_path='unappraised'，reasons 带 'turn-tainted'），
 *     这样它和审过的发言一样，不拿来当成长的依据（§5.7）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../intake/index.js').PerceptRow} percept
 */
export function onSelfUtterance(core, percept) {
  try {
    if (core.readOnly || !percept?.id) return;
    const p = perceptRow(core, percept.id) ?? percept;
    if (p.kind !== 'self-utterance' && p.kind !== 'on-my-behalf') return;
    const cfg = dcfg(core);
    const memo = new Map();
    const historical = !!p.historical;
    // 对上审视记录：令牌优先；没有令牌按（场合、文本哈希、时间窗）
    let u = p.appraisal_token ? core.store.get('SELECT * FROM utterances WHERE token = ?', p.appraisal_token) : null;
    // 同一条感知重复投递：上次已经对上（或记过）的那一行
    if (!u) u = core.store.get('SELECT * FROM utterances WHERE matched_percept = ? ORDER BY id LIMIT 1', p.id) ?? null;
    if (!u) {
      u = core.store.get(`SELECT * FROM utterances WHERE setting_key = ? AND text_hash = ? AND matched_percept IS NULL AND at BETWEEN ? AND ?
                            AND (outcome IS NULL OR outcome IN ('sent','held')) ORDER BY abs(at - ?) LIMIT 1`,
      p.setting_key, p.text_hash, p.at - cfg.told.matchWindowMs, p.at + cfg.told.matchWindowMs, p.at);
    }
    const sessions = historical ? [] : sessionsFor(core, p, u);
    if (u) {
      core.store.run("UPDATE utterances SET matched_percept = ?, outcome = COALESCE(outcome, 'sent'), held_text = NULL WHERE id = ?", p.id, u.id);
    } else if (!historical) {
      if (p.kind === 'self-utterance') {
        // 有发出前拦截点的场合却对不上：「未经审视的发言」，记下来并按场合属性回头补评估（§9.5）
        const t = descriptorTraits(settingInfo(core, p.setting_key, memo)?.snapshot?.descriptor);
        if (!t || t.preSendGate) {
          logDecision(core, { kind: 'unappraised', settingKey: p.setting_key, reason: 'no-matching-appraisal', at: p.at });
          metric(core, 'unappraised');
          if (!t || t.publicLike || t.exposureRank >= 1) {
            soft(core, 'store.enqueueJob', () => enqueueJob(core.store, { kind: JOB_POSTCHECK, dedupeKey: hkey(core, 'postcheck', p.id), payload: { perceptId: p.id }, priority: 1 }), null);
          }
        }
      }
      const sid = taintedSession(core, sessions);
      if (sid != null) recordUnappraisedTaint(core, p, sid);
    }
    if (!p.text) return;
    const cands = new Map([...(historical ? [] : ledgerCandidates(core, sessions)), ...toolResultCandidates(core, p, cfg.told.recentToolResults)]);
    const { uf, matched } = matchSync(core, p, cands, memo);
    writeTold(core, p, matched);
    // 比对不上、但有区分性词的：排一个异步的比对（向量 + 全库）。这里拿不到 IDF（同步），只能认出数字和名字；
    // 话有一定长度的也排上，任务里先按 IDF 判一次有没有区分性词，没有就直接结束（不花嵌入）
    if (!matched.length && (uf.distinct.size || uf.entities.size || uf.terms.size >= cfg.told.scanMinTerms)) {
      soft(core, 'store.enqueueJob', () => enqueueJob(core.store, {
        kind: JOB_TOLD_SCAN, dedupeKey: hkey(core, 'told-scan', p.id), payload: { perceptId: p.id, candidates: [...cands.keys()].slice(0, 100) },
      }), null);
    }
  } catch (e) {
    warn(core, 'onSelfUtterance', { error: errCode(e) });
    metric(core, 'onSelfUtterance.error');
  }
}

/** 没经过关口②、在带污点的一轮里说出去的话：记一行 utterances 只为留下按轮污点的标记（不含正文）。 */
function recordUnappraisedTaint(core, p, sessionId) {
  core.store.run(`INSERT INTO utterances(token, setting_key, home_setting_key, at, channel_json, origin_path, text_hash, verdict, reasons_json,
                    outcome, session_id, matched_percept, created_at)
                  VALUES (?, ?, ?, ?, '{}', 'unappraised', ?, 'speak', ?, 'sent', ?, ?, ?)`,
  newToken(), p.setting_key, p.perceived_in ?? p.setting_key, p.at, p.text_hash ?? '', JSON.stringify(['unappraised', TURN_TAINT_MARK]),
  sessionId, p.id, core.now());
  metric(core, 'unappraised.tainted');
}

/**
 * 异步比对任务：先拿本周期注入过的条目比整句向量，再在全库里找（词法 + 稠密），只认很像的，记成「说了个大概」。
 */
export async function runToldScan(core, job, opt = {}) {
  const cfg = dcfg(core);
  const payload = parseJson(job.payload_json, {});
  const p = Number.isSafeInteger(payload.perceptId) ? perceptRow(core, payload.perceptId) : null;
  if (!p?.text) { completeJob(core.store, job.id, () => 0); return { told: 0 }; }
  const memo = new Map();
  // 先按 IDF 判有没有区分性词（数字、高 IDF 的词、名字）；没有的是寒暄这类话，不值得比对
  const ms = cfg.told.scanMs;
  const idf = await idfFor(core, [p.text], ms.idf);
  const uf = features(core, p.text, { idf, settingKey: p.setting_key, memo });
  if (!uf.distinct.size && !uf.entities.size) { completeJob(core.store, job.id, () => 0); return { told: 0 }; }
  const vec = await sentenceVector(core, p.text, ms.vector, opt.signal);
  const matched = new Map();
  const candRefs = (payload.candidates ?? []).filter((r) => parseRef(r));
  if (vec && candRefs.length) {
    const stored = await storedVectors(core, candRefs, ms.vector);
    for (const r of candRefs) {
      const c = cosine(vec.vec, stored.get(r));
      if (c != null && c >= cfg.told.vectorSim) matched.set(r, { mref: parseRef(r), level: 'vague' });
    }
  }
  if (!matched.size) {
    const hits = [];
    if (uf.distinct.size) {
      const r = await softAsync(core, 'worker.lexicalSearch', () => core.mods.worker.lexicalSearch(core,
        { terms: [...uf.distinct].slice(0, 12), tables: ['assertions_fts', 'episodes_fts'], limit: 20 }, { deadlineMs: ms.search, signal: opt.signal }), null);
      for (const h of r?.hits ?? []) hits.push({ ref: h.ref, lexical: true });
    }
    if (vec) {
      const r = await softAsync(core, 'worker.denseSearch', () => core.mods.worker.denseSearch(core,
        { vectors: [vec.vec], spaceId: vec.spaceId, layers: ['memory'], topK: { memory: 20, raw: 0 }, includeCold: true }, { deadlineMs: ms.search, signal: opt.signal }), null);
      for (const h of r?.hits ?? []) if (h.score >= cfg.told.scanMinCos) hits.push({ ref: h.ref, dense: true });
    }
    for (const h of hits) {
      if (matched.size >= cfg.told.scanLimit || matched.has(h.ref)) continue;
      const m = parseRef(h.ref);
      if (!m) continue;
      const f = memoryFacts(core, m, memo);
      if (!f.exists || !f.text) continue;
      const s = overlapScore(core, uf, features(core, f.text, { idf, memo }), { memo });
      if (s >= cfg.told.minOverlap + (h.dense ? 0 : 1)) matched.set(h.ref, { mref: m, level: 'vague' });
    }
  }
  let told = 0;
  completeJob(core.store, job.id, () => { told = writeTold(core, p, [...matched.values()]); return told; });
  return { told };
}

/** 未经审视的发言回头补评估：照外发审视的初筛 + 审视走一遍，不是 speak 的记进分寸日志（管理页报警）。 */
export async function runPostcheck(core, job, opt = {}) {
  const payload = parseJson(job.payload_json, {});
  const p = Number.isSafeInteger(payload.perceptId) ? perceptRow(core, payload.perceptId) : null;
  if (!p?.text) { completeJob(core.store, job.id, () => null); return { verdict: null }; }
  const { assessText } = await import('./egress.js');
  let verdict = 'speak';
  try { verdict = (await assessText(core, { text: p.text, targetKey: p.setting_key, homeKey: null, sessionId: null, at: p.at, signal: opt.signal })).verdict; } catch (e) {
    verdict = 'unknown';
    warn(core, 'postcheck', { error: errCode(e) });
  }
  completeJob(core.store, job.id, () => {
    if (verdict !== 'speak') logDecision(core, { kind: 'unappraised', settingKey: p.setting_key, reason: `posthoc:${verdict}`, at: core.now() });
  });
  return { verdict };
}
