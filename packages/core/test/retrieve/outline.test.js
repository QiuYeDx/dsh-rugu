// 「那段时间的经过」和同一件事合并（D156）：梗概行的一句话（上下文头去掉开头的日期、头为空的顶替）、选行（按段轮流、段内按对题程度、
// 没有事件情节的那段用小结补、范围很大时先给日记和小结）、经过占的字数看形状；合并该合的合、不该合的不合。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCore, seedEntity, seedPercept, seedSetting, seedEpisode, seedWindow, T0, MIN, HOUR, DAY } from './fixtures.js';
import { outlineText, outlineRows, firstSentence } from '../../src/retrieve/outline.js';
import { groupSame } from '../../src/retrieve/merge.js';
import { shareOf } from '../../src/retrieve/recollect.js';
import { cutSpan } from '../../src/retrieve/recollect-util.js';
import { zhStripDate } from '../../src/lang/when.js';

const lang = { stripLeadingDate: (core, t) => zhStripDate(t) };
const Y = Math.floor(T0 / DAY) * DAY - DAY;
const rowsOf = (core, ids) => ids.map((id) => {
  const r = core.store.get('SELECT id, t_start, t_end, setting_key FROM episodes WHERE id = ?', id);
  return { ref: `e${r.id}`, tStart: r.t_start, tEnd: r.t_end, settingKey: r.setting_key };
});

test('梗概行的一句话：上下文头去掉开头的完整日期（带时段、「起」的也去）；头为空用「标题：叙述的第一句」；头里只有日期当空的', async () => {
  const { core, cleanup } = await retrieveCore({ mods: { lang } });
  try {
    assert.equal(outlineText(core, { header: '2026-11-11 17:30，阿明在群里说晚饭吃了拉面' }), '阿明在群里说晚饭吃了拉面');
    assert.equal(outlineText(core, { header: '2026-11-09 22:29 到 22:40，她给阿明发了视频' }), '她给阿明发了视频');
    assert.equal(outlineText(core, { header: '2026-11-11 16:38 起，我和阿明聊游戏' }), '我和阿明聊游戏');
    assert.equal(outlineText(core, { header: '2026-10-31T18:00，阿明说去拿快递' }), '阿明说去拿快递');
    assert.equal(outlineText(core, { header: '下午阿明说了一句话' }), '下午阿明说了一句话', '开头不是日期：原样');
    assert.equal(outlineText(core, { header: '', title: '中午吃饭', narrative: '阿明说中午吃了面。后来又聊了别的。' }), '中午吃饭：阿明说中午吃了面。');
    assert.equal(outlineText(core, { header: '2026-11-01', title: '打招呼', narrative: '' }), '打招呼');
    assert.equal(firstSentence('没有句号的一句'), '没有句号的一句');
  } finally { await cleanup(); }
});

test('选行：按段轮流取，段内按对题程度（没检索到的排在后面、按时间均匀取）；某一段没有事件情节时用那段时间的小结补', async () => {
  const { core, cleanup } = await retrieveCore({ mods: { lang } });
  try {
    seedSetting(core, 'G', { label: '群' });
    const ep = (h, kind = 'event') => seedEpisode(core, { settingKey: 'G', header: `第${h}点的事`, tStart: Y + h * HOUR, tEnd: Y + h * HOUR + 10 * MIN, epKind: kind });
    const morning = [ep(8), ep(9), ep(10)];
    const noonSummary = ep(13, 'summary');        // 中午这一段只有小结
    const evening = [ep(19), ep(20), ep(21)];
    const morningSummary = ep(9.5, 'summary');     // 上午有事件情节，小结不用
    const scope = { rows: rowsOf(core, [...morning, noonSummary, ...evening, morningSummary]) };
    const span = { start: Y + 6 * HOUR, end: Y + 24 * HOUR };
    const segments = cutSpan(span, 3);             // 6–12、12–18、18–24
    const ranks = new Map([[`e${evening[2]}`, 1], [`e${morning[1]}`, 2]]);
    const got = outlineRows(core, scope, { ranks, segments, span, max: 5 });
    const refs = got.map((x) => x.ref);
    assert.deepEqual(refs.slice(0, 3), [`e${morning[1]}`, `e${noonSummary}`, `e${evening[2]}`], '每段先给一条：上午、中午（小结补）、晚上，段内名次在前');
    assert.ok(!refs.includes(`e${morningSummary}`), '上午有事件情节，小结不补');
    assert.equal(got.length, 5);
    assert.equal(outlineRows(core, scope, { ranks, segments, span, max: 0 }).length, 0);
  } finally { await cleanup(); }
});

