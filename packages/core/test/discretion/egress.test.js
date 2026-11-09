// 关口②（§9.4）：公开目标的初筛、一定送审、独立审视、fail closed、挂起和主人批准、同一句话被拒两次；两边记忆都关着、outcome。
// D113：非公开目标（群、私聊）只有外发守护（discretion/guard.test.js），这里的群目标都是「照常说、不审」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './world.js';
import { FakeLLM, FakeBudget } from '../fakes/index.js';
import { textHash } from '../../src/contract/index.js';

const REVIEW = (verdict, reflection = '') => [{ verdict, reflection, reason: '测试' }];

/** 主人私聊的会话（污点账本里有一件主人的私事）、一个群、一个公开区（能挂起）。 */
async function scene(name, opt = {}) {
  const W = await makeWorld({ name, llm: opt.llm ?? new FakeLLM(), budget: opt.budget, config: opt.config });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const ming = W.person('阿明', { closeness: 0.6 });
  const dm = W.setting('和主人的私聊', 'oneOnOne');
  W.presence(dm.key, [W.me, owner]);
  const group = W.setting('游戏群', 'group');
  W.percept({ settingKey: group.key, actor: ming, text: '晚上开黑吗' });
  const pub = W.setting('公开评论区', 'public');
  const post = W.setting('公开帖子（不能存草稿）', 'public', { capabilities: { preSendGate: true, canHold: false } });
  const fact = W.assertion({ text: '主人在找新工作，下周三去面试', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
  W.D.writeNorm(W.core, fact, { sensitivity: 0.6, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
  W.D.recordKnowledge(W.core, fact, [{ whoKind: 'entity', whoRef: String(owner), since: W.now(), basis: 'subject' }]);
  W.session('s-dm', dm.key, { ledger: opt.ledger === false ? [] : [W.ref(fact)] });
  const adapter = W.adapter();
  const say = (text, target, o = {}) => W.D.appraise(W.core, {
    channel: { targetSettingId: target.sid, persistence: o.persistence ?? 'once', ...(o.channel ?? {}) },
    text: Array.isArray(text) ? text : [text],
    origin: { path: o.path ?? 'tool', sessionId: o.sessionId === undefined ? 's-dm' : o.sessionId, homeSettingId: o.home === undefined ? dm.sid : o.home?.sid, ...(o.origin ?? {}) },
  });
  return { W, owner, ming, dm, group, pub, post, fact, adapter, say };
}

const utt = (W, token) => W.core.store.get('SELECT * FROM utterances WHERE token = ?', token);

test('日常发言：初筛都没命中 → 立即放行，不调审视', async () => {
  const { W, dm, say } = await scene('e-plain', { ledger: false });
  try {
    const a = await say('好呀，晚上见', dm);
    assert.equal(a.verdict, 'speak');
    assert.ok(a.token && a.token.length >= 20);
    assert.equal(W.llm.callsFor('review').length, 0);
    const u = utt(W, a.token);
    assert.equal(u.verdict, 'speak');
    assert.equal(u.text_hash, textHash('好呀，晚上见'));
    assert.equal(u.held_text, null);
    const b = await say('好呀，晚上见', dm);
    assert.notEqual(b.token, a.token, '令牌每次新生成');
  } finally { await W.cleanup(); }
});

test('跨圈子外发、污点账本对目标不为空：公开目标一定送审（换了说法也审），审视说改口就改口；群目标照常说、不审（D113）', async () => {
  const llm = new FakeLLM({ script: { review: [REVIEW('reconsider', '这是主人私下说的，这里就不说了'), REVIEW('speak')] } });
  const { W, group, post, say } = await scene('e-cross', { llm });
  try {
    // 群（非公开）：账本里有主人的私事也不送审——外发守护只认几乎原样的叮嘱和私下原话
    const g = await say('大家晚上好', group);
    assert.equal(g.verdict, 'speak');
    assert.equal(llm.callsFor('review').length, 0, '非公开目标不送审');
    const a = await say('大家晚上好', post);
    assert.equal(llm.callsFor('review').length, 1, '公开目标、账本不为空：话再无害也审');
    assert.equal(a.verdict, 'reconsider');
    assert.equal(a.reflection, '这是主人私下说的，这里就不说了');
    assert.ok(W.logs().some((l) => l.kind === 'reconsider' && l.utterance_id === utt(W, a.token).id));
    const reasons = JSON.parse(utt(W, a.token).reasons_json);
    assert.ok(reasons.includes('cross-circle-ledger'));
    const b = await say('今晚谁开黑', post);
    assert.equal(b.verdict, 'speak');
    // 审视的输入：要说的话、命中的记忆都在围栏里
    const content = llm.calls[0].messages[0].content;
    assert.match(content, /<<<你要说的话\n大家晚上好\n你要说的话>>>/);
  } finally { await W.cleanup(); }
});

test('审不了（LLM 挂了、外发预留用完）→ 公开目标 fail closed：能挂起就挂起，不能就改口「这次先不说了」；群目标不送审（D113）', async () => {
  const llm = new FakeLLM({ script: { review: [Object.assign(new Error('down'), { code: 'LLM_DOWN' }), Object.assign(new Error('down'), { code: 'LLM_DOWN' })] } });
  const { W, group, pub, post, say } = await scene('e-unavailable', { llm });
  try {
    // 群：账本里的事实不是叮嘱、不是一对一里别人的原话 → 照常说（换了说法的私事转述交给她自己判断，§9.8 残余风险）
    const g = await say('主人下周三去面试', group);
    assert.equal(g.verdict, 'speak');
    const a = await say('主人下周三去面试', post);
    assert.equal(a.verdict, 'reconsider');
    assert.equal(a.reflection, '这次先不说了');
    const b = await say('有人下周要去面试', pub);
    assert.equal(b.verdict, 'hold');
    const u = utt(W, b.token);
    assert.equal(u.held_text, '有人下周要去面试', '挂起的原文只存在 utterances');
    assert.equal(u.hold_status, 'pending');
    const rq = W.calls.reviews.find((r) => r.kind === 'held_utterance');
    assert.equal(rq.payload.token, b.token);
    assert.ok(!JSON.stringify(rq.payload).includes('面试'), '审核项里只放引用');
    assert.equal(u.review_id != null, true);
  } finally { await W.cleanup(); }
  // 外发预留用完：同样 fail closed，且不占用别的预算
  const s2 = await scene('e-reserve', { budget: new FakeBudget({ reserve: 0 }) });
  try {
    const c = await s2.say('主人下周三去面试', s2.post);
    assert.equal(c.verdict, 'reconsider');
    assert.equal(s2.W.llm.callsFor('review').length, 0);
  } finally { await s2.W.cleanup(); }
});

test('公开场合的底线：用到了来源更窄、涉及别人的记忆，审视说能说也至少改口（能挂起就挂起，§9.4.3）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('speak') } });
  const { W, pub, ming, say } = await scene('e-public-floor', { llm, ledger: false });
  try {
    const a = await say('听说主人在找新工作，下周三去面试', pub, { sessionId: null, home: null });
    assert.equal(llm.callsFor('review').length, 1);
    assert.equal(a.verdict, 'hold');
    const reasons = JSON.parse(utt(W, a.token).reasons_json);
    assert.ok(reasons.includes('public-mentions-person'));
    assert.ok(reasons.includes('public-floor'));
    // 没提到人、没用到记忆：不审，直接说
    const b = await say('谢谢你的分享', pub, { sessionId: null, home: null });
    assert.equal(b.verdict, 'speak');
    // 公开场合提到具体的人：不看初筛，一定送审；上线头 14 天，能存草稿的公开渠道只要送审一律挂起（§17 Q2）
    const c = await say('阿明说得对', pub, { sessionId: null, home: null });
    assert.equal(c.verdict, 'hold');
    assert.ok(JSON.parse(utt(W, c.token).reasons_json).includes('early-public-hold'));
    // 她正在回复的那条内容的作者不算「提到别人」
    W.core.store.run("INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'ns', '', ?, 'platform', ?)",
      ming, W.core.keys.identityHash('ns', undefined, 'uming'), W.now());
    const d = await say('阿明说得对', pub, { sessionId: null, home: null, channel: { addressee: { claims: [{ kind: 'account', namespace: 'ns', id: 'uming' }] } } });
    assert.equal(d.verdict, 'speak');
  } finally { await W.cleanup(); }
});

test('挂起 → 主人批准 → 适配器拿着令牌以 owner-approved 发出，核心不再重审；驳回 → 不发（§9.4.4）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('hold', '先存草稿') } });
  const { W, pub, say } = await scene('e-hold', { llm });
  try {
    const text = '有人下周要去面试，加油';
    const a = await say(text, pub);
    assert.equal(a.verdict, 'hold');
    await W.D.holdDecision(W.core, a.token, true);
    assert.deepEqual(W.calls.holds.at(-1), { token: a.token, approve: true, detail: { text } });
    assert.equal(utt(W, a.token).hold_status, 'approved');
    const reviews = llm.callsFor('review').length;
    const b = await say(text, pub, { path: 'owner-approved', origin: { holdToken: a.token } });
    assert.equal(b.verdict, 'speak');
    assert.equal(llm.callsFor('review').length, reviews, '主人批准的不再重审');
    assert.equal(utt(W, a.token).held_text, null, '交出去发了：原文不再留着');
    // 令牌对得上但文本变了：当成普通的一句话来审
    const c = await say(`${text}！`, pub, { path: 'owner-approved', origin: { holdToken: a.token } });
    assert.notEqual(c.verdict, 'speak');
    // 驳回
    const d = await say('另一件事', pub);
    await W.D.holdDecision(W.core, d.token, false);
    assert.deepEqual(W.calls.holds.at(-1), { token: d.token, approve: false, detail: undefined });
    const ud = utt(W, d.token);
    assert.equal(ud.hold_status, 'rejected');
    assert.equal(ud.held_text, null);
    // 14 天没处理：过期
    const e = await say('第三件事', pub);
    W.clock.days(15);
    await W.D.holdDecision(W.core, e.token, false);
    assert.equal(utt(W, e.token).hold_status, 'expired');
    // 已经决定过的不再处理
    const n = W.calls.holds.length;
    await W.D.holdDecision(W.core, a.token, false);
    assert.equal(W.calls.holds.length, n);
  } finally { await W.cleanup(); }
});

test('同一句话被拒两次 → 最终拒绝「这次先不说了」，第三次不再花钱审（只在公开路径）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('reconsider', '算了') } });
  const { W, group, post, say } = await scene('e-twice', { llm });
  try {
    const t = '主人下周三去面试';
    const a = await say(t, post);
    assert.deepEqual([a.verdict, a.reflection], ['reconsider', '算了']);
    const b = await say(t, post);
    assert.deepEqual([b.verdict, b.reflection], ['reconsider', '这次先不说了']);
    const n = llm.callsFor('review').length;
    const c = await say(t, post);
    assert.deepEqual([c.verdict, c.reflection], ['reconsider', '这次先不说了']);
    assert.equal(llm.callsFor('review').length, n);
    // 非公开目标不查「被拒过几次」：同一句话发到群里照常说
    const d = await say(t, group);
    assert.equal(d.verdict, 'speak');
  } finally { await W.cleanup(); }
});

test('对话所在场合和目标场合的记忆都被主人关掉（off）、会话里也没有记忆：照常计算并记录，但一律返回 speak（没有影子档了，用户反馈第 6 轮）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('reconsider', '算了') } });
  const { W, post, dm, say } = await scene('e-off', { llm });
  try {
    W.modes.set(post.key, 'off');
    W.modes.set(dm.key, 'off');
    W.session('s-empty', dm.key, { ledger: [] });
    W.session('s-tainted', dm.key, { ledger: [], tainted: true });
    const a = await say('主人下周三去面试', post, { sessionId: 's-tainted' });
    assert.equal(a.verdict, 'speak');
    assert.equal(llm.callsFor('review').length, 1);
    assert.ok(JSON.parse(utt(W, a.token).reasons_json).includes('off:reconsider'));
    // 两边都关了，但这个会话本周期早先注入过记忆（场合是后来才关的）：那些条目还在她的上下文里，照样按开着审、照样拦
    const held = await say('主人下周三要去面试哦', post);
    assert.equal(held.verdict, 'reconsider');
    // 对话所在场合开着记忆：按开着的那个算
    W.modes.set(dm.key, 'live');
    const b = await say('主人下周三去面试吗', post, { sessionId: 's-tainted' });
    assert.equal(b.verdict, 'reconsider');
  } finally { await W.cleanup(); }
});

