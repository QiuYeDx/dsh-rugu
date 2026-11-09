// 分寸底线的性质测试（§14.2「分寸底线」、模块与接口 §4.7 的不变式）：假平台的随机场合属性 + 几种固定场合 × 随机的记忆属性，
// 第二段用一个「被劫持」的模型（永远说能说、永远想暗示），检查任何放行路径都不会让底线命中的条目通过（100%）。
// 期望只按属性组合算（公开程度、留存、名单完整不完整、有没有发出前拦截点），不按场合的名字。
// 失败时打印种子；用 DISCRETION_PROP_SEED / FAKE_PLATFORM_SEED 复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, appraiseReply } from './world.js';
import { FakeLLM } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { exposureRank, persistenceRank, isPublicLike } from '../../src/contract/index.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('性质：底线命中的条目，任何放行路径和第二段都推翻不了（含假平台的随机场合属性）', async (t) => {
  const envSeed = Number(process.env.DISCRETION_PROP_SEED);
  const seed = Number.isInteger(envSeed) && envSeed > 0 ? envSeed : Math.floor(Math.random() * 2 ** 31);
  const fp = createFakePlatform();
  t.diagnostic(`DISCRETION_PROP_SEED=${seed} FAKE_PLATFORM_SEED=${fp.seed}`);
  const rnd = mulberry32(seed);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const llm = new FakeLLM({ fallback: { appraise: appraiseReply({ verdict: 'share', vague: '有人提过一件事', hint: true }) } });
  const W = await makeWorld({ name: 'prop', llm, config: { discretion: { stage2: { perSettingPerHour: 100000 } } } });
  try {
    const owner = W.person('主人', { closeness: 1, authority: 'principal' });
    const friend = W.person('小红', { closeness: 0.5 });
    const stranger = W.person('路人', { closeness: 0 });
    const third = W.person('不在场的人', { closeness: 0.4 });
    const mk1on1 = (label, who, o) => { const s = W.setting(label, 'oneOnOne', o); W.presence(s.key, [W.me, who]); return s; };
    // 目标：每个都只记属性（谁在、名单全不全、公开程度、留存、有没有发出前拦截点）
    const T = {};
    const addT = (name, s, people, complete) => {
      const d = s.descriptor;
      T[name] = { s, people, complete, managerOnly: complete && people.every((p) => p === owner), pubLike: isPublicLike(d),
        expo: exposureRank(d), persist: persistenceRank(d), preSend: !!d.capabilities.preSendGate, stranger1on1: complete && people.length === 1 && people[0] === stranger };
    };
    addT('ownerDm', mk1on1('和主人的私聊', owner), [owner], true);
    addT('friendDm', mk1on1('和小红的私聊', friend), [friend], true);
    addT('strangerDm', mk1on1('和路人的私聊', stranger), [stranger], true);
    addT('web', mk1on1('和小红的网页聊天', friend, { capabilities: { preSendGate: false, canHold: false } }), [friend], true);
    addT('group', W.setting('群', 'group'), [friend, stranger], false);
    addT('pub', W.setting('公开区', 'public'), [stranger], false);
    W.percept({ settingKey: T.group.s.key, actor: friend, text: '在吗' });
    W.percept({ settingKey: T.group.s.key, actor: stranger, text: '嗨' });
    W.percept({ settingKey: T.pub.s.key, actor: stranger, text: '路过' });
    // 假平台的五类场合（属性随机）：私聊给主人，其余的只看得到一个说过话的陌生人
    for (const [k, s] of Object.entries(fp.settings)) {
      const st = W.settingFrom(s.descriptor);
      if (k === 'oneOnOne') { W.presence(st.key, [W.me, owner]); addT(`fp.${k}`, st, [owner], true); continue; }
      W.percept({ settingKey: st.key, actor: stranger, text: '最近怎么样' });
      addT(`fp.${k}`, st, [stranger], false);
    }
    const origins = ['ownerDm', 'friendDm', 'group', 'pub'];
    let checked = 0;
    const violations = [];
    for (let i = 0; i < 200; i++) {
      W.clock.minutes(1);
      const subject = pick([owner, friend, third, stranger]);
      const speaker = rnd() < 0.7 ? subject : pick([owner, friend, third]);
      const fromKey = pick(origins);
      const from = T[fromKey];
      const kind = rnd() < 0.15 ? 'percept' : rnd() < 0.1 ? 'link' : 'assertion';
      let m;
      let norm = null;
      if (kind === 'percept') {
        m = { kind: 'percept', id: W.percept({ settingKey: from.s.key, actor: speaker, text: `第 ${i} 条原话`, visibleTo: from.s.descriptor.audience.size === 2 ? 'participants' : 'setting-audience' }) };
      } else if (kind === 'link') {
        const alt = W.person(`另一个号${i}`);
        m = { kind: 'link', id: W.link(subject, alt, 'same', 'mutual-claim', 1) };
        W.D.writeNorm(W.core, m, { identityLink: true });
      } else {
        m = W.assertion({ text: `第 ${i} 件事`, subjects: [subject], sources: [{ speaker, perceivedIn: from.s.key }] });
        norm = {
          restriction: pick(['none', 'none', 'soft', 'strict']),
          sensitivity: Math.round(rnd() * 100) / 100,
          deny: rnd() < 0.25 ? [pick([owner, friend, stranger])] : undefined,
          allow: rnd() < 0.1 ? [] : undefined,
          derivation: rnd() < 0.15 ? 'inference' : undefined,
          originExposure: { exposureRank: from.expo, persistenceRank: from.persist, settingKey: from.s.key },
        };
        W.D.writeNorm(W.core, m, norm);
        if (speaker === subject && norm.derivation !== 'inference') W.D.recordKnowledge(W.core, m, [{ whoKind: 'entity', whoRef: String(subject), since: W.now(), basis: 'subject' }]);
      }
      const tk = pick(Object.keys(T));
      const tg = T[tk];
      const taint = rnd() < 0.2;
      let sessionId = null;
      if (taint) { sessionId = `s${i}`; W.session(sessionId, tg.s.key, { tainted: true }); }
      const target = W.target(tg.s.key, { sessionId });
      // 「X 声称 B 知道」不改变第一段的结论
      const before = W.D.stage1(W.core, m, target);
      W.D.recordKnowledge(W.core, m, [{ whoKind: 'entity', whoRef: String(tg.people[0]), since: W.now(), basis: 'claimed', claimant: third }]);
      const after = W.D.stage1(W.core, m, target);
      if (before.decision !== after.decision || before.rule !== after.rule) violations.push({ i, why: 'claimed-changed', before, after });
      const items = await W.gate([m], target, { mode: 'deliberate', deadlineMs: 5000 });
      const v = items.find((g) => g.ref === W.ref(m))?.verdict ?? 'none';
      // 返回的每一条都对得上一行判定：同一条记忆、同一个结论（context.recordInjection 照这个核对，§9.3.6）
      for (const g of items) {
        const row = W.core.store.get('SELECT memory_kind, memory_id, verdict FROM appraisals WHERE id = ?', Number(String(g.appraisalRef).slice(2)));
        if (!row || W.ref({ kind: row.memory_kind, id: row.memory_id }) !== g.ref || row.verdict !== g.verdict) violations.push({ i, why: 'untraced', g, row });
      }
      // 独立地算出这一例该守的底线
      // 已经知道的人：事实 = 说自己事的主体本人；原话 = 说话的人；身份对应 = 当事人和管理者
      const knowers = kind === 'link' ? [subject, owner]
        : kind === 'percept' ? [speaker]
          : speaker === subject && norm.derivation !== 'inference' ? [subject] : [];
      // 群里当众说的原话：那时在群里的人按场合级的知道都算知道（§5.6 第 2 条），谁在不好独立算 → 只在新知情者确定存在时检查
      const uncertain = kind === 'percept' && fromKey === 'group' && !tg.pubLike;
      const sameSetting = tk === fromKey;
      const nNonEmpty = !uncertain && !(kind === 'percept' && sameSetting) && (!tg.complete || tg.people.some((p) => !knowers.includes(p)));
      const narrower = from.expo < tg.expo || from.persist < tg.persist;
      const expect = (cond, allowed, why) => { checked += 1; if (cond && !allowed.includes(v)) violations.push({ i, why, v, tk, kind, norm, fromKey }); };
      const notShare = ['none', 'share_vague', 'aware_private', 'pending'];
      // D113：只有公开目标（和说出去就收不回、听的不只是管理者的渠道）还走第二段和封顶；其余目标只跑第一段，底线照样守
      const strictT = tg.pubLike || (!tg.preSend && !tg.managerOnly);
      if (before.decision === 'block') expect(true, ['none'], 'stage1-block');
      if (kind === 'link') expect(!tg.managerOnly && nNonEmpty, ['none'], 'B3');
      if (kind === 'assertion') {
        expect(norm.restriction === 'strict' && nNonEmpty && !tg.managerOnly, ['none'], 'B1-strict');
        expect(!!norm.deny && tg.people.includes(norm.deny[0]) && !tg.managerOnly, ['none'], 'B1-deny');
        expect(!!norm.deny && tg.people.includes(norm.deny[0]) && tg.managerOnly && strictT, notShare, 'B1-deny-manager');
        expect(tg.pubLike && narrower && norm.sensitivity >= 0.5, ['none'], 'B2-omit');
        expect(tg.pubLike && narrower, notShare, 'B2-cap');
        expect(tg.stranger1on1 && subject !== stranger && norm.sensitivity >= 0.7, ['none'], 'B5');
        // 她自己的猜测：永远不经 A1；涉及别人的也不经 A3（断言者是她，不是主体本人）
        if (norm.derivation === 'inference') expect(['A1a', 'A1b', 'A3'].includes(before.rule), [], 'guess-never-A1-A3');
      }
      // 还没评估的原话：离开它自己的场合，N 不为空时最多说个大概（在原场合里当众说的走 A1(b)）——只在公开路径（D113）
      if (kind === 'percept') expect(!sameSetting && nNonEmpty && strictT, notShare, 'unassessed-cap');
      // 带污点（D102）：第一段放行的不再收紧；其余 N 不为空的不给能说——只在公开路径（D113）
      expect(taint && nNonEmpty && before.decision !== 'pass' && strictT, notShare, 'taint');
      // 非公开目标（D113）：不调第二段，给出来的都是第一段的结论（stage 1）
      if (!strictT) for (const g of items) if (g.stage !== 1) violations.push({ i, why: 'open-stage2', g, tk });
      expect(!tg.preSend && !tg.managerOnly && nNonEmpty, ['none', 'share'], 'no-pre-send-gate');
    }
    assert.deepEqual(violations, [], `种子 ${seed} / 假平台 ${fp.seed}`);
    assert.ok(checked > 1200, `只检查了 ${checked} 次`);
  } finally { await W.cleanup(); }
});
