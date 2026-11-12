// 「试一下」后台模型（D168）：提炼那一形状的一次小请求。纯函数，不碰库、不调模型——集成层拿去自己发，再用这里的解析判断能不能用。
// 系统提示词就是真实的提炼提示词（EXTRACT_STATIC），用户消息照 buildExtractPrompt 的样子拼，内容全是编的（两个不存在的人约骑车）；
// 解析用真实的那一个（parseJsonl）：真实的提炼收不下的输出，这里也算不合格。
import { EXTRACT_STATIC } from './prompt.js';
import { parseJsonl } from './parse.js';
import { DEFAULTS } from '../config/defaults.js';

const HEAD = [
  '日期：2026-05-16（周六）  场合：「江边骑车群」（多人的群；成员固定；成员看得到；有记录）',
  '消息的本地时间以 2026-05-16T09:00:00+08:00 为准换算相对时间。',
  '在场的人：U1 小周（人）；U2 阿宁（人）',
  '本场合的人都知道的背景（可以写进上下文头和叙述）：无',
  '只供你理解、不许写进上下文头和叙述的背景：无',
  '候选档案：无',
  '本段：',
  '[m1][05-16 09:00][U1]：明天上午去江边骑车吗，九点桥头见',
  '[m2][05-16 09:01][U2]：好啊，我带打气筒',
  '[m3][05-16 09:02][我]：我也去，顺便带点水',
  '[m4][05-16 09:03][U1]〔对你说〕：那说定了，迟到的请喝奶茶',
].join('\n');

/**
 * 提炼形状的试调请求。
 * @returns {{system: string, messages: {role: 'user', content: string}[], maxTokens: number}}
 */
export function extractTrialRequest() {
  return { system: EXTRACT_STATIC, messages: [{ role: 'user', content: HEAD }], maxTokens: DEFAULTS.extract.maxTokens };
}

/**
 * 试调的输出能不能用：有效行 = 真实的提炼会收下的行（认得的 type）；坏行 = 解析不了的行。
 * @param {string} text
 * @returns {{valid: number, bad: number}}
 */
export function parseExtractTrial(text) {
  const r = parseJsonl(text);
  return { valid: r.lines.length, bad: r.errors };
}
