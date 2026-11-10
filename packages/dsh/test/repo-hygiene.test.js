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
