// 原文窗口（§5.1、§7.1 第 8 步、§8.2 稠密路的原文层）：同一场合连续 5–8 条原话拼成一块（≤ 400 字，带说话人和绝对时间），
// 入库就送嵌入队列的「文档」档（priority 1），不依赖 LLM，后台提炼暂停时也照常切（评审:UV-08）。
//   - 按（场合，visible_to）分开切：她心里想的、私下读到的不和当众的话混在一起（窗口的规范取成员里最严的，D10）；
//   - 什么时候切：凑满 maxMsgs 条、再加一条就超字数、或者中间隔了一段对话间隔（segment.gapMin）→ 立刻切；
//     凑够 minMsgs 条而且最早那条已经过了 idleMs → 切；最后一条之后空闲 idleMs → 有几条切几条；
//   - 相邻窗口重叠 overlap 条（只在同一段对话里重叠，隔了很久的不硬接上）；
//   - 切好的窗口：worker.enqueueEmbed(window) + dynamics.addTrace(window, 编码强度取成员里最大的 w_enc，时间取最后一条)
//     + admin.inheritSuppression(window)：成员里有主人隐藏过的消息，窗口一切出来就跟着对别人隐藏（§12.7，不等 tick 的兜底扫描）。
// 成员以 raw_windows.members_json 为准。全部在调用方的事务里做（同步）。
import { refOf } from '../store/refs.js';
import { bumpMetric } from '../store/kv.js';
import { displayNameOf } from './hash.js';
import { DEFAULTS } from '../config/defaults.js';
import { withSeen, hasPlaceholder, SEEN_BY } from './media.js';

/** 会进原文窗口的感知种类（「原话」：说的、做的、看到的内容、她心里想的、改过的消息）。迁移里的 percepts_unwindowed 索引用同一份。 */
export const WINDOW_KINDS = Object.freeze(['utterance', 'action', 'content', 'self-utterance', 'self-action', 'self-thought', 'on-my-behalf', 'edit']);
const KIND_SQL = WINDOW_KINDS.map((k) => `'${k}'`).join(',');
const ROW_COLS = 'id, setting_key, visible_to, at, actor_entity_id, actor_self, actor_json, kind, text, text_state, media_json, w_enc';
const MIN_MS = 60_000;

