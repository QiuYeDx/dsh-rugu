// §7.1 的 1–9 步（drain）：校验 → 清洗 → 去重和注意力升级 → 认说话人 → 出现集合 → 行 + FTS + 游标同一个事务 → 通知。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ftsSearch } from '../../src/store/fts.js';
import { readMetrics } from '../../src/store/kv.js';
import { makeKeyring } from '../../src/store/keys.js';
import { TEST_KEY } from '../fakes/test-core.js';
import {
  withIntake, ingest, obs, descriptor, oneOnOne, people, sid, ADAPTER, SELF_ID, PRINCIPAL_ID, T0, M,
} from './helpers.js';

const SECRET_KEY = makeKeyring(TEST_KEY).settingKey(ADAPTER, sid('secret'));
const metric = (core, name) => readMetrics(core.store).filter((r) => r.name === name).reduce((a, r) => a + r.value, 0);

test('入库：一条感知的各列；原值 id 只存 HMAC；入库后原文立刻能被词法路找到（同一事务）', () => withIntake((t) => {
  const o = obs('g', 'friend', '我表哥开网约车，挺辛苦的', { addressed: 'to-her' });
  const r = ingest(t, [o]);
  assert.equal(r.accepted, 1);
  const [p] = t.rows();
  assert.equal(p.adapter, ADAPTER);
  assert.equal(p.ext_key, t.core.keys.obsKey(ADAPTER, o.id));
  assert.notEqual(p.ext_key, o.id);
  assert.equal(p.setting_key, t.key('g'));
  assert.equal(p.perceived_in, t.key('g'));
  assert.equal(p.visible_to, 'setting-audience');
  assert.equal(p.kind, 'utterance');
  assert.equal(p.addressed, 'to-her');
  assert.equal(p.attention_class, 'toHer');
  assert.equal(p.norm_state, 'unassessed');
  assert.equal(p.episode_id, null);
  assert.equal(p.lang, 'zh');
  assert.ok(p.actor_entity_id >= 10);
  assert.ok(p.w_enc > 0);
  assert.ok(p.snapshot_id > 0);
  assert.ok(p.presence_set_id > 0);
  // 账号原值不进库
  assert.ok(!p.actor_json.includes('ufriend001'));
  assert.match(p.actor_json, /idHash/);
  // FTS：同一个事务写进了当月分表
  assert.ok(p.fts_shard.startsWith('percepts_fts_'));
  const hits = ftsSearch(t.core.store, p.fts_shard, t.core.mods.lang.queryTerms(t.core, '网约车'));
  assert.deepEqual(hits.map((h) => h.rowid), [p.id]);
  // 日志里只有 id 和计数
  t.core.log.assertNoText('网约车', 'ufriend001', o.id);
}));

test('第 1 步：不合契约的丢弃并计数，同一批里合格的照常入库', () => withIntake((t) => {
  const good = obs('g', 'friend', '好的');
  const bad1 = { ...obs('g', 'friend', 'x'), kind: 'whatever' };
  const bad2 = { ...obs('g', 'friend', 'y'), actor: { self: true, claims: [] } };   // 她自己的 utterance 应该是 self-utterance
  const r = ingest(t, [bad1, good, bad2]);
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected, 2);
  assert.equal(metric(t.core, 'intake.rejected'), 2);
  assert.equal(t.rows().length, 1);
}));

test('enqueue 同步、不抛错：没有适配器 id、不认识的适配器、不是数组、坏的选项都只计数', () => withIntake((t) => {
  const { intake } = t.core.mods;
  assert.doesNotThrow(() => intake.enqueue(t.core, undefined, [obs('g', 'friend', 'a')]));
  assert.doesNotThrow(() => intake.enqueue(t.core, 'nobody', [obs('g', 'friend', 'a')]));
  assert.doesNotThrow(() => intake.enqueue(t.core, ADAPTER, /** @type {any} */ ('nope')));
  assert.doesNotThrow(() => intake.enqueue(t.core, ADAPTER, [obs('g', 'friend', 'a')], /** @type {any} */ ({ historical: 'yes' })));
  assert.equal(t.drain().accepted, 0);
  assert.equal(metric(t.core, 'intake.dropped.adapter'), 2);
  assert.equal(metric(t.core, 'intake.rejected'), 2);
  // 同步部分很快（入队而已）
  const list = Array.from({ length: 20 }, (_, i) => obs('g', 'friend', `消息${i}`));
  const t0 = performance.now();
  intake.enqueue(t.core, ADAPTER, list);
  assert.ok(performance.now() - t0 < 5);
  assert.equal(t.drain().accepted, 20);
}));

