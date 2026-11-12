// 修补以前留下的「假人」和重复的档案（D108、D160）：把现在认人的规矩用到已经存下来的档案上。启动时跑，她有了新名字时也跑；幂等、有上限。
//   1. 撤掉：从没说过话、没有任何身份证据（账号、same 链接、关系描述）的档案里——
//      a. 每个名字都不到 2 个字（「@我」）；
//      b. 每个名字都是她自己或有管理权限的人在同一场合（或不限场合）的名字；
//      c. 只有名字的提及造出来的（D160：「@名字」只是一个名字，不是这个人存在的证据）：名字全是名片（name_kind = 'card'，
//         只有名字的 ActorRef 就是这样记的），而且没有任何别的东西指着它。有东西指着它、而它的名字正好是这个场合里一个有账号的人的
//         平台名 → 不撤，和那个人挂 same（信念层）；否则不动。
//   2. 重复的档案：从没说过话、没有身份证据和关系描述、名字全是话里来的（别人叫的 name_kind = 'mention'，或「@名字」留下的
//      'card'——提炼后来又把名字挂到了「@名字」造出来的档案上的，两种都有），而名字正好是同一场合里
//      一个有账号的人的平台名（名片 / 昵称）→ 和他挂 same（信念层，decidedBy = 'extractor'）。不撤：可能已经有事实挂在它上面，
//      sameGroup 在回想和人物卡里会把两个档案并起来。
// 不按 id 写死任何一个。
import { bump, DECIDER_RANK } from './records.js';
import { entityParams } from './params.js';
import { link, linkRow } from './links.js';

/** 一次最多看多少个候选档案（启动时跑，不让一个很大的库拖慢启动；剩下的下次启动再看）。 */
const MAX_CANDIDATES = 2000;

/** 档案自己的状况（不算「别的东西指着它」）：从没说过话、没有账号证据、没有关系描述。 */
const BARE = `e.status <> 'retracted' AND e.is_self = 0 AND e.authority = 'none'
  AND NOT EXISTS (SELECT 1 FROM percepts p WHERE p.actor_entity_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM identity_evidence v WHERE v.entity_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM entity_descriptors d WHERE d.entity_id = e.id)
  AND EXISTS (SELECT 1 FROM entity_names n WHERE n.entity_id = e.id)`;

/**
 * @returns {{retracted: number, linked: number}}
 */
export function repairMentionGhosts(core) {
  if (core.readOnly) return { retracted: 0, linked: 0 };
  const P = entityParams(core);
  let retracted = 0;
  let linked = 0;
  core.store.tx(() => {
    const retract = (id) => {
      core.store.run("UPDATE entities SET status = 'retracted', updated_at = ? WHERE id = ?", core.now(), id);
      retracted += 1;
    };
    // ── 1. 撤掉假人
    const cands = core.store.all(`SELECT e.id FROM entities e WHERE ${BARE} AND e.kind = 'person'
        AND NOT EXISTS (SELECT 1 FROM entity_links l WHERE (l.a = e.id OR l.b = e.id) AND l.rel = 'same')
        ORDER BY e.id LIMIT ${MAX_CANDIDATES}`);
    const products = [];
    for (const { id } of cands) {
      const names = core.store.all('SELECT text_raw, text_norm, scope_setting_key AS scope, name_kind FROM entity_names WHERE entity_id = ?', id);
      const short = names.every((x) => [...String(x.text_raw ?? '').trim()].length < 2);
      const reserved = names.every((x) => !!core.store.get(`SELECT 1 AS x FROM entity_names n JOIN entities e ON e.id = n.entity_id
          WHERE n.text_norm = ? AND e.id <> ? AND (e.is_self = 1 OR e.authority <> 'none') AND e.status <> 'retracted'
            AND (e.is_self = 1 OR n.scope_setting_key = ? OR n.scope_setting_key = '' OR ? = '') LIMIT 1`, x.text_norm, id, x.scope, x.scope));
      if (short || reserved) { retract(id); continue; }
      if (names.every((x) => x.name_kind === 'card')) products.push({ id, names });
    }
    if (products.length) {
      const used = referenced(core, products.map((p) => p.id));
      for (const p of products) {
        if (!used.has(p.id)) { retract(p.id); continue; }
        // 有东西指着它：名字正好是这里一个有账号的人的平台名 → 认成他（信念层）；否则不动
        const target = platformHolder(core, p.id, p.names);
        if (target && linkSame(core, p.id, target, P)) linked += 1;
      }
    }
    // ── 2. 重复的档案（提炼造出来的，或者提炼接着用了「@名字」造出来的那个）
    // 它和别的档案之间已有的链接不拦着（夜里常把两份重复档案先互相认成同一个，却都没挂到本人身上）；
    // 它和本人之间已经有决定的，由 linkSame 按这一对来看
    const dups = core.store.all(`SELECT e.id FROM entities e WHERE ${BARE} AND e.kind IN ('person', 'unknown')
        AND NOT EXISTS (SELECT 1 FROM entity_names n WHERE n.entity_id = e.id AND n.name_kind NOT IN ('mention', 'card'))
        ORDER BY e.id LIMIT ${MAX_CANDIDATES}`);
    for (const { id } of dups) {
      const names = core.store.all('SELECT text_norm, scope_setting_key AS scope FROM entity_names WHERE entity_id = ?', id);
      const target = platformHolder(core, id, names);
      if (target && linkSame(core, id, target, P)) linked += 1;
    }
  });
  if (retracted) bump(core, 'entities.ghost.retracted', retracted);
  if (linked) bump(core, 'entities.ghost.linked', linked);
  return { retracted, linked };
}

