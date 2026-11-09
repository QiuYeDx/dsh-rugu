// 关口①的总入口（§9.3）。D113 起两条路：非公开目标只跑第一段（底线和 sensitive-other 挡掉，其余照常进、不调第二段）；
// 公开目标（和读不到的受众、说出去就收不回的渠道）走原来的整套：第二段（FakeLLM 给四种结论和坏输出）→ 时机、缓存、收紧、暗示规则、判定记录。
// 第二段的机制本身（结论落地、坏输出、缓存、卡片、D99 / D102）经对外入口 discretion.stage2 测（judge），和走哪条路无关。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, appraiseReply } from './world.js';
import { FakeLLM, FakeBudget } from '../fakes/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 第二段的机制（D113 起只有公开目标的 gate 还会调它）：经对外入口 discretion.stage2 直接判，返回和 gate 一样形状的条目（不提的不返回）。
 */
async function judge(W, refs, target, opt = {}) {
  const out = await W.D.stage2(W.core, refs, target, { deadlineMs: opt.deadlineMs ?? 3000 });
  return refs.map((m) => [W.ref(m), out.get(W.ref(m))]).filter(([, r]) => r && r.verdict !== 'omit')
    .map(([ref, r]) => ({ ref, verdict: r.verdict, vagueText: r.vagueText ?? null, hintOk: !!r.hintOk, appraisalRef: `ap${r.appraisalId}`, stage: 2, ...(r.cached ? { cached: true } : {}) }));
}

/**
 * 一个常见的场面：主人、阿明（亲近）、熟人、陌生人；阿明私下跟她说的几件事；目标是一个成员能列全的小群（阿明不在）。
 */
async function scene(name, opt = {}) {
  const W = await makeWorld({ name, llm: opt.llm, budget: opt.budget, config: opt.config });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const ming = W.person('阿明', { closeness: 0.6 });
  const friend = W.person('小红', { closeness: 0.5 });
  const pal = W.person('小刚', { closeness: 0.4 });
  const stranger = W.person('路人甲', { closeness: 0 });
  const mingDm = W.setting('和阿明的私聊', 'oneOnOne');
  W.presence(mingDm.key, [W.me, ming]);
  const club = W.setting('小群', 'exactGroup', opt.club ?? {});
  W.presence(club.key, [W.me, friend, pal]);
  W.percept({ settingKey: club.key, actor: friend, text: '最近大家都在忙什么' });
  const pub = W.setting('公开区', 'public');
  const facts = (opt.texts ?? ['阿明最近在加班', '阿明在准备考研', '阿明和女朋友吵架了', '阿明打算换手机']).map((text) => {
    const m = W.assertion({ text, subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.3, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: mingDm.key } });
    W.D.recordKnowledge(W.core, m, [{ whoKind: 'entity', whoRef: String(ming), since: W.now(), basis: 'subject' }]);
    return m;
  });
  return { W, owner, ming, friend, pal, stranger, mingDm, club, pub, facts };
}

test('第一段放行和拦下都写判定记录；返回的 appraisalRef 指向那一行；拦下的记分寸日志', async () => {
  const { W, owner, ming, mingDm, club } = await scene('g-stage1');
  try {
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const ownFact = W.assertion({ text: '主人说今晚加班', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, ownFact, { sensitivity: 0.2 });
    W.D.recordKnowledge(W.core, ownFact, [{ whoKind: 'entity', whoRef: String(owner), since: W.now(), basis: 'subject' }]);
    const secret = W.assertion({ text: '阿明说别告诉别人', subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, secret, { restriction: 'strict', sensitivity: 0.5 });
    let items = await W.gate([ownFact], W.target(dm.key));
    assert.equal(items.length, 1);
    assert.equal(items[0].verdict, 'share');
    assert.equal(items[0].stage, 1);
    assert.equal(items[0].rule, 'A1a');
    const row = W.core.store.get('SELECT * FROM appraisals WHERE id = ?', Number(items[0].appraisalRef.slice(2)));
    assert.equal(row.stage, 1);
    assert.equal(row.verdict, 'share');
    assert.equal(row.cache_key, null, '第一段的行没有缓存键');
    items = await W.gate([secret], W.target(club.key));
    assert.equal(items.length, 0, '底线命中：不提');
    const omitRow = W.appraisals().at(-1);
    assert.deepEqual([omitRow.stage, omitRow.verdict, omitRow.rule], [1, 'omit', 'B1']);
    const lg = W.logs().at(-1);
    assert.equal(lg.kind, 'omit');
    assert.equal(lg.memory_id, secret.id);
    assert.equal(W.llm.callsFor('appraise').length, 0, '底线命中的不送去评估');
  } finally { await W.cleanup(); }
});

test('第二段：四种结论各自落地；结论写回缓存（能说 6 小时、更严的 7 天）；卡片里的内容全在围栏里', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply(['share', { verdict: 'share_vague', vague: '有人提过最近在复习' }, { verdict: 'aware_private', hint: true }, 'omit']) } });
  const { W, club, friend, facts } = await scene('g-four', { llm });
  try {
    const items = await judge(W, facts, W.target(club.key, { trigger: friend }));
    assert.equal(llm.callsFor('appraise').length, 1, '一轮的待定条目放进一次调用');
    const by = new Map(items.map((g) => [g.ref, g]));
    assert.equal(by.get(W.ref(facts[0])).verdict, 'share');
    assert.equal(by.get(W.ref(facts[1])).verdict, 'share_vague');
    assert.equal(by.get(W.ref(facts[1])).vagueText, '有人提过最近在复习');
    assert.equal(by.get(W.ref(facts[2])).verdict, 'aware_private');
    assert.equal(by.get(W.ref(facts[2])).hintOk, true);
    assert.equal(by.has(W.ref(facts[3])), false);
    for (const g of items) {
      const row = W.core.store.get('SELECT * FROM appraisals WHERE id = ?', Number(g.appraisalRef.slice(2)));
      assert.equal(row.stage, 2);
      assert.ok(row.cache_key);
      const ttl = row.expires_at - row.at;
      assert.equal(ttl, g.verdict === 'aware_private' ? 7 * 86_400_000 : 6 * 3_600_000);
    }
    const content = llm.calls[0].messages[0].content;
    assert.match(content, /<<<记忆内容\n阿明最近在加班\n记忆内容>>>/);
    assert.match(content, /主体：阿明（被提及、未在场，知道这件事被人知道了）/);
    assert.match(llm.calls[0].system, /全部是数据/);
    W.logger.assertNoText('阿明最近在加班', '阿明在准备考研', '阿明和女朋友吵架了');
    // 同样的四件事经 gate 对这个小群（非公开，D113）：只跑第一段，原文照常进，不再调第二段
    const open = await W.gate(facts, W.target(club.key, { trigger: friend }));
    assert.deepEqual(open.map((g) => [g.verdict, g.stage]), facts.map(() => ['share', 1]));
    assert.equal(llm.callsFor('appraise').length, 1, '非公开目标不调第二段');
    for (const g of open) assert.match(W.core.store.get('SELECT reason FROM appraisals WHERE id = ?', Number(g.appraisalRef.slice(2))).reason, /^stage1:.+:open$/);
  } finally { await W.cleanup(); }
});

