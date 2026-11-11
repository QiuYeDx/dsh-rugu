// 「跟他现在定的是什么」整件在心里（D110，实测问题 #18；用户反馈第 9 轮）：主人在一个群里说「玩个游戏 我说一个数字 你回复²值」、
// 她接了、他报「99」、她答「9801」，一分钟后到另一个群「@她 111」——她心里要有完整的这一段（他定的、她接的、最近的一问一答），知道这是
// 他最近一次跟她定的、改掉了更早的「乘3」，第一次就答 12321；晚上还没办的两件提醒不能丢，但一件一行，不刷屏。
// 真模块：createPersonaMemory + 替身端口 + 假平台；第一眼用替身（词表只在这个替身里：真模型自己看），第二段、提炼一调用就报错。
// 第一眼按 glance-2 看完 / glance-1 的旧行 / 还在看 / 看失败 各跑一遍。不认任何词、没有时间窗：段按内容和结构切，预算是软的条数和字数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, readGlanceCard, readCards, FakeLLM, MINUTE, deferred } from './presence-world.js';

const HOUR = 60 * MINUTE;
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const SEED = 101;
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.unitKey ?? '-', i.speak ?? '-', i.rendered]), null, 1);
const wmOf = (out) => out.items.filter((i) => i.layer === 'working');
const charLen = (s) => Array.from(String(s)).length;

function addGroups(w) {
  const base = w.fp.settings.smallGroup.descriptor;
  const mk = (name, label, audience) => {
    const d = structuredClone(base);
    const id = opaqueFrom(`ct-${SEED}`, 'setting', name);
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

/**
 * 第一眼的替身（一个听话的人第一眼的样子；用词判断只在这里）：定玩法的那句是 asks，改掉了他前面最近的一句玩法（replaces）；
 * 只报一个数的是照着最近那句玩法的一步（follows）；她接下来的话是 asks；身体这类事敏感。judge(行, 卡片) 返回的字段覆盖默认值。
 */
function glance(judge = () => ({}), seen = []) {
  return (req) => {
    const card = readGlanceCard(req);
    seen.push(card);
    return card.targets.map((t) => {
      const his = t.who === '他';
      const rule = his && /乘\d|²|平方/.test(t.text);
      const step = his && /^\s*(@她\s*)?\d+\s*$/.test(t.text);
      const lastRule = [...card.lines].reverse().find((x) => x.i < t.i && x.who === '他' && /乘\d|²|平方/.test(x.text));
      const sens = /体检|血糖/.test(t.text) ? 0.8 : 0.05;
      return {
        i: t.i, sens, limit: 'none', quote: '', about: /阿明|同事/.test(t.text) ? 'others' : t.who === '你' ? 'both' : 'speaker',
        asks: rule || step || /提醒/.test(t.text) || (!his && /报数|考我|放马|来吧/.test(t.text)),
        gist: t.text.slice(0, 20), vague: sens >= 0.5 ? '他最近有点自己的事' : '一件平常的事',
        replaces: rule && lastRule ? lastRule.i : null, follows: step && lastRule ? lastRule.i : null, applies: [], ...judge(t, card),
      };
    });
  };
}

/** 一个世界：第一眼按变体装好；第二段、提炼、审视一调用就报错。 */
async function world(name, variant = 'v2', { judge, seen = [], config = {} } = {}) {
  const gate = deferred();
  const g = glance(judge, seen);
  const glanceFn = variant === 'pending' ? async (req) => { await gate.promise; return g(req); } : variant === 'failed' ? () => new Error('glance down') : g;
  const llm = new FakeLLM({ fallback: { appraise: new Error('no stage2'), extract: new Error('no extract'), review: new Error('review down'), glance: glanceFn } });
  const w = await openWorld({ seed: SEED, name, config: { ...LIVE, ...config }, llm });
  addGroups(w);
  await w.flush();
  return { w, llm, gate, seen, variant };
}

/** 第一眼看完（或者故意没看完）：glance-1 的旧行把 follows / replaces 去掉、版本记成 glance-1。 */
async function settle(x) {
  await x.w.flush();
  if (x.variant === 'pending') return;
  await x.w.core.mods.discretion.glancesIdle(x.w.core);
  if (x.variant === 'v1') x.w.core.store.run("UPDATE glances SET prompt_ver = 'glance-1:old', follows = NULL, replaces = NULL");
}

const say = (w, where, who, text, gap = 15_000, extra = {}) => {
  const addressed = who === 'principal' && /^@她/.test(text) ? 'mentions-her' : who === 'principal' && where === 'oneOnOne' ? 'to-her' : 'ambient';
  const o = w.say(where, who, text, who === 'her' ? { ...extra } : { addressed, attention: 'attended', ...extra }, gap);
  return lazy(w, o);
};
/** 感知行（落库以后第一次读到就记住；在 flush / settle 之后读）。 */
function lazy(w, o) {
  let row = null;
  const get = () => (row ??= w.perceptOf(o) ?? null);
  return new Proxy({}, { get: (_, k) => get()?.[k] });
}
const sayO = (w, where, who, text, gap = 15_000) => {
  const addressed = who === 'principal' && /^@她/.test(text) ? 'mentions-her' : who === 'principal' && where === 'oneOnOne' ? 'to-her' : 'ambient';
  return w.say(where, who, text, who === 'her' ? {} : { addressed, attention: 'attended' }, gap);
};

function intention(w, owner, text, srcIds, dueIn) {
  const at = w.clock.now();
  return w.core.mods.encode.formIntention(w.core, {
    about: null, targetEntityId: owner, act: text, text, origin: 'principal-request',
    trigger: { timeWindow: { start: at + dueIn, end: at + dueIn + 10 * MINUTE }, cues: [{ entity: owner }] }, evidencePerceptIds: srcIds,
  }, { at });
}

/** 18:03 的样子：上午群 X「乘3」玩了一轮；下午群 Y 说过一句提醒，私聊里定了两件 8 点的提醒；傍晚群 X「²」玩了一轮；一分钟后群 Y「@她 111」。 */
async function scene(x) {
  const { w } = x;
  const p = {};
  say(w, 'groupX', 'friend', '今天谁值班');
  p.r3 = say(w, 'groupX', 'principal', '@她 陪我玩个游戏 我说一个数字 你就回复这个数字乘3的值', 10_000);
  p.r3ok = say(w, 'groupX', 'her', '乘三也来，放马过来', 7000);
  p.six = say(w, 'groupX', 'principal', '6', 15_000);
  p.r18 = say(w, 'groupX', 'her', '18', 20_000);
  await settle(x);
  w.clock.advance(6 * HOUR);
  p.here = say(w, 'groupY', 'principal', '@她 晚上八点提醒我排查一下看动图的问题', 20_000);
  say(w, 'groupY', 'her', '八点，记下了', 30_000);
  p.rA = say(w, 'oneOnOne', 'principal', '8点提醒我处理里面提到的问题', 10_000);
  say(w, 'oneOnOne', 'her', '八点的闹钟定好了，到点我准时敲你', 1000);
  say(w, 'oneOnOne', 'her', '要提醒的就是看动图那个问题吧？我按这个记了', 15_000);
  p.rB = say(w, 'oneOnOne', 'principal', '另外还有个问题就是在群聊里不能给你设置定时任务的问题 也得提醒我处理一下', 10_000);
  say(w, 'oneOnOne', 'her', '卡带没到就先眼馋着吧', 15_000);
  p.rC = say(w, 'oneOnOne', 'principal', '还有这个问题 8点的时候一并提醒我', 15_000);
  say(w, 'oneOnOne', 'her', '改好了，八点一口气提醒你两件事', 1000);
  say(w, 'oneOnOne', 'her', '看动图那个，还有群里设不了定时任务那个', 15_000);
  say(w, 'oneOnOne', 'principal', '好', 15_000);
  say(w, 'oneOnOne', 'her', '那我趴着去了，你忙吧', 10_000);
  await settle(x);
  const owner = p.rA.actor_entity_id;
  p.owner = owner;
  p.i1 = intention(w, owner, '八点提醒他处理转发消息里的问题', [p.rA.id], 160 * MINUTE);
  p.i2 = intention(w, owner, '八点也提醒他群里设不了定时任务那件事', [p.rB.id, p.rC.id], 165 * MINUTE);
  assert.ok(p.i1 && p.i2 && p.i1 !== p.i2, '两件提醒都形成了意图');
  w.clock.advance(40 * MINUTE);
  say(w, 'groupX', 'friend', '晚上吃啥', 20_000);
  p.sq = say(w, 'groupX', 'principal', '@她 玩个游戏 我说一个数字 你回复²值', 16_000);
  p.acc1 = say(w, 'groupX', 'her', '又要考我？行吧', 1000);
  p.acc2 = say(w, 'groupX', 'her', '报数，我算给你看', 3000);
  p.n99 = say(w, 'groupX', 'principal', '99', 20_000);
  p.ans = say(w, 'groupX', 'her', '9801', 20_000);
  await settle(x);
  w.say('groupY', 'other', '有人吗', { addressed: 'ambient', attention: 'peripheral' }, 5000);
  return p;
}

function sessionIn(w, where, sid) {
  w.pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings[where].id, adapterId: w.fp.namespace, confidence: 'specific' });
  w.pm.sessions.markTurnTaint(sid, { tainted: true, reason: 'read:wait_for_messages' });
}
function inject(w, sid, items, nonce) {
  w.pm.sessions.injected({ sessionId: sid, nonce, layer: 'block', mode: 'live', chars: 10,
    items: items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef, ...(i.speak ? { speak: i.speak } : {}),
      ...(i.unit ? { unit: i.unit } : {}), ...(i.unitKey ? { unitKey: i.unitKey } : {}) })) });
  w.pm.sessions.confirm(sid, nonce);
}
const sayIn = (w, where, sid, text) => w.pm.expression.appraise({
  channel: { targetSettingId: w.fp.settings[where].id, persistence: 'once' }, text: [text],
  origin: { path: 'tool', sessionId: sid, homeSettingId: w.fp.settings[where].id },
});

