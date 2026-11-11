// API 方法 → 模块函数的对照（docs/实现/模块与接口.md §1.1）。
// 每个对外方法只转给一个模块函数（找场合键的 intake.resolveSetting、恢复期间不注入的 backup.isRestoring 是共用的辅助，不算）；
// 新加的 API 方法必须先写进这张表，否则这里失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonaMemory } from '../src/index.js';
import { fakePorts } from './fakes/index.js';
import { tmpDir, rmDir } from './helpers.js';

const AUX = new Set(['intake.resolveSetting', 'backup.isRestoring']);
const S = { settingId: 'S1', trigger: 'message' };
const R = { mode: 'involuntary', deadlineMs: 800, budgetChars: 600 };
const U = { channel: { targetSettingId: 'S1', persistence: 'once' }, text: ['好'], origin: { path: 'tool' } };
const ACTOR = { claims: [] };
const ADAPTER = { id: 'zz', protocol: 2, describeSetting() {}, selfClaims: () => [], principalClaims: () => [] };

/** [API 路径, 调用参数, 转给的模块函数]。'(顶层)' = maintenance.js 自己做，不经模块。 */
export const API_MAP = [
  // §4.5 原有的
  ['registerAdapter', [ADAPTER], 'intake.registerAdapter'],
  ['observe', [[], { adapter: 'zz' }], 'intake.enqueue'],
  ['describe', [{}, { adapter: 'zz' }], 'intake.describe'],
  ['sealBuffers', ['S1'], 'intake.sealBuffers'],
  ['expectRelay', [{}], 'intake.expectRelay'],
  ['resident', ['S1'], 'context.resident'],
  ['recall', [S, R], 'context.recall'],
  ['recallCached', [S], 'context.recallCached'],
  ['look', [S, { open: 'e1', deadlineMs: 100 }], 'context.look'],
  ['self.coreBlock', ['S1'], 'context.coreBlock'],
  ['expression.appraise', [U], 'discretion.appraise'],
  ['expression.outcome', ['t1', 'sent'], 'discretion.outcome'],
  ['ingest.import', [[{ subjects: ['a'], text: 'b', sourceMeta: {} }], { provenance: 'imported', source: 't' }], 'encode.importRecords'],
  ['note', [{ triggerObsId: 'm1', speaker: ACTOR, op: 'remember', text: 'x', evidenceQuote: 'x' }], 'encode.note'],
  ['fix', [{ triggerObsId: 'm1', speaker: ACTOR, op: 'forget', target: 'a1', evidenceQuote: 'x' }], 'encode.fix'],
  ['admin.list', [{}], 'admin.list'],
  ['admin.get', ['a1'], 'admin.get'],
  ['admin.simulate', [{ settingId: 'S1', as: ACTOR, text: 'x' }], 'admin.simulate'],
  ['admin.review.list', [], 'admin.listReview'],
  ['admin.review.decide', [1, 'approve'], 'admin.decideReview'],
  ['admin.pendingCount', [true], 'admin.pendingCount'],
  ['maintenance.runJobs', [{ maxJobs: 0 }], '(顶层)'],
  ['maintenance.sleep', [], 'consolidate.sleep'],
  // 【补】（§7 的 D2、D4、D5 和管理页）
  ['cursor', ['zz', 'file'], 'intake.cursor'],
  ['modeOf', ['S1'], 'admin.modeFor'],
  ['maintenance.tick', [{ only: [] }], '(顶层)'],
  ['sessions.bind', [{}], 'context.bindSession'],
  ['sessions.injected', [{}], 'context.recordInjection'],
  ['sessions.confirm', ['s', 'n'], 'context.confirmInjection'],
  ['sessions.abort', ['s'], 'context.abortPending'],
  ['sessions.compaction', ['s', 'start'], 'context.compaction'],
  ['sessions.markTurnTaint', ['s', {}], 'context.markTurnTaint'],
  ['sessions.step', ['s', {}], 'context.recordStep'],
  ['sessions.get', ['s'], 'context.sessionInfo'],
  ['sessions.holdsMemory', ['s'], 'context.taintLedger'],
  // 【D117】回想的稳定性
  ['sessions.recallOutcome', ['s', { outcome: 'timeout', waitedMs: 4300 }], 'context.noteHostRecall'],
  ['admin.recallHealth', [], 'context.recallHealth'],
  ['admin.needToKnow.list', [{}], 'admin.listNeedToKnow'],
  ['admin.needToKnow.markRead', [1], 'admin.markNeedToKnowRead'],
  ['admin.rules.list', ['disclosure'], 'admin.activeRules'],
  ['admin.rules.add', [{ kind: 'disclosure', target: {} }], 'admin.addRule'],
  ['admin.rules.revoke', [1], 'admin.revokeRule'],
  ['admin.setMode', ['S1', 'live'], 'admin.addRule'],
  ['admin.renameSetting', ['k1', '新名字'], 'intake.renameSetting'],
  ['admin.forget', ['a1'], 'admin.suppress'],
  ['admin.hide', ['a1'], 'admin.suppress'],
  ['admin.restore', ['a1'], 'admin.restore'],
  ['admin.relaxLimit', ['a1'], 'admin.relaxLimit'],
  // 【D116】她看过的媒体
  ['media.noteViewed', [{ adapter: 'zz', obsId: 'm1', thoughts: '看到一只小狗' }], 'intake.perceiveMedia'],
  ['admin.purge', [['a1']], 'admin.purge'],
  ['admin.withdrawBySource', [{}], 'admin.withdrawBySource'],
  ['admin.retention.get', [], 'admin.retentionState'],
  ['admin.retention.request', ['1y', 'x'], 'admin.requestRetentionChange'],
  ['admin.retention.cancel', [], 'admin.cancelRetentionChange'],
  ['admin.growth.versions', [], 'consolidate.growthVersions'],
  ['admin.growth.revoke', [1], 'consolidate.revokeGrowth'],
  ['admin.growth.rollback', [1], 'consolidate.rollbackGrowth'],
  ['admin.checks.revert', [1], 'consolidate.revertCheck'],
  // D124：她自己的经验
  ['lessons.note', [{ text: 'x' }], 'encode.noteLesson'],
  ['lessons.toolOutcome', [{ tool: 't', ok: true }], 'encode.lessonToolOutcome'],
  ['admin.lessons.confirm', [1], 'encode.confirmLesson'],
  ['admin.lessons.stats', [], 'encode.lessonStats'],
  // D126：「有记忆 / 没记忆」评测的结果
  ['admin.evalResult.get', [], 'admin.evalResult'],
  ['admin.evalResult.set', [{ cases: [] }], 'admin.setEvalResult'],
  ['admin.backup.now', [], 'backup.createPack'],
  ['admin.backup.verify', ['p'], 'backup.verifyPack'],
  ['admin.backup.preview', ['p'], 'backup.previewRestore'],
  ['admin.backup.restore', ['p'], 'backup.restoreFull'],
  ['admin.backup.restorePartial', ['p', {}], 'backup.restorePartial'],
  ['admin.backup.exportJsonl', [{}], 'backup.exportJsonl'],
  ['admin.backup.rescan', [], 'backup.rescan'],
  // 【补】管理页的总览和设置（D69）
  ['admin.backup.setupEncryption', [{}], 'backup.setupEncryption'],
  ['admin.backup.overview', [], 'backup.overview'],
  ['admin.embedding.health', [], 'worker.health'],
  ['admin.embedding.spaces', [], 'worker.spaces'],
  ['admin.embedding.activate', ['sp1'], 'worker.activateSpace'],
];
/** 不转给任何模块的方法。 */
const LOCAL = new Set(['status', 'close']);