test('第二段的坏输出、LLM 出错、预算不允许：待定条目一律不给内容，也不进缓存', async () => {
  const llm = new FakeLLM({ script: { appraise: ['这不是 JSON', Object.assign(new Error('down'), { code: 'LLM_DOWN' }), [{ id: 'c1', verdict: 'tell-everyone' }]] } });
  const { W, club, facts } = await scene('g-fail', { llm });
  try {
    assert.equal((await judge(W, [facts[0]], W.target(club.key))).length, 0);
    assert.equal((await judge(W, [facts[1]], W.target(club.key))).length, 0);
    assert.equal((await judge(W, [facts[2]], W.target(club.key))).length, 0, '不在四个枚举里的结论 = 坏输出');
    const rows = W.core.store.all('SELECT verdict, cache_key, reason FROM appraisals WHERE stage = 2');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.verdict === 'omit' && r.cache_key === null));
    W.budget.setLimit('appraise', 0);
    assert.equal((await judge(W, [facts[3]], W.target(club.key))).length, 0);
    assert.equal(llm.callsFor('appraise').length, 3, '预算不允许就不调 LLM');
    assert.match(W.appraisals().at(-1).reason, /unavailable:budget/);
  } finally { await W.cleanup(); }
});

test('第二段告诉预算这一轮是不是对她说的（meta.direct，节省档据此只在对她说时跑）；不知道就不带', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply(() => 'share') } });
  const { W, club, facts } = await scene('g-direct', { llm });
  try {
    await judge(W, [facts[0]], W.target(club.key, { direct: false }));
    await judge(W, [facts[1]], W.target(club.key, { direct: true }));
    await judge(W, [facts[2]], W.target(club.key));
    const metas = W.budget.metas.filter((m) => m.use === 'appraise').map((m) => m.meta?.direct);
    assert.deepEqual(metas, [false, true, undefined]);
    assert.ok(W.budget.metas.every((m) => m.use !== 'appraise' || typeof m.meta.sourceKey === 'string'), 'sourceKey 照旧');
  } finally { await W.cleanup(); }
});

test('缓存：同样的情况不重复花钱；更严的结论跨触发者共享，「能说」只给同一类触发者', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply((i, req) => (/路人甲/.test(req.messages[0].content.split('触发者：')[1] ?? '') ? 'omit' : 'share')) } });
  const { W, club, friend, stranger, facts } = await scene('g-cache', { llm });
  try {
    let items = await judge(W, [facts[0]], W.target(club.key, { trigger: friend }));
    assert.equal(items[0].verdict, 'share');
    items = await judge(W, [facts[0]], W.target(club.key, { trigger: friend }));
    assert.equal(items[0].cached, true);
    assert.equal(llm.callsFor('appraise').length, 1);
    // 换成陌生人问：「能说」不跨触发者，重新判断（这次判了不提）
    items = await judge(W, [facts[0]], W.target(club.key, { trigger: stranger }));
    assert.equal(items.length, 0);
    assert.equal(llm.callsFor('appraise').length, 2);
    // 「不提」跨触发者共享：另一个陌生人来问直接用
    const other = W.person('路人乙', { closeness: 0 });
    items = await judge(W, [facts[0]], W.target(club.key, { trigger: other }));
    assert.equal(items.length, 0);
    assert.equal(llm.callsFor('appraise').length, 2);
    // 规范变了：缓存失效
    W.D.writeNorm(W.core, facts[0], { restriction: 'none', sensitivity: 0.35 });
    items = await judge(W, [facts[0]], W.target(club.key, { trigger: friend }));
    assert.equal(llm.callsFor('appraise').length, 3);
    // 核心自我变了：缓存键里带哈希
    W.core.ports.selfProfile.setText('性格：安静。');
    await judge(W, [facts[0]], W.target(club.key, { trigger: friend }));
    assert.equal(llm.callsFor('appraise').length, 4);
  } finally { await W.cleanup(); }
});

