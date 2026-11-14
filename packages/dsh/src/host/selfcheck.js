// 启动自检（§13.2，代替 V0 的实验插件，§15.1）：每次启动都跑一遍；任何一项失败就关掉对应的部分、在总览标红，**绝不影响聊天**。
// 只读：不读任何凭据文件（credential.json、cookies、桥接的令牌）；桥接的 social-v2.json 只由 QQ 适配器按白名单字段读。
// 结果只有状态、计数和提示，没有内容。每一项：
//   {id, group, area, level: 'ok'|'info'|'warn'|'fail', status: 'ok'|'warn'|'fail'|'skip', label, detail?, disables?}
//   level 是我们自己的分级；status 是管理页认的那四种（info 算 ok）。disables 写明这一项不过时关掉了什么。
// 「关掉对应的部分」由宿主按结果执行（host/index.js 的 applySelfCheck）：适配器的绑定不合格 → 它的会话特征进拒认名单。
import fs from 'node:fs';
import path from 'node:path';
import { validateBinding } from '../binding/index.js';
import { MEMORY_TOOLS } from './tooltable.js';
import { readJson, writeJsonAtomic, errCode } from './util.js';

export const PATCH_MARK = '// persona-memory patch';

/** 桥接里我们要看的几个文件（相对桥接目录）。都不含凭据；social-v2 不在这里读。 */
export const BRIDGE_FILES = Object.freeze({
  socialV2: 'state/social-v2.json',
  mode: 'state/mode.json',
  sessions: 'state/sessions.json',
  restrict: 'plugins/qq-agent-presets/qq-tool-restrict.mjs',
  presetsDir: 'plugins/qq-agent-presets/presets',
});

const AREAS = Object.freeze({ host: '宿主', runtime: '运行时', store: '存储', models: '模型', self: '核心自我', adapters: '适配器', bridge: 'QQ 桥接' });
const STATUS_OF = { ok: 'ok', info: 'ok', warn: 'warn', fail: 'fail', skip: 'skip' };

/** 比最早那版补丁晚加进来的记忆工具（D156）：旧补丁只缺它们时算「补丁是旧的」，别的工具照常用。 */
const LATER_TOOLS = Object.freeze(['memory_look']);

/** SAFE_EXACT 里有没有我们的记忆工具（只认带标记的那几行，§11.1 白名单补丁）。 */
export function whitelistState(src) {
  const text = String(src ?? '');
  const at = text.indexOf('const SAFE_EXACT = new Set([');
  if (at < 0) return { found: false, missing: [...MEMORY_TOOLS], patched: [] };
  const end = text.indexOf('])', at);
  const body = text.slice(at, end > at ? end : undefined);
  const patched = MEMORY_TOOLS.filter((t) => body.includes(`'${t}', ${PATCH_MARK}`));
  const present = MEMORY_TOOLS.filter((t) => body.includes(`'${t}'`));
  return { found: true, missing: MEMORY_TOOLS.filter((t) => !present.includes(t)), patched };
}

/** D167 之前插件在 Cordis 里的行 id（改名成 rugu，和别人的同名插件撞了）。 */
export const LEGACY_ROW_ID = 'persona-memory';

/**
 * 用户自己的 Cordis 补丁文件里还有没有针对旧行 id 的覆盖项（D167）：家目录的 cordis.patch.yml 和每个 profile 的那一份。
 * 只按行找 `id: persona-memory`（引号可有可无，块写法、流写法都认，# 后面的注释不算）；只读，读不到的文件跳过。
 * @param {string} dshHome
 * @param {typeof fs} [fsx]
 * @returns {string[]} 找到的文件（相对 DSH 家目录，用 / 分隔）
 */
