// 写入函数（§5.3、§5.4、§7.2）：writeEpisode / writeAssertion / addSource / supersede / markChanged / ensurePredicate /
// derivedFrom / onPerceptRetracted / onPerceptEdited。都在调用方的事务里，顺带写 FTS、来源、规范、谁知道、痕迹、嵌入文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ftsSearch } from '../../src/store/fts.js';
import { makeWorld, DAY, HOUR } from './harness.js';
import { reviseAssertion } from '../../src/encode/write.js';

async function setup() {
  const w = await makeWorld();
  const ming = w.entity('阿明', { closeness: 0.3 });
  const owner = w.entity('阿杰', { closeness: 1, authority: 'principal' });
  const g = w.setting('游戏群', { exposure: 2, label: '某游戏群' });
  const dm = w.setting('私聊', { exposure: 0 });
  return { w, ming, owner, g, dm, enc: w.core.mods.encode };
}
const src = (p, o = {}) => ({ perceptId: p, speaker: o.speaker ?? null, asserter: o.asserter ?? o.speaker ?? null, mode: o.mode ?? 'overheard', hop: o.hop ?? 0,
  quote: o.quote ?? null, confidence: 0.8, at: o.at });

test('writeEpisode：主表 + FTS（上下文头 + 叙述）+ 来源 + 规范（involves_others 由代码算）+ 谁知道 + 痕迹（证据时间）+ 嵌入块（场合名不进）', async () => {
  const { w, ming, g, enc } = await setup();
  try {
    const p1 = w.percept(g, ming, '我表哥开网约车', { presenceSetId: 7 });
    const at = w.clock.now();
    w.clock.hours(3);   // 处理晚了：痕迹时间仍用证据时间
    const narrative = '某游戏群里阿明说他表哥开网约车。'.repeat(40);
    const id = enc.writeEpisode(w.core, {
      settingKey: g.key, kind: 'event', title: '聊表哥', header: '2026-10-31 18:00，阿明聊他表哥', narrative, tStart: at, tEnd: at,
      participants: [ming], sources: [src(p1, { speaker: ming, at })], norm: { restriction: 'none', involvesOthers: false }, w: 0.7, jobId: null,
    });
    const ep = w.core.store.get('SELECT * FROM episodes WHERE id = ?', id);
    assert.equal(ep.ep_kind, 'event');
    assert.equal(ep.setting_key, g.key);
    assert.deepEqual(JSON.parse(ep.participants_json), [ming]);
    assert.ok(ftsSearch(w.core.store, 'episodes_fts', ['表哥']).some((h) => h.rowid === id));
    assert.ok(ftsSearch(w.core.store, 'episodes_fts', [`ent_${ming}`]).some((h) => h.rowid === id), '参与者的实体词元也进 FTS');
    assert.equal(w.sources('episode', id).length, 1);
    const norm = w.callsOf('writeNorm').find((c) => c.ref === `e${id}`).norm;
    assert.equal(norm.involvesOthers, true, '不信调用方给的 involvesOthers');
    assert.equal(norm.originExposure.exposureRank, 2);
    assert.equal(norm.settingRuleRef, g.key);
    const kn = w.callsOf('recordKnowledge').find((c) => c.ref === `e${id}`).entries;
    assert.ok(kn.some((e) => e.whoKind === 'setting' && e.whoRef === g.key && e.basis === 'setting'));
    assert.ok(kn.some((e) => e.whoKind === 'presence_set' && e.whoRef === '7'));
    const tr = w.callsOf('addTrace').find((c) => c.ref === `e${id}`);
    assert.equal(tr.t, at);
    assert.equal(tr.w, 0.7);
    assert.equal(tr.reason, 'encode');
    const chunks = w.embeds.get(`e${id}`);
    assert.ok(chunks.length > 1, '超过 400 字按 200–400 字切块');
    for (const c of chunks) {
      assert.ok([...c.text].length <= 400 + 40);
      assert.ok(c.text.startsWith('2026-10-31 18:00，阿明聊他表哥'), '每块都带上下文头');
    }
    assert.ok(!chunks.some((c) => c.text.includes('某游戏群')), '场合名不进嵌入文本（模型写进叙述了也去掉）');
    assert.ok(ep.narrative.includes('某游戏群'), '存着的叙述不改');
  } finally { await w.cleanup(); }
});

