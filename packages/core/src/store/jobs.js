// 后台任务队列（jobs 表）。崩溃安全（§12.8 第 3 条）：
//   - 一批任务的全部输出和「任务完成」在同一个事务里提交（completeJob）；已经完成的任务再提交一次直接跳过，重跑幂等。
//   - 用 dedupe_key 去重，同一件事只排一次。
//   - 启动时把上次没跑完的 running 放回 queued（requeueStale）。
//   - last_error 只记错误类型和 id，不记内容（§12.3）。
//   - 结束了的任务夜里按 retention.logs.jobsDays 分批清掉（expireJobs，D139）。
import { expireInBatches } from './expire.js';

export const BACKOFF_MS = Object.freeze([60_000, 240_000, 960_000]);   // 1 / 4 / 16 分钟（§10.6）
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/**
 * @typedef {object} JobRow
 * @property {number} id
 * @property {string} kind
 * @property {string|null} use
 * @property {number} priority
 * @property {string|null} dedupe_key
 * @property {string|null} scope_key
 * @property {number|null} ep_from
 * @property {number|null} ep_to
 * @property {string} payload_json
 * @property {string} status
 * @property {number} attempts
 * @property {number} run_after
 */

/**
 * 排一个任务。dedupeKey 已存在时不重复排，返回已有的那个。
 * @param {import('./db.js').Store} store
 * @param {{kind: string, use?: string, priority?: number, dedupeKey?: string, scopeKey?: string, epFrom?: number, epTo?: number,
 *          payload?: object, runAfter?: number}} job
 * @returns {{id: number, created: boolean, status: string}}
 */
export function enqueueJob(store, job) {
  const now = store.now();
  if (job.dedupeKey) {
    const old = store.get('SELECT id, status FROM jobs WHERE dedupe_key = ?', job.dedupeKey);
    if (old) return { id: old.id, created: false, status: old.status };
  }
  const r = store.run(`INSERT INTO jobs(kind, use, priority, dedupe_key, scope_key, ep_from, ep_to, payload_json, run_after, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  job.kind, job.use, job.priority ?? 0, job.dedupeKey, job.scopeKey, job.epFrom, job.epTo,
  JSON.stringify(job.payload ?? {}), job.runAfter ?? 0, now, now);
  return { id: Number(r.lastInsertRowid), created: true, status: 'queued' };
}

/**
 * 取下一个能跑的任务并标成 running。核心是单线程的，没有并发抢任务的问题。
 * @param {import('./db.js').Store} store
 * @param {{kinds?: string[]}} [opt]
 * @returns {JobRow|null}
 */
export function claimNextJob(store, { kinds } = {}) {
  const now = store.now();
  const rows = store.all(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY priority DESC, id LIMIT 50`, now);
  const job = rows.find((j) => !kinds || kinds.includes(j.kind));
  if (!job) return null;
  store.run("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", now, job.id);
  return { ...job, status: 'running', attempts: job.attempts + 1 };
}

/**
 * 在一个事务里写入任务的全部输出并标记完成。任务已经完成过就不再执行 write（返回 {skipped: true}）。
 * write 必须是同步的（store.tx 的规矩）。
 * @template T
 * @param {import('./db.js').Store} store
 * @param {number} jobId
 * @param {(db: import('./db.js').Store) => T} write
 * @param {{model?: string, tokensIn?: number, tokensCached?: number, tokensOut?: number}} [usage]
 * @returns {{skipped: boolean, result?: T}}
 */
export function completeJob(store, jobId, write, usage = {}) {
  return store.tx((db) => {
    const row = db.get('SELECT status FROM jobs WHERE id = ?', jobId);
    if (!row) throw new Error(`没有这个任务：${jobId}`);
    if (row.status === 'done') return { skipped: true };
    const result = write(db);
    db.run(`UPDATE jobs SET status = 'done', done_at = ?, updated_at = ?, model = COALESCE(?, model),
              tokens_in = tokens_in + ?, tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ?, last_error = NULL
            WHERE id = ?`,
    db.now(), db.now(), usage.model, usage.tokensIn ?? 0, usage.tokensCached ?? 0, usage.tokensOut ?? 0, jobId);
    return { skipped: false, result };
  });
}

