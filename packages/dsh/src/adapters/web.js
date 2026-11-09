// DSH 网页适配器（§11.3）：主人在 DSH 自己的界面里和她聊天。
//   - 认领要有「本机界面发起的会话」的正面证据（preset 在配置的网页 preset 里——默认就是插件自己的 Agent 预设，主人在「新建任务」
//     的下拉里选它，D112；宿主给的 SessionInfo.preset 是会话现在的预设（会话投影），不是冻结的会话头——或主人手动绑定了这个会话；
//     不是子代理、不是委派出来的、工作目录不在排除的前缀下），返回 confidence:'fallback'；
//     子代理按 DSH 自己的规矩认：origin 'subagent' 或 delegationDepth > 0。只带 parentSession 的是主人从菜单里「分叉会话」
//     分出来的普通会话（DSH 的 SessionController.fork），按它自己现在的预设认（D112 集成）；
//     「没有 principal 字段」本身不算证据（F24），也不写「没有被 QQ 认领」这种对别的适配器的依赖；
//     辅助证据（附录 G）：网页客户端发的消息都带 source.clientTimeZone，以主人身份连进来的 API 客户端（桥接这类）不带——
//     按 preset 认领时，这一步的用户消息一条都没带它就不认（手动绑定的不看这一条）；因为这个被拒过的会话，之后不带用户消息的那几步
//     （工具结果之后的续步）也不认，直到有一条带时区的消息来（D112：不然换短了的重试间隔会在续步上把 API 客户端的会话认上）；
//     这一步的消息里有远程访客的 principal：直接认领成「和这位访客」的场合，主人的记忆一开始就不会注入给他；
//   - user/message 且 source.kind === 'user'：不带 principal → 主人；带 principal → 远程访问的那个人，受众按他来算：
//     这个会话从此改记在「和这位访客」的场合下（之前注入给主人的东西不会再给他，§10.3）；
//     source.kind === 'schedule' → 她自己定的提醒（reminder）；别的 source.kind（注入、运行时上下文、压缩摘要）不是经历；
//   - assistant/message 就是她说的话（self-utterance），模型文本直接就是发言；
//   - 场合：2 人、closed、participants、logged；capabilities.preSendGate: false（没有发出前的拦截点，关口①按 §9.3.4 收紧）。
// 宿主把会话事件交给适配器（deps.sessions.onMessage / onSession），适配器经 start(sink) 提交；
// DSH 绑定的 fromSessionEvent 是同一个映射（同一个 ObsId），宿主两条路都走也只会去重。
// 经 sink 提交只在宿主给了 gate（总开关，§10.1）时才做：没有 gate 就分不出 off 的场合，这时只靠宿主自己的绑定那条路
// （它在 observe 前查过 modeOf），这里只跟踪会话归属（远程访客），不提交（fail closed）。
// 规矩：只依赖 'rugu-core/contract'、../binding/ 和 node 内置模块。
import { opaqueFrom } from 'rugu-core/contract';
import { mkLog, isRecord, resolveSalt } from './util.js';

export const ADAPTER_ID = 'dsh-web';
const SALT_NAME = 'web';

const PRINCIPAL = Object.freeze({ kind: 'principal', strength: 'config' });
const TEXT_MAX = 32_000;

/**
 * @typedef {object} WebAdapterConfig
 * @property {string[]} [presets]              「这是她」的网页会话用的 preset（正面证据之一）
 * @property {string[]} [sessionIds]           配置里手动指定的会话（`host.adapters.web.sessionIds`，热加载时放宽要主人确认）
 * @property {string[]} [excludeCwdPrefixes]   这些工作目录下的会话不认（例如桥接的 agent 目录）
 * @property {string} [principalLabel]         她对主人的称呼，默认「主人」
 * @property {string[]} [selfNames]
 * @property {boolean} [requireClientTimeZone]  按 preset 认领时要不要网页客户端的时区标记（默认 true）
 */
/**
 * 宿主交来的一条会话事件。两种形状都认：宿主会话中心（host/hub.js）的 {sessionId, claim, type, data, seq}，
 * 或者 {sessionId, event: {type, data, seq}, settingId}。宿主把所有会话的事件都发过来，这里只收认领给网页适配器的。
 * @typedef {object} WebSessionEvent
 * @property {string} sessionId
 * @property {{settingId: string, adapterId: string}|null} [claim]
 * @property {string} [type]
 * @property {unknown} [data]
 * @property {number} [seq]
 * @property {{type: string, data: unknown, seq: number}} [event]
 * @property {string} [settingId]
 * @property {number} [at]                 事件时间（毫秒）
 */
