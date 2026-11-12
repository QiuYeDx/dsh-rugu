// 「试一下」后台模型（D168）：第一眼那一形状的一次小请求。纯函数，不碰库、不调模型——集成层拿去自己发，再用这里的解析判断能不能用。
// 内容全是编的（两个不存在的人在一个不存在的群里约周末），系统提示词和输出格式和真实的第一眼完全一样（GLANCE_SYSTEM），
// 解析也用真实的那一个（parseJsonlObjects）：真实的第一眼认不了的输出，这里也算不合格。
import { GLANCE_SYSTEM } from './glance.js';
import { fence, parseJsonlObjects } from './util.js';
import { DEFAULTS } from '../config/defaults.js';

/** 卡片：三行，第 2、3 行要看（和真实的第一眼一样带 *）。 */
const LINES = [
  { i: 1, who: '其他人A', text: '周末有人去江边骑车吗', target: false },
  { i: 2, who: '他〔对你说〕', text: '@你 周六上午我们去吧，九点在桥头见', target: true },
  { i: 3, who: '他', text: '对了，我换工作的事先别跟别人说', target: true },
];
const TARGETS = new Set(LINES.filter((l) => l.target).map((l) => l.i));

/**
 * 第一眼形状的试调请求。
 * @returns {{system: string, messages: {role: 'user', content: string}[], maxTokens: number, targets: number}}
 */
export function glanceTrialRequest() {
  const content = ['这是一个多人的聊天，卡片上还有 1 个别人说的话。',
    fence('最近的几句（数据）', LINES.map((l) => `[${l.i}]${l.target ? '*' : ''} ${l.who}：${l.text}`).join('\n'))].join('\n');
  return { system: GLANCE_SYSTEM, messages: [{ role: 'user', content }], maxTokens: DEFAULTS.discretion.glance.maxTokens, targets: TARGETS.size };
}

/**
 * 试调的输出能不能用：有效行 = 真实的第一眼会收下的行（能解析、编号是要看的那几句、带 sens 和 to）；坏行 = 别的非空行。
 * @param {string} text
 * @returns {{valid: number, bad: number, expected: number}}
 */
export function parseGlanceTrial(text) {
  const objs = parseJsonlObjects(text);
  const seen = new Set();
  for (const o of objs) {
    const i = Number(o?.i);
    if (TARGETS.has(i) && typeof o.sens === 'number' && typeof o.to === 'string') seen.add(i);
  }
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^```/.test(s));
  return { valid: seen.size, bad: Math.max(0, lines.length - objs.length), expected: TARGETS.size };
}
