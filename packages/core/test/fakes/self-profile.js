// FakeSelfProfile：她的核心自我（只有性格、口吻、价值观，§5.7）。测试数据里不出现任何真实人设名。
import crypto from 'node:crypto';

export const DEFAULT_CORE_SELF = '性格：温和，偶尔调皮，好奇心重。口吻：口语、简短，不说教。价值观：真诚、守信、不搬弄是非。';

export class FakeSelfProfile {
  /** @param {{text?: string, principalLabel?: string, locale?: string}} [opt] */
  constructor({ text = DEFAULT_CORE_SELF, principalLabel = '主人', locale = 'zh' } = {}) {
    this.text = text;
    this.label = principalLabel;
    this.locale = locale;
  }
  coreSelf() {
    return { text: this.text, hash: crypto.createHash('sha256').update(this.text).digest('hex').slice(0, 16) };
  }
  principalLabel() { return this.label; }
  /** 改核心自我（缓存键里带哈希，改了之后评估缓存应失效）。 */
  setText(text) { this.text = text; return this; }
}
