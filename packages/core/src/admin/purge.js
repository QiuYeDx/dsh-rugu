// 彻底删除、墓碑、按来源撤回（§12.7、§12.4.5 第 5 步、§12.4.8；级联表见 docs/实现/模块与接口.md §2.3）。
// 这是唯一允许跨拥有者删行的地方。顺序固定，每一步分批、可中断、可重跑：
//   1. 操作前快照（backup.preOperationSnapshot reason='purge'）；
//   2. 按来源链找派生（encode.derivedFrom）：只靠它作证据的一起删，其余的事实标 needs_review；
//      情节的叙述是整段派生出来的，删掉其中一条来源就删掉整个情节，把剩下的感知放回切分缓冲重新提炼（「有其他证据的重新评估」）；
//      含被删内容的印象、故事线、社区摘要也删掉，夜里从剩下的事实重新生成——摘要里不能留着删掉的话；
//      社区（D143）：被删的人、事实涉及的人、情节的参与者和场合所在的社区，当前的、退休的、跨场合的都算；
//   3. 计划写进 meta 'admin.purge.pending'（中途崩溃，下次启动时 reapplyTombstones 接着做完，结果一致）；
//   4. **先删向量**（worker.dropEmbeddings），再删主库：主表行 + FTS 行 + 规范 + 谁知道 + 告诉过谁 + 痕迹 + 来源 + 评估记录……
//      删除期间 secure_delete 打开，删掉的内容不留在数据库页里；含被删感知的原文窗口交给 intake.dropFromWindows 重新渲染
//      （一条成员都不剩的整个删掉），和第一批删除在同一个事务里，所以窗口里不会留着已经删掉的原话；
//      解开的备份副本上没有 intake，含被删感知的窗口整个删掉；
//      最后一个事务里清成长块（D143）：依据里有被删内容的行，从当前文本和全部历史版本里抹掉（consolidate.purgeGrowth），
//      成长的审核项抹掉提议的文字；全文索引开 secure-delete，删的时候词元就从索引页里抹掉；
//   5. 写墓碑（kind = owner_kind，ref = 记忆引用；身份证据 kind='identity'，ref = id_hash；感知另记 kind='obs'，
//      ref = 适配器 + ext_key，这样恢复后从来源补回、或者平台重发同一条消息时，删掉的消息不会回来）；
//   6. 主库、向量库各做一次截断式的 WAL 检查点（WAL 里删除之前的旧页清掉，D143）；
//   7. 返回注入过这些记忆的会话（「已经注入过的文字收不回」）；勾了「连备份一起删」时带回每个包改写没改写成（D143）。
// 墓碑按时间生效：只删墓碑时间之前就有的行。恢复旧包之后新写入的行可能复用同一个 id，那是新的记忆，不该被删。
import { ContractError } from '../contract/errors.js';
import { parseRef, refOf, OWNER_TABLES } from '../store/refs.js';
import { ftsDelete, ftsOptimize, enableFtsSecureDelete } from '../store/fts.js';
import { getMetaJson, setMetaJson, setMeta, bumpMetric } from '../store/kv.js';
import { suppress, restore, settleCascades } from './suppress.js';
import { hasTable, hasColumn, derivedOf, windowsContaining, parseIds, CREATED } from './derive.js';
import { residentDirty, namesChanged } from './notify.js';
import { param } from './params.js';

const DAY = 86_400_000;
const ORDER = ['impression', 'storyline', 'community', 'link', 'intention', 'assertion', 'episode', 'window', 'entity', 'percept'];
const SHARD_RE = /^percepts_fts_\d{6}$/;
const PENDING = 'admin.purge.pending';
const bad = (what, path, message) => new ContractError(what, [{ path, message }]);

// ── 小工具 ────────────────────────────────────────────────────────────────

const run = (db, table, sql, ...p) => (hasTable(db, table) ? Number(db.run(sql, ...p).changes) : 0);
// 只在这一列存在时才跑（旧版本做的备份包里可能还没有这一列，比如迁移 014 之前的 glances.follows）
const runIf = (db, table, col, sql, ...p) => (hasColumn(db, table, col) ? Number(db.run(sql, ...p).changes) : 0);
const jsonList = (a) => JSON.stringify([...a]);
export const obsTombRef = (adapter, extKey) => `${adapter}:${extKey}`;

/** 【D143】成员里有这些人的社区（不管当前还是退休、挂在哪个场合下）。 */
function communitiesOf(db, entityIds, push) {
  const ids = [...new Set(entityIds.filter((x) => Number.isSafeInteger(x)))];
  if (!ids.length || !hasTable(db, 'communities')) return;
  for (const c of db.all(`SELECT id FROM communities WHERE EXISTS (SELECT 1 FROM json_each(communities.members_json) j
                          WHERE j.value IN (SELECT value FROM json_each(?)))`, JSON.stringify(ids))) push('community', c.id);
}

function principalIds(core, db) {
  if (db === core.store) { try { return new Set(core.mods.entities.principals(core)); } catch { /* 退回 SQL */ } }
  return new Set(db.all("SELECT id FROM entities WHERE authority = 'principal'").map((r) => r.id));
}

// ── 第 2 步：展开要删的集合 ─────────────────────────────────────────────────

/**
 * @param {object} core
 * @param {import('../store/db.js').Store} db
 * @param {string[]} refs
 * @param {{guard?: boolean, rebuildWindows?: boolean}} [opt]   guard=true：拒绝删她自己和主人的档案（主人发起的彻底删除）。主库上用 encode.derivedFrom 找派生。
 *        rebuildWindows=true（主库）：含被删感知的原文窗口不算要删的单元，记在 windows 里，执行时交给 intake 重新渲染
 * @returns {{units: string[], review: number[], release: number[], windows: number[]}}   windows：含被删感知的原文窗口
 */
