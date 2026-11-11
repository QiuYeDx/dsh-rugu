// 契约校验（手写，无依赖）。适配器交进来的每样东西都先过这里（§7.1 第 1 步）。
// 每个 validateX(v) 返回 {ok, value, errors}：
//   - value 是只含已知字段的新对象（未知字段一律丢掉，适配器夹带不进来），可选字段按契约补默认值；
//   - errors 是 [{path, message}]，ok=false 时 value 为 null。
// assertX(v) 校验不过就抛 ContractError。
// 校验只管「形状和自洽」，不做判断（能不能说、可不可信都不在这里）。
import {
  CLAIM_KINDS, VERIFIED_BY, VISIBLE_TO, OBSERVATION_KINDS, SELF_KINDS, TARGET_KINDS, ADDRESSED, ATTENTION, STANDING,
  STABILITY, LABEL_KIND, LABEL_ORIGIN, AUDIENCE_ENTRY, MEMBERS_KNOWN, DISCLOSURE_VISIBLE_TO, PERSISTENCE, CHANNEL_PERSISTENCE, UTTERANCE_PATHS,
  APPRAISAL_VERDICTS, SITUATION_TRIGGERS, RECALL_MODES, LAYERS, SPEAK_LEVELS, WORKING_UNITS, ITEM_VERDICTS, NOTE_OPS, FIX_OPS, RESTRICTIONS, PROTOCOL,
} from './enums.js';
import { isOpaqueId, MAX_ID_LENGTH } from './ids.js';
import { ContractError } from './errors.js';

/** 长度和数量上限。超了算不合契约：适配器应该自己截断并标 textTruncated。 */
export const LIMITS = Object.freeze({
  textMax: 32_768,          // Observation.text
  shortMax: 2_000,          // 各种短字符串（名字、摘要、角色……）
  labelMax: 200,
  hintMax: 24,
  settingNameMax: 40,       // 【D111】主人在管理页给场合起的名字（按字符数，不按 UTF-16 码元）
  noteTextMax: 4_000,       // 场合规矩一条
  utterancePartMax: 8_000,
  utterancePartsMax: 16,
  claimsMax: 32,
  listMax: 64,              // mentions、media、notes、notifies、egress……
  importBatchMax: 5_000,
  deadlineMaxMs: 60_000,
});
const MAX_TIME = 8.64e15;   // Date 能表示的最大毫秒数
const ADAPTER_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

