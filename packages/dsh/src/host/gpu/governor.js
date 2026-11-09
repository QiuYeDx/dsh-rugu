// 资源管家（ResourceGovernor，§8.6.2、§10.7）：执行显卡策略「关 / 开 / 自适应」。只在集成层，核心不知道显卡的存在。
// 每 sampleMs（默认 15 秒）采样一次：清单里的程序、全屏状态、空闲显存、整卡占用率；决定嵌入走 CPU 还是 GPU、CPU 线程数、重排能不能启动。
// 自适应的让出条件（每条可单独开关 / 改阈值）：
//   1 指定程序在运行（清单是主人的配置）；2 全屏程序在前台；3 空闲显存不足（扣掉我们自己模型占的）；4 显卡持续很忙；
//   5 时间表；6 手动「游戏模式」。
//   回到 GPU：全部解除并持续 cooldown（默认 15 分钟）——回差，避免反复「卸掉 → 加载」。启动以来还没真让出过的
//   （只是还没采样）不用等回差，第一次采样全部解除就上 GPU。
//   让出时也让 CPU：1、2、6 成立时（说明主人在玩）CPU 线程降到 yield 档；3、4、5 只让出 GPU。
// 隐私：进程清单只拿来和配置比对，不保存、不写日志；日志只记「因为清单第 N 项 / 全屏 / 显存不足而让出」。

const REASON_TEXT = {
  'game-mode': '游戏模式', fullscreen: '有全屏程序在前台', vram: '空闲显存不足', busy: '显卡持续很忙', schedule: '在不用显卡的时间段',
  cooldown: '刚解除让出，等回差时间', 'no-sample': '还没采样', 'no-gpu-reading': '读不到显卡状态', 'gpu-error': '显卡出过错，先用 CPU', 'policy-off': '策略是「不用」',
};
/** 让出原因 → 给人看的一句（清单命中只说第几项）。 */
export const reasonText = (r) => (String(r).startsWith('process:') ? `清单第 ${String(r).slice(8)} 项在运行` : REASON_TEXT[r] ?? String(r));

