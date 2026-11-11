// 候选的元数据（只读、按种类批量查）：激活打分要的 S / C / 取代 / 意图，MMR 要的文字和包含关系，
// 发生次要的时间，每个实体最多 3 条要的「关于谁」。主表已经没有的行（被删了）返回不到，候选随之丢掉。
import { mrefOf, parseJson, rowsByIds } from './util.js';

/**
 * @typedef {object} CandMeta
 * @property {string} kind
 * @property {string} text                 用来重排、MMR 的文字（不是渲染结果）
 * @property {string[]} settingKeys        在哪些场合编码 / 知道的
 * @property {number[]} participants       当时和谁在一起（说话人、在场者）
 * @property {number[]} about              「关于谁」：事实的主体和宾语、实体本身、印象的主人、意图的对象
 * @property {number|null} tStart
 * @property {number|null} tEnd
 * @property {number} [windowId]
 * @property {number} [episodeId]
 * @property {{settingKey: string, first: number, last: number}} [range]   原文窗口覆盖的感知 id
 * @property {number[]} [sourcePercepts]
 * @property {object} [row]                主表行（事实、意图要用）
 */

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {string[]} refs
 * @returns {Map<string, CandMeta>}
 */
export function hydrate(core, refs) {
  const byKind = new Map();
  for (const ref of refs) {
    const m = mrefOf(ref);
    if (!m) continue;
    if (!byKind.has(m.kind)) byKind.set(m.kind, []);
    byKind.get(m.kind).push(m.id);
  }
  const out = new Map();
  const st = core.store;

  const a = byKind.get('assertion') ?? [];
  if (a.length) {
    const rows = rowsByIds(st, `SELECT id, text, kind_hint, predicate, certainty, confidence, imp, event_start, event_end, valid_from,
      valid_to_known, change_known, t50_h, shape, confirmed_at, recorded_at, expired_at, supersedes, superseded_by, plan_agent, plan_status,
      plan_outcome_ref, occurrence_key, planned_time_json FROM assertions WHERE id IN (?*)`, a);
    const ents = groupBy(rowsByIds(st, 'SELECT assertion_id AS id, entity_id AS e, role FROM assertion_entities WHERE assertion_id IN (?*)', a));
    const srcs = groupBy(rowsByIds(st, "SELECT owner_id AS id, perceived_in, speaker, percept_id, at FROM sources WHERE owner_kind = 'assertion' AND owner_id IN (?*)", a));
    for (const r of rows) {
      const es = ents.get(r.id) ?? [];
      const ss = srcs.get(r.id) ?? [];
      const t = occTime(r);
      out.set(`a${r.id}`, {
        kind: 'assertion',
        text: r.text ?? '',
        settingKeys: uniq(ss.map((s) => s.perceived_in).filter(Boolean)),
        participants: uniq([...ss.map((s) => s.speaker), ...es.filter((e) => e.role === 'speaker').map((e) => e.e)].filter((x) => x != null)),
        about: uniq(es.filter((e) => e.role === 'subject' || e.role === 'object').map((e) => e.e)),
        mentions: uniq(es.filter((e) => e.role === 'mention').map((e) => e.e)),
        tStart: t,
        tEnd: r.event_end ?? t,
        sourcePercepts: uniq(ss.map((s) => s.percept_id).filter((x) => x != null)),
        row: r,
      });
    }
  }

  const e = byKind.get('episode') ?? [];
  if (e.length) {
    for (const r of rowsByIds(st, 'SELECT id, setting_key, ep_kind, title, header, narrative, t_start, t_end, participants_json FROM episodes WHERE id IN (?*)', e)) {
      const parts = (parseJson(r.participants_json, []) ?? []).filter((x) => Number.isInteger(x));
      out.set(`e${r.id}`, {
        kind: 'episode', text: [r.header, r.narrative].filter(Boolean).join(' ') || r.title || '',
        settingKeys: [r.setting_key], participants: parts, about: [], tStart: r.t_start, tEnd: r.t_end, row: r,
      });
    }
  }

  const p = byKind.get('percept') ?? [];
  if (p.length) {
    for (const r of rowsByIds(st, `SELECT id, setting_key, perceived_in, at, actor_entity_id, actor_self, kind, text, text_state, window_id,
      episode_id, visible_to, addressed, media_json FROM percepts WHERE id IN (?*)`, p)) {
      // 她看过的媒体（D116）：文字带上她看到的（重排、去重按这段文字算）
      const text = r.text_state === 'retracted' ? '' : r.media_json ? core.mods.intake.mediaText(core, r.text, r.media_json, { who: '你' }) : (r.text ?? '');
      out.set(`p${r.id}`, {
        kind: 'percept', text,
        settingKeys: uniq([r.setting_key, r.perceived_in].filter(Boolean)),
        participants: r.actor_entity_id != null ? [r.actor_entity_id] : [], about: [], tStart: r.at, tEnd: r.at,
        windowId: r.window_id ?? undefined, episodeId: r.episode_id ?? undefined, row: r,
      });
    }
  }

  const w = byKind.get('window') ?? [];
  if (w.length) {
    for (const r of rowsByIds(st, 'SELECT id, setting_key, first_percept, last_percept, t_start, t_end, text FROM raw_windows WHERE id IN (?*)', w)) {
      out.set(`w${r.id}`, {
        kind: 'window', text: r.text ?? '', settingKeys: [r.setting_key], participants: [], about: [], tStart: r.t_start, tEnd: r.t_end,
        range: { settingKey: r.setting_key, first: r.first_percept, last: r.last_percept }, row: r,
      });
    }
  }

  const n = byKind.get('entity') ?? [];
  if (n.length) {
    for (const r of rowsByIds(st, 'SELECT id, kind, display_name, is_self, last_mention_at FROM entities WHERE id IN (?*)', n)) {
      out.set(`n${r.id}`, {
        kind: 'entity', text: r.display_name ?? '', settingKeys: [], participants: [], about: r.is_self ? [] : [r.id],
        tStart: r.last_mention_at ?? null, tEnd: r.last_mention_at ?? null, row: r,
      });
    }
  }

  const i = byKind.get('impression') ?? [];
  if (i.length) {
    for (const r of rowsByIds(st, 'SELECT id, entity_id, layer, text, built_at, is_current FROM entity_impressions WHERE id IN (?*)', i)) {
      if (!r.is_current) continue;   // 旧版本的印象已经被重新生成的取代
      out.set(`i${r.id}`, {
        kind: 'impression', text: r.text ?? '', settingKeys: [], participants: [], about: [r.entity_id], tStart: r.built_at, tEnd: r.built_at, row: r,
      });
    }
  }

  const t = byKind.get('intention') ?? [];
  if (t.length) {
    for (const r of rowsByIds(st, 'SELECT * FROM intentions WHERE id IN (?*)', t)) {
      out.set(`t${r.id}`, {
        kind: 'intention', text: r.text ?? '', settingKeys: [], participants: [],
        about: r.target_entity_id != null ? [r.target_entity_id] : [], tStart: r.window_start ?? r.formed_at, tEnd: r.window_end ?? r.formed_at, row: r,
      });
    }
  }

  const s = byKind.get('storyline') ?? [];
  if (s.length) {
    for (const r of rowsByIds(st, 'SELECT id, setting_key, text, updated_at FROM storylines WHERE id IN (?*)', s)) {
      out.set(`s${r.id}`, { kind: 'storyline', text: r.text ?? '', settingKeys: [r.setting_key], participants: [], about: [], tStart: r.updated_at, tEnd: r.updated_at, row: r });
    }
  }

  const c = byKind.get('community') ?? [];
  if (c.length) {
    for (const r of rowsByIds(st, 'SELECT id, setting_key, label, summary, members_json, built_at, is_current FROM communities WHERE id IN (?*)', c)) {
      if (!r.is_current) continue;
      out.set(`c${r.id}`, {
        kind: 'community', text: [r.label, r.summary].filter(Boolean).join('：'), settingKeys: r.setting_key ? [r.setting_key] : [],
        participants: [], about: [], tStart: r.built_at, tEnd: r.built_at, row: r,
      });
    }
  }

  const l = byKind.get('link') ?? [];
  if (l.length) {
    for (const r of rowsByIds(st, 'SELECT id, a, b, at FROM entity_links WHERE id IN (?*)', l)) {
      out.set(`l${r.id}`, { kind: 'link', text: '', settingKeys: [], participants: [], about: [r.a, r.b], tStart: r.at, tEnd: r.at, row: r });
    }
  }
  return out;
}

/** 一条事实「是哪一次」的时间：事件时间 → 计划时间 → 开始成立 → 记下的时间。 */
export function occTime(r) {
  if (Number.isFinite(r.event_start)) return r.event_start;
  const pt = parseJson(r.planned_time_json, null);
  const ps = pt && (Number.isFinite(pt.start) ? pt.start : Number.isFinite(pt.at) ? pt.at : null);
  if (Number.isFinite(ps)) return ps;
  if (Number.isFinite(r.valid_from)) return r.valid_from;
  return r.recorded_at ?? null;
}

function groupBy(rows) {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.id)) m.set(r.id, []); m.get(r.id).push(r); }
  return m;
}
function uniq(xs) { return [...new Set(xs)]; }