test('observe 之后不调 drain 也会在 setImmediate 里处理', () => withIntake(async (t) => {
  t.observe([obs('g', 'friend', '自动处理')]);
  assert.equal(t.rows().length, 0);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(t.rows().length, 1);
}));

test('第 3 步：同一条消息重复提交结果相同；注意力取较高的（升级不新建行，w_enc 取较大值）', () => withIntake((t) => {
  const o = obs('g', 'friend', '今晚加班', { attention: 'peripheral' });
  ingest(t, [o]);
  const [p0] = t.rows();
  assert.equal(p0.attention_class, 'peripheral');
  // 原样再来一次：没有变化
  assert.equal(ingest(t, [o]).duplicates, 1);
  // 她后来在工具结果里读到了：升级
  const r = ingest(t, [{ ...o, attention: 'attended', perceivedAt: o.perceivedAt + 5 * M }]);
  assert.equal(r.upgraded, 1);
  const [p1] = t.rows();
  assert.equal(t.rows().length, 1);
  assert.equal(p1.attention, 'attended');
  assert.equal(p1.attention_class, 'attendedAmbient');
  assert.ok(p1.w_enc > p0.w_enc);
  // 较低的那个再来：不降级
  assert.equal(ingest(t, [{ ...o, attention: 'peripheral' }]).duplicates, 1);
  assert.equal(t.rows()[0].attention, 'attended');
  // addressed 也取较高的（ambient → to-her）
  assert.equal(ingest(t, [{ ...o, addressed: 'to-her' }]).upgraded, 1);
  assert.equal(t.rows()[0].attention_class, 'toHer');
}));

test('同一条消息后来被标成对她说的（唤醒路径交上来）：升级后再通知一次预取；只是注意力升级不再通知', () => withIntake((t) => {
  const o = obs('g', 'friend', '在吗', { attention: 'peripheral' });
  ingest(t, [o]);
  assert.equal(t.calls['retrieve.onPercepts'].length, 1);
  ingest(t, [{ ...o, attention: 'attended' }]);
  assert.equal(t.calls['retrieve.onPercepts'].length, 1);
  ingest(t, [{ ...o, attention: 'attended', addressed: 'mentions-her' }]);
  assert.equal(t.calls['retrieve.onPercepts'].length, 2);
  const [, rows] = t.calls['retrieve.onPercepts'][1];
  assert.equal(rows[0].addressed, 'mentions-her');
  assert.equal(rows[0].id, t.rows()[0].id);
  // 回填里的升级不预取
  const h = obs('g', 'friend', '旧消息', { attention: 'peripheral', historical: true });
  ingest(t, [h]);
  ingest(t, [{ ...h, addressed: 'to-her' }]);
  assert.equal(t.calls['retrieve.onPercepts'].length, 2);
}));

