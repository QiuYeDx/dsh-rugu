#!/usr/bin/env node
// QQ 桥接白名单补丁（§11.1、§15.2、B15）：把三个记忆工具的完整名字加进 qq-tool-restrict.mjs 的 SAFE_EXACT。
// 照 bili-eyes 这类补丁的规矩（v1:1006-1021）：
//   - 默认只预演：打印要加 / 删哪几行，不写任何文件；加 --apply 才真的改；
//   - 锚点精确匹配：SAFE_EXACT 里去掉首尾空白后恰好是 'todo_write', 的那一行，找不到就报错退出，不硬改（桥接版本变了要人看）；
//   - 第一次改之前备份成 <文件>.bak-persona-memory（已有备份不覆盖）；每一行都带标记 `// persona-memory patch`；
//   - --revert 只删带我们标记的行（别的补丁的行一行不动）；重复执行幂等；桥接升级后重跑一次即可；
//   - 改白名单要彻底重启 DSH 才生效（preset 守卫跟着修订走，热加载不换，附录 G.4），重启前先征得主人同意。
// 用法：node scripts/bridge-whitelist-patch.mjs [--bridge <桥接目录>] [--config <persona-memory.json>] [--apply] [--revert]
//   不给 --bridge 时读配置文件（默认 <DSH 家目录>/persona-memory.json）里的 host.adapters.qq.bridgeDir。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export { MARK, TOOLS, RESTRICT_REL, planPatch, resolveBridgeDir, runPatch } from '../src/host/bridge-whitelist.js';
import { resolveBridgeDir, runPatch } from '../src/host/bridge-whitelist.js';

function parseArgs(argv) {
  const a = { apply: argv.includes('--apply'), revert: argv.includes('--revert') };
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  a.bridge = val('--bridge');
  a.config = val('--config');
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bridgeDir = resolveBridgeDir(args);
  if (!bridgeDir) {
    console.error('不知道桥接在哪：用 --bridge <桥接目录>，或在 persona-memory.json 里写 host.adapters.qq.bridgeDir');
    process.exit(2);
  }
  const r = runPatch({ bridgeDir, apply: args.apply, revert: args.revert });
  if (!r.ok) { console.error(`白名单补丁：${r.error}`); process.exit(1); }
  const verb = args.revert ? '还原' : '加入';
  console.log(`文件：${r.file}`);
  if (r.already?.length) console.log(`已经在白名单里：${r.already.join('、')}`);
  if (!r.changes.length) console.log(args.revert ? '没有带标记的行，不用还原。' : '三个工具都已放行，不用改。');
  for (const c of r.changes) console.log(`${c.op === 'add' ? '+' : '-'} ${c.line.trim()}`);
  if (!args.apply && r.changes.length) console.log(`\n这是预演，什么都没改。确认要${verb}就加 --apply。`);
  if (r.applied) {
    if (r.backup) console.log(`已备份：${r.backup}`);
    console.log(`已${verb}。要彻底重启 DSH 才生效（重启前先征得主人同意；已有的 QQ 会话要重建才拿到新守卫）。`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