test('writeEpisode：导入的不加痕迹、不写谁知道；她私下读到的只有她自己知道（不写别人）', async () => {
  const { w, ming, g, enc } = await setup();
  try {
    const id = enc.writeEpisode(w.core, { settingKey: 'imp', kind: 'import', title: 't', header: 'h', narrative: 'n', tStart: 1, tEnd: 1, participants: [ming],
      sources: [{ perceptId: null, speaker: null, asserter: null, mode: 'imported', hop: 1, confidence: 0.6, at: 1 }], norm: {}, w: 1 });
    assert.equal(w.callsOf('addTrace').filter((c) => c.ref === `e${id}`).length, 0);
    assert.equal(w.callsOf('recordKnowledge').filter((c) => c.ref === `e${id}`).length, 0);
    const p = w.percept(g, ming, '一段素材', { kind: 'content', visibleTo: 'her-only', standing: 'material' });
    const id2 = enc.writeEpisode(w.core, { settingKey: g.key, kind: 'event', title: 't', header: 'h', narrative: 'n', tStart: 1, tEnd: 1, participants: [],
      sources: [src(p, { mode: 'read', at: 1 })], norm: {}, w: 1 });
    const kn = w.callsOf('recordKnowledge').find((c) => c.ref === `e${id2}`).entries;
    assert.deepEqual(kn, []);
    // 私下读到的内容：原始受众是内容所属场合的受众（§5.3），不是「一对一」；谁知道照样只有她自己
    assert.equal(w.callsOf('writeNorm').find((c) => c.ref === `e${id2}`).norm.originExposure.exposureRank, 2);
  } finally { await w.cleanup(); }
});

test('她私下读到的、原属另一个场合的内容（§5.3「原始场合的受众 + 她自己」）：谁知道写那个场合的受众和原作者，不写她读的时候所在的会话', async () => {
  const { w, ming, g, dm, enc } = await setup();
  try {
    const pub = w.setting('公开区', { exposure: 3, persistence: 2 });
    // 在私聊里替主人看了游戏群（内容属于游戏群）、看了一个公开视频（内容属于公开区）
    const fromGroup = w.percept(g, ming, '下周六一起开黑', { kind: 'content', visibleTo: 'her-only', standing: 'material', perceivedIn: dm.key });
    const fromVideo = w.percept(pub, ming, '新版本主角可以在水下呼吸了', { kind: 'content', visibleTo: 'her-only', standing: 'material', perceivedIn: dm.key });
    const fact = (p) => enc.writeAssertion(w.core, { subjects: [ming], predicate: 'x', text: '一件事', kindHint: 'fact', certainty: 'stated', confidence: 0.8, imp: 4,
      sources: [src(p, { mode: 'read', at: 1 })], norm: {}, w: 1 });
    const kn = (id) => w.callsOf('recordKnowledge').find((c) => c.ref === `a${id}`).entries;
    const a1 = fact(fromGroup);
    const e1 = kn(a1);
    assert.ok(e1.some((e) => e.whoKind === 'setting' && e.whoRef === g.key && e.basis === 'setting'), JSON.stringify(e1));
    assert.ok(e1.some((e) => e.whoKind === 'entity' && e.whoRef === String(ming)), '原作者知道自己写的');
    assert.ok(!e1.some((e) => e.whoRef === dm.key), '她读的时候所在的会话不算');
    const e2 = kn(fact(fromVideo));
    assert.ok(e2.some((e) => e.whoKind === 'setting' && e.whoRef === pub.key && e.basis === 'public'), '公开内容：公开可得（不进已知圈，PS-05）');
    // 她心里想的、她在这里私下读到的（原场合不知道）：照旧只有她自己
    const thought = w.percept(g, 'self', '阿明今天好像很烦', { kind: 'self-thought', visibleTo: 'her-only', perceivedIn: dm.key });
    assert.deepEqual(kn(fact(thought)), []);
    const here = w.percept(dm, ming, '一段素材', { kind: 'content', visibleTo: 'her-only', standing: 'material' });
    assert.deepEqual(kn(fact(here)), []);
  } finally { await w.cleanup(); }
});