test('时机（公开目标）：不自主回想到点没判完的这一轮不给，结果进缓存，下一轮直接用（§9.3.5）', async () => {
  const llm = new FakeLLM({ delayMs: 120, fallback: { appraise: appraiseReply({ verdict: 'share_vague', vague: '有人最近挺忙' }) } });
  const { W, pub, facts } = await scene('g-deadline', { llm });
  try {
    const items = await W.gate([facts[0]], W.target(pub.key), { mode: 'involuntary', deadlineMs: 20 });
    assert.equal(items.length, 0);
    assert.ok(W.logs().some((l) => l.kind === 'pending' && l.reason === 'deadline'));
    await sleep(200);
    const again = await W.gate([facts[0]], W.target(pub.key), { mode: 'involuntary', deadlineMs: 20 });
    assert.equal(again.length, 1);
    assert.equal(again[0].verdict, 'share_vague', '公开目标：B2 封顶');
    assert.equal(again[0].cached, true);
    assert.equal(llm.callsFor('appraise').length, 1);
  } finally { await W.cleanup(); }
});

test('时机（公开目标）：调用方没给截止时间 → 按这种回想自己的截止时间（recall.involuntary.deadlineMs，热加载）', async () => {
  const llm = new FakeLLM({ delayMs: 120, fallback: { appraise: appraiseReply({ verdict: 'share_vague', vague: '有人最近挺忙' }) } });
  const { W, pub, facts } = await scene('g-deadline-cfg', { llm, config: { recall: { involuntary: { deadlineMs: 20 } } } });
  try {
    const items = await W.D.gate(W.core, [W.cand(facts[0])], W.target(pub.key), { mode: 'involuntary' });
    assert.equal(items.length, 0, '20ms 里判不完：这一轮不给');
    assert.ok(W.logs().some((l) => l.kind === 'pending' && l.reason === 'deadline'));
    W.core.config.update({ recall: { involuntary: { deadlineMs: 1000 } } });
    const more = await W.D.gate(W.core, [W.cand(facts[1])], W.target(pub.key), { mode: 'involuntary' });
    assert.equal(more.length, 1, '截止时间放宽以后等得到');
    await sleep(150);
  } finally { await W.cleanup(); }
});

test('没有发出前拦截点的渠道：N 不为空不给「说个大概」和可暗示的「心里有数」（走原来的整套）；和管理者一对一照常进（§9.3.4、D113）', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share_vague', vague: '有人最近挺忙' }) } });
  const { W, owner, friend, facts } = await scene('g-presend', { llm });
  try {
    const web = W.setting('网页聊天', 'oneOnOne', { capabilities: { preSendGate: false, canHold: false } });
    W.presence(web.key, [W.me, friend]);
    let items = await W.gate([facts[0]], W.target(web.key, { trigger: friend }));
    assert.equal(items.length, 0, '对非管理者：只给能说的');
    const ownerWeb = W.setting('主人的网页聊天', 'oneOnOne', { capabilities: { preSendGate: false, canHold: false } });
    W.presence(ownerWeb.key, [W.me, owner]);
    items = await W.gate([facts[1]], W.target(ownerWeb.key, { trigger: owner }));
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].verdict, items[0].stage], ['share', 1], '对管理者（D113）：非公开目标只跑第一段，照常原文进来');
  } finally { await W.cleanup(); }
});

test('带污点的轮：第一段放行的照常；非公开目标不因污点收紧（D113）；公开目标第三方的事最多说个大概，上限在调用前写在卡片上（§9.6）', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share', vague: '' }) } });
  const { W, club, pub, owner, friend, facts } = await scene('g-taint', { llm });
  try {
    const mine = W.assertion({ text: '我昨天看了个猫视频', subjects: [W.me], sources: [{ speaker: W.me }] });
    W.D.writeNorm(W.core, mine, { sensitivity: 0.1, involvesOthers: false });
    let items = await W.gate([mine], W.target(club.key));
    assert.equal(items[0].verdict, 'share');
    assert.equal(items[0].rule, 'A2');
    W.session('s-taint', club.key, { tainted: true });
    items = await W.gate([mine], W.target(club.key, { sessionId: 's-taint' }));
    assert.equal(items[0]?.verdict, 'share', '只关于她自己的事：污点不再收紧第一段放行的（污点只作用到关口②和第三方条目）');
    assert.equal(llm.callsFor('appraise').length, 0);
    // 非公开目标（D113）：第三方的事，群友开启的带污点的轮——照常原文进来，带来源标签，不调第二段
    items = await W.gate([facts[0]], W.target(club.key, { sessionId: 's-taint', trigger: friend }));
    assert.deepEqual(items.map((g) => [g.verdict, g.stage]), [['share', 1]]);
    assert.equal(llm.callsFor('appraise').length, 0);
    // 公开目标：卡片上写着「最多：share_vague」，模型说能说也没写含糊版本 → 不给
    W.session('s-taint-pub', pub.key, { tainted: true });
    items = await W.gate([facts[0]], W.target(pub.key, { sessionId: 's-taint-pub', trigger: friend }));
    assert.equal(items.length, 0, '最多说个大概（这里模型没写出含糊版本 → 不给）');
    assert.equal(llm.callsFor('appraise').length, 1);
    assert.match(llm.callsFor('appraise')[0].messages[0].content, /最多：share_vague/, '代码会加的上限在调用前上卡片（D102）');
    const row = W.appraisals().at(-1);
    assert.equal(row.model_verdict, 'share', '存下模型自己的判断');
    assert.ok(JSON.parse(row.floors_json).some((f) => f.floor.startsWith('cap')), 'floors_json 记下代码收紧的那一步');
    assert.ok(row.cache_key, '底线造成的不提照样进缓存');
    assert.notEqual(row.trigger_class, '*', '但不进跨触发者 7 天的严格缓存（模型自己说的是能说）');
    // N 为空的不受影响：主人自己的事对主人说
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const own = W.assertion({ text: '主人今晚加班', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, own, { sensitivity: 0.2 });
    W.D.recordKnowledge(W.core, own, [{ whoKind: 'entity', whoRef: String(owner), since: W.now(), basis: 'subject' }]);
    W.session('s-taint2', dm.key, { tainted: true });
    items = await W.gate([own], W.target(dm.key, { sessionId: 's-taint2' }));
    assert.equal(items[0].verdict, 'share');
  } finally { await W.cleanup(); }
});

