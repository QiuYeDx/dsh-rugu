// 计划类场景（§14.3 S1、S2；模块与接口 §4.14「集成」）的小世界：真的 createPersonaMemory（十二个真模块一起跑）+ 假平台
// （随机命名空间、随机语言标签、随机场合属性，FAKE_PLATFORM_SEED 可复现）+ 替身端口（FakeLLM 按 use 给脚本、FakeEmbedding、FakeClock）。
// 这里只造输入（谁在哪儿说了什么、模型这次回什么），不碰任何模块的表；断言读 API 的返回值和库里的结果。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPersonaMemory, validateRecallLayers } from '../../src/index.js';
import { fakePorts, FakeLLM, FakeClock, FakeEmbedding, MINUTE, HOUR, DAY } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { tmpDir, rmDir } from '../helpers.js';

export { MINUTE, HOUR, DAY };
/** 测试里的本地时区（东八区）：「18:00」「04:30」都按它算（D19）。 */
export const TZ_MIN = 480;

/** 本地时间 'YYYY-MM-DDTHH:mm' → UTC 毫秒。 */
export const localMs = (iso) => Date.parse(`${iso}:00+08:00`);
/** UTC 毫秒 → 本地时间 'YYYY-MM-DDTHH:mm'（提炼输出里的绝对时间就是这个格式）。 */
export function localIso(ms) {
  const d = new Date(ms + TZ_MIN * MINUTE);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ── 读提炼提示词（只认格式，不认内容） ─────────────────────────────────────
const promptOf = (req) => req.messages.map((m) => m.content).join('\n');
/** 在场的人的编号：[U1 主人]。 */
export function speakerCode(req, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = promptOf(req).match(new RegExp(`\\[(U\\d+) ${esc}\\]`));
  if (!m) throw new Error(`提示词里没有说话人「${label}」`);
  return m[1];
}
/** 本段某条消息的编号（按原文找）。 */
export function msgCode(req, text) {
  for (const line of promptOf(req).split('\n')) {
    const m = line.match(/^\[(m\d+)\]/);
    if (m && line.includes(text)) return m[1];
  }
  throw new Error(`提示词里没有消息「${text}」`);
}
/** 背景里含这段文字的那一条的编号（k1 / p2…）；没有返回 null。 */
export function bgCode(req, text) {
  const re = /\[([kp]\d+)\] ([^[]*)/g;
  const s = promptOf(req);
  let m;
  while ((m = re.exec(s))) if (m[2].includes(text)) return m[1];
  return null;
}
/** 背景一行的全文（断言用：背景里的计划带着什么状态）。 */
export function bgText(req, code) {
  const m = promptOf(req).match(new RegExp(`\\[${code}\\] ([^[]*)`));
  return m ? m[1].trim() : null;
}
/** 换算相对时间的基准（「消息的本地时间以 … 为准」）。 */
export function baseMs(req) {
  const m = promptOf(req).match(/以 (\S+) 为准/);
  if (!m) throw new Error('提示词里没有时间基准');
  return localMs(m[1]);
}

/** 关口①第二段：每张卡片都按 verdict 判（字符串或 (cardText, i) => 字符串 / 对象）。 */
export function appraiseReply(verdict) {
  return (req) => {
    const cards = promptOf(req).split(/(?=卡片 c\d+)/).filter((p) => /^卡片 c\d+/.test(p));
    return cards.map((card, i) => {
      const v = typeof verdict === 'function' ? verdict(card, i) : verdict;
      return { id: `c${i + 1}`, flow: '…', judgement: '…', reason: '测试', hint: false, ...(typeof v === 'string' ? { verdict: v } : v) };
    });
  };
}

/**
 * @param {string} name
 * @param {{seed?: number, startWorker?: boolean, embedding?: object, config?: object, smallTalk?: string[],
 *          appraise?: Function, followUp?: (line: {tag: string, text: string}) => object|null}} [opt]
 *        followUp：夜间「要不要回头问问」那次调用里每件事怎么回（不给 = 都不问）；smallTalk：只写一句叙述就够的寒暄
 */
export async function makePlansWorld(name, opt = {}) {
  const fp = createFakePlatform(Number.isInteger(opt.seed) ? { seed: opt.seed } : {});
  const clock = new FakeClock(localMs('2026-10-31T18:00'));
  const calls = { appraise: 0, followUp: [], sleep: 0, review: 0, extract: 0 };
  const handlers = { appraise: opt.appraise ?? appraiseReply('share'), followUp: opt.followUp ?? (() => null) };
  // 只有寒暄的段（「在吗」「早呀」）：模型只写一句叙述。别的段没准备脚本就报错（测试漏写脚本会立刻暴露）
  const smallTalk = new Set(opt.smallTalk ?? ['在吗', '早呀', '刚起床', '嗯嗯']);
  /** @type {{when: string, fn: (req: object) => unknown}[]} */
  const extractScripts = [];
  const llm = new FakeLLM({
    fallback: {
      // 提炼：按本段原文挑脚本（任务的先后由优先级定，不能按推入的顺序对号）
      extract: (req) => {
        calls.extract += 1;
        const msgs = promptOf(req).split('\n').map((l) => l.match(/^\[m\d+\]\[[^\]]+\]\[[^\]]+\][^：]*：(.*)$/)?.[1]).filter((x) => x != null);
        const i = extractScripts.findIndex((s) => msgs.some((t) => t.includes(s.when)));
        if (i >= 0) {
          const s = extractScripts[i];
          extractScripts.splice(i, 1);
          return s.fn(req);
        }
        if (msgs.length && msgs.every((t) => smallTalk.has(t))) return [{ type: 'narrative', text: '打了个招呼，没聊别的。' }];
        throw new Error(`没有准备提炼脚本：${msgs.join(' / ')}`);
      },
      // 今天到目前为止（§5.7）：一句话小结
      summary: [{ type: 'summary', text: '和主人聊了几句家常' }],
      appraise: (req) => { calls.appraise += 1; return handlers.appraise(req); },
      // 外发审视（§9.4.2）：放行
      review: () => { calls.review += 1; return [{ verdict: 'speak', reason: '测试' }]; },
      // 夜间整理：只回「回头问问」那一步（§5.5 第 5 条），别的步骤没有输出（各步自己按「没东西」处理）
      sleep: (req) => {
        calls.sleep += 1;
        if (!String(req.system).includes('一直没有下文')) return '';
        const out = [];
        for (const line of promptOf(req).split('\n')) {
          const m = line.match(/^\[(q\d+)\] (.*)$/);
          if (!m) continue;
          calls.followUp.push({ tag: m[1], text: m[2] });
          const r = handlers.followUp({ tag: m[1], text: m[2] });
          if (r) out.push({ type: 'followup', plan: m[1], ...r });
        }
        return out;
      },
    },
  });
  const embedding = opt.embedding ?? new FakeEmbedding();
  const dir = tmpDir(`scn-${name}`);
  // 身份哈希密钥按（场景，种子）固定：场合键和激活噪声（种子含场合键，D33）都由 FAKE_PLATFORM_SEED 决定，失败能复现（§6）
  const key = crypto.createHash('sha256').update(`plans-${name}-${fp.seed}`).digest();
  fs.writeFileSync(path.join(dir, 'persona-memory.key'), `${key.toString('base64')}\n`);
  let pm;
  try {
    // 提炼两次调用之间的间隔（§10.6，默认 5 秒）是按真实时间等的；假时钟不走，场景里同一刻的两段会白等 5 秒，所以关掉
    //（间隔本身由 s01-s02-plans.test.js 的最后一个测试在子进程里管）
    const extract = { minSpacingMs: 0, ...(opt.config?.extract ?? {}) };
    // 回想的截止时间按真实时间算（800 ms / 3 秒）：整套测试并行跑、机器忙的时候有的路会超时，结果就随负载变。
    // 场景要的是「想起了什么」，不是「多快」，所以放宽到不会超时（降级本身由 retrieve 的单测管）
    const rc = opt.config?.recall ?? {};
    const recall = { ...rc, involuntary: { deadlineMs: 20_000, ...(rc.involuntary ?? {}) }, deliberate: { deadlineMs: 20_000, ...(rc.deliberate ?? {}) } };
    pm = await createPersonaMemory({
      dataDir: dir, ports: fakePorts({ clock, llm, embedding }), startWorker: !!opt.startWorker,
      config: { ...(opt.config ?? {}), extract, recall, time: { tzOffsetMin: TZ_MIN, ...(opt.config?.time ?? {}) } },
    });
  } catch (e) { rmDir(dir); throw e; }
  const core = pm._core;
  // 假平台的成员名单和真实适配器一样：一对一就是她和对方（§14.2）
  const adapter = fp.adapter;
  pm.registerAdapter(adapter);

  /** 让 setImmediate 里的入库跑完。 */
  const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  await flush();

  const w = {
    pm, core, clock, llm, fp, dir, calls, handlers, adapter,
    DM: fp.settings.oneOnOne.id,
    flush,
    /** 本段原文里有 when 的那一段提炼时，模型回 fn(req)（用一次）。 */
    onExtract(when, fn) { extractScripts.push({ when, fn }); },
    /** 还没用掉的提炼脚本（断言「该提炼的都提炼了」）。 */
    pendingExtract: () => extractScripts.map((s) => s.when),
    /** 场合键（只给断言读库用）。 */
    keyOf: (where) => core.mods.intake.resolveSetting(core, fp.settings[where].id).key,
    entityOf: (who) => (who === 'her' ? core.store.get('SELECT id FROM entities WHERE is_self = 1').id
      : who === 'principal' ? core.mods.entities.principals(core)[0] : null),
    /** 拨到某个本地时间（只能往后拨）。 */
    at(iso) { clock.set(localMs(iso)); return clock.now(); },
    /**
     * 有人在某个场合说了一句（时间 = 现在）。默认：对她说的、她注意到了；她自己说的是 by-her。
     * @returns {Promise<{obs: object, perceptId: number}>}
     */
    async say(where, who, text, extra = {}) {
      const at = clock.now();
      const o = fp.say(where, who, text, {
        at, perceivedAt: at, addressed: who === 'her' ? 'by-her' : 'to-her', attention: 'attended', ...extra,
      });
      await flush();
      const row = core.store.get('SELECT id FROM percepts WHERE adapter = ? AND ext_key = ?', fp.namespace, core.keys.obsKey(fp.namespace, o.id));
      if (!row) throw new Error(`这条没有入库：${text}`);
      return { obs: o, perceptId: row.id };
    },
    /** 过一会儿（对话空闲到能封口），跑一次 tick 和任务队列（提炼、告诉过谁……）。 */
    async settle(minutes = 25) {
      clock.minutes(minutes);
      const tick = await pm.maintenance.tick({ sleep: false });
      const jobs = await pm.maintenance.runJobs({});
      return { tick, jobs };
    },
    async tick() { return pm.maintenance.tick({ sleep: false }); },
    /** 一次回想（默认：真实的新消息到来、不自主回想）；返回值一律先过契约校验。 */
    async recall(where = 'oneOnOne', o = {}) {
      const s = { settingId: fp.settings[where].id, trigger: o.trigger ?? 'message', ...(o.sessionId ? { sessionId: o.sessionId } : {}) };
      const cfg = core.config.get();
      const mode = o.mode ?? 'involuntary';
      const layers = await pm.recall(s, {
        mode, deadlineMs: mode === 'deliberate' ? cfg.recall.deliberate.deadlineMs : cfg.recall.involuntary.deadlineMs,
        budgetChars: o.budgetChars ?? cfg.context.blockMaxChars,
      });
      const v = validateRecallLayers(layers);
      if (!v.ok) throw new Error(`RecallLayers 不合契约：${JSON.stringify(v.errors)}`);
      return layers;
    },
    rows: (sql, ...a) => core.store.all(sql, ...a),
    row: (sql, ...a) => core.store.get(sql, ...a),
    async close() {
      try { await pm.close(); } finally { rmDir(dir); }
    },
  };
  return w;
}

