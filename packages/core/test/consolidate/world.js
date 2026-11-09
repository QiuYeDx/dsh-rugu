// consolidate 测试用的「小世界」：真库 + 真迁移 + 替身端口，依赖的模块全部换成照契约写的小替身（别的模块正在并行实现，
// 测试不依赖它们）。替身只做契约里写明的那部分：写主表行、记下调用，规范和痕迹只记录不计算。
// 测试数据里没有真实账号、群号；人名都是合成的。
import { createTestCore, FakeLLM, FakeClock, FakeBudget, FakeLogger, FakeSelfProfile, FakeEmbedding, fakePorts } from '../fakes/index.js';
import { refOf, parseRef } from '../../src/store/index.js';
import { textHash } from '../../src/contract/index.js';
import { createConfig } from '../../src/config/defaults.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** 2026-10-31 10:00 UTC；测试统一用 UTC+8（tzOffsetMin=480）→ 本地 18:00 */
export const T0 = Date.UTC(2026, 9, 31, 10, 0, 0);

const UNASSESSED = Object.freeze({ unassessed: true, version: 0, restriction: 'none', allow: null, deny: null, involvesOthers: false, identityLink: false, sensitivity: null, originExposure: { exposureRank: 0, persistenceRank: 1 } });

/**
 * @param {{llm?: FakeLLM, clock?: FakeClock, budget?: FakeBudget, config?: object, mods?: object, embedding?: object|null, recall?: (s, opt) => string[]}} [opt]
 */
