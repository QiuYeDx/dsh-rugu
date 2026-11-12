// 模拟器（§13.1）：「如果 X 在 Y 说了 Z」——只计算召回和分寸，不注入、不写感知、不加痕迹。
//   - 认人：在一个必定回滚的事务里调 entities.resolveActor（同步），新账号建的临时档案随回滚消失 = 她不认识这个人。
//   - 召回：retrieve.recall，Z 作为查询文本（库里没有这条感知）；召回本身不加痕迹（§6.4）。
//   - 分寸：discretion.targetFor + gate，目标上带 simulate=true（判定记录照常写，由 discretion 标成模拟）；每条候选的第一段结论
//     （stage1，纯代码）也列出来，被 omit 的也看得到。
//   - 也可以直接给 refs：「这几条在场合 Y、对着 X 会被怎么判」（不经召回）。
import { ContractError } from '../contract/errors.js';
import { validateActorRef, isOpaqueId, LIMITS } from '../contract/index.js';
import { parseRef } from '../store/refs.js';
import { param } from './params.js';

const ROLLBACK = Symbol('simulate-rollback');
const bad = (what, path, message) => new ContractError(what, [{ path, message }]);

function resolveActorDry(core, actor, ctx) {
  let id = null;
  try {
    core.store.tx(() => {
      const r = core.mods.entities.resolveActor(core, actor, ctx);
      id = r?.entityId ?? null;
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { core.log.warn('admin.simulate-actor', { error: e?.code ?? e?.name ?? 'Error' }); return null; }
  }
  if (id != null && !core.store.get('SELECT 1 FROM entities WHERE id = ?', id)) return null;   // 回滚掉了 = 新面孔
  return id;
}

const bareCandidate = (ref) => ({ ref, mref: parseRef(ref), ranks: {}, rrf: 0, signals: {}, A: 0, P: 1, parts: { B: 0, S: 0, C: 0, I: 0, Psup: 0, eps: 0 } });

/**
 * @param {object} core
 * @param {{settingId: string, as: import('../contract/types.js').ActorRef, text: string, mode?: 'involuntary'|'deliberate', refs?: string[]}} s
 * @returns {Promise<import('../contract/types.js').SimResult>}
 */
export async function simulate(core, s) {
  if (!s || !isOpaqueId(s.settingId)) throw bad('simulate', 'settingId', '应为不透明 id');
  if (typeof s.text !== 'string' || s.text.length > LIMITS.textMax) throw bad('simulate', 'text', '应为字符串');
  const av = validateActorRef(s.as);
  if (!av.ok) throw new ContractError('ActorRef', av.errors);
  const actor = av.value;
  const resolved = core.mods.intake.resolveSetting(core, s.settingId);
  if (!resolved) throw bad('simulate', 'settingId', '没有描述过这个场合');
  const at = core.now();
  const mode = s.mode === 'deliberate' ? 'deliberate' : 'involuntary';
  const deadlineMs = param(core, 'recall.deliberate.toolDeadlineMs');
  const triggerEntityId = resolveActorDry(core, actor, { adapterId: resolved.adapter, settingKey: resolved.key, at });

  let candidates;
  let degradeLevel = 0;
  const suppressedDecisions = [];
  if (Array.isArray(s.refs) && s.refs.length) {
    // 直接给的记忆：隐藏 / 忘掉 / 彻底删除的根本想不起来（召回的预过滤），照实列出来
    const refs = [...new Set(s.refs.filter((r) => parseRef(r)))];
    const hidden = core.mods.admin.suppressedRefs(core, refs);
    for (const r of refs) if (hidden.has(r)) suppressedDecisions.push({ id: r, stage: 1, rule: 'suppressed', verdict: 'omit' });
    candidates = refs.filter((r) => !hidden.has(r)).map(bareCandidate);
  } else {
    const cs = await core.mods.retrieve.recall(core, { settingKey: resolved.key, focusPerceptId: null, sessionId: null, trigger: 'message' },
      { mode, query: s.text, deadlineMs });
    candidates = cs.items ?? [];
    degradeLevel = cs.degradeLevel ?? 0;
  }
  const base = core.mods.discretion.targetFor(core, { settingKey: resolved.key, homeSettingKey: resolved.key, sessionId: null, triggerEntityId, mode, at });
  const target = { ...base, simulate: true };
  const first = new Map();
  for (const c of candidates) {
    try { first.set(c.ref, core.mods.discretion.stage1(core, c.mref ?? parseRef(c.ref), target)); } catch { /* 第一段算不了的照常交给 gate */ }
  }
  const gated = await core.mods.discretion.gate(core, candidates, target, { mode, deadlineMs });
  const byRef = new Map(candidates.map((c) => [c.ref, c]));
  const itemChars = param(core, `recall.${mode}.itemChars`);
  // 别的场合的名字：和真的注入一样，那个场合的档案卡在这里过了第一段才写（discretion.placeAllowed）
  const places = new Map();
  const placeAllowed = (k) => {
    if (!places.has(k)) { let ok = false; try { ok = core.mods.discretion.placeAllowed(core, k, target) === true; } catch { ok = false; } places.set(k, ok); }
    return places.get(k);
  };
  const items = [];
  const decided = new Set();
  const decisions = [...suppressedDecisions];
  for (const g of gated) {
    decided.add(g.ref);
    let rendered = '';
    let confidence = 0;
    let provenance = '';
    if (g.verdict === 'share' || g.verdict === 'share_vague') {
      try {
        // 和真的注入一样按目标场合渲染（来源在同一个场合说「在这里」、称呼按这个场合的叫法）
        const r = core.mods.retrieve.render(core, byRef.get(g.ref) ?? bareCandidate(g.ref),
          { verdict: g.verdict, vagueText: g.vagueText ?? null, at, bodyChars: itemChars, settingKey: resolved.key, placeAllowed });
        rendered = r.rendered; confidence = r.confidence; provenance = r.provenance;
      } catch { rendered = ''; }
    }
    items.push({ id: g.ref, layer: g.verdict === 'aware_private' ? 'awarePrivate' : 'recalled', rendered, verdict: g.verdict, confidence, provenance, appraisalRef: g.appraisalRef });
    decisions.push({ id: g.ref, stage: g.stage, rule: g.rule, verdict: g.verdict, reason: first.get(g.ref)?.rule ?? undefined });
  }
  for (const c of candidates) {
    if (decided.has(c.ref)) continue;
    const d = first.get(c.ref);
    decisions.push({ id: c.ref, stage: d && d.decision !== 'stage2' ? 1 : 2, rule: d?.rule, verdict: 'omit' });
  }
  core.log.info('admin.simulate', { candidates: candidates.length, items: items.length, degradeLevel });
  return { items, decisions, degradeLevel };
}
