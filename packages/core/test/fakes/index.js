// 测试替身（rugu-core/testing）。各模块的测试和 DSH 适配器的契约测试都用它们。
export { FakeClock, MINUTE, HOUR, DAY } from './clock.js';
export { FakeLLM, estimateTokens } from './llm.js';
export { FakeEmbedding, FakeRerank, cosine } from './embedding.js';
export { FakeBudget } from './budget.js';
export { FakeSelfProfile, DEFAULT_CORE_SELF } from './self-profile.js';
export { FakeLogger } from './logger.js';
export { fakePorts } from './ports.js';
export { createTestCore, TEST_KEY } from './test-core.js';
