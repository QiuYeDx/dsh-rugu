// 核心契约（§4.2–§4.5）：类型、枚举、校验、不透明 id 的帮手、错误类型。
// 适配器只依赖这一个入口（`rugu-core/contract`），不碰核心的其他部分（§3.5 第 3 条）。
export * from './enums.js';
export * from './errors.js';
export * from './ids.js';
export * from './setting.js';
export * from './validate.js';
