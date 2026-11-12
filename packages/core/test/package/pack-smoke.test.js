// 打包冒烟（scripts/pack-check.mjs）：rugu-core 从 npm 装下来以后，每个 exports 入口、运行时按路径加载的文件（worker 脚本、
// package.json、DSH 管理页在 worker 里加载的 test/eval/memory-eval.js）依赖的文件都在包里；测试文件不进包。
//   用 `npm pack --dry-run --json` 拿清单（不真的打包、不联网）。npm 用不了时跳过并写明原因；设 RUGU_REQUIRE_PACK=1 时改成失败。
// 后半是检查器自己的测试：在临时目录里造几个小包，确认它真的能查出漏文件（不依赖 npm）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPackage, checkPack, runtimeUrls, EXTRA_FILES } from '../../../../scripts/pack-check.mjs';
import { REPO_ROOT, tmpDir, rmDir } from '../helpers.js';

function packOrSkip(t, which) {
  const r = checkPackage(which, REPO_ROOT);
  if (r.skip) {
    if (process.env.RUGU_REQUIRE_PACK === '1') assert.fail(`RUGU_REQUIRE_PACK=1，但打包清单拿不到：${r.skip}`);
    t.skip(`拿不到打包清单，没有检查：${r.skip}`);
    return null;
  }
  return r;
}

test('rugu-core 的包：入口和运行时加载的文件依赖的都在包里，测试文件不进包', (t) => {
  const r = packOrSkip(t, 'core');
  if (!r) return;
  assert.deepEqual(r.problems, []);
  for (const f of ['src/index.js', 'src/contract/index.js', 'test/fakes/index.js', 'test/fakes/tmp.js', 'test/fixtures/fake-platform.js',
    'test/eval/memory-eval.js', 'src/worker/thread.js', 'src/backup/sqlite-task.js']) assert.ok(r.files.includes(f), `包里应该有 ${f}`);
  assert.ok(r.walked > 50, `走了 ${r.walked} 个 JS 文件，太少了，清单可能不对`);
});

test('检查器：查得出入口、相对 import、new URL 加载的文件缺了，指到包外，没声明的包，测试文件进包', () => {
  const dir = tmpDir('pack-check');
  try {
    const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
    w('package.json', JSON.stringify({
      name: 'demo', main: './src/index.js', icon: './assets/icon.svg',
      exports: { '.': './src/index.js', './client': './src/client.js', './locale/*.json': './locale/*.json', './testing': './test/fakes/index.js' },
      scripts: { test: 'node ../../scripts/run-tests.mjs', install2: 'node scripts/install.mjs' },
      dependencies: { dep: '1.0.0' },
    }));
    w('src/index.js', "import fs from 'node:fs';\nimport './a.js';\nimport dep from 'dep/sub';\nconst P = new URL('./page.html', import.meta.url);\nconst W = new URL( './worker.js' , import.meta.url);\nconst x = `./not-a-load.js`;\n");
    w('src/a.js', "export * from './gone.js';\nawait import('undeclared');\n");
    w('src/client.js', "const React = require('react');\n"); // 浏览器入口：只查在不在
    w('test/fakes/index.js', "export * from '../helpers.js';\n");
    w('test/helpers.js', 'export const x = 1;\n');
    w('locale/zh.json', '{}');
    w('locale/en.json', '{}');
    w('scripts/install.mjs', '');
    w('src/x.test.js', '');
    const files = ['package.json', 'src/index.js', 'src/a.js', 'src/client.js', 'test/fakes/index.js', 'locale/zh.json', 'src/x.test.js'];
    const r = checkPack(dir, files, { extraFiles: ['plugin.json'] });
    const has = (re) => assert.ok(r.problems.some((p) => re.test(p)), `应该报：${re}\n实际：\n${r.problems.join('\n')}`);
    has(/icon 不在包里：assets\/icon\.svg/);
    has(/exports\['\.\/locale\/\*\.json'\] 不在包里：locale\/en\.json/);
    has(/scripts\['install2'\] 不在包里：scripts\/install\.mjs/);
    has(/运行时加载的文件 不在包里：plugin\.json/);
    has(/src\/index\.js 的 new URL.*不在包里：src\/page\.html/);
    has(/src\/index\.js 的 new URL.*不在包里：src\/worker\.js/);
    has(/src\/a\.js 的 import.*不在包里：src\/gone\.js/);
    has(/src\/a\.js 的 import.*没声明的包：'undeclared'/);
    has(/test\/fakes\/index\.js 的 import.*不在包里：test\/helpers\.js/);
    has(/测试文件进了包：src\/x\.test\.js/);
    assert.ok(!r.problems.some((p) => /react|not-a-load|run-tests|'dep\/sub'|node:fs/.test(p)), r.problems.join('\n'));
    assert.equal(r.problems.length, 10, r.problems.join('\n'));
  } finally { rmDir(dir); }
});

test('检查器：只认 new URL(相对路径, import.meta.url)', () => {
  assert.deepEqual(runtimeUrls("new URL('./a.html', import.meta.url); new URL('../b.js',import.meta.url); new URL('./c.js', base); new URL('https://x.test/')"), ['./a.html', '../b.js']);
});

test('DSH 的「记忆评测」按路径加载的评测文件在核心的额外清单里（两边的路径对得上）', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'dsh', 'src', 'host', 'eval.js'), 'utf8');
  assert.match(src, /path\.join\(dir, 'test', 'eval', 'memory-eval\.js'\)/);
  assert.ok(EXTRA_FILES.core.includes('test/eval/memory-eval.js'));
});
