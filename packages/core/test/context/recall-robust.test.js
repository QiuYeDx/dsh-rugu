// 回想的稳定性（D117，实测问题 #28）：11-06 的 37 次 context.recall.fault 是工作记忆渲染里的一处崩溃（D110 的 `items[0].l`：
// 「开着的事」那一组一件都没装进来，渲染时取第一件就抛错），而整个回想只有一个 try——这一轮连已经算好的工作记忆都丢了，
// 错误类型只进了不落盘的控制台。这里：
//   1. 复现那个条件：开着的事的来源行（他亲口说的，准入了）自己装进来、那一件没装进来——D110–D112 抛错，D113–D116 不抛但这一行
//      「装进来了」却哪儿都不出现。现在：那一件因为准入没装进来（来源有一行被挡），按 D110 它的来源行也不单独出现（去向 excluded:open-item）；
//      只是名额满了的，这一行照普通的一句出现；
//   2. 工作记忆的选取 / 渲染抛错：不丢整轮，退回每条准入了的一行原话，别的层照给；
//   3. 乱抛错 / 卡住（每一层各来一次）：这一轮照样拿到其余的记忆，契约照样合格，没有一次是「整轮什么都没给」；
//   4. 出错都记得下：按步骤 / 错误类型的计数、最近的出错（只有代码事实，没有内容），宿主报来的等待结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecallLayers } from '../../src/contract/index.js';
import { getMetaJson } from '../../src/store/index.js';
import { withWorld, percept, GROUP, DM, M, H } from './world.js';

const INVOL = { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 };
const sit = (sid, o = {}) => ({ settingId: sid, trigger: 'message', sessionId: null, ...o });
const metric = (core, name) => core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0;
const ids = (out, layer) => out.items.filter((i) => !layer || i.layer === layer).map((i) => i.id);

/** 一行判定记录（和 world 的 gate 一样：每条进她上下文的都对得上一次判定）。 */
function appraise(core, ref, key) {
  const id = Number(ref.slice(1));
  return `ap${Number(core.store.run(`INSERT INTO appraisals(stage, rule, memory_kind, memory_id, setting_key, taint, verdict, at) VALUES (1, 'wm', 'percept', ?, ?, 0, 'share', ?)`,
    id, key, core.now()).lastInsertRowid)}`;
}

const line = (p, o) => ({
  ref: `p${p.id}`, perceptId: p.id, settingKey: o.settingKey, at: o.at, role: o.role ?? 'trigger', actorEntityId: o.actor ?? null, text: o.text,
  A: o.A ?? 1, parts: { B: 0, trigger: 1, topic: 0, open: 0 }, topicSim: 0, focusSim: 0, open: !!o.open, intentionIds: [], context: [],
  primary: o.primary ?? true, anchor: false, exchange: '', unitKey: o.unitKey ?? null,
});
const unit = (o) => ({
  key: o.key, settingKey: o.settingKey, kind: o.kind ?? 'talk', members: o.members, root: o.root ?? null, core: o.core ?? o.members.slice(-1), B: o.B ?? 1,
  newestAt: o.newestAt ?? 0, newerThanHere: false, hereAt: null, latestRoot: false, replacedRef: null, replacedHere: false, fallback: false, replaced: false,
  ...(o.sources ? { sources: o.sources } : {}), ...(o.due != null ? { due: o.due, overdue: 0 } : {}),
});

/**
 * 工作记忆的替身：retrieve.workingSet 给 w.ws；discretion.admitWorking 准入 w.ws 里的行，w.blocked 里的挡掉。
 * 另带一个普通回想的候选（a1）和它的正文。
 */
