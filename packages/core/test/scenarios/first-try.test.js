// 第一次就接得上（D106–D108，实测问题 #15；用户反馈第 8 轮）：「私聊里定规则、马上去群里玩」——主人：「真人可不会这样！」
// 她听到一句话的那一刻就知道它：感知落库，它就在工作记忆里；第一眼（glance）、提炼、第二段、审视都只管分寸，哪一个没做完、做失败、
// 被预算挡了，都不影响她知道。每个情形按 第一眼 {还没回来 / 看完 / 失败 / 预算不给} × 审视 {说 / 改口 / 挂了 / 被带偏} × 向量 {有 / 没有}
// 跑一遍，每一遍都看：规则原样在工作记忆里；第一段 A4 / A5；规则没送去第二段、提炼零次；回「21」零次审视。
// D113：没有说出口的档位——每条带来源标签（〔你们俩私聊时 · …〕〔在「群X」当着大家 · …〕）；非公开目标的关口②只剩外发守护
// （几乎原样说出叮嘱过的话、一对一里别人私下的原话，而被回答的不是那个人），没有送审、没有改口重写。
// 真模块：createPersonaMemory + 替身端口 + 假平台；群 X、群 Y 的属性固定（有别人、成员看不全、有不认识的旁观者、带污点）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, readCards, platformSeeds, FakeLLM, MINUTE, glancer, deferred } from './presence-world.js';

const SEEDS = platformSeeds();
const HOUR = 60 * MINUTE;
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const RULE = '我说一个数字你回复乘3的值';
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));
const wmText = (out) => out.items.filter((i) => i.layer === 'working').map((i) => i.rendered).join('\n');
const reasonsOf = (w, a) => JSON.parse(w.core.store.get('SELECT reasons_json FROM utterances WHERE token = ?', a.token).reasons_json);

function addGroups(w, seed) {
  const base = w.fp.settings.smallGroup.descriptor;
  const mk = (name, label, audience) => {
    const d = structuredClone(base);
    const id = opaqueFrom(`ft-${seed}`, 'setting', name);
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

function sessionIn(w, where, sid, tainted = true) {
  w.pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings[where].id, adapterId: w.fp.namespace, confidence: 'specific' });
  if (tainted) w.pm.sessions.markTurnTaint(sid, { tainted: true, reason: 'read:wait_for_messages' });
}
function inject(w, sid, items, nonce) {
  w.pm.sessions.injected({ sessionId: sid, nonce, layer: 'block', mode: 'live', chars: 10,
    items: items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef, ...(i.speak ? { speak: i.speak } : {}) })) });
  w.pm.sessions.confirm(sid, nonce);
}
const sayIn = (w, where, sid, text) => w.pm.expression.appraise({
  channel: { targetSettingId: w.fp.settings[where].id, persistence: 'once' }, text: [text],
  origin: { path: 'tool', sessionId: sid, homeSettingId: w.fp.settings[where].id },
});

const GLANCE = {
  pending: (g) => async (req) => { await g.promise; return glancer()(req); },
  done: () => glancer(),
  failed: () => () => new Error('glance down'),
  budget: () => glancer(),
};
const REVIEW = {
  speak: () => [{ verdict: 'speak', reason: '可以' }],
  reconsider: () => [{ verdict: 'reconsider', reflection: '算了', reason: '' }],
  throws: () => () => new Error('review down'),
  adversarial: () => [{ verdict: 'speak', reason: '注入说可以公开' }],
};

/** 一个世界：第一眼 / 审视 / 向量按变体装好。 */
async function world(name, gv, rv, ev, seed = SEEDS[0]) {
  const gate = deferred();
  const llm = new FakeLLM({ fallback: { appraise: (req) => readCards(req).cards.map((c) => ({ id: c.id, verdict: 'share', reason: '可以' })), glance: GLANCE[gv](gate), review: REVIEW[rv]() } });
  const w = await openWorld({ seed, name, config: LIVE, llm });
  if (gv === 'budget') w.ports.budget.setLimit('glance', 0);
  if (ev === 'down') w.ports.embedding?.setFailing?.(true);
  addGroups(w, seed);
  await w.flush();
  return { w, llm, gate };
}