async function ask(w, where, text, sid) {
  const o = sayO(w, where, 'principal', text, 7000);
  await w.flush();
  sessionIn(w, where, sid);
  return recallAt(w, where, o, { sessionId: sid, deadlineMs: 800 });
}

const renderBlock = async (items, maxChars) => (await import(new URL('../../../dsh/src/host/render.js', import.meta.url))).renderBlock(items, { maxChars });

test('R1（= M13，18:03 原样）：第一眼 glance-2 / glance-1 旧行 / 还在看 / 失败——这一段完整、是最近一次定的、比这里说过的都晚；提醒一件一行；「12321」不审', async (t) => {
  for (const variant of ['v2', 'v1', 'pending', 'failed']) {
    await t.test(variant, async () => {
      const x = await world(`ct-r1-${variant}`, variant);
      const { w, llm } = x;
      try {
        const p = await scene(x);
        const out = await ask(w, 'groupY', '@她 111', `s-r1-${variant}`);
        const wm = wmOf(out);
        const by = new Map(wm.map((i) => [i.id, i]));
        const cur = [p.sq, p.acc1, p.acc2, p.n99, p.ans].map((r) => `p${r.id}`);
        for (const r of cur) assert.ok(by.has(r), `${variant}：${r} 在工作记忆里 ${show(wm)}`);
        const groups = new Set(cur.map((r) => by.get(r).group));
        assert.equal(groups.size, 1, `${variant}：同一组 ${show(wm)}`);
        const g = wm.filter((i) => i.group === [...groups][0]);
        assert.match(g[0].rendered, /比他在这里跟你说过的都晚/, `${variant}：段头 ${show(g)}`);
        assert.match(by.get(cur[0]).rendered, /（他最近一次跟你定的）/, `${variant}：根 ${show(g)}`);
        assert.equal(wm.at(-1).group, g[0].group, `${variant}：「现在这件」在最后（离她要回的那句话最近）`);
        if (variant === 'v2') {
          const gl = w.core.mods.discretion.glancesOf(w.core, [p.sq.id, p.n99.id]);
          assert.equal(gl.get(p.sq.id).replaces, p.r3.id, '第一眼：² 改掉了乘3（「他更早跟你说过的」里看得到）');
          assert.equal(gl.get(p.n99.id).follows, p.sq.id, '第一眼：99 是照着 ² 的一步');
          assert.match(by.get(cur[0]).rendered, /（改掉了他之前定的那条）/);
          assert.match(by.get(`p${p.r3.id}`)?.rendered ?? '', /乘3.*后来改了/, `乘3 作为它自己的一条：后来改了 ${show(wm)}`);
          // 被改掉的那一串剩下的一问一答（「6 / 18」）不在别的段里不带标记地出现（评审）
          for (const r of [p.r3ok, p.six, p.r18]) {
            const it = by.get(`p${r.id}`);
            assert.ok(!it || it.group === g[0].group, `旧玩法的一问一答不单独出现 ${show(wm)}`);
          }
        }
        // 提醒：两件各一行（他的一句来源原话），私聊里她的那几句回话不逐行出现
        const open = wm.filter((i) => i.unit === 'open');
        assert.equal(open.length, 2, `${variant}：两件提醒各一行 ${show(wm)}`);
        assert.match(open[0].rendered, /他托你的，还没办（2 件；还有约 \d+ 小时到点）/, show(open));
        assert.ok(!wm.some((i) => /闹钟定好了|一口气提醒你两件事|卡带没到/.test(i.rendered)), `${variant}：她回那几件事的话不逐行出现 ${show(wm)}`);
        assert.ok(wm.length <= 12, `${variant}：行数 ${wm.length}`);
        assert.ok(wm.reduce((n, i) => n + charLen(i.rendered), 0) <= 800, `${variant}：字数`);
        const block = await renderBlock(out.items, 1400);
        for (const r of cur) assert.ok(block.used.some((i) => i.id === r), `${variant}：renderBlock(1400) 之后这一段完整`);
        assert.match(block.text, /以他最新的说法为准/, '用法说明');
        // 工作记忆这一路第二段 0 次：这一段和两件提醒都没作为「记忆内容」送去第二段（普通回想照常可能把别的话送去、卡片上附前后几句，那是另一路）
        const cards = llm.callsFor('appraise').flatMap((c) => readCards(c).cards.map((k) => k.text.match(/<<<记忆内容\n([\s\S]*?)\n记忆内容>>>/)?.[1] ?? '')).join('\n');
        for (const s of ['²值', '9801', '报数', '8点提醒我处理', '设置定时任务']) assert.ok(!cards.includes(s), `${variant}：「${s}」没送去第二段 ${cards}`);
        assert.equal(llm.callsFor('extract').length, 0, '提炼 0 次');
        // 关口②：「12321」clear，不审
        inject(w, `s-r1-${variant}`, out.items, `n-r1-${variant}`);
        const r0 = llm.callsFor('review').length;
        const a = await sayIn(w, 'groupY', `s-r1-${variant}`, '12321');
        assert.equal(a.verdict, 'speak', `${variant}：「12321」照样说`);
        assert.equal(llm.callsFor('review').length, r0, `${variant}：零次审视`);
        // 注入日志带段
        const row = w.core.store.get("SELECT items_json FROM injections WHERE nonce = ?", `n-r1-${variant}`);
        assert.ok(JSON.parse(row.items_json).some((i) => i.unit === 'thread' && /^thread:/.test(i.unitKey)), 'items_json 带 unit / unitKey');
      } finally { x.gate.resolve(); await w.close(); }
    });
  }
});