/**
 * @typedef {object} WebSessions            宿主提供的会话钩子（每个都返回取消订阅的函数）
 * @property {(cb: (e: WebSessionEvent) => void) => (() => void)} onMessage
 * @property {(cb: (info: import('../binding/index.js').SessionInfo & {settingId?: string}) => void) => (() => void)} [onSession]
 * @property {(sessionId: string, settingId: string) => void} [rebind]   会话改记到别的场合时通知宿主（远程访客出现）
 */

/**
 * @param {{salt?: Buffer|string, paths?: {dshHome?: string, dataDir?: string, keyFile?: string}, sessions?: WebSessions,
 *          config?: WebAdapterConfig|(() => WebAdapterConfig), log?: unknown, now?: () => number,
 *          gate?: (settingId: string) => boolean,
 *          presetRoster?: {nameOf: (id: string) => string|null, available: (id: string) => boolean|null, own?: () => string|null}}} deps
 *   presetRoster：宿主报的 DSH 预设下拉（D112）：预设叫什么、现在在不在下拉里（null = 不知道）、插件自己的预设是哪个。只用于管理页的说法和自检
 *   salt：不给就从身份哈希密钥派生（util.resolveSalt）；
 *   gate：这个场合现在要不要感知（宿主给 `(sid) => pm.modeOf(sid) !== 'off'`，§10.1 总开关）；不给就不经 sink 提交（见文件头）
 */
