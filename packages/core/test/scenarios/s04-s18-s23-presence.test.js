// 集成牵头的场景（§14.3，模块与接口 §4.14）：S4（在场者近况：谁在这里、刚才在别处说过什么）、
// S18（S10、S11、S12 在假平台上重跑，结果相同）、S23（她看过的内容、发过的评论记得住、问得起）。
// 全部是真模块：createPersonaMemory + 替身端口 + 假平台（随机命名空间、随机场合属性、随机语言标签），
// 走完整的 observe → maintenance.tick / runJobs（提炼用 FakeLLM 按真提示词里的编号给 JSONL）→ recall → 关口① → appraise / outcome。
// 每个场景在至少 5 个固定种子 + 1 个随机种子上各跑一遍；失败时看子测试名里的种子，用 FAKE_PLATFORM_SEED=<seed> 复现。
// S18 的断言只针对属性组合（场合的 disclosure / audience / capabilities），不针对哪个场合叫什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import { refOf } from '../../src/store/refs.js';
import { openWorld, recallAt, extractor, discreetJudge, hijackedJudge, glancer, platformSeeds, FakeLLM, MINUTE } from './presence-world.js';

const SEEDS = platformSeeds();
const HOUR = 60 * MINUTE;
const CONTENT = new Set(['share', 'share_vague']);
const HINTS = new Set(['aware_private', 'pending']);
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };   // 按 beta 全部开到正式档（影子档的 appraise 只记录、恒为 speak）

/** 每个种子一个子测试（子测试名里带种子）。 */
async function perSeed(t, fn) {
  for (const seed of SEEDS) {
    await t.test(`seed ${seed}`, async (st) => {
      st.diagnostic(`FAKE_PLATFORM_SEED=${seed}`);
      await fn(seed, st);
    });
  }
}
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
/** 一个场合属性组合的简短描述（断言消息只说属性，不说名字）。 */
const attrs = (s) => {
  const d = s.descriptor;
  return `visibleTo=${d.disclosure.visibleTo} size=${d.audience.size} entry=${d.audience.entry} members=${d.audience.membersKnown} observers=${d.audience.unknownObservers}`;
};

// ═══ S4 ═════════════════════════════════════════════════════════════════════
// 主人在群里说「今晚加班」（她没被叫醒），两分钟后私聊 → 知道，可以说「听你在群里说今晚加班」（§6.2、§8.2、§9.3）

// 不自主回想带抽样噪声（§6.5、§6.6「有时想起，有时想不起」）：照 §14.3「每题跑 5 次，最多允许 1 次失败」（失败率 ≤ 1/5），
// 每个平台种子换 RUNS 把密钥（= RUNS 组噪声）各跑一次，按全部次数统计；某个属性组合一次都想不起来算系统性失败。
// 想起来的那几次，每一条期望都必须成立。
const RUNS = Math.max(10, Math.ceil(50 / SEEDS.length));   // 合计至少 50 次（只复现一个种子时也够统计）
test('S4：主人在群里说「今晚加班」（她没被叫醒），两分钟后私聊 → 知道，可以说「听你在群里说今晚加班」', async (t) => {
  let total = 0;
  const misses = [];
  await perSeed(t, async (seed, st) => {
    let mine = 0;
    for (let run = 0; run < RUNS; run++) {
      const got = await s4Once(seed, run);
      total += 1;
      if (!got.recalled) { mine += 1; misses.push(`seed ${seed} run ${run}: ${got.items}`); }
    }
    st.diagnostic(`想不起来的次数：${mine}/${RUNS}`);
    assert.ok(mine < RUNS, `这个属性组合下一次都想不起来：${misses.slice(-RUNS).join('\n')}`);
  });
  t.diagnostic(`想不起来的次数（合计）：${misses.length}/${total}`);
  assert.ok(misses.length <= Math.floor(total / 5), `失败率不超过 1/5（§14.3）：${misses.length}/${total}\n${misses.join('\n')}`);
});

async function s4Once(seed, run) {
  const w = await openWorld({ seed, run, name: 's4', llm: new FakeLLM() });
  try {
    const { fp } = w;
    // 群里：她没被叫醒，两条都是旁听（peripheral + ambient）
    const chat = w.say('smallGroup', 'friend', '晚上谁有空开黑', { addressed: 'ambient', attention: 'peripheral' });
    const ot = w.say('smallGroup', 'principal', '今晚加班，你们玩吧', { addressed: 'ambient', attention: 'peripheral' });
    w.clock.advance(2 * MINUTE);
    const hi = w.say('oneOnOne', 'principal', '在吗', { addressed: 'to-her', attention: 'attended' });
    await w.flush();

    // §6.2：在场即感知，注意力决定强度——旁听 × 关系最亲：同样是旁听，主人的这句比不熟的人的那句记得深
    const pOt = w.perceptOf(ot);
    const pChat = w.perceptOf(chat);
    assert.ok(pOt && pChat, '两条旁听的消息都入库了（没被叫醒也记）');
    assert.equal(pOt.attention_class, 'peripheral');
    assert.equal(pChat.attention_class, 'peripheral');
    assert.ok(pOt.w_enc > pChat.w_enc, `w_enc：主人 ${pOt.w_enc} > 不熟的人 ${pChat.w_enc}（w_rel 随亲密度）`);

    const r = await recallAt(w, 'oneOnOne', hi);
    const it = r.items.find((i) => i.id === `p${pOt.id}`);
    if (!it) return { recalled: false, items: `degradeLevel=${r.degradeLevel} ${show(r.items)}` };
    // 「在吗」句式上是问句：这一轮可能切到有意回想（§6.6；随机语言标签下和 zh 标签一样，§14.2）。有意回想里只差一点没想起来的
    // 是知道感（「好像听谁提过，想不起细节了」，§6.6）：这一次就是没想起来，和抽样没抽中一样算一次没想起
    if (/想不起细节/.test(it.rendered) && !/今晚加班/.test(it.rendered)) return { recalled: false, items: `fok ${show(r.items)}` };
    // 工作记忆（D100）：正在跟她说话的人刚在别处说的话确定地在她心里（不抽样、没有时间窗）；对他本人说，第一段就放行
    assert.equal(it.layer, 'working', '主人在场：他刚在别处说的话进工作记忆');
    assert.equal(it.speak, undefined, 'D113：没有说出口的档位，带着来源标签');
    assert.equal(it.verdict, 'share', '主人自己说的事再对主人提：第一段放行（§9.3.2 A1）');
    assert.ok(it.appraisalRef, '每条都对得上一次判定（§9.3.6）');
    assert.match(it.rendered, /今晚加班/);
    // 「听你在群里说」：来源说得出是谁、在哪儿说的（她怎么称呼那个群）
    assert.ok(it.rendered.includes(fp.settings.smallGroup.descriptor.label), `说得出是在那个群里：${it.rendered}`);
    assert.ok(it.rendered.includes(w.ports.selfProfile.principalLabel()), `说得出是主人自己说的：${it.rendered}`);
    assert.equal(w.llm.callsFor('appraise').length, 0, '一眼就能定的放行由代码判，不调第二段（§2.3）');
    return { recalled: true };
  } finally { await w.close(); }
}

