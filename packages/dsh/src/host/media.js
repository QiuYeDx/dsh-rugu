// 她看过的媒体（D116，主人：「按简单的做」）——宿主这一半：认出「她用工具看了一条消息里的媒体」，等她看完之后的想法和回话，
// 交给核心（pm.media.noteViewed）写进那条消息的媒体说明。主人的原话：「画面大意不是AI模型读图之后才知道的吗？工具只是帮忙把视频
// 处理成图片返回给AI看而已。在AI看完理解完之后 本身不就知道了画面内容了吗」——所以不另调视觉模型，不改主人的插件。
//   1. 认出来（通用）：认领的会话里，任何工具的结果带着图片（DSH 工具结果的内容块 type 'image'），或者是配置里声明的看媒体工具
//      （host.media.viewTools，默认空：主人私有插件的工具名写在他自己的配置里，不进公开代码）。记忆工具不算。
//   2. 认是哪一条：先问适配器（绑定的可选钩子 resolveViewedMedia({tool, args, resultText, declared, turn}) → ObsId | null；
//      返回 null = 认不出、不写；没有这个钩子、返回 undefined = 用宿主的兜底）。结果带图片只说明她看了一张图，不说明看的是谁分享的：
//      参数里点明了消息（适配器认得的消息 id）才算那一条；没点明的只有声明过的看媒体工具才认，而且这个场合这一轮（或这一轮开始前
//      tools.seenFreshMs 内）她看到的、带能「看」的媒体的别人的消息恰好一条（uniqueViewed）；分不清、对不上就什么都不做（不猜，不跨场合）。
//      同一步里认出了两条不同的（并排调了两次）→ 分不清她的想法说的是哪一条，两条都不写。
//   3. 等她看完：之后的 assistant/message 里她的想法（reasoning）、说的话（text）和说话类工具的话（按工具表 resolve 出来的 Utterance）
//      记下来；出现了她的回话、或者过了 host.media.maxSteps 步、或者这一轮结束 → 交给核心一次（不等结果，不在热路径上）。
// 只在内存里，不落库；只记 ObsId、这一轮她自己写的字和工具结果里的文字（只拿来比对，不存），交出去就清掉。
// 同一条再看一次：照样交（核心那边更晚的一次替换更早的）。
import { SPEAKING_CLASSES, uniqueViewed } from '../binding/index.js';
import { bareName, MEMORY_TOOLS } from './tooltable.js';
import { errCode } from './util.js';

const MAX_RING = 24;
const TEXT_CAP = 6000;

