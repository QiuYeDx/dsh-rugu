// 管理页里 D124–D126 的几处：她的经验（列出来、主人确认）、用法说明的写法（设置里切换）、「有记忆 / 没记忆」评测（诊断里看结果、跑一次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { makeFakePm, makeFakeHost } from './fixtures.js';
import { MEMORY_VIEWS } from '../../src/admin/views.js';
import { CONFIG_KEYS } from '../../src/admin/actions.js';

const EVAL = { at: Date.UTC(2026, 10, 8), version: 'memory-eval-1', ms: 650,
  cases: [{ id: 'square-game', name: '跨群接着玩平方游戏（111）', on: true, off: false }, { id: 'secret', name: '叮嘱过别外传', on: true, off: false, guard: true }] };

test('用法说明的写法（D125）：设置里能切（两档、不用确认），设置页显示现在是哪一档；默认是详细指引', async () => {
  assert.deepEqual(CONFIG_KEYS['context.usageStyle'], ['guided', 'purpose']);
  const s = setup();
  const v = await s.view('config');
  assert.equal(v.status, 200);
  assert.equal(v.body.data.usageStyle, 'guided');
  const r = await s.act('config.set', { key: 'context.usageStyle', value: 'purpose' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(s.hostCallsOf('config.set').at(-1).args[0], { context: { usageStyle: 'purpose' } });
  const v2 = await s.view('config');
  assert.equal(v2.body.data.usageStyle, 'purpose');
  assert.equal((await s.act('config.set', { key: 'context.usageStyle', value: 'short' })).status, 400, '只有两档');
});

test('她的经验（D124）：记忆里多一类「经验」；主人确认一条交给核心；确认不了时说清楚为什么', async () => {
  assert.ok(MEMORY_VIEWS.includes('lessons'));
  const pm = makeFakePm({ scenario: 'normal' });
  const seen = [];
  pm.admin.lessons = { confirm: (id) => { seen.push(id); return id === 7 ? { ok: true, ref: 'a7' } : { ok: false, reason: 'superseded' }; } };
  const s = setup({ pm });
  const ok = await s.act('lesson.confirm', { id: 7 });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, [7]);
  const bad = await s.act('lesson.confirm', { id: 8 });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body), /已经有更新的版本/);
});

test('记忆评测（D126）：诊断里显示最近一次的结果（只有用例名、对错和数字）；「跑一次」交给宿主，结果存进核心', async () => {
  const pm = makeFakePm({ scenario: 'normal' });
  let last = null;
  pm.admin.evalResult = { get: () => last, set: (r) => { last = r; return r; } };
  const host = makeFakeHost({ scenario: 'normal' });
  host.memoryEval = { run: async () => { last = { ...EVAL, total: 2, on: 2, off: 0, guards: 1, guardsHeld: 1 }; return last; } };
  const s = setup({ pm, host });
  const d0 = await s.view('diagnostics');
  const r0 = d0.body.data;
  assert.equal(r0.memoryEval, null, '还没跑过');
  assert.equal(r0.memoryEvalCanRun, true);
  const run = await s.act('eval.run');
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.deepEqual(run.body.result, { total: 2, on: 2, off: 0, guards: 1, guardsHeld: 1 });
  const d1 = await s.view('diagnostics');
  const r1 = d1.body.data;
  assert.equal(r1.memoryEval.on, 2);
  assert.equal(r1.memoryEval.cases[1].guard, true);
  assert.doesNotMatch(JSON.stringify(r1.memoryEval), /detail/, '没有内容');
  // 宿主没有评测（老版本）：说现在不可用
  const old = makeFakeHost({ scenario: 'normal' });
  delete old.memoryEval;
  const s2 = setup({ pm, host: old });
  assert.equal((await s2.act('eval.run')).status >= 400, true);
});