test('R2：同一个群里 ×2 → ×3——×3 是最近一次定的，×2 后来改了', async () => {
  const x = await world('ct-r2');
  const { w } = x;
  try {
    const r2 = say(w, 'groupX', 'principal', '@她 我说一个数字你回复乘2的值', 5000);
    say(w, 'groupX', 'her', '好呀', 5000);
    say(w, 'groupX', 'principal', '9', 5000);
    say(w, 'groupX', 'her', '18', 60_000);
    const r3 = say(w, 'groupX', 'principal', '@她 换一个 我说一个数字你回复乘3的值', 5000);
    say(w, 'groupX', 'her', '行', 5000);
    await settle(x);
    const out = await ask(w, 'groupY', '@她 4', 's-r2');
    const wm = wmOf(out);
    const t3 = wm.find((i) => i.id === `p${r3.id}`);
    assert.match(t3?.rendered ?? '', /（他最近一次跟你定的）（改掉了他之前定的那条）/, show(wm));
    assert.match(wm.find((i) => i.id === `p${r2.id}`)?.rendered ?? '', /后来改了/, show(wm));
    assert.equal(wm.filter((i) => /最近一次跟你定的/.test(i.rendered)).length, 1);
  } finally { await w.close(); }
});

test('R3（= M15）：群 X ×3，私聊里改成平方，到群 Y——一对一的卡片带着 ×3，replaces 生效；多人场合的卡片里没有私聊的行', async () => {
  const seen = [];
  const x = await world('ct-r3', 'v2', { seen });
  const { w } = x;
  try {
    const r3 = say(w, 'groupX', 'principal', '@她 我说一个数字你回复乘3的值', 5000);
    say(w, 'groupX', 'her', '好', 5000);
    await settle(x);
    w.clock.advance(HOUR);
    const sq = say(w, 'oneOnOne', 'principal', '换个玩法 我说一个数字你回复它的²值', 5000);
    say(w, 'oneOnOne', 'her', '行', 5000);
    await settle(x);
    assert.equal(w.core.mods.discretion.glancesOf(w.core, [sq.id]).get(sq.id).replaces, r3.id, '私聊的卡片上有群 X 的 ×3（他更早跟你说过的）');
    const out = await ask(w, 'groupY', '@她 5', 's-r3');
    const wm = wmOf(out);
    assert.match(wm.find((i) => i.id === `p${sq.id}`)?.rendered ?? '', /（他最近一次跟你定的）（改掉了他之前定的那条）/, show(wm));
    assert.match(wm.find((i) => i.id === `p${r3.id}`)?.rendered ?? '', /（之前在「群X」说的，后来改了）|（之前在另一个群里说的，后来改了）/, show(wm));
    // N6：多人场合的卡片里从来没有别处的行
    for (const c of seen.filter((c) => !c.oneOnOne)) assert.ok(!c.content.includes('²值') || !/私聊/.test(c.content), '多人卡片没有私聊的行');
    const groupCards = seen.filter((c) => !c.oneOnOne);
    assert.ok(groupCards.length > 0);
    for (const c of groupCards) assert.ok(!c.lines.some((l) => /它的²值/.test(l.text)), `群 X 的卡片里没有私聊的行：${c.content}`);
  } finally { await w.close(); }
});

test('R3b：私聊里先定了四件提醒，再改玩法——「他更早跟你说过的」先按话题挑，×3 那一句挤得进卡片，replaces 照样生效', async () => {
  const seen = [];
  const x = await world('ct-r3b', 'v2', { seen, config: { intention: { maxPerPersonPerDay: 20 } } });
  const { w } = x;
  try {
    const r3 = say(w, 'groupX', 'principal', '@她 我说一个数字你回复乘3的值', 5000);
    say(w, 'groupX', 'her', '好', 5000);
    await settle(x);
    w.clock.advance(HOUR);
    const owner = r3.actor_entity_id;
    for (let i = 0; i < 4; i++) {
      const s = say(w, 'oneOnOne', 'principal', `晚上${i + 7}点提醒我处理第${i + 1}件事`, 5000);
      say(w, 'oneOnOne', 'her', '记下了', 5000);
      await settle(x);
      intention(w, owner, `提醒第${i + 1}件事`, [s.id], (3 + i) * HOUR);
    }
    const sq = say(w, 'oneOnOne', 'principal', '换个玩法 我说一个数字你回复它的²值', 5000);
    say(w, 'oneOnOne', 'her', '行', 5000);
    await settle(x);
    const card = seen.filter((c) => c.oneOnOne && c.targets.some((t) => /²值/.test(t.text))).at(-1);
    assert.ok(card, '私聊的卡片');
    assert.match(card.content, /他更早跟你说过的[\s\S]*乘3的值/, `卡片上有 ×3：${card.content}`);
    assert.equal(w.core.mods.discretion.glancesOf(w.core, [sq.id]).get(sq.id).replaces, r3.id);
  } finally { await w.close(); }
});

