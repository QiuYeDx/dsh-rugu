// 【D159】管理页按时间看记忆：时间筛选、顺序、跳到某个时间 / 某一条、往两头翻（keyset 游标）、按天计数、带条件下推的搜索。
// 数据全是编的；时间用固定的毫秒（不靠测试时钟），按天计数的时区边界用 +480 和 0 两个偏移各算一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../../src/contract/errors.js';
import { adminCore, seedSetting, seedEntity, seedPercept, seedWindow, seedAssertion, seedEpisode } from './fixtures.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** 2026-11-10 00:00 UTC */
const T0 = Date.UTC(2026, 10, 10);

const withCore = (name, fn) => async () => {
  const t = await adminCore(name);
  try { await fn(t.core); } finally { await t.cleanup(); }
};
const L = (core, q) => core.mods.admin.list(core, q);
const refs = (p) => p.items.map((x) => x.ref);
/** 一次全取（limit 200 足够）的顺序。 */
const all = (core, q) => refs(L(core, { ...q, limit: 200 }));

/** 顺着 next 翻到底，再从最后一页顺着 prev 翻回开头：两次拼起来都和一次全取的一样（不重不漏）。 */
function walk(core, q, limit) {
  const pages = [];
  let p = L(core, { ...q, limit });
  pages.push(p);
  while (p.next) { p = L(core, { ...q, limit, next: p.next }); pages.push(p); }
  const forward = pages.flatMap(refs);
  const back = [];
  let b = pages.at(-1);
  back.unshift(...refs(b));
  while (b.prev) { b = L(core, { ...q, limit, prev: b.prev }); back.unshift(...refs(b)); }
  return { forward, back, pages: pages.length };
}

/** 两个场合、两个人，原话跨三天；同一毫秒有三条；最后再回填几条早先的历史消息（id 大、at 早）。 */
function percepts(core) {
  const sk1 = seedSetting(core, { label: '编的读书会' });
  const sk2 = seedSetting(core, { label: '编的球友群' });
  const A = seedEntity(core, { name: '编的阿木' });
  const B = seedEntity(core, { name: '编的小禾' });
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push(seedPercept(core, { settingKey: i % 3 ? sk1 : sk2, actor: i % 2 ? A : B, text: `第 ${i} 句随便聊聊`, at: T0 + i * 2 * HOUR + 7 * MIN }));
  const same = [0, 1, 2].map((k) => seedPercept(core, { settingKey: sk1, actor: A, text: `同一刻 ${k}`, at: T0 + 30 * HOUR }));
  const back = [0, 1, 2].map((k) => seedPercept(core, { settingKey: sk1, actor: B, text: `回填的旧话 ${k}`, at: T0 - DAY + k * HOUR }));
  return { sk1, sk2, A, B, ids, same, back };
}

test('原话按说话的时间排（at, id）：回填的历史消息（id 大、at 早）排在对的位置；同一毫秒多条按 id 稳定', withCore('tl-order', (core) => {
  const d = percepts(core);
  const desc = all(core, { view: 'percepts' });
  assert.equal(desc.length, 36);
  assert.deepEqual(desc.slice(-3), d.back.slice().reverse().map((id) => `p${id}`), '回填的最早，排在新的在前的最后');
  const asc = all(core, { view: 'percepts', order: 'asc' });
  assert.deepEqual(asc, desc.slice().reverse(), '旧的在前正好反过来');
  const i = asc.indexOf(`p${d.same[0]}`);
  assert.deepEqual(asc.slice(i, i + 3), d.same.map((id) => `p${id}`), '同一毫秒按 id 从小到大');
  const items = L(core, { view: 'percepts', order: 'asc', limit: 200 }).items;
  for (let k = 1; k < items.length; k++) assert.ok(items[k].at >= items[k - 1].at, '旧的在前：时间不减');
}));

