#!/usr/bin/env node
// 打包检查：npm 包里会不会缺文件。用 `npm pack --dry-run --json` 拿到每个包会打进去的文件清单（不真的打包、不联网、不跑生命周期脚本），然后：
//   1. 清单里的每个 JS 文件（浏览器端的除外）沿着 import / export from / import() / require() 的相对路径走一遍，
//      再加上 `new URL('<相对路径>', import.meta.url)` 这种运行时按路径加载的文件（管理页的 ui/ 各文件、starmap.client.js、
//      worker 脚本、读 package.json 的地方）：依赖的每个文件都要在清单里，不许指到包外；
//   2. package.json 里声明的入口：main、exports（含 * 通配，磁盘上匹配到的每个文件都要进包）、icon、dsh.bundle.patch、
//      scripts 里 `node <包内文件>` 用到的脚本（指到包外的 ../ 只在仓库里用，不查），再加上调用方给的额外文件（dsh.plugin.json 之类）；
//   3. 外部包：只许 node 内置模块、包自己的名字、dependencies / peerDependencies / optionalDependencies 里写了的；
//      引用 rugu-core 的子路径时，要是核心 exports 里有的（由调用方给出可用的子路径）；
//   4. 测试文件（*.test.js / *.test.mjs）不许进包。
// 查不到的：拼出来的路径（path.join(某目录, '文件名')、模板字符串里的路径、require.resolve 之后再拼）、宿主按约定去找的文件——
//   这些由调用方用 extraFiles 列出来。这只是静态检查，不保证装好以后真的能跑。
// 用法：node scripts/pack-check.mjs   （两个包都查，有问题退出码 1；npm 用不了时退出码 2 并说明原因）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findImports, lexJs } from './check-boundaries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN = new Set(builtinModules);
const isBuiltin = (s) => s.startsWith('node:') || BUILTIN.has(s) || BUILTIN.has(s.split('/')[0]);
const posix = (p) => p.split(path.sep).join('/');

/** 找 npm：先找当前 node 旁边的 npm-cli.js（便携版 node 就是这样带 npm 的），再找 npm_execpath。找不到返回 null。 */
export function findNpmCli() {
  const cands = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.npm_execpath,
  ];
  for (const c of cands) if (c && /\.c?js$/.test(c) && fs.existsSync(c)) return c;
  return null;
}

/**
 * 一个包会打进去的文件（相对包目录、/ 分隔）。
 * @returns {{files: string[]} | {skip: string}}  npm 用不了时给 skip（原因），不当成「没问题」
 */