export function expandPlan(core, db, refs, opt = {}) {
  const units = new Set();
  const review = new Set();
  const release = new Set();
  // 有别的证据的派生（还要看那些证据是不是也在这次删的范围里）：记忆引用 → 它的证据感知 id
  const partial = new Map();
  // 从感知找到的原文窗口只删窗口本身（或交给 intake 重新渲染）；直接删一个窗口时，窗口里的消息一起删
  const windowViaPercept = new Set();
  const touched = new Set();
  const queue = [...refs];
  const live = db === core.store;
  const principals = opt.guard ? principalIds(core, db) : new Set();
  const derive = (pid) => derivedOf(core, db, pid);
  const rebuild = live && !!opt.rebuildWindows;
  const exists = (m) => hasTable(db, OWNER_TABLES[m.kind]) && !!db.get(`SELECT 1 FROM ${OWNER_TABLES[m.kind]} WHERE id = ?`, m.id);
  const push = (kind, id) => { const r = refOf(kind, id); if (!units.has(r)) queue.push(r); };
  const evidenceOf = (dm) => {
    if (dm.kind === 'intention') {
      const t = db.get('SELECT sources_json FROM intentions WHERE id = ?', dm.id);
      let src = [];
      try { src = JSON.parse(t?.sources_json ?? '[]'); } catch { src = []; }
      return Array.isArray(src) ? src : [];
    }
    if (!hasTable(db, 'sources')) return [null];
    return db.all('SELECT percept_id AS p FROM sources WHERE owner_kind = ? AND owner_id = ?', dm.kind, dm.id).map((r) => r.p);
  };
  const drain = () => {
    while (queue.length) {
      const ref = queue.pop();
      if (units.has(ref)) continue;
      const m = parseRef(ref);
      if (!m || !exists(m)) continue;
      if (m.kind === 'entity' && opt.guard) {
        const e = db.get('SELECT is_self FROM entities WHERE id = ?', m.id);
        if (e?.is_self || principals.has(m.id)) throw bad('purge', 'refs', '不能彻底删除她自己或主人的档案');
      }
      units.add(ref);
      switch (m.kind) {
        case 'percept': {
          for (const d of derive(m.id) ?? []) {
            const dm = parseRef(d.ref);
            if (!dm) continue;
            // 情节的叙述是整段派生出来的：删掉其中一条来源就删掉整个情节，其余感知放回切分缓冲重新提炼
            if (d.onlySource || dm.kind === 'episode') queue.push(d.ref);
            else partial.set(d.ref, dm);
          }
          for (const wid of windowsContaining(db, m.id)) {
            touched.add(wid);
            if (rebuild) continue;
            windowViaPercept.add(wid);
            push('window', wid);
          }
          if (hasTable(db, 'intentions')) {
            for (const t of db.all('SELECT id FROM intentions WHERE EXISTS (SELECT 1 FROM json_each(intentions.sources_json) j WHERE j.value = ?)', m.id)) {
              partial.set(refOf('intention', t.id), { kind: 'intention', id: t.id });
            }
          }
          break;
        }
        case 'window':
          if (!windowViaPercept.has(m.id)) for (const p of db.all('SELECT id FROM percepts WHERE window_id = ?', m.id)) push('percept', p.id);
          break;
        case 'episode': {
          const e = db.get('SELECT setting_key, participants_json FROM episodes WHERE id = ?', m.id);
          for (const p of db.all('SELECT id FROM percepts WHERE episode_id = ?', m.id)) release.add(p.id);
          // 这个场合的故事线、社区摘要可能写着删掉的内容：一起删，夜里从剩下的情节重新生成
          if (e && hasTable(db, 'storylines')) for (const s of db.all('SELECT id FROM storylines WHERE setting_key = ?', e.setting_key)) push('storyline', s.id);
          if (e && hasTable(db, 'communities')) {
            // 【D143】当前的、退休的都算（退休的行和摘要还在库里）；跨场合的（场合键为空）按参与者找
            for (const c of db.all('SELECT id FROM communities WHERE setting_key = ?', e.setting_key)) push('community', c.id);
            communitiesOf(db, parseIds(e.participants_json), push);
          }
          break;
        }
        case 'assertion':
          if (hasTable(db, 'intentions')) for (const t of db.all("SELECT id FROM intentions WHERE about_kind = 'assertion' AND about_id = ?", m.id)) push('intention', t.id);
          // 【D143】社区摘要是按成员的事实写的：这条事实涉及的人所在的社区（当前的、退休的、跨场合的）一起删，夜里重新生成
          if (hasTable(db, 'communities')) {
            const ids = db.all('SELECT entity_id AS id FROM assertion_entities WHERE assertion_id = ?', m.id).map((r) => r.id);
            const obj = hasColumn(db, 'assertions', 'object_entity_id') ? db.get('SELECT object_entity_id AS id FROM assertions WHERE id = ?', m.id)?.id : null;
            communitiesOf(db, obj != null ? [...ids, obj] : ids, push);
          }
          break;
        case 'entity': {
          for (const i of db.all('SELECT id FROM entity_impressions WHERE entity_id = ?', m.id)) push('impression', i.id);
          for (const l of db.all('SELECT id FROM entity_links WHERE a = ? OR b = ?', m.id, m.id)) push('link', l.id);
          if (hasTable(db, 'intentions')) for (const t of db.all('SELECT id FROM intentions WHERE target_entity_id = ?', m.id)) push('intention', t.id);
          // 关于他的事实：只有他是主体 / 对象的一起删；顺带提到他的标 needs_review
          for (const a of db.all(`SELECT ae.assertion_id AS id,
                                    (SELECT count(*) FROM assertion_entities x WHERE x.assertion_id = ae.assertion_id AND x.role IN ('subject','object') AND x.entity_id <> ?) AS others,
                                    max(ae.role IN ('subject','object')) AS core
                                  FROM assertion_entities ae WHERE ae.entity_id = ? GROUP BY ae.assertion_id`, m.id, m.id)) {
            if (a.core && Number(a.others) === 0) push('assertion', a.id); else review.add(a.id);
          }
          communitiesOf(db, [m.id], push);
          break;
        }
        default: break;
      }
      // 摘要类（印象）里引用了被删记忆的，一起删（夜里从剩下的事实重新生成）
      if (hasTable(db, 'entity_impressions')) {
        for (const i of db.all('SELECT id FROM entity_impressions WHERE EXISTS (SELECT 1 FROM json_each(entity_impressions.evidence_ids_json) j WHERE j.value = ?)', ref)) push('impression', i.id);
      }
    }
  };
  // 一直展开到不动为止：有几条证据的派生，证据全在这次删的范围里（比如按来源撤回同一个人的好几句话）就一起删，
  // 只要还有一条别的证据就留着、标复核（事实）或不动（意图）
  for (;;) {
    drain();
    const deletedP = new Set([...units].map(parseRef).filter((x) => x.kind === 'percept').map((x) => x.id));
    let more = false;
    for (const [ref, dm] of partial) {
      if (units.has(ref)) { partial.delete(ref); continue; }
      const ev = evidenceOf(dm);
      if (ev.length && ev.every((p) => p != null && deletedP.has(Number(p)))) { queue.push(ref); partial.delete(ref); more = true; }
    }
    if (!more) break;
  }
  for (const [, dm] of partial) if (dm.kind === 'assertion') review.add(dm.id);
  const unitIds = (kind) => new Set([...units].map(parseRef).filter((x) => x.kind === kind).map((x) => x.id));
  const deletedA = unitIds('assertion');
  const deletedP = unitIds('percept');
  const ordered = [...units].sort((a, b) => ORDER.indexOf(parseRef(a).kind) - ORDER.indexOf(parseRef(b).kind));
  return { units: ordered, review: [...review].filter((id) => !deletedA.has(id)), release: [...release].filter((id) => !deletedP.has(id)),
    windows: [...touched].sort((a, b) => a - b) };
}