test('往两头翻：next / prev 拼起来不重不漏、和一次全取一致（两种顺序、带场合、带时间筛选；页大小整除和不整除）', withCore('tl-walk', (core) => {
  const d = percepts(core);
  for (const q of [{ view: 'percepts' }, { view: 'percepts', order: 'asc' }, { view: 'percepts', settingKey: d.sk1 }, { view: 'percepts', entityId: d.A, order: 'asc' },
    { view: 'percepts', from: T0 + 5 * HOUR, to: T0 + 40 * HOUR }]) {
    const full = all(core, q);
    for (const limit of [4, 5, 7]) {
      const w = walk(core, q, limit);
      assert.deepEqual(w.forward, full, `往后翻 ${JSON.stringify(q)} / ${limit}`);
      assert.deepEqual(w.back, full, `往前翻 ${JSON.stringify(q)} / ${limit}`);
    }
  }
  const first = L(core, { view: 'percepts', limit: 5 });
  assert.equal(first.prev, undefined, '第一页没有更前面的');
  assert.equal(first.total, 36);
  const second = L(core, { view: 'percepts', limit: 5, next: first.next });
  assert.ok(second.prev, '第二页能往前翻');
}));

test('时间筛选：from / to 闭区间；只给一头也行；total 跟着变', withCore('tl-range', (core) => {
  percepts(core);
  const a = T0 + 2 * HOUR + 7 * MIN; const b = T0 + 10 * HOUR + 7 * MIN;
  const p = L(core, { view: 'percepts', from: a, to: b, limit: 200 });
  assert.equal(p.total, 5, '两头都算');
  assert.ok(p.items.every((x) => x.at >= a && x.at <= b));
  assert.equal(L(core, { view: 'percepts', to: T0 - 1 }).total, 3, '只给 to：回填的那三条');
  assert.equal(L(core, { view: 'percepts', from: T0 + 30 * HOUR }).total, 3 + 15, '只给 from');
}));

test('跳到某个时间（around）：离它最近的一条做锚点，前后各约半页，两个方向都能接着翻；锚点被筛选范围夹住时说明是哪一头', withCore('tl-around', (core) => {
  const d = percepts(core);
  const full = all(core, { view: 'percepts' });
  const target = T0 + 20 * HOUR + 40 * MIN;   // 最近的是 T0 + 20h + 7m（第 10 句）
  const p = L(core, { view: 'percepts', around: target, limit: 10 });
  assert.equal(p.anchor.ref, `p${d.ids[10]}`);
  assert.equal(p.anchor.exact, false);
  assert.equal(p.items[p.anchor.index].ref, `p${d.ids[10]}`);
  assert.equal(p.anchor.index, 5, '前面半页');
  assert.equal(p.items.length, 10);
  const at = full.indexOf(`p${d.ids[10]}`);
  assert.deepEqual(refs(p), full.slice(at - 5, at + 5), '就是全表里锚点前后的那一段');
  // 两个方向接着翻
  const up = L(core, { view: 'percepts', limit: 10, prev: p.prev });
  assert.deepEqual(refs(up), full.slice(Math.max(0, at - 15), at - 5));
  const down = L(core, { view: 'percepts', limit: 10, next: p.next });
  assert.deepEqual(refs(down), full.slice(at + 5, at + 15));
  // 正好这一刻
  const ex = L(core, { view: 'percepts', around: T0 + 4 * HOUR + 7 * MIN, order: 'asc', limit: 6 });
  assert.equal(ex.anchor.exact, true);
  assert.equal(ex.items[ex.anchor.index].at, T0 + 4 * HOUR + 7 * MIN);
  // near：只取这一刻之前 / 之后的（跳到某一天要落在那一天里）；那一边没有就退回另一边
  const nb = L(core, { view: 'percepts', around: T0 + 20 * HOUR + 6 * MIN, near: 'after', limit: 4 });
  assert.equal(nb.items[nb.anchor.index].ref, `p${d.ids[10]}`);
  const na = L(core, { view: 'percepts', around: T0 + 20 * HOUR + 8 * MIN, near: 'before', limit: 4 });
  assert.equal(na.items[na.anchor.index].ref, `p${d.ids[10]}`);
  const nf = L(core, { view: 'percepts', around: T0 + 100 * DAY, near: 'after', limit: 4 });
  assert.equal(nf.anchor.index, 0, '之后没有：退回之前最近的（最新的那条）');
  // 靠近开头：前面不够半页，后面补满
  const head = L(core, { view: 'percepts', around: T0 + 100 * DAY, limit: 8 });
  assert.equal(head.anchor.index, 0);
  assert.equal(head.prev, undefined);
  assert.equal(head.items.length, 8);
  // 筛选范围夹住
  const lo = T0 + 10 * HOUR; const hi = T0 + 20 * HOUR;
  const c1 = L(core, { view: 'percepts', from: lo, to: hi, around: T0, limit: 4 });
  assert.equal(c1.anchor.clamped, 'from');
  assert.ok(c1.items[c1.anchor.index].at >= lo);
  const c2 = L(core, { view: 'percepts', from: lo, to: hi, around: T0 + 50 * DAY, limit: 4 });
  assert.equal(c2.anchor.clamped, 'to');
  assert.ok(c2.items[c2.anchor.index].at <= hi);
  // 什么都没有
  const none = L(core, { view: 'percepts', settingKey: 'sk-none', around: T0 });
  assert.deepEqual(none.items, []);
  assert.equal(none.anchor, undefined);
}));

