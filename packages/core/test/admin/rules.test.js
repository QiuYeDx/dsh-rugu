// 规则（§12.2 rules、§12.7「别记」、§9.3.2 B4 主人的披露规则）和按场合的模式（§10.1、§15.2、D5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../../src/contract/errors.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { invalidateRules } from '../../src/admin/rules.js';
import { adminCore, seedSetting, seedEntity, seedPercept, seedAssertion, setDescriptor, descriptors } from './fixtures.js';

const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};

test('addRule：三种规则都按目标的属性写，不认入口名；不合契约的抛 ContractError', withCore('adm-rule-add', (core) => {
  const at = core.now();
  const sk = seedSetting(core);
  const e = seedEntity(core);
  const a = seedAssertion(core, { text: '阿明换工作了' });
  const r1 = core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { settingKey: sk }, createdBy: 'owner', at });
  const r2 = core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { entityId: e }, createdBy: 'tool', at });
  const r3 = core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { ref: `a${a}` }, createdBy: `subject:${e}`, at });
  const r4 = core.mods.admin.addRule(core, { kind: 'disclosure', target: { attribute: 'health', settingAttrs: { publicLike: true } }, value: { restriction: 'strict', deny: [e, e] }, createdBy: 'owner', at });
  assert.ok([r1, r2, r3, r4].every((x) => Number.isInteger(x) && x > 0));
  const dnr = core.mods.admin.activeRules(core, 'do_not_remember');
  assert.equal(dnr.length, 3);
  assert.deepEqual(dnr.map((r) => r.target), [{ settingKey: sk }, { entityId: e }, { ref: `a${a}` }]);
  const disc = core.mods.admin.activeRules(core, 'disclosure');
  assert.deepEqual(disc[0].value, { restriction: 'strict', deny: [e] });
  // 不合契约
  const bads = [
    { kind: 'nope', target: {}, createdBy: 'owner', at },
    { kind: 'do_not_remember', target: { settingKey: sk, entityId: e }, createdBy: 'owner', at },     // 只能一个目标
    { kind: 'do_not_remember', target: { settingKey: sk }, createdBy: 'stranger', at },               // 来源不认识
    { kind: 'disclosure', target: { settingAttrs: { adapter: 'zz' } }, value: { restriction: 'soft' }, createdBy: 'owner', at },   // 按入口 → 拒绝
    { kind: 'disclosure', target: { attribute: 'x' }, value: { restriction: 'soft' }, createdBy: 'tool', at },  // 披露规则只能主人写
    { kind: 'disclosure', target: {}, value: { restriction: 'soft' }, createdBy: 'owner', at },
    { kind: 'mode', target: { settingKey: sk }, value: 'loud', createdBy: 'owner', at },
    { kind: 'mode', target: { settingKey: sk }, value: 'shadow', createdBy: 'owner', at },           // 没有影子档了（用户反馈第 6 轮）
    { kind: 'mode', target: { settingKey: sk }, value: 'live', createdBy: 'tool', at },               // 模式只能主人在管理页改（§9.6）
  ];
  for (const b of bads) assert.throws(() => core.mods.admin.addRule(core, b), ContractError, JSON.stringify(b));
}));

test('revokeRule / activeRules：撤销后立即不生效（缓存跟着失效）；事务回滚不留下没提交的规则', withCore('adm-rule-revoke', (core) => {
  const sk = seedSetting(core);
  const id = core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { settingKey: sk }, createdBy: 'owner', at: core.now() });
  assert.equal(core.mods.admin.doNotRemember(core, { settingKey: sk }), true);
  core.mods.admin.revokeRule(core, id, { at: core.now() });
  assert.equal(core.mods.admin.doNotRemember(core, { settingKey: sk }), false);
  assert.equal(core.mods.admin.activeRules(core, 'do_not_remember').length, 0);
  assert.ok(core.store.get('SELECT revoked_at FROM rules WHERE id = ?', id).revoked_at);
  assert.throws(() => core.mods.admin.revokeRule(core, 0, { at: core.now() }), ContractError);
  assert.throws(() => core.mods.admin.activeRules(core, 'bogus'), ContractError);
  // 在事务里加了又回滚：缓存里不会留下
  assert.throws(() => core.store.tx(() => {
    core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { settingKey: sk }, createdBy: 'owner', at: core.now() });
    assert.equal(core.mods.admin.doNotRemember(core, { settingKey: sk }), true);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(core.mods.admin.doNotRemember(core, { settingKey: sk }), false);
}));

