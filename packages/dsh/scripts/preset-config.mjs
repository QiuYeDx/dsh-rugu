#!/usr/bin/env node
// 设插件预设（D112：DSH「新建任务」下拉里插件加的那一项）在下拉里叫什么、人设行的开头（可选）。写的是 <DSH 家目录>/persona-memory.json 的 host.preset。
//   公开代码里只有一个通用的默认名；人设的名字、人设开头的文字放在私有 kit 里，用这个脚本写进本机的配置（§11.6）；
//   默认只预演：只打印 host.preset 现在的和要改成的（不打印配置里的别的东西，人设开头只打印字数），什么都不写；
//   --apply 才写：先备份成 persona-memory.json.bak-preset（已经有备份就不覆盖）、写临时文件再改名（原子）；没变就不写（幂等）；
//   配置文件不是合法的 JSON 就拒绝（不覆盖主人的文件）。不碰 profile。
//   插件在跑的时候每分钟热加载一次配置：写进去以后预设的名字一分钟内跟着变，不用重启 DSH（插件本身要先重启加载过一次带预设的版本）。
// 用法：node scripts/preset-config.mjs --name <名字> [--description <说明>] [--persona-prefix-file <私有 kit 里的文件>] [--clear-persona-prefix]
//                                      [--order <数字>] [--apply] [--dsh-home <目录>]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshHome } from '../src/host/paths.js';
import { PERSONA_PRESET_ID } from '../src/preset/index.js';

export const BACKUP_SUFFIX = '.bak-preset';
const PREFIX_MAX = 2000;
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 算出要改成什么（不写文件）。
 * @param {{file: string, name?: string, description?: string, order?: number, personaPrefix?: string|null}} opt
 *   personaPrefix：字符串 = 设成它；null = 清掉；undefined = 不动
 * @returns {{ok: boolean, problems: string[], exists: boolean, current: object, next: object, changed: boolean, config?: object}}
 */
export function planPresetConfig({ file, name, description, order, personaPrefix }) {
  const problems = [];
  let config = {};
  const exists = fs.existsSync(file);
  if (exists) {
    try { config = JSON.parse(read(file)); } catch { problems.push(`${file} 不是合法的 JSON：先修好它（这个脚本不覆盖它）`); }
    if (!problems.length && !isPlain(config)) problems.push(`${file} 的顶层不是对象`);
  }
  if (name !== undefined && !(typeof name === 'string' && name.trim() && name.trim().length <= 40)) problems.push('--name 要 1–40 个字');
  if (description !== undefined && !(typeof description === 'string' && description.trim().length <= 300)) problems.push('--description 最多 300 个字');
  if (order !== undefined && !Number.isFinite(order)) problems.push('--order 要是数字');
  if (typeof personaPrefix === 'string' && (!personaPrefix.trim() || personaPrefix.trim().length > PREFIX_MAX)) problems.push(`人设开头要 1–${PREFIX_MAX} 个字`);
  const host = isPlain(config?.host) ? config.host : {};
  const current = isPlain(host.preset) ? host.preset : {};
  const nextPreset = { ...current };
  if (name !== undefined) nextPreset.name = String(name).trim();
  if (description !== undefined) nextPreset.description = String(description).trim();
  if (order !== undefined) nextPreset.order = order;
  if (typeof personaPrefix === 'string') nextPreset.personaPrefix = personaPrefix.trim();
  else if (personaPrefix === null) delete nextPreset.personaPrefix;
  const changed = JSON.stringify(nextPreset) !== JSON.stringify(current);
  const next = problems.length ? config : { ...(isPlain(config) ? config : {}), host: { ...host, preset: nextPreset } };
  return { ok: !problems.length, problems, exists, current, next: nextPreset, changed: !problems.length && changed, config: next };
}

/** 照计划写（先备份，原子替换）。返回做了什么。 */
export function applyPresetConfig(file, plan) {
  if (!plan.ok) throw new Error(plan.problems.join('；'));
  if (!plan.changed) return { written: false, backup: null };
  let backup = null;
  let backupExisted = false;
  if (plan.exists) {
    backup = `${file}${BACKUP_SUFFIX}`;
    try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); } catch (e) { if (e?.code !== 'EEXIST') throw e; backupExisted = true; }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(plan.config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { written: true, backup, ...(backup ? { backupExisted } : {}) };
}

/** host.preset 的一行说法：人设开头只说字数。 */
export function describePreset(p) {
  const v = isPlain(p) ? p : {};
  const parts = [];
  parts.push(`name: ${typeof v.name === 'string' && v.name ? v.name : '（默认的通用名）'}`);
  if (typeof v.description === 'string' && v.description) parts.push(`description: ${v.description.length} 字`);
  if (v.order !== undefined) parts.push(`order: ${v.order}`);
  if (v.enabled === false) parts.push('enabled: false');
  parts.push(`personaPrefix: ${typeof v.personaPrefix === 'string' && v.personaPrefix ? `${v.personaPrefix.length} 字` : '（照标准模式）'}`);
  return parts.join('，');
}

function main() {
  const argv = process.argv.slice(2);
  const VALUED = ['--name', '--description', '--persona-prefix-file', '--order', '--dsh-home'];
  // 带值的参数后面跟的是另一个 --参数（或者什么都没有）= 少写了值：报问题，不把「--apply」当名字写进去
  const missing = VALUED.filter((k) => { const i = argv.indexOf(k); return i >= 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith('--')); });
  if (missing.length) { console.error(`问题：${missing.join('、')} 后面少了值`); console.error('有问题，没有动任何文件。'); process.exit(1); }
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = argv.includes('--apply');
  const dshHome = val('--dsh-home') ? path.resolve(val('--dsh-home')) : resolveDshHome(process.env);
  const file = path.join(dshHome, 'persona-memory.json');
  let personaPrefix;
  if (argv.includes('--clear-persona-prefix')) personaPrefix = null;
  const pf = val('--persona-prefix-file');
  if (pf) {
    try { personaPrefix = read(path.resolve(pf)); } catch (e) { console.error(`读不了 --persona-prefix-file（${e?.code ?? 'Error'}）`); process.exit(1); }
  }
  const order = val('--order') !== undefined ? Number(val('--order')) : undefined;
  const plan = planPresetConfig({ file, name: val('--name'), description: val('--description'), order, personaPrefix });
  console.log(`配置文件：${file}${plan.exists ? '' : '（还没有，--apply 时新建）'}`);
  console.log(`预设 id：${PERSONA_PRESET_ID}（固定，不改）`);
  console.log(`现在的 host.preset：${describePreset(plan.current)}`);
  if (!plan.ok) { for (const p of plan.problems) console.error(`问题：${p}`); console.error('有问题，没有动任何文件。'); process.exit(1); }
  console.log(`改成的 host.preset：${describePreset(plan.next)}`);
  if (!plan.changed) { console.log('已经是这样了，不用改。'); return; }
  if (!apply) { console.log('\n这是预演，什么都没改。确认要写就加 --apply。'); return; }
  const r = applyPresetConfig(file, plan);
  const bak = !r.backup ? '' : r.backupExisted ? `（备份 ${path.basename(r.backup)} 已经有了，是第一次用这个脚本改之前的那份，没有覆盖）` : `（原来的备份在 ${path.basename(r.backup)}）`;
  console.log(`✓ 写好了${bak}。插件在跑的话一分钟内热加载，预设的名字跟着变。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
