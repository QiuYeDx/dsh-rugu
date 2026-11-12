// 版本号一致：两个包一起发版，写了版本号的每一处（scripts/bump-version.mjs 的 VERSION_SPOTS）必须相同；
// 别的地方不许再写死现在的版本号（要写就加进 VERSION_SPOTS，让 bump-version 一起改）。改版本用 node scripts/bump-version.mjs。
//   运行时要版本号的地方读 package.json（核心的 CORE_VERSION），不另写常量；README、locale 里不写版本号。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERSION_SPOTS, VERSION_RE, currentVersions, planBump, applyBump, compareVersions } from '../../../../scripts/bump-version.mjs';
import { REPO_ROOT, tmpDir, rmDir } from '../helpers.js';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bump-version.mjs');

test('写了版本号的几处都相同，而且是合法的 semver', () => {
  const cur = currentVersions(REPO_ROOT);
  assert.equal(cur.length, VERSION_SPOTS.length);
  const v = cur[0].value;
  assert.match(v, VERSION_RE);
  for (const c of cur) assert.equal(c.value, v, `${c.file} ${c.path.join('.')} 是 ${c.value}，别处是 ${v}（用 node scripts/bump-version.mjs 一起改）`);
});

test('别处没有写死现在的版本号（只在 VERSION_SPOTS 那几个文件里）', () => {
  const v = currentVersions(REPO_ROOT)[0].value;
  const spotFiles = new Set(VERSION_SPOTS.map((s) => s.file));
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(m?js|json|md|ya?ml|html)$/.test(e.name)) continue;
      const rel = path.relative(REPO_ROOT, p).split(path.sep).join('/');
      if (spotFiles.has(rel) || rel.endsWith('.test.js')) continue;
      if (fs.readFileSync(p, 'utf8').includes(v)) hits.push(rel);
    }
  };
  for (const d of ['packages', 'scripts', 'docs']) walk(path.join(REPO_ROOT, d));
  // 根目录的文件（README.md、package.json；package-lock.json 在 VERSION_SPOTS 里）
  for (const e of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (e.isFile() && /\.(json|md)$/.test(e.name) && !spotFiles.has(e.name) && fs.readFileSync(path.join(REPO_ROOT, e.name), 'utf8').includes(v)) hits.push(e.name);
  }
  assert.deepEqual([...new Set(hits)], []);
});

test('版本号格式和大小比较', () => {
  for (const ok of ['0.1.0', '1.2.3', '0.2.0-beta.1', '0.1.0-rc.7', '10.20.30-alpha.0.x']) assert.match(ok, VERSION_RE);
  for (const bad of ['v0.1.0', '0.1', '01.2.3', '0.1.0-', '0.1.0+build.1', '0.1.0-01', ' 0.1.0', '']) assert.doesNotMatch(bad, VERSION_RE);
  const order = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-beta.0', '0.1.0-beta.2', '0.1.0-beta.11', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1);
  }
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
});

/** 把版本号所在的文件复制进临时目录（保持相对路径）。 */
function copyRepo(dir) {
  for (const f of new Set(VERSION_SPOTS.map((s) => s.file))) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(dir, f));
  }
}

test('bump-version：默认只预演，--apply 才改齐所有地方；保留换行和其余内容', () => {
  const dir = tmpDir('bump-version');
  try {
    copyRepo(dir);
    // 一个文件换成 CRLF，看写回时保不保留
    const plugin = path.join(dir, 'packages/dsh/dsh.plugin.json');
    fs.writeFileSync(plugin, fs.readFileSync(plugin, 'utf8').replace(/\r?\n/g, '\r\n'));
    const before = Object.fromEntries([...new Set(VERSION_SPOTS.map((s) => s.file))].map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const cur = currentVersions(dir)[0].value;
    const to = '99.0.0-test.1';

    const dry = spawnSync(process.execPath, [SCRIPT, to, '--root', dir], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /预演/);
    assert.equal(dry.stdout.match(/→ 99\.0\.0-test\.1/g).length, VERSION_SPOTS.length);
    for (const [f, s] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), s, `预演不该改 ${f}`);

    const run = spawnSync(process.execPath, [SCRIPT, to, '--root', dir, '--apply'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    for (const c of currentVersions(dir)) assert.equal(c.value, to, `${c.file} ${c.path.join('.')}`);
    const after = fs.readFileSync(plugin, 'utf8');
    assert.ok(after.includes('\r\n') && !/[^\r]\n/.test(after), 'CRLF 要保留');
    // 除了版本号，内容一字不差
    for (const [f, s] of Object.entries(before)) {
      assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').split(to).join(cur), s, `${f} 除了版本号不该有别的改动`);
    }
    // 再跑一次：已经是这个版本了
    const again = spawnSync(process.execPath, [SCRIPT, to, '--root', dir, '--apply'], { encoding: 'utf8' });
    assert.equal(again.status, 2);
    assert.match(again.stderr, /已经是/);
  } finally { rmDir(dir); }
});

test('bump-version：格式不对、没给、降版本都拒绝；降版本加 --allow-downgrade 才行；只差几处的只改那几处', () => {
  const dir = tmpDir('bump-version-bad');
  try {
    copyRepo(dir);
    for (const bad of ['v1.0.0', '1.0', 'latest', undefined]) {
      const r = planBump(bad, { root: dir });
      assert.equal(r.ok, false);
      assert.match(r.error, /格式不对/);
    }
    const cli = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /没给/);

    assert.equal(applyBump(planBump('5.0.0', { root: dir }), { root: dir }).length, new Set(VERSION_SPOTS.map((s) => s.file)).size);
    const down = planBump('4.9.9', { root: dir });
    assert.equal(down.ok, false);
    assert.match(down.error, /allow-downgrade/);
    assert.equal(planBump('4.9.9', { root: dir, allowDowngrade: true }).ok, true);

    // 只有一处没跟上：只改这一处
    const f = path.join(dir, 'packages/dsh/dsh.plugin.json');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"5.0.0"', '"4.0.0"'));
    const fix = planBump('5.0.0', { root: dir });
    assert.equal(fix.ok, true);
    assert.deepEqual(fix.changes.map((c) => c.file), ['packages/dsh/dsh.plugin.json']);
  } finally { rmDir(dir); }
});
