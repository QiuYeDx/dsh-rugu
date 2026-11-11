// 提炼的输出被上限截断（D141）：不当成功、不写半截；这一段按消息数对半拆成两段各自提炼，两段的结果都写进去且不重复；
// 端口没给停止原因时，最后一行坏了而且输出量接近上限才按截断算（输出很短的坏行是模型自己写坏的，照旧只跳过那一行）；
// 拆到一条消息还截断的走失败 / 搁置（D136）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, codeIn, msgIn } from './harness.js';
import { enqueueJob } from '../../src/store/index.js';
import { splitPoint } from '../../src/encode/segment.js';

const HOBBIES = ['钓鱼', '爬山', '下棋', '做饭'];
const metric = (core, name) => core.store.all('SELECT value FROM metrics WHERE name = ?', name).reduce((a, r) => a + r.value, 0);

/** 提示词里有哪几条消息，就给哪几条各一条事实。 */
function linesFor(req) {
  const U = codeIn(req, '阿明');
  const out = [{ type: 'header', title: '聊爱好', text: '阿明聊爱好' }, { type: 'narrative', text: '阿明说了几样爱好。' }];
  HOBBIES.forEach((h, i) => {
    let m;
    try { m = msgIn(req, `我喜欢${h}`); } catch { return; }
    out.push({ type: 'fact', id: `f${i + 1}`, subjects: [U], speaker: U, predicate: `爱好${i + 1}`, text: `阿明喜欢${h}`, kind_hint: 'preference', msgRefs: [m], imp: 5 });
  });
  return out;
}
/** 写到第一条事实，第二条写到一半被截掉。 */
const cut = (req) => [...linesFor(req).slice(0, 3), '{"type":"fact","id":"f2","subjects":["U1"],"text":"阿明喜欢爬'];

async function setup(opt) {
  const w = await makeWorld(opt);
  const ming = w.entity('阿明', { closeness: 0.3 });
  const g = w.setting('游戏群', { exposure: 2 });
  const ids = [];
  for (const h of HOBBIES) { ids.push(w.percept(g, ming, `我喜欢${h}`)); w.clock.minutes(1); }
  w.llm.fallback.extract = linesFor;
  return { w, ming, g, ids };
}
async function drain(w) {
  const outs = [];
  for (let i = 0; i < 20; i++) {
    const r = await w.runNext();
    if (!r) break;
    outs.push(r);
  }
  return outs;
}

test('端口说「长度到了」：这一次什么都不写、不封口；对半拆成两段各自提炼，两段的结果都写进去且不重复', async () => {
  const { w, g, ids } = await setup();
  try {
    w.llm.push('extract', (req) => ({ reply: cut(req), stopReason: 'length' }));
    w.core.mods.encode.segment(w.core, { settingKey: g.key, force: true });
    const first = await w.runNext();
    assert.deepEqual(first.out, { status: 'split', reason: 'truncated' });
    // 半截的结果一条都没写：没有情节、没有事实，感知还在缓冲里
    assert.equal(w.assertions().length, 0);
    assert.equal(w.episodes().length, 0);
    assert.ok(w.core.store.all(`SELECT episode_id FROM percepts WHERE id IN (${ids.join(',')})`).every((p) => p.episode_id == null), '没封口');
    assert.equal(w.core.store.get('SELECT status FROM jobs WHERE id = ?', first.job.id).status, 'done', '这一次的用量照记，任务本身结束');
    // 拆成两段：按消息数对半，各一个任务；前一段的结尾是我们切的，算确定的边界
    const kids = w.jobs();
    assert.equal(kids.length, 2);
    assert.deepEqual(kids.map((j) => JSON.parse(j.payload_json).perceptIds).sort((a, b) => a[0] - b[0]), [ids.slice(0, 2), ids.slice(2)]);
    assert.ok(kids.every((j) => JSON.parse(j.payload_json).boundaryCertain === true));
    assert.ok(kids.every((j) => j.dedupe_key.endsWith(`#t${first.job.id}`)));
    assert.equal(metric(w.core, 'encode.extract.truncated'), 1);
    assert.equal(metric(w.core, 'encode.extract.split'), 1);
    // 两段各自提炼：都写进去，每件事一条
    const outs = await drain(w);
    assert.deepEqual(outs.map((r) => r.out.status), ['written', 'written']);
    assert.equal(w.episodes().length, 2);
    assert.deepEqual(w.assertions().map((a) => a.text).sort(), HOBBIES.map((h) => `阿明喜欢${h}`).sort(), '四件事都在，不重复');
    assert.ok(w.core.store.all(`SELECT episode_id FROM percepts WHERE id IN (${ids.join(',')})`).every((p) => p.episode_id != null));
    // 管理页诊断：最近的截断和拆分次数
    const s = w.core.mods.encode.stalledSummary(w.core);
    assert.deepEqual([s.segments, s.truncated, s.splits], [0, 1, 1]);
  } finally { await w.cleanup(); }
});

test('没有停止原因：最后一行坏了而且输出量接近上限，同样按截断处理', async () => {
  const { w, g } = await setup({ config: { extract: { minSpacingMs: 0, maxTokens: 100 } } });
  try {
    w.llm.push('extract', (req) => ({ reply: cut(req), out: 95 }));
    w.core.mods.encode.segment(w.core, { settingKey: g.key, force: true });
    const first = await w.runNext();
    assert.equal(first.out.status, 'split');
    assert.equal(w.assertions().length, 0);
    assert.equal(w.jobs().length, 2);
    await drain(w);
    assert.equal(w.assertions().length, HOBBIES.length);
  } finally { await w.cleanup(); }
});

