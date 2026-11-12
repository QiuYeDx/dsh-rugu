// 把 assets/brand/banner-dark.html、banner-light.html 渲染成 README 顶部的两张横幅 assets/banner-dark.webp、banner-light.webp
// （README 用 <picture> 按深浅色主题选一张；2 倍图，圆角外透明）。横幅只给 README 用，不进 npm 包。
// assets/banner.webp 是第一个 npm 版本的旧横幅：那一版 npm 页面上的 README 还指着它，留着不删，也不再重新生成。
// 用 WebP（质量 95）：和 PNG 看不出差别，体积约 1/7；PNG 压成 256 色会让渐变出色带。
// 图标从 assets/icon.svg 嵌进去（两张都用它），改了图标或横幅文字后重跑一次就行：
//   node packages/dsh/assets/brand/render-banner.mjs
// 用无界面的 Chrome（新 headless 模式，不弹窗口）和一个用完就删的临时配置目录，不碰你自己的 Chrome。
// Chrome 不在默认位置时用环境变量 CHROME 指定；临时文件默认放系统临时目录，用 RUGU_TMP 换地方。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.dirname(HERE);
const BANNERS = ['dark', 'light'].map((t) => ({ src: path.join(HERE, `banner-${t}.html`), out: path.join(ASSETS, `banner-${t}.webp`) }));
const W = 1280; const H = 640; const SCALE = 2;

const chrome = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && fs.existsSync(p));
if (!chrome) { console.error('找不到 Chrome，用环境变量 CHROME 指定路径'); process.exit(1); }

// 图标嵌进模板，每张写一个临时页面
const TMP = process.env.RUGU_TMP || path.join(os.tmpdir(), 'rugu-banner'); fs.mkdirSync(TMP, { recursive: true });
const ICON = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');
const pages = BANNERS.map((b, i) => {
  const html = fs.readFileSync(b.src, 'utf8');
  if (!html.includes('<!-- ICON -->')) { console.error(`${path.basename(b.src)} 里没有 <!-- ICON --> 占位`); process.exit(1); }
  const page = path.join(TMP, `rugu-banner-${process.pid}-${i}.html`);
  fs.writeFileSync(page, html.replace('<!-- ICON -->', ICON));
  return { ...b, page };
});

const port = 9300 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(TMP, 'rugu-banner-chrome-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill();
  for (let i = 0; i < 10; i += 1) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']); } }
  for (const p of pages) fs.rmSync(p.page, { force: true });
};

try {
  let targets;
  for (let i = 0; i < 100 && !targets; i += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); }
  }
  const target = targets?.find((t) => t.type === 'page');
  if (!target) throw new Error('Chrome 没起来');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });   // 圆角外透明
  await send('Page.enable');
  for (const p of pages) {
    await send('Page.navigate', { url: pathToFileURL(p.page).href });
    await sleep(1500);
    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true });
    const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 95, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    if (!shot.result?.data) throw new Error(`截图失败：${path.basename(p.src)}`);
    fs.writeFileSync(p.out, Buffer.from(shot.result.data, 'base64'));
    console.log(`已生成 ${path.relative(process.cwd(), p.out)}（${W * SCALE}×${H * SCALE}，${Math.round(fs.statSync(p.out).size / 1024)} KB）`);
  }
  ws.close();
} catch (e) {
  console.error('生成失败：', e.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
