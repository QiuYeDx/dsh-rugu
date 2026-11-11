// admin 测试用的替身和测试数据。别的模块正在并行实现，这里一律用照契约写的小替身（createTestCore({mods})），
// 测试数据直接写表（schema 就是契约，测试只需要行在那里）。
import { createTestCore } from '../fakes/index.js';
import { refOf, parseRef } from '../../src/store/refs.js';
import { ensurePerceptShard } from '../../src/store/fts.js';

/** 测试里的 queryTerms 替身：和 lang 的契约一致（规范化、去重），中文切二元组。 */
export function terms(text) {
  const out = [];
  for (const m of String(text).normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu)) {
    const w = m[0];
    if (/\p{Script=Han}/u.test(w) && w.length > 1) for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2));
    else out.push(w);
  }
  return [...new Set(out)];
}

/**
 * 依赖模块的替身（照 docs/实现/模块与接口.md 附录 A 的契约）。calls 记下每次调用（按顺序），断言调用顺序和参数用。
 * @param {object} [extra]  按模块覆盖
 */
export function fakeMods(extra = {}) {
  const calls = [];
  const rec = (name, args) => calls.push({ name, args });
  const base = {
    lang: { queryTerms: (core, text) => terms(text) },
    intake: {
      settingByKey: (core, key) => {
        const r = core.store.get(`SELECT s.*, ss.descriptor_json, ss.exposure_rank, ss.persistence_rank, ss.reach_hash FROM settings s
                                  LEFT JOIN setting_snapshots ss ON ss.id = s.current_snapshot_id WHERE s.key = ?`, key);
        if (!r) return null;
        return { key: r.key, adapter: r.adapter, label: r.label ?? '', stability: r.stability, parentKey: r.parent_key ?? null, entityId: r.entity_id ?? null,
          snapshotId: r.current_snapshot_id ?? null, descriptor: r.descriptor_json ? JSON.parse(r.descriptor_json) : null,
          exposureRank: r.exposure_rank ?? 0, persistenceRank: r.persistence_rank ?? 0, reachHash: r.reach_hash ?? '' };
      },
      resolveSetting: (core, settingId) => {
        const r = core.store.get('SELECT key, adapter FROM settings WHERE label = ?', `sid:${settingId}`);
        return r ? { key: r.key, adapter: r.adapter } : null;
      },
      // 原文到期（契约：分批把 text 置 NULL、text_state='expired'，删 FTS 行；先让 worker 删窗口的嵌入）
      expireRawText: (core, o) => {
        rec('intake.expireRawText', [o]);
        const limit = o.limit ?? 500;
        const wins = core.store.all('SELECT id FROM raw_windows WHERE text IS NOT NULL AND t_start < ? ORDER BY t_start LIMIT ?', o.before, limit);
        const ps = core.store.all('SELECT id FROM percepts WHERE text IS NOT NULL AND at < ? ORDER BY at LIMIT ?', o.before, limit);
        core.store.tx(() => {
          for (const w of wins) core.store.run('UPDATE raw_windows SET text = NULL WHERE id = ?', w.id);
          for (const p of ps) core.store.run("UPDATE percepts SET text = NULL, text_state = 'expired' WHERE id = ?", p.id);
        });
        const left = core.store.get('SELECT count(*) AS n FROM percepts WHERE text IS NOT NULL AND at < ?', o.before).n
          + core.store.get('SELECT count(*) AS n FROM raw_windows WHERE text IS NOT NULL AND t_start < ?', o.before).n;
        return { percepts: ps.length, windows: wins.length, done: left === 0 };
      },
      // 彻底删除的级联（契约：把这些感知从窗口成员里拿掉、重新渲染；一条不剩的整个删掉；先让 worker 删这些窗口的向量）
      dropFromWindows: (core, perceptIds) => {
        rec('intake.dropFromWindows', [[...perceptIds]]);
        const gone = new Set(perceptIds);
        const out = { rebuilt: 0, deleted: 0 };
        return core.store.tx(() => {
          for (const w of core.store.all('SELECT id, members_json FROM raw_windows ORDER BY id')) {
            const members = JSON.parse(w.members_json);
            if (!members.some((id) => gone.has(id))) continue;
            core.mods.worker.dropEmbeddings(core, [{ kind: 'window', id: w.id }]);
            const keep = members.filter((id) => !gone.has(id));
            if (!keep.length) {
              core.store.run('DELETE FROM raw_windows WHERE id = ?', w.id);
              core.store.run('UPDATE percepts SET window_id = NULL WHERE window_id = ? AND id NOT IN (SELECT value FROM json_each(?))', w.id, JSON.stringify([...gone]));
              out.deleted += 1;
              continue;
            }
            const text = core.store.all('SELECT text FROM percepts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', JSON.stringify(keep)).map((r) => r.text).join(' / ');
            core.store.run('UPDATE raw_windows SET members_json = ?, first_percept = ?, last_percept = ?, n_percepts = ?, text = ? WHERE id = ?',
              JSON.stringify(keep), keep[0], keep.at(-1), keep.length, text, w.id);
            out.rebuilt += 1;
          }
          return out;
        });
      },
    },
    // 常驻区标脏（契约：只标脏，不换文本）
    context: { markResidentDirty: (core, settingKey) => { rec('context.markResidentDirty', [settingKey ?? null]); } },
    entities: {
      principals: (core) => core.store.all("SELECT id FROM entities WHERE authority = 'principal' AND is_self = 0 ORDER BY closeness DESC, id").map((r) => r.id),
      link: (core, a, b, l) => { rec('entities.link', [a, b, l]); return 1; },
      // 认人：认得出名字就返回；认不出就建一个临时档案（模拟器应该在回滚的事务里调它）
      resolveActor: (core, actor, ctx) => {
        const name = actor?.name ?? null;
        const hit = name ? core.store.get('SELECT entity_id AS id FROM entity_names WHERE text_raw = ?', name) : null;
        if (hit) return { entityId: hit.id, isSelf: false, isPrincipal: false, via: 'scoped-name' };
        const id = Number(core.store.run("INSERT INTO entities(kind, status, created_at, updated_at) VALUES ('person', 'provisional', ?, ?)", ctx.at, ctx.at).lastInsertRowid);
        return { entityId: id, isSelf: false, isPrincipal: false, via: 'none' };
      },
      invalidateNames: () => { rec('entities.invalidateNames', []); },
    },
    worker: {
      // 先删向量再删主库：替身在被调用时记下这些记忆的主表行还在不在（应该都还在）
      dropEmbeddings: (core, refs) => {
        const still = refs.map((r) => {
          const m = typeof r === 'string' ? parseRef(r) : r;
          const t = { percept: 'percepts', window: 'raw_windows', episode: 'episodes', assertion: 'assertions', entity: 'entities', impression: 'entity_impressions',
            intention: 'intentions', storyline: 'storylines', community: 'communities', link: 'entity_links' }[m.kind];
          return !!core.store.get(`SELECT 1 FROM ${t} WHERE id = ?`, m.id);
        });
        rec('worker.dropEmbeddings', [refs.map((r) => (typeof r === 'string' ? r : refOf(r.kind, r.id))), still]);
        let texts = 0;
        for (const r of refs) {
          const m = typeof r === 'string' ? parseRef(r) : r;
          texts += Number(core.store.run('DELETE FROM embed_texts WHERE owner_kind = ? AND owner_id = ?', m.kind, m.id).changes);
        }
        return { texts, vectors: texts };
      },
      sweepVectors: () => ({ removed: 0, requeued: 0 }),
    },
    encode: {
      // 契约：以这条感知为来源的记忆（读 sources.percept_id），onlySource = 只靠它作证据
      derivedFrom: (core, perceptId) => core.store.all(`SELECT s.owner_kind AS k, s.owner_id AS id,
          (SELECT count(*) FROM sources s2 WHERE s2.owner_kind = s.owner_kind AND s2.owner_id = s.owner_id AND (s2.percept_id IS NULL OR s2.percept_id <> ?)) AS others
          FROM sources s WHERE s.percept_id = ? GROUP BY s.owner_kind, s.owner_id`, perceptId, perceptId)
        .map((r) => ({ ref: refOf(r.k, r.id), onlySource: Number(r.others) === 0 })),
      applyToolOp: async (core, payload, ctx) => { rec('encode.applyToolOp', [payload, ctx]); return { status: 'done', refs: [] }; },
    },
    backup: {
      preOperationSnapshot: async (core, info) => { rec('backup.preOperationSnapshot', [info]); return `${core.dataDir}/backup/pre-op/fake.pmpack`; },
      createPack: async (core, opt) => { rec('backup.createPack', [opt]); return [{ id: 1, path: 'x', kind: opt.kind, location: 'local', verified: true }]; },
      scrubPacks: async (core, opt) => { rec('backup.scrubPacks', [opt]); return { rewritten: 0, failed: 0, skipped: 0 }; },
    },
    discretion: {
      holdDecision: async (core, token, approve) => { rec('discretion.holdDecision', [token, approve]); },
      applyNormUpdate: (core, update, ctx) => { rec('discretion.applyNormUpdate', [update, ctx]); return { applied: true, queued: false }; },
      writeSettingRule: (core, key, rule, ctx) => { rec('discretion.writeSettingRule', [key, rule, ctx]); return { version: 2, status: 'active' }; },
      // 契约：批准 → 那一版标成被取代（另写一版主人认可的）；驳回 → 那一版标 rejected；不在等审核 → 'not-pending'
      decideSettingRule: (core, key, version, approve, ctx) => {
        rec('discretion.decideSettingRule', [key, version, approve, ctx]);
        const r = core.store.get('SELECT status, superseded_at FROM setting_rules WHERE setting_key = ? AND version = ?', key, version);
        if (!r || r.status !== 'pending' || r.superseded_at != null) return { version: null, status: 'not-pending' };
        if (!approve) { core.store.run("UPDATE setting_rules SET status = 'rejected' WHERE setting_key = ? AND version = ?", key, version); return { version, status: 'rejected' }; }
        core.store.run('UPDATE setting_rules SET superseded_at = ? WHERE setting_key = ? AND version = ?', ctx?.at ?? core.now(), key, version);
        return { version: version + 1, status: 'active' };
      },
      normOf: (core, ref) => ({ unassessed: false, restriction: 'none', version: 1 }),
    },
    consolidate: {
      applyGrowth: (core, change, ctx) => { rec('consolidate.applyGrowth', [change, ctx]); return { version: 3, queued: false }; },
      regenerateImpressions: async (core, id) => { rec('consolidate.regenerateImpressions', [id]); },
    },
  };
  const mods = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(extra)])) mods[k] = { ...(base[k] ?? {}), ...(extra[k] ?? {}) };
  return { mods, calls, of: (name) => calls.filter((c) => c.name === name) };
}

