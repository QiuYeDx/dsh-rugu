// 提炼一直不成的段（D136）：搁置起来不挡后面的段；按退避再试（一时的和稳定被拒的隔得不一样）；试成了恢复正常；
// 不给它编造任何东西（不写情节、不写规范，感知仍是「没评估」）；状态全在库里，重启不丢。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeWorld, MINUTE, HOUR, DAY } from './harness.js';
import { openStore, enqueueJob } from '../../src/store/index.js';
import { markStalled, stallDelayMs, failureKind } from '../../src/encode/stalled.js';
import { extractDedupeKey } from '../../src/encode/segment.js';

const BAD = '坏段';
const GOOD = (req) => [{ type: 'header', title: '闲聊', text: '群里闲聊' }, { type: 'narrative', text: `大家闲聊（${req.messages[0].content.length}）。` }];

/** 切段 + 跑任务，直到没有能跑的（没有就把时钟往前拨 20 分钟，好让 1 / 4 / 16 分钟的重试到点）。 */
async function pump(w, rounds = 12) {
  const outs = [];
  for (let i = 0; i < rounds; i++) {
    w.core.mods.encode.segment(w.core, {});
    const r = await w.runNext();
    if (r) outs.push(r);
    else w.clock.minutes(20);
  }
  return outs;
}
const stalledRows = (core) => core.store.all('SELECT * FROM extract_stalled ORDER BY id');
const metric = (core, name) => core.store.all('SELECT value FROM metrics WHERE name = ?', name).reduce((a, r) => a + r.value, 0);
const assigned = (core, ids) => core.store.all(`SELECT episode_id, norm_state FROM percepts WHERE id IN (${ids.join(',')}) ORDER BY id`);

/** 一个群：先是一段模型稳定处理不了的对话，隔 30 分钟后是一段正常的。scanLimit 3：卡住的那段正好占满一次扫描。 */
async function setup() {
  const w = await makeWorld({ config: { segment: { scanLimit: 3 } } });
  const g = w.setting('游戏群', { exposure: 2 });
  const a = w.entity('甲');
  const b = w.entity('乙');
  const bad = [w.percept(g, a, `${BAD}第一句`), w.percept(g, b, `${BAD}第二句`), w.percept(g, a, `${BAD}第三句`)];
  w.clock.minutes(30);
  const good = [w.percept(g, b, '晚上打本吗'), w.percept(g, a, '八点上线')];
  w.clock.minutes(30);
  let badOk = false;
  w.llm.fallback.extract = (req) => (req.messages[0].content.includes(BAD) && !badOk ? 'garbage\nnot json' : GOOD(req));
  return { w, g, bad, good, fixBad: () => { badOk = true; } };
}

