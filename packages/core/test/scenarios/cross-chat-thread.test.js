// 跨聊天接着玩（实测问题 #5、#6）：主人在群 A 里定了个规则（「我说一个数字，你回复比它大一的」）、玩了一轮，
// 一分钟后在私聊里只发了一个「3」，再过一会儿在另一个群里 @ 她发「5」。
// 一个字的消息按字面什么都搜不到；「刚才在别处和这个人一来一回的事」靠在场者近况那一路（基础激活排序 + 召回结果里自己的名额
// + 上下文里和「想起来的」同一档分配）成为回想的候选。能不能用由关口①判断，这里不替它定规矩：
//   - 私聊、只有她和主人的群：主人自己就是来源，听的人只有他 → 第一段直接放行（§9.3.2 A1），规则原样给她；
//   - 有别人在的群：规则照样交到关口①面前（有判定记录），说到什么程度由它定（D99）：主人就在这里、是他在跟她说话、
//     内容不敏感，第二段判能说就原样给——而且就在这一轮：第二段比不自主回想的截止时间慢，这一轮也等它（集成层本来就等 3 秒多），
//     或者预取时就先判好了。别人问起主人私聊里说的私事：问的不是说的人，代码照旧封顶到「说个大概」——第二段被带偏、
//     报不敏感也宽不过它；第二段跑不了就不给。
// 工作记忆以后（D100）：主人刚在别处跟她说的规则、她回他的话，每一轮确定地在她心里（working 层，第一段 A1 / A4 / A5，不抽样、不等第二段）；
// 公开场合、说出去就收不回的场合不进工作记忆，照旧走在场者近况和关口①。
// D113：非公开目标的关口①只跑第一段——有别人在的群里，第二段不再判（预取也不判），内容带着来源标签原文进来，说不说由她判断；
// 公开目标、说出去就收不回的场合照旧第一段 + 第二段。
// 真模块：createPersonaMemory + 替身端口 + 假平台（随机命名空间、随机场合属性、随机语言标签），每个平台种子换几把密钥（= 几组抽样噪声）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, discreetJudge, readCards, platformSeeds, FakeLLM, MINUTE } from './presence-world.js';

const SEEDS = platformSeeds();
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };   // 群里也按正式档（实测要的就是最终效果）
const RULE = '我们玩个游戏 我说一个数字 你就回复比这个数字大1的数值';
// 不自主回想带抽样噪声（§6.5）：照 §14.3「失败率 ≤ 1/5」统计，某个平台种子一次都没成算系统性失败
const RUNS = Math.max(4, Math.ceil(24 / SEEDS.length));
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
// 宿主等不自主回想的截止时间（dsh 的 inject.deadlineMs）；第二段的替身比它慢（实测 1.3–5 秒），只在有别人的群里慢
const HOST_DEADLINE_MS = 800;
const SLOW_STAGE2_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 替身模型对「多敏感」的判断（测试替身用；核心里没有这种词表）
const SENSITIVE = /胃溃疡|体检|吃药/;

/**
 * 第二段的替身：照 discreetJudge 判，另外替提炼报分寸（卡片写着「还没仔细想过」时，D99）——日常内容 0.05，私事 0.85；
 * 卡片上写着「这件事就是他自己说的」而且不敏感的 → 能说（他自己把话头带过来的平常内容）。
 * slowIn：目标场合的称呼含这个字样时慢 SLOW_STAGE2_MS（比宿主等不自主回想的时间长）。careless：什么都说能说（测代码的收紧）；
 * lowSens：报什么都不敏感（0，照文档格式回答的被带偏的模型）。
 */
function threadJudge({ slowIn = null, careless = false, lowSens = false, seen = [] } = {}) {
  const base = discreetJudge();
  return async (req) => {
    const { target, cards } = readCards(req);
    if (slowIn && target?.includes(slowIn)) await sleep(SLOW_STAGE2_MS);
    const first = base(req);
    return cards.map((c, i) => {
      seen.push({ ...c, target });
      const sens = lowSens ? 0 : SENSITIVE.test(c.text) ? 0.85 : 0.05;
      const extra = /还没仔细想过这件事的分寸/.test(c.text) ? { sens, limit: 'none' } : {};
      if (careless) return { ...first[i], verdict: 'share', vague: '最近身体有点小状况，在调养', ...extra };
      if (/这件事就是他自己说的/.test(c.text) && sens < 0.5) return { ...first[i], verdict: 'share', ...extra };
      return { ...first[i], ...extra };
    });
  };
}

