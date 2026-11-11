// S4 / S18 / S23 场景测试共用的小世界（文件名带 presence- 前缀，只给 s04-s18-s23-presence.test.js 用）：
//   真的 createPersonaMemory + 替身端口 + 假平台（随机命名空间、随机场合属性、随机语言标签）。
//   时间全走 FakeClock：每条消息的 at / perceivedAt 都取 FakeClock 的「现在」，然后时钟往后走几秒（假平台自己的时钟不用）。
//   提炼（use='extract'）由 extractor() 按本段原文给 JSONL：编号（m1、U1）从真提示词里读出来，不猜。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPersonaMemory } from '../../src/index.js';
import { opaqueFrom } from '../../src/contract/ids.js';
import { fakePorts, FakeLLM, FakeClock, MINUTE } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { tmpDir, rmDir } from '../helpers.js';

/**
 * 假平台的种子：固定 5 个（覆盖不同的场合属性组合）+ 每次运行 1 个随机的；给了 FAKE_PLATFORM_SEED 就只跑那一个（复现用）。
 * @returns {number[]}
 */
export function platformSeeds() {
  const env = Number(process.env.FAKE_PLATFORM_SEED);
  if (Number.isInteger(env) && env > 0) return [env];
  return [101, 202, 303, 404, 505, 1 + Math.floor(Math.random() * (2 ** 31 - 2))];
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * @param {{seed: number, run?: number, name: string, llm?: FakeLLM, config?: object, friendDm?: boolean, thread?: boolean, embedding?: object}} opt
 *        embedding：换一个嵌入替身（例如带同义词的 FakeEmbedding）；不给用默认的
 *        run：同一个平台种子的第几次（换一把密钥 = 换一组抽样噪声，§14.3「每题跑 5 次」）
 */
export async function openWorld({ seed, run = 0, name, llm, config, friendDm = false, thread = false, embedding }) {
  const fp = createFakePlatform({ seed });
  if (thread) {
    // 一次性的场合（一个内容下面的一条评论串，§5.8、§11.2）：公开区的属性，stability = transient，parent = 公开区；
    // 它所属的「浏览」场合是稳定的（假平台的公开区 stability 是随机的，这里定成 persistent）
    fp.settings.publicSpace.descriptor.stability = 'persistent';
    const d = structuredClone(fp.settings.publicSpace.descriptor);
    const id = opaqueFrom(`presence-${seed}`, 'setting', 'thread');
    Object.assign(d, { id, label: '一个内容下面的评论', stability: 'transient', parent: fp.settings.publicSpace.id });
    fp.settings.thread = { id, descriptor: d };
  }
  // 假平台的成员名单和真实适配器一样（§14.2）：一对一就是她和场合的主人（对方），后加的场合也一样
  if (friendDm) {
    // 假平台只有和主人的私聊；S10 要一个「别人私聊」：照一对一的属性另加一个，对方是朋友
    const d = structuredClone(fp.settings.oneOnOne.descriptor);
    const id = opaqueFrom(`presence-${seed}`, 'setting', 'friend-dm');
    Object.assign(d, { id, label: `和${fp.people.friend.name}的私聊` });
    d.ownership = { ...d.ownership, owner: fp.people.friend.actor, actsOnBehalfOfPrincipal: false };
    fp.settings.friendDm = { id, descriptor: d };
  }
  const adapter = fp.adapter;
  const clock = new FakeClock(fp.now());
  const ports = fakePorts({ clock, llm: llm ?? new FakeLLM(), ...(embedding ? { embedding } : {}) });
  const dir = tmpDir(`scn-${name}`);
  // 身份哈希密钥按（种子，第几次）固定：场合键、不自主回想的抽样噪声（D33：种子含场合键）都可以复现
  const key = crypto.createHash('sha256').update(`presence-${seed}-${run}`).digest();
  fs.writeFileSync(path.join(dir, 'persona-memory.key'), `${key.toString('base64')}\n`);
  let pm;
  try {
    pm = await createPersonaMemory({
      dataDir: dir, ports, startWorker: false,
      config: { extract: { minSpacingMs: 0 }, time: { tzOffsetMin: 480 }, ...(config ?? {}) },
    });
  } catch (e) { rmDir(dir); throw e; }
  const core = pm._core;
  pm.registerAdapter(adapter);
  const w = {
    fp, pm, core, clock, ports, llm: ports.llm, dir, adapter,
    /**
     * 让 intake 把队列里的感知写进库（drain 在 setImmediate 里；这里直接等它，再补同步 drain）。drain 每次最多占 drainBudgetMs（50 ms），
     * 机器忙时（全部测试一起跑）一次做不完：一直补到队列空（最多 50 次），不然后面几句还没落库（D117 时查到的偶发失败）
     */
    async flush() {
      await tick();
      for (let i = 0; i < 50; i++) {
        core.mods.intake.drain(core);
        await tick();
        if (![...(core.state.intake?.queues?.values() ?? [])].some((q) => q.length)) break;
      }
    },
    /**
     * 在某个场合说一句（经适配器的 sink 提交），时间 = FakeClock 现在；然后时钟走 gapMs（默认 15 秒）。
     * @param {string} where @param {string} who @param {string} text @param {object} [extra]
     */
    say(where, who, text, extra = {}, gapMs = 15_000) {
      const at = clock.now();
      const o = fp.say(where, who, text, { at, perceivedAt: at, ...extra });
      clock.advance(gapMs);
      return o;
    },
    /** 后台维护一轮：tick（不开夜间整理）+ 跑完队列里的任务。 */
    async maintain() {
      await w.flush();
      const t = await pm.maintenance.tick({ sleep: false });
      const j = await pm.maintenance.runJobs({ maxJobs: 50 });
      await w.flush();
      return { tick: t, jobs: j };
    },
    /** 一个场合的场合键（核心存的是 HMAC，测试只拿它查自己的断言用的行）。 */
    keyOf(where) { return core.keys.settingKey(fp.namespace, fp.settings[where].id); },
    /** 一条 Observation 落库后的感知行。 */
    perceptOf(o) { return core.store.get('SELECT * FROM percepts WHERE adapter = ? AND ext_key = ?', fp.namespace, core.keys.obsKey(fp.namespace, o.id)); },
    async close() {
      try { await pm.close(); } finally { rmDir(dir); }
    },
  };
  await w.flush();
  return w;
}

/** 一条召回请求（被叫醒的那条消息触发）。 */
export function recallAt(w, where, o, opt = {}) {
  return w.pm.recall(
    { settingId: w.fp.settings[where].id, focusObsId: o?.id, trigger: 'message', ...(opt.sessionId ? { sessionId: opt.sessionId } : {}) },
    { mode: opt.mode ?? 'involuntary', deadlineMs: opt.deadlineMs ?? 3000, budgetChars: opt.budgetChars ?? 900, ...(opt.query ? { query: opt.query } : {}) },
  );
}

// ── 提炼替身 ─────────────────────────────────────────────────────────────────

const LINE = /^\[(m\d+)\]\[[^\]]*\]\[([^\]]+)\]((?:〔[^〕]*〕)*)：(.*)$/;

