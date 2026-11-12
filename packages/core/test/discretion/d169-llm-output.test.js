// D169 解析放宽：各家模型典型的输出样子（前言、围栏、数组、多行对象、think 标签、尾部多一句话、中英文冒号混用、空行、行尾逗号），
// 第一眼、第二段评估、外发审视三个用途各自走一遍真模块；现在能解析的输出（DeepSeek 风格，每行一个对象）结果逐字段不变；
// 对抗的（夹着另一个看起来像结果的 JSON、超长、嵌套的围栏、字符串里的 JSON）不把垃圾当成结果。提炼、夜间整理、预取改写、媒体摘一句顺带看。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, appraiseReply } from './world.js';
import { FakeLLM } from '../fakes/index.js';
import { openWorld, platformSeeds, glancer } from '../scenarios/presence-world.js';
import { parseJsonlObjects } from '../../src/discretion/util.js';
import { readJsonObjects, stripThinking, jsonValueInLine } from '../../src/ports/llm-text.js';
import { parseJsonl, parseJsonlWith } from '../../src/encode/parse.js';
import { parseJsonLines } from '../../src/consolidate/util.js';
import { parseRewrite } from '../../src/retrieve/prefetch.js';
import { cleanSummary } from '../../src/intake/media.js';

/** D169 以前的 parseJsonlObjects（原样抄下来做参照）。 */
function oldParse(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim().replace(/^```(?:json|jsonl)?/i, '').replace(/```$/, '').trim();
    if (!s || s[0] !== '{') continue;
    try { const o = JSON.parse(s); if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** 各家模型典型的输出样子：拿一组对象，排成那个样子的文字。 */
const SHAPES = {
  jsonl: (os) => os.map((o) => JSON.stringify(o)).join('\n'),
  preamble: (os) => `好的，以下是结果：\n${os.map((o) => JSON.stringify(o)).join('\n')}`,
  fence: (os) => `\`\`\`json\n${os.map((o) => JSON.stringify(o)).join('\n')}\n\`\`\``,
  array: (os) => JSON.stringify(os),
  arrayPretty: (os) => JSON.stringify(os, null, 2),
  multiline: (os) => os.map((o) => JSON.stringify(o, null, 2)).join('\n'),
  think: (os) => `<think>\n先看第一张卡片……{"id":"c1","verdict":"omit"} 不对，再想想。\n</think>\n${os.map((o) => JSON.stringify(o)).join('\n')}`,
  tail: (os) => `${os.map((o) => JSON.stringify(o)).join('\n')}\n以上就是我的判断，如有需要可以再调整。`,
  colons: (os) => os.map((o) => JSON.stringify(o).replace(/":/g, '"：').replace(/,"/g, '，"')).join('\n'),
  blankLines: (os) => `\n\n${os.map((o) => JSON.stringify(o)).join('\n\n')}\n\n`,
  trailingComma: (os) => os.map((o) => `${JSON.stringify(o).replace(/}$/, ',}')},`).join('\n'),
  fencedArrayWithPreamble: (os) => `结果如下：\n\`\`\`json\n${JSON.stringify(os, null, 2)}\n\`\`\`\n希望有帮助。`,
};

const SAMPLE = [
  { id: 'c1', flow: '主人说给我的', judgement: '日常', verdict: 'share', hint: false, reason: '不敏感' },
  { id: 'c2', flow: '阿明私下说的', judgement: '私事', verdict: 'share_vague', vague: '他最近有点事', reason: '别人的事' },
  { id: 'c3', flow: '…', judgement: '…', verdict: 'omit', reason: '会伤到人' },
];

test('D169 解析：每一种样子都取得出同样的对象，字段逐个相同', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const got = parseJsonlObjects(shape(SAMPLE));
    assert.deepEqual(got, SAMPLE, `${name}：${shape(SAMPLE).slice(0, 80)}`);
  }
});

test('D169 解析：现在能解析的输出（DeepSeek 风格、现有测试里的样例）放宽以后结果逐字段相同', () => {
  const cases = [
    SHAPES.jsonl(SAMPLE),
    '```json\n{"id":"c1","verdict":"share"}\n```',
    '```jsonl\n{"id":"c1","verdict":"share"}\n{"id":"c2","verdict":"omit","reason":"有 } 和 { 的理由"}\n```',
    '{"i":1,"sens":0.1,"limit":"none","quote":"","about":"speaker","asks":false,"gist":"在吗","vague":"一件平常的事","replaces":null,"applies":[]}',
    '{"verdict":"speak","reflection":"","reason":"测试"}',
    '这不是 JSON',
    '[{"id":"c1"}]'.slice(0, 0) + '{"id":"c1","verdict":"tell-everyone"}',
    '说明：下面每行一个\n{"id":"c1","verdict":"share"}\n没有了',
    '{"id":"c1","verdict":"share"}\n{"id":"c1","verdict":"omit"}',
    '{"a":{"b":[1,2,{"c":"}"}]}}',
    '',
  ];
  for (const t of cases) assert.deepEqual(parseJsonlObjects(t), oldParse(t), t);
  // 随机拼：每行要么是一个合法的对象、要么是不带括号的散文、要么是空行 → 新旧一样
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const prose = ['好的', '以下是结果', '以上', '这件事不敏感：可以说', '“引号”和\\反斜杠', '   '];
  for (let k = 0; k < 300; k++) {
    const lines = [];
    const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.6) lines.push(JSON.stringify({ id: `c${i + 1}`, verdict: ['share', 'omit', 'share_vague'][Math.floor(rnd() * 3)], reason: prose[Math.floor(rnd() * prose.length)], n: Math.floor(rnd() * 100) }));
      else lines.push(prose[Math.floor(rnd() * prose.length)]);
    }
    const t = lines.join(rnd() < 0.5 ? '\n' : '\r\n');
    assert.deepEqual(parseJsonlObjects(t), oldParse(t), t);
  }
});

