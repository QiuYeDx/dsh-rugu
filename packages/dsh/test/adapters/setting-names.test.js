// 场合的名字（D111，实测问题 #19，用户反馈第 10 轮）在适配器这一层：
//   - 平台上的群名从 SnowLuma 的缓存库被动地读（qq/names.js）：学得到、表重写后刷新、机器人的备注优先、表结构不认识 / 没配置就当没有；
//   - QQ 的场合描述：名字（主人的插件配置 > 桥接配置 > 平台上的）是 labelKind 'name'；不知道名字就是一句说法「一个 QQ 群」，
//     短码和人数只进 hint，从不进 label；主人的私聊是一句说法；
//   - 适配器的 displayName、quietReason（管理页用）；DSH 网页场合是一句说法，没有认领证据时说清楚为什么收不到。
// 群号、账号运行时随机生成；群名都是编的；临时库在仓库的 .tmp/ 下。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateSettingDescriptor, validatePerceptionAdapter, opaqueFrom } from 'rugu-core/contract';
import { createPlatformNames } from '../../src/adapters/qq/names.js';
import { describeConversation } from '../../src/adapters/qq/describe.js';
import { projectBridgeConfig } from '../../src/adapters/qq/files.js';
import { createQqBridgeAdapter } from '../../src/adapters/qq-bridge.js';
import { createWebAdapter } from '../../src/adapters/web.js';
import { fakeTimers, fakeFs, fakeSink, fakeLog, rid, salt as mkSalt, socialFile, mkTmp, rmTmp } from './helpers.js';

const CODE_IN_PARENS = /（[A-Za-z0-9_-]{4}）/;

/** 一个假的 SnowLuma 目录：data/<随机子目录>/snowluma_identity.db，表结构照 v2.2.1 的 groups。 */
function fakeSnowLuma(rows, { columns } = {}) {
  const home = mkTmp('names-sl');
  const sub = path.join(home, 'data', rid('bot'));
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, 'snowluma_identity.db');
  const db = new DatabaseSync(file);
  db.exec(columns ?? 'CREATE TABLE groups (group_id INTEGER PRIMARY KEY, group_name TEXT, remark TEXT, member_count INTEGER, member_max INTEGER, active INTEGER, updated_at INTEGER)');
  const write = (list) => {
    db.exec('DELETE FROM groups');
    for (const r of list) {
      db.prepare('INSERT INTO groups (group_id, group_name, remark, member_count, member_max, active, updated_at) VALUES (?, ?, ?, ?, 200, 1, ?)')
        .run(r.id, r.name ?? '', r.remark ?? '', r.count ?? 0, r.at ?? 1);
    }
  };
  if (!columns) write(rows);
  return { home, file, write, close: () => { db.close(); rmTmp(home); } };
}

test('平台上的群名：被动读到；机器人的备注优先；表重写（改名）后刷新；不带路径和名字的状态', () => {
  const g1 = String(100_000 + Math.floor(Math.random() * 1e6));
  const g2 = String(Number(g1) + 7);
  const sl = fakeSnowLuma([{ id: g1, name: '周末读书会', count: 9 }, { id: g2, name: '平台群名', remark: '我们的小群', count: 3 }]);
  let t = 0;
  const names = createPlatformNames({ dir: () => sl.home, now: () => t, minIntervalMs: 0 });
  try {
    assert.deepEqual(names.group(g1), { name: '周末读书会', source: 'name', memberCount: 9 });
    assert.deepEqual(names.group(g2), { name: '我们的小群', source: 'remark', memberCount: 3 }, '备注优先');
    assert.equal(names.group('424242'), null);
    const st = names.status();
    assert.deepEqual([st.ok, st.groups, st.reason], [true, 2, null]);
    assert.ok(!JSON.stringify(st).includes(sl.home) && !JSON.stringify(st).includes('读书会'), '状态里没有路径和名字');
    // SnowLuma 同步群列表时整张表重写：名字变了，下一次查就是新的
    sl.write([{ id: g1, name: '周末读书会（新）', count: 10, at: 2 }, { id: g2, name: '平台群名', remark: '我们的小群', count: 3 }]);
    fs.utimesSync(sl.file, new Date(), new Date(Date.now() + 5000));
    t += 1;
    assert.deepEqual(names.group(g1), { name: '周末读书会（新）', source: 'name', memberCount: 10 });
  } finally { sl.close(); }
});

