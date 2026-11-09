// 适配器测试的替身：内存里的文件系统（带指纹和目录监视）、假定时器、假 sink、合成的桥接文件。
// 所有账号、群号都是运行时随机生成的（u / g 开头），仓库里不写任何真实 id。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rid = (p = 'u') => `${p}${crypto.randomBytes(5).toString('hex')}`;
export const salt = () => `test-salt-${crypto.randomBytes(12).toString('hex')}`;
/** 运行时随机的「像账号的数字」（测试 text 里账号原值会被换掉）。 */
export const randomDigits = () => String(100_000_000 + crypto.randomInt(0, 899_999_999));

/** 假定时器：advance(ms) 按时间顺序触发到期的回调。 */
export function fakeTimers(start = Date.UTC(2026, 10, 4, 8, 0, 0)) {
  let now = start;
  let seq = 0;
  /** @type {{id: number, at: number, fn: Function, every?: number, dead?: boolean}[]} */
  let q = [];
  const add = (fn, ms, every) => { const h = { id: ++seq, at: now + Math.max(0, ms), fn, every }; q.push(h); return h; };
  const clear = (h) => { if (h) h.dead = true; q = q.filter((x) => x !== h); };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms),
    clearTimeout: clear,
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearInterval: clear,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = q.filter((h) => !h.dead && h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every; else q = q.filter((x) => x !== due);
        due.fn();
      }
      now = end;
    },
    set: (t) => { now = t; },
    pending: () => q.filter((h) => !h.dead).length,
  };
}

