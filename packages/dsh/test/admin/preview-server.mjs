// 管理页的本地预览（不是测试文件）：不启动 DSH，用假 pm / 假 host 跑真的路由处理函数，给无头 Chrome 截图审稿用。
//   node packages/dsh/test/admin/preview-server.mjs [--port 3471]
//   http://127.0.0.1:3471/s/<normal|empty|errors>/api/persona-memory/admin            单独打开的管理页
//   http://127.0.0.1:3471/shell/<normal|empty|errors>?theme=dark                       仿 DSH 设置面板，经 client.js 用 iframe 打开
// 只监听 127.0.0.1；数据全是 fixtures.js 里编的。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createAdminHandlers, ROUTES } from '../../src/admin/index.js';
import { makeFakePm, makeFakeHost } from './fixtures.js';

process.env.PM_ADMIN_PAGE_NOCACHE = '1';   // 改了 page.html 刷新就能看到
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', '..', 'src', 'admin', 'client.js');
const i = process.argv.indexOf('--port');
const port = (i > 0 && Number(process.argv[i + 1])) || 3471;
const exportDir = fs.mkdtempSync(path.join(process.env.PM_PREVIEW_TMP ?? os.tmpdir(), 'pm-preview-export-'));
fs.writeFileSync(path.join(exportDir, 'pm-export-20261104T063000Z.jsonl'), '{"type":"header"}\n');

// PM_PREVIEW_NOW=<毫秒>：假数据以这一刻为「现在」（看「今天」「昨天」这类相对时间时用真的现在）；不给用 fixtures 的固定时刻
const previewNow = Number(process.env.PM_PREVIEW_NOW) || undefined;
const scenarios = {};
for (const s of ['normal', 'empty', 'errors']) {
  const h = createAdminHandlers({ pm: makeFakePm({ scenario: s, now: previewNow }), host: makeFakeHost({ scenario: s }), exportDir, log: { info() {}, warn() {}, error() {} } });
  scenarios[s] = { [ROUTES.page]: h.page, [ROUTES.data]: h.data, [ROUTES.act]: h.act, [ROUTES.file]: h.file };
}

async function toRequest(req, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string'));
  return new Request(new URL(url, 'http://dsh.internal'), { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
}
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

const SHELL = (scenario, theme) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH 设置（预览）</title>
<style>
  body{margin:0;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    --dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-label-tertiary:#81858c;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;
    --dsw-alias-bg-module-platform:#f5f6f7;--dsw-alias-border-l1:#0000000a;--dsw-alias-border-l2:#0000001a;--dsw-alias-brand-primary:#0f1115;--dsw-alias-label-primary-foreground:#fff;
    --dsw-alias-link:#4176e6;--dsw-alias-state-error-primary:#ec1313;--dsw-alias-interactive-bg-hover:#2631480f;--dsw-alias-bg-mask-1:#0000003d;background:#e9ecf2}
  body[data-ds-dark-theme]{--dsw-alias-label-primary:#f9fafb;--dsw-alias-label-secondary:#cfd3d6;--dsw-alias-label-tertiary:#adb2b8;--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#232324;
    --dsw-alias-bg-module-platform:#2c2c2e;--dsw-alias-border-l1:#ffffff0f;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-brand-primary:#f9fafb;--dsw-alias-label-primary-foreground:#0f1115;
    --dsw-alias-link:#7aaaff;--dsw-alias-state-error-primary:#f25a5a;--dsw-alias-interactive-bg-hover:#ffffff14;--dsw-alias-bg-mask-1:#00000080;background:#0b0b0c}
  .panel{position:fixed;inset:32px;margin:auto;max-width:1080px;max-height:760px;display:grid;grid-template-columns:200px 1fr;border-radius:16px;overflow:hidden;
    background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 20px 60px rgba(0,0,0,.25)}
  nav{padding:16px 10px;border-right:1px solid var(--dsw-alias-border-l2);font-size:13px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
  nav div{padding:7px 10px;border-radius:8px}nav .on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
  .content{display:flex;flex-direction:column;min-width:0;min-height:0}
  .header{height:44px;flex:none}
  .options{flex:1;min-height:0;overflow-y:auto;padding:0 28px 20px}
</style></head>
<body ${theme === 'dark' ? 'data-ds-dark-theme' : ''}>
<div class="panel"><nav><div>通用</div><div>模型</div><div>插件</div><div>B站伙伴</div><div class="on">记忆</div></nav>
<div class="content"><div class="header"></div><div class="options" id="root"></div></div></div>
<script>
  // 一个只够 client.js 用的小 React：createElement 直接建 DOM，hook 只跑一次（预览不需要协调）
  const React = (() => {
    let hooks = []; let idx = 0; const effects = []; let root = null; let comp = null;
    const px = new Set(['height','width','gap','fontSize','minWidth']);
    function createElement(type, props, ...kids) {
      if (typeof type === 'function') return type(props ?? {});
      const el = document.createElement(type);
      for (const [k, v] of Object.entries(props ?? {})) {
        if (v == null || v === false) continue;
        if (k === 'ref') v.current = el;
        else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style[sk] = typeof sv === 'number' && px.has(sk) ? sv + 'px' : sv;
        else el.setAttribute(k, v);
      }
      for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
      return el;
    }
    function render() { idx = 0; const out = comp(); root.replaceChildren(out); while (effects.length) effects.shift()(); }
    return {
      createElement,
      useRef: (v) => { const i = idx++; return hooks[i] ??= { current: v ?? null }; },
      useState: (v) => { const i = idx++; if (!(i in hooks)) hooks[i] = { v }; const slot = hooks[i]; return [slot.v, (nv) => { if (nv !== slot.v) { slot.v = nv; render(); } }]; },
      useEffect: (fn) => { const i = idx++; if (!(i in hooks)) { hooks[i] = true; effects.push(fn); } },
      mount: (c, el) => { comp = c; root = el; render(); },
    };
  })();
  window.__ModuleLoader__ = { load({ factory }) {
    const mod = factory((n) => { if (n === 'react') return React; throw new Error('预览里没有 ' + n); });
    mod.apply({ slots: { inject: (_n, fn) => fn(), register: (_def, Comp) => React.mount(Comp, document.getElementById('root')) } });
  } };
</script>
<base href="/s/${scenario}/">
<script src="/client.js"></script>
</body></html>`;

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    const m = url.pathname.match(/^\/s\/(normal|empty|errors)(\/api\/persona-memory\/[A-Za-z.]+)$/);
    if (m) {
      const fn = scenarios[m[1]][m[2]];
      if (!fn) { res.writeHead(404); return res.end(); }
      return send(res, await fn(await toRequest(req, `${m[2]}${url.search}`)));
    }
    const s = url.pathname.match(/^\/shell\/(normal|empty|errors)$/);
    if (s) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(SHELL(s[1], url.searchParams.get('theme')));
    }
    if (url.pathname === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(CLIENT));
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(500); res.end(String(e?.stack ?? e));
  }
}).listen(port, '127.0.0.1', () => console.log(`管理页预览：http://127.0.0.1:${port}/s/normal/api/persona-memory/admin  ·  http://127.0.0.1:${port}/shell/normal`));