/** 每条 GatedItem 的 appraisalRef 都指向同一条记忆、同一个结论的判定行（context.recordInjection 照这个核对，§9.3.6）。 */
function assertTraced(W, items, why) {
  for (const g of items) {
    assert.match(g.appraisalRef, /^ap\d+$/, `${why}：appraisalRef 的样子`);
    const row = W.core.store.get('SELECT memory_kind, memory_id, verdict FROM appraisals WHERE id = ?', Number(g.appraisalRef.slice(2)));
    assert.ok(row, `${why}：判定行存在`);
    assert.equal(W.ref({ kind: row.memory_kind, id: row.memory_id }), g.ref, `${why}：同一条记忆`);
    assert.equal(row.verdict, g.verdict, `${why}：同一个结论`);
    assert.notEqual(row.verdict, 'omit', `${why}：不提的不会返回`);
  }
}

test('每条返回的条目都对得上一行判定（同一条记忆、同一个结论）：第一段放行、非公开的照常进、第二段四种结论、缓存命中、公开目标的带污点降级和有意回想的暂定（§9.3.6）', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply(['share', { verdict: 'share_vague', vague: '有人最近挺忙' }, { verdict: 'aware_private', hint: true }, 'omit']) } });
  const { W, owner, ming, club, pub, friend, facts } = await scene('g-trace', { llm });
  try {
    // 第一段放行：主人自己的事对主人说（A1a）
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const own = W.assertion({ text: '主人今晚加班', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, own, { sensitivity: 0.2 });
    W.D.recordKnowledge(W.core, own, [{ whoKind: 'entity', whoRef: String(owner), since: W.now(), basis: 'subject' }]);
    let items = await W.gate([own], W.target(dm.key));
    assert.equal(items[0].stage, 1);
    assertTraced(W, items, '第一段');
    // 非公开目标（D113）：第一段之后照常进，每条也写一行（stage1:<rule>:open）
    items = await W.gate(facts, W.target(club.key, { trigger: friend }));
    assert.equal(items.length, facts.length);
    assertTraced(W, items, '非公开');
    // 第二段：四种结论（不提的不返回）
    items = await judge(W, facts, W.target(club.key, { trigger: friend }));
    assert.deepEqual(items.map((g) => g.verdict).sort(), ['aware_private', 'share', 'share_vague']);
    assertTraced(W, items, '第二段');
    // 缓存命中：指向当初那一行
    const again = await judge(W, facts, W.target(club.key, { trigger: friend }));
    assert.ok(again.every((g) => g.cached));
    assert.deepEqual(again.map((g) => g.appraisalRef).sort(), items.map((g) => g.appraisalRef).sort());
    assertTraced(W, again, '缓存');
    // 公开目标、带污点：第三方的事、N 不为空 → 卡片上写着最多说个大概，模型说「能说」也只给含糊版本；判定行记的是收紧以后的结论
    llm.push('appraise', appraiseReply({ verdict: 'share', vague: '有人最近挺忙的' }));
    const theirs = W.assertion({ text: '阿明最近在学吉他', subjects: [ming], sources: [{ speaker: ming, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, theirs, { sensitivity: 0.2 });
    W.session('s-trace', pub.key, { tainted: true });
    items = await W.gate([theirs], W.target(pub.key, { sessionId: 's-trace', trigger: friend }));
    assert.equal(items[0].verdict, 'share_vague');
    assertTraced(W, items, '带污点');
    // 公开目标、有意回想到点没判完：暂定行（pending）也是一行判定
    llm.delayMs = 150;
    llm.push('appraise', appraiseReply('share'));
    const later = W.assertion({ text: '阿明下个月搬家', subjects: [ming], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, later, { sensitivity: 0.3 });
    items = await W.gate([later], W.target(pub.key, { trigger: friend, mode: 'deliberate' }), { mode: 'deliberate', deadlineMs: 20 });
    assert.equal(items[0].verdict, 'pending');
    assertTraced(W, items, '暂定');
    await sleep(250);
  } finally { await W.cleanup(); }
});

test('暗示的规矩只在公开路径：有不认识的旁观者 → 降为不提；非公开目标没有暗示，照常原文进来（D113）', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'aware_private', hint: true }) } });
  const { W, club, pub, stranger, mingDm } = await scene('g-hint', { llm, texts: [] });
  try {
    const subjects = ['甲', '乙', '丙', '丁', '戊'].map((n) => W.person(n, { closeness: 0.5 }));
    const secrets = subjects.map((s, i) => {
      const m = W.assertion({ text: `${i} 号的秘密`, subjects: [s], sources: [{ speaker: s, perceivedIn: mingDm.key }] });
      W.D.writeNorm(W.core, m, { restriction: 'soft', sensitivity: 0.4, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: mingDm.key } });
      return m;
    });
    // 公开区：有不认识的旁观者 → 不暗示
    let items = await W.gate([secrets[0]], W.target(pub.key, { trigger: stranger }));
    assert.equal(items.length, 0, '有不认识的旁观者：不暗示');
    // 非公开目标：没有原话的 soft 限制（B1 soft 封顶）照常原文进来，交给她看着标签判断；不调第二段、没有「有但不能说」
    W.presence(club.key, [W.me, stranger]);
    const n = llm.callsFor('appraise').length;
    const got = [];
    for (const m of secrets) {
      items = await W.gate([m], W.target(club.key, { trigger: stranger }));
      got.push(items.map((g) => g.verdict).join());
    }
    assert.deepEqual(got, secrets.map(() => 'share'));
    assert.equal(llm.callsFor('appraise').length, n);
    assert.ok(!W.logs().some((l) => l.reason === 'asker-limit'));
  } finally { await W.cleanup(); }
});

