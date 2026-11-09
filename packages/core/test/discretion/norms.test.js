// 流动规范和场合规矩（§5.6）：写入时给出、只能收紧、放宽只认有权限的来源、场合规矩单调。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './world.js';

const RANK = { none: 0, soft: 1, strict: 2 };

test('normOf：没有行 = unassessed（按最严处理，涉及别人按「是」）；写了之后版本递增、旧值进历史', async () => {
  const W = await makeWorld({ name: 'n-basic' });
  try {
    const a = W.person('甲');
    const dm = W.setting('私聊', 'oneOnOne');
    const p = W.percept({ settingKey: dm.key, actor: a, text: '我失恋了', visibleTo: 'participants' });
    let n = W.D.normOf(W.core, { kind: 'percept', id: p });
    assert.equal(n.unassessed, true);
    assert.equal(n.involvesOthers, true);
    assert.equal(n.originExposure.exposureRank, 0);
    const m = W.assertion({ text: '甲失恋了', subjects: [a], sources: [{ percept: p, speaker: a, perceivedIn: dm.key }] });
    assert.equal(W.D.normOf(W.core, m).unassessed, true);
    const v1 = W.D.writeNorm(W.core, m, { restriction: 'soft', sensitivity: 0.6, attribute: '感情', summary: '甲私下说的' });
    const v2 = W.D.writeNorm(W.core, m, { restriction: 'strict', sensitivity: 0.7 });
    assert.equal(v1, 1);
    assert.equal(v2, 2);
    assert.equal(W.D.normOf(W.core, m).unassessed, true, '写了行，但来源感知还没提炼：仍按 unassessed（证据里最严的）');
    W.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", p);
    n = W.D.normOf(W.core, m);
    assert.equal(n.unassessed, false);
    assert.equal(n.version, 2);
    assert.equal(n.restriction, 'strict');
    assert.equal(n.originExposure.settingKey, dm.key, '没给来源场合时从来源推');
    const hist = JSON.parse(W.core.store.get('SELECT history_json FROM flow_norms WHERE owner_kind = ? AND owner_id = ?', 'assertion', m.id).history_json);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].prev.restriction, 'soft');
  } finally { await W.cleanup(); }
});

test('writeNorm：「涉及别人」由代码从实体算，调用方给 false 也改不掉（评审:PS-19）；规范变了评估缓存失效', async () => {
  const W = await makeWorld({ name: 'n-involves' });
  try {
    const a = W.person('甲');
    const m = W.assertion({ text: '甲在找工作', subjects: [a] });
    W.D.writeNorm(W.core, m, { involvesOthers: false, sensitivity: 0.1 });
    assert.equal(W.D.normOf(W.core, m).involvesOthers, true);
    const mine = W.assertion({ text: '我昨天看了个猫视频', subjects: [W.me] });
    W.D.writeNorm(W.core, mine, { involvesOthers: false });
    assert.equal(W.D.normOf(W.core, mine).involvesOthers, false);
    // 缓存失效
    const at = W.now();
    W.core.store.run(`INSERT INTO appraisals(stage, memory_kind, memory_id, verdict, cache_key, at, expires_at) VALUES (2, 'assertion', ?, 'share', 'k', ?, ?)`, m.id, at, at + 3_600_000);
    W.clock.minutes(1);
    W.D.writeNorm(W.core, m, { sensitivity: 0.5 });
    assert.ok(W.core.store.get("SELECT expires_at FROM appraisals WHERE cache_key = 'k'").expires_at <= W.now());
  } finally { await W.cleanup(); }
});

test('「别告诉你主人」这类请求本身报 T1（§9.3.7），只报一次；内容本身不因此变成 T1', async () => {
  const W = await makeWorld({ name: 'n-secrecy' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const a = W.person('甲');
    const m = W.assertion({ text: '甲失恋了', subjects: [a], sources: [{ speaker: a }] });
    W.D.writeNorm(W.core, m, { restriction: 'strict', deny: [owner], restrictionQuote: '别告诉你主人' });
    W.D.writeNorm(W.core, m, { restriction: 'strict', deny: [owner] });
    const t1 = W.calls.notify.filter((n) => n.kind === 'T1');
    assert.equal(t1.length, 1);
    assert.equal(t1[0].reason, 'secrecy-request');
    assert.equal(t1[0].sourceEntityId, a, '请求来自谁');
    // 别的 deny（不是管理者）不报
    W.D.writeNorm(W.core, W.assertion({ text: 'x', subjects: [a] }), { deny: [W.person('乙')] });
    assert.equal(W.calls.notify.filter((n) => n.kind === 'T1').length, 1);
  } finally { await W.cleanup(); }
});

test('tightenNorm：撤回 → 至少 soft；收紧是粘的，之后整体重写也冲不掉；还没提炼的感知收紧后仍是 unassessed', async () => {
  const W = await makeWorld({ name: 'n-tighten' });
  try {
    const a = W.person('甲');
    const g = W.setting('群', 'group');
    const m = W.assertion({ text: '甲说的事', subjects: [a] });
    W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.2 });
    W.D.tightenNorm(W.core, m, { restriction: 'soft', reason: 'retracted', at: W.now() });
    assert.equal(W.D.normOf(W.core, m).restriction, 'soft');
    W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.1 });
    const n = W.D.normOf(W.core, m);
    assert.equal(n.restriction, 'soft', '收紧过的底线保留');
    // 收紧不会放宽：给 none 什么都不变
    W.D.tightenNorm(W.core, m, { restriction: 'none', sensitivity: 0, reason: 'x', at: W.now() });
    assert.equal(W.D.normOf(W.core, m).restriction, 'soft');
    const p = W.percept({ settingKey: g.key, actor: a, text: '刚才那句撤回了' });
    W.D.tightenNorm(W.core, { kind: 'percept', id: p }, { restriction: 'soft', reason: 'retracted', at: W.now() });
    const pn = W.D.normOf(W.core, { kind: 'percept', id: p });
    assert.equal(pn.unassessed, true);
    assert.equal(pn.restriction, 'soft');
    // 提炼之后写的规范仍然至少 soft
    W.assess(p, { restriction: 'none' });
    assert.equal(W.D.normOf(W.core, { kind: 'percept', id: p }).restriction, 'soft');
  } finally { await W.cleanup(); }
});

