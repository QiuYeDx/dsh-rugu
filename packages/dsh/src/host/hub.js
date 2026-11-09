// 会话事件的分发（给网页适配器的 deps.sessions，§11.3）：
//   onSession(cb)  会话出现时（agent/created、插件启动时已经活着的会话）：cb(SessionInfo)
//   onMessage(cb)  每个会话事件：cb({sessionId, claim: {settingId, adapterId}|null, type, data, seq, session})
//   rebind(sid, settingId)  适配器说这个会话改记到别的场合了（远程访客出现）：宿主改认领、重新绑定、常驻区下次重新渲染
//   list()         现在活着的会话的 SessionInfo
// 订阅者出错不影响别人，也不影响钩子。只在进程内传，不落盘。
import { sessionInfoOf } from './claim.js';

/**
 * @param {{listAgents?: () => object[], onRebind?: (sessionId: string, settingId: string, adapterId?: string) => void,
 *          infoOf?: typeof sessionInfoOf}} [opt]   infoOf：读会话现在的 preset（D112），默认只看会话头
 */
export function createSessionHub({ listAgents = () => [], onRebind = () => {}, infoOf = sessionInfoOf } = {}) {
  const msgSubs = new Set();
  const sessSubs = new Set();
  const call = (subs, arg) => { for (const fn of subs) { try { fn(arg); } catch { /* 订阅者出错不影响别人 */ } } };
  /** 给某个适配器的那一份（rebind 带上它的 id：只能改它自己认领的会话）。 */
  const forAdapter = (adapterId) => Object.freeze({
    onMessage(cb) { if (typeof cb !== 'function') return () => {}; msgSubs.add(cb); return () => msgSubs.delete(cb); },
    onSession(cb) { if (typeof cb !== 'function') return () => {}; sessSubs.add(cb); return () => sessSubs.delete(cb); },
    rebind(sessionId, settingId) {
      if (typeof sessionId !== 'string' || typeof settingId !== 'string') return;
      try { onRebind(sessionId, settingId, adapterId); } catch { /* 宿主这边出错不影响适配器 */ }
    },
    list() { try { return listAgents().map((a) => infoOf(a)).filter((s) => s.id); } catch { return []; } },
  });
  return {
    api: forAdapter(undefined),
    forAdapter,
    emitMessage: (m) => call(msgSubs, m),
    emitSession: (info) => call(sessSubs, info),
    size: () => ({ message: msgSubs.size, session: sessSubs.size }),
  };
}
