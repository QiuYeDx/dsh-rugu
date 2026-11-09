// 人物卡（§10.4「在场人物卡」「重要的人」）和给 context 自己组的条目打激活分。
// 卡头（称呼、认识多久、和她的关系、上次在这里说话）由实体这一条（'n'）的判定决定能不能说；印象按层分别判定，
// 选能通过评估的那层（§5.2、评审:UV-17、PS-17）。卡里的每一段都对得上一次判定（§9.3.6）。
import { refOf, parseRef } from '../store/index.js';
import { clip, sanitize, humanSpan, DAY_MS, HOUR_MS } from './text.js';

/**
 * context 自己组的候选（人物卡、时间间隔、暖启动、今天到目前为止、意图……）→ ScoredCandidate（S = C = 0，B / I 由 dynamics 算）。
 * @param {{ref: string, superseded?: boolean, intention?: object|null, cueHit?: boolean}[]} cands
 * @returns {import('../core-types.js').ScoredCandidate[]}
 */
export function activateExtras(core, cands, ctx) {
  const seen = new Set();
  const inputs = [];
  for (const c of cands) {
    if (seen.has(c.ref) || !parseRef(c.ref)) continue;
    seen.add(c.ref);
    inputs.push({
      candidate: { ref: c.ref, mref: parseRef(c.ref), ranks: {}, rrf: 0, signals: {} },
      S: 0, C: 0, superseded: !!c.superseded, intention: c.intention ?? null, cueHit: !!c.cueHit,
    });
  }
  if (!inputs.length) return [];
  try {
    return core.mods.dynamics.activate(core, inputs, ctx);
  } catch (e) {
    core.log.warn('context.activate.error', { error: e?.code ?? e?.name ?? 'Error' });
    return inputs.map((i) => ({ ...i.candidate, A: 0, P: 0.5, parts: { B: 0, S: 0, C: 0, I: 0, Psup: 0, eps: 0 } }));
  }
}

/**
 * 她在这个场合怎么称呼这个人：本场合作用域的名字优先，其次不限场合的，再其次档案上的名字。
 * 和别人保留名撞了的名片 / 昵称（spoof）不用（§9.6 冒充）；别的场合作用域的名字（群名片）不跨场合带出来。
 */
export function bestName(core, entityId, settingKey) {
  const row = core.store.get(`SELECT text_raw FROM entity_names WHERE entity_id = ? AND spoof = 0 AND (scope_setting_key = ? OR scope_setting_key = '')
      ORDER BY (scope_setting_key = ?) DESC, count DESC, last DESC LIMIT 1`, entityId, settingKey ?? '', settingKey ?? '');
  if (row?.text_raw) return row.text_raw;
  return core.store.get('SELECT display_name FROM entities WHERE id = ?', entityId)?.display_name ?? null;
}

/** 关系描述：「阿明的表哥」「你的同学」（锚点 + 关系，§5.2）。用关系的原文（规范化后的只用来比较）；自称的关系不算（只产生 maybe_same）。 */
function relationText(core, entityId, settingKey, selfId) {
  const d = core.store.get(`SELECT anchor_entity_id, relation, text FROM entity_descriptors WHERE entity_id = ? AND basis <> 'self-claim'
      ORDER BY count DESC, id LIMIT 1`, entityId);
  const rel = d ? (String(d.text ?? '').trim() || d.relation) : null;
  if (!rel) return null;
  const anchor = d.anchor_entity_id === selfId ? '你' : bestName(core, d.anchor_entity_id, settingKey);
  return anchor ? `${anchor}的${rel}` : null;
}

/**
 * 一张人物卡的卡头。share → 自己渲染（称呼、和她的关系、认识多久、上次在这里说话）；share_vague → 第二段写好的含糊版本；其余不给。
 * @returns {{ref: string, text: string}|null}
 */
