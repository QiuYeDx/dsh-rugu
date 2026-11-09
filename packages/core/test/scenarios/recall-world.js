// 回想 / 备份类场景的集成小世界（§14.3 S7、S15、S24、S31；模块与接口 §4.14「集成」）：
// 真的 createPersonaMemory（十二个真模块一起跑，startWorker:false 时引擎在主线程里跑，结果和线程一样）+ 假平台
// （随机命名空间、随机语言标签、随机场合属性，FAKE_PLATFORM_SEED 可复现）+ 替身端口（FakeLLM 按 use 给脚本、FakeEmbedding、FakeClock）。
// 这里只造输入（谁在哪儿说了什么、提炼模型这次回什么），不碰任何模块的表；断言只读 API 的返回值和库里的结果。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPersonaMemory } from '../../src/index.js';
import { fakePorts, FakeLLM, FakeClock, MINUTE, HOUR, DAY } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { tmpDir, rmDir } from '../helpers.js';

export { MINUTE, HOUR, DAY };

/** 深合并（配置）。 */
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
}

// 闲聊的素材：和场景里要找的那几件事不沾边（不出现快递、包裹、表哥这些词）
const TOPICS = ['今天的天气', '那个新出的游戏', '晚饭吃什么', '周末的比赛', '新买的耳机', '公司楼下的咖啡', '昨晚的电影', '小区里的猫',
  '地铁又晚点', '这次的版本更新', '健身房的人', '早上的会议', '新开的面馆', '手机电池', '下周的考试', '楼上在装修'];
const VERBS = ['真的不错', '有点离谱', '还行吧', '我觉得一般', '笑死我了', '谁懂啊', '太难了', '下次再说', '可以试试', '别提了'];
/** n 条确定的闲聊（同一个种子同样的内容）。 */
export function fillerTexts(n, seed = 1) {
  let r = (seed >>> 0) || 1;
  const next = () => { r = (Math.imul(r, 1103515245) + 12345) >>> 0; return r; };
  return Array.from({ length: n }, (_, i) => `${TOPICS[next() % TOPICS.length]}${VERBS[next() % VERBS.length]}，第${i % 97}回`);
}