function wmMods(state) {
  return {
    retrieve: {
      workingSet: () => { if (state.throws.workingSet) throw new TypeError('替身故障：workingSet'); return state.ws ?? { lines: [], units: [] }; },
    },
    discretion: {
      admitWorking: (core, items, target) => {
        if (state.throws.admitWorking) throw new TypeError('替身故障：admitWorking');
        const key = target.audience.settingKey;
        return {
          items: items.filter((i) => !state.blocked.has(i.ref)).map((i) => ({ ref: i.ref, verdict: 'share', appraisalRef: appraise(core, i.ref, key), label: state.label ?? {} })),
          excluded: items.filter((i) => state.blocked.has(i.ref)).map((i) => ({ ref: i.ref, rule: 'test' })),
        };
      },
    },
    intake: {
      mediaText: (core, text) => { if (state.throws.mediaText) throw new TypeError("Cannot read properties of undefined (reading 'l')"); return String(text ?? ''); },
      drain: () => { if (state.throws.drain) throw new Error('替身故障：drain'); },
    },
    encode: {
      dueIntentions: () => { if (state.throws.dueIntentions) throw new Error('替身故障：dueIntentions'); return []; },
    },
  };
}

/** 主人在私聊里托她办一件事（开着的事），这会儿在群里叫她。 */
function sceneOpen(core, w, state) {
  const now = core.now();
  const owner = w.ids.owner;
  const ask = { id: percept(core, w, { sid: DM, actor: owner, addressed: 'to-her', text: '明天早上提醒我交周报', at: now - 2 * H }) };
  const ok = { id: percept(core, w, { sid: DM, self: true, text: '好的，记下了', at: now - 2 * H + M }) };
  percept(core, w, { sid: GROUP, actor: owner, addressed: 'to-her', text: '在吗', at: now });
  const dm = w.key(DM);
  state.ws = {
    triggerEntityId: owner, people: [], candidates: 2, aboveTau: 2, lastHereAt: null,
    lines: [
      line(ask, { settingKey: dm, at: now - 2 * H, actor: owner, text: '明天早上提醒我交周报', A: 2, unitKey: 'open:i1', open: true }),
      line(ok, { settingKey: dm, at: now - 2 * H + M, role: 'reply', text: '好的，记下了', A: 1, unitKey: 'open:i1', open: true, primary: false }),
    ],
    units: [unit({ key: 'open:i1', kind: 'open', settingKey: dm, members: [`p${ask.id}`, `p${ok.id}`], core: [`p${ask.id}`], sources: [`p${ask.id}`, `p${ok.id}`],
      due: now + 10 * H, newestAt: now - 2 * H + M })],
  };
  return { ask, ok };
}

/** 主人刚在私聊里跟她聊了两句（闲聊段），这会儿在群里叫她；普通回想另有一条 a1。 */
function sceneTalk(core, w, state) {
  const now = core.now();
  const owner = w.ids.owner;
  const p1 = { id: percept(core, w, { sid: DM, actor: owner, addressed: 'to-her', text: '我下周去杭州出差', at: now - 20 * M }) };
  const p2 = { id: percept(core, w, { sid: DM, self: true, text: '去几天呀', at: now - 19 * M }) };
  percept(core, w, { sid: GROUP, actor: owner, addressed: 'to-her', text: '在吗', at: now });
  const dm = w.key(DM);
  state.ws = {
    triggerEntityId: owner, people: [], candidates: 2, aboveTau: 2, lastHereAt: null,
    lines: [
      line(p1, { settingKey: dm, at: now - 20 * M, actor: owner, text: '我下周去杭州出差', A: 2, unitKey: 'talk:1' }),
      line(p2, { settingKey: dm, at: now - 19 * M, role: 'reply', text: '去几天呀', A: 1.5, unitKey: 'talk:1' }),
    ],
    units: [unit({ key: 'talk:1', settingKey: dm, members: [`p${p1.id}`, `p${p2.id}`], core: [`p${p1.id}`, `p${p2.id}`], newestAt: now - 19 * M })],
  };
  w.candidates = ['a1'];
  w.texts.set('a1', '上次团建去了湖边');
  return { p1, p2 };
}

function newState() { return { ws: null, blocked: new Set(), throws: {} }; }
function stateWorld(fn) {
  const state = newState();
  return withWorld((ctx) => fn({ ...ctx, state }), { mods: wmMods(state) });
}

