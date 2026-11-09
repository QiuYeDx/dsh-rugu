// 核心对外的全部 API（§4.5）：createPersonaMemory({ports, config, dataDir}) 组装 CoreContext，方法都只是转给各模块的函数。
// 这一层只做三件事：
//   1. 校验调用方给的参数（contract 的校验器），不合契约就抛 ContractError（observe 这类「不抛错」的方法除外）；
//   2. 「同步入队、不抛错」的方法（observe、describe、sealBuffers、expectRelay、outcome）在这里兜住所有异常，只记日志和计数；
//   3. 只读模式（库比代码新，§12.5）：不注入、不摄入——读接口返回空结果，写接口拒绝。
//      整体恢复期间（backup.isRestoring，§12.4.5 第 2 步）同理：聊天照常，只是不注入新回想（不写新记忆由 intake 管）。
// 模块的语义和错误行为见 docs/实现/模块与接口.md。
import path from 'node:path';
import {
  ContractError, ReadOnlyError, PROTOCOL, OUTCOMES,
  validatePerceptionAdapter, assertSituationRef, assertRecallOptions, assertUtterance, assertNoteRequest, assertFixRequest,
  validateImportRecords, isOpaqueId, LIMITS,
} from './contract/index.js';
import {
  openStore, openVectorStore, dataFiles, mainDbIdOf, loadOrCreateKey, makeKeyring, bumpMetric, checkSchema,
  MIGRATIONS, SCHEMA_VERSION, schemaVersionOf,
} from './store/index.js';
import { normalizePorts } from './ports/index.js';
import { toConfigHandle } from './config/defaults.js';
import { runJobs, recoverJobs, tick } from './maintenance.js';
import * as lang from './lang/index.js';
import * as intake from './intake/index.js';
import * as entities from './entities/index.js';
import * as encode from './encode/index.js';
import * as dynamics from './dynamics/index.js';
import * as retrieve from './retrieve/index.js';
import * as discretion from './discretion/index.js';
import * as context from './context/index.js';
import * as consolidate from './consolidate/index.js';
import * as worker from './worker/index.js';
import * as backup from './backup/index.js';
import * as admin from './admin/index.js';

/**
 * 模块，按 init 的顺序（被依赖的在前）。core.mods 默认就是它；模块之间互相调用一律写 core.mods.<模块>.<函数>(core, …)，
 * 不 static import 别的业务模块（scripts/check-boundaries.mjs 会查），这样单测里可以换掉依赖（test/fakes/test-core.js）。
 */
export const MODULES = Object.freeze({ lang, admin, intake, entities, dynamics, discretion, encode, worker, retrieve, context, consolidate, backup });

export const CAPABILITIES = Object.freeze([
  'observe', 'describe', 'sealBuffers', 'expectRelay', 'cursor', 'modeOf',
  'resident', 'recall', 'recallCached', 'coreBlock',
  'appraise', 'outcome', 'ingest', 'note', 'fix', 'admin', 'maintenance', 'sessions', 'media', 'lessons',
]);

const READ_ONLY_LAYERS = Object.freeze({ items: Object.freeze([]), degradeLevel: 4, traceId: 'read-only' });
const RESTORING_LAYERS = Object.freeze({ items: Object.freeze([]), degradeLevel: 4, traceId: 'restoring' });

/**
 * @typedef {object} CreateOptions
 * @property {import('./ports/index.js').Ports} [ports]
 * @property {object|import('./config/defaults.js').ConfigHandle} [config]   用户配置对象，或一个 createConfig() 的句柄（热加载）
 * @property {string} dataDir                  主库、向量库、本机备份都在这里（DSH 上默认 ~/.dsh/persona-memory，主人可以在私有配置里换到别的盘上）
 * @property {string} [keyFile]                身份哈希密钥（默认 <dataDir>/persona-memory.key；DSH 上是 ~/.dsh/persona-memory.key）
 * @property {boolean} [readOnly]              以只读方式打开（工具、诊断用）
 * @property {boolean} [startWorker]           起 worker 线程（默认 true；测试里可以关）
 */

