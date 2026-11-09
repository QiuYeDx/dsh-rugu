// render（§5.3、§5.4、§6.6、§8.5、F25）：来源说法、时态、计划状态、版本、哪一次、含糊版本、截断、清洗。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRef } from '../../src/store/refs.js';
import {
  retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedEpisode, seedDescriptor, supersede, T0, HOUR, DAY,
} from './fixtures.js';

const cand = (ref, extra = {}) => ({ ref, mref: parseRef(ref), ranks: {}, rrf: 0, signals: {}, A: 1, P: 0.95, parts: {}, ...extra });
const share = (core, ref, extra = {}, opt = {}) => core.mods.retrieve.render(core, cand(ref, extra), { verdict: 'share', at: T0, itemChars: 120, ...opt });

async function world() {
  const env = await retrieveCore();
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '大王', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明' });
  const cousin = seedEntity(core, { name: null });
  seedDescriptor(core, cousin, ming, '表哥');
  seedSetting(core, 'G', { label: '游戏群' });
  seedSetting(core, 'D', { label: '' });
  return { ...env, me, boss, ming, cousin };
}

test('来源说法：本人说的 / 听谁说的 / 最初是谁说的 / 自己的猜测 / 她自己说的；带绝对时间和场合', async () => {
  const w = await world();
  try {
    const { core } = w;
    const own = seedAssertion(core, { text: '大王今晚又要加班', subjects: [w.boss], confidence: 0.95,
      sources: [{ speaker: w.boss, mode: 'overheard', perceivedIn: 'G', at: T0 - 2 * HOUR }] });
    let r = share(core, `a${own}`);
    assert.equal(r.provenance, '主人在「游戏群」自己说的', '唯一的管理者用她对他的称呼（selfProfile.principalLabel），不用显示名');
    assert.match(r.rendered, /^（10\/31 10:00，主人在「游戏群」自己说的）大王今晚又要加班/);
    const hearsay = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [w.cousin], certainty: 'hearsay', confidence: 0.6,
      sources: [{ speaker: w.ming, mode: 'told_to_her', hop: 1, perceivedIn: 'G', at: T0 - DAY }] });
    r = share(core, `a${hearsay}`);
    assert.equal(r.provenance, '听阿明在「游戏群」说的');
    assert.match(r.rendered, /好像阿明的表哥开网约车/, '听说的 confidence ≤ 0.6 → 「好像」');
    const via = seedAssertion(core, { text: '表哥说网约车不好跑了', subjects: [w.cousin], certainty: 'hearsay', confidence: 0.6,
      sources: [{ speaker: w.ming, asserter: w.cousin, mode: 'told_to_her', hop: 1, perceivedIn: 'G' }] });
    assert.equal(share(core, `a${via}`).provenance, '听阿明在「游戏群」说的（最初是阿明的表哥说的）');
    const guess = seedAssertion(core, { text: '阿明今天心情不好', subjects: [w.ming], certainty: 'inferred', confidence: 0.5,
      sources: [{ speaker: w.me, mode: 'inferred', perceivedIn: 'G' }] });
    assert.equal(share(core, `a${guess}`).provenance, '你自己的猜测，没人说过');
    const mine = seedAssertion(core, { text: '我喜欢猫', subjects: [w.me], certainty: 'self_said',
      sources: [{ speaker: w.me, mode: 'self_generated', perceivedIn: 'G' }] });
    assert.equal(share(core, `a${mine}`).provenance, '你自己在「游戏群」说的');
    const told = seedAssertion(core, { text: '阿明下周要搬家', subjects: [w.ming],
      sources: [{ speaker: w.ming, mode: 'told_to_her', perceivedIn: 'G' }, { speaker: w.boss, mode: 'overheard', perceivedIn: 'G', hop: 1, confidence: 0.5 }] });
    assert.equal(share(core, `a${told}`).provenance, '阿明在「游戏群」自己说的，还有1个人也提过');
  } finally { await w.cleanup(); }
});

test('目标场合就是来源场合时说「在这里」；激活低时来源说得含糊（只说在哪听谁提过，不点名）', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [w.cousin], certainty: 'hearsay', confidence: 0.6,
      sources: [{ speaker: w.ming, mode: 'told_to_her', hop: 1, perceivedIn: 'G' }] });
    assert.equal(share(core, `a${a}`, {}, { settingKey: 'G' }).provenance, '听阿明在这里说的');
    const low = share(core, `a${a}`, { P: 0.2 });
    assert.equal(low.provenance, '好像是在「游戏群」听谁提过');
    assert.ok(!low.rendered.includes('听阿明'));
    assert.match(low.rendered, /（印象很模糊，别主动提）$/, 'P 和置信度都低 → 不主动提（§6.6）');
    assert.ok(low.confidence <= 0.2);
  } finally { await w.cleanup(); }
});

