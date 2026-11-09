// 一套全是替身的端口。
import { FakeClock } from './clock.js';
import { FakeLLM } from './llm.js';
import { FakeEmbedding, FakeRerank } from './embedding.js';
import { FakeBudget } from './budget.js';
import { FakeSelfProfile } from './self-profile.js';
import { FakeLogger } from './logger.js';

/**
 * 一套全是替身的端口。overrides 里给的覆盖默认的；给 null 表示「没有这个端口」（测降级用）。
 * @param {Partial<Record<'clock'|'llm'|'embedding'|'rerank'|'budget'|'selfProfile'|'logger', object|null>>} [overrides]
 */
export function fakePorts(overrides = {}) {
  const embedding = overrides.embedding === undefined ? new FakeEmbedding() : overrides.embedding;
  const ports = {
    clock: new FakeClock(),
    llm: new FakeLLM(),
    embedding,
    rerank: embedding ? new FakeRerank(embedding) : null,
    budget: new FakeBudget(),
    selfProfile: new FakeSelfProfile(),
    logger: new FakeLogger(),
    ...overrides,
  };
  for (const k of Object.keys(ports)) if (ports[k] === null) delete ports[k];
  return ports;
}
