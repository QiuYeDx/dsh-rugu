// 时间说法（D148）：进她上下文的「什么时候」按人感觉的方式写好，不让读的人自己和「现在」做减法。边界：几个小时以内、
// 跨午夜、昨天 / 前天、一周内、更早、跨年、以后的事、时区；三种写法（full / day / date）；注册表按 locale 选、不认识的退回绝对时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { zhWhen, zhNow, zhSpan, undWhen, phrasingFor } from '../../src/lang/when.js';
import { describeTime, describeNow, describeSpan } from '../../src/lang/index.js';

const TZ = 480;
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** 东八区的本地时间（月份 1–12）。 */
const L = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - TZ * MIN;
// 2026-11-11 是周三
const NOW = L(2026, 11, 11, 22, 0);
const w = (t, style, now = NOW, agoH = 3) => zhWhen(t, now, { tzOffsetMin: TZ, style, agoH });

test('几个小时以内：当天写「今晚 21:39 · 21 分钟前」，以「多久以前」为主；一分钟以内是「刚才」', () => {
  assert.equal(w(L(2026, 11, 11, 21, 39)), '今晚 21:39 · 21 分钟前');
  assert.equal(w(NOW - 30_000), '刚才');
  assert.equal(w(L(2026, 11, 11, 20, 0)), '今晚 20:00 · 2 小时前');
  assert.equal(w(L(2026, 11, 11, 19, 1)), '今晚 19:01 · 3 小时前', '刚好不到 agoH');
  assert.equal(w(L(2026, 11, 11, 19, 0)), '今晚 19:00', '到了 agoH 就只写钟点');
  assert.equal(w(L(2026, 11, 11, 16, 20)), '今天下午 16:20');
  assert.equal(w(L(2026, 11, 11, 9, 5)), '今天上午 9:05');
  assert.equal(w(L(2026, 11, 11, 3, 0)), '今天凌晨 3:00');
});

test('跨午夜：凌晨 0:30 说 23:50 的事是「40 分钟前（23:50）」，不说「昨天」；过了 agoH 才说「昨天晚上」', () => {
  const now = L(2026, 11, 12, 0, 30);
  assert.equal(w(L(2026, 11, 11, 23, 50), 'full', now), '40 分钟前（23:50）');
  assert.equal(w(L(2026, 11, 11, 22, 0), 'full', now), '3 小时前（22:00）');
  assert.equal(w(L(2026, 11, 11, 21, 0), 'full', now), '昨天晚上 21:00');
  // day / date 不说「多久以前」
  assert.equal(w(L(2026, 11, 11, 23, 50), 'day', now), '昨天晚上 23:50');
  assert.equal(w(L(2026, 11, 11, 23, 50), 'date', now), '昨天');
});

test('昨天、前天、一周以内、更早、跨年', () => {
  assert.equal(w(L(2026, 11, 10, 22, 14)), '昨天晚上 22:14');
  assert.equal(w(L(2026, 11, 10, 12, 0)), '昨天中午 12:00');
  assert.equal(w(L(2026, 11, 9, 15, 0)), '前天下午');
  assert.equal(w(L(2026, 11, 8, 15, 0)), '周日（11/8）下午');
  assert.equal(w(L(2026, 11, 7, 20, 38)), '周六（11/7）晚上');
  assert.equal(w(L(2026, 11, 5, 7, 0)), '周四（11/5）早上', '六天前还写星期几');
  assert.equal(w(L(2026, 11, 4, 7, 0)), '11/4', '七天前写日期');
  assert.equal(w(L(2025, 12, 30, 7, 0), 'full', L(2026, 1, 20, 9, 0)), '2025/12/30', '跨年带年');
  assert.equal(w(L(2025, 12, 30, 7, 0), 'full', L(2026, 1, 2, 9, 0)), '周二（12/30）早上', '跨年但在一周以内：星期几');
});

