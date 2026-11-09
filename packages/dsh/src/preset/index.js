// 插件自己的 Agent 预设（D112，用户反馈第 11 轮）：DSH「新建任务」的预设下拉里多一项，选了它就是「在跟她聊」。
//   - 运行时注册（ctx.agentPresets.register），不发静态补丁文件：插件启动时照抄 DSH「标准模式」（standard）当时的全部插件行
//     （含主人在 DSH 编辑器里对标准模式的改动，DSH 升级后也跟着变），只换名字、说明和排序；配置给了 personaPrefix 才改人设行的开头；
//   - 预设 id 固定（PERSONA_PRESET_ID）：它会永远写在会话记录里，DSH 恢复会话时按 id 找预设，找不到就打不开（agent-preset/not-found）。
//     所以只要插件还装着就一直注册着——记忆总开关关着、核心打不开、集成层起不来都照样注册；只有 host.preset.enabled:false 才撤掉（要确认）；
//   - 名字来自配置 host.preset.name（代码里只有一个通用的默认名，人设的名字不进公开代码，§11.6）；
//   - 读不到标准模式（等 15 秒还没有，或者 DSH 改了内部结构）就用插件自带的精简副本（fallback-rows.js），自检里标出来；
//   - 读 DSH 内部的 definitions（不是公开接口）一律防御着读；注册失败只记状态、绝不抛错（插件出错不能让 DSH 起不来）。
// 认这个预设开的会话是网页适配器的事（默认的 host.adapters.web.presets 就是这个 id，见 host/config.js），这里只管预设本身。
import { fallbackRows } from './fallback-rows.js';

export const PERSONA_PRESET_ID = 'persona-chat';
export const DEFAULT_PRESET_NAME = '人设聊天';
export const DEFAULT_PRESET_DESCRIPTION = '标准模式的全部能力，加上她的记忆：记得在别处跟你聊过的事。设成默认预设的话，所有新会话（包括写代码的）都会算在跟她聊。';
export const DEFAULT_PRESET_ORDER = 5;
const STANDARD = 'standard';
const PERSONA_ROW = '@deepseek-ai/dsh-persona';
const PREFIX_MAX = 2000;

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const codeOf = (e) => String(e?.code ?? (/Duplicate agent preset/.test(String(e?.message ?? '')) ? 'DUPLICATE' : e?.name ?? 'Error')).slice(0, 40);

/** host.preset 配置 → 生效的设置（类型不对的按默认）。 */
export function presetSettings(hostCfg) {
  const p = hostCfg && typeof hostCfg === 'object' && hostCfg.preset && typeof hostCfg.preset === 'object' ? hostCfg.preset : {};
  const prefix = typeof p.personaPrefix === 'string' && p.personaPrefix.trim() ? p.personaPrefix.trim() : '';
  return {
    enabled: p.enabled !== false,
    name: str(p.name, 40) || DEFAULT_PRESET_NAME,
    description: str(p.description, 300) || DEFAULT_PRESET_DESCRIPTION,
    order: Number.isFinite(p.order) ? p.order : DEFAULT_PRESET_ORDER,
    personaPrefix: prefix.length <= PREFIX_MAX ? prefix : '',
  };
}

/**
 * 预设的插件行：照抄的行深拷贝一份（!!js 表达式是普通对象 {__jsExpr}，照样拷），给了 prefix 才改第一个人设行的 config.prefix。
 * 原来的行不动。
 * @param {object[]} rows
 * @param {string} [personaPrefix]
 */
export function buildPresetRows(rows, personaPrefix = '') {
  const out = structuredClone(rows);
  if (!personaPrefix) return out;
  let done = false;
  const walk = (list) => {
    for (const r of Array.isArray(list) ? list : []) {
      if (done || !r || typeof r !== 'object') continue;
      if (r.name === PERSONA_ROW) { r.config = { ...(r.config && typeof r.config === 'object' && !Array.isArray(r.config) ? r.config : {}), prefix: personaPrefix }; done = true; return; }
      if (r.group === true) walk(r.config);
    }
  };
  walk(out);
  if (!done) out.unshift({ id: 'persona', name: PERSONA_ROW, config: { prefix: personaPrefix } });
  return out;
}

/** 标准模式现在的插件行（DSH 内部的 definitions Map，不是公开接口：读不到就 null）。 */
export function standardRowsOf(registry) {
  try {
    const p = registry?.definitions?.get?.(STANDARD)?.config?.plugins;
    return Array.isArray(p) && p.length ? p : null;
  } catch { return null; }
}

