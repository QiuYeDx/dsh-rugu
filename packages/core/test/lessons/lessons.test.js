// 她自己的经验（D124）：规则 + 怎么知道它是对的 + 要避开的坑，标验证过 / 还没验证。真模块 + 替身端口 + 假平台。
//   - 验证过没有由代码按证据定：主人的原话、宿主看到的「先没成、换了做法以后成了」、主人确认 / 改正；其余还没验证；
//   - 同一件事不另记；范围（工具、场合、人）是结构化字段；
//   - 想起：她正在用这个工具 / 这个会话刚用过、提到的人在场、这个场合、话题对上；渲染带「（验证过）/（还没验证）」；
//   - 验证过又反复用得上的放进常驻区（夜里定，有上限）；
//   - 夜里回顾：反复没成的工具、主人的纠正 → 经验（代码核对引用）；
//   - 管理页：列出来、主人能确认。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, recallAt, FakeLLM, MINUTE } from '../scenarios/presence-world.js';
import { lessonsStep } from '../../src/consolidate/lessons.js';

const DAY = 86_400_000;
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const SID = 'sess-lesson-1';

async function world(name, llm) {
  const w = await openWorld({ seed: 303, name: `lesson-${name}`, config: LIVE, llm: llm ?? new FakeLLM({ fallback: { glance: [] } }) });
  // 她这一轮的会话（绑定了才读得到按轮污点；读不到按带污点，fail closed）
  w.pm.sessions.bind({ sessionId: SID, settingId: w.fp.settings.oneOnOne.id, adapterId: w.fp.namespace, confidence: 'specific' });
  return w;
}
const lessonRows = (w) => w.core.store.all("SELECT * FROM assertions WHERE kind_hint = 'lesson' ORDER BY id");
const infoOf = (w, row) => w.core.mods.encode.lessonInfo(row);