test('升级时给包含它的原文窗口补一条更强的痕迹（感知本身没有痕迹行）', () => withIntake((t) => {
  const o = obs('g', 'friend', '旁听到的一句', { attention: 'peripheral' });
  ingest(t, [o]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const [p] = t.rows();
  assert.ok(p.window_id > 0);
  const before = (t.calls['dynamics.addTrace'] ?? []).length;
  ingest(t, [{ ...o, attention: 'attended', perceivedAt: o.at + 3 * M }]);
  const traces = t.calls['dynamics.addTrace'].slice(before);
  assert.equal(traces.length, 1);
  const [ref, tr] = traces[0];
  assert.deepEqual(ref, { kind: 'window', id: p.window_id });
  assert.equal(tr.reason, 'reread');
  assert.equal(tr.t, o.at + 3 * M);   // 痕迹时间用她读到的时间
  assert.equal(tr.w, t.rows()[0].w_enc);
}));

test('场合 attending=false：这个场合的感知丢弃（事情发生的场合或她知道的场合任一个）', () => withIntake((t) => {
  const r = ingest(t, [obs('away', 'friend', '她不在这里'), obs('g', 'friend', '这里在', { perceivedInSettingId: sid('away') })]);
  assert.equal(r.dropped, 2);
  assert.equal(t.rows().length, 0);
  // 之后改成 attending=true：照常入库
  t.describe(descriptor('away', { attending: true }));
  assert.equal(ingest(t, [obs('away', 'friend', '回来了')]).accepted, 1);
}, { settings: { g: descriptor('g'), away: descriptor('away', { attending: false }) } }));

test('「别记」规则：命中说话人 → 不入库（认人时写下的东西随这一条的保存点一起回滚）', () => withIntake((t) => {
  const r = ingest(t, [obs('g', 'friend', '别记我'), obs('g', 'other', '可以记'), obs('g', 'principal', '@阿明 你好', { mentions: [people.friend] })]);
  assert.equal(r.accepted, 1);
  assert.equal(r.dropped, 2);   // 说话人命中，或者提到的人命中
  assert.deepEqual(t.rows().map((p) => p.text), ['可以记']);
  // 问过场合和涉及的实体两种
  const qs = t.calls['admin.doNotRemember'].map(([q]) => q);
  assert.ok(qs.some((q) => q.settingKey === t.key('g')));
  assert.ok(qs.some((q) => Array.isArray(q.entityIds) && q.entityIds.includes(10)));
  // 被丢掉的那条没有给档案加「被提到」
  assert.equal((t.calls['entities.noteMention'] ?? []).length, 0);
}, { doNotRemember: (q) => (q.entityIds ?? []).includes(10) }));

test('「别记」规则：命中场合 → 这个场合的感知都不入库（她知道的场合命中也一样）', () => withIntake((t) => {
  const r = ingest(t, [obs('secret', 'other', '这里别记'), obs('g', 'other', '在别处读到', { perceivedInSettingId: sid('secret') }), obs('g', 'other', '这里可以')]);
  assert.equal(r.dropped, 2);
  assert.deepEqual(t.rows().map((p) => p.text), ['这里可以']);
}, {
  settings: { g: descriptor('g'), secret: descriptor('secret') },
  doNotRemember: (q) => q.settingKey === SECRET_KEY,
}));

test('「别记」规则查不了：整批不提交（感知和游标都没写），留在队列头上，好了以后补上', () => {
  let broken = true;
  return withIntake((t) => {
    t.observe([obs('g', 'friend', '一'), obs('g', 'friend', '二')], { cursor: { key: 'g', value: '42' } });
    const r = t.drain();
    assert.equal(r.accepted, 0);
    assert.equal(t.rows().length, 0);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), null);
    broken = false;
    const r2 = t.drain();
    assert.equal(r2.accepted, 2);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), '42');
  }, { doNotRemember: () => { if (broken) throw new Error('rules unavailable'); return false; } });
});

test('§12.8 第 1 条：游标和感知同一个事务；事务边界抛错（崩溃注入）→ 感知和游标都没写，重试后都写进去', () => withIntake((t) => {
  const real = t.core.store;
  let crash = true;
  // 只拦写游标那一句：模拟事务提交前的崩溃
  t.core.store = new Proxy(real, {
    get(target, prop) {
      if (prop === 'run') {
        return (sql, ...a) => {
          if (crash && /INSERT INTO cursors/.test(sql)) throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
          return target.run(sql, ...a);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    t.observe([obs('g', 'friend', '第一条'), obs('g', 'friend', '第二条')], { cursor: { key: 'room-g', value: 'c-2' } });
    const r = t.drain();
    assert.equal(r.accepted, 0);
    assert.equal(real.get('SELECT COUNT(*) AS n FROM percepts').n, 0);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'room-g'), null);
    // 通知也没有发出去（afterCommit 随回滚作废）
    assert.equal((t.calls['retrieve.onPercepts'] ?? []).length, 0);
    crash = false;
    assert.equal(t.drain().accepted, 2);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'room-g'), 'c-2');
  } finally { t.core.store = real; }
}));

