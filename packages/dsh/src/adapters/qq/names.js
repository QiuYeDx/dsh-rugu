// 平台上的群名（D111）。桥接把消息事件里的群名丢掉了（落盘文件里没有），所以从 SnowLuma 自己的缓存库里被动地读：
// 不调 QQ、不调 OneBot、不碰任何令牌；只读打开、读完就关；读不出来就当没有（她照样用「一个 QQ 群」，管理页照样能改名）。
//   位置：<SnowLuma 目录>/data/<每个子目录>/snowluma_identity.db。目录默认来自桥接 config.json 的 snowluma.homeDir；
//         主人可以在插件的私有配置 host.adapters.qq.platformNames 里改（{dir}）或关掉（false）。子目录名带着账号，所以路径从不进日志、状态和页面。
//   表结构：SnowLuma 没有公开（v2.2.1 只读核对过）——groups(group_id, group_name, remark, member_count, updated_at)。
//         读之前按 PRAGMA table_info 核对这几列，对不上就当没有（status().reason = 'schema'）。
//   刷新：SnowLuma 拉群列表时整张表重写（群改了名，下一次同步就是新的）。这里只看库文件和 -wal 的大小、修改时间：变了才重读，
//         最快 minIntervalMs 一次；适配器下一次描述这个会话时就带上新名字，核心按「描述变了」存新快照，旧名字留作别名。
// remark 是机器人账号自己给群的备注，比群名更接近「她怎么叫这个群」，有就排在群名前面。
// 规矩：只用 node 内置模块；名字、路径、账号都不进日志（只记事件名和数字）。
import fs from 'node:fs';
import path from 'node:path';

const DB_NAME = 'snowluma_identity.db';
const NEEDED = ['group_id', 'group_name', 'remark', 'member_count'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 名字里去掉控制字符、折叠空白；太长的截到 60 字。 */
function cleanName(v) {
  if (typeof v !== 'string') return '';
  // 控制字符、零宽字符、方向控制符换成空格（按码位判断，不写进正则：源码里不放这些字符）
  const bad = (c) => c < 0x20 || c === 0x7f || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
  const kept = [...v].map((ch) => (bad(ch.codePointAt(0)) ? ' ' : ch)).join('');
  return [...kept.split(' ').filter(Boolean).join(' ').trim()].slice(0, 60).join('');
}

/** 默认的只读打开（node:sqlite 是内置模块；按需取，测试和不需要它的地方不加载）。 */
function defaultOpen(file) {
  const sqlite = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqlite?.DatabaseSync) throw Object.assign(new Error('node:sqlite 不可用'), { code: 'NO_SQLITE' });
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

/**
 * @param {object} o
 * @param {() => string|null} o.dir                  SnowLuma 目录（每次查都重新问：配置会热加载）；null / 空 = 不读
 * @param {() => number} o.now
 * @param {(file: string) => any} [o.openDb]         只读打开一个 SQLite 文件（测试可换）
 * @param {(dir: string) => string[]} [o.listDirs]   列子目录（测试可换）
 * @param {(file: string) => {size: number, mtimeMs: number}|null} [o.stat]
 * @param {number} [o.minIntervalMs]
 * @param {{warn?: Function, info?: Function}} [o.log]
 */
export function createPlatformNames(o) {
  const openDb = o.openDb ?? defaultOpen;
  const listDirs = o.listDirs ?? ((d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  const stat = o.stat ?? ((f) => { try { const s = fs.statSync(f); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } });
  const minInterval = Number.isFinite(o.minIntervalMs) && o.minIntervalMs >= 0 ? o.minIntervalMs : 30_000;
  /** @type {Map<string, {name: string, remark: string, memberCount: number|null, at: number}>} */
  let groups = new Map();
  let checkedAt = -Infinity;
  let stampKey = null;
  let lastDir = null;
  let state = { ok: false, reason: 'not-read', files: 0 };
  const stats = { reads: 0, errors: 0 };

  function files(dir) {
    const out = [];
    let subs = [];
    try { subs = listDirs(path.join(dir, 'data')); } catch { return out; }
    for (const s of subs.slice(0, 16)) {
      const f = path.join(dir, 'data', s, DB_NAME);
      if (stat(f)) out.push(f);
    }
    return out;
  }
  function stampOf(list) {
    return list.map((f) => [f, `${f}-wal`].map((x) => { const s = stat(x); return s ? `${s.size}:${s.mtimeMs}` : '-'; }).join('/')).join('|');
  }
  function readAll(list) {
    const next = new Map();
    let ok = 0;
    let reason = list.length ? 'schema' : 'no-db';
    for (const f of list) {
      let db = null;
      try {
        db = openDb(f);
        const cols = new Set(db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name));
        if (!NEEDED.every((c) => cols.has(c))) continue;
        const hasAt = cols.has('updated_at');
        const rows = db.prepare(`SELECT group_id, group_name, remark, member_count${hasAt ? ', updated_at' : ''} FROM groups LIMIT 5000`).all();
        ok += 1;
        for (const r of rows) {
          const id = String(r.group_id ?? '');
          if (!ID_RE.test(id)) continue;
          const at = Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0;
          const prev = next.get(id);
          if (prev && prev.at > at) continue;
          const n = Number(r.member_count);
          next.set(id, { name: cleanName(r.group_name), remark: cleanName(r.remark), memberCount: Number.isSafeInteger(n) && n > 0 ? n : null, at });
        }
      } catch (e) {
        stats.errors += 1;
        reason = 'unreadable';
        try { o.log?.warn?.('qq.names.read', { code: String(e?.code ?? e?.name ?? 'Error').slice(0, 40) }); } catch { /* 忽略 */ }
      } finally {
        try { db?.close(); } catch { /* 已关 */ }
      }
    }
    stats.reads += 1;
    return { next, ok, reason };
  }
  function refresh() {
    const t = o.now();
    let dir = null;
    try { dir = o.dir(); } catch { dir = null; }
    if (!dir) { groups = new Map(); stampKey = null; lastDir = null; state = { ok: false, reason: 'off', files: 0 }; return; }
    if (dir === lastDir && t - checkedAt < minInterval) return;
    checkedAt = t;
    const list = files(dir);
    const stamp = `${dir}#${stampOf(list)}`;
    if (stamp === stampKey) return;
    const r = readAll(list);
    lastDir = dir;
    // 读坏了（被占用、表结构不认识）不把已经知道的名字清掉：等文件下一次变化再读
    if (r.ok > 0 || !list.length) { groups = r.next; stampKey = stamp; }
    state = { ok: r.ok > 0, reason: r.ok > 0 ? null : r.reason, files: list.length };
  }

  return {
    /**
     * 一个群在平台上的名字：有备注用备注，没有用群名；都没有返回 null。
     * @param {string} groupId
     * @returns {{name: string, source: 'remark'|'name', memberCount: number|null}|null}
     */
    group(groupId) {
      try { refresh(); } catch { return null; }
      const g = groups.get(String(groupId));
      if (!g) return null;
      if (g.remark) return { name: g.remark, source: 'remark', memberCount: g.memberCount };
      if (g.name) return { name: g.name, source: 'name', memberCount: g.memberCount };
      return g.memberCount ? { name: '', source: 'name', memberCount: g.memberCount } : null;
    },
    /** 只有状态和数字（自检、管理页用）：读没读到、读到几个群。不带路径、名字。 */
    status() {
      try { refresh(); } catch { /* 下面照报 */ }
      return { ...state, groups: groups.size, ...stats };
    },
  };
}