test('稳定失败的段不挡后面的；不替它编任何东西；退避到点再试一次，试成了恢复正常', async () => {
  const { w, g, bad, good, fixBad } = await setup();
  try {
    await pump(w);
    // 后面那段照常提炼了
    assert.ok(assigned(w.core, good).every((p) => p.episode_id != null && p.norm_state === 'assessed'), '后面的段没被挡住');
    // 卡住的那段：搁置，什么都没写（不编情节、不写规范），仍在缓冲里
    assert.ok(assigned(w.core, bad).every((p) => p.episode_id == null && p.norm_state !== 'assessed'));
    assert.equal(w.episodes().length, 1);
    assert.ok(!w.callsOf('writeNorm').some((c) => bad.some((id) => c.ref === `p${id}`)), '没给卡住的感知写规范');
    let [s] = stalledRows(w.core);
    assert.deepEqual([s.setting_key, s.ep_from, s.ep_to, s.reason, s.rounds, s.last_error], [g.key, bad[0], bad[2], 'rejected', 1, 'BAD_OUTPUT']);
    assert.equal(metric(w.core, 'encode.extract.stalled.rejected'), 1);
    assert.deepEqual(w.core.mods.encode.stalledSummary(w.core), { segments: 1, transient: 0, rejected: 1, maxRounds: 1, oldestAt: s.first_at, nextAt: s.next_at, truncated: 0, splits: 0, waitingLlm: 0 });
    // 没到点：不排
    w.clock.minutes((s.next_at - MINUTE - w.clock.now()) / MINUTE);
    w.core.mods.encode.segment(w.core, {});
    assert.equal(w.jobs().length, 0, '退避还没到点');
    // 到点：同一个范围一个任务，一轮只试一次（失败了直接记下一轮，不再按 1 / 4 / 16 分钟重试）
    w.clock.minutes(2);
    w.core.mods.encode.segment(w.core, {});
    let [j] = w.jobs();
    assert.equal(j.dedupe_key, `${extractDedupeKey(g.key, bad[0], bad[2])}#s1`);
    assert.equal(JSON.parse(j.payload_json).boundaryCertain, true);
    let r = await w.runNext();
    assert.equal(r.out.reason, 'BAD_OUTPUT');
    assert.equal(w.core.store.get('SELECT status FROM jobs WHERE id = ?', j.id).status, 'failed', '这一轮只试一次');
    [s] = stalledRows(w.core);
    assert.equal(s.rounds, 2);
    assert.equal(s.next_at - w.clock.now(), 2 * w.core.config.get().extract.stalled.rejectedMs, '第二轮隔得更久');
    // 下一轮：模型这回能处理了 → 写进情节、不再搁置
    fixBad();
    w.clock.minutes((s.next_at - w.clock.now()) / MINUTE + 1);
    w.core.mods.encode.segment(w.core, {});
    [j] = w.jobs();
    assert.match(j.dedupe_key, /#s2$/);
    r = await w.runNext();
    assert.equal(r.out.status, 'written');
    assert.equal(stalledRows(w.core).length, 0);
    assert.equal(metric(w.core, 'encode.extract.unstalled'), 1);
    assert.ok(assigned(w.core, bad).every((p) => p.episode_id != null && p.norm_state === 'assessed'));
    assert.equal(w.core.mods.encode.stalledSummary(w.core).segments, 0);
  } finally { await w.cleanup(); }
});

test('一时的错误和稳定被拒的间隔不一样；都翻倍、都有上限；分不清的错误连着两轮一样才算稳定被拒', async () => {
  const w = await makeWorld();
  try {
    const { core } = w;
    const st = core.config.get().extract.stalled;
    assert.equal(failureKind('TIMEOUT'), 'transient');
    assert.equal(failureKind('ECONNRESET'), 'transient');
    assert.equal(failureKind('BAD_OUTPUT'), 'rejected');
    assert.equal(failureKind('HTTP_400'), 'transient', '第一次分不清，先当一时的');
    assert.equal(failureKind('HTTP_400', 'HTTP_400'), 'rejected', '同一个错误连着两轮');
    assert.equal(failureKind('HTTP_400', 'TIMEOUT'), 'transient');
    const at = core.now();
    const t1 = markStalled(core, { settingKey: 'S', from: 1, to: 3, code: 'TIMEOUT', at });
    const r1 = markStalled(core, { settingKey: 'S', from: 4, to: 6, code: 'BAD_OUTPUT', at });
    assert.equal(t1.nextAt - at, st.transientMs);
    assert.equal(r1.nextAt - at, st.rejectedMs);
    assert.ok(r1.nextAt - at > t1.nextAt - at, '稳定被拒的隔得更久');
    const t2 = markStalled(core, { settingKey: 'S', from: 1, to: 3, code: 'TIMEOUT', at });
    assert.equal(t2.rounds, 2);
    assert.equal(t2.nextAt - at, 2 * st.transientMs, '翻倍');
    // 上限
    assert.equal(stallDelayMs(core, 'transient', 30), st.transientMaxMs);
    assert.equal(stallDelayMs(core, 'rejected', 30), st.rejectedMaxMs);
    assert.ok(st.transientMaxMs <= 12 * HOUR && st.rejectedMaxMs <= 7 * DAY);
    // 分不清的错误：第一轮一时的，第二轮还是它 → 稳定被拒
    const u1 = markStalled(core, { settingKey: 'S', from: 7, to: 8, code: 'HTTP_400', at });
    const u2 = markStalled(core, { settingKey: 'S', from: 7, to: 8, code: 'HTTP_400', at });
    assert.deepEqual([u1.reason, u2.reason], ['transient', 'rejected']);
    assert.equal(u2.nextAt - at, 2 * st.rejectedMs);
    assert.deepEqual(core.mods.encode.stalledSummary(core), { segments: 3, transient: 1, rejected: 2, maxRounds: 2, oldestAt: at, nextAt: at + 2 * st.transientMs, truncated: 0, splits: 0, waitingLlm: 0 });
    assert.equal(core.store.get("SELECT COUNT(*) AS n FROM metrics WHERE name LIKE 'encode.extract.stalled.%'").n, 2, '按原因分开计数');
  } finally { await w.cleanup(); }
});

test('D136 之前失败的批次（有失败的任务、没有搁置记录）：切段时补记成搁置，马上再试一次，之后不再挡在前面', async () => {
  const w = await makeWorld({ config: { segment: { scanLimit: 3 } } });
  try {
    const g = w.setting('游戏群', { exposure: 2 });
    const a = w.entity('甲');
    const ids = [w.percept(g, a, '一'), w.percept(g, a, '二'), w.percept(g, a, '三')];
    w.clock.minutes(30);
    const j = enqueueJob(w.core.store, { kind: 'extract', use: 'extract', dedupeKey: extractDedupeKey(g.key, ids[0], ids[2]), scopeKey: g.key, epFrom: ids[0], epTo: ids[2], payload: {} });
    w.core.store.run("UPDATE jobs SET status = 'failed', last_error = 'LLM_DOWN' WHERE id = ?", j.id);
    const later = [w.percept(g, a, '四'), w.percept(g, a, '五')];
    w.clock.minutes(30);
    w.core.mods.encode.segment(w.core, {});
    const [s] = stalledRows(w.core);
    assert.deepEqual([s.ep_from, s.ep_to, s.last_error, s.next_at], [ids[0], ids[2], 'LLM_DOWN', w.clock.now()]);
    w.core.mods.encode.segment(w.core, {});
    const keys = w.jobs().map((x) => x.dedupe_key).sort();
    assert.deepEqual(keys, [extractDedupeKey(g.key, later[0], later[1]), `${extractDedupeKey(g.key, ids[0], ids[2])}#s1`].sort(), '后面的段照切，旧的那段马上再试一次');
  } finally { await w.cleanup(); }
});

test('重启后状态还在：搁置的段照样跳过、照样按退避到点再试', async () => {
  const { w, g, bad, good } = await setup();
  let s2 = null;
  try {
    await pump(w);
    const [before] = stalledRows(w.core);
    assert.ok(before);
    assert.ok(assigned(w.core, good).every((p) => p.episode_id != null));
    // 「重启」：关库、重新打开同一个文件，内存里什么都不带
    w.core.store.close();
    s2 = await openStore({ file: path.join(w.dir, 'persona-memory.db'), clock: w.clock, logger: w.logger });
    w.core.store = s2;
    w.core.state.encode = { lastCallAt: 0, selfId: null, predicates: null };
    const [after] = stalledRows(w.core);
    assert.deepEqual(after, before);
    w.core.mods.encode.segment(w.core, {});
    assert.equal(s2.get("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").n, 0, '没到点，也不会又把它切进新段');
    w.clock.minutes((after.next_at - w.clock.now()) / MINUTE + 1);
    w.core.mods.encode.segment(w.core, {});
    const q = s2.all("SELECT dedupe_key FROM jobs WHERE status = 'queued'");
    assert.deepEqual(q.map((x) => x.dedupe_key), [`${extractDedupeKey(g.key, bad[0], bad[2])}#s1`]);
  } finally {
    try { s2?.close(); } catch { /* 尽力 */ }
    await w.cleanup();
  }
});

// ── D168：后台模型不工作（配置类的错）不算这段的失败 ─────────────────────────
const configError = () => Object.assign(new Error('UNKNOWN_MODEL'), { code: 'UNKNOWN_MODEL', kind: 'config' });

test('D168：配置类的错（端口带 kind=config）不计重试、不进搁置的慢档，推迟等恢复；恢复后提到现在补，照常写进情节', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('游戏群', { exposure: 2 });
    const a = w.entity('甲');
    const ids = [w.percept(g, a, '晚上打本吗'), w.percept(g, a, '八点上线')];
    w.clock.minutes(30);
    let broken = true;
    w.llm.fallback.extract = (req) => (broken ? configError() : GOOD(req));
    w.core.mods.encode.segment(w.core, {});
    // 配错了：失败多少轮都不进搁置表、不记失败、任务一直还在（推迟），每次推迟带 waitLlm
    for (let i = 0; i < 6; i++) {
      const r = await w.runNext();
      if (r) assert.deepEqual(r.out, { status: 'deferred', reason: 'llm-down' });
      if (i < 5) w.clock.minutes(400);
    }
    assert.equal(stalledRows(w.core).length, 0, '不进搁置表（不进 6 小时到 7 天的慢档）');
    assert.equal(metric(w.core, 'encode.extract.failed'), 0, '不算失败、不消耗重试');
    assert.ok(metric(w.core, 'encode.extract.deferred.llm-down') >= 2);
    const [j] = w.jobs();
    assert.equal(JSON.parse(j.payload_json).waitLlm, 1);
    assert.equal(w.core.mods.encode.stalledSummary(w.core).waitingLlm, 1, '管理页「正在补 / 等着补的段」');
    // 修好了：恢复时提到现在，马上能跑（不用等推迟的那几个小时）
    broken = false;
    assert.ok(j.run_after > w.clock.now());
    assert.deepEqual(w.core.mods.encode.resumeExtraction(w.core, {}), { jobs: 1, stalled: 0 });
    assert.equal(w.core.store.get('SELECT run_after FROM jobs WHERE id = ?', j.id).run_after, w.clock.now());
    const r = await w.runNext();
    assert.equal(r.out.status, 'written');
    assert.ok(assigned(w.core, ids).every((p) => p.episode_id != null));
    assert.equal(w.core.mods.encode.stalledSummary(w.core).waitingLlm, 0);
    assert.equal(metric(w.core, 'encode.extract.resumed'), 1);
  } finally { await w.cleanup(); }
});

