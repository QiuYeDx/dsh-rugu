#!/usr/bin/env node
// 结构检查（设计 §2.2「结构检查是主防线」、§3.5、§14.2「核心纯净」）。不用 AST 库，自己写一个够用的 JS 词法扫描：
//   1. 依赖边界（错误）：
//      - 核心（packages/core/src）只 import node: 内置模块和核心自己的文件；外部包只许可选的 @node-rs/jieba，且只能动态 import()；
//      - 核心里，基础层（contract / store / config / ports / core-types.js）不许 import 业务模块；contract 只许 import contract 自己；
//      - 业务模块之间不许 static import：跨模块调用一律 core.mods.<模块>.<函数>(core, …)（单测里才能换掉依赖）；
//        顶层文件（api.js、maintenance.js）只能经各模块的 index.js 用它们；
//      - DSH 插件（packages/dsh/src）只能经 'rugu-core' 或 'rugu-core/contract' 用核心，不许深路径、不许相对路径进核心；
//      - 适配器（adapters/）和 DSH 绑定（binding/）只依赖核心契约和绑定的类型（§3.5 第 3 条）。
//   2. 不透明 id（错误）：核心里不许对 SettingId、ObsId、账号 id 做字符串解析——startsWith / split / slice / 正则 / 模板拼接 / + 拼接。
//      确实需要的地方，在同一行或上一行写 `// boundary-allow: opaque-id <理由>`。
//   3. 字面量（只是提示）：核心的字符串字面量和标识符里出现已注册适配器的 id 或平台词（整词匹配）。
//      清单 = packages/dsh/src/adapters/*.js 里的 `export const ADAPTER_ID = '...'` + scripts/platform-words.json。
// 用法：node scripts/check-boundaries.mjs   （有错误时退出码 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = new Set(['contract', 'store', 'config', 'ports']);
const INFRA_FILES = new Set(['core-types.js']);
const OPTIONAL_CORE_DEPS = new Set(['@node-rs/jieba']);
const CORE_PUBLIC_ENTRIES = new Set(['rugu-core', 'rugu-core/contract']);
const ALLOW_OPAQUE = /boundary-allow:\s*opaque-id/;

// ── 词法扫描 ──────────────────────────────────────────────────────────────
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

/**
 * 把源码切成：code（注释、字符串、正则、模板文字部分都换成空格，换行保留，长度不变）、
 * tmpl（每个位置是不是在模板字符串的 ${} 里）、strings（字符串字面量的位置和内容，含模板文字段）。
 * @param {string} src
 */
export function lexJs(src) {
  const out = src.split('');
  const tmpl = new Uint8Array(src.length);
  const strings = [];
  const blank = (i) => { if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '; };
  /** 模板嵌套栈：每层记进入 ${ 时的花括号深度 */
  const tstack = [];
  let brace = 0;
  let i = 0;
  let lastSig = '';      // 上一个有意义的 token（判断 / 是正则还是除号）
  const n = src.length;
  const markTmpl = (a, b) => { if (tstack.length) for (let k = a; k < b; k++) tmpl[k] = 1; };

  function readTemplate() {
    // 现在 src[i] 是 ` 或者 } （从 ${} 回到模板文字）
    const start = i;
    i++;
    let text = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { text += src.slice(i, i + 2); blank(i); blank(i + 1); i += 2; continue; }
      if (c === '`') { strings.push({ start, end: i + 1, value: text, template: true }); i++; lastSig = 'str'; return; }
      if (c === '$' && src[i + 1] === '{') {
        strings.push({ start, end: i, value: text, template: true });
        i += 2;
        tstack.push(brace);
        brace++;
        lastSig = '{';
        return;
      }
      text += c;
      blank(i);
      i++;
    }
  }

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { blank(i); i++; } continue; }
    if (c === '/' && d === '*') { blank(i); blank(i + 1); i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; } blank(i); blank(i + 1); i += 2; continue; }
    if (c === '"' || c === "'") {
      const start = i;
      let text = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { text += src.slice(i, i + 2); blank(i); blank(i + 1); i += 2; continue; }
        text += src[i]; blank(i); i++;
      }
      i++;
      strings.push({ start, end: i, value: text, template: false });
      markTmpl(start, i);
      lastSig = 'str';
      continue;
    }
    if (c === '`') { readTemplate(); continue; }
    if (c === '}' && tstack.length && brace - 1 === tstack.at(-1)) {
      brace--;
      tstack.pop();
      readTemplate();
      continue;
    }
    if (c === '/' && (REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.has(lastSig))) {
      // 正则字面量
      const start = i;
      blank(i); i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const x = src[i];
        if (x === '\\') { blank(i); blank(i + 1); i += 2; continue; }
        if (x === '[') inClass = true;
        else if (x === ']') inClass = false;
        else if (x === '/' && !inClass) { blank(i); i++; break; }
        blank(i); i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) { blank(i); i++; }
      markTmpl(start, i);
      lastSig = 'regex';
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(src[i])) i++;
      markTmpl(start, i);
      lastSig = src.slice(start, i);
      continue;
    }
    if (/[0-9]/.test(c)) { const s = i; while (i < n && /[\w.]/.test(src[i])) i++; markTmpl(s, i); lastSig = 'num'; continue; }
    if (c === '{') brace++;
    else if (c === '}') brace--;
    markTmpl(i, i + 1);
    lastSig = c;
    i++;
  }
  return { code: out.join(''), tmpl, strings };
}

