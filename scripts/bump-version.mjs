#!/usr/bin/env node
// 改版本号：两个包的版本一起走，一次改齐所有写了版本号的地方（VERSION_SPOTS）。默认只预演（打印会改什么），加 --apply 才写。
//   版本号要是 semver（1.2.3、0.2.0-beta.1 这样；不带 v，不带 +build）；和现在一样的拒绝；比现在小的要加 --allow-downgrade。
//   写回时保留文件原来的换行（CRLF / LF）和两格缩进；package-lock.json 只改两个工作区包的那几处，不重新解析依赖（之后 npm install 也不会再改它）。
//   哪几处必须一致由测试守着（packages/core/test/package/version.test.js）。什么时候改版本由主人定。
// 用法：node scripts/bump-version.mjs <新版本> [--apply] [--allow-downgrade] [--root <仓库目录>]（--root 给测试在副本上跑）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** semver 2.0（不带 build 元数据）。 */
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** 写了版本号的地方：文件（相对仓库根）+ JSON 里的路径。 */
export const VERSION_SPOTS = Object.freeze([
  { file: 'packages/core/package.json', path: ['version'] },
  { file: 'packages/dsh/package.json', path: ['version'] },
  { file: 'packages/dsh/package.json', path: ['dependencies', 'rugu-core'] },   // 插件锁定核心的精确版本
  { file: 'packages/dsh/dsh.plugin.json', path: ['version'] },
  { file: 'package-lock.json', path: ['packages', 'packages/core', 'version'] },
  { file: 'package-lock.json', path: ['packages', 'packages/dsh', 'version'] },
  { file: 'package-lock.json', path: ['packages', 'packages/dsh', 'dependencies', 'rugu-core'] },
]);

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const getAt = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** 每一处现在的值。 */
export function currentVersions(root = ROOT) {
  const cache = new Map();
  return VERSION_SPOTS.map((s) => {
    if (!cache.has(s.file)) cache.set(s.file, readJson(path.join(root, s.file)));
    return { ...s, value: getAt(cache.get(s.file), s.path) };
  });
}

/** 比较两个 semver：-1 / 0 / 1（预发布按 semver 规则）。 */
export function compareVersions(a, b) {
  const pa = VERSION_RE.exec(a);
  const pb = VERSION_RE.exec(b);
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const xa = pa[4].split('.');
  const xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) { if (Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) < Number(xb[i]) ? -1 : 1; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 算出要改什么（不写）。
 * @returns {{ok: true, from: string|null, to: string, changes: {file: string, path: string[], from: any, to: string}[]} | {ok: false, error: string}}
 */
export function planBump(to, { root = ROOT, allowDowngrade = false } = {}) {
  if (typeof to !== 'string' || !VERSION_RE.test(to)) return { ok: false, error: `版本号格式不对：${to ?? '（没给）'}（要 semver，比如 0.2.0 或 0.2.0-beta.1，不带 v）` };
  let cur;
  try { cur = currentVersions(root); } catch (e) { return { ok: false, error: `读不了版本号所在的文件：${e.message}` }; }
  const missing = cur.filter((c) => typeof c.value !== 'string');
  if (missing.length) return { ok: false, error: `这几处没有版本号（文件结构变了，先改 VERSION_SPOTS）：${missing.map((m) => `${m.file} ${m.path.join('.')}`).join('；')}` };
  const from = cur[0].value;
  if (cur.every((c) => c.value === to)) return { ok: false, error: `已经是 ${to} 了` };
  if (VERSION_RE.test(from) && compareVersions(to, from) < 0 && !allowDowngrade) return { ok: false, error: `${to} 比现在的 ${from} 小；确实要降就加 --allow-downgrade` };
  const changes = cur.filter((c) => c.value !== to).map((c) => ({ file: c.file, path: c.path, from: c.value, to }));
  return { ok: true, from, to, changes };
}

/** 按 planBump 的结果写回（保留换行风格，两格缩进，末尾一个换行）。 */
export function applyBump(plan, { root = ROOT } = {}) {
  const byFile = new Map();
  for (const c of plan.changes) (byFile.get(c.file) ?? byFile.set(c.file, []).get(c.file)).push(c);
  for (const [file, list] of byFile) {
    const abs = path.join(root, file);
    const raw = fs.readFileSync(abs, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const obj = JSON.parse(raw.replace(/^﻿/, ''));
    for (const c of list) {
      const parent = getAt(obj, c.path.slice(0, -1));
      parent[c.path.at(-1)] = c.to;
    }
    const out = `${JSON.stringify(obj, null, 2)}\n`.replace(/\n/g, eol);
    const tmp = `${abs}.tmp-bump`;
    fs.writeFileSync(tmp, (raw.startsWith('﻿') ? '﻿' : '') + out);
    fs.renameSync(tmp, abs);
  }
  return [...byFile.keys()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--root');
  const root = ri >= 0 ? path.resolve(argv[ri + 1] ?? '') : ROOT;
  const to = argv.find((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  const plan = planBump(to, { root, allowDowngrade: argv.includes('--allow-downgrade') });
  if (!plan.ok) { console.error(`bump-version：${plan.error}`); process.exit(2); }
  for (const c of plan.changes) console.log(`${c.file}  ${c.path.join('.')}：${c.from} → ${c.to}`);
  if (!argv.includes('--apply')) {
    console.log(`\n这是预演，什么都没改。确认要改成 ${plan.to} 就加 --apply。`);
  } else {
    const files = applyBump(plan, { root });
    console.log(`\n已改 ${files.length} 个文件。之后跑一遍全量测试；README 里没有写版本号，不用同步。`);
  }
}
