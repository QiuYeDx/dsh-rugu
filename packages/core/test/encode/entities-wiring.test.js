// encode 和真的 entities 接起来（只换 entities，其余照旧是替身）：提炼输出的 ent 行经 resolveExtracted 落成档案。
//   - 「我表哥小刚」→ 锚点本人说的关系描述（msgRefs 交过去才知道是谁说的）；
//   - 自我介绍（"is"）→ 只到 maybe_same；锚点本人当面说「对，他就是我表哥」→ same（anchor-confirmed，权利层，§5.2、S8b）；
//   - 锚点是候选档案的编号（candidateCodes）时描述不丢。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as entities from '../../src/entities/index.js';
import { makeWorld, codeIn, msgIn, ADAPTER } from './harness.js';

async function world() {
  const w = await makeWorld({ mods: { entities: { ...entities } } });
  entities.init(w.core);
  return w;
}

const link = (w, a, b) => {
  const r = w.core.store.get('SELECT rel, decided_by FROM entity_links WHERE a = ? AND b = ?', Math.min(a, b), Math.max(a, b));
  return r ? { ...r } : null;
};

test('真的 entities：锚点本人说「我表哥小刚」；之后自称是他表哥的人只到 maybe_same，阿明当面确认才有权利', async () => {
  const w = await world();
  try {
    const E = w.core.mods.entities;
    const ming = w.entity('阿明', { closeness: 0.3 });
    const g = w.setting('游戏群', { exposure: 2 });
    w.percept(g, ming, '我表哥小刚开网约车');
    w.llm.push('extract', (req) => [
      { type: 'narrative', text: '阿明说他表哥小刚开网约车。' },
      { type: 'ent', id: 'E1', name: '小刚', kind: 'person', individual: true, anchor: codeIn(req, '阿明'), relation: '表哥', msgRefs: [msgIn(req, '我表哥小刚')] },
    ]);
    assert.deepEqual((await w.extractAll(g)).map((o) => o.status), ['written']);
    const cousin = w.core.store.get("SELECT entity_id FROM entity_names WHERE text_raw = '小刚'").entity_id;
    assert.deepEqual(E.profile(w.core, cousin).descriptors.map((d) => [d.anchor, d.basis]), [[ming, 'first-person']], '知道是阿明本人说的');
    assert.equal(w.core.store.get("SELECT used_by FROM entity_names WHERE entity_id = ? AND text_raw = '小刚'", cousin).used_by, ming);

    // 两天后：一个新账号进群自称是阿明的表哥
    w.clock.minutes(2 * 24 * 60);
    const gx = w.entity('gx', { status: 'provisional' });
    w.percept(g, gx, '我是阿明的表哥');
    w.llm.push('extract', (req) => [
      { type: 'narrative', text: 'gx 说他是阿明的表哥。' },
      { type: 'ent', id: 'E1', is: codeIn(req, 'gx'), name: null, kind: 'person', anchor: codeIn(req, '阿明'), relation: '表哥', msgRefs: [msgIn(req, '我是阿明的表哥')] },
    ]);
    assert.deepEqual((await w.extractAll(g)).map((o) => o.status), ['written']);
    assert.deepEqual(link(w, gx, cousin), { rel: 'maybe_same', decided_by: 'extractor' }, '自称：认得出');
    assert.equal(E.rightsHolder(w.core, gx, cousin), false, '自称不给权利');
    assert.ok(w.core.store.get("SELECT 1 AS x FROM entity_descriptors WHERE entity_id = ? AND basis = 'self-claim'", gx));
    // 半小时后阿明当面确认（gx 也在这一段里说话）
    w.clock.minutes(30);
    w.percept(g, ming, '对，他就是我表哥');
    w.clock.minutes(1);
    w.percept(g, gx, '嗯嗯');
    w.llm.push('extract', (req) => [
      { type: 'narrative', text: '阿明确认 gx 是他表哥。' },
      { type: 'ent', id: 'E1', is: codeIn(req, 'gx'), name: null, kind: 'person', anchor: codeIn(req, '阿明'), relation: '表哥', msgRefs: [msgIn(req, '他就是我表哥')] },
    ]);
    assert.deepEqual((await w.extractAll(g)).map((o) => o.status), ['written']);
    assert.deepEqual(link(w, gx, cousin), { rel: 'same', decided_by: 'anchor-confirmed' });
    assert.equal(E.rightsHolder(w.core, gx, cousin), true, '锚点本人当面确认（§5.2 权利层）');
  } finally { await w.cleanup(); }
});