/** 'HH:MM' → 分钟。 */
const minutesOf = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** 现在在不在时间表的区间里（可以跨午夜，按本机时间）。 */
export function inSchedule(sch, at) {
  if (!sch?.enabled) return false;
  const a = minutesOf(sch.from); const b = minutesOf(sch.to);
  if (a == null || b == null || a === b) return false;
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/**
 * @param {{hostConfig: () => object, sampler?: {sample: (o: {processes: string[]}) => Promise<object>, dispose?: Function}|null,
 *          now?: () => number, log?: object, ownVramMb?: () => number, onChange?: (d: object, prev: object) => void,
 *          setTimer?: typeof setInterval, clearTimer?: typeof clearInterval}} opt
 */
export function createGovernor({ hostConfig, sampler = null, now = () => Date.now(), log = { info() {}, warn() {} }, ownVramMb = () => 0,
  onChange = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
  const cfg = () => hostConfig().gpu;
  const enabled = () => hostConfig().features?.gpu !== false;
  let last = null;                  // 最近一次采样（只有布尔、数字和命中的序号）
  let busySince = 0;
  let clearSince = 0;               // 让出条件全部解除的时刻
  let yielded = false;              // 启动以来真的因为让出条件退到过 CPU（之后回 GPU 才要回差）
  let gpuErrorAt = 0;
  let decision = { policy: 'off', device: 'cpu', reasons: ['no-sample'], cpuThreads: 4, rerankAllowed: false, nextGpuAt: null, at: 0 };
  let timer = null;
  let sampling = false;
  let samples = 0;
  const freeHist = [];              // 空闲显存的分布（只记数字，§8.6.2：按 p10 定阈值）

  function evaluate(at = now()) {
    const c = cfg();
    const policy = enabled() ? c.policy : 'off';
    const threads = c.cpuThreads ?? { normal: 4, yield: 2 };
    const reasons = [];
    let yieldCpu = false;
    const game = c.gameMode?.until === -1 || (c.gameMode?.until > 0 && at < c.gameMode.until);
    if (game) { reasons.push('game-mode'); yieldCpu = true; }
    if (policy === 'adaptive') {
      if (last?.procHits?.length) { reasons.push(...last.procHits.map((i) => `process:${i + 1}`)); yieldCpu = true; }
      if (c.fullscreen !== false && last?.fullscreen === true) { reasons.push('fullscreen'); yieldCpu = true; }
      if (last?.gpu) {
        const own = decision.device === 'gpu' ? Math.max(0, ownVramMb()) : 0;
        const free = last.gpu.freeMb + own;   // 读数里扣掉我们自己模型占的部分
        const need = decision.device === 'gpu' ? (c.vram?.minFreeMb ?? 1500) : modelVram() + (c.vram?.returnExtraMb ?? 2000);
        if (free < need) reasons.push('vram');
        if (busySince && at - busySince >= (c.busy?.seconds ?? 60) * 1000) reasons.push('busy');
      } else if (!last) reasons.push('no-sample');
      else reasons.push('no-gpu-reading');
      if (inSchedule(c.schedule, at)) reasons.push('schedule');
    }
    if (policy === 'on' && gpuErrorAt && at - gpuErrorAt < (c.gpuErrorHoldMin ?? 30) * 60_000) reasons.push('gpu-error');
    if (policy === 'adaptive' && gpuErrorAt && at - gpuErrorAt < (c.gpuErrorHoldMin ?? 30) * 60_000) reasons.push('gpu-error');

    let device = 'cpu';
    let nextGpuAt = null;
    if (policy === 'on') device = reasons.some((r) => r === 'gpu-error' || r === 'game-mode') ? 'cpu' : 'gpu';
    else if (policy === 'adaptive') {
      // 真的让出过（不是刚启动还没采样、读不到显卡）才要回差：启动后第一次采样就全部解除，直接上 GPU，
      // 不在 CPU 上白跑 15 分钟、再付一次「CPU → GPU」的重新加载（实测问题 #1）
      if (reasons.some((r) => r !== 'no-sample' && r !== 'no-gpu-reading')) yielded = true;
      if (reasons.length) clearSince = 0;
      else {
        if (!clearSince) clearSince = at;
        const cool = (c.cooldownMin ?? 15) * 60_000;
        if (decision.device === 'gpu' || !yielded || at - clearSince >= cool) device = 'gpu';
        else { reasons.push('cooldown'); nextGpuAt = clearSince + cool; }
      }
    }
    if (policy === 'off') reasons.splice(0, reasons.length, ...(game ? ['game-mode'] : []), 'policy-off');
    const next = {
      policy, device, reasons, cpuThreads: yieldCpu ? (threads.yield ?? 2) : (threads.normal ?? 4),
      rerankAllowed: device === 'gpu' && hostConfig().features?.rerank !== false, nextGpuAt, at,
    };
    const prev = decision;
    decision = next;
    if (prev.device !== next.device || prev.cpuThreads !== next.cpuThreads) {
      log.info('gpu.decision', { device: next.device, reasons: next.reasons.join(',').slice(0, 80), cpuThreads: next.cpuThreads });
      try { onChange(next, prev); } catch { /* 监听器出错不影响决定 */ }
    }
    return next;
  }
  const modelVram = () => {
    const e = hostConfig().embedding;
    return Number(e?.tiers?.[e?.tier]?.vramMb) || 4200;
  };

  async function sampleOnce() {
    if (sampling || !sampler || !enabled() || cfg().policy !== 'adaptive') return evaluate();
    sampling = true;
    try {
      const s = await sampler.sample({ processes: (cfg().processes ?? []).map((p) => String(p).toLowerCase()) });
      const at = now();
      last = { at, procHits: Array.isArray(s?.procHits) ? s.procHits : [], fullscreen: s?.fullscreen ?? null, gpu: s?.gpu ?? null, ms: s?.ms ?? null };
      samples += 1;
      if (last.gpu) {
        freeHist.push(last.gpu.freeMb);
        if (freeHist.length > 2000) freeHist.shift();
        if (last.gpu.utilPct > (cfg().busy?.utilPct ?? 80)) { if (!busySince) busySince = at; } else busySince = 0;
      }
    } catch (e) {
      log.warn('gpu.sample', { error: e?.code ?? e?.name ?? 'Error' });
    } finally { sampling = false; }
    return evaluate();
  }

  try { evaluate(); } catch { /* 配置坏了就先 CPU */ }
  return {
    start() {
      if (timer) return;
      evaluate();
      sampleOnce().catch(() => {});
      timer = setTimer(() => { sampleOnce().catch(() => {}); }, cfg().sampleMs ?? 15_000);
      timer?.unref?.();
    },
    stop() { if (timer) { clearTimer(timer); timer = null; } try { sampler?.dispose?.(); } catch { /* 忽略 */ } },
    /** 嵌入端口每次请求前问一下。 */
    decision: () => decision,
    evaluate,
    sampleOnce,
    /** 「开」档或自适应加载失败、调用报错：退回 CPU，管理页提示（§8.6.2）。 */
    reportGpuError() { gpuErrorAt = now(); log.warn('gpu.error', {}); evaluate(); },
    /**
     * 管理页总览（§8.6.2 末尾：当前在 CPU 还是 GPU、为什么、下次可能回到 GPU 的时间）。
     * games：命中的是主人自己配置的清单里的哪几项（配置数据，不是进程列表）；进程列表本身从不离开采样线程。
     */
    status() {
      const sorted = [...freeHist].sort((a, b) => a - b);
      const p10 = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : null;
      const list = cfg().processes ?? [];
      return {
        ...decision, reasons: [...decision.reasons], samples, sampler: !!sampler,
        reason: decision.reasons.map(reasonText).join('、'),
        yielding: decision.policy !== 'off' && decision.device === 'cpu',
        vramFreeMb: last?.gpu?.freeMb ?? null,
        utilization: last?.gpu ? last.gpu.utilPct : null,
        games: (last?.procHits ?? []).map((i) => String(list[i] ?? `#${i + 1}`)),
        last: last ? { at: last.at, procHits: last.procHits.length, fullscreen: last.fullscreen, gpu: last.gpu ? { ...last.gpu } : null, ms: last.ms } : null,
        freeVramP10Mb: p10, gpuErrorAt: gpuErrorAt || null,
      };
    },
  };
}
