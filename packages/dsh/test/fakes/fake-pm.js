// 核心 API（§4.5）的录音替身：集成层的测试只关心「调了什么、按什么顺序、出错时怎么办」，不需要真的库。
// 形状照 rugu-core 的 api.js；sessions.injected 和真核心一样，条目缺 appraisalRef 就抛 ContractError（D47）。
export function createFakePm({
  modes = {}, defaultMode = 'live',
  recall = null, appraise = null, note = null, fix = null, mediaViewed = null, cached = null, lessonNote = null, toolOutcome = null, look = null,
} = {}) {
  const calls = [];
  const rec = (name, ...args) => { calls.push({ name, args }); };
  let residentN = 0;
  const pm = {
    protocol: 2,
    capabilities: [],
    readOnly: false,
    calls,
    modes: { ...modes },
    adapters: [],
    named: (name) => calls.filter((c) => c.name === name),
    status: () => ({ readOnly: false, schema: { ok: true }, schemaVersion: 1, startup: { worker: 'ok' }, adapters: pm.adapters.map((a) => a.id) }),
    registerAdapter(a) { rec('registerAdapter', a.id); pm.adapters.push(a); return () => { rec('unregisterAdapter', a.id); const i = pm.adapters.indexOf(a); if (i >= 0) pm.adapters.splice(i, 1); }; },
    observe(o, opt) { rec('observe', o, opt); },
    describe(d, opt) { rec('describe', d, opt); },
    sealBuffers(id) { rec('sealBuffers', id); },
    expectRelay(r) { rec('expectRelay', r); },
    cursor() { return null; },
    modeOf(settingId) {
      rec('modeOf', settingId);
      const m = pm.modes[settingId];
      if (m instanceof Error) throw m;
      return m ?? defaultMode;
    },
    resident(settingId) { residentN += 1; rec('resident', settingId); return { text: `【你自己】常驻区 ${settingId} v${residentN}`, version: `v${residentN}`, itemIds: [] }; },
    async recall(s, opt) {
      rec('recall', s, opt);
      if (recall) return recall(s, opt);
      return { items: [{ id: 'a1', layer: 'recalled', rendered: '前天这里聊到团建去哪，还没定', verdict: 'share', confidence: 0.8, provenance: '在这里聊的', appraisalRef: 'ap1' }], degradeLevel: 2, traceId: 't1' };
    },
    recallCached(s) { rec('recallCached', s); return cached ? cached(s) : { items: [], degradeLevel: 2, traceId: 'cached' }; },
    // 翻看（D156）
    async look(s, opt) { rec('look', s, opt); return look ? look(s, opt) : { items: [], degradeLevel: 2, traceId: 'l1', look: { kind: opt?.open ? 'open' : 'when', reason: 'nothing' } }; },
    self: { coreBlock: () => ({ text: '', hash: 'x' }) },
    expression: {
      async appraise(u, signal) { rec('appraise', u); if (appraise) return appraise(u, signal); return { verdict: 'speak', token: 'tok-1' }; },
      outcome(token, result, meta) { rec('outcome', token, result, meta); },
    },
    ingest: { async import() { return { accepted: 0, skipped: 0, errors: [] }; } },
    async note(req) { rec('note', req); return note ? note(req) : { status: 'done' }; },
    async fix(req) { rec('fix', req); return fix ? fix(req) : { status: 'review' }; },
    // 她自己的经验（D124）
    lessons: {
      async note(req) { rec('lessonNote', req); return lessonNote ? lessonNote(req) : { status: 'done', lessonStatus: 'unverified', refs: ['a9'] }; },
      toolOutcome(o) { rec('toolOutcome', o); return toolOutcome ? toolOutcome(o) : { recorded: false, recovered: false, lessons: 0 }; },
    },
    // 她看过的媒体（D116）
    media: { async noteViewed(req) { rec('noteViewed', req); return mediaViewed ? mediaViewed(req) : { ok: true, reason: 'written', summary: '假的' }; } },
    admin: { pendingCount: () => 0, recallHealth: () => pm.health ?? { days: [], recent: [], buckets: [] },
      evalResult: { get: () => pm.evalLast ?? null, set: (r) => { rec('evalSet', r); pm.evalLast = { ...r, total: r.cases.length, on: r.cases.filter((c) => c.on).length, off: r.cases.filter((c) => c.off).length }; return pm.evalLast; } } },
    maintenance: {
      async tick(o) { rec('tick', o); return { windows: 0, segment: 0, sleep: 'not-due' }; },
      async runJobs(b) { rec('runJobs', b); return { ran: 0, failed: 0 }; },
      async sleep() { return { steps: [] }; },
    },
    sessions: {
      bind(b) { rec('bind', b); },
      injected(inj) {
        rec('injected', inj);
        if (inj.items.some((it) => !it.appraisalRef)) throw Object.assign(new Error('Injection 不合契约'), { code: 'CONTRACT', name: 'ContractError' });
        return calls.filter((c) => c.name === 'injected').length;
      },
      confirm(sid, nonce) { rec('confirm', sid, nonce); },
      abort(sid) { rec('abort', sid); },
      compaction(sid, phase) { rec('compaction', sid, phase); },
      markTurnTaint(sid, m) { rec('markTurnTaint', sid, m); },
      step(sid, s) { rec('step', sid, s); },
      // D117：等回想的结果
      recallOutcome(sid, o) { rec('recallOutcome', sid, o); },
      get() { return null; },
      holdsMemory(sid) { rec('holdsMemory', sid); return pm.holding.has(sid); },
    },
    holding: new Set(),   // 本周期注入过记忆的会话（sessions.holdsMemory）
    closed: false,
    async close() { pm.closed = true; rec('close'); },
  };
  return pm;
}
