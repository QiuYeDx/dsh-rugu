// retrieve 牵头的场景（docs/实现/模块与接口.md §4.14、设计 §14.3）：
//   S15 「你怎么知道的？」→ 说得出来源，或按分寸说「听人说的」（§5.3）；
//   S24 「快递拿了没」和「下午去驿站取了包裹」→ 换个说法也能想起（§8）。
// 依赖的模块全是照契约写的替身（fixtures.js）；分寸的结论（share / share_vague）由测试直接给，关口①本身不在这里测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEmbedding } from '../fakes/embedding.js';
import { PARAPHRASE_PAIRS } from '../fixtures/paraphrase-pairs.js';
import {
  retrieveCore, seedEntity, seedPercept, seedSetting, seedAssertion, seedWindow, seedPresence, seedDescriptor, T0, MIN, HOUR, DAY,
} from './fixtures.js';

async function people(core) {
  const me = seedEntity(core, { name: '小鱼', isSelf: true });
  const boss = seedEntity(core, { name: '大王', authority: 'principal', closeness: 1 });
  const ming = seedEntity(core, { name: '阿明', closeness: 0.3 });
  const cousin = seedEntity(core, { name: null });
  seedSetting(core, 'G', { label: '游戏群' });
  seedSetting(core, 'D', { label: '私聊' });
  seedPresence(core, 'D', [me, boss], 'exact');
  return { me, boss, ming, cousin };
}

// FakeEmbedding 是字符 n-gram 哈希，不懂查询指令：通用的英文指令会盖过线索本身。真实的指令模型理解指令而不是去匹配它，
// 这里把指令关掉来模拟这一点（recall.queryInstruct 是交付说明里请求加进 defaults.js 的键）。
const NO_INSTRUCT = { recall: { queryInstruct: '' } };

test('S24：「快递拿了没」想得起「下午去驿站取了包裹」——稠密路接住换说法，词法接住换语序；嵌入挂了也不至于想不起', async () => {
  const emb = new FakeEmbedding({ synonyms: [['快递', '包裹'], ['拿', '取']] });
  const w = await retrieveCore({ embedding: emb, extraConfig: NO_INSTRUCT });
  try {
    const { core, worker } = w;
    const { boss } = await people(core);
    // 下午 15:00 主人在群里说了一句（她在旁听），原文窗口入库就嵌；提炼出了一条事实
    const p = seedPercept(core, { settingKey: 'G', at: T0 - 5 * HOUR, actor: boss, text: '下午去驿站取了包裹', attention: 'peripheral' });
    const win = seedWindow(core, { settingKey: 'G', first: p, last: p, tStart: T0 - 5 * HOUR, tEnd: T0 - 5 * HOUR, text: '大王：下午去驿站取了包裹' });
    worker.addDoc(`w${win}`, '大王：下午去驿站取了包裹', 'raw');
    const fact = seedAssertion(core, { text: '大王下午去驿站取了包裹', subjects: [boss], kindHint: 'event', eventStart: T0 - 5 * HOUR,
      sources: [{ speaker: boss, mode: 'overheard', perceivedIn: 'G', at: T0 - 5 * HOUR, perceptId: p }] });
    worker.addDoc(`a${fact}`, '大王下午去驿站取了包裹');
    const distract = [];
    for (const t of ['大王这周开始玩新游戏', '大王的猫前两天拉肚子', '大王说楼下新开了一家烧烤店', '大王想今年学吉他']) {
      const id = seedAssertion(core, { text: t, subjects: [boss], sources: [{ speaker: boss, perceivedIn: 'D', at: T0 - 3 * DAY }] });
      worker.addDoc(`a${id}`, t);
      distract.push(id);
    }
    // 晚上 20:00（这里是 T0）私聊里问
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: boss, text: '快递拿了没', addressed: 'to-her' });
    assert.equal(await core.mods.retrieve.looksLikePast(core, '快递拿了没'), true, '看起来在问过去 → context 切到有意回想');

    const set = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'message' }, { mode: 'deliberate', deadlineMs: 3000 });
    const hit = set.items.find((c) => c.ref === `a${fact}`);
    assert.ok(hit, '想起来了');
    assert.ok(hit.ranks.dense, '靠稠密路');
    assert.equal(hit.ranks.lexical, undefined, '「快递拿了没」和「取了包裹」一个词都不重合，词法路帮不上');
    const top = set.items.filter((c) => c.meta?.kind === 'assertion').slice(0, 1).map((c) => c.ref);
    assert.deepEqual(top, [`a${fact}`], '排在关于他的其他事前面');
    const r = core.mods.retrieve.render(core, hit, { verdict: 'share', at: T0, itemChars: 120, settingKey: 'D' });
    assert.match(r.rendered, /^（10\/31 07:00，主人在「游戏群」自己说的）/);
    assert.match(r.rendered, /大王下午去驿站取了包裹/);

    // 不自主回想（800 ms）也想得起
    const inv = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'involuntary', deadlineMs: 800 });
    assert.ok(inv.items.slice(0, 5).some((c) => c.ref === `a${fact}` || c.ref === `w${win}` || c.ref === `p${p}`));

    // 换语序、同样的词：词法路（lang 的二元组）就能接住
    seedPercept(core, { settingKey: 'D', at: T0, actor: boss, text: '包裹取了吗', addressed: 'to-her' });
    const lex = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', deadlineMs: 3000 });
    assert.ok(lex.items.find((c) => c.ref === `a${fact}`)?.ranks.lexical);

    // 嵌入服务挂了（L3）：主人本人就是强线索（实体路），加上伪查询向量，照样想得起
    emb.setFailing(true);
    const l3 = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', deadlineMs: 3000 });
    assert.equal(l3.degradeLevel, 3);
    assert.ok(l3.items.some((c) => c.ref === `a${fact}`));
  } finally { await w.cleanup(); }
});