test('说个大概：只用第二段写好的含糊版本，来源也含糊，只写日期；没有含糊版本就不给内容', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '阿明的表哥小刚被乘客投诉了', subjects: [w.cousin],
      sources: [{ speaker: w.ming, mode: 'told_to_her', perceivedIn: 'G', at: T0 - DAY }] });
    const r = core.mods.retrieve.render(core, cand(`a${a}`), { verdict: 'share_vague', vagueText: '有人提过最近工作不太好找', at: T0, itemChars: 120 });
    assert.equal(r.rendered, '（10/30，听人说的）有人提过最近工作不太好找');
    assert.equal(r.provenance, '听人说的');
    for (const leak of ['阿明', '游戏群', '投诉', '小刚']) assert.ok(!r.rendered.includes(leak), leak);
    const none = core.mods.retrieve.render(core, cand(`a${a}`), { verdict: 'share_vague', at: T0, itemChars: 120 });
    assert.equal(none.rendered, '');
  } finally { await w.cleanup(); }
});

test('时态（§5.4）：成立概率高 → 现在时；中间 → 不确定；低 → 过去时；「据说已变」；稳定的事实不加时态', async () => {
  const w = await world();
  try {
    const { core } = w;
    const mk = (t50, ago, extra = {}) => seedAssertion(core, { text: '大王在加班', subjects: [w.boss], t50, shape: 1, validFrom: T0 - ago,
      sources: [{ speaker: w.boss, mode: 'told_to_her', perceivedIn: 'D', at: T0 - ago }], ...extra });
    assert.match(share(core, `a${mk(5, HOUR)}`).rendered, /（现在大概还是这样）$/);
    assert.match(share(core, `a${mk(5, 5 * HOUR)}`).rendered, /（当时是这样，现在不知道了）$/);
    assert.match(share(core, `a${mk(5, 30 * HOUR)}`).rendered, /（是那时候的事了）$/);
    assert.match(share(core, `a${mk(null, DAY, { changeKnown: true })}`).rendered, /（听说后来变了，变成什么不清楚）$/);
    const stable = seedAssertion(core, { text: '大王养了一只猫', subjects: [w.boss], sources: [{ speaker: w.boss, perceivedIn: 'D' }] });
    assert.ok(!/现在|当时|那时候/.test(share(core, `a${stable}`).rendered));
  } finally { await w.cleanup(); }
});

test('计划带状态（§5.5）；被取代的旧版本标出来；context 把旧版本也过了关口①时渲染成「之前……，后来……」', async () => {
  const w = await world();
  try {
    const { core } = w;
    const plan = (status, end) => seedAssertion(core, { text: '大王要去拿快递', subjects: [w.boss], kindHint: 'plan', planStatus: status, eventStart: end - HOUR, eventEnd: end,
      sources: [{ speaker: w.boss, perceivedIn: 'D' }] });
    assert.match(share(core, `a${plan('planned', T0 + HOUR)}`).rendered, /（还没听说结果）$/);
    assert.match(share(core, `a${plan('planned', T0 - HOUR)}`).rendered, /（到时候了，还没听说结果）$/);
    assert.match(share(core, `a${plan('done', T0 - HOUR)}`).rendered, /（后来做完了）$/);
    assert.match(share(core, `a${plan('unknown', T0 - HOUR)}`).rendered, /（后来怎么样没听说）$/);
    const old = seedAssertion(core, { text: '阿明的表哥送外卖', subjects: [w.cousin], sources: [{ speaker: w.ming, perceivedIn: 'G' }] });
    const neu = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [w.cousin], sources: [{ speaker: w.ming, perceivedIn: 'G' }] });
    supersede(core, old, neu);
    assert.match(share(core, `a${old}`).rendered, /（后来有了新的说法）$/);
    const both = core.mods.retrieve.render(core, cand(`a${neu}`), { verdict: 'share', at: T0, itemChars: 120, previous: { candidate: cand(`a${old}`), verdict: 'share' } });
    assert.match(both.rendered, /之前阿明的表哥送外卖，后来阿明的表哥开网约车/);
  } finally { await w.cleanup(); }
});

test('哪一次：更早的一次标出来，挨得近的标「可能指多次」', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '大王拿到了快递', subjects: [w.boss], sources: [{ speaker: w.boss, perceivedIn: 'D' }] });
    assert.match(share(core, `a${a}`, { occurrence: { count: 2, latest: false, ambiguous: false } }).rendered, /（这是更早的一次）$/);
    assert.match(share(core, `a${a}`, { occurrence: { count: 2, latest: true, ambiguous: true } }).rendered, /可能指别的那次/);
    assert.ok(!/更早|可能指/.test(share(core, `a${a}`, { occurrence: { count: 2, latest: true, ambiguous: false } }).rendered));
  } finally { await w.cleanup(); }
});

