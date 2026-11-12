# 新管理页（D170，重做中）

旧版是 `../page.html` 一个文件，现在仍是默认。新版在这个目录里，同一个地址加 `?ui=next` 打开（或配置 `host.admin.ui: 'next'`）。
这一页说明给接着做「记忆」「待处理 + 场合」「设置 + 关于 + 首次设置」三路的人：目录、模块怎么登记、公共函数、约定、怎么预览和截图、不许做的事。

视觉和交互的标准是主人确认过的样稿（仓库外的私有材料；截图名和这里的去处、分段一一对应）。Token 和组件样式已经从样稿搬进 `shell.html`，**照着用，不要另起一套**。

## 目录

| 文件 | 干什么 |
|---|---|
| `shell.html` | 骨架：`<head>`、设计 token（浅 / 深两套 CSS 变量）、全页公共组件的样式、挂载点 `#app` |
| `base.js` | 地基：全页唯一的全局 `window.Rugu`（下文的 `R`）。`h()`、图标、请求层（含确认令牌流程）、路由、主题、公共组件、格式化、模块登记 |
| `home.js` / `home.css` | 首页（数据：`admin.data?view=home`） |
| `memory.js` / `memory.css` | 记忆（列表、人物、星图、成长）——现在是占位 |
| `pending.js` / `pending.css` | 待处理——现在是占位 |
| `places.js` / `places.css` | 场合（场合、规则、叮嘱）——现在是占位 |
| `settings.js` / `settings.css` | 设置（基本、模型、接入、花费、备份、诊断、关于）——现在是占位 |
| `wizard.js` / `wizard.css` | 首次设置——现在是占位（没有配置文件时服务端仍然给旧版的向导） |

`../page.js` 的 `renderNextPage` 在响应时把它们拼成**一个** HTML：`shell.html` + 每个 `.css` 一个 `<style nonce>` + 每个 `.js` 一个 `<script nonce>`（`base.js` 第一个）+ 最后一个启动脚本 `Rugu.start()`。没有构建步骤、不加载外部资源。
加新文件：在 `page.js` 的 `UI_SCRIPTS` / `UI_STYLES` 里加一行字面量的 `new URL('./ui/xxx.js', import.meta.url)`（打包检查靠它认文件），再在 `test/package/pack-smoke.test.js` 的清单里加上。

## 模块怎么登记、怎么兜错

```js
// memory.js
Rugu.define('memory', (R) => {
  // 这里只在第一次打开「记忆」时跑一次
  async function render(el, route) {   // route = {dest: 'memory', sub: 'list', params: {open: 'a12'}, path: 'memory/list'}
    R.clear(el, R.h('div', { class: 'wrap' }, R.pageHead('记忆', '她记得的事，你都看得到，包括对别人隐藏的。', segFor(route)), …));
  }
  function update(route) {             // 可选：同一个分段只是参数变了（打开 / 关掉详情）
    if (route.params.open) { openDetail(route.params.open); return true; }   // 返回 true = 处理了，不整页重画
    return false;
  }
  function leave() { /* 可选：离开这一页时停计时器、关面板 */ }
  return { render, update, leave };
});
```

- 去处的键固定：`home` / `memory` / `pending` / `places` / `settings` / `wizard`。分段在 `R.SUBS` 里（改分段先改那里，别在模块里写死另一份）。
- 每个文件在自己的 `<script>` 里：一个出语法错只坏它自己。`factory` 或 `render` 抛错、返回的 Promise 失败，只坏那一页：显示「这一块没打开」+「重试」+「去旧版里看」，别的去处照常。文件读不到时 `page.js` 登记 `Rugu.missing(名字)`，效果一样。`base.js` 自己坏了，启动脚本写一句话和回旧版的链接。
- 换去处时（`leave` 之前）还在等的延迟提交（`R.deferred`）会立刻提交。
- 浏览器里看状态：`Rugu.moduleStates()` → `{home: 'loaded', memory: 'pending', …}`。

## 路由

地址栏的 hash：`#/去处/分段?参数=值`，例如 `#/memory/people?open=n12`。刷新、前进后退都对。

