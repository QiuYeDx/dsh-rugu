// rugu-core：通用的人设记忆核心。零宿主依赖，不认识任何入口（§3）。
// 对外：createPersonaMemory（§4.5 的全部 API）、核心契约（也可以单独 import 'rugu-core/contract'）、
// 配置和端口的帮手。各模块的内部函数不从这里导出，集成层只调 API（§3.5 第 2 条）。
export { createPersonaMemory, CAPABILITIES } from './api.js';
export * from './contract/index.js';
export { DEFAULTS, createConfig, mergeConfig, budgetLimits, BUDGET_OVERRIDE_KEYS, checkBudgetOverride, RETENTION_MS, MODE_RANK, ROOM_MIN, ROOM_MAX } from './config/defaults.js';
// D165：回想各层生效的上限（随花费档位的 room）——集成层据此让自己的块上限跟着核心走，不另截核心决定要给的东西
export { recallCaps } from './config/caps.js';
export { normalizePorts, systemClock, nullLogger, unlimitedBudget, emptySelfProfile } from './ports/index.js';
export { SCHEMA_VERSION } from './store/migrations/index.js';