/** 位置 → 行号（从 1 开始）。 */
function lineOf(src, pos) {
  let line = 1;
  for (let k = 0; k < pos && k < src.length; k++) if (src[k] === '\n') line++;
  return line;
}

/**
 * 找出全部 import / export from / import() / require() 的模块名。
 * @returns {{spec: string, dynamic: boolean, line: number}[]}
 */
export function findImports(src) {
  const { code, strings } = lexJs(src);
  const out = [];
  for (const s of strings) {
    if (s.template) continue;
    const before = code.slice(Math.max(0, s.start - 40), s.start).replace(/\s+/g, ' ').trimEnd();
    const dynamic = /\bimport\s?\($/.test(before);
    const required = /\brequire\s?\($/.test(before);
    const isStatic = /\bfrom$/.test(before) || /(^|[;\s}])import$/.test(before);
    if (!dynamic && !required && !isStatic) continue;
    out.push({ spec: s.value, dynamic, line: lineOf(src, s.start) });
  }
  return out;
}

// ── 不透明 id ─────────────────────────────────────────────────────────────
// 名字以 settingId / obsId / accountId 结尾的变量和属性（targetSettingId、focusObsId……），整词
const ID_NAME = String.raw`(?:[A-Za-z_$][\w$]*?)?(?:[sS]ettingId|[oO]bsId|[aA]ccountId)s?(?![\w$])`;
const ID_EXPR = String.raw`(?:(?:[\w$]+\??\.)*${ID_NAME}|(?:claim|acct|account)\??\.id)`;
const STRING_METHODS = 'startsWith|endsWith|split|slice|substring|substr|indexOf|lastIndexOf|includes|match|matchAll|replace|replaceAll|search|charAt|charCodeAt|codePointAt|at|padStart|padEnd|toLowerCase|toUpperCase|trim|trimStart|trimEnd|concat|normalize';
const RULES = [
  { re: new RegExp(String.raw`\b${ID_EXPR}\s*\??\.\s*(?:${STRING_METHODS})\s*\(`, 'g'), what: '字符串方法' },
  { re: new RegExp(String.raw`\.(?:test|exec)\s*\(\s*${ID_EXPR}\b`, 'g'), what: '正则' },
  { re: new RegExp(String.raw`\b${ID_EXPR}\s*\+(?![+=])`, 'g'), what: '+ 拼接' },
  { re: new RegExp(String.raw`(?<![+])\+\s*${ID_EXPR}\b`, 'g'), what: '+ 拼接' },
];
const ID_IN_TEMPLATE = new RegExp(String.raw`\b${ID_EXPR}\b`, 'g');

/**
 * 不透明 id 的字符串解析（§2.2）。返回 [{line, what, text}]。
 * @param {string} src
 */
export function scanOpaqueIds(src) {
  const { code, tmpl } = lexJs(src);
  const lines = src.split('\n');
  const allowed = (line) => ALLOW_OPAQUE.test(lines[line - 1] ?? '') || ALLOW_OPAQUE.test(lines[line - 2] ?? '');
  const hits = [];
  const add = (pos, what, text) => {
    const line = lineOf(src, pos);
    if (!allowed(line) && !hits.some((h) => h.line === line && h.what === what)) hits.push({ line, what, text: text.trim().slice(0, 60) });
  };
  for (const { re, what } of RULES) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(code));) add(m.index, what, m[0]);
  }
  ID_IN_TEMPLATE.lastIndex = 0;
  for (let m; (m = ID_IN_TEMPLATE.exec(code));) if (tmpl[m.index]) add(m.index, '模板拼接', m[0]);
  return hits.sort((a, b) => a.line - b.line);
}

