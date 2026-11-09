// 关口①第一段：底线（B1–B5、T1/T2）和放行（A1–A3）的单元测试，加一个随机属性的性质测试（底线不变式 100%）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './world.js';

const MIN = 60_000;

/** 一个常见的小世界：她、主人、阿明、陌生人；主人私聊、游戏群、公开区。 */
async function base(name) {
  const W = await makeWorld({ name });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const ming = W.person('阿明', { closeness: 0.6 });
  const stranger = W.person('路人甲', { closeness: 0 });
  const dm = W.setting('和主人的私聊', 'oneOnOne');
  const mingDm = W.setting('和阿明的私聊', 'oneOnOne');
  const strangerDm = W.setting('和路人的私聊', 'oneOnOne');
  const game = W.setting('游戏群', 'group');
  const pub = W.setting('公开区', 'public');
  W.presence(dm.key, [W.me, owner]);
  W.presence(mingDm.key, [W.me, ming]);
  W.presence(strangerDm.key, [W.me, stranger]);
  return { W, owner, ming, stranger, dm, mingDm, strangerDm, game, pub };
}

test('A1(a)：主人在群里自己说的事，私聊里对主人说 → 直接放行（S4 的关口①部分）', async () => {
  const { W, owner, dm, game } = await base('s1-a1a');
  try {
    W.clock.minutes(1);
    const p = W.percept({ settingKey: game.key, actor: owner, text: '今晚又要加班', presence: [W.me, owner, W.person('群友')], completeness: 'recent-speakers' });
    W.clock.minutes(2);
    const r = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(dm.key));
    assert.equal(r.decision, 'pass');
    assert.equal(r.rule, 'A1a');
  } finally { await W.cleanup(); }
});

test('unassessed：原话离开 visible_to 只能进第二段；只有说的人自己是触发者、或听的人只有管理者时不封顶，别人问起照旧最多说个大概（D99）', async () => {
  const { W, owner, ming, dm, game } = await base('s1-unassessed');
  try {
    const p = W.percept({ settingKey: game.key, actor: owner, text: '今晚加班' });
    const other = W.setting('另一个群', 'group');
    const yi = W.person('群友乙');
    W.percept({ settingKey: other.key, actor: yi, text: '你主人干嘛呢' });
    W.percept({ settingKey: other.key, actor: owner, text: '大家好' });
    // 别人问起（触发者不是说的人）：代码的封顶照旧，不管第二段自己报多不敏感
    const r0 = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(other.key, { trigger: yi }));
    assert.equal(r0.decision, 'cap');
    assert.equal(r0.cap, 'share_vague');
    assert.equal(r0.rule, 'unassessed');
    assert.ok(r0.notes.includes('unassessed'), '第二段照样替提炼报分寸（只用来收紧）');
    // 没有触发者（她自己想起来的）：同样封顶
    assert.equal(W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(other.key)).cap, 'share_vague');
    // 说的人自己在这里开启了这一轮：不封顶，由第二段连同分寸一起判
    const r = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(other.key, { trigger: owner }));
    assert.equal(r.decision, 'stage2', '不经 A1、不直接放行');
    assert.equal(r.cap, undefined, '他自己带过来的：没有一刀切的封顶');
    assert.equal(r.rule, 'unassessed');
    assert.ok(r.notes.includes('unassessed'), '第二段据此要它替提炼报分寸');
    // 别人在群里说的、主人私聊里问起：听的人只有管理者，不封顶
    const q = W.percept({ settingKey: game.key, actor: ming, text: '我明天请假' });
    const rm = W.D.stage1(W.core, { kind: 'percept', id: q }, W.target(dm.key, { trigger: owner }));
    assert.notEqual(rm.decision, 'block');
    assert.equal(rm.cap, undefined, '听的人只有管理者：没有泄露面，由第二段判');
    // 她私下读到的（只有她看得到）：说的人就是触发者也照旧封顶
    const ro = W.percept({ settingKey: game.key, actor: owner, text: '后台的一段记录', visibleTo: 'her-only' });
    const rr = W.D.stage1(W.core, { kind: 'percept', id: ro }, W.target(other.key, { trigger: owner }));
    assert.notEqual(rr.decision, 'block');
    assert.equal(rr.cap, 'share_vague', '她自己私下读到的：最多说个大概');
    // 公开场合的底线照旧（B2：来源更窄 → 最多不点名的说个大概）
    const pub = W.setting('公开区', 'public');
    W.percept({ settingKey: pub.key, actor: W.person('路人'), text: '路过' });
    const rp = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(pub.key, { trigger: owner }));
    assert.equal(rp.cap, 'share_vague');
  } finally { await W.cleanup(); }
});