test('doNotRemember：场合、说话人、被忘掉的记忆都能命中；别的不命中', withCore('adm-dnr', (core) => {
  const sk = seedSetting(core);
  const other = seedSetting(core);
  const e = seedEntity(core, { name: '阿明' });
  const f = seedEntity(core, { name: '小红' });
  core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { settingKey: sk }, createdBy: 'owner', at: core.now() });
  core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { entityId: e }, createdBy: 'owner', at: core.now() });
  core.mods.admin.addRule(core, { kind: 'do_not_remember', target: { ref: 'a7' }, createdBy: 'system', at: core.now() });
  assert.equal(core.mods.admin.doNotRemember(core, { settingKey: sk }), true);
  assert.equal(core.mods.admin.doNotRemember(core, { settingKey: other }), false);
  assert.equal(core.mods.admin.doNotRemember(core, { settingKey: other, entityIds: [f, e] }), true);
  assert.equal(core.mods.admin.doNotRemember(core, { entityIds: [f] }), false);
  assert.equal(core.mods.admin.doNotRemember(core, /** @type {any} */ ({ ref: 'a7' })), true);
  assert.equal(core.mods.admin.doNotRemember(core, {}), false);
}));

test('modeFor：min(global, 场合覆盖 ?? 按属性的默认档)；按属性只看一对一 + 管理者 / 公开 / 其他', withCore('adm-mode', (core, t) => {
  const principal = seedEntity(core, { name: '主人', authority: 'principal', closeness: 1 });
  const friend = seedEntity(core, { name: '阿明' });
  const dm = seedSetting(core, { descriptor: descriptors.oneOnOne });
  const dmFriend = seedSetting(core, { descriptor: descriptors.oneOnOne });
  const group = seedSetting(core, { descriptor: descriptors.group });
  const pub = seedSetting(core, { descriptor: descriptors.public });
  seedPercept(core, { settingKey: dm, actor: principal, text: '在吗' });
  seedPercept(core, { settingKey: dmFriend, actor: friend, text: '在吗' });
  seedPercept(core, { settingKey: group, actor: principal, text: '大家好' });
  // 默认：每类场合都开着（§15.2，用户反馈第 6 轮：说不说由关口逐条判断，不按场合一刀切）
  for (const k of [dm, dmFriend, group, pub, 'sk-never-described']) assert.equal(core.mods.admin.modeFor(core, k), 'live', k);
  // 按属性分类本身照旧：主人把「封闭的群」「公开场合」这两类关掉时看得出来
  core.config.update({ mode: { byAttributes: { closed: 'off', public: 'off' } } });
  assert.equal(core.mods.admin.modeFor(core, dm), 'live');
  assert.equal(core.mods.admin.modeFor(core, dmFriend), 'off', '一对一但对方不是管理者 → 其他');
  assert.equal(core.mods.admin.modeFor(core, group), 'off', '主人在群里也不算一对一');
  assert.equal(core.mods.admin.modeFor(core, pub), 'off');
  assert.equal(core.mods.admin.modeFor(core, 'sk-never-described'), 'off', '没描述过的场合按最保守的一档');
  core.config.update({ mode: { byAttributes: { closed: 'live', public: 'shadow' } } });
  assert.equal(core.mods.admin.modeFor(core, pub), 'live', '配置里写影子档按不合法的值忽略，用默认档');
  // 旧版本留在库里的影子覆盖：当没有覆盖
  core.store.run("INSERT INTO rules (kind, target_json, value_json, created_by, at) VALUES ('mode', ?, ?, 'owner', ?)", JSON.stringify({ settingKey: group }), JSON.stringify('shadow'), core.now());
  invalidateRules(core);
  core.config.update({ mode: { byAttributes: { closed: 'off' } } });
  assert.equal(core.mods.admin.modeFor(core, group), 'off', '旧的影子覆盖不生效，按属性的默认档');
  core.config.update({ mode: { byAttributes: { closed: 'live', public: 'live' } } });
  assert.equal(core.mods.admin.modeFor(core, group), 'live');
  // 场合覆盖（主人在管理页，D5）：最新的为准
  core.mods.admin.addRule(core, { kind: 'mode', target: { settingKey: group }, value: 'live', createdBy: 'owner', at: core.now() });
  assert.equal(core.mods.admin.modeFor(core, group), 'live');
  core.mods.admin.addRule(core, { kind: 'mode', target: { settingKey: group }, value: 'off', createdBy: 'owner', at: core.now() });
  assert.equal(core.mods.admin.modeFor(core, group), 'off');
  assert.equal(core.mods.admin.activeRules(core, 'mode').length, 1, '同一个场合的旧模式规则撤销了');
  // 总开关封顶
  core.config.update({ mode: { global: 'off' } });
  assert.equal(core.mods.admin.modeFor(core, dm), 'off');
  core.config.update({ mode: { global: 'live', byAttributes: { public: 'off' } } });
  assert.equal(core.mods.admin.modeFor(core, pub), 'off');
  // 描述换了（私聊被改成任何人可见）：缓存不挡，马上按新属性
  assert.equal(core.mods.admin.modeFor(core, dm), 'live');
  setDescriptor(core, dm, descriptors.public);
  assert.equal(core.mods.admin.modeFor(core, dm), 'off');
}));

