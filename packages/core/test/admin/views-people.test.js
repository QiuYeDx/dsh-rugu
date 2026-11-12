// 管理页上能选的人（D161）：选择器里不列收回的档案、不列场合；认成同一个人的几个档案（信念层 rel='same'）并成一项，
// 代表按 有身份证据 > established > 被提到的天数多 > id 小 挑；一组都没名字的不列；同名的带上名字用在哪个场合。
// 按人筛（原话、事实、情节、意图）展开成那个人名下的全部档案。名字都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminCore, seedSetting, seedEntity, seedPercept, seedAssertion, seedEpisode, seedIdentity } from './fixtures.js';

const withCore = (name, fn) => async () => {
  const t = await adminCore(name);
  try { await fn(t.core); } finally { await t.cleanup(); }
};

function world(core) {
  const sk1 = seedSetting(core, { label: '编的小群' });
  const sk2 = seedSetting(core, { label: '编的大群' });
  const ent = (o) => {
    const id = seedEntity(core, { name: o.name ?? '无名' });
    core.store.run('UPDATE entities SET kind = ?, status = ?, display_name = ?, mention_days = ?, is_self = ? WHERE id = ?',
      o.kind ?? 'person', o.status ?? 'established', o.name ?? null, o.days ?? 0, o.self ? 1 : 0, id);
    return id;
  };
  const link = (a, b, rel = 'same', by = 'extractor') => core.store.run(
    'INSERT INTO entity_links(a, b, rel, confidence, decided_by, at, created_at) VALUES (?, ?, ?, 0.9, ?, ?, ?)', Math.min(a, b), Math.max(a, b), rel, by, core.now(), core.now());
  const me = ent({ name: '小雪', self: true });
  seedIdentity(core, { entityId: me });
  const ming = ent({ name: '阿明', days: 2 });
  seedIdentity(core, { entityId: ming });
  const ming2 = ent({ name: '明哥', status: 'provisional', days: 9 });          // 天数多，但没有身份证据：不当代表
  const ming3 = ent({ name: null, status: 'provisional' });                     // 没名字，经 ming2 连过来
  const mingGhost = ent({ name: '[', status: 'retracted' });                    // 收回的：并在组里（按人筛看得到它名下的），不当名字
  link(ming, ming2); link(ming2, ming3); link(ming, mingGhost);
  const maybe = ent({ name: '阿明明' });
  link(ming, maybe, 'maybe_same');                                              // 「可能是」不并
  const ghost = ent({ name: '@阿明你好', status: 'retracted' });
  const group = ent({ name: '编的大群', kind: 'setting' });
  const nameless = ent({ name: null });
  const pet = ent({ name: '团团', kind: 'pet' });
  const hong1 = ent({ name: '小红' });
  const hong2 = ent({ name: '小红' });
  core.store.run("INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, count, first, last) VALUES (?, '小红', '小红c', ?, 'card', 3, 1, 1)", hong1, sk1);
  core.store.run("INSERT INTO entity_names(entity_id, text_raw, text_norm, scope_setting_key, name_kind, count, first, last) VALUES (?, '小红', '小红c', ?, 'card', 2, 1, 1)", hong2, sk2);
  return { sk1, sk2, me, ming, ming2, ming3, mingGhost, maybe, ghost, group, nameless, pet, hong1, hong2 };
}

test('pickable：一个人一项；不列收回的、场合、没名字的；并起来的档案、代表、别名、同名的场合', withCore('adm-pick', (core) => {
  const w = world(core);
  const p = core.mods.admin.list(core, { view: 'pickable' });
  const ids = p.items.map((x) => x.id);
  assert.equal(p.total, p.items.length);
  for (const gone of [w.ming2, w.ming3, w.mingGhost, w.ghost, w.group, w.nameless]) assert.ok(!ids.includes(gone), `不该列出 ${gone}`);
  const ming = p.items.find((x) => x.id === w.ming);
  assert.ok(ming, '有身份证据的档案当代表');
  assert.deepEqual(ming.members, [w.ming, w.ming2, w.ming3, w.mingGhost].sort((a, b) => a - b));
  assert.deepEqual([ming.name, ming.aliases, ming.status, ming.isSelf], ['阿明', ['明哥'], 'established', false]);
  assert.ok(ids.includes(w.maybe), '「可能是同一个」不并');
  assert.deepEqual(p.items.find((x) => x.id === w.me).isSelf, true);
  assert.equal(p.items.find((x) => x.id === w.pet).kind, 'pet');
  const hongs = p.items.filter((x) => x.name === '小红');
  assert.deepEqual(hongs.map((x) => x.place).sort(), [w.sk1, w.sk2].sort(), '同名的两个人靠名字用在哪个场合分开');
  assert.equal(core.mods.admin.list(core, { view: 'pickable', limit: 2 }).items.length, 2);
}));

