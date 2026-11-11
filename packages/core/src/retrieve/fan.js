// 实体线索的强度（§6.5 扇出效应，D149）：实体扩散的种子是谁、各有多强。
//   种子的有效权重 = 名义权重（线索的来源：她正被问的那句话里的名字最强，窗口里早几行的名字弱一些，正在说话的人、在场的人是情境，
//   只当弱种子）× 线索有多专门（dynamics.fanSpecificity：一个连着几百件事的人，对其中每一件都是弱线索）。
//   实体路（routes.js entityRoute）用它给 PPR 的种子定权重，激活打分（pipeline.js）用它定 S 的整体大小和扇出项。
import { entityToken } from '../store/fts.js';
import { rowsByIds, safe, selfId } from './util.js';

/**
 * 实体名下有多少条记忆（扇出项的 fan，§6.5「fan 是这个实体名下的记忆条数」）：关于他的事实（主体、宾语、提到他），
 * 加上他在场的情节——只数事实的话，事实少、聊得多的人每段经历都像是专门的线索。
 * 情节按 episodes_fts 里的实体词元数（ent_<id> 就是情节的参与者，encode 写情节时加的），走 FTS 索引，不扫情节表。
 * @param {import('../core-types.js').CoreContext} core
 * @param {Iterable<number>} ids
 * @returns {Map<number, number>}
 */
export function fanOf(core, ids) {
  const m = new Map();
  const list = [...new Set(ids)].filter(Number.isInteger);
  if (!list.length) return m;
  const rows = safe(core, 'fan', () => rowsByIds(core.store,
    "SELECT entity_id AS e, COUNT(*) AS n FROM assertion_entities WHERE entity_id IN (?*) AND role IN ('subject','object','mention') GROUP BY entity_id",
    list), []);
  const facts = new Map((rows ?? []).map((r) => [r.e, Number(r.n) || 0]));
  for (const e of list) {
    const eps = Number(safe(core, 'fanEpisodes', () => core.store.get('SELECT count(*) AS n FROM episodes_fts WHERE episodes_fts MATCH ?',
      `"${entityToken(e)}"`)?.n, 0)) || 0;
    m.set(e, Math.max(1, (facts.get(e) ?? 0) + eps));
  }
  return m;
}

/** 记忆单元总数 N（还没被取代的事实 + 情节），扇出项的分母。查不了按 0（fanSpecificity 用 activation.fanMinTotal 兜底）。 */
export function memoryTotal(core) {
  const a = Number(safe(core, 'memTotalA', () => core.store.get('SELECT count(*) AS n FROM assertions WHERE superseded_by IS NULL')?.n, 0)) || 0;
  const e = Number(safe(core, 'memTotalE', () => core.store.get('SELECT count(*) AS n FROM episodes')?.n, 0)) || 0;
  return a + e;
}

/**
 * 实体扩散的种子（D149）：实体 id → { nominal（名义权重）, weight（有效权重 = 名义 × 专门程度）, spec }。
 * 名义权重（recall.entity.seedWeights）：
 *   - 名字：出现在焦点里（有意回想的 query / about、她正被问的那一句）的是内容线索，name；只出现在窗口里更早几行的，nameWindow；
 *   - 结构化的 @ / 引用 / 回复：mentioned；
 *   - 正在说话的人：focus；在场的人：present——这两样是情境不是内容（情境另有 γ 项和在场者近况那一路），只当弱种子；
 *     话里点到了他（名字、@），按名字的权重算（取大的）；
 *   - 没有任何内容线索的轮（她自己开口：没有对她说的那句、也没有 query）：在场的人就是唯一的线索，按 alone；
 *   - 词法前几条事实涉及的实体：fact（factIds 给了才算）。
 * 不含她自己。
 * @param {import('../core-types.js').CoreContext} core
 * @param {object} cues  buildCues 的结果
 * @param {object} sw    recall.entity.seedWeights
 * @param {number[]} [factEntities]
 * @returns {{seeds: Map<number, {nominal: number, weight: number, spec: number}>, strength: number, nominalMax: number, total: number, fan: Map<number, number>}}
 *   strength = 这一批里最强的有效权重 / 名义上最强的权重（0–1）：没有强线索时，S 整体就低
 */
export function entitySeeds(core, cues, sw, factEntities = []) {
  const me = selfId(core);
  const nominal = new Map();
  const add = (id, w) => { if (Number.isInteger(id) && id !== me && w > 0) nominal.set(id, Math.max(nominal.get(id) ?? 0, w)); };
  const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
  const wName = num(sw.name, 1);
  const wWin = num(sw.nameWindow, wName);
  for (const n of cues.names ?? []) {
    const base = n.focus === false ? wWin : wName;
    add(n.entityId, base * Math.max(0.1, Math.min(1, n.score || 1)));
  }
  for (const e of cues.mentioned ?? []) add(e, num(sw.mentioned, 1));
  const content = cues.contentCue !== false;
  add(cues.focusSpeaker, num(sw.focus, 1));
  for (const e of cues.present ?? []) add(e, content ? num(sw.present, 0.5) : num(sw.alone, num(sw.present, 0.5)));
  for (const e of factEntities) add(e, num(sw.fact, 0.5));
  const total = memoryTotal(core);
  const fan = fanOf(core, nominal.keys());
  const spec = (e) => safe(core, 'fanSpec', () => core.mods.dynamics.fanSpecificity(core, fan.get(e) ?? 1, total), 1);
  const seeds = new Map();
  for (const [e, w] of nominal) {
    const s = spec(e);
    seeds.set(e, { nominal: w, weight: w * s, spec: s });
  }
  const nominalMax = Math.max(1e-9, ...['name', 'nameWindow', 'mentioned', 'focus', 'present', 'alone', 'fact'].map((k) => num(sw[k], 0)));
  const strongest = Math.max(0, ...[...seeds.values()].map((x) => x.weight));
  return { seeds, strength: Math.min(1, strongest / nominalMax), nominalMax, total, fan };
}
