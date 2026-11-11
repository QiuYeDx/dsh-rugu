// 工具分类表（§4.6、§9.4.2 第 6 条、§10.9）：外发钩子按 exec.name（和认领这个会话的适配器）查表。
//   来源（先查到的算）：认领这个会话的适配器绑定声明的（含 sessionScoped：平台会转述的 DSH 自带工具）→ 别的适配器绑定声明的
//   （MCP 工具带完整前缀）→ 主人补的分类（egress.extraTools，只给没有适配器声明的工具；对集成层和 DSH 自带的工具只能往严里改）→
//   集成层自己的工具（memory_*）→ DSH 自带的工具（不往别人那儿说话）。
//   都查不到 = 没有分类：放行（D113，原来记忆开着时参数里有较长的自由文本就拒绝），计 unclassifiedPassed，管理页提示补分类。
// 主人补成说话类的工具没有适配器替它解析目标：目标记成「不知道的场合」（核心的初筛一定送审，审不了就不说），
// 参数里一句自由文本都找不到就当审不了（宿主按 D113 处理：公开目标改口，其余放行）。
import { opaqueFrom } from 'rugu-core/contract';
import { SPEAKING_CLASSES, TOOL_CLASSES } from '../binding/index.js';

export const MEMORY_TOOLS = Object.freeze(['memory_recall', 'memory_note', 'memory_fix']);

/**
 * DSH 自带的工具（@deepseek-ai/dsh-tool-*）：本机执行、读写文件、任务列表、她自己的会话记录……都不往别的受众说话。
 * web_search / web_fetch 读进来的是外面的内容：分成 read（给这一轮打按轮污点，§9.6），但没有适配器替它们生成感知。
 * 读本机文件、跑命令、翻她别的会话记录的工具结果里也可能有别人写的文字：不分成 read（没有感知可入库），只打按轮污点（taints）。
 * 委派出去的活（subagent / task / subagent_fork / workflow，子代理回话的 send_message）也一样：子代理读网页、群消息、文件，
 * 它的总结经这些工具的结果回到她这一轮（D112 集成；子代理自己读的东西另外给父会话这一轮打污点，egress.js after()）。
 */
const TAINTING_BUILTINS = new Set(['bash', 'pwsh', 'run_code', 'read', 'read_image', 'grep', 'terminal_read', 'job_output',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'subagent', 'task', 'subagent_fork', 'workflow', 'send_message']);
const DSH_BUILTIN = new Map([
  ...['ask_user_question', 'bash', 'pwsh', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'get_goal', 'create_goal', 'update_goal',
    'job_output', 'job_list', 'job_kill', 'present', 'ralph', 'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update',
    'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read', 'skill', 'str_replace_editor',
    'list_subagent_models', 'send_message', 'interrupt_agent', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal',
    'terminal_close', 'todo_write', 'working_directory', 'load_workspace_dependencies', 'run_code', 'cordis_inspect_list', 'cordis_inspect_query',
    'subagent', 'task',
    // D112：标准模式里还有这几个（插件预设照抄标准模式）。subagent_fork 的参数是给子代理的文字；exit_plan_mode 是给主人看的计划；
    // list_agents 只列出子代理。workflow 的参数是一段脚本：它跑在 Node 里，网络不受限（和 bash / pwsh / run_code 一样，
    // 能把文字送出本机却不经外发审视——插件预设照抄标准模式时接受的已知缺口，设计 §10.9）。
    // 子代理自己的外发按父会话的认领审（egress.js inheritedClaim）
    'subagent_fork', 'workflow', 'exit_plan_mode', 'list_agents'].map((n) => [n, Object.freeze({ tool: n, class: 'none', ...(TAINTING_BUILTINS.has(n) ? { taints: true } : {}) })]),
  ['web_search', Object.freeze({ tool: 'web_search', class: 'read' })],
  ['web_fetch', Object.freeze({ tool: 'web_fetch', class: 'read' })],
]);
/** 别的 MCP 服务器提供的同名工具只认这两个是只读（名字叫 bash、read 的 MCP 工具不知道会干什么）。 */
const MCP_READ_ALIASES = new Set(['web_search', 'web_fetch']);

/** 去掉 MCP 前缀（mcp__<server>__name → name），只用于和 DSH 自带工具、冻结清单比对。 */
export const bareName = (name) => { const s = String(name ?? ''); const i = s.lastIndexOf('__'); return i >= 0 ? s.slice(i + 2) : s; };

/** 分类的严格程度：说话类 > 只读 > 不说话。主人补的分类对集成层和 DSH 自带的工具只能往严里改。 */
const strictness = (cls) => (SPEAKING_CLASSES.includes(cls) ? 2 : cls === 'read' ? 1 : 0);

/** 主人补成说话类的工具：目标是这个谁也不认识的场合（核心按「目标未知」一定送审）。 */
export const UNKNOWN_TARGET = opaqueFrom('persona-memory/host', 'egress', 'unknown-target');
const SECRET_KEY = /token|secret|password|passwd|cookie|auth|credential|api[_-]?key/i;

/**
 * 参数里的自由文本（深度 ≤ 4，最多 16 段，每段 ≤ 8000 字）。名字像凭据的键（token、cookie……）跳过：不交给审视的模型。
 * @param {unknown} args
 * @returns {string[]}
 */