test('S24（批量）：V0 探针的换说法句子对，用对应的同义词时，有意回想都能把那一条排进前 3', async () => {
  // 只取替身能模拟的几对：给出把两边说法对齐的同义词（真实嵌入模型不需要同义词表，§14.4 用真实嵌入重测）
  const pairs = [
    [PARAPHRASE_PAIRS[0], [['快递', '包裹'], ['拿', '取']]],
    [PARAPHRASE_PAIRS[20], [['换车', '换了一辆新能源车']]],
    [PARAPHRASE_PAIRS[23], [['键盘', '机械键盘'], ['买了没', '下单了']]],
  ];
  for (const [[q, memory], synonyms] of pairs) {
    const emb = new FakeEmbedding({ synonyms });
    const w = await retrieveCore({ embedding: emb, extraConfig: NO_INSTRUCT });
    try {
      const { core, worker } = w;
      const { boss } = await people(core);
      const target = seedAssertion(core, { text: memory, subjects: [boss], sources: [{ speaker: boss, perceivedIn: 'G', at: T0 - DAY }] });
      worker.addDoc(`a${target}`, memory);
      for (const [, other] of PARAPHRASE_PAIRS.filter(([qq]) => qq !== q).slice(0, 12)) {
        const id = seedAssertion(core, { text: other, subjects: [], sources: [{ speaker: boss, perceivedIn: 'G', at: T0 - DAY }] });
        worker.addDoc(`a${id}`, other);
      }
      seedPercept(core, { settingKey: 'D', at: T0 - MIN, actor: boss, text: q, addressed: 'to-her' });
      const set = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'simulate' }, { mode: 'deliberate', deadlineMs: 3000, query: q });
      const rank = set.items.filter((c) => c.meta?.kind === 'assertion').findIndex((c) => c.ref === `a${target}`);
      assert.ok(rank >= 0 && rank < 3, `「${q}」→ 第 ${rank + 1} 条`);
    } finally { await w.cleanup(); }
  }
});

