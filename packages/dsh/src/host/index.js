// DSH 集成层（§10）：把核心接到宿主上。启动顺序照 §10.1：
//   0.（同步）读配置、装端口、ctx.provide('personaMemory', 外壳)、挂全部钩子（核心没打开之前：不感知、不注入；外发钩子审不了，
//      说话类工具往公开的目标说改口，其余放行（D113））；
//   1. 建内置适配器、登记它们的 DSH 绑定（QQ、网页）：会话认领和工具分类只要桥接的文件和配置，不要核心——
//      核心打不开时会话照样认得出来，往公开目标说的话才能照旧改口（插件重启前注入的记忆还在会话记录里）；
//   2. 打开数据库（单写者；迁移前自动备份，核心自己做）；启动 worker（startWorker: true）；打不开就只注册一个只给主人看的状态页；
//   3. 把内置适配器交给核心（开始感知）；排队的外来适配器（bili-eyes）补上；
//   4. 给已经活着的 agent 补注册记忆工具；注册管理接口（只给主人，admin/）；启动调度、资源管家、嵌入健康检查；
//   5. 启动自检（§13.2），结果进总览；不合格的适配器绑定进拒认名单（§10.3）。
// 插件出错只让插件不可用，绝不让 DSH 起不来、绝不影响聊天：每一步都 try/catch，失败的部分在总览标红。
import fs from 'node:fs';
import path from 'node:path';
import { createPersonaMemory } from 'rugu-core';
import { validateBinding } from '../binding/index.js';
import { buildPorts } from '../ports/index.js';
import { createConfigStore } from './config.js';
import { resolveDshHome, resolvePaths, ensureKeyFile, MAIN_DB_FILE } from './paths.js';
import { createLogger } from './log.js';
import { createHookGuard } from './guard.js';
import { createClaims, makeSessionInfoOf } from './claim.js';
import { createToolTable } from './tooltable.js';
import { createSessionStates, agentId } from './session-state.js';
import { createContextAssembler, RESIDENT_CONTEXT } from './context.js';
import { createEgress } from './egress.js';
import { createMediaSeen } from './media.js';
import { createMemoryTools } from './tools.js';
import { runMemoryEvalInWorker } from './eval.js';
import { createServiceFacade } from './service.js';
import { createScheduler } from './scheduler.js';
import { createSessionHub } from './hub.js';
import { runSelfCheck, failedAdapters } from './selfcheck.js';
import { createEmbeddingSetup, createKeyReader } from './embedding-setup.js';
import { createBridgeSetup } from './bridge-setup.js';
import { createGovernor } from './gpu/governor.js';
import { createSystemSampler, resolveKoffiPath } from './gpu/sampler.js';
import { errCode, isPlain } from './util.js';

export const SERVICE_NAME = 'personaMemory';
export { HOST_DEFAULTS } from './config.js';

/** 内置适配器：配置里的键 → 工厂的模块和导出名、必填的配置项。 */
export const BUILTIN_ADAPTERS = Object.freeze([
  { key: 'qq', module: '../adapters/qq-bridge.js', factory: 'createQqBridgeAdapter', requires: { bridgeDir: '桥接目录 host.adapters.qq.bridgeDir' } },
  { key: 'web', module: '../adapters/web.js', factory: 'createWebAdapter', requires: {} },
]);

/** 找 defineTool（和 bili-eyes 同一种找法）。找不到返回 null：记忆工具不注册，自检标出来。 */
export async function loadDefineTool() {
  try { const mod = await import('@deepseek-ai/dsh-tools'); if (typeof mod?.defineTool === 'function') return mod.defineTool; } catch { /* 本地开发时用 DSH_TOOLS_PATH */ }
  if (process.env.DSH_TOOLS_PATH) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(process.env.DSH_TOOLS_PATH).href);
      if (typeof mod?.defineTool === 'function') return mod.defineTool;
    } catch { /* 找不到 */ }
  }
  return null;
}

/** 适配器工厂可以返回 {adapter, binding}，也可以返回带 dshBinding / binding 属性的 PerceptionAdapter。 */
export function splitAdapter(made) {
  if (made && typeof made === 'object' && made.adapter && typeof made.adapter === 'object') return { adapter: made.adapter, binding: made.binding ?? made.adapter.dshBinding ?? null };
  if (made && typeof made === 'object' && made.protocol) return { adapter: made, binding: made.dshBinding ?? made.binding ?? null };
  return { adapter: null, binding: null };
}

async function loadAdapterFactories() {
  const out = {};
  for (const b of BUILTIN_ADAPTERS) {
    try { out[b.key] = (await import(b.module))[b.factory]; } catch (e) { out[`${b.key}Error`] = errCode(e); }
  }
  return out;
}
async function loadRegisterAdmin() {
  try { return (await import('../admin/index.js')).registerAdmin ?? null; } catch { return null; }
}
async function loadFallbackAdmin() {
  try { return (await import('../admin/index.js')).registerFallbackAdmin ?? null; } catch { return null; }
}

const inertHost = (log) => ({
  ready: Promise.resolve(false), dispose: async () => {}, status: () => ({ ready: false, inert: true }), selfCheck: async () => null,
  api: null, log,
});

const codeError = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {any} ctx      Cordis 上下文（插件 inject 了 tools、connection）
 * @param {object} [config]  Cordis 行的 config（低于配置文件）
 * @param {{
 *   env?: NodeJS.ProcessEnv, dshHome?: string, clock?: {now: () => number}, fetchImpl?: typeof fetch,
 *   coreFactory?: typeof createPersonaMemory, coreOptions?: {startWorker?: boolean},
 *   adapterFactories?: Record<string, Function>|null, registerAdmin?: Function|null, registerFallbackAdmin?: Function|null, defineTool?: Function|null,
 *   sampler?: object|null, skipSelfCheckNetwork?: boolean, startServices?: boolean,
 *   preset?: ReturnType<typeof import('../preset/index.js').createPersonaPreset>|null,
 * }} [deps]
 *   preset：插件自己的 Agent 预设（D112，入口 src/index.js 建好、自己启动）。这里只拿它的状态进自检和总览、配置变了让它同步、
 *   网页适配器拿它的名单说「预设在不在下拉里」
 */
