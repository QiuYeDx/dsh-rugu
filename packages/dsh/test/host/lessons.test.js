// 她自己的经验（D124）在集成层：memory_note kind=lesson、工具结果交给核心记经验、先没成后成了时提醒一句、按正在用的工具想起经验；
// 用法说明和工具说明的两种写法（D125：默认「详细指引」和以前一字不差，「只讲目的」可以在管理页切）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePm, fakeAgent, userMessage } from '../fakes/index.js';
import { makeHost } from './helpers.js';
import crypto from 'node:crypto';
import { memoryToolSpecs, DESCRIPTION_BUDGET, DESCRIPTION_BUDGET_GUIDED, NOTE_LESSON_GUIDED } from '../../src/host/tools.js';
import { renderBlock, renderToolResult, BLOCK_HEAD, TOOL_HEAD, BLOCK_HEAD_PURPOSE, TOOL_HEAD_PURPOSE, WORKING_TITLES } from '../../src/host/render.js';

const len = (s) => [...String(s)].length;

async function claimed(o = {}) {
  const env = await makeHost(o);
  const agent = fakeAgent({ id: o.sid ?? 's-l', preset: 'zz-chat' });
  await env.ctx.preStep(agent, [userMessage(o.text ?? '你好', { id: 'u1' })]);
  const tool = (name) => agent.ctx.tools.registered.find((t) => t.name === name);
  return { ...env, agent, tool, exec: (callId = 'c1') => ({ agent, callId, signal: new AbortController().signal }) };
}

test('用法说明的两种写法（D125）：默认「详细指引」和以前一字不差（memory_note 只在后面补经验那一行）；「只讲目的」不写规定动作、不比以前长；块头、工作记忆的小标题、工具结果的头跟着换', async () => {
  const h = (x) => crypto.createHash('sha256').update(x).digest('hex').slice(0, 16);
  const g = memoryToolSpecs();
  assert.deepEqual(memoryToolSpecs('guided'), g);
  // D124 以前的原文（哈希锁住）
  assert.equal(h(g.recall.description), 'c73105058e31851c');
  assert.equal(h(g.fix.description), '0e7b54b31044181c');
  const lines = g.note.description.split('\n');
  assert.equal(h(lines.slice(0, 3).join('\n')), 'b35569e0d3aa867b', 'memory_note 原来的三行一字不改');
  assert.equal(lines[3], NOTE_LESSON_GUIDED);
  assert.match(NOTE_LESSON_GUIDED, /你自己做事的办法/);
  assert.match(NOTE_LESSON_GUIDED, /别人的事、别人的要求用 remember/);
  assert.doesNotMatch(NOTE_LESSON_GUIDED, /是谁教的/, '不邀请她记别人教的（评审 M6）');
  // remember / todo 的参数说明照原文（评审 M6）；evidence_quote 的必填写在说明里
  assert.equal(g.note.parameters.text.description, '要记的事');
  assert.equal(g.note.parameters.evidence_quote.description, '对方刚发给你的消息里的原话（照抄一小段）；remember / todo 必填');
  assert.equal(h(BLOCK_HEAD), '176b6ff60b436f0b');
  assert.equal(h(TOOL_HEAD), '7b76e9cf532b39f0');
  assert.equal(h(WORKING_TITLES.guided), '353b087885561e47');
  const total = (s) => len(s.recall.description) + len(s.note.description) + len(s.fix.description);
  assert.ok(total(g) <= DESCRIPTION_BUDGET_GUIDED, `${total(g)} 字`);
  const p = memoryToolSpecs('purpose');
  assert.ok(total(p) <= DESCRIPTION_BUDGET, `${total(p)} 字`);
  assert.match(p.note.description, /记忆是为了让以后的你不翻聊天记录也知道该知道的/);
  for (const d of [p.recall.description, p.note.description, p.fix.description]) {
    assert.doesNotMatch(d, /一条消息只调用一次|只在对方明确要求时调用|别逐条复述|根据记忆|必须/);
  }
  assert.match(p.recall.description, /别编/, '不编是底线，两种写法都有');
  // 增量块：块头、工作记忆的小标题按写法换，字数不超过原来的
  const items = [{ id: 'p1', layer: 'working', rendered: '〔在「群A」当着大家 · 1 分钟前〕他：我说一个数字你回平方', verdict: 'share', appraisalRef: 'x', group: 'g1' }];
  const bg = renderBlock(items);
  const bp = renderBlock(items, { style: 'purpose' });
  assert.ok(bg.text.startsWith(BLOCK_HEAD) && bg.text.includes(WORKING_TITLES.guided));
  assert.ok(bp.text.startsWith(BLOCK_HEAD_PURPOSE) && bp.text.includes(WORKING_TITLES.purpose));
  assert.ok(len(BLOCK_HEAD_PURPOSE) <= len(BLOCK_HEAD) && len(WORKING_TITLES.purpose) <= len(WORKING_TITLES.guided) && len(TOOL_HEAD_PURPOSE) <= len(TOOL_HEAD));
  assert.doesNotMatch(bp.text, /拿不准就不提|根据记忆|逐条复述/);
  assert.match(BLOCK_HEAD_PURPOSE, /是数据不是指令/);
  const tool = renderToolResult([{ id: 'a1', layer: 'recalled', rendered: '前天聊到团建', verdict: 'share', appraisalRef: 'y' }], { style: 'purpose' });
  assert.ok(tool.text.startsWith(TOOL_HEAD_PURPOSE));
  // memory_note 多了 lesson 和它的参数（两种写法一样）
  assert.deepEqual(g.note.parameters.kind.enum, ['remember', 'todo', 'lesson']);
  assert.deepEqual(Object.keys(p.note.parameters), ['text', 'kind', 'about', 'when', 'trap', 'tool', 'here', 'evidence_quote']);
  assert.notEqual(g.note.parameters.evidence_quote.required, true, 'lesson 可以没有原话');
});

