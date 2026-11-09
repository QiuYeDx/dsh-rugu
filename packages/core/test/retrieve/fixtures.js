// retrieve 测试用的数据和替身。依赖的模块（lang、intake、entities、dynamics、worker、admin、discretion）一律换成照着各自契约写的
// 小替身（docs/实现/模块与接口.md 附录 A），不依赖它们的真实实现（并行开发期间它们可能还没写完）。
// 数据直接写进表里（测试准备数据，不是模块代码，不受「一张表一个拥有者」约束）。
// 只从替身各自的文件 import（fakes/index.js 会顺带 import api.js，也就加载了全部模块）。
import { fakePorts } from '../fakes/ports.js';
import { FakeEmbedding, cosine } from '../fakes/embedding.js';
import { ensurePerceptShard, ftsInsert, ftsSearch, entityToken, normalizeToken } from '../../src/store/fts.js';
import { isolatedCore } from './core.js';

export const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);   // 2026-10-31 12:00Z（测试里时区偏移固定为 0）
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// ── 分词：中文二元组 + ASCII 词（和替身 lang 一致，FTS 里存的、查询用的是同一套）──
export function tokenize(text) {
  const out = [];
  const t = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const m of t.matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    const s = m[0];
    if (/^[a-z0-9]+$/.test(s)) { out.push(s); continue; }
    const cs = [...s];
    if (cs.length === 1) out.push(cs[0]);
    for (let i = 0; i + 1 < cs.length; i++) out.push(cs[i] + cs[i + 1]);
  }
  return [...new Set(out.map(normalizeToken).filter(Boolean))];
}