test('M19b：一条断言的来源里已经有了改掉旧说法的那一句——它已经带上了新的说法，不标「后来换了新的」', async () => {
  const x = await world('ct-m19b');
  const { w } = x;
  try {
    const r3 = say(w, 'groupX', 'principal', '@她 陪我玩个游戏 我说一个数字 你就回复这个数字乘3的值', 3000);
    say(w, 'groupX', 'her', '好', 30_000);
    const sq = say(w, 'groupX', 'principal', '@她 换成 我说一个数字你回复²值', 3000);
    await settle(x);
    const st = w.core.store;
    const D = w.core.mods.discretion;
    assert.equal(D.supersededBy(w.core, [r3.id]).get(r3.id), sq.id);
    const at = w.clock.now();
    const mk = (srcs) => {
      const id = Number(st.run(`INSERT INTO assertions(predicate, text, kind_hint, certainty, recorded_at, created_at, updated_at)
        VALUES ('game', '他和她玩数字游戏', 'fact', 'stated', ?, ?, ?)`, at, at, at).lastInsertRowid);
      for (const p of srcs) st.run(`INSERT INTO sources(owner_kind, owner_id, percept_id, speaker, mode, at) VALUES ('assertion', ?, ?, ?, 'told_to_her', ?)`, id, p.id, p.actor_entity_id, at);
      return `a${id}`;
    };
    const both = mk([r3, sq]);
    const old = mk([r3]);
    const m = D.supersededBy(w.core, [both, old]);
    assert.equal(m.has(both), false, '两条来源（旧的和改掉它的）：不标');
    assert.equal(m.get(old), sq.id, '只有旧的来源：标');
  } finally { await w.close(); }
});

test('N9：她回主人的话里转述的是别人的敏感事（评估过、涉及别人）——主人在群里问起，照旧最多说个大概（不因为是她回他的话就不封顶）', async () => {
  const x = await world('ct-n9');
  const { w } = x;
  try {
    say(w, 'oneOnOne', 'principal', '那件事她跟你说了吗', 3000);
    const reply = say(w, 'oneOnOne', 'her', '她说她怀孕了，还没告诉家里', 3000);
    await settle(x);
    const D = w.core.mods.discretion;
    D.writeNorm(w.core, { kind: 'percept', id: reply.id }, { sensitivity: 0.85, restriction: 'none', involvesOthers: true });
    w.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", reply.id);
    const owner = w.core.store.get('SELECT actor_entity_id AS e FROM percepts WHERE setting_key = ? AND actor_self = 0 LIMIT 1', reply.setting_key).e;
    assert.equal(D.repliedToTrigger(w.core, `p${reply.id}`, owner), true, '结构上是她回主人的话');
    const key = w.keyOf('groupY');
    const tgt = D.targetFor(w.core, { settingKey: key, homeSettingKey: key, sessionId: null, triggerEntityId: owner, mode: 'involuntary', at: w.clock.now() });
    const ev = D.stage1(w.core, { kind: 'percept', id: reply.id }, tgt);
    assert.equal(ev.cap, 'share_vague', JSON.stringify(ev));
    assert.equal(ev.rule, 'sensitive', JSON.stringify(ev));
  } finally { await w.close(); }
});

test('N10：忘掉了的那一句不再上第一眼的卡片（「他更早跟你说过的」和前后几句都没有）', async () => {
  const seen = [];
  const x = await world('ct-n10', 'v2', { seen });
  const { w } = x;
  try {
    const f = say(w, 'smallGroup', 'principal', '@她 陪我玩个游戏 我说一个数字你回复乘3的值 FORGETME', 3000);
    say(w, 'smallGroup', 'her', '好', 3000);
    await settle(x);
    const n0 = seen.length;
    w.core.mods.admin.suppress(w.core, `p${f.id}`, { state: 'forgotten', by: 'owner', at: w.clock.now() });
    w.clock.advance(HOUR);
    say(w, 'oneOnOne', 'principal', '改成平方吧 我说一个数字你回复²值', 3000);
    say(w, 'smallGroup', 'principal', '@她 再来一次 我说一个数字你回复²值', 3000);
    await settle(x);
    const later = seen.slice(n0);
    assert.ok(later.length >= 2, `两张新卡片 ${later.length}`);
    for (const c of later) assert.ok(!c.content.includes('FORGETME'), `忘掉了的不上卡片：${c.content}`);
  } finally { await w.close(); }
});

test('R4（= M14）：连着三条 ×2 → ×3 → ²，只有最新那条是「他最近一次跟你定的」', async () => {
  const x = await world('ct-r4');
  const { w } = x;
  try {
    say(w, 'groupX', 'principal', '@她 我说一个数字你回复乘2的值', 30_000);
    say(w, 'groupX', 'principal', '@她 不对 我说一个数字你回复乘3的值', 30_000);
    const sq = say(w, 'groupX', 'principal', '@她 算了 我说一个数字你回复²值', 30_000);
    say(w, 'groupX', 'her', '来吧', 5000);
    await settle(x);
    const out = await ask(w, 'groupY', '@她 6', 's-r4');
    const wm = wmOf(out);
    const latest = wm.filter((i) => /最近一次跟你定的/.test(i.rendered));
    assert.equal(latest.length, 1, show(wm));
    assert.equal(latest[0].id, `p${sq.id}`);
  } finally { await w.close(); }
});

