// 时间表达解析（§6.6、§8.1「时间表达」、§8.2 时间路）：「昨天、上周、那天晚上、10/31、晚上八点」等解析成绝对时间窗，
// 本地时间按 config.time.tzOffsetMin（D19），说不准的给多个候选，不替说话的人做决定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createZhAnalyzer, createUnicodeAnalyzer } from '../../src/lang/index.js';
import { withLang, AT, L, D, H, M, TZ, show } from './helpers.js';

const zhP = createZhAnalyzer({ jieba: false, tzOffsetMin: TZ });
const one = (ws, label) => {
  assert.equal(ws.length, 1, `${label}：应只有一个窗口，实际 ${ws.map(show).join(' | ')}`);
  return ws[0];
};
const win = (ws, start, end, precision, label) => {
  const w = one(ws, label);
  assert.equal(w.start, start, `${label} 起点：${show(w)}`);
  assert.equal(w.end, end, `${label} 终点：${show(w)}`);
  if (precision) assert.equal(w.precision, precision, `${label} 精度`);
  return w;
};

test('契约里点名的五种：昨天、上周、那天晚上、10/31、晚上八点', async () => {
  const zh = await zhP;
  win(zh.parseTime('昨天', AT), L(2026, 10, 30), L(2026, 10, 31), 'day', '昨天');
  win(zh.parseTime('上周', AT), L(2026, 10, 19), L(2026, 10, 26), 'week', '上周');   // 周一是一周的第一天
  // 「那天晚上」是回指：单看一句话定不下是哪天，给一个宽的过去窗口（fuzzy），覆盖最近的晚上
  const w = one(zh.parseTime('那天晚上', AT), '那天晚上');
  assert.equal(w.precision, 'fuzzy');
  assert.ok(w.end <= AT && w.start <= L(2026, 10, 30, 18) && w.end >= L(2026, 10, 30, 23), show(w));
  win(zh.parseTime('10/31', AT), L(2026, 10, 31), L(2026, 11, 1), 'day', '10/31');
  win(zh.parseTime('晚上八点', AT), L(2026, 10, 31, 20), L(2026, 10, 31, 21), 'exact', '晚上八点');
  // 命中的文字带回来（渲染「你说的那天」时用）
  assert.equal(zh.parseTime('我们晚上八点见', AT)[0].text, '晚上八点');
});

test('日子 + 时段 + 钟点合成一组：昨天晚上八点、今晚、明早', async () => {
  const zh = await zhP;
  win(zh.parseTime('昨天晚上八点他打电话来了', AT), L(2026, 10, 30, 20), L(2026, 10, 30, 21), 'exact', '昨天晚上八点');
  win(zh.parseTime('今晚', AT), L(2026, 10, 31, 18), L(2026, 11, 1), 'day', '今晚');
  win(zh.parseTime('明早', AT), L(2026, 11, 1, 5), L(2026, 11, 1, 10), 'day', '明早');
  win(zh.parseTime('10月31号晚上', AT), L(2026, 10, 31, 18), L(2026, 11, 1), 'day', '10月31号晚上');
  win(zh.parseTime('前天下午3点', AT), L(2026, 10, 29, 15), L(2026, 10, 29, 16), 'exact', '前天下午3点');
});

test('星期：上周六、下周六、这周三；光说「周三」给上一个和下一个', async () => {
  const zh = await zhP;
  win(zh.parseTime('上周六', AT), L(2026, 10, 24), L(2026, 10, 25), 'day', '上周六');
  win(zh.parseTime('下周六', AT), L(2026, 11, 7), L(2026, 11, 8), 'day', '下周六');
  win(zh.parseTime('这周三', AT), L(2026, 10, 28), L(2026, 10, 29), 'day', '这周三');
  const bare = zh.parseTime('周三', AT);
  assert.deepEqual(bare.map((w) => w.start), [L(2026, 10, 28), L(2026, 11, 4)], bare.map(show).join(' | '));
  // 今天就是周六：给今天
  win(zh.parseTime('星期六', AT), L(2026, 10, 31), L(2026, 11, 1), 'day', '星期六');
  win(zh.parseTime('上个周末', AT), L(2026, 10, 24), L(2026, 10, 26), 'week', '上个周末');
});

test('相对：三天前、两个小时前、最近、前几天、上个月底、去年', async () => {
  const zh = await zhP;
  win(zh.parseTime('三天前', AT), L(2026, 10, 28), L(2026, 10, 29), 'day', '三天前');
  const h2 = one(zh.parseTime('两个小时前', AT), '两个小时前');
  assert.ok(h2.start <= AT - 2 * H && h2.end >= AT - 2 * H && h2.end < AT, show(h2));
  const recent = one(zh.parseTime('最近', AT), '最近');
  assert.equal(recent.end, AT);
  assert.equal(recent.start, AT - 7 * D);   // lang.time.recentDays 的兜底 7 天
  const few = one(zh.parseTime('前几天', AT), '前几天');
  assert.ok(few.start < L(2026, 10, 30) && few.end === L(2026, 10, 31), show(few));
  win(zh.parseTime('上个月底', AT), L(2026, 9, 21), L(2026, 10, 1), 'fuzzy', '上个月底');
  win(zh.parseTime('去年', AT), L(2025, 1, 1), L(2026, 1, 1), 'fuzzy', '去年');
  win(zh.parseTime('2025年10月', AT), L(2025, 10, 1), L(2025, 11, 1), 'month', '2025年10月');
});

