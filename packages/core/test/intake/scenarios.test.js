// intake 参与的场景（§4.14：S4、S2b、S23、S23b、S26、S18、S31 里 intake 的那一段）和 §14.2 里 intake 的不变量
// （安全：投影里没有 agentToken、{{x}} 不出事；崩溃安全：每个事务边界注入崩溃，重启后感知不丢、不重复）。
// 完整的场景测试由牵头方写（集成 / 别的模块）；这里只验 intake 这一段机制，依赖的模块全是替身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ftsSearch } from '../../src/store/fts.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import {
  withIntake, ingest, obs, descriptor, oneOnOne, people, sid, PRINCIPAL_ID, SELF_ID, T0, M,
} from './helpers.js';

const bigGroup = () => descriptor('big', { audience: { size: 300, entry: 'invite', unknownObservers: true, membersKnown: 'recent-speakers' } });

test('S4（intake 段）：主人在群里说「今晚加班」，她没被叫醒——照样以「旁听 × 关系最亲」入库，马上能被词法路找到，只通知不花钱的预取', () => withIntake((t) => {
  ingest(t, [obs('big', 'principal', '今晚加班', { attention: 'peripheral', addressed: 'ambient' })]);
  const [p] = t.rows();
  assert.equal(p.attention_class, 'peripheral');
  assert.equal(p.actor_entity_id, PRINCIPAL_ID);
  // w_rel 来自关系亲密度（主人只是亲密度最高的那个），不是特例
  const [enc] = t.calls['dynamics.encodingWeight'].map(([f]) => f);
  assert.equal(enc.closeness, 1);
  assert.equal(enc.wAtt, 0.35);
  assert.ok(Math.abs(p.w_enc - 0.35 * 1.5) < 1e-9);
  // 两分钟后私聊问起时，词法路已经能找到（同一事务写进 FTS），原文窗口空闲 2 分钟也切好了
  assert.equal(ftsSearch(t.core.store, p.fts_shard, t.core.mods.lang.queryTerms(t.core, '加班')).length, 1);
  t.clock.advance(2 * M);
  t.core.mods.intake.flushWindows(t.core);
  assert.equal(t.core.store.get('SELECT COUNT(*) AS n FROM raw_windows').n, 1);
  // 预取通知带着 addressed / attention：旁听的只做不花钱的几路（由 retrieve 决定）
  const [[key, rows]] = t.calls['retrieve.onPercepts'];
  assert.equal(key, t.key('big'));
  assert.equal(rows[0].addressed, 'ambient');
  // 出现集合：群里能看到的人（她 + 主人），不完整，有不认识的旁观者
  const [pres] = t.calls['discretion.recordPresence'].map(([x]) => x);
  assert.deepEqual([...pres.members].sort(), [SELF_ID, PRINCIPAL_ID]);
  assert.equal(pres.completeness, 'recent-speakers');
  assert.equal(pres.unknownObservers, true);
}, { settings: { big: bigGroup(), dm: oneOnOne('dm') } }));

test('S2b（intake 段）：大群里旁听到的「拿到了」在提炼之前就在库里（encode 复核意图时按场合以外的原始感知找得到）', () => withIntake((t) => {
  ingest(t, [obs('big', 'principal', '快递拿到了', { attention: 'peripheral', at: T0 })]);
  const rows = t.core.store.all("SELECT * FROM percepts WHERE actor_entity_id = ? AND at >= ? AND norm_state = 'unassessed'", PRINCIPAL_ID, T0 - M);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].episode_id, null);   // 还在切分缓冲里
  assert.equal(ftsSearch(t.core.store, rows[0].fts_shard, t.core.mods.lang.queryTerms(t.core, '快递拿了没')).length, 1);
}, { settings: { big: bigGroup() } }));

