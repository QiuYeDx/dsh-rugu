// intake 测试共用：测试核心（真库、真迁移、真 lang），intake 调到的别的模块全部换成按契约写的小替身（附录 A 的签名），
// 每次调用都记进 calls，测试据此断言「通知了谁、传了什么」。别的模块此刻正由别人并行实现，这里不依赖它们。
import { createTestCore } from '../fakes/test-core.js';
import { fakePorts } from '../fakes/ports.js';
import { opaqueFrom } from '../../src/contract/ids.js';

export const M = 60_000;
export const H = 60 * M;
export const D = 24 * H;
export const TZ = 480;
/** FakeClock 的默认起点：2026-10-31 10:00 UTC（东八区 18:00，周六） */
export const T0 = Date.UTC(2026, 9, 31, 10, 0, 0);
export const ADAPTER = 'tfake';
export const SELF_ID = 1;
export const PRINCIPAL_ID = 2;

const SALT = 'intake-test-salt';
/** 测试里的 SettingId：适配器自己的盐做的不透明 id（§4.2），里面没有账号。 */
export const sid = (name) => opaqueFrom(SALT, 'setting', name);
export const acct = (id, extra = {}) => ({ kind: 'account', namespace: ADAPTER, id, verifiedBy: 'platform', ...extra });
export const people = {
  her: { self: true, claims: [acct('uherself01')] },
  principal: { claims: [acct('uprinc0001', { verifiedBy: 'config' })] },
  friend: { claims: [acct('ufriend001'), { kind: 'display-name', name: '阿明', observedAt: T0 }] },
  other: { claims: [acct('uother0001'), { kind: 'display-name', name: '小红', observedAt: T0 }] },
  stranger: { claims: [acct('ustrange01')] },
};

/** 场合描述（属性可以覆盖）。 */
export function descriptor(name, over = {}) {
  const base = {
    id: sid(name),
    label: `场合-${name}`,
    stability: 'persistent',
    audience: { size: 8, entry: 'closed', unknownObservers: false, membersKnown: 'recent-speakers' },
    disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: 'unknown', herRole: '成员', herModerates: false, actsOnBehalfOfPrincipal: false },
    capabilities: { preSendGate: true, canHold: false },
    attending: true,
  };
  const d = { ...base, ...over };
  for (const k of ['audience', 'disclosure', 'ownership', 'capabilities']) if (over[k]) d[k] = { ...base[k], ...over[k] };
  return d;
}
export const oneOnOne = (name = 'dm') => descriptor(name, {
  audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
  disclosure: { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true },
  ownership: { owner: people.principal, actsOnBehalfOfPrincipal: true },
});

let seq = 0;
/** 一条 Observation（可覆盖任何字段）。 */
export function obs(settingName, who, text, extra = {}) {
  seq += 1;
  const self = who === 'her';
  const at = extra.at ?? T0;
  return {
    id: `m${seq}x${Math.random().toString(36).slice(2, 7)}`,
    settingId: sid(settingName),
    visibleTo: 'setting-audience',
    at,
    perceivedAt: at,
    actor: people[who],
    kind: self ? 'self-utterance' : 'utterance',
    text,
    addressed: self ? 'by-her' : 'ambient',
    attention: 'attended',
    evidential: true,
    standing: 'first-hand',
    ...extra,
  };
}

/**
 * 替身模块。o.doNotRemember(q) 决定「别记」；o.throwOn 让某个替身抛错（测降级）；
 * o.env 是可以在测试里随时改的环境：tombstoned（彻底删除过的 ext_key 集合）、restoring（整体恢复中）、replay（补回窗口）。
 * @param {{calls: Record<string, any[]>, doNotRemember?: (q: object) => boolean, throwOn?: Set<string>,
 *          env?: {tombstoned?: Set<string>, restoring?: boolean, replay?: object|null}}} o
 */
