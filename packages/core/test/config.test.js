import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, mergeConfig, createConfig, budgetLimits, toConfigHandle, defaultAt, RETENTION_MS, MODE_RANK, BUDGET_OVERRIDE_KEYS, checkBudgetOverride } from '../src/config/defaults.js';

test('默认值：§6.9 参数表的关键项', () => {
  const a = DEFAULTS.activation;
  assert.deepEqual([a.a, a.c, a.dMax, a.exactTraces, a.ageFloorMin], [0.30, 0.30, 1.0, 8, 3]);
  assert.deepEqual([a.s, a.tauInvoluntary, a.tauDeliberate], [0.4, 0.0, -1.6]);
  assert.equal(a.attention.peripheral, 0.35);
  assert.equal(a.selfRelevance.social, 1.2);
  assert.equal(a.hearsayConfidenceCap, 0.6);
  assert.equal(a.fanSMax, 1.5);
  assert.equal(a.supersededPenalty, 0.8);
  assert.deepEqual([DEFAULTS.intention.boost, DEFAULTS.intention.cueBoost, DEFAULTS.intention.suppression, DEFAULTS.intention.suppressionTauH], [1.0, 0.5, -0.6, 12]);
  assert.equal(DEFAULTS.intention.cooldownH, 48);
  assert.deepEqual([a.events.replay, a.events.replayWithinDays, a.events.replayMaxPerUnit], [0.2, 30, 3]);
  assert.deepEqual([a.events.retellNewAudience, a.events.retellMaxPerUnit], [0.3, 5]);
  assert.deepEqual(a.sourceWindow, { sameMemoryH: 6, sameSourcePerDay: 1 });
  assert.deepEqual([DEFAULTS.validity.presentAbove, DEFAULTS.validity.pastBelow, DEFAULTS.validity.changeKnownFactor], [0.7, 0.3, 0.3]);
  assert.equal(DEFAULTS.mood.halfLifeH, 3);
  // D165：平衡档的基线（随 room 乘，见 test/context/caps.test.js），itemChars 是正文
  assert.deepEqual([DEFAULTS.recall.involuntary.maxItems, DEFAULTS.recall.involuntary.maxChars, DEFAULTS.recall.involuntary.itemChars], [8, 1600, 240]);
  // §9.3.2 的阈值
  assert.deepEqual(DEFAULTS.discretion.thresholds, { b2OmitSensitivity: 0.5, b5Sensitivity: 0.7, b5MaxCloseness: 0.3, a2MaxSensitivity: 0.6, a3MaxSensitivity: 0.3, lateMemberSensitivity: 0.5, unassessedShareMaxSensitivity: 0.5, notTellerShareMaxSensitivity: 0.5 });
  // §12.4.2、§12.6
  assert.deepEqual(DEFAULTS.backup.retention, { daily: 7, weekly: 4, monthly: 12, preOp: 10, export: 12 });
  assert.equal(DEFAULTS.backup.weeklyOnDay, 0, '周包在本地的周日（D19）');
  assert.equal(DEFAULTS.retention.raw, '2y');
  assert.equal(DEFAULTS.retention.coolingOffDays, 7);
  assert.equal(RETENTION_MS.forever, Infinity);
  assert.ok(MODE_RANK.off < MODE_RANK.live);
  assert.deepEqual(Object.keys(MODE_RANK).sort(), ['live', 'off'], '没有影子档（用户反馈第 6 轮）');
  // 每类场合默认都开着：说不说由关口逐条判断，不按场合一刀切（§15.2）
  assert.deepEqual(DEFAULTS.mode, { global: 'live', byAttributes: { principalOneOnOne: 'live', closed: 'live', public: 'live' } });
  assert.ok(Object.isFrozen(DEFAULTS.activation.attention), '默认值深冻结');
});

