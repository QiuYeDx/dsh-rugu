// 仓库本身的两条规矩：npm 包里的 README 和根目录的一致（scripts/sync-readme.mjs）；私有词检查的读表和扫描（scripts/check-private-words.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { packageReadme, PACKAGE_README, absoluteLinks } from '../../../scripts/sync-readme.mjs';
import { readList, scan } from '../../../scripts/check-private-words.mjs';
import { tmpDir, rmDir } from './fakes/index.js';

test('packages/dsh/README.md 和根目录 README 一致（改了根目录的就跑 node scripts/sync-readme.mjs）', () => {
  assert.equal(fs.readFileSync(PACKAGE_README, 'utf8').replace(/\r\n/g, '\n'), packageReadme());
  assert.equal(absoluteLinks('[文档](docs/图解.md#x) ![图](a/b.webp) [外](https://x.test) [锚](#y)'),
    '[文档](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/图解.md#x) ![图](https://raw.githubusercontent.com/QiuYeDx/dsh-rugu/main/a/b.webp) [外](https://x.test) [锚](#y)');
});

test('同步 README：HTML 的 <img src> 当图片、<a href> 当链接，和 Markdown 同一套规则；绝对地址、锚点、data: 不动', () => {
  const RAW = 'https://raw.githubusercontent.com/QiuYeDx/dsh-rugu/main/';
  const BLOB = 'https://github.com/QiuYeDx/dsh-rugu/blob/main/';
  assert.equal(absoluteLinks('<img src="packages/dsh/assets/banner.webp" width="100%" alt="横幅">'), `<img src="${RAW}packages/dsh/assets/banner.webp" width="100%" alt="横幅">`);
  assert.equal(absoluteLinks("<IMG alt='x' SRC='./a/b.png'/>"), `<IMG alt='x' SRC='${RAW}a/b.png'/>`);
  assert.equal(absoluteLinks('<p align="center"><a href="docs/图解.md#链路"><img src="a.svg"></a></p>'),
    `<p align="center"><a href="${BLOB}docs/图解.md#链路"><img src="${RAW}a.svg"></a></p>`);
  for (const keep of ['<img src="https://x.test/a.png">', '<img src="//cdn.test/a.png">', '<img src="data:image/png;base64,AA">', '<a href="#y">锚</a>',
    '<a href="mailto:x@example.com">信</a>', '<img src="/abs.png">', '<abbr title="a.png">缩写</abbr>', '<img data-src="a.png">', '<img src="">']) {
    assert.equal(absoluteLinks(keep), keep);
  }
  // 同步出来的 npm README 里没有剩下相对路径的 <img>
  for (const m of packageReadme().matchAll(/<img\b[^>]*\ssrc\s*=\s*["']([^"']*)["']/gi)) assert.match(m[1], /^https:\/\//);
});

test('同步 README（D167）：<picture> 里 <source srcset> 的每个地址都当图片改成 raw；描述符、绝对地址不动；<img srcset> 同样', () => {
  const RAW = 'https://raw.githubusercontent.com/QiuYeDx/dsh-rugu/main/';
  assert.equal(absoluteLinks('<source media="(prefers-color-scheme: dark)" srcset="packages/dsh/assets/banner-dark.webp">'),
    `<source media="(prefers-color-scheme: dark)" srcset="${RAW}packages/dsh/assets/banner-dark.webp">`);
  assert.equal(absoluteLinks("<SOURCE SRCSET='./a.webp 1x, b@2x.webp 2x,https://x.test/c.webp 3x'>"),
    `<SOURCE SRCSET='${RAW}a.webp 1x, ${RAW}b@2x.webp 2x,https://x.test/c.webp 3x'>`);
  assert.equal(absoluteLinks('<img srcset="a.webp 640w, b.webp 1280w" src="b.webp" alt="x">'), `<img srcset="${RAW}a.webp 640w, ${RAW}b.webp 1280w" src="${RAW}b.webp" alt="x">`);
  for (const keep of ['<source srcset="https://x.test/a.webp">', '<source src="a.mp4">', '<source data-srcset="a.webp">']) assert.equal(absoluteLinks(keep), keep);
  // 同步出来的 npm README 里，<source srcset> 也没有剩下相对路径
  const pkg = packageReadme();
  for (const m of pkg.matchAll(/<source\b[^>]*\ssrcset\s*=\s*["']([^"']*)["']/gi)) for (const c of m[1].split(',')) assert.match(c.trim(), /^https:\/\//);
});

test('私有词检查：词大小写不敏感、re: 是正则、注释和空行跳过；报的是第几条规则，不把词打出来', () => {
  const dir = tmpDir('private-words');
  const f = path.join(dir, 'list.txt');
  fs.writeFileSync(f, '# 注释\n\n秘密名字\nSecretWord\nre:[A-Z]:\\\\private\\b\n');
  const list = readList(f);
  assert.equal(list.words.length, 2);
  assert.equal(list.patterns.length, 1);
  const hits = scan('第一行没事\n这里有 secretword\n路径 D:\\private\\x\n还有秘密名字', list);
  assert.deepEqual(hits.map((h) => h.line), [2, 3, 4]);
  assert.ok(hits.every((h) => !/秘密|secret/i.test(h.hit)));
  rmDir(dir);
});
