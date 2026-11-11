// 管理页的写操作（POST，§13.1）。每个操作一张小表：
//   parse(body)          校验并取出参数（多出来的字段直接拒绝）；
//   needsConfirm(p)      这次要不要确认令牌（服务端自己判断，不信页面说的）；
//   prepare(p)           预览 + 确认语（只在要确认时调；预览本身不改任何东西）；
//   bind(p)              令牌绑定的参数（默认就是 p；恢复码这类秘密不进绑定）；
//   run(p)               真正去做，只调核心的公开 API 和宿主给的 host.*。
// 要确认的（§12.4.5、§12.6、§12.7、§15.2）：彻底删除、按来源撤回、批准「按来源撤回」和挂起的发言、整体 / 部分恢复、
// 缩短原文保留期、开启或更换备份加密、成长块回退、换向量空间；宿主认为有风险的配置改动（总开关关掉……）。
// 会删东西的另外要手动输入确认语。日志只记操作名、结果和错误类型，不记任何参数里的内容。
import path from 'node:path';
import {
  InputError, isPlainObject, onlyKeys, posInt, nonNegInt, timeMs, opaque, oneOf, bool, text, list, absDir,
} from './check.js';
import { ConfirmError } from './confirm.js';
import { BUDGET_OVERRIDE_KEYS } from 'rugu-core';
import { RETENTION_ORDER, codeOf, within, retentionLabel, configParts, budgetConfigView, budgetValue, budgetRisks, BUDGET_PRESETS } from './views.js';

const DAY = 86_400_000;
/** 场合的档只有关 / 开（用户反馈第 6 轮：不要影子模式；说不说由关口①②逐条判断）。 */
const MODES = ['off', 'live'];
const RESTRICTIONS = ['none', 'soft', 'strict'];
const GPU_POLICIES = ['off', 'on', 'adaptive'];
/** 撤销夜里的改正撤不了的原因（核心 consolidate.revertCheck 给的码）→ 人话。 */
const REVERT_REASON = {
  'not-found': '没有这次核对',
  'already-reverted': '已经撤销过了',
  'nothing-to-revert': '这次核对没改东西',
  gone: '这条记忆已经不在了',
  'changed-since': '这条记忆之后又换过版本，请到「事实」里看现在的那一条',
};
/** 游戏模式一次最多开多久（小时）；不给 = 一直开到手动关。 */
const GAME_MODE_MAX_H = 24;
/** 管理页能改的配置项（其余配置只能改配置文件；保留期不在这里：它只能走确认语 + 冷静期，§12.6、D56）。 */
export const CONFIG_KEYS = Object.freeze({
  'mode.global': MODES,
  'mode.byAttributes.principalOneOnOne': MODES,
  'mode.byAttributes.closed': MODES,
  'mode.byAttributes.public': MODES,
  'budget.preset': [...BUDGET_PRESETS],
  'sleep.growth.mode': ['auto', 'approve'],
  // D125：用法说明和记忆工具说明的写法（详细指引 / 只讲目的）
  'context.usageStyle': ['guided', 'purpose'],
});
const SETTING_ATTR_INT = ['exposureRankMin', 'exposureRankMax', 'persistenceRankMin'];
const SETTING_ATTR_BOOL = ['oneOnOne', 'publicLike'];
const EXPORT_NAME_RE = /^pm-export-[A-Za-z0-9._-]{1,80}\.(jsonl|pmpack)$/;

const notFound = (what) => Object.assign(new Error(`没有${what}`), { code: 'NOT_FOUND' });
const unavailable = (what) => Object.assign(new Error(`${what}现在不可用`), { code: 'UNAVAILABLE' });

/**
 * 宿主写配置的结果（host/config.js 的 set()：{ok, warnings, needsConfirm?, rejected?}）→ 成功就原样返回，不成功抛给 HTTP 层：
 *   needsConfirm → CONFIRM_REQUIRED（带宿主说的理由，页面带 ask 重来一次）；rejected → REJECTED；其余（写文件失败、配置文件坏了）→ CONFIG_WRITE。
 * 宿主不给结果（老的宿主、直接抛错的宿主）就当成功。
 */
function hostResult(r, confirmed) {
  if (!r || typeof r !== 'object' || r.ok !== false) return r;
  const reasons = Array.isArray(r.needsConfirm) ? r.needsConfirm.filter((x) => typeof x === 'string' && x) : [];
  if (reasons.length && !confirmed) throw new ConfirmError('CONFIRM_REQUIRED', '这项改动有风险，要先确认', { reasons });
  const rejected = Array.isArray(r.rejected) ? r.rejected.filter((x) => typeof x === 'string' && x) : [];
  if (rejected.length) throw Object.assign(new Error(rejected.join('；').slice(0, 300)), { code: 'REJECTED' });
  const w = Array.isArray(r.warnings) ? r.warnings.filter((x) => typeof x === 'string' && x) : [];
  throw Object.assign(new Error((w.join('；') || '宿主没有保存这项设置').slice(0, 300)), { code: 'CONFIG_WRITE' });
}
/**
 * 调宿主的写接口。DSH 宿主（host/index.js）不成功时抛错：CONFIRM_REQUIRED（带 needsConfirm 理由）/ CONTRACT（不许经配置改）/
 * UNAVAILABLE（没写进去）；这里统一成 hostResult 认的 {ok:false, …}，两种宿主走同一条路。别的错误原样抛（超时之类）。
 */
