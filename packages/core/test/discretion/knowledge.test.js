// 出现集合、谁知道、已知圈、知情圈（§5.6、§9.3.1）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './world.js';

test('recordPresence：同样的名单复用上一行；名单、完整程度、旁观者任一变了就新建', async () => {
  const W = await makeWorld({ name: 'k-presence' });
  try {
    const g = W.setting('群', 'group');
    const a = W.person('甲');
    const b = W.person('乙');
    const p1 = W.D.recordPresence(W.core, { settingKey: g.key, at: W.now(), members: [b, a, W.me, a], completeness: 'recent-speakers', unknownObservers: false });
    const p2 = W.D.recordPresence(W.core, { settingKey: g.key, at: W.now() + 1000, members: [W.me, a, b], completeness: 'recent-speakers', unknownObservers: false });
    assert.equal(p2, p1, '名单相同（去重、排序后）复用');
    const p3 = W.D.recordPresence(W.core, { settingKey: g.key, at: W.now() + 2000, members: [W.me, a, b], completeness: 'recent-speakers', unknownObservers: true });
    assert.notEqual(p3, p1);
    const p4 = W.D.recordPresence(W.core, { settingKey: g.key, at: W.now() + 3000, members: [W.me, a], completeness: 'exact', unknownObservers: false });
    assert.notEqual(p4, p3);
    const row = W.core.store.get('SELECT members_json, completeness FROM presence_sets WHERE id = ?', p4);
    assert.deepEqual(JSON.parse(row.members_json), [W.me, a].sort((x, y) => x - y));
    assert.equal(row.completeness, 'exact');
    // 不认识的完整程度按 unknown 存
    const p5 = W.D.recordPresence(W.core, { settingKey: g.key, at: W.now() + 4000, members: [], completeness: 'bogus', unknownObservers: false });
    assert.equal(W.core.store.get('SELECT completeness FROM presence_sets WHERE id = ?', p5).completeness, 'unknown');
  } finally { await W.cleanup(); }
});

test('recordKnowledge：同一条只写一次（since 只会提前）；坏条目跳过并计数', async () => {
  const W = await makeWorld({ name: 'k-record' });
  try {
    const a = W.person('甲');
    const m = W.assertion({ text: '甲的事', subjects: [a] });
    const t = W.now();
    W.D.recordKnowledge(W.core, m, [{ whoKind: 'entity', whoRef: String(a), since: t, basis: 'subject' }]);
    W.D.recordKnowledge(W.core, m, [{ whoKind: 'entity', whoRef: String(a), since: t - 5000, basis: 'subject' }]);
    W.D.recordKnowledge(W.core, m, [{ whoKind: 'entity', whoRef: String(a), since: t + 5000, basis: 'subject' }]);
    const rows = W.core.store.all('SELECT since FROM known_by WHERE owner_kind = ? AND owner_id = ?', 'assertion', m.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].since, t - 5000);
    W.D.recordKnowledge(W.core, m, [{ whoKind: 'nobody', whoRef: '1', since: t, basis: 'subject' }, { whoKind: 'entity', whoRef: '1', since: t, basis: 'gossip' }]);
    assert.equal(W.core.store.all('SELECT id FROM known_by').length, 1);
    assert.ok(W.core.store.get("SELECT value FROM metrics WHERE name = 'discretion.knowledge.badEntry'").value >= 2);
    assert.throws(() => W.D.recordKnowledge(W.core, { kind: 'nope', id: 1 }, []));
  } finally { await W.cleanup(); }
});