test('一批几次都提交不了才丢；丢过之后同一个游标键在本次运行里不再推进（后面的批次照样入库），重新注册后恢复', () => withIntake((t) => {
  const real = t.core.store;
  let crash = true;
  t.core.store = new Proxy(real, {
    get(target, prop) {
      if (prop === 'run') {
        return (sql, ...a) => {
          if (crash && /INSERT INTO percepts\(/.test(sql)) throw Object.assign(new Error('disk full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
          return target.run(sql, ...a);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    t.observe([obs('g', 'friend', '丢掉的那批')], { cursor: { key: 'g', value: '1' } });
    assert.equal(t.drain().accepted, 0);
    assert.equal(t.drain().accepted, 0);
    const r = t.drain();   // 第 3 次：丢掉
    assert.equal(r.failed, 1);
    assert.equal(t.core.state.intake.queues.size, 0);
    crash = false;
    t.observe([obs('g', 'friend', '后面的一批')], { cursor: { key: 'g', value: '2' } });
    t.observe([obs('g', 'friend', '别的游标键')], { cursor: { key: 'h', value: '9' } });
    assert.equal(t.drain().accepted, 2);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), null);   // 没有推过丢掉的那一段
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'h'), '9');
    assert.ok(metric(t.core, 'intake.cursor.held') >= 1);
    // 适配器重新注册（会从旧游标重读）：丢掉的那批补上，重复的去重，游标恢复推进
    t.core.mods.intake.registerAdapter(t.core, t.adapter);
    const again = [obs('g', 'friend', '丢掉的那批')];
    ingest(t, again, { cursor: { key: 'g', value: '2' } });
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'g'), '2');
    assert.deepEqual(t.rows().map((p) => p.text).sort(), ['丢掉的那批', '别的游标键', '后面的一批'].sort());
  } finally { t.core.store = real; }
}));

test('D2：只带游标的空批次也推进游标；sink.cursor 和 intake.cursor 读回同一个值', () => withIntake((t) => {
  t.observe([], { cursor: { key: 'k1', value: 'v1' } });
  t.drain();
  assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'k1'), 'v1');
  assert.equal(t.adapter.sink.cursor('k1'), 'v1');
  assert.equal(t.core.mods.intake.cursor(t.core, 'other-adapter', 'k1'), null);
  // 后提交的覆盖先提交的
  t.observe([obs('g', 'friend', 'x')], { cursor: { key: 'k1', value: 'v2' } });
  t.drain();
  assert.equal(t.adapter.sink.cursor('k1'), 'v2');
}));

test('同一个适配器的批次按顺序提交：前一批卡住（等场合描述）时后一批也等着，游标不会跳过没提交的', () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const settings = { g: descriptor('g'), late: descriptor('late') };
  return withIntake(async (t) => {
    t.adapter.describeSetting = (id) => (id === sid('late') ? pending : structuredClone(settings.g));
    t.observe([obs('late', 'friend', '新场合')], { cursor: { key: 'c', value: '1' } });
    t.observe([obs('g', 'friend', '老场合')], { cursor: { key: 'c', value: '2' } });
    const r = t.drain();
    assert.equal(r.accepted, 0);
    assert.ok(r.waiting >= 1);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'c'), null);
    resolve(structuredClone(settings.late));
    await pending;
    await new Promise((r2) => setImmediate(r2));
    await new Promise((r2) => setImmediate(r2));
    t.drain();
    assert.deepEqual(t.rows().map((p) => p.text), ['新场合', '老场合']);
    assert.equal(t.core.mods.intake.cursor(t.core, ADAPTER, 'c'), '2');
  }, { settings: { g: settings.g } });
});

test('没描述过的场合：drain 向适配器要描述（同步给的当场入库；要不到就计数丢弃）', () => {
  const settings = { g: descriptor('g'), newroom: descriptor('newroom') };
  return withIntake((t) => {
    t.adapter.describeSetting = (id) => {
      if (id === sid('newroom')) return structuredClone(settings.newroom);
      throw new Error('不知道');
    };
    const r = ingest(t, [obs('newroom', 'friend', '新地方'), obs('ghost', 'friend', '没人描述')]);
    assert.equal(r.accepted, 1);
    assert.equal(r.dropped, 1);
    assert.ok(t.core.mods.intake.settingByKey(t.core, t.key('newroom')));
    assert.equal(metric(t.core, 'intake.describe.unavailable'), 1);
  }, { settings: { g: settings.g } });
});

