// 管理页的「星图」页签（D163）：把她的记忆画成一片能交互、能按时间回放的星空。
// 一颗星是一条记忆（经历、知道的事、约定和打算、做事的经验），亮度是「此刻想不想得起来」（和核心 dynamics/actr.js 同一个式子，按痕迹现算）。
// 这个文件是一个普通脚本，由 page.js 渲染时塞进 page.html 主脚本前面的占位处（同一个带 nonce 的块）；它只往 window 上挂
//   window.__pmStarmap = { mount(el, deps) → {show, hide, refresh}, lib }
// lib 是不碰 DOM 的纯函数（亮度、布局、时间刻度），测试里用 vm 单独加载它。
// 约束（和管理页一样）：CSP 只许带 nonce 的脚本和样式；不拼 HTML 字符串（记忆内容、名字是别人可控的字符串，一律文本节点）；
// 不动态执行代码、不起后台线程；样式只经 el.style.x 或 CSS 变量。没有外部库：WebGL 和布局都在这里写。
(() => {
  'use strict';
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const GOLDEN = 2.399963229728653;

  // ═══════════════════════════════════════════════════════════════════════
  // 纯函数
  // ═══════════════════════════════════════════════════════════════════════
  /** 四种星：名字（主人的话）、颜色（深色天空上分得开，也不靠颜色单独区分：提示和详情里都写种类）。 */
  const KINDS = [
    { name: '经历', rgb: [0x85, 0xB7, 0xEB] },
    { name: '知道的事', rgb: [0xFA, 0xC7, 0x75] },
    { name: '约定和打算', rgb: [0xED, 0x93, 0xB1] },
    { name: '做事的经验', rgb: [0x5D, 0xCA, 0xA5] },
  ];
  /** 想起的三种（injections 的 layerCode）。连线：想起是虚线，说起是实线。 */
  const LAYERS = [
    { name: '眼前的事', css: '#8FD6FF' },
    { name: '自己浮上来的', css: '#C7B5FF' },
    { name: '被问到去找的', css: '#FFB27A' },
  ];
  const TELL_CSS = '#F2F4F8';
  const MOON_CSS = '#BFCBFF';
  /** 痕迹的原因（r）。 */
  const REASONS = ['记下', '被提起', '又想起', '确认', '被问到', '回话时用到', '讲给别人', '夜里重温', '接过旧的', '以前的'];
  const SUB = { plan: '计划', commitment: '答应的事', rule: '规矩', lesson: '经验', event: '经历', diary: '日记', import: '导入的', intention: '想做的事', summary: '小结' };
  const CERT = { s: '本人说的', c: '确认过', m: '她自己说的', h: '听说的', i: '推断的' };
  /** 亮度映射：B ≈ −3.5 最暗（仍看得见），+1 最亮，中间过一条 gamma。 */
  const BRIGHT = { lo: -3.5, hi: 1, floor: 0.06, gamma: 2, ghost: 0.35 };

  /** FNV-1a（种子用）。 */
  function hash32(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  /** 一个确定的 [0, 1) 数（同一个种子永远一样）。 */
  const unit = (s) => { let x = hash32(s); x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  /**
   * Σ w·max((T − t)/unit, floor/unit)^(−d)，只算 t ≤ T 的痕迹（和核心 dynamics/actr.js 的 traceSum 对精确痕迹是同一个式子）。
   * 痕迹放在平行数组里，[from, to) 一段，按 t 升序。
   */
  function traceSumAt(tT, tW, tD, from, to, T, ageFloorMs, unitMs) {
    const floor = ageFloorMs / unitMs;
    let s = 0;
    for (let j = from; j < to; j++) {
      const t = tT[j];
      if (!(t <= T)) break;
      if (!(tW[j] > 0)) continue;
      const age = Math.max((T - t) / unitMs, floor);
      s += tW[j] * Math.pow(age, -tD[j]);
    }
    return s;
  }
  /** B = ln Σ …；没有痕迹（或都还没发生）返回 −∞。 */
  const activationAt = (tT, tW, tD, from, to, T, ageFloorMs, unitMs) => { const s = traceSumAt(tT, tW, tD, from, to, T, ageFloorMs, unitMs); return s > 0 ? Math.log(s) : -Infinity; };
  /** B → 亮度 0..1（被取代的再 ×0.35）。 */
  function brightOf(B, ghost = false) {
    if (!Number.isFinite(B)) return 0;
    const x = clamp((B - BRIGHT.lo) / (BRIGHT.hi - BRIGHT.lo), 0, 1);
    const v = BRIGHT.floor + (1 - BRIGHT.floor) * Math.pow(x, BRIGHT.gamma);
    return ghost ? v * BRIGHT.ghost : v;
  }
  /** 星的核心直径（CSS 像素）：第一条痕迹的 w（记得多深）。 */
  const sizeOf = (w) => 2 + 2.3 * Math.pow(clamp(w, 0.2, 1.8), 0.8);

  /**
   * 快照（§3.1 的形状，集成层整理过场合和人名）→ 页面用的模型：typed array 的列、按星分好的痕迹、每颗星的想起和说起。
   * @param {any} snap
   */
  function buildModel(snap) {
    // 她自己排第一（people 下标 0）：核心说她永远第一，但库里没有她的档案时没有这一项——那就在正中补一个没有名字的「她」
    const ppl0 = Array.isArray(snap.people) ? snap.people : [];
    let selfAt = ppl0.findIndex((p) => p && p.self === true);
    const people = selfAt >= 0 ? [ppl0[selfAt], ...ppl0.filter((_, k) => k !== selfAt)] : [{ id: -1, name: '', self: true, principal: false, closeness: null, n: 0, virtual: true }, ...ppl0];
    const pmap = ppl0.map((_, k) => (selfAt >= 0 ? (k === selfAt ? 0 : k < selfAt ? k + 1 : k) : k + 1));
    selfAt = 0;
    const cols = snap.stars?.cols ?? [];
    const rows = snap.stars?.rows ?? [];
    const c = (name) => cols.indexOf(name);
    const C = { ref: c('ref'), k: c('k'), sub: c('sub'), t: c('t'), t2: c('t2'), place: c('place'), who: c('who'), st: c('st'), sup: c('sup'), imp: c('imp'), cert: c('cert'), val: c('val'), b: c('b') };
    const n = rows.length;
    const m = {
      n, now: snap.now, rev: snap.rev, cursor: { ...(snap.cursor ?? { inj: 0, trace: 0, told: 0 }) },
      params: { ageFloorMs: snap.params?.ageFloorMs ?? 180_000, timeUnitMs: snap.params?.timeUnitMs ?? HOUR },
      people, places: snap.places ?? [], dropped: snap.dropped ?? 0, counts: snap.counts ?? {},
      ref: new Array(n), refIdx: new Map(), sub: new Array(n), cert: new Array(n), who: new Array(n),
      kind: new Uint8Array(n), t: new Float64Array(n), t2: new Float64Array(n), place: new Int16Array(n), home: new Int16Array(n),
      st: new Uint8Array(n), sup: new Int32Array(n), imp: new Float32Array(n), val: new Float32Array(n), b: new Float32Array(n),
      w1: new Float32Array(n), seed: new Float32Array(n), supBy: new Int32Array(n).fill(-1),
      raw: { traces: [], recalls: [], tells: [] },
      mood: Array.isArray(snap.mood) ? snap.mood : [], heard: Array.isArray(snap.heard) ? snap.heard : [], nights: Array.isArray(snap.nights) ? snap.nights : [],
      placeIdx: new Map(),
    };
    (m.places).forEach((p, i) => m.placeIdx.set(p.key, i));
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const ref = String(r[C.ref]);
      m.ref[i] = ref; m.refIdx.set(ref, i);
      m.kind[i] = clamp(Number(r[C.k]) | 0, 0, 3);
      m.sub[i] = r[C.sub] ?? null;
      m.t[i] = Number(r[C.t]);
      m.t2[i] = r[C.t2] == null ? NaN : Number(r[C.t2]);
      const pl = Number(r[C.place]);
      m.place[i] = Number.isInteger(pl) && pl >= 0 && pl < m.places.length ? pl : -1;
      const who = Array.isArray(r[C.who]) ? r[C.who].filter((w) => Number.isInteger(w) && w >= 0 && w < pmap.length).map((w) => pmap[w]) : [];
      m.who[i] = who;
      m.home[i] = who.length ? who[0] : -1;
      m.st[i] = clamp(Number(r[C.st]) | 0, 0, 2);
      const sup = Number(r[C.sup]);
      m.sup[i] = Number.isInteger(sup) && sup >= 0 && sup < n ? sup : -1;
      m.imp[i] = r[C.imp] == null ? NaN : Number(r[C.imp]);
      m.cert[i] = r[C.cert] ?? null;
      m.val[i] = r[C.val] == null ? NaN : Number(r[C.val]);
      m.b[i] = r[C.b] == null ? NaN : Number(r[C.b]);
      m.seed[i] = unit(ref);
    }
    for (let i = 0; i < n; i++) if (m.sup[i] >= 0) m.supBy[m.sup[i]] = i;
    for (const x of snap.traces ?? []) if (Array.isArray(x) && x[0] >= 0 && x[0] < n) m.raw.traces.push([x[0], Number(x[1]), Number(x[2]), Number(x[3]), x[4] | 0]);
    for (const x of snap.recalls ?? []) if (Array.isArray(x)) m.raw.recalls.push([Number(x[0]), x[1] ?? -1, (Array.isArray(x[2]) ? x[2] : []).filter((it) => Array.isArray(it) && it[0] >= 0 && it[0] < n).map((it) => [it[0], clamp(it[1] | 0, 0, 2)]), x[3] | 0]);
    for (const x of snap.tells ?? []) if (Array.isArray(x) && x[2] >= 0 && x[2] < n) m.raw.tells.push([Number(x[0]), x[1] ?? -1, x[2], x[3] ? 1 : 0]);
    m.t0 = Number.isFinite(snap.t0) ? snap.t0 : n ? m.t.reduce((a, b) => Math.min(a, b), Infinity) : (snap.now ?? 0) - DAY;
    indexEvents(m);
    return m;
  }
  /** 痕迹、想起、说起变了以后重建索引（按星分组的痕迹、全局按时间的痕迹、每颗星的想起和说起）。 */
  function indexEvents(m) {
    const n = m.n;
    const tr = m.raw.traces;
    tr.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const cnt = new Int32Array(n + 1);
    for (const x of tr) cnt[x[0] + 1]++;
    for (let i = 0; i < n; i++) cnt[i + 1] += cnt[i];
    const fill = cnt.slice(0, n);
    m.trStart = cnt;
    m.trT = new Float64Array(tr.length); m.trW = new Float32Array(tr.length); m.trD = new Float32Array(tr.length); m.trR = new Uint8Array(tr.length);
    m.gT = new Float64Array(tr.length); m.gI = new Int32Array(tr.length); m.gR = new Uint8Array(tr.length);
    tr.forEach((x, k) => {
      const j = fill[x[0]]++;
      m.trT[j] = x[1]; m.trW[j] = x[2]; m.trD[j] = x[3]; m.trR[j] = x[4];
      m.gT[k] = x[1]; m.gI[k] = x[0]; m.gR[k] = x[4];
    });
    for (let i = 0; i < n; i++) {
      const a = m.trStart[i]; const b = m.trStart[i + 1];
      // 记得多深：第一条痕迹的 w（记下那一条）；没有痕迹时按重要度估
      m.w1[i] = b > a ? m.trW[a] : Number.isFinite(m.imp[i]) ? 0.5 + m.imp[i] * 0.5 : 0.7;
    }
    m.raw.recalls.sort((a, b) => a[0] - b[0]);
    m.raw.tells.sort((a, b) => a[0] - b[0]);
    m.recTs = Float64Array.from(m.raw.recalls, (x) => x[0]);
    m.telTs = Float64Array.from(m.raw.tells, (x) => x[0]);
    m.recOf = new Map(); m.telOf = new Map();
    for (const r of m.raw.recalls) for (const [i, layer] of r[2]) { let l = m.recOf.get(i); if (!l) m.recOf.set(i, l = []); l.push([r[0], r[1], layer]); }
    for (const x of m.raw.tells) { let l = m.telOf.get(x[2]); if (!l) m.telOf.set(x[2], l = []); l.push([x[0], x[1], x[3]]); }
    // 每晚的整理重温了几条（夜间整理时刻前后的 replay 痕迹）
    m.nightN = m.nights.map((t) => { let k = 0; for (let j = lowerBound(m.gT, t - 30 * MIN); j < m.gT.length && m.gT[j] <= t + 2 * HOUR; j++) if (m.gR[j] === 7) k++; return k; });
  }
  /** 第一个 ≥ x 的位置。 */
  function lowerBound(arr, x) {
    let lo = 0; let hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /** 一颗星在 T 时刻的 B（没有任何痕迹时用夜里算好的 b 兜底，当成不随时间变；都没有就当很暗）。 */
  function starB(m, i, T) {
    const B = activationAt(m.trT, m.trW, m.trD, m.trStart[i], m.trStart[i + 1], T, m.params.ageFloorMs, m.params.timeUnitMs);
    if (Number.isFinite(B)) return B;
    if (m.trStart[i + 1] > m.trStart[i]) return -Infinity;   // 有痕迹，只是都还没发生
    return Number.isFinite(m.b[i]) ? m.b[i] : -3.2;
  }

  /**
   * 按人摆（§4.2）：她在原点；人按给的顺序（她、主人、亲的在前）各占一个圆盘，半径 ∝ √n；从亲疏对应的最小半径起，按固定的角度序列
   * （种子 = 档案 id）找第一个不和已摆圆盘重叠的位置。盘内按时间排成向日葵螺旋（早的在里）。两个人的事往第二个人那边拉 0.35–0.5，
   * 成为两团之间的桥。没认出是谁的自成一团（真实库里只有个位数，铺满最外一整圈会把画面撑得很空），团里按场合、时间排。同样的数据永远同样的图。
   */
  function layoutPeople(m) {
    const n = m.n; const P = m.people.length;
    const SP = 0.62;
    // 天空是横的：人在一个横向拉长的椭圆上找位置（盘本身还是圆的）
    const ASP = 1.9;
    // 没认出是谁的（who 为空）当成最后一个「人」，自己成一团（按场合、时间排）
    const per = Array.from({ length: P + 1 }, () => []);
    for (let i = 0; i < n; i++) per[m.home[i] >= 0 ? m.home[i] : P].push(i);
    for (let k = 0; k < P; k++) per[k].sort((a, b) => m.t[a] - m.t[b]);
    per[P].sort((a, b) => m.place[a] - m.place[b] || m.t[a] - m.t[b]);
    const discR = (k) => SP * Math.sqrt(Math.max(1, per[k].length)) + 1.4;
    const discs = [];
    // 亲疏只在大家的 closeness 真有差别时才用（真实库里除了主人，别人常常全是 0）：没有差别就按给的顺序（主人、星多的在前）由近到远贪心地摆
    const cl = m.people.slice(1).filter((p) => !p.principal && Number.isFinite(p.closeness)).map((p) => p.closeness);
    const varied = cl.length > 1 && Math.max(...cl) - Math.min(...cl) > 0.05;
    const gapOf = (r) => 1 + Math.min(r, 4) * 0.35;
    for (let k = 0; k <= P; k++) {
      const r = discR(k);
      const pi = k === P ? -1 : k;
      if (k === P && !per[P].length) break;
      if (k === 0) { discs.push({ pi: 0, x: 0, y: 0, r, n: per[0].length }); continue; }
      const p = m.people[k] ?? { id: 'none' };
      const clos = p.principal ? 1 : varied && Number.isFinite(p.closeness) ? clamp(p.closeness, 0, 1) : null;
      // 没有亲疏可用时，越往后（星越少）的人起始半径越大一点：只有一两颗星的人不会抢到离她最近的位置
      const rmin = discs[0].r + r + gapOf(r) + (clos == null ? (p.principal ? 0 : Math.min(k, 40) * 0.45) : (1 - clos) * (discs[0].r * 0.6 + 4));
      const base = unit(`p${p.id}`) * Math.PI * 2;
      let placed = null;
      for (let step = 0; step < 900 && !placed; step++) {
        const rad = rmin + step * 0.5;
        for (let j = 0; j < 40; j++) {
          const a = base + j * GOLDEN;
          const x = Math.cos(a) * rad * ASP; const y = Math.sin(a) * rad;
          if (discs.every((d) => Math.hypot(d.x - x, d.y - y) >= d.r + r + Math.max(gapOf(r), gapOf(d.r)))) { placed = { x, y }; break; }
        }
      }
      discs.push({ pi, x: placed?.x ?? 0, y: placed?.y ?? 0, r, n: per[k].length });
    }
    const discOf = new Map(discs.map((d) => [d.pi, d]));
    const p = new Float32Array(n * 2);
    for (const d of discs) {
      const list = per[d.pi < 0 ? P : d.pi];
      const rot = unit(`r${d.pi < 0 ? 'none' : m.people[d.pi].id}`) * Math.PI * 2;
      list.forEach((i, j) => {
        const rr = SP * Math.sqrt(j + 0.5);
        const a = rot + j * GOLDEN;
        const jx = (m.seed[i] - 0.5) * 0.3; const jy = (unit(`${m.ref[i]}y`) - 0.5) * 0.3;
        let x = d.x + Math.cos(a) * rr + jx; let y = d.y + Math.sin(a) * rr + jy;
        // 两个人的事：从家朝第二个人拉出去 0.35–0.5，成为两团之间的桥
        const w2 = m.who[i][1];
        const d2 = w2 != null && w2 !== d.pi ? discOf.get(w2) : null;
        if (d2) {
          const f = 0.35 + 0.15 * unit(`${m.ref[i]}b`);
          x += (d2.x - d.x) * f; y += (d2.y - d.y) * f;
        }
        p[i * 2] = x; p[i * 2 + 1] = y;
      });
    }
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, p[i * 2]); x1 = Math.max(x1, p[i * 2]); y0 = Math.min(y0, p[i * 2 + 1]); y1 = Math.max(y1, p[i * 2 + 1]); }
    for (const d of discs) { x0 = Math.min(x0, d.x - d.r); x1 = Math.max(x1, d.x + d.r); y0 = Math.min(y0, d.y - d.r - 2); y1 = Math.max(y1, d.y + d.r); }
    if (!Number.isFinite(x0)) { x0 = -5; x1 = 5; y0 = -5; y1 = 5; }
    return { p, discs, discOf, bounds: { x0, y0, x1, y1 } };
  }

  /**
   * 按时间摆（§4.3）：x = 离 t0 的小时数；y 在 0..1 里分成河道（一个场合一条，按星数排，道高 ∝ √n、有下限），道内按种子抖开，经历靠中线。
   */
  function layoutTime(m) {
    const n = m.n;
    const cnt = new Map();
    for (let i = 0; i < n; i++) cnt.set(m.place[i], (cnt.get(m.place[i]) ?? 0) + 1);
    const keys = [...cnt.keys()].sort((a, b) => (a === -1) - (b === -1) || cnt.get(b) - cnt.get(a));
    // 一颗星都没有的场合也给一条窄道（听到的话还能画在上面）
    for (let k = 0; k < m.places.length; k++) if (!cnt.has(k) && m.heard.some((h) => h[0] === k)) { keys.push(k); cnt.set(k, 0); }
    const max = Math.max(1, ...[...cnt.values()]);
    const hs = keys.map((k) => Math.max(Math.sqrt(cnt.get(k)), 0.38 * Math.sqrt(max)));
    const gap = keys.length > 1 ? 0.035 : 0;
    const total = hs.reduce((a, b) => a + b, 0);
    const scale = (1 - gap * (keys.length - 1)) / (total || 1);
    const lanes = []; const laneOf = new Map();
    let y = 0;
    keys.forEach((k, j) => { const h = hs[j] * scale; const lane = { place: k, y0: y, y1: y + h, yc: y + h / 2, n: cnt.get(k) }; lanes.push(lane); laneOf.set(k, lane); y += h + gap; });
    const p = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const lane = laneOf.get(m.place[i]);
      p[i * 2] = (m.t[i] - m.t0) / HOUR;
      const spread = m.kind[i] === 0 ? 0.32 : 0.84;
      p[i * 2 + 1] = lane ? lane.yc + (unit(`${m.ref[i]}t`) - 0.5) * (lane.y1 - lane.y0) * spread : 0.5;
    }
    return { p, lanes, laneOf, x1: Math.max(1, (m.now - m.t0) / HOUR) };
  }

  /** 时间刻度：一屏里每隔多久一个刻度（本地时间对齐），返回 [{t, major, label}]。 */
  function timeTicks(t0, t1, pxPerMs) {
    const steps = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];
    const step = steps.find((s) => s * pxPerMs >= 64) ?? 7 * DAY;
    const out = [];
    const d = new Date(t0); d.setMinutes(0, 0, 0);
    if (step >= DAY) d.setHours(0);
    else d.setHours(Math.floor(d.getHours() / (step / HOUR)) * (step / HOUR));
    for (let k = 0; k < 400; k++) {
      const t = d.getTime();
      if (t > t1) break;
      if (t >= t0) {
        const midnight = d.getHours() === 0;
        out.push({ t, major: midnight, label: midnight || step >= DAY ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:00` });
      }
      if (step >= DAY) d.setDate(d.getDate() + step / DAY); else d.setTime(t + step);
      if (step < DAY && d.getHours() % (step / HOUR) !== 0) d.setHours(Math.round(d.getHours() / (step / HOUR)) * (step / HOUR));
    }
    return out;
  }

  /** 演示模式的名字：她、主人、别人按顺序甲乙丙丁…；场合：私聊 / 群 A / 群 B…。 */
  function demoNames(people, places) {
    const GAN = '甲乙丙丁戊己庚辛壬癸';
    let o = 0;
    const ppl = people.map((p) => (p.self ? '她' : p.principal ? '主人' : (o++ < GAN.length ? GAN[o - 1] : `路人 ${o}`)));
    let g = 0; let d = 0;
    const plc = places.map((s) => (s.oneOnOne ? `私聊${d++ ? ` ${d}` : ''}` : `群 ${String.fromCharCode(65 + (g++ % 26))}`));
    return { people: ppl, places: plc };
  }

  const lib = { KINDS, LAYERS, BRIGHT, hash32, unit, traceSumAt, activationAt, brightOf, sizeOf, buildModel, indexEvents, starB, layoutPeople, layoutTime, timeTicks, demoNames, lowerBound };

  // ═══════════════════════════════════════════════════════════════════════
  // WebGL
  // ═══════════════════════════════════════════════════════════════════════
  const VS = `
attribute vec4 aP;   // 按人的位置 xy、按时间的位置 zw（世界坐标）
attribute vec4 aS;   // 种类、大小、样式（0 普通 2 没到点的意图 3 做过的意图 4 过时）、种子
attribute vec4 aD;   // 亮度、闪光、筛选后的不透明度、是不是虚影（被取代）
uniform vec4 uC0; uniform vec4 uC1;   // 两套镜头：sx, sy, ox, oy（CSS 像素）
uniform float uMix; uniform vec2 uRes; uniform float uDpr; uniform float uTime; uniform float uTw; uniform float uZoom;
uniform vec3 uK0; uniform vec3 uK1; uniform vec3 uK2; uniform vec3 uK3;
varying vec3 vC; varying float vA; varying float vF; varying float vG; varying float vR;
void main() {
  float h = aS.w;
  float m = clamp(uMix * 1.45 - h * 0.45, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  vec2 s0 = aP.xy * uC0.xy + uC0.zw;
  vec2 s1 = aP.zw * uC1.xy + uC1.zw;
  vec2 d = s1 - s0;
  float bend = m * (1.0 - m) * 0.35 * (h - 0.5);
  vec2 s = s0 + d * m + vec2(-d.y, d.x) * bend;
  vec2 c = s / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  vec3 col = uK0;
  if (aS.x > 2.5) col = uK3; else if (aS.x > 1.5) col = uK2; else if (aS.x > 0.5) col = uK1;
  float grey = dot(col, vec3(0.3, 0.55, 0.15));
  if (aD.w > 0.5) col = mix(vec3(grey), col, 0.3);
  else if (aS.z > 3.5) col = mix(vec3(grey), col, 0.6);
  float b = aD.x * aD.z;
  float tw = 1.0 + uTw * 0.1 * sin(uTime * (0.6 + h * 1.9) + h * 61.0);
  float breathe = (aS.z > 1.5 && aS.z < 2.5) ? 1.0 + 0.22 * uTw * sin(uTime * 2.1 + h * 9.0) : 1.0;
  float size = aS.y * uZoom * (0.72 + 0.5 * aD.x) * (1.0 + aD.y * 0.9) * breathe;
  gl_PointSize = b > 0.0005 ? max(size * 3.2 * uDpr, 2.0) : 0.0;
  vC = col; vA = clamp(b * tw + aD.y * 0.7 * aD.z, 0.0, 1.7); vF = aD.y; vG = aD.w;
  vR = (aS.z > 1.5 && aS.z < 3.5) ? 1.0 : 0.0;
}`;
  const FS = `
precision mediump float;
varying vec3 vC; varying float vA; varying float vF; varying float vG; varying float vR;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  float core = exp(-r * r * 22.0);
  float halo = exp(-r * 4.4) * (1.0 - r) * 0.6;
  float a = core + halo;
  if (vG > 0.5) { float ring = exp(-pow((r - 0.24) / 0.065, 2.0)); a = ring * 0.95 + halo * 0.35; }
  else if (vR > 0.5) { float ring = exp(-pow((r - 0.27) / 0.06, 2.0)); a = ring * 1.1 + core * 0.3 + halo * 0.5; }
  vec3 col = mix(vC, vec3(1.0), clamp(core * 0.5 + vF * 0.55, 0.0, 1.0));
  float al = a * vA;
  gl_FragColor = vec4(col * al, al);
}`;
  function makeGL(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { alpha: true, antialias: false, premultipliedAlpha: true, depth: false, stencil: false }); } catch { gl = null; }
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader'); return s; };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    } catch { return null; }
    gl.useProgram(prog);
    const A = { P: gl.getAttribLocation(prog, 'aP'), S: gl.getAttribLocation(prog, 'aS'), D: gl.getAttribLocation(prog, 'aD') };
    const U = {};
    for (const u of ['uC0', 'uC1', 'uMix', 'uRes', 'uDpr', 'uTime', 'uTw', 'uZoom', 'uK0', 'uK1', 'uK2', 'uK3']) U[u] = gl.getUniformLocation(prog, u);
    KINDS.forEach((k, i) => gl.uniform3f(U[`uK${i}`], k.rgb[0] / 255, k.rgb[1] / 255, k.rgb[2] / 255));
    const bufP = gl.createBuffer(); const bufS = gl.createBuffer(); const bufD = gl.createBuffer();
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    let count = 0;
    return {
      kind: 'webgl',
      lost: () => gl.isContextLost(),
      upload(pos, stat) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufP); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufS); gl.bufferData(gl.ARRAY_BUFFER, stat, gl.STATIC_DRAW);
        count = pos.length / 4;
      },
      draw(dyn, u) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (!count) return;
        gl.bindBuffer(gl.ARRAY_BUFFER, bufD); gl.bufferData(gl.ARRAY_BUFFER, dyn, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(A.D); gl.vertexAttribPointer(A.D, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufP); gl.enableVertexAttribArray(A.P); gl.vertexAttribPointer(A.P, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufS); gl.enableVertexAttribArray(A.S); gl.vertexAttribPointer(A.S, 4, gl.FLOAT, false, 0, 0);
        gl.uniform4f(U.uC0, u.c0.sx, u.c0.sy, u.c0.ox, u.c0.oy); gl.uniform4f(U.uC1, u.c1.sx, u.c1.sy, u.c1.ox, u.c1.oy);
        gl.uniform1f(U.uMix, u.mix); gl.uniform2f(U.uRes, u.w, u.h); gl.uniform1f(U.uDpr, u.dpr); gl.uniform1f(U.uTime, u.time);
        gl.uniform1f(U.uTw, u.tw); gl.uniform1f(U.uZoom, u.zoom);
        gl.drawArrays(gl.POINTS, 0, count);
      },
      info() {
        try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); } catch { return 'webgl'; }
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 页面
  // ═══════════════════════════════════════════════════════════════════════
  const LIMIT_2D = 5000;
  const SPEEDS = [[6000, '慢', '一天约 6 秒'], [3000, '中', '一天约 3 秒'], [1000, '快', '一天约 1 秒']];
  const DEMO_KEY = 'pm-admin:starmap-demo';
  const VIEW_KEY = 'pm-admin:starmap-view';
  const WEEK = '日一二三四五六';
  const pad2 = (x) => String(x).padStart(2, '0');
  const fmtWhen = (t, week = false) => { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日${week ? ` 周${WEEK[d.getDay()]}` : ''} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const fmtInt = (x) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rgbCss = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 隐私模式 */ } },
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(d, size = 14) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size)); s.setAttribute('aria-hidden', 'true');
    for (const x of [].concat(d)) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', x); p.setAttribute('fill', 'currentColor'); s.append(p); }
    return s;
  }
  const IC = {
    play: 'M4.5 2.8v10.4c0 .5.6.8 1 .5l8-5.2a.6.6 0 0 0 0-1L5.5 2.3c-.4-.3-1 0-1 .5z',
    pause: ['M4 2.5h2.6v11H4z', 'M9.4 2.5H12v11H9.4z'],
    max: 'M2 2h5v1.6H3.6V7H2zm7 0h5v5h-1.6V3.6H9zM2 9h1.6v3.4H7V14H2zm10.4 0H14v5H9v-1.6h3.4z',
    min: 'M5.4 2H7v5H2V5.4h3.4zm3.6 0h1.6v3.4H14V7H9zM2 9h5v5H5.4v-3.4H2zm7 0h5v1.6h-3.4V14H9z',
  };

  /**
   * @param {HTMLElement} el   页签的容器
   * @param {any} deps         管理页现成的工具：{h, add, clear, api, openMemory, errorBox, loading, toast, go, reduce}
   */
  function mount(el, deps) {
    const { h, clear, api } = deps;
    const reduceMq = deps.reduce ?? matchMedia('(prefers-reduced-motion: reduce)');
    const force2d = /(?:^|[?&])starmap=2d(?:&|$)/.test(location.search);
    // ── 状态 ──
    const S = {
      m: null, lp: null, lt: null, names: null,
      view: store.get(VIEW_KEY) === 'time' ? 'time' : 'people', mix: 0, mixAnim: null,
      cam0: { sx: 1, sy: 1, ox: 0, oy: 0 }, cam1: { sx: 1, sy: 1, ox: 0, oy: 0 }, fit0: null, fit1: null, moved0: false, moved1: false, tween: null,
      T: 0, live: true, playing: false, speed: 3000, dragging: false,
      kinds: [true, true, true, true], place: 'all', search: null, searchQ: '', hoverPerson: -2, hoverStar: -1, sel: -1,
      demo: store.get(DEMO_KEY) === '1', max: false, fs: false,
      W: 0, H: 0, dpr: 1, narrow: false,
      clockBase: 0, perfBase: 0, lastSnapAt: 0,
      brightT: NaN, alphaDirty: true, dataDirty: true,
      visible: false, loading: false,
    };
    S.mix = S.view === 'time' ? 1 : 0;
    let bright = new Float32Array(0); let alphaF = new Float32Array(0); let flash = new Float32Array(0); let ghost = new Float32Array(0); let dyn = new Float32Array(0);
    let flashed = [];
    let gfx = null;          // WebGL 或 2D 退路
    let sprites = null;      // 2D 退路的星（每种一张）
    let raf = 0; let lastTs = 0; let pollTimer = 0;
    const frameMs = []; const frameGap = [];
    const peekCache = new Map(); let peekTimer = 0; const peekWant = new Set();
    const serverNow = () => S.clockBase + (performance.now() - S.perfBase);
    const reduced = () => reduceMq.matches;

    // ── DOM ──
    const cvBg = h('canvas', { class: 'pm-sm-cv', 'aria-hidden': 'true' });
    let cvGl = h('canvas', { class: 'pm-sm-cv', 'aria-hidden': 'true' });
    const cvFg = h('canvas', { class: 'pm-sm-cv', 'aria-hidden': 'true' });
    const ctxBg = cvBg.getContext('2d'); const ctxFg = cvFg.getContext('2d');
    const capMain = h('b', null, '一颗星是一条记忆 · 越亮 = 此刻越容易想起');
    const capSub = h('small');
    const listLink = h('button', { type: 'button', class: 'pm-sm-cap-link', onclick: () => deps.go?.('memory') }, '在记忆列表里看');
    const lineKey = h('div', { class: 'pm-sm-key' },
      h('span', null, '想起：'), LAYERS.map((l) => { const s = h('span', { class: 'ln dash' }); s.style.setProperty('--c', l.css); return h('span', { class: 'it' }, s, l.name); }),
      h('span', { class: 'it' }, (() => { const s = h('span', { class: 'ln' }); s.style.setProperty('--c', TELL_CSS); return s; })(), '说起'),
      h('span', { class: 'it' }, (() => { const s = h('span', { class: 'ring' }); s.style.setProperty('--c', MOON_CSS); return s; })(), '夜里整理'));
    const cap = h('div', { class: 'pm-sm-cap' }, capMain, h('div', { class: 'pm-sm-cap-row' }, capSub, listLink), lineKey);
    const note = h('div', { class: 'pm-sm-note', hidden: true, role: 'status' });
    const tip = h('div', { class: 'pm-sm-tip', hidden: true, role: 'tooltip' });
    const card = h('section', { class: 'pm-sm-card', hidden: true, 'aria-label': '这颗星' });
    const msg = h('div', { class: 'pm-sm-msg', hidden: true });
    // 时间轴
    const playBtn = h('button', { type: 'button', class: 'pm-sm-sbtn icon', 'aria-label': '播放' });
    const timeLbl = h('span', { class: 'pm-sm-time' });
    const speedBtns = SPEEDS.map(([ms, text, title]) => h('button', { type: 'button', class: 'pm-sm-sbtn', 'aria-pressed': String(ms === S.speed), title, onclick: () => setSpeed(ms) }, text));
    const nowBtn = h('button', { type: 'button', class: 'pm-sm-sbtn now', 'aria-pressed': 'true', title: '回到此刻：跟着真实时间走，她想起什么当场闪一下' }, h('i', { class: 'dot' }), '此刻');
    const trackCv = h('canvas', { class: 'pm-sm-track-cv', 'aria-hidden': 'true' });
    const track = h('div', { class: 'pm-sm-track', role: 'slider', tabindex: '0', 'aria-label': '时间', 'aria-valuemin': '0', 'aria-valuemax': '100' }, trackCv);
    const tl = h('div', { class: 'pm-sm-tl' },
      h('div', { class: 'pm-sm-tl-row' }, playBtn, timeLbl, h('span', { class: 'pm-sm-grow' }), h('div', { class: 'pm-sm-speeds', role: 'group', 'aria-label': '回放速度' }, speedBtns), nowBtn),
      track);
    const sky = h('div', { class: 'pm-sm-sky', tabindex: '0', role: 'application', 'aria-roledescription': '星图', 'aria-label': '记忆星图' },
      cvBg, cvGl, cvFg, cap, note, msg, card, tip, tl);
    // 工具条（跟主题）
    const viewBtns = [['people', '按人'], ['time', '按时间']].map(([v, text]) => h('button', { type: 'button', 'aria-pressed': String(S.view === v), onclick: () => setView(v) }, text));
    const viewSeg = h('div', { class: 'pm-seg pm-sm-view', role: 'group', 'aria-label': '摆法' }, h('div', { class: 'pm-seg-in' }, viewBtns));
    const kindBtns = KINDS.map((k, i) => {
      const dot = h('i'); dot.style.setProperty('--c', rgbCss(k.rgb));
      const b = h('button', { type: 'button', class: 'pm-sm-kind', 'aria-pressed': 'true', title: `只看 / 不看「${k.name}」` }, dot, h('span', null, k.name), h('b'));
      b.addEventListener('click', () => { S.kinds[i] = !S.kinds[i]; b.setAttribute('aria-pressed', String(S.kinds[i])); S.alphaDirty = true; kick(); });
      return b;
    });
    const placeSel = h('select', { class: 'pm-select pm-sm-place', 'aria-label': '场合' });
    placeSel.addEventListener('change', () => { S.place = placeSel.value; S.alphaDirty = true; kick(); });
    const searchIn = h('input', { class: 'pm-input', type: 'search', placeholder: '搜记忆，命中的亮', 'aria-label': '搜记忆' });
    const searchInfo = h('span', { class: 'pm-sm-hits', hidden: true });
    const searchBox = h('div', { class: 'pm-search pm-sm-search' }, searchIn);
    const demoBtn = h('button', { type: 'button', class: 'pm-btn sm pm-sm-demo', 'aria-pressed': String(S.demo), title: '名字换成甲乙丙、内容不显示（截图、录屏用）' }, '演示模式');
    const maxBtn = h('button', { type: 'button', class: 'pm-btn sm pm-sm-max', title: '放大' }, icon(IC.max), h('span', null, '放大'));
    const bar = h('div', { class: 'pm-sm-bar' }, viewSeg, h('div', { class: 'pm-sm-kinds', role: 'group', 'aria-label': '种类（点一下只看 / 不看这一种）' }, kindBtns),
      h('span', { class: 'pm-sm-grow' }), h('div', { class: 'pm-sm-tools' }, placeSel, searchBox, searchInfo, demoBtn, maxBtn));
    const root = h('div', { class: 'pm-sm' }, bar, sky);
    clear(el, root);

    /** 读不出来、老核心：同样一片深色天空，中间一段说明。 */
    function stateBox(title, text, action) {
      const box = h('div', { class: 'pm-sm-sky pm-sm-state', role: 'status' }, h('div', { class: 'pm-sm-msg' }, h('div', { class: 'pm-sm-msg-in col' }, h('b', null, title), h('span', null, text), action)));
      requestAnimationFrame(() => { const top = box.getBoundingClientRect().top + window.scrollY; box.style.height = `${clamp(window.innerHeight - top - 24, 360, 900)}px`; });
      return box;
    }
    /** 天空的高度：从它在页面里的位置到窗口底（页签栏吸顶，往下滚一点就整片都在眼前），400–900。放大时由 CSS 撑满。 */
    function fitHeight() {
      if (S.max) { sky.style.removeProperty('height'); return; }
      const top = sky.getBoundingClientRect().top + window.scrollY;
      sky.style.height = `${Math.round(clamp(window.innerHeight - top - 24, 400, 900))}px`;
    }
    // ── 数据 ──
    async function load(soft = false) {
      if (S.loading) return;
      S.loading = true;
      if (!soft) { msg.hidden = false; clear(msg, h('div', { class: 'pm-sm-msg-in' }, h('span', { class: 'pm-spin' }), '正在把记忆摆成星空…')); }
      let snap;
      try { snap = await api.get('starmap'); } catch (e) {
        S.loading = false;
        if (soft) return;
        clear(el, stateBox('星图读不出来', `${e?.message ?? e}。记忆本身没有动，过一会儿再试；一直这样就去「诊断」页签看看。`, h('button', { type: 'button', class: 'pm-sm-sbtn', onclick: () => { clear(el, root); load(); } }, '重试')));
        return;
      }
      S.loading = false;
      if (snap?.unsupported) { clear(el, stateBox('这个版本的核心还画不了星图', '星图要更新到带「星图」的核心才看得到。插件更新、重启 DSH 后再来看；记忆本身不受影响，在「记忆」页签里照常能看。', h('button', { type: 'button', class: 'pm-sm-sbtn', onclick: () => deps.go?.('memory') }, '去看记忆列表'))); return; }
      const selRef = S.sel >= 0 ? S.m?.ref[S.sel] : null;
      S.m = buildModel(snap);
      S.clockBase = S.m.now; S.perfBase = performance.now(); S.lastSnapAt = Date.now();
      S.lp = layoutPeople(S.m); S.lt = layoutTime(S.m);
      S.names = demoNames(S.m.people, S.m.places);
      const n = S.m.n;
      bright = new Float32Array(n); alphaF = new Float32Array(n); flash = new Float32Array(n); ghost = new Float32Array(n); dyn = new Float32Array(n * 4); flashed = [];
      S.sel = selRef != null && S.m.refIdx.has(selRef) ? S.m.refIdx.get(selRef) : -1;
      if (!soft) { S.live = true; S.playing = false; S.T = serverNow(); } else if (S.live) S.T = serverNow(); else S.T = clamp(S.T, S.m.t0, serverNow());
      ensureGfx();
      uploadStatic();
      fillPlaces(); fillKinds(); updateCaption(); updateTimeUi();
      S.brightT = NaN; S.alphaDirty = true; S.dataDirty = true; S.moved0 = soft && S.moved0; S.moved1 = soft && S.moved1;
      resize(true);
      lineKey.hidden = !n;
      if (!n) { msg.hidden = false; clear(msg, h('div', { class: 'pm-sm-msg-in col' }, h('b', null, '还没有星星'), h('span', null, '她还没有记下什么。和大家聊过之后，这里会一颗一颗亮起来。'))); tl.hidden = true; }
      else { msg.hidden = true; tl.hidden = false; }
      if (S.sel >= 0) showCard(S.sel); else hideCard();
      drawTrack();
      kick(); schedulePoll();
    }
    function ensureGfx() {
      if (gfx) return;
      if (!force2d) { try { gfx = makeGL(cvGl); } catch { gfx = null; } }
      if (!gfx) {
        // 2D 退路：换一块没碰过 WebGL 的画布
        const c2 = h('canvas', { class: 'pm-sm-cv', 'aria-hidden': 'true' });
        cvGl.replaceWith(c2); cvGl = c2;
        gfx = { kind: '2d', ctx: c2.getContext('2d'), info: () => '2d' };
      }
    }
    function uploadStatic() {
      const m = S.m; const n = m.n;
      if (gfx.kind !== 'webgl') return;
      const pos = new Float32Array(n * 4); const stat = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        pos[i * 4] = S.lp.p[i * 2]; pos[i * 4 + 1] = S.lp.p[i * 2 + 1]; pos[i * 4 + 2] = S.lt.p[i * 2]; pos[i * 4 + 3] = S.lt.p[i * 2 + 1];
        stat[i * 4] = m.kind[i]; stat[i * 4 + 1] = sizeOf(m.w1[i]); stat[i * 4 + 2] = styleOf(i); stat[i * 4 + 3] = m.seed[i];
      }
      gfx.upload(pos, stat);
    }
    /** 星的样式：0 普通、2 没到点的意图（会呼吸）、3 做过 / 不做了的意图、4 过时。被取代（虚影）是动态的，看 T 时刻新的那条在不在。 */
    function styleOf(i) {
      const m = S.m;
      if (m.sub[i] === 'intention') return m.st[i] === 0 ? 2 : 3;
      return m.st[i] === 2 ? 4 : 0;
    }
    const personName = (pi) => (pi < 0 ? '没认出是谁' : S.demo ? S.names.people[pi] : S.m.people[pi]?.self && !S.m.people[pi].name ? '她' : S.m.people[pi]?.name || '？');
    const placeName = (k) => (k == null || k < 0 || !S.m.places[k] ? '没记下在哪儿' : S.demo ? S.names.places[k] : S.m.places[k].title);
    function fillPlaces() {
      const opts = [h('option', { value: 'all' }, '全部场合'), ...S.m.places.map((p, i) => h('option', { value: String(i) }, `${placeName(i)}（${fmtInt(p.n ?? 0)}）`))];
      if (S.m.place.some((x) => x === -1)) opts.push(h('option', { value: '-1' }, '没记下在哪儿'));
      clear(placeSel, opts);
      if (![...placeSel.options].some((o) => o.value === S.place)) S.place = 'all';
      placeSel.value = S.place;
    }
    function fillKinds() {
      const c = [0, 0, 0, 0];
      for (let i = 0; i < S.m.n; i++) c[S.m.kind[i]]++;
      kindBtns.forEach((b, i) => { b.lastChild.textContent = fmtInt(c[i]); });
    }
    function updateCaption() {
      const m = S.m;
      const view = S.view === 'people' ? '按人：她在正中，常在一起的人离她近；每团里早的在里、新的在外' : '按时间：一个场合一条河，河底的起伏是她在那儿听到多少话，最下面是她的心境';
      capSub.textContent = `${fmtInt(m.n)} 颗星${m.dropped ? `（另有 ${fmtInt(m.dropped)} 颗最暗的没画）` : ''} · ${view}`;
      sky.setAttribute('aria-label', `记忆星图：${fmtInt(m.n)} 颗星，每颗是一条记忆，越亮越容易想起。现在是${S.view === 'people' ? '按人' : '按时间'}摆的。可以用方向键平移、加减号缩放、空格播放。`);
      const notes = [];
      if (gfx?.kind === '2d') notes.push(m.n > LIMIT_2D ? `这台电脑上用不了 WebGL，用的是简化画法：只画了最亮的 ${fmtInt(LIMIT_2D)} 颗` : '这台电脑上用不了 WebGL，用的是简化画法');
      note.hidden = !notes.length; note.textContent = notes.join('；');
    }

    // ── 实时：此刻时每 3 秒要一次增量（页签不可见、页面隐藏时停） ──
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (!S.visible || !S.m) return;
      pollTimer = setTimeout(poll, 3000);
    }
    async function poll() {
      if (!S.visible || !S.m || document.hidden) { schedulePoll(); return; }
      if (!S.live) { schedulePoll(); return; }
      try {
        const r = await api.get('starmapLive', S.m.cursor);
        if (r?.unsupported) return;
        mergeLive(r);
        if (r.rev && r.rev !== S.m.rev && Date.now() - S.lastSnapAt >= 20_000) { await load(true); return; }
      } catch { /* 下一轮再试 */ }
      schedulePoll();
    }
    function mergeLive(r) {
      const m = S.m;
      if (Number.isFinite(r.now)) { S.clockBase = r.now; S.perfBase = performance.now(); }
      if (r.cursor) m.cursor = { inj: r.cursor.inj ?? m.cursor.inj, trace: r.cursor.trace ?? m.cursor.trace, told: r.cursor.told ?? m.cursor.told };
      let changed = false;
      for (const x of r.traces ?? []) { const i = m.refIdx.get(x[0]); if (i == null) continue; m.raw.traces.push([i, Number(x[1]), Number(x[2]), Number(x[3]), x[4] | 0]); changed = true; }
      for (const x of r.recalls ?? []) {
        const items = (x[2] ?? []).map((it) => [m.refIdx.get(it[0]), clamp(it[1] | 0, 0, 2)]).filter((it) => it[0] != null);
        if (!items.length && !x[3]) continue;
        m.raw.recalls.push([Number(x[0]), m.placeIdx.get(x[1]) ?? -1, items, x[3] | 0]); changed = true;
      }
      for (const x of r.tells ?? []) { const i = m.refIdx.get(x[2]); if (i == null) continue; m.raw.tells.push([Number(x[0]), m.placeIdx.get(x[1]) ?? -1, i, x[3] ? 1 : 0]); changed = true; }
      if (changed) { indexEvents(m); S.brightT = NaN; if (S.sel >= 0) showCard(S.sel, true); drawTrack(); kick(); }
    }

    // ── 镜头 ──
    const TL_H = 82;
    const MOOD_H = 56;
    const TOP0 = 84;
    const TOP1 = 114;
    const GUTTER = () => (S.W < 640 ? 84 : 116);
    function fits() {
      const W = S.W; const H = S.H; const b = S.lp.bounds;
      const padX = 28; const top = TOP0 + 8; const bottom = TL_H + 18;
      const s = Math.min((W - padX * 2) / Math.max(1, b.x1 - b.x0), (H - top - bottom) / Math.max(1, b.y1 - b.y0));
      S.fit0 = { sx: s, sy: s, ox: W / 2 - ((b.x0 + b.x1) / 2) * s, oy: top + (H - top - bottom) / 2 - ((b.y0 + b.y1) / 2) * s };
      const g = GUTTER();
      const sx = (W - g - 28) / S.lt.x1;
      S.fit1 = { sx, sy: Math.max(80, H - TOP1 - TL_H - MOOD_H - 10), ox: g + 6, oy: TOP1 };
    }
    function resize(force = false) {
      const r = sky.getBoundingClientRect();
      const W = Math.max(200, Math.round(r.width)); const H = Math.max(200, Math.round(r.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (!force && W === S.W && H === S.H && dpr === S.dpr) return;
      const old0 = S.fit0; const old1 = S.fit1; const oldW = S.W; const oldH = S.H;
      S.W = W; S.H = H; S.dpr = dpr;
      for (const c of [cvBg, cvGl, cvFg]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const tr = track.getBoundingClientRect();
      trackCv.width = Math.round(Math.max(10, tr.width) * dpr); trackCv.height = Math.round(Math.max(10, tr.height) * dpr);
      S.narrow = W < 640;
      sky.classList.toggle('narrow', S.narrow);
      if (!S.m) return;
      fits();
      // 主人没动过镜头就跟着重新对准；动过就保持中心不变
      if (!S.moved0 || !old0) S.cam0 = { ...S.fit0 };
      else {
        const k = S.fit0.sx / old0.sx; const c = S.cam0;
        const cx = (oldW / 2 - c.ox) / c.sx; const cy = (oldH / 2 - c.oy) / c.sy;
        const sx = c.sx * k;
        S.cam0 = { sx, sy: sx, ox: W / 2 - cx * sx, oy: H / 2 - cy * sx };
      }
      if (!S.moved1 || !old1) S.cam1 = { ...S.fit1 };
      else S.cam1 = { ...S.cam1, sy: S.fit1.sy, oy: S.fit1.oy };
      drawTrack();
      kick();
    }
    const camOf = (v) => (v === 0 ? S.cam0 : S.cam1);
    /** 一颗星在屏幕上的位置（和顶点着色器同一个算法）。 */
    function scr(i) {
      const h0 = S.m.seed[i];
      let mm = clamp(S.mix * 1.45 - h0 * 0.45, 0, 1); mm = mm * mm * (3 - 2 * mm);
      const c0 = S.cam0; const c1 = S.cam1;
      const x0 = S.lp.p[i * 2] * c0.sx + c0.ox; const y0 = S.lp.p[i * 2 + 1] * c0.sy + c0.oy;
      const x1 = S.lt.p[i * 2] * c1.sx + c1.ox; const y1 = S.lt.p[i * 2 + 1] * c1.sy + c1.oy;
      const dx = x1 - x0; const dy = y1 - y0; const bend = mm * (1 - mm) * 0.35 * (h0 - 0.5);
      return [x0 + dx * mm - dy * bend, y0 + dy * mm + dx * bend];
    }
    const xOfT = (t) => ((t - S.m.t0) / HOUR) * S.cam1.sx + S.cam1.ox;
    const tOfX = (x) => S.m.t0 + ((x - S.cam1.ox) / S.cam1.sx) * HOUR;
    const zoomNow = () => {
      const z0 = clamp(Math.sqrt(S.cam0.sx / S.fit0.sx), 0.85, 2.3);
      const z1 = clamp(Math.pow(S.cam1.sx / S.fit1.sx, 0.22), 0.9, 1.7);
      return z0 + (z1 - z0) * S.mix;
    };
    function clampCams() {
      const c0 = S.cam0; const f0 = S.fit0;
      const s0 = clamp(c0.sx, f0.sx * 0.6, f0.sx * 30);
      if (s0 !== c0.sx) { const k = s0 / c0.sx; c0.ox = S.W / 2 - (S.W / 2 - c0.ox) * k; c0.oy = S.H / 2 - (S.H / 2 - c0.oy) * k; c0.sx = c0.sy = s0; }
      const c1 = S.cam1; const f1 = S.fit1;
      const g = GUTTER();
      const s1 = clamp(c1.sx, f1.sx * 0.85, (S.W - g) / 2);
      if (s1 !== c1.sx) { const ax = S.W / 2; c1.ox = ax - (ax - c1.ox) * (s1 / c1.sx); c1.sx = s1; }
      // 时间轴两头不拖出去太多
      const left = c1.ox; const right = c1.ox + S.lt.x1 * c1.sx;
      if (left > g + (S.W - g) * 0.5) c1.ox -= left - (g + (S.W - g) * 0.5);
      if (right < g + (S.W - g) * 0.5) c1.ox += g + (S.W - g) * 0.5 - right;
    }
    function tweenTo(v, target, dur = 650) {
      if (reduced()) { Object.assign(camOf(v), target); clampCams(); kick(); return; }
      S.tween = { v, from: { ...camOf(v) }, to: target, t0: performance.now(), dur };
      kick();
    }
    function resetCam() {
      if (S.view === 'people') { S.moved0 = false; tweenTo(0, { ...S.fit0 }); } else { S.moved1 = false; tweenTo(1, { ...S.fit1 }); }
    }
    function focusPerson(pi) {
      const d = S.lp.discOf.get(pi); if (!d) return;
      const s = clamp(Math.min(S.W, S.H - TL_H - TOP0) * 0.34 / Math.max(2, d.r), S.fit0.sx, S.fit0.sx * 30);
      const cy = TOP0 + (S.H - TOP0 - TL_H) / 2;
      S.moved0 = true;
      tweenTo(0, { sx: s, sy: s, ox: S.W / 2 - d.x * s, oy: cy - d.y * s });
    }
    function focusStar(i) {
      if (S.view === 'people') {
        const s = Math.max(S.cam0.sx, S.fit0.sx * 3);
        S.moved0 = true;
        tweenTo(0, { sx: s, sy: s, ox: S.W / 2 - S.lp.p[i * 2] * s - (S.narrow ? 0 : 150), oy: (S.H - TL_H) / 2 - S.lp.p[i * 2 + 1] * s });
      } else {
        const sx = Math.max(S.cam1.sx, (S.W - GUTTER()) / (2 * 24));
        S.moved1 = true;
        tweenTo(1, { ...S.cam1, sx, ox: GUTTER() + (S.W - GUTTER()) * 0.4 - S.lt.p[i * 2] * sx });
      }
    }
    function setView(v) {
      if (v === S.view || !S.m) return;
      S.view = v; store.set(VIEW_KEY, v);
      viewBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'people' : 'time') === v)));
      S.hoverPerson = -2; S.alphaDirty = true; hideTip();
      const to = v === 'time' ? 1 : 0;
      if (reduced()) { S.mix = to; S.mixAnim = null; } else S.mixAnim = { from: S.mix, to, t0: performance.now(), dur: 1150 };
      updateCaption(); kick();
    }

    // ── 时间 ──
    function setSpeed(ms) { S.speed = ms; speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i][0] === ms))); }
    function goLive() { S.live = true; S.playing = false; S.T = serverNow(); updateTimeUi(); schedulePoll(); kick(); }
    function setT(T, { keepPlaying = false } = {}) {
      const end = serverNow();
      S.T = clamp(T, S.m.t0, end);
      if (!keepPlaying) S.playing = false;
      S.live = false;
      updateTimeUi(); kick();
    }
    function togglePlay() {
      if (!S.m?.n) return;
      if (S.playing) { S.playing = false; updateTimeUi(); return; }
      if (S.live || S.T >= serverNow() - 60_000) S.T = S.m.t0;
      S.live = false; S.playing = true; updateTimeUi(); kick();
    }
    function updateTimeUi() {
      playBtn.replaceChildren(icon(S.playing ? IC.pause : IC.play, 13));
      playBtn.setAttribute('aria-label', S.playing ? '暂停' : '从头回放');
      playBtn.title = S.playing ? '暂停' : S.live ? '从最早一颗星开始回放' : '从这里接着回放';
      nowBtn.setAttribute('aria-pressed', String(S.live));
      timeLbl.textContent = S.m ? `${S.live ? '此刻 · ' : ''}${fmtWhen(S.T, true)}` : '';
      if (S.m) {
        const end = serverNow(); const pct = Math.round(((S.T - S.m.t0) / Math.max(1, end - S.m.t0)) * 100);
        track.setAttribute('aria-valuenow', String(clamp(pct, 0, 100)));
        track.setAttribute('aria-valuetext', S.live ? `此刻（${fmtWhen(S.T, true)}）` : fmtWhen(S.T, true));
      }
    }
    playBtn.addEventListener('click', togglePlay);
    nowBtn.addEventListener('click', goLive);
    const trackX = (t) => { const r = track.getBoundingClientRect(); return 8 + ((t - S.m.t0) / Math.max(1, serverNow() - S.m.t0)) * (r.width - 16); };
    const trackT = (x) => { const r = track.getBoundingClientRect(); return S.m.t0 + clamp((x - 8) / (r.width - 16), 0, 1) * (serverNow() - S.m.t0); };
    track.addEventListener('pointerdown', (e) => {
      if (!S.m?.n) return;
      track.setPointerCapture(e.pointerId); S.dragging = true;
      const r = track.getBoundingClientRect();
      const at = (ev) => { const x = ev.clientX - r.left; if (x >= r.width - 6) goLive(); else setT(trackT(x)); };
      at(e);
      const move = (ev) => at(ev);
      const up = () => { S.dragging = false; track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); kick(); };
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
    });
    track.addEventListener('keydown', (e) => {
      if (!S.m?.n) return;
      const step = { ArrowLeft: -HOUR, ArrowRight: HOUR, ArrowDown: -HOUR, ArrowUp: HOUR, PageDown: -DAY, PageUp: DAY }[e.key];
      if (step != null) { e.preventDefault(); const T = S.T + step * (e.shiftKey ? 24 : 1); if (T >= serverNow()) goLive(); else setT(T); }
      else if (e.key === 'Home') { e.preventDefault(); setT(S.m.t0); }
      else if (e.key === 'End') { e.preventDefault(); goLive(); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    });

    // ── 亮度、筛选、效果 ──
    function computeBright() {
      const m = S.m; const T = S.T;
      for (let i = 0; i < m.n; i++) {
        if (m.t[i] > T) { bright[i] = 0; ghost[i] = 0; continue; }
        // 被取代：取代它的那条在 T 时已经有了才是虚影（老核心没给 sup 的被取代一直是虚影）
        const g = m.st[i] === 1 && (m.sup[i] < 0 || m.t[m.sup[i]] <= T);
        ghost[i] = g ? 1 : 0;
        bright[i] = brightOf(starB(m, i, T), g);
      }
      S.brightT = T;
    }
    function relatedTo(i, pi) { const w = S.m.who[i]; if (pi === -1) return !w.length; for (let k = 0; k < w.length; k++) if (w[k] === pi) return true; return false; }
    function computeAlpha() {
      const m = S.m;
      const place = S.place === 'all' ? null : Number(S.place);
      for (let i = 0; i < m.n; i++) {
        let a = S.kinds[m.kind[i]] ? 1 : 0;
        if (a && place != null && m.place[i] !== place) a = 0;
        if (a && S.search && !S.search.has(i)) a = 0.1;
        if (a && S.hoverPerson > -2 && S.view === 'people' && !relatedTo(i, S.hoverPerson)) a *= 0.16;
        alphaF[i] = a;
      }
      S.alphaDirty = false;
    }
    /** 回放 / 此刻那一小段时间窗（模拟时间）。 */
    function effectWindow() {
      if (S.live) return 40_000;
      if (S.playing) return clamp((DAY / S.speed) * 700, 20 * MIN, 6 * HOUR);
      return 90 * MIN;
    }
    /** 时间窗里的痕迹、想起、说起 → 星闪一下、圆环、连线（全是 T 的函数：拖到哪儿都一样）。 */
    function collectEffects() {
      const m = S.m; const T = S.T; const W = effectWindow();
      for (const i of flashed) flash[i] = 0;
      flashed = [];
      const fx = { rings: [], lines: [], places: [], night: null, W };
      const calm = reduced();
      const setF = (i, v) => { if (calm) return; if (v > flash[i]) { if (!flash[i]) flashed.push(i); flash[i] = v; } };
      // 从新到旧：画面上只留最近的一些（真实库里说起比想起多得多，全画会糊成一团）
      const lo = lowerBound(m.gT, T - W);
      for (let j = lowerBound(m.gT, T + 1) - 1; j >= lo && j >= m.gT.length - 6000; j--) {
        const i = m.gI[j]; const r = m.gR[j];
        if (r === 9 || !alphaF[i] || m.t[i] > T) continue;
        const p = (T - m.gT[j]) / W;
        if (fx.rings.length < (S.playing ? 90 : 140)) fx.rings.push([i, r, p]);
        setF(i, r === 7 ? 0.42 * (1 - p) : r === 0 ? 0.8 * (1 - p) * (1 - p) : 0.5 * (1 - p) * (1 - p));
      }
      let nRec = 0; let nTel = 0;
      for (let j = lowerBound(m.recTs, T + 1) - 1; j >= 0 && m.recTs[j] > T - W; j--) {
        const rr = m.raw.recalls[j]; const p = (T - rr[0]) / W;
        for (const [i, layer] of rr[2]) {
          if (!alphaF[i] || m.t[i] > T) continue;
          setF(i, (1 - p) * (1 - p));
          if (nRec < (S.playing ? 24 : 36)) { fx.lines.push({ i, kind: layer, p, ts: rr[0], place: rr[1] }); nRec++; }
        }
        if (rr[2].length && fx.places.length < 12) fx.places.push({ place: rr[1], p, tell: false });
      }
      for (let j = lowerBound(m.telTs, T + 1) - 1; j >= 0 && m.telTs[j] > T - W; j--) {
        const x = m.raw.tells[j]; const p = (T - x[0]) / W;
        if (!alphaF[x[2]] || m.t[x[2]] > T) continue;
        setF(x[2], (1 - p) * (1 - p));
        if (nTel < (S.playing ? 8 : 14)) { fx.lines.push({ i: x[2], kind: 'tell', p, ts: x[0], place: x[1] }); nTel++; }
        if (fx.places.length < 12) fx.places.push({ place: x[1], p, tell: true });
      }
      fx.places.sort((a, b) => a.p - b.p);
      const nj = lowerBound(m.nights, T - Math.max(W, 2 * HOUR)) ;
      if (nj < m.nights.length && m.nights[nj] <= T) fx.night = { t: m.nights[nj], n: m.nightN[nj], p: (T - m.nights[nj]) / Math.max(W, 2 * HOUR) };
      return fx;
    }

    // ── 画 ──
    function frame(ts) {
      raf = 0;
      if (!S.visible || !S.m) return;
      const t0 = performance.now();
      const dt = lastTs ? Math.min(120, ts - lastTs) : 16;
      if (lastTs) { frameGap.push(ts - lastTs); if (frameGap.length > 240) frameGap.shift(); }
      lastTs = ts;
      // 时间往前走
      if (S.live && !S.dragging) S.T = serverNow();
      else if (S.playing) {
        S.T += dt * (DAY / S.speed);
        if (S.T >= serverNow()) { S.T = serverNow(); S.playing = false; S.live = true; schedulePoll(); }
        followT();
      }
      updateTimeUi();
      // 视角切换、镜头动画
      if (S.mixAnim) {
        const k = clamp((ts - S.mixAnim.t0) / S.mixAnim.dur, 0, 1);
        S.mix = S.mixAnim.from + (S.mixAnim.to - S.mixAnim.from) * easeInOut(k);
        if (k >= 1) S.mixAnim = null;
      }
      if (S.tween) {
        const tw = S.tween; const k = clamp((ts - tw.t0) / tw.dur, 0, 1); const e = easeOut(k);
        const c = camOf(tw.v);
        // 缩放按对数插值（镜头拉近时速度均匀）
        const ls = Math.log(tw.from.sx) + (Math.log(tw.to.sx) - Math.log(tw.from.sx)) * e;
        const sx = Math.exp(ls); const sy = tw.v === 0 ? sx : tw.from.sy + (tw.to.sy - tw.from.sy) * e;
        // 让镜头中心沿直线走
        const cx0 = (S.W / 2 - tw.from.ox) / tw.from.sx; const cx1 = (S.W / 2 - tw.to.ox) / tw.to.sx;
        const cy0 = (S.H / 2 - tw.from.oy) / tw.from.sy; const cy1 = (S.H / 2 - tw.to.oy) / tw.to.sy;
        c.sx = sx; c.sy = sy; c.ox = S.W / 2 - (cx0 + (cx1 - cx0) * e) * sx; c.oy = S.H / 2 - (cy0 + (cy1 - cy0) * e) * sy;
        if (k >= 1) { Object.assign(c, tw.to); S.tween = null; }
      }
      if (S.alphaDirty) computeAlpha();
      if (!(S.brightT === S.T) && (S.playing || S.dragging || !S.live || Math.abs(S.T - S.brightT) > 2000 || !Number.isFinite(S.brightT))) computeBright();
      const fx = collectEffects();
      const n = S.m.n;
      for (let i = 0; i < n; i++) { dyn[i * 4] = bright[i]; dyn[i * 4 + 1] = flash[i]; dyn[i * 4 + 2] = alphaF[i]; dyn[i * 4 + 3] = ghost[i]; }
      drawBg();
      if (gfx.kind === 'webgl') {
        gfx.draw(dyn, { c0: S.cam0, c1: S.cam1, mix: S.mix, w: S.W, h: S.H, dpr: S.dpr, time: ts / 1000, tw: reduced() ? 0 : 1, zoom: zoomNow() });
      } else draw2d(ts);
      drawFg(fx, ts);
      frameMs.push(performance.now() - t0); if (frameMs.length > 240) frameMs.shift();
      trackTick();
      // 减少动态效果、又什么都没在动的时候不空转（不闪烁就不需要一直画）
      if (!reduced() || S.live || S.playing || S.mixAnim || S.tween || S.dragging) kick();
    }
    function kick() {
      if (raf || !S.visible || !S.m) return;
      raf = requestAnimationFrame(frame);
    }
    /** 回放时 T 走出画面就把镜头往前带（按时间时）。 */
    function followT() {
      if (S.view !== 'time' || S.tween) return;
      const x = xOfT(S.T); const g = GUTTER();
      if (x > S.W - 40) { S.cam1.ox -= x - (g + (S.W - g) * 0.62); S.moved1 = true; }
    }

    function drawBg() {
      const c = ctxBg; const W = S.W; const H = S.H;
      c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      const a1 = clamp((S.mix - 0.35) / 0.65, 0, 1);
      if (a1 > 0 && S.m.n) {
        c.globalAlpha = a1;
        drawLanesBg(c);
        drawMood(c);
        c.globalAlpha = 1;
      }
    }
    function drawLanesBg(c) {
      const m = S.m; const c1 = S.cam1; const W = S.W; const H = S.H; const g = GUTTER();
      const yOf = (y) => y * c1.sy + c1.oy;
      const tA = tOfX(g); const tB = tOfX(W);
      // 夜里（本地 0–7 点）加深
      const d = new Date(Math.max(m.t0, tA)); d.setHours(0, 0, 0, 0);
      c.fillStyle = 'rgba(0,0,12,.24)';
      for (let k = 0; k < 400 && d.getTime() < tB; k++) {
        const x0 = xOfT(d.getTime()); const n7 = new Date(d); n7.setHours(7);
        const x1 = xOfT(n7.getTime());
        if (x1 > g) c.fillRect(Math.max(g, x0), TOP1 - 26, x1 - Math.max(g, x0), H - TOP1 + 26 - TL_H + 6);
        d.setDate(d.getDate() + 1);
      }
      // 河道
      const lanes = S.lt.lanes;
      const pxH = Math.max(1, (c1.sx * 1));   // 一小时多宽
      let maxN = 1;
      for (const x of m.heard) if (x[2] > maxN) maxN = x[2];
      lanes.forEach((ln, j) => {
        const y0 = yOf(ln.y0); const y1 = yOf(ln.y1);
        c.fillStyle = j % 2 ? 'rgba(255,255,255,.022)' : 'rgba(255,255,255,.04)';
        c.fillRect(g, y0, W - g, y1 - y0);
      });
      // 她听到多少话：每个整点一格，越多越亮（对她说的那部分偏暖）
      // 画在每条河道的底部：一条按小时起伏的密度带（越高越多），对她说的那部分偏暖；只画到 T 为止
      const laneOf = S.lt.laneOf;
      for (const x of m.heard) {
        const ln = laneOf.get(x[0]); if (!ln) continue;
        if (x[1] + HOUR < tA || x[1] > tB || x[1] > S.T) continue;
        const x0 = xOfT(x[1]); const x1 = Math.min(xOfT(Math.min(x[1] + HOUR, S.T)), W);
        const xl = Math.max(g, x0); const w = x1 - xl; if (w <= 0) continue;
        const y1 = yOf(ln.y1) - 1; const band = Math.min(26, (yOf(ln.y1) - yOf(ln.y0)) * 0.42);
        const v = Math.sqrt(x[2] / maxN);
        c.fillStyle = `rgba(150,170,230,${(0.07 + v * 0.16).toFixed(3)})`;
        c.fillRect(xl, y1 - band * v, w, band * v);
        if (x[3]) { const v2 = Math.sqrt(x[3] / maxN); c.fillStyle = 'rgba(255,205,150,.32)'; c.fillRect(xl, y1 - band * v2, w, Math.min(band * v2, 2)); }
      }
      // 日期刻度
      const ticks = timeTicks(Math.max(m.t0 - DAY, tA), tB, c1.sx / HOUR);
      c.font = '11px system-ui, sans-serif'; c.textBaseline = 'alphabetic'; c.textAlign = 'center';
      // 放大到一天以内时，刻度只有钟点：左边钉一个「这是哪天」，给它让出位置
      const hourly = ticks.some((tk) => !tk.major) && !ticks.some((tk) => tk.major && xOfT(tk.t) < g + 90 && xOfT(tk.t) >= g + 18);
      for (const tk of ticks) {
        const x = xOfT(tk.t); if (x < g + 18) continue;
        if (hourly && x < g + 96) { c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(Math.round(x), TOP1 - 8, 1, H - TOP1 - TL_H + 2); continue; }
        c.fillStyle = tk.major ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.05)';
        c.fillRect(Math.round(x), TOP1 - 8, 1, H - TOP1 - TL_H + 2);
        c.fillStyle = tk.major ? 'rgba(232,236,244,.72)' : 'rgba(232,236,244,.45)';
        c.fillText(tk.label, x, TOP1 - 12);
      }
      if (hourly) {
        const d0 = new Date(Math.max(tA, m.t0));
        c.textAlign = 'left'; c.fillStyle = 'rgba(232,236,244,.85)'; c.font = '600 11px system-ui, sans-serif';
        c.fillText(`${d0.getMonth() + 1}/${d0.getDate()} 周${WEEK[d0.getDay()]}`, g + 24, TOP1 - 12);
        c.font = '11px system-ui, sans-serif';
      }
      // 夜间整理：小月亮
      for (let j = 0; j < m.nights.length; j++) {
        const x = xOfT(m.nights[j]); if (x < g || x > W) continue;
        moon(c, x, TOP1 - 2, 4.2, m.nights[j] <= S.T ? 0.9 : 0.35);
      }
    }
    function moon(c, x, y, r, a) {
      c.save(); c.globalAlpha *= a;
      c.fillStyle = MOON_CSS; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.globalCompositeOperation = 'destination-out'; c.beginPath(); c.arc(x + r * 0.55, y - r * 0.35, r * 0.85, 0, Math.PI * 2); c.fill();
      c.restore();
    }
    function drawMood(c) {
      const m = S.m; if (!m.mood.length) return;
      const g = GUTTER(); const W = S.W;
      const y0 = S.H - TL_H - MOOD_H + 4; const y1 = S.H - TL_H - 6; const ym = (y0 + y1) / 2; const amp = (y1 - y0) / 2;
      c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(g, ym, W - g, 1);
      const tA = tOfX(g - 20); const tB = tOfX(W + 20);
      let prev = null;
      c.lineCap = 'round';
      for (const p of m.mood) {
        if (p[0] < tA || p[0] > tB || p[0] > S.T) { prev = p[0] < tA ? p : null; continue; }
        if (prev && p[0] - prev[0] < 3 * HOUR) {
          const xa = xOfT(prev[0]); const xb = xOfT(p[0]);
          const va = prev[1]; const vb = p[1];
          c.strokeStyle = (va + vb) / 2 >= 0 ? 'rgba(255,214,150,.75)' : 'rgba(150,180,255,.75)';
          c.lineWidth = 1 + 3 * ((prev[2] + p[2]) / 2);
          c.beginPath(); c.moveTo(xa, ym - va * amp); c.lineTo(xb, ym - vb * amp); c.stroke();
        }
        prev = p;
      }
    }

    function draw2d(ts) {
      const c = gfx.ctx; const m = S.m; const W = S.W; const H = S.H;
      c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      if (!sprites) sprites = KINDS.map((k) => {
        const s = document.createElement('canvas'); s.width = s.height = 32;
        const x = s.getContext('2d'); const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, rgbCss(k.rgb, 1)); gr.addColorStop(0.32, rgbCss(k.rgb, 0.35)); gr.addColorStop(1, rgbCss(k.rgb, 0));
        x.fillStyle = gr; x.fillRect(0, 0, 32, 32); return s;
      });
      // 多了只画最亮的 LIMIT_2D 颗：按亮度分桶找门槛
      let thr = 0;
      if (m.n > LIMIT_2D) {
        const hist = new Int32Array(256);
        for (let i = 0; i < m.n; i++) if (alphaF[i]) hist[Math.min(255, (bright[i] * 255) | 0)]++;
        let acc = 0; for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= LIMIT_2D) { thr = b / 255; break; } }
      }
      c.globalCompositeOperation = 'lighter';
      const z = zoomNow(); const tw = reduced() ? 0 : 1; const t = ts / 1000;
      for (let i = 0; i < m.n; i++) {
        const b = bright[i] * alphaF[i];
        if (b < 0.0005 || bright[i] < thr) continue;
        const [x, y] = scr(i);
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        const sz = sizeOf(m.w1[i]) * z * (0.72 + 0.5 * bright[i]) * (1 + flash[i] * 0.9) * 3.2;
        c.globalAlpha = clamp(b * (1 + tw * 0.1 * Math.sin(t * (0.6 + m.seed[i] * 1.9) + m.seed[i] * 61)) + flash[i] * 0.7, 0, 1);
        if (ghost[i] || styleOf(i) === 2 || styleOf(i) === 3) {
          c.strokeStyle = rgbCss(ghost[i] ? [170, 175, 185] : KINDS[m.kind[i]].rgb); c.lineWidth = 1;
          c.beginPath(); c.arc(x, y, sz * 0.13, 0, Math.PI * 2); c.stroke();
        } else c.drawImage(sprites[m.kind[i]], x - sz / 2, y - sz / 2, sz, sz);
      }
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    }

    const labelRects = [];   // 这一帧画出来的人名：[x0, y0, x1, y1, pi]
    function drawFg(fx, ts) {
      const c = ctxFg; const m = S.m; const W = S.W; const H = S.H;
      c.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      labelRects.length = 0;
      if (!m.n) return;
      const a0 = clamp(1 - S.mix * 2.2, 0, 1); const a1 = clamp((S.mix - 0.45) / 0.55, 0, 1);
      // 连线、圆环（在名字下面）
      drawLines(c, fx, a0, a1, ts);
      drawRings(c, fx);
      if (a0 > 0) { c.globalAlpha = a0; drawPeopleLabels(c, fx); c.globalAlpha = 1; }
      if (a1 > 0) { c.globalAlpha = a1; drawLaneLabels(c); c.globalAlpha = 1; }
      // T 在时间河里的位置
      if (a1 > 0 && !S.live) {
        const x = xOfT(S.T);
        if (x > GUTTER()) {
          c.globalAlpha = a1; c.fillStyle = 'rgba(255,255,255,.5)'; c.fillRect(Math.round(x), TOP1 - 6, 1, H - TOP1 - TL_H + 2); c.globalAlpha = 1;
        }
      }
      // 搜到的星：一圈淡淡的环（别的星暗下去）
      if (S.search) { let k = 0; for (const i of S.search) { if (k++ > 300) break; ringAt(c, i, 'rgba(255,236,170,.75)', 1.2, 7); } }
      // 选中、悬停的星
      if (S.sel >= 0) ringAt(c, S.sel, 'rgba(255,255,255,.95)', 1.6, 11);
      if (S.hoverStar >= 0 && S.hoverStar !== S.sel) ringAt(c, S.hoverStar, 'rgba(255,255,255,.6)', 1.2, 9);
      drawHud(c, fx);
    }
    function ringAt(c, i, color, lw, r) {
      if (!bright[i] || !alphaF[i]) return;
      const [x, y] = scr(i);
      c.strokeStyle = color; c.lineWidth = lw; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    }
    function roundRect(c, x, y, w, hh, r) {
      c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r); c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    /** 她的位置（按人时连线的终点）。 */
    const herAt = () => { const d = S.lp.discs[0]; return [d.x * S.cam0.sx + S.cam0.ox, d.y * S.cam0.sy + S.cam0.oy]; };
    const laneY = (k) => { const ln = S.lt.laneOf.get(k); return ln ? ln.yc * S.cam1.sy + S.cam1.oy : null; };
    function lineStyle(c, kind) {
      if (kind === 'tell') { c.strokeStyle = TELL_CSS; c.setLineDash([]); } else { c.strokeStyle = LAYERS[kind].css; c.setLineDash([4, 4]); }
    }
    function drawLink(c, i, kind, ts0, place, alpha, a0, a1) {
      const [sx, sy] = scr(i);
      lineStyle(c, kind);
      c.lineWidth = kind === 'tell' ? 1.1 : 1.2;
      if (a0 > 0) {
        const [hx, hy] = herAt();
        c.globalAlpha = alpha * a0;
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(hx, hy); c.stroke();
      }
      if (a1 > 0) {
        const y = laneY(place); if (y == null) return;
        const x = xOfT(ts0);
        const mx = (sx + x) / 2; const lift = Math.min(140, Math.abs(x - sx) * 0.28 + Math.abs(y - sy) * 0.4 + 18);
        c.globalAlpha = alpha * a1;
        c.beginPath(); c.moveTo(sx, sy); c.quadraticCurveTo(mx, Math.min(sy, y) - lift, x, y); c.stroke();
        c.setLineDash([]); c.fillStyle = c.strokeStyle; c.beginPath(); c.arc(x, y, 2.2, 0, Math.PI * 2); c.fill();
      }
    }
    function drawLines(c, fx, a0, a1) {
      const m = S.m;
      c.save();
      for (const l of fx.lines) drawLink(c, l.i, l.kind, l.ts, l.place, (l.kind === 'tell' ? 0.55 : 0.8) * Math.pow(1 - l.p, 1.2) * alphaF[l.i], a0, a1);
      // 选中的星：它全部的想起和说起
      if (S.sel >= 0 && bright[S.sel]) {
        const recs = (m.recOf.get(S.sel) ?? []).filter((r) => r[0] <= S.T);
        const tels = (m.telOf.get(S.sel) ?? []).filter((r) => r[0] <= S.T);
        if (a1 > 0) {
          for (const r of recs.slice(-60)) drawLink(c, S.sel, r[2], r[0], r[1], 0.55, 0, a1);
          for (const r of tels.slice(-30)) drawLink(c, S.sel, 'tell', r[0], r[1], 0.7, 0, a1);
        }
        if (a0 > 0 && (recs.length || tels.length)) drawLink(c, S.sel, tels.length && !recs.length ? 'tell' : recs.at(-1)?.[2] ?? 1, 0, -1, 0.65, a0, 0);
      }
      c.restore();
    }
    /** 底部（时间轴上面）浮出刚才是在哪儿想起、说起的：最近的几个场合，一个一枚，慢慢淡掉。 */
    function drawHud(c, fx) {
      const items = [];
      const seen = new Set();
      for (const x of fx.places) { const key = `${x.place}:${x.tell}`; if (seen.has(key)) continue; seen.add(key); items.push(x); if (items.length >= (S.narrow ? 2 : 3)) break; }
      const rows = [];
      if (fx.night && fx.night.n && !S.live) rows.push({ night: true, p: fx.night.p, text: `夜里 ${pad2(new Date(fx.night.t).getHours())}:${pad2(new Date(fx.night.t).getMinutes())} 整理记忆：重温了 ${fmtInt(fx.night.n)} 条` });
      for (const x of items) rows.push({ tell: x.tell, p: x.p, text: `在「${clipChars(placeName(x.place), 12)}」${x.tell ? '说起' : '想起'}` });
      if (!rows.length) return;
      c.save();
      c.font = '12px system-ui, sans-serif'; c.textBaseline = 'middle'; c.textAlign = 'left';
      const ws = rows.map((r) => c.measureText(r.text).width + (r.night ? 34 : 30));
      const gap = 8; const total = ws.reduce((x, y) => x + y, 0) + gap * (rows.length - 1);
      // 按时间时底下是心境曲线：宽的时候挪到右上角（左上是图例），窄的时候放在心境上面
      const timeView = S.mix > 0.5;
      const top = timeView && S.W >= 900;
      let x = top ? S.W - total - 16 : Math.max(12, (S.W - total) / 2);
      const y = top ? (note.hidden ? 26 : 60) : timeView ? S.H - TL_H - MOOD_H - 10 : S.H - TL_H - 18;
      rows.forEach((r, k) => {
        const w = ws[k];
        c.globalAlpha = clamp(1.15 - r.p, 0, 1);
        c.fillStyle = 'rgba(12,16,28,.86)'; roundRect(c, x, y - 12, w, 24, 12); c.fill();
        c.strokeStyle = r.night ? 'rgba(191,203,255,.35)' : 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.stroke();
        if (r.night) moon(c, x + 15, y, 4.5, 1);
        else {
          c.strokeStyle = r.tell ? TELL_CSS : LAYERS[1].css; c.lineWidth = 1.4; c.setLineDash(r.tell ? [] : [3, 3]);
          c.beginPath(); c.moveTo(x + 9, y); c.lineTo(x + 21, y); c.stroke(); c.setLineDash([]);
        }
        c.fillStyle = r.night ? '#E3E8FF' : '#E8ECF4'; c.fillText(r.text, x + (r.night ? 26 : 26), y + 0.5);
        x += w + gap;
      });
      c.restore();
    }
    const clipChars = (t, n) => { const ch = [...String(t)]; return ch.length > n ? `${ch.slice(0, n).join('')}…` : String(t); };
    function drawRings(c, fx) {
      const m = S.m; const calm = reduced();
      c.save();
      for (const [i, r, p] of fx.rings) {
        const [x, y] = scr(i);
        if (x < -30 || y < -30 || x > S.W + 30 || y > S.H + 30) continue;
        const a = Math.pow(1 - p, 1.4);
        if (r === 7) {
          // 夜里重温：整批柔和地亮（不扩散，一圈淡淡的月光）
          c.strokeStyle = MOON_CSS; c.globalAlpha = a * 0.5; c.lineWidth = 1;
          c.beginPath(); c.arc(x, y, calm ? 7 : 5 + p * 6, 0, Math.PI * 2); c.stroke();
        } else if (r === 0) {
          // 记下：出生，一圈种类色的环往外扩
          c.strokeStyle = rgbCss(KINDS[m.kind[i]].rgb); c.globalAlpha = a * 0.7; c.lineWidth = 1.2;
          c.beginPath(); c.arc(x, y, calm ? 8 : 3 + easeOut(p) * 13, 0, Math.PI * 2); c.stroke();
        } else {
          c.strokeStyle = '#ffffff'; c.globalAlpha = a * 0.45; c.lineWidth = 1;
          c.beginPath(); c.arc(x, y, calm ? 6 : 3 + easeOut(p) * 9, 0, Math.PI * 2); c.stroke();
        }
      }
      c.restore();
    }
    function drawPeopleLabels(c) {
      const m = S.m; const cam = S.cam0;
      c.textBaseline = 'middle'; c.textAlign = 'center';
      const placed = [];
      const hit = (r) => placed.some((q) => !(r[2] < q[0] || r[0] > q[2] || r[3] < q[1] || r[1] > q[3]));
      for (const d of S.lp.discs) {
        if (!d.n && d.pi !== 0) continue;
        const x = d.x * cam.sx + cam.ox; const yTop = (d.y - d.r) * cam.sy + cam.oy;
        // 名字太长（真实库里有 15 个字的）只写前 8 个字，全名在悬停和详情卡里
        const name = d.pi === -1 ? '没认出是谁的' : clipChars(personName(d.pi), 8);
        const big = d.pi <= 1;
        c.font = `600 ${big ? 13 : 12}px system-ui, sans-serif`;
        const nw = c.measureText(name).width;
        c.font = '11px system-ui, sans-serif';
        const cnt = fmtInt(d.n); const cw = c.measureText(cnt).width;
        const w = nw + cw + 22; const hh = big ? 22 : 20;
        const y = yTop - hh / 2 - 4;
        const rect = [x - w / 2, y - hh / 2, x + w / 2, y + hh / 2, d.pi];
        if (rect[2] < 0 || rect[0] > S.W || rect[3] < 0 || rect[1] > S.H - TL_H) continue;
        // 星很少的人（真实库里很多只有一两颗）：镜头拉近到他那团够大、或者悬停时才写名字，名字不压过星
        if (d.pi > 1 && d.n < 6 && d.r * cam.sx < 16 && S.hoverPerson !== d.pi) continue;
        if (hit(rect) && d.pi !== 0 && d.pi !== 1) continue;
        placed.push(rect); labelRects.push(rect);
        const on = S.hoverPerson === d.pi;
        const covers = [S.sel, S.hoverStar].some((i) => { if (i < 0 || !bright[i]) return false; const [sx, sy] = scr(i); return sx >= rect[0] - 4 && sx <= rect[2] + 4 && sy >= rect[1] - 4 && sy <= rect[3] + 4; });
        const dim = (S.hoverPerson > -2 && !on) || covers;
        c.save();
        if (dim) c.globalAlpha *= 0.45;
        c.fillStyle = on ? 'rgba(255,255,255,.18)' : 'rgba(9,12,22,.72)';
        roundRect(c, rect[0], rect[1], w, hh, hh / 2); c.fill();
        c.strokeStyle = on ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.stroke();
        c.textAlign = 'left';
        c.font = `600 ${big ? 13 : 12}px system-ui, sans-serif`; c.fillStyle = '#F2F4F8';
        c.fillText(name, rect[0] + 10, y + 0.5);
        c.font = '11px system-ui, sans-serif'; c.fillStyle = 'rgba(232,236,244,.6)';
        c.fillText(cnt, rect[0] + 14 + nw, y + 0.5);
        c.restore();
      }
    }
    function drawLaneLabels(c) {
      const m = S.m; const g = GUTTER(); const H = S.H;
      // 左边的栏：盖住滑到下面的星，写河道名字
      const gr = c.createLinearGradient(0, 0, g + 18, 0);
      gr.addColorStop(0, 'rgba(6,8,15,.96)'); gr.addColorStop(g / (g + 18), 'rgba(6,8,15,.9)'); gr.addColorStop(1, 'rgba(6,8,15,0)');
      c.fillStyle = gr; c.fillRect(0, TOP1 - 30, g + 18, H - TOP1 + 30 - TL_H + 4);
      c.textAlign = 'left'; c.textBaseline = 'middle';
      for (const ln of S.lt.lanes) {
        const y0 = ln.y0 * S.cam1.sy + S.cam1.oy; const y1 = ln.y1 * S.cam1.sy + S.cam1.oy; const yc = (y0 + y1) / 2;
        const title = placeName(ln.place);
        c.font = '600 12px system-ui, sans-serif'; c.fillStyle = '#E8ECF4';
        const two = y1 - y0 >= 34;
        fitText(c, title, 14, two ? yc - 7 : yc, g - 18);
        if (two) { c.font = '11px system-ui, sans-serif'; c.fillStyle = 'rgba(232,236,244,.55)'; c.fillText(`${fmtInt(ln.n)} 颗`, 14, yc + 9); }
      }
      if (S.m.mood.length) {
        const y0 = S.H - TL_H - MOOD_H + 4; const y1 = S.H - TL_H - 6;
        c.font = '600 12px system-ui, sans-serif'; c.fillStyle = '#E8ECF4'; c.fillText('心境', 14, (y0 + y1) / 2);
        c.font = '11px system-ui, sans-serif'; c.fillStyle = 'rgba(255,214,150,.75)'; c.fillText('好', g - 22, y0 + 6);
        c.fillStyle = 'rgba(150,180,255,.75)'; c.fillText('低落', g - 34, y1 - 5);
      }
    }
    function fitText(c, text, x, y, max) {
      let t = text;
      if (c.measureText(t).width > max) { const chars = [...t]; while (chars.length > 1 && c.measureText(`${chars.join('')}…`).width > max) chars.pop(); t = `${chars.join('')}…`; }
      c.fillText(t, x, y);
    }

    function drawTrack() {
      if (!S.m) return;
      const c = trackCv.getContext('2d'); const dpr = S.dpr || 1;
      const W = trackCv.width / dpr; const H = trackCv.height / dpr;
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
      const m = S.m; const end = serverNow(); const span = Math.max(1, end - m.t0);
      const X = (t) => 8 + ((t - m.t0) / span) * (W - 16);
      const bins = Math.max(20, Math.min(240, Math.floor((W - 16) / 4)));
      const cnt = new Int32Array(bins);
      for (let i = 0; i < m.n; i++) cnt[clamp(Math.floor(((m.t[i] - m.t0) / span) * bins), 0, bins - 1)]++;
      const max = Math.max(1, ...cnt);
      const bh = 14; const by = 16;
      const bw = (W - 16) / bins;
      const xT = X(S.T);
      for (let b = 0; b < bins; b++) {
        const x = 8 + b * bw; const hh = Math.max(cnt[b] ? 1.5 : 0, Math.sqrt(cnt[b] / max) * bh);
        c.fillStyle = x + bw <= xT ? 'rgba(232,236,244,.55)' : 'rgba(232,236,244,.2)';
        c.fillRect(x + 0.5, by - hh, Math.max(1, bw - 1), hh);
      }
      c.fillStyle = 'rgba(255,255,255,.14)'; c.fillRect(8, by + 1, W - 16, 1);
      let lastMoon = -1e9;
      for (const t of m.nights) { const x = X(t); if (x - lastMoon < 9) continue; moon(c, x, 3.5, 2.6, 0.8); lastMoon = x; }
      // 日期
      c.font = '11px system-ui, sans-serif'; c.textBaseline = 'top'; c.fillStyle = 'rgba(232,236,244,.5)';
      const ticks = timeTicks(m.t0, end, (W - 16) / span).filter((x) => x.major || x.label.includes('/'));
      let lastX = -1e9;
      for (const tk of ticks) {
        const x = X(tk.t); if (x - lastX < 40 || x > W - 22) continue;
        c.textAlign = 'center'; c.fillText(tk.label, x, by + 4); lastX = x;
      }
      // 游标
      c.fillStyle = '#fff'; c.fillRect(Math.round(xT) - 0.5, 1, 1.5, by + 1);
      c.beginPath(); c.arc(xT, by + 1, 4.5, 0, Math.PI * 2); c.fill();
      if (S.live) { c.strokeStyle = 'rgba(123,227,176,.8)'; c.lineWidth = 1.5; c.beginPath(); c.arc(xT, by + 1, 7, 0, Math.PI * 2); c.stroke(); }
    }
    let trackRaf = 0;
    const trackLater = () => { if (!trackRaf) trackRaf = requestAnimationFrame(() => { trackRaf = 0; drawTrack(); }); };
    let lastTrackT = 0;
    const trackTick = () => { if (Math.abs(S.T - lastTrackT) > 1000 || S.playing || S.dragging) { lastTrackT = S.T; trackLater(); } };

    // ── 悬停、点选 ──
    function nearestStar(px, py, maxD = 14) {
      const m = S.m; let best = -1; let bd = maxD * maxD;
      for (let i = 0; i < m.n; i++) {
        if (!bright[i] || alphaF[i] < 0.5) continue;
        const [x, y] = scr(i); const dx = x - px; const dy = y - py; const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    const labelAt = (x, y) => (S.mix < 0.3 ? labelRects.find((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) : null);
    function discAt(x, y) {
      if (S.mix > 0.3) return -2;
      const wx = (x - S.cam0.ox) / S.cam0.sx; const wy = (y - S.cam0.oy) / S.cam0.sy;
      for (const d of S.lp.discs) if (d.n && Math.hypot(wx - d.x, wy - d.y) <= d.r) return d.pi;
      return -2;
    }
    function kindLine(i) {
      const m = S.m; const sub = SUB[m.sub[i]];
      return sub && sub !== KINDS[m.kind[i]].name ? `${KINDS[m.kind[i]].name}（${sub}）` : KINDS[m.kind[i]].name;
    }
    function aboutWho(i) { const w = S.m.who[i]; return w.length ? w.slice(0, 3).map(personName).join('、') : '没认出是谁'; }
    function showTip(i, px, py) {
      const m = S.m;
      const head = `${aboutWho(i)} · ${kindLine(i)} · ${fmtWhen(m.t[i])} · ${placeName(m.place[i])}`;
      const peek = S.demo ? null : peekCache.get(m.ref[i]);
      const txt = S.demo ? '演示模式：不显示内容' : peek === undefined ? '…' : peek ? (peek.title && peek.text && !peek.text.startsWith(peek.title) ? `${peek.title}：${peek.text}` : peek.text || peek.title || '（没有文字）') : '（读不到内容）';
      const extra = [`${S.live ? '此刻' : '这时'}的亮度 ${Math.round(bright[i] * 100)}%`, ghost[i] ? '已经被新的说法取代' : m.st[i] === 2 ? '已经过时' : null, (m.recOf.get(i)?.length ? `想起过 ${m.recOf.get(i).filter((r) => r[0] <= S.T).length} 次` : null)].filter(Boolean).join(' · ');
      clear(tip, h('div', { class: 'm' }, h('i', { class: 'dot' }), head), h('div', { class: 'x' }, txt), h('div', { class: 'm s' }, extra));
      tip.querySelector('.dot').style.background = rgbCss(KINDS[m.kind[i]].rgb);
      tip.hidden = false;
      const tw = tip.offsetWidth; const th = tip.offsetHeight;
      let x = px + 14; let y = py + 14;
      if (x + tw > S.W - 8) x = px - tw - 14;
      if (y + th > S.H - TL_H) y = py - th - 14;
      tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
      if (!S.demo && peek === undefined) wantPeek(m.ref[i]);
    }
    function hideTip() { tip.hidden = true; }
    function wantPeek(ref) {
      peekWant.add(ref);
      clearTimeout(peekTimer);
      peekTimer = setTimeout(async () => {
        const refs = [...peekWant].filter((r) => !peekCache.has(r)).slice(0, 24); peekWant.clear();
        if (!refs.length) return;
        try {
          const r = await api.get('starmapPeek', { refs: refs.join(',') });
          for (const ref of refs) peekCache.set(ref, null);
          for (const x of r?.items ?? []) if (x?.ref) peekCache.set(x.ref, x);
        } catch { for (const ref of refs) peekCache.delete(ref); return; }
        if (S.hoverStar >= 0 && refs.includes(S.m.ref[S.hoverStar]) && !tip.hidden) showTip(S.hoverStar, lastPointer[0], lastPointer[1]);
        if (S.sel >= 0 && refs.includes(S.m.ref[S.sel])) showCard(S.sel, true);
      }, 120);
    }
    const lastPointer = [0, 0];
    let ptr = null;
    function localXY(e) { const r = sky.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    const inUi = (e) => !!e.target.closest?.('.pm-sm-tl, .pm-sm-card, .pm-sm-cap-link');
    sky.addEventListener('pointerdown', (e) => {
      if (inUi(e) || !S.m?.n || e.button !== 0) return;
      const [x, y] = localXY(e);
      ptr = { id: e.pointerId, x, y, moved: false, cam: { ...camOf(S.view === 'people' ? 0 : 1) } };
      sky.setPointerCapture(e.pointerId);
    });
    sky.addEventListener('pointermove', (e) => {
      if (!S.m?.n) return;
      const [x, y] = localXY(e); lastPointer[0] = x; lastPointer[1] = y;
      if (ptr && ptr.id === e.pointerId) {
        const dx = x - ptr.x; const dy = y - ptr.y;
        if (!ptr.moved && Math.hypot(dx, dy) > 4) { ptr.moved = true; S.tween = null; hideTip(); sky.classList.add('grab'); }
        if (ptr.moved) {
          if (S.view === 'people') { S.cam0.ox = ptr.cam.ox + dx; S.cam0.oy = ptr.cam.oy + dy; S.moved0 = true; } else { S.cam1.ox = ptr.cam.ox + dx; S.moved1 = true; }
          clampCams(); kick();
        }
        return;
      }
      if (inUi(e)) { if (S.hoverStar >= 0 || S.hoverPerson > -2) { S.hoverStar = -1; setHoverPerson(-2); hideTip(); } return; }
      hoverAt(x, y);
    });
    function hoverAt(x, y) {
      const lab = labelAt(x, y);
      if (lab) { setHoverPerson(lab[4]); S.hoverStar = -1; hideTip(); sky.style.cursor = 'pointer'; return; }
      setHoverPerson(-2);
      const i = nearestStar(x, y);
      S.hoverStar = i;
      sky.style.cursor = i >= 0 ? 'pointer' : '';
      if (i >= 0) showTip(i, x, y); else hideTip();
      kick();
    }
    function setHoverPerson(pi) { if (S.hoverPerson !== pi) { S.hoverPerson = pi; S.alphaDirty = true; kick(); } }
    sky.addEventListener('pointerup', (e) => {
      if (!ptr || ptr.id !== e.pointerId) return;
      const moved = ptr.moved; ptr = null; sky.classList.remove('grab');
      if (moved) return;
      const [x, y] = localXY(e);
      const lab = labelAt(x, y);
      if (lab) { focusPerson(lab[4]); return; }
      const i = nearestStar(x, y);
      if (i >= 0) select(i); else if (S.sel >= 0) select(-1);
    });
    sky.addEventListener('pointercancel', () => { ptr = null; sky.classList.remove('grab'); });
    sky.addEventListener('pointerleave', () => { if (!ptr) { S.hoverStar = -1; setHoverPerson(-2); hideTip(); sky.style.cursor = ''; kick(); } });
    sky.addEventListener('dblclick', (e) => {
      if (inUi(e) || !S.m?.n) return;
      const [x, y] = localXY(e);
      if (S.view === 'people') { const pi = discAt(x, y); if (pi > -2) focusPerson(pi); }
      else if (x > GUTTER()) {
        // 按时间：双击放大到这一天
        const t = tOfX(x); const sx = (S.W - GUTTER() - 28) / 24; S.moved1 = true;
        const d = new Date(t); d.setHours(0, 0, 0, 0);
        tweenTo(1, { ...S.cam1, sx, ox: GUTTER() + 6 - ((d.getTime() - S.m.t0) / HOUR) * sx });
      }
    });
    sky.addEventListener('wheel', (e) => {
      if (!S.m?.n || inUi(e)) return;
      e.preventDefault();
      const [x, y] = localXY(e);
      const k = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0016);
      S.tween = null;
      if (S.view === 'people') { const c = S.cam0; c.ox = x - (x - c.ox) * k; c.oy = y - (y - c.oy) * k; c.sx *= k; c.sy *= k; S.moved0 = true; }
      else { const c = S.cam1; const ax = Math.max(GUTTER(), x); c.ox = ax - (ax - c.ox) * k; c.sx *= k; S.moved1 = true; }
      clampCams(); hideTip(); kick();
    }, { passive: false });
    sky.addEventListener('keydown', (e) => {
      if (e.target !== sky || !S.m?.n) return;
      const c = camOf(S.view === 'people' ? 0 : 1);
      const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
      if (pan) { e.preventDefault(); c.ox += pan[0]; if (S.view === 'people') c.oy += pan[1]; if (S.view === 'people') S.moved0 = true; else S.moved1 = true; clampCams(); kick(); return; }
      if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
        e.preventDefault(); const k = e.key === '-' || e.key === '_' ? 1 / 1.25 : 1.25; const ax = S.W / 2; const ay = S.H / 2;
        c.ox = ax - (ax - c.ox) * k; c.sx *= k; if (S.view === 'people') { c.oy = ay - (ay - c.oy) * k; c.sy *= k; S.moved0 = true; } else S.moved1 = true;
        clampCams(); kick(); return;
      }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
      if (e.key === 'Escape') { e.preventDefault(); escape(); }
    });
    function escape() {
      if (S.sel >= 0) { select(-1); return; }
      if ((S.view === 'people' && S.moved0) || (S.view === 'time' && S.moved1)) { resetCam(); return; }
      if (S.max) setMax(false);
    }

    // ── 详情卡 ──
    function select(i) {
      S.sel = i;
      if (i >= 0) showCard(i); else hideCard();
      kick();
    }
    function hideCard() { card.hidden = true; clear(card); }
    function showCard(i, refresh = false) {
      const m = S.m;
      if (!refresh || card.hidden) card.scrollTop = 0;
      const ref = m.ref[i];
      const peek = S.demo ? null : peekCache.get(ref);
      if (!S.demo && peek === undefined) wantPeek(ref);
      const dot = h('i', { class: 'dot' }); dot.style.background = rgbCss(KINDS[m.kind[i]].rgb);
      const recs = m.recOf.get(i) ?? []; const tels = m.telOf.get(i) ?? [];
      const supBy = m.sup[i] >= 0 ? m.sup[i] : -1; const replaced = m.supBy[i];
      const status = m.st[i] === 1 ? '被新的说法取代了' : m.st[i] === 2 ? (m.sub[i] === 'intention' ? '做过了 / 不做了' : '过时了') : m.sub[i] === 'intention' ? '想着，还没到时候' : '现在成立';
      const when = Number.isFinite(m.t2[i]) && m.t2[i] - m.t[i] > MIN ? `${fmtWhen(m.t[i], true)} – ${pad2(new Date(m.t2[i]).getHours())}:${pad2(new Date(m.t2[i]).getMinutes())}` : fmtWhen(m.t[i], true);
      const row = (k, v) => (v == null || v === '' ? null : [h('dt', null, k), h('dd', null, v)]);
      const jump = (j, text) => h('button', { type: 'button', class: 'pm-link', onclick: () => { select(j); focusStar(j); } }, text);
      const curve = h('canvas', { class: 'pm-sm-curve', 'aria-hidden': 'true' });
      const nowB = bright[i];
      const body = S.demo ? h('p', { class: 'pm-sm-card-txt muted' }, '演示模式：不显示内容')
        : peek === undefined ? h('p', { class: 'pm-sm-card-txt muted' }, '正在读这条记忆…')
          : peek ? h('div', { class: 'pm-sm-card-txt' }, peek.title ? h('b', null, peek.title) : null, peek.text && peek.text !== peek.title ? h('p', null, peek.text) : null)
            : h('p', { class: 'pm-sm-card-txt muted' }, '读不到内容（可能刚被隐藏或删掉）');
      const last = recs.filter((r) => r[0] <= S.T).slice(-5).reverse();
      clear(card,
        h('div', { class: 'pm-sm-card-h' }, dot, h('span', null, kindLine(i)), h('button', { type: 'button', class: 'pm-x', 'aria-label': '关掉', onclick: () => select(-1) }, '×')),
        body,
        h('dl', { class: 'pm-sm-dl' },
          row('什么时候', when), row('在哪儿', placeName(m.place[i])), row('有关的人', aboutWho(i)),
          row('状态', [status, supBy >= 0 ? [' ', jump(supBy, '看新的那条')] : null, replaced >= 0 ? [' ', jump(replaced, '看旧的那条')] : null]),
          m.cert[i] ? row('从哪儿知道', CERT[m.cert[i]] ?? null) : null),
        h('div', { class: 'pm-sm-sec' },
          h('div', { class: 'pm-sm-sec-h' }, h('span', null, '亮度'), h('span', { class: 'v' }, `${S.live ? '此刻' : '这时'} ${Math.round(nowB * 100)}% · 痕迹 ${m.trStart[i + 1] - m.trStart[i]} 条`)),
          curve),
        h('div', { class: 'pm-sm-sec' },
          h('div', { class: 'pm-sm-sec-h' }, h('span', null, `想起过 ${recs.length} 次`), h('span', { class: 'v' }, tels.length ? `讲给别人 ${tels.length} 次` : '')),
          last.length ? h('ul', { class: 'pm-sm-recs' }, last.map((r) => { const ln = h('i', { class: 'ln' }); ln.style.setProperty('--c', LAYERS[r[2]].css); return h('li', null, ln, h('span', null, fmtWhen(r[0])), h('span', { class: 'p' }, `在「${placeName(r[1])}」· ${LAYERS[r[2]].name}`)); }))
            : h('p', { class: 'pm-faint' }, recs.length ? '这个时刻之前还没想起过' : '还没被想起过')),
        h('div', { class: 'pm-sm-card-f' }, h('span', { class: 'pm-faint pm-mono' }, ref), h('button', { type: 'button', class: 'pm-btn sm', onclick: () => deps.openMemory?.(ref) }, '打开这条记忆')));
      card.hidden = false;
      requestAnimationFrame(() => drawCurve(curve, i));
    }
    function drawCurve(cv, i) {
      const m = S.m; const dpr = S.dpr || 1;
      const W = cv.clientWidth || 280; const H = cv.clientHeight || 76;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t0 = m.t[i]; const t1 = Math.max(serverNow(), t0 + HOUR);
      const X = (t) => 6 + ((t - t0) / (t1 - t0)) * (W - 12);
      const top = 16; const bot = H - 14;
      const Y = (b) => bot - b * (bot - top);
      c.fillStyle = 'rgba(255,255,255,.06)'; c.fillRect(6, Y(0.5), W - 12, 1);
      const col = KINDS[m.kind[i]].rgb;
      c.beginPath();
      const N = 140;
      for (let k = 0; k <= N; k++) {
        const t = t0 + ((t1 - t0) * k) / N;
        const st = m.st[i] === 1 && (m.sup[i] < 0 || m.t[m.sup[i]] <= t);
        const b = brightOf(starB(m, i, t), st);
        if (k) c.lineTo(X(t), Y(b)); else c.moveTo(X(t), Y(b));
      }
      c.strokeStyle = rgbCss(col, 0.95); c.lineWidth = 1.6; c.stroke();
      c.lineTo(X(t1), bot); c.lineTo(X(t0), bot); c.closePath();
      const gr = c.createLinearGradient(0, top, 0, bot); gr.addColorStop(0, rgbCss(col, 0.25)); gr.addColorStop(1, rgbCss(col, 0)); c.fillStyle = gr; c.fill();
      // 每条痕迹一个刻度
      for (let j = m.trStart[i]; j < m.trStart[i + 1]; j++) {
        const r = m.trR[j]; const x = X(m.trT[j]);
        c.fillStyle = r === 7 ? MOON_CSS : r === 0 ? rgbCss(col) : 'rgba(255,255,255,.75)';
        c.fillRect(Math.round(x) - 0.5, bot + 3, 1.5, r === 0 ? 7 : 5);
      }
      // T
      if (!S.live) { const x = X(S.T); c.fillStyle = 'rgba(255,255,255,.6)'; c.fillRect(Math.round(x), top - 2, 1, bot - top + 4); }
      c.font = '10.5px system-ui, sans-serif'; c.fillStyle = 'rgba(232,236,244,.5)'; c.textBaseline = 'top';
      c.textAlign = 'left'; c.fillText(`${new Date(t0).getMonth() + 1}/${new Date(t0).getDate()} 记下`, 6, 3);
      c.textAlign = 'right'; c.fillText('现在', W - 6, 3);
    }

    // ── 工具条 ──
    let searchTimer = 0; let searchSeq = 0;
    async function runSearch(q) {
      const seq = ++searchSeq;
      S.searchQ = q;
      if (!q) { S.search = null; searchInfo.hidden = true; S.alphaDirty = true; kick(); return; }
      searchInfo.hidden = false; clear(searchInfo, '在搜…');
      try {
        const lists = await Promise.all(['assertions', 'episodes'].map((list) => api.get('memories', { list, q, limit: 200 }).catch(() => ({ items: [] }))));
        if (seq !== searchSeq) return;
        const set = new Set();
        for (const l of lists) for (const x of l.items ?? []) { const i = S.m.refIdx.get(x.ref); if (i != null) set.add(i); }
        S.search = set; S.alphaDirty = true;
        clear(searchInfo, set.size ? `搜到 ${fmtInt(set.size)} 颗` : '没有搜到', h('button', { type: 'button', class: 'pm-x sm', 'aria-label': '清掉搜索', onclick: () => { searchIn.value = ''; runSearch(''); } }, '×'));
        kick();
      } catch (e) { if (seq === searchSeq) clear(searchInfo, `搜不了：${e?.message ?? e}`); }
    }
    searchIn.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(searchIn.value.trim()), 450); });
    searchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(searchIn.value.trim()); } if (e.key === 'Escape' && searchIn.value) { e.stopPropagation(); searchIn.value = ''; runSearch(''); } });
    demoBtn.addEventListener('click', () => {
      S.demo = !S.demo; store.set(DEMO_KEY, S.demo ? '1' : null); demoBtn.setAttribute('aria-pressed', String(S.demo));
      if (S.m) { fillPlaces(); if (S.sel >= 0) showCard(S.sel, true); }
      hideTip(); kick();
    });
    function setMax(on) {
      S.max = on;
      if (!on && document.fullscreenElement === root) document.exitFullscreen?.().catch(() => {});
      root.classList.toggle('max', on);
      document.documentElement.classList.toggle('pm-sm-maxed', on);
      maxBtn.replaceChildren(icon(on ? IC.min : IC.max), h('span', null, on ? '缩回' : '放大'));
      maxBtn.title = on ? '缩回（Esc）' : '放大';
      requestAnimationFrame(() => { fitHeight(); resize(true); });
    }
    maxBtn.addEventListener('click', async () => {
      const want = !S.max;
      // 能全屏就全屏（单独打开时）；在 DSH 的 iframe 里没有全屏权限，就填满 iframe
      if (want && document.fullscreenEnabled && root.requestFullscreen) { try { await root.requestFullscreen(); S.fs = true; setMax(true); return; } catch { /* 填满 iframe */ } }
      if (!want && document.fullscreenElement) { try { await document.exitFullscreen(); } catch { /* 已经退了 */ } }
      setMax(want);
    });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.fs) { S.fs = false; if (S.max) setMax(false); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.max && S.visible && e.target === document.body) { e.preventDefault(); escape(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.visible) { kick(); schedulePoll(); } });
    reduceMq.addEventListener?.('change', () => { if (reduced()) { S.mixAnim = null; S.mix = S.view === 'time' ? 1 : 0; } kick(); });
    if (typeof ResizeObserver === 'function') { new ResizeObserver(() => { resize(); trackLater(); }).observe(sky); new ResizeObserver(() => { if (S.visible) fitHeight(); }).observe(bar); }
    window.addEventListener('resize', () => { if (S.visible) fitHeight(); });


    const self = {
      show() {
        S.visible = true;
        fitHeight();
        if (!S.m && !S.loading) load(); else { resize(true); kick(); schedulePoll(); }
      },
      hide() { S.visible = false; cancelAnimationFrame(raf); raf = 0; lastTs = 0; clearTimeout(pollTimer); hideTip(); if (S.max) setMax(false); },
      refresh() { return load(true); },
      /** 调试和截图验收用：画法、星数、最近的帧耗时（毫秒）。 */
      stats() {
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
        const sorted = [...frameMs].sort((a, b) => a - b);
        return { renderer: gfx?.kind ?? null, gpu: gfx?.info?.() ?? null, stars: S.m?.n ?? 0, frames: frameMs.length, cpuMs: avg(frameMs), p95Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null, gapMs: avg(frameGap), view: S.view, mix: S.mix, live: S.live, T: S.T };
      },
      /** 调试和截图验收用：直接摆到某个状态。 */
      debug: {
        state: () => S, bright: (i) => bright[i],
        /** 按时间：放大到 hours 小时宽，从 t 开始。 */
        zoomTime: (t, hours) => { const sx = (S.W - GUTTER() - 28) / hours; S.moved1 = true; S.cam1 = { ...S.cam1, sx, ox: GUTTER() + 6 - ((t - S.m.t0) / HOUR) * sx }; clampCams(); kick(); },
        setT, setView, select, focusPerson, focusStar, togglePlay, goLive, setSpeed, hoverAt, runSearch, setMax,
        starAt: (ref) => S.m?.refIdx.get(ref) ?? -1, screenOf: (i) => scr(i), labelRects: () => labelRects.map((r) => [...r]),
      },
    };
    window.__pmStarmap.current = self;
    return self;
  }

  window.__pmStarmap = { mount, lib };
})();