/**
 * @param {{ctx: any, hostConfig?: () => object, log?: {warn?: Function, info?: Function},
 *          setTimer?: (fn: () => void, ms: number) => unknown, now?: () => number,
 *          waitMs?: number, pollMs?: number, retryMs?: number, retries?: number, listTimeoutMs?: number}} opt
 */
export function createPersonaPreset({ ctx, hostConfig = () => ({}), log = {}, setTimer = setTimeout, now = () => Date.now(),
  waitMs = 15_000, pollMs = 100, retryMs = 200, retries = 10, listTimeoutMs = 5000 } = {}) {
  const warn = (ev, f) => { try { log.warn?.(ev, f); } catch { /* 忽略 */ } };
  const info = (ev, f) => { try { log.info?.(ev, f); } catch { /* 忽略 */ } };
  const sleep = (ms) => new Promise((r) => { setTimer(r, ms); });
  const settings = () => { try { return presetSettings(hostConfig()); } catch { return presetSettings({}); } };

  /** 现在的预设服务（DSH 的 agentPresets）。 */
  let registry = null;
  /** 现在注册着的：{dispose, sig, source, name, rows, registry} */
  let current = null;
  let chain = Promise.resolve();
  let stopped = false;
  let handle = null;
  /** @type {{id: string, name: string, broken: boolean}[]|null} */
  let roster = null;
  const st = { disabled: false, error: null, broken: null, baseUrl: null, registeredAt: null, rosterAt: null, attempts: 0, registry: false, started: false };

  const enqueue = (fn) => { chain = chain.then(fn).catch((e) => { st.error = codeOf(e); warn('preset.error', { error: st.error }); }); return chain; };

  async function drop() {
    const c = current;
    current = null;
    if (!c) return;
    try { await c.dispose?.(); } catch (e) { warn('preset.unregister', { error: codeOf(e) }); }
  }

  async function waitStandard(reg) {
    const start = now();
    for (;;) {
      const rows = standardRowsOf(reg);
      if (rows || stopped || registry !== reg) return rows;
      if (now() - start >= waitMs) return null;
      await sleep(pollMs);
    }
  }

  async function ensure({ wait }) {
    const reg = registry;
    if (stopped || !reg) return;
    const want = settings();
    if (!want.enabled) {
      st.disabled = true;
      if (current) { await drop(); info('preset.disabled', {}); }
      return;
    }
    st.disabled = false;
    const sig = JSON.stringify([want.name, want.description, want.order, want.personaPrefix]);
    let rows = standardRowsOf(reg);
    if (!rows && wait && !current) rows = await waitStandard(reg);
    if (stopped || registry !== reg) return;
    // 已经注册着、设置没变、来源也没变好（之前是精简副本、现在读得到标准模式了就换）：不动
    if (current && current.registry === reg && current.sig === sig && (current.source === 'standard' || !rows)) return;
    const source = rows ? 'standard' : 'fallback';
    const plugins = buildPresetRows(rows ?? fallbackRows(), want.personaPrefix);
    await drop();
    const def = { id: PERSONA_PRESET_ID, name: want.name, description: want.description, order: want.order, plugins };
    for (let i = 0; ; i += 1) {
      if (stopped || registry !== reg) return;
      st.attempts += 1;
      try {
        const dispose = await reg.register(def);
        current = { dispose: typeof dispose === 'function' ? dispose : null, sig, source, name: want.name, rows: plugins.length, registry: reg };
        st.error = null;
        st.registeredAt = now();
        info('preset.registered', { source, rows: plugins.length });
        if (stopped || registry !== reg) await drop();
        return;
      } catch (e) {
        const code = codeOf(e);
        // 插件热重载：上一个实例的撤销可能还没做完，同一个 id 还在（DUPLICATE）。等一会儿再试
        if (code === 'DUPLICATE' && i < retries) { await sleep(retryMs); continue; }
        st.error = code;
        warn('preset.register', { error: code });
        return;
      }
    }
  }

  function attach(reg, meta = {}) {
    if (stopped || !reg) return;
    registry = reg;
    st.registry = true;
    st.baseUrl = meta.baseUrl ?? null;
    enqueue(() => ensure({ wait: true })).then(() => refreshRoster());
  }
  function detach(reg) {
    if (registry !== reg) return;
    registry = null;
    st.registry = false;
    roster = null;
    enqueue(drop);
  }

  /** 预设下拉里现在有哪些预设（DSH 的 agentPresets.list()，含激活失败的 broken）。读不到就保持 null（不知道）。 */
  async function refreshRoster() {
    const reg = registry;
    if (!reg || typeof reg.list !== 'function') { roster = null; return roster; }
    let timer;
    try {
      const rows = await Promise.race([
        Promise.resolve().then(() => reg.list()),
        new Promise((_, rej) => { timer = setTimer(() => rej(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), listTimeoutMs); }),
      ]);
      if (registry !== reg || !Array.isArray(rows)) return roster;
      roster = rows.filter((r) => r && typeof r.id === 'string').map((r) => ({ id: r.id, name: typeof r.name === 'string' ? r.name.slice(0, 40) : '', broken: r.broken !== undefined && r.broken !== null && r.broken !== false }));
      const mine = rows.find((r) => r?.id === PERSONA_PRESET_ID);
      st.broken = mine && mine.broken !== undefined && mine.broken !== null && mine.broken !== false ? String(mine.broken).slice(0, 300) : null;
      st.rosterAt = now();
    } catch (e) {
      warn('preset.list', { error: codeOf(e) });
    } finally { try { clearTimeout(timer); } catch { /* 注入的计时器 */ } }
    return roster;
  }

  return {
    id: PERSONA_PRESET_ID,
    /** 等 DSH 的预设服务出现后注册（ctx.inject：服务重新提供时回调会再跑一次，插件卸载时跟着撤掉）。 */
    start() {
      if (st.started) return;
      st.started = true;
      if (typeof ctx?.inject === 'function') {
        try {
          handle = ctx.inject(['agentPresets'], (sub) => {
            let reg = null;
            try { reg = sub?.agentPresets ?? sub?.get?.('agentPresets') ?? null; } catch { reg = null; }
            let baseUrl = null;
            try { baseUrl = typeof sub?.baseUrl === 'string' || (sub?.baseUrl && typeof sub.baseUrl.href === 'string'); } catch { baseUrl = null; }
            const meta = { baseUrl: baseUrl === null ? null : !!baseUrl };
            if (typeof sub?.effect === 'function') {
              sub.effect(() => { attach(reg, meta); return () => detach(reg); });
              return undefined;
            }
            attach(reg, meta);
            return () => detach(reg);
          });
          return;
        } catch (e) { st.error = `INJECT:${codeOf(e)}`.slice(0, 40); warn('preset.inject', { error: codeOf(e) }); }
      }
      // 没有 ctx.inject（别的宿主、测试）：服务现在就在才注册
      let reg = null;
      try { reg = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : ctx?.agentPresets; } catch { reg = null; }
      if (reg) attach(reg, {});
    },
    /** 撤掉预设（插件卸载）。返回撤完的 promise。 */
    stop() {
      stopped = true;
      const h = handle;
      handle = null;
      try { if (typeof h === 'function') h(); else if (typeof h?.dispose === 'function') h.dispose(); } catch { /* 尽力 */ }
      registry = null;
      st.registry = false;
      return enqueue(drop);
    },
    /** 配置变了（热加载、管理页）：名字、说明、排序、人设开头变了就重新注册；关掉就撤；之前用的是精简副本、现在读得到标准模式也换。 */
    sync() { return enqueue(() => ensure({ wait: false })).then(() => refreshRoster()); },
    refreshRoster,
    /** 只有数字、代码和名字（主人在配置里起的）。 */
    status() {
      const s = settings();
      return {
        id: PERSONA_PRESET_ID, enabled: s.enabled, registered: !!current, name: current?.name ?? s.name, source: current?.source ?? null,
        rows: current?.rows ?? 0, broken: st.broken, error: st.error, registry: st.registry, baseUrl: st.baseUrl,
        registeredAt: st.registeredAt, rosterAt: st.rosterAt, attempts: st.attempts,
      };
    },
    roster: () => (roster ? roster.map((r) => ({ ...r })) : null),
    /** 预设在下拉里叫什么（DSH 报的名字；我们自己的还没列出来就用配置里的）。 */
    nameOf(id) {
      const r = roster?.find((x) => x.id === id);
      if (r?.name) return r.name;
      if (id === PERSONA_PRESET_ID) return current?.name ?? settings().name;
      return null;
    },
    /** 这个预设现在能不能选：true / false / null（不知道，例如还没列出来过）。 */
    available(id) {
      if (roster) { const r = roster.find((x) => x.id === id); return !!r && !r.broken; }
      if (id === PERSONA_PRESET_ID) {
        if (!settings().enabled) return false;
        if (st.error && st.error !== 'DUPLICATE' && !current) return false;   // 同 id 的已经有一个（别人的）：不说它不在
      }
      return null;
    },
    /** 测试用：等排队的注册 / 撤销做完。 */
    settled: () => chain,
  };
}