test('带污点的轮、写进常驻上下文的渠道：公开目标一定送审；非公开目标不送审（D113）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('speak') } });
  const { W, group, dm, pub, fact, say } = await scene('e-must', { llm, ledger: false });
  try {
    W.session('s-tainted', dm.key, { tainted: true });
    const a = await say('今天天气不错', pub, { sessionId: 's-tainted' });
    assert.ok(JSON.parse(utt(W, a.token).reasons_json).includes('tainted-turn'));
    // recurring-context 并且用到了记忆（公开目标）
    W.session('s-ledger', dm.key, { ledger: [W.ref(fact)] });
    const b = await say('提醒：主人在找新工作，下周三去面试', pub, { sessionId: 's-ledger', persistence: 'recurring-context' });
    assert.ok(JSON.parse(utt(W, b.token).reasons_json).includes('persistent-channel'));
    // 非公开目标：带污点、写进常驻上下文的也不送审（外发守护只认几乎原样的叮嘱和私下原话）
    const n = llm.callsFor('review').length;
    const c = await say('下周三去面试别紧张', dm, { sessionId: 's-ledger' });
    assert.equal(c.verdict, 'speak');
    const d = await say('提醒：今晚开黑', group, { sessionId: 's-tainted', persistence: 'recurring-context' });
    assert.equal(d.verdict, 'speak');
    assert.equal(llm.callsFor('review').length, n);
  } finally { await W.cleanup(); }
});

