// D157：她凭记忆答别人的话不是别人的事实（核验第 15 条、来源的断言人、夜里的清查和撤销）。
// 测试数据全是编的：人名、群名、对话都不是真实的。用真的语言层（问句线索、查询词、词类），别的照 harness 的替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, codeIn, msgIn } from './harness.js';
import * as lang from '../../src/lang/index.js';
import { echoSweep, SWEEP_VER } from '../../src/consolidate/echo.js';
import { revertCheckImpl, pickCandidates } from '../../src/consolidate/correct.js';

const realLang = { queryTerms: lang.queryTerms, termClass: lang.termClass, registry: lang.registry };

async function setup() {
  const w = await makeWorld({ mods: { lang: realLang } });
  const owner = w.entity('阿杰', { closeness: 1, authority: 'principal' });
  const ming = w.entity('阿明', { closeness: 0.3 });
  const dm = w.setting('私聊', { exposure: 0 });
  const group = w.setting('游戏群', { exposure: 2, size: 30 });
  return { w, owner, ming, dm, group, enc: w.core.mods.encode };
}

const ASK = '你还记得我今天吃了哪些东西吗';
const ANSWER = '记着呢，晚上是一碗番茄面配葱油饼，中午就记得是热乎的一碗饭，具体吃的啥记不清了。就这两顿？';
const WRONG = '阿杰11/2晚上吃的是番茄面配葱油饼，中午是一碗热乎的饭，可能一整天只吃了这两顿';

/** 线上那样的输出：问话和她的回答一起当证据，说话人、断言人写成问的人，「本人说的」。 */
function misattributed(req, refs) {
  const U = codeIn(req, '主人');
  return [
    { type: 'header', title: '阿杰问我记不记得他吃了什么', text: '2026-11-02 23:50，阿杰问我记不记得他今天吃了什么' },
    { type: 'narrative', text: '深夜阿杰问我记不记得他今天吃了什么，我答晚上是番茄面配葱油饼，中午只记得是热乎的一碗饭。' },
    { type: 'fact', id: 'f1', subjects: [U], speaker: U, asserter: U, certainty: 'stated', predicate: '饮食', text: WRONG, kind_hint: 'state',
      imp: 5, confidence: 0.8, msgRefs: refs(req), quote: ASK },
  ];
}

test('#57 复现：对方问、她凭记忆答错、提炼把它记成对方说的事实 → 第 15 条挡下；只引了她的回答也认得出来；叙述和原话都在', async () => {
  for (const [name, refs] of [['问话 + 回答', (req) => [msgIn(req, ASK), msgIn(req, '番茄面')]], ['只引了回答', (req) => [msgIn(req, '番茄面')]]]) {
    const { w, owner, dm } = await setup();
    try {
      w.percept(dm, owner, ASK, { addressed: 'to-her' });
      w.clock.minutes(1);
      w.percept(dm, 'self', ANSWER);
      w.llm.push('extract', (req) => misattributed(req, refs).map((l) => (l.quote && name === '只引了回答' ? { ...l, quote: null } : l)));
      const outs = await w.extractAll(dm);
      assert.deepEqual(outs.map((o) => o.status), ['written'], name);
      assert.equal(w.assertions().length, 0, `${name}：不成为关于他的事实`);
      assert.match(w.episodes()[0].narrative, /番茄面/, `${name}：那段经历里照样有她答了什么`);
      assert.equal(w.core.store.get("SELECT SUM(value) AS v FROM metrics WHERE name = 'encode.verify.rule15'")?.v ?? null, 1, name);
    } finally { await w.cleanup(); }
  }
});

