// 管理页的写操作（§13.1、§12.4、§12.6、§12.7、§15.2）：每个操作先校验输入（多出来的字段也拒绝），
// 设计里说要确认的必须带确认令牌（服务端自己判断要不要，不信页面），会删东西的还要手动输入确认语；
// 令牌绑定操作和对象、一次性、10 分钟过期、输错 5 次作废。只经核心的公开 API 和 host.*。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('输入校验：多余字段、格式不对的引用和 id、越界的值，一律 400，不往核心里送', async () => {
  const s = setup();
  const bad = [
    ['memory.hide', { ref: 'a1', extra: 1 }, 'body.extra'],
    ['memory.hide', { ref: 'a1; DROP TABLE' }, 'ref'],
    ['memory.forget', {}, 'ref'],
    ['ntk.read', { id: 'abc' }, 'id'],
    ['ntk.read', { id: -3 }, 'id'],
    ['review.decide', { id: 11, decision: 'maybe' }, 'decision'],
    ['rules.add', { kind: 'do_not_remember', target: { settingKey: 'sk-web', entityId: 10 } }, 'target'],
    ['rules.add', { kind: 'disclosure', target: { attribute: '健康' }, value: {} }, 'value.restriction'],
    ['rules.add', { kind: 'disclosure', target: { settingAttrs: { adapter: 'qq' } }, value: { restriction: 'soft' } }, 'target.settingAttrs.adapter'],
    ['rules.add', { kind: 'mode', target: { settingKey: 'sk-web' }, value: 'live' }, 'kind'],
    ['source.withdraw', { entityId: 10, from: Date.UTC(2026, 10, 2), to: Date.UTC(2026, 10, 1) }, 'from'],
    ['source.withdraw', { entityId: 10, from: 5, to: 6 }, 'from'],
    ['backup.offsite', { dir: 'relative\\dir' }, 'dir'],
    ['backup.offsite', { dir: 'D:\\a\\..\\b' }, 'dir'],
    ['backup.offsite', { dir: 'D:\\' }, 'dir'],
    ['backup.restore', { id: 1, path: 'C:\\evil.pmpack' }, 'body.path'],
    ['backup.restorePartial', { id: 1, selector: {} }, 'selector'],
    ['backup.restorePartial', { id: 1, selector: { settingKeys: ['a b'] } }, 'selector.settingKeys[0]'],
    ['config.set', { key: 'retention.raw', value: '1y' }, 'key'],
    ['config.set', { key: 'host.features.freeze', value: false }, 'key'],
    ['config.set', { key: 'budget.preset', value: 'huge' }, 'value'],
    ['budget.set', { preset: 'huge' }, 'preset'],
    ['budget.set', { preset: 'loose', overrides: { dailyCalls: 10 } }, 'overrides.dailyCalls'],
    ['budget.set', { preset: 'loose', overrides: { dailyCalls: 1500.5 } }, 'overrides.dailyCalls'],
    ['budget.set', { preset: 'loose', overrides: { dailyUncachedTokens: '5000000' } }, 'overrides.dailyUncachedTokens'],
    ['budget.set', { preset: 'loose', overrides: { perSourceShare: 1.5 } }, 'overrides.perSourceShare'],
    ['budget.set', { preset: 'loose', overrides: { perSourceShare: null } }, 'overrides.perSourceShare'],
    ['budget.set', { preset: 'loose', overrides: { mainChatRatioCap: 0 } }, 'overrides.mainChatRatioCap'],
    ['budget.set', { preset: 'loose', overrides: { balanceProtectDays: 31 } }, 'overrides.balanceProtectDays'],
    ['budget.set', { preset: 'loose', overrides: { balanceProtectDays: -1 } }, 'overrides.balanceProtectDays'],
    ['budget.set', { preset: 'loose', overrides: { stage2Scope: 'some' } }, 'overrides.stage2Scope'],
    ['budget.set', { preset: 'loose', overrides: { rerank: 'yes' } }, 'overrides.rerank'],
    ['budget.set', { preset: 'loose', overrides: { egressReservePerDay: 5 } }, 'overrides.egressReservePerDay'],
    ['budget.set', { preset: 'loose', overrides: [] }, 'overrides'],
    ['gpu.policy', { policy: 'max' }, 'policy'],
    ['gpu.gameMode', { on: true, hours: 25 }, 'hours'],
    ['gpu.gameMode', { on: false, hours: 2 }, 'hours'],
    ['retention.request', { to: '10y' }, 'to'],
    ['memory.purge', { refs: [] }, 'refs'],
    ['memory.purge', { refs: Array.from({ length: 51 }, (_, i) => `a${i + 1}`) }, 'refs'],
    ['embedding.activate', { spaceId: 'sp 4b' }, 'spaceId'],
  ];
  for (const [action, body, p] of bad) {
    const r = await s.act(action, body);
    assert.equal(r.status, 400, `${action} ${JSON.stringify(body).slice(0, 60)}`);
    assert.equal(r.body.code, 'BAD_INPUT');
    assert.equal(r.body.path, p, action);
  }
  const touched = s.pm.calls.filter((c) => !['admin.list', 'admin.get', 'admin.retention.get', 'status'].includes(c.name));
  assert.deepEqual(touched, [], '校验不过的请求一个都不该碰到核心');
  assert.deepEqual(s.host.calls, []);
  // prepare 也一样校验
  const pr = await s.act('prepare', { for: 'memory.purge', params: { refs: ['a1'], x: 1 } });
  assert.equal(pr.status, 400);
  assert.equal((await s.act('prepare', { for: 'nope', params: {} })).status, 400);
});