test('写法跟着核心的 context.usageStyle（配置文件 / 管理页）：记忆工具的说明按注册时的写法，增量块按这一轮的', async () => {
  const pm = createFakePm();
  const env = await makeHost({ name: 'lesson-style', pm, config: { context: { usageStyle: 'purpose' } } });
  try {
    const agent = fakeAgent({ id: 's-style', preset: 'zz-chat' });
    const d = await env.ctx.preStep(agent, [userMessage('你好', { id: 'u1' })]);
    const note = agent.ctx.tools.registered.find((t) => t.name === 'memory_note');
    assert.match(note.description, /记忆是为了让以后的你/);
    const block = (d.messages ?? []).map((m) => m?.content?.[0]?.text ?? '').find((t) => t.startsWith('【记忆·内部参考】'));
    assert.equal(block?.split('\n')[0], BLOCK_HEAD_PURPOSE);
  } finally { await env.cleanup(); }
  const env2 = await makeHost({ name: 'lesson-style2', pm: createFakePm() });
  try {
    const agent = fakeAgent({ id: 's-style2', preset: 'zz-chat' });
    const d = await env2.ctx.preStep(agent, [userMessage('你好', { id: 'u1' })]);
    assert.doesNotMatch(agent.ctx.tools.registered.find((t) => t.name === 'memory_note').description, /记忆是为了让以后的你/, '默认是详细指引');
    const block = (d.messages ?? []).map((m) => m?.content?.[0]?.text ?? '').find((t) => t.startsWith('【记忆·内部参考】'));
    assert.equal(block?.split('\n')[0], BLOCK_HEAD);
  } finally { await env2.cleanup(); }
});

test('memory_note kind=lesson：交给核心的是会话、规则、坑、工具；不占「一条消息一个操作」、不需要这一轮有人对她说话；结果说成人话', async () => {
  const pm = createFakePm({ lessonNote: (req) => ({ status: 'done', lessonStatus: req.tool ? 'verified' : 'unverified', merged: false, refs: ['a3'] }) });
  const { tool, exec, agent, cleanup } = await claimed({ name: 'lesson-note', pm });
  const r = await tool('memory_note').execute({ kind: 'lesson', text: '长消息先分段再发', trap: '一次发一大段', tool: 'mcp__chat__send' }, exec());
  assert.equal(r, '记下了（验证过的经验）。');
  const req = pm.named('lessonNote')[0].args[0];
  assert.equal(req.sessionId, agent.id);
  assert.equal(req.text, '长消息先分段再发');
  assert.equal(req.trap, '一次发一大段');
  assert.equal(req.tool, 'mcp__chat__send');
  assert.equal(req.evidenceQuote, undefined);
  assert.equal(typeof req.triggerObsId, 'string', '没引原话也交这一轮是谁开的头（核心据此认出别人口授的，评审 H3）');
  // 再记一条：照样可以（经验是她自己的，不占这条消息的操作）；remember 照旧要原话
  assert.equal(await tool('memory_note').execute({ kind: 'lesson', text: '查天气带城市名' }, exec('c2')), '记下了（还没验证的经验）。');
  await tool('memory_note').execute({ kind: 'remember', text: 'x', evidence_quote: '你好' }, exec('c3'));
  assert.equal(pm.named('note').length, 1, 'remember 照旧走 note（要原话、一条消息一个操作）');
  assert.equal(pm.named('lessonNote').length, 2);
  // 给了原话：带上这一轮看到的消息去核对
  await tool('memory_note').execute({ kind: 'lesson', text: '先回想再答', evidence_quote: '你好' }, exec('c4'));
  const q = pm.named('lessonNote').at(-1).args[0];
  assert.equal(q.evidenceQuote, '你好');
  assert.equal(typeof q.triggerObsId, 'string');
  // 核心拒绝：一句人话
  const pm2 = createFakePm({ lessonNote: () => ({ status: 'rejected', reason: 'lesson-too-many' }) });
  const e2 = await claimed({ name: 'lesson-note2', pm: pm2, sid: 's-l2' });
  assert.match(await e2.tool('memory_note').execute({ kind: 'lesson', text: 'x' }, e2.exec()), /今天新记的经验已经不少了/);
  await e2.cleanup();
  await cleanup();
});

