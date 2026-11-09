// lang 测试共用：测试核心（真库、真迁移；只 init lang，别的模块不碰），东八区，时间基准是 FakeClock 的默认时间。
import { createTestCore } from '../fakes/test-core.js';
import { fakePorts } from '../fakes/ports.js';

export const M = 60_000;
export const H = 60 * M;
export const D = 24 * H;
export const TZ = 480;
/** 2026-10-31（周六）18:00 东八区 = FakeClock 的默认起点 */
export const AT = Date.UTC(2026, 9, 31, 10, 0, 0);
/** 东八区本地时间 → UTC 毫秒（月份从 1 开始） */
export const L = (y, mo, d, h = 0, min = 0) => Date.UTC(y, mo - 1, d, h, min) - TZ * M;

/**
 * @param {(core: import('../../src/core-types.js').CoreContext, ports: object) => any} fn
 * @param {{config?: object, ports?: object, init?: boolean}} [opt]
 */
export async function withLang(fn, { config = {}, ports, init = true } = {}) {
  const { core, cleanup, ports: p } = await createTestCore({
    name: 'lang', init: false, ports: ports ?? fakePorts(), config: { time: { tzOffsetMin: TZ }, ...config },
  });
  try {
    if (init) await core.mods.lang.init(core);
    return await fn(core, p);
  } finally { await cleanup(); }
}

/** 时间窗写成本地时间，方便看断言失败。 */
export function show(w) {
  const f = (t) => new Date(t + TZ * M).toISOString().slice(0, 16).replace('T', ' ');
  return `${f(w.start)} → ${f(w.end)} ${w.precision}`;
}
