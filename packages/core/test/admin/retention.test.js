// 原文保留期（§12.6、§17 Q3）。S30 由 admin 牵头：用真的 backup 模块做「到期删除前的备份」，intake.expireRawText 用照契约的替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ContractError } from '../../src/contract/errors.js';
import * as realBackup from '../../src/backup/index.js';
import { DAY, HOUR } from '../fakes/index.js';
import { adminCore, fakeMods, seedSetting, seedPercept, seedWindow } from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};

/** 真的 backup，套一层记下调用顺序。 */
function recordingBackup(calls) {
  return {
    createPack: async (core, opt) => { calls.push({ name: 'backup.createPack', args: [opt] }); return realBackup.createPack(core, opt); },
    preOperationSnapshot: realBackup.preOperationSnapshot,
    verifyPack: realBackup.verifyPack,
  };
}

/** 原文：500 天前的两条（一个窗口）、100 天前的一条。 */
function rawText(core) {
  const sk = seedSetting(core);
  const now = core.now();
  const old1 = seedPercept(core, { settingKey: sk, text: '一年半以前说的话', at: now - 500 * DAY });
  const old2 = seedPercept(core, { settingKey: sk, text: '一年半以前的另一句', at: now - 500 * DAY + 60_000 });
  const recent = seedPercept(core, { settingKey: sk, text: '三个月前说的话', at: now - 100 * DAY });
  const win = seedWindow(core, { settingKey: sk, perceptIds: [old1, old2], text: '一年半以前说的话 / 一年半以前的另一句' });
  return { sk, old1, old2, recent, win };
}
const textOf = (core, id) => core.store.get('SELECT text FROM percepts WHERE id = ?', id).text;
const rawCount = (core) => core.store.get('SELECT count(*) AS n FROM percepts WHERE text IS NOT NULL').n + core.store.get('SELECT count(*) AS n FROM raw_windows WHERE text IS NOT NULL').n;

test('S30：2 年改成 1 年 → 先给影响和确认语；冷静期里一条不删、可以取消；不取消就到期先备份（验证过）再删', async () => {
  const calls = [];
  const expire = fakeMods().mods.intake.expireRawText;
  const intake = { expireRawText: (core, o) => { calls.push({ name: 'intake.expireRawText', args: [o] }); return expire(core, o); } };
  const t = await adminCore('adm-s30', { mods: { backup: recordingBackup(calls), intake }, config: { backup: { scrypt: { N: 1024, r: 8, p: 1 } } } });
  const { core } = t;
  const of = (n) => calls.filter((c) => c.name === n);
  try {
    t.ports.clock.set(Date.UTC(2026, 10, 1, 4, 0));
    core.config.update({ time: { tzOffsetMin: 480 } });
    const w = rawText(core);
    assert.equal(core.mods.admin.retentionState(core).current, '2y');
    assert.deepEqual(await core.mods.admin.applyRetention(core, core.now()), { expired: 0, done: true }, '2 年内的原文都留着');

    // 1. 先显示影响并要求输入确认语
    const ask = core.mods.admin.requestRetentionChange(core, { to: '1y', by: 'owner', at: core.now() });
    assert.equal(ask.status, 'need-confirm');
    assert.match(ask.confirmPhrase, /^确认删除 \d{4}-\d{2} 之前的原文$/);
    assert.equal(ask.impact.percepts, 2);
    assert.equal(ask.impact.windows, 1);
    assert.ok(ask.impact.bytes > 0);
    assert.equal(ask.impact.from, core.now() - 500 * DAY);
    assert.equal(core.mods.admin.retentionState(core).pending, null, '只看影响不算数');
    // 只点一下（确认语不对）不行
    assert.equal(core.mods.admin.requestRetentionChange(core, { to: '1y', confirmPhrase: '确认', by: 'owner', at: core.now() }).status, 'need-confirm');
    // 2. 输入确认语 → 7 天冷静期
    const ok = core.mods.admin.requestRetentionChange(core, { to: '1y', confirmPhrase: ask.confirmPhrase, by: 'owner', at: core.now() });
    assert.equal(ok.status, 'cooling-off');
    assert.equal(ok.effectiveAt, core.now() + 7 * DAY);
    t.ports.clock.advance(3 * DAY);
    assert.deepEqual(await core.mods.admin.applyRetention(core, core.now()), { expired: 0, done: false });
    const st = core.mods.admin.retentionState(core);
    assert.equal(st.current, '2y');
    assert.equal(st.pending.to, '1y');
    assert.equal(st.pending.daysLeft, 4, '待审提示显示倒计时');
    assert.equal(core.mods.admin.pendingSummary(core).retention.daysLeft, 4);
    // 3. 冷静期内取消：原文一条不少
    core.mods.admin.cancelRetentionChange(core, { by: 'owner', at: core.now() });
    t.ports.clock.advance(10 * DAY);
    await core.mods.admin.applyRetention(core, core.now());
    assert.equal(core.mods.admin.retentionState(core).current, '2y');
    assert.equal(rawCount(core), 4);
    assert.equal(of('backup.createPack').length, 0);
    assert.equal(of('intake.expireRawText').length, 0);

    // 4. 再来一次，这次不取消：到期先做完整备份，验证过了才删
    const ask2 = core.mods.admin.requestRetentionChange(core, { to: '1y', by: 'owner', at: core.now() });
    core.mods.admin.requestRetentionChange(core, { to: '1y', confirmPhrase: ask2.confirmPhrase, by: 'owner', at: core.now() });
    t.ports.clock.advance(7 * DAY - HOUR);
    await core.mods.admin.applyRetention(core, core.now());
    assert.equal(rawCount(core), 4, '冷静期最后一小时也不删');
    t.ports.clock.advance(HOUR);
    const r = await core.mods.admin.applyRetention(core, core.now());
    assert.equal(r.done, true);
    assert.equal(r.expired, 3, '两条感知原文 + 一个窗口');
    const order = calls.map((c) => c.name).filter((n) => n === 'backup.createPack' || n === 'intake.expireRawText');
    assert.deepEqual(order, ['backup.createPack', 'intake.expireRawText'], '备份在删除之前');
    assert.deepEqual(of('backup.createPack')[0].args[0], { kind: 'pre-op', reason: 'retention' });
    const pack = core.store.get("SELECT * FROM backups WHERE kind = 'pre-op' AND reason = 'retention'");
    assert.equal(pack.verify_status, 'ok');
    assert.ok(fs.existsSync(pack.path));
    assert.equal(JSON.parse(pack.manifest_json).counts.percepts, 3, '备份里原文都还在');
    assert.equal(textOf(core, w.old1), null);
    assert.equal(textOf(core, w.recent), '三个月前说的话');
    assert.equal(core.mods.admin.retentionState(core).current, '1y');
    assert.equal(core.mods.admin.retentionState(core).pending, null);
    t.ports.logger.assertNoText('一年半以前', '三个月前');
  } finally { await t.cleanup(); }
});