test('D169 解析：对抗的输出不把垃圾当成结果', () => {
  // 夹着另一个看起来像结果的 JSON：按行写好的那一份排在前面（第二段、第一眼按 id 取第一个，外发审视取第一个合格的）
  const decoy = '比如这样写 {"id":"c1","verdict":"share"} 这种格式，但我的判断是：\n{"id":"c1","verdict":"omit","reason":"私事"}';
  assert.equal(parseJsonlObjects(decoy)[0].verdict, 'omit');
  // 思考里的草稿不算
  assert.deepEqual(parseJsonlObjects('<think>{"id":"c1","verdict":"share"}</think>\n{"id":"c1","verdict":"omit"}'), [{ id: 'c1', verdict: 'omit' }]);
  assert.deepEqual(parseJsonlObjects('<think>想了很久，{"id":"c1","verdict":"share"} 还没想完'), [], '思考被截断：什么都不取');
  assert.deepEqual(parseJsonlObjects('（开头被吃掉的思考）{"id":"c1","verdict":"share"}</think>\n{"id":"c1","verdict":"omit"}'), [{ id: 'c1', verdict: 'omit' }]);
  // 字符串里的 JSON 不是结果；嵌在别的对象里的「结果」不展开
  assert.deepEqual(parseJsonlObjects('{"note":"{\\"id\\":\\"c1\\",\\"verdict\\":\\"share\\"}"}'), [{ note: '{"id":"c1","verdict":"share"}' }]);
  assert.deepEqual(parseJsonlObjects('{"example":{"id":"c1","verdict":"share"}}').map((o) => o.id), [undefined]);
  // 嵌套的围栏
  assert.deepEqual(parseJsonlObjects('```\n```json\n{"id":"c1","verdict":"share"}\n```\n```'), [{ id: 'c1', verdict: 'share' }]);
  // 超长：一大串「{」、一大段垃圾，很快返回，不报错
  const t0 = performance.now();
  const bomb = `${'{'.repeat(200_000)}${'[}'.repeat(50_000)}{"id":"c1","verdict":"share"`;
  assert.deepEqual(parseJsonlObjects(bomb), []);
  assert.ok(performance.now() - t0 < 2000, `超长输出 ${Math.round(performance.now() - t0)} ms`);
  // 不是对象的 JSON（数字、字符串、数组里的数字）不算
  assert.deepEqual(parseJsonlObjects('[1,2,3]\n"share"\n42\n[1] 是第一行'), []);
  // 括号不成对、引号不配对：跳过那一段，后面好的照取
  assert.deepEqual(parseJsonlObjects('{"id":"c1","verdict":"sha\n{"id":"c2","verdict":"omit"}'), [{ id: 'c2', verdict: 'omit' }]);
});

test('D169 解析：think 标签的几种写法；没有标签原样返回', () => {
  assert.equal(stripThinking('{"a":1}'), '{"a":1}');
  assert.equal(stripThinking('<think>x</think>\n{"a":1}').trim(), '{"a":1}');
  assert.equal(stripThinking('<THINKING foo="1">x\ny</THINKING>{"a":1}'), '{"a":1}');
  assert.equal(stripThinking('<reasoning>x</reasoning><think>y</think>答'), '答');
  assert.equal(stripThinking('答<think>没完'), '答');
  assert.equal(stripThinking('前面的思考</think>答'), '答');
  assert.equal(readJsonObjects('<think>{"x":1}</think>').objects.length, 0);
  assert.deepEqual(jsonValueInLine('1. {"type":"fact","text":"a"} 以上'), { type: 'fact', text: 'a' });
  assert.deepEqual(jsonValueInLine('[1] {"type":"fact"}'), { type: 'fact' }, '行里好几个值：取带对象的');
});

