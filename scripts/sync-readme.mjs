#!/usr/bin/env node
// 根目录的 README.md 是入口页；npm 包里的 packages/dsh/README.md 由它生成：相对链接换成 GitHub 上的绝对地址（npm 页面上才打得开）。
//   Markdown 的 [文字](路径)、![图](路径)，和 HTML 的 <img src="路径">、<a href="路径"> 用同一套规则：图片指 raw，其余指 blob/main。
// 改了根目录的 README 就跑一次：node scripts/sync-readme.mjs（测试会检查两边是不是一致）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'QiuYeDx/dsh-rugu';

/** 一个相对路径的绝对地址：图片指 raw.githubusercontent.com，其余指 github.com/blob/main。 */
function absoluteUrl(target, hash, image) {
  const clean = target.replace(/^\.\//, '');
  return image ? `https://raw.githubusercontent.com/${REPO}/main/${clean}${hash}` : `https://github.com/${REPO}/blob/main/${clean}${hash}`;
}

/** HTML 里不用改写的地址：带协议的（http(s):、data:、mailto:……）、协议相对的 //、站点根 /、页内锚点 #。 */
const KEEP = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** 相对链接 → 绝对地址：Markdown 的链接和图片，HTML 的 <img src>（当图片）和 <a href>（当链接）。 */
export function absoluteLinks(md) {
  const out = md.replace(/(!?)\[([^\]]*)\]\((?!https?:|#)([^)#]+)(#[^)]*)?\)/g, (_m, bang, label, target, hash = '') => (
    bang ? `![${label}](${absoluteUrl(target, hash, true)})` : `[${label}](${absoluteUrl(target, hash, false)})`));
  return out.replace(/<(img|a)\b[^>]*>/gi, (tag, name) => {
    const image = name.toLowerCase() === 'img';
    const attr = image ? /(\ssrc\s*=\s*)(["'])([^"']*)\2/i : /(\shref\s*=\s*)(["'])([^"']*)\2/i;
    return tag.replace(attr, (m, pre, q, url) => {
      if (!url || KEEP.test(url)) return m;
      const i = url.indexOf('#');
      return `${pre}${q}${absoluteUrl(i >= 0 ? url.slice(0, i) : url, i >= 0 ? url.slice(i) : '', image)}${q}`;
    });
  });
}

export const packageReadme = () => absoluteLinks(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n'));
export const PACKAGE_README = path.join(ROOT, 'packages', 'dsh', 'README.md');

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(PACKAGE_README, packageReadme());
  console.log('已同步 packages/dsh/README.md');
}