test('normOf：引用的场合规矩更严时按更严的算，规矩当场生效（评审:UV-09、S11b 的机制）', async () => {
  const W = await makeWorld({ name: 'n-rule' });
  try {
    const work = W.setting('工作群', 'group');
    const a = W.person('同事');
    const p = W.percept({ settingKey: work.key, actor: a, text: '下季度要裁员' });
    const m = W.assertion({ text: '公司下季度要裁员', subjects: [a], sources: [{ percept: p, speaker: a, perceivedIn: work.key }] });
    W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.4 });
    assert.equal(W.D.normOf(W.core, m).restriction, 'none');
    const r = W.D.writeSettingRule(W.core, work.key, { text: '这是工作群，内部别外传', restriction: 'strict' },
      { source: 'learned', authorEntityId: a, authority: 'none', at: W.now() });
    assert.equal(r.status, 'active', '收紧不需要权限');
    const n = W.D.normOf(W.core, m);
    assert.equal(n.restriction, 'strict');
    assert.equal(n.ruleVersion, r.version);
    assert.equal(n.settingRules.at(-1).text, '这是工作群，内部别外传');
    // 还没提炼的原话也跟着场合规矩变严
    assert.equal(W.D.normOf(W.core, { kind: 'percept', id: p }).restriction, 'strict');
  } finally { await W.cleanup(); }
});

test('withdrawSettingRules：公告撤下了 → 之后才知道的不再受它约束；撤下之前知道的照旧（不会变松）；主人写的、她学到的不撤；又贴回来是新的一版', async () => {
  const W = await makeWorld({ name: 'n-withdraw' });
  try {
    const H = 3_600_000;
    const work = W.setting('工作群', 'group');
    const a = W.person('同事');
    const fact = (text) => {
      const p = W.percept({ settingKey: work.key, actor: a, text });
      const m = W.assertion({ text, subjects: [a], sources: [{ percept: p, speaker: a, perceivedIn: work.key }] });
      W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.4 });
      return m;
    };
    const before = fact('上个月团建去了海边');
    W.clock.advance(H);
    const note = '这是工作群，内部别外传';
    const r = W.D.writeSettingRule(W.core, work.key, { text: note, restriction: 'strict' }, { source: 'adapter-notes', authorEntityId: a, authority: 'none', at: W.now() });
    assert.equal(r.status, 'active');
    W.clock.advance(H);
    const during = fact('下季度要裁员');
    assert.equal(W.D.normOf(W.core, during).restriction, 'strict');
    W.clock.advance(H);
    // 公告撤下了：只撤公告来的那一条
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'adapter-notes', texts: [note] }, { at: W.now() }), 1);
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'adapter-notes', texts: [note] }, { at: W.now() }), 0, '撤过的不再撤');
    W.clock.advance(H);
    const after = fact('周五下午茶有蛋糕');
    assert.equal(W.D.normOf(W.core, after).restriction, 'none', '撤下之后才知道的：不受它约束');
    assert.equal(W.D.normOf(W.core, during).restriction, 'strict', '在这条规矩下听到的：照旧');
    assert.equal(W.D.normOf(W.core, before).restriction, 'strict', '撤下之前就知道的：已经按它收紧过，不会变松');
    assert.ok(!W.D.settingRules(W.core, work.key).rules.some((x) => x.text === note), '当前生效的规矩里没有它了');
    // 主人写的公告、她自己学到的同一句：都不撤
    const owner = W.D.writeSettingRule(W.core, work.key, { text: '周报别外传', restriction: 'strict' }, { source: 'adapter-notes', authorEntityId: null, authority: 'principal', at: W.now() });
    const learned = W.D.writeSettingRule(W.core, work.key, { text: note, restriction: 'strict' }, { source: 'learned', authorEntityId: a, authority: 'none', at: W.now() });
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'adapter-notes', texts: ['周报别外传', note] }, { at: W.now() }), 0);
    const texts = W.D.settingRules(W.core, work.key).rules.map((x) => x.text);
    assert.ok(texts.includes('周报别外传') && texts.includes(note), JSON.stringify(texts));
    assert.ok(owner.status === 'active' && learned.status === 'active');
    // 别的来源不归它撤
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'learned', texts: [note] }), 0);
    // 同一条公告又贴回来：新的一版，重新生效
    const again = W.D.writeSettingRule(W.core, work.key, { text: note, restriction: 'strict' }, { source: 'adapter-notes', authorEntityId: a, authority: 'none', at: W.now() });
    assert.ok(again.version > r.version && again.status === 'active');
    // 按完整清单问（keep，intake 用的）：清单里还有的留着，没有的公告规矩撤下；主人写的、她学到的照旧不动
    const ads = W.D.writeSettingRule(W.core, work.key, { text: '禁止广告', restriction: 'strict' }, { source: 'adapter-notes', authorEntityId: a, authority: 'none', at: W.now() });
    assert.equal(ads.status, 'active');
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'adapter-notes', keep: ['禁止广告'] }, { at: W.now() }), 1, '只撤清单里没有的那条（又贴回来的那版）');
    let now = W.D.settingRules(W.core, work.key).rules.map((x) => `${x.text}|${x.authority}`);
    assert.ok(now.includes('禁止广告|none') && now.includes('周报别外传|principal') && now.includes(`${note}|none`), JSON.stringify(now));
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'adapter-notes', keep: [] }, { at: W.now() }), 1, '清单空了：剩下那条公告也撤');
    now = W.D.settingRules(W.core, work.key).rules.map((x) => x.text);
    assert.ok(!now.includes('禁止广告') && now.includes('周报别外传'), JSON.stringify(now));
    assert.equal(W.D.withdrawSettingRules(W.core, work.key, { source: 'adapter-notes', texts: [] }), 0, '没说撤什么：不撤');
  } finally { await W.cleanup(); }
});

