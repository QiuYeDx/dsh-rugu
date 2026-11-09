// 夜里对照原话纠错（§7.7 第 2 步，D122）：挑最可能错、最常被想起的事实；给模型看来源原话、之后的原话、她实际做过的；
// 代码核对引用的编号、证据的信任度；主人做的永远不动；核对过的按间隔再挑；写回经 encode.applyCorrection。
// 测试数据里没有真实账号、群号；人名都是合成的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, reply, T0, MIN, HOUR, DAY } from './world.js';
import { FakeLLM, FakeBudget } from '../fakes/index.js';
import { correctStep, pickCandidates, recheckAfter, judge } from '../../src/consolidate/correct.js';
import { DEFAULTS } from '../../src/config/defaults.js';
import { newRun } from '../../src/consolidate/util.js';

const AT = T0 + 3 * DAY;

/** 词法检索的替身：原话里出现任意一个查询词的感知（world 的感知不进 FTS）。 */
const lexical = {
  lexicalSearch: async (c, q) => {
    const rows = c.store.all('SELECT id, text FROM percepts WHERE text IS NOT NULL ORDER BY id');
    const hits = rows.filter((r) => q.terms.some((t) => [...t].length >= 2 && r.text.includes(t))).map((r) => ({ ref: `p${r.id}`, score: 1 }));
    return { hits, timedOut: false };
  },
};
/** applyCorrection 的替身：记下调用，改正 / 降低把握返回一个新 id（直接插一行，和真的 encode 一样旧的被取代）。 */
function encodeFake(calls) {
  return {
    applyCorrection: (c, id, op, ctx) => {
      calls.push({ id, op, ctx });
      if (op.op === 'changed') return id;
      const old = c.store.get('SELECT * FROM assertions WHERE id = ?', op.op === 'restore' ? op.from : id);
      if (op.op === 'restore') op = { ...op, certainty: 'confirmed', confidence: 0.9, text: old.text };
      const nid = Number(c.store.run(`INSERT INTO assertions(predicate, text, kind_hint, certainty, confidence, imp, recorded_at, extract_ver, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, old.predicate, op.text ?? old.text, old.kind_hint, op.certainty ?? old.certainty, op.confidence, old.imp,
      ctx.at, op.extractVer, ctx.at, ctx.at).lastInsertRowid);
      c.store.run('UPDATE assertions SET superseded_by = ? WHERE id = ?', nid, id);
      for (const r of c.store.all("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role = 'subject'", old.id)) {
        c.store.run("INSERT OR IGNORE INTO assertion_entities(assertion_id, entity_id, role) VALUES (?, ?, 'subject')", nid, r.entity_id);
      }
      return nid;
    },
  };
}

/** 她在私聊里说自己收不到群里的消息（记成关于她自己的事实）；之后主人纠正，她在两个群里照常说话。 */
function scene(w) {
  const owner = w.entity({ name: '阿杰', authority: 'principal', closeness: 1 });
  const ming = w.entity({ name: '阿明' });
  const dm = w.setting({ label: '私聊', exposure: 0 });
  const g1 = w.setting({ label: '群一' });
  const g2 = w.setting({ label: '群二' });
  const ask = w.percept(dm, { actor: owner, text: '群里那条你看到没', at: T0, addressed: 'to-her' });
  const said = w.percept(dm, { self: true, text: '群里那条我这边真收不到，只看得到你私聊说的话', at: T0 + MIN });
  const claim = w.fact({ text: '我这边收不到群里的消息，只能看到私聊里主人说的话', predicate: '收不到群消息', kindHint: 'fact', certainty: 'self_said', confidence: 0.9,
    subjects: [w.self], recordedAt: T0 + 20 * MIN, sources: [{ perceptId: said, speaker: w.self, mode: 'self_generated', at: T0 + MIN }] });
  const g1a = w.percept(g1, { actor: ming, text: '@她 晚上打游戏吗', at: T0 + DAY, addressed: 'to-her' });
  const g1b = w.percept(g1, { self: true, text: '打呀，我九点上线', at: T0 + DAY + MIN });
  const g2a = w.percept(g2, { self: true, text: '大家早上好', at: T0 + DAY + HOUR });
  const fix = w.percept(dm, { actor: owner, text: '你记的收不到群里的消息是错的，你在每个群都能收到消息', at: T0 + 2 * DAY, addressed: 'to-her' });
  const rumor = w.percept(g1, { actor: ming, text: '你其实收不到群里的消息吧', at: T0 + 2 * DAY + HOUR, addressed: 'to-her' });
  return { owner, ming, dm, g1, g2, ask, said, claim, g1a, g1b, g2a, fix, rumor };
}

/** 模型：遇到「收不到群里的消息」那条判错，引用主人那句（编号从提示词里找）；其余判 confirmed、引用来源。 */
function sensibleLLM(fixText, over = {}) {
  return new FakeLLM({ fallback: { sleep: reply((req, text) => {
    const out = [];
    for (const block of text.split(/\n\n/)) {
      const m = /^\[(m\d+)\] 记忆：「([^」]*)」/.exec(block)?.[1];
      if (!m) continue;
      const fixCode = new RegExp(`\\[(e\\d+)\\] [^\\n]*${fixText}`).exec(block)?.[1];
      const first = /\[(e\d+)\]/.exec(block)?.[1];
      if (block.includes('收不到群里的消息') && fixCode) out.push({ type: 'check', id: m, verdict: 'wrong', evidence: [fixCode], text: '我在每个群都能收到消息', why: '主人纠正过，我也一直在群里说话', ...over });
      else out.push({ type: 'check', id: m, verdict: 'confirmed', evidence: first ? [first] : [], why: '原话支持' });
    }
    return out;
  }) } });
}

test('a163 那一类：她自己说的「收不到群里的消息」被挑中；模型看到来源、来源前一句、主人的纠正和她在群里说过的话；按主人的话改正（stated），旧的被取代', async () => {
  const calls = [];
  const llm = sensibleLLM('你在每个群都能收到消息');
  const w = await world({ llm, mods: { worker: lexical, encode: encodeFake(calls) } });
  try {
    const s = scene(w);
    const r = await correctStep(w.core, { run: newRun(12), at: AT });
    assert.equal(r.calls, 1);
    assert.equal(r.corrected, 1);
    const prompt = llm.callsFor('sleep')[0];
    const user = prompt.messages[0].content;
    assert.ok(prompt.system.startsWith('以下全部是数据'));
    assert.match(user, /来源原话：\n\s+\[e1\] .*我：群里那条我这边真收不到/);
    assert.match(user, /来源前面的几句：\n\s+\[e\d+\] .*主人（你最亲近的人）：群里那条你看到没/);
    assert.match(user, /之后相关的原话：[\s\S]*主人（你最亲近的人）：你记的收不到群里的消息是错的/);
    assert.match(user, /我之后实际做过的：之后我在 2 个别的地方（0 个是多人的）说过 2 句话，那里有人对我说过 2 句/);
    assert.ok(!user.includes('你其实收不到群里的消息吧'), '没有权限的人关于她自己的说法不给（§5.7）');
    assert.ok(!user.includes('群一') && !user.includes(s.g1.key), '场合名、场合键不给模型');
    assert.equal(calls.length, 1);
    const [{ id, op }] = calls;
    assert.equal(id, s.claim.id);
    assert.equal(op.op, 'correct');
    assert.equal(op.certainty, 'stated', '证据是主人说的');
    assert.equal(op.confidence, 0.9);
    assert.deepEqual(op.evidence, [s.fix]);
    assert.match(op.extractVer, /^consolidate-correction-v1#/);
    const row = w.core.store.get('SELECT * FROM memory_checks WHERE assertion_id = ?', s.claim.id);
    assert.equal(row.verdict, 'corrected');
    assert.ok(row.result_id > s.claim.id);
    assert.deepEqual(JSON.parse(row.evidence_json), [s.fix]);
    assert.equal(row.why, '主人纠正过，我也一直在群里说话');
    assert.deepEqual([row.before_conf, row.after_conf], [0.9, 0.9]);
    assert.ok(row.next_at > AT, '改正后的新版本过一阵再核');
    assert.deepEqual(pickCandidates(w.core, AT + HOUR, 10).map((c) => c.id), [], '新版本今晚不再挑');
  } finally { await w.cleanup(); }
});

/** judge 的小场景：一条记忆（m1）和给它看过的几句（e 编号 → 角色、说话人）。 */
function judgeCase({ selfBelief = true, kind = 'fact', certainty = 'self_said', confidence = 0.9, streak = 0, lines = {} } = {}) {
  const OWNER = 2; const MING = 7; const SELF = 1;
  const codes = new Map(Object.entries(lines).map(([code, [role, who], i]) => [code, { mem: 'm1', pid: 100 + Number(code.slice(1)), role,
    row: { id: 100 + Number(code.slice(1)), actor_self: who === 'self' ? 1 : 0, actor_entity_id: who === 'self' ? SELF : who === 'owner' ? OWNER : MING } }]));
  const it = { code: 'm1', cand: { selfBelief, streak, row: { certainty, kind_hint: kind, confidence } }, ev: { subjects: new Set(selfBelief ? [SELF] : [MING + 1]), asserters: new Set() } };
  const p = { correct: DEFAULTS.sleep.correct, keep: DEFAULTS.extract.keep, factTextMax: 120 };
  const authority = (id) => (id === OWNER ? 'principal' : 'none');
  return (line) => judge({ type: 'check', id: 'm1', why: '理由', ...line }, it, codes, p, { authority, self: SELF });
}

test('评审 HIGH-1：关于她自己的，她自己之后的话、她做过的事都不能改写成新说法——最多降低把握；改写要有主人的话；「她做过的」只对 ability 算', () => {
  const ownLine = judgeCase({ lines: { e1: ['source', 'self'], e2: ['later', 'self'] } });
  assert.deepEqual(ownLine({ verdict: 'wrong', evidence: ['e2'], text: '我能收到群里的消息' }).op, { op: 'doubt', confidence: 0.4 }, '她的一句话不能换成她的另一句话');
  assert.deepEqual(ownLine({ verdict: 'changed', evidence: ['e2'] }).op, { op: 'doubt', confidence: 0.4 });
  const behaviorFact = judgeCase({ lines: { e1: ['source', 'self'], e2: ['behavior', 'self'] } });
  assert.equal(behaviorFact({ verdict: 'wrong', evidence: ['e2'], text: 'x' }).verdict, 'unclear', '她做过的事对 fact 不算证据');
  const behaviorAbility = judgeCase({ kind: 'ability', confidence: 0.4, lines: { e1: ['source', 'self'], e2: ['behavior', 'self'] } });
  const b = behaviorAbility({ verdict: 'wrong', evidence: ['e2'], text: '我能看图片' });
  assert.equal(b.verdict, 'doubted', '对 ability 算证据，但也只到降低把握');
  const owner = judgeCase({ lines: { e1: ['source', 'self'], e2: ['later', 'self'], e3: ['later', 'owner'] } });
  const r = owner({ verdict: 'wrong', evidence: ['e2', 'e3'], text: '我在每个群都能收到消息' });
  assert.equal(r.verdict, 'corrected');
  assert.deepEqual({ ...r.op, text: undefined }, { op: 'correct', text: undefined, certainty: 'stated', confidence: 0.9, evidence: [103] }, '新说法只拿主人那句作来源');
  assert.deepEqual(owner({ verdict: 'changed', evidence: ['e3'] }).op, { op: 'changed', evidence: [103] });
});

test('评审 HIGH-2：降低把握只对低信任的断言（fact / identity / ability / state），而且要引用至少一句原话；看法、喜好、答应的事不降', () => {
  const lines = { e1: ['source', 'self'] };
  assert.equal(judgeCase({ lines })({ verdict: 'unsupported', evidence: ['e1'] }).verdict, 'doubted');
  assert.equal(judgeCase({ lines })({ verdict: 'unsupported', evidence: [] }).reason, 'doubt-without-evidence');
  for (const kind of ['opinion', 'preference', 'commitment', 'plan', 'insight']) {
    assert.equal(judgeCase({ kind, lines })({ verdict: 'unsupported', evidence: ['e1'] }).verdict, 'unclear', kind);
  }
  assert.equal(judgeCase({ certainty: 'stated', lines })({ verdict: 'unsupported', evidence: ['e1'] }).verdict, 'unclear', '本人说的不降');
});

test('评审 MEDIUM-4：关于别人的事，她自己的话只算听说——推不翻本人说的；推翻听说的时候新说法是「她说过」、把握 ≤ 0.5', () => {
  const lines = { e1: ['source', 'ming'], e2: ['later', 'self'] };
  assert.equal(judgeCase({ selfBelief: false, certainty: 'stated', lines })({ verdict: 'wrong', evidence: ['e2'], text: 'x' }).reason, 'weaker-evidence');
  const r = judgeCase({ selfBelief: false, certainty: 'hearsay', confidence: 0.6, lines })({ verdict: 'wrong', evidence: ['e2'], text: '阿明的表哥不开车了' });
  assert.deepEqual([r.verdict, r.op.certainty, r.op.confidence], ['corrected', 'self_said', 0.5]);
});

test('评审 MEDIUM-7：ability 被她做过的事反复确认（第二次起）把握升一级，最多 0.75，永远不变成 confirmed', () => {
  const lines = { e1: ['source', 'self'], e2: ['behavior', 'self'] };
  assert.equal(judgeCase({ kind: 'ability', confidence: 0.4, streak: 0, lines })({ verdict: 'confirmed', evidence: ['e2'] }).op, undefined, '第一次只记下核对过');
  assert.deepEqual(judgeCase({ kind: 'ability', confidence: 0.4, streak: 1, lines })({ verdict: 'confirmed', evidence: ['e2'] }).op, { op: 'raise', confidence: 0.5 });
  assert.deepEqual(judgeCase({ kind: 'ability', confidence: 0.7, streak: 3, lines })({ verdict: 'confirmed', evidence: ['e2'] }).op, { op: 'raise', confidence: 0.75 });
  assert.equal(judgeCase({ kind: 'ability', confidence: 0.75, streak: 3, lines })({ verdict: 'confirmed', evidence: ['e2'] }).op, undefined);
  assert.equal(judgeCase({ kind: 'fact', confidence: 0.4, streak: 3, lines })({ verdict: 'confirmed', evidence: ['e2'] }).op, undefined, '只对 ability');
});

test('没有主人的纠正时：她在群里实际说过话推不翻 fact——只记下核对过 / 看不出来；来源前面的几句只给她自己和有权限的人说的；给模型看过的全部记下', async () => {
  const calls = [];
  const llm = new FakeLLM({ fallback: { sleep: reply((req, text) => {
    const m = /\[(m\d+)\] 记忆/.exec(text)[1];
    const b = /我之后实际做过的[^\n]*\n\s+\[(e\d+)\]/.exec(text)[1];
    return [{ type: 'check', id: m, verdict: 'wrong', evidence: [b], text: '我能收到群里的消息', why: '我一直在群里回话' }];
  }) } });
  const w = await world({ llm, mods: { worker: lexical, encode: encodeFake(calls) } });
  try {
    const s = scene(w);
    w.core.store.run('DELETE FROM percepts WHERE id IN (?, ?)', s.fix, s.rumor);
    // 来源前面插一句没有权限的人说的（关于她自己的记忆：不给模型看）
    w.core.store.run('UPDATE percepts SET actor_entity_id = ? WHERE id = ?', s.ming, s.ask);
    const r = await correctStep(w.core, { run: newRun(12), at: AT });
    assert.equal(r.corrected, 0);
    assert.equal(calls.length, 0, '没有写回');
    const user = llm.callsFor('sleep')[0].messages[0].content;
    assert.ok(!user.includes('群里那条你看到没'), '来源前面那句是没有权限的人说的：不给');
    const row = w.core.store.get('SELECT * FROM memory_checks WHERE assertion_id = ?', s.claim.id);
    assert.equal(row.verdict, 'unclear');
    assert.deepEqual(JSON.parse(row.shown_json).sort((a, b) => a - b), [s.said, s.g1b, s.g2a].sort((a, b) => a - b), '给模型看过的全部记下（彻底删除的级联按它）');
  } finally { await w.cleanup(); }
});

test('评审 MEDIUM-3：主人撤销一次改正——旧版本按确认过恢复成新的一版（夜里不再挑），这一行记下撤销；撤过的、没改的、之后又换过版本的不撤', async () => {
  const calls = [];
  const w = await world({ llm: sensibleLLM('你在每个群都能收到消息'), mods: { worker: lexical, encode: encodeFake(calls) } });
  try {
    const s = scene(w);
    await correctStep(w.core, { run: newRun(12), at: AT });
    const row = w.core.store.get('SELECT * FROM memory_checks WHERE assertion_id = ?', s.claim.id);
    const r = w.core.mods.consolidate.revertCheck(w.core, row.id, { by: 'owner', at: AT + HOUR });
    assert.equal(r.reverted, true);
    const restored = w.core.store.get('SELECT * FROM assertions WHERE id = ?', Number(r.restored.slice(1)));
    assert.deepEqual([restored.text, restored.certainty], ['我这边收不到群里的消息，只能看到私聊里主人说的话', 'confirmed']);
    assert.equal(w.core.store.get('SELECT superseded_by FROM assertions WHERE id = ?', row.result_id).superseded_by, restored.id);
    const after = w.core.store.get('SELECT * FROM memory_checks WHERE id = ?', row.id);
    assert.deepEqual([after.reverted_by, after.restored_id, after.next_at], ['owner', restored.id, null]);
    assert.equal(w.core.mods.consolidate.revertCheck(w.core, row.id, { by: 'owner', at: AT + HOUR }).reason, 'already-reverted');
    assert.ok(!pickCandidates(w.core, AT + 30 * DAY, 50).some((c) => c.id === restored.id), '恢复成确认过的：夜里不再挑');
    const v = w.core.mods.admin.list(w.core, { view: 'checks' }).items[0];
    assert.equal(v.revertable, false);
    assert.equal(v.reverted.restored.ref, `a${restored.id}`);
    assert.equal(w.core.mods.consolidate.revertCheck(w.core, 999, {}).reason, 'not-found');
  } finally { await w.cleanup(); }
});

test('评审 MEDIUM-7：改出来的新版本也有「没核过」的加分（过了间隔会再核一次）', async () => {
  const w = await world({ llm: sensibleLLM('你在每个群都能收到消息'), mods: { worker: lexical, encode: encodeFake([]) } });
  try {
    const s = scene(w);
    await correctStep(w.core, { run: newRun(12), at: AT });
    const row = w.core.store.get('SELECT * FROM memory_checks WHERE assertion_id = ?', s.claim.id);
    const later = pickCandidates(w.core, row.next_at + 1, 10).find((c) => c.id === row.result_id);
    assert.ok(later, '到期了会再挑');
    assert.equal(later.score, 1 + 0.5, '改出来的（主人说的、stated）：至少再核一次 + 没核过');
  } finally { await w.cleanup(); }
});

test('代码核对：引用别的记忆的编号、wrong 却没有之后的证据 → 看不出来（只记一次核对）；unsupported 的她自己的话 → 把握降到 0.4', async () => {
  for (const [line, verdict, op] of [
    [{ verdict: 'wrong', evidence: ['e99'], text: 'x' }, 'unclear', null],
    [{ verdict: 'wrong', evidence: ['e1'], text: 'x' }, 'unclear', null],
    [{ verdict: 'unsupported', evidence: ['e1'] }, 'doubted', 'doubt'],
    [{ verdict: 'confirmed', evidence: ['e1'] }, 'confirmed', null],
  ]) {
    const calls = [];
    const llm = new FakeLLM({ fallback: { sleep: [{ type: 'check', id: 'm1', why: '理由', ...line }] } });
    const w = await world({ llm, mods: { worker: lexical, encode: encodeFake(calls) } });
    try {
      const s = scene(w);
      const r = await correctStep(w.core, { run: newRun(12), at: AT });
      assert.equal(r.checked, 1);
      const row = w.core.store.get('SELECT * FROM memory_checks WHERE assertion_id = ?', s.claim.id);
      assert.equal(row.verdict, verdict, JSON.stringify(line));
      assert.equal(calls[0]?.op.op ?? null, op);
      if (op === 'doubt') assert.equal(calls[0].op.confidence, 0.4);
      if (verdict === 'confirmed') {
        assert.equal(row.streak, 1);
        assert.equal(row.next_at, AT + recheckAfter(w.core.config.get().sleep.correct, 1, 0), '连续确认一次：间隔翻倍');
      }
    } finally { await w.cleanup(); }
  }
});

test('挑哪些：主人说的、钉住的、主人确认过的、隐藏的永远不挑；没人用、不是关于她的也不是约定的不挑；规矩和被常想起的挑', async () => {
  const w = await world({ llm: new FakeLLM(), mods: { worker: lexical } });
  try {
    const s = scene(w);
    const ownerSaid = w.fact({ text: '她最怕打雷', certainty: 'stated', subjects: [w.self], sources: [{ perceptId: s.ask, speaker: s.owner, at: T0 }] });
    const pinned = w.fact({ text: '我答应每天提醒主人喝水', certainty: 'self_said', kindHint: 'fact', subjects: [w.self], pinned: true });
    const confirmed = w.fact({ text: '我在南方长大', certainty: 'confirmed', subjects: [w.self] });
    const hidden = w.fact({ text: '我不会游泳', certainty: 'self_said', kindHint: 'ability', subjects: [w.self] });
    w.hidden.add(hidden.ref);
    const idle = w.fact({ text: '阿明觉得那部电影一般', certainty: 'stated', kindHint: 'opinion', subjects: [s.ming] });
    const rule = w.fact({ text: '群一里数字游戏的规则：报的数要乘三', certainty: 'stated', kindHint: 'rule', subjects: [s.ming] });
    const used = w.fact({ text: '阿明在杭州上班', certainty: 'stated', kindHint: 'fact', subjects: [s.ming] });
    for (let i = 0; i < 3; i++) w.core.store.run("INSERT INTO traces(owner_kind, owner_id, t, w, d, source_key, reason) VALUES ('assertion', ?, ?, 1, 0.5, ?, 'mention')", used.id, AT - HOUR, `m${i}`);
    const ability = w.fact({ text: '我看不了视频', certainty: 'self_said', kindHint: 'ability', subjects: [w.self] });
    const ids = pickCandidates(w.core, AT, 20).map((c) => c.id);
    assert.deepEqual(ids, [ability.id, s.claim.id, rule.id, used.id], '能力 > 关于自己的断言 > 规矩 > 常被想起的');
    for (const x of [ownerSaid, pinned, confirmed, hidden, idle]) assert.ok(!ids.includes(x.id));
  } finally { await w.cleanup(); }
});

test('额度和预算：一晚最多 maxCalls 次；预算不允许就整段跳过，不记核对', async () => {
  const w = await world({ llm: sensibleLLM('你在每个群都能收到消息'), budget: new FakeBudget({ perUse: { sleep: 0 } }), mods: { worker: lexical, encode: encodeFake([]) } });
  try {
    scene(w);
    const r = await correctStep(w.core, { run: newRun(12), at: AT });
    assert.equal(r.skipped, 'budget');
    assert.equal(w.core.store.get('SELECT count(*) AS n FROM memory_checks').n, 0);
    const capped = await correctStep(w.core, { run: { calls: 12, max: 12 }, at: AT });
    assert.equal(capped.skipped, 'llm-cap');
  } finally { await w.cleanup(); }
});

test('间隔：连续确认的次数翻倍、用得越多越勤，至少 minRecheckDays', () => {
  const c = { recheckDays: 7, minRecheckDays: 1, maxStreak: 8 };
  assert.equal(recheckAfter(c, 0, 0), 7 * DAY);
  assert.equal(recheckAfter(c, 2, 0), 28 * DAY);
  assert.equal(recheckAfter(c, 0, 1), 3.5 * DAY);
  assert.equal(recheckAfter(c, 0, 20), 1 * DAY);
  assert.equal(recheckAfter(c, 99, 0), 7 * 256 * DAY);
});

test('接在夜间整理第 2 步：先纠错再重放，调用算在一晚的上限里，结果在报告的 detail.correct', async () => {
  const calls = [];
  const llm = sensibleLLM('你在每个群都能收到消息');
  const w = await world({ llm, mods: { worker: lexical, encode: encodeFake(calls) } });
  try {
    scene(w);
    const r = await w.core.mods.consolidate.sleep(w.core, { at: AT });
    const s2 = r.steps.find((s) => s.step === 2);
    assert.equal(s2.name, 'replay');
    assert.equal(s2.detail.correct.corrected, 1);
    assert.equal(s2.llmCalls, 1, '纠错的那一次算在第 2 步');
    assert.ok(r.llmCalls >= 1);
    assert.equal(calls.length, 1);
  } finally { await w.cleanup(); }
});