test('historical=true（回填）：照常入库、去重，但不通知预取', () => withIntake((t) => {
  const old = obs('g', 'friend', '很久以前的话', { at: T0 - 30 * 24 * 60 * M });
  ingest(t, [old], { historical: true });
  ingest(t, [obs('g', 'friend', '现在的话'), { ...obs('g', 'friend', '单条标的回填'), historical: true }]);
  const rows = t.rows();
  assert.deepEqual(rows.map((p) => p.historical), [1, 0, 1]);
  const notified = (t.calls['retrieve.onPercepts'] ?? []).flatMap(([, list]) => list.map((p) => p.text));
  assert.deepEqual(notified, ['现在的话']);
  // 回填同一条：幂等
  assert.equal(ingest(t, [old], { historical: true }).duplicates, 1);
}));

test('提交后的通知：retrieve.onPercepts 按场合给新行；她自己的发言给 discretion.onSelfUtterance', () => withIntake((t) => {
  ingest(t, [
    obs('g', 'friend', '在吗', { addressed: 'to-her' }),
    obs('g', 'her', '在的'),
    obs('h', 'other', '另一个群'),
  ]);
  const byKey = new Map((t.calls['retrieve.onPercepts'] ?? []).map(([key, list]) => [key, list.map((p) => p.text)]));
  assert.deepEqual(byKey.get(t.key('g')), ['在吗', '在的']);
  assert.deepEqual(byKey.get(t.key('h')), ['另一个群']);
  const selfCalls = t.calls['discretion.onSelfUtterance'] ?? [];
  assert.equal(selfCalls.length, 1);
  assert.equal(selfCalls[0][0].text, '在的');
  assert.equal(selfCalls[0][0].actor_self, 1);
  assert.equal(selfCalls[0][0].actor_entity_id, SELF_ID);
}, { settings: { g: descriptor('g'), h: descriptor('h') } }));

test('富化步骤出错只降级：认不出人、注意力、出现集合失败，原话照样入库', () => withIntake((t) => {
  const r = ingest(t, [obs('g', 'friend', '照样记下来')]);
  assert.equal(r.accepted, 1);
  const [p] = t.rows();
  assert.equal(p.actor_entity_id, null);
  assert.equal(p.presence_set_id, null);
  assert.equal(p.attention_class, 'unclassified');
  assert.equal(p.w_enc, 0);
  assert.ok(metric(t.core, 'intake.degraded.resolveActor') >= 1);
  assert.ok(metric(t.core, 'intake.degraded.presence') >= 1);
  assert.ok(ftsSearch(t.core.store, p.fts_shard, ['记下']).length === 1);
}, { throwOn: new Set(['entities.resolveActor', 'dynamics.attentionClass', 'discretion.recordPresence']) }));

test('注意力：她最近 10 分钟在这个场合说过话 → 在参与的对话；关系亲密度进编码强度', () => withIntake((t) => {
  ingest(t, [obs('g', 'her', '我也觉得', { at: T0 })]);
  ingest(t, [obs('g', 'friend', '对吧', { at: T0 + 5 * M }), obs('g', 'principal', '嗯', { at: T0 + 30 * M })]);
  const [, a, b] = t.rows();
  assert.equal(a.attention_class, 'participating');
  assert.equal(b.attention_class, 'attendedAmbient');
  assert.ok(b.w_enc > 0.6);   // 主人亲密度最高（替身 closeness=1）
  const ac = t.calls['dynamics.attentionClass'].map(([p, ctx]) => ctx.herSpokeRecently);
  assert.deepEqual(ac, [false, true, false]);
}));

test('visibleTo、evidential、forwarded、standing 原样保留；转发的作者和转发者只存哈希', () => withIntake((t) => {
  ingest(t, [
    obs('g', 'friend', '[拍了拍]', { kind: 'action', evidential: false }),
    obs('g', 'friend', '转发：某某说明天放假', {
      forwarded: { claimedAuthor: people.stranger, relayedBy: people.friend, authorVerified: false }, standing: 'material',
    }),
  ]);
  const [a, b] = t.rows();
  assert.equal(a.evidential, 0);
  assert.equal(b.standing, 'material');
  const fwd = JSON.parse(b.forwarded_json);
  assert.equal(fwd.authorVerified, false);
  assert.ok(fwd.relayedBy.claims[0].idHash);
  assert.ok(!b.forwarded_json.includes('ustrange01') && !b.forwarded_json.includes('ufriend001'));
}));