export function freeTexts(args) {
  const out = [];
  const walk = (v, depth) => {
    if (out.length >= 16) return;
    if (typeof v === 'string') { const s = v.trim(); if (s) out.push(s.slice(0, 8000)); return; }
    if (depth > 4 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) if (!SECRET_KEY.test(k)) walk(x, depth + 1);
  };
  walk(args, 0);
  return out;
}

/** 主人在设置里补的分类 → 工具声明。说话类的自己带一个保守的 resolve（目标未知、一定送审）。 */
function configDecl(name, cls) {
  const d = { tool: name, class: cls, configured: true };
  if (!SPEAKING_CLASSES.includes(cls)) return d;
  d.returns = false;   // 不知道她的话会不会回流成感知：原文交给 outcome，核心自己记成她说过的话
  d.resolveAll = (args, exec) => {
    const text = freeTexts(args);
    if (!text.length) return [];   // 找不到她要说的话：审不了（D113：公开目标改口，其余放行）
    const channel = { targetSettingId: UNKNOWN_TARGET, persistence: cls === 'speak' ? 'once' : 'recurring-context', formHint: '没有适配器声明的工具' };
    if (cls === 'defer') channel.delayMs = 60_000;
    const origin = { path: 'tool' };
    if (typeof exec?.sessionId === 'string' && exec.sessionId) origin.sessionId = exec.sessionId;
    if (typeof exec?.callId === 'string' && exec.callId) origin.callId = exec.callId;
    if (typeof exec?.homeSettingId === 'string' && exec.homeSettingId) origin.homeSettingId = exec.homeSettingId;
    return [{ channel, text, origin }];
  };
  d.resolve = (args, exec) => d.resolveAll(args, exec)[0] ?? null;
  return d;
}

/**
 * @param {{hostConfig: () => object, bindings: () => {adapterId: string, binding: object}[]}} opt
 */
export function createToolTable({ hostConfig, bindings }) {
  const unclassified = new Map();   // 工具名 → 次数（管理页提示补分类；工具名不是秘密）
  const declared = (name) => {
    for (const { adapterId, binding } of bindings()) {
      const decl = (binding.tools ?? []).find((t) => t?.tool === name && t.sessionScoped !== true);
      if (decl) return { decl, adapterId, binding, source: 'adapter' };
    }
    return null;
  };
  const builtin = (name) => {
    if (MEMORY_TOOLS.includes(name)) return { decl: { tool: name, class: 'none' }, adapterId: null, binding: null, source: 'host' };
    const b = DSH_BUILTIN.get(name);
    if (b) return { decl: b, adapterId: null, binding: null, source: 'builtin' };
    if (name.startsWith('mcp__') && MCP_READ_ALIASES.has(bareName(name))) return { decl: { tool: name, class: 'read' }, adapterId: null, binding: null, source: 'builtin' };
    return null;
  };
  return {
    /**
     * @param {string} name
     * @param {{adapterId?: string, binding?: object}|null} [claim]   这次调用所在会话的认领（有的话先查认领它的适配器）
     * @returns {{decl: object, adapterId: string|null, binding: object|null, source: 'config'|'adapter'|'host'|'builtin'}|null}
     */
    lookup(name, claim = null) {
      const own = claim?.binding ? (claim.binding.tools ?? []).find((t) => t?.tool === name) : null;
      if (own) return { decl: own, adapterId: claim.adapterId ?? claim.binding.adapterId ?? null, binding: claim.binding, source: 'adapter' };
      const adapterHit = declared(name);
      if (adapterHit) return adapterHit;   // 适配器声明过的工具，主人补的分类盖不掉（盖掉就等于关掉它的审视）
      const base = builtin(name);
      const extra = hostConfig().egress?.extraTools ?? {};
      if (Object.hasOwn(extra, name) && TOOL_CLASSES.includes(extra[name]) && (!base || strictness(extra[name]) > strictness(base.decl.class))) {
        return { decl: configDecl(name, extra[name]), adapterId: null, binding: null, source: 'config' };
      }
      return base;
    },
    noteUnclassified(name) {
      unclassified.set(name, (unclassified.get(name) ?? 0) + 1);
      if (unclassified.size > 200) unclassified.delete(unclassified.keys().next().value);
    },
    /** 绑定里全部的说话类工具（外发包络、自检用）。 */
    speakingTools() {
      const out = [];
      for (const { adapterId, binding } of bindings()) for (const t of binding.tools ?? []) if (SPEAKING_CLASSES.includes(t?.class)) out.push({ adapterId, tool: t.tool, class: t.class, appraisedBy: t.appraisedBy ?? 'core' });
      return out;
    },
    status() {
      const perAdapter = {};
      for (const { adapterId, binding } of bindings()) {
        const counts = {};
        for (const t of binding.tools ?? []) counts[t?.class ?? '?'] = (counts[t?.class ?? '?'] ?? 0) + 1;
        perAdapter[adapterId] = counts;
      }
      // 主人补的分类里被适配器的声明盖住、或者对自带工具往松里改而没生效的（只有工具名）
      const extra = hostConfig().egress?.extraTools ?? {};
      const ignoredExtra = Object.keys(extra).filter((name) => {
        if (!TOOL_CLASSES.includes(extra[name])) return true;
        if (declared(name)) return true;
        const base = builtin(name);
        return !!base && strictness(extra[name]) <= strictness(base.decl.class) && extra[name] !== base.decl.class;
      }).slice(0, 50);
      return { perAdapter, unclassified: [...unclassified.entries()].map(([tool, count]) => ({ tool, count })), ignoredExtra };
    },
  };
}
