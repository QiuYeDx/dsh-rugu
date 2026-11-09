// discretion 测试用的小世界：直接往别的模块的表里放夹具行（schema 就是契约），别的模块的函数全部换成照契约写的小替身。
// 这样 discretion 的测试不依赖任何还在并行实现的模块。
import { createTestCore, FakeLLM, FakeEmbedding, FakeBudget, FakeLogger, FakeClock, FakeSelfProfile, cosine } from '../fakes/index.js';
import { textHash } from '../../src/contract/index.js';
import { refOf, parseRef } from '../../src/store/index.js';

export const ADAPTER = 'tz';

const DESCRIPTORS = {
  oneOnOne: (o = {}) => ({
    stability: 'persistent', audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
    disclosure: { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: 'unknown', herRole: '朋友', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false }, attending: true, ...o,
  }),
  group: (o = {}) => ({
    stability: 'persistent', audience: { size: 20, entry: 'closed', unknownObservers: false, membersKnown: 'recent-speakers' },
    disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: 'unknown', herRole: '普通成员', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false }, attending: true, ...o,
  }),
  exactGroup: (o = {}) => ({
    stability: 'persistent', audience: { size: 4, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
    disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: 'unknown', herRole: '普通成员', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false }, attending: true, ...o,
  }),
  public: (o = {}) => ({
    stability: 'persistent', audience: { size: 'unbounded', entry: 'open', unknownObservers: true, membersKnown: 'unknown' },
    disclosure: { visibleTo: 'anyone', persistence: 'public-permanent', searchable: true, attributedToHer: true },
    ownership: { owner: 'platform', herRole: '路人', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: true }, attending: true, ...o,
  }),
};

function exposureRank(d) {
  if (d.disclosure.visibleTo === 'anyone') return 3;
  if (d.audience.entry === 'open' || d.audience.unknownObservers) return 2;
  if (d.audience.size === 2 && d.disclosure.visibleTo === 'participants') return 0;
  return 1;
}
const persistenceRank = (d) => ({ ephemeral: 0, logged: 1, 'public-permanent': 2 }[d.disclosure.persistence] ?? 1);

/** 照语言模块契约的小替身：中文二元组 + 其他文字的词。 */
export function terms(text) {
  const out = [];
  const t = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const seg of t.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(seg)) {
      if (seg.length === 1) out.push(seg);
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    } else out.push(seg);
  }
  return [...new Set(out)];
}

/**
 * @param {{name?: string, mods?: object, llm?: FakeLLM, budget?: FakeBudget, config?: object, embedding?: FakeEmbedding|null}} [opt]
 */
