// 她自己和主人这两个特殊的档案（§5.2、§5.7）。
// 「主人」在核心里只是两个通用属性：亲密度最高（closeness=1）+ 有管理权限（authority='principal'）。
// 她的称呼（selfProfile.principalLabel）登记成主人的保留名：别人不能用名片冒用它，账号证据不能把别人挂到主人身上；
// 它不会把文中提到的同名的人强制认成主人（名字匹配器照常把同名的都返回）。
import { getMeta, setMeta } from '../store/index.js';
import { createEntity, addName, getEntity, setDisplay, flushEmbeds, warn, errName } from './records.js';

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