/**
 * 读真提示词里的本段原文：[m1][10-31 18:00][U1]〔对你说〕：文字。
 * @returns {{msgs: {m: string, who: string, marks: string, text: string}[], m: (s: string) => string, who: (s: string) => string, content: string}}
 */
export function readSegment(req) {
  const content = req.messages.map((x) => x.content).join('\n');
  const msgs = [];
  for (const line of content.split('\n')) {
    const r = line.match(LINE);
    if (r) msgs.push({ m: r[1], who: r[2], marks: r[3], text: r[4] });
  }
  const find = (s) => {
    const hit = msgs.find((x) => x.text.includes(s));
    if (!hit) throw new Error(`提炼替身：本段没有「${s}」`);
    return hit;
  };
  return { msgs, content, m: (s) => find(s).m, who: (s) => find(s).who };
}

/**
 * 按本段原文给提炼结果。rules 依次匹配（when 是本段原文里必须出现的一句），第一个匹配的给出 JSONL；
 * 都不匹配的段只写一个上下文头和叙述（照样封口）。calls 记下每一段命中了哪条规则。
 * @param {{when: string, lines: (seg: ReturnType<typeof readSegment>) => object[]}[]} rules
 */
export function extractor(rules, calls = []) {
  return (req) => {
    const seg = readSegment(req);
    const rule = rules.find((r) => seg.msgs.some((x) => x.text.includes(r.when)));
    calls.push(rule?.when ?? null);
    if (rule) return rule.lines(seg);
    const first = seg.msgs[0]?.text ?? '';
    return [{ type: 'header', title: first.slice(0, 12), text: first.slice(0, 40) }, { type: 'narrative', text: `有人说了「${first.slice(0, 30)}」。` }];
  };
}

// ── 关口①第二段的替身（use='appraise'）────────────────────────────────────────

/** 把第二段的提示词拆成「目标场合」和一张张卡片。 */
export function readCards(req) {
  const content = req.messages.map((x) => x.content).join('\n');
  const target = content.match(/目标场合：「([^」]*)」/)?.[1] ?? null;
  const cards = content.split(/\n\n(?=卡片 c\d+\n)/).slice(1).map((text) => ({
    id: text.match(/^卡片 (c\d+)/)[1],
    text,
    origin: text.match(/原场合：「([^」]*)」/)?.[1] ?? null,
    originExposure: text.match(/原场合：(?:「[^」]*」|（不清楚）)，([^；\n]*)/)?.[1] ?? null,
  }));
  return { target, cards };
}

