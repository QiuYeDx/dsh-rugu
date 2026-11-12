// 清查她凭记忆答的话被记成别人的事实（D157；夜间整理第 2 步、对照原话纠错之前，纯代码，不调模型）。
//   提炼的核验第 15 条挡住新的；库里已经有的按同一把尺子（encode.echoCheck）过一遍：
//   - echo（内容出自她自己的话、讲的是别人、对方那一侧只是在问或什么都没说）：收回（encode.applyCorrection 的 withdraw：标过时，
//     不删，原话和那段经历都还在），memory_checks 记一行 doubted（把握记成 0，why 说明原因），管理页「夜里改过的」看得到、能撤销；
//   - unsure（对方也只是在问，正文的内容大半在问句里，她的话又添了东西）：不动，记一行 unclear、下次核对的时间就是现在——
//     同一晚的对照原话纠错（correct.js）会挑它（主人说过的事实平常不挑，这种例外：主人那一侧只有问话）。
//   幂等：meta 里记着清查的版本和看到的最大事实 id，之后每晚只看新记下的；版本变了从头再看一遍。记过一行的不再记。
import { getMetaJson, setMetaJson } from '../store/index.js';
import { errCode, metric, warn } from './util.js';

export const SWEEP_VER = 'echo-sweep-v1';
const CURSOR_KEY = 'consolidate.echoSweep';
const WHY = {
  echo: '只有她自己的话撑着：对方只是在问，内容是她凭记忆答的，不是对方说的，收回了',
  unsure: '对方那一侧只是在问，她的话又添了东西，拿不准是谁说的，夜里对照原话再核',
};

/**
 * 一晚的清查。不抛错。
 * @param {import('../core-types.js').CoreContext} core
 * @param {{at: number, limit?: number}} ctx
 * @returns {{checked: number, withdrawn: number, flagged: number, skipped?: string}}
 */
export function echoSweep(core, { at, limit = 5000 }) {
  const out = { checked: 0, withdrawn: 0, flagged: 0 };
  let cursor = getMetaJson(core.store, CURSOR_KEY, null);
  if (!cursor || cursor.ver !== SWEEP_VER) cursor = { ver: SWEEP_VER, maxId: 0 };
  const ids = core.store.all(`SELECT id FROM assertions WHERE id > ? AND superseded_by IS NULL AND expired_at IS NULL ORDER BY id LIMIT ?`, cursor.maxId, limit).map((r) => r.id);
  if (!ids.length) return { ...out, skipped: 'nothing-new' };
  const done = new Set(core.store.all('SELECT DISTINCT assertion_id AS id FROM memory_checks WHERE prompt_ver = ?', SWEEP_VER).map((r) => r.id));
  for (const id of ids) {
    if (done.has(id)) continue;
    let v;
    try { v = core.mods.encode.echoCheck(core, id); } catch (e) { warn(core, 'echo.check', { id, error: errCode(e) }); continue; }
    out.checked += 1;
    if (v.verdict !== 'echo' && v.verdict !== 'unsure') continue;
    try {
      core.store.tx(() => {
        const before = core.store.get('SELECT confidence FROM assertions WHERE id = ?', id)?.confidence ?? null;
        if (v.verdict === 'echo') {
          if (core.mods.encode.applyCorrection(core, id, { op: 'withdraw' }, { at }) == null) return;
          record(core, { id, at, verdict: 'doubted', evidence: v.her, shown: [...v.her, ...v.others], why: WHY.echo, before, after: 0, nextAt: null });
          out.withdrawn += 1;
        } else {
          record(core, { id, at, verdict: 'unclear', evidence: [], shown: [...v.her, ...v.others], why: WHY.unsure, before, after: null, nextAt: at });
          out.flagged += 1;
        }
      });
    } catch (e) {
      warn(core, 'echo.apply', { id, error: errCode(e) });
    }
  }
  try { setMetaJson(core.store, CURSOR_KEY, { ver: SWEEP_VER, maxId: Math.max(cursor.maxId, ...ids) }); } catch (e) { warn(core, 'echo.cursor', { error: errCode(e) }); }
  if (out.withdrawn) metric(core, 'echo.withdrawn', out.withdrawn);
  if (out.flagged) metric(core, 'echo.flagged', out.flagged);
  return out;
}

function record(core, { id, at, verdict, evidence, shown, why, before, after, nextAt }) {
  core.store.run(`INSERT INTO memory_checks(assertion_id, at, verdict, result_id, evidence_json, shown_json, why, before_conf, after_conf, streak, next_at, prompt_ver)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`, id, at, verdict, JSON.stringify(evidence ?? []), JSON.stringify([...new Set(shown ?? [])]), why,
  before, after, nextAt, SWEEP_VER);
}
