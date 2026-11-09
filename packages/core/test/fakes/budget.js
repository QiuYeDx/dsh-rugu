// FakeBudget：可控的预算端口（§10.6）。
//   - perUse：每个用途今天最多放行几次（不给 = 不限）；dailyCalls：所有用途合计（外发审视不算在内）；
//   - reserve：外发审视（use='review'）的独立预留，别的用途永远动不了它；
//   - pause()：模拟余额保护触发——除了外发审视的预留，全部拒绝。
export class FakeBudget {
  /** @param {{perUse?: Record<string, number>, dailyCalls?: number, reserve?: number, daysOfBalance?: number}} [opt] */
  constructor({ perUse = {}, dailyCalls = Infinity, reserve = 100, daysOfBalance = 30 } = {}) {
    this.perUse = { ...perUse };
    this.dailyCalls = dailyCalls;
    this.reserve = reserve;
    this.daysOfBalance = daysOfBalance;
    this.paused = false;
    this.used = {};
    this.total = 0;
    this.spentTokens = 0;
    this.denied = [];
    /** 每次 allow 带的 meta（sourceKey、reserved、direct……），测试核对核心告诉了预算什么 */
    this.metas = [];
  }
  /** @param {string} use @param {number} estTokens @param {object} [meta] */
  allow(use, estTokens = 0, meta = undefined) {
    this.metas.push({ use, meta: meta ?? null });
    if (use === 'review') {
      if (this.reserve <= 0) { this.denied.push(use); return false; }
      this.reserve -= 1;
      this.spentTokens += estTokens;
      return true;
    }
    const limit = this.perUse[use] ?? Infinity;
    const used = this.used[use] ?? 0;
    if (this.paused || used >= limit || this.total >= this.dailyCalls) { this.denied.push(use); return false; }
    this.used[use] = used + 1;
    this.total += 1;
    this.spentTokens += estTokens;
    return true;
  }
  state() {
    return { spentToday: this.spentTokens, reserveLeft: this.reserve, daysOfBalance: this.daysOfBalance, paused: this.paused };
  }
  pause() { this.paused = true; return this; }
  resume() { this.paused = false; return this; }
  setLimit(use, n) { this.perUse[use] = n; return this; }
  /** 新的一天：计数清零，预留恢复。 */
  resetDay(reserve = 100) { this.used = {}; this.total = 0; this.spentTokens = 0; this.reserve = reserve; return this; }
}
