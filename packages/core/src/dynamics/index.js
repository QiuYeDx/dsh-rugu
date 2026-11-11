// dynamics 模块（§6、§5.4 成立概率、§5.7 心境）：两条互不相干的曲线。
//   - 可及性：A = B + S + C + I − P_sup + ε，P(想起) = σ((A − τ)/s)。B 是 ACT-R 基础激活（幂律衰减、每条痕迹自己的衰减率）。
//   - 有效性：p_hold(t) = 2^(−((t − valid_from)/t50)^shape)，超过 valid_to_known 为 0；change_known 再乘系数。
//   - 听说不进编码强度（评审:UV-01）；只被召回、注入、对同一批人复述、导入都**不加痕迹**（§6.4）。
//   - 每个函数的数值都从 core.config.get().activation / validity / intention / mood 取（热加载）。
// 拥有的表：traces、activation、mood。
// 用到的端口：clock。
// 契约细节：docs/实现/模块与接口.md §4.5。
import { refOf, parseRef, OWNER_KINDS, getMetaJson, setMetaJson, setMeta, bumpMetric } from '../store/index.js';
import {
  HOUR_MS, DAY_MS, emptyAgg, baseActivationOf as baseOf, replayDecays, foldOldest, mergeAgg, stateFromEvents as fromEvents,
  pRecall as pRecallOf, seededNoise as noiseOf, pHoldOf, localDay, slotOf,
} from './actr.js';

/**
 * §6.2 的注意力类别。
 * @typedef {'self'|'toHer'|'mentionsHer'|'participating'|'attendedAmbient'|'peripheral'|'contentSkimmed'|'contentOpened'|'selfThought'} AttentionClass
 */
/**
 * @typedef {object} TraceState
 * @property {{t: number, w: number, d: number}[]} traces   精确痕迹，按时间升序
 * @property {{n: number, w: number, first: number|null, last: number|null, d: number|null}} agg
 */
/**
 * activate() 的输入：retrieve 算好的各项，dynamics 补上 B、I、P_sup、ε。
 * @typedef {object} ActivationInput
 * @property {import('../core-types.js').Candidate} candidate
 * @property {number} S                  线索扩散（PPR 归一化到 0–S_max，加扇出项）
 * @property {number} C                  情境与语义匹配（调参前用 RRF 名次分）
 * @property {boolean} superseded
 * @property {object|null} [intention]   候选是意图时的 intentions 行
 * @property {boolean} [cueHit]
 */

// 算「又遇到了一次」的事件（§6.4）。别的 reason（injected、recalled、retold-same-audience、import、compaction……）一律不加痕迹：
// 用白名单而不是黑名单，新出现的说法默认不算，免得「用上了 → 变牢 → 更常被召回」的自我喂养回路从缝里钻回来（v1:648）。
const COUNTED = new Set(['encode', 'mention', 'reread', 'confirm', 'asked', 'reply', 'retell', 'replay', 'inherit']);
// 有自己痕迹行的记忆单元（§2.2）。impression 跟随实体；percept 只编码一次（w_enc）；intention 的 I 项另算；link 没有痕迹
const TRACED = new Set(['window', 'episode', 'assertion', 'entity', 'storyline', 'community']);
const SELF_DOING = new Set(['self-utterance', 'self-action', 'on-my-behalf']);
const CHUNK = 400;

/** @param {import('../core-types.js').CoreContext} core */
export function init(core) {
  core.state.dynamics = {};
}
/** @param {import('../core-types.js').CoreContext} core */
export function dispose(core) { /* 无资源 */ }

// ── 编码强度（§6.2） ─────────────────────────────────────────────────────

/**
 * 注意力类别和 w_att（§6.2 的表）。kind / addressed / attention 来自感知；herSpokeRecently = 她最近
 * activation.participatingWindowMin 分钟在这个场合说过话；opened 只对 content 有意义（点开看了 vs 只扫过）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{kind: string, addressed: string, attention: string}} p
 * @param {{herSpokeRecently: boolean, opened?: boolean}} ctx
 * @returns {{cls: AttentionClass, wAtt: number}}
 */
export function attentionClass(core, p, ctx) {
  const W = core.config.get().activation.attention;
  const cls = classify(p ?? {}, ctx ?? {});
  return { cls, wAtt: W[cls] };
}
function classify(p, ctx) {
  if (p.kind === 'self-thought') return 'selfThought';
  if (SELF_DOING.has(p.kind) || p.addressed === 'by-her') return 'self';
  if (p.kind === 'content') {
    // 只在信息流里扫过 vs 点开看了；适配器没说时按注意力推（attended = 看了）
    const opened = typeof ctx.opened === 'boolean' ? ctx.opened : p.attention === 'attended';
    return opened ? 'contentOpened' : 'contentSkimmed';
  }
  if (p.addressed === 'to-her') return 'toHer';
  if (p.addressed === 'mentions-her') return 'mentionsHer';   // 鸡尾酒会效应：自己的名字总会被注意到
  if (p.attention === 'peripheral') return 'peripheral';
  return ctx.herSpokeRecently ? 'participating' : 'attendedAmbient';
}

