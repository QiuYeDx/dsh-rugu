// 11-06 的误拦（D113，实测问题 #22）：两天里群聊的正常发言被拦了 59 句（11-06 一天 29 句，占当天 32%），大多是「中午吃啥呀」这样的日常话。
// 现场的形状（这里用替身照着搭，账号、群号都是假的）：三个群 + 和主人的私聊 + 网页；主人私聊里的两条提醒已经注入进三个群的会话
// （原来以 careful 的工作记忆跟着进每个群）；她自己在群B 当众说过的玩笑；账本超过 200 项；大多数轮是旁听（ambient）、带污点；
// 还有 36 条那种没有原话的 soft 规范（提炼、撤回、提炼失败时按 soft 记下的）。
// 断言：那 29 句同形的日常话、提醒的创建和投递全部照常说；审视调用 0 次；字面不重合时 embed 调用 0 次；没有任何返回文字要她改写。
// 真模块：createPersonaMemory + 替身端口 + 假平台。
import test from 'node:test';
import assert from 'node:assert/strict';
import { opaqueFrom } from '../../src/contract/ids.js';
import { openWorld, platformSeeds, FakeLLM, MINUTE } from './presence-world.js';

const SEED = platformSeeds()[0];
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };

// 和 11-06 被拦下的那些同形的日常话（不是原文，是同一类：吃饭、问候、玩笑、接梗）
const DRAFTS = [
  '对了，都快十一点了，中午吃啥呀', '午饭时间快到了诶', '这会儿在忙的都抬头歇会儿吧', '中午我想吃白饭配个热汤，你们呢',
  '别发问号了，我认错还不行嘛', '哈哈哈那明明是个问号啦', '想笑就笑吧，别憋坏了', '早上好呀，今天也要元气满满',
  '你们昨晚几点睡的', '这个表情包好可爱，我收下了', '那我先去喝口水', '外面好像要下雨了，出门记得带伞',
  '这题我也不会，坐等大佬', '啊这，我刚才说错了，是周四不是周三', '好耶！', '晚上一起打游戏吗',
  '我觉得还行，不算太难', '这首歌我单曲循环了一下午', '谁偷吃了我的布丁（假装生气）', '收到收到',
  '欢迎新朋友～', '今天的晚霞好好看', '你说得对，是我想多了', '笑死，这也太巧了吧',
  '午睡醒了，有人在吗', '我去看看再回来', '冲鸭', '下次一定', '大家辛苦啦，早点休息',
];

