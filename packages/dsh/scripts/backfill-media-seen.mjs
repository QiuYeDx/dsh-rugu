#!/usr/bin/env node
// 补录「她看过的媒体」（D116）：D116 之前她用工具看过的视频 / 图片，从会话日志里找出来，把她看到的写进那条消息的 media_json。
//   默认只预演：列出找到的（会话 id 前 8 位、时间、感知 id、种类、她的想法和回话各几个字、是不是已经有了），不打印任何聊天内容，什么都不写；
//   --plan <文件>：另把每一条的输入（那条消息的感知 id、种类、她看完之后的想法和回话）写进这个本机文件，给人或模型摘「她看到了什么」
//                  （里面有聊天内容：放在自己的目录里、用完删掉）；
//   --apply --summaries <文件>：按 {"<感知 id>": "她看到的一句"} 写进去（经核心的 intake.writeSeenMedia：清洗、截到 80 字、
//                  平台给的说明不改、只被更晚的一次替换、重建 FTS 和原文窗口）。写之前先停掉 DSH（主库只有一个写者），或者对副本跑。
// 认法（和线上的宿主、QQ 适配器的 resolveViewedMedia 同一个规矩，只是改成读日志）：工具结果带图片（type 'image'），或者是 --view-tools 里的工具；
//   看的是哪一条：调用参数里给了消息 id → 之前读到的、同一会话（参数里的 key / 群号 / 对方账号）里那个 id 的消息；
//   没给 id 的只认 --view-tools 里的工具：那之前 tools.seenFreshMs（10 分钟）以内读到的、带能「看」的媒体（不是小黄脸、表情、合并转发）
//   的别人的消息恰好一条才算（视频、语音、文件优先；两条以上分不清 → 跳过）；结果带图片、参数点的是别的东西（收藏表情、头像、
//   搜索候选、合并转发、网址）的不算。QQ 桥接的形状：唤醒快照、读消息工具的结果里 {messageId, time, text, isSelf} 的消息；
//   带媒体 = 桥接的媒体清单不空，或者文字里有桥接的「[视频]」这类占位。按（时间，文字）对上库里的感知，对不上或者对上不止一条就跳过（不猜）。
//   她看完之后的想法 = 之后最多两步 assistant/message 的 reasoning；回话 = 那几步里的文字和说话类工具（QQ 桥接的 speak 类）参数里的话。
// 用法：node packages/dsh/scripts/backfill-media-seen.mjs --sessions <DSH 会话目录> --data <记忆数据目录>
//        [--since 2026-11-01] [--view-tools a,b] [--plan <文件>] [--apply --summaries <文件>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { placeholderMedia } from '../src/adapters/qq/messages.js';
import { hasImageContent, isDeclaredViewer } from '../src/host/media.js';
import { uniqueViewed } from '../src/binding/index.js';
import { bareName } from '../src/host/tooltable.js';
import { QQ_TOOL_CLASSES } from '../src/adapters/qq/tools.js';
import { canonicalKey } from '../src/adapters/qq/files.js';

const FRESH_MS = 10 * 60_000;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const REPLY_KEYS = new Set(['messages', 'message', 'text', 'content', 'texts', 'lines']);

/** 会话日志（.jsonl 或多帧的 .jsonl.zstd）→ 事件。坏的帧、坏的行跳过。 */
export function readSessionLog(file) {
  const buf = fs.readFileSync(file);
  let text = '';
  if (file.endsWith('.zstd')) {
    const starts = [];
    for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i);
    for (let k = 0; k < starts.length; k++) {
      try { text += zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString('utf8'); } catch { /* 帧里碰巧出现的魔数 */ }
    }
  } else text = buf.toString('utf8');
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* 坏行 */ } }
  return out;
}

