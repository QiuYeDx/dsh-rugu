// 单写者的数据库包装（§12.1、§12.8）。
//   - node:sqlite 的 DatabaseSync 是同步的，跑在宿主唯一的事件循环上（H1），所以：慢查询和维护都进 worker，
//     这里每次调用都计时，超过 slowMs（默认 50 ms）记慢日志（§7.7）。
//   - 主库只有一个写者：同一个文件同时只能被一个 Store 以读写方式打开（文件锁 <db>.writer.lock）。
//     worker 用 openStore({readOnly: true}) 开自己的只读连接（WAL 允许并发读）。
//   - 时间一律 UTC 毫秒，从注入的 Clock 取（store.now()）。
//   - 参数：布尔值自动转 1/0，undefined 自动转 null；对象和数组不自动转 JSON（要自己 JSON.stringify，免得写进去一串 [object Object]）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ReadOnlyError } from '../contract/errors.js';

export const DEFAULT_SLOW_MS = 50;
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const systemClock = { now: () => Date.now() };
const nullLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class StoreLockedError extends Error {
  constructor(file, holder) {
    super(`数据库已被另一个写者占用：${path.basename(file)}（pid ${holder?.pid ?? '?'}）`);
    this.name = 'StoreLockedError';
    this.code = 'STORE_LOCKED';
  }
}

