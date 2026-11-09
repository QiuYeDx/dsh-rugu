#!/usr/bin/env node
// 从各模块 index.js 的 JSDoc 生成签名清单，写进 docs/实现/模块与接口.md 的附录（两个标记之间）。
// 用法：node scripts/gen-signatures.mjs [--check]   （--check：附录过期就退出 1，不写文件）
// 以代码为准：签名改了就重新生成一次。并行实现期间不要求每个人都重新生成，整合时统一跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', '实现', '模块与接口.md');
const START = '<!-- signatures:start -->';
const END = '<!-- signatures:end -->';
const ORDER = ['lang', 'intake', 'entities', 'encode', 'dynamics', 'retrieve', 'discretion', 'context', 'consolidate', 'worker', 'backup', 'admin'];

/** 把 import('...').X 简写成 X，压掉多余空白。 */
const shortType = (t) => t.replace(/import\(['"][^'"]+['"]\)\./g, '').replace(/\s+/g, ' ').trim();

/** 取出一段 JSDoc 里的 {type}，允许嵌套花括号。 */
function readBraced(s, i) {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) return { text: s.slice(i + 1, j), end: j + 1 }; }
  }
  return null;
}

function parseDoc(doc) {
  const body = doc.replace(/^\/\*\*|\*\/$/g, '').split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n');
  const firstTag = body.search(/(^|\s)@(param|returns?|template|typedef)\b/);
  const summary = (firstTag >= 0 ? body.slice(0, firstTag) : body).replace(/\s+/g, ' ').trim();
  const params = [];
  let returns = null;
  const tagRe = /@(param|returns?)\s*/g;
  for (let m; (m = tagRe.exec(body));) {
    const b = readBraced(body, m.index + m[0].length);
    if (!b) continue;
    if (m[1] === 'param') {
      const rest = body.slice(b.end).match(/^\s*(\[?)([\w$.]+)(?:=[^\]]*)?\]?/);
      if (rest && !rest[2].includes('.')) params.push({ name: rest[2], optional: rest[1] === '[', type: shortType(b.text) });
    } else returns = shortType(b.text);
  }
  return { summary, params, returns };
}

export function extract(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*export\s+(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
  for (let m; (m = re.exec(src));) {
    const { summary, params, returns } = parseDoc(m[1]);
    const names = m[4].split(',').map((x) => x.trim()).filter(Boolean);
    const typed = names.map((n) => {
      const p = params.find((x) => x.name === n);
      if (n === 'core') return 'core';
      return p ? `${n}${p.optional ? '?' : ''}: ${p.type}` : n;
    });
    let ret = returns ?? (m[2] ? 'Promise<void>' : 'void');
    if (m[2] && !/^Promise</.test(ret)) ret = `Promise<${ret}>`;
    out.push({ name: m[3], sig: `${m[3]}(${typed.join(', ')}): ${ret}`, summary });
  }
  return out;
}

export function render() {
  const lines = [START, '', '## 附录 A：各模块的导出函数（由 `scripts/gen-signatures.mjs` 从 JSDoc 生成，以代码为准）', ''];
  for (const mod of ORDER) {
    const file = path.join(ROOT, 'packages', 'core', 'src', mod, 'index.js');
    lines.push(`### ${mod}`, '');
    for (const f of extract(file)) {
      lines.push(`- \`${f.sig}\``);
      if (f.summary) lines.push(`  ${f.summary}`);
    }
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 换行按 LF 比较：Windows 上 git（core.autocrlf）检出的文档是 CRLF，不能因此永远报「过期」；写回时沿用文档自己的换行
  const raw = fs.readFileSync(DOC, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const doc = raw.replace(/\r\n/g, '\n');
  const block = render();
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  const next = a >= 0 && b > a ? doc.slice(0, a) + block + doc.slice(b + END.length) : `${doc.trimEnd()}\n\n---\n\n${block}\n`;
  if (process.argv.includes('--check')) {
    if (next !== doc) { console.log('附录 A 过期了：跑一次 node scripts/gen-signatures.mjs'); process.exit(1); }
    console.log('附录 A 是最新的');
  } else {
    fs.writeFileSync(DOC, eol === '\n' ? next : next.replace(/\n/g, eol));
    console.log(`写好了附录 A（${ORDER.length} 个模块）`);
  }
}