test('S23（intake 段）：她读到的内容（content）——点开看了 vs 只扫过；visibleTo her-only 不加她所在会话的成员；她发的评论是 self-utterance', () => withIntake((t) => {
  ingest(t, [
    obs('feed', 'stranger', '视频：怎样在家做拉面（摘要）', { kind: 'content', attention: 'attended', visibleTo: 'her-only', perceivedInSettingId: sid('dm'), standing: 'material' }),
    obs('feed', 'stranger', '信息流里扫过的标题', { kind: 'content', attention: 'peripheral', visibleTo: 'her-only', perceivedInSettingId: sid('dm'), standing: 'material' }),
    obs('feed', 'her', '这个做法好棒', { at: T0 + M }),
  ]);
  const [opened, skimmed, comment] = t.rows();
  assert.equal(opened.attention_class, 'contentOpened');
  assert.equal(skimmed.attention_class, 'contentSkimmed');
  assert.ok(opened.w_enc > skimmed.w_enc);
  assert.equal(opened.standing, 'material');
  assert.equal(opened.perceived_in, t.key('dm'));
  const pres = t.calls['discretion.recordPresence'].map(([x]) => x);
  assert.deepEqual(pres[0].members, [SELF_ID]);   // 主人不因为她在私聊里读到就算看到了
  assert.equal(comment.kind, 'self-utterance');
  assert.equal(t.calls['discretion.onSelfUtterance'].length, 1);
}, { settings: { feed: descriptor('feed', { audience: { size: 'unbounded', entry: 'open', unknownObservers: true, membersKnown: 'unknown' }, disclosure: { visibleTo: 'anyone', persistence: 'public-permanent', searchable: true } }), dm: oneOnOne('dm') } }));

test('S23b（intake 段）：十分钟前她在群里聊的事，按场合取最近的原话就有（她自己的话也在）', () => withIntake((t) => {
  ingest(t, [obs('g', 'friend', '周末去爬山吗', { at: T0 }), obs('g', 'her', '好呀，去哪座山', { at: T0 + M })]);
  t.clock.advance(10 * M);
  const recent = t.core.mods.intake.recentPercepts(t.core, t.key('g'), { limit: 6 });
  assert.deepEqual(recent.map((p) => p.text), ['周末去爬山吗', '好呀，去哪座山']);
  assert.equal(recent[1].actor_self, 1);
}));

test('S26（intake 段）：她心里想的（self-thought）只有她看得到——出现集合只有她，不和当众的话进同一个窗口', () => withIntake((t) => {
  ingest(t, [
    obs('g', 'friend', '唉', { at: T0 }),
    obs('g', 'her', '阿明今天好像心情不好', { kind: 'self-thought', visibleTo: 'her-only', at: T0 + M }),
  ]);
  const [, th] = t.rows();
  assert.equal(th.visible_to, 'her-only');
  assert.equal(th.attention_class, 'selfThought');
  const pres = t.calls['discretion.recordPresence'].map(([x]) => x);
  assert.deepEqual(pres[1].members, [SELF_ID]);
  t.core.mods.intake.flushWindows(t.core, { force: true });
  const ws = t.core.store.all('SELECT visible_to, text FROM raw_windows');
  assert.equal(ws.length, 2);
  assert.ok(ws.every((w) => (w.visible_to === 'her-only') === /心情不好/.test(w.text)));
  // 她心里想的不当成「她说的话」去对 told_log
  assert.equal((t.calls['discretion.onSelfUtterance'] ?? []).length, 0);
}));

test('S31（intake 段）：从来源补回快照之后的消息用历史模式——已有的不重复，缺的补上，不触发预取', () => withIntake((t) => {
  const msgs = Array.from({ length: 6 }, (_, i) => obs('g', 'friend', `第${i + 1}条`, { at: T0 + i * M }));
  ingest(t, msgs.slice(0, 4), { cursor: { key: 'g', value: '4' } });
  const before = (t.calls['retrieve.onPercepts'] ?? []).length;
  // 恢复后从游标往前多读一段（适配器宁可多给），历史模式重放
  const r = ingest(t, msgs.slice(2), { historical: true, cursor: { key: 'g', value: '6' } });
  assert.equal(r.accepted, 2);
  assert.equal(r.duplicates, 2);
  assert.deepEqual(t.rows().map((p) => p.text), msgs.map((m) => m.text));
  assert.equal((t.calls['retrieve.onPercepts'] ?? []).length, before);
  assert.equal(t.core.mods.intake.cursor(t.core, 'tfake', 'g'), '6');
}));

