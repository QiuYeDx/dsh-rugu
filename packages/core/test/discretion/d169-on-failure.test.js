// D169 评估不了的时候照给（discretion.stage2.onFailure，主人在用户反馈第 40 轮定的）：第二段这一步没有结论——LLM 出错、超时、预算不允许、
// 输出解析不了、漏了这一条、这一轮等不到——时，非公开目标上默认照给（当作模型说「能说」，再过代码的底线：主人定的上限照旧），设成 omit 是原来的做法。
// 公开的、受众读不到的、说出去就收不回的目标一律不给；第一段挡掉的照旧挡；照给的带来源标签、不再给「还在想」；「没有结论」不进缓存，
// 下一轮照常评估、按评估的结论办；计数 stage2.failGive / failOmit；判定行看得出是「评估不了、按设置照给」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, appraiseReply } from './world.js';
import { FakeLLM } from '../fakes/index.js';

const metric = (W, name) => Number(W.core.store.get('SELECT SUM(value) AS v FROM metrics WHERE name = ?', `discretion.${name}`)?.v ?? 0);
const row = (W, g) => W.core.store.get('SELECT * FROM appraisals WHERE id = ?', Number(g.appraisalRef.slice(2)));

/**
 * 主人私聊里说的一句工作上的事（她第一眼看过：有一句不带细节的说法）；群 Y（非公开）里主人定了「最多说个大概」（B4 封顶，D113 起非公开目标上
 * 只有它还走第二段）；另有一个公开区、一个说出去就收不回的群（preSendGate:false）。
 */
async function scene(name, { onFailure, llm, config = {} } = {}) {
  const W = await makeWorld({ name, llm: llm ?? new FakeLLM(), config: { ...config, discretion: { ...(config.discretion ?? {}), stage2: { ...(config.discretion?.stage2 ?? {}), ...(onFailure ? { onFailure } : {}) } } } });
  const owner = W.person('主人', { closeness: 1, authority: 'principal' });
  const pal = W.person('小刚', { closeness: 0.4 });
  const dm = W.setting('和主人的私聊', 'oneOnOne');
  W.presence(dm.key, [W.me, owner]);
  const y = W.setting('群Y', 'group');
  W.presence(y.key, [W.me, owner, pal], W.now(), 'recent-speakers', true);
  const pub = W.setting('公开区', 'public');
  const fin = W.setting('说出去就收不回的群', 'group', { capabilities: { preSendGate: false, canHold: false } });
  W.presence(fin.key, [W.me, owner, pal], W.now(), 'recent-speakers', true);
  const p = W.percept({ settingKey: dm.key, actor: owner, text: '我下个月要跳槽去另一家公司了，先别到处说', addressed: 'to-her' });
  W.core.store.run(`INSERT INTO glances(percept_id, setting_key, state, sens, limit_kind, quote, quote_ok, about, asks, mixed, vague, created_at)
                    SELECT id, setting_key, 'done', 0.3, 'soft', '先别到处说', 1, 'speaker', 0, 0, '他最近工作上有变动', ? FROM percepts WHERE id = ?`, W.now(), p);
  W.assess(p, { restriction: 'none', sensitivity: 0.3, involvesOthers: false, attribute: '工作' });
  W.ownerRule({ attribute: '工作' }, 'share_vague');
  const mem = { kind: 'percept', id: p };
  return { W, owner, pal, dm, y, pub, fin, mem };
}

const FAILS = {
  llm: () => new FakeLLM({ fallback: { appraise: Object.assign(new Error('down'), { code: 'LLM_DOWN' }) } }),
  timeout: () => new FakeLLM({ delayMs: 300, fallback: { appraise: appraiseReply('omit') } }),
  budget: () => new FakeLLM({ fallback: { appraise: appraiseReply('omit') } }),
  unparseable: () => new FakeLLM({ fallback: { appraise: '抱歉，我无法判断这些卡片。' } }),
  badVerdict: () => new FakeLLM({ fallback: { appraise: appraiseReply('tell-everyone') } }),
  missing: () => new FakeLLM({ fallback: { appraise: '{"id":"c9","verdict":"omit"}' } }),
};
const REASON = { llm: 'unavailable:llm', timeout: 'unavailable:timeout', budget: 'unavailable:budget', unparseable: 'missing-output', badVerdict: 'bad-output', missing: 'missing-output' };