test('阶段 B 并进来的参数：和设计里写死的数一致', () => {
  const r = DEFAULTS.recall;
  assert.deepEqual([r.render.sureAbove, r.render.hedgeAbove], [0.8, 0.4], '§6.6：> 0.8 直接说，0.4–0.8「好像」');
  assert.deepEqual([r.window.minMsgs, r.window.maxMsgs, r.window.maxChars, r.window.maxGapH], [6, 10, 400, 12], '§8.1 窗口；§10.4 12 小时的间隔');
  assert.ok(r.queryInstruct.startsWith('Instruct: Given an ongoing conversation'), '§8.1 查询端指令');
  assert.ok(r.rewrite.maxCues >= 1 && r.rewrite.maxCues <= 3, '§8.1 改写出 1–3 条线索');
  assert.equal(r.present.maxItems, 15, '§8.2 在场者近况 ≤ 15 条');
  assert.equal(r.ppr.weights.same, 1.0);
  const e = DEFAULTS.embedding;
  assert.ok(e.batch.cpu <= 4 && e.batch.gpu >= 16 && e.batch.gpu <= 64, '§7.6 CPU ≤ 4，GPU 16–64');
  assert.equal(e.dims, null);
  assert.deepEqual(DEFAULTS.worker.ftsMerge, { pages: 200, segments: 8 }, '§7.7 第 10 步 merge=200,8');
  assert.equal(DEFAULTS.extract.maxCandidates, 15, '§5.2 第 4 步最多 15 个候选');
  assert.equal(DEFAULTS.entities.vectorCandidates.max, DEFAULTS.extract.maxCandidates);
  const s = DEFAULTS.sleep;
  assert.deepEqual([s.reflection.maxQuestions, s.reflection.confidenceCap, s.reflection.impThreshold], [3, 0.7, 150], '§7.7 第 4 步');
  assert.ok(s.generalize.maxCalls >= 1 && s.generalize.maxCalls <= 3, '§7.7 第 3 步 1–3 次');
  assert.equal(s.growth.maxChangesPerNight, 1, '§5.7 每次只改一点');
  assert.deepEqual([DEFAULTS.context.layers.gapLines, DEFAULTS.context.resident.autobiographyDays], [2, 2], '§10.4 1–2 行；近两天');
  assert.equal(DEFAULTS.activation.untracedWeight, null, 'null = 跟着 attention.peripheral');
  assert.deepEqual(DEFAULTS.backup.offsiteKinds, ['daily', 'weekly', 'monthly'], '§12.4.3 日包、周包、月包都复制到异地');
});

test('新加的嵌套键：用户配置能改、类型和枚举照查、热加载生效', () => {
  const { config, warnings } = mergeConfig(DEFAULTS, {
    recall: { past: { simMin: 0.6 }, ppr: { weights: { same: 0.9 } }, queryInstruct: '' },
    sleep: { reflection: { deadlineMs: 2000 }, generalize: { windowDays: 'long' } },
    embedding: { dims: 512 },
    backup: { offsiteKinds: ['weekly', 'yearly'], vectorsIn: ['monthly'] },
    worker: { enabled: false },
    activation: { untracedWeight: NaN },
  });
  assert.equal(config.recall.past.simMin, 0.6);
  assert.equal(config.recall.past.simWithCue, DEFAULTS.recall.past.simWithCue, '没给的保持默认');
  assert.equal(config.recall.ppr.weights.same, 0.9);
  assert.equal(config.recall.ppr.weights.maybeSame, DEFAULTS.recall.ppr.weights.maybeSame);
  assert.equal(config.recall.queryInstruct, '', '空串 = 不加查询指令');
  assert.equal(config.sleep.reflection.deadlineMs, 2000, 'null 默认值接受数字');
  assert.equal(config.sleep.generalize.windowDays, 60);
  assert.equal(config.embedding.dims, 512);
  assert.deepEqual(config.backup.offsiteKinds, ['daily', 'weekly', 'monthly'], '数组里有不认识的种类 → 整个忽略');
  assert.deepEqual(config.backup.vectorsIn, ['monthly']);
  assert.equal(config.worker.enabled, false);
  assert.equal(config.activation.untracedWeight, null, 'NaN 不收');
  assert.deepEqual(warnings.map((w) => w.split('：')[0]).sort(), ['activation.untracedWeight', 'backup.offsiteKinds', 'sleep.generalize.windowDays']);

  const cfg = createConfig({});
  const seen = [];
  cfg.onChange((c) => seen.push(c.discretion.told.vectorSim));
  cfg.update({ discretion: { told: { vectorSim: 0.75 } } });
  assert.equal(cfg.get().discretion.told.vectorSim, 0.75);
  assert.equal(cfg.get().discretion.told.scanMinCos, DEFAULTS.discretion.told.scanMinCos);
  assert.deepEqual(seen, [0.75]);
  assert.ok(Object.isFrozen(cfg.get().discretion.told));
});