// ── 第 4、5 步：删一个记忆单元 ─────────────────────────────────────────────

/**
 * 删一个记忆单元和挂在它身上的全部行（在调用方的事务里调用，同步）。返回要写的墓碑。
 * @param {import('../store/db.js').Store} db
 * @param {{kind: string, id: number}} m
 * @returns {{kind: string, ref: string}[]}
 */
export function deleteUnit(db, m) {
  const ref = refOf(/** @type {any} */ (m.kind), m.id);
  const tombs = [{ kind: m.kind, ref }];
  const k = m.kind;
  const id = m.id;
  // 所有记忆单元共有的
  for (const t of ['flow_norms', 'known_by', 'told_log', 'traces', 'activation', 'suppressions', 'embed_texts', 'sources']) {
    run(db, t, `DELETE FROM ${t} WHERE owner_kind = ? AND owner_id = ?`, k, id);
  }
  run(db, 'appraisals', 'DELETE FROM appraisals WHERE memory_kind = ? AND memory_id = ?', k, id);
  run(db, 'discretion_log', 'DELETE FROM discretion_log WHERE memory_kind = ? AND memory_id = ?', k, id);
  run(db, 'need_to_know', "UPDATE need_to_know SET status = 'withdrawn' WHERE owner_kind = ? AND owner_id = ? AND status <> 'withdrawn'", k, id);
  run(db, 'mood', `UPDATE mood SET cause_ids_json = (SELECT json_group_array(j.value) FROM json_each(mood.cause_ids_json) j WHERE j.value <> ?)
                   WHERE EXISTS (SELECT 1 FROM json_each(mood.cause_ids_json) j WHERE j.value = ?)`, ref, ref);
  switch (k) {
    case 'percept': {
      const p = db.get('SELECT fts_shard, adapter, ext_key FROM percepts WHERE id = ?', id);
      if (p?.fts_shard && SHARD_RE.test(p.fts_shard) && hasTable(db, p.fts_shard)) ftsDelete(db, p.fts_shard, id);
      if (p) tombs.push({ kind: 'obs', ref: obsTombRef(p.adapter, p.ext_key) });
      run(db, 'sources', 'UPDATE sources SET percept_id = NULL WHERE percept_id = ?', id);
      run(db, 'glances', 'DELETE FROM glances WHERE percept_id = ?', id);
      runIf(db, 'glances', 'replaces', 'UPDATE glances SET replaces = NULL WHERE replaces = ?', id);
      runIf(db, 'glances', 'follows', 'UPDATE glances SET follows = NULL WHERE follows = ?', id);
      run(db, 'percepts', 'UPDATE percepts SET target_id = NULL WHERE target_id = ?', id);
      run(db, 'percepts', 'UPDATE percepts SET relay_of = NULL WHERE relay_of = ?', id);
      run(db, 'relays', 'UPDATE relays SET matched_percept = NULL WHERE matched_percept = ?', id);
      run(db, 'utterances', 'UPDATE utterances SET matched_percept = NULL WHERE matched_percept = ?', id);
      run(db, 'plan_status_history', 'UPDATE plan_status_history SET evidence_percept = NULL WHERE evidence_percept = ?', id);
      // 夜里核对时给模型看过它的（D122，引用了的和只是看过的都算）：理由可能转述了它，一起删（只是少一条核对记录，下次照样会再核）
      run(db, 'memory_checks', `DELETE FROM memory_checks WHERE EXISTS (SELECT 1 FROM json_each(memory_checks.evidence_json) j WHERE j.value = ?)
                                OR EXISTS (SELECT 1 FROM json_each(memory_checks.shown_json) j WHERE j.value = ?)`, id, id);
      run(db, 'percepts', 'DELETE FROM percepts WHERE id = ?', id);
      break;
    }
    case 'window':
      run(db, 'percepts', 'UPDATE percepts SET window_id = NULL WHERE window_id = ?', id);
      run(db, 'raw_windows', 'DELETE FROM raw_windows WHERE id = ?', id);
      break;
    case 'episode':
      if (hasTable(db, 'episodes_fts')) ftsDelete(db, 'episodes_fts', id);
      run(db, 'sources', "DELETE FROM sources WHERE owner_kind = 'episode' AND owner_id = ?", id);
      run(db, 'assertions', 'UPDATE assertions SET plan_outcome_ref = NULL WHERE plan_outcome_ref = ?', ref);
      run(db, 'episodes', 'DELETE FROM episodes WHERE id = ?', id);
      break;
    case 'assertion':
      if (hasTable(db, 'assertions_fts')) ftsDelete(db, 'assertions_fts', id);
      run(db, 'assertion_entities', 'DELETE FROM assertion_entities WHERE assertion_id = ?', id);
      run(db, 'same_type', 'DELETE FROM same_type WHERE a = ? OR b = ?', id, id);
      run(db, 'plan_status_history', 'DELETE FROM plan_status_history WHERE assertion_id = ?', id);
      run(db, 'sources', "DELETE FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", id);
      run(db, 'assertions', 'UPDATE assertions SET supersedes = NULL WHERE supersedes = ?', id);
      run(db, 'assertions', 'UPDATE assertions SET superseded_by = NULL WHERE superseded_by = ?', id);
      run(db, 'assertions', 'UPDATE assertions SET plan_outcome_ref = NULL WHERE plan_outcome_ref = ?', ref);
      run(db, 'intentions', "UPDATE intentions SET about_kind = NULL, about_id = NULL WHERE about_kind = 'assertion' AND about_id = ?", id);
      run(db, 'memory_checks', 'DELETE FROM memory_checks WHERE assertion_id = ? OR result_id = ? OR restored_id = ?', id, id, id);   // D122：核对记录跟着事实走
      run(db, 'assertions', 'DELETE FROM assertions WHERE id = ?', id);
      break;
    case 'entity': {
      for (const r of hasTable(db, 'identity_evidence') ? db.all('SELECT id_hash FROM identity_evidence WHERE entity_id = ?', id) : []) tombs.push({ kind: 'identity', ref: r.id_hash });
      run(db, 'identity_evidence', 'DELETE FROM identity_evidence WHERE entity_id = ?', id);
      run(db, 'entity_names', 'DELETE FROM entity_names WHERE entity_id = ?', id);
      run(db, 'entity_descriptors', 'DELETE FROM entity_descriptors WHERE entity_id = ? OR anchor_entity_id = ?', id, id);
      run(db, 'entity_links', 'DELETE FROM entity_links WHERE a = ? OR b = ?', id, id);
      run(db, 'entity_impressions', 'DELETE FROM entity_impressions WHERE entity_id = ?', id);
      run(db, 'assertion_entities', 'DELETE FROM assertion_entities WHERE entity_id = ?', id);
      run(db, 'assertions', 'UPDATE assertions SET object_entity_id = NULL WHERE object_entity_id = ?', id);
      run(db, 'assertions', 'UPDATE assertions SET plan_agent = NULL WHERE plan_agent = ?', id);
      run(db, 'settings', 'UPDATE settings SET entity_id = NULL WHERE entity_id = ?', id);
      run(db, 'intentions', 'UPDATE intentions SET target_entity_id = NULL WHERE target_entity_id = ?', id);
      run(db, 'known_by', "DELETE FROM known_by WHERE who_kind = 'entity' AND who_ref = ?", String(id));
      // 他说过的话（感知、来源）留着，但不再指向一个已经不存在的人：变成「有人说过」
      run(db, 'percepts', 'UPDATE percepts SET actor_entity_id = NULL WHERE actor_entity_id = ?', id);
      run(db, 'sources', 'UPDATE sources SET speaker = NULL WHERE speaker = ?', id);
      run(db, 'sources', 'UPDATE sources SET asserter = NULL WHERE asserter = ?', id);
      run(db, 'entities', 'DELETE FROM entities WHERE id = ?', id);
      break;
    }
    case 'impression': run(db, 'entity_impressions', 'DELETE FROM entity_impressions WHERE id = ?', id); break;
    case 'intention':
      run(db, 'sources', "DELETE FROM sources WHERE owner_kind = 'intention' AND owner_id = ?", id);
      run(db, 'intentions', 'DELETE FROM intentions WHERE id = ?', id);
      break;
    case 'storyline': run(db, 'storylines', 'DELETE FROM storylines WHERE id = ?', id); break;
    case 'community': run(db, 'communities', 'DELETE FROM communities WHERE id = ?', id); break;
    case 'link': run(db, 'entity_links', 'DELETE FROM entity_links WHERE id = ?', id); break;
    default: break;
  }
  return tombs;
}