test('D168：端口说现在用不了（ready() = false：配错了没有顶上的、主人关了后台模型）→ 不调模型、不占预算，推迟等恢复', async () => {
  const w = await makeWorld();
  try {
    const g = w.setting('游戏群', { exposure: 2 });
    const a = w.entity('甲');
    w.percept(g, a, '晚上打本吗'); w.percept(g, a, '八点上线');
    w.clock.minutes(30);
    w.llm.fallback.extract = GOOD;
    let ready = false;
    w.llm.ready = () => ready;
    let allows = 0;
    const allow = w.budget.allow.bind(w.budget);
    w.budget.allow = (...xs) => { allows += 1; return allow(...xs); };
    w.core.mods.encode.segment(w.core, {});
    const r = await w.runNext();
    assert.deepEqual(r.out, { status: 'deferred', reason: 'llm-down' });
    assert.equal(w.llm.callsFor('extract').length, 0, '没调模型');
    assert.equal(allows, 0, '没占预算');
    ready = true;
    w.core.mods.encode.resumeExtraction(w.core, {});
    assert.equal((await w.runNext()).out.status, 'written');
  } finally { delete w.llm.ready; await w.cleanup(); }
});

test('D168：恢复时，升级前就因为配置类的错搁置了的段（last_error 在集成层给的清单里）也提到现在；别的搁置照旧等退避', async () => {
  const w = await makeWorld();
  try {
    const { core } = w;
    const at = core.now();
    markStalled(core, { settingKey: 'S', from: 1, to: 3, code: 'UNKNOWN_MODEL', at });
    markStalled(core, { settingKey: 'S', from: 1, to: 3, code: 'UNKNOWN_MODEL', at });
    markStalled(core, { settingKey: 'S', from: 4, to: 6, code: 'BAD_OUTPUT', at });
    assert.deepEqual(core.mods.encode.resumeExtraction(core, { errorCodes: ['UNKNOWN_MODEL', 'AUTH'] }), { jobs: 0, stalled: 1 });
    const rows = stalledRows(core);
    assert.equal(rows.find((x) => x.ep_from === 1).next_at, core.now());
    assert.ok(rows.find((x) => x.ep_from === 4).next_at > core.now(), '内容的问题（模型答了但读不懂）照旧等');
    assert.deepEqual(core.mods.encode.resumeExtraction(core, {}), { jobs: 0, stalled: 0 }, '不给清单就不碰搁置表');
  } finally { await w.cleanup(); }
});