test('defaultAt：按路径取默认值', () => {
  assert.equal(defaultAt('segment.chunk.maxChars'), 400);
  assert.equal(defaultAt('recall.ppr.weights.outcome'), DEFAULTS.recall.ppr.weights.outcome);
  assert.equal(defaultAt('nope.x'), undefined);
  assert.equal(defaultAt('segment.gapMin.x'), undefined);
});

test('预算：三档预设，默认宽松（§10.6）；单项覆盖', () => {
  const loose = budgetLimits(DEFAULTS);
  assert.equal(loose.mainChatRatioCap, null);
  assert.equal(loose.dailyCalls, 3000);
  assert.equal(loose.dailyUncachedTokens, 5_000_000);
  assert.equal(loose.balanceProtectDays, 1);
  assert.equal(loose.egressReservePerDay, 100);   // D113：只有公开目标还送审
  const { config } = mergeConfig(DEFAULTS, { budget: { preset: 'saving', overrides: { dailyCalls: 800 } } });
  const saving = budgetLimits(config);
  assert.equal(saving.mainChatRatioCap, 0.25);
  assert.equal(saving.dailyCalls, 800);
  assert.equal(saving.balanceProtectDays, 3);
});

test('阶段 B 接线时模块新读的参数键都在 defaults.js 里：主人的配置改得了，不会被 mergeConfig 当未知键丢掉（§0 第 7 条、D25）', () => {
  const user = { review: { maxTokens: 1234 }, intake: { restorePollMs: 777 }, admin: { inheritBatch: 55 }, recall: { background: { plans: 5 } } };
  const warnings = [];
  const c = createConfig(user, { onWarn: (w) => warnings.push(...w) }).get();
  assert.deepEqual([c.review.maxTokens, c.intake.restorePollMs, c.admin.inheritBatch, c.recall.background.plans], [1234, 777, 55, 5]);
  assert.deepEqual(warnings, []);
  // 默认值和模块原来写在代码里的兜底一致（不改行为）
  assert.deepEqual([DEFAULTS.review.maxTokens, DEFAULTS.intake.restorePollMs, DEFAULTS.admin.inheritBatch], [2000, 1000, 200]);
  assert.equal(DEFAULTS.recall.background.plans, DEFAULTS.recall.perEntityMax, '§7.3 S2b：本段说话人还开着的计划最多 3 条');
});

test('模块按路径读的参数（param(core, \'a.b\')、intake 的 opt / param）在 DEFAULTS 里都有：键缺了主人就改不了', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(src);
  const missing = [];
  let seen = 0;
  for (const f of files) {
    // 注释里举的例子不算（只看代码行）
    const text = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    const rel = path.relative(src, f).split(path.sep).join('/');
    // 带点的是从根开始的完整路径（admin、backup、encode 的 param）
    for (const m of text.matchAll(/\bparam\(core, '([a-zA-Z]+(?:\.[a-zA-Z]+)+)'\)/g)) {
      seen += 1;
      if (defaultAt(m[1]) === undefined) missing.push(`${rel}: ${m[1]}`);
    }
    // intake 的 opt / param 读 intake 段里的键
    if (rel.startsWith('intake/')) {
      for (const m of text.matchAll(/\b(?:opt|param)\(core, '([a-zA-Z]+)'\)/g)) {
        seen += 1;
        if (defaultAt(`intake.${m[1]}`) === undefined) missing.push(`${rel}: intake.${m[1]}`);
      }
    }
  }
  assert.ok(seen > 50, `扫到的参数读取太少（${seen}），正则可能对不上代码了`);
  assert.deepEqual(missing, [], '模块在读、defaults.js 里没有的键（要并进 defaults.js，§8「配置项」）');
});