/** createTestCore + 替身。返回 {core, calls, of, cleanup, ports}。 */
export async function adminCore(name, { mods = {}, config = {} } = {}) {
  const f = fakeMods(mods);
  const t = await createTestCore({ name, mods: f.mods, config });
  return { ...t, calls: f.calls, of: f.of };
}

// ── 测试数据 ──────────────────────────────────────────────────────────────

let seq = 0;
const DESC = {
  id: 'opaque', label: '小群', stability: 'persistent',
  audience: { size: 6, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
  disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
  ownership: { owner: 'unknown', herRole: 'member', herModerates: false, actsOnBehalfOfPrincipal: false },
  capabilities: { preSendGate: true, canHold: false }, attending: true,
};
export const descriptors = {
  group: DESC,
  oneOnOne: { ...DESC, audience: { ...DESC.audience, size: 2 }, disclosure: { ...DESC.disclosure, visibleTo: 'participants' } },
  public: { ...DESC, audience: { size: 'unbounded', entry: 'open', unknownObservers: true, membersKnown: 'unknown' },
    disclosure: { visibleTo: 'anyone', persistence: 'public-permanent', searchable: true, attributedToHer: true } },
};

export function seedSetting(core, { key = `sk-${++seq}`, label = '小群', descriptor = DESC, settingId = null } = {}) {
  const at = core.now();
  const snap = Number(core.store.run(`INSERT INTO setting_snapshots(setting_key, at, descriptor_json, descriptor_hash, reach_hash, exposure_rank, persistence_rank)
                                      VALUES (?, ?, ?, ?, 'r', 1, 1)`, key, at, JSON.stringify(descriptor), `h${seq}`).lastInsertRowid);
  core.store.run('INSERT INTO settings(key, adapter, label, stability, current_snapshot_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    key, 'zz', settingId ? `sid:${settingId}` : label, 'persistent', snap, at, at);
  return key;
}
export function setDescriptor(core, key, descriptor) {
  const snap = Number(core.store.run(`INSERT INTO setting_snapshots(setting_key, at, descriptor_json, descriptor_hash, reach_hash, exposure_rank, persistence_rank)
                                      VALUES (?, ?, ?, ?, 'r', 3, 2)`, key, core.now(), JSON.stringify(descriptor), `h${++seq}`).lastInsertRowid);
  core.store.run('UPDATE settings SET current_snapshot_id = ? WHERE key = ?', snap, key);
}

export function seedEntity(core, { name = '阿明', authority = 'none', closeness = 0.3, isSelf = 0, at = core.now() } = {}) {
  const id = Number(core.store.run(`INSERT INTO entities(kind, status, display_name, is_self, closeness, authority, created_at, updated_at)
                                    VALUES ('person', 'established', ?, ?, ?, ?, ?, ?)`, name, isSelf, closeness, authority, at, at).lastInsertRowid);
  core.store.run('INSERT INTO entity_names(entity_id, text_raw, text_norm, first, last) VALUES (?, ?, ?, ?, ?)', id, name, name, at, at);
  return id;
}

// 原文分表照真的建法（store.ensurePerceptShard：登记、开 secure-delete）
const shardFor = (core, at) => ensurePerceptShard(core.store, at);

export function seedPercept(core, { settingKey, actor = null, text = '你好', at = core.now(), ext } = {}) {
  const shard = shardFor(core, at);
  const id = Number(core.store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_entity_id, actor_json, kind,
                                     text, text_hash, addressed, attention, attention_class, evidential, standing, fts_shard, created_at)
                                   VALUES ('zz', ?, ?, ?, 'setting-audience', ?, ?, ?, '{}', 'utterance', ?, 'th', 'ambient', 'attended', 'attended', 1, 'first-hand', ?, ?)`,
  ext ?? `x${++seq}`, settingKey, settingKey, at, at, actor, text, shard, Math.max(at, core.now())).lastInsertRowid);
  core.store.run(`INSERT INTO ${shard}(rowid, tokens) VALUES (?, ?)`, id, terms(text).join(' '));
  return id;
}

export function seedWindow(core, { settingKey, perceptIds, text = '窗口原文' }) {
  const ps = core.store.all('SELECT id, at FROM percepts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', JSON.stringify(perceptIds));
  const id = Number(core.store.run(`INSERT INTO raw_windows(setting_key, members_json, first_percept, last_percept, n_percepts, t_start, t_end, text, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, settingKey, JSON.stringify(ps.map((p) => p.id)), ps[0].id, ps.at(-1).id, ps.length, ps[0].at, ps.at(-1).at,
  text, core.now()).lastInsertRowid);
  for (const p of ps) core.store.run('UPDATE percepts SET window_id = ? WHERE id = ?', id, p.id);
  memoryRows(core, 'window', id, { layer: 'raw' });
  return id;
}

/** 记忆单元身上挂的那些行：规范、谁知道、告诉过谁、痕迹、激活、嵌入文本。 */
export function memoryRows(core, kind, id, { layer = 'memory', settingKey = 'sk-x', norm = true } = {}) {
  const at = core.now();
  if (norm) core.store.run('INSERT INTO flow_norms(owner_kind, owner_id, restriction, updated_at) VALUES (?, ?, ?, ?)', kind, id, 'none', at);
  core.store.run("INSERT INTO known_by(owner_kind, owner_id, who_kind, who_ref, since, basis, at) VALUES (?, ?, 'setting', ?, ?, 'setting', ?)", kind, id, settingKey, at, at);
  core.store.run("INSERT INTO traces(owner_kind, owner_id, t, w, d, reason) VALUES (?, ?, ?, 1, 0.5, 'encode')", kind, id, at);
  core.store.run('INSERT INTO activation(owner_kind, owner_id, trace_count, last_trace_at) VALUES (?, ?, 1, ?)', kind, id, at);
  core.store.run("INSERT INTO embed_texts(owner_kind, owner_id, chunk_no, kind, layer, text, hash, created_at, updated_at) VALUES (?, ?, 0, 'text', ?, 't', 'h', ?, ?)",
    kind, id, layer, at, at);
}

export function seedAssertion(core, { text, subjects = [], mentions = [], speaker = null, perceptIds = [], settingKey = 'sk-x', at = core.now(), supersedes = null } = {}) {
  const id = Number(core.store.run(`INSERT INTO assertions(predicate, text, certainty, confidence, recorded_at, valid_from, supersedes, created_at, updated_at)
                                   VALUES ('p', ?, 'stated', 0.8, ?, ?, ?, ?, ?)`, text, at, at, supersedes, Math.max(at, core.now()), core.now()).lastInsertRowid);
  if (supersedes) core.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', id, supersedes);
  for (const e of subjects) core.store.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')", id, e);
  for (const e of mentions) core.store.run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'mention')", id, e);
  const pids = perceptIds.length ? perceptIds : [null];
  for (const pid of pids) {
    core.store.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, speaker, asserter, mode, confidence, at)
                    VALUES ('assertion', ?, ?, ?, ?, ?, 'told_to_her', 0.8, ?)`, id, pid, settingKey, speaker, speaker, at);
  }
  core.store.run('INSERT INTO assertions_fts(rowid, tokens) VALUES (?, ?)', id, terms(text).join(' '));
  memoryRows(core, 'assertion', id, { settingKey });
  return id;
}

/** kind：event（提炼出的经历，感知归进它）/ summary（今天到目前为止）/ diary（日记）——后两种只引用感知作来源，不收感知。 */
export function seedEpisode(core, { settingKey, narrative = '大家在聊天', participants = [], perceptIds = [], at = core.now(), kind = 'event' } = {}) {
  const id = Number(core.store.run(`INSERT INTO episodes(setting_key, ep_kind, narrative, header, t_start, t_end, participants_json, sealed_at, created_at)
                                   VALUES (?, ?, ?, '', ?, ?, ?, ?, ?)`, settingKey, kind, narrative, at, at, JSON.stringify(participants), at, Math.max(at, core.now())).lastInsertRowid);
  for (const pid of perceptIds) {
    core.store.run("INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, mode, confidence, at) VALUES ('episode', ?, ?, ?, 'overheard', 0.5, ?)", id, pid, settingKey, at);
    if (kind === 'event') core.store.run('UPDATE percepts SET episode_id = ? WHERE id = ?', id, pid);
  }
  core.store.run('INSERT INTO episodes_fts(rowid, tokens) VALUES (?, ?)', id, terms(narrative).join(' '));
  memoryRows(core, 'episode', id, { settingKey });
  return id;
}

export function seedImpression(core, { entityId, text = '他挺好的', evidence = [] }) {
  const id = Number(core.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, evidence_ids_json, version, built_at)
                                    VALUES (?, 'shared', ?, ?, 1, ?)`, entityId, text, JSON.stringify(evidence), core.now()).lastInsertRowid);
  memoryRows(core, 'impression', id);
  return id;
}