for (const [mode, mk] of Object.entries(FAILS)) {
  test(`D169 第二段没有结论（${mode}）：give 照给（主人的上限照旧：给成说个大概）、带来源标签、不进缓存；omit 不给`, async () => {
    for (const onFailure of ['give', 'omit']) {
      const llm = mk();
      const { W, pal, y, mem } = await scene(`d169-${mode}-${onFailure}`, { onFailure, llm, config: mode === 'timeout' ? { discretion: { stage2: { timeoutMs: 50 } } } : {} });
      try {
        if (mode === 'budget') W.budget.setLimit('appraise', 0);
        const items = await W.gate([mem], W.target(y.key, { trigger: pal }), { deadlineMs: 3000 });
        const rows = W.appraisals().filter((r) => r.stage === 2);
        assert.equal(rows.length, 1, JSON.stringify(rows));
        assert.equal(rows[0].cache_key, null, '「没有结论」不进缓存');
        assert.equal(rows[0].expires_at, null);
        if (onFailure === 'give') {
          assert.equal(items.length, 1, `${mode}：照给`);
          const g = items[0];
          assert.equal(g.verdict, 'share_vague', '主人定的「最多说个大概」照旧由代码执行');
          assert.equal(g.vagueText, '他最近工作上有变动', '含糊版本用第一眼的（不带名字、数字）');
          assert.equal(g.failGive, true);
          assert.equal(g.stage, 2);
          assert.equal(g.label?.open, true, '带来源标签');
          assert.deepEqual(g.label.limit && { kind: g.label.limit.kind, quote: g.label.limit.quote }, { kind: 'soft', quote: '先别到处说' }, '核对过原话的叮嘱在标签里');
          assert.equal(rows[0].verdict, 'share_vague', '判定行和返回项的结论一样（§9.3.6）');
          assert.equal(rows[0].reason, `${REASON[mode]}:give`, '判定行看得出是「评估不了、按设置照给」');
          assert.equal(row(W, g).id, rows[0].id);
          assert.equal(metric(W, 'stage2.failGive'), 1);
          assert.equal(metric(W, 'stage2.failOmit'), 0);
          assert.ok(!W.logs().some((l) => l.kind === 'omit'), '给了的不记「没说」');
        } else {
          assert.equal(items.length, 0, `${mode}：不给`);
          assert.equal(rows[0].verdict, 'omit');
          assert.equal(rows[0].reason, REASON[mode]);
          assert.equal(metric(W, 'stage2.failOmit'), 1);
          assert.equal(metric(W, 'stage2.failGive'), 0);
          assert.ok(W.logs().some((l) => l.kind === 'omit' && l.memory_id === mem.id));
        }
      } finally { await W.cleanup(); }
    }
  });
}

test('D169 默认值是 give；配置只认 give / omit', async () => {
  const W = await makeWorld({ name: 'd169-default' });
  try { assert.equal(W.core.config.get().discretion.stage2.onFailure, 'give'); } finally { await W.cleanup(); }
  const bad = await makeWorld({ name: 'd169-badcfg', config: { discretion: { stage2: { onFailure: 'maybe' } } } });
  try { assert.equal(bad.core.config.get().discretion.stage2.onFailure, 'give', '不认识的值忽略，用默认'); } finally { await bad.cleanup(); }
});