test('以后的事：今晚、明天、后天、一周以内、更远', () => {
  assert.equal(w(L(2026, 11, 11, 23, 0)), '今晚 23:00');
  assert.equal(w(L(2026, 11, 12, 9, 30)), '明天上午 9:30');
  assert.equal(w(L(2026, 11, 13, 15, 0)), '后天下午');
  assert.equal(w(L(2026, 11, 14, 10, 0)), '周六（11/14）上午');
  assert.equal(w(L(2026, 11, 30, 10, 0)), '11/30');
});

test('三种写法：date 只到天；day 不带「多久以前」', () => {
  const t = L(2026, 11, 11, 21, 39);
  assert.equal(w(t, 'day'), '今晚 21:39');
  assert.equal(w(t, 'date'), '今天');
  assert.equal(w(L(2026, 11, 9, 1, 0), 'date'), '前天');
  assert.equal(w(L(2026, 11, 8, 1, 0), 'date'), '周日（11/8）');
  assert.equal(w(L(2026, 10, 31, 1, 0), 'date'), '10/31');
});

test('时区：同一刻在东八区是今晚，在 UTC 是今天下午', () => {
  const t = L(2026, 11, 11, 21, 39);
  assert.equal(zhWhen(t, NOW, { tzOffsetMin: 0, agoH: 0 }), '今天下午 13:39');
  assert.equal(zhWhen(t, NOW, { tzOffsetMin: TZ, agoH: 0 }), '今晚 21:39');
});

test('「现在」那一句写全年月日、星期几和时段；时长', () => {
  assert.equal(zhNow(NOW, { tzOffsetMin: TZ }), '2026-11-11（周三）晚上 22:00');
  assert.equal(zhNow(L(2026, 1, 1, 8, 5), { tzOffsetMin: TZ }), '2026-01-01（周四）上午 8:05');
  assert.equal(zhSpan(4 * D + 2 * H), '4 天');
  assert.equal(zhSpan(20 * MIN), '20 分钟');
  assert.equal(zhSpan(21 * D), '3 周');
});

test('别的语言退回和语言无关的绝对时间；不认识的 locale 也一样', () => {
  assert.equal(undWhen(L(2026, 11, 11, 21, 39), NOW, { tzOffsetMin: TZ }), '11-11 21:39');
  assert.equal(undWhen(L(2025, 11, 11, 21, 39), NOW, { tzOffsetMin: TZ }), '2025-11-11 21:39');
  assert.equal(undWhen(L(2026, 11, 11, 21, 39), NOW, { tzOffsetMin: TZ, style: 'date' }), '11-11');
  assert.equal(phrasingFor('zh-CN').when, zhWhen);
  assert.equal(phrasingFor('x-abc').when, undWhen);
});

test('注册表：按 selfProfile.locale 选，时区、agoH 从配置取；出错返回空字符串', () => {
  const mk = (locale, cfg = {}) => ({
    ports: { selfProfile: { locale } }, now: () => NOW,
    config: { get: () => ({ time: { tzOffsetMin: TZ }, lang: { timePhrase: { agoH: 3 } }, ...cfg }) },
  });
  assert.equal(describeTime(mk('zh'), L(2026, 11, 11, 21, 39)), '今晚 21:39 · 21 分钟前');
  assert.equal(describeTime(mk('zh'), L(2026, 11, 11, 21, 39), { style: 'day' }), '今晚 21:39');
  assert.equal(describeTime(mk('zh', { lang: { timePhrase: { agoH: 0 } } }), L(2026, 11, 11, 21, 39)), '今晚 21:39', 'agoH = 0：不说「多久以前」');
  assert.equal(describeTime(mk('fr'), L(2026, 11, 11, 21, 39)), '11-11 21:39');
  assert.equal(describeNow(mk('zh')), '2026-11-11（周三）晚上 22:00');
  assert.equal(describeSpan(mk('zh'), 4 * D), '4 天');
  assert.equal(describeTime({ ports: {}, now: () => { throw new Error('x'); }, config: { get: () => ({}) } }, 1), '');
});