export function cardFor(core, { entityId, gate, settingKey, at, selfId }) {
  if (!gate) return null;
  const cfg = core.config.get();
  const max = cfg.context.layers.peopleCardChars;
  const ref = refOf('entity', entityId);
  if (gate.verdict === 'share_vague') {
    const t = clip(sanitize(core, gate.vagueText ?? ''), max);
    return t ? { ref, text: t } : null;
  }
  if (gate.verdict !== 'share') return null;
  const e = core.store.get('SELECT id, display_name, first_mention_at, created_at, authority FROM entities WHERE id = ?', entityId);
  if (!e) return null;
  const rel = relationText(core, entityId, settingKey, selfId);
  const name = bestName(core, entityId, settingKey) ?? rel ?? '一个人';
  const parts = [];
  if (e.authority === 'principal') {
    let label = '';
    try { label = core.ports.selfProfile.principalLabel() ?? ''; } catch { /* 没有称呼就不写 */ }
    if (label && label !== name) parts.push(`你的${label}`);
  }
  if (rel && rel !== name) parts.push(rel);
  // 她从没直接接触过的人（只在别人的话里出现过）：不说「认识多久」，说清楚是听谁说的（§10.4 注入块的例子）
  const firstHand = e.authority === 'principal'
    || !!core.store.get('SELECT 1 AS x FROM percepts WHERE actor_entity_id = ? AND actor_self = 0 LIMIT 1', entityId);
  if (!firstHand) {
    const src = core.store.get(`SELECT speaker_entity_id AS s FROM entity_descriptors WHERE entity_id = ? AND speaker_entity_id > 0 AND basis <> 'self-claim'
        GROUP BY speaker_entity_id ORDER BY SUM(count) DESC, MIN(id) LIMIT 1`, entityId)?.s;
    const who = src && src !== selfId && src !== entityId ? bestName(core, src, settingKey) : null;
    parts.push(who ? `你没见过，是听${who}说的` : '你没见过');
  } else {
    const first = e.first_mention_at ?? e.created_at;
    if (first != null) parts.push(at - first < DAY_MS ? '今天刚认识' : `认识 ${humanSpan(at - first)}`);
  }
  const last = lastSpokeHere(core, entityId, settingKey, at, cfg.context.layers.gapH * HOUR_MS);
  if (last != null) parts.push(`上次在这里说话是 ${humanSpan(at - last)}前`);
  const text = parts.length ? `${name}（${parts.join('，')}）` : name;
  return { ref, text: clip(sanitize(core, text), max) };
}

/**
 * rows 按 id 降序：从最新往回走，间隔都 ≤ gapMs 的是「这一段」；再往前一条和这一段开头隔了 > gapMs，就是「很久没聊」。
 * @param {{id: number, at: number}[]} rows
 * @returns {{burstStart: {id: number, at: number}, prev: {id: number, at: number}}|null}
 */
export function burstGap(rows, gapMs) {
  if (!rows.length) return null;
  let burstStart = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (burstStart.at - rows[i].at > gapMs) return { burstStart, prev: rows[i] };
    burstStart = rows[i];
  }
  return null;
}

/** 这个人上次在这个场合说话（这一段对话之前的那次；隔得不久就不提）。 */
function lastSpokeHere(core, entityId, settingKey, at, gapMs) {
  const rows = core.store.all('SELECT id, at FROM percepts WHERE setting_key = ? AND actor_entity_id = ? AND at <= ? ORDER BY id DESC LIMIT 50',
    settingKey, entityId, at);
  if (!rows.length) return null;
  if (at - rows[0].at > gapMs) return rows[0].at;    // 最近没说过话：最后那次就是「上次」
  return burstGap(rows, gapMs)?.prev.at ?? null;     // 正在说：上一段的最后一句
}

/**
 * 印象选哪一层（「选能通过评估的那层」）：私下那层能说 > 大家都看得到那层能说 > 私下那层说个大概 > 公开那层说个大概。
 * @param {{ref: string, layer: string}[]} imps
 * @param {Map<string, {verdict: string}>} gated
 */
export function bestImpression(imps, gated) {
  const rank = (c) => {
    const g = gated.get(c.ref);
    if (!g) return -1;
    if (g.verdict === 'share') return c.layer === 'private' ? 4 : 3;
    if (g.verdict === 'share_vague') return c.layer === 'private' ? 2 : 1;
    return -1;
  };
  let best = null;
  for (const c of imps) {
    const r = rank(c);
    if (r > 0 && (!best || r > best.r)) best = { r, ref: c.ref, gate: gated.get(c.ref) };
  }
  return best;
}
