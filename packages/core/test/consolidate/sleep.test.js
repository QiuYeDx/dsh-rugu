// 夜间整理的编排（§7.7）：什么时候跑、10 步按顺序、开始前先备份、每步失败只跳过这一步、LLM ≤ 12 次 / 晚超了顺延、
// 预算不够整步跳过、节省预设只做必要项、同一时间只跑一个；第 1 步补跑失败批次、第 2 步分诊和重放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, reply, T0, MIN, HOUR, DAY } from './world.js';
import { FakeLLM, FakeBudget } from '../fakes/index.js';
import { getMeta, setMeta, getMetaJson, enqueueJob, completeJob } from '../../src/store/index.js';
import { nextRecurrence, replayStep } from '../../src/consolidate/sleep.js';
import { params } from '../../src/consolidate/params.js';

// 测试统一用 UTC+8：T0 是本地 10-31 18:00；本地 11-01 04:30 = T0 + 10.5 小时
const NEXT_0430 = T0 + 10.5 * HOUR;
const STEP_NAMES = ['backup', 'seal-review', 'replay', 'generalize', 'reflect', 'entities', 'time', 'settings', 'self', 'vectors', 'ops', 'lessons'];

test('shouldSleep：本地 04:30 之后、今天还没跑过才跑；从没跑过就补跑；中途崩了隔一会儿再试；只读或正在跑时不跑', async () => {
  const w = await world();
  try {
    const { core } = w;
    const should = (at) => core.mods.consolidate.shouldSleep(core, at);
    assert.equal(should(T0), true, '从没跑过：启动时补跑');
    setMeta(core.store, 'sleep.lastAt', T0);            // 本地 10-31 18:00 跑过
    assert.equal(should(T0 + HOUR), false);
    assert.equal(should(NEXT_0430 - MIN), false, '本地 04:29 还不到点');
    assert.equal(should(NEXT_0430 + MIN), true, '本地 04:31：今天的还没跑');
    setMeta(core.store, 'sleep.lastAt', NEXT_0430 + MIN);
    assert.equal(should(NEXT_0430 + 20 * HOUR), false, '今天已经跑过');
    assert.equal(should(NEXT_0430 + DAY + MIN), true, '第二天 04:30 之后');
    // 上次开始了但没跑完（进程崩了）：至少隔 retryMin 分钟再试
    setMeta(core.store, 'sleep.attemptAt', NEXT_0430 + DAY);
    assert.equal(should(NEXT_0430 + DAY + 10 * MIN), false);
    assert.equal(should(NEXT_0430 + DAY + 2 * HOUR), true);
    core.readOnly = true;
    assert.equal(should(NEXT_0430 + DAY + 2 * HOUR), false, '只读库不跑');
    core.readOnly = false;
    core.state.consolidate.running = Promise.resolve();
    assert.equal(should(NEXT_0430 + DAY + 2 * HOUR), false, '正在跑');
    core.state.consolidate.running = null;
  } finally { await w.cleanup(); }
});

