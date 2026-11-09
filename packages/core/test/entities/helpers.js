// entities 测试的公共部分：一个只初始化 entities 的 CoreContext，依赖的模块全换成按契约写的小替身（不依赖别的模块的实现）。
//   dynamics：addTrace（记下来，返回 {added:true}）、baseActivation / baseActivations（按记下的痕迹数给个数）
//   discretion：writeNorm / recordKnowledge / inheritNorm（记下来）
//   worker：enqueueEmbed（记下文本）、dropEmbeddings、embedQuery（FakeEmbedding）、denseSearch（在记下的文本上算余弦）
//   admin：suppressedRefs、enqueueReview（记下来，同样的还在等着就不重复）、withdrawReviews（撤掉匹配的）；intake：snapshotById（测试里登记的快照）；
//   lang：registry().setUserDictionary
import { createTestCore, FakeEmbedding, cosine } from '../fakes/index.js';
import { refOf } from '../../src/store/index.js';

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 9, 26, 4, 0, 0);   // 一个周一（UTC 中午，东八区）

/**
 * @param {{name?: string, config?: object, embedding?: FakeEmbedding|null, mods?: object, ports?: object}} [opt]
 */
export async function entitiesCore({ name = 'entities', config, embedding = new FakeEmbedding(), mods = {}, ports } = {}) {
  const rec = {
    traces: [], norms: [], knowledge: [], inherits: [], embeds: new Map(), drops: [], dictionaries: [],
    suppressed: new Set(), snapshots: new Map(), embedQueries: 0, denseSearches: 0, reviews: [], activationBatches: 0, withdrawn: [],
  };
  const base = {
    dynamics: {
      addTrace: (core, ref, tr) => { rec.traces.push({ ref: refOf(ref.kind, ref.id), ...tr }); return { added: true }; },
      baseActivation: (core, ref) => {
        const n = rec.traces.filter((t) => t.ref === refOf(ref.kind, ref.id)).length;
        return n ? Math.log(n) : -Infinity;
      },
      // 和真的一样：一批单元一次读（键是记忆引用）；记下调用次数（名字匹配器一次扫描只读一次）
      baseActivations: (core, refs) => {
        rec.activationBatches += 1;
        return new Map(refs.map((r) => {
          const n = rec.traces.filter((t) => t.ref === refOf(r.kind, r.id)).length;
          return [refOf(r.kind, r.id), n ? Math.log(n) : -Infinity];
        }));
      },
    },
    discretion: {
      // 和真的一样：写（或整体替换）flow_norms 的一行，version + 1
      writeNorm: (core, ref, norm) => {
        rec.norms.push({ ref: refOf(ref.kind, ref.id), norm });
        const v = (core.store.get('SELECT version FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', ref.kind, ref.id)?.version ?? 0) + 1;
        core.store.run('DELETE FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', ref.kind, ref.id);
        insertRow(core, 'flow_norms', { owner_kind: ref.kind, owner_id: ref.id, version: v, identity_link: norm.identityLink ? 1 : 0, updated_at: core.now() });
        return v;
      },
      recordKnowledge: (core, ref, entries) => { rec.knowledge.push({ ref: refOf(ref.kind, ref.id), entries }); },
      inheritNorm: (core, ref, evidence, ctx) => { rec.inherits.push({ ref: refOf(ref.kind, ref.id), evidence: evidence.map((e) => refOf(e.kind, e.id)), ctx }); },
    },
    worker: {
      enqueueEmbed: (core, ref, chunks, opt) => { rec.embeds.set(refOf(ref.kind, ref.id), { chunks, opt }); },
      dropEmbeddings: (core, refs) => { for (const r of refs) { rec.drops.push(refOf(r.kind, r.id)); rec.embeds.delete(refOf(r.kind, r.id)); } return { texts: refs.length, vectors: refs.length }; },
      embedQuery: async (core, texts) => {
        if (!embedding) return null;
        rec.embedQueries += 1;
        try { return await embedding.embed(texts, 'query'); } catch { return null; }
      },
      denseSearch: async (core, q) => {
        rec.denseSearches += 1;
        const hits = [];
        for (const [ref, { chunks }] of rec.embeds) {
          let best = -1;
          for (const c of chunks) for (const v of q.vectors) best = Math.max(best, cosine(v, embedding.vector(c.text)));
          hits.push({ ref, score: best });
        }
        hits.sort((a, b) => b.score - a.score);
        return { hits: hits.slice(0, q.topK.memory), timedOut: false };
      },
    },
    admin: {
      suppressedRefs: (core, refs) => new Set(refs.filter((r) => rec.suppressed.has(r))),
      // 和真的一样：同样的 kind + payload 还在等着的不重复排
      enqueueReview: (core, item) => {
        const key = `${item.kind}:${JSON.stringify(item.payload)}`;
        const i = rec.reviews.findIndex((r) => r.key === key);
        if (i >= 0) return i + 1;
        rec.reviews.push({ key, ...item });
        return rec.reviews.length;
      },
      // 和真的一样：撤掉还在等着的、payload 含 match 里全部字段的审核（记下来；撤掉的从 reviews 里拿掉）
      withdrawReviews: (core, q, ctx) => {
        const hit = rec.reviews.filter((r) => r.kind === q.kind && Object.entries(q.match).every(([k, v]) => r.payload?.[k] === v));
        rec.withdrawn.push({ q, ctx, n: hit.length });
        for (const h of hit) rec.reviews.splice(rec.reviews.indexOf(h), 1);
        return hit.length;
      },
    },
    intake: { snapshotById: (core, id) => rec.snapshots.get(id) ?? null },
    lang: { registry: () => ({ setUserDictionary: (words) => { rec.dictionaries.push(words); } }) },
  };
  const merged = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(mods)])) merged[k] = { ...(base[k] ?? {}), ...(mods[k] ?? {}) };
  const t = await createTestCore({ name, config, mods: merged, init: false, ports });
  t.core.mods.entities.init(t.core);
  return { ...t, rec, embedding };
}

