// 首次设置（占位，D170）：「设置 + 关于 + 首次设置」这一路：一步一屏的向导（没有配置文件时现在仍然显示旧的向导） 搬完以后整个换掉这个文件。
// 现在只照样稿画出这个去处的页头和分段，内容区写「这一块正在搬过来」，并给一个去旧版对应页签的链接（R.placeholderPage）。
// 样式写在 ui/wizard.css，类名带 wiz- 前缀；公共组件和 token 的用法见 ui/README.md。
Rugu.define('wizard', (R) => ({
  render(el, route) {
    R.placeholderPage(el, route, { title: '首次设置', desc: '几分钟的事，也可以全部用默认，之后都能在「设置」里改。', sideNav: false });
  },
}));