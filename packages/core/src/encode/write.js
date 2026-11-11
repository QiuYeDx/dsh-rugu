// 写入：情节、事实、来源、取代、「变了未知」、属性键、来源链（§5.3、§5.4、§7.2）。
// 都是同步的，在调用方的事务里调用（自己有多条写入时照样包一层 core.store.tx，嵌套自动变 SAVEPOINT）。
// 顺带写的东西：FTS（lang.indexTokens）、规范（discretion.writeNorm）、谁知道（discretion.recordKnowledge）、
// 痕迹（dynamics.addTrace）、嵌入文本（worker.enqueueEmbed）、隐藏的继承（admin.inheritSuppression，§12.7）。场合名不进嵌入文本（§7.2）。
import { ftsInsert } from '../store/fts.js';
import { parseRef } from '../store/refs.js';
import { bumpMetric } from '../store/kv.js';
import { SELF_KINDS } from '../contract/enums.js';
import {
  param, clamp, clamp01, isNum, jsonParse, clip, mref, rstr, isOccurrenceKind, TRUST, localDay, localWeek, localMonth,
  restrictionRank, normToInput, DAY, modeOfPercept,
} from './util.js';

const ROLE_ORDER = ['subject', 'object', 'mention', 'speaker', 'asserter'];

// ── 她自己、实体 ──────────────────────────────────────────────────────────

/** 她自己的实体 id（entities.ensureSelf；按 core 缓存）。 */
export function selfIdOf(core) {
  const st = core.state.encode ?? (core.state.encode = {});
  if (st.selfId == null) st.selfId = core.mods.entities.ensureSelf(core);
  return st.selfId;
}

/** 这批实体里有没有她以外的具体的人（§5.6 involves_others，评审:PS-19：由代码从实体算，不信模型）。 */
export function involvesOthers(core, entityIds) {
  const self = selfIdOf(core);
  for (const id of new Set(entityIds)) {
    if (!id || id === self) continue;
    try { if (core.mods.entities.isIndividual(core, id)) return true; } catch { return true; }   // 判断不了按涉及别人（更严）
  }
  return false;
}

// ── 感知、场合快照（读，schema 就是契约） ─────────────────────────────────────

export function perceptRow(core, id) {
  if (!id) return null;
  return core.store.get('SELECT * FROM percepts WHERE id = ?', id) ?? null;
}
export function snapshotRow(core, id) {
  if (!id) return null;
  return core.store.get('SELECT * FROM setting_snapshots WHERE id = ?', id) ?? null;
}
/** 场合当前的快照（没有就 null）。 */
export function currentSnapshot(core, settingKey) {
  return core.store.get(`SELECT s.* FROM setting_snapshots s JOIN settings t ON t.current_snapshot_id = s.id WHERE t.key = ?`, settingKey)
    ?? core.store.get('SELECT * FROM setting_snapshots WHERE setting_key = ? ORDER BY at DESC, id DESC LIMIT 1', settingKey) ?? null;
}
/** 场合规矩的当前版本（D8：MAX(setting_rules.version)，只算生效的）。 */
export function ruleVersion(core, settingKey) {
  if (!settingKey) return null;
  return core.store.get("SELECT MAX(version) AS v FROM setting_rules WHERE setting_key = ? AND status = 'active'", settingKey)?.v ?? null;
}

/** 她自己这边、只有她知道的感知（心里想的、她做了没对外的事）：没有别的原始受众。 */
const ownPrivate = (p) => p.visible_to === 'her-only' && (!!p.actor_self || SELF_KINDS.includes(p.kind));
/** 她私下读到的、原属另一个场合的内容（不是她自己的）：原始受众是内容所在场合的受众（§5.3）。 */
const readElsewhere = (p) => p.visible_to === 'her-only' && !ownPrivate(p) && !!p.setting_key && !!p.perceived_in && p.setting_key !== p.perceived_in;

/**
 * 来源场合当时的公开程度（规范的 origin_exposure）：取这些来源里最私密的那条感知所在场合的快照。
 * 她私下读到的内容（素材、她看的视频、工具结果、替主人看的另一个群）的原始受众是内容所属场合（setting_key）的受众（§5.3），
 * 公开内容就是公开的（§9.3.2 A3「某个公开视频里说的事」）。「谁知道」是内容所在场合的受众和原作者（knowledgeEntries），
 * 她读的时候所在的会话不算；visible_to 仍然只有她，所以照样不经 A1（§9.3.2）。
 * 只有她自己这边的（心里想的……）才是最私密的、优先于别的来源。没有感知（导入的）按最私密处理。
 * @returns {{originExposure: object, settingRuleRef: string|null, settingRuleVersion: number|null}}
 */
export function exposureOfSources(core, sources) {
  let best = null;
  let bestOwn = false;
  for (const s of sources ?? []) {
    const p = s.perceptId ? perceptRow(core, s.perceptId) : null;
    if (!p) continue;
    const snap = snapshotRow(core, p.snapshot_id ?? s.snapshotId) ?? currentSnapshot(core, p.setting_key);
    const own = ownPrivate(p);
    const ex = {
      exposureRank: own ? 0 : (snap?.exposure_rank ?? 1),
      persistenceRank: snap?.persistence_rank ?? 1,
      visibleTo: p.visible_to,
      settingKey: p.setting_key,
    };
    if (!best || ex.exposureRank < best.exposureRank || (own && !bestOwn)) { best = ex; bestOwn = own; }
  }
  if (!best) return { originExposure: { exposureRank: 0, persistenceRank: 1 }, settingRuleRef: null, settingRuleVersion: null };
  return { originExposure: best, settingRuleRef: best.settingKey, settingRuleVersion: ruleVersion(core, best.settingKey) };
}

/**
 * 「谁知道」的条目（§5.6）：按每个来源感知的 visible_to 和出现集合。她心里想的、她自己这边只有她知道的不写别人；
 * 她私下读到的、原属另一个场合的内容（替主人看的另一个群、她看的视频：setting_key ≠ perceived_in，§5.3「原始场合的受众 + 她自己」），
 * 写那个场合的受众和原作者——和感知本身的已知圈（discretion 的 perceptCircle）一致；她读的时候所在会话的人不写。
 * 任何人可见的场合记成「公开可得」（PS-05，不进已知圈）；主体本人只在说话人就是主体本人（权利层确认）时记。
 * @returns {import('../discretion/index.js').KnowledgeEntry[]}
 */