// ── 「拿快递」的提炼脚本（模型的输出；时间按提示词里的基准换算成绝对时间） ─────────────
/** 提炼提示词静态前缀里【示例一】的计划行（就是「拿快递」这件事；模型照着示例写）。读不到返回 {}。 */
export function examplePlanLine(req) {
  const sys = String(req.system ?? '');
  const part = sys.slice(sys.indexOf('【示例一】'), sys.indexOf('【示例二】') > 0 ? sys.indexOf('【示例二】') : undefined);
  const line = part.split('\n').find((l) => l.startsWith('{"type":"plan"'));
  try { return line ? JSON.parse(line) : {}; } catch { return {}; }
}

/**
 * 「等下去拿快递」：计划（这一次）+ 可选的「晚点问问」意图（形不形成是模型按关系和分量判断的，§5.5 第 1 条）。
 * 字段照提炼提示词里的【示例一】（正是这件事）写：示例的计划行带不带 confidence，模型这行就带不带（不给 confidence 参数时）。
 * @param {{intent?: boolean, msg?: string, confidence?: number, narrative?: string}} [o]  narrative：这一段的叙述（默认她回了一句「拿到跟我说一声」）
 */
export const parcelPlan = ({ intent = true, msg = '去拿快递', confidence, narrative = '傍晚主人说等下要去拿快递，我让他拿到了跟我说一声。' } = {}) => (req) => {
  const U = speakerCode(req, '主人');
  const m = msgCode(req, msg);
  const at = baseMs(req);
  if (confidence == null) confidence = examplePlanLine(req).confidence;
  const lines = [
    { type: 'header', title: '主人要去拿快递', text: `${localIso(at)}，主人说等下去拿快递` },
    { type: 'narrative', text: narrative },
    { type: 'plan', id: 'f1', subjects: [U], agent: U, speaker: U, asserter: U, certainty: 'stated', predicate: '取快递',
      text: '主人10/31傍晚要去拿快递', kind_hint: 'plan', status: 'planned',
      planned_time: { start: localIso(at), end: localIso(at + 3 * HOUR), precision: 'fuzzy' },
      imp: 3, msgRefs: [m], quote: '去拿快递', future_q: ['快递拿了没'], ...(confidence != null ? { confidence } : {}) },
  ];
  if (intent) {
    lines.push({ type: 'intent', about: 'f1', target: U, act: '追问', text: '晚点问问他快递拿到没', origin: 'self-care',
      trigger: { window: { start: localIso(at + HOUR), end: localIso(at + 18 * HOUR) }, cues: [U] }, msgRefs: [m] });
  }
  return lines;
};
/** 「拿到了」：背景里那条计划结案（target 是提示词给它的背景编号）。 */
export const parcelDone = (seen = {}) => (req) => {
  // 认计划那一行（情节的叙述里也有「要去拿快递」，模型指的是计划）
  const target = bgCode(req, '10/31傍晚要去拿快递');
  seen.target = target;
  seen.bg = target ? bgText(req, target) : null;
  if (!target) throw new Error('提炼背景里没有那条计划');
  return [
    { type: 'narrative', text: '晚上主人说快递拿到了。' },
    { type: 'plan_status', target, status: 'done', msgRefs: [msgCode(req, '拿到了')] },
  ];
};