test('以一条为锚点（aroundRef）：前后原话；种类不对、没有这条的报错；被筛掉的按它的时间找最近的', withCore('tl-ref', (core) => {
  const d = percepts(core);
  const ref = `p${d.ids[17]}`;
  const p = L(core, { view: 'percepts', aroundRef: ref, settingKey: d.sk1, order: 'asc', limit: 6 });
  assert.equal(p.anchor.ref, ref);
  assert.equal(p.anchor.exact, true);
  assert.equal(p.items[p.anchor.index].ref, ref);
  assert.ok(p.items.every((x) => x.settingKey === d.sk1));
  assert.throws(() => L(core, { view: 'percepts', aroundRef: 'a1' }), ContractError, '别的种类');
  assert.throws(() => L(core, { view: 'percepts', aroundRef: 'p999999' }), ContractError, '没有这条');
  assert.throws(() => L(core, { view: 'checks', aroundRef: 'p1' }), ContractError, '不按某一条定位的列表');
  // 第 0 句在 sk2：按 sk1 筛掉了，退回按时间找 sk1 里最近的
  const off = L(core, { view: 'percepts', aroundRef: `p${d.ids[0]}`, settingKey: d.sk1, limit: 4 });
  assert.equal(off.anchor.exact, false);
  assert.equal(off.items[off.anchor.index].settingKey, d.sk1);
}));

test('乱传的游标按从头开始，不抛错；换了顺序的旧游标不认；offset 游标在按时间的列表里也从头开始', withCore('tl-cursor', (core) => {
  percepts(core);
  const first = refs(L(core, { view: 'percepts', limit: 5 }));
  for (const bad of ['!!!', 'e30', Buffer.from('{"v":1,"t":"x","i":1,"d":"desc"}').toString('base64url'), Buffer.from(JSON.stringify({ o: 10 })).toString('base64url'), 'a'.repeat(500)]) {
    assert.deepEqual(refs(L(core, { view: 'percepts', limit: 5, next: bad })), first, bad.slice(0, 20));
    assert.deepEqual(refs(L(core, { view: 'percepts', limit: 5, prev: bad })), first, bad.slice(0, 20));
  }
  const ascNext = L(core, { view: 'percepts', order: 'asc', limit: 5 }).next;
  assert.deepEqual(refs(L(core, { view: 'percepts', limit: 5, next: ascNext })), first, '旧的在前的游标拿到新的在前里：从头');
  // 按相关排（搜索）用 offset 游标，乱传的照样从头
  const r1 = refs(L(core, { view: 'percepts', q: '随便', limit: 3 }));
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '随便', limit: 3, next: ascNext })), r1);
}));

test('原话能搜：子串第一档、词全在第二档（原话的全文分表），默认最相关；按时间排时第 1 档不受条数上限', withCore('tl-psearch', (core) => {
  const sk = seedSetting(core, { label: '编的小组' });
  const A = seedEntity(core, { name: '编的阿木' });
  const p1 = seedPercept(core, { settingKey: sk, actor: A, text: '我表哥开网约车', at: T0 });
  const p2 = seedPercept(core, { settingKey: sk, actor: A, text: '网约车是我表哥在开', at: T0 + HOUR });
  const p3 = seedPercept(core, { settingKey: sk, actor: A, text: '周末去爬山', at: T0 + 2 * HOUR });
  const p4 = seedPercept(core, { settingKey: sk, actor: A, text: '下个月的表哥', at: T0 + 40 * DAY });   // 另一个月的分表
  const r = L(core, { view: 'percepts', q: '表哥 网约车' });
  assert.equal(r.order, 'rank');
  assert.deepEqual(new Set(refs(r)), new Set([`p${p1}`, `p${p2}`]), '词全在（第 2 档，原话的全文分表）');
  assert.ok(!refs(r).includes(`p${p3}`));
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '在开' })), [`p${p2}`], '子串');
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '网约车' })), [`p${p2}`, `p${p1}`], '子串那一档里新的在前');
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '我表哥开网约车。' })), [`p${p1}`], '规范化以后含整句的（只差标点）算第 1 档');
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '表哥', order: 'asc' })), [`p${p1}`, `p${p2}`, `p${p4}`], '跨月分表都查');
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '表哥', to: T0 + 10 * DAY, order: 'asc' })), [`p${p1}`, `p${p2}`], '带时间条件');
  assert.deepEqual(refs(L(core, { view: 'percepts', q: '100%_' })), [], '% _ 不当通配符');
}));