/** 往别的模块的表里塞一行测试数据（只用于搭场景）。没给的 NOT NULL 列按类型补个占位值，别的模块改了表结构也不至于插不进去。 */
export function insertRow(core, table, values) {
  const cols = core.store.all(`PRAGMA table_info("${table}")`);
  const row = { ...values };
  for (const c of cols) {
    if (c.name in row) continue;
    if (c.notnull && c.dflt_value == null && !c.pk) row[c.name] = /INT|REAL/i.test(c.type) ? 0 : '';
  }
  const keys = Object.keys(row).filter((k) => cols.some((c) => c.name === k));
  const r = core.store.run(`INSERT INTO "${table}"(${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => (row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k])));
  return Number(r.lastInsertRowid);
}

let seq = 0;
/** 一条感知（给 msgRefs 用：谁说的、什么时候、编码强度）。 */
export function percept(core, { settingKey = 'S', actor, at, wEnc = 1, visibleTo = 'setting-audience', snapshotId = null, text = '…' }) {
  seq += 1;
  return insertRow(core, 'percepts', {
    adapter: 'zz', ext_key: `k${seq}-${Math.random()}`, setting_key: settingKey, snapshot_id: snapshotId, perceived_in: settingKey,
    visible_to: visibleTo, at, perceived_at: at, actor_entity_id: actor ?? null, actor_json: '{}', kind: 'utterance', text,
    text_hash: `h${seq}`, addressed: 'ambient', attention: 'attended', attention_class: 'attendedAmbient', evidential: 1,
    w_enc: wEnc, standing: 'first-hand', created_at: at,
  });
}

/** 一个账号 ActorRef（账号 id 是测试里现编的随机串，不是任何真实账号）。 */
export function acct(ns, id, extra = {}) {
  return { claims: [{ kind: 'account', namespace: ns, id, verifiedBy: 'platform', ...extra }] };
}

/** 直接建一个人（绕过 resolveActor），带一个账号。 */
export function person(core, ns, id, at, name) {
  const actor = acct(ns, id, name ? { displayName: name } : {});
  return core.mods.entities.resolveActor(core, actor, { adapterId: ns, settingKey: 'S', at }).entityId;
}

/** 造一条事实（encode 的表，只用于搭场景）：主体、说话人、断言者、来源方式、来源感知。 */
export function fact(core, { subject, speaker, asserter = speaker, mode = 'told_to_her', perceptId = null, at = T0, text = '某事', superseded = null }) {
  const id = insertRow(core, 'assertions', {
    predicate: 'note', text, kind_hint: 'fact', certainty: asserter === subject ? 'stated' : 'hearsay', confidence: 0.6, imp: 5,
    recorded_at: at, created_at: at, updated_at: at, superseded_by: superseded,
  });
  insertRow(core, 'assertion_entities', { assertion_id: id, entity_id: subject, role: 'subject' });
  if (speaker) insertRow(core, 'assertion_entities', { assertion_id: id, entity_id: speaker, role: 'speaker' });
  insertRow(core, 'sources', { owner_kind: 'assertion', owner_id: id, percept_id: perceptId, speaker, asserter, mode, hop: asserter === speaker ? 0 : 1, confidence: 0.6, at });
  return id;
}