test('withdrawSettingRules：还在等审核的那一版（管事人放宽）撤下 = 作废，主人之后再批也不生效', async () => {
  const W = await makeWorld({ name: 'n-withdraw-pending' });
  try {
    const g = W.setting('游戏群', 'group');
    const mod = W.person('群管');
    W.D.writeSettingRule(W.core, g.key, { text: '群里的事别外传', restriction: 'strict' }, { source: 'owner', authorEntityId: null, authority: 'principal', at: W.now() });
    const relax = W.D.writeSettingRule(W.core, g.key, { text: '群里的事可以随便说', restriction: 'none' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    assert.equal(relax.status, 'pending');
    assert.equal(W.D.withdrawSettingRules(W.core, g.key, { source: 'adapter-notes', keep: [] }, { at: W.now() }), 1);
    assert.equal(W.D.decideSettingRule(W.core, g.key, relax.version, true).status, 'not-pending', '撤下的那一版不再等审核');
    assert.deepEqual(W.D.settingRules(W.core, g.key).rules.map((x) => x.restriction), ['strict'], '主人写的照旧，放宽没有生效');
  } finally { await W.cleanup(); }
});

test('writeSettingRule：没有权限只能收紧；管事人放宽进审核；主人放宽生效并取代旧规矩；只是说明的不改变结论', async () => {
  const W = await makeWorld({ name: 'n-setting-rule' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const mod = W.person('管事的');
    const rando = W.person('路人');
    const g = W.setting('群', 'group');
    const strict = W.D.writeSettingRule(W.core, g.key, { text: '群里不聊私事', restriction: 'strict' }, { source: 'learned', authorEntityId: rando, authority: 'none', at: W.now() });
    assert.equal(strict.status, 'active');
    assert.ok(W.calls.notify.some((n) => n.kind === 'foreign_write'), '准备写进她的规矩、来源不是管理者 → 让主人知道');
    const dup = W.D.writeSettingRule(W.core, g.key, { text: '群里不聊私事', restriction: 'strict' }, { source: 'learned', authorEntityId: rando, authority: 'none', at: W.now() });
    assert.equal(dup.version, strict.version, '同一条规矩不重复建版本');
    const relaxNone = W.D.writeSettingRule(W.core, g.key, { text: '这里什么都能聊', restriction: 'none' }, { source: 'learned', authorEntityId: rando, authority: 'none', at: W.now() });
    assert.equal(relaxNone.status, 'rejected');
    assert.equal(W.D.settingRules(W.core, g.key).rules.length, 1);
    const relaxMod = W.D.writeSettingRule(W.core, g.key, { text: '可以聊私事了', restriction: 'none' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    assert.equal(relaxMod.status, 'pending');
    assert.ok(W.calls.reviews.some((r) => r.kind === 'setting_rule_relax' && r.payload.version === relaxMod.version));
    assert.equal(W.D.settingRules(W.core, g.key).rules[0].restriction, 'strict', '挂起的放宽不生效');
    const info = W.D.writeSettingRule(W.core, g.key, { text: '这里什么都能聊（群公告）' }, { source: 'adapter-notes', authorEntityId: rando, authority: 'none', at: W.now() });
    assert.equal(info.status, 'active');
    const eff = W.D.settingRules(W.core, g.key);
    assert.equal(eff.rules.find((r) => r.text.startsWith('这里什么都能聊')).restriction, 'none');
    const m = W.assertion({ text: '某事', subjects: [rando], sources: [{ speaker: rando, perceivedIn: g.key }] });
    W.D.writeNorm(W.core, m, { originExposure: { exposureRank: 1, persistenceRank: 1, settingKey: g.key } });
    assert.equal(W.D.normOf(W.core, m).restriction, 'strict', '说明性的规矩不让结论变松');
    const relaxOwner = W.D.writeSettingRule(W.core, g.key, { text: '私事可以聊', restriction: 'none' }, { source: 'owner', authorEntityId: owner, authority: 'principal', at: W.now() });
    assert.equal(relaxOwner.status, 'active');
    assert.equal(W.D.normOf(W.core, m).restriction, 'none', '主人放宽：取代更严的旧规矩');
    assert.ok(W.D.settingRules(W.core, g.key).rules.every((r) => r.restriction === 'none'));
    // 场合规矩的 deny 里有管理者：请求本身报 T1
    W.D.writeSettingRule(W.core, g.key, { text: '别让主人知道', restriction: 'soft', scope: { deny: [owner] } }, { source: 'learned', authorEntityId: rando, authority: 'none', at: W.now() });
    assert.ok(W.calls.notify.some((n) => n.kind === 'T1' && n.reason === 'secrecy-request'));
    assert.throws(() => W.D.writeSettingRule(W.core, '', { text: 'x' }, { source: 'owner', authority: 'principal', at: 1 }));
  } finally { await W.cleanup(); }
});

test('性质：没有权限的来源写场合规矩，生效的限制永远不会变松（单调性，§5.6）', async () => {
  const W = await makeWorld({ name: 'n-monotone' });
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  try {
    const g = W.setting('群', 'group');
    const authors = [W.person('甲'), W.person('乙'), null];
    let floor = 0;
    for (let i = 0; i < 60; i++) {
      const restriction = ['none', 'soft', 'strict', undefined][Math.floor(rnd() * 4)];
      const authority = ['none', 'moderator'][Math.floor(rnd() * 2)];
      W.D.writeSettingRule(W.core, g.key, { text: `规矩${i % 7}`, ...(restriction ? { restriction } : {}) },
        { source: rnd() < 0.5 ? 'learned' : 'adapter-notes', authorEntityId: authors[Math.floor(rnd() * 3)], authority, at: W.now() + i });
      const eff = Math.max(0, ...W.D.settingRules(W.core, g.key).rules.map((r) => RANK[r.restriction]));
      assert.ok(eff >= floor, `第 ${i} 步变松了（seed 12345）`);
      floor = eff;
    }
  } finally { await W.cleanup(); }
});

test('applyNormUpdate：收紧直接生效；放宽只认管理者、经权利层确认的主体本人、当初提出限制的人（S16、S19b 的机制）', async () => {
  const W = await makeWorld({ name: 'n-update' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const ming = W.person('阿明', { closeness: 0.6 });
    const mingAlt = W.person('阿明的另一个号');
    W.link(ming, mingAlt, 'same', 'platform', 1);
    const cousin = W.person('阿明的表哥');
    const claimer = W.person('自称表哥的人');
    W.link(cousin, claimer, 'maybe_same', 'extractor', 0);
    const rando = W.person('路人');
    const m = W.assertion({ text: '阿明说表哥很抠', subjects: [cousin], sources: [{ speaker: ming }] });
    W.D.writeNorm(W.core, m, { restriction: 'strict', restrictedBy: ming, sensitivity: 0.5 });
    const ref = W.ref(m);
    // 没有权限：只记成听来的，不生效，进审核（同一目标只排一条）
    let r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'relax', change: { restriction: 'none' }, quote: '主人说可以告诉大家' }, { speakerEntityId: rando, at: W.now() });
    assert.deepEqual([r.applied, r.queued, r.reason], [false, true, 'unauthorized']);
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'relax', change: { restriction: 'none' }, quote: null }, { speakerEntityId: rando, at: W.now() });
    assert.equal(r.queued, false, '已经有一条在等');
    assert.equal(W.calls.reviews.filter((x) => x.kind === 'norm_change').length, 1);
    assert.equal(W.D.normOf(W.core, m).restriction, 'strict');
    const hist = JSON.parse(W.core.store.get('SELECT history_json FROM flow_norms WHERE owner_id = ?', m.id).history_json);
    assert.ok(hist.some((h) => h.kind === 'relax-claim' && h.applied === false));
    // 自称是主体的人（只有 maybe_same）：认得 ≠ 权利
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'relax', change: { restriction: 'none' }, quote: null }, { speakerEntityId: claimer, at: W.now() });
    assert.equal(r.applied, false);
    // 当初提出限制的人（经平台确认的另一个号也算他本人）
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'relax', change: { restriction: 'soft' }, quote: null }, { speakerEntityId: mingAlt, at: W.now() });
    assert.equal(r.applied, true);
    assert.equal(W.D.normOf(W.core, m).restriction, 'soft');
    // 收紧：谁都可以；收紧的人之后也能放宽自己加的
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'tighten', change: { restriction: 'strict', deny: [rando] }, quote: '别告诉路人' }, { speakerEntityId: claimer, at: W.now() });
    assert.equal(r.applied, true);
    let n = W.D.normOf(W.core, m);
    assert.equal(n.restriction, 'strict');
    assert.deepEqual(n.deny, [rando]);
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'relax', change: { deny: [] }, quote: null }, { speakerEntityId: claimer, at: W.now() });
    assert.equal(r.applied, true, '提出限制的人可以放宽');
    // 管理者
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'relax', change: { restriction: 'none' }, quote: null }, { speakerEntityId: owner, at: W.now() });
    assert.equal(r.applied, true);
    n = W.D.normOf(W.core, m);
    assert.equal(n.restriction, 'none');
    // 放宽之后再整体重写：旧的收紧不再粘着
    W.D.writeNorm(W.core, m, { restriction: 'none' });
    assert.equal(W.D.normOf(W.core, m).restriction, 'none');
    // 主体本人（经平台确认）可以放宽关于自己的
    const own = W.assertion({ text: '阿明在找工作', subjects: [ming], sources: [{ speaker: owner }] });
    W.D.writeNorm(W.core, own, { restriction: 'soft', restrictedBy: owner });
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref: W.ref(own) }, direction: 'relax', change: { restriction: 'none' }, quote: null }, { speakerEntityId: mingAlt, at: W.now() });
    assert.equal(r.applied, true);
    // 坏请求
    assert.equal(W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref: 'zz' }, direction: 'relax', change: {} }, { speakerEntityId: owner, at: 1 }).reason, 'bad-target');
    assert.equal(W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref }, direction: 'sideways', change: {} }, { speakerEntityId: owner, at: 1 }).reason, 'bad-direction');
  } finally { await W.cleanup(); }
});

