// 成长块（§5.7、§17 Q4）：常驻区「成长」那一段。默认自动生效、每次变化存一个版本、主人可以撤销单条或回到任意旧版本；
// 也可以配置成逐条批准（sleep.growth.mode，只认配置，聊天里说的不算，§9.6）。
//   - 文本是若干行，每行一条自我概念；一次变化只动一行（add / revise / remove），每晚最多 maxChangesPerNight 处（「每次只改一点」）。
//   - 门槛（两种方式一样）：≥ 5 条证据、跨 ≥ 3 天、来自 ≥ 2 个不同的人或场合。证据必须是她自己的经历：
//     她参与的情节、她自己说的话、有权限的人关于她的说法。「需要你知道」里标过的（无权限者的指令和设定、污染、投毒）、
//     encode 记下的指令类记录（kind_hint='request'）和它们引用的感知（不管那条标记还在不在）、
//     带按轮污点的轮里她说的话、被隐藏或删掉的、她自己的推断，都不算（§5.7「这样别人没法靠反复灌输改掉她的性格」）。
//   - 成长块的文本变了（自动生效、主人批准 / 撤销 / 回滚）就给常驻区标脏（§10.4），提交之后才标。
//   - 一个人在几个群里反复说，算一个来源：来源按「对面是谁」算，没有对面的人才按场合算。
//   - 撤销过（或逐条批准时被驳回过）的同一变化，之后没有新证据（不在当初的依据里、而且比撤销晚）就不再写回。
import { parseRef } from '../store/index.js';
import { params } from './params.js';
import { charLen, jaccard, localDay, normText, safeJson, termSet, warn, metric, errCode, residentDirty } from './util.js';
import {
  selfId, sourcesOf, suppressedSet, flaggedSets, participantsOf, assertionEntities, principalIds, taintedTurnPercepts, authorityOf,
  directiveAssertions, directivePercepts,
} from './memory.js';

const NAME = 'growth';

/** @returns {{text: string, version: number}} */
export function growthBlock(core) {
  const r = core.store.get('SELECT text, version FROM core_blocks WHERE name = ?', NAME);
  return { text: r?.text ?? '', version: r?.version ?? 0 };
}

export const linesOf = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

/**
 * 规范化一处变化：{op: add|revise|remove, before?, after?}。不认识的返回 null。
 * @returns {{op: 'add'|'revise'|'remove', before: string|null, after: string|null}|null}
 */
export function normalizeChange(c) {
  if (!c || typeof c !== 'object') return null;
  const op = c.op;
  const before = typeof c.before === 'string' && c.before.trim() ? c.before.trim() : null;
  const after = typeof c.after === 'string' && c.after.trim() ? c.after.trim() : null;
  if (op === 'add' && after) return { op, before: null, after };
  if (op === 'revise' && before && after) return { op, before, after };
  if (op === 'remove' && before) return { op, before, after: null };
  return null;
}

const findLine = (lines, line) => lines.findIndex((l) => normText(l) === normText(line));

/** 把一处变化应用到文本上；应用不了（要改的那行已经不在了、要加的已经有了）返回 null。 */
export function applyChange(text, change) {
  const lines = linesOf(text);
  if (change.op === 'add') {
    if (findLine(lines, change.after) >= 0) return null;
    return [...lines, change.after].join('\n');
  }
  const i = findLine(lines, change.before);
  if (i < 0) return null;
  if (change.op === 'revise') lines[i] = change.after;
  else lines.splice(i, 1);
  return lines.join('\n');
}

const invert = (c) => (c.op === 'add' ? { op: 'remove', before: c.after, after: null }
  : c.op === 'remove' ? { op: 'add', before: null, after: c.before }
    : { op: 'revise', before: c.after, after: c.before });

const focusOf = (c) => (c.op === 'remove' ? c.before : c.after) ?? '';
export function signatureOf(c) {
  return `${c.op}:${normText(focusOf(c))}`;
}