export function knowledgeEntries(core, sources, subjects = []) {
  const out = [];
  const seen = new Set();
  const push = (e) => { const k = `${e.whoKind}|${e.whoRef}|${e.basis}`; if (!seen.has(k)) { seen.add(k); out.push(e); } };
  const settingEntry = (p) => {
    const snap = snapshotRow(core, p.snapshot_id) ?? currentSnapshot(core, p.setting_key);
    push({ whoKind: 'setting', whoRef: p.setting_key, since: p.at, basis: (snap?.exposure_rank ?? 1) >= 3 ? 'public' : 'setting' });
  };
  for (const s of sources ?? []) {
    // 她推断的：「谁知道」固定是她自己（§5.6 第 6 条）——证据是当众说的，结论不是
    if (s.mode === 'inferred') continue;
    const p = s.perceptId ? perceptRow(core, s.perceptId) : null;
    if (p && p.visible_to !== 'her-only') {
      if (p.visible_to === 'setting-audience') settingEntry(p);
      if (p.presence_set_id) push({ whoKind: 'presence_set', whoRef: String(p.presence_set_id), since: p.at, basis: 'presence' });
    }
    if (p && readElsewhere(p)) {
      settingEntry(p);
      if (Number.isSafeInteger(p.actor_entity_id)) push({ whoKind: 'entity', whoRef: String(p.actor_entity_id), since: p.at, basis: 'presence' });
    }
    if (s.speaker && p && p.visible_to !== 'her-only') {
      for (const sub of subjects) {
        if (!sub) continue;
        let holder = sub === s.speaker;
        if (!holder) { try { holder = !!core.mods.entities.rightsHolder(core, s.speaker, sub); } catch { holder = false; } }
        if (holder) push({ whoKind: 'entity', whoRef: String(sub), since: s.at, basis: 'subject' });
      }
    }
  }
  return out;
}

/**
 * 新写出来的记忆单元继承隐藏（§12.7 隐藏 = 对别人隐藏）：证据里有主人隐藏过的消息（或含它的窗口、经历），一写出来就跟着隐藏，
 * 不等下一次 tick 的兜底扫描。在写入的事务里调（写完来源之后）。admin 出错不挡写入：兜底扫描照样会补上。
 * @param {string} ref
 * @param {number} at
 */
export function inheritHidden(core, ref, at) {
  try { core.mods.admin.inheritSuppression(core, ref, { at }); } catch (e) {
    try { bumpMetric(core.store, 'encode.errors.inheritSuppression'); } catch { /* 只读库 */ }
    core.log.warn('encode.inheritSuppression.failed', { ref, error: e?.code ?? e?.name ?? 'Error' });
  }
}

// ── 嵌入文本 ──────────────────────────────────────────────────────────────

/** 这个场合被叫过的名字（settings.label 和快照描述里的 label；太短的不算，免得误删正文里的字）。 */
export function settingLabels(core, settingKey) {
  if (!settingKey) return [];
  const out = new Set();
  const s = core.store.get('SELECT * FROM settings WHERE key = ?', settingKey);
  // 【D111】生效的、适配器最近给的、主人起的都算（旧库没有后两列）
  for (const l of [s?.label, s?.adapter_label, s?.owner_label]) if (typeof l === 'string' && l) out.add(l);
  for (const r of core.store.all('SELECT descriptor_json FROM setting_snapshots WHERE setting_key = ? ORDER BY id DESC LIMIT 5', settingKey)) {
    const l = jsonParse(r.descriptor_json, null)?.label;
    if (typeof l === 'string' && l) out.add(l);
  }
  return [...out].filter((l) => [...l].length >= 2).sort((a, b) => b.length - a.length);
}

/**
 * 情节的嵌入块（§7.2、向量:244）：上下文头 + 叙述；超过 maxChars 的按 minChars–maxChars 带重叠切块，每块都带上下文头。
 * @returns {{chunkNo: number, kind: 'text', text: string, headerVer: string|null}[]}
 */
export function episodeChunks(core, header, narrative, headerVer, settingLabels = []) {
  const maxChars = param(core, 'segment.chunk.maxChars');
  const minChars = param(core, 'segment.chunk.minChars');
  // 场合名不进嵌入文本（§7.2）：回想应当和场合无关，场合名还会把向量往同一场合的记忆上拉。模型写进去了也去掉（只在嵌入文本里）
  // 4 个字以上的名字到处去掉；更短的（主人起的「家里」「工作」这种也是常用词）只去掉写成地点的样子（「X」、在X里），不误删正文（评审）
  const strip = (s) => settingLabels.reduce((t, l) => ([...l].length >= 4 ? [l] : [`在「${l}」里`, `在「${l}」`, `「${l}」`, `在${l}里`])
    .reduce((u, p) => u.split(p).join(''), t), String(s ?? '')).replace(/\s{2,}/g, ' ').trim();
  const h = clip(strip(header), 150);
  const body = strip(narrative);
  const whole = [h, body].filter(Boolean).join('\n');
  if (!whole) return [];
  if ([...whole].length <= maxChars) return [{ chunkNo: 0, kind: 'text', text: whole, headerVer: headerVer ?? null }];
  const room = Math.max(minChars, maxChars - [...h].length - 1);
  const overlap = Math.min(60, Math.floor(room / 4));
  const chars = [...body];
  const chunks = [];
  for (let i = 0, n = 0; i < chars.length; n += 1) {
    let end = Math.min(chars.length, i + room);
    // 尽量在句末断开（不短于 minChars）
    for (let j = end; j > i + Math.min(minChars, room) && end < chars.length; j--) {
      if (/[。！？!?；;\n]/.test(chars[j - 1])) { end = j; break; }
    }
    chunks.push({ chunkNo: n, kind: 'text', text: [h, chars.slice(i, end).join('')].filter(Boolean).join('\n'), headerVer: headerVer ?? null });
    if (end >= chars.length) break;
    i = Math.max(i + 1, end - overlap);
  }
  return chunks;
}

