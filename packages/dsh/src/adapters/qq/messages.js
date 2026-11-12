// 桥接的一条消息 → 一条 Observation（§4.3、§11.1 的字段映射）。只给事实，不做判断。
// 平台知识都在这里：她自己的行 isOwner 也是 true（先判 isSelf，C2）；拍一拍、入群退群这类系统行 evidential:false；
// text / plain / tail 各截 200 字（头尾拼接，标 textTruncated）；@ 只剩名字（按名字反查账号，D108；群里加上平台的成员名单，D160）；
// 桥接渲染的系统行里带着账号原值（「QQ 123…」「拍了拍 123…」「@123…」），进 text 之前换成名字或「某人」（§4.7：不许把账号写进 text）。
import { opaqueFrom, textHash } from 'rugu-core/contract';

/** 截断阈值：桥接的 truncateText(…, 200)。 */
export const BRIDGE_CUT = 200;
const MIN_OVERLAP = 8;

/**
 * 头尾拼接：原文 ≤ 200 字时头尾相同；200–400 字时两段有重叠，找出来拼回全文；更长的中间丢了，用「…」接上并标截断。
 * @param {string} head
 * @param {string|undefined} tail
 * @returns {{text: string, truncated: boolean}}
 */
export function joinHeadTail(head, tail) {
  if (!tail || tail === head) return { text: head, truncated: false };
  for (let k = Math.min(head.length, tail.length) - 1; k >= MIN_OVERLAP; k--) {
    const overlap = tail.slice(0, k);
    if (!head.endsWith(overlap)) continue;
    // 「哈哈哈哈……」这种重复的文字随便哪里都对得上，拼不出可信的全文：当作中间丢了
    if (new Set(overlap).size < 4) break;
    return { text: head + tail.slice(k), truncated: false };
  }
  return { text: `${head}…${tail}`, truncated: true };
}

/**
 * 这条消息自己的文字（不含引用的原文）。工具结果里的消息经过桥接的压缩：和 text 相同的 plain / tail 被删掉了，这里补回来。
 * @param {import('./files.js').BridgeMessage} m
 */
export function ownText(m) {
  if (m.isSelf) {
    const t = m.plain ?? m.text ?? '';
    return { text: t, truncated: t.length >= BRIDGE_CUT };
  }
  const head = m.plain ?? m.text ?? '';
  return joinHeadTail(head, m.tail ?? head);
}