export function seedIdentity(core, { entityId, hash = `ih${++seq}` }) {
  core.store.run("INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'zz', '', ?, 'platform', ?)", entityId, hash, core.now());
  return hash;
}

export function seedInjection(core, { sessionId = 'sess-1', refs }) {
  core.store.run(`INSERT INTO injections(ts, session_id, cycle, layer, nonce, items_json, chars) VALUES (?, ?, 1, 'recalled', ?, ?, 10)`,
    core.now(), sessionId, `n${++seq}`, JSON.stringify(refs.map((id) => ({ id, appraisalRef: 'ap1' }))));
}

/** 一张表里这条记忆身上还挂着几行（规范、谁知道……），检查级联删干净没有。 */
export function leftovers(core, kind, id) {
  const n = (sql, ...p) => Number(core.store.get(sql, ...p).n);
  return {
    norms: n('SELECT count(*) AS n FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', kind, id),
    knownBy: n('SELECT count(*) AS n FROM known_by WHERE owner_kind = ? AND owner_id = ?', kind, id),
    traces: n('SELECT count(*) AS n FROM traces WHERE owner_kind = ? AND owner_id = ?', kind, id),
    activation: n('SELECT count(*) AS n FROM activation WHERE owner_kind = ? AND owner_id = ?', kind, id),
    embed: n('SELECT count(*) AS n FROM embed_texts WHERE owner_kind = ? AND owner_id = ?', kind, id),
  };
}
export const NONE_LEFT = { norms: 0, knownBy: 0, traces: 0, activation: 0, embed: 0 };
