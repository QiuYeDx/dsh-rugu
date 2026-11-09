// 关口①的总入口（§9.3）。每条结论（含第一段放行）都写一行 appraisals，返回的 appraisalRef 指向它（§9.3.6）。
// 两条路（D113「功能优先」）：
//   - 目标是公开的（publicLike）或者受众读不到（批量目标里有这样的也算）、说出去就收不回的渠道而听的不只是管理者（那里没有关口②）：
//     原来的整套——第一段 + 第二段 + 封顶 + 污点封顶 + 暗示，一字不改；
//   - 其余目标（同一场合、别的群、私聊）：只跑第一段。不进上下文的只有底线（隐藏 / 忘掉 / 撤回 / missing / error、B1 strict 和
//     叮嘱里被点名的人在场、B3、B4 block、B5）、叮嘱里被点名的人的关系人确实在这里（named-deny；「受众看不全、可能在」不算，定叮嘱的人
//     自己在问的不算）和「给第三方的敏感私事」（sensitive-other：敏感度 ≥ b5Sensitivity——规范的，还没提炼的用第一眼的 sens——、不是他自己的事、
//     听的不只是管理者、这里有人当时没听到而且不在同一场合）；主人定的上限（B4 封顶）照旧走第二段和封顶；其余一律原文进来、带来源标签
//     （label：核对过原话的叮嘱；渲染时别处的来源按结构写「私聊时 / 在另一个群里」），说不说、说多少由她看着标签自己掂量。
//     不调第二段，没有 pending、截止时间、暗示、aware_private、限速。第一段的判定照样写一行（reason 'stage1:<rule>:open'）。
// 想起来了但没说的（aware_private / omit / pending）记分寸日志。
import { parseRef, refOf } from '../store/index.js';
import { dcfg, raceDeadline, soft, DAY, metric, stricterVerdict } from './util.js';
import { managerIds, selfId } from './facts.js';
import { audienceOf, unknownAudience, refreshMembers, presenceMembers, managerOnly } from './knowledge.js';
import { evaluate } from './stage1.js';
import { prepareItem, lookupCache, runStage2, writeAppraisal, triggerClass } from './stage2.js';
import { logDecision } from './told.js';
import { glancesOf } from './glance.js';
import { explicitLimit } from './norms.js';

const apRef = (id) => `ap${id}`;

function stage1Row(core, ev, mref, target, verdict, reason = `stage1:${ev.rule}`) {
  return writeAppraisal(core, {
    stage: 1, rule: ev.rule, memoryKind: mref.kind, memoryId: mref.id, settingKey: target.audience.settingKey,
    normVersion: ev.norm?.version ?? null, snapshotId: target.audience.snapshotId, taint: target.taint,
    triggerClass: triggerClass(core, target.triggerEntityId, null), verdict, reason,
  });
}

/**
 * 这个目标走不走原来的整套（D113）：公开的、受众读不到的（批量目标里有一个这样的也算），以及说出去就收不回的渠道（preSendGate:false）
 * 而听的不只是管理者——那里没有关口②，外发守护也就无从兜底。其余只跑第一段。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').DisclosureTarget} target
 */
export function strictTarget(core, target, memo = new Map()) {
  const list = [target?.audience, ...(target?.batchTargets ?? [])];
  return list.some((a) => !a || !a.known || a.publicLike || (a.preSendGate === false && !managerOnly(core, a, memo)));
}

/** 她以前对这批人说过这件事吗（§5.6 告诉过谁：不把同一件事当新鲜事讲两遍，S14）。 */
function toldBefore(core, mref, target, ev, memo) {
  const rows = core.store.all('SELECT at, level, setting_key, presence_set_id FROM told_log WHERE owner_kind = ? AND owner_id = ? ORDER BY at DESC LIMIT 20', mref.kind, mref.id);
  const people = new Set(ev.N?.people ?? []);
  for (const r of rows) {
    if (r.setting_key === target.audience.settingKey) return { at: r.at, level: r.level };
    const ps = presenceMembers(core, r.presence_set_id, memo);
    if (ps && people.size && [...people].every((p) => ps.members.includes(p))) return { at: r.at, level: r.level };
  }
  return null;
}