test('#57 的对照：他接着认了（「对，就这两顿」）→ 写成他的事实；她那句的来源断言人是她自己，不是他', async () => {
  const { w, owner, dm } = await setup();
  try {
    w.percept(dm, owner, ASK, { addressed: 'to-her' });
    w.clock.minutes(1);
    const her = w.percept(dm, 'self', ANSWER);
    w.clock.minutes(1);
    const yes = w.percept(dm, owner, '对，就这两顿', { addressed: 'to-her' });
    w.llm.push('extract', (req) => misattributed(req, (r) => [msgIn(r, ASK), msgIn(r, '番茄面'), msgIn(r, '对，就这两顿')]));
    await w.extractAll(dm);
    const [a] = w.assertions();
    assert.ok(a, '他认了：算他的事实');
    assert.equal(a.certainty, 'stated');
    const s = w.sources('assertion', a.id);
    assert.deepEqual(s.find((x) => x.percept_id === her).asserter, w.self, '她的话：断言人是她');
    assert.deepEqual(s.find((x) => x.percept_id === yes).asserter, owner);
  } finally { await w.cleanup(); }
});

/** verify 一段对话（真的 buildExtractPrompt 给 ctx）。 */
async function scene(w, s, build) {
  const ids = build();
  const seg = { settingKey: s.key, perceptIds: ids, boundaryCertain: true, historical: false };
  const pr = w.core.mods.encode.buildExtractPrompt(w.core, seg, {});
  const ctx = { seg, percepts: pr.percepts, speakers: pr.speakers, msgRefs: pr.msgRefs, bgCodes: pr.bgCodes, candidateCodes: pr.candidateCodes,
    labels: pr.labels, actorCodes: pr.actorCodes, selfId: w.self };
  return (lines) => w.core.mods.encode.verify(w.core, lines, ctx);
}
const facts = (r) => r.accepted.filter((l) => ['fact', 'plan', 'self', 'rel'].includes(l.type));

test('第 15 条不误伤：她提议、对方答应；对方陈述、她复述；问句本身就是这件事；她说自己的事；她对别人的看法', async () => {
  const { w, ming, group } = await setup();
  try {
    let ids;
    const run = await scene(w, group, () => (ids = [
      w.percept(group, 'self', '明天把你那台相机借我用用呗'),          // m1 她提议
      w.percept(group, ming, '好'),                                    // m2 他答应
      w.percept(group, ming, '我下个月搬去杭州了'),                       // m3 他陈述
      w.percept(group, 'self', '杭州好呀，下个月就搬了啊'),              // m4 她复述
      w.percept(group, ming, '@她 分镜是按固定间隔挑还是看弹幕密度挑的？'), // m5 他问（事实说的就是他问了这个）
      w.percept(group, 'self', '看弹幕密度挑的'),                        // m6 她答
      w.percept(group, ming, '你最喜欢什么颜色'),                        // m7 他问
      w.percept(group, 'self', '我最喜欢蓝色'),                          // m8 她说自己的
      w.percept(group, ming, '你觉得我做饭怎么样'),                      // m9 他问
      w.percept(group, 'self', '你做饭挺有一手的'),                      // m10 她的看法
    ]));
    const r = run([
      { type: 'plan', id: 'f1', subjects: ['U1'], agent: 'U1', speaker: 'U1', certainty: 'stated', predicate: '借相机', text: '阿明答应11/3把相机借给我', kind_hint: 'plan',
        planned_time: { start: '2026-11-03' }, imp: 4, msgRefs: ['m1', 'm2'] },
      { type: 'fact', id: 'f2', subjects: ['U1'], speaker: 'U1', certainty: 'stated', predicate: '搬家', text: '阿明下个月搬去杭州', kind_hint: 'plan', imp: 5, msgRefs: ['m3', 'm4'],
        planned_time: { start: '2026-12-01', precision: 'month' } },
      { type: 'fact', id: 'f3', subjects: ['U1'], speaker: 'U1', certainty: 'stated', predicate: '问过', text: '阿明问过分镜是按固定间隔挑还是看弹幕密度挑', kind_hint: 'fact', imp: 4, msgRefs: ['m5', 'm6'] },
      { type: 'self', subjects: ['我'], predicate: '喜欢', text: '我最喜欢蓝色', kind_hint: 'preference', imp: 5, msgRefs: ['m8'] },
      { type: 'fact', id: 'f5', subjects: ['U1'], speaker: '我', certainty: 'stated', predicate: '厨艺', text: '我觉得阿明做饭挺有一手', kind_hint: 'opinion', imp: 4, msgRefs: ['m9', 'm10'] },
    ]);
    assert.deepEqual(r.dropped.filter((d) => d.rule === 15), [], '一条都不该被第 15 条挡');
    const by = Object.fromEntries(facts(r).map((f) => [f.id, f]));
    assert.equal(by.f1.speaker, 'U1');
    assert.equal(by.f1.certainty, 'stated', '她提议、他答应：是他答应的事');
    assert.equal(by.f2.certainty, 'stated', '他自己说的，她复述不影响');
    assert.equal(by.f3.asserter, 'U1', '问句本身就是这件事');
    const self = facts(r).find((f) => f.type === 'self');
    assert.equal(self.certainty, 'self_said', '她说自己的事照旧');
    assert.equal(by.f5.speaker, '我');
    assert.equal(by.f5.certainty, 'self_said', '她的看法照旧是她说的');
    assert.ok(by.f5.confidence <= 0.5);
    assert.ok(ids.length === 10);
  } finally { await w.cleanup(); }
});

