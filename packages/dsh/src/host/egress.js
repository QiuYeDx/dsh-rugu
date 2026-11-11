// 外发钩子（§9.4、§10.9）和工具结果钩子（§9.5、§9.6、§10.4）。
// tools/pre-execute（一个全局监听器，F16：异步瀑布，可以带理由拒绝；MCP 工具也走这里）：
//   0. 硬底线，不看模式、不需要核心：冻结桥接自带的记忆（§15.2、B13：qq_memory_* 的写入和 qq_note_person 一律拒绝）；
//      插件自己的配置、密钥和数据文件，工具一律碰不到（§9.6：「聊天和工具没有任何改它的路」，改设置只走管理页）；
//   1. 按 exec.name（和认领这个会话的适配器）查分类表 → 说话类（speak / defer / standing / persist-foreign）的 resolve 成 Utterance →
//      expression.appraise()；一次调用会落到几个场合的（定时任务的多个目标、写进全局存储的笔记），绑定给 resolveAll，逐个场合各审一次，
//      全都 speak 才放行（目标太多审不过来 = 审不了）；speak 放行；reconsider 带她自己的一句转念拒绝（她看到 `Error: <转念>`，自己换个说法，
//      pre-execute 本来就改不了参数）；hold 记 outcome('held') 并拒绝（只有 canHold 的场合会走到这里，§9.4.4）；
//      这次调用没说新的话（绑定的 silent：暂停定时任务、列出规则……）不审直接放行；
//   2. appraisedBy:'adapter' 的跳过（适配器在自己的汇合点审，避免同一句审两遍）；
//   3. 审不了（核心出错、超时、resolve 不出目标、核心没打开 / 只读、熔断、父会话不在了的子代理）：D113「功能优先」——一律放行
//      （fail open，计 failOpen），只有宿主读得到目标场合的属性、而且它是公开的（publicLike：任何人可见或公开留存）时才照旧改口
//      （「这次先不说了」）。公开渠道（B站）是 appraisedBy:'adapter'，不走这里；
//   4. 没分类的工具 + 参数里有较长的自由文本：放行，计 unclassifiedPassed、记一条警告，管理页提示补分类（D113；原来记忆开着就拒绝）。
// 场合的档只有 off / live（没有影子模式，用户反馈第 6 轮）：每类场合默认 live，群里、公开场合的话照常送审。
// tools/post-execute（F9：先 await next()，只调一次，结果原样合并；出错返回原结果）：
//   说话类工具按 callId 回报 sent / failed（关口③记账，§9.5）；memory_recall 的注入确认；
//   读内容的工具结果当场交给绑定翻译成感知（F11：内层看到的是截断前的完整结果）、给这一轮打按轮污点（§9.6），
//   有新消息就召回一次，结果用 additionalContexts 带进下一步（F10）；
//   没分类的工具、读本机文件和跑命令的自带工具，结果里有文字就只打按轮污点（不知道是谁写的，按素材算）；
//   她的每次工具调用成没成交给核心记经验（D124），见 lessonsAfter。
import path from 'node:path';
import { SPEAKING_CLASSES } from '../binding/index.js';
import { textHash, isPublicLike } from 'rugu-core/contract';
import { sessionInfoOf, matchesSignature } from './claim.js';
import { agentId } from './session-state.js';
import { bareName, MEMORY_TOOLS } from './tooltable.js';
import { settleWithin, charLen, errCode, pickFocus, pickFoci, randomId, clip } from './util.js';
import { createUserMessage, SOURCE_KIND } from './context.js';

const deny = (reason) => ({ kind: 'deny', reason });

/** 参数里有没有较长的自由文本（深度 ≤ 4）。 */
export function hasLongFreeText(args, minChars, depth = 0) {
  if (typeof args === 'string') return charLen(args.trim()) >= minChars;
  if (depth > 4 || args == null || typeof args !== 'object') return false;
  for (const v of Array.isArray(args) ? args : Object.values(args)) if (hasLongFreeText(v, minChars, depth + 1)) return true;
  return false;
}

/** 冻结清单里的工具：精确名，或 MCP 前缀 + __ + 名字。 */
export function isFrozenTool(name, list) {
  const n = String(name ?? '');
  const bare = bareName(n);
  return (list ?? []).some((t) => n === t || (bare === t && n.endsWith(`__${t}`)));
}

