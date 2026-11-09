// 会话认领（§10.3）：
//   - 在第一次 agent/pre-step 时解析（B2：桥接在 sessions.create 之后才写会话映射），结果交给核心 sessions.bind（存进 sessions 表）；
//   - 问全部适配器的 DSH 绑定：specific 优先；两个 specific → 不认领、报警（fail closed）。不靠注册先后；
//   - 拒认名单：某个适配器被停用或自检失败时，它声明过的会话特征（sessionSignature 的 cwd 前缀、preset）进拒认名单，别的适配器不得认领；
//   - 都不认 → 这个会话不是她，不感知、不注入（fail closed）。不认的结果只缓存一小会儿再问（适配器可能还没读到桥接的映射）；
//   - 一律排除：子代理（F20：origin 'subagent'，或 delegationDepth > 0）；配置里的开发会话特征。
// SettingId 只在内存里（§12.3：库里只有场合键）。插件重载后第一次 pre-step 重新认领（claimSession 是同步的，很便宜）。

/**
 * agent → SessionInfo（§4.6）。extra 里可以带这一步 claimed 的消息（网页适配器找「本机界面会话」的正面证据要用，F24）。
 * presetOf(agent)：会话「现在」用的 preset（D112）。会话头里的 agentPreset 只是创建时的那个、冻结的；在已经开着的空白会话上
 * 从「新建任务」的下拉里换预设，DSH 只往会话里追加一条 agent-preset/selected，会话头不变——认领要按宿主的会话投影读。
 * 没给或者读不到才退回会话头。
 * @param {(agent: any) => string|undefined} [presetOf]
 */
export function makeSessionInfoOf(presetOf) {
  return function infoOf(agent, extra = {}) {
    const session = agent?.session ?? null;
    const header = session?.header ?? agent?.header ?? {};
    const id = String(agent?.id ?? session?.id ?? header?.id ?? '');
    let current;
    if (typeof presetOf === 'function') { try { const p = presetOf(agent); current = typeof p === 'string' && p ? p : undefined; } catch { current = undefined; } }
    return {
      id,
      preset: current ?? header?.agentPreset ?? agent?.preset ?? undefined,
      cwd: header?.cwd ?? undefined,
      origin: header?.origin ?? undefined,
      delegationDepth: Number.isFinite(header?.delegationDepth) ? header.delegationDepth : undefined,
      parentSession: header?.parentSession ?? undefined,
      header,
      ...extra,
    };
  };
}

/** 只看会话头的版本（测试、没有宿主投影的地方）。 */
export const sessionInfoOf = makeSessionInfoOf();

const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const under = (cwd, prefix) => { const c = norm(cwd); const p = norm(prefix); return !!p && (c === p || c.startsWith(`${p}/`)); };

/** 这个会话符不符合某个会话特征（sessionSignature）。 */
export function matchesSignature(info, sig) {
  if (!sig) return false;
  if (info.preset && (sig.presets ?? []).includes(info.preset)) return true;
  if (info.cwd && (sig.cwdPrefixes ?? []).some((p) => under(info.cwd, p))) return true;
  return false;
}

/**
 * @param {{hostConfig: () => object, getPm: () => any, now?: () => number, log?: object}} opt
 */