test('sleep：开始前先做备份；11 步按顺序都在报告里（D124 的第 11 步在最后）；一步出错只跳过这一步；记下时间和报告（只有数字，没有内容）', async () => {
  const order = [];
  const llm = new FakeLLM({ fallback: { sleep: [] } });
  const w = await world({
    llm,
    mods: {
      backup: { runScheduled: async (c, o) => { order.push('backup'); assert.equal(o.at, NEXT_0430); return [{}, {}]; } },
      encode: {
        segment: (c, o) => { order.push('segment'); assert.equal(o.force, true, '第 1 步把全部缓冲封口'); throw new Error('boom'); },
        reviewFlagged: async () => { order.push('review'); return { reviewed: 3, llmCalls: 1 }; },
      },
      dynamics: { retier: () => { order.push('retier'); return { updated: 5, done: true }; } },
      worker: { maintenance: async (c, t) => { order.push(`maint:${t.kind}`); return { ok: true }; } },
      admin: { applyRetention: async () => { order.push('retention'); throw new Error('disk'); } },
    },
  });
  try {
    const { core } = w;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(order[0], 'backup', '夜间整理开始前先 backup.runScheduled');
    assert.deepEqual(r.steps.map((s) => s.name), STEP_NAMES);
    assert.deepEqual(r.steps.map((s) => s.step), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const s1 = r.steps[1];
    assert.equal(s1.ok, false);
    assert.ok(s1.errors.some((e) => e.startsWith('sealed:')), '封口出错只记在第 1 步');
    assert.equal(s1.llmCalls, 1, '复核的 LLM 调用算进一晚的上限');
    assert.ok(order.includes('review') && order.includes('retier'), '后面的步照常跑');
    assert.equal(r.steps[10].ok, false);
    assert.ok(r.steps[10].errors.some((e) => e.startsWith('retention:')));
    assert.ok(order.includes('maint:fts-merge') && order.includes('maint:vacuum'), '第 10 步的维护都交给 worker');
    assert.ok(!order.includes('maint:integrity-check'), '完整性检查由 backup 在刚备份出的副本上做，不碰正在用的库');
    assert.equal(r.steps[0].detail.packs, 2);
    assert.equal(r.llmCalls, 1);
    assert.equal(Number(getMeta(core.store, 'sleep.lastAt')), NEXT_0430);
    const saved = getMetaJson(core.store, 'sleep.lastReport');
    assert.equal(saved.steps.length, 12);
    assert.equal(core.mods.consolidate.shouldSleep(core, NEXT_0430 + HOUR), false);
    w.logger.assertNoText('boom', 'disk');
  } finally { await w.cleanup(); }
});

/** 每一步都有活干的一晚：泛化、反思、印象、故事线、自我概念都要调 LLM。 */
function busyDay(w) {
  const G = w.setting({ label: '群' });
  const a = w.entity({ name: '阿明', lastMention: T0 });
  const b = w.entity({ name: '小红', lastMention: T0 });
  for (let d = 0; d < 6; d++) {
    const at = T0 - 6 * DAY + d * DAY;
    w.episode(G, [[a, `周六一起打某游戏 第${d}回`, at], ['self', '我也来', at + MIN], [b, '好呀', at + 2 * MIN]], { header: '大家约周六打某游戏' });
  }
  for (let i = 0; i < 40; i++) w.fact({ subjects: [a], text: `阿明的近况 ${i}`, imp: 6, recordedAt: T0 - DAY + i * MIN });
  return { G, a, b };
}

test('LLM 调用一晚 ≤ sleep.maxLlmCalls：到了上限后面的步顺延（skipped=llm-cap），水位线不推进，下一晚接着做', async () => {
  const llm = new FakeLLM({ fallback: { sleep: [] } });
  const w = await world({ llm, config: { sleep: { maxLlmCalls: 2 } } });
  try {
    const { core } = w;
    busyDay(w);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(llm.callsFor('sleep').length, 2);
    assert.equal(r.llmCalls, 2);
    const skipped = r.steps.filter((s) => s.skipped === 'llm-cap').map((s) => s.name);
    assert.ok(skipped.includes('self'), JSON.stringify(r.steps));
    assert.equal(core.store.get('SELECT COUNT(*) AS n FROM storylines').n, 0, '故事线没写，水位线也就没动');
    // 第二晚：额度恢复，接着做
    core.config.update({ sleep: { maxLlmCalls: 12 } });
    const r2 = await core.mods.consolidate.sleep(core, { at: NEXT_0430 + DAY });
    assert.ok(r2.llmCalls > 0 && r2.llmCalls <= 12);
    assert.ok(llm.callsFor('sleep').length <= 2 + 12);
  } finally { await w.cleanup(); }
});

test('预算不允许：要 LLM 的步整步跳过（不调模型），不需要 LLM 的照常做', async () => {
  const llm = new FakeLLM({ fallback: { sleep: [] } });
  const w = await world({ llm, budget: new FakeBudget({ perUse: { sleep: 0 } }) });
  try {
    const { core } = w;
    busyDay(w);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(llm.calls.length, 0);
    const by = Object.fromEntries(r.steps.map((s) => [s.name, s]));
    assert.equal(by.generalize.skipped, 'budget');
    assert.equal(by.reflect.skipped, 'budget');
    assert.equal(by.self.skipped, 'budget');
    assert.ok(by.replay.ok && by.replay.detail.added > 0, '重放不用 LLM');
    assert.ok(by.vectors.ok && by.ops.ok);
  } finally { await w.cleanup(); }
});

test('节省预设（sleepDepth=essential）：只做必要项；泛化、反思、她自己、社区、回头问问留到宽松的时候', async () => {
  const llm = new FakeLLM({ fallback: { sleep: [] } });
  const w = await world({ llm, config: { budget: { preset: 'saving' } } });
  try {
    const { core } = w;
    busyDay(w);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    const by = Object.fromEntries(r.steps.map((s) => [s.name, s]));
    for (const n of ['generalize', 'reflect', 'self']) assert.equal(by[n].skipped, 'saving-preset', n);
    for (const n of ['backup', 'seal-review', 'replay', 'entities', 'time', 'settings', 'vectors', 'ops']) assert.notEqual(by[n].skipped, 'saving-preset', n);
    assert.equal(by.time.detail.followUpSkipped, 'saving-preset');
    assert.equal(by.settings.detail.communitiesBuilt, undefined);
    assert.equal(params(core).depth, 'essential');
  } finally { await w.cleanup(); }
});

test('同一时间只跑一个；dispose 中止正在跑的；中止的那次不记 lastAt；只读库不跑', async () => {
  let release;
  let backups = 0;
  const gate = new Promise((r) => { release = r; });
  const w = await world({ mods: { backup: { runScheduled: async () => { backups += 1; await gate; return []; } } } });
  try {
    const { core } = w;
    const p1 = core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    const p2 = core.mods.consolidate.sleep(core, { at: NEXT_0430 + MIN });
    assert.equal(core.mods.consolidate.shouldSleep(core, NEXT_0430 + HOUR), false);
    core.mods.consolidate.dispose(core);
    release();
    const [r, r2] = await Promise.all([p1, p2]);
    assert.equal(r, r2, '第二次调用等的是同一次进行中的整理');
    assert.equal(backups, 1);
    assert.ok(r.steps.slice(1).every((s) => s.skipped === 'aborted'));
    assert.equal(getMeta(core.store, 'sleep.lastAt'), null, '没跑完不算跑过');
    assert.equal(core.state.consolidate.running, null);
    core.readOnly = true;
    const ro = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.deepEqual(ro.steps, []);
    core.readOnly = false;
  } finally { await w.cleanup(); }
});

test('第 1 步：补跑最近失败的提炼批次（最多 retryMax 次；已经写进情节的、正在跑的不补）；顺手跑掉排着的提炼任务', async () => {
  const w = await world();
  try {
    const { core } = w;
    const G = w.setting();
    const a = w.entity({ name: '甲' });
    const pids = [0, 1, 2, 3, 4, 5].map((i) => w.percept(G, { at: T0 + i * MIN, actor: a, text: `第${i}句` }));
    const failed = (key, from, to) => {
      const j = enqueueJob(core.store, { kind: 'extract', use: 'extract', dedupeKey: key, scopeKey: G.key, epFrom: from, epTo: to, payload: { x: 1 } });
      core.store.run("UPDATE jobs SET status = 'failed' WHERE id = ?", j.id);
      return j.id;
    };
    failed('seg:a', pids[0], pids[1]);
    failed('seg:b#sleep-retry-3', pids[2], pids[2]);              // 已经补跑过 3 次
    failed('seg:c', pids[3], pids[3]);
    core.store.run('UPDATE percepts SET episode_id = 99 WHERE id = ?', pids[3]);   // 后来已经写进情节了
    failed('seg:d', pids[4], pids[5]);
    enqueueJob(core.store, { kind: 'extract', dedupeKey: 'busy', scopeKey: G.key, epFrom: pids[5], epTo: pids[5] });   // 同一段正在排
    const ran = [];
    core.jobHandlers.set('extract', async (c, job) => { ran.push(job.dedupe_key); completeJob(c.store, job.id, () => {}); return { status: 'written' }; });
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    const s1 = r.steps[1];
    assert.equal(s1.detail.retried, 1);
    assert.deepEqual(ran.sort(), ['busy', 'seg:a#sleep-retry-1']);
    const again = core.store.get("SELECT payload_json FROM jobs WHERE dedupe_key = 'seg:a#sleep-retry-1'");
    assert.deepEqual(JSON.parse(again.payload_json), { x: 1 });
  } finally { await w.cleanup(); }
});

test('第 2 步分诊和重放：将来用得上的、显著的、情绪强的、意外的排前面；加一条重放痕迹（w=0.2，30 天内）；隐藏的不重放', async () => {
  const w = await world({ extra: { sleep: { replay: { maxItems: 3 } } } });
  try {
    const { core } = w;
    const at = NEXT_0430;
    const G = w.setting();
    const a = w.entity({ name: '阿明', lastMention: at - HOUR });
    const plan = w.fact({ subjects: [a], text: '阿明周六考驾照', plan: { agent: a, status: 'planned' }, imp: 7, recordedAt: at - DAY });
    const birthday = w.fact({ subjects: [a], text: '阿明的生日', recurrence: { freq: 'year', anchor: Date.UTC(2020, 10, 5) }, imp: 6, recordedAt: at - 2 * DAY });
    const dull = w.fact({ subjects: [w.entity({ name: '路人' })], text: '路人说今天下雨', imp: 2, recordedAt: at - DAY });
    const old = w.fact({ subjects: [a], text: '很久以前的事', plan: { agent: a, status: 'planned' }, imp: 9, recordedAt: at - 40 * DAY });
    const hiddenPlan = w.fact({ subjects: [a], text: '被隐藏的计划', plan: { agent: a, status: 'planned' }, imp: 9, recordedAt: at - DAY });
    w.hidden.add(hiddenPlan.ref);
    const emo = w.episode(G, [[a, '我失恋了', at - DAY]], { emotion: { valence: -0.8, intensity: 0.9 } });
    const r = replayStep(core, { p: params(core), at });
    assert.equal(r.detail.picked, 3);
    const traced = w.rec.addTrace.filter((t) => t.reason === 'replay');
    assert.deepEqual(traced.map((t) => t.ref).sort(), [plan.ref, birthday.ref, emo.ref].sort());
    assert.ok(!traced.some((t) => [dull.ref, old.ref, hiddenPlan.ref].includes(t.ref)));
    for (const t of traced) {
      assert.equal(t.w, 0.2);
      assert.equal(t.t, at);
      assert.match(t.sourceKey, /^sleep-replay:\d+$/);
    }
  } finally { await w.cleanup(); }
});

test('nextRecurrence：{next} 直接用；按年 / 月 / 周 / 天从锚点往后数；不认识的返回 null', () => {
  const at = Date.UTC(2026, 9, 31);
  assert.equal(nextRecurrence({ next: 123 }, null, at), 123);
  assert.equal(nextRecurrence({ freq: 'year', anchor: Date.UTC(2000, 10, 5) }, null, at), Date.UTC(2026, 10, 5));
  assert.equal(nextRecurrence({ every: 'week' }, Date.UTC(2026, 9, 1), at), Date.UTC(2026, 10, 5));
  assert.equal(nextRecurrence({ period: 'day' }, Date.UTC(2026, 9, 1), at), at);
  assert.equal(nextRecurrence({ freq: 'month', at: Date.UTC(2026, 0, 31, 12) }, null, at) > at, true);
  assert.equal(nextRecurrence({ freq: 'fortnightly-ish' }, at, at), null);
  assert.equal(nextRecurrence(null, at, at), null);
  assert.equal(nextRecurrence({ freq: 'year' }, null, at), null);
});

test('报告和日志里没有内容：busy 的一晚跑完，日志只有 id、类型、计数', async () => {
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => {
    const out = [];
    for (const m of text.matchAll(/【(s\d+)】/g)) out.push({ type: 'storyline', setting: m[1], text: '大家约了周六打某游戏' });
    for (const m of text.matchAll(/【(P\d+)】/g)) out.push({ type: 'impression', entity: m[1], text: '阿明爱打某游戏' });
    return out;
  }) } });
  const w = await world({ llm });
  try {
    const { core } = w;
    busyDay(w);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.ok(!JSON.stringify(r).includes('某游戏'));
    assert.ok(!JSON.stringify(getMetaJson(core.store, 'sleep.lastReport')).includes('阿明'));
    w.logger.assertNoText('某游戏', '阿明', '小红', '近况');
  } finally { await w.cleanup(); }
});

