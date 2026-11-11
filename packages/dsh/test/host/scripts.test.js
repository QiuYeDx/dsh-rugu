// 会改动本机的两个脚本（都默认只预演）：install.mjs（装进 DSH 的 profile）、bridge-whitelist-patch.mjs（QQ 白名单补丁，§11.1）。
// 补丁：锚点精确匹配、先备份、带标记、可还原、重复应用幂等（§15.3「补丁」）。全部在 .tmp 下的合成目录里做，不碰真的 DSH 和桥接。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planPatch, runPatch, resolveBridgeDir, MARK, TOOLS, RESTRICT_REL } from '../../scripts/bridge-whitelist-patch.mjs';
import { planInstall, applyPlan, ROW, NAME, LEGACY_NAME } from '../../scripts/install.mjs';
import { tmpDir, rmDir } from '../fakes/index.js';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const RESTRICT = [
  "const SAFE_PREFIXES = ['mcp__snowluma__']",
  'const SAFE_EXACT = new Set([',
  "  'ask_user_question',",
  "  'todo_write',",
  "  'bili_fav', // bili-eyes patch：别的插件的补丁行",
  '])',
  '',
].join('\n');

function bridge(dir, text = RESTRICT) {
  const b = path.join(dir, 'bridge');
  fs.mkdirSync(path.join(b, path.dirname(RESTRICT_REL)), { recursive: true });
  fs.writeFileSync(path.join(b, RESTRICT_REL), text);
  return b;
}

test('白名单补丁（纯函数）：锚点后面加四行带标记的完整工具名（D156 起有 memory_look）；已经有的不重复；找不到 SAFE_EXACT 或锚点就不硬改', () => {
  const p = planPatch(RESTRICT);
  assert.equal(p.ok, true);
  assert.deepEqual(p.changes.map((c) => c.op), ['add', 'add', 'add', 'add']);
  const lines = p.next.split('\n');
  const at = lines.indexOf("  'todo_write',");
  assert.deepEqual(lines.slice(at + 1, at + 5).map((l) => l.trim().split(',')[0]), TOOLS.map((t) => `'${t}'`));
  assert.ok(lines.slice(at + 1, at + 5).every((l) => l.includes(MARK)));
  assert.ok(p.next.includes("'bili_fav', // bili-eyes patch"), '别的补丁的行不动');
  assert.equal(planPatch(p.next).changes.length, 0, '重复应用幂等');
  const half = RESTRICT.replace("  'todo_write',", "  'todo_write',\n  'memory_recall',");
  assert.deepEqual(planPatch(half).already, ['memory_recall']);
  assert.equal(planPatch(half).changes.length, 3);
  // 打过旧补丁（D156 以前的三行）的桥接再打一次：只补上 memory_look 那一行，已经有的不动；再打一次什么都不改
  const oldLines = ['memory_recall', 'memory_note', 'memory_fix'].map((t) => `  '${t}', ${MARK}`).join('\n');
  const old = RESTRICT.replace("  'todo_write',", `  'todo_write',\n${oldLines}`);
  const up = planPatch(old);
  assert.deepEqual(up.changes.map((c) => c.line.trim().split(',')[0]), ["'memory_look'"]);
  assert.equal(planPatch(up.next).changes.length, 0);
  assert.equal(planPatch('const x = 1').ok, false);
  assert.equal(planPatch(RESTRICT.replace("  'todo_write',\n", '')).ok, false, '锚点行没了（桥接版本变了）：要人看');
  // 换行风格保持原样
  const crlf = planPatch(RESTRICT.replace(/\n/g, '\r\n'));
  assert.ok(crlf.next.includes(`'memory_fix', ${MARK}\r\n`));
  assert.ok(!/[^\r]\n/.test(crlf.next));
});

