// 启动探针的句子（§13.2）：建空间时嵌一遍存下向量，之后每次启动重嵌比较，平均余弦低于 embedding.probeMinCos
// 就说明「同一个空间 id 下的模型被悄悄换过」（Ollama 会自动升级，附录 G.1）。
// 这些句子只用来校准向量，不参与任何判断；中英混合、长短不一，内容是虚构的日常琐事，不含真实的人和入口。
export const PROBE_SENTENCES = Object.freeze([
  '昨天晚上八点多去楼下取了快递',
  '下周六大家约好一起去爬山',
  '他说最近工作很忙，经常加班到很晚',
  '猫这两天不太爱吃东西，有点担心',
  '新买的键盘手感不错，就是声音有点大',
  '今天的天气特别好，适合出去走走',
  '她准备明年考研，正在复习数学',
  '那家烧烤店味道一般，但是价格便宜',
  '我更喜欢浅蓝色，看起来很安静',
  '周末在家看了一部很长的纪录片',
  'The meeting was moved to Thursday afternoon.',
  'I finally finished reading that long novel.',
  'She said the train was delayed by forty minutes.',
  'We should try the new noodle place next week.',
  '这个月的电费比上个月高了不少',
  '他的表哥前阵子换了一辆新车',
  '晚上睡不着，凌晨两点还在刷手机',
  '会议纪要已经发到群里了，记得看一下',
  'Remember to water the plants before leaving.',
  '明天早上九点要去医院复查',
]);
