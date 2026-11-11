// 翻看（D156，memory_look）：工具定义和说明、调用核心的参数、结果的渲染和注入记录、没给出东西时的人话；
// QQ 桥接的白名单补丁是旧的时只关掉 memory_look（别的记忆工具照常），自检说得清楚怎么做。数据全是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePm, fakeAgent, userMessage } from '../fakes/index.js';
import { makeHost } from './helpers.js';
import { memoryToolSpecs, LOOK_TEXT, LOOK_DESCRIPTIONS, RECALL_LOOK_GUIDED, RECALL_LOOK_PURPOSE, createMemoryTools } from '../../src/host/tools.js';
import { renderLookResult } from '../../src/host/render.js';
import { whitelistState } from '../../src/host/selfcheck.js';

async function claimed(o = {}) {
  const env = await makeHost(o);
  const agent = fakeAgent({ id: o.sid ?? 's-look', preset: 'zz-chat' });
  await env.ctx.preStep(agent, [userMessage(o.text ?? '你还记得今天上午的事吗', { id: 'u1' })]);
  const tool = (name) => agent.ctx.tools.registered.find((t) => t.name === name);
  return { ...env, agent, tool, exec: (callId = 'c1') => ({ agent, callId, signal: new AbortController().signal }) };
}

test('工具定义：memory_look 有 open / when / where / about；两种写法的说明都短而具体；memory_recall 的说明末尾补一行指向它，原文不动', () => {
  for (const style of ['guided', 'purpose']) {
    const s = memoryToolSpecs(style);
    assert.equal(s.look.name, 'memory_look');
    assert.deepEqual(Object.keys(s.look.parameters), ['open', 'when', 'where', 'about']);
    assert.ok([...s.look.description].length <= 260, `${style}：${[...s.look.description].length} 字`);
    assert.match(s.look.description, /记号/);
    assert.match(s.look.description, /别编/);
    assert.equal(s.recall.description.split('\n').at(-1), style === 'guided' ? RECALL_LOOK_GUIDED : RECALL_LOOK_PURPOSE);
  }
  assert.equal(memoryToolSpecs().look.description, LOOK_DESCRIPTIONS.guided);
});

test('memory_look：open 一个记号 → 交给核心的 look（截止时间同 memory_recall）；结果带说明那一行；记注入账本，层名 memory_look', async () => {
  const pm = createFakePm({
    look: async () => ({ items: [
      { id: 'e7', layer: 'look', rendered: '〔e7〕（今天中午 12:10，你在「小群」经历的）他发了午饭的图', verdict: 'share', confidence: 0.9, provenance: '', appraisalRef: 'ap7' },
      { id: 'p3', layer: 'look', rendered: '〔p3〕（今天中午 12:10，他在「小群」说的）他：「［图片，你看到的：一碗牛肉面］」', verdict: 'share', confidence: 0.9, provenance: '', appraisalRef: 'ap3' },
    ], degradeLevel: 1, traceId: 't', look: { kind: 'open', ref: 'e7', note: '展开〔e7〕；这段经历里有 2 句原话，下面给了 1 句' } }),
  });
  const { tool, exec, cleanup } = await claimed({ pm, name: 'look-open' });
  const text = await tool('memory_look').execute({ open: '〔e7〕' }, exec('l1'));
  const lines = text.split('\n');
  assert.match(lines[0], /^（这是你自己想起来的/);
  assert.match(lines[1], /^展开〔e7〕/);
  assert.match(text, /一碗牛肉面/);
  const [sit, opt] = pm.named('look').at(-1).args;
  assert.equal(opt.open, '〔e7〕');
  assert.equal(opt.deadlineMs, 8000);
  assert.equal(sit.focusObsId, 'obs-u1');
  const inj = pm.named('injected').at(-1).args[0];
  assert.equal(inj.layer, 'memory_look');
  assert.deepEqual(inj.items.map((i) => i.appraisalRef), ['ap7', 'ap3']);
  await cleanup();
});

test('memory_look：when（加 where、about）原样交过去；两样都没给先问；核心没给出东西时按原因说人话', async () => {
  const reasons = ['bad-ref', 'not-found', 'withheld', 'bad-time', 'nothing'];
  let i = 0;
  const pm = createFakePm({ look: async () => ({ items: [], degradeLevel: 1, traceId: 't', look: { kind: 'when', reason: reasons[i++] } }) });
  const { tool, exec, cleanup } = await claimed({ pm, name: 'look-when' });
  assert.equal(await tool('memory_look').execute({}, exec('x')), LOOK_TEXT.ask);
  assert.equal(pm.named('look').length, 0);
  for (const r of reasons) {
    const t = await tool('memory_look').execute({ when: '今天上午', where: '这个群', about: '阿明' }, exec(`w-${r}`));
    assert.equal(t, LOOK_TEXT[r], r);
  }
  const opt = pm.named('look').at(-1).args[1];
  assert.deepEqual([opt.when, opt.where, opt.about, opt.open], ['今天上午', '这个群', '阿明', undefined]);
  assert.equal(LOOK_TEXT.withheld, '这会儿想不起来更具体的了。', '和记忆工具同样的口径');
  assert.equal(pm.named('injected').filter((c) => c.args[0]?.layer === 'memory_look').length, 0, '什么都没给就不记注入');
  await cleanup();
});

test('翻看的渲染：说明那一行在头后面，经过行和展开的正文各有上限，总字数不超过 tools.recollectChars', () => {
  const items = Array.from({ length: 80 }, (_, k) => ({ id: `e${k}`, layer: 'outline', rendered: `〔e${k}〕今天上午 9:${String(k).padStart(2, '0')} · 在这里 · ${'某'.repeat(70)}`,
    verdict: 'share', confidence: 1, provenance: '', appraisalRef: `ap${k}` }));
  const r = renderLookResult({ items, look: { kind: 'when', note: '翻看：今天上午；这段时间有 80 段经历' } }, { tools: { recollectChars: 2000 } });
  assert.match(r.text.split('\n')[1], /^翻看：/);
  assert.ok([...r.text].length <= 2000 + 80);
  assert.ok(r.used.length > 10 && r.used.length < 80);
});

test('白名单补丁是旧的（只缺 memory_look）：只关掉 memory_look，别的记忆工具照常注册', () => {
  const MARK = '// persona-memory patch';
  const lines = ['memory_recall', 'memory_note', 'memory_fix'].map((t) => `  '${t}', ${MARK}`).join('\n');
  const src = `const SAFE_EXACT = new Set([\n  'todo_write',\n${lines}\n])\n`;
  assert.deepEqual(whitelistState(src).missing, ['memory_look']);
  const reg = [];
  const agent = { id: 'a1', ctx: { tools: { register: (d) => { reg.push(d.name); return () => {}; } } } };
  const mt = createMemoryTools({
    getPm: () => null, claims: { get: () => ({ adapterId: 'qq' }), activeBindings: () => [], resolve: () => null }, states: { get: () => ({}) },
    assembler: { modeOf: () => 'live' }, hostConfig: () => ({ tools: { presets: ['*'] } }), log: { warn() {} }, getDefineTool: () => (d) => d, recallNonces: new Map(),
    infoOf: () => ({ id: 'a1', preset: 'x' }), blockedToolFor: (id, name) => id === 'qq' && name === 'memory_look',
  });
  assert.equal(mt.registerOn(agent), true);
  assert.deepEqual(reg.sort(), ['memory_fix', 'memory_note', 'memory_recall']);
});
