// 时间感（D148，实测问题 #47 / #51 的形状，文字是编的）：主人晚上在群里说想吃点热的、她在群里答过，十几分钟后在一对一里打招呼——
//   - 间隔那一句看人：这里隔了几天，可他今天在别处一直和她有来往，两件事都说清，不说「隔了这么久」；没有别处的来往照旧；
//   - 工作记忆折行：留着她的回话，就留着他问的那句；拍一拍这种纯动作不顶掉他有内容的那一句；
//   - 记忆工具：查到的排在最前，工作记忆只留和问题有关的那几段。
// 真模块：createPersonaMemory + 替身端口 + 假平台；第一眼用替身（都不是约定），第二段、提炼一调用就报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, readGlanceCard, FakeLLM, MINUTE } from './presence-world.js';

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SEED = 148;
const show = (items) => JSON.stringify(items.map((i) => [i.layer, i.id, i.rendered]), null, 1);

function addGroup(w, name, label) {
  const d = structuredClone(w.fp.settings.smallGroup.descriptor);
  const id = opaqueFrom(`ts-${SEED}`, 'setting', name);
  Object.assign(d, { id, label });
  d.audience = { ...d.audience, size: 6, entry: 'closed', unknownObservers: false, membersKnown: 'recent-speakers' };
  d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
  d.capabilities = { preSendGate: true, canHold: false };
  d.ownership = { ...d.ownership, owner: w.fp.people.friend.actor };
  w.fp.settings[name] = { id, descriptor: d };
  w.fp.sink.describe(structuredClone(d));
}

/** 第一眼的替身：都是平常的闲聊（不是约定、不敏感）。 */
const glance = (req) => readGlanceCard(req).targets.map((t) => ({
  i: t.i, sens: 0.05, limit: 'none', quote: '', about: t.who === '你' ? 'both' : 'speaker', asks: false, gist: t.text.slice(0, 20), vague: '一件平常的事',
  replaces: null, follows: null, applies: [],
}));

async function world(name, config = {}) {
  const llm = new FakeLLM({ fallback: { appraise: new Error('no stage2'), extract: new Error('no extract'), review: new Error('review down'), glance } });
  const w = await openWorld({ seed: SEED, name, config: { mode: { byAttributes: { closed: 'live', public: 'live' } }, ...config }, llm });
  addGroup(w, 'groupX', '群X');
  addGroup(w, 'groupY', '群Y');
  await w.flush();
  return w;
}
async function settle(w) {
  await w.flush();
  await w.core.mods.discretion.glancesIdle(w.core);
}
const say = (w, where, who, text, gap = 15_000, extra = {}) => {
  const addressed = who === 'principal' && where === 'oneOnOne' ? 'to-her' : 'ambient';
  return w.say(where, who, text, who === 'her' ? { ...extra } : { addressed, attention: 'attended', ...extra }, gap);
};
function sessionIn(w, where, sid) {
  w.pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings[where].id, adapterId: w.fp.namespace, confidence: 'specific' });
}
async function ask(w, where, text, sid, opt = {}) {
  const o = say(w, where, 'principal', text, 7000);
  await w.flush();
  sessionIn(w, where, sid);
  return recallAt(w, where, o, { sessionId: sid, deadlineMs: 2000, ...opt });
}

test('间隔看人：这里隔了几天，可他今天在别处一直和她有来往——两件事都说，不说「隔了这么久」；没有别处的来往照旧', async () => {
  const w = await world('ts-gap');
  try {
    say(w, 'oneOnOne', 'principal', '早上好');
    say(w, 'oneOnOne', 'her', '早呀', 60_000);
    await settle(w);
    w.clock.advance(4 * DAY);
    say(w, 'groupX', 'principal', '今晚想吃点热乎的东西');
    say(w, 'groupX', 'principal', '有啥推荐');
    say(w, 'groupX', 'principal', '饿了');
    say(w, 'groupX', 'her', '热乎的就煮碗面吧，加个蛋', 5 * MINUTE);
    await settle(w);
    const out = await ask(w, 'oneOnOne', '在吗', 's-gap');
    const gap = out.items.find((i) => i.layer === 'gap');
    assert.ok(gap, show(out.items));
    const t = gap.rendered;
    assert.match(t, /^现在是 \d{4}-\d\d-\d\d（周.）\S\S \d{1,2}:\d\d；上次在这里聊是/u, t);
    assert.match(t, /已经 4 天了；不过今天你们在别处一直有来往，最近一次是/u, t);
    assert.match(t, /最近一次是(?:在「群X」，)?\S+ \d{1,2}:\d\d · 5 分钟前/u, `最近一次是她在群里回他的那一句：${t}`);
    assert.ok(!t.includes('隔了这么久'), t);
    assert.ok(t.endsWith('别直接接着这里上次的话题'), t);
  } finally { await w.close(); }

  const w2 = await world('ts-gap-none');
  try {
    say(w2, 'oneOnOne', 'principal', '早上好');
    say(w2, 'oneOnOne', 'her', '早呀', 60_000);
    await settle(w2);
    w2.clock.advance(4 * DAY);
    say(w2, 'groupX', 'friend', '今晚吃啥');
    await settle(w2);
    const out = await ask(w2, 'oneOnOne', '在吗', 's-gap2');
    const t = out.items.find((i) => i.layer === 'gap')?.rendered ?? '';
    assert.match(t, /已经 4 天了/u, show(out.items));
    assert.ok(!t.includes('别处'), t);
    assert.ok(t.includes('隔了这么久'), t);
  } finally { await w2.close(); }
});