test('平台上的群名：没配置、关掉、表结构不认识、目录不在 → 当没有（不抛错）', () => {
  assert.equal(createPlatformNames({ dir: () => null, now: () => 0 }).group('1'), null);
  assert.equal(createPlatformNames({ dir: () => null, now: () => 0 }).status().reason, 'off');
  const missing = createPlatformNames({ dir: () => path.join('X:', 'no-such-dir'), now: () => 0 });
  assert.equal(missing.group('1'), null);
  assert.equal(missing.status().ok, false);
  const odd = fakeSnowLuma([], { columns: 'CREATE TABLE groups (gid INTEGER, title TEXT)' });
  try {
    const n = createPlatformNames({ dir: () => odd.home, now: () => 0 });
    assert.equal(n.group('1'), null);
    assert.deepEqual([n.status().ok, n.status().reason], [false, 'schema']);
  } finally { odd.close(); }
  const broken = createPlatformNames({ dir: () => 'D:/sl', now: () => 0, listDirs: () => ['b'], stat: () => ({ size: 1, mtimeMs: 1 }), openDb: () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); } });
  assert.equal(broken.group('1'), null);
  assert.equal(broken.status().reason, 'unreadable');
});

test('QQ 场合描述：名字的来源和种类；不知道名字时是一句说法，短码和人数只进 hint，从不进 label', () => {
  const owner = rid('u');
  const other = rid('u');
  const g = rid('g');
  const s = mkSalt();
  const sid = (k) => opaqueFrom(s, 'qq/setting', k);
  const bare = projectBridgeConfig({ ownerQQ: owner });
  const labeled = projectBridgeConfig({ ownerQQ: owner, continuity: { groups: { [g]: { label: '桥接里写的名字' } } } });
  const base = { key: `group:${g}`, settingId: sid(`group:${g}`), code: 'Xy7q', ownerId: owner, principalLabel: '主人' };
  const cases = [
    [describeConversation({ ...base, bridgeCfg: bare }), '一个 QQ 群', 'description', 'Xy7q', undefined],
    [describeConversation({ ...base, bridgeCfg: bare, platform: { name: '', source: 'name', memberCount: 9 } }), '一个 QQ 群', 'description', '9 人 · Xy7q', undefined],
    [describeConversation({ ...base, bridgeCfg: bare, platform: { name: '平台上的群名', source: 'name', memberCount: 9 } }), '平台上的群名', 'name', '9 人 · Xy7q', 'platform'],
    [describeConversation({ ...base, bridgeCfg: labeled, platform: { name: '平台上的群名', source: 'name', memberCount: null } }), '桥接里写的名字', 'name', 'Xy7q', 'config'],
    [describeConversation({ ...base, bridgeCfg: labeled, override: { label: '主人配置里的名字' }, platform: { name: '平台上的群名', source: 'name', memberCount: 9 } }), '主人配置里的名字', 'name', '9 人 · Xy7q', 'config'],
    // 平台上的群名和消息一样清洗账号（评审）：认识的账号换成名字，5 位以上的数字串去掉；只剩标点就当不知道名字
    [describeConversation({ ...base, bridgeCfg: bare, known: new Map([[other, '阿明']]), platform: { name: `${other}和朋友们 13800001111`, source: 'name', memberCount: 3 } }),
      '阿明和朋友们', 'name', '3 人 · Xy7q', 'platform'],
    [describeConversation({ ...base, bridgeCfg: bare, platform: { name: '123456789 —', source: 'name', memberCount: 3 } }), '一个 QQ 群', 'description', '3 人 · Xy7q', undefined],
  ];
  for (const [d, label, kind, hint, origin] of cases) {
    assert.ok(validateSettingDescriptor(d).ok, JSON.stringify(validateSettingDescriptor(d).errors));
    assert.deepEqual([d.label, d.labelKind, d.hint, d.labelOrigin], [label, kind, hint, origin]);
    assert.ok(!/\d{5,}/.test(d.label), '账号样的数字串不进名字');
    assert.ok(!d.label.includes('Xy7q') && !CODE_IN_PARENS.test(d.label), '短码从不进 label');
    assert.equal(d.audience.size, 'unknown', '人数只进提示，不改场合属性（这一轮不动分寸）');
  }
  const dm = describeConversation({ key: `private:${owner}`, settingId: sid(`private:${owner}`), code: 'Ab1c', bridgeCfg: bare, ownerId: owner, principalLabel: '主人' });
  assert.deepEqual([dm.label, dm.labelKind, dm.hint], ['和主人的私聊', 'description', undefined]);
  const peer = describeConversation({ key: `private:${other}`, settingId: sid(`private:${other}`), code: 'Cd2e', bridgeCfg: bare, ownerId: owner, principalLabel: '主人' });
  assert.deepEqual([peer.label, peer.labelKind, peer.hint], ['一个 QQ 私聊', 'description', 'Cd2e']);
  const named = describeConversation({ key: `private:${other}`, settingId: sid(`private:${other}`), code: 'Cd2e', bridgeCfg: bare, ownerId: owner, principalLabel: '主人', override: { label: '和老同学的私聊' } });
  assert.deepEqual([named.label, named.labelKind], ['和老同学的私聊', 'name']);
});

