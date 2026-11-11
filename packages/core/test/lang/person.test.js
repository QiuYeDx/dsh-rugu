// 人称换成她的视角、场合的说法（D154）：对她说的话里「我」是说话人、「你」是她。规则克制，拿不准就不换。
// 名字都是编的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { zhPersonView, zhPlaceRef } from '../../src/lang/zh.js';
import { DictMatcher } from '../../src/lang/text.js';
import { withLang } from './helpers.js';

const R = { speaker: '阿明' };
const view = (t, roles = R, dict) => zhPersonView(t, roles, dict);

test('人称：说话人的「我」换成他的称呼，对她说的「你 / 您」换成「我」；领属跟着换', () => {
  assert.deepEqual(view('我今天吃了哪些东西'), { text: '阿明今天吃了哪些东西', speaker: true, self: false });
  assert.deepEqual(view('你还记得我的生日吗'), { text: '我还记得阿明的生日吗', speaker: true, self: true });
  assert.deepEqual(view('您还记得我吗'), { text: '我还记得阿明吗', speaker: true, self: true });
  assert.equal(view('我上周借你的书还了吗').text, '阿明上周借我的书还了吗');
  assert.equal(view('我问你个事，我昨天说的那家店在哪').text, '阿明问我个事，阿明昨天说的那家店在哪');
  // 她的自称可以给（她在记忆里不一定叫「我」）
  assert.equal(view('你记得吗', { speaker: '阿明', self: '小鹿' }).text, '小鹿记得吗');
  // 标点不改（全角还是全角）
  assert.equal(view('我呢？你呢！').text, '阿明呢？我呢！');
});

test('人称：复数、合称、词里的「我」不换', () => {
  for (const t of ['我们昨天去哪了', '你们群里谁养猫', '咱们上次聊到哪儿', '我俩谁先到的', '你我之间', '自我介绍一下', '忘我地工作']) {
    assert.equal(view(t).text, t, t);
  }
  // 一句里有复数也有单数：只换单数
  assert.deepEqual(view('我们说好的，你还记得吗'), { text: '我们说好的，我还记得吗', speaker: false, self: true });
});

test('人称：引号、书名号里的话不换；说话动词加冒号的直接引语到句末都不换', () => {
  assert.equal(view('「我饿了」是谁说的').text, '「我饿了」是谁说的');
  assert.equal(view('“你好笨”这句你说过吗').text, '“你好笨”这句我说过吗');
  assert.equal(view('《我和你》你听过吗').text, '《我和你》我听过吗');
  assert.equal(view('他说：我饿了，你信吗？').text, '他说：我饿了，你信吗？');
  // 句末以后恢复
  assert.equal(view('他说：我饿了。你记得吗').text, '他说：我饿了。我记得吗');
  // 说话人自己说的直接引语里的「你」指的是当时听他说话的人，也不换
  assert.equal(view('我说：你别走').text, '阿明说：你别走');
});

test('人称：第三方转述拿不准就不换（「问 / 告诉」紧跟的宾语照换）；话语标记「你说 / 你看」引出问题时不换', () => {
  assert.equal(view('小明说我胖').text, '小明说我胖', '没有冒号：分不清直接引语和间接引语');
  assert.equal(view('大家都说你唱歌好听').text, '大家都说你唱歌好听');
  assert.deepEqual(view('他问我你去不去'), { text: '他问阿明你去不去', speaker: true, self: false });
  assert.equal(view('小周告诉你那件事了吗').text, '小周告诉我那件事了吗');
  // 主语是说话人自己：照换
  assert.equal(view('我跟你说过我要搬家').text, '阿明跟我说过阿明要搬家');
  // 「小说」「问题」不是说话动词
  assert.equal(view('这本小说你看完了吗').text, '这本小说我看完了吗');
  assert.equal(view('那个问题你想好了吗').text, '那个问题我想好了吗');
  // 话语标记
  assert.deepEqual(view('你说我今天吃了啥'), { text: '你说阿明今天吃了啥', speaker: true, self: false });
  assert.equal(view('你知道我昨天干嘛了吗').text, '你知道阿明昨天干嘛了吗');
  assert.equal(view('你说过要请我吃饭').text, '我说过要请阿明吃饭', '不是问句：「你说」就是她说');
});

test('人称：用户词典里的整词（名字里带「我」「你」）不换；不知道说话人的称呼就整句不换', () => {
  const dict = new DictMatcher();
  dict.set(['小你子']);
  assert.equal(view('小你子跟我说的', R, dict).text, '小你子跟阿明说的');
  assert.deepEqual(view('你还记得我吗', { speaker: '' }), { text: '你还记得我吗', speaker: false, self: false });
  assert.deepEqual(view('', R), { text: '', speaker: false, self: false });
  assert.deepEqual(view(null, R), { text: '', speaker: false, self: false });
});

test('场合的说法：这里 / 私下 / 光说群里 / 名字的几种写法', () => {
  for (const t of ['这里', '这儿', '这个群', '在这个群', '本群', '这个群里']) assert.equal(zhPlaceRef(t).kind, 'here', t);
  for (const t of ['私聊', '私下', '私聊里', '私信', '单独']) assert.equal(zhPlaceRef(t).kind, 'private', t);
  for (const t of ['群里', '群聊']) assert.equal(zhPlaceRef(t).kind, 'group', t);
  assert.deepEqual(zhPlaceRef('读书会群里'), { kind: null, names: ['读书会群里', '读书会群', '读书会'] });
  assert.deepEqual(zhPlaceRef(''), { kind: null, names: [] });
});

test('注册表：personView / placeRef 按文字选分析器；不给这个能力的语言原样返回，不抛', async () => {
  await withLang(async (core) => {
    const L = core.mods.lang;
    assert.deepEqual(L.personView(core, '你还记得我吗', { speaker: '阿明' }), { text: '我还记得阿明吗', speaker: true, self: true });
    // 英文没有分析器给人称：原样
    assert.deepEqual(L.personView(core, 'do you remember me', { speaker: 'Ming' }), { text: 'do you remember me', speaker: false, self: false });
    assert.equal(L.placeRef(core, '私聊').kind, 'private');
    assert.deepEqual(L.placeRef(core, 'book club'), { kind: null, names: ['book club'] });
  });
  // 端口给的分析器出错：退回原样
  const broken = { lang: 'xx', detect: () => 1, tokenize: () => [], parseTime: () => [], pastQuestionExemplars: () => [], questionCue: () => 0,
    personView: () => { throw new Error('boom'); }, placeRef: () => ({ kind: 'weird' }) };
  const { fakePorts } = await import('../fakes/ports.js');
  await withLang(async (core) => {
    assert.deepEqual(core.mods.lang.personView(core, '你好呀', { speaker: '阿明', lang: 'xx' }), { text: '你好呀', speaker: false, self: false });
    assert.deepEqual(core.mods.lang.placeRef(core, '某处', { lang: 'xx' }), { kind: null, names: ['某处'] });
  }, { ports: fakePorts({ languages: [broken] }) });
});
