// FakeClock：可控的时钟。所有「现在」都从 Clock 端口取，所以测试里能把时间拨到 30 天后。
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export class FakeClock {
  /** @param {number|string|Date} [start]  默认 2026-10-31T10:00:00Z */
  constructor(start = Date.UTC(2026, 9, 31, 10, 0, 0)) {
    this.t = new Date(start).getTime();
    if (!Number.isFinite(this.t)) throw new TypeError('FakeClock 的起点不是合法时间');
  }
  now() { return this.t; }
  /** 往后拨 ms 毫秒（不许往回拨：迟到的处理靠事件时间，不靠时钟倒退）。 */
  advance(ms) {
    if (!(ms >= 0)) throw new RangeError('FakeClock 只能往后拨');
    this.t += ms;
    return this.t;
  }
  minutes(n) { return this.advance(n * MINUTE); }
  hours(n) { return this.advance(n * HOUR); }
  days(n) { return this.advance(n * DAY); }
  /** 直接设到某个时间（必须不早于现在）。 */
  set(t) {
    const v = new Date(t).getTime();
    if (v < this.t) throw new RangeError('FakeClock 不能往回拨');
    this.t = v;
    return this.t;
  }
}
