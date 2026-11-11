// 判定记录（appraisals）和她说过的话的审视记录（utterances）的到期清理（D139）。这两张表归 discretion，只在这里删。
// 删之前先看清楚谁还读它们；拿不准还有没有人读的，不删。
import { expireInBatches } from '../store/index.js';

const DAY = 86_400_000;

/**
 * 判定记录。读者：
 *   - 注入日志每一项的 appraisalRef（context.recordInjection 核对它对得上一行判定）→ 还留着的注入行引用的不删；
 *   - 第二段的缓存（lookupCache：cache_key、expires_at > now）→ 还没过期的不删（再留一天的余量，免得刚查到就被删）；
 *   - 工作记忆沿用旧行（working.js reuseAppraisal）→ 它只沿用比保留期新至少一天的行，删不到；
 *   - 管理页的分寸视图（working、floorOverrides、appraisals 列表）只列还在的行；discretion_log.appraisal_id 只是显示的编号，没有地方拿它回查。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{before: number, batch?: number, maxBatches?: number, signal?: AbortSignal}} opt
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireAppraisals(core, { before, ...opt }) {
  // 还留着的注入行引用了哪些（注入日志先清，这里看清完以后剩下的；这一次运行里新写的注入只引用新行或没过期的缓存行）
  const used = new Set();
  for (const r of core.store.all(`SELECT DISTINCT json_extract(j.value, '$.appraisalRef') AS ref FROM injections i, json_each(i.items_json) j
                                  WHERE json_type(j.value) = 'object'`)) {
    const m = /^ap([1-9]\d{0,15})$/.exec(String(r.ref ?? ''));
    if (m) used.add(Number(m[1]));
  }
  const cacheAlive = core.now() - DAY;
  return expireInBatches(core.store, 'appraisals', (after, limit) => {
    const rows = core.store.all(`SELECT id, (cache_key IS NOT NULL AND coalesce(expires_at, 0) > ?) AS cached FROM appraisals
                                 WHERE id > ? AND at < ? ORDER BY id LIMIT ?`, cacheAlive, after, before, limit);
    return { seen: rows.map((r) => r.id), del: rows.filter((r) => !r.cached && !used.has(r.id)).map((r) => r.id) };
  }, opt);
}

/**
 * 她说过的话的审视记录。读者：
 *   - 外发结果（outcome 按令牌）、回流对账（onSelfUtterance 按令牌 / 文本哈希、told.matchWindowMs）、「同一句被拒两次」（rejectWindowH）
 *     都只看最近的；保留天数不会比它们短（logRetentionDays）；
 *   - 挂起的发言（hold_status = 'pending'）还在等主人处理 → 不删；主人批准了、还没发出去的（approved 且 held_text 还在）→ 不删；
 *   - 成长和自我概念的依据要排除带按轮污点的发言（consolidate.taintedTurnPercepts 按 matched_percept + reasons 里的污点标记查）
 *     → reasons 里带污点标记的不删：这是「这句话不能当依据」的唯一记录，删了旧经历就会被当成干净的依据；
 *   - 管理页的「审核」「分寸」（blocked、utterances、holds 视图）只列还在的行；discretion_log.utterance_id 只是显示的编号。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{before: number, batch?: number, maxBatches?: number, signal?: AbortSignal}} opt
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireUtterances(core, { before, ...opt }) {
  return expireInBatches(core.store, 'utterances', (after, limit) => {
    const rows = core.store.all(`SELECT id, (coalesce(hold_status, '') = 'pending'
                                    OR (coalesce(hold_status, '') = 'approved' AND held_text IS NOT NULL)
                                    OR coalesce(reasons_json, '') LIKE '%taint%') AS keep
                                 FROM utterances WHERE id > ? AND at < ? ORDER BY id LIMIT ?`, after, before, limit);
    return { seen: rows.map((r) => r.id), del: rows.filter((r) => !r.keep).map((r) => r.id) };
  }, opt);
}