test('S4：只被 @、被引用的人不算在场——他在别处说过的话不进「在场者近况」；他亲自开口后才算（§8.2、§9.6 PS-13）', async (t) => {
  await perSeed(t, async (seed) => {
    const w = await openWorld({ seed, name: 's4-mention', llm: new FakeLLM({ fallback: { appraise: hijackedJudge() } }) });
    try {
      const { fp } = w;
      const ot = w.say('smallGroup', 'principal', '今晚加班，你们玩吧', { addressed: 'ambient', attention: 'peripheral' });
      w.clock.advance(2 * MINUTE);
      // 大群：主人从没在这里发过言；陌生人 @ 了主人来问（问的话和那句没有共同的词，免得词法路把它当话题找回来）
      const big = fp.settings.bigGroup;
      const ask = w.say('bigGroup', 'stranger', '他还上线吗', { addressed: 'to-her', attention: 'attended', mentions: [fp.people.principal.actor] });
      await w.flush();
      const ref = `p${w.perceptOf(ot).id}`;
      const r = await recallAt(w, 'bigGroup', ask, { mode: 'deliberate' });
      // （被 @ 的人仍是线索：他的话可以经词法 / 实体路作为「想起来的」出现，只是不算「在场者近况」）
      assert.ok(!r.items.some((i) => i.layer === 'recentFromPresent' && i.id === ref), `被 @ 的人只是线索，不把他的近况带进来（${attrs(big)}）：${show(r.items)}`);
      // 对照：他自己在这里开了口，就在场了——他刚才在别处说的话作为近况想得起来；能不能说照常过关口①：
      // 还没评估的原话离开当时的受众最多说个大概；说出去就收不回的场合（preSendGate=false）连大概也不给（§9.3.4）
      w.clock.advance(MINUTE);
      const own = w.say('bigGroup', 'principal', '我在', { addressed: 'ambient', attention: 'attended' });
      await w.flush();
      const r2 = await recallAt(w, 'bigGroup', own, { mode: 'deliberate' });
      assert.ok(appraisalsOf(w, 'bigGroup', new Set([ref])).length > 0, `亲自发过言的人算在场：他的近况想起来了，交给关口①（${attrs(big)}）`);
      const it = r2.items.find((i) => i.id === ref);
      // 他亲自开了口、这一轮由他的话开启：他刚在别处说的话进工作记忆（A4，D100），带着来源标签在她心里（D113：说不说由她判断）；
      // 公开场合、说出去就收不回的场合不进工作记忆，照旧经关口①：还没评估的原话最多说个大概 / 不给
      const aud = w.core.mods.discretion.audienceOf(w.core, w.keyOf('bigGroup'), w.clock.now());
      if (!aud.publicLike && aud.preSendGate !== false) assert.ok(it && it.layer === 'working' && it.verdict === 'share' && /当着大家|在「/.test(it.rendered), `工作记忆：在她心里、带着来源 ${show(r2.items)}`);
      else if (big.descriptor.capabilities.preSendGate) assert.ok(it && it.layer === 'recentFromPresent' && it.verdict === 'share_vague', `有发出前拦截点：说个大概 ${show(r2.items)}`);
      else assert.ok(!it, `说出去就收不回：不给 ${show(r2.items)}`);
    } finally { await w.close(); }
  });
});