/** 工具结果的内容块里有没有图片（DSH：{type:'image', attachment|data|…}）。 */
export function hasImageContent(content) {
  const parts = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : [];
  return parts.some((b) => b && typeof b === 'object' && (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image'));
}
/** 工具结果里的文字（给适配器认是哪一条；最多 2000 字）。 */
export function textOfContent(content) {
  const parts = Array.isArray(content) ? content : content == null ? [] : [content];
  return parts.map((b) => (typeof b === 'string' ? b : b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n').slice(0, 2000);
}
/** 配置里声明的看媒体工具：精确名，或「MCP 前缀 + __ + 名字」。 */
export function isDeclaredViewer(name, list) {
  const n = String(name ?? '');
  if (!n || !Array.isArray(list)) return false;
  const bare = bareName(n);
  return list.some((t) => typeof t === 'string' && t && (n === t || bare === t));
}

/**
 * 兜底的「看的是哪一条」（只对声明过的看媒体工具）：这一轮（不早于 floor）看到的、带能「看」的媒体的别人的消息里，
 * 在这个场合恰好一条才算（uniqueViewed）；分不清 → null。
 * @param {{obsId: string, settingId: string, at: number, seenAt: number, kinds: string[]}[]} ring
 * @param {{settingId: string, floor: number}} o
 */
export function pickViewed(ring, { settingId, floor }) {
  return uniqueViewed((ring ?? []).filter((x) => x && x.seenAt >= floor), settingId);
}

const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  if (typeof a !== 'string' || !a) return {};
  try { const v = JSON.parse(a); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/**
 * @param {{getPm: () => any, states: ReturnType<typeof import('./session-state.js').createSessionStates>, hostConfig: () => object,
 *          tooltable?: {lookup: Function}|null, log: object, now?: () => number}} deps
 */
export function createMediaSeen({ getPm, states, hostConfig, tooltable = null, log, now = () => Date.now() }) {
  const cfg = () => hostConfig().media ?? {};
  const stats = { detected: 0, resolved: 0, unresolved: 0, adapterNull: 0, ambiguous: 0, fired: 0, dropped: 0, results: {} };
  const enabled = () => cfg().enabled !== false && hostConfig().features?.observe !== false;

  /** 她看到的、带媒体的别人的消息（observeNow 交上去的感知）记进这个会话的小环。 */
  function noteObserved(claim, obs) {
    if (!claim?.sessionId || !Array.isArray(obs) || !obs.length) return;
    const st = states.get(claim.sessionId);
    const ring = st.mediaRing ?? (st.mediaRing = []);
    const t = now();
    for (const o of obs) {
      if (!o || typeof o.id !== 'string' || o.actor?.self === true || !Array.isArray(o.media) || !o.media.length) continue;
      const kinds = o.media.map((m) => (typeof m?.kind === 'string' ? m.kind : 'media')).slice(0, 8);
      const i = ring.findIndex((x) => x.obsId === o.id);
      if (i >= 0) ring.splice(i, 1);
      ring.push({ obsId: o.id, settingId: String(o.settingId ?? claim.settingId), at: Number.isFinite(o.at) ? o.at : t, seenAt: t, kinds });
    }
    while (ring.length > MAX_RING) ring.shift();
  }

  /** 这一轮的「看到的带媒体的消息」（给适配器的钩子，副本）。 */
  const turnOf = (claim, st) => {
    const freshMs = Number(hostConfig().tools?.seenFreshMs ?? 10 * 60_000);
    const floor = (Number.isFinite(st.turnAt) ? st.turnAt : now()) - freshMs;
    return {
      sessionId: claim.sessionId, homeSettingId: claim.settingId, startedAt: Number.isFinite(st.turnAt) ? st.turnAt : null, floor,
      media: (st.mediaRing ?? []).filter((x) => x.seenAt >= floor).map((x) => ({ ...x, kinds: [...x.kinds] })),
    };
  };

  function resolve(claim, exec, content, st, declared) {
    const turn = turnOf(claim, st);
    const fn = claim.binding?.resolveViewedMedia;
    if (typeof fn === 'function') {
      let r;
      try { r = fn.call(claim.binding, { tool: String(exec?.name ?? ''), args: parseArgs(exec?.arguments), resultText: textOfContent(content), declared, turn }); } catch { r = undefined; }
      if (typeof r === 'string' && r) return r;
      if (r === null) { stats.adapterNull += 1; return null; }
    }
    // 兜底只对声明过的看媒体工具：结果带图片的别的工具（截图、读图片文件、搜图）不往别人分享的东西里写
    if (!declared) return null;
    return pickViewed(turn.media, { settingId: claim.settingId, floor: turn.floor });
  }

  /**
   * egress 的 post-execute 交来的工具结果（认领的会话、调用成功、不是记忆工具）。
   * @returns {boolean} 认成了「她在看媒体」并记下了是哪一条
   */
  function onToolResult(claim, exec, content) {
    if (!enabled() || !claim?.sessionId || MEMORY_TOOLS.includes(exec?.name)) return false;
    const declared = isDeclaredViewer(exec?.name, cfg().viewTools);
    if (!declared && !hasImageContent(content)) return false;
    stats.detected += 1;
    const st = states.get(claim.sessionId);
    let obsId = null;
    try { obsId = resolve(claim, exec, content, st, declared); } catch { obsId = null; }
    if (!obsId) { stats.unresolved += 1; return false; }
    stats.resolved += 1;
    const cur = st.mediaView;
    if (cur && cur.obsId !== obsId) {
      // 同一步里又认出了另一条（并排的两次调用）：她接下来的想法说的是哪一条分不清 → 两条都不写
      if (cur.steps === 0) { cur.ambiguous = true; stats.ambiguous += 1; return false; }
      flush(claim.sessionId, 'next');
    }
    const kind = (st.mediaRing ?? []).find((x) => x.obsId === obsId)?.kinds?.[0] ?? undefined;
    const material = textOfContent(content);
    if (!st.mediaView) st.mediaView = { obsId, adapterId: claim.adapterId, kind, at: now(), thoughts: [], reply: [], steps: 0, claim, material };
    else if (material && !st.mediaView.material.includes(material)) st.mediaView.material = `${st.mediaView.material}
${material}`.slice(0, 4000);
    return true;
  }

  /** 一条说话类工具调用里她说的话（按工具表 resolve 出来的 Utterance 的文字）。 */
  function speechOf(claim, part) {
    if (!tooltable || typeof part?.name !== 'string') return [];
    let hit = null;
    try { hit = tooltable.lookup(part.name, claim); } catch { hit = null; }
    if (!hit?.decl || !SPEAKING_CLASSES.includes(hit.decl.class)) return [];
    const args = parseArgs(part.arguments ?? part.input ?? part.args);
    const ex = { sessionId: claim.sessionId, callId: String(part.id ?? ''), homeSettingId: claim.settingId };
    let list = [];
    try {
      if (typeof hit.decl.resolveAll === 'function') list = hit.decl.resolveAll(args, ex) ?? [];
      else { const one = hit.decl.resolve?.(args, ex); list = one ? [one] : []; }
    } catch { list = []; }
    return list.flatMap((u) => (Array.isArray(u?.text) ? u.text : [])).filter((x) => typeof x === 'string' && x.trim());
  }

  /** 会话事件里的 assistant/message：她看完之后的想法和回话。 */
  function onAssistant(sid, data) {
    const st = states.peek(sid);
    const v = st?.mediaView;
    if (!v) return;
    const msg = data?.message && typeof data.message === 'object' ? data.message : data;
    const parts = Array.isArray(msg?.content) ? msg.content : typeof msg?.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    let replied = false;
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) v.thoughts.push(p.text.trim());
      else if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) { v.reply.push(p.text.trim()); replied = true; }
      else if (p.type === 'tool-call') {
        const said = speechOf(v.claim, p);
        if (said.length) { v.reply.push(...said); replied = true; }
      }
    }
    v.steps += 1;
    const maxSteps = Math.max(1, Math.floor(cfg().maxSteps ?? 2));
    if (replied || v.steps >= maxSteps) flush(sid, replied ? 'reply' : 'steps');
  }

  /** 交给核心（不等结果）。没有她自己写的字就丢掉。 */
  function flush(sid, why = 'end') {
    const st = states.peek(sid);
    const v = st?.mediaView;
    if (!v) return;
    st.mediaView = null;
    const thoughts = v.thoughts.join('\n').slice(0, TEXT_CAP);
    const reply = v.reply.join('\n').slice(0, TEXT_CAP);
    const pm = getPm();
    if (v.ambiguous || (!thoughts.trim() && !reply.trim()) || typeof pm?.media?.noteViewed !== 'function') { stats.dropped += 1; return; }
    stats.fired += 1;
    let p;
    // sessionId：核心按这一轮的按轮污点给这一项打标（§9.6）；material：工具结果里的文字，核心拿来挡「照抄工具给的字」
    try { p = pm.media.noteViewed({ adapter: v.adapterId, obsId: v.obsId, sessionId: sid, thoughts, reply, material: v.material || undefined, ...(v.kind ? { kind: v.kind } : {}), at: v.at }); } catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then((r) => {
      const k = String(r?.reason ?? 'error').slice(0, 24);
      stats.results[k] = (stats.results[k] ?? 0) + 1;
    }, (e) => {
      stats.results.error = (stats.results.error ?? 0) + 1;
      log.warn('media.seen.failed', { error: errCode(e), why });
    });
  }

  return {
    noteObserved, onToolResult, onAssistant, flush,
    /** 这一轮结束：还在等的交出去（她看完就没再说话，也照样记下她想到的）。 */
    onTurnEnd: (sid) => flush(sid, 'turn-end'),
    /** 排查、测试用：这个会话在等哪一条（不含正文）。 */
    pending: (sid) => { const v = states.peek(sid)?.mediaView; return v ? { obsId: v.obsId, steps: v.steps, kind: v.kind ?? null } : null; },
    status: () => ({ ...stats, results: { ...stats.results } }),
  };
}