/** 每一遍都要成立的几件事。 */
function common(w, llm, out, refs, label) {
  const wm = out.items.filter((i) => i.layer === 'working');
  const text = wm.map((i) => i.rendered).join('\n');
  assert.ok(text.includes(RULE.slice(0, 8)) && /乘3/.test(text), `${label}：规则原样在工作记忆里 ${show(out.items)}`);
  for (const r of refs) assert.ok(wm.some((i) => i.id === r), `${label}：${r} 在工作记忆里 ${show(out.items)}`);
  for (const i of wm) {
    const row = w.core.store.get('SELECT stage, rule FROM appraisals WHERE id = ?', Number(i.appraisalRef.slice(2)));
    // 到他自己在场过的地方（听的人都知道）第一段直接放行（A1a）；别处都是 A4 / A5
    assert.ok(row.stage === 1 && ['A4', 'A5', 'A1a', 'A1b'].includes(row.rule), `${label}：第一段 ${JSON.stringify(row)}`);
  }
  const cards = llm.callsFor('appraise').flatMap((c) => readCards(c).cards.map((x) => x.text)).join('\n');
  assert.ok(!cards.includes(RULE), `${label}：规则没送去第二段`);
  assert.equal(llm.callsFor('extract').length, 0, `${label}：提炼零次`);
}

test('M1：私聊定规则、她说「好」，群 Y（有别人、不认识的旁观者、带污点）「@她 7」——+2 秒、+10 秒、+1 分钟、+3 小时，每种变体第一次就接得上，「21」不审', async (t) => {
  for (const gv of Object.keys(GLANCE)) {
    for (const rv of Object.keys(REVIEW)) {
      for (const ev of ['ok', 'down']) {
        await t.test(`第一眼 ${gv} / 审视 ${rv} / 向量 ${ev}`, async () => {
          const { w, llm, gate } = await world(`ft-m1-${gv}-${rv}-${ev}`, gv, rv, ev);
          try {
            const rule = w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
            const ok = w.say('oneOnOne', 'her', '好', {}, 1000);
            await w.flush();
            if (gv !== 'pending') await w.core.mods.discretion.glancesIdle(w.core);
            const refs = [`p${w.perceptOf(rule).id}`, `p${w.perceptOf(ok).id}`];
            w.say('groupY', 'other', '晚上吃啥', { addressed: 'ambient', attention: 'peripheral' }, 500);
            w.say('groupY', 'stranger', '路过', { addressed: 'ambient', attention: 'peripheral' }, 500);
            let last = 0;
            for (const [k, dt] of [['2s', 0], ['10s', 8000], ['1min', MINUTE], ['3h', 3 * HOUR]]) {
              w.clock.advance(Math.max(0, dt - last));
              last = dt;
              const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
              await w.flush();
              const sid = `s-${k}`;
              sessionIn(w, 'groupY', sid);
              const out = await recallAt(w, 'groupY', seven, { sessionId: sid, deadlineMs: 800 });
              common(w, llm, out, refs, k);
              assert.match(wmText(out), /〔你们俩私聊时 · /, `${k}：带着「你们俩私聊时」的来源 ${show(out.items)}`);
              inject(w, sid, out.items, `n-${k}`);
              const r0 = llm.callsFor('review').length;
              const a = await sayIn(w, 'groupY', sid, '21');
              assert.equal(a.verdict, 'speak', `${k}：「21」照样说`);
              assert.equal(llm.callsFor('review').length, r0, `${k}：「21」零次审视`);
            }
          } finally { gate.resolve(); await w.close(); }
        });
      }
    }
  }
});

