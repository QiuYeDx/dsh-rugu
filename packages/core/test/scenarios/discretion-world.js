// discretion 牵头场景的集成小镇（§14.3、模块与接口 §4.14「集成」）：真的 createPersonaMemory（十二个真模块一起跑）+ 假平台
// （随机命名空间、随机语言标签、随机场合属性，FAKE_PLATFORM_SEED 可复现）+ 替身端口（FakeLLM 按 use 给脚本、FakeEmbedding、FakeClock）。
// 走完整的路：适配器 observe → maintenance.tick（切分）/ runJobs（提炼）→ recall / resident（关口①）→ appraise（关口②）→ outcome。
// 这里只造输入（谁在哪儿说了什么、模型这次回什么），不写任何模块的表；断言只读 API 的返回值和库里的结果（schema 就是契约）。
// 和自带的假平台不同的两处：能列全成员的场合，成员名单按场合给（说过话的人都在，和主人的私聊只有她和主人）；人带显示名。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPersonaMemory } from '../../src/index.js';
import { opaqueFrom } from '../../src/contract/ids.js';
import { fakePorts, FakeLLM, FakeClock, MINUTE, HOUR, DAY } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { tmpDir, rmDir } from '../helpers.js';

export { MINUTE, HOUR, DAY };

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 场合描述的几种形状（只填属性；名字只是她心里的称呼）。 */
export const SHAPES = {
  oneOnOne: () => ({
    stability: 'persistent', audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
    disclosure: { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: 'unknown', herRole: '朋友', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false }, attending: true,
  }),
  group: (size = 20) => ({
    stability: 'persistent', audience: { size, entry: 'closed', unknownObservers: false, membersKnown: 'recent-speakers' },
    disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: 'unknown', herRole: '普通成员', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false }, attending: true,
  }),
};

/** 提示词里某个显示名对应的编号：[U2 阿明]、[c1] 阿明（…）、[k1] …（文本以 label 开头）。 */
export function codeIn(req, label) {
  const text = req.messages.map((m) => m.content).join('\n');
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`\\[(U\\d+) ${esc}\\]`)) ?? text.match(new RegExp(`\\[([ckp]\\d+)\\] ${esc}`));
  if (!m) throw new Error(`提示词里没有「${label}」`);
  return m[1];
}
/** 提示词里某条消息的编号（按原文找）。 */
export function msgIn(req, text) {
  for (const line of req.messages.map((m) => m.content).join('\n').split('\n')) {
    const m = line.match(/^\[(m\d+)\]/);
    if (m && line.includes(text)) return m[1];
  }
  throw new Error(`提示词里没有消息「${text}」`);
}
/** 一条消息所有的编号（同一句话说了好几遍）。 */
export function msgsIn(req, text) {
  const out = [];
  for (const line of req.messages.map((m) => m.content).join('\n').split('\n')) {
    const m = line.match(/^\[(m\d+)\]/);
    if (m && line.includes(text)) out.push(m[1]);
  }
  return out;
}
/** 提示词里「本段：」之后的原文（背景里出现的同一句话不算）。 */
export function segmentOf(req) {
  const text = req.messages.map((m) => m.content).join('\n');
  const i = text.search(/^本段(（请判断边界）)?：$/m);
  return i >= 0 ? text.slice(i) : '';
}
/** 本段里她自己说的话的编号。 */
export const herLines = (req) => segmentOf(req).split('\n').filter((l) => /^\[m\d+\]\[[^\]]+\]\[我\]/.test(l)).map((l) => l.match(/^\[(m\d+)\]/)[1]);
/** 背景（[k1] / [p1]）里内容对得上的那一条的编号。 */
export function bgCode(req, re) {
  for (const m of req.messages.map((x) => x.content).join('\n').matchAll(/\[([kp]\d+)\] ([^[]*)/g)) if (re.test(m[2])) return m[1];
  return null;
}
/** 提示词里的本地日期（「日期：2026-10-31（周六）」）。 */
export const promptDate = (req) => req.messages[0].content.match(/日期：(\d{4}-\d{2}-\d{2})/)[1];

/** 关口①第二段的回复：给每张卡片一个结论（verdicts 可以是字符串、对象、数组，或 (i, req, 这张卡片的文字) => …）。 */
export function appraiseReply(verdicts) {
  return (req) => {
    const content = req.messages[0].content;
    const n = (content.match(/卡片 c\d+/g) ?? []).length;
    const cards = content.split(/^卡片 c\d+$/m).slice(1);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const v = typeof verdicts === 'function' ? verdicts(i, req, cards[i - 1] ?? '') : Array.isArray(verdicts) ? verdicts[i - 1] : verdicts;
      const o = typeof v === 'string' ? { verdict: v } : v;
      out.push({ id: `c${i}`, flow: '…', judgement: '…', reason: '测试', hint: false, ...o });
    }
    return out;
  };
}