test('来源的公开程度（§5.3）：公开视频里说的事是公开的（A3 才用得上）；她心里想的最私密，和别的来源一起时也取它', async () => {
  const { w, ming, g, enc } = await setup();
  try {
    const pub = w.setting('公开区', { exposure: 3, persistence: 2 });
    const video = w.percept(pub, ming, '新版本主角可以在水下呼吸了', { kind: 'content', visibleTo: 'her-only', standing: 'material' });
    const thought = w.percept(g, 'self', '阿明今天好像很烦', { kind: 'self-thought', visibleTo: 'her-only' });
    const said = w.percept(g, ming, '我今天加班');
    const exp = (ps) => enc.writeAssertion(w.core, { subjects: [ming], predicate: 'x', text: '一件事', kindHint: 'fact', certainty: 'stated', confidence: 0.8, imp: 4,
      sources: ps.map((p) => src(p, { at: 1 })), norm: {}, w: 1 });
    const oe = (id) => w.callsOf('writeNorm').find((c) => c.ref === `a${id}`).norm.originExposure;
    const a1 = exp([video]);
    assert.deepEqual([oe(a1).exposureRank, oe(a1).persistenceRank, oe(a1).settingKey], [3, 2, pub.key], '公开内容：任何人可见、公开留存');
    assert.deepEqual(w.callsOf('recordKnowledge').find((c) => c.ref === `a${a1}`).entries, [], '私下读的：谁知道只有她自己（不经 A1）');
    assert.equal(oe(exp([thought])).exposureRank, 0, '心里想的只有她自己');
    assert.equal(oe(exp([said, thought])).exposureRank, 0, '和当众说的一起：取最私密的');
    assert.equal(oe(exp([video, said])).exposureRank, 2, '公开内容和群里说的一起：取更窄的那个群');
  } finally { await w.cleanup(); }
});