test('pickable：代表按 有身份证据 > established > 天数 > id；一组只剩收回的就不列', withCore('adm-pick-rep', (core) => {
  const w = world(core);
  // 没有身份证据时：established 的胜过 provisional 的（哪怕天数少）
  core.store.run('DELETE FROM identity_evidence WHERE entity_id = ?', w.ming);
  let ming = core.mods.admin.list(core, { view: 'pickable' }).items.find((x) => x.members.includes(w.ming2));
  assert.equal(ming.id, w.ming);
  core.store.run("UPDATE entities SET status = 'established' WHERE id = ?", w.ming2);
  ming = core.mods.admin.list(core, { view: 'pickable' }).items.find((x) => x.members.includes(w.ming2));
  assert.equal(ming.id, w.ming2, '都 established：天数多的');
  assert.deepEqual([ming.name, ming.aliases], ['明哥', ['阿明']]);
  core.store.run("UPDATE entities SET status = 'retracted' WHERE id IN (?, ?, ?)", w.ming, w.ming2, w.ming3);
  assert.ok(!core.mods.admin.list(core, { view: 'pickable' }).items.some((x) => x.members.includes(w.ming)), '全收回了：不列');
}));

test('按人筛：展开成那个人名下的全部档案（原话、事实、情节、意图），别的人不跟着进来', withCore('adm-pick-filter', (core) => {
  const w = world(core);
  const p1 = seedPercept(core, { settingKey: w.sk1, actor: w.ming2, text: '明哥说的话' });
  const p2 = seedPercept(core, { settingKey: w.sk1, actor: w.ming, text: '阿明说的话' });
  const p3 = seedPercept(core, { settingKey: w.sk1, actor: w.maybe, text: '阿明明说的话' });
  const p4 = seedPercept(core, { settingKey: w.sk1, actor: w.mingGhost, text: '收回的档案名下的话' });
  const a1 = seedAssertion(core, { text: '关于没名字的那个档案', subjects: [w.ming3], perceptIds: [p1], settingKey: w.sk1 });
  const a2 = seedAssertion(core, { text: '关于阿明明', subjects: [w.maybe], perceptIds: [p3], settingKey: w.sk1 });
  const e1 = seedEpisode(core, { settingKey: w.sk1, participants: [w.ming2], perceptIds: [p1] });
  seedEpisode(core, { settingKey: w.sk1, participants: [w.maybe], perceptIds: [p3] });
  const t1 = Number(core.store.run("INSERT INTO intentions(act, text, origin, state, target_entity_id, formed_at, created_at, updated_at) VALUES ('ask', '问问明哥', 'self-care', 'formed', ?, ?, ?, ?)",
    w.ming2, core.now(), core.now(), core.now()).lastInsertRowid);
  const refs = (view, entityId) => core.mods.admin.list(core, { view, entityId }).items.map((x) => x.ref).sort();
  assert.deepEqual(refs('percepts', w.ming), [`p${p1}`, `p${p2}`, `p${p4}`].sort());
  assert.deepEqual(refs('percepts', w.ming2), [`p${p1}`, `p${p2}`, `p${p4}`].sort(), '从组里哪个档案选都一样');
  assert.deepEqual(refs('assertions', w.ming), [`a${a1}`]);
  assert.deepEqual(refs('episodes', w.ming), [`e${e1}`]);
  assert.deepEqual(refs('intentions', w.ming), [`t${t1}`]);
  assert.deepEqual(refs('assertions', w.maybe), [`a${a2}`], '「可能是」的不展开');
  // 按天计数用同一套条件
  const days = core.mods.admin.list(core, { view: 'days', of: 'percepts', entityId: w.ming, month: new Date(core.now()).toISOString().slice(0, 7) });
  assert.equal(days.items.reduce((s, x) => s + x.n, 0), 3);
}));