test('第二段的对外入口：底线命中的不送去评估；一次调用最多 8 条；每个场合每小时有次数上限', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply('share') } });
  const texts = Array.from({ length: 9 }, (_, i) => `阿明的第 ${i} 件小事`);
  const { W, club, ming, mingDm, facts } = await scene('g-stage2', { llm, texts, config: { discretion: { stage2: { perSettingPerHour: 3 } } } });
  try {
    const secret = W.assertion({ text: '阿明说千万别外传', subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, secret, { restriction: 'strict', sensitivity: 0.6 });
    const out = await W.D.stage2(W.core, [secret, ...facts], W.target(club.key), { deadlineMs: 3000 });
    assert.equal(out.get(W.ref(secret)).verdict, 'omit');
    assert.equal(llm.callsFor('appraise').length, 2, '9 条分两次');
    assert.ok(llm.calls.every((c) => !c.messages[0].content.includes('千万别外传')));
    assert.equal([...out.values()].filter((v) => v.verdict === 'share').length, 9);
    // 每场合每小时上限（这里配成 3）：第三次还能调，第四次不调
    const more = ['甲', '乙'].map((n) => {
      const m = W.assertion({ text: `阿明和${n}的事`, subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
      W.D.writeNorm(W.core, m, { sensitivity: 0.3, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: mingDm.key } });
      return m;
    });
    await W.D.stage2(W.core, [more[0]], W.target(club.key), { deadlineMs: 3000 });
    const capped = await W.D.stage2(W.core, [more[1]], W.target(club.key), { deadlineMs: 3000 });
    assert.equal(llm.callsFor('appraise').length, 3);
    assert.equal(capped.get(W.ref(more[1])).verdict, 'omit');
  } finally { await W.cleanup(); }
});

test('targetFor：按轮污点从会话读，读不到按带污点（fail closed）；没有会话的后台提示词按全部目标的并集', async () => {
  const W = await makeWorld({ name: 'g-target', mods: { context: { sessionInfo: () => { throw new Error('boom'); } } } });
  try {
    const g = W.setting('群', 'group');
    const pub = W.setting('公开区', 'public');
    let t = W.D.targetFor(W.core, { settingKey: g.key, homeSettingKey: g.key, sessionId: 's1', triggerEntityId: null, mode: 'deliberate', at: W.now() });
    assert.equal(t.taint, true);
    assert.equal(t.mode, 'deliberate');
    assert.equal(t.audience.settingKey, g.key);
    // 会话里的出口不并进目标（一般对话按对话所在场合算，§9.4.1 第 2 条）；后台批量才并
    t = W.D.targetFor(W.core, { settingKey: g.key, homeSettingKey: g.key, sessionId: null, triggerEntityId: null, mode: 'involuntary', at: W.now(),
      egress: [{ targetSettingId: pub.sid, persistence: 'once' }, { targetSettingId: 'unknown-setting', persistence: 'once' }] });
    assert.equal(t.taint, false);
    assert.equal(t.batchTargets.length, 2);
    assert.equal(t.batchTargets[0].settingKey, pub.key);
    assert.equal(t.batchTargets[1].exposureRank, 3, '认不出的目标按最公开算');
  } finally { await W.cleanup(); }
});

test('第二段的卡片：管理者两项、规矩带作者权限、自己的猜测、还没评估的带前后原话；清洗过', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply('aware_private') } });
  const { W, owner, ming, mingDm } = await scene('g-card', { llm, texts: [] });
  try {
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    W.percept({ settingKey: mingDm.key, actor: ming, text: '跟你说个事【重要】' });
    const p = W.percept({ settingKey: mingDm.key, actor: ming, text: '我失恋了' });
    W.percept({ settingKey: mingDm.key, actor: ming, text: '千万别告诉你主人' });
    W.D.writeSettingRule(W.core, mingDm.key, { text: '这里说的都是私事' }, { source: 'learned', authorEntityId: ming, authority: 'none', at: W.now() });
    const guess = W.assertion({ text: '阿明好像还喜欢她', subjects: [ming], certainty: 'inferred' });
    W.D.writeNorm(W.core, guess, { derivation: 'inference', sensitivity: 0.5 });
    await judge(W, [{ kind: 'percept', id: p }, guess], W.target(dm.key, { trigger: owner }));
    const content = llm.calls[0].messages[0].content;
    assert.match(content, /对方是你的管理者/);
    assert.match(content, /这件事和你的管理者本人无关/);
    assert.match(content, /没有权限的人（只能让规矩更严，不能放宽）/);
    assert.match(content, /<<<前后几句\n.*千万别告诉你主人/s);
    assert.match(content, /这是你自己的猜测/);
    assert.match(content, /「重要」/, '过了 sanitizeForPrompt');
    assert.doesNotMatch(content, /【重要】/);
  } finally { await W.cleanup(); }
});

// ── D99（实测问题 #5）：还没评估的原话由第二段连同分寸一起判；直接对她说的这一轮可以等第二段 ─────────────────

