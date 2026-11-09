// 向量的截断、归一化、量化（§8.7）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitVector, quantizeQ8, dequantizeQ8, dotQ8, binarize, hamming, popcnt, dot, asBytes, blobToF32, blobToI8, blobToU32, binWords } from '../../src/worker/quant.js';
import { FakeEmbedding } from '../fakes/index.js';

test('MRL 截断：取前 dim 维再归一化；太短、非有限数、全零都不能用', () => {
  const v = new Float32Array([3, 4, 12, 0]);
  const f = fitVector(v, 2);
  assert.equal(f.length, 2);
  assert.ok(Math.abs(f[0] - 0.6) < 1e-6 && Math.abs(f[1] - 0.8) < 1e-6);
  assert.equal(fitVector(v, 5), null);
  assert.equal(fitVector([1, Number.NaN], 2), null);
  assert.equal(fitVector([0, 0, 0], 3), null);
  assert.ok(Math.abs(dot(fitVector([1, 2, 3, 4], 4), fitVector([1, 2, 3, 4], 4)) - 1) < 1e-6);
});

test('int8：点积误差小（真实形状的向量）', () => {
  const emb = new FakeEmbedding({ dim: 256 });
  const texts = ['昨天晚上去取了快递', '他说最近总是加班', '周末去爬山了', '猫拉肚子去医院', 'The meeting moved to Friday'];
  let worst = 0;
  for (const a of texts) {
    for (const b of texts) {
      const va = emb.vector(a);
      const vb = emb.vector(b);
      const qa = quantizeQ8(va);
      const qb = quantizeQ8(vb);
      const approx = dotQ8(qa.q, 0, qb.q, 256) * qa.scale * qb.scale;
      worst = Math.max(worst, Math.abs(approx - dot(va, vb)));
    }
  }
  assert.ok(worst < 0.02, `int8 误差 ${worst}`);
  const q = quantizeQ8(emb.vector('还原'));
  const back = dequantizeQ8(q.q, q.scale);
  assert.ok(dot(back, emb.vector('还原')) > 0.999);
});

test('二值：相同 0、相反 = 维数；popcount', () => {
  const v = fitVector([1, -1, 2, -3, 0.5, -0.1, 4, 1, -2, 3, 1, 1, -1, -1, 2, 2, 1, -5, 3, 2, 1, 1, -1, 1, 2, 3, -4, 1, 1, 1, 1, -1, 2, 2], 34);
  const b = binarize(v);
  assert.equal(b.length, binWords(34));
  assert.equal(hamming(b, 0, b, b.length), 0);
  const neg = binarize(v.map((x) => -x));
  assert.equal(hamming(b, 0, neg, b.length), 34);
  assert.equal(popcnt(0xffffffff), 32);
  assert.equal(popcnt(0), 0);
  assert.equal(popcnt(0b1011), 3);
});

test('BLOB 进出：没对齐的字节偏移也能读回来', () => {
  const f = new Float32Array([1.5, -2, 3.25]);
  const bytes = asBytes(f);
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  assert.deepEqual([...blobToF32(shifted.subarray(1))], [1.5, -2, 3.25]);
  assert.deepEqual([...blobToI8(asBytes(new Int8Array([-1, 2, 127])))], [-1, 2, 127]);
  assert.deepEqual([...blobToU32(asBytes(new Uint32Array([7, 0xffffffff])))], [7, 0xffffffff]);
});