function writeTombs(db, tombs, at) {
  for (const t of tombs) db.run('INSERT OR IGNORE INTO tombstones(kind, ref, at) VALUES (?, ?, ?)', t.kind, t.ref, at);
}

/** 剩下的：有其他来源的事实标 needs_review；被删情节的其他感知放回切分缓冲（按回填处理，不会冒出过期的意图）。 */
function finishSideEffects(db, plan) {
  if (plan.review.length && hasColumn(db, 'assertions', 'needs_review')) {
    db.run('UPDATE assertions SET needs_review = 1 WHERE id IN (SELECT value FROM json_each(?))', jsonList(plan.review));
  }
  if (plan.release.length && hasTable(db, 'percepts')) {
    const hist = hasColumn(db, 'percepts', 'historical') ? ', historical = 1' : '';
    db.run(`UPDATE percepts SET episode_id = NULL${hist} WHERE id IN (SELECT value FROM json_each(?))`, jsonList(plan.release));
  }
}

/**
 * 主库上含被删感知的原文窗口（§2.3 第 4 步）：交给 intake 把这些感知从成员里拿掉、重新渲染，一条不剩的整个删掉（它先删这些窗口的向量）。
 * intake 只删窗口那一行：被它删掉的窗口身上挂的规范、谁知道、痕迹、激活、隐藏这些行由这里照删除单元的规矩清掉，并写墓碑。
 * 在第一批删除的事务里调用：窗口不会比感知晚改，中途崩溃重跑时这一步是空操作（已经不在的窗口再清一遍也一样；
 * 同一个 id 已经被新窗口用了的不碰）。intake 做不了就退回整窗删除——宁可多删几个窗口，也不留下已经删掉的原话。
 * @returns {{deleted: number, tombs: {kind: string, ref: string}[]}}
 */
function dropPerceptsFromWindows(core, tx, perceptIds, windows) {
  try {
    tx.tx(() => core.mods.intake.dropFromWindows(core, perceptIds));
    let deleted = 0;
    const tombs = [];
    for (const id of windows ?? []) {
      if (tx.get('SELECT 1 FROM raw_windows WHERE id = ?', id)) continue;   // 重新渲染了（或者 id 已经是新窗口的）
      tombs.push(...deleteUnit(tx, { kind: 'window', id }));
      deleted += 1;
    }
    return { deleted, tombs };
  } catch (e) {
    core.log.warn('admin.purge-windows-fallback', { error: e?.code ?? e?.name ?? 'Error' });
    bumpMetric(core.store, 'admin.purge.windowsFallback');
    let deleted = 0;
    const tombs = [];
    for (const id of windows ?? []) {
      if (!tx.get('SELECT 1 FROM raw_windows WHERE id = ?', id)) continue;
      try { core.mods.worker.dropEmbeddings(core, [{ kind: 'window', id }]); } catch { /* 向量库是缓存：嵌入文本跟着删，清扫会清走孤立的向量 */ }
      tombs.push(...deleteUnit(tx, { kind: 'window', id }));
      deleted += 1;
    }
    return { deleted, tombs };
  }
}

/** PRAGMA secure_delete 的读数（0 / 1 / 2）→ 设回去用的值。 */
const SECURE = ['OFF', 'ON', 'FAST'];

