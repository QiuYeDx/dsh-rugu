// context 测试共用的「小世界」：真库 + 真迁移 + 真 dynamics，别的模块全部换成按各自契约写的替身（它们正被并行实现，不依赖）。
//   - intake：resolveSetting / settingByKey / sanitizeForPrompt / sealBuffers（场合表就是 w.settings）；
//   - retrieve：recall 给 w.candidates（未过关口①）、render 按 w.texts 渲染、looksLikePast 看 w.past、cached 看 w.cachedSet；
//   - discretion：targetFor 照契约组目标（按轮污点读 context.sessionInfo）；gate 按 w.verdict(ref, target, mode) 判，
//     **每条结论都写一行 appraisals**、返回 'ap<id>'（契约 §4.7 / §9.3.6），omit 不返回；
//   - admin：modeFor / suppressedRefs / pendingCount / retentionState；encode：dueIntentions / recheckIntention；
//   - consolidate：growthBlock；entities：principals；backup：isRestoring（看 w.restoring）。
// 夹具数据（感知、情节、实体……）直接插行：只是数据，不依赖那些模块的实现。
import { createTestCore } from '../fakes/test-core.js';
import { refOf, parseRef } from '../../src/store/refs.js';

export const M = 60_000;
export const H = 60 * M;
export const D = 24 * H;
export const ADAPTER = 'fake';
export const GROUP = 'room-g1';     // 一个群（封闭、多人）
export const DM = 'room-dm1';       // 和主人的一对一
export const DM2 = 'room-dm2';      // 和普通群友的一对一
export const OTHER = 'room-g2';     // 另一个群

const DESCRIPTORS = {
  [GROUP]: { audience: { size: 30 }, disclosure: { visibleTo: 'members', persistence: 'logged' } },
  [OTHER]: { audience: { size: 12 }, disclosure: { visibleTo: 'members', persistence: 'logged' } },
  [DM]: { audience: { size: 2 }, disclosure: { visibleTo: 'participants', persistence: 'logged' } },
  [DM2]: { audience: { size: 2 }, disclosure: { visibleTo: 'participants', persistence: 'logged' } },
};

/**
 * @param {{config?: object, mods?: object}} [opt]
 */