test('knownCircle：感知按 visible_to 推；her-only 只有她自己；「声称」和「公开可得」不进已知圈（PS-05、PS-08）', async () => {
  const W = await makeWorld({ name: 'k-circle' });
  try {
    const g = W.setting('群', 'group');
    const pub = W.setting('公开区', 'public');
    const a = W.person('甲');
    const b = W.person('乙');
    const c = W.person('丙');
    const p = W.percept({ settingKey: g.key, actor: a, text: '我周末搬家', presence: [W.me, a, b], completeness: 'recent-speakers' });
    let kc = W.D.knownCircle(W.core, { kind: 'percept', id: p }, W.now());
    assert.ok(kc.entities.has(a) && kc.entities.has(b));
    assert.deepEqual(kc.settings.map((s) => s.settingKey), [g.key]);
    assert.equal(kc.selfOnly, false);
    const thought = W.percept({ settingKey: g.key, actor: W.me, kind: 'self-thought', visibleTo: 'her-only', text: '甲好像有心事' });
    kc = W.D.knownCircle(W.core, { kind: 'percept', id: thought }, W.now());
    assert.equal(kc.selfOnly, true);
    assert.equal(kc.settings.length, 0);
    // 公开区里的内容：只记「公开可得」
    const pp = W.percept({ settingKey: pub.key, actor: c, text: '甲欠钱不还' });
    kc = W.D.knownCircle(W.core, { kind: 'percept', id: pp }, W.now());
    assert.equal(kc.publicAvailable, true);
    assert.equal(kc.settings.length, 0);
    // 声称：只进 claimed
    const m = W.assertion({ text: '甲的私事', subjects: [a] });
    W.D.recordKnowledge(W.core, m, [
      { whoKind: 'entity', whoRef: String(c), since: W.now(), basis: 'claimed', claimant: b },
      { whoKind: 'setting', whoRef: pub.key, since: W.now(), basis: 'public' },
    ]);
    kc = W.D.knownCircle(W.core, m, W.now());
    assert.equal(kc.entities.has(c), false);
    assert.deepEqual(kc.claimed, [{ claimant: b, who: c }]);
    assert.equal(kc.publicAvailable, true);
  } finally { await W.cleanup(); }
});

test('knownCircle：原文窗口按 members_json 取成员，已知圈取交集', async () => {
  const W = await makeWorld({ name: 'k-window' });
  try {
    const g = W.setting('群', 'group');
    const a = W.person('甲');
    const b = W.person('乙');
    const p1 = W.percept({ settingKey: g.key, actor: a, text: '一', presence: [W.me, a, b], completeness: 'recent-speakers' });
    const hidden = W.percept({ settingKey: g.key, actor: W.me, kind: 'self-thought', visibleTo: 'her-only', text: '心里想的' });
    const p2 = W.percept({ settingKey: g.key, actor: b, text: '二', presence: [W.me, a, b], completeness: 'recent-speakers' });
    const at = W.now();
    const wid = Number(W.core.store.run(`INSERT INTO raw_windows(setting_key, visible_to, members_json, first_percept, last_percept, n_percepts, t_start, t_end, text, created_at)
                                         VALUES (?, 'setting-audience', ?, ?, ?, 2, ?, ?, '一 二', ?)`, g.key, JSON.stringify([p1, p2]), p1, p2, at, at, at).lastInsertRowid);
    assert.ok(hidden > p1 && hidden < p2);
    const kc = W.D.knownCircle(W.core, { kind: 'window', id: wid }, at);
    assert.equal(kc.selfOnly, false, '中间那条心里想的不是窗口成员');
    assert.ok(kc.entities.has(a) && kc.entities.has(b));
    assert.deepEqual(kc.settings.map((s) => s.settingKey), [g.key]);
    // 窗口的规范：取成员里最严的；有 unassessed 就是 unassessed
    assert.equal(W.D.normOf(W.core, { kind: 'window', id: wid }).unassessed, true);
    W.assess(p1, { restriction: 'soft', sensitivity: 0.4 });
    W.assess(p2, { restriction: 'none', sensitivity: 0.1 });
    const n = W.D.normOf(W.core, { kind: 'window', id: wid });
    assert.equal(n.unassessed, false);
    assert.equal(n.restriction, 'soft');
    assert.equal(n.sensitivity, 0.4);
  } finally { await W.cleanup(); }
});

