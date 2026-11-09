// 假平台（§2.2、§14.2）：一个随机命名空间、随机场合属性、随机语言标签的适配器。
// 核心的行为测试都应该在它上面再跑一遍：断言只针对属性组合（「任何人可见 + 私密来源 ⇒ 不说」），
// 永远不针对某个入口。种子可以用环境变量 FAKE_PLATFORM_SEED 固定，失败时测试会把种子打印出来。
//
//   const fp = createFakePlatform({ seed: 42 });
//   pm.registerAdapter(fp.adapter);          // start(sink) 会把 sink 存下来
//   fp.say('smallGroup', 'friend', '我表哥开网约车');   // 造一条 Observation 并经 sink 提交
import { opaqueFrom } from '../../src/contract/ids.js';

/** mulberry32：小而确定的伪随机数。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * @param {{seed?: number, startAt?: number}} [opt]
 */
export function createFakePlatform({ seed, startAt = Date.UTC(2026, 9, 31, 10, 0, 0) } = {}) {
  const envSeed = Number(process.env.FAKE_PLATFORM_SEED);
  const usedSeed = Number.isInteger(seed) ? seed : Number.isInteger(envSeed) && envSeed > 0 ? envSeed : Math.floor(Math.random() * 2 ** 31);
  const rnd = mulberry32(usedSeed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const word = (n, alphabet = ALNUM) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
  const bool = () => rnd() < 0.5;

  // 随机命名空间（也是适配器 id）、随机语言标签（核心应该退回 Unicode 分析器）、随机盐
  const namespace = `${pick([...LOWER])}${word(int(4, 9), LOWER)}`;
  const lang = `x-${word(int(3, 6), LOWER)}`;
  const salt = `salt-${word(16)}`;

  // 人：账号 id 是随机字母数字，SettingId 里永远不含它们（§4.2）
  const account = (verifiedBy = 'platform') => ({ kind: 'account', namespace, id: `u${word(10)}`, verifiedBy });
  const people = {
    her: { actor: { self: true, claims: [account()] } },
    principal: { actor: { claims: [{ ...account('config') }] } },
    friend: { actor: { claims: [account()] } },
    other: { actor: { claims: [account()] } },
    stranger: { actor: { claims: [account()] } },
  };
  people.principal.name = `p${word(3, LOWER)}`;
  for (const k of ['friend', 'other', 'stranger']) people[k].name = `n${word(3, LOWER)}`;

  const sid = (name) => opaqueFrom(salt, 'setting', name);
  const audience = (size, entry, unknownObservers, membersKnown) => ({ size, entry, unknownObservers, membersKnown });
  const caps = () => ({ preSendGate: bool(), canHold: bool() });

  // 五类场合，属性在各自的约束内随机（只依赖属性，不依赖名字）
  const settings = {
    oneOnOne: {
      id: sid('one-on-one'),
      descriptor: {
        label: `和${people.principal.name}的私聊`, stability: 'persistent',
        audience: audience(2, 'closed', false, 'exact'),
        disclosure: { visibleTo: 'participants', persistence: pick(['ephemeral', 'logged']), searchable: false, attributedToHer: true },
        ownership: { owner: people.principal.actor, herRole: word(4, LOWER), herModerates: false, actsOnBehalfOfPrincipal: true },
        capabilities: { preSendGate: true, canHold: bool() }, attending: true,
      },
    },
    smallGroup: {
      id: sid('small-group'),
      descriptor: {
        label: `小群-${word(3, LOWER)}`, stability: 'persistent',
        audience: audience(int(3, 12), pick(['closed', 'invite']), false, pick(['exact', 'recent-speakers'])),
        disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
        ownership: { owner: pick([people.principal.actor, people.friend.actor]), herRole: word(5, LOWER), herModerates: bool(), actsOnBehalfOfPrincipal: false },
        capabilities: caps(), attending: true,
      },
    },
    bigGroup: {
      id: sid('big-group'),
      descriptor: {
        label: `大群-${word(3, LOWER)}`, stability: 'persistent',
        audience: audience(int(50, 500), pick(['invite', 'open']), true, 'recent-speakers'),
        disclosure: { visibleTo: 'members', persistence: 'logged', searchable: bool(), attributedToHer: true },
        ownership: { owner: 'unknown', herRole: word(5, LOWER), herModerates: false, actsOnBehalfOfPrincipal: false },
        capabilities: caps(), attending: true,
      },
    },
    publicSpace: {
      id: sid('public'),
      descriptor: {
        label: `公开区-${word(3, LOWER)}`, stability: pick(['persistent', 'transient']),
        audience: audience('unbounded', 'open', true, 'unknown'),
        disclosure: { visibleTo: 'anyone', persistence: 'public-permanent', searchable: true, attributedToHer: true },
        ownership: { owner: 'platform', herRole: word(4, LOWER), herModerates: bool(), actsOnBehalfOfPrincipal: false },
        capabilities: { preSendGate: true, canHold: true }, attending: true,
      },
    },
    workGroup: {
      id: sid('work-group'),
      descriptor: {
        label: `工作群-${word(3, LOWER)}`, stability: 'persistent',
        audience: audience(int(5, 40), 'closed', false, pick(['exact', 'recent-speakers'])),
        disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
        ownership: { owner: people.other.actor, herRole: word(5, LOWER), herModerates: false, actsOnBehalfOfPrincipal: false },
        norms: { notes: [{ text: '这是工作群，内部事务别外传。', author: people.other.actor }] },
        capabilities: caps(), attending: true,
      },
    },
  };
  for (const s of Object.values(settings)) s.descriptor.id = s.id;

  // 能列全成员（membersKnown 'exact'）的场合的成员名单，存 people 的键（§14.2：结果要和真实适配器一致）。
  // 真实适配器给的名单不会比 audience.size 多出人来：一对一就是她和对方。她和场合的主人一定在，主人、朋友补到人数为止；
  // 在这里亲自说过话的人当然也是成员（obs 时补进来，满了不补）。测试后加的场合（settings 里新增的）第一次用到时按同样的规矩建。
  const memberKeys = new Map();   // SettingId → people 的键
  const accountIds = (actor) => new Set((actor?.claims ?? []).filter((c) => c.kind === 'account').map((c) => `${c.namespace}\u0000${c.id}`));
  const keyOf = (actor) => {
    if (!actor || typeof actor !== 'object') return null;
    const ids = accountIds(actor);
    return Object.keys(people).find((k) => people[k].actor === actor || [...accountIds(people[k].actor)].some((x) => ids.has(x))) ?? null;
  };
  const capOf = (s) => (typeof s.descriptor.audience.size === 'number' ? s.descriptor.audience.size : Infinity);
  function memberList(s) {
    if (s.descriptor.audience.membersKnown !== 'exact') return null;
    if (!memberKeys.has(s.id)) {
      const base = [...new Set(['her', keyOf(s.descriptor.ownership?.owner), 'principal', 'friend'].filter(Boolean))];
      memberKeys.set(s.id, base.slice(0, capOf(s)));
    }
    return memberKeys.get(s.id);
  }
  function join(s, who) {
    const list = memberList(s);
    if (list && !list.includes(who) && list.length < capOf(s)) list.push(who);
  }

  let seq = 0;
  let clock = startAt;
  /** @type {import('../../src/contract/types.js').PerceptionSink|null} */
  let sink = null;
  const holds = [];

  /**
   * 造一条 Observation（不提交）。who 是 people 的键；extra 覆盖任何字段。
   * @param {keyof typeof settings} where
   * @param {keyof typeof people} who
   * @param {string} text
   * @param {Partial<import('../../src/contract/types.js').Observation>} [extra]
   * @returns {import('../../src/contract/types.js').Observation}
   */
  function obs(where, who, text, extra = {}) {
    seq += 1;
    clock += int(5, 90) * 1000;
    const self = who === 'her';
    const visibleTo = settings[where].descriptor.disclosure.visibleTo === 'participants' ? 'participants' : 'setting-audience';
    const o = {
      id: `m-${word(6)}-${seq}`,
      settingId: settings[where].id,
      visibleTo,
      at: clock,
      perceivedAt: clock + int(0, 2000),
      actor: people[who].actor,
      kind: self ? 'self-utterance' : 'utterance',
      text,
      lang,
      addressed: self ? 'by-her' : pick(['to-her', 'ambient', 'ambient']),
      attention: self ? 'attended' : pick(['attended', 'peripheral']),
      evidential: true,
      standing: 'first-hand',
      ...extra,
    };
    // 在场合里亲自说的（不是她私下读到的材料）：说话的人是成员
    if (!self && o.visibleTo !== 'her-only' && people[who]) join(settings[where], who);
    return o;
  }

  /** @type {import('../../src/contract/types.js').PerceptionAdapter} */
  const adapter = {
    id: namespace,
    protocol: 2,
    describeSetting(id) {
      const s = Object.values(settings).find((x) => x.id === id);
      if (!s) throw new Error('fake-platform：没有这个场合');
      return structuredClone(s.descriptor);
    },
    async members(id) {
      const s = Object.values(settings).find((x) => x.id === id);
      const list = s ? memberList(s) : null;
      return list ? list.filter((k) => people[k]).map((k) => people[k].actor) : null;
    },
    start(s) {
      sink = s;
      for (const x of Object.values(settings)) s.describe(structuredClone(x.descriptor));
      return () => { sink = null; };
    },
    selfClaims: () => people.her.actor.claims,
    principalClaims: () => people.principal.actor.claims,
    async onHoldDecision(token, approve) { holds.push({ token, approve }); },
  };

  return {
    seed: usedSeed,
    namespace,
    lang,
    adapter,
    settings,
    people,
    holds,
    obs,
    /** 某个场合现在的成员名单（people 的键；不能列全成员的场合返回 null）。 */
    memberKeys(where) {
      const list = settings[where] ? memberList(settings[where]) : null;
      return list ? [...list] : null;
    },
    /** 造一条并经 sink 提交（适配器要先被注册、start 过）。 */
    say(where, who, text, extra) {
      const o = obs(where, who, text, extra);
      if (!sink) throw new Error('fake-platform：适配器还没 start');
      sink.observe([o]);
      return o;
    },
    get sink() { return sink; },
    now: () => clock,
  };
}