test('彻底删除：不带确认 428；先预览（原文开头、来源数、注入过几个会话）再照确认语输入才执行', async () => {
  const s = setup();
  const direct = await s.act('memory.purge', { refs: ['a1'] });
  assert.equal(direct.status, 428);
  assert.equal(direct.body.code, 'CONFIRM_REQUIRED');
  assert.equal(s.callsOf('admin.purge').length, 0);

  const pr = await s.prepare('memory.purge', { refs: ['a3', 'a1'] });
  assert.equal(pr.needsConfirm, true);
  assert.equal(pr.phrase, '彻底删除 2 条');
  assert.equal(pr.preview.items.length, 2);
  assert.equal(pr.preview.items[0].ref, 'a1', '对象排过序，令牌和顺序无关');
  assert.ok(pr.preview.items[0].text.length <= 81);
  assert.equal(typeof pr.preview.items[0].sources, 'number');
  assert.equal(s.callsOf('admin.purge').length, 0, '预览不删任何东西');

  const wrong = await s.act('memory.purge', { refs: ['a1', 'a3'], confirm: { token: pr.token, typed: '彻底删除' } });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, 'CONFIRM_MISMATCH');
  assert.equal(s.callsOf('admin.purge').length, 0);
  // 输错不作废，可以重输；alsoBackups 不在绑定里（预览之后还能勾）；全角空格、首尾空白不影响
  const ok = await s.act('memory.purge', { refs: ['a3', 'a1'], alsoBackups: true, confirm: { token: pr.token, typed: ' 彻底删除　2 条 ' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.callsOf('admin.purge')[0].args, [['a1', 'a3'], { alsoBackups: true }]);
  assert.equal(ok.body.result.sessions, 2, '只回会话个数（提示「已经注入过的文字收不回」）');
  // 令牌一次性
  const again = await s.act('memory.purge', { refs: ['a1', 'a3'], confirm: { token: pr.token, typed: '彻底删除 2 条' } });
  assert.equal(again.status, 428);
  assert.equal(s.callsOf('admin.purge').length, 1);
});

test('确认令牌绑定对象：删 A 的令牌删不了 B（而且对不上就作废）；10 分钟过期；输错 5 次作废', async () => {
  const s = setup();
  const pr = await s.prepare('memory.purge', { refs: ['a1'] });
  const other = await s.act('memory.purge', { refs: ['a2'], confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(other.status, 428);
  const after = await s.act('memory.purge', { refs: ['a1'], confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(after.status, 428, '拿错对象试过一次，这个令牌就作废了');
  // 别的操作的令牌也不行
  const enc = await s.prepare('backup.encryption', {});
  assert.equal((await s.act('memory.purge', { refs: ['a1'], confirm: { token: enc.token, typed: '彻底删除 1 条' } })).status, 428);

  const p2 = await s.prepare('memory.purge', { refs: ['a1'] });
  s.clock.t += 10 * 60_000 + 1;
  assert.equal((await s.act('memory.purge', { refs: ['a1'], confirm: { token: p2.token, typed: p2.phrase } })).status, 428);

  const p3 = await s.prepare('memory.purge', { refs: ['a1'] });
  for (let i = 0; i < 5; i++) assert.equal((await s.act('memory.purge', { refs: ['a1'], confirm: { token: p3.token, typed: `不对 ${i}` } })).status, 422);
  assert.equal((await s.act('memory.purge', { refs: ['a1'], confirm: { token: p3.token, typed: p3.phrase } })).status, 428);
  assert.equal(s.callsOf('admin.purge').length, 0);

  const p4 = await s.prepare('memory.purge', { refs: ['a1'] });
  assert.equal((await s.act('memory.purge', { refs: ['a1'], confirm: 'yes' })).status, 428);
  assert.equal((await s.act('memory.purge', { refs: ['a1'], confirm: { token: p4.token, typed: p4.phrase } })).status, 200);
});

test('隐藏、忘掉、恢复不要确认（都能撤回），直接调核心', async () => {
  const s = setup();
  assert.equal((await s.act('memory.hide', { ref: 'a1' })).status, 200);
  assert.equal((await s.act('memory.forget', { ref: 'a2' })).status, 200);
  assert.equal((await s.act('memory.restore', { ref: 'a2' })).status, 200);
  assert.deepEqual(s.callsOf('admin.hide').map((c) => c.args), [['a1']]);
  assert.deepEqual(s.callsOf('admin.forget').map((c) => c.args), [['a2']]);
  assert.deepEqual(s.callsOf('admin.restore').map((c) => c.args), [['a2']]);
});

test('原文保留期：延长立即生效、不要确认；缩短要核心给的确认语，进 7 天冷静期，可以取消', async () => {
  const s = setup();
  const ext = await s.act('retention.request', { to: '5y' });
  assert.equal(ext.status, 200);
  assert.equal(ext.body.result.status, 'applied');
  const direct = await s.act('retention.request', { to: '1y' });
  assert.equal(direct.status, 428);
  assert.ok(!s.callsOf('admin.retention.request').some((c) => c.args[1]), '没确认过就不把确认语交给核心');
  const pr = await s.prepare('retention.request', { to: '1y' });
  assert.equal(pr.phrase, '确认删除 2025-11 之前的原文', '确认语是核心按影响算出来的');
  assert.equal(pr.preview.coolingOffDays, 7);
  assert.equal(pr.preview.impact.percepts, 18_420);
  assert.equal(pr.preview.from, '5y');
  const typo = await s.act('retention.request', { to: '1y', confirm: { token: pr.token, typed: '确认删除' } });
  assert.equal(typo.status, 422);
  const ok = await s.act('retention.request', { to: '1y', confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.status, 'cooling-off');
  assert.equal(s.callsOf('admin.retention.request').at(-1).args[1], '确认删除 2025-11 之前的原文');
  assert.equal((await s.act('retention.cancel')).status, 200);
  assert.equal(s.callsOf('admin.retention.cancel').length, 1);
  // 保留期不能经配置改（D56）
  assert.equal((await s.act('config.set', { key: 'retention.coolingOffDays', value: 0 })).status, 400);
});

test('按场合切模式：只有关 / 开（没有影子档），都不用确认；「按默认」撤掉覆盖；没有的场合 404', async () => {
  const s = setup();
  const one = await s.act('setting.mode', { settingKey: 'sk-private-owner', mode: 'live' });
  assert.equal(one.status, 200);
  assert.deepEqual(s.callsOf('admin.rules.add').at(-1).args[0], { kind: 'mode', target: { settingKey: 'sk-private-owner' }, value: 'live' });
  // 群开着是默认（她在哪儿都记得，说不说由关口逐条判断）：不弹确认
  const grp = await s.act('setting.mode', { settingKey: 'sk-group-big', mode: 'live' });
  assert.equal(grp.status, 200);
  assert.equal((await s.act('setting.mode', { settingKey: 'sk-comments', mode: 'off' })).status, 200, '关掉这里的记忆不用确认（已有的不删）');
  assert.equal((await s.act('setting.mode', { settingKey: 'sk-comments', mode: 'shadow' })).status, 400, '没有影子档了');
  const def = await s.act('setting.mode', { settingKey: 'sk-group-small', mode: 'default' });
  assert.equal(def.status, 200);
  assert.deepEqual(s.callsOf('admin.rules.revoke').map((x) => x.args[0]), [4]);
  assert.equal((await s.act('setting.mode', { settingKey: 'sk-unknown', mode: 'live' })).status, 404);
});

test('「别记这里」开关：关掉加一条别记规则（已有就不重复），打开撤掉', async () => {
  const s = setup();
  const off = await s.act('setting.remember', { settingKey: 'sk-web', remember: false });
  assert.equal(off.status, 200);
  assert.deepEqual(s.callsOf('admin.rules.add')[0].args[0].target, { settingKey: 'sk-web' });
  await s.act('setting.remember', { settingKey: 'sk-web', remember: false });
  assert.equal(s.callsOf('admin.rules.add').length, 1);
  await s.act('setting.remember', { settingKey: 'sk-web', remember: true });
  assert.equal(s.callsOf('admin.rules.revoke').length, 1);
});

test('规则：别记和披露规则交给核心（加的人记成 owner 是核心的事），撤销按 id', async () => {
  const s = setup();
  const r = await s.act('rules.add', { kind: 'disclosure', target: { entityId: '10' }, value: { restriction: 'strict', deny: [13, 17, 13] }, note: '  备注  ' });
  assert.equal(r.status, 200);
  assert.deepEqual(s.callsOf('admin.rules.add')[0].args[0], { kind: 'disclosure', target: { entityId: 10 }, value: { restriction: 'strict', deny: [13, 17] }, note: '备注' });
  assert.equal((await s.act('rules.revoke', { id: r.body.result.id })).status, 200);
});

test('配置：预算预设、各类场合的默认档直接改（没有影子档）；宿主说有风险的（关掉总开关）先回 428 带理由，带 ask 再走确认', async () => {
  const s = setup();
  const b = await s.act('config.set', { key: 'budget.preset', value: 'saving' });
  assert.equal(b.status, 200);
  assert.deepEqual(s.hostCallsOf('config.set')[0].args, [{ budget: { preset: 'saving' } }, { confirm: false }]);

  const closedOff = await s.act('config.set', { key: 'mode.byAttributes.closed', value: 'off' });
  assert.equal(closedOff.status, 200);
  assert.deepEqual(s.hostCallsOf('config.set').at(-1).args, [{ mode: { byAttributes: { closed: 'off' } } }, { confirm: false }]);
  assert.equal((await s.act('config.set', { key: 'mode.byAttributes.closed', value: 'live' })).status, 200, '打开不用确认');
  assert.equal((await s.act('config.set', { key: 'mode.byAttributes.public', value: 'shadow' })).status, 400, '没有影子档了');

  const risky = await s.act('config.set', { key: 'mode.global', value: 'off' });
  assert.equal(risky.status, 428);
  assert.deepEqual(risky.body.reasons, ['总开关改成 off']);
  assert.equal(s.host.config.get().core.mode.global, 'live', '宿主没写');
  const asked = await s.confirmAct('config.set', { key: 'mode.global', value: 'off', ask: true });
  assert.equal(asked.status, 200);
  assert.equal(s.host.config.get().core.mode.global, 'off');

  // 宿主拒绝、写不成：给主人看得懂的错误
  s.host.config.set = () => ({ ok: false, warnings: ['写配置文件失败：EPERM'] });
  const w = await s.act('config.set', { key: 'sleep.growth.mode', value: 'approve' });
  assert.equal(w.status, 409);
  assert.equal(w.body.code, 'CONFIG_WRITE');
  s.host.config.set = () => ({ ok: false, warnings: [], rejected: ['不能经配置改'] });
  assert.equal((await s.act('config.set', { key: 'sleep.growth.mode', value: 'approve' })).body.code, 'REJECTED');
  const noHost = setup({ host: null });
  assert.equal((await noHost.act('config.set', { key: 'budget.preset', value: 'saving' })).status, 503);
  // DSH 宿主不成功时抛错（host/index.js）：同样变成 428 带理由 / 422 / 409
  const thrower = setup();
  const err = (code, extra = {}) => Object.assign(new Error(`宿主：${code}`), { code, ...extra });
  thrower.host.config.set = (patch, opt) => { if (!opt.confirm) throw err('CONFIRM_REQUIRED', { needsConfirm: ['总开关改成 off'] }); return { ok: true, warnings: [] }; };
  const r428 = await thrower.act('config.set', { key: 'mode.global', value: 'off' });
  assert.equal(r428.status, 428);
  assert.deepEqual(r428.body.reasons, ['总开关改成 off']);
  assert.equal((await thrower.confirmAct('config.set', { key: 'mode.global', value: 'off', ask: true })).status, 200);
  thrower.host.config.set = () => { throw err('CONTRACT'); };
  assert.equal((await thrower.act('config.set', { key: 'sleep.growth.mode', value: 'approve' })).body.code, 'REJECTED');
  thrower.host.config.set = () => { throw err('UNAVAILABLE'); };
  assert.equal((await thrower.act('config.set', { key: 'sleep.growth.mode', value: 'approve' })).body.code, 'CONFIG_WRITE');
});

test('显卡：「一直用」要确认（宿主也当有风险的改动）；自适应直接改；游戏模式可以只开几个小时', async () => {
  const s = setup();
  assert.equal((await s.act('gpu.policy', { policy: 'on' })).status, 428);
  const on = await s.confirmAct('gpu.policy', { policy: 'on' });
  assert.equal(on.status, 200);
  assert.deepEqual(s.hostCallsOf('gpu.setPolicy')[0].args, [{ policy: 'on', confirm: true }]);
  assert.equal((await s.act('gpu.policy', { policy: 'adaptive' })).status, 200);
  assert.deepEqual(s.hostCallsOf('gpu.setPolicy')[1].args, [{ policy: 'adaptive', confirm: false }]);
  assert.equal((await s.act('gpu.gameMode', { on: true, hours: 2 })).status, 200);
  assert.deepEqual(s.hostCallsOf('gpu.setPolicy')[2].args, [{ gameMode: { on: true, hours: 2 } }]);
  assert.equal((await s.act('gpu.gameMode', { on: false })).status, 200);
  const empty = setup({ scenario: 'empty' });   // 这个宿主没有 setPolicy
  assert.equal((await empty.act('gpu.policy', { policy: 'off' })).status, 503);
});

test('备份加密：恢复码只在确认后的那一次响应里出现；同一个令牌拿不到第二次', async () => {
  const s = setup();
  const pr = await s.prepare('backup.encryption', {});
  assert.equal(pr.phrase, '更换恢复码', '已经开过加密：换恢复码要输入确认语');
  assert.ok(!JSON.stringify(pr).includes('PM7Q'), '预览里没有恢复码');
  const r = await s.act('backup.encryption', { confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.recoveryCode, 'PM7Q-4KX2-9WZD-HT3M-8RBV-C6NE');
  assert.equal(r.body.result.keyId, 'k-3f9a');
  assert.deepEqual(s.callsOf('admin.backup.setupEncryption')[0].args, [{}], '不由页面给恢复码，核心生成');
  const again = await s.act('backup.encryption', { confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(again.status, 428);
  assert.equal(s.callsOf('admin.backup.setupEncryption').length, 1);
  const first = setup({ scenario: 'empty' });
  const p1 = await first.prepare('backup.encryption', {});
  assert.equal(p1.phrase, null, '第一次开启只要确认，不用输入确认语');
});

test('整体恢复：页面只给备份的 id，路径由服务端查登记；确认语是核心预览给的；恢复后只回文件名', async () => {
  const s = setup();
  assert.equal((await s.act('backup.restore', { id: 1 })).status, 428);
  const pr = await s.prepare('backup.restore', { id: 1 });
  assert.equal(pr.phrase, '确认恢复到 2026-11-03 04:30 的备份');
  assert.equal(pr.preview.pack.path, undefined, '预览里不带整条路径');
  assert.match(pr.preview.pack.name, /\.pmpack$/);
  const packPath = s.callsOf('admin.backup.preview')[0].args[0];
  assert.match(packPath, /^E:\\data\\memory\\backup\\daily\\/);
  const r = await s.act('backup.restore', { id: 1, confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(r.status, 200);
  assert.equal(s.callsOf('admin.backup.restore')[0].args[0], packPath);
  assert.equal(s.callsOf('admin.backup.restore')[0].args[1].confirmPhrase, '确认恢复到 2026-11-03 04:30 的备份');
  assert.equal(r.body.result.preRestorePack, 'pm-pre.pmpack');
  assert.equal((await s.prepare('backup.restore', { id: 9999 }).catch((e) => e.message)).includes('404'), true);
  // 包验证不过：不发令牌，告诉主人为什么
  s.pm.admin.backup.preview = async () => ({ ok: false, errors: ['sha256 对不上'] });
  const bad = await s.prepare('backup.restore', { id: 3 });
  assert.equal(bad.token, undefined);
  assert.match(bad.refuse, /sha256/);
});

test('部分恢复：选择器校验后排序绑定令牌；恢复码不进绑定、不进预览', async () => {
  const s = setup();
  const params = { id: 1, selector: { entityIds: [13, 10], before: Date.UTC(2026, 9, 1) }, recoveryCode: 'ABCD-EFGH' };
  const pr = await s.prepare('backup.restorePartial', params);
  assert.equal(pr.phrase, '确认部分恢复');
  assert.deepEqual(pr.preview.selector, { entityIds: [10, 13], before: Date.UTC(2026, 9, 1) });
  assert.ok(!JSON.stringify(pr).includes('ABCD'));
  const r = await s.act('backup.restorePartial', { ...params, recoveryCode: 'ANOTHER-CODE', confirm: { token: pr.token, typed: pr.phrase } });
  assert.equal(r.status, 200);
  const call = s.callsOf('admin.backup.restorePartial')[0];
  assert.deepEqual(call.args[1], { entityIds: [10, 13], before: Date.UTC(2026, 9, 1) });
  assert.deepEqual(call.args[2], { recoveryCode: 'ANOTHER-CODE' });
});

test('审核：驳回不用确认；批准「按来源撤回」= 彻底删除，要输入确认语；批准挂起的发言要确认；处理过的 404', async () => {
  const s = setup();
  assert.equal((await s.act('review.decide', { id: 12, decision: 'approve' })).status, 200, '合并不用确认');
  assert.equal((await s.act('review.decide', { id: 15, decision: 'reject' })).status, 200);
  assert.equal((await s.act('review.decide', { id: 14, decision: 'approve' })).status, 428);
  const w = await s.prepare('review.decide', { id: 14, decision: 'approve' });
  assert.equal(w.phrase, '彻底删除 4 条');
  assert.equal(w.preview.refs, 4);
  assert.equal((await s.act('review.decide', { id: 14, decision: 'approve', confirm: { token: w.token, typed: w.phrase } })).status, 200);
  const hold = await s.prepare('review.decide', { id: 11, decision: 'approve' });
  assert.equal(hold.phrase, null);
  assert.equal(hold.preview.kind, 'held_utterance');
  assert.equal((await s.act('review.decide', { id: 11, decision: 'approve', confirm: { token: hold.token } })).status, 200);
  assert.deepEqual(s.callsOf('admin.review.decide').map((c) => c.args), [[12, 'approve'], [15, 'reject'], [14, 'approve'], [11, 'approve']]);
  assert.equal((await s.act('review.decide', { id: 14, decision: 'approve' })).status, 404, '已经处理过了');
});

test('需要你知道：标为已读；按来源撤回先预览这个人、这段时间，确认后交给核心（核心先隐藏、进审核）', async () => {
  const s = setup();
  assert.equal((await s.act('ntk.read', { id: '1' })).status, 200);
  assert.deepEqual(s.callsOf('admin.needToKnow.markRead')[0].args, [1]);
  const q = { entityId: 13, from: Date.UTC(2026, 10, 3), to: Date.UTC(2026, 10, 4) };
  assert.equal((await s.act('source.withdraw', q)).status, 428);
  const c = await s.confirmAct('source.withdraw', q);
  assert.equal(c.pr.preview.name, '小雨');
  assert.equal(c.status, 200);
  assert.deepEqual(s.callsOf('admin.withdrawBySource')[0].args[0], q);
  assert.deepEqual(c.body.result, { reviewId: 99, refs: 6 });
});

test('夜里改过的（D122 评审）：撤销一次改正要确认；撤不了的给人话', async () => {
  const s = setup();
  assert.equal((await s.act('check.revert', { id: 3 })).status, 428);
  const c = await s.confirmAct('check.revert', { id: 3 });
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.result, { restored: 'a16' });
  assert.deepEqual(s.callsOf('admin.checks.revert').map((x) => x.args[0]), [3]);
  const no = await s.confirmAct('check.revert', { id: 1 });
  assert.equal(no.status, 400);
  assert.match(JSON.stringify(no.body), /这次核对没改东西/);
  assert.equal((await s.act('check.revert', { id: 'x' })).status, 400);
});

test('成长块：撤销单处直接做；回到旧版本要确认；没有的版本 404', async () => {
  const s = setup();
  assert.equal((await s.act('growth.revoke', { version: 2 })).status, 200);
  assert.equal((await s.act('growth.revoke', { version: 42 })).status, 404);
  assert.equal((await s.act('growth.rollback', { version: 1 })).status, 428);
  const c = await s.confirmAct('growth.rollback', { version: 1 });
  assert.deepEqual(c.pr.preview, { from: 5, to: 1, undone: 2 }, '第 2 版上面撤销过了，之后没撤销的是第 4、5 版');
  assert.equal(c.status, 200);
  const zero = await s.prepare('growth.rollback', { version: 0 });
  assert.equal(zero.preview.to, 0);
  const none = await s.prepare('growth.rollback', { version: 9 });
  assert.match(none.refuse, /没有这个版本/);
});

test('其它：立即备份同一时间只跑一个；换向量空间要确认；导出没有目录 503', async () => {
  const s = setup();
  let release;
  s.pm.admin.backup.now = () => new Promise((r) => { release = () => r([{ kind: 'manual', location: 'local', verified: true, size: 1 }]); });
  const first = s.act('backup.now');
  await new Promise((r) => setTimeout(r, 10));
  const second = await s.act('backup.now');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'BUSY');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await s.act('embedding.activate', { spaceId: 'sp-06b' })).status, 428);
  const c = await s.confirmAct('embedding.activate', { spaceId: 'sp-06b' });
  assert.equal(c.status, 200);
  assert.deepEqual(s.callsOf('admin.embedding.activate')[0].args, ['sp-06b', {}]);
  assert.equal((await s.act('backup.export', {})).status, 503);
  assert.equal((await s.act('selfcheck.run')).status, 200);
  assert.deepEqual(s.hostCallsOf('selfCheck')[0].args, [{ force: true }]);
});

test('给场合起名字 / 恢复自动（D111）：不用确认；名字最多 40 字、不许控制字符；空的就是清掉；没有的场合 404', async () => {
  const s = setup();
  const r = await s.act('setting.rename', { settingKey: 'sk-group-noname', label: ' 周五桌游群 ' });
  assert.equal(r.status, 200);
  assert.deepEqual(s.callsOf('admin.renameSetting').at(-1).args, ['sk-group-noname', '周五桌游群']);
  let v = (await s.view('settings')).body.data.items.find((x) => x.key === 'sk-group-noname');
  assert.deepEqual([v.label, v.labelSource, v.title], ['周五桌游群', 'owner', '周五桌游群']);
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-group-noname', label: null })).status, 200);
  assert.deepEqual(s.callsOf('admin.renameSetting').at(-1).args, ['sk-group-noname', null]);
  v = (await s.view('settings')).body.data.items.find((x) => x.key === 'sk-group-noname');
  assert.deepEqual([v.label, v.labelSource], ['一个 QQ 群', 'adapter']);
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-group-noname', label: '' })).status, 200, '空串也是清掉');
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-group-noname', label: '长'.repeat(41) })).status, 400);
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-group-noname', label: 'a\u0007b' })).status, 400);
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-group-noname', label: 'x', extra: 1 })).status, 400);
  const zw = await s.act('setting.rename', { settingKey: 'sk-group-noname', label: '​​' });
  assert.equal(zw.status, 400, '只有看不见的字符：不当清掉，报错');
  assert.match(JSON.stringify(zw.body), /没有能显示的字/);
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-group-noname', label: 'Ｑ群①' })).status, 200);
  assert.deepEqual(s.callsOf('admin.renameSetting').at(-1).args, ['sk-group-noname', 'Ｑ群①'], '名字原样交给核心（不做 NFKC）');
  assert.equal((await s.act('setting.rename', { settingKey: 'sk-unknown', label: 'x' })).status, 404);
  const pre = await s.prepare('setting.rename', { settingKey: 'sk-group-noname', label: 'x' });
  assert.equal(pre.needsConfirm, false, '随时能改回来，不用确认');
});

test('花费护栏（D121）：自定义存成 budget.overrides（和那一档一样的不存）；回到一档清空；不设上限、关余额保护、去掉上限要确认，和现在一样的不再问', async () => {
  const s = setup();
  // 普通的自定义：不用确认，整个替换 budget.overrides；和宽松档一样的项（dailyCalls 3000、rerank true）不存
  const r = await s.act('budget.set', { preset: 'loose', overrides: { dailyCalls: 10_000, dailyUncachedTokens: 20_000_000, dailyOutputTokens: 3_000_000, perSourceShare: 0.8, rerank: true, sleepDepth: 'essential' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const call = s.hostCallsOf('config.set').at(-1);
  assert.deepEqual(call.args, [{ budget: { preset: 'loose', overrides: { dailyCalls: 10_000, dailyUncachedTokens: 20_000_000, dailyOutputTokens: 3_000_000, perSourceShare: 0.8, sleepDepth: 'essential' } } },
    { confirm: false, replace: ['budget.overrides'] }]);
  let c = (await s.view('config')).body.data;
  assert.equal(c.budgetConfig.custom, true);
  assert.equal(c.budgetConfig.effective.dailyCalls, 10_000);
  assert.equal(c.budgetConfig.presets.loose.dailyCalls, 3000, '每一档自己的值照给（页面写「宽松档 3000 次」）');
  assert.equal(c.budget.custom, true, '护栏的状态也知道是自定义');
  assert.equal(c.budget.limits.dailyCalls, 10_000, '改了立即生效（BudgetPort 读的同一份配置）');
  assert.equal(c.budget.limits.dailyOutputTokens, 3_000_000);

  // 回到节省：overrides 清空
  assert.equal((await s.act('budget.set', { preset: 'saving' })).status, 200);
  assert.deepEqual(s.hostCallsOf('config.set').at(-1).args, [{ budget: { preset: 'saving', overrides: {} } }, { confirm: false, replace: ['budget.overrides'] }]);
  c = (await s.view('config')).body.data;
  assert.equal(c.budgetConfig.custom, false);
  assert.deepEqual(c.budgetConfig.overrides, {});
  assert.equal(c.budget.limits.dailyCalls, 600);

  // 换成不设上限：没确认就 428；确认的预览里有一句说明
  const un = await s.act('budget.set', { preset: 'unlimited' });
  assert.equal(un.status, 428);
  const pr = await s.prepare('budget.set', { preset: 'unlimited' });
  assert.match(pr.preview.reasons.join(), /不设上限.*余额保护/);
  const ok = await s.confirmAct('budget.set', { preset: 'unlimited' });
  assert.equal(ok.status, 200);
  assert.deepEqual(s.hostCallsOf('config.set').at(-1).args[1], { confirm: true, replace: ['budget.overrides'] });
  c = (await s.view('config')).body.data;
  assert.equal(c.budgetConfig.preset, 'unlimited');
  assert.deepEqual([c.budget.limits.dailyCalls, c.budget.limits.dailyUncachedTokens, c.budget.limits.dailyOutputTokens], ['none', 'none', 'none']);
  assert.equal(c.budget.limits.balanceProtectDays, 1, '余额保护照留');
  // 已经是不设上限：在它上面改别的项不再问
  assert.equal((await s.act('budget.set', { preset: 'unlimited', overrides: { balanceProtectDays: 2 } })).status, 200);

  // 关掉余额保护要确认；已经是 0 再改别的项不再问
  assert.equal((await s.act('budget.set', { preset: 'loose', overrides: { balanceProtectDays: 0 } })).status, 428);
  assert.equal((await s.confirmAct('budget.set', { preset: 'loose', overrides: { balanceProtectDays: 0 } })).status, 200);
  assert.equal((await s.act('budget.set', { preset: 'loose', overrides: { balanceProtectDays: 0, dailyCalls: 5000 } })).status, 200);
  // 在有上限的档上去掉某一项上限要确认
  const lift = await s.prepare('budget.set', { preset: 'loose', overrides: { balanceProtectDays: 0, dailyCalls: null } });
  assert.equal(lift.needsConfirm, true);
  assert.deepEqual(lift.preview.reasons, ['去掉每天后台调用次数的上限：程序失控时不会被拦住']);
  // 令牌绑定参数：拿「不设上限」的令牌换别的改动不行
  const pr2 = await s.prepare('budget.set', { preset: 'saving', overrides: { balanceProtectDays: 0, dailyOutputTokens: null } });
  const swapped = await s.act('budget.set', { preset: 'saving', overrides: { balanceProtectDays: 0, dailyOutputTokens: null, dailyCalls: null }, confirm: { token: pr2.token } });
  assert.notEqual(swapped.status, 200);
  // 每次写都记一行日志（操作名，不记值）
  assert.ok(s.logs.some(([, ev, f]) => ev === 'admin.request' && f?.action === 'budget.set'));
});