test('#28 复现：开着的事那一件因为准入没装进来（来源有一行被挡）——不抛错，它的来源行也不单独出现（D110），去向记 excluded:open-item，不是「装进来了却没有」', () => stateWorld(async ({ core, w, state }) => {
  const { ok } = sceneOpen(core, w, state);
  state.blocked.add(`p${ok.id}`);   // 她回的那句被挡：这一件（一件一行）不出现
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(validateRecallLayers(out).ok);
  const wm = out.items.filter((i) => i.layer === 'working');
  assert.deepEqual(wm.map((i) => i.id), [], JSON.stringify(wm.map((i) => i.rendered)));
  assert.equal(metric(core, 'wm.continuity.miss.packed-out'), 0, '没有「装进来了却没出现」的');
  assert.equal(metric(core, 'wm.continuity.excluded.open-item'), 1);
  assert.equal(metric(core, 'context.recall.fault'), 0);
}));

test('#28 复现（名额）：开着的事那一件只是名额满了没装进来（open.maxItems = 0），他亲口托的那一句照普通的一句出现', () => {
  const state = newState();
  return withWorld(async ({ core, w }) => {
    const { ask } = sceneOpen(core, w, state);
    const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
    assert.ok(validateRecallLayers(out).ok);
    const wm = out.items.filter((i) => i.layer === 'working');
    assert.deepEqual(wm.map((i) => i.id), [`p${ask.id}`], JSON.stringify(wm.map((i) => i.rendered)));
    assert.match(wm[0].rendered, /明天早上提醒我交周报/);
    assert.doesNotMatch(wm[0].rendered, /他托你的，还没办/, '那一件没装进来：不写成开着的事');
    assert.equal(metric(core, 'wm.continuity.miss.packed-out'), 0, '装进来的都出现了');
    assert.equal(metric(core, 'context.recall.fault'), 0);
  }, { mods: wmMods(state), config: { recall: { working: { open: { maxItems: 0 } } } } });
});

test('#28 对照：那一件装进来了，就是一件一行（来源那一句不再单独多出一行）', () => stateWorld(async ({ core, w, state }) => {
  const { ask } = sceneOpen(core, w, state);
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  const wm = out.items.filter((i) => i.layer === 'working');
  assert.deepEqual(wm.map((i) => i.id), [`p${ask.id}`]);
  assert.match(wm[0].rendered, /他托你的，还没办/);
}));

test('工作记忆的选取 / 渲染抛错（D110–D112 那种）：不丢整轮——退回一行一句的原话，普通回想照给，记 working-select', () => stateWorld(async ({ core, w, state }) => {
  const { p1, p2 } = sceneTalk(core, w, state);
  core.store.run('UPDATE percepts SET media_json = ? WHERE id = ?', JSON.stringify([{ kind: 'image' }]), p1.id);
  state.throws.mediaText = true;
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(validateRecallLayers(out).ok);
  assert.deepEqual(ids(out, 'working').sort(), [`p${p1.id}`, `p${p2.id}`].sort(), '两句都在');
  assert.match(out.items.find((i) => i.id === `p${p1.id}`).rendered, /杭州/);
  assert.ok(ids(out, 'recalled').includes('a1'), '普通回想照给');
  assert.equal(metric(core, 'context.recall.fault.working-select'), 1);
  assert.equal(metric(core, 'context.recall.fault.working-select.TypeError'), 1);
  assert.equal(metric(core, 'context.recall.lost'), 0);
  assert.equal(metric(core, 'context.recall.partial'), 1);
  // 最近的出错：步骤、错误类型、代码位置（文件:行号），没有任何内容
  const ring = getMetaJson(core.store, 'context.recallErrors', []);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].stage, 'working-select');
  assert.equal(ring[0].code, 'TypeError');
  assert.match(String(ring[0].frame), /^(context\/working\.js|.*\.js):\d+$/);
  assert.doesNotMatch(JSON.stringify(ring), /杭州|去几天|团建/);
}));