test('最后一行坏了但输出很短（模型自己写坏的）：照旧只跳过那一行，其余照写、封口；端口明说正常结束的也一样', async () => {
  const { w, g, ids } = await setup();
  try {
    w.llm.push('extract', (req) => cut(req));
    w.core.mods.encode.segment(w.core, { settingKey: g.key, force: true });
    const r = await w.runNext();
    assert.equal(r.out.status, 'written');
    assert.deepEqual(w.assertions().map((a) => a.text), ['阿明喜欢钓鱼']);
    assert.equal(metric(w.core, 'encode.extract.badLines'), 1);
    assert.equal(metric(w.core, 'encode.extract.truncated'), 0);
    assert.equal(w.jobs().length, 0, '不拆');
    assert.ok(w.core.store.all(`SELECT episode_id FROM percepts WHERE id IN (${ids.join(',')})`).every((p) => p.episode_id != null));
  } finally { await w.cleanup(); }
  // 端口说「正常结束」：哪怕输出量接近上限，也不算截断
  const s2 = await setup({ config: { extract: { minSpacingMs: 0, maxTokens: 100 } } });
  try {
    s2.w.llm.push('extract', (req) => ({ reply: cut(req), out: 99, stopReason: 'end' }));
    s2.w.core.mods.encode.segment(s2.w.core, { settingKey: s2.g.key, force: true });
    assert.equal((await s2.w.runNext()).out.status, 'written');
    assert.equal(metric(s2.w.core, 'encode.extract.truncated'), 0);
  } finally { await s2.w.cleanup(); }
});

test('一直拆到一条消息还截断：走失败路径，直接搁置（TRUNCATED 算稳定被拒），什么都不写', async () => {
  const w = await makeWorld();
  try {
    const ming = w.entity('阿明', { closeness: 0.3 });
    const g = w.setting('游戏群', { exposure: 2 });
    const ids = [w.percept(g, ming, '我喜欢钓鱼'), w.percept(g, ming, '我喜欢爬山')];
    w.llm.fallback.extract = (req) => ({ reply: cut(req), stopReason: 'length' });
    w.core.mods.encode.segment(w.core, { settingKey: g.key, force: true });
    const outs = await drain(w);
    assert.deepEqual(outs.map((r) => r.out.status), ['split', 'failed', 'failed']);
    assert.ok(outs.slice(1).every((r) => r.out.reason === 'TRUNCATED'));
    assert.equal(w.jobs('failed').length, 2, '一条消息的不按 1 / 4 / 16 分钟重试（原样重试只会再截断）');
    const st = w.core.store.all('SELECT ep_from, ep_to, reason, last_error FROM extract_stalled ORDER BY ep_from').map((r) => ({ ...r }));
    assert.deepEqual(st, ids.map((id) => ({ ep_from: id, ep_to: id, reason: 'rejected', last_error: 'TRUNCATED' })));
    assert.equal(w.assertions().length, 0);
    assert.equal(w.episodes().length, 0);
    assert.equal(metric(w.core, 'encode.extract.truncated'), 3);
    assert.equal(metric(w.core, 'encode.extract.split'), 1);
  } finally { await w.cleanup(); }
});

test('拿不准边界的段截断了、又没来得及给边界那一行：后一段接着拿不准，前一段是我们切的、算确定', async () => {
  const { w, g, ids } = await setup();
  try {
    enqueueJob(w.core.store, { kind: 'extract', use: 'extract', priority: 1, dedupeKey: 'extract:test-uncertain', scopeKey: g.key, epFrom: ids[0], epTo: ids.at(-1),
      payload: { settingKey: g.key, perceptIds: ids, boundaryCertain: false } });
    w.llm.push('extract', (req) => ({ reply: cut(req), stopReason: 'length' }));
    assert.equal((await w.runNext()).out.status, 'split');
    const kids = w.jobs().map((j) => JSON.parse(j.payload_json)).sort((a, b) => a.perceptIds[0] - b.perceptIds[0]);
    assert.deepEqual(kids.map((k) => k.boundaryCertain), [true, false]);
  } finally { await w.cleanup(); }
});

test('拆的位置：在中间一半里挑回填和实时的交界，没有就挑隔得最久的地方；一样的取正中', () => {
  const MIN = 60_000;
  const at = (ms) => ms.map((m, i) => ({ at: m * MIN, historical: 0, i }));
  assert.equal(splitPoint(at([0, 1, 2, 3])), 2, '间隔一样：正中');
  assert.equal(splitPoint(at([0, 1, 2, 30, 31, 32, 33, 34])), 3, '隔得最久的地方');
  assert.equal(splitPoint(at([0, 1, 2, 3, 4, 5, 6, 90])), 4, '最久的那处不在中间一半里就不取（拆得太偏，取正中）');
  const rows = at([0, 1, 2, 3, 30, 31]);
  rows[0].historical = rows[1].historical = 1;
  assert.equal(splitPoint(rows), 2, '回填和实时的交界优先');
  assert.equal(splitPoint(at([0, 1])), 1);
  assert.equal(splitPoint(at([0])), null);
});
