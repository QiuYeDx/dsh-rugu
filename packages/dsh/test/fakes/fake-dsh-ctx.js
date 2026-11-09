// FakeDshCtx：DSH 宿主上下文的替身，只模仿集成层用到的那几样（形状照 @deepseek-ai 宿主包的源码，见 docs/调研/v2/v0/v0-实验插件.md）：
//   ctx.on(name, fn, {prepend})          事件监听；waterfall（pre-step、pre-execute、post-execute）、serial（agent/created）、emit
//   ctx.get(name) / ctx.provide / ctx.set 服务
//   ctx.tools.register / guard           全局工具和守卫（守卫同步、只能拒绝，F15）
//   ctx.connection.fetch.register        只给主人的 Fetch 路由（管理页用）
//   systemPrompt.context({name, order, required, interpolate, text})   provider 同步（F1）
//   agents.list / get                    活着的 agent
//   llm.stream(opts)                     按脚本吐 chunk（text-delta / usage / finish）
//   sessionProjections.stateOf(session, 'agentPreset')   会话现在的预设：会话头，之后被 agent-preset/selected 事件推进（照 DSH 的预设注册表）
//   ctx.inject(deps, cb) / sub.effect(fn)  服务都在了才跑 cb；服务撤掉时 effect 的 disposer 跑掉，重新提供时再跑一次
//   agentPresets（installPresets() 装上）：FakePresetRegistry，definitions / register / list / composedPreset / select
// 另外给测试用的驱动：preStep()、preExecute()、postExecute()、sessionEvent()、agentCreated()、resolveContexts()。
export class FakeDshCtx {
  constructor({ llmScript = null } = {}) {
    this.listeners = new Map();
    this.services = new Map();
    this.provided = new Map();
    this.lines = [];
    this.logger = {
      debug: (m) => this.lines.push(['debug', m]), info: (m) => this.lines.push(['info', m]),
      warn: (m) => this.lines.push(['warn', m]), error: (m) => this.lines.push(['error', m]),
    };
    const globalTools = [];
    const guards = [];
    this.tools = {
      registered: globalTools,
      guards,
      register: (def) => { globalTools.push(def); return () => { const i = globalTools.indexOf(def); if (i >= 0) globalTools.splice(i, 1); }; },
      guard: (fn) => { guards.push(fn); return () => { const i = guards.indexOf(fn); if (i >= 0) guards.splice(i, 1); }; },
      guardReason: (exec) => { for (const g of guards) { const r = g(exec); if (r !== undefined) return r; } return undefined; },
    };
    const routes = [];
    this.connection = { fetch: { routes, register: (r) => { routes.push(r); return () => { const i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1); }; } } };
    const contexts = new Map();
    this.systemPrompt = {
      contexts,
      context: (c) => {
        if (!Number.isFinite(c.order)) throw new TypeError('order must be finite');
        if (contexts.has(c.name)) throw new Error(`prompt context "${c.name}" is already registered`);
        contexts.set(c.name, c);
        return () => contexts.delete(c.name);
      },
    };
    const agentMap = new Map();
    this.agents = { map: agentMap, list: () => [...agentMap.values()], get: (id) => agentMap.get(id) };
    this.llmCalls = [];
    this.llmScript = llmScript ?? (() => [{ type: 'text-delta', text: 'ok' }, { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }]);
    const self = this;
    this.llm = {
      async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }; },
      stream(opts) {
        self.llmCalls.push(opts);
        const chunks = self.llmScript(opts);
        return (async function* gen() {
          for (const ch of chunks) {
            if (ch === 'wait') { await new Promise((r) => setTimeout(r, 20)); if (opts.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } }; return; } continue; }
            if (ch instanceof Error) throw ch;
            yield ch;
          }
        })();
      },
    };
    this.services.set('agents', this.agents);
    this.services.set('systemPrompt', this.systemPrompt);
    this.services.set('llm', this.llm);
    // 会话投影（照 dsh-agent-preset-registry 的 agentPresetProjectionDefinition：init 取会话头，agent-preset/selected 推进）
    const selected = new WeakMap();
    this.selectedPresets = selected;
    this.sessionProjections = {
      stateOf: (session, key) => {
        if (key !== 'agentPreset' || !session) return undefined;
        return selected.has(session) ? selected.get(session) : (session.header?.agentPreset ?? null);
      },
    };
    this.services.set('sessionProjections', this.sessionProjections);
    /** ctx.inject 的订阅：{deps, cb, disposers, active} */
    this.injections = [];
    this.baseUrl = 'file:///fake-profile/';
  }

  /** cordis 的 ctx.inject 的替身：deps 里的服务都在才跑 cb(sub)；返回撤销函数。 */
  inject(deps, cb) {
    const entry = { deps: [...deps], cb, disposers: [], active: false };
    this.injections.push(entry);
    this.runInjection(entry);
    return () => { this.stopInjection(entry); const i = this.injections.indexOf(entry); if (i >= 0) this.injections.splice(i, 1); };
  }
  runInjection(entry) {
    if (entry.active || !entry.deps.every((d) => this.get(d) !== undefined)) return;
    entry.active = true;
    const sub = { baseUrl: this.baseUrl, get: (n) => this.get(n), effect: (fn) => { const d = fn(); if (typeof d === 'function') entry.disposers.push(d); } };
    for (const d of entry.deps) sub[d] = this.get(d);
    const r = entry.cb(sub);
    if (typeof r === 'function') entry.disposers.push(r);
  }
  stopInjection(entry) {
    if (!entry.active) return;
    entry.active = false;
    for (const d of entry.disposers.splice(0).reverse()) { try { d(); } catch { /* 尽力 */ } }
  }
  /** 宿主的服务出现 / 撤掉（测试用）：跑或者停掉依赖它的 inject。 */
  setService(name, value) {
    if (value === undefined) {
      for (const e of this.injections) if (e.deps.includes(name)) this.stopInjection(e);
      this.services.delete(name);
      return;
    }
    if (this.services.has(name)) for (const e of this.injections) if (e.deps.includes(name)) this.stopInjection(e);
    this.services.set(name, value);
    for (const e of this.injections) this.runInjection(e);
  }
  /** 装上一个假的预设注册表（DSH 的 agentPresets 服务）。 */
  installPresets(opt = {}) {
    const reg = new FakePresetRegistry(this, opt);
    this.setService('agentPresets', reg);
    return reg;
  }

  on(name, fn, opt = {}) {
    const list = this.listeners.get(name) ?? [];
    const entry = { fn };
    if (opt.prepend) list.unshift(entry); else list.push(entry);
    this.listeners.set(name, list);
    return () => { const l = this.listeners.get(name) ?? []; const i = l.indexOf(entry); if (i >= 0) l.splice(i, 1); };
  }
  get(name) { return this.provided.has(name) ? this.provided.get(name) : this.services.get(name); }
  provide(name, value) {
    if (this.provided.has(name)) throw new Error(`service "${name}" has been registered`);
    this.provided.set(name, value);
    return () => this.provided.delete(name);
  }
  set(name, value) { if (!this.provided.has(name)) throw new Error(`cannot set property "${name}" without provide`); this.provided.set(name, value); return true; }
  count(name) { return (this.listeners.get(name) ?? []).length; }

  async waterfall(name, args, fallback) {
    const ls = [...(this.listeners.get(name) ?? [])].map((l) => l.fn);
    const run = (i) => (i < ls.length ? ls[i](...args, () => run(i + 1)) : fallback());
    return run(0);
  }
  emit(name, ...args) { for (const l of [...(this.listeners.get(name) ?? [])]) l.fn(...args); }
  async serial(name, ...args) { for (const l of [...(this.listeners.get(name) ?? [])]) await l.fn(...args); }

  // ── 驱动 ──
  /** agent/pre-step：默认结果把 claimed 原样放进 messages，后面再跟一条运行时上下文（和 agent-loop 一样）。 */
  preStep(agent, messages, { turn = 1, step = 1, signal = new AbortController().signal, runtimeContext = true } = {}) {
    const ctxMsg = { id: 'rt', role: 'user', content: [{ type: 'text', text: 'Current runtime context' }], source: { kind: 'runtime-context' } };
    return this.waterfall('agent/pre-step', [{ agent, messages, turn, step, signal }], () => Promise.resolve({ kind: 'enter', messages: runtimeContext ? [...messages, ctxMsg] : [...messages] }));
  }
  /** tools/pre-execute 瀑布，再跑守卫（只在放行时，和 dsh-tools 一样）。 */
  async preExecute(exec) {
    const decision = await this.waterfall('tools/pre-execute', [exec], () => Promise.resolve({ kind: 'allow' }));
    const denial = decision.kind === 'allow' ? this.tools.guardReason(exec) : decision.reason;
    return { decision, denial };
  }
  postExecute(exec, result) {
    return this.waterfall('tools/post-execute', [exec, result], () => Promise.resolve({ kind: 'accept' }));
  }
  sessionEvent(session, event) {
    if (event?.type === 'agent-preset/selected' && session) this.selectedPresets.set(session, event.data?.agentPreset ?? null);
    this.emit('session/event', session, event);
    // 预设注册表自己监听 session/event，再发 agent-preset/selected(sessionId, presetId)
    if (event?.type === 'agent-preset/selected') this.emit('agent-preset/selected', session?.id, event.data?.agentPreset);
  }
  async agentCreated(agent, source = { kind: 'create' }) { this.agents.map.set(agent.id, agent); await this.serial('agent/created', { agent, source }); }
  agentDisposed(agent) { this.agents.map.delete(agent.id); this.emit('agent/disposed', { agent }); }
  /** 照 agent-loop 的 assembleContextFor({agent, scope}) 跑全部 context provider。 */
  resolveContexts(agent) {
    return [...this.systemPrompt.contexts.values()].sort((a, b) => a.order - b.order).map((c) => ({ name: c.name, text: typeof c.text === 'function' ? c.text({ agent, scope: agent }) : c.text, interpolate: c.interpolate, required: c.required }));
  }
}