test('退回一行一句时标签和「在哪儿、当着谁」照写（D113 靠它们让她自己判断）：叮嘱原话、最多说个大概、讲到了谁、私下读到的、在哪儿', () => stateWorld(async ({ core, w, state }) => {
  const { p1 } = sceneTalk(core, w, state);
  state.label = { origin: 'one-on-one', ownerVague: true, selfOnly: 'read', mentions: ['阿明'], limit: { by: null, quote: '别跟别人说' } };
  const normal = await core.mods.context.recall(core, sit(GROUP), INVOL);
  const want = [/他叮嘱过别外传：「别跟别人说」/, /主人定过：在这里最多说个大概/, /讲到了阿明/, /你私下读到的/];
  const r0 = normal.items.find((i) => i.id === `p${p1.id}`)?.rendered ?? '';
  for (const re of want) assert.match(r0, re, `正常渲染：${r0}`);
  core.state.context.cache.clear();
  core.store.run('UPDATE percepts SET media_json = ? WHERE id = ?', JSON.stringify([{ kind: 'image' }]), p1.id);
  state.throws.mediaText = true;
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(metric(core, 'wm.plain'), 1);
  const r1 = out.items.find((i) => i.id === `p${p1.id}`)?.rendered ?? '';
  for (const re of want) assert.match(r1, re, `退回一行一句：${r1}`);
  // 「在哪儿、当着谁」和正常渲染的段头一样
  const where0 = (r0.match(/〔([^·〕]+?)\s*·/) ?? [])[1];
  assert.ok(where0 && r1.includes(`〔${where0}〕`), `${where0} / ${r1}`);
  assert.doesNotMatch(r1, /在别处说的/);
}));

test('退回一行一句时一行的标签写不出来：这一行不给（fail closed），不光着给', () => stateWorld(async ({ core, w, state }) => {
  const { p1, p2 } = sceneTalk(core, w, state);
  // 第一个 mentions 读出来就抛错（标签坏了）；mediaText 抛错让工作记忆走退路
  state.label = { get mentions() { throw new TypeError('标签坏了'); } };
  core.store.run('UPDATE percepts SET media_json = ? WHERE id = ?', JSON.stringify([{ kind: 'image' }]), p1.id);
  state.throws.mediaText = true;
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(validateRecallLayers(out).ok);
  assert.deepEqual(ids(out, 'working').filter((x) => x === `p${p1.id}` || x === `p${p2.id}`), []);
  assert.ok(metric(core, 'context.recall.fault.working-plain-line') >= 1);
  assert.ok(ids(out, 'recalled').includes('a1'), '普通回想照给');
}));

// 每一层各抛一次错 / 卡住一次：这一轮照样拿到其余的记忆
const CHAOS = [
  { name: 'retrieve.recall 抛错', set: ({ w }) => { w.throws['retrieve.recall'] = true; }, wm: true, recalled: false, stage: 'retrieve' },
  { name: 'retrieve.recall 卡住不回', set: ({ w }) => { w.hangs['retrieve.recall'] = true; }, wm: true, recalled: false, stage: 'retrieve', code: 'Timeout' },
  { name: 'retrieve.render 抛错', set: ({ w }) => { w.throws['retrieve.render'] = true; }, wm: true, recalled: false, stage: 'render-item' },
  { name: 'discretion.gate 抛错', set: ({ w }) => { w.throws['discretion.gate'] = true; }, wm: true, recalled: false, stage: 'gate' },
  { name: 'discretion.gate 卡住不回', set: ({ w }) => { w.hangs['discretion.gate'] = true; }, wm: true, recalled: false, stage: 'gate', code: 'Timeout' },
  { name: 'admin.suppressedRefs 抛错', set: ({ w }) => { w.throws['admin.suppressedRefs'] = true; }, wm: true, recalled: false, stage: 'suppress' },
  { name: 'retrieve.looksLikePast 抛错', set: ({ w }) => { w.throws['retrieve.looksLikePast'] = true; }, wm: true, recalled: true, stage: null },
  { name: 'worker.queryWarming 抛错', set: ({ w }) => { w.throws['worker.queryWarming'] = true; }, wm: true, recalled: true, stage: null },
  { name: 'retrieve.workingSet 抛错', set: ({ state }) => { state.throws.workingSet = true; }, wm: false, recalled: true, stage: 'working-set' },
  { name: 'discretion.admitWorking 抛错', set: ({ state }) => { state.throws.admitWorking = true; }, wm: false, recalled: true, stage: 'working-admit' },
  { name: 'intake.drain 抛错', set: ({ state }) => { state.throws.drain = true; }, wm: true, recalled: true, stage: 'drain' },
  { name: 'encode.dueIntentions 抛错', set: ({ state }) => { state.throws.dueIntentions = true; }, wm: true, recalled: true, stage: 'intentions' },
  { name: '库读人物印象抛错', set: ({ core }) => { failSql(core, /entity_impressions/); }, wm: true, recalled: true, stage: 'people' },
  { name: '库读时间间隔抛错', set: ({ core }) => { failSql(core, /ORDER BY id DESC LIMIT 200/); }, wm: true, recalled: true, stage: 'gap' },
  { name: '库读暖启动抛错', set: ({ core }) => { failSql(core, /FROM storylines/); }, wm: true, recalled: true, stage: 'warm' },
];