| 函数 | 用法 |
|---|---|
| `R.go(path, {params?, replace?, focus?})` | 换页：`R.go('memory/list', {params: {open: 'a12'}})`。默认换页后焦点落在页头的 h1 上（`pageHead` 给的 `data-page-title`）；分段切换传 `{focus: false}` |
| `R.setParams(params, {replace = true})` | 只改参数（打开 / 关掉详情、筛选），交给模块的 `update`；值为空的参数去掉 |
| `R.route()` | 当前路由 |
| `R.parseHash(hash)` / `R.buildHash(path, params)` | 纯函数 |
| `R.classicHref(path, theme)` / `R.classicTab(path)` | 旧版对应页签的地址（`admin?ui=classic&tab=…`）；搬完的去处不再需要 |
| `R.setPendingCount(n)` | 主导航「待处理」上的数字 |

## 请求层

| 函数 | 说明 |
|---|---|
| `await R.api.get(view, params)` | `GET admin.data?view=…`，自动带 `tz`（浏览器时区，分钟，东正）。返回 `data`；出错抛 `R.ApiError {status, code, message, reasons}` |
| `await R.api.act(action, body)` | `POST admin.do`。返回 `result` |
| `await R.api.confirmed(action, params, opts)` | 要确认的操作（`actions.js` 的 prepare / confirm）：先 `prepare`；不用确认的直接执行（宿主说有风险且 `opts.askable` 时带 `ask: true` 再走一遍）；要确认的弹对话框（一句后果、可选的手输确认语——服务端给的 `phrase`、折叠的技术细节），确认后带 `{confirm: {token, typed?}}` 提交，出错留在框里。返回结果，取消返回 `null`。`opts`：`{title, consequence?, render?(preview), details?(preview), okText?, danger? (默认 true), askable?, extra?(state)}` |
| `R.errorText(e, 'read'|'write')` | 出错的人话：连不上、403、只读、500、超时、找不到……服务端给了看得懂的说明（400 / 422 的大多数）就用它；`'read'` 前面加「读不出来：」 |

```js
const r = await R.api.confirmed('memory.purge', { refs: [ref] }, {
  title: '彻底删除这条记忆', consequence: '这条记忆和只靠它作证据的内容会一起删掉，找不回来。', okText: '彻底删除',
  render: (pv) => R.h('div', { class: 'item' }, pv.text), details: (pv) => `会删 ${pv.count} 行`,
});
if (r) R.toast('已彻底删除');
```

## 组件（都在 `R` 上；样式在 `shell.html`）

