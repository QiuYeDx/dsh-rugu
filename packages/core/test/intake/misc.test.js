// 其余导出：observeInternal（§5.6、§9.5 不回流的渠道）、assignEpisode / markAssessed（encode 的批次事务）、
// expireRawText（§12.6、§2.3 原文到期的级联）、recentPercepts、cursor。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ftsSearch } from '../../src/store/fts.js';
import { withIntake, ingest, obs, descriptor, ADAPTER, SELF_ID, T0, M, D } from './helpers.js';

test('observeInternal：她在不回流的渠道说的话走同一条写入路径（FTS、窗口、通知），按 dedupeKey 去重', () => withIntake((t) => {
  const { intake } = t.core.mods;
  const p = { settingKey: t.key('g'), kind: 'self-utterance', text: '我上周去了海边', at: T0, visibleTo: 'setting-audience', appraisalToken: 'tok-1', dedupeKey: 'utt-1' };
  const id = intake.observeInternal(t.core, p);
  assert.ok(id > 0);
  const [row] = t.rows();
  assert.equal(row.id, id);
  assert.equal(row.adapter, ADAPTER);
  assert.equal(row.ext_key, t.core.keys.hash('core', 'utt-1'));
  assert.equal(row.kind, 'self-utterance');
  assert.equal(row.actor_self, 1);
  assert.equal(row.actor_entity_id, SELF_ID);
  assert.equal(row.addressed, 'by-her');
  assert.equal(row.attention_class, 'self');
  assert.equal(row.appraisal_token, 'tok-1');
  assert.equal(row.visible_to, 'setting-audience');
  assert.equal(ftsSearch(t.core.store, row.fts_shard, t.core.mods.lang.queryTerms(t.core, '海边')).length, 1);
  assert.equal(t.calls['discretion.onSelfUtterance'].length, 1);
  assert.equal(t.calls['discretion.onSelfUtterance'][0][0].id, id);
  assert.equal(t.calls['retrieve.onPercepts'].length, 1);
  // 同一个 dedupeKey：返回已有的，不再通知
  assert.equal(intake.observeInternal(t.core, { ...p, text: '别的' }), id);
  assert.equal(t.rows().length, 1);
  assert.equal(t.calls['discretion.onSelfUtterance'].length, 1);
  // 心里想的一律 her-only
  const tid = intake.observeInternal(t.core, { ...p, kind: 'self-thought', visibleTo: 'setting-audience', dedupeKey: 'th-1', text: '有点累' });
  assert.equal(t.core.store.get('SELECT visible_to FROM percepts WHERE id = ?', tid).visible_to, 'her-only');
  // 不合法的参数、没有的场合：抛错（调用方 discretion.outcome 兜住）
  assert.throws(() => intake.observeInternal(t.core, { ...p, kind: 'utterance', dedupeKey: 'x' }), TypeError);
  assert.throws(() => intake.observeInternal(t.core, { ...p, dedupeKey: '' }), TypeError);
  assert.throws(() => intake.observeInternal(t.core, { ...p, settingKey: 'nope', dedupeKey: 'y' }));
}));

test('observeInternal：场合 attending=false 或命中「别记」时不记（返回 0）', () => withIntake((t) => {
  const p = { settingKey: t.key('away'), kind: 'self-utterance', text: '不记', at: T0, visibleTo: 'setting-audience', dedupeKey: 'a' };
  assert.equal(t.core.mods.intake.observeInternal(t.core, p), 0);
  assert.equal(t.rows().length, 0);
}, { settings: { away: descriptor('away', { attending: false }) } }));

test('assignEpisode / markAssessed：只改这两列，可以在调用方的事务里调用', () => withIntake((t) => {
  const { intake } = t.core.mods;
  ingest(t, [obs('g', 'friend', '一'), obs('g', 'friend', '二'), obs('g', 'friend', '三')]);
  const ids = t.rows().map((p) => p.id);
  const before = t.rows();
  t.core.store.tx(() => {
    intake.assignEpisode(t.core, [ids[0], ids[1], ids[1], 'x'], 7);
    intake.markAssessed(t.core, [ids[0]]);
  });
  const after = t.rows();
  assert.deepEqual(after.map((p) => p.episode_id), [7, 7, null]);
  assert.deepEqual(after.map((p) => p.norm_state), ['assessed', 'unassessed', 'unassessed']);
  for (let i = 0; i < 3; i++) {
    const { episode_id: _e, norm_state: _n, ...a } = after[i];
    const { episode_id: _e2, norm_state: _n2, ...b } = before[i];
    assert.deepEqual(a, b);
  }
  assert.throws(() => intake.assignEpisode(t.core, [ids[2]], 0), TypeError);
  assert.doesNotThrow(() => intake.assignEpisode(t.core, [], 0));
  assert.doesNotThrow(() => intake.markAssessed(t.core, /** @type {any} */ (null)));
}));