test('modeFor 的缓存：一对一里第一次见到管理者马上重算（不用等一分钟）；见到之前的感知不让缓存失效之外的场合重算', withCore('adm-mode-first', (core) => {
  const principal = seedEntity(core, { name: '主人', authority: 'principal', closeness: 1 });
  const friend = seedEntity(core, { name: '阿明' });
  const dm = seedSetting(core, { descriptor: descriptors.oneOnOne });
  const group = seedSetting(core, { descriptor: descriptors.group });
  // 默认每类都开着，看不出分类；主人把「封闭的群」这类关掉时才看得出缓存有没有及时重算
  core.config.update({ mode: { byAttributes: { closed: 'off' } } });
  // 宿主在主人的第一条消息落库之前就问过一次（认领会话时）
  assert.equal(core.mods.admin.modeFor(core, dm), 'off', '还没见到任何人：按「其他」');
  assert.equal(core.mods.admin.modeFor(core, group), 'off');
  seedPercept(core, { settingKey: dm, actor: friend, text: '在吗' });
  assert.equal(core.mods.admin.modeFor(core, dm), 'off', '新感知触发重算，但对方不是管理者');
  seedPercept(core, { settingKey: dm, actor: principal, text: '是我' });
  assert.equal(core.mods.admin.modeFor(core, dm), 'live', '主人的消息落库后马上是主人一对一（§15.2）');
  seedPercept(core, { settingKey: group, actor: principal, text: '大家好' });
  assert.equal(core.mods.admin.modeFor(core, group), 'off', '群不是一对一：主人在场也不改');
}));

test('modeFor 在假平台上：结论只取决于场合属性和在场者是不是管理者', withCore('adm-mode-fake', (core, t, tc) => {
  const fp = createFakePlatform();
  tc.diagnostic(`seed=${fp.seed}`);
  const principal = seedEntity(core, { name: fp.people.principal.name, authority: 'principal', closeness: 1 });
  const keys = {};
  for (const [name, s] of Object.entries(fp.settings)) {
    keys[name] = seedSetting(core, { descriptor: s.descriptor });
    seedPercept(core, { settingKey: keys[name], actor: principal, text: 'hi' });
  }
  // 默认：哪儿都开着
  for (const name of Object.keys(keys)) assert.equal(core.mods.admin.modeFor(core, keys[name]), 'live', `${name} seed=${fp.seed}`);
  // 主人把群和公开场合两类关掉：只剩和主人一对一开着
  core.config.update({ mode: { byAttributes: { closed: 'off', public: 'off' } } });
  const want = { oneOnOne: 'live', smallGroup: 'off', bigGroup: 'off', publicSpace: 'off', workGroup: 'off' };
  for (const [name, mode] of Object.entries(want)) assert.equal(core.mods.admin.modeFor(core, keys[name]), mode, `${name} seed=${fp.seed}`);
}));
