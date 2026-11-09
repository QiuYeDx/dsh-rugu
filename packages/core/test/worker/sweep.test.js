// 向量库是缓存（D15、§12.8）：主库是真相源；启动和恢复备份后清扫：主库没有 / 墓碑 / 原文过期 → 删；文本变了 → 删；
// 主库标 done 向量库却没有 → 重新排队。向量库丢了整个重建（openVectorStore 清空后清扫会把全部改回 pending）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerCore, addText, drainQueue, owner } from './_helpers.js';

const W = (core) => core.mods.worker;

function owners(core) {
  core.store.tx(() => {
    for (const id of [1, 2, 3]) owner(core, 'assertion', id);
    owner(core, 'window', 1);
    owner(core, 'window', 2);
  });
}

test('清扫：主表没有的、墓碑里的、原文已过期的窗口，嵌入文本和向量一起删；文本变了的向量删掉；缺向量的改回 pending', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-sweep' });
  try {
    owners(core);
    for (const id of [1, 2, 3]) addText(core, 'assertion', id, `事实 ${id}`);
    addText(core, 'assertion', 4, '主表里没有这条');
    addText(core, 'window', 1, '[原文窗口一]', { layer: 'raw' });
    addText(core, 'window', 2, '[原文窗口二]', { layer: 'raw' });
    await drainQueue(core);
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 6);
    // 墓碑：a2 被彻底删除过（恢复备份把它带回来了）
    core.store.run("INSERT INTO tombstones(kind, ref, at) VALUES ('assertion', 'a2', ?)", core.now());
    // 原文窗口 2 过了保留期
    core.store.run('UPDATE raw_windows SET text = NULL WHERE id = 2');
    // a3 的向量丢了（向量库不是事务性的）
    const id3 = core.store.get('SELECT id FROM embed_texts WHERE owner_kind = ? AND owner_id = 3', 'assertion').id;
    core.vectors.run('DELETE FROM vectors WHERE embed_text_id = ?', id3);
    // a1 的向量对应的是旧文本
    const id1 = core.store.get('SELECT id FROM embed_texts WHERE owner_kind = ? AND owner_id = 1', 'assertion').id;
    core.vectors.run("UPDATE vectors SET text_hash = 'old' WHERE embed_text_id = ?", id1);
    const r = W(core).sweepVectors(core);
    assert.equal(r.requeued, 2);   // a3 缺向量、a1 的旧向量删了之后也缺
    assert.ok(r.removed >= 4);
    const texts = core.store.all('SELECT owner_kind, owner_id, status FROM embed_texts ORDER BY owner_kind, owner_id').map((x) => `${x.owner_kind}${x.owner_id}:${x.status}`);
    assert.deepEqual(texts, ['assertion1:pending', 'assertion3:pending', 'window1:done']);
    assert.deepEqual(core.vectors.all('SELECT owner_kind, owner_id FROM vectors').map((x) => `${x.owner_kind}${x.owner_id}`), ['window1']);
    // 可以重跑
    assert.deepEqual(W(core).sweepVectors(core), { removed: 0, requeued: 0 });
    await drainQueue(core);
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 3);
  } finally { await cleanup(); }
});

test('start 先清扫，索引从清扫后的向量库冷加载', async () => {
  const { core, cleanup } = await workerCore({ name: 'worker-sweep-start', config: { worker: { enabled: false } } });
  try {
    owners(core);
    addText(core, 'assertion', 1, '事实一');
    addText(core, 'assertion', 9, '主表没有');
    await drainQueue(core);
    await W(core).start(core);   // 线程关掉了：start 失败，但清扫照做
    assert.equal(core.store.get('SELECT count(*) AS n FROM embed_texts').n, 1);
    assert.equal(core.vectors.get('SELECT count(*) AS n FROM vectors').n, 1);
  } finally { await cleanup(); }
});
