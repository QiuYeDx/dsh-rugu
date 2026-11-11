// 日志表的分批到期删除（D139）。表的拥有者自己定「哪些行能删」（pick），这里只管怎么删：
//   - 每批一个短事务，批与批之间让出事件循环：不长时间占着写锁，聊天照常；
//   - 能中断（signal、批数上限），没删完的下次接着删——删不删只看行本身和当时的状态，不另存进度。

/**
 * @param {import('./db.js').Store} store
 * @param {string} table   拥有者自己的表（只给内部常量，不拼外来的字符串）
 * @param {(afterId: number, limit: number) => {seen: number[], del: number[]}} pick
 *        这一批按 id 升序看过的行（最多 limit 个）和其中要删的；看过的不到 limit 个说明扫到头了。和删除在同一段同步代码里执行，中间没有别的写入。
 * @param {{batch?: number, maxBatches?: number, signal?: AbortSignal}} [opt]
 * @returns {Promise<{deleted: number, done: boolean}>}
 */
export async function expireInBatches(store, table, pick, { batch = 500, maxBatches = 200, signal } = {}) {
  const limit = Math.max(1, Math.floor(batch));
  let after = 0;
  let deleted = 0;
  for (let n = 0; n < maxBatches; n++) {
    if (signal?.aborted || store.closed) return { deleted, done: false };
    const { seen, del } = pick(after, limit);
    if (del.length) {
      deleted += store.tx((db) => {
        let c = 0;
        for (let i = 0; i < del.length; i += 400) {
          const part = del.slice(i, i + 400);
          c += Number(db.run(`DELETE FROM ${table} WHERE id IN (${part.map(() => '?').join(',')})`, ...part).changes);
        }
        return c;
      });
    }
    if (seen.length < limit) return { deleted, done: true };
    after = seen.at(-1);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { deleted, done: false };
}
