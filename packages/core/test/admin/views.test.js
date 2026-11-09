// 管理页的数据面（§13.1）：列表、详情、模拟器。主人看得到全部（含隐藏的，§9.3.7 第 3 条）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../../src/contract/errors.js';
import { DAY } from '../fakes/index.js';
import {
  adminCore, seedSetting, seedEntity, seedPercept, seedWindow, seedAssertion, seedEpisode, seedImpression, seedIdentity, seedInjection,
} from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};

function data(core) {
  const sk = seedSetting(core, { label: '读书会' });
  const A = seedEntity(core, { name: '阿明' });
  const B = seedEntity(core, { name: '小红' });
  const p1 = seedPercept(core, { settingKey: sk, actor: A, text: '我表哥开网约车' });
  const p2 = seedPercept(core, { settingKey: sk, actor: B, text: '周末去爬山' });
  const w = seedWindow(core, { settingKey: sk, perceptIds: [p1, p2] });
  const a1 = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [A], speaker: A, perceptIds: [p1], settingKey: sk });
  const a2 = seedAssertion(core, { text: '阿明的表哥换工作了', subjects: [A], speaker: A, perceptIds: [p1], settingKey: sk, supersedes: a1 });
  const a3 = seedAssertion(core, { text: '小红周末去爬山', subjects: [B], speaker: B, perceptIds: [p2], settingKey: sk });
  core.store.run('INSERT INTO same_type(a, b) VALUES (?, ?)', Math.min(a1, a3), Math.max(a1, a3));
  const e = seedEpisode(core, { settingKey: sk, narrative: '读书会上阿明聊起他表哥', participants: [A, B], perceptIds: [p1, p2] });
  seedImpression(core, { entityId: A, text: '阿明很照顾家人', evidence: [`a${a1}`] });
  seedIdentity(core, { entityId: A });
  seedInjection(core, { sessionId: 'sess-9', refs: [`a${a2}`] });
  core.mods.admin.suppress(core, `a${a3}`, { state: 'hidden', by: 'owner', at: core.now() });
  return { sk, A, B, p1, p2, w, a1, a2, a3, e };
}

test('list：各类列表、筛选、分页游标；隐藏的照样列出来并标明状态', withCore('adm-list', (core) => {
  const d = data(core);
  const all = core.mods.admin.list(core, { view: 'memories' });
  assert.equal(all.total, 3);
  assert.ok(all.items.some((x) => x.ref === `a${d.a3}` && x.state === 'hidden' && x.text === '小红周末去爬山'), '主人看得到隐藏的');
  assert.deepEqual(core.mods.admin.list(core, { view: 'assertions', entityId: d.A, current: true }).items.map((x) => x.ref), [`a${d.a2}`]);
  assert.deepEqual(core.mods.admin.list(core, { view: 'assertions', state: 'hidden' }).items.map((x) => x.ref), [`a${d.a3}`]);
  assert.deepEqual(core.mods.admin.list(core, { view: 'assertions', state: 'active' }).items.length, 2);
  assert.deepEqual(core.mods.admin.list(core, { view: 'assertions', q: '爬山' }).items.map((x) => x.ref), [`a${d.a3}`]);
  assert.deepEqual(core.mods.admin.list(core, { view: 'assertions', q: '100%_' }).items, [], '搜索词里的 % _ 不当通配符');
  // 分页
  const p1 = core.mods.admin.list(core, { view: 'assertions', limit: 2 });
  assert.equal(p1.items.length, 2);
  assert.ok(p1.next);
  const p2 = core.mods.admin.list(core, { view: 'assertions', limit: 2, next: p1.next });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.next, undefined);
  assert.equal(new Set([...p1.items, ...p2.items].map((x) => x.ref)).size, 3);
  // 其他列表
  assert.equal(core.mods.admin.list(core, { view: 'memories', kind: 'episode' }).items[0].ref, `e${d.e}`);
  assert.equal(core.mods.admin.list(core, { view: 'episodes', entityId: d.B }).total, 1);
  assert.equal(core.mods.admin.list(core, { view: 'people', q: '阿' }).items[0].name, '阿明');
  const settings = core.mods.admin.list(core, { view: 'settings' }).items;
  assert.equal(settings[0].label, '读书会');
  assert.ok(['off', 'live'].includes(settings[0].mode));
  assert.equal(settings[0].doNotRemember, false);
  assert.equal(core.mods.admin.list(core, { view: 'experiences', settingKey: d.sk }).total, 2);
  assert.equal(core.mods.admin.list(core, { view: 'percepts', entityId: d.A }).items[0].text, '我表哥开网约车');
  assert.equal(core.mods.admin.list(core, { view: 'windows' }).items[0].ref, `w${d.w}`);
  assert.equal(core.mods.admin.list(core, { view: 'injections', sessionId: 'sess-9' }).items[0].items[0].id, `a${d.a2}`);
  assert.equal(core.mods.admin.list(core, { view: 'suppressed' }).total, 1);
  assert.equal(core.mods.admin.list(core, { view: 'forgotten' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'intentions' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'discretion' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'holds' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'utterances' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'tombstones' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'backups' }).total, 0);
  assert.equal(core.mods.admin.list(core, { view: 'drills' }).total, 0);
  core.mods.admin.enqueueReview(core, { kind: 'merge', payload: { a: d.A, b: d.B }, reason: 'm' });
  core.mods.admin.notifyNeedToKnow(core, { kind: 'T2', reason: 'harm', at: core.now() });
  core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { settingKey: d.sk }, createdBy: 'owner', at: core.now() });
  assert.equal(core.mods.admin.list(core, { view: 'review' }).total, 1);
  assert.equal(core.mods.admin.list(core, { view: 'needToKnow' }).total, 1);
  assert.equal(core.mods.admin.list(core, { view: 'rules' }).total, 1);
  assert.equal(core.mods.admin.list(core, { view: 'settings' }).items[0].doNotRemember, true);
  assert.throws(() => core.mods.admin.list(core, { view: 'nope' }), ContractError);
  assert.throws(() => core.mods.admin.list(core, /** @type {any} */ ({})), ContractError);
}));

