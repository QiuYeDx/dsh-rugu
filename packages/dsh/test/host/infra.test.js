// 集成层的基础件：配置（§12.1、热加载、写错只给 warning、有风险的改动要确认）、钩子防护（§10.10）、会话认领（§10.3）、调度（§3.3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createConfigStore, mergeHost, HOST_DEFAULTS } from '../../src/host/config.js';
import { createHookGuard } from '../../src/host/guard.js';
import { createClaims, matchesSignature, sessionInfoOf } from '../../src/host/claim.js';
import { createScheduler } from '../../src/host/scheduler.js';
import { resolvePaths, resolveDshHome, ensureKeyFile } from '../../src/host/paths.js';
import { createLogger, safeFields } from '../../src/host/log.js';
import { createFakePm, fakeBinding, fakeAgent, tmpDir, rmDir } from '../fakes/index.js';

// ── 配置 ────────────────────────────────────────────────────────────────

test('配置：写错只给 warning（不认识的键、类型不对、枚举外的值），开放对象原样保留；默认值是建议值', () => {
  const w = [];
  const h = mergeHost(HOST_DEFAULTS, { nope: 1, gpu: { policy: 'turbo', cooldownMin: '15' }, adapters: { qq: { bridgeDir: 'B:/x', selfNames: ['她'] }, weird: { a: 1 } }, egress: { extraTools: { t: 'none' } } }, '', w);
  assert.equal(h.gpu.policy, 'adaptive');
  assert.equal(h.gpu.cooldownMin, 15);
  assert.deepEqual(h.adapters.qq.selfNames, ['她']);
  assert.deepEqual(h.adapters.weird, { a: 1 });
  assert.deepEqual(h.egress.extraTools, { t: 'none' });
  assert.equal(w.length, 3);
  assert.ok(w.some((x) => x.includes('host.nope')));
  assert.ok(w.some((x) => x.includes('host.gpu.policy')));
  assert.equal(HOST_DEFAULTS.gpu.policy, 'adaptive', '§17 Q1：标准 4B + 自适应');
  assert.equal(HOST_DEFAULTS.embedding.tier, 'standard');
  assert.equal(HOST_DEFAULTS.embedding.tiers.standard.model, 'qwen3-embedding:4b');
  assert.equal(HOST_DEFAULTS.embedding.tiers.light.model, 'qwen3-embedding:0.6b');
  assert.deepEqual(HOST_DEFAULTS.llm.allow, ['deepseek-flash']);
  assert.ok(Object.values(HOST_DEFAULTS.llm.models).every((m) => m === 'deepseek-flash'), '附录 G：后台模型精确 id deepseek-flash');
  assert.deepEqual(HOST_DEFAULTS.freeze.tools, ['qq_memory_append', 'qq_memory_remove', 'qq_memory_clear', 'qq_note_person']);
});

test('配置文件：顶层是核心的参数表、host 是集成层的；改了文件热加载；坏了不覆盖、保持当前值；Cordis 行的 config 优先级更低', () => {
  const dir = tmpDir('cfg');
  const file = path.join(dir, 'persona-memory.json');
  fs.writeFileSync(file, JSON.stringify({ mode: { global: 'off' }, host: { gpu: { policy: 'off' } } }));
  const warns = [];
  const s = createConfigStore({ file, initial: { host: { gpu: { policy: 'on', cooldownMin: 5 } }, budget: { preset: 'saving' } }, onWarn: (x) => warns.push(...x) });
  assert.equal(s.host().gpu.policy, 'off', '文件优先');
  assert.equal(s.host().gpu.cooldownMin, 5, 'Cordis 行的 config 补上文件里没有的');
  assert.equal(s.core.get().mode.global, 'off');
  assert.equal(s.core.get().budget.preset, 'saving');
  assert.equal(s.core.get().host, undefined, 'host 不交给核心');
  let changed = 0;
  s.onHostChange(() => { changed += 1; });
  fs.writeFileSync(file, JSON.stringify({ host: { gpu: { policy: 'adaptive' } } }));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
  assert.equal(s.reload(), true);
  assert.equal(s.host().gpu.policy, 'adaptive');
  assert.equal(s.core.get().mode.global, 'live');
  assert.equal(changed, 1);
  assert.equal(s.reload(), false, '没变就不重读');
  // 坏文件：保持当前值，set() 拒绝写（免得把主人手写的配置覆盖掉）
  fs.writeFileSync(file, '{ 坏了');
  const t2 = new Date(Date.now() + 10_000);
  fs.utimesSync(file, t2, t2);
  s.reload();
  assert.equal(s.host().gpu.policy, 'adaptive');
  const r = s.set({ host: { gpu: { policy: 'off' } } });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ 坏了', '不覆盖坏文件');
  rmDir(dir);
});