function subjectOf(ev) { return (ev.subjects ?? [])[0] ?? null; }

/**
 * 非公开目标上原文放进来的那条带的来源标签（D113，和工作记忆同一套事实）：limit = 核对过原话的叮嘱（norms.explicitLimit），
 * 渲染成「（他叮嘱过别外传：「原话」）」；别的场合的来源在说不出名字时按结构写「私聊时」/「在另一个群里」（retrieve.render 按 label 有无决定）。
 * 读不到返回 {limit: null}（照样带上，渲染据此写结构化的场合）。
 */
function openLabel(core, mref, ev, memo) {
  let lim = null;
  try {
    const g = mref.kind === 'percept' ? glancesOf(core, [mref.id]).get(mref.id) ?? null : null;
    lim = explicitLimit(core, mref, g, memo);
  } catch { lim = null; }
  return { limit: lim ? { kind: lim.kind, quote: lim.quote ?? null, by: lim.by ?? null } : null, open: true, rule: ev.rule ?? null };
}

/**
 * 带污点的轮（§9.6）：新知情者不为空、而且不是触发者自己说的条目，最多说个大概。这个上限在调用第二段**之前**写进 ev.cap，
 * 卡片上写着「最多：share_vague」，模型知道要写含糊版本（D102：代码会加的上限一律先上卡片；11-05 那次上限没写在卡片上，
 * 模型判 share、没写含糊版本，代码一路降成 omit）。触发者自己说的事、她回他的那一句（D110 repliedToTrigger）不受污点约束：
 * 污点防的是不可信的内容把别人的事套出来。
 */
function taintCap(ev, target) {
  if (!target.taint || !ev.N || ev.N.empty || ev.toldByTrigger || ev.repliedToTrigger) return ev;
  return { ...ev, decision: 'cap', cap: stricterVerdict(ev.cap ?? null, 'share_vague'), notes: [...(ev.notes ?? []), 'taint'] };
}

/**
 * 暗示能不能写得具体一点（§9.3.4「暗示本身也是信息」）：默认不写主体是谁、不写「是别人私下说的」；
 * 只有主体本人（权利层确认）或当初告诉她的那个人在场时才可以。
 */
function hintSpecific(core, ev, memo) {
  if (ev.subjectPresent) return true;
  const people = new Set(ev.N?.people ?? []);
  if (!people.size) return false;
  const me = selfId(core, memo);
  const tellers = [...(ev.facts?.speakers ?? []), ...(ev.facts?.asserters ?? [])].filter((x) => x != null && x !== me);
  return tellers.some((t) => people.has(t));
}

/**
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').ScoredCandidate[]} candidates
 * @param {import('../core-types.js').DisclosureTarget} target
 * @param {{mode: 'involuntary'|'deliberate', deadlineMs: number, waitMs?: number, signal?: AbortSignal}} opt
 *        waitMs（可选）：第二段最多等到多久（从调用开始算）；比 deadlineMs 长时只延长等第二段的那一段（D99）
 * @returns {Promise<import('../core-types.js').GatedItem[]>}
 */