| 函数 | 说明 |
|---|---|
| `h(tag, attrs, ...kids)` / `add(el, ...kids)` / `clear(el, ...kids)` | 建节点。attrs：`class`、`style`（对象）、`on<事件>`、`value/checked/disabled/hidden/open/selected`、其余 setAttribute。字符串子节点是文本节点 |
| `icon(name, size = 16, stroke?)` / `R.ICONS` | Lucide 风格的内联 SVG（24 网格、2px、圆头）。`gu` 是「故」字形。要新图标：往 `ICONS` 里加，别在模块里另画 |
| `brandMark(size = 28)` | 应用图标（照 `assets/icon.svg`） |
| `pageHead(title, desc?, extra?)` | 页头：h1 + 一句说明 + 分段等 |
| `seg(options, value, onChange, label)` | 分段控件：`[[键, 名字, 计数?]]`；左右键 / Home / End；放不下时两头渐隐 |
| `sideNav(items, value, onChange)` | 设置的左侧小导航（`[[键, 名字, 图标?, 有提醒?]]`），放进 `.sidenav-layout` 的第一列、内容放 `.scontent`；窄屏变成上面一排 |
| `section(title, aside?, ...body)` | 一节：h2 + 右边的小字或 `link()` |
| `row({lead?, title, strong?, clamp = true, meta?, tags?, trail?, onOpen?, sel?, check?, label?})` / `list(rows)` | 列表行（全页唯一一种）：主文 + 小字元信息 + 行尾。`onOpen` 让整行可点、可聚焦 |
| `metaLine(...parts)` | 「·」隔开的小字，空的跳过 |
| `moreButton(items)` | 行尾的「⋯」（悬停 / 聚焦 / 选中时出现）；items 同 `menu` |
| `menu(anchor, items, {align})` / `closeMenu()` | 弹出菜单：`[{label, ic?, onSelect, danger?, checked?, disabled?}]`，可夹 `{sep}`、`{header}`、`{hint}`；上下键、Esc、Tab |
| `dropdown(name, options, value, onChange, {allValue})` | 胶囊形的下拉筛选（单选菜单） |
| `sheet({kicker?, body, foot?, label, onClose?})` → `{close, body, box}` | 右侧滑出的面板（详情）：焦点圈在里面、Esc / 点外面关、关掉后焦点回到打开它的元素；同时只开一个 |
| `dialog({title, body, actions, initial?, onClose?, dismissible?})` → `{close}` | 对话框 |
| `await confirmSimple({title, text, okText, danger?})` → `boolean` | 普通确认 |
| `await confirmDanger({title, consequence, item?, phrase?, okText, extra?, details?})` → `boolean` | 本地的危险确认（一句后果 + 手输确认语 + 技术细节）；要服务端令牌的用 `api.confirmed` |
| `toast(text, {undo?, undoLabel?, tone?: 'bad', duration?})` | 底部提示条 |
| `deferred({text, commit, undo?, delay = 6000, done?})` → `{flush, cancel}` | **延迟提交**：调用方先把那一项收起来，提示条带「撤销」；`delay` 后才 `commit()`；点撤销就 `undo()` 不提交；离开页面、页面藏起来、换去处时立刻提交；`commit` 失败提示原因并 `undo()`。不可恢复的操作别用它，走确认对话框 |
| `flushPending()` | 立刻提交全部还在等的 |
| `btn(label, {kind, size, ic, onclick, disabled, title})` | `kind`：`primary`（浅色墨、深色金）/ `secondary` / `ghost` / `danger` / `danger-ghost`；`size: 'sm'`；没有 label 是图标按钮（`title` 当名字） |
| `link(label, to, {arrow})` | 蓝色文字链接，`to` 是路由串、`{path, params}` 或函数；`'admin?…'` 开头的是真链接 |
| `sw(checked, onChange, label, {disabled})` | 开关；`onChange` 返回的 Promise 失败时自动翻回并提示 |
| `tag(text, tone)` / `status(text, tone)` | 小标签 / 带图标的状态字（`ok` 金色对勾、`warn`、`bad`、`dim`）。状态永远带图标或文字，不只靠颜色 |
| `empty({ic, tone?, title, text?, actions?})` / `loading(text)` / `errorBox(e, retry, {title})` | 空状态 / 加载中 / 出错可重试 |
| `note(tone, text, action?)` | 提示框：`info` / `warn` / `bad` |
| `more(summary, ...body)` | 折叠区（「技术细节」「更多」） |
| `frow({title, hint?, control?, stack?, right?})` | 表单行：标签 + 说明 + 控件；放进 `.form` |
| `kv(pairs)` | 键值对（详情面板里） |
| `placeholderPage(el, route, {title, desc?, subDesc?, sideNav?})` | 「这一块正在搬过来」的占位；搬完删掉调用 |

格式（纯函数，`now` 可以传）：`R.fmt.when(t, now)`（今天 14:32 / 昨天 09:05 / 11/3 08:00 / 2025/1/2，照旧页面的规矩）、`fmt.day`、`fmt.dayLabel`（按天分组的标题）、`fmt.clock`、`fmt.ago`、`fmt.num`（1.2 万）、`fmt.pct`、`fmt.yuan`、`fmt.spaced`（中文和英文、数字之间补空格；句子能直接写成带空格的模板字符串就直接写）。

其他：`R.theme.set('light'|'dark'|null)`、`R.theme.isDark()`、`R.reduceMotion()`、`R.closeAll()`。

## 约定

