// 隐藏和忘掉（§12.7）：对别人隐藏，主人和审核视图仍可见；忘掉 = 隐藏 + 别记 + 30 天内可恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../../src/contract/errors.js';
import { DAY } from '../fakes/index.js';
import { createConfig } from '../../src/config/defaults.js';
import { adminCore, seedSetting, seedEntity, seedPercept, seedWindow, seedAssertion, seedEpisode } from './fixtures.js';

/** 配置里加 admin 的新键（defaults.js 还没有它时 mergeConfig 会丢掉未知键，所以直接给一个配置句柄）。 */
const withAdmin = (extra) => {
  const base = createConfig({});
  return { get: () => { const c = base.get(); return { ...c, admin: { ...c.admin, ...extra } }; }, onChange: (fn) => base.onChange(fn) };
};
const withCore = (name, fn, opt) => async (tc) => {
  const t = await adminCore(name, opt);
  try { await fn(t.core, t, tc); } finally { await t.cleanup(); }
};

test('suppress hidden / forgotten：所有记忆单元通用；忘掉连带一条指向它的「别记」规则，30 天内可恢复', withCore('adm-sup', (core) => {
  const sk = seedSetting(core);
  const e = seedEntity(core);
  const p = seedPercept(core, { settingKey: sk, actor: e, text: '我失恋了' });
  const a = seedAssertion(core, { text: '阿明失恋了', subjects: [e], perceptIds: [p] });
  const ep = seedEpisode(core, { settingKey: sk, narrative: '阿明说他失恋了', perceptIds: [p] });
  core.mods.admin.suppress(core, `a${a}`, { state: 'hidden', by: 'owner', at: core.now() });
  core.mods.admin.suppress(core, `e${ep}`, { state: 'forgotten', by: 'owner', reason: '主人说别记', at: core.now() });
  core.mods.admin.suppress(core, `n${e}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `a${a}`), 'hidden');
  assert.equal(core.mods.admin.suppression(core, `e${ep}`), 'forgotten');
  assert.equal(core.mods.admin.suppression(core, `p${p}`), null);
  assert.equal(core.mods.admin.suppression(core, 'not-a-ref'), null);
  const row = core.store.get("SELECT * FROM suppressions WHERE owner_kind = 'episode' AND owner_id = ?", ep);
  assert.equal(row.restore_until, core.now() + 30 * DAY);
  assert.ok(row.rule_id);
  assert.equal(core.mods.admin.doNotRemember(core, { ref: `e${ep}` }), true);
  assert.deepEqual([...core.mods.admin.suppressedRefs(core, [`a${a}`, `e${ep}`, `p${p}`, `n${e}`, 'junk'])].sort(), [`a${a}`, `e${ep}`, `n${e}`].sort());
  // 不会把「忘掉」降回「隐藏」
  core.mods.admin.suppress(core, `e${ep}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${ep}`), 'forgotten');
  // 隐藏 → 忘掉 可以升级
  core.mods.admin.suppress(core, `a${a}`, { state: 'forgotten', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `a${a}`), 'forgotten');
  // 不合契约 / 不存在
  assert.throws(() => core.mods.admin.suppress(core, 'x1', { state: 'hidden', by: 'owner', at: core.now() }), ContractError);
  assert.throws(() => core.mods.admin.suppress(core, `a${a}`, { state: 'gone', by: 'owner', at: core.now() }), ContractError);
  assert.throws(() => core.mods.admin.suppress(core, 'a99999', { state: 'hidden', by: 'owner', at: core.now() }), { code: 'NOT_FOUND' });
  // 主人看得到全部（含隐藏的）：admin.get 照常返回内容，并标明状态
  const g = core.mods.admin.get(core, `a${a}`);
  assert.equal(g.row.text, '阿明失恋了');
  assert.equal(g.suppression.state, 'forgotten');
}));

test('restore：隐藏的随时；忘掉的只在 30 天内，连带的「别记」规则一并撤销；过了就 RESTORE_EXPIRED', withCore('adm-restore', (core, t) => {
  const a = seedAssertion(core, { text: '阿明换工作了' });
  const b = seedAssertion(core, { text: '小红搬家了' });
  core.mods.admin.suppress(core, `a${a}`, { state: 'forgotten', by: 'owner', at: core.now() });
  core.mods.admin.suppress(core, `a${b}`, { state: 'forgotten', by: 'owner', at: core.now() });
  t.ports.clock.advance(29 * DAY);
  core.mods.admin.restore(core, `a${a}`, { by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `a${a}`), null);
  assert.equal(core.mods.admin.doNotRemember(core, { ref: `a${a}` }), false);
  t.ports.clock.advance(2 * DAY);
  assert.throws(() => core.mods.admin.restore(core, `a${b}`, { by: 'owner', at: core.now() }), { code: 'RESTORE_EXPIRED' });
  assert.equal(core.mods.admin.suppression(core, `a${b}`), 'forgotten', '30 天之后也不会自动彻底删除：那只由主人决定');
  // 没有隐藏的：什么都不做
  core.mods.admin.restore(core, `a${a}`, { by: 'owner', at: core.now() });
  assert.throws(() => core.mods.admin.restore(core, 'bad', { by: 'owner', at: core.now() }), ContractError);
}));

/** 阿明在群里说了两句，提炼出一段经历和两条事实；当天的小结引用了这两句，日记又引用了小结的那两句。 */
function day(core) {
  const sk = seedSetting(core);
  const A = seedEntity(core, { name: '阿明' });
  const p1 = seedPercept(core, { settingKey: sk, actor: A, text: '我失恋了' });
  const p2 = seedPercept(core, { settingKey: sk, actor: A, text: '周末去爬山吧' });
  const p3 = seedPercept(core, { settingKey: sk, actor: A, text: '今天好热' });
  const w = seedWindow(core, { settingKey: sk, perceptIds: [p1, p2] });
  const w3 = seedWindow(core, { settingKey: sk, perceptIds: [p3] });
  const ev = seedEpisode(core, { settingKey: sk, narrative: '阿明说他失恋了，约大家周末爬山', perceptIds: [p1, p2] });
  const a1 = seedAssertion(core, { text: '阿明失恋了', subjects: [A], perceptIds: [p1], settingKey: sk });
  const a2 = seedAssertion(core, { text: '周末爬山', subjects: [A], perceptIds: [p1, p2], settingKey: sk });
  const sum = seedEpisode(core, { settingKey: sk, kind: 'summary', narrative: '群里阿明说失恋了，还约了爬山', perceptIds: [p1, p2] });
  const diary = seedEpisode(core, { settingKey: '', kind: 'diary', narrative: '今天阿明失恋了', perceptIds: [p1, p2] });
  const other = seedEpisode(core, { settingKey: sk, kind: 'summary', narrative: '今天好热', perceptIds: [p3] });
  return { sk, A, p1, p2, p3, w, w3, ev, a1, a2, sum, diary, other };
}
const reasonOf = (core, ref) => {
  const m = { a: 'assertion', e: 'episode', p: 'percept', w: 'window' }[ref[0]];
  return core.store.get('SELECT by, reason FROM suppressions WHERE owner_kind = ? AND owner_id = ?', m, Number(ref.slice(1))) ?? null;
};

test('隐藏一条事实：从同一批消息汇总出的小结、日记一起对别人隐藏（级联）；提炼出的经历、别的事实不动；恢复时一起恢复', withCore('adm-sup-cascade', (core, t) => {
  const d = day(core);
  core.mods.admin.suppress(core, `a${d.a1}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${d.sum}`), 'hidden', '小结复述了被隐藏的内容');
  assert.equal(core.mods.admin.suppression(core, `e${d.diary}`), 'hidden', '日记也是');
  assert.deepEqual({ ...reasonOf(core, `e${d.sum}`) }, { by: 'system', reason: `cascade:a${d.a1}` });
  for (const ref of [`e${d.ev}`, `a${d.a2}`, `e${d.other}`, `p${d.p1}`, `w${d.w}`]) assert.equal(core.mods.admin.suppression(core, ref), null, `${ref} 不动`);
  assert.ok(t.of('context.markResidentDirty').length >= 1, '常驻区标脏');
  // 「忘掉」另一条：派生的照样只是「隐藏」（别记规则只指向主人忘掉的那条）
  core.mods.admin.suppress(core, `a${d.a2}`, { state: 'forgotten', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${d.sum}`), 'hidden');
  assert.equal(core.mods.admin.doNotRemember(core, { ref: `e${d.sum}` }), false);
  // 恢复 a1：小结还被 a2 带着（改记 a2），不恢复
  core.mods.admin.restore(core, `a${d.a1}`, { by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${d.sum}`), 'hidden');
  assert.equal(reasonOf(core, `e${d.sum}`).reason, `cascade:a${d.a2}`);
  // 再恢复 a2：没有别的来源了，一起恢复
  core.mods.admin.restore(core, `a${d.a2}`, { by: 'owner', at: core.now() });
  for (const ref of [`e${d.sum}`, `e${d.diary}`]) assert.equal(core.mods.admin.suppression(core, ref), null);
  t.ports.logger.assertNoText('失恋', '阿明');
}));

test('隐藏一条消息：含它的原文窗口、复述它的每段叙述（经历也算，整段派生，同 D55）、只靠它作证据的记忆一起隐藏；有别的证据的事实不动', withCore('adm-sup-cascade-p', (core) => {
  const d = day(core);
  core.mods.admin.suppress(core, `p${d.p1}`, { state: 'hidden', by: 'owner', at: core.now() });
  for (const ref of [`w${d.w}`, `a${d.a1}`, `e${d.ev}`, `e${d.sum}`, `e${d.diary}`]) assert.equal(core.mods.admin.suppression(core, ref), 'hidden', `${ref} 跟着隐藏`);
  for (const ref of [`a${d.a2}`, `w${d.w3}`, `e${d.other}`, `p${d.p2}`]) assert.equal(core.mods.admin.suppression(core, ref), null, `${ref} 还有别的证据 / 无关`);
  core.mods.admin.restore(core, `p${d.p1}`, { by: 'owner', at: core.now() });
  assert.equal(core.store.get('SELECT count(*) AS n FROM suppressions').n, 0);
}));

test('级联来的隐藏被主人直接隐藏后改记成直接的：来源恢复时不跟着恢复；隐藏一段经历也带上小结', withCore('adm-sup-cascade-own', (core) => {
  const d = day(core);
  core.mods.admin.suppress(core, `e${d.ev}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(reasonOf(core, `e${d.sum}`).reason, `cascade:e${d.ev}`);
  core.mods.admin.suppress(core, `e${d.sum}`, { state: 'hidden', by: 'owner', reason: '主人自己藏的', at: core.now() });
  assert.deepEqual({ ...reasonOf(core, `e${d.sum}`) }, { by: 'owner', reason: '主人自己藏的' });
  core.mods.admin.restore(core, `e${d.ev}`, { by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${d.sum}`), 'hidden', '主人自己隐藏的不动');
  assert.equal(reasonOf(core, `e${d.diary}`).reason, `cascade:e${d.sum}`, '日记汇总了那篇小结：改由主人直接隐藏的小结带着');
  core.mods.admin.restore(core, `e${d.sum}`, { by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${d.diary}`), null);
  // 调用方不能伪造级联的原因
  core.mods.admin.suppress(core, `a${d.a2}`, { state: 'hidden', by: 'owner', reason: `cascade:a${d.a1}`, at: core.now() });
  assert.equal(reasonOf(core, `a${d.a2}`).reason, null);
}));

test('inheritSuppression：隐藏之后才写出来的小结、日记、窗口照样跟着隐藏；证据里没有被隐藏的就不动', withCore('adm-sup-inherit', (core) => {
  const d = day(core);
  core.mods.admin.suppress(core, `a${d.a1}`, { state: 'hidden', by: 'owner', at: core.now() });
  const late = seedEpisode(core, { settingKey: d.sk, kind: 'summary', narrative: '晚些时候的小结：阿明失恋', perceptIds: [d.p1] });
  assert.equal(core.mods.admin.suppression(core, `e${late}`), null);
  assert.equal(core.mods.admin.inheritSuppression(core, `e${late}`), `a${d.a1}`);
  assert.deepEqual({ ...reasonOf(core, `e${late}`) }, { by: 'system', reason: `cascade:a${d.a1}` });
  assert.equal(core.mods.admin.inheritSuppression(core, `e${d.other}`), null, '证据里没有被隐藏的');
  assert.equal(core.mods.admin.inheritSuppression(core, 'e99999'), null, '不存在的不报错');
  // 再隐藏一次也会补上之后写出来的
  const later = seedEpisode(core, { settingKey: d.sk, kind: 'diary', narrative: '又一篇', perceptIds: [d.p1] });
  core.mods.admin.suppress(core, `a${d.a1}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `e${later}`), 'hidden');
  // 隐藏一条消息之后才切出来的窗口
  core.mods.admin.suppress(core, `p${d.p3}`, { state: 'hidden', by: 'owner', at: core.now() });
  const w4 = seedWindow(core, { settingKey: d.sk, perceptIds: [d.p3] });
  assert.equal(core.mods.admin.inheritSuppression(core, `w${w4}`), `p${d.p3}`);
  assert.throws(() => core.mods.admin.inheritSuppression(core, 'junk'), ContractError);
}));

test('彻底删除过的：suppressedRefs 一并返回，suppression 算 forgotten；不能再隐藏', withCore('adm-sup-tomb', async (core) => {
  const a = seedAssertion(core, { text: '阿明的秘密' });
  await core.mods.admin.purge(core, [`a${a}`], { by: 'owner', at: core.now() });
  assert.deepEqual([...core.mods.admin.suppressedRefs(core, [`a${a}`])], [`a${a}`]);
  assert.equal(core.mods.admin.suppression(core, `a${a}`), 'forgotten');
  assert.equal(core.mods.admin.isTombstoned(core, 'assertion', `a${a}`), true);
  assert.throws(() => core.mods.admin.suppress(core, `a${a}`, { state: 'hidden', by: 'owner', at: core.now() }), { code: 'PURGED' });
}));

test('墓碑按时间生效（D42）：删掉最新的一条之后，新记忆拿到同一个 id——它能被想起、能被隐藏，不受那块墓碑影响', withCore('adm-sup-tomb-reuse', async (core, t) => {
  const sk = seedSetting(core);
  seedAssertion(core, { text: '早先的一条' });
  const a = seedAssertion(core, { text: '最新的一条，要删' });
  const p = seedPercept(core, { settingKey: sk, text: '最新的消息，要删' });
  await core.mods.admin.purge(core, [`a${a}`, `p${p}`], { by: 'owner', at: core.now() });
  t.ports.clock.advance(1000);
  const b = seedAssertion(core, { text: '之后的新事实' });
  const q = seedPercept(core, { settingKey: sk, text: '之后的新消息' });
  assert.equal(b, a, 'SQLite 复用了最大的 id（主表 id 不是 AUTOINCREMENT）');
  assert.equal(q, p);
  assert.deepEqual([...core.mods.admin.suppressedRefs(core, [`a${b}`, `p${q}`])], [], '新记忆照常能被想起');
  assert.equal(core.mods.admin.suppression(core, `a${b}`), null);
  assert.equal(core.mods.admin.isTombstoned(core, 'assertion', `a${b}`), false);
  assert.equal(core.mods.admin.isTombstoned(core, 'percept', `p${q}`), false);
  core.mods.admin.suppress(core, `a${b}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(core.mods.admin.suppression(core, `a${b}`), 'hidden');
  // 墓碑本身还在：恢复旧包时同 id 的旧行（墓碑之前就有的）照样删
  assert.ok(core.store.get("SELECT 1 FROM tombstones WHERE kind = 'assertion' AND ref = ?", `a${a}`));
}));

test('汇总只往更高一层带：隐藏小结 → 带上汇总它的日记；隐藏日记什么都不带（小结、经历不是从日记来的）', withCore('adm-sup-agg', (core) => {
  const d = day(core);
  core.mods.admin.suppress(core, `e${d.diary}`, { state: 'hidden', by: 'owner', at: core.now() });
  for (const ref of [`e${d.sum}`, `e${d.ev}`, `e${d.other}`, `a${d.a1}`, `w${d.w}`]) assert.equal(core.mods.admin.suppression(core, ref), null, `${ref} 不动`);
  core.mods.admin.restore(core, `e${d.diary}`, { by: 'owner', at: core.now() });
  core.mods.admin.suppress(core, `e${d.sum}`, { state: 'hidden', by: 'owner', at: core.now() });
  assert.equal(reasonOf(core, `e${d.diary}`).reason, `cascade:e${d.sum}`);
  for (const ref of [`e${d.ev}`, `e${d.other}`, `a${d.a1}`, `p${d.p1}`]) assert.equal(core.mods.admin.suppression(core, ref), null, `${ref} 不动`);
}));

test('tick 兜底（expireReviews）：隐藏之后才写出来、写的模块没报的派生内容补上隐藏；没有任何直接隐藏时只推水位', withCore('adm-sup-sweep', (core, t) => {
  const d = day(core);
  // 没有直接隐藏：什么都不做，水位推到现在
  t.ports.clock.advance(1000);
  core.mods.admin.expireReviews(core, core.now());
  const cur = JSON.parse(core.store.get("SELECT value FROM meta WHERE key = 'admin.inherit.cursor'").value);
  assert.deepEqual(cur.episode, [core.now(), 0]);
  assert.deepEqual(cur.window, [core.now(), 0]);
  assert.equal(core.store.get('SELECT count(*) AS n FROM suppressions').n, 0);
  core.mods.admin.suppress(core, `p${d.p3}`, { state: 'hidden', by: 'owner', at: core.now() });
  t.ports.clock.advance(1000);
  // 之后：今天的小结、新切的窗口、从那条消息提炼的事实；还有一条和它无关的
  const sum2 = seedEpisode(core, { settingKey: d.sk, kind: 'summary', narrative: '又热又闷', perceptIds: [d.p3] });
  const w5 = seedWindow(core, { settingKey: d.sk, perceptIds: [d.p3] });
  const a5 = seedAssertion(core, { text: '今天很热', subjects: [d.A], perceptIds: [d.p3], settingKey: d.sk });
  const free = seedEpisode(core, { settingKey: d.sk, kind: 'summary', narrative: '爬山的事', perceptIds: [d.p2] });
  t.ports.clock.advance(1000);
  core.mods.admin.expireReviews(core, core.now());
  for (const ref of [`e${sum2}`, `w${w5}`, `a${a5}`]) assert.deepEqual({ ...reasonOf(core, ref) }, { by: 'system', reason: `cascade:p${d.p3}` }, `${ref} 补上了`);
  assert.equal(core.mods.admin.suppression(core, `e${free}`), null);
  assert.ok(t.of('context.markResidentDirty').length >= 1);
  // 主人自己恢复了补上的那条：之后的扫描不会再把它藏回去（只看水位之后写出来的）
  core.mods.admin.restore(core, `e${sum2}`, { by: 'owner', at: core.now() });
  t.ports.clock.advance(1000);
  core.mods.admin.expireReviews(core, core.now());
  assert.equal(core.mods.admin.suppression(core, `e${sum2}`), null);
}));

test('tick 兜底分批：一次每张表最多 admin.inheritBatch 行，剩下的下次接着扫', withCore('adm-sup-sweep-batch', (core, t) => {
  const d = day(core);
  core.mods.admin.suppress(core, `p${d.p3}`, { state: 'hidden', by: 'owner', at: core.now() });
  // 先把已有的行扫完（4 段情节、2 个窗口、2 条事实，每次每张表 2 行）
  for (let i = 0; i < 3; i++) core.mods.admin.expireReviews(core, core.now());
  const late = [];
  for (let i = 0; i < 3; i++) { t.ports.clock.advance(10); late.push(seedEpisode(core, { settingKey: d.sk, kind: 'summary', narrative: `第 ${i} 篇`, perceptIds: [d.p3] })); }
  t.ports.clock.advance(10);
  core.mods.admin.expireReviews(core, core.now());
  assert.deepEqual(late.map((id) => core.mods.admin.suppression(core, `e${id}`)), ['hidden', 'hidden', null], '这次只扫了两行');
  core.mods.admin.expireReviews(core, core.now());
  assert.deepEqual(late.map((id) => core.mods.admin.suppression(core, `e${id}`)), ['hidden', 'hidden', 'hidden']);
}, { config: withAdmin({ inheritBatch: 2 }) }));