/**
 * 任务失败：按 1 / 4 / 16 分钟退避重排，次数用完标 failed。errorCode 只放错误类型（不放内容）。
 * @param {import('./db.js').Store} store
 * @param {number} jobId
 * @param {{errorCode: string, retry?: boolean, usage?: {tokensIn?: number, tokensCached?: number, tokensOut?: number}}} info
 * @returns {'queued'|'failed'}
 */
export function failJob(store, jobId, { errorCode, retry = true, usage = {} }) {
  const row = store.get('SELECT attempts FROM jobs WHERE id = ?', jobId);
  if (!row) return 'failed';
  const now = store.now();
  const again = retry && row.attempts < MAX_ATTEMPTS;
  const runAfter = again ? now + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)] : 0;
  store.run(`UPDATE jobs SET status = ?, run_after = ?, last_error = ?, updated_at = ?,
               tokens_in = tokens_in + ?, tokens_cached = tokens_cached + ?, tokens_out = tokens_out + ? WHERE id = ?`,
  again ? 'queued' : 'failed', runAfter, String(errorCode).slice(0, 200), now,
  usage.tokensIn ?? 0, usage.tokensCached ?? 0, usage.tokensOut ?? 0, jobId);
  return again ? 'queued' : 'failed';
}

export function cancelJob(store, jobId) {
  store.run("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running')", store.now(), jobId);
}

/** 启动时：上次崩溃时还在跑的任务放回队列（结果没提交过，重跑幂等）。 */
export function requeueStale(store) {
  return Number(store.run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'", store.now()).changes);
}

/**
 * 到期清理已经结束的任务（D139，admin.expireLogs 在夜里调）。只删同时满足这些的：
 *   - 结束了：done、cancelled，或 failed（failJob 只在不再重试时标 failed；还要重试的是 queued）；排队中、在跑的不动；
 *   - 最后一次变动早于 before；种类在 kinds 里（有处理函数的种类，读它们的地方查清了；别的种类不知道谁还读，不删）；
 *   - 带感知范围的（提炼）：范围里的感知都已经归进情节。还有感知在切分缓冲里的留着——done 的那行是「拿不准的切口模型没确认」的记号
 *     （encode/segment.js 不再在同一处切），failed / cancelled 的那行的去重键挡着同一段不被重复排（补跑走另起的键）。
 *     删掉的范围以后只会因为彻底删除把感知放回缓冲才再出现，那时本来就该重新提炼。
 * @param {import('./db.js').Store} store
 * @param {{before: number, kinds: string[], batch?: number, maxBatches?: number, signal?: AbortSignal}} opt
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireJobs(store, { before, kinds, ...opt }) {
  if (!kinds?.length) return { deleted: 0, done: true };
  const ph = kinds.map(() => '?').join(',');
  return expireInBatches(store, 'jobs', (after, limit) => {
    const rows = store.all(`SELECT j.id, CASE
        WHEN j.ep_from IS NULL AND j.ep_to IS NULL THEN 0
        WHEN j.scope_key IS NULL OR j.ep_from IS NULL OR j.ep_to IS NULL THEN 1
        WHEN EXISTS (SELECT 1 FROM percepts p WHERE p.setting_key = j.scope_key AND p.id BETWEEN j.ep_from AND j.ep_to AND p.episode_id IS NULL) THEN 1
        ELSE 0 END AS keep
      FROM jobs j WHERE j.id > ? AND j.status IN ('done','cancelled','failed') AND j.updated_at < ? AND j.kind IN (${ph})
      ORDER BY j.id LIMIT ?`, after, before, ...kinds, limit);
    return { seen: rows.map((r) => r.id), del: rows.filter((r) => !r.keep).map((r) => r.id) };
  }, opt);
}

export function getJob(store, jobId) {
  return store.get('SELECT * FROM jobs WHERE id = ?', jobId) ?? null;
}
