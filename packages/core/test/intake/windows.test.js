// §7.1 第 8 步：原文窗口——同一场合连续 5–8 条（≤ 400 字，带说话人和绝对时间），相邻窗口重叠 2 条，空闲 2 分钟也切；
// 切好就送嵌入队列的文档档（priority 1）并加一条痕迹；不依赖 LLM。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withIntake, ingest, obs, descriptor, T0, M, SELF_ID } from './helpers.js';

const windows = (t) => t.core.store.all('SELECT * FROM raw_windows ORDER BY id').map((w) => ({ ...w, members: JSON.parse(w.members_json) }));
const burst = (t, n, { name = 'g', who = 'friend', start = T0, step = 10_000, text = (i) => `第${i}条消息`, extra = {} } = {}) => {
  const list = Array.from({ length: n }, (_, i) => obs(name, who, text(i + 1), { at: start + i * step, ...extra }));
  ingest(t, list);
  return list;
};

test('凑满 8 条立刻切；相邻窗口重叠 2 条；不满的等空闲 2 分钟（或凑够 5 条后最早那条等了 2 分钟）', () => withIntake((t) => {
  burst(t, 12);
  let ws = windows(t);
  assert.equal(ws.length, 1);
  const ids = t.rows().map((p) => p.id);
  assert.deepEqual(ws[0].members, ids.slice(0, 8));
  assert.equal(ws[0].n_percepts, 8);
  // 剩下 4 条 + 重叠 2 条 = 6 条：还在等
  assert.equal(t.core.mods.intake.flushWindows(t.core, { at: T0 + 11 * 10_000 + 30_000 }).windows, 0);
  // 空闲 2 分钟后切
  const r = t.core.mods.intake.flushWindows(t.core, { at: T0 + 11 * 10_000 + 2 * M });
  assert.equal(r.windows, 1);
  assert.equal(r.pending, 0);
  ws = windows(t);
  assert.deepEqual(ws[1].members, ids.slice(6, 12));   // 重叠前一个窗口的最后 2 条
  // 每条感知的 window_id 是最后一个包含它的窗口
  assert.equal(t.rows()[6].window_id, ws[1].id);
  assert.equal(t.rows()[0].window_id, ws[0].id);
}));

test('凑够 5 条、最早那条已经等了 2 分钟：不等空闲也切', () => withIntake((t) => {
  burst(t, 5, { step: 40_000 });   // 0s, 40s, ... 160s
  assert.equal(windows(t).length, 0);
  // 最后一条才过去 10 秒（不空闲），但最早那条已经 2 分 50 秒
  assert.equal(t.core.mods.intake.flushWindows(t.core, { at: T0 + 170_000 }).windows, 1);
}));

test('只有一两条也会在空闲 2 分钟后切（她偶尔路过的小群也有原文层）', () => withIntake((t) => {
  burst(t, 1);
  assert.equal(t.core.mods.intake.flushWindows(t.core, { at: T0 + M }).windows, 0);
  assert.equal(t.core.mods.intake.flushWindows(t.core, { at: T0 + 2 * M }).windows, 1);
  assert.equal(windows(t)[0].n_percepts, 1);
}));