export function createClaims({ hostConfig, getPm, now = () => Date.now(), log = { warn() {}, info() {} } }) {
  /** adapterId → {binding, active} */
  const bindings = new Map();
  /** sessionId → claim | {none: true, at, attempts, reason} */
  const cache = new Map();
  const stats = { claimed: 0, none: 0, conflicts: 0, excluded: 0, denied: 0, bindErrors: 0, claimErrors: 0 };
  const conflicts = [];   // 最近的「两个 specific」：只记适配器 id 和时间

  const excluded = (info) => {
    const c = hostConfig().claim ?? {};
    if (info.origin === 'subagent' || (info.delegationDepth ?? 0) > 0) return 'subagent';
    if (info.header && typeof info.header === 'object' && info.header.archived === true) return 'archived';
    if (info.preset && (c.excludePresets ?? []).includes(info.preset)) return 'excluded-preset';
    if (info.cwd && (c.excludeCwdPrefixes ?? []).some((p) => under(info.cwd, p))) return 'excluded-cwd';
    return null;
  };
  const deniedFor = (info) => {
    for (const [id, b] of bindings) {
      if (b.active) continue;
      let sig = null;
      try { sig = b.binding.sessionSignature?.(); } catch { sig = null; }
      if (matchesSignature(info, sig)) return id;
    }
    return null;
  };

  function decide(info) {
    const ex = excluded(info);
    if (ex) { stats.excluded += 1; return { none: true, reason: ex, final: true }; }
    const denied = deniedFor(info);
    if (denied) { stats.denied += 1; return { none: true, reason: 'deny-list', final: false }; }
    const specific = [];
    const fallback = [];
    for (const [id, b] of bindings) {
      if (!b.active) continue;
      let r = null;
      try { r = b.binding.claimSession(info); } catch (e) { stats.claimErrors += 1; log.warn('claim.error', { adapter: id, error: e?.code ?? e?.name ?? 'Error' }); r = null; }
      if (!r || typeof r.settingId !== 'string' || !r.settingId) continue;
      (r.confidence === 'specific' ? specific : fallback).push({ adapterId: id, binding: b.binding, settingId: r.settingId, confidence: r.confidence === 'specific' ? 'specific' : 'fallback' });
    }
    if (specific.length > 1 || (specific.length === 0 && fallback.length > 1)) {
      stats.conflicts += 1;
      const ids = (specific.length > 1 ? specific : fallback).map((x) => x.adapterId);
      conflicts.push({ at: now(), adapters: ids });
      if (conflicts.length > 20) conflicts.shift();
      log.warn('claim.conflict', { adapters: ids.join(',') });
      return { none: true, reason: 'conflict', final: false };
    }
    const pick = specific[0] ?? fallback[0];
    if (pick) return { ...pick };
    // 符合某个绑定声明的会话特征（例：选了插件预设的网页会话）却没被认领——多半是这一步的消息还缺证据（不是网页客户端发的）。
    // 绑定自己说了要这样（retryOnSignature，现在只有网页）才很快再问一次、不算进次数上限：下一条从网页界面发的消息就能认上，
    // 不用等一分钟（实测问题 #20）。别的绑定（QQ：桥接自己的辅助会话永远不在映射里）照旧按次数上限放弃
    const sigMatch = [...bindings.values()].some((b) => { if (!b.active || b.binding?.retryOnSignature !== true) return false; try { return matchesSignature(info, b.binding.sessionSignature?.()); } catch { return false; } });
    return { none: true, reason: sigMatch ? 'signature-unclaimed' : 'unclaimed', final: false, retry: sigMatch };
  }

  return {
    /** 注册一个适配器的 DSH 绑定。active=false：适配器被停用 / 自检失败，它的会话特征进拒认名单。 */
    addBinding(binding, { active = true } = {}) {
      const id = binding.adapterId;
      bindings.set(id, { binding, active });
      for (const [sid, c] of cache) if (c.none && !c.final) cache.delete(sid);   // 新绑定来了：没认的会话再问一次
      return () => {
        if (bindings.get(id)?.binding === binding) bindings.delete(id);
        for (const [sid, c] of cache) if (!c.none && c.adapterId === id) cache.delete(sid);
      };
    },
    setActive(adapterId, active) {
      const b = bindings.get(adapterId);
      if (!b) return;
      b.active = !!active;
      for (const [sid, c] of cache) if ((c.none && !c.final) || (!active && c.adapterId === adapterId)) cache.delete(sid);
    },
    bindings: () => [...bindings.entries()].map(([id, b]) => ({ adapterId: id, active: b.active, binding: b.binding })),
    activeBindings: () => [...bindings.values()].filter((b) => b.active).map((b) => b.binding),
    binding: (adapterId) => bindings.get(adapterId)?.binding ?? null,
    /** 已认领的（不触发认领）。 */
    get(sessionId) { const c = cache.get(sessionId); return c && !c.none ? c : null; },
    /**
     * 认领（或取缓存）。不认 → null。
     * @param {ReturnType<typeof sessionInfoOf>} info
     */
    resolve(info) {
      if (!info?.id) return null;
      const prev = cache.get(info.id);
      if (prev && !prev.none) return prev;
      const c = hostConfig().claim ?? {};
      if (prev?.none) {
        const ttl = prev.retry ? (c.signatureRetryMs ?? 5000) : (c.negativeTtlMs ?? 60_000);
        if (prev.final || (!prev.retry && prev.attempts >= (c.maxAttempts ?? 5)) || now() - prev.at < ttl) return null;
      }
      const r = decide(info);
      if (r.none) {
        stats.none += 1;
        // 符合特征、等证据的会话（retry）：不带这一步消息的问法（工具调用、记忆工具：本来就看不到证据）没认上不记缓存，
        // 免得把紧接着带消息的那次 pre-step 挡在 5 秒的缓存外
        if (r.retry && !Array.isArray(info.messages)) return null;
        if (r.retry) stats.signatureRetries = (stats.signatureRetries ?? 0) + 1;
        cache.set(info.id, { none: true, at: now(), attempts: r.retry ? (prev?.attempts ?? 0) : (prev?.attempts ?? 0) + 1, reason: r.reason, final: r.final, retry: !!r.retry });
        return null;
      }
      const claim = { sessionId: info.id, settingId: r.settingId, adapterId: r.adapterId, confidence: r.confidence, binding: r.binding, at: now() };
      cache.set(info.id, claim);
      stats.claimed += 1;
      try { getPm()?.sessions?.bind({ sessionId: info.id, settingId: r.settingId, adapterId: r.adapterId, confidence: r.confidence }); } catch (e) {
        stats.bindErrors += 1;
        log.warn('claim.bind', { adapter: r.adapterId, error: e?.code ?? e?.name ?? 'Error' });
      }
      return claim;
    },
    /**
     * 认领它的适配器说这个会话改记到别的场合了（例：网页会话里出现了远程访客，§11.3）。
     * 只改已认领的会话、只认同一个适配器报上来的；重新交给核心 sessions.bind。返回改没改。
     * @param {string} sessionId
     * @param {string} settingId
     * @param {string} [adapterId]
     */
    rebind(sessionId, settingId, adapterId) {
      const c = cache.get(sessionId);
      if (!c || c.none || typeof settingId !== 'string' || !settingId) return false;
      if (adapterId && c.adapterId !== adapterId) return false;
      if (c.settingId === settingId) return false;
      cache.set(sessionId, { ...c, settingId, at: now() });
      stats.rebinds = (stats.rebinds ?? 0) + 1;
      try { getPm()?.sessions?.bind({ sessionId, settingId, adapterId: c.adapterId, confidence: c.confidence }); } catch (e) {
        stats.bindErrors += 1;
        log.warn('claim.rebind', { adapter: c.adapterId, error: e?.code ?? e?.name ?? 'Error' });
      }
      return true;
    },
    forget(sessionId) { cache.delete(sessionId); },
    status() {
      let claimed = 0; let none = 0;
      const byAdapter = {};
      for (const c of cache.values()) { if (c.none) none += 1; else { claimed += 1; byAdapter[c.adapterId] = (byAdapter[c.adapterId] ?? 0) + 1; } }
      return { ...stats, live: { claimed, none }, byAdapter, conflicts: conflicts.map((x) => ({ ...x, adapters: [...x.adapters] })),
        bindings: [...bindings.entries()].map(([id, b]) => ({ adapterId: id, active: b.active, tools: (b.binding.tools ?? []).length })) };
    },
  };
}
