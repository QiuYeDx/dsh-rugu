// 原文保留期（§12.6、§17 Q3）：情节、事实永久保留；原文（感知原话、原文窗口）默认 2 年，可选 1 年 / 2 年 / 5 年 / 永久。
//   - 延长（含改成永久）立即生效。
//   - 缩短：先算影响（会删多少条原文、时间范围、占多少空间）→ 主人手动输入确认语 → 7 天冷静期（期间什么都不删，可以取消，
//     待审提示显示倒计时）→ 到期先做一次完整备份 → 按新期限分批删除（可中断、可重跑）。
//   - 只能经管理接口改；聊天和工具都改不了（§9.6）——这里没有任何从感知或工具到这些函数的路径。
//   - 状态在 meta：'retention.policy'（当前生效的）、'retention.pending'（冷静期中的改动）、'retention.doneBefore'（例行到期删除做到了哪）。
import { ContractError } from '../contract/errors.js';
import { RETENTION_MS } from '../config/defaults.js';
import { getMeta, setMeta, getMetaJson, setMetaJson, bumpMetric } from '../store/kv.js';
import { param } from './params.js';

const DAY = 86_400_000;
const OPTIONS = Object.keys(RETENTION_MS);
const bad = (what, path, message) => new ContractError(what, [{ path, message }]);

export function currentPolicy(core) {
  const v = getMeta(core.store, 'retention.policy');
  if (v && OPTIONS.includes(v)) return v;
  const d = core.config.get().retention?.raw;
  return OPTIONS.includes(d) ? d : '2y';
}

/** @returns {{current: string, pending: {to: string, effectiveAt: number, impact: object, daysLeft: number}|null}} */
export function retentionState(core) {
  const p = getMetaJson(core.store, 'retention.pending', null);
  return {
    current: currentPolicy(core),
    pending: p ? { to: p.to, effectiveAt: p.effectiveAt, impact: p.impact, daysLeft: Math.max(0, Math.ceil((p.effectiveAt - core.now()) / DAY)) } : null,
  };
}