export function fakeMods(o) {
  const { calls } = o;
  const rec = (name, ret) => (core, ...args) => {
    (calls[name] ??= []).push(args);
    if (o.throwOn?.has(name)) throw Object.assign(new Error(`替身 ${name} 故意出错`), { code: 'FAKE' });
    return typeof ret === 'function' ? ret(...args) : ret;
  };
  // 认人：按账号 id 给固定的实体 id（替身拿到的是原始 ActorRef；真模块存的是哈希）
  const ids = new Map([['uherself01', SELF_ID], ['uprinc0001', PRINCIPAL_ID]]);
  let next = 10;
  const entityOf = (actor) => {
    if (actor?.self) return SELF_ID;
    if (actor?.claims?.some((c) => c.kind === 'principal')) return PRINCIPAL_ID;
    const a = actor?.claims?.find((c) => c.kind === 'account');
    if (!a) return null;
    if (!ids.has(a.id)) ids.set(a.id, next++);
    return ids.get(a.id);
  };
  let presence = 0;
  let ruleVersion = 0;
  let settingEntity = 1000;
  const W = { self: 1, toHer: 1, mentionsHer: 0.9, participating: 0.8, attendedAmbient: 0.6, peripheral: 0.35, contentSkimmed: 0.15, contentOpened: 0.6, selfThought: 0.5 };
  return {
    entities: {
      registerAdapterClaims: rec('entities.registerAdapterClaims'),
      ensureSelf: rec('entities.ensureSelf', SELF_ID),
      resolveActor: rec('entities.resolveActor', (actor) => {
        const entityId = entityOf(actor);
        return { entityId, isSelf: entityId === SELF_ID, isPrincipal: entityId === PRINCIPAL_ID, via: entityId == null ? 'none' : 'identity' };
      }),
      bondOf: rec('entities.bondOf', (id) => ({ closeness: id === PRINCIPAL_ID ? 1 : 0.2, authority: id === PRINCIPAL_ID ? 'principal' : 'none', isSelf: id === SELF_ID })),
      noteMention: rec('entities.noteMention'),
      ensureSettingEntity: rec('entities.ensureSettingEntity', () => ++settingEntity),
      profile: rec('entities.profile', (id) => ({ id, displayName: `人${id}` })),
    },
    dynamics: {
      attentionClass: rec('dynamics.attentionClass', (p, ctx) => {
        let cls;
        if (p.kind === 'self-thought') cls = 'selfThought';
        else if (['self-utterance', 'self-action', 'on-my-behalf'].includes(p.kind) || p.addressed === 'by-her') cls = 'self';
        else if (p.kind === 'content') cls = (ctx.opened ?? p.attention === 'attended') ? 'contentOpened' : 'contentSkimmed';
        else if (p.addressed === 'to-her') cls = 'toHer';
        else if (p.addressed === 'mentions-her') cls = 'mentionsHer';
        else if (p.attention === 'peripheral') cls = 'peripheral';
        else cls = ctx.herSpokeRecently ? 'participating' : 'attendedAmbient';
        return { cls, wAtt: W[cls] };
      }),
      encodingWeight: rec('dynamics.encodingWeight', (f) => f.wAtt * (f.closeness == null ? 1 : 0.8 + 0.7 * f.closeness)),
      addTrace: rec('dynamics.addTrace', { added: true }),
    },
    discretion: {
      recordPresence: rec('discretion.recordPresence', () => ++presence),
      writeSettingRule: rec('discretion.writeSettingRule', () => ({ version: ++ruleVersion, status: 'active' })),
      withdrawSettingRules: rec('discretion.withdrawSettingRules', (key, q) => (q.texts ?? q.keep ?? []).length),
      onSelfUtterance: rec('discretion.onSelfUtterance'),
    },
    admin: {
      doNotRemember: rec('admin.doNotRemember', (q) => (o.doNotRemember ? o.doNotRemember(q) : false)),
      // 契约：返回这批 ext_key 里被彻底删除过的那些（Set）
      tombstonedObs: rec('admin.tombstonedObs', (adapter, keys) => new Set(keys.filter((k) => o.env?.tombstoned?.has(k)))),
      // 契约：新切的窗口继承隐藏，返回带来隐藏的那条引用（没有是 null）
      inheritSuppression: rec('admin.inheritSuppression', null),
    },
    backup: {
      isRestoring: rec('backup.isRestoring', () => !!o.env?.restoring),
      replayWindow: rec('backup.replayWindow', () => o.env?.replay ?? null),
    },
    worker: {
      enqueueEmbed: rec('worker.enqueueEmbed'),
      dropEmbeddings: rec('worker.dropEmbeddings', (refs) => ({ texts: refs.length, vectors: refs.length })),
    },
    retrieve: { onPercepts: rec('retrieve.onPercepts') },
    encode: {
      onPerceptRetracted: rec('encode.onPerceptRetracted'),
      onPerceptEdited: rec('encode.onPerceptEdited'),
    },
  };
}