test('writeAssertion：主表、FTS、实体边、来源、规范、谁知道、痕迹、嵌入（含 future_q 块）；听说的 confidence ≤ 0.6 但 w 不打折', async () => {
  const { w, ming, g, enc } = await setup();
  try {
    const gang = w.entity('小刚');
    const p = w.percept(g, ming, '我表哥开网约车，千万别说');
    const at = w.clock.now();
    const id = enc.writeAssertion(w.core, {
      subjects: [gang], mentions: [ming], predicate: '职业', value: '网约车司机', text: '阿明的表哥开网约车', kindHint: 'state', certainty: 'hearsay', confidence: 0.95, imp: 4,
      survival: { t50h: 2000, shape: 1 }, futureQ: ['他表哥干啥的', 'b', 'c', 'd'], sources: [src(p, { speaker: ming, hop: 1, quote: '表哥开网约车', at })],
      norm: { restriction: 'strict', restrictionQuote: '千万别说' }, w: 0.9,
    });
    const a = w.assertion(id);
    assert.equal(a.confidence, 0.6, '听说的 confidence 不超过上限');
    assert.equal(a.valid_from, at, '没给开始时间：用证据消息的时间');
    assert.equal(a.t50_h, 2000);
    assert.equal(a.predicate, '职业');
    assert.equal(a.occurrence_key, null, '状态类没有发生次');
    const roles = w.core.store.all('SELECT entity_id, role FROM assertion_entities WHERE assertion_id = ? ORDER BY role', id);
    assert.deepEqual(roles.map((r) => `${r.role}:${r.entity_id}`).sort(), [`asserter:${ming}`, `mention:${ming}`, `speaker:${ming}`, `subject:${gang}`].sort());
    assert.ok(ftsSearch(w.core.store, 'assertions_fts', ['网约']).some((h) => h.rowid === id));
    assert.ok(ftsSearch(w.core.store, 'assertions_fts', [`ent_${gang}`]).some((h) => h.rowid === id));
    const s = w.sources('assertion', id)[0];
    assert.equal(s.quote, '表哥开网约车');
    assert.equal(s.mode, 'overheard');
    const norm = w.callsOf('writeNorm').find((c) => c.ref === `a${id}`).norm;
    assert.equal(norm.restriction, 'strict');
    assert.equal(norm.involvesOthers, true);
    assert.equal(w.callsOf('addTrace').find((c) => c.ref === `a${id}`).w, 0.9, '编码强度不因为是听说打折');
    const chunks = w.embeds.get(`a${id}`);
    assert.deepEqual(chunks.map((c) => c.kind), ['text', 'fq', 'fq', 'fq'], 'future_q ≤ 3 条');
    // 只涉及她自己和非人物：involves_others = false（模型说什么都不信）
    const cat = w.entity('猫', { kind: 'animal', identity: false });
    const id2 = enc.writeAssertion(w.core, { subjects: [cat], predicate: '她的看法', text: '我喜欢猫', kindHint: 'opinion', certainty: 'self_said', confidence: 0.9, imp: 5,
      sources: [{ perceptId: null, speaker: w.self, asserter: w.self, mode: 'self_generated', hop: 0, confidence: 0.9, at }], norm: { involvesOthers: true }, w: 1 });
    assert.equal(w.callsOf('writeNorm').find((c) => c.ref === `a${id2}`).norm.involvesOthers, false);
    // 她推断的结论：证据是当众说的，「谁知道」仍然只有她自己（§5.6 第 6 条）
    const id3 = enc.writeAssertion(w.core, { subjects: [ming], predicate: '心情', text: '阿明今天好像心情不好', kindHint: 'state', certainty: 'inferred', confidence: 0.4, imp: 4,
      sources: [src(p, { speaker: w.self, mode: 'inferred', at })], norm: {}, w: 0.5 });
    assert.deepEqual(w.callsOf('recordKnowledge').find((c) => c.ref === `a${id3}`).entries, []);
  } finally { await w.cleanup(); }
});

test('writeAssertion：计划带 occurrence_key 和初始状态历史；导入的不加痕迹、不写谁知道', async () => {
  const { w, owner, dm, enc } = await setup();
  try {
    const p = w.percept(dm, owner, '等下去拿快递', { addressed: 'to-her' });
    const win = { start: w.clock.now(), end: w.clock.now() + 3 * HOUR, precision: 'fuzzy' };
    const id = enc.writeAssertion(w.core, { subjects: [owner], predicate: '取快递', text: '阿杰要去拿快递', kindHint: 'plan', certainty: 'stated', confidence: 0.9, imp: 3,
      plannedTime: win, plan: { agent: owner, status: 'planned' }, sources: [src(p, { speaker: owner, mode: 'told_to_her', at: w.clock.now() })], norm: {}, w: 1 });
    const a = w.assertion(id);
    assert.ok(a.occurrence_key);
    assert.equal(a.plan_status, 'planned');
    assert.equal(a.plan_agent, owner);
    assert.deepEqual(JSON.parse(a.planned_time_json), win);
    assert.deepEqual(w.core.mods.encode.planHistory(w.core, id).map((h) => h.status), ['planned']);
    // 同一件事、同一天的另一句：同一个 occurrence_key；下周的：不同
    const k2 = enc.writeAssertion(w.core, { subjects: [owner], predicate: '取快递', text: 'x', kindHint: 'plan', certainty: 'stated', confidence: 0.9, imp: 3,
      plannedTime: { ...win, start: win.start + 7 * DAY, end: win.end + 7 * DAY }, plan: { agent: owner, status: 'planned' }, sources: [src(p, { at: 1 })], norm: {}, w: 1 });
    assert.notEqual(w.assertion(k2).occurrence_key, a.occurrence_key);
    const imp = enc.writeAssertion(w.core, { subjects: [owner], predicate: '记录', text: '导入的', kindHint: 'fact', certainty: 'stated', confidence: 0.6, imp: 5,
      sources: [{ perceptId: null, speaker: null, asserter: null, mode: 'imported', hop: 1, confidence: 0.6, at: 1 }], norm: {}, w: 1 });
    assert.equal(w.callsOf('addTrace').filter((c) => c.ref === `a${imp}`).length, 0);
    assert.equal(w.callsOf('recordKnowledge').filter((c) => c.ref === `a${imp}`).length, 0);
  } finally { await w.cleanup(); }
});