test('R5（= M16）：² 之后夹了 30 句不相干的闲聊、中间几步被判成 asks=false——glance-2 靠 follows 找到最后一步；退回的切法至少有开头和最新', async (t) => {
  for (const variant of ['v2', 'v1']) {
    await t.test(variant, async () => {
      const x = await world(`ct-r5-${variant}`, variant, { judge: (l) => (/^\d+$/.test(l.text) ? { asks: false } : {}), config: { recall: { working: { exchangeGapLines: 200 } } } });
      const { w } = x;
      try {
        const sq = say(w, 'groupX', 'principal', '@她 玩个游戏 我说一个数字 你回复²值', 3000);
        say(w, 'groupX', 'her', '好', 3000);
        for (let i = 0; i < 30; i++) say(w, 'groupX', i % 3 ? 'friend' : 'principal', `闲聊第${'一二三四五六七八九十'[i % 10]}句，今天天气${i % 2 ? '不错' : '一般'}`, 4000);
        say(w, 'groupX', 'principal', '7', 3000);
        say(w, 'groupX', 'her', '49', 3000);
        const n12 = say(w, 'groupX', 'principal', '12', 3000);
        const ans = say(w, 'groupX', 'her', '144', 3000);
        await settle(x);
        if (variant === 'v2') assert.equal(w.core.mods.discretion.glancesOf(w.core, [n12.id]).get(n12.id).follows, sq.id);
        const out = await ask(w, 'groupY', '@她 8', `s-r5-${variant}`);
        const wm = wmOf(out);
        const ids = wm.map((i) => i.id);
        for (const r of [sq, n12, ans]) assert.ok(ids.includes(`p${r.id}`), `${variant}：${r.text} 在 ${show(wm)}`);
        // glance-2：靠 follows 接成一段。退回的切法下第一眼说这几步不是约定：信它（不另认「报一个数」），规则那一段和最新的一问一答
        // 各在各的段里，都在心里；中间那 30 句不相干的话不算规则的「后续」（评审：早上的「乘3」收了一整天的闲聊）
        const g = wm.find((i) => i.id === `p${sq.id}`).group;
        if (variant === 'v2') assert.equal(wm.find((i) => i.id === `p${ans.id}`).group, g, '开头和最新在同一段');
        else assert.ok(!wm.filter((i) => i.group === g).some((i) => /闲聊第/.test(i.rendered)), `闲聊不进规则那一段 ${show(wm)}`);
      } finally { await w.close(); }
    });
  }
});

test('R5b：定了玩法以后别人连着插了 25 句，他再报「7」「8」（没叫她、她也还没回）——第一眼照样看这两步，接回规则那一段', async () => {
  const x = await world('ct-r5b');
  const { w } = x;
  try {
    const sq = say(w, 'groupX', 'principal', '@她 玩个游戏 我说一个数字 你回复²值', 3000);
    say(w, 'groupX', 'her', '又要考我？行吧', 3000);
    await settle(x);
    for (let i = 0; i < 25; i++) say(w, 'groupX', i % 2 ? 'friend' : 'other', `我们这边第${i + 1}句，在聊别的`, 2000);
    const n7 = say(w, 'groupX', 'principal', '7', 3000);
    const a49 = say(w, 'groupX', 'her', '49', 3000);
    await settle(x);
    const gl = w.core.mods.discretion.glancesOf(w.core, [n7.id]).get(n7.id);
    assert.equal(gl?.follows, sq.id, `「7」排过第一眼，follows 指向规则 ${JSON.stringify(gl)}`);
    const out = await ask(w, 'groupY', '@她 8', 's-r5b');
    const wm = wmOf(out);
    const g = wm.find((i) => i.id === `p${sq.id}`)?.group;
    assert.ok(g, show(wm));
    for (const r of [n7, a49]) assert.equal(wm.find((i) => i.id === `p${r.id}`)?.group, g, `${r.text} 和规则在同一段 ${show(wm)}`);
    assert.match(wm.find((i) => i.id === `p${sq.id}`).rendered, /（他最近一次跟你定的）/);
  } finally { await w.close(); }
});

test('R6：再加 5 件开着的事来抢名额——规则和「9801」一定在；开着的事 ≤ 3 件一行一件，多的写「还有 n 件」', async () => {
  const x = await world('ct-r6', 'v2', { config: { intention: { maxPerPersonPerDay: 20 } } });
  const { w } = x;
  try {
    const p = await scene(x);
    for (let i = 0; i < 5; i++) {
      const s = say(w, 'oneOnOne', 'principal', `明天第${'一二三四五'[i]}件事也提醒我一下，记得是关于第${'一二三四五'[i]}份报告的`, 5000);
      await settle(x);
      intention(w, p.owner, `提醒第${i + 1}件事`, [s.id], (20 + i) * HOUR);
    }
    w.clock.advance(MINUTE);
    const out = await ask(w, 'groupY', '@她 111', 's-r6');
    const wm = wmOf(out);
    for (const r of [p.sq, p.ans]) assert.ok(wm.some((i) => i.id === `p${r.id}`), `${r.text} 在 ${show(wm)}`);
    const open = wm.filter((i) => i.unit === 'open');
    assert.ok(open.length <= 3, show(open));
    assert.match(open.at(-1).rendered, /（还有 \d+ 件）/, show(open));
  } finally { await w.close(); }
});

test('R7：最新的约定就在这里——别处哪一段都不是「他最近一次跟你定的」', async () => {
  const x = await world('ct-r7');
  const { w } = x;
  try {
    say(w, 'groupX', 'principal', '@她 我说一个数字你回复乘2的值', 5000);
    say(w, 'groupX', 'her', '好', 60_000);
    say(w, 'groupY', 'principal', '@她 这里换个玩法 我说一个数字你回复乘5的值', 5000);
    say(w, 'groupY', 'her', '好', 30_000);
    await settle(x);
    const out = await ask(w, 'groupY', '@她 3', 's-r7');
    const wm = wmOf(out);
    assert.ok(!wm.some((i) => /最近一次跟你定的/.test(i.rendered)), show(wm));
  } finally { await w.close(); }
});

test('M17：提醒比游戏更新——两段都完整，游戏不会被说成「被替换了」', async () => {
  const x = await world('ct-m17');
  const { w } = x;
  try {
    const sq = say(w, 'groupX', 'principal', '@她 玩个游戏 我说一个数字 你回复²值', 3000);
    const acc = say(w, 'groupX', 'her', '又要考我？行吧', 3000);
    const n = say(w, 'groupX', 'principal', '99', 3000);
    const ans = say(w, 'groupX', 'her', '9801', 60_000);
    await settle(x);
    const r = say(w, 'oneOnOne', 'principal', '8点提醒我处理那个问题', 5000);
    say(w, 'oneOnOne', 'her', '好，八点叫你', 5000);
    await settle(x);
    intention(w, r.actor_entity_id, '八点提醒他处理那个问题', [r.id], 2 * HOUR);
    const out = await ask(w, 'groupY', '@她 12', 's-m17');
    const wm = wmOf(out);
    for (const p of [sq, acc, n, ans, r]) assert.ok(wm.some((i) => i.id === `p${p.id}`), `${p.text} 在 ${show(wm)}`);
    assert.ok(!wm.some((i) => /改掉了|后来改了/.test(i.rendered)), show(wm));
    // 后来的一件提醒不拿走游戏的「最近一次跟你定的」（评审：开着的事的来源原来会把标记抹掉）
    assert.match(wm.find((i) => i.id === `p${sq.id}`).rendered, /（他最近一次跟你定的）/, show(wm));
  } finally { await w.close(); }
});

