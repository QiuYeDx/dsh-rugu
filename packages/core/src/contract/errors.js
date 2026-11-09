// 核心对外抛的几种错误。适配器和集成层只按 code 判断，不按 message（message 是给人看的中文）。

/** 还没实现的模块函数。message 里带「模块.函数」，方便看出是哪个模块没写完。 */
export class NotImplementedError extends Error {
  /** @param {string} what 形如 'intake.enqueue' */
  constructor(what) {
    super(`还没实现：${what}`);
    this.name = 'NotImplementedError';
    this.code = 'NOT_IMPLEMENTED';
    this.what = what;
    this.module = what.slice(0, Math.max(0, what.indexOf('.'))) || what;
  }
}

/** 抛出 NotImplementedError。stub 里写 `notImplemented('intake.enqueue')`。 */
export function notImplemented(what) {
  throw new NotImplementedError(what);
}

/** 适配器给的数据不合契约。errors 是 [{path, message}]。 */
export class ContractError extends Error {
  /** @param {string} what 校验的是什么（'Observation' 等） @param {{path:string, message:string}[]} errors */
  constructor(what, errors) {
    super(`${what} 不合契约：${errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('；')}${errors.length > 3 ? ` 等 ${errors.length} 处` : ''}`);
    this.name = 'ContractError';
    this.code = 'CONTRACT';
    this.errors = errors;
  }
}

/** 库是只读的（库的版本比代码新，§12.5），写操作一律拒绝。 */
export class ReadOnlyError extends Error {
  constructor(reason = '数据库是只读的') {
    super(reason);
    this.name = 'ReadOnlyError';
    this.code = 'READ_ONLY';
  }
}