/**
 * 编码强度 w = w_att × w_self × w_sal × w_rel × w_emo（§6.2）。缺的因子按 1（imp 缺省按 activation.defaultImp）。
 * 听说不进这个公式（评审:UV-01）：调用方不该、也没有参数可以给听说打折。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{wAtt: number, selfRelevance?: number, imp?: number, closeness?: number, emotionIntensity?: number}} f
 * @returns {number}
 */
export function encodingWeight(core, f) {
  const A = core.config.get().activation;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const wAtt = Math.max(0, num(f?.wAtt) ?? A.attention.attendedAmbient);
  const self = num(f?.selfRelevance);
  const wSelf = self == null ? 1 : clamp(self, A.selfRelevance.min, A.selfRelevance.max);
  const imp = clamp(num(f?.imp) ?? A.defaultImp, 1, 10);
  const wSal = Math.pow(2, (imp - A.salience.pivot) / A.salience.scale);
  const close = num(f?.closeness);
  const wRel = close == null ? 1 : A.relation.base + A.relation.span * clamp(close, 0, 1);
  const emo = num(f?.emotionIntensity);
  const wEmo = emo == null ? 1 : 1 + A.emotion.span * clamp(emo, 0, 1);
  return wAtt * wSelf * wSal * wRel * wEmo;
}

/**
 * 【补】她最近 activation.participatingWindowMin 分钟有没有在这个场合说过话（attentionClass 的 herSpokeRecently，给 intake 用）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {number} at
 * @returns {boolean}
 */
export function herSpokeRecently(core, settingKey, at) {
  const min = core.config.get().activation.participatingWindowMin;
  const row = core.store.get(`SELECT 1 AS x FROM percepts WHERE setting_key = ? AND actor_self = 1
    AND kind IN ('self-utterance','self-action','on-my-behalf') AND at <= ? AND at >= ? LIMIT 1`, settingKey, at, at - min * 60_000);
  return !!row;
}

// ── 痕迹（§6.3、§6.4） ────────────────────────────────────────────────────

/**
 * 加一条痕迹（§6.3、§6.4）。规则全在这里执行，调用方不用自己判断：
 *   - reason 不算「又遇到了一次」的（'injected'、'recalled'、'retold-same-audience'、'import'、'compaction'）直接拒绝；
 *   - 来源窗口：同一条记忆 6 小时内最多一条；同一 sourceKey 同一天最多一条；
 *   - 上限：replay 每条 ≤ 3 次且只给 30 天内的新记忆；retell 每条 ≤ 5 次；
 *   - d_j = a + c·e^min(m_{j−1}, 3)，上限 dMax，第一条 d = a；超过 K 条的旧痕迹并进聚合项（Petrov 2006）；
 *   - t 用证据消息的时间（迟到的处理不改变结果）。
 * 在调用方的事务里调用（同步）。
 *
 * 实现上的几点（docs 里没写死的，取确定、和到达顺序无关的做法）：
 *   - w 是 §6.2 的编码强度；§6.4 的事件系数在这里乘（只在这里，调用方给编码强度本身、不要先乘，D137）：
 *     confirm × events.confirm、asked × events.askedAndRecalled；
 *     retell、replay 的权重是固定的 events.retellNewAudience / events.replay（调用方给的 w 不用）；
 *   - 「6 小时内一条」按本地时间对齐的 6 小时格算，「同一天」按本地日（config.time.tzOffsetMin）；
 *     同一格（或同一来源同一天）里**最早**的那次算数：迟到的、更早的证据会顶替已记下的较晚那条，所以结果不依赖处理顺序；
 *   - 插到中间的痕迹会让它后面的痕迹按「写入前一刻的激活」重算衰减率；
 *   - impression 的痕迹跟随它的实体（§2.2）；percept、intention、link 没有痕迹行，返回 not-counted；
 *   - retell 同一个 sourceKey（听众）只算一次。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {{t: number, w: number, sourceKey: string,
 *          reason: 'encode'|'mention'|'reread'|'confirm'|'asked'|'reply'|'retell'|'replay'|'inherit'|string}} tr
 * @returns {{added: boolean, why?: 'not-counted'|'memory-window'|'source-window'|'cap'|'too-old'}}
 */
export function addTrace(core, ref, tr) {
  const cfg = core.config.get();
  const reason = tr?.reason;
  if (!COUNTED.has(reason)) return reject(core, 'not-counted', reason === 'injected' || reason === 'recalled' ? 'reason' : 'other');
  const target = traceTarget(core, ref);
  if (!target) return reject(core, 'not-counted', 'kind');
  const t = Number(tr.t);
  const w0 = Number(tr.w);
  if (!Number.isFinite(t) || !Number.isFinite(w0) || !(w0 > 0)) {
    core.log.warn('dynamics.trace.bad', { kind: target.kind, id: target.id });
    return reject(core, 'not-counted', 'value');
  }
  const ev = cfg.activation.events;
  const w = reason === 'confirm' ? w0 * ev.confirm
    : reason === 'asked' ? w0 * ev.askedAndRecalled
      : reason === 'retell' ? ev.retellNewAudience
        : reason === 'replay' ? ev.replay : w0;
  const sourceKey = typeof tr.sourceKey === 'string' ? tr.sourceKey : '';
  const res = core.store.tx(() => addTraceTx(core, target, { t, w, sourceKey, reason }, cfg));
  if (!res.added) bumpMetric(core.store, `dynamics.trace.${res.why}`);
  return res;
}