// ── 三个用途走真模块 ────────────────────────────────────────────────────────

/** FakeLLM 的回复函数：先按原来的生成对象，再排成某个样子的文字。 */
const shaped = (gen, shape) => async (req) => shape(await gen(req));

test('D169 第二段评估：各家的输出样子都判得出结论（四种结论落地、含糊版本照收），结论和 JSONL 一样', async () => {
  const gen = appraiseReply(['share', { verdict: 'share_vague', vague: '有人提过最近在复习' }, 'omit']);
  for (const [name, shape] of Object.entries(SHAPES)) {
    const W = await makeWorld({ name: `d169-ap-${name}`, llm: new FakeLLM({ fallback: { appraise: shaped(gen, shape) } }) });
    try {
      const ming = W.person('阿明', { closeness: 0.6 });
      const friend = W.person('小红', { closeness: 0.5 });
      const dm = W.setting('和阿明的私聊', 'oneOnOne');
      W.presence(dm.key, [W.me, ming]);
      const club = W.setting('小群', 'exactGroup');
      W.presence(club.key, [W.me, friend]);
      const facts = ['阿明最近在加班', '阿明在准备考研', '阿明和女朋友吵架了'].map((text) => {
        const m = W.assertion({ text, subjects: [ming], sources: [{ speaker: ming, perceivedIn: dm.key }] });
        W.D.writeNorm(W.core, m, { restriction: 'none', sensitivity: 0.3, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
        return m;
      });
      const out = await W.D.stage2(W.core, facts, W.target(club.key, { trigger: friend }), { deadlineMs: 3000 });
      const got = facts.map((m) => out.get(W.ref(m)));
      assert.deepEqual(got.map((r) => [r.verdict, r.vagueText ?? null, !!r.failed]),
        [['share', null, false], ['share_vague', '有人提过最近在复习', false], ['omit', null, false]], name);
      const rows = W.core.store.all('SELECT reason, cache_key FROM appraisals WHERE stage = 2 ORDER BY id');
      assert.ok(rows.every((r) => r.cache_key && !/bad-output|missing-output/.test(r.reason ?? '')), `${name}：${JSON.stringify(rows)}`);
    } finally { await W.cleanup(); }
  }
});

test('D169 外发审视：各家的输出样子都读得出结论（公开目标的审视不再因为格式变成「审不了」）', async () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    const llm = new FakeLLM({ fallback: { review: shape([{ verdict: 'reconsider', reflection: '这是私下说的', reason: '测试' }]) } });
    const W = await makeWorld({ name: `d169-rv-${name}`, llm });
    try {
      const owner = W.person('主人', { closeness: 1, authority: 'principal' });
      const dm = W.setting('和主人的私聊', 'oneOnOne');
      W.presence(dm.key, [W.me, owner]);
      const post = W.setting('公开帖子', 'public', { capabilities: { preSendGate: true, canHold: false } });
      const fact = W.assertion({ text: '主人在找新工作，下周三去面试', subjects: [owner], sources: [{ speaker: owner, perceivedIn: dm.key }] });
      W.D.writeNorm(W.core, fact, { sensitivity: 0.6, originExposure: { exposureRank: 0, persistenceRank: 1, settingKey: dm.key } });
      W.session('s-dm', dm.key, { ledger: [W.ref(fact)] });
      W.adapter();
      const a = await W.D.appraise(W.core, {
        channel: { targetSettingId: post.sid, persistence: 'once' }, text: ['大家晚上好'],
        origin: { path: 'tool', sessionId: 's-dm', homeSettingId: dm.sid },
      });
      assert.equal(llm.callsFor('review').length, 1, name);
      assert.equal(a.verdict, 'reconsider', `${name}：${a.verdict}`);
      assert.equal(a.reflection, '这是私下说的', name);
    } finally { await W.cleanup(); }
  }
});

