// 宿主怎么造适配器，适配器就得怎么活（host/index.js 的 startAdapters）：
//   - 宿主不给盐，只给身份哈希密钥的位置：适配器自己按固定算法派生（恢复备份后 SettingId 不变）；直接给的盐（测试替身）
//     也认，派生出来的和照同一算法给的是同一个；没有密钥时用数据目录里自己的盐文件；
//   - 注入的文件函数是异步的（fs.promises）、watch 是 fs.watch 的 (path, options, listener)：适配器照样同步读、照样监视；
//   - 自检的条目是宿主总览的形状 {id, level, label}；
//   - 端到端：真的核心（rugu-core + 替身端口）注册适配器，感知和场合真的入库、游标真的跟着事务走，重启后接着读不重复；
//     网页适配器经宿主的会话中心和绑定两条路交同一条消息，核心只记一条。
// 临时目录在仓库的 .tmp/ 下；账号、群号都是运行时随机生成的。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPersonaMemory } from 'rugu-core';
import { fakePorts, FakeClock } from 'rugu-core/testing';
import { validatePerceptionAdapter, opaqueFrom } from 'rugu-core/contract';
import { validateBinding } from '../../src/binding/index.js';
import { createQqBridgeAdapter } from '../../src/adapters/qq-bridge.js';
import { createWebAdapter, ADAPTER_ID as WEB_ID } from '../../src/adapters/web.js';
import { resolveSalt, ioOf, IDENTITY_KEY_FILE } from '../../src/adapters/util.js';
import { createSessionHub } from '../../src/host/hub.js';
import { fakeSink, fakeLog, rid, inMsg, selfMsg, socialFile, mkTmp, rmTmp, atomicWrite, waitFor } from './helpers.js';

/** 清理栈：后登记的先做（先停适配器、关核心，最后删临时目录）。 */
function cleanup(t) {
  const fns = [];
  t.after(async () => { for (const fn of fns.reverse()) { try { await fn(); } catch { /* 尽力 */ } } });
  return (fn) => fns.push(fn);
}

const writeKey = (dshHome) => {
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, IDENTITY_KEY_FILE), `${crypto.randomBytes(32).toString('base64')}\n`);
};

/**
 * 和 host/index.js 的 startAdapters 同一个形状的 deps：配置是函数（热加载）、paths 带身份哈希密钥的位置（盐由适配器自己派生）、
 * 会话中心给这个适配器的那一份、总开关。salt：宿主测试替身直接给的盐；legacyFs=true：再加上早先那版宿主传的异步文件函数
 * 和 fs.watch 签名的 watch。
 */
function hostDeps({ dshHome, dataDir, acfg = {}, log = fakeLog(), now = () => Date.now(), sessions = createSessionHub().forAdapter(undefined),
  gate, salt, legacyFs = false }) {
  return {
    log, now, config: () => acfg, sessions, ...(gate ? { gate } : {}),
    paths: Object.freeze({ dshHome, dataDir, keyFile: path.join(dshHome, IDENTITY_KEY_FILE), bridgeDir: typeof acfg.bridgeDir === 'string' ? acfg.bridgeDir : '' }),
    ...(salt ? { salt } : {}),
    ...(legacyFs ? {
      readFile: (f, enc) => fs.promises.readFile(f, enc), readFileSync: (f, enc) => fs.readFileSync(f, enc),
      stat: (f) => fs.promises.stat(f), watch: (f, opt, cb) => fs.watch(f, opt, cb),
    } : {}),
  };
}

/** 一个合成的桥接目录：二代模式、白名单、会话映射。 */
function fakeBridge(root) {
  const bridgeDir = path.join(root, 'bridge');
  const ids = { owner: rid('u'), friend: rid('u'), me: rid('u'), g: rid('g') };
  const K = { owner: `private:${ids.owner}`, g: `group:${ids.g}` };
  atomicWrite(path.join(bridgeDir, 'config.json'), {
    ownerQQ: ids.owner, allow: { private: [ids.owner], groups: [ids.g] }, socialV2: { agentPreset: 'qq-chat-v2' },
    continuity: { groups: { [ids.g]: { label: '合成的群' } } },
  });
  atomicWrite(path.join(bridgeDir, 'state', 'mode.json'), { mode: 'reserved2' });
  atomicWrite(path.join(bridgeDir, 'state', 'sessions.json'), { sessions: { [K.g]: 'sess-g' } });
  return { bridgeDir, ids, K, social: path.join(bridgeDir, 'state', 'social-v2.json') };
}

