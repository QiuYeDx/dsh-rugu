// 分层印象（§5.2「印象分层」「八卦的来源分开」、§7.7 第 5 步）。
//   - 每层（shared 大家都看得到的 / private 私下的）是一个带规范的记忆单元，和别的记忆一样逐条过关口①；
//   - 每次都从事实**重新**生成（consolidate），这里只负责存：旧版本 is_current=0，新版本继承证据里最严的规范、登记嵌入文本；
//   - impressionSources 给重新生成挑证据：只看「主体是他」的事实（「A 说 B 很懒」只进 B 的听说，A 的印象不因这句话的内容改变），
//     shared 只用他本人当众说的和大家当场都看到的，其余进 private；「本人」按权利层认，不按信念层认。
import { refOf, parseRef } from '../store/index.js';
import { getEntity, bump, warn, errName } from './records.js';
import { sameGroup } from './links.js';
import { defaultAt } from '../config/defaults.js';

const LAYERS = new Set(['shared', 'private']);

/** 印象文本切块（记忆层嵌入，超过上限按段落 / 句子切，带上是谁的印象）。 */
function chunks(core, entity, text) {
  const max = core.config.get().segment?.chunk?.maxChars ?? defaultAt('segment.chunk.maxChars');
  const label = entity.display_name ?? '';
  const head = label ? `${label}: ` : '';
  const room = Math.max(50, max - head.length);
  const out = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i += room) out.push(chars.slice(i, i + room).join(''));
  return out.map((t, i) => ({ chunkNo: i, kind: /** @type {'text'} */ ('text'), text: head + t }));
}

/**
 * 写一层新的印象。见 index.js 的 writeImpression()。
 * @returns {number}
 */
export function writeImpression(core, entityId, layer, imp) {
  if (!LAYERS.has(layer)) throw new TypeError('entities.writeImpression：layer 应为 shared / private');
  if (!imp || typeof imp.text !== 'string' || !imp.text.trim()) throw new TypeError('entities.writeImpression：text 不能为空');
  const at = Number.isFinite(imp.at) ? imp.at : core.now();
  const text = imp.text.trim();
  const refs = [...new Set((Array.isArray(imp.evidenceRefs) ? imp.evidenceRefs : []).filter((r) => parseRef(r) !== null))];
  const derivation = imp.derivation === 'inference' ? 'inference' : 'quote';
  const firstHand = Math.max(0, Math.floor(Number(imp.firstHand) || 0));
  const hearsay = Math.max(0, Math.floor(Number(imp.hearsay) || 0));
  return core.store.tx(() => {
    const entity = getEntity(core, entityId);
    if (!entity) throw new TypeError('entities.writeImpression：实体不存在');
    const cur = core.store.get('SELECT id, text, evidence_ids_json, derivation FROM entity_impressions WHERE entity_id = ? AND layer = ? AND is_current = 1', entityId, layer);
    // 内容、证据都没变：不新建版本
    if (cur && cur.text === text && cur.derivation === derivation && cur.evidence_ids_json === JSON.stringify(refs)) return cur.id;
    const v = (core.store.get('SELECT MAX(version) AS v FROM entity_impressions WHERE entity_id = ? AND layer = ?', entityId, layer)?.v ?? 0) + 1;
    if (cur) core.store.run('UPDATE entity_impressions SET is_current = 0 WHERE id = ?', cur.id);
    const r = core.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, evidence_ids_json, first_hand, hearsay, derivation,
        version, is_current, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, entityId, layer, text, JSON.stringify(refs), firstHand, hearsay, derivation, v, at);
    const id = Number(r.lastInsertRowid);
    const ref = { kind: /** @type {'impression'} */ ('impression'), id };
    // 规范：继承证据里最严的（§5.6 派生内容）。规范写不了就整条不写（回滚），不能有不带规范的印象
    core.mods.discretion.inheritNorm(core, ref, refs.map(parseRef), { derivation, at });
    try {
      core.mods.worker.enqueueEmbed(core, ref, chunks(core, entity, text), { layer: 'memory', priority: 2 });
    } catch (err) {
      bump(core, 'entities.embed.error');
      warn(core, 'entities.embed.error', { ref: refOf('impression', id), error: errName(err) });
    }
    if (cur) {
      // 旧版本只留作历史，不再参与回想：提交后删掉它的嵌入
      const old = { kind: /** @type {'impression'} */ ('impression'), id: cur.id };
      core.store.afterCommit(() => {
        try { core.mods.worker.dropEmbeddings(core, [old]); } catch (err) { bump(core, 'entities.embed.dropError'); warn(core, 'entities.embed.dropError', { error: errName(err) }); }
      });
    }
    bump(core, `entities.impression.${layer}`);
    return id;
  });
}

