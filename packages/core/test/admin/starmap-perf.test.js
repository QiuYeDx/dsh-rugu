// 【D163】星图的耗时：合成约 2 万颗星的库（带痕迹、几千条想起、说起、心境、几万句原话），量快照和增量各用多少毫秒。
// 目标是快照 < 150 ms、增量 < 5 ms。要防的是「规模上去以后退化」（快照随库变大超线性地变慢、增量变成全表扫）。
// 断言只比同一个进程里、交替着量出来的相对数字，机器忙（全量测试并行跑）时两边一起变慢，不会误报：
//   1. 同样的造法造一个 1/8 大的库，交替量两边的快照：大库 / 小库 < 24 倍（线性约 8 倍，平方级会到几十倍）；
//   2. 大库上增量（每样 200 行）的中位数 < 快照的 1/8（全表扫的话两者差不多）。
// 绝对毫秒数（快照 < 1500 ms、增量 < 100 ms）默认只打印告警；设 RUGU_PERF_STRICT=1 时也断言（在空闲的机器上单独跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminCore } from './fixtures.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 确定性的伪随机（同样的种子同样的库）。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** 造库；scale 只缩放「量」（事实、经历、意图、原话、想起、说起、心境），人和场合的个数不变。 */
function synth(core, { scale = 1, people = 300, settings = 30 } = {}) {
  const n = (x) => Math.max(1, Math.round(x * scale));
  const [assertions, episodes, intentions, percepts, injections, tells, moods] = [14_000, 4_000, 2_000, 40_000, 5_000, 4_000, 3_000].map(n);
  const now = core.now();
  const r = rng(7);
  const pick = (n) => Math.floor(r() * n);
  const run = (sql, ...p) => core.store.run(sql, ...p);
  const keys = [];
  core.store.tx(() => {
    for (let i = 0; i < settings; i++) {
      const key = `perf-sk-${i}`;
      keys.push(key);
      run("INSERT INTO settings(key, adapter, label, stability, first_seen, last_seen) VALUES (?, 'zz', ?, 'persistent', ?, ?)", key, `编的场合${i}`, now, now);
    }
    const ents = [];
    for (let i = 0; i < people; i++) {
      ents.push(Number(run(`INSERT INTO entities(kind, status, display_name, is_self, closeness, authority, created_at, updated_at)
        VALUES ('person', 'established', ?, ?, ?, ?, ?, ?)`, `编的人${i}`, i === 0 ? 1 : 0, r(), i === 1 ? 'principal' : 'none', now, now).lastInsertRowid));
    }
    for (let i = 2; i < people; i += 10) run("INSERT INTO entity_links(a, b, rel, confidence, decided_by, at, created_at) VALUES (?, ?, 'same', 0.9, 'owner', ?, ?)", ents[i], ents[i + 1], now, now);
    for (let i = 0; i < percepts; i++) {
      const at = now - Math.floor(r() * 120 * DAY);
      run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_entity_id, actor_json, kind, text, text_hash, addressed,
             attention, attention_class, evidential, standing, created_at)
           VALUES ('zz', ?, ?, ?, 'setting-audience', ?, ?, ?, '{}', 'utterance', NULL, 'th', ?, 'attended', 'attended', 1, 'first-hand', ?)`,
      `pe${i}`, keys[i % settings], keys[i % settings], at, at, ents[pick(people)], r() < 0.2 ? 'to-her' : 'ambient', now);
    }
    const addTraces = (kind, id, born) => {
      const n = 1 + pick(5);
      for (let k = 0; k < n; k++) run('INSERT INTO traces(owner_kind, owner_id, t, w, d, reason) VALUES (?, ?, ?, ?, ?, ?)', kind, id, born + k * pick(10) * DAY, 0.5 + r(), 0.3 + r() * 0.4, k ? 'mention' : 'encode');
      const bins = r() < 0.3 ? JSON.stringify([{ k: 7, n: 3, w: 2, first: born - 30 * DAY, last: born - 10 * DAY, d: 0.35 }]) : '[]';
      const tier = r() < 0.5 ? 'cold' : r() < 0.5 ? 'warm' : 'hot';
      run('INSERT INTO activation(owner_kind, owner_id, trace_count, b_cache, tier, agg_bins_json) VALUES (?, ?, ?, ?, ?, ?)', kind, id, n, r() * 4 - 3, tier, bins);
    };
    const hints = ['fact', 'fact', 'fact', 'preference', 'plan', 'lesson', 'state'];
    for (let i = 0; i < assertions; i++) {
      const born = now - Math.floor(r() * 300 * DAY);
      const id = Number(run(`INSERT INTO assertions(predicate, text, kind_hint, certainty, imp, recorded_at, created_at, updated_at)
        VALUES ('p', ?, ?, 'stated', ?, ?, ?, ?)`, `编的事实${i}`, hints[pick(hints.length)], 1 + pick(10), born, born, born).lastInsertRowid);
      for (let k = 0; k < 2; k++) run("INSERT INTO sources(owner_kind, owner_id, perceived_in, speaker, mode, confidence, at) VALUES ('assertion', ?, ?, ?, 'told_to_her', 0.8, ?)", id, keys[pick(settings)], ents[pick(people)], born + k * HOUR);
      run("INSERT INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')", id, ents[pick(people)]);
      if (r() < 0.3) run("INSERT OR IGNORE INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'object')", id, ents[pick(people)]);
      addTraces('assertion', id, born);
    }
    const kinds = ['event', 'event', 'event', 'diary', 'summary'];
    for (let i = 0; i < episodes; i++) {
      const born = now - Math.floor(r() * 300 * DAY);
      const parts = [ents[0], ents[pick(people)], ents[pick(people)]];
      const id = Number(run(`INSERT INTO episodes(setting_key, ep_kind, title, narrative, t_start, t_end, participants_json, emotion_json, sealed_at, created_at)
        VALUES (?, ?, '', '编的经历', ?, ?, ?, ?, ?, ?)`, keys[pick(settings)], kinds[pick(kinds.length)], born, born + HOUR, JSON.stringify(parts),
      JSON.stringify({ valence: r() * 2 - 1, intensity: r() }), born, born).lastInsertRowid);
      addTraces('episode', id, born);
    }
    for (let i = 0; i < intentions; i++) {
      const born = now - Math.floor(r() * 100 * DAY);
      const id = Number(run(`INSERT INTO intentions(target_entity_id, act, text, origin, state, formed_at, sources_json, created_at, updated_at)
        VALUES (?, '追问', '编的打算', 'self-care', 'formed', ?, ?, ?, ?)`, ents[pick(people)], born, JSON.stringify([1 + pick(percepts)]), born, born).lastInsertRowid);
      addTraces('intention', id, born);
    }
    for (let i = 0; i < injections; i++) {
      const items = [];
      for (let k = 0; k < 6; k++) items.push({ id: r() < 0.8 ? `a${1 + pick(assertions)}` : `p${1 + pick(percepts)}`, layer: r() < 0.5 ? 'recalled' : 'working', verdict: r() < 0.1 ? 'omit' : 'speak' });
      run('INSERT INTO injections(ts, session_id, cycle, setting_key, layer, nonce, items_json, chars) VALUES (?, ?, 1, ?, ?, ?, ?, 100)',
        now - Math.floor(r() * 60 * DAY), 's', keys[pick(settings)], 'block', `pn${i}`, JSON.stringify(items));
    }
    for (let i = 0; i < tells; i++) {
      run("INSERT INTO told_log(owner_kind, owner_id, at, setting_key, utterance_percept_id, level) VALUES ('assertion', ?, ?, ?, 1, 'full')",
        1 + pick(assertions), now - Math.floor(r() * 60 * DAY), keys[pick(settings)]);
    }
    for (let i = 0; i < moods; i++) run('INSERT INTO mood(at, valence, intensity) VALUES (?, ?, ?)', now - i * HOUR, r() * 2 - 1, r());
    for (let i = 1; i < assertions; i += 200) run("INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES ('assertion', ?, 'hidden', 'owner', ?)", i, now);
  });
}

const time = (fn, n) => {
  fn();   // 预热（语句编译、页缓存）
  const ms = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  return { median: ms[Math.floor(n / 2)], min: ms[0], max: ms.at(-1) };
};

/** 交替量两个函数（a、b、a、b……），各取中位数：同一段时间里机器忙闲对两边一样。 */
const timeBoth = (a, b, n) => {
  a(); b();   // 预热
  const ma = [];
  const mb = [];
  for (let i = 0; i < n; i++) {
    let t = performance.now(); a(); ma.push(performance.now() - t);
    t = performance.now(); b(); mb.push(performance.now() - t);
  }
  const st = (ms) => { ms.sort((x, y) => x - y); return { median: ms[Math.floor(n / 2)], min: ms[0], max: ms.at(-1) }; };
  return [st(ma), st(mb)];
};

test('性能：约 2 万颗星的库上快照和增量的耗时（打印实际数字；断言只看相对数字）', { timeout: 300_000 }, async () => {
  const t = await adminCore('sm-perf');
  const small = await adminCore('sm-perf-small');
  try {
    const core = t.core;
    const t0 = performance.now();
    synth(core);
    const buildMs = performance.now() - t0;
    synth(small.core, { scale: 1 / 8 });
    const snap = core.mods.admin.starmap(core, {});
    const snapSmall = small.core.mods.admin.starmap(small.core, {});
    const [snapT, smallT] = timeBoth(() => core.mods.admin.starmap(core, {}), () => small.core.mods.admin.starmap(small.core, {}), 5);
    const since = { inj: Math.max(0, snap.cursor.inj - 200), trace: Math.max(0, snap.cursor.trace - 200), told: Math.max(0, snap.cursor.told - 200) };
    const liveT = time(() => core.mods.admin.starmap(core, { since }), 20);
    const idleT = time(() => core.mods.admin.starmap(core, { since: snap.cursor }), 20);
    const peekT = time(() => core.mods.admin.starmap(core, { peek: snap.stars.rows.slice(0, 24).map((r) => r[0]) }), 20);
    const f = (x) => `${x.median.toFixed(1)} ms（${x.min.toFixed(1)}–${x.max.toFixed(1)}）`;
    const growth = snapT.median / Math.max(0.5, smallT.median);
    const starsRatio = snap.stars.rows.length / snapSmall.stars.rows.length;
    console.log(`[starmap perf] 星 ${snap.stars.rows.length}、痕迹 ${snap.traces.length}、想起 ${snap.recalls.length} 行、说起 ${snap.tells.length}、`
      + `听到 ${snap.heard.length} 格、人 ${snap.people.length}、场合 ${snap.places.length}；造库 ${(buildMs / 1000).toFixed(1)} s；JSON ${(JSON.stringify(snap).length / 1e6).toFixed(2)} MB`);
    console.log(`[starmap perf] 快照 ${f(snapT)}；增量（每样 200 行）${f(liveT)}；增量（没有新的）${f(idleT)}；看一眼 24 颗 ${f(peekT)}`);
    console.log(`[starmap perf] 1/8 的库（星 ${snapSmall.stars.rows.length}）快照 ${f(smallT)}；星多了 ${starsRatio.toFixed(1)} 倍，快照慢了 ${growth.toFixed(1)} 倍`);
    assert.ok(snap.stars.rows.length > 18_000);
    assert.ok(snap.recalls.length > 3000);
    assert.ok(starsRatio > 6, `小库的星数不对：${snapSmall.stars.rows.length}`);
    // 相对数字（机器忙时两边一起慢）
    assert.ok(growth < 24, `快照随规模超线性地变慢：库大 8 倍，快照慢了 ${growth.toFixed(1)} 倍（${snapT.median.toFixed(0)} ms / ${smallT.median.toFixed(0)} ms）`);
    assert.ok(liveT.median < snapT.median / 8, `增量和快照差不多慢了（像是在全表扫）：增量 ${liveT.median.toFixed(1)} ms，快照 ${snapT.median.toFixed(1)} ms`);
    // 绝对数字：默认只告警
    const slow = [];
    if (snapT.median >= 1500) slow.push(`快照太慢：${snapT.median.toFixed(0)} ms（上限 1500）`);
    if (liveT.median >= 100) slow.push(`增量太慢：${liveT.median.toFixed(0)} ms（上限 100）`);
    if (slow.length && process.env.RUGU_PERF_STRICT === '1') assert.fail(slow.join('；'));
    for (const w of slow) console.log(`[starmap perf] 告警（机器忙时会这样；要断言就设 RUGU_PERF_STRICT=1 单独跑）：${w}`);
  } finally { await small.cleanup(); await t.cleanup(); }
});