export async function world(opt = {}) {
  const llm = opt.llm ?? new FakeLLM();
  const clock = opt.clock ?? new FakeClock(T0);
  const budget = opt.budget ?? new FakeBudget();
  const logger = new FakeLogger();
  const embedding = opt.embedding === undefined ? new FakeEmbedding() : opt.embedding;
  const ports = fakePorts({ llm, clock, budget, logger, selfProfile: new FakeSelfProfile(), embedding });
  const rec = new Proxy({}, { get: (t, k) => (t[k] ??= []) });
  const norms = new Map();
  const hidden = new Set();
  let recallRefs = opt.recall ?? (() => []);

  const insertAssertion = (core, a) => {
    const now = a.recordedAt ?? core.now();
    const id = Number(core.store.run(`INSERT INTO assertions(predicate, value, object_entity_id, text, kind_hint, recurrence, occurrence_key, certainty,
        confidence, imp, event_start, event_end, planned_time_json, valid_from, valid_to_known, change_known, t50_h, shape, recorded_at,
        supersedes, superseded_by, plan_agent, plan_status, pinned, needs_review, needs_reconcile, extract_ver, model, job_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.predicate ?? 'fact', a.value ?? null, a.objectEntityId ?? null, a.text, a.kindHint ?? 'fact',
    a.recurrence ? JSON.stringify(a.recurrence) : null, a.occurrenceKey ?? null, a.certainty ?? 'stated',
    a.confidence ?? 0.8, a.imp ?? 5, a.eventTime?.start ?? null, a.eventTime?.end ?? null,
    a.plannedTime ? JSON.stringify(a.plannedTime) : null, a.validFrom ?? null, a.validToKnown ?? null, a.changeKnown ? 1 : 0,
    a.survival?.t50h ?? null, a.survival?.shape ?? null, now, a.supersedes ?? null, a.supersededBy ?? null,
    a.plan?.agent ?? null, a.plan?.status ?? null, a.pinned ? 1 : 0, a.needsReview ? 1 : 0, a.needsReconcile ? 1 : 0,
    a.extractVer ?? null, a.model ?? null, a.jobId ?? null, now, a.updatedAt ?? now).lastInsertRowid);
    const role = (eid, r) => core.store.run('INSERT OR IGNORE INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, ?)', id, eid, r);
    for (const s of a.subjects ?? []) role(s, 'subject');
    if (a.objectEntityId) role(a.objectEntityId, 'object');
    for (const m of a.mentions ?? []) role(m, 'mention');
    for (const s of a.sources ?? []) insertSource(core, 'assertion', id, s);
    return id;
  };
  const insertSource = (core, kind, id, s) => {
    core.store.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, snapshot_id, perceived_in, speaker, asserter, mode, hop, quote, confidence, used_bg_json, at, extract_ver)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL)`, kind, id, s.perceptId ?? null, s.snapshotId ?? null, s.perceivedIn ?? null,
    s.speaker ?? null, s.asserter ?? s.speaker ?? null, s.mode ?? 'told_to_her', s.hop ?? 0, s.quote ?? null, s.confidence ?? 0.8, s.at ?? core.now());
  };
  const insertEpisode = (core, ep) => {
    const now = ep.createdAt ?? core.now();
    const id = Number(core.store.run(`INSERT INTO episodes(setting_key, ep_kind, title, narrative, header, header_ver, t_start, t_end, participants_json,
        snapshot_id, sealed_at, emotion_json, extract_ver, model, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ep.settingKey, ep.kind ?? 'event', ep.title ?? '', ep.narrative ?? '', ep.header ?? '', ep.headerVer ?? null, ep.tStart, ep.tEnd,
    JSON.stringify(ep.participants ?? []), ep.snapshotId ?? null, now, ep.emotion ? JSON.stringify(ep.emotion) : null,
    ep.extractVer ?? null, ep.model ?? null, ep.jobId ?? null, now).lastInsertRowid);
    for (const s of ep.sources ?? []) insertSource(core, 'episode', id, s);
    return id;
  };

  const fakes = {
    intake: {
      sanitizeForPrompt: (c, t) => String(t ?? '').replaceAll('【', '「').replaceAll('】', '」'),
      flushWindows: (c, o) => { rec.flushWindows.push(o); return { windows: 0, pending: 0 }; },
    },
    context: {
      markResidentDirty: (c, key) => { rec.markResidentDirty.push(key ?? null); },
    },
    encode: {
      writeEpisode: (c, ep) => {
        const id = insertEpisode(c, ep);
        rec.writeEpisode.push({ id, ep });
        c.mods.discretion.writeNorm(c, { kind: 'episode', id }, ep.norm);
        c.mods.dynamics.addTrace(c, { kind: 'episode', id }, { t: ep.tEnd, w: ep.w, sourceKey: `ep:${id}`, reason: 'encode' });
        return id;
      },
      writeAssertion: (c, a) => {
        const id = insertAssertion(c, a);
        rec.writeAssertion.push({ id, a });
        c.mods.discretion.writeNorm(c, { kind: 'assertion', id }, a.norm);
        return id;
      },
      addSource: (c, owner, s, tr) => { insertSource(c, owner.kind, owner.id, s); rec.addSource.push({ owner, s, tr }); },
      segment: (c, o) => { rec.segment.push(o); return { jobs: 0 }; },
      reviewFlagged: async (c, o) => { rec.reviewFlagged.push(o); return { reviewed: 0, llmCalls: 0 }; },
      transitionPlan: (c, id, status, ctx) => {
        c.store.run('UPDATE assertions SET plan_status = ?, updated_at = ? WHERE id = ?', status, ctx.at, id);
        c.store.run("INSERT INTO plan_status_history(assertion_id, status, at, source_json) VALUES (?, ?, ?, '{}')", id, status, ctx.at);
        rec.transitionPlan.push({ id, status, ctx });
      },
      transitionIntention: (c, id, state, ctx) => {
        c.store.run('UPDATE intentions SET state = ?, armed_at = CASE WHEN ? = \'armed\' THEN ? ELSE armed_at END, updated_at = ? WHERE id = ?', state, state, ctx.at, ctx.at, id);
        rec.transitionIntention.push({ id, state, ctx });
      },
      formIntention: (c, p, ctx) => {
        const id = Number(c.store.run(`INSERT INTO intentions(about_kind, about_id, target_entity_id, act, text, origin, trigger_json, state, formed_at,
            window_start, window_end, sources_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'formed', ?, ?, ?, ?, ?, ?)`,
        p.about?.kind ?? null, p.about?.id ?? null, p.targetEntityId, p.act, p.text, p.origin, JSON.stringify(p.trigger ?? {}), ctx.at,
        p.trigger?.timeWindow?.start ?? null, p.trigger?.timeWindow?.end ?? null, JSON.stringify(p.evidencePerceptIds ?? []), ctx.at, ctx.at).lastInsertRowid);
        rec.formIntention.push({ id, p, ctx });
        return id;
      },
      ensurePredicate: (c, key) => key,
    },
    discretion: {
      normOf: (c, ref) => norms.get(refOf(ref.kind, ref.id)) ?? UNASSESSED,
      writeNorm: (c, ref, n) => {
        const r = refOf(ref.kind, ref.id);
        rec.writeNorm.push({ ref: r, norm: n });
        norms.set(r, { ...UNASSESSED, unassessed: false, version: (norms.get(r)?.version ?? 0) + 1, ...n });
        return 1;
      },
      inheritNorm: (c, ref, ev, ctx) => { rec.inheritNorm.push({ ref: refOf(ref.kind, ref.id), evidence: ev.map((e) => refOf(e.kind, e.id)), ...ctx }); },
      settingRules: (c, key) => ({ version: 0, rules: (rec.writeSettingRule.filter((r) => r.key === key)).map((r) => ({ text: r.rule.text, restriction: r.rule.restriction, author: null, authority: 'none' })) }),
      writeSettingRule: (c, key, rule, ctx) => { rec.writeSettingRule.push({ key, rule, ctx }); return { version: 1, status: 'active' }; },
    },
    dynamics: {
      encodingWeight: (c, f) => f.wAtt ?? 1,
      addTrace: (c, ref, tr) => { rec.addTrace.push({ ref: refOf(ref.kind, ref.id), ...tr }); return { added: true }; },
      pHold: () => 1,
      tense: () => 'present',
      retier: (c, o) => { rec.retier.push(o); return { updated: 2, done: true }; },
    },
    worker: {
      enqueueEmbed: (c, ref, chunks, o) => { rec.enqueueEmbed.push({ ref: refOf(ref.kind, ref.id), chunks, o }); },
      storedVectors: async (c, refs) => {
        const out = new Map();
        if (!embedding) return out;
        for (const r of refs) {
          const m = parseRef(r);
          const e = m?.kind === 'episode' ? c.store.get('SELECT header, narrative FROM episodes WHERE id = ?', m.id) : null;
          if (e) out.set(r, embedding.vector(`${e.header} ${e.narrative}`));
        }
        return out;
      },
      dropEmbeddings: (c, refs) => { rec.dropEmbeddings.push(refs.map((r) => refOf(r.kind, r.id))); return { texts: refs.length, vectors: refs.length }; },
      runEmbedQueue: async (c, o) => { rec.runEmbedQueue.push(o); return { embedded: 0, failed: 0 }; },
      reloadIndex: () => { rec.reloadIndex.push(true); },
      shadowReembed: async (c, o) => { rec.shadowReembed.push(o); return { coverage: 1 }; },
      maintenance: async (c, t) => { rec.maintenance.push(t); return { ok: true }; },
    },
    entities: {
      writeImpression: (c, id, layer, imp) => {
        const cur = c.store.get('SELECT MAX(version) AS v FROM entity_impressions WHERE entity_id = ? AND layer = ?', id, layer)?.v ?? 0;
        c.store.run('UPDATE entity_impressions SET is_current = 0 WHERE entity_id = ? AND layer = ? AND is_current = 1', id, layer);
        const iid = Number(c.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, evidence_ids_json, first_hand, hearsay, version, is_current, built_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`, id, layer, imp.text, JSON.stringify(imp.evidenceRefs), imp.firstHand, imp.hearsay, cur + 1, imp.at).lastInsertRowid);
        rec.writeImpression.push({ entityId: id, layer, imp });
        return iid;
      },
      link: (c, a, b, l) => {
        const [x, y] = a < b ? [a, b] : [b, a];
        c.store.run(`INSERT INTO entity_links(a, b, rel, confidence, evidence_json, decided_by, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(a, b) DO UPDATE SET rel = excluded.rel, confidence = excluded.confidence, decided_by = excluded.decided_by, at = excluded.at`,
        x, y, l.rel, l.confidence, JSON.stringify(l.evidence ?? []), l.decidedBy, l.at, l.at);
        rec.link.push({ a, b, ...l });
        return 1;
      },
      isIndividual: (c, id) => c.store.get('SELECT kind FROM entities WHERE id = ?', id)?.kind === 'person',
    },
    admin: {
      suppressedRefs: (c, refs) => new Set(refs.filter((r) => hidden.has(r))),
      enqueueReview: (c, item) => {
        const id = Number(c.store.run('INSERT INTO review_queue(kind, payload_json, reason, status, created_at) VALUES (?, ?, ?, \'pending\', ?)',
          item.kind, JSON.stringify(item.payload), item.reason, c.now()).lastInsertRowid);
        rec.enqueueReview.push({ id, ...item });
        return id;
      },
      notifyNeedToKnow: (c, item) => { rec.notify.push(item); return rec.notify.length; },
      expireReviews: (c, at) => { rec.expireReviews.push(at); return 0; },
      applyRetention: async (c, at) => { rec.applyRetention.push(at); return { expired: 0, done: true }; },
    },
    backup: {
      runScheduled: async (c, o) => { rec.runScheduled.push(o); return []; },
    },
    retrieve: {
      recall: async (c, s, o) => { rec.recall.push({ s, o }); return { items: recallRefs(s, o).map((ref) => ({ ref })), degradeLevel: 0, routeMs: {}, traceId: 't' }; },
    },
  };
  const mods = {};
  for (const [k, v] of Object.entries(fakes)) mods[k] = { ...v, ...(opt.mods?.[k] ?? {}) };
  for (const [k, v] of Object.entries(opt.mods ?? {})) if (!mods[k]) mods[k] = v;
  // extra：还没并进 defaults.js 的键（mergeConfig 会丢掉不认识的键），直接叠在合并好的配置上
  const config = opt.extra ? configWith({ time: { tzOffsetMin: 480 }, ...(opt.config ?? {}) }, opt.extra) : { time: { tzOffsetMin: 480 }, ...(opt.config ?? {}) };
  const t = await createTestCore({ name: 'consolidate', ports, config, mods });
  const { core } = t;

  let ext = 0;
  const w = {
    ...t, core, llm, clock, budget, logger, rec, norms, hidden, embedding,
    setRecall: (fn) => { recallRefs = fn; },
    /** 一个场合（带一份快照）。exposure：0 一对一、1 封闭群、2 开放群、3 公开。 */
    setting({ label = '某个地方', stability = 'persistent', exposure = 1, parentKey = null } = {}) {
      const key = `K${Math.random().toString(36).slice(2, 10)}`;
      const now = core.now();
      core.store.run('INSERT INTO settings(key, adapter, label, stability, parent_key, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', key, 'zz', label, stability, parentKey, now, now);
      const sid = Number(core.store.run(`INSERT INTO setting_snapshots(setting_key, at, descriptor_json, descriptor_hash, reach_hash, exposure_rank, persistence_rank)
          VALUES (?, ?, '{}', 'h', 'r', ?, 1)`, key, now, exposure).lastInsertRowid);
      core.store.run('UPDATE settings SET current_snapshot_id = ? WHERE key = ?', sid, key);
      let entityId = null;
      if (stability === 'persistent') {
        entityId = w.entity({ kind: 'setting', name: label });
        core.store.run('UPDATE entities SET setting_key = ? WHERE id = ?', key, entityId);
        core.store.run('UPDATE settings SET entity_id = ? WHERE key = ?', entityId, key);
      }
      return { key, snapshotId: sid, entityId, label };
    },
    entity({ kind = 'person', name = null, closeness = 0.3, authority = 'none', isSelf = false, lastMention = null } = {}) {
      const now = core.now();
      const id = Number(core.store.run(`INSERT INTO entities(kind, status, display_name, is_self, closeness, authority, last_mention_at, created_at, updated_at)
          VALUES (?, 'established', ?, ?, ?, ?, ?, ?, ?)`, kind, name, isSelf ? 1 : 0, closeness, authority, lastMention, now, now).lastInsertRowid);
      if (name) core.store.run('INSERT INTO entity_names(entity_id, text_raw, text_norm, first, last) VALUES (?, ?, ?, ?, ?)', id, name, name, now, now);
      return id;
    },
    /** 一条感知。 */
    percept(s, { at = core.now(), actor = null, self = false, kind, text = '', visibleTo = 'setting-audience', addressed = 'ambient', attention = 'attended',
      episodeId = null, standing = 'first-hand', evidential = true, historical = false, assessed = false, textState = 'normal' } = {}) {
      ext += 1;
      const k = kind ?? (self ? 'self-utterance' : 'utterance');
      const id = Number(core.store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, snapshot_id, perceived_in, visible_to, at, perceived_at, actor_entity_id,
          actor_self, actor_json, kind, text, text_state, text_hash, addressed, attention, attention_class, evidential, w_enc, standing, historical,
          episode_id, norm_state, created_at) VALUES ('zz', ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 'x', ?, 0.6, ?, ?, ?, ?, ?)`,
      `x${ext}`, s.key, s.snapshotId, s.key, visibleTo, at, at, self ? w.self : actor, self ? 1 : 0, k, text, textState, textHash(text),
      self ? 'by-her' : addressed, attention, evidential ? 1 : 0, standing, historical ? 1 : 0, episodeId, assessed ? 'assessed' : 'unassessed', at).lastInsertRowid);
      if (assessed) norms.set(`p${id}`, { ...UNASSESSED, unassessed: false, version: 1 });
      return id;
    },
    /** 一段情节，连同它的感知（每一行 [actor|'self', text, at]）。 */
    episode(s, lines, { kind = 'event', narrative, header = '', emotion = null, participants } = {}) {
      const pids = lines.map(([who, text, at]) => w.percept(s, { at, text, self: who === 'self', actor: who === 'self' ? null : who }));
      const ats = lines.map((l) => l[2]);
      const parts = participants ?? [...new Set(lines.map(([who]) => (who === 'self' ? w.self : who)))];
      const id = insertEpisode(core, {
        settingKey: s.key, kind, narrative: narrative ?? lines.map((l) => l[1]).join('；'), header, tStart: Math.min(...ats), tEnd: Math.max(...ats),
        participants: parts, snapshotId: s.snapshotId, emotion,
        sources: pids.map((pid, i) => ({ perceptId: pid, snapshotId: s.snapshotId, perceivedIn: s.key, speaker: lines[i][0] === 'self' ? w.self : lines[i][0], mode: lines[i][0] === 'self' ? 'self_generated' : 'overheard', at: lines[i][2] })),
      });
      for (const pid of pids) core.store.run('UPDATE percepts SET episode_id = ? WHERE id = ?', id, pid);
      norms.set(`e${id}`, { ...UNASSESSED, unassessed: false, version: 1 });
      return { id, ref: `e${id}`, pids };
    },
    /** 一条事实（直接插表，和 encode 的替身同一套写法）。norm 不给 = 已评估、无限制。 */
    fact(a, { norm } = {}) {
      const id = insertAssertion(core, a);
      norms.set(`a${id}`, { ...UNASSESSED, unassessed: false, version: 1, ...(norm ?? {}) });
      return { id, ref: `a${id}` };
    },
    flag(kind, { perceptId = null, ref = null } = {}) {
      const m = ref ? parseRef(ref) : null;
      core.store.run("INSERT INTO need_to_know(kind, owner_kind, owner_id, percept_id, reason, created_at) VALUES (?, ?, ?, ?, 'test', ?)",
        kind, m?.kind ?? null, m?.id ?? null, perceptId, core.now());
    },
  };
  w.self = w.entity({ kind: 'self', name: '她', isSelf: true, closeness: 1 });
  return w;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a, b) {
  if (!isPlain(a) || !isPlain(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}
/** 配置句柄：先按正常途径合并 config，再把 extra 原样叠上去（测试 params.js 里还没进 defaults.js 的键）。 */
export function configWith(config, extra) {
  const base = createConfig(config);
  let cur = deepMerge(base.get(), extra);
  return {
    get: () => cur,
    version: () => base.version(),
    update: (patch) => { const w = base.update(patch); cur = deepMerge(base.get(), extra); return w; },
    replace: (o) => { const w = base.replace(o); cur = deepMerge(base.get(), extra); return w; },
    onChange: (fn) => base.onChange(fn),
  };
}

/** FakeLLM 的回复：按请求内容决定（func 拿到 req，返回对象数组）。 */
export function reply(fn) { return (req) => fn(req, req.messages.map((m) => m.content).join('\n')); }

/** 提示词里的 [tag] 编号。 */
export function tagsIn(text, prefix) {
  return [...new Set([...text.matchAll(new RegExp(`\\[(${prefix}\\d+)\\]`, 'g'))].map((m) => m[1]))];
}
