// D113 集成评审修的几处（全部用替身，账号、群号都是假的）：
//   - 非公开目标上原文放进来的条目（普通回想、常驻区）也带来源标签：说不出名字的别处来源按结构写「私聊时」，核对过原话的叮嘱写在后面；
//   - 「给第三方的敏感私事」这条底线在还没提炼的感知上用第一眼的 sens（原来只看规范，现场等于不存在）；
//   - named-deny 只认「被点名的人的关系人确实在这里」，不认「看不全、可能在」；定叮嘱的人自己就在这里问的不算；看 hintBlocked 以外的事实，
//     不看第一段报的规则名（B4 先封顶时规则名是 B4）；
//   - 主人定的上限（B4 封顶）在非公开目标上照旧由代码执行（走第二段和封顶），不只是标签；
//   - 读不到的目标：会留下来的（persistence 不是 once）走公开路径，说完就过去的走守护。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, appraiseReply } from './world.js';
import { FakeLLM } from '../fakes/index.js';

function glance(W, id, g = {}) {
  W.core.store.run(`INSERT INTO glances(percept_id, setting_key, state, sens, limit_kind, quote, quote_ok, about, asks, mixed, created_at)
                    SELECT id, setting_key, 'done', ?, ?, ?, ?, ?, 0, 0, ? FROM percepts WHERE id = ?`,
  g.sens ?? 0.1, g.limit ?? 'none', g.quote ?? null, g.quoteOk ? 1 : 0, g.about ?? 'speaker', W.now(), id);
}

async function scene(name, opt = {}) {
  const W = await makeWorld({ name, llm: opt.llm ?? new FakeLLM({ fallback: { appraise: new Error('no stage2') } }) });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const friend = W.person('小美', { closeness: 0.5 });
  const pal = W.person('小刚', { closeness: 0.4 });
  const dm = W.setting('和主人的私聊', 'oneOnOne');
  W.presence(dm.key, [W.me, owner]);
  const friendDm = W.setting('和小美的私聊', 'oneOnOne');
  W.presence(friendDm.key, [W.me, friend]);
  const y = W.setting('群Y', 'group');
  W.presence(y.key, [W.me, owner, pal], W.now(), 'recent-speakers', true);
  return { W, owner, friend, pal, dm, friendDm, y };
}