test('M2 / M3：群 X 定的规则——到和他的私聊「7」是 free；到群 Y 是 careful、带污点，「21」不审', async () => {
  for (const seed of SEEDS.slice(0, 3)) {
    const { w, llm, gate } = await world(`ft-m23-${seed}`, 'done', 'speak', 'ok', seed);
    try {
      w.say('groupX', 'friend', '今天谁值班', { addressed: 'ambient', attention: 'peripheral' });
      const rule = w.say('groupX', 'principal', `@她 ${RULE}`, { addressed: 'mentions-her', attention: 'attended' }, 3000);
      const ok = w.say('groupX', 'her', '好呀', {}, 3000);
      await w.flush();
      const refs = [`p${w.perceptOf(rule).id}`, `p${w.perceptOf(ok).id}`];
      const dm = w.say('oneOnOne', 'principal', '7', { addressed: 'to-her', attention: 'attended' }, 1000);
      await w.flush();
      let out = await recallAt(w, 'oneOnOne', dm, { deadlineMs: 800 });
      common(w, llm, out, refs, `M2 seed ${seed}`);
      assert.match(wmText(out), /在「群X」当着大家/, `M2：带着来源 ${show(out.items)}`);
      w.say('groupY', 'other', '晚上吃啥', { addressed: 'ambient', attention: 'peripheral' }, 500);
      const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
      await w.flush();
      sessionIn(w, 'groupY', 'sy');
      out = await recallAt(w, 'groupY', seven, { sessionId: 'sy', deadlineMs: 800 });
      common(w, llm, out, refs, `M3 seed ${seed}`);
      assert.match(wmText(out), /在「群X」当着大家/, `M3：带着来源 ${show(out.items)}`);
      inject(w, 'sy', out.items, 'n-y');
      const r0 = llm.callsFor('review').length;
      assert.equal((await sayIn(w, 'groupY', 'sy', '21')).verdict, 'speak');
      assert.equal(llm.callsFor('review').length, r0, 'M3：「21」不审');
    } finally { gate.resolve(); await w.close(); }
  }
});