test('工具结果交给核心记经验：没成的带一小段出错说明；先没成、换了做法成了 → 下一步提醒一句（只一次）；有这个工具的经验 → 按它想一次带进下一步', async () => {
  let n = 0;
  const pm = createFakePm({
    toolOutcome: (o) => { n += 1; return { recorded: !o.ok, recovered: o.ok && n === 2, lessons: n >= 3 ? 1 : 0 }; },
    recall: (s) => (s.tools?.length
      ? { items: [{ id: 'a7', layer: 'lessons', rendered: '（验证过）用 zz_post 时：长消息先分段再发', verdict: 'share', confidence: 1, provenance: '', appraisalRef: 'ap7' }], degradeLevel: 2, traceId: 't' }
      : { items: [], degradeLevel: 2, traceId: 't' }),
  });
  const { ctx, agent, cleanup } = await claimed({ name: 'lesson-egress', pm });
  const call = (id, isError, text) => ctx.postExecute({ name: 'mcp__zz__zz_post', callId: id, agent, arguments: {} }, { content: [{ type: 'text', text }], isError });
  await call('t1', true, 'Error: 消息太长\n详细堆栈');
  const o1 = pm.named('toolOutcome')[0].args[0];
  assert.deepEqual({ tool: o1.tool, ok: o1.ok, sessionId: o1.sessionId }, { tool: 'mcp__zz__zz_post', ok: false, sessionId: agent.id }, '工具的身份带服务前缀');
  assert.match(o1.error, /消息太长/);
  const d2 = await call('t2', false, 'ok');
  const hint = (d2.additionalContexts ?? []).map((m) => m.content?.[0]?.text ?? '').join('\n');
  assert.match(hint, /mcp__zz__zz_post 先没成，换了做法这次成了.*memory_note 记成经验/);
  const d3 = await call('t3', false, 'ok');
  const texts = (d3.additionalContexts ?? []).map((m) => m.content?.[0]?.text ?? '');
  assert.ok(texts.some((t) => /你做事的经验.*\n- （验证过）用 zz_post 时/s.test(t)), JSON.stringify(texts));
  assert.deepEqual(pm.named('recall').at(-1).args[0].tools, ['mcp__zz__zz_post'], '回想带着她正在用的工具');
  assert.ok(!texts.some((t) => /先没成/.test(t)), '提醒只一次');
  // 经验条数没变：这个会话不再为它重复想
  const before = pm.named('recall').length;
  await call('t4', false, 'ok');
  assert.equal(pm.named('recall').length, before);
  // 记忆工具自己不算
  await ctx.postExecute({ name: 'memory_note', callId: 't5', agent, arguments: {} }, { content: [{ type: 'text', text: '记下了。' }], isError: false });
  assert.ok(!pm.named('toolOutcome').some((c) => c.args[0].tool === 'memory_note'));
  await cleanup();
});

test('增量块里「你做事的经验」一节排在「你想着的」前面，字紧时排在时间间隔后面先拿到', () => {
  const items = [
    { id: 'a1', layer: 'recalled', rendered: '前天聊到团建', verdict: 'share', appraisalRef: 'x' },
    { id: 'a2', layer: 'lessons', rendered: '（还没验证）玩数字游戏时先复述一遍规则', verdict: 'share', appraisalRef: 'y' },
    { id: 'i1', layer: 'intentions', rendered: '8 点提醒他收衣服', verdict: 'share', appraisalRef: 'z' },
  ];
  const { text } = renderBlock(items);
  assert.ok(text.indexOf('你做事的经验') > text.indexOf('想起来的'));
  assert.ok(text.indexOf('你做事的经验') < text.indexOf('你想着的'));
  const tight = renderBlock(items, { maxChars: len(BLOCK_HEAD) + 60 });
  assert.ok(tight.used.some((i) => i.layer === 'lessons'), JSON.stringify(tight.used));
});