// ── 小工具 ────────────────────────────────────────────────────────────────
class Ctx {
  constructor() { /** @type {{path:string, message:string}[]} */ this.errors = []; }
  err(path, message) { this.errors.push({ path, message }); return undefined; }
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = (v) => v === undefined || v === null;

function str(c, v, path, { required = false, max = LIMITS.shortMax, allowEmpty = true } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (typeof v !== 'string') return c.err(path, '应为字符串');
  if (!allowEmpty && v.length === 0) return c.err(path, '不能为空');
  if (v.length > max) return c.err(path, `超过 ${max} 字符`);
  return v;
}
function id(c, v, path, { required = false } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (!isOpaqueId(v)) return c.err(path, `应为非空、≤ ${MAX_ID_LENGTH} 字符、无控制字符的不透明 id`);
  return v;
}
function bool(c, v, path, { required = false } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (typeof v !== 'boolean') return c.err(path, '应为布尔值');
  return v;
}
function num(c, v, path, { required = false, min = -Infinity, max = Infinity, int = false } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return c.err(path, '应为有限数字');
  if (int && !Number.isInteger(v)) return c.err(path, '应为整数');
  if (v < min || v > max) return c.err(path, `应在 ${min}–${max} 之间`);
  return v;
}
const time = (c, v, path, opt = {}) => num(c, v, path, { ...opt, min: 0, max: MAX_TIME });
function oneOf(c, v, list, path, { required = false } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (!list.includes(v)) return c.err(path, `应为 ${list.join(' / ')} 之一`);
  return v;
}
function arr(c, v, path, item, { required = false, max = LIMITS.listMax, min = 0 } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (!Array.isArray(v)) return c.err(path, '应为数组');
  if (v.length > max) return c.err(path, `最多 ${max} 项`);
  if (v.length < min) return c.err(path, `至少 ${min} 项`);
  const out = [];
  v.forEach((x, i) => { const r = item(c, x, `${path}[${i}]`); if (r !== undefined) out.push(r); });
  return out;
}
function obj(c, v, path, { required = false } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (!isObj(v)) return c.err(path, '应为对象');
  return v;
}
/** 去掉值为 undefined 的键，结果冻结（深冻结由调用方决定）。 */
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
function result(c, value) {
  return c.errors.length ? { ok: false, value: null, errors: c.errors } : { ok: true, value, errors: [] };
}
function asserter(what, fn) {
  return (v) => {
    const r = fn(v);
    if (!r.ok) throw new ContractError(what, r.errors);
    return r.value;
  };
}

// ── §4.2 身份 ─────────────────────────────────────────────────────────────
function claim(c, v, path) {
  if (!obj(c, v, path, { required: true })) return undefined;
  const kind = oneOf(c, v.kind, CLAIM_KINDS, `${path}.kind`, { required: true });
  switch (kind) {
    case 'account': return clean({
      kind,
      namespace: str(c, v.namespace, `${path}.namespace`, { required: true, allowEmpty: false, max: 64 }),
      id: id(c, v.id, `${path}.id`, { required: true }),
      scope: id(c, v.scope, `${path}.scope`),
      verifiedBy: oneOf(c, v.verifiedBy, VERIFIED_BY, `${path}.verifiedBy`, { required: true }),
      displayName: str(c, v.displayName, `${path}.displayName`, { max: LIMITS.labelMax }),
    });
    case 'display-name': return clean({
      kind,
      name: str(c, v.name, `${path}.name`, { required: true, allowEmpty: false, max: LIMITS.labelMax }),
      scope: id(c, v.scope, `${path}.scope`),
      observedAt: time(c, v.observedAt, `${path}.observedAt`, { required: true }),
    });
    case 'self-introduction': return clean({
      kind,
      text: str(c, v.text, `${path}.text`, { required: true, allowEmpty: false }),
      obs: id(c, v.obs, `${path}.obs`, { required: true }),
    });
    case 'role-in-setting': return clean({
      kind,
      setting: id(c, v.setting, `${path}.setting`, { required: true }),
      role: str(c, v.role, `${path}.role`, { required: true, max: LIMITS.labelMax }),
      moderates: bool(c, v.moderates, `${path}.moderates`),
      isOwner: bool(c, v.isOwner, `${path}.isOwner`),
    });
    case 'principal':
      if (v.strength !== 'config') c.err(`${path}.strength`, "principal 只能来自配置，strength 必须是 'config'");
      return { kind, strength: 'config' };
    default: return undefined;
  }
}
function actor(c, v, path, { required = true } = {}) {
  if (!obj(c, v, path, { required })) return undefined;
  if (v.self !== undefined && v.self !== true) c.err(`${path}.self`, '只能省略或为 true');
  const claims = arr(c, v.claims, `${path}.claims`, claim, { required: true, max: LIMITS.claimsMax });
  return clean({ self: v.self === true ? true : undefined, claims });
}

export function validateIdentityClaim(v) { const c = new Ctx(); const value = claim(c, v, 'claim'); return result(c, value); }
export function validateActorRef(v) { const c = new Ctx(); const value = actor(c, v, 'actor'); return result(c, value); }

// ── §4.3 感知 ─────────────────────────────────────────────────────────────
function media(c, v, path) {
  if (!obj(c, v, path, { required: true })) return undefined;
  return clean({
    kind: str(c, v.kind, `${path}.kind`, { required: true, allowEmpty: false, max: 64 }),
    summary: str(c, v.summary, `${path}.summary`),
    ref: str(c, v.ref, `${path}.ref`, { max: MAX_ID_LENGTH }),
  });
}

/**
 * @param {unknown} v
 * @returns {{ok: boolean, value: import('./types.js').Observation|null, errors: {path:string, message:string}[]}}
 */
export function validateObservation(v) {
  const c = new Ctx();
  if (!obj(c, v, 'observation', { required: true })) return result(c, null);
  const o = /** @type {any} */ (v);
  const kind = oneOf(c, o.kind, OBSERVATION_KINDS, 'kind', { required: true });
  const out = clean({
    id: id(c, o.id, 'id', { required: true }),
    settingId: id(c, o.settingId, 'settingId', { required: true }),
    perceivedInSettingId: id(c, o.perceivedInSettingId, 'perceivedInSettingId'),
    visibleTo: oneOf(c, o.visibleTo, VISIBLE_TO, 'visibleTo', { required: true }),
    at: time(c, o.at, 'at', { required: true }),
    perceivedAt: time(c, o.perceivedAt, 'perceivedAt', { required: true }),
    actor: actor(c, o.actor, 'actor'),
    kind,
    target: id(c, o.target, 'target'),
    text: str(c, o.text, 'text', { required: true, max: LIMITS.textMax }),
    textTruncated: bool(c, o.textTruncated, 'textTruncated'),
    lang: str(c, o.lang, 'lang', { max: 35, allowEmpty: false }),
    media: arr(c, o.media, 'media', media),
    quote: undefined,
    replyTo: id(c, o.replyTo, 'replyTo'),
    mentions: arr(c, o.mentions, 'mentions', (cc, x, p) => actor(cc, x, p)),
    addressed: oneOf(c, o.addressed, ADDRESSED, 'addressed', { required: true }),
    attention: oneOf(c, o.attention, ATTENTION, 'attention', { required: true }),
    evidential: bool(c, o.evidential, 'evidential', { required: true }),
    forwarded: undefined,
    via: undefined,
    derivedFrom: undefined,
    standing: oneOf(c, o.standing, STANDING, 'standing', { required: true }),
    sessionRef: undefined,
    appraisalToken: str(c, o.appraisalToken, 'appraisalToken', { max: MAX_ID_LENGTH, allowEmpty: false }),
    historical: bool(c, o.historical, 'historical'),
  });
  if (obj(c, o.quote, 'quote')) {
    out.quote = clean({
      obs: id(c, o.quote.obs, 'quote.obs'),
      author: actor(c, o.quote.author, 'quote.author', { required: false }),
      excerpt: str(c, o.quote.excerpt, 'quote.excerpt'),
    });
  }
  if (obj(c, o.forwarded, 'forwarded')) {
    if (o.forwarded.authorVerified !== false) c.err('forwarded.authorVerified', '转发内容的作者永远未经核实，必须是 false');
    out.forwarded = clean({
      claimedAuthor: actor(c, o.forwarded.claimedAuthor, 'forwarded.claimedAuthor', { required: false }),
      relayedBy: actor(c, o.forwarded.relayedBy, 'forwarded.relayedBy'),
      authorVerified: false,
    });
  }
  if (obj(c, o.via, 'via')) {
    out.via = clean({
      relayedBy: actor(c, o.via.relayedBy, 'via.relayedBy'),
      originalSetting: id(c, o.via.originalSetting, 'via.originalSetting'),
    });
  }
  if (obj(c, o.derivedFrom, 'derivedFrom')) {
    out.derivedFrom = {
      adapter: adapterId(c, o.derivedFrom.adapter, 'derivedFrom.adapter'),
      obsId: id(c, o.derivedFrom.obsId, 'derivedFrom.obsId', { required: true }),
    };
  }
  if (obj(c, o.sessionRef, 'sessionRef')) {
    out.sessionRef = clean({
      sessionId: id(c, o.sessionRef.sessionId, 'sessionRef.sessionId', { required: true }),
      seq: num(c, o.sessionRef.seq, 'sessionRef.seq', { int: true, min: 0 }),
      callId: id(c, o.sessionRef.callId, 'sessionRef.callId'),
    });
  }
  clean(out);

  // 字段之间的自洽
  const self = out.actor?.self === true;
  if (kind && SELF_KINDS.includes(kind)) {
    if (!self) c.err('actor.self', `${kind} 的 actor 必须是她自己（self: true）`);
    if (out.addressed && out.addressed !== 'by-her') c.err('addressed', `${kind} 的 addressed 必须是 by-her`);
  }
  if (out.addressed === 'by-her' && !self) c.err('addressed', 'by-her 只用于她自己的感知');
  if (self && (kind === 'utterance' || kind === 'action')) c.err('kind', `她自己的话和动作用 self-${kind}`);
  if (kind === 'self-thought' && out.visibleTo && out.visibleTo !== 'her-only') c.err('visibleTo', '她心里想的只有她自己看得到（her-only）');
  if (kind && TARGET_KINDS.includes(kind) && !out.target) c.err('target', `${kind} 必须指向原消息`);
  if (kind && !TARGET_KINDS.includes(kind) && out.target) c.err('target', '只有 retract / edit 才有 target');
  if (out.target && out.id && out.target === out.id) c.err('target', '不能指向自己');

  if (c.errors.length) return result(c, null);
  out.perceivedInSettingId ??= out.settingId;
  out.textTruncated ??= false;
  out.historical ??= false;
  return result(c, /** @type {import('./types.js').Observation} */ (out));
}

function adapterId(c, v, path, { required = true } = {}) {
  if (missing(v)) return required ? c.err(path, '必填') : undefined;
  if (typeof v !== 'string' || !ADAPTER_ID_RE.test(v)) return c.err(path, '应为 1–64 位、字母开头的字母数字和 ._-');
  return v;
}
export const isAdapterId = (v) => typeof v === 'string' && ADAPTER_ID_RE.test(v);

/** 校验一批感知：合格的进 accepted，不合格的带下标进 rejected。 */
export function validateObservations(list) {
  const accepted = [];
  const rejected = [];
  if (!Array.isArray(list)) return { accepted, rejected: [{ index: -1, errors: [{ path: 'observations', message: '应为数组' }] }] };
  list.forEach((o, index) => {
    const r = validateObservation(o);
    if (r.ok) accepted.push(r.value); else rejected.push({ index, errors: r.errors });
  });
  return { accepted, rejected };
}

/** @param {unknown} v */
export function validateObserveOptions(v) {
  const c = new Ctx();
  if (missing(v)) return result(c, { historical: false });
  if (!obj(c, v, 'options')) return result(c, null);
  const o = /** @type {any} */ (v);
  const out = clean({
    adapter: adapterId(c, o.adapter, 'adapter', { required: false }),
    historical: bool(c, o.historical, 'historical') ?? false,
    cursor: undefined,
  });
  if (obj(c, o.cursor, 'cursor')) {
    out.cursor = {
      key: str(c, o.cursor.key, 'cursor.key', { required: true, allowEmpty: false, max: 200 }),
      value: str(c, o.cursor.value, 'cursor.value', { required: true, max: LIMITS.shortMax }),
    };
  }
  return result(c, clean(out));
}

// ── §4.3 场合 ─────────────────────────────────────────────────────────────
/**
 * @param {unknown} v
 * @returns {{ok: boolean, value: import('./types.js').SettingDescriptor|null, errors: {path:string, message:string}[]}}
 */
export function validateSettingDescriptor(v) {
  const c = new Ctx();
  if (!obj(c, v, 'descriptor', { required: true })) return result(c, null);
  const d = /** @type {any} */ (v);
  const out = clean({
    id: id(c, d.id, 'id', { required: true }),
    label: str(c, d.label, 'label', { required: true, allowEmpty: false, max: LIMITS.labelMax }),
    labelKind: oneOf(c, d.labelKind, LABEL_KIND, 'labelKind'),
    labelOrigin: oneOf(c, d.labelOrigin, LABEL_ORIGIN, 'labelOrigin'),
    hint: str(c, d.hint, 'hint', { max: LIMITS.hintMax }),
    parent: id(c, d.parent, 'parent'),
    stability: oneOf(c, d.stability, STABILITY, 'stability', { required: true }),
    audience: undefined, disclosure: undefined, ownership: undefined, norms: undefined, capabilities: undefined,
    purpose: str(c, d.purpose, 'purpose'),
    attending: bool(c, d.attending, 'attending', { required: true }),
  });
  if (obj(c, d.audience, 'audience', { required: true })) {
    const a = d.audience;
    let size;
    if (a.size === 'unbounded' || a.size === 'unknown') size = a.size;
    else size = num(c, a.size, 'audience.size', { required: true, int: true, min: 1 });
    out.audience = {
      size,
      entry: oneOf(c, a.entry, AUDIENCE_ENTRY, 'audience.entry', { required: true }),
      unknownObservers: bool(c, a.unknownObservers, 'audience.unknownObservers', { required: true }),
      membersKnown: oneOf(c, a.membersKnown, MEMBERS_KNOWN, 'audience.membersKnown', { required: true }),
    };
  }
  if (obj(c, d.disclosure, 'disclosure', { required: true })) {
    const x = d.disclosure;
    out.disclosure = {
      visibleTo: oneOf(c, x.visibleTo, DISCLOSURE_VISIBLE_TO, 'disclosure.visibleTo', { required: true }),
      persistence: oneOf(c, x.persistence, PERSISTENCE, 'disclosure.persistence', { required: true }),
      searchable: bool(c, x.searchable, 'disclosure.searchable', { required: true }),
      attributedToHer: bool(c, x.attributedToHer, 'disclosure.attributedToHer', { required: true }),
    };
  }
  if (obj(c, d.ownership, 'ownership', { required: true })) {
    const w = d.ownership;
    let owner;
    if (w.owner === 'platform' || w.owner === 'unknown') owner = w.owner;
    else owner = actor(c, w.owner, 'ownership.owner');
    out.ownership = {
      owner,
      herRole: str(c, w.herRole, 'ownership.herRole', { required: true, max: LIMITS.labelMax }),
      herModerates: bool(c, w.herModerates, 'ownership.herModerates', { required: true }),
      actsOnBehalfOfPrincipal: bool(c, w.actsOnBehalfOfPrincipal, 'ownership.actsOnBehalfOfPrincipal', { required: true }),
    };
  }
  if (obj(c, d.norms, 'norms')) {
    out.norms = clean({
      register: str(c, d.norms.register, 'norms.register'),
      notes: arr(c, d.norms.notes, 'norms.notes', (cc, n, p) => {
        if (!obj(cc, n, p, { required: true })) return undefined;
        return clean({
          text: str(cc, n.text, `${p}.text`, { required: true, allowEmpty: false, max: LIMITS.noteTextMax }),
          author: actor(cc, n.author, `${p}.author`, { required: false }),
        });
      }),
    });
  }
  if (obj(c, d.capabilities, 'capabilities', { required: true })) {
    out.capabilities = {
      preSendGate: bool(c, d.capabilities.preSendGate, 'capabilities.preSendGate', { required: true }),
      canHold: bool(c, d.capabilities.canHold, 'capabilities.canHold', { required: true }),
    };
  }
  clean(out);
  if (out.parent && out.parent === out.id) c.err('parent', '不能是自己');
  if (out.disclosure?.visibleTo === 'anyone' && out.audience && !out.audience.unknownObservers) {
    c.err('audience.unknownObservers', '任何人可见的场合一定有不认识的旁观者（必须为 true）');
  }
  return result(c, /** @type {import('./types.js').SettingDescriptor} */ (out));
}

// ── §4.4 渠道和发言 ───────────────────────────────────────────────────────
function channel(c, v, path) {
  if (!obj(c, v, path, { required: true })) return undefined;
  return clean({
    targetSettingId: id(c, v.targetSettingId, `${path}.targetSettingId`, { required: true }),
    persistence: oneOf(c, v.persistence, CHANNEL_PERSISTENCE, `${path}.persistence`, { required: true }),
    delayMs: num(c, v.delayMs, `${path}.delayMs`, { min: 0, max: MAX_TIME }),
    addressee: actor(c, v.addressee, `${path}.addressee`, { required: false }),
    notifies: arr(c, v.notifies, `${path}.notifies`, (cc, x, p) => actor(cc, x, p)),
    formHint: str(c, v.formHint, `${path}.formHint`, { max: 64 }),
  });
}
export function validateExpressionChannel(v) { const c = new Ctx(); const value = channel(c, v, 'channel'); return result(c, value); }

/**
 * @param {unknown} v
 * @returns {{ok: boolean, value: import('./types.js').Utterance|null, errors: {path:string, message:string}[]}}
 */
export function validateUtterance(v) {
  const c = new Ctx();
  if (!obj(c, v, 'utterance', { required: true })) return result(c, null);
  const u = /** @type {any} */ (v);
  const out = clean({
    channel: channel(c, u.channel, 'channel'),
    text: arr(c, u.text, 'text', (cc, x, p) => str(cc, x, p, { required: true, max: LIMITS.utterancePartMax }),
      { required: true, max: LIMITS.utterancePartsMax }),
    media: arr(c, u.media, 'media', (cc, m, p) => {
      if (!obj(cc, m, p, { required: true })) return undefined;
      return clean({ kind: str(cc, m.kind, `${p}.kind`, { required: true, allowEmpty: false, max: 64 }), summary: str(cc, m.summary, `${p}.summary`) });
    }),
    origin: undefined,
  });
  if (obj(c, u.origin, 'origin', { required: true })) {
    const o = u.origin;
    out.origin = clean({
      path: oneOf(c, o.path, UTTERANCE_PATHS, 'origin.path', { required: true }),
      sessionId: id(c, o.sessionId, 'origin.sessionId'),
      callId: id(c, o.callId, 'origin.callId'),
      homeSettingId: id(c, o.homeSettingId, 'origin.homeSettingId'),
      holdToken: id(c, o.holdToken, 'origin.holdToken'),
    });
    if (out.origin.path === 'owner-approved' && !out.origin.holdToken) c.err('origin.holdToken', 'owner-approved 必须带挂起令牌（§9.4.4）');
  }
  clean(out);
  if (out.text && !out.text.some((t) => t.trim()) && !(out.media?.length)) c.err('text', '没有任何要说的内容');
  return result(c, /** @type {import('./types.js').Utterance} */ (out));
}

/** 核心自己的输出也校验一遍（测试和不变式断言用）。 */
export function validateAppraisal(v) {
  const c = new Ctx();
  if (!obj(c, v, 'appraisal', { required: true })) return result(c, null);
  const a = /** @type {any} */ (v);
  const out = clean({
    verdict: oneOf(c, a.verdict, APPRAISAL_VERDICTS, 'verdict', { required: true }),
    reflection: str(c, a.reflection, 'reflection'),
    token: id(c, a.token, 'token', { required: true }),
  });
  return result(c, out);
}

// ── §4.5 读接口 ───────────────────────────────────────────────────────────
export function validateSituationRef(v) {
  const c = new Ctx();
  if (!obj(c, v, 'situation', { required: true })) return result(c, null);
  const s = /** @type {any} */ (v);
  const out = clean({
    settingId: id(c, s.settingId, 'settingId', { required: true }),
    focusObsId: id(c, s.focusObsId, 'focusObsId'),
    focusObsIds: arr(c, s.focusObsIds, 'focusObsIds', (cc, x, p) => id(cc, x, p, { required: true }), { max: 8 }),
    trigger: oneOf(c, s.trigger, SITUATION_TRIGGERS, 'trigger', { required: true }),
    egress: arr(c, s.egress, 'egress', channel),
    homeSettingId: id(c, s.homeSettingId, 'homeSettingId'),
    sessionId: id(c, s.sessionId, 'sessionId'),
    // D124：她这一步正在用的工具名（只用来想起用这个工具的经验）
    tools: arr(c, s.tools, 'tools', (cc, x, p) => str(cc, x, p, { required: true, allowEmpty: false, max: 64 }), { max: 4 }),
  });
  if (c.errors.length) return result(c, null);
  out.homeSettingId ??= out.settingId;
  return result(c, out);
}

export function validateRecallOptions(v) {
  const c = new Ctx();
  if (!obj(c, v, 'options', { required: true })) return result(c, null);
  const o = /** @type {any} */ (v);
  const out = clean({
    mode: oneOf(c, o.mode, RECALL_MODES, 'mode', { required: true }),
    query: str(c, o.query, 'query'),
    about: str(c, o.about, 'about', { max: LIMITS.labelMax }),
    time: str(c, o.time, 'time', { max: LIMITS.labelMax }),
    where: str(c, o.where, 'where', { max: LIMITS.labelMax }),
    includeHistory: bool(c, o.includeHistory, 'includeHistory'),
    deadlineMs: num(c, o.deadlineMs, 'deadlineMs', { required: true, min: 0, max: LIMITS.deadlineMaxMs }),
    budgetChars: num(c, o.budgetChars, 'budgetChars', { required: true, int: true, min: 0, max: 100_000 }),
    signal: undefined,
  });
  if (o.signal !== undefined && !(o.signal && typeof o.signal.aborted === 'boolean')) c.err('signal', '应为 AbortSignal');
  else if (o.signal) out.signal = o.signal;
  return result(c, out);
}

function recallItem(c, v, path) {
  if (!obj(c, v, path, { required: true })) return undefined;
  return {
    id: str(c, v.id, `${path}.id`, { required: true, allowEmpty: false, max: 200 }),
    layer: oneOf(c, v.layer, LAYERS, `${path}.layer`, { required: true }),
    rendered: str(c, v.rendered, `${path}.rendered`, { required: true }),
    verdict: oneOf(c, v.verdict, ITEM_VERDICTS, `${path}.verdict`, { required: true }),
    confidence: num(c, v.confidence, `${path}.confidence`, { required: true, min: 0, max: 1 }),
    provenance: str(c, v.provenance, `${path}.provenance`, { required: true }),
    // §9.3.6：每条都必须能对上一次判定
    appraisalRef: str(c, v.appraisalRef, `${path}.appraisalRef`, { required: true, allowEmpty: false, max: 200 }),
    // 可选（D101）：工作记忆的条目带说出口的档位
    ...(v.speak !== undefined ? { speak: oneOf(c, v.speak, SPEAK_LEVELS, `${path}.speak`, { required: true }) } : {}),
    // 可选（D108 评审）：工作记忆的条目带组号（同一个来源场合的一组；组长带着场合说明，集成层截字数时整组一起取舍）
    ...(v.group !== undefined ? { group: str(c, v.group, `${path}.group`, { required: true, allowEmpty: false, max: 32 }) } : {}),
    // 可选（D110）：工作记忆的条目带所在的段（只给注入日志和管理页用）
    ...(v.unit !== undefined ? { unit: oneOf(c, v.unit, WORKING_UNITS, `${path}.unit`, { required: true }) } : {}),
    ...(v.unitKey !== undefined ? { unitKey: str(c, v.unitKey, `${path}.unitKey`, { required: true, allowEmpty: false, max: 40 }) } : {}),
  };
}
export function validateRecallLayers(v) {
  const c = new Ctx();
  if (!obj(c, v, 'layers', { required: true })) return result(c, null);
  const l = /** @type {any} */ (v);
  const out = {
    items: arr(c, l.items, 'items', recallItem, { required: true, max: 500 }),
    degradeLevel: num(c, l.degradeLevel, 'degradeLevel', { required: true, int: true, min: 0, max: 4 }),
    traceId: str(c, l.traceId, 'traceId', { required: true, allowEmpty: false, max: 200 }),
  };
  // 可选（D95）：有意回想时，有关但本周期已经给过她的条数
  const already = num(c, l.alreadySent, 'alreadySent', { int: true, min: 0 });
  if (already !== undefined) out.alreadySent = already;
  // 可选（D155）：回忆的「找了哪儿」那一行和意图、范围的摘要
  if (l.recollect !== undefined) {
    if (obj(c, l.recollect, 'recollect', { required: true })) {
      const note = str(c, l.recollect.note, 'recollect.note', { required: true, max: 400 });
      const log = l.recollect.log;
      if (log !== undefined && (log === null || typeof log !== 'object' || Array.isArray(log))) c.err('recollect.log', '应为对象');
      out.recollect = { note: note ?? '', ...(log && typeof log === 'object' && !Array.isArray(log) ? { log } : {}) };
    }
  }
  return result(c, out);
}

// ── 写类请求 ──────────────────────────────────────────────────────────────
export function validateNoteRequest(v) {
  const c = new Ctx();
  if (!obj(c, v, 'note', { required: true })) return result(c, null);
  const n = /** @type {any} */ (v);
  const out = clean({
    triggerObsId: id(c, n.triggerObsId, 'triggerObsId', { required: true }),
    triggerObsIds: arr(c, n.triggerObsIds, 'triggerObsIds', (cc, x, p) => id(cc, x, p, { required: true }), { max: 8 }),
    speaker: actor(c, n.speaker, 'speaker'),
    op: oneOf(c, n.op, NOTE_OPS, 'op', { required: true }),
    text: str(c, n.text, 'text', { required: true, allowEmpty: false }),
    about: str(c, n.about, 'about', { max: LIMITS.labelMax }),
    when: str(c, n.when, 'when', { max: LIMITS.labelMax }),
    evidenceQuote: str(c, n.evidenceQuote, 'evidenceQuote', { required: true, allowEmpty: false }),
  });
  return result(c, out);
}

export function validateFixRequest(v) {
  const c = new Ctx();
  if (!obj(c, v, 'fix', { required: true })) return result(c, null);
  const n = /** @type {any} */ (v);
  const out = clean({
    triggerObsId: id(c, n.triggerObsId, 'triggerObsId', { required: true }),
    triggerObsIds: arr(c, n.triggerObsIds, 'triggerObsIds', (cc, x, p) => id(cc, x, p, { required: true }), { max: 8 }),
    speaker: actor(c, n.speaker, 'speaker'),
    op: oneOf(c, n.op, FIX_OPS, 'op', { required: true }),
    target: str(c, n.target, 'target', { required: true, allowEmpty: false }),
    newText: str(c, n.newText, 'newText', { allowEmpty: false }),
    evidenceQuote: str(c, n.evidenceQuote, 'evidenceQuote', { required: true, allowEmpty: false }),
  });
  if (out.op === 'correct' && !out.newText) c.err('newText', 'correct 必须给出新的说法');
  return result(c, out);
}

function importRecord(c, v, path) {
  if (!obj(c, v, path, { required: true })) return undefined;
  const meta = obj(c, v.sourceMeta, `${path}.sourceMeta`, { required: true });
  const out = clean({
    subjects: arr(c, v.subjects, `${path}.subjects`, (cc, s, p) => str(cc, s, p, { required: true, allowEmpty: false, max: LIMITS.labelMax }), { required: true, min: 1 }),
    text: str(c, v.text, `${path}.text`, { required: true, allowEmpty: false, max: LIMITS.noteTextMax }),
    sourceMeta: meta ? clean({
      speaker: str(c, meta.speaker, `${path}.sourceMeta.speaker`, { max: LIMITS.labelMax }),
      at: time(c, meta.at, `${path}.sourceMeta.at`),
      settingLabel: str(c, meta.settingLabel, `${path}.sourceMeta.settingLabel`, { max: LIMITS.labelMax }),
    }) : undefined,
    norm: undefined,
  });
  if (obj(c, v.norm, `${path}.norm`)) {
    out.norm = clean({ restriction: oneOf(c, v.norm.restriction, RESTRICTIONS, `${path}.norm.restriction`), scope: v.norm.scope });
  }
  return clean(out);
}
export function validateImportRecords(list) {
  const c = new Ctx();
  const value = arr(c, list, 'records', importRecord, { required: true, max: LIMITS.importBatchMax });
  return result(c, value);
}

export function validateRelayExpectation(v) {
  const c = new Ctx();
  if (!obj(c, v, 'relay', { required: true })) return result(c, null);
  const r = /** @type {any} */ (v);
  const out = {
    adapter: adapterId(c, r.adapter, 'adapter'),
    obsId: id(c, r.obsId, 'obsId', { required: true }),
    textHash: str(c, r.textHash, 'textHash', { required: true, allowEmpty: false, max: 64 }),
    until: time(c, r.until, 'until', { required: true }),
  };
  return result(c, out);
}

// ── 适配器本身 ────────────────────────────────────────────────────────────
export function validatePerceptionAdapter(v) {
  const c = new Ctx();
  if (!obj(c, v, 'adapter', { required: true })) return result(c, null);
  const a = /** @type {any} */ (v);
  adapterId(c, a.id, 'id');
  if (a.protocol !== PROTOCOL) c.err('protocol', `只支持 protocol ${PROTOCOL}`);
  for (const fn of ['describeSetting', 'selfClaims', 'principalClaims']) {
    if (typeof a[fn] !== 'function') c.err(fn, '必须是函数');
  }
  for (const fn of ['members', 'start', 'onHoldDecision', 'quietReason']) {
    if (a[fn] !== undefined && typeof a[fn] !== 'function') c.err(fn, '提供的话必须是函数');
  }
  if (a.displayName !== undefined && (typeof a.displayName !== 'string' || !a.displayName.trim() || a.displayName.length > 40)) c.err('displayName', '提供的话必须是 1–40 字的字符串');
  return result(c, a);
}

export const assertObservation = asserter('Observation', validateObservation);
export const assertSettingDescriptor = asserter('SettingDescriptor', validateSettingDescriptor);
export const assertUtterance = asserter('Utterance', validateUtterance);
export const assertSituationRef = asserter('SituationRef', validateSituationRef);
export const assertRecallOptions = asserter('RecallOptions', validateRecallOptions);
export const assertRecallLayers = asserter('RecallLayers', validateRecallLayers);
export const assertNoteRequest = asserter('NoteRequest', validateNoteRequest);
export const assertFixRequest = asserter('FixRequest', validateFixRequest);
export const assertPerceptionAdapter = asserter('PerceptionAdapter', validatePerceptionAdapter);
export const assertRelayExpectation = asserter('RelayExpectation', validateRelayExpectation);