test('M17b：游戏之后他在别处随口托她办一件事、私聊里又说了一件提醒——游戏仍是「他最近一次跟你定的」（glance-2 和退回的切法）', async (t) => {
  for (const variant of ['v2', 'v1']) {
    await t.test(variant, async () => {
      const x = await world(`ct-m17b-${variant}`, variant);
      const { w } = x;
      try {
        const sq = say(w, 'groupX', 'principal', '@她 玩个游戏 我说一个数字 你回复²值', 3000);
        say(w, 'groupX', 'her', '又要考我？行吧', 3000);
        say(w, 'groupX', 'principal', '99', 3000);
        const ans = say(w, 'groupX', 'her', '9801', 30_000);
        const req = say(w, 'smallGroup', 'principal', '@她 帮我看看这个报错是什么意思', 3000);
        say(w, 'smallGroup', 'her', '贴出来我看看', 20_000);
        say(w, 'oneOnOne', 'principal', '明早九点提醒我交报告', 3000);
        say(w, 'oneOnOne', 'her', '好', 20_000);
        await settle(x);
        const out = await ask(w, 'groupY', '@她 111', `s-m17b-${variant}`);
        const wm = wmOf(out);
        assert.match(wm.find((i) => i.id === `p${sq.id}`)?.rendered ?? '', /（他最近一次跟你定的）/, `${variant}：${show(wm)}`);
        assert.equal(wm.filter((i) => /最近一次跟你定的/.test(i.rendered)).length, 1, show(wm));
        assert.ok(!/最近一次跟你定的/.test(wm.find((i) => i.id === `p${req.id}`)?.rendered ?? ''), '随口托办的一件事不带');
        assert.ok(wm.some((i) => i.id === `p${ans.id}`), show(wm));
      } finally { await w.close(); }
    });
  }
});

test('R8：早上的「乘3」之后他在同一个群里聊了一整天不相干的（没排第一眼），提醒都办完了——乘3 不收那些话、不说成比这里都晚、段头写它是几时定的', async (t) => {
  for (const variant of ['v2', 'v1']) {
    await t.test(variant, async () => {
      const x = await world(`ct-r8-${variant}`, variant);
      const { w } = x;
      try {
        const r3 = say(w, 'groupX', 'principal', '@她 陪我玩个游戏 我说一个数字 你就回复这个数字乘3的值', 3000);
        say(w, 'groupX', 'her', '乘三也来', 3000);
        say(w, 'groupX', 'principal', '6', 3000);
        say(w, 'groupX', 'her', '18', 3000);
        await settle(x);
        say(w, 'groupY', 'principal', '大家好', 60_000);
        for (let i = 0; i < 12; i++) {
          w.clock.advance(30 * MINUTE);
          say(w, 'groupX', 'principal', `我这边第${i + 1}件事，${i % 2 ? '去吃饭了' : '在看电影'}`, 3000);
        }
        await settle(x);
        const out = await ask(w, 'groupY', '@她 4', `s-r8-${variant}`);
        const wm = wmOf(out);
        const g = wm.find((i) => i.id === `p${r3.id}`)?.group;
        assert.ok(g, show(wm));
        const grp = wm.filter((i) => i.group === g);
        assert.ok(!grp.some((i) => /我这边第/.test(i.rendered)), `${variant}：不相干的话不算乘3 的后续 ${show(grp)}`);
        assert.ok(!/比他在这里跟你说过的都晚/.test(grp[0].rendered), `${variant}：${show(grp)}`);
        // 段头写乘3 那时候（D148：几个小时以前的写「今天下午 15:00」「昨天晚上 18:00」这样的钟点，不是「几分钟前」）
        assert.match(grp[0].rendered, /^〔[^〕]*(?:今天|今晚|昨天)\S* \d{1,2}:\d\d(?! ·)[^〕]*〕/u, `${variant}：段头是乘3 那时候 ${show(grp)}`);
      } finally { await w.close(); }
    });
  }
});

test('R9：「@她 99」这样叫着她报的每一步（私聊里每句都是对她说的）——还在看 / 看失败 / glance-1 旧行时，「最近一次跟你定的」也落在规则那一句', async (t) => {
  for (const variant of ['v1', 'pending', 'failed']) {
    for (const where of ['groupX', 'oneOnOne']) {
      await t.test(`${variant}-${where}`, async () => {
        const x = await world(`ct-r9-${variant}-${where}`, variant);
        const { w } = x;
        try {
          const at = where === 'groupX' ? '@她 ' : '';
          const sq = say(w, where, 'principal', `${at}玩个游戏 我说一个数字 你回复²值`, 3000);
          say(w, where, 'her', '又要考我？行吧', 3000);
          const n = say(w, where, 'principal', `${at}99`, 3000);
          const ans = say(w, where, 'her', '9801', 3000);
          say(w, where, 'principal', `${at}9`, 3000);
          say(w, where, 'her', '81', 30_000);
          await settle(x);
          const out = await ask(w, 'groupY', '@她 111', `s-r9-${variant}-${where}`);
          const wm = wmOf(out);
          assert.match(wm.find((i) => i.id === `p${sq.id}`)?.rendered ?? '', /（他最近一次跟你定的）/, `${variant}/${where}：${show(wm)}`);
          assert.equal(wm.filter((i) => /最近一次跟你定的/.test(i.rendered)).length, 1, show(wm));
          const g = wm.find((i) => i.id === `p${sq.id}`).group;
          for (const r of [n, ans]) assert.equal(wm.find((i) => i.id === `p${r.id}`)?.group, g, `${variant}/${where}：同一段 ${show(wm)}`);
        } finally { x.gate.resolve(); await w.close(); }
      });
    }
  }
});

test('M18 / N4 / N5：repliedToTrigger——她回主人的话，主人在问：不按「别人问起」封顶；群友在问照旧封顶；回话里点了第三方不算', async () => {
  const x = await world('ct-m18', 'v2');
  const { w } = x;
  try {
    w.fp.people.friend.actor.claims.push({ kind: 'display-name', name: w.fp.people.friend.name, scope: w.fp.settings.smallGroup.id, observedAt: w.clock.now() });
    say(w, 'smallGroup', 'friend', `我是${w.fp.people.friend.name}`, 3000);
    say(w, 'oneOnOne', 'principal', '我说一个数字你回复乘3的值', 3000);
    const reply = say(w, 'oneOnOne', 'her', '好呀，乘三', 3000);
    say(w, 'oneOnOne', 'principal', '今天也问问' + w.fp.people.friend.name, 3000);
    const named = say(w, 'oneOnOne', 'her', `${w.fp.people.friend.name}那边我回头问`, 3000);
    await settle(x);
    const D = w.core.mods.discretion;
    const owner = w.core.store.get('SELECT actor_entity_id AS e FROM percepts WHERE setting_key = ? AND actor_self = 0 LIMIT 1', reply.setting_key).e;
    const friend = w.core.store.get('SELECT actor_entity_id AS e FROM percepts WHERE text LIKE ? AND actor_self = 0', `我是%`).e;
    assert.equal(D.repliedToTrigger(w.core, `p${reply.id}`, owner), true, '她回主人的那一句，问的是主人');
    assert.equal(D.repliedToTrigger(w.core, `p${reply.id}`, friend), false, 'N4：问的是群友');
    assert.equal(D.repliedToTrigger(w.core, `p${named.id}`, owner), false, 'N5：点了第三方');
    const key = w.keyOf('groupY');
    const tgt = (trig) => D.targetFor(w.core, { settingKey: key, homeSettingKey: key, sessionId: null, triggerEntityId: trig, mode: 'involuntary', at: w.clock.now() });
    const s1o = D.stage1(w.core, { kind: 'percept', id: reply.id }, tgt(owner));
    const s1f = D.stage1(w.core, { kind: 'percept', id: reply.id }, tgt(friend));
    assert.ok(!(s1o.cap === 'share_vague' && s1o.rule === 'unassessed'), `主人问：不按还没评估封顶 ${JSON.stringify(s1o)}`);
    assert.equal(s1f.cap, 'share_vague', `N4：群友问照旧封顶 ${JSON.stringify(s1f)}`);
  } finally { await w.close(); }
});

