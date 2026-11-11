#!/usr/bin/env node
// 回放评测：一把尺子（D152）。钉在库的某一刻的用例，逐例把库副本拨回那一刻、跑一次回想、渲染成她会拿到的那一块文字，
// 看用例里「该有的」进没进块、排第几，按问题的类型汇总。
//
//   node scripts/replay-eval.mjs run --db <目录> --cases <用例.json> --key <身份密钥文件> --out <输出目录>
//                                    [--only <id,id>] [--config '<JSON，覆盖核心配置>'] [--embed ollama|off|fake]
//                                    [--ollama <地址>] [--deadline-ms <毫秒>] [--sent clear|at-time] [--keep]
//   node scripts/replay-eval.mjs compare <a/summary.json> <b/summary.json>
//
// --db 目录里要有 persona-memory.db 和 persona-vectors.db（连同 -wal）。源库只读：先整份复制到 <out>/work/，之后只碰副本。
// --key 只读，不复制。路径都由参数给，代码里没有任何本机路径和真实数据；用例文件和输出都在调用方给的地方。
// 输出：<out>/summary.json（不含原文：每例各组命中没有、命中的那条在块里第几条、哪一层、块多少条多少字；按类型的命中率）、
//       屏幕上一张小表、<out>/detail/<用例 id>.txt（含那一块的原文，给人看，只留在本机）。
//
// 每一例（用例格式见 docs/实现/模块与接口.md 的 D152）：
//   1. 拨回（scripts/replay-eval/rollback.mjs 的登记表）：按入库时间删掉之后的行、跟着主表删的一起删、能还原的还原；
//      启动时库里有没登记的表就拒绝跑；拨回之后断言没有晚于那一刻的行。
//   2. 开核心：时钟定在那一刻；嵌入端口用本机 Ollama 的真实查询向量（按「空间 + 文本哈希」缓存在 <out>/embed-cache.jsonl）；
//      模型端口一律拒绝；不配重排；不起 worker 线程；不跑后台任务。冷热分层在那一刻重算一次。Ollama 连不上就退到无嵌入档，报告第一行写明。
//   3. 回想：trigger 是 message / idle 的走自动的那一块（context.recallAt：按场合键 + 感知 id 进入，和 recall 同一条路）；
//      tool 的带 query / about / time / include_history 走有意回想（和集成层记忆工具交给核心的参数一样）。会话「本周期已经给过」默认清空（看排序本身）；--sent at-time 按当时的注入记录重建（看她实际会拿到什么）。
//   4. 渲染：自动的用集成层的 renderBlock，工具的用 renderToolResult，上限照集成层的默认配置（inject / tools）。
//   5. 判定（scripts/replay-eval/judge.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkRegistry, rollbackCopy, MAIN_REGISTRY, VEC_REGISTRY, NOT_RESTORED } from './replay-eval/rollback.mjs';
import { ollamaQueryPort } from './replay-eval/embed.mjs';
import { judge, expand } from './replay-eval/judge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
export const SUMMARY_VERSION = 'replay-eval-1';
export const TYPES = Object.freeze(['point', 'timeline', 'person-time', 'roster', 'recent', 'greeting']);
const TRIGGERS = new Set(['message', 'idle', 'tool']);
const FILES = ['persona-memory.db', 'persona-vectors.db'];

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'keep') { o.keep = true; continue; }
      o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const charLen = (s) => [...String(s ?? '')].length;
const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? a.slice(0, n).join('') : a.join(''); };
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

/**
 * 读用例文件并检查格式。返回 {cases, errors}。
 * @param {string} file
 */