/**
 * 一个小镇：一个假平台（可以再加第二个），真核心。
 * @param {string} name
 * @param {{seed?: number, llm?: FakeLLM, config?: object, embedding?: object}} [opt]
 */
export async function makeTown(name, opt = {}) {
  const fp = createFakePlatform(opt.seed != null ? { seed: opt.seed } : {});
  const clock = new FakeClock(fp.now());
  const llm = opt.llm ?? new FakeLLM();
  const ports = fakePorts({ clock, llm, ...(opt.embedding !== undefined ? { embedding: opt.embedding } : {}) });
  const dir = tmpDir(`scn-discretion-${name}`);
  // 身份哈希密钥按（场景，种子）固定：场合键和激活噪声（种子含场合键，D33）都由 FAKE_PLATFORM_SEED 决定，失败能复现（§6）
  const key = crypto.createHash('sha256').update(`discretion-${name}-${fp.seed}`).digest();
  fs.writeFileSync(path.join(dir, 'persona-memory.key'), `${key.toString('base64')}\n`);
  let pm;
  try {
    // 本地时间固定成东八区（D19），「今天」「第二天」不随跑测试的机器变；替身时钟不走，提炼的调用间隔（真实的 setTimeout）设 0
    const cfg = opt.config ?? {};
    pm = await createPersonaMemory({ dataDir: dir, ports, startWorker: false,
      config: { ...cfg, time: { tzOffsetMin: 480, ...(cfg.time ?? {}) }, extract: { minSpacingMs: 0, ...(cfg.extract ?? {}) } } });
  } catch (e) { rmDir(dir); throw e; }
  const core = pm._core;
  let rnd = (fp.seed >>> 0) || 1;
  const word = (n) => Array.from({ length: n }, () => { rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0; return ALNUM[rnd % ALNUM.length]; }).join('');

  /** 一个平台：假平台本体 + 我们加的场合 / 人（成员名单按场合给）。 */
  function platform(p, salt) {
    const members = new Map();   // SettingId → 人的键
    const adapter = {
      ...p.adapter,
      async members(id) {
        const s = Object.values(p.settings).find((x) => x.id === id);
        if (!s || s.descriptor.audience.membersKnown !== 'exact') return null;
        const keys = members.get(id) ?? ['her', 'principal', 'friend'];
        return keys.map((k) => p.people[k].actor);
      },
    };
    const P = {
      fp: p, adapter, members,
      /** 已有的人加上显示名（适配器给的名片，像真实入口那样）；没有的新建一个（随机账号）。 */
      person(key, name) {
        if (!p.people[key]) p.people[key] = { actor: { claims: [{ kind: 'account', namespace: p.namespace, id: `u${word(10)}`, verifiedBy: 'platform' }] } };
        const person = p.people[key];
        if (name) {
          person.name = name;
          person.actor.claims = [...person.actor.claims.filter((c) => c.kind !== 'display-name'), { kind: 'display-name', name, observedAt: clock.now() }];
        }
        return person;
      },
      /** 加一个场合（形状见 SHAPES）；members 是能列全成员时的人的键。 */
      setting(key, descriptor, memberKeys) {
        const id = opaqueFrom(salt, 'setting', key);
        p.settings[key] = { id, descriptor: { ...descriptor, id, label: descriptor.label ?? key } };
        if (memberKeys) members.set(id, memberKeys);
        p.sink?.describe(structuredClone(p.settings[key].descriptor));
        return p.settings[key];
      },
      /** 某人在某个场合说了一句（时间取小镇的时钟；之后让 intake 把队列落库）。 */
      say(where, who, text, extra = {}) {
        const at = clock.now();
        const s = p.settings[where];
        // 能列全成员的场合：说话的人当然在成员名单里
        if (s.descriptor.audience.membersKnown === 'exact') {
          const list = members.get(s.id) ?? ['her', 'principal', 'friend'];
          if (!list.includes(who)) members.set(s.id, [...list, who]);
        }
        const oneOnOne = s.descriptor.audience.size === 2;
        const o = p.obs(where, who, text, {
          at, perceivedAt: at,
          addressed: who === 'her' ? 'by-her' : oneOnOne ? 'to-her' : 'ambient',
          attention: who === 'her' || oneOnOne ? 'attended' : 'peripheral',
          ...extra,
        });
        p.sink.observe([o]);
        core.mods.intake.drain(core);
        clock.advance(30_000);
        return o;
      },
    };
    return P;
  }

  const A = platform(fp, `salt-a-${fp.seed}`);
  // 假平台自带的成员名单对所有能列全的场合都给同三个人；和主人的私聊只有她和主人
  A.members.set(fp.settings.oneOnOne.id, ['her', 'principal']);
  const platforms = [A];
  pm.registerAdapter(A.adapter);

  const town = {
    fp, A, pm, core, clock, llm, ports, dir, platforms,
    /** 再接一个平台（另一个命名空间：跨平台的同一个人，S19）。 */
    addPlatform(seed) {
      const p2 = createFakePlatform({ seed });
      const B = platform(p2, `salt-b-${seed}`);
      B.members.set(p2.settings.oneOnOne.id, ['her', 'principal']);
      // 两个平台的「她」「主人」各有各的账号（适配器配置里写的）
      pm.registerAdapter(B.adapter);
      platforms.push(B);
      return B;
    },
    sid: (where, P = A) => P.fp.settings[where].id,
    key: (where, P = A) => core.keys.settingKey(P.fp.namespace, P.fp.settings[where].id),
    /** 某个人在库里是哪个实体（按他的账号证据认，入库时 entities.resolveActor 认出的那个）。 */
    entityOf(who, P = A) {
      const pc = P.fp.people[who];
      for (const c of pc.actor.claims) {
        if (c.kind !== 'account') continue;
        const id = core.store.get('SELECT entity_id FROM identity_evidence WHERE id_hash = ?', core.keys.identityHash(c.namespace, c.scope ?? '', c.id))?.entity_id;
        if (id) return id;
      }
      if (who === 'principal') return core.store.get("SELECT id FROM entities WHERE authority = 'principal' ORDER BY id LIMIT 1")?.id ?? null;
      if (who === 'her') return core.store.get('SELECT id FROM entities WHERE is_self = 1')?.id ?? null;
      return null;
    },
    /** 时间往后拨，跑一次白天的维护（切窗口、切分、时间维护、今天到目前为止、嵌入……；不睡觉）。 */
    async tick(ms = 0) {
      if (ms) clock.advance(ms);
      return pm.maintenance.tick({ sleep: false });
    },
    /** 空闲到能封口（> 切分的空闲间隔），切分并跑完排着的提炼任务。 */
    async settle() {
      const gap = (core.config.get().segment.gapMin + 1) * MINUTE;
      const t = await town.tick(gap);
      const r = await pm.maintenance.runJobs({ maxJobs: 50 });
      return { tick: t, jobs: r };
    },
    /** 有人在这儿问了一句，她回想（默认有意回想：被直接问到）。 */
    async ask(where, who, text, o = {}) {
      const P = o.platform ?? A;
      const obs = P.say(where, who, text, o.extra);
      const layers = await pm.recall({ settingId: P.fp.settings[where].id, trigger: 'message', focusObsId: obs.id, ...(o.sessionId ? { sessionId: o.sessionId } : {}) },
        { mode: o.mode ?? 'deliberate', deadlineMs: o.deadlineMs ?? 3000, budgetChars: o.budgetChars ?? 1200, ...(o.query ? { query: o.query } : {}), ...(o.about ? { about: o.about } : {}) });
      return { obs, layers };
    },
    /** 她自己调 memory_recall（有意回想，query / about 是她想到的说法，§8.5）：接着这个场合最新的一条消息。 */
    async recallTool(where, o = {}) {
      const P = o.platform ?? A;
      return pm.recall({ settingId: P.fp.settings[where].id, trigger: 'message', ...(o.sessionId ? { sessionId: o.sessionId } : {}) },
        { mode: 'deliberate', deadlineMs: o.deadlineMs ?? 8000, budgetChars: o.budgetChars ?? 1200, ...(o.query ? { query: o.query } : {}), ...(o.about ? { about: o.about } : {}) });
    },
    /**
     * 常驻区：第一次要（或标脏之后）先给只有核心自我的版本、后台渲染完整的；集成层下一回合再要就是完整的（§10.4 冻结规则）。
     * 这里等后台那一次渲染完再取。
     */
    async resident(where, P = A) {
      const id = P.fp.settings[where].id;
      pm.resident(id);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      return pm.resident(id);
    },
    /** 第二段（use='appraise'）这次调用里看到的全部文字。 */
    appraiseSeen: (from = 0) => llm.callsFor('appraise').slice(from).map((c) => [c.system, ...c.messages.map((m) => m.content)].join('\n')).join('\n'),
    async cleanup() {
      try { await pm.close(); } finally { rmDir(dir); }
    },
  };
  return town;
}