test('D169 第一眼：各家的输出样子都写得进去（不再整批按失败算）', async () => {
  const SEED = platformSeeds()[0];
  for (const [name, shape] of Object.entries(SHAPES)) {
    if (name === 'think') continue;   // think 样子里的草稿行用的是第二段的字段，第一眼单独测在下面
    const w = await openWorld({ seed: SEED, name: `d169-gl-${name}`, config: { mode: { byAttributes: { closed: 'live', public: 'live' } } },
      llm: new FakeLLM({ fallback: { glance: shaped(glancer(), shape) } }) });
    try {
      const a = w.say('oneOnOne', 'principal', '我体检结果出来了，别外传', { addressed: 'to-her', attention: 'attended' });
      await w.flush();
      await w.core.mods.discretion.glancesIdle(w.core);
      const g = w.core.mods.discretion.glancesOf(w.core, [w.perceptOf(a).id]).get(w.perceptOf(a).id);
      assert.equal(g?.state, 'done', name);
      assert.equal(g.limit, 'strict', name);
      assert.ok(g.sens >= 0.5, name);
    } finally { await w.close(); }
  }
  // 思考里写了一份不一样的草稿（「不敏感、没叮嘱」）：以思考之后的为准
  const w = await openWorld({ seed: SEED, name: 'd169-gl-think', config: { mode: { byAttributes: { closed: 'live', public: 'live' } } },
    llm: new FakeLLM({ fallback: { glance: async (req) => { const os = glancer()(req); return `<think>\n${os.map((o) => JSON.stringify({ ...o, sens: 0, limit: 'none', quote: '' })).join('\n')}\n</think>\n${SHAPES.fence(os)}`; } } }) });
  try {
    const a = w.say('oneOnOne', 'principal', '我体检结果出来了，别外传', { addressed: 'to-her', attention: 'attended' });
    await w.flush();
    await w.core.mods.discretion.glancesIdle(w.core);
    const g = w.core.mods.discretion.glancesOf(w.core, [w.perceptOf(a).id]).get(w.perceptOf(a).id);
    assert.equal(g?.state, 'done');
    assert.equal(g.limit, 'strict', '思考里的草稿不算');
  } finally { await w.close(); }
});

// ── 其他用途 ──────────────────────────────────────────────────────────────

test('D169 提炼、夜间整理：去掉 think 标签（里面的草稿行既不当结果、也不算坏行）；原来能解析的照旧', () => {
  const body = '{"type":"header","text":"一段"}\n{"type":"fact","text":"他在加班"}';
  assert.deepEqual(parseJsonl(body), { lines: [{ type: 'header', text: '一段' }, { type: 'fact', text: '他在加班' }], errors: 0 });
  const withThink = `<think>\n草稿：{"type":"fact","text":"他辞职了"}\n还要再想\n</think>\n${body}`;
  assert.deepEqual(parseJsonl(withThink), parseJsonl(body));
  assert.deepEqual(parseJsonlWith(`<think>{"type":"review"}</think>\n{"type":"review","id":1}`, new Set(['review'])), { lines: [{ type: 'review', id: 1 }], errors: 0 });
  // 中文冒号、行尾逗号、一行数组、前言里的对象：都认
  assert.deepEqual(parseJsonl('{"type"："fact"，"text"："a"},\n好的：{"type":"fact","text":"b"}\n[{"type":"fact","text":"c"}]').lines.map((l) => l.text), ['a', 'b', 'c']);
  // 夜间整理（小结同一个解析器）：没有「{」的行不算坏行；思考里的不算
  assert.deepEqual(parseJsonLines(`<think>{"type":"x","text":"草稿"}</think>\n以下是结果：\n{"type":"line","text":"今天"}\n{"type":"line","text":"晚上"},\n[{"type":"line","text":"夜里"}]`),
    { lines: [{ type: 'line', text: '今天' }, { type: 'line', text: '晚上' }, { type: 'line', text: '夜里' }], errors: 0 });
  assert.deepEqual(parseJsonLines('{"type":"line","text":"今天"}\n{"no":"type"}\n{坏的'), { lines: [{ type: 'line', text: '今天' }], errors: 2 });
});

test('D169 预取改写、媒体摘一句：去掉 think 标签；本来就宽容的照旧', () => {
  const r = parseRewrite('<think>{"cues":["草稿"]}</think>\n```json\n{"cues":["上周的游戏"],"about":[],"time":"上周","where":null,"shape":null}\n```');
  assert.deepEqual(r.cues, ['上周的游戏']);
  assert.equal(r.time, '上周');
  assert.deepEqual(parseRewrite('好的：{"cues":["a","b"],}').cues, ['a', 'b'], '行尾逗号');
  assert.deepEqual(parseRewrite('<think>想想</think>\n1. 上周的游戏\n2. 奶茶').cues, ['上周的游戏', '奶茶']);
  assert.equal(cleanSummary('<think>\n这是一张图，我来描述\n</think>\n一只小狗在草地上跑', 80), '一只小狗在草地上跑');
  assert.equal(cleanSummary('好的，以下是描述：\n一只小狗在草地上跑', 80), '一只小狗在草地上跑');
  assert.equal(cleanSummary('一只小狗在草地上跑', 80), '一只小狗在草地上跑');
  assert.equal(cleanSummary('<think>没想完', 80), null);
});