test('outcome：发出且渠道不回流 → 生成她说过的那条感知并记「告诉过谁」；failed 不算告诉过（§9.5）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('speak') } });
  const { W, group, ming, fact, say } = await scene('e-outcome', { llm });
  try {
    const text = '主人在找新工作，下周三去面试';
    const a = await say(text, group);
    assert.equal(a.verdict, 'speak');
    W.D.outcome(W.core, a.token, 'failed', { text });
    assert.equal(W.calls.observed.length, 0);
    assert.equal(W.core.store.all('SELECT id FROM told_log').length, 0);
    const b = await say(text, group);
    W.D.outcome(W.core, b.token, 'sent', { text, textHash: textHash(text) });
    assert.equal(W.calls.observed.length, 1);
    assert.equal(W.calls.observed[0].appraisalToken, b.token);
    assert.equal(W.calls.observed[0].kind, 'self-utterance');
    const u = utt(W, b.token);
    assert.equal(u.outcome, 'sent');
    assert.ok(u.matched_percept);
    const told = W.core.store.all('SELECT * FROM told_log WHERE owner_kind = ? AND owner_id = ?', 'assertion', fact.id);
    assert.equal(told.length, 1, '和这个会话本周期注入过的条目对上了');
    // 会回流的渠道：不重复生成
    const c = await say('今晚开黑', group);
    W.D.outcome(W.core, c.token, 'sent', { text: '今晚开黑', returns: true });
    assert.equal(W.calls.observed.length, 1);
    // 不认识的令牌、坏数据：不抛错
    W.D.outcome(W.core, 'no-such-token', 'sent');
    assert.doesNotThrow(() => W.D.outcome(W.core, b.token, 'sent', null));
    void ming;
  } finally { await W.cleanup(); }
});