test('原始感知：原话带说话人；撤回的不展示原话；她心里想的写明；情节、原文窗口、实体也能渲染', async () => {
  const w = await world();
  try {
    const { core } = w;
    const p = seedPercept(core, { settingKey: 'G', at: T0 - HOUR, actor: w.ming, text: '我表哥又换车了', addressed: 'to-her' });
    const r = share(core, `p${p}`);
    assert.equal(r.provenance, '阿明在「游戏群」跟你说的');
    assert.match(r.rendered, /阿明：「我表哥又换车了」/);
    const gone = seedPercept(core, { settingKey: 'G', at: T0 - HOUR, actor: w.ming, text: '不想让人看到的话', textState: 'retracted' });
    const g = share(core, `p${gone}`);
    assert.ok(!g.rendered.includes('不想让人看到的话'));
    assert.match(g.rendered, /后来撤回了/);
    const th = seedPercept(core, { settingKey: 'G', at: T0 - HOUR, self: true, actor: w.me, kind: 'self-thought', text: '阿明今天好像心情不好', visibleTo: 'her-only' });
    assert.equal(share(core, `p${th}`).provenance, '你心里想过的');
    const ep = seedEpisode(core, { settingKey: 'G', narrative: '大家在群里聊显卡涨价', tStart: T0 - 3 * HOUR });
    assert.match(share(core, `e${ep}`).rendered, /^（10\/31 09:00，你在「游戏群」经历的）大家在群里聊显卡涨价$/);
    const sum = seedEpisode(core, { settingKey: 'G', epKind: 'summary', narrative: '下午和大家聊了显卡', tStart: T0 - 3 * HOUR });
    assert.equal(share(core, `e${sum}`).provenance, '你自己记下的小结');
    assert.match(share(core, `n${w.cousin}`).rendered, /阿明的表哥/);
    assert.deepEqual(core.mods.retrieve.render(core, cand('a99999'), { verdict: 'share', at: T0, itemChars: 120 }), { rendered: '', provenance: '', confidence: 0 });
  } finally { await w.cleanup(); }
});

test('知道感：不给内容，只说好像听谁提过和这有关的事', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [w.cousin], sources: [{ speaker: w.ming, mode: 'told_to_her', perceivedIn: 'G' }] });
    const r = share(core, `a${a}`, { fok: true, P: 0.1 });
    assert.equal(r.rendered, '（好像听阿明在「游戏群」提过和这有关的事，但想不起细节了）');
    assert.ok(!r.rendered.includes('网约车'));
  } finally { await w.cleanup(); }
});

test('整条 ≤ itemChars（按字算，不切坏 emoji）；文字过清洗（【】→「」、折叠换行）', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: `【公告】${'很长的一段话😀'.repeat(30)}\n第二行`, subjects: [w.boss], sources: [{ speaker: w.boss, perceivedIn: 'D' }] });
    const r = share(core, `a${a}`, {}, { itemChars: 40 });
    assert.ok([...r.rendered].length <= 40);
    assert.ok(!r.rendered.includes('【') && r.rendered.includes('「公告」'));
    assert.ok(!r.rendered.includes('\n'));
    assert.ok(r.rendered.endsWith('…'));
    assert.ok(!/[\uD800-\uDBFF]…$/.test(r.rendered));
  } finally { await w.cleanup(); }
});

test('别的场合的名字也要过关口①：opt.placeAllowed 说不能写的场合，来源说法里不写在哪儿（内容照常）；目标场合本身照常是「在这里」', async () => {
  const w = await world();
  try {
    const { core } = w;
    const a = seedAssertion(core, { text: '阿明周末去爬山', subjects: [w.ming], confidence: 0.95,
      sources: [{ speaker: w.ming, mode: 'told_to_her', perceivedIn: 'G', at: T0 - 2 * HOUR }] });
    const asked = [];
    const no = share(core, `a${a}`, {}, { settingKey: 'D', placeAllowed: (k) => { asked.push(k); return false; } });
    assert.equal(no.provenance, '阿明自己说的', no.provenance);
    assert.ok(!no.rendered.includes('游戏群') && no.rendered.includes('阿明周末去爬山'), no.rendered);
    assert.deepEqual(asked, ['G']);
    const yes = share(core, `a${a}`, {}, { settingKey: 'D', placeAllowed: () => true });
    assert.equal(yes.provenance, '阿明在「游戏群」自己说的');
    // 目标就是来源场合：「在这里」，不用问
    const here = share(core, `a${a}`, {}, { settingKey: 'G', placeAllowed: () => { throw new Error('不该问'); } });
    assert.equal(here.provenance, '阿明在这里自己说的');
    // 判定出错：不写（fail closed）
    assert.equal(share(core, `a${a}`, {}, { settingKey: 'D', placeAllowed: () => { throw new Error('x'); } }).provenance, '阿明自己说的');
  } finally { await w.cleanup(); }
});