function reject(core, why, what) {
  try { if (!core.readOnly) bumpMetric(core.store, `dynamics.trace.${why}.${what}`); } catch { /* 计数失败不影响 */ }
  return { added: false, why };
}

function addTraceTx(core, target, ev, cfg) {
  const A = cfg.activation;
  const P = ageParams(cfg);
  const tz = cfg.time.tzOffsetMin;
  const { traces, act } = loadOne(core.store, target.kind, target.id);
  let agg = aggOf(act);
  const counters = { replay: act?.replay_count ?? 0, retell: act?.retell_count ?? 0 };

  // 上限（§6.4）
  if (ev.reason === 'replay') {
    if (counters.replay >= A.events.replayMaxPerUnit) return { added: false, why: 'cap' };
    const first = earliestOf(traces, agg) ?? ev.t;
    if (ev.t - first > A.events.replayWithinDays * DAY_MS) return { added: false, why: 'too-old' };
  }
  if (ev.reason === 'retell') {
    if (counters.retell >= A.events.retellMaxPerUnit) return { added: false, why: 'cap' };
    if (ev.sourceKey && traces.some((x) => x.reason === 'retell' && x.source_key === ev.sourceKey)) return { added: false, why: 'source-window' };
  }

  // 来源窗口（防刷屏、防慢性灌输，v1:623）
  const remove = [];
  const slotMs = A.sourceWindow.sameMemoryH * HOUR_MS;
  if (slotMs > 0) {
    const slot = slotOf(ev.t, slotMs, tz);
    const x = traces.find((r) => slotOf(r.t, slotMs, tz) === slot);
    if (x) {
      if (x.t <= ev.t) return { added: false, why: 'memory-window' };
      remove.push(x);   // 更早的证据迟到了：它才是这一格里「遇到」的那一次
    } else if (agg.n > 0 && agg.last != null && ev.t <= agg.last && slotOf(agg.last, slotMs, tz) === slot) {
      return { added: false, why: 'memory-window' };
    }
  }
  const perDay = A.sourceWindow.sameSourcePerDay;
  if (ev.sourceKey && perDay > 0) {
    const day = localDay(ev.t, tz);
    const same = traces.filter((r) => !remove.includes(r) && r.source_key === ev.sourceKey && localDay(r.t, tz) === day);
    if (same.length >= perDay) {
      const later = same.filter((r) => r.t > ev.t).sort((p, q) => p.t - q.t);
      const need = same.length - perDay + 1;
      if (later.length < need) return { added: false, why: 'source-window' };
      remove.push(...later.slice(later.length - need));
    }
  }

  // 插入、按时间重算衰减率、超过 K 条的并进聚合项
  const kept = traces.filter((r) => !remove.includes(r));
  const fresh = { id: null, t: ev.t, w: ev.w, d: A.a, source_key: ev.sourceKey, reason: ev.reason };
  const merged = [...kept, fresh].sort((p, q) => p.t - q.t || (p.id ?? Infinity) - (q.id ?? Infinity));
  const changedFrom = Math.min(ev.t, ...remove.map((r) => r.t));
  const from = merged.findIndex((r) => r.t >= changedFrom);
  const before = new Map(merged.map((r) => [r, r.d]));
  replayDecays(merged, agg, { ...P, a: A.a, c: A.c, dMax: A.dMax }, from < 0 ? merged.length : from);
  const folded = foldOldest(merged, agg, A.exactTraces);
  agg = folded.agg;

  const store = core.store;
  for (const r of [...remove, ...folded.folded]) if (r.id != null) store.run('DELETE FROM traces WHERE id = ?', r.id);
  for (const r of merged) {
    if (r.id == null) {
      store.run('INSERT INTO traces(owner_kind, owner_id, t, w, d, source_key, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        target.kind, target.id, r.t, r.w, r.d, r.source_key, r.reason);
    } else if (before.get(r) !== r.d) {
      store.run('UPDATE traces SET d = ? WHERE id = ?', r.d, r.id);
    }
  }
  writeActivation(store, target, agg, merged, {
    replay: counters.replay + (ev.reason === 'replay' ? 1 : 0),
    retell: counters.retell + (ev.reason === 'retell' ? 1 : 0),
    inherited: act?.inherited_json ?? '[]',
  });
  return { added: true };
}

/**
 * 新版本至少继承旧版本的激活（§5.4 第 7 条）：把旧版本的痕迹状态复制给新版本（reason='inherit'），不重复计数。
 * 新版本 B = ln(e^B_新 + e^B_旧) ≥ B_旧；继承来的痕迹保留旧的衰减率，新版本自己的痕迹按合并后的历史重算。
 * 同一对 (from, to) 重复调用不会再复制一遍（activation.inherited_json）。在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} from
 * @param {import('../core-types.js').MemoryRef} to
 * @param {{at: number}} ctx
 */
export function inheritActivation(core, from, to, ctx) {
  const src = traceTarget(core, from);
  const dst = traceTarget(core, to);
  if (!src || !dst || (src.kind === dst.kind && src.id === dst.id)) return;
  const cfg = core.config.get();
  const A = cfg.activation;
  core.store.tx(() => {
    const a = loadOne(core.store, src.kind, src.id);
    const b = loadOne(core.store, dst.kind, dst.id);
    const fromRef = refOf(src.kind, src.id);
    const inherited = safeJson(b.act?.inherited_json, []);
    if (inherited.includes(fromRef)) return;
    inherited.push(fromRef);
    const own = new Set(b.traces);
    const merged = [...b.traces, ...a.traces.map((x) => ({ id: null, t: x.t, w: x.w, d: x.d, source_key: x.source_key, reason: 'inherit' }))]
      .sort((p, q) => p.t - q.t);
    let agg = aggOf(b.act);
    const aAgg = aggOf(a.act);
    if (aAgg.n > 0) agg = mergeAgg(agg, aAgg);
    const before = new Map(merged.map((r) => [r, r.d]));
    replayDecays(merged, agg, { ...ageParams(cfg), a: A.a, c: A.c, dMax: A.dMax }, 0, (r) => !own.has(r));
    const folded = foldOldest(merged, agg, A.exactTraces);
    agg = folded.agg;
    for (const r of folded.folded) if (r.id != null) core.store.run('DELETE FROM traces WHERE id = ?', r.id);
    for (const r of merged) {
      if (r.id == null) {
        core.store.run('INSERT INTO traces(owner_kind, owner_id, t, w, d, source_key, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
          dst.kind, dst.id, r.t, r.w, r.d, r.source_key, r.reason);
      } else if (before.get(r) !== r.d) {
        core.store.run('UPDATE traces SET d = ? WHERE id = ?', r.d, r.id);
      }
    }
    writeActivation(core.store, dst, agg, merged, {
      replay: b.act?.replay_count ?? 0, retell: b.act?.retell_count ?? 0, inherited: JSON.stringify(inherited),
    });
  });
  core.log.debug('dynamics.inherit', { from: src.kind, to: dst.kind, at: ctx?.at ?? core.now() });
}

/**
 * 读一个记忆单元的痕迹状态（traces + activation）。impression 读它所属实体的；percept 按入库时的一次编码（w_enc、at）
 * 合成一条；intention、link 和还没有痕迹的单元返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @returns {TraceState|null}
 */
export function traceState(core, ref) {
  const m = mrefOf(ref);
  if (!m) return null;
  if (m.kind === 'percept') {
    const p = core.store.get('SELECT w_enc, at FROM percepts WHERE id = ?', m.id);
    if (!p || !(p.w_enc > 0)) return null;
    return { traces: [{ t: p.at, w: p.w_enc, d: core.config.get().activation.a }], agg: emptyAgg() };
  }
  const target = traceTarget(core, m);
  if (!target) return null;
  const { traces, act } = loadOne(core.store, target.kind, target.id);
  if (!traces.length && !(act?.agg_n > 0)) return null;
  return { traces: traces.map((r) => ({ t: r.t, w: r.w, d: r.d })), agg: aggOf(act) };
}

/**
 * 基础激活 B = ln Σ w_j · age_j^(−d_j)（小时，age 下限 3 分钟），聚合项用 Petrov 近似。纯函数。
 * 没有任何痕迹返回 -Infinity。
 * @param {TraceState} state
 * @param {number} at
 * @param {{ageFloorMin: number, timeUnitMs: number}} params
 * @returns {number}
 */
export function baseActivationOf(state, at, params) {
  return baseOf(state, at, params);
}

/**
 * 一个记忆单元现在的基础激活。没有痕迹行的单元（导入的、迁移来的）按它的来源时间算一次 activation.untracedWeight 的编码
 * （否则它们永远想不起来）；意图按形成那一刻她自己的一次编码；link 是 -Infinity。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef} ref
 * @param {number} at
 * @returns {number}
 */
export function baseActivation(core, ref, at) {
  const m = mrefOf(ref);
  if (!m) return -Infinity;
  return baseActivations(core, [m], at).get(refOf(m.kind, m.id)) ?? -Infinity;
}

/**
 * 原始感知的基础激活：只编码一次（w_enc、at），没有 traces 行（感知不加痕迹，又遇到时加在它派生的记忆上）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{w_enc: number, at: number}} percept
 * @param {number} at
 * @returns {number}
 */
export function perceptActivation(core, percept, at) {
  const cfg = core.config.get();
  if (!percept || !(percept.w_enc > 0) || !Number.isFinite(percept.at)) return -Infinity;
  return baseOf({ traces: [{ t: percept.at, w: percept.w_enc, d: cfg.activation.a }], agg: emptyAgg() }, at, ageParams(cfg));
}

/**
 * 【补】一批记忆单元的基础激活（activate 和夜间重算用；一次查询按种类批量读）。键是记忆引用（'a12'）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').MemoryRef[]} refs
 * @param {number} at
 * @returns {Map<string, number>}
 */
export function baseActivations(core, refs, at) {
  const cfg = core.config.get();
  const A = cfg.activation;
  const P = ageParams(cfg);
  const out = new Map();
  const byKind = new Map();
  for (const r of refs) {
    const m = mrefOf(r);
    if (!m) continue;
    if (!byKind.has(m.kind)) byKind.set(m.kind, new Set());
    byKind.get(m.kind).add(m.id);
  }
  const single = (t, w) => baseOf({ traces: [{ t, w, d: A.a }], agg: emptyAgg() }, at, P);
  // impression → 它的实体
  const impEntity = new Map();
  if (byKind.has('impression')) {
    for (const row of chunkedAll(core.store, 'SELECT id, entity_id, built_at FROM entity_impressions WHERE id IN', [...byKind.get('impression')])) {
      impEntity.set(row.id, row);
      if (!byKind.has('entity')) byKind.set('entity', new Set());
      byKind.get('entity').add(row.entity_id);
    }
  }
  const entityB = new Map();
  for (const [kind, ids] of byKind) {
    const list = [...ids];
    if (kind === 'percept') {
      for (const p of chunkedAll(core.store, 'SELECT id, w_enc, at FROM percepts WHERE id IN', list)) {
        out.set(refOf('percept', p.id), p.w_enc > 0 ? single(p.at, p.w_enc) : -Infinity);
      }
    } else if (kind === 'intention') {
      for (const it of chunkedAll(core.store, 'SELECT id, formed_at FROM intentions WHERE id IN', list)) {
        out.set(refOf('intention', it.id), single(it.formed_at, A.attention.self));
      }
    } else if (kind === 'link') {
      for (const id of list) out.set(refOf('link', id), -Infinity);
    } else if (TRACED.has(kind)) {
      const states = loadMany(core.store, kind, list);
      const untraced = [];
      for (const id of list) {
        const s = states.get(id);
        if (s && (s.traces.length || s.agg.n > 0)) {
          const B = baseOf(s, at, P);
          out.set(refOf(kind, id), B);
          if (kind === 'entity') entityB.set(id, B);
        } else {
          untraced.push(id);
        }
      }
      if (untraced.length) {
        const w = A.untracedWeight ?? A.attention.peripheral;
        for (const row of originTimes(core.store, kind, untraced)) {
          const B = row.t != null ? single(row.t, w) : -Infinity;
          out.set(refOf(kind, row.id), B);
          if (kind === 'entity') entityB.set(row.id, B);
        }
      }
    }
  }
  for (const [id, row] of impEntity) {
    const B = entityB.get(row.entity_id);
    out.set(refOf('impression', id), B ?? (row.built_at != null ? single(row.built_at, A.untracedWeight ?? A.attention.peripheral) : -Infinity));
  }
  return out;
}

/**
 * 【补】一串「又遇到了一次」→ 痕迹状态（不经过来源窗口，纯函数；§6.7 的数值演示、评测回放用）。
 * @param {{t: number, w: number}[]} events
 * @param {{a: number, c: number, dMax: number, ageFloorMin: number, timeUnitMs: number, exactTraces?: number}} params
 * @returns {TraceState}
 */
export function stateFromEvents(events, params) {
  return fromEvents(events, params);
}

// ── 回想时的激活（§6.5、§6.6） ──────────────────────────────────────────────

/**
 * 给候选打激活分（§6.5）：A = B + S + C + I − P_sup + ε，P = σ((A − τ)/s)。
 * ε 是 logistic 噪声，种子 = seededNoise([seed..., ref])，同一会话同一回合同一记忆结果相同（可复现）。
 * P 用不含 ε 的均值算（ACT-R 的回想概率本来就是对 logistic 噪声积分的结果；ε 已经体现在 A 里、由 sample 按阈值抽样，
 * 再进 P 就成了两次随机），渲染措辞看 P，抽样看 A。
 * @param {import('../core-types.js').CoreContext} core
 * @param {ActivationInput[]} inputs
 * @param {{at: number, mode: 'involuntary'|'deliberate', seed: string[]}} ctx
 * @returns {import('../core-types.js').ScoredCandidate[]}
 */
export function activate(core, inputs, ctx) {
  const A = core.config.get().activation;
  const at = ctx?.at ?? core.now();
  const tau = ctx?.mode === 'deliberate' ? A.tauDeliberate : A.tauInvoluntary;
  const seed = (ctx?.seed ?? []).map(String);
  const list = Array.isArray(inputs) ? inputs : [];
  const mrefs = list.map((inp) => mrefOf(inp?.candidate?.mref ?? inp?.candidate?.ref));
  const Bs = baseActivations(core, mrefs.filter(Boolean), at);
  const needRows = [...new Set(mrefs.filter((m, i) => m?.kind === 'intention' && !list[i].intention).map((m) => m.id))];
  const rows = new Map(chunkedAll(core.store, 'SELECT * FROM intentions WHERE id IN', needRows).map((r) => [r.id, r]));
  return list.map((inp, i) => {
    const c = inp?.candidate ?? {};
    const m = mrefs[i];
    const key = m ? refOf(m.kind, m.id) : String(c.ref ?? '');
    const B = m ? (Bs.get(key) ?? -Infinity) : -Infinity;
    const S = finite(inp?.S);
    const C = finite(inp?.C);
    const row = inp?.intention ?? (m?.kind === 'intention' ? rows.get(m.id) : null);
    const I = row ? intentionBias(core, row, { at, cueHit: !!inp?.cueHit }) : 0;
    const Psup = inp?.superseded ? A.supersededPenalty : 0;
    const eps = A.noise ? noiseOf([...seed, key], A.s) : 0;
    const mean = B + S + C + I - Psup;
    return { ...c, ref: c.ref ?? key, mref: c.mref ?? m, A: mean + eps, P: pRecallOf(mean, tau, A.s), parts: { B, S, C, I, Psup, eps } };
  });
}

/**
 * 不自主回想按 P 抽样（不是固定取前 k，§6.6）；有意回想取 A ≥ τ_del 的全部。抽样只决定「想不想得起」，和安全无关。
 * A 里已经带着种子噪声 ε（activate），所以「A ≥ τ」就是一次概率为 P 的伯努利抽样，而且同一会话同一回合可复现；
 * 没经过 activate 的候选（没有 parts）在这里按同样的种子补一次噪声。结果按 A 降序。
 * @param {import('../core-types.js').CoreContext} core
 * @param {import('../core-types.js').ScoredCandidate[]} scored
 * @param {{mode: 'involuntary'|'deliberate', seed: string[]}} ctx
 * @returns {import('../core-types.js').ScoredCandidate[]}
 */
export function sample(core, scored, ctx) {
  const A = core.config.get().activation;
  const tau = ctx?.mode === 'deliberate' ? A.tauDeliberate : A.tauInvoluntary;
  const seed = (ctx?.seed ?? []).map(String);
  const out = [];
  for (const c of scored ?? []) {
    if (!c || typeof c.A !== 'number' || Number.isNaN(c.A)) continue;
    const a = c.parts ? c.A : c.A + (A.noise ? noiseOf([...seed, String(c.ref)], A.s) : 0);
    if (a >= tau) out.push(c);
  }
  return out.sort((x, y) => y.A - x.A);
}

/**
 * σ((A − τ)/s)。纯函数。
 * @param {number} A
 * @param {number} tau
 * @param {number} s
 * @returns {number}
 */
export function pRecall(A, tau, s) {
  return pRecallOf(A, tau, s);
}

/**
 * 可复现的 logistic 噪声：用 parts 的哈希做种子。纯函数。
 * @param {string[]} parts
 * @param {number} s
 * @returns {number}
 */
export function seededNoise(parts, s) {
  return noiseOf((parts ?? []).map(String), s);
}

/**
 * 【补】扇出项（§6.5）：线索直接认出某个实体时，关于它的每条记忆加 S_max − ln(fan)（不小于 0）。给 retrieve 拼 S 用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} fan   这个实体名下的记忆条数
 * @returns {number}
 */
export function fanTerm(core, fan) {
  const sMax = core.config.get().activation.fanSMax;
  return Math.max(0, sMax - Math.log(Math.max(1, Number(fan) || 1)));
}

// ── 有效性（§5.4） ────────────────────────────────────────────────────────

/**
 * 现在还成立的概率（§5.4）。没有 t50 的（稳定类）按 1；超过 valid_to_known 为 0；change_known 乘 validity.changeKnownFactor。
 * 还没开始的（at 早于 valid_from）也按 1：还没开始衰减，将来时由渲染看 valid_from。和可及性互不影响（§6.1）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{valid_from: number|null, valid_to_known: number|null, t50_h: number|null, shape: number|null, change_known: number, recorded_at: number}} a
 * @param {number} at
 * @returns {number}
 */
export function pHold(core, a, at) {
  if (!a) return 1;
  return pHoldOf(a, at, core.config.get().validity.changeKnownFactor);
}

/**
 * 时态（§5.4 渲染）：> presentAbove 现在时；< pastBelow 过去时；中间带不确定。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} p
 * @returns {'present'|'uncertain'|'past'}
 */
export function tense(core, p) {
  const v = core.config.get().validity;
  if (p > v.presentAbove) return 'present';
  if (p < v.pastBelow) return 'past';
  return 'uncertain';
}

/**
 * 意图项 I（§5.5、§6.5）：armed 的 +boost（线索命中再 +cueBoost）；obsolete / cancelled 后 suppression × e^(−Δt/τ)。
 * formed 的意图「到了时间窗」就是 armed（§5.5 state：formed → armed（到了时间窗）），状态还没来得及改也照样加成；
 * 还没到时间窗的 formed、executed、lapsed 为 0：做过了就撤掉加成，冷却由 encode.dueIntentions 按人执行。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object} intention   intentions 行
 * @param {{at: number, cueHit: boolean}} ctx
 * @returns {number}
 */
export function intentionBias(core, intention, ctx) {
  const c = core.config.get().intention;
  const it = /** @type {any} */ (intention);
  if (!it) return 0;
  const at = ctx?.at ?? core.now();
  const windowStart = it.window_start ?? it.windowStart;
  const windowOpen = it.state === 'formed' && Number.isFinite(windowStart) && windowStart <= at
    && !(Number.isFinite(it.window_end ?? it.windowEnd) && (it.window_end ?? it.windowEnd) < at);
  if (it.state === 'armed' || windowOpen) return c.boost + (ctx?.cueHit ? c.cueBoost : 0);
  if (it.state === 'obsolete' || it.state === 'cancelled') {
    const since = it.suppressed_at ?? it.suppressedAt ?? it.updated_at ?? it.updatedAt;
    if (since == null) return c.suppression;
    const dtH = Math.max(0, at - since) / HOUR_MS;
    return c.suppression * Math.exp(-dtH / c.suppressionTauH);
  }
  return 0;
}

// ── 分层（§6.8） ──────────────────────────────────────────────────────────

/**
 * 夜间按基础激活重算 b_cache 和 tier（热 / 温 / 冷，§6.8）。分批，可中断：游标在 meta 'dynamics.retier.cursor'，
 * 一轮做完（done=true）游标清掉，下一次从头开始。分层只决定索引放在哪，任何一层都不因为衰减而删除。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at: number, limit?: number}} opt
 * @returns {{updated: number, done: boolean}}
 */
export function retier(core, opt) {
  const cfg = core.config.get();
  const at = opt?.at ?? core.now();
  const limit = Math.max(1, Math.floor(opt?.limit ?? cfg.activation.retierBatch));
  const tiers = cfg.activation.tiers;
  const cur = getMetaJson(core.store, 'dynamics.retier.cursor', null);
  const rows = cur
    ? core.store.all(`SELECT owner_kind, owner_id FROM activation WHERE (owner_kind, owner_id) > (?, ?)
                      ORDER BY owner_kind, owner_id LIMIT ?`, cur.kind, cur.id, limit)
    : core.store.all('SELECT owner_kind, owner_id FROM activation ORDER BY owner_kind, owner_id LIMIT ?', limit);
  const P = ageParams(cfg);
  return core.store.tx(() => {
    const byKind = new Map();
    for (const r of rows) {
      if (!byKind.has(r.owner_kind)) byKind.set(r.owner_kind, []);
      byKind.get(r.owner_kind).push(r.owner_id);
    }
    let updated = 0;
    for (const [kind, ids] of byKind) {
      const states = loadMany(core.store, kind, ids);
      for (const id of ids) {
        const s = states.get(id);
        const B = s ? baseOf(s, at, P) : -Infinity;
        const tier = B >= tiers.hotMinB ? 'hot' : B >= tiers.warmMinB ? 'warm' : 'cold';
        core.store.run('UPDATE activation SET b_cache = ?, b_at = ?, tier = ? WHERE owner_kind = ? AND owner_id = ?',
          Number.isFinite(B) ? B : null, at, tier, kind, id);
        updated += 1;
      }
    }
    const done = rows.length < limit;
    if (done) setMeta(core.store, 'dynamics.retier.cursor', null);
    else { const last = rows.at(-1); setMetaJson(core.store, 'dynamics.retier.cursor', { kind: last.owner_kind, id: last.owner_id }); }
    return { updated, done };
  });
}

// ── 心境（§5.7） ──────────────────────────────────────────────────────────

/**
 * 当前心境（按 mood.halfLifeH 衰减后的）；没有就返回 null。原因是记忆引用，渲染前照常过关口①。
 * 每次情绪反应是一次冲量 (v, i)，到现在的权重 i·2^(−Δt/半衰期)：效价 = Σ v·权重 / Σ 权重，强度 = min(1, Σ 权重)。
 * 强度低于 mood.floor 时算「没什么特别的心情」，返回 null。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number} at
 * @returns {{valence: number, intensity: number, causes: string[]}|null}
 */
export function currentMood(core, at) {
  const m = core.config.get().mood;
  const half = m.halfLifeH * HOUR_MS;
  if (!(half > 0)) return null;
  const horizon = half * m.horizonHalfLives;
  const rows = core.store.all('SELECT at, valence, intensity, cause_ids_json FROM mood WHERE at <= ? AND at > ? ORDER BY at', at, at - horizon);
  let mass = 0;
  let net = 0;
  const contrib = new Map();
  for (const r of rows) {
    const wt = r.intensity * Math.pow(2, -(at - r.at) / half);
    if (!(wt > 0)) continue;
    mass += wt;
    net += r.valence * wt;
    for (const ref of safeJson(r.cause_ids_json, [])) if (typeof ref === 'string') contrib.set(ref, (contrib.get(ref) ?? 0) + wt);
  }
  if (!(mass >= m.floor)) return null;
  const causes = [...contrib.entries()].sort((a, b) => b[1] - a[1]).slice(0, m.maxCauses).map(([ref]) => ref);
  return { valence: clamp(net / mass, -1, 1), intensity: Math.min(1, mass), causes };
}

/**
 * 她对一段经历的情绪反应推动心境（提炼的 emotion 行）。在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at: number, valence: number, intensity: number, causeRefs: string[]}} m
 */
export function pushMood(core, m) {
  const at = Number(m?.at);
  const v = Number(m?.valence);
  const i = Number(m?.intensity);
  if (!Number.isFinite(at) || !Number.isFinite(v) || !Number.isFinite(i) || i <= 0) return;
  const causes = [...new Set((m.causeRefs ?? []).filter((r) => parseRef(r)))];
  core.store.run('INSERT INTO mood(at, valence, intensity, cause_ids_json) VALUES (?, ?, ?, ?)',
    at, clamp(v, -1, 1), clamp(i, 0, 1), JSON.stringify(causes));
}

// ── 内部 ──────────────────────────────────────────────────────────────────

function ageParams(cfg) {
  return { ageFloorMin: cfg.activation.ageFloorMin, timeUnitMs: cfg.activation.timeUnitMs };
}
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function safeJson(s, fallback) {
  try { const v = JSON.parse(s ?? ''); return Array.isArray(fallback) ? (Array.isArray(v) ? v : fallback) : (v ?? fallback); } catch { return fallback; }
}

/** MemoryRef 或记忆引用字符串 → {kind, id}。 */
function mrefOf(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return parseRef(ref);
  if (typeof ref === 'object' && OWNER_KINDS[ref.kind] && Number.isInteger(ref.id) && ref.id > 0) return { kind: ref.kind, id: ref.id };
  return null;
}

/** 痕迹落在哪个单元上：impression → 它的实体；没有痕迹行的种类返回 null。 */
function traceTarget(core, ref) {
  const m = mrefOf(ref);
  if (!m) return null;
  if (m.kind === 'impression') {
    const row = core.store.get('SELECT entity_id FROM entity_impressions WHERE id = ?', m.id);
    return row ? { kind: 'entity', id: row.entity_id } : null;
  }
  return TRACED.has(m.kind) ? m : null;
}

function loadOne(store, kind, id) {
  const traces = store.all('SELECT id, t, w, d, source_key, reason FROM traces WHERE owner_kind = ? AND owner_id = ? ORDER BY t, id', kind, id);
  const act = store.get('SELECT * FROM activation WHERE owner_kind = ? AND owner_id = ?', kind, id) ?? null;
  return { traces, act };
}

function loadMany(store, kind, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    for (const a of store.all(`SELECT * FROM activation WHERE owner_kind = ? AND owner_id IN (${marks})`, kind, ...part)) {
      out.set(a.owner_id, { traces: [], agg: aggOf(a) });
    }
    for (const r of store.all(`SELECT owner_id, t, w, d FROM traces WHERE owner_kind = ? AND owner_id IN (${marks}) ORDER BY owner_id, t, id`, kind, ...part)) {
      if (!out.has(r.owner_id)) out.set(r.owner_id, { traces: [], agg: emptyAgg() });
      out.get(r.owner_id).traces.push({ t: r.t, w: r.w, d: r.d });
    }
  }
  return out;
}