test('M4：私聊「乘2」、群 X「乘3」、群 Y「7」——两条都在，新的在后；同一场合「不对改成乘3」带改过的标记（没有 5 分钟的提炼间隔）', async () => {
  const { w, llm, gate } = await world('ft-m4', 'done', 'speak', 'ok');
  try {
    const r2 = w.say('oneOnOne', 'principal', '我说一个数字你回复乘2的值', { addressed: 'to-her', attention: 'attended' }, 2000);
    w.say('oneOnOne', 'her', '好', {}, 2000);
    w.clock.advance(MINUTE);
    const r3 = w.say('groupX', 'principal', `@她 ${RULE}`, { addressed: 'mentions-her', attention: 'attended' }, 2000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    sessionIn(w, 'groupY', 's4');
    const out = await recallAt(w, 'groupY', seven, { sessionId: 's4', deadlineMs: 800 });
    const ids = out.items.filter((i) => i.layer === 'working').map((i) => i.id);
    const a = ids.indexOf(`p${w.perceptOf(r2).id}`);
    const b = ids.indexOf(`p${w.perceptOf(r3).id}`);
    assert.ok(a >= 0 && b >= 0 && a < b, `两条都在，新的在后 ${show(out.items)}`);
    // 同一场合改规则
    const x1 = w.say('groupX', 'principal', '@她 我说一个数字你回复乘2', { addressed: 'mentions-her', attention: 'attended' }, 2000);
    w.say('groupX', 'her', '好', {}, 2000);
    const x2 = w.say('groupX', 'principal', '@她 不对，改成乘5', { addressed: 'mentions-her', attention: 'attended' }, 2000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const g = w.core.mods.discretion.glancesOf(w.core, [w.perceptOf(x2).id]).get(w.perceptOf(x2).id);
    assert.equal(g?.replaces, w.perceptOf(x1).id, '第一眼核对过：改掉了前面那条');
    const eight = w.say('groupY', 'principal', '@她 8', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    const out2 = await recallAt(w, 'groupY', eight, { sessionId: 's4b', deadlineMs: 800 });
    const txt = out2.items.filter((i) => i.layer === 'working').map((i) => i.rendered).join('\n');
    // D110：改过的规则是「他最近一次跟你定的」，带「改掉了他之前定的那条」；被改掉的那一句作为它自己的一条，带「后来改了」
    assert.match(txt, /改成乘5（他最近一次跟你定的）（改掉了他之前定的那条）/, txt);
    assert.match(txt, /乘2（后来改了）/, txt);
    assert.equal(llm.callsFor('extract').length, 0);
  } finally { gate.resolve(); await w.close(); }
});

test('M5：「7」的各种说法、规则里叫她的各种说法——不带空格、群名片不带 @、两个 @：规则照样在', async () => {
  const { w, gate } = await world('ft-m5', 'done', 'speak', 'ok');
  try {
    const card = '星野小满';
    // 她在群 X 里用这个群名片说过话（适配器把她的群名片记成她的名字，D108）
    w.fp.people.her.actor.claims.push({ kind: 'display-name', name: card, scope: w.fp.settings.groupX.id, observedAt: w.clock.now() });
    w.say('groupX', 'her', '大家好', {}, 1000);
    const at = w.clock.now();
    const m = [{ claims: [{ kind: 'display-name', name: card, scope: w.fp.settings.groupX.id, observedAt: at }] }];
    const rules = [
      w.say('groupX', 'principal', `@${card}陪我玩 ${RULE}`, { addressed: 'mentions-her', attention: 'attended', mentions: m }, 1000),
      w.say('groupX', 'principal', `${card} ${RULE}`, { addressed: 'mentions-her', attention: 'attended' }, 1000),
      w.say('groupX', 'principal', `@${card} @${card} ${RULE}`, { addressed: 'mentions-her', attention: 'attended', mentions: [...m, ...m] }, 1000),
    ];
    await w.flush();
    const ghosts = w.core.store.all("SELECT e.id FROM entities e JOIN entity_names n ON n.entity_id = e.id WHERE e.is_self = 0 AND e.status <> 'retracted' AND n.text_raw = ?", card);
    assert.equal(ghosts.length, 0, '她的群名片没有被认成别的人');
    // 还没撤掉的旧假人（和她同一个名片）：同一处名字也认得出是她，那一处就是在叫她，不算「点了别人」（评审）
    const E = w.core.mods.entities;
    const g = Number(w.core.store.run("INSERT INTO entities(kind, status, individual, created_at, updated_at) VALUES ('person', 'established', 1, ?, ?)", at, at).lastInsertRowid);
    w.core.store.run("INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, first, last) VALUES (?, ?, ?, '', 'card', ?, ?)", g, card, E.normalizeName(card), at, at);
    E.invalidateNames(w.core);
    for (const [k, text] of [['bare', '7'], ['nospace', '@她7'], ['card', `${card} 7`]]) {
      const seven = w.say('groupY', 'principal', text, { addressed: 'mentions-her', attention: 'attended' }, 500);
      await w.flush();
      const out = await recallAt(w, 'groupY', seven, { deadlineMs: 800 });
      const ids = out.items.filter((i) => i.layer === 'working').map((i) => i.id);
      for (const r of rules) assert.ok(ids.includes(`p${w.perceptOf(r).id}`), `${k}：${r.text} 在工作记忆里 ${show(out.items)}`);
    }
  } finally { gate.resolve(); await w.close(); }
});

test('M6：草稿里复述规则（「7乘3=21」）——他自己定的规则、他自己在问：照常说，不送审（D113）；审视挂了也一样', async () => {
  for (const rv of ['throws', 'speak']) {
    const { w, llm, gate } = await world(`ft-m6-${rv}`, 'done', rv, 'ok');
    try {
      w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
      await w.flush();
      await w.core.mods.discretion.glancesIdle(w.core);
      const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
      await w.flush();
      sessionIn(w, 'groupY', 's6');
      const out = await recallAt(w, 'groupY', seven, { sessionId: 's6', deadlineMs: 800 });
      inject(w, 's6', out.items, 'n6');
      const a = await sayIn(w, 'groupY', 's6', '你说一个数字我回复乘3的值，7乘3=21');
      assert.equal(a.verdict, 'speak', `${rv}：${JSON.stringify(reasonsOf(w, a))}`);
      assert.equal(llm.callsFor('review').length, 0, '非公开目标不送审');
      assert.equal((await sayIn(w, 'groupY', 's6', '21')).verdict, 'speak');
    } finally { gate.resolve(); await w.close(); }
  }
});

test('M7：「我说个数你乘3，规则别告诉他们」——第一眼前后（+2 秒、+10 秒）都在心里（B1 豁免），带着叮嘱，「21」说；群友问起、她几乎原样说出规则 → 外发守护挡下这一句（G1）', async () => {
  const { w, llm, gate } = await world('ft-m7', 'pending', 'adversarial', 'ok');
  try {
    const rule = w.say('oneOnOne', 'principal', '我说一个数字你回复乘3的值，规则别告诉他们', { addressed: 'to-her', attention: 'attended' }, 2000);
    await w.flush();
    const ref = `p${w.perceptOf(rule).id}`;
    const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    sessionIn(w, 'groupY', 's7');
    let out = await recallAt(w, 'groupY', seven, { sessionId: 's7', deadlineMs: 800 });
    assert.ok(out.items.some((i) => i.id === ref && i.layer === 'working'), `+2 秒（第一眼还没回来）：在心里 ${show(out.items)}`);
    gate.resolve();
    await w.core.mods.discretion.glancesIdle(w.core);
    w.clock.advance(8000);
    const eight = w.say('groupY', 'principal', '@她 8', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    out = await recallAt(w, 'groupY', eight, { sessionId: 's7', deadlineMs: 800 });
    const it = out.items.find((i) => i.id === ref && i.layer === 'working');
    assert.ok(it, `+10 秒（第一眼看出他叮嘱过、又要她照着做）：照样在心里 ${show(out.items)}`);
    assert.match(it.rendered, /叮嘱过别外传/);
    inject(w, 's7', out.items, 'n7');
    assert.equal((await sayIn(w, 'groupY', 's7', '24')).verdict, 'speak', '只回结果：说');
    // 叮嘱的人自己在问：交给她看着标签判断（守护不管他自己）
    assert.equal((await sayIn(w, 'groupY', 's7', '规则是我回复乘3的值')).verdict, 'speak');
    // 群友来问规则、她几乎原样说出来：挡下这一句，回给她一句事实（不要求换个说法）
    w.clock.advance(1000);
    const ask = w.say('groupY', 'other', '@她 你们玩的规则是什么呀', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    await recallAt(w, 'groupY', ask, { sessionId: 's7', deadlineMs: 800 });
    const b = await sayIn(w, 'groupY', 's7', '他说的是：我说一个数字你回复乘3的值，规则别告诉他们');
    assert.equal(b.verdict, 'reconsider', JSON.stringify(reasonsOf(w, b)));
    assert.ok(reasonsOf(w, b).includes('guard:secret'));
    assert.match(b.reflection, /^这句没发：里面几乎是.+叮嘱过别外传的原话。这件不说，别的照常说。$/);
    assert.doesNotMatch(b.reflection, /换个说法/);
    assert.equal(llm.callsFor('review').length, 0, '不送审');
    assert.equal((await sayIn(w, 'groupY', 's7', '这是我们俩的小游戏，不告诉你～')).verdict, 'speak', '别的照常说');
  } finally { gate.resolve(); await w.close(); }
});

test('M8：玩了 8 轮再换地方——定规则的那一句是这一段的锚点，照样在', async () => {
  const { w, gate } = await world('ft-m8', 'done', 'speak', 'ok');
  try {
    const rule = w.say('groupX', 'principal', `@她 ${RULE}`, { addressed: 'mentions-her', attention: 'attended' }, 2000);
    w.say('groupX', 'her', '好呀', {}, 2000);
    for (let i = 1; i <= 8; i++) {
      w.say('groupX', 'principal', String(i + 10), { addressed: 'ambient', attention: 'attended' }, 2000);
      w.say('groupX', 'her', String((i + 10) * 3), {}, 2000);
    }
    await w.flush();
    const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    const out = await recallAt(w, 'groupY', seven, { deadlineMs: 800 });
    assert.ok(out.items.some((i) => i.layer === 'working' && i.id === `p${w.perceptOf(rule).id}`), `开头那句在 ${show(out.items)}`);
  } finally { gate.resolve(); await w.close(); }
});

test('M9 / M10：一批里主人和别人都在对她说话——两个触发者，规则照样在；焦点找不到时退回最后一条别人对她说的话，不是她自己的话', async () => {
  const { w, gate } = await world('ft-m9', 'done', 'speak', 'ok');
  try {
    const rule = w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
    await w.flush();
    const ref = `p${w.perceptOf(rule).id}`;
    const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
    const other = w.say('groupY', 'other', '@她 你在干嘛', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    // M9：主触发者是后说话的群员，主人那条在 focusObsIds 里
    sessionIn(w, 'groupY', 's9', false);
    const out = await w.pm.recall({ settingId: w.fp.settings.groupY.id, focusObsId: other.id, focusObsIds: [seven.id], trigger: 'message', sessionId: 's9' },
      { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 });
    assert.ok(out.items.some((i) => i.layer === 'working' && i.id === ref), `两个触发者：规则在 ${show(out.items)}`);
    const info = w.core.mods.context.sessionInfo(w.core, 's9');
    assert.deepEqual(info.triggerEntityIds, [w.perceptOf(other).actor_entity_id, w.perceptOf(seven).actor_entity_id], '关口②看得到两个触发者（主触发者在前）');
    // M10：她刚回了一句（最后一条是她自己的），交进来的焦点又对不上
    w.say('groupY', 'her', '在呢', {}, 500);
    await w.flush();
    sessionIn(w, 'groupY', 's10', false);
    await w.pm.recall({ settingId: w.fp.settings.groupY.id, focusObsId: 'no-such-obs', trigger: 'message', sessionId: 's10' }, { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 });
    const t10 = w.core.mods.context.sessionInfo(w.core, 's10').triggerEntityIds;
    assert.deepEqual(t10, [w.perceptOf(other).actor_entity_id], '退回最后一条别人对她说的话：触发者是那个群员，不是 null');
    assert.ok(Number(w.core.store.get("SELECT SUM(value) AS v FROM metrics WHERE name = 'context.focus.fallback'")?.v ?? 0) >= 1);
  } finally { gate.resolve(); await w.close(); }
});

// ── 评审之后（D106–D108 评审）────────────────────────────────────────────────

test('M7b：规则和叮嘱分两句（「我说一个数字你回复乘3的值」「别告诉他们规则哈」，后一句本身不要她做什么）——第一眼前后两句都在心里；规则那句也收紧了，群友问起时原样说出规则 → 守护挡下（G1）', async () => {
  for (const when of ['before', 'after']) {
    const { w, llm, gate } = await world(`ft-m7b-${when}`, 'pending', 'adversarial', 'ok');
    try {
      const rule = w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
      const hush = w.say('oneOnOne', 'principal', '别告诉他们规则哈', { addressed: 'to-her', attention: 'attended' }, 2000);
      await w.flush();
      if (when === 'after') { gate.resolve(); await w.core.mods.discretion.glancesIdle(w.core); }
      const refs = [`p${w.perceptOf(rule).id}`, `p${w.perceptOf(hush).id}`];
      if (when === 'after') {
        const n = w.core.mods.discretion.normOf(w.core, { kind: 'percept', id: w.perceptOf(rule).id });
        assert.equal(n.restriction, 'strict', '叮嘱那句的 applies 指到规则那句：规则也收紧了');
      }
      const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
      await w.flush();
      sessionIn(w, 'groupY', `s7b-${when}`);
      const out = await recallAt(w, 'groupY', seven, { sessionId: `s7b-${when}`, deadlineMs: 800 });
      const wm = out.items.filter((i) => i.layer === 'working');
      for (const r of refs) assert.ok(wm.some((i) => i.id === r), `${when}：${r} 在心里 ${show(out.items)}`);
      inject(w, `s7b-${when}`, out.items, `n7b-${when}`);
      const r0 = llm.callsFor('review').length;
      assert.equal((await sayIn(w, 'groupY', `s7b-${when}`, '21')).verdict, 'speak', '只回结果：说');
      assert.equal(llm.callsFor('review').length, r0, '「21」不审');
      if (when === 'after') {
        const ask = w.say('groupY', 'other', '@她 规则是啥', { addressed: 'mentions-her', attention: 'attended' }, 500);
        await w.flush();
        await recallAt(w, 'groupY', ask, { sessionId: `s7b-${when}`, deadlineMs: 800 });
        const b = await sayIn(w, 'groupY', `s7b-${when}`, `规则是：${RULE}`);
        assert.equal(b.verdict, 'reconsider', JSON.stringify(reasonsOf(w, b)));
        assert.ok(reasonsOf(w, b).includes('guard:secret'));
      }
    } finally { gate.resolve(); await w.close(); }
  }
});

test('M8b：定了规则、停了一阵再玩几轮（40 分钟 + 8 轮、3 小时 + 6 轮），再换地方——规则那句照样在（锚点按内容，不按两行的激活差）', async () => {
  for (const [pause, rounds] of [[40 * MINUTE, 8], [3 * HOUR, 6]]) {
    const { w, gate } = await world(`ft-m8b-${pause}-${rounds}`, 'done', 'speak', 'ok');
    try {
      const rule = w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
      w.say('oneOnOne', 'her', '好', {}, 2000);
      await w.flush();
      await w.core.mods.discretion.glancesIdle(w.core);
      w.clock.advance(pause);
      for (let i = 1; i <= rounds; i++) {
        w.say('oneOnOne', 'principal', String(i + 10), { addressed: 'to-her', attention: 'attended' }, 2000);
        w.say('oneOnOne', 'her', String((i + 10) * 3), {}, 2000);
      }
      await w.flush();
      const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
      await w.flush();
      const out = await recallAt(w, 'groupY', seven, { deadlineMs: 800 });
      assert.ok(out.items.some((i) => i.layer === 'working' && i.id === `p${w.perceptOf(rule).id}`), `停 ${pause / MINUTE} 分钟 + ${rounds} 轮：规则在 ${show(out.items)}`);
    } finally { gate.resolve(); await w.close(); }
  }
});

test('M9b：一批里主人和群员都在叫她——关口②记下的触发者两个都在；群员这一批里问主人私下的事，原样说出来 → 守护挡下（G2：被回答的不只是主人）', async () => {
  const { w, gate } = await world('ft-m9b', 'done', 'adversarial', 'ok');
  try {
    const h = w.say('oneOnOne', 'principal', '我体检结果出来了，血糖偏高', { addressed: 'to-her', attention: 'attended' }, 2000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
    const ask = w.say('groupY', 'other', '@她 你主人身体怎么样', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    sessionIn(w, 'groupY', 's9b');
    const out = await w.pm.recall({ settingId: w.fp.settings.groupY.id, focusObsId: ask.id, focusObsIds: [seven.id], trigger: 'message', sessionId: 's9b' },
      { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 });
    const info = w.core.mods.context.sessionInfo(w.core, 's9b');
    assert.deepEqual([...info.triggerEntityIds].sort(), [w.perceptOf(seven).actor_entity_id, w.perceptOf(ask).actor_entity_id].sort(), '两个触发者都记下了');
    inject(w, 's9b', out.items, 'n9b');
    if (out.items.some((i) => i.id === `p${w.perceptOf(h).id}`)) {
      const a = await sayIn(w, 'groupY', 's9b', '他说：我体检结果出来了，血糖偏高');
      assert.equal(a.verdict, 'reconsider', JSON.stringify(reasonsOf(w, a)));
      assert.ok(reasonsOf(w, a).includes('guard:relay'));
      assert.match(a.reflection, /^这句没发：里面几乎是.+私下跟你说的原话。$/);
    }
    assert.equal((await sayIn(w, 'groupY', 's9b', '21')).verdict, 'speak');
  } finally { gate.resolve(); await w.close(); }
});

test('M11：私聊里先玩过一轮（「7」→「21」），到群 Y 再「@她 7」——又回「21」不审；审视挂了也照样说；换一个会话也不被「同一句话被拒过」挡', async () => {
  for (const rv of ['speak', 'throws']) {
    const { w, llm, gate } = await world(`ft-m11-${rv}`, 'done', rv, 'ok');
    try {
      w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
      w.say('oneOnOne', 'her', '好', {}, 2000);
      w.say('oneOnOne', 'principal', '7', { addressed: 'to-her', attention: 'attended' }, 2000);
      w.say('oneOnOne', 'her', '21', {}, 2000);
      await w.flush();
      await w.core.mods.discretion.glancesIdle(w.core);
      for (const sid of ['s11a', 's11b']) {
        const seven = w.say('groupY', 'principal', '@她 7', { addressed: 'mentions-her', attention: 'attended' }, 500);
        await w.flush();
        sessionIn(w, 'groupY', sid);
        const out = await recallAt(w, 'groupY', seven, { sessionId: sid, deadlineMs: 800 });
        inject(w, sid, out.items, `n-${sid}`);
        const r0 = llm.callsFor('review').length;
        const a = await sayIn(w, 'groupY', sid, '21');
        assert.equal(a.verdict, 'speak', `${rv} / ${sid}：${JSON.stringify(JSON.parse(w.core.store.get('SELECT reasons_json FROM utterances WHERE token = ?', a.token).reasons_json))}`);
        assert.equal(llm.callsFor('review').length, r0, '又说了一遍她说过的答案：不审');
        w.say('groupY', 'her', '21', {}, 500);
        await w.flush();
      }
    } finally { gate.resolve(); await w.close(); }
  }
});

test('M12：第一眼失败过的私聊原话——被想起时重新排上（不必等那个私聊再来一句）；看没看完都在心里', async () => {
  let fail = true;
  const llm = new FakeLLM({ fallback: { appraise: (req) => readCards(req).cards.map((c) => ({ id: c.id, verdict: 'share', reason: '可以' })),
    glance: (req) => (fail ? new Error('glance down') : glancer()(req)), review: [{ verdict: 'speak', reason: '' }] } });
  const w = await openWorld({ seed: SEEDS[0], name: 'ft-m12', config: LIVE, llm });
  addGroups(w, SEEDS[0]);
  await w.flush();
  try {
    const rule = w.say('oneOnOne', 'principal', RULE, { addressed: 'to-her', attention: 'attended' }, 2000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const id = w.perceptOf(rule).id;
    assert.equal(w.core.mods.discretion.glancesOf(w.core, [id]).get(id).state, 'failed');
    fail = false;
    for (let k = 0; k < 4 && w.core.mods.discretion.glancesOf(w.core, [id]).get(id).state !== 'done'; k++) {
      const seven = w.say('groupY', 'principal', `@她 ${7 + k}`, { addressed: 'mentions-her', attention: 'attended' }, 500);
      await w.flush();
      const out = await recallAt(w, 'groupY', seven, { sessionId: `s12-${k}`, deadlineMs: 800 });
      await w.core.mods.discretion.glancesIdle(w.core);
      assert.ok(out.items.some((i) => i.id === `p${id}` && i.layer === 'working'), `第 ${k + 1} 次：规则在心里`);
    }
    assert.equal(w.core.mods.discretion.glancesOf(w.core, [id]).get(id).state, 'done', '被想起时重新看了');
  } finally { await w.close(); }
});