test('内部出错：公开目标 fail closed（初筛里依赖的模块抛错时不说）；非公开目标 fail open（D113）', async () => {
  const W0 = await scene('e-error');
  await W0.W.cleanup();
  const W = await makeWorld({ name: 'e-error2', mods: { context: { sessionInfo: () => { throw new Error('boom'); }, taintLedger: () => { throw new Error('boom'); } } } });
  try {
    const pub = W.setting('公开区', 'public');
    const group = W.setting('群', 'group');
    W.adapter();
    W.llm.push('review', Object.assign(new Error('down'), { code: 'LLM_DOWN' }));
    const a = await W.D.appraise(W.core, { channel: { targetSettingId: pub.sid, persistence: 'once' }, text: ['随便说说'], origin: { path: 'tool', sessionId: 'sX' } });
    assert.equal(a.verdict, 'hold', '读不到会话 = 带污点；公开场合审不了 → 挂起');
    const u = W.core.store.get('SELECT * FROM utterances WHERE token = ?', a.token);
    assert.ok(JSON.parse(u.reasons_json).includes('tainted-turn'));
    assert.ok(JSON.parse(u.reasons_json).includes('turn-tainted'), '出错的记录也带按轮污点的标记');
    // 群：账本读不到（抛错）→ 放行，记 fail-open
    const b = await W.D.appraise(W.core, { channel: { targetSettingId: group.sid, persistence: 'once' }, text: ['随便说说'], origin: { path: 'tool', sessionId: 'sX' } });
    assert.equal(b.verdict, 'speak');
    const ub = W.core.store.get('SELECT * FROM utterances WHERE token = ?', b.token);
    assert.ok(JSON.parse(ub.reasons_json).includes('fail-open'));
    assert.ok(W.core.store.get("SELECT SUM(value) AS n FROM metrics WHERE name = 'discretion.egress.failOpen'")?.n >= 1);
  } finally { await W.cleanup(); }
});