test('配置 set()：有风险的改动没确认就不写（返回 needsConfirm）；保留期不能经配置改；写入是原子的', () => {
  const dir = tmpDir('cfg-set');
  const file = path.join(dir, 'persona-memory.json');
  const s = createConfigStore({ file });
  for (const [patch, re] of [
    [{ host: { features: { freeze: false } } }, /冻结/],
    [{ host: { features: { egress: false } } }, /外发审视/],
    [{ host: { enabled: false } }, /关掉整个记忆插件/],
    [{ host: { gpu: { policy: 'on' } } }, /换页/],
    [{ mode: { global: 'off' } }, /总开关/],
    [{ budget: { overrides: { balanceProtectDays: 0 } } }, /余额保护/],
  ]) {
    const r = s.set(patch);
    assert.equal(r.ok, false);
    assert.match(r.needsConfirm.join(), re);
  }
  assert.equal(fs.existsSync(file), false, '一项都没写');
  assert.deepEqual(s.set({ retention: { raw: '1y' } }, { confirm: true }).rejected.length, 1);
  assert.equal(s.set({ host: { gpu: { policy: 'on' } } }, { confirm: true }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).host.gpu.policy, 'on');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  assert.equal(s.set({ mode: { global: 'live' } }).ok, true, '重新打开总开关不用确认');
  rmDir(dir);
});

test('配置（D121）：花费护栏——不设上限、去掉某项上限、关余额保护要确认（和现在一样的不再问）；replace 整个换掉 budget.overrides；手改文件的同样先扣下', () => {
  const dir = tmpDir('cfg-budget');
  const file = path.join(dir, 'persona-memory.json');
  const s = createConfigStore({ file });
  // 普通的自定义直接写
  assert.equal(s.set({ budget: { preset: 'loose', overrides: { dailyCalls: 9000, rerank: false } } }, { replace: ['budget.overrides'] }).ok, true);
  assert.deepEqual(s.core.get().budget.overrides, { dailyCalls: 9000, rerank: false });
  // replace：回到一档时 overrides 清空（不是和原来的合并）
  assert.equal(s.set({ budget: { preset: 'saving', overrides: {} } }, { replace: ['budget.overrides'] }).ok, true);
  assert.deepEqual(s.core.get().budget.overrides, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).budget, { preset: 'saving', overrides: {} });
  // 不带 replace 的照旧是合并
  s.set({ budget: { overrides: { dailyCalls: 700 } } });
  s.set({ budget: { overrides: { rerank: false } } });
  assert.deepEqual(s.core.get().budget.overrides, { dailyCalls: 700, rerank: false });
  // 有风险的
  for (const [patch, re] of [
    [{ budget: { preset: 'unlimited' } }, /不设上限/],
    [{ budget: { overrides: { dailyCalls: null } } }, /调用次数的上限/],
    [{ budget: { overrides: { dailyUncachedTokens: null } } }, /未命中缓存输入的上限/],
    [{ budget: { overrides: { dailyOutputTokens: null } } }, /输出的上限/],
    [{ budget: { overrides: { balanceProtectDays: 0 } } }, /余额保护/],
  ]) {
    const r = s.set(patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.needsConfirm.join(), re);
  }
  assert.equal(s.set({ budget: { preset: 'unlimited', overrides: { balanceProtectDays: 0 } } }, { confirm: true, replace: ['budget.overrides'] }).ok, true);
  assert.equal(s.core.get().budget.preset, 'unlimited');
  // 已经是这样：在上面改别的项不再问
  assert.equal(s.set({ budget: { preset: 'unlimited', overrides: { balanceProtectDays: 0, sleepDepth: 'essential' } } }, { replace: ['budget.overrides'] }).ok, true);
  // 手改文件：回到宽松后，文件里又写成不设上限 + 去掉输出上限 → 先扣下，照旧按宽松跑
  assert.equal(s.set({ budget: { preset: 'loose', overrides: {} } }, { replace: ['budget.overrides'] }).ok, true);
  fs.writeFileSync(file, JSON.stringify({ budget: { preset: 'unlimited', overrides: { dailyOutputTokens: null, dailyCalls: 5000 } } }));
  const t = new Date(Date.now() + 10_000);
  fs.utimesSync(file, t, t);
  assert.equal(s.reload(), true);
  assert.equal(s.core.get().budget.preset, 'loose');
  assert.deepEqual(s.core.get().budget.overrides, { dailyCalls: 5000 }, '无风险的那一项照常生效');
  assert.deepEqual(s.pending().map((x) => x.path).sort(), ['budget.overrides.dailyOutputTokens', 'budget.preset']);
  assert.equal(s.applyPending({ confirm: true }).applied, 2);
  assert.equal(s.core.get().budget.preset, 'unlimited');
  assert.equal(s.core.get().budget.overrides.dailyOutputTokens, null);
  rmDir(dir);
});

