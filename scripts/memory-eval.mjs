#!/usr/bin/env node
// 「有记忆 / 没记忆」对比评测（D126）：node scripts/memory-eval.mjs [--json] [--detail] [--only 用例,用例]
// 每个用例在仓库 .tmp/ 下一个新的临时库里，用真模块把记忆的状态造出来，决定性的那一轮有记忆时真的回想一次、没记忆时只有这个会话自己的聊天记录，
// 按字面打分（决定性的那句在不在她的上下文里；守护守住了没有）。不调模型（替身端口），免费、确定。用例在 packages/core/test/eval/memory-eval.js。
// 只碰临时库：不打开线上库，不需要 DSH。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMemoryEval, formatEvalTable } from '../packages/core/test/eval/memory-eval.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : undefined;
const r = await runMemoryEval({ tmpRoot: path.join(ROOT, '.tmp'), ...(only ? { only } : {}) });
if (args.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(`记忆评测（${r.version}）：${r.on}/${r.total} 个用例在有记忆时拿到了关键内容，没记忆时 ${r.off}/${r.total}；守护 ${r.guardsHeld}/${r.guards}；用时 ${r.ms} ms\n`);
  console.log(formatEvalTable(r));
  if (args.includes('--detail')) for (const c of r.cases) console.log(`\n── ${c.name}（${c.source}）\n${c.error ? `出错：${c.error}` : c.detail}`);
}
process.exitCode = r.cases.every((c) => c.on && c.guard !== false && !c.error) ? 0 : 1;