test('普通回想 / 常驻区的条目也带来源标签：私聊里核对过原话的叮嘱，到群里原文进来时写着「私聊时」和「叮嘱过别外传：「…」」', async () => {
  const { W, owner, pal, dm, y } = await scene('r-label');
  try {
    const p1 = W.percept({ settingKey: dm.key, actor: owner, text: '我明天下午去面试产品经理岗，刚才那句别外传哈', addressed: 'to-her' });
    glance(W, p1, { sens: 0.4, limit: 'soft', quote: '别外传哈', quoteOk: true });
    const m = { kind: 'percept', id: p1 };
    const items = await W.gate([m], W.target(y.key, { trigger: pal, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.equal(items.length, 1);
    assert.equal(items[0].verdict, 'share');
    assert.deepEqual(items[0].label.limit, { kind: 'soft', quote: '别外传哈', by: owner });
    // 渲染：场合名说不出来（placeAllowed false）→ 按结构写「私聊时」；后面带叮嘱
    const r = W.core.mods.retrieve.render(W.core, W.cand(m), { verdict: 'share', at: W.now(), itemChars: 200, settingKey: y.key, placeAllowed: () => false, label: items[0].label });
    assert.match(r.rendered, /私聊时/, r.rendered);
    assert.match(r.rendered, /主人叮嘱过别外传：「别外传哈」/, r.rendered);
    // 没有 label（公开目标的老路径、工作记忆以外的老调用）：照旧不写在哪儿
    const r0 = W.core.mods.retrieve.render(W.core, W.cand(m), { verdict: 'share', at: W.now(), itemChars: 200, settingKey: y.key, placeAllowed: () => false });
    assert.doesNotMatch(r0.rendered, /私聊时|叮嘱/);
  } finally { await W.cleanup(); }
});

test('给第三方的敏感私事：还没提炼的感知用第一眼的 sens——朋友私聊说的病情，群里别人问起 → 不进（所有层）；朋友自己在问 → 进', async () => {
  const { W, friend, pal, friendDm, y } = await scene('r-sens');
  try {
    W.presence(y.key, [W.me, friend, pal], W.now(), 'recent-speakers', true);
    const p1 = W.percept({ settingKey: friendDm.key, actor: friend, text: '我上周体检查出来血糖很高，医生说可能是糖尿病，挺担心的', addressed: 'to-her' });
    glance(W, p1, { sens: 0.8 });
    const m = { kind: 'percept', id: p1 };
    W.clock.hours(2);
    let items = await W.gate([m], W.target(y.key, { trigger: pal, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.deepEqual(items, []);
    assert.ok(W.logs().some((l) => l.memory_id === p1 && l.reason === 'omit:sensitive-other'));
    const adm = W.D.admitWorking(W.core, [{ ref: `p${p1}` }], W.target(y.key, { trigger: pal }));
    assert.deepEqual(adm.excluded.map((x) => x.rule), ['sensitive-other']);
    // 她自己在问（这是她的事）：照常进
    items = await W.gate([m], W.target(y.key, { trigger: friend, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.equal(items[0]?.verdict, 'share');
    // 第一眼说不敏感的平常话：照常进
    const p2 = W.percept({ settingKey: friendDm.key, actor: friend, text: '我周末去爬山了，腿到现在还酸', addressed: 'to-her' });
    glance(W, p2, { sens: 0.1 });
    items = await W.gate([{ kind: 'percept', id: p2 }], W.target(y.key, { trigger: pal, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.equal(items[0]?.verdict, 'share');
  } finally { await W.cleanup(); }
});

test('named-deny：「别告诉阿明」——阿明从没在这个群出现过（看不全、可能在）→ 照常进、带叮嘱；定叮嘱的人自己就在这里问 → 进；阿明的好朋友在这里 → 不进', async () => {
  const { W, friend, pal, y } = await scene('r-deny');
  try {
    const ming = W.person('阿明', { closeness: 0.6 });
    const bestie = W.person('大伟', { closeness: 0.4 });
    W.descriptor(bestie, ming, '最好的朋友', 'third-party', friend);
    const hongDm = W.setting('和小美的私聊2', 'oneOnOne');
    W.presence(hongDm.key, [W.me, friend]);
    const p1 = W.percept({ settingKey: hongDm.key, actor: friend, text: '别告诉阿明哦，我周末在给他准备生日惊喜', addressed: 'to-her' });
    W.assess(p1, { restriction: 'soft', sensitivity: 0.3, involvesOthers: true, deny: [ming], restrictedBy: friend, restrictionQuote: '别告诉阿明' });
    const m = { kind: 'percept', id: p1 };
    // 读书群：阿明从没来过，人看不全
    const book = W.setting('读书群', 'group');
    W.presence(book.key, [W.me, friend, pal], W.now(), 'recent-speakers', true);
    let items = await W.gate([m], W.target(book.key, { trigger: pal, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.equal(items[0]?.verdict, 'share');
    assert.equal(items[0].label.limit.quote, '别告诉阿明');
    // 小美自己在读书群里问
    items = await W.gate([m], W.target(book.key, { trigger: friend, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.equal(items[0]?.verdict, 'share');
    // 阿明最好的朋友在的群：不进（叮嘱里被点名的人的关系人确实在这里）
    const g2 = W.setting('有大伟的群', 'group');
    W.presence(g2.key, [W.me, bestie, pal], W.now(), 'recent-speakers', true);
    items = await W.gate([m], W.target(g2.key, { trigger: pal, mode: 'deliberate' }), { mode: 'deliberate' });
    assert.deepEqual(items, []);
    assert.ok(W.logs().some((l) => l.memory_id === p1 && l.reason === 'omit:named-deny'));
    // 主人的 B4 封顶先命中（规则名是 B4）也一样认得出 named-deny（看事实，不看规则名）
    W.ownerRule({ entity: ming }, 'share_vague');
    const adm = W.D.admitWorking(W.core, [{ ref: `p${p1}` }], W.target(g2.key, { trigger: pal }));
    assert.deepEqual(adm.excluded.map((x) => x.rule), ['named-deny']);
  } finally { await W.cleanup(); }
});

test('主人定的上限（B4「最多说个大概」）在非公开目标上照旧由代码执行：走第二段、只给含糊版本，不是原文加标签', async () => {
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share_vague', vague: '他最近在忙工作上的事' }) } });
  const { W, owner, pal, dm, y } = await scene('r-b4', { llm });
  try {
    const p1 = W.percept({ settingKey: dm.key, actor: owner, text: '我下个月要跳槽去另一家公司了', addressed: 'to-her' });
    W.assess(p1, { restriction: 'none', sensitivity: 0.3, involvesOthers: false, attribute: '工作' });
    W.ownerRule({ attribute: '工作' }, 'share_vague');
    const items = await W.gate([{ kind: 'percept', id: p1 }], W.target(y.key, { trigger: pal, mode: 'deliberate' }), { mode: 'deliberate', deadlineMs: 3000 });
    assert.equal(items[0]?.verdict, 'share_vague');
    assert.equal(items[0].vagueText, '他最近在忙工作上的事');
    assert.ok(llm.callsFor('appraise').length >= 1, '主人的上限走第二段');
  } finally { await W.cleanup(); }
});

test('读不到的目标：会留下来的（recurring-context）走公开路径（送审），说完就过去的（once）走守护', async () => {
  const llm = new FakeLLM({ fallback: { review: [{ verdict: 'reconsider', reflection: '先不说', reason: '测试', touches: [] }] } });
  const { W, owner, dm } = await scene('r-unknown', { llm });
  try {
    const p1 = W.percept({ settingKey: dm.key, actor: owner, text: '我下个月要辞职了', addressed: 'to-her' });
    W.session('s1', dm.key, { ledger: [`p${p1}`] });
    W.turn('s1', [owner]);
    const say = (persistence) => W.D.appraise(W.core, { channel: { targetSettingId: 'never-seen-place', persistence }, text: ['大家好，今天也加油'],
      origin: { path: 'tool', sessionId: 's1', homeSettingId: dm.sid } });
    const once = await say('once');
    assert.equal(once.verdict, 'speak');
    assert.equal(llm.callsFor('review').length, 0);
    const kept = await say('recurring-context');
    assert.notEqual(kept.verdict, 'speak', '会留下来的读不到目标：按公开的审');
  } finally { await W.cleanup(); }
});

test('管理页「被拦下的话」：依据按目标现在的属性分——非公开目标上 D113 以前审视判的「先不说」算旧规则，公开目标的挂起算公开路径；error 能单独筛；「她在守的叮嘱」列出第一眼核对过的', async () => {
  const { W, owner, pal, dm, y } = await scene('r-admin');
  try {
    const pub = W.setting('评论区', 'public');
    const ins = (key, verdict, reasons) => W.core.store.run(`INSERT INTO utterances(token, setting_key, at, channel_json, origin_path, text_hash, verdict, reasons_json, created_at)
      VALUES (?, ?, ?, '{}', 'tool', 'h', ?, ?, ?)`, `t-${Math.random()}`, key, W.now(), verdict, JSON.stringify(reasons), W.now());
    ins(y.key, 'reconsider', ['model:flash', 'turn-tainted']);
    ins(y.key, 'reconsider', ['floor:P1']);
    ins(y.key, 'reconsider', ['guard:relay', 'p1']);
    ins(pub.key, 'hold', ['public-hold', 'model:flash']);
    ins(pub.key, 'reconsider', ['error']);
    const L = (q) => W.core.mods.admin.list(W.core, { view: 'blocked', ...q }).items;
    const byBasis = Object.fromEntries(['guard', 'public', 'legacy', 'error'].map((b) => [b, L({ basis: b }).length]));
    assert.deepEqual(byBasis, { guard: 1, public: 1, legacy: 2, error: 1 });
    assert.deepEqual(L({}).map((x) => x.basis).sort(), ['error', 'guard', 'legacy', 'legacy', 'public']);
    // current = 旧规则以外的全部（D119：管理页默认只列这些）
    assert.deepEqual(L({ basis: 'current' }).map((x) => x.basis).sort(), ['error', 'guard', 'public']);
    // 她在守的叮嘱
    const p1 = W.percept({ settingKey: dm.key, actor: owner, text: '我要辞职了，别告诉别人', addressed: 'to-her' });
    glance(W, p1, { limit: 'strict', quote: '别告诉别人', quoteOk: true });
    const plain = W.percept({ settingKey: dm.key, actor: owner, text: '签到连续第四天', addressed: 'to-her' });
    W.assess(plain, { restriction: 'soft', sensitivity: 0.1, involvesOthers: false });
    const lims = W.core.mods.admin.list(W.core, { view: 'limits' }).items;
    assert.deepEqual(lims.map((x) => x.ref), [`p${p1}`], '没有原话的 soft 不算');
    void pal;
  } finally { await W.cleanup(); }
});
