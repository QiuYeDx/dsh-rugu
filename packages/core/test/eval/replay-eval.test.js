// 回放评测（D152，scripts/replay-eval.mjs）的自测：不依赖真实数据。用假平台在临时库里造几句话，写几个合成用例，
// 整条命令跑一遍（子进程，和人在命令行上跑的一样；不碰 Ollama：--embed off），看：
//   - 拨回：那一刻之后才入库的话在那一刻不存在（用例里写了它就报「那一刻还不在库里」）、不会出现在那一块里；之后的那一刻又在；
//   - 判定：该有的命中、排第几、哪一层；摘要里没有原文（原文只在 detail/ 里）；
//   - 防漏：库里有没登记的表就拒绝跑（退出码 3）；
//   - compare 能把两次的摘要排成两列。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createPersonaMemory } from '../../src/index.js';
import { fakePorts, FakeLLM, FakeClock } from '../fakes/index.js';
import { createFakePlatform } from '../fixtures/fake-platform.js';
import { REPO_ROOT, tmpDir, rmDir } from '../helpers.js';

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'replay-eval.mjs');
const MIN = 60_000;
const tick = () => new Promise((r) => { setImmediate(r); });

function run(args) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000 });
}

/** 一个小库：一对一里主人说要去一个地方出差，过一阵改口去另一个地方，中间夹几句闲话。 */
async function buildWorld(dir) {
  const fp = createFakePlatform({ seed: 1152 });
  const clock = new FakeClock(fp.now());
  const llm = new FakeLLM({ fallback: { glance: () => [] } });
  const dataDir = path.join(dir, 'db');
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dir, 'identity.key');
  fs.writeFileSync(keyFile, `${crypto.createHash('sha256').update('replay-eval-selftest').digest().toString('base64')}\n`);
  const pm = await createPersonaMemory({ dataDir, keyFile, ports: fakePorts({ clock, llm }), startWorker: false,
    config: { time: { tzOffsetMin: 480 }, mode: { byAttributes: { closed: 'live', public: 'live' } } } });
  const core = pm._core;
  pm.registerAdapter(fp.adapter);
  const flush = async () => {
    await tick();
    for (let i = 0; i < 50; i++) {
      core.mods.intake.drain(core);
      await tick();
      if (![...(core.state.intake?.queues?.values() ?? [])].some((q) => q.length)) break;
    }
  };
  const say = async (who, text, gap = 10 * MIN, where = 'oneOnOne') => {
    const at = clock.now();
    const o = fp.say(where, who, text, { at, perceivedAt: at, ...(who === 'her' ? {} : where === 'oneOnOne' ? { addressed: 'to-her', attention: 'attended' } : { addressed: 'mentions-her', attention: 'attended' }) });
    await flush();
    clock.advance(gap);
    return core.store.get('SELECT id, created_at FROM percepts WHERE adapter = ? AND ext_key = ?', fp.namespace, core.keys.obsKey(fp.namespace, o.id));
  };
  await say('principal', '今天的天气不错，适合晒被子');
  const first = await say('principal', '我下周要去海港城出差三天');
  await say('her', '好呀，记得带伞');
  await say('principal', '晚上吃了一碗牛肉面');
  // 在另一个群里问起：她在这个群的聊天记录里看不到，要靠回想
  const asked = await say('principal', '@她 你还记得我下周出差去哪吗', 60 * MIN, 'smallGroup');
  const changed = await say('principal', '出差改成去雪山镇了');
  const groupKey = core.keys.settingKey(fp.namespace, fp.settings.smallGroup.id);
  await pm.close();
  return { dataDir, keyFile, groupKey, first, asked, changed };
}

