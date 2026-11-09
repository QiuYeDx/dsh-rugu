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

/** SAFE_EXACT 里有没有我们的三个工具（只认带标记的那几行，§11.1 白名单补丁）。 */
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
  const sp = d.ctxGet('systemPrompt');
  add('host.systemPrompt', 'host', d.registered.resident ? 'ok' : 'fail',
    d.registered.resident ? 'systemPrompt.context 可用（interpolate:false、required:true）' : '没法注册常驻区（systemPrompt.context 不可用）',
    d.registered.resident ? {} : { hint: typeof sp?.context === 'function' ? '注册时报错，看 DSH 日志' : '宿主没有 systemPrompt 服务', disables: ['resident'] });
  add('host.preStep', 'host', d.registered.preStep ? 'ok' : 'fail', d.registered.preStep ? 'agent/pre-step 已挂上' : 'agent/pre-step 没挂上', d.registered.preStep ? {} : { disables: ['inject', 'claim'] });
  add('host.preExecute', 'host', d.registered.preExecute ? 'ok' : 'fail', d.registered.preExecute ? 'tools/pre-execute 已挂上（外发审视、冻结桥接记忆）' : 'tools/pre-execute 没挂上',
    d.registered.preExecute ? {} : { disables: ['egress', 'freeze'] });
  add('host.postExecute', 'host', d.registered.postExecute ? 'ok' : 'fail', d.registered.postExecute ? 'tools/post-execute 已挂上（可以返回 additionalContexts）' : 'tools/post-execute 没挂上',
    d.registered.postExecute ? {} : { disables: ['outcome', 'ingest-tool-results'] });
  add('host.guard', 'host', d.registered.guard ? 'ok' : 'warn', d.registered.guard ? 'tools.guard 已挂上（冻结的兜底）' : 'tools.guard 不可用：冻结只靠 pre-execute');
  add('host.sessionEvent', 'host', d.registered.sessionEvent ? 'ok' : 'fail', d.registered.sessionEvent ? 'session/event 已挂上' : 'session/event 没挂上',
    d.registered.sessionEvent ? {} : { disables: ['confirm', 'compaction'] });
  const agents = d.ctxGet('agents');
  add('host.agents', 'host', typeof agents?.list === 'function' ? 'ok' : 'warn', typeof agents?.list === 'function' ? 'agents.list 可用' : '拿不到 agents 服务：插件重载后要等新建的会话才有记忆工具');
  const llm = d.ctxGet('llm');
  add('host.llm', 'host', typeof llm?.stream === 'function' ? 'ok' : 'fail', typeof llm?.stream === 'function' ? 'ctx.llm.stream 可用' : '宿主没有模型服务：提炼、评估、审视都做不了（外发按 fail closed）',
    typeof llm?.stream === 'function' ? {} : { disables: ['background-llm'] });
  add('host.defineTool', 'host', d.defineToolAvailable ? 'ok' : 'warn', d.defineToolAvailable ? '@deepseek-ai/dsh-tools 的 defineTool 可用' : '找不到 defineTool：记忆工具没注册', d.defineToolAvailable ? {} : { disables: ['tools'] });
  // D112：插件自己的 Agent 预设（新建任务的下拉里那一项）。不合格不关任何东西：只是告诉主人「选不了 / 用的是精简副本」
  if (d.preset) presetItem(add, d.preset);
  // 管理页只走只给主人的 Fetch 路由（§13.1、附录 G.4）；没有就不注册管理页（fail closed），绝不退回 webServer.register
  let conn = null;
  try { conn = d.ctx?.connection ?? d.ctxGet('connection'); } catch { conn = null; }
  add('host.connection', 'host', typeof conn?.fetch?.register === 'function' ? 'ok' : 'warn',
    typeof conn?.fetch?.register === 'function' ? 'connection.fetch.register 可用（管理页只给主人）' : '没有 connection.fetch.register：管理页不注册（不会退回不鉴权的 webServer 路由）',
    typeof conn?.fetch?.register === 'function' ? {} : { disables: ['admin'] });

  // ── 运行时 ──
  const sq = await sqliteChecks();
  add('runtime.sqlite', 'runtime', sq.sqlite && sq.moduleBackup && sq.fts5 && sq.quotedQuery ? 'ok' : 'fail',
    `node:sqlite ${sq.sqlite ? '可用' : '不可用'}；模块级 backup ${sq.moduleBackup ? '有' : '没有'}；FTS5 ${sq.fts5 ? '有' : '没有'}；带引号的查询 ${sq.quotedQuery ? '正常' : '报错'}`);
  let sab = false;
  try { const b = new SharedArrayBuffer(8, { maxByteLength: 16 }); b.grow(16); sab = b.byteLength === 16; } catch { sab = false; }
  add('runtime.sab', 'runtime', sab ? 'ok' : 'info', sab ? '可增长 SharedArrayBuffer 可用（向量增量写入）' : '没有可增长 SharedArrayBuffer：向量按块追加（§8.7）');
  let jieba = false;
  try { import.meta.resolve('@node-rs/jieba'); jieba = true; } catch { jieba = false; }
  add('runtime.jieba', 'runtime', 'info', jieba ? '@node-rs/jieba 可以加载：中文分词用词典' : '没装 @node-rs/jieba：中文分词退回二元组（装不装要主人同意，附录 G.5）');
  let st = null;
  try { st = pm?.status?.() ?? null; } catch { st = null; }
  const w = st?.startup?.worker;
  add('runtime.worker', 'runtime', !st ? 'fail' : w && typeof w === 'object' && w.error ? 'warn' : 'ok',
    !st ? '核心没打开' : w && typeof w === 'object' && w.error ? `worker 没起来（${w.error}）：慢查询退回主线程降级` : 'worker 和只读连接正常');

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
  const lc = h.llm ?? {};
  const bad = Object.entries(lc.models ?? {}).filter(([, m]) => !(lc.allow ?? []).includes(m)).map(([u]) => u);
  add('llm.allowlist', 'models', bad.length ? 'fail' : 'ok', bad.length ? `这些用途的模型不在允许清单里：${bad.join('、')}` : `后台模型都在允许清单里（${[...new Set(Object.values(lc.models ?? {}))].join('、')}）`,
    bad.length ? { disables: bad.map((u) => `llm:${u}`) } : {});
  if (!d.skipNetwork) {
    let eh = null;
    try { eh = await d.ports.embedding.checkHealth(); } catch { eh = null; }
    if (eh?.disabled) add('embed.service', 'models', 'info', '没有用嵌入服务（管理页「设置」里可以改）：按字面、人和事、时间、在场的人回想，意思相近但说法不同的事不容易想起来', { disables: ['dense-recall'] });
    else add('embed.service', 'models', eh?.ok ? 'ok' : 'fail', eh?.ok ? `嵌入服务可达${eh.version ? `（Ollama ${eh.version}）` : ''}` : `嵌入服务不可达：检索降到 L3（${eh?.error ?? '没响应'}）`,
      eh?.ok ? {} : { disables: ['dense-recall'] });
    if (eh?.ok) {
      add('embed.model', 'models', eh.modelPresent === false ? 'fail' : 'ok', eh.modelPresent === false ? `嵌入模型不在：${eh.model ?? '没配置'}（到管理页「设置 → 嵌入」下载）` : `嵌入模型${eh.modelPresent == null ? '：服务没给模型清单，以实际请求为准' : '在'}（${eh.model}，${eh.dim} 维，档位 ${eh.tier}）`,
        eh.modelPresent === false ? { disables: ['dense-recall'] } : {});
      let prev = null;
      try { prev = readJson(d.paths.hostStateFile, {})?.ollamaVersion ?? null; } catch { prev = null; }
      if (eh.version && prev && prev !== eh.version) add('embed.version', 'models', 'warn', `Ollama 版本变了（${prev} → ${eh.version}）：核心会重嵌探针句子比较，模型被悄悄换过会降到 L3`);
      if (eh.version) { try { writeJsonAtomic(d.paths.hostStateFile, { ...(readJson(d.paths.hostStateFile, {}) ?? {}), ollamaVersion: eh.version, checkedAt: d.now?.() ?? Date.now() }); } catch { /* 只是比较用 */ } }
    }
  }
  // 向量空间（§8.9、§13.2）：探针向量对不上 → 核心已经标可疑、降到 L3
  try {
    const eh2 = pm?.admin?.embedding?.health?.() ?? null;
    if (eh2) {
      const level = eh2.activeUnproducible ? 'fail' : eh2.dense ? 'ok' : 'warn';
      if (!(h.embedding?.provider === 'none' && !eh2.dense)) add('embed.space', 'models', level, eh2.activeUnproducible ? '现在的向量空间对不上嵌入模型（模型可能被悄悄换过）：检索降到 L3，到管理页确认'
        : eh2.dense ? '向量空间正常，稠密召回可用' : `稠密召回暂不可用（${String(eh2.reason ?? eh2.mode ?? '原因不明').slice(0, 40)}）：检索降到 L3`);
    }
  } catch { /* 核心没有这个接口就不报 */ }
  // 回想的稳定性（D117）：今天（UTC 日）回想了几次、出错几处（按步骤）、整轮什么都没给几次、宿主等超时几次；最近一次出错在哪一步、什么错。
  // 只有数字和代码位置。有出错就提醒（聊天照常：出错的那一步只少那一层）
  try {
    const rh = pm?.admin?.recallHealth?.({ days: 2, recent: 1 }) ?? null;
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
  add('rerank', 'models', 'info', d.ports.rerank ? '重排已配置，只在显卡有空时启用' : '重排没配置（五路召回照常，§15.2）');
  const gs = d.governor?.status?.();
  if (gs) add('gpu.policy', 'models', 'info', `显卡策略 ${gs.policy}：现在 ${gs.device === 'gpu' ? 'GPU' : 'CPU'}${gs.reason ? `（${gs.reason}）` : ''}；采样器${gs.sampler ? '可用' : '不可用'}`);

  // ── 核心自我 ──
  const ss = d.ports.selfProfile?.status?.() ?? {};
  if (!ss.configured) add('self.coreSelf', 'self', 'warn', '没有配置 core-self.md（私有 kit）：常驻区只有用法说明');
  else if (!ss.present) add('self.coreSelf', 'self', 'fail', `core-self.md 读不到（${ss.error ?? '不存在'}）`);
  else {
    const text = d.ports.selfProfile.coreSelf().text;
    const longDigits = /\d{5,}/.test(text);
    const contact = /@[\w-]+\.|https?:\/\//i.test(text);
    add('self.coreSelf', 'self', longDigits || contact || ss.chars > 400 ? 'warn' : 'ok',
      `核心自我 ${ss.chars} 字${ss.chars > 400 ? '（超过 400 字的部分不进常驻区）' : ''}${longDigits ? '；里面有像账号的长数字' : ''}${contact ? '；里面有邮箱或链接' : ''}`,
      longDigits || contact ? { hint: '核心自我只该有性格、口吻和价值观（§5.7）' } : {});
  }

  // ── 适配器 ──
  for (const a of d.adapters ?? []) {
    if (a.disabled) { add(`adapter.${a.id}`, 'adapters', 'info', `适配器 ${a.id} 在配置里停用了：它的会话特征进拒认名单`); continue; }
    if (a.error) {
      add(`adapter.${a.id}`, 'adapters', a.error === 'NOT_CONFIGURED' ? 'info' : 'fail',
        a.error === 'NOT_CONFIGURED' ? `${a.id === 'qq' ? 'QQ' : a.id} 这个入口还没接上（${a.hint ?? '缺必填项'}）：可以在管理页「设置」里接` : `适配器 ${a.id} 没起来（${a.error}）：它的会话不感知、不注入`);
      continue;
    }
    if (a.external) {
      // 别的插件里注册的（bili-eyes）：协议握手；注册在记忆插件重载后仍然有效（它们在 ctx.inject 回调里注册，这里看得到就说明重新注册上了）
      if (a.adapter?.protocol !== 2) { add(`adapter.${a.id}`, 'adapters', 'fail', `外来适配器 ${a.id} 的协议版本不对（要 2）`); continue; }
      if (!a.binding) { add(`adapter.${a.id}`, 'adapters', 'ok', `外来适配器 ${a.id}：协议 2，已注册（没有 DSH 绑定：不认领会话）`); continue; }
    }
    const v = a.binding ? validateBinding(a.binding) : { ok: false, errors: [{ path: 'binding', message: '没有 DSH 绑定' }] };
    add(`adapter.${a.id}`, 'adapters', v.ok ? 'ok' : 'fail', v.ok ? `适配器 ${a.id}：工具分类 ${(a.binding.tools ?? []).length} 个` : `适配器 ${a.id} 的 DSH 绑定不合格：${v.errors.slice(0, 3).map((e) => e.path).join('、')}`,
      v.ok ? {} : { disables: [`claim:${a.id}`] });
    if (v.ok) {
      let sig = null;
      try { sig = a.binding.sessionSignature?.() ?? null; } catch { sig = null; }
      if (!(sig?.presets?.length || sig?.cwdPrefixes?.length)) {
        add(`adapter.${a.id}.signature`, 'adapters', 'warn', `适配器 ${a.id} 没有声明会话特征（preset / 工作目录）：认不出它的会话，也没法在它停用时进拒认名单`,
          { hint: '在设置里给它配 preset（例如网页会话用的 preset）' });
      }
    }
    try {
      const extra = await (a.adapter?.selfCheck?.() ?? a.binding?.selfCheck?.());
      for (const x of Array.isArray(extra) ? extra : []) {
        const n = normalizeAdapterCheck(x);
        if (n) add(`adapter.${a.id}.${n.id}`, 'adapters', n.level, `${a.id}：${n.label}`, n.detail ? { hint: n.detail } : {});
      }
    } catch (e) { add(`adapter.${a.id}.selfCheck`, 'adapters', 'warn', `适配器 ${a.id} 的自检出错（${errCode(e)}）`); }
  }
  const qq = h.adapters?.qq ?? {};
  if (qq.enabled !== false && qq.bridgeDir) {
    // 只看在不在（stat），不读内容：social-v2 里有 agentToken，内容只由 QQ 适配器按白名单字段读
    const has = (rel) => { try { return !!fsx.statSync(path.join(qq.bridgeDir, rel), { throwIfNoEntry: false }); } catch { return false; } };
    const missing = ['socialV2', 'mode', 'sessions', 'restrict'].filter((k) => !has(BRIDGE_FILES[k]));
    add('bridge.files', 'bridge', missing.length ? 'warn' : 'ok', missing.length ? `桥接文件缺：${missing.map((k) => BRIDGE_FILES[k]).join('、')}` : '桥接文件都在（social-v2、mode、sessions、白名单）');
    try {
      const src = fsx.readFileSync(path.join(qq.bridgeDir, BRIDGE_FILES.restrict), 'utf8');
      const ws = whitelistState(src);
      add('bridge.whitelist', 'bridge', !ws.found ? 'fail' : ws.missing.length ? 'warn' : 'ok',
        !ws.found ? '桥接白名单里找不到 SAFE_EXACT（桥接版本变了？）' : ws.missing.length ? `QQ 会话还用不了：${ws.missing.join('、')}（白名单补丁没打）` : 'QQ 白名单已放行记忆工具',
        ws.missing.length || !ws.found ? { hint: '到管理页「设置 → QQ 桥接」预览并打补丁，然后彻底重启 DSH', disables: ['tools:qq'] } : {});
    } catch { add('bridge.whitelist', 'bridge', 'warn', '读不到桥接的白名单文件'); }
    try {
      const dir = path.join(qq.bridgeDir, BRIDGE_FILES.presetsDir);
      const residue = (fsx.readdirSync(dir) ?? []).filter((f) => /\.(ya?ml|json|md)$/i.test(f)).some((f) => fsx.readFileSync(path.join(dir, f), 'utf8').includes('【轻量记忆】'));
      add('bridge.residue', 'bridge', 'info', residue ? '人设里还有【轻量记忆】段落（beta 期间桥接记忆冻结、不退役，正常）' : '人设里没有【轻量记忆】残留');
    } catch { /* 没有 presets 目录就不报 */ }
  }
  const frozen = h.features?.freeze !== false;
  add('bridge.freeze', 'bridge', frozen && d.registered.preExecute ? 'ok' : 'warn', frozen && d.registered.preExecute ? `桥接自带的记忆已冻结：拒绝 ${(h.freeze?.tools ?? []).join('、')} 的写入` : '桥接自带的记忆没冻结');
  const un = d.tooltable?.status?.().unclassified ?? [];
  if (un.length) add('tools.unclassified', 'adapters', 'warn', `有 ${un.length} 个工具没有分类（记忆开着的场合带长文本会被拒绝）：${un.slice(0, 5).map((x) => x.tool).join('、')}`, { hint: '让对应的适配器声明它（最好）；或者在配置文件的 host.egress.extraTools 里补分类：补成说话类的一律送审（审不了就不说），标成不说话要在管理页确认' });

  const level = items.some((x) => x.level === 'fail') ? 'fail' : items.some((x) => x.level === 'warn') ? 'warn' : 'ok';
  return { at: d.now?.() ?? Date.now(), level, ok: level !== 'fail', items };
}

/** 预设一项（只有名字、来源、行数和代码；激活失败的诊断原文放 detail，只在管理页的诊断里看）。 */
function presetItem(add, p) {
  const s = p.status ?? null;
  if (!s) { add('host.preset', 'host', 'warn', '读不到插件预设的状态'); return; }
  const name = `「${s.name || s.id}」`;
  const mine = Array.isArray(p.roster) ? p.roster.find((r) => r?.id === s.id) : null;
  if (s.enabled === false) {
    add('host.preset', 'host', 'warn', `预设${name}关着（host.preset.enabled）：新建任务里没有它，用它开过的旧会话打不开`);
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