test('搜索带条件下推：一千多条新的命中不会把范围里旧的那条截掉（rank 和按时间都一样）；按时间排的 total 是全部命中', withCore('tl-pushdown', (core) => {
  const sk = seedSetting(core, { label: '编的大群' });
  const old = seedPercept(core, { settingKey: sk, text: '西瓜好甜', at: T0 - 60 * DAY });
  core.store.tx(() => { for (let i = 0; i < 1005; i++) seedPercept(core, { settingKey: sk, text: `今天又吃西瓜 ${i}`, at: T0 + i * MIN }); });
  const ranked = L(core, { view: 'percepts', q: '西瓜', from: T0 - 61 * DAY, to: T0 - 59 * DAY });
  assert.deepEqual(refs(ranked), [`p${old}`]);
  const asc = L(core, { view: 'percepts', q: '西瓜', order: 'asc', limit: 3 });
  assert.equal(asc.total, 1006, '按时间排：子串那一档是 SQL 条件，不受 1000 条上限');
  assert.equal(asc.items[0].ref, `p${old}`);
  // 事实也一样（assertions 的搜索也改成了带条件下推）
  const a0 = seedAssertion(core, { text: '编的阿木爱吃西瓜', at: T0 - 60 * DAY });
  core.store.tx(() => { for (let i = 0; i < 1003; i++) seedAssertion(core, { text: `西瓜第 ${i} 条`, at: T0 + i * MIN }); });
  assert.deepEqual(refs(L(core, { view: 'assertions', q: '西瓜', to: T0 - DAY })), [`a${a0}`]);
  assert.equal(L(core, { view: 'assertions', q: '西瓜', order: 'asc', limit: 2 }).items[0].ref, `a${a0}`);
}));

test('原文片段能搜（子串）；按 t_end 排，时间筛选和 [t_start, t_end] 相交；经历同理', withCore('tl-windows', (core) => {
  const sk = seedSetting(core, { label: '编的小组' });
  const ps = Array.from({ length: 6 }, (_, i) => seedPercept(core, { settingKey: sk, text: `第 ${i} 句`, at: T0 + i * HOUR }));
  const w1 = seedWindow(core, { settingKey: sk, perceptIds: ps.slice(0, 3), text: '阿木：明天去钓鱼\n她：好呀' });     // T0 .. T0+2h
  const w2 = seedWindow(core, { settingKey: sk, perceptIds: ps.slice(3), text: '小禾：今天好热' });                    // T0+3h .. T0+5h
  assert.deepEqual(refs(L(core, { view: 'windows' })), [`w${w2}`, `w${w1}`]);
  assert.deepEqual(refs(L(core, { view: 'windows', q: '钓鱼' })), [`w${w1}`]);
  assert.deepEqual(refs(L(core, { view: 'windows', from: T0 + HOUR, to: T0 + HOUR })), [`w${w1}`], '相交');
  assert.deepEqual(refs(L(core, { view: 'windows', from: T0 + 2.5 * HOUR, to: T0 + 3.5 * HOUR })), [`w${w2}`]);
  const p = L(core, { view: 'windows', aroundRef: `w${w1}`, order: 'asc' });
  assert.equal(p.anchor.index, 0);
  const e1 = seedEpisode(core, { settingKey: sk, narrative: '编的经历一', at: T0 });
  const e2 = seedEpisode(core, { settingKey: sk, narrative: '编的经历二', at: T0 + DAY });
  assert.deepEqual(refs(L(core, { view: 'episodes', order: 'asc' })), [`e${e1}`, `e${e2}`]);
  assert.deepEqual(refs(L(core, { view: 'episodes', from: T0 + HOUR })), [`e${e2}`]);
  assert.deepEqual(refs(L(core, { view: 'episodes', q: '经历', order: 'desc' })), [`e${e2}`, `e${e1}`]);
}));