/** 库在读某一类 SQL 时抛错（磁盘、锁、表坏了之类）。 */
function failSql(core, re) {
  for (const m of ['all', 'get']) {
    const orig = core.store[m].bind(core.store);
    core.store[m] = (sql, ...args) => { if (re.test(sql)) throw Object.assign(new Error('库替身故障'), { code: 'SQLITE_IOERR' }); return orig(sql, ...args); };
  }
}

for (const c of CHAOS) {
  test(`乱抛错：${c.name} → 这一轮照样拿到其余的记忆（工作记忆 ${c.wm ? '在' : '不在'}、普通回想 ${c.recalled ? '在' : '不在'}），契约合格，记在 ${c.stage ?? '（不算出错）'}`, () => stateWorld(async (ctx) => {
    const { core, w, state } = ctx;
    const { p1 } = sceneTalk(core, w, state);
    const sid = 'sess-chaos';
    core.mods.context.bindSession(core, { sessionId: sid, settingId: GROUP, adapterId: 'fake', confidence: 'specific' });
    c.set(ctx);
    const t0 = Date.now();
    const out = await core.mods.context.recall(core, sit(GROUP, { sessionId: sid }), INVOL);
    const took = Date.now() - t0;
    const v = validateRecallLayers(out);
    assert.ok(v.ok, JSON.stringify(v.errors));
    assert.ok(took < 4600, `最多等截止时间 + 余量（直接叫她的一轮，关口①最多等到有意回想的截止 4000 + 250）：${took}ms`);
    assert.equal(ids(out, 'working').includes(`p${p1.id}`), c.wm, `工作记忆：${JSON.stringify(ids(out))}`);
    assert.equal(ids(out, 'recalled').includes('a1'), c.recalled, `普通回想：${JSON.stringify(ids(out))}`);
    assert.equal(metric(core, 'context.recall.lost'), 0, '没有一次整轮什么都没给');
    if (c.stage) {
      assert.ok(metric(core, `context.recall.fault.${c.stage}`) >= 1, `记在 ${c.stage}`);
      if (c.code) assert.ok(metric(core, `context.recall.fault.${c.stage}.${c.code}`) >= 1);
      assert.ok(metric(core, 'context.recall.partial') >= 1);
      const h = core.mods.context.recallHealth(core);
      assert.ok(h.days[0].byStage[c.stage] >= 1, JSON.stringify(h.days[0].byStage));
      assert.equal(h.recent[0].stage, c.stage === 'render-item' ? 'render-item' : h.recent[0].stage);
    } else {
      assert.equal(metric(core, 'context.recall.fault'), 0);
    }
    assert.equal(metric(core, 'context.recall.count'), 1);
  }));
}

