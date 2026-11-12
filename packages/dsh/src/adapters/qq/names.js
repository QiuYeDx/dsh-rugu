// 平台上的群名（D111）和群成员名单（D160）。桥接把消息事件里的群名丢掉了（落盘文件里没有），所以从 SnowLuma 自己的缓存库里被动地读：
// 不调 QQ、不调 OneBot、不碰任何令牌；只读打开、读完就关；读不出来就当没有（她照样用「一个 QQ 群」，管理页照样能改名）。
//   位置：<SnowLuma 目录>/data/<每个子目录>/snowluma_identity.db。目录默认来自桥接 config.json 的 snowluma.homeDir；
//         主人可以在插件的私有配置 host.adapters.qq.platformNames 里改（{dir}）或关掉（false）。子目录名带着账号，所以路径从不进日志、状态和页面。
//   表结构：SnowLuma 没有公开（v2.2.1 只读核对过）——groups(group_id, group_name, remark, member_count, updated_at)。
//         读之前按 PRAGMA table_info 核对这几列，对不上就当没有（status().reason = 'schema'）。
//   刷新：SnowLuma 拉群列表时整张表重写（群改了名，下一次同步就是新的）。这里只看库文件和 -wal 的大小、修改时间：变了才重读，
//         最快 minIntervalMs 一次；适配器下一次描述这个会话时就带上新名字，核心按「描述变了」存新快照，旧名字留作别名。
// remark 是机器人账号自己给群的备注，比群名更接近「她怎么叫这个群」，有就排在群名前面。
// 【D160】群成员名单：同一个库里的 group_members。桥接把「@某人」只存成渲染后的文字「@<群名片或昵称>」（结构化的目标丢了），
//   适配器要靠名单才认得出「@」点的是谁——包括从没在这里说过话的人，和她自己（她的那几行桥接一律写成「我」，她的平台名字只有名单里有）。
//   表结构同样没公开，主人那边只核对过列名：group_members(id, group_id, uid, uin, nickname, card, role, level, title, join_time,
//   last_sent_time, shut_up_time, is_robot, active, updated_at)，group_id、uin、updated_at 是整数；她自己在她所在的每个群里都有一行
//   （她的 card 是空的，平台上显示的、桥接 @ 时渲染的是她的 nickname）。读之前核对 group_id、uin、nickname、card 四列（updated_at 可选），
//   对不上就当没有名单（status().membersReason = 'schema'），群名照读。名字 = card || nickname（清洗、截短，和群名一样）。
//   读法和群名一样：只读、文件变了才重读、读坏了留着已经知道的、有行数上限（一共 10 万行、每个群 5000 人）；
//   只是最快 memberIntervalMs（默认 5 分钟）重读一次——成员行随每条消息更新（last_sent_time），库文件几乎一直在变。
//   账号只在内存里（members() 交给适配器反查「@名字」用）：不进日志、状态和页面，状态里只有数字。
// 【D162】她自己的账号：主人的私有配置里多半没写 selfAccount（首次设置不问它），D160 却靠它认出名单里哪一行是她。
//   SnowLuma 的缓存按登录的账号分目录：<目录>/data/<登录的账号>/。一个子目录算她的账号，要同时满足——目录名像个账号（纯数字），
//   而且这个账号在这个库自己的 group_members 里每一个群都有（至少一个群）。只看「在每个群里」不够：主人往往也在她的每个群里；
//   只看目录名也不够：目录可能是别的东西。几个子目录都满足 → 说不清，当不知道（主人得自己配 selfAccount）。
//   和名单一起读、一起留：读坏了留着已经知道的；账号同样只在内存里，状态里只有 selfKnown（知不知道）。
// 规矩：只用 node 内置模块；名字、路径、账号都不进日志（只记事件名和数字）。
import fs from 'node:fs';
import path from 'node:path';