test('D118：转发人认成实体，存进 forwarded_json.relayedById（role=relay）；不知道是谁转的不记；同一份再读到时才认出来的补上', () => withIntake((t) => {
  ingest(t, [
    obs('g', 'stranger', '主人转来的：晚上八点提醒我', { id: 'fw-1', kind: 'content', actor: { claims: [] },
      forwarded: { claimedAuthor: people.principal, relayedBy: people.principal, authorVerified: false }, standing: 'material' }),
    obs('g', 'stranger', '群友转来的一段', { id: 'fw-2', kind: 'content', actor: { claims: [] },
      forwarded: { relayedBy: people.friend, authorVerified: false }, standing: 'material' }),
    obs('g', 'stranger', '不知道谁转的', { id: 'fw-3', kind: 'content', actor: { claims: [] },
      forwarded: { relayedBy: { claims: [] }, authorVerified: false }, standing: 'material' }),
  ]);
  const [a, b, c] = t.rows();
  const relay = t.calls['entities.resolveActor'].filter(([, ctx]) => ctx?.role === 'relay');
  assert.equal(relay.length, 2, '只有带着证据的转发人才去认');
  assert.equal(JSON.parse(a.forwarded_json).relayedById, PRINCIPAL_ID);
  assert.equal(JSON.parse(b.forwarded_json).relayedById, 10);
  assert.equal(JSON.parse(c.forwarded_json).relayedById, undefined);
  assert.equal(a.actor_entity_id, null, '转发人不会因此变成内容的说话人');
  assert.equal(JSON.parse(a.forwarded_json).authorVerified, false);
  // 同一份转发第一次读时不知道是谁转的，再读一次（适配器认出来了）：补上
  ingest(t, [obs('g', 'stranger', '不知道谁转的', { id: 'fw-3', kind: 'content', actor: { claims: [] },
    forwarded: { relayedBy: people.friend, authorVerified: false }, standing: 'material' })]);
  const c2 = t.rows().find((r) => r.id === c.id);
  assert.equal(JSON.parse(c2.forwarded_json).relayedById, 10);
  assert.ok(JSON.parse(c2.forwarded_json).relayedBy.claims[0].idHash);
  assert.ok(!c2.forwarded_json.includes('ufriend001'));
}));

test('第 6 步：出现集合按 visibleTo——私下读到的只有她；一对一给 exact；群里是她 + 说话人 + 最近说过话的人', () => withIntake((t) => {
  ingest(t, [obs('g', 'other', '先说一句', { at: T0 })]);
  ingest(t, [obs('g', 'friend', '群里的话', { at: T0 + M })]);
  ingest(t, [obs('dm', 'principal', '私聊', { visibleTo: 'participants', at: T0 + 2 * M })]);
  ingest(t, [obs('g', 'friend', '她私下读到的', { kind: 'content', visibleTo: 'her-only', perceivedInSettingId: sid('dm'), at: T0 + 3 * M })]);
  const ps = t.calls['discretion.recordPresence'].map(([p]) => p);
  const group = ps[1];
  assert.equal(group.settingKey, t.key('g'));
  assert.deepEqual([...group.members].sort(), [SELF_ID, 10, 11].sort());
  assert.equal(group.completeness, 'recent-speakers');
  assert.equal(group.unknownObservers, false);
  const dm = ps[2];
  assert.deepEqual(dm.members, [SELF_ID, PRINCIPAL_ID]);
  assert.equal(dm.completeness, 'exact');
  const her = ps[3];
  assert.deepEqual(her.members, [SELF_ID]);
  assert.equal(her.settingKey, t.key('dm'));   // 记在她知道的那个场合，不加那里的成员
  assert.equal(her.completeness, 'exact');
  const [, , , p] = t.rows();
  assert.equal(p.visible_to, 'her-only');
  assert.equal(p.setting_key, t.key('g'));
  assert.equal(p.perceived_in, t.key('dm'));
}, { settings: { g: descriptor('g'), dm: oneOnOne('dm') } }));

