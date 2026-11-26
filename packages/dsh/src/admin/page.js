// 管理页的 HTML（§13.1，D170 起 ui/ 下拼出来的单页；D176 删掉了旧版 page.html）：骨架、各去处的样式和脚本全部内联在响应里，带每次请求的 nonce 和管理页令牌。
// 页面里的记忆、名字、昵称都是别人可控的字符串：页面脚本一律用文本节点渲染，不用 innerHTML、不渲染 markdown（§12.3）；
// CSP 再兜一层：只许带 nonce 的脚本和样式、只许同源请求、只许被 DSH 自己的页面嵌入。
import fs from 'node:fs';

// ── 新管理页（D170，管理页重做）：ui/ 下的骨架、地基、各去处的模块，响应时拼成一个 HTML ─────────────
// 每个文件都写成字面量的 new URL(..., import.meta.url)：打包检查（scripts/pack-check.mjs）靠它认出这些文件要进包。
const UI_SHELL_URL = new URL('./ui/shell.html', import.meta.url);
/** 脚本：base 必须第一个（定义 window.Rugu），其余各去处一个文件；每个放进自己的 <script>，一个出语法错只坏它自己。 */
export const UI_SCRIPTS = Object.freeze([
  ['base', new URL('./ui/base.js', import.meta.url)],
  ['home', new URL('./ui/home.js', import.meta.url)],
  ['memory', new URL('./ui/memory.js', import.meta.url)],
  ['pending', new URL('./ui/pending.js', import.meta.url)],
  ['places', new URL('./ui/places.js', import.meta.url)],
  ['settings', new URL('./ui/settings.js', import.meta.url)],
  ['wizard', new URL('./ui/wizard.js', import.meta.url)],
  // 【D171】星图的脚本：记忆 · 星图 用 window.__pmStarmap.mount（工具条和详情由 memory.js 画）
  ['starmap', new URL('./starmap.client.js', import.meta.url)],
]);
/** 各去处自己的样式（类名带模块前缀）；读不到的跳过。 */
export const UI_STYLES = Object.freeze([
  ['home', new URL('./ui/home.css', import.meta.url)],
  ['memory', new URL('./ui/memory.css', import.meta.url)],
  ['pending', new URL('./ui/pending.css', import.meta.url)],
  ['places', new URL('./ui/places.css', import.meta.url)],
  ['settings', new URL('./ui/settings.css', import.meta.url)],
  ['wizard', new URL('./ui/wizard.css', import.meta.url)],
]);
/**
 * 最后一个脚本：启动。base.js 坏了（没定义 Rugu）时不白屏：用最朴素的 DOM 写一句话和一个「刷新」按钮。
 * 文字全走 textContent。
 */
export const UI_BOOT = `(function () {
  var app = document.getElementById('app');
  if (window.Rugu && typeof window.Rugu.start === 'function') {
    try { window.Rugu.start(); return; } catch (e) { if (window.console) console.error('[如故] 启动出错', e); }
  }
  var box = document.createElement('div');
  box.className = 'wrap';
  var t = document.createElement('h1'); t.className = 'ph'; t.textContent = '管理页没有打开';
  var p = document.createElement('p'); p.className = 'quiet'; p.textContent = '管理页的基础脚本出错了。刷新一下再试；还不行就彻底重启 DSH。';
  var a = document.createElement('button'); a.type = 'button'; a.className = 'btn btn-secondary'; a.textContent = '刷新';
  a.style.marginTop = '16px'; a.onclick = function () { window.location.reload(); };
  box.appendChild(t); box.appendChild(p); box.appendChild(a);
  app.replaceChildren(box); app.removeAttribute('aria-busy');
})();`;
let uiCache = null;

/** 读一个 ui 文件：读不到返回 null；脚本里出现 </script（会提前结束脚本块）也当读不到。 */
function readUi(url, { script = false } = {}) {
  try {
    const src = fs.readFileSync(url, 'utf8');
    if (script && /<\/script/i.test(src)) return null;
    if (!script && /<\/style/i.test(src)) return null;
    return src;
  } catch { return null; }
}

/** 新管理页的各部分（只读一次；PM_ADMIN_PAGE_NOCACHE=1 时每次重读）。 */
export function uiParts() {
  if (uiCache == null || process.env.PM_ADMIN_PAGE_NOCACHE === '1') {
    uiCache = {
      shell: fs.readFileSync(UI_SHELL_URL, 'utf8'),
      scripts: UI_SCRIPTS.map(([name, url]) => [name, readUi(url, { script: true })]),
      styles: UI_STYLES.map(([name, url]) => [name, readUi(url)]),
    };
  }
  return uiCache;
}

/**
 * 新管理页（D170）：骨架 + 各模块的样式 + 地基和各模块的脚本 + 启动，全部内联、带同一个 nonce。
 * 某个模块的文件读不到：放一行 Rugu.missing('名字')，那一页显示「这一块没打开」，别的照常。
 * @param {{nonce: string, token: string}} o
 * @param {ReturnType<typeof uiParts>} [parts]  测试换成别的（缺文件、坏文件）
 * @returns {string}
 */
export function renderNextPage({ nonce, token, setupMode = false }, parts = uiParts()) {
  if (!/^[A-Za-z0-9+/=]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError('nonce / token 格式不对');
  const { shell, scripts, styles } = parts;
  const tag = (body) => `<script nonce="${nonce}">${body}</script>`;
  // D173：首次设置模式（还没有核心）——页面一打开就进向导（base.js 的 start 认这个标记）
  const setupMeta = setupMode === true ? '<meta name="rugu-setup-mode" content="1">\n' : '';
  const css = setupMeta + styles.filter(([, src]) => src != null).map(([name, src]) => `<style nonce="${nonce}" data-ui="${name}">\n${src}\n</style>`).join('\n');
  const js = scripts.map(([name, src]) => (src == null
    ? tag(`window.Rugu && window.Rugu.missing(${JSON.stringify(name)}, '这一页的脚本没有读到');`)
    : tag(`${src}\n//# sourceURL=rugu-ui/${name}.js`))).join('\n');
  // 用函数替换：脚本里的 $& 之类不会被当成替换模式
  return shell.replaceAll('__PM_NONCE__', nonce).replaceAll('__PM_TOKEN__', token)
    .replace('<!--__RUGU_STYLES__-->', () => css)
    .replace('<!--__RUGU_SCRIPTS__-->', () => `${js}\n${tag(UI_BOOT)}`);
}

/** 管理页的 CSP。 */
export function pageCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