/**
 * 【D143】删掉的记忆可能写进了别的派生文字里，按引用找不到的部分在这里清：
 *   - 成长块：依据里有被删内容的行，从当前文本和全部历史版本里抹掉（consolidate.purgeGrowth）；
 *     这次删了经历或事实时，判断不了来历的行也去掉（宁可多去一行成长，不留被删的内容）；
 *   - 成长的审核项（逐条批准方式）：依据里有被删内容的，提议的文字抹掉，还挂着的撤下（withdrawn）。
 * gone = 这次删的单元（删除时间 at）+ 这个库墓碑表里以前删的（墓碑按时间生效：比墓碑晚的依据指向的是新写入的行）。
 * 在调用方的事务里调用。
 * @returns {{growthLines: number, growthVersions: number, reviews: number}}
 */
function scrubDerivedText(core, db, units, at, { removeUnknown }) {
  const gone = units.map((ref) => ({ ref, at }));
  if (hasTable(db, 'tombstones')) for (const t of db.all('SELECT ref, at FROM tombstones')) gone.push({ ref: t.ref, at: t.at });
  const goneAt = new Map();
  for (const g of gone) goneAt.set(g.ref, Math.max(goneAt.get(g.ref) ?? -Infinity, g.at));
  let reviews = 0;
  if (hasTable(db, 'review_queue')) {
    for (const r of db.all("SELECT id, payload_json, status, created_at FROM review_queue WHERE kind = 'growth'")) {
      let p;
      try { p = JSON.parse(r.payload_json ?? '{}'); } catch { p = {}; }
      const ev = Array.isArray(p?.evidenceRefs) ? p.evidenceRefs : [];
      if (!ev.some((x) => typeof x === 'string' && goneAt.has(x) && goneAt.get(x) >= r.created_at) || p?.change?.purged) continue;
      const change = { op: p?.change?.op ?? null, before: null, after: null, signature: `purged:review:${r.id}`, purged: true };
      const payload = JSON.stringify({ ...p, change, ...(p && 'text' in p ? { text: null } : {}) });
      if (r.status === 'pending') db.run("UPDATE review_queue SET payload_json = ?, status = 'withdrawn', decided_at = ?, decided_by = 'purge' WHERE id = ?", payload, at, r.id);
      else db.run('UPDATE review_queue SET payload_json = ? WHERE id = ?', payload, r.id);
      reviews += 1;
    }
  }
  const g = core.mods.consolidate.purgeGrowth(core, db, { gone, removeUnknown, clearPending: reviews > 0, by: 'owner', at });
  return { growthLines: g.removed, growthVersions: g.versions, growthUnknown: g.unknown ?? 0, reviews };
}

/**
 * 在给定的库上执行一个计划（主库或备份副本）。每批一个事务；secure_delete 打开，全文索引的 secure-delete 打开（D143）。
 * live=true（主库）：第一批的事务里先让 intake 重新渲染含被删感知的原文窗口。
 * 最后一个事务里清成长块和成长的审核项（scrubDerivedText），和收尾的副作用在一起。
 * @returns {{deleted: Record<string, number>, tombstones: {kind: string, ref: string, at: number}[], scrubbed: {growthLines: number, growthVersions: number, reviews: number}}}
 */
function executePlan(core, db, plan, { at, batch, live = false }) {
  const deleted = {};
  const written = [];
  let scrubbed = { growthLines: 0, growthVersions: 0, reviews: 0 };
  const perceptIds = live ? plan.units.map(parseRef).filter((m) => m?.kind === 'percept').map((m) => m.id) : [];
  let windowsDone = !perceptIds.length;
  const prevSecure = Number(db.pragma('secure_delete'));
  try { db.exec('PRAGMA secure_delete = ON'); } catch { /* 不支持就算了 */ }
  // 解开的备份副本（旧版本做的包）上表还没开 secure-delete：先开，删掉的词元才不会留在索引页里等以后合并
  const fts = enableFtsSecureDelete(db);
  if (fts.failed) core.log.warn('admin.purge-fts-secure-delete', { failed: fts.failed });
  // 这次会删到行的 FTS 表（删完 optimize 一次：词在段里没有行了，词本身也不留）
  const ftsTouched = new Set();
  for (const ref of plan.units) {
    const m = parseRef(ref);
    if (m?.kind === 'episode') ftsTouched.add('episodes_fts');
    else if (m?.kind === 'assertion') ftsTouched.add('assertions_fts');
    else if (m?.kind === 'percept' && hasTable(db, 'percepts')) {
      const sh = db.get('SELECT fts_shard FROM percepts WHERE id = ?', m.id)?.fts_shard;
      if (sh && SHARD_RE.test(sh)) ftsTouched.add(sh);
    }
  }
  try {
    for (let i = 0; i < plan.units.length; i += batch) {
      const chunk = plan.units.slice(i, i + batch);
      let windowsDeleted = 0;
      db.tx((tx) => {
        if (!windowsDone) {
          const w = dropPerceptsFromWindows(core, tx, perceptIds, plan.windows);
          windowsDeleted = w.deleted;
          if (w.tombs.length && hasTable(tx, 'tombstones')) writeTombs(tx, w.tombs, at);
          for (const t of w.tombs) written.push({ ...t, at });
        }
        for (const ref of chunk) {
          const m = parseRef(ref);
          if (!m) continue;
          const existed = hasTable(tx, OWNER_TABLES[m.kind]) && !!tx.get(`SELECT 1 FROM ${OWNER_TABLES[m.kind]} WHERE id = ?`, m.id);
          const tombs = deleteUnit(tx, m);
          if (existed) deleted[m.kind] = (deleted[m.kind] ?? 0) + 1;
          if (hasTable(tx, 'tombstones')) writeTombs(tx, tombs, at);
          for (const t of tombs) written.push({ ...t, at });
        }
      });
      if (!windowsDone) {
        windowsDone = true;
        if (windowsDeleted) deleted.window = (deleted.window ?? 0) + windowsDeleted;
      }
    }
    let ftsFailed = 0;
    for (const t of ftsTouched) {
      if (!hasTable(db, t)) continue;
      try { ftsOptimize(db, t); } catch { ftsFailed += 1; }
    }
    if (ftsFailed) {
      // 行已经删了、查不到了；只是词元可能还在索引页里，等夜里的小步合并。记下来，看得见
      core.log.warn('admin.purge-fts-optimize-failed', { failed: ftsFailed });
      bumpMetric(core.store, 'admin.purge.ftsOptimizeFailed', ftsFailed);
    }
    // 判断不了来历的行（整块替换写进来的，多半是主人自己手写的）不去掉：原来删任何一段经历、一条事实都会把它们全去掉，
    // 等于删一句话就清空主人手写的成长块。改成留着、把行数报给主人（管理页提示他自己看一眼）
    const removeUnknown = false;
    db.tx((tx) => {
      finishSideEffects(tx, plan);
      scrubbed = scrubDerivedText(core, tx, plan.units, at, { removeUnknown });
    });
  } finally {
    try { db.exec(`PRAGMA secure_delete = ${SECURE[prevSecure] ?? 'FAST'}`); } catch { /* 尽力 */ }
  }
  return { deleted, tombstones: written, scrubbed };
}

