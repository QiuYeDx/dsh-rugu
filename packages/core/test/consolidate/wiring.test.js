// 夜间整理和真模块的接线（阶段 B 交付说明里的请求）：在 createPersonaMemory + 假平台 + 替身端口上跑一晚，
// 只看 consolidate 自己接的那几处调用和真模块对得上——第 1 步 intake.flushWindows(force) 真的切出了原文窗口，
// 第 9 步 worker.runEmbedQueue(night) 真的按夜里的方式把它嵌了、dynamics.retier 做完后 worker.reloadIndex 真的被调，
// 跑完 context.markResidentDirty 真的标了脏。别的模块各步的行为由它们自己的测试管，这里不断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaMemory } from '../../src/index.js';
import { getMeta } from '../../src/store/index.js';
import { fakePorts, FakeLLM, FakeClock } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { tmpDir, rmDir } from '../helpers.js';

test('接线（真模块）：第 1 步切出原文窗口，第 9 步夜里嵌掉它、分层做完重建索引，跑完常驻区标脏', async (t) => {
  const fp = createFakePlatform();
  t.diagnostic(`fake-platform seed=${fp.seed}`);
  const clock = new FakeClock(fp.now());
  const llm = new FakeLLM({ fallback: { extract: [], sleep: [], summary: [], appraise: [], review: [], rewrite: [] } });
  const dir = tmpDir('consolidate-wiring');
  const pm = await createPersonaMemory({ dataDir: dir, ports: fakePorts({ clock, llm }), startWorker: false });
  try {
    const core = pm._core;
    const dirty = [];
    const real = core.mods;
    core.mods = Object.freeze({
      ...real,
      context: Object.freeze({ ...real.context, markResidentDirty: (c, key) => { dirty.push(key ?? null); return real.context.markResidentDirty(c, key); } }),
    });
    pm.registerAdapter(fp.adapter);
    const t0 = clock.now() + 1000;
    const lines = [['friend', '周末一起去爬山吗'], ['her', '好呀，我也想去'], ['friend', '那就周六早上集合']];
    lines.forEach(([who, text], i) => fp.say('smallGroup', who, text, { at: t0 + i * 10_000, perceivedAt: t0 + i * 10_000 }));
    clock.set(t0 + 30_000);   // 离第一条才半分钟（< 空闲 2 分钟、不到 5 条）：白天的切窗口不会切它
    core.mods.intake.drain(core);
    assert.ok(core.store.get('SELECT count(*) AS n FROM percepts').n >= 3);
    assert.equal(core.store.get('SELECT count(*) AS n FROM raw_windows').n, 0, '窗口还没切');

    const r = await pm.maintenance.sleep();
    const s1 = r.steps.find((s) => s.step === 1);
    const s9 = r.steps.find((s) => s.step === 9);
    assert.ok(!(s1.errors ?? []).some((e) => e.startsWith('windows:')), JSON.stringify(s1));
    assert.ok(s1.detail.windows >= 1, '第 1 步把还在缓冲里的原文窗口切掉了');
    assert.ok(core.store.get('SELECT count(*) AS n FROM raw_windows').n >= 1);
    assert.ok(!(s9.errors ?? []).some((e) => /^(embed|reindex|retier):/.test(e)), JSON.stringify(s9));
    assert.ok(s9.detail.embed.embedded >= 1, '夜里那一轮把刚切的窗口嵌了');
    assert.equal(Number(getMeta(core.store, 'worker.nightRunAt')), clock.now(), 'worker 收到的是夜里那一轮（night=true）');
    assert.equal(core.store.get("SELECT count(*) AS n FROM embed_texts WHERE owner_kind = 'window' AND status <> 'done'").n, 0);
    assert.equal(s9.detail.retierDone, true);
    assert.equal(s9.detail.reindexed, true);
    assert.ok(dirty.includes(null), '跑完给所有场合的常驻区标脏（别的模块自己标的不管）');
  } finally {
    await pm.close();
    rmDir(dir);
  }
});