test('数据位置（§12.1）：DSH 家目录 > 环境变量 DSH_HOME > ~/.dsh；数据目录默认 <家目录>/persona-memory，可配置；身份密钥只建不覆盖', () => {
  const dir = tmpDir('paths');
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }).endsWith('.dsh'), true, '空白的 DSH_HOME 当作没设');
  assert.equal(resolveDshHome({ DSH_HOME: dir }), path.resolve(dir));
  const p = resolvePaths({ dshHome: dir });
  assert.equal(p.dataDir, path.join(dir, 'persona-memory'));
  assert.equal(p.configFile, path.join(dir, 'persona-memory.json'));
  assert.equal(p.keyFile, path.join(dir, 'persona-memory.key'));
  assert.equal(p.backupKeyFile, path.join(dir, 'persona-memory-backup.key'));
  assert.equal(resolvePaths({ dshHome: dir, dataDir: path.join(dir, 'elsewhere') }).dataDir, path.join(dir, 'elsewhere'));
  assert.equal(ensureKeyFile(p.keyFile), true);
  const k1 = fs.readFileSync(p.keyFile, 'utf8');
  assert.equal(Buffer.from(k1.trim(), 'base64').length, 32);
  assert.equal(ensureKeyFile(p.keyFile), true);
  assert.equal(fs.readFileSync(p.keyFile, 'utf8'), k1, '已有的不覆盖');
  rmDir(dir);
});

test('日志：只记事件名、id、类型和计数，不记内容（字段只收数字、布尔和短字符串）', () => {
  assert.deepEqual(safeFields({ n: 1, ok: true, s: 'a\nb', o: { text: '秘密' }, arr: ['x'], long: 'x'.repeat(200) }), { n: 1, ok: true, s: 'a b', long: 'x'.repeat(80) });
  const lines = [];
  const log = createLogger({ logger: { warn: (m) => lines.push(m), info: (m) => lines.push(m) } });
  log.warn('hook.error', { hook: 'pre-step', error: 'TypeError', text: { body: '不该出现' } });
  assert.deepEqual(lines, ['[persona-memory] hook.error hook=pre-step error=TypeError']);
  assert.deepEqual(log.recent().map((r) => [r.event, r.error]), [['hook.error', 'TypeError']]);
});

// ── 钩子防护 ────────────────────────────────────────────────────────────