/** 一个最小的适配器（契约里的 PerceptionAdapter）。describeSetting 从 settings 里找。 */
export function makeAdapter(settings = {}, over = {}) {
  const a = {
    id: ADAPTER,
    protocol: 2,
    sink: null,
    describeCalls: [],
    describeSetting(id) {
      a.describeCalls.push(id);
      const d = Object.values(settings).find((x) => x.id === id);
      if (!d) throw new Error('没有这个场合');
      return structuredClone(d);
    },
    starts: 0,
    start(sink) { a.sink = sink; a.starts += 1; a.stopped = false; return () => { a.sink = null; a.stopped = true; }; },
    selfClaims: () => people.her.claims,
    principalClaims: () => people.principal.claims,
    ...over,
  };
  return a;
}

/**
 * 跑一个测试：建核心（只 init lang 和 intake）、登记适配器（像 api.registerAdapter 那样先放进 core.adapters）、描述场合。
 * @param {(t: {core: any, calls: Record<string, any[]>, adapter: any, ports: any, clock: any, describe: Function, drain: Function, observe: Function,
 *              env: {tombstoned: Set<string>, restoring: boolean, replay: object|null}}) => any} fn
 * @param {{settings?: Record<string, object>, doNotRemember?: Function, throwOn?: Set<string>, config?: object,
 *          ports?: object, register?: boolean, adapter?: object, configHandle?: object}} [opt]
 */
export async function withIntake(fn, opt = {}) {
  const calls = {};
  const env = { tombstoned: new Set(), restoring: false, replay: null };
  const settings = opt.settings ?? { g: descriptor('g') };
  const { core, cleanup, ports } = await createTestCore({
    name: 'intake', init: false, ports: opt.ports ?? fakePorts(),
    // configHandle：要测还不在 defaults.js 里的键时，直接给一个 get() 返回带这些键的快照的句柄
    config: opt.configHandle ?? { time: { tzOffsetMin: TZ }, ...(opt.config ?? {}) },
    mods: fakeMods({ calls, doNotRemember: opt.doNotRemember, throwOn: opt.throwOn, env }),
  });
  const adapter = opt.adapter ?? makeAdapter(settings);
  try {
    await core.mods.lang.init(core);
    core.mods.intake.init(core);
    if (opt.register !== false) {
      core.adapters.set(adapter.id, adapter);
      core.mods.intake.registerAdapter(core, adapter);
      for (const d of Object.values(settings)) core.mods.intake.describe(core, adapter.id, d);
    }
    const t = {
      core, calls, adapter, ports, clock: ports.clock, env,
      describe: (d) => core.mods.intake.describe(core, adapter.id, d),
      observe: (list, o = {}) => core.mods.intake.enqueue(core, adapter.id, list, o),
      drain: () => core.mods.intake.drain(core),
      key: (name) => core.keys.settingKey(adapter.id, sid(name)),
      rows: (where = '1=1', ...p) => core.store.all(`SELECT * FROM percepts WHERE ${where} ORDER BY id`, ...p),
    };
    return await fn(t);
  } finally { await cleanup(); }
}

/** 观察 + 立刻处理。 */
export function ingest(t, list, o) {
  t.observe(list, o);
  return t.drain();
}