function chunkedAll(store, sqlPrefix, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(...store.all(`${sqlPrefix} (${part.map(() => '?').join(',')})`, ...part));
  }
  return out;
}

/** 没有痕迹的单元的来源时间（导入、迁移来的记忆）。 */
function originTimes(store, kind, ids) {
  const sql = {
    assertion: 'SELECT id, recorded_at AS t FROM assertions WHERE id IN',
    episode: 'SELECT id, t_end AS t FROM episodes WHERE id IN',
    window: 'SELECT id, t_end AS t FROM raw_windows WHERE id IN',
    entity: 'SELECT id, COALESCE(first_mention_at, created_at) AS t FROM entities WHERE id IN',
    storyline: 'SELECT id, updated_at AS t FROM storylines WHERE id IN',
    community: 'SELECT id, built_at AS t FROM communities WHERE id IN',
  }[kind];
  return sql ? chunkedAll(store, sql, ids) : [];
}

function aggOf(act) {
  if (!act || !(act.agg_n > 0)) return emptyAgg();
  const bins = safeJson(act.agg_bins_json, []).filter((b) => b && b.n > 0 && b.w > 0);
  return { n: act.agg_n, w: act.agg_w, first: act.agg_first, last: act.agg_last, d: act.agg_d, bins };
}
function earliestOf(traces, agg) {
  const ts = traces.map((r) => r.t);
  if (agg.n > 0 && agg.first != null) ts.push(agg.first);
  return ts.length ? Math.min(...ts) : null;
}

function writeActivation(store, target, agg, exact, c) {
  const lastExact = exact.length ? Math.max(...exact.map((r) => r.t)) : null;
  const last = [lastExact, agg.last].filter((x) => x != null);
  store.run(`INSERT INTO activation(owner_kind, owner_id, agg_n, agg_w, agg_first, agg_last, agg_d, agg_bins_json, trace_count, last_trace_at,
               replay_count, retell_count, inherited_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_kind, owner_id) DO UPDATE SET agg_n = excluded.agg_n, agg_w = excluded.agg_w,
               agg_first = excluded.agg_first, agg_last = excluded.agg_last, agg_d = excluded.agg_d, agg_bins_json = excluded.agg_bins_json,
               trace_count = excluded.trace_count, last_trace_at = excluded.last_trace_at,
               replay_count = excluded.replay_count, retell_count = excluded.retell_count, inherited_json = excluded.inherited_json`,
  target.kind, target.id, agg.n, agg.w, agg.first, agg.last, agg.d, JSON.stringify(agg.bins ?? []), agg.n + exact.length,
  last.length ? Math.max(...last) : null, c.replay, c.retell, c.inherited);
}