// ── 和别的模块的接线（阶段 B 交付说明里提的） ─────────────────────────────────────

test('第 1 步：原文窗口（intake.flushWindows force）和切分缓冲（encode.segment force）都封口，窗口先切；切窗口出错只记在第 1 步', async () => {
  const order = [];
  const w = await world({
    mods: {
      intake: { flushWindows: (c, o) => { order.push(['windows', o]); return { windows: 3, pending: 0 }; } },
      encode: { segment: (c, o) => { order.push(['segment', o]); return { jobs: 2 }; } },
    },
  });
  try {
    const { core } = w;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.deepEqual(order.map((x) => x[0]), ['windows', 'segment']);
    assert.deepEqual(order[0][1], { at: NEXT_0430, force: true }, '不等空闲 2 分钟，有几条切几条');
    assert.equal(order[1][1].force, true);
    assert.equal(r.steps[1].ok, true);
    assert.equal(r.steps[1].detail.windows, 3);
    assert.equal(r.steps[1].detail.sealed, 2);
  } finally { await w.cleanup(); }
  const w2 = await world({ mods: { intake: { flushWindows: () => { throw new Error('win'); } } } });
  try {
    const { core } = w2;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(r.steps[1].ok, false);
    assert.ok(r.steps[1].errors.some((e) => e.startsWith('windows:')));
    assert.equal(w2.rec.segment.length, 1, '切窗口出错不影响封口');
    assert.ok(r.steps.slice(2).every((s) => s.skipped !== 'aborted'));
  } finally { await w2.cleanup(); }
});