export function createWebAdapter(deps) {
  if (!isRecord(deps)) throw Object.assign(new TypeError('网页适配器：需要 deps'), { code: 'PM_ADAPTER_DEPS' });
  // 派生用的名字是宿主配置里的键 'web'（不是适配器 id）：照同一算法算的盐都一样，场合 id 不变
  const { salt, source: saltSource } = resolveSalt(deps, ADAPTER_ID, SALT_NAME);
  const log = mkLog(deps.log);
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const cfg = () => { try { const c = typeof deps.config === 'function' ? deps.config() : deps.config; return isRecord(c) ? c : {}; } catch { return {}; } };
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  const label = () => (typeof cfg().principalLabel === 'string' && cfg().principalLabel.trim() ? cfg().principalLabel.trim().slice(0, 20) : '主人');

  const OWNER_SETTING = opaqueFrom(salt, 'dsh-web/setting', 'owner');
  /** 远程访客 → 场合（按访客分，不按会话分：同一位访客的几个会话记在一起）。 */
  const remotes = new Map();          // settingId → {actor, name}
  /** 会话 → 现在记在哪个场合。 */
  const sessionSetting = new Map();
  const stats = { observed: 0, ignored: 0, ungated: 0, remoteSessions: 0, claims: 0, claimNoTimeZone: 0, errors: 0 };
  /** 因为消息不带网页客户端的时区被拒过的会话（只在内存里，最多记 500 个）。 */
  const noTz = new Set();
  const roster = isRecord(deps.presetRoster) ? deps.presetRoster : null;
  const presetName = (id) => { try { const n = roster?.nameOf?.(id); return typeof n === 'string' && n.trim() ? n.trim().slice(0, 40) : id; } catch { return id; } };
  const presetAvailable = (id) => { try { const v = roster?.available?.(id); return v === true || v === false ? v : null; } catch { return null; } };
  const quote = (ids) => ids.map((id) => `「${presetName(id)}」`).join('、');
  const hasGate = typeof deps.gate === 'function';
  let sink = null;
  let unsubs = [];

  /** 远程访客的身份：principal 对象的规范 JSON 做 HMAC 当账号 id（不存原样）。 */
  function remoteOf(principal, register = true) {
    const canon = JSON.stringify(sortKeys(principal));
    const id = opaqueFrom(salt, 'dsh-web/principal', canon);
    const settingId = opaqueFrom(salt, 'dsh-web/setting', 'remote', canon);
    const nameRaw = principal.displayName ?? principal.name ?? principal.label;
    const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim().slice(0, 60) : '';
    const actor = { claims: [{ kind: 'account', namespace: ADAPTER_ID, id, verifiedBy: 'platform', ...(name ? { displayName: name } : {}) }] };
    if (register && !remotes.has(settingId)) remotes.set(settingId, { actor, name });
    return { settingId, actor };
  }

  function describe(settingId) {
    if (settingId === OWNER_SETTING) {
      return {
        id: OWNER_SETTING, label: `和${label()}的 DSH 聊天`, labelKind: 'description', stability: 'persistent',
        audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
        disclosure: { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true },
        ownership: { owner: { claims: [{ ...PRINCIPAL }] }, herRole: '助理', herModerates: false, actsOnBehalfOfPrincipal: true },
        capabilities: { preSendGate: false, canHold: false },
        attending: true,
      };
    }
    const r = remotes.get(settingId);
    if (!r) return null;
    return {
      id: settingId, label: r.name ? `和${r.name}的 DSH 聊天` : '和一位远程访客的 DSH 聊天', labelKind: 'description', stability: 'persistent',
      audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
      disclosure: { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true },
      ownership: { owner: r.actor, herRole: '主人的助理', herModerates: false, actsOnBehalfOfPrincipal: true },
      capabilities: { preSendGate: false, canHold: false },
      attending: true,
    };
  }

  /** 会话现在记在哪个场合：见过远程访客的会话记到访客那里，否则是主人。 */
  const settingOfSession = (sessionId, claimed) => sessionSetting.get(sessionId) ?? (claimed && (claimed === OWNER_SETTING || remotes.has(claimed)) ? claimed : OWNER_SETTING);

  /**
   * 一条会话事件 → Observation（零条或一条）。纯映射，fromSessionEvent 和 onMessage 两条路共用。
   * @returns {{obs: import('rugu-core/contract').Observation[], moved?: string}}
   */
  function mapEvent(ev, claimed, sessionId, at, { peek = false } = {}) {
    if (!isRecord(ev) || typeof sessionId !== 'string' || !sessionId) return { obs: [] };
    const msg = isRecord(ev.data?.message) ? ev.data.message : isRecord(ev.data) ? ev.data : null;
    if (!msg) return { obs: [] };
    const seq = Number.isSafeInteger(ev.seq) && ev.seq >= 0 ? ev.seq : undefined;
    const time = Number.isFinite(at) && at > 0 ? at : timeOf(msg.time ?? ev.data?.time) ?? now();
    const { text, truncated, media } = contentOf(msg.content);
    if (!text.trim() && !media.length) return { obs: [] };
    let settingId = settingOfSession(sessionId, claimed);
    let moved;
    let o;
    // ObsId：DSH 的每条消息都有稳定的 id（createMessage 给的 UUID）。宿主在 pre-step 里交 claimed 消息（没有日志序号）、
    // 在 session/event 里再交一次（有序号），两条路必须得到同一个 ObsId，所以优先用消息 id
    const msgId = typeof msg.id === 'string' && msg.id ? msg.id : null;
    const common = (sid) => ({
      id: msgId ? opaqueFrom(salt, 'dsh-web/msg', msgId) : opaqueFrom(salt, 'dsh-web/obs', sessionId, seq ?? -1, seq === undefined ? time : 0),
      settingId: sid, visibleTo: 'participants', at: time, perceivedAt: Math.max(now(), time),
      text, ...(truncated ? { textTruncated: true } : {}), ...(media.length ? { media } : {}),
      ...(seq !== undefined ? { sessionRef: { sessionId, seq } } : { sessionRef: { sessionId } }),
    });
    if (ev.type === 'user/message') {
      const src = isRecord(msg.source) ? msg.source : {};
      if (src.kind === 'user') {
        let actor = { claims: [{ ...PRINCIPAL }] };
        if (isRecord(src.principal) && src.principal.kind !== 'owner') {
          const r = remoteOf(src.principal, !peek);
          actor = r.actor;
          if (settingId !== r.settingId) { settingId = r.settingId; moved = r.settingId; }
        }
        o = { ...common(settingId), actor, kind: 'utterance', addressed: 'to-her', attention: 'attended', evidential: true, standing: 'first-hand' };
      } else if (src.kind === 'schedule') {
        // 她自己定的提醒到了：前瞻记忆的触发，不是有人在说话；提醒的框架文字是系统生成的
        o = { ...common(settingId), actor: { self: true, claims: [] }, kind: 'reminder', addressed: 'to-her', attention: 'attended', evidential: false, standing: 'platform' };
      } else return { obs: [] };
    } else if (ev.type === 'assistant/message') {
      o = { ...common(settingId), actor: { self: true, claims: [] }, kind: 'self-utterance', addressed: 'by-her', attention: 'attended', evidential: true, standing: 'first-hand' };
    } else return { obs: [] };
    return { obs: [o], moved };
  }

  const mine = (sid) => sid === OWNER_SETTING || remotes.has(sid);
  const gate = (sid) => { try { return typeof deps.gate !== 'function' || deps.gate(sid) !== false; } catch { return false; } };
  function onMessage(e) {
    try {
      if (!sink || !isRecord(e) || typeof e.sessionId !== 'string') return;
      // 只收认领给网页适配器的会话（宿主把所有会话的事件都发过来；别的适配器的、没人认领的一律不感知，fail closed）
      let claimed = null;
      if (isRecord(e.claim)) {
        if (e.claim.adapterId !== ADAPTER_ID) return;
        claimed = typeof e.claim.settingId === 'string' ? e.claim.settingId : null;
      } else if ('claim' in e) {
        return;                                  // 宿主说了：这个会话没人认领
      } else if (typeof e.settingId === 'string') {
        if (!mine(e.settingId)) return;
        claimed = e.settingId;
      } else if (!sessionSetting.has(e.sessionId)) return;
      const ev = isRecord(e.event) ? e.event : { type: e.type, data: e.data, seq: e.seq };
      const { obs, moved } = mapEvent(ev, claimed, e.sessionId, e.at);
      if (moved) moveSession(e.sessionId, moved);
      if (!obs.length) { stats.ignored += 1; return; }
      // 没有总开关就不经 sink 提交：交给宿主那条查过 modeOf 的绑定路（fail closed）
      if (!hasGate) { stats.ungated += 1; return; }
      if (!gate(obs[0].settingId)) { stats.ignored += 1; return; }
      sink.observe(obs);
      stats.observed += obs.length;
    } catch (err) { stats.errors += 1; log.warn('web.observe.error', { name: String(err?.name ?? 'Error') }); }
  }
  /** 会话改记到访客的场合。notify=false：认领时就定下来的，宿主拿到的认领结果本来就是对的，不用 rebind。 */
  function moveSession(sessionId, settingId, { notify = true } = {}) {
    if (sessionSetting.get(sessionId) === settingId) return;
    sessionSetting.set(sessionId, settingId);
    stats.remoteSessions += 1;
    log.info('web.session.remote', {});
    const d = describe(settingId);
    if (d && sink) { try { sink.describe(d); } catch { /* sink 出错不影响认领 */ } }
    if (notify) { try { deps.sessions?.rebind?.(sessionId, settingId); } catch { /* 宿主没有这个钩子也行 */ } }
  }

  /** 正面证据：配置的 preset 或手动绑定；排除子代理、委派、排除的工作目录、已归档。 */
  function claimSession(s) {
    try {
      if (!s || typeof s.id !== 'string' || !s.id) return null;
      if (s.origin === 'subagent' || (Number(s.delegationDepth) || 0) > 0) return null;
      const header = isRecord(s.header) ? s.header : {};
      // 只带 parentSession 的是分叉出来的普通会话（DSH 只把 origin 'subagent' 当子代理）：照常按它自己的预设认
      if (header.archived === true || header.origin === 'subagent' || (Number(header.delegationDepth) || 0) > 0) return null;
      const c = cfg();
      const cwd = typeof s.cwd === 'string' ? s.cwd.replace(/\\/g, '/').toLowerCase() : '';
      if (cwd && list(c.excludeCwdPrefixes).some((p) => cwd.startsWith(p.replace(/\\/g, '/').toLowerCase()))) return null;
      const bound = list(c.sessionIds).includes(s.id);
      const byPreset = typeof s.preset === 'string' && list(c.presets).includes(s.preset);
      if (!bound && !byPreset) return null;
      // 这一步 claimed 的消息（宿主在 pre-step 里放进 SessionInfo.messages）：真人发来的那几条
      const users = (Array.isArray(s.messages) ? s.messages : [])
        .filter((m) => isRecord(m) && m.role === 'user' && isRecord(m.source) && m.source.kind === 'user');
      const remote = users.map((m) => m.source.principal).find((p) => isRecord(p) && p.kind !== 'owner') ?? null;
      const tz = users.some((m) => typeof m.source.clientTimeZone === 'string' && m.source.clientTimeZone.trim());
      if (!bound && !remote && c.requireClientTimeZone !== false && !tz && (users.length || noTz.has(s.id))) {
        stats.claimNoTimeZone += users.length ? 1 : 0;   // 不是网页客户端发的（以主人身份连进来的 API 客户端）：不认
        if (users.length) { noTz.add(s.id); if (noTz.size > 500) noTz.delete(noTz.values().next().value); }
        return null;
      }
      noTz.delete(s.id);
      stats.claims += 1;
      if (remote) {
        const r = remoteOf(remote);
        moveSession(s.id, r.settingId, { notify: false });
        return { settingId: r.settingId, confidence: 'fallback' };
      }
      const settingId = settingOfSession(s.id);
      if (!sessionSetting.has(s.id)) sessionSetting.set(s.id, settingId);
      return { settingId, confidence: 'fallback' };
    } catch { return null; }
  }

  const binding = {
    adapterId: ADAPTER_ID,
    claimSession,
    sessionSignature: () => ({ presets: list(cfg().presets) }),
    /** 符合会话特征却没认上（这一步的消息不是网页界面发的）：很快再问、不算次数（宿主 claim.js，D112）。只有网页这么做 */
    retryOnSignature: true,
    /** 和 onMessage 同一个映射；远程访客出现时同样改记场合。 */
    fromSessionEvent(ev, setting, sessionId) {
      try {
        const { obs, moved } = mapEvent(ev, setting, sessionId, Number(ev?.at));
        if (moved) moveSession(sessionId, moved);
        return obs;
      } catch { stats.errors += 1; return []; }
    },
    /**
     * 触发这一轮的是这条用户消息本身。ev 可以是 {sessionId, event}、会话事件本身，或者宿主直接给的那条 claimed 消息
     * （DSH 消息带 id，不需要会话 id 也算得出同一个 ObsId）。
     */
    resolveFocus(ev, sessionIdArg) {
      try {
        let e = isRecord(ev?.event) ? ev.event : ev;
        if (isRecord(e) && e.role === 'user' && !e.type) e = { type: 'user/message', data: e };
        const sessionId = typeof ev?.sessionId === 'string' ? ev.sessionId : typeof sessionIdArg === 'string' ? sessionIdArg : '-';
        if (e?.type !== 'user/message') return null;
        return mapEvent(e, ev?.settingId, sessionId, Number(ev?.at), { peek: true }).obs[0]?.id ?? null;
      } catch { return null; }
    },
    /** 网页里她说话不经工具：模型文本本身就是发言（preSendGate:false）。 */
    tools: [],
  };

  return {
    id: ADAPTER_ID,
    protocol: 2,
    /** 管理页上的入口名（D111）。 */
    displayName: 'DSH 网页',
    describeSetting(id) {
      const d = describe(id);
      if (!d) throw new Error('网页适配器：不认识这个场合');
      return d;
    },
    /** 一对一：她和对方。 */
    async members(id) {
      if (id === OWNER_SETTING) return [{ self: true, claims: [] }, { claims: [{ ...PRINCIPAL }] }];
      const r = remotes.get(id);
      return r ? [{ self: true, claims: [] }, r.actor] : null;
    },
    start(s) {
      stop();
      sink = s;
      s.describe(describe(OWNER_SETTING));
      for (const id of remotes.keys()) s.describe(describe(id));
      const sess = deps.sessions;
      if (sess && typeof sess.onMessage === 'function') unsubs.push(sess.onMessage(onMessage));
      if (sess && typeof sess.onSession === 'function') {
        unsubs.push(sess.onSession((info) => {
          try {
            if (isRecord(info) && typeof info.id === 'string' && typeof info.settingId === 'string' && (info.settingId === OWNER_SETTING || remotes.has(info.settingId))) {
              sessionSetting.set(info.id, info.settingId);
            }
          } catch { /* 忽略坏数据 */ }
        }));
      }
      const mine = sink;
      return () => { if (sink === mine) stop(); };
    },
    selfClaims() {
      const names = list(cfg().selfNames).map((n) => n.trim().slice(0, 30)).filter(Boolean).slice(0, 16);
      return names.map((name) => ({ kind: 'display-name', name, observedAt: now() }));
    },
    principalClaims: () => [{ ...PRINCIPAL }],
    /** 网页的场合不能挂起（canHold:false）。 */
    async onHoldDecision(_token, approve) { log.warn('web.hold.unsupported', { approve: !!approve }); },
    binding,
    /** 主人的网页场合（宿主和管理页用）。 */
    ownerSettingId: OWNER_SETTING,
    status: () => ({ started: !!sink, gated: hasGate, saltSource, remotes: remotes.size, sessions: sessionSetting.size, presets: list(cfg().presets), ...stats }),
    /**
     * 【D111】管理页「场合与规则」用：主人的网页场合现在为什么收不到东西（没有任何认领的证据时）。接得上就返回 null。
     * 只说这个入口自己的事实（配置里有没有 preset / 手动绑定的会话），不进提示词。
     */
    quietReason(id) {
      if (id !== OWNER_SETTING) return null;
      const c = cfg();
      const presets = list(c.presets);
      if (list(c.sessionIds).length > 0) return null;
      if (!presets.length) return 'DSH 桌面里的会话现在一个都没接到这里，那边聊的她都记不住、也想不起别处的事。要接上，得在插件配置里指定哪些会话算（诊断页有详情）';
      // D112：算数的预设一个都不在「新建任务」的下拉里（没注册上、激活失败、被关掉）：新会话接不上
      if (presets.every((p) => presetAvailable(p) === false)) return `${quote(presets)}预设现在不在新建任务的列表里，这里接不上新会话（看诊断页自检的「预设」一项）`;
      return null;
    },
    /** 启动自检（§13.2）：宿主总览的形状 {id, level, label}。 */
    selfCheck() {
      const c = cfg();
      const evidence = list(c.presets).length > 0 || list(c.sessionIds).length > 0;
      // 放宽了「哪些会话算跟她聊」的配置（热加载时要确认，可是停着 DSH 改文件、重启时就直接生效了）：自检标出来让主人看得见
      let own = null;
      try { own = typeof roster?.own === 'function' ? roster.own() : null; } catch { own = null; }
      const wider = [
        ...(own ? list(c.presets).filter((p) => p !== own).map((p) => `${quote([p])}预设开的会话也算`) : []),
        ...(list(c.sessionIds).length ? [`${list(c.sessionIds).length} 个手动指定的会话也算`] : []),
        ...(c.requireClientTimeZone === false ? ['不再要求是 DSH 界面里亲手发的消息'] : []),
      ];
      return [
        { id: 'claim-evidence', level: evidence && !wider.length ? 'ok' : 'warn',
          label: evidence ? `网页：${list(c.presets).length ? `新建任务时选了${quote(list(c.presets))}预设的会话算跟主人聊` : '没有按预设认领的会话'}${list(c.sessionIds).length ? `；另有 ${list(c.sessionIds).length} 个手动绑定的会话` : ''}（只认 DSH 界面里亲手发的消息；子代理除外）`
            + (wider.length ? `。注意：配置放宽了——${wider.join('、')}，这些会话会被记住、会收到她的记忆` : '')
            : '网页：没有配置网页 preset 或手动绑定的会话，DSH 界面里的聊天不会被记住（host.adapters.web.presets）' },
        { id: 'salt', level: saltSource === 'local-file' ? 'warn' : 'ok',
          label: saltSource === 'local-file' ? '网页：场合 id 的盐只存在本机数据目录，不在备份包里' : '网页：场合 id 的盐来自身份哈希密钥' },
      ];
    },
  };

  function stop() {
    for (const u of unsubs) { try { if (typeof u === 'function') u(); } catch { /* 已取消 */ } }
    unsubs = [];
    sink = null;
  }
}

/** 消息内容 → 文字（只取 text 块；思考、工具调用不算她说的话）、图片占位。 */
function contentOf(content) {
  let text = '';
  const media = [];
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!isRecord(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      else if (b.type === 'image' || b.type === 'attachment') media.push({ kind: b.type === 'image' ? 'image' : 'file' });
    }
    text = parts.join('\n');
  }
  const truncated = text.length > TEXT_MAX;
  return { text: truncated ? text.slice(0, TEXT_MAX) : text, truncated, media: media.slice(0, 16) };
}

/** 事件里的时间：毫秒数或 ISO 字符串。 */
function timeOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? t : undefined; }
  return undefined;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isRecord(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}
