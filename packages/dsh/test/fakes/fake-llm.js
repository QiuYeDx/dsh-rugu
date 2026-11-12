// 可配置的 ctx.llm 替身（D168）：形状照 DSH 0.2 的 @deepseek-ai/dsh-llm 运行时——
//   listProviders()               已注册的服务商 [{id, name}]
//   listModels(provider)          服务商的模型目录（只是参考；没注册的服务商抛 NO_ADAPTER）
//   resolveModelInfo(p, m)        没注册的服务商抛 NO_ADAPTER；strict 的服务商（像 pi-ai）不认识的模型抛 UNKNOWN_MODEL，
//                                 不 strict 的（像 DeepSeek 的两条通道）什么名字都认
//   stream(opts)                  适配器的错误不抛，变成 finish {kind: 'error', failure: {code}}（照 adapterStream）；
//                                 其余按 script(opts) 吐：chunk 数组，元素可以是 'wait'（等 20 毫秒）、Error（抛出）、{fail: 'CODE'}（报错的 finish）
// 和 agentDefaultModel.currentSelection() 的替身。测试里绝不调真的模型。
export const ok = (text, usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }) => [{ type: 'text-delta', text }, ...(usage ? [{ type: 'usage', usage }] : []), { type: 'finish', reason: { kind: 'stop' } }];
export const failWith = (code) => [{ fail: code }];

/** 能通过真实解析器的输出：第一眼（两句要看的）、提炼（一个 header 一个 narrative）。 */
export const GOOD_GLANCE = '{"i":2,"sens":0.1,"limit":"none","quote":"","about":"both","asks":true,"to":"her","gist":"约周六骑车","vague":"约了出去","replaces":null,"follows":null,"applies":[]}\n'
  + '{"i":3,"sens":0.7,"limit":"strict","quote":"先别跟别人说","about":"speaker","asks":true,"to":"her","gist":"换工作先保密","vague":"他工作上有变动","replaces":null,"follows":null,"applies":[]}';
export const GOOD_EXTRACT = '{"type":"header","title":"约去江边骑车","text":"2026-05-16 上午，群里约第二天去江边骑车"}\n{"type":"narrative","text":"小周约大家明天九点桥头见，阿宁带打气筒，我说带水。"}';

/**
 * @param {{providers?: Record<string, {name?: string, models?: string[], strict?: boolean, efforts?: string[]}>,
 *          defaultSelection?: {provider: string, model: string}|null, script?: (opts: any) => any[]}} [o]
 */
export function createFakeLlm(o = {}) {
  const providers = o.providers ?? {
    'deepseek-account': { name: 'DeepSeek Account', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  };
  const state = {
    providers,
    defaultSelection: o.defaultSelection === undefined ? { provider: 'deepseek-account', model: 'deepseek-flash' } : o.defaultSelection,
    script: o.script ?? (() => ok('ok')),
    calls: [],
    infoCalls: 0,
  };
  const err = (code) => Object.assign(new Error(code), { code });
  const llm = {
    listProviders: () => Object.entries(state.providers).map(([id, p]) => ({ id, name: p.name ?? id })),
    async listModels(id) {
      const p = state.providers[id];
      if (!p) throw err('NO_ADAPTER');
      return (p.models ?? []).map((m) => ({ provider: id, id: m, name: m }));
    },
    async resolveModelInfo(id, model) {
      state.infoCalls += 1;
      const p = state.providers[id];
      if (!p) throw err('NO_ADAPTER');
      if (p.strict && !(p.models ?? []).includes(model)) throw err('UNKNOWN_MODEL');
      return { provider: id, id: model, name: model, reasoning: { efforts: (p.efforts ?? ['off', 'high']).map((e) => ({ id: e, name: e })) } };
    },
    stream(opts) {
      state.calls.push(opts);
      const p = state.providers[opts.provider];
      let chunks;
      if (!p) chunks = failWith('NO_ADAPTER');
      else if (p.strict && !(p.models ?? []).includes(opts.model)) chunks = failWith('UNKNOWN_MODEL');
      else chunks = state.script(opts);
      return (async function* gen() {
        for (const ch of chunks) {
          if (ch === 'wait') { await new Promise((r) => setTimeout(r, 20)); if (opts.signal?.aborted) { yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } } }; return; } continue; }
          if (ch instanceof Error) throw ch;
          if (ch && typeof ch === 'object' && 'fail' in ch) { yield { type: 'finish', reason: { kind: 'error', failure: { code: ch.fail, message: ch.fail } } }; return; }
          yield ch;
        }
      })();
    },
  };
  const agentDefaultModel = { currentSelection: () => (state.defaultSelection ? { ...state.defaultSelection } : undefined) };
  return { llm, agentDefaultModel, state, getLlm: () => llm, getDefaultSelection: () => agentDefaultModel.currentSelection() ?? null };
}
