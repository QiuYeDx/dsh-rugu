// encode 测试自己的 CoreContext 和小世界：真库、真迁移、替身端口；core.mods 里只有 encode 是真模块，其余全是按契约写的替身
// （没准备的函数一调用就报错——不悄悄依赖别的模块的真实现；不 import api.js，别的模块正在改、暂时加载不了时 encode 的测试照样能跑）。
// 替身记下每次调用（world.calls），测试据此断言 encode 交给别的模块的东西对不对。
// 别的模块的表（entities、percepts、setting_snapshots……）只在这里按 schema 直接插测试数据（schema 就是契约）。
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore, openVectorStore, mainDbIdOf, makeKeyring, ensurePerceptShard, ftsInsert, ftsSearch, normalizeToken, entityToken, claimNextJob } from '../../src/store/index.js';
import { refOf, parseRef } from '../../src/store/refs.js';
import { normalizePorts } from '../../src/ports/index.js';
import { createConfig } from '../../src/config/defaults.js';
import * as encode from '../../src/encode/index.js';
import { fakePorts } from '../fakes/ports.js';
import { FakeLLM } from '../fakes/llm.js';
import { MINUTE, HOUR, DAY } from '../fakes/clock.js';
import { tmpDir, rmDir } from '../helpers.js';

export { MINUTE, HOUR, DAY };
const TEST_KEY = crypto.createHash('sha256').update('rugu-core/test-key').digest();
const MODULE_NAMES = ['lang', 'admin', 'intake', 'entities', 'dynamics', 'discretion', 'encode', 'worker', 'retrieve', 'context', 'consolidate', 'backup'];
export const ADAPTER = 'fake';

function stubModule(name, fns = {}) {
  const base = { init() {}, dispose() {} };
  return new Proxy({ ...base, ...fns }, {
    get(t, k) {
      if (k in t || typeof k === 'symbol') return t[k];
      return () => { throw new Error(`测试替身：${name}.${String(k)} 没有准备`); };
    },
  });
}

/** 深合并（把还没并进 defaults.js 的键叠到当前快照上，模拟整合之后）。 */
function overlay(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? overlay(base?.[k], v) : v;
  return out;
}