function tz(core, at) {
  const v = core.config.get().time?.tzOffsetMin;
  return typeof v === 'number' ? v : -new Date(at).getTimezoneOffset();
}
/** 'YYYY-MM'（本地时间）。 */
function localMonth(core, at) {
  const d = new Date(at + tz(core, at) * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 缩短到 to 的影响（到 effectiveAt 那天会删掉的原文）。 */
export function retentionImpact(core, to, effectiveAt) {
  const cutoff = effectiveAt - RETENTION_MS[to];
  const p = core.store.get("SELECT count(*) AS n, min(at) AS a, max(at) AS b, coalesce(sum(length(CAST(text AS BLOB))), 0) AS bytes FROM percepts WHERE at < ? AND text IS NOT NULL", cutoff);
  // 窗口只要有一条成员过期，整个窗口的原文就清掉（和 intake.expireRawText 一样按 t_start 算）
  const w = core.store.get('SELECT count(*) AS n, coalesce(sum(length(CAST(text AS BLOB))), 0) AS bytes FROM raw_windows WHERE t_start < ? AND text IS NOT NULL', cutoff);
  return { percepts: Number(p.n), windows: Number(w.n), from: p.a ?? null, to: cutoff, lastAt: p.b ?? null, bytes: Number(p.bytes) + Number(w.bytes),
    note: 'memories-kept' };
}

/** 缩短的确认语（例：「确认删除 2025-11 之前的原文」）。 */
export const retentionConfirmPhrase = (core, cutoff) => `确认删除 ${localMonth(core, cutoff)} 之前的原文`;

/**
 * 改保留期。
 * @returns {{status: 'applied'|'cooling-off'|'need-confirm', confirmPhrase?: string, impact?: object, effectiveAt?: number}}
 */
export function requestRetentionChange(core, req) {
  if (!OPTIONS.includes(req?.to)) throw bad('retention.request', 'to', `应为 ${OPTIONS.join(' / ')}`);
  const at = Number.isFinite(req.at) ? req.at : core.now();
  const cur = currentPolicy(core);
  const by = String(req.by ?? 'owner').slice(0, 40);
  if (RETENTION_MS[req.to] >= RETENTION_MS[cur]) {
    // 延长（或者改回现在的）：立即生效，冷静期中的缩短作废
    core.store.tx((db) => {
      setMeta(db, 'retention.policy', req.to);
      setMeta(db, 'retention.pending', null);
    });
    core.log.info('admin.retention', { status: 'applied', to: req.to, by: by === 'owner' ? 'owner' : 'other' });
    return { status: 'applied' };
  }
  const coolMs = param(core, 'retention.coolingOffDays') * DAY;
  const effectiveAt = at + coolMs;
  const impact = retentionImpact(core, req.to, effectiveAt);
  const phrase = retentionConfirmPhrase(core, impact.to);
  if (req.confirmPhrase !== phrase) return { status: 'need-confirm', confirmPhrase: phrase, impact };
  setMetaJson(core.store, 'retention.pending', { to: req.to, from: cur, requestedAt: at, effectiveAt, impact, by, backupDone: null });
  bumpMetric(core.store, 'retention.shorten.requested');
  core.log.info('admin.retention', { status: 'cooling-off', to: req.to });
  return { status: 'cooling-off', effectiveAt, impact, confirmPhrase: phrase };
}

export function cancelRetentionChange(core, ctx) {
  if (!getMetaJson(core.store, 'retention.pending', null)) return;
  setMeta(core.store, 'retention.pending', null);
  bumpMetric(core.store, 'retention.shorten.cancelled', 1, Number.isFinite(ctx?.at) ? ctx.at : core.now());
  core.log.info('admin.retention', { status: 'cancelled' });
}

/** 最近有没有一份验证过的本机包（例行到期删除前要求有，§12.6「到期前先备份」）。 */
function recentVerifiedPack(core, at) {
  const since = at - param(core, 'retention.requireBackupWithinH') * 3_600_000;
  // 缩短生效前那份操作前快照（这里自己记下的）也算
  if (Number(getMeta(core.store, 'retention.backupAt') ?? 0) >= since) return true;
  try {
    return !!core.store.get("SELECT 1 FROM backups WHERE location = 'local' AND deleted_at IS NULL AND verify_status = 'ok' AND created_at >= ?", since);
  } catch { return false; }
}

/**
 * 冷静期满了就生效：先做一次完整备份（backup.createPack kind='pre-op' reason='retention'），备份验证通过才换成新期限；
 * 之后（以及平时）按当前期限分批调 intake.expireRawText。每次调用只做一批（maintenance.tick 每分钟一次），返回做完没有。
 * 同一时间只跑一个（备份要一会儿，tick 不会叠着再做一份）；备份失败隔 retention.backupRetryMin 分钟再试，期间什么都不删。
 * @returns {Promise<{expired: number, done: boolean}>}
 */
export async function applyRetention(core, at) {
  const st = (core.state.admin ??= {});
  if (st.retentionRun) return { expired: 0, done: false };
  st.retentionRun = true;
  try { return await applyRetentionOnce(core, Number.isFinite(at) ? at : core.now()); } finally { st.retentionRun = false; }
}

async function applyRetentionOnce(core, now) {
  const cfg = core.config.get();
  const st = core.state.admin;
  const pending = getMetaJson(core.store, 'retention.pending', null);
  if (pending && now >= pending.effectiveAt) {
    const retryMs = param(core, 'retention.backupRetryMin') * 60_000;
    if (pending.backupFailedAt != null && now - pending.backupFailedAt < retryMs) return { expired: 0, done: false };
    let local = null;
    try {
      const packs = await core.mods.backup.createPack(core, { kind: 'pre-op', reason: 'retention' });
      local = (packs ?? []).find((p) => (p.location ?? 'local') === 'local' && p.verified !== false) ?? null;
    } catch (e) {
      core.log.error('admin.retention-backup-failed', { error: e?.code ?? e?.name ?? 'Error' });
    }
    // 再读一次：备份期间主人可能取消了
    const still = getMetaJson(core.store, 'retention.pending', null);
    if (!still || still.requestedAt !== pending.requestedAt) return { expired: 0, done: true };
    if (!local) {
      // 备份没做成（或者验证不过）：不生效、不删，过一阵再试
      setMetaJson(core.store, 'retention.pending', { ...still, backupFailedAt: now });
      bumpMetric(core.store, 'retention.backupFailed');
      core.log.error('admin.retention-backup-unverified', {});
      return { expired: 0, done: false };
    }
    core.store.tx((db) => {
      setMeta(db, 'retention.policy', pending.to);
      setMeta(db, 'retention.pending', null);
      setMeta(db, 'retention.backupAt', String(now));
    });
    bumpMetric(core.store, 'retention.shorten.effective');
    core.log.info('admin.retention', { status: 'effective', to: pending.to });
  }
  // 生效的期限以 meta 为准；配置里的 retention.raw 只是第一次的默认值。之后改配置文件不算数（缩短必须走确认语 + 冷静期）
  if (getMeta(core.store, 'retention.policy') == null) setMeta(core.store, 'retention.policy', currentPolicy(core));
  else if (cfg.retention?.raw && cfg.retention.raw !== currentPolicy(core) && !st.retentionWarned) {
    st.retentionWarned = true;
    core.log.warn('admin.retention-config-ignored', {});
  }
  // 冷静期里什么都不删（例行的也停下，§12.6 第 3 条）
  if (getMetaJson(core.store, 'retention.pending', null)) return { expired: 0, done: false };
  const policy = currentPolicy(core);
  if (RETENTION_MS[policy] === Infinity) return { expired: 0, done: true };
  const cutoff = now - RETENTION_MS[policy];
  const doneBefore = Number(getMeta(core.store, 'retention.doneBefore') ?? 0);
  if (doneBefore >= cutoff) return { expired: 0, done: true };
  // 有没有要删的：从上次做到的地方往后看一眼（不扫已经清空的旧行）
  const any = core.store.get('SELECT 1 FROM percepts WHERE at >= ? AND at < ? AND text IS NOT NULL LIMIT 1', doneBefore, cutoff)
    ?? core.store.get('SELECT 1 FROM raw_windows WHERE t_start < ? AND text IS NOT NULL LIMIT 1', cutoff);
  if (!any) { setMeta(core.store, 'retention.doneBefore', cutoff); return { expired: 0, done: true }; }
  // 例行到期删除也要先有一份新近的、验证过的备份（删掉的原文找不回来）；没有就等夜里的日包
  if (!recentVerifiedPack(core, now)) {
    if (!st.retentionWaitWarned) { st.retentionWaitWarned = true; core.log.warn('admin.retention-waiting-backup', {}); }
    return { expired: 0, done: false };
  }
  st.retentionWaitWarned = false;
  const r = core.mods.intake.expireRawText(core, { before: cutoff, limit: param(core, 'retention.batch') });
  const expired = (r?.percepts ?? 0) + (r?.windows ?? 0);
  if (r?.done) setMeta(core.store, 'retention.doneBefore', cutoff);
  if (expired) { bumpMetric(core.store, 'retention.expired', expired); core.log.info('admin.retention-expired', { n: expired, done: !!r?.done }); }
  return { expired, done: !!r?.done };
}