test('延长（含永久）立即生效，冷静期中的缩短作废；不认识的选项抛错', withCore('adm-ret-extend', async (core) => {
  rawText(core);
  const ask = core.mods.admin.requestRetentionChange(core, { to: '1y', by: 'owner', at: core.now() });
  core.mods.admin.requestRetentionChange(core, { to: '1y', confirmPhrase: ask.confirmPhrase, by: 'owner', at: core.now() });
  assert.deepEqual(core.mods.admin.requestRetentionChange(core, { to: '5y', by: 'owner', at: core.now() }), { status: 'applied' });
  assert.deepEqual(core.mods.admin.retentionState(core), { current: '5y', pending: null });
  assert.equal(core.mods.admin.requestRetentionChange(core, { to: 'forever', by: 'owner', at: core.now() }).status, 'applied');
  assert.deepEqual(await core.mods.admin.applyRetention(core, core.now() + 3000 * DAY), { expired: 0, done: true });
  assert.equal(rawCount(core), 4);
  assert.throws(() => core.mods.admin.requestRetentionChange(core, { to: '3y', by: 'owner', at: core.now() }), ContractError);
  // 永久 → 2 年也是缩短：要确认
  assert.equal(core.mods.admin.requestRetentionChange(core, { to: '2y', by: 'owner', at: core.now() }).status, 'need-confirm');
}));