/** 内存文件系统：readFile / stat / watch 三件套，写文件模拟桥接的「临时文件 + rename」。 */
export function fakeFs(timers) {
  const files = new Map();       // 路径 → {text, mtimeMs}
  const watchers = new Map();    // 目录 → Set<cb>
  const counts = { reads: new Map(), busy: new Set() };
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const fs = {
    readFile(p) {
      counts.reads.set(p, (counts.reads.get(p) ?? 0) + 1);
      if (counts.busy.has(p)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      const f = files.get(p);
      if (!f) throw enoent();
      return f.text;
    },
    stat(p) {
      const f = files.get(p);
      return f ? { size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs } : null;
    },
    watch(dir, cb) {
      if (!watchers.has(dir)) watchers.set(dir, new Set());
      watchers.get(dir).add(cb);
      const on = { close: [], error: [] };
      const h = { close() { watchers.get(dir)?.delete(cb); }, on(ev, fn) { on[ev]?.push(fn); return h; }, fail() { for (const fn of on.error) fn(new Error('EPERM')); } };
      handles.push({ dir, h });
      return h;
    },
  };
  const handles = [];
  let bump = 0;
  const emit = (p, name) => { for (const cb of [...(watchers.get(path.dirname(p)) ?? [])]) cb('rename', name); };
  return {
    ...fs,
    /** 桥接的写法：先写 <名>.<pid>.<hex>.tmp（目录里有事件），再 rename 覆盖目标（又一次事件）。 */
    write(p, text, { events = true } = {}) {
      const name = path.basename(p);
      if (events) emit(p, `${name}.4242.${crypto.randomBytes(6).toString('hex')}.tmp`);
      bump += 1;
      files.set(p, { text: typeof text === 'string' ? text : JSON.stringify(text, null, 2), mtimeMs: (timers?.now() ?? Date.now()) + bump / 1000 });
      if (events) emit(p, name);
    },
    remove(p) { files.delete(p); emit(p, path.basename(p)); },
    busy(p, on = true) { if (on) counts.busy.add(p); else counts.busy.delete(p); },
    reads: (p) => counts.reads.get(p) ?? 0,
    watcherCount: (dir) => watchers.get(dir)?.size ?? 0,
    /** 目录被删、句柄失效：现有的监视器报 error。 */
    killWatchers(dir) { for (const { dir: d, h } of handles.splice(0)) if (d === dir) h.fail(); },
    files,
  };
}

/** 假 sink：记下提交的批次；游标立即生效（真核心是在同一个事务里提交）。 */
export function fakeSink(initialCursors = new Map()) {
  const batches = [];
  const described = [];
  const cursors = new Map(initialCursors);
  return {
    observe(o, opt) { batches.push({ o, opt }); if (opt?.cursor) cursors.set(opt.cursor.key, opt.cursor.value); },
    describe(d) { described.push(d); },
    cursor: (k) => cursors.get(k) ?? null,
    batches, described, cursors,
    all: () => batches.flatMap((b) => b.o),
    clear() { batches.length = 0; described.length = 0; },
  };
}

/** 假日志：只记事件名和字段；assertNoText 断言里面没有内容和账号。 */
export function fakeLog() {
  const entries = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (event, fields) => entries.push({ level, event, fields });
  log.entries = entries;
  log.assertNoText = (...needles) => {
    const blob = JSON.stringify(entries);
    for (const n of needles) if (n && blob.includes(n)) throw new Error(`日志里出现了不该有的内容：${n.slice(0, 12)}`);
  };
  return log;
}

// ── 合成的桥接消息（字段形状照桥接的 appendSocialV2Message / appendSocialV2Poke / appendSocialV2Notice / recordSentMessagesV2）──
export function inMsg({ seq, messageId = rid('m'), userId, sender = '私聊', text, plain, tail, time, isOwner = false, quoteSelf = false, media = [], forwardIds = [] }) {
  const p = plain ?? text;
  return {
    seq, messageId, sender, userId, text: text.slice(0, 200), plain: p.slice(0, 200), tail: p.slice(-200),
    quoteTargetIsSelf: quoteSelf, isOwner, ownerLabel: isOwner ? `管理员（ownerQQ ${userId}）` : '', isSelf: false,
    media, hasMedia: media.length > 0, forwardIds, hasForward: forwardIds.length > 0, time,
  };
}
export function pokeMsg({ seq, userId, sender, targetId = null, targetIsSelf = false, time, suffix = '' }) {
  const text = `[拍一拍] ${sender} 拍了拍 ${targetIsSelf ? '你' : targetId}${suffix ? ` ${suffix}` : ''}`;
  return {
    seq, messageId: null, sender, userId, text, plain: text, tail: text, kind: 'poke', quoteTargetIsSelf: targetIsSelf,
    isOwner: false, ownerLabel: '', isSelf: false, media: [], hasMedia: false, forwardIds: [], hasForward: false,
    poke: { targetId, targetIsSelf, groupId: null }, time,
  };
}
export function noticeMsg({ seq, userId, name, time }) {
  const text = `[入群] ${name}（QQ ${userId}） 加入了本群：第一次见到的人`;
  return { seq, messageId: null, sender: '系统通知', userId, text, plain: text, tail: text, kind: 'notice', quoteTargetIsSelf: false, isOwner: false, ownerLabel: '', isSelf: false, media: [], hasMedia: false, forwardIds: [], hasForward: false, time };
}
export function selfMsg(text, time) {
  return { sender: '我', text: text.slice(0, 200), plain: text.slice(0, 200), quoteTargetIsSelf: false, isOwner: true, ownerLabel: '我', isSelf: true, time };
}
/**
 * qq_owner_peek_group 的结果，照桥接的真实形状：social/group-rules.js 的 peekView（time 是 ISO 字符串、她自己是「（我）」，
 * 没有序号、消息 id、isSelf）再过一遍 qq-model-view.js 的 serializeModelData（空的 userId、false 的 hasMedia 去掉）。
 */
export function peekResult(targetKey, msgs, { memoryText = '桥接自己的群记忆摘要' } = {}) {
  const messages = msgs.map((m) => {
    const v = { time: m?.time ? new Date(m.time).toISOString() : null, sender: m?.isSelf ? '（我）' : String(m?.sender ?? m?.userId ?? ''),
      userId: m?.userId != null ? String(m.userId) : null, text: String(m?.plain ?? m?.text ?? ''), hasMedia: !!m?.hasMedia };
    if (v.userId == null || v.userId === '') delete v.userId;
    if (!v.hasMedia) delete v.hasMedia;
    if (!v.text) delete v.text;
    if (!v.sender) delete v.sender;
    return v;
  });
  return JSON.stringify({ ok: true, targetKey, messages, memory: memoryText, rules: [], note: '只读视图：你不能直接在这个群发言' });
}
/** 一份 social-v2.json：每个会话都带 agentToken 和桥接自己的记忆（适配器必须丢掉）。 */
export function socialFile(conversations, { paused = false } = {}) {
  const out = { paused, conversations: {} };
  for (const [key, c] of Object.entries(conversations)) {
    const recent = c.recent ?? [];
    out.conversations[key] = {
      wakeConfig: { mode: 'diving' },
      recentMessages: recent,
      unread: c.unread ?? [],
      lastWakeReason: '', lastAiReplyAt: 0, lastActionAt: 0,
      agentToken: crypto.randomBytes(16).toString('hex'),
      bootstrapSent: true, wakeTimes: [], sendTimes: [], stickerCollectTimes: [],
      lastIncomingAt: c.lastIncomingAt ?? 0,
      lastUnreadSeq: c.lastUnreadSeq ?? Math.max(0, ...recent.map((m) => m.seq ?? 0)),
      lastReadThroughSeq: c.lastReadThroughSeq ?? 0,
      activeTopics: [{ text: '桥接自己的话题' }], pendingThoughts: [{ text: '桥接自己的想法' }],
      memberImpressions: { 某人: '桥接自己的印象' },
      ownerRules: c.ownerRules ?? [],
      seenForwardIds: [],
    };
  }
  return out;
}

// ── 真文件系统（临时目录一律在仓库的 .tmp/ 下：C 盘快满了）──
export const TMP_ROOT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'), '.tmp');
/** 新建一个空的临时目录。 */
export function mkTmp(name) {
  const dir = path.join(TMP_ROOT, `adapters-${name}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
/** 只删 .tmp 下的目录。 */
export function rmTmp(dir) {
  if (!dir || !path.resolve(dir).startsWith(TMP_ROOT + path.sep)) throw new Error(`只删 .tmp 下的目录：${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
/** 桥接的写法：唯一名临时文件 + rename 覆盖。 */
export function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}
/** 等到条件成立（真定时器）。 */
export async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return pred();
}