// ── 通用插入：别的模块的表还在变（并行开发），没有默认值的 NOT NULL 列按类型填一个值，测试数据只给关心的列 ──
const colCache = new Map();
export function insertRow(core, table, values) {
  let cols = colCache.get(table);
  if (!cols) {
    cols = core.store.all(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${table}')`);
    colCache.set(table, cols);
  }
  const row = {};
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name];
    else if (c.nn && c.d == null && !(c.pk && /INT/i.test(c.type))) {
      row[c.name] = /INT/i.test(c.type) ? (/_at$|^at$|^first$|^last$/.test(c.name) ? T0 : 0) : /REAL/i.test(c.type) ? 0 : /BLOB/i.test(c.type) ? new Uint8Array(0) : '';
    }
  }
  const names = Object.keys(row);
  const r = core.store.run(`INSERT OR IGNORE INTO ${table}(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, ...names.map((n) => row[n]));
  return Number(r.lastInsertRowid);
}

// ── 种数据 ──────────────────────────────────────────────────────────────
export function seedSetting(core, key, { label = '', adapter = 'fake', parentKey = null, stability = 'persistent', descriptor = null, at = T0 - 30 * DAY } = {}) {
  insertRow(core, 'settings', { key, adapter, label, stability, parent_key: parentKey, first_seen: at, last_seen: at });
  if (descriptor) {
    const id = insertRow(core, 'setting_snapshots', { setting_key: key, at, descriptor_json: JSON.stringify(descriptor), descriptor_hash: 'h',
      reach_hash: 'r', exposure_rank: 1, persistence_rank: 1 });
    core.store.run('UPDATE settings SET current_snapshot_id = ? WHERE key = ?', id, key);
  }
  return key;
}

export function seedEntity(core, { name = null, kind = 'person', isSelf = false, authority = 'none', closeness = 0, names = [], at = T0 - 30 * DAY } = {}) {
  const id = insertRow(core, 'entities', { kind: isSelf ? 'self' : kind, display_name: name, is_self: isSelf ? 1 : 0, closeness, authority,
    created_at: at, updated_at: at });
  for (const n of [name, ...names].filter(Boolean)) addName(core, id, typeof n === 'string' ? { text: n } : n);
  return id;
}
export function addName(core, entityId, { text, scope = '', count = 1, usedBy = 0 }) {
  insertRow(core, 'entity_names', { entity_id: entityId, text_raw: text, text_norm: text.toLowerCase(), used_by: usedBy, scope_setting_key: scope,
    count, first: T0 - DAY, last: T0 - DAY });
}
export function seedDescriptor(core, entityId, anchor, relation, text = relation) {
  insertRow(core, 'entity_descriptors', { entity_id: entityId, anchor_entity_id: anchor, relation, text, created_at: T0, first_at: T0, last_at: T0 });
}

let extSeq = 0;
export function seedPercept(core, {
  settingKey, at = T0, actor = null, self = false, kind = 'utterance', text = '', addressed = 'ambient', attention = 'attended',
  visibleTo = 'setting-audience', standing = 'first-hand', windowId = null, episodeId = null, mentions = null, replyToKey = null,
  extKey = null, adapter = 'fake', textState = 'normal', historical = false,
} = {}) {
  const key = extKey ?? `x${++extSeq}`;
  const id = insertRow(core, 'percepts', {
    adapter, ext_key: key, setting_key: settingKey, perceived_in: settingKey, visible_to: visibleTo, at, perceived_at: at, actor_entity_id: actor,
    actor_self: self ? 1 : 0, actor_json: '{}', kind, text, text_state: textState, text_hash: `h:${text}`, addressed, attention, attention_class: 'toHer',
    evidential: 1, w_enc: 1, standing, window_id: windowId, episode_id: episodeId, mentions_json: mentions ? JSON.stringify(mentions) : null,
    reply_to_key: replyToKey, historical: historical ? 1 : 0, created_at: at,
  });
  const shard = ensurePerceptShard(core.store, at);
  ftsInsert(core.store, shard, id, tokenize(text));
  core.store.run('UPDATE percepts SET fts_shard = ? WHERE id = ?', shard, id);
  return id;
}

export function seedWindow(core, { settingKey, first, last, tStart, tEnd, text }) {
  const id = insertRow(core, 'raw_windows', { setting_key: settingKey, first_percept: first, last_percept: last, n_percepts: last - first + 1,
    t_start: tStart, t_end: tEnd, text, created_at: tEnd });
  core.store.run('UPDATE percepts SET window_id = ? WHERE setting_key = ? AND id BETWEEN ? AND ?', id, settingKey, first, last);
  return id;
}

export function seedEpisode(core, { settingKey, narrative = '', header = '', title = '', tStart = T0, tEnd = tStart, participants = [], epKind = 'event', sources = [] }) {
  const id = insertRow(core, 'episodes', { setting_key: settingKey, ep_kind: epKind, title, narrative, header, t_start: tStart, t_end: tEnd,
    participants_json: JSON.stringify(participants), sealed_at: tEnd, created_at: tEnd });
  // 和 encode 写情节一样：参与者的实体词元也进 FTS（扇出项按它数情节）
  ftsInsert(core.store, 'episodes_fts', id, [...tokenize(`${header} ${narrative}`), ...participants.map(entityToken)]);
  for (const s of sources) seedSource(core, 'episode', id, s);
  return id;
}

export function seedAssertion(core, {
  text, predicate = 'p', subjects = [], objects = [], mentions = [], certainty = 'stated', confidence = 0.9, kindHint = 'fact',
  eventStart = null, eventEnd = null, validFrom = null, validTo = null, t50 = null, shape = null, changeKnown = false, recordedAt = T0,
  supersedes = null, supersededBy = null, planStatus = null, plannedTime = null, sources = [], occurrenceKey = null,
}) {
  const id = insertRow(core, 'assertions', {
    predicate, text, kind_hint: kindHint, certainty, confidence, imp: 5, event_start: eventStart, event_end: eventEnd, valid_from: validFrom,
    valid_to_known: validTo, change_known: changeKnown ? 1 : 0, t50_h: t50, shape, recorded_at: recordedAt, supersedes, superseded_by: supersededBy,
    plan_status: planStatus, planned_time_json: plannedTime ? JSON.stringify(plannedTime) : null, occurrence_key: occurrenceKey,
    created_at: recordedAt, updated_at: recordedAt,
  });
  for (const [role, list] of [['subject', subjects], ['object', objects], ['mention', mentions]]) {
    for (const e of list) insertRow(core, 'assertion_entities', { assertion_id: id, entity_id: e, role });
  }
  ftsInsert(core.store, 'assertions_fts', id, [...tokenize(text), ...subjects.map(entityToken)]);
  for (const s of sources) seedSource(core, 'assertion', id, s);
  return id;
}
export function supersede(core, oldId, newId) {
  core.store.run('UPDATE assertions SET superseded_by = ?, expired_at = ? WHERE id = ?', newId, T0, oldId);
  core.store.run('UPDATE assertions SET supersedes = ? WHERE id = ?', oldId, newId);
}
export function seedSource(core, ownerKind, ownerId, { speaker = null, asserter = null, mode = 'told_to_her', hop = 0, perceivedIn = null, at = T0, perceptId = null, confidence = 0.9 } = {}) {
  insertRow(core, 'sources', { owner_kind: ownerKind, owner_id: ownerId, percept_id: perceptId, perceived_in: perceivedIn, speaker,
    asserter: asserter ?? speaker, mode, hop, confidence, at });
}
export function sameType(core, a, b) {
  insertRow(core, 'same_type', { a: Math.min(a, b), b: Math.max(a, b) });
}
/** 登记一个向量空间（worker 的表还在变：没有默认值的 NOT NULL 列一律按类型填一个值）。 */
export function seedSpace(core, spaceId, status = 'active') {
  const given = { space_id: spaceId, status, model: 'fake', dim: 256, doc_tpl_ver: '1', created_at: T0 };
  const cols = core.store.all("SELECT name, type, \"notnull\" AS nn, dflt_value AS d, pk FROM pragma_table_info('vector_spaces')");
  const row = {};
  for (const c of cols) {
    if (c.name in given) row[c.name] = given[c.name];
    else if (c.nn && c.d == null && !c.pk) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : /BLOB/i.test(c.type) ? new Uint8Array(0) : spaceId;
  }
  const names = Object.keys(row);
  core.store.run(`INSERT INTO vector_spaces(${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, ...names.map((n) => row[n]));
}
export function seedPresence(core, settingKey, members, completeness = 'exact', at = T0) {
  insertRow(core, 'presence_sets', { setting_key: settingKey, at, members_json: JSON.stringify(members), completeness, members_hash: JSON.stringify(members) });
}

// ── 替身 ────────────────────────────────────────────────────────────────

/** lang：注册表 + queryTerms。时间表达只认测试里用到的几个写法（替身可以有固定词，核心不行）。 */
export function fakeLang(calls = {}) {
  const registry = {
    get: () => registry,
    detect: () => 'zh',
    tokenize: (text) => tokenize(text),
    parseTime: (text, at) => {
      const day = (n) => { const d = Math.floor(at / DAY) * DAY + n * DAY; return { start: d, end: d + DAY - 1, precision: 'day' }; };
      const out = [];
      if (/昨天/.test(text)) out.push({ ...day(-1), text: '昨天' });
      if (/上周/.test(text)) out.push({ start: Math.floor(at / DAY) * DAY - 7 * DAY, end: Math.floor(at / DAY) * DAY - 1, precision: 'week', text: '上周' });
      if (/明天/.test(text)) out.push({ ...day(1), text: '明天' });
      return out;
    },
    questionCue: (text) => (/[吗呢？?]$|了没|没有$/.test(String(text).trim()) ? 1 : 0),
    pastQuestionExemplars: () => ['你还记得那件事吗', '那个拿了没', '上次说的那个'],
    setUserDictionary: () => {},
    info: { jieba: false, langs: ['zh', 'und'] },
  };
  return {
    registry: () => registry,
    queryTerms: (core, text, opt = {}) => {
      calls.queryTerms = (calls.queryTerms ?? 0) + 1;
      return [...tokenize(text), ...(opt.entityIds ?? []).map(entityToken)];
    },
  };
}

/** intake：读感知、场合；清洗只做 §10.4 的两件（【】→「」、折叠换行）。 */
export function fakeIntake() {
  return {
    recentPercepts: (core, settingKey, opt = {}) => {
      const kinds = opt.kinds ?? null;
      const rows = core.store.all(`SELECT * FROM percepts WHERE setting_key = ? AND id < ? ${kinds ? `AND kind IN (${kinds.map(() => '?').join(',')})` : ''}
        ORDER BY id DESC LIMIT ?`, settingKey, opt.beforeId ?? Number.MAX_SAFE_INTEGER, ...(kinds ?? []), opt.limit ?? 10);
      return rows.reverse();
    },
    settingByKey: (core, key) => {
      const r = core.store.get('SELECT * FROM settings WHERE key = ?', key);
      if (!r) return null;
      const snap = r.current_snapshot_id ? core.store.get('SELECT descriptor_json FROM setting_snapshots WHERE id = ?', r.current_snapshot_id) : null;
      return { key: r.key, adapter: r.adapter, label: r.label, stability: r.stability, parentKey: r.parent_key, entityId: r.entity_id,
        snapshotId: r.current_snapshot_id, descriptor: snap ? JSON.parse(snap.descriptor_json) : null, exposureRank: 1, persistenceRank: 1, reachHash: 'r' };
    },
    snapshotById: (core, id) => {
      const r = core.store.get('SELECT * FROM setting_snapshots WHERE id = ?', id);
      return r ? { id: r.id, settingKey: r.setting_key, at: r.at, descriptor: JSON.parse(r.descriptor_json), exposureRank: 1, persistenceRank: 1, reachHash: 'r' } : null;
    },
    sanitizeForPrompt: (core, t) => String(t ?? '').replaceAll('【', '「').replaceAll('】', '」').replace(/\s*\n\s*/g, ' '),
  };
}

/** entities：档案（读表）、名字匹配器（子串匹配，同名的都返回）、管理者。 */
export function fakeEntities() {
  const profile = (core, id) => {
    const e = core.store.get('SELECT * FROM entities WHERE id = ?', id);
    if (!e) return null;
    return {
      id: e.id, kind: e.kind, status: e.status, displayName: e.display_name, isSelf: !!e.is_self,
      bond: { closeness: e.closeness, authority: e.authority },
      names: core.store.all('SELECT text_raw AS text, used_by AS usedBy, scope_setting_key AS scopeSettingKey, count, last FROM entity_names WHERE entity_id = ?', id),
      descriptors: core.store.all('SELECT anchor_entity_id AS anchor, relation, text FROM entity_descriptors WHERE entity_id = ?', id),
      identities: [], links: [], impressions: [],
    };
  };
  return {
    profile,
    principals: (core) => core.store.all("SELECT id FROM entities WHERE authority = 'principal'").map((r) => r.id),
    nameMatcher: (core) => {
      const names = core.store.all('SELECT entity_id, text_raw, scope_setting_key FROM entity_names');
      const descs = core.store.all('SELECT entity_id, anchor_entity_id AS anchor, relation, text FROM entity_descriptors');
      return {
        version: names.length + descs.length,
        // 契约（entities.NameMatcher）：同名的都返回；opt.anchors 给了时，正文里的关系词挂在锚点或紧挨着的名字下面的档案也返回（via='relation'）
        scan: (text, opt = {}) => {
          const t = String(text);
          const out = [];
          const named = [];
          for (const n of names) {
            if (n.scope_setting_key && opt.settingKey && n.scope_setting_key !== opt.settingKey) continue;
            const i = t.indexOf(n.text_raw);
            if (i >= 0) { out.push({ entityId: n.entity_id, name: n.text_raw, start: i, end: i + n.text_raw.length, score: 1, via: 'name' }); named.push({ e: n.entity_id, end: i + n.text_raw.length }); }
          }
          for (const d of descs) {
            const word = d.text || d.relation;
            const i = t.indexOf(word);
            if (i < 0) continue;
            const adjacent = named.some((n) => n.e === d.anchor && (n.end === i || (n.end + 1 === i && t[n.end] === '的')));
            if (adjacent || (opt.anchors ?? []).includes(d.anchor)) out.push({ entityId: d.entity_id, name: word, start: i, end: i + word.length, score: 0.9, via: 'relation', anchor: d.anchor });
          }
          return out;
        },
      };
    },
  };
}

/**
 * dynamics：照 §6.5 的公式（A = B + S + C + I − P_sup + ε，P = σ((A − τ)/s)），B 由测试给（默认 0），ε = 0；
 * 不自主回想取 P ≥ 0.5（确定的），有意回想取 A ≥ τ_del。pHold / tense 照 §5.4。
 */
export function fakeDynamics({ B = {}, calls = {} } = {}) {
  const sig = (x) => 1 / (1 + Math.exp(-x));
  return {
    activate: (core, inputs, ctx) => {
      calls.activate = (calls.activate ?? []);
      calls.activate.push({ n: inputs.length, ctx, inputs });
      const a = core.config.get().activation;
      const tau = ctx.mode === 'deliberate' ? a.tauDeliberate : a.tauInvoluntary;
      return inputs.map((i) => {
        const b = B[i.candidate.ref] ?? 0;
        const I = i.intention ? (i.cueHit ? 1.5 : 1.0) : 0;
        const Psup = i.superseded ? a.supersededPenalty : 0;
        const A = b + i.S + i.C + I - Psup;
        return { ...i.candidate, A, P: sig((A - tau) / a.s), parts: { B: b, S: i.S, C: i.C, I, Psup, eps: 0 } };
      });
    },
    sample: (core, scored, ctx) => {
      calls.sample = (calls.sample ?? []);
      calls.sample.push(ctx);
      const a = core.config.get().activation;
      return ctx.mode === 'deliberate' ? scored.filter((c) => c.A >= a.tauDeliberate) : scored.filter((c) => c.P >= 0.5);
    },
    pRecall: (A, tau, s) => sig((A - tau) / s),
    pHold: (core, r, at) => {
      if (r.valid_to_known != null && at > r.valid_to_known) return 0;
      if (r.t50_h == null) return r.change_known ? 0.3 : 1;
      const from = r.valid_from ?? r.recorded_at;
      const p = 2 ** -(((at - from) / 3_600_000 / r.t50_h) ** (r.shape ?? 1));
      return r.change_known ? p * 0.3 : p;
    },
    tense: (core, p) => (p > 0.7 ? 'present' : p < 0.3 ? 'past' : 'uncertain'),
  };
}

/**
 * worker：稠密路用 FakeEmbedding 的向量算余弦（每条记忆取几条查询向量里的最大值）；词法路用真的 FTS 表（store.ftsSearch）；
 * PPR 只走一跳（种子 → 事实 → 种子实体本身），分数 = 种子权重；storedVectors 给登记过的文档向量。
 */
export function fakeWorker(embedding, { delays = {}, calls = {} } = {}) {
  const docs = new Map();
  const wait = (k, signal) => (delays[k] ? new Promise((r) => { const t = setTimeout(r, delays[k]); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }); }) : null);
  const api = {
    docs,
    addDoc(ref, text, layer = 'memory') { docs.set(ref, { layer, vec: embedding.vector(text) }); },
    embedQuery: async (core, texts, opt) => {
      (calls.embedQuery ??= []).push(texts);
      if (delays.embed) await wait('embed', opt?.signal);
      if (opt?.signal?.aborted) return null;
      try { return await core.ports.embedding.embed(texts, 'query'); } catch { return null; }
    },
    denseSearch: async (core, q, opt) => {
      (calls.denseSearch ??= []).push(q);
      if (delays.dense) await wait('dense', opt?.signal);
      const hits = [];
      for (const [ref, d] of docs) {
        if (!q.layers.includes(d.layer) || q.exclude?.has(ref)) continue;
        let s = -1;
        for (const v of q.vectors) s = Math.max(s, cosine(v, d.vec));
        hits.push({ ref, score: s, layer: d.layer });
      }
      hits.sort((a, b) => b.score - a.score);
      const mem = hits.filter((h) => h.layer === 'memory').slice(0, q.topK.memory);
      const raw = hits.filter((h) => h.layer === 'raw').slice(0, q.topK.raw);
      return { hits: [...mem, ...raw].sort((a, b) => b.score - a.score).map(({ ref, score }) => ({ ref, score })), timedOut: false };
    },
    lexicalSearch: async (core, q, opt) => {
      (calls.lexicalSearch ??= []).push(q);
      if (delays.lexical) await wait('lexical', opt?.signal);
      const hits = [];
      for (const table of q.tables) {
        const prefix = table.startsWith('percepts_fts_') ? 'p' : table === 'episodes_fts' ? 'e' : 'a';
        for (const r of ftsSearch(core.store, table, q.terms, { limit: q.limit })) hits.push({ ref: `${prefix}${r.rowid}`, score: -r.score });
      }
      return { hits: hits.sort((a, b) => b.score - a.score).slice(0, q.limit), timedOut: false };
    },
    termStats: async (core, terms) => {
      (calls.termStats ??= []).push(terms);
      const m = new Map();
      const total = Math.max(1, core.store.get('SELECT COUNT(*) AS n FROM percepts').n + core.store.get('SELECT COUNT(*) AS n FROM assertions').n);
      for (const t of terms) {
        const n = calls.common?.has(t) ? total : 0;
        m.set(t, { idf: Math.log(1 + total / (1 + n)) + (t.length > 1 ? 0.01 * t.length : 0), rowFraction: n / total });
      }
      return m;
    },
    pprSearch: async (core, q, opt) => {
      (calls.pprSearch ??= []).push(q);
      if (delays.ppr) await wait('ppr', opt?.signal);
      const score = new Map();
      const put = (ref, v) => score.set(ref, Math.max(score.get(ref) ?? 0, v));
      // 实体链接也是图上的边（same 1.0、maybe_same 0.5，乘置信度；not_same 不走），和 worker 的图一样
      const ents = new Map();
      for (const s of q.seeds) {
        ents.set(s.entityId, Math.max(ents.get(s.entityId) ?? 0, s.weight));
        for (const l of core.store.all("SELECT a, b, rel, confidence FROM entity_links WHERE (a = ? OR b = ?) AND rel <> 'not_same'", s.entityId, s.entityId)) {
          const other = l.a === s.entityId ? l.b : l.a;
          const w = s.weight * (l.rel === 'same' ? 1 : 0.5) * l.confidence;
          ents.set(other, Math.max(ents.get(other) ?? 0, w));
        }
      }
      for (const [e, wt] of ents) {
        put(`n${e}`, wt);
        for (const r of core.store.all('SELECT assertion_id FROM assertion_entities WHERE entity_id = ?', e)) put(`a${r.assertion_id}`, wt * 0.8);
      }
      return { hits: [...score].map(([ref, s]) => ({ ref, score: s })).sort((a, b) => b.score - a.score).slice(0, q.limit), timedOut: false };
    },
    storedVectors: async (core, refs) => new Map(refs.filter((r) => docs.has(r)).map((r) => [r, docs.get(r).vec])),
  };
  return api;
}