test('第 9 步：嵌入队列按夜里的方式跑（night=true、每轮上限来自 sleep.maintenance.embedBatches、带 signal）；分层一轮做完才让 worker 重建内存索引', async () => {
  const order = [];
  const calls = [];
  const w = await world({
    config: { sleep: { maintenance: { embedBatches: 7 } } },
    mods: {
      worker: {
        runEmbedQueue: async (c, o) => { order.push('embed'); calls.push(o); return { embedded: 4, failed: 0 }; },
        health: () => ({ queue: { pending: 0, stale: 0, done: 4 } }),
        reloadIndex: () => { order.push('reload'); },
      },
      dynamics: { retier: (c, o) => { order.push('retier'); calls.push(o); return { updated: 3, done: order.filter((x) => x === 'retier').length === 2 }; } },
    },
  });
  try {
    const { core } = w;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    const [o, ...retierOpts] = calls;
    assert.equal(o.night, true, '白天推后的积压、失败了一天的行只在夜里那一轮做');
    assert.equal(o.maxBatches, 7);
    assert.ok(o.signal instanceof AbortSignal, '关库时能中止');
    assert.deepEqual(order, ['embed', 'retier', 'retier', 'reload'], '队列空了不再来一轮；分层做完之后才重建');
    assert.ok(retierOpts.every((x) => x.at === NEXT_0430 && x.limit === undefined), '批大小用 dynamics 自己的 activation.retierBatch');
    const s9 = r.steps[9];
    assert.equal(s9.ok, true);
    assert.equal(s9.detail.retier, 6);
    assert.equal(s9.detail.retierRounds, 2);
    assert.equal(s9.detail.retierDone, true);
    assert.equal(s9.detail.reindexed, true);
    assert.equal(s9.detail.embed.embedded, 4);
    assert.equal(s9.detail.embed.rounds, 1);
  } finally { await w.cleanup(); }
});