export function legacyRowOverrides(dshHome, fsx = fs) {
  if (!dshHome) return [];
  const files = ['cordis.patch.yml'];
  try {
    for (const e of fsx.readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true }) ?? []) {
      if (e?.isDirectory?.()) files.push(`profiles/${e.name}/cordis.patch.yml`);
    }
  } catch { /* 没有 profiles 目录 */ }
  const re = new RegExp(`(?:^|[\\s{,-])id\\s*:\\s*(["']?)${LEGACY_ROW_ID}\\1\\s*(?:$|[,}])`);
  const hits = [];
  for (const rel of files) {
    let text;
    try { text = fsx.readFileSync(path.join(dshHome, ...rel.split('/')), 'utf8'); } catch { continue; }
    if (String(text).split(/\r?\n/).some((line) => re.test(line.replace(/(^|\s)#.*$/, '')))) hits.push(rel);
  }
  return hits;
}

/**
 * 适配器自己的自检项归一成我们的形状。认两种：{id, level, label} 和 {name, ok, detail}（QQ 适配器）。
 * ok:false 默认只是 warn（适配器知道得最清楚的是「哪里读不到」，不一定要停掉它）；写了 critical 或 level:'fail' 才算失败。
 * @returns {{id: string, level: string, label: string, detail?: string}|null}
 */
export function normalizeAdapterCheck(x) {
  if (!x || typeof x !== 'object') return null;
  const id = String(x.id ?? x.name ?? '').replace(/[^\w.-]/g, '').slice(0, 40);
  if (!id) return null;
  let level;
  if (['ok', 'info', 'warn', 'fail'].includes(x.level)) level = x.level;
  else if (x.ok === true) level = 'ok';
  else if (x.ok === false) level = x.critical === true ? 'fail' : 'warn';
  else level = 'info';
  const label = String(x.label ?? x.detail ?? (level === 'ok' ? `${id}：正常` : `${id}：不正常`)).slice(0, 200);
  const detail = x.label && x.detail ? String(x.detail).slice(0, 300) : undefined;
  return { id, level, label, ...(detail ? { detail } : {}) };
}

async function sqliteChecks() {
  const out = { sqlite: false, moduleBackup: false, fts5: false, quotedQuery: false };
  try {
    const sqlite = await import('node:sqlite');
    out.sqlite = typeof sqlite.DatabaseSync === 'function';
    out.moduleBackup = typeof sqlite.backup === 'function';
    const db = new sqlite.DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
      db.prepare('INSERT INTO t(x) VALUES (?)').run('a AND b');
      out.fts5 = true;
      db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?').get('"AND"');
      out.quotedQuery = true;
    } finally { db.close(); }
  } catch { /* 留着 false */ }
  return out;
}

/**
 * @param {{
 *   ctx: any, ctxGet: (n: string) => any, getPm: () => any, hostConfig: () => object, paths: object,
 *   ports: {llm: any, embedding: any, rerank: any, selfProfile: any}, claims: any, tooltable: any, governor?: any,
 *   registered: Record<string, boolean>, defineToolAvailable: boolean,
 *   adapters?: {id: string, adapter: any, binding: any, error?: string, disabled?: boolean}[],
 *   fsImpl?: typeof fs, now?: () => number, skipNetwork?: boolean,
 * }} d
 */
export async function runSelfCheck(d) {
  const fsx = d.fsImpl ?? fs;
  const items = [];
  const add = (id, group, level, label, extra = {}) => {
    const { hint, ...rest } = extra;
    items.push({ id, group, area: AREAS[group] ?? group, level, status: STATUS_OF[level] ?? 'warn', label, ...(hint ? { detail: hint } : {}), ...rest });
  };
  const h = d.hostConfig();
  const pm = d.getPm();

  // ── 宿主 ──
  // D173（乙10、丁3）：标题说人话（这一项管什么、不过时会怎样）；DSH 的接口名只放在 detail 里（管理页「诊断 → 开发者明细」看得到）
  const sp = d.ctxGet('systemPrompt');
  add('host.systemPrompt', 'host', d.registered.resident ? 'ok' : 'fail',
    d.registered.resident ? '常驻的记忆块能放进对话' : '常驻的记忆块放不进对话',
    d.registered.resident ? { hint: 'DSH 的 systemPrompt.context 可用' } : { hint: typeof sp?.context === 'function' ? 'systemPrompt.context 注册时报错，看 DSH 日志' : 'DSH 没有 systemPrompt 服务', disables: ['resident'] });
  add('host.preStep', 'host', d.registered.preStep ? 'ok' : 'fail', d.registered.preStep ? '每轮回话前能把记忆放进对话' : '每轮回话前放不进记忆，也认不出对话是谁的',
    d.registered.preStep ? { hint: 'agent/pre-step 已挂上' } : { hint: 'agent/pre-step 没挂上', disables: ['inject', 'claim'] });
  add('host.preExecute', 'host', d.registered.preExecute ? 'ok' : 'fail', d.registered.preExecute ? '她发出去的话能先检查一遍，桥接自带的记忆能冻结' : '她发出去的话没法先检查，桥接自带的记忆也冻结不了',
    d.registered.preExecute ? { hint: 'tools/pre-execute 已挂上' } : { hint: 'tools/pre-execute 没挂上', disables: ['egress', 'freeze'] });
  add('host.postExecute', 'host', d.registered.postExecute ? 'ok' : 'fail', d.registered.postExecute ? '工具的结果能记下来' : '工具的结果记不下来',
    d.registered.postExecute ? { hint: 'tools/post-execute 已挂上' } : { hint: 'tools/post-execute 没挂上', disables: ['outcome', 'ingest-tool-results'] });
  add('host.guard', 'host', d.registered.guard ? 'ok' : 'warn', d.registered.guard ? '冻结桥接自带记忆的兜底挂上了' : '冻结桥接自带的记忆只剩一道检查（少了兜底）',
    { hint: d.registered.guard ? 'tools.guard 已挂上' : 'tools.guard 不可用：冻结只靠 tools/pre-execute' });
  add('host.sessionEvent', 'host', d.registered.sessionEvent ? 'ok' : 'fail', d.registered.sessionEvent ? '对话里的事件收得到' : '收不到对话里的事件：确认放进去的记忆、压缩时记下来都做不了',
    d.registered.sessionEvent ? { hint: 'session/event 已挂上' } : { hint: 'session/event 没挂上', disables: ['confirm', 'compaction'] });
  const agents = d.ctxGet('agents');
  add('host.agents', 'host', typeof agents?.list === 'function' ? 'ok' : 'warn', typeof agents?.list === 'function' ? '看得到已经开着的对话' : '看不到已经开着的对话：插件重载后要等新建的对话才有记忆工具',
    { hint: typeof agents?.list === 'function' ? 'agents.list 可用' : '拿不到 agents 服务' });
  const llm = d.ctxGet('llm');
  add('host.llm', 'host', typeof llm?.stream === 'function' ? 'ok' : 'fail', typeof llm?.stream === 'function' ? 'DSH 的模型服务可用' : 'DSH 没有模型服务：整理、说话前的细看、发出前的检查都做不了（往公开的地方说的改口；群里、私聊照常）',
    typeof llm?.stream === 'function' ? { hint: 'ctx.llm.stream 可用' } : { disables: ['background-llm'] });
  add('host.defineTool', 'host', d.defineToolAvailable ? 'ok' : 'warn', d.defineToolAvailable ? '她的记忆工具能注册' : '注册不了她的记忆工具',
    d.defineToolAvailable ? { hint: '@deepseek-ai/dsh-tools 的 defineTool 可用' } : { hint: '找不到 @deepseek-ai/dsh-tools 的 defineTool', disables: ['tools'] });
  // D112：插件自己的 Agent 预设（新建任务的下拉里那一项）。不合格不关任何东西：只是告诉主人「选不了 / 用的是精简副本」
  if (d.preset) presetItem(add, d.preset);
  // 管理页只走只给主人的 Fetch 路由（§13.1、附录 G.4）；没有就不注册管理页（fail closed），绝不退回 webServer.register
  let conn = null;
  try { conn = d.ctx?.connection ?? d.ctxGet('connection'); } catch { conn = null; }
  add('host.connection', 'host', typeof conn?.fetch?.register === 'function' ? 'ok' : 'warn',
    typeof conn?.fetch?.register === 'function' ? '管理页只给你打开' : '没有只给主人的入口：管理页不打开（不会退回谁都能开的路由）',
    typeof conn?.fetch?.register === 'function' ? { hint: 'connection.fetch.register 可用' } : { hint: '没有 connection.fetch.register（不退回不鉴权的 webServer 路由）', disables: ['admin'] });
  // D167：插件的行 id 从 persona-memory 改成了 rugu；用户自己手写的覆盖还指着旧 id 的话就不再生效了。没有就不报
  let stale = [];
  try { stale = legacyRowOverrides(d.paths?.dshHome, fsx); } catch { stale = []; }
  if (stale.length) {
    add('host.legacyRow', 'host', 'warn', `以前的设置行改名了：${stale.join('、')} 里针对 id: ${LEGACY_ROW_ID} 的覆盖不再生效`,
      { hint: `如故在 DSH 里的行 id 从 ${LEGACY_ROW_ID} 改成了 rugu（和别人的同名插件撞了）。把那一项的 id 改成 rugu，然后彻底重启 DSH；不需要那项覆盖就删掉它。` });
  }

  // ── 运行时 ──
  const sq = await sqliteChecks();
  const sqOk = sq.sqlite && sq.moduleBackup && sq.fts5 && sq.quotedQuery;
  add('runtime.sqlite', 'runtime', sqOk ? 'ok' : 'fail', sqOk ? '数据库组件齐全（存、搜、备份都能用）' : '数据库组件不全：记忆库可能打不开，或者搜不了、备份不了',
    { hint: `node:sqlite ${sq.sqlite ? '可用' : '不可用'}；模块级 backup ${sq.moduleBackup ? '有' : '没有'}；FTS5 ${sq.fts5 ? '有' : '没有'}；带引号的查询 ${sq.quotedQuery ? '正常' : '报错'}` });
  let sab = false;
  try { const b = new SharedArrayBuffer(8, { maxByteLength: 16 }); b.grow(16); sab = b.byteLength === 16; } catch { sab = false; }
  add('runtime.sab', 'runtime', sab ? 'ok' : 'info', sab ? '新算的向量能直接接上' : '新算的向量按块接上（这版 Node 少一个功能，不影响用）',
    { hint: sab ? '可增长 SharedArrayBuffer 可用' : '没有可增长 SharedArrayBuffer：向量按块追加' });
  let jieba = false;
  try { import.meta.resolve('@node-rs/jieba'); jieba = true; } catch { jieba = false; }
  add('runtime.jieba', 'runtime', 'info', jieba ? '中文分词用词典' : '中文分词按两个字一组切（没装分词词典，不影响用；装不装你定）',
    { hint: jieba ? '@node-rs/jieba 可以加载' : '没装 @node-rs/jieba' });
  let st = null;
  try { st = pm?.status?.() ?? null; } catch { st = null; }
  const w = st?.startup?.worker;
  add('runtime.worker', 'runtime', !st ? 'fail' : w && typeof w === 'object' && w.error ? 'warn' : 'ok',
    !st ? '记忆库没打开' : w && typeof w === 'object' && w.error ? `后台线程没起来（${w.error}）：慢的查询改在主线程做，会慢一些` : '后台线程正常');

  // ── 库 ──
  if (!pm || !st) add('store.open', 'store', 'fail', '记忆库没打开：这段时间不感知、不注入，聊天照常', { disables: ['all'] });
  else {
    add('store.open', 'store', st.readOnly ? 'fail' : 'ok', st.readOnly ? `记忆库是只读的（${st.readOnlyReason ?? '库比代码新'}）：不注入、不摄入` : '记忆库已打开', st.readOnly ? { disables: ['inject', 'observe'] } : {});
    add('store.schema', 'store', st.schema?.ok === false ? 'fail' : 'ok', st.schema?.ok === false ? '表结构和代码对不上' : `表结构正常（版本 ${st.schemaVersion ?? '?'}）`);
  }
  try {
    const sfs = typeof fsx.statfsSync === 'function' && fsx.existsSync(d.paths.dataDir) ? fsx.statfsSync(d.paths.dataDir) : null;
    if (sfs) {
      const freeGb = (Number(sfs.bavail) * Number(sfs.bsize)) / 1024 ** 3;
      add('store.disk', 'store', freeGb < 5 ? 'warn' : 'ok', `数据目录所在的盘剩余 ${freeGb.toFixed(1)} GB${freeGb < 5 ? '（不到 5 GB）' : ''}`);
    }
  } catch { /* 拿不到就不报 */ }

  // ── 模型 ──
  // 后台模型（D168，代替原来那项永远是绿的「模型在允许清单里」）：两项都不花钱——
  //   llm.target：选定的那一对在 DSH 里认不认得（服务商在不在、resolveModelInfo 认不认这个模型；别家服务商的错配在这里就抓住）；
  //   llm.health：运行中的健康状态（配置类的错 = 不通过；暂时类的失败率高 = 提醒）
  await llmItems(add, d.ports.llm, d.skipNetwork === true, d.now?.() ?? Date.now());
  if (!d.skipNetwork) {
    let eh = null;
    try { eh = await d.ports.embedding.checkHealth(); } catch { eh = null; }
    if (eh?.disabled) add('embed.service', 'models', 'info', '想起来的方式选的是「不用」（「设置 → 模型」里可以改）：按字面、人和事、时间、在场的人回想，意思相近但说法不同的事不容易想起来', { disables: ['dense-recall'] });
    else add('embed.service', 'models', eh?.ok ? 'ok' : 'fail', eh?.ok ? `想起来的方式连得上${eh.version ? `（Ollama ${eh.version}）` : ''}` : `想起来的方式连不上：现在只按字面、人和事、时间找（${eh?.error ?? '没响应'}）`,
      eh?.ok ? {} : { hint: '本机的 Ollama 没开，或者外部服务连不上。到「设置 → 模型」看看', disables: ['dense-recall'] });
    if (eh?.ok) {
      add('embed.model', 'models', eh.modelPresent === false ? 'fail' : 'ok', eh.modelPresent === false ? `想起来的方式要的模型还没下载：${eh.model ?? '没配置'}（到「设置 → 模型」下载）` : `想起来的方式的模型${eh.modelPresent == null ? '：服务没给模型清单，以实际请求为准' : '在'}（${eh.model}，${eh.dim} 维，档位 ${eh.tier}）`,
        eh.modelPresent === false ? { disables: ['dense-recall'] } : {});
      let prev = null;
      try { prev = readJson(d.paths.hostStateFile, {})?.ollamaVersion ?? null; } catch { prev = null; }
      if (eh.version && prev && prev !== eh.version) add('embed.version', 'models', 'warn', `Ollama 升级了（${prev} → ${eh.version}）：插件会重新比对一遍；模型被悄悄换过的话，想起来先只按字面找`);
      if (eh.version) { try { writeJsonAtomic(d.paths.hostStateFile, { ...(readJson(d.paths.hostStateFile, {}) ?? {}), ollamaVersion: eh.version, checkedAt: d.now?.() ?? Date.now() }); } catch { /* 只是比较用 */ } }
    }
  }
  // 向量空间（§8.9、§13.2）：探针向量对不上 → 核心已经标可疑、降到 L3
  try {
    const eh2 = pm?.admin?.embedding?.health?.() ?? null;
    if (eh2) {
      const level = eh2.activeUnproducible ? 'fail' : eh2.dense ? 'ok' : 'warn';
      if (!(h.embedding?.provider === 'none' && !eh2.dense)) add('embed.space', 'models', level, eh2.activeUnproducible ? '算好的向量对不上现在的模型（模型可能被悄悄换过）：想起来先只按字面找，到「设置 → 模型 → 技术细节」确认'
        : eh2.dense ? '按「意思」想起来能用' : `按「意思」想起来暂时用不了（${String(eh2.reason ?? eh2.mode ?? '原因不明').slice(0, 40)}）：先只按字面找`);
    }
  } catch { /* 核心没有这个接口就不报 */ }
  // 回想的稳定性（D117）：今天（UTC 日）回想了几次、出错几处（按步骤）、整轮什么都没给几次、宿主等超时几次；最近一次出错在哪一步、什么错。
  // 只有数字和代码位置。有出错就提醒（聊天照常：出错的那一步只少那一层）
  try {
    const rh = pm?.admin?.recallHealth?.({ days: 2, recent: 1, sessions: 0 }) ?? null;
    if (rh && Array.isArray(rh.days) && rh.days.length) {
      const t = rh.days[0] ?? {};
      const y = rh.days[1] ?? {};
      const errs = Number(t.errors) || 0;
      const lost = Number(t.lost) || 0;
      // 升级前的旧计数（D117 之前：每次整轮丢掉记一次，没有明细）单独写，不当成现在的出错提醒
      const legacy = Number(t.legacyErrors) || 0;
      const stages = Object.entries(t.byStage ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join('、');
      const last = Array.isArray(rh.recent) ? rh.recent[0] : null;
      add('store.recall', 'store', errs || lost ? 'warn' : 'ok',
        `回想：今天 ${Number(t.recalls) || 0} 次，出错 ${errs} 处${stages ? `（${stages}）` : ''}，整轮什么都没给 ${lost} 次；宿主等超时 ${Number(t.host?.timeout) || 0} 次（昨天出错 ${Number(y.errors) || 0} 处）${legacy ? `；升级前的旧计数 ${legacy} 次（没有明细）` : ''}`,
        last ? { hint: `最近一次：${String(last.stage ?? '?')} · ${String(last.code ?? '?')}${last.frame ? ` @ ${last.frame}` : ''}（${new Date(Number(last.at) || 0).toISOString().slice(0, 16)}Z）；到诊断页看明细` } : {});
    }
  } catch { /* 核心没有这个接口就不报 */ }
  add('rerank', 'models', 'info', d.ports.rerank ? '想起来以后再排一次序：配置了，只在显卡有空时用' : '想起来以后不再排一次序（没配置，回想照常）');
  const gs = d.governor?.status?.();
  const POLICY = { off: '不用', on: '一直用', adaptive: '有空才用' };
  if (gs) add('gpu.policy', 'models', 'info', `显卡：${POLICY[gs.policy] ?? gs.policy}，现在在 ${gs.device === 'gpu' ? '显卡' : 'CPU'} 上算${gs.reason ? `（${gs.reason}）` : ''}；${gs.sampler ? '读得到显卡的占用' : '读不到显卡的占用'}`);

  // ── 核心自我 ──
  const ss = d.ports.selfProfile?.status?.() ?? {};
  if (!ss.configured) add('self.coreSelf', 'self', 'warn', '没有写她的核心自我：常驻的记忆块里只有用法说明', { hint: '核心自我是一个文件，路径写在配置文件的 host.self.coreSelfFile' });
  else if (!ss.present) add('self.coreSelf', 'self', 'fail', `她的核心自我读不到（${ss.error ?? '文件不在'}）`, { hint: '路径写在配置文件的 host.self.coreSelfFile' });
  else {
    const text = d.ports.selfProfile.coreSelf().text;
    const longDigits = /\d{5,}/.test(text);
    const contact = /@[\w-]+\.|https?:\/\//i.test(text);
    add('self.coreSelf', 'self', longDigits || contact || ss.chars > 400 ? 'warn' : 'ok',
      `她的核心自我 ${ss.chars} 字${ss.chars > 400 ? '（超过 400 字的部分不放进对话）' : ''}${longDigits ? '；里面有像账号的长数字' : ''}${contact ? '；里面有邮箱或链接' : ''}`,
      longDigits || contact ? { hint: '核心自我只该写性格、口吻和价值观' } : {});
  }

  // ── 适配器 ──
  const ENTRY = { qq: 'QQ', 'dsh-web': 'DSH 桌面', bili: 'B站' };
  const en = (id) => ENTRY[id] ?? id;
  for (const a of d.adapters ?? []) {
    if (a.disabled) { add(`adapter.${a.id}`, 'adapters', 'info', `${en(a.id)} 这个入口在配置里停用了：它的对话不记、也不放记忆`); continue; }
    if (a.error) {
      add(`adapter.${a.id}`, 'adapters', a.error === 'NOT_CONFIGURED' ? 'info' : 'fail',
        a.error === 'NOT_CONFIGURED' ? `${en(a.id)} 这个入口还没接上（${a.hint ?? '缺必填项'}）：可以在「设置 → 接入」里接` : `${en(a.id)} 这个入口没起来（${a.error}）：它的对话不记、也不放记忆`);
      continue;
    }
    if (a.external) {
      // 别的插件里注册的（bili-eyes）：协议握手；注册在记忆插件重载后仍然有效（它们在 ctx.inject 回调里注册，这里看得到就说明重新注册上了）
      if (a.adapter?.protocol !== 2) { add(`adapter.${a.id}`, 'adapters', 'fail', `外来适配器 ${a.id} 的协议版本不对（要 2）`); continue; }
      if (!a.binding) { add(`adapter.${a.id}`, 'adapters', 'ok', `外来适配器 ${a.id}：协议 2，已注册（没有 DSH 绑定：不认领会话）`); continue; }
    }
    const v = a.binding ? validateBinding(a.binding) : { ok: false, errors: [{ path: 'binding', message: '没有 DSH 绑定' }] };
    add(`adapter.${a.id}`, 'adapters', v.ok ? 'ok' : 'fail', v.ok ? `${en(a.id)} 这个入口正常（认得它的 ${(a.binding.tools ?? []).length} 个工具）` : `${en(a.id)} 这个入口和 DSH 对不上：认不出它的对话`,
      v.ok ? {} : { hint: `DSH 绑定不合格：${v.errors.slice(0, 3).map((e) => e.path).join('、')}`, disables: [`claim:${a.id}`] });
    if (v.ok) {
      let sig = null;
      try { sig = a.binding.sessionSignature?.() ?? null; } catch { sig = null; }
      if (!(sig?.presets?.length || sig?.cwdPrefixes?.length)) {
        add(`adapter.${a.id}.signature`, 'adapters', 'warn', `${en(a.id)} 这个入口没说清哪些对话是它的：认不出它的对话`,
          { hint: '没有声明会话特征（preset / 工作目录）；在配置文件里给它配 preset（例如网页会话用的预设）' });
      }
    }
    try {
      const extra = await (a.adapter?.selfCheck?.() ?? a.binding?.selfCheck?.());
      for (const x of Array.isArray(extra) ? extra : []) {
        const n = normalizeAdapterCheck(x);
        if (n) add(`adapter.${a.id}.${n.id}`, 'adapters', n.level, `${a.id}：${n.label}`, n.detail ? { hint: n.detail } : {});
      }
    } catch (e) { add(`adapter.${a.id}.selfCheck`, 'adapters', 'warn', `${en(a.id)} 这个入口自己的检查出错了（${errCode(e)}）`); }
  }
  const qq = h.adapters?.qq ?? {};
  if (qq.enabled !== false && qq.bridgeDir) {
    // 只看在不在（stat），不读内容：social-v2 里有 agentToken，内容只由 QQ 适配器按白名单字段读
    const has = (rel) => { try { return !!fsx.statSync(path.join(qq.bridgeDir, rel), { throwIfNoEntry: false }); } catch { return false; } };
    const missing = ['socialV2', 'mode', 'sessions', 'restrict'].filter((k) => !has(BRIDGE_FILES[k]));
    add('bridge.files', 'bridge', missing.length ? 'warn' : 'ok', missing.length ? '桥接目录里少了几个文件：QQ 里的消息可能听不到' : '桥接要的文件都在',
      { hint: missing.length ? `缺：${missing.map((k) => BRIDGE_FILES[k]).join('、')}（桥接还没跑起来过，或者不是二代模式）` : 'social-v2、mode、sessions、白名单' });
    try {
      const src = fsx.readFileSync(path.join(qq.bridgeDir, BRIDGE_FILES.restrict), 'utf8');
      const ws = whitelistState(src);
      // 补丁是旧的（D156）：原来的三个工具都放行了，只缺后来加的（memory_look）——别的工具照常用，只是缺的那几个先不给她
      const stale = ws.found && ws.missing.length > 0 && ws.missing.every((t) => LATER_TOOLS.includes(t));
      add('bridge.whitelist', 'bridge', !ws.found ? 'fail' : ws.missing.length ? 'warn' : 'ok',
        !ws.found ? '桥接的白名单文件和插件认识的样子不一样（桥接升级了？）'
          : stale ? `QQ 里的记忆补丁是旧的：还没放行 ${ws.missing.join('、')}（别的记忆工具照常能用）`
            : ws.missing.length ? `QQ 里她还用不了记忆：${ws.missing.join('、')}（白名单补丁没打）` : 'QQ 里她能用记忆（白名单补丁打好了）',
        stale ? { hint: '到「设置 → 接入 → QQ 桥接」再打一次补丁（只会补上缺的那几行，已经有的不动），然后彻底重启 DSH', disables: ws.missing.map((t) => `tools:qq/${t}`) }
          : ws.missing.length || !ws.found ? { hint: `到「设置 → 接入 → QQ 桥接」预览并打补丁，然后彻底重启 DSH${!ws.found ? '（白名单里找不到 SAFE_EXACT）' : ''}`, disables: ['tools:qq'] } : {});
    } catch { add('bridge.whitelist', 'bridge', 'warn', '读不到桥接的白名单文件'); }
    try {
      const dir = path.join(qq.bridgeDir, BRIDGE_FILES.presetsDir);
      const residue = (fsx.readdirSync(dir) ?? []).filter((f) => /\.(ya?ml|json|md)$/i.test(f)).some((f) => fsx.readFileSync(path.join(dir, f), 'utf8').includes('【轻量记忆】'));
      add('bridge.residue', 'bridge', 'info', residue ? '桥接的人设里还留着【轻量记忆】那一段（桥接自带的记忆冻结着、不删，正常）' : '桥接的人设里没有【轻量记忆】残留');
    } catch { /* 没有 presets 目录就不报 */ }
  }
  const frozen = h.features?.freeze !== false;
  add('bridge.freeze', 'bridge', frozen && d.registered.preExecute ? 'ok' : 'warn', frozen && d.registered.preExecute ? '桥接自带的记忆冻结着：她的记忆只记在如故里' : '桥接自带的记忆没冻结：可能有两份记忆',
    { hint: frozen && d.registered.preExecute ? `拒绝 ${(h.freeze?.tools ?? []).join('、')} 的写入` : 'host.features.freeze 关着，或者工具执行前的检查没挂上' });
  const un = d.tooltable?.status?.().unclassified ?? [];
  if (un.length) add('tools.unclassified', 'adapters', 'warn', `有 ${un.length} 个工具不知道是干什么的：用它们发出去的话没经过检查（照常放行）`, { hint: `${un.slice(0, 5).map((x) => x.tool).join('、')}。让对应的插件声明它（最好）；或者在配置文件的 host.egress.extraTools 里补分类：补成说话类的一律送审，标成不说话要在管理页确认` });

  const level = items.some((x) => x.level === 'fail') ? 'fail' : items.some((x) => x.level === 'warn') ? 'warn' : 'ok';
  return { at: d.now?.() ?? Date.now(), level, ok: level !== 'fail', items };
}

const pairText = (p) => `${p.provider} / ${p.model}`;
const LLM_USES = ['glance', 'extract', 'sleep', 'summary', 'appraise', 'review', 'rewrite', 'perceive'];
const ago = (t, at) => { const m = Math.max(0, Math.round((at - t) / 60_000)); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 48 * 60 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
/** 后台模型的两项（D168）。llm 是 ports/llm.js 的端口；别的宿主的端口没有这些方法就只报一项「看不到」。 */
async function llmItems(add, llm, skipNetwork, at) {
  if (typeof llm?.health !== 'function') { add('llm.target', 'models', 'info', '看不到后台模型的选择（端口没有提供）'); return; }
  const hv = llm.health();
  if (hv.state === 'off') {
    add('llm.target', 'models', 'info', '选的是「不用后台模型」：原话照记、能按原话 / 人 / 时间找回来；不会自己整理出事实和经历', { disables: ['background-llm'] });
    return;
  }
  const rows = (hv.pairs ?? []);
  const noPair = rows.find((r) => r.error && r.error !== 'MODEL_NOT_ALLOWED' && r.error !== 'NO_MODEL');
  // 还没选的（升级前的配置）：手写的各用途模型要在允许清单里（原来那一项并到这里）
  const notAllowed = typeof llm.target === 'function' ? LLM_USES.filter((u) => ['MODEL_NOT_ALLOWED', 'NO_MODEL'].includes(llm.target(u)?.error)) : [];
  if (notAllowed.length) {
    add('llm.target', 'models', 'fail', '配置文件里写的后台模型用不了：有的用途没有可用的模型',
      { hint: `用途：${notAllowed.join('、')}（配置文件的 host.llm.models / allow）。到「设置 → 模型」选一对（选了以后就不再看 models / allow）`, disables: notAllowed.map((u) => `llm:${u}`) });
  } else if (noPair) {
    add('llm.target', 'models', 'fail', `后台模型选不出来（${noPair.error}）：DSH 里没有默认的模型，也还没在「设置 → 模型」里选`,
      { hint: '到「设置 → 模型」选一对、点「试一下」', disables: ['background-llm'] });
  } else {
    const named = rows.map((r) => `${pairText(r.pair)}${r.use === 'glance' ? '（听到时的判断）' : ''}`).join('、');
    const how = hv.mode === 'chosen' ? '' : rows[0]?.source === 'pinned' ? '（升级前的配置，第一次成功时自动钉住的）' : '（还没选，按升级前的做法：主聊天的服务商 + deepseek-flash）';
    if (skipNetwork || typeof llm.recognize !== 'function') add('llm.target', 'models', 'info', `后台模型：${named}${how}`);
    else {
      const bad = [];
      const offCatalog = [];
      for (const r of rows) {
        let k = null;
        try { k = await llm.recognize(r.pair); } catch { k = null; }
        if (k && k.ok === false) bad.push({ pair: r.pair, code: k.code });
        else if (k?.inCatalog === false) offCatalog.push(r.pair);
      }
      if (bad.length) {
        add('llm.target', 'models', 'fail', `后台模型在 DSH 里认不出来：${bad.map((b) => `${pairText(b.pair)}（${b.code}）`).join('、')}`,
          { hint: '到「设置 → 模型」换一对、点「试一下」', disables: ['background-llm'] });
      } else if (offCatalog.length) {
        add('llm.target', 'models', 'warn', `后台模型 ${offCatalog.map(pairText).join('、')} 不在 DSH 列出的模型里（DSH 不按目录拦，能不能用以「试一下」为准）${how}`);
      } else add('llm.target', 'models', 'ok', `后台模型 ${named} 在 DSH 里认得${how}`);
    }
  }
  if (hv.state === 'down') {
    add('llm.health', 'models', 'fail', `后台模型不工作（${hv.code ?? '配置有问题'}）${hv.fallback ? `：临时在用聊天的模型（${pairText(hv.fallback)}）顶着` : '：她记不住新的事、回想变少，聊天照常'}`,
      { hint: '到「设置 → 模型」换一对或者点「试一下」', disables: hv.fallback ? [] : ['background-llm'] });
  } else if (hv.state === 'flaky') {
    add('llm.health', 'models', 'warn', `后台模型最近不稳定（最近 30 分钟失败过半，${hv.code ?? '暂时的错误'}）：会自己重试`);
  } else {
    const last = rows.map((r) => r.lastOkAt).filter(Boolean).sort((a, b) => b - a)[0];
    add('llm.health', 'models', last ? 'ok' : 'info', last ? `后台模型上一次调用成功在 ${ago(last, at)}` : '后台模型还没调用过（可以在「设置 → 模型」里点「试一下」）');
  }
}

/** 预设一项（只有名字、来源、行数和代码；激活失败的诊断原文放 detail，只在管理页的诊断里看）。 */
function presetItem(add, p) {
  const s = p.status ?? null;
  if (!s) { add('host.preset', 'host', 'warn', '读不到插件预设的状态'); return; }
  const name = `「${s.name || s.id}」`;
  const mine = Array.isArray(p.roster) ? p.roster.find((r) => r?.id === s.id) : null;
  if (s.enabled === false) {
    add('host.preset', 'host', 'warn', `预设${name}关着：新建任务里没有它，用它开过的旧会话打不开`, { hint: '配置文件里 host.preset.enabled 是 false' });
    return;
  }
  if (s.broken || mine?.broken) {
    add('host.preset', 'host', 'fail', `预设${name}注册了但用不了（DSH 报激活失败）：选它开不了会话`,
      { hint: `${String(s.broken ?? '').slice(0, 300) || '看 DSH 日志里 agent preset 那一行'}${s.baseUrl === false ? '；插件的上下文没有 baseUrl，预设里的插件名可能解析不了' : ''}` });
    return;
  }
  if (!s.registered) {
    const why = s.error ? `（${s.error}）` : !s.registry ? '（DSH 的预设服务还没出现）' : '（还在等）';
    add('host.preset', 'host', s.error ? 'fail' : 'warn', `预设${name}没注册上${why}：新建任务里选不了它，用它开过的旧会话打不开`);
    return;
  }
  const listed = Array.isArray(p.roster) ? (mine ? '' : '；DSH 的预设列表里还看不到它') : '';
  if (s.source === 'fallback') {
    add('host.preset', 'host', 'warn', `新建任务里有${name}预设，用的是插件自带的精简副本（读不到标准模式，${s.rows} 个插件行）${listed}`);
    return;
  }
  add('host.preset', 'host', listed ? 'warn' : 'ok', `新建任务里有${name}预设（照标准模式，${s.rows} 个插件行）${listed}`);
}

/** 自检结果里哪些适配器的绑定不合格（宿主据此把它们的会话特征放进拒认名单，§10.3）。 */
export function failedAdapters(result) {
  const out = new Set();
  for (const x of result?.items ?? []) {
    const m = /^adapter\.([^.]+)$/.exec(x.id);
    if (m && x.level === 'fail') out.add(m[1]);
  }
  return out;
}