export function createHost(ctx, config = {}, deps = {}) {
  const clock = deps.clock ?? { now: () => Date.now() };
  const now = () => clock.now();
  const log = createLogger(ctx, { now });
  if (!ctx || typeof ctx.on !== 'function') { log.warn('host.noContext', {}); return inertHost(log); }

  const ctxGet = (name) => { try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]; } catch { return undefined; } };
  /**
   * 会话现在用的 preset（D112）：DSH 自己的会话投影（从下拉里换过预设的空白会话，会话头还是创建时的那个），
   * 再退到预设服务报的「这个 agent 绑着哪个预设」；都读不到 → undefined（退回会话头）。
   */
  const presetOf = (agent) => {
    try { const p = ctxGet('sessionProjections')?.stateOf?.(agent?.session, 'agentPreset'); if (typeof p === 'string' && p) return p; } catch { /* 读不到 */ }
    try { const p = ctxGet('agentPresets')?.composedPreset?.(agent?.ctx); if (typeof p === 'string' && p) return p; } catch { /* 读不到 */ }
    return undefined;
  };
  const infoOf = makeSessionInfoOf(presetOf);
  const dshHome = deps.dshHome ?? resolveDshHome(deps.env ?? process.env);
  const basePaths = resolvePaths({ dshHome });
  const configStore = createConfigStore({
    file: basePaths.configFile,
    initial: isPlain(config) ? config : {},
    defaults: { core: { backup: { keyFile: basePaths.backupKeyFile, configFile: basePaths.configFile } } },
    onWarn: (w) => log.warn('config.warnings', { count: w.length }),
  });
  const hostConfig = () => configStore.host();
  const features = () => hostConfig().features ?? {};
  const paths = resolvePaths({ dshHome, dataDir: hostConfig().dataDir });

  // 首次设置（D128）：配置文件不存在 = 新装的。先不开库、不接入口、不感知，等主人在管理页走完（或者手写了配置）。
  // 修实测问题 #10（DSH 一看到 profile 变了就热加载，没配置时建出一个多余的空库），也让「会记下群聊」这件事先经主人知道。
  /** @type {{resolve: () => void, promise: Promise<void>, timer: any}|null} */
  let setupGate = null;
  if (deps.firstRun === true) {
    if (setupUnfinished(basePaths.configFile)) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      setupGate = { resolve, promise, timer: null };
    }
  }
  const dormant = () => setupGate !== null;
  let fullAdmin = false;   // 完整的管理页接手了（设置模式的路由已经换掉）
  /** @type {Set<string>} 向导里取消、「关」还没写进核心的场合（D131） */
  const firstRunOff = new Set();

  let pm = null;
  let disposed = false;
  let openError = null;
  let startedAt = null;
  let lastSelfCheck = null;
  let selfCheckRunning = null;
  const getPm = () => (disposed ? null : pm);
  const disposers = [];
  const registered = { resident: false, preStep: false, preExecute: false, postExecute: false, guard: false, sessionEvent: false, agentCreated: false, presetSelected: false };
  /** @type {{id: string, key?: string, adapter?: any, binding?: any, dispose?: Function, unbind?: Function, pending?: boolean, error?: string, hint?: string, disabled?: boolean, selfCheckFailed?: boolean}[]} */
  const adapters = [];

  const states = createSessionStates();
  const guard = createHookGuard({ hostConfig, now, log });
  const claims = createClaims({ hostConfig, getPm, now, log });
  const tooltable = createToolTable({ hostConfig, bindings: () => claims.bindings().filter((b) => b.active).map((b) => ({ adapterId: b.adapterId, binding: b.binding })) });
  const hub = createSessionHub({
    listAgents: () => ctxGet('agents')?.list?.() ?? [],
    infoOf,
    // 网页适配器：会话里出现了远程访客，这个会话改记在「和这位访客」的场合下（§11.3）。之前给主人的常驻区不能再给他
    onRebind: (sid, settingId, adapterId) => {
      if (!claims.rebind(sid, settingId, adapterId)) return;
      const st = states.peek(sid);
      if (st) { st.frozen = null; st.swapOnNext = true; }
      log.info('claim.rebound', { adapter: adapterId ?? '?' });
    },
  });

  let ports = null;
  const governor = createGovernor({
    hostConfig, now, log,
    sampler: deps.sampler !== undefined ? deps.sampler
      : (features().gpu !== false ? createSystemSampler({ koffiPath: process.platform === 'win32' ? resolveKoffiPath({ configured: hostConfig().gpu?.koffiPath }) : null }) : null),
    ownVramMb: () => ports?.embedding?.ownVramMb?.() ?? 0,
    onChange: (next) => { try { ports?.embedding?.onDeviceChange?.(next); ports?.rerank?.onDeviceChange?.(next); } catch { /* 忽略 */ } },
  });
  ports = buildPorts({ ctxGet, configStore, paths, governor, log, clock, fetchImpl: deps.fetchImpl ?? globalThis.fetch, embeddingKey: createKeyReader(paths.embeddingKeyFile) });

  /** 登记一个 DSH 绑定：认领、工具分类表、平台转义。 */
  const addBinding = (b, { active = true } = {}) => {
    const v = validateBinding(b);
    if (!v.ok) { log.warn('binding.invalid', { adapter: String(b?.adapterId ?? '?').slice(0, 32), errors: v.errors.length }); return () => {}; }
    const unclaim = claims.addBinding(b, { active });
    const unsan = b.sanitizer ? ports.sanitizer.register(b.adapterId, b.sanitizer) : () => {};
    return () => { unclaim(); unsan(); };
  };
  const service = createServiceFacade({ log, validateBinding, onBinding: (b) => addBinding(b), finalReflection: () => hostConfig().egress?.finalReflection || '这次先不说了' });
  try { if (typeof ctx.provide === 'function') ctx.provide(SERVICE_NAME, service.facade); } catch (e) { log.warn('service.provide', { error: errCode(e) }); }

  const recallNonces = new Map();
  let defineTool = deps.defineTool ?? null;
  /** @type {ReturnType<typeof createMemoryTools>|null} */
  let memoryTools = null;
  // 她看过的媒体（D116）：认出她用工具看了哪条消息里的媒体，等她看完之后的想法和回话，交给核心写进那条消息
  const media = createMediaSeen({ getPm, states, hostConfig, tooltable, log, now });
  const assembler = createContextAssembler({
    getPm, claims, states, guard, hostConfig, log, now, budget: ports.budget, hub, infoOf, media,
    coreConfig: () => { try { return configStore.core.get(); } catch { return {}; } },
    onClaimed: (agent) => { memoryTools?.registerOn(agent, { claimed: true }); },   // 第一次认领成功时补注册记忆工具
  });
  /** 自检关掉了哪些适配器的记忆工具（disables 里的 'tools:<适配器 id>'；只关一个工具的是 'tools:<适配器 id>/<工具名>'，D156）。 */
  const toolsBlocked = new Set();
  memoryTools = createMemoryTools({ getPm, claims, states, assembler, hostConfig, log, getDefineTool: () => defineTool, recallNonces, blockedFor: (id) => toolsBlocked.has(id), infoOf,
    blockedToolFor: (id, name) => toolsBlocked.has(`${id}/${name}`),   // D156：白名单补丁是旧的时，只关掉还没放行的那几个
    coreConfig: () => { try { return configStore.core.get(); } catch { return {}; } } });   // D125：工具说明的写法跟核心的 context.usageStyle
  const egress = createEgress({
    getPm, claims, tooltable, guard, assembler, hostConfig, log, recallNonces, now, infoOf, media,
    getAgent: (sid) => ctxGet('agents')?.get?.(sid),
    protectedPaths: () => ({ dataDir: paths.dataDir, files: [paths.configFile, paths.keyFile, paths.backupKeyFile, paths.embeddingKeyFile] }),
    dormant,
    // 审不了时只有公开目标才改口（D113）：按 SettingId 问适配器这是什么场合（认不出就是 null）
    describeTarget: (sid) => {
      for (const a of adapters) {
        if (typeof a.adapter?.describeSetting !== 'function' || a.error || a.disabled) continue;
        try { const d = a.adapter.describeSetting(sid); if (d) return d; } catch { /* 不是这个适配器的场合 */ }
      }
      // 外面注册进来的绑定（适配器插件）：绑定自己带 describeSetting 的也问一下
      for (const { binding } of claims.bindings()) {
        if (typeof binding?.describeSetting !== 'function') continue;
        try { const d = binding.describeSetting(sid); if (d) return d; } catch { /* 不认识这个场合 */ }
      }
      return null;
    },
  });

  // ── 钩子（核心没打开之前一律放行 / 空串）──
  const on = (name, fn, opt) => {
    try { const d = ctx.on(name, fn, opt); if (typeof d === 'function') disposers.push(d); return true; } catch (e) { log.warn('hook.register', { hook: name, error: errCode(e) }); return false; }
  };
  const registerResident = () => {
    if (registered.resident) return true;
    const sp = ctxGet('systemPrompt');
    if (typeof sp?.context !== 'function') return false;
    try {
      const d = sp.context({ ...RESIDENT_CONTEXT, text: (c) => assembler.residentText(c) });
      if (typeof d === 'function') disposers.push(d);
      registered.resident = true;
    } catch (e) { log.warn('hook.register', { hook: 'systemPrompt.context', error: errCode(e) }); }
    return registered.resident;
  };
  registerResident();
  registered.preStep = on('agent/pre-step', (ev, next) => assembler.onPreStep(ev, next));
  registered.preExecute = on('tools/pre-execute', (exec, next) => egress.preExecute(exec, next));
  registered.postExecute = on('tools/post-execute', (exec, result, next) => egress.postExecute(exec, result, next));
  registered.sessionEvent = on('session/event', (session, event) => { assembler.onSessionEvent(session, event); });
  // agent/created 是串行派发，监听器出错会让会话创建失败（F12）：同步、不等、不抛
  registered.agentCreated = on('agent/created', (ev) => {
    try { if (pm) memoryTools.registerOn(ev?.agent); } catch { /* 忽略 */ }
    try { hub.emitSession(infoOf(ev?.agent)); } catch { /* 忽略 */ }
  });
  // D112：在空白会话上从「新建任务」的下拉里换了预设（DSH 先重组、再记 agent-preset/selected、再发这个事件）。
  // 不认的缓存清掉、记忆工具按新的组合重新注册（换进插件预设的会话马上有工具；换出去的拿掉），会话中心重新报一次。
  // reuseSetup 这条路上 agent 还没发布（agents.get 拿不到）：之后的 agent/created 会按会话投影注册。
  /** 只有计数：看到过几次换预设、其中几次换进插件预设、几次当时拿得到 agent（活的 DSH 里核实下拉流程用）。 */
  const presetSelections = { seen: 0, intoPlugin: 0, liveAgent: 0 };
  registered.presetSelected = on('agent-preset/selected', (sessionId, presetId) => {
    try {
      const sid = typeof sessionId === 'string' ? sessionId : String(sessionId?.id ?? '');
      if (!sid) return;
      presetSelections.seen += 1;
      if (deps.preset && presetId === deps.preset.id) presetSelections.intoPlugin += 1;
      claims.forget(sid);
      const a = ctxGet('agents')?.get?.(sid);
      if (!a) return;
      presetSelections.liveAgent += 1;
      memoryTools.unregister(a);
      if (pm) memoryTools.registerOn(a);
      hub.emitSession(infoOf(a));
    } catch { /* 忽略 */ }
  });
  // 配置变了（热加载、管理页）：预设的名字、说明、开关跟着变
  if (deps.preset && typeof configStore.onHostChange === 'function') {
    try { disposers.push(configStore.onHostChange(() => { try { deps.preset.sync?.(); } catch { /* 忽略 */ } })); } catch { /* 忽略 */ }
  }
  on('agent/disposed', (ev) => {
    try { const sid = agentId(ev?.agent); memoryTools.unregister(ev?.agent); states.delete(sid); claims.forget(sid); } catch { /* 忽略 */ }
  });
  try {
    if (typeof ctx.tools?.guard === 'function') {
      const d = ctx.tools.guard((exec) => { try { return egress.guardCheck(exec); } catch { return undefined; } });
      if (typeof d === 'function') disposers.push(d);
      registered.guard = true;
    }
  } catch (e) { log.warn('hook.register', { hook: 'tools.guard', error: errCode(e) }); }

  /**
   * 心跳（§13.2）：适配器在 status().heartbeat 里报「来源那边收到的条数」和「交上来的条数」（QQ：social-v2 的 lastUnreadSeq 增量）。
   * 差距连续 3 次 tick 扩大就报警（不依赖文件修改时间，来源切到别的模式也报得出来）。只有数字。
   */
  const heartbeat = new Map();
  function checkHeartbeat() {
    for (const a of adapters) {
      let hb = null;
      try { hb = a.adapter?.status?.()?.heartbeat ?? null; } catch { hb = null; }
      if (!hb || !Number.isFinite(hb.bridgeReceived) || !Number.isFinite(hb.observedIncoming)) continue;
      const gap = Math.max(0, hb.bridgeReceived - hb.observedIncoming);
      const h = heartbeat.get(a.id) ?? { gap, rising: 0, alarm: false };
      h.rising = gap > h.gap ? h.rising + 1 : gap < h.gap ? 0 : h.rising;
      h.gap = gap;
      const alarm = h.rising >= 3;
      if (alarm && !h.alarm) log.warn('heartbeat.gap', { adapter: a.id, gap });
      h.alarm = alarm;
      heartbeat.set(a.id, h);
    }
  }

  const scheduler = createScheduler({
    getPm, hostConfig, log, now,
    onTick: () => {
      configStore.reload();
      ports.selfProfile.refresh();
      ports.budget.refreshBalance();
      try { checkHeartbeat(); } catch { /* 只是诊断 */ }
    },
  });

  // ── 配置（管理页和 gpu.setPolicy 共用）──
  /** 管理页看到的配置：核心的参数表在顶层（mode、budget、sleep、backup、retention……），集成层的在 host 下。 */
  const configView = () => {
    const c = configStore.get();
    return { ...c.core, host: c.host, meta: { file: c.file, warnings: [...c.warnings], loadError: c.loadError, pendingRisky: [...(c.pendingRisky ?? [])] } };
  };
  /**
   * 写配置（热加载）。主人在管理页改的才走这里；聊天和工具没有任何改配置的路（§9.6）。
   * 要确认的改动没带 confirm → 抛 CONFIRM_REQUIRED（管理页走确认流程再来）；不许经配置改的项 → 抛 CONTRACT。
   */
  const setConfig = (patch0, opt = {}) => {
    // 向导走到一半（D128）：配置文件虽然已经写了（嵌入、桥接），但主人还没确认告知，重启后也要接着走向导
    const patch = dormant() && isPlain(patch0?.host) && patch0.host.setup?.inProgress === undefined ? { ...patch0, host: { ...patch0.host, setup: { ...(patch0.host.setup ?? {}), inProgress: true } } } : patch0;
    const r = configStore.set(patch, { confirm: opt?.confirm === true, ...(Array.isArray(opt?.replace) ? { replace: opt.replace.filter((x) => typeof x === 'string') } : {}) });
    if (r.rejected?.length) throw codeError('CONTRACT', r.rejected.join('；'));
    if (r.needsConfirm?.length) throw Object.assign(codeError('CONFIRM_REQUIRED', `要先确认：${r.needsConfirm.join('；')}`), { needsConfirm: [...r.needsConfirm] });
    if (!r.ok) throw codeError('UNAVAILABLE', r.warnings.join('；') || '配置没写进去');
    try { governor.evaluate(); } catch { /* 忽略 */ }
    return { ok: true, warnings: [...r.warnings] };
  };

  const embeddingSetup = createEmbeddingSetup({ hostConfig, setConfig, keyFile: paths.embeddingKeyFile, fetchImpl: deps.fetchImpl ?? globalThis.fetch, log, now, ...(deps.execFile ? { execFile: deps.execFile } : {}), noVectorsYet: dormant });
  const bridgeSetup = createBridgeSetup({ hostConfig, setConfig, sessionsDir: path.join(paths.dshHome, 'sessions'), log });
  /** 首次设置走完：写配置，放行后面的开库。参数都是可选的，什么都不填也能完成。 */
  async function finishSetup(p) {
    if (!setupGate) throw codeError('CONFLICT', '已经设置过了');
    try { await embeddingSetup.settleDefault(); } catch (e) { log.warn('setup.settle', { error: errCode(e) }); }
    const self = {};
    if (p.principalLabel) self.principalLabel = p.principalLabel;
    const adapters = {};
    if (p.selfNames?.length) adapters.qq = { selfNames: p.selfNames };
    const patch = { host: { setup: { completedAt: now(), acknowledged: true, inProgress: false, ...(p.offGroups?.length ? { offGroups: p.offGroups } : {}) },
      ...(Object.keys(self).length ? { self } : {}), ...(Object.keys(adapters).length ? { adapters } : {}), ...(p.presetName ? { preset: { name: p.presetName } } : {}) } };
    setConfig(patch, { confirm: true });
    log.info('setup.finished', {});
    openGate();
    return { ok: true };
  }
  function openGate() {
    const g = setupGate;
    if (!g) return;
    setupGate = null;
    if (g.timer) clearInterval(g.timer);
    g.resolve();
  }

  // ── 给管理页的 host 对象（admin/ 的固定接口）──
  const hostApi = {
    embeddingSetup,
    bridgeSetup,
    setup: {
      /** needed：还没走首次设置；starting：走完了，核心还在打开。 */
      status: () => ({ needed: dormant(), starting: !dormant() && !fullAdmin && !openError, dataDir: paths.dataDir, configFile: paths.configFile, retention: '2y' }),
      finish: finishSetup,
    },
    paths: Object.freeze({ dataDir: paths.dataDir, exportDir: paths.exportDir, configFile: paths.configFile }),
    status: () => status(),
    /** 启动自检的结果；force=true 重新检查。 */
    selfCheck: (o) => (o?.force === true || !lastSelfCheck ? selfCheck() : Promise.resolve(lastSelfCheck)),
    gpu: {
      status: () => governor.status(),
      /**
       * 'off'|'on'|'adaptive'（管理页：主人在只给主人的页面上点的，页面自己提示「开」档的风险），
       * 或 {policy?, gameMode?: {on: boolean, hours?: number}, confirm?: boolean}。
       */
      setPolicy(p) {
        const o = typeof p === 'string' ? { policy: p, confirm: true } : isPlain(p) ? p : {};
        const gpu = {};
        if (o.policy) gpu.policy = o.policy;
        if (o.gameMode) gpu.gameMode = { until: o.gameMode.on ? (Number(o.gameMode.hours) > 0 ? now() + Number(o.gameMode.hours) * 3_600_000 : -1) : 0 };
        if (!Object.keys(gpu).length) throw codeError('CONTRACT', '要给 policy 或 gameMode');
        const r = setConfig({ host: { gpu } }, { confirm: o.confirm === true });
        return { ...r, gpu: governor.status() };
      },
    },
    budget: { status: () => ports.budget.status() },
    /** 【D126】「有记忆 / 没记忆」评测：在 worker 线程里跑核心包带的评测（临时库、替身端口，不调模型），结果交给核心存下。 */
    memoryEval: {
      run: async () => {
        const r = await runMemoryEvalInWorker({ dataDir: paths.dataDir });
        const pm = getPm();
        return pm?.admin?.evalResult?.set ? pm.admin.evalResult.set({ at: r.at, version: r.version, ms: r.ms, cases: r.cases }) : r;
      },
    },
    config: {
      get: () => configView(),
      set: (patch, opt) => setConfig(patch, opt),
      /** 热加载时扣下的有风险的改动（配置文件被改过）：主人确认后生效，或者丢弃（按现在的设置重写配置文件）。 */
      pending: () => configStore.pending(),
      applyPending: (opt = {}) => {
        const r = configStore.applyPending({ confirm: opt?.confirm === true });
        if (r.needsConfirm?.length) throw Object.assign(codeError('CONFIRM_REQUIRED', `要先确认：${r.needsConfirm.join('；')}`), { needsConfirm: [...r.needsConfirm] });
        if (!r.ok) throw codeError('UNAVAILABLE', r.warnings.join('；') || '配置没写进去');
        try { governor.evaluate(); } catch { /* 忽略 */ }
        return { ok: true, applied: r.applied ?? 0, warnings: [...r.warnings] };
      },
      discardPending: () => {
        const r = configStore.discardPending();
        if (!r.ok) throw codeError('UNAVAILABLE', r.warnings.join('；') || '配置没写进去');
        return { ok: true };
      },
    },
  };

  async function selfCheck() {
    if (selfCheckRunning) return selfCheckRunning;
    selfCheckRunning = (async () => {
      try {
        // 预设的注册通常几毫秒就完（标准模式还没注册时最多等 15 秒）：自检最多等它 3 秒，免得刚启动就报「还在等」
        if (deps.preset?.settled) {
          let t;
          try { await Promise.race([deps.preset.settled(), new Promise((r) => { t = setTimeout(r, 3000); })]); } catch { /* 只是诊断 */ } finally { clearTimeout(t); }
        }
        try { await deps.preset?.refreshRoster?.(); } catch { /* 只是诊断 */ }
        lastSelfCheck = await runSelfCheck({
          ctx, ctxGet, getPm, hostConfig, paths, ports, claims, tooltable, governor, registered, defineToolAvailable: !!defineTool,
          preset: deps.preset ? { status: safeCall(() => deps.preset.status()), roster: safeCall(() => deps.preset.roster()) } : null,
          adapters: [
            ...adapters.map((a) => ({ id: a.id, adapter: a.adapter, binding: a.binding, error: a.error, hint: a.hint, disabled: a.disabled })),
            ...service.entries(),
          ],
          now, skipNetwork: !!deps.skipSelfCheckNetwork,
        });
      } catch (e) {
        lastSelfCheck = { at: now(), level: 'fail', ok: false, items: [{ id: 'selfcheck', group: 'host', area: '宿主', level: 'fail', status: 'fail', label: `自检本身出错（${errCode(e)}）` }] };
      }
      applySelfCheck(lastSelfCheck);
      return lastSelfCheck;
    })();
    try { return await selfCheckRunning; } finally { selfCheckRunning = null; }
  }
  /** 「任何一项失败就关掉对应的部分」（§13.2）：绑定不合格的适配器 → 它的会话特征进拒认名单；修好了（下一次自检通过）再放出来。 */
  function applySelfCheck(r) {
    toolsBlocked.clear();
    for (const x of r?.items ?? []) for (const dis of Array.isArray(x.disables) ? x.disables : []) if (String(dis).startsWith('tools:')) toolsBlocked.add(String(dis).slice(6));
    const failed = failedAdapters(r);
    for (const a of adapters) {
      if (a.disabled || a.error || !a.binding) continue;
      const bad = failed.has(a.id);
      if (bad !== !!a.selfCheckFailed) {
        a.selfCheckFailed = bad;
        claims.setActive(a.id, !bad);
        log.warn(bad ? 'adapter.denied' : 'adapter.restored', { adapter: a.id });
      }
    }
  }

  function status() {
    let core = null;
    try { core = pm?.status?.() ?? null; } catch { core = null; }
    const cfg = configStore.get();
    const ctxStatus = assembler.status();
    const adapterStatus = (a) => { try { return a.adapter?.status?.() ?? null; } catch { return null; } };
    return {
      ready: !!pm && !disposed, error: openError, startedAt, uptimeMs: startedAt ? now() - startedAt : null, dataDir: paths.dataDir, configFile: paths.configFile,
      mode: cfg.core?.mode?.global ?? null, budgetPreset: cfg.core?.budget?.preset ?? null, features: { ...hostConfig().features }, configWarnings: cfg.warnings.length,
      registered: { ...registered },
      degrade: [...ctxStatus.degrade],
      hooks: guard.status(), claims: claims.status(), context: ctxStatus, egress: egress.status(), tools: memoryTools.status(), media: media.status(),
      tooltable: tooltable.status(), scheduler: scheduler.status(), llm: ports.llm.status(), embedding: ports.embedding.status(),
      rerank: ports.rerank?.status?.() ?? { configured: false }, gpu: governor.status(), budget: ports.budget.status(), selfProfile: ports.selfProfile.status(),
      service: service.status(),
      preset: deps.preset ? { ...(safeCall(() => deps.preset.status()) ?? {}), selections: { ...presetSelections } } : null,
      adapters: adapters.map((a) => ({ id: a.id, name: typeof a.adapter?.displayName === 'string' ? a.adapter.displayName.slice(0, 40) : null, ok: !a.error && !a.disabled && !a.selfCheckFailed && !a.pending, disabled: !!a.disabled, error: a.error ?? null, pending: !!a.pending,
        denied: !!a.selfCheckFailed, tools: (a.binding?.tools ?? []).length, status: adapterStatus(a) })),
      heartbeat: Object.fromEntries([...heartbeat].map(([id, h]) => [id, { gap: h.gap, rising: h.rising, alarm: h.alarm }])),
      selfCheck: lastSelfCheck ? { at: lastSelfCheck.at, level: lastSelfCheck.level, fails: lastSelfCheck.items.filter((x) => x.level === 'fail').length, warns: lastSelfCheck.items.filter((x) => x.level === 'warn').length } : null,
      log: { recent: log.recent(), counts: log.counts() }, core,
    };
  }

  /** 这个场合现在要不要感知（给适配器的 gate，§10.1 总开关）：off 不感知；读不到按不感知（fail closed）。 */
  const gate = (settingId) => {
    if (hostConfig().enabled === false || features().observe === false) return false;
    if (firstRunOff.has(settingId)) return false;   // 向导里取消的群，「关」还没写成功：照样不感知（D131，fail closed）
    const p = getPm();
    if (!p) return false;
    return p.modeOf(settingId) !== 'off';
  };
  /**
   * 第一步（核心打开之前）：建内置适配器、登记它们的 DSH 绑定（认领、工具分类、平台转义）。不碰核心，也不开始读桥接的消息
   * （start(sink) 由核心的 registerAdapter 调）。核心打不开时绑定照样在：会话认得出来，外发钩子才能对公开目标照旧改口（D113：其余放行）。
   */
  async function createAdapters() {
    const factories = deps.adapterFactories !== undefined ? (deps.adapterFactories ?? {}) : await loadAdapterFactories();
    // 适配器的盐从身份哈希密钥派生（适配器自己做，见 paths.ensureKeyFile）：没有就按核心同样的格式先建好（核心打开时也会建，不覆盖）。
    // 库已经在了就不建（D140）：密钥丢了时新建一把只会让核心认成「换了密钥」，原因就看不清了；核心会以 IDENTITY_KEY_MISSING 拒绝打开
    if (fs.existsSync(path.join(paths.dataDir, MAIN_DB_FILE)) && !fs.existsSync(paths.keyFile)) log.warn('adapters.keyFile.missing', {});
    else if (!ensureKeyFile(paths.keyFile)) log.warn('adapters.keyFile', {});
    for (const spec of BUILTIN_ADAPTERS) {
      const key = spec.key;
      const factory = factories[key];
      const acfg = hostConfig().adapters?.[key] ?? {};
      if (typeof factory !== 'function') { adapters.push({ id: key, key, error: factories[`${key}Error`] ?? 'NO_FACTORY' }); continue; }
      const missing = Object.entries(spec.requires).filter(([k]) => !(typeof acfg[k] === 'string' && acfg[k].trim()));
      if (acfg.enabled !== false && missing.length) {
        adapters.push({ id: key, key, error: 'NOT_CONFIGURED', hint: missing.map(([, label]) => label).join('、') });
        continue;
      }
      let made;
      try {
        made = factory({
          log: scopedLog(log, key), now,
          // 函数形式：主人在管理页改了配置马上生效（热加载）。主人的称呼没单独配就用 self.principalLabel
          config: () => {
            const c = hostConfig().adapters?.[key] ?? {};
            const label = hostConfig().self?.principalLabel;
            return label && !c.principalLabel ? { ...c, principalLabel: label } : c;
          },
          paths: Object.freeze({ dshHome: paths.dshHome, dataDir: paths.dataDir, keyFile: paths.keyFile, bridgeDir: typeof acfg.bridgeDir === 'string' ? acfg.bridgeDir : '' }),
          sessions: hub.forAdapter(undefined),
          gate,
          // D112：DSH 预设下拉里现在有什么（网页适配器说「预设在不在」、自检写预设的名字用）。QQ 不看它
          presetRoster: Object.freeze({
            nameOf: (id) => safeCall(() => deps.preset?.nameOf?.(id)) ?? null,
            available: (id) => safeCall(() => deps.preset?.available?.(id)) ?? null,
            own: () => (typeof deps.preset?.id === 'string' ? deps.preset.id : null),
          }),
        });
      } catch (e) { adapters.push({ id: key, key, error: errCode(e) }); log.warn('adapter.create', { adapter: key, error: errCode(e) }); continue; }
      const { adapter, binding } = splitAdapter(made);
      if (!adapter) { adapters.push({ id: key, key, error: 'BAD_SHAPE' }); continue; }
      if (acfg.enabled === false) {
        // 停用的适配器：它声明过的会话特征进拒认名单（§10.3），别的适配器不得认领
        const unbind = binding ? addBinding(binding, { active: false }) : () => {};
        adapters.push({ id: adapter.id, key, adapter, binding, disabled: true, dispose: unbind });
        continue;
      }
      const unbind = binding ? addBinding(binding) : () => {};
      adapters.push({ id: adapter.id, key, adapter, binding, pending: true, unbind, dispose: () => { try { unbind(); } catch { /* 尽力 */ } } });
    }
  }
  /**
   * 向导里取消的群（D131），分两步：适配器开始感知之前先挡住（prepare，gate 认 firstRunOff）；核心认识这个适配器之后写成「这个场合关」
   * （describe 要适配器已注册）。写的是普通的场合规则，之后在「场合与规则」里随时能开回来。
   * 全部写成功才清空配置（群号不留在配置里）；没写成的下次启动再写，这次 gate 一直挡着不感知。没有取消过的（线上已有配置都是）这里什么都不做。
   */
  let firstRunOffItems = [];
  function prepareFirstRunOff() {
    const ids = hostConfig().setup?.offGroups ?? [];
    if (!ids.length) return;
    const qq = adapters.find((a) => a.key === 'qq' && a.adapter && !a.error && !a.disabled);
    if (typeof qq?.adapter?.groupSetting !== 'function') { log.warn('setup.offGroups', { reason: 'no-qq', count: ids.length }); return; }
    const items = [];
    for (const id of ids) {
      try { const g = qq.adapter.groupSetting(id); firstRunOff.add(g.settingId); items.push(g); } catch (e) { log.warn('setup.offGroups', { error: errCode(e) }); }
    }
    firstRunOffItems = items.map((g) => ({ ...g, adapterId: qq.adapter.id }));
  }
  function applyFirstRunOff() {
    const items = firstRunOffItems;
    firstRunOffItems = [];
    if (!items.length) return;
    const ids = hostConfig().setup?.offGroups ?? [];
    let done = 0;
    for (const g of items) {
      try {
        pm.describe(g.descriptor(), { adapter: g.adapterId });
        pm.admin.setMode(g.settingId, 'off');
        firstRunOff.delete(g.settingId);
        done += 1;
      } catch (e) { log.warn('setup.offGroups', { error: errCode(e) }); }
    }
    log.info('setup.offGroups', { done, total: ids.length });
    if (done === ids.length) { try { setConfig({ host: { setup: { offGroups: [] } } }, { confirm: true }); } catch (e) { log.warn('setup.offGroups', { error: errCode(e) }); } }
  }
  /** 第二步（核心打开之后）：把建好的适配器交给核心（开始感知）。注册失败的，它的绑定进拒认名单（§10.3）。 */
  function registerAdapters() {
    for (const a of adapters) {
      if (!a.pending) continue;
      a.pending = false;
      let unreg = null;
      try { unreg = pm.registerAdapter(a.adapter); } catch (e) {
        a.error = errCode(e);
        if (a.binding) claims.setActive(a.binding.adapterId, false);
        log.warn('adapter.register', { adapter: a.key, error: a.error });
        continue;
      }
      const unbind = a.unbind ?? (() => {});
      a.dispose = () => { try { unbind(); } catch { /* 尽力 */ } try { unreg?.(); } catch { /* 尽力 */ } };
    }
  }
  /** 核心打不开：只注册一个只给主人看的状态页（出错的代码和几个数字），让主人知道插件现在没在工作。 */
  async function registerFallback() {
    try {
      const reg = deps.registerFallbackAdmin !== undefined ? deps.registerFallbackAdmin : await loadFallbackAdmin();
      closeAdminRoutes();
      if (typeof reg === 'function' && !disposed) { const d = reg(ctx, { host: hostApi, log, now, error: openError }); adminDispose = typeof d === 'function' ? d : null; }
    } catch (e) { log.warn('admin.fallback', { error: errCode(e) }); }
  }

  let adminDispose = null;
  const closeAdminRoutes = () => { const d = adminDispose; adminDispose = null; try { d?.(); } catch { /* 尽力 */ } };
  const ready = (async () => {
    if (hostConfig().enabled === false) { log.info('host.disabled', {}); return false; }
    if (setupGate) {
      // 等首次设置：管理页先以「设置模式」开着（没有核心，只有向导、嵌入、桥接这几条），手写了配置文件的也放行
      log.info('setup.waiting', {});
      try {
        const reg = deps.registerAdmin !== undefined ? deps.registerAdmin : await loadRegisterAdmin();
        if (typeof reg === 'function' && !disposed) { const d = reg(ctx, { pm: null, host: hostApi, log, now, dataDir: paths.dataDir, exportDir: paths.exportDir, setupMode: true }); adminDispose = typeof d === 'function' ? d : null; }
      } catch (e) { log.warn('admin.register', { error: errCode(e) }); }
      if (setupGate) {
        setupGate.timer = setInterval(() => {
          try { if (!setupUnfinished(basePaths.configFile)) { configStore.reload(); openGate(); } } catch { /* 下一次再看 */ }
        }, deps.setupPollMs ?? 3000);
        setupGate.timer.unref?.();
        await setupGate.promise;
      }
      if (disposed) return false;
      log.info('setup.opening', {});
    }
    if (!defineTool && deps.defineTool === undefined) defineTool = await loadDefineTool();
    try { await createAdapters(); } catch (e) { log.warn('adapters.create', { error: errCode(e) }); }
    if (disposed) return false;
    // 打开核心之前先查一次嵌入服务（每个请求自己 3 秒超时，不抛错）：核心打开时的启动探针要用到端口报的模型指纹（实测问题 #1）
    if (deps.startServices !== false) { try { await ports.embedding.checkHealth?.(); } catch { /* 查不了就只看探针 */ } }
    if (disposed) return false;
    try {
      const factory = deps.coreFactory ?? createPersonaMemory;
      const opened = await factory({ ports: ports.core, config: configStore.core, dataDir: paths.dataDir, keyFile: paths.keyFile, startWorker: deps.coreOptions?.startWorker ?? true });
      if (disposed) { try { await opened.close(); } catch { /* 尽力 */ } return false; }
      pm = opened;
    } catch (e) {
      openError = errCode(e);
      log.error('core.open', { error: openError });
      await registerFallback();
      return false;
    }
    service.attach(pm);
    startedAt = now();
    try { prepareFirstRunOff(); } catch (e) { log.warn('setup.offGroups', { error: errCode(e) }); }
    try { registerAdapters(); } catch (e) { log.warn('adapters.start', { error: errCode(e) }); }
    try { applyFirstRunOff(); } catch (e) { log.warn('setup.offGroups', { error: errCode(e) }); }
    if (disposed) return false;
    registerResident();
    try {
      const reg = deps.registerAdmin !== undefined ? deps.registerAdmin : await loadRegisterAdmin();
      closeAdminRoutes();   // 设置模式的路由（如果有）换成完整的
      if (typeof reg === 'function' && !disposed) { const d = reg(ctx, { pm, host: hostApi, log, now, dataDir: paths.dataDir, exportDir: paths.exportDir }); adminDispose = typeof d === 'function' ? d : null; }
      fullAdmin = true;
    } catch (e) { log.warn('admin.register', { error: errCode(e) }); }
    if (deps.startServices !== false && !disposed) {
      scheduler.start();
      governor.start();
      ports.embedding.startHealth();
    }
    // 自检先跑（它决定哪些适配器的会话现在给不了记忆工具），再给已经活着的 agent 补注册
    if (features().selfCheck !== false && !disposed) await selfCheck();
    if (disposed) return false;
    try { for (const a of ctxGet('agents')?.list?.() ?? []) { memoryTools.registerOn(a); hub.emitSession(infoOf(a)); } } catch (e) { log.warn('tools.existing', { error: errCode(e) }); }
    log.info('host.ready', { adapters: adapters.filter((a) => !a.error && !a.disabled).length });
    return true;
  })().catch(async (e) => {
    openError = openError ?? errCode(e);
    log.error('host.start', { error: errCode(e) });
    if (!pm && !adminDispose) await registerFallback();
    return false;
  });

  async function dispose() {
    if (disposed) return;
    disposed = true;
    openGate();
    scheduler.stop();
    governor.stop();
    memoryTools.disposeAll();
    for (const d of disposers.splice(0).reverse()) { try { d(); } catch { /* 尽力 */ } }
    const closeAdmin = () => { const d = adminDispose; adminDispose = null; try { d?.(); } catch { /* 尽力 */ } };
    closeAdmin();
    await ready.catch(() => {});
    closeAdmin();   // ready 里刚注册上的
    for (const a of adapters.splice(0)) { try { a.dispose?.(); } catch { /* 尽力 */ } }
    service.detach();
    const p = pm;
    pm = null;
    try { await p?.close?.(); } catch { /* 尽力 */ }
    ports.dispose();
    states.clear();
  }

  return { ready, dispose, status, selfCheck, api: hostApi, service: service.facade, log, configStore, paths, getPm: () => pm, claims, tooltable, governor, ports, registered, assembler, egress, media, tools: memoryTools, scheduler, checkHeartbeat };
}

/** 首次设置还没走完：配置文件不存在，或者向导写了一半。判断不了（读不了、JSON 坏了）就当走完了，按原来的路开库并在总览报错。 */
function setupUnfinished(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return e?.code === 'ENOENT'; }
  try { return JSON.parse(txt.replace(/^\uFEFF/, ''))?.host?.setup?.inProgress === true; } catch { return false; }
}

/** 诊断用的调用：出错就 null。 */
function safeCall(fn) { try { return fn() ?? null; } catch { return null; } }

/** 适配器用的日志：事件名前面加适配器 id。 */
function scopedLog(log, id) {
  const wrap = (fn) => (event, fields) => fn(`adapter.${id}.${event}`, fields);
  return { debug: wrap(log.debug), info: wrap(log.info), warn: wrap(log.warn), error: wrap(log.error) };
}
