// 结构检查本身的测试（§2.2「结构检查是主防线」）：检查器认得出违规，也不误伤正常写法；真实仓库必须 0 错误。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lexJs, findImports, scanOpaqueIds, scanLiterals, checkRepo, platformWords } from '../../../scripts/check-boundaries.mjs';
import { tmpDir, rmDir, REPO_ROOT } from './helpers.js';

test('词法扫描：注释、字符串、正则都抹掉；模板的 ${} 保留', () => {
  const src = "const a = 'settingId.split(x)'; // settingId.split(y)\n/* obsId.slice(1) */ const r = /settingId/g; const t = `x${settingId}y`;";
  const { code, tmpl, strings } = lexJs(src);
  assert.equal(code.length, src.length);
  assert.ok(!code.includes('split'), code);
  assert.ok(!code.includes('slice'));
  const pos = code.indexOf('settingId');
  assert.ok(pos > 0 && tmpl[pos] === 1, '模板表达式里的标识符被标出来');
  assert.ok(strings.some((s) => s.value === 'settingId.split(x)'));
});

test('找 import：静态、动态、export from、side-effect、require；注释和普通字符串不算', () => {
  const src = [
    "import a from './a.js';",
    "import { b } from \"../b/index.js\";",
    "export * from './c.js';",
    "import './side.js';",
    "const j = await import('@node-rs/jieba');",
    "const r = require('fs');",
    "// import x from 'nope'",
    "const s = 'from here';",
  ].join('\n');
  const got = findImports(src).map((i) => [i.spec, i.dynamic, i.line]);
  assert.deepEqual(got, [['./a.js', false, 1], ['../b/index.js', false, 2], ['./c.js', false, 3], ['./side.js', false, 4], ['@node-rs/jieba', true, 5], ['fs', false, 6]]);
});

test('不透明 id：各种解析写法都报', () => {
  const bad = [
    "if (settingId.startsWith('grp')) x();",
    "const [kind] = o.settingId.split(':');",
    "const head = focusObsId?.slice(0, 3);",
    "if (/^g/.test(obsId)) y();",
    'const k = `${adapter}:${settingId}`;',
    "const k2 = 'grp-' + targetSettingId;",
    "const k3 = homeSettingId + '#';",
    "const parts = claim.id.split('');",
    "const low = accountId.toLowerCase();",
  ];
  for (const line of bad) assert.equal(scanOpaqueIds(line).length, 1, `应该报：${line} → ${JSON.stringify(scanOpaqueIds(line))}`);
});

test('不透明 id：正常写法不误伤；允许注释能放行', () => {
  const ok = [
    'if (a.settingId === b.settingId) z();',
    'isOpaqueId(settingId);',
    'keys.settingKey(adapterId, settingId);',
    '// settingId.split(":") 只是注释',
    "const msg = 'settingId.split 只是字符串';",
    'settingIdLeaksAccount(x, y);',
    'state.intake.settingIds.get(k);',
    'const n = settingIds.length + 1;',
    'const x = { settingId: s.id, obsId };',
    "if (settingId.includes(c.id)) w();   // boundary-allow: opaque-id 契约测试",
    "// boundary-allow: opaque-id 上一行放行\nconst p = obsId.split('-');",
  ];
  for (const line of ok) assert.deepEqual(scanOpaqueIds(line), [], `不该报：${line}`);
});

test('字面量提示：字符串和标识符里的平台词（整词），注释不算', () => {
  const words = ['qq', 'dsh-web', 'mcp__', 'bvid'];
  const src = "const a = 'qq-group'; const qqAdapter = 1; // qq 只是注释\nconst b = 'mcp__x__tool'; const c = 'squad'; const bvidOf = 2; const s = 'via dsh-web';";
  const hits = scanLiterals(src, words).map((h) => `${h.word}:${h.where}`).sort();
  assert.deepEqual(hits, ['bvid:identifier', 'dsh-web:string', 'mcp__:string', 'qq:identifier', 'qq:string']);
  assert.deepEqual(scanLiterals("const squad = 'qqq';", ['qq']), [], '整词匹配：squad、qqq 都不算');
});

test('真实仓库：0 个错误；已注册适配器的 id 进了平台词清单', () => {
  const { errors, files } = checkRepo(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.ok(files > 30);
  const words = platformWords(REPO_ROOT);
  assert.ok(words.includes('qq') && words.includes('dsh-web') && words.includes('onebot'));
});

test('合成的违规仓库：每一类违规都被认出来', async () => {
  const root = tmpDir('boundaries');
  try {
    const w = (p, s) => { const f = path.join(root, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
    w('packages/dsh/src/adapters/fake.js', "export const ADAPTER_ID = 'zzplat';\nimport x from '../host/index.js';\nimport y from 'rugu-core';\n");
    w('packages/dsh/src/host/index.js', "import z from 'rugu-core/src/store/index.js';\nimport q from '../../../core/src/api.js';\nexport {};\n");
    w('packages/dsh/src/binding/index.js', "import h from '../host/index.js';\nexport {};\n");
    w('packages/core/src/contract/index.js', "import s from '../store/index.js';\nexport {};\n");
    w('packages/core/src/store/index.js', "import i from '../intake/index.js';\nexport {};\n");
    w('packages/core/src/intake/index.js', "import fs from 'fs';\nimport lodash from 'lodash';\nimport j from '@node-rs/jieba';\nimport d from '../dynamics/weights.js';\nimport t from '../../test/fakes/index.js';\nexport const k = (settingId) => settingId.split(':');\nexport const zz = 'zzplat';\n");
    w('packages/core/src/dynamics/index.js', 'export {};\n');
    w('packages/core/src/dynamics/weights.js', 'export {};\n');
    w('packages/core/src/api.js', "import * as d from './dynamics/weights.js';\nimport * as ok from './dynamics/index.js';\n/** @param {import('./intake/index.js').X} x */\nexport {};\n");
    const { errors, warnings } = checkRepo(root);
    const has = (frag) => errors.some((e) => e.includes(frag));
    assert.ok(has("内置模块要写成 'node:fs'"));
    assert.ok(has("核心不许依赖外部包：'lodash'"));
    assert.ok(has('可选依赖只能动态 import()'));
    assert.ok(has('packages/core/src/intake/index.js:4 业务模块之间不许 import：调用 dynamics 写 core.mods.dynamics'));
    assert.ok(has("packages/core/src/api.js:1 只能经 dynamics/index.js 用这个模块"));
    assert.ok(!errors.some((e) => e.includes('packages/core/src/api.js:2')), '顶层文件经 index.js 用模块是允许的');
    assert.ok(!errors.some((e) => e.includes('packages/core/src/api.js:3')), 'JSDoc 里的 import() 只是类型，不算依赖');
    assert.ok(has('核心不许 import 核心 src 以外的文件'));
    assert.ok(has('不透明 id 不许做字符串解析'));
    assert.ok(has('contract 只许依赖 contract 自己'));
    assert.ok(has('基础层（store）不许依赖业务模块 intake'));
    assert.ok(has("只能经 'rugu-core' 或 'rugu-core/contract'"));
    assert.ok(has('不许用相对路径进核心或插件以外的地方'));
    assert.ok(has('适配器只依赖核心契约和 binding'));
    assert.ok(has('适配器和 DSH 绑定只依赖核心契约'));
    assert.ok(has('binding 不许依赖 host'));
    assert.ok(warnings.some((x) => x.includes('zzplat')), '注册过的适配器 id 出现在核心里 → 提示');
  } finally { rmDir(root); }
});