test('白名单补丁（文件）：默认只预演不写；--apply 先备份（不覆盖已有备份）再写；--revert 只删带标记的行，还原成原样', () => {
  const dir = tmpDir('patch');
  const b = bridge(dir);
  const file = path.join(b, RESTRICT_REL);
  const dry = runPatch({ bridgeDir: b });
  assert.equal(dry.ok, true);
  assert.equal(dry.changes.length, 4);
  assert.equal(dry.applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), RESTRICT, '预演什么都没改');
  assert.equal(fs.existsSync(`${file}.bak-persona-memory`), false);
  const r = runPatch({ bridgeDir: b, apply: true });
  assert.equal(r.applied, true);
  assert.equal(fs.readFileSync(`${file}.bak-persona-memory`, 'utf8'), RESTRICT);
  const patched = fs.readFileSync(file, 'utf8');
  assert.equal(runPatch({ bridgeDir: b, apply: true }).changes.length, 0, '再跑一次：不用改');
  assert.equal(fs.readFileSync(file, 'utf8'), patched);
  const back = runPatch({ bridgeDir: b, apply: true, revert: true });
  assert.equal(back.changes.length, 4);
  assert.equal(fs.readFileSync(file, 'utf8'), RESTRICT, '还原成原样');
  assert.equal(runPatch({ bridgeDir: b, apply: true, revert: true }).changes.length, 0, '还原也幂等');
  // 再打一次：已有备份不覆盖
  fs.writeFileSync(`${file}.bak-persona-memory`, 'OLD');
  runPatch({ bridgeDir: b, apply: true });
  assert.equal(fs.readFileSync(`${file}.bak-persona-memory`, 'utf8'), 'OLD');
  assert.equal(runPatch({ bridgeDir: path.join(dir, 'nope') }).ok, false, '不像桥接的目录');
  rmDir(dir);
});

test('白名单补丁：桥接目录从 --bridge 或配置文件的 host.adapters.qq.bridgeDir 来；命令行默认预演（退出码 0，不写）', () => {
  const dir = tmpDir('patch-cli');
  const b = bridge(dir);
  const cfg = path.join(dir, 'persona-memory.json');
  fs.writeFileSync(cfg, JSON.stringify({ host: { adapters: { qq: { bridgeDir: b } } } }));
  assert.equal(resolveBridgeDir({ config: cfg }), path.resolve(b));
  assert.equal(resolveBridgeDir({ bridge: dir }), path.resolve(dir));
  assert.equal(resolveBridgeDir({ env: { DSH_HOME: dir } }), path.resolve(b));
  assert.equal(resolveBridgeDir({ env: { DSH_HOME: path.join(dir, 'empty') } }), null);
  const out = spawnSync(process.execPath, [path.join(SCRIPTS, 'bridge-whitelist-patch.mjs'), '--config', cfg], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /这是预演/);
  assert.match(out.stdout, /\+ 'memory_recall'/);
  assert.equal(fs.readFileSync(path.join(b, RESTRICT_REL), 'utf8'), RESTRICT);
  const none = spawnSync(process.execPath, [path.join(SCRIPTS, 'bridge-whitelist-patch.mjs'), '--config', path.join(dir, 'missing.json')], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  rmDir(dir);
});

// 真的桥接（可选）：PM_QQ_BRIDGE_DIR 指向桥接目录时，只读它的白名单文件，在内存里算一遍补丁和还原（不写任何文件）
test('白名单补丁对真的桥接文件（可选，只读）：锚点找得到、加三行、还原后和原文一字不差', { skip: !process.env.PM_QQ_BRIDGE_DIR }, () => {
  const src = fs.readFileSync(path.join(process.env.PM_QQ_BRIDGE_DIR, RESTRICT_REL), 'utf8');
  const p = planPatch(src);
  assert.equal(p.ok, true, p.error);
  assert.equal(planPatch(p.next).changes.length, 0);
  assert.equal(planPatch(p.next, { revert: true }).next, src.replace(/^﻿/, ''));
});

/** 合成的 DSH 家目录：profiles/desktop/package.json。 */
function dshHome(dir) {
  const home = path.join(dir, 'dsh');
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'profile', dependencies: { other: '1.0.0' }, dsh: { profile: { bundles: ['other'] } } }, null, 2));
  return home;
}

test('安装（预演）：打印 Cordis 行、要建的链接、profile 的 package.json 要改的两处、要写的最小配置；什么都不改', () => {
  const dir = tmpDir('install');
  const home = dshHome(dir);
  const pkgFile = path.join(home, 'profiles', 'desktop', 'package.json');
  const before = fs.readFileSync(pkgFile, 'utf8');
  const plan = planInstall({ dshHome: home });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.row, { id: 'persona-memory', name: 'dsh-rugu' });
  assert.deepEqual(ROW, plan.row);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['junction', 'junction', 'package.json']);
  assert.equal(plan.pkgChange.next.dependencies[NAME], `link:${path.join(home, 'plugins', NAME).replace(/\\/g, '/')}`);
  assert.deepEqual(plan.pkgChange.next.dsh.profile.bundles, ['other', NAME]);
  assert.equal(plan.steps.some((s) => s.kind === 'config'), false, '不写配置：插件起来时走首次设置（D128）');
  assert.equal(fs.readFileSync(pkgFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, 'plugins')), false);
  assert.equal(fs.existsSync(path.join(home, 'persona-memory.json')), false);
  // 复制模式：列出要复制的文件（插件和核心按各自 package.json 的 files）
  const copy = planInstall({ dshHome: home, copy: true });
  const c = copy.steps.find((s) => s.kind === 'copy');
  assert.ok(c.files > 10);
  assert.ok(c.list.some((f) => f.to.endsWith(path.join('node_modules', 'rugu-core', 'src', 'api.js'))));
  assert.ok(c.list.every((f) => !f.from.includes(`${path.sep}test${path.sep}`) || f.from.includes('core')), '插件的测试不复制');
  // 命令行：默认预演，退出码 0
  const out = spawnSync(process.execPath, [path.join(SCRIPTS, 'install.mjs'), '--dsh-home', home], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /id: persona-memory/);
  assert.match(out.stdout, /这是预演/);
  assert.equal(fs.readFileSync(pkgFile, 'utf8'), before);
  // 找不到 profile：报问题
  assert.ok(planInstall({ dshHome: path.join(dir, 'none') }).problems.length);
  rmDir(dir);
});