// ── 字面量提示 ────────────────────────────────────────────────────────────
const splitIdent = (id) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$]+/).filter(Boolean).map((s) => s.toLowerCase());

/**
 * 字符串字面量和标识符里有没有平台词（整词，不分大小写）。注释不扫。
 * @param {string} src
 * @param {string[]} words
 * @returns {{line: number, word: string, where: 'string'|'identifier'}[]}
 */
export function scanLiterals(src, words) {
  const plain = new Set(words.filter((w) => /^[a-z0-9]+$/i.test(w)).map((w) => w.toLowerCase()));
  const odd = words.filter((w) => !/^[a-z0-9]+$/i.test(w)).map((w) => w.toLowerCase());
  const { code, strings } = lexJs(src);
  const hits = [];
  for (const s of strings) {
    const v = s.value.toLowerCase();
    for (const w of v.split(/[^a-z0-9]+/)) if (plain.has(w)) hits.push({ line: lineOf(src, s.start), word: w, where: 'string' });
    for (const w of odd) if (v.includes(w)) hits.push({ line: lineOf(src, s.start), word: w, where: 'string' });
  }
  const identRe = /[A-Za-z_$][\w$]*/g;
  for (let m; (m = identRe.exec(code));) {
    const segs = splitIdent(m[0]);
    for (const w of segs) if (plain.has(w)) hits.push({ line: lineOf(src, m.index), word: w, where: 'identifier' });
    for (const w of odd) if (m[0].toLowerCase().includes(w)) hits.push({ line: lineOf(src, m.index), word: w, where: 'identifier' });
  }
  return hits;
}

