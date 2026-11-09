// 关口③（§9.5、§5.6「告诉过谁」）：她的话回流成感知以后，记告诉过谁、扩充谁知道、找出没经过审视的发言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './world.js';
import { runJobs } from '../../src/maintenance.js';
import { JOB_POSTCHECK, JOB_TOLD_SCAN } from '../../src/discretion/index.js';
import { FakeLLM, FakeEmbedding } from '../fakes/index.js';

async function scene(name, opt = {}) {
  const W = await makeWorld({ name, llm: opt.llm });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const ming = W.person('阿明', { closeness: 0.6 });
  const hong = W.person('小红', { closeness: 0.5 });
  const dm = W.setting('和主人的私聊', 'oneOnOne');
  W.presence(dm.key, [W.me, owner]);
  const group = W.setting('游戏群', 'group');
  const fact = W.assertion({ text: '主人在找新工作，下周三去面试', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
  W.D.writeNorm(W.core, fact, { sensitivity: 0.4, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
  W.D.recordKnowledge(W.core, fact, [{ whoKind: 'entity', whoRef: String(owner), since: W.now(), basis: 'subject' }]);
  return { W, owner, ming, hong, dm, group, fact };
}

test('她的话回流：对上审视令牌；和本周期注入过的条目比对，写告诉过谁、谁知道（told_by_her），讲给新听众各加一次痕迹', async () => {
  const { W, ming, hong, group, fact } = await scene('t-basic');
  try {
    W.session('s-g', group.key, { ledger: [W.ref(fact)] });
    W.core.store.run(`INSERT INTO utterances(token, setting_key, at, channel_json, origin_path, text_hash, verdict, created_at, session_id)
                      VALUES ('tok-1', ?, ?, '{}', 'tool', 'h', 'speak', ?, 's-g')`, group.key, W.now(), W.now());
    const before = W.D.knownCircle(W.core, fact, W.now());
    assert.equal(before.entities.has(ming), false);
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', appraisalToken: 'tok-1', presence: [W.me, ming, hong], completeness: 'recent-speakers' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    const u = W.core.store.get("SELECT * FROM utterances WHERE token = 'tok-1'");
    assert.equal(u.matched_percept, pid);
    assert.equal(u.outcome, 'sent');
    const told = W.core.store.all('SELECT * FROM told_log');
    assert.equal(told.length, 1);
    assert.deepEqual([told[0].owner_id, told[0].setting_key, told[0].utterance_percept_id, told[0].level], [fact.id, group.key, pid, 'full']);
    const after = W.D.knownCircle(W.core, fact, W.now());
    assert.ok(after.entities.has(ming) && after.entities.has(hong), '当时的受众现在知道了');
    assert.deepEqual(after.settings.map((s) => s.settingKey), [group.key]);
    const retell = W.calls.traces.filter((t) => t.reason === 'retell');
    assert.equal(retell.length, 2, '两个新听众各一次');
    assert.equal(new Set(retell.map((t) => t.sourceKey)).size, 2);
    // 同一句话再回流一次（重复投递）：不重复记
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    assert.equal(W.core.store.all('SELECT * FROM told_log').length, 1);
    // 再对同一批人复述：不算讲给新听众
    const p2 = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', presence: [W.me, ming, hong], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', p2));
    assert.equal(W.calls.traces.filter((t) => t.reason === 'retell').length, 2);
    W.logger.assertNoText('主人在找新工作');
  } finally { await W.cleanup(); }
});

test('只给了「说个大概」的条目：记成 vague，不扩充已知圈（说了个大概 ≠ 对方知道了细节）', async () => {
  const { W, ming, group, fact } = await scene('t-vague');
  try {
    W.session('s-g', group.key, { ledger: [W.ref(fact)], verdict: 'share_vague' });
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', presence: [W.me, ming], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    const told = W.core.store.get('SELECT level FROM told_log');
    assert.equal(told.level, 'vague');
    assert.equal(W.D.knownCircle(W.core, fact, W.now()).entities.has(ming), false);
  } finally { await W.cleanup(); }
});

test('说得多细看讲到了多少（§5.6、S14）：换个代词把整件事讲了一遍 = 讲全了（扩充已知圈）；只沾到人名、讲了一点点 = 说了个大概', async () => {
  const { W, owner, ming, hong, group, fact } = await scene('t-coverage');
  try {
    W.session('s-g', group.key, { ledger: [W.ref(fact)] });
    // 「主人」换成「他」：没有共同的名字和数字，重合分只有词元重合那一点，但内容几乎全讲到了
    const p1 = W.percept({ settingKey: group.key, actor: W.me, text: '他在找新工作，下周三去面试', presence: [W.me, ming], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', p1));
    assert.equal(W.core.store.get('SELECT level FROM told_log WHERE utterance_percept_id = ?', p1)?.level, 'full', '换了代词的复述也是讲全了');
    assert.ok(W.D.knownCircle(W.core, fact, W.now()).entities.has(ming), '讲全了：阿明现在知道了（told_by_her）');
    // 另一条更长的记忆：只提到主人和一点点（对得上，但细节没讲）
    const long = W.assertion({ text: '主人在找新工作，下周三去一家做游戏的公司面试，公司在杭州，他挺紧张的', subjects: [owner], sources: [{ speaker: owner }] });
    W.D.writeNorm(W.core, long, { sensitivity: 0.3 });
    W.session('s-g2', group.key, { ledger: [W.ref(long)] });
    const p2 = W.percept({ settingKey: group.key, actor: W.me, text: '主人最近挺忙的', presence: [W.me, hong], completeness: 'recent-speakers', sessionId: 's-g2' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', p2));
    assert.equal(W.core.store.get('SELECT level FROM told_log WHERE owner_id = ? AND utterance_percept_id = ?', long.id, p2)?.level, 'vague', '只沾到一点：说了个大概');
    assert.equal(W.D.knownCircle(W.core, long, W.now()).entities.has(hong), false, '说了个大概不扩充已知圈（D64）');
  } finally { await W.cleanup(); }
});

test('意图被执行了：讲给意图的对象（他在场）→ encode.recordExecution', async () => {
  const { W, ming, group } = await scene('t-intention');
  try {
    const at = W.now();
    const tid = Number(W.core.store.run(`INSERT INTO intentions(target_entity_id, act, text, origin, state, formed_at, created_at, updated_at)
                                         VALUES (?, '问候', '问问阿明考试考得怎么样', 'self-care', 'armed', ?, ?, ?)`, ming, at, at, at).lastInsertRowid);
    W.session('s-g', group.key, { ledger: [`t${tid}`] });
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '阿明，考试考得怎么样', presence: [W.me, ming], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    assert.equal(W.calls.executions.length, 1);
    assert.deepEqual([W.calls.executions[0].id, W.calls.executions[0].targetEntityId, W.calls.executions[0].settingKey], [tid, ming, group.key]);
  } finally { await W.cleanup(); }
});

test('未经审视的发言：有发出前拦截点的场合对不上审视记录 → 记分寸日志、排一个回头补评估；没有拦截点的渠道不算', async () => {
  const llm = new FakeLLM({ fallback: { review: [{ verdict: 'reconsider', reflection: '不该说', reason: 'x' }] } });
  const { W, group, fact } = await scene('t-unappraised', { llm });
  try {
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    assert.ok(W.logs().some((l) => l.kind === 'unappraised' && l.reason === 'no-matching-appraisal'));
    const job = W.core.store.get('SELECT * FROM jobs WHERE kind = ?', JOB_POSTCHECK);
    assert.ok(job);
    assert.ok(!job.payload_json.includes('面试'), '任务里只放引用');
    // 回头补评估：照外发审视走一遍（D113：群里是外发守护，没有叮嘱、没有私下原话 → 能说，不记）
    let r = await runJobs(W.core, { kinds: [JOB_POSTCHECK] });
    assert.equal(r.ran, 1);
    assert.ok(!W.logs().some((l) => l.reason?.startsWith('posthoc:')));
    // 公开区：照公开路径送审，不是 speak 的记进分寸日志
    const pub = W.setting('公开区', 'public');
    const pp = W.percept({ settingKey: pub.key, actor: W.me, text: '主人在找新工作，下周三去面试' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pp));
    r = await runJobs(W.core, { kinds: [JOB_POSTCHECK] });
    assert.equal(r.ran, 1);
    assert.ok(W.logs().some((l) => l.kind === 'unappraised' && l.reason === 'posthoc:reconsider'));
    // 没有发出前拦截点的渠道（模型文本本身就是发言）：本来就不会有审视记录
    const web = W.setting('网页聊天', 'oneOnOne', { capabilities: { preSendGate: false, canHold: false } });
    const n = W.logs().length;
    const p2 = W.percept({ settingKey: web.key, actor: W.me, text: '好的' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', p2));
    assert.equal(W.logs().length, n);
    // 以她名义发出的（有结构证据）：不算未经审视
    const p3 = W.percept({ settingKey: group.key, actor: W.me, kind: 'on-my-behalf', text: '定时提醒：开会' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', p3));
    assert.equal(W.logs().length, n);
    void fact;
  } finally { await W.cleanup(); }
});

test('按（场合、文本哈希、时间窗）对上没带令牌的审视记录；outcome=failed 的不算', async () => {
  const { W, group } = await scene('t-hashmatch');
  try {
    const { textHash } = await import('../../src/contract/index.js');
    const at = W.now();
    W.core.store.run(`INSERT INTO utterances(token, setting_key, at, channel_json, origin_path, text_hash, verdict, outcome, created_at) VALUES ('f', ?, ?, '{}', 'tool', ?, 'speak', 'failed', ?)`,
      group.key, at, textHash('收到'), at);
    W.core.store.run(`INSERT INTO utterances(token, setting_key, at, channel_json, origin_path, text_hash, verdict, created_at) VALUES ('ok', ?, ?, '{}', 'tool', ?, 'speak', ?)`,
      group.key, at, textHash('收到'), at);
    W.clock.minutes(1);
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '收到' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    assert.equal(W.core.store.get("SELECT matched_percept FROM utterances WHERE token = 'ok'").matched_percept, pid);
    assert.equal(W.core.store.get("SELECT matched_percept FROM utterances WHERE token = 'f'").matched_percept, null);
    assert.equal(W.logs().filter((l) => l.kind === 'unappraised').length, 0);
  } finally { await W.cleanup(); }
});

test('比对不上、但有区分性词的：排一个异步比对；任务按整句向量对上注入过的条目，记成说了个大概', async () => {
  // 换说法：同义词让向量很近、字面很远（替身嵌入的 synonyms）
  const embedding = new FakeEmbedding({ synonyms: [['找', '寻'], ['工作', '差事'], ['下周三', '礼拜三'], ['面试', '应聘'], ['主人', '他']] });
  // 常见的口头语 IDF 很低（替身按真实统计的样子给）
  const W = await makeWorld({ name: 't-scan', embedding,
    mods: { worker: { termStats: async (core, ts) => new Map(ts.map((t) => [t, { idf: t === '哈哈' ? 0.5 : 4, rowFraction: 0.001 }])) } } });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const ming = W.person('阿明', { closeness: 0.6 });
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    const group = W.setting('游戏群', 'group');
    const fact = W.assertion({ text: '主人在找新工作，下周三去面试', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, fact, { sensitivity: 0.4 });
    W.session('s-g', group.key, { ledger: [W.ref(fact)] });
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '他在寻新差事，礼拜三去应聘', presence: [W.me, ming], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', pid));
    assert.equal(W.core.store.all('SELECT * FROM told_log').length, 0, '同步比对对不上');
    const job = W.core.store.get('SELECT * FROM jobs WHERE kind = ?', JOB_TOLD_SCAN);
    assert.ok(job);
    assert.ok(!job.payload_json.includes('差事'), '任务里只放引用');
    const r = await runJobs(W.core, { kinds: [JOB_TOLD_SCAN] });
    assert.equal(r.ran, 1);
    const told = W.core.store.all('SELECT * FROM told_log');
    assert.equal(told.length, 1);
    assert.equal(told[0].level, 'vague');
    assert.equal(told[0].owner_id, fact.id);
    // 寒暄（没有区分性词）：任务直接结束，不花嵌入
    const calls = embedding.calls.query;
    const p2 = W.percept({ settingKey: group.key, actor: W.me, text: '哈哈哈哈哈哈哈', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, W.core.store.get('SELECT * FROM percepts WHERE id = ?', p2));
    await runJobs(W.core, { kinds: [JOB_TOLD_SCAN] });
    assert.equal(embedding.calls.query, calls, '没有区分性词：不花嵌入');
  } finally { await W.cleanup(); }
});

test('logDecision：只认六种 kind；只记引用和理由', async () => {
  const W = await makeWorld({ name: 't-log' });
  try {
    W.D.logDecision(W.core, { kind: 'omit', settingKey: 'k', ref: 'a12', appraisalId: 3, triggerEntityId: 4, subjectEntityId: 5, reason: 'stage1:B1', at: 1000 });
    const r = W.logs()[0];
    assert.deepEqual([r.kind, r.memory_kind, r.memory_id, r.appraisal_id, r.trigger_entity_id, r.subject_entity_id, r.reason, r.at], ['omit', 'assertion', 12, 3, 4, 5, 'stage1:B1', 1000]);
    assert.throws(() => W.D.logDecision(W.core, { kind: 'gossip', reason: 'x', at: 1 }));
  } finally { await W.cleanup(); }
});

const row = (W, id) => W.core.store.get('SELECT * FROM percepts WHERE id = ?', id);

test('没经过关口②、在带按轮污点的一轮里说出去的话：记一行 unappraised 的 utterances 带 turn-tainted（夜间整理据此不拿它当成长依据，§5.7、§9.6）', async () => {
  const { W } = await scene('t-taint-unappraised');
  try {
    // 没有发出前拦截点的渠道（模型文本本身就是发言）：本来就不会有审视记录
    const web = W.setting('网页聊天', 'oneOnOne', { capabilities: { preSendGate: false, canHold: false } });
    W.session('s-web', web.key, { tainted: true });
    const pid = W.percept({ settingKey: web.key, actor: W.me, text: '好的，我以后就这么说话', sessionId: 's-web' });
    W.D.onSelfUtterance(W.core, row(W, pid));
    const u = W.core.store.get('SELECT * FROM utterances WHERE matched_percept = ?', pid);
    assert.ok(u, '记了一行');
    assert.deepEqual([u.origin_path, u.verdict, u.outcome, u.session_id, u.setting_key, u.held_text], ['unappraised', 'speak', 'sent', 's-web', web.key, null]);
    assert.deepEqual(JSON.parse(u.reasons_json), ['unappraised', 'turn-tainted']);
    // 夜间整理的查法（consolidate 的 taintedTurnPercepts）认得出它
    assert.ok(W.core.store.get("SELECT 1 AS x FROM utterances WHERE matched_percept = ? AND reasons_json LIKE '%taint%'", pid));
    assert.equal(W.logs().filter((l) => l.kind === 'unappraised').length, 0, '没有拦截点的渠道不算未经审视');
    // 同一条再回流一次：对上刚记的那一行，不重复记
    W.D.onSelfUtterance(W.core, row(W, pid));
    assert.equal(W.core.store.get('SELECT COUNT(*) AS n FROM utterances WHERE matched_percept = ?', pid).n, 1);
    // 没带污点的一轮：什么都不记
    W.sessions.get('s-web').turnTainted = false;
    const p2 = W.percept({ settingKey: web.key, actor: W.me, text: '晚安', sessionId: 's-web' });
    W.D.onSelfUtterance(W.core, row(W, p2));
    assert.equal(W.core.store.get('SELECT COUNT(*) AS n FROM utterances WHERE matched_percept = ?', p2).n, 0);
  } finally { await W.cleanup(); }
  // 读不到会话：按带污点（fail closed，最多是这句不拿来当成长依据）
  const W2 = await makeWorld({ name: 't-taint-unknown', mods: { context: { sessionInfo: () => { throw new Error('boom'); }, taintLedger: () => [] } } });
  try {
    const web = W2.setting('网页聊天', 'oneOnOne', { capabilities: { preSendGate: false, canHold: false } });
    W2.session('s-x', web.key);
    const pid = W2.percept({ settingKey: web.key, actor: W2.me, text: '嗯嗯', sessionId: 's-x' });
    W2.D.onSelfUtterance(W2.core, row(W2, pid));
    assert.ok(JSON.parse(W2.core.store.get('SELECT reasons_json FROM utterances WHERE matched_percept = ?', pid).reasons_json).includes('turn-tainted'));
  } finally { await W2.cleanup(); }
});

test('回填的旧发言（historical=1）：不算未经审视、不补评估、不记按轮污点；不和眼下会话本周期的注入比对，只排全库比对', async () => {
  const { W, group, fact } = await scene('t-historical');
  try {
    W.session('s-g', group.key, { ledger: [W.ref(fact)], tainted: true });
    const pid = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', sessionId: 's-g' });
    W.core.store.run('UPDATE percepts SET historical = 1 WHERE id = ?', pid);
    W.D.onSelfUtterance(W.core, row(W, pid));
    assert.equal(W.logs().filter((l) => l.kind === 'unappraised').length, 0, '回填的旧发言当时没有关口②可对');
    assert.equal(W.core.store.get('SELECT id FROM jobs WHERE kind = ?', JOB_POSTCHECK), undefined);
    assert.equal(W.core.store.get('SELECT COUNT(*) AS n FROM utterances').n, 0, '眼下这一轮的污点和那句旧话无关');
    assert.equal(W.core.store.all('SELECT id FROM told_log').length, 0, '眼下会话的注入不是那句话说出口之前的');
    assert.ok(W.core.store.get('SELECT id FROM jobs WHERE kind = ?', JOB_TOLD_SCAN), '按内容排全库比对，补回「告诉过谁」');
    // 同一句话现在说（不是回填）：照常对上本周期的注入
    const p2 = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, row(W, p2));
    assert.equal(W.core.store.all('SELECT id FROM told_log').length, 1);
    assert.ok(W.logs().some((l) => l.kind === 'unappraised'));
  } finally { await W.cleanup(); }
});

test('讲给新听众只算一次：以前听她讲过的（哪怕只是个大概，不扩充已知圈）再听一遍不加痕迹（§6.4）', async () => {
  const { W, ming, hong, group, fact } = await scene('t-retell-once');
  try {
    W.session('s-g', group.key, { ledger: [W.ref(fact)], verdict: 'share_vague' });
    const p1 = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', presence: [W.me, ming], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, row(W, p1));
    assert.equal(W.calls.traces.filter((t) => t.reason === 'retell').length, 1);
    W.clock.days(3);
    const p2 = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三就去面试了', presence: [W.me, ming, hong], completeness: 'recent-speakers', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, row(W, p2));
    assert.equal(W.core.store.all('SELECT id FROM told_log').length, 2);
    const retell = W.calls.traces.filter((t) => t.reason === 'retell');
    assert.equal(retell.length, 2, '这次只有小红是新听众');
    assert.equal(new Set(retell.map((t) => t.sourceKey)).size, 2);
  } finally { await W.cleanup(); }
});

test('讲给新听众只算一次（没有出现集合的那次也算）：上次的听众按那句话当时最近说过话的人重算，不靠 dynamics 只在保留的精确痕迹里查重（§6.4）', async () => {
  const { W, ming, hong, group, fact } = await scene('t-retell-nops');
  try {
    W.session('s-g', group.key, { ledger: [W.ref(fact)], verdict: 'share_vague' });
    W.percept({ settingKey: group.key, actor: ming, text: '晚上开黑吗' });
    // 第一次：这句话没带出现集合，听众 = 当时最近亲自说过话的人（阿明）
    const p1 = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三去面试', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, row(W, p1));
    assert.deepEqual(W.calls.traces.filter((t) => t.reason === 'retell').length, 1);
    // 很多天以后再讲一遍：阿明还在，小红也来了 → 只有小红是新听众
    W.clock.days(10);
    W.percept({ settingKey: group.key, actor: ming, text: '又是周末' });
    W.percept({ settingKey: group.key, actor: hong, text: '我也在' });
    const p2 = W.percept({ settingKey: group.key, actor: W.me, text: '主人在找新工作，下周三就去面试了', sessionId: 's-g' });
    W.D.onSelfUtterance(W.core, row(W, p2));
    assert.equal(W.core.store.all('SELECT id FROM told_log').length, 2);
    const retell = W.calls.traces.filter((t) => t.reason === 'retell');
    assert.equal(retell.length, 2, '阿明以前听过（上次没有出现集合，也认得出来），这次只有小红是新听众');
  } finally { await W.cleanup(); }
});
