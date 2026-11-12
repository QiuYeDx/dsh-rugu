// 每轮上下文怎么拼（§10.4）和会话事件（§10.5、§9.5）。所有内容都来自核心的读接口，集成层不碰表（评审:AR-01）。
//   常驻区：systemPrompt.context({name:'persona-memory:core', order:300, required:true, interpolate:false})，provider 同步（F1），
//          只返回这个会话在内存里冻结的文本；新文本只在「pre-step 看到真实新消息」和「压缩结束后」换上（F3、F6）；出错返回上一次的；
//          记忆关着（off）、读不到档位、没认领的会话一律返回空串（不是她的会话不注入）。
//   增量块：agent/pre-step 里 await next() 之后，只在 claimed 里有真实新消息时（F7：回合将结束时绝不插），在最后一条 claimed
//          后面插一条 createUserMessage({source:{kind:'persona-memory', form:'<层>:<nonce>'}})（F8、F21）；
//          先记 sessions.injected（待确认），会话事件里看到这个 nonce 才 sessions.confirm（§10.4「已发过」）；回合结束 sessions.abort。
//   场合的档只有 off / live（没有影子模式）：live 就照常注入，说不说某件事已经由核心的关口①逐条判断过；
//   读不到档位（核心出错）就不注入、也不记注入日志（fail closed，计数 withheldBlocks）。
//   会话事件：交给认领它的适配器绑定翻译成感知（fromSessionEvent）；压缩 start / end；她每一步之后的上下文 token（滚动窗口预算）。
import { randomUUID } from 'node:crypto';
import { sessionInfoOf } from './claim.js';
import { agentId } from './session-state.js';
import { renderInjectBlock, coreBudgetChars } from './render.js';
import { randomId, charLen, settleWithin, deepFreeze, errCode, pickFocus, pickFoci, mergeSeen, freshToHer, turnCandidates } from './util.js';

export const SOURCE_KIND = 'persona-memory';
/** 读不到核心配置时按核心默认的有意回想截止时间（recall.deliberate.deadlineMs）等。 */
const PAST_DEADLINE_FALLBACK_MS = 4000;
/** 集成层等核心回想的上限：再长就不是「等」而是卡住了。 */
const RECALL_WAIT_CAP_MS = 10_000;

/**
 * 增量块最多等核心多久（实测问题 #2）。核心看到「在问过去」的问句会切成有意回想，截止时间放宽到
 * max(不自主回想的截止时间, recall.deliberate.deadlineMs)（默认 4000，D117 起；见 core/src/context/recall.js 的 compute）；
 * 集成层原来只等不自主回想的 800 + 200，「你还记得…吗」这类问句的结果就被丢掉、这一轮什么都不注入。所以按核心同样的规则取大的那个等，
 * 再加 graceMs 的余量（核心在截止时间之外还有一点同步的写库）。平常的消息核心 800 毫秒内就返回，多等的上限只在它真的在有意回想时才用上。
 * 读不到核心配置时按核心默认的 4000 等；核心配置写成 0 或负数时核心按不自主回想的截止时间算，这里也一样。
 * @param {number} deadline   不自主回想的截止时间（inject.deadlineMs）
 * @param {object|null} coreCfg  核心配置（读不到给 null）
 * @param {{graceMs?: number}} [injectCfg]
 */
export function recallWaitMs(deadline, coreCfg, injectCfg) {
  const base = Number.isFinite(deadline) && deadline > 0 ? deadline : 1500;
  const raw = coreCfg && typeof coreCfg === 'object' ? Number(coreCfg.recall?.deliberate?.deadlineMs) : NaN;
  const past = Number.isFinite(raw) ? raw : PAST_DEADLINE_FALLBACK_MS;
  const grace = Number.isFinite(injectCfg?.graceMs) ? Math.max(0, injectCfg.graceMs) : 200;
  return Math.min(RECALL_WAIT_CAP_MS, Math.max(base, past) + grace);
}

export const RESIDENT_CONTEXT = Object.freeze({ name: 'persona-memory:core', order: 300, required: true, interpolate: false });

/** 和 @deepseek-ai/dsh-llm 的 createUserMessage 同一个形状：{...input, role:'user', id}，深冻结。 */
export function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }));
}

/** 默认的「真实新消息」：用户发来的（网页、桥接的唤醒都是 source.kind 'user'）或定时任务（'schedule'）。适配器可以给 isRealMessage 覆盖。 */
export const isUserMessage = (m) => m?.role === 'user' && (m?.source?.kind === 'user' || m?.source?.kind === 'schedule');

