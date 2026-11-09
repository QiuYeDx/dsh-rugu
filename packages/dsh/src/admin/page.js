// 管理页的 HTML（§13.1）：page.html 是一个自带样式和脚本的文件，这里只把每次请求的 nonce 和管理页令牌填进去。
// 页面里的记忆、名字、昵称都是别人可控的字符串：页面脚本一律用文本节点渲染，不用 innerHTML、不渲染 markdown（§12.3）；
// CSP 再兜一层：只许带 nonce 的脚本和样式、只许同源请求、只许被 DSH 自己的页面嵌入。
import fs from 'node:fs';

const PAGE_URL = new URL('./page.html', import.meta.url);
let cached = null;

/** 读 page.html（只读一次；本地预览设 PM_ADMIN_PAGE_NOCACHE=1 时每次重读，改了页面不用重启）。 */
export function pageTemplate() {
  if (cached == null || process.env.PM_ADMIN_PAGE_NOCACHE === '1') cached = fs.readFileSync(PAGE_URL, 'utf8');
  return cached;
}

/**
 * @param {{nonce: string, token: string}} o   nonce 是 base64，token 是 base64url：都不含要转义的字符
 * @returns {string}
 */
export function renderPage({ nonce, token }) {
  if (!/^[A-Za-z0-9+/=]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(token)) throw new TypeError('nonce / token 格式不对');
  return pageTemplate().replaceAll('__PM_NONCE__', nonce).replaceAll('__PM_TOKEN__', token);
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
