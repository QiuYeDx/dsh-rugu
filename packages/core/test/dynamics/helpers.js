// dynamics 测试共用：测试核心（真库、真迁移），几张别的模块的表直接插行当夹具（只是数据，不依赖那些模块的实现）。
import { createTestCore } from '../fakes/test-core.js';
import { refOf } from '../../src/store/refs.js';

export const H = 3_600_000;
export const D = 24 * H;
export const M = 60_000;
/** 2026-11-02 00:00 东八区（测试一律用 tzOffsetMin = 480，时间格和「同一天」才是确定的） */
export const T0 = Date.UTC(2026, 10, 1, 16, 0);

export async function withCore(fn, { config = {}, name = 'dynamics' } = {}) {
  const { core, cleanup, ports } = await createTestCore({ name, config: { time: { tzOffsetMin: 480 }, ...config } });
  try { return await fn(core, ports); } finally { await cleanup(); }
}

export function insertEntity(core, { kind = 'person', name = null, closeness = 0, authority = 'none', isSelf = 0, at = T0 } = {}) {
  return Number(core.store.run(`INSERT INTO entities(kind, display_name, closeness, authority, is_self, first_mention_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, kind, name, closeness, authority, isSelf, at, at, at).lastInsertRowid);
}
export function insertImpression(core, entityId, { layer = 'shared', text = '印象', at = T0 } = {}) {
  return Number(core.store.run(`INSERT INTO entity_impressions(entity_id, layer, text, version, is_current, built_at) VALUES (?, ?, ?, 1, 1, ?)`,
    entityId, layer, text, at).lastInsertRowid);
}
export function insertAssertion(core, { text = '一条事实', at = T0, ...cols } = {}) {
  const r = core.store.run(`INSERT INTO assertions(predicate, text, certainty, recorded_at, created_at, updated_at, valid_from, t50_h, shape, change_known)
    VALUES ('p', ?, 'stated', ?, ?, ?, ?, ?, ?, ?)`, text, at, at, at, cols.valid_from ?? at, cols.t50_h ?? null, cols.shape ?? null, cols.change_known ?? 0);
  return Number(r.lastInsertRowid);
}
export function insertPercept(core, { at = T0, wEnc = 1, settingKey = 'sk', ext = `x${Math.random()}` } = {}) {
  return Number(core.store.run(`INSERT INTO percepts(adapter, ext_key, setting_key, perceived_in, visible_to, at, perceived_at, actor_json, kind,
      text, text_hash, addressed, attention, attention_class, evidential, standing, w_enc, created_at)
    VALUES ('fake', ?, ?, ?, 'setting-audience', ?, ?, '{}', 'utterance', '……', 'h', 'to-her', 'attended', 'toHer', 1, 'first-hand', ?, ?)`,
  ext, settingKey, settingKey, at, at, wEnc, at).lastInsertRowid);
}
export function insertIntention(core, { state = 'armed', at = T0, suppressedAt = null } = {}) {
  return Number(core.store.run(`INSERT INTO intentions(act, text, origin, state, formed_at, suppressed_at, created_at, updated_at)
    VALUES ('ask', '问问', 'self-care', ?, ?, ?, ?, ?)`, state, at, suppressedAt, at, at).lastInsertRowid);
}

/** 被问到时（有意回想）在线索强度 S 下想起来的概率（不加噪声，用 P）。 */
export function askedP(core, ref, at, S = 1.0) {
  const [c] = core.mods.dynamics.activate(core, [{ candidate: { ref: refOf(ref.kind, ref.id), mref: ref, ranks: {}, rrf: 0, signals: {} }, S, C: 0, superseded: false }],
    { at, mode: 'deliberate', seed: ['t'] });
  return c.P;
}