test('钩子防护：出错永不外抛，走 fallback；同一会话连续 3 次出错，这个钩子在该会话关 10 分钟；别的会话不受影响；慢了记慢日志', async () => {
  let t = 0;
  const warns = [];
  const g = createHookGuard({ hostConfig: () => HOST_DEFAULTS, now: () => t, log: { warn: (e, f) => warns.push([e, f]) } });
  const boom = () => { throw new Error('x'); };
  for (let i = 0; i < 3; i++) assert.equal(await g.run('pre-step', 's1', boom, (why) => `fb:${why}`), 'fb:error');
  assert.equal(g.isOpen('pre-step', 's1'), true);
  assert.equal(await g.run('pre-step', 's1', () => 'ok', (why) => `fb:${why}`), 'fb:open');
  assert.equal(await g.run('pre-step', 's2', () => 'ok', () => 'fb'), 'ok');
  assert.equal(g.runSync('resident', 's1', () => 'r', () => 'fb'), 'r', '按钩子分开熔断');
  t += 10 * 60_000 + 1;
  assert.equal(await g.run('pre-step', 's1', () => 'ok', () => 'fb'), 'ok', '10 分钟后恢复');
  // 成功一次清零
  await g.run('post-execute', 's3', boom, () => null);
  await g.run('post-execute', 's3', boom, () => null);
  await g.run('post-execute', 's3', () => 1, () => null);
  await g.run('post-execute', 's3', boom, () => null);
  assert.equal(g.isOpen('post-execute', 's3'), false);
  // 慢日志：超过 100 ms
  await g.run('pre-step', 's4', () => { t += 150; return 1; }, () => null);
  assert.ok(warns.some(([e, f]) => e === 'hook.slow' && f.ms === 150));
  const st = g.status();
  assert.equal(st['pre-step'].breakerOpened, 1);
  assert.equal(typeof st['pre-step'].p95Ms, 'number');
  // fallback 自己出错也不外抛
  assert.equal(await g.run('x', 's', boom, () => { throw new Error('y'); }), undefined);
});

// ── 会话认领 ────────────────────────────────────────────────────────────

test('认领：specific 优先于 fallback；两个 specific → 不认领、报警；只有两个 fallback 也不认；适配器出错当不认', () => {
  const pm = createFakePm();
  const c = createClaims({ hostConfig: () => HOST_DEFAULTS, getPm: () => pm });
  c.addBinding(fakeBinding({ adapterId: 'aa', claimSession: () => ({ settingId: 'set-a', confidence: 'fallback' }) }));
  c.addBinding(fakeBinding({ adapterId: 'bb', claimSession: (s) => (s.preset === 'p-b' ? { settingId: 'set-b', confidence: 'specific' } : null) }));
  assert.equal(c.resolve({ id: 's1', preset: 'p-b', header: {} }).adapterId, 'bb');
  assert.equal(pm.named('bind').at(-1).args[0].settingId, 'set-b', '结果交给核心 sessions.bind');
  assert.equal(c.resolve({ id: 's2', preset: 'other', header: {} }).adapterId, 'aa');
  c.addBinding(fakeBinding({ adapterId: 'cc', claimSession: () => ({ settingId: 'set-c', confidence: 'specific' }) }));
  assert.equal(c.resolve({ id: 's3', preset: 'p-b', header: {} }), null, '两个 specific：fail closed');
  assert.deepEqual(c.status().conflicts.at(-1).adapters, ['bb', 'cc']);
  const d = createClaims({ hostConfig: () => HOST_DEFAULTS, getPm: () => pm });
  d.addBinding(fakeBinding({ adapterId: 'x1', claimSession: () => ({ settingId: 'a', confidence: 'fallback' }) }));
  d.addBinding(fakeBinding({ adapterId: 'x2', claimSession: () => ({ settingId: 'b', confidence: 'fallback' }) }));
  assert.equal(d.resolve({ id: 's', header: {} }), null);
  const e = createClaims({ hostConfig: () => HOST_DEFAULTS, getPm: () => pm });
  e.addBinding(fakeBinding({ adapterId: 'x1', claimSession: () => { throw new Error('bad'); } }));
  assert.equal(e.resolve({ id: 's', header: {} }), null);
  assert.equal(e.status().claimErrors, 1);
});