/** 「标准模式」的样子（照 dsh-web-app/presets/standard.patch.yml 缩写：人设行、带 !!js 条件的行、一个组）。 */
export const FAKE_STANDARD_ROWS = Object.freeze([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent powered by the {{model}} model.' } },
  { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } },
  { id: 'delegation', name: 'cordis:group', group: true, isolate: { workflowEngine: true }, config: [{ id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', toolName: 'subagent' } }] },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } },
]);

/**
 * DSH 预设注册表（dsh-agent-preset-registry）的替身：只模仿插件用到的几样。
 *   definitions（内部的 Map：id → {config}）、register(def) → 撤销函数（同 id 重复注册抛 Duplicate agent preset）、
 *   list()（broken 来自 brokenIds）、composedPreset(agentCtx)、select(agent, id)（重组、记 agent-preset/selected）。
 */
export class FakePresetRegistry {
  constructor(ctx, { standard = FAKE_STANDARD_ROWS, standardLater = false } = {}) {
    this.ctx = ctx;
    this.definitions = new Map();
    this.registerCalls = [];
    this.brokenIds = new Set();
    this.bound = new WeakMap();
    this.seq = 9000;
    this.standard = standard ? structuredClone(standard) : null;
    if (this.standard && !standardLater) this.addStandard();
  }
  addStandard(rows = this.standard) { this.definitions.set('standard', { config: { id: 'standard', order: 1, plugins: rows } }); }
  async register(def) {
    if (!String(def?.id ?? '').trim()) throw new Error('Preset id must not be empty');
    if (this.definitions.has(def.id)) throw new Error(`Duplicate agent preset: ${def.id}`);
    const record = { config: def };
    this.definitions.set(def.id, record);
    this.registerCalls.push(def);
    let done = false;
    return async () => { if (done) return; done = true; if (this.definitions.get(def.id) === record) this.definitions.delete(def.id); };
  }
  async list() {
    return [...this.definitions.values()].map(({ config: c }) => ({ id: c.id, ...(c.name !== undefined ? { name: c.name } : {}), ...(c.order !== undefined ? { order: c.order } : {}),
      ...(this.brokenIds.has(c.id) ? { broken: 'Cannot find package' } : {}) })).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id));
  }
  composedPreset(agentCtx) { return agentCtx ? this.bound.get(agentCtx) : undefined; }
  /** 新建 agent 时绑定预设（测试用）。 */
  bind(agent, id) { this.bound.set(agent.ctx, id); }
  async select(agent, id) {
    if (!this.definitions.has(id)) throw new Error(`Unknown agent preset: ${id}`);
    this.bound.set(agent.ctx, id);
    this.ctx.sessionEvent(agent.session, { type: 'agent-preset/selected', seq: this.seq++, data: { agentPreset: id } });
    return id;
  }
}

/** 一个假的 agent（id 就是会话 id，DSH 里也是这样）。agent.ctx.tools.register 只注册给它。 */
export function fakeAgent({ id = 'sess-1', preset, cwd, origin, delegationDepth, parentSession } = {}) {
  const regs = [];
  const header = { version: 4, id, ...(preset ? { agentPreset: preset } : {}), ...(cwd ? { cwd } : {}), ...(origin ? { origin } : {}), ...(delegationDepth ? { delegationDepth } : {}),
    ...(parentSession ? { parentSession } : {}) };
  return {
    id,
    session: { id, header },
    ctx: { tools: { registered: regs, register(def) { regs.push(def); return () => { const i = regs.indexOf(def); if (i >= 0) regs.splice(i, 1); }; } } },
  };
}

/** 用户消息（网页客户端和桥接的唤醒都是 source.kind 'user'）。 */
export function userMessage(text, { id, kind = 'user', extra = {} } = {}) {
  return { id: id ?? `m-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content: [{ type: 'text', text }], source: { kind, rpcId: 'r1', ...extra } };
}
