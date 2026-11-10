#!/usr/bin/env node
// 根目录的 README.md 是入口页；npm 包里的 packages/dsh/README.md 由它生成：相对链接换成 GitHub 上的绝对地址（npm 页面上才打得开）。
// 改了根目录的 README 就跑一次：node scripts/sync-readme.mjs（测试会检查两边是不是一致）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'QiuYeDx/dsh-rugu';

/** 相对链接 → 绝对地址：图片指 raw.githubusercontent.com，其余指 github.com/blob/main。 */
export function absoluteLinks(md) {
  return md.replace(/(!?)\[([^\]]*)\]\((?!https?:|#)([^)#]+)(#[^)]*)?\)/g, (_m, bang, label, target, hash = '') => {
    const clean = target.replace(/^\.\//, '');
    return bang ? `![${label}](https://raw.githubusercontent.com/${REPO}/main/${clean}${hash})` : `[${label}](https://github.com/${REPO}/blob/main/${clean}${hash})`;
  });
}

export const packageReadme = () => absoluteLinks(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n'));
export const PACKAGE_README = path.join(ROOT, 'packages', 'dsh', 'README.md');

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(PACKAGE_README, packageReadme());
  console.log('已同步 packages/dsh/README.md');
}