/**
 * 打开记忆核心。失败只在两种情况下抛错：数据目录或密钥不可用、迁移前的备份做不了（这时不迁移，宁可不启动）。
 * 其余启动步骤（worker、向量空间、墓碑清扫……）失败只降级，结果在 status().startup 里。
 * @param {CreateOptions} opt
 * @returns {Promise<PersonaMemoryApi>}
 */
export async function createPersonaMemory(opt) {
  if (!opt || typeof opt.dataDir !== 'string' || !opt.dataDir) throw new TypeError('createPersonaMemory 需要 dataDir');
  const ports = normalizePorts(opt.ports);
  const config = toConfigHandle(opt.config);
  const files = dataFiles(opt.dataDir);
  const keyFile = opt.keyFile ?? path.join(opt.dataDir, 'persona-memory.key');
  const keys = makeKeyring(loadOrCreateKey(keyFile));

  /** @type {import('./core-types.js').CoreContext} */
  const core = {
    store: /** @type {any} */ (null),
    vectors: null,
    ports,
    config,
    keys,
    keyFile,
    adapters: new Map(),
    dataDir: opt.dataDir,
    readOnly: false,
    state: {},
    log: ports.logger,
    now: () => ports.clock.now(),
    jobHandlers: new Map(),
    mods: MODULES,
    reopen: async () => {},
  };
  const startup = {};

  async function openStores() {
    const cfg = config.get();
    core.store = await openStore({
      file: files.main,
      readOnly: !!opt.readOnly,
      clock: ports.clock,
      logger: ports.logger,
      slowMs: cfg.store.slowMs,
      busyTimeoutMs: cfg.store.busyTimeoutMs,
      backup: (info) => core.mods.backup.preOperationSnapshot(core, info),
    });
    core.readOnly = core.store.readOnly;
    core.vectors = null;
    if (!core.readOnly) {
      try {
        core.vectors = openVectorStore({ file: files.vectors, mainDbId: mainDbIdOf(core.store), clock: ports.clock, logger: ports.logger, slowMs: cfg.store.slowMs });
      } catch (e) {
        startup.vectors = { error: e?.code ?? e?.name ?? 'Error' };   // 向量库是缓存：开不了只是降到 L3
      }
    }
  }
  async function initModules() {
    for (const [name, mod] of Object.entries(core.mods)) {
      await mod.init(core);
      if (!core.state[name]) core.state[name] = {};
    }
  }
  async function step(name, fn) {
    try { startup[name] = (await fn()) ?? 'ok'; } catch (e) { startup[name] = { error: e?.code ?? e?.name ?? 'Error' }; }
  }
  async function runStartup() {
    if (core.readOnly) { startup.mode = 'read-only'; return; }
    await step('jobs', () => ({ requeued: recoverJobs(core) }));
    await step('self', () => ({ self: core.mods.entities.ensureSelf(core), principal: core.mods.entities.ensurePrincipal(core) }));
    await step('ghosts', () => core.mods.entities.repairMentionGhosts(core));   // D108：提及造出来的「假人」（幂等）
    await step('tombstones', () => core.mods.admin.reapplyTombstones(core));
    if (opt.startWorker !== false) {
      await step('worker', () => core.mods.worker.start(core));   // 线程起来之前先清扫向量缓存（§12.8）
      await step('space', () => core.mods.worker.ensureSpace(core));
    } else {
      // 不起线程（测试、工具）也要做启动清扫（§12.8）：平时它在 worker.start 里
      await step('sweep', () => core.mods.worker.sweepVectors(core));
    }
  }
  async function disposeModules() {
    for (const mod of Object.values(core.mods).reverse()) {
      try { await mod.dispose(core); } catch { /* 关闭时尽力 */ }
    }
  }
  function closeStores() {
    try { core.vectors?.close(); } catch { /* 尽力 */ }
    try { core.store?.close(); } catch { /* 尽力 */ }
  }

  await openStores();
  await initModules();
  await runStartup();
  core.reopen = async (swap) => {
    await disposeModules();
    closeStores();
    await swap({ ...files });
    await openStores();
    await initModules();
    await runStartup();
  };
  return buildApi(core, { startup, files });
}