export function packList(pkgDir) {
  const cli = findNpmCli();
  if (!cli) return { skip: `找不到 npm（当前 node 旁边没有 npm-cli.js，也没有 npm_execpath）：${process.execPath}` };
  const r = spawnSync(process.execPath, [cli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
    cwd: pkgDir, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { skip: `npm pack 跑不起来：${r.error.message}` };
  if (r.status !== 0) return { skip: `npm pack --dry-run 失败（退出码 ${r.status}）：${String(r.stderr).trim().split('\n').slice(-3).join(' / ')}` };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { skip: `npm pack --dry-run --json 的输出不是 JSON：${String(r.stdout).slice(0, 200)}` }; }
  const files = j?.[0]?.files?.map((f) => f.path.replace(/\\/g, '/'));
  if (!files?.length) return { skip: 'npm pack --dry-run --json 没给出文件清单' };
  return { files };
}

/** `new URL('<相对路径>', import.meta.url)` 里的相对路径（运行时按路径加载的文件）。 */
export function runtimeUrls(src) {
  const { code, strings } = lexJs(src);
  const out = [];
  for (const s of strings) {
    if (s.template || !/^\.\.?\//.test(s.value)) continue;
    const before = code.slice(Math.max(0, s.start - 30), s.start).replace(/\s+/g, ' ').trimEnd();
    const after = code.slice(s.end, s.end + 40).replace(/\s+/g, ' ').trimStart();
    if (/\bnew URL ?\($/.test(before) && /^, ?import\.meta\.url\b/.test(after)) out.push(s.value);
  }
  return out;
}

/** exports 的目标（字符串、条件对象、数组都展开），和键一起。 */
function exportTargets(exp) {
  if (exp == null) return [];
  if (typeof exp === 'string') return [['.', exp]];
  const out = [];
  const walk = (key, v) => {
    if (typeof v === 'string') out.push([key, v]);
    else if (Array.isArray(v)) v.forEach((x) => walk(key, x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(k.startsWith('.') ? k : key, x);
  };
  if (Object.keys(exp).every((k) => !k.startsWith('.'))) walk('.', exp);
  else for (const [k, v] of Object.entries(exp)) walk(k, v);
  return out;
}

const globRe = (pat) => new RegExp(`^${pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

function listDisk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listDisk(p, base, out); else out.push(posix(path.relative(base, p)));
  }
  return out;
}

/**
 * 查一个包的文件清单。
 * @param {string} pkgDir
 * @param {string[]} files  packList 给的清单
 * @param {{extraFiles?: string[], browser?: (rel: string) => boolean, coreExports?: string[]}} [opt]
 *        extraFiles：运行时按约定 / 拼出来的路径加载、静态扫不到的文件（相对包目录）；
 *        browser：浏览器端的文件，只查在不在、不沿 import 走（默认 *.client.js）；
 *        coreExports：rugu-core 可用的子路径（'rugu-core'、'rugu-core/contract'……），给了就查对 rugu-core 的引用
 * @returns {{problems: string[], walked: number, entries: string[], runtime: string[]}}  runtime：扫到的运行时按路径加载的文件
 */
export function checkPack(pkgDir, files, { extraFiles = [], browser = (f) => /\.client\.js$/.test(f), coreExports } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const inPack = new Set(files);
  const problems = [];
  const deps = new Set([pkg.name, ...Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })]);
  const entries = new Set();
  const need = (rel, why) => {
    const r = posix(path.posix.normalize(rel.replace(/^\.\//, '')));
    entries.add(r);
    if (r.startsWith('../')) problems.push(`${why} 指到包外：${rel}`);
    else if (!inPack.has(r)) problems.push(`${why} 不在包里：${r}`);
  };

  // 1. 声明的入口
  if (pkg.main) need(pkg.main, 'main');
  const disk = listDisk(pkgDir);
  for (const [key, target] of exportTargets(pkg.exports)) {
    if (target.includes('*')) {
      const re = globRe(target.replace(/^\.\//, ''));
      const onDisk = disk.filter((f) => re.test(f));
      if (!onDisk.length) problems.push(`exports['${key}'] 在磁盘上一个文件都匹配不到：${target}`);
      for (const f of onDisk) need(f, `exports['${key}']`);
    } else need(target, `exports['${key}']`);
  }
  if (pkg.icon) need(pkg.icon, 'icon');
  if (pkg.dsh?.bundle?.patch) need(pkg.dsh.bundle.patch, 'dsh.bundle.patch');
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/\bnode\s+(\S+\.m?js)\b/g)) {
      if (m[1].startsWith('../')) continue; // 只在仓库里用的（比如 test 指到仓库根的 run-tests.mjs）
      need(m[1], `scripts['${name}']`);
    }
  }
  for (const f of extraFiles) need(f, '运行时加载的文件');

  // 2. 包里的每个 JS 文件（浏览器端的入口：exports 里键是 ./client 的、和 *.client.js，只查在不在：它们的 require('react') 之类由宿主的页面给）
  const clientEntries = new Set(exportTargets(pkg.exports).filter(([k]) => /(^|\/)client$/.test(k)).map(([, t]) => t.replace(/^\.\//, '')));
  let walked = 0;
  const runtime = new Set();
  for (const rel of files) {
    if (!/\.(m?js|cjs)$/.test(rel) || browser(rel) || clientEntries.has(rel)) continue;
    walked++;
    const abs = path.join(pkgDir, rel);
    const src = fs.readFileSync(abs, 'utf8');
    const deps1 = [
      ...findImports(src).map((i) => ({ spec: i.spec, how: `import（第 ${i.line} 行）`, dynamic: i.dynamic })),
      ...runtimeUrls(src).map((spec) => ({ spec, how: 'new URL(…, import.meta.url)', dynamic: false, url: true })),
    ];
    for (const { spec, how, dynamic, url } of deps1) {
      if (spec.startsWith('.')) {
        const target = posix(path.relative(pkgDir, path.resolve(path.dirname(abs), spec)));
        if (url) runtime.add(target);
        if (target.startsWith('../') || path.isAbsolute(target)) problems.push(`${rel} 的 ${how} 指到包外：'${spec}'`);
        else if (!inPack.has(target)) problems.push(`${rel} 的 ${how} 要的文件不在包里：${target}`);
        continue;
      }
      if (isBuiltin(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!deps.has(name)) {
        // 动态 import 的可选包也要声明（peerDependencies + optional），装的人才知道有这回事
        problems.push(`${rel} 的 ${how} 用了没声明的包：'${spec}'${dynamic ? '（动态 import 也要在 peerDependencies 里声明为可选）' : ''}`);
        continue;
      }
      if (name === 'rugu-core' && coreExports && !coreExports.includes(spec)) problems.push(`${rel} 的 ${how} 用了核心 exports 里没有的子路径：'${spec}'`);
    }
  }

  // 3. 测试文件不进包
  for (const f of files) if (/\.test\.(m?js|cjs)$/.test(f)) problems.push(`测试文件进了包：${f}`);
  return { problems, walked, entries: [...entries], runtime: [...runtime] };
}

/** rugu-core 的 exports 换成可以 import 的名字（'rugu-core'、'rugu-core/contract'……；带 * 的跳过）。 */
export function coreExportNames(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'core', 'package.json'), 'utf8'));
  return Object.keys(pkg.exports ?? {}).filter((k) => !k.includes('*')).map((k) => (k === '.' ? pkg.name : `${pkg.name}/${k.slice(2)}`));
}

/** 两个包各自要额外查的文件（静态扫不到、按约定或拼路径加载的）。 */
export const EXTRA_FILES = Object.freeze({
  // packages/dsh/src/host/eval.js 用 require.resolve('rugu-core/package.json') 再拼 test/eval/memory-eval.js
  core: ['test/eval/memory-eval.js', 'README.md', 'LICENSE'],
  // DSH 按约定读插件根目录的 dsh.plugin.json；locale/*.json 已由 exports 覆盖
  dsh: ['dsh.plugin.json', 'cordis.patch.yml', 'README.md', 'LICENSE'],
});

export function checkPackage(which, root = ROOT) {
  const dir = path.join(root, 'packages', which);
  const list = packList(dir);
  if (list.skip) return { skip: list.skip };
  const r = checkPack(dir, list.files, { extraFiles: EXTRA_FILES[which] ?? [], coreExports: which === 'dsh' ? coreExportNames(root) : undefined });
  return { ...r, files: list.files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let bad = 0;
  let skipped = 0;
  for (const which of ['core', 'dsh']) {
    const r = checkPackage(which);
    if (r.skip) { skipped++; console.log(`${which}：跳过——${r.skip}`); continue; }
    for (const p of r.problems) console.log(`${which}：${p}`);
    console.log(`${which}：包里 ${r.files.length} 个文件，走了 ${r.walked} 个 JS，${r.problems.length} 个问题`);
    bad += r.problems.length;
  }
  process.exit(bad ? 1 : skipped ? 2 : 0);
}
