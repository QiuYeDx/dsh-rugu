// 他在回哪一句（D145）：工作记忆从「他说的那几句」补成「他刚参与的那段对话」——他在群里回别人的一句话，带上被回的那一句。
// 实测的形状（内容是编的）：群里一个群友先发了一句「#查询」，接着说「你这插件没做防刷屏保护啊」；主人答「没做」。几分钟后主人在私聊里问她
// 「你觉得有必要做一下那个防刷屏保护吗」——原来工作记忆里只有「主人：没做」（别人的话不进这一层），几十句的闲聊段里连它都被省掉
// （core 只留最新的一两句），她答不上来。
// 现在：认「他在回哪一句」只看结构（回复 / 引用的目标；没有的话是紧挨在他这句前面的、别人亲口说的那一句），带不带按关口①第一段
// （直接放行的才带），话题相似度把被回那一句的词并进他这一行，闲聊段的 core 加上和眼前话题最相近的他的那一句。
// 真模块：createPersonaMemory + 替身端口 + 假平台（随机命名空间、随机语言标签）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, platformSeeds, FakeLLM, readCards, MINUTE } from './presence-world.js';

const SEEDS = platformSeeds();
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const ASKED = '你这插件没做防刷屏保护啊';
const ASK = '你觉得有必要做一下那个防刷屏保护吗';
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
const metricOf = (w, name) => Number(w.core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', name)?.v ?? 0);
// 第二段一律判不提：被回的那一句不该等它、也不该靠它
const omit = () => (req) => readCards(req).cards.map((c) => ({ id: c.id, verdict: 'omit', reason: '替身' }));

/** 一个小群（成员看不全）和一个大群（有不认识的旁观者）；适配器 describe 一次。 */
function addGroups(w, seed) {
  const base = w.fp.settings.smallGroup.descriptor;
  const mk = (name, label, audience) => {
    const d = structuredClone(base);
    const id = opaqueFrom(`wr-${seed}`, 'setting', name);
    Object.assign(d, { id, label });
    d.audience = { ...d.audience, ...audience };
    d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
    d.capabilities = { preSendGate: true, canHold: false };
    d.ownership = { ...d.ownership, owner: w.fp.people.friend.actor };
    w.fp.settings[name] = { id, descriptor: d };
    w.fp.sink.describe(structuredClone(d));
  };
  mk('groupX', '群X', { size: 6, entry: 'closed', unknownObservers: false, membersKnown: 'recent-speakers' });
  mk('groupY', '群Y', { size: 40, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' });
}

async function world(seed, name) {
  const w = await openWorld({ seed, name, config: LIVE, llm: new FakeLLM({ fallback: { appraise: omit() } }) });
  addGroups(w, seed);
  await w.flush();
  return w;
}

const pid = (w, o) => `p${w.perceptOf(o).id}`;
const wmOf = (r) => r.items.filter((i) => i.layer === 'working');

/**
 * 主人先在群 X 里说了一句（他在这里、看得到后面的话：第一段按「同一时刻亲自发过言的人」算他知道），群友发「#查询」、接着说 ASKED，
 * 主人答「没做」（opt.extra：「没做」那一条的额外字段）。
 */
function exchange(w, opt = {}) {
  w.say('groupX', 'principal', '今天有点忙', { addressed: 'ambient', attention: 'attended' }, 60_000);
  w.say('groupX', 'friend', '#查询', { addressed: 'ambient', attention: 'peripheral' }, 5_000);
  const asked = w.say('groupX', 'friend', opt.askedText ?? ASKED, { addressed: 'ambient', attention: 'peripheral' }, 20_000);
  const between = opt.between ? w.say('groupX', 'other', opt.between, { addressed: 'ambient', attention: 'peripheral' }, 10_000) : null;
  const answer = w.say('groupX', 'principal', '没做', { addressed: 'ambient', attention: 'attended', ...(opt.extra?.(asked) ?? {}) }, 20_000);
  return { asked, answer, between };
}

test('D145：主人在群里答了一句「没做」，几分钟后在私聊里问起——工作记忆里先是群友那一句、再是主人答的那一句，同一段、段头标着在群里当着大家', async (t) => {
  for (const seed of SEEDS) {
    await t.test(`seed ${seed}`, async () => {
      const w = await world(seed, 'wr-basic');
      try {
        const x = exchange(w);
        w.clock.advance(5 * MINUTE);
        const ask = w.say('oneOnOne', 'principal', ASK, { addressed: 'to-her', attention: 'attended' });
        await w.flush();
        w.pm.sessions.bind({ sessionId: 'sess-dm', settingId: w.fp.settings.oneOnOne.id, adapterId: w.fp.namespace, confidence: 'specific' });
        const r = await recallAt(w, 'oneOnOne', ask, { sessionId: 'sess-dm' });
        const wm = wmOf(r);
        const ids = wm.map((i) => i.id);
        const asked = pid(w, x.asked);
        const answer = pid(w, x.answer);
        assert.ok(ids.includes(answer), `主人答的那一句在工作记忆里 ${show(r.items)}`);
        assert.ok(ids.includes(asked), `群友被回的那一句也在 ${show(r.items)}`);
        const a = wm.find((i) => i.id === asked);
        const b = wm.find((i) => i.id === answer);
        assert.equal(ids.indexOf(asked) + 1, ids.indexOf(answer), `顺序：被回的那一句紧挨在他答的那一句前面 ${show(wm)}`);
        assert.equal(a.group, b.group, '同一段');
        const groupHead = wm.find((i) => i.group === a.group);
        assert.match(groupHead.rendered, /^〔[^〕]*当着大家/, `段头标着在群里当着大家说的 ${groupHead.rendered}`);
        assert.match(a.rendered, new RegExp(`(^|〕)[^：〔〕]+：${ASKED}`), a.rendered);
        assert.ok(!new RegExp(`(^|〕)他：${ASKED}`).test(a.rendered), `不写成「他」（「他」指眼前这个人） ${a.rendered}`);
        assert.ok(!/听.+说的/.test(a.rendered), `不是他转述的：不写「听谁说的」 ${a.rendered}`);
        assert.match(b.rendered, /：没做/);
        // 「#查询」不是被回的那一句（紧挨在前面的是 ASKED）
        assert.ok(!wm.some((i) => /#查询/.test(i.rendered)), show(wm));
        // 一条对一次判定：被回的那一句是第一段直接放行的（不是 A4 / A5）
        const row = w.core.store.get('SELECT stage, rule, reason FROM appraisals WHERE id = ?', Number(a.appraisalRef.slice(2)));
        assert.equal(row.stage, 1);
        assert.ok(!['A4', 'A5'].includes(row.rule), JSON.stringify(row));
        assert.match(row.reason, /^working:replied:/);
        assert.ok(metricOf(w, 'wm.replied.items') >= 1, '计数 wm.replied.items');
        // 外发守护的账本里也有它（G2 照样按账本逐条看）
        w.pm.sessions.injected({ sessionId: 'sess-dm', nonce: 'n1', layer: 'block', mode: 'live', chars: 10,
          items: r.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })) });
        w.pm.sessions.confirm('sess-dm', 'n1');
        assert.ok(w.core.mods.context.taintLedger(w.core, 'sess-dm').includes(asked), '进了注入日志的条目、在账本里');
        // 接续的计数没有新的 miss
        assert.equal(metricOf(w, 'wm.continuity.miss'), 0, 'wm.continuity.miss');
      } finally { await w.close(); }
    });
  }
});

test('D145：那段群聊很长（几十句闲聊）、主人答的那一句不是最新的——靠被回那一句的话题和闲聊段的切题那一句，仍然装得进来，预算没被挤爆', async (t) => {
  for (const seed of SEEDS) {
    await t.test(`seed ${seed}`, async () => {
      const w = await world(seed, 'wr-long');
      try {
        const x = exchange(w);
        // 之后几十句闲聊：主人隔几句说一句（同一段），她也回几句
        const chat = ['今晚吃什么', '火锅吧', '又是火锅', '那烧烤', '下雨了', '带伞没', '周末去爬山吗', '看天气', '新番出了', '哪一部'];
        for (let i = 0; i < 44; i++) {
          if (i % 4 === 3) w.say('groupX', 'principal', `@${w.fp.people.other.name} 就${i}条`, { addressed: 'ambient', attention: 'attended' }, 8_000);
          else if (i % 9 === 5) w.say('groupX', 'her', `嗯嗯${i}`, {}, 8_000);
          else w.say('groupX', i % 2 ? 'other' : 'stranger', `${chat[i % chat.length]}${i}`, { addressed: 'ambient', attention: 'peripheral' }, 8_000);
        }
        w.clock.advance(5 * MINUTE);
        const ask = w.say('oneOnOne', 'principal', ASK, { addressed: 'to-her', attention: 'attended' });
        await w.flush();
        const r = await recallAt(w, 'oneOnOne', ask);
        const wm = wmOf(r);
        const ids = wm.map((i) => i.id);
        assert.ok(ids.includes(pid(w, x.answer)), `「没做」不是最新的，也装进来了 ${show(wm)}`);
        assert.ok(ids.includes(pid(w, x.asked)), `被回的那一句也在 ${show(wm)}`);
        assert.ok(ids.indexOf(pid(w, x.asked)) < ids.indexOf(pid(w, x.answer)), show(wm));
        const W = w.core.config.get().recall.working;
        assert.ok(wm.length <= W.maxLines, `行数不超 maxLines：${wm.length}`);
        assert.ok(wm.reduce((n, i) => n + [...i.rendered].length, 0) <= W.budgetChars, '字数不超 budgetChars');
        assert.equal(new Set(ids).size, ids.length, '同一句只出现一次');
      } finally { await w.close(); }
    });
  }
});

test('D145：被回的那一句过不了第一段（带着别外传的叮嘱；来源比眼前的场合更私密、这里有人当时不在）——不带，只有他那一句', async (t) => {
  await t.test('叮嘱过别外传', async () => {
    const w = await world(SEEDS[0], 'wr-limit');
    try {
      const x = exchange(w, { askedText: '别外传啊，你这插件没做防刷屏保护' });
      await w.flush();
      const askedId = w.perceptOf(x.asked).id;
      w.core.mods.discretion.writeNorm(w.core, { kind: 'percept', id: askedId }, { sensitivity: 0.3, restriction: 'strict', restrictionQuote: '别外传', involvesOthers: false });
      w.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", askedId);
      w.clock.advance(5 * MINUTE);
      const ask = w.say('oneOnOne', 'principal', ASK, { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      const r = await recallAt(w, 'oneOnOne', ask);
      const wm = wmOf(r);
      assert.ok(wm.some((i) => i.id === pid(w, x.answer)), `他那一句照旧在 ${show(r.items)}`);
      assert.ok(!wm.some((i) => i.id === `p${askedId}`), `叮嘱过的那一句不跟着带进来 ${show(r.items)}`);
      assert.ok(metricOf(w, 'wm.replied.excluded') >= 1, '计数 wm.replied.excluded');
    } finally { await w.close(); }
  });
  await t.test('在更大、有旁观者的群里问起', async () => {
    const w = await world(SEEDS[0], 'wr-wider');
    try {
      const x = exchange(w);
      w.clock.advance(5 * MINUTE);
      w.say('groupY', 'stranger', '大家好', { addressed: 'ambient', attention: 'peripheral' });
      const ask = w.say('groupY', 'principal', `@她 ${ASK}`, { addressed: 'mentions-her', attention: 'attended' });
      await w.flush();
      const r = await recallAt(w, 'groupY', ask);
      const wm = wmOf(r);
      assert.ok(wm.some((i) => i.id === pid(w, x.answer)), `他那一句照旧在 ${show(r.items)}`);
      assert.ok(!wm.some((i) => i.id === pid(w, x.asked)), `群友在小群里说的，这里有人当时不在：不跟着带进来 ${show(r.items)}`);
    } finally { await w.close(); }
  });
});

test('D145：带着回复目标的消息按目标取，不按「紧挨在前面的那一句」', async (t) => {
  for (const seed of SEEDS) {
    await t.test(`seed ${seed}`, async () => {
      const w = await world(seed, 'wr-target');
      try {
        const x = exchange(w, { between: '今晚吃火锅吗', extra: (asked) => ({ replyTo: asked.id }) });
        w.clock.advance(5 * MINUTE);
        const ask = w.say('oneOnOne', 'principal', ASK, { addressed: 'to-her', attention: 'attended' });
        await w.flush();
        const r = await recallAt(w, 'oneOnOne', ask);
        const wm = wmOf(r);
        assert.ok(wm.some((i) => i.id === pid(w, x.asked)), `回复的目标那一句在 ${show(wm)}`);
        assert.ok(!wm.some((i) => i.id === pid(w, x.between)), `紧挨在前面的别人那一句不带 ${show(wm)}`);
        // 没有回复目标时，紧挨在前面的就是那一句（对照）
        const ws = w.core.mods.retrieve.workingSet(w.core, { settingKey: w.keyOf('oneOnOne'), focusPerceptId: w.perceptOf(ask).id },
          { triggerEntityId: w.perceptOf(x.answer).actor_entity_id });
        assert.equal(ws.lines.find((l) => l.ref === pid(w, x.answer))?.repliedTo, pid(w, x.asked));
      } finally { await w.close(); }
    });
  }
});

test('D145：没有回复目标——中间只隔着她的话也算；他连着说的几句共用前面那一句；对她说的话不猜；隔得远了不带', async () => {
  const w = await world(SEEDS[0], 'wr-near');
  try {
    const asked = w.say('groupX', 'friend', ASKED, { addressed: 'ambient', attention: 'peripheral' });
    w.say('groupX', 'her', '好像是哦');
    const a1 = w.say('groupX', 'principal', '没做', { addressed: 'ambient', attention: 'attended' });
    const a2 = w.say('groupX', 'principal', '回头加上', { addressed: 'ambient', attention: 'attended' });
    const a3 = w.say('groupX', 'principal', '@她 你记一下', { addressed: 'mentions-her', attention: 'attended' });
    for (let i = 0; i < 5; i++) w.say('groupX', 'her', `嗯${i}`);
    const far = w.say('groupX', 'principal', '对了', { addressed: 'ambient', attention: 'attended' });
    w.clock.advance(MINUTE);
    const ask = w.say('oneOnOne', 'principal', ASK, { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    const ws = w.core.mods.retrieve.workingSet(w.core, { settingKey: w.keyOf('oneOnOne'), focusPerceptId: w.perceptOf(ask).id },
      { triggerEntityId: w.perceptOf(a1).actor_entity_id });
    const rt = (o) => ws.lines.find((l) => l.ref === pid(w, o))?.repliedTo ?? null;
    assert.equal(rt(a1), pid(w, asked), '隔着她的一句');
    assert.equal(rt(a2), pid(w, asked), '他连着说的第二句共用前面那一句');
    assert.equal(rt(a3), null, '对她说的话不猜');
    assert.equal(rt(far), null, `往前 ${w.core.config.get().recall.working.repliedScan} 条以内没有别人的话：不带`);
    assert.ok(ws.replied.some((x) => x.ref === pid(w, asked) && x.by.length >= 2), JSON.stringify(ws.replied));
  } finally { await w.close(); }
});
