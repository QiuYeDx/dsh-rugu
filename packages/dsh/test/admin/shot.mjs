// 管理页截图（不是测试文件）：无头 Chrome（--headless=new，不开任何可见窗口），一次性的配置目录放在仓库 .tmp 下，每次清空。
// 用法：node shot.mjs <jobs.json> <outDir>
//   jobs.json：[{ name, url, width?, height?, full?: boolean, wait?: ms, script?: '(async () => {...})()', clip?: 'css 选择器' }]
//   script 在截图前跑（切页签、点按钮、打开对话框……），返回值会打印出来。
//   可选：reduce: true 模拟「减少动态效果」；keys: ['Tab', 'ArrowRight'] 在 script 之后按键；hover: {x, y} 最后把鼠标移到这个位置（看悬停态）。
// 只结束命令行里带这个配置目录名的 chrome.exe，不碰用户自己的 Chrome。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [jobsFile, outDir] = process.argv.slice(2);
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = Number(process.env.CDP_PORT) || 9341;
const profile = path.resolve(process.env.PROFILE || path.join(outDir, '..', 'chrome-shot-profile'));
fs.rmSync(profile, { recursive: true, force: true });
// CHROME_ARGS='--a --b'：额外的启动参数（例如无头 Chrome 要 WebGL 时加 --enable-unsafe-swiftshader --use-angle=swiftshader）
const extraArgs = (process.env.CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
// SHOW_SCROLLBARS=1：不加 --hide-scrollbars，截图里能看到真实的滚动条（滚动条样式要靠这个审）
const showBars = process.env.SHOW_SCROLLBARS === '1';
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-sync', '--mute-audio', ...(showBars ? [] : ['--hide-scrollbars']), '--window-size=1280,900', '--lang=zh-CN', ...extraArgs, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 150; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const pageT = targets.find((t) => t.type === 'page');
const ws = new WebSocket(pageT.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') problems.push(`EXCEPTION ${m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`CONSOLE.ERROR ${JSON.stringify(m.params.args.map((a) => a.value ?? a.description)).slice(0, 300)}`);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(`LOG ${m.params.entry.text.slice(0, 300)}`);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
for (const job of jobs) {
  const W = job.width ?? 1100; const H = job.height ?? 860;
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: job.dsf ?? 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: job.dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: job.reduce ? 'reduce' : 'no-preference' }] });
  problems.length = 0;
  await send('Page.navigate', { url: job.url });
  await sleep(job.wait ?? 1200);
  if (job.script) {
    const r = await send('Runtime.evaluate', { expression: job.script, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) console.log('SCRIPT-ERROR', job.name, r.result.exceptionDetails.exception?.description?.slice(0, 300));
    else if (r.result?.result?.value !== undefined) console.log('EVAL', job.name, JSON.stringify(r.result.result.value).slice(0, 2000));
    await sleep(job.after ?? 500);
  }
  const VK = { Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  for (const key of job.keys ?? []) {
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: VK[key] ?? 0 });
    await sleep(250);
  }
  if (job.hover) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: job.hover.x, y: job.hover.y }); await sleep(400); }
  const params = { format: 'png' };
  if (job.full) {
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})', returnByValue: true });
    const b = JSON.parse(r.result.result.value);
    params.clip = { x: 0, y: 0, width: Math.max(W, b.w), height: Math.min(12000, b.h), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const shot = await send('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(outDir, `${job.name}.png`), Buffer.from(shot.result.data, 'base64'));
  console.log('saved', job.name, problems.length ? `\n  ${problems.join('\n  ')}` : '');
}
ws.close();
proc.kill();
spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like ('*' + $env:SHOT_PROFILE + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { env: { ...process.env, SHOT_PROFILE: path.basename(profile) } });
process.exit(0);