test('addSource 追加来源不改写旧来源、加一条「又遇到了一次」的痕迹（按来源去重的键）；supersede 两条都保留、继承激活；markChanged 只标变了', async () => {
  const { w, ming, owner, g, dm, enc } = await setup();
  try {
    const p1 = w.percept(g, ming, '阿杰在减肥');
    const t0 = w.clock.now();
    const id = enc.writeAssertion(w.core, { subjects: [owner], predicate: '状态', text: '阿杰在减肥', kindHint: 'state', certainty: 'hearsay', confidence: 0.5, imp: 5,
      sources: [src(p1, { speaker: ming, hop: 1, at: t0 })], norm: {}, w: 1 });
    w.clock.hours(5);
    const p2 = w.percept(dm, owner, '我在减肥', { addressed: 'to-her' });
    enc.addSource(w.core, { kind: 'assertion', id }, src(p2, { speaker: owner, mode: 'told_to_her', at: w.clock.now() }), { w: 1.4, reason: 'mention' });
    const ss = w.sources('assertion', id);
    assert.equal(ss.length, 2);
    assert.equal(ss[0].percept_id, p1, '旧来源不动');
    const tr = w.callsOf('addTrace').filter((c) => c.ref === `a${id}`);
    assert.equal(tr.length, 2);
    assert.equal(tr[1].sourceKey, `speaker:${owner}`);
    assert.equal(tr[1].reason, 'mention');
    assert.ok(w.callsOf('recordKnowledge').filter((c) => c.ref === `a${id}`).at(-1).entries.some((e) => e.basis === 'subject' && e.whoRef === String(owner)),
      '本人在场说的：主体本人知道');
    // 取代
    w.clock.hours(1);
    const nid = enc.writeAssertion(w.core, { subjects: [owner], predicate: '状态', text: '阿杰不减肥了', kindHint: 'state', certainty: 'stated', confidence: 0.9, imp: 5,
      validFrom: w.clock.now(), sources: [src(p2, { speaker: owner, at: w.clock.now() })], norm: {}, w: 1 });
    enc.supersede(w.core, id, nid, { at: w.clock.now() });
    const old = w.assertion(id);
    const nw = w.assertion(nid);
    assert.equal(old.valid_to_known, nw.valid_from);
    assert.equal(old.expired_at, w.clock.now());
    assert.equal(old.superseded_by, nid);
    assert.equal(nw.supersedes, id);
    assert.deepEqual(w.callsOf('inheritActivation').at(-1), { from: `a${id}`, to: `a${nid}`, ctx: { at: w.clock.now() } });
    assert.equal(w.assertions().length, 2, '失效但不删除');
    // 变了未知
    enc.markChanged(w.core, nid, { at: w.clock.now(), source: src(p1, { speaker: ming, at: w.clock.now() }) });
    assert.equal(w.assertion(nid).change_known, 1);
    assert.equal(w.assertion(nid).superseded_by, null);
    assert.equal(w.sources('assertion', nid).length, 2);
  } finally { await w.cleanup(); }
});

