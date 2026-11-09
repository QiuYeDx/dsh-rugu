#!/usr/bin/env node
// 跑全部测试：node scripts/run-tests.mjs [core|dsh] [-- 额外的 node --test 参数]
// 核心要 Node ≥ 22.16（node:sqlite 的模块级 backup()，§3.2）。系统自带的 node 太旧时，按顺序找一个能用的：
//   1. 环境变量 PERSONA_MEMORY_NODE；
//   2. npm 自己用的 node（npm_node_execpath：用便携版的 npm.cmd 跑 `npm test` 时就是便携版 node）。
// 都不行就报错退出，不会悄悄跳过测试。这个脚本本身只用老版本 node 也有的 API。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = [22, 16];

function usable(bin) {
  if (!bin || !fs.existsSync(bin)) return false;
  const r = spawnSync(bin, ['-e', "const [a,b]=process.versions.node.split('.').map(Number);require('node:sqlite');process.exit(a>22||(a===22&&b>=16)?0:3)"], { encoding: 'utf8' });
  return r.status === 0;
}
function pickNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const selfOk = (major > MIN[0] || (major === MIN[0] && minor >= MIN[1])) && usable(process.execPath);
  if (selfOk) return process.execPath;
  for (const cand of [process.env.PERSONA_MEMORY_NODE, process.env.npm_node_execpath]) {
    if (cand && cand !== process.execPath && usable(cand)) return cand;
  }
  return null;
}

function findTests(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findTests(p, out);
    else if (/\.test\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const dash = args.indexOf('--');
const extra = dash >= 0 ? args.slice(dash + 1) : [];
const only = (dash >= 0 ? args.slice(0, dash) : args).filter(Boolean);
const packages = only.length ? only : fs.readdirSync(path.join(ROOT, 'packages'));
const files = packages.flatMap((p) => findTests(path.join(ROOT, 'packages', p, 'test'))).sort();

const node = pickNode();
if (!node) {
  console.error(`需要 Node ≥ ${MIN.join('.')}（带 node:sqlite）。当前是 ${process.version}。`);
  console.error('设置环境变量 PERSONA_MEMORY_NODE 指向合适的 node.exe，或者用那个版本的 npm 来跑 npm test。');
  process.exit(1);
}
if (!files.length) {
  console.error('没有找到测试文件');
  process.exit(1);
}
const r = spawnSync(node, ['--disable-warning=ExperimentalWarning', '--test', ...extra, ...files.map((f) => path.relative(ROOT, f))], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