test('A1(b)：同一个群当众说过的事，换了一批人说话也能再提；可见范围变大就不行', async () => {
  const { W, ming, game } = await base('s1-a1b');
  try {
    const early = W.person('老成员');
    W.percept({ settingKey: game.key, actor: early, text: '大家好', at: W.now() - 60 * MIN });
    const p = W.percept({ settingKey: game.key, actor: ming, text: '周末去爬山', presence: [W.me, ming, early], completeness: 'recent-speakers' });
    W.D.writeNorm(W.core, { kind: 'percept', id: p }, { restriction: 'none', sensitivity: 0.1, involvesOthers: true });
    W.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", p);
    W.clock.minutes(40);
    W.percept({ settingKey: game.key, actor: early, text: '爬山的事怎么样了' });
    let r = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(game.key));
    assert.equal(r.rule, 'A1b');
    assert.equal(r.decision, 'pass');
    // 群变成任何人可见：可见范围变大了，不再按场合级的知道放行
    W.snapshot(game.key, { ...game.descriptor, disclosure: { ...game.descriptor.disclosure, visibleTo: 'anyone', persistence: 'public-permanent' },
      audience: { ...game.descriptor.audience, unknownObservers: true } });
    r = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(game.key));
    assert.notEqual(r.decision, 'pass');
  } finally { await W.cleanup(); }
});

test('A1(b) 晚到的成员：有入群证据、内容敏感时单独交给第二段；之后才开口的老成员照常覆盖', async () => {
  const { W, ming, game } = await base('s1-late');
  try {
    const p = W.percept({ settingKey: game.key, actor: ming, text: '我最近身体不太好', presence: [W.me, ming], completeness: 'recent-speakers' });
    W.D.writeNorm(W.core, { kind: 'percept', id: p }, { sensitivity: 0.6, involvesOthers: true });
    W.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", p);
    W.clock.minutes(5);
    // 只是之后才第一次开口的人：多半一直在群里没说话，仍按场合级的知道覆盖
    const quiet = W.person('潜水的');
    W.percept({ settingKey: game.key, actor: quiet, text: '冒个泡' });
    let r = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(game.key));
    assert.equal(r.rule, 'A1b');
    // 有入群证据的新成员：内容敏感，单独交给第二段
    const newbie = W.person('新来的');
    W.percept({ settingKey: game.key, actor: newbie, kind: 'presence', text: '' });
    W.percept({ settingKey: game.key, actor: newbie, text: '大家好我刚进群' });
    r = W.D.stage1(W.core, { kind: 'percept', id: p }, W.target(game.key));
    assert.equal(r.rule, 'late-member');
    assert.equal(r.decision, 'stage2');
  } finally { await W.cleanup(); }
});

test('A2：只涉及她自己的、不敏感的直接放行；心里想的关于别人的永远不经 A1（S26）', async () => {
  const { W, ming, game } = await base('s1-a2');
  try {
    const own = W.percept({ settingKey: game.key, actor: W.me, kind: 'self-thought', visibleTo: 'her-only', text: '我昨天看了个猫视频' });
    W.D.writeNorm(W.core, { kind: 'percept', id: own }, { involvesOthers: false, sensitivity: 0.1 });
    W.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", own);
    let r = W.D.stage1(W.core, { kind: 'percept', id: own }, W.target(game.key));
    assert.equal(r.rule, 'A2');
    // 心里想的、关于阿明的：回到同一个群也不经 A1
    const thought = W.percept({ settingKey: game.key, actor: W.me, kind: 'self-thought', visibleTo: 'her-only', text: '阿明今天好像心情不好', presence: [W.me, ming] });
    W.D.writeNorm(W.core, { kind: 'percept', id: thought }, { involvesOthers: true, sensitivity: 0.3 });
    W.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", thought);
    r = W.D.stage1(W.core, { kind: 'percept', id: thought }, W.target(game.key));
    assert.notEqual(r.decision, 'pass');
    assert.equal(r.rule, 'self-only');
    assert.ok(r.notes.includes('own-guess'));
  } finally { await W.cleanup(); }
});