test('真的 entities：锚点是候选档案的编号（阿明不在这一段里）时，「阿明的表哥」的描述照样记上', async () => {
  const w = await world();
  try {
    const E = w.core.mods.entities;
    const ming = w.entity('阿明', { closeness: 0.3 });
    const jie = w.entity('阿杰');
    const g = w.setting('游戏群', { exposure: 2 });
    w.percept(g, jie, '阿明的表哥又换车了');
    w.llm.push('extract', (req) => [
      { type: 'narrative', text: '阿杰说阿明的表哥又换车了。' },
      { type: 'ent', id: 'E1', name: null, kind: 'person', anchor: codeIn(req, '阿明'), relation: '表哥', msgRefs: [msgIn(req, '阿明的表哥')] },
    ]);
    assert.deepEqual((await w.extractAll(g)).map((o) => o.status), ['written']);
    const row = w.core.store.get('SELECT entity_id, basis, speaker_entity_id FROM entity_descriptors WHERE anchor_entity_id = ?', ming);
    assert.ok(row, '锚点 c 编号认得出（§7.4 第 12 条「已知」）');
    assert.equal(row.basis, 'third-party', '阿杰说的：旁人的描述');
    assert.equal(row.speaker_entity_id, jie);
    assert.equal(E.profile(w.core, row.entity_id).kind, 'person');
  } finally { await w.cleanup(); }
});

test('真的 entities：入库时没认出来的说话人带着适配器给的自我介绍——卡片里带那条消息的编号，"is" 行落到给他新立的档案上（自称），锚点是候选档案', async () => {
  const w = await world();
  try {
    const E = w.core.mods.entities;
    const ming = w.entity('阿明', { closeness: 0.3 });
    const g = w.setting('游戏群', { exposure: 2 });
    const p = w.percept(g, null, '我是阿明的表哥，开网约车的', { displayName: '老g', obsId: 'obs-intro' });
    const actor = JSON.parse(w.core.store.get('SELECT actor_json FROM percepts WHERE id = ?', p).actor_json);
    actor.claims.push({ kind: 'self-introduction', text: '我是阿明的表哥', obsKey: w.core.keys.obsKey(ADAPTER, 'obs-intro') });
    w.core.store.run('UPDATE percepts SET actor_json = ? WHERE id = ?', JSON.stringify(actor), p);
    let seen = null;
    w.llm.push('extract', (req) => {
      seen = req;
      const [U, c, m] = [codeIn(req, '老g'), codeIn(req, '阿明'), msgIn(req, '我是阿明的表哥')];
      return [
        { type: 'narrative', text: '一个新人说他是阿明的表哥，开网约车。' },
        { type: 'ent', id: 'E1', is: U, name: null, kind: 'person', anchor: c, relation: '表哥', msgRefs: [m] },
        { type: 'fact', id: 'f1', subjects: ['E1'], speaker: U, certainty: 'stated', predicate: '职业', value: '网约车司机', text: 'E1开网约车', kind_hint: 'state', msgRefs: [m] },
      ];
    });
    assert.deepEqual((await w.extractAll(g)).map((o) => o.status), ['written']);
    assert.match(seen.messages[0].content, /\[U1 老g\]（还没认出是谁；自我介绍（m1）：「我是阿明的表哥」）/);
    const d = w.core.store.get('SELECT entity_id, basis, speaker_entity_id FROM entity_descriptors WHERE anchor_entity_id = ?', ming);
    assert.ok(d, '锚点是候选档案（阿明不在这一段里）');
    assert.equal(d.basis, 'self-claim', '他自己说的：自称，不给权利');
    assert.equal(d.speaker_entity_id, d.entity_id, '「is」那一行就是给这个说话人新立的档');
    assert.equal(E.profile(w.core, d.entity_id).displayName, '老g');
    const [f] = w.assertions();
    const subs = w.core.store.all("SELECT entity_id FROM assertion_entities WHERE assertion_id = ? AND role = 'subject'", f.id).map((r) => r.entity_id);
    assert.deepEqual(subs, [d.entity_id], 'E1 就是这个说话人');
    assert.equal(f.certainty, 'stated', '本人说自己的事');
  } finally { await w.cleanup(); }
});