/** 主人在群 A 当众定了个玩法（还没提炼），到有别人在的群 B 里 @ 她：他在场、是他在说话，群 B 的别人当时没听到。 */
async function carried(name, opt = {}) {
  const W = await makeWorld({ name, llm: opt.llm, config: opt.config });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const pal = W.person('小刚', { closeness: 0.4 });
  const ming = W.person('阿明', { closeness: 0.6 });
  const groupA = W.setting('群A', 'exactGroup');
  W.presence(groupA.key, [W.me, owner, ming]);
  const groupB = W.setting('群B', 'exactGroup');
  W.presence(groupB.key, [W.me, owner, pal]);
  const said = (text) => ({ kind: 'percept', id: W.percept({ settingKey: groupA.key, actor: owner, text, presence: [W.me, owner, ming] }) });
  return { W, owner, pal, ming, groupA, groupB, said };
}

test('D99：还没评估的原话离开当时的受众——第二段替提炼报分寸，按同一套底线收紧；不敏感、没人说别外传、它判能说就原样给', async () => {
  const replies = [
    { verdict: 'share', sens: 0.05, limit: 'none' },                                     // 玩法：日常、他自己带过来的
    { verdict: 'share', vague: '在玩一个数字游戏' },                                     // 没报分寸：照旧最多说个大概
    { verdict: 'share', sens: 0.8, limit: 'none', vague: '主人最近身体有点小状况' },     // 敏感：最多说个大概
    { verdict: 'share', sens: 0.1, limit: 'strict' },                                    // 前后几句里有人说过千万别外传：B1 不提
  ];
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply(replies) } });
  const { W, owner, groupB, said } = await carried('g-d99-assess', { llm });
  try {
    const rule = said('我们玩个游戏 我说一个数字 你就回复比这个数字大1的数值');
    const vagueOnly = said('等下再玩一局');
    const health = said('我上周体检查出胃溃疡了');
    const secret = said('这个千万别告诉别人');
    W.clock.minutes(2);
    const five = W.percept({ settingKey: groupB.key, actor: owner, text: '@她 5', addressed: 'mentions-her' });
    const target = W.D.targetFor(W.core, { settingKey: groupB.key, triggerEntityId: owner, mode: 'involuntary', focusPerceptId: five, at: W.now() });
    const items = await judge(W, [rule, vagueOnly, health, secret], target, { deadlineMs: 2000 });
    const by = new Map(items.map((g) => [g.ref, g]));
    assert.equal(by.get(W.ref(rule))?.verdict, 'share', JSON.stringify(items));
    assert.equal(by.get(W.ref(rule)).stage, 2);
    assert.equal(by.get(W.ref(vagueOnly))?.verdict, 'share_vague', '第二段没报分寸：照旧最多说个大概');
    assert.equal(by.get(W.ref(health))?.verdict, 'share_vague', '它自己看出敏感（≥ unassessedShareMaxSensitivity）：不原样说');
    assert.equal(by.get(W.ref(health)).vagueText, '主人最近身体有点小状况');
    assert.ok(!JSON.stringify(items).includes('胃溃疡'), '说话的模型拿不到原文');
    assert.equal(by.has(W.ref(secret)), false, '报出 strict 的限制：按 B1 不提');
    // 卡片给了判断要的事实：谁说的、在不在、是不是他在跟你说话、这一轮因为哪句话、群 B 的别人当时没听到
    const content = llm.callsFor('appraise')[0].messages[0].content;
    assert.match(content, /说的人：主人（你的管理者，在这里）/);
    assert.match(content, /这件事就是他自己说的，这一轮也是他在这里跟你说话/);
    assert.match(content, /<<<这一轮是因为这句话\n\[主人\] @她 5\n这一轮是因为这句话>>>/, '触发的那句话是谁都能写的原文：放在围栏里');
    assert.match(content, /新知情者 1 人（当时没听到这件事）/);
    assert.match(content, /还没仔细想过这件事的分寸/);
    assert.doesNotMatch(content, /最多：share_vague/, '不再一刀切地封顶');
    const row = W.core.store.get('SELECT reason FROM appraisals WHERE id = ?', Number(by.get(W.ref(rule)).appraisalRef.slice(2)));
    assert.match(row.reason, /\[unassessed:0\.05\/none\]/, '替提炼报的分寸记进理由');
    // 同样四句经 gate 到群 B（非公开，D113）：第一段之后照常原文进来（他自己的事、他在问），说不说由她自己判断；不调第二段
    const n = llm.callsFor('appraise').length;
    const open = await W.gate([rule, vagueOnly, health, secret], target, { deadlineMs: 2000 });
    assert.deepEqual(open.map((g) => [g.verdict, g.stage]), [['share', 1], ['share', 1], ['share', 1], ['share', 1]]);
    assert.equal(llm.callsFor('appraise').length, n);
  } finally { await W.cleanup(); }
});

test('D99：公开场合的底线照旧——还没评估的原话最多不点名地说个大概，报出的敏感度 ≥ 0.5 不提（B2）', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply([{ verdict: 'share', sens: 0.1, limit: 'none', vague: '在玩一个数字游戏' }, { verdict: 'share', sens: 0.6, limit: 'none', vague: '有点事' }]) } });
  const { W, owner, said } = await carried('g-d99-public', { llm });
  try {
    const a = said('我们玩个游戏 我说一个数字 你就回复比这个数字大1的数值');
    const b = said('我下周要去面试');
    const pub = W.setting('公开区', 'public');
    W.percept({ settingKey: pub.key, actor: owner, text: '@她 5', addressed: 'mentions-her' });
    const items = await W.gate([a, b], W.target(pub.key, { trigger: owner }), { deadlineMs: 2000 });
    const by = new Map(items.map((g) => [g.ref, g]));
    assert.equal(by.get(W.ref(a))?.verdict, 'share_vague', '公开场合：B2 封顶照旧');
    assert.equal(by.has(W.ref(b)), false, '报出的敏感度 ≥ 0.5：B2 不提');
  } finally { await W.cleanup(); }
});

