// QQ 桥接（dsh-qq）的接入（D129）：管理页「设置 → QQ 桥接」和首次设置共用。
//   - 找桥接目录：配置里的 → 从 DSH 会话的工作目录往上找（dsh-qq 的会话默认开在 <桥接>/state/agents）→ 也可以手填；
//   - 白名单补丁：直接用 bridge-whitelist.js 的 planPatch / runPatch（同一份逻辑，命令行也用它），带预览和还原；
//   - 改白名单要彻底重启 DSH 才生效，页面上写清楚，这里不替主人重启。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { planPatch, runPatch, RESTRICT_REL, TOOLS, MARK } from './bridge-whitelist.js';
import { projectBridgeConfig, projectSocial, canonicalKey, splitKey } from '../adapters/qq/files.js';
import { createPlatformNames } from '../adapters/qq/names.js';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SOCIAL_REL = path.join('state', 'social-v2.json');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
/** 这个目录是不是 dsh-qq 桥接（有白名单文件）。 */
export const isBridgeDir = (dir) => isFile(path.join(dir, RESTRICT_REL));

/** 会话工作目录 → 它所在的桥接目录（往上找几层），不是就返回 ''。 */
export function bridgeDirOf(cwd) {
  if (!cwd) return '';
  let d = path.resolve(String(cwd));
  for (let i = 0; i < 4; i += 1) {
    if (isBridgeDir(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}

/** 一个会话日志的第一行（会话头，里面有 cwd）。.zstd 是一串独立的帧，只解第一帧。 */
function sessionHead(file) {
  try {
    let text;
    if (file.endsWith('.zstd')) {
      if (typeof zlib.zstdDecompressSync !== 'function') return null;
      const buf = fs.readFileSync(file);
      const next = buf.indexOf(ZSTD_MAGIC, 4);
      text = zlib.zstdDecompressSync(next > 0 ? buf.subarray(0, next) : buf).toString('utf8');
    } else {
      const fd = fs.openSync(file, 'r');
      try { const b = Buffer.alloc(4096); text = b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString('utf8'); } finally { fs.closeSync(fd); }
    }
    return JSON.parse(text.split('\n')[0]);
  } catch { return null; }
}

/**
 * DSH 会话里出现过的桥接目录。每个项目目录（按工作目录分）只读一个会话的会话头，只取 cwd，不读对话内容。
 * @param {string} sessionsDir   <DSH 家目录>/sessions
 * @param {string[]} [extra]     另外知道的目录
 * @returns {string[]}
 */
export function findBridgeDirs(sessionsDir, extra = []) {
  const out = new Set();
  for (const e of extra) { if (e && isBridgeDir(e)) out.add(path.resolve(e)); }
  let projects = [];
  try { projects = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch { /* 没有会话目录 */ }
  for (const p of projects.slice(0, 200)) {
    try {
      const dir = path.join(sessionsDir, p.name);
      const one = fs.readdirSync(dir, { withFileTypes: true }).find((x) => x.isDirectory());
      if (!one) continue;
      const file = fs.readdirSync(path.join(dir, one.name)).filter((x) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(x)).sort().pop();
      const head = file && sessionHead(path.join(dir, one.name, file));
      const b = bridgeDirOf(head?.cwd);
      if (b) out.add(b);
    } catch { /* 读不了就跳过 */ }
  }
  return [...out];
}

/** 白名单现在的状态（只读）。 */
function whitelistOf(dir) {
  const file = path.join(dir, RESTRICT_REL);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return { readable: false, patched: false, missing: [...TOOLS], applicable: false }; }
  const plan = planPatch(src);
  const revert = planPatch(src, { revert: true });
  return {
    readable: true,
    applicable: plan.ok,
    error: plan.ok ? null : plan.error,
    patched: plan.ok && plan.changes.length === 0,
    missing: plan.ok ? plan.changes.map((c) => /'([^']+)'/.exec(c.line)?.[1]).filter(Boolean) : [...TOOLS],
    canRevert: revert.changes.length > 0,
    hasBackup: isFile(`${file}.bak-persona-memory`),
  };
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

/**
 * 桥接放行了哪些群（D131，首次设置列出来让主人取消）。名字：桥接配置里的备注 → SnowLuma 缓存库里的真实群名；都没有就只有群号。
 * 桥接没设白名单、又放行全部时（allowAll）列不全，只列出已经有聊天的群。只读，不调 QQ。
 * @returns {{readable: boolean, allowAll: boolean, groups: {id: string, name: string|null}[]}}
 */
export function bridgeGroups(dir, { now = () => Date.now(), names = null } = {}) {
  const raw = readJson(path.join(dir, 'config.json'));
  if (!raw) return { readable: false, allowAll: false, groups: [] };
  const cfg = projectBridgeConfig(raw);
  const allowAll = cfg.allow.group.length === 0 && cfg.allowAllWhenEmpty;
  let ids = cfg.allow.group;
  if (allowAll) {
    const social = projectSocial(readJson(path.join(dir, SOCIAL_REL)) ?? {});
    ids = [...social.conversations.keys()].map((k) => splitKey(canonicalKey(k))).filter((k) => k.kind === 'group').map((k) => k.id);
  }
  const platform = names ?? createPlatformNames({ dir: () => cfg.snowlumaHome || null, now });
  const groups = [...new Set(ids)].filter((id) => !cfg.deny.group.includes(id)).map((id) => {
    let name = cfg.groups.get(id)?.label ?? null;
    if (!name) { try { name = platform.group(id)?.name || null; } catch { name = null; } }
    return { id, name };
  });
  groups.sort((a, b) => Number(!a.name) - Number(!b.name));
  return { readable: true, allowAll, groups };
}

/**
 * @param {{hostConfig: () => any, setConfig: (patch: object, o: {confirm: boolean}) => any, sessionsDir: string, log?: {info: Function, warn: Function}}} deps
 */
export function createBridgeSetup({ hostConfig, setConfig, sessionsDir, log = { info() {}, warn() {} } }) {
  const configured = () => {
    const d = hostConfig().adapters?.qq?.bridgeDir;
    return typeof d === 'string' && d.trim() ? path.resolve(d.trim()) : '';
  };
  /** 一个目录的情况（只读，不回传目录里的任何内容）。 */
  function inspect(dir) {
    const d = path.resolve(dir);
    if (!isBridgeDir(d)) return { dir: d, isBridge: false };
    return { dir: d, isBridge: true, hasSocial: isFile(path.join(d, SOCIAL_REL)), whitelist: whitelistOf(d) };
  }
  return {
    /** @param {{dir?: string}} [q]  手填的目录：顺便看看它 */
    status(q = {}) {
      const cur = configured();
      const candidates = findBridgeDirs(sessionsDir, cur ? [cur] : []);
      const manual = q.dir ? inspect(q.dir) : null;
      return { configured: cur, current: cur ? inspect(cur) : null, groups: cur && isBridgeDir(cur) ? bridgeGroups(cur) : null, candidates: candidates.map(inspect), manual, mark: MARK, restartNote: '改白名单要彻底重启 DSH 才生效（已经开着的 QQ 会话要重建才拿到）。' };
    },
    /** 预览（不写）：要加 / 要删的行。 */
    preview({ dir, revert = false }) {
      const r = runPatch({ bridgeDir: path.resolve(dir), apply: false, revert });
      return { ok: r.ok, error: r.error ?? null, file: r.file, already: r.already ?? [], changes: r.changes.map((c) => ({ op: c.op, line: c.line.trim() })), restart: true };
    },
    /** 打补丁或还原。第一次改之前备份成 .bak-persona-memory。 */
    apply({ dir, revert = false }) {
      const r = runPatch({ bridgeDir: path.resolve(dir), apply: true, revert });
      if (!r.ok) throw Object.assign(new Error(r.error), { code: 'REJECTED' });
      log.info('bridge.patch', { revert, changed: r.changes.length });
      return { applied: r.applied, changed: r.changes.length, backup: !!r.backup, restart: r.applied };
    },
    /** 把目录记进配置（核心已经开着时要重启 DSH，QQ 入口才接上）。 */
    setDir(dir) {
      const d = dir ? path.resolve(dir) : '';
      if (d && !isBridgeDir(d)) throw Object.assign(new Error('这个目录不像 dsh-qq 桥接（找不到 plugins/qq-agent-presets/qq-tool-restrict.mjs）'), { code: 'REJECTED' });
      setConfig({ host: { adapters: { qq: { enabled: true, bridgeDir: d }, ...(d ? { web: { excludeCwdPrefixes: [path.join(d, 'state', 'agents')] } } : {}) } } }, { confirm: true });
      return { dir: d };
    },
  };
}