/** 注入过这些记忆的会话（注入日志里只有 id，没有正文）。 */
function injectedSessions(core, refs) {
  if (!hasTable(core.store, 'injections') || !refs.length) return [];
  const out = new Set();
  for (let i = 0; i < refs.length; i += 500) {
    const list = jsonList(refs.slice(i, i + 500));
    for (const r of core.store.all(`SELECT DISTINCT i.session_id AS s FROM injections i, json_each(i.items_json) j
                                    WHERE json_extract(j.value, '$.id') IN (SELECT value FROM json_each(?))`, list)) out.add(r.s);
  }
  return [...out];
}

/**
 * 主库上删完之后：来源被删掉的级联隐藏重新定（重新渲染过的窗口放开，还复述着删掉内容的留着）；档案、名字、身份证据改过就让
 * 名字匹配器重建；常驻区标脏（人物卡、计划里可能有删掉的东西）。
 */
function afterLiveDelete(core, plan, identityDeleted = 0, scrubbed = null) {
  const units = plan.units ?? [];
  if (units.length) {
    const rebuilt = (plan.windows ?? []).filter((id) => core.store.get('SELECT 1 FROM raw_windows WHERE id = ?', id)).map((id) => refOf('window', id));
    try { settleCascades(core, units, rebuilt); } catch (e) {
      core.log.warn('admin.purge-cascades-failed', { error: e?.code ?? e?.name ?? 'Error' });
    }
  }
  if (identityDeleted || units.some((r) => parseRef(r)?.kind === 'entity')) namesChanged(core);
  if (units.length || identityDeleted || scrubbed?.growthLines) residentDirty(core);
}

/**
 * 【D143】删完以后让删掉的内容在文件里也不在：主库和向量库各做一次截断式的 WAL 检查点（TRUNCATE）。
 * WAL 里还留着删除之前那些页的旧副本；检查点把抹过的页写回主文件，再把 WAL 截成 0 字节。
 * 有读者（worker 的只读连接）正读着旧快照时做不完：等到忙等超时（几秒）为止，做不完的记下来（busy）、照实告诉主人；
 * 旧页留在日志文件里，等下一次彻底删除再截断，或者关库时最后一个连接把日志写回、删掉。
 * @returns {{main: 'truncated'|'busy'|'skipped', vectors: 'truncated'|'busy'|'skipped'}}
 */
function truncateWal(core) {
  const one = (store) => {
    if (!store || store.readOnly || store.closed) return 'skipped';
    try {
      const r = store.checkpoint('TRUNCATE');
      return r && Number(r.busy) === 0 ? 'truncated' : 'busy';
    } catch { return 'busy'; }
  };
  const out = { main: one(core.store), vectors: one(core.vectors) };
  if (out.main === 'busy' || out.vectors === 'busy') {
    core.log.warn('admin.purge-wal-busy', out);
    bumpMetric(core.store, 'admin.purge.walBusy');
  }
  return out;
}

/** 向量库在彻底删除期间也打开 secure_delete = ON（平时是 FAST）：删掉的向量连同放回空闲列表的页一起抹掉。返回恢复用的函数。 */
function secureVectors(core) {
  const v = core.vectors;
  if (!v || v.readOnly || v.closed) return () => {};
  let prev;
  try { prev = Number(v.pragma('secure_delete')); v.exec('PRAGMA secure_delete = ON'); } catch { return () => {}; }
  return () => { try { v.exec(`PRAGMA secure_delete = ${SECURE[prev] ?? 'FAST'}`); } catch { /* 尽力 */ } };
}

async function runLivePlan(core, plan, ctx) {
  const batch = param(core, 'admin.purgeBatch');
  const restoreVectors = secureVectors(core);
  let r;
  try {
    // 先删向量，再删主库（§12.7）。worker 不可用就停下（计划留着，下次启动接着做）
    const mrefs = plan.units.map(parseRef).filter(Boolean);
    if (mrefs.length) core.mods.worker.dropEmbeddings(core, mrefs);
    r = executePlan(core, core.store, { windows: [], ...plan }, { at: ctx.at, batch, live: true });
  } finally { restoreVectors(); }
  setMeta(core.store, PENDING, null);
  afterLiveDelete(core, plan, 0, r.scrubbed);
  return r;
}

/**
 * 彻底删除（只给主人）。
 * @param {object} core
 * @param {string[]} refs
 * @param {{by: string, alsoBackups?: boolean, at: number}} ctx
 * @returns {Promise<{deleted: Record<string, number>, sessions: string[], growth: {lines: number, versions: number, unknown: number},
 *                    wal: {main: string, vectors: string}, backups?: {rewritten: number, unchanged: number, failed: number, failures: {id: number|null, reason: string}[]}}>}
 *   growth：从成长块去掉的行、抹过的历史版本（D143）；wal：截断式检查点做没做成；backups：勾了「连备份一起删」时每个包的结果
 */
export async function purge(core, refs, ctx) {
  if (!Array.isArray(refs) || !refs.length || refs.some((r) => !parseRef(r))) throw bad('purge', 'refs', '应为非空的记忆引用列表');
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  // 操作前快照：按来源撤回批准后的删除记成 'withdraw'，其余 'purge'（§12.4.2）
  await core.mods.backup.preOperationSnapshot(core, { reason: ctx?.reason === 'withdraw' ? 'withdraw' : 'purge' });
  const plan = expandPlan(core, core.store, [...new Set(refs)], { guard: true, rebuildWindows: true });
  setMetaJson(core.store, PENDING, { plan, at, by: String(ctx?.by ?? 'owner').slice(0, 40), alsoBackups: !!ctx?.alsoBackups });
  const r = await runLivePlan(core, plan, { at });
  // 注入过的原文窗口也算：窗口重新渲染了，但当时注入的文字里有这条
  const sessions = injectedSessions(core, [...plan.units, ...plan.windows.map((id) => refOf('window', id))]);
  bumpMetric(core.store, 'admin.purge', plan.units.length);
  core.log.info('admin.purged', { units: plan.units.length, review: plan.review.length, released: plan.release.length, sessions: sessions.length });
  const out = { deleted: r.deleted, sessions, growth: { lines: r.scrubbed.growthLines, versions: r.scrubbed.growthVersions,
    // 这次删了经历或事实时，成长块里还有几行判断不了是不是由被删内容写出来的（没有动）
    unknown: plan.units.some((x) => ['episode', 'assertion'].includes(parseRef(x)?.kind)) ? r.scrubbed.growthUnknown : 0 } };
  if (ctx?.alsoBackups) out.backups = await scrubBackups(core, r.tombstones);
  // 最后做：之前的计数、备份登记这些写入也进了 WAL（里面没有内容），一起截掉
  out.wal = truncateWal(core);
  return out;
}