/** 插件自己的文件（核心的库文件名照 rugu-core 的 store；这里只按名字认）。 */
export const PROTECTED_BASENAMES = Object.freeze(['persona-memory.json', 'persona-memory.key', 'persona-memory-backup.key', 'persona-memory-embedding.key', 'persona-memory.db', 'persona-vectors.db']);
const FILE_TOOLS = new Set(['write', 'edit', 'read', 'str_replace_editor', 'grep', 'glob']);
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'run_code', 'terminal_send']);
const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const stringsOf = (args) => {
  const out = [];
  const walk = (v, depth) => {
    if (typeof v === 'string') { out.push(v); return; }
    if (depth > 3 || v == null || typeof v !== 'object') return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(args, 0);
  return out;
};

/**
 * 这次工具调用碰不碰插件自己的配置、密钥和数据（DSH 自带的读写文件、改文件、跑命令的工具）。
 * 命令行没法真的看懂，只按文件名和数据目录的路径找（纵深防御：她被网页里的话骗去改设置、读密钥）。
 * @param {{name?: string, arguments?: unknown}} exec
 * @param {{dataDir?: string, files?: string[]}} where
 */
export function touchesProtected(exec, where) {
  const name = String(exec?.name ?? '');
  if (name.startsWith('mcp__')) return false;
  const isFile = FILE_TOOLS.has(name);
  if (!isFile && !SHELL_TOOLS.has(name)) return false;
  const a = exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
  const dataDir = where?.dataDir ? normPath(where.dataDir) : '';
  const names = new Set([...PROTECTED_BASENAMES, ...(where?.files ?? []).map((f) => path.basename(String(f)).toLowerCase())]);
  if (isFile) {
    const p = normPath(a.file_path ?? a.path ?? '');
    if (!p) return false;
    const base = p.split('/').pop();
    return names.has(base) || (!!dataDir && (p === dataDir || p.startsWith(`${dataDir}/`)));
  }
  const text = stringsOf(a).join('\n').replace(/\\/g, '/').toLowerCase();
  if (!text) return false;
  for (const n of names) if (text.includes(n)) return true;
  return !!dataDir && text.includes(dataDir);
}

/**
 * @param {{getPm: () => any, claims: object, tooltable: object, guard: object, assembler: object, states?: object,
 *          hostConfig: () => object, log: object, recallNonces: Map<string, {sessionId: string, nonce: string}>,
 *          protectedPaths?: () => {dataDir?: string, files?: string[]}, now?: () => number,
 *          infoOf?: typeof sessionInfoOf, getAgent?: (sessionId: string) => any, describeTarget?: (settingId: string) => any}} deps
 *   infoOf：读会话现在的 preset（D112），默认只看会话头；getAgent：按会话 id 找活着的 agent（子代理找父会话用）；
 *   describeTarget：按 SettingId 读适配器给的场合描述（D113：审不了时只有公开目标才改口；读不到就是 null）
 */
export function createEgress({ getPm, claims, tooltable, guard, assembler, hostConfig, log, recallNonces, protectedPaths = () => ({}), dormant = () => false, now = () => Date.now(),
  infoOf = sessionInfoOf, getAgent = () => undefined, describeTarget = () => null, media = null }) {
  const features = () => hostConfig().features ?? {};
  const ecfg = () => hostConfig().egress ?? {};
  /** callId → {list: [{token, textHash, text}], returns, sessionId, at}（被后面的监听器或守卫拦下、永远等不到 post-execute 的，过期丢掉） */
  const tokens = new Map();
  const TOKEN_TTL_MS = 30 * 60_000;
  const prune = () => {
    if (tokens.size < 64) return;
    const cut = now() - TOKEN_TTL_MS;
    for (const [k, v] of tokens) if (v.at < cut) tokens.delete(k);
    while (tokens.size > 2000) tokens.delete(tokens.keys().next().value);
  };
  /** 冻结：配置里的名单，或者任何一个绑定（启用的、停用的都算）声明了这个工具要冻结（B13）。 */
  const frozen = (name) => {
    if (features().freeze === false) return false;
    if (isFrozenTool(name, hostConfig().freeze?.tools)) return true;
    for (const { binding } of claims.bindings()) {
      try { if (typeof binding?.isFrozenTool === 'function' && binding.isFrozenTool(name) === true) return true; } catch { /* 绑定出错不影响别的 */ }
    }
    return false;
  };
  const frozenReason = () => hostConfig().freeze?.reason || '这些现在由记忆插件负责';
  const PROTECTED_REASON = '这是记忆插件自己的设置和数据，只能由主人在 DSH 设置里的「记忆」管理页看和改，工具碰不到。';
  const isProtected = (exec) => { try { return touchesProtected(exec, protectedPaths()); } catch { return false; } };
  const stats = { frozenDenied: 0, protectedDenied: 0, appraised: 0, speak: 0, reconsider: 0, hold: 0, failClosed: 0, failOpen: 0, offPassed: 0,
    unclassifiedPassed: 0, adapterAppraised: 0, silent: 0, coreDownDenied: 0, coreDownPassed: 0, tooManyTargets: 0,
    outcomes: { sent: 0, failed: 0 }, ingested: 0, tainted: 0, toolBlocks: 0, inheritedClaims: 0, orphanDenied: 0, orphanPassed: 0, inheritedTaints: 0,
    lessonOutcomes: 0, lessonNudges: 0, lessonBlocks: 0 };

  const finalReflection = () => ecfg().finalReflection || '这次先不说了';
  const maxTargets = () => { const n = Number(ecfg().maxTargets); return Number.isInteger(n) && n > 0 ? n : 64; };
  /**
   * 会话里还有没有记忆（本周期注入过、带内容的条目）：场合、总开关是后来才关的，早先注入的还在她的上下文里。
   * 读不到（核心出错、旧核心没有这个接口）按「有」（fail closed）。
   */
  const holdsMemory = (claim, also = []) => {
    if (!claim?.sessionId) return false;
    for (const id of [claim.sessionId, ...also]) {
      try { if (getPm()?.sessions?.holdsMemory?.(id) !== false) return true; } catch { return true; }
    }
    return false;
  };
  /**
   * 生效档：对话所在场合和目标场合里有一个开着就是 live；读不到按 live（fail closed）。两边都被主人关掉、
   * 会话里也没有早先注入的记忆，才是 off。
   */
  const effectiveMode = (claim, u, also = []) => {
    const ms = [claim?.settingId, u?.channel?.targetSettingId].filter(Boolean).map((s) => assembler.modeOf(s));
    return ms.length && ms.every((m) => m === 'off') && !holdsMemory(claim, also) ? 'off' : 'live';
  };
  /**
   * 目标里有没有宿主读得到、而且是公开的场合（任何人可见或公开留存，D113）。读不到描述的不算公开（fail open 只在确定不是公开目标时）。
   * @param {any[]} list  Utterance（或 null）
   */
  const anyPublic = (list) => {
    for (const u of list ?? []) {
      const sid = u?.channel?.targetSettingId;
      if (typeof sid !== 'string' || !sid) continue;
      let d = null;
      try { d = describeTarget(sid); } catch { d = null; }
      // 描述是异步给的（契约允许 describeSetting 返回 Promise）：这里等不了，按读不到的公开目标处理（改口，不放行）
      if (d && typeof d.then === 'function') { Promise.resolve(d).catch(() => {}); return true; }
      try { if (d && isPublicLike(d)) return true; } catch { /* 描述不完整：不算公开 */ }
    }
    return false;
  };
  /**
   * 审不了（D113）：公开目标照旧改口；其余放行（fail open）。两边的记忆都被主人关掉的照旧只记录、放行。
   * also：分叉出来的会话带着的那几个父会话（它们注入过的记忆跟着分叉的前缀一起过来了，holdsMemory 也要问它们）。
   */
  const failClosed = (claim, why, u = null, also = [], list = null) => {
    if (effectiveMode(claim, u, also) === 'off') { stats.offPassed += 1; log.info('egress.offPassed', { why }); return null; }
    if (anyPublic(list ?? [u])) {
      stats.failClosed += 1;
      log.warn('egress.failClosed', { why });
      return deny(finalReflection());
    }
    stats.failOpen += 1;
    log.warn('egress.failOpen', { why });
    return null;
  };
  /** 核心用不了（没打开、打开失败、只读）：公开目标改口，其余放行（D113 fail open）。 */
  const coreDown = (why, list = []) => {
    if (anyPublic(list)) {
      stats.coreDownDenied += 1;
      stats.failClosed += 1;
      log.warn('egress.coreUnavailable', { why });
      return deny(finalReflection());
    }
    stats.coreDownPassed += 1;
    stats.failOpen += 1;
    log.warn('egress.coreUnavailable.passed', { why });
    return null;
  };
  /** 一次调用要说到的那几个 Utterance（解析不出来就是空的）。 */
  const utterancesOf = (decl, exec, exCtx) => {
    try {
      if (typeof decl?.resolveAll === 'function') return (decl.resolveAll(exec.arguments, exCtx) ?? []).filter(Boolean);
      const one = decl?.resolve?.(exec.arguments, exCtx);
      return one ? [one] : [];
    } catch { return []; }
  };
  const headerOf = (a) => { const h = a?.session?.header ?? a?.header ?? null; return h && typeof h === 'object' ? h : null; };
  /** DSH 自己的规矩（session-controller、dsh-subagent）：origin 'subagent' 或委派深度 > 0 才是子代理；只带 parentSession 的是分叉出来的普通会话。 */
  const isSubagentHeader = (h) => !!h && (h.origin === 'subagent' || (Number(h.delegationDepth) || 0) > 0);
  /** 像不像她的会话：符合某个绑定声明的会话特征（插件预设、桥接的工作目录……）。 */
  const looksHers = (agent) => {
    let info;
    try { info = infoOf(agent); } catch { return false; }
    for (const { binding } of claims.bindings()) {
      try { if (matchesSignature(info, binding?.sessionSignature?.())) return true; } catch { /* 绑定出错不算 */ }
    }
    return false;
  };
  /** 子代理 → 看到过的父会话的认领（父会话的 agent 下线、认领被 forget 以后，还在跑的子代理照这个审）。只在内存里，最多 500 个。 */
  const lineage = new Map();
  const rememberLineage = (sid, claim) => {
    if (!sid || !claim) return;
    lineage.delete(sid);
    lineage.set(sid, claim);
    while (lineage.size > 500) lineage.delete(lineage.keys().next().value);
  };
  /**
   * 子代理自己不认领（不感知、不注入、没有记忆工具），但它们是从她的会话里派出来的：fork 出来的子代理带着父会话已经做完的轮次
   * （里面有注入过的记忆），拿得到全局的说话工具（D112：插件预设照抄标准模式，带 subagent / subagent_fork / workflow）。
   * 所以外发按父会话的认领审（沿 parentSession 往上找，只走子代理这一串；只用于外发和按轮污点，别的一概不给）。
   * 只用已经认上的（claims.get；不在这里触发认领：这条路没有消息、看不到证据，D112 集成）。
   * 返回 {claim} = 照这个审；{orphan:true} = 父会话已经不在了（或者链太长）、可这一串像是她的会话：审不了，说话类工具放行（orphanPassed），
   * 只有公开目标改口（D113）；
   * null = 不是子代理，或者父会话在、但不是她的会话（和父会话一样不管）。
   */
  const inheritedClaim = (agent) => {
    let header = headerOf(agent);
    if (!isSubagentHeader(header)) return null;
    const sid = agentId(agent);
    const seen = new Set([sid]);
    let hers = looksHers(agent);
    let gone = true;
    for (let depth = 0; depth < 8; depth += 1) {
      const pid = typeof header?.parentSession === 'string' ? header.parentSession : '';
      if (!pid || seen.has(pid)) break;
      seen.add(pid);
      const known = claims.get(pid);
      if (known) { rememberLineage(sid, known); return { claim: known }; }
      let parent;
      try { parent = getAgent(pid); } catch { parent = undefined; }
      if (!parent) break;                                  // 父会话的 agent 已经不在了
      if (looksHers(parent)) hers = true;
      header = headerOf(parent);
      if (!isSubagentHeader(header)) { gone = false; break; }   // 走到了一个活着、没认领的普通会话：它不是她，子代理也一样不管
    }
    if (!gone) return null;
    const remembered = lineage.get(sid);
    if (remembered) return { claim: remembered };
    return hers ? { orphan: true } : null;
  };
  /** 分叉出来的普通会话（isSeeded + parentSession）带着的父会话 id：它们注入过的记忆跟着前缀过来了。最多 4 层。 */
  const seededFrom = (agent) => {
    const out = [];
    let header = headerOf(agent);
    for (let depth = 0; depth < 4 && header?.isSeeded === true && typeof header.parentSession === 'string' && header.parentSession; depth += 1) {
      if (out.includes(header.parentSession)) break;
      out.push(header.parentSession);
      let parent;
      try { parent = getAgent(header.parentSession); } catch { parent = undefined; }
      header = headerOf(parent);
    }
    return out;
  };
  /** {claim, inherited} | {orphan:true} | null */
  const claimOf = (agent) => {
    const sid = agentId(agent);
    if (!sid) return null;
    const own = claims.get(sid) ?? claims.resolve(infoOf(agent));
    if (own) return { claim: own, inherited: false };
    const inh = inheritedClaim(agent);
    if (inh?.claim) { stats.inheritedClaims += 1; return { claim: inh.claim, inherited: true }; }
    return inh;
  };
  /** 父会话不在了的子代理（像是她的）：审不了。说话类工具只有目标是公开场合时改口，其余放行（D113 fail open）；未分类的放行。 */
  const orphanDecision = (exec) => {
    const hit = tooltable.lookup(exec.name, null);
    if (!hit || !SPEAKING_CLASSES.includes(hit.decl.class) || hit.decl.appraisedBy === 'adapter') return null;
    if (anyPublic(utterancesOf(hit.decl, exec, { callId: String(exec.callId ?? '') }))) {
      stats.orphanDenied += 1;
      stats.failClosed += 1;
      log.warn('egress.failClosed', { why: 'parent-gone' });
      return deny(finalReflection());
    }
    stats.orphanPassed += 1;
    stats.failOpen += 1;
    log.warn('egress.failOpen', { why: 'parent-gone' });
    return null;
  };
  /** 已经审过能说的那几句：记下令牌等 post-execute 回报，并告诉适配器（关口③的对账，§9.5）。 */
  /** 对一句审过的话回报：有令牌直接回报；超时放行的那句（late）等审视晚到的令牌再回报（不等、不抛错）。 */
  const report = (p, fn) => {
    if (p.token) { try { fn(p.token); } catch { /* 不抛错的接口 */ } return; }
    if (!p.late) return;
    Promise.resolve(p.late).then((a) => { if (a?.token) { try { fn(a.token); } catch { /* 不抛错的接口 */ } } }, () => {});
  };
  const remember = (exec, claim, hit, passed) => {
    if (!passed.length) return;
    if (exec.callId) {
      prune();
      tokens.set(String(exec.callId), { list: passed.map((p) => ({ token: p.token, late: p.late ?? null, textHash: p.textHash, text: p.text })), returns: hit.decl.returns !== false, sessionId: claim.sessionId, at: now() });
    }
    for (const p of passed) { if (p.token) { try { hit.binding?.noteAppraisal?.(p.u, p.token); } catch { /* 适配器出错不影响放行 */ } } }
  };

  /** 我们自己的判定。null = 不拦（交给后面的监听器）；{kind:'deny'} = 拒绝。 */
  async function decide(exec) {
    if (features().egress === false || hostConfig().enabled === false) return null;
    if (!exec?.agent) return null;                    // 不是在会话里调的
    const owner = claimOf(exec.agent);
    if (!owner) return null;                          // 不是她的会话
    if (owner.orphan) return orphanDecision(exec);    // 她的会话派出来的子代理，父会话已经不在了：审不了
    const { claim } = owner;
    const also = seededFrom(exec.agent);
    const hit = tooltable.lookup(exec.name, claim);
    if (!hit) {
      tooltable.noteUnclassified(exec.name);
      if (!hasLongFreeText(exec.arguments, ecfg().unclassifiedMinChars ?? 40)) return null;
      // D113：放行，管理页提示补分类（原来记忆开着就拒绝）
      stats.unclassifiedPassed += 1;
      log.warn('egress.unclassified', { tool: String(exec.name ?? '?').slice(0, 64) });
      return null;
    }
    const { decl } = hit;
    if (!SPEAKING_CLASSES.includes(decl.class)) return null;
    const exCtx = { sessionId: claim.sessionId, callId: String(exec.callId ?? ''), homeSettingId: claim.settingId };
    if (typeof decl.silent === 'function') {
      let quiet = false;
      try { quiet = decl.silent(exec.arguments, exCtx) === true; } catch { quiet = false; }
      if (quiet) { stats.silent += 1; return null; }   // 这次没说新的话（暂停、列出、删除……）
    }
    if (decl.appraisedBy === 'adapter') { stats.adapterAppraised += 1; return null; }   // 适配器在自己的汇合点审（核心用不了时它拿到的是改口）
    /** @type {any[]|null} */
    let list = null;
    try {
      if (typeof decl.resolveAll === 'function') list = decl.resolveAll(exec.arguments, exCtx);
      else { const one = decl.resolve?.(exec.arguments, exCtx); list = one ? [one] : []; }
    } catch (e) { log.warn('egress.resolve', { tool: exec.name, error: errCode(e) }); list = null; }
    const raw = Array.isArray(list) ? list : [];
    const us = raw.filter((u) => u && u.channel && Array.isArray(u.text))
      .map((u) => ({ ...u, origin: { path: 'tool', sessionId: claim.sessionId, ...(exec.callId ? { callId: String(exec.callId) } : {}), homeSettingId: claim.settingId, ...(u.origin ?? {}) } }));
    const resolved = us.length > 0 && us.length === raw.length;
    const pm = getPm();
    // 核心用不了：公开目标改口，其余放行（D113 fail open）
    if (!pm || pm.readOnly === true) return coreDown(!pm ? 'not-open' : 'read-only', us);
    // 有一个目标解析不出来，整个调用就当审不了（不能只审解析得出来的那几个）
    if (!resolved) return failClosed(claim, 'unresolved', us[0] ?? null, also, us);
    // 目标太多审不过来：也当审不了（不能只审前面那些就放行）
    if (us.length > maxTargets()) { stats.tooManyTargets += 1; return failClosed(claim, 'too-many-targets', us[0], also, us); }
    // 逐个场合审（共用一个总时限）：全都 speak 才放行；有一个不能说，整个调用拒绝（已经审过能说的那几条记 failed：没发出去）
    const deadline = now() + (ecfg().appraiseTimeoutMs ?? 12_000);
    const passed = [];
    /** 收尾：真的拒绝了，审过能说的记 failed；放行的（包括记忆关着的场合审不了照常放行），审过能说的那几句照常等 post-execute 回报。 */
    const finish = (result) => {
      if (result) {
        for (const p of passed) report(p, (tk) => pm.expression.outcome(tk, 'failed', { textHash: p.textHash }));
        return result;
      }
      remember(exec, claim, hit, passed);
      return null;
    };
    for (const u of us) {
      stats.appraised += 1;
      const ap = pm.expression.appraise(u, exec.signal);
      const r = await settleWithin(ap, Math.max(1, deadline - now()));
      if (!r.value) {
        const fc = failClosed(claim, r.timedOut ? 'timeout' : `error:${errCode(r.error)}`, u, also, [u]);
        if (fc) return finish(fc);
        // 审不了、不是公开目标：这一句放行。审视晚到时还会给令牌：post-execute 等它到了照常回报（发出去的这句照样记成她说过的话，评审）
        if (r.timedOut) { const text = u.text.join('\n'); passed.push({ token: null, late: ap, textHash: textHash(text), text, u }); }
        continue;
      }
      const a = r.value;
      const text = u.text.join('\n');
      if (a.verdict === 'speak') { passed.push({ token: a.token, textHash: textHash(text), text, u }); continue; }
      if (a.verdict === 'hold') {
        stats.hold += 1;
        try { pm.expression.outcome(a.token, 'held', { textHash: textHash(text) }); } catch { /* 不抛错的接口 */ }
        return finish(deny(`${a.reflection || '这句先不发'}（先存下来，等主人看过再说）`));
      }
      stats.reconsider += 1;
      // 她改口了：这句没发出去（不等 post-execute，被拒的调用不一定有）
      try { pm.expression.outcome(a.token, 'failed', { textHash: textHash(text) }); } catch { /* 不抛错的接口 */ }
      return finish(deny(a.reflection || finalReflection()));
    }
    stats.speak += 1;
    return finish(null);
  }

  /** 熔断中的 pre-execute：说话类工具当审不了——公开目标改口，其余放行（D113 fail open）；别的放行。 */
  function whenOpen(exec) {
    const own = claims.get(agentId(exec?.agent));
    const inh = own ? null : inheritedClaim(exec?.agent);
    if (inh?.orphan) return orphanDecision(exec);
    const claim = own ?? inh?.claim ?? null;
    if (!claim) return null;
    const hit = tooltable.lookup(exec.name, claim);
    if (!hit || !SPEAKING_CLASSES.includes(hit.decl.class) || hit.decl.appraisedBy === 'adapter') return null;
    const list = utterancesOf(hit.decl, exec, { sessionId: claim.sessionId, callId: String(exec.callId ?? ''), homeSettingId: claim.settingId });
    const pm = getPm();
    if (!pm || pm.readOnly === true) return coreDown('breaker', list);
    return failClosed(claim, 'breaker', list[0] ?? null, seededFrom(exec?.agent), list);
  }

  async function preExecute(exec, next) {
    if (dormant()) return next();   // 还没走首次设置（D128）：插件完全不管事，桥接自带的记忆照常用
    // 0. 硬底线：先于一切（不看模式、不需要核心，§15.2、§9.6）
    let isFrozen = false;
    try { isFrozen = frozen(exec?.name); } catch { isFrozen = false; }
    if (isFrozen) {
      stats.frozenDenied += 1;
      return deny(frozenReason());
    }
    if (isProtected(exec)) {
      stats.protectedDenied += 1;
      log.warn('egress.protected', { tool: String(exec?.name ?? '?').slice(0, 64) });
      return deny(PROTECTED_REASON);
    }
    const sid = agentId(exec?.agent);
    const mine = await guard.run('pre-execute', sid, () => decide(exec), (why) => (why === 'open' || why === 'error' ? whenOpen(exec) : null));
    if (mine) return mine;
    return next();
  }

  /** 纯代码的硬底线（F15：同步、只能拒绝，在 pre-execute 之后）：冻结清单、插件自己的文件兜底（pre-execute 的监听器被熔断也还在）。 */
  function guardCheck(exec) {
    if (dormant()) return undefined;
    try { if (frozen(exec?.name)) return frozenReason(); } catch { /* 守卫永不抛错 */ }
    if (isProtected(exec)) return PROTECTED_REASON;
    return undefined;
  }

  /** 工具结果里有没有像样的文字（没分类的工具按素材打污点用）。 */
  const hasText = (content, min) => {
    const parts = Array.isArray(content) ? content : content == null ? [] : [content];
    let n = 0;
    for (const b of parts) {
      const t = typeof b === 'string' ? b : b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '';
      n += charLen(t.trim());
      if (n >= min) return true;
    }
    return false;
  };

  // ── 她自己的经验（D124）──────────────────────────────────────────────────
  // 她的每次工具调用（记忆工具除外）成没成交给核心：只有工具名和一小段出错说明。
  //   - 这个工具在这个会话里先没成、换了做法这次成了：下一步带一句提醒——要是摸到了下次用得上的做法，可以记成经验（只提醒一次）；
  //   - 有这个工具的经验、这个会话还没按它想过（或者经验多了）：按这个工具想一次（回想的 tools），结果带进下一步。
  /** sid → Map(工具 → {n: 当时有几条, at}) / Set(提醒过的工具)。只在内存里，有上限。 */
  const lessonAsked = new Map();
  const LESSON_REASK_MS = 30 * 60_000;
  const lessonText = (tool) => `（刚才 ${tool} 先没成，换了做法这次成了。要是摸到了下次用得上的做法，可以用 memory_note 记成经验：kind 写 lesson，tool 写 ${tool}。）`;
  /** 工具结果里的第一段文字（出错说明）。 */
  const errorTextOf = (content) => {
    const list = Array.isArray(content) ? content : [];
    const t = list.find((x) => x?.type === 'text' && typeof x.text === 'string' && x.text.trim());
    return t ? clip(t.text.trim(), 200) : 'error';
  };
  async function lessonsAfter(exec, result, d) {
    const pm = getPm();
    if (typeof pm?.lessons?.toolOutcome !== 'function' || hostConfig().lessons?.enabled === false || features().lessons === false) return [];
    if (d?.kind !== 'accept' || MEMORY_TOOLS.includes(exec?.name)) return [];
    const sid = agentId(exec?.agent);
    const claim = sid ? claims.get(sid) : null;
    if (!claim) return [];
    // 工具的身份带服务前缀（不同服务的同名工具不混，评审）；给她看的提醒里也写这个全名，她记经验时照抄就对得上
    const tool = String(exec.name ?? '').trim();
    if (!tool) return [];
    const failed = !!result?.isError;
    const o = pm.lessons.toolOutcome({ sessionId: sid, tool, ok: !failed, ...(failed ? { error: errorTextOf(Array.isArray(d.content) ? d.content : result?.content) } : {}) });
    stats.lessonOutcomes += 1;
    let mine = lessonAsked.get(sid);
    if (!mine) { mine = { tools: new Map(), nudged: new Set() }; lessonAsked.set(sid, mine); if (lessonAsked.size > 500) lessonAsked.delete(lessonAsked.keys().next().value); }
    const extra = [];
    if (o?.recovered && hostConfig().lessons?.nudge !== false && !mine.nudged.has(tool)) {
      mine.nudged.add(tool);
      extra.push(createUserMessage({ content: [{ type: 'text', text: lessonText(tool) }], source: { kind: SOURCE_KIND, form: `lesson-hint:${randomId(12)}` } }));
      stats.lessonNudges += 1;
    }
    const n = Number(o?.lessons) || 0;
    const prev = mine.tools.get(tool);
    if (n > 0 && features().inject !== false && (!prev || n > prev.n || now() - prev.at > LESSON_REASK_MS)) {
      mine.tools.set(tool, { n, at: now() });
      const tf = typeof assembler.toolFocus === 'function' ? assembler.toolFocus(claim, [], null) : { trigger: 'message', focusObsId: null, focusObsIds: [] };
      const block = await assembler.blockFor(claim, { trigger: tf.trigger, focusObsId: tf.focusObsId, focusObsIds: tf.focusObsIds, tools: [tool], signal: exec.signal });
      if (block) { extra.push(block.msg); stats.lessonBlocks += 1; }
    }
    return extra;
  }

  async function after(exec, result, d) {
    const out = await afterTool(exec, result, d);
    let extra = [];
    try { extra = await lessonsAfter(exec, result, out ?? d); } catch (e) { log.warn('egress.lessons', { error: errCode(e) }); extra = []; }
    if (!extra.length || (out ?? d)?.kind !== 'accept') return out;
    const base = out ?? d;
    return { ...base, additionalContexts: [...(base.additionalContexts ?? []), ...extra] };
  }

  async function afterTool(exec, result, d) {
    const pm = getPm();
    if (!pm) return d;
    const key = String(exec?.callId ?? '');
    const sid = agentId(exec?.agent);
    const failed = !!result?.isError || d?.kind === 'block';
    const tk = key ? tokens.get(key) : null;
    if (tk) {
      tokens.delete(key);
      for (const x of tk.list) {
        report(x, (token) => pm.expression.outcome(token, failed ? 'failed' : 'sent', tk.returns ? { textHash: x.textHash, returns: true } : { textHash: x.textHash, text: x.text }));
        stats.outcomes[failed ? 'failed' : 'sent'] += 1;
      }
    }
    const rn = key ? recallNonces.get(key) : null;
    if (rn) {
      recallNonces.delete(key);
      if (!failed && d?.kind === 'accept') pm.sessions.confirm(rn.sessionId, rn.nonce);
      else pm.sessions.abort(rn.sessionId);
    }
    if (d?.kind !== 'accept' || failed || MEMORY_TOOLS.includes(exec?.name)) return d;
    const claim = sid ? claims.get(sid) : null;
    if (!claim) {
      // 她的会话派出来的子代理读进来的东西（网页、群消息、文件、命令输出……）会经 subagent / workflow 的结果回到她这一轮：
      // 给父会话这一轮打按轮污点（不入库、不注入，子代理自己一概不给，D112 集成）
      const inh = inheritedClaim(exec?.agent);
      if (inh?.claim?.sessionId) {
        const h = tooltable.lookup(exec.name, inh.claim);
        const content = Array.isArray(d.content) ? d.content : result?.content;
        const taints = !h ? true : h.decl.class === 'read' ? h.decl.taints !== false : h.decl.taints === true;
        if (taints && hasText(content, h ? 1 : (ecfg().unclassifiedMinChars ?? 40))) {
          pm.sessions.markTurnTaint(inh.claim.sessionId, { tainted: true, reason: `sub:${h ? bareName(exec.name) : 'unclassified'}`.slice(0, 64) });
          stats.tainted += 1;
          stats.inheritedTaints += 1;
        }
      }
      return d;
    }
    const hit = tooltable.lookup(exec.name, claim);
    const content = Array.isArray(d.content) ? d.content : result?.content;
    // 她用工具看了一条消息里的媒体（结果带图片，或者是配置里声明的看媒体工具，D116）：记下是哪一条，等她看完之后的想法和回话
    if (media) { try { media.onToolResult(claim, exec, content); } catch { /* 只影响「看过的媒体」 */ } }
    if (hit?.decl?.class !== 'read') {
      // 没分类的工具、读文件 / 跑命令的自带工具：读进来的文字不知道是谁写的，按素材打污点（fail closed，§9.6），不入库
      const taints = hit ? hit.decl.taints === true : true;
      if (taints && hasText(content, hit ? 1 : (ecfg().unclassifiedMinChars ?? 40))) {
        pm.sessions.markTurnTaint(sid, { tainted: true, reason: (hit ? `read:${bareName(exec.name)}` : 'read:unclassified').slice(0, 64) });
        stats.tainted += 1;
      }
      return d;
    }
    // 读进来的内容当场入库（不等读文件）
    const obs = assembler.observeNow(claim, [{ type: 'tool/result', data: { callId: key, name: exec.name, arguments: exec.arguments, content, isError: !!result?.isError }, seq: -1 }]);
    stats.ingested += obs.length;
    // 认触发者（D104）：绑定认出来的、对她说的那条；认不出来取最后一条对她说的；都没有才退回最后一条（和 pre-step 同一个规矩）
    let resolved = null;
    if (obs.length) { try { resolved = claim.binding?.resolveFocus?.({ tool: exec.name, args: exec.arguments, content, homeSettingId: claim.settingId }) ?? null; } catch { resolved = null; } }
    // 她读到了别人对她说的新消息：记进这一轮「看到的」，记忆工具的触发消息跟着换（D114）
    if (obs.length) { try { assembler.noteSeen?.(claim, obs, resolved); } catch { /* 只影响记忆工具认触发消息 */ } }
    // 按轮污点（§9.6）：素材或无权限者的文字进了这一轮的上下文
    if (hit.decl.taints !== false) { pm.sessions.markTurnTaint(sid, { tainted: true, reason: `read:${bareName(exec.name)}`.slice(0, 64) }); stats.tainted += 1; }
    if (!obs.length || features().inject === false || hostConfig().inject?.onToolResults === false) return d;
    // 焦点只从这一轮新看到的里挑（D115 集成复核）：翻历史读到的旧话不当焦点、不让核心记成这一轮的触发者；
    // 这一轮没有触发消息、也没读到新的 → idle（她自己开启的轮里读历史，不把几个小时前对她说话的人又变回「眼前这个人」）
    const tf = typeof assembler.toolFocus === 'function' ? assembler.toolFocus(claim, obs, resolved)
      : { trigger: 'message', focusObsId: pickFocus(obs, resolved)?.id ?? null, focusObsIds: pickFoci(obs, resolved, { max: hostConfig().inject?.maxTriggers ?? 3 }).map((o) => o.id) };
    const block = await assembler.blockFor(claim, { trigger: tf.trigger, focusObsId: tf.focusObsId, focusObsIds: tf.focusObsIds, signal: exec.signal });
    if (!block) return d;
    stats.toolBlocks += 1;
    return { ...d, additionalContexts: [...(d.additionalContexts ?? []), block.msg] };
  }

  async function postExecute(exec, result, next) {
    const d = await next();
    const sid = agentId(exec?.agent);
    const out = await guard.run('post-execute', sid, () => after(exec, result, d), () => d);
    return out ?? d;
  }

  return { preExecute, postExecute, guardCheck, decide, status: () => ({ ...stats, outcomes: { ...stats.outcomes }, pendingTokens: tokens.size }) };
}
