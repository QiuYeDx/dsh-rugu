// buildCues（§8.1）：窗口、在场者（评审:PS-13）、被提到的人只是线索、正文里的名字、时间表达、查询文本、缓存键的一半。
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveCore, seedEntity, seedPercept, seedPresence, seedSetting, addName, T0, MIN } from './fixtures.js';

async function world() {
  const env = await retrieveCore();
  const { core } = env;
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '老板', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明' });
  const jie = seedEntity(core, { name: '阿杰' });
  const lurker = seedEntity(core, { name: '潜水员' });
  seedSetting(core, 'G', { label: '游戏群' });
  seedSetting(core, 'D', { label: '私聊' });
  return { ...env, me, boss, ming, jie, lurker };
}

test('窗口：最近 ≤ 10 条、≤ 400 字、按时间升序，写成「名字：文字」；最新对她说的那句单独成一条查询', async () => {
  const w = await world();
  try {
    const { core } = w;
    for (let i = 0; i < 14; i++) seedPercept(core, { settingKey: 'G', at: T0 - (14 - i) * MIN, actor: w.ming, text: `第${i}条消息，聊聊显卡涨价的事` });
    const q = seedPercept(core, { settingKey: 'G', at: T0 - 30_000, actor: w.boss, text: '你还记得阿明表哥是干啥的吗', addressed: 'to-her' });
    seedPercept(core, { settingKey: 'G', at: T0 - 10_000, actor: w.ming, text: '我也想知道', addressed: 'ambient' });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'G' });
    assert.ok(cues.window.length <= 10 && cues.window.length >= 6);
    assert.ok(cues.window.every((x, i, a) => i === 0 || a[i - 1].perceptId < x.perceptId));
    assert.equal(cues.window.at(-1).text, '我也想知道');
    assert.ok([...cues.windowText].length <= 400 + cues.window.length * 4);
    assert.match(cues.windowText, /老板：你还记得阿明表哥是干啥的吗/);
    assert.equal(cues.directedText, '你还记得阿明表哥是干啥的吗');
    assert.equal(cues.queryTexts.length, 2);
    assert.equal(cues.queryTexts[0], cues.windowText);
    assert.equal(cues.queryTexts[1], '你还记得阿明表哥是干啥的吗');
    assert.equal(cues.latestPerceptId, q + 1);
    assert.equal(cues.focusSpeaker, w.boss, '正在对她说话的人（最新一条对她说的），不是最后一个插话的');
    assert.ok(cues.names.some((n) => n.entityId === w.ming && n.name === '阿明'));
    assert.equal(cues.pastQuestion, true);   // 句式像在问
    // focus 给了：窗口到它为止，焦点说话人是它的说话人
    const f = core.mods.retrieve.buildCues(core, { settingKey: 'G', focusPerceptId: q - 1 });
    assert.equal(f.window.at(-1).perceptId, q - 1);
    assert.equal(f.focusSpeaker, w.ming);
    assert.equal(f.latestPerceptId, q + 1);   // 缓存键的一半永远是场合里最新的一条
  } finally { await w.cleanup(); }
});

test('在场者：成员不能列全时 = 最近 30 分钟在本场合亲自发过言的人 + 她自己；素材的作者、更早说话的人不算', async () => {
  const w = await world();
  try {
    const { core } = w;
    seedPercept(core, { settingKey: 'G', at: T0 - 40 * MIN, actor: w.lurker, text: '很久以前说的话' });
    seedPercept(core, { settingKey: 'G', at: T0 - 5 * MIN, actor: w.jie, text: '大家好', kind: 'content', standing: 'material' });
    seedPercept(core, { settingKey: 'G', at: T0 - 3 * MIN, actor: w.ming, text: '今天加班吗' });
    seedPercept(core, { settingKey: 'G', at: T0 - 2 * MIN, actor: w.boss, text: '@阿杰 你在吗', mentions: [{ entityId: w.jie }] });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'G' });
    assert.deepEqual(cues.present, [w.me, w.boss, w.ming].sort((a, b) => a - b));
    assert.ok(cues.mentioned.includes(w.jie), '被 @ 的人是线索');
    assert.ok(!cues.present.includes(w.jie), '被 @ 的人不算在场（评审:PS-13）');
    assert.ok(!cues.present.includes(w.lurker));
  } finally { await w.cleanup(); }
});

test('在场者：能列出成员时（exact）就是成员；回复的那条的作者也是线索', async () => {
  const w = await world();
  try {
    const { core } = w;
    seedPresence(core, 'D', [w.boss, w.me], 'exact');
    seedPercept(core, { settingKey: 'D', at: T0 - 50 * MIN, actor: w.ming, text: '早先的一句', extKey: 'orig' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '这个呢', addressed: 'to-her', replyToKey: 'orig' });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'D' });
    assert.deepEqual(cues.present, [w.me, w.boss].sort((a, b) => a - b));
    assert.ok(cues.mentioned.includes(w.ming));
  } finally { await w.cleanup(); }
});

test('有意回想的 query / about / time：query 排在查询文本最前，about 里的名字记下来，time 解析成时间窗', async () => {
  const w = await world();
  try {
    const { core } = w;
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '帮我想想', addressed: 'to-her' });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'D', query: '表哥的工作', about: '阿明', time: '昨天' });
    assert.equal(cues.queryTexts[0], '表哥的工作 阿明');
    assert.equal(cues.queryTexts.length, 2);
    assert.deepEqual(cues.aboutEntityIds, [w.ming]);
    assert.equal(cues.timeWindows.length, 1);
    assert.ok(cues.timeWindows[0].end < T0);
    assert.equal(cues.pastQuestion, true);   // 时间表达指向过去
  } finally { await w.cleanup(); }
});

test('线索为空：hash = empty；同样的线索哈希相同，换了窗口就不同；群名片只在本场合作用', async () => {
  const w = await world();
  try {
    const { core } = w;
    assert.equal(core.mods.retrieve.buildCues(core, { settingKey: 'G' }).hash, 'empty');
    addName(core, w.jie, { text: '杰哥', scope: 'G' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: w.boss, text: '杰哥最近怎么样' });
    const a = core.mods.retrieve.buildCues(core, { settingKey: 'D' });
    const b = core.mods.retrieve.buildCues(core, { settingKey: 'D' });
    assert.equal(a.hash, b.hash);
    assert.ok(!a.names.some((n) => n.entityId === w.jie), '群名片在别的场合不算');
    seedPercept(core, { settingKey: 'D', at: T0, actor: w.boss, text: '算了' });
    assert.notEqual(core.mods.retrieve.buildCues(core, { settingKey: 'D' }).hash, a.hash);
  } finally { await w.cleanup(); }
});

test('依赖出错只降级：名字匹配器、时间解析坏了，线索照样有窗口', async () => {
  const w = await (async () => {
    const env = await retrieveCore({
      mods: {
        entities: { nameMatcher: () => { throw new Error('boom'); }, profile: () => null, principals: () => [] },
        lang: { registry: () => { throw new Error('boom'); }, queryTerms: () => [] },
      },
    });
    seedSetting(env.core, 'G', { label: '群' });
    return env;
  })();
  try {
    const { core } = w;
    seedPercept(core, { settingKey: 'G', at: T0 - MIN, text: '有人吗' });
    const cues = core.mods.retrieve.buildCues(core, { settingKey: 'G' });
    assert.equal(cues.window.length, 1);
    assert.equal(cues.names.length, 0);
    assert.equal(cues.timeWindows.length, 0);
    assert.equal(cues.lang, 'und');
  } finally { await w.cleanup(); }
});