/**
 * 【D143】「连备份一起删」：交给 backup.scrubPacks 重写每个包，把结果带回去（几个改写了、几个没改成、为什么）。
 * 整个调用失败也算没改成，不当成功；没改成的记日志和计数。
 */
async function scrubBackups(core, tombstones) {
  let s;
  try { s = await core.mods.backup.scrubPacks(core, { tombstones }); } catch (e) {
    const reason = e?.code ?? e?.name ?? 'Error';
    core.log.warn('admin.purge-backups-failed', { error: reason });
    s = { rewritten: 0, failed: 1, skipped: 0, failures: [{ id: null, reason }] };
  }
  const failures = Array.isArray(s?.failures) ? s.failures.map((f) => ({ id: f?.id ?? null, reason: String(f?.reason ?? 'error').slice(0, 60) })) : [];
  const failed = Math.max(Number(s?.failed) || 0, failures.length);
  if (failed) {
    core.log.warn('admin.purge-backups-incomplete', { failed, rewritten: Number(s?.rewritten) || 0 });
    bumpMetric(core.store, 'admin.purge.backupsFailed', failed);
  }
  return { rewritten: Number(s?.rewritten) || 0, unchanged: Number(s?.skipped) || 0, failed, failures };
}

// ── 墓碑重删 ──────────────────────────────────────────────────────────────