async function hostWrite(fn) {
  try { return await within(10_000, fn); } catch (e) {
    const msg = typeof e?.message === 'string' ? e.message : '';
    if (e?.code === 'CONFIRM_REQUIRED') return { ok: false, warnings: [], needsConfirm: Array.isArray(e.needsConfirm) && e.needsConfirm.length ? e.needsConfirm.map(String) : [msg || '要先确认'] };
    if (e?.code === 'CONTRACT') return { ok: false, warnings: [], rejected: [msg || '不能经配置改'] };
    if (e?.code === 'UNAVAILABLE') return { ok: false, warnings: [msg || '宿主没有保存这项设置'] };
    throw e;
  }
}
const warningsOf = (r) => (Array.isArray(r?.warnings) ? r.warnings.slice(0, 8).map((w) => String(w).slice(0, 200)) : []);
/** 只留文件名（Windows 和 POSIX 的分隔符都认，页面不需要整条路径）。 */
const baseName = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : null);
const preview = (s, max = 80) => {
  if (typeof s !== 'string') return null;
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

/** 规则的目标和值（核心也会校验；这里先挡，并给看得懂的错误）。 */
function parseRule(b) {
  onlyKeys(b, ['action', 'kind', 'target', 'value', 'note']);
  const kind = oneOf(b.kind, ['do_not_remember', 'disclosure'], 'kind');
  if (!isPlainObject(b.target)) throw new InputError('target', '应为对象');
  const t = b.target;
  const note = text(b.note, 'note', { optional: true, max: 200 });
  if (kind === 'do_not_remember') {
    onlyKeys(t, ['settingKey', 'entityId', 'ref'], 'target');
    const opts = [
      t.settingKey != null ? { settingKey: opaque(t.settingKey, 'target.settingKey') } : null,
      t.entityId != null ? { entityId: posInt(t.entityId, 'target.entityId') } : null,
      t.ref != null ? { ref: opaque(t.ref, 'target.ref') } : null,
    ].filter(Boolean);
    if (opts.length !== 1) throw new InputError('target', '「别记」的目标只能是一个场合、一个人或一条记忆');
    if (b.value != null) throw new InputError('value', '「别记」规则不带值');
    return { kind, target: opts[0], ...(note ? { note } : {}) };
  }
  onlyKeys(t, ['entityId', 'attribute', 'settingKey', 'settingAttrs'], 'target');
  const target = {};
  if (t.entityId != null) target.entityId = posInt(t.entityId, 'target.entityId');
  if (t.attribute != null) target.attribute = text(t.attribute, 'target.attribute', { max: 60 });
  if (t.settingKey != null) target.settingKey = opaque(t.settingKey, 'target.settingKey');
  if (t.settingAttrs != null) {
    if (!isPlainObject(t.settingAttrs)) throw new InputError('target.settingAttrs', '应为对象');
    onlyKeys(t.settingAttrs, [...SETTING_ATTR_INT, ...SETTING_ATTR_BOOL], 'target.settingAttrs');
    const sa = {};
    for (const k of SETTING_ATTR_INT) if (t.settingAttrs[k] != null) {
      const v = t.settingAttrs[k];
      if (!Number.isInteger(v) || v < 0 || v > 10) throw new InputError(`target.settingAttrs.${k}`, '应为 0–10 的整数');
      sa[k] = v;
    }
    for (const k of SETTING_ATTR_BOOL) if (t.settingAttrs[k] != null) sa[k] = bool(t.settingAttrs[k], `target.settingAttrs.${k}`);
    if (Object.keys(sa).length) target.settingAttrs = sa;
  }
  if (!Object.keys(target).length) throw new InputError('target', '披露规则至少要指定一个人、一类信息或一种场合');
  if (!isPlainObject(b.value)) throw new InputError('value', '应为对象');
  onlyKeys(b.value, ['restriction', 'allow', 'deny'], 'value');
  const value = { restriction: oneOf(b.value.restriction, RESTRICTIONS, 'value.restriction') };
  for (const k of ['allow', 'deny']) if (b.value[k] != null && (!Array.isArray(b.value[k]) || b.value[k].length)) value[k] = list(b.value[k], `value.${k}`, posInt, { max: 64 });
  return { kind, target, value, ...(note ? { note } : {}) };
}

/**
 * @param {{pm: any, host: any, now: () => number, confirms: ReturnType<import('./confirm.js').createConfirmStore>,
 *          exportDir: () => string|null, views: ReturnType<import('./views.js').createViews>}} deps
 */
export function createActions(deps) {
  const { pm, host, now, confirms, views } = deps;
  const busy = new Set();
  const hostPart = (k) => (host && typeof host === 'object' ? host[k] : undefined);
  const needPart = (k, what) => { const v = hostPart(k); if (!v) throw unavailable(what); return v; };
  const setupPart = () => needPart('setup', '首次设置');
  const embeddingPart = () => needPart('embeddingSetup', '嵌入设置');
  const bridgePart = () => needPart('bridgeSetup', 'QQ 桥接设置');

  /** 同一类长操作同一时间只跑一个（两次「立即备份」、恢复时再恢复）。 */
  async function exclusive(key, fn) {
    if (busy.has(key)) throw Object.assign(new Error('上一个同类操作还没做完，请稍等'), { code: 'BUSY' });
    busy.add(key);
    try { return await fn(); } finally { busy.delete(key); }
  }

  /** 备份 id → 包（含路径）。页面只传 id，路径由服务端从备份登记里查，不接受页面给的路径。 */
  function packById(id) {
    let next;
    for (let i = 0; i < 20; i++) {
      const p = pm.admin.list({ view: 'backups', limit: 200, ...(next ? { next } : {}) });
      const hit = (p.items ?? []).find((b) => b.id === id);
      if (hit) return hit;
      next = p.next;
      if (!next) break;
    }
    throw notFound('这份备份（可能已经轮转删除了，点「重新扫描」看看）');
  }
  function pendingReview(id) {
    let next;
    for (let i = 0; i < 20; i++) {
      const p = pm.admin.list({ view: 'review', status: 'pending', limit: 200, ...(next ? { next } : {}) });
      const hit = (p.items ?? []).find((r) => r.id === id);
      if (hit) return hit;
      next = p.next;
      if (!next) break;
    }
    throw notFound('这条审核（可能已经处理过、过期或被撤回了）');
  }
  function settingByKey(key) {
    let next;
    for (let i = 0; i < 10; i++) {
      const p = pm.admin.list({ view: 'settings', limit: 200, ...(next ? { next } : {}) });
      const hit = (p.items ?? []).find((s) => s.key === key);
      if (hit) return hit;
      next = p.next;
      if (!next) break;
    }
    throw notFound('这个场合');
  }
  /** 经宿主写配置（热加载）。宿主说要确认、拒绝或没写成，都变成对应的错误。extra.replace：整个换掉的路径（不和原来的合并）。 */
  async function setConfig(patch, confirmed, extra = {}) {
    const cfg = hostPart('config');
    if (typeof cfg?.set !== 'function') throw unavailable('配置');
    return hostResult(await hostWrite(() => cfg.set(patch, { confirm: !!confirmed, ...extra })), confirmed);
  }
  /** 现在的花费护栏（预设、每档的值、主人改过的项）；宿主没给配置就按核心的默认值。 */
  const budgetNow = () => { const c = configParts(host); return budgetConfigView(c.core, c.host); };
  async function setGpu(arg, confirmed) {
    const gpu = hostPart('gpu');
    if (typeof gpu?.setPolicy !== 'function') throw unavailable('显卡策略');
    return hostResult(await hostWrite(() => gpu.setPolicy(arg)), confirmed);
  }
  const currentRetention = () => pm.admin.retention.get()?.current ?? '2y';
  const shortens = (to) => RETENTION_ORDER.indexOf(to) < RETENTION_ORDER.indexOf(currentRetention());

  /** @type {Record<string, {parse: (b: any) => any, needsConfirm?: (p: any) => boolean|Promise<boolean>, prepare?: (p: any) => any, bind?: (p: any) => any, run: (p: any, confirmed: {phrase: string|null}|null) => any}>} */
  const A = {
    // ── 需要你知道 ──────────────────────────────────────────────────────
    'ntk.read': {
      parse: (b) => ({ id: posInt(onlyKeys(b, ['action', 'id']).id, 'id') }),
      run: (p) => { pm.admin.needToKnow.markRead(p.id); return {}; },
    },
    // 按来源撤回（§12.7）：某人在某段时间提供的全部内容 → 先对别人隐藏、进审核队列，主人批准后才删
    'source.withdraw': {
      parse: (b) => {
        onlyKeys(b, ['action', 'entityId', 'from', 'to']);
        const p = { entityId: posInt(b.entityId, 'entityId'), from: timeMs(b.from, 'from'), to: timeMs(b.to, 'to') };
        if (p.from >= p.to) throw new InputError('from', '开始时间要早于结束时间');
        if (p.to - p.from > 3660 * DAY) throw new InputError('to', '时间范围太大（最多十年）');
        return p;
      },
      needsConfirm: () => true,
      prepare: (p) => {
        let name = null;
        try { name = (pm.admin.list({ view: 'entities', limit: 200 }).items ?? []).find((e) => e.id === p.entityId)?.name ?? null; } catch { name = null; }
        return { preview: { entityId: p.entityId, name, from: p.from, to: p.to } };
      },
      run: (p) => pm.admin.withdrawBySource(p),
    },

    // ── 审核队列 ────────────────────────────────────────────────────────
    'review.decide': {
      parse: (b) => {
        onlyKeys(b, ['action', 'id', 'decision']);
        return { id: posInt(b.id, 'id'), decision: oneOf(b.decision, ['approve', 'reject'], 'decision') };
      },
      // 批准「按来源撤回」= 彻底删除；批准挂起的发言 = 她真的会说出去。这两种要确认
      needsConfirm: (p) => p.decision === 'approve' && ['withdraw', 'held_utterance'].includes(pendingReview(p.id).kind),
      prepare: (p) => {
        const r = pendingReview(p.id);
        if (r.kind === 'withdraw') {
          const n = Array.isArray(r.payload?.refs) ? r.payload.refs.length : 0;
          return { phrase: `彻底删除 ${n} 条`, preview: { kind: r.kind, refs: n, entityId: r.payload?.entityId ?? null, from: r.payload?.from ?? null, to: r.payload?.to ?? null } };
        }
        return { preview: { kind: r.kind } };
      },
      run: async (p) => { await pm.admin.review.decide(p.id, p.decision); return {}; },
    },

    // ── 规则 ────────────────────────────────────────────────────────────
    'rules.add': {
      parse: parseRule,
      run: (p) => ({ id: pm.admin.rules.add(p) }),
    },
    'rules.revoke': {
      parse: (b) => ({ id: posInt(onlyKeys(b, ['action', 'id']).id, 'id') }),
      run: (p) => { pm.admin.rules.revoke(p.id); return {}; },
    },

    // ── 场合：模式（关 / 开）和「别记这里」 ────────────────────────
    'setting.mode': {
      parse: (b) => {
        onlyKeys(b, ['action', 'settingKey', 'mode']);
        return { settingKey: opaque(b.settingKey, 'settingKey'), mode: oneOf(b.mode, [...MODES, 'default'], 'mode') };
      },
      // 开着是默认（她在哪儿都记得，说不说由关口逐条判断）；关掉只是这里不感知、不注入，已有的不删，随时能开回来：都不用确认
      needsConfirm: () => false,
      run: (p) => {
        settingByKey(p.settingKey);   // 没有这个场合：404，不给不存在的场合写规则
        if (p.mode === 'default') {
          for (const r of pm.admin.rules.list('mode') ?? []) if (r.target?.settingKey === p.settingKey) pm.admin.rules.revoke(r.id);
          return {};
        }
        return { id: pm.admin.rules.add({ kind: 'mode', target: { settingKey: p.settingKey }, value: p.mode }) };
      },
    },
    // 【D111】给场合起名字 / 清掉（退回入口给的）。主人起的名字优先于一切，她心里、提示词、管理页都用它；随时能清掉，所以不用确认。
    // 日志只记操作名和结果（handlers.js），名字本身不进日志
    'setting.rename': {
      parse: (b) => {
        onlyKeys(b, ['action', 'settingKey', 'label']);
        // 名字原样存（不做 NFKC）；40 个字按码点算，和核心的 LIMITS.settingNameMax 一致
        return { settingKey: opaque(b.settingKey, 'settingKey'), label: text(b.label, 'label', { max: 40, optional: true, normalize: false }) };
      },
      needsConfirm: () => false,
      run: (p) => {
        settingByKey(p.settingKey);   // 没有这个场合：404
        if (typeof pm.admin.renameSetting !== 'function') throw unavailable('起名字');
        let r;
        try { r = pm.admin.renameSetting(p.settingKey, p.label); } catch (e) {
          // 核心清洗以后才知道的（只有看不见的字符）：给主人看得懂的错误，不悄悄清掉原来的名字
          if (e?.code === 'CONTRACT') throw new InputError('label', e.errors?.[0]?.message ?? '这个名字不能用');
          throw e;
        }
        if (!r) throw notFound('这个场合');
        return { label: r.label ?? null, labelSource: r.labelSource ?? (p.label ? 'owner' : 'adapter') };
      },
    },
    'setting.remember': {
      parse: (b) => {
        onlyKeys(b, ['action', 'settingKey', 'remember']);
        return { settingKey: opaque(b.settingKey, 'settingKey'), remember: bool(b.remember, 'remember') };
      },
      run: (p) => {
        const rules = (pm.admin.rules.list('do_not_remember') ?? []).filter((r) => r.target?.settingKey === p.settingKey);
        if (p.remember) { for (const r of rules) pm.admin.rules.revoke(r.id); return {}; }
        if (rules.length) return { id: rules[0].id };
        return { id: pm.admin.rules.add({ kind: 'do_not_remember', target: { settingKey: p.settingKey }, note: '管理页「别记这里」' }) };
      },
    },

    // ── 记忆：隐藏 / 忘掉 / 恢复 / 彻底删除（§12.7） ──────────────────
    'memory.hide': { parse: (b) => ({ ref: opaque(onlyKeys(b, ['action', 'ref']).ref, 'ref') }), run: (p) => { pm.admin.hide(p.ref); return {}; } },
    'memory.forget': { parse: (b) => ({ ref: opaque(onlyKeys(b, ['action', 'ref']).ref, 'ref') }), run: (p) => { pm.admin.forget(p.ref); return {}; } },
    'memory.restore': { parse: (b) => ({ ref: opaque(onlyKeys(b, ['action', 'ref']).ref, 'ref') }), run: (p) => { pm.admin.restore(p.ref); return {}; } },
    // 解除一条她在守的叮嘱（D113，「分寸」页）：只认 discretion.explicitLimit 认的条目
    'limit.relax': { parse: (b) => ({ ref: opaque(onlyKeys(b, ['action', 'ref']).ref, 'ref') }), run: (p) => ({ applied: !!pm.admin.relaxLimit(p.ref)?.applied }) },
    'memory.purge': {
      parse: (b) => {
        onlyKeys(b, ['action', 'refs', 'alsoBackups']);
        return { refs: list(b.refs, 'refs', opaque, { max: 50 }).sort(), alsoBackups: bool(b.alsoBackups, 'alsoBackups') };
      },
      needsConfirm: () => true,
      bind: (p) => ({ refs: p.refs }),
      prepare: (p) => {
        const items = p.refs.map((ref) => {
          const d = pm.admin.get(ref);
          if (!d) return { ref, missing: true };
          if (d.purged) return { ref, purged: true };
          const row = d.row ?? {};
          return { ref, kind: d.kind, text: preview(row.text ?? row.narrative ?? row.title ?? row.display_name ?? null),
            sources: Array.isArray(d.sources) ? d.sources.length : 0, injectedIn: Array.isArray(d.injectedIn) ? d.injectedIn.length : 0,
            suppression: d.suppression?.state ?? null };
        });
        const live = items.filter((x) => !x.missing && !x.purged).length;
        if (!live) return { refuse: '这些记忆都已经不在了' };
        return { phrase: `彻底删除 ${live} 条`, preview: { items, sessions: items.reduce((n, x) => n + (x.injectedIn ?? 0), 0) } };
      },
      run: (p) => exclusive('purge', async () => {
        const r = await pm.admin.purge(p.refs, { alsoBackups: p.alsoBackups });
        // 【D143】成长块去掉了几行、WAL 截没截断、备份包改写了几个和没改成的（原因）：管理页照实显示，没改成的不当成功
        const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
        const b = r?.backups;
        return {
          deleted: r?.deleted ?? {}, sessions: Array.isArray(r?.sessions) ? r.sessions.length : 0,
          growth: { lines: n(r?.growth?.lines), versions: n(r?.growth?.versions), unknown: n(r?.growth?.unknown) },
          wal: { main: String(r?.wal?.main ?? 'skipped'), vectors: String(r?.wal?.vectors ?? 'skipped') },
          ...(b ? { backups: { rewritten: n(b.rewritten), unchanged: n(b.unchanged), failed: n(b.failed),
            failures: (Array.isArray(b.failures) ? b.failures : []).slice(0, 20).map((f) => ({ id: f?.id ?? null, reason: String(f?.reason ?? 'error').slice(0, 60) })) } } : {}),
        };
      }),
    },

    // ── 夜里对照原话的改正（D122）：主人撤销一次，旧版本按确认过恢复 ─────────
    // ── 她的经验（D124）：主人确认一条（算验证过）；忘掉、隐藏、彻底删除照普通的记忆走 ─────────
    // ── 「有记忆 / 没记忆」评测（D126）：在宿主的 worker 线程里跑一次（临时库、不调模型），结果存进核心 ─────────
    'eval.run': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      run: () => exclusive('eval', async () => {
        const ev = hostPart('memoryEval');
        if (typeof ev?.run !== 'function') throw unavailable('记忆评测');
        const r = await ev.run();
        return { total: r?.total ?? 0, on: r?.on ?? 0, off: r?.off ?? 0, guards: r?.guards ?? 0, guardsHeld: r?.guardsHeld ?? 0 };
      }),
    },
    'lesson.confirm': {
      parse: (b) => ({ id: posInt(onlyKeys(b, ['action', 'id']).id, 'id') }),
      run: (p) => {
        const r = pm.admin.lessons?.confirm?.(p.id);
        if (!r?.ok) throw new InputError('id', r?.reason === 'superseded' ? '这条经验已经有更新的版本了' : '这不是一条经验');
        return { ref: r.ref ?? null };
      },
    },
    'check.revert': {
      parse: (b) => ({ id: posInt(onlyKeys(b, ['action', 'id']).id, 'id') }),
      needsConfirm: () => true,
      prepare: (p) => ({ preview: { id: p.id } }),
      run: (p) => {
        const r = pm.admin.checks.revert(p.id);
        if (!r?.reverted) throw new InputError('id', REVERT_REASON[r?.reason] ?? '撤销不了');
        return { restored: r.restored ?? null };
      },
    },

    // ── 成长块（§5.7） ──────────────────────────────────────────────────
    'growth.revoke': {
      parse: (b) => ({ version: posInt(onlyKeys(b, ['action', 'version']).version, 'version') }),
      run: (p) => { pm.admin.growth.revoke(p.version); return {}; },
    },
    'growth.rollback': {
      parse: (b) => ({ version: nonNegInt(onlyKeys(b, ['action', 'version']).version, 'version') }),
      needsConfirm: () => true,
      prepare: (p) => {
        const vs = pm.admin.growth.versions() ?? [];
        const cur = vs.filter((v) => !v.revokedAt).reduce((m, v) => Math.max(m, v.version), 0);
        const target = p.version === 0 ? { text: '' } : vs.find((v) => v.version === p.version);
        if (!target) return { refuse: '没有这个版本' };
        return { preview: { from: cur, to: p.version, undone: vs.filter((v) => v.version > p.version && !v.revokedAt).length } };
      },
      run: (p) => { pm.admin.growth.rollback(p.version); return {}; },
    },

    // ── 备份与恢复（§12.4） ─────────────────────────────────────────────
    'backup.now': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      run: () => exclusive('backup', async () => {
        const packs = await pm.admin.backup.now();
        return { packs: (packs ?? []).map((x) => ({ kind: x.kind ?? null, location: x.location ?? null, verified: x.verified ?? null, size: x.size ?? null })) };
      }),
    },
    'backup.verify': {
      parse: (b) => {
        onlyKeys(b, ['action', 'id', 'recoveryCode']);
        return { id: posInt(b.id, 'id'), recoveryCode: text(b.recoveryCode, 'recoveryCode', { optional: true, max: 200 }) };
      },
      run: (p) => exclusive('backup', async () => {
        const pack = packById(p.id);
        const r = await pm.admin.backup.verify(pack.path, p.recoveryCode ? { recoveryCode: p.recoveryCode } : undefined);
        return { ok: !!r?.ok, errors: (r?.errors ?? []).map((e) => String(e).slice(0, 200)) };
      }),
    },
    'backup.rescan': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      run: () => exclusive('backup', async () => ({ found: (await pm.admin.backup.rescan())?.found ?? 0 })),
    },
    'backup.restore': {
      parse: (b) => {
        onlyKeys(b, ['action', 'id', 'recoveryCode', 'restoreConfig']);
        return { id: posInt(b.id, 'id'), recoveryCode: text(b.recoveryCode, 'recoveryCode', { optional: true, max: 200 }),
          restoreConfig: b.restoreConfig == null ? undefined : bool(b.restoreConfig, 'restoreConfig') };
      },
      needsConfirm: () => true,
      bind: (p) => ({ id: p.id }),
      prepare: (p) => exclusive('backup', async () => {
        const pack = packById(p.id);
        const pv = await pm.admin.backup.preview(pack.path, p.recoveryCode ? { recoveryCode: p.recoveryCode } : undefined);
        if (!pv?.ok) return { refuse: `这份包验证不过：${(pv?.errors ?? []).map((e) => String(e).slice(0, 80)).join('；') || '原因不明'}` };
        return { phrase: pv.confirmPhrase, preview: { pack: pv.pack ? { ...pv.pack, path: undefined, name: baseName(pv.pack.path) } : null,
          diff: pv.diff ?? null, changed: pv.changed ?? null, people: pv.people ?? null, gaps: pv.gaps ?? [], tombstonesToReapply: pv.tombstonesToReapply ?? 0,
          newMachine: !!pv.newMachine, warnings: pv.warnings ?? [] } };
      }),
      run: (p, confirmed) => exclusive('backup', async () => {
        const pack = packById(p.id);
        const r = await pm.admin.backup.restore(pack.path, { confirmPhrase: confirmed.phrase, ...(p.recoveryCode ? { recoveryCode: p.recoveryCode } : {}),
          ...(p.restoreConfig !== undefined ? { restoreConfig: p.restoreConfig } : {}) });
        return { ok: !!r?.ok, gaps: r?.gaps ?? [], preRestorePack: r?.preRestorePack ? baseName(r.preRestorePack) : null,
          tombstonesReapplied: r?.tombstonesReapplied ?? 0, configRestored: !!r?.configRestored, identityKeyReplaced: !!r?.identityKeyReplaced };
      }),
    },
    'backup.restorePartial': {
      parse: (b) => {
        onlyKeys(b, ['action', 'id', 'selector', 'recoveryCode']);
        if (!isPlainObject(b.selector)) throw new InputError('selector', '应为对象');
        onlyKeys(b.selector, ['entityIds', 'settingKeys', 'before'], 'selector');
        const selector = {};
        if (b.selector.entityIds != null) selector.entityIds = list(b.selector.entityIds, 'selector.entityIds', posInt, { max: 50 }).sort((x, y) => x - y);
        if (b.selector.settingKeys != null) selector.settingKeys = list(b.selector.settingKeys, 'selector.settingKeys', opaque, { max: 50 }).sort();
        if (b.selector.before != null) selector.before = timeMs(b.selector.before, 'selector.before');
        if (!Object.keys(selector).length) throw new InputError('selector', '要选一个人、一个场合或一个时间点');
        return { id: posInt(b.id, 'id'), selector, recoveryCode: text(b.recoveryCode, 'recoveryCode', { optional: true, max: 200 }) };
      },
      needsConfirm: () => true,
      bind: (p) => ({ id: p.id, selector: p.selector }),
      prepare: (p) => {
        const pack = packById(p.id);
        return { phrase: '确认部分恢复', preview: { pack: { id: pack.id, kind: pack.kind, createdAt: pack.createdAt, name: baseName(pack.path) }, selector: p.selector } };
      },
      run: (p) => exclusive('backup', async () => {
        const pack = packById(p.id);
        const r = await pm.admin.backup.restorePartial(pack.path, p.selector, p.recoveryCode ? { recoveryCode: p.recoveryCode } : undefined);
        return { report: r ?? null };
      }),
    },
    'backup.export': {
      parse: (b) => (onlyKeys(b, ['action', 'encrypt']), { encrypt: bool(b.encrypt, 'encrypt') }),
      run: (p) => exclusive('backup', async () => {
        const dir = deps.exportDir?.();
        if (!dir) throw unavailable('导出目录');
        const r = await pm.admin.backup.exportJsonl({ dest: `${dir}${path.sep}`, encrypt: p.encrypt });
        return { name: baseName(r?.path) ?? '', counts: r?.counts ?? {}, encrypted: p.encrypt };
      }),
    },
    // 开启 / 更换备份加密：恢复码只在这一次的响应里出现（§12.4.3）；这里不存、不记日志
    'backup.encryption': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      needsConfirm: () => true,
      prepare: () => {
        let encrypted = false;
        try { encrypted = !!pm.admin.backup.overview()?.offsite?.encrypted; } catch { encrypted = false; }
        return encrypted ? { phrase: '更换恢复码', preview: { replacing: true } } : { preview: { replacing: false } };
      },
      run: () => exclusive('backup', async () => {
        const r = await pm.admin.backup.setupEncryption({});
        return { keyId: r?.keyId ?? null, recoveryCode: r?.recoveryCode ?? null };
      }),
    },
    'backup.offsite': {
      parse: (b) => (onlyKeys(b, ['action', 'dir']), { dir: absDir(b.dir, 'dir') }),
      run: async (p) => ({ warnings: warningsOf(await setConfig({ backup: { offsiteDir: p.dir } }, false)) }),
    },

    // ── 原文保留期（§12.6）：延长立即生效；缩短要确认语 + 7 天冷静期 ──
    'retention.request': {
      parse: (b) => (onlyKeys(b, ['action', 'to']), { to: oneOf(b.to, RETENTION_ORDER, 'to') }),
      needsConfirm: (p) => shortens(p.to),
      prepare: (p) => {
        const r = pm.admin.retention.request(p.to);   // 缩短时只返回 need-confirm，不改任何东西
        if (r?.status !== 'need-confirm') return { refuse: '保留期已经变了，请刷新后再试' };
        const c = views.config().core?.retention?.coolingOffDays;
        const cool = typeof c === 'number' && c >= 0 ? c : 7;
        return { phrase: r.confirmPhrase, preview: { from: currentRetention(), to: p.to, fromLabel: retentionLabel(currentRetention()), toLabel: retentionLabel(p.to),
          impact: r.impact ?? null, coolingOffDays: cool, effectiveAt: now() + cool * DAY } };
      },
      run: (p, confirmed) => {
        const r = confirmed ? pm.admin.retention.request(p.to, confirmed.phrase) : pm.admin.retention.request(p.to);
        if (r?.status === 'need-confirm') throw Object.assign(new Error('影响范围变了（又过了一个月？），请重新预览'), { code: 'CONFIRM_REQUIRED' });
        return { status: r?.status ?? null, effectiveAt: r?.effectiveAt ?? null };
      },
    },
    'retention.cancel': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      run: () => { pm.admin.retention.cancel(); return {}; },
    },

    // ── 设置：模式、预算预设、成长块方式（热加载，经宿主写配置文件） ────
    'config.set': {
      parse: (b) => {
        onlyKeys(b, ['action', 'key', 'value', 'ask']);
        const key = oneOf(b.key, Object.keys(CONFIG_KEYS), 'key');
        return { key, value: oneOf(b.value, CONFIG_KEYS[key], 'value'), ask: bool(b.ask, 'ask') };
      },
      // 宿主自己认为有风险的改动（关掉总开关……），第一次提交会拿到 CONFIRM_REQUIRED 和理由，页面带 ask 再走一遍确认
      needsConfirm: (p) => p.ask,
      bind: (p) => ({ key: p.key, value: p.value }),
      prepare: (p) => ({ preview: { key: p.key, value: p.value } }),
      run: async (p, confirmed) => {
        const patch = {};
        let cur = patch;
        const parts = p.key.split('.');
        parts.forEach((k, i) => { cur[k] = i === parts.length - 1 ? p.value : {}; cur = cur[k]; });
        return { warnings: warningsOf(await setConfig(patch, confirmed)) };
      },
    },
    // 花费护栏（D121）：选一档预设，加上主人单独改的项（overrides，整个替换：不给 = 回到那一档）。
    // 和那一档一样的项不存；换成「不设上限」、关掉余额保护、去掉某一项上限要确认（和现在一样的不再问）
    'budget.set': {
      parse: (b) => {
        onlyKeys(b, ['action', 'preset', 'overrides', 'ask']);
        const preset = oneOf(b.preset, BUDGET_PRESETS, 'preset');
        const raw = b.overrides == null ? {} : b.overrides;
        if (!isPlainObject(raw)) throw new InputError('overrides', '应为对象');
        onlyKeys(raw, BUDGET_OVERRIDE_KEYS, 'overrides');
        const base = budgetNow().presets[preset];
        const overrides = {};
        for (const k of BUDGET_OVERRIDE_KEYS) {
          if (!Object.hasOwn(raw, k)) continue;
          const v = budgetValue(k, raw[k], `overrides.${k}`);
          if (v !== base[k]) overrides[k] = v;
        }
        return { preset, overrides, ask: bool(b.ask, 'ask') };
      },
      needsConfirm: (p) => p.ask || budgetRisks(budgetNow(), p).length > 0,
      bind: (p) => ({ preset: p.preset, overrides: p.overrides }),
      prepare: (p) => ({ preview: { preset: p.preset, overrides: p.overrides, reasons: budgetRisks(budgetNow(), p) } }),
      run: async (p, confirmed) => ({
        warnings: warningsOf(await setConfig({ budget: { preset: p.preset, overrides: p.overrides } }, confirmed, { replace: ['budget.overrides'] })),
      }),
    },
    // 配置文件被直接改过、里面有风险的改动（关掉外发审视、解除冻结……）：热加载时宿主先扣下没生效，只有主人在这里确认才生效
    'config.applyPending': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      needsConfirm: () => true,
      prepare: () => {
        const cfg = hostPart('config');
        let list = [];
        try { list = typeof cfg?.pending === 'function' ? cfg.pending() ?? [] : []; } catch { list = []; }
        return { preview: { items: (Array.isArray(list) ? list : []).slice(0, 20).map((x) => ({ path: String(x?.path ?? '').slice(0, 80), reason: String(x?.reason ?? '').slice(0, 200) })) } };
      },
      run: async (p, confirmed) => {
        const cfg = hostPart('config');
        if (typeof cfg?.applyPending !== 'function') throw unavailable('配置');
        const r = hostResult(await hostWrite(() => cfg.applyPending({ confirm: !!confirmed })), confirmed);
        return { applied: Number(r?.applied) || 0, warnings: warningsOf(r) };
      },
    },
    'config.discardPending': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      run: async () => {
        const cfg = hostPart('config');
        if (typeof cfg?.discardPending !== 'function') throw unavailable('配置');
        hostResult(await hostWrite(() => cfg.discardPending()), null);
        return {};
      },
    },
    // 显卡策略（§8.6.2）。「一直用」不看显存，玩游戏、开 TTS 时可能卡（宿主也把它当有风险的改动），要确认
    'gpu.policy': {
      parse: (b) => (onlyKeys(b, ['action', 'policy', 'ask']), { policy: oneOf(b.policy, GPU_POLICIES, 'policy'), ask: bool(b.ask, 'ask') }),
      needsConfirm: (p) => p.ask || p.policy === 'on',
      bind: (p) => ({ policy: p.policy }),
      prepare: (p) => ({ preview: { policy: p.policy } }),
      run: async (p, confirmed) => ({ warnings: warningsOf(await setGpu({ policy: p.policy, confirm: !!confirmed }, confirmed)) }),
    },
    // 游戏模式（§13.1 设置）：开着的时候让出显卡、CPU 也少占几个线程。hours 不给 = 一直开到手动关
    'gpu.gameMode': {
      parse: (b) => {
        onlyKeys(b, ['action', 'on', 'hours']);
        const on = bool(b.on, 'on');
        let hours = null;
        if (b.hours != null) {
          hours = posInt(b.hours, 'hours');
          if (hours > GAME_MODE_MAX_H) throw new InputError('hours', `最多 ${GAME_MODE_MAX_H} 小时`);
        }
        if (!on && hours != null) throw new InputError('hours', '关掉游戏模式不带时长');
        return { on, hours };
      },
      run: async (p) => ({ warnings: warningsOf(await setGpu({ gameMode: { on: p.on, ...(p.hours != null ? { hours: p.hours } : {}) } }, false)) }),
    },
    'selfcheck.run': {
      parse: (b) => (onlyKeys(b, ['action']), {}),
      run: async () => {
        const r = await views.selfCheck(true);
        return r?.error ? { error: r.error } : { total: r.items.length, failed: r.items.filter((c) => c.status === 'fail').length };
      },
    },
    // 首次设置走完（D128）：主人确认过告知才放行开库；名字都是可选的
    'setup.finish': {
      parse: (b) => {
        onlyKeys(b, ['action', 'ack', 'principalLabel', 'presetName', 'selfNames', 'offGroups']);
        if (b.ack !== true) throw new InputError('ack', '要先勾选「我知道了」');
        const names = b.selfNames == null ? [] : list(b.selfNames, 'selfNames', (v, p) => text(v, p, { max: 30 }), { max: 16, min: 0 });
        const groupId = (v, p) => { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new InputError(p, '群号不对'); return v; };
        const offGroups = b.offGroups == null ? [] : list(b.offGroups, 'offGroups', groupId, { max: 500, min: 0 });
        return { principalLabel: b.principalLabel ? text(b.principalLabel, 'principalLabel', { max: 20 }) : '', presetName: b.presetName ? text(b.presetName, 'presetName', { max: 40 }) : '', selfNames: names, offGroups };
      },
      run: (p) => setupPart().finish(p),
    },
    // 嵌入三档（D127）。下载、测试不用确认；保存时换模型、发给第三方要先确认
    'embedding.pull': {
      parse: (b) => { onlyKeys(b, ['action', 'tier', 'url']); return { tier: oneOf(b.tier, ['standard', 'light'], 'tier'), url: b.url ? text(b.url, 'url', { max: 300, normalize: false }) : '' }; },
      run: (p) => embeddingPart().startPull(p),
    },
    'embedding.pullCancel': { parse: (b) => (onlyKeys(b, ['action']), {}), run: () => embeddingPart().cancelPull() },
    'embedding.test': {
      parse: (b) => { onlyKeys(b, ['action', 'url', 'model', 'dim', 'apiKey']); return { url: text(b.url, 'url', { max: 300, normalize: false }), model: text(b.model, 'model', { max: 200, normalize: false }), dim: b.dim == null || b.dim === 0 ? 0 : posInt(b.dim, 'dim'), apiKey: b.apiKey ? text(b.apiKey, 'apiKey', { max: 512, normalize: false }) : '' }; },
      run: (p) => embeddingPart().test(p),
    },
    'embedding.save': {
      parse: (b) => {
        onlyKeys(b, ['action', 'mode', 'tier', 'url', 'model', 'dim', 'sendDimensions', 'apiKey', 'clearKey']);
        const mode = oneOf(b.mode, ['none', 'ollama', 'external'], 'mode');
        const p = { mode };
        if (mode === 'ollama') { p.tier = oneOf(b.tier, ['standard', 'light'], 'tier'); p.url = b.url ? text(b.url, 'url', { max: 300, normalize: false }) : ''; }
        if (mode === 'external') {
          p.url = text(b.url, 'url', { max: 300, normalize: false }); p.model = text(b.model, 'model', { max: 200, normalize: false }); p.dim = posInt(b.dim, 'dim');
          p.sendDimensions = b.sendDimensions !== false;
          if (b.apiKey) p.apiKey = text(b.apiKey, 'apiKey', { max: 512, normalize: false });
          if (b.clearKey) p.clearKey = bool(b.clearKey, 'clearKey');
        }
        return p;
      },
      needsConfirm: (p) => embeddingPart().reasonsFor(p).reasons.length > 0,
      // 令牌只绑定配置，不绑定 Key（Key 不进任何令牌和日志）
      bind: ({ apiKey, ...rest }) => rest,
      prepare: (p) => ({ preview: { reasons: embeddingPart().reasonsFor(p).reasons } }),
      run: (p) => embeddingPart().save(p),
    },
    // QQ 桥接（D129）：白名单补丁，预览 + 确认 + 可还原；改了要彻底重启 DSH
    'bridge.apply': {
      parse: (b) => { onlyKeys(b, ['action', 'dir', 'revert']); return { dir: absDir(b.dir, 'dir'), revert: b.revert == null ? false : bool(b.revert, 'revert') }; },
      needsConfirm: () => true,
      prepare: (p) => ({ preview: bridgePart().preview(p) }),
      run: (p) => bridgePart().apply(p),
    },
    'bridge.setDir': {
      parse: (b) => { onlyKeys(b, ['action', 'dir']); return { dir: absDir(b.dir ?? '', 'dir') }; },
      run: (p) => bridgePart().setDir(p.dir),
    },
    // 换向量空间（§8.9）：影子评测通过后切换；对可疑空间「就用现在这个模型」（rebaseline，全部重嵌）
    'embedding.activate': {
      parse: (b) => {
        onlyKeys(b, ['action', 'spaceId', 'rebaseline']);
        return { spaceId: opaque(b.spaceId, 'spaceId'), rebaseline: bool(b.rebaseline, 'rebaseline') };
      },
      needsConfirm: () => true,
      prepare: (p) => ({ preview: { spaceId: p.spaceId, rebaseline: p.rebaseline } }),
      run: async (p) => {
        const r = await pm.admin.embedding.activate(p.spaceId, p.rebaseline ? { rebaseline: true } : {});
        return { ok: !!r?.ok, reason: r?.reason ?? null, coverage: r?.coverage ?? null };
      },
    },
  };

  return {
    names: Object.keys(A),
    /**
     * 执行一个操作（含确认令牌的核对）。
     * @param {string} name
     * @param {Record<string, unknown>} body   请求体（已解析）
     */
    async run(name, body) {
      if (name === 'prepare') return prepare(body);
      if (!Object.hasOwn(A, name)) throw new InputError('action', '不认识的操作');
      const spec = A[name];
      const { confirm, ...rest } = body;
      const p = await spec.parse(rest);
      const need = spec.needsConfirm ? await spec.needsConfirm(p) : false;
      if (!need && confirm !== undefined && !isPlainObject(confirm)) throw new InputError('confirm', '格式不对');
      // 确认过的：run 拿到 {phrase}（令牌里存的那句确认语，不是页面输入的那份）；不用确认的：null
      const confirmed = need ? confirms.consume(name, spec.bind ? spec.bind(p) : p, confirm) : null;
      return spec.run(p, confirmed);
    },
  };

  /** prepare：{for, params} → {needsConfirm, token?, phrase?, expiresAt?, preview?} 或 {refuse}。 */
  async function prepare(body) {
    onlyKeys(body, ['action', 'for', 'params']);
    const name = body.for;
    if (typeof name !== 'string' || !Object.hasOwn(A, name)) throw new InputError('for', '不认识的操作');
    const spec = A[name];
    const params = body.params == null ? {} : body.params;
    if (!isPlainObject(params)) throw new InputError('params', '应为对象');
    const p = await spec.parse({ ...params, action: name });
    const need = spec.needsConfirm ? await spec.needsConfirm(p) : false;
    if (!need) return { needsConfirm: false };
    const pr = spec.prepare ? await spec.prepare(p) : {};
    if (pr?.refuse) return { needsConfirm: true, refuse: pr.refuse };
    const t = confirms.issue(name, spec.bind ? spec.bind(p) : p, { phrase: pr?.phrase ?? null });
    return { needsConfirm: true, token: t.token, phrase: t.phrase, expiresAt: t.expiresAt, preview: pr?.preview ?? null };
  }
}

/** 导出文件名（下载路由只认这种名字，不收路径）。 */
export function exportFileName(name) {
  if (typeof name !== 'string' || !EXPORT_NAME_RE.test(name)) throw new InputError('name', '文件名不对');
  return name;
}

export { codeOf };