test('认领：子代理一律排除（F20）；配置里的开发会话特征排除；不认的结果只缓存一小会儿；新绑定来了马上再问', () => {
  let t = 0;
  const cfg = JSON.parse(JSON.stringify(HOST_DEFAULTS));
  cfg.claim.excludePresets = ['coding'];
  cfg.claim.excludeCwdPrefixes = ['D:\\dev'];
  const c = createClaims({ hostConfig: () => cfg, getPm: () => null, now: () => t });
  const any = fakeBinding({ adapterId: 'aa', claimSession: () => ({ settingId: 'x', confidence: 'specific' }) });
  c.addBinding(any);
  assert.equal(c.resolve({ id: 'sub', origin: 'subagent', header: {} }), null);
  assert.equal(c.resolve({ id: 'del', delegationDepth: 1, header: {} }), null);
  assert.equal(c.resolve({ id: 'dev', preset: 'coding', header: {} }), null);
  assert.equal(c.resolve({ id: 'dev2', cwd: 'd:/dev/project', header: {} }), null, '工作目录前缀不分大小写和斜杠');
  assert.equal(c.status().excluded, 4);
  // 不认的缓存
  const late = createClaims({ hostConfig: () => cfg, getPm: () => null, now: () => t });
  let ready = false;
  late.addBinding(fakeBinding({ adapterId: 'qq', claimSession: () => (ready ? { settingId: 'q', confidence: 'specific' } : null) }));
  assert.equal(late.resolve({ id: 's', header: {} }), null);
  ready = true;
  assert.equal(late.resolve({ id: 's', header: {} }), null, '60 秒内不再问（B2：桥接映射可能还没写）');
  t += 61_000;
  assert.equal(late.resolve({ id: 's', header: {} }).settingId, 'q');
  // rebind：同一个适配器报上来的才改
  assert.equal(late.rebind('s', 'q2', 'other'), false);
  assert.equal(late.rebind('s', 'q2', 'qq'), true);
  assert.equal(late.get('s').settingId, 'q2');
  assert.equal(late.rebind('nope', 'z'), false);
  assert.equal(matchesSignature({ preset: 'qq-chat' }, { presets: ['qq-chat'] }), true);
  assert.equal(matchesSignature({ cwd: 'X:/b/state/agents/x' }, { cwdPrefixes: ['x:\\b\\state\\agents'] }), true);
  const info = sessionInfoOf(fakeAgent({ id: 'a1', preset: 'p', cwd: 'C:/w', origin: 'subagent', delegationDepth: 2 }), { messages: [] });
  assert.deepEqual([info.id, info.preset, info.cwd, info.origin, info.delegationDepth, Array.isArray(info.messages)], ['a1', 'p', 'C:/w', 'subagent', 2, true]);
});

// ── 调度 ────────────────────────────────────────────────────────────────

test('调度：启动后约一分钟一次 tick（热加载配置、核心自我、余额）；任务队列有活就接着跑、没活歇一会儿；stop 之后不再跑', async () => {
  const pm = createFakePm();
  let jobs = 3;
  pm.maintenance.runJobs = async (b) => { pm.calls.push({ name: 'runJobs', args: [b] }); if (jobs > 0) { jobs -= 1; return { ran: 1, failed: 0 }; } return { ran: 0, failed: 0 }; };
  const cfg = JSON.parse(JSON.stringify(HOST_DEFAULTS));
  Object.assign(cfg.scheduler, { tickMs: 15, startDelayMs: 0, jobsIdleMs: 20, jobsBusyMs: 1, jobsMaxMs: 1000 });
  let onTick = 0;
  const s = createScheduler({ getPm: () => pm, hostConfig: () => cfg, log: { warn() {} }, onTick: () => { onTick += 1; } });
  s.start();
  await new Promise((r) => setTimeout(r, 120));
  s.stop();
  const ticks = pm.named('tick').length;
  assert.ok(ticks >= 2, `tick ${ticks} 次`);
  assert.ok(onTick >= ticks);
  assert.ok(pm.named('runJobs').length >= 4, '三次有活 + 至少一次空转');
  assert.equal(pm.named('runJobs')[0].args[0].maxMs, 1000, '每一轮有时间上限，让出事件循环');
  assert.ok(pm.named('runJobs')[0].args[0].signal instanceof AbortSignal);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pm.named('tick').length, ticks, 'stop 之后不再 tick');
  const st = s.status();
  assert.equal(st.running, false);
  assert.ok(st.lastTick);
});