/** 只有她和主人的一个群（「干净的群」）：照群 A 的属性另加一个场合，成员能列全、只有两个人；适配器 describe 一次。 */
function addCleanGroup(w, seed) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`thread-${seed}`, 'setting', 'clean-group');
  Object.assign(d, { id, label: '另一个小群' });
  d.audience = { ...d.audience, size: 2, membersKnown: 'exact' };
  d.ownership = { ...d.ownership, owner: w.fp.people.principal.actor };
  w.fp.settings.cleanGroup = { id, descriptor: d };
  w.fp.sink.describe(structuredClone(d));
}

const gatedIn = (w, where, perceptId) => w.core.store.all(
  "SELECT verdict FROM appraisals WHERE setting_key = ? AND memory_kind = 'percept' AND memory_id = ?", w.keyOf(where), perceptId);

async function once(seed, run) {
  const w = await openWorld({ seed, run, name: 'thread', config: LIVE, llm: new FakeLLM({ fallback: { appraise: threadJudge({ slowIn: '大群' }) } }) });
  const out = { privateOk: false, cleanOk: false, crowdGated: false, crowdShared: false, detail: '' };
  try {
    addCleanGroup(w, seed);
    await w.flush();
    // 群 A：主人 @ 她定规则，她答应；主人发「1」，她回「2」
    const rule = w.say('smallGroup', 'principal', `@她 ${RULE}`, { addressed: 'mentions-her', attention: 'attended' });
    w.say('smallGroup', 'her', '好呀，来吧');
    w.say('smallGroup', 'principal', '1', { addressed: 'ambient', attention: 'attended' });
    w.say('smallGroup', 'her', '2');
    w.clock.advance(MINUTE);
    // 私聊：只发了一个「3」
    const three = w.say('oneOnOne', 'principal', '3', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    const ruleId = w.perceptOf(rule).id;
    const ruleRef = `p${ruleId}`;
    const r1 = await recallAt(w, 'oneOnOne', three);
    const it1 = r1.items.find((i) => i.id === ruleRef);
    if (it1) {
      assert.equal(it1.layer, 'working', `主人刚才在别处跟她说的进工作记忆：${show(r1.items)}`);
      assert.equal(it1.speak, undefined, 'D113：没有说出口的档位');
      assert.equal(it1.verdict, 'share', '主人自己说的规则再对主人提：第一段放行（§9.3.2 A1）');
      assert.ok(it1.appraisalRef, '每条都对得上一次判定（§9.3.6）');
      assert.match(it1.rendered, /数字/);
      out.privateOk = true;
    } else out.detail += `私聊 degradeLevel=${r1.degradeLevel} ${show(r1.items)}\n`;
    w.say('oneOnOne', 'her', '4');
    w.clock.advance(MINUTE);

    // 只有她和主人的群：@ 她发「5」
    const five = w.say('cleanGroup', 'principal', '@她 5', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    const r2 = await recallAt(w, 'cleanGroup', five);
    const it2 = r2.items.find((i) => i.id === ruleRef);
    if (it2) {
      assert.equal(it2.layer, 'working', show(r2.items));
      assert.equal(it2.verdict, 'share', '听的人只有主人自己（来源本人）：照样直接放行，不因为「这里是群」就不说');
      out.cleanOk = true;
    } else out.detail += `干净的群 判定=${JSON.stringify(gatedIn(w, 'cleanGroup', ruleId))} degradeLevel=${r2.degradeLevel} ${show(r2.items)}\n`;

    // 有别人在的群：主人自己开口了（他在场），规则照样交到关口①面前，说不说、说多少由它定。
    // 第二段比宿主等的截止时间慢：直接对她说的这一轮等它判完（D99），规则这一轮就到她手里
    w.clock.advance(MINUTE);
    w.say('bigGroup', 'stranger', '今天好冷', { addressed: 'ambient', attention: 'peripheral' });
    const six = w.say('bigGroup', 'principal', '@她 6', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    const r3 = await recallAt(w, 'bigGroup', six, { deadlineMs: HOST_DEADLINE_MS });
    out.crowdGated = gatedIn(w, 'bigGroup', ruleId).length > 0;
    if (!out.crowdGated) out.detail += '有别人的群：规则没到关口①\n';
    const it3 = r3.items.find((i) => i.id === ruleRef);
    if (it3) {
      const aud = w.core.mods.discretion.audienceOf(w.core, w.keyOf('bigGroup'), w.clock.now());
      // 工作记忆（A4，D100）：带着来源在她心里；公开场合、说出去就收不回的场合不进工作记忆，照旧经在场者近况和第二段
      assert.equal(it3.layer, aud.publicLike || aud.preSendGate === false ? 'recentFromPresent' : 'working', show(r3.items));
      assert.equal(it3.verdict, 'share', `他自己带过来的平常内容，原样在她心里（不再一刀切封顶）：${show(r3.items)}`);
      assert.match(it3.rendered, /数字/);
      out.crowdShared = true;
    } else if (out.crowdGated) out.detail += `有别人的群 判定=${JSON.stringify(gatedIn(w, 'bigGroup', ruleId))} ${show(r3.items)}\n`;
    return out;
  } finally { await w.close(); }
}

test('跨聊天接着玩：主人在群里定的规则，一分钟后私聊只发「3」、到只有他俩的群 @ 她发「5」，都想得起、能说；有别人的群里交给关口①，同一轮就判完、能说', async (t) => {
  let total = 0;
  const miss = { privateOk: 0, cleanOk: 0, crowdGated: 0, crowdShared: 0 };
  const notes = [];
  for (const seed of SEEDS) {
    await t.test(`seed ${seed}`, async (st) => {
      st.diagnostic(`FAKE_PLATFORM_SEED=${seed}`);
      const mine = { privateOk: 0, cleanOk: 0, crowdGated: 0, crowdShared: 0 };
      for (let run = 0; run < RUNS; run++) {
        const got = await once(seed, run);
        total += 1;
        for (const k of Object.keys(mine)) if (!got[k]) { mine[k] += 1; miss[k] += 1; }
        if (got.detail) notes.push(`seed ${seed} run ${run}:\n${got.detail}`);
      }
      st.diagnostic(`没成的次数：${JSON.stringify(mine)} / ${RUNS}`);
      for (const k of Object.keys(mine)) assert.ok(mine[k] < RUNS, `${k} 一次都没成：${notes.slice(-RUNS).join('')}`);
    });
  }
  t.diagnostic(`没成的次数（合计）：${JSON.stringify(miss)} / ${total}`);
  for (const k of Object.keys(miss)) assert.ok(miss[k] <= Math.floor(total / 5), `${k}：失败率不超过 1/5（§14.3）：${miss[k]}/${total}\n${notes.join('')}`);
});

/** 等后台还在跑的：context 预取时先判的、discretion 第二段的调用（结论写进判定缓存）。 */
async function settle(w) {
  for (let i = 0; i < 5; i++) {
    const ps = [...w.core.state.context.inflight.values(), ...w.core.state.discretion.inflight.values()];
    if (!ps.length) return;
    await Promise.allSettled(ps);
  }
}

test('预取时先判（D99）：主人在有别人的群里 @ 她「5」，感知一到就把第二段判了；这一轮开始时直接用判定缓存，不再等', async (t) => {
  let total = 0;
  let miss = 0;
  const notes = [];
  for (const seed of SEEDS) {
    for (let run = 0; run < 2; run++) {
      total += 1;
      const llm = new FakeLLM({ fallback: { appraise: threadJudge({ slowIn: '大群' }) } });
      const w = await openWorld({ seed, run, name: 'thread-prefetch', config: LIVE, llm });
      try {
        w.say('smallGroup', 'principal', `@她 ${RULE}`, { addressed: 'mentions-her', attention: 'attended' });
        w.say('smallGroup', 'her', '好呀，来吧');
        w.say('smallGroup', 'principal', '1', { addressed: 'ambient', attention: 'attended' });
        w.say('smallGroup', 'her', '2');
        w.clock.advance(2 * MINUTE);
        // 宿主的常驻区每一步都会读：这一次运行里见过这个场合的 SettingId
        w.pm.resident(w.fp.settings.bigGroup.id);
        w.say('bigGroup', 'stranger', '今天好冷', { addressed: 'ambient', attention: 'peripheral' });
        const five = w.say('bigGroup', 'principal', '@她 5', { addressed: 'mentions-her', attention: 'attended' });
        await w.flush();
        const key = w.keyOf('bigGroup');
        const rule = w.core.store.get('SELECT id FROM percepts WHERE text LIKE ? ORDER BY id LIMIT 1', `%${RULE}%`).id;
        // 预取（防抖到点时 intake → retrieve 调的就是它）：候选好了就通知 context 在后台先过关口①
        await w.core.mods.retrieve.prefetch(w.core, key, { full: true });
        await settle(w);
        const aud = w.core.mods.discretion.audienceOf(w.core, key, w.clock.now());
        if (!aud.publicLike && aud.preSendGate !== false) {
          // 非公开目标（D113）：不调第二段——这一轮开始时第一段就给了（工作记忆或在场者近况，带着来源）
          assert.equal(w.core.store.all("SELECT id FROM appraisals WHERE setting_key = ? AND stage = 2", key).length, 0, '非公开目标不调第二段');
          const r0 = await recallAt(w, 'bigGroup', five, { deadlineMs: HOST_DEADLINE_MS });
          const it0 = r0.items.find((i) => i.id === `p${rule}`);
          if (!it0) { miss += 1; notes.push(`seed ${seed} run ${run}: ${show(r0.items)}\n`); continue; }
          assert.equal(it0.verdict, 'share');
          assert.equal(w.core.store.get('SELECT stage FROM appraisals WHERE id = ?', Number(it0.appraisalRef.slice(2))).stage, 1);
          continue;
        }
        const pre = w.core.store.get("SELECT id, verdict FROM appraisals WHERE setting_key = ? AND memory_kind = 'percept' AND memory_id = ? AND stage = 2 ORDER BY id DESC LIMIT 1", key, rule);
        if (!pre) { miss += 1; notes.push(`seed ${seed} run ${run}: 预取时规则没到第二段\n`); continue; }
        assert.equal(pre.verdict, 'share', '预取时就判好了（他自己带过来的平常内容）');
        // 预取在后台等第二段自己的超时：比宿主的截止时间慢也不记「判不完」（gate.deadline、待定行只算这一轮的）
        const deadlines = w.core.store.get("SELECT value FROM metrics WHERE name = 'discretion.gate.deadline'")?.value ?? 0;
        assert.equal(Number(deadlines), 0, '预取时先判的不算到点没判完');
        assert.equal(w.core.store.all("SELECT id FROM discretion_log WHERE kind = 'pending' AND reason = 'deadline'").length, 0);
        // 这一轮开始（宿主只等不自主回想的截止时间也够）：判定缓存命中，用的就是预取时那一行
        const r = await recallAt(w, 'bigGroup', five, { deadlineMs: HOST_DEADLINE_MS });
        const it = r.items.find((i) => i.id === `p${rule}`);
        if (!it) { miss += 1; notes.push(`seed ${seed} run ${run}: ${show(r.items)}\n`); continue; }
        assert.equal(it.verdict, 'share');
        if (it.layer === 'working') {
          // 工作记忆（D100）：第一段就放进她心里（A4），不用等第二段，也就不依赖预取时判没判好
          const row = w.core.store.get('SELECT stage, rule, speak FROM appraisals WHERE id = ?', Number(it.appraisalRef.slice(2)));
          assert.deepEqual([row.stage, row.rule], [1, 'A4'], JSON.stringify(row));
        } else assert.ok(Number(it.appraisalRef.slice(2)) <= pre.id, `用的是预取时的判定：${it.appraisalRef} vs ap${pre.id}`);
      } finally { await settle(w); await w.close(); }
    }
  }
  t.diagnostic(`没成的次数：${miss} / ${total}`);
  assert.ok(miss <= Math.floor(total / 5), `失败率不超过 1/5（§14.3）：${miss}/${total}\n${notes.join('')}`);
});

test('反面（D99 / D113）：主人私聊里说了身体上的私事，群里别人问起——公开目标、说出去就收不回的场合：第二段被带偏也最多给大概、跑不了就不给；非公开的群：还没评估的带着「私下」的来源进来（她判断，原样转述由外发守护挡）', async (t) => {
  let gated = 0;
  let surfaced = 0;
  const modes = ['careless', 'hijacked', 'down'];
  for (const seed of SEEDS) {
    for (const mode of modes) {
      const llm = new FakeLLM({ fallback: { appraise: threadJudge({ careless: true, lowSens: mode === 'hijacked' }) } });
      const w = await openWorld({ seed, name: `thread-private-${mode}`, config: LIVE, llm });
      try {
        const secret = '我上周体检查出胃溃疡了，最近在吃药';
        w.say('oneOnOne', 'principal', secret, { addressed: 'to-her', attention: 'attended' });
        w.say('oneOnOne', 'her', '啊，要好好养着');
        w.clock.advance(3 * MINUTE);
        // 主人也在群里（刚说过话），问的是群里别的人
        w.say('bigGroup', 'principal', '大家晚上好', { addressed: 'ambient', attention: 'attended' });
        const ask = w.say('bigGroup', 'friend', '@她 你主人最近身体还好吗', { addressed: 'mentions-her', attention: 'attended' });
        await w.flush();
        const pid = w.core.store.get('SELECT id FROM percepts WHERE text = ?', secret).id;
        if (mode === 'down') llm.queues.set('appraise', [new Error('stage2 down'), new Error('stage2 down'), new Error('stage2 down')]);
        const r = await recallAt(w, 'bigGroup', ask, { deadlineMs: 3000 });
        const rows = w.core.store.all("SELECT verdict, reason FROM appraisals WHERE setting_key = ? AND memory_kind = 'percept' AND memory_id = ?", w.keyOf('bigGroup'), pid);
        if (rows.length) gated += 1;
        const aud = w.core.mods.discretion.audienceOf(w.core, w.keyOf('bigGroup'), w.clock.now());
        if (!aud.publicLike && aud.preSendGate !== false) {
          // 非公开目标（D113）：第一段之后照常进（还没评估：没有可比的敏感度），带着「你们俩私聊时 / 私下」的来源；不调第二段
          const it = r.items.find((i) => i.id === `p${pid}`);
          if (it) { assert.equal(it.verdict, 'share'); surfaced += 1; }
          assert.ok(rows.every((row) => !/^stage2/.test(row.reason ?? '')), JSON.stringify(rows));
          continue;
        }
        assert.ok(!JSON.stringify(r.items).includes('胃溃疡'), `原话不进她的上下文（${mode}）：${show(r.items)}`);
        // 判定记录：第二段说能说的，落下来的结论也宽不过「说个大概」
        for (const row of rows) assert.ok(row.verdict !== 'share', `问的不是说的人：代码封顶（${mode}）${JSON.stringify(rows)}`);
        const it = r.items.find((i) => i.id === `p${pid}`);
        if (mode === 'down') assert.equal(it, undefined, `第二段不可用：不给内容 ${JSON.stringify(rows)}`);
        else if (it) {
          assert.equal(it.verdict, 'share_vague', `最多说个大概（${mode}）`);
          assert.doesNotMatch(it.rendered, /胃|体检|吃药/);
          surfaced += 1;
        }
      } finally { await settle(w); await w.close(); }
    }
  }
  t.diagnostic(`私事到了关口①的次数：${gated} / ${SEEDS.length * modes.length}；落成大概、交到她手里的：${surfaced}`);
  assert.ok(gated >= SEEDS.length, '大多数时候私事是被想起来、交给关口①的（不是根本没想起来）');
  assert.ok(surfaced >= 1, '「说个大概」那条路真的走到过（不是每次都没交到她手里）');
});