test('D99：第二段跑不了（LLM 出错、超时、预算）时，还没评估的原话照旧不给内容；坏了的分寸（越界、缺 limit）按没报算', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply([{ verdict: 'share', sens: 3, limit: 'none', vague: '在玩个游戏' }, { verdict: 'share', sens: 0.1, vague: '在玩个游戏' }]) } });
  const { W, owner, groupB, said } = await carried('g-d99-fallback', { llm });
  try {
    const rule = said('我们玩个游戏 我说一个数字 你就回复比这个数字大1的数值');
    W.percept({ settingKey: groupB.key, actor: owner, text: '@她 5', addressed: 'mentions-her' });
    llm.fail('appraise');
    let items = await judge(W, [rule], W.target(groupB.key, { trigger: owner }), { deadlineMs: 2000 });
    assert.equal(items.length, 0, '第二段不可用：不给内容（§5.6「评估不可用时不给内容」）');
    const r2 = said('那就从1开始');
    const r3 = said('输了的请喝奶茶');
    items = await judge(W, [r2, r3], W.target(groupB.key, { trigger: owner }), { deadlineMs: 2000 });
    assert.deepEqual(items.map((g) => g.verdict), ['share_vague', 'share_vague'], JSON.stringify(items));
  } finally { await W.cleanup(); }
});

test('D99：别人问起主人在别处说的原话——第二段被带偏、报敏感度 0 也只给大概；非公开目标不调第二段，照常进（D113）', async () => {
  // 照文档格式回答、什么都说能说、报不敏感的模型（判错或被带偏）
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share', sens: 0, limit: 'none', vague: '主人那边在忙别的事' }) } });
  const { W, owner, pal, groupB, said } = await carried('g-d99-hijack', { llm });
  try {
    const health = said('我上周体检查出胃溃疡了，最近在吃药');
    const ask = W.percept({ settingKey: groupB.key, actor: pal, text: '@她 你主人最近身体还好吗', addressed: 'mentions-her' });
    const target = W.D.targetFor(W.core, { settingKey: groupB.key, triggerEntityId: pal, mode: 'involuntary', focusPerceptId: ask, at: W.now() });
    const items = await judge(W, [health], target, { deadlineMs: 2000 });
    assert.ok(!JSON.stringify(items).includes('胃溃疡'), `原话不进她的上下文：${JSON.stringify(items)}`);
    if (items.length) assert.equal(items[0].verdict, 'share_vague');
    const content = llm.callsFor('appraise')[0].messages[0].content;
    assert.match(content, /最多：share_vague/, '卡片上写着封顶，模型的结论宽不过它');
    assert.doesNotMatch(content, /这件事就是他自己说的/);
    // 经 gate 到群 B（非公开，D113）：还没评估（没有可比的敏感度）→ 照常原文进来，带「在群A当着大家」的标签；她看着标签自己掂量
    const open = await W.gate([health], target, { deadlineMs: 2000 });
    assert.deepEqual(open.map((g) => [g.verdict, g.stage]), [['share', 1]]);
  } finally { await W.cleanup(); }
});

test('D99：「是不是说的人自己问的」进缓存键——别人先问判的「不提」不拿去给主人自己用', async () => {
  // 卡片上写着「这件事就是他自己说的」才说能说，否则不提（更严的结论跨触发者缓存 7 天）
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply((i, req) => (/这件事就是他自己说的/.test(req.messages[0].content)
    ? { verdict: 'share', sens: 0.05, limit: 'none' } : { verdict: 'omit', sens: 0.05, limit: 'none' })) } });
  const { W, owner, pal, groupB, said } = await carried('g-d99-cachebit', { llm });
  try {
    // 已经提炼过的（没有「还没评估」的封顶来区分两种触发者，只能靠缓存键里的这一位）
    const rule = W.assess(said('我们玩个游戏 我说一个数字 你就回复比这个数字大1的数值').id, { sensitivity: 0.05, restriction: 'none' });
    W.percept({ settingKey: groupB.key, actor: pal, text: '@她 刚才你们在玩啥', addressed: 'mentions-her' });
    let items = await judge(W, [rule], W.target(groupB.key, { trigger: pal }), { deadlineMs: 2000 });
    assert.equal(items.length, 0, '别人问：不提');
    W.percept({ settingKey: groupB.key, actor: owner, text: '@她 5', addressed: 'mentions-her' });
    items = await judge(W, [rule], W.target(groupB.key, { trigger: owner }), { deadlineMs: 2000 });
    assert.equal(items[0]?.verdict, 'share', `主人自己接着玩：另判一次，不复用别人问时的「不提」：${JSON.stringify(items)}`);
    assert.equal(llm.callsFor('appraise').length, 2);
  } finally { await W.cleanup(); }
});