test('盐：deps 给的优先；不给就从身份哈希密钥派生（稳定、按适配器分开、推不回密钥）；没有密钥用数据目录里的盐文件；都没有报错', (t) => {
  const later = cleanup(t);
  const root = mkTmp('salt');
  later(() => rmTmp(root));
  assert.deepEqual(resolveSalt({ salt: 'x'.repeat(16) }, 'qq'), { salt: 'x'.repeat(16), source: 'deps' });
  assert.throws(() => resolveSalt({ salt: 'short', paths: { dshHome: root } }, 'qq'), (e) => e instanceof TypeError && e.code === 'PM_ADAPTER_SALT', '给了坏的盐不悄悄换');

  const home = path.join(root, 'home');
  writeKey(home);
  const keyFile = path.join(home, IDENTITY_KEY_FILE);
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const a = resolveSalt({ paths: { dshHome: home } }, 'qq');
  assert.equal(a.source, 'identity-key');
  assert.ok(typeof a.salt === 'string' && a.salt.length >= 16);
  assert.equal(resolveSalt({ paths: { dshHome: home } }, 'qq').salt, a.salt, '同一把密钥 → 同一个盐（恢复备份后 SettingId 不变）');
  assert.notEqual(resolveSalt({ paths: { dshHome: home } }, 'dsh-web', 'web').salt, a.salt, '每个适配器各自一个');
  assert.ok(!a.salt.includes(key) && a.salt !== key, '不是密钥本身');
  assert.equal(resolveSalt({ paths: { keyFile } }, 'qq').salt, a.salt, 'paths.keyFile 也认');
  // 派生算法固定（opaqueFrom(密钥, 'persona-memory/adapter-salt', 名字)）：别处（宿主、工具）照这个算法得到的是同一个盐
  assert.equal(opaqueFrom(Buffer.from(key, 'base64'), 'persona-memory/adapter-salt', 'qq'), a.salt);
  const viaGiven = createWebAdapter({ salt: resolveSalt({ paths: { keyFile } }, 'dsh-web', 'web').salt });
  const viaSelf = createWebAdapter({ paths: { dshHome: home } });
  assert.equal(viaSelf.ownerSettingId, viaGiven.ownerSettingId, '给不给 salt，场合 id 都一样');
  assert.equal(viaSelf.status().saltSource, 'identity-key');
  const other = path.join(root, 'home2');
  writeKey(other);
  assert.notEqual(resolveSalt({ paths: { dshHome: other } }, 'qq').salt, a.salt);
  const bad = path.join(root, 'home3');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, IDENTITY_KEY_FILE), 'not-a-key\n');
  assert.throws(() => resolveSalt({ paths: { dshHome: bad } }, 'qq'), (e) => e.code === 'PM_ADAPTER_KEY_FORMAT', '密钥坏了不悄悄换成别的盐');

  // 没有密钥文件：数据目录里自己的盐文件（只在本机稳定）
  const data = path.join(root, 'data');
  const l1 = resolveSalt({ paths: { dshHome: path.join(root, 'nokey'), dataDir: data } }, 'qq');
  assert.equal(l1.source, 'local-file');
  assert.ok(fs.existsSync(path.join(data, 'adapter-salt', 'qq.salt')));
  assert.deepEqual(resolveSalt({ paths: { dataDir: data } }, 'qq').salt, l1.salt);
  assert.throws(() => resolveSalt({ paths: {} }, 'qq'), (e) => e.code === 'PM_ADAPTER_SALT');
  assert.throws(() => resolveSalt({}, 'qq'), TypeError);
});