export function loadCases(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw?.cases;
  const errors = [];
  if (!Array.isArray(list)) return { cases: [], errors: ['用例文件应该是数组，或者 {cases: [...]}'] };
  const seen = new Set();
  for (const c of list) {
    const id = c?.id;
    const bad = (m) => errors.push(`${id ?? '(没有 id)'}：${m}`);
    if (typeof id !== 'string' || !id) { bad('缺 id'); continue; }
    if (seen.has(id)) bad('id 重复');
    seen.add(id);
    if (!TYPES.includes(c.type)) bad(`type 应为 ${TYPES.join(' / ')}`);
    if (!Number.isSafeInteger(c.at)) bad('at 应为毫秒整数');
    if (typeof c.setting !== 'string' || !c.setting) bad('缺 setting（场合键）');
    if (!TRIGGERS.has(c.trigger)) bad('trigger 应为 message / idle / tool');
    if (c.trigger === 'message' && !Number.isSafeInteger(c.focus)) bad('message 要有 focus（感知 id）');
    if (c.trigger === 'tool' && (typeof c.tool?.query !== 'string' || !c.tool.query.trim())) bad('tool 要有 tool.query');
    if (!Array.isArray(c.need) || !c.need.length || c.need.some((g) => !Array.isArray(g?.any) || !g.any.length)) bad('need 应为非空的组，每组有 any');
  }
  return { cases: list, errors };
}

/** 把源库复制到 <work>/base 并合并 WAL（源库只读：只用文件复制）。 */
function stage(dbDir, baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  for (const f of FILES) {
    const src = path.join(dbDir, f);
    if (!fs.existsSync(src)) throw new Error(`--db 目录里没有 ${f}`);
    for (const s of ['', '-wal']) {
      const dst = path.join(baseDir, f + s);
      fs.rmSync(dst, { force: true });
      if (fs.existsSync(src + s)) fs.copyFileSync(src + s, dst);
    }
    fs.rmSync(path.join(baseDir, `${f}-shm`), { force: true });
    const db = new DatabaseSync(path.join(baseDir, f));
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
  }
}

function rejectingLlm() {
  return { async complete() { throw Object.assign(new Error('回放不调模型'), { code: 'LLM_OFF' }); } };
}

/** 屏幕上的小表。 */
export function formatTable(summary) {
  const rows = [['用例', '类型', '触发', '组', '没命中的组', '位置', '块', 'avoid']];
  for (const c of summary.cases) {
    if (c.error) { rows.push([c.id, c.type ?? '', c.trigger ?? '', '出错', c.error, '', '', '']); continue; }
    const hit = c.groups.filter((g) => g.hit).length;
    const miss = c.groups.filter((g) => !g.hit).map((g) => `${g.name}${g.cutByRender ? '(核心给了、块里截掉)' : ''}`).join('、');
    const pos = c.groups.map((g) => (g.rank ?? '—')).join(',');
    rows.push([c.id, c.type, c.trigger, `${hit}/${c.groups.length}`, miss || '', pos, `${c.block.items}条/${c.block.chars}字`, c.avoid.hits.length ? String(c.avoid.hits.length) : '']);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => charLen(r[i])), 2));
  const line = (r) => r.map((x, i) => String(x) + ' '.repeat(w[i] - charLen(x))).join('  ');
  const out = rows.map(line);
  out.push('');
  for (const [t, s] of Object.entries(summary.byType)) {
    out.push(`${t}: ${s.cases} 例，全中 ${s.casesOk}（${pct(s.casesOk, s.cases)}），组 ${s.groupsHit}/${s.groups}（${pct(s.groupsHit, s.groups)}），avoid 出现 ${s.avoidHits} 条${s.errors ? `，出错 ${s.errors}` : ''}`);
  }
  const T = summary.total;
  out.push(`合计: ${T.cases} 例，全中 ${T.casesOk}（${pct(T.casesOk, T.cases)}），组 ${T.groupsHit}/${T.groups}（${pct(T.groupsHit, T.groups)}），avoid 出现 ${T.avoidHits} 条`);
  return out.join('\n');
}