function apiPaths(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'function') out.push(p);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...apiPaths(v, p));
  }
  return out;
}
const at = (obj, p) => p.split('.').reduce((o, k) => o[k], obj);

test('API 方法 → 模块函数：表里列全了，每个方法只转给表里那一个函数', async () => {
  const dir = tmpDir('api-map');
  const pm = await createPersonaMemory({ dataDir: dir, ports: fakePorts(), startWorker: false });
  const core = pm._core;
  const real = core.mods;
  try {
    const paths = apiPaths(pm).filter((p) => !LOCAL.has(p));
    const mapped = new Set(API_MAP.map((r) => r[0]));
    assert.deepEqual(paths.filter((p) => !mapped.has(p)), [], '这些 API 方法没写进对照表（模块与接口.md §1.1）');
    assert.deepEqual([...mapped].filter((p) => !paths.includes(p)), [], '对照表里有 API 里没有的方法');
    assert.equal(mapped.size, API_MAP.length, '对照表里有重复的行');

    // 替身：记下调用了哪个模块函数；resolveSetting 返回一个场合键，其余返回 undefined
    let calls = [];
    core.mods = new Proxy({}, {
      get: (_, mod) => new Proxy({}, {
        get: (__, fn) => (...args) => {
          const name = `${String(mod)}.${String(fn)}`;
          calls.push(name);
          if (name === 'intake.resolveSetting') return { key: 'k1' };
          if (name === 'intake.registerAdapter') return () => {};
          return undefined;
        },
      }),
    });
    for (const [p, args, target] of API_MAP) {
      calls = [];
      const fn = at(pm, p);
      const parent = p.includes('.') ? at(pm, p.split('.').slice(0, -1).join('.')) : pm;
      const r = fn.apply(parent, args);
      if (r && typeof r.then === 'function') await r;
      const own = calls.filter((c) => !AUX.has(c));
      if (target === '(顶层)') {
        assert.ok(own.every((c) => !c.endsWith('.undefined')), p);
        continue;
      }
      assert.deepEqual(own, [target], `${p} 应该只转给 ${target}，实际：${calls.join(', ') || '（没有调用）'}`);
      if (p === 'registerAdapter') core.adapters.clear();
    }
  } finally {
    core.mods = real;
    await pm.close();
    rmDir(dir);
  }
});

test('API 对照表和文档一致（模块与接口.md §1.1）', async () => {
  const fs = await import('node:fs');
  const url = new URL('../../../docs/实现/模块与接口.md', import.meta.url);
  if (!fs.existsSync(url)) return;   // 公开发布时 docs/ 可能被移走
  const md = fs.readFileSync(url, 'utf8');
  const sec = md.slice(md.indexOf('### 1.1'), md.indexOf('## 2.'));
  for (const [p, , target] of API_MAP) {
    const fn = target === '(顶层)' ? `maintenance.${p.split('.').at(-1)}` : target;
    assert.ok(new RegExp(String.raw`\|\s*\`${p.replace(/\./g, '\\.')}\`[^\n]*\`${fn.replace(/\./g, '\\.')}\``).test(sec), `§1.1 缺少 ${p} → ${fn}`);
  }
});
