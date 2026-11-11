// 回忆（D155）在上下文这一层：「找了哪儿」那一行的各种情况、回忆这一层的先后（名额按 pick、展示按时间）、打包时这一层的名额。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { recollectNote, recollectOrder, NOTE_MAX } from '../../src/context/recollect.js';
import { pack } from '../../src/context/pack.js';
import { describeRange } from '../../src/lang/index.js';
import { DEFAULTS } from '../../src/config/defaults.js';

const H = 3_600_000;
const DAY = 24 * H;
const TZ = 480;
// 本地 2026-11-11 22:00
const NOW = Date.UTC(2026, 10, 11, 14, 0, 0);
const TODAY = Date.UTC(2026, 10, 10, 16, 0, 0);   // 本地 11-11 0 点

/** 够用的核心替身：真的 lang.describeRange，场合、人按表查。 */
function fakeCore({ settings = {}, people = {}, principalLabel = '主人' } = {}) {
  const core = {
    now: () => NOW,
    config: { get: () => ({ ...DEFAULTS, time: { tzOffsetMin: TZ } }) },
    ports: { selfProfile: { locale: 'zh', principalLabel: () => principalLabel } },
    store: { get: (sql, id) => (/FROM entities/.test(sql) ? people[id] ?? null : /entity_names/.test(sql) ? (people[id]?.name ? { text_raw: people[id].name } : null) : null) },
    mods: {
      lang: { describeRange: (c, a, b, o) => describeRange(core, a, b, o) },
      intake: {
        settingByKey: (c, k) => settings[k] ?? null,
        labelForPrompt: (c, l) => l,
        sanitizeForPrompt: (c, t) => t,
      },
    },
  };
  return core;
}

const rcOf = (o = {}) => ({
  tier: { kind: 'auto', maxItems: 18, itemChars: 240, totalChars: 2000 },
  fallback: null,
  intent: { aboutEntityIds: [2], timeWindows: [{ start: TODAY, end: TODAY + DAY - 1 }], settingKeys: [], shape: 'timeline', cues: ['主人今天吃了什么'], from: {} },
  scope: { given: { time: true, about: true, where: false }, counts: { episodes: 41, assertions: 10, windows: 30 }, total: 81, clipped: false, found: 60, searched: true },
  segments: [
    { start: TODAY, end: TODAY + 8 * H, total: 4 }, { start: TODAY + 8 * H, end: TODAY + 12 * H, total: 10 },
    { start: TODAY + 12 * H, end: TODAY + 18 * H, total: 30 }, { start: TODAY + 18 * H, end: NOW, total: 37 },
  ],
  ...o,
});

test('「找了哪儿」：时间、关于谁、所有场合；范围里多少、给了多少、哪些时段还有没给的；不含记忆内容', () => {
  const core = fakeCore({ people: { 2: { authority: 'principal', is_self: 0, name: '某个网名' } } });
  const given = [{ ref: 'e1', t: TODAY + 13 * H }, { ref: 'e2', t: TODAY + 19 * H }, { ref: 'e3', t: TODAY + 20 * H }];
  const note = recollectNote(core, rcOf(), { given, key: 'k-here', at: NOW, placeOk: () => false });
  assert.equal(note, '找的是：今天（11/11） · 和主人有关的 · 所有场合；范围里 81 条记忆（41 段经历），下面给了 3 条；中午 12:00–18:00 还有 29 条，晚上 18:00–22:00 还有 35 条没展开');
  assert.ok([...note].length <= NOTE_MAX);
});

test('「找了哪儿」：没有圈范围、范围是空的、没能细找、场合说得出 / 说不出名字', () => {
  const core = fakeCore({ settings: { 'k-g': { label: '读书会', labelKind: 'name' }, 'k-x': { label: '某个群', labelKind: 'name' } }, people: { 5: { authority: 'none', is_self: 0, name: '阿明' } } });
  const at = NOW;
  assert.equal(recollectNote(core, rcOf({ scope: null, intent: { aboutEntityIds: [], timeWindows: [], settingKeys: [] } }), { given: [], key: 'k', at, placeOk: () => true }),
    '没有限定时间和人，是按话题在全部记忆里找的');
  assert.match(recollectNote(core, rcOf({ scope: null, fallback: 'timeout' }), { given: [{ ref: 'a', t: null }], key: 'k', at, placeOk: () => true }),
    /^这次没能按时间、人在范围里细找，下面 1 条是按话题在全部记忆里找的$/u);
  const empty = rcOf({ scope: { given: { time: true }, counts: { episodes: 0, assertions: 0, windows: 0 }, total: 0, clipped: false, found: 0, searched: false } });
  assert.match(recollectNote(core, empty, { given: [], key: 'k', at, placeOk: () => true }), /；范围里没有记忆，下面是按话题在全部记忆里找的$/u);
  const where = rcOf({ intent: { aboutEntityIds: [5], timeWindows: [], settingKeys: ['k-g', 'k-x', 'k'], cues: [] }, segments: [] });
  const n = recollectNote(core, where, { given: [], key: 'k', at, placeOk: (sk) => sk === 'k-g' });
  assert.match(n, /^找的是：和阿明有关的 · 在「读书会」、这里；/u, '说不出名字的场合不写');
  const notSearched = rcOf({ scope: { ...rcOf().scope, searched: false } });
  assert.match(recollectNote(core, notSearched, { given: [{ ref: 'a', t: null }], key: 'k', at, placeOk: () => true }), /这次没能在里面细找，下面 1 条是按话题在全部记忆里找的$/u);
});