test('合并：类型不对、枚举不对、未知键都忽略并给 warning，不让核心起不来', () => {
  const { config, warnings } = mergeConfig(DEFAULTS, {
    activation: { a: 0.25, s: 'big', attention: { peripheral: 0.4 }, typo: 1 },
    retention: { raw: '10y' },
    mode: { global: 'off', byAttributes: { closed: 'shadow' } },
    budget: { presets: { loose: { mainChatRatioCap: 0.5 } } },
    nope: {},
  });
  assert.equal(config.activation.a, 0.25);
  assert.equal(config.activation.s, 0.4);
  assert.equal(config.activation.attention.peripheral, 0.4);
  assert.equal(config.activation.attention.toHer, 1.0, '没给的保持默认');
  assert.equal(config.retention.raw, '2y');
  assert.equal(config.mode.global, 'off');
  assert.equal(config.mode.byAttributes.closed, 'live', '旧配置里的影子档不再认，用默认档');
  assert.ok(warnings.some((w) => w.startsWith('mode.byAttributes.closed')));
  assert.equal(config.budget.presets.loose.mainChatRatioCap, 0.5, 'null 默认值接受数字');
  assert.equal(warnings.length, 5, warnings.join('\n'));
  assert.ok(warnings.some((w) => w.startsWith('activation.s')));
  assert.ok(warnings.some((w) => w.startsWith('activation.typo')));
  assert.ok(warnings.some((w) => w.startsWith('retention.raw')));
  assert.ok(warnings.some((w) => w.startsWith('nope')));
  assert.equal(mergeConfig(DEFAULTS, { activation: { a: Infinity } }).config.activation.a, 0.30);
});

test('热加载：update / replace 只在真正变化时通知；快照不可变', () => {
  const warns = [];
  const cfg = createConfig({ activation: { a: 0.2 } }, { onWarn: (w) => warns.push(...w) });
  assert.equal(cfg.get().activation.a, 0.2);
  const seen = [];
  const off = cfg.onChange((c) => seen.push(c.activation.a));
  const before = cfg.get();
  cfg.update({ activation: { c: 0.25 } });
  assert.equal(cfg.get().activation.a, 0.2, 'update 是在用户配置上合并，不丢之前的改动');
  assert.equal(cfg.get().activation.c, 0.25);
  assert.equal(before.activation.c, 0.30, '旧快照不受影响');
  cfg.update({ activation: { c: 0.25 } });
  assert.equal(seen.length, 1, '没变化不通知');
  cfg.replace({});
  assert.equal(cfg.get().activation.a, 0.30);
  assert.equal(seen.length, 2);
  off();
  cfg.update({ activation: { a: 0.1 } });
  assert.equal(seen.length, 2);
  cfg.update({ bogus: 1 });
  assert.ok(warns.some((w) => w.startsWith('bogus')));
  assert.throws(() => { cfg.get().activation.a = 9; }, TypeError);
  assert.equal(toConfigHandle(cfg), cfg);
  assert.equal(toConfigHandle({ mood: { halfLifeH: 5 } }).get().mood.halfLifeH, 5);
});

test('预算（D121）：「不设上限」档不设次数、token、比例上限，其余和宽松一样全开，余额保护照留；单项覆盖照样盖在上面', () => {
  const { config, warnings } = mergeConfig(DEFAULTS, { budget: { preset: 'unlimited' } });
  assert.deepEqual(warnings, []);
  const u = budgetLimits(config);
  assert.deepEqual([u.dailyCalls, u.dailyUncachedTokens, u.mainChatRatioCap, u.perSourceShare], [null, null, null, 1]);
  assert.deepEqual([u.stage2Scope, u.prefetchRewrite, u.rerank, u.sleepDepth, u.balanceProtectDays], ['all', true, true, 'full', 1]);
  assert.equal(Object.hasOwn(u, 'dailyOutputTokens'), false, '每天输出的上限没改时不在这里（宿主按每档的数）');
  const o = budgetLimits(mergeConfig(DEFAULTS, { budget: { preset: 'unlimited', overrides: { dailyCalls: 20_000, dailyOutputTokens: null, sleepDepth: 'essential' } } }).config);
  assert.deepEqual([o.dailyCalls, o.dailyOutputTokens, o.sleepDepth, o.dailyUncachedTokens], [20_000, null, 'essential', null]);
  // 不认识的预设名照旧忽略
  assert.equal(mergeConfig(DEFAULTS, { budget: { preset: 'huge' } }).config.budget.preset, 'loose');
});