function aggregate(cases) {
  const byType = {};
  const total = { cases: 0, casesOk: 0, groups: 0, groupsHit: 0, avoidHits: 0, errors: 0 };
  for (const t of TYPES) byType[t] = { cases: 0, casesOk: 0, groups: 0, groupsHit: 0, avoidHits: 0, errors: 0 };
  for (const c of cases) {
    const s = byType[c.type] ?? (byType[c.type] = { cases: 0, casesOk: 0, groups: 0, groupsHit: 0, avoidHits: 0, errors: 0 });
    for (const x of [s, total]) {
      x.cases += 1;
      if (c.error) { x.errors += 1; continue; }
      if (c.ok) x.casesOk += 1;
      x.groups += c.groups.length;
      x.groupsHit += c.groups.filter((g) => g.hit).length;
      x.avoidHits += c.avoid.hits.length;
    }
  }
  for (const t of Object.keys(byType)) if (!byType[t].cases) delete byType[t];
  return { byType, total };
}

function textOf(db, ref) {
  const m = /^([a-z])(\d+)$/.exec(ref);
  if (!m) return '';
  const sql = { p: 'SELECT text AS t FROM percepts WHERE id = ?', w: 'SELECT text AS t FROM raw_windows WHERE id = ?', e: "SELECT COALESCE(title, '') || '｜' || narrative AS t FROM episodes WHERE id = ?", a: 'SELECT text AS t FROM assertions WHERE id = ?' }[m[1]];
  if (!sql) return '';
  try { return String(db.prepare(sql).get(Number(m[2]))?.t ?? '').replace(/\s+/g, ' '); } catch { return ''; }
}