// ── 写者锁 ────────────────────────────────────────────────────────────────
const heldLocks = new Set();
let exitHookInstalled = false;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireWriterLock(dbFile) {
  const lockFile = `${dbFile}.writer.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      heldLocks.add(lockFile);
      if (!exitHookInstalled) {
        exitHookInstalled = true;
        process.once('exit', () => { for (const f of heldLocks) { try { fs.rmSync(f, { force: true }); } catch { /* 退出时尽力 */ } } });
      }
      return lockFile;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* 锁文件坏了，当成过期 */ }
      // 同一进程里已经有一个写者（heldLocks 里有），或者别的活着的进程拿着：不能再开
      if (heldLocks.has(lockFile) || (holder && holder.pid !== process.pid && pidAlive(holder.pid))) {
        throw new StoreLockedError(dbFile, holder);
      }
      fs.rmSync(lockFile, { force: true });   // 上次崩溃留下的过期锁
    }
  }
  throw new StoreLockedError(dbFile, null);
}
function releaseWriterLock(lockFile) {
  if (!lockFile) return;
  heldLocks.delete(lockFile);
  try { fs.rmSync(lockFile, { force: true }); } catch { /* 下次打开时会当成过期锁清掉 */ }
}

// ── 参数规范化 ────────────────────────────────────────────────────────────
function normValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array) && !ArrayBuffer.isView(v)) {
    throw new TypeError('SQL 参数不能是普通对象或数组：先 JSON.stringify');
  }
  return v;
}
function normParams(params) {
  if (params.length === 1 && params[0] !== null && typeof params[0] === 'object'
    && !(params[0] instanceof Uint8Array) && !ArrayBuffer.isView(params[0]) && !Array.isArray(params[0])) {
    const named = {};
    for (const [k, v] of Object.entries(params[0])) named[k] = normValue(v);
    return [named];
  }
  return params.map(normValue);
}
const sqlTag = (sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 48);

/**
 * 数据库连接的包装。业务模块只用 get / all / run / tx / afterCommit，不直接碰 raw。
 */
export class Store {
  /** @type {DatabaseSync} */ #db;
  #stmts = new Map();
  #depth = 0;
  #afterCommit = [];
  #lockFile;
  #closed = false;

  /**
   * @param {DatabaseSync} db
   * @param {{file: string, readOnly: boolean, readOnlyReason?: string, clock?: {now(): number},
   *          logger?: object, slowMs?: number, lockFile?: string|null}} opt
   */
  constructor(db, opt) {
    this.#db = db;
    this.file = opt.file;
    this.readOnly = !!opt.readOnly;
    this.readOnlyReason = opt.readOnlyReason ?? (opt.readOnly ? 'opened-read-only' : null);
    this.clock = opt.clock ?? systemClock;
    this.logger = opt.logger ?? nullLogger;
    this.slowMs = opt.slowMs ?? DEFAULT_SLOW_MS;
    this.#lockFile = opt.lockFile ?? null;
    /** 打开时的迁移结果（openStore 填） */
    this.migration = null;
  }

  /** 底层 DatabaseSync。只给 store/ 自己和迁移用。 */
  get raw() { return this.#db; }
  get closed() { return this.#closed; }
  get inTransaction() { return this.#depth > 0; }
  /** UTC 毫秒。 */
  now() { return this.clock.now(); }

  #assertWritable() {
    if (this.readOnly) throw new ReadOnlyError(`数据库是只读的（${this.readOnlyReason}）`);
  }
  #timed(sql, fn) {
    const t0 = performance.now();
    try { return fn(); } finally {
      const ms = performance.now() - t0;
      if (ms > this.slowMs) { try { this.logger.warn('store.slow', { ms: Math.round(ms), op: sqlTag(sql) }); } catch { /* 日志失败不影响查询 */ } }
    }
  }

  /** 预编译并缓存语句。 */
  prepare(sql) {
    let s = this.#stmts.get(sql);
    if (!s) { s = this.#db.prepare(sql); this.#stmts.set(sql, s); }
    return s;
  }
  /** 读一行（没有返回 undefined）。 */
  get(sql, ...params) { return this.#timed(sql, () => this.prepare(sql).get(...normParams(params))); }
  /** 读多行。 */
  all(sql, ...params) { return this.#timed(sql, () => this.prepare(sql).all(...normParams(params))); }
  /** 写。返回 {changes, lastInsertRowid}。 */
  run(sql, ...params) {
    this.#assertWritable();
    return this.#timed(sql, () => this.prepare(sql).run(...normParams(params)));
  }
  /** 执行不带参数的 SQL（建表、PRAGMA）。 */
  exec(sql) {
    this.#assertWritable();
    return this.#timed(sql, () => this.#db.exec(sql));
  }
  /** 读一个 PRAGMA 的值。 */
  pragma(name) {
    const row = this.#db.prepare(`PRAGMA ${name}`).get();
    return row ? Object.values(row)[0] : undefined;
  }

  /**
   * 事务。回调必须是同步的（DatabaseSync 是同步的；在事务里 await 会让别的写入插进来）。
   * 嵌套调用用 SAVEPOINT：内层失败只回滚内层，异常照样往外抛。
   * 外层用 BEGIN IMMEDIATE，一开始就拿写锁，免得和 worker 的只读连接之间出现升级死锁。
   * @template T
   * @param {(store: Store) => T} fn
   * @returns {T}
   */
  tx(fn) {
    this.#assertWritable();
    const depth = this.#depth;
    const sp = `sp_${depth}`;
    this.#db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.#depth++;
    const afterLen = this.#afterCommit.length;
    let r;
    try {
      r = fn(this);
      if (r && typeof r.then === 'function') {
        r.then?.(() => {}, () => {});
        throw new Error('tx() 的回调必须是同步的：事务里不能 await');
      }
    } catch (e) {
      this.#depth--;
      this.#afterCommit.length = afterLen;   // 回滚掉的部分，它登记的 afterCommit 也作废
      try {
        if (depth === 0) this.#db.exec('ROLLBACK');
        else { this.#db.exec(`ROLLBACK TO ${sp}`); this.#db.exec(`RELEASE ${sp}`); }
      } catch { /* 连接已经坏了：原异常更有用 */ }
      throw e;
    }
    this.#depth--;
    try {
      this.#db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    } catch (e) {
      this.#afterCommit.length = afterLen;
      try {
        if (depth === 0) this.#db.exec('ROLLBACK');
        else { this.#db.exec(`ROLLBACK TO ${sp}`); this.#db.exec(`RELEASE ${sp}`); }
      } catch { /* 原异常更有用 */ }
      throw e;
    }
    if (depth === 0) this.#flushAfterCommit();
    return r;
  }

  /**
   * 提交之后再做的事（比如通知预取、让 worker 刷新索引）。不在事务里就马上做。
   * 回调里抛的错只记日志，不影响已经提交的数据。
   */
  afterCommit(cb) {
    if (this.#depth === 0) { this.#runCb(cb); return; }
    this.#afterCommit.push(cb);
  }
  #flushAfterCommit() {
    const cbs = this.#afterCommit.splice(0);
    for (const cb of cbs) this.#runCb(cb);
  }
  #runCb(cb) {
    try { cb(); } catch (e) { try { this.logger.error('store.afterCommit', { error: e?.name ?? 'Error' }); } catch { /* 忽略 */ } }
  }

  /** WAL 检查点（PASSIVE 不阻塞读者）。 */
  checkpoint(mode = 'PASSIVE') {
    if (this.readOnly) return null;
    return this.#db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stmts.clear();
    try { if (!this.readOnly) this.checkpoint('PASSIVE'); } catch { /* 关库时尽力 */ }
    try { this.#db.close(); } finally { releaseWriterLock(this.#lockFile); }
  }
}

/**
 * 打开一个 SQLite 文件，设好主库要求的 PRAGMA。不跑迁移（迁移见 openStore）。
 * @param {{file: string, readOnly?: boolean, clock?: object, logger?: object, slowMs?: number, busyTimeoutMs?: number,
 *          lock?: boolean}} opt
 * @returns {Store}
 */
export function openDatabase(opt) {
  const file = opt.file;
  const memory = file === ':memory:';
  const readOnly = !!opt.readOnly;
  if (!memory && !readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = !memory && !readOnly && opt.lock !== false ? acquireWriterLock(file) : null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly, timeout: opt.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS });
  } catch (e) { releaseWriterLock(lockFile); throw e; }
  const store = new Store(db, { file, readOnly, clock: opt.clock, logger: opt.logger, slowMs: opt.slowMs, lockFile });
  if (!readOnly) {
    try { applyWriterPragmas(store); } catch (e) { store.close(); throw e; }
  } else {
    db.exec('PRAGMA query_only = ON');
  }
  return store;
}

/** 主库的 PRAGMA（§12.1）：WAL、synchronous=NORMAL、auto_vacuum=INCREMENTAL。 */
function applyWriterPragmas(store) {
  const db = store.raw;
  // auto_vacuum 只能在建第一张表之前设；已经有表的旧库要 VACUUM 才能改，这里不动它
  const hasTables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n > 0;
  if (!hasTables) db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  if (store.file !== ':memory:') {
    const mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
    if (String(mode).toLowerCase() !== 'wal') throw new Error(`开不了 WAL（journal_mode=${mode}）`);
  }
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = OFF');   // 引用完整性由各模块按来源链维护（§12.3 删除按来源链级联），不用外键
  db.exec('PRAGMA temp_store = MEMORY');
}