test('安装（执行 package.json 和配置两步）：先备份、幂等；卸载只删我们加的两处、不删配置', () => {
  const dir = tmpDir('install-apply');
  const home = dshHome(dir);
  const pkgFile = path.join(home, 'profiles', 'desktop', 'package.json');
  const original = fs.readFileSync(pkgFile, 'utf8');
  const noLinks = (p) => ({ ...p, steps: p.steps.filter((s) => s.kind !== 'junction') });   // 测试里不建指向仓库的链接
  applyPlan(noLinks(planInstall({ dshHome: home })));
  assert.equal(fs.readFileSync(`${pkgFile}.bak-persona-memory`, 'utf8'), original);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  assert.ok(pkg.dependencies[NAME].startsWith('link:'));
  assert.equal(pkg.dependencies.other, '1.0.0');
  assert.equal(fs.existsSync(path.join(home, 'persona-memory.json')), false, '不写配置');
  const again = planInstall({ dshHome: home });
  assert.equal(again.steps.some((s) => s.kind === 'package.json'), false, '重复执行幂等');
  fs.writeFileSync(path.join(home, 'persona-memory.json'), '{"host":{"adapters":{"qq":{"bridgeDir":"X"}}}}');
  applyPlan(noLinks(planInstall({ dshHome: home, uninstall: true })));
  const un = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  assert.equal(un.dependencies[NAME], undefined);
  assert.deepEqual(un.dsh.profile.bundles, ['other']);
  assert.equal(un.dependencies.other, '1.0.0');
  assert.equal(fs.readFileSync(path.join(home, 'persona-memory.json'), 'utf8'), '{"host":{"adapters":{"qq":{"bridgeDir":"X"}}}}', '卸载不删主人的配置');
  // 目标位置已经是真实目录：拒绝覆盖
  fs.mkdirSync(path.join(home, 'plugins', NAME), { recursive: true });
  const blocked = planInstall({ dshHome: home });
  assert.ok(blocked.problems.some((p) => p.includes('拒绝覆盖')));
  assert.throws(() => applyPlan(blocked));
  rmDir(dir);
});