test('一对一：她隔了很久先开口，出现集合照样是她和对方两个人（exact）', () => withIntake((t) => {
  ingest(t, [obs('dm', 'principal', '晚安', { visibleTo: 'participants', at: T0 })]);
  t.clock.advance(5 * 60 * M);
  ingest(t, [obs('dm', 'her', '早上好呀', { at: T0 + 5 * 60 * M })]);
  ingest(t, [obs('dm', 'her', '在吗', { visibleTo: 'participants', at: T0 + 5 * 60 * M + M })]);
  const ps = t.calls['discretion.recordPresence'].map(([p]) => p);
  for (const p of ps) {
    assert.deepEqual([...p.members].sort(), [SELF_ID, PRINCIPAL_ID].sort());
    assert.equal(p.completeness, 'exact');
  }
}, { settings: { dm: oneOnOne('dm') } }));

test('drain 一次最多占用 drainBudgetMs，做不完的让出事件循环再接着做（至少做一批）', async () => {
  const base = (await import('../../src/config/defaults.js')).createConfig({ time: { tzOffsetMin: 480 } });
  const handle = { ...base, get: () => ({ ...base.get(), intake: { ...base.get().intake, drainBudgetMs: -1 } }) };
  await withIntake(async (t) => {
    for (let i = 0; i < 3; i++) t.observe([obs('g', 'friend', `批${i}`)]);
    const r = t.drain();
    assert.equal(r.accepted, 1);
    assert.equal(r.waiting, 2);
    for (let i = 0; i < 5 && t.rows().length < 3; i++) await new Promise((res) => setImmediate(res));
    assert.equal(t.rows().length, 3);
  }, { configHandle: handle });
});

test('提到的人：结构化的 @ 给档案加「又被提到」；实体词元进 FTS（说话人和被提到的）', () => withIntake((t) => {
  ingest(t, [obs('g', 'friend', '@小红 明天见', { mentions: [people.other] })]);
  const [p] = t.rows();
  const mentions = JSON.parse(p.mentions_json);
  assert.equal(mentions[0].entityId, 11);
  assert.ok(!p.mentions_json.includes('uother0001'));
  const [eid, m] = t.calls['entities.noteMention'][0];
  assert.equal(eid, 11);
  assert.equal(m.at, p.at);
  assert.equal(m.sourceKey, 'n10');   // 来源 = 说这句话的人
  assert.deepEqual(ftsSearch(t.core.store, p.fts_shard, ['ent_11']).map((h) => h.rowid), [p.id]);
  assert.deepEqual(ftsSearch(t.core.store, p.fts_shard, ['ent_10']).map((h) => h.rowid), [p.id]);
}));

test('媒体只留占位和摘要（ref 不入库）；引用的摘录清洗后入库并可检索', () => withIntake((t) => {
  ingest(t, [obs('g', 'friend', '看图', {
    media: [{ kind: 'image', summary: '一只橘猫趴在键盘上', ref: 'https://cdn.example.com/a.jpg?token=abcdef' }],
    quote: { obs: 'm-older', excerpt: '昨天说的那家火锅店' },
  })]);
  const [p] = t.rows();
  const media = JSON.parse(p.media_json);
  assert.deepEqual(media, [{ kind: 'image', summary: '一只橘猫趴在键盘上' }]);
  const quote = JSON.parse(p.quote_json);
  assert.equal(quote.excerpt, '昨天说的那家火锅店');
  assert.equal(quote.obsKey, t.core.keys.obsKey(ADAPTER, 'm-older'));
  const q = t.core.mods.lang.queryTerms(t.core, '橘猫');
  assert.equal(ftsSearch(t.core.store, p.fts_shard, q).length, 1);
  assert.equal(ftsSearch(t.core.store, p.fts_shard, t.core.mods.lang.queryTerms(t.core, '火锅')).length, 1);
}));

test('adapter 给了 lang 就用它（随机标签也照存，分词退回 und）；没给就检测', () => withIntake((t) => {
  ingest(t, [obs('g', 'friend', 'nqvx 你好', { lang: 'x-qwzt' }), obs('g', 'friend', 'hello there')]);
  const [a, b] = t.rows();
  assert.equal(a.lang, 'x-qwzt');
  assert.equal(b.lang, 'und');
  assert.equal(ftsSearch(t.core.store, a.fts_shard, ['nqvx']).length, 1);
}));
