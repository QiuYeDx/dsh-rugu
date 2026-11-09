// QQ 适配器（§11.1）：私聊和群共用一个，不改桥接，只读桥接落盘的文件。
// 平台知识全部在这里（和 qq/ 下的几个文件），核心里没有：
//   - 主路：监视 state/social-v2.json。fs.watch 收到事件后等文件安静 300 ms 再读一次，连续刷屏最长 2 秒也读一次，
//     轮询兜底 5 秒只比大小和修改时间（H2，adapters/watch.js）；读进来立刻投影成白名单字段，agentToken 留不下来；
//   - 只有二代模式才写 social-v2（H3）：读 state/mode.json，模式不对在状态里标「旁听不可用」；
//   - 每个会话一个游标（最大本地序号、时间、她自己的行的时间、已读水位），和感知在同一个事务里提交（§12.8）；
//     会话被重置时序号从 0 重来：序号变小、或者序号不超过游标的消息却比游标新，就改按时间对齐；窗口滚掉的消息记成缺口（管理页「这段时间没在场」）；
//   - 插件启动前就在文件里的消息按历史模式回填（不预取、不形成意图，§4.5 ObserveOptions.historical）；
//   - 已读水位越过的消息再交一次 attended（她看过了），核心按同一个 ObsId 升级注意力；
//   - SettingId = 用适配器自己的盐把会话 key 做 HMAC（contract.opaqueFrom），不含账号原值（§4.2）；
//   - 她自己发的行：按（场合、文本哈希、时间窗）对上 pre-execute 发出的审视令牌（§9.5）；能对上主人登记的定时文字的记 on-my-behalf；
//   - DSH 绑定（adapter.binding）：会话认领、唤醒头检查（C1）、唤醒快照和读消息工具的结果当场提交（来源 E）、
//     全部 MCP 工具分类和 Utterance 解析（关口②）、桥接记忆冻结的工具名单（B13）。
// 规矩：只依赖 'rugu-core/contract'、../binding/ 和 node 内置模块（scripts/check-boundaries.mjs 会查）；
//       日志只记事件名和数字；仓库里不写任何账号、群号。
import path from 'node:path';
import { opaqueFrom, textHash } from 'rugu-core/contract';
import { mkLog, ioOf, createJsonCache, isRetryableIo, parseJson, isRecord, resolveSalt } from './util.js';
import { createDebouncedWatch } from './watch.js';
import { uniqueViewed } from '../binding/index.js';
import {
  projectSocial, projectMode, isSecondGen, projectSessions, projectBridgeConfig, projectInitialPrompts, projectScheduler,
  projectMessage, canonicalKey, splitKey, forwardKey,
} from './qq/files.js';
import { toObservation, obsIdOf, knownNames, ownText, scrubAccounts, selfCardOf, PRINCIPAL_CLAIM } from './qq/messages.js';
import { describeConversation, principalActor, peerActor } from './qq/describe.js';
import { createPlatformNames } from './qq/names.js';
import { qqToolDecls, FROZEN_BARE, FROZEN_REASON, DEFAULT_MCP_PREFIX, DEFAULT_HOST_PREFIX, QQ_TOOL_CLASSES, HOST_TOOL_CLASSES } from './qq/tools.js';
import { wakeCheck, scanWake, extractSnapshot, textOfContent, messagesInResult } from './qq/wake.js';

/** 适配器 id，也是它的默认账号命名空间。check-boundaries 用它生成核心的平台词清单。 */
export const ADAPTER_ID = 'qq';
export { FROZEN_REASON, QQ_TOOL_CLASSES, HOST_TOOL_CLASSES };

const DEFAULT_TIMING = Object.freeze({
  quietMs: 300, maxWaitMs: 2000, pollMs: 5000,
  liveGraceMs: 120_000,       // 插件启动前这么久以内的消息算「刚才的」，更早的按历史回填
  selfSlackMs: 600_000,       // 她连发时桥接把时间往后错开（第 i 条 +i 秒），新旧发言的时间会交错：游标往回放宽这么多再去重
  appraisalTtlMs: 600_000,    // 审视令牌等她的行回流的时间窗
  restartWindowMs: 1_800_000, // 会话重置后这么久以内的【引导唤醒】算「重新开始」
});
const SCHEDULE_PREFIX = '（定时任务）';
const CURSOR_PREFIX = 'conv.';

/**
 * @typedef {object} QqAdapterConfig      都来自主人的私有配置（§11.6），仓库里没有任何账号
 * @property {string} [selfAccount]        她自己的账号（selfClaims）
 * @property {string[]} [selfNames]        她的名字和昵称（认「叫她名字」、selfClaims 的保留名）
 * @property {string} [principalAccount]   主人账号；不给就读桥接 config.json 的 ownerQQ
 * @property {string} [principalLabel]     她对主人的称呼，默认「主人」
 * @property {Record<string, import('./qq/describe.js').ConversationOverride>} [conversations]   按会话 key 的说明
 * @property {string} [mcpPrefix]          桥接 MCP 工具的前缀，默认 mcp__snowluma__
 * @property {string} [hostPrefix]
 * @property {boolean} [readScheduler]     核对「以她名义」时读 state/scheduler.json（默认 true）
 * @property {Partial<typeof DEFAULT_TIMING>} [timing]
 */
/**
 * @typedef {object} QqAdapterDeps
 * @property {{bridgeDir: string, dshHome?: string, dataDir?: string, keyFile?: string}} paths
 * @property {Buffer|string} [salt]        适配器自己的盐（≥ 16 字节，稳定、保密）：SettingId 和 ObsId 都由它 HMAC 出来。
 *                                         不给就从身份哈希密钥派生（util.resolveSalt），恢复备份后不变
 * @property {QqAdapterConfig|(() => QqAdapterConfig)} [config]   函数形式可以热加载
 * @property {unknown} [log]               核心 Logger 端口的形状，或 (level, event, fields) 函数
 * @property {() => number} [now]
 * @property {(p: string) => string} [readFile]       同步读（默认 fs.readFileSync）；给异步的（宿主的 fs.promises）自动改用同步读
 * @property {(p: string, enc?: string) => string} [readFileSync]   宿主传的同步读，优先用它
 * @property {(p: string) => ({size: number, mtimeMs: number}|null)} [stat]   同上，异步的自动改用 fs.statSync
 * @property {Function} [watch]            (dir, cb) 或 fs.watch 的 (path, options, listener)
 * @property {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} [timers]
 * @property {(settingId: string) => boolean} [gate]   这个场合现在要不要感知（宿主给 `(sid) => pm.modeOf(sid) !== 'off'`）
 */