test('目标拿不到（判断不了能不能说）：fail closed——只给这个场合这一刻已经判过、缓存着的；没有就什么都不给，记 lost', () => stateWorld(async ({ core, w, state }) => {
  const { p1 } = sceneTalk(core, w, state);
  const first = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(ids(first, 'working').includes(`p${p1.id}`));
  w.throws['discretion.targetFor'] = true;
  const again = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(ids(again, 'working').includes(`p${p1.id}`), '同一刻（之后没有新消息）判过的照给');
  assert.equal(metric(core, 'context.recall.fault.target'), 1);
  assert.equal(metric(core, 'context.recall.lost'), 0);
  // 旁边的人随口说了一句（不是对她说的）：宿主等超时的那条路上工作记忆那一层还能用；目标拿不到时不用它（判它时的目标更早）→ 什么都不给
  percept(core, w, { sid: GROUP, actor: w.ids.ming, addressed: 'ambient', text: '今天好热', at: core.now() });
  assert.ok(ids(core.mods.context.recallCached(core, sit(GROUP)), 'working').includes(`p${p1.id}`), '宿主那条路照旧');
  const lost = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(lost.items, []);
  assert.equal(metric(core, 'context.recall.lost'), 1);
  assert.equal(metric(core, 'context.recall.fault.target'), 2, '每一轮记一次，不在后台再算一遍再记一次');
}));

test('整轮丢了（目标拿不到、缓存里没有）：只记一次出错，不在后台再跑一遍同一条会出错的路', () => stateWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.owner, addressed: 'to-her', text: '在吗', at: core.now() });
  w.cachedSet = { items: [], cues: {} };
  w.throws['discretion.targetFor'] = true;
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(out.items, []);
  assert.equal(metric(core, 'context.recall.lost'), 1);
  assert.equal(metric(core, 'context.recall.fault.target'), 1);
  assert.equal(w.calls.targetFor.filter((p) => p.focusPerceptId != null).length, 1, '回想只判了一次目标（常驻区刷新另算）');
}));

test('有意回想里 retrieve 卡住到点：不再发第二次（卡住的那一次没取消，再发只会一起卡、吃掉关口①的时间）', () => stateWorld(async ({ core, w }) => {
  percept(core, w, { sid: GROUP, actor: w.ids.owner, addressed: 'to-her', text: '在吗', at: core.now() });
  w.hangs['retrieve.recall'] = true;
  const out = await core.mods.context.recall(core, sit(GROUP), { mode: 'deliberate', deadlineMs: 4000, budgetChars: 900 });
  assert.ok(validateRecallLayers(out).ok);
  assert.equal(w.calls.retrieve.length, 1);
  assert.equal(metric(core, 'context.retrieve.retry'), 0);
  assert.equal(metric(core, 'context.recall.fault.retrieve.Timeout'), 1);
}));

test('retrieve 很快就抛错：剩下的时间够就再试一次（计 context.retrieve.retry / retryOk）', () => stateWorld(async ({ core, w, state }) => {
  const { p1 } = sceneTalk(core, w, state);
  let n = 0;
  Object.defineProperty(w.throws, 'retrieve.recall', { get: () => (n += 1) === 1, configurable: true });   // 第一次抛错，之后好了
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.equal(w.calls.retrieve.length, 2);
  assert.ok(ids(out, 'recalled').includes('a1'), '再试拿到了');
  assert.ok(ids(out, 'working').includes(`p${p1.id}`));
  assert.equal(metric(core, 'context.retrieve.retry'), 1);
  assert.equal(metric(core, 'context.retrieve.retryOk'), 1);
}));

test('宿主取消了这一轮：核心马上停下来，取消之后的不算出错（记 context.recall.aborted，不算回想次数、不算 partial）', () => stateWorld(async ({ core, w, state }) => {
  sceneTalk(core, w, state);
  w.hangs['discretion.gate'] = true;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  const out = await core.mods.context.recall(core, sit(GROUP), { ...INVOL, signal: ac.signal });
  assert.ok(Date.now() - t0 < 1500, `取消以后不再等到截止：${Date.now() - t0}ms`);
  assert.ok(validateRecallLayers(out).ok);
  assert.equal(metric(core, 'context.recall.fault'), 0);
  assert.equal(metric(core, 'context.recall.aborted'), 1);
  assert.equal(metric(core, 'context.recall.count'), 0);
  assert.equal(metric(core, 'context.recall.partial'), 0);
}));