// ── 来源 ─────────────────────────────────────────────────────────────────

/**
 * 插一行来源（不加痕迹）。quote 截到 retention.evidenceChars（60 字），撤回的消息不存原话。
 * @param {{kind: string, id: number}} owner
 * @param {import('./index.js').SourceInput & {jobId?: number|null, extractVer?: string|null}} s
 */
export function insertSource(core, owner, s) {
  const quoteMax = param(core, 'extract.quoteMax');
  let quote = s.quote ? clip(s.quote, quoteMax) : null;
  const p = s.perceptId ? perceptRow(core, s.perceptId) : null;
  if (p && p.text_state === 'retracted') quote = null;
  const r = core.store.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, snapshot_id, perceived_in, speaker, asserter, mode, hop, quote,
                              confidence, used_bg_json, at, extract_ver, job_id)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  owner.kind, owner.id, s.perceptId ?? null, s.snapshotId ?? p?.snapshot_id ?? null, s.perceivedIn ?? p?.perceived_in ?? null,
  s.speaker ?? null, s.asserter ?? null, s.mode, Math.max(0, Math.round(s.hop ?? 0)), quote, clamp01(s.confidence ?? 0.5),
  JSON.stringify(s.usedBg ?? []), s.at, s.extractVer ?? null, s.jobId ?? null);
  return Number(r.lastInsertRowid);
}

function sourceKeyOf(s) {
  if (s?.speaker) return `speaker:${s.speaker}`;
  if (s?.perceptId) return `percept:${s.perceptId}`;
  return `mode:${s?.mode ?? 'none'}`;
}

function addEntityRoles(core, assertionId, roles) {
  for (const [role, ids] of Object.entries(roles)) {
    for (const id of new Set(ids)) {
      if (!Number.isInteger(id) || id <= 0) continue;
      core.store.run('INSERT OR IGNORE INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, ?)', assertionId, id, role);
    }
  }
}

// ── 属性键注册表（§5.4：属性键是数据，不是代码） ─────────────────────────────