test('ensurePredicate：属性键是数据；同义的写法（大小写、空白、连字符）归到同一个规范名并登记成同义词', async () => {
  const { w, enc } = await setup();
  try {
    assert.equal(enc.ensurePredicate(w.core, '职业', { createdBy: 'extractor' }), '职业');
    assert.equal(enc.ensurePredicate(w.core, ' 职 业 ', { createdBy: 'extractor' }), '职业');
    assert.equal(enc.ensurePredicate(w.core, 'Home-City', { createdBy: 'extractor', cardinality: 'one', isCurrent: true }), 'home-city');
    assert.equal(enc.ensurePredicate(w.core, 'home city', { createdBy: 'extractor' }), 'home-city');
    const row = w.core.store.get("SELECT * FROM predicates WHERE key = '职业'");
    assert.deepEqual(JSON.parse(row.synonyms_json), ['职 业']);
    assert.equal(w.core.store.get("SELECT is_current FROM predicates WHERE key = 'home-city'").is_current, 1);
    assert.equal(w.core.store.get("SELECT COUNT(*) AS n FROM predicates").n, 4);
  } finally { await w.cleanup(); }
});

test('derivedFrom 按来源链找派生（onlySource）；撤回：派生的规范收紧到至少 soft、原话不再展示；编辑：依赖它的事实标 needs_review；两个通知都不抛错', async () => {
  const { w, ming, g, enc } = await setup();
  try {
    const p1 = w.percept(g, ming, '我表哥开网约车');
    const p2 = w.percept(g, ming, '真的');
    const only = enc.writeAssertion(w.core, { subjects: [ming], predicate: 'a', text: 'x', kindHint: 'fact', certainty: 'stated', confidence: 0.8, imp: 5,
      sources: [src(p1, { speaker: ming, quote: '表哥开网约车', at: 1 })], norm: {}, w: 1 });
    const both = enc.writeAssertion(w.core, { subjects: [ming], predicate: 'b', text: 'y', kindHint: 'fact', certainty: 'stated', confidence: 0.8, imp: 5,
      sources: [src(p1, { speaker: ming, at: 1 }), src(p2, { speaker: ming, at: 1 })], norm: {}, w: 1 });
    const d = enc.derivedFrom(w.core, p1);
    assert.deepEqual(d.sort((x, y) => x.ref.localeCompare(y.ref)), [{ ref: `a${only}`, onlySource: true }, { ref: `a${both}`, onlySource: false }]);
    enc.onPerceptRetracted(w.core, p1);
    assert.deepEqual(w.callsOf('tightenNorm').map((c) => [c.ref, c.t.restriction]).sort(), [[`a${both}`, 'soft'], [`a${only}`, 'soft']].sort());
    assert.equal(w.sources('assertion', only)[0].quote, null);
    enc.onPerceptEdited(w.core, p2, p2 + 100);
    assert.equal(w.assertion(both).needs_review, 1);
    assert.equal(w.assertion(only).needs_review, 0);
    // 不抛错：依赖坏了只计数、记日志
    const bad = await makeWorld({ mods: { discretion: { tightenNorm: () => { throw new Error('boom'); } } } });
    try {
      const gg = bad.setting('群', { exposure: 2 });
      const a = bad.entity('甲');
      const pp = bad.percept(gg, a, '你好');
      bad.core.mods.encode.writeAssertion(bad.core, { subjects: [a], predicate: 'a', text: 'x', kindHint: 'fact', certainty: 'stated', confidence: 0.8, imp: 5,
        sources: [src(pp, { speaker: a, at: 1 })], norm: {}, w: 1 });
      assert.doesNotThrow(() => bad.core.mods.encode.onPerceptRetracted(bad.core, pp));
      assert.equal(bad.logger.events('encode.retracted.failed').length, 1);
    } finally { await bad.cleanup(); }
  } finally { await w.cleanup(); }
});

