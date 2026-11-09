// 名字规范化和 Aho-Corasick 自动机（纯函数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, normalizeWithMap, normalizeKind, individualOf } from '../../src/entities/normalize.js';
import { buildAutomaton, findAll, dropContained } from '../../src/entities/matcher.js';
import * as entities from '../../src/entities/index.js';

test('规范化：中文名不会变成空串（Graphiti 规范化坑的回归），不同的中文名不会撞成同一个键', () => {
  const names = ['小刚', '小鱼', '小鱼干', '阿明', '小林', '老王', '王老师'];
  const keys = names.map(normalizeName);
  for (const k of keys) assert.ok(k.length > 0, '中文名规范化后不能是空串');
  assert.equal(new Set(keys).size, names.length, '不同的名字规范化后不能撞在一起');
  assert.equal(normalizeName('小鱼干') === normalizeName('小鱼'), false, '「小鱼干」≠「小鱼」');
  assert.equal(entities.normalizeName('小刚'), '小刚');
});

test('规范化：全角 / 大小写 / 空白 / 标点统一，但只做完全相等', () => {
  assert.equal(normalizeName('Ｔｏｍ　Lee'), normalizeName('tom lee'));
  assert.equal(normalizeName('A-Ming!'), 'aming');
  assert.equal(normalizeName(' 小刚 '), '小刚');
  // 全是符号的名字：退回原文，仍然只和自己相等
  assert.ok(normalizeName('🐟🐟').length > 0);
  assert.notEqual(normalizeName('🐟🐟'), normalizeName('🐱'));
  assert.equal(normalizeName(null), '');
});

test('规范化：正文的映射能回到原文位置', () => {
  const text = '昨天 Ａ明说';
  const { chars, map } = normalizeWithMap(text);
  assert.deepEqual(chars, ['昨', '天', 'a', '明', '说']);
  assert.equal(text.slice(map[2][0], map[3][1]), 'Ａ明');
});

test('种类：档案结构里的非个人种类不是个人，不认识的种类按个人算（宁严），她自己不算「她以外的个人」', () => {
  assert.equal(individualOf(normalizeKind('person')), true);
  assert.equal(individualOf(normalizeKind('Group')), false);
  assert.equal(individualOf(normalizeKind('setting')), false);
  assert.equal(individualOf(normalizeKind('pet')), false);
  assert.equal(individualOf(normalizeKind('something-new')), true);
  assert.equal(individualOf(normalizeKind('')), true);
  assert.equal(individualOf('self'), false);
  assert.equal(individualOf('group', true), true, '显式给的优先');
});

test('Aho-Corasick：重叠、嵌套、多模式都找得到', () => {
  const keys = ['he', 'she', 'his', 'hers'].map(normalizeName);
  const ac = buildAutomaton(keys);
  const hits = ac.search([...'ushers']).map((h) => `${keys[h.key]}@${h.start}`).sort();
  assert.deepEqual(hits, ['he@2', 'hers@2', 'she@1']);
  const zh = ['小鱼', '小鱼干', '鱼干'].map(normalizeName);
  const ac2 = buildAutomaton(zh);
  const all = ac2.search([...'我爱吃小鱼干']).map((h) => zh[h.key]).sort();
  assert.deepEqual(all, ['小鱼', '小鱼干', '鱼干']);
});

test('findAll + dropContained：取最长的、拉丁字母按整词', () => {
  const keys = ['小鱼', '小鱼干', 'tom'].map(normalizeName);
  const ac = buildAutomaton(keys);
  const hits = dropContained(findAll(ac, keys, '我爱吃小鱼干，Tomato 不是 Tom。'));
  const got = hits.map((h) => keys[h.key]);
  assert.deepEqual(got, ['小鱼干', 'tom'], '「小鱼干」里不报「小鱼」；Tomato 里不报 Tom');
  const tom = hits.find((h) => keys[h.key] === 'tom');
  assert.equal('我爱吃小鱼干，Tomato 不是 Tom。'.slice(tom.origStart, tom.origEnd), 'Tom');
});