/** 引用段：桥接渲染成「[引用 名字：原文]」，引用不可解析时是「[引用消息]」。 */
export function parseQuote(m) {
  const t = m.text ?? '';
  if (!t.startsWith('[引用')) return null;
  const mm = /^\[引用(?: ([^\]]{0,400})|消息)?\]/.exec(t);
  if (!mm) return null;
  const inner = (mm[1] ?? '').trim();
  if (!inner) return { name: '', excerpt: '' };
  const i = inner.indexOf('：');
  return i < 0 ? { name: '', excerpt: inner.slice(0, 200) } : { name: inner.slice(0, i).trim().slice(0, 60), excerpt: inner.slice(i + 1).trim().slice(0, 200) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 把文字里的账号原值换掉：认识的换成名字，不认识的换成「某人」。
 * 认识的账号整词替换（前后不是字母数字）；另外兜底两种桥接的渲染：「@<5–12 位数字>」和「QQ <5–12 位数字>」。
 * @param {string} text
 * @param {Map<string, string>} known   账号 → 名字
 */
export function scrubAccounts(text, known) {
  let s = text;
  // 入群 / 退群：「名字（QQ 123）」里的括号整个去掉，只剩名字
  s = s.replace(/（QQ\s*([A-Za-z0-9_-]{1,64})）/g, '');
  for (const [id, name] of known) {
    if (!id || id.length < 3 || !s.includes(id)) continue;
    s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(id)}(?![A-Za-z0-9])`, 'g'), name || '某人');
  }
  s = s.replace(/@\d{5,12}(?!\d)/g, '@某人').replace(/QQ\s*\d{5,12}(?!\d)/g, '某人');
  // 拍一拍：桥接渲染成「[拍一拍] 名字 拍了拍 <被拍的人的账号>」（她自己拍别人是「我拍了拍 <账号>」），被拍的人没说过话就不认识
  s = s.replace(/(拍了拍|戳了戳)\s*\d{5,12}(?![A-Za-z0-9])/g, '$1 某人');
  return s;
}

/**
 * 桥接把视频、语音、文件段渲染成文字里的占位（bridge.js 的 segmentsToText：video →「[视频]」、record →「[语音]」、
 * file →「[文件<文件名>]」），它的媒体清单（extractMediaFromSegments）只记图片和表情：照占位补上媒体的种类（D116：她之后用工具看了它，
 * 她看到的就写进这一项）。只照桥接自己的占位格式，不带文件名、不带任何定位信息。图片、表情在清单里已经有了，这里不再补。
 */
const BRIDGE_PLACEHOLDERS = Object.freeze([[/\[视频\]/g, 'video'], [/\[语音\]/g, 'voice'], [/\[文件[^\]\n]{0,200}\]/g, 'file']]);
export function placeholderMedia(text) {
  const t = String(text ?? '');
  const out = [];
  if (!t.includes('[')) return out;
  for (const [re, kind] of BRIDGE_PLACEHOLDERS) {
    const n = t.match(re)?.length ?? 0;
    for (let i = 0; i < n && out.length < 16; i++) out.push({ kind });
  }
  return out;
}

/** 文字里的「[转发消息 id=…]」只留占位：id 是平台句柄，对记忆没用。 */
const stripForwardIds = (s) => s.replace(/\[转发消息 id=[^\]]{0,200}\]/g, '[转发消息]');

const AT_TOKEN = /^[^\s@，。！？,.!?:：\]\[]{1,30}/;
/** 认得的名字按首字分组、长的在前（「@」后面先找最长的认得的名字）。不到 2 个字的不收。 */
function atIndex(names) {
  const idx = new Map();
  const seen = new Set();
  for (const raw of names) {
    const n = typeof raw === 'string' ? raw.trim() : '';
    const low = n.toLowerCase();
    if ([...n].length < 2 || n.length > 60 || seen.has(low) || low.length !== n.length) continue;
    seen.add(low);
    const k = low[0];
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(low);
  }
  for (const list of idx.values()) list.sort((a, b) => b.length - a.length);
  return idx;
}

/**
 * 文字里提到的「@名字」（结构化的 @ 桥接没存，只剩渲染出来的「@<群名片或昵称>」，感知:210）。
 * 【D160】每个「@」后面先找认得的名字里最长的那个（成员名单、这个会话里认得的、她的名字）——「@阿明你好」是「阿明」，不是「阿明你好」；
 * 一个都对不上才照旧取到空白或标点为止。不到 2 个字的不算（和 mentionsHer 一样，「@我」不是在点谁的名，D108）。
 * @param {string} text
 * @param {Iterable<string>|Map<string, string[]>} [known]   认得的名字（或 atIndex 的结果）
 */
export function atNames(text, known = []) {
  const idx = known instanceof Map ? known : atIndex(known);
  const out = [];
  for (let i = text.indexOf('@'); i >= 0 && out.length < 16; i = text.indexOf('@', i + 1)) {
    const rest = text.slice(i + 1, i + 61);
    let name = '';
    const low = rest.toLowerCase();
    if (low.length === rest.length) {
      for (const n of idx.get(low[0]) ?? []) if (low.startsWith(n)) { name = rest.slice(0, n.length); break; }
    }
    if (!name) name = AT_TOKEN.exec(rest)?.[0] ?? '';
    if ([...name].length < 2 || name === '全体成员' || name === '某人' || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 她的名字出现在文字里（@她 或直接叫名字）。名字太短（< 2 字）的不算，免得误判。 */
export function mentionsHer(text, selfNames) {
  const lower = text.toLowerCase();
  return selfNames.some((n) => n.length >= 2 && lower.includes(n.toLowerCase()));
}

/**
 * ObsId：同一条消息不管从哪条路来（读文件、唤醒快照、读消息工具的结果）都得到同一个 id（§4.7 幂等）。
 * 有平台消息 id 的用它；拍一拍、系统通知没有，用本地序号 + 时间（会话重置后序号从 0 开始，时间不会重复）；
 * 她自己发的行既没有序号也没有消息 id，用时间 + 文本哈希。全部用适配器的盐做 HMAC，不含原值。
 * @param {Buffer|string} salt
 * @param {string} key
 * @param {import('./files.js').BridgeMessage} m
 */
export function obsIdOf(salt, key, m) {
  if (m.isSelf) return opaqueFrom(salt, 'qq/self', key, m.time, textHash(m.plain ?? m.text ?? ''));
  if (m.messageId) return opaqueFrom(salt, 'qq/msg', key, m.messageId);
  return opaqueFrom(salt, 'qq/seq', key, m.seq ?? -1, m.time);
}

const accountClaim = (id, verifiedBy = 'platform') => ({ kind: 'account', namespace: 'qq', id, verifiedBy });
export const PRINCIPAL_CLAIM = Object.freeze({ kind: 'principal', strength: 'config' });

/**
 * @typedef {object} MapContext
 * @property {string} key                会话 key（只在内存里，不进任何输出）
 * @property {'group'|'private'} kind
 * @property {string} settingId
 * @property {Buffer|string} salt
 * @property {string[]} selfNames
 * @property {Map<string, string>} known 账号 → 名字（换掉 text 里的账号原值用）
 * @property {number} now
 * @property {string} [selfAccount]      她的账号（配置给的；只在内存里）
 * @property {string} [ownerAccount]     主人的账号
 * @property {string} [selfCard]         她在这个群里平台上显示的名字（D160：成员名单里她那一行；没有名单时退回她自己那几行的 sender）
 * @property {Map<string, string>} [roster]   【D160】这个群的成员名单：账号 → 平台上显示的名字（只在内存里）；没有名单就不给
 * @property {string} [principalLabel]   她对主人的称呼（knownNames 拿它顶替主人的名字；这种名字不当成主人在群里的名字记）
 */
/**
 * @typedef {object} MapOptions
 * @property {'attended'|'peripheral'} attention
 * @property {boolean} [historical]
 * @property {boolean} [onMyBehalf]      她自己的行能对上主人登记的定时文字（结构证据，§9.5）
 * @property {string} [appraisalToken]   对上了 pre-execute 发出的审视令牌
 * @property {{sessionId: string, seq?: number, callId?: string}} [sessionRef]
 * @property {string} [settingId]        覆盖：替主人看别的群时，事情发生在那个群
 * @property {string} [perceivedInSettingId]
 * @property {'setting-audience'|'her-only'|'participants'} [visibleTo]
 */

/**
 * @param {import('./files.js').BridgeMessage} m
 * @param {MapContext} ctx
 * @param {MapOptions} opt
 * @returns {import('rugu-core/contract').Observation|null}
 */
export function toObservation(m, ctx, opt) {
  if (m?.kind === 'recall') return null;   // dsh-qq 1.1.2 的撤回记录（「[已撤回一条消息]」）：只是桥接留给上下文的，不是她说的话
  const settingId = opt.settingId ?? ctx.settingId;
  const group = ctx.kind === 'group';
  const { text: raw, truncated } = ownText(m);
  const text = stripForwardIds(scrubAccounts(raw, ctx.known)).slice(0, 32_000);
  const media = [...(m.media ?? []).map((x) => ({ ...x })), ...placeholderMedia(raw)].slice(0, 16);
  if (m.hasForward) media.push({ kind: 'forward' });
  if (!text.trim() && !media.length) return null;

  const base = {
    id: obsIdOf(ctx.salt, ctx.key, m),
    settingId,
    perceivedInSettingId: opt.perceivedInSettingId,
    visibleTo: opt.visibleTo ?? (group ? 'setting-audience' : 'participants'),
    at: m.time,
    perceivedAt: Math.max(ctx.now, m.time),
    text,
    textTruncated: truncated || undefined,
    media: media.length ? media : undefined,
    attention: opt.attention,
    historical: opt.historical || undefined,
    sessionRef: opt.sessionRef,
  };

  // 先判 isSelf：她自己的行 isOwner 也是 true（C2）
  if (m.isSelf) {
    // 她自己的群名片也记成她的名字（只在这个场合算数，D108）：别人 @ 这个名片时认得出是她，不另造一个「人」。
    // 【D160】真的桥接把她的行一律写成「我」，名片只能从成员名单来（ctx.selfCard）
    const card = group ? cardOf(m.sender) || ctx.selfCard || '' : '';
    return clean({
      ...base,
      actor: { self: true, claims: card ? [{ kind: 'display-name', name: card, scope: settingId, observedAt: m.time }] : [] },
      kind: opt.onMyBehalf ? 'on-my-behalf' : 'self-utterance',
      addressed: 'by-her',
      attention: 'attended',
      evidential: true,
      standing: opt.onMyBehalf ? 'platform' : 'first-hand',
      appraisalToken: opt.onMyBehalf ? undefined : opt.appraisalToken,
    });
  }

  const claims = [];
  if (m.userId) claims.push(accountClaim(m.userId));
  const name = group && m.sender && m.sender !== m.userId && !/^\d{5,12}$/.test(m.sender) ? m.sender.trim().slice(0, 60) : '';
  if (name && m.kind !== 'notice') claims.push({ kind: 'display-name', name, scope: settingId, observedAt: m.time });
  if (m.isOwner) claims.push({ ...PRINCIPAL_CLAIM });
  const actor = { claims };

  if (m.kind === 'poke') {
    const target = m.poke?.targetIsSelf || m.quoteTargetIsSelf ? { self: true, claims: [] }
      : m.poke?.targetId ? { claims: [accountClaim(m.poke.targetId)] } : null;
    return clean({
      ...base, actor, kind: 'action', mentions: target ? [target] : undefined,
      addressed: target?.self || !group ? 'to-her' : 'ambient',
      evidential: false, standing: 'platform',   // 拍一拍的后缀是被拍的人自己设的（v1:415）
    });
  }
  if (m.kind === 'notice') {
    return clean({ ...base, actor, kind: 'presence', addressed: 'ambient', evidential: false, standing: 'platform' });
  }

  const quote = parseQuote(m);
  let quoteOut;
  if (quote && (quote.excerpt || quote.name || m.quoteTargetIsSelf)) {
    const author = m.quoteTargetIsSelf ? { self: true, claims: [] }
      : quote.name ? { claims: [{ kind: 'display-name', name: quote.name, scope: settingId, observedAt: m.time }] } : undefined;
    quoteOut = clean({ excerpt: quote.excerpt ? scrubAccounts(quote.excerpt, ctx.known) : undefined, author });
  }
  const { selfNames, selfLower, byName, index } = lookupOf(ctx);
  const herNamed = mentionsHer(text, selfNames);
  const selfCardLow = ctx.selfCard ? ctx.selfCard.toLowerCase() : '';
  const nameClaim = (name) => ({ kind: 'display-name', name: name.slice(0, 60), scope: settingId, observedAt: m.time });
  // 「@名字」按账号 → 名字反查（D108；D160 加上群成员名单）：正好一个账号、是她 → 她；是别人 → 那个账号 + 这个名字
  // （从没在这里说过话的人也有了名字；主人另带主人的声明）；对不上或不止一个 → 只有名字（照旧）。
  // 点的是她在平台上的名字时带上这个名字（核心把它记成她在这个场合的名字）；点她配置里的名字不带（selfClaims 里已经有了）
  const herMention = (n) => ({ self: true, claims: selfCardLow && n.toLowerCase() === selfCardLow ? [nameClaim(ctx.selfCard)] : [] });
  const mentions = atNames(text, index).map((n) => {
    const low = n.toLowerCase();
    if (selfLower.has(low)) return herMention(n);
    const accts = [...(byName.get(low)?.keys() ?? [])];
    if (accts.length === 1) {
      const a = accts[0];
      if (ctx.selfAccount && a === ctx.selfAccount) return herMention(n);
      const owner = !!ctx.ownerAccount && a === ctx.ownerAccount;
      // 顶替用的称呼（「主人」）不是他在群里的名字，不记
      const real = byName.get(low).get(a);
      return { claims: [accountClaim(a), ...(real ? [nameClaim(n)] : []), ...(owner ? [{ ...PRINCIPAL_CLAIM }] : [])] };
    }
    return { claims: [nameClaim(n)] };
  });
  if (herNamed && !mentions.some((x) => x.self)) mentions.push({ self: true, claims: [] });
  const addressed = !group || m.quoteTargetIsSelf ? 'to-her' : herNamed ? 'mentions-her' : 'ambient';
  return clean({
    ...base, actor, kind: 'utterance', quote: quoteOut, mentions: mentions.length ? mentions.slice(0, 64) : undefined,
    addressed, evidential: true, standing: 'first-hand',
  });
}

/** 一个 MapContext 的名字表（一批消息共用一个 ctx，只算一次）。 */
const lookups = new WeakMap();
function lookupOf(ctx) {
  let l = lookups.get(ctx);
  if (l) return l;
  const selfNames = [...(ctx.selfNames ?? []), ...(ctx.selfCard ? [ctx.selfCard] : [])];
  /** 名字（小写）→ (账号 → 这是不是他在平台上真的名字) @type {Map<string, Map<string, boolean>>} */
  const byName = new Map();
  const add = (acct, n, real) => {
    if (!acct || typeof n !== 'string' || !n || n === '某人' || n === '对方') return;
    const k = n.toLowerCase();
    if (!byName.has(k)) byName.set(k, new Map());
    const m = byName.get(k);
    m.set(acct, m.get(acct) === true || real);
  };
  for (const [acct, n] of ctx.roster ?? []) add(acct, n, true);
  for (const [acct, n] of ctx.known ?? []) {
    add(acct, n, !(ctx.principalLabel && acct === ctx.ownerAccount && n === ctx.principalLabel));
  }
  const index = atIndex([...byName.keys(), ...selfNames]);
  l = { selfNames, selfLower: new Set(selfNames.map((n) => n.toLowerCase())), byName, index };
  lookups.set(ctx, l);
  return l;
}

function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** 她自己那一行的 sender 当群名片用：不是账号样的数字、不是「我」、至少 2 个字。 */
function cardOf(sender) {
  const t = typeof sender === 'string' ? sender.trim().slice(0, 30) : '';
  return t && [...t].length >= 2 && !/^\d{5,12}$/.test(t) && t !== '私聊' ? t : '';
}

/** 她在这个会话里现在的群名片（她自己最近一行的 sender），没有返回 ''。 */
export function selfCardOf(msgs) {
  let card = '';
  for (const m of msgs) if (m?.isSelf) card = cardOf(m.sender) || card;
  return card;
}

/**
 * 这个会话里认识的账号 → 名字（群里取最近一次的群名片），外加配置里的主人和她自己。
 * 她的账号换成她现在的群名片（没有就第一个名字），主人的换成他现在的群名片（没有就主人的称呼）——原来她的账号换成「我」，
 * 「@<她的账号>」就成了「@我」，被认成了一个叫「我」的人（D108）。
 * 【D160】群里有成员名单时：名单里的人先全部认得（从没说过话的人的账号也换成名字），她的账号换成名单里她的名字（o.selfCard）。
 * @param {Iterable<import('./files.js').BridgeMessage>} msgs
 * @param {{ownerId?: string, selfId?: string, principalLabel: string, kind: 'group'|'private', peerId?: string, selfNames?: string[],
 *   selfCard?: string, roster?: Map<string, string>}} o
 */
export function knownNames(msgs, o) {
  const known = new Map();
  const list = [...msgs];
  if (o.kind === 'private' && o.peerId) known.set(o.peerId, '对方');
  if (o.kind === 'group' && o.roster) for (const [acct, n] of o.roster) if (acct && n) known.set(acct, n.slice(0, 30));
  for (const m of list) {
    // 被拍的人可能从没说过话：账号也要认得（换成「某人」），不然原值留在拍一拍的文字里
    const target = m.poke?.targetId;
    if (target && !m.poke.targetIsSelf && !known.has(target)) known.set(target, '某人');
    if (m.isSelf || !m.userId || m.kind === 'notice') continue;
    const n = m.sender && m.sender !== m.userId && m.sender !== '私聊' && !/^\d{5,12}$/.test(m.sender) ? m.sender.trim().slice(0, 30) : '';
    if (n || !known.has(m.userId)) known.set(m.userId, n || '某人');
  }
  if (o.ownerId) {
    const cur = o.kind === 'group' ? known.get(o.ownerId) : null;
    known.set(o.ownerId, cur && cur !== '某人' ? cur : o.principalLabel);
  }
  if (o.selfId) known.set(o.selfId, (o.kind === 'group' && o.selfCard) || selfCardOf(list) || (o.selfNames ?? []).find((x) => typeof x === 'string' && x.trim()) || '她');
  return known;
}