export async function gate(core, candidates, target, opt = {}) {
  const t0 = performance.now();
  const cfg = dcfg(core);
  const mode = opt.mode ?? target.mode ?? 'involuntary';
  const memo = new Map();
  const results = new Array(candidates.length).fill(null);
  const logs = [];
  const pending = [];
  const at = core.now();
  const settingKey = target.audience?.settingKey ?? null;
  const trig = target.triggerEntityId ?? null;
  const log = (kind, i, ev, mref, appraisalId, reason) => logs.push({
    kind, settingKey, ref: refOf(mref.kind, mref.id), memoryId: mref.id, appraisalId, triggerEntityId: trig, subjectEntityId: subjectOf(ev), reason, at, i,
  });

  const open = !strictTarget(core, target, memo);
  core.store.tx(() => {
    candidates.forEach((c, i) => {
      const mref = c?.mref ?? parseRef(c?.ref);
      if (!mref) return;
      const ref = refOf(mref.kind, mref.id);
      let ev;
      try { ev = evaluate(core, mref, target, memo); } catch (e) {
        soft(core, 'gate.stage1', () => { throw e; }, null);
        ev = { decision: 'block', rule: 'error', notes: [], subjects: [] };
      }
      if (ev.decision === 'block') {
        const id = stage1Row(core, ev, mref, target, 'omit');
        log('omit', i, ev, mref, id, `stage1:${ev.rule}`);
        return;
      }
      if (open && ev.decision !== 'pass' && !ev.ownerCap) {
        // 非公开目标（D113）：给第三方的敏感私事、叮嘱里被点名不让知道的人的关系人确实在这里（namedDeny；定叮嘱的人自己在问的不算）不进；
        // 其余（封顶、交给第二段的）一律原文进来，带来源标签（label：从哪种场合来的、核对过原话的叮嘱）。
        // 主人定的上限（B4 封顶，ownerCap）不在这里放开：照旧走第二段和封顶（主人的控制由代码执行，§3.0）
        const omitWhy = ev.sensitiveOther ? 'sensitive-other' : ev.namedDeny ? 'named-deny' : null;
        if (omitWhy) {
          const id = stage1Row(core, ev, mref, target, 'omit', `stage1:${omitWhy}`);
          log('omit', i, ev, mref, id, `omit:${omitWhy}`);
          metric(core, omitWhy === 'sensitive-other' ? 'gate.omit.sensitiveOther' : 'gate.omit.namedDeny');
          return;
        }
        const id = stage1Row(core, ev, mref, target, 'share', `stage1:${ev.rule}:open`);
        const told = toldBefore(core, mref, target, ev, memo);
        const label = openLabel(core, mref, ev, memo);
        results[i] = { ref, verdict: 'share', vagueText: null, hintOk: false, appraisalRef: apRef(id), stage: 1, rule: ev.rule, ...(label ? { label } : {}), ...(told ? { told } : {}) };
        return;
      }
      if (ev.decision === 'pass') {
        // 第一段放行的（A1–A3：在场的人本来就知道、只关于她自己或不针对谁、本来就公开）不因为按轮污点再收紧：
        // 污点只作用到关口②和第三方的条目（§9.6，D102）
        const id = stage1Row(core, ev, mref, target, 'share');
        const told = toldBefore(core, mref, target, ev, memo);
        results[i] = { ref, verdict: 'share', vagueText: null, hintOk: false, appraisalRef: apRef(id), stage: 1, rule: ev.rule, ...(told ? { told } : {}) };
        return;
      }
      pending.push({ i, ref, mref, ev: taintCap(ev, target) });
    });
  });

  if (pending.length) {
    const items = pending.map((p) => ({ ...prepareItem(core, p.ref, p.mref, p.ev, target, memo), i: p.i }));
    const apply = (it, r) => {
      if (!r || r.failed || r.verdict === 'omit') {
        log('omit', it.i, it.ev, it.mref, r?.appraisalId ?? null, r?.failed ? `stage2:${r.failed}` : 'stage2:omit');
        return;
      }
      const told = toldBefore(core, it.mref, target, it.ev, memo);
      results[it.i] = {
        ref: it.ref, verdict: r.verdict, vagueText: r.verdict === 'share_vague' ? (r.vagueText ?? null) : null,
        hintOk: r.verdict === 'aware_private' ? !!r.hintOk : false, appraisalRef: apRef(r.appraisalId), stage: 2, rule: it.ev.rule,
        ...(r.verdict === 'aware_private' ? { hintSpecific: hintSpecific(core, it.ev, memo) } : {}),
        ...(told ? { told } : {}), ...(r.cached ? { cached: true } : {}),
      };
      if (r.verdict === 'aware_private') log('aware_private', it.i, it.ev, it.mref, r.appraisalId, 'stage2:aware_private');
    };
    // 被直接问到（有意回想）、而问的人在上次判断之后又说了话（追问、说明了理由）：更严的旧结论不直接沿用，重新想一想
    //（§9.3.5「停一下想一想」、§9.3.7「认真追问时可以讲大概」）。缓存只是允许复用，不是必须复用
    const lastAsk = mode === 'deliberate' && trig != null && settingKey
      ? core.store.get(`SELECT MAX(at) AS at FROM percepts WHERE setting_key = ? AND actor_entity_id = ? AND kind IN ('utterance','action','content')`, settingKey, trig)?.at ?? null
      : null;
    const uncached = [];
    for (const it of items) {
      const hit = lookupCache(core, it, target, memo);
      if (hit && !(hit.strict && lastAsk != null && hit.at < lastAsk)) apply(it, hit); else uncached.push(it);
    }
    const per = Math.max(1, cfg.stage2.maxItemsPerCall);
    const limit = per * (mode === 'deliberate' ? Math.max(1, cfg.stage2.deliberateMaxCalls) : 1);
    const toRun = uncached.slice(0, limit);
    const overflow = uncached.slice(limit);
    const markPending = (list, why) => {
      core.store.tx(() => {
        for (const it of list) {
          if (mode === 'deliberate') {
            // 有意回想：先给一行不含内容、不点名的暂定提示，下一轮用缓存补上（§9.3.5）
            const id = writeAppraisal(core, {
              stage: 2, rule: it.ev.rule, memoryKind: it.mref.kind, memoryId: it.mref.id, settingKey, normVersion: it.normVersion,
              snapshotId: target.audience.snapshotId, audienceClass: it.audClass, triggerClass: it.trig, taint: target.taint, verdict: 'pending', reason: why,
            });
            results[it.i] = { ref: it.ref, verdict: 'pending', vagueText: null, hintOk: false, appraisalRef: apRef(id), stage: 2, rule: it.ev.rule };
            log('pending', it.i, it.ev, it.mref, id, why);
          } else {
            log('pending', it.i, it.ev, it.mref, null, why);   // 不自主回想：这一轮不给，留到下一轮用缓存
          }
        }
      });
    };
    if (toRun.length) {
      // 第二段在后台跑完（结果进缓存），这一轮只等到截止时间（不把调用方的 signal 传进去：中止这一轮不该浪费已经开始的判断）
      const p = runStage2(core, toRun, target, { deadlineMs: cfg.stage2.timeoutMs, signal: core.state.discretion.ctl.signal }, memo);
      p.catch(() => {});
      // 调用方没给截止时间：按这种回想自己的截止时间（recall.involuntary / deliberate.deadlineMs）。
      // waitMs：这一轮可以为第二段多等多久（直接对她说的消息触发的不自主回想，D99：这一轮就用上判断，不留到下一轮）
      const base = opt.deadlineMs ?? core.config.get().recall[mode].deadlineMs;
      const remaining = (Number.isFinite(opt.waitMs) ? Math.max(base, opt.waitMs) : base) - (performance.now() - t0);
      const raced = await raceDeadline(p, remaining);
      if (raced.done) {
        for (const it of toRun) apply(it, raced.value.get(it.ref) ?? { failed: 'missing', appraisalId: null });
      } else {
        metric(core, 'gate.deadline');
        markPending(toRun, 'deadline');
      }
    }
    if (overflow.length) {
      metric(core, `gate.overflow.${mode}`, overflow.length);   // 第二段名额不够、这一轮没判到的条数（实测问题 #5：看近况是不是把名额挤满了）
      markPending(overflow, 'overflow');
    }
  }

  // 逐个打听「谁有秘密」：同一个人一天内收到关于几个不同的人「有但不能说」的信号，超过阈值后一律不再给（§9.3.4；只有公开路径有暗示）
  if (trig != null && !managerIds(core, memo).has(trig)) {
    const max = cfg.hint.maxDenialsPerAskerPerDay;
    const given = new Set(core.store.all(`SELECT DISTINCT COALESCE(subject_entity_id, -memory_id) AS k FROM discretion_log
                                          WHERE trigger_entity_id = ? AND kind = 'aware_private' AND at > ?`, trig, at - DAY).map((r) => r.k));
    for (const lg of logs) {
      if (lg.kind !== 'aware_private') continue;
      const key = lg.subjectEntityId ?? -lg.memoryId;
      if (given.has(key)) continue;
      if (given.size >= max) { results[lg.i] = null; lg.kind = 'omit'; lg.reason = 'asker-limit'; continue; }
      given.add(key);
    }
  }

  if (logs.length && !core.store.closed) {
    soft(core, 'gate.log', () => core.store.tx(() => { for (const lg of logs) logDecision(core, lg); }), null);
  }
  return results.filter(Boolean);
}

