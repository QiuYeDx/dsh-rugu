#!/usr/bin/env node
// 提交前检查：这个仓库是公开的，每次提交前按私有词表扫一遍要提交的内容（人设名、账号、本机路径……）。
//   词表不在仓库里：--list <文件> 或环境变量 RUGU_BLOCKLIST；每行一个词（大小写不敏感），# 开头是注释，
//   re: 开头的一行是正则（例如本机路径的写法）。
//   默认扫暂存区（git add 过的内容，也就是要提交的那份）；--all 扫仓库里全部跟踪的文件。
// 用法：node scripts/check-private-words.mjs [--all] [--list <文件>]
//   在 .git/hooks/pre-commit 里调用它（钩子是本机的，不进仓库）。扫到了退出码 1。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXT = /\.(js|mjs|cjs|json|md|html|yml|yaml|svg|txt|css|ps1|sh)$|(^|\/)(LICENSE|\.gitignore)$/i;

/** 读词表：{words: string[], patterns: RegExp[]}。 */
export function readList(file) {
  const words = [];
  const patterns = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    if (l.startsWith('re:')) patterns.push(new RegExp(l.slice(3), 'i'));
    else words.push(l.toLowerCase());
  }
  return { words: [...new Set(words)], patterns };
}

/** 一份文本里扫到的：[{line, hit}]。hit 只说是第几条规则，不把词本身打出来（词表也是私有的）。 */
export function scan(text, { words, patterns }) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const low = line.toLowerCase();
    words.forEach((w, k) => { if (low.includes(w)) out.push({ line: i + 1, hit: `词 #${k + 1}` }); });
    patterns.forEach((p, k) => { if (p.test(line)) out.push({ line: i + 1, hit: `规则 re #${k + 1}` }); });
  });
  return out;
}

const git = (args, opt = {}) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opt });

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--list');
  const file = (i >= 0 ? argv[i + 1] : undefined) || process.env.RUGU_BLOCKLIST;
  if (!file || !fs.existsSync(file)) {
    console.error('没有词表：用 --list <文件> 或环境变量 RUGU_BLOCKLIST 指过去（词表放在仓库外）。');
    process.exit(2);
  }
  const list = readList(file);
  const all = argv.includes('--all');
  const names = (all ? git(['-c', 'core.quotepath=off', 'ls-files']) : git(['-c', 'core.quotepath=off', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'])).stdout
    .split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => TEXT_EXT.test(f));
  const hits = [];
  for (const f of names) {
    const text = all ? fs.readFileSync(path.join(ROOT, f), 'utf8') : git(['show', `:${f}`]).stdout;
    for (const h of scan(text, list)) hits.push(`${f}:${h.line}  ${h.hit}`);
    // 文件名本身也查
    for (const h of scan(f, list)) hits.push(`${f}（文件名）  ${h.hit}`);
  }
  if (hits.length) {
    console.error(`这些内容不能进公开仓库（${hits.length} 处）：`);
    for (const h of hits.slice(0, 100)) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`私有词检查：${names.length} 个文件，干净。`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