/**
 * 名字（每一行都）是同一场合里同一个有账号的人的平台名（名片 / 账号昵称，同一个场合键，不限场合的不算）→ 他的 id；
 * 对不上、对上好几个人、对上她自己或有管理权限的人 → null。
 */
function platformHolder(core, id, names) {
  let target = null;
  for (const x of names) {
    if (!x.scope) return null;
    const rows = core.store.all(`SELECT DISTINCT n.entity_id AS id FROM entity_names n JOIN entities e ON e.id = n.entity_id
        WHERE n.text_norm = ? AND n.scope_setting_key = ? AND n.name_kind IN ('card', 'account') AND n.spoof = 0
          AND e.id <> ? AND e.status <> 'retracted' AND e.is_self = 0 AND e.authority = 'none'
          AND EXISTS (SELECT 1 FROM identity_evidence v WHERE v.entity_id = e.id) LIMIT 2`, x.text_norm, x.scope, id);
    if (rows.length !== 1) return null;
    if (target != null && target !== rows[0].id) return null;
    target = rows[0].id;
  }
  return target;
}

/**
 * 挂 same（信念层）。两个档案之间已经有 same / not_same，或者有比提炼高一级的决定（夜间整理的 maybe_same 等）→ 不挂（低一级的决定不推翻高一级的）。
 * @returns {boolean} 挂上了
 */
function linkSame(core, a, b, P) {
  const ex = linkRow(core, a, b);
  if (ex && (ex.rel !== 'maybe_same' || DECIDER_RANK[ex.decided_by] > DECIDER_RANK.extractor)) return false;
  link(core, a, b, { rel: 'same', confidence: P.scores.platformNameHere, evidence: ['platform-name'], decidedBy: 'extractor', at: core.now() });
  return true;
}

/**
 * 这几个档案里，哪些有别的东西指着（事实、情节、意图、关系描述的锚点、印象、链接、谁知道、规则、规范、来源、场合、出现集合、社区、
 * 隐藏、需要你知道、分寸日志、审核、发言配额、转发人）。名字和痕迹、嵌入（档案自己的账目）、感知里的提及记录（造出它的那一处）不算。
 * 一处查询出错就当全都有东西指着（宁可不撤）。
 * @param {number[]} ids
 * @returns {Set<number>}
 */