test('这个场合不注入（档位 off）：不算一次回想（context.recall.skipped）', () => stateWorld(async ({ core, w }) => {
  w.mode = 'off';
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.deepEqual(out.items, []);
  assert.equal(metric(core, 'context.recall.count'), 0);
  assert.equal(metric(core, 'context.recall.skipped'), 1);
}));

test('升级前的旧计数（context.recall.error，没有明细）单独列成 legacyErrors，不混进现在的出错', () => stateWorld(async ({ core }) => {
  const day = new Date(core.now()).toISOString().slice(0, 10);
  core.store.run('INSERT INTO metrics(day, name, value) VALUES (?, ?, ?)', day, 'context.recall.error', 37);
  const h = core.mods.context.recallHealth(core);
  assert.equal(h.days[0].errors, 0);
  assert.equal(h.days[0].legacyErrors, 37);
  assert.deepEqual(h.days[0].byStage, {});
}));

test('没想到的错（各步之外）：记 fatal，已经写进缓存的工作记忆照给', () => stateWorld(async ({ core, w, state }) => {
  const { p1 } = sceneTalk(core, w, state);
  // 在各步的兜底之外造一个：召回给的候选集读 items 就抛错（形状坏了）
  w.recallResult = { degradeLevel: 0, get items() { throw new TypeError('替身故障：候选集坏了'); } };
  const out = await core.mods.context.recall(core, sit(GROUP), INVOL);
  assert.ok(ids(out, 'working').includes(`p${p1.id}`), JSON.stringify(ids(out)));
  assert.equal(metric(core, 'context.recall.fault.fatal'), 1);
  assert.equal(metric(core, 'context.recall.lost'), 0);
}));

test('宿主报来的等待结果：超时 / 报错进计数和最近的出错（等了多久、退回缓存给了几条）；ok 只计数；耗时分档', () => stateWorld(async ({ core }) => {
  core.mods.context.noteHostRecall(core, 's1', { outcome: 'ok', waitedMs: 120, trigger: 'message' });
  core.mods.context.noteHostRecall(core, 's1', { outcome: 'timeout', waitedMs: 4300, trigger: 'message', served: 3 });
  core.mods.context.noteHostRecall(core, 's1', { outcome: 'error', code: 'ContractError', waitedMs: 2, trigger: 'tool' });
  const h = core.mods.context.recallHealth(core);
  const d = h.days[0];
  assert.equal(d.host.ok, 1);
  assert.equal(d.host.timeout, 1);
  assert.equal(d.host.error, 1);
  assert.equal(d.host.cachedServed, 1);
  assert.equal(d.host.wait.le300, 2);
  assert.equal(d.host.wait.le4500, 1);
  assert.deepEqual(h.recent.map((r) => r.stage), ['host.error', 'host.timeout']);
  assert.equal(h.recent[0].code, 'ContractError');
  assert.equal(h.recent[1].served, 3);
}));

test('最近的出错有上限（context.errorLogMax），新的在前；宿主的等超时另记一份，挤不掉核心各步的出错', () => stateWorld(async ({ core, w, state }) => {
  sceneTalk(core, w, state);
  w.throws['discretion.gate'] = true;
  await core.mods.context.recall(core, sit(GROUP), INVOL);
  for (let i = 0; i < 60; i++) core.mods.context.noteHostRecall(core, 's1', { outcome: 'timeout', waitedMs: i });
  assert.equal(getMetaJson(core.store, 'context.hostRecallErrors', []).length, 50);
  assert.equal(getMetaJson(core.store, 'context.recallErrors', []).length, 1, '核心的那一条还在');
  assert.equal(core.mods.context.recallHealth(core, { recent: 5 }).recent.find((r) => r.stage === 'host.timeout').waitedMs, 59);
  assert.ok(core.mods.context.recallHealth(core, { recent: 50 }).recent.some((r) => r.stage === 'gate'));
}));