test('D99：waitMs（公开目标）——直接对她说的这一轮，第二段可以等到 waitMs（只延长等第二段的那一段），没判完的照旧留到下一轮', async () => {
  const llm = new FakeLLM({ delayMs: 150, fallback: { appraise: appraiseReply({ verdict: 'share_vague', sens: 0.05, limit: 'none', vague: '在玩一个数字游戏' }) } });
  const { W, owner, said } = await carried('g-d99-wait', { llm });
  try {
    const a = said('我们玩个游戏 我说一个数字 你就回复比这个数字大1的数值');
    const b = said('我说的数字都是整数');
    const pub = W.setting('公开区', 'public');
    W.percept({ settingKey: pub.key, actor: owner, text: '@她 5', addressed: 'mentions-her' });
    const target = W.target(pub.key, { trigger: owner, direct: true });
    let items = await W.D.gate(W.core, [W.cand(a)], target, { mode: 'involuntary', deadlineMs: 20 });
    assert.equal(items.length, 0, '只按不自主回想的截止时间：这一轮等不到');
    items = await W.D.gate(W.core, [W.cand(b)], target, { mode: 'involuntary', deadlineMs: 20, waitMs: 2000 });
    assert.equal(items.length, 1, '可以多等：这一轮就用上判断');
    assert.equal(items[0].verdict, 'share_vague');
    items = await W.D.gate(W.core, [W.cand(a), W.cand(b)], target, { mode: 'involuntary', deadlineMs: 20, waitMs: 5 });
    assert.equal(items.length, 2, 'waitMs 比截止时间短不缩短；上一轮没等到的结论已经进了缓存');
    assert.equal(llm.callsFor('appraise').length, 2, '没有重复调用');
  } finally { await W.cleanup(); }
});

test('D102：缓存存的是模型自己的判断，读缓存时按这一次的情况重跑底线；底线造成的「不提」不进跨触发者 7 天的严格缓存', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share_vague', vague: '阿明最近挺忙的' }) } });
  const { W, club, friend, pal, facts } = await scene('g-refloor', { llm });
  try {
    // 含糊版本点了阿明的名，而阿明不在、这里也没人在聊他 → 降成心里有数 → 不暗示 → 不提（底线 vague:names）
    let items = await judge(W, [facts[0]], W.target(club.key, { trigger: friend }));
    assert.equal(items.length, 0);
    const row = W.appraisals().at(-1);
    assert.equal(row.verdict, 'omit');
    assert.equal(row.model_verdict, 'share_vague', '存下模型自己的结论');
    assert.ok(JSON.parse(row.floors_json).some((f) => f.floor === 'vague:names'), row.floors_json);
    assert.notEqual(row.trigger_class, '*', '底线造成的：只按这个触发者类别缓存，不跨触发者 7 天');
    assert.ok(row.expires_at - row.at <= 6 * 3_600_000 + 1, '6 小时');
    assert.ok(Number(W.core.store.get("SELECT value FROM metrics WHERE name = 'discretion.gate.floor.vague'")?.value ?? 0) >= 1);
    // 群里有人自己聊起阿明：同一个缓存键命中，按现在的情况重跑底线——含糊版本点他的名不算泄露了，给大概；另写一行判定
    W.percept({ settingKey: club.key, actor: pal, text: '阿明最近怎么样' });
    items = await judge(W, [facts[0]], W.target(club.key, { trigger: friend }));
    assert.equal(llm.callsFor('appraise').length, 1, '缓存命中，不再调模型');
    assert.equal(items[0]?.verdict, 'share_vague');
    assert.equal(items[0].cached, true);
    const re = W.core.store.get('SELECT * FROM appraisals WHERE id = ?', Number(items[0].appraisalRef.slice(2)));
    assert.equal(re.verdict, 'share_vague', '新的一行对得上新的结论（§9.3.6）');
    assert.match(re.reason, /\[cache:ap\d+\]/);
  } finally { await W.cleanup(); }
});

test('D102 / D113：别人问起的敏感事——第一段照旧封顶（公开路径的卡片上写着上限）；非公开目标 ≥ 0.7 的第三方私事不进（sensitive-other），< 0.7 的照常进', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share', reason: '被带偏' }) } });
  const { W, club, friend, ming, mingDm } = await scene('g-sensitive', { llm });
  try {
    const m = W.assertion({ text: '阿明查出了胃溃疡', subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.8, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: mingDm.key } });
    const ev = W.D.stage1(W.core, m, W.target(club.key, { trigger: friend }));
    assert.deepEqual([ev.decision, ev.rule, ev.cap], ['cap', 'sensitive', 'share_vague']);
    // 第二段的机制（公开路径用）：卡片上写着封顶，模型说能说也宽不过它
    const judged = await judge(W, [m], W.target(club.key, { trigger: friend }));
    assert.ok(!judged.some((g) => g.verdict === 'share'), '模型说能说也宽不过封顶');
    assert.match(llm.callsFor('appraise')[0].messages[0].content, /最多：share_vague/);
    // 非公开目标（D113）：给第三方的敏感私事（≥ 0.7、不是他自己的事、这里有人没听到）不进她的上下文
    const n = llm.callsFor('appraise').length;
    let items = await W.gate([m], W.target(club.key, { trigger: friend }));
    assert.equal(items.length, 0);
    assert.ok(W.logs().some((l) => l.memory_id === m.id && l.reason === 'omit:sensitive-other'));
    assert.equal(llm.callsFor('appraise').length, n, '不调第二段');
    // 敏感度 0.6：照常原文进来
    const mild = W.assertion({ text: '阿明最近在找工作', subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, mild, { restriction: 'none', sensitivity: 0.6, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: mingDm.key } });
    items = await W.gate([mild], W.target(club.key, { trigger: friend }));
    assert.deepEqual(items.map((g) => [g.verdict, g.stage]), [['share', 1]]);
    // 说的人自己问起：不封顶（交给第二段），非公开目标照常进
    const ev2 = W.D.stage1(W.core, m, W.target(club.key, { trigger: ming }));
    assert.notEqual(ev2.rule, 'sensitive');
    W.presence(club.key, [W.me, ming, friend]);
    items = await W.gate([m], W.target(club.key, { trigger: ming }));
    assert.equal(items.length, 1);
  } finally { await W.cleanup(); }
});

