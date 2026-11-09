// 会话 → SettingDescriptor（§4.3、§11.1 的字段映射表）。只填属性，不出现平台名；私聊和群共用一份逻辑，区别全在属性里。
import { splitKey, allowedByBridge } from './files.js';
import { PRINCIPAL_CLAIM, scrubAccounts } from './messages.js';

/** 主人：配置给的账号 + principal 证据（核心按它挂到主人实体上）。 */
export function principalActor(ownerId) {
  return { claims: ownerId ? [{ kind: 'account', namespace: 'qq', id: ownerId, verifiedBy: 'config' }, { ...PRINCIPAL_CLAIM }] : [{ ...PRINCIPAL_CLAIM }] };
}
export const peerActor = (id) => ({ claims: [{ kind: 'account', namespace: 'qq', id, verifiedBy: 'platform' }] });

/**
 * @typedef {object} ConversationOverride   主人在插件配置里对某个会话的说明（私有配置，不进仓库）
 * @property {string} [label]               她对这里的称呼
 * @property {boolean} [ownedByPrincipal]   群主是主人（桥接的文件里没有群主信息）
 * @property {boolean} [doNotRecord]        「别记这里」
 * @property {number} [size]                群人数（桥接的文件里没有）
 */

/**
 * @param {object} o
 * @param {string} o.key
 * @param {string} o.settingId
 * @param {string} o.code                       区分没有名字的会话用的短码（不含账号）：只进 hint（管理页），从不进 label
 * @param {{name: string, source: 'remark'|'name', memberCount: number|null}|null} [o.platform]   平台上的群名（qq/names.js，D111）
 * @param {Map<string, string>} [o.known]       账号 → 名字（平台上的群名过一遍和消息一样的账号清洗）
 * @param {import('./files.js').BridgeConfig|null} o.bridgeCfg
 * @param {ConversationOverride} [o.override]
 * @param {string} [o.initialPrompt]            操作者写的环境说明
 * @param {{text: string}[]} [o.ownerRules]     管理员经 qq_owner_group_rule 写的群规
 * @param {string} [o.ownerId]
 * @param {string} o.principalLabel
 * @returns {import('rugu-core/contract').SettingDescriptor}
 */
export function describeConversation(o) {
  const { kind, id } = splitKey(o.key);
  const ov = o.override ?? {};
  const allowed = allowedByBridge(o.bridgeCfg, o.key);
  const groupCfg = kind === 'group' ? o.bridgeCfg?.groups.get(id) : undefined;
  const attending = allowed !== false && !ov.doNotRecord && groupCfg?.recordable !== false;
  const principal = principalActor(o.ownerId);
  const notes = [];
  // 操作者写的环境说明、管理员写的群规：作者都是主人（配置），核心按 authority='principal' 写成场合规矩。
  // 给了 notes 核心就当它是完整清单（D91：清单里没有的公告规矩撤下）；主人写的规矩不随公告撤，所以读不全时也不会放松什么
  if (o.initialPrompt) notes.push({ text: o.initialPrompt.slice(0, 2000), author: principal });
  for (const r of o.ownerRules ?? []) if (r?.text) notes.push({ text: r.text.slice(0, 400), author: principal });

  if (kind === 'private') {
    const isPrincipal = !!o.ownerId && id === o.ownerId;
    return {
      id: o.settingId,
      // 【D111】主人配置里写的是名字；否则只是一句说法（不当名字认），短码只给管理页区分
      label: (ov.label || (isPrincipal ? `和${o.principalLabel}的私聊` : '一个 QQ 私聊')).slice(0, 60),
      labelKind: ov.label ? 'name' : 'description',
      ...(ov.label ? { labelOrigin: 'config' } : {}),
      ...(ov.label || isPrincipal ? {} : { hint: o.code }),
      stability: 'persistent',
      audience: { size: 2, entry: 'closed', unknownObservers: false, membersKnown: 'exact' },
      disclosure: { visibleTo: 'participants', persistence: 'logged', searchable: false, attributedToHer: true },
      ownership: { owner: isPrincipal ? principal : peerActor(id), herRole: isPrincipal ? '助理' : '朋友', herModerates: false, actsOnBehalfOfPrincipal: isPrincipal },
      ...(notes.length ? { norms: { notes: notes.slice(0, 32) } } : {}),
      capabilities: { preSendGate: true, canHold: false },   // 发言工具都过 pre-execute；QQ 没有草稿
      attending,
    };
  }
  const owned = ov.ownedByPrincipal === true;
  const configured = (ov.label || groupCfg?.label || '').trim();
  const fromPlatform = configured ? '' : platformName(o);
  const named = configured || fromPlatform;
  const size = Number.isSafeInteger(ov.size) && ov.size >= 3 ? ov.size : 'unknown';
  return {
    id: o.settingId,
    // 【D111】名字的来源：主人的插件配置 → 桥接配置里写的 → 平台上的（机器人的备注、群名）；都没有就是一句说法「一个 QQ 群」，
    // 短码和人数只进 hint（管理页区分用），从不进 label、不进她的提示词
    label: (named || '一个 QQ 群').slice(0, 60),
    labelKind: named ? 'name' : 'description',
    // 平台上的名字是群里的人起的（主人没过目）：核心只在那个群的人、管理者面前说出它（关口①，D111 评审）
    ...(named ? { labelOrigin: configured ? 'config' : 'platform' } : {}),
    hint: groupHint(o),
    stability: 'persistent',
    audience: { size, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' },
    disclosure: { visibleTo: 'members', persistence: 'logged', searchable: false, attributedToHer: true },
    ownership: { owner: owned ? principal : 'unknown', herRole: owned ? '群主的助理' : '群成员', herModerates: owned, actsOnBehalfOfPrincipal: false },
    ...(notes.length ? { norms: { notes: notes.slice(0, 32) } } : {}),
    capabilities: { preSendGate: true, canHold: false },
    attending,
  };
}

/**
 * 平台上的群名 / 备注，过一遍和消息文字一样的账号清洗（D111 评审）：认识的账号换名字，@数字、QQ 数字换「某人」，
 * 再去掉 5 位以上的数字串（群号、QQ 号、手机号的样子）。剩下没有字（只有标点、空白）就当不知道名字，退回「一个 QQ 群」。
 */
function platformName(o) {
  const raw = typeof o.platform?.name === 'string' ? o.platform.name : '';
  if (!raw.trim()) return '';
  const s = scrubAccounts(raw, o.known ?? new Map()).replace(/\d{5,}/g, ' ').replace(/\s+/g, ' ').trim();
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(s) ? s : '';
}

/** 管理页的区分提示（D111）：平台报的人数 + 短码，例如「9 人 · DX2y」。不进 label、不进提示词。 */
function groupHint(o) {
  const n = o.platform?.memberCount;
  return [Number.isSafeInteger(n) && n > 0 ? `${n} 人` : null, o.code].filter(Boolean).join(' · ').slice(0, 24);
}
