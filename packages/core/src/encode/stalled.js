// 提炼一直不成的段（D136，迁移 018 的 extract_stalled）。
//   一个提炼任务把自己的重试（1 / 4 / 16 分钟）用完了，这段对话就「搁置」：
//   - 切段时跳过它（segment.js），后面的对话照常切段、提炼——以前它留在缓冲最前面，攒到 segment.scanLimit 条以后，
//     这个场合的切段从头扫、扫不到后面，整个场合的提炼静默停掉；
//   - 按退避再试，不会「再试一次就永远放弃」：第 n 轮隔 base × 2^(n−1)，最长 max（extract.stalled）。
//     一时的错误（超时、连不上）隔得短；稳定被拒的（模型答了但一行能用的都没有、同一个错误连着两轮都一样）隔得长；
//   - 每一轮只试一次（任务自己不再按 1 / 4 / 16 分钟重试），试成了这一行就删掉；
//   - 不给这段编造任何东西：不写情节、不写规范（感知仍是「没评估」，分寸对没评估的内容本来就更谨慎），原话照常能被搜到、能进工作记忆。
//   看得见：计数 encode.extract.stalled.<原因>、encode.extract.stalledRetry、encode.extract.unstalled；管理页诊断（stalledSummary）。
// 输出被上限截断的段（D141）不当成功：extract 把它对半拆成两段各自重做；拆到一条消息还截断（TRUNCATED）才走到这里，算稳定被拒。
//   最近 7 天截断了几次、拆了几次也在 stalledSummary 里（计数 encode.extract.truncated / encode.extract.split）。
// 后台模型不工作（D168：端口在错误上带 kind = 'config'，或者主人关了后台模型）不算这段的失败：extract.js 直接推迟、不计轮次、不进这里，
//   等恢复时 resumeExtraction 把推迟的（和升级前就因为配置类的错搁置了的）提到现在补。
// 状态全在库里（重启不丢）：切段、重试都从这张表和 jobs 表重新算，不在内存里另存。
import { bumpMetric, utcDay } from '../store/kv.js';
import { param, DAY } from './util.js';

// 过一会儿多半就好的错误：超时、中止、宿主的退避、没有模型服务、余额用完、库被锁、网络（Node 的 E 开头错误码）、
// 宿主报的 408 / 429 / 5xx。这是错误类型的分类，和内容无关
const TRANSIENT = new Set(['TIMEOUT', 'Timeout', 'TimeoutError', 'ABORTED', 'AbortError', 'LLM_BACKOFF', 'NO_LLM', 'CLOSED',
  'QUOTA', 'ACCOUNT_QUOTA', 'STORE_LOCKED']);

/**
 * 一次失败属于哪一类。BAD_OUTPUT（模型答了，但一行能用的都没有）一定是稳定的；已知的一时错误是一时的；
 * 别的错误（供应商拒绝这段内容、宿主报的其他错）事先分不清，看它稳不稳：同一个错误连着两轮都一样，就当稳定被拒。
 * @param {string|null|undefined} code
 * @param {string|null} [prevError]  上一轮的错误类型
 * @returns {'transient'|'rejected'}
 */
export function failureKind(code, prevError = null) {
  const c = String(code ?? '');
  if (c === 'BAD_OUTPUT' || c === 'TRUNCATED') return 'rejected';   // 一条消息的输出就超了上限（D141）：再试多半还是一样
  if (TRANSIENT.has(c) || /^E[A-Z]+$/.test(c) || /^HTTP_(408|429|5\d\d)$/.test(c)) return 'transient';
  return prevError != null && prevError === c ? 'rejected' : 'transient';
}

/** 第 rounds 轮失败以后隔多久再试。 */
export function stallDelayMs(core, reason, rounds) {
  const s = param(core, 'extract.stalled');
  const base = reason === 'rejected' ? s.rejectedMs : s.transientMs;
  const max = reason === 'rejected' ? s.rejectedMaxMs : s.transientMaxMs;
  return Math.min(max, base * 2 ** Math.min(Math.max(0, rounds - 1), 30));
}

/**
 * 记一段搁置（第一次）或者又失败了一轮。dueAt 给了就按它（补记旧的失败批次时马上试一次），否则按退避。
 * @returns {{reason: 'transient'|'rejected', rounds: number, nextAt: number}|null}
 */
export function markStalled(core, { settingKey, from, to, code, at = core.now(), dueAt = null }) {
  if (!settingKey || !Number.isInteger(from) || !Number.isInteger(to)) return null;
  const err = code == null ? null : String(code).slice(0, 80);
  const old = core.store.get('SELECT id, rounds, last_error FROM extract_stalled WHERE setting_key = ? AND ep_from = ? AND ep_to = ?', settingKey, from, to);
  const reason = failureKind(err, old?.last_error ?? null);
  const rounds = old ? old.rounds + 1 : 1;
  const nextAt = Number.isFinite(dueAt) ? dueAt : at + stallDelayMs(core, reason, rounds);
  if (old) {
    core.store.run('UPDATE extract_stalled SET reason = ?, last_error = ?, rounds = ?, last_at = ?, next_at = ? WHERE id = ?', reason, err, rounds, at, nextAt, old.id);
  } else {
    core.store.run(`INSERT INTO extract_stalled(setting_key, ep_from, ep_to, reason, last_error, rounds, first_at, last_at, next_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`, settingKey, from, to, reason, err, at, at, nextAt);
  }
  bumpMetric(core.store, `encode.extract.stalled.${reason}`);
  core.log.warn('encode.extract.stalled', { from, to, reason, error: err, rounds, nextAt });
  return { reason, rounds, nextAt };
}