// ── 仓库级检查 ────────────────────────────────────────────────────────────
function listJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const isBuiltin = (spec) => spec.startsWith('node:') || builtinModules.includes(spec);
const inside = (file, dir) => { const r = path.relative(dir, file); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
/** 核心 src 下的文件属于哪一块：业务模块名、基础层名，或顶层文件名（加 @ 前缀）。 */
function coreUnit(coreSrc, file) {
  const parts = path.relative(coreSrc, file).split(path.sep);
  return parts.length > 1 ? parts[0] : `@${parts[0]}`;
}

/** 已注册适配器的 id + 平台词清单。 */
export function platformWords(root = ROOT) {
  const words = new Set();
  for (const f of listJs(path.join(root, 'packages', 'dsh', 'src', 'adapters'))) {
    const m = fs.readFileSync(f, 'utf8').match(/export\s+const\s+ADAPTER_ID\s*=\s*['"]([^'"]+)['"]/);
    if (m) words.add(m[1]);
  }
  const extra = path.join(root, 'scripts', 'platform-words.json');
  if (fs.existsSync(extra)) for (const w of JSON.parse(fs.readFileSync(extra, 'utf8')).words ?? []) words.add(w);
  return [...words];
}

/**
 * @returns {{errors: string[], warnings: string[], files: number}}
 */
export function checkRepo(root = ROOT) {
  const CORE_SRC = path.join(root, 'packages', 'core', 'src');
  const DSH_SRC = path.join(root, 'packages', 'dsh', 'src');
  const rel = (p) => path.relative(root, p).split(path.sep).join('/');
  const errors = [];
  const warnings = [];
  const coreFiles = listJs(CORE_SRC);
  const dshFiles = listJs(DSH_SRC);
  const words = platformWords(root);

  for (const file of coreFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const unit = coreUnit(CORE_SRC, file);
    const isInfra = INFRA.has(unit) || INFRA_FILES.has(unit.slice(1));
    for (const imp of findImports(src)) {
      const at = `${rel(file)}:${imp.line}`;
      if (isBuiltin(imp.spec)) {
        if (!imp.spec.startsWith('node:')) errors.push(`${at} 内置模块要写成 'node:${imp.spec}'`);
        continue;
      }
      if (!imp.spec.startsWith('.')) {
        if (OPTIONAL_CORE_DEPS.has(imp.spec) && imp.dynamic) continue;
        errors.push(`${at} 核心不许依赖外部包：'${imp.spec}'${OPTIONAL_CORE_DEPS.has(imp.spec) ? '（可选依赖只能动态 import()）' : ''}`);
        continue;
      }
      const target = path.resolve(path.dirname(file), imp.spec);
      if (!inside(target, CORE_SRC)) { errors.push(`${at} 核心不许 import 核心 src 以外的文件：'${imp.spec}'`); continue; }
      const tUnit = coreUnit(CORE_SRC, target);
      if (tUnit === unit) continue;
      const tIsInfra = INFRA.has(tUnit) || INFRA_FILES.has(tUnit.slice(1));
      if (unit === 'contract' && tUnit !== 'contract') { errors.push(`${at} contract 只许依赖 contract 自己（适配器只拿到它）：'${imp.spec}'`); continue; }
      if (isInfra && !tIsInfra) { errors.push(`${at} 基础层（${unit}）不许依赖业务模块 ${tUnit}`); continue; }
      const isBusiness = !isInfra && !unit.startsWith('@');
      const tIsBusiness = !tIsInfra && !tUnit.startsWith('@');
      if (isBusiness && tIsBusiness) {
        errors.push(`${at} 业务模块之间不许 import：调用 ${tUnit} 写 core.mods.${tUnit}.<函数>(core, …)（类型只在 JSDoc 里 import()）`);
        continue;
      }
      if (tIsBusiness && path.basename(target) !== 'index.js') {
        errors.push(`${at} 只能经 ${tUnit}/index.js 用这个模块，不许直接 import 它的内部文件：'${imp.spec}'`);
      }
    }
    for (const h of scanOpaqueIds(src)) errors.push(`${rel(file)}:${h.line} 不透明 id 不许做字符串解析（${h.what}）：${h.text}`);
    for (const h of scanLiterals(src, words)) warnings.push(`${rel(file)}:${h.line} 核心的${h.where === 'string' ? '字符串' : '标识符'}里出现平台词「${h.word}」`);
  }

  for (const file of dshFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const sub = path.relative(DSH_SRC, file).split(path.sep)[0];
    for (const imp of findImports(src)) {
      const at = `${rel(file)}:${imp.line}`;
      if (isBuiltin(imp.spec)) continue;
      if (imp.spec.startsWith('rugu-core')) {
        if (!CORE_PUBLIC_ENTRIES.has(imp.spec)) { errors.push(`${at} 只能经 'rugu-core' 或 'rugu-core/contract' 用核心：'${imp.spec}'`); continue; }
        if ((sub === 'adapters' || sub === 'binding') && imp.spec !== 'rugu-core/contract') {
          errors.push(`${at} 适配器和 DSH 绑定只依赖核心契约（'rugu-core/contract'）`);
        }
        continue;
      }
      if (imp.spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), imp.spec);
        if (!inside(target, DSH_SRC)) { errors.push(`${at} 不许用相对路径进核心或插件以外的地方：'${imp.spec}'`); continue; }
        const tSub = path.relative(DSH_SRC, target).split(path.sep)[0];
        if (sub === 'adapters' && !['adapters', 'binding'].includes(tSub)) errors.push(`${at} 适配器只依赖核心契约和 binding：'${imp.spec}'`);
        if (sub === 'binding' && tSub !== 'binding') errors.push(`${at} binding 不许依赖 ${tSub}：'${imp.spec}'`);
        continue;
      }
      if (sub === 'adapters' || sub === 'binding') errors.push(`${at} 适配器和 DSH 绑定不许依赖外部包：'${imp.spec}'`);
    }
  }
  return { errors, warnings, files: coreFiles.length + dshFiles.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { errors, warnings, files } = checkRepo();
  for (const w of warnings) console.log(`提示 ${w}`);
  for (const e of errors) console.log(`错误 ${e}`);
  console.log(`check-boundaries：扫了 ${files} 个文件，${errors.length} 个错误，${warnings.length} 个提示`);
  process.exit(errors.length ? 1 : 0);
}
