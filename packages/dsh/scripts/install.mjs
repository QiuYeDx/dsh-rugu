#!/usr/bin/env node
// 本地开发用：把这个仓库里的 dsh-rugu 链接进 DSH 的一个 profile（profile 的组合见 @deepseek-ai/dsh-app-boot）。
//   普通用户不用它，在 DSH「添加插件」里按包名 dsh-rugu 装；这个脚本留给改代码的人（不进 npm 包）。
//   从旧名字 dsh-persona-memory 换过来时，顺手把旧的链接和 profile 里的旧条目摘掉（数据、配置都不动）。
//   默认只预演：打印要建的链接 / 要复制的文件、profile 的 package.json 要改的两处、Cordis 行、要写的配置文件；什么都不改；
//   --apply 才真的做；--uninstall 反过来（只删链接和我们加的那两处，不删目标目录、不删配置和数据）；
//   不写配置文件：插件第一次起来时等主人在管理页走完首次设置（D128，也不会先建一个空库）；手写配置的照旧；
//   --copy：不建链接，把插件和核心复制进 <DSH 家目录>/plugins/dsh-rugu（默认建 junction，改代码不用重装）；
//   改 package.json 之前先备份成 package.json.bak-persona-memory；目标位置已经是真实目录（不是链接）就拒绝覆盖；
//   重复执行幂等。装完要彻底重启 DSH 一次才加载（重启前先征得主人同意，§15.4）；QQ 会话要用记忆工具还要打白名单补丁。
// 用法：node scripts/install.mjs [--apply] [--uninstall] [--copy] [--profile desktop] [--dsh-home <目录>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NAME = 'dsh-rugu';
export const ROW = Object.freeze({ id: 'persona-memory', name: NAME });
/** 改名之前的包名：换名字时摘掉（D130）。 */
export const LEGACY_NAME = 'dsh-persona-memory';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(HERE, '..');
const CORE_DIR = path.resolve(PLUGIN_DIR, '..', 'core');

const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
/** 只删链接本身（junction 用 unlink；不行再 rmdir，两者都不会碰目标目录）。 */
const unlinkLink = (p) => { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } };

/** 复制模式要复制的文件：按两个包 package.json 的 files。 */
function copyList() {
  const out = [];
  const walk = (base, rel, dest) => {
    const src = path.join(base, rel);
    let st;
    try { st = fs.statSync(src); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(src)) if (e !== 'node_modules' && !e.startsWith('.')) walk(base, path.join(rel, e), dest); }
    else out.push({ from: src, to: path.join(dest, rel) });
  };
  const add = (pkgDir, dest) => {
    const pkg = JSON.parse(read(path.join(pkgDir, 'package.json')));
    for (const f of ['package.json', ...(pkg.files ?? [])]) walk(pkgDir, f, dest);
  };
  return { add, out };
}

/**
 * 算出安装（或卸载）计划（不碰文件）。
 * @param {{dshHome: string, profile?: string, uninstall?: boolean, copy?: boolean}} opt
 */