test('按天计数：时区边界（23:30 和次日 00:30 在 +480 和 0 下各算哪天）；和列表相同的筛选；first / last；经历算在结束那天', withCore('tl-days', (core) => {
  const sk = seedSetting(core, { label: '编的小组' });
  const sk2 = seedSetting(core, { label: '编的另一组' });
  // +480 下：11-10 23:30 和 11-11 00:30；UTC 下两条都是 11-10（15:30、16:30）
  const a = Date.UTC(2026, 10, 10, 15, 30);
  const b = Date.UTC(2026, 10, 10, 16, 30);
  seedPercept(core, { settingKey: sk, text: '晚安', at: a });
  seedPercept(core, { settingKey: sk, text: '早', at: b });
  seedPercept(core, { settingKey: sk2, text: '别的群', at: Date.UTC(2026, 10, 3, 4) });
  seedPercept(core, { settingKey: sk, text: '上个月', at: Date.UTC(2026, 9, 31, 20) });   // +480 下是 11-01 04:00
  const D = (q) => core.mods.admin.list(core, { view: 'days', of: 'percepts', month: '2026-11', ...q });
  assert.deepEqual(D({ tzOffsetMin: 480 }).items, [{ day: '2026-11-01', n: 1 }, { day: '2026-11-03', n: 1 }, { day: '2026-11-10', n: 1 }, { day: '2026-11-11', n: 1 }]);
  assert.deepEqual(D({ tzOffsetMin: 0 }).items, [{ day: '2026-11-03', n: 1 }, { day: '2026-11-10', n: 2 }], 'UTC 下 10-31 20:00 不在 11 月');
  const s = D({ tzOffsetMin: 480, settingKey: sk });
  assert.deepEqual(s.items.map((x) => x.day), ['2026-11-01', '2026-11-10', '2026-11-11'], '按场合筛');
  assert.equal(s.first, Date.UTC(2026, 9, 31, 20));
  assert.equal(s.last, b);
  assert.deepEqual(D({ tzOffsetMin: 480, q: '晚安' }).items, [{ day: '2026-11-10', n: 1 }], '带搜索');
  assert.deepEqual(D({ tzOffsetMin: 480, from: b }).items, [{ day: '2026-11-11', n: 1 }], '带时间筛选');
  assert.equal(D({ tzOffsetMin: 480, around: a, next: 'x' }).items.length, 4, 'around / 游标不影响计数');
  const empty = core.mods.admin.list(core, { view: 'days', of: 'percepts', month: '2026-12', tzOffsetMin: 480 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.last, b, '这个月没有也给 first / last（月历翻到哪儿）');
  // 经历：算在 t_end 那天
  const e = seedEpisode(core, { settingKey: sk, narrative: '跨夜的一段', at: a });
  core.store.run('UPDATE episodes SET t_end = ? WHERE id = ?', b, e);
  assert.deepEqual(core.mods.admin.list(core, { view: 'days', of: 'episodes', month: '2026-11', tzOffsetMin: 480 }).items, [{ day: '2026-11-11', n: 1 }]);
  // 别名、不按时间的、坏的月份
  assert.equal(core.mods.admin.list(core, { view: 'days', of: 'experiences', month: '2026-11', tzOffsetMin: 480 }).items.length, 4);
  assert.throws(() => core.mods.admin.list(core, { view: 'days', of: 'entities', month: '2026-11' }), ContractError);
  assert.throws(() => core.mods.admin.list(core, { view: 'days', of: 'percepts', month: '2026-13' }), ContractError);
  assert.throws(() => core.mods.admin.list(core, { view: 'days', month: '2026-11' }), ContractError);
  assert.equal(typeof core.mods.admin.list(core, { view: 'days', of: 'percepts', month: '2026-11' }).tzOffsetMin, 'number', '不给时区用核心的（本机）');
}));

test('别的按时间的列表：事实（recorded_at）、意图（formed_at）、经验（updated_at）、已隐藏（操作的时间）都能筛时间、换顺序、往两头翻', withCore('tl-others', (core) => {
  const as = Array.from({ length: 9 }, (_, i) => seedAssertion(core, { text: `编的事实 ${i}`, at: T0 + i * HOUR }));
  assert.deepEqual(all(core, { view: 'assertions', order: 'asc' }), as.map((id) => `a${id}`));
  assert.deepEqual(walk(core, { view: 'assertions' }, 4).back, all(core, { view: 'assertions' }));
  assert.equal(L(core, { view: 'assertions', from: T0 + 3 * HOUR, to: T0 + 5 * HOUR }).total, 3);
  const p = L(core, { view: 'assertions', aroundRef: `a${as[4]}`, limit: 4 });
  assert.equal(p.items[p.anchor.index].ref, `a${as[4]}`);
  for (const [k, id] of as.slice(0, 5).entries()) core.mods.admin.suppress(core, `a${id}`, { state: 'hidden', by: 'owner', at: T0 + k * DAY });
  const sup = L(core, { view: 'suppressed', order: 'asc', limit: 2 });
  assert.equal(sup.total, 5);
  assert.deepEqual(walk(core, { view: 'suppressed' }, 2).forward, all(core, { view: 'suppressed' }));
  assert.equal(L(core, { view: 'suppressed', from: T0 + 2 * DAY }).total, 3);
  assert.equal(L(core, { view: 'suppressed', around: T0 + 2 * DAY + HOUR, limit: 2 }).anchor.exact, false);
  for (let i = 0; i < 3; i++) core.store.run("INSERT INTO intentions(act, text, origin, state, formed_at, created_at, updated_at) VALUES ('ask', ?, 'self-care', 'formed', ?, ?, ?)", `编的意图 ${i}`, T0 + i * DAY, T0, T0);
  assert.equal(L(core, { view: 'intentions', from: T0 + DAY }).total, 2);
  assert.equal(L(core, { view: 'intentions', order: 'asc' }).items[0].text, '编的意图 0');
  assert.equal(L(core, { view: 'lessons', order: 'asc' }).total, 0);
  assert.equal(L(core, { view: 'checks', from: T0 }).total, 0);
}));

test('性能：按时间翻页、按天计数走索引（EXPLAIN QUERY PLAN 里没有为排序建的临时 B 树，也不整表扫）', withCore('tl-plan', (core) => {
  const plan = (sql, ...a) => core.store.all(`EXPLAIN QUERY PLAN ${sql}`, ...a).map((r) => r.detail).join(' | ');
  const cases = [
    ['SELECT * FROM percepts t WHERE t.at <= ? AND (t.at < ? OR t.id < ?) ORDER BY t.at DESC, t.id DESC LIMIT 51', 1, 1, 1],
    ['SELECT * FROM percepts t WHERE t.setting_key = ? AND t.at >= ? AND (t.at > ? OR t.id >= ?) ORDER BY t.at ASC, t.id ASC LIMIT 51', 'x', 1, 1, 1],
    ['SELECT * FROM percepts t WHERE t.setting_key = ? ORDER BY t.at DESC, t.id DESC LIMIT 51', 'x'],
    ['SELECT * FROM raw_windows t ORDER BY t.t_end DESC, t.id DESC LIMIT 51'],
    ['SELECT * FROM raw_windows t WHERE t.setting_key = ? ORDER BY t.t_end DESC, t.id DESC LIMIT 51', 'x'],
    ['SELECT * FROM episodes t WHERE t.setting_key = ? ORDER BY t.t_end ASC, t.id ASC LIMIT 51', 'x'],
    ['SELECT * FROM memory_checks t ORDER BY t.at DESC, t.id DESC LIMIT 51'],
  ];
  for (const [sql, ...a] of cases) {
    const p = plan(sql, ...a);
    assert.doesNotMatch(p, /TEMP B-TREE/, `${sql}\n${p}`);
    assert.doesNotMatch(p, /^SCAN t$|\| SCAN t$|^SCAN t \|/, `${sql}\n${p}`);
  }
  const days = plan('SELECT CAST((t.at + ?) / 86400000 AS INTEGER) AS d, count(*) FROM percepts t WHERE t.at >= ? AND t.at < ? AND t.setting_key = ? GROUP BY d', 0, 0, 1, 'x');
  assert.match(days, /USING (COVERING )?INDEX/, days);
}));
