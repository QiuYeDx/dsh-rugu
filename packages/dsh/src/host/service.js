// 给别的插件的服务 personaMemory（§10.1 第 4、5 条）：核心 API（§4.5）的一个稳定外壳。
//   - 插件 apply 一开始就 ctx.provide 这个外壳（Cordis 要先 provide、同一个 fiber，F22）；核心打开之后外壳才真正干活，
//     打开之前、打开失败或者只读时：感知类调用丢弃、读接口给空结果、写接口报「还没准备好」；appraise 返回改口（fail closed，§9.4.2 第 4 条）：
//     插件重启前注入过的记忆还在各个会话的记录和压缩摘要里，「核心没打开」不等于「什么都没注入过」；
//   - 别的插件（bili-eyes）在 ctx.inject(['personaMemory'], …) 里调 registerAdapter：核心还没开就先排队，开了再注册；
//     记忆插件重载后服务重新提供，它们的回调会再跑一次，注册不会丢（评审:AR-18）；
//   - 适配器可以带上自己的 DSH 绑定（adapter.dshBinding，或第二个参数 {binding}）：工具分类进外发钩子的表（bili_* 写工具声明
//     appraisedBy:'adapter'，会话里和后台都只在它自己的 request() 里审一次，§11.2）；也可以单独 dsh.registerBinding(b)。
import { PROTOCOL, CAPABILITIES } from 'rugu-core';

const notReady = () => Object.assign(new Error('记忆插件还没准备好'), { code: 'NOT_READY' });
const EMPTY_LAYERS = Object.freeze({ items: Object.freeze([]), degradeLevel: 4, traceId: 'unavailable' });

/**
 * @param {{log: object, onBinding: (b: object, source: string) => (() => void), validateBinding: (b: unknown) => {ok: boolean, errors: object[]},
 *          finalReflection?: () => string}} opt
 */
export function createServiceFacade({ log, onBinding, validateBinding, finalReflection = () => '这次先不说了' }) {
  let pm = null;
  /** 排队等核心打开的注册：{adapter, binding, unregister?, done} */
  const queued = new Set();
  const live = new Set();

  const doRegister = (entry) => {
    try {
      entry.unregister = pm.registerAdapter(entry.adapter);
      live.add(entry);
    } catch (e) {
      log.warn('service.registerAdapter', { adapter: String(entry.adapter?.id ?? '?').slice(0, 32), error: e?.code ?? e?.name ?? 'Error' });
      entry.error = e;
    }
  };
  const addBinding = (b, source) => {
    if (!b) return () => {};
    const v = validateBinding(b);
    if (!v.ok) { log.warn('service.binding', { adapter: String(b?.adapterId ?? '?').slice(0, 32), errors: v.errors.length }); return () => {}; }
    return onBinding(b, source);
  };

  const facade = {
    protocol: PROTOCOL,
    capabilities: CAPABILITIES,
    get ready() { return !!pm; },
    get readOnly() { return pm ? pm.readOnly : true; },
    status: () => (pm ? pm.status() : { unavailable: true }),

    /**
     * @param {import('rugu-core/contract').PerceptionAdapter & {dshBinding?: object}} adapter
     * @param {{binding?: object}} [opt]
     */
    registerAdapter(adapter, opt = {}) {
      const binding = opt.binding ?? adapter?.dshBinding ?? null;
      const entry = { adapter, binding, unregister: null, done: false, error: null };
      const unbind = addBinding(binding, 'service');
      if (pm) doRegister(entry); else queued.add(entry);
      if (entry.error) { unbind(); throw entry.error; }
      return () => {
        if (entry.done) return;
        entry.done = true;
        queued.delete(entry);
        live.delete(entry);
        try { entry.unregister?.(); } catch { /* 尽力 */ }
        try { unbind(); } catch { /* 尽力 */ }
      };
    },
    dsh: {
      /** 单独登记一个 DSH 绑定（工具分类、会话认领）。 */
      registerBinding: (b) => addBinding(b, 'service'),
    },

    observe(o, opt) { pm?.observe(o, opt); },
    describe(d, opt) { pm?.describe(d, opt); },
    sealBuffers(id) { pm?.sealBuffers(id); },
    expectRelay(r) { pm?.expectRelay(r); },
    cursor(a, k) { return pm ? pm.cursor(a, k) : null; },
    modeOf(id) { return pm ? pm.modeOf(id) : 'off'; },
    resident(id) { return pm ? pm.resident(id) : { text: '', version: 'unavailable', itemIds: [] }; },
    async recall(s, opt) { return pm ? pm.recall(s, opt) : EMPTY_LAYERS; },
    recallCached(s) { return pm ? pm.recallCached(s) : EMPTY_LAYERS; },
    self: { coreBlock: (id) => (pm ? pm.self.coreBlock(id) : { text: '', hash: 'unavailable' }) },
    expression: {
      async appraise(u, signal) {
        if (!pm || pm.readOnly === true) return { verdict: 'reconsider', reflection: finalReflection(), token: 'unavailable' };
        return pm.expression.appraise(u, signal);
      },
      outcome(token, result, meta) { pm?.expression.outcome(token, result, meta); },
    },
    ingest: { async import(records, opt) { if (!pm) throw notReady(); return pm.ingest.import(records, opt); } },
    async note(req) { if (!pm) throw notReady(); return pm.note(req); },
    async fix(req) { if (!pm) throw notReady(); return pm.fix(req); },
    get admin() { if (!pm) throw notReady(); return pm.admin; },
    get maintenance() { if (!pm) throw notReady(); return pm.maintenance; },
    get sessions() { if (!pm) throw notReady(); return pm.sessions; },
  };

  return {
    facade,
    /** 核心打开了：排队的注册补上。 */
    attach(next) {
      pm = next;
      for (const e of [...queued]) { queued.delete(e); if (!e.done) doRegister(e); }
    },
    /** 关闭前：注销全部外来适配器（核心关掉之后它们也停了；插件重载后对方的 inject 回调会重新注册）。 */
    detach() {
      for (const e of [...live]) { try { e.unregister?.(); } catch { /* 尽力 */ } e.unregister = null; queued.add(e); }
      live.clear();
      pm = null;
    },
    status: () => ({ ready: !!pm, external: live.size, queued: queued.size, ids: [...live].map((e) => String(e.adapter?.id ?? '?').slice(0, 32)) }),
    /** 现在注册着的外来适配器（自检用：协议握手、绑定是否合格）。 */
    entries: () => [...live].map((e) => ({ id: String(e.adapter?.id ?? '?').slice(0, 32), adapter: e.adapter, binding: e.binding, external: true })),
  };
}
