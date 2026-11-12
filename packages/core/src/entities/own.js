// 她自己和主人这两个特殊的档案（§5.2、§5.7）。
// 「主人」在核心里只是两个通用属性：亲密度最高（closeness=1）+ 有管理权限（authority='principal'）。
// 她的称呼（selfProfile.principalLabel）登记成主人的保留名：别人不能用名片冒用它，账号证据不能把别人挂到主人身上；
// 它不会把文中提到的同名的人强制认成主人（名字匹配器照常把同名的都返回）。
import { getMeta, setMeta } from '../store/index.js';
import { createEntity, addName, getEntity, setDisplay, flushEmbeds, warn, errName, moveEvidence, markDirty, bump, STRENGTH_RANK } from './records.js';
import { link } from './links.js';

const PRINCIPAL_META = 'entities.principalId';

/** 她自己（is_self=1，kind='self'）；没有就建。 */
export function ensureSelf(core) {
  const row = core.store.get('SELECT id FROM entities WHERE is_self = 1');
  if (row) return row.id;
  return core.store.tx(() => {
    const again = core.store.get('SELECT id FROM entities WHERE is_self = 1');
    if (again) return again.id;
    // 她和她自己的亲密度取 1（她自己的经历按「最亲近的说话人」编码）；她没有管理权限（authority='none'），所以不会被当成主人
    return createEntity(core, { kind: 'self', status: 'established', isSelf: true, closeness: 1, individual: false, at: core.now() });
  });
}

/** 主人的实体（authority='principal'，closeness=1）；没有就建。 */
export function ensurePrincipal(core) {
  const st = core.state.entities ?? (core.state.entities = {});
  let id = null;
  const metaId = Number(getMeta(core.store, PRINCIPAL_META));
  if (Number.isInteger(metaId) && metaId > 0) {
    const e = getEntity(core, metaId);
    if (e && e.authority === 'principal' && !e.is_self) id = e.id;
  }
  if (id == null) {
    id = core.store.tx(() => {
      const ex = core.store.get(`SELECT id FROM entities WHERE authority = 'principal' AND is_self = 0
        ORDER BY closeness DESC, id ASC LIMIT 1`);
      const pid = ex?.id ?? createEntity(core, {
        kind: 'person', status: 'established', closeness: 1, authority: 'principal', individual: true, at: core.now(),
      });
      setMeta(core.store, PRINCIPAL_META, pid);
      return pid;
    });
  }
  // 她对主人的称呼是主人的保留名（这个进程里称呼变了才再写一次）
  let label = '';
  try { label = String(core.ports.selfProfile?.principalLabel?.() ?? '').trim(); } catch (e) { warn(core, 'entities.principalLabel.error', { error: errName(e) }); }
  if (label && st.principalLabelSynced !== `${id}\u0000${label}`) {
    core.store.tx(() => {
      addName(core, id, { raw: label, kind: 'config', reserved: true, at: core.now() });
      setDisplay(core, id, label, 'config');
      flushEmbeds(core);
    });
    core.store.afterCommit(() => { st.principalLabelSynced = `${id}\u0000${label}`; });
  }
  return id;
}

export const isReservedOwner = (e) => !!e && (e.is_self === 1 || e.authority === 'principal');

/**
 * 【D162】她自己的账号（适配器在她的 ActorRef 里给的、核实过的）已经挂在别的档案上：把这条身份证据改挂到她身上。
 * 为什么可以：适配器说「self: true」和「这就是她」是同一句话，整个「认出她」都靠它；哪个账号是她的，也该由适配器说。
 * 以前适配器不知道她的账号时，「@她的平台名」被当成一个普通群友，核心为她的账号另立了一个档案（D160 之后的实测）。
 * 只从没有管理权限的普通档案上拿；有管理权限的（主人等）不动，照旧算冲突。
 * 拿走以后那个档案：自己还说过话、还有别的证据或关系描述的，和她挂 same（decidedBy = platform：它用这个账号说过的话就是她说的，
 * 和适配器晚注册时原来的做法一样）；什么都没有了的不挂、不在这里撤——调用方记完名字再跑修复，名字都是她的就被撤掉
 * （挂上 same 它就永远撤不掉了）。只记编号，不记账号。
 * @param {{id: number, entity_id: number, strength: string}} ev   findEvidence 找到的那一条
 * @returns {{moved: boolean, from: number|null, linked: boolean}}
 */
export function reclaimOwnAccount(core, selfId, ev, strength) {
  const holder = getEntity(core, ev.entity_id);
  if (!holder || holder.id === selfId || holder.is_self === 1 || holder.authority !== 'none') return { moved: false, from: null, linked: false };
  // 强度不降：原来那条比这次说的强（主人确认过），按原来的
  const keep = (STRENGTH_RANK[ev.strength] ?? 0) > (STRENGTH_RANK[strength] ?? 0) ? ev.strength : strength;
  moveEvidence(core, ev.id, selfId, keep);
  markDirty(core, selfId);
  markDirty(core, holder.id);
  bump(core, 'entities.identity.selfReclaimed');
  warn(core, 'entities.identity.selfReclaimed', { entity: selfId, from: holder.id });
  const linked = hasOwnFooting(core, holder.id);
  if (linked) link(core, selfId, holder.id, { rel: 'same', confidence: 1, evidence: ['adapter-claims'], decidedBy: 'platform', at: core.now() });
  return { moved: true, from: holder.id, linked };
}

/** 一个档案自己还有没有「是一个人」的东西：说过话、还有身份证据、有关系描述（和修复里的 BARE 是同一个尺子）。 */
function hasOwnFooting(core, id) {
  return !!core.store.get(`SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM percepts WHERE actor_entity_id = ?)
      OR EXISTS (SELECT 1 FROM identity_evidence WHERE entity_id = ?) OR EXISTS (SELECT 1 FROM entity_descriptors WHERE entity_id = ?)`, id, id, id);
}
