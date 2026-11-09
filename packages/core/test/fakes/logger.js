// FakeLogger：把日志记下来，测试可以断言「日志里没有内容」（§12.3：只记 id、类型和计数）。
export class FakeLogger {
  constructor() {
    /** @type {{level: string, event: string, fields: Record<string, unknown>}[]} */
    this.entries = [];
    for (const level of ['debug', 'info', 'warn', 'error']) {
      this[level] = (event, fields = {}) => { this.entries.push({ level, event, fields: { ...fields } }); };
    }
  }
  events(event) { return this.entries.filter((e) => e.event === event); }
  clear() { this.entries.length = 0; }
  /**
   * 断言日志里没有出现这些文字（消息原文、账号、记忆内容）。出现了就抛错并指出是哪条。
   * @param {...string} needles
   */
  assertNoText(...needles) {
    for (const e of this.entries) {
      const blob = `${e.event} ${JSON.stringify(e.fields)}`;
      for (const n of needles) {
        if (n && blob.includes(n)) throw new Error(`日志里出现了不该有的内容：事件 ${e.event} 含「${n.slice(0, 20)}」`);
      }
    }
  }
}