export function planInstall({ dshHome, profile = 'desktop', uninstall = false, copy = false }) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const pkgFile = path.join(profileDir, 'package.json');
  const linkDir = path.join(dshHome, 'plugins', NAME);
  const moduleLink = path.join(profileDir, 'node_modules', NAME);
  const configFile = path.join(dshHome, 'persona-memory.json');
  const legacyLink = path.join(dshHome, 'plugins', LEGACY_NAME);
  const legacyModule = path.join(profileDir, 'node_modules', LEGACY_NAME);
  const steps = [];
  const problems = [];
  if (!exists(pkgFile)) problems.push(`找不到 profile：${pkgFile}`);
  // 换名字（D130）：旧的链接摘掉；旧目录要是复制装的真实目录，不动，只提示
  if (!uninstall) {
    for (const p of [legacyModule, legacyLink]) {
      if (isLink(p)) steps.push({ kind: 'unlink', path: p, legacy: true });
      else if (exists(p)) steps.push({ kind: 'note', text: `${p} 是旧名字的真实目录：不动它，确认不用了可以手工删` });
    }
  }

  if (uninstall) {
    // D112：插件预设是插件运行时注册的，卸载后就没了；DSH 恢复会话时找不到预设 id 会拒绝
    steps.push({ kind: 'note', text: '注意：卸载后，用插件预设（「新建任务」里插件加的那一项）开过的会话打不开，重新装上才行' });
    if (isLink(moduleLink)) steps.push({ kind: 'unlink', path: moduleLink });
    if (isLink(linkDir)) steps.push({ kind: 'unlink', path: linkDir });
    else if (exists(linkDir)) steps.push({ kind: 'note', text: `${linkDir} 是复制装的真实目录：卸载不删它，要删请手工删` });
  } else if (copy) {
    if (isLink(linkDir)) problems.push(`${linkDir} 现在是链接：先 --uninstall 再用 --copy`);
    const { add, out } = copyList();
    add(PLUGIN_DIR, linkDir);
    add(CORE_DIR, path.join(linkDir, 'node_modules', 'rugu-core'));
    steps.push({ kind: 'copy', files: out.length, to: linkDir, list: out });
    if (exists(moduleLink) && !isLink(moduleLink)) problems.push(`${moduleLink} 已经是真实目录，拒绝覆盖`);
    else if (!isLink(moduleLink)) steps.push({ kind: 'junction', path: moduleLink, target: linkDir });
  } else {
    if (exists(linkDir) && !isLink(linkDir)) problems.push(`${linkDir} 已经是真实目录（不是链接），拒绝覆盖`);
    else steps.push({ kind: 'junction', path: linkDir, target: PLUGIN_DIR, skip: isLink(linkDir) && path.resolve(fs.realpathSync(linkDir)) === path.resolve(fs.realpathSync(PLUGIN_DIR)) });
    if (exists(moduleLink) && !isLink(moduleLink)) problems.push(`${moduleLink} 已经是真实目录，拒绝覆盖`);
    else steps.push({ kind: 'junction', path: moduleLink, target: linkDir, skip: isLink(moduleLink) });
  }

  let pkgChange = null;
  if (exists(pkgFile)) {
    try {
      const pkg = JSON.parse(read(pkgFile));
      const before = JSON.stringify(pkg);
      pkg.dependencies ??= {};
      pkg.dsh ??= {}; pkg.dsh.profile ??= {}; pkg.dsh.profile.bundles ??= [];
      if (uninstall) {
        delete pkg.dependencies[NAME];
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== NAME);
      } else {
        delete pkg.dependencies[LEGACY_NAME];
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== LEGACY_NAME);
        pkg.dependencies[NAME] = `link:${linkDir.replace(/\\/g, '/')}`;
        if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME);
      }
      const changed = JSON.stringify(pkg) !== before;
      pkgChange = { file: pkgFile, changed, next: pkg, dependency: uninstall ? null : pkg.dependencies[NAME], bundles: pkg.dsh.profile.bundles.includes(NAME) };
      if (changed) steps.push({ kind: 'package.json', file: pkgFile, backup: `${pkgFile}.bak-persona-memory`, uninstall });
    } catch { problems.push(`${pkgFile} 不是合法的 JSON`); }
  }
  let coreResolves = false;
  try { createRequire(path.join(PLUGIN_DIR, 'package.json')).resolve('rugu-core'); coreResolves = true; } catch { coreResolves = false; }
  return { profileDir, linkDir, moduleLink, configFile, steps, problems, pkgChange, row: ROW, coreResolves: copy || coreResolves };
}