test('回忆这一层的先后：名额按 pick，有时间窗时展示从早到晚，没有时按 pick', () => {
  const routed = [{ ref: 'a', layer: 'recollect' }, { ref: 'b', layer: 'recollect' }, { ref: 'c', layer: 'recentFromPresent' }, { ref: 'd', layer: 'recollect' }];
  const by = new Map([['a', { recollect: { pick: 0, t: 300 } }], ['b', { recollect: { pick: 1, t: 100 } }], ['d', { recollect: { pick: 2, t: null } }]]);
  const timed = recollectOrder(routed, by, { timed: true });
  assert.deepEqual([...timed.entries()].sort((x, y) => x[1].order - y[1].order).map(([r]) => r), ['b', 'a', 'd']);
  assert.deepEqual(timed.get('a').alloc, 0);
  assert.ok(!timed.has('c'));
  const plain = recollectOrder(routed, by, { timed: false });
  assert.deepEqual([...plain.entries()].sort((x, y) => x[1].order - y[1].order).map(([r]) => r), ['a', 'b', 'd']);
});

test('打包：回忆这一层按这一档的条数和总字数，有自己的预算（不占整块上限）；名额按 alloc 分、展示按 order', () => {
  const cfg = DEFAULTS;
  const e = (i, chars, order, alloc) => ({ ref: `e${i}`, layer: 'recollect', verdict: 'share', rendered: 'x'.repeat(chars), provenance: '', confidence: 1,
    appraisalRef: `ap${i}`, group: `r:e${i}`, order, alloc });
  // 20 条、每条 150 字：整块上限 900 放不下，回忆这一层按自己的 2000 字、18 条装
  const entries = Array.from({ length: 20 }, (_, i) => e(i + 1, 150, (20 - i) * 10, i));
  const items = pack(entries, { cfg, mode: 'deliberate', sent: new Set(), budgetChars: 900, budget: { dayUsed: 0, dayLimit: Infinity, rollingLeft: Infinity },
    recollectTier: { kind: 'auto', maxItems: 18, itemChars: 240, totalChars: 2000 } });
  assert.equal(items.length, 13, '2000 字装 13 条（150 字一条）');
  assert.deepEqual(items.map((x) => x.id).sort(), Array.from({ length: 13 }, (_, i) => `e${i + 1}`).sort(), '名额按 alloc：先分到的是 pick 靠前的');
  assert.deepEqual(items.map((x) => x.id), Array.from({ length: 13 }, (_, i) => `e${13 - i}`), '展示按 order（时间）');
  const small = pack(entries, { cfg, mode: 'deliberate', sent: new Set(), budgetChars: 900, budget: { dayUsed: 0, dayLimit: Infinity, rollingLeft: Infinity },
    recollectTier: { kind: 'auto', maxItems: 4, itemChars: 240, totalChars: 1000 } });
  assert.equal(small.length, 4, '节省档：条数减半那一档');
  // 每天的额度用完了：被问到时的回忆照样给（和想起来的同一档）
  const over = pack(entries, { cfg, mode: 'deliberate', sent: new Set(), budgetChars: 900, budget: { dayUsed: 10, dayLimit: 5, rollingLeft: Infinity },
    recollectTier: { kind: 'auto', maxItems: 4, itemChars: 240, totalChars: 1000 } });
  assert.equal(over.length, 4);
});

test('注入记录：回忆的意图和范围的摘要记进已有的 scores_json（不加迁移）；不是对象、太长的拒收', async () => {
  const { createTestCore } = await import('../fakes/index.js');
  const { core, cleanup } = await createTestCore({ name: 'recollect-inject' });
  try {
    const log = { kind: 'tool', given: 0, intent: { about: 1, windows: [[1, 2]] }, scope: { total: 5 } };
    core.mods.context.recordInjection(core, { sessionId: 'sess-rc', nonce: 'nonce-rc-1', layer: 'memory_recall', items: [], chars: 10, mode: 'live', recollect: log });
    const row = core.store.get("SELECT scores_json FROM injections WHERE nonce = 'nonce-rc-1'");
    assert.deepEqual(JSON.parse(row.scores_json), { recollect: log });
    core.mods.context.recordInjection(core, { sessionId: 'sess-rc', nonce: 'nonce-rc-2', layer: 'block', items: [], chars: 10, mode: 'live' });
    assert.equal(core.store.get("SELECT scores_json FROM injections WHERE nonce = 'nonce-rc-2'").scores_json, null, '浮现的块照旧没有');
    assert.throws(() => core.mods.context.recordInjection(core, { sessionId: 'sess-rc', nonce: 'nonce-rc-3', layer: 'block', items: [], chars: 1, mode: 'live', recollect: [1] }), /recollect/);
    assert.throws(() => core.mods.context.recordInjection(core, { sessionId: 'sess-rc', nonce: 'nonce-rc-4', layer: 'block', items: [], chars: 1, mode: 'live', recollect: { x: 'y'.repeat(5000) } }), /recollect/);
  } finally { await cleanup(); }
});