test('≤ 400 字：长消息让窗口提前切；单条超长的单独成窗并截断', () => withIntake((t) => {
  const long = (i) => `${'很长的一段话'.repeat(20)}#${i}`;   // 每条 ~123 字
  burst(t, 4, { text: long });
  const ws = windows(t);
  assert.ok(ws.length >= 1);
  for (const w of ws) assert.ok([...w.text].length <= 400, `窗口 ${w.id} 有 ${[...w.text].length} 字`);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  for (const w of windows(t)) assert.ok([...w.text].length <= 400);
  ingest(t, [obs('g', 'friend', '超'.repeat(600), { at: T0 + 10 * M })]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const last = windows(t).at(-1);
  assert.equal(last.n_percepts, 1);
  assert.ok([...last.text].length <= 400);
  assert.ok(last.text.endsWith('…'));
}));

test('中间隔了一段对话间隔（segment.gapMin）：立刻切，而且不跨间隔重叠', () => withIntake((t) => {
  burst(t, 3, { start: T0 });
  burst(t, 3, { start: T0 + 60 * M });
  const ws = windows(t);
  assert.equal(ws.length, 1);   // 前 3 条在第二段到来时就切了
  const ids = t.rows().map((p) => p.id);
  assert.deepEqual(ws[0].members, ids.slice(0, 3));
  t.core.mods.intake.flushWindows(t.core, { force: true });
  assert.deepEqual(windows(t)[1].members, ids.slice(3, 6));   // 没有接上前一段的 2 条
}));

test('按（场合，visible_to）分开切：她心里想的不和当众的话混在一个窗口里；presence、retract 这类不进窗口', () => withIntake((t) => {
  ingest(t, [
    obs('g', 'friend', '当众说的话'),
    obs('g', 'her', '（她心里想）这人真有意思', { kind: 'self-thought', visibleTo: 'her-only' }),
    obs('g', 'friend', '进群了', { kind: 'presence', evidential: false }),
    obs('h', 'other', '另一个群'),
  ]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const ws = windows(t);
  assert.equal(ws.length, 3);
  const byGroup = Object.fromEntries(ws.map((w) => [`${w.setting_key === t.key('g') ? 'g' : 'h'}/${w.visible_to}`, w]));
  assert.match(byGroup['g/setting-audience'].text, /当众说的话/);
  assert.doesNotMatch(byGroup['g/setting-audience'].text, /这人真有意思|进群了/);
  assert.match(byGroup['g/her-only'].text, /我（心里想）：/);
  assert.match(byGroup['h/setting-audience'].text, /另一个群/);
  assert.equal(t.rows().find((p) => p.kind === 'presence').window_id, null);
}, { settings: { g: descriptor('g'), h: descriptor('h') } }));

test('窗口文字：本地时间（config.time.tzOffsetMin）+ 说话人；她自己写「我」，有管理权限的人用她对主人的称呼', () => withIntake((t) => {
  ingest(t, [
    obs('g', 'friend', '晚上好', { at: T0 }),
    obs('g', 'her', '晚上好呀', { at: T0 + M }),
    obs('g', 'principal', '我回来了', { at: T0 + 2 * M }),
  ]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const [w] = windows(t);
  const lines = w.text.split('\n');
  assert.equal(lines[0], '[10-31 18:00] 阿明：晚上好');
  assert.equal(lines[1], '[18:01] 我：晚上好呀');            // 同一天只写时分
  assert.equal(lines[2], '[18:02] 主人：我回来了');
  assert.equal(w.t_start, T0);
  assert.equal(w.t_end, T0 + 2 * M);
  assert.ok(!w.text.includes('场合-g'));   // 场合名不进嵌入文本（§7.2）
}));

test('切好的窗口：送嵌入队列（原文层、priority 1）+ 一条痕迹（编码强度取成员里最大的，时间取最后一条）', () => withIntake((t) => {
  ingest(t, [obs('g', 'friend', '旁听', { attention: 'peripheral', at: T0 }), obs('g', 'friend', '对她说', { addressed: 'to-her', at: T0 + M })]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const [w] = windows(t);
  const [ref, chunks, opt] = t.calls['worker.enqueueEmbed'].at(-1);
  assert.deepEqual(ref, { kind: 'window', id: w.id });
  assert.deepEqual(chunks, [{ chunkNo: 0, kind: 'text', text: w.text }]);
  assert.deepEqual(opt, { layer: 'raw', priority: 1 });
  const [tref, tr] = t.calls['dynamics.addTrace'].at(-1);
  assert.deepEqual(tref, { kind: 'window', id: w.id });
  assert.equal(tr.reason, 'encode');
  assert.equal(tr.t, T0 + M);
  const maxW = Math.max(...t.rows().map((p) => p.w_enc));
  assert.equal(tr.w, maxW);
  assert.equal(tr.sourceKey, `w${w.id}`);
  // 成员里有主人隐藏过的消息：窗口一切出来就跟着对别人隐藏（§12.7），不等 tick 的兜底扫描
  const [iref] = t.calls['admin.inheritSuppression'].at(-1);
  assert.equal(iref, `w${w.id}`);
}));

test('切窗口时 admin 继承隐藏出错：窗口照样切好（tick 的兜底扫描会补上），记一次计数', () => withIntake((t) => {
  ingest(t, [obs('g', 'friend', '第一条', { at: T0 }), obs('g', 'friend', '第二条', { at: T0 + M })]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  assert.equal(windows(t).length, 1);
  assert.equal(t.calls['admin.inheritSuppression'].length, 1);
  assert.ok(t.core.store.get("SELECT SUM(value) AS n FROM metrics WHERE name = 'intake.inheritSuppression.error'")?.n >= 1);
}, { throwOn: new Set(['admin.inheritSuppression']) }));

test('切窗口出错（嵌入登记失败）不影响感知入库；下次再切', () => {
  const throwOn = new Set(['worker.enqueueEmbed']);
  return withIntake((t) => {
    burst(t, 8);
    assert.equal(t.rows().length, 8);
    assert.equal(windows(t).length, 0);
    assert.ok(t.rows().every((p) => p.window_id === null));
    throwOn.delete('worker.enqueueEmbed');
    assert.equal(t.core.mods.intake.flushWindows(t.core, { force: true }).windows, 1);
  }, { throwOn });
});

test('定时：凑不满的分组在到点时再看（时间判断用 core.now()，定时器只负责叫一声）；重启后第一次 drain 也会定时', () => withIntake((t) => {
  burst(t, 2);
  const st = t.core.state.intake;
  assert.equal(st.windowDueAt, T0 + 10_000 + 2 * M);   // 最后一条之后空闲 2 分钟
  // 模拟重启：内存状态清空，库里还有没切的
  t.core.mods.intake.dispose(t.core);
  t.core.mods.intake.init(t.core);
  t.core.adapters.set(t.adapter.id, t.adapter);
  t.core.mods.intake.registerAdapter(t.core, t.adapter);
  assert.equal(t.core.state.intake.windowDueAt, null);
  t.drain();
  assert.equal(t.core.state.intake.windowDueAt, T0 + 10_000 + 2 * M);
}));

test('dropFromWindows（彻底删除的级联用）：先删向量，把感知从成员里拿掉重新渲染；成员空了的窗口整个删掉', () => withIntake((t) => {
  burst(t, 3);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const ids = t.rows().map((p) => p.id);
  const [w] = windows(t);
  const r = t.core.store.tx(() => t.core.mods.intake.dropFromWindows(t.core, [ids[1]]));
  assert.deepEqual(r, { rebuilt: 1, deleted: 0 });
  const [w1] = windows(t);
  assert.deepEqual(w1.members, [ids[0], ids[2]]);
  assert.doesNotMatch(w1.text, /第2条消息/);
  assert.deepEqual(t.calls['worker.dropEmbeddings'].at(-1)[0], [{ kind: 'window', id: w.id }]);
  const r2 = t.core.mods.intake.dropFromWindows(t.core, [ids[0], ids[2]]);
  assert.deepEqual(r2, { rebuilt: 0, deleted: 1 });
  assert.equal(windows(t).length, 0);
}));

test('她自己的话也进窗口（说话人「我」，痕迹照加）', () => withIntake((t) => {
  ingest(t, [obs('g', 'her', '我先下线啦')]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  assert.match(windows(t)[0].text, /我：我先下线啦/);
  assert.equal(t.rows()[0].actor_entity_id, SELF_ID);
}));