test('到期那天备份失败：不生效、不删；隔一阵再试，不会每分钟都做一份；主人这时取消也来得及', withCore('adm-ret-bkfail', async (core, t) => {
  const w = rawText(core);
  const ask = core.mods.admin.requestRetentionChange(core, { to: '1y', by: 'owner', at: core.now() });
  core.mods.admin.requestRetentionChange(core, { to: '1y', confirmPhrase: ask.confirmPhrase, by: 'owner', at: core.now() });
  t.ports.clock.advance(7 * DAY);
  core.state.failBackup = true;
  assert.deepEqual(await core.mods.admin.applyRetention(core, core.now()), { expired: 0, done: false });
  assert.equal(core.mods.admin.retentionState(core).current, '2y');
  assert.equal(textOf(core, w.old1), '一年半以前说的话');
  t.ports.clock.advance(60_000);
  await core.mods.admin.applyRetention(core, core.now());
  assert.equal(core.state.backupTries, 1, '一分钟后不再立刻重做');
  core.state.failBackup = false;
  t.ports.clock.advance(HOUR);
  await core.mods.admin.applyRetention(core, core.now());
  assert.equal(core.mods.admin.retentionState(core).current, '1y');
  assert.equal(textOf(core, w.old1), null);
}, { mods: { backup: { createPack: async (core, opt) => {
  if (core.state.failBackup) { core.state.backupTries = (core.state.backupTries ?? 0) + 1; throw new Error('disk'); }
  return [{ id: 1, path: 'x', kind: opt.kind, location: 'local', verified: true }];
} } } }));

test('备份期间主人取消了：备份做完也不生效', withCore('adm-ret-cancel-during', async (core) => {
  const w = rawText(core);
  const ask = core.mods.admin.requestRetentionChange(core, { to: '1y', by: 'owner', at: core.now() });
  core.mods.admin.requestRetentionChange(core, { to: '1y', confirmPhrase: ask.confirmPhrase, by: 'owner', at: core.now() });
  core.state.onBackup = () => core.mods.admin.cancelRetentionChange(core, { by: 'owner', at: core.now() });
  const r = await core.mods.admin.applyRetention(core, core.now() + 7 * DAY);
  assert.equal(r.expired, 0);
  assert.equal(core.mods.admin.retentionState(core).current, '2y');
  assert.equal(textOf(core, w.old1), '一年半以前说的话');
}, { mods: { backup: { createPack: async (core, opt) => { core.state.onBackup?.(); return [{ id: 1, path: 'x', kind: opt.kind, location: 'local', verified: true }]; } } } }));

test('例行到期删除：要有一份 48 小时内验证过的本机包；没有就等，有了按批删、做完记下进度；同一时间只跑一个', withCore('adm-ret-routine', async (core, t) => {
  const sk = seedSetting(core);
  const now = core.now();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(seedPercept(core, { settingKey: sk, text: `三年前的第${i}句`, at: now - 1100 * DAY + i }));
  const keep = seedPercept(core, { settingKey: sk, text: '昨天的话', at: now - DAY });
  const r0 = await core.mods.admin.applyRetention(core, now);
  assert.deepEqual(r0, { expired: 0, done: false }, '没有新近的备份：先不删');
  assert.equal(t.ports.logger.events('admin.retention-waiting-backup').length, 1);
  await core.mods.admin.applyRetention(core, now);
  assert.equal(t.ports.logger.events('admin.retention-waiting-backup').length, 1, '等备份的警告不刷屏');
  core.store.run("INSERT INTO backups(kind, location, path, created_at, verify_status) VALUES ('daily', 'local', 'p', ?, 'ok')", now - HOUR);
  core.config.update({ retention: { batch: 2 } });
  // 并发的两次调用：第二次直接返回
  const [a, b] = await Promise.all([core.mods.admin.applyRetention(core, now), core.mods.admin.applyRetention(core, now)]);
  assert.deepEqual(b, { expired: 0, done: false });
  assert.ok(a.expired > 0);
  let guard = 0;
  while (!(await core.mods.admin.applyRetention(core, now)).done && guard++ < 10);
  for (const id of ids) assert.equal(textOf(core, id), null);
  assert.equal(textOf(core, keep), '昨天的话');
  assert.ok(Number(core.store.get("SELECT value FROM meta WHERE key = 'retention.doneBefore'").value) >= now - 730 * DAY);
  const before = t.of('intake.expireRawText').length;
  assert.deepEqual(await core.mods.admin.applyRetention(core, now + 60_000), { expired: 0, done: true });
  assert.equal(t.of('intake.expireRawText').length, before, '做完之后不再空跑');
}));

test('配置文件里的 retention.raw 只是第一次的默认值：之后改配置不算数（缩短必须走确认语 + 冷静期）', withCore('adm-ret-config', async (core, t) => {
  rawText(core);
  await core.mods.admin.applyRetention(core, core.now());
  core.config.update({ retention: { raw: '1y' } });
  await core.mods.admin.applyRetention(core, core.now());
  assert.equal(core.mods.admin.retentionState(core).current, '2y');
  assert.equal(t.ports.logger.events('admin.retention-config-ignored').length, 1);
  assert.equal(rawCount(core), 4);
}));
