// fuse（RRF）和 mmr 两个纯函数（§8.3 第 1、5 步）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuse, mmr } from '../../src/retrieve/index.js';

const route = (name, refs) => ({ route: name, hits: refs.map((ref, i) => ({ ref, score: 1 - i * 0.1 })), ms: 1, timedOut: false });

test('fuse：RRF 分 = Σ 1/(k + 名次)，名次和各路分数都记下', () => {
  const out = fuse([route('dense', ['a1', 'e2']), route('lexical', ['e2', 'p3']), route('entity', ['a1'])], { k: 60, keep: 10 });
  const by = Object.fromEntries(out.map((c) => [c.ref, c]));
  assert.ok(Math.abs(by.a1.rrf - (1 / 61 + 1 / 61)) < 1e-12);
  assert.ok(Math.abs(by.e2.rrf - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(by.e2.ranks, { dense: 2, lexical: 1 });
  assert.equal(by.a1.signals.ppr, 1);
  assert.equal(by.e2.signals.bm25, 1);
  assert.equal(by.a1.signals.dense, 1);
  assert.deepEqual(by.a1.mref, { kind: 'assertion', id: 1 });
  assert.deepEqual(out.map((c) => c.ref), ['a1', 'e2', 'p3']);
});

test('fuse：留 ≤ keep 条；同一路重复的引用只算最好名次；不认识的引用丢掉；结果确定', () => {
  const r = route('dense', ['a1', 'a1', 'zz9', 'x', 'e5', 'w6']);
  const out = fuse([r], { k: 60, keep: 2 });
  assert.deepEqual(out.map((c) => c.ref), ['a1', 'e5']);
  assert.equal(out[0].ranks.dense, 1);
  assert.equal(out[1].ranks.dense, 2);   // 无效引用不占名次
  const again = fuse([r], { k: 60, keep: 2 });
  assert.deepEqual(again, out);
  assert.deepEqual(fuse([], { k: 60, keep: 5 }), []);
  assert.deepEqual(fuse([{ route: 'time', hits: [], ms: 0, timedOut: true }], { k: 60, keep: 5 }), []);
});

test('fuse：同分按最好名次、再按引用排', () => {
  const out = fuse([route('dense', ['a2']), route('lexical', ['a1'])], { k: 60, keep: 10 });
  assert.deepEqual(out.map((c) => c.ref), ['a1', 'a2']);
});

test('mmr：λ 权衡相关度和与已选的最大相似度；limit 截断；同分取靠前的', () => {
  const items = [{ id: 'x', s: 0.9, g: 1 }, { id: 'y', s: 0.85, g: 1 }, { id: 'z', s: 0.6, g: 2 }];
  const sim = (a, b) => (a.g === b.g ? 1 : 0);
  const out = mmr(items, { lambda: 0.7, sim, score: (v) => v.s, limit: 3 });
  assert.deepEqual(out.map((v) => v.id), ['x', 'z', 'y']);   // y 和 x 一样，被 z 超过
  assert.deepEqual(mmr(items, { lambda: 1, sim, score: (v) => v.s, limit: 2 }).map((v) => v.id), ['x', 'y']);
  assert.deepEqual(mmr(items, { lambda: 0.7, sim, score: (v) => v.s, limit: 1 }).map((v) => v.id), ['x']);
  assert.deepEqual(mmr([], { lambda: 0.7, sim, score: (v) => v.s, limit: 3 }), []);
  const tie = [{ id: 'a', s: 0.5, g: 1 }, { id: 'b', s: 0.5, g: 2 }];
  assert.deepEqual(mmr(tie, { lambda: 0.7, sim, score: (v) => v.s, limit: 2 }).map((v) => v.id), ['a', 'b']);
});

test('mmr：坏分数当 0，不抛错', () => {
  const out = mmr([{ s: NaN }, { s: 0.2 }], { lambda: 0.7, sim: () => NaN, score: (v) => v.s, limit: 5 });
  assert.equal(out.length, 2);
  assert.equal(out[0].s, 0.2);
});

test('mmr 的 dup：挑中的和已选的几乎一样就合并掉、不占名额，下一条补上；dup 出错当不是重复', () => {
  const items = [{ id: 'a', s: 1 }, { id: 'a2', s: 0.95 }, { id: 'b', s: 0.5 }, { id: 'c', s: 0.4 }];
  const merged = [];
  const out = mmr(items, {
    lambda: 1, limit: 2, score: (x) => x.s, sim: () => 0,
    dup: (x, y) => { const d = x.id.startsWith(y.id) && x.id !== y.id; if (d) merged.push([x.id, y.id]); return d; },
  });
  assert.deepEqual(out.map((x) => x.id), ['a', 'b'], '几乎一样的 a2 不占名额，b 补上');
  assert.deepEqual(merged, [['a2', 'a']]);
  // 没有 dup：照旧（名额够时两条几乎一样的都选上）
  assert.deepEqual(mmr(items, { lambda: 1, limit: 2, score: (x) => x.s, sim: () => 0 }).map((x) => x.id), ['a', 'a2']);
  // dup 抛错：当不是重复
  assert.deepEqual(mmr(items, { lambda: 1, limit: 2, score: (x) => x.s, sim: () => 0, dup: () => { throw new Error('x'); } }).map((x) => x.id), ['a', 'a2']);
});