test('expireRawText（§2.3）：先让 worker 删原文窗口的向量，再把原文置空、text_state=expired、删 FTS 行；情节和事实不动', () => withIntake((t) => {
  const { intake } = t.core.mods;
  const old = T0 - 800 * D;
  ingest(t, [
    obs('g', 'friend', '很久以前的私事', { at: old, media: [{ kind: 'image', summary: '旧照片' }], quote: { excerpt: '旧引用' } }),
    obs('g', 'friend', '很久以前的第二句', { at: old + M }),
  ], { historical: true });
  ingest(t, [obs('g', 'friend', '最近的话', { at: T0 })]);
  intake.flushWindows(t.core, { force: true });
  const [w0] = t.core.store.all('SELECT * FROM raw_windows ORDER BY id');
  assert.ok(w0.text);
  // 记录 dropEmbeddings 被调用那一刻窗口的原文还在（先删向量，再清主库）
  let textAtDrop = null;
  const orig = t.core.mods.worker.dropEmbeddings;
  t.core.mods = { ...t.core.mods, worker: { ...t.core.mods.worker, dropEmbeddings: (core, refs) => {
    textAtDrop = core.store.get('SELECT text FROM raw_windows WHERE id = ?', refs[0].id).text;
    return orig(core, refs);
  } } };
  const shard = t.rows()[0].fts_shard;
  const r = intake.expireRawText(t.core, { before: T0 - 730 * D });
  assert.deepEqual(r, { percepts: 2, windows: 1, done: true });
  assert.ok(textAtDrop);
  const rows = t.rows();
  assert.deepEqual(rows.map((p) => p.text_state), ['expired', 'expired', 'normal']);
  assert.equal(rows[0].text, null);
  assert.equal(rows[2].text, '最近的话');
  assert.deepEqual(JSON.parse(rows[0].media_json), [{ kind: 'image' }]);   // 只留种类
  assert.equal(JSON.parse(rows[0].quote_json).excerpt, undefined);
  assert.equal(ftsSearch(t.core.store, shard, t.core.mods.lang.queryTerms(t.core, '私事')).length, 0);
  assert.equal(ftsSearch(t.core.store, rows[2].fts_shard, t.core.mods.lang.queryTerms(t.core, '最近')).length, 1);
  assert.equal(t.core.store.get('SELECT text FROM raw_windows WHERE id = ?', w0.id).text, null);
  // 可重跑：再来一次什么都不做
  assert.deepEqual(intake.expireRawText(t.core, { before: T0 - 730 * D }), { percepts: 0, windows: 0, done: true });
  // 过期的感知不会再被切进新窗口
  assert.equal(intake.flushWindows(t.core, { force: true }).windows, 0);
  assert.throws(() => intake.expireRawText(t.core, /** @type {any} */ ({})), TypeError);
}));

test('expireRawText 分批：limit 条一批，done=false 时接着跑', () => withIntake((t) => {
  const old = T0 - 800 * D;
  ingest(t, Array.from({ length: 5 }, (_, i) => obs('g', 'friend', `旧${i}`, { at: old + i * 30 * M })), { historical: true });
  let r = t.core.mods.intake.expireRawText(t.core, { before: T0, limit: 2 });
  assert.equal(r.percepts, 2);
  assert.equal(r.done, false);
  let guard = 0;
  while (!r.done && guard++ < 10) r = t.core.mods.intake.expireRawText(t.core, { before: T0, limit: 2 });
  assert.ok(t.rows().every((p) => p.text === null));
}));

test('recentPercepts：一个场合最近的几条，按 id 升序；limit、beforeId、maxChars、kinds', () => withIntake((t) => {
  const { intake } = t.core.mods;
  ingest(t, Array.from({ length: 14 }, (_, i) => obs('g', 'friend', `消息${i + 1}`, { at: T0 + i * M })));
  ingest(t, [obs('g', 'friend', '进群了', { kind: 'presence', evidential: false, at: T0 + 20 * M })]);
  const all = t.rows();
  const ten = intake.recentPercepts(t.core, t.key('g'));
  assert.equal(ten.length, 10);   // 缺省 recall.window.maxMsgs
  assert.deepEqual(ten.map((p) => p.id), all.slice(-10).map((p) => p.id));
  assert.deepEqual(intake.recentPercepts(t.core, t.key('g'), { limit: 3, beforeId: all[5].id }).map((p) => p.text), ['消息3', '消息4', '消息5']);
  assert.deepEqual(intake.recentPercepts(t.core, t.key('g'), { limit: 5, kinds: ['presence'] }).map((p) => p.text), ['进群了']);
  const capped = intake.recentPercepts(t.core, t.key('g'), { limit: 10, maxChars: 8 });
  assert.deepEqual(capped.map((p) => p.text), ['消息14', '进群了']);
  assert.equal(intake.recentPercepts(t.core, t.key('g'), { maxChars: 1 }).length, 1);   // 至少给一条
  assert.deepEqual(intake.recentPercepts(t.core, 'nope'), []);
}));
