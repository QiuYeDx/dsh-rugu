// 每个会话在内存里的小状态（不落库：库里的账本由核心的 sessions.* 管，§3.5 第 2 条）。
//   frozen     这个会话冻结的常驻区文本（§10.4：provider 只返回它；只在真实新消息到来时和压缩结束后换）
//   swapOnNext 压缩结束了，下一次 provider 取新文本
//   trigger    这一轮由哪条消息直接触发（memory_note / memory_fix 的授权依据，§10.8 第 1 条）；定时、转达、超时唤醒为 null；
//              唤醒消息里只有旧的上下文、没有新消息的（主动冒泡、回复检查……）也是 null（D115），她之后用读消息工具读到新消息时才有
//   selfTurn   这一轮是她自己开启的（真实的唤醒消息，但没有新来的、能触发这一轮的消息，D115）：回想按 idle，没有「眼前这个人」
//   seen       这一轮她看到的、别人对她说的消息（唤醒消息和读消息工具的结果里的，新的在前，D114）：记忆工具交给核心挑哪一条是触发消息
//   turnAt     这一轮从什么时候开始（真实新消息到来的那个 pre-step）：读消息工具读到的多旧的还算「这一轮新看到的」从这里往前算
//   opsUsed    这一轮的触发消息已经做过记忆操作（一条消息只执行一个操作，§10.8 第 3 条）
//   pending    已插入、还没在会话事件里看到的 nonce
//   suspended  绑定报了一致性告警（C1）：这个会话停掉感知和注入，直到插件重载后重新认领
//   compactions 看到了 compaction/start、还没看到 compaction/end 的压缩（compactionId；只有成功的 end 才开新周期，§10.5）

/** agent / session 的 id（DSH 里 agent id 就是会话 id）。 */
export const agentId = (agent) => String(agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id ?? '');

export function createSessionStates({ max = 2000 } = {}) {
  const map = new Map();
  const fresh = () => ({ frozen: null, swapOnNext: false, trigger: null, selfTurn: false, seen: [], turnAt: null, opsUsed: new Set(), pending: new Set(), suspended: null, compactions: new Set(), lastSeenAt: 0 });
  return {
    get(sid) {
      let s = map.get(sid);
      if (!s) {
        s = fresh();
        map.set(sid, s);
        if (map.size > max) map.delete(map.keys().next().value);
      }
      return s;
    },
    peek: (sid) => map.get(sid) ?? null,
    delete: (sid) => map.delete(sid),
    clear: () => map.clear(),
    get size() { return map.size; },
  };
}
