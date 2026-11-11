// retrieve 用到的参数：每次都从 core.config.get() 取（热加载）。数值都在 config/defaults.js 的 recall 段（唯一的来源），
// 都是【建议】，等评测集调参（§6.5、§14.4）。这里只把 retrieve 内部用的几个键摆成方便用的形状（x）。

/**
 * 当前配置里 retrieve 用的部分。mergeConfig 保证快照里的键是全的。
 * @param {import('../core-types.js').CoreContext} core
 */
export function params(core) {
  const cfg = core.config.get();
  const r = cfg.recall;
  const x = {
    queryInstruct: r.queryInstruct,
    maxQueryVectors: r.maxQueryVectors,
    cRankDepth: r.cRankDepth,
    routeReserveMs: r.routeReserveMs,
    poolFactor: r.poolFactor,
    linkDecay: r.linkDecay,
    weightsPresent: r.weights.present,
    entity: r.entity,
    time: r.time,
    present: r.present,
    rerank: r.rerank,
    occurrence: r.occurrence,
    past: r.past,
    render: r.render,
    fok: r.fok,
    rewrite: r.rewrite,
    background: r.background,
    contextSim: r.contextSim,
    prefetchCacheMax: r.prefetchCacheMax,
    prefetchTtlMin: r.prefetchTtlMin,
    windowMaxGapH: r.window.maxGapH,
  };
  return {
    cfg,
    recall: r,
    x,
    act: cfg.activation,
    tzOffsetMin: cfg.time?.tzOffsetMin ?? null,
  };
}