export function fakeAdmin(hidden = new Set(), calls = {}) {
  return {
    suppressedRefs: (core, refs) => { (calls.suppressedRefs ??= []).push(refs); return new Set(refs.filter((r) => hidden.has(r))); },
  };
}

/** discretion：只给 retrieve 会读的两个函数；normOf 被调用就是 bug（召回从不按「这里能不能说」过滤）。 */
export function fakeDiscretion({ circles = new Map(), audience = null } = {}) {
  return {
    knownCircle: (core, mref) => circles.get(`${mref.kind}:${mref.id}`) ?? { entities: new Set(), settings: [], presenceSets: [], selfOnly: false, publicAvailable: false, claimed: [] },
    audienceOf: (core, settingKey) => audience ?? { settingKey, snapshotId: null, members: null, recentSpeakers: [], completeness: 'unknown', unknownObservers: true,
      exposureRank: 1, persistenceRank: 1, size: 'unknown', preSendGate: true, canHold: false },
    normOf: () => { throw new Error('retrieve 不该读规范'); },
    stage1: () => { throw new Error('retrieve 不该做分寸判定'); },
  };
}

/**
 * 一个只换掉依赖的测试核心：retrieve 是真的，其余全是替身。
 * @returns {Promise<{core: any, cleanup: Function, worker: any, embedding: FakeEmbedding, calls: any, hidden: Set<string>, B: Record<string, number>}>}
 */