test('文件函数：宿主给的异步 readFile / stat 自动改用同步读，没有未处理的 rejection；Buffer 转文字；watch 用 fs.watch 的签名', async (t) => {
  const later = cleanup(t);
  const root = mkTmp('io');
  later(() => rmTmp(root));
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  t.after(() => process.off('unhandledRejection', onRej));
  const f = path.join(root, 'a.json');
  fs.writeFileSync(f, '{"x":1}');
  const asyncOnly = ioOf({ readFile: (p, enc) => fs.promises.readFile(p, enc), stat: (p) => fs.promises.stat(p) });
  assert.equal(asyncOnly.readFile(f), '{"x":1}');
  assert.equal(asyncOnly.readFile(f), '{"x":1}', '之后一直同步读');
  assert.equal(asyncOnly.stat(f).size, 7);
  assert.equal(asyncOnly.stat(path.join(root, 'none')), null, '文件不在 → null');
  assert.throws(() => asyncOnly.readFile(path.join(root, 'none')), (e) => e.code === 'ENOENT');
  const asyncMissing = ioOf({ readFile: (p, enc) => fs.promises.readFile(p, enc), stat: (p) => fs.promises.stat(p) });
  assert.equal(asyncMissing.stat(path.join(root, 'none')), null, '第一次就撞上不存在的文件');
  assert.throws(() => asyncMissing.readFile(path.join(root, 'none2')), (e) => e.code === 'ENOENT');
  const buf = ioOf({ readFileSync: (p) => fs.readFileSync(p) });
  assert.equal(buf.readFile(f), '{"x":1}', 'Buffer 转成文字');
  let opts = null;
  const w = ioOf({ watch: (p, o, cb) => { opts = o; return fs.watch(p, o, cb); } }).watch(root, () => {});
  assert.deepEqual(opts, { persistent: false });
  w.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rejections.length, 0);
});

test('按宿主的 deps 造两个适配器：形状合格、绑定合格；盐从身份哈希密钥派生，直接给同一个盐得到同一个场合 id；QQ 用真文件系统读得到 rename 覆盖写入的文件；自检是总览的形状', async (t) => {
  const later = cleanup(t);
  const root = mkTmp('hostdeps');
  later(() => rmTmp(root));
  const dshHome = path.join(root, 'home');
  writeKey(dshHome);
  const br = fakeBridge(root);
  const dataDir = path.join(root, 'data');
  const log = fakeLog();
  const qcfg = { enabled: true, bridgeDir: br.bridgeDir, selfAccount: br.ids.me };
  const qq = createQqBridgeAdapter(hostDeps({ dshHome, dataDir, log, acfg: qcfg, gate: () => true }));
  const web = createWebAdapter(hostDeps({ dshHome, dataDir, acfg: { enabled: true, presets: ['her-web'] }, gate: () => true }));
  // 早先那版宿主：传异步文件函数和 fs.watch 签名的 watch；测试替身直接给盐（照同一算法派生的）
  const keyFile = path.join(dshHome, IDENTITY_KEY_FILE);
  const qqLegacy = createQqBridgeAdapter(hostDeps({ dshHome, dataDir, acfg: qcfg, legacyFs: true, salt: resolveSalt({ paths: { keyFile } }, 'qq').salt }));
  const webLegacy = createWebAdapter(hostDeps({ dshHome, dataDir, acfg: { presets: ['her-web'] }, legacyFs: true, salt: resolveSalt({ paths: { keyFile } }, 'dsh-web', 'web').salt }));
  for (const a of [qq, web, qqLegacy, webLegacy]) {
    assert.ok(validatePerceptionAdapter(a).ok, a.id);
    assert.deepEqual(validateBinding(a.binding), { ok: true, errors: [] }, a.id);
    for (const x of a.selfCheck()) {
      assert.ok(typeof x.id === 'string' && x.id && typeof x.label === 'string' && x.label, `${a.id} 自检条目要有 id 和 label`);
      assert.ok(['ok', 'warn', 'fail', 'info'].includes(x.level));
    }
  }
  assert.equal(qq.status().saltSource, 'identity-key');
  assert.equal(web.status().saltSource, 'identity-key');
  assert.equal(qqLegacy.status().saltSource, 'deps');
  assert.equal(webLegacy.ownerSettingId, web.ownerSettingId, '给不给盐，场合 id 都一样');
  const claimG = { id: 'sess-g', preset: 'qq-chat-v2', header: {} };
  assert.equal(qq.binding.claimSession(claimG).settingId, qqLegacy.binding.claimSession(claimG).settingId);
  assert.equal(typeof qq.binding.sanitizer.forPrompt, 'function', 'Sanitizer 端口按适配器叠加的平台转义');
  assert.throws(() => createQqBridgeAdapter(hostDeps({ dshHome, dataDir })), (e) => e.code === 'PM_QQ_NO_BRIDGE_DIR', '没配桥接目录：宿主报出这个错误码');

  const T = Date.now();
  // 同一条消息在桥接的每一版文件里 messageId 都不变（inMsg 每次调用会随机一个新的，所以只造一次）
  const m1 = inMsg({ seq: 1, userId: br.ids.friend, sender: '阿明', text: '第一条', time: T - 1000 });
  const m2 = inMsg({ seq: 2, userId: br.ids.friend, sender: '阿明', text: '第二条', time: T });
  atomicWrite(br.social, socialFile({ [br.K.g]: { recent: [m1] } }));
  const sink = fakeSink();
  const stop = qq.start(sink);
  later(() => stop());
  assert.ok(await waitFor(() => sink.all().length === 1), '防抖后读到第一条');
  atomicWrite(br.social, socialFile({ [br.K.g]: { recent: [m1, m2] } }));
  assert.ok(await waitFor(() => sink.all().length === 2), 'fs.watch（宿主的签名）收到 rename 覆盖的事件');
  assert.deepEqual(sink.all().map((o) => o.text), ['第一条', '第二条']);
  assert.equal(qq.status().watch.watching, true);
  const items = Object.fromEntries(qq.selfCheck().map((x) => [x.id, x.level]));
  assert.equal(items['bridge-mode'], 'ok');
  assert.equal(items.salt, 'ok');
  // 早先那版宿主的文件函数（异步 readFile / stat、fs.watch 签名的 watch）照样读得到、ObsId 一样
  const sink2 = fakeSink();
  const stop2 = qqLegacy.start(sink2);
  later(() => stop2());
  assert.ok(await waitFor(() => sink2.all().length === 2));
  assert.deepEqual(sink2.all().map((o) => [o.text, o.id]), sink.all().map((o) => [o.text, o.id]));
  log.assertNoText(...Object.values(br.ids));
});