/** 一个有积压的嵌入队列替身：每轮最多嵌 maxBatches 条（一批一条），health 报剩下的。 */
function backlogWorker(n, { stuck = 0, breakerAt = null } = {}) {
  const st = { left: n, stuck, rounds: [] };
  st.worker = {
    runEmbedQueue: async (c, o) => {
      st.rounds.push(o);
      if (breakerAt != null && st.rounds.length >= breakerAt) return { embedded: 0, failed: 0, breaker: true };
      const k = Math.min(st.left, o.maxBatches);
      st.left -= k;
      return { embedded: k, failed: st.stuck };
    },
    health: () => ({ queue: { pending: st.left + st.stuck, stale: 0 } }),
  };
  return st;
}

test('第 9 步：推到夜里的积压一轮接一轮嵌完（每轮 ≤ embedBatches 批），不是每晚只消化一轮；队列空、一轮没嵌成、熔断、中止都停', async () => {
  // 23 条积压、每轮 10 批：三轮（10、10、3），之后队列空了就停
  const q = backlogWorker(23);
  const w = await world({ config: { sleep: { maintenance: { embedBatches: 10 } } }, mods: { worker: q.worker } });
  try {
    const { core } = w;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(q.rounds.length, 3);
    assert.ok(q.rounds.every((o) => o.night === true && o.maxBatches === 10));
    assert.equal(q.left, 0);
    assert.deepEqual({ ...r.steps[9].detail.embed }, { embedded: 23, failed: 0, rounds: 3 });
  } finally { await w.cleanup(); }
  // 剩下的两条一直失败：嵌完别的那一轮之后，下一轮一条也没嵌成 → 停（失败的留给下一晚），不空转
  const q2 = backlogWorker(15, { stuck: 2 });
  const w2 = await world({ config: { sleep: { maintenance: { embedBatches: 10 } } }, mods: { worker: q2.worker } });
  try {
    const { core } = w2;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(q2.rounds.length, 3);
    assert.equal(r.steps[9].detail.embed.embedded, 15);
    assert.equal(r.steps[9].ok, true);
  } finally { await w2.cleanup(); }
  // 第二轮熔断：停
  const q3 = backlogWorker(100, { breakerAt: 2 });
  const w3 = await world({ config: { sleep: { maintenance: { embedBatches: 10 } } }, mods: { worker: q3.worker } });
  try {
    const { core } = w3;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(q3.rounds.length, 2);
    assert.equal(r.steps[9].detail.embed.breaker, true);
    assert.equal(r.steps[9].detail.embed.embedded, 10);
  } finally { await w3.cleanup(); }
  // 关库（dispose）：正在嵌的那一轮结束后不再开新的一轮，后面的步也不做
  let release;
  const gate = new Promise((res) => { release = res; });
  const q4 = backlogWorker(100);
  const inner = q4.worker.runEmbedQueue;
  q4.worker.runEmbedQueue = async (c, o) => { const r = await inner(c, o); if (q4.rounds.length === 2) await gate; return r; };
  const w4 = await world({ config: { sleep: { maintenance: { embedBatches: 10 } } }, mods: { worker: q4.worker } });
  try {
    const { core } = w4;
    const p = core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    while (q4.rounds.length < 2) await new Promise((res) => setImmediate(res));
    const d = core.mods.consolidate.dispose(core);
    release();
    const [r] = await Promise.all([p, d]);
    assert.equal(q4.rounds.length, 2);
    assert.ok(q4.rounds[1].signal.aborted);
    assert.equal(r.steps[10].skipped, 'aborted');
    assert.equal(getMeta(core.store, 'sleep.lastAt'), null);
  } finally { await w4.cleanup(); }
});