test('调度：上一次 tick 还没跑完就跳过；tick 出错只记日志；功能开关关掉就不跑核心（热加载照样做）', async () => {
  const pm = createFakePm();
  let release;
  pm.maintenance.tick = () => new Promise((r) => { release = r; });
  const s = createScheduler({ getPm: () => pm, hostConfig: () => HOST_DEFAULTS, log: { warn() {} } });
  const first = s.tickOnce();
  assert.equal(await s.tickOnce(), null);
  assert.equal(s.status().skippedTicks, 1);
  release({ windows: 1, segment: { error: 'X' } });
  await first;
  assert.deepEqual(s.status().lastTick, { windows: '1', segment: 'error:X' }, '只留步骤名和状态');
  pm.maintenance.tick = async () => { throw new Error('boom'); };
  await s.tickOnce();
  assert.equal(s.status().tickErrors, 1);
  const cfg = JSON.parse(JSON.stringify(HOST_DEFAULTS));
  cfg.features.scheduler = false;
  let hot = 0;
  const pm2 = createFakePm();
  const off = createScheduler({ getPm: () => pm2, hostConfig: () => cfg, log: { warn() {} }, onTick: () => { hot += 1; } });
  await off.tickOnce();
  assert.equal(pm2.named('tick').length, 0);
  assert.equal(hot, 1);
});

test('配置热加载：文件里出现有风险的改动（关掉外发审视、解除冻结、把工具标成不说话……）先不生效，等主人确认或丢弃；无风险的照常生效', () => {
  const dir = tmpDir('cfg-hold');
  const file = path.join(dir, 'persona-memory.json');
  fs.writeFileSync(file, JSON.stringify({ host: { gpu: { policy: 'off' } } }));
  const warns = [];
  const s = createConfigStore({ file, onWarn: (x) => warns.push(...x) });
  let n = 0;
  const bump = (obj) => { fs.writeFileSync(file, JSON.stringify(obj)); n += 1; const t = new Date(Date.now() + n * 5000); fs.utimesSync(file, t, t); };
  // 被骗去改了配置文件：关掉外发审视和冻结，顺手把一个工具标成不说话，再改一项无风险的
  bump({ host: { gpu: { policy: 'adaptive' }, features: { egress: false, freeze: false }, egress: { extraTools: { bili_comment: 'none' } } } });
  assert.equal(s.reload(), true);
  assert.equal(s.host().gpu.policy, 'adaptive', '无风险的照常生效');
  assert.equal(s.host().features.egress, true, '外发审视没被关掉');
  assert.equal(s.host().features.freeze, true);
  assert.deepEqual(s.host().egress.extraTools, {});
  assert.deepEqual(s.pending().map((x) => x.path).sort(), ['host.egress.extraTools', 'host.features.egress', 'host.features.freeze']);
  assert.equal(s.get().pendingRisky.length, 3);
  assert.ok(warns.some((w) => /管理页确认/.test(w)));
  // 又热加载一次（文件没变回去）：继续扣着，不重复告警
  const w0 = warns.length;
  bump({ host: { gpu: { policy: 'adaptive' }, features: { egress: false, freeze: false }, egress: { extraTools: { bili_comment: 'none' } } } });
  s.reload();
  assert.equal(s.host().features.egress, true);
  assert.equal(s.pending().length, 3);
  assert.equal(warns.length, w0);
  // 没确认：不生效
  assert.equal(s.applyPending().ok, false);
  assert.equal(s.applyPending().needsConfirm.length, 3);
  // 主人确认：生效
  const r = s.applyPending({ confirm: true });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 3);
  assert.equal(s.host().features.egress, false);
  assert.deepEqual(s.host().egress.extraTools, { bili_comment: 'none' });
  assert.equal(s.pending().length, 0);
  // 丢弃：按现在生效的值重写配置文件
  bump({ host: { gpu: { policy: 'adaptive' }, features: { egress: false, freeze: false }, egress: { extraTools: { bili_comment: 'none' } }, enabled: false } });
  s.reload();
  assert.equal(s.host().enabled, true);
  assert.equal(s.discardPending().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).host.enabled, undefined, '文件里那项改动没了');
  assert.equal(s.reload(), false);
  assert.equal(s.pending().length, 0);
  // set() 重写文件：扣着的改动丢弃，并告诉主人
  bump({ host: { gpu: { policy: 'adaptive' }, features: { egress: false, freeze: false }, egress: { extraTools: { bili_comment: 'none' } }, enabled: false } });
  s.reload();
  const w = s.set({ host: { gpu: { policy: 'off' } } });
  assert.equal(w.ok, true);
  assert.ok(w.warnings.some((x) => /待确认的改动没有生效/.test(x)));
  assert.equal(s.pending().length, 0);
  assert.equal(s.host().enabled, true);
  // 启动时读到的就是主人写的（没有「之前的值」可比）：照常生效
  const s2 = createConfigStore({ file });
  assert.equal(s2.host().features.egress, false);
  rmDir(dir);
});

