// FakeLLM：按 use 预先写好回复的 LLM 端口。核心要的结构化输出都是 JSONL，所以回复可以直接给对象数组。
//   new FakeLLM({ script: { extract: [[{type:'header', text:'…'}, …], '原样文本', (req) => [...] ], appraise: [...] },
//                 fallback: { appraise: (req) => [...] } })
// 每次 complete({use}) 取这个 use 队列里的下一项：
//   - 字符串：原样返回；
//   - 对象数组：每个对象 JSON.stringify 成一行（JSONL）；
//   - 函数：调用它（参数是请求），返回值再按上面两条处理；
//   - Error：抛出（模拟 LLM 挂了、额度用完）；
//   - { reply, stopReason?, out? }：reply 按上面处理，带上停止原因（D141：'length' 模拟输出被上限截断）、改报的输出 token 数。
// 队列用完了就用 fallback[use]；也没有就抛错（测试里漏写脚本会立刻暴露，而不是悄悄返回空）。
export class FakeLLM {
  /**
   * @param {{script?: Record<string, unknown[]>, fallback?: Record<string, unknown>, model?: string, delayMs?: number}} [opt]
   */
  constructor({ script = {}, fallback = {}, model = 'fake-flash', delayMs = 0 } = {}) {
    /** @type {Map<string, unknown[]>} */
    this.queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    this.fallback = { ...fallback };
    this.model = model;
    this.delayMs = delayMs;
    /** @type {{use: string, system: string, messages: {role: string, content: string}[], maxTokens?: number}[]} */
    this.calls = [];
  }

  /** 给某个 use 追加回复。 */
  push(use, ...responses) {
    if (!this.queues.has(use)) this.queues.set(use, []);
    this.queues.get(use).push(...responses);
    return this;
  }
  /** 下一次这个 use 的调用抛错。 */
  fail(use, error = Object.assign(new Error('fake LLM down'), { code: 'LLM_DOWN' })) {
    if (!this.queues.has(use)) this.queues.set(use, []);
    this.queues.get(use).unshift(error);
    return this;
  }
  remaining(use) { return this.queues.get(use)?.length ?? 0; }
  callsFor(use) { return this.calls.filter((c) => c.use === use); }

  /** @param {{use: string, system: string, messages: {role: string, content: string}[], maxTokens?: number, signal?: AbortSignal}} req */
  async complete(req) {
    if (!req || typeof req.use !== 'string') throw new TypeError('FakeLLM.complete 需要 use');
    this.calls.push({ use: req.use, system: req.system, messages: req.messages, maxTokens: req.maxTokens });
    if (req.signal?.aborted) throw abortError();
    if (this.delayMs > 0) await sleep(this.delayMs, req.signal);
    const q = this.queues.get(req.use);
    let item = q?.length ? q.shift() : this.fallback[req.use];
    if (item === undefined) throw new Error(`FakeLLM：use='${req.use}' 没有准备回复`);
    if (typeof item === 'function') item = await item(req);
    if (item instanceof Error) throw item;
    let extra = null;
    if (item && typeof item === 'object' && !Array.isArray(item) && 'reply' in item) {
      extra = item;
      item = item.reply;
    }
    const text = Array.isArray(item) ? item.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : String(item);
    const inTokens = estimateTokens(req.system) + req.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    const out = Number.isFinite(extra?.out) ? extra.out : estimateTokens(text);
    return { text, usage: { in: inTokens, cached: 0, out }, model: this.model, ...(extra?.stopReason ? { stopReason: extra.stopReason } : {}) };
  }
}

/** 粗略的 token 估计：中文 1 字 ≈ 1 token，其他 4 字符 ≈ 1 token。只给用量计数用。 */
export function estimateTokens(s) {
  const t = String(s ?? '');
  const cjk = (t.match(/[㐀-鿿]/g) ?? []).length;
  return cjk + Math.ceil((t.length - cjk) / 4);
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}