test('选行：范围跨了好几天时先给日记，没有日记的那天给小结，日记、小结都没有的那天才用事件情节', async () => {
  const { core, cleanup } = await retrieveCore({ mods: { lang } });
  try {
    seedSetting(core, 'G', { label: '群' });
    const at = (d, h) => Y - d * DAY + h * HOUR;
    const mk = (d, h, kind) => seedEpisode(core, { settingKey: 'G', header: `${kind}${d}`, tStart: at(d, h), tEnd: at(d, h) + 10 * MIN, epKind: kind });
    const diary5 = mk(5, 23, 'diary');
    const sum5 = mk(5, 12, 'summary');
    const sum4 = mk(4, 12, 'summary');
    const ev4 = mk(4, 9, 'event');
    const ev3 = mk(3, 9, 'event');
    const scope = { rows: rowsOf(core, [diary5, sum5, sum4, ev4, ev3]) };
    const got = outlineRows(core, scope, { max: 10, dayLayerDays: 1 }).map((x) => x.ref);
    assert.ok(got.includes(`e${diary5}`) && got.includes(`e${sum4}`) && got.includes(`e${ev3}`), JSON.stringify(got));
    assert.ok(!got.includes(`e${sum5}`), '有日记的那天不再给小结');
    assert.ok(!got.includes(`e${ev4}`), '有小结的那天不给事件情节');
  } finally { await cleanup(); }
});

test('经过占的字数看形状：timeline 七成、point 两成、判断不出来一半；配置里写的照用', () => {
  const share = { timeline: 0.7, point: 0.2, none: 0.5 };
  assert.equal(shareOf(share, 'timeline'), 0.7);
  assert.equal(shareOf(share, 'point'), 0.2);
  assert.equal(shareOf(share, null), 0.5);
  assert.equal(shareOf(share, 'roster'), 0.5);
  assert.equal(shareOf({ timeline: 0.9 }, 'timeline'), 0.9);
  assert.equal(shareOf({}, 'point'), 0.2, '没配置按默认');
});

test('合并：同一张图发到几个场合（时间接近、向量很像）合成一组，展示带「看到的」说明的那条；时间隔得远、内容不像、种类不同、相邻窗口只重叠几句的都不合', async () => {
  const env = await retrieveCore({ mods: { lang } });
  const { core, worker, cleanup } = env;
  try {
    seedSetting(core, 'A', { label: '群A' });
    seedSetting(core, 'B', { label: '群B' });
    const ep = (k, h, narrative) => seedEpisode(core, { settingKey: k, narrative, tStart: Y + h * HOUR, tEnd: Y + h * HOUR + 5 * MIN });
    const e1 = ep('A', 12, '阿明发了一碗牛肉面的图');
    const e2 = ep('B', 12.05, '阿明发了一碗牛肉面的图，我看到的：一碗牛肉面，上面很多香菜');
    const e3 = ep('A', 18, '阿明发了一碗牛肉面的图');           // 同样的话，隔了六个小时：另一件事
    const e4 = ep('B', 12.1, '大家在聊明天的考试');               // 时间接近，内容不像
    for (const [id, t] of [[e1, '牛肉面 图'], [e2, '牛肉面 图'], [e3, '牛肉面 图'], [e4, '考试 明天']]) worker.addDoc(`e${id}`, t);
    // 相邻的两个原文窗口有一句重叠：不合
    const p = [1, 2, 3, 4, 5].map((i) => seedPercept(core, { settingKey: 'A', at: Y + 11 * HOUR + i * MIN, text: `第${i}句` }));
    const w1 = seedWindow(core, { settingKey: 'A', first: p[0], last: p[2], tStart: Y + 11 * HOUR, tEnd: Y + 11 * HOUR + 3 * MIN, text: '前三句' });
    const w2 = seedWindow(core, { settingKey: 'A', first: p[2], last: p[4], tStart: Y + 11 * HOUR + 3 * MIN, tEnd: Y + 11 * HOUR + 5 * MIN, text: '后三句' });
    core.store.run('UPDATE raw_windows SET members_json = ? WHERE id = ?', JSON.stringify([p[0], p[1], p[2]]), w1);
    core.store.run('UPDATE raw_windows SET members_json = ? WHERE id = ?', JSON.stringify([p[2], p[3], p[4]]), w2);
    const meta = (ref, t0, t1, text, kind) => ({ ref, meta: { kind, tStart: t0, tEnd: t1, text } });
    const list = [
      meta(`e${e1}`, Y + 12 * HOUR, Y + 12 * HOUR + 5 * MIN, '阿明发了一碗牛肉面的图', 'episode'),
      meta(`e${e2}`, Y + 12.05 * HOUR, Y + 12.05 * HOUR + 5 * MIN, '阿明发了一碗牛肉面的图，我看到的：一碗牛肉面，上面很多香菜', 'episode'),
      meta(`e${e3}`, Y + 18 * HOUR, Y + 18 * HOUR + 5 * MIN, '阿明发了一碗牛肉面的图', 'episode'),
      meta(`e${e4}`, Y + 12.1 * HOUR, Y + 12.1 * HOUR + 5 * MIN, '大家在聊明天的考试', 'episode'),
      meta(`w${w1}`, Y + 11 * HOUR, Y + 11 * HOUR + 3 * MIN, '前三句', 'window'),
      meta(`w${w2}`, Y + 11 * HOUR + 3 * MIN, Y + 11 * HOUR + 5 * MIN, '后三句', 'window'),
    ];
    const groups = await groupSame(core, list, { gapMin: 15, minSim: 0.9, minOverlap: 0.5 });
    assert.equal(groups.length, 5, JSON.stringify(groups.map((g) => [g.rep.ref, g.others])));
    const g = groups.find((x) => x.others.length);
    assert.equal(g.rep.ref, `e${e2}`, '展示带「看到的」说明的那条');
    assert.deepEqual(g.others, [`e${e1}`]);
  } finally { await cleanup(); }
});

