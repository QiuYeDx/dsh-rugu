// 设置（占位，D170）：「设置 + 关于 + 首次设置」这一路：基本、模型、接入、花费、备份、诊断、关于 搬完以后整个换掉这个文件。
// 现在只照样稿画出这个去处的页头和分段，内容区写「这一块正在搬过来」，并给一个去旧版对应页签的链接（R.placeholderPage）。
// 样式写在 ui/settings.css，类名带 set- 前缀；公共组件和 token 的用法见 ui/README.md。
Rugu.define('settings', (R) => ({
  render(el, route) {
    R.placeholderPage(el, route, { title: '设置', subDesc: { basic: '她是谁、总开关、原文留多久。', models: '后台模型、想起来的方式、显卡。', connect: '接 QQ、B站。', cost: '后台整理花的是你 DSH 账号的余额，有上限。', backup: '备份在哪儿、恢复。', diag: '出问题时先看这里。', about: '如故是什么、数据在哪儿、会发给谁。' }, sideNav: true });
  },
}));