test('reviseAssertion：新版本照搬旧版本的规范——来源还没评估完（unassessed）时保留已合并的限制、至少 soft，读不到规范按 soft，都不丢成「无限制」', async () => {
  let normOf = () => null;
  const w = await makeWorld({ mods: { discretion: { normOf: (c, ref) => normOf(c, ref) } } });
  try {
    const ming = w.entity('阿明', { closeness: 0.3 });
    const g = w.setting('游戏群', { exposure: 2 });
    const enc = w.core.mods.encode;
    const p = w.percept(g, ming, '我下个月换工作，别告诉别人');
    const id = enc.writeAssertion(w.core, { subjects: [ming], predicate: '工作', text: '阿明下个月换工作', kindHint: 'state', certainty: 'stated', confidence: 0.9, imp: 5,
      sources: [src(p, { speaker: ming, mode: 'told_to_her', at: w.clock.now() })], norm: { restriction: 'strict', deny: [] }, w: 1 });
    // 证据里有条还没评估完：discretion 报 unassessed，但已合并的限制是 strict、deny 有人
    normOf = () => ({ unassessed: true, version: 2, restriction: 'strict', allow: null, deny: [ming], sensitivity: 0.6 });
    const n1 = reviseAssertion(w.core, id, { kindHint: 'plan' }, { at: w.clock.now() });
    const norm1 = w.callsOf('writeNorm').filter((c) => c.ref === `a${n1}`).at(-1).norm;
    assert.equal(norm1.restriction, 'strict', '已合并的 strict 不丢');
    assert.deepEqual(norm1.deny, [ming]);
    assert.ok(!('unassessed' in norm1) && !('version' in norm1));
    // 只是还没评估、没有限制：至少 soft
    normOf = () => ({ unassessed: true, version: 0, restriction: 'none', allow: null, deny: null });
    const n2 = reviseAssertion(w.core, n1, { kindHint: 'state' }, { at: w.clock.now() });
    assert.equal(w.callsOf('writeNorm').filter((c) => c.ref === `a${n2}`).at(-1).norm.restriction, 'soft');
    // 读不到：按 soft
    normOf = () => { throw new Error('discretion down'); };
    const n3 = reviseAssertion(w.core, n2, { kindHint: 'plan' }, { at: w.clock.now() });
    assert.equal(w.callsOf('writeNorm').filter((c) => c.ref === `a${n3}`).at(-1).norm.restriction, 'soft');
  } finally { await w.cleanup(); }
});

test('applyCorrection（D122）：correct 写改正后的新版本（来源 = 证据感知、说话人和方式按感知算、出处记下）、旧的被取代；doubt 降把握；changed 只标变了；已被取代的不动', async () => {
  const { w, owner, dm, g, enc } = await setup();
  try {
    const self = w.self;
    const said = w.percept(dm, 'self', '群里那条我这边真收不到');
    const id = enc.writeAssertion(w.core, { subjects: [self], predicate: '收不到群消息', text: '我收不到群里的消息', kindHint: 'fact', certainty: 'self_said', confidence: 0.9, imp: 4,
      sources: [src(said, { speaker: self, mode: 'self_generated', at: w.clock.now() })], norm: {}, w: 1 });
    w.clock.hours(20);
    const fix = w.percept(dm, owner, '你在每个群都能收到消息', { addressed: 'to-her' });
    const nid = enc.applyCorrection(w.core, id, { op: 'correct', text: '我在每个群都能收到消息', certainty: 'stated', confidence: 0.9, evidence: [fix],
      extractVer: 'consolidate-correction-v1#x', model: 'm' }, { at: w.clock.now() });
    const nw = w.assertion(nid);
    assert.deepEqual([nw.text, nw.certainty, nw.confidence, nw.predicate, nw.kind_hint, nw.extract_ver], ['我在每个群都能收到消息', 'stated', 0.9, '收不到群消息', 'fact', 'consolidate-correction-v1#x']);
    assert.equal(w.assertion(id).superseded_by, nid, '旧的被取代，照样留着');
    const s = w.sources('assertion', nid);
    assert.deepEqual(s.map((x) => [x.percept_id, x.speaker, x.mode, x.hop]), [[fix, owner, 'told_to_her', 1]]);
    assert.deepEqual(w.callsOf('inheritNorm').at(-1).evidence, [`a${id}`, `p${fix}`]);
    assert.equal(enc.applyCorrection(w.core, id, { op: 'doubt', confidence: 0.4 }, { at: w.clock.now() }), null, '已经有新版本了：不动');
    // 降把握：新版本、来源照抄
    const g1 = w.percept(g, 'self', '我会弹钢琴');
    const a2 = enc.writeAssertion(w.core, { subjects: [self], predicate: '会弹琴', text: '我会弹钢琴', kindHint: 'ability', certainty: 'self_said', confidence: 0.9, imp: 3,
      sources: [src(g1, { speaker: self, mode: 'self_generated', at: w.clock.now() })], norm: {}, w: 1 });
    const d = enc.applyCorrection(w.core, a2, { op: 'doubt', confidence: 0.4, extractVer: 'consolidate-correction-v1#x' }, { at: w.clock.now() });
    assert.notEqual(d, a2);
    assert.deepEqual([w.assertion(d).confidence, w.assertion(d).extract_ver, w.assertion(a2).superseded_by], [0.4, 'consolidate-correction-v1#x', d]);
    assert.equal(enc.applyCorrection(w.core, d, { op: 'doubt', confidence: 0.4 }, { at: w.clock.now() }), d, '本来就不高于它：不动');
    // 变了未知
    const c = enc.applyCorrection(w.core, d, { op: 'changed', evidence: [fix] }, { at: w.clock.now() });
    assert.equal(c, d);
    assert.equal(w.assertion(d).change_known, 1);
  } finally { await w.cleanup(); }
});