/** 照计划执行。 */
export function applyPlan(plan) {
  if (plan.problems.length) throw new Error(plan.problems.join('；'));
  const done = [];
  for (const s of plan.steps) {
    if (s.kind === 'unlink') { unlinkLink(s.path); done.push(`删链接 ${s.path}`); }
    else if (s.kind === 'junction' && !s.skip) {
      if (isLink(s.path)) unlinkLink(s.path);
      fs.mkdirSync(path.dirname(s.path), { recursive: true });
      fs.symlinkSync(s.target, s.path, 'junction');
      done.push(`链接 ${s.path} → ${s.target}`);
    } else if (s.kind === 'copy') {
      for (const f of s.list) { fs.mkdirSync(path.dirname(f.to), { recursive: true }); fs.copyFileSync(f.from, f.to); }
      done.push(`复制 ${s.files} 个文件到 ${s.to}`);
    } else if (s.kind === 'package.json') {
      if (!exists(s.backup)) fs.copyFileSync(s.file, s.backup);
      fs.writeFileSync(s.file, `${JSON.stringify(plan.pkgChange.next, null, 2)}\n`);
      done.push(`改 ${s.file}（备份 ${path.basename(s.backup)}）`);
    }
  }
  return done;
}

function describe(plan, { uninstall }) {
  const lines = [];
  lines.push(`profile：${plan.profileDir}`);
  lines.push('Cordis 行（插件自己的 cordis.patch.yml 会插进 profile，§10.1）：');
  lines.push(`  - id: ${plan.row.id}`);
  lines.push(`    name: ${plan.row.name}`);
  for (const s of plan.steps) {
    if (s.kind === 'junction') lines.push(`${s.skip ? '（已在）' : ''}建 junction：${s.path} → ${s.target}`);
    else if (s.kind === 'unlink') lines.push(`删 junction：${s.path}（只删链接，不删目标）`);
    else if (s.kind === 'copy') { lines.push(`复制 ${s.files} 个文件到 ${s.to}：`); for (const f of s.list.slice(0, 12)) lines.push(`  ${path.relative(PLUGIN_DIR, f.from)} → ${path.relative(s.to, f.to)}`); if (s.list.length > 12) lines.push(`  ……共 ${s.list.length} 个`); }
    else if (s.kind === 'package.json') lines.push(`${uninstall ? '从' : '往'} ${s.file} ${uninstall ? '删掉' : '加上'} dependencies["${NAME}"] 和 dsh.profile.bundles 里的 "${NAME}"（先备份成 ${path.basename(s.backup)}）`);
    else if (s.kind === 'note') lines.push(s.text);
  }
  if (plan.pkgChange && !plan.pkgChange.changed) lines.push(`${plan.pkgChange.file}：${uninstall ? '本来就没登记' : '已经登记过'}`);
  if (!uninstall) lines.push(`rugu-core 能从插件目录解析到：${plan.coreResolves ? '是' : '否（先在仓库根目录 npm install）'}`);
  for (const p of plan.problems) lines.push(`问题：${p}`);
  return lines;
}

function main() {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const uninstall = argv.includes('--uninstall');
  const apply = argv.includes('--apply');
  const copy = argv.includes('--copy');
  const dshHome = path.resolve(val('--dsh-home') || String(process.env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh'));
  const plan = planInstall({ dshHome, profile: val('--profile') || 'desktop', uninstall, copy });
  for (const l of describe(plan, { uninstall })) console.log(l);
  if (!apply) { console.log('\n这是预演，什么都没改。确认要做就加 --apply。'); return; }
  if (plan.problems.length) { console.error('有问题，没有动任何文件。'); process.exit(1); }
  for (const l of applyPlan(plan)) console.log(`✓ ${l}`);
  console.log(uninstall ? '已卸载。彻底重启 DSH 后生效（先征得主人同意）。数据和配置都留着。'
    : '已装好。下一步：彻底重启 DSH 一次（先征得主人同意），然后打开设置里的「记忆」：新装的先走首次设置（QQ 白名单也在那里），已有配置的直接看启动自检。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