test('第 9 步：分层一晚做完一整轮——批数上限 = activation 表要几批 + retierRounds 批余量；没做完不重建索引，游标留到下一晚；重建出错只记在第 9 步', async () => {
  const addRows = (core, n) => { for (let i = 1; i <= n; i++) core.store.run("INSERT INTO activation(owner_kind, owner_id) VALUES ('assertion', ?)", i); };
  // 25 行、每批 10 个：一整轮要 3 批；游标不前进（一直 done:false）也只转 3 + 2 批
  const w = await world({
    config: { activation: { retierBatch: 10 }, sleep: { maintenance: { retierRounds: 2 } } },
    mods: { dynamics: { retier: (c, o) => { w.rec.retierCalls.push(o); return { updated: 10, done: false }; } } },
  });
  try {
    const { core } = w;
    addRows(core, 25);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(w.rec.retierCalls.length, 5);
    assert.equal(r.steps[9].detail.retier, 50);
    assert.equal(r.steps[9].detail.retierDone, false);
    assert.equal(w.rec.reloadIndex.length, 0, '没做完：不重建');
  } finally { await w.cleanup(); }
  // 表很大、一晚要很多批：不被 retierRounds 卡住，做完一整轮就重建（不用等好几晚）
  let calls = 0;
  const w2 = await world({
    config: { activation: { retierBatch: 10 }, sleep: { maintenance: { retierRounds: 2 } } },
    mods: { dynamics: { retier: () => { calls += 1; return { updated: 10, done: calls === 12 }; } } },
  });
  try {
    const { core } = w2;
    addRows(core, 115);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(calls, 12);
    assert.equal(r.steps[9].detail.retierDone, true);
    assert.equal(r.steps[9].detail.reindexed, true);
    assert.equal(w2.rec.reloadIndex.length, 1);
  } finally { await w2.cleanup(); }
  const w3 = await world({ mods: { worker: { reloadIndex: () => { throw new Error('thread'); } } } });
  try {
    const { core } = w3;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(r.steps[9].ok, false);
    assert.ok(r.steps[9].errors.some((e) => e.startsWith('reindex:')));
    assert.ok(r.steps[10].ok, '后面的步照常');
  } finally { await w3.cleanup(); }
});

