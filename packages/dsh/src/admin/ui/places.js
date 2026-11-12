// 场合（占位，D170）：「待处理 + 场合」这一路：场合（一个开关）、规则、叮嘱 搬完以后整个换掉这个文件。
// 现在只照样稿画出这个去处的页头和分段，内容区写「这一块正在搬过来」，并给一个去旧版对应页签的链接（R.placeholderPage）。
// 样式写在 ui/places.css，类名带 plc- 前缀；公共组件和 token 的用法见 ui/README.md。
Rugu.define('places', (R) => ({
  render(el, route) {
    R.placeholderPage(el, route, { title: '场合', desc: '她在哪儿记、有什么规矩。', sideNav: false });
  },
}));