test('S15：「你怎么知道的？」——说得出来源（谁、在哪、什么时候、第几手），或按分寸只说「听人说的」', async () => {
  const w = await retrieveCore();
  try {
    const { core, worker } = w;
    const { boss, ming, cousin } = await people(core);
    seedDescriptor(core, cousin, ming, '表哥');
    // 10/28 阿明在游戏群对她说「我表哥开网约车」
    const told = T0 - 3 * DAY;
    const p = seedPercept(core, { settingKey: 'G', at: told, actor: ming, text: '我表哥开网约车', addressed: 'to-her' });
    const fact = seedAssertion(core, { text: '阿明的表哥开网约车', subjects: [cousin], mentions: [ming], certainty: 'hearsay', confidence: 0.6,
      sources: [{ speaker: ming, asserter: ming, mode: 'told_to_her', hop: 1, perceivedIn: 'G', at: told, perceptId: p }] });
    worker.addDoc(`a${fact}`, '阿明的表哥开网约车');
    // 主人自己在群里说过的事（本人说的）
    const own = seedAssertion(core, { text: '大王说最近在学吉他', subjects: [boss], confidence: 0.95,
      sources: [{ speaker: boss, mode: 'overheard', perceivedIn: 'G', at: T0 - DAY }] });
    // 现在私聊里：
    seedPercept(core, { settingKey: 'D', at: T0 - 2 * MIN, actor: boss, text: '阿明表哥干啥的', addressed: 'to-her' });
    seedPercept(core, { settingKey: 'D', at: T0 - MIN, self: true, kind: 'self-utterance', text: '好像是开网约车的' });
    seedPercept(core, { settingKey: 'D', at: T0, actor: boss, text: '你怎么知道的？', addressed: 'to-her' });

    const set = await core.mods.retrieve.recall(core, { settingKey: 'D', trigger: 'message' }, { mode: 'deliberate', deadlineMs: 3000 });
    const c = set.items.find((x) => x.ref === `a${fact}`);
    assert.ok(c, '「怎么知道的」靠窗口里的上文想起同一件事');
    const at = T0;
    const r = core.mods.retrieve.render(core, c, { verdict: 'share', at, itemChars: 120, settingKey: 'D' });
    assert.equal(r.provenance, '听阿明在「游戏群」说的');
    assert.match(r.rendered, /^（10\/28 12:00，听阿明在「游戏群」说的）好像阿明的表哥开网约车$/, '谁、在哪、绝对时间；听说的带「好像」');
    assert.ok(r.confidence <= 0.6);

    // 本人说的：说成「他自己说的」
    const ro = core.mods.retrieve.render(core, { ...c, ref: `a${own}`, mref: { kind: 'assertion', id: own } }, { verdict: 'share', at, itemChars: 120, settingKey: 'D' });
    assert.equal(ro.provenance, '主人在「游戏群」自己说的');

    // 按分寸只能说个大概：来源也含糊，不点名、不说在哪
    const rv = core.mods.retrieve.render(core, c, { verdict: 'share_vague', vagueText: '有人提过他亲戚是跑车的', at, itemChars: 120, settingKey: 'D' });
    assert.equal(rv.provenance, '听人说的');
    assert.equal(rv.rendered, '（10/28，听人说的）有人提过他亲戚是跑车的');
    assert.ok(!/阿明|游戏群|网约车/.test(rv.rendered));

    // 很久以后、激活低：内容还在，「听谁说的」记不清了，说成「好像是在游戏群听谁提过」（来源比内容忘得快，§5.3）
    const rl = core.mods.retrieve.render(core, { ...c, P: 0.3 }, { verdict: 'share', at: T0 + 60 * DAY, itemChars: 120, settingKey: 'D' });
    assert.equal(rl.provenance, '好像是在「游戏群」听谁提过');
    assert.ok(rl.rendered.includes('网约车'));
    assert.ok(!rl.rendered.includes('听阿明'));

    // 日志里没有内容（§12.3）
    w.ports.logger.assertNoText('网约车', '你怎么知道的', '阿明的表哥');
  } finally { await w.cleanup(); }
});