test('跑完给所有场合的常驻区标脏（只标脏，§10.4）；中止的那次也标（前面几步可能写过）', async () => {
  const order = [];
  const w = await world({
    mods: {
      context: { markResidentDirty: (c, key) => { order.push(['dirty', key ?? null]); } },
      admin: { applyRetention: async () => { order.push(['retention']); return { expired: 0, done: true }; } },
    },
  });
  try {
    const { core } = w;
    await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.deepEqual(order, [['retention'], ['dirty', null]], '最后一步之后、不带场合键 = 全部场合');
  } finally { await w.cleanup(); }
  let release;
  const gate = new Promise((r) => { release = r; });
  const w2 = await world({ mods: { backup: { runScheduled: async () => { await gate; return []; } } } });
  try {
    const { core } = w2;
    const p = core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    const d = core.mods.consolidate.dispose(core);
    release();
    await Promise.all([p, d]);
    assert.deepEqual(w2.rec.markResidentDirty, [null]);
  } finally { await w2.cleanup(); }
});

test('第 1 步的复核先占 LLM 额度：额度用完就不复核（标记留到下一晚）；没东西复核退回额度；出错按占了算', async () => {
  // 上限 1：复核用掉了这一次，后面要 LLM 的步顺延
  const llm = new FakeLLM({ fallback: { sleep: [] } });
  const w = await world({ llm, config: { sleep: { maxLlmCalls: 1 } }, mods: { encode: { reviewFlagged: async () => ({ reviewed: 2, llmCalls: 1 }) } } });
  try {
    const { core } = w;
    busyDay(w);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(r.steps[1].llmCalls, 1);
    assert.equal(r.llmCalls, 1);
    assert.equal(llm.callsFor('sleep').length, 0);
    assert.ok(r.steps.filter((s) => s.skipped === 'llm-cap').length >= 3, JSON.stringify(r.steps));
  } finally { await w.cleanup(); }
  // 上限 1：没有要复核的（一次都没调）→ 额度退回去，后面的步还能用
  const llm2 = new FakeLLM({ fallback: { sleep: [] } });
  const w2 = await world({ llm: llm2, config: { sleep: { maxLlmCalls: 1 } } });
  try {
    const { core } = w2;
    busyDay(w2);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(w2.rec.reviewFlagged.length, 1);
    assert.equal(r.steps[1].llmCalls, 0);
    assert.equal(llm2.callsFor('sleep').length, 1, '退回的那一次给了后面的步');
    assert.equal(r.llmCalls, 1);
  } finally { await w2.cleanup(); }
  // 上限 0：复核根本不调
  const w3 = await world({ config: { sleep: { maxLlmCalls: 0 } } });
  try {
    const { core } = w3;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.equal(w3.rec.reviewFlagged.length, 0);
    assert.equal(r.steps[1].detail.review, 'llm-cap');
    assert.equal(r.llmCalls, 0);
  } finally { await w3.cleanup(); }
  // 复核出错：不知道调没调成，按占了的算
  const w4 = await world({ config: { sleep: { maxLlmCalls: 2 } }, mods: { encode: { reviewFlagged: async () => { throw new Error('x'); } } } });
  try {
    const { core } = w4;
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.ok(r.steps[1].errors.some((e) => e.startsWith('review:')));
    assert.equal(r.steps[1].llmCalls, 1);
  } finally { await w4.cleanup(); }
});