/** 文字里的 JSON（整段，或者唤醒消息末尾的快照那一行）。 */
function jsonsIn(text) {
  const out = [];
  const t = String(text ?? '');
  try { out.push(JSON.parse(t)); } catch { /* 不是整段 JSON */ }
  for (const line of t.split('\n')) { const s = line.trim(); if (s.startsWith('{') && s.length < 400_000) { try { out.push(JSON.parse(s)); } catch { /* 不是 */ } } }
  return out;
}
/** 带媒体的别人的消息（桥接的消息形状）：{time, text, kind, kinds, messageId, key}。key：外层结果里点明的会话（没有就 null）。 */
export function mediaMessagesIn(value, out = [], depth = 0, key = null) {
  if (depth > 6 || value == null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const v of value) mediaMessagesIn(v, out, depth + 1, key); return out; }
  const k = canonicalKey(value.key) ?? key;
  const t = Number(value.time);
  if (typeof value.text === 'string' && Number.isFinite(t) && value.isSelf !== true) {
    const listed = Array.isArray(value.media) ? value.media.map((m) => (typeof m?.kind === 'string' ? m.kind : null)).filter(Boolean) : [];
    const kinds = [...listed, ...placeholderMedia(value.plain ?? value.text).map((m) => m.kind)];
    if (!kinds.length && value.hasMedia === true) kinds.push('media');
    const viewable = kinds.filter((x) => x !== 'face');
    const mid = value.messageId ?? value.message_id;
    if (viewable.length) out.push({ time: t, text: value.text, kind: viewable[0], kinds, messageId: mid == null ? null : String(mid), key: k });
  }
  for (const v of Object.values(value)) if (v && typeof v === 'object') mediaMessagesIn(v, out, depth + 1, k);
  return out;
}
const contentOf = (ev) => (Array.isArray(ev?.data?.message?.content) ? ev.data.message.content : Array.isArray(ev?.data?.content) ? ev.data.content : []);
const textOf = (parts) => parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
/** 说话类工具（QQ 桥接的 speak 类）参数里的话（messages / text 这类字段的字符串）；别的工具的参数不算她说的话。 */
function replyStrings(args, out = [], depth = 0, under = false) {
  if (depth > 4 || args == null) return out;
  if (typeof args === 'string') { if (under && args.trim().length >= 2) out.push(args.trim()); return out; }
  if (Array.isArray(args)) { for (const v of args) replyStrings(v, out, depth + 1, under); return out; }
  if (typeof args === 'object') for (const [k, v] of Object.entries(args)) replyStrings(v, out, depth + 1, under || REPLY_KEYS.has(k));
  return out;
}
const sameMsg = (a, b) => a.time === b.time && a.text === b.text && (a.messageId ?? null) === (b.messageId ?? null);
const parseArgs = (a) => { if (a && typeof a === 'object') return a; try { const v = JSON.parse(String(a ?? '')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const speaks = (name) => QQ_TOOL_CLASSES[bareName(name)] === 'speak';
const idOf = (v) => ((typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_-]{1,64}$/.test(String(v)) ? String(v) : null);
/** 调用参数点明的会话（key / 群号 / 对方账号）。 */
function keyOfArgs(a) {
  const g = idOf(a.groupId ?? a.group_id ?? a.targetGroupId);
  const u = idOf(a.userId ?? a.user_id);
  return canonicalKey(a.key) ?? (g ? canonicalKey(`group:${g}`) : null) ?? (u ? canonicalKey(`private:${u}`) : null);
}
/**
 * 看的是哪一条（和 QQ 适配器的 resolveViewedMedia 同一个规矩）：给了消息 id 就是那一条（同一会话里读到过的）；
 * 没给 id 的只认声明过的工具，而且恰好一条才算。
 * @returns {{message: object|null, why: string}}
 */
export function pickMessage(seen, { args = {}, declared = false, at }) {
  const key = keyOfArgs(args);
  const mid = idOf(args.messageId ?? args.message_id ?? args.msgId);
  if (mid) {
    const hits = seen.filter((m) => m.messageId === mid && (!key || !m.key || m.key === key));
    return hits.length === 1 ? { message: hits[0], why: '' } : { message: null, why: hits.length ? '消息 id 对上不止一条' : '没读到那个 id 的消息' };
  }
  if (!declared) return { message: null, why: '没点明是哪条消息' };
  const cands = seen.filter((m) => m.time <= at && at - m.time <= FRESH_MS && (!key || !m.key || m.key === key));
  const byId = new Map(cands.map((m, i) => [`m${i}`, m]));
  const pick = uniqueViewed([...byId].map(([id, m]) => ({ obsId: id, settingId: 's', kinds: m.kinds ?? [m.kind] })), 's');
  return pick ? { message: byId.get(pick), why: '' } : { message: null, why: cands.length ? '分不清是哪一条' : '没看到带媒体的消息' };
}

/**
 * 一个会话日志里她看过媒体的几次。
 * @returns {{sessionId: string, at: number, message: {time: number, text: string, kind: string}|null, why: string, thoughts: string, reply: string}[]}
 */
export function viewsIn(events, { viewTools = [], since = 0 } = {}) {
  const sessionId = String(events.find((e) => e?.type === 'session' || e?.id)?.id ?? '');
  const seen = [];
  const calls = new Map();
  const views = [];
  let open = null;
  const close = () => { if (open) { views.push(open); open = null; } };
  for (const ev of events) {
    const type = ev?.type;
    const t = Number(ev?.time) || 0;
    if (type === 'tool/call') calls.set(ev.data?.callId, { name: ev.data?.name, args: parseArgs(ev.data?.arguments) });
    if (type === 'user/message' || type === 'tool/result') {
      for (const j of jsonsIn(textOf(contentOf(ev)))) for (const m of mediaMessagesIn(j)) if (!seen.some((x) => sameMsg(x, m))) seen.push(m);
    }
    if (type === 'tool/result') {
      const parts = contentOf(ev);
      const call = calls.get(ev.data?.message?.toolCallId ?? ev.data?.callId) ?? { name: '', args: {} };
      const declared = isDeclaredViewer(call.name, viewTools);
      if ((hasImageContent(parts) || declared) && t >= since) {
        close();
        const { message, why } = pickMessage(seen, { args: call.args, declared, at: t });
        open = { sessionId, at: t, message, why, thoughts: [], reply: [], steps: 0 };
      }
    }
    if (type === 'assistant/message' && open) {
      for (const p of contentOf(ev)) {
        if (p?.type === 'reasoning' && p.text?.trim()) open.thoughts.push(p.text.trim());
        else if (p?.type === 'text' && p.text?.trim()) open.reply.push(p.text.trim());
        else if (p?.type === 'tool-call' && speaks(p.name)) open.reply.push(...replyStrings(parseArgs(p.arguments)));
      }
      open.steps += 1;
      if (open.reply.length || open.steps >= 2) close();
    }
    if (type === 'turn/end') close();
  }
  close();
  return views.map((v) => ({ sessionId, at: v.at, message: v.message ? { time: v.message.time, text: v.message.text, kind: v.message.kind } : null, why: v.why,
    thoughts: v.thoughts.join('\n'), reply: v.reply.join('\n') }));
}

function sessionFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

function argOf(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv = process.argv.slice(2)) {
  const sessions = argOf(argv, '--sessions');
  const data = argOf(argv, '--data');
  if (!sessions || !data) { console.error('用法：--sessions <DSH 会话目录> --data <记忆数据目录> [--since 日期] [--view-tools a,b] [--plan 文件] [--apply --summaries 文件]'); return 2; }
  const since = argOf(argv, '--since') ? Date.parse(argOf(argv, '--since')) : 0;
  const viewTools = (argOf(argv, '--view-tools') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const apply = argv.includes('--apply');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(data, 'persona-memory.db'), { readOnly: true });
  const plan = [];
  const local = (t) => new Date(t + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
  for (const f of sessionFiles(sessions)) {
    let events;
    try { events = readSessionLog(f); } catch { continue; }
    for (const v of viewsIn(events, { viewTools, since })) {
      let row = null;
      let why = '';
      if (!v.message) why = v.why || '没看到带媒体的消息';
      else {
        const rows = db.prepare('SELECT id, text, media_json FROM percepts WHERE at = ? AND actor_self = 0').all(v.message.time).filter((r) => (r.text ?? '') === v.message.text || !r.text);
        if (rows.length === 1) [row] = rows; else why = rows.length ? '对上不止一条' : '库里没有';
      }
      const has = row?.media_json ? /"by":"self"/.test(row.media_json) : false;
      console.log(`${v.sessionId.slice(0, 16).padEnd(16)}  ${local(v.at)}  ${row ? `p${row.id} (${v.message.kind})` : `跳过：${why}`}  想法 ${[...v.thoughts].length} 字 / 回话 ${[...v.reply].length} 字${has ? '  [已经有她看到的]' : ''}`);
      if (row && (v.thoughts.trim() || v.reply.trim())) plan.push({ perceptId: row.id, kind: v.message.kind, at: v.at, thoughts: v.thoughts.slice(0, 1500), reply: v.reply.slice(0, 800), hasSeen: has });
    }
  }
  db.close();
  console.log(`找到 ${plan.length} 条可以补的。`);
  const planFile = argOf(argv, '--plan');
  if (planFile) { fs.writeFileSync(planFile, JSON.stringify(plan, null, 2)); console.log(`输入写进了 ${planFile}（里面有聊天内容，用完删掉）`); }
  if (!apply) { console.log('预演：什么都没写（要写：--apply --summaries <文件>）'); return 0; }
  const sf = argOf(argv, '--summaries');
  if (!sf) { console.error('--apply 要配 --summaries <文件>（{"<感知 id>": "她看到的一句"}）'); return 2; }
  const summaries = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const { createPersonaMemory } = await import('rugu-core');
  const pm = await createPersonaMemory({ dataDir: data, startWorker: false });
  try {
    if (pm.readOnly) { console.error('库是只读打开的（DSH 还在跑？主库只有一个写者）：先停掉 DSH，或者对副本跑'); return 1; }
    const core = pm._core;
    let n = 0;
    for (const p of plan) {
      const s = summaries[String(p.perceptId)];
      if (typeof s !== 'string' || !s.trim()) continue;
      const r = core.mods.intake.writeSeenMedia(core, { perceptId: p.perceptId, summary: s, kind: p.kind, at: p.at });
      console.log(`p${p.perceptId}: ${r.reason}`);
      if (r.ok) n += 1;
    }
    console.log(`写了 ${n} 条。`);
  } finally { await pm.close(); }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().then((c) => { process.exitCode = c; }, (e) => { console.error(e?.message ?? e); process.exitCode = 1; });