test('搜索（D114）：原话一模一样的旧记忆排第一页第一条（不被许多新的、只沾一两个词的压到后面）；标点不同照样认；词全在的其次；OR 只作最后的退路；分页照常', withCore('adm-search', (core) => {
  const sk = seedSetting(core, { label: '读书会' });
  const T0 = core.now() - 3 * DAY;
  const exact = seedAssertion(core, { text: '我这边收不到群里的消息，只能看到私聊里主人说的话', settingKey: sk, at: T0 });
  // 两天里更新的六十条：都沾着「群里」「消息」「收到」之类的词
  const noise = [];
  for (let i = 0; i < 60; i++) {
    noise.push(seedAssertion(core, { text: [`主人${i}点在群里发了张图片`, `群里有人问消息怎么撤回（${i}）`, `收到主人第${i}条消息`][i % 3], settingKey: sk, at: T0 + (i + 1) * 3_600_000 }));
  }
  // 词全在、但不是这句原话的
  const allWords = seedAssertion(core, { text: '有人收不到群，群里的消息也看不全', settingKey: sk, at: T0 + 100 * 3_600_000 });
  const page1 = core.mods.admin.list(core, { view: 'assertions', q: '收不到群里的消息', limit: 10 });
  assert.equal(page1.items[0].ref, `a${exact}`, '原话一模一样的排第一');
  assert.equal(page1.items[1].ref, `a${allWords}`, '词全在的其次');
  assert.equal(page1.total, 2, '不是一个词沾上就算');
  // 标点、空白不同：照样是第一条
  assert.equal(core.mods.admin.list(core, { view: 'assertions', q: '收不到 群里的消息，只能', limit: 10 }).items[0].ref, `a${exact}`);
  // 整句不在、词也凑不全：退回任意一个词（OR），翻页照常
  const loose = core.mods.admin.list(core, { view: 'assertions', q: '撤回图片', limit: 10 });
  assert.ok(loose.total >= 40, `退回 OR：${loose.total}`);
  assert.ok(loose.next);
  const p2 = core.mods.admin.list(core, { view: 'assertions', q: '撤回图片', limit: 10, next: loose.next });
  assert.equal(p2.items.length, 10);
  assert.equal(new Set([...loose.items, ...p2.items].map((x) => x.ref)).size, 20, '两页不重复');
  // 和别的筛选一起用：只在筛出来的里排
  core.mods.admin.suppress(core, `a${exact}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.list(core, { view: 'assertions', q: '收不到群里的消息', state: 'active' }).items[0].ref, `a${allWords}`);
  assert.equal(core.mods.admin.list(core, { view: 'assertions', q: '收不到群里的消息', state: 'hidden' }).items[0].ref, `a${exact}`);
  // 情节一样
  const oldEp = seedEpisode(core, { settingKey: sk, narrative: '她说自己收不到群里的消息，主人说不是这样', at: T0 });
  for (let i = 0; i < 30; i++) seedEpisode(core, { settingKey: sk, narrative: `群里聊消息第${i}回`, at: T0 + (i + 1) * 3_600_000 });
  assert.equal(core.mods.admin.list(core, { view: 'episodes', q: '收不到群里的消息', limit: 5 }).items[0].ref, `e${oldEp}`);
  assert.ok(noise.length === 60);
}));

test('搜索（D114 集成复核）：换了说法、要找的词排在一长串虚词后面的，照样排第一页（OR 用全部多字词，不只是前 12 个查询词）', withCore('adm-search-para', (core) => {
  const sk = seedSetting(core, { label: '读书会' });
  const T0 = core.now() - 3 * DAY;
  const old = seedAssertion(core, { text: '我这边收不到群里的消息，只能看到私聊里主人说的话', settingKey: sk, at: T0 });
  const Q = '我记得她以前好像跟我说过收不到群消息';
  // 更新的八十条：都沾着「我记得」「她以前」「好像」「跟我说过」这些开头的词
  for (let i = 0; i < 80; i++) seedAssertion(core, { text: [`我记得她以前好像跟我说过第${i}次想吃火锅`, `她以前好像跟我说过${i}点要睡觉，我记得`, `我记得主人以前好像说过第${i}件事`][i % 3], settingKey: sk, at: T0 + (i + 1) * 3_600_000 });
  const terms = [...new Set(core.mods.lang.queryTerms(core, Q))];
  assert.ok(!terms.slice(0, 12).includes('收不'), `前提：要找的词不在前 12 个查询词里（${terms.slice(0, 12).join(' ')}）`);
  const r = core.mods.admin.list(core, { view: 'assertions', q: Q, limit: 10 });
  assert.equal(r.items[0]?.ref, `a${old}`, JSON.stringify(r.items.slice(0, 3).map((x) => x.text)));
}));

test('get：来源链（含原话）、规范、谁知道、版本链、同类的其他几次、注入过它的会话；彻底删除的标 purged', withCore('adm-get', async (core) => {
  const d = data(core);
  const g = core.mods.admin.get(core, `a${d.a2}`);
  assert.equal(g.row.text, '阿明的表哥换工作了');
  assert.equal(g.sources[0].percept.text, '我表哥开网约车');
  assert.equal(g.sources[0].speaker, d.A);
  assert.deepEqual(g.versions.map((v) => v.ref), [`a${d.a1}`, `a${d.a2}`]);
  assert.equal(g.knownBy.length, 1);
  assert.deepEqual(g.injectedIn.map((s) => s.sessionId), ['sess-9']);
  assert.ok(g.norm);
  const g1 = core.mods.admin.get(core, `a${d.a1}`);
  assert.deepEqual(g1.sameType.map((x) => x.ref), [`a${d.a3}`]);
  const n = core.mods.admin.get(core, `n${d.A}`);
  assert.equal(n.names[0].text, '阿明');
  assert.equal(n.identity.length, 1);
  assert.equal(n.impressions[0].text, '阿明很照顾家人');
  const p = core.mods.admin.get(core, `p${d.p1}`);
  assert.deepEqual(new Set(p.derived), new Set([`a${d.a1}`, `a${d.a2}`, `e${d.e}`]));
  assert.deepEqual(p.windows, [`w${d.w}`]);
  assert.equal(core.mods.admin.get(core, 'a99999'), null);
  await core.mods.admin.purge(core, [`a${d.a3}`], { by: 'owner', at: core.now() });
  assert.deepEqual(core.mods.admin.get(core, `a${d.a3}`), { ref: `a${d.a3}`, kind: 'assertion', purged: true, at: core.now() });
  assert.throws(() => core.mods.admin.get(core, 'bogus'), ContractError);
}));

test('simulate：「如果 X 在 Y 说了 Z」——只算召回和分寸：不写感知、不加痕迹、不留下新面孔的档案；被第一段拦下的也列出来', withCore('adm-sim', async (core, t) => {
  core.state.calls = t.calls;
  const d = data(core);
  core.store.run("UPDATE settings SET label = 'sid:setting-y' WHERE key = ?", d.sk);
  const before = {
    percepts: core.store.get('SELECT count(*) AS n FROM percepts').n,
    traces: core.store.get('SELECT count(*) AS n FROM traces').n,
    entities: core.store.get('SELECT count(*) AS n FROM entities').n,
    injections: core.store.get('SELECT count(*) AS n FROM injections').n,
  };
  const stranger = { claims: [{ kind: 'account', namespace: 'zz', id: 'u-stranger', verifiedBy: 'platform' }] };
  const r = await core.mods.admin.simulate(core, { settingId: 'setting-y', as: stranger, text: '阿明他表哥干嘛的' });
  assert.deepEqual(r.items.map((x) => [x.id, x.verdict]), [[`a${d.a2}`, 'share_vague'], [`a${d.a1}`, 'aware_private']]);
  assert.equal(r.items[0].rendered, `渲染:a${d.a2}:share_vague`);
  assert.equal(r.items[1].rendered, '', '没说出口的不渲染');
  assert.equal(t.calls.find((c) => c.name === 'retrieve.render').args[1].settingKey, d.sk, '和真的注入一样按目标场合渲染');
  assert.equal(r.items[1].layer, 'awarePrivate');
  assert.deepEqual(r.decisions.find((x) => x.id === `e${d.e}`), { id: `e${d.e}`, stage: 1, rule: 'B2', verdict: 'omit' });
  assert.equal(r.degradeLevel, 1);
  const sim = t.calls.find((c) => c.name === 'discretion.gate').args[1];
  assert.equal(sim.simulate, true, '判定记录照常写，标模拟');
  assert.equal(sim.triggerEntityId, null, '新面孔：她不认识这个人');
  assert.equal(t.calls.find((c) => c.name === 'retrieve.recall').args[1].query, '阿明他表哥干嘛的');
  assert.deepEqual({
    percepts: core.store.get('SELECT count(*) AS n FROM percepts').n,
    traces: core.store.get('SELECT count(*) AS n FROM traces').n,
    entities: core.store.get('SELECT count(*) AS n FROM entities').n,
    injections: core.store.get('SELECT count(*) AS n FROM injections').n,
  }, before);
  // 认得的人：带上他的实体 id；直接给 refs 时不经召回
  const known = { claims: [{ kind: 'account', namespace: 'zz', id: 'u-amin', verifiedBy: 'platform' }] };
  core.state.knownAs = { 'u-amin': d.A };
  const r2 = await core.mods.admin.simulate(core, /** @type {any} */ ({ settingId: 'setting-y', as: known, text: '', refs: [`a${d.a2}`, `a${d.a3}`, 'junk'] }));
  assert.equal(t.calls.filter((c) => c.name === 'discretion.gate').at(-1).args[1].triggerEntityId, d.A);
  assert.equal(t.calls.filter((c) => c.name === 'retrieve.recall').length, 1, '给了 refs 就不召回');
  assert.deepEqual(r2.items.map((x) => x.id), [`a${d.a2}`]);
  assert.deepEqual(r2.decisions.find((x) => x.id === `a${d.a3}`), { id: `a${d.a3}`, stage: 1, rule: 'suppressed', verdict: 'omit' }, '隐藏的根本想不起来');
  await assert.rejects(core.mods.admin.simulate(core, { settingId: 'never-described', as: stranger, text: 'x' }), ContractError);
  await assert.rejects(core.mods.admin.simulate(core, { settingId: 'setting-y', as: /** @type {any} */ ({ claims: 'x' }), text: 'x' }), ContractError);
  t.ports.logger.assertNoText('表哥', '阿明');
}, {
  mods: (() => {
    return {
      entities: {
        resolveActor: (core, actor, ctx) => {
          const id = actor.claims?.[0]?.id;
          const known = core.state.knownAs?.[id];
          if (known) return { entityId: known, isSelf: false, isPrincipal: false, via: 'identity' };
          const nid = Number(core.store.run("INSERT INTO entities(kind, status, created_at, updated_at) VALUES ('person', 'provisional', ?, ?)", ctx.at, ctx.at).lastInsertRowid);
          return { entityId: nid, isSelf: false, isPrincipal: false, via: 'none' };
        },
      },
      retrieve: {
        recall: async (core, s, opt) => {
          core.state.calls?.push({ name: 'retrieve.recall', args: [s, opt] });
          const refs = core.store.all('SELECT id FROM assertions ORDER BY id DESC').map((r) => `a${r.id}`).concat(core.store.all('SELECT id FROM episodes').map((r) => `e${r.id}`));
          return { items: refs.map((ref) => ({ ref, mref: { kind: ref[0] === 'a' ? 'assertion' : 'episode', id: Number(ref.slice(1)) }, A: 1, P: 1 })), cues: {}, degradeLevel: 1, routeMs: {}, traceId: 'x' };
        },
        render: (core, c, opt) => {
          core.state.calls?.push({ name: 'retrieve.render', args: [c.ref, opt] });
          return { rendered: `渲染:${c.ref}:${opt.verdict}`, provenance: '听人说的', confidence: 0.7 };
        },
      },
      discretion: {
        targetFor: (core, p) => ({ audience: { settingKey: p.settingKey }, homeSettingKey: p.homeSettingKey, sessionId: p.sessionId, triggerEntityId: p.triggerEntityId, taint: false, mode: p.mode }),
        stage1: (core, ref) => (ref.kind === 'episode' ? { decision: 'block', rule: 'B2' } : { decision: 'stage2', rule: 'unassessed' }),
        gate: async (core, cands, target, opt) => {
          core.state.calls?.push({ name: 'discretion.gate', args: [cands, target, opt] });
          const hidden = core.mods.admin.suppressedRefs(core, cands.map((c) => c.ref));
          const out = [];
          for (const c of cands) {
            if (c.ref[0] !== 'a' || hidden.has(c.ref)) continue;
            out.push({ ref: c.ref, verdict: out.length === 0 ? 'share_vague' : 'aware_private', vagueText: null, hintOk: false, appraisalRef: 'ap1', stage: 2, rule: 'stage2' });
          }
          return out;
        },
      },
    };
  })(),
}));

test('list checks（D122）：夜里核对过的事实，默认只列改了的；文字从事实表取（核对表不抄文字），证据给原话', withCore('adm-checks', (core) => {
  const d = data(core);
  const at = core.now();
  const ins = (aid, verdict, rid, ev) => core.store.run(`INSERT INTO memory_checks(assertion_id, at, verdict, result_id, evidence_json, why, before_conf, after_conf, streak, next_at, prompt_ver)
      VALUES (?, ?, ?, ?, ?, '之后说法变了', 0.9, 0.9, 0, ?, 'v')`, aid, at, verdict, rid, JSON.stringify(ev), at + 7 * DAY);
  ins(d.a1, 'corrected', d.a2, [d.p1]);
  ins(d.a3, 'confirmed', null, [d.p2]);
  const changed = core.mods.admin.list(core, { view: 'checks' });
  assert.equal(changed.total, 1);
  const [c] = changed.items;
  assert.deepEqual([c.verdict, c.before.ref, c.before.text, c.after.ref, c.after.text, c.why], ['corrected', `a${d.a1}`, '阿明的表哥开网约车', `a${d.a2}`, '阿明的表哥换工作了', '之后说法变了']);
  assert.deepEqual(c.evidence.map((e) => [e.ref, e.text]), [[`p${d.p1}`, '我表哥开网约车']]);
  assert.equal(core.mods.admin.list(core, { view: 'checks', changed: false }).total, 2);
}));
