// QQ 桥接白名单补丁的核心（D129）：算补丁、执行补丁。管理页「设置 → QQ 桥接」（host/bridge-setup.js）和命令行（scripts/bridge-whitelist-patch.mjs）共用这一份。
//   纯函数 planPatch 不碰文件；runPatch 默认只预演；规矩见命令行脚本开头。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARK = '// persona-memory patch';
// D156 加了 memory_look：打过旧补丁的桥接重打一次只补上缺的那一行（幂等：已经有的不动）
export const TOOLS = Object.freeze(['memory_recall', 'memory_note', 'memory_fix', 'memory_look']);
export const RESTRICT_REL = path.join('plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const SET_START = 'const SAFE_EXACT = new Set([';
const ANCHOR = "'todo_write',";

const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');

/**
 * 算出补丁（纯函数，不碰文件）。
 * @param {string} src  qq-tool-restrict.mjs 的内容
 * @param {{revert?: boolean, tools?: string[]}} [opt]
 * @returns {{ok: boolean, error?: string, changes: {op: 'add'|'remove', line: string}[], next: string, already: string[]}}
 */
export function planPatch(src, { revert = false, tools = TOOLS } = {}) {
  const text = String(src ?? '').replace(/^﻿/, '');
  const eol = eolOf(text);
  const lines = text.split(eol);
  if (revert) {
    const removed = lines.filter((l) => l.includes(MARK));
    return { ok: true, changes: removed.map((line) => ({ op: 'remove', line })), next: lines.filter((l) => !l.includes(MARK)).join(eol), already: [] };
  }
  const start = lines.findIndex((l) => l.includes(SET_START));
  if (start < 0) return { ok: false, error: '找不到 SAFE_EXACT（桥接版本变了？），请手工把工具名加进白名单', changes: [], next: text, already: [] };
  let end = lines.findIndex((l, i) => i > start && /^\s*\]\)/.test(l));
  if (end < 0) end = lines.length;
  const anchor = lines.findIndex((l, i) => i > start && i < end && l.trim() === ANCHOR);
  if (anchor < 0) return { ok: false, error: `SAFE_EXACT 里找不到锚点行 ${ANCHOR}，不硬改`, changes: [], next: text, already: [] };
  const body = lines.slice(start, end);
  const already = tools.filter((t) => body.some((l) => l.trim().startsWith(`'${t}'`)));
  const missing = tools.filter((t) => !already.includes(t));
  const add = missing.map((t, i) => `  '${t}', ${MARK}${i === 0 && !already.length ? '：记忆插件 dsh-rugu 的工具（授权由记忆插件按库里的那条消息判定，§10.8）' : ''}`);
  const out = [...lines];
  out.splice(anchor + 1, 0, ...add);
  return { ok: true, changes: add.map((line) => ({ op: 'add', line })), next: out.join(eol), already };
}

/** 找桥接目录：--bridge > 配置文件的 host.adapters.qq.bridgeDir。 */
export function resolveBridgeDir({ bridge, config, env = process.env } = {}) {
  if (bridge) return path.resolve(bridge);
  const home = String(env.DSH_HOME ?? '').trim() || path.join(os.homedir(), '.dsh');
  const file = config ? path.resolve(config) : path.join(home, 'persona-memory.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const dir = j?.host?.adapters?.qq?.bridgeDir;
    return typeof dir === 'string' && dir ? path.resolve(dir) : null;
  } catch { return null; }
}

/**
 * 执行（或预演）。返回给命令行打印的结果。
 * @param {{bridgeDir: string, apply?: boolean, revert?: boolean, fsImpl?: typeof fs}} opt
 */
export function runPatch({ bridgeDir, apply = false, revert = false, fsImpl = fs }) {
  const file = path.join(bridgeDir, RESTRICT_REL);
  let src;
  try { src = fsImpl.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, file, error: `读不到 ${RESTRICT_REL}（${e?.code ?? 'Error'}）：这个目录不像桥接`, changes: [], applied: false }; }
  const plan = planPatch(src, { revert });
  if (!plan.ok) return { ok: false, file, error: plan.error, changes: [], applied: false };
  const res = { ok: true, file, changes: plan.changes, already: plan.already, applied: false, backup: null };
  if (!apply || !plan.changes.length) return res;
  const bak = `${file}.bak-persona-memory`;
  if (!fsImpl.existsSync(bak)) { fsImpl.copyFileSync(file, bak); res.backup = bak; }
  fsImpl.writeFileSync(file, plan.next);
  res.applied = true;
  return res;
}