const charLen = (s) => [...s].length;
const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时间（config.time.tzOffsetMin；null = 本机时区）。 */
function localParts(core, t) {
  const tz = core.config.get().time?.tzOffsetMin;
  const off = typeof tz === 'number' && Number.isFinite(tz) ? tz : -new Date(t).getTimezoneOffset();
  const d = new Date(t + off * MIN_MS);
  return { day: `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`, time: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` };
}

/** 说话人怎么写：她自己写「我」；有管理权限的人用她对主人的称呼（selfProfile.principalLabel，只用于渲染）；其余用本场合的名片。 */
function speakerLabel(core, row, cache) {
  if (row.actor_self) return '我';
  const key = row.actor_entity_id ?? `raw:${row.id}`;
  if (cache.has(key)) return cache.get(key);
  let actor = null;
  try { actor = JSON.parse(row.actor_json); } catch { actor = null; }
  let name = displayNameOf(actor, row.setting_key);
  if (row.actor_entity_id != null) {
    try {
      const bond = core.mods.entities.bondOf(core, row.actor_entity_id);
      if (bond?.authority === 'principal') {
        const label = core.ports.selfProfile?.principalLabel?.();
        if (typeof label === 'string' && label.trim()) name = label.trim();
      }
    } catch { /* 认不出关系就用名片 */ }
    if (!name) {
      try { name = core.mods.entities.profile(core, row.actor_entity_id)?.displayName ?? null; } catch { name = null; }
    }
  }
  const label = (name ?? '').replace(/\s+/g, ' ').trim() || '有人';
  cache.set(key, label);
  return label;
}

function bodyOf(row) {
  if (row.text_state === 'retracted') return '（撤回了一条消息）';
  let s = String(row.text ?? '').replace(/\s+/g, ' ').trim();
  let media = [];
  try { media = row.media_json ? JSON.parse(row.media_json) : []; } catch { media = []; }
  // 她看到的（D116，by:'self'）写进文字里的占位（「［视频，我看到的：…］」）；文字里已经有占位时，没有说明的媒体项不再另写一遍种类
  const placeholder = hasPlaceholder(s);
  s = withSeen(s, media, { who: '我' });
  for (const m of media) {
    if (!m?.kind || m.by === SEEN_BY) continue;
    if (!m.summary && placeholder) continue;
    s += `${s ? ' ' : ''}［${m.kind}${m.summary ? `：${String(m.summary).replace(/\s+/g, ' ').trim()}` : ''}］`;
  }
  return s;
}

/**
 * 渲染一个窗口的文字。只有一条而且超字数时截断那一条。
 * @returns {string}
 */
export function renderWindow(core, rows, maxChars, cache = new Map()) {
  const lines = [];
  let prevDay = null;
  for (const r of rows) {
    const p = localParts(core, r.at);
    const stamp = p.day === prevDay ? p.time : `${p.day} ${p.time}`;
    prevDay = p.day;
    let who = speakerLabel(core, r, cache);
    if (r.kind === 'self-thought') who += '（心里想）';
    else if (r.kind === 'edit') who += '（改了一条消息）';
    lines.push({ head: `[${stamp}] ${who}：`, body: bodyOf(r) });
  }
  let text = lines.map((l) => l.head + l.body).join('\n');
  if (charLen(text) > maxChars && lines.length === 1) {
    const room = Math.max(1, maxChars - charLen(lines[0].head) - 1);
    text = `${lines[0].head}${[...lines[0].body].slice(0, room).join('')}…`;
  }
  return text;
}

function loadRows(db, ids) {
  if (!ids.length) return [];
  const rows = db.all(`SELECT ${ROW_COLS} FROM percepts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`, JSON.stringify(ids));
  return rows;
}

function insertWindow(core, settingKey, visibleTo, members, text) {
  const db = core.store;
  const ids = members.map((r) => r.id);
  const tStart = Math.min(...members.map((r) => r.at));
  const tEnd = Math.max(...members.map((r) => r.at));
  const res = db.run(`INSERT INTO raw_windows(setting_key, visible_to, first_percept, last_percept, n_percepts, t_start, t_end, text, members_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, settingKey, visibleTo, ids[0], ids.at(-1), ids.length, tStart, tEnd, text, JSON.stringify(ids), core.now());
  const wid = Number(res.lastInsertRowid);
  db.run('UPDATE percepts SET window_id = ? WHERE id IN (SELECT value FROM json_each(?))', wid, JSON.stringify(ids));
  const ref = { kind: 'window', id: wid };
  core.mods.worker.enqueueEmbed(core, ref, [{ chunkNo: 0, kind: 'text', text }], { layer: 'raw', priority: 1 });
  const w = Math.max(...members.map((r) => Number(r.w_enc) || 0));
  core.mods.dynamics.addTrace(core, ref, { t: tEnd, w, sourceKey: refOf('window', wid), reason: 'encode' });
  // 出错不挡切窗口：tick 的兜底扫描照样会补上
  try { core.mods.admin.inheritSuppression(core, refOf('window', wid), { at: core.now() }); } catch (e) {
    try { bumpMetric(core.store, 'intake.inheritSuppression.error', 1, core.now()); } catch { /* 计数失败不影响 */ }
    core.log.warn('intake.inheritSuppression.failed', { error: e?.code ?? e?.name ?? 'Error' });
  }
  return wid;
}

/**
 * 给一组（场合，visible_to）切窗口。在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} settingKey
 * @param {string} visibleTo
 * @param {{at: number, force?: boolean}} opt  force：有几条切几条（夜间封口、测试）
 * @returns {number} 切了几个
 */
export function cutGroup(core, settingKey, visibleTo, { at, force = false }) {
  const cfg = core.config.get();
  const rw = cfg.intake.rawWindow;
  const gapMs = (cfg.segment?.gapMin ?? DEFAULTS.segment.gapMin) * MIN_MS;
  const db = core.store;
  const pending = db.all(`SELECT ${ROW_COLS} FROM percepts WHERE setting_key = ? AND visible_to = ? AND window_id IS NULL AND kind IN (${KIND_SQL})
    ORDER BY id`, settingKey, visibleTo);
  if (!pending.length) return 0;
  const prev = db.get('SELECT id, members_json FROM raw_windows WHERE setting_key = ? AND visible_to = ? ORDER BY last_percept DESC LIMIT 1', settingKey, visibleTo);
  let tail = [];
  if (prev && rw.overlap > 0) {
    let ids = [];
    try { ids = JSON.parse(prev.members_json); } catch { ids = []; }
    tail = loadRows(db, ids.slice(-rw.overlap)).filter((r) => r.text != null || r.text_state === 'retracted');
  }
  const cache = new Map();
  const render = (rows) => renderWindow(core, rows, rw.maxChars, cache);
  let i = 0;
  let cut = 0;
  while (i < pending.length) {
    if (tail.length && pending[i].at - tail.at(-1).at > gapMs) tail = [];
    const members = [...tail];
    let j = i;
    let boundary = false;
    while (j < pending.length) {
      const r = pending[j];
      if (members.length >= rw.maxMsgs) { boundary = true; break; }
      if (j > i && r.at - pending[j - 1].at > gapMs) { boundary = true; break; }
      if (charLen(render([...members, r])) > rw.maxChars) {
        if (j > i) { boundary = true; break; }
        // 第一条新消息就放不下：先丢掉重叠的，还放不下就让这一条单独成窗（渲染时截断）
        while (members.length && charLen(render([...members, r])) > rw.maxChars) members.shift();
        members.push(r);
        j += 1;
        boundary = true;
        break;
      }
      members.push(r);
      j += 1;
    }
    if (j === i) break;
    if (members.length >= rw.maxMsgs) boundary = true;   // 凑满了就切，不等下一条
    const firstNew = pending[i];
    const lastNew = pending[j - 1];
    const idle = at - lastNew.at >= rw.idleMs;
    const stale = members.length >= rw.minMsgs && at - firstNew.at >= rw.idleMs;
    if (!(boundary || force || idle || stale)) break;   // 等更多消息
    insertWindow(core, settingKey, visibleTo, members, render(members));
    cut += 1;
    tail = rw.overlap > 0 ? members.slice(-rw.overlap) : [];
    i = j;
  }
  return cut;
}

/**
 * 还没切进窗口的分组（启动后、定时器到点时都从库里重建，不在内存里另存「待切列表」）。
 * @returns {{setting_key: string, visible_to: string, n: number, first_at: number, last_at: number}[]}
 */
export function pendingGroups(core) {
  return core.store.all(`SELECT setting_key, visible_to, COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at FROM percepts
    WHERE window_id IS NULL AND kind IN (${KIND_SQL}) GROUP BY setting_key, visible_to`);
}

/** 下一次该看的时间（还在等的分组里最早到点的）。没有在等的返回 null。 */
export function nextDue(core, groups) {
  const rw = core.config.get().intake.rawWindow;
  let due = null;
  for (const g of groups) {
    let t = g.last_at + rw.idleMs;
    if (g.n + rw.overlap >= rw.minMsgs) t = Math.min(t, g.first_at + rw.idleMs);
    due = due == null ? t : Math.min(due, t);
  }
  return due;
}

/**
 * 包含这些感知的窗口（成员里有它们的）。
 * @returns {{id: number, setting_key: string, visible_to: string, members: number[], text: string|null}[]}
 */
export function windowsContaining(core, perceptIds) {
  const db = core.store;
  const out = new Map();
  for (const pid of perceptIds) {
    const p = db.get('SELECT setting_key FROM percepts WHERE id = ?', pid);
    const candidates = p
      ? db.all('SELECT id, setting_key, visible_to, members_json, text FROM raw_windows WHERE setting_key = ? AND last_percept >= ? AND first_percept <= ? ORDER BY last_percept LIMIT 16', p.setting_key, pid, pid)
      : db.all('SELECT id, setting_key, visible_to, members_json, text FROM raw_windows WHERE last_percept >= ? AND first_percept <= ? ORDER BY last_percept LIMIT 16', pid, pid);
    for (const w of candidates) {
      let members = [];
      try { members = JSON.parse(w.members_json); } catch { members = []; }
      if (members.includes(pid) && !out.has(w.id)) out.set(w.id, { id: w.id, setting_key: w.setting_key, visible_to: w.visible_to, members, text: w.text });
    }
  }
  return [...out.values()];
}

/**
 * 重新渲染包含这些感知的窗口（撤回：原话换成「撤回了一条消息」；彻底删除：drop=true，把它们从成员里拿掉，
 * 一个成员都不剩的窗口整个删掉，删之前先删向量，§2.3）。在调用方的事务里调用。
 * @param {import('../core-types.js').CoreContext} core
 * @param {number[]} perceptIds
 * @param {{drop?: boolean}} [opt]
 * @returns {{rebuilt: number, deleted: number}}
 */
export function rebuildWindows(core, perceptIds, { drop = false } = {}) {
  const db = core.store;
  const rw = core.config.get().intake.rawWindow;
  const gone = new Set(perceptIds);
  let rebuilt = 0;
  let deleted = 0;
  for (const w of windowsContaining(core, perceptIds)) {
    const ref = { kind: 'window', id: w.id };
    const keep = drop ? w.members.filter((id) => !gone.has(id)) : w.members;
    if (drop) core.mods.worker.dropEmbeddings(core, [ref]);
    if (!keep.length) {
      db.run('DELETE FROM raw_windows WHERE id = ?', w.id);
      db.run('UPDATE percepts SET window_id = NULL WHERE window_id = ? AND id NOT IN (SELECT value FROM json_each(?))', w.id, JSON.stringify([...gone]));
      deleted += 1;
      continue;
    }
    const rows = loadRows(db, keep);
    const tStart = Math.min(...rows.map((r) => r.at));
    const tEnd = Math.max(...rows.map((r) => r.at));
    if (w.text == null) {
      // 原文已经到期：只更新成员
      db.run('UPDATE raw_windows SET members_json = ?, first_percept = ?, last_percept = ?, n_percepts = ?, t_start = ?, t_end = ? WHERE id = ?',
        JSON.stringify(keep), keep[0], keep.at(-1), keep.length, tStart, tEnd, w.id);
      rebuilt += 1;
      continue;
    }
    const text = renderWindow(core, rows, rw.maxChars);
    db.run('UPDATE raw_windows SET text = ?, members_json = ?, first_percept = ?, last_percept = ?, n_percepts = ?, t_start = ?, t_end = ? WHERE id = ?',
      text, JSON.stringify(keep), keep[0], keep.at(-1), keep.length, tStart, tEnd, w.id);
    core.mods.worker.enqueueEmbed(core, ref, [{ chunkNo: 0, kind: 'text', text }], { layer: 'raw', priority: 1 });
    rebuilt += 1;
  }
  return { rebuilt, deleted };
}
