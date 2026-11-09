// createTestCore：给单个模块写测试用的 CoreContext。真库（.tmp 下的临时目录、跑完迁移）、真配置、替身端口，
// 加上可以替换的 core.mods——依赖的模块还没实现，或者想隔离它，就在 mods 里给替身函数：
//
//   const { core, cleanup } = await createTestCore({
//     name: 'encode',
//     mods: { discretion: { writeNorm: (core, ref, norm) => 1 }, dynamics: { addTrace: () => ({ added: true }) } },
//   });
//   try { ... core.mods.encode.writeAssertion(core, {...}) ... } finally { await cleanup(); }
//
// mods 里只给想换的函数，其余的照用真模块。
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore, openVectorStore, mainDbIdOf, makeKeyring } from '../../src/store/index.js';
import { normalizePorts } from '../../src/ports/index.js';
import { createConfig, toConfigHandle } from '../../src/config/defaults.js';
import { MODULES } from '../../src/api.js';
import { fakePorts } from './ports.js';
import { tmpDir, rmDir } from '../helpers.js';

/**
 * @param {{name?: string, ports?: object, config?: object, mods?: Record<string, Record<string, Function>>,
 *          init?: boolean, vectors?: boolean, key?: Buffer}} [opt]
 *        ports：给了就用它（会经 normalizePorts）；没给用 fakePorts()。init=false 时不调各模块的 init。
 *        key：身份哈希密钥（32 字节）。默认是固定的测试密钥，同样的输入每次得到同样的哈希和场合键（替身要确定）；
 *        测「换密钥全变」时自己传一个。
 * @returns {Promise<{core: import('../../src/core-types.js').CoreContext, dir: string, ports: object, cleanup: () => Promise<void>}>}
 */
export const TEST_KEY = crypto.createHash('sha256').update('rugu-core/test-key').digest();

export async function createTestCore({ name = 'core', ports, config, mods = {}, init = true, vectors = true, key = TEST_KEY } = {}) {
  for (const k of Object.keys(mods)) if (!MODULES[k]) throw new Error(`createTestCore：没有这个模块 ${k}`);
  const rawPorts = ports ?? fakePorts();
  const p = normalizePorts(rawPorts);
  const cfg = config && typeof config.get === 'function' ? toConfigHandle(config) : createConfig(config ?? {});
  const dir = tmpDir(name);
  let store;
  let vec = null;
  try {
    store = await openStore({ file: path.join(dir, 'persona-memory.db'), clock: p.clock, logger: p.logger });
    if (vectors) vec = openVectorStore({ file: path.join(dir, 'persona-vectors.db'), mainDbId: mainDbIdOf(store), clock: p.clock, logger: p.logger });
  } catch (e) {
    try { store?.close(); } catch { /* 尽力 */ }
    rmDir(dir);
    throw e;
  }
  const merged = Object.freeze(Object.fromEntries(Object.entries(MODULES).map(([k, ns]) => [k, Object.freeze({ ...ns, ...(mods[k] ?? {}) })])));
  /** @type {import('../../src/core-types.js').CoreContext} */
  const core = {
    store,
    vectors: vec,
    ports: p,
    config: cfg,
    keys: makeKeyring(key),
    adapters: new Map(),
    dataDir: dir,
    readOnly: false,
    state: {},
    log: p.logger,
    now: () => p.clock.now(),
    jobHandlers: new Map(),
    mods: /** @type {any} */ (merged),
    reopen: async () => { throw new Error('createTestCore 的 core 不支持 reopen'); },
  };
  if (init) {
    for (const [k, m] of Object.entries(merged)) {
      await m.init(core);
      core.state[k] ??= {};
    }
  }
  let done = false;
  return {
    core,
    dir,
    ports: rawPorts,
    async cleanup() {
      if (done) return;
      done = true;
      for (const m of Object.values(merged).reverse()) { try { await m.dispose(core); } catch { /* 尽力 */ } }
      try { vec?.close(); } catch { /* 尽力 */ }
      try { store.close(); } catch { /* 尽力 */ }
      rmDir(dir);
    },
  };
}