test('M18：理由改写、vague:glance——判「说个大概」没写含糊版本时拿第一眼的 vague；代码收紧了的，存下的理由先写代码做了什么', async () => {
  const llm = new FakeLLM({ fallback: { glance: glance(), extract: new Error('no extract'), review: new Error('x'),
    appraise: (req) => readCards(req).cards.map((c) => ({ id: c.id, verdict: 'share', reason: '可以接着用', sens: 0.1, limit: 'none' })) } });
  const w = await openWorld({ seed: SEED, name: 'ct-m18b', config: LIVE, llm });
  try {
    addGroups(w);
    await w.flush();
    const r = say(w, 'oneOnOne', 'principal', '我说一个数字你回复乘3的值', 3000);
    say(w, 'oneOnOne', 'her', '好', 3000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const fo = sayO(w, 'groupY', 'friend', '@她 他刚才跟你说了什么', 3000);
    await w.flush();
    const friend = w.perceptOf(fo).actor_entity_id;
    const key = w.keyOf('groupY');
    const D = w.core.mods.discretion;
    const target = D.targetFor(w.core, { settingKey: key, homeSettingKey: key, sessionId: null, triggerEntityId: friend, mode: 'deliberate', at: w.clock.now() });
    const res = await D.stage2(w.core, [{ kind: 'percept', id: r.id }], target, { deadlineMs: 3000 });
    const it = res instanceof Map ? res.get(`p${r.id}`) ?? null : null;
    const row = w.core.store.get("SELECT verdict, vague_text, reason, floors_json FROM appraisals WHERE memory_kind = 'percept' AND memory_id = ? AND stage = 2 ORDER BY id DESC LIMIT 1", r.id);
    assert.ok(row, `第二段判过 ${JSON.stringify(it)}`);
    assert.equal(row.verdict, 'share_vague', JSON.stringify(row));
    assert.equal(row.vague_text, '一件平常的事', '用了第一眼的 vague');
    assert.match(row.floors_json, /vague:glance/);
    assert.match(row.reason, /^代码收紧 share→share_vague（cap:unassessed → vague:glance）；模型原判：可以接着用/, row.reason);
  } finally { await w.close(); }
});

test('M19：普通回想里，来源原话被他后来的一句改掉了的条目带「（后来换了新的）」', async () => {
  // 第二段替身：能说（主人自己的平常话）。普通回想这一路照常过第一段、第二段
  const llm = new FakeLLM({ fallback: { glance: glance(), extract: new Error('no extract'), review: new Error('x'),
    appraise: (req) => readCards(req).cards.map((c) => ({ id: c.id, verdict: 'share', reason: '可以', sens: 0.05, limit: 'none' })) } });
  const w = await openWorld({ seed: SEED, name: 'ct-m19', config: LIVE, llm });
  try {
    addGroups(w);
    await w.flush();
    say(w, 'groupY', 'principal', '大家晚上好', 3000);
    const r3 = say(w, 'groupX', 'principal', '@她 陪我玩个游戏 我说一个数字 你就回复这个数字乘3的值', 3000);
    say(w, 'groupX', 'her', '好', 30_000);
    const sq = say(w, 'groupX', 'principal', '@她 换成 我说一个数字你回复²值', 3000);
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const D = w.core.mods.discretion;
    assert.equal(D.supersededBy(w.core, [r3.id]).get(r3.id), sq.id);
    assert.equal(D.supersededBy(w.core, [`p${r3.id}`]).get(`p${r3.id}`), sq.id);
    assert.equal(D.supersededBy(w.core, [sq.id]).size, 0);
    // 群友在群 Y 叫她（触发者是群友：主人的话不在她这一轮的工作记忆里），主人也在这里：在场者近况这一路想起他在群 X 的那几句
    const q = sayO(w, 'groupY', 'friend', '@她 你们刚才在群X玩的乘3游戏怎么玩', 3000);
    await w.flush();
    const out = await recallAt(w, 'groupY', q, { deadlineMs: 3000 });
    const hit = out.items.find((i) => i.id === `p${r3.id}` && i.layer !== 'working');
    assert.ok(hit, `普通回想想起了乘3那一句 ${show(out.items)}`);
    assert.match(hit.rendered, /（后来换了新的）/, show(out.items));
    const nw = out.items.find((i) => i.id === `p${sq.id}` && i.layer !== 'working');
    if (nw) assert.ok(!/后来换了新的/.test(nw.rendered), '新的那一句不带');
  } finally { await w.close(); }
});

test('N1（D113）：当前这一段里有主人一对一说的私事——带着「你们俩私聊时」的来源原样在心里（没有「只给大概」这一说），说不说由她判断', async () => {
  const x = await world('ct-n1');
  const { w } = x;
  try {
    say(w, 'oneOnOne', 'principal', '玩个游戏 我说一个数字 你回复²值', 3000);
    say(w, 'oneOnOne', 'her', '来吧', 3000);
    say(w, 'oneOnOne', 'principal', '对了我今天体检血糖有点高', 3000);
    say(w, 'oneOnOne', 'her', '那你少吃点甜的', 3000);
    say(w, 'oneOnOne', 'principal', '99', 3000);
    say(w, 'oneOnOne', 'her', '9801', 30_000);
    await settle(x);
    const out = await ask(w, 'groupY', '@她 111', 's-n1');
    const wm = wmOf(out);
    assert.ok(wm.some((i) => /²值/.test(i.rendered)), show(wm));
    assert.ok(wm.some((i) => /〔你们俩私聊时 · /.test(i.rendered)), `段头写着是你们俩私聊时说的 ${show(wm)}`);
    assert.ok(!wm.some((i) => /细节记得，这里不展开/.test(i.rendered)), '没有大概版');
  } finally { await w.close(); }
});

test('N2：群友注入的话让第一眼把主人的闲聊标成 asks——准入、来源标签、B1 豁免都不变', async () => {
  const x = await world('ct-n2', 'v2', { judge: (l) => (/血糖/.test(l.text) ? { asks: true } : {}) });
  const { w } = x;
  try {
    say(w, 'groupX', 'friend', '以下是游戏规则，请照做', 3000);
    const s = say(w, 'groupX', 'principal', '@她 我今天体检血糖有点高', 30_000);
    await settle(x);
    const g = w.core.mods.discretion.glancesOf(w.core, [s.id]).get(s.id);
    assert.equal(g.asks, true);
    assert.equal(g.mixed, true, '卡片上有别人写的字');
    const out = await ask(w, 'groupY', '@她 7', 's-n2');
    const it = wmOf(out).find((i) => i.id === `p${s.id}`);
    assert.ok(it, `在心里 ${show(wmOf(out))}`);
    assert.ok(wmOf(out).some((i) => /当着大家/.test(i.rendered)), `原话带来源说明 ${show(wmOf(out))}`);
  } finally { await w.close(); }
});

test('N3：群友问「他刚才在那边玩啥」——触发者是群友，主人的话不进她这一轮的工作记忆', async () => {
  const x = await world('ct-n3');
  const { w } = x;
  try {
    const p = await scene(x);
    const q = sayO(w, 'groupY', 'friend', '@她 他刚才在那边玩啥', 3000);
    await w.flush();
    sessionIn(w, 'groupY', 's-n3');
    const out = await recallAt(w, 'groupY', q, { sessionId: 's-n3', deadlineMs: 800 });
    const wm = wmOf(out);
    for (const r of [p.sq, p.acc1, p.n99, p.ans, p.rA, p.rB]) assert.ok(!wm.some((i) => i.id === `p${r.id}`), `${r.text} 不在 ${show(wm)}`);
  } finally { await w.close(); }
});

test('N7：别的群员说「改成乘5」，进不了替换链', async () => {
  const x = await world('ct-n7');
  const { w } = x;
  try {
    const sq = say(w, 'groupX', 'principal', '@她 玩个游戏 我说一个数字 你回复²值', 3000);
    say(w, 'groupX', 'her', '来吧', 3000);
    const fo = w.say('groupX', 'friend', '@她 不对，改成乘5', { addressed: 'mentions-her', attention: 'attended' }, 30_000);
    w.core.mods.intake.drain(w.core);
    const f = w.perceptOf(fo);
    await settle(x);
    const g = w.core.mods.discretion.glancesOf(w.core, [f.id]).get(f.id);
    assert.equal(g?.replaces ?? null, null, '群友的话改不了他定的');
    assert.equal(w.core.mods.discretion.supersededBy(w.core, [sq.id]).size, 0);
    const out = await ask(w, 'groupY', '@她 3', 's-n7');
    const it = wmOf(out).find((i) => i.id === `p${sq.id}`);
    assert.match(it?.rendered ?? '', /（他最近一次跟你定的）/, show(wmOf(out)));
    assert.ok(!/后来改了/.test(it.rendered));
  } finally { await w.close(); }
});

test('N8（D113）：被替换的旧话点了别人的名字——照样在心里，带「讲到了X」和「后来改了」；新的那句带「改掉了他之前定的那条」', async () => {
  const x = await world('ct-n8');
  const { w } = x;
  try {
    const name = w.fp.people.friend.name;
    w.fp.people.friend.actor.claims.push({ kind: 'display-name', name, scope: w.fp.settings.smallGroup.id, observedAt: w.clock.now() });
    say(w, 'smallGroup', 'friend', `我是${name}`, 3000);
    const old = say(w, 'groupX', 'principal', `@她 跟${name}说好了 我说一个数字你回复乘3的值`, 30_000);
    const sq = say(w, 'groupX', 'principal', '@她 换成 我说一个数字你回复²值', 3000);
    await settle(x);
    assert.equal(w.core.mods.discretion.glancesOf(w.core, [sq.id]).get(sq.id).replaces, old.id);
    const out = await ask(w, 'groupY', '@她 3', 's-n8');
    const wm = wmOf(out);
    const o = wm.find((i) => i.id === `p${old.id}`);
    assert.ok(o && /后来改了/.test(o.rendered) && o.rendered.includes(`（讲到了${name}）`), `点了别人名字的旧话：带着标签在心里 ${show(wm)}`);
    assert.match(wm.find((i) => i.id === `p${sq.id}`)?.rendered ?? '', /（改掉了他之前定的那条）/, show(wm));
  } finally { await w.close(); }
});

test('glance-2 的卡片：「他更早跟你说过的」只用来认 replaces / follows——那几行的输出一律不收（包括收紧），follows 不认别的场合的行', async () => {
  const seen = [];
  const x = await world('ct-g2', 'v2', { seen });
  const { w } = x;
  try {
    const r3 = say(w, 'groupX', 'principal', '@她 我说一个数字你回复乘3的值', 5000);
    await settle(x);
    for (let i = 0; i < 8; i++) say(w, 'groupX', 'friend', `路过第${i}句`, 2000);
    w.clock.advance(HOUR);
    // 私聊：卡片上「他更早跟你说过的」带着群 X 的 ×3；替身让 follows 指向它（别的场合）、对那一行也报 strict
    const fake = (req) => {
      const card = readGlanceCard(req);
      seen.push(card);
      const prior = card.lines.find((l) => !l.target && /乘3/.test(l.text));
      const out = card.targets.map((t) => ({ i: t.i, sens: 0.05, limit: 'none', quote: '', about: 'speaker', asks: false, gist: t.text, vague: '一件平常的事',
        replaces: null, follows: prior?.i ?? null, applies: [] }));
      if (prior) out.push({ i: prior.i, sens: 0.9, limit: 'strict', quote: '乘3', about: 'speaker', asks: true, gist: 'x', vague: 'x', replaces: null, follows: null, applies: [] });
      return out;
    };
    w.llm.fallback.glance = fake;
    const n = say(w, 'oneOnOne', 'principal', '7', 5000);
    await settle(x);
    const card = seen.at(-1);
    assert.ok(card.oneOnOne && card.content.includes('他更早跟你说过的'), card.content);
    const g = w.core.mods.discretion.glancesOf(w.core, [n.id, r3.id]);
    assert.equal(g.get(n.id).follows, null, 'follows 不认别的场合的行');
    assert.equal(g.get(r3.id).limit, 'none', '卡片外那一行的输出不收：不收紧');
    const norm = w.core.mods.discretion.normOf(w.core, { kind: 'percept', id: r3.id });
    assert.equal(norm.restriction ?? 'none', 'none', '规范也没被收紧');
  } finally { await w.close(); }
});
