// 管理页的 HTML（§13.1）：page.html 是一个自带样式和脚本的文件，这里只把每次请求的 nonce 和管理页令牌填进去。
// 页面里的记忆、名字、昵称都是别人可控的字符串：页面脚本一律用文本节点渲染，不用 innerHTML、不渲染 markdown（§12.3）；
// CSP 再兜一层：只许带 nonce 的脚本和样式、只许同源请求、只许被 DSH 自己的页面嵌入。
import fs from 'node:fs';

const PAGE_URL = new URL('./page.html', import.meta.url);
// 星图（D163）的脚本单独一个文件，渲染时塞进 page.html 主脚本前面的占位处（同一个带 nonce 的 <script>）
const STARMAP_URL = new URL('./starmap.client.js', import.meta.url);
export const STARMAP_SLOT = '__PM_STARMAP__';
let cached = null;
let starmapCached = null;

/** 读 page.html（只读一次；本地预览设 PM_ADMIN_PAGE_NOCACHE=1 时每次重读，改了页面不用重启）。 */
export function pageTemplate() {
  if (cached == null || process.env.PM_ADMIN_PAGE_NOCACHE === '1') cached = fs.readFileSync(PAGE_URL, 'utf8');
  return cached;
}

/** 读 starmap.client.js（同上，只读一次）。文件里不能有 </script（会提前结束脚本块）。 */
export function starmapScript() {
  if (starmapCached == null || process.env.PM_ADMIN_PAGE_NOCACHE === '1') {
    const src = fs.readFileSync(STARMAP_URL, 'utf8');
    if (/<\/script/i.test(src)) throw new Error('starmap.client.js 里不能出现 </script');
    starmapCached = src;
  }
  return starmapCached;
}

/**
 * @param {{nonce: string, token: string}} o   nonce 是 base64，token 是 base64url：都不含要转义的字符
 * @returns {string}
 */
export function renderPage({ nonce, token }) {
  if (!/^[A-Za-z0-9+/=]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError('nonce / token 格式不对');
  // 先填 nonce 和令牌，再塞星图脚本（用函数替换：脚本里的 $& 之类不会被当成替换模式）
  const script = starmapScript();
  return pageTemplate().replaceAll('__PM_NONCE__', nonce).replaceAll('__PM_TOKEN__', token).replace(STARMAP_SLOT, () => script);
}

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
  // 【D171】星图的脚本（和旧页面是同一个文件）：记忆 · 星图 用 window.__pmStarmap.mount 的新挂载（工具条和详情由 memory.js 画）
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
 * 最后一个脚本：启动。base.js 坏了（没定义 Rugu）时不白屏：用最朴素的 DOM 写一句话和回旧版的链接。
 * 文字全走 textContent；回旧版的地址是固定的。
 */
export const UI_BOOT = `(function () {
  var app = document.getElementById('app');
  if (window.Rugu && typeof window.Rugu.start === 'function') {
    try { window.Rugu.start(); return; } catch (e) { if (window.console) console.error('[如故] 启动出错', e); }
  }
  var box = document.createElement('div');
  box.className = 'wrap';
  var t = document.createElement('h1'); t.className = 'ph'; t.textContent = '管理页没有打开';
  var p = document.createElement('p'); p.className = 'quiet'; p.textContent = '新版管理页的基础脚本出错了。可以先回旧版：功能都在。';
  var a = document.createElement('a'); a.className = 'btn btn-secondary'; a.href = 'admin?ui=classic'; a.textContent = '回旧版';
  a.style.marginTop = '16px';
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

/**
 * 这次打开哪一版：地址上的 ?ui=next|classic 优先，没有就按配置 host.admin.ui；配置没给、读不出来或写了别的，都是新版（D174）。
 * 只有明确写了 'classic'（配置，或页面里点「回旧版」后 DSH 外壳带的 ?ui=classic）才是旧版。
 * 首次设置（setupMode）也跟着这个开关走（D173）：新版用一步一屏的向导，旧版是一长页。
 * 删旧页：这里只剩 next。
 * @param {string|null} param   地址上的 ui
 * @param {unknown} configured  配置里的 host.admin.ui
 * @param {boolean} [_setupMode]  不再影响选哪一版（留着参数，调用方不用改）
 * @returns {'next'|'classic'}
 */
export function pickUi(param, configured, _setupMode = false) {
  if (param === 'next' || param === 'classic') return param;
  return configured === 'classic' ? 'classic' : 'next';
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