test('预算（D121）：budget.overrides 只认那几个键、每个按自己的规则查；写错的那一项忽略并给 warning，其余照用', () => {
  assert.deepEqual(BUDGET_OVERRIDE_KEYS, ['dailyCalls', 'dailyUncachedTokens', 'dailyOutputTokens', 'perSourceShare', 'mainChatRatioCap', 'balanceProtectDays', 'stage2Scope', 'prefetchRewrite', 'rerank', 'sleepDepth',
    'injectShare', 'injectPerSessionPerDay', 'room']);
  const { config, warnings } = mergeConfig(DEFAULTS, { budget: { overrides: {
    dailyCalls: 0, dailyUncachedTokens: null, dailyOutputTokens: 1.5, perSourceShare: 0, mainChatRatioCap: null, balanceProtectDays: 400,
    stage2Scope: 'direct', prefetchRewrite: 'no', rerank: false, sleepDepth: 'deep', egressReservePerDay: 3 } } });
  assert.deepEqual(config.budget.overrides, { dailyCalls: 0, dailyUncachedTokens: null, mainChatRatioCap: null, stage2Scope: 'direct', rerank: false });
  assert.deepEqual(warnings.map((w) => w.split('：')[0]).sort(), ['budget.overrides.balanceProtectDays', 'budget.overrides.dailyOutputTokens', 'budget.overrides.egressReservePerDay',
    'budget.overrides.perSourceShare', 'budget.overrides.prefetchRewrite', 'budget.overrides.sleepDepth']);
  assert.equal(checkBudgetOverride('perSourceShare', 1), null);
  assert.match(checkBudgetOverride('nope', 1), /不认识/);
  assert.match(mergeConfig(DEFAULTS, { budget: { overrides: [] } }).warnings[0], /应为对象/);
});

test('注入预算跟着花费档位（D133）：平衡 40%（D165，原来 25%）/ 每天不限（D147），节省 5% / 8000 字（原来的数），效果优先都是 null（不限）', () => {
  const at = (preset) => budgetLimits(mergeConfig(DEFAULTS, { budget: { preset } }).config);
  assert.deepEqual([at('loose').injectShare, at('loose').injectPerSessionPerDay], [0.4, null]);
  assert.deepEqual([at('saving').injectShare, at('saving').injectPerSessionPerDay], [0.05, 8000]);
  assert.deepEqual([at('unlimited').injectShare, at('unlimited').injectPerSessionPerDay], [null, null]);
  assert.deepEqual([budgetLimits(DEFAULTS).injectShare, budgetLimits(DEFAULTS).injectPerSessionPerDay], [0.4, null], '默认平衡');
  // 自定义：单独改、单独设成不限
  const o = budgetLimits(mergeConfig(DEFAULTS, { budget: { preset: 'saving', overrides: { injectShare: 0.1, injectPerSessionPerDay: null } } }).config);
  assert.deepEqual([o.injectShare, o.injectPerSessionPerDay, o.sleepDepth], [0.1, null, 'essential']);
  // 校验：比例要 (0, 1] 或 null；每天的字数要非负整数或 null
  for (const ok of [null, 0.01, 0.5, 1]) assert.equal(checkBudgetOverride('injectShare', ok), null, String(ok));
  for (const bad of [0, -0.1, 1.5, '0.2', Infinity, true]) assert.match(checkBudgetOverride('injectShare', bad), /不超过 1/, String(bad));
  for (const ok of [null, 0, 8000]) assert.equal(checkBudgetOverride('injectPerSessionPerDay', ok), null, String(ok));
  for (const bad of [-1, 1.5, '8000', false]) assert.match(checkBudgetOverride('injectPerSessionPerDay', bad), /整数/, String(bad));
  const { config, warnings } = mergeConfig(DEFAULTS, { budget: { overrides: { injectShare: 2, injectPerSessionPerDay: 12_000 } } });
  assert.deepEqual(config.budget.overrides, { injectPerSessionPerDay: 12_000 });
  assert.deepEqual(warnings.map((w) => w.split('：')[0]), ['budget.overrides.injectShare']);
  // 旧的键（已弃用，D133）还在 DEFAULTS 里：旧配置写了不报未知字段，只是不再起作用
  const old = mergeConfig(DEFAULTS, { context: { rolling: { steps: 30, maxShare: 0.01 }, perSessionPerDay: 100 } });
  assert.deepEqual(old.warnings, []);
  assert.equal(old.config.context.rolling.steps, 30, '滚动窗口的步数照旧有效');
  assert.equal(budgetLimits(old.config).injectPerSessionPerDay, null);
});