test('工作记忆折行：留着她的回话，就留着他问的那句；拍一拍这种纯动作不顶掉他有内容的那一句', async () => {
  const w = await world('ts-fold');
  try {
    const asked = say(w, 'groupX', 'principal', '今晚想吃点热乎的东西');
    const more = say(w, 'groupX', 'principal', '有啥推荐');
    const poke = say(w, 'groupX', 'principal', '［拍一拍］ 戳了戳你', 15_000, { kind: 'action', addressed: 'to-her' });
    say(w, 'groupX', 'her', '别戳啦');
    const reply = say(w, 'groupX', 'her', '热乎的就煮碗面吧，加个蛋', 10 * MINUTE);
    const q = say(w, 'oneOnOne', 'principal', '在吗', 7000);
    await settle(w);
    const p = (o) => w.perceptOf(o);
    const owner = p(asked).actor_entity_id;
    const ws = w.core.mods.retrieve.workingSet(w.core, { settingKey: w.keyOf('oneOnOne'), focusPerceptId: p(q).id }, { triggerEntityId: owner, at: w.clock.now() });
    const u = ws.units.find((x) => x.members.includes(`p${p(reply).id}`));
    assert.ok(u, JSON.stringify(ws.units));
    assert.equal(u.kind, 'talk');
    assert.ok(u.core.includes(`p${p(asked).id}`), `她接的那一句在 core 里：${JSON.stringify(u.core)}`);
    assert.ok(u.core.includes(`p${p(reply).id}`), JSON.stringify(u.core));
    assert.ok(!u.core.includes(`p${p(poke).id}`), `拍一拍不进 core：${JSON.stringify(u.core)}`);
    assert.ok(!u.core.includes(`p${p(more).id}`), `她接的那句代替他最后一句，core 的行数不变：${JSON.stringify(u.core)}`);
    assert.equal(u.core.length, 2, JSON.stringify(u.core));

    // 她的回话接不上他的哪一句（词对不上）：照旧是他最后一句有内容的话，拍一拍照样不算
    const a2 = say(w, 'groupY', 'principal', '下班了');
    const k2 = say(w, 'groupY', 'principal', '［拍一拍］ 戳了戳你', 15_000, { kind: 'action', addressed: 'to-her' });
    const r2 = say(w, 'groupY', 'her', '辛苦啦', 5 * MINUTE);
    const q2 = say(w, 'oneOnOne', 'principal', '在吗', 7000);
    await settle(w);
    const ws2 = w.core.mods.retrieve.workingSet(w.core, { settingKey: w.keyOf('oneOnOne'), focusPerceptId: p(q2).id }, { triggerEntityId: owner, at: w.clock.now() });
    const u2 = ws2.units.find((x) => x.members.includes(`p${p(r2).id}`));
    assert.deepEqual(u2.core, [`p${p(a2).id}`, `p${p(r2).id}`], JSON.stringify(u2));
    assert.ok(!u2.core.includes(`p${p(k2).id}`));
  } finally { await w.close(); }
});

test('记忆工具：查到的排在最前；工作记忆只留和问题有关的那几段', async () => {
  // 库很小：稠密那一路的前几名什么都有，这里只认词法和字面（真实的库里稠密排在最前几名的才算）
  const w = await world('ts-tool', { context: { toolRecall: { denseTop: 0 } } });
  try {
    say(w, 'groupY', 'principal', '我家阳台上养了两条金鱼');
    say(w, 'groupY', 'her', '两条金鱼，好养吗');
    await settle(w);
    w.clock.advance(2 * HOUR);
    say(w, 'groupX', 'principal', '在看一部老电影');
    say(w, 'groupX', 'her', '看完说说好不好看', 5 * MINUTE);
    await settle(w);
    const out = await ask(w, 'oneOnOne', '我们刚才聊什么了', 's-tool', { mode: 'deliberate', query: '主人养的金鱼', deadlineMs: 4000, budgetChars: 1200 });
    const items = out.items;
    assert.ok(items.length, show(items));
    const firstWm = items.findIndex((i) => i.layer === 'working');
    const firstOther = items.findIndex((i) => i.layer !== 'working');
    if (firstWm >= 0 && firstOther >= 0) assert.ok(firstOther < firstWm, `查到的在工作记忆前面：${show(items)}`);
    assert.ok(!items.some((i) => i.layer === 'working' && /老电影|好不好看/.test(i.rendered)), `和问题不相干的那一段不放：${show(items)}`);
    assert.ok(items.some((i) => /金鱼/.test(i.rendered)), `问的那件事在：${show(items)}`);

    // 不自主回想（同一个场景）：工作记忆照常两段都在、排在前面
    const inv = await ask(w, 'oneOnOne', '在吗', 's-tool2');
    const wm = inv.items.filter((i) => i.layer === 'working');
    assert.ok(wm.some((i) => /老电影|好不好看/.test(i.rendered)), show(inv.items));
  } finally { await w.close(); }
});