/** 兜住异常：同步入队类的方法永不抛错（§4.5），只记日志和计数。 */
function quiet(core, name, fn) {
  try { fn(); } catch (e) {
    try {
      core.log.warn('api.dropped', { method: name, error: e?.code ?? e?.name ?? 'Error' });
      if (!core.readOnly && core.store && !core.store.closed) bumpMetric(core.store, `api.${name}.error`);
    } catch { /* 日志也失败就算了 */ }
  }
}
function writable(core) {
  if (core.readOnly) throw new ReadOnlyError(`数据库是只读的（${core.store?.readOnlyReason ?? 'read-only'}）`);
}
/** 整体恢复进行中（§12.4.5 第 2 步：聊天照常，不注入新回想）。查不了就当没在恢复。 */
function restoring(core) {
  try { return !!core.mods.backup.isRestoring(core); } catch { return false; }
}
function resolveKey(core, settingId) {
  if (!isOpaqueId(settingId)) throw new ContractError('SettingId', [{ path: 'settingId', message: '应为不透明 id' }]);
  const s = core.mods.intake.resolveSetting(core, settingId);
  if (!s) throw new ContractError('SettingId', [{ path: 'settingId', message: '没有描述过这个场合（或两个适配器撞了同一个 id）' }]);
  return s.key;
}

/**
 * @typedef {ReturnType<typeof buildApi>} PersonaMemoryApi
 */
