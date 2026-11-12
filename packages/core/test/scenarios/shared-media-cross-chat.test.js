// 群A 的小狗视频，到群B 她像换了个人（D113，实测问题 #21）。主人：「我在一个群里发过一个小狗的视频，她也看了，但是我在另一个群里提起的时候
// 她就像是换了一个人一样完全想不起来了」。成因：第一眼把主人自己分享的小狗判成 about=others，「替别人做不了主」把这几行挡在工作记忆外面；
// 闲聊段的 core 被挡时整段跳过，名额被陈旧的闲聊补满；「［图片］」这类占位被当成话题词；段头「比他在这里说过的都晚」按整段成员算。
// 现在：那几行带着「在群A当着大家」的来源在心里、是最新的一段，段头按显示出来的最后一行算；草稿直接说（不送审、不改口）。
// 变体：旧的 glance-2 行 about=others 照样进；规范写好以后照样进。真模块 + 替身端口 + 假平台；账号、群号都是假的。
import test from 'node:test';
import { recallCaps } from '../../src/config/caps.js';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, recallAt, platformSeeds, FakeLLM, MINUTE, glancer } from './presence-world.js';

const SEED = platformSeeds()[0];
const HOUR = 60 * MINUTE;
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));

function addGroups(w) {
  const base = w.fp.settings.smallGroup.descriptor;
  for (const [name, label] of [['gA', '群A'], ['gB', '群B']]) {
    const d = structuredClone(base);
    const id = opaqueFrom(`media-${SEED}`, 'setting', name);
    Object.assign(d, { id, label });
    d.audience = { ...d.audience, size: 30, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' };
    d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
    d.capabilities = { preSendGate: true, canHold: false };
    w.fp.settings[name] = { id, descriptor: d };
    w.fp.sink.describe(structuredClone(d));
  }
}

async function scene(name, { aboutOthers = false, assess = false, live = false } = {}) {
  // 第一眼的替身：旧的 glance-2 把主人分享的小狗判成「别人的事」（这次的成因）；现场的形状（live）里私聊那串提醒是一个根 + 他照着的一步
  const judge = (t, card) => {
    const o = aboutOthers && /小狗|视频|车底|走路/.test(t.text) ? { about: 'others' } : {};
    if (live && t.who === '他' && /^那两件事/.test(t.text)) {
      const root = [...card.lines].reverse().find((x) => x.i < t.i && x.who === '他' && /帮我记着/.test(x.text));
      if (root) Object.assign(o, { asks: true, follows: root.i });
    }
    return o;
  };
  const llm = new FakeLLM({ fallback: { appraise: () => [], glance: glancer(judge), review: [{ verdict: 'reconsider', reflection: '先不说', reason: '偏紧' }] } });
  const w = await openWorld({ seed: SEED, name, config: LIVE, llm });
  addGroups(w);
  await w.flush();
  // 主人以前在群B 说过话（「比他在这里说过的都晚」的参照）
  w.say('gB', 'principal', '晚上好', { addressed: 'ambient', attention: 'attended' }, 2000);
  if (live) {
    // 现场的形状（11-06 群B 09:35 那一轮）：8 小时前私聊里一串提醒（他最近一次跟你定的，带一步后续），两件当时托的、早就过了点的事
    const dm = (who, text, gap = 15_000) => w.say('oneOnOne', who, text, who === 'her' ? {} : { addressed: 'to-her', attention: 'attended' }, gap);
    const root = dm('principal', '帮我记着：十点半提醒我两件事');
    dm('her', '好，十点半提醒你，两件都记下了');
    const step = dm('principal', '那两件事等十点半再说吧');
    dm('her', '行，那就先放着，十点半准时叫你');
    for (let i = 0; i < 3; i++) await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const owner = w.perceptOf(root).actor_entity_id;
    for (const [text, src] of [['十点半提醒他第一件事', root], ['十点半也提醒他第二件事', step]]) {
      const at = w.clock.now();
      w.core.mods.encode.formIntention(w.core, { about: null, targetEntityId: owner, act: text, text, origin: 'principal-request',
        trigger: { timeWindow: { start: at + HOUR, end: at + HOUR + 10 * MINUTE }, cues: [{ entity: owner }] }, evidencePerceptIds: [w.perceptOf(src).id] }, { at });
    }
    w.clock.advance(8 * HOUR);
    // 15 分钟前私聊里又聊了两句
    dm('principal', '诶嘿嘿', 30_000);
    dm('her', '行吧行吧，你先忙，十点半那两件事我记着呢', 60_000);
    w.clock.advance(10 * MINUTE);
  } else {
    w.clock.advance(3 * HOUR);
  }
  // 群A：一段 30 多句的旧闲聊（主人和她），中间一张图片（现场的形状：主人的话都是 ambient，小狗紧跟在闲聊后面，合进同一段）
  for (let i = 0; i < 16; i++) {
    w.say('gA', 'principal', i === 7 ? '［图片］' : `今天第${i}件小事，随便聊聊`, { addressed: live || i % 3 ? 'ambient' : 'mentions-her', attention: 'attended' }, 20_000);
    w.say('gA', 'her', i === 7 ? '［图片］' : `嗯嗯，第${i}件我知道啦`, {}, 20_000);
  }
  if (!live) w.clock.advance(2 * HOUR);
  // 主人发了视频、说了一句，她回了三句
  const v = w.say('gA', 'principal', '［视频］', { addressed: 'ambient', attention: 'attended' }, 5000);
  const pup = live ? w.say('gA', 'principal', '刚出生不久的小狗', { addressed: 'ambient', attention: 'attended' }, 8000)
    : w.say('gA', 'principal', '@她 刚出生不久的小狗', { addressed: 'mentions-her', attention: 'attended' }, 8000);
  const h1 = w.say('gA', 'her', '哇好小一只！', {}, 6000);
  const h2 = w.say('gA', 'her', '走路还晃悠悠的', {}, 6000);
  const h3 = w.say('gA', 'her', '它怎么老往车底下钻呀', {}, 60_000);
  for (let i = 0; i < 5; i++) await w.flush();
  await w.core.mods.discretion.glancesIdle(w.core);
  const lines = [v, pup, h1, h2, h3].map((o) => w.perceptOf(o));
  if (assess) {
    for (const p of lines) {
      w.core.mods.discretion.writeNorm(w.core, { kind: 'percept', id: p.id }, { sensitivity: 0.05, restriction: 'none' });
      w.core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", p.id);
    }
  }
  w.clock.advance(live ? MINUTE : 4 * MINUTE);
  const ask = w.say('gB', 'principal', '@她 给大家讲讲我刚拍的小狗', { addressed: 'mentions-her', attention: 'attended' }, 500);
  await w.flush();
  return { w, llm, lines, ask };
}

for (const [label, opt] of [['第一眼 glance-2（正常）', {}], ['旧的 glance-2 行 about=others', { aboutOthers: true }], ['规范写好以后', { assess: true }],
  ['现场的形状：8 小时前私聊里那串提醒、两件过了点的事、15 分钟前的私聊、主人的话都是 ambient', { live: true, aboutOthers: true }]]) {
  test(`小狗（${label}）：群A 的那五行在群B 的工作记忆里、是最新的一段、段头写对了；草稿直接说`, async () => {
    const { w, llm, lines, ask } = await scene(`media-${Object.keys(opt).join('-') || 'plain'}`, opt);
    try {
      w.pm.sessions.bind({ sessionId: 's-b', settingId: w.fp.settings.gB.id, adapterId: w.fp.namespace, confidence: 'specific' });
      const out = await recallAt(w, 'gB', ask, { sessionId: 's-b', deadlineMs: 800 });
      const wm = out.items.filter((i) => i.layer === 'working');
      const ids = lines.map((p) => `p${p.id}`);
      for (const r of ids) assert.ok(wm.some((i) => i.id === r), `${r} 在工作记忆里 ${show(wm)}`);
      // 是最新的一段：排在最后（离她要回的那句话最近），同一组
      const last = wm.at(-1);
      const g = wm.filter((i) => i.group === last.group);
      assert.ok(ids.every((r) => g.some((i) => i.id === r)), `那五行是「现在这件」（最后一组）${show(wm)}`);
      assert.match(g[0].rendered, /^〔在「群A」当着大家 · [^〕]*分钟前 · 这是你们最近的一段，比他在这里跟你说过的都晚〕/, `段头 ${g[0].rendered}`);
      if (opt.live) {
        // 8 小时前那串提醒（过了点的两件）还在心里，但不是「现在这件」：一分钟前刚聊的小狗才是
        assert.ok(wm.some((i) => /十点半/.test(i.rendered) && i.group !== last.group), `那串提醒还在、不在最后 ${show(wm)}`);
        assert.ok(wm.length <= recallCaps(w.core.config.get()).working.maxLines, 'D165：按生效的行数上限');
      }
      assert.deepEqual(g.slice(-5).map((i) => i.id), ids, '显示出来的最后五行就是视频、他那句和她的三句（按时间）');
      assert.ok(!wm.some((i) => /别外传|私下/.test(i.rendered)), '没有不相干的判语');
      // 草稿直接说：不送审、不改口
      w.pm.sessions.injected({ sessionId: 's-b', nonce: 'n-b', layer: 'block', mode: 'live', chars: 10,
        items: out.items.map((i) => ({ id: i.id, layer: i.layer, verdict: i.verdict, appraisalRef: i.appraisalRef })) });
      w.pm.sessions.confirm('s-b', 'n-b');
      const a = await w.pm.expression.appraise({ channel: { targetSettingId: w.fp.settings.gB.id, persistence: 'once' },
        text: ['看过啦，小小一只走路晃悠悠的，还往车底下钻'], origin: { path: 'tool', sessionId: 's-b', homeSettingId: w.fp.settings.gB.id } });
      assert.equal(a.verdict, 'speak');
      assert.equal(llm.callsFor('review').length, 0);
    } finally { await w.close(); }
  });
}