test('D169 公开目标、说出去就收不回的目标：不管设置，评估不了一律不给', async () => {
  const llm = new FakeLLM({ fallback: { appraise: Object.assign(new Error('down'), { code: 'LLM_DOWN' }) } });
  const { W, pal, pub, fin, mem } = await scene('d169-strict', { onFailure: 'give', llm });
  try {
    // 一条第一段不放行的普通私事（主人私聊里说的、没定上限），在公开目标 / 收不回的群里本来就要第二段
    const p2 = W.percept({ settingKey: W.core.store.get('SELECT setting_key FROM percepts WHERE id = ?', mem.id).setting_key, actor: W.core.store.get('SELECT actor_entity_id FROM percepts WHERE id = ?', mem.id).actor_entity_id, text: '我最近睡得不太好', addressed: 'to-her' });
    W.assess(p2, { restriction: 'none', sensitivity: 0.3, involvesOthers: false });
    for (const k of [pub.key, fin.key]) {
      const items = await W.gate([mem, { kind: 'percept', id: p2 }], W.target(k, { trigger: pal }), { deadlineMs: 3000 });
      assert.deepEqual(items, [], k === pub.key ? '公开目标' : '说出去就收不回');
    }
    assert.ok(W.appraisals().filter((r) => r.stage === 2).every((r) => r.verdict === 'omit' && !/:give$/.test(r.reason)));
    assert.equal(metric(W, 'stage2.failGive'), 0);
    assert.equal(metric(W, 'stage2.failOmit'), 4);
  } finally { await W.cleanup(); }
});

test('D169 第一段挡掉的照旧挡（忘掉的、严格叮嘱、主人的 block 规则），不送去评估；给第三方的敏感私事、主人上限收不出含糊版本的也不照给', async () => {
  const llm = new FakeLLM({ fallback: { appraise: Object.assign(new Error('down'), { code: 'LLM_DOWN' }) } });
  const { W, owner, pal, dm, y } = await scene('d169-floors', { onFailure: 'give', llm });
  try {
    const say = (text, norm) => { const id = W.percept({ settingKey: dm.key, actor: owner, text, addressed: 'to-her' }); W.assess(id, norm); return { kind: 'percept', id }; };
    const strict = say('这件事千万别告诉任何人', { restriction: 'strict', sensitivity: 0.5 });
    const blocked = say('我的工资是一万二', { restriction: 'none', sensitivity: 0.3, attribute: '收入' });
    W.ownerRule({ attribute: '收入' }, 'omit');
    const forgotten = say('上周去看了牙医', { restriction: 'none', sensitivity: 0.2 });
    W.core.store.run("INSERT INTO suppressions(owner_kind, owner_id, state, by, at) VALUES ('percept', ?, 'forgotten', 'owner', ?)", forgotten.id, W.now());
    // 主人定了上限、第一眼没有含糊版本：照给也只能给到「心里有数」，不暗示 → 不给
    const capped = say('我们部门下个月要重组', { restriction: 'none', sensitivity: 0.3, attribute: '部门' });
    W.ownerRule({ attribute: '部门' }, 'share_vague');
    const items = await W.gate([strict, blocked, forgotten, capped], W.target(y.key, { trigger: pal }), { deadlineMs: 3000 });
    assert.deepEqual(items, []);
    const byMem = new Map(W.appraisals().map((r) => [r.memory_id, r]));
    assert.equal(byMem.get(strict.id).rule, 'B1');
    assert.equal(byMem.get(blocked.id).rule, 'B4');
    assert.equal(byMem.get(forgotten.id).rule, 'suppressed');
    assert.equal(byMem.get(capped.id).verdict, 'omit');
    assert.equal(byMem.get(capped.id).reason, 'unavailable:llm', '底线收成 omit 的不算照给');
    assert.ok(JSON.parse(byMem.get(capped.id).floors_json ?? '[]').some((f) => f.floor === 'vague:missing'));
    assert.equal(llm.callsFor('appraise').every((c) => !/千万别告诉|工资|牙医/.test(c.messages[0].content)), true, '第一段挡掉的不送去评估');
    assert.equal(metric(W, 'stage2.failGive'), 0);
  } finally { await W.cleanup(); }
});