/** 提炼提示词里的消息行：[m1][10-31 18:00][U1]〔对你说〕：文字 */
export function parsePrompt(req) {
  const text = req.messages.map((m) => m.content).join('\n');
  const msgs = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\[(m\d+)\]\[([^\]]+)\]\[([^\]]+)\]([^：]*)：(.*)$/);
    if (m) msgs.push({ code: m[1], stamp: m[2], who: m[3], marks: m[4], text: m[5] });
  }
  const historical = text.includes('这是回填的旧记录');
  const date = text.match(/日期：(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  return { text, msgs, historical, date };
}

/** 关口①第二段的回复：每张卡片一个结论（verdict 可以是字符串、对象，或 (cardText, i) => …）。 */
export function appraiseReply(verdict) {
  return (req) => {
    const content = req.messages[0].content;
    const parts = content.split(/(?=卡片 c\d+)/);
    const cards = parts.filter((p) => /^卡片 c\d+/.test(p));
    return cards.map((card, i) => {
      const v = typeof verdict === 'function' ? verdict(card, i) : verdict;
      const o = typeof v === 'string' ? { verdict: v } : v;
      return { id: `c${i + 1}`, flow: '…', judgement: '…', reason: '测试', hint: false, ...o };
    });
  };
}

/**
 * 一个小世界：一个假平台，真核心。
 * @param {string} name
 * @param {{seed?: number, embedding?: object|null, rerank?: object|null, config?: object, extract?: (req: object, p: ReturnType<typeof parsePrompt>) => object[],
 *          appraise?: Function, dataDir?: string}} [opt]
 */
export async function makeWorld(name, opt = {}) {
  const fp = createFakePlatform(opt.seed != null ? { seed: opt.seed } : {});
  const clock = new FakeClock(fp.now());
  const handlers = { extract: opt.extract ?? (() => []), appraise: opt.appraise ?? appraiseReply('share') };
  const llm = new FakeLLM({
    fallback: {
      extract: (req) => {
        const p = parsePrompt(req);
        const lines = handlers.extract(req, p) ?? [];
        return lines.length ? lines : [{ type: 'narrative', text: '大家随便聊了几句。' }];
      },
      appraise: (req) => handlers.appraise(req),
      review: [{ verdict: 'speak', reason: '测试' }],
      summary: '和大家聊了几句。',
      rewrite: [],
      sleep: [],
    },
  });
  const ports = fakePorts({ clock, llm, ...(opt.embedding !== undefined ? { embedding: opt.embedding } : {}), ...(opt.rerank !== undefined ? { rerank: opt.rerank } : {}) });
  const dir = opt.dataDir ?? tmpDir(`scn-recall-${name}`);
  // 新建的数据目录：身份哈希密钥按（场景，种子）固定，场合键和激活噪声都由 FAKE_PLATFORM_SEED 决定，失败能复现（§6）
  const keyFile = path.join(dir, 'persona-memory.key');
  if (!opt.dataDir && !fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, `${crypto.createHash('sha256').update(`recall-${name}-${fp.seed}`).digest().toString('base64')}\n`);
  }
  // 时区固定（渲染出来的绝对时间可断言）；FakeEmbedding 不懂查询指令（真实的指令模型理解指令而不是去匹配它），关掉指令模拟这一点。
  // 测试里墙上时间几乎不走（FakeClock 一拨就是几天）：词频统计的缓存按墙上时间过期，不关掉的话整场测试都用第一次查到的行数；
  // 提炼调用之间的最小间隔按假时钟算，同一批任务连着跑会真的睡 5 秒。两者都关掉，模拟真实使用里事件之间隔着几分钟、几小时
  const base = { time: { tzOffsetMin: 480 }, recall: { queryInstruct: '' }, worker: { countTtlMs: 0, termStatsTtlMs: 0 }, extract: { minSpacingMs: 0 } };
  const config = merge(base, opt.config ?? {});
  let pm;
  try {
    pm = await createPersonaMemory({ dataDir: dir, ports, startWorker: false, config });
  } catch (e) { rmDir(dir); throw e; }
  const core = pm._core;

  // 群友带上名片（像真实入口那样）；她和主人用适配器配置里的账号
  for (const k of ['friend', 'other', 'stranger']) {
    const p = fp.people[k];
    p.actor.claims = [...p.actor.claims, { kind: 'display-name', name: p.name, observedAt: clock.now() }];
  }
  // 数一数适配器 start() 了几次（恢复后要重启一次，从恢复出来的游标重读）
  let starts = 0;
  const realStart = fp.adapter.start;
  fp.adapter.start = (sink) => { starts += 1; return realStart(sink); };
  pm.registerAdapter(fp.adapter);

  const world = {
    fp, pm, core, clock, llm, ports, dir, handlers,
    get starts() { return starts; },
    sid: (where) => fp.settings[where].id,
    key: (where) => core.keys.settingKey(fp.namespace, fp.settings[where].id),
    /** 某个人在库里是哪个实体（按入库时 entities.resolveActor 认出的账号证据）。 */
    entityOf(who) {
      if (who === 'her') return core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null;
      if (who === 'principal') return core.store.get("SELECT id FROM entities WHERE authority = 'principal' ORDER BY id LIMIT 1")?.id ?? null;
      for (const c of fp.people[who].actor.claims) {
        if (c.kind !== 'account') continue;
        const id = core.store.get('SELECT entity_id FROM identity_evidence WHERE id_hash = ?', core.keys.identityHash(c.namespace, c.scope ?? '', c.id))?.entity_id;
        if (id) return id;
      }
      return null;
    },
    /** 造一条消息（时间取世界的时钟），不提交。 */
    obs(where, who, text, extra = {}) {
      const at = clock.now();
      const oneOnOne = fp.settings[where].descriptor.audience.size === 2;
      return fp.obs(where, who, text, {
        at, perceivedAt: at,
        addressed: who === 'her' ? 'by-her' : oneOnOne ? 'to-her' : 'ambient',
        attention: who === 'her' || oneOnOne ? 'attended' : 'peripheral',
        ...extra,
      });
    },
    /** 提交一批（可带游标），让 intake 落库。 */
    deliver(list, opt2) {
      fp.sink.observe(list, opt2);
      core.mods.intake.drain(core);
    },
    /** 某人在某个场合说了一句：落库，时钟往后拨 30 秒。 */
    say(where, who, text, extra = {}, cursor = null) {
      const o = world.obs(where, who, text, extra);
      world.deliver([o], cursor ? { cursor } : undefined);
      clock.advance(30_000);
      return o;
    },
    /** 白天的维护（切窗口、切分、时间维护、今天到目前为止、嵌入一小批……；不睡觉）。 */
    async tick(ms = 0) {
      if (ms) clock.advance(ms);
      return pm.maintenance.tick({ sleep: false });
    },
    /** 空闲到能封口（> 切分的空闲间隔），切分并跑完排着的提炼任务，再把嵌入队列跑空。 */
    async settle() {
      const gap = (core.config.get().segment.gapMin + 1) * MINUTE;
      const t = await world.tick(gap);
      const jobs = await pm.maintenance.runJobs({ maxJobs: 50 });
      clock.advance(10_000);
      await world.embedAll();
      return { tick: t, jobs };
    },
    /** 嵌入队列跑空（tick 每次只跑一批；剩下的像夜里那样一轮跑完）。返回还没嵌的条数。 */
    async embedAll() {
      await pm.maintenance.tick({ sleep: false });
      await core.mods.worker.runEmbedQueue(core, {});
      return core.store.get("SELECT count(*) AS n FROM embed_texts WHERE status IN ('pending','stale')").n;
    },
    /** 一大段不相干的闲聊（让库有真实的规模：词频的「常见词」、各路名次才有意义）。 */
    chatter(where, n, { who = ['stranger', 'other'], batch = 50 } = {}) {
      const texts = fillerTexts(n, fp.seed);
      for (let i = 0; i < n; i += batch) {
        const list = texts.slice(i, i + batch).map((text, j) => {
          clock.advance(20_000);
          return world.obs(where, who[(i + j) % who.length], text, { addressed: 'ambient', attention: 'peripheral' });
        });
        world.deliver(list);
      }
    },
    /** 有人在这儿问了一句，她回想（默认有意回想：被直接问到）。 */
    async ask(where, who, text, o = {}) {
      const obs = world.say(where, who, text, o.extra);
      const layers = await pm.recall({ settingId: fp.settings[where].id, trigger: 'message', focusObsId: obs.id },
        { mode: o.mode ?? 'deliberate', deadlineMs: o.deadlineMs ?? 3000, budgetChars: o.budgetChars ?? 1200, ...(o.query ? { query: o.query } : {}) });
      return { obs, layers };
    },
    /** 同一个场合的回想，但直接看 retrieve 的候选（各路名次、P），不过关口①。 */
    async candidates(where, mode = 'deliberate', extra = {}) {
      return core.mods.retrieve.recall(core, { settingKey: world.key(where), trigger: 'simulate' }, { mode, deadlineMs: 3000, ...extra });
    },
    async close() { await pm.close(); },
    async cleanup() {
      try { await pm.close(); } finally { if (!opt.dataDir) rmDir(dir); }
    },
  };
  return world;
}
