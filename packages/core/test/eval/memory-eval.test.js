// 「有记忆 / 没记忆」对比评测（D126）作为测试的一部分：只断言「有记忆」这一列（决定性的内容在她的上下文里、守护守住了）；
// 「没记忆」那一列是基线，只报告（t.diagnostic）。不调模型，确定。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMemoryEval, formatEvalTable, evalFailures, CASES } from './memory-eval.js';
import { REPO_ROOT, TMP_ROOT } from '../helpers.js';

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
  assert.deepEqual(evalFailures(r), [], 'scripts/memory-eval.mjs 的退出码按 evalFailures 定，和这里的判断要一致');
});

test('评测的对错：出错、有记忆时没拿到、守护没守住算不对；只看守护的用例（on 为 null）和「没记忆」那一列不算', () => {
  const r = (cases) => ({ cases });
  assert.deepEqual(evalFailures(r([{ id: 'a', on: true, off: false }, { id: 'g', on: null, off: null, guard: true }])), []);
  assert.deepEqual(evalFailures(r([{ id: 'a', on: false, off: false }])), [{ id: 'a', why: '有记忆时没拿到决定性的内容' }]);
  assert.deepEqual(evalFailures(r([{ id: 'g', on: null, off: null, guard: false }])), [{ id: 'g', why: '守护没守住' }]);
  assert.deepEqual(evalFailures(r([{ id: 'e', on: false, off: false, error: 'X' }])).map((x) => x.id), ['e']);
});

test('scripts/memory-eval.mjs 的退出码：全对 0（含只看守护的用例）；一个用例都没跑 2', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'memory-eval.mjs');
  const guardOnly = CASES.find((c) => c.id === 'unrelated');
  assert.ok(guardOnly, '要一个只看守护的用例来钉退出码（原来守护用例没有 on，全对也退出 1）');
  const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, '--only', 'same-chat,unrelated'], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /守护 1\/1/);
  const none = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, '--only', 'no-such-case'], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(none.status, 2, none.stdout + none.stderr);
});