test('插件预设的名字（scripts/preset-config.mjs，D112）：默认预演什么都不写；--apply 先备份、原子写、幂等；坏的 JSON 拒绝；只动 host.preset', async () => {
  const { planPresetConfig, applyPresetConfig, describePreset, BACKUP_SUFFIX } = await import('../../scripts/preset-config.mjs');
  const dir = tmpDir('preset-config');
  const file = path.join(dir, 'persona-memory.json');
  const original = JSON.stringify({ mode: { global: 'live' }, host: { adapters: { web: { enabled: true } }, preset: { order: 7 } } });
  fs.writeFileSync(file, original);
  // 命令行：默认预演
  const dry = spawnSync(process.execPath, [path.join(SCRIPTS, 'preset-config.mjs'), '--name', '某个名字', '--dsh-home', dir], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /这是预演/);
  assert.match(dry.stdout, /name: 某个名字/);
  assert.ok(!dry.stdout.includes('"mode"') && !dry.stdout.includes('adapters'), '只打印 host.preset');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(`${file}${BACKUP_SUFFIX}`), false);
  // --apply：备份、写、别的配置不动
  const prefixFile = path.join(dir, 'prefix.txt');
  fs.writeFileSync(prefixFile, '你是测试里的她。\n');
  const ap = spawnSync(process.execPath, [path.join(SCRIPTS, 'preset-config.mjs'), '--name', '某个名字', '--persona-prefix-file', prefixFile, '--dsh-home', dir, '--apply'], { encoding: 'utf8' });
  assert.equal(ap.status, 0, ap.stderr);
  assert.ok(!ap.stdout.includes('你是测试里的她'), '人设开头只打印字数');
  assert.equal(fs.readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), original);
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(now.host.preset, { order: 7, name: '某个名字', personaPrefix: '你是测试里的她。' });
  assert.deepEqual(now.mode, { global: 'live' });
  assert.deepEqual(now.host.adapters, { web: { enabled: true } });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], '没有留下临时文件');
  // 幂等：再来一次不写、不动备份
  const again = planPresetConfig({ file, name: '某个名字', personaPrefix: '你是测试里的她。' });
  assert.equal(again.changed, false);
  assert.deepEqual(applyPresetConfig(file, again), { written: false, backup: null });
  // 再改名：备份不覆盖（留着最早的那份）
  applyPresetConfig(file, planPresetConfig({ file, name: '另一个名字', personaPrefix: null }));
  assert.equal(fs.readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).host.preset, { order: 7, name: '另一个名字' });
  assert.match(describePreset({ name: 'x', personaPrefix: 'abc' }), /personaPrefix: 3 字/);
  // 少写了值（后面紧跟另一个 --参数）：报问题，不把「--apply」当名字写进去（集成复查）
  const before = fs.readFileSync(file, 'utf8');
  for (const args of [['--name', '--apply'], ['--persona-prefix-file', '--apply', '--name', 'y'], ['--apply', '--name']]) {
    const miss = spawnSync(process.execPath, [path.join(SCRIPTS, 'preset-config.mjs'), ...args, '--dsh-home', dir], { encoding: 'utf8' });
    assert.equal(miss.status, 1, args.join(' '));
    assert.match(miss.stderr, /少了值/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, '少了值时什么都不写');
  // 已经有备份时再 --apply：说清楚备份是第一次改之前的那份
  const twice = spawnSync(process.execPath, [path.join(SCRIPTS, 'preset-config.mjs'), '--name', '第三个名字', '--dsh-home', dir, '--apply'], { encoding: 'utf8' });
  assert.equal(twice.status, 0, twice.stderr);
  assert.match(twice.stdout, /已经有了.*没有覆盖/);
  assert.equal(fs.readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'), original);
  // 坏的 JSON：拒绝、不覆盖
  fs.writeFileSync(file, '{ 坏了');
  const bad = spawnSync(process.execPath, [path.join(SCRIPTS, 'preset-config.mjs'), '--name', 'x', '--dsh-home', dir, '--apply'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ 坏了');
  assert.equal(planPresetConfig({ file: path.join(dir, 'none.json'), name: '' }).ok, false, '名字不能是空的');
  // 还没有配置文件：新建（没有可备份的）
  const fresh = path.join(dir, 'fresh', 'persona-memory.json');
  assert.deepEqual(applyPresetConfig(fresh, planPresetConfig({ file: fresh, name: '新的' })), { written: true, backup: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), { host: { preset: { name: '新的' } } });
  rmDir(dir);
});

test('安装：从旧包名换过来时摘掉旧链接和 profile 里的旧条目（D130）；旧的真实目录不动', () => {
  const dir = tmpDir('install-legacy');
  const home = dshHome(dir);
  const pkgFile = path.join(home, 'profiles', 'desktop', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies[LEGACY_NAME] = 'link:x';
  pkg.dsh.profile.bundles.push(LEGACY_NAME);
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  const oldLink = path.join(home, 'plugins', LEGACY_NAME);
  fs.mkdirSync(path.dirname(oldLink), { recursive: true });
  fs.symlinkSync(target, oldLink, 'junction');
  const oldModule = path.join(home, 'profiles', 'desktop', 'node_modules', LEGACY_NAME);
  fs.mkdirSync(oldModule, { recursive: true });   // 真实目录：不动
  const plan = planInstall({ dshHome: home });
  assert.ok(plan.steps.some((s) => s.kind === 'unlink' && s.path === oldLink));
  assert.ok(plan.steps.some((s) => s.kind === 'note' && s.text.includes(LEGACY_NAME)));
  applyPlan(plan);
  assert.equal(fs.existsSync(oldLink), false);
  assert.equal(fs.existsSync(target), true, '只删链接，不删目标');
  assert.equal(fs.existsSync(oldModule), true);
  const next = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  assert.equal(LEGACY_NAME in next.dependencies, false);
  assert.ok(next.dependencies[NAME].startsWith('link:'));
  assert.deepEqual(next.dsh.profile.bundles, ['other', NAME]);
  rmDir(dir);
});