/**
 * 重新生成一个人的印象时该用哪些事实（§5.2、§7.7 第 5 步）。只看「主体是他」的、没被取代的事实：
 *   - firstHand：断言者就是他本人（权利层认定的同一个人），或者是大家当场看到的（mode='observed'）；
 *   - shared：firstHand 且来源是在不止两个人的场合当众（visible_to = setting-audience）；
 *   - private：其余的（一对一里得到的、听别人说的、她自己推断的）。
 * 他自己说别人的话（他是说话人、主体是别人）不在这里：八卦只进被说的人名下。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} entityId
 * @param {{limit?: number}} [opt]
 */
export function impressionSources(core, entityId, opt = {}) {
  const limit = Math.max(1, Math.min(1000, opt.limit ?? 200));
  const empty = { shared: [], private: [], counts: { shared: { firstHand: 0, hearsay: 0 }, private: { firstHand: 0, hearsay: 0, inferred: 0 } } };
  if (!getEntity(core, entityId)) return empty;
  const subjects = [...sameGroup(core, entityId)];            // 认成同一个人的档案一起算（信念层的 same）
  const self = sameGroup(core, entityId, { rights: true });   // 「本人说的」只认权利层
  const ph = subjects.map(() => '?').join(',');
  const facts = core.store.all(`SELECT DISTINCT a.id FROM assertion_entities ae JOIN assertions a ON a.id = ae.assertion_id
      WHERE ae.entity_id IN (${ph}) AND ae.role = 'subject' AND a.superseded_by IS NULL ORDER BY a.id DESC LIMIT ?`, ...subjects, limit).map((r) => r.id);
  if (!facts.length) return empty;
  let hidden = new Set();
  try { hidden = core.mods.admin.suppressedRefs(core, facts.map((id) => refOf('assertion', id))); } catch (err) {
    warn(core, 'entities.impressionSources.suppressedRefs', { error: errName(err) });
  }
  const exposure = new Map();
  const exposureOf = (snapshotId) => {
    if (!Number.isInteger(snapshotId)) return -1;
    if (!exposure.has(snapshotId)) {
      let rank = -1;
      try { rank = core.mods.intake.snapshotById(core, snapshotId)?.exposureRank ?? -1; } catch { rank = -1; }
      exposure.set(snapshotId, rank);
    }
    return exposure.get(snapshotId);
  };
  const out = { shared: [], private: [], counts: { shared: { firstHand: 0, hearsay: 0 }, private: { firstHand: 0, hearsay: 0, inferred: 0 } } };
  for (const id of facts) {
    const ref = refOf('assertion', id);
    if (hidden.has(ref)) continue;
    const sources = core.store.all("SELECT percept_id, speaker, asserter, mode FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", id);
    let firstHand = false;
    let shared = false;
    let inferred = sources.length > 0;
    for (const s of sources) {
      const by = s.asserter ?? s.speaker;
      const own = (Number.isInteger(by) && self.has(by)) || s.mode === 'observed';
      if (s.mode !== 'inferred' && s.mode !== 'self_generated') inferred = false;
      if (!own) continue;
      firstHand = true;
      if (Number.isInteger(s.percept_id)) {
        const p = core.store.get('SELECT visible_to, snapshot_id FROM percepts WHERE id = ?', s.percept_id);
        // 当众：这条感知当时是场合的受众都看得到的，而且这个场合不是一对一（exposure ≥ 1）。快照读不到时按不当众算（宁严）
        if (p && p.visible_to === 'setting-audience' && exposureOf(p.snapshot_id) >= 1) shared = true;
      }
    }
    const item = { ref, firstHand, hearsay: !firstHand && !inferred, inferred: !firstHand && inferred };
    if (shared) { out.shared.push(item); out.counts.shared.firstHand += 1; } else {
      out.private.push(item);
      if (item.firstHand) out.counts.private.firstHand += 1;
      else if (item.inferred) out.counts.private.inferred += 1;
      else out.counts.private.hearsay += 1;
    }
  }
  return out;
}
