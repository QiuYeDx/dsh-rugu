// 冒烟：假平台（随机命名空间、随机场合属性、随机语言标签）+ .tmp 下的临时库跑迁移 + 感知过契约。
// 失败时看输出里的 seed，用 FAKE_PLATFORM_SEED=<seed> 复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createFakePlatform } from './fixtures/fake-platform.js';
import {
  validateObservation, validateObservations, validateSettingDescriptor, validatePerceptionAdapter, settingIdLeaksAccount,
  exposureRank, isPublicLike, isOneOnOne, reachHash,
} from '../src/contract/index.js';
import { openStore, checkSchema, MIGRATIONS, SCHEMA_VERSION, ensurePerceptShard, ftsInsert, ftsSearch, makeKeyring, loadOrCreateKey } from '../src/store/index.js';
import { createPersonaMemory } from '../src/index.js';
import { fakePorts } from './fakes/index.js';
import { tmpDir, rmDir, REPO_ROOT } from './helpers.js';

const KNOWN_ADAPTER_IDS = ['qq', 'web', 'dsh-web', 'bili', 'bilibili', 'wechat', 'discord'];

test('假平台：迁移 + 场合描述 + 感知过契约', async (t) => {
  const fp = createFakePlatform();
  t.diagnostic(`fake-platform seed=${fp.seed} namespace=${fp.namespace} lang=${fp.lang}`);
  const dir = tmpDir('smoke');
  assert.ok(path.resolve(dir).startsWith(path.join(REPO_ROOT, '.tmp')), '临时文件在仓库的 .tmp 下');
  try {
    // 1. 迁移
    const store = await openStore({ file: path.join(dir, 'persona-memory.db') });
    try {
      assert.equal(store.migration.to, SCHEMA_VERSION);
      assert.equal(checkSchema(store, MIGRATIONS).ok, true);

      // 2. 适配器和场合描述
      assert.equal(validatePerceptionAdapter(fp.adapter).ok, true);
      assert.ok(!KNOWN_ADAPTER_IDS.includes(fp.namespace), '假平台的命名空间是随机的，不是任何真实入口');
      const accounts = Object.values(fp.people).flatMap((p) => p.actor.claims);
      for (const [name, s] of Object.entries(fp.settings)) {
        const r = validateSettingDescriptor(fp.adapter.describeSetting(s.id));
        assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.errors)}`);
        assert.equal(settingIdLeaksAccount(s.id, accounts), false, `${name} 的 SettingId 不含账号原值（§4.2）`);
      }
      // 核心只按属性推理：五类场合的公开程度由属性决定，和名字无关
      const d = (k) => validateSettingDescriptor(fp.settings[k].descriptor).value;
      assert.equal(isOneOnOne(d('oneOnOne')), true);
      assert.equal(exposureRank(d('oneOnOne')), 0);
      assert.equal(exposureRank(d('publicSpace')), 3);
      assert.equal(isPublicLike(d('publicSpace')), true);
      assert.equal(exposureRank(d('bigGroup')), 2);
      assert.ok(exposureRank(d('workGroup')) <= 1);
      assert.notEqual(reachHash(d('workGroup')), reachHash(d('publicSpace')));

      // 3. 感知过契约
      const batch = [
        fp.obs('workGroup', 'other', '下季度要裁员'),
        fp.obs('smallGroup', 'friend', '我表哥开网约车，前两天还被投诉了', { addressed: 'to-her', attention: 'attended' }),
        fp.obs('smallGroup', 'principal', '今晚又要加班', { addressed: 'ambient', attention: 'peripheral' }),
        fp.obs('oneOnOne', 'principal', '等下去拿快递', { addressed: 'to-her', attention: 'attended' }),
        fp.obs('oneOnOne', 'her', '好，拿到跟我说一声'),
        fp.obs('smallGroup', 'her', '阿明今天好像很烦', { kind: 'self-thought', visibleTo: 'her-only' }),
        fp.obs('publicSpace', 'stranger', '视频里讲了新版本的玩法', { kind: 'content', standing: 'material', visibleTo: 'her-only', addressed: 'ambient' }),
      ];
      const { accepted, rejected } = validateObservations(batch);
      assert.equal(rejected.length, 0, JSON.stringify(rejected));
      assert.equal(accepted.length, batch.length);
      for (const o of accepted) assert.equal(o.lang, fp.lang, '随机语言标签原样保留（核心以后退回 Unicode 分析器）');

      // 平台夹带的字段被丢掉；自相矛盾的被拒
      const smuggled = validateObservation({ ...batch[1], agentToken: 'should-not-pass', platformMsg: { raw: 1 } });
      assert.equal(smuggled.ok, true);
      assert.ok(!('agentToken' in smuggled.value) && !('platformMsg' in smuggled.value));
      assert.equal(validateObservation({ ...batch[1], actor: fp.people.her.actor }).ok, false, '她说的话不能是 utterance');
      assert.equal(validateObservation({ ...batch[5], visibleTo: 'setting-audience' }).ok, false, '心里想的只有她自己看得到');

      // 4. 存储键和 FTS 在随机命名空间下照常工作
      const keys = makeKeyring(loadOrCreateKey(path.join(dir, 'persona-memory.key')));
      const k1 = keys.settingKey(fp.namespace, fp.settings.smallGroup.id);
      assert.notEqual(k1, keys.settingKey(fp.namespace, fp.settings.bigGroup.id));
      assert.ok(!k1.includes(fp.namespace));
      const shard = ensurePerceptShard(store, accepted[1].at);
      ftsInsert(store, shard, 1, ['表哥', '网约', '约车', '投诉']);
      assert.deepEqual(ftsSearch(store, shard, ['表哥']).map((r) => r.rowid), [1]);
    } finally { store.close(); }

    // 5. 整个核心能在这个目录上开起来（模块还没实现：启动步骤降级，不影响打开）
    const pm = await createPersonaMemory({ dataDir: dir, ports: fakePorts(), startWorker: false });
    try {
      assert.equal(pm.status().schema.ok, true);
      assert.equal(pm.status().migration.applied.length, 0, '同一个库不再迁移');
    } finally { await pm.close(); }
    assert.ok(fs.existsSync(path.join(dir, 'persona-vectors.db')), '向量缓存库建好了');
  } finally { rmDir(dir); }
});

test('假平台的 members() 和真实适配器一样：不比 audience.size 多出人来；一对一就是她和对方；主人在名单里；在群里说过话的人是成员', async (t) => {
  // §14.2「假平台」+ §5.6 出现集合：一对一多列出一个人，那个人就成了「新知情者」，主人自己在私聊里说的事在这个私聊里也过不了 A1
  for (const seed of [1, 7, 42, 12345, 2 ** 31 - 1]) {
    const fp = createFakePlatform({ seed });
    const ids = (list) => (list ?? []).map((a) => a.claims.find((c) => c.kind === 'account').id).sort();
    const idOf = (k) => fp.people[k].actor.claims.find((c) => c.kind === 'account').id;
    for (const [name, s] of Object.entries(fp.settings)) {
      const a = s.descriptor.audience;
      const m = await fp.adapter.members(s.id);
      if (a.membersKnown !== 'exact') { assert.equal(m, null, `seed=${seed} ${name}：列不全成员的场合不给名单`); continue; }
      assert.ok(Array.isArray(m) && m.length <= a.size, `seed=${seed} ${name}：audience.size=${a.size}，members() 给了 ${m?.length} 个人`);
      assert.ok(ids(m).includes(idOf('her')), `seed=${seed} ${name}：她在名单里`);
      const owner = s.descriptor.ownership.owner;
      if (owner && typeof owner === 'object') assert.ok(ids(m).includes(owner.claims[0].id), `seed=${seed} ${name}：场合的主人在名单里`);
    }
    assert.deepEqual(ids(await fp.adapter.members(fp.settings.oneOnOne.id)), [idOf('her'), idOf('principal')].sort(), `seed=${seed}：一对一就是她和主人`);
    // 一对一满了：别人的话不会把名单撑大（真实平台上也不会有第三个人在一对一里说话）
    fp.obs('oneOnOne', 'friend', '串门');
    assert.equal((await fp.adapter.members(fp.settings.oneOnOne.id)).length, 2);
    // 能列全成员的群：在群里亲自说过话的人在名单里；她私下读到的材料的作者不算
    const g = fp.settings.smallGroup;
    if (g.descriptor.audience.membersKnown === 'exact') {
      fp.obs('smallGroup', 'stranger', '视频里讲的', { kind: 'content', standing: 'material', visibleTo: 'her-only', addressed: 'ambient' });
      assert.ok(!fp.memberKeys('smallGroup').includes('stranger'), `seed=${seed}：她私下读到的材料，作者不在场`);
      fp.obs('smallGroup', 'other', '大家好');
      const keys = fp.memberKeys('smallGroup');
      // 起始名单是她、主人、朋友（群主是两人之一）：只有三个人的群已经满了
      assert.equal(keys.includes('other'), g.descriptor.audience.size > 3, `seed=${seed}：说过话的人补进名单（满了不补）`);
      assert.ok(keys.length <= g.descriptor.audience.size);
    }
  }
  t.diagnostic('members() 按场合给名单');
});

test('假平台：同一个种子得到同样的平台', () => {
  const a = createFakePlatform({ seed: 12345 });
  const b = createFakePlatform({ seed: 12345 });
  assert.equal(a.namespace, b.namespace);
  assert.equal(a.lang, b.lang);
  assert.deepEqual(a.settings.smallGroup.descriptor.audience, b.settings.smallGroup.descriptor.audience);
  assert.notEqual(createFakePlatform({ seed: 54321 }).namespace, a.namespace);
});