/** 这一段提炼成了（或者已经不用提炼了）：不再搁置。 */
export function clearStalled(core, settingKey, from, to) {
  if (!settingKey || !Number.isInteger(from) || !Number.isInteger(to)) return false;
  const n = Number(core.store.run('DELETE FROM extract_stalled WHERE setting_key = ? AND ep_from = ? AND ep_to = ?', settingKey, from, to).changes);
  if (n) {
    bumpMetric(core.store, 'encode.extract.unstalled');
    core.log.info('encode.extract.unstalled', { from, to });
  }
  return n > 0;
}

/** 复核要求提前（prioritizeExtraction）：含这些感知的搁置段马上到点。 */
export function expediteStalled(core, settingKey, perceptIds, at) {
  let n = 0;
  for (const id of perceptIds) {
    n += Number(core.store.run('UPDATE extract_stalled SET next_at = ? WHERE setting_key = ? AND ep_from <= ? AND ep_to >= ? AND next_at > ?',
      at, settingKey, id, id, at).changes);
  }
  return n;
}

/**
 * 后台模型恢复了（D168：配错的修好了、主人换了模型并试通、从「不用后台模型」切回来）：把因为它推迟的提炼马上补。
 *   - 等后台模型的推迟任务（payload.waitLlm，extract.js 的 defer）：下次运行时间提到现在；
 *   - 搁置着的段里，最后一次的错误是 errorCodes 里的（集成层给的「配置类」错误码，升级前就搁置了的那些）：下次再试提到现在。
 *     核心不认识宿主的错误码，只照集成层给的清单比对。
 * 补的时候照常受预算上限和后台队列的间隔管（任务还是一个一个跑，这里只改「什么时候可以跑」）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{errorCodes?: string[], at?: number}} [opt]
 * @returns {{jobs: number, stalled: number}}
 */
export function resumeExtraction(core, opt = {}) {
  const at = Number.isFinite(opt.at) ? opt.at : core.now();
  const codes = (Array.isArray(opt.errorCodes) ? opt.errorCodes : []).filter((c) => typeof c === 'string' && c).slice(0, 100);
  return core.store.tx(() => {
    const jobs = Number(core.store.run(`UPDATE jobs SET run_after = ?, updated_at = ? WHERE kind = 'extract' AND status = 'queued' AND run_after > ?
                                        AND json_extract(payload_json, '$.waitLlm') = 1`, at, at, at).changes);
    const stalled = codes.length ? Number(core.store.run(`UPDATE extract_stalled SET next_at = ? WHERE next_at > ? AND last_error IN (${codes.map(() => '?').join(',')})`,
      at, at, ...codes).changes) : 0;
    if (jobs || stalled) {
      bumpMetric(core.store, 'encode.extract.resumed', jobs + stalled);
      core.log.info('encode.extract.resumed', { jobs, stalled });
    }
    return { jobs, stalled };
  });
}

/** 正在等后台模型、或者恢复后排着补的提炼任务有几段（D168，管理页「正在补之前没整理的 N 段」）。 */
export function waitingForLlm(core) {
  return Number(core.store.get(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract' AND status IN ('queued','running')
                                AND json_extract(payload_json, '$.waitLlm') = 1`)?.n ?? 0);
}

/** 「最近」的截断次数看几天（D141，管理页诊断）。 */
export const RECENT_DAYS = 7;

/**
 * 管理页诊断用（只有数字）：搁置了几段、一时的 / 稳定被拒的各几段、最多失败了几轮、最早的从什么时候起、下一次什么时候试；
 * 最近 RECENT_DAYS 天（按 UTC 日）提炼的输出被上限截断了几次、为此拆了几次（D141）；正在等后台模型、恢复后排着补的有几段（waitingLlm，D168）。
 * @returns {{segments: number, transient: number, rejected: number, maxRounds: number, oldestAt: number|null, nextAt: number|null,
 *            truncated: number, splits: number, waitingLlm: number}}
 */
export function stalledSummary(core) {
  const r = core.store.get(`SELECT COUNT(*) AS n, SUM(reason = 'transient') AS t, SUM(reason = 'rejected') AS j, MAX(rounds) AS m,
                                   MIN(first_at) AS first, MIN(next_at) AS next FROM extract_stalled`);
  const since = utcDay(core.now() - (RECENT_DAYS - 1) * DAY);
  const m = core.store.all(`SELECT name, SUM(value) AS v FROM metrics WHERE day >= ? AND name IN ('encode.extract.truncated','encode.extract.split') GROUP BY name`, since);
  const count = (name) => m.find((x) => x.name === name)?.v ?? 0;
  return { segments: r?.n ?? 0, transient: r?.t ?? 0, rejected: r?.j ?? 0, maxRounds: r?.m ?? 0, oldestAt: r?.first ?? null, nextAt: r?.next ?? null,
    truncated: count('encode.extract.truncated'), splits: count('encode.extract.split'), waitingLlm: waitingForLlm(core) };
}
