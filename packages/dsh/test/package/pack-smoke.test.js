// 打包冒烟（scripts/pack-check.mjs）：dsh-rugu 从 npm 装下来以后，每个 exports 入口（含 locale/*.json）、package.json 里的 icon、
// dsh.bundle.patch、scripts 用到的脚本、DSH 按约定读的 dsh.plugin.json、运行时按路径加载的文件（管理页的 page.html、starmap.client.js、
// GPU 采样的 worker）依赖的都在包里；对 rugu-core 只用它 exports 里有的入口；测试文件不进包。浏览器端的入口（./client）只查在不在。
//   用 `npm pack --dry-run --json` 拿清单（不真的打包、不联网）。npm 用不了时跳过并写明原因；设 RUGU_REQUIRE_PACK=1 时改成失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPackage } from '../../../../scripts/pack-check.mjs';
import { REPO_ROOT } from '../fakes/index.js';

test('dsh-rugu 的包：入口和运行时加载的文件依赖的都在包里，测试文件不进包', (t) => {
  const r = checkPackage('dsh', REPO_ROOT);
  if (r.skip) {
    if (process.env.RUGU_REQUIRE_PACK === '1') assert.fail(`RUGU_REQUIRE_PACK=1，但打包清单拿不到：${r.skip}`);
    t.skip(`拿不到打包清单，没有检查：${r.skip}`);
    return;
  }
  assert.deepEqual(r.problems, []);
  for (const f of ['src/index.js', 'src/admin/client.js', 'src/admin/page.html', 'src/admin/starmap.client.js', 'src/host/gpu/sampler-worker.js',
    'locale/zh.json', 'locale/en.json', 'assets/icon.svg', 'dsh.plugin.json', 'cordis.patch.yml']) assert.ok(r.files.includes(f), `包里应该有 ${f}`);
  // 运行时按路径加载的几个确实被扫到了（不是碰巧在清单里）
  for (const f of ['src/admin/page.html', 'src/admin/starmap.client.js', 'src/host/gpu/sampler-worker.js']) assert.ok(r.runtime.includes(f), `应该扫到运行时加载的 ${f}`);
  assert.ok(!r.files.some((f) => f.startsWith('test/')), '插件的测试不进包');
  assert.ok(!r.files.includes('scripts/install.mjs'), 'install.mjs 只在仓库里用');
  // D167：三个图标都进包；横幅只给 README 用（README 里是 raw 地址），横幅的源文件和渲染脚本也不进包
  for (const f of ['assets/icon.svg', 'assets/icon-light.svg', 'assets/glyph.svg']) assert.ok(r.files.includes(f), `包里应该有 ${f}`);
  assert.deepEqual(r.files.filter((f) => /\.webp$/i.test(f) || f.startsWith('assets/brand/')), [], '横幅和它的源文件不进包');
});

test('对 DSH 的 peer 依赖 @deepseek-ai/dsh-tools 写 *（DSH 只发预发布版；package-lock.json 跟着一致）', async () => {
  // npm 的 semver 范围不含别的 x.y.z 的预发布版：原来的 >=0.1.0-rc.7 在 npm 看来只认 0.1.0-rc.7、0.1.0-rc.8，
  // DSH 0.2.x 带的 0.2.1-rc.3 之类全不认；而 dsh-tools 发布的全是预发布版，任何写下限的范围都漏掉以后的新版本。
  // npm（@npmcli/arborist 的 dep-valid）和 pnpm 都把 * 当成任何版本都行（含预发布）。插件运行时自己看 defineTool 在不在（自检 host.defineTool）。
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'dsh', 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.peerDependencies['@deepseek-ai/dsh-tools'], '*');
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-tools'].optional, true);
  assert.deepEqual(lock.packages['packages/dsh'].peerDependencies, pkg.peerDependencies);
});