/** 存进注册表的键：NFKC、去首尾空白、折叠空白、拉丁字母小写。 */
export function predicateKey(key) {
  const k = String(key ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  return clip(k, 64) || 'attr';
}
/** 只用来找同义写法的宽松形：再去掉空白、下划线、连字符和点。 */
const looseKey = (k) => k.replace(/[\s_\-·・.]+/g, '');

function predicateCache(core) {
  const st = core.state.encode ?? (core.state.encode = {});
  if (!st.predicates) {
    const byKey = new Map();
    const byLoose = new Map();
    for (const r of core.store.all('SELECT key, canonical FROM predicates')) {
      byKey.set(r.key, r.canonical);
      if (!byLoose.has(looseKey(r.key))) byLoose.set(looseKey(r.key), r.canonical);
    }
    st.predicates = { byKey, byLoose };
  }
  return st.predicates;
}
export function resetPredicateCache(core) { if (core.state.encode) core.state.encode.predicates = null; }

/** 一个属性键现在的规范名（只读，不登记新键）：注册过的按注册表，没注册的按宽松形找同义的，都没有就是它自己。 */
export function canonicalPredicate(core, key) {
  const k = predicateKey(key);
  const cache = predicateCache(core);
  return cache.byKey.get(k) ?? core.store.get('SELECT canonical FROM predicates WHERE key = ?', k)?.canonical ?? cache.byLoose.get(looseKey(k)) ?? k;
}

/**
 * 属性键注册（实现 encode.ensurePredicate）。已有同义键（规范化后一样）时返回规范名，并把新写法登记成它的同义词。
 * 向量层面的同义键合并在夜里做（reviewFlagged）。
 */
export function ensurePredicate(core, key, info = {}) {
  const k = predicateKey(key);
  const cache = predicateCache(core);
  const hit = cache.byKey.get(k);
  if (hit) return hit;
  const row = core.store.get('SELECT canonical FROM predicates WHERE key = ?', k);
  if (row) { cache.byKey.set(k, row.canonical); return row.canonical; }
  const canonical = cache.byLoose.get(looseKey(k)) ?? k;
  core.store.tx((db) => {
    db.run(`INSERT INTO predicates(key, canonical, cardinality, is_current, synonyms_json, created_by, created_at)
            VALUES (?, ?, ?, ?, '[]', ?, ?)`,
    k, canonical, info.cardinality === 'many' ? 'many' : 'one', info.isCurrent ? 1 : 0, String(info.createdBy ?? 'extractor').slice(0, 32), core.now());
    if (canonical !== k) addSynonym(core, canonical, k);
  });
  cache.byKey.set(k, canonical);
  if (!cache.byLoose.has(looseKey(k))) cache.byLoose.set(looseKey(k), canonical);
  return canonical;
}
/** 把 alias 登记为 canonical 的同义词（canonical 行的 synonyms_json）。 */
export function addSynonym(core, canonical, alias) {
  const row = core.store.get('SELECT synonyms_json FROM predicates WHERE key = ?', canonical);
  if (!row) return;
  const syn = new Set(jsonParse(row.synonyms_json, []));
  if (syn.has(alias) || alias === canonical) return;
  syn.add(alias);
  core.store.run('UPDATE predicates SET synonyms_json = ? WHERE key = ?', JSON.stringify([...syn]), canonical);
}
/** 一个规范名下的全部写法（对账在这些键里找候选）。 */
export function predicateFamily(core, canonical) {
  const keys = core.store.all('SELECT key FROM predicates WHERE canonical = ? OR key = ?', canonical, canonical).map((r) => r.key);
  return [...new Set([canonical, ...keys])];
}
export function cardinalityOf(core, canonical) {
  return core.store.get('SELECT cardinality FROM predicates WHERE key = ?', canonical)?.cardinality ?? 'one';
}

// ── 发生次（§5.4「发生次」，评审:SC-01） ──────────────────────────────────

/**
 * 计划和事件的 occurrence_key：属性键 + 主体 / 当事人 + 时间窗所在的那一格（按精度：一天 / 一周 / 一个月）。
 * 同一个时间窗里的同一件事才算重复；不同的时间窗就是新的一次。没有时间返回 null（核验第 5 条会补上感知时间）。
 */
export function occurrenceKeyOf(core, { predicate, subjects = [], agent = null, window = null }) {
  if (!window || !isNum(window.start)) return null;
  const prec = window.precision ?? 'day';
  const bucket = prec === 'month' ? `m${localMonth(core, window.start)}`
    : prec === 'week' ? `w${localWeek(core, window.start)}`
      : `d${localDay(core, window.start)}`;
  const who = [...new Set([agent, ...subjects].filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b).join(',');
  return core.keys.hash('occurrence', predicate, who, bucket);
}

/** 同一类事的不同几次互相挂上（same_type，a < b），互不取代。 */
export function linkSameType(core, a, b) {
  if (!a || !b || a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  core.store.run('INSERT OR IGNORE INTO same_type(a, b) VALUES (?, ?)', x, y);
}
export function sameTypeOf(core, id) {
  return core.store.all('SELECT b AS id FROM same_type WHERE a = ? UNION SELECT a AS id FROM same_type WHERE b = ?', id, id).map((r) => r.id);
}

// ── 情节 ─────────────────────────────────────────────────────────────────

/** 实现 encode.writeEpisode。 */
export function writeEpisode(core, ep) {
  return core.store.tx(() => {
    const now = core.now();
    const participants = [...new Set((ep.participants ?? []).filter((x) => Number.isInteger(x) && x > 0))];
    const r = core.store.run(`INSERT INTO episodes(setting_key, ep_kind, title, narrative, header, header_ver, t_start, t_end, participants_json,
                                snapshot_id, sealed_at, emotion_json, extract_ver, model, job_id, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ep.settingKey, ep.kind ?? 'event', clip(ep.title ?? '', 80), String(ep.narrative ?? ''), String(ep.header ?? ''), ep.headerVer ?? null,
    ep.tStart, Math.max(ep.tStart, ep.tEnd ?? ep.tStart), JSON.stringify(participants), ep.snapshotId ?? null, now,
    ep.emotion ? JSON.stringify(ep.emotion) : null, ep.extractVer ?? null, ep.model ?? null, ep.jobId ?? null, now);
    const id = Number(r.lastInsertRowid);
    const ref = mref('episode', id);
    const text = [ep.title, ep.header, ep.narrative].filter(Boolean).join(' ');
    const hasText = !!(ep.header || ep.narrative);
    if (hasText) ftsInsert(core.store, 'episodes_fts', id, core.mods.lang.indexTokens(core, text, { entityIds: participants }));
    const sources = ep.sources ?? [];
    for (const s of sources) insertSource(core, { kind: 'episode', id }, { ...s, jobId: ep.jobId ?? null, extractVer: s.extractVer ?? ep.extractVer ?? null });
    // 规范在写入时给出（§5.6）：involves_others 由代码算
    const speakerIds = sources.map((s) => s.speaker).filter(Boolean);
    const exp = exposureOfSources(core, sources);
    const norm = { ...exp, ...(ep.norm ?? {}), involvesOthers: involvesOthers(core, [...participants, ...speakerIds, ...(ep.extraEntities ?? [])]) };
    if (!norm.originExposure) norm.originExposure = exp.originExposure;
    core.mods.discretion.writeNorm(core, ref, norm);
    if (ep.kind !== 'import' && !ep.noKnowledge) core.mods.discretion.recordKnowledge(core, ref, knowledgeEntries(core, sources, participants));
    if (sources.some((s) => s.perceptId)) inheritHidden(core, rstr('episode', id), now);
    // 痕迹：导入的不加（§6.4）；空的情节（模型没给叙述，只是把这段感知封口）不加
    if (hasText && ep.kind !== 'import') {
      core.mods.dynamics.addTrace(core, ref, { t: ep.tEnd ?? ep.tStart, w: ep.w ?? 1, sourceKey: `encode:${rstr('episode', id)}`, reason: 'encode' });
    }
    const chunks = episodeChunks(core, ep.header, ep.narrative, ep.headerVer, settingLabels(core, ep.settingKey));
    if (chunks.length) core.mods.worker.enqueueEmbed(core, ref, chunks, { layer: 'memory', priority: 2 });
    return id;
  });
}

// ── 事实 ─────────────────────────────────────────────────────────────────

/** 新属性键的默认基数（模型没说时）：状态、身份、事实类是单值；偏好、关系、看法、事件、计划可以有好几个。 */
const MANY_KINDS = new Set(['preference', 'relation', 'opinion', 'event', 'plan', 'request', 'norm_claim', 'commitment', 'ability']);
export const defaultCardinality = (kind) => (MANY_KINDS.has(kind) ? 'many' : 'one');

function windowOf(t) {
  if (!t) return null;
  if (isNum(t.start)) return { start: t.start, end: isNum(t.end) ? t.end : t.start, precision: t.precision ?? 'day' };
  return null;
}

/** 实现 encode.writeAssertion。 */
export function writeAssertion(core, a) {
  return core.store.tx(() => {
    const now = core.now();
    const cfg = core.config.get();
    const canonical = ensurePredicate(core, a.predicate, {
      createdBy: a.predicateCreatedBy ?? 'extractor', cardinality: a.cardinality ?? defaultCardinality(a.kindHint), isCurrent: a.isCurrent ?? a.kindHint === 'state',
    });
    let confidence = clamp01(a.confidence ?? 0.5);
    if (a.certainty === 'hearsay') confidence = Math.min(confidence, cfg.activation.hearsayConfidenceCap);   // 听说只影响可信度（UV-01）
    const text = clip(a.text, cfg.extract.factTextMax);
    const kindHint = a.kindHint || 'fact';
    const sources = a.sources ?? [];
    const evidenceAt = sources.reduce((m, s) => (isNum(s.at) ? Math.max(m, s.at) : m), -Infinity);
    const at0 = Number.isFinite(evidenceAt) ? evidenceAt : now;
    const ev = windowOf(a.eventTime);
    const planned = windowOf(a.plannedTime);
    const subjects = [...new Set((a.subjects ?? []).filter((x) => Number.isInteger(x) && x > 0))];
    const agent = a.plan?.agent ?? null;
    // 没有时间就没法自动失效（§5.4 第 5 条）：开始成立的时间默认是证据消息的时间
    const validFrom = isNum(a.validFrom) ? a.validFrom : (ev?.start ?? at0);
    const occurrenceKey = a.occurrenceKey ?? (isOccurrenceKind(kindHint)
      ? occurrenceKeyOf(core, { predicate: canonical, subjects, agent, window: planned ?? ev ?? { start: at0, precision: 'fuzzy' } }) : null);
    const imp = clamp(isNum(a.imp) ? a.imp : cfg.activation.defaultImp, 1, 10);
    const r = core.store.run(`INSERT INTO assertions(predicate, value, object_entity_id, text, kind_hint, recurrence, occurrence_key, certainty,
                                confidence, imp, event_start, event_end, event_precision, planned_time_json, valid_from, valid_to_known,
                                change_known, t50_h, shape, recorded_at, plan_agent, plan_status, pinned, needs_review, needs_reconcile,
                                extract_ver, model, job_id, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    canonical, a.value == null ? null : String(a.value).slice(0, 500), a.objectEntityId ?? null, text, kindHint,
    a.recurrence ? JSON.stringify(a.recurrence) : null, occurrenceKey, a.certainty, confidence, imp,
    ev?.start ?? null, ev?.end ?? null, ev?.precision ?? null, planned ? JSON.stringify(planned) : null, validFrom,
    isNum(a.validToKnown) ? a.validToKnown : null,
    isNum(a.survival?.t50h) && a.survival.t50h > 0 ? a.survival.t50h : null, isNum(a.survival?.shape) && a.survival.shape > 0 ? a.survival.shape : null,
    now, agent, a.plan ? (a.plan.status ?? 'planned') : null, a.pinned ? 1 : 0, a.needsReview ? 1 : 0, a.needsReconcile ? 1 : 0,
    a.extractVer ?? null, a.model ?? null, a.jobId ?? null, now, now);
    const id = Number(r.lastInsertRowid);
    const ref = mref('assertion', id);
    const speakers = sources.map((s) => s.speaker).filter(Boolean);
    const asserters = sources.map((s) => s.asserter).filter(Boolean);
    const mentions = (a.mentions ?? []).filter(Boolean);
    addEntityRoles(core, id, { subject: subjects, object: a.objectEntityId ? [a.objectEntityId] : [], mention: mentions, speaker: speakers, asserter: asserters });
    const allEntities = [...subjects, ...(a.objectEntityId ? [a.objectEntityId] : []), ...mentions, ...speakers, ...asserters];
    ftsInsert(core.store, 'assertions_fts', id,
      core.mods.lang.indexTokens(core, [text, a.value ?? ''].filter(Boolean).join(' '), { entityIds: [...new Set(allEntities)] }));
    for (const s of sources) insertSource(core, { kind: 'assertion', id }, { ...s, jobId: a.jobId ?? null, extractVer: s.extractVer ?? a.extractVer ?? null });
    const exp = exposureOfSources(core, sources);
    const norm = { ...exp, ...(a.norm ?? {}), involvesOthers: involvesOthers(core, allEntities) };
    if (!norm.originExposure) norm.originExposure = exp.originExposure;
    core.mods.discretion.writeNorm(core, ref, norm);
    const imported = sources.length > 0 && sources.every((s) => s.mode === 'imported');
    if (!imported) core.mods.discretion.recordKnowledge(core, ref, knowledgeEntries(core, sources, subjects));
    if (sources.some((s) => s.perceptId)) inheritHidden(core, rstr('assertion', id), now);
    if (!imported && !a.noTrace) {
      core.mods.dynamics.addTrace(core, ref, { t: at0, w: a.w ?? 1, sourceKey: `encode:${rstr('assertion', id)}`, reason: 'encode' });
    }
    const chunks = [{ chunkNo: 0, kind: 'text', text }];
    const fqMax = cfg.extract.futureQMax;
    (a.futureQ ?? []).map((q) => clip(String(q ?? '').trim(), 60)).filter(Boolean).slice(0, fqMax)
      .forEach((q, i) => chunks.push({ chunkNo: i + 1, kind: 'fq', text: q }));
    core.mods.worker.enqueueEmbed(core, ref, chunks, { layer: 'memory', priority: 2 });
    if (a.plan) {
      core.store.run('INSERT INTO plan_status_history(assertion_id, status, at, evidence_percept, source_json) VALUES (?, ?, ?, ?, ?)',
        id, a.plan.status ?? 'planned', at0, sources[0]?.perceptId ?? null, JSON.stringify({ initial: true }));
    }
    return id;
  });
}

export function assertionRow(core, id) {
  return core.store.get('SELECT * FROM assertions WHERE id = ?', id) ?? null;
}
export function assertionSubjects(core, id) {
  return core.store.all("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role = 'subject' ORDER BY entity_id", id).map((r) => r.entity_id);
}
export function assertionEntities(core, id) {
  const out = {};
  for (const r of core.store.all('SELECT entity_id, role FROM assertion_entities WHERE assertion_id = ?', id)) (out[r.role] ??= []).push(r.entity_id);
  return out;
}

/** 实现 encode.addSource：追加一个来源（不改写旧来源），顺带「又遇到了一次」的痕迹，并把这次的受众加进「谁知道」。 */
export function addSource(core, owner, source, trace) {
  core.store.tx(() => {
    insertSource(core, owner, source);
    const ref = mref(owner.kind, owner.id);
    if (owner.kind === 'assertion') {
      addEntityRoles(core, owner.id, { speaker: source.speaker ? [source.speaker] : [], asserter: source.asserter ? [source.asserter] : [] });
      core.store.run('UPDATE assertions SET updated_at = ? WHERE id = ?', core.now(), owner.id);
    }
    const subjects = owner.kind === 'assertion' ? assertionSubjects(core, owner.id) : [];
    if (source.mode !== 'imported') {
      const entries = knowledgeEntries(core, [source], subjects);
      if (entries.length) core.mods.discretion.recordKnowledge(core, ref, entries);
    }
    if (trace && source.mode !== 'imported') {
      core.mods.dynamics.addTrace(core, ref, { t: source.at, w: trace.w ?? 1, sourceKey: sourceKeyOf(source), reason: trace.reason ?? 'mention' });
    }
  });
}

/**
 * 记下一条事实被本人或有权限的人确认了（D142）：confirmed_at 取较晚的那次。不动 valid_from——确认是「到这时还成立」，
 * 不是「从这时才成立」；状态类事实的成立概率从两者里较晚的那个开始衰减（dynamics.pHold）。
 */
export function noteConfirmed(core, id, at) {
  if (!isNum(at)) return;
  core.store.run('UPDATE assertions SET confirmed_at = MAX(COALESCE(confirmed_at, ?), ?), updated_at = ? WHERE id = ?', at, at, core.now(), id);
}

/** 实现 encode.supersede（§5.4 第 2 条）：两条都保留；新版本至少继承旧版本的激活（第 7 条）。 */
export function supersede(core, oldId, newId, ctx) {
  if (!oldId || !newId || oldId === newId) return;
  core.store.tx(() => {
    const nw = assertionRow(core, newId);
    const old = assertionRow(core, oldId);
    if (!nw || !old) throw new Error('supersede：事实不存在');
    const at = ctx?.at ?? core.now();
    const validTo = isNum(nw.valid_from) ? nw.valid_from : at;
    core.store.run(`UPDATE assertions SET valid_to_known = CASE WHEN valid_to_known IS NULL OR valid_to_known > ? THEN ? ELSE valid_to_known END,
                      expired_at = COALESCE(expired_at, ?), superseded_by = ?, updated_at = ? WHERE id = ?`,
    validTo, validTo, at, newId, core.now(), oldId);
    core.store.run('UPDATE assertions SET supersedes = ?, updated_at = ? WHERE id = ?', oldId, core.now(), newId);
    core.mods.dynamics.inheritActivation(core, mref('assertion', oldId), mref('assertion', newId), { at });
  });
}

/** 重复合并（夜间复核判「相同」）：旧的那条的来源抄给保留的那条（不改写旧来源），旧的标过时、指向保留的那条。 */
export function mergeDuplicate(core, dupId, keepId, ctx) {
  if (!dupId || !keepId || dupId === keepId) return;
  core.store.tx(() => {
    const at = ctx?.at ?? core.now();
    for (const s of core.store.all("SELECT * FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", dupId)) {
      insertSource(core, { kind: 'assertion', id: keepId }, {
        perceptId: s.percept_id, snapshotId: s.snapshot_id, perceivedIn: s.perceived_in, speaker: s.speaker, asserter: s.asserter, mode: s.mode,
        hop: s.hop, quote: s.quote, confidence: s.confidence, usedBg: jsonParse(s.used_bg_json, []), at: s.at, extractVer: s.extract_ver, jobId: s.job_id,
      });
    }
    const roles = assertionEntities(core, dupId);
    addEntityRoles(core, keepId, { mention: roles.subject ?? [], speaker: roles.speaker ?? [], asserter: roles.asserter ?? [] });
    core.store.run('UPDATE assertions SET expired_at = COALESCE(expired_at, ?), superseded_by = ?, needs_review = 0, needs_reconcile = 0, updated_at = ? WHERE id = ?',
      at, keepId, core.now(), dupId);
    // 被合并掉的那条确认过（D142）：同一件事，保留的那条也算确认过（取较晚的）
    const dupConfirmed = core.store.get('SELECT confirmed_at FROM assertions WHERE id = ?', dupId)?.confirmed_at;
    if (dupConfirmed != null) noteConfirmed(core, keepId, dupConfirmed);
    repointIntentions(core, dupId, keepId);   // 同一件事：开着的意图跟着保留的那条（D122 评审：线上两条意图还挂在被合并掉的那条上）
    core.mods.dynamics.inheritActivation(core, mref('assertion', dupId), mref('assertion', keepId), { at });
  });
}

/** 实现 encode.markChanged（§5.4 第 3 条）：change_known=1；来源记下这次「据说变了」，并算又遇到一次。 */
export function markChanged(core, assertionId, ctx) {
  core.store.tx(() => {
    const row = assertionRow(core, assertionId);
    if (!row) throw new Error('markChanged：事实不存在');
    core.store.run('UPDATE assertions SET change_known = 1, updated_at = ? WHERE id = ?', core.now(), assertionId);
    if (ctx?.source) addSource(core, { kind: 'assertion', id: assertionId }, ctx.source, { w: ctx.w ?? 1, reason: 'mention' });
  });
}

/**
 * 一条事实换成新版本时，还开着的意图（formed / armed）跟着指向新版本（D122 评审）：它们说的还是同一件事，
 * 留在旧 id 上的话，计划结案时按 id 找不到它们（plans.transitionPlan），时间维护还可能再形成一条。
 */
export function repointIntentions(core, oldId, newId) {
  core.store.run(`UPDATE intentions SET about_id = ?, updated_at = ? WHERE about_kind = 'assertion' AND about_id = ? AND state IN ('formed','armed')`,
    newId, core.now(), oldId);
}

/** 照着一条事实复制出新版本（来源照抄、规范照旧版本），不取代谁。patch 能改的见 reviseAssertion（D124 起也能改 value：经验的状态和范围）；changeKnown:false 不带上「变了」。 */
function copyAssertion(core, id, patch) {
  const old = assertionRow(core, id);
  if (!old) return null;
  const roles = assertionEntities(core, id);
  const sources = core.store.all("SELECT * FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? ORDER BY id", id).map((s) => ({
    perceptId: s.percept_id, snapshotId: s.snapshot_id, perceivedIn: s.perceived_in, speaker: s.speaker, asserter: s.asserter, mode: s.mode,
    hop: s.hop, quote: s.quote, confidence: s.confidence, usedBg: jsonParse(s.used_bg_json, []), at: s.at, extractVer: s.extract_ver,
  }));
  // 规范照旧版本：来源还没评估完的（unassessed）保留已合并的限制、至少 soft，不丢成「无限制」；读不到按 soft（往严里靠）
  let norm;
  try { norm = normToInput(core.mods.discretion.normOf(core, mref('assertion', id))) ?? { restriction: 'soft' }; } catch { norm = { restriction: 'soft' }; }
  const planned = jsonParse(old.planned_time_json, null);
  const nid = writeAssertion(core, {
    subjects: roles.subject ?? [], objectEntityId: old.object_entity_id, mentions: roles.mention ?? [], predicate: old.predicate, value: patch.value !== undefined ? patch.value : old.value,
    text: patch.text ?? old.text, kindHint: patch.kindHint ?? old.kind_hint, recurrence: jsonParse(old.recurrence, null),
    occurrenceKey: patch.kindHint && !isOccurrenceKind(patch.kindHint) ? null : old.occurrence_key, certainty: patch.certainty ?? old.certainty,
    confidence: patch.confidence ?? old.confidence, imp: old.imp,
    eventTime: old.event_start != null ? { start: old.event_start, end: old.event_end, precision: old.event_precision } : null,
    plannedTime: planned, validFrom: patch.validFrom ?? old.valid_from, validToKnown: old.valid_to_known,
    survival: patch.survival !== undefined ? patch.survival : (old.t50_h ? { t50h: old.t50_h, shape: old.shape ?? 1 } : null),
    plan: old.plan_status ? { agent: old.plan_agent, status: old.plan_status } : null, pinned: !!old.pinned, sources,
    norm, noTrace: true, extractVer: patch.extractVer ?? old.extract_ver, model: patch.model ?? old.model, jobId: null,
  });
  if (old.change_known && patch.changeKnown !== false) core.store.run('UPDATE assertions SET change_known = 1 WHERE id = ?', nid);
  // 确认过的照旧带上（D142）：新版本说的还是同一件事，「到那时还成立」不因为改了别的字段就丢
  if (old.confirmed_at != null) core.store.run('UPDATE assertions SET confirmed_at = ? WHERE id = ?', old.confirmed_at, nid);
  return nid;
}

/**
 * 复制一条事实成新版本（夜间复核改了种类、存续时间这类字段：修改写历史，不改写来源，§5.4 第 8 条）。
 * 来源照抄，规范继承旧版本，然后旧的被新的取代；还开着的意图跟着指向新版本。返回新 id。
 */
export function reviseAssertion(core, id, patch, ctx) {
  return core.store.tx(() => {
    const nid = copyAssertion(core, id, patch);
    if (nid == null) return null;
    // 新版本不重复加痕迹：激活靠继承（supersede 里 inheritActivation）
    supersede(core, id, nid, { at: ctx?.at ?? core.now() });
    repointIntentions(core, id, nid);
    return nid;
  });
}

// ── 夜里对照原话纠错的写回（D122） ───────────────────────────────────────

/**
 * 实现 encode.applyCorrection。要动的那一版已经被取代了就不动（返回 null）。
 *   correct：新版本 = 改正后的说法（主体、宾语、提到的人、种类、时间照旧），来源 = 引用的证据感知（说话人、方式按感知的结构算，
 *            不信模型），确定程度和把握由调用方按证据定；旧的被它取代（覆盖同一段时间，旧的等于从来没成立过，两条都留着）。
 *            规范先照旧版本，再经 discretion.inheritNorm（quote：旧版本和证据里最严的、「谁知道」取交集）。
 *   doubt：把握降到 confidence（新版本、来源照抄，修改写历史）；本来就不高于它的不动。
 *   raise：把握升到 confidence（只升不降；新版本、来源照抄；上限由调用方给，确认过的不动）。
 *   changed：只标「变了但不知道变成什么」（change_known=1）：不加来源（证据记在调用方那里）、不加痕迹——
 *            过时的事不该因此更容易被想起，主人的那句话也不会让它变成「主人说的」。
 *   restore：主人撤销一次改正：照 from（改之前的那一版）复制出新版本，确定程度 confirmed、把握至少 0.9、不带「变了」，取代现在这一版。
 * 换版本时还开着的意图跟着指向新版本。
 */
export function applyCorrection(core, id, c, ctx = {}) {
  return core.store.tx(() => {
    const old = assertionRow(core, id);
    if (!old || old.superseded_by != null) return null;
    const at = ctx.at ?? core.now();
    const self = selfIdOf(core);
    const ids = [...new Set((c.evidence ?? []).filter((x) => Number.isInteger(x)))];
    const rows = ids.length ? core.store.all(`SELECT * FROM percepts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY at, id`, ...ids) : [];
    const roles = assertionEntities(core, id);
    const subjects = roles.subject ?? [];
    const conf = clamp01(c.confidence ?? old.confidence);
    const replaceWith = (nid) => {
      supersede(core, id, nid, { at });
      repointIntentions(core, id, nid);
      return nid;
    };
    if (c.op === 'doubt') return conf >= old.confidence ? old.id : replaceWith(copyAssertion(core, id, { confidence: conf, extractVer: c.extractVer, model: c.model }));
    if (c.op === 'raise') {
      if (conf <= old.confidence || old.certainty === 'confirmed') return old.id;
      return replaceWith(copyAssertion(core, id, { confidence: conf, extractVer: c.extractVer, model: c.model }));
    }
    if (c.op === 'changed') {
      core.store.run('UPDATE assertions SET change_known = 1, updated_at = ? WHERE id = ?', core.now(), id);
      return old.id;
    }
    if (c.op === 'restore') {
      const from = assertionRow(core, c.from);
      if (!from) return null;
      return replaceWith(copyAssertion(core, from.id, { certainty: 'confirmed', confidence: Math.max(0.9, from.confidence), changeKnown: false }));
    }
    if (c.op !== 'correct' || !rows.length || !String(c.text ?? '').trim()) return null;
    const sourceOf = (p) => {
      const speaker = p.actor_self ? self : p.actor_entity_id ?? null;
      return { perceptId: p.id, snapshotId: p.snapshot_id, perceivedIn: p.perceived_in, speaker, asserter: speaker, mode: modeOfPercept(p),
        hop: speaker != null && subjects.includes(speaker) ? 0 : 1, quote: null, confidence: conf, at: p.at, extractVer: c.extractVer ?? null };
    };
    let norm;
    try { norm = normToInput(core.mods.discretion.normOf(core, mref('assertion', id))) ?? { restriction: 'soft' }; } catch { norm = { restriction: 'soft' }; }
    const cfg = core.config.get();
    const nid = writeAssertion(core, {
      subjects, objectEntityId: old.object_entity_id, mentions: roles.mention ?? [], predicate: c.predicate || old.predicate, value: null,
      text: clip(String(c.text).trim(), cfg.extract.factTextMax), kindHint: old.kind_hint, certainty: c.certainty, confidence: conf, imp: old.imp,
      eventTime: old.event_start != null ? { start: old.event_start, end: old.event_end, precision: old.event_precision } : null,
      plannedTime: jsonParse(old.planned_time_json, null), validFrom: old.valid_from,
      survival: old.t50_h ? { t50h: old.t50_h, shape: old.shape ?? 1 } : null,
      plan: old.plan_status ? { agent: old.plan_agent, status: old.plan_status } : null,
      sources: rows.map(sourceOf), norm, noTrace: true, extractVer: c.extractVer ?? null, model: c.model ?? null, jobId: null,
    });
    replaceWith(nid);
    core.mods.discretion.inheritNorm(core, mref('assertion', nid), [mref('assertion', id), ...rows.map((p) => mref('percept', p.id))], { derivation: 'quote', at });
    return nid;
  });
}

// ── 来源链（撤回、彻底删除的级联靠它） ─────────────────────────────────────

/** 实现 encode.derivedFrom。onlySource：除了这条感知没有别的证据（导入、推断的来源也算别的证据）。 */
export function derivedFrom(core, perceptId) {
  const owners = core.store.all('SELECT DISTINCT owner_kind, owner_id FROM sources WHERE percept_id = ?', perceptId);
  const out = [];
  for (const o of owners) {
    const other = core.store.get(`SELECT COUNT(*) AS n FROM sources WHERE owner_kind = ? AND owner_id = ?
                                    AND ((percept_id IS NOT NULL AND percept_id <> ?) OR (percept_id IS NULL AND mode IN ('imported','inferred','self_generated')))`,
    o.owner_kind, o.owner_id, perceptId).n;
    out.push({ ref: rstr(o.owner_kind, o.owner_id), onlySource: other === 0 });
  }
  // 情节：感知归进了哪个情节（来源行之外的那条路，免得漏掉没写来源的老数据）
  const p = core.store.get('SELECT episode_id FROM percepts WHERE id = ?', perceptId);
  if (p?.episode_id && !out.some((x) => x.ref === rstr('episode', p.episode_id))) {
    const n = core.store.get('SELECT COUNT(*) AS n FROM percepts WHERE episode_id = ? AND id <> ?', p.episode_id, perceptId).n;
    out.push({ ref: rstr('episode', p.episode_id), onlySource: n === 0 });
  }
  return out;
}

/** 实现 encode.onPerceptRetracted（§5.6「撤回」，评审:AR-14）。不抛错。 */
export function onPerceptRetracted(core, perceptId) {
  try {
    core.store.tx(() => {
      const at = core.now();
      const derived = derivedFrom(core, perceptId);
      for (const d of derived) {
        const r = parseRef(d.ref);
        if (r) core.mods.discretion.tightenNorm(core, r, { restriction: 'soft', reason: 'retracted', at });
      }
      core.store.run('UPDATE sources SET quote = NULL WHERE percept_id = ?', perceptId);
      const p = perceptRow(core, perceptId);
      // 已经提炼过的感知自己的规范也收紧；还没提炼的，提炼时看到 text_state 会给 ≥ soft
      if (p && p.norm_state === 'assessed') core.mods.discretion.tightenNorm(core, mref('percept', perceptId), { restriction: 'soft', reason: 'retracted', at });
    });
    bumpMetric(core.store, 'encode.retracted');
  } catch (e) {
    try { bumpMetric(core.store, 'encode.errors.retracted'); } catch { /* 只读库 */ }
    core.log.warn('encode.retracted.failed', { perceptId, error: e?.code ?? e?.name ?? 'Error' });
  }
}

/** 实现 encode.onPerceptEdited：依赖它的事实标 needs_review，夜里重新核验。不抛错。 */
export function onPerceptEdited(core, oldPerceptId, newPerceptId) {
  try {
    core.store.tx(() => {
      for (const d of derivedFrom(core, oldPerceptId)) {
        const r = parseRef(d.ref);
        if (r?.kind !== 'assertion') continue;
        core.store.run('UPDATE assertions SET needs_review = 1, updated_at = ? WHERE id = ?', core.now(), r.id);
      }
    });
    bumpMetric(core.store, 'encode.edited');
  } catch (e) {
    try { bumpMetric(core.store, 'encode.errors.edited'); } catch { /* 只读库 */ }
    core.log.warn('encode.edited.failed', { oldPerceptId, newPerceptId, error: e?.code ?? e?.name ?? 'Error' });
  }
}


// ── 配额（§7.4 第 10 条） ──────────────────────────────────────────────────

/** 某人某天已经用掉的新事实配额。 */
export function quotaUsed(core, day, entityId) {
  return core.store.get('SELECT facts, hearsay FROM speaker_quota WHERE day = ? AND entity_id = ?', day, entityId) ?? { facts: 0, hearsay: 0 };
}
export function quotaAdd(core, day, entityId, { facts = 0, hearsay = 0 }) {
  core.store.run(`INSERT INTO speaker_quota(day, entity_id, facts, hearsay) VALUES (?, ?, ?, ?)
                  ON CONFLICT(day, entity_id) DO UPDATE SET facts = facts + excluded.facts, hearsay = hearsay + excluded.hearsay`,
  day, entityId, facts, hearsay);
}
/** 每人每天的上限：10 × (1 + 4 × closeness)；principal 不限（Infinity）。 */
export function quotaLimit(core, bond) {
  if (bond?.authority === 'principal') return Infinity;
  const q = core.config.get().extract.quota;
  return q.base * (1 + q.closenessFactor * clamp01(bond?.closeness ?? 0));
}
export { localDay, restrictionRank, TRUST, DAY };
