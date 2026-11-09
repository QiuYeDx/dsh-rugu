// 实现契约文档（docs/实现/模块与接口.md）的自洽检查：§14.3 的每个场景只有一个牵头方，表和各模块小节里的「参与的场景」对得上；
// 每张表只有一个拥有者，和迁移里的 owner 一致。公开发布时 docs/ 可能被移走，那时跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MODULES } from '../src/api.js';
import { TABLE_OWNERS } from '../src/store/index.js';

const DOC = new URL('../../../docs/实现/模块与接口.md', import.meta.url);
const SCENARIOS = ['S1', 'S1b', 'S2', 'S2b', 'S3', 'S4', 'S5', 'S6', 'S7', 'S7b', 'S8', 'S8b', 'S8c', 'S9', 'S10', 'S10b', 'S11', 'S11b',
  'S12', 'S12b', 'S13', 'S14', 'S15', 'S16', 'S17', 'S17b', 'S18', 'S19', 'S19b', 'S20', 'S20b', 'S21', 'S22', 'S23', 'S23b', 'S24',
  'S25', 'S26', 'S27', 'S28', 'S29', 'S30', 'S31', 'S32', 'S33'];
const MODULE_NAMES = Object.keys(MODULES);
const SCENE_RE = /S\d+[a-z]?/g;

const section = (md, start, end) => {
  const a = md.indexOf(start);
  assert.ok(a >= 0, `文档里没有「${start}」`);
  const b = md.indexOf(end, a + start.length);
  return md.slice(a, b < 0 ? undefined : b);
};

test('场景归属（§4.14）：S1–S33 每个只有一个牵头方，和各模块的「参与的场景」一致', { skip: !fs.existsSync(DOC) }, () => {
  const md = fs.readFileSync(DOC, 'utf8');
  const rows = [...section(md, '### 4.14', '\n## ').matchAll(/^\| (S\d+[a-z]?) \| ([^|]+?) \| ([^|]*?) \|$/gm)]
    .map((m) => ({ id: m[1], lead: m[2].trim(), part: m[3] }));
  assert.deepEqual(rows.map((r) => r.id), SCENARIOS, '§4.14 要按顺序列出 §14.3 的全部场景，每个一行');
  const involved = (r) => new Set([r.lead, ...MODULE_NAMES.filter((m) => new RegExp(`(^|[^a-z])${m}([^a-z]|$)`).test(r.part))]);
  for (const r of rows) assert.ok(MODULE_NAMES.includes(r.lead) || r.lead === '集成' || r.lead === '宿主', `${r.id} 的牵头方「${r.lead}」不是模块、集成或宿主`);

  // 各模块小节的「参与的场景」
  const lists = {};
  for (const m of md.matchAll(/### 4\.\d+ (\w+)\n[\s\S]*?- \*\*参与的场景\*\*：([^\n]*)/g)) lists[m[1]] = new Set(m[2].match(SCENE_RE) ?? []);
  for (const r of rows) {
    for (const m of involved(r)) if (lists[m]) assert.ok(lists[m].has(r.id), `${m} 牵头或参与 ${r.id}，但它的小节里没列`);
  }
  for (const [m, set] of Object.entries(lists)) {
    for (const id of set) {
      const r = rows.find((x) => x.id === id);
      assert.ok(r && involved(r).has(m), `${m} 的小节列了 ${id}，但 §4.14 里它既不牵头也不参与`);
    }
  }
});

test('表的归属（§2.1）：每张表只有一个拥有者，和迁移一致', { skip: !fs.existsSync(DOC) }, () => {
  const md = fs.readFileSync(DOC, 'utf8');
  const owners = {};
  for (const line of section(md, '### 2.1', '### 2.2').split('\n')) {
    const m = line.match(/^\| ([^|]+) \| (\w+) \|/);
    if (!m || m[2] === '拥有者') continue;
    for (const raw of m[1].split('、')) {
      for (const t of raw.replace(/^向量库\s*/, '').split('/').map((x) => x.trim())) (owners[t] ??= []).push(m[2]);
    }
  }
  for (const [t, o] of Object.entries(TABLE_OWNERS)) {
    if (/_fts_(config|data|docsize|idx)$/.test(t)) continue;
    assert.deepEqual(owners[t], [o], `表 ${t}：文档里的拥有者 ${owners[t] ?? '（没写）'}，迁移里是 ${o}`);
  }
});

test('附录 A（§8）：和各模块 index.js 的 JSDoc 一致——签名改了要跑 node scripts/gen-signatures.mjs', { skip: !fs.existsSync(DOC) }, async () => {
  const { render } = await import('../../../scripts/gen-signatures.mjs');
  const md = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
  const a = md.indexOf('<!-- signatures:start -->');
  const b = md.indexOf('<!-- signatures:end -->');
  assert.ok(a >= 0 && b > a, '文档里没有附录 A 的标记');
  const now = md.slice(a, b + '<!-- signatures:end -->'.length);
  const want = render();
  if (now === want) return;
  // 指出第一处对不上的模块和行，方便看是哪次改动没重新生成
  const x = now.split('\n');
  const y = want.split('\n');
  const i = x.findIndex((l, k) => l !== y[k]);
  const mod = y.slice(0, i + 1).reverse().find((l) => l.startsWith('### '));
  assert.fail(`附录 A 过期了（${mod ?? '?'}）：文档「${x[i] ?? ''}」，代码「${y[i] ?? ''}」`.slice(0, 400));
});