test('audienceOf：一对一能列全；群只看得到最近 30 分钟说过话的人；不认识的场合按最公开处理（fail closed）', async () => {
  const W = await makeWorld({ name: 'k-audience' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const dm = W.setting('私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    let a = W.D.audienceOf(W.core, dm.key, W.now());
    assert.equal(a.completeness, 'exact');
    assert.deepEqual(a.members, [W.me, owner].sort((x, y) => x - y));
    assert.equal(a.exposureRank, 0);
    // 没有出现集合的一对一：从唯一一个说过话的人推出来
    const dm2 = W.setting('私聊2', 'oneOnOne');
    const x = W.person('某人');
    W.percept({ settingKey: dm2.key, actor: x, text: '在吗' });
    a = W.D.audienceOf(W.core, dm2.key, W.now());
    assert.deepEqual(a.members, [W.me, x].sort((p, q) => p - q));
    const g = W.setting('群', 'group');
    const old = W.person('老');
    const fresh = W.person('新');
    W.percept({ settingKey: g.key, actor: old, text: '早', at: W.now() - 60 * 60_000 });
    W.percept({ settingKey: g.key, actor: fresh, text: '嗨' });
    a = W.D.audienceOf(W.core, g.key, W.now());
    assert.equal(a.completeness, 'recent-speakers');
    assert.equal(a.members, null);
    assert.deepEqual(a.recentSpeakers, [fresh]);
    const unknown = W.D.audienceOf(W.core, 'no-such-setting', W.now());
    assert.equal(unknown.exposureRank, 3);
    assert.equal(unknown.unknownObservers, true);
    assert.equal(unknown.preSendGate, false);
  } finally { await W.cleanup(); }
});

test('targetFor：能列成员的平台在后台向适配器要名单，结果进出现集合（下一次 audienceOf 就用得上）', async () => {
  const W = await makeWorld({ name: 'k-members' });
  try {
    const g = W.setting('小群', 'exactGroup');
    const a = W.person('甲');
    W.core.store.run("INSERT INTO identity_evidence(entity_id, namespace, scope, id_hash, strength, created_at) VALUES (?, 'ns', '', ?, 'platform', ?)",
      a, W.core.keys.identityHash('ns', undefined, 'uabc'), W.now());
    let asked = 0;
    W.adapter({ async members(sid) { asked += 1; assert.equal(sid, g.sid); return [{ self: true }, { claims: [{ kind: 'account', namespace: 'ns', id: 'uabc' }] }]; } });
    W.D.targetFor(W.core, { settingKey: g.key, homeSettingKey: g.key, sessionId: null, triggerEntityId: null, mode: 'involuntary', at: W.now(), settingId: g.sid, adapterId: 'tz' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asked, 1);
    const a1 = W.D.audienceOf(W.core, g.key, W.now());
    assert.equal(a1.completeness, 'exact');
    assert.deepEqual(a1.members, [W.me, a].sort((x, y) => x - y));
    // 刷新有间隔：马上再要不会再问一次
    W.D.targetFor(W.core, { settingKey: g.key, homeSettingKey: g.key, sessionId: null, triggerEntityId: null, mode: 'involuntary', at: W.now(), settingId: g.sid, adapterId: 'tz' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asked, 1);
  } finally { await W.cleanup(); }
});

test('her-only 的出现集合（完整名单里只有她自己）记成 private：不会让她读到它的那个场合看起来只剩她（§5.3、§9.3.1）', async () => {
  const W = await makeWorld({ name: 'k-private' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const stranger = W.person('陌生人');
    const dm = W.setting('和陌生人的私聊', 'oneOnOne');
    const t0 = W.now();
    const ps = W.presence(dm.key, [W.me, stranger], t0);
    W.clock.minutes(1);
    // 她在这个私聊里查了个东西（工具结果，her-only）：intake 给的出现集合是 [她自己]、exact
    const priv = W.presence(dm.key, [W.me]);
    assert.notEqual(priv, ps);
    assert.equal(W.core.store.get('SELECT private FROM presence_sets WHERE id = ?', priv).private, 1);
    assert.equal(W.core.store.get('SELECT private FROM presence_sets WHERE id = ?', ps).private, 0);
    W.percept({ settingKey: dm.key, kind: 'content', visibleTo: 'her-only', standing: 'material', text: '查到的天气', presenceSetId: priv });
    const a = W.D.audienceOf(W.core, dm.key, W.now());
    assert.equal(a.completeness, 'exact');
    assert.deepEqual(a.members, [W.me, stranger].sort((x, y) => x - y), '知情圈还是她和陌生人');
    // 主人的私事：对陌生人仍然不会因为「这里只剩她」被 A1 放过
    const fact = W.assertion({ text: '主人下周去医院复查', subjects: [owner], sources: [{ speaker: owner }] });
    W.D.writeNorm(W.core, fact, { sensitivity: 0.5, originExposure: { exposureRank: 0, persistenceRank: 1 } });
    W.D.recordKnowledge(W.core, fact, [{ whoKind: 'entity', whoRef: String(owner), since: t0, basis: 'subject' }]);
    const d = W.D.stage1(W.core, fact, W.target(dm.key));
    assert.notEqual(d.decision, 'pass');
    // private 的不打断复用：回到同样的名单，复用之前那一行
    W.clock.minutes(1);
    assert.equal(W.presence(dm.key, [W.me, stranger]), ps);
    // 后加入的判断、第一次出现的时间也不看 private 的集合
    const g = W.setting('小群', 'exactGroup');
    const x = W.person('甲');
    const since = W.now();
    W.presence(g.key, [W.me, x], since);
    W.clock.minutes(1);
    W.presence(g.key, [W.me]);
    const k = W.assertion({ text: '群里当众说的事', subjects: [x] });
    W.D.recordKnowledge(W.core, k, [{ whoKind: 'setting', whoRef: g.key, since, basis: 'setting' }]);
    W.D.writeNorm(W.core, k, { originExposure: { exposureRank: 1, persistenceRank: 1, settingKey: g.key } });
    assert.equal(W.D.stage1(W.core, k, W.target(g.key)).rule, 'A1b', '名单还是 [她, 甲]：同一个场合当众说的，照常放行');
  } finally { await W.cleanup(); }
});

test('knownCircle：她私下读到的、原属另一个场合的内容（替主人看了别的群）= 那个场合的受众 + 原作者，不加她读它时所在会话的人（§5.3）', async () => {
  const W = await makeWorld({ name: 'k-elsewhere' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const ming = W.person('阿明');
    const hong = W.person('小红');
    const zhang = W.person('老张');
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const g = W.setting('游戏群', 'group');
    W.percept({ settingKey: g.key, actor: hong, text: '晚上开黑', presence: [W.me, hong], completeness: 'recent-speakers' });
    const priv = W.presence(dm.key, [W.me]);
    const peek = W.percept({ settingKey: g.key, perceivedIn: dm.key, actor: ming, visibleTo: 'her-only', text: '阿明说他下个月要换工作', presenceSetId: priv });
    const kc = W.D.knownCircle(W.core, { kind: 'percept', id: peek }, W.now());
    assert.deepEqual(kc.settings.map((s) => s.settingKey), [g.key], '原来那个群的受众（场合级）');
    assert.ok(kc.entities.has(ming), '原作者');
    assert.equal(kc.entities.has(owner), false, '不加她读它时所在会话的人');
    assert.equal(kc.selfOnly, false);
    // 心里想的，哪怕记在另一个场合下，也只有她自己
    const thought = W.percept({ settingKey: g.key, perceivedIn: dm.key, actor: W.me, kind: 'self-thought', visibleTo: 'her-only', text: '阿明大概还没跟别人说' });
    assert.equal(W.D.knownCircle(W.core, { kind: 'percept', id: thought }, W.now()).selfOnly, true);
    // 在这个私聊里自己查到的（不原属别的场合）：只有她自己
    const tool = W.percept({ settingKey: dm.key, kind: 'content', visibleTo: 'her-only', standing: 'material', text: '查到的资料' });
    assert.equal(W.D.knownCircle(W.core, { kind: 'percept', id: tool }, W.now()).selfOnly, true);
    // 判定：带「千万别外传」的那句，在原来的群里没有新知情者（大家本来就看到了），拿到另一个群就是扩散 → B1；私下读到的仍然不经 A1
    W.assess(peek, { restriction: 'strict', sensitivity: 0.3 });
    const here = W.D.stage1(W.core, { kind: 'percept', id: peek }, W.target(g.key));
    assert.deepEqual([here.decision, here.rule], ['stage2', 'self-only']);
    const h = W.setting('另一个群', 'group');
    W.percept({ settingKey: h.key, actor: zhang, text: '在吗', presence: [W.me, zhang], completeness: 'recent-speakers' });
    const there = W.D.stage1(W.core, { kind: 'percept', id: peek }, W.target(h.key));
    assert.deepEqual([there.decision, there.rule], ['block', 'B1']);
  } finally { await W.cleanup(); }
});

test('谁在这个场合里：她在这里私下读到的东西（工具结果、素材）的作者不算在场；替主人看的别的群里说话的人算那个群的（§5.3、§9.3.1）', async () => {
  const W = await makeWorld({ name: 'k-in-setting' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const author = W.person('网页作者');
    const ming = W.person('阿明');
    // 和主人的私聊：主人还没开口，她先查了个东西（作者是网页作者）
    const dm = W.setting('和主人的私聊', 'oneOnOne');
    W.percept({ settingKey: dm.key, actor: author, kind: 'content', visibleTo: 'her-only', standing: 'material', text: '查到的一篇文章' });
    let a = W.D.audienceOf(W.core, dm.key, W.now());
    assert.equal(a.members, null, '一对一的对方不能拿私下读到的东西的作者来认');
    assert.equal(a.completeness, 'recent-speakers');
    assert.deepEqual(a.recentSpeakers, [], '作者不算最近在这里说过话的人');
    W.percept({ settingKey: dm.key, actor: owner, text: '在吗' });
    a = W.D.audienceOf(W.core, dm.key, W.now());
    assert.deepEqual(a.members, [W.me, owner].sort((x, y) => x - y), '主人开口以后：她和主人');
    // 群：她在群里读到一篇文章；同一时刻群里有人说过话 → 群里当众说的事，「那时在场的人」不含文章作者
    const g = W.setting('游戏群', 'group');
    const t = W.now();
    W.percept({ settingKey: g.key, actor: ming, text: '晚上开黑' });
    W.percept({ settingKey: g.key, actor: author, kind: 'content', visibleTo: 'her-only', standing: 'material', text: '群里时她查到的攻略' });
    assert.deepEqual(W.D.audienceOf(W.core, g.key, W.now()).recentSpeakers, [ming]);
    const k = W.assertion({ text: '阿明在群里说他晚上开黑', subjects: [ming], sources: [{ speaker: ming, perceivedIn: g.key }] });
    W.D.writeNorm(W.core, k, { sensitivity: 0.2, originExposure: { exposureRank: 1, persistenceRank: 1, settingKey: g.key } });
    W.D.recordKnowledge(W.core, k, [{ whoKind: 'setting', whoRef: g.key, since: t, basis: 'setting' }]);
    // 和作者的私聊：作者不是「本来就知道」的人 → 新知情者不为空，不经 A1
    const adm = W.setting('和网页作者的私聊', 'oneOnOne');
    W.presence(adm.key, [W.me, author]);
    const d = W.D.stage1(W.core, k, W.target(adm.key));
    assert.notEqual(d.rule, 'A1a', '作者没在群里，不算已经知道');
    assert.notEqual(d.rule, 'A1b');
    // 替主人看的别的群：那里说话的人确实在那个群里（内容原属那个群）
    const h = W.setting('别的群', 'group');
    const priv = W.presence(dm.key, [W.me]);
    W.percept({ settingKey: h.key, perceivedIn: dm.key, actor: ming, visibleTo: 'her-only', text: '那个群里的一句话', presenceSetId: priv });
    assert.deepEqual(W.D.audienceOf(W.core, h.key, W.now()).recentSpeakers, [ming]);
  } finally { await W.cleanup(); }
});