test('整体恢复进行中（backup.isRestoring）：夜间整理不开始，今天到目前为止、时间维护都不写新记忆', async () => {
  let restoringNow = true;
  const w = await world({ mods: { backup: { isRestoring: () => restoringNow } } });
  try {
    const { core } = w;
    assert.equal(core.mods.consolidate.shouldSleep(core, NEXT_0430), false);
    const r = await core.mods.consolidate.sleep(core, { at: NEXT_0430 });
    assert.deepEqual(r.steps, []);
    assert.equal(w.rec.runScheduled.length, 0, '连备份都没开始');
    const G = w.setting();
    const a = w.entity({ name: '阿明' });
    for (let i = 0; i < 4; i++) w.percept(G, { at: T0 - HOUR + i * MIN, actor: a, text: `第${i}句` });
    w.percept(G, { at: T0 - HOUR + 5 * MIN, self: true, text: '我也觉得' });
    assert.deepEqual(await core.mods.consolidate.todaySoFar(core, { at: T0 }), { written: 0 });
    // 一个早就过了时间、没有下文的计划：恢复期间不标 unknown
    const plan = w.fact({ subjects: [a], kindHint: 'plan', text: '阿明说要去拿快递', plan: { agent: a, status: 'planned' }, eventTime: { start: T0 - 2 * DAY }, recordedAt: T0 - 2 * DAY });
    assert.equal(core.mods.consolidate.timeMaintenance(core, T0).plansUnknown, 0);
    assert.equal(w.rec.transitionPlan.length, 0);
    assert.equal(w.rec.expireReviews.length, 0);
    assert.equal(w.rec.markResidentDirty.length, 0);
    restoringNow = false;
    assert.equal(core.mods.consolidate.shouldSleep(core, NEXT_0430), true);
    assert.ok((await core.mods.consolidate.todaySoFar(core, { at: T0 })).written >= 1, '恢复完了照常写');
    assert.equal(core.mods.consolidate.timeMaintenance(core, T0).plansUnknown, 1);
    assert.deepEqual(w.rec.transitionPlan.map((x) => [x.id, x.status]), [[plan.id, 'unknown']]);
  } finally { await w.cleanup(); }
});

test('常驻区标脏（§10.4，只标脏）：白天写了小结、时间维护改了计划或意图、被叫来重建印象之后都标所有场合；什么都没变不标', async () => {
  const w = await world();
  try {
    const { core } = w;
    const G = w.setting();
    const a = w.entity({ name: '阿明' });
    assert.equal((await core.mods.consolidate.todaySoFar(core, { at: T0 })).written, 0);
    assert.equal(core.mods.consolidate.timeMaintenance(core, T0).plansUnknown, 0);
    assert.deepEqual(w.rec.markResidentDirty, [], '没变化：不标');
    for (let i = 0; i < 4; i++) w.percept(G, { at: T0 - HOUR + i * MIN, actor: a, text: `第${i}句` });
    w.percept(G, { at: T0 - HOUR + 5 * MIN, self: true, text: '我也觉得' });
    assert.ok((await core.mods.consolidate.todaySoFar(core, { at: T0 })).written >= 1);
    assert.deepEqual(w.rec.markResidentDirty, [null], '小结是「自传要点」的候选');
    w.fact({ subjects: [a], kindHint: 'plan', text: '阿明说要去拿快递', plan: { agent: a, status: 'planned' }, eventTime: { start: T0 - 2 * DAY }, recordedAt: T0 - 2 * DAY });
    assert.equal(core.mods.consolidate.timeMaintenance(core, T0).plansUnknown, 1);
    assert.deepEqual(w.rec.markResidentDirty, [null, null], '「近期约定」变了');
    await core.mods.consolidate.regenerateImpressions(core, a);
    assert.deepEqual(w.rec.markResidentDirty, [null, null, null], '印象在「重要的人」里');
  } finally { await w.cleanup(); }
});
