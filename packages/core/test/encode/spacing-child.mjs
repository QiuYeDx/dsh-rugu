// 子进程（extract.test.js 用）：进程里除了这次提炼再没有别的事在等的时候（命令行工具、批量补提炼），
// 两次调用之间的间隔（§10.6）也要撑住事件循环，提炼照样跑完。
// 用法：node spacing-child.mjs <extract.minSpacingMs>；跑完打印「done <状态>」。
import { makeWorld, codeIn, msgIn } from './harness.js';

const spacing = Number(process.argv[2] ?? 300);
const w = await makeWorld({ config: { extract: { minSpacingMs: spacing } } });
try {
  const owner = w.entity('阿杰', { closeness: 1, authority: 'principal' });
  const dm = w.setting('私聊', { exposure: 0 });
  w.percept(dm, owner, '等下去拿快递', { addressed: 'to-her' });
  w.llm.push('extract', (req) => [
    { type: 'narrative', text: '阿杰说等下去拿快递。' },
    { type: 'fact', id: 'f1', subjects: [codeIn(req, '主人')], predicate: '取快递', text: '阿杰要去拿快递', msgRefs: [msgIn(req, '等下去拿快递')] },
  ]);
  // 上一次调用刚刚发生：这一次要等满间隔
  w.core.state.encode.lastCallAt = w.clock.now();
  const outs = await w.extractAll(dm);
  process.stdout.write(`done ${outs.map((o) => o.status).join(',')}\n`);
} finally {
  await w.cleanup();
}
