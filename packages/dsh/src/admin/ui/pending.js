// 待处理（占位，D170）：「待处理 + 场合」这一路：一个收件箱，按类型筛（需要你知道 · 等你批准 · 被拦下的话），延迟提交和撤销 搬完以后整个换掉这个文件。
// 现在只照样稿画出这个去处的页头和分段，内容区写「这一块正在搬过来」，并给一个去旧版对应页签的链接（R.placeholderPage）。
// 样式写在 ui/pending.css，类名带 pend- 前缀；公共组件和 token 的用法见 ui/README.md。
Rugu.define('pending', (R) => ({
  render(el, route) {
    R.placeholderPage(el, route, { title: '待处理', desc: '要你知道、或等你点头的事。', sideNav: false });
  },
}));