export async function makeWorld(opt = {}) {
  const clock = new FakeClock();
  const llm = opt.llm ?? new FakeLLM();
  const embedding = opt.embedding === undefined ? new FakeEmbedding() : opt.embedding;
  const budget = opt.budget ?? new FakeBudget();
  const logger = new FakeLogger();
  const ports = { clock, llm, budget, logger, selfProfile: new FakeSelfProfile(), ...(embedding ? { embedding } : {}) };
  const sessions = new Map();     // sessionId → {settingKey, turnTainted, ledger: string[]}
  const turns = new Map();        // sessionId → {ids, focus}：这一轮的触发者（D107）
  const calls = { notify: [], reviews: [], traces: [], executions: [], observed: [], holds: [] };
  const modes = new Map();
  const W = {};
  const fakes = {
    intake: {
      sanitizeForPrompt: (core, t) => String(t ?? '').replace(/【/g, '「').replace(/】/g, '」').replace(/\s*\n\s*/g, ' ').replace(/\[(m|U)(\d+)\]/g, '［$1$2］'),
      resolveSetting: (core, sid) => {
        if (typeof sid !== 'string') return null;
        const key = core.keys.settingKey(ADAPTER, sid);
        return core.store.get('SELECT key FROM settings WHERE key = ?', key) ? { key, adapter: ADAPTER } : null;
      },
      observeInternal: (core, p) => {
        calls.observed.push(p);
        const id = W.percept({ settingKey: p.settingKey, actor: W.me, text: p.text, at: p.at, kind: p.kind, visibleTo: p.visibleTo, appraisalToken: p.appraisalToken });
        core.store.afterCommit(() => core.mods.discretion.onSelfUtterance(core, core.store.get('SELECT * FROM percepts WHERE id = ?', id)));
        return id;
      },
    },
    entities: {
      isIndividual: (core, id) => core.store.get('SELECT kind FROM entities WHERE id = ?', id)?.kind === 'person',
      rightsHolder: (core, a, b) => a === b || !!core.store.get(`SELECT 1 FROM entity_links WHERE rel = 'same' AND decided_by IN ('platform','mutual-claim','anchor-confirmed','owner')
                                                                   AND ((a = ? AND b = ?) OR (a = ? AND b = ?))`, Math.min(a, b), Math.max(a, b), Math.min(a, b), Math.max(a, b)),
      nameMatcher: (core) => ({
        version: 1,
        scan(text) {
          const out = [];
          for (const r of core.store.all('SELECT entity_id, text_raw FROM entity_names')) {
            const i = String(text).indexOf(r.text_raw);
            if (r.text_raw && i >= 0) out.push({ entityId: r.entity_id, name: r.text_raw, start: i, end: i + r.text_raw.length, score: 1 });
          }
          return out;
        },
      }),
      resolveActor: () => ({ entityId: null, isSelf: false, isPrincipal: false, via: 'none' }),
    },
    admin: {
      notifyNeedToKnow: (core, item) => {
        calls.notify.push(item);
        const m = item.ref ? parseRef(item.ref) : null;
        return Number(core.store.run(`INSERT INTO need_to_know(kind, owner_kind, owner_id, percept_id, source_entity_id, reason, severity, created_at)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, item.kind, m?.kind ?? null, m?.id ?? null, item.perceptId ?? null,
        item.sourceEntityId ?? null, item.reason, item.severity ?? 1, item.at).lastInsertRowid);
      },
      enqueueReview: (core, item) => {
        calls.reviews.push(item);
        return Number(core.store.run('INSERT INTO review_queue(kind, payload_json, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
          item.kind, JSON.stringify(item.payload ?? {}), item.reason ?? '', core.now(), item.expiresAt ?? null).lastInsertRowid);
      },
      activeRules: (core, kind) => core.store.all('SELECT id, target_json, value_json FROM rules WHERE kind = ? AND revoked_at IS NULL', kind)
        .map((r) => ({ id: r.id, kind, target: JSON.parse(r.target_json), value: r.value_json ? JSON.parse(r.value_json) : null })),
      modeFor: (core, key) => modes.get(key) ?? 'live',
    },
    context: {
      sessionInfo: (core, sid) => {
        const s = sessions.get(sid);
        const t = turns.get(sid);
        return s ? { sessionId: sid, settingKey: s.settingKey, adapter: ADAPTER, cycle: 0, turnTainted: !!s.turnTainted, warmPending: false,
          triggerEntityIds: t?.ids ?? [], focusPerceptId: t?.focus ?? null, selfTurn: t?.self === true, turnAt: t?.at ?? null } : null;
      },
      taintLedger: (core, sid) => [...(sessions.get(sid)?.ledger ?? [])],
    },
    lang: {
      queryTerms: (core, text) => terms(text),
      distinctiveTerms: (core, text, o = {}) => {
        const out = new Set(String(text).match(/\d{2,}/g) ?? []);
        for (const n of o.names ?? []) out.add(n);
        if (o.idf) for (const t of terms(text)) if (o.idf(t) >= (o.minIdf ?? 3)) out.add(t);
        for (const x of o.exclude ?? []) out.delete(x);
        return [...out];
      },
    },
    worker: {
      termStats: async (core, ts) => new Map(ts.map((t) => [t, { idf: 4, rowFraction: 0.001 }])),
      embedQuery: async (core, texts) => {
        if (!embedding) return null;
        const r = await embedding.embed(texts, 'query');
        return { spaceId: r.spaceId, vectors: r.vectors };
      },
      storedVectors: async (core, refs) => {
        const out = new Map();
        if (!embedding) return out;
        for (const r of refs) {
          const m = parseRef(r);
          const t = m?.kind === 'assertion' ? core.store.get('SELECT text FROM assertions WHERE id = ?', m.id)?.text
            : m?.kind === 'percept' ? core.store.get('SELECT text FROM percepts WHERE id = ?', m.id)?.text : null;
          if (t) out.set(r, embedding.vector(t));
        }
        return out;
      },
      lexicalSearch: async () => ({ hits: [], timedOut: false }),
      denseSearch: async () => ({ hits: [], timedOut: false }),
    },
    dynamics: { addTrace: (core, ref, tr) => { calls.traces.push({ ref, ...tr }); return { added: true }; } },
    encode: { recordExecution: (core, id, exec) => { calls.executions.push({ id, ...exec }); } },
  };
  const mods = {};
  for (const [k, v] of Object.entries(fakes)) mods[k] = { ...v, ...(opt.mods?.[k] ?? {}) };
  for (const [k, v] of Object.entries(opt.mods ?? {})) if (!mods[k]) mods[k] = v;
  const { core, cleanup } = await createTestCore({ name: opt.name ?? 'discretion', ports, mods, config: opt.config });
  const D = core.mods.discretion;
  const st = core.store;
  let sidSeq = 0;
  let extSeq = 0;

  Object.assign(W, {
    core, D, llm, budget, logger, clock, embedding, calls, sessions, modes, cleanup,
    ref: (m) => refOf(m.kind, m.id),
    now: () => core.now(),
    entity(kind, name, o = {}) {
      const at = core.now();
      const id = Number(st.run(`INSERT INTO entities(kind, status, display_name, is_self, closeness, authority, created_at, updated_at)
                                VALUES (?, 'established', ?, ?, ?, ?, ?, ?)`, kind, name, o.self ? 1 : 0, o.closeness ?? 0, o.authority ?? 'none', at, at).lastInsertRowid);
      if (name) st.run('INSERT INTO entity_names(entity_id, text_raw, text_norm, first, last) VALUES (?, ?, ?, ?, ?)', id, name, name, at, at);
      return id;
    },
    person(name, o) { return W.entity('person', name, o); },
    setting(label, kind = 'group', o = {}) {
      sidSeq += 1;
      const sid = `S-${sidSeq}-${label}`;
      const key = core.keys.settingKey(ADAPTER, sid);
      const d = { id: sid, label, ...DESCRIPTORS[kind](o) };
      const at = o.at ?? core.now();
      st.run('INSERT INTO settings(key, adapter, label, stability, parent_key, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', key, ADAPTER, label, d.stability, o.parentKey ?? null, at, at);
      W.snapshot(key, d, at);
      return { key, sid, descriptor: d };
    },
    /** 用一份现成的描述建场合（假平台的随机属性），断言只针对属性组合。 */
    settingFrom(descriptor, o = {}) {
      sidSeq += 1;
      const sid = `F-${sidSeq}`;
      const key = core.keys.settingKey(ADAPTER, sid);
      const d = { ...structuredClone(descriptor), id: sid };
      const at = o.at ?? core.now();
      st.run('INSERT INTO settings(key, adapter, label, stability, parent_key, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', key, ADAPTER, d.label ?? '', d.stability, null, at, at);
      W.snapshot(key, d, at);
      return { key, sid, descriptor: d };
    },
    /** 注册一个适配器（只有 onHoldDecision / members，给关口②的挂起流程用）。 */
    adapter(extra = {}) {
      const a = { id: ADAPTER, protocol: 2, describeSetting: () => null, selfClaims: () => [], principalClaims: () => [],
        async onHoldDecision(token, approve, detail) { calls.holds.push({ token, approve, detail }); }, ...extra };
      core.adapters.set(ADAPTER, a);
      return a;
    },
    /** 提炼写好了规范的感知（norm_state = assessed）。 */
    assess(perceptId, norm = {}) {
      D.writeNorm(core, { kind: 'percept', id: perceptId }, norm);
      st.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", perceptId);
      return { kind: 'percept', id: perceptId };
    },
    snapshot(key, d, at = core.now()) {
      const id = Number(st.run(`INSERT INTO setting_snapshots(setting_key, at, descriptor_json, descriptor_hash, reach_hash, exposure_rank, persistence_rank, audience_size)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, key, at, JSON.stringify(d), String(Math.random()), 'r', exposureRank(d), persistenceRank(d),
      typeof d.audience.size === 'number' ? d.audience.size : null).lastInsertRowid);
      st.run('UPDATE settings SET current_snapshot_id = ? WHERE key = ?', id, key);
      return id;
    },
    presence(settingKey, members, at = core.now(), completeness = 'exact', unknownObservers = false) {
      return D.recordPresence(core, { settingKey, at, members, completeness, unknownObservers });
    },
    /** 一条感知。presence 给了就记一个出现集合。 */
    percept(p) {
      extSeq += 1;
      const at = p.at ?? core.now();
      const presenceId = p.presence ? W.presence(p.settingKey, p.presence, at, p.completeness ?? 'exact') : (p.presenceSetId ?? null);
      const isSelf = p.actor === W.me;
      const kind = p.kind ?? (isSelf ? 'self-utterance' : 'utterance');
      const text = p.text ?? '';
      return Number(st.run(`INSERT INTO percepts(adapter, ext_key, setting_key, snapshot_id, perceived_in, presence_set_id, visible_to, at, perceived_at,
                              actor_entity_id, actor_self, actor_json, kind, text, text_hash, addressed, attention, attention_class, evidential, standing,
                              appraisal_token, session_ref_json, norm_state, created_at)
                            VALUES (?, ?, ?, (SELECT current_snapshot_id FROM settings WHERE key = ?), ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'attended', 'toHer', 1, ?, ?, ?, ?, ?)`,
      ADAPTER, `x${extSeq}`, p.settingKey, p.settingKey, p.perceivedIn ?? p.settingKey, presenceId, p.visibleTo ?? 'setting-audience', at, at,
      p.actor ?? null, isSelf ? 1 : 0, kind, text, textHash(text), isSelf ? 'by-her' : (p.addressed ?? 'ambient'), p.standing ?? 'first-hand',
      p.appraisalToken ?? null, p.sessionId ? JSON.stringify({ sessionId: p.sessionId }) : null, p.normState ?? 'unassessed', at).lastInsertRowid);
    },
    /** 一条事实（带实体边和来源）。 */
    assertion(a) {
      const at = a.at ?? core.now();
      const id = Number(st.run(`INSERT INTO assertions(predicate, text, kind_hint, certainty, confidence, recorded_at, created_at, updated_at)
                                VALUES (?, ?, ?, ?, 0.8, ?, ?, ?)`, a.predicate ?? 'p', a.text, a.kindHint ?? 'fact', a.certainty ?? 'stated', at, at, at).lastInsertRowid);
      for (const s of a.subjects ?? []) st.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')", id, s);
      for (const s of a.mentions ?? []) st.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'mention')", id, s);
      for (const src of a.sources ?? []) {
        st.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, speaker, asserter, mode, hop, confidence, at)
                VALUES ('assertion', ?, ?, ?, ?, ?, ?, ?, 0.8, ?)`, id, src.percept ?? null, src.perceivedIn ?? null, src.speaker ?? null, src.asserter ?? src.speaker ?? null,
        src.mode ?? 'told_to_her', src.hop ?? 0, at);
      }
      return { kind: 'assertion', id };
    },
    episode(e) {
      const at = e.at ?? core.now();
      const id = Number(st.run(`INSERT INTO episodes(setting_key, title, narrative, header, t_start, t_end, participants_json, sealed_at, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.settingKey, e.title ?? '', e.narrative ?? '', e.header ?? '', at, at, JSON.stringify(e.participants ?? []), at, at).lastInsertRowid);
      return { kind: 'episode', id };
    },
    link(a, b, rel = 'same', decidedBy = 'platform', cross = 1) {
      return Number(st.run('INSERT INTO entity_links(a, b, rel, confidence, decided_by, cross_namespace, at, created_at) VALUES (?, ?, ?, 0.9, ?, ?, ?, ?)',
        Math.min(a, b), Math.max(a, b), rel, decidedBy, cross, core.now(), core.now()).lastInsertRowid);
    },
    descriptor(entity, anchor, relation, basis = 'third-party', speaker = 0) {
      const at = core.now();
      st.run('INSERT INTO entity_descriptors(entity_id, anchor_entity_id, relation, basis, speaker_entity_id, first_at, last_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        entity, anchor, relation, basis, speaker, at, at, at);
    },
    ntk(kind, m, reason = 'test') {
      return fakes.admin.notifyNeedToKnow(core, { kind, ref: m ? refOf(m.kind, m.id) : null, reason, at: core.now() });
    },
    ownerRule(target, value) {
      st.run("INSERT INTO rules(kind, target_json, value_json, created_by, at) VALUES ('disclosure', ?, ?, 'owner', ?)", JSON.stringify(target), JSON.stringify(value), core.now());
    },
    hide(m, state = 'hidden') {
      st.run('INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES (?, ?, ?, ?, ?)', m.kind, m.id, state, 'owner', core.now());
    },
    /** 这一轮的触发者（context 回想时记下的那份的替身，D107）。ids 为空 = 读不到。 */
    turn(sid, ids, focus = null, { self = false, at = null } = {}) { if (ids?.length || self) turns.set(sid, { ids: ids ?? [], focus, self, at }); else turns.delete(sid); },
    session(sid, settingKey, o = {}) {
      sessions.set(sid, { settingKey, turnTainted: !!o.tainted, ledger: o.ledger ?? [] });
      st.run(`INSERT INTO sessions(session_id, setting_key, adapter, cycle, status, updated_at) VALUES (?, ?, ?, 0, 'active', ?)
              ON CONFLICT(session_id) DO UPDATE SET setting_key = excluded.setting_key`, sid, settingKey, ADAPTER, core.now());
      if (o.ledger?.length) {
        st.run(`INSERT INTO injections(ts, session_id, cycle, setting_key, layer, nonce, items_json, chars, mode, seen) VALUES (?, ?, 0, ?, 'block', ?, ?, 10, 'live', 1)`,
          core.now(), sid, settingKey, `n-${sid}-${Math.random()}`, JSON.stringify(o.ledger.map((id) => ({ id, layer: 'recalled', verdict: o.verdict ?? 'share', appraisalRef: 'ap1' }))));
      }
    },
    target(settingKey, o = {}) {
      return D.targetFor(core, { settingKey, homeSettingKey: o.home ?? settingKey, sessionId: o.sessionId ?? null, triggerEntityId: o.trigger ?? null,
        mode: o.mode ?? 'involuntary', egress: o.egress, at: core.now(), batch: o.batch, ...(typeof o.direct === 'boolean' ? { direct: o.direct } : {}) });
    },
    cand(m) { return { ref: refOf(m.kind, m.id), mref: m, ranks: {}, rrf: 0, signals: {}, A: 0, P: 1, parts: { B: 0, S: 0, C: 0, I: 0, Psup: 0, eps: 0 } }; },
    async gate(ms, target, o = {}) { return D.gate(core, ms.map((m) => W.cand(m)), target, { mode: o.mode ?? target.mode, deadlineMs: o.deadlineMs ?? 800 }); },
    appraisals: () => st.all('SELECT * FROM appraisals ORDER BY id'),
    logs: () => st.all('SELECT * FROM discretion_log ORDER BY id'),
    vectorOf: (t) => embedding?.vector(t),
    cosine,
  });
  W.me = W.entity('self', null, { self: true });
  return W;
}

/** FakeLLM 的第二段回复：给每张卡片同一个结论（或按 id 指定）。 */
export function appraiseReply(verdicts) {
  return (req) => {
    const n = (req.messages[0].content.match(/卡片 c\d+/g) ?? []).length;
    const out = [];
    for (let i = 1; i <= n; i++) {
      const v = typeof verdicts === 'function' ? verdicts(i, req) : Array.isArray(verdicts) ? verdicts[i - 1] : verdicts;
      const o = typeof v === 'string' ? { verdict: v } : v;
      out.push({ id: `c${i}`, flow: '…', judgement: '…', reason: '测试', hint: false, ...o });
    }
    return out;
  };
}