test('第 15 条：问话当证据——对方只是在问，内容出自她的回答 → 不写；她的看法除外；对方没说话、她自己说别人的事照旧是她说的', async () => {
  const { w, ming, group } = await setup();
  try {
    const run = await scene(w, group, () => [
      w.percept(group, ming, '@她 你还记得我上周末去哪了吗'),    // m1
      w.percept(group, 'self', '去爬山了吧，还拍了好多云海'),      // m2 她凭记忆答
      w.percept(group, 'self', '阿明最近好像换了新工作'),          // m3 她自己说起别人的事（没人问）
    ]);
    const r = run([
      { type: 'fact', id: 'f1', subjects: ['U1'], speaker: 'U1', asserter: 'U1', certainty: 'stated', predicate: '周末', text: '阿明上周末去爬山，拍了云海', kind_hint: 'event',
        event_time: { start: '2026-10-25', precision: 'week' }, imp: 4, msgRefs: ['m1', 'm2'], quote: '你还记得我上周末去哪了吗' },
      { type: 'fact', id: 'f2', subjects: ['U1'], speaker: 'U1', asserter: 'U1', certainty: 'stated', predicate: '周末', text: '阿明上周末去爬山，拍了云海', kind_hint: 'event',
        event_time: { start: '2026-10-25', precision: 'week' }, imp: 4, msgRefs: ['m2'] },
      { type: 'fact', id: 'f3', subjects: ['U1'], speaker: '我', certainty: 'stated', predicate: '工作', text: '阿明最近换了新工作', kind_hint: 'fact', imp: 5, msgRefs: ['m3'] },
    ]);
    assert.deepEqual(r.dropped.filter((d) => d.rule === 15).map((d) => [d.line.id, d.reason]), [['f1', 'echo'], ['f2', 'echo-answer']]);
    const [f3] = facts(r);
    assert.equal(f3.id, 'f3');
    assert.deepEqual([f3.speaker, f3.asserter, f3.certainty], ['我', '我', 'self_said'], '没人问、她自己说起的：照旧是她说的（把握 ≤ 0.5）');
  } finally { await w.cleanup(); }
});

/** 按旧的写法写一条事实：她的话的来源断言人也记成对方（D157 以前的样子）。 */
function oldStyle(w, enc, { subjects, text, kindHint = 'state', certainty = 'stated', confidence = 0.8, rows }) {
  const src = rows.map(([p, speaker, asserter]) => ({ perceptId: p, speaker, asserter, mode: speaker === w.self ? 'self_generated' : 'told_to_her', hop: 0,
    quote: null, confidence, at: w.clock.now() }));
  return enc.writeAssertion(w.core, { subjects, predicate: 'p', text, kindHint, certainty, confidence, imp: 5, sources: src, norm: {}, w: 1 });
}