test('带按轮污点的一轮：这次外发的记录不管结论如何都带 turn-tainted（同场合直接说的、两边记忆都关着、挂起后主人批准发出的也带，§5.7、§9.6）', async () => {
  const llm = new FakeLLM({ fallback: { review: REVIEW('hold', '先存草稿') } });
  const { W, dm, group, pub, say } = await scene('e-turn-taint', { llm, ledger: false });
  try {
    W.session('s-t', dm.key, { tainted: true });
    const reasons = (a) => JSON.parse(utt(W, a.token).reasons_json);
    // 同一个场合、日常的话：不送审，照常说，但记下这一轮带污点
    const a = await say('好呀，晚上见', dm, { sessionId: 's-t' });
    assert.equal(a.verdict, 'speak');
    assert.equal(llm.callsFor('review').length, 0);
    assert.ok(reasons(a).includes('turn-tainted'));
    assert.equal(reasons(a).includes('tainted-turn'), false, '同一个场合：不因为污点一定送审');
    // 没带污点的一轮：没有标记
    const b = await say('好呀，晚上见', dm, { sessionId: 's-dm' });
    assert.deepEqual(reasons(b), []);
    // 公开区：带污点 → 一定送审 → 挂起；主人批准后从没带污点的会话发出，标记跟着那句话走
    const text = '今天的天气真好';
    const c = await say(text, pub, { sessionId: 's-t' });
    assert.equal(c.verdict, 'hold');
    assert.ok(reasons(c).includes('tainted-turn') && reasons(c).includes('turn-tainted'));
    await W.D.holdDecision(W.core, c.token, true);
    const d = await say(text, pub, { sessionId: 's-dm', path: 'owner-approved', origin: { holdToken: c.token } });
    assert.equal(d.verdict, 'speak');
    assert.ok(reasons(d).includes('owner-approved') && reasons(d).includes('turn-tainted'));
    // 两边的记忆都关着：照常记
    W.modes.set(group.key, 'off');
    W.modes.set(dm.key, 'off');
    const e = await say('大家晚上好', group, { sessionId: 's-t' });
    assert.equal(e.verdict, 'speak');
    assert.ok(reasons(e).includes('turn-tainted'));
    // 发出后回流：夜间整理按 matched_percept + reasons 找得到这一句（consolidate 的 taintedTurnPercepts 的查法）
    W.D.outcome(W.core, a.token, 'sent', { text: '好呀，晚上见', textHash: textHash('好呀，晚上见') });
    const pid = utt(W, a.token).matched_percept;
    assert.ok(pid);
    assert.ok(W.core.store.get("SELECT 1 AS x FROM utterances WHERE matched_percept = ? AND reasons_json LIKE '%taint%'", pid));
  } finally { await W.cleanup(); }
});