test('回放评测：整条命令在合成的小库上跑通——拨回、判定、摘要不含原文、没登记的表拒绝跑、compare', async () => {
  const dir = tmpDir('replay-eval');
  try {
    const w = await buildWorld(dir);
    const T1 = w.asked.created_at + 1000;          // 改口之前
    const T2 = w.changed.created_at + 1000;        // 改口之后
    assert.ok(T1 < w.changed.created_at);
    // 都在群里问（她在那个群的聊天记录里看不到一对一里说的，要靠回想）
    const base = { setting: w.groupKey, session: null, avoid: [] };
    const cases = [
      { ...base, id: 'auto-before', type: 'recent', at: T1, trigger: 'message', focus: w.asked.id, tool: null,
        need: [{ name: '出差', any: [`p${w.first.id}`] }] },
      { ...base, id: 'tool-before', type: 'point', at: T1, trigger: 'tool', focus: null, tool: { query: '主人下周出差去哪', about: '主人' },
        need: [{ name: '出差', any: [`p${w.first.id}`] }] },
      // 改口那句在 T1 还不在库里：写进 need 就报「那一刻还不在库里」，这一例不算全中
      { ...base, id: 'leak-check', type: 'point', at: T1, trigger: 'tool', focus: null, tool: { query: '出差' },
        need: [{ name: '改口', any: [`p${w.changed.id}`] }] },
      { ...base, id: 'tool-after', type: 'point', at: T2, trigger: 'tool', focus: null, tool: { query: '出差改成去哪了' },
        need: [{ name: '改口', any: [`p${w.changed.id}`] }, { name: '原来的', any: [`p${w.first.id}`] }] },
    ];
    const casesFile = path.join(dir, 'cases.json');
    fs.writeFileSync(casesFile, JSON.stringify({ cases }));
    const out = path.join(dir, 'out');
    const r = run(['run', '--db', w.dataDir, '--cases', casesFile, '--key', w.keyFile, '--out', out, '--embed', 'off']);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /无嵌入档/, '报告第一行写明嵌入的档');
    const s = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    assert.equal(s.cases.length, cases.length);
    for (const c of s.cases) assert.equal(c.error, undefined, `${c.id}：${c.error}`);
    const by = Object.fromEntries(s.cases.map((c) => [c.id, c]));

    // 拨回：改口那句在 T1 不在库里
    assert.deepEqual(by['leak-check'].missingRefs, [`p${w.changed.id}`]);
    assert.equal(by['leak-check'].ok, false);
    const detail = (id) => fs.readFileSync(path.join(out, 'detail', `${id}.txt`), 'utf8');
    for (const id of ['auto-before', 'tool-before', 'leak-check']) assert.ok(!detail(id).includes('雪山镇'), `${id}：那一刻之后的话出现在了那一块里`);
    assert.equal(by['tool-after'].missingRefs, undefined, '之后的那一刻，改口那句在库里');

    // 判定：该有的进了块，记下第几条、哪一层
    for (const id of ['auto-before', 'tool-before', 'tool-after']) {
      const c = by[id];
      assert.ok(c.block.items > 0, `${id}：块是空的`);
      for (const g of c.groups) {
        assert.equal(g.hit, true, `${id}/${g.name} 没命中\n${detail(id)}`);
        assert.ok(Number.isInteger(g.rank) && g.rank >= 1 && g.rank <= c.block.items);
        assert.equal(typeof g.layer, 'string');
      }
    }
    assert.equal(s.byType.point.cases, 3);
    assert.equal(s.total.cases, 4);
    assert.ok(s.rollback.notRestored.length > 0, '还原不了的写在摘要里');

    // 摘要不含原文；detail 含
    const raw = fs.readFileSync(path.join(out, 'summary.json'), 'utf8');
    for (const t of ['海港城', '雪山镇', '牛肉面', '晒被子']) assert.ok(!raw.includes(t), `摘要里有原文：${t}`);
    assert.ok(detail('tool-before').includes('海港城'));
    // 源库没被写过：工作副本已经删掉，源库里没有回放写的判定
    assert.ok(!fs.existsSync(path.join(out, 'work')));

    // compare：两列
    const c2 = run(['compare', path.join(out, 'summary.json'), path.join(out, 'summary.json')]);
    assert.equal(c2.status, 0, c2.stderr);
    assert.match(c2.stdout, /tool-after/);
    assert.match(c2.stdout, /合计: .*→/);

    // 防漏：多一张没登记的表就拒绝跑
    const bad = path.join(dir, 'bad');
    fs.mkdirSync(bad);
    for (const f of fs.readdirSync(w.dataDir)) if (/^persona-(memory|vectors)\.db(-wal)?$/.test(f)) fs.copyFileSync(path.join(w.dataDir, f), path.join(bad, f));
    const db = new DatabaseSync(path.join(bad, 'persona-memory.db'));
    db.exec('CREATE TABLE zz_unregistered (id INTEGER PRIMARY KEY, at INTEGER)');
    db.close();
    const r3 = run(['run', '--db', bad, '--cases', casesFile, '--key', w.keyFile, '--out', path.join(dir, 'out-bad'), '--embed', 'off']);
    assert.equal(r3.status, 3, `${r3.stdout}\n${r3.stderr}`);
    assert.match(r3.stderr, /zz_unregistered/);
  } finally {
    rmDir(dir);
  }
});