test('applyNormUpdate：以场合为目标的变化走场合规矩（当场生效）；没权限的放宽不生效', async () => {
  const W = await makeWorld({ name: 'n-update-setting' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const a = W.person('同事');
    const work = W.setting('工作群', 'group');
    let r = W.D.applyNormUpdate(W.core, { target: { kind: 'setting', settingKey: work.key }, direction: 'tighten', change: { restriction: 'strict' }, quote: '内部别外传' },
      { speakerEntityId: a, at: W.now() });
    assert.deepEqual([r.applied, r.queued], [true, false]);
    assert.equal(W.D.settingRules(W.core, work.key).rules[0].restriction, 'strict');
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'setting', settingKey: work.key }, direction: 'relax', change: { restriction: 'none' }, quote: '随便说' },
      { speakerEntityId: a, at: W.now() });
    assert.equal(r.applied, false);
    r = W.D.applyNormUpdate(W.core, { target: { kind: 'setting', settingKey: work.key }, direction: 'relax', change: { restriction: 'none' }, quote: '可以说' },
      { speakerEntityId: owner, at: W.now() });
    assert.equal(r.applied, true);
  } finally { await W.cleanup(); }
});

test('inheritNorm：继承证据里最严的；复述原话的「谁知道」取交集；推断类只有她自己；证据没评估过至少 soft', async () => {
  const W = await makeWorld({ name: 'n-inherit' });
  try {
    const a = W.person('甲');
    const b = W.person('乙');
    const g = W.setting('群', 'group');
    const dm = W.setting('私聊', 'oneOnOne');
    const p1 = W.percept({ settingKey: g.key, actor: a, text: '一', presence: [W.me, a, b], completeness: 'recent-speakers' });
    const p2 = W.percept({ settingKey: g.key, actor: b, text: '二', presence: [W.me, a, b], completeness: 'recent-speakers' });
    const e1 = W.assess(p1, { restriction: 'none', sensitivity: 0.2 });
    const e2 = W.assess(p2, { restriction: 'soft', sensitivity: 0.5, deny: [W.person('丙')] });
    const imp = Number(W.core.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, version, built_at) VALUES (?, 'shared', '甲和乙常聊天', 1, ?)`, a, W.now()).lastInsertRowid);
    W.D.inheritNorm(W.core, { kind: 'impression', id: imp }, [e1, e2], { derivation: 'quote', at: W.now() });
    let n = W.D.normOf(W.core, { kind: 'impression', id: imp });
    assert.equal(n.restriction, 'soft');
    assert.equal(n.sensitivity, 0.5);
    assert.equal(n.deny.length, 1);
    let kc = W.D.knownCircle(W.core, { kind: 'impression', id: imp }, W.now());
    assert.ok(kc.entities.has(a) && kc.entities.has(b));
    assert.deepEqual(kc.settings.map((s) => s.settingKey), [g.key]);
    // 推断类：只有她自己，卡片会写「这是你自己的猜测」
    const guess = Number(W.core.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, derivation, version, built_at) VALUES (?, 'private', '甲好像喜欢乙', 'inference', 1, ?)`, a, W.now()).lastInsertRowid);
    W.D.inheritNorm(W.core, { kind: 'impression', id: guess }, [e1, e2], { derivation: 'inference', at: W.now() });
    kc = W.D.knownCircle(W.core, { kind: 'impression', id: guess }, W.now());
    assert.equal(kc.selfOnly, true);
    n = W.D.normOf(W.core, { kind: 'impression', id: guess });
    assert.equal(n.derivation, 'inference');
    // 证据没评估过：至少 soft
    const raw = W.percept({ settingKey: dm.key, actor: a, text: '私聊里说的', visibleTo: 'participants' });
    const s = Number(W.core.store.run(`INSERT INTO storylines(setting_key, text, updated_at) VALUES (?, '最近在聊', ?)`, dm.key, W.now()).lastInsertRowid);
    W.D.inheritNorm(W.core, { kind: 'storyline', id: s }, [{ kind: 'percept', id: raw }], { derivation: 'quote', at: W.now() });
    n = W.D.normOf(W.core, { kind: 'storyline', id: s });
    assert.ok(RANK[n.restriction] >= 1);
    assert.equal(n.originExposure.exposureRank, 0);
  } finally { await W.cleanup(); }
});