/** 墓碑 → 现在库里还在、而且是墓碑之前就有的行（新写入的同 id 行不算）。 */
function targetsOf(db, tombstones) {
  const refs = new Set();
  const identity = [];
  const byKind = new Map();
  const obs = [];
  for (const t of tombstones) {
    if (t.kind === 'identity') { identity.push(t); continue; }
    if (t.kind === 'obs') { obs.push(t); continue; }
    const m = parseRef(t.ref);
    if (!m || m.kind !== t.kind) continue;
    if (!byKind.has(m.kind)) byKind.set(m.kind, []);
    byKind.get(m.kind).push({ id: m.id, at: t.at });
  }
  for (const [kind, list] of byKind) {
    const table = OWNER_TABLES[kind];
    if (!hasTable(db, table)) continue;
    const col = hasColumn(db, table, CREATED[kind]) ? CREATED[kind] : null;
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const at = new Map(chunk.map((x) => [x.id, x.at]));
      const rows = db.all(`SELECT id${col ? `, ${col} AS c` : ''} FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, jsonList(chunk.map((x) => x.id)));
      for (const r of rows) if (!col || r.c == null || r.c <= at.get(r.id)) refs.add(refOf(kind, r.id));
    }
  }
  if (identity.length && hasTable(db, 'identity_evidence')) {
    for (const t of identity) {
      for (const r of db.all('SELECT entity_id, created_at FROM identity_evidence WHERE id_hash = ?', t.ref)) {
        if (r.created_at <= t.at) refs.add(`identity:${t.ref}`);
      }
    }
  }
  if (obs.length && hasTable(db, 'percepts')) {
    for (const t of obs) {
      const i = t.ref.indexOf(':');
      if (i <= 0) continue;
      for (const r of db.all('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', t.ref.slice(0, i), t.ref.slice(i + 1))) refs.add(refOf('percept', r.id));
    }
  }
  return [...refs];
}

/**
 * 在任意一个库上按墓碑再删一遍（主库或备份副本；同步）。备份副本上不碰向量库和 worker。
 * @returns {{deleted: number, tombstones: {kind: string, ref: string, at: number}[]}}
 */
export function applyTombstonesTo(core, db, tombstones, opt = {}) {
  const live = db === core.store;
  // 先把墓碑记进这个库（换回来的旧库里没有之后的墓碑）：删到一半停了，下次启动按墓碑表接着删，不会丢
  if (tombstones.length && hasTable(db, 'tombstones')) {
    db.tx((tx) => { for (const t of tombstones) tx.run('INSERT OR IGNORE INTO tombstones(kind, ref, at) VALUES (?, ?, ?)', t.kind, t.ref, t.at); });
  }
  const targets = targetsOf(db, tombstones);
  const idTargets = targets.filter((r) => r.startsWith('identity:'));
  const unitTargets = targets.filter((r) => !r.startsWith('identity:'));
  const plan = unitTargets.length ? expandPlan(core, db, unitTargets, { rebuildWindows: live }) : { units: [], review: [], release: [], windows: [] };
  if (live && opt.dropVectors !== false && plan.units.length) {
    const restoreVectors = secureVectors(core);
    try { core.mods.worker.dropEmbeddings(core, plan.units.map(parseRef)); } catch (e) {
      // 向量库是缓存：嵌入文本跟着主库一起删掉，下次清扫会把孤立的向量清走
      core.log.warn('admin.tombstones-vectors-deferred', { error: e?.code ?? e?.name ?? 'Error' });
    } finally { restoreVectors(); }
  }
  const at = core.now();
  let r = { deleted: {}, tombstones: [], scrubbed: { growthLines: 0, growthVersions: 0, reviews: 0 } };
  if (plan.units.length) r = executePlan(core, db, plan, { at, batch: param(core, 'admin.purgeBatch'), live });
  else if (tombstones.length) {
    // 没有要删的行了，成长块里可能还留着以前删掉的内容写出来的行（D143 之前的彻底删除不清成长块；换回来的旧包）：照墓碑再清一遍
    try { db.tx((tx) => { r.scrubbed = scrubDerivedText(core, tx, [], at, { removeUnknown: false }); }); } catch (e) {
      core.log.warn('admin.tombstones-growth-failed', { error: e?.code ?? e?.name ?? 'Error' });
    }
  }
  // 成长块里抹掉的也算删掉的（备份包据此判断要不要重写）
  let deleted = Object.values(r.deleted).reduce((a, b) => a + b, 0) + r.scrubbed.growthLines + r.scrubbed.growthVersions + r.scrubbed.reviews;
  let idDeleted = 0;
  if (idTargets.length) {
    const idAt = new Map(tombstones.filter((x) => x.kind === 'identity').map((x) => [x.ref, x.at]));
    db.tx((tx) => {
      for (const ref of idTargets) {
        const h = ref.slice('identity:'.length);
        idDeleted += Number(tx.run('DELETE FROM identity_evidence WHERE id_hash = ? AND created_at <= ?', h, idAt.get(h) ?? at).changes);
      }
    });
    deleted += idDeleted;
  }
  if (live) afterLiveDelete(core, plan, idDeleted, r.scrubbed);
  return { deleted, tombstones: r.tombstones };
}

/**
 * 按墓碑再删一遍（每次启动时、恢复备份后）。先把上次没做完的彻底删除做完。
 * @returns {Promise<{deleted: number}>}
 */
export async function reapplyTombstones(core, opt = {}) {
  let deleted = 0;
  const pending = getMetaJson(core.store, PENDING, null);
  if (pending?.plan) {
    const r = await runLivePlan(core, pending.plan, { at: pending.at ?? core.now() });
    deleted += Object.values(r.deleted).reduce((a, b) => a + b, 0);
    core.log.info('admin.purge-resumed', { units: pending.plan.units.length });
  }
  const list = opt.tombstones ?? core.store.all('SELECT kind, ref, at FROM tombstones ORDER BY id');
  if (list.length) deleted += applyTombstonesTo(core, core.store, list).deleted;
  if (deleted) {
    core.log.info('admin.tombstones-reapplied', { deleted });
    truncateWal(core);
  }
  return { deleted };
}

/** 一批 (adapter, ext_key) 里哪些是被彻底删除过的消息（intake 入库前问：删掉的消息补回或重发时不再入库）。 */
export function tombstonedObs(core, adapter, extKeys) {
  const out = new Set();
  const keys = [...new Set(extKeys ?? [])];
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const refs = jsonList(chunk.map((k) => obsTombRef(adapter, k)));
    for (const r of core.store.all("SELECT ref FROM tombstones WHERE kind = 'obs' AND ref IN (SELECT value FROM json_each(?))", refs)) {
      out.add(r.ref.slice(adapter.length + 1));
    }
  }
  return out;
}

// ── 按来源撤回（§12.7） ────────────────────────────────────────────────────

/**
 * 某人在某段时间提供的全部内容和由它们派生的记忆 → 先对别人隐藏、进审核队列，主人批准后彻底删除；驳回就恢复原样。
 * @returns {{reviewId: number, refs: number}}
 */
/**
 * 某人在某段时间提供的内容（撤回的起点；派生的由 expandPlan 顺着来源链展开）：他说的每条感知，加上没有原始感知、
 * 只靠他在这段时间提供的记忆（导入的、原文已经删掉的）。
 * @param {object} core
 * @param {{entityId: number, from?: number, to?: number}} q
 * @returns {string[]}
 */
export function withdrawRefs(core, q) {
  const from = Number.isFinite(q.from) ? q.from : 0;
  const to = Number.isFinite(q.to) ? q.to : core.now();
  const refs = core.store.all('SELECT id FROM percepts WHERE actor_entity_id = ? AND at >= ? AND at <= ? ORDER BY id', q.entityId, from, to).map((r) => refOf('percept', r.id));
  for (const r of core.store.all(`SELECT owner_kind AS k, owner_id AS id FROM sources s WHERE speaker = ? AND at >= ? AND at <= ? AND percept_id IS NULL
                                  AND NOT EXISTS (SELECT 1 FROM sources o WHERE o.owner_kind = s.owner_kind AND o.owner_id = s.owner_id
                                                  AND (o.speaker IS NOT ? OR o.at < ? OR o.at > ? OR o.percept_id IS NOT NULL))
                                  GROUP BY owner_kind, owner_id`, q.entityId, from, to, q.entityId, from, to)) {
    refs.push(refOf(r.k, r.id));
  }
  return refs;
}

export function withdrawBySource(core, q) {
  if (!Number.isSafeInteger(q?.entityId) || q.entityId <= 0) throw bad('withdrawBySource', 'entityId', '应为实体 id');
  const from = Number.isFinite(q.from) ? q.from : 0;
  const to = Number.isFinite(q.to) ? q.to : core.now();
  if (to < from) throw bad('withdrawBySource', 'from/to', '时间范围不对');
  const at = Number.isFinite(q.at) ? q.at : core.now();
  const refs = withdrawRefs(core, { entityId: q.entityId, from, to });
  const plan = refs.length ? expandPlan(core, core.store, refs, { guard: true, rebuildWindows: true }) : { units: [], review: [], release: [], windows: [] };
  const counts = {};
  for (const r of plan.units) { const k = parseRef(r).kind; counts[k] = (counts[k] ?? 0) + 1; }
  const reviewId = core.mods.admin.enqueueReview(core, {
    kind: 'withdraw',
    payload: { entityId: q.entityId, from, to, refs, counts, review: plan.review.length },
    reason: 'withdraw-by-source',
  });
  // 审核期间先对别人隐藏（驳回时按这个标记恢复）；含这些消息的原文窗口、小结和日记由隐藏的级联带上
  for (const ref of plan.units) {
    try {
      if (!core.store.get('SELECT 1 FROM suppressions WHERE owner_kind = ? AND owner_id = ?', parseRef(ref).kind, parseRef(ref).id)) {
        suppress(core, ref, { state: 'hidden', by: 'owner', reason: `withdraw:${reviewId}`, at });
      }
    } catch { /* 已经不在了 */ }
  }
  core.log.info('admin.withdraw-queued', { reviewId, refs: refs.length, units: plan.units.length });
  return { reviewId, refs: refs.length };
}

/** 驳回按来源撤回：把审核期间隐藏的恢复原样。 */
export function undoWithdrawHide(core, reviewId, at) {
  let n = 0;
  for (const r of core.store.all('SELECT owner_kind AS k, owner_id AS id FROM suppressions WHERE reason = ?', `withdraw:${reviewId}`)) {
    try { restore(core, refOf(r.k, r.id), { by: 'owner', at }); n += 1; } catch { /* 忽略 */ }
  }
  return n;
}

export { DAY };