test('applyCorrection 评审补：changed 不加来源和痕迹（不会因此更容易被想起、也不会变成主人说的）；raise 只升；restore 按确认过恢复；换版本时开着的意图跟着走', async () => {
  const { w, owner, dm, enc } = await setup();
  try {
    const self = w.self;
    const said = w.percept(dm, 'self', '我会弹钢琴');
    const id = enc.writeAssertion(w.core, { subjects: [self], predicate: '会弹琴', text: '我会弹钢琴', kindHint: 'ability', certainty: 'self_said', confidence: 0.4, imp: 3,
      sources: [src(said, { speaker: self, mode: 'self_generated', at: w.clock.now() })], norm: {}, w: 1 });
    const t = w.core.store.run(`INSERT INTO intentions(about_kind, about_id, target_entity_id, act, text, origin, state, formed_at, created_at, updated_at)
        VALUES ('assertion', ?, ?, '分享', '弹给主人听', 'self-care', 'formed', ?, ?, ?)`, id, owner, w.clock.now(), w.clock.now(), w.clock.now()).lastInsertRowid;
    const fix = w.percept(dm, owner, '你不会弹钢琴吧', { addressed: 'to-her' });
    const traces = w.callsOf('addTrace').length;
    assert.equal(enc.applyCorrection(w.core, id, { op: 'changed', evidence: [fix] }, { at: w.clock.now() }), id);
    assert.equal(w.assertion(id).change_known, 1);
    assert.equal(w.sources('assertion', id).length, 1, '不加来源（主人那句不会让它变成主人说的）');
    assert.equal(w.callsOf('addTrace').length, traces, '不加痕迹');
    assert.equal(enc.applyCorrection(w.core, id, { op: 'raise', confidence: 0.3 }, { at: w.clock.now() }), id, '只升不降');
    const up = enc.applyCorrection(w.core, id, { op: 'raise', confidence: 0.5 }, { at: w.clock.now() });
    assert.deepEqual([w.assertion(up).confidence, w.assertion(id).superseded_by], [0.5, up]);
    assert.equal(w.core.store.get('SELECT about_id FROM intentions WHERE id = ?', t).about_id, up, '开着的意图指向新版本');
    const back = enc.applyCorrection(w.core, up, { op: 'restore', from: id }, { at: w.clock.now() });
    assert.deepEqual([w.assertion(back).certainty, w.assertion(back).confidence, w.assertion(back).change_known, w.assertion(up).superseded_by], ['confirmed', 0.9, 0, back]);
    assert.equal(w.core.store.get('SELECT about_id FROM intentions WHERE id = ?', t).about_id, back);
  } finally { await w.cleanup(); }
});