test('说不准的给多个候选：没有时段的「八点」给 8 点和 20 点', async () => {
  const zh = await zhP;
  const ws = zh.parseTime('八点', AT);
  assert.deepEqual(ws.map((w) => w.start), [L(2026, 10, 31, 8), L(2026, 10, 31, 20)], ws.map(show).join(' | '));
  // 有时段就只给一个
  assert.equal(zh.parseTime('早上八点', AT).length, 1);
  assert.equal(zh.parseTime('早上八点', AT)[0].start, L(2026, 10, 31, 8));
});

test('区间：明天下午三点到五点', async () => {
  const zh = await zhP;
  const w = one(zh.parseTime('明天下午三点到五点', AT), '区间');
  assert.equal(w.start, L(2026, 11, 1, 15));
  assert.ok(w.end >= L(2026, 11, 1, 17) && w.end <= L(2026, 11, 1, 18), show(w));
});

test('不把普通的词当成时间：以前天天、如今天下、一点也不', async () => {
  const zh = await zhP;
  for (const t of ['我以前天天跑步', '如今天下太平', '一点也不好笑', '他是1号线的司机', '你好呀']) {
    assert.deepEqual(zh.parseTime(t, AT), [], t);
  }
  assert.deepEqual(zh.parseTime('', AT), []);
  assert.deepEqual(zh.parseTime('昨天', NaN), []);
});

test('年份就近：跨年时「10/31」指刚过去的那个', async () => {
  const zh = await zhP;
  const jan = L(2027, 1, 2, 12);
  win(zh.parseTime('10/31', jan), L(2026, 10, 31), L(2026, 11, 1), 'day', '跨年');
  win(zh.parseTime('1/5', jan), L(2027, 1, 5), L(2027, 1, 6), 'day', '近处的未来');
});

test('时区：同一句话按 tzOffsetMin 换算（UTC 偏移 0 vs 东八区）', async () => {
  const utc = await createZhAnalyzer({ jieba: false, tzOffsetMin: 0 });
  // 2026-10-31 10:00 UTC：UTC 里的「昨天」是 10-30 整天（UTC）
  win(utc.parseTime('昨天', AT), Date.UTC(2026, 9, 30), Date.UTC(2026, 9, 31), 'day', 'UTC 昨天');
  const zh = await zhP;
  assert.notEqual(zh.parseTime('昨天', AT)[0].start, utc.parseTime('昨天', AT)[0].start);
});

test('registry.parseTime 每次从 config.time.tzOffsetMin 取偏移（热加载）', () => withLang((core) => {
  const reg = core.mods.lang.registry(core);
  win(reg.parseTime('昨天', AT, 'zh'), L(2026, 10, 30), L(2026, 10, 31), 'day', '东八区');
  core.config.update({ time: { tzOffsetMin: 0 } });
  win(reg.parseTime('昨天', AT, 'zh'), Date.UTC(2026, 9, 30), Date.UTC(2026, 9, 31), 'day', '改成 UTC 后');
  // 自动检测语言：中文走 zh
  assert.equal(reg.parseTime('昨天晚上', AT).length, 1);
}));

test('tzOffsetMin = null 时用本机时区（和 Date 的本地时间一致）', async () => {
  const local = await createZhAnalyzer({ jieba: false, tzOffsetMin: null });
  const [w] = local.parseTime('昨天', AT);
  const d = new Date(AT);
  const expect = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
  assert.equal(w.start, expect);
});

test('und：只认和语言无关的写法（ISO 日期、YYYY/MM/DD、HH:MM）', () => {
  const und = createUnicodeAnalyzer({ tzOffsetMin: TZ });
  win(und.parseTime('see you 2026-11-03', AT), L(2026, 11, 3), L(2026, 11, 4), 'day', 'ISO');
  win(und.parseTime('2026-10-30 20:15', AT), L(2026, 10, 30, 20, 15), L(2026, 10, 30, 20, 30), 'exact', 'ISO + 时间');
  win(und.parseTime('2026/10/29', AT), L(2026, 10, 29), L(2026, 10, 30), 'day', 'YYYY/MM/DD');
  win(und.parseTime('at 21:05', AT), L(2026, 10, 31, 21, 5), L(2026, 10, 31, 21, 5) + 15 * M, 'exact', 'HH:MM');
  assert.deepEqual(und.parseTime('yesterday', AT), []);   // 没有专门分析器的语言不猜
  assert.deepEqual(und.parseTime('2026-02-30', AT), []);  // 不存在的日期
});