test('清查（D157）：库里已有的——明确的收回、记一行能撤销；拿不准的标上、当晚纠错先挑；正常的不动；幂等；撤销后按确认过恢复', async () => {
  const { w, owner, ming, dm, group, enc } = await setup();
  try {
    const at = w.clock.now();
    const q = w.percept(dm, owner, ASK, { addressed: 'to-her' });
    const a = w.percept(dm, 'self', ANSWER);
    const echoId = oldStyle(w, enc, { subjects: [owner], text: WRONG, rows: [[q, owner, owner], [a, w.self, owner]] });
    const p1 = w.percept(group, 'self', '明天把你那台相机借我用用呗');
    const p2 = w.percept(group, ming, '好');
    const okId = oldStyle(w, enc, { subjects: [ming], text: '阿明答应明天把相机借给我', kindHint: 'plan', rows: [[p1, w.self, ming], [p2, ming, ming]] });
    const c1 = w.percept(group, ming, '@她 怎么还把我名字写成繁体了');
    const c2 = w.percept(group, 'self', '那以后都写简体的');
    const unsureId = oldStyle(w, enc, { subjects: [ming], text: '阿明希望名字写简体，不要写成繁体', kindHint: 'preference', certainty: 'hearsay', confidence: 0.6,
      rows: [[c1, ming, ming], [c2, w.self, ming]] });
    const mine = oldStyle(w, enc, { subjects: [w.self], text: '我答应以后写简体', kindHint: 'commitment', certainty: 'self_said', rows: [[c2, w.self, w.self]] });

    const r1 = echoSweep(w.core, { at });
    assert.deepEqual([r1.withdrawn, r1.flagged], [1, 1]);
    assert.ok(w.assertion(echoId).expired_at != null, '收回：标过时');
    assert.equal(w.assertion(echoId).superseded_by, null, '不取代、不删');
    assert.equal(w.assertion(okId).expired_at, null, '她提议、他答应的不动');
    assert.equal(w.assertion(mine).expired_at, null, '关于她自己的不归这一条管');
    const rows = w.core.store.all('SELECT * FROM memory_checks WHERE prompt_ver = ? ORDER BY assertion_id', SWEEP_VER);
    assert.deepEqual(rows.map((x) => [x.assertion_id, x.verdict, x.after_conf]), [[echoId, 'doubted', 0], [unsureId, 'unclear', null]]);
    assert.deepEqual(JSON.parse(rows[0].evidence_json), [a], '依据是她自己那句');
    assert.equal(rows[1].next_at, at, '拿不准的：当晚就该核');
    // 拿不准的进当晚的纠错，排在最前
    const picked = pickCandidates(w.core, at, 8);
    assert.equal(picked[0]?.id, unsureId);
    assert.equal(picked[0].echoReview, true);
    // 幂等：再跑没有新的；游标清掉再跑也不重复记
    assert.equal(echoSweep(w.core, { at: at + 1 }).skipped, 'nothing-new');
    w.core.store.run("DELETE FROM meta WHERE key = 'consolidate.echoSweep'");
    const r3 = echoSweep(w.core, { at: at + 2 });
    assert.deepEqual([r3.withdrawn, r3.flagged], [0, 0]);
    assert.equal(w.core.store.get('SELECT count(*) AS n FROM memory_checks WHERE prompt_ver = ?', SWEEP_VER).n, 2);
    // 撤销：按改之前的那一版恢复成确认过的新的一版；之后的清查不再动它
    const rv = revertCheckImpl(w.core, rows[0].id, { by: 'owner', at: at + 3 });
    assert.equal(rv.reverted, true);
    const restored = w.core.store.get('SELECT * FROM assertions WHERE supersedes = ?', echoId);
    assert.deepEqual([restored.certainty, restored.expired_at, restored.text], ['confirmed', null, WRONG]);
    assert.equal(revertCheckImpl(w.core, rows[0].id, {}).reason, 'already-reverted');
    const r4 = echoSweep(w.core, { at: at + 4 });
    assert.equal(r4.withdrawn, 0);
    assert.equal(w.core.store.get('SELECT expired_at FROM assertions WHERE id = ?', restored.id).expired_at, null);
  } finally { await w.cleanup(); }
});
