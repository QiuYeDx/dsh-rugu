// 新管理页（D170）的批量截图（不是测试文件）：起一个假数据预览（preview-server.mjs），按「去处 × 状态 × 主题 × 宽度」生成任务，交给 shot.mjs
// 用无头 Chrome（--headless=new，不开任何可见窗口）截，截完把预览关掉。
// 用法（在仓库根目录）：
//   node packages/dsh/test/admin/ui-shots.mjs [--dest home,memory/list] [--state normal,empty] [--theme light,dark] [--width 1280,420]
//                                             [--out .tmp/ui-shots] [--shell] [--viewport] [--open '<截图前跑的 JS 表达式>'] [--port 3480]
//   --dest    去处（'去处' 或 '去处/分段'，和地址栏 #/ 后面一样），默认 home
//   --state   假数据的场景：normal / empty / errors / llmdown / fallback / readonly / off（首页的几种状态），默认 normal
//   --theme   light / dark，默认两个都截
//   --width   默认 1280,420（高度：宽的 900、窄的 860）
//   --shell   经仿 DSH 设置面板的外壳（client.js 的 iframe）打开，看嵌在 DSH 里的样子（面板宽 880）
//   --viewport 只截一屏（默认截整页）
//   --open    页面画好以后先跑这段 JS（例：打开一个面板），再截（--shell 时不支持：iframe 里的 CSP 不许 eval）
// 文件名：<去处-分段>-<状态>-<宽度>-<主题>.png，放在 --out（默认 .tmp/ui-shots，仓库根目录下，.gitignore 里有 .tmp）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes(`--${name}`);
const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);

const dests = list(arg('dest', 'home'));
const states = list(arg('state', 'normal'));
const themes = list(arg('theme', 'light,dark'));
const widths = list(arg('width', '1280,420')).map(Number);
const out = path.resolve(ROOT, arg('out', '.tmp/ui-shots'));
const port = Number(arg('port', '3480'));
const shell = flag('shell');
const full = !flag('viewport');
const open = arg('open', null);

fs.mkdirSync(out, { recursive: true });
const server = spawn(process.execPath, [path.join(HERE, 'preview-server.mjs'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PM_PREVIEW_TMP: path.join(ROOT, '.tmp') } });
await new Promise((resolve, reject) => {
  // D173：场景多了（设置和首次设置的 6 种），预览起来要二十秒上下：多等一会儿
  const t = setTimeout(() => reject(new Error('预览没起来')), 60_000);
  server.stdout.on('data', (b) => { if (String(b).includes('管理页预览')) { clearTimeout(t); resolve(); } });
  server.on('exit', (c) => reject(new Error(`预览退出了（${c}）`)));
});

const jobs = [];
for (const dest of dests) for (const state of states) for (const theme of themes) for (const width of widths) {
  const name = `${dest.replace(/\//g, '-')}-${state}-${width}-${theme}`;
  const url = shell
    ? `http://127.0.0.1:${port}/shell/${state}?theme=${theme}&ui=next`
    : `http://127.0.0.1:${port}/s/${state}/api/rugu/admin?ui=next&theme=${theme}#/${dest}`;
  const job = { name, url, width, height: width >= 760 ? 900 : 860, full: full && !shell, dark: theme === 'dark', wait: 1400 };
  // 外壳里：iframe 打开以后再把它里面的 hash 换到要的去处
  if (shell) job.script = `(async () => { const f = document.querySelector('iframe'); for (let i = 0; i < 50 && !(f.contentWindow && f.contentWindow.Rugu); i++) await new Promise((r) => setTimeout(r, 100)); f.contentWindow.location.hash = '#/${dest}'; await new Promise((r) => setTimeout(r, 900)); return f.contentWindow.Rugu.moduleStates(); })()`;
  else if (open) job.script = open;
  jobs.push(job);
}
const jobsFile = path.join(out, 'jobs.json');
fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
const r = spawnSync(process.execPath, [path.join(HERE, 'shot.mjs'), jobsFile, out], { stdio: 'inherit', env: { ...process.env, PROFILE: path.join(ROOT, '.tmp', 'chrome-ui-shots'), CDP_PORT: String(port + 1) } });
server.kill();
fs.rmSync(path.join(ROOT, '.tmp', 'chrome-ui-shots'), { recursive: true, force: true });
console.log(`截了 ${jobs.length} 张，在 ${out}`);
process.exit(r.status ?? 0);