/**
 * 组装关口①的目标：audienceOf(目标场合) + 触发者 + 按轮污点 + 批量目标的并集（没有会话的后台提示词，§9.4.1 第 4 条）。
 * 可选字段（【补】）：settingId / adapterId（适配器自己的 id，能列成员的平台据此后台刷新成员名单）、batch（显式声明是批量提示词）。
 */
export function targetFor(core, p) {
  const memo = new Map();
  const at = Number.isFinite(p.at) ? p.at : core.now();
  const audience = audienceOf(core, p.settingKey, at, memo);
  let taint = false;
  if (p.sessionId) {
    try { taint = !!core.mods.context.sessionInfo(core, p.sessionId)?.turnTainted; } catch {
      taint = true;   // 读不到按轮污点：按带污点处理（fail closed）
      metric(core, 'target.taintUnknown');
    }
  }
  // 预取时替「这一轮开始时」先判（D99）：按轮污点由宿主在这一轮开始时才定（有权限的人开启的轮清掉上一轮的，§9.6），
  // 调用方预计会清掉时给 expectCleanTurn。判定照常按污点分开缓存：预计错了只是这一轮缓存对不上、注入前照常再判，
  // 不会把没污点的结论用到带污点的轮
  if (p.expectCleanTurn === true) taint = false;
  const out = {
    audience, homeSettingKey: p.homeSettingKey ?? p.settingKey, sessionId: p.sessionId ?? null,
    triggerEntityId: Number.isSafeInteger(p.triggerEntityId) ? p.triggerEntityId : null, taint, mode: p.mode === 'deliberate' ? 'deliberate' : 'involuntary',
  };
  // 这一轮是不是直接对她说的（或她自己想回想）：节省档的第二段只在这时跑（budget.presets.saving.stage2Scope='direct'，执行在 BudgetPort）
  if (typeof p.direct === 'boolean') out.direct = p.direct;
  // 触发这一轮的那条感知（第二段的提示词里写「这一轮是因为这句话」，§9.3.3 的输入；不进缓存键）
  if (Number.isSafeInteger(p.focusPerceptId)) out.focusPerceptId = p.focusPerceptId;
  if ((p.batch === true || !p.sessionId) && Array.isArray(p.egress) && p.egress.length) {
    const seen = new Set([p.settingKey]);
    const batch = [];
    for (const ch of p.egress) {
      let key = null;
      try { key = core.mods.intake.resolveSetting(core, ch?.targetSettingId)?.key ?? null; } catch { key = null; }
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      batch.push(key ? audienceOf(core, key, at, memo) : unknownAudience(null));
    }
    if (batch.length) out.batchTargets = batch;
  }
  if (p.settingId) refreshMembers(core, { settingKey: p.settingKey, settingId: p.settingId, adapterId: p.adapterId ?? audience.adapter, at });
  return out;
}

/**
 * 第二段的对外入口：对给定的条目（先过第一段：底线命中的直接 omit，绝不送去评估）查缓存，没命中的一次调用判完。
 */
export async function stage2(core, refs, target, opt = {}) {
  const memo = new Map();
  const out = new Map();
  const items = [];
  core.store.tx(() => {
    for (const mref of refs ?? []) {
      if (!mref || !Number.isSafeInteger(mref.id)) continue;
      const ref = refOf(mref.kind, mref.id);
      const ev = evaluate(core, mref, target, memo);
      if (ev.decision === 'block') {
        out.set(ref, { verdict: 'omit', hintOk: false, appraisalId: stage1Row(core, ev, mref, target, 'omit') });
        continue;
      }
      items.push(prepareItem(core, ref, mref, taintCap(ev, target), target, memo));
    }
  });
  const run = [];
  for (const it of items) {
    const hit = lookupCache(core, it, target, memo);
    if (hit) out.set(it.ref, hit); else run.push(it);
  }
  if (run.length) {
    const res = await runStage2(core, run, target, { deadlineMs: opt.deadlineMs, signal: opt.signal }, memo);
    for (const [k, v] of res) out.set(k, v);
  }
  return out;
}