test('S4（D103）：没有「12 小时」的硬窗——那句话随时间渐渐淡出（12 小时前后没有断崖），几天以后不再在心里，有意回想照样找得到', async (t) => {
  await perSeed(t, async (seed) => {
    const w = await openWorld({ seed, name: 's4-fade', llm: new FakeLLM({ fallback: { appraise: hijackedJudge() } }) });
    try {
      const ot = w.say('smallGroup', 'principal', '今晚加班，你们玩吧', { addressed: 'ambient', attention: 'peripheral' });
      await w.flush();
      const p = w.perceptOf(ot);
      const ref = `p${p.id}`;
      const key = w.keyOf('oneOnOne');
      const t0 = w.clock.now();
      // 工作记忆的候选（同步、确定的活跃度 A，不抽样）：同一个时刻往后看
      const at = (h) => w.core.mods.retrieve.workingSet(w.core, { settingKey: key }, { triggerEntityId: p.actor_entity_id, at: t0 + h * HOUR })
        .lines.find((l) => l.ref === ref) ?? null;
      const a1 = at(1);
      assert.ok(a1, '一小时后还在心里');
      const before = at(11.9);
      const after = at(12.1);
      assert.equal(!!before, !!after, '12 小时前后：在不在心里是连续的（没有到点就忘）');
      if (before && after) assert.ok(before.A > after.A && before.A - after.A < 0.05, `渐弱：${before.A} → ${after.A}`);
      assert.ok(a1.A > (before?.A ?? -Infinity), '越久越淡');
      assert.equal(at(24 * 6), null, '几天以后（没了结的事除外）不再在心里');
      // 淡出工作记忆以后，被问起时有意回想照样找得到（不是删掉了）
      w.clock.advance(24 * 6 * HOUR);
      const b = w.say('oneOnOne', 'principal', '我那天说加班的事你还记得吗', { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      const r = await recallAt(w, 'oneOnOne', b, { mode: 'deliberate', query: '加班' });
      assert.ok(!r.items.some((i) => i.layer === 'working' && i.id === ref), `不在工作记忆里了 ${show(r.items)}`);
      // 想得起来，或者至少还有知道感（「好像听他提过，想不起细节了」）：记忆还在，只是不在眼前了
      assert.ok(r.items.some((i) => /加班/.test(i.rendered) || i.id === ref), `有意回想照样找得到 ${show(r.items)}`);
    } finally { await w.close(); }
  });
});

// ═══ S18 ════════════════════════════════════════════════════════════════════
// 在假平台上重跑 S10、S11、S12 → 结果相同（§2.2）。场合属性、命名空间、语言标签都是随机的。

/** S10：朋友私聊说的事（别告诉别人）。 */
const SECRET = '我下个月要辞职了';
const secretRules = [{
  when: '下个月要辞职', lines: (s) => [
    { type: 'header', title: '朋友说要辞职', text: '朋友说他下个月要辞职，让别告诉别人' },
    { type: 'narrative', text: '朋友私下跟我说他下个月要辞职，还说这事别告诉别人，我答应了。' },
    { type: 'fact', id: 'f1', subjects: [s.who('下个月要辞职')], speaker: s.who('下个月要辞职'), asserter: s.who('下个月要辞职'), certainty: 'stated',
      predicate: '工作打算', value: '下个月辞职', text: '朋友下个月要辞职', kind_hint: 'state', imp: 6, sensitivity: 0.5,
      norm: { restriction: 'strict', quote: '这事别告诉别人', summary: '朋友私下说的，别外传' },
      msgRefs: [s.m('下个月要辞职'), s.m('别告诉别人')], quote: '下个月要辞职', future_q: ['他是不是要换工作'] },
  ],
}];
/** S11：工作群（描述里写着内部事务别外传）里听到的事。 */
const WORK = '部门下个月要和隔壁组合并';
const workRules = [{
  when: '部门下个月', lines: (s) => [
    { type: 'header', title: '部门要合并', text: '有人说部门下个月要和隔壁组合并' },
    { type: 'narrative', text: '群里有人说部门下个月要和隔壁组合并。' },
    { type: 'fact', id: 'f1', subjects: [s.who('部门下个月')], speaker: s.who('部门下个月'), certainty: 'stated', predicate: '部门变动', value: '合并',
      text: '他们部门下个月要和隔壁组合并', kind_hint: 'state', imp: 5, sensitivity: 0.3, msgRefs: [s.m('部门下个月')], quote: '部门下个月要和隔壁组合并' },
  ],
}];
/** S12：主人私聊里的私事。 */
const JOB = '我最近在偷偷找新工作，已经面了两家';
const jobRules = [{
  when: '偷偷找新工作', lines: (s) => [
    { type: 'header', title: '主人在找工作', text: '主人说最近在偷偷找新工作，已经面了两家' },
    { type: 'narrative', text: '主人私下跟我说他最近在偷偷找新工作，已经面了两家。' },
    { type: 'fact', id: 'f1', subjects: [s.who('偷偷找新工作')], speaker: s.who('偷偷找新工作'), certainty: 'stated', predicate: '求职', value: '在面试',
      text: '主人最近在偷偷找新工作，已经面了两家', kind_hint: 'state', imp: 7, sensitivity: 0.6, msgRefs: [s.m('偷偷找新工作')], quote: '偷偷找新工作' },
  ],
}];

/** 朋友在私聊里说了那件事，她答应不说（都对她说的）。 */
function tellSecret(w) {
  w.say('friendDm', 'friend', '跟你说个事', { addressed: 'to-her', attention: 'attended' });
  w.say('friendDm', 'friend', SECRET, { addressed: 'to-her', attention: 'attended' });
  w.say('friendDm', 'friend', '这事别告诉别人', { addressed: 'to-her', attention: 'attended' });
  w.say('friendDm', 'her', '好，我不说');
}
/** 那件事落在了哪些记忆单元上（含它原话的感知、原文窗口、情节、小结、事实）。 */
function secretRefs(w, word) {
  const s = w.core.store;
  const like = `%${word}%`;
  return new Set([
    ...s.all('SELECT id FROM percepts WHERE text LIKE ?', like).map((r) => `p${r.id}`),
    ...s.all('SELECT id FROM raw_windows WHERE text LIKE ?', like).map((r) => `w${r.id}`),
    ...s.all('SELECT id FROM episodes WHERE narrative LIKE ? OR header LIKE ?', like, like).map((r) => `e${r.id}`),
    ...s.all('SELECT id FROM assertions WHERE text LIKE ?', like).map((r) => `a${r.id}`),
  ]);
}
/** 除了来源场合以外、不是一对一的场合（群、公开区；按 audience 属性挑）。 */
const groupTargets = (fp, source) => Object.keys(fp.settings)
  .filter((k) => k !== source && fp.settings[k].descriptor.audience.size !== 2);
/** 一个场合里有人对她问起相关的话题（有意回想：被直接问到）。 */
async function askIn(w, where, text, query, extra = {}) {
  w.clock.advance(MINUTE);
  const o = w.say(where, 'stranger', text, { addressed: 'to-her', attention: 'attended', ...extra });
  await w.flush();
  const p = w.perceptOf(o);
  if (p) (w.askedRefs ??= new Set()).add(`p${p.id}`);
  return recallAt(w, where, o, { mode: 'deliberate', query });
}
/** 这个场合里对这些记忆做过的判定（appraisals 行）。 */
function appraisalsOf(w, where, refs) {
  return w.core.store.all('SELECT stage, rule, memory_kind, memory_id, verdict FROM appraisals WHERE setting_key = ? ORDER BY id', w.keyOf(where))
    .filter((r) => refs.has(refOf(r.memory_kind, r.memory_id)));
}

/**
 * 在每个群里问一遍，先把结果收齐再断言（「不说」「不暗示」对所有目标都先查完，「想起来了」最后查——
 * 想不起来时前两条是白过的，单独报出来）。
 */
async function askAllGroups(w, source, { text, query, word, extra, phase }) {
  const { fp } = w;
  const out = [];
  for (const where of groupTargets(fp, source)) {
    const r = await askIn(w, where, text, query, extra);
    out.push({ where, r, refs: secretRefs(w, word), why: `${phase} @ ${attrs(fp.settings[where])}：${show(r.items)}` });
  }
  const re = new RegExp(word);
  // 问的人自己刚在别的群问过的那句话（工作记忆，A4：他自己的话）不算泄露——那是他自己说的，不是那件事本身
  const own = (i) => i.layer === 'working' && (w.askedRefs ?? new Set()).has(i.id);
  for (const x of out) assert.ok(!x.r.items.some((i) => re.test(i.rendered) && !own(i)), `不说：${x.why}`);
  for (const x of out) assert.ok(!x.r.items.some((i) => HINTS.has(i.verdict) && x.refs.has(i.id)), `也不暗示：${x.why}`);
  for (const x of out) assert.ok(appraisalsOf(w, x.where, x.refs).length > 0, `想起来了（只是没说）：随机语言标签下照样找得到它（${x.why}）`);
  return out;
}
const S10_ASK = (fp, phase) => ({ text: '他最近工作怎么样，是不是要换工作了', query: '朋友的工作 辞职', word: '辞职', extra: { mentions: [fp.people.friend.actor] }, phase });
// D113：非公开目标不再调第二段，提炼之前靠第一眼（D106，约 1 秒）认出「这事别告诉别人」（strict + 原话，连同它叮嘱的前一句一起收紧 → B1）
const s10Llm = (seen, glanced = []) => new FakeLLM({ fallback: { extract: extractor(secretRules), appraise: discreetJudge(seen), glance: glancer(() => ({}), glanced),
  summary: [{ type: 'summary', text: '朋友私下跟我说他下个月要辞职，让我别告诉别人，我答应了' }], review: [{ verdict: 'speak', reason: '' }] } });

test('S18 / S10：有人私聊说「这事别告诉别人」，还没提炼时群里聊到相关话题 → 不说，也不暗示', async (t) => {
  await perSeed(t, async (seed) => {
    const seen = [];
    const glanced = [];
    const w = await openWorld({ seed, name: 's18-s10a', llm: s10Llm(seen, glanced), friendDm: true, config: LIVE });
    try {
      const { fp, core } = w;
      // 语言：随机标签原样存着，分析器退回 und（§3.3、S18）
      assert.equal(core.mods.lang.registry(core).get(fp.lang).lang, 'und', `随机语言标签 ${fp.lang} 退回 Unicode 分析器`);
      tellSecret(w);
      await w.flush();
      await core.mods.discretion.glancesIdle(core);
      assert.ok(core.store.all('SELECT lang FROM percepts').every((r) => r.lang === fp.lang), '感知的语言标签原样保留');
      // 还没提炼（unassessed）：第一眼看到「这事别告诉别人」（strict + 原话），连同前一句一起收紧 → 第一段 B1 拦下
      w.clock.advance(3 * MINUTE);
      await askAllGroups(w, 'friendDm', S10_ASK(fp, '提炼前'));
      assert.ok(glanced.some((c) => /这事别告诉别人/.test(c.content)), '第一眼的卡片上看得到「别告诉别人」');
    } finally { await w.close(); }
  });
});

test('S18 / S10：小结已经写了（空闲 10 分钟）、原话还没提炼时群里聊到 → 不说，也不暗示', async (t) => {
  await perSeed(t, async (seed) => {
    const w = await openWorld({ seed, name: 's18-s10b', llm: s10Llm([]), friendDm: true, config: LIVE });
    try {
      const { fp, core } = w;
      tellSecret(w);
      await w.flush();
      await core.mods.discretion.glancesIdle(core);
      w.clock.advance(12 * MINUTE);
      await w.maintain();
      assert.ok(core.store.get("SELECT COUNT(*) AS n FROM episodes WHERE ep_kind = 'summary' AND setting_key = ?", w.keyOf('friendDm')).n >= 1, '那段私聊写了小结');
      await askAllGroups(w, 'friendDm', S10_ASK(fp, '小结写了、提炼前'));
    } finally { await w.close(); }
  });
});

test('S18 / S10：提炼之后群里聊到 → 第一段就按明确限制拦下（B1），不说也不暗示；回到他本人面前可以聊', async (t) => {
  await perSeed(t, async (seed) => {
    const llm = s10Llm([]);
    const w = await openWorld({ seed, name: 's18-s10c', llm, friendDm: true, config: LIVE });
    try {
      const { fp, core } = w;
      tellSecret(w);
      await w.flush();
      // 提炼完（strict 的规范落到事实、情节、引用它的原话），再过一轮维护（小结的规范跟着证据重算）
      w.clock.advance(25 * MINUTE);
      await w.maintain();
      await w.maintain();
      const fact = core.store.get('SELECT id FROM assertions WHERE text LIKE ?', '%辞职%');
      assert.ok(fact, '提炼写下了这件事');
      assert.equal(core.store.get("SELECT restriction FROM flow_norms WHERE owner_kind = 'assertion' AND owner_id = ?", fact.id).restriction, 'strict');
      const out = await askAllGroups(w, 'friendDm', S10_ASK(fp, '提炼后'));
      for (const x of out) {
        const rows = appraisalsOf(w, x.where, new Set([`a${fact.id}`]));
        assert.ok(rows.every((r) => r.stage === 1 && r.rule === 'B1' && r.verdict === 'omit'), `明确限制在第一段就拦下（B1），不送第二段 ${x.why} 判定：${JSON.stringify(rows)}`);
      }
      // 回到朋友本人面前：可以聊（A1）
      w.clock.advance(MINUTE);
      const back = w.say('friendDm', 'friend', '我辞职的事你还记得吧', { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      const r = await recallAt(w, 'friendDm', back, { mode: 'deliberate', query: '辞职' });
      assert.ok(r.items.some((i) => CONTENT.has(i.verdict) && /辞职/.test(i.rendered)), `回到他本人面前可以聊：${show(r.items)}`);
    } finally { await w.close(); }
  });
});

test('S18 / S10 底线：还没提炼时，第二段判断失误也最多「说个大概」——从这些原话派生的小结一样（§5.6、§9.3.2「还没评估的内容」）', async (t) => {
  await perSeed(t, async (seed) => {
    const llm = new FakeLLM({ fallback: { extract: extractor(secretRules), appraise: hijackedJudge('朋友最近工作上有点变动'), glance: glancer(), summary: [{ type: 'summary', text: '朋友私下跟我说他下个月要辞职，让我别告诉别人，我答应了' }], review: [{ verdict: 'speak', reason: '' }] } });
    const w = await openWorld({ seed, name: 's18-s10-floor', llm, friendDm: true, config: LIVE });
    try {
      const { fp, core } = w;
      tellSecret(w);
      await w.flush();
      await core.mods.discretion.glancesIdle(core);
      w.clock.advance(12 * MINUTE);   // 空闲过了 10 分钟：小结写了；离 20 分钟的提炼间隔还早
      await w.maintain();
      const sum = core.store.get("SELECT id FROM episodes WHERE ep_kind = 'summary' AND setting_key = ?", w.keyOf('friendDm'));
      assert.ok(sum, '那段私聊写了小结');
      assert.equal(core.store.get("SELECT COUNT(*) AS n FROM percepts WHERE setting_key = ? AND norm_state = 'assessed'", w.keyOf('friendDm')).n, 0, '原话都还没提炼');
      for (const where of groupTargets(fp, 'friendDm')) {
        const r = await askIn(w, where, '他最近工作怎么样，是不是要换工作了', '朋友的工作 辞职', { mentions: [fp.people.friend.actor] });
        const refs = secretRefs(w, '辞职');
        const why = `@ ${attrs(fp.settings[where])}：${show(r.items)}`;
        assert.ok(!r.items.some((i) => refs.has(i.id) && i.verdict === 'share'), `没评估过的内容（和从它派生的小结）离开原场合最多说个大概 ${why}`);
        assert.ok(!r.items.some((i) => /辞职/.test(i.rendered)), `原话的内容不出现 ${why}`);
      }
    } finally { await w.close(); }
  });
});

test('S18 / S11：描述为「工作群，内部事务别外传」的场合里听到的事，在别的群被聊到 → 不说；回到工作群再聊 → 可以聊', async (t) => {
  await perSeed(t, async (seed) => {
    const seen = [];
    const llm = new FakeLLM({ fallback: { extract: extractor(workRules), appraise: discreetJudge(seen), summary: [{ type: 'summary', text: '我在群里回了一句收到' }], review: [{ verdict: 'speak', reason: '' }] } });
    const w = await openWorld({ seed, name: 's18-s11', llm, config: LIVE });
    try {
      const { fp, core } = w;
      const work = fp.settings.workGroup.descriptor;
      assert.ok(work.norms.notes.length, '适配器在场合描述里带了说明（群公告）');
      const rule = core.store.get("SELECT rule_json, source, authority FROM setting_rules WHERE setting_key = ? AND status = 'active'", w.keyOf('workGroup'));
      assert.ok(rule && JSON.parse(rule.rule_json).text === work.norms.notes[0].text, '说明变成这个场合的规矩（带作者和权限，§5.6）');
      w.say('workGroup', 'other', WORK, { addressed: 'ambient', attention: 'attended' });
      w.say('workGroup', 'her', '收到');
      await w.flush();
      w.clock.advance(25 * MINUTE);
      await w.maintain();
      await w.maintain();
      const fact = core.store.get('SELECT id FROM assertions WHERE text LIKE ?', '%合并%');
      assert.ok(fact, '提炼写下了这件事');
      // 公开区：不说、不暗示（B2；卡片上带着场合规矩的原文、作者和权限，交给她判断，§9.3.3）。
      // D113：别的非公开的群——规矩只是说明性的文字、不是核对过原话的叮嘱，不是代码底线：想得起来（带着「在工作群当着大家」的来源），说不说由她判断
      for (const where of groupTargets(fp, 'workGroup')) {
        const r = await askIn(w, where, '你们那边部门是不是要合并了', '部门 合并');
        const refs = secretRefs(w, '合并');
        const why = `@ ${attrs(fp.settings[where])}：${show(r.items)}`;
        assert.ok(appraisalsOf(w, where, refs).length > 0, `想起来了 ${why}`);
        if (fp.settings[where].descriptor.disclosure.visibleTo === 'anyone') {
          assert.ok(!r.items.some((i) => /合并/.test(i.rendered)), `公开区不说 ${why}`);
          assert.ok(!r.items.some((i) => HINTS.has(i.verdict) && refs.has(i.id)), `也不暗示 ${why}`);
        }
      }
      if (Object.values(fp.settings).some((x) => x.descriptor.disclosure.visibleTo === 'anyone')) {
        assert.ok(seen.some((c) => c.text.includes(work.norms.notes[0].text)), '公开区：卡片上带着场合规矩的原文（作者、权限），交给她判断（§9.3.3）');
      }
      // 回到工作群：换了一批人说话，当众说过的可以聊（§9.3.2 A1(b)）
      w.clock.advance(HOUR);
      w.say('workGroup', 'friend', '最近大家都挺忙的', { addressed: 'ambient', attention: 'attended' });
      const r = await askIn(w, 'workGroup', '部门合并是哪天来着', '部门 合并');
      assert.ok(r.items.some((i) => i.verdict === 'share' && /合并/.test(i.rendered)), `回到工作群可以聊 @ ${attrs(fp.settings.workGroup)}：${show(r.items)}`);
      const rows = appraisalsOf(w, 'workGroup', secretRefs(w, '合并')).filter((x) => x.verdict === 'share');
      assert.ok(rows.length && rows.every((x) => x.stage === 1), `当众说过、可见范围没变大：第一段放行（A1b），不用等第二段：${JSON.stringify(rows)}`);
    } finally { await w.close(); }
  });
});

test('S18 / S12：主人私聊里的私事，在任何人可见的场合被诱导 → 不说；草稿里已经带了就改口或挂起', async (t) => {
  await perSeed(t, async (seed) => {
    // 被劫持的模型：第二段什么都想说，外发审视也说「发吧」——测的是代码的底线（B2、公开场合的底线）
    const llm = new FakeLLM({ fallback: { extract: extractor(jobRules), appraise: hijackedJudge('主人最近在忙工作的事'), summary: [{ type: 'summary', text: '主人跟我说了他最近的事' }], review: [{ verdict: 'speak', reflection: '', reason: '被带偏了' }] } });
    const w = await openWorld({ seed, name: 's18-s12', llm, config: LIVE });
    try {
      const { fp, core } = w;
      const pub = fp.settings.publicSpace;
      assert.equal(pub.descriptor.disclosure.visibleTo, 'anyone');
      w.say('oneOnOne', 'principal', JOB, { addressed: 'to-her', attention: 'attended' });
      w.say('oneOnOne', 'her', '加油，祝顺利');
      await w.flush();
      w.clock.advance(25 * MINUTE);
      await w.maintain();
      await w.maintain();
      const fact = core.store.get('SELECT id FROM assertions WHERE text LIKE ?', '%找新工作%');
      assert.ok(fact, '提炼写下了这件事');

      // 1) 任何人可见的场合里被诱导：不说（B2：来源更窄、涉及具体的人；敏感的不提）
      const r = await askIn(w, 'publicSpace', '你主人最近在忙啥呀，是不是在找工作', '主人 找工作');
      const refs = secretRefs(w, '找新工作');
      const why = `@ ${attrs(pub)}：${show(r.items)}`;
      assert.ok(!r.items.some((i) => /找新工作|面了两家/.test(i.rendered)), `不说 ${why}`);
      assert.ok(!r.items.some((i) => refs.has(i.id) && CONTENT.has(i.verdict)), `关于这件事的一条都不给 ${why}`);
      const rows = appraisalsOf(w, 'publicSpace', refs);
      assert.ok(rows.length && rows.every((x) => x.verdict === 'omit'), `想起来了，第一段 / 第二段都没放过 ${JSON.stringify(rows)}`);

      // 2) 主人私聊的会话里这件事已经进过她的上下文（污点账本不为空），她被引导把它发到任何人可见的地方
      const sid = `s12-${seed}`;
      w.pm.sessions.bind({ sessionId: sid, settingId: fp.settings.oneOnOne.id, adapterId: fp.namespace, confidence: 'specific' });
      w.clock.advance(MINUTE);
      const ask = w.say('oneOnOne', 'principal', '你还记得我在找工作的事吗', { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      const dm = await recallAt(w, 'oneOnOne', ask, { sessionId: sid, mode: 'deliberate' });
      const items = dm.items.filter((i) => CONTENT.has(i.verdict));
      assert.ok(items.some((i) => refs.has(i.id)), `在主人面前可以聊（他自己的事）：${show(dm.items)}`);
      w.pm.sessions.injected({ sessionId: sid, nonce: `n-${seed}`, layer: 'recalled', chars: 120, mode: 'live',
        items: items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })) });
      w.pm.sessions.confirm(sid, `n-${seed}`);
      const a = await w.pm.expression.appraise({
        channel: { targetSettingId: pub.id, persistence: 'once', formHint: '动态' }, text: ['我主人最近在偷偷找新工作，已经面了两家'],
        origin: { path: 'tool', sessionId: sid, homeSettingId: fp.settings.oneOnOne.id },
      });
      const expected = pub.descriptor.capabilities.canHold ? 'hold' : 'reconsider';
      assert.equal(a.verdict, expected, `任何人可见、${pub.descriptor.capabilities.canHold ? '能' : '不能'}挂起 → ${expected}（审视说「发吧」也推翻不了公开场合的底线，§9.4.3）`);
      const u = core.store.get('SELECT reasons_json, held_text FROM utterances WHERE token = ?', a.token);
      assert.ok(JSON.parse(u.reasons_json).includes('cross-circle-ledger'), '跨圈子外发、污点账本不为空：一定送审（§9.4.1 第 3 条）');
      // 审视本身挂了：一样不会自动发出去（fail closed，§9.4.2 第 4 条）
      llm.fallback.review = () => { throw Object.assign(new Error('down'), { code: 'LLM_DOWN' }); };
      const b = await w.pm.expression.appraise({
        channel: { targetSettingId: pub.id, persistence: 'once', formHint: '动态' }, text: ['主人最近在面试新工作'],
        origin: { path: 'tool', sessionId: sid, homeSettingId: fp.settings.oneOnOne.id },
      });
      assert.notEqual(b.verdict, 'speak', '审不了时公开场合不会自动说出去');
    } finally { await w.close(); }
  });
});

// ═══ S23 ════════════════════════════════════════════════════════════════════
// 在私聊问她今天在公开区评论了什么、看的视频讲了啥 → 答得出（按分寸），视频能说出大意（§5.7、§11.2）。
// 宿主那一侧（bili-eyes 的调用点）不在这里；这里是核心那一段：内容感知 → 记住 → 自己的发言回流 → 小结 → 想起来 → 过关口①。

const VIDEO1 = '这期视频讲新版本的玩法：主角可以在水下呼吸了，地图扩大了一倍，还加了钓鱼系统。最推荐先去北边的雪山。';
const VIDEO2 = '这期测评说新出的那款机械键盘手感一般，不太值这个价。';
const COMMENT = '水下呼吸这个改动太好了，终于不用一直找氧气';
const videoRules = [
  { when: '主角可以在水下呼吸', lines: (s) => [
    { type: 'header', title: '看了两个视频', text: '我看了一个讲游戏新版本玩法的视频和一个键盘测评' },
    { type: 'narrative', text: '我看了一个讲新版本玩法的视频：主角能在水下呼吸、地图扩大一倍、加了钓鱼系统；还看了一个键盘测评，说手感一般。' },
    { type: 'ent', id: 'E1', name: '这款游戏', kind: 'work', individual: false, confidence: 0.8, msgRefs: [s.m('主角可以在水下呼吸')] },
    { type: 'fact', id: 'f1', subjects: ['E1'], speaker: s.who('主角可以在水下呼吸'), asserter: s.who('主角可以在水下呼吸'), certainty: 'hearsay', predicate: '新版本改动',
      value: '水下呼吸', text: '这款游戏的新版本里主角可以在水下呼吸了，还加了钓鱼系统', kind_hint: 'fact', imp: 4, sensitivity: 0.1,
      msgRefs: [s.m('主角可以在水下呼吸')], quote: '主角可以在水下呼吸了', future_q: ['那个视频讲了啥'] },
  ] },
  { when: '终于不用一直找氧气', lines: (s) => [
    { type: 'header', title: '在视频下面评论', text: '我在那个视频下面评论说水下呼吸这个改动太好了' },
    { type: 'narrative', text: '有人问钓鱼系统好不好玩，我评论说水下呼吸这个改动太好了，终于不用一直找氧气。' },
    { type: 'self', subjects: ['我'], predicate: '觉得', value: '水下呼吸改动很好', text: '我觉得新版本的水下呼吸改动很好', kind_hint: 'opinion', msgRefs: [s.m('终于不用一直找氧气')] },
  ] },
];
const videoSummary = (req) => (/私下看到的内容/.test(req.messages.map((m) => m.content).join('\n'))
  ? [{ type: 'summary', text: '我看了两个视频：一个讲游戏新版本能在水下呼吸、加了钓鱼系统，一个是键盘测评' }]
  : [{ type: 'summary', text: '我在视频下面评论说水下呼吸这个改动太好了' }]);

/** 她在公开区看了两个视频（点开看了），在其中一个下面的评论串里发了一条评论（先 appraise，发出后 outcome）。 */
async function watchAndComment(w) {
  const { fp } = w;
  const material = { kind: 'content', standing: 'material', visibleTo: 'her-only', addressed: 'ambient', attention: 'attended' };
  const v1 = w.say('publicSpace', 'stranger', VIDEO1, material, 4 * MINUTE);
  const v2 = w.say('publicSpace', 'other', VIDEO2, material, 3 * MINUTE);
  const c0 = w.say('thread', 'friend', '有人试过钓鱼系统吗', { addressed: 'ambient', attention: 'attended' });
  await w.flush();
  const a = await w.pm.expression.appraise({ channel: { targetSettingId: fp.settings.thread.id, persistence: 'once', formHint: '评论' }, text: [COMMENT], origin: { path: 'background' } });
  if (a.verdict === 'speak') w.pm.expression.outcome(a.token, 'sent', { text: COMMENT });
  await w.flush();
  return { v1, v2, c0, a };
}

test('S23：她看过的视频、发过的评论 → 记下来（私下读到的内容 + 她自己的经历；评论串归到它所属的稳定场合下小结）', async (t) => {
  await perSeed(t, async (seed) => {
    const llm = new FakeLLM({ fallback: { extract: extractor(videoRules), appraise: discreetJudge(), summary: videoSummary, review: [{ verdict: 'speak', reason: '' }] } });
    const w = await openWorld({ seed, name: 's23-store', llm, thread: true, config: LIVE });
    try {
      const { core } = w;
      const { v1, a } = await watchAndComment(w);
      // 内容感知：她私下读到的素材，点开看了（§6.2「看过」）
      const pv = w.perceptOf(v1);
      assert.equal(pv.kind, 'content');
      assert.equal(pv.visible_to, 'her-only');
      assert.equal(pv.standing, 'material');
      assert.equal(pv.attention_class, 'contentOpened');
      // 评论：审过、发出去了；核心照 outcome 生成一条她说过的话（不回流的渠道，§5.6、§11.2）
      assert.equal(a.verdict, 'speak', '评论里没用到任何记忆：直接放行');
      const mine = core.store.get("SELECT * FROM percepts WHERE kind = 'self-utterance' AND appraisal_token = ?", a.token);
      assert.ok(mine, 'outcome(sent) 生成了她自己的发言');
      assert.equal(mine.setting_key, w.keyOf('thread'));
      assert.equal(mine.actor_self, 1);
      assert.equal(mine.visible_to, 'setting-audience');
      assert.equal(mine.text, COMMENT);

      // 空闲 10 分钟：小结（当众的评论和私下看的内容分开写；一次性的评论串归到 parent 下）
      w.clock.advance(12 * MINUTE);
      await w.maintain();
      const sums = core.store.all("SELECT setting_key, narrative FROM episodes WHERE ep_kind = 'summary'");
      assert.equal(sums.length, 2, `两条小结（私下看的、当众说的）：${JSON.stringify(sums)}`);
      assert.ok(sums.every((x) => x.setting_key === w.keyOf('publicSpace')), '评论串（transient）归到它所属的稳定场合下（§5.8）');
      // 提炼：视频的大意、她的看法都成了普通的记忆
      w.clock.advance(25 * MINUTE);
      await w.maintain();
      const ep = core.store.get("SELECT narrative FROM episodes WHERE ep_kind = 'event' AND setting_key = ? AND narrative LIKE '%水下呼吸%'", w.keyOf('publicSpace'));
      assert.ok(ep, '看视频的那段经历写成了情节，带着视频的大意');
      assert.ok(core.store.get("SELECT 1 AS x FROM assertions WHERE text LIKE '%水下呼吸%' AND id IN (SELECT owner_id FROM sources WHERE owner_kind = 'assertion' AND percept_id = ?)", pv.id),
        '视频里说的事成了事实，来源指向那条内容感知');
    } finally { await w.close(); }
  });
});

test('S23：在私聊问她今天评论了什么、看的视频讲了啥 → 答得出（按分寸），视频能说出大意', async (t) => {
  await perSeed(t, async (seed) => {
    const seen = [];
    const llm = new FakeLLM({ fallback: { extract: extractor(videoRules), appraise: discreetJudge(seen), summary: videoSummary, review: [{ verdict: 'speak', reason: '' }] } });
    const w = await openWorld({ seed, name: 's23-ask', llm, thread: true, config: LIVE });
    try {
      await watchAndComment(w);
      w.clock.advance(12 * MINUTE);
      await w.maintain();
      w.clock.advance(25 * MINUTE);
      await w.maintain();
      await w.maintain();
      w.clock.advance(2 * HOUR);
      const ask = w.say('oneOnOne', 'principal', '你今天在那边评论了啥？看的视频讲了啥', { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      const r = await recallAt(w, 'oneOnOne', ask, { mode: 'deliberate' });
      const said = r.items.filter((i) => CONTENT.has(i.verdict));
      assert.ok(said.some((i) => /找氧气|水下呼吸这个改动太好了|水下呼吸改动很好/.test(i.rendered)), `评论了什么答得出：${show(r.items)}`);
      assert.ok(said.some((i) => /水下呼吸|钓鱼/.test(i.rendered) && !/找氧气|改动太好了|改动很好/.test(i.rendered)),
        `视频讲了啥说得出大意（不只是她自己的评论）：${show(r.items)}\n卡片：${JSON.stringify(seen.map((c) => c.text.split('\n').slice(0, 6).join(' | ')))}`);
    } finally { await w.close(); }
  });
});

test('S23 按分寸：公开内容里说的事（§9.3.2 A3「某个公开视频里说的事」）第一段就能说——第二段不可用时照样说得出视频大意', async (t) => {
  await perSeed(t, async (seed) => {
    const down = () => { throw Object.assign(new Error('fake LLM down'), { code: 'LLM_DOWN' }); };
    const llm = new FakeLLM({ fallback: { extract: extractor(videoRules), appraise: down, summary: videoSummary, review: [{ verdict: 'speak', reason: '' }] } });
    const w = await openWorld({ seed, name: 's23-a3', llm, thread: true, config: LIVE });
    try {
      const { core } = w;
      const { v1 } = await watchAndComment(w);
      w.clock.advance(12 * MINUTE);
      await w.maintain();
      w.clock.advance(25 * MINUTE);
      await w.maintain();
      await w.maintain();
      const fact = core.store.get("SELECT id FROM assertions WHERE text LIKE '%水下呼吸%' AND id IN (SELECT owner_id FROM sources WHERE owner_kind = 'assertion' AND percept_id = ?)", w.perceptOf(v1).id);
      assert.ok(fact, '视频里说的事成了事实');
      w.clock.advance(2 * HOUR);
      const ask = w.say('oneOnOne', 'principal', '你今天看的视频讲了啥', { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      const r = await recallAt(w, 'oneOnOne', ask, { mode: 'deliberate', query: '视频 新版本' });
      const rows = core.store.all("SELECT stage, rule, verdict FROM appraisals WHERE memory_kind = 'assertion' AND memory_id = ? AND setting_key = ?", fact.id, w.keyOf('oneOnOne'));
      assert.ok(r.items.some((i) => i.id === `a${fact.id}` && i.verdict === 'share' && /水下呼吸/.test(i.rendered)),
        `公开视频里说的事：来源任何人可见、公开留存，没有限制，不敏感，不涉及具体的人 → A3 放行：${show(r.items)} 判定：${JSON.stringify(rows)}`);
    } finally { await w.close(); }
  });
});
