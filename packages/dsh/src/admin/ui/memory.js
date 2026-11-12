// 记忆（占位，D170）：「记忆」这一路：记忆列表（全部类型混排）、详情面板、人物、星图（starmap.client.js 接进来）、成长 搬完以后整个换掉这个文件。
// 现在只照样稿画出这个去处的页头和分段，内容区写「这一块正在搬过来」，并给一个去旧版对应页签的链接（R.placeholderPage）。
// 样式写在 ui/memory.css，类名带 mem- 前缀；公共组件和 token 的用法见 ui/README.md。
Rugu.define('memory', (R) => ({
  render(el, route) {
    R.placeholderPage(el, route, { title: '记忆', desc: '她记得的事，你都看得到，包括对别人隐藏的。', sideNav: false });
  },
}));