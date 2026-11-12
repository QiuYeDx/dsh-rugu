// D169 场景（真模块：createPersonaMemory + 假平台 + FakeLLM）：后台模型连不上的时候，她想起来的不因此变少——
// 主人私聊里说了工作上的变动（她第一眼看过，有一句不带细节的说法），主人给一个群定了「这里最多说个大概」（B4 封顶，D113 起非公开目标上
// 只有它还走第二段）。第二段评估一直失败：
//   - onFailure = give（默认）：有意回想里这件事照样在，给的是不带细节的那一句（主人的上限照旧由代码执行），不出现「还在想能不能说」；
//   - onFailure = omit：原来的做法，这件事这一轮不给内容（有意回想最多一行「还在想」）；
//   - 公开的场合不管设置，一律不给。
// 假平台的场合属性随种子变：只在这个群对这个种子是非公开、有发出前拦截点的时候断言照给（D113 的非公开目标）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorld, recallAt, platformSeeds, glancer, FakeLLM, MINUTE } from './presence-world.js';
import { strictTarget } from '../../src/discretion/knowledge.js';

const SEEDS = platformSeeds();
const LIVE = { mode: { byAttributes: { closed: 'live', public: 'live' } } };
const SECRET = '我最近工作上要有变动了，下个月换到另一家公司';
const VAGUE = '他最近工作上有些变化';
const PENDING = /还在想这里能不能说/;
const show = (items) => JSON.stringify(items.map((i) => [i.id, i.layer, i.verdict, i.rendered]));

async function run(seed, onFailure, where) {
  const llm = new FakeLLM({ fallback: {
    glance: (req) => glancer((t) => (/换到另一家公司/.test(t.text) ? { sens: 0.3, vague: VAGUE } : {}))(req),
    appraise: Object.assign(new Error('后台模型连不上'), { code: 'LLM_DOWN' }),
    extract: [], summary: [], rewrite: [], sleep: [], review: [{ verdict: 'speak', reflection: '', reason: '测试' }],
  } });
  const w = await openWorld({ seed, name: `d169-${onFailure}-${where}`, config: { ...LIVE, discretion: { stage2: { onFailure } } }, llm });
  try {
    const said = w.say('oneOnOne', 'principal', SECRET, { addressed: 'to-her', attention: 'attended' });
    w.say('oneOnOne', 'her', '好的，加油');
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const pid = w.perceptOf(said).id;
    w.core.store.run("INSERT INTO rules(kind, target_json, value_json, created_by, at) VALUES ('disclosure', ?, ?, 'owner', ?)",
      JSON.stringify({ settingKey: w.keyOf(where) }), JSON.stringify('share_vague'), w.core.now());
    w.clock.advance(3 * MINUTE);
    w.say(where, 'principal', '大家晚上好', { addressed: 'ambient', attention: 'attended' });
    const ask = w.say(where, 'friend', '@她 你主人最近工作上怎么样', { addressed: 'mentions-her', attention: 'attended' });
    await w.flush();
    const r = await recallAt(w, where, ask, { mode: 'deliberate', deadlineMs: 3000, query: '主人 最近 工作 变动' });
    const aud = w.core.mods.discretion.audienceOf(w.core, w.keyOf(where), w.clock.now());
    const strict = strictTarget(w.core, { audience: aud });
    const rows = w.core.store.all("SELECT verdict, reason, stage FROM appraisals WHERE setting_key = ? AND memory_kind = 'percept' AND memory_id = ?", w.keyOf(where), pid);
    const metrics = Object.fromEntries(w.core.store.all("SELECT name, SUM(value) AS v FROM metrics WHERE name LIKE 'discretion.stage2.fail%' GROUP BY name").map((x) => [x.name, Number(x.v)]));
    return { r, rows, strict, pid, metrics, text: r.items.map((i) => i.rendered).join('\n') };
  } finally { await w.close(); }
}

test('D169：后台模型连不上——非公开的群里照给（给成主人允许的大概、不说「还在想」）；设成 omit 照旧不给；公开场合一律不给', async (t) => {
  let checked = 0;
  let gave = 0;
  for (const seed of SEEDS) {
    for (const where of ['bigGroup', 'smallGroup']) {
      const give = await run(seed, 'give', where);
      const omit = await run(seed, 'omit', where);
      for (const x of [give, omit]) assert.ok(!x.text.includes('换到另一家公司'), `原话不进来（主人定了最多说个大概）：${show(x.r.items)}`);
      // 有判定记录（想起来了、交到了关口①面前）的才比较
      if (!give.rows.length || !omit.rows.length) continue;
      checked += 1;
      if (give.strict) {
        // 公开的 / 说出去就收不回的：不管设置，一律不给
        assert.ok(give.rows.every((row) => row.verdict !== 'share_vague' && !/:give$/.test(row.reason ?? '')), JSON.stringify(give.rows));
        assert.ok(!give.text.includes(VAGUE));
        continue;
      }
      const g2 = give.rows.filter((row) => row.stage === 2);
      assert.ok(g2.length && g2.every((row) => row.verdict === 'share_vague' && /^unavailable:llm:give$/.test(row.reason)), `seed ${seed} ${where}：${JSON.stringify(give.rows)}`);
      assert.ok(give.text.includes(VAGUE), `照给：给的是第一眼的那一句大概 ${show(give.r.items)}`);
      assert.doesNotMatch(give.text, PENDING, '给了内容就不再说「还在想」');
      assert.ok(give.metrics['discretion.stage2.failGive'] >= 1);
      assert.ok(!omit.text.includes(VAGUE), `omit：不给内容 ${show(omit.r.items)}`);
      assert.ok(omit.rows.filter((row) => row.stage === 2).every((row) => row.verdict === 'omit' && row.reason === 'unavailable:llm'));
      assert.ok(omit.metrics['discretion.stage2.failOmit'] >= 1);
      gave += 1;
    }
  }
  t.diagnostic(`交到关口①的：${checked}；非公开目标上照给的：${gave}`);
  assert.ok(gave >= 1, '非公开目标上照给那条路真的走到过');
});