test('端到端（真核心）：QQ 的场合和感知真的入库，历史回填标 historical，游标跟着事务走；重启插件后接着读、不重复', async (t) => {
  const later = cleanup(t);
  const root = mkTmp('e2e-qq');
  later(() => rmTmp(root));
  const dshHome = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const keyFile = path.join(dshHome, IDENTITY_KEY_FILE);
  fs.mkdirSync(dshHome, { recursive: true });
  const br = fakeBridge(root);
  const clock = new FakeClock(Date.UTC(2026, 10, 4, 8, 0, 0));
  const T = clock.now();
  const H = 3_600_000;
  atomicWrite(br.social, socialFile({
    [br.K.g]: { recent: [
      inMsg({ seq: 1, userId: br.ids.friend, sender: '阿明', text: '昨天的事', time: T - 20 * H }),
      inMsg({ seq: 2, userId: br.ids.friend, sender: '阿明', text: '刚刚说的', time: T - 10_000 }),
      selfMsg('我也觉得', T - 5000),
    ] },
    [br.K.owner]: { recent: [inMsg({ seq: 1, userId: br.ids.owner, text: '在吗', time: T - 8000, isOwner: true })] },
  }));
  const open = () => createPersonaMemory({ dataDir, keyFile, ports: fakePorts({ clock }), startWorker: false });
  const acfg = { enabled: true, bridgeDir: br.bridgeDir, selfAccount: br.ids.me, selfNames: ['小雪'] };

  let pm = await open();
  later(() => pm.close());   // 重开之后 pm 指向新的那个
  let qq = createQqBridgeAdapter(hostDeps({ dshHome, dataDir, acfg, now: () => clock.now(), gate: (sid) => pm.modeOf(sid) !== 'off' }));
  let unreg = pm.registerAdapter(qq);
  assert.equal(qq.refresh(), 'ok');
  const percepts = () => pm.admin.list({ view: 'percepts', limit: 200 });
  assert.ok(await waitFor(() => percepts().total === 4), `四条都入库（实际 ${percepts().total}）`);
  const list = percepts().items;
  assert.equal(list.filter((p) => p.historical).length, 1, '插件启动前很久的那条按历史回填');
  assert.ok(list.some((p) => p.self && p.kind === 'self-utterance'));
  for (const p of list) for (const id of Object.values(br.ids)) assert.ok(!String(p.text).includes(id), 'text 里没有账号原值');
  const settings = pm.admin.list({ view: 'settings' }).items.filter((s) => s.adapter === 'qq');
  assert.equal(settings.length, 2);
  const group = settings.find((s) => s.descriptor?.audience?.entry === 'invite');
  assert.deepEqual(group.descriptor.audience, { size: 'unknown', entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' });
  assert.equal(group.label, '合成的群');
  const salt = resolveSalt({ paths: { dshHome } }, 'qq').salt;
  const gSid = opaqueFrom(salt, 'qq/setting', br.K.g);
  assert.equal(pm.modeOf(gSid), 'live', '派生的 SettingId 核心认得；群默认也开着（§15.2）');
  const cur = JSON.parse(pm.cursor('qq', `conv.${gSid}`));
  assert.equal(cur.s, 2, '游标和感知一起提交');

  // 重启插件（核心关掉再开、适配器重新造）：从游标接着读
  unreg();
  await pm.close();
  pm = await open();
  clock.advance(60_000);
  atomicWrite(br.social, socialFile({
    [br.K.g]: { recent: [
      inMsg({ seq: 1, userId: br.ids.friend, sender: '阿明', text: '昨天的事', time: T - 20 * H }),
      inMsg({ seq: 2, userId: br.ids.friend, sender: '阿明', text: '刚刚说的', time: T - 10_000 }),
      selfMsg('我也觉得', T - 5000),
      inMsg({ seq: 3, userId: br.ids.friend, sender: '阿明', text: '重启之后的', time: T + 30_000 }),
    ] },
    [br.K.owner]: { recent: [inMsg({ seq: 1, userId: br.ids.owner, text: '在吗', time: T - 8000, isOwner: true })] },
  }));
  qq = createQqBridgeAdapter(hostDeps({ dshHome, dataDir, acfg, now: () => clock.now(), gate: (sid) => pm.modeOf(sid) !== 'off' }));
  unreg = pm.registerAdapter(qq);
  later(() => unreg());
  assert.equal(qq.refresh(), 'ok');
  assert.ok(await waitFor(() => percepts().total === 5), `只多了一条（实际 ${percepts().total}）`);
  assert.equal(percepts().items.filter((p) => p.text === '重启之后的').length, 1);
  assert.equal(JSON.parse(pm.cursor('qq', `conv.${gSid}`)).s, 3);
});

test('端到端（真核心）：网页会话经宿主的会话中心和绑定两条路交同一条消息，核心只记一条；认领要网页客户端的时区标记', async (t) => {
  const later = cleanup(t);
  const root = mkTmp('e2e-web');
  later(() => rmTmp(root));
  const dshHome = path.join(root, 'home');
  fs.mkdirSync(dshHome, { recursive: true });
  const dataDir = path.join(root, 'data');
  const clock = new FakeClock(Date.UTC(2026, 10, 4, 9, 0, 0));
  const pm = await createPersonaMemory({ dataDir, keyFile: path.join(dshHome, IDENTITY_KEY_FILE), ports: fakePorts({ clock }), startWorker: false });
  later(() => pm.close());
  const hub = createSessionHub();
  const web = createWebAdapter(hostDeps({ dshHome, dataDir, acfg: { presets: ['her-web'] }, sessions: hub.forAdapter(undefined), now: () => clock.now(), gate: (sid) => pm.modeOf(sid) !== 'off' }));
  const unreg = pm.registerAdapter(web);
  later(() => unreg());
  const msg = { id: rid('m'), role: 'user', content: [{ type: 'text', text: '今天好累' }], source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' } };
  const claim = web.binding.claimSession({ id: 'sess-w', preset: 'her-web', header: {}, messages: [msg] });
  assert.deepEqual(claim, { settingId: web.ownerSettingId, confidence: 'fallback' });
  // 宿主的 session/event：先发给会话中心，再交给认领它的绑定（context.js onSessionEvent）
  const event = { type: 'user/message', data: msg, seq: 7 };
  hub.emitMessage({ sessionId: 'sess-w', claim: { settingId: claim.settingId, adapterId: WEB_ID }, type: event.type, data: event.data, seq: event.seq, session: {} });
  pm.observe(web.binding.fromSessionEvent(event, claim.settingId, 'sess-w'), { adapter: WEB_ID });
  const percepts = () => pm.admin.list({ view: 'percepts', limit: 50 });
  assert.ok(await waitFor(() => percepts().total >= 1));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(percepts().total, 1, '同一个 ObsId，只记一条');
  assert.equal(percepts().items[0].addressed, 'to-her');
  const s = pm.admin.list({ view: 'settings' }).items.find((x) => x.adapter === WEB_ID);
  assert.deepEqual(s.descriptor.capabilities, { preSendGate: false, canHold: false });
});
