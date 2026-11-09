// 不透明 id 换成存储键（§12.3、D9）：账号 id → identityHash，SettingId → settingKey，ObsId → obsKey。
// 适配器给的 ActorRef、场合描述在入库前都过这里：原值只在内存里停留到算完哈希，库里、日志里、LLM 里都不出现。
// 不透明 id 只整体交给 keys.*，不拆不拼（§2.2）。
import crypto from 'node:crypto';
import { cleanLabel } from './sanitize.js';

/**
 * 一条身份证据 → 可以存的形状。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {import('../contract/types.js').IdentityClaim} c   已经过 contract 校验
 * @param {(text: string) => string} cleanText              自我介绍这类正文的清洗
 */
export function hashClaim(core, adapterId, c, cleanText) {
  switch (c.kind) {
    case 'account': {
      const out = { kind: 'account', namespace: c.namespace, idHash: core.keys.identityHash(c.namespace, c.scope, c.id), verifiedBy: c.verifiedBy };
      if (c.scope != null) out.scopeHash = core.keys.hash('account-scope', c.namespace, c.scope);
      if (c.displayName != null) out.displayName = cleanLabel(c.displayName);
      return out;
    }
    case 'display-name': {
      const out = { kind: 'display-name', name: cleanLabel(c.name), observedAt: c.observedAt };
      if (c.scope != null) out.scopeKey = core.keys.settingKey(adapterId, c.scope);
      return out;
    }
    case 'self-introduction':
      return { kind: 'self-introduction', text: cleanText(c.text), obsKey: core.keys.obsKey(adapterId, c.obs) };
    case 'role-in-setting': {
      const out = { kind: 'role-in-setting', settingKey: core.keys.settingKey(adapterId, c.setting), role: cleanLabel(c.role) };
      if (c.moderates != null) out.moderates = c.moderates;
      if (c.isOwner != null) out.isOwner = c.isOwner;
      return out;
    }
    case 'principal':
      return { kind: 'principal', strength: 'config' };
    default:
      return null;
  }
}

/**
 * ActorRef → 可以存的形状（账号 id 换成哈希）。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {import('../contract/types.js').ActorRef|undefined|null} a
 * @param {(text: string) => string} cleanText
 */
export function hashActor(core, adapterId, a, cleanText) {
  if (!a) return null;
  const out = { claims: (a.claims ?? []).map((c) => hashClaim(core, adapterId, c, cleanText)).filter(Boolean) };
  if (a.self === true) out.self = true;
  return out;
}

/** 存下来的 ActorRef 里，这个人在某个场合的显示名（本场合的名片优先，其次账号名，再次任何名片）。 */
export function displayNameOf(storedActor, settingKey) {
  const claims = storedActor?.claims ?? [];
  const scoped = claims.find((c) => c.kind === 'display-name' && c.scopeKey === settingKey && c.name);
  if (scoped) return scoped.name;
  const acct = claims.find((c) => c.kind === 'account' && c.displayName);
  if (acct) return acct.displayName;
  const any = claims.find((c) => c.kind === 'display-name' && !c.scopeKey && c.name)
    ?? claims.find((c) => c.kind === 'display-name' && c.name);
  return any ? any.name : null;
}

/**
 * 场合描述 → 可以存的形状：id、parent 换成场合键，ActorRef 里的账号换成哈希，文字去不可见字符。
 * 返回的对象照样能交给 contract 的 exposureRank / persistenceRank / reachHash。
 * @param {import('../core-types.js').CoreContext} core
 * @param {string} adapterId
 * @param {import('../contract/types.js').SettingDescriptor} d   已经过 contract 校验
 * @param {(text: string) => string} cleanText
 */
export function storableDescriptor(core, adapterId, d, cleanText) {
  const out = {
    id: core.keys.settingKey(adapterId, d.id),
    label: cleanLabel(d.label),
  };
  if (d.parent != null) out.parent = core.keys.settingKey(adapterId, d.parent);
  out.stability = d.stability;
  out.audience = { ...d.audience };
  out.disclosure = { ...d.disclosure };
  out.ownership = {
    owner: typeof d.ownership.owner === 'string' ? d.ownership.owner : hashActor(core, adapterId, d.ownership.owner, cleanText),
    herRole: cleanLabel(d.ownership.herRole),
    herModerates: d.ownership.herModerates,
    actsOnBehalfOfPrincipal: d.ownership.actsOnBehalfOfPrincipal,
  };
  if (d.norms) {
    const norms = {};
    if (d.norms.register != null) norms.register = cleanLabel(d.norms.register);
    if (d.norms.notes) {
      norms.notes = d.norms.notes.map((n) => {
        const note = { text: cleanText(n.text) };
        if (n.author) note.author = hashActor(core, adapterId, n.author, cleanText);
        return note;
      });
    }
    out.norms = norms;
  }
  out.capabilities = { ...d.capabilities };
  if (d.purpose != null) out.purpose = cleanText(d.purpose);
  out.attending = d.attending;
  return out;
}

/** 描述的指纹（没变就不新建快照）。 */
export function descriptorHash(stored) {
  return crypto.createHash('sha256').update(JSON.stringify(stored)).digest('hex').slice(0, 32);
}

/** 一条场合规矩的指纹（文字 + 作者）：只把新出现的 norms.notes 交给 discretion。 */
export function noteKey(note) {
  const author = note.author?.claims?.map((c) => c.idHash ?? c.name ?? c.kind).join(',') ?? '';
  return crypto.createHash('sha256').update(JSON.stringify([note.text.replace(/\s+/g, ' ').trim(), author])).digest('hex').slice(0, 24);
}