/**
 * @param {QqAdapterDeps} deps
 * @returns {import('rugu-core/contract').PerceptionAdapter & {binding: QqBinding, status: () => object,
 *   selfCheck: () => {name: string, ok: boolean, detail?: string}[], noteAppraisal: (u: object, token: string) => void,
 *   refresh: () => string}}
 */
export function createQqBridgeAdapter(deps) {
  const bridgeDir = deps?.paths?.bridgeDir;
  if (typeof bridgeDir !== 'string' || !bridgeDir) {
    throw Object.assign(new TypeError('QQ 适配器：需要 paths.bridgeDir（桥接目录，配置 host.adapters.qq.bridgeDir）'), { code: 'PM_QQ_NO_BRIDGE_DIR' });
  }
  const { salt, source: saltSource } = resolveSalt(deps, ADAPTER_ID);
  const io = ioOf(deps);
  const log = mkLog(deps.log);
  const cfg = () => { try { const c = typeof deps.config === 'function' ? deps.config() : deps.config; return isRecord(c) ? c : {}; } catch { return {}; } };
  const timing = () => ({ ...DEFAULT_TIMING, ...(isRecord(cfg().timing) ? cfg().timing : {}) });
  const principalLabel = () => (typeof cfg().principalLabel === 'string' && cfg().principalLabel.trim() ? cfg().principalLabel.trim().slice(0, 20) : '主人');
  const selfNames = () => (Array.isArray(cfg().selfNames) ? cfg().selfNames.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 30)).slice(0, 16) : []);

  const stateDir = path.join(bridgeDir, 'state');
  const FILES = {
    social: path.join(stateDir, 'social-v2.json'),
    mode: path.join(stateDir, 'mode.json'),
    sessions: path.join(stateDir, 'sessions.json'),
    prompts: path.join(stateDir, 'initial-prompts.json'),
    scheduler: path.join(stateDir, 'scheduler.json'),
    config: path.join(bridgeDir, 'config.json'),
  };
  const modeC = createJsonCache(io, FILES.mode, projectMode);
  const sessionsC = createJsonCache(io, FILES.sessions, projectSessions);
  const configC = createJsonCache(io, FILES.config, projectBridgeConfig);
  const promptsC = createJsonCache(io, FILES.prompts, projectInitialPrompts);
  const schedC = createJsonCache(io, FILES.scheduler, projectScheduler);
  const bridgeCfg = () => configC.get().value;
  // 平台上的群名（D111，qq/names.js）：私有配置 platformNames=false 关掉、{dir} 换目录；默认用桥接配置里的 SnowLuma 目录。测试可整个换掉
  const platformNames = deps.platformNames ?? createPlatformNames({
    dir: () => {
      const pn = cfg().platformNames;
      if (pn === false) return null;
      if (isRecord(pn) && typeof pn.dir === 'string' && pn.dir.trim()) return pn.dir.trim();
      return bridgeCfg()?.snowlumaHome || null;
    },
    now: () => io.now(),
    log,
  });
  const ownerId = () => {
    const c = cfg().principalAccount;
    return typeof c === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c) ? c : bridgeCfg()?.ownerId;
  };
  const selfId = () => (typeof cfg().selfAccount === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(cfg().selfAccount) ? cfg().selfAccount : undefined);
  /** 宿主的总开关（§10.1）：这个场合是 off 就不感知。不给 gate 就一律感知；gate 出错按 off（fail closed）。 */
  const gateOk = (settingId) => { try { return typeof deps.gate !== 'function' || deps.gate(settingId) !== false; } catch { return false; } };

  // ── 不透明 id ──
  const sidByKey = new Map();
  const keyBySid = new Map();
  /** 会话 key → SettingId（HMAC，不含账号原值）；顺手登记反查表。 */
  function settingOf(key) {
    let s = sidByKey.get(key);
    if (!s) {
      s = opaqueFrom(salt, 'qq/setting', key);
      sidByKey.set(key, s);
      keyBySid.set(s, key);
    }
    return s;
  }
  const codeOf = (key) => opaqueFrom(salt, 'qq/code', key).slice(0, 4);

  // ── 状态 ──
  /** @type {ReturnType<typeof projectSocial>|null} */
  let social = null;
  /** @type {Map<string, {cur: Cursor|null, descHash: string|null, seenSelf: Set<string>, firstPass: boolean, resetAt?: number, resetReported?: boolean}>} */
  const convs = new Map();
  let sink = null;
  let startedAt = 0;
  let watcher = null;
  let gen = 0;
  /** @type {{settingId: string, hashes: Set<string>, token: string, until: number}[]} */
  let appraisals = [];
  const stats = {
    reads: 0, readOk: 0, parseErrors: 0, busy: 0, missing: 0, observed: 0, incoming: 0, historical: 0, upgrades: 0,
    gaps: 0, gapMessages: 0, resets: 0, received: 0, describes: 0, selfMatched: 0, selfUnmatched: 0, onMyBehalf: 0,
    wakeAlarms: 0, snapshotObs: 0, toolObs: 0, peekUnmatched: 0, forwardRelayKnown: 0, forwardRelayUnknown: 0, lastReadAt: 0, errors: 0,
  };

  // ── 合并转发是谁发来的（D118）──
  /**
   * 转发 id 的指纹（files.forwardKey）→ 带着它的那条消息的发送人（账号、是不是主人、时间）。按会话分开记：同一份转发可以被不同的人
   * 转进不同的群。同一个会话里好几条消息带着同一份（后来有人引用了它）时认最早的那条——转进来的人。
   * 只在内存里，不进库、不进日志：重启后从 social-v2 和她再读到的消息重新认；最多 2000 份，最久没用到的先丢。
   * @type {Map<string, {userId: string|null, isOwner: boolean, time: number}>}
   */
  const carriers = new Map();
  const CARRIERS_MAX = 2000;
  const carrierKey = (key, fk) => `${key}#${fk}`;
  function putCarrier(k, c) {
    const old = carriers.get(k);
    carriers.delete(k);
    carriers.set(k, old && old.time <= c.time ? old : c);
    while (carriers.size > CARRIERS_MAX) carriers.delete(carriers.keys().next().value);
  }
  /** 她看得到的消息（social-v2、唤醒快照、读消息工具的结果）里带着的转发：记下是谁发来的。她自己的行、不知道是谁的不记。 */
  function noteCarriers(key, msgs) {
    for (const m of msgs) {
      if (!m?.forwardKeys?.length || m.isSelf || (!m.userId && !m.isOwner)) continue;
      for (const fk of m.forwardKeys) putCarrier(carrierKey(key, fk), { userId: m.userId ?? null, isOwner: m.isOwner === true, time: m.time });
    }
  }
  /** 转发人的 ActorRef：和 toObservation 给那条消息的说话人一样（平台核实过的账号；桥接认出是主人的再带主人的证据）。 */
  function relayActorOf(c) {
    const claims = c.userId ? [...peerActor(c.userId).claims] : [];
    if (c.isOwner) claims.push({ ...PRINCIPAL_CLAIM });
    return { claims };
  }

  // ── 读文件 ──
  /** 读一次 social-v2.json（同步，一次读完就关）。返回 'ok' | 'parse' | 'busy' | 'missing'。 */
  function readSocial() {
    stats.reads += 1;
    let text;
    try { text = io.readFile(FILES.social); } catch (e) {
      if (e?.code === 'ENOENT') { stats.missing += 1; return 'missing'; }
      stats.busy += 1;
      if (!isRetryableIo(e)) log.warn('qq.read.error', { code: String(e?.code ?? 'io') });
      return 'busy';
    }
    const p = parseJson(text);
    if (!p.ok) {
      // 半截文件、坏文件：不重试，等文件下一次变化（§11.1）
      stats.parseErrors += 1;
      log.warn('qq.read.parse', { kind: p.error });
      return 'parse';
    }
    social = projectSocial(p.value);
    for (const [key, c] of social.conversations) { settingOf(key); noteCarriers(key, [...c.recent, ...c.unread]); }
    stats.readOk += 1;
    stats.lastReadAt = io.now();
    return 'ok';
  }

  // ── 场合描述 ──
  function descriptorFor(key) {
    const c = social?.conversations.get(key);
    const conv = cfg().conversations;
    const override = isRecord(conv) && isRecord(conv[key]) ? conv[key] : undefined;
    const { kind, id } = splitKey(key);
    let platform = null;
    if (kind === 'group') { try { platform = platformNames.group(id); } catch { platform = null; } }
    // 平台上的群名和消息文字一样清洗账号（D111 评审）：认识的账号换成名字
    const known = platform ? knownNames(c?.recent ?? [], { ownerId: ownerId(), selfId: selfId(), principalLabel: principalLabel(), kind, selfNames: selfNames() }) : undefined;
    return describeConversation({
      key, settingId: settingOf(key), code: codeOf(key), bridgeCfg: bridgeCfg(), override, platform, known,
      initialPrompt: promptsC.get().value?.get(key), ownerRules: c?.ownerRules ?? [], ownerId: ownerId(), principalLabel: principalLabel(),
    });
  }

  // ── 审视令牌对账（§9.5）──
  function pruneAppraisals() {
    const now = io.now();
    appraisals = appraisals.filter((a) => a.until >= now && a.hashes.size > 0);
  }
  /**
   * 宿主在 pre-execute 审完 QQ 的说话类工具后告诉适配器：这几句话、这个令牌。她的行回流时按（场合、文本哈希、时间窗）对上。
   * @param {import('rugu-core/contract').Utterance} u
   * @param {string} token
   */
  function noteAppraisal(u, token) {
    try {
      if (!u?.channel?.targetSettingId || typeof token !== 'string' || !token) return;
      const hashes = new Set();
      for (const t of Array.isArray(u.text) ? u.text : []) {
        if (typeof t !== 'string' || !t.trim()) continue;
        hashes.add(textHash(t));
        hashes.add(textHash(t.slice(0, 200)));
      }
      if (!hashes.size) return;
      pruneAppraisals();
      const delay = Number.isFinite(u.channel.delayMs) ? u.channel.delayMs : 0;
      appraisals.push({ settingId: u.channel.targetSettingId, hashes, token, until: io.now() + delay + timing().appraisalTtlMs });
      if (appraisals.length > 500) appraisals.splice(0, appraisals.length - 500);
    } catch (e) { stats.errors += 1; }
  }
  /** consume=false 只看不取（来源 E 先到时，读文件那条路还要对得上）。 */
  function matchToken(settingId, text, consume = true) {
    pruneAppraisals();
    const candidates = [textHash(text)];
    if (text.startsWith(SCHEDULE_PREFIX)) candidates.push(textHash(text.slice(SCHEDULE_PREFIX.length)));
    for (const a of appraisals) {
      if (a.settingId !== settingId) continue;
      const h = candidates.find((x) => a.hashes.has(x));
      if (h) { if (consume) a.hashes.delete(h); return a.token; }
    }
    return null;
  }
  /** 她的行是不是主人登记的定时文字（只读核对任务的目标和固定文字，§9.5）。 */
  function scheduledByPrincipal(key, text) {
    if (!text.startsWith(SCHEDULE_PREFIX) || cfg().readScheduler === false) return false;
    const tasks = schedC.get().value ?? [];
    return tasks.some((t) => t.kind === 'text' && !t.byHer && t.targets.includes(key) && `${SCHEDULE_PREFIX}${t.text}`.slice(0, 200) === text.slice(0, 200));
  }
  /** 桥接 scheduler.json 里的这个任务（改任务时按它合并补丁，§11.1）。读不到、坏了、没有这个编号 → null（改内容的就审不了）。 */
  function scheduledTask(id) {
    const n = typeof id === 'number' ? id : typeof id === 'string' && /^\d{1,9}$/.test(id.trim()) ? Number(id) : NaN;
    if (!Number.isSafeInteger(n)) return null;
    const r = schedC.get();
    if (!r.ok || r.missing) return null;
    return (r.value ?? []).find((t) => t.id === n) ?? null;
  }

  // ── 映射 ──
  function mapCtx(key, msgs) {
    const { kind, id } = splitKey(key);
    const list = [...msgs];
    return {
      key, kind, settingId: settingOf(key), salt, selfNames: selfNames(), now: io.now(),
      known: knownNames(list, { ownerId: ownerId(), selfId: selfId(), principalLabel: principalLabel(), kind, peerId: kind === 'private' ? id : undefined, selfNames: selfNames() }),
      selfAccount: selfId(), ownerAccount: ownerId(), selfCard: kind === 'group' ? selfCardOf(list) : '',
    };
  }
  /**
   * 她自己的一行：对令牌，判 on-my-behalf。count=false 时不记数（历史回填、重启后放宽窗口里多半交过的行、来源 E）。
   * @param {{consume?: boolean, count?: boolean}} [o]
   */
  function selfOptions(key, m, { consume = true, count = true } = {}) {
    const text = ownText(m).text;
    const token = matchToken(settingOf(key), text, consume);
    if (token) { if (count) stats.selfMatched += 1; return { appraisalToken: token }; }
    if (scheduledByPrincipal(key, text)) { if (count) stats.onMyBehalf += 1; return { onMyBehalf: true }; }
    if (count) stats.selfUnmatched += 1;   // 未经审视的发言：核心发现没带令牌会报警、回头补评估（§9.5）
    return {};
  }

  // ── 游标 ──
  /** @typedef {{s: number, t: number, st: number, rt: number, n: number}} Cursor */
  const cursorKey = (key) => `${CURSOR_PREFIX}${settingOf(key)}`;
  function loadCursor(key) {
    try {
      const raw = sink?.cursor?.(cursorKey(key));
      if (typeof raw !== 'string') return null;
      const p = parseJson(raw);
      if (!p.ok || !isRecord(p.value)) return null;
      const v = p.value;
      const n = (x) => (Number.isFinite(x) && x >= 0 ? x : 0);
      return { s: n(v.s), t: n(v.t), st: n(v.st), rt: n(v.rt), n: n(v.n) };
    } catch { return null; }
  }

  /** 把一个会话的新内容交给 sink。 */
  function processConversation(key, c) {
    let cs = convs.get(key);
    if (!cs) { cs = { cur: loadCursor(key), descHash: null, seenSelf: new Set(), firstPass: true }; convs.set(key, cs); }
    const d = descriptorFor(key);
    const h = JSON.stringify(d);
    if (h !== cs.descHash) { sink.describe(d); cs.descHash = h; stats.describes += 1; }

    const T = timing();
    const cur = cs.cur;
    // 重置：序号比游标小；或者序号不超过游标的别人的消息，时间却比游标里最新的还晚（重置后新会话的序号又涨回来了）
    const reset = !!cur && (c.lastUnreadSeq < cur.s
      || [...c.recent, ...c.unread].some((m) => !m.isSelf && Number.isSafeInteger(m.seq) && m.seq <= cur.s && m.time > cur.t));
    if (reset) { stats.resets += 1; cs.resetAt = io.now(); cs.resetReported = false; log.info('qq.conversation.reset', {}); }
    const byId = new Map();
    for (const m of [...c.recent, ...c.unread]) byId.set(obsIdOf(salt, key, m), m);
    const msgs = [...byId.entries()].sort((a, b) => (a[1].time - b[1].time) || ((a[1].seq ?? 0) - (b[1].seq ?? 0)));
    const ctx = mapCtx(key, byId.values());
    const rtPrev = reset ? 0 : (cur?.rt ?? 0);
    const rt = c.lastReadThroughSeq;
    const liveFrom = startedAt - T.liveGraceMs;
    const hist = [];
    const live = [];
    let newIncoming = 0;
    let freshT = 0;   // 新来的别人的消息里最晚的时间（交不出感知的也算：游标的时间要跟上序号，重置检测靠它）
    for (const [id, m] of msgs) {
      let attention = 'peripheral';
      let fresh = true;
      let opt = {};
      if (m.isSelf) {
        if (cs.seenSelf.has(id)) continue;
        cs.seenSelf.add(id);
        if (cur && m.time <= cur.st - T.selfSlackMs) continue;   // 早就交过
        attention = 'attended';
        // 历史回填的、重启后第一遍里时间不晚于游标的（多半交过）不记数，免得把旧话都算成「未经审视」
        opt = selfOptions(key, m, { count: m.time >= liveFrom && !(cs.firstPass && cur && m.time <= cur.st) });
      } else if (Number.isSafeInteger(m.seq)) {
        fresh = !cur || (reset ? m.time > cur.t : m.seq > cur.s);
        const seen = m.seq <= rt && m.seq > rtPrev;     // 已读水位刚越过它：她看过了
        if (!fresh && !seen) continue;
        if (m.seq <= rt) attention = 'attended';
        if (!fresh) stats.upgrades += 1; else { newIncoming += 1; freshT = Math.max(freshT, m.time); }
      } else {
        fresh = !cur || m.time > cur.t;
        if (!fresh) continue;
      }
      const isHistorical = fresh && m.time < liveFrom;
      const o = toObservation(m, ctx, { attention, historical: isHistorical, ...opt });
      if (!o) continue;
      (isHistorical ? hist : live).push({ o, m, fresh });
    }
    if (cs.seenSelf.size > 2000) cs.seenSelf = new Set([...cs.seenSelf].slice(-1000));

    // 缺口：桥接收到了，但窗口滚掉了，没交上来（插件停机太久）
    if (cur) {
      const expected = reset ? c.lastUnreadSeq : Math.max(0, c.lastUnreadSeq - cur.s);
      const missed = expected - newIncoming;
      if (missed > 0) { stats.gaps += 1; stats.gapMessages += missed; log.warn('qq.gap', { missed }); }
      // 心跳（§13.2）：桥接收到的条数（lastUnreadSeq 的增量，重置时重新对齐）对比交上来的条数
      stats.received += reset ? c.lastUnreadSeq : Math.max(0, c.lastUnreadSeq - cur.n);
      stats.incoming += newIncoming;
    }

    const base = cur && !reset ? cur : { s: 0, t: reset ? cur.t : 0, st: cur?.st ?? 0, rt: 0, n: 0 };
    const advance = (from, list) => {
      const x = { ...from };
      for (const { m, fresh } of list) {
        if (!fresh) continue;
        if (m.isSelf) x.st = Math.max(x.st, m.time);
        else { if (Number.isSafeInteger(m.seq)) x.s = Math.max(x.s, m.seq); x.t = Math.max(x.t, m.time); }
      }
      return x;
    };
    const afterHist = advance(base, hist);
    const final = { ...advance(afterHist, live), rt, n: c.lastUnreadSeq };
    final.t = Math.max(final.t, freshT);
    final.s = Math.max(final.s, c.lastUnreadSeq);   // 窗口外滚掉的也算过去了（上面已记缺口）
    if (!d.attending || !gateOk(d.id)) {
      // 她不在这个房间（不在白名单、主人说别记这里），或者这个场合的总开关是 off：不交内容，游标照走，以后恢复时不补这段
      hist.length = 0;
      live.length = 0;
    }
    const ck = cursorKey(key);
    if (hist.length) {
      // 历史批先交，游标只推进到它为止：后面那批没写进去时，下次从这里接着读
      sink.observe(hist.map((x) => x.o), { historical: true, cursor: { key: ck, value: JSON.stringify(afterHist) } });
      stats.historical += hist.length;
      stats.observed += hist.length;
    }
    const changed = !cur || JSON.stringify(final) !== JSON.stringify(cur);
    if (live.length || changed) {
      sink.observe(live.map((x) => x.o), { cursor: { key: ck, value: JSON.stringify(final) } });
      stats.observed += live.length;
    }
    cs.cur = final;
    cs.firstPass = false;
  }

  function emit() {
    if (!sink || !social) return;
    for (const [key, c] of social.conversations) {
      try { processConversation(key, c); } catch (e) { stats.errors += 1; log.error('qq.process.error', { name: String(e?.name ?? 'Error') }); }
    }
  }

  // ── DSH 绑定 ──
  const toolDecls = qqToolDecls({
    settingOf, keyOf: (sid) => keyBySid.get(sid) ?? null, now: io.now,
    knownKeys: () => [...(social?.conversations.keys() ?? [])],
    principalKey: () => (ownerId() ? canonicalKey(`private:${ownerId()}`) : null),
    scheduledTask,
    prefix: typeof cfg().mcpPrefix === 'string' ? cfg().mcpPrefix : DEFAULT_MCP_PREFIX,
    hostPrefix: typeof cfg().hostPrefix === 'string' ? cfg().hostPrefix : DEFAULT_HOST_PREFIX,
  });
  const declByName = new Map(toolDecls.map((d) => [d.tool, d]));
  const frozen = new Set(toolDecls.filter((d) => d.frozen).map((d) => d.tool));

  /** 消息列表 → attended 的 Observation（来源 E：读消息工具的结果、唤醒快照）。 */
  function attendedFrom(key, list, extra = {}) {
    const msgs = list.map(projectMessage).filter(Boolean);
    if (!msgs.length) return [];
    noteCarriers(key, msgs);
    const ctx = mapCtx(key, [...(social?.conversations.get(key)?.recent ?? []), ...msgs]);
    const out = [];
    for (const m of msgs) {
      // 来源 E 里她自己的行：令牌只看不取、不记数（读文件那条路还会再对一遍）
      const o = toObservation(m, ctx, { attention: 'attended', ...(m.isSelf ? selfOptions(key, m, { consume: false, count: false }) : {}), ...extra });
      if (o) out.push(o);
    }
    return out;
  }

  /**
   * 替主人看别的群（qq_owner_peek_group）的结果 → 感知。桥接的 peekView 只给 {time: ISO 字符串, sender: 她自己是「（我）」, userId, text, hasMedia}，
   * 没有序号、消息 id 和 isSelf：按（时间、说话人、文字）对上那个群在 social-v2 里的消息，用它本来的字段（同一个 ObsId），
   * peek 只多带「她是在主人私聊里知道的」（perceivedInSettingId）和 her-only。对不上的别人的消息不交（拿不到同一个 ObsId，
   * 交了会和读文件那条路记成两条）；她自己的行 ObsId 只看时间和文字，照样交。
   */
  function peekObservations(key, list, extra) {
    const entries = list.filter(isRecord).slice(0, 100).map((m) => {
      const t = typeof m.time === 'string' ? Date.parse(m.time) : Number(m.time);
      if (!Number.isFinite(t) || t <= 0) return null;
      const isSelf = m.sender === '（我）' || m.isSelf === true;
      return { time: t, isSelf, userId: typeof m.userId === 'string' && m.userId ? m.userId : null, text: String(m.text ?? m.plain ?? '') };
    }).filter(Boolean);
    if (!entries.length) return [];
    const lookup = () => {
      const c = social?.conversations.get(key);
      const stored = [...(c?.recent ?? []), ...(c?.unread ?? [])];
      return entries.map((e) => stored.find((m) => m.time === e.time && !!m.isSelf === e.isSelf
        && (e.isSelf || !e.userId || m.userId === e.userId) && (m.plain ?? m.text ?? '') === e.text) ?? null);
    };
    let found = lookup();
    // 内存里的 social-v2 旧了（桥接刚写、防抖还没读）：重读一次再对。只读不交——读文件那条路照常交，同一个 ObsId 只升级注意力；
    // peek 先交的那条记着「是在主人私聊里知道的」
    if (found.some((m, i) => !m && !entries[i].isSelf) && readSocial() === 'ok') found = lookup();
    const msgs = [];
    entries.forEach((e, i) => {
      if (found[i]) msgs.push(found[i]);
      else if (e.isSelf) msgs.push({ isSelf: true, time: e.time, text: e.text.slice(0, 4000), plain: e.text.slice(0, 4000), media: [] });
      else stats.peekUnmatched += 1;
    });
    if (!msgs.length) return [];
    const ctx = mapCtx(key, [...(social?.conversations.get(key)?.recent ?? []), ...msgs]);
    const out = [];
    for (const m of msgs) {
      const o = toObservation(m, ctx, { attention: 'attended', ...(m.isSelf ? selfOptions(key, m, { consume: false, count: false }) : {}), ...extra });
      if (o) out.push(o);
    }
    return out;
  }

  /** @typedef {ReturnType<typeof makeBinding>} QqBinding */
  function makeBinding() {
    return {
      adapterId: ADAPTER_ID,
      /** 会话认领：桥接的会话映射里有它才认（specific）；子代理、委派出来的会话一律不认（F20）。 */
      claimSession(s) {
        try {
          if (!s || typeof s.id !== 'string' || s.origin === 'subagent' || (Number(s.delegationDepth) || 0) > 0) return null;
          if (isRecord(s.header) && (s.header.origin === 'subagent' || s.header.archived === true)) return null;
          const key = sessionsC.get().value?.get(s.id);
          return key ? { settingId: settingOf(key), confidence: 'specific' } : null;
        } catch { return null; }
      },
      sessionSignature() {
        const c = bridgeCfg();
        return {
          cwdPrefixes: [c?.sessionCwd || path.join(bridgeDir, 'state', 'agents')],
          presets: c?.presets?.length ? [...c.presets] : ['qq-chat-v2', 'qq-chat'],
        };
      },
      /**
       * 会话事件：桥接发进来的唤醒消息（user/message，source.kind 'user'）。先查唤醒头（C1），再取尾锚快照，快照里的消息记 attended。
       * 唤醒头不对时返回 []，并在 lastWakeAlarm 里留下原因给宿主停掉这个会话的感知和注入。
       */
      fromSessionEvent(ev, setting, sessionId) {
        try {
          // 宿主在 tools/post-execute 里交来的工具结果（带工具名）；会话日志里的 tool/result 没有工具名，不理
          if (ev?.type === 'tool/result') {
            const dt = ev.data;
            if (!isRecord(dt) || typeof dt.name !== 'string' || dt.isError) return [];
            return binding.fromToolResult({ tool: dt.name, args: dt.arguments, content: dt.content, sessionId, callId: typeof dt.callId === 'string' ? dt.callId : undefined, homeSettingId: setting });
          }
          if (ev?.type !== 'user/message') return [];
          const msg = isRecord(ev.data?.message) ? ev.data.message : ev.data;
          if (msg?.source?.kind !== 'user') return [];
          const text = textOfContent(msg.content);
          const check = wakeCheck(text, settingOf, setting);
          if (!check.ok) { stats.wakeAlarms += 1; binding.lastWakeAlarm = { sessionId, reason: check.reason, at: io.now() }; return []; }
          const snap = extractSnapshot(text);
          if (!snap) return [];
          const sessionRef = Number.isSafeInteger(ev.seq) && ev.seq >= 0 ? { sessionId, seq: ev.seq } : { sessionId };
          const out = attendedFrom(check.key, [...snap.messages, ...snap.recent], { sessionRef });
          stats.snapshotObs += out.length;
          return out;
        } catch (e) { stats.errors += 1; return []; }
      },
      /**
       * 「是哪条消息触发的」：唤醒消息（会话事件，或者宿主直接给的那条 claimed 消息）里快照的最新一条别人的消息；
       * 工具结果（{tool, args, content}）里最新的一条别人的消息。
       */
      resolveFocus(ev) {
        try {
          let list = [];
          let key = null;
          const msg = ev?.type === 'user/message' ? (isRecord(ev.data?.message) ? ev.data.message : ev.data)
            : isRecord(ev) && ev.role === 'user' ? ev : null;
          if (msg) {
            const text = textOfContent(msg?.content);
            const w = scanWake(text);
            if (w.count !== 1) return null;
            key = w.key;
            list = extractSnapshot(text)?.messages ?? [];
          } else if (isRecord(ev) && typeof ev.tool === 'string') {
            key = canonicalKey(ev.args?.key) ?? (ev.homeSettingId ? keyBySid.get(ev.homeSettingId) : null);
            list = messagesInResult(ev.content);
          }
          if (!key) return null;
          const msgs = list.map(projectMessage).filter((m) => m && !m.isSelf);
          const last = msgs.sort((a, b) => a.time - b.time).at(-1);
          return last ? obsIdOf(salt, key, last) : null;
        } catch { return null; }
      },
      /**
       * 唤醒消息带来的感知里哪些是这一轮新来的（D115）：桥接的快照自己分开了两段——messages 是她还没读过的（未读），
       * recent 是已经读过的最近几句（只作上下文）。只有 messages 里别人的消息算新的；【主动机会】、回复检查、潜水到点这类唤醒
       * messages 常常是空的 → []（这一轮是她自己开启的）。不是唤醒消息、没有快照 → null（分不出，宿主按兜底规则）。
       */
      newObsIds(m) {
        try {
          const msg = isRecord(m) && m.type === 'user/message' ? (isRecord(m.data?.message) ? m.data.message : m.data)
            : isRecord(m) && m.role === 'user' ? m : null;
          if (!isRecord(msg) || msg.source?.kind !== 'user') return null;
          const text = textOfContent(msg.content);
          const w = scanWake(text);
          if (w.count !== 1 || !w.key) return null;
          const snap = extractSnapshot(text);
          if (!snap) return null;
          return snap.messages.map(projectMessage).filter((x) => x && !x.isSelf).map((x) => obsIdOf(salt, w.key, x));
        } catch { return null; }
      },
      /**
       * 她用工具看了媒体（D116），看的是哪一条：参数里点明了会话（桥接工具的 key、群号、对方账号）就只在那个会话里找，没点明就是这个会话；
       * 参数里给了消息 id（桥接取消息图片的工具就是这样）就是那一条；没给 id 的，只有主人声明过的看媒体工具（r.declared）才认：
       * 那个会话这一轮她看到的、带能「看」的媒体的别人的消息恰好一条才算（uniqueViewed：视频、语音、文件优先；两条以上分不清 → null）。
       * 结果带图片、参数却点的是别的东西的（收藏表情、头像、搜索候选、合并转发的 id、网址）没有消息 id、也没声明 → null，不往别人的消息里写。
       * @param {{tool: string, args?: any, resultText?: string, declared?: boolean, turn: {homeSettingId: string, media: {obsId: string, settingId: string, at: number, kinds: string[]}[]}}} r
       */
      resolveViewedMedia(r) {
        try {
          const a = isRecord(r?.args) ? r.args : {};
          const id = (v) => (typeof v === 'string' || typeof v === 'number') && /^[A-Za-z0-9_-]{1,64}$/.test(String(v)) ? String(v) : null;
          const g = id(a.groupId ?? a.group_id ?? a.targetGroupId);
          const u = id(a.userId ?? a.user_id);
          const key = canonicalKey(a.key) ?? (g ? canonicalKey(`group:${g}`) : null) ?? (u ? canonicalKey(`private:${u}`) : null)
            ?? (r?.turn?.homeSettingId ? keyBySid.get(r.turn.homeSettingId) ?? null : null);
          if (!key) return null;
          const mid = id(a.messageId ?? a.message_id ?? a.msgId);
          if (mid) return obsIdOf(salt, key, { messageId: mid });
          if (r?.declared !== true) return null;
          return uniqueViewed(r?.turn?.media, settingOf(key));
        } catch { return null; }
      },
      /** C1 检查（宿主在 pre-step 里用）：恰好一个唤醒头、会话和绑定的场合一致。 */
      wakeCheck: (text, settingId) => wakeCheck(String(text ?? ''), settingOf, settingId),
      /**
       * 「重新开始」还是「退役」（§10.5，取舍:504）：两种情况桥接都会发一次【引导唤醒】；
       * 只有主人在这个场合 /reset（social-v2 里这个会话被删掉重建、序号从 0 开始）才算重新开始。每次重置只报一次。
       */
      isRestart(ev) {
        try {
          if (ev?.type !== 'user/message') return false;
          const msg = isRecord(ev.data?.message) ? ev.data.message : ev.data;
          if (msg?.source?.kind !== 'user') return false;
          const text = textOfContent(msg.content);
          if (!text.includes('【引导唤醒】')) return false;
          const w = scanWake(text);
          if (w.count !== 1 || !w.key) return false;
          if (sink) { if (readSocial() === 'ok') emit(); }      // 唤醒可能比防抖读文件先到
          const cs = convs.get(w.key);
          if (!cs?.resetAt || cs.resetReported || io.now() - cs.resetAt > timing().restartWindowMs) return false;
          cs.resetReported = true;
          return true;
        } catch { return false; }
      },
      /**
       * 读消息工具的结果当场提交（来源 E，§10.4「先把工具结果里的消息直接当场 observe()」）。宿主在 tools/post-execute 里调。
       * @param {{tool: string, args?: any, content: unknown, sessionId?: string, callId?: string, homeSettingId?: string}} r
       * @returns {import('rugu-core/contract').Observation[]}
       */
      fromToolResult(r) {
        try {
          const d = declByName.get(r?.tool);
          if (!d?.reader) return [];
          const sessionRef = typeof r.sessionId === 'string' && r.sessionId ? { sessionId: r.sessionId, ...(typeof r.callId === 'string' && r.callId ? { callId: r.callId } : {}) } : undefined;
          const homeKey = r.homeSettingId ? keyBySid.get(r.homeSettingId) ?? null : null;
          let out = [];
          if (d.reader === 'messages') {
            const key = canonicalKey(r.args?.key) ?? homeKey;
            if (key) out = attendedFrom(key, messagesInResult(r.content), { sessionRef });
          } else if (d.reader === 'peek') {
            // 替主人看别的群：事情发生在那个群，她是在主人私聊里知道的；那个群的受众 + 她（§5.3、§11.1）
            const key = canonicalKey(`group:${String(r.args?.targetGroupId ?? '')}`);
            if (key) out = peekObservations(key, messagesInResult(r.content), { sessionRef, visibleTo: 'her-only', perceivedInSettingId: r.homeSettingId });
          } else if (d.reader === 'forward') {
            const key = canonicalKey(r.args?.key) ?? homeKey;
            if (key) out = forwardNodes(key, r.args?.id, messagesInResult(r.content), sessionRef);
          }
          stats.toolObs += out.length;
          return out;
        } catch (e) { stats.errors += 1; return []; }
      },
      /** 这个工具是写桥接自己的记忆、beta 里要拒绝的吗（B13）。 */
      isFrozenTool: (name) => frozen.has(name),
      frozenReason: FROZEN_REASON,
      noteAppraisal,
      tools: toolDecls,
      /** 宿主 Sanitizer 端口按适配器叠加的平台转义（§3.3、评审:UV-03）。 */
      sanitizer: Object.freeze({ forPrompt: escapeForPrompt }),
      lastWakeAlarm: null,
    };
  }
  /**
   * 合并转发的节点：她读到的素材，作者可能是伪造的（authorVerified:false）。
   * 【D118】转发人（relayedBy）是带着这份转发的那条消息的发送人——平台核实过的，主人自己转来的就是主人；按参数里的 id 的指纹在
   * 转发人表里找，内存里的 social-v2 旧了（桥接刚写、防抖还没读）就重读一次再找。找不到的照旧是空的（不知道是谁转的）。
   * 这份转发里套着的转发（nestedForwardIds）也是这个人发来的。
   */
  function forwardNodes(key, fid, nodes, sessionRef) {
    const settingId = settingOf(key);
    const out = [];
    const now = io.now();
    const fk = forwardKey(fid);
    let carrier = fk ? carriers.get(carrierKey(key, fk)) ?? null : null;
    if (fk && !carrier && readSocial() === 'ok') carrier = carriers.get(carrierKey(key, fk)) ?? null;
    if (carrier) {
      stats.forwardRelayKnown += 1;
      for (const n of nodes.slice(0, 100)) {
        if (!isRecord(n) || !Array.isArray(n.nestedForwardIds)) continue;
        for (const nk of n.nestedForwardIds.slice(0, 16).map(forwardKey)) if (nk && !carriers.has(carrierKey(key, nk))) putCarrier(carrierKey(key, nk), carrier);
      }
    } else stats.forwardRelayUnknown += 1;
    const relayedBy = carrier ? relayActorOf(carrier) : { claims: [] };
    const known = knownNames(social?.conversations.get(key)?.recent ?? [], { ownerId: ownerId(), selfId: selfId(), principalLabel: principalLabel(), kind: splitKey(key).kind, selfNames: selfNames() });
    nodes.slice(0, 100).forEach((n, i) => {
      if (!isRecord(n)) return;
      const text = String(n.plain ?? n.text ?? '').slice(0, 2000);
      if (!text.trim()) return;
      const t = Number(n.time);
      const at = Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : now;
      const claimed = typeof n.userId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(n.userId) ? peerActor(n.userId)
        : typeof n.sender === 'string' && n.sender.trim() ? { claims: [{ kind: 'display-name', name: n.sender.trim().slice(0, 60), scope: settingId, observedAt: at }] } : undefined;
      const o = {
        id: opaqueFrom(salt, 'qq/fwd', key, String(fid ?? ''), i, textHash(text)),
        settingId, visibleTo: 'setting-audience', at, perceivedAt: Math.max(now, at),
        actor: { claims: [] }, kind: 'content', text: scrubAccounts(text, known),
        addressed: 'ambient', attention: 'attended', evidential: true, standing: 'material',
        forwarded: { ...(claimed ? { claimedAuthor: claimed } : {}), relayedBy, authorVerified: false },
      };
      if (sessionRef) o.sessionRef = sessionRef;
      out.push(o);
    });
    return out;
  }
  const binding = makeBinding();

  // ── 适配器 ──
  /** @type {any} */
  const adapter = {
    id: ADAPTER_ID,
    protocol: 2,
    /** 管理页上的入口名（D111）。 */
    displayName: 'QQ',
    /** 【D111】管理页用：这里现在为什么可能收不到东西（桥接不是二代模式就旁听不了）。接得上返回 null。 */
    quietReason(id) {
      if (!keyBySid.has(id)) return null;
      return isSecondGen(modeC.get().value?.mode ?? null) ? null : '桥接不是二代模式，QQ 里的消息旁听不到（state/mode.json）';
    },
    /**
     * 首次设置里取消的群（D131）：宿主在开始感知之前按群号拿到场合 id 和描述，把这个场合写成「关」。
     * @param {string} groupId
     * @returns {{settingId: string, descriptor: () => object}}
     */
    groupSetting(groupId) {
      const key = canonicalKey(`group:${groupId}`);
      if (!key) throw Object.assign(new TypeError('QQ 适配器：群号不对'), { code: 'CONTRACT' });
      return { settingId: settingOf(key), descriptor: () => descriptorFor(key) };
    },
    describeSetting(id) {
      let key = keyBySid.get(id);
      if (!key) { readSocial(); for (const k of sessionsC.get().value?.values() ?? []) settingOf(k); key = keyBySid.get(id); }
      if (!key) throw new Error('QQ 适配器：不认识这个场合');
      return descriptorFor(key);
    },
    /** 能列全成员的只有私聊：她和对方（§4.5 members，§14.2：和假平台一致）。群只知道最近说话的人，返回 null。 */
    async members(id) {
      const key = keyBySid.get(id);
      if (!key) return null;
      const { kind, id: peer } = splitKey(key);
      if (kind !== 'private') return null;
      const me = { self: true, claims: adapter.selfClaims() };
      return [me, peer === ownerId() ? principalActor(peer) : peerActor(peer)];
    },
    start(s) {
      if (watcher) stopWatching();
      sink = s;
      gen += 1;
      startedAt = io.now();
      convs.clear();
      const T = timing();
      watcher = createDebouncedWatch({
        dir: stateDir, name: path.basename(FILES.social), file: FILES.social, io, log,
        quietMs: T.quietMs, maxWaitMs: T.maxWaitMs, pollMs: T.pollMs,
        onChange: () => {
          const r = readSocial();
          if (r === 'ok') { modeC.get(); emit(); }
          return r;
        },
      });
      watcher.start();
      watcher.poke();      // 第一次读也走防抖：不在注册的调用栈里做 IO
      const myGen = gen;
      return () => { if (gen === myGen) stopWatching(); };
    },
    selfClaims() {
      const out = [];
      const id = selfId();
      if (id) out.push({ kind: 'account', namespace: ADAPTER_ID, id, verifiedBy: 'config' });
      for (const name of selfNames()) out.push({ kind: 'display-name', name, observedAt: io.now() });
      return out;
    },
    principalClaims() {
      const id = ownerId();
      return id ? principalActor(id).claims : [];
    },
    /** QQ 的场合都不能挂起（canHold:false），核心不会走到这里；万一走到，只记一笔。 */
    async onHoldDecision(_token, approve) { log.warn('qq.hold.unsupported', { approve: !!approve }); },
    binding,
    noteAppraisal,
    /** 马上读一次（不等防抖）。返回 'ok' | 'parse' | 'busy' | 'missing'。 */
    refresh() {
      const r = readSocial();
      if (r === 'ok') emit();
      return r;
    },
    /** 只有数字（§13.3）。 */
    status() {
      const mode = modeC.get().value?.mode ?? null;
      const w = watcher?.stats() ?? null;
      return {
        mode, listening: isSecondGen(mode), started: !!sink, conversations: social?.conversations.size ?? 0, saltSource,
        gated: typeof deps.gate === 'function',
        watch: w, pendingAppraisals: appraisals.length, ...stats,
        heartbeat: { bridgeReceived: stats.received, observedIncoming: stats.incoming, gapMessages: stats.gapMessages },
      };
    },
    /**
     * 启动自检（§13.2 适配器 QQ 那几项）。每项 {id, level, label}（宿主总览的形状）+ {name, ok, detail}；只有状态，没有内容和账号。
     */
    selfCheck() {
      const items = [];
      const add = (name, ok, okLabel, badLabel, badLevel = 'fail') => items.push({
        id: name, name, ok, level: ok ? 'ok' : badLevel, label: ok ? okLabel : badLabel, ...(ok ? {} : { detail: badLabel }),
      });
      let readable = true;
      try { io.readFile(FILES.social); } catch { readable = false; }
      add('bridge-files', readable, 'QQ：读得到桥接的 social-v2.json', 'QQ：读不到 state/social-v2.json（旁听不可用）');
      const mode = modeC.get().value?.mode ?? null;
      add('bridge-mode', isSecondGen(mode), 'QQ：桥接是二代模式，旁听可用', '桥接不是二代模式：旁听不可用');
      if (readable && readSocial() === 'ok') {
        const clean = !JSON.stringify([...social.conversations.values()]).includes('agentToken');
        add('projection-clean', clean, 'QQ：投影里没有会话令牌', 'QQ：投影里出现了会话令牌字段');
      } else add('projection-clean', false, '', 'social-v2.json 读不出来', 'warn');
      const sess = sessionsC.get();
      add('sessions-map', sess.ok && !sess.missing, 'QQ：读得到桥接的会话映射', 'state/sessions.json 读不出来或结构不对：QQ 会话认领不了', 'warn');
      add('tools-classified', toolDecls.every((t) => t.class), `QQ：桥接工具 ${toolDecls.length} 个全部已分类`, 'QQ：有桥接工具没分类');
      // 平台上的群名（D111）：读不到不算失败——没起名字的群照样用「一个 QQ 群」，主人可以在管理页起名字
      const pn = platformNames.status();
      items.push({ id: 'platform-names', name: 'platform-names', ok: true, level: pn.ok ? 'ok' : 'info',
        label: pn.ok ? `QQ：从 SnowLuma 的缓存里读到 ${pn.groups} 个群的名字（只读，不调 QQ）`
          : pn.reason === 'off' ? 'QQ：没有读平台上的群名（配置关掉了，或不知道 SnowLuma 在哪）：没起名字的群显示成「一个 QQ 群」，可以在管理页起名字'
            : 'QQ：读不到 SnowLuma 缓存里的群名：没起名字的群显示成「一个 QQ 群」，可以在管理页起名字' });
      add('principal', !!ownerId(), 'QQ：知道主人的账号', '不知道主人的账号：主人私聊认不出来', 'warn');
      add('salt', saltSource !== 'local-file', 'QQ：场合 id 的盐来自身份哈希密钥（恢复备份后不变）',
        'QQ：场合 id 的盐只存在本机数据目录，不在备份包里（恢复到别的电脑后场合对不上）', 'warn');
      return items;
    },
  };
  function stopWatching() {
    try { watcher?.stop(); } catch { /* 已停 */ }
    watcher = null;
    sink = null;
  }
  return adapter;
}

/** 取一个内置适配器的 DSH 绑定（adapter.binding）。 */
export const bindingOf = (adapter) => adapter?.binding ?? null;

/** 给宿主 Sanitizer 端口的平台转义（§3.3）：她读到的文字里出现的唤醒头、快照标记这类方括号，进提示词前换掉。 */
export function escapeForPrompt(text) {
  return String(text ?? '').replace(/【/g, '〔').replace(/】/g, '〕');
}

/** 完整工具名（带前缀）是不是写桥接记忆、beta 要拒绝的（B13）。 */
export function isFrozenBridgeMemoryTool(name, prefix = DEFAULT_MCP_PREFIX) {
  return typeof name === 'string' && name.startsWith(prefix) && FROZEN_BARE.includes(name.slice(prefix.length));
}