/**
 * 这条感知的说话人带不带主人证据（§4.2：principal 证据只能来自配置，适配器只给经配置核实的主人加）。
 * 只看证据的形状，不看是谁、在哪个入口；文字里的权限声明不算（§9.6）。
 */
export const isAuthorizedActor = (actor) => Array.isArray(actor?.claims) && actor.claims.some((c) => c?.kind === 'principal');

/** 交给适配器绑定翻译的会话事件类型。 */
export const OBSERVED_EVENTS = new Set(['user/message', 'assistant/message', 'tool/result']);

/** 被取消时提前结束等待（返回 null，不抛错）；核心那边的计算照常跑完，结果留在它自己的缓存里。 */
function abortable(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(p).then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
// 注入日志只记这几项（不记正文）；工作记忆的条目另带所在的段（D110，排查用）。speak（说出口的档位）D113 起核心不再给，旧版核心给了也只是照记。
// chars：这一条自己的字数（D133）：核心的注入预算按条目的层记账，「你想着的」和工作记忆不算（块头、小标题不算进任何一条）
const pick4 = (it) => ({ id: it.id, layer: it.layer, verdict: it.verdict, appraisalRef: it.appraisalRef, ...(typeof it.speak === 'string' ? { speak: it.speak } : {}),
  ...(typeof it.unit === 'string' ? { unit: it.unit } : {}), ...(typeof it.unitKey === 'string' ? { unitKey: it.unitKey } : {}),
  ...(typeof it.rendered === 'string' ? { chars: charLen(it.rendered) } : {}) });
/** assistant/message 的 usage → 数字（没有 usage 返回 null）。 */
const usageOf = (u) => {
  if (!u || typeof u !== 'object') return null;
  return { in: Number(u.inputTokens) || 0, cached: Number(u.cacheReadTokens) || 0, cacheWrite: Number(u.cacheWriteTokens) || 0, out: Number(u.outputTokens) || 0 };
};
const layerName = (items) => [...new Set(items.map((i) => i.layer))].join('+').slice(0, 64) || 'block';

/** 在最后一条 claimed 消息后面插（F8）；找不到就放最后。 */
export function insertAfterClaimed(messages, claimed, msg) {
  const list = Array.isArray(messages) ? [...messages] : [];
  const ids = new Set((claimed ?? []).map((m) => m?.id).filter(Boolean));
  let at = -1;
  list.forEach((m, i) => { if ((claimed ?? []).includes(m) || (m?.id && ids.has(m.id))) at = i; });
  list.splice(at >= 0 ? at + 1 : list.length, 0, msg);
  return list;
}

/**
 * 绑定说这几条真实消息里哪些感知是这一轮新来的（D115，可选钩子 newObsIds）：每一条都给了数组才算分得出，返回并集；
 * 有一条给 null（分不出）、没有这个钩子、出错 → null（宿主按兜底规则，见 turnCandidates）。
 */
export function newIdsOf(claim, real) {
  const fn = claim?.binding?.newObsIds;
  if (typeof fn !== 'function') return null;
  const out = new Set();
  for (const m of real) {
    let ids = null;
    try { ids = fn.call(claim.binding, m); } catch { return null; }
    if (!Array.isArray(ids)) return null;
    for (const id of ids) if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

/** nonce 从 source.form（'<层>:<nonce>'）里取出来：取最后一个冒号之后。这是我们自己造的格式，不是不透明 id。 */
const nonceOf = (form) => { const s = String(form ?? ''); const i = s.lastIndexOf(':'); return i >= 0 ? s.slice(i + 1) : ''; };

/**
 * @param {{getPm: () => any, claims: ReturnType<typeof import('./claim.js').createClaims>, states: ReturnType<typeof import('./session-state.js').createSessionStates>,
 *          guard: ReturnType<typeof import('./guard.js').createHookGuard>, hostConfig: () => object, log: object, now?: () => number,
 *          budget?: {recordMainChat?: Function, recordAccountChat?: Function}, hub?: {emitMessage: Function}, onClaimed?: (agent: object, claim: object) => void,
 *          infoOf?: typeof sessionInfoOf}} deps   infoOf：读会话现在的 preset（D112），默认只看会话头
 */
export function createContextAssembler({ getPm, claims, states, guard, hostConfig, coreConfig = () => ({}), log, now = () => Date.now(), budget = null, hub = null, onClaimed = () => {}, infoOf = sessionInfoOf, media = null }) {
  const features = () => hostConfig().features ?? {};
  const stats = { blocks: 0, withheldBlocks: 0, chars: 0, confirmed: 0, aborted: 0, recallTimeouts: 0, recallErrors: 0, recallCachedServed: 0, unappraised: 0, degrade: [0, 0, 0, 0, 0], observed: 0, residentServed: 0, suspended: 0, alarmsIgnored: 0, restarts: 0,
    compactionFailed: 0, compactionUnpaired: 0 };

  /** 这个场合现在的生效档。读不到（没描述过、核心坏了）返回 'unknown'：注入按「不注入」处理，外发按 live 处理（各自 fail closed）。 */
  const modeOf = (settingId) => { try { const m = getPm()?.modeOf?.(settingId); return m === 'live' || m === 'off' ? m : 'unknown'; } catch { return 'unknown'; } };

  /** 会话被停掉了（绑定报了一致性告警，例：唤醒头和绑定的场合对不上，C1）：不感知、不注入，管理页报警。 */
  const suspendedOf = (sid) => states.peek(sid)?.suspended ?? null;
  const suspended = new Map();   // sid → {adapterId, reason, at}（给总览，只有原因的类别）
  function suspend(claim, reason) {
    const st = states.get(claim.sessionId);
    if (st.suspended) return;
    st.suspended = { reason: String(reason ?? 'alarm').slice(0, 40), at: now() };
    st.frozen = null;
    suspended.set(claim.sessionId, { adapterId: claim.adapterId, reason: st.suspended.reason, at: st.suspended.at });
    if (suspended.size > 100) suspended.delete(suspended.keys().next().value);
    stats.suspended += 1;
    log.warn('session.suspended', { adapter: claim.adapterId, reason: st.suspended.reason });
  }
  /**
   * 绑定在翻译时留下的告警（lastWakeAlarm）：只认这次调用之后新出现的、属于这个会话的、原因在 claim.suspendOnAlarms 里的
   * （默认：会话对不上 mismatch、不止一个 multiple；「没有唤醒头」只是这条不是唤醒消息，不停）。
   */
  const alarmSince = (claim, before) => {
    const a = claim.binding?.lastWakeAlarm;
    if (!a || a === before || a.sessionId !== claim.sessionId) return null;
    const on = hostConfig().claim?.suspendOnAlarms ?? ['mismatch', 'multiple'];
    if (!on.includes(a.reason)) { stats.alarmsIgnored += 1; return null; }
    return a;
  };

  /** 交给认领它的绑定翻译成感知，马上 observe（同步入队，不阻塞）。返回交上去的感知。 */
  function observeNow(claim, events) {
    const pm = getPm();
    const b = claim.binding;
    if (!pm || typeof b?.fromSessionEvent !== 'function' || features().observe === false) return [];
    if (suspendedOf(claim.sessionId)) return [];
    if (modeOf(claim.settingId) === 'off') return [];
    const before = b.lastWakeAlarm;
    const out = [];
    for (const ev of events) {
      let obs = [];
      try { obs = b.fromSessionEvent(ev, claim.settingId, claim.sessionId) ?? []; } catch (e) { log.warn('observe.translate', { adapter: claim.adapterId, error: errCode(e) }); obs = []; }
      if (Array.isArray(obs) && obs.length) out.push(...obs);
    }
    const alarm = alarmSince(claim, before);
    if (alarm) { suspend(claim, alarm.reason); return []; }
    if (out.length) { pm.observe(out, { adapter: claim.adapterId }); stats.observed += out.length; }
    // 她看到的带媒体的消息（D116）：她之后用工具看了哪一条，从这里认
    if (out.length && media) { try { media.noteObserved(claim, out); } catch { /* 只影响「看过的媒体」 */ } }
    return out;
  }

  const waitMsFor = (deadline) => {
    let core = null;
    try { core = coreConfig(); } catch { core = null; }
    return recallWaitMs(deadline, core, hostConfig().inject);
  };

  /**
   * 召回 → 渲染 → 记注入日志 → 返回要插的消息。记忆关着、读不到档位返回 null（不记注入日志）。
   * @param {object} claim
   * @param {{trigger: 'message'|'reminder'|'idle', focusObsId?: string|null, focusObsIds?: string[], tools?: string[], signal?: AbortSignal}} s
   *        focusObsIds：这一批里对她说话的几条（不同的人，主触发者那条在前；D108）
   */
  async function blockFor(claim, { trigger, focusObsId = null, focusObsIds = null, tools = null, signal } = {}) {
    const pm = getPm();
    if (!pm || features().inject === false || suspendedOf(claim.sessionId)) return null;
    const mode = modeOf(claim.settingId);
    if (mode === 'off') return null;
    const ic = hostConfig().inject ?? {};
    const others = Array.isArray(focusObsIds) ? focusObsIds.filter((x) => typeof x === 'string' && x && x !== focusObsId).slice(0, 7) : [];
    // tools：她这一步正在用的工具（D124：核心据此想起用这个工具的经验）
    const tl = Array.isArray(tools) ? tools.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 64)).slice(0, 4) : [];
    const sit = { settingId: claim.settingId, sessionId: claim.sessionId, trigger, homeSettingId: claim.settingId, ...(focusObsId ? { focusObsId } : {}),
      ...(others.length ? { focusObsIds: others } : {}), ...(tl.length ? { tools: tl } : {}) };
    const deadline = ic.deadlineMs ?? 1500;
    const t0 = Date.now();
    // 等回想的结果交回核心记下来（D117）：等到 / 超时 / 出错 / 取消、等了多久、退回缓存后给了几条——重启也留得下，管理页的诊断看得到
    const report = (outcome, extra = {}) => {
      try { pm.sessions?.recallOutcome?.(claim.sessionId, { outcome, waitedMs: Date.now() - t0, trigger, ...extra }); } catch { /* 只是计数 */ }
    };
    // pm.recall 同步抛错（契约校验不过之类）也当成「出错」，退回缓存，不让这一轮的钩子出错
    let p0;
    // 交给核心的整块字数（D165）：主人没手写就跟着核心的 context.blockMaxChars（随花费档位的 room），不再比它小
    let budgetChars;
    try { budgetChars = coreBudgetChars(coreConfig(), ic, 'inject'); } catch { budgetChars = coreBudgetChars(null, ic, 'inject'); }
    try { p0 = pm.recall(sit, { mode: 'involuntary', deadlineMs: deadline, budgetChars, ...(signal ? { signal } : {}) }); } catch (e) { p0 = Promise.reject(e); }
    const r = await settleWithin(abortable(p0, signal), waitMsFor(deadline));
    // 这一轮在等的时候被取消了（主人取消、桥接中止）：不给死掉的回合记「待确认」、也不插（审查：等得更久以后这点更要紧）
    if (signal?.aborted) { report('aborted'); return null; }
    let layers = r.value ?? null;
    if (!layers) {
      // 等超时、回想报错（rejected）：退回 recallCached（工作记忆第一步就写进缓存了，D117 起核心出错时也先写好）
      if (r.timedOut) stats.recallTimeouts += 1;
      if (r.error) { stats.recallErrors += 1; log.warn('inject.recall.error', { error: errCode(r.error) }); }
      try { layers = pm.recallCached(sit); } catch { layers = null; }
      const served = Array.isArray(layers?.items) ? layers.items.length : 0;
      if (served && (r.timedOut || r.error)) stats.recallCachedServed += 1;
      report(r.timedOut ? 'timeout' : r.error ? 'error' : 'ok', { served, ...(r.error ? { code: errCode(r.error) } : {}) });
    } else {
      report('ok');
    }
    if (Number.isInteger(layers?.degradeLevel)) stats.degrade[Math.min(4, Math.max(0, layers.degradeLevel))] += 1;
    if (!layers?.items?.length) return null;
    // 块头和小标题的写法跟核心的 context.usageStyle（D125；读不到按 guided）
    let style = 'guided';
    let cc = null;
    try { cc = coreConfig(); } catch { cc = null; }
    style = cc?.context?.usageStyle === 'purpose' ? 'purpose' : 'guided';
    // 被判成回忆的那一轮（D155：结果里有回忆那一层）整块的上限加大、开头带「找了哪儿」；浮现的轮不变。
    // D165：上限默认跟着核心走（核心打包出来的东西一定装得下）；主人手写了更小的数才会截，截掉的按条交回核心计数（host.inject.truncated）
    const { text, used, recollect, truncated } = renderInjectBlock(layers, { inject: ic, style, coreConfig: cc });
    if (truncated > 0) report('truncated', { count: truncated });
    if (!used.length) return null;
    // 生效档回想之后再问一次：新场合的第一条消息在回想时才落库、才描述进库（核心先 drain 再算，D96），之前问只能得到 unknown
    const live = (mode === 'live' ? mode : modeOf(claim.settingId)) === 'live';
    if (!live) { stats.withheldBlocks += 1; return null; }
    const nonce = randomId(12);
    const layer = layerName(used);
    try {
      pm.sessions.injected({ sessionId: claim.sessionId, nonce, layer, items: used.map(pick4), chars: charLen(text),
        ...(Number.isInteger(layers.degradeLevel) ? { degradeLevel: layers.degradeLevel } : {}), mode: 'live',
        // 回忆（D155）：意图和范围的摘要原样交回，注入记录里认得出这是回忆
        ...(recollect ? { recollect } : {}) });
    } catch (e) {
      // §9.3.6 / D47：对不上判定记录的块不能当作已发出，整块不注入
      stats.unappraised += 1;
      log.warn('inject.rejected', { error: errCode(e) });
      return null;
    }
    stats.blocks += 1;
    stats.chars += charLen(text);
    states.get(claim.sessionId).pending.add(nonce);
    return { nonce, text, msg: createUserMessage({ content: [{ type: 'text', text }], source: { kind: SOURCE_KIND, form: `${layer}:${nonce}` } }) };
  }

  /** 常驻区 provider（同步）。 */
  function residentText(context) {
    const agent = context?.agent ?? context?.scope ?? null;
    const sid = agentId(agent);
    if (!sid) return '';
    return guard.runSync('resident', sid, () => {
      if (features().resident === false) return '';
      const pm = getPm();
      const claim = claims.get(sid);
      if (!pm || !claim || suspendedOf(sid)) return '';
      if (modeOf(claim.settingId) !== 'live') return '';   // 关着、读不到档位：不注入
      const st = states.get(sid);
      if (!st.frozen || st.swapOnNext) { st.frozen = pm.resident(claim.settingId); st.swapOnNext = false; stats.residentServed += 1; }
      return String(st.frozen?.text ?? '');
    }, () => String(states.peek(sid)?.frozen?.text ?? ''));   // 出错返回上一次的冻结文本
  }

  /** agent/pre-step（F8 瀑布）。next() 只调一次。 */
  async function onPreStep(ev, next) {
    const d = await next();
    const agent = ev?.agent;
    const sid = agentId(agent);
    if (!sid || !d || d.kind === 'reject' || ev?.signal?.aborted) return d;
    const out = await guard.run('pre-step', sid, async () => {
      if (hostConfig().enabled === false) return d;
      const pm = getPm();
      if (!pm) return d;
      const claimed = Array.isArray(ev.messages) ? ev.messages : [];
      const known = claims.get(sid);
      const claim = known ?? claims.resolve(infoOf(agent, { messages: claimed }));
      if (!claim) return d;
      if (!known) { try { onClaimed(agent, claim); } catch { /* 注册工具失败不影响这一步 */ } }
      const isReal = typeof claim.binding?.isRealMessage === 'function'
        ? (m) => { try { return !!claim.binding.isRealMessage(m); } catch { return false; } } : isUserMessage;
      const real = claimed.filter(isReal);
      if (!real.length) return d;   // 没有真实新消息：不插（F7）
      const st = states.get(sid);
      if (st.suspended) return d;
      // 当场提交唤醒消息里的消息（§11.1 E 路：要马上用的不等读文件），注意力升级为 attended
      const obs = observeNow(claim, real.map((m) => ({ type: 'user/message', data: m, seq: -1 })));
      if (st.suspended) return d;   // 绑定刚报了告警（C1）：这个会话停掉感知和注入
      const last = real[real.length - 1];
      let focus = null;
      try { focus = claim.binding?.resolveFocus?.(last) ?? null; } catch { focus = null; }
      const reminder = real.every((m) => m?.source?.kind === 'schedule');
      const turnAt = now();
      const maxT = hostConfig().inject?.maxTriggers ?? 3;
      let trig = null;
      let focusId = null;
      let foci = [];
      let cands = [];
      if (reminder) {
        // 定时提醒开启的轮：没有触发消息（一批里全是定时任务；夹着一条真实的新消息就走下面 message 的路）。
        // 交给核心的焦点是提醒那一条（适配器映射出来的话）；核心按她自己开启的一轮算（D144），不退回最后一个对她说话的人
        trig = pickFocus(obs, focus, { fallbackLast: false });
        focusId = trig?.id ?? focus ?? null;
        foci = trig ? pickFoci(obs, focus, { fallbackLast: false, max: maxT }).map((o) => o.id) : [];
      } else {
        // 只有这一轮新来的能触发这一轮（D115）：唤醒消息里的旧上下文照常入库，但不当触发消息、焦点、清污点的依据、记忆工具的权限
        const freshMs = Number(hostConfig().tools?.seenFreshMs ?? 10 * 60_000);
        cands = turnCandidates(obs, { newIds: newIdsOf(claim, real), floor: turnAt - freshMs });
        // 触发这一轮的那条（D104，和工具结果同一个规矩）：绑定认出来的、对她说的那条；认不出来或认出的是别人随口一句，取最后一条对她说的；
        // 说话人只取同一条感知上的（对不上就不知道）
        trig = pickFocus(cands, focus, { fallbackLast: false });
        // 感知交不上去（记忆关着、感知开关关了）时才退回绑定认出来的那条：那时候没有感知可比
        focusId = trig?.id ?? (obs.length ? null : focus);
        // 一批里还有别的人也在对她说话（D108）：各算一份工作记忆
        foci = trig ? pickFoci(cands, focus, { fallbackLast: false, max: maxT }).map((o) => o.id) : [];
      }
      // 没有新来的、可以触发这一轮的消息（主动冒泡、回复检查、潜水到点……）：这一轮是她自己开启的（selfTurn），没有「眼前这个人」
      const selfTurn = !reminder && !focusId;
      // 轮中（第 2 步以后）又来了一条没有新消息的唤醒：这一轮已经有触发消息了（她读到过谁在对她说话），留着，不当成她自己重新开启的
      const keep = selfTurn && Number(ev.step) > 1 && st.trigger?.obsId != null;
      if (keep) focusId = st.trigger.obsId;
      else {
        // 定时提醒开启的轮也是她自己开启的（D144）：之后的记忆工具回想、读到的随口一句，都和空闲唤醒的轮一样，不当成有人在问她
        st.selfTurn = selfTurn || reminder;
        st.trigger = reminder || selfTurn ? null : { obsId: focusId, actor: trig?.actor ?? null, at: turnAt, msgAt: Number.isFinite(trig?.at) ? trig.at : null };
        // 这一轮她看到的、别人对她说的（D114）：从触发这一轮的那条（和同样新的）重新记起；快照里的旧上下文不算（集成复核）；定时提醒开启的轮没有
        st.turnAt = turnAt;
        st.seen = reminder || !Number.isFinite(trig?.at) ? [] : mergeSeen([], freshToHer(cands, trig.at));
        st.opsUsed = new Set();
      }
      // 按轮污点（§9.6）「从最近一条有权限的说话人的消息开始」：只有这一轮是由带主人证据的消息开启的，才清掉上一轮的污点。
      // 群友、定时提醒、她自己开启的轮不清（污点一直留到主人在这个会话里开口；跨圈子、公开的外发因此一律送审）；
      // 唤醒消息里带着的主人的旧话不算主人开启了这一轮（D115）
      if (ev.step === 1 && !reminder && isAuthorizedActor(st.trigger?.actor)) {
        try { pm.sessions.markTurnTaint(sid, { tainted: false, reason: 'turn-start' }); } catch { /* 不抛错的接口 */ }
      }
      // 她自己开启的轮按「空闲唤醒」（idle）回想：核心不再退回这里最后一个对她说话的人当「眼前这个人」，焦点是这里最近的对话（D115）
      const block = await blockFor(claim, { trigger: reminder ? 'reminder' : selfTurn && !keep ? 'idle' : 'message', focusObsId: focusId, focusObsIds: foci, signal: ev.signal });
      // 冻结规则第 1 条：真实新消息到来时换常驻区（召回里核心已经按这条消息刷新过冻结的版本）
      if (features().resident !== false && modeOf(claim.settingId) === 'live') {
        try { st.frozen = pm.resident(claim.settingId); st.swapOnNext = false; } catch { /* 留着旧的 */ }
      }
      if (!block) return d;
      return { ...d, messages: insertAfterClaimed(d.messages, claimed, block.msg) };
    }, () => d);
    return out ?? d;
  }

  /** session/event（同步；不许往会话里追加，dsh-session 不允许重入）。 */
  function onSessionEvent(session, event) {
    const sid = String(session?.id ?? session?.header?.id ?? '');
    if (!sid || !event?.type) return;
    guard.runSync('session-event', sid, () => {
      const type = event.type;
      const claim = claims.get(sid);
      if (hub) { try { hub.emitMessage({ sessionId: sid, claim: claim ? { settingId: claim.settingId, adapterId: claim.adapterId } : null, type, data: event.data, seq: event.seq, session }); } catch { /* 订阅者出错不影响别人 */ } }
      // 余额能撑几天按整个账户的花费算（§10.6）：别的会话（主人写代码、子代理、桥接的辅助会话）花的也是同一份余额
      const usage = type === 'assistant/message' ? usageOf(event.data?.usage) : null;
      if (usage) { try { budget?.recordAccountChat?.(usage, { provider: event.data?.source?.provider }); } catch { /* 只是诊断数字 */ } }
      if (!claim) return;
      const pm = getPm();
      if (!pm) return;
      const st = states.get(sid);
      if (type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) {
        const nonce = nonceOf(event.data.source.form);
        if (nonce) { pm.sessions.confirm(sid, nonce); st.pending.delete(nonce); stats.confirmed += 1; }
        return;
      }
      if (type === 'turn/end') {
        // 她看完媒体就没再开口：这一轮结束时把她想到的交出去（D116）
        if (media) { try { media.onTurnEnd(sid); } catch { /* 只影响「看过的媒体」 */ } }
        if (st.pending.size) stats.aborted += st.pending.size;
        pm.sessions.abort(sid);
        st.pending.clear();
        st.trigger = null;
        st.selfTurn = false;
        st.seen = [];
        return;
      }
      if (type === 'compaction/start' || type === 'compaction/end') {
        if (features().compaction === false) return;
        const cid = typeof event.data?.compactionId === 'string' && event.data.compactionId ? event.data.compactionId : null;
        if (type === 'compaction/start') {
          if (cid) { st.compactions.add(cid); if (st.compactions.size > 16) st.compactions.delete(st.compactions.values().next().value); }
          pm.sessions.compaction(sid, 'start');
          return;
        }
        // 压缩失败（compaction-basic 失败时也写一条带 error 的 compaction/end，会话的上下文原样不动）：不开新周期、不换常驻区，
        // 已发名单和污点账本照旧——那些块还原样在她的上下文里
        if (event.data?.error != null) {
          if (cid) st.compactions.delete(cid);
          stats.compactionFailed += 1;
          log.warn('compaction.failed', {});
          return;
        }
        // 对不上 start 的 end（插件在压缩中途重载过）：不知道这次压缩成没成，按没成处理（宁可多当一会儿「已发过」）
        if (cid && !st.compactions.has(cid)) { stats.compactionUnpaired += 1; log.warn('compaction.unpaired', {}); return; }
        if (cid) st.compactions.delete(cid);
        pm.sessions.compaction(sid, 'end');
        st.swapOnNext = true;   // 冻结规则第 2 条：压缩结束后换常驻区
        return;
      }
      if (usage) {
        const tokens = usage.in + usage.cached + usage.cacheWrite + usage.out;
        if (tokens > 0) pm.sessions.step(sid, { contextTokens: tokens, at: now() });
        try { budget?.recordMainChat?.({ in: usage.in, cached: usage.cached, cacheWrite: usage.cacheWrite, out: usage.out }); } catch { /* 只是诊断数字 */ }
      }
      // 重新开始（主人在这个场合主动重置，§10.5、§17 Q6）：判断是重置还是退役由适配器负责
      // 核心清空工作记忆、只给常驻区（§17 Q6），并马上重新渲染常驻区：下一次 provider 换上新的
      let restart = false;
      try { restart = claim.binding?.isRestart?.(event) === true; } catch { restart = false; /* 适配器判断出错就当不是 */ }
      if (restart && features().compaction !== false) {
        pm.sessions.compaction(sid, 'restart');
        st.swapOnNext = true;
        stats.restarts += 1;
      }
      // 她看完媒体之后的想法和回话（D116）
      if (type === 'assistant/message' && media) { try { media.onAssistant(sid, event.data); } catch { /* 只影响「看过的媒体」 */ } }
      if (OBSERVED_EVENTS.has(type)) observeNow(claim, [{ type, data: event.data, seq: event.seq }]);
    }, () => {});
  }

  /**
   * 读消息工具的结果当场入库之后（egress 的 post-execute 调，D114）：她这一步看到了别人对她说的新消息——
   * 记进这一轮的「看到的」，触发消息换成这批里对她说的最新那条（比原来的晚才换；定时提醒、她自己开启的轮（没有触发消息，D115）也一样：她自己读到了有人在对她说话）。
   * 只算新的（freshToHer）：翻历史读到的旧消息、她已经回过的不算。
   * 在 bridge 的 reserved2 模式下，唤醒消息常常只带着旧的上下文，新消息是她用 qq_wait_for_messages 读到的；
   * 不换的话，memory_note / memory_fix 拿去核对原话的还是唤醒时那条旧消息（11-06 14:28 那三次「quote-not-in-message」）。
   * @param {object} claim
   * @param {object[]} obs        这次交给核心的感知
   * @param {string|null} resolvedId  绑定认出来的那条（resolveFocus）
   */
  function noteSeen(claim, obs, resolvedId = null) {
    if (!claim?.sessionId || !Array.isArray(obs) || !obs.length) return;
    const st = states.get(claim.sessionId);
    // 只算新的（集成复核）：不早于触发这一轮的那条，也不早于这一轮开始前 seenFreshMs；在这批里她最后一次开口之后。
    // 翻历史（qq_get_recent_messages、旁观别的群）读到的旧消息不算她这一轮看到的「别人对她说的」
    const freshMs = Number(hostConfig().tools?.seenFreshMs ?? 10 * 60_000);
    const floor = Math.max(Number.isFinite(st.trigger?.msgAt) ? st.trigger.msgAt : -Infinity, (Number.isFinite(st.turnAt) ? st.turnAt : now()) - freshMs);
    const fresh = freshToHer(obs, floor);
    if (!fresh.length) return;
    st.seen = mergeSeen(st.seen, fresh);
    const trig = pickFocus(fresh, resolvedId, { fallbackLast: false });
    if (!trig) return;
    const at = Number.isFinite(trig.at) ? trig.at : null;
    const cur = st.trigger;
    if (cur?.obsId === trig.id) return;
    if (cur?.obsId && cur.msgAt != null && at != null && at < cur.msgAt) return;   // 读到的是更早的消息（翻历史）：触发的还是原来那条
    st.trigger = { obsId: trig.id, actor: trig.actor ?? null, at: now(), msgAt: at };
  }

  /**
   * 读消息工具的结果按哪条回想（D115 集成复核；egress 的 post-execute 在 noteSeen 之后调）。焦点和「一批里对她说话的几个人」
   * 只从这一轮新看到的里挑（不早于触发消息、不早于这一轮开始前 seenFreshMs、在这批里她最后一次开口之后）；翻历史读到的旧话照常入库，
   * 但不当焦点——否则核心会把那句旧话的说话人记成这一轮的触发者，外发守护就当他是「被回答的人」，工作记忆也围着他转。
   * 没有新看到的：按这一轮的触发消息想；这一轮没有触发消息（她自己开启的、定时提醒开启的，也还没读到有人对她说话）→ idle（没有「眼前这个人」）。
   * @returns {{trigger: 'message'|'idle', focusObsId: string|null, focusObsIds: string[]}}
   */
  function toolFocus(claim, obs, resolvedId = null) {
    const st = claim?.sessionId ? states.get(claim.sessionId) : null;
    const cur = st?.trigger?.obsId ?? null;
    const freshMs = Number(hostConfig().tools?.seenFreshMs ?? 10 * 60_000);
    const floor = Math.max(Number.isFinite(st?.trigger?.msgAt) ? st.trigger.msgAt : -Infinity, (Number.isFinite(st?.turnAt) ? st.turnAt : now()) - freshMs);
    // 她自己开启、还没读到有人对她说话的一轮：读到的新的随口一句也不让她变成「在回谁」（和 pre-step 一样，只有对她说的才开启「回谁」）
    const cands = !cur && st?.selfTurn ? [] : turnCandidates(Array.isArray(obs) ? obs : [], { floor });
    const f = pickFocus(cands, resolvedId);
    if (!f && !cur) return { trigger: 'idle', focusObsId: null, focusObsIds: [] };
    const focusObsIds = f ? pickFoci(cands, resolvedId, { max: hostConfig().inject?.maxTriggers ?? 3 }).map((o) => o.id) : [];
    return { trigger: 'message', focusObsId: f?.id ?? cur, focusObsIds };
  }

  return {
    residentText, onPreStep, onSessionEvent, blockFor, observeNow, modeOf, suspend, noteSeen, toolFocus,
    isSuspended: (sid) => !!suspendedOf(sid),
    /** 这一轮的触发消息、是不是她自己开启的、她看到的（只给排查和测试用的副本，不含正文）。 */
    turnState: (sid) => { const st = states.peek(sid); return st ? { trigger: st.trigger ? { ...st.trigger } : null, selfTurn: !!st.selfTurn, seen: (st.seen ?? []).map((x) => ({ ...x })) } : null; },
    status: () => ({ ...stats, degrade: [...stats.degrade], suspendedSessions: [...suspended.values()].map((x) => ({ ...x })) }),
  };
}