test('QQ 适配器：描述里带平台上的群名、改名后下一次描述就是新的；入口名 QQ；不是二代模式时说清楚为什么收不到；桥接配置只取 SnowLuma 目录', () => {
  const timers = fakeTimers();
  const ffs = fakeFs(timers);
  const bridgeDir = path.join('X:', 'fake-bridge');
  const state = path.join(bridgeDir, 'state');
  const ids = { owner: rid('u'), g: rid('g'), g2: rid('g') };
  const K = { g: `group:${ids.g}`, g2: `group:${ids.g2}` };
  const raw = { ownerQQ: ids.owner, allow: { groups: [ids.g, ids.g2] }, socialV2: { agentPreset: 'qq-chat-v2' }, snowluma: { homeDir: 'D:/sl-home', accessToken: 'tok-ob-secret', httpUrl: 'http://127.0.0.1:1' } };
  const proj = projectBridgeConfig(raw);
  assert.equal(proj.snowlumaHome, 'D:/sl-home');
  assert.ok(!JSON.stringify([...Object.entries(proj)]).includes('tok-ob-secret'), '令牌不进投影');
  ffs.write(path.join(bridgeDir, 'config.json'), raw, { events: false });
  ffs.write(path.join(state, 'mode.json'), { mode: 'reserved2' }, { events: false });
  ffs.write(path.join(state, 'sessions.json'), { sessions: {} }, { events: false });
  const platform = new Map([[ids.g, { name: '编的群名', source: 'name', memberCount: 5 }]]);
  const s = mkSalt();
  const adapter = createQqBridgeAdapter({
    paths: { bridgeDir }, salt: s, readFile: ffs.readFile, stat: ffs.stat, watch: ffs.watch, timers, now: timers.now, log: fakeLog(),
    platformNames: { group: (id) => platform.get(id) ?? null, status: () => ({ ok: true, groups: platform.size, reason: null }) },
  });
  assert.ok(validatePerceptionAdapter(adapter).ok);
  assert.equal(adapter.displayName, 'QQ');
  const sid = (k) => opaqueFrom(s, 'qq/setting', k);
  const sink = fakeSink();
  ffs.write(path.join(state, 'social-v2.json'), socialFile({ [K.g]: { recent: [] }, [K.g2]: { recent: [] } }), { events: false });
  adapter.start(sink);
  timers.advance(300);
  const labelOf = (k) => sink.described.filter((d) => d.id === sid(k)).at(-1);
  assert.deepEqual([labelOf(K.g).label, labelOf(K.g).labelKind, labelOf(K.g).hint.startsWith('5 人 · ')], ['编的群名', 'name', true]);
  assert.deepEqual([labelOf(K.g2).label, labelOf(K.g2).labelKind], ['一个 QQ 群', 'description']);
  // 群改了名：桥接文件下一次变化时（来了新消息）重新描述
  platform.set(ids.g, { name: '编的新群名', source: 'name', memberCount: 5 });
  ffs.write(path.join(state, 'social-v2.json'), socialFile({ [K.g]: { recent: [] }, [K.g2]: { recent: [] }, [`private:${ids.owner}`]: { recent: [] } }));
  timers.advance(2500);
  assert.equal(labelOf(K.g).label, '编的新群名');
  for (const d of sink.described) assert.ok(!CODE_IN_PARENS.test(d.label), `label 里没有短码：${d.label}`);
  assert.equal(adapter.quietReason(sid(K.g)), null);
  assert.equal(adapter.quietReason('不认识的场合'), null);
  ffs.write(path.join(state, 'mode.json'), { mode: 'chat' }, { events: false });
  assert.match(adapter.quietReason(sid(K.g)), /不是二代模式/);
  const pn = adapter.selfCheck().find((c) => c.id === 'platform-names');
  assert.deepEqual([pn.ok, pn.level], [true, 'ok']);
  assert.ok(!pn.label.includes('编的'), '自检里没有群名');
});

test('DSH 网页场合：一句说法（不当名字认）；入口名 DSH 网页；没有认领证据时说清楚为什么还没有会话记在这里', () => {
  const mk = (config) => createWebAdapter({ salt: mkSalt(), config, log: fakeLog(), now: () => Date.UTC(2026, 10, 4, 9, 0, 0) });
  const bare = mk({ excludeCwdPrefixes: ['X:/bridge/state'] });
  assert.equal(bare.displayName, 'DSH 网页');
  const d = bare.describeSetting(bare.ownerSettingId);
  assert.deepEqual([d.label, d.labelKind], ['和主人的 DSH 聊天', 'description']);
  assert.ok(validateSettingDescriptor(d).ok);
  const why = bare.quietReason(bare.ownerSettingId);
  assert.match(why, /DSH 桌面里的会话.*都记不住/, '先说人话：桌面里的会话没接上');
  assert.ok(!/host\.adapters|presets|sessionIds/.test(why), '不在主人看的那一行里写配置键（诊断页有）');
  assert.equal(mk({ presets: ['her-web'] }).quietReason(bare.ownerSettingId), null, '有认领的证据就不报');
  assert.equal(bare.quietReason('别的场合'), null);
});