/** 是不是「同一处变化」：同一种操作，内容相同或很像（换个说法不能绕过撤销）。 */
export function sameChange(core, a, b, sim) {
  if (!a || !b || a.op !== b.op) return false;
  const fa = focusOf(a);
  const fb = focusOf(b);
  if (normText(fa) && normText(fa) === normText(fb)) return true;
  return jaccard(termSet(core, fa), termSet(core, fb)) >= sim;
}

/**
 * 分析一组证据：哪些算数、跨几天、来自几个不同的来源。不信调用方（夜里的模型）说的，全部按库里的数据重算。
 * @returns {{valid: {ref: string, t: number, day: number, origin: string}[], excluded: {ref: string, why: string}[], days: number, origins: Set<string>}}
 */
export function analyzeEvidence(core, refs) {
  const self = selfId(core);
  const list = [...new Set((refs ?? []).filter((r) => typeof r === 'string'))];
  const flagged = flaggedSets(core);
  const suppressed = suppressedSet(core, list);
  const valid = [];
  const excluded = [];
  for (const ref of list) {
    const m = parseRef(ref);
    if (!m || (m.kind !== 'episode' && m.kind !== 'assertion')) { excluded.push({ ref, why: 'kind' }); continue; }
    if (suppressed.has(ref)) { excluded.push({ ref, why: 'suppressed' }); continue; }
    if (flagged.refs.has(ref)) { excluded.push({ ref, why: 'flagged' }); continue; }
    const srcs = sourcesOf(core, m.kind, m.id);
    if (srcs.some((s) => s.percept_id != null && flagged.percepts.has(s.percept_id))) { excluded.push({ ref, why: 'flagged' }); continue; }
    // 指令类：这条本身就是「X 提过一个要求」，或者它的来源里有被这种记录引用过的感知（S29）
    if ((m.kind === 'assertion' && directiveAssertions(core, [m.id]).size) || directivePercepts(core, srcs.map((s) => s.percept_id)).size) {
      excluded.push({ ref, why: 'directive' });
      continue;
    }
    if (taintedTurnPercepts(core, srcs.map((s) => s.percept_id)).size) { excluded.push({ ref, why: 'tainted-turn' }); continue; }
    let t;
    let setting = null;
    const people = new Map();
    const count = (id) => { if (Number.isInteger(id) && id !== self) people.set(id, (people.get(id) ?? 0) + 1); };
    if (m.kind === 'episode') {
      const e = core.store.get('SELECT id, ep_kind, setting_key, t_end, participants_json FROM episodes WHERE id = ?', m.id);
      if (!e) { excluded.push({ ref, why: 'missing' }); continue; }
      if (e.ep_kind !== 'event') { excluded.push({ ref, why: 'derived' }); continue; }
      const parts = participantsOf(e);
      const hers = parts.includes(self) || srcs.some((s) => s.actor_self === 1 || s.p_kind === 'content');
      if (!hers) { excluded.push({ ref, why: 'not-hers' }); continue; }
      t = e.t_end;
      setting = e.setting_key;
      for (const s of srcs) if (!s.actor_self) count(s.actor_entity_id);
      if (!people.size) for (const id of parts) count(id);
    } else {
      const a = core.store.get('SELECT id, certainty, recorded_at, event_start FROM assertions WHERE id = ?', m.id);
      if (!a) { excluded.push({ ref, why: 'missing' }); continue; }
      if (a.certainty === 'inferred') { excluded.push({ ref, why: 'inferred' }); continue; }
      const aboutSelf = assertionEntities(core, a.id).some((r) => r.entity_id === self && r.role === 'subject');
      const bySelf = a.certainty === 'self_said' || srcs.some((s) => s.speaker === self);
      // 别人关于她的说法只在说话人有管理权限时才算（按属性判断）：否则谁都能靠反复「你就是这样的」改掉她（§5.7、§9.6）
      const byAuthority = aboutSelf && (a.certainty === 'stated' || a.certainty === 'confirmed')
        && srcs.some((s) => s.speaker !== self && authorityOf(core, s.speaker) !== 'none');
      if (!bySelf && !byAuthority) { excluded.push({ ref, why: 'not-hers' }); continue; }
      t = srcs.find((s) => Number.isFinite(s.at))?.at ?? a.event_start ?? a.recorded_at;
      setting = srcs.find((s) => s.setting_key)?.setting_key ?? srcs.find((s) => s.perceived_in)?.perceived_in ?? null;
      for (const s of srcs) if (s.speaker !== self) count(s.speaker);
      // 她自己说的话：对面是谁看同一段对话里的其他人
      const eps = [...new Set(srcs.map((s) => s.episode_id).filter((x) => Number.isInteger(x)))];
      for (const ep of eps) {
        for (const r of core.store.all('SELECT actor_entity_id AS id, COUNT(*) AS n FROM percepts WHERE episode_id = ? AND actor_self = 0 AND actor_entity_id IS NOT NULL GROUP BY actor_entity_id', ep)) {
          if (r.id !== self) people.set(r.id, (people.get(r.id) ?? 0) + r.n);
        }
      }
    }
    if (!Number.isFinite(t)) { excluded.push({ ref, why: 'no-time' }); continue; }
    let origin;
    if (people.size) {
      const top = [...people.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
      origin = `p:${top}`;
    } else origin = `s:${setting ?? 'none'}`;
    valid.push({ ref, t, day: localDay(core, t), origin });
  }
  return { valid, excluded, days: new Set(valid.map((v) => v.day)).size, origins: new Set(valid.map((v) => v.origin)) };
}

/** 撤销过、或者逐条批准时被驳回过的同一变化，之后有没有新证据。 */
function blockedByHistory(core, change, ev, sim) {
  const prior = [];
  for (const r of core.store.all('SELECT change_json, evidence_ids, revoked_at FROM core_block_versions WHERE name = ? AND revoked_at IS NOT NULL', NAME)) {
    prior.push({ change: normalizeChange(safeJson(r.change_json, {})), evidence: safeJson(r.evidence_ids, []), at: r.revoked_at });
  }
  for (const r of core.store.all("SELECT payload_json, decided_at, created_at FROM review_queue WHERE kind = 'growth' AND status = 'rejected'")) {
    const p = safeJson(r.payload_json, {});
    prior.push({ change: normalizeChange(p.change), evidence: Array.isArray(p.evidenceRefs) ? p.evidenceRefs : [], at: r.decided_at ?? r.created_at });
  }
  for (const pr of prior) {
    if (!pr.change || !sameChange(core, pr.change, change, sim)) continue;
    const old = new Set(pr.evidence);
    const fresh = ev.valid.filter((v) => !old.has(v.ref) && v.t > (pr.at ?? 0));
    if (!fresh.length) return true;
  }
  return false;
}

function pendingSame(core, change, sim) {
  for (const r of core.store.all("SELECT payload_json FROM review_queue WHERE kind = 'growth' AND status = 'pending'")) {
    const c = normalizeChange(safeJson(r.payload_json, {}).change);
    if (c && sameChange(core, c, change, sim)) return true;
  }
  return false;
}

/** 在嵌套事务（SAVEPOINT）里做一件附带的事：失败只回滚它自己，不影响外层。 */
function sideEffect(core, what, fn) {
  try { return core.store.tx(fn); } catch (e) { warn(core, `${what}.failed`, { error: errCode(e) }); return undefined; }
}

function writeVersion(core, { text, change, evidence, by, at, charLimit, clearPending }) {
  return core.store.tx((db) => {
    const cur = growthBlock(core);
    const version = cur.version + 1;
    db.run(`INSERT INTO core_blocks(name, text, version, char_limit, updated_at, updated_by, pending_text) VALUES (?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(name) DO UPDATE SET text = excluded.text, version = excluded.version, char_limit = excluded.char_limit,
              updated_at = excluded.updated_at, updated_by = excluded.updated_by,
              pending_text = CASE WHEN ? THEN NULL ELSE core_blocks.pending_text END`,
    NAME, text, version, charLimit, at, by, clearPending);
    db.run(`INSERT INTO core_block_versions(name, version, text, change_json, evidence_ids, created_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, NAME, version, text, JSON.stringify(change), JSON.stringify(evidence), at, by);
    // 成长块在每个场合的常驻区里都有（§10.4）：全部标脏，等下一条真实消息再换上
    residentDirty(core);
    return version;
  });
}

/**
 * 应用一处成长变化（index.js 的 applyGrowth）。
 * change.text 是变化之后的整块文本；没给就把 change.change 应用到当前文本上（逐条批准时管理页只带结构化的变化）。
 * @returns {{version: number|null, queued: boolean, reason?: string}}
 */
export function applyGrowthImpl(core, change, ctx) {
  const p = params(core);
  const by = ctx?.by === 'owner' ? 'owner' : 'sleep';
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  const cur = growthBlock(core);
  const ch = normalizeChange(change?.change);
  let text = typeof change?.text === 'string' && change.text.trim() ? linesOf(change.text).join('\n') : null;
  if (text == null && ch) text = applyChange(cur.text, ch);
  if (text == null) return { version: null, queued: false, reason: 'stale' };
  if (linesOf(text).some((l) => charLen(l) > p.growth.lineChars) || charLen(text) > p.growth.charLimit) return { version: null, queued: false, reason: 'too-long' };
  if (text === cur.text) return { version: null, queued: false, reason: 'no-change' };
  const refs = [...new Set((change?.evidenceRefs ?? []).filter((r) => typeof r === 'string' && parseRef(r)))];
  const stored = { ...(ch ?? { op: 'replace', before: null, after: null }), signature: ch ? signatureOf(ch) : `replace:${normText(text)}` };

  if (by === 'owner') {
    // 主人在管理页批准（或自己改）：门槛在提议时已经查过；这里是主人的决定，直接生效
    const version = writeVersion(core, { text, change: stored, evidence: refs, by, at, charLimit: p.growth.charLimit, clearPending: true });
    metric(core, 'growth.owner');
    return { version, queued: false };
  }

  // 夜里自己归纳出的：照门槛重新核一遍
  if (!ch) return { version: null, queued: false, reason: 'bad-change' };
  const ev = analyzeEvidence(core, refs);
  if (ev.valid.length < p.selfConcept.minEvidence) return { version: null, queued: false, reason: 'too-little-evidence' };
  if (ev.days < p.selfConcept.minDays) return { version: null, queued: false, reason: 'too-few-days' };
  if (ev.origins.size < p.growth.minDistinctSources) return { version: null, queued: false, reason: 'single-source' };
  if (blockedByHistory(core, ch, ev, p.growth.sameChangeSim)) return { version: null, queued: false, reason: 'revoked-no-new-evidence' };
  if (pendingSame(core, ch, p.growth.sameChangeSim)) return { version: null, queued: false, reason: 'already-pending' };
  const evidence = ev.valid.map((v) => v.ref);
  const principals = new Set(principalIds(core).map((id) => `p:${id}`));
  const foreign = [...ev.origins].some((o) => !principals.has(o));

  if (p.growth.mode === 'approve') {
    // pending_text 只放最近一次提议的整块文本（管理页预览用）；每条审核项自己带着结构化的变化，批准时应用到当时的文本上
    core.store.tx((db) => {
      db.run(`INSERT INTO core_blocks(name, text, version, char_limit, updated_at, updated_by, pending_text) VALUES (?, '', 0, ?, ?, 'sleep', ?)
              ON CONFLICT(name) DO UPDATE SET pending_text = excluded.pending_text`, NAME, p.growth.charLimit, at, text);
      core.mods.admin.enqueueReview(core, {
        kind: 'growth',
        payload: { name: NAME, baseVersion: cur.version, change: stored, evidenceRefs: evidence },
        reason: 'growth-proposal',
      });
      if (foreign) sideEffect(core, 'growth.notify', () => core.mods.admin.notifyNeedToKnow(core, { kind: 'foreign_write', ref: null, reason: 'growth-proposal', severity: 1, at }));
    });
    metric(core, 'growth.queued');
    return { version: null, queued: true };
  }

  const version = core.store.tx(() => {
    const v = writeVersion(core, { text, change: stored, evidence, by, at, charLimit: p.growth.charLimit, clearPending: false });
    if (foreign) sideEffect(core, 'growth.notify', () => core.mods.admin.notifyNeedToKnow(core, { kind: 'foreign_write', ref: null, reason: `growth-v${v}`, severity: 1, at }));
    return v;
  });
  metric(core, 'growth.auto');
  return { version, queued: false };
}

function versionRow(core, version) {
  return core.store.get('SELECT * FROM core_block_versions WHERE name = ? AND version = ?', NAME, version);
}
const assertVersion = (v) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`成长块版本应为非负整数：${v}`);
};

/** 撤销单条变化：记下被撤销（之后同样的变化没有新证据不再写回），并从当前文本里把这处变化退掉，存成一个新版本。 */
export function revokeGrowthImpl(core, version, ctx) {
  assertVersion(version);
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  const by = String(ctx?.by ?? 'owner');
  core.store.tx((db) => {
    const row = versionRow(core, version);
    if (!row) throw new RangeError(`没有这个成长块版本：${version}`);
    if (row.revoked_at != null) return;
    db.run('UPDATE core_block_versions SET revoked_at = ?, revoked_by = ? WHERE name = ? AND version = ?', at, by, NAME, version);
    const cur = growthBlock(core);
    const ch = normalizeChange(safeJson(row.change_json, {}));
    let text = null;
    if (version === cur.version) {
      text = version > 1 ? (versionRow(core, version - 1)?.text ?? '') : '';
    } else if (ch) {
      text = applyChange(cur.text, invert(ch));
    }
    if (text == null || text === cur.text) return;
    writeVersion(core, { text, change: { op: 'revoke', of: version, before: null, after: null, signature: `revoke:${version}` }, evidence: [], by, at, charLimit: Math.max(params(core).growth.charLimit, [...text].length), clearPending: false });
  });
  metric(core, 'growth.revoke');
}

/** 一键回到任意旧版本（0 = 空）：之后的每处变化都记为被撤销。 */
export function rollbackGrowthImpl(core, toVersion, ctx) {
  assertVersion(toVersion);
  const at = Number.isFinite(ctx?.at) ? ctx.at : core.now();
  const by = String(ctx?.by ?? 'owner');
  core.store.tx((db) => {
    const cur = growthBlock(core);
    if (toVersion > cur.version) throw new RangeError(`没有这个成长块版本：${toVersion}`);
    if (toVersion === cur.version) return;
    const target = toVersion === 0 ? { text: '' } : versionRow(core, toVersion);
    if (!target) throw new RangeError(`没有这个成长块版本：${toVersion}`);
    db.run('UPDATE core_block_versions SET revoked_at = ?, revoked_by = ? WHERE name = ? AND version > ? AND revoked_at IS NULL', at, by, NAME, toVersion);
    if (target.text === cur.text) return;
    writeVersion(core, { text: target.text, change: { op: 'rollback', to: toVersion, before: null, after: null, signature: `rollback:${toVersion}` }, evidence: [], by, at, charLimit: Math.max(params(core).growth.charLimit, [...target.text].length), clearPending: false });
  });
  metric(core, 'growth.rollback');
}

export function growthVersionsImpl(core) {
  return core.store.all('SELECT * FROM core_block_versions WHERE name = ? ORDER BY version', NAME).map((r) => ({
    version: r.version,
    text: r.text,
    change: safeJson(r.change_json, {}),
    evidenceRefs: safeJson(r.evidence_ids, []),
    createdAt: r.created_at,
    createdBy: r.created_by,
    revokedAt: r.revoked_at ?? null,
    revokedBy: r.revoked_by ?? null,
  }));
}