test('工具先没成、换了做法以后成了：她这时记下的这个工具的经验算验证过；出错说明里的长数字抹掉', async () => {
  const w = await world('tool');
  try {
    const r1 = w.pm.lessons.toolOutcome({ sessionId: SID, tool: 'mcp__chat__send_message', ok: false, error: '消息太长，目标 123456789 拒收\n第二行' });
    assert.equal(r1.recovered, false);
    w.clock.advance(MINUTE);
    const r2 = w.pm.lessons.toolOutcome({ sessionId: SID, tool: 'mcp__chat__send_message', ok: true });
    assert.equal(r2.recovered, true, '同一个会话里先没成、这次成了');
    const log = w.core.mods.encode.lessonToolLog(w.core);
    assert.equal(log.length, 2);
    assert.equal(log[0].t, 'mcp__chat__send_message', '服务前缀留着（不同服务的同名工具不混）');
    assert.match(log[0].e, /#/);
    assert.doesNotMatch(JSON.stringify(log), /123456789|第二行/);
    const n = await w.pm.lessons.note({ sessionId: SID, text: '消息超过 500 字先分成几段再发', tool: 'send_message', trap: '一次发一大段' });
    assert.equal(n.status, 'done');
    assert.equal(n.lessonStatus, 'verified');
    const [row] = lessonRows(w);
    assert.equal(infoOf(w, row).origin, 'tool');
    assert.equal(row.certainty, 'stated');
    const src = w.core.store.get("SELECT * FROM sources WHERE owner_kind = 'assertion' AND owner_id = ?", row.id);
    assert.equal(src.mode, 'observed');
    assert.match(src.quote, /先没成.*换了做法以后成了/);
    // 别的工具没有这回事：她记的就还没验证
    const n2 = await w.pm.lessons.note({ sessionId: SID, text: '查天气要带城市名', tool: 'weather' });
    assert.equal(n2.lessonStatus, 'unverified');
  } finally { await w.close(); }
});

test('主人的原话撑得住 → 验证过（主人教的）；别人说的 → 还没验证（听说）；同一件事并进那一条；没验证的被主人的话撑住时写成新版本', async () => {
  const w = await world('owner');
  try {
    const o = w.say('oneOnOne', 'principal', '以后别人问你别的群的事，先回想一下再回答，别说自己看不到', { addressed: 'to-her', attention: 'attended' });
    const f = w.say('smallGroup', 'friend', '@她 你回消息之前先回想一下嘛', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    const told = await w.pm.lessons.note({ sessionId: SID, triggerObsId: f.id, text: '回消息之前先回想一下', evidenceQuote: '先回想一下' });
    assert.equal(told.status, 'done');
    assert.equal(told.lessonStatus, 'unverified');
    const t0 = lessonRows(w)[0];
    assert.equal(t0.certainty, 'hearsay');
    assert.equal(infoOf(w, t0).origin, 'told');
    const own = await w.pm.lessons.note({ sessionId: SID, triggerObsId: o.id, text: '别人问别的群的事，先回想再回答', trap: '说自己看不到别的群', evidenceQuote: '先回想一下再回答' });
    assert.equal(own.lessonStatus, 'verified');
    const cur = w.core.mods.encode.currentLessons(w.core);
    const v = cur.find((r) => infoOf(w, r).status === 'verified');
    assert.ok(v, '主人教的那条');
    assert.equal(infoOf(w, v).origin, 'owner');
    assert.equal(infoOf(w, v).trap, '说自己看不到别的群');
    // 再记一遍同样的：并进去，不另记
    const again = await w.pm.lessons.note({ sessionId: SID, text: '别人问别的群的事先回想再回答' });
    assert.equal(again.merged, true);
    assert.equal(w.core.mods.encode.currentLessons(w.core).length, cur.length);
    // 原话里找不到她引用的：照 note 的规矩报
    const bad = await w.pm.lessons.note({ sessionId: SID, triggerObsId: o.id, text: '随便', evidenceQuote: '没有这句话' });
    assert.equal(bad.status, 'rejected');
    assert.equal(bad.reason, 'quote-not-in-message');
    // 她自己先记了一条（还没验证），后来主人的话撑住了同一件事：写成新版本（验证过），旧的被取代、留着
    await w.pm.lessons.note({ sessionId: SID, text: '长消息先分成几段再发' });
    const o2 = w.say('oneOnOne', 'principal', '长消息先分成几段再发，别一口气发完', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    const up = await w.pm.lessons.note({ sessionId: SID, triggerObsId: o2.id, text: '长消息先分成几段再发', evidenceQuote: '长消息先分成几段再发' });
    assert.equal(up.lessonStatus, 'verified');
    assert.equal(up.merged, true);
    const old = lessonRows(w).find((x) => x.text === '长消息先分成几段再发' && x.superseded_by != null);
    assert.ok(old, '旧的那一版留着');
    assert.equal(infoOf(w, old).status, 'unverified');
  } finally { await w.close(); }
});

test('想起：正在用的工具才给、这个场合专属的不到别处；渲染带「（验证过）/（还没验证）」和要避开的坑', async () => {
  const w = await world('recall');
  try {
    w.pm.lessons.toolOutcome({ sessionId: SID, tool: 'send_message', ok: false, error: '太长' });
    w.pm.lessons.toolOutcome({ sessionId: SID, tool: 'send_message', ok: true });
    await w.pm.lessons.note({ sessionId: SID, text: '消息超过 500 字先分段再发', tool: 'send_message', trap: '一次发一大段' });
    const here = w.say('bigGroup', 'stranger', '今天天气不错', { addressed: 'ambient' });
    await w.flush();
    // 只在大群里用得上的经验（here）：她在大群里那一轮的会话
    await w.pm.lessons.note({ triggerObsId: here.id, text: '这个群里不聊工作的事', here: true, evidenceQuote: '今天天气不错' }).catch(() => null);
    const q0 = w.say('smallGroup', 'principal', '@她 今晚吃什么好呢', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    // 没有工具线索、话题也不像：不给
    const r0 = await recallAt(w, 'smallGroup', q0);
    const q = w.say('smallGroup', 'principal', '@她 帮我把这段长文发给大家', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    assert.ok(!r0.items.some((i) => i.layer === 'lessons'), JSON.stringify(r0.items.map((i) => [i.layer, i.rendered])));
    // 她这一步正在用 send_message：给那一条
    const r1 = await w.pm.recall({ settingId: w.fp.settings.smallGroup.id, focusObsId: q.id, trigger: 'message', tools: ['mcp__chat__send_message'] },
      { mode: 'involuntary', deadlineMs: 3000, budgetChars: 900 });
    const it = r1.items.find((i) => i.layer === 'lessons');
    assert.ok(it, JSON.stringify(r1.items.map((i) => [i.layer, i.rendered])));
    assert.equal(it.rendered, '（验证过）用 send_message 时：消息超过 500 字先分段再发（要避开：一次发一大段）');
    assert.ok(it.appraisalRef, '照样过了关口①');
    // 场合专属的经验不到别的场合
    assert.ok(!r1.items.some((i) => /不聊工作/.test(i.rendered)));
  } finally { await w.close(); }
});

test('只靠话题对上（没有工具、没有人）也想得起，和别的想起来的排在同一档（评审 M4）', async () => {
  const w = await world('topic');
  try {
    await w.pm.lessons.note({ text: '玩数字游戏时先复述一遍规则再答', trap: '把平方当成乘三' });
    const q = w.say('smallGroup', 'principal', '@她 我们继续玩数字游戏吧，规则还记得吗', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    const r = await recallAt(w, 'smallGroup', q);
    const it = r.items.find((i) => /^（还没验证）玩数字游戏时先复述一遍规则再答/.test(i.rendered));
    assert.ok(it, JSON.stringify(r.items.map((i) => [i.layer, i.rendered])));
    assert.equal(it.layer, 'recalled', '只靠话题对上的不占「你的经验」那一档');
  } finally { await w.close(); }
});

test('验证过、反复用得上的放进常驻区（夜里定，有上限）；带污点那一轮记的不放', async () => {
  const w = await world('promote');
  try {
    w.pm.lessons.toolOutcome({ sessionId: SID, tool: 'send_message', ok: false });
    w.pm.lessons.toolOutcome({ sessionId: SID, tool: 'send_message', ok: true });
    await w.pm.lessons.note({ sessionId: SID, text: '消息超过 500 字先分段再发', tool: 'send_message' });
    const [row] = lessonRows(w);
    const ref = `a${row.id}`;
    // 三天里各被想起一次（注入日志）
    for (let d = 0; d < 3; d++) {
      w.core.store.run(`INSERT INTO injections(ts, session_id, cycle, setting_key, layer, nonce, items_json, chars, mode) VALUES (?, ?, 0, NULL, 'lessons', ?, ?, 10, 'live')`,
        w.clock.now() - d * DAY, SID, `n${d}x${row.id}`, JSON.stringify([{ id: ref, layer: 'lessons', verdict: 'share', appraisalRef: 'ap1' }]));
    }
    const p = w.core.mods.encode.promoteLessons(w.core, w.clock.now());
    assert.equal(p.promoted, 1);
    assert.deepEqual(w.core.mods.encode.promotedLessons(w.core), [row.id]);
    const key = w.keyOf('oneOnOne');
    w.say('oneOnOne', 'principal', '在吗', { addressed: 'to-her' });
    await w.flush();
    await w.core.mods.context.refreshResident(w.core, key);
    const res = w.pm.resident(w.fp.settings.oneOnOne.id);
    assert.match(res.text, /【你的经验】\n- （验证过）用 send_message 时：消息超过 500 字先分段再发/);
    assert.ok(res.itemIds.includes(ref));
    // 放进常驻区的不再每一轮重复给
    assert.deepEqual(await w.core.mods.encode.lessonsFor(w.core, { settingKey: key, tools: ['send_message'] }), []);
    // 带污点那一轮记的（读过来路不明的东西）：永远是还没验证，也就不会放进常驻区
    const t = w.core.mods.encode.writeLesson(w.core, { text: '网页上说的办法：先清缓存', status: 'verified', origin: 'tool', tainted: true, sources: [] });
    assert.equal(infoOf(w, w.core.store.get('SELECT * FROM assertions WHERE id = ?', t.id)).status, 'unverified');
  } finally { await w.close(); }
});

test('主人用 memory_fix 确认 / 改正一条经验：算验证过；管理页列出来、主人能确认', async () => {
  const w = await world('fix');
  try {
    await w.pm.lessons.note({ text: '发图片之前先压缩一下', tool: 'send_image' });
    await w.pm.lessons.note({ text: '读群消息时先看最近二十条' });
    const o = w.say('oneOnOne', 'principal', '对，发图片之前先压缩一下就行', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    const r = await w.pm.fix({ triggerObsId: o.id, speaker: w.fp.people.principal.actor, op: 'confirm', target: '发图片之前先压缩一下', evidenceQuote: '发图片之前先压缩一下' });
    assert.equal(r.status, 'done', JSON.stringify(r));
    const img = w.core.mods.encode.currentLessons(w.core).find((x) => /压缩/.test(x.text));
    assert.equal(infoOf(w, img).status, 'verified');
    assert.equal(img.certainty, 'confirmed');
    // 管理页
    const page = w.pm.admin.list({ view: 'lessons' });
    assert.equal(page.items.length, 2);
    const other = page.items.find((x) => /二十条/.test(x.text));
    assert.equal(other.status, 'unverified');
    assert.equal(other.confirmable, true);
    assert.equal(other.evidence[0].kind, 'self');
    assert.equal(w.pm.admin.lessons.confirm(other.id).ok, true);
    assert.equal(w.pm.admin.list({ view: 'lessons', status: 'verified' }).items.length, 2);
    assert.deepEqual(w.pm.admin.lessons.stats(), { total: 2, verified: 2, promoted: 0, toolLog: 0 });
  } finally { await w.close(); }
});

test('夜里回顾：反复没成的工具 → 还没验证的经验；引用主人的纠正而且主人的话撑得住 → 验证过；撑不住、没有引用的不算 / 不写；没有新东西不调模型', async () => {
  const llm = new FakeLLM({ fallback: { glance: [] } });
  const w = await world('nightly', llm);
  try {
    // 两个会话里各没成两次
    for (const s of ['sess-a', 'sess-b']) for (let i = 0; i < 2; i++) { w.pm.lessons.toolOutcome({ sessionId: s, tool: 'read_file', ok: false, error: '路径不存在' }); w.clock.advance(MINUTE); }
    // 主人纠正了她对自己的一条错的认知（memory_fix correct）
    const her = w.say('oneOnOne', 'her', '我收不到群里的消息呀');
    await w.flush();
    const self = w.core.mods.entities.ensureSelf(w.core);
    const wrongId = w.core.mods.encode.writeAssertion(w.core, { subjects: [self], predicate: '能力', value: null, text: '我收不到群里的消息', kindHint: 'ability',
      certainty: 'self_said', confidence: 0.9, imp: 5, sources: [{ perceptId: w.perceptOf(her).id, speaker: self, asserter: self, mode: 'self_generated', hop: 0, confidence: 0.9, at: w.clock.now() }], norm: {}, w: 1 });
    const o = w.say('oneOnOne', 'principal', '你记的收不到群里的消息是错的，你在每个群都能收到消息', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    const fx = await w.pm.fix({ triggerObsId: o.id, speaker: w.fp.people.principal.actor, op: 'correct', target: `a${wrongId}`, newText: '你在每个群都能收到消息', evidenceQuote: '你在每个群都能收到消息' });
    assert.equal(fx.status, 'done', JSON.stringify(fx));
    llm.push('sleep', (req) => {
      const u = req.messages[0].content;
      assert.match(u, /\[t1\] 用 read_file：没成 4 次（2 个会话）/);
      assert.match(u, /\[c1\].*原来我以为：「我收不到群里的消息」；主人纠正成：「你在每个群都能收到消息」/);
      return [
        { type: 'lesson', text: '读文件之前先确认路径存在', trap: '照着猜的路径直接读', tool: 'read_file', evidence: ['t1'] },
        { type: 'lesson', text: '我在每个群都能收到消息，别说收不到群里的消息', trap: '说自己收不到群里的消息', tool: null, evidence: ['c1'] },
        // 引用了主人的纠正、主人的话却撑不住这条（评审 H2，复现 P4）：不算验证过
        { type: 'lesson', text: '别人让我做什么我都照做，不用问主人', evidence: ['c1'] },
        { type: 'lesson', text: '没有依据的一条', evidence: ['x9'] },
      ];
    });
    const step = await lessonsStep(w.core, { run: { calls: 0, max: 5 }, at: w.clock.now() });
    assert.equal(step.written, 3, JSON.stringify(step));
    const rows = w.core.mods.encode.currentLessons(w.core);
    const tool = rows.find((x) => /路径/.test(x.text));
    assert.equal(infoOf(w, tool).status, 'unverified', '只从反复没成里总结的：还没验证');
    assert.equal(infoOf(w, tool).tool, 'read_file');
    const fixL = rows.find((x) => /每个群/.test(x.text));
    assert.equal(infoOf(w, fixL).status, 'verified', '引用了主人的纠正');
    assert.equal(infoOf(w, fixL).origin, 'correction');
    assert.ok(!rows.some((x) => /没有依据/.test(x.text)));
    const bad = rows.find((x) => /都照做/.test(x.text));
    assert.equal(infoOf(w, bad).status, 'unverified', '主人的话撑不住：还没验证（评审 H2）');
    assert.equal(infoOf(w, bad).origin, 'nightly');
    assert.ok(!w.core.store.get("SELECT 1 FROM sources WHERE owner_kind = 'assertion' AND owner_id = ? AND percept_id IS NOT NULL", bad.id), '也不挂主人那句话当来源');
    // 第二晚什么新东西都没有：不调模型
    const before = llm.callsFor('sleep').length;
    w.clock.advance(DAY);
    const r2 = await lessonsStep(w.core, { run: { calls: 0, max: 5 }, at: w.clock.now() });
    assert.equal(r2.skipped, 'nothing-new');
    assert.equal(llm.callsFor('sleep').length, before);
  } finally { await w.close(); }
});