function referenced(core, ids) {
  const out = new Set();
  const list = JSON.stringify(ids);
  const IN = 'IN (SELECT value FROM json_each(?))';
  const queries = [
    `SELECT entity_id AS id FROM assertion_entities WHERE entity_id ${IN}`,
    `SELECT object_entity_id AS id FROM assertions WHERE object_entity_id ${IN}`,
    `SELECT plan_agent AS id FROM assertions WHERE plan_agent ${IN}`,
    `SELECT CAST(j.value AS INTEGER) AS id FROM episodes, json_each(episodes.participants_json) j WHERE j.value ${IN}`,
    `SELECT target_entity_id AS id FROM intentions WHERE target_entity_id ${IN}`,
    `SELECT anchor_entity_id AS id FROM entity_descriptors WHERE anchor_entity_id ${IN}`,
    `SELECT speaker_entity_id AS id FROM entity_descriptors WHERE speaker_entity_id ${IN}`,
    `SELECT entity_id AS id FROM entity_impressions WHERE entity_id ${IN}`,
    `SELECT a AS id FROM entity_links WHERE a ${IN}`,
    `SELECT b AS id FROM entity_links WHERE b ${IN}`,
    `SELECT CAST(who_ref AS INTEGER) AS id FROM known_by WHERE who_kind = 'entity' AND who_ref IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
    `SELECT CAST(json_extract(target_json, '$.entityId') AS INTEGER) AS id FROM rules WHERE CAST(json_extract(target_json, '$.entityId') AS INTEGER) ${IN}`,
    `SELECT CAST(substr(created_by, 9) AS INTEGER) AS id FROM rules WHERE created_by LIKE 'subject:%' AND CAST(substr(created_by, 9) AS INTEGER) ${IN}`,
    `SELECT CAST(j.value AS INTEGER) AS id FROM flow_norms, json_each(COALESCE(flow_norms.allow_json, '[]')) j WHERE j.value ${IN}`,
    `SELECT CAST(j.value AS INTEGER) AS id FROM flow_norms, json_each(COALESCE(flow_norms.deny_json, '[]')) j WHERE j.value ${IN}`,
    `SELECT owner_id AS id FROM flow_norms WHERE owner_kind = 'entity' AND owner_id ${IN}`,
    `SELECT speaker AS id FROM sources WHERE speaker ${IN}`,
    `SELECT asserter AS id FROM sources WHERE asserter ${IN}`,
    `SELECT entity_id AS id FROM settings WHERE entity_id ${IN}`,
    `SELECT author_entity_id AS id FROM setting_rules WHERE author_entity_id ${IN}`,
    `SELECT CAST(j.value AS INTEGER) AS id FROM presence_sets, json_each(presence_sets.members_json) j WHERE j.value ${IN}`,
    `SELECT CAST(j.value AS INTEGER) AS id FROM communities, json_each(communities.members_json) j WHERE j.value ${IN}`,
    `SELECT owner_id AS id FROM suppressions WHERE owner_kind = 'entity' AND owner_id ${IN}`,
    `SELECT source_entity_id AS id FROM need_to_know WHERE source_entity_id ${IN}`,
    `SELECT owner_id AS id FROM need_to_know WHERE owner_kind = 'entity' AND owner_id ${IN}`,
    `SELECT trigger_entity_id AS id FROM discretion_log WHERE trigger_entity_id ${IN}`,
    `SELECT subject_entity_id AS id FROM discretion_log WHERE subject_entity_id ${IN}`,
    `SELECT CAST(json_extract(payload_json, '$.a') AS INTEGER) AS id FROM review_queue WHERE status = 'pending' AND CAST(json_extract(payload_json, '$.a') AS INTEGER) ${IN}`,
    `SELECT CAST(json_extract(payload_json, '$.b') AS INTEGER) AS id FROM review_queue WHERE status = 'pending' AND CAST(json_extract(payload_json, '$.b') AS INTEGER) ${IN}`,
    `SELECT entity_id AS id FROM speaker_quota WHERE entity_id ${IN}`,
    `SELECT CAST(json_extract(forwarded_json, '$.relayedById') AS INTEGER) AS id FROM percepts WHERE forwarded_json IS NOT NULL
       AND CAST(json_extract(forwarded_json, '$.relayedById') AS INTEGER) ${IN}`,
  ];
  for (const q of queries) {
    let rows;
    try { rows = core.store.all(q, list); } catch {
      bump(core, 'entities.ghost.refCheckError');
      return new Set(ids);
    }
    for (const r of rows) if (Number.isInteger(r.id)) out.add(r.id);
  }
  return out;
}