function addGroups(w) {
  const base = w.fp.settings.smallGroup.descriptor;
  for (const [name, label, size] of [['gA', '群A', 30], ['gB', '群B', 60], ['gC', '群C', 12]]) {
    const d = structuredClone(base);
    const id = opaqueFrom(`fb-${SEED}`, 'setting', name);
    Object.assign(d, { id, label });
    d.audience = { ...d.audience, size, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' };
    d.disclosure = { ...d.disclosure, visibleTo: 'members', persistence: 'logged' };
    d.capabilities = { preSendGate: true, canHold: false };
    w.fp.settings[name] = { id, descriptor: d };
    w.fp.sink.describe(structuredClone(d));
  }
}

test('11-06 的形状：29 句日常话、提醒的创建和投递全部照常说；审视 0 次；字面不重合时 embed 0 次；没有一句被要求改写', async () => {
  const llm = new FakeLLM({ fallback: { review: [{ verdict: 'reconsider', reflection: '先不说', reason: '偏紧的审视' }], appraise: () => [], glance: () => [] } });
  const w = await openWorld({ seed: SEED, name: 'fb-1106', config: LIVE, llm });
  try {
    addGroups(w);
    await w.flush();
    const { core, pm } = w;
    // 主人私聊里的两条提醒（p1027 / p1023 那样的原话）
    const r1 = w.say('oneOnOne', 'principal', '还有这个问题 8点的时候一并提醒我', { addressed: 'to-her', attention: 'attended' }, 2000);
    const r2 = w.say('oneOnOne', 'principal', '另外还有个问题就是在群聊里不能给你设置定时任务的问题 也得提醒我处理一下', { addressed: 'to-her', attention: 'attended' }, 2000);
    // 网页那边主人问过的一句（p1227 那样）
    const web = w.say('oneOnOne', 'principal', '你还记得昨天我跟你聊了什么吗', { addressed: 'to-her', attention: 'attended' }, 2000);
    // 她自己在群B 当众说的玩笑（p1385 那样）
    const joke = w.say('gB', 'her', '今天也是凶，宜听歌、学点新东西，忌删库跑路喔', {}, 2000);
    // 三个群里的闲聊（账本里的大头）
    const fill = [];
    for (let i = 0; i < 230; i++) fill.push(w.say(['gA', 'gB', 'gC'][i % 3], i % 2 ? 'friend' : 'other', `群里第${i}句闲聊，签到打卡看番`, { addressed: 'ambient', attention: 'peripheral' }, 200));
    for (let i = 0; i < 20; i++) await w.flush();
    const id = (o) => { const p = w.perceptOf(o); assert.ok(p, `落库了：${o.text}`); return p.id; };
    const ledger = [r1, r2, web, joke, ...fill].map((o) => `p${id(o)}`);
    // 36 条没有原话的 soft 规范（提炼、撤回、catch → soft 留下的）
    for (const o of fill.slice(0, 36)) {
      core.mods.discretion.writeNorm(core, { kind: 'percept', id: id(o) }, { restriction: 'soft', sensitivity: 0.1, involvesOthers: false });
      core.store.run("UPDATE percepts SET norm_state = 'assessed' WHERE id = ?", id(o));
    }
    /** 这几条对一个场合过一遍关口①（真的判定行，D113：非公开目标只跑第一段），注入并确认送达（进污点账本）。 */
    const injectInto = async (where, sid, refs) => {
      pm.sessions.bind({ sessionId: sid, settingId: w.fp.settings[where].id, adapterId: w.fp.namespace, confidence: 'specific' });
      const target = core.mods.discretion.targetFor(core, { settingKey: w.keyOf(where), homeSettingKey: w.keyOf(where), sessionId: sid, triggerEntityId: null, mode: 'involuntary', at: w.clock.now() });
      const items = await core.mods.discretion.gate(core, refs.map((ref) => ({ ref, mref: { kind: 'percept', id: Number(ref.slice(1)) } })), target, { mode: 'involuntary', deadlineMs: 800 });
      pm.sessions.injected({ sessionId: sid, nonce: `n-${sid}`, layer: 'block', mode: 'live', chars: 400,
        items: items.map((i) => ({ id: i.ref, layer: 'recalled', verdict: i.verdict, appraisalRef: i.appraisalRef })) });
      pm.sessions.confirm(sid, `n-${sid}`);
      return items;
    };
    // 两条提醒和别的条目已经注入进三个群的会话；每一轮都带污点
    for (const g of ['gA', 'gB', 'gC']) {
      const items = await injectInto(g, `s-${g}`, ledger);
      assert.ok(items.some((i) => i.ref === ledger[0]) && items.some((i) => i.ref === ledger[1]), '主人私聊里的两条提醒进了群里的会话（带着「私聊时」的来源）');
      assert.ok(items.length > 200, `账本超过 200 项：${items.length}`);
      pm.sessions.markTurnTaint(`s-${g}`, { tainted: true, reason: 'read:wait_for_messages' });
    }
    // 这一轮是群友在群里随口说的（ambient），问她的不是说那两条提醒的人
    w.say('gB', 'friend', '?', { addressed: 'ambient', attention: 'attended' }, 500);
    w.say('gB', 'other', '@她 中午吃啥', { addressed: 'mentions-her', attention: 'attended' }, 500);
    await w.flush();
    const emb = w.ports.embedding;
    const q0 = emb?.calls?.query ?? 0;
    const results = [];
    for (const [i, text] of DRAFTS.entries()) {
      const g = ['gA', 'gB', 'gC'][i % 3];
      const a = await pm.expression.appraise({ channel: { targetSettingId: w.fp.settings[g].id, persistence: 'once' }, text: [text],
        origin: { path: 'tool', sessionId: `s-${g}`, homeSettingId: w.fp.settings[g].id } });
      results.push([text, a.verdict, a.reflection ?? '']);
    }
    // 提醒的创建（和主人的私聊里，延时发给他）和投递（主人让她到点在群A 里说一声）
    await injectInto('oneOnOne', 's-dm', [ledger[0], ledger[1]]);
    const ask = w.say('oneOnOne', 'principal', '八点记得提醒我，顺便在群A说一声', { addressed: 'to-her', attention: 'attended' }, 500);
    await w.flush();
    await pm.recall({ settingId: w.fp.settings.oneOnOne.id, focusObsId: ask.id, trigger: 'message', sessionId: 's-dm' }, { mode: 'involuntary', deadlineMs: 800, budgetChars: 900 });
    for (const [target, delayMs, text] of [
      ['oneOnOne', 3 * 60 * MINUTE, '到八点啦：记得处理群聊里不能给你设置定时任务的问题'],
      ['gA', 3 * 60 * MINUTE, '大家八点的时候提醒一下，主人要处理定时任务的问题'],
    ]) {
      const a = await pm.expression.appraise({ channel: { targetSettingId: w.fp.settings[target].id, persistence: 'once', delayMs }, text: [text],
        origin: { path: 'tool', sessionId: 's-dm', homeSettingId: w.fp.settings.oneOnOne.id } });
      results.push([text, a.verdict, a.reflection ?? '']);
    }
    const blocked = results.filter((r) => r[1] !== 'speak');
    assert.deepEqual(blocked, [], `一句都不拦：${JSON.stringify(blocked)}`);
    assert.equal(llm.callsFor('review').length, 0, '非公开目标：审视 0 次');
    assert.equal((emb?.calls?.query ?? 0) - q0, 0, '字面上和叮嘱、私下的原话都不重合：0 次 embed');
    assert.ok(!results.some((r) => /换个说法|只说这里该说的/.test(r[2])), '没有任何返回文字要她改写');
    assert.equal(core.store.all("SELECT id FROM utterances WHERE verdict <> 'speak'").length, 0);
  } finally { await w.close(); }
});
