// 集成层测试的小工具：用 FakeDshCtx + 核心 API 替身起一个完整的 host（不起调度、不起资源管家、不碰网络和本机的 DSH 目录）。
import fs from 'node:fs';
import path from 'node:path';
import { createHost } from '../../src/host/index.js';
import { FakeDshCtx, createFakePm, tmpDir, rmDir, fakeBinding } from '../fakes/index.js';

/** 一个永远不通的 fetch（嵌入健康检查之类的不会真的出去）。 */
export const offlineFetch = async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); };

/**
 * @param {{pm?: object, config?: object, bindings?: object[], deps?: object, ctx?: FakeDshCtx, name?: string}} [o]
 */
export async function makeHost(o = {}) {
  const dir = tmpDir(o.name ?? 'host');
  if (o.config) fs.writeFileSync(path.join(dir, 'persona-memory.json'), JSON.stringify(o.config));
  const ctx = o.ctx ?? new FakeDshCtx();
  const pm = o.pm === undefined ? createFakePm() : o.pm;
  const host = createHost(ctx, {}, {
    dshHome: dir,
    coreFactory: async () => { if (!pm) throw Object.assign(new Error('open failed'), { code: 'STORE_LOCKED' }); return pm; },
    adapterFactories: {},
    registerAdmin: null,
    defineTool: (d) => d,
    sampler: null,
    skipSelfCheckNetwork: true,
    startServices: false,
    fetchImpl: offlineFetch,
    ...(o.deps ?? {}),
  });
  await host.ready;
  const unbinds = [];
  for (const b of o.bindings ?? [fakeBinding()]) unbinds.push(host.service.dsh.registerBinding(b));
  return {
    ctx, host, pm, dir,
    async cleanup() { await host.dispose(); rmDir(dir); },
  };
}