test('D169 下一轮评估成功时按评估的结论办（「没有结论」没有缓存下来）；评估成功的结论照常进缓存', async () => {
  const llm = new FakeLLM({ script: { appraise: [Object.assign(new Error('down'), { code: 'LLM_DOWN' })] }, fallback: { appraise: appraiseReply('omit') } });
  const { W, pal, y, mem } = await scene('d169-next', { onFailure: 'give', llm });
  try {
    const t = () => W.target(y.key, { trigger: pal });
    let items = await W.gate([mem], t(), { deadlineMs: 3000 });
    assert.equal(items[0]?.failGive, true, '这一轮评估不了：照给');
    items = await W.gate([mem], t(), { deadlineMs: 3000 });
    assert.equal(llm.callsFor('appraise').length, 2, '下一轮照常评估，不拿上一轮的「照给」当结论');
    assert.deepEqual(items, [], '评估说不提：按评估的结论办');
    const last = W.appraisals().at(-1);
    assert.equal(last.verdict, 'omit');
    assert.ok(last.cache_key, '评估成功的结论照常进缓存');
    items = await W.gate([mem], t(), { deadlineMs: 3000 });
    assert.equal(llm.callsFor('appraise').length, 2, '第三轮用缓存');
    assert.deepEqual(items, []);
  } finally { await W.cleanup(); }
});

test('D169 这一轮等不到第二段（截止时间到了）：give 这一轮就给、不给「还在想」；第二段在后台判完进缓存，下一轮按它；omit 照旧（有意回想给 pending）', async () => {
  for (const onFailure of ['give', 'omit']) {
    for (const mode of ['involuntary', 'deliberate']) {
      const llm = new FakeLLM({ delayMs: 150, fallback: { appraise: appraiseReply({ verdict: 'share_vague', vague: '他工作上有点变化' }) } });
      const { W, pal, y, mem } = await scene(`d169-deadline-${onFailure}-${mode}`, { onFailure, llm });
      try {
        const target = W.target(y.key, { trigger: pal, mode });
        const items = await W.gate([mem], target, { mode, deadlineMs: 20 });
        if (onFailure === 'give') {
          assert.equal(items.length, 1, `${mode}：照给`);
          assert.equal(items[0].verdict, 'share_vague');
          assert.equal(items[0].vagueText, '他最近工作上有变动');
          assert.equal(items[0].failGive, true);
          assert.ok(!items.some((g) => g.verdict === 'pending'), '同一条不既给内容又说「还在想」');
          assert.equal(row(W, items[0]).reason, 'unavailable:deadline:give');
          assert.ok(!W.appraisals().some((r) => r.verdict === 'pending'));
        } else if (mode === 'deliberate') {
          assert.deepEqual(items.map((g) => g.verdict), ['pending'], 'omit：有意回想照旧先给「还在想」');
        } else {
          assert.deepEqual(items, [], 'omit：不自主回想这一轮不给');
        }
        // 第二段在后台判完（进缓存）：下一轮按它的结论（说个大概，用第二段写的含糊版本）
        await new Promise((r) => setTimeout(r, 300));
        const next = await W.gate([mem], W.target(y.key, { trigger: pal, mode }), { mode, deadlineMs: 3000 });
        assert.equal(next[0]?.verdict, 'share_vague', `${onFailure}/${mode}`);
        assert.equal(next[0].vagueText, '他工作上有点变化');
        assert.equal(next[0].cached, true);
        assert.equal(next[0].failGive, undefined);
      } finally { await W.cleanup(); }
    }
  }
});

test('D169 对外入口 discretion.stage2（没有主人上限的条目、非公开目标）：评估不了时照给成「能说」，返回项带 give: true；omit 照旧', async () => {
  for (const onFailure of ['give', 'omit']) {
    const llm = new FakeLLM({ fallback: { appraise: Object.assign(new Error('down'), { code: 'LLM_DOWN' }) } });
    const { W, owner, pal, dm, y } = await scene(`d169-entry-${onFailure}`, { onFailure, llm });
    try {
      const id = W.percept({ settingKey: dm.key, actor: owner, text: '周末想去爬山', addressed: 'to-her' });
      W.assess(id, { restriction: 'none', sensitivity: 0.1 });
      const ref = `p${id}`;
      const out = await W.D.stage2(W.core, [{ kind: 'percept', id }], W.target(y.key, { trigger: pal }), { deadlineMs: 3000 });
      const r = out.get(ref);
      if (onFailure === 'give') assert.deepEqual([r.verdict, r.give, r.failed], ['share', true, 'llm']);
      else assert.deepEqual([r.verdict, r.give, r.failed], ['omit', undefined, 'llm']);
    } finally { await W.cleanup(); }
  }
});