- **类名前缀**：公共组件用 `shell.html` 里的类（`btn`、`row`、`seg`、`sec`、`card`……）。某一页自己的样式写在同名 `.css` 里，类名带前缀：首页 `home-`、记忆 `mem-`、待处理 `pend-`、场合 `plc-`、设置 `set-`、首次设置 `wiz-`。不改公共类的样式；要改公共组件，改 `shell.html` / `base.js` 并在交付里说明（别的路也在用）。
- **token**：颜色只用 CSS 变量：`--background`、`--foreground`、`--card`、`--popover`、`--primary`（主按钮）、`--secondary`（次按钮、分段底）、`--muted-foreground`（次要文字）、`--border`、`--ring`、`--hover`、`--gold` / `--gold-ink` / `--gold-soft`（品牌、「好」）、`--blue` / `--blue-soft`（链接、选中）、`--success` / `--warning` / `--destructive`、`--tone-*`（分类色）、`--shadow-*`、`--radius-*`（按钮输入 8 / 菜单 10 / 小卡 14 / 卡片 18）、`--duration-*`、`--ease-*`、`--font-sans` / `--font-mono`。同一个元素里金和蓝不同时用。浅 / 深两套都要看。不写死颜色（品牌图标的 `--mark-*` 除外）。
- **字**：字号阶梯 24 / 20 / 17 / 15 / 14 / 13 / 12；一页最多三种字重（400 / 500 / 600）。
- **间距**：4px 基数；小节之间 48，卡片内 24；能用留白分开的不画线、不套卡片。卡片只给「能单独拿走的东西」。
- **文案**：平实的中文，按钮 2–6 个字、动词开头；中文和英文、数字之间留空格；不用感叹号；界面上不出现内部说法（D 号、关口、污点、第一眼、L3……；对照表在设计说明里）。
- **数据**：一个去处要的东西尽量一个视图给全（照 `home` 的写法：核心 `pm.admin.*` 给只有核心知道的，集成层 `views.js` 补宿主的部分），视图里的计数走索引；页面不拼多次请求凑一个列表。
- **无障碍**：能点的都是 `button` / `a`；图标按钮有名字；焦点环用全局的 `:focus-visible`；对话框和面板的焦点由 `dialog` / `sheet` 管；`prefers-reduced-motion` 已在 `shell.html` 里统一处理。
- **深浅色**：`<html data-theme>` 由外壳带来（`?theme=`、之后 `postMessage`），没带时跟系统；模块不用管。嵌在 DSH 里时页面底色是外壳写进来的 `--pm-page`。

## 预览和截图

- 假数据预览：`node packages/dsh/test/admin/preview-server.mjs`，打开 `http://127.0.0.1:3471/s/<场景>/api/rugu/admin?ui=next&theme=light#/memory/list`。场景：`normal`、`empty`、`errors`、`llmdown`、`fallback`、`readonly`、`off`（后四个是首页的几种状态，数据同 normal）、`big`、`old`。改了页面文件刷新就能看到。仿 DSH 设置面板（iframe）：`/shell/<场景>?theme=dark&ui=next`。
- 假数据在 `test/admin/fixtures.js`（`makeFakePm` 的 `admin.*`、`makeFakeHost`）；新视图的假数据照核心的形状加在那里。
- 截图（无头 Chrome，不开窗口）：
  `node packages/dsh/test/admin/ui-shots.mjs --dest memory/list,memory/people --state normal,empty --theme light,dark --width 1280,420`
  其余参数：`--out`（默认仓库根的 `.tmp/ui-shots`）、`--viewport`（只截一屏）、`--shell`（经 iframe 外壳）、`--open '<JS 表达式>'`（截之前跑，打开面板、对话框用）。文件名 `<去处-分段>-<状态>-<宽度>-<主题>.png`。**截了要逐张看**，和样稿同名截图对照，1280 / 420、浅 / 深都看。

## 不许做的

- 不用 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` / `new Function`，不 `setAttribute('style', …)`（CSP 不许；样式走 CSSOM 或类名）。记忆、名字、昵称、场合名都是别人可控的字符串（`test/admin/ui.test.js` 守着）。
- 不加载任何外部资源：脚本、样式、字体、图片、`fetch` 都只能同源；不引框架、不加构建步骤。
- 不另起一套组件样式、不另写一个 `h()` / 菜单 / 对话框；缺什么加进 `base.js`、`shell.html`，接口写进这一页。
- 不新增全局名字（只有 `window.Rugu`）；模块里的东西都放在 `define` 的工厂函数里。
- 首页不上工程数字（数据版本、维度、覆盖率、认领的会话……）；这些只在「设置 → 诊断」的开发者明细里。
- 文件里不出现真实人名、账号、群名、聊天原文、本机路径（仓库是公开的）。
