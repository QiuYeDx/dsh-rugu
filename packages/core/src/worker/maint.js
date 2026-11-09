// 运维（§7.7 第 10 步，评审:FE-05）：全部在一个临时的 worker 线程里跑（thread.js 的 role='maint'），不占主线程。
//   - quick_check / integrity_check 跑在**刚备份出的副本**上（task.file），不碰正在用的库；
//   - FTS 不整体 optimize，改成每次小步合并（usermerge = 8，merge = 200 页）；
//   - incremental_vacuum(N) 每次限定页数。
// 结果只有 ok 和计数（detail 里没有内容）。
import fs from 'node:fs';
import { DEFAULTS } from '../config/defaults.js';

const TABLE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * 在一份副本上跑完整性检查。
 * @param {typeof import('node:sqlite').DatabaseSync} DatabaseSync
 * @param {{kind: 'quick-check'|'integrity-check', file: string}} task
 */
export function checkCopy(DatabaseSync, task) {
  if (!task.file || !fs.existsSync(task.file)) return { ok: false, detail: 'missing-file' };
  const db = new DatabaseSync(task.file, { readOnly: true });
  try {
    const pragma = task.kind === 'quick-check' ? 'quick_check' : 'integrity_check';
    const rows = db.prepare(`PRAGMA ${pragma}(100)`).all();
    const values = rows.map((r) => String(Object.values(r)[0] ?? ''));
    const ok = values.length === 1 && values[0] === 'ok';
    return ok ? { ok: true, detail: 'ok' } : { ok: false, detail: `problems=${values.length}` };
  } finally { db.close(); }
}

/** FTS 表（主表的 + 原文分表）。 */
function ftsTables(db) {
  const shards = db.prepare('SELECT name FROM fts_shards ORDER BY month').all().map((r) => r.name);
  return ['episodes_fts', 'assertions_fts', ...shards].filter((t) => TABLE_RE.test(t));
}

/**
 * FTS 小步合并：每张表做一次 merge（pages 页的工作量）。total_changes 增加不到 2 说明这张表已经合并完了（FTS5 文档）。
 * @param {{prepare: Function}} db 可写的 DatabaseSync
 * @param {{pages: number, segments: number}} p
 */
export function ftsMerge(db, { pages, segments }) {
  let more = 0;
  let tables = 0;
  // FTS5 的 usermerge 只认 INTEGER 类型的值，node:sqlite 把 JS 数字绑成 REAL 会报 SQL logic error：校验成整数后直接写进 SQL
  const seg = Math.min(16, Math.max(2, Math.floor(Number(segments) || DEFAULTS.worker.ftsMerge.segments)));
  const pg = Math.max(1, Math.floor(Number(pages) || DEFAULTS.worker.ftsMerge.pages));
  for (const t of ftsTables(db)) {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(t);
    if (!exists) continue;
    tables++;
    const cur = db.prepare(`SELECT v FROM "${t}_config" WHERE k = 'usermerge'`).get();
    if (Number(cur?.v) !== seg) db.prepare(`INSERT INTO ${t}(${t}, rank) VALUES ('usermerge', ${seg})`).run();
    const before = Number(db.prepare('SELECT total_changes() AS c').get().c);
    db.prepare(`INSERT INTO ${t}(${t}, rank) VALUES ('merge', ${pg})`).run();
    const after = Number(db.prepare('SELECT total_changes() AS c').get().c);
    if (after - before >= 2) more++;
  }
  return { ok: true, detail: `tables=${tables} more=${more}` };
}

/** 增量 vacuum：最多回收 pages 页。 */
export function vacuum(db, pages) {
  const before = Number(db.prepare('PRAGMA freelist_count').get().freelist_count ?? 0);
  db.prepare(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`).all();
  const after = Number(db.prepare('PRAGMA freelist_count').get().freelist_count ?? 0);
  return { ok: true, detail: `freed=${Math.max(0, before - after)} left=${after}` };
}

/**
 * 跑一个运维任务（在 maint 线程里，或者没有线程时在调用方线程里）。
 * @param {typeof import('node:sqlite').DatabaseSync} DatabaseSync
 * @param {{kind: string, file?: string, pages?: number, target: string, ftsMerge: {pages: number, segments: number}, vacuumPages: number, busyMs: number}} task
 */
export function runTask(DatabaseSync, task) {
  if (task.kind === 'quick-check' || task.kind === 'integrity-check') return checkCopy(DatabaseSync, task);
  if (task.kind !== 'fts-merge' && task.kind !== 'vacuum') return { ok: false, detail: 'unknown-task' };
  if (!task.target || !fs.existsSync(task.target)) return { ok: false, detail: 'missing-file' };
  const db = new DatabaseSync(task.target, { timeout: task.busyMs ?? DEFAULTS.worker.busyMs });
  try {
    if (task.kind === 'fts-merge') return ftsMerge(db, task.ftsMerge);
    return vacuum(db, task.pages ?? task.vacuumPages);
  } catch (e) {
    return { ok: false, detail: /busy|locked/i.test(String(e?.message)) ? 'busy' : (e?.code ?? e?.name ?? 'error') };
  } finally { db.close(); }
}