test('合并：一段事件情节和盖住它的那段时间的小结（来源是同一批原话）合成一组；种类不同（情节和它里面的原文窗口）不合', async () => {
  const { core, cleanup } = await retrieveCore({ mods: { lang } });
  try {
    seedSetting(core, 'A', { label: '群A' });
    const p = [1, 2, 3].map((i) => seedPercept(core, { settingKey: 'A', at: Y + 12 * HOUR + i * MIN, text: `第${i}句` }));
    const ev = seedEpisode(core, { settingKey: 'A', narrative: '中午阿明说吃了面', tStart: Y + 12 * HOUR, tEnd: Y + 12 * HOUR + 3 * MIN });
    const sum = seedEpisode(core, { settingKey: 'A', narrative: '中午和大家聊了吃饭、考试和天气，阿明说吃了面', tStart: Y + 11 * HOUR, tEnd: Y + 13 * HOUR, epKind: 'summary' });
    for (const id of p) core.store.run('UPDATE percepts SET episode_id = ? WHERE id = ?', ev, id);
    for (const id of p) core.store.run("INSERT INTO sources(owner_kind, owner_id, percept_id, mode, at, confidence) VALUES ('episode', ?, ?, 'observed', ?, 0.9)", sum, id, Y + 12 * HOUR);
    const w = seedWindow(core, { settingKey: 'A', first: p[0], last: p[2], tStart: Y + 12 * HOUR, tEnd: Y + 12 * HOUR + 3 * MIN, text: '三句' });
    core.store.run('UPDATE raw_windows SET members_json = ? WHERE id = ?', JSON.stringify(p), w);
    const list = [
      { ref: `e${ev}`, meta: { kind: 'episode', tStart: Y + 12 * HOUR, tEnd: Y + 12 * HOUR + 3 * MIN, text: '中午阿明说吃了面' } },
      { ref: `e${sum}`, meta: { kind: 'episode', tStart: Y + 11 * HOUR, tEnd: Y + 13 * HOUR, text: '中午和大家聊了吃饭、考试和天气，阿明说吃了面' } },
      { ref: `w${w}`, meta: { kind: 'window', tStart: Y + 12 * HOUR, tEnd: Y + 12 * HOUR + 3 * MIN, text: '三句' } },
    ];
    const groups = await groupSame(core, list, { gapMin: 15, minSim: 0.9, minOverlap: 0.5 });
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].others.length + groups[1].others.length, 1);
    assert.ok(groups.some((g) => g.rep.ref === `w${w}` && !g.others.length), '原文窗口自成一组');
  } finally { await cleanup(); }
});