function buildApi(core, { startup, files }) {
  const at = () => core.now();
  let closed = false;
  const api = {
    protocol: PROTOCOL,
    capabilities: CAPABILITIES,
    get readOnly() { return core.readOnly; },

    /** 健康（给总览和启动自检，§13.1、§13.2）。只有数字和状态，没有内容。 */
    status() {
      const store = core.store;
      return {
        readOnly: core.readOnly,
        readOnlyReason: store?.readOnlyReason ?? null,
        schemaVersion: store && !store.closed ? schemaVersionOf(store) : null,
        codeSchemaVersion: SCHEMA_VERSION,
        schema: store && !store.closed ? checkSchema(store, MIGRATIONS) : null,
        migration: store?.migration ?? null,
        vectors: core.vectors ? { wiped: /** @type {any} */ (core.vectors).wiped ?? null } : null,
        adapters: [...core.adapters.keys()],
        startup: { ...startup },
        files: { main: path.basename(files.main), vectors: path.basename(files.vectors) },
      };
    },

    // ── 感知（§4.5） ──────────────────────────────────────────────────────
    /**
     * @param {import('./contract/types.js').PerceptionAdapter} a
     * @returns {() => void}
     */
    registerAdapter(a) {
      const v = validatePerceptionAdapter(a);
      if (!v.ok) throw new ContractError('PerceptionAdapter', v.errors);
      if (core.adapters.has(a.id)) throw new Error(`适配器 id 重复：${a.id}`);
      core.adapters.set(a.id, a);
      let stop;
      try { stop = core.readOnly ? null : core.mods.intake.registerAdapter(core, a); } catch (e) { core.adapters.delete(a.id); throw e; }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        try { stop?.(); } catch { /* 适配器自己的停止出错不影响注销 */ }
        if (core.adapters.get(a.id) === a) core.adapters.delete(a.id);
      };
    },
    /** 同步入队，不阻塞，不抛错。opt.adapter 必填（【补】，见 ObserveOptions）。 */
    observe(o, opt) { if (!core.readOnly) quiet(core, 'observe', () => core.mods.intake.enqueue(core, opt?.adapter, o, opt)); },
    /** 不抛错。opt.adapter 必填。 */
    describe(d, opt) { if (!core.readOnly) quiet(core, 'describe', () => core.mods.intake.describe(core, opt?.adapter, d)); },
    sealBuffers(settingId) { if (!core.readOnly) quiet(core, 'sealBuffers', () => core.mods.intake.sealBuffers(core, settingId)); },
    expectRelay(r) { if (!core.readOnly) quiet(core, 'expectRelay', () => core.mods.intake.expectRelay(core, r)); },
    /** 【补】读回适配器自己上次和感知一起提交的游标。 */
    cursor(adapterId, key) { return core.mods.intake.cursor(core, adapterId, key); },
    /**
     * 【补】这个场合当前的生效档（§10.1、§15.2）：off 不感知、不注入 / live 照常记、照常注入，说不说由关口①②逐条判断。
     * 没有影子档了（用户反馈第 6 轮）。集成层注入前、外发钩子放行前都要问它。
     * @returns {'off'|'live'}
     */
    modeOf(settingId) {
      if (core.readOnly) return 'off';
      return core.mods.admin.modeFor(core, resolveKey(core, settingId));
    },

    /**
     * 【D116】她看过的媒体：她用工具看了某条消息里的视频 / 图片 / 文件，看完之后的想法和回话交来，
     * 核心摘出她看到了什么（一次纯文字调用，预算、超时照 intake.mediaSeen），写进那条消息的媒体说明（标明是她的感知）。
     * 不抛错：返回 {ok, reason}（read-only / no-percept / self / budget / failed / timeout / none / copied / older / written …）。
     * sessionId：她看的那个会话（这一轮带按轮污点的，写下的这一项标 tainted，不当成长的依据，§9.6）；
     * material：工具结果里的文字（只拿来挡「照抄工具给的字」，不存）。
     * @param {{adapter: string, obsId: string, sessionId?: string, thoughts?: string, reply?: string, material?: string, kind?: string, at?: number, signal?: AbortSignal}} req
     * @returns {Promise<{ok: boolean, reason: string, summary?: string}>}
     */
    media: {
      async noteViewed(req) {
        if (core.readOnly) return { ok: false, reason: 'read-only' };
        if (restoring(core)) return { ok: false, reason: 'restoring' };
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
        try {
          // 按轮污点当场读（交来时就是她看完的这一轮）；读不到按带污点（fail closed）
          let tainted = true;
          try { tainted = typeof req?.sessionId === 'string' && req.sessionId ? !!core.mods.context.sessionInfo(core, req.sessionId)?.turnTainted : false; } catch { tainted = true; }
          const r = await core.mods.intake.perceiveMedia(core, {
            adapterId: str(req?.adapter, 64), obsId: req?.obsId, thoughts: str(req?.thoughts, 20_000), reply: str(req?.reply, 8000),
            material: str(req?.material, 4000), tainted,
            kind: str(req?.kind, 16), at: Number.isFinite(req?.at) ? req.at : core.now(), signal: req?.signal,
          });
          return { ok: !!r?.ok, reason: String(r?.reason ?? 'error'), ...(r?.summary ? { summary: r.summary } : {}) };
        } catch (e) {
          quiet(core, 'media', () => { throw e; });
          return { ok: false, reason: 'error' };
        }
      },
    },

    // ── 读（每一层都有自己的接口，集成层不碰表） ─────────────────────────
    /** @returns {import('./contract/types.js').ResidentBlock} */
    resident(settingId) {
      if (core.readOnly) return { text: '', version: 'read-only', itemIds: [] };
      return core.mods.context.resident(core, settingId);
    },
    /** @returns {Promise<import('./contract/types.js').RecallLayers>} */
    async recall(s, opt) {
      const sv = assertSituationRef(s);
      const ov = assertRecallOptions(opt);
      if (core.readOnly) return READ_ONLY_LAYERS;
      if (restoring(core)) return RESTORING_LAYERS;
      return core.mods.context.recall(core, sv, ov);
    },
    /** @returns {import('./contract/types.js').RecallLayers} */
    recallCached(s) {
      const sv = assertSituationRef(s);
      if (core.readOnly) return READ_ONLY_LAYERS;
      if (restoring(core)) return RESTORING_LAYERS;
      return core.mods.context.recallCached(core, sv);
    },
    self: {
      /** @returns {{text: string, hash: string}} */
      coreBlock(settingId) {
        if (core.readOnly) { const c = core.ports.selfProfile.coreSelf(); return { text: c.text, hash: c.hash }; }
        return core.mods.context.coreBlock(core, settingId);
      },
    },

    // ── 说（关口②、③） ───────────────────────────────────────────────────
    expression: {
      /**
       * 只读模式下没有注入过任何记忆，污点账本为空，返回 speak（令牌 'read-only'）。
       * @returns {Promise<import('./contract/types.js').Appraisal>}
       */
      async appraise(u, signal) {
        const uv = assertUtterance(u);
        if (core.readOnly) return { verdict: 'speak', token: 'read-only' };
        return core.mods.discretion.appraise(core, uv, signal);
      },
      /** 不抛错。 */
      outcome(token, result, meta) {
        if (core.readOnly) return;
        quiet(core, 'outcome', () => {
          if (!isOpaqueId(token) || !OUTCOMES.includes(result)) throw new ContractError('outcome', [{ path: 'token/result', message: '不合契约' }]);
          core.mods.discretion.outcome(core, token, result, meta);
        });
      },
    },

    // ── 写类请求 ──────────────────────────────────────────────────────────
    ingest: {
      /** @returns {Promise<import('./contract/types.js').ImportReport>} */
      async import(records, opt) {
        writable(core);
        const v = validateImportRecords(records);
        if (!v.ok) throw new ContractError('ImportRecord[]', v.errors);
        if (opt?.provenance !== 'imported' || typeof opt?.source !== 'string' || !opt.source) {
          throw new ContractError('ImportOptions', [{ path: 'provenance/source', message: "provenance 必须是 'imported'，source 必填" }]);
        }
        return core.mods.encode.importRecords(core, v.value, { provenance: 'imported', source: opt.source });
      },
    },
    /** @returns {Promise<import('./contract/types.js').NoteResult>} */
    async note(req) { writable(core); return core.mods.encode.note(core, assertNoteRequest(req)); },
    /** @returns {Promise<import('./contract/types.js').FixResult>} */
    async fix(req) { writable(core); return core.mods.encode.fix(core, assertFixRequest(req)); },

    /**
     * 【D124】她自己的经验：做事学到的规则 + 怎么知道它是对的 + 要避开的坑，标验证过 / 还没验证（kind_hint='lesson' 的事实）。
     *   note：memory_note 的 kind=lesson（她自己记；验证过没有由核心按证据定，见 encode/lessons.js）；
     *   toolOutcome：宿主交来一次工具调用成没成（不抛错）——没成的、换了做法后成了的记下来，返回 recovered（这时她记下的
     *                这个工具的经验算验证过）和现在有几条这个工具的经验。
     */
    lessons: {
      /** @returns {Promise<{status: 'done'|'rejected', reason?: string, refs?: string[], lessonStatus?: string, merged?: boolean, triggerObsId?: string}>} */
      async note(req) {
        writable(core);
        const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
        if (typeof req?.text !== 'string' || !req.text.trim()) throw new ContractError('LessonRequest', [{ path: 'text', message: '必填' }]);
        const ids = Array.isArray(req?.triggerObsIds) ? req.triggerObsIds.filter((x) => isOpaqueId(x)).slice(0, 8) : [];
        return core.mods.encode.noteLesson(core, {
          sessionId: isOpaqueId(req?.sessionId) ? req.sessionId : undefined, triggerObsId: isOpaqueId(req?.triggerObsId) ? req.triggerObsId : undefined,
          triggerObsIds: ids, text: str(req.text, 400), trap: str(req?.trap, 200), tool: str(req?.tool, 120), about: str(req?.about, LIMITS.labelMax),
          here: req?.here === true, evidenceQuote: str(req?.evidenceQuote, 400),
        });
      },
      /** @returns {{recorded: boolean, recovered: boolean, lessons: number}} */
      toolOutcome(o) {
        if (core.readOnly) return { recorded: false, recovered: false, lessons: 0 };
        try {
          return core.mods.encode.lessonToolOutcome(core, {
            sessionId: isOpaqueId(o?.sessionId) ? o.sessionId : undefined, tool: typeof o?.tool === 'string' ? o.tool.slice(0, 120) : '',
            ok: o?.ok !== false, error: typeof o?.error === 'string' ? o.error.slice(0, 400) : undefined, at: Number.isFinite(o?.at) ? o.at : core.now(),
          });
        } catch (e) {
          quiet(core, 'lessons', () => { throw e; });
          return { recorded: false, recovered: false, lessons: 0 };
        }
      },
    },

    // ── 管理（只给主人；鉴权在集成层，§13.1） ─────────────────────────────
    admin: {
      list: (q) => core.mods.admin.list(core, q),
      get: (ref) => core.mods.admin.get(core, ref),
      simulate: (s) => core.mods.admin.simulate(core, s),
      review: {
        list: () => core.mods.admin.listReview(core, { status: 'pending' }),
        /** id 是 review_queue.id；管理页表单传来的十进制数字字符串也认（D23）。 */
        decide: async (id, d) => {
          writable(core);
          const n = typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : id;
          if (!Number.isSafeInteger(n) || n <= 0 || (d !== 'approve' && d !== 'reject')) {
            throw new ContractError('review.decide', [{ path: 'id/decision', message: 'id 应为正整数，结论只能是 approve / reject' }]);
          }
          return core.mods.admin.decideReview(core, n, d, { by: 'owner' });
        },
      },
      pendingCount: (principalOnly) => (core.readOnly ? 0 : core.mods.admin.pendingCount(core, !!principalOnly)),
      /** 【D117】回想的健康：出错按步骤和错误类型分、整轮丢掉 / 部分给出、耗时分布、宿主等待的结果、最近的出错（只有代码事实）。 */
      recallHealth: (o) => core.mods.context.recallHealth(core, o),
      needToKnow: {
        list: (q) => core.mods.admin.listNeedToKnow(core, q),
        markRead: (id) => { writable(core); return core.mods.admin.markNeedToKnowRead(core, id); },
      },
      rules: {
        list: (kind) => core.mods.admin.activeRules(core, kind),
        add: (rule) => { writable(core); return core.mods.admin.addRule(core, { ...rule, createdBy: 'owner', at: at() }); },
        revoke: (id) => { writable(core); return core.mods.admin.revokeRule(core, id, { at: at() }); },
      },
      /** 按场合切 off / live（rules.kind='mode'；没有影子档了，别的值核心不认）。 */
      setMode: (settingId, mode) => {
        writable(core);
        return core.mods.admin.addRule(core, { kind: 'mode', target: { settingKey: resolveKey(core, settingId) }, value: mode, createdBy: 'owner', at: at() });
      },
      /**
       * 【D111】给场合起名字（场合键；label 为 null / 空串 = 清掉，退回自动）。主人起的名字优先于适配器给的，她心里、提示词、管理页都用它。
       * 返回改完的场合记录；不认识的场合 → null；超长、清洗后是空的 → ContractError。
       */
      renameSetting: (settingKey, label) => {
        writable(core);
        // 长度按字符数（码点）算，和管理页、intake 同一个上限；清洗后才知道的（只有不可见字符）由 intake 拒绝
        if (typeof settingKey !== 'string' || !settingKey || (label != null && typeof label !== 'string')
          || (typeof label === 'string' && [...label.trim()].length > LIMITS.settingNameMax)) {
          throw new ContractError('admin.renameSetting', [{ path: 'settingKey/label', message: `场合键必填；名字是不超过 ${LIMITS.settingNameMax} 个字的字符串或 null` }]);
        }
        return core.mods.intake.renameSetting(core, settingKey, label ?? null, { at: at() });
      },
      forget: (ref) => { writable(core); return core.mods.admin.suppress(core, ref, { state: 'forgotten', by: 'owner', at: at() }); },
      hide: (ref) => { writable(core); return core.mods.admin.suppress(core, ref, { state: 'hidden', by: 'owner', at: at() }); },
      restore: (ref) => { writable(core); return core.mods.admin.restore(core, ref, { by: 'owner', at: at() }); },
      relaxLimit: (ref) => { writable(core); return core.mods.admin.relaxLimit(core, ref, { by: 'owner', at: at() }); },
      purge: async (refs, o = {}) => { writable(core); return core.mods.admin.purge(core, refs, { ...o, by: 'owner', at: at() }); },
      withdrawBySource: (q) => { writable(core); return core.mods.admin.withdrawBySource(core, { ...q, by: 'owner', at: at() }); },
      retention: {
        get: () => core.mods.admin.retentionState(core),
        request: (to, confirmPhrase) => { writable(core); return core.mods.admin.requestRetentionChange(core, { to, confirmPhrase, by: 'owner', at: at() }); },
        cancel: () => { writable(core); return core.mods.admin.cancelRetentionChange(core, { by: 'owner', at: at() }); },
      },
      /** 【D122】夜里对照原话的改正：主人撤销一次（旧版本按确认过恢复）。 */
      checks: {
        revert: (id) => { writable(core); return core.mods.consolidate.revertCheck(core, id, { by: 'owner', at: at() }); },
      },
      /** 【D124】她的经验：主人确认一条（验证过）；忘掉、隐藏、彻底删除照普通的记忆走（forget / hide / purge）。 */
      lessons: {
        confirm: (id) => {
          writable(core);
          const n = typeof id === 'string' && /^[1-9]\d{0,15}$/.test(id) ? Number(id) : id;
          if (!Number.isSafeInteger(n) || n <= 0) throw new ContractError('lessons.confirm', [{ path: 'id', message: '应为正整数' }]);
          return core.mods.encode.confirmLesson(core, n, { at: at() });
        },
        stats: () => (core.readOnly ? { total: 0, verified: 0, promoted: 0, toolLog: 0 } : core.mods.encode.lessonStats(core)),
      },
      /** 【D126】「有记忆 / 没记忆」评测的最近一次结果（集成层跑完交来存下；只有用例名、对错和数字，没有内容）。 */
      evalResult: {
        get: () => (core.readOnly ? null : core.mods.admin.evalResult(core)),
        set: (r) => { writable(core); return core.mods.admin.setEvalResult(core, r); },
      },
      growth: {
        versions: () => core.mods.consolidate.growthVersions(core),
        revoke: (version) => { writable(core); return core.mods.consolidate.revokeGrowth(core, version, { by: 'owner', at: at() }); },
        rollback: (version) => { writable(core); return core.mods.consolidate.rollbackGrowth(core, version, { by: 'owner', at: at() }); },
      },
      backup: {
        now: async () => { writable(core); return core.mods.backup.createPack(core, { kind: 'manual' }); },
        verify: (p, o) => core.mods.backup.verifyPack(core, p, o),
        preview: (p, o) => core.mods.backup.previewRestore(core, p, o),
        restore: (p, o) => core.mods.backup.restoreFull(core, p, o),
        restorePartial: (p, sel, o) => { writable(core); return core.mods.backup.restorePartial(core, p, sel, o); },
        exportJsonl: (o) => core.mods.backup.exportJsonl(core, o),
        rescan: () => core.mods.backup.rescan(core),
        /** 【补】开启（或换）备份加密；不给恢复码就生成一个，只在这次返回（§12.4.3，D69）。 */
        setupEncryption: async (o) => { writable(core); return core.mods.backup.setupEncryption(core, o); },
        /** 【补】备份总览：上次备份、验证、演练、异地、磁盘、补不回的时间段（§13.1）。 */
        overview: () => core.mods.backup.overview(core),
      },
      /** 【补】嵌入和向量空间（§8.6.1、§8.9、§13.2，D69）。 */
      embedding: {
        health: () => core.mods.worker.health(core),
        spaces: () => core.mods.worker.spaces(core),
        /** 换到另一个空间（影子评测通过、14 天内切回、对可疑空间「就用现在的模型」：{rebaseline: true}）。 */
        activate: async (spaceId, o) => { writable(core); return core.mods.worker.activateSpace(core, spaceId, o); },
      },
    },

    // ── 后台（什么时候跑由集成层的调度决定） ───────────────────────────────
    maintenance: {
      /** @param {import('./contract/types.js').JobBudget} [budget] */
      runJobs: (budget) => runJobs(core, budget),
      /** @returns {Promise<import('./contract/types.js').SleepReport>} */
      sleep: async () => { writable(core); return core.mods.consolidate.sleep(core, {}); },
      /** 【补】每分钟左右一次的轻量维护（见 maintenance.js）。 */
      tick: (o) => tick(core, o),
    },

    // ── 会话账本【补】（§10.3–§10.5、§9.4.1、§9.6） ──────────────────────
    sessions: {
      bind: (b) => { writable(core); return core.mods.context.bindSession(core, b); },
      injected: (inj) => { writable(core); return core.mods.context.recordInjection(core, inj); },
      confirm: (sessionId, nonce) => { if (!core.readOnly) core.mods.context.confirmInjection(core, sessionId, nonce); },
      abort: (sessionId) => { if (!core.readOnly) core.mods.context.abortPending(core, sessionId); },
      compaction: (sessionId, phase) => { if (!core.readOnly) core.mods.context.compaction(core, sessionId, phase); },
      markTurnTaint: (sessionId, m) => { if (!core.readOnly) core.mods.context.markTurnTaint(core, sessionId, { ...m, at: m?.at ?? at() }); },
      step: (sessionId, s) => { if (!core.readOnly) core.mods.context.recordStep(core, sessionId, { ...s, at: s?.at ?? at() }); },
      get: (sessionId) => core.mods.context.sessionInfo(core, sessionId),
      /** 【D117】这一轮等回想的结果（等到 / 超时 / 出错 / 取消，等了多久，退回缓存给了几条）：只记数字和错误类型。不抛错。 */
      recallOutcome: (sessionId, o) => { if (!core.readOnly) quiet(core, 'recallOutcome', () => core.mods.context.noteHostRecall(core, sessionId ?? null, o)); },
      /** 【补】这个会话本周期有没有带内容的记忆进过上下文（污点账本不为空）。场合后来被关掉时，外发钩子据此判断还要不要审。 */
      holdsMemory: (sessionId) => (core.mods.context.taintLedger(core, sessionId) ?? []).length > 0,
    },

    /** 关闭：各模块 dispose、关库、释放写者锁。 */
    async close() {
      if (closed) return;
      closed = true;
      for (const mod of Object.values(core.mods).reverse()) {
        try { await mod.dispose(core); } catch { /* 尽力 */ }
      }
      try { core.vectors?.close(); } catch { /* 尽力 */ }
      try { core.store?.close(); } catch { /* 尽力 */ }
    },
  };
  // 测试和集成层的诊断用：不在契约里，别的代码不要依赖
  Object.defineProperty(api, '_core', { value: core, enumerable: false });
  return api;
}
