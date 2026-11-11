// 日志表到期清理（D139）：任务、注入日志、判定记录、她说过的话的审视记录。到期的删、没到期的不删；还在用的多旧都不删；
// 分批、中断以后接着删；清完以后污点账本、注入预算、记注入、管理页的视图、成长排除带污点的发言照常。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCore, DAY, HOUR } from '../fakes/index.js';
import { budgetState, loadSession } from '../../src/context/ledger.js';
import { expireInBatches, refOf } from '../../src/store/index.js';
import { logRetentionDays, DEFAULTS, mergeConfig } from '../../src/config/defaults.js';
import { taintedTurnPercepts } from '../../src/consolidate/memory.js';
import { seedSetting, seedPercept } from './fixtures.js';

const withCore = (name, fn, config) => async () => {
  const t = await createTestCore({ name, config });
  try { await fn(t.core, t); } finally { await t.cleanup(); }
};
const has = (core, table, id) => !!core.store.get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, id);

function job(core, { kind = 'extract', status = 'done', at, scope = null, from = null, to = null, key = null }) {
  return Number(core.store.run(`INSERT INTO jobs(kind, dedupe_key, scope_key, ep_from, ep_to, payload_json, status, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`, kind, key, scope, from, to, status, at, at).lastInsertRowid);
}
function session(core, { id, cycle = 1, pending = [], steps = [] }) {
  core.store.run(`INSERT INTO sessions(session_id, cycle, pending_json, inject_window_json, status, updated_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    id, cycle, JSON.stringify(pending), JSON.stringify({ steps }), core.now());
}
let nonceSeq = 0;
function injection(core, { sid, cycle, at, refs = [], nonce = `n-${++nonceSeq}`, chars = 10 }) {
  const items = refs.map(([id, ap]) => ({ id, layer: 'recalled', verdict: 'share', appraisalRef: ap }));
  return Number(core.store.run(`INSERT INTO injections(ts, session_id, cycle, layer, nonce, items_json, chars, mode, seen, seen_at)
                                VALUES (?, ?, ?, 'block', ?, ?, ?, 'live', 1, ?)`, at, sid, cycle, nonce, JSON.stringify(items), chars, at).lastInsertRowid);
}
function appraisal(core, { at, memoryId = 1, cacheKey = null, expiresAt = null }) {
  return Number(core.store.run(`INSERT INTO appraisals(stage, memory_kind, memory_id, verdict, at, cache_key, expires_at) VALUES (1, 'assertion', ?, 'share', ?, ?, ?)`,
    memoryId, at, cacheKey, expiresAt).lastInsertRowid);
}
let tokenSeq = 0;
function utterance(core, { at, hold = null, held = null, reasons = [], percept = null }) {
  return Number(core.store.run(`INSERT INTO utterances(token, at, channel_json, origin_path, text_hash, held_text, verdict, reasons_json, hold_status, matched_percept, created_at)
                                VALUES (?, ?, '{}', 'tool', 'th', ?, ?, ?, ?, ?, ?)`, `tok-${++tokenSeq}`, at, held, hold ? 'hold' : 'speak',
  JSON.stringify(reasons), hold, percept, at).lastInsertRowid);
}

test('保留天数：和读它们的步骤要看的天数取大的；0 / 负数 / 不是数 = 不清理', () => {
  const d = logRetentionDays(DEFAULTS);
  assert.deepEqual(d, { injections: 30, jobs: 30, appraisals: 7, utterances: 365 }, '注入日志至少留到经验「最近 30 天被想起过几天」看得到');
  const cfg = (logs) => mergeConfig(DEFAULTS, { retention: { logs } }).config;
  assert.deepEqual(logRetentionDays(cfg({ injectionsDays: 0, jobsDays: -1, appraisalsDays: 1, utterancesDays: 1 })),
    { injections: null, jobs: null, appraisals: 2, utterances: 14 });
});

test('任务：只删结束了的、有处理函数的种类；还有感知在切分缓冲里的提炼留着', withCore('logs-jobs', async (core) => {
  const now = core.now();
  const old = now - 40 * DAY;
  const sk = seedSetting(core);
  const p1 = seedPercept(core, { settingKey: sk, at: old });
  const p2 = seedPercept(core, { settingKey: sk, at: old });
  const p3 = seedPercept(core, { settingKey: sk, at: old });
  core.store.run('UPDATE percepts SET episode_id = 7 WHERE id IN (?, ?)', p1, p2);   // p3 还在缓冲里
  const sealed = job(core, { at: old, scope: sk, from: p1, to: p2, key: `extract:${sk}:${p1}-${p2}` });
  const cut = job(core, { at: old, scope: sk, from: p2, to: p3, key: 'extract:cut' });   // 「拿不准的切口没确认」的记号
  const failedOpen = job(core, { status: 'failed', at: old, scope: sk, from: p3, to: p3, key: 'extract:failed' });
  const cancelled = job(core, { status: 'cancelled', at: old, scope: sk, from: p1, to: p1, key: 'extract:deferred' });
  const queued = job(core, { status: 'queued', at: old, scope: sk, from: p1, to: p2 });
  const running = job(core, { kind: 'discretion.postcheck', status: 'running', at: old });
  const post = job(core, { kind: 'discretion.postcheck', status: 'failed', at: old });
  const scan = job(core, { kind: 'discretion.told-scan', status: 'done', at: old });
  const recent = job(core, { kind: 'discretion.told-scan', status: 'done', at: now - 3 * DAY });
  const unknown = job(core, { kind: 'someone-else', status: 'done', at: old });
  const r = await core.mods.admin.expireLogs(core, now);
  assert.equal(r.deleted.jobs, 4);
  for (const id of [sealed, cancelled, post, scan]) assert.equal(has(core, 'jobs', id), false, `删掉 ${id}`);
  for (const id of [cut, failedOpen, queued, running, recent, unknown]) assert.equal(has(core, 'jobs', id), true, `留着 ${id}`);
  // 留着的切口照样挡住同一处再切：segment 不会为同一段重新排任务
  assert.equal(core.store.get("SELECT count(*) AS n FROM jobs WHERE dedupe_key = 'extract:cut'").n, 1);
}));

test('注入日志：到期的删；会话当前周期的、等确认的、滚动窗口里的、每个会话最新的一行多旧都不删；当天的照样算预算', withCore('logs-inj', async (core) => {
  const now = core.now();
  const old = now - 60 * DAY;
  // 安静的会话：当前周期从 60 天前开始，一直没压缩过
  session(core, { id: 'quiet', cycle: 3 });
  const curOld = injection(core, { sid: 'quiet', cycle: 3, at: old, refs: [[refOf('assertion', 11), 'ap1']] });
  const prevCycle = injection(core, { sid: 'quiet', cycle: 2, at: old - DAY });
  // 换过周期的会话：旧周期的行到期；最新一行是旧周期的也留着（暖启动看「注入过没有」）
  session(core, { id: 'moved', cycle: 5 });
  const movedOld = injection(core, { sid: 'moved', cycle: 4, at: old - 2 * DAY });
  const movedLast = injection(core, { sid: 'moved', cycle: 4, at: old });
  // 等确认的块、滚动窗口里送达的
  const pendNonce = 'pending-1';
  session(core, { id: 'busy', cycle: 9, pending: [{ nonce: pendNonce, id: 0, at: old, live: true }], steps: [{ at: old - 5 * DAY, tokens: 10 }, { at: now, tokens: 20 }] });
  const pend = injection(core, { sid: 'busy', cycle: 8, at: old - 10 * DAY, nonce: pendNonce });
  const inWindow = injection(core, { sid: 'busy', cycle: 8, at: old - 4 * DAY });
  const beforeWindow = injection(core, { sid: 'busy', cycle: 8, at: old - 6 * DAY });
  const busyLast = injection(core, { sid: 'busy', cycle: 9, at: now - HOUR });
  // 会话已经不在的、没到期的
  const orphan = injection(core, { sid: 'gone', cycle: 1, at: old });
  const fresh = injection(core, { sid: 'gone', cycle: 1, at: now - 20 * DAY });
  const today = injection(core, { sid: 'quiet', cycle: 3, at: now - HOUR, chars: 123 });

  const r = await core.mods.admin.expireLogs(core, now);
  assert.equal(r.deleted.injections, 4);
  for (const id of [prevCycle, movedOld, beforeWindow, orphan]) assert.equal(has(core, 'injections', id), false, `删掉 ${id}`);
  for (const id of [curOld, movedLast, pend, inWindow, busyLast, fresh, today]) assert.equal(has(core, 'injections', id), true, `留着 ${id}`);
  // 污点账本照常：当前周期 60 天前注入的那条还在
  assert.ok(core.mods.context.taintLedger(core, 'quiet').includes(refOf('assertion', 11)));
  // 当天的预算照常从注入日志算
  assert.ok(budgetState(core, loadSession(core, 'quiet'), now).dayUsed >= 123);
}));

test('判定记录：没被留下的注入行引用、缓存也过期了的才删；之后照常记注入', withCore('logs-ap', async (core) => {
  const now = core.now();
  const old = now - 30 * DAY;
  session(core, { id: 's1', cycle: 2 });
  const kept = appraisal(core, { at: old, memoryId: 21 });
  const dropped = appraisal(core, { at: old, memoryId: 22 });
  const lone = appraisal(core, { at: old, memoryId: 23 });
  const cached = appraisal(core, { at: old, memoryId: 24, cacheKey: 'k1', expiresAt: now + DAY });
  const staleCache = appraisal(core, { at: old, memoryId: 25, cacheKey: 'k2', expiresAt: now - 3 * DAY });
  const recent = appraisal(core, { at: now - DAY, memoryId: 26 });
  injection(core, { sid: 's1', cycle: 2, at: old, refs: [[refOf('assertion', 21), `ap${kept}`]] });                 // 当前周期：留着
  const gone = injection(core, { sid: 's1', cycle: 1, at: old - DAY, refs: [[refOf('assertion', 22), `ap${dropped}`]] });   // 旧周期：删
  injection(core, { sid: 's1', cycle: 1, at: now - HOUR });   // 让上面那行不是这个会话最新的一行
  const r = await core.mods.admin.expireLogs(core, now);
  assert.equal(has(core, 'injections', gone), false);
  assert.equal(r.deleted.appraisals, 3);
  for (const id of [dropped, lone, staleCache]) assert.equal(has(core, 'appraisals', id), false, `删掉 ap${id}`);
  for (const id of [kept, cached, recent]) assert.equal(has(core, 'appraisals', id), true, `留着 ap${id}`);
  // 清完以后照常记注入：对得上还在的判定
  const id = core.mods.context.recordInjection(core, { sessionId: 's1', nonce: 'after-1', layer: 'block', mode: 'live', chars: 5,
    items: [{ id: refOf('assertion', 26), layer: 'recalled', verdict: 'share', appraisalRef: `ap${recent}` }] });
  assert.ok(Number.isInteger(id));
  assert.throws(() => core.mods.context.recordInjection(core, { sessionId: 's1', nonce: 'after-2', layer: 'block', mode: 'live', chars: 5,
    items: [{ id: refOf('assertion', 23), layer: 'recalled', verdict: 'share', appraisalRef: `ap${lone}` }] }), { code: 'CONTRACT' }, '删掉的判定对不上，照旧拒绝');
}));

test('她说过的话：等主人处理的草稿、批准了还没发的、带按轮污点的多旧都不删；成长照样排除带污点的那句', withCore('logs-utt', async (core) => {
  const now = core.now();
  const old = now - 400 * DAY;
  const sk = seedSetting(core);
  const spoke = seedPercept(core, { settingKey: sk, at: old });
  const tainted = seedPercept(core, { settingKey: sk, at: old });
  const plain = utterance(core, { at: old, percept: spoke });
  const pending = utterance(core, { at: old, hold: 'pending', held: '草稿' });
  const approved = utterance(core, { at: old, hold: 'approved', held: '草稿二' });
  const approvedSent = utterance(core, { at: old, hold: 'approved' });
  const rejected = utterance(core, { at: old, hold: 'rejected' });
  const taint = utterance(core, { at: old, reasons: ['turn-tainted'], percept: tainted });
  const recent = utterance(core, { at: now - 10 * DAY });
  const r = await core.mods.admin.expireLogs(core, now);
  assert.equal(r.deleted.utterances, 3);
  for (const id of [plain, approvedSent, rejected]) assert.equal(has(core, 'utterances', id), false, `删掉 ${id}`);
  for (const id of [pending, approved, taint, recent]) assert.equal(has(core, 'utterances', id), true, `留着 ${id}`);
  assert.deepEqual([...taintedTurnPercepts(core, [spoke, tainted])], [tainted]);
  // 管理页的「审核」「分寸」视图照常列
  assert.equal(core.mods.admin.list(core, { view: 'holds', holdStatus: 'pending' }).total, 1);
  assert.ok(core.mods.admin.list(core, { view: 'blocked' }).items.length >= 1);
  assert.ok(core.mods.admin.list(core, { view: 'injections' }).items);
}));

test('配置成 0：那张表不清理；结果和计数在保留期状态里看得到', withCore('logs-off', async (core) => {
  const now = core.now();
  const u = utterance(core, { at: now - 400 * DAY });
  const j = job(core, { kind: 'discretion.told-scan', at: now - 40 * DAY });
  const r = await core.mods.admin.expireLogs(core, now);
  assert.equal(has(core, 'utterances', u), true);
  assert.equal(has(core, 'jobs', j), false);
  assert.equal(r.deleted.utterances, undefined);
  const st = core.mods.admin.retentionState(core).logs;
  assert.equal(st.at, now);
  assert.equal(st.total, 1);
  assert.deepEqual(st.off, ['utterances']);
  assert.equal(st.deleted.jobs, 1);
  assert.equal(core.store.get("SELECT value FROM metrics WHERE name = 'retention.logs.jobs'").value, 1);
}, { retention: { logs: { utterancesDays: 0 } } }));

test('分批：每批一个短事务；中断了下次接着删，结果一样', withCore('logs-batch', async (core) => {
  const now = core.now();
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push(utterance(core, { at: now - 400 * DAY + i }));
  const keep = utterance(core, { at: now - 400 * DAY, hold: 'pending', held: '草稿' });
  let batches = 0;
  const pick = (after, limit) => {
    batches += 1;
    const rows = core.store.all('SELECT id, hold_status FROM utterances WHERE id > ? ORDER BY id LIMIT ?', after, limit);
    return { seen: rows.map((r) => r.id), del: rows.filter((r) => r.hold_status !== 'pending').map((r) => r.id) };
  };
  const first = await expireInBatches(core.store, 'utterances', pick, { batch: 2, maxBatches: 2 });
  assert.deepEqual(first, { deleted: 4, done: false }, '到了批数上限就停，没删完');
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await expireInBatches(core.store, 'utterances', pick, { batch: 2, signal: ac.signal }), { deleted: 0, done: false }, '中断了什么都不删');
  const rest = await expireInBatches(core.store, 'utterances', pick, { batch: 2 });
  assert.equal(rest.done, true);
  assert.equal(rest.deleted, 5);
  assert.ok(batches >= 6);
  assert.equal(core.store.get('SELECT count(*) AS n FROM utterances').n, 1);
  assert.equal(has(core, 'utterances', keep), true);
  // expireLogs 本身也能被中断：中断了的那次不删，下次照常
  for (let i = 0; i < 3; i++) utterance(core, { at: now - 400 * DAY });
  const stop = new AbortController();
  stop.abort();
  const r1 = await core.mods.admin.expireLogs(core, now, { signal: stop.signal });
  assert.equal(r1.done, false);
  assert.equal(core.store.get('SELECT count(*) AS n FROM utterances').n, 4);
  const r2 = await core.mods.admin.expireLogs(core, now);
  assert.equal(r2.done, true);
  assert.equal(r2.deleted.utterances, 3);
}, { retention: { batch: 2 } }));