test('配置（D112）：网页默认按插件预设认领；文件里只写了 adapters.web 的几项时默认的 presets 还在；写 [] 关掉；算不算跟她聊的改动热加载时要确认', () => {
  const live = mergeHost(HOST_DEFAULTS, { adapters: { web: { enabled: true, excludeCwdPrefixes: ['X:/bridge/state'] } } }, '', []);
  assert.deepEqual(live.adapters.web.presets, ['persona-chat'], '默认值没被整个替换掉');
  assert.deepEqual(live.adapters.web.excludeCwdPrefixes, ['X:/bridge/state']);
  assert.equal(live.adapters.qq.enabled, true);
  assert.deepEqual(mergeHost(HOST_DEFAULTS, { adapters: { web: { presets: [] } } }, '', []).adapters.web.presets, []);
  const w = [];
  assert.deepEqual(mergeHost(HOST_DEFAULTS, { adapters: { web: { presets: 'persona-chat' } } }, '', w).adapters.web.presets, ['persona-chat'], '类型不对：按默认');
  assert.equal(w.length, 1);
  assert.deepEqual(HOST_DEFAULTS.preset, { enabled: true, name: '', description: '', order: 5, personaPrefix: '' });
  assert.equal(HOST_DEFAULTS.claim.signatureRetryMs, 5000);

  const dir = tmpDir('cfg-d112');
  const file = path.join(dir, 'persona-memory.json');
  fs.writeFileSync(file, JSON.stringify({ host: { adapters: { web: { enabled: true } } } }));
  const s = createConfigStore({ file });
  let n = 0;
  const bump = (obj) => { fs.writeFileSync(file, JSON.stringify(obj)); n += 1; const t = new Date(Date.now() + n * 5000); fs.utimesSync(file, t, t); };
  bump({ host: { preset: { name: '某个名字', enabled: false }, adapters: { web: { presets: ['persona-chat', 'standard'], sessionIds: ['s1'], requireClientTimeZone: false } } } });
  s.reload();
  assert.equal(s.host().preset.name, '某个名字', '改名不用确认');
  assert.equal(s.host().preset.enabled, true);
  assert.deepEqual(s.host().adapters.web.presets, ['persona-chat']);
  assert.equal(s.host().adapters.web.sessionIds, undefined);
  assert.equal(s.host().adapters.web.requireClientTimeZone, undefined);
  assert.deepEqual(s.pending().map((x) => x.path).sort(), ['host.adapters.web.presets', 'host.adapters.web.requireClientTimeZone', 'host.adapters.web.sessionIds', 'host.preset.enabled']);
  assert.equal(s.applyPending({ confirm: true }).applied, 4);
  assert.deepEqual(s.host().adapters.web.presets, ['persona-chat', 'standard']);
  assert.equal(s.host().preset.enabled, false);
  // 只留插件自己的预设、或者关掉：不用确认
  assert.equal(s.set({ host: { adapters: { web: { presets: ['persona-chat'] } } } }).ok, true);
  assert.equal(s.set({ host: { adapters: { web: { presets: [] } } } }).ok, true);
  assert.equal(s.set({ host: { adapters: { web: { presets: ['standard'] } } } }).ok, false);
  rmDir(dir);
});