export async function retrieveCore({ embedding, ports, config = {}, extraConfig, mods = {}, delays = {}, circles, audience, gpu = false, rerank = null, llm } = {}) {
  const emb = embedding === undefined ? new FakeEmbedding({ device: gpu ? 'gpu' : 'cpu' }) : embedding;
  const calls = {};
  const hidden = new Set();
  const B = {};
  const worker = fakeWorker(emb ?? new FakeEmbedding(), { delays, calls });
  const p = ports ?? fakePorts({ embedding: emb, ...(rerank !== null ? { rerank } : {}), ...(llm ? { llm } : {}) });
  if (rerank === false) delete p.rerank;
  p.clock.set(T0);
  const merged = { lang: fakeLang(calls), intake: fakeIntake(), entities: fakeEntities(), dynamics: fakeDynamics({ B, calls }),
    worker, admin: fakeAdmin(hidden, calls), discretion: fakeDiscretion({ circles, audience }) };
  for (const [k, v] of Object.entries(mods)) merged[k] = { ...(merged[k] ?? {}), ...v };
  const { core, cleanup } = await isolatedCore({ ports: p, config: { time: { tzOffsetMin: 0 }, ...config }, extraConfig, mods: merged });
  if (emb) seedSpace(core, emb.spaceId);
  return { core, cleanup, worker, embedding: emb, calls, hidden, B, ports: p };
}