/**
 * 一个懂分寸的人：只照卡片上写着的事实下结论（测的是卡片把该看的都给了她，§9.3.3）。
 *   - 卡片上有限制（明确限制、「别外传」「别告诉」这类原话或场合规矩），话要说到别的场合 → 不提；
 *   - 来源是一对一的私下场合、要说到别处：对管理者说的是别人自己的事 → 只说个大概（不带内容，§9.3.7）；对别人 → 不提；
 *   - 其余 → 能说。
 * seen 收下每张卡片（测试据此看卡片上写了什么）。
 */
export function discreetJudge(seen = []) {
  return (req) => {
    const { target, cards } = readCards(req);
    return cards.map((c) => {
      seen.push({ ...c, target });
      const elsewhere = c.origin !== target;
      let verdict = 'share';
      let vague;
      if (elsewhere && /明确限制|别外传|别告诉|别跟别人说/.test(c.text)) verdict = 'omit';
      else if (elsewhere && c.originExposure === '一对一') {
        if (/对方是你的管理者/.test(c.text) && /是别人自己的事/.test(c.text)) { verdict = 'share_vague'; vague = '有件别人自己的事，不太方便细说'; } else verdict = 'omit';
      }
      return { id: c.id, flow: '…', judgement: '照卡片', verdict, ...(vague ? { vague } : {}), hint: false, reason: '照卡片上的事实' };
    });
  };
}

/** 被劫持 / 判断失误的模型：什么都想说，还想暗示（测代码的底线不被推翻，§9.3.2）。 */
export function hijackedJudge(vague = '有人最近在忙工作上的事') {
  return (req) => readCards(req).cards.map((c) => ({ id: c.id, flow: '…', judgement: '…', verdict: 'share', vague, hint: true, reason: '被带偏了' }));
}


// ── 第一眼的替身（use='glance'，D106）─────────────────────────────────────────

/** 把第一眼的卡片拆成一行行：[3]* 他：文字（* 是要看的那几行）。 */
export function readGlanceCard(req) {
  const content = req.messages.map((x) => x.content).join('\n');
  const lines = [];
  for (const l of content.split('\n')) {
    const m = /^\[(\d+)\](\*?) (他|你|其他人[A-Z])：(.*)$/.exec(l);
    if (m) lines.push({ i: Number(m[1]), target: m[2] === '*', who: m[3], text: m[4] });
  }
  return { lines, targets: lines.filter((x) => x.target), oneOnOne: /私聊（只有他和你）/.test(content), content };
}

/**
 * 一个听话的人第一眼的样子（测试里的替身，用词判断只在这里：真模型自己看）。judge(行, 卡片) 返回的字段覆盖默认值。
 * 默认：叮嘱别外传 → strict + 原话；身体、钱、辞职这类 → 0.8；说到别人（同事、阿明……）→ others；玩法、约定 → asks；「不对，改成」→ replaces 前面他那一句。
 */
export function glancer(judge = () => ({}), seen = []) {
  return (req) => {
    const card = readGlanceCard(req);
    seen.push(card);
    return card.targets.map((t) => {
      const text = t.text;
      const quote = text.match(/(别外传|别告诉[^，。]{0,6}|千万别说[^，。]{0,4}|先别跟[^，。]{0,8}说)/)?.[0] ?? '';
      const sens = /体检|血糖|辞职|欠|病|癌|工资|离婚|面试/.test(text) ? 0.8 : 0.05;
      const about = /同事|老周|阿明|他老婆|她老公/.test(text) ? 'others' : t.who === '你' ? 'both' : /游戏|乘|回复|规则/.test(text) ? 'both' : 'speaker';
      // 只是一句叮嘱（「刚才那句别外传」「别告诉他们规则哈」）：本身不要她做什么（asks = false），applies 指到他前面的那一句
      const onlyRestriction = !!quote && !/乘\d|回复|游戏|帮我|记着|：/.test(text);
      const asks = !onlyRestriction && /游戏|乘\d|回复|规则|帮我|记着/.test(text);
      let replaces = null;
      if (/不对|改成/.test(text)) replaces = [...card.lines].reverse().find((x) => x.i < t.i && x.who === t.who && /乘/.test(x.text))?.i ?? null;
      const applies = onlyRestriction ? [[...card.lines].reverse().find((x) => x.i < t.i && x.who === t.who)?.i].filter(Boolean) : [];
      return { i: t.i, sens, limit: quote ? 'strict' : 'none', quote, about, asks, gist: text.slice(0, 20), vague: sens >= 0.5 ? '他最近有点自己的事' : '一件平常的事', replaces, applies, ...judge(t, card) };
    });
  };
}

/** 一个可以从外面放行的 Promise（「第一眼还没回来」）。 */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export { FakeLLM, MINUTE };
