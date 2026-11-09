// worker 线程的入口（§8.7、§7.7 第 10 步，H1）。三种角色：
//   - search：常驻；向量库的只读连接 + 内存索引（热温层 int8 + 二值、原文层二值），做稠密扫描；
//   - db：常驻；主库和向量库的只读连接，做词法查询、词频统计、图扩散、取已存向量；
//   - maint：临时；跑一个运维任务（副本上的完整性检查、FTS 小步合并、增量 vacuum）就退出。
// 只读连接直接用 DatabaseSync({readOnly: true})（不经 store 的写者锁：同一进程里第二个写者锁会把主线程的锁当成过期锁删掉）。
// 消息：{id, op, args} → {id, kind: 'partial'|'done'|'error', data|error}；id 为 null 的只做不答。错误只回类型，不回内容。
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { Engine, wrapDatabase } from './engine.js';
import { runTask } from './maint.js';
import { DEFAULTS } from '../config/defaults.js';

const { role, mainFile, vecFile, opts = {}, task, spaces = [] } = workerData ?? {};

const openRo = (file) => wrapDatabase(new DatabaseSync(file, { readOnly: true, timeout: opts.busyMs ?? DEFAULTS.worker.busyMs }));
const errOf = (e) => ({ code: String(e?.code ?? e?.name ?? 'Error').slice(0, 60) });

if (role === 'maint') {
  let out;
  try { out = runTask(DatabaseSync, task); } catch (e) { out = { ok: false, detail: errOf(e).code }; }
  parentPort.postMessage({ kind: 'ready', data: out });
} else {
  let engine = null;
  try {
    engine = new Engine({
      main: openRo(mainFile),
      vec: vecFile ? openRo(vecFile) : null,
      chunkRows: opts.chunkRows,
      loadBatch: opts.loadBatch,
    });
    parentPort.postMessage({ kind: 'ready', data: { role, readOnly: engine.readOnlyCheck() } });
  } catch (e) {
    parentPort.postMessage({ kind: 'fatal', error: errOf(e) });
  }
  const OPS = new Set(['dense', 'lexical', 'termCounts', 'ppr', 'stored', 'loadSpace', 'unloadSpace', 'reload', 'add', 'remove', 'removeOwners', 'stats']);
  parentPort.on('message', (m) => {
    const { id, op, args } = m ?? {};
    if (!engine || !OPS.has(op)) {
      if (id != null) parentPort.postMessage({ id, kind: 'error', error: { code: engine ? 'UNKNOWN_OP' : 'NO_ENGINE' } });
      return;
    }
    try {
      const onPartial = id == null ? undefined : (data) => parentPort.postMessage({ id, kind: 'partial', data });
      const data = engine[op](args ?? {}, onPartial);
      if (id != null) parentPort.postMessage({ id, kind: 'done', data });
    } catch (e) {
      if (id != null) parentPort.postMessage({ id, kind: 'error', error: errOf(e) });
    }
  });
  // search：连接打开就报 ready，然后才冷加载向量（大库要几秒，不能让 start 因此超时失败）。
  // 冷加载期间来的请求排在后面，到点没做完的那一路由主线程丢掉（冷启动按 L3 过这一轮，§8.8）。
  if (engine && role === 'search') {
    for (const s of spaces) {
      try { engine.loadSpace({ ...s, ifMissing: true }); } catch { /* 这个空间读不了：查询时再按需加载 */ }
    }
  }
}