async function runCase(c, env) {
  const { baseDir, workDir, keyFile, embedding, cfgOverride, deadlineMs, caps, render, createPersonaMemory, fakePorts, FakeClock, FakeLogger } = env;
  const dir = path.join(workDir, `case-${env.index}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(baseDir, f), path.join(dir, f));
  const t0 = performance.now();
  const rb = rollbackCopy({ main: path.join(dir, FILES[0]), vectors: path.join(dir, FILES[1]) }, c.at, { sent: env.sent });
  if (rb.unknown.length) throw new Error(`库里有没登记的表：${rb.unknown.join('、')}`);
  const tRollback = performance.now() - t0;
  const ports = fakePorts({ clock: new FakeClock(c.at), llm: rejectingLlm(), embedding: embedding ?? null, rerank: null, logger: new FakeLogger() });
  const pm = await createPersonaMemory({ dataDir: dir, keyFile, ports, startWorker: false, config: cfgOverride });
  const core = pm._core;
  let db = null;
  try {
    try { core.mods.dynamics.retier(core, { at: c.at, limit: 1e9 }); } catch { /* 分层算不了：照副本里的 */ }
    const style = core.config.get().context?.usageStyle === 'purpose' ? 'purpose' : 'guided';
    let out;
    let rendered;
    const t1 = performance.now();
    if (c.trigger === 'tool') {
      const t = c.tool;
      const s = { settingKey: c.setting, sessionId: c.session ?? null, trigger: Number.isSafeInteger(c.focus) ? 'message' : 'idle',
        ...(Number.isSafeInteger(c.focus) ? { focusPerceptId: c.focus } : {}) };
      const opt = { mode: 'deliberate', query: clip(t.query.trim(), 200), deadlineMs, budgetChars: caps.toolBudgetChars,
        ...(t.about ? { about: clip(t.about, 80) } : {}), ...(t.time ? { time: clip(t.time, 40) } : {}), ...(t.include_history === true || t.includeHistory === true ? { includeHistory: true } : {}) };
      out = await core.mods.context.recallAt(core, s, opt);
      rendered = render.renderToolResult(out.items, { style });
    } else {
      const s = { settingKey: c.setting, sessionId: c.session ?? null, trigger: c.trigger, ...(Number.isSafeInteger(c.focus) ? { focusPerceptId: c.focus } : {}) };
      out = await core.mods.context.recallAt(core, s, { mode: 'involuntary', deadlineMs, budgetChars: caps.injectBudgetChars });
      rendered = render.renderBlock(out.items, { maxChars: caps.blockMaxChars, style });
    }
    const tRecall = performance.now() - t1;
    db = new DatabaseSync(path.join(dir, FILES[0]), { readOnly: true });
    const j = judge(db, c, rendered.used, out.items);
    const res = {
      id: c.id, type: c.type, trigger: c.trigger, at: c.at, ok: j.ok && !j.missingRefs.length,
      groups: j.groups, avoid: { n: j.avoid.refs.length, hits: j.avoid.hits },
      block: { items: rendered.used.length, chars: charLen(rendered.text), layers: [...new Set(rendered.used.map((x) => x.layer))] },
      coreItems: out.items.length, degradeLevel: out.degradeLevel ?? null,
      ...(j.missingRefs.length ? { missingRefs: [...new Set(j.missingRefs)] } : {}),
      ms: { rollback: Math.round(tRollback), recall: Math.round(tRecall), total: Math.round(performance.now() - t0) },
    };
    // 给人看的：含原文，只留在本机
    const lines = [
      '# 本文件含聊天原文，只留在本机，不要提交、不要外传。',
      `用例 ${c.id}（${c.type}，${c.trigger}）  那一刻 ${new Date(c.at).toISOString()}  场合 ${c.setting}  会话 ${c.session ?? '—'}  焦点 ${c.focus ?? '—'}`,
      ...(c.tool ? [`工具参数 ${JSON.stringify(c.tool)}`] : []),
      `结果 ${res.ok ? '全中' : '没全中'}  降级 ${res.degradeLevel}  核心给了 ${out.items.length} 条，块里 ${res.block.items} 条 ${res.block.chars} 字`,
      `拨回 ${JSON.stringify(rb.stats)}`,
      '',
      '## 各组',
      ...res.groups.map((g) => `- ${g.name}：${g.hit ? `命中（第 ${g.rank} 条 ${g.via}，${g.layer}；中了 ${g.matched}/${g.min}）` : `没命中${g.cutByRender ? '（核心给了，块里截掉）' : ''}`}`),
      ...(c.need ?? []).flatMap((g) => g.any.map((r) => `    ${g.name ?? ''} ${r} → 等价 ${[...expand(db, r)].join(',')}｜${clip(textOf(db, r), 80)}`)),
      `avoid：${res.avoid.hits.length ? res.avoid.hits.join(',') : '没有出现'}`,
      '',
      '## 核心给的条目（渲染前；* = 进了块）',
      ...out.items.map((it, i) => `${rendered.used.includes(it) ? '*' : ' '}${i + 1}. [${it.layer}] ${it.id} ${it.verdict ?? ''} ${clip(String(it.rendered ?? '').replace(/\s+/g, ' '), 100)}`),
      '',
      '## 她拿到的那一块',
      rendered.text || '（空）',
    ];
    fs.mkdirSync(env.detailDir, { recursive: true });
    fs.writeFileSync(path.join(env.detailDir, `${c.id.replace(/[\\/:*?"<>|]/g, '_')}.txt`), `${lines.join('\n')}\n`);
    return res;
  } finally {
    try { db?.close(); } catch { /* 尽力 */ }
    try { await pm.close(); } catch { /* 尽力 */ }
    if (!env.keep) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * 跑一遍。返回摘要（同时写 <out>/summary.json 和 detail/）。
 * @param {{db: string, cases: string, key: string, out: string, only?: string[], config?: object, embed?: 'ollama'|'off'|'fake',
 *          ollama?: string, deadlineMs?: number, keep?: boolean, sent?: 'clear'|'at-time', log?: (s: string) => void}} o
 */
export async function runReplay(o) {
  const log = o.log ?? ((s) => console.log(s));
  const t0 = performance.now();
  const { cases: all, errors } = loadCases(o.cases);
  if (errors.length) throw Object.assign(new Error(`用例文件有错：\n${errors.join('\n')}`), { code: 'BAD_CASES' });
  const cases = o.only?.length ? all.filter((c) => o.only.includes(c.id)) : all;
  if (!cases.length) throw Object.assign(new Error('没有要跑的用例'), { code: 'BAD_CASES' });
  if (!fs.existsSync(o.key)) throw new Error('--key 指向的身份密钥文件不存在');
  const out = path.resolve(o.out);
  const workDir = path.join(out, 'work');
  const baseDir = path.join(workDir, 'base');
  stage(o.db, baseDir);
  // 防漏：表清单和登记表对一遍
  {
    const unknown = [];
    for (const [f, reg, tag] of [[FILES[0], MAIN_REGISTRY, ''], [FILES[1], VEC_REGISTRY, 'vectors:']]) {
      const db = new DatabaseSync(path.join(baseDir, f), { readOnly: true });
      try { unknown.push(...checkRegistry(db, reg).unknown.map((t) => tag + t)); } finally { db.close(); }
    }
    if (unknown.length) throw Object.assign(new Error(`库里有没登记的表（拨回规则不全，拒绝跑）：${unknown.join('、')}`), { code: 'UNREGISTERED_TABLE' });
  }
  const space = (() => {
    const db = new DatabaseSync(path.join(baseDir, FILES[0]), { readOnly: true });
    try { return db.prepare("SELECT * FROM vector_spaces WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1").get() ?? null; } finally { db.close(); }
  })();
  const { createPersonaMemory } = await imp('packages/core/src/index.js');
  const { fakePorts, FakeClock, FakeLogger, FakeEmbedding } = await imp('packages/core/test/fakes/index.js');
  const render = await imp('packages/dsh/src/host/render.js');
  const { HOST_DEFAULTS } = await imp('packages/dsh/src/host/config.js');
  const caps = {
    injectBudgetChars: HOST_DEFAULTS.inject?.budgetChars ?? 900,
    blockMaxChars: HOST_DEFAULTS.inject?.blockMaxChars ?? 1400,
    toolBudgetChars: HOST_DEFAULTS.tools?.recallBudgetChars ?? 1200,
  };
  const embedMode = o.embed ?? 'ollama';
  let embedding = null;
  let embedNote;
  let embedStats = null;
  if (embedMode === 'fake') {
    embedding = new FakeEmbedding();
    embedNote = '嵌入：测试替身（FakeEmbedding）';
  } else if (embedMode === 'off' || !space) {
    embedNote = `嵌入：无嵌入档（${embedMode === 'off' ? '--embed off' : '库里没有活动的向量空间'}）；这种结果不能用来判断和向量那一路有关的改动`;
  } else {
    const r = await ollamaQueryPort({ space, url: o.ollama ?? 'http://127.0.0.1:11434', cacheFile: path.join(out, 'embed-cache.jsonl') });
    embedding = r.port;
    embedStats = r.stats;
    embedNote = r.port ? `嵌入：本机 Ollama 的真实查询向量（${space.model}，${space.dim} 维）`
      : `嵌入：无嵌入档——${r.reason}；这种结果不能用来判断和向量那一路有关的改动`;
  }
  log(embedNote);
  const deadlineMs = Number(o.deadlineMs) > 0 ? Number(o.deadlineMs) : 30_000;
  const env = { baseDir, workDir, keyFile: path.resolve(o.key), embedding, cfgOverride: o.config ?? {}, deadlineMs, caps, render, createPersonaMemory, fakePorts, FakeClock, FakeLogger,
    detailDir: path.join(out, 'detail'), keep: !!o.keep, index: 0, sent: o.sent === 'at-time' ? 'at-time' : 'clear' };
  const results = [];
  for (const c of cases) {
    env.index += 1;
    try {
      results.push(await runCase(c, env));
    } catch (e) {
      results.push({ id: c.id, type: c.type, trigger: c.trigger, at: c.at, ok: false, error: `${e?.code ?? e?.name ?? 'Error'}: ${String(e?.message ?? e).slice(0, 200)}` });
    }
    const r = results.at(-1);
    log(`  ${r.id} ${r.error ? `出错 ${r.error}` : `${r.groups.filter((g) => g.hit).length}/${r.groups.length} ${r.ms.total}ms`}`);
  }
  const summary = {
    version: SUMMARY_VERSION,
    note: embedNote,
    embed: { mode: embedding ? embedMode : 'off', ...(embedStats ? { cacheHits: embedStats.hits, calls: embedStats.calls } : {}) },
    config: o.config ?? {}, deadlineMs, caps, sent: env.sent,
    rollback: { by: '入库时间', notRestored: NOT_RESTORED },
    cases: results,
    ...aggregate(results),
    ms: Math.round(performance.now() - t0),
  };
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (!o.keep) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return summary;
}

/** 两次的摘要对比成改前改后两列。 */
export function formatCompare(a, b) {
  const out = [];
  if (a.note !== b.note) out.push(`注意：两次的嵌入不一样——前：${a.note}；后：${b.note}`);
  const byId = new Map(b.cases.map((c) => [c.id, c]));
  const cell = (c) => (!c ? '—' : c.error ? '出错' : `${c.groups.filter((g) => g.hit).length}/${c.groups.length}${c.avoid.hits.length ? ` avoid${c.avoid.hits.length}` : ''}`);
  const rows = [['用例', '类型', '改前', '改后', '']];
  const ids = [...new Set([...a.cases.map((c) => c.id), ...b.cases.map((c) => c.id)])];
  const aById = new Map(a.cases.map((c) => [c.id, c]));
  for (const id of ids) {
    const x = aById.get(id);
    const y = byId.get(id);
    const hx = x && !x.error ? x.groups.filter((g) => g.hit).length - x.avoid.hits.length : null;
    const hy = y && !y.error ? y.groups.filter((g) => g.hit).length - y.avoid.hits.length : null;
    const mark = hx == null || hy == null ? '' : hy > hx ? '变好' : hy < hx ? '变坏' : '';
    rows.push([id, (x ?? y).type, cell(x), cell(y), mark]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => charLen(r[i])), 2));
  for (const r of rows) out.push(r.map((v, i) => String(v) + ' '.repeat(w[i] - charLen(v))).join('  ').trimEnd());
  out.push('');
  const types = [...new Set([...Object.keys(a.byType), ...Object.keys(b.byType)])];
  const rate = (s) => (s ? `${s.groupsHit}/${s.groups}（${pct(s.groupsHit, s.groups)}），全中 ${s.casesOk}/${s.cases}` : '—');
  for (const t of types) out.push(`${t}: ${rate(a.byType[t])}  →  ${rate(b.byType[t])}`);
  out.push(`合计: ${rate(a.total)}  →  ${rate(b.total)}`);
  return out.join('\n');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (cmd === 'compare') {
    const [fa, fb] = o._;
    if (!fa || !fb) { console.error('用法：node scripts/replay-eval.mjs compare <a.json> <b.json>'); return 2; }
    console.log(formatCompare(JSON.parse(fs.readFileSync(fa, 'utf8')), JSON.parse(fs.readFileSync(fb, 'utf8'))));
    return 0;
  }
  if (cmd !== 'run' || !o.db || !o.cases || !o.key || !o.out) {
    console.error('用法：node scripts/replay-eval.mjs run --db <目录> --cases <用例.json> --key <身份密钥文件> --out <输出目录> [--only id,id] [--config JSON] [--embed ollama|off|fake] [--ollama 地址] [--deadline-ms 毫秒] [--sent clear|at-time] [--keep]');
    console.error('      node scripts/replay-eval.mjs compare <a.json> <b.json>');
    return 2;
  }
  let config = {};
  if (o.config) {
    try { config = JSON.parse(o.config); } catch { console.error('--config 不是合法的 JSON'); return 2; }
  }
  try {
    const s = await runReplay({ db: o.db, cases: o.cases, key: o.key, out: o.out, config, embed: o.embed, ollama: o.ollama,
      deadlineMs: o['deadline-ms'], keep: o.keep, sent: o.sent, only: o.only ? o.only.split(',').filter(Boolean) : undefined });
    console.log('');
    console.log(s.note);
    console.log(formatTable(s));
    console.log(`\n用时 ${(s.ms / 1000).toFixed(1)} 秒；摘要 ${path.join(path.resolve(o.out), 'summary.json')}`);
    return s.cases.some((c) => c.error) ? 1 : 0;
  } catch (e) {
    console.error(e?.message ?? e);
    return e?.code === 'UNREGISTERED_TABLE' || e?.code === 'BAD_CASES' ? 3 : 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
