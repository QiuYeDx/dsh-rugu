// rugu-core：通用的人设记忆核心。零宿主依赖，不认识任何入口（§3）。
// 对外：createPersonaMemory（§4.5 的全部 API）、核心契约（也可以单独 import 'rugu-core/contract'）、
// 配置和端口的帮手。各模块的内部函数不从这里导出，集成层只调 API（§3.5 第 2 条）。
export { createPersonaMemory, CAPABILITIES } from './api.js';
export * from './contract/index.js';
export { DEFAULTS, createConfig, mergeConfig, budgetLimits, BUDGET_OVERRIDE_KEYS, checkBudgetOverride, RETENTION_MS, MODE_RANK } from './config/defaults.js';
export { normalizePorts, systemClock, nullLogger, unlimitedBudget, emptySelfProfile } from './ports/index.js';
export { SCHEMA_VERSION } from './store/migrations/index.js';