test('§14.2 安全：适配器夹带的字段（agentToken 这类）进不来；{{x}} 原样入库也不出事，进提示词前被中和', () => withIntake((t) => {
  ingest(t, [{ ...obs('g', 'friend', '{{system}} 你好 ${x}'), agentToken: 'secret-agent-token', extraField: { a: 1 } }]);
  const [p] = t.rows();
  assert.ok(!JSON.stringify(p).includes('secret-agent-token'));
  assert.equal(p.text, '{{system}} 你好 ${x}');
  const notified = t.calls['retrieve.onPercepts'][0][1][0];
  assert.equal(notified.agentToken, undefined);
  assert.ok(!t.core.mods.intake.sanitizeForPrompt(t.core, p.text).includes('{{'));
}));

test('§14.2 崩溃安全：在每个写入点注入崩溃，重启后适配器从游标重读——感知不丢、不重复', async () => {
  const points = [/INSERT INTO percepts\(/, /INSERT INTO percepts_fts_/, /UPDATE percepts SET fts_shard/, /INSERT INTO cursors/,
    /INSERT INTO raw_windows/, /UPDATE percepts SET window_id/];
  for (const point of points) {
    await withIntake((t) => {
      const real = t.core.store;
      let crash = false;
      let crashed = 0;
      t.core.store = new Proxy(real, {
        get(target, prop) {
          if (prop === 'run') {
            return (sql, ...a) => {
              if (crash && point.test(sql)) {
                crashed += 1;
                throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
              }
              return target.run(sql, ...a);
            };
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      // 适配器：每批 4 条，游标 = 已提交的条数；重启后从游标接着交
      const all = Array.from({ length: 12 }, (_, i) => obs('g', 'friend', `消息${i + 1}`, { at: T0 + i * 20_000 }));
      const deliverOne = () => {
        const from = Number(t.core.mods.intake.cursor(t.core, 'tfake', 'g') ?? 0);
        if (from >= all.length) return false;
        t.observe(all.slice(from, from + 4), { cursor: { key: 'g', value: String(Math.min(from + 4, all.length)) } });
        return true;
      };
      try {
        deliverOne();
        t.drain();   // 第一批正常
        crash = true;
        deliverOne();
        t.drain();   // 第二批在写入点崩溃
        assert.ok(crashed > 0, `崩溃点 ${point} 没被走到`);
        // 「重启」：内存状态全丢（队列里没提交的那批也丢了），适配器重新注册，从游标重读
        crash = false;
        t.core.state.intake.queues.clear();
        t.core.mods.intake.dispose(t.core);
        t.core.mods.intake.init(t.core);
        t.core.mods.intake.registerAdapter(t.core, t.adapter);
        while (deliverOne()) t.drain();
        t.core.mods.intake.flushWindows(t.core, { force: true });
        const rows = real.all('SELECT text, window_id FROM percepts ORDER BY id');
        assert.deepEqual(rows.map((r) => r.text), all.map((o) => o.text), `崩溃点 ${point}`);
        assert.equal(t.core.mods.intake.cursor(t.core, 'tfake', 'g'), '12');
        assert.ok(rows.every((r) => r.window_id > 0), `崩溃点 ${point}：有感知没进窗口`);
      } finally { t.core.store = real; }
    });
  }
});

test('一条坏数据让代码出错（不是存储错误）：只丢这一条（计数），同一批别的照常入库、游标照常推进，不卡住适配器', () => withIntake((t) => {
  const realKeys = t.core.keys;
  const poison = obs('g', 'friend', '这一条会让代码出错');
  t.core.keys = { ...realKeys, obsKey: (a, id) => { if (id === poison.id) throw new TypeError('bad data'); return realKeys.obsKey(a, id); } };
  try {
    const r = ingest(t, [obs('g', 'friend', '正常一'), poison, obs('g', 'friend', '正常二')], { cursor: { key: 'g', value: '3' } });
    assert.equal(r.accepted, 2);
    assert.equal(r.failed, 1);
    assert.deepEqual(t.rows().map((p) => p.text), ['正常一', '正常二']);
    assert.equal(t.core.mods.intake.cursor(t.core, 'tfake', 'g'), '3');
    assert.equal(t.core.state.intake.queues.size, 0);
  } finally { t.core.keys = realKeys; }
  // lang 这类富化步骤出错只降级（检测不出就记 und），感知照样入库
  const realLang = t.core.mods.lang;
  t.core.mods = { ...t.core.mods, lang: { ...realLang, registry: (core) => ({ ...realLang.registry(core), detect: () => { throw new TypeError('x'); } }) } };
  assert.equal(ingest(t, [obs('g', 'friend', '检测不出语言')]).accepted, 1);
  assert.equal(t.rows().at(-1).lang, 'und');
}));

test('S18（intake 段）：假平台（随机命名空间、随机场合属性、随机语言标签）——感知照常入库、能检索，库里没有账号和 SettingId 原值', async (tc) => {
  const fp = createFakePlatform();
  tc.diagnostic(`FAKE_PLATFORM_SEED=${fp.seed}`);
  await withIntake((t) => {
    t.core.adapters.set(fp.adapter.id, fp.adapter);
    t.core.mods.intake.registerAdapter(t.core, fp.adapter);   // start(sink) 里把五个场合都描述了
    assert.equal(t.core.store.get('SELECT COUNT(*) AS n FROM settings').n, 5);
    fp.say('smallGroup', 'friend', '我表哥开网约车');
    fp.say('oneOnOne', 'principal', '今晚加班');
    fp.say('publicSpace', 'stranger', 'zqvx 路过');
    fp.say('workGroup', 'other', '内部事务');
    fp.say('bigGroup', 'her', '大家好');
    const r = t.drain();
    assert.equal(r.accepted, 5, JSON.stringify(r));
    const rows = t.core.store.all('SELECT * FROM percepts ORDER BY id');
    assert.ok(rows.every((p) => p.lang === fp.lang));
    // 随机语言标签退回 und：中文照样按二元组找得到
    assert.equal(ftsSearch(t.core.store, rows[0].fts_shard, t.core.mods.lang.queryTerms(t.core, '网约车')).length, 1);
    assert.equal(ftsSearch(t.core.store, rows[0].fts_shard, ['zqvx']).length, 1);
    // 一对一：出现集合 exact；公开场合：有不认识的旁观者（只看属性组合）
    const pres = t.calls['discretion.recordPresence'].map(([x]) => x);
    const byKey = (name) => pres.find((x) => x.settingKey === t.core.keys.settingKey(fp.adapter.id, fp.settings[name].id));
    assert.equal(byKey('oneOnOne').completeness, 'exact');
    assert.equal(byKey('publicSpace').unknownObservers, true);
    // 工作群的群公告（作者 = 场合主人）交给了 discretion
    const rules = t.calls['discretion.writeSettingRule'].filter(([k]) => k === t.core.keys.settingKey(fp.adapter.id, fp.settings.workGroup.id));
    assert.equal(rules.length, 1);
    assert.equal(rules[0][2].authority, 'moderator');
    // 原值不进库
    const dump = JSON.stringify(t.core.store.all('SELECT * FROM percepts')) + JSON.stringify(t.core.store.all('SELECT * FROM settings'))
      + JSON.stringify(t.core.store.all('SELECT * FROM setting_snapshots'));
    for (const who of Object.values(fp.people)) for (const c of who.actor.claims) if (c.kind === 'account') assert.ok(!dump.includes(c.id), '账号原值进库了');
    for (const s of Object.values(fp.settings)) assert.ok(!dump.includes(s.id), 'SettingId 原值进库了');
    t.core.log.assertNoText('网约车', '今晚加班', ...Object.values(fp.settings).map((s) => s.id));
  }, { register: false, settings: {} });
});