test('A3：公开来源、本人说自己的事、不敏感 → 放行；陌生人在公开场合贴的别人的事 → 不走 A3', async () => {
  const { W, ming, stranger, pub, game } = await base('s1-a3');
  try {
    const self = W.assertion({ text: '阿明说他在玩新游戏', subjects: [ming], sources: [{ speaker: ming, perceivedIn: pub.key }] });
    W.D.writeNorm(W.core, self, { originExposure: { exposureRank: 3, persistenceRank: 2, settingKey: pub.key }, sensitivity: 0.1, involvesOthers: true });
    const r1 = W.D.stage1(W.core, self, W.target(game.key));
    assert.equal(r1.rule, 'A3');
    const gossip = W.assertion({ text: '有人说阿明欠钱', subjects: [ming], certainty: 'hearsay', sources: [{ speaker: stranger, perceivedIn: pub.key, hop: 1 }] });
    W.D.writeNorm(W.core, gossip, { originExposure: { exposureRank: 3, persistenceRank: 2, settingKey: pub.key }, sensitivity: 0.1, involvesOthers: true });
    const r2 = W.D.stage1(W.core, gossip, W.target(game.key));
    assert.notEqual(r2.decision, 'pass');
  } finally { await W.cleanup(); }
});

test('B1 strict：「这事别告诉别人」→ 任何新知情者都不提，也不进第二段（S10 的第一段）', async () => {
  const { W, ming, mingDm, game } = await base('s1-b1-strict');
  try {
    const p = W.percept({ settingKey: mingDm.key, actor: ming, text: '我要换工作了，这事别告诉别人', visibleTo: 'participants', presenceSetId: null });
    const a = W.assertion({ text: '阿明要换工作', subjects: [ming], sources: [{ percept: p, speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, a, { restriction: 'strict', allow: [], restrictionQuote: '这事别告诉别人', sensitivity: 0.5, involvesOthers: true });
    W.D.recordKnowledge(W.core, a, [{ whoKind: 'entity', whoRef: String(ming), since: W.now(), basis: 'subject' }]);
    const r = W.D.stage1(W.core, a, W.target(game.key));
    assert.equal(r.decision, 'block');
    assert.equal(r.rule, 'B1');
    // 再对阿明本人说：N 为空，不违反
    const back = W.D.stage1(W.core, a, W.target(mingDm.key));
    assert.equal(back.decision, 'pass');
  } finally { await W.cleanup(); }
});

test('B1 deny：「别告诉阿明」→ 有阿明在的群不提；和阿明的好朋友一对一进第二段并且不能暗示（S10b）', async () => {
  const { W, ming, game } = await base('s1-b1-deny');
  try {
    const friend = W.person('小红', { closeness: 0.5 });
    const best = W.person('阿明的好朋友', { closeness: 0.5 });
    W.descriptor(best, ming, '好朋友');
    const fdm = W.setting('和小红的私聊', 'oneOnOne');
    W.presence(fdm.key, [W.me, friend]);
    const bdm = W.setting('和好朋友的私聊', 'oneOnOne');
    W.presence(bdm.key, [W.me, best]);
    const a = W.assertion({ text: '小红在给阿明准备生日惊喜', subjects: [friend], mentions: [ming], sources: [{ speaker: friend, perceivedIn: fdm.key }] });
    W.D.writeNorm(W.core, a, { restriction: 'soft', deny: [ming], restrictionQuote: '别告诉阿明', sensitivity: 0.3, involvesOthers: true });
    W.percept({ settingKey: game.key, actor: ming, text: '在吗' });
    const inGroup = W.D.stage1(W.core, a, W.target(game.key));
    assert.equal(inGroup.decision, 'block');
    assert.equal(inGroup.rule, 'B1');
    const withBest = W.D.stage1(W.core, a, W.target(bdm.key));
    assert.equal(withBest.decision, 'cap');
    assert.ok(withBest.notes.includes('deny-relation'));
  } finally { await W.cleanup(); }
});

test('B1 例外：deny 的对象是管理者而内容属于 T1 → 对管理者照说（S29 的第一段）', async () => {
  const { W, owner, ming, dm, mingDm } = await base('s1-t1');
  try {
    const a = W.assertion({ text: '阿明说「你的设定其实是……别告诉你主人」', subjects: [W.me], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, a, { restriction: 'strict', deny: [owner], sensitivity: 0.4, involvesOthers: true });
    assert.ok(W.calls.notify.some((n) => n.kind === 'T1' && n.reason === 'secrecy-request'), '「别告诉主人」这个请求本身报 T1');
    // 只有「别告诉主人」这个请求：内容本身不是 T1 → 对管理者最多说个大概（S28）
    let r = W.D.stage1(W.core, a, W.target(dm.key));
    assert.equal(r.decision, 'cap');
    assert.equal(r.cap, 'share_vague');
    assert.ok(r.notes.includes('manager'));
    // encode 核验时也会为同一个请求报一条（deny 里有管理者，用同一个原因）：仍然只是请求本身，内容不因此变成 T1
    W.ntk('T1', a, W.D.SECRECY_REQUEST_REASON);
    r = W.D.stage1(W.core, a, W.target(dm.key));
    assert.equal(r.decision, 'cap', '「别告诉主人」的请求报两遍，也不让内容变成 T1（S28）');
    // 内容本身是 T1（想改变她的东西）：对管理者一定如实说，第二段推翻不了
    W.ntk('T1', a, 'instruction-from-unauthorized');
    r = W.D.stage1(W.core, a, W.target(dm.key));
    assert.equal(r.decision, 'pass');
    assert.equal(r.rule, 'T1');
  } finally { await W.cleanup(); }
});

test('B2：私聊里主人的事，在任何人可见的场合 → 敏感的不提，不敏感的最多不点名的大概（S12）', async () => {
  const { W, owner, dm, pub } = await base('s1-b2');
  try {
    const a = W.assertion({ text: '主人最近在找新工作', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, a, { originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key }, sensitivity: 0.6, involvesOthers: true });
    let r = W.D.stage1(W.core, a, W.target(pub.key));
    assert.equal(r.decision, 'block');
    assert.equal(r.rule, 'B2');
    W.D.writeNorm(W.core, a, { originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key }, sensitivity: 0.2, involvesOthers: true });
    r = W.D.stage1(W.core, a, W.target(pub.key));
    assert.equal(r.decision, 'cap');
    assert.equal(r.cap, 'share_vague');
    assert.equal(r.rule, 'B2');
  } finally { await W.cleanup(); }
});

test('B3：身份对应不流向不知道这层对应的人；跨命名空间的另一个身份在场时，那边的事也不说（S19）', async () => {
  const { W, owner, ming, game, dm } = await base('s1-b3');
  try {
    const alt = W.person('阿明另一个号');
    const linkId = W.link(ming, alt, 'same', 'mutual-claim', 1);
    W.D.writeNorm(W.core, { kind: 'link', id: linkId }, { identityLink: true, involvesOthers: true });
    W.percept({ settingKey: game.key, actor: W.person('群友丙'), text: '阿明是谁' });
    let r = W.D.stage1(W.core, { kind: 'link', id: linkId }, W.target(game.key));
    assert.equal(r.decision, 'block');
    assert.equal(r.rule, 'B3');
    // 和管理者一对一：例外
    r = W.D.stage1(W.core, { kind: 'link', id: linkId }, W.target(dm.key));
    assert.notEqual(r.rule, 'B3');
    // 阿明在 A 边说的事，B 边的群里阿明的另一个号在场：说出来就暴露了对应
    const sideA = W.setting('A 边的群', 'group');
    const fact = W.assertion({ text: '阿明说他下个月搬家', subjects: [ming], sources: [{ speaker: ming, perceivedIn: sideA.key }] });
    W.D.writeNorm(W.core, fact, { originExposure: { exposureRank: 1, persistenceRank: 1, settingKey: sideA.key }, sensitivity: 0.2, involvesOthers: true });
    const sideB = W.setting('B 边的群', 'group');
    W.percept({ settingKey: sideB.key, actor: alt, text: '大家好' });
    W.percept({ settingKey: sideB.key, actor: W.person('B 边的人'), text: '嗨' });
    r = W.D.stage1(W.core, fact, W.target(sideB.key));
    assert.equal(r.decision, 'block');
    assert.equal(r.rule, 'B3');
    void owner;
  } finally { await W.cleanup(); }
});

test('B3 不靠在不在场（S19）：说出这层对应的那句话（链接的证据）、含它的情节，和只来自另一侧的事，流向那一侧不知道对应的人都不提', async () => {
  const { W, ming, mingDm } = await base('s1-b3-floor');
  try {
    const side = (s, adapter) => { W.core.store.run('UPDATE settings SET adapter = ? WHERE key = ?', adapter, s.key); return s; };
    const alt = W.person('明明');
    const friendB = W.person('小周');
    side(mingDm, 'A');
    const groupA = side(W.setting('A 边的另一个群', 'group'), 'A');
    const smallB = side(W.setting('B 边的小群', 'group'), 'B');
    const bigB = side(W.setting('B 边的大群', 'group'), 'B');
    const groupC = side(W.setting('C 边的群', 'group'), 'C');
    W.percept({ settingKey: smallB.key, actor: alt, text: '大家好，我是明明' });   // 明明在 B 边露过面
    W.percept({ settingKey: bigB.key, actor: friendB, text: '晚上好' });          // B 边的大群：明明不在
    W.percept({ settingKey: groupA.key, actor: W.person('A 边的人'), text: '在吗' });
    W.percept({ settingKey: groupC.key, actor: W.person('C 边的人'), text: '在吗' });
    // 阿明在 A 边的私聊里自己说的：「我在另一个平台上叫明明」——这句话就是那条（还没确认的）跨命名空间链接的证据
    const intro = W.percept({ settingKey: mingDm.key, actor: ming, text: '对了，我在另一个平台上叫明明', visibleTo: 'participants', presence: [W.me, ming] });
    W.assess(intro, { restriction: 'none', sensitivity: 0.3 });
    const linkId = W.link(ming, alt, 'maybe_same', 'extractor', 1);
    W.core.store.run('UPDATE entity_links SET evidence_json = ? WHERE id = ?', JSON.stringify([`p${intro}`]), linkId);
    const ep = W.episode({ settingKey: mingDm.key, narrative: '阿明说他在另一个平台上叫明明', participants: [ming] });
    W.core.store.run("INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, speaker, asserter, mode, hop, confidence, at) VALUES ('episode', ?, ?, ?, ?, ?, 'told_to_her', 0, 1, ?)",
      ep.id, intro, mingDm.key, ming, ming, W.now());
    W.D.inheritNorm(W.core, ep, [{ kind: 'percept', id: intro }], { derivation: 'quote', at: W.now() });
    for (const m of [{ kind: 'percept', id: intro }, ep]) {
      const r = W.D.stage1(W.core, m, W.target(bigB.key));
      assert.deepEqual([r.decision, r.rule], ['block', 'B3'], `说出对应的那句话、含它的情节：B 边的大群（明明不在）也不提 ${JSON.stringify(r)}`);
      assert.notEqual(W.D.stage1(W.core, m, W.target(mingDm.key)).rule, 'B3', '阿明自己的私聊里：他自己说的，照常');
    }
    // 只来自 A 边的事（不涉及对应本身）：到了 B 边——是经由链接才连上的，受众不知道这层对应 → 不提
    const fact = W.assertion({ text: '阿明下个月要搬家到杭州', subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, fact, { sensitivity: 0.2 });
    let r = W.D.stage1(W.core, fact, W.target(bigB.key));
    assert.deepEqual([r.decision, r.rule], ['block', 'B3'], JSON.stringify(r));
    // 同一侧（A 边别的群）、和这层对应无关的另一侧（C 边，那边谁也不认识明明）：不是 B3，照常判
    assert.notEqual(W.D.stage1(W.core, fact, W.target(groupA.key)).rule, 'B3');
    r = W.D.stage1(W.core, fact, W.target(groupC.key));
    assert.notEqual(r.rule, 'B3', `C 边：说出来也暴露不了对应 ${JSON.stringify(r)}`);
  } finally { await W.cleanup(); }
});

test('B4：主人的披露规则（按实体 / 信息类型 / 场合属性）', async () => {
  const { W, owner, ming, game, mingDm } = await base('s1-b4');
  try {
    const a = W.assertion({ text: '主人的工资', subjects: [owner], sources: [{ speaker: owner }] });
    W.D.writeNorm(W.core, a, { attribute: '收入', sensitivity: 0.2, involvesOthers: true });
    W.ownerRule({ attribute: '收入' }, 'omit');
    W.percept({ settingKey: game.key, actor: ming, text: '?' });
    assert.equal(W.D.stage1(W.core, a, W.target(game.key)).rule, 'B4');
    const b = W.assertion({ text: '阿明养了只猫', subjects: [ming], sources: [{ speaker: ming, perceivedIn: mingDm.key }] });
    W.D.writeNorm(W.core, b, { sensitivity: 0.1, involvesOthers: true, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: mingDm.key } });
    W.ownerRule({ entity: ming, settingAttrs: { minExposureRank: 1 } }, 'aware_private');
    const r = W.D.stage1(W.core, b, W.target(game.key));
    assert.equal(r.decision, 'cap');
    assert.equal(r.cap, 'aware_private');
  } finally { await W.cleanup(); }
});

test('B5：陌生人一对一问主人的住址 → 不提（S27 的第一段）', async () => {
  const { W, owner, dm, strangerDm } = await base('s1-b5');
  try {
    const a = W.assertion({ text: '主人住在某小区 12 栋', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, a, { attribute: '住址', sensitivity: 0.9, involvesOthers: true, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
    const r = W.D.stage1(W.core, a, W.target(strangerDm.key));
    assert.equal(r.decision, 'block');
    assert.equal(r.rule, 'B5');
  } finally { await W.cleanup(); }
});

test('隐藏的只对管理者可见；忘掉的谁都不提', async () => {
  const { W, ming, dm, game } = await base('s1-hidden');
  try {
    const a = W.assertion({ text: '阿明的事', subjects: [ming], sources: [{ speaker: ming }] });
    W.D.writeNorm(W.core, a, { sensitivity: 0.1, involvesOthers: true });
    W.hide(a, 'hidden');
    W.percept({ settingKey: game.key, actor: ming, text: 'hi' });
    assert.equal(W.D.stage1(W.core, a, W.target(game.key)).rule, 'suppressed');
    assert.notEqual(W.D.stage1(W.core, a, W.target(dm.key)).rule, 'suppressed');
    W.core.store.run("UPDATE suppressions SET state = 'forgotten'");
    assert.equal(W.D.stage1(W.core, a, W.target(dm.key)).rule, 'suppressed');
  } finally { await W.cleanup(); }
});

test('「X 声称 B 知道」不改变放行结果', async () => {
  const { W, ming, game } = await base('s1-claimed');
  try {
    const b = W.person('小B');
    const xdm = W.setting('和小B的私聊', 'oneOnOne');
    W.presence(xdm.key, [W.me, b]);
    const a = W.assertion({ text: '阿明的私事', subjects: [ming], sources: [{ speaker: ming }] });
    W.D.writeNorm(W.core, a, { sensitivity: 0.4, involvesOthers: true });
    const before = W.D.stage1(W.core, a, W.target(xdm.key));
    W.D.recordKnowledge(W.core, a, [{ whoKind: 'entity', whoRef: String(b), since: W.now(), basis: 'claimed', claimant: ming }]);
    const after = W.D.stage1(W.core, a, W.target(xdm.key));
    assert.equal(after.decision, before.decision);
    assert.equal(after.rule, before.rule);
    assert.notEqual(after.decision, 'pass');
    void game;
  } finally { await W.cleanup(); }
});

test('批量提示词：全部目标的并集按最严的算', async () => {
  const { W, owner, dm, game, pub } = await base('s1-batch');
  try {
    const a = W.assertion({ text: '主人的事', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, a, { originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key }, sensitivity: 0.6, involvesOthers: true });
    const t = W.D.targetFor(W.core, { settingKey: game.key, homeSettingKey: game.key, sessionId: null, triggerEntityId: null, mode: 'involuntary',
      egress: [{ targetSettingId: game.sid, persistence: 'once' }, { targetSettingId: pub.sid, persistence: 'once' }], at: W.now() });
    assert.equal(t.batchTargets.length, 1);
    const r = W.D.stage1(W.core, a, t);
    assert.equal(r.decision, 'block');
    assert.equal(r.rule, 'B2');
  } finally { await W.cleanup(); }
});

test('场合的档案卡（§5.8）：一对一场合的卡涉及对方（A2 不放行），名字只在那个一对一里随便说；群的卡只涉及群本身。placeAllowed 据此决定来源说法里写不写别的场合的名字', async () => {
  const { W, ming, mingDm, game, dm } = await base('s1-setting-card');
  try {
    // 稳定的场合都有 kind=setting 的档案卡（intake.describe 时 entities.ensureSettingEntity 建的）
    const card = (s) => {
      const id = W.entity('setting', s.descriptor.label);
      W.core.store.run('UPDATE entities SET setting_key = ?, individual = 0 WHERE id = ?', s.key, id);
      W.core.store.run('UPDATE settings SET entity_id = ? WHERE key = ?', id, s.key);
      return { kind: 'entity', id };
    };
    const mingCard = card(mingDm);
    const gameCard = card(game);
    W.percept({ settingKey: mingDm.key, actor: ming, text: '在吗' });
    W.percept({ settingKey: game.key, actor: W.person('群友'), text: '开黑吗' });
    const other = W.setting('另一个群', 'group');
    W.percept({ settingKey: other.key, actor: W.person('群友乙'), text: '你们平时都在哪儿聊' });
    // 一对一的卡：在别的群里放不过去（她私下和谁聊，本身就是关于那个人的事）
    const inOther = W.D.stage1(W.core, mingCard, W.target(other.key));
    assert.notEqual(inOther.decision, 'pass', JSON.stringify(inOther));
    assert.equal(W.D.normOf(W.core, mingCard).involvesOthers, true);
    assert.equal(W.D.placeAllowed(W.core, mingDm.key, W.target(other.key)), false);
    // 回到那个一对一：照常
    assert.equal(W.D.placeAllowed(W.core, mingDm.key, W.target(mingDm.key)), true);
    assert.equal(W.D.stage1(W.core, mingCard, W.target(mingDm.key)).decision, 'pass');
    // 群的卡：只涉及群本身，别处说得出名字（A2）
    assert.equal(W.D.stage1(W.core, gameCard, W.target(other.key)).decision, 'pass');
    assert.equal(W.D.placeAllowed(W.core, game.key, W.target(other.key)), true);
    assert.equal(W.D.placeAllowed(W.core, game.key, W.target(dm.key)), true);
    // 不认识的场合、没有目标：不写（fail closed）
    assert.equal(W.D.placeAllowed(W.core, W.core.keys.settingKey('zz', 'nope'), W.target(other.key)), false);
    assert.equal(W.D.placeAllowed(W.core, game.key, null), false);
  } finally { await W.cleanup(); }
});