/** 按表的实际列插一行：不认识的键丢掉，NOT NULL 又没默认值的列补一个（别的模块的迁移还在改，测试数据别跟着坏）。 */
export function insertRow(core, table, values) {
  const cols = core.store.all(`PRAGMA table_info(${table})`);
  const now = core.now();
  const row = {};
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name];
    else if (c.notnull && c.dflt_value == null && !c.pk) {
      const t = String(c.type).toUpperCase();
      row[c.name] = /INT|REAL/.test(t) ? (/(_at|first|last|^at$)/.test(c.name) ? now : 0) : '';
    }
  }
  const keys = Object.keys(row);
  const r = core.store.run(`INSERT INTO ${table}(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
  return Number(r.lastInsertRowid);
}

// ── 替身的语言分析：中文二元组（单字段保留单字）+ 其他文字按连续段 ─────────────────
export function tokenize(text) {
  const out = [];
  const t = String(text ?? '').normalize('NFKC').toLowerCase();
  for (const seg of t.match(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(seg)) {
      const ch = [...seg];
      if (ch.length === 1) out.push(seg);
      for (let i = 0; i + 1 < ch.length; i++) out.push(ch[i] + ch[i + 1]);
    } else out.push(seg);
  }
  return out.map(normalizeToken).filter(Boolean);
}
const uniq = (a) => [...new Set(a)];

/**
 * @param {{config?: object, extraConfig?: object, mods?: Record<string, Record<string, Function>>, ports?: object, llm?: FakeLLM}} [opt]
 */
export async function makeWorld({ config, extraConfig, mods = {}, ports, llm } = {}) {
  const raw = ports ?? fakePorts({ llm: llm ?? new FakeLLM() });
  const p = normalizePorts(raw);
  const base = createConfig({ extract: { minSpacingMs: 0 }, time: { tzOffsetMin: 480 }, ...(config ?? {}) });
  const cfg = extraConfig ? { ...base, get: () => overlay(base.get(), extraConfig) } : base;
  const dir = tmpDir('encode');
  let store;
  let vec = null;
  try {
    store = await openStore({ file: path.join(dir, 'persona-memory.db'), clock: p.clock, logger: p.logger });
    vec = openVectorStore({ file: path.join(dir, 'persona-vectors.db'), mainDbId: mainDbIdOf(store), clock: p.clock, logger: p.logger });
  } catch (e) {
    try { store?.close(); } catch { /* 尽力 */ }
    rmDir(dir);
    throw e;
  }

  const calls = {};
  const rec = (name, v) => { (calls[name] ??= []).push(v); return v; };
  const norms = new Map();      // 'a12' → 规范
  const embeds = new Map();     // 'a12' → chunks
  const windows = new Map();    // 原文窗口 id → 文本（稠密路替身用）
  const state = { background: { known: [], private: [] }, rights: new Set(), embedDown: false, ids: 0, failWriteNorm: false, termIdf: null,
    hiddenPercepts: new Set(), failInherit: false };
  const core = {
    store, vectors: vec, ports: p, config: cfg, keys: makeKeyring(TEST_KEY), adapters: new Map([[ADAPTER, { id: ADAPTER }]]), dataDir: dir, readOnly: false,
    state: {}, log: p.logger, now: () => p.clock.now(), jobHandlers: new Map(), mods: null,
    reopen: async () => { throw new Error('不支持 reopen'); },
  };
  const rs = (ref) => (typeof ref === 'string' ? ref : refOf(ref.kind, ref.id));

  const fakes = {
    lang: {
      indexTokens: (c, text, opt = {}) => uniq([...tokenize(text), ...(opt.entityIds ?? []).map(entityToken)]),
      queryTerms: (c, text, opt = {}) => uniq([...tokenize(text), ...(opt.entityIds ?? []).map(entityToken)]),
      distinctiveTerms: (c, text, opt = {}) => {
        const t = String(text ?? '');
        const ex = new Set([...(opt.exclude ?? [])].map(normalizeToken));
        const out = [...(t.match(/\d{2,}/g) ?? [])];
        for (const n of opt.names ?? []) if (t.includes(n)) out.push(n);
        const idf = opt.idf ?? state.termIdf;
        // 契约（lang.distinctiveTerms）：idf 可以返回数字，也可以返回统计 {idf, docs}——docs ≤ 1 的也算
        if (idf) {
          for (const w of tokenize(t)) {
            const v = idf(w);
            const st = v && typeof v === 'object' ? v : null;
            if ((st ? st.idf : v) >= (opt.minIdf ?? 3) || (st && Number.isFinite(st.docs) && st.docs <= 1)) out.push(w);
          }
        }
        return uniq(out.map(normalizeToken)).filter((w) => w && !ex.has(w));
      },
      registry: () => ({
        parseTime: (text, at) => {
          // 替身只认「明天」「今晚」：够测「when 换成时间窗」
          const d0 = Math.floor((at + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
          if (/明天/.test(text)) return [{ start: d0 + DAY, end: d0 + 2 * DAY - 1, precision: 'day' }];
          if (/今晚/.test(text)) return [{ start: d0 + 18 * HOUR, end: d0 + DAY - 1, precision: 'fuzzy' }];
          return [];
        },
      }),
    },
    entities: {
      ensureSelf: () => {
        const r = store.get('SELECT id FROM entities WHERE is_self = 1');
        if (r) return r.id;
        return insertRow(core, 'entities', { kind: 'self', status: 'established', display_name: '我', is_self: 1, closeness: 0, authority: 'none', created_at: core.now(), updated_at: core.now() });
      },
      bondOf: (c, id) => {
        const r = store.get('SELECT closeness, authority, is_self FROM entities WHERE id = ?', id);
        return { closeness: r?.closeness ?? 0, authority: r?.authority ?? 'none', isSelf: !!r?.is_self };
      },
      isIndividual: (c, id) => {
        const k = store.get('SELECT kind FROM entities WHERE id = ?', id)?.kind;
        return k == null || k === 'person' || k === 'self';
      },
      rightsHolder: (c, a, b) => a === b || state.rights.has(`${a}>${b}`),
      principals: () => store.all("SELECT id FROM entities WHERE authority = 'principal' ORDER BY id").map((r) => r.id),
      nameMatcher: () => ({
        version: 1,
        scan: (text) => {
          const out = [];
          for (const n of store.all('SELECT entity_id, text_raw FROM entity_names')) {
            const i = String(text ?? '').indexOf(n.text_raw);
            if (i >= 0) out.push({ entityId: n.entity_id, name: n.text_raw, start: i, end: i + n.text_raw.length, score: 1 });
          }
          return out;
        },
      }),
      candidates: async () => [],
      noteMention: (c, id, m) => { rec('noteMention', { id, ...m }); },
      resolveExtracted: (c, ents, ctx) => {
        rec('resolveExtracted', { ents, ctx });
        const map = new Map();
        const selfId = fakes.entities.ensureSelf(core);
        for (const e of ents) {
          if (e.verdict?.match) { map.set(e.local, e.verdict.match); continue; }
          // 契约：带 speaker 的行就是那个说话人（入库时没认出来的，用本批里给他立的档）
          if (e.speaker && (ctx.speakers?.get(e.speaker) || map.get(e.speaker))) { map.set(e.local, ctx.speakers.get(e.speaker) ?? map.get(e.speaker)); continue; }
          const sp = ctx.speakers?.get(e.local);
          if (sp) { map.set(e.local, sp); continue; }
          const id = insertRow(core, 'entities', { kind: e.kind ?? 'person', status: 'provisional', display_name: e.name ?? null, created_at: core.now(), updated_at: core.now() });
          if (e.name) insertRow(core, 'entity_names', { entity_id: id, text_raw: e.name, text_norm: normalizeToken(e.name), first: ctx.at, last: ctx.at });
          if (e.descriptor) {
            const a = e.descriptor.anchor;
            const anchor = a === '我' ? selfId : (ctx.speakers?.get(a) ?? map.get(a) ?? null);
            if (anchor) insertRow(core, 'entity_descriptors', { entity_id: id, anchor_entity_id: anchor, relation: e.descriptor.relation, text: e.descriptor.relation, created_at: core.now(), first_at: ctx.at, last_at: ctx.at });
          }
          map.set(e.local, id);
        }
        return map;
      },
    },
    discretion: {
      SECRECY_REQUEST_REASON: 'secrecy-request',
      writeNorm: (c, ref, norm) => {
        if (state.failWriteNorm) throw Object.assign(new Error('injected crash'), { code: 'INJECTED' });
        const k = rs(ref);
        const v = (norms.get(k)?.version ?? 0) + 1;
        norms.set(k, { ...norm, version: v });
        rec('writeNorm', { ref: k, norm });
        return v;
      },
      normOf: (c, ref) => {
        const n = norms.get(rs(ref));
        if (!n) return { unassessed: true, version: 0, restriction: 'none', allow: null, deny: null, originExposure: { exposureRank: 0, persistenceRank: 1 } };
        return { unassessed: false, allow: null, deny: null, ...n };
      },
      recordKnowledge: (c, ref, entries) => { rec('recordKnowledge', { ref: rs(ref), entries }); },
      tightenNorm: (c, ref, t) => {
        const k = rs(ref);
        rec('tightenNorm', { ref: k, t });
        const n = norms.get(k) ?? { restriction: 'none', version: 0 };
        const rank = { none: 0, soft: 1, strict: 2 };
        norms.set(k, { ...n, restriction: rank[t.restriction] > rank[n.restriction ?? 'none'] ? t.restriction : n.restriction, version: (n.version ?? 0) + 1 });
      },
      inheritNorm: (c, ref, evidence, ctx) => {
        rec('inheritNorm', { ref: rs(ref), evidence: evidence.map(rs), ctx });
        norms.set(rs(ref), { restriction: 'none', version: 1, derived: true });
      },
      applyNormUpdate: (c, update, ctx) => {
        rec('applyNormUpdate', { update, ctx });
        return { applied: update.direction === 'tighten', queued: false };
      },
      writeSettingRule: (c, settingKey, rule, ctx) => {
        rec('writeSettingRule', { settingKey, rule, ctx });
        const v = (store.get('SELECT MAX(version) AS v FROM setting_rules WHERE setting_key = ?', settingKey)?.v ?? 0) + 1;
        const relax = rule.restriction === 'none';
        const status = relax && ctx.authority === 'none' ? 'rejected' : 'active';
        insertRow(core, 'setting_rules', { setting_key: settingKey, version: v, rule_json: JSON.stringify(rule), source: ctx.source, author_entity_id: ctx.authorEntityId,
          authority: ctx.authority, stricter: relax ? 0 : 1, status, at: ctx.at });
        return { version: v, status };
      },
      settingRules: (c, settingKey) => {
        const rows = store.all("SELECT version, rule_json, author_entity_id, authority FROM setting_rules WHERE setting_key = ? AND status = 'active' ORDER BY version", settingKey);
        return { version: rows.at(-1)?.version ?? 0, rules: rows.map((r) => ({ ...JSON.parse(r.rule_json), author: r.author_entity_id, authority: r.authority })) };
      },
    },
    dynamics: {
      encodingWeight: (c, f) => (f.wAtt ?? 1) * (f.selfRelevance ?? 1) * 2 ** (((f.imp ?? 5) - 5) / 2.5) * (0.8 + 0.7 * (f.closeness ?? 0)) * (1 + 0.5 * (f.emotionIntensity ?? 0)),
      addTrace: (c, ref, tr) => { rec('addTrace', { ref: rs(ref), ...tr }); return { added: true }; },
      inheritActivation: (c, from, to, ctx) => { rec('inheritActivation', { from: rs(from), to: rs(to), ctx }); },
      pushMood: (c, m) => { rec('pushMood', m); },
    },
    worker: {
      activeSpaceId: () => store.get("SELECT space_id FROM vector_spaces WHERE status = 'active'")?.space_id ?? null,
      enqueueEmbed: (c, ref, chunks, opt) => { embeds.set(rs(ref), chunks); rec('enqueueEmbed', { ref: rs(ref), chunks, opt }); },
      embedQuery: async (c, texts) => {
        if (state.embedDown || !p.embedding) return null;
        const r = await p.embedding.embed(texts, 'query');
        return { spaceId: r.spaceId, vectors: r.vectors };
      },
      storedVectors: async (c, refs) => {
        const out = new Map();
        if (state.embedDown) return out;
        for (const r of refs) { const ch = embeds.get(r)?.[0]; if (ch) out.set(r, raw.embedding.vector(ch.text)); }
        return out;
      },
      lexicalSearch: async (c, q) => {
        const hits = [];
        for (const t of q.tables) {
          const prefix = t === 'assertions_fts' ? 'a' : t === 'episodes_fts' ? 'e' : 'p';
          for (const h of ftsSearch(store, t, q.terms, { limit: q.limit })) hits.push({ ref: `${prefix}${h.rowid}`, score: -h.score });
        }
        return { hits: hits.sort((a, b) => b.score - a.score).slice(0, q.limit), timedOut: false };
      },
      denseSearch: async (c, q) => {
        if (state.embedDown) return { hits: [], timedOut: false };
        const hits = [];
        for (const [id, text] of windows) {
          const v = raw.embedding.vector(text);
          let s = -1;
          for (const qv of q.vectors) { let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * qv[i]; s = Math.max(s, d); }
          hits.push({ ref: `w${id}`, score: s });
        }
        return { hits: hits.sort((a, b) => b.score - a.score).slice(0, q.topK?.raw ?? 20), timedOut: false };
      },
      termStats: async () => new Map(),
    },
    intake: {
      assignEpisode: (c, ids, epId) => {
        rec('assignEpisode', { ids, epId });
        for (const id of ids) store.run('UPDATE percepts SET episode_id = ? WHERE id = ?', epId, id);
      },
      markAssessed: (c, ids) => {
        rec('markAssessed', { ids });
        for (const id of ids) store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", id);
      },
      sanitizeForPrompt: (c, text) => String(text ?? ''),
    },
    retrieve: {
      backgroundForExtraction: async () => (typeof state.background === 'function' ? state.background() : state.background),
    },
    admin: {
      enqueueReview: (c, item) => { rec('enqueueReview', item); return calls.enqueueReview.length; },
      notifyNeedToKnow: (c, item) => { rec('notifyNeedToKnow', item); return calls.notifyNeedToKnow.length; },
      suppress: (c, ref, s) => { rec('suppress', { ref, ...s }); },
      // 契约：新写出来的派生内容继承隐藏，返回带来隐藏的那条引用（没有是 null）；state.hiddenPercepts 里的感知算主人隐藏过的
      inheritSuppression: (c, ref, ctx) => {
        if (state.failInherit) throw Object.assign(new Error('injected'), { code: 'INJECTED' });
        const m = parseRef(ref);
        const pids = m ? store.all('SELECT percept_id AS p FROM sources WHERE owner_kind = ? AND owner_id = ? AND percept_id IS NOT NULL', m.kind, m.id).map((r) => r.p) : [];
        const src = pids.find((p) => state.hiddenPercepts.has(p));
        rec('inheritSuppression', { ref, ctx, inTx: store.inTransaction, from: src ? `p${src}` : null });
        return src ? `p${src}` : null;
      },
    },
  };
  const all = Object.fromEntries(MODULE_NAMES.map((n) => [n, n === 'encode'
    ? Object.freeze({ ...encode, ...(mods.encode ?? {}) })
    : stubModule(n, { ...(fakes[n] ?? {}), ...(mods[n] ?? {}) })]));
  core.mods = Object.freeze(all);
  encode.init(core);

  const self = fakes.entities.ensureSelf(core);
  const world = {
    core, ports: raw, llm: raw.llm, clock: raw.clock, budget: raw.budget, embedding: raw.embedding, logger: raw.logger,
    calls, norms, embeds, windows, state, self, dir,
    async cleanup() {
      try { encode.dispose(core); } catch { /* 尽力 */ }
      try { vec?.close(); } catch { /* 尽力 */ }
      try { store.close(); } catch { /* 尽力 */ }
      rmDir(dir);
    },
    callsOf: (name) => calls[name] ?? [],
    clear() { for (const k of Object.keys(calls)) delete calls[k]; },

    // ── 测试数据 ─────────────────────────────────────────────────────────
    /** 一个人（或别的实体）。 */
    entity(name, { kind = 'person', closeness = 0, authority = 'none', identity = true, status = 'established' } = {}) {
      const id = insertRow(core, 'entities', { kind, status, display_name: name, closeness, authority, created_at: core.now(), updated_at: core.now() });
      if (name) insertRow(core, 'entity_names', { entity_id: id, text_raw: name, text_norm: normalizeToken(name), first: core.now(), last: core.now() });
      if (identity) insertRow(core, 'identity_evidence', { entity_id: id, namespace: ADAPTER, scope: '', id_hash: core.keys.identityHash(ADAPTER, '', `acct-${id}`), strength: 'platform', created_at: core.now() });
      return id;
    },
    descriptor(entityId, anchorId, relation) {
      return insertRow(core, 'entity_descriptors', { entity_id: entityId, anchor_entity_id: anchorId, relation, text: relation, created_at: core.now(), first_at: core.now(), last_at: core.now() });
    },
    /** 一个场合（加一份快照）。exposure：0 一对一 … 3 任何人可见。 */
    setting(name, { exposure = 2, size = 30, label = name, persistence = 1, stability = 'persistent' } = {}) {
      const key = core.keys.settingKey(ADAPTER, name);
      const oneOnOne = exposure === 0;
      const descriptor = {
        label, stability,
        audience: { size: oneOnOne ? 2 : size, entry: exposure >= 3 ? 'open' : 'closed', unknownObservers: exposure >= 3 },
        disclosure: { visibleTo: oneOnOne ? 'participants' : exposure >= 3 ? 'anyone' : 'members', persistence: 'logged' },
        ownership: {},
      };
      insertRow(core, 'settings', { key, adapter: ADAPTER, label, stability, first_seen: core.now(), last_seen: core.now() });
      const snap = insertRow(core, 'setting_snapshots', { setting_key: key, at: core.now(), descriptor_json: JSON.stringify(descriptor), descriptor_hash: `h-${name}`,
        reach_hash: `r-${name}`, exposure_rank: exposure, persistence_rank: persistence, audience_size: oneOnOne ? 2 : size });
      store.run('UPDATE settings SET current_snapshot_id = ? WHERE key = ?', snap, key);
      return { key, snapshotId: snap, name };
    },
    /**
     * 一条感知（像 intake 入库那样：FTS 同时写好）。by：实体 id 或 'self'。
     * @returns {number}
     */
    percept(s, by, text, opt = {}) {
      const at = opt.at ?? core.now();
      const isSelf = by === 'self';
      const kind = opt.kind ?? (isSelf ? 'self-utterance' : 'utterance');
      const addressed = opt.addressed ?? (isSelf ? 'by-her' : 'ambient');
      const attention = opt.attention ?? (addressed === 'ambient' ? 'peripheral' : 'attended');
      const cls = opt.attentionClass ?? (isSelf ? 'self' : addressed === 'to-her' ? 'toHer' : addressed === 'mentions-her' ? 'mentionsHer' : attention === 'peripheral' ? 'peripheral' : 'attendedAmbient');
      const obsId = opt.obsId ?? `obs-${++state.ids}`;
      const actor = isSelf ? { kind: 'self' } : { claims: [{ kind: 'display-name', name: opt.displayName ?? (store.get('SELECT display_name FROM entities WHERE id = ?', by)?.display_name ?? '某人') }] };
      const id = insertRow(core, 'percepts', {
        adapter: ADAPTER, ext_key: core.keys.obsKey(ADAPTER, obsId), setting_key: s.key, snapshot_id: s.snapshotId, perceived_in: opt.perceivedIn ?? s.key,
        presence_set_id: opt.presenceSetId ?? null, visible_to: opt.visibleTo ?? 'setting-audience', at, perceived_at: at,
        actor_entity_id: isSelf ? self : (by ?? null), actor_self: isSelf ? 1 : 0, actor_json: JSON.stringify(actor), kind, text,
        text_state: opt.textState ?? 'normal', text_hash: crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16),
        quote_json: opt.quote ? JSON.stringify({ excerpt: opt.quote }) : null, addressed, attention, attention_class: cls,
        evidential: opt.evidential === false ? 0 : 1, forwarded_json: opt.forwarded ? JSON.stringify({ from: 'x' }) : null,
        w_enc: 1, standing: opt.standing ?? 'first-hand', historical: opt.historical ? 1 : 0, relay_of: opt.relayOf ?? null, created_at: at,
      });
      const shard = ensurePerceptShard(store, at);
      ftsInsert(store, shard, id, fakes.lang.indexTokens(core, text, { entityIds: isSelf ? [self] : by ? [by] : [] }));
      store.run('UPDATE percepts SET fts_shard = ? WHERE id = ?', shard, id);
      return id;
    },
    /** 一个原文窗口（稠密路替身按它的文本算相似度）。 */
    rawWindow(s, perceptIds) {
      const rows = perceptIds.map((id) => store.get('SELECT * FROM percepts WHERE id = ?', id));
      const text = rows.map((r) => r.text).join(' / ');
      const id = insertRow(core, 'raw_windows', { setting_key: s.key, members_json: JSON.stringify(perceptIds), first_percept: perceptIds[0], last_percept: perceptIds.at(-1),
        n_percepts: perceptIds.length, t_start: rows[0].at, t_end: rows.at(-1).at, text, created_at: core.now() });
      windows.set(id, text);
      return id;
    },
    /** 排好的提炼任务（按优先级）。 */
    jobs(status = 'queued') {
      return store.all('SELECT * FROM jobs WHERE kind = ? AND status = ? ORDER BY priority DESC, id', encode.EXTRACT_JOB_KIND, status);
    },
    /** 取下一个提炼任务并跑完（runJobs 的最小版）。 */
    async runNext() {
      const job = claimNextJob(store, { kinds: [encode.EXTRACT_JOB_KIND] });
      if (!job) return null;
      return { job, out: await encode.runExtract(core, job) };
    },
    /** 封口这个场合的缓冲并跑完所有提炼任务。 */
    async extractAll(s) {
      encode.segment(core, { settingKey: s.key, force: true });
      const outs = [];
      for (let i = 0; i < 20; i++) {
        const r = await world.runNext();
        if (!r) break;
        outs.push(r.out);
      }
      return outs;
    },
    assertion(id) { return store.get('SELECT * FROM assertions WHERE id = ?', id); },
    assertions(where = '1=1', ...args) { return store.all(`SELECT * FROM assertions WHERE ${where} ORDER BY id`, ...args); },
    episodes() { return store.all('SELECT * FROM episodes ORDER BY id'); },
    intentions() { return store.all('SELECT * FROM intentions ORDER BY id'); },
    sources(kind, id) { return store.all('SELECT * FROM sources WHERE owner_kind = ? AND owner_id = ? ORDER BY id', kind, id); },
    parseRef,
  };
  return world;
}

/** 提示词里某个显示名对应的编号：[U2 阿明]、[c1] 小刚（…）、[k1] …（文本以 label 开头）。 */
export function codeIn(req, label) {
  const text = req.messages.map((m) => m.content).join('\n');
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`\\[(U\\d+) ${esc}\\]`)) ?? text.match(new RegExp(`\\[([ckp]\\d+)\\] ${esc}`));
  if (!m) throw new Error(`提示词里没有「${label}」`);
  return m[1];
}
/** 提示词里某条消息的编号（按原文找）。 */
export function msgIn(req, text) {
  const all = req.messages.map((m) => m.content).join('\n');
  for (const line of all.split('\n')) {
    const m = line.match(/^\[(m\d+)\]/);
    if (m && line.includes(text)) return m[1];
  }
  throw new Error(`提示词里没有消息「${text}」`);
}