export async function makeWorld(opt = {}) {
  const w = {
    settings: new Map(),          // settingId → {key, adapter}
    candidates: [],               // retrieve.recall 给的候选（记忆引用）
    present: null,                // retrieve 线索里的在场者（null = 让 context 自己从感知推）
    texts: new Map(),             // 记忆引用 → 渲染出来的正文
    provenance: new Map(),        // 记忆引用 → 来源说法（默认「自己说的」）
    restoring: false,             // backup.isRestoring
    verdicts: new Map(),          // 记忆引用 → 'share' | 'share_vague' | 'aware_private' | 'pending' | 'omit' | {verdict, vagueText, hintOk}
    defaultVerdict: 'share',
    mode: 'live',
    hidden: new Set(),
    due: [],                      // encode.dueIntentions 的结果
    recheck: () => ({ suppress: false, perceptIds: [] }),
    pendingCount: 0,
    retention: { current: '2y', pending: null },
    growth: '',
    past: false,
    warming: false,               // worker.queryWarming：查询模型正在冷加载
    degrade: 0,
    cachedSet: null,
    throws: {},                   // 'retrieve.recall' / 'discretion.gate' / 'discretion.targetFor' … → 抛错
    hangs: {},                    // 'retrieve.recall' / 'discretion.gate' → 返回一个永远不落定的 promise（D117 的乱抛错测试）
    calls: { retrieve: [], gate: [], targetFor: [], seal: [], logDecision: [], recheck: [], render: [] },
    members: new Map(),           // 场合键 → 成员实体 id（能列全时）
    ids: {},
  };
  const boom = (name) => { if (w.throws[name]) throw new Error(`替身故障：${name}`); };

  const mods = {
    intake: {
      resolveSetting: (core, settingId) => { boom('intake.resolveSetting'); return w.settings.get(settingId) ?? null; },
      settingByKey: (core, key) => {
        const [sid] = [...w.settings.entries()].find(([, v]) => v.key === key) ?? [];
        if (!sid) return null;
        return { key, adapter: ADAPTER, label: sid, stability: 'persistent', parentKey: null, entityId: null, snapshotId: null,
          descriptor: DESCRIPTORS[sid] ?? null, exposureRank: 1, persistenceRank: 1, reachHash: 'r' };
      },
      sanitizeForPrompt: (core, text) => String(text).replace(/【/g, '「').replace(/】/g, '」').replace(/\s*\n+\s*/g, ' '),
      sealBuffers: (core, settingId) => { w.calls.seal.push(settingId); },
    },
    retrieve: {
      recall: async (core, s, o) => {
        w.calls.retrieve.push({ s, o });
        boom('retrieve.recall');
        if (w.hangs['retrieve.recall']) return new Promise(() => {});
        if (w.recallResult) return w.recallResult;   // 原样交回（坏形状的候选集，D117）
        return candidateSet(w.candidates, s.settingKey, w);
      },
      cached: (core, key) => w.cachedSet,
      // 照 retrieve.render 的契约：share_vague 只用含糊版本；opt.previous（旧版本也过了关口①）渲染成「之前……，后来……」；
      // opt.settingKey 是目标场合（这里只记下来，断言用）
      render: (core, c, o) => {
        w.calls.render.push({ ref: c.ref, verdict: o.verdict, settingKey: o.settingKey ?? null, previous: o.previous?.candidate?.ref ?? null, itemChars: o.itemChars });
        boom('retrieve.render');
        const body = (ref, v, vague) => (v === 'share_vague' ? (vague ?? '有人提过一件事') : (w.texts.get(ref) ?? `记忆 ${ref}`));
        let text = body(c.ref, o.verdict, o.vagueText);
        if (o.previous && o.verdict === 'share') text = `之前${body(o.previous.candidate.ref, o.previous.verdict, o.previous.vagueText)}，后来${text}`;
        const provenance = o.verdict === 'share_vague' ? '听人说的' : (w.provenance.get(c.ref) ?? '自己说的');
        return { rendered: Array.from(text).slice(0, o.itemChars).join(''), provenance, confidence: 0.9 };
      },
      looksLikePast: async () => { boom('retrieve.looksLikePast'); return w.past; },
      degradeLevel: () => w.degrade,
    },
    discretion: {
      targetFor: (core, p) => {
        w.calls.targetFor.push(p);
        boom('discretion.targetFor');
        let taint = false;
        if (p.sessionId) { try { taint = !!core.mods.context.sessionInfo(core, p.sessionId)?.turnTainted; } catch { taint = true; } }
        const members = w.members.get(p.settingKey) ?? null;
        return {
          audience: { settingKey: p.settingKey, snapshotId: null, members, recentSpeakers: members ?? [], completeness: members ? 'exact' : 'unknown',
            unknownObservers: false, exposureRank: 1, persistenceRank: 1, size: members?.length ?? 'unknown', preSendGate: true, canHold: false },
          homeSettingKey: p.homeSettingKey, sessionId: p.sessionId, triggerEntityId: p.triggerEntityId, taint, mode: p.mode,
        };
      },
      gate: async (core, cands, target, o) => {
        w.calls.gate.push({ refs: cands.map((c) => c.ref), target, mode: o.mode });
        boom('discretion.gate');
        if (w.hangs['discretion.gate']) return new Promise(() => {});
        const out = [];
        for (const c of cands) {
          let v = w.verdicts.get(c.ref) ?? w.defaultVerdict;
          if (typeof v === 'function') v = v(target, o.mode);
          const r = typeof v === 'string' ? { verdict: v } : v;
          let verdict = r.verdict;
          if (verdict === 'pending' && o.mode !== 'deliberate') verdict = 'omit';   // 不自主回想：没判完的这一轮不给
          const m = parseRef(c.ref);
          const id = Number(core.store.run(`INSERT INTO appraisals(stage, rule, memory_kind, memory_id, setting_key, taint, verdict, vague_text, hint_ok, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, verdict === 'share' ? 1 : 2, 'test', m.kind, m.id, target.audience.settingKey, target.taint ? 1 : 0,
          verdict, r.vagueText ?? null, r.hintOk ? 1 : 0, core.now()).lastInsertRowid);
          if (verdict === 'omit') continue;
          // GatedItem 的可选字段：told（S14，告诉过这批人）、hintSpecific（§9.3.4，暗示可以具体一点）
          out.push({ ref: c.ref, verdict, vagueText: r.vagueText ?? null, hintOk: r.hintOk ?? verdict === 'aware_private', appraisalRef: `ap${id}`, stage: 2, rule: 'test',
            ...(r.told ? { told: r.told } : {}), ...(verdict === 'aware_private' && r.hintSpecific != null ? { hintSpecific: !!r.hintSpecific } : {}) });
        }
        return out;
      },
      logDecision: (core, e) => { w.calls.logDecision.push(e); },
    },
    admin: {
      modeFor: () => { boom('admin.modeFor'); return w.mode; },
      suppressedRefs: (core, refs) => { boom('admin.suppressedRefs'); return new Set(refs.filter((r) => w.hidden.has(r))); },
      pendingCount: () => w.pendingCount,
      retentionState: () => w.retention,
    },
    encode: {
      dueIntentions: () => w.due,
      recheckIntention: async (core, id) => { w.calls.recheck.push(id); return w.recheck(id); },
    },
    consolidate: { growthBlock: () => { boom('consolidate.growthBlock'); return { text: w.growth, version: 1 }; } },
    entities: { principals: (core) => (w.ids.owner ? [w.ids.owner] : []) },
    backup: { isRestoring: () => { boom('backup.isRestoring'); return w.restoring; } },
    worker: { queryWarming: () => { boom('worker.queryWarming'); return w.warming === true; } },
  };
  for (const [k, v] of Object.entries(opt.mods ?? {})) mods[k] = { ...(mods[k] ?? {}), ...v };

  const { core, ports, cleanup } = await createTestCore({ name: 'context', mods, config: { time: { tzOffsetMin: 480 }, ...(opt.config ?? {}) } });
  for (const sid of [GROUP, DM, DM2, OTHER]) w.settings.set(sid, { key: core.keys.settingKey(ADAPTER, sid), adapter: ADAPTER });
  w.key = (sid) => w.settings.get(sid).key;
  w.ids.self = entity(core, { name: '她', isSelf: 1 });
  w.ids.owner = entity(core, { name: '小秋', closeness: 1, authority: 'principal' });
  w.ids.ming = entity(core, { name: '阿明', closeness: 0.4 });
  w.ids.hong = entity(core, { name: '小红', closeness: 0.2 });
  w.members.set(w.key(DM), [w.ids.self, w.ids.owner]);
  w.members.set(w.key(DM2), [w.ids.self, w.ids.ming]);
  return { core, ports, w, clock: ports.clock, logger: ports.logger, cleanup };
}

/** 跑完就清理。 */
export async function withWorld(fn, opt) {
  const ctx = await makeWorld(opt);
  try { return await fn(ctx); } finally { await ctx.cleanup(); }
}

function candidateSet(refs, settingKey, w) {
  const items = refs.map((x, i) => {
    const r = typeof x === 'string' ? { ref: x } : x;
    // 候选上 retrieve 另带的字段（previousRef / versionOf / outcomeOf / attachedTo / belief / fok …）原样带过去
    const { ref, ranks, P, ...extra } = r;
    return { ...extra, ref, mref: parseRef(ref), ranks: ranks ?? { lexical: i + 1 }, rrf: 0.01, signals: {}, A: 0.5, P: P ?? 0.8,
      parts: { B: 0, S: 0, C: 0, I: 0, Psup: 0, eps: 0 } };
  });
  return {
    items,
    cues: { settingKey, focusPerceptId: null, latestPerceptId: 0, window: [], present: w.present ?? undefined, mentioned: [], names: [],
      timeWindows: w.timeWindows ?? [], queryTexts: [], lang: 'zh', pastQuestion: false, hash: 'h' },
    degradeLevel: w.degrade,
    routeMs: {},
    traceId: 'tr',
  };
}

// ── 夹具 ──────────────────────────────────────────────────────────────────

export function entity(core, { name = null, closeness = 0, authority = 'none', isSelf = 0, at = core.now(), kind = 'person' } = {}) {
  return Number(core.store.run(`INSERT INTO entities(kind, display_name, closeness, authority, is_self, first_mention_at, last_mention_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, isSelf ? 'self' : kind, name, closeness, authority, isSelf, at, at, at, at).lastInsertRowid);
}

let extSeq = 0;
/** 一条感知（to-her / ambient / by-her）。obsId 给了就按适配器的 ObsId 存 ext_key（focusObsId 能找到它）。 */
export function percept(core, w, { sid = GROUP, at = core.now(), actor = null, self = false, addressed = 'ambient', kind = null, text = '……', obsId = null } = {}) {
  const key = w.key(sid);
  const ext = obsId ? core.keys.obsKey(ADAPTER, obsId) : `x${(extSeq += 1)}`;
  const k = kind ?? (self ? 'self-utterance' : 'utterance');
  return Number(core.store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_entity_id, actor_self,
      actor_json, kind, text, text_hash, addressed, attention, attention_class, evidential, standing, w_enc, created_at)
    VALUES (?, ?, ?, ?, 'setting-audience', ?, ?, ?, ?, '{}', ?, ?, 'h', ?, 'attended', 'toHer', 1, 'first-hand', 1, ?)`,
  ADAPTER, ext, key, key, at, at, self ? w.ids.self : actor, self ? 1 : 0, k, text, self ? 'by-her' : addressed, at).lastInsertRowid);
}

export function episode(core, w, { sid = GROUP, kind = 'event', at = core.now(), title = '一段经历' } = {}) {
  return Number(core.store.run(`INSERT INTO episodes(setting_key, ep_kind, title, narrative, t_start, t_end, sealed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, w.key(sid), kind, title, title, at - 10 * M, at, at, at).lastInsertRowid);
}

export function rawWindow(core, w, { sid = GROUP, first, last, at = core.now() }) {
  return Number(core.store.run(`INSERT INTO raw_windows(setting_key, members_json, first_percept, last_percept, n_percepts, t_start, t_end, text, created_at)
    VALUES (?, '[]', ?, ?, ?, ?, ?, '……', ?)`, w.key(sid), first, last, last - first + 1, at - 5 * M, at, at).lastInsertRowid);
}

export function storyline(core, w, { sid = GROUP, text = '这个群最近在聊团建', at = core.now() } = {}) {
  return Number(core.store.run('INSERT INTO storylines(setting_key, text, version, updated_at) VALUES (?, ?, 1, ?)', w.key(sid), text, at).lastInsertRowid);
}

export function impression(core, entityId, { layer = 'shared', text = '爱玩梗', at = core.now() } = {}) {
  return Number(core.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, version, is_current, built_at) VALUES (?, ?, ?, 1, 1, ?)`,
    entityId, layer, text, at).lastInsertRowid);
}

export function entityName(core, entityId, text, { scope = '', spoof = 0, count = 1, at = core.now() } = {}) {
  core.store.run(`INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, spoof, count, first, last) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    entityId, text, text, scope, spoof, count, at, at);
}

export function plan(core, { text = '明天去拿快递', start, agent, at = core.now() }) {
  const id = Number(core.store.run(`INSERT INTO assertions(predicate, text, kind_hint, certainty, recorded_at, created_at, updated_at, event_start, plan_agent, plan_status)
    VALUES ('plan', ?, 'plan', 'stated', ?, ?, ?, ?, ?, 'planned')`, text, at, at, at, start, agent).lastInsertRowid);
  core.store.run(`INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')`, id, agent);
  return id;
}

export function intention(core, { target, aboutKind = null, aboutId = null, text = '问问那件事怎么样了', at = core.now(), state = 'armed' }) {
  return Number(core.store.run(`INSERT INTO intentions(about_kind, about_id, target_entity_id, act, text, origin, trigger_json, state, formed_at, armed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'ask', ?, 'self-care', ?, ?, ?, ?, ?, ?)`, aboutKind, aboutId, target, text, JSON.stringify({ cues: [{ entity: target }] }),
  state, at, at, at, at).lastInsertRowid);
}

/** dueIntentions 返回的行（和 encode 的实现一样：intentions 行 + cueHit）。 */
export function dueRow(core, id, cueHit = false) {
  return { ...core.store.get('SELECT * FROM intentions WHERE id = ?', id), cueHit };
}

export { refOf, parseRef };