const DB_NAME = 'snowluma_identity.db';
const NEEDED = ['group_id', 'group_name', 'remark', 'member_count'];
const MEMBER_NEEDED = ['group_id', 'uin', 'nickname', 'card'];
const MEMBER_ROWS_MAX = 100_000;
const MEMBERS_PER_GROUP_MAX = 5000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 像个 QQ 号：纯数字、5 到 12 位、不以 0 开头。 */
const ACCOUNT_RE = /^[1-9]\d{4,11}$/;

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
 * @param {number} [o.memberIntervalMs]              【D160】名单最快多久重读一次（默认 5 分钟）：SnowLuma 每来一条消息都会更新成员行
 *                                                   （last_sent_time），库文件几乎一直在变；群名片很少变，不必跟着整张名单重读
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
  const memberInterval = Number.isFinite(o.memberIntervalMs) && o.memberIntervalMs >= 0 ? o.memberIntervalMs : 300_000;
  /** 群号 → (账号 → 名字)。只在内存里。 @type {Map<string, Map<string, string>>} */
  let members = new Map();
  let memberCount = 0;
  let membersReadAt = -Infinity;
  /** 【D162】登录的账号（她自己的），认不出是 null。只在内存里。 @type {string|null} */
  let selfAcct = null;
  let state = { ok: false, reason: 'not-read', files: 0, membersOk: false, membersReason: 'not-read' };
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
  const warn = (event, e) => {
    stats.errors += 1;
    try { o.log?.warn?.(event, { code: String(e?.code ?? e?.name ?? 'Error').slice(0, 40) }); } catch { /* 忽略 */ }
  };
  const atOf = (r) => (Number.isFinite(Number(r.updated_at)) ? Number(r.updated_at) : 0);
  /** 一个库里的 groups → next。返回 true = 表结构认得、读到了。 */
  function readGroups(db, next) {
    const cols = new Set(db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name));
    if (!NEEDED.every((c) => cols.has(c))) return false;
    const hasAt = cols.has('updated_at');
    const rows = db.prepare(`SELECT group_id, group_name, remark, member_count${hasAt ? ', updated_at' : ''} FROM groups LIMIT 5000`).all();
    for (const r of rows) {
      const id = String(r.group_id ?? '');
      if (!ID_RE.test(id)) continue;
      const at = atOf(r);
      const prev = next.get(id);
      if (prev && prev.at > at) continue;
      const n = Number(r.member_count);
      next.set(id, { name: cleanName(r.group_name), remark: cleanName(r.remark), memberCount: Number.isSafeInteger(n) && n > 0 ? n : null, at });
    }
    return true;
  }
  /**
   * 【D160】一个库里的 group_members → next（群号 → 账号 → 名字）。同一个人在几个库里都有时认 updated_at 新的。
   * 【D162】owner 是这个库所在子目录的名字（像个账号时才给）：返回它是不是在这个库的每一个群里都有一行（至少一个群）。
   * @returns {false|{mine: boolean}}   false = 表结构不认识
   */
  function readMembers(db, next, owner) {
    const cols = new Set(db.prepare('PRAGMA table_info(group_members)').all().map((c) => c.name));
    if (!MEMBER_NEEDED.every((c) => cols.has(c))) return false;
    const hasAt = cols.has('updated_at');
    const rows = db.prepare(`SELECT group_id, uin, nickname, card${hasAt ? ', updated_at' : ''} FROM group_members LIMIT ${MEMBER_ROWS_MAX}`).all();
    const seen = new Set();
    const ownerIn = new Set();
    for (const r of rows) {
      const g = String(r.group_id ?? '');
      const u = String(r.uin ?? '');
      if (!ID_RE.test(g) || !ID_RE.test(u)) continue;
      seen.add(g);
      if (owner && u === owner) ownerIn.add(g);
      const name = cleanName(r.card) || cleanName(r.nickname);
      if (!name) continue;
      let m = next.get(g);
      if (!m) { m = new Map(); next.set(g, m); }
      const at = atOf(r);
      const prev = m.get(u);
      if (prev ? prev.at > at : m.size >= MEMBERS_PER_GROUP_MAX) continue;
      m.set(u, { name, at });
    }
    return { mine: !!owner && seen.size > 0 && ownerIn.size === seen.size };
  }
  function readAll(list, withMembers) {
    const next = new Map();
    const nextMembers = new Map();
    let ok = 0;
    let membersOk = 0;
    let reason = list.length ? 'schema' : 'no-db';
    let membersReason = list.length ? 'schema' : 'no-db';
    /** 【D162】哪些子目录的名字是登录的账号（见文件头） */
    const owners = [];
    for (const f of list) {
      let db = null;
      try {
        db = openDb(f);
      } catch (e) {
        warn('qq.names.read', e);
        reason = 'unreadable';
        membersReason = 'unreadable';
        continue;
      }
      try {
        if (readGroups(db, next)) ok += 1;
      } catch (e) { warn('qq.names.read', e); reason = 'unreadable'; }
      // 名单读不出来不影响群名（反过来也一样）
      if (withMembers) {
        try {
          const sub = path.basename(path.dirname(f));
          const r = readMembers(db, nextMembers, ACCOUNT_RE.test(sub) ? sub : null);
          if (r) { membersOk += 1; if (r.mine) owners.push(path.basename(path.dirname(f))); }
        } catch (e) { warn('qq.names.members', e); membersReason = 'unreadable'; }
      }
      try { db.close(); } catch { /* 已关 */ }
    }
    stats.reads += 1;
    // 正好一个子目录满足才算；几个都满足就说不清
    const self = owners.length === 1 ? owners[0] : null;
    return { next, ok, reason, nextMembers, membersOk, membersReason, self };
  }
  function refresh() {
    const t = o.now();
    let dir = null;
    try { dir = o.dir(); } catch { dir = null; }
    if (!dir) {
      groups = new Map(); members = new Map(); memberCount = 0; stampKey = null; lastDir = null; selfAcct = null;
      state = { ok: false, reason: 'off', files: 0, membersOk: false, membersReason: 'off' };
      return;
    }
    if (dir === lastDir && t - checkedAt < minInterval) return;
    checkedAt = t;
    const list = files(dir);
    const stamp = `${dir}#${stampOf(list)}`;
    if (stamp === stampKey) return;
    const withMembers = dir !== lastDir || t - membersReadAt >= memberInterval;
    const r = readAll(list, withMembers);
    lastDir = dir;
    // 读坏了（被占用、表结构不认识）不把已经知道的名字清掉；被占用的过 minIntervalMs 再试，其余等文件下一次变化再读
    if (r.ok > 0 || !list.length) groups = r.next;
    let ms = { membersOk: state.membersOk, membersReason: state.membersReason };
    if (withMembers) {
      if (r.membersOk > 0 || !list.length) {
        members = new Map([...r.nextMembers].map(([g, m]) => [g, new Map([...m].map(([u, x]) => [u, x.name]))]));
        memberCount = [...members.values()].reduce((s, m) => s + m.size, 0);
      }
      // 【D162】她的账号：每个库都读到了才重新认（有一个读坏了，可能正是另一个也满足的子目录：留着已经知道的）
      if (r.membersReason !== 'unreadable') selfAcct = r.self;
      if (r.membersReason !== 'unreadable') membersReadAt = t;
      ms = { membersOk: r.membersOk > 0, membersReason: r.membersOk > 0 ? null : r.membersReason };
    }
    // 名单这次没到重读的时候：文件的这次变化照样算看过了（下一次变化时再看到没到时候）
    if (r.reason !== 'unreadable' && (!withMembers || r.membersReason !== 'unreadable')) stampKey = stamp;
    state = { ok: r.ok > 0, reason: r.ok > 0 ? null : r.reason, files: list.length, ...ms };
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
    /**
     * 【D160】一个群的成员名单：账号 → 平台上显示的名字（群名片，没有就昵称）。没有名单（没配置、表结构不认识、没读到这个群）返回空的。
     * 账号只给适配器在内存里反查「@名字」用，不往外交。返回的是一份拷贝。
     * @param {string} groupId
     * @returns {Map<string, string>}
     */
    members(groupId) {
      try { refresh(); } catch { return new Map(); }
      const m = members.get(String(groupId));
      return m ? new Map(m) : new Map();
    },
    /**
     * 【D162】缓存里登录的账号（她自己的）：子目录名像个账号、又在这个库的每一个群里都有，而且只有一个子目录这样（见文件头）。
     * 认不出、说不清、没有名单返回 null。只给适配器在内存里用，不往外交。
     * @returns {string|null}
     */
    selfAccount() {
      try { refresh(); } catch { return selfAcct; }
      return selfAcct;
    },
    /** 只有状态和数字（自检、管理页用）：读没读到、读到几个群、名单里一共几个人、认没认出她的账号。不带路径、名字、账号。 */
    status() {
      try { refresh(); } catch { /* 下面照报 */ }
      return { ...state, groups: groups.size, members: memberCount, selfKnown: !!selfAcct, ...stats };
    },
  };
}
