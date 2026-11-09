// 子进程（s01-s02-plans.test.js 的最后一个测试用）：进程里除了 runJobs 再没有别的事在等的时候（命令行工具、批量补提炼的脚本），
// 提炼两次调用之间的间隔（§10.6「两次调用至少隔 5 秒」）也不能让 runJobs 的 Promise 悬空。
// 用法：node plans-spacing-child.mjs <extract.minSpacingMs>；先打印「dir <数据目录>」（父进程负责删），做完打印「jobs-done …」「closed」。
import { makePlansWorld, parcelPlan } from './plans-world.js';

const spacing = Number(process.argv[2] ?? 5000);
const w = await makePlansWorld('spacing', { config: { extract: { minSpacingMs: spacing } } });
process.stdout.write(`dir ${w.dir}\n`);
try {
  // 两段（隔了 30 分钟），同一次 tick 里一起排上提炼任务
  await w.say('oneOnOne', 'principal', '等下去拿快递');
  w.clock.minutes(30);
  await w.say('oneOnOne', 'principal', '在吗');
  w.onExtract('去拿快递', parcelPlan({ intent: false }));
  w.clock.minutes(25);
  await w.tick();
  const r = await w.pm.maintenance.runJobs({});
  process.stdout.write(`jobs-done ${JSON.stringify(r)}\n`);
} finally {
  await w.pm.close();
}
process.stdout.write('closed\n');