test('派生内容的证据还没提炼（今天到目前为止的小结）：存下的行不让它看着像评估过——按 unassessed，离开原场合最多说个大概；证据评估完重算后恢复（§5.6、S18/S10）', async () => {
  const W = await makeWorld({ name: 'n-derived-unassessed' });
  try {
    const a = W.person('甲');
    const dm = W.setting('私聊', 'oneOnOne');
    const g = W.setting('群', 'group');
    const p1 = W.percept({ settingKey: dm.key, actor: a, text: '我下个月要辞职，别告诉别人', visibleTo: 'participants', presence: [W.me, a] });
    const p2 = W.percept({ settingKey: dm.key, actor: W.me, text: '好，我不说', visibleTo: 'participants', presence: [W.me, a] });
    const sum = W.episode({ settingKey: dm.key, narrative: '甲私下跟我说他下个月要辞职，我答应不说', participants: [a, W.me] });
    for (const p of [p1, p2]) {
      W.core.store.run("INSERT INTO sources(owner_kind, owner_id, percept_id, perceived_in, speaker, asserter, mode, hop, confidence, at) VALUES ('episode', ?, ?, ?, ?, ?, 'told_to_her', 0, 1, ?)",
        sum.id, p, dm.key, p === p2 ? W.me : a, p === p2 ? W.me : a, W.now());
    }
    W.D.inheritNorm(W.core, sum, [{ kind: 'percept', id: p1 }, { kind: 'percept', id: p2 }], { derivation: 'quote', at: W.now() });
    assert.ok(W.core.store.get("SELECT 1 AS x FROM flow_norms WHERE owner_kind = 'episode' AND owner_id = ?", sum.id), '小结写了一行继承来的规范');
    let n = W.D.normOf(W.core, sum);
    assert.equal(n.unassessed, true, '证据还没提炼：派生的小结也是 unassessed');
    assert.ok(RANK[n.restriction] >= 1, '继承下来的收紧照样留着');
    // 别的群（不在 visible_to 里）：第一段封顶到「说个大概」，不会因为第二段说 share 就整段说出去
    const s1 = W.D.stage1(W.core, sum, W.target(g.key, { mode: 'deliberate' }));
    assert.notEqual(s1.decision, 'pass');
    assert.equal(s1.cap, 'share_vague', `离开原场合最多说个大概：${JSON.stringify(s1)}`);
    // 提炼之后证据评估完：重新继承，派生的规范按存下来的行算
    W.assess(p1, { restriction: 'strict', sensitivity: 0.7, restrictionQuote: '别告诉别人' });
    W.assess(p2, { restriction: 'none' });
    W.D.inheritNorm(W.core, sum, [{ kind: 'percept', id: p1 }, { kind: 'percept', id: p2 }], { derivation: 'quote', at: W.now() });
    n = W.D.normOf(W.core, sum);
    assert.equal(n.unassessed, false, '证据评估完：不再是 unassessed');
    assert.equal(n.restriction, 'strict');
    assert.equal(W.D.stage1(W.core, sum, W.target(g.key, { mode: 'deliberate' })).decision, 'block', '评估之后按明确限制拦下（B1）');
  } finally { await W.cleanup(); }
});

