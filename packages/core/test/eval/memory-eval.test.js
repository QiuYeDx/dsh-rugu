// 「有记忆 / 没记忆」对比评测（D126）作为测试的一部分：只断言「有记忆」这一列（决定性的内容在她的上下文里、守护守住了）；
// 「没记忆」那一列是基线，只报告（t.diagnostic）。不调模型，确定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMemoryEval, formatEvalTable, CASES } from './memory-eval.js';
import { TMP_ROOT } from '../helpers.js';

test('有记忆 / 没记忆：每个用例在有记忆时都拿到了决定性的内容，守护都守住（有不相干的记忆作竞争）；没记忆的一列只报告', async (t) => {
  const r = await runMemoryEval({ tmpRoot: TMP_ROOT });
  t.diagnostic(`\n${formatEvalTable(r)}`);
  assert.equal(r.cases.length, CASES.length);
  for (const c of r.cases) {
    assert.equal(c.error, undefined, `${c.id} 出错：${c.error}`);
    if (c.on !== null) assert.equal(c.on, true, `${c.id}：有记忆时没拿到决定性的内容\n${c.detail}`);
    if (typeof c.guard === 'boolean') assert.equal(c.guard, true, `${c.id}：守护没守住\n${c.detail}`);
  }
  assert.ok(r.guards >= 7, '守护用例（评审之后补的：忘掉的不想起、口授的不算验证过、夜里撑不住的不算、主人教的不被取代、不相干的不带出）');
  assert.ok(r.off < r.on, '没记忆时应该比有记忆时拿到的少（否则这些用例测不出记忆的作用）');
});
