// retrieve 测试自己的 CoreContext：和 test/fakes/test-core.js 的 createTestCore 一样（真库、真迁移、替身端口、可替换的 core.mods），
// 但 core.mods 里只有 retrieve 是真模块，其余全是替身——不 import api.js，所以别的模块正在改、暂时加载不了的时候，
// retrieve 的测试照样能跑（并行开发期间的隔离；整合之后 createTestCore 和这里等价）。
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore, openVectorStore, mainDbIdOf, makeKeyring } from '../../src/store/index.js';
import { normalizePorts } from '../../src/ports/index.js';
import { createConfig } from '../../src/config/defaults.js';
import * as retrieve from '../../src/retrieve/index.js';
import { fakePorts } from '../fakes/ports.js';
import { tmpDir, rmDir } from '../helpers.js';

const TEST_KEY = crypto.createHash('sha256').update('rugu-core/test-key').digest();
const MODULE_NAMES = ['lang', 'admin', 'intake', 'entities', 'dynamics', 'discretion', 'encode', 'worker', 'retrieve', 'context', 'consolidate', 'backup'];

/** 没给替身的函数一调用就报错（不悄悄依赖别的模块的真实现）。 */
function stubModule(name, fns = {}) {
  const base = { init() {}, dispose() {} };
  return new Proxy({ ...base, ...fns }, {
    get(t, k) {
      if (k in t || typeof k === 'symbol') return t[k];
      return () => { throw new Error(`测试替身：${name}.${String(k)} 没有准备`); };
    },
  });
}

/** 深合并（测试用：把还没并进 defaults.js 的键叠到当前快照上）。 */
function overlay(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? overlay(base?.[k], v) : v;
  return out;
}

/**
 * @param {{ports?: object, config?: object, extraConfig?: object, mods?: Record<string, Record<string, Function>>}} [opt]
 *        extraConfig：retrieve 交付说明里请求加进 defaults.js 的键（mergeConfig 会丢掉不认识的键，这里叠在快照上模拟整合之后）
 */
export async function isolatedCore({ ports, config, extraConfig, mods = {} } = {}) {
  const p = normalizePorts(ports ?? fakePorts());
  const base = createConfig(config ?? {});
  const cfg = extraConfig ? { ...base, get: () => overlay(base.get(), extraConfig) } : base;
  const dir = tmpDir('retrieve');
  let store;
  let vec = null;
  try {
    store = await openStore({ file: path.join(dir, 'persona-memory.db'), clock: p.clock, logger: p.logger });
    vec = openVectorStore({ file: path.join(dir, 'persona-vectors.db'), mainDbId: mainDbIdOf(store), clock: p.clock, logger: p.logger });
  } catch (e) {
    try { store?.close(); } catch { /* 尽力 */ }
    rmDir(dir);
    throw e;
  }
  const all = Object.fromEntries(MODULE_NAMES.map((n) => [n, n === 'retrieve' ? Object.freeze({ ...retrieve, ...(mods.retrieve ?? {}) }) : stubModule(n, mods[n])]));
  const core = {
    store, vectors: vec, ports: p, config: cfg, keys: makeKeyring(TEST_KEY), adapters: new Map(), dataDir: dir, readOnly: false,
    state: {}, log: p.logger, now: () => p.clock.now(), jobHandlers: new Map(), mods: Object.freeze(all),
    reopen: async () => { throw new Error('不支持 reopen'); },
  };
  retrieve.init(core);
  let done = false;
  return {
    core,
    dir,
    async cleanup() {
      if (done) return;
      done = true;
      try { retrieve.dispose(core); } catch { /* 尽力 */ }
      try { vec?.close(); } catch { /* 尽力 */ }
      try { if (!store.closed) store.close(); } catch { /* 尽力 */ }
      rmDir(dir);
    },
  };
}