test('setting_rule_relax 的决定（decideSettingRule）：批准 → 按原作者写一版主人认可的，那一版标成被取代；驳回 → 那一版 rejected，同一个人再提不再排队', async () => {
  const W = await makeWorld({ name: 'n-decide-rule' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const mod = W.person('管事的');
    const g = W.setting('群', 'group');
    const rule = (v) => W.core.store.get('SELECT * FROM setting_rules WHERE setting_key = ? AND version = ?', g.key, v);
    W.D.writeSettingRule(W.core, g.key, { text: '群里不聊私事', restriction: 'strict' }, { source: 'learned', authorEntityId: mod, authority: 'moderator', at: W.now() });
    const m = W.assertion({ text: '某事', subjects: [mod], sources: [{ speaker: mod, perceivedIn: g.key }] });
    W.D.writeNorm(W.core, m, { originExposure: { exposureRank: 1, persistenceRank: 1, settingKey: g.key } });
    assert.equal(W.D.normOf(W.core, m).restriction, 'strict');
    // 管事人提了两条放宽：都等主人决定
    const p1 = W.D.writeSettingRule(W.core, g.key, { text: '可以聊私事了', restriction: 'none' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    const p2 = W.D.writeSettingRule(W.core, g.key, { text: '周末可以聊点私事', restriction: 'soft' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    assert.deepEqual([p1.status, p2.status], ['pending', 'pending']);
    assert.equal(W.calls.reviews.filter((r) => r.kind === 'setting_rule_relax').length, 2);
    // 驳回第二条：标 rejected、不生效；同一个人以同样的权限再提一遍，不再排队、不再新建版本
    assert.deepEqual(W.D.decideSettingRule(W.core, g.key, p2.version, false), { version: p2.version, status: 'rejected' });
    assert.equal(rule(p2.version).status, 'rejected');
    const again = W.D.writeSettingRule(W.core, g.key, { text: '周末可以聊点私事', restriction: 'soft' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    assert.deepEqual(again, { version: p2.version, status: 'rejected' });
    assert.equal(W.calls.reviews.filter((r) => r.kind === 'setting_rule_relax').length, 2);
    assert.equal(W.D.normOf(W.core, m).restriction, 'strict');
    // 批准第一条：按原作者写一版主人认可的（authority = principal），当场生效；那一版被取代
    const r = W.D.decideSettingRule(W.core, g.key, p1.version, true, { at: W.now() });
    assert.equal(r.status, 'active');
    assert.ok(r.version > p2.version);
    assert.ok(rule(p1.version).superseded_at != null, '等审核的那一版结了');
    assert.deepEqual([rule(r.version).status, rule(r.version).author_entity_id, rule(r.version).authority], ['active', mod, 'principal']);
    assert.equal(W.D.normOf(W.core, m).restriction, 'none', '主人批准的放宽取代了更严的旧规矩');
    assert.ok(W.D.settingRules(W.core, g.key).rules.some((x) => x.text === '可以聊私事了' && x.author === mod && x.authority === 'principal'));
    // 已经决定过的不再处理
    assert.deepEqual(W.D.decideSettingRule(W.core, g.key, p1.version, true), { version: p1.version, status: 'not-pending' });
    assert.equal(W.D.decideSettingRule(W.core, g.key, 999, false).status, 'not-pending');
    assert.throws(() => W.D.decideSettingRule(W.core, '', 1, true));

    // 另一条等审核的放宽：主人自己写了内容一样的规矩（admin 直接调 writeSettingRule 的老路径）→ 那一版也结了；
    // 内容不一样的照旧等主人决定，不会被顺手取代
    const g2 = W.setting('群2', 'group');
    W.D.writeSettingRule(W.core, g2.key, { text: '不聊私事', restriction: 'strict' }, { source: 'learned', authorEntityId: mod, authority: 'moderator', at: W.now() });
    const q1 = W.D.writeSettingRule(W.core, g2.key, { text: '私事可以聊', restriction: 'none' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    const q2 = W.D.writeSettingRule(W.core, g2.key, { text: '可以发链接', restriction: 'soft' }, { source: 'adapter-notes', authorEntityId: mod, authority: 'moderator', at: W.now() });
    const owned = W.D.writeSettingRule(W.core, g2.key, { text: '私事可以聊', restriction: 'none' }, { source: 'owner', authorEntityId: owner, authority: 'principal', at: W.now() });
    assert.equal(owned.status, 'active');
    const row = (v) => W.core.store.get('SELECT status, superseded_at FROM setting_rules WHERE setting_key = ? AND version = ?', g2.key, v);
    assert.ok(row(q1.version).superseded_at != null);
    assert.deepEqual([row(q2.version).status, row(q2.version).superseded_at], ['pending', null]);
    assert.equal(W.D.decideSettingRule(W.core, g2.key, q1.version, true).status, 'not-pending');
  } finally { await W.cleanup(); }
});

// ── D113：explicitLimit（只认核对过原话的叮嘱）──────────────────────────────

test('explicitLimit：第一眼核对过的原话（不是她自己的话）、规范里的原话真在来源原文里、点了名的名单、主人收紧过——四种来源；原话对不上、没有原话的 soft 返回 null；主人可以解除', async () => {
  const W = await makeWorld({ name: 'n-xlimit' });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const ming = W.person('阿明', { closeness: 0.6 });
    const dm = W.setting('私聊', 'oneOnOne');
    W.presence(dm.key, [W.me, owner]);
    const g = (id, o) => W.core.store.run(`INSERT INTO glances(percept_id, setting_key, state, sens, limit_kind, quote, quote_ok, about, asks, mixed, created_at)
                                             SELECT id, setting_key, 'done', 0.3, ?, ?, ?, 'speaker', 0, 0, ? FROM percepts WHERE id = ?`, o.limit, o.quote, o.ok ? 1 : 0, W.now(), id);
    const P = (id) => ({ kind: 'percept', id });
    // (a) 第一眼核对过的原话
    const a = W.percept({ settingKey: dm.key, actor: owner, text: '我要辞职了，别告诉别人', addressed: 'to-her' });
    g(a, { limit: 'strict', quote: '别告诉别人', ok: true });
    assert.deepEqual(W.D.explicitLimit(W.core, P(a)), { kind: 'strict', quote: '别告诉别人', by: owner, deny: [], source: 'glance' });
    // 第一眼的原话没核对上：不算
    const a2 = W.percept({ settingKey: dm.key, actor: owner, text: '我要搬家了', addressed: 'to-her' });
    g(a2, { limit: 'strict', quote: '编出来的', ok: false });
    assert.equal(W.D.explicitLimit(W.core, P(a2)), null);
    // 她自己的话：不算任何人的叮嘱
    const a3 = W.percept({ settingKey: dm.key, actor: W.me, text: '今天的事别外传喔' });
    g(a3, { limit: 'soft', quote: '别外传喔', ok: true });
    assert.equal(W.D.explicitLimit(W.core, P(a3)), null);
    // (b) 规范里的原话真在来源原文里（规范化：标点、空白不算）
    const b = W.percept({ settingKey: dm.key, actor: owner, text: '这件事 千万别外传！我下周去面试', addressed: 'to-her' });
    W.assess(b, { restriction: 'soft', sensitivity: 0.4, involvesOthers: false, restrictionQuote: '千万别外传' });
    assert.equal(W.D.explicitLimit(W.core, P(b))?.quote, '千万别外传');
    assert.equal(W.D.explicitLimit(W.core, P(b))?.source, 'quote');
    const fact = W.assertion({ text: '主人下周去面试', subjects: [owner], sources: [{ speaker: owner, percept: b, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, fact, { restriction: 'strict', sensitivity: 0.4, restrictionQuote: '千万别外传' });
    assert.equal(W.D.explicitLimit(W.core, fact)?.kind, 'strict', '派生的记忆：原话在它的来源感知里');
    // 原话对不上（不在原文里）、没有原话的 soft：不算
    const b2 = W.percept({ settingKey: dm.key, actor: owner, text: '签到连续第四天', addressed: 'to-her' });
    W.assess(b2, { restriction: 'soft', sensitivity: 0.1, involvesOthers: false, restrictionQuote: '别外传' });
    assert.equal(W.D.explicitLimit(W.core, P(b2)), null);
    const b3 = W.percept({ settingKey: dm.key, actor: owner, text: '通关艾尔登法环了', addressed: 'to-her' });
    W.assess(b3, { restriction: 'soft', sensitivity: 0.1, involvesOthers: false });
    assert.equal(W.D.explicitLimit(W.core, P(b3)), null);
    // (c) 点了名的名单，定这条限制的不是她
    const c = W.assertion({ text: '小红在准备惊喜', subjects: [ming], sources: [{ speaker: ming, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, c, { restriction: 'soft', deny: [owner], restrictedBy: ming, sensitivity: 0.3 });
    assert.deepEqual(W.D.explicitLimit(W.core, c), { kind: 'strict', quote: null, by: ming, deny: [owner], source: 'list' });
    // (d) 主人收紧过（管理页、审核通过的收紧：历史里 by 是管理者）
    const d = W.assertion({ text: '主人的体检报告', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
    W.D.writeNorm(W.core, d, { restriction: 'none', sensitivity: 0.5 });
    W.D.applyNormUpdate(W.core, { target: { kind: 'memory', ref: W.ref(d) }, direction: 'tighten', change: { restriction: 'soft' }, quote: null }, { speakerEntityId: owner, at: W.now() });
    assert.equal(W.D.explicitLimit(W.core, d)?.by, owner);
    assert.equal(W.D.explicitLimit(W.core, d)?.source, 'manager');
    // 主人解除：explicitLimit 不再认它（第一眼核对过的那一句也一样）
    assert.equal(W.D.relaxLimit(W.core, d, { at: W.now(), speakerEntityId: owner }).applied, true);
    assert.equal(W.D.explicitLimit(W.core, d), null);
    assert.equal(W.D.relaxLimit(W.core, P(a), { at: W.now(), speakerEntityId: owner }).applied, true);
    assert.equal(W.D.explicitLimit(W.core, P(a)), null);
  } finally { await W.cleanup(); }
});
