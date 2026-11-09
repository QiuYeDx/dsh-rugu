// 采样器的 worker 线程：koffi 调 Toolhelp 枚举进程、SHQueryUserNotificationState 查全屏。
// 进程名只在这里和主人配置的清单比对，传回去的只有命中的序号（§8.6.2：进程列表不保存、不写日志）。
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const SIZE = 568;                 // sizeof(PROCESSENTRY32W)（x64）
const NAME_OFFSET = 44;           // szExeFile 的偏移：dwSize..dwFlags 之后（含 x64 对齐）
const FULLSCREEN_STATES = new Set([2, 3, 4]);   // QUNS_BUSY / QUNS_RUNNING_D3D_FULL_SCREEN / QUNS_PRESENTATION_MODE

let native = null;
function bind() {
  if (native) return native;
  native = { toolhelp: null, notification: null };
  let koffi;
  try { koffi = createRequire(import.meta.url)(workerData.koffiPath); } catch { return native; }
  try {
    const k32 = koffi.load('kernel32.dll');
    const PVOID = koffi.pointer('void');
    const snap = k32.func('__stdcall', 'CreateToolhelp32Snapshot', PVOID, ['uint32', 'uint32']);
    const first = k32.func('__stdcall', 'Process32FirstW', 'int', [PVOID, PVOID]);
    const next = k32.func('__stdcall', 'Process32NextW', 'int', [PVOID, PVOID]);
    const close = k32.func('__stdcall', 'CloseHandle', 'int', [PVOID]);
    native.toolhelp = () => {
      const names = new Set();
      const h = snap(0x2, 0);
      if (h === null) return names;
      const entry = Buffer.alloc(SIZE);
      entry.writeUInt32LE(SIZE, 0);
      const read = () => {
        const raw = entry.subarray(NAME_OFFSET, NAME_OFFSET + 520).toString('utf16le');
        const end = raw.indexOf('\u0000');
        names.add((end >= 0 ? raw.slice(0, end) : raw).toLowerCase());
      };
      try { if (first(h, entry)) { read(); while (next(h, entry)) read(); } } finally { close(h); }
      return names;
    };
  } catch { native.toolhelp = null; }
  try {
    const sh = koffi.load('shell32.dll');
    const fn = sh.func('__stdcall', 'SHQueryUserNotificationState', 'int32', [koffi.pointer('int32')]);
    native.notification = () => {
      const slot = koffi.alloc('int32', 1);
      try { return fn(slot) === 0 ? koffi.decode(slot, 'int32') : null; } finally { koffi.free(slot); }
    };
  } catch { native.notification = null; }
  return native;
}

parentPort.on('message', ({ id, processes }) => {
  const out = { id };
  try {
    const n = bind();
    if (n.toolhelp && Array.isArray(processes) && processes.length) {
      const names = n.toolhelp();
      out.procHits = processes.map((p, i) => (names.has(String(p).toLowerCase()) ? i : -1)).filter((i) => i >= 0);
    } else out.procHits = [];
    if (n.notification) {
      const st = n.notification();
      out.fullscreen = st == null ? null : FULLSCREEN_STATES.has(st);
    }
  } catch { /* 采不到就当不成立 */ }
  parentPort.postMessage(out);
});
