// 记忆（D171）：「她记得什么」。四个分段：
//   记忆 —— 一条一行的列表（事实、经历、打算、经验按时间混排，数据来自 admin.data?view=feed；原话、原文片段、夜里改过的、
//            已隐藏、已忘掉沿用 view=memories），搜索 + 类型 / 人 / 场合 / 时间四个下拉 + 排序 + 「选择」多选，按天分组，往下翻自动取；
//            点一行打开右侧的详情面板（#/memory/list?open=<引用>，刷新后还在）。
//   人物 —— 一个人一张卡（view=people，D161 的分组），点开是人物面板：印象、各场合的叫法、关系、关于他的记忆。
//   星图 —— starmap.client.js 的新挂载：星空和时间轴是它画的，工具条和选中那颗星的详情是这里用公共组件画的。
//   成长 —— 她的性格现在的样子、每一处变化（撤销这一处 / 回到这一版），清空在「更多」里。
// 筛选条件都在地址栏的参数里（type / who / place / time / from / to / q / order / at），刷新、前进后退、从别处跳过来都对。
// 规矩同 ui/README.md：全部用 DOM API 和文本节点建；样式在 memory.css，类名带 mem- 前缀；颜色只用 token。
Rugu.define('memory', (R) => {
  const { h, icon, fmt, metaLine, tag, btn } = R;
  const DAY = 86_400_000;
  // 星图工具条的「放大 / 缩回」（Lucide maximize-2 / minimize-2）。值得放进 base.js 的 ICONS；先在这里补上，不覆盖已有的
  R.ICONS.max ??= [['path', { d: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7' }]];
  R.ICONS.min ??= [['path', { d: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7' }]];

  // ════════════════════════════════════════════════════════════════════════
  // 说法（纯数据）
  // ════════════════════════════════════════════════════════════════════════
  /** 类型下拉：键 → 名字和怎么取。feed：合并的列表（核心 admin/feed.js）；list：旧的单种列表（view=memories）。 */
  const TYPES = {
    all: { label: '全部', feed: {} },
    fact: { label: '事实', feed: { kinds: 'fact' } },
    episode: { label: '经历', feed: { kinds: 'episode' } },
    intent: { label: '打算', feed: { kinds: 'intent' } },
    lesson: { label: '经验', feed: { kinds: 'lesson' } },
    unverified: { label: '还没验证的经验', feed: { kinds: 'lesson', lessonStatus: 'unverified' } },
    old: { label: '被取代的旧说法', feed: { kinds: 'fact,lesson', versions: 'old' } },
    quote: { label: '原话', list: 'percepts', search: true, place: true, who: true, rank: true },
    window: { label: '原文片段', list: 'windows', search: true, place: true, rank: true },
    check: { label: '夜里改过的', list: 'checks' },
    checkall: { label: '夜里核对过的', list: 'checks', extra: { all: '1' } },
    hidden: { label: '已隐藏', list: 'suppressed', extra: { state: 'hidden' } },
    forgotten: { label: '已忘掉', list: 'forgotten' },
  };
  const TIMES = { all: '全部时间', today: '今天', yesterday: '昨天', '7d': '最近 7 天', '30d': '最近 30 天' };
  const SOURCE = { stated: '亲口说的', confirmed: '确认过的', self_said: '她自己说的', hearsay: '听别人说的', inferred: '她猜的' };
  const SRC_MODE = { told_to_her: '对她说的', overheard: '她旁听到的', read: '她读到的', observed: '她看到的', relayed: '转述的', inferred: '她推断的',
    self_generated: '她自己想的', imported: '导入的' };
  const EP_KIND = { event: '经历', summary: '今天到目前为止', diary: '日记', lapse: '没做成的事', import: '导入的经历' };
  const INT_STATE = { formed: '她打算做的', armed: '到时候了', executed: '做过了', cancelled: '不做了', obsolete: '用不上了', lapsed: '错过了' };
  const PLAN = { planned: '打算做', in_progress: '在做', done: '做完了', cancelled: '取消了', missed: '错过了', unknown: '不确定' };
  const LESSON_ORIGIN = { owner: '你教的', tool: '她试出来的', confirmed: '你确认过', correction: '你纠正过', self: '她自己琢磨的', told: '别人说的', nightly: '夜里回顾时总结的' };
  const CHECK = { corrected: '改正了', changed: '后来变了', doubted: '把握降低了', confirmed: '核对过，没问题', unclear: '看不出来' };
  const KIND_NAME = { assertion: '事实', episode: '经历', entity: '人与物', intention: '打算', percept: '原话', window: '原文片段', impression: '印象', storyline: '故事线',
    community: '圈子', link: '认人的线索', fact: '事实', intent: '打算', lesson: '经验' };
  const REF_KIND = { p: 'percept', w: 'window', e: 'episode', a: 'assertion', n: 'entity', i: 'impression', t: 'intention', s: 'storyline', c: 'community', l: 'link' };
  const RESTRICT = { none: '平常：照常可以聊', soft: '谨慎：看场合再说', strict: '严格：只在当事人面前提' };
  const ADDR = { 'to-her': '对她说的', 'mentions-her': '提到她', ambient: '她旁听到的', 'by-her': '她说的' };
  const OP = { add: '多了一处', revise: '改了一处', remove: '去掉了一处', purge: '因为彻底删除去掉了几行' };
  /** 彻底删除时「连本机备份一起删」默认勾上（发布前审查定的；旧页面默认不勾）。 */
  const PURGE_ALSO_BACKUPS_DEFAULT = true;
  /** 列表里最多留多少行：再多就不自动往下取了（几千条时 DOM 不撑爆），提示用「跳到某一天」。 */
  const AUTO_MAX = 400;
  const HARD_MAX = 1000;

  // ════════════════════════════════════════════════════════════════════════
  // 纯函数（测试在 node 里直接调：lib）
  // ════════════════════════════════════════════════════════════════════════
  const clip = (s, n) => { const c = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return c.length > n ? `${c.slice(0, n).join('')}…` : c.join(''); };
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  /** 地址栏参数 → 列表的筛选条件（不认识的值退回默认）。 */
  function filtersOf(params = {}) {
    const p = params ?? {};
    const type = Object.hasOwn(TYPES, p.type) ? p.type : 'all';
    const time = p.time === 'range' || Object.hasOwn(TIMES, p.time) ? p.time : 'all';
    const order = p.order === 'asc' || (p.order === 'rank' && TYPES[type].rank && p.q) ? p.order : 'desc';
    return { type, who: /^[1-9]\d{0,15}$/.test(p.who ?? '') ? p.who : '', place: typeof p.place === 'string' ? p.place.slice(0, 200) : '',
      time, from: time === 'range' ? num(p.from) : null, to: time === 'range' ? num(p.to) : null, q: typeof p.q === 'string' ? p.q.slice(0, 100) : '', order,
      at: num(p.at) };
  }
  /** 筛选条件 → 地址栏参数（默认值不写，地址干净）。 */
  function paramsOf(f) {
    return { type: f.type === 'all' ? '' : f.type, who: f.who || '', place: f.place || '', time: f.time === 'all' ? '' : f.time,
      from: f.time === 'range' && f.from != null ? String(f.from) : '', to: f.time === 'range' && f.to != null ? String(f.to) : '', q: f.q || '',
      order: f.order === 'desc' ? '' : f.order, at: f.at != null ? String(f.at) : '' };
  }
  /** 两组筛选条件是不是同一个列表（只差 at 也算不同：要重新定位）。 */
  const sameFilters = (a, b) => JSON.stringify(paramsOf(a)) === JSON.stringify(paramsOf(b));
  /** 时间筛选 → [from, to]（毫秒，闭区间；本地时区的天）。 */
  function rangeOf(f, now = Date.now()) {
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    const today = d0.getTime();
    if (f.time === 'today') return [today, null];
    if (f.time === 'yesterday') { const y = new Date(today); y.setDate(y.getDate() - 1); return [y.getTime(), today - 1]; }
    if (f.time === '7d') return [now - 7 * DAY, null];
    if (f.time === '30d') return [now - 30 * DAY, null];
    if (f.time === 'range') return [f.from ?? null, f.to ?? null];
    return [null, null];
  }
  /** 筛选条件 → 用到的维度（这一类能不能按人、场合筛，能不能搜）。 */
  function dims(type) {
    const t = TYPES[type] ?? TYPES.all;
    if (t.feed) return { who: true, place: true, search: true, time: true };
    return { who: !!t.who, place: !!t.place, search: !!t.search, time: true };
  }
  /**
   * 一页的请求：[视图名, 参数]。page：{next?, prev?, around?, limit?, meta?}。合并的列表走 feed，原话这些走 memories（D159 的旧视图）。
   * @returns {[string, Record<string, any>]}
   */
  function requestFor(f, page = {}, now = Date.now()) {
    const t = TYPES[f.type] ?? TYPES.all;
    const [from, to] = rangeOf(f, now);
    const dm = dims(f.type);
    const common = { from: from ?? '', to: to ?? '', q: dm.search ? f.q : '', settingKey: dm.place ? f.place : '', entityId: dm.who ? f.who : '' };
    if (t.feed) {
      return ['feed', { ...common, ...t.feed, order: f.order === 'asc' ? 'asc' : 'desc', limit: page.limit ?? 50,
        next: page.next ?? '', prev: page.prev ?? '', around: page.around ?? '', meta: page.meta ? '1' : '' }];
    }
    const order = f.order === 'rank' && f.q ? 'rank' : f.order === 'asc' ? 'asc' : 'desc';
    return ['memories', { list: t.list, ...(t.extra ?? {}), ...common, order, limit: page.limit ?? 50, next: page.next ?? '', prev: page.prev ?? '',
      around: page.around ?? '', near: page.around != null && page.around !== '' ? (order === 'asc' ? 'after' : 'before') : '' }];
  }
  /** 「跳到某一天」的月历要的请求。 */
  function daysRequestFor(f, month, now = Date.now()) {
    const [view, q] = requestFor({ ...f, order: f.order === 'rank' ? 'desc' : f.order }, {}, now);
    const { next, prev, around, near, limit, meta, ...rest } = q;
    return [view === 'feed' ? 'feedDays' : 'memoryDays', { ...rest, month }];
  }
  /** 跳到某一天：在列表的方向上从那天的哪一刻起（新的在前 = 那天的最后一刻，旧的在前 = 那天的 0 点）。 */
  function jumpAt(dayStart, order) { return order === 'asc' ? dayStart : dayStart + DAY - 1; }

  /** 一个人的叫法（名字表 + 能选的人）。 */
  function whoName(ctx, id) {
    if (id == null) return null;
    const n = ctx.names?.[id];
    if (n && typeof n === 'object') return n.principal ? '你' : n.self ? '她' : n.name || '没认出是谁的人';
    if (typeof n === 'string' && n) return n;
    const p = ctx.people?.find((x) => x.id === id || x.members?.includes(id));
    if (p) return p.isSelf ? '她' : p.name;
    return '没认出是谁的人';
  }
  /** 场合的叫法（场合名最多 14 个字：群名可以很长）。 */
  function placeName(ctx, key) {
    if (!key) return null;
    const s = ctx.settings?.[key] ?? ctx.allSettings?.[key];
    const label = typeof s === 'string' ? s : s?.label;
    return clip(label || '某个场合', 14);
  }
  const span = (a, b, now) => (a != null && b != null && b - a > 60_000 && fmt.day(a, now) === fmt.day(b, now)
    ? `${fmt.day(b, now) === '今天' ? '' : `${fmt.day(b, now)} `}${fmt.clock(a)}–${fmt.clock(b)}` : fmt.when(b ?? a, now));
  const daysLeft = (until, now) => Math.max(0, Math.ceil((until - now) / DAY));

  /** 一行的小字（谁说的 · 在哪儿 · 什么时候 · 把握…）：返回字符串数组，metaLine 用「·」连起来。 */
  function metaParts(m, ctx, now = Date.now()) {
    const k = m._t ?? m.kind;
    if (k === 'fact') {
      const n = ctx.names?.[m.who];
      const who = m.who != null ? whoName(ctx, m.who) : null;
      const src = !who ? SOURCE[m.certainty] ?? null
        : m.certainty === 'hearsay' ? `听${who}说的`
          : n?.self ? '她自己说的'
            : who === '你' ? (m.certainty === 'stated' ? '你说的' : `你${SOURCE[m.certainty] ?? '说的'}`)
              : `${who}${SOURCE[m.certainty] ?? '说的'}`;
      return [src, placeName(ctx, m.settingKey), fmt.when(m.at, now), m.confidence != null ? `把握 ${fmt.pct(m.confidence)}` : null,
        m.planStatus ? `计划：${PLAN[m.planStatus] ?? m.planStatus}` : null];
    }
    if (k === 'episode') {
      const ps = (m.participants ?? []).map((id) => whoName(ctx, id)).filter(Boolean);
      const people = ps.length > 3 ? `${ps.slice(0, 3).join('、')}等 ${ps.length} 人` : ps.join('、');
      return [EP_KIND[m.epKind] ?? '经历', people || null, placeName(ctx, m.settingKey), span(m.tStart, m.at, now)];
    }
    if (k === 'intent') {
      const who = m.who != null ? whoName(ctx, m.who) : null;
      return [INT_STATE[m.intentState] ?? '打算', who ? `对${who}` : null,
        m.until && ['formed', 'armed'].includes(m.intentState) ? `到 ${fmt.day(m.until, now)}` : null, m.executions ? `做过 ${m.executions} 次` : null, fmt.when(m.at, now)];
    }
    if (k === 'lesson') {
      return ['经验', LESSON_ORIGIN[m.origin] ?? m.how ?? null, m.tool ? `用 ${m.tool} 时` : m.settingKey ? `只在「${placeName(ctx, m.settingKey)}」` : null, fmt.when(m.at, now)];
    }
    if (k === 'quote') {
      const who = m.self ? '她' : whoName(ctx, m.actorEntityId);
      return [m.self ? '她说的' : `${who}的原话`, placeName(ctx, m.settingKey), m.addressed && !m.self ? ADDR[m.addressed] ?? null : null,
        m.addressedBy === 'glance' ? '按意思判断是对她说的' : null, m.visibleTo === 'her-only' ? '只有她看到' : null,
        m.textState === 'edited' ? '编辑过' : m.textState === 'retracted' ? '撤回了' : null, m.historical ? '补进来的旧消息' : null, fmt.when(m.at, now)];
    }
    if (k === 'window') return ['原文片段', placeName(ctx, m.settingKey), span(m.tStart, m.tEnd, now)];
    if (k === 'check') return [m.withdrawn ? '收回了' : CHECK[m.verdict] ?? '核对过', m.why ? clip(m.why, 40) : null, fmt.when(m.at, now)];
    if (k === 'sup') {
      return [KIND_NAME[m.kind] ?? '记忆', m.by === 'owner' ? '你操作的' : /^cascade:/.test(m.reason ?? '') ? '跟着别的一起收起来的' : /^purged:/.test(m.reason ?? '') ? '还复述着被删掉的内容' : null,
        fmt.when(m.at, now)];
    }
    return [fmt.when(m.at, now)];
  }
  /** 状态小标签：[文字, 色调]。「忘掉」不用红色（红色只给彻底删除）。 */
  function tagsOf(m, now = Date.now()) {
    const out = [];
    if (m.state === 'hidden') out.push(['已隐藏', '']);
    if (m.state === 'forgotten') out.push([m.restoreUntil ? `已忘掉 · 还剩 ${daysLeft(m.restoreUntil, now)} 天能恢复` : '已忘掉', '']);
    if (m.supersededBy != null) out.push(['被取代了', '']);
    if (m.expiredAt != null) out.push(['已经过时', '']);
    if (m._t === 'lesson' || m.kind === 'lesson') out.push(m.status === 'verified' ? ['验证过', 'ok'] : ['还没验证', 'warn']);
    if (m.needsReview) out.push(['待复核', 'warn']);
    if (m._t === 'quote' && m.textState === 'expired') out.push(['原话已过保留期', '']);
    if (m._t === 'sup' && m.restorable === false) out.push(['已过恢复期', '']);
    return out;
  }
  /** 一行的主文。 */
  function titleOf(m) {
    if (m._t === 'quote') return m.textState === 'expired' && !m.text ? '（原话已过保留期）' : m.text ?? '';
    if (m._t === 'window') return m.text ? String(m.text).replace(/\n+/g, ' / ') : '（已过保留期）';
    if (m._t === 'check') return m.after && m.after.text !== m.before?.text ? `「${m.before?.text ?? ''}」→「${m.after.text}」` : m.before?.text ?? '';
    if (m._t === 'sup') return m.preview || KIND_NAME[m.kind] || '记忆';
    return m.text ?? '';
  }
  /** 一行的时间（按天分组用）。 */
  const atOf = (m) => (m._t === 'window' ? m.tEnd : m.at);
  /** 从 view=memories 来的一行 → 带上 _t。 */
  function normalize(x, type) {
    const t = TYPES[type] ?? TYPES.all;
    if (t.feed) return { ...x, _t: x.kind };
    if (t.list === 'percepts') return { ...x, _t: 'quote' };
    if (t.list === 'windows') return { ...x, _t: 'window', at: x.tEnd };
    if (t.list === 'checks') return { ...x, _t: 'check', ref: null, key: `c${x.id}` };
    return { ...x, _t: 'sup' };
  }
  /** 删除结果的人话（备份包改写了几个、没改成的原因、性格里去掉的行、WAL）。 */
  function purgeSummary(r) {
    const BAD = { missing: '文件不在了', 'no-key': '缺少解密的钥匙', 'read-only': '目录只读', aborted: '中途停了', sha256: '校验对不上', corrupt: '包坏了', format: '格式不认识' };
    const lines = [];
    if (r?.growth?.lines) lines.push(`她的性格里由它写出来的 ${r.growth.lines} 行一起去掉了。`);
    if (r?.backups) {
      lines.push(`改写了 ${r.backups.rewritten} 个备份包${r.backups.unchanged ? `，${r.backups.unchanged} 个里本来就没有` : ''}。`);
      if (r.backups.failed) lines.push(`有 ${r.backups.failed} 个备份包没改成（${[...new Set((r.backups.failures ?? []).map((f) => BAD[f.reason] ?? f.reason))].join('、')}）：那些包里还留着。`);
    }
    if (r?.wal?.main === 'busy' || r?.wal?.vectors === 'busy') lines.push('数据库日志正被别的程序读着，要等下一次删除时再清掉。');
    if (r?.sessions) lines.push(`她已经在 ${r.sessions} 个对话里用过它，那些对话记录里的字收不回。`);
    return lines;
  }
  const lib = { TYPES, PURGE_ALSO_BACKUPS_DEFAULT, filtersOf, paramsOf, sameFilters, rangeOf, dims, requestFor, daysRequestFor, jumpAt, whoName, placeName,
    metaParts, tagsOf, titleOf, normalize, purgeSummary, clip };

  // ════════════════════════════════════════════════════════════════════════
  // 状态
  // ════════════════════════════════════════════════════════════════════════
  const S = {
    sub: null,
    readOnly: false,
    /** 下拉要的：全部场合的名字、能选的人（第一次读列表时一起拿）。 */
    meta: null,
    list: null,
    sheetRef: null,
    sheet: null,
    personId: null,
    sky: null,
  };
  const roNote = () => R.note('warn', '记忆库现在是只读的：能看，不能隐藏、忘掉、恢复或删除。');
  const roHint = '记忆库现在是只读的';

  // ════════════════════════════════════════════════════════════════════════
  // 页头
  // ════════════════════════════════════════════════════════════════════════
  const DESC = { list: '她记得的事，你都看得到，包括对别人隐藏的。' };
  function head(route) {
    const segEl = R.seg(R.SUBS.memory.map(([k, t]) => [k, t]), route.sub, (k) => R.go(`memory/${k}`, { focus: false }), '记忆的分类');
    return R.pageHead('记忆', DESC[route.sub] ?? DESC.list, segEl);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 记忆列表
  // ════════════════════════════════════════════════════════════════════════
  function ctxOf(L) { return { names: L.names, settings: L.settings, allSettings: S.meta?.allSettings ?? {}, people: S.meta?.pickable ?? [] }; }

  async function renderList(body, route) {
    const f = filtersOf(route.params);
    const L = S.list = { f, items: [], next: null, prev: null, total: null, names: {}, settings: {}, seq: 0, picking: false, picked: new Set(), byRef: new Map(),
      els: {}, lastDay: null, group: null, rows: new Map(), error: null };
    const search = h('input', { type: 'search', placeholder: '搜她记得的事、原话', value: f.q, 'aria-label': '搜索记忆', autocomplete: 'off', spellcheck: 'false' });
    let t = 0;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => setFilters({ q: search.value.trim(), order: L.f.order === 'rank' ? 'desc' : L.f.order }), 300); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; setFilters({ q: '' }); } });
    L.els.search = search;
    L.els.chips = h('div', { class: 'chips' });
    L.els.end = h('div', { class: 'end' });
    L.els.ro = h('div');
    L.els.top = h('div', { class: 'mem-pager top' });
    L.els.box = h('div', { class: 'mem-list', 'aria-live': 'off' });
    L.els.foot = h('div', { class: 'mem-pager' });
    L.els.sentinel = h('div', { class: 'mem-sentinel', 'aria-hidden': 'true' });
    R.clear(body, h('div', { class: 'toolbar mem-toolbar' }, h('label', { class: 'search' }, icon('search', 16), search), L.els.chips, L.els.end), L.els.ro, L.els.top, L.els.box, L.els.foot, L.els.sentinel);
    if (typeof IntersectionObserver === 'function') {
      L.io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && L.next && !L.loading && L.items.length < AUTO_MAX) loadMore(); }, { rootMargin: '600px 0px' });
      L.io.observe(L.els.sentinel);
    }
    drawToolbar();
    await loadFirst();
  }

  function setFilters(patch, { keepAt = false } = {}) {
    const f = { ...S.list.f, ...patch };
    if (!keepAt) f.at = null;
    const dm = dims(f.type);
    if (!dm.search) f.q = '';
    if (!dm.who) f.who = '';
    if (!dm.place) f.place = '';
    R.setParams({ ...paramsOf(f), open: R.route()?.params.open ?? '' });
  }

  function drawToolbar() {
    const L = S.list;
    const f = L.f;
    const dm = dims(f.type);
    const typeOpts = [
      { value: 'all', label: '全部（事实、经历、打算、经验）' }, { sep: true },
      ...['fact', 'episode', 'intent', 'lesson', 'unverified'].map((k) => ({ value: k, label: TYPES[k].label })),
      { sep: true }, { header: '原始的' }, ...['quote', 'window', 'check', 'checkall', 'old'].map((k) => ({ value: k, label: TYPES[k].label })),
      { sep: true }, { header: '收起来的' }, ...['hidden', 'forgotten'].map((k) => ({ value: k, label: TYPES[k].label })),
    ];
    const people = (S.meta?.pickable ?? []).filter((p) => p.stored !== false && !p.isSelf);
    const dup = new Map();
    for (const p of people) dup.set(p.name, (dup.get(p.name) ?? 0) + 1);
    const pOpts = [{ value: '', label: '全部的人' }, { sep: true },
      ...people.map((p) => ({ value: String(p.id), label: `${p.name}${p.aliases?.length ? `（也叫${p.aliases[0]}）` : ''}${dup.get(p.name) > 1 && p.place ? ` · ${placeName(ctxOf(L), p.place)}` : ''}` }))];
    if (f.who && !pOpts.some((o) => o.value === f.who)) pOpts.push({ value: f.who, label: whoName(ctxOf(L), Number(f.who)) ?? '这个人' });
    const places = Object.entries(S.meta?.allSettings ?? {});
    const plOpts = [{ value: '', label: '全部场合' }, { sep: true }, ...places.map(([k, v]) => ({ value: k, label: clip(v, 24) }))];
    if (f.place && !plOpts.some((o) => o.value === f.place)) plOpts.push({ value: f.place, label: placeName(ctxOf(L), f.place) });
    const tOpts = [...Object.entries(TIMES).map(([k, v]) => ({ value: k, label: v })),
      ...(f.time === 'range' ? [{ value: 'range', label: rangeText(f), run: () => customRange() }] : []),
      { value: 'custom', label: '自定时间段…', run: () => customRange() }, { sep: true }, { value: 'jump', label: '跳到某一天…', run: () => jumpDialog() }];
    R.clear(L.els.chips,
      R.dropdown('类型', typeOpts, f.type, (v) => setFilters({ type: v, order: L.f.order === 'rank' ? 'desc' : L.f.order }), { allValue: 'all' }),
      dm.who ? R.dropdown('人', pOpts, f.who, (v) => setFilters({ who: v })) : null,
      dm.place ? R.dropdown('场合', plOpts, f.place, (v) => setFilters({ place: v })) : null,
      R.dropdown('时间', tOpts, f.time, (v) => setFilters({ time: v, from: null, to: null }), { allValue: 'all' }));
    L.els.search.disabled = !dm.search;
    L.els.search.placeholder = dm.search ? (f.type === 'quote' ? '搜原话' : f.type === 'window' ? '搜原文' : '搜她记得的事') : '这一类不能搜';
    const ORD = { desc: '新的在前', asc: '旧的在前', rank: '最相关' };
    const ordBtn = btn(ORD[f.order], { kind: 'ghost', size: 'sm', ic: 'sort', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: '排序' } });
    ordBtn.addEventListener('click', () => R.menu(ordBtn, [
      ...(TYPES[f.type].rank && f.q ? [{ label: '最相关', checked: f.order === 'rank', onSelect: () => setFilters({ order: 'rank' }) }] : []),
      { label: '新的在前', checked: f.order === 'desc', onSelect: () => setFilters({ order: 'desc' }) },
      { label: '旧的在前', checked: f.order === 'asc', onSelect: () => setFilters({ order: 'asc' }) }]));
    const canPick = !S.readOnly && f.type !== 'check' && f.type !== 'checkall';
    const selBtn = canPick ? btn(L.picking ? '完成' : '选择', { kind: 'ghost', size: 'sm', ic: L.picking ? 'check' : 'select', onclick: () => setPicking(!L.picking) }) : null;
    // 全新的、什么都没有的时候：排序、选择都用不上
    const fresh = L.total === 0 && !(f.q || f.who || f.place || f.time !== 'all' || f.type !== 'all');
    R.clear(L.els.end, fresh ? null : [ordBtn, selBtn]);
    R.clear(L.els.ro, S.readOnly ? h('div', { class: 'mem-ro' }, roNote()) : null);
  }
  function rangeText(f) {
    const d = (t) => (t == null ? '' : fmt.day(t));
    return f.from != null && f.to != null ? `${d(f.from)}–${d(f.to)}` : f.from != null ? `${d(f.from)} 以后` : f.to != null ? `${d(f.to)} 以前` : '自定';
  }

  async function fetchPage(page) {
    const L = S.list;
    const [view, q] = requestFor(L.f, { ...page, meta: !S.meta && page.meta !== false });
    const d = await R.api.get(view, q);
    if (d?.unsupported) throw Object.assign(new Error('这个版本的核心还没有合并的记忆列表，先去旧版看。'), { code: 'UNAVAILABLE', status: 503 });
    if (d.allSettings || d.pickable) S.meta = { allSettings: d.allSettings ?? {}, pickable: d.pickable ?? [] };
    if (view === 'memories' && !S.meta) S.meta = { allSettings: d.settings ?? {}, pickable: d.pickable ?? [] };
    if (typeof d.readOnly === 'boolean') S.readOnly = d.readOnly;
    Object.assign(L.names, d.names ?? {});
    Object.assign(L.settings, d.settings ?? {});
    return d;
  }

  async function loadFirst() {
    const L = S.list;
    const seq = ++L.seq;
    L.loading = true;
    R.clear(L.els.box, R.loading('正在读她记得的事…'));
    R.clear(L.els.foot); R.clear(L.els.top);
    let d;
    try { d = await fetchPage(L.f.at != null ? { around: L.f.at } : {}); } catch (e) {
      if (seq !== L.seq) return;
      L.loading = false;
      R.clear(L.els.box, R.errorBox(e, () => loadFirst(), { title: '记忆读不出来' }));
      return;
    }
    if (seq !== L.seq) return;
    L.loading = false;
    L.items = []; L.byRef.clear(); L.rows.clear(); L.lastDay = null; L.group = null;
    L.total = d.total ?? null;
    L.next = d.next ?? null; L.prev = d.prev ?? null;
    R.clear(L.els.box);
    drawToolbar();
    append((d.items ?? []).map((x) => normalize(x, L.f.type)));
    drawPagers();
    if (!L.items.length) drawEmpty();
    if (d.anchor && L.f.at != null) {
      const day = fmt.dayLabel(L.f.at).filter(Boolean).join(' ');
      if (d.anchor.side && ((L.f.order === 'asc') !== (d.anchor.side === 'after'))) R.toast(`${day}没有符合条件的，停在离它最近的地方`);
    }
    // 刷新后详情面板还在
    const open = R.route()?.params.open;
    if (open && S.sheetRef !== open) openDetail(open);
  }

  async function loadMore() {
    const L = S.list;
    if (!L.next || L.loading) return;
    if (L.items.length >= HARD_MAX) { drawPagers(); return; }
    const seq = L.seq;
    L.loading = true;
    R.clear(L.els.foot, R.loading('正在往下读…'));
    let d;
    try { d = await fetchPage({ next: L.next, meta: false }); } catch (e) {
      if (seq !== L.seq) return;
      L.loading = false;
      R.clear(L.els.foot, h('div', { class: 'mem-endnote' }, R.errorText(e, 'read'), ' ', btn('重试', { size: 'sm', kind: 'ghost', onclick: () => loadMore() })));
      return;
    }
    if (seq !== L.seq) return;
    L.loading = false;
    L.next = d.next ?? null;
    append((d.items ?? []).map((x) => normalize(x, L.f.type)));
    drawPagers();
  }
  /** 往回翻（跳到某一天以后，看更新 / 更早的）：插在最上面，屏幕上的那一行不动。 */
  async function loadPrev() {
    const L = S.list;
    if (!L.prev || L.loading) return;
    const seq = L.seq;
    L.loading = true;
    let d;
    try { d = await fetchPage({ prev: L.prev, meta: false }); } catch (e) { L.loading = false; R.toast(R.errorText(e, 'read'), { tone: 'bad' }); return; }
    if (seq !== L.seq) return;
    L.loading = false;
    L.prev = d.prev ?? null;
    const first = L.els.box.querySelector('.row');
    const y0 = first?.getBoundingClientRect().top ?? 0;
    const items = [...(d.items ?? []).map((x) => normalize(x, L.f.type)), ...L.items];
    L.items = []; L.byRef.clear(); L.rows.clear(); L.lastDay = null; L.group = null;
    R.clear(L.els.box);
    append(items);
    if (first?.isConnected) window.scrollBy(0, first.getBoundingClientRect().top - y0);
    drawPagers();
  }

  const grouped = () => S.list.f.order !== 'rank';
  /** 追加一批行（按天分组接着上一批的那一天）。 */
  function append(items) {
    const L = S.list;
    for (const m of items) {
      const key = m.ref ?? m.key;
      if (key && L.byRef.has(key)) continue;
      L.items.push(m);
      if (key) L.byRef.set(key, m);
      if (grouped()) {
        const d = new Date(atOf(m)).toDateString();
        if (d !== L.lastDay || !L.group) {
          L.lastDay = d;
          const [a, b] = fmt.dayLabel(atOf(m));
          L.els.box.append(h('div', { class: 'mem-dayhead' }, a, b ? h('span', null, b) : null));
          L.group = h('div', { class: 'list', role: 'list' });
          L.els.box.append(L.group);
        }
      } else if (!L.group) { L.group = h('div', { class: 'list', role: 'list' }); L.els.box.append(L.group); }
      const el = memRow(m);
      if (key) L.rows.set(key, el);
      L.group.append(el);
    }
  }
  function drawPagers() {
    const L = S.list;
    R.clear(L.els.top, L.prev ? btn(L.f.order === 'asc' ? '看更早的' : '看更新的', { kind: 'ghost', size: 'sm', ic: L.f.order === 'asc' ? 'down' : 'refresh', onclick: () => loadPrev() }) : null);
    if (!L.items.length) { R.clear(L.els.foot); return; }
    const count = L.total != null ? `共 ${fmt.num(L.total)} 条` : null;
    if (!L.next) { R.clear(L.els.foot, h('p', { class: 'mem-endnote' }, [count, L.f.order === 'asc' ? '已经是最新的了' : '已经是最早的了'].filter(Boolean).join(' · '))); return; }
    if (L.items.length >= HARD_MAX) {
      R.clear(L.els.foot, h('p', { class: 'mem-endnote' }, `已经显示了 ${fmt.num(L.items.length)} 条${count ? `（${count}）` : ''}。要看更早的，用「时间」里的「跳到某一天」直接过去。`));
      return;
    }
    R.clear(L.els.foot, h('div', { class: 'mem-more' }, btn('加载更多', { kind: 'secondary', size: 'sm', onclick: () => loadMore() }),
      h('span', { class: 'mem-endnote' }, [count, `已显示 ${fmt.num(L.items.length)} 条`].filter(Boolean).join(' · '))));
  }
  function drawEmpty() {
    const L = S.list;
    const f = L.f;
    const filtered = f.q || f.who || f.place || f.time !== 'all' || f.type !== 'all';
    if (!filtered) {
      R.clear(L.els.box, R.empty({ ic: 'book', title: '她还什么都没记住',
        text: '她在场时听到、说过的话，会慢慢整理成一件件事、一段段经历，出现在这里。在 DSH 里和她聊几句，或者接上 QQ，过一会儿再来看。' }));
      return;
    }
    const hint = { hidden: '你隐藏的记忆会在这里，随时能恢复。', forgotten: '忘掉的记忆在这里放 30 天，这段时间里能恢复。', check: '夜里整理时对照原话改过的事实会在这里。',
      unverified: '她自己琢磨出来、还没被证实的做法会在这里。', old: '一件事有了新说法以后，旧的会在这里。' }[f.type];
    R.clear(L.els.box, R.empty({ ic: f.q ? 'search' : 'book', title: f.q ? `没有搜到「${clip(f.q, 20)}」` : '这里没有符合条件的记忆',
      text: hint ?? '换个说法，或者清掉筛选再看。',
      actions: btn('清掉筛选', { onclick: () => R.setParams({ type: '', who: '', place: '', time: '', from: '', to: '', q: '', order: '', at: '' }) }) }));
  }

  // ── 一行 ─────────────────────────────────────────────────────────────
  function memRow(m) {
    const L = S.list;
    const key = m.ref ?? m.key;
    const picking = L.picking && !!m.ref;
    const check = picking ? h('input', { type: 'checkbox', class: 'check', checked: L.picked.has(m.ref), 'aria-label': '选中这条' }) : null;
    const tags = tagsOf(m).map(([t, tone]) => tag(t, tone));
    const open = () => {
      if (picking) { check.click(); return; }
      if (m.ref) R.setParams({ open: m.ref });
      else if (m._t === 'check') openDetail(m.after?.ref ?? m.before?.ref);
    };
    const el = R.row({ title: titleOf(m), tags, meta: metaLine(metaParts(m, ctxOf(L))), onOpen: open, check, sel: picking && L.picked.has(m.ref) || S.sheetRef === m.ref,
      cls: `mem-row${m.state ? ' mem-dim' : ''}`, label: picking ? `选中：${clip(titleOf(m), 30)}` : null,
      trail: picking ? null : R.moreButton(() => rowMenu(m), '这条记忆的操作') });
    el.setAttribute('role', 'listitem');
    if (key) el.dataset.ref = key;
    check?.addEventListener('change', () => { if (check.checked) L.picked.add(m.ref); else L.picked.delete(m.ref); el.classList.toggle('sel', check.checked); drawBulk(); });
    return el;
  }
  /** 行尾「⋯」：详情 / 按类型多出来的 / 隐藏、忘掉或恢复。彻底删除只在详情面板里。 */
  function rowMenu(m) {
    const ro = S.readOnly;
    const items = [];
    if (m.ref) items.push({ label: '详情', ic: 'file', onSelect: () => R.setParams({ open: m.ref }) });
    if ((m._t === 'episode' || m._t === 'window') && m.settingKey && m.tStart != null) items.push({ label: '这段时间的原话', ic: 'chat', onSelect: () => quotesOf(m.settingKey, m.tStart, m._t === 'window' ? m.tEnd : m.at) });
    if (m._t === 'quote' && m.settingKey) items.push({ label: '看前后的原话', ic: 'chat', onSelect: () => around(m.settingKey, m.at) });
    if (m._t === 'lesson' && m.confirmable && !m.state) items.push({ label: '确认这条经验', ic: 'check', disabled: ro, onSelect: () => confirmLesson(m) });
    if (m._t === 'check') {
      if (m.before?.ref) items.push({ label: m.after ? '看原来那条' : '详情', ic: 'file', onSelect: () => openDetail(m.before.ref) });
      if (m.after?.ref) items.push({ label: '看改成的那条', ic: 'file', onSelect: () => openDetail(m.after.ref) });
      if (m.reverted?.restored?.ref) items.push({ label: '看恢复的那条', ic: 'file', onSelect: () => openDetail(m.reverted.restored.ref) });
      if (m.revertable) items.push({ label: '撤销这次改正', ic: 'undo', disabled: ro, onSelect: () => revertCheck(m) });
    }
    if (m.ref) {
      items.push({ sep: true });
      if (m.state) { if (m.restorable !== false) items.push({ label: '恢复', ic: 'undo', disabled: ro, onSelect: () => setState(m.ref, null, m.state) }); }
      else {
        items.push({ label: '隐藏', ic: 'eyeoff', disabled: ro, onSelect: () => setState(m.ref, 'hidden', null) });
        items.push({ label: '忘掉', ic: 'archive', disabled: ro, onSelect: () => setState(m.ref, 'forgotten', null) });
      }
    }
    if (ro) items.push({ hint: `${roHint}，改不了。` });
    return items;
  }
  /** 原话列表：某个场合、某段时间（经历、原文片段的「这段时间的原话」）。 */
  function quotesOf(place, from, to) {
    closeSheet();
    R.go('memory/list', { params: paramsOf({ ...filtersOf({}), type: 'quote', place, time: 'range', from, to, order: 'asc' }), focus: false });
  }
  /** 原话列表：某个场合、跳到某一刻（「看前后」）。 */
  function around(place, at) {
    closeSheet();
    R.go('memory/list', { params: paramsOf({ ...filtersOf({}), type: 'quote', place, order: 'asc', at: Math.max(0, at - 1) }), focus: false });
    R.toast('在看这句话前后的原话');
  }

  // ── 隐藏 / 忘掉 / 恢复（可撤销：提示条的「撤销」调反向的动作） ─────
  const ACT = { hidden: 'memory.hide', forgotten: 'memory.forget' };
  async function setState(ref, to, from, { quiet = false } = {}) {
    try { await R.api.act(to ? ACT[to] : 'memory.restore', { ref }); } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); return false; }
    applyState(ref, to);
    if (!quiet) {
      const text = to === 'hidden' ? '已对别人隐藏，你仍然看得到' : to === 'forgotten' ? '已忘掉，30 天内能恢复' : '已恢复';
      R.toast(text, { undo: () => setState(ref, from, to, { quiet: true }).then((ok) => ok && R.toast(from ? '已撤销' : '已撤销，恢复原样')) });
    }
    return true;
  }
  /** 列表里那一行跟着变：还符合筛选的换上新状态，不符合的收起来。 */
  function applyState(ref, state) {
    const L = S.list;
    if (!L) return;
    const m = L.byRef.get(ref);
    if (!m) return;
    m.state = state;
    if (state === 'forgotten') m.restoreUntil = Date.now() + 30 * DAY;
    const t = L.f.type;
    const fits = t === 'hidden' ? state === 'hidden' : t === 'forgotten' ? state === 'forgotten' : state !== 'forgotten';
    const el = L.rows.get(ref);
    if (!el) return;
    if (!fits) { el.remove(); L.rows.delete(ref); L.byRef.delete(ref); L.items = L.items.filter((x) => x !== m); L.picked.delete(ref); drawBulk(); return; }
    const fresh = memRow(m);
    el.replaceWith(fresh);
    L.rows.set(ref, fresh);
  }
  async function confirmLesson(m) {
    try { await R.api.act('lesson.confirm', { id: m.id }); } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); return; }
    m.status = 'verified'; m.confirmable = false; m.origin = 'confirmed';
    const el = S.list?.rows.get(m.ref);
    if (el) { const fresh = memRow(m); el.replaceWith(fresh); S.list.rows.set(m.ref, fresh); }
    R.toast('已确认，这条算验证过');
  }
  async function revertCheck(m) {
    const r = await R.api.confirmed('check.revert', { id: m.id }, {
      title: '撤销这次改正', danger: false, okText: '撤销改正',
      consequence: `原来那条「${clip(m.before?.text, 40)}」会按确认过恢复（把握 90%），夜里整理不会再改它。`,
    }).catch((e) => { R.toast(R.errorText(e), { tone: 'bad' }); return null; });
    if (r) { R.toast('已撤销，原来那条恢复了'); loadFirst(); }
  }

  // ── 多选 ───────────────────────────────────────────────────────────────
  function setPicking(on) {
    const L = S.list;
    L.picking = on;
    L.picked.clear();
    redrawRows();
    drawToolbar();
    drawBulk();
  }
  function redrawRows() {
    const L = S.list;
    for (const [key, el] of L.rows) { const m = L.byRef.get(key); if (!m) continue; const fresh = memRow(m); el.replaceWith(fresh); L.rows.set(key, fresh); }
  }
  function drawBulk() {
    document.querySelector('.mem-bulk')?.remove();
    const L = S.list;
    if (!L?.picking || !L.picked.size) return;
    const refs = [...L.picked];
    const anyOn = refs.some((r) => L.byRef.get(r)?.state);
    const bar = h('div', { class: 'mem-bulk', role: 'region', 'aria-label': '选中的记忆' }, h('span', { class: 'n' }, `已选 ${refs.length} 条`),
      h('span', { class: 'acts' },
        anyOn ? btn('恢复', { size: 'sm', onclick: () => bulk(refs, null) }) : null,
        btn('隐藏', { size: 'sm', onclick: () => bulk(refs, 'hidden') }),
        btn('忘掉', { size: 'sm', onclick: () => bulk(refs, 'forgotten') }),
        btn('彻底删除…', { size: 'sm', kind: 'danger', onclick: () => purge(refs) }),
        btn('', { size: 'sm', kind: 'ghost', ic: 'x', title: '取消选择', onclick: () => setPicking(false) })));
    document.body.append(bar);
  }
  async function bulk(refs, to) {
    const L = S.list;
    const before = new Map(refs.map((r) => [r, L.byRef.get(r)?.state ?? null]));
    let done = 0;
    for (const ref of refs) { if (before.get(ref) === to) continue; if (await setState(ref, to, before.get(ref), { quiet: true })) done++; }
    L.picked.clear();
    setPicking(false);
    const word = to === 'hidden' ? '隐藏' : to === 'forgotten' ? '忘掉' : '恢复';
    R.toast(`已${word} ${done} 条`, { undo: async () => { for (const ref of refs) await setState(ref, before.get(ref), to, { quiet: true }); R.toast('已撤销'); } });
  }

  // ── 彻底删除（危险确认：一句后果 + 手输确认语 + 折叠的技术细节；连备份一起删默认勾上） ─────
  async function purge(refs, { onDone } = {}) {
    if (refs.length > 50) { R.toast('一次最多彻底删除 50 条，请少选一些'); return; }
    const n = refs.length;
    let r;
    try {
      r = await R.api.confirmed('memory.purge', { refs, alsoBackups: PURGE_ALSO_BACKUPS_DEFAULT }, {
        title: n > 1 ? `彻底删除 ${n} 条记忆` : '彻底删除这条记忆', okText: '彻底删除',
        consequence: `${n > 1 ? '这些记忆' : '这条记忆'}和只靠它作证据的内容会一起删掉，找不回来。`,
        render: (pv) => {
          const live = (pv?.items ?? []).filter((x) => !x.missing && !x.purged);
          const used = pv?.sessions ? h('p', null, `她已经在 ${pv.sessions} 个对话里用过${n > 1 ? '它们' : '它'}，那些对话记录里的字收不回。`) : null;
          return [live.length === 1 ? h('div', { class: 'item' }, live[0].text ?? KIND_NAME[live[0].kind] ?? '') : live.length > 1
            ? h('div', { class: 'item mem-purge-list' }, live.slice(0, 5).map((x) => h('div', null, clip(x.text ?? KIND_NAME[x.kind], 60))), live.length > 5 ? h('div', { class: 'mem-faint' }, `还有 ${live.length - 5} 条`) : null) : null,
          used];
        },
        extra: (state) => {
          state.params = { alsoBackups: PURGE_ALSO_BACKUPS_DEFAULT };
          const cb = h('input', { type: 'checkbox', checked: PURGE_ALSO_BACKUPS_DEFAULT });
          cb.addEventListener('change', () => { state.params = { alsoBackups: cb.checked }; });
          return h('label', { class: 'cbox' }, cb, h('span', null, '同时从本机备份里删掉（会重写每个备份包，比较慢）'));
        },
        details: (pv) => [
          '会一起删掉：只靠它作证据的派生内容、包含它的小结、她的性格里由它写出来的行（连历史版本）、算好的向量和全文索引里的词。',
          ` 删之前会先自动做一个备份；不勾「同时从本机备份里删掉」的话，这个备份和以前的备份包里还留着，等它们按保留期轮换掉。`,
          (pv?.items ?? []).some((x) => x.sources) ? ` 来源：${(pv.items ?? []).map((x) => `${x.ref} 有 ${x.sources ?? 0} 条来源`).join('，')}。` : '',
        ].join(''),
      });
    } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); return; }
    if (!r) return;
    const lines = purgeSummary(r);
    const failed = r.backups?.failed || r.wal?.main === 'busy' || r.wal?.vectors === 'busy';
    for (const ref of refs) dropRow(ref);
    if (S.list) { S.list.picked.clear(); if (S.list.picking) setPicking(false); }
    closeSheet();
    if (failed) {
      const l = R.dialog({ title: '已彻底删除，有几处没清干净', body: lines.map((x) => h('p', null, x)), actions: [btn('知道了', { kind: 'primary', onclick: () => l.close() })] });
    } else R.toast(r.backups ? `已彻底删除，改写了 ${r.backups.rewritten} 个备份包` : '已彻底删除');
    onDone?.();
  }
  function dropRow(ref) {
    const L = S.list;
    if (!L) return;
    L.rows.get(ref)?.remove();
    L.rows.delete(ref); L.byRef.delete(ref);
    L.items = L.items.filter((x) => x.ref !== ref);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 详情面板（右侧滑出；地址 ?open=<引用>，刷新后还在；Esc 关，焦点回到那一行）
  // ════════════════════════════════════════════════════════════════════════
  function closeSheet() { if (S.sheet) { const s = S.sheet; S.sheet = null; S.sheetRef = null; s.close(false); } }
  const ss = (title, ...body) => h('div', { class: 'mem-ss' }, h('h3', null, title), ...body);
  const refKind = (ref) => REF_KIND[String(ref ?? '')[0]] ?? null;

  async function openDetail(ref) {
    if (!ref) return;
    closeSheet();
    const isEntity = refKind(ref) === 'entity';
    if (isEntity && S.sub === 'people') { openPerson(Number(ref.slice(1))); return; }
    S.sheetRef = ref;
    markSel(ref);
    const body = h('div', null, R.loading('正在读这条记忆…'));
    const foot = h('div', { class: 'mem-sfoot' });
    const layer = R.sheet({ kicker: [KIND_NAME[refKind(ref)] ?? '记忆'], body, foot, label: '记忆详情',
      onClose: () => { if (S.sheet === layer) { S.sheet = null; S.sheetRef = null; markSel(null); if (R.route()?.params.open) R.setParams({ open: '' }); } } });
    S.sheet = layer;
    let d;
    try { d = await R.api.get('memory', { ref }); } catch (e) {
      if (S.sheet !== layer) return;
      R.clear(body, R.errorBox(e, () => { closeSheet(); openDetail(ref); }, { title: '这条记忆读不出来' }));
      return;
    }
    if (S.sheet !== layer) return;
    drawDetail(layer, body, foot, ref, d);
  }
  function markSel(ref) {
    for (const el of document.querySelectorAll('.mem-row.sel')) if (!S.list?.picking) el.classList.remove('sel');
    if (ref) document.querySelector(`.mem-row[data-ref="${CSS.escape(ref)}"]`)?.classList.add('sel');
  }

  function drawDetail(layer, body, foot, ref, d) {
    const x = d.detail ?? {};
    const ctx = { names: d.names ?? {}, settings: d.settings ?? {}, allSettings: S.meta?.allSettings ?? {}, people: S.meta?.pickable ?? [] };
    const row = x.row ?? {};
    const kick = layer.box.querySelector('.shead .k');
    if (x.purged) {
      R.clear(body, R.empty({ ic: 'trash', title: '这条已经被彻底删除了', text: `删除于 ${fmt.when(x.at)}。` }));
      R.clear(foot);
      return;
    }
    const sup = x.suppression;
    const kind = x.kind;
    const listItem = S.list?.byRef.get(ref);
    R.clear(kick, KIND_NAME[kind] ?? '记忆', sup ? tag(sup.state === 'hidden' ? '已隐藏' : sup.restoreUntil ? `已忘掉 · 还剩 ${daysLeft(sup.restoreUntil, Date.now())} 天能恢复` : '已忘掉') : null,
      x.norm && !x.norm.unassessed && x.norm.restriction && x.norm.restriction !== 'none' ? tag(x.norm.restriction === 'strict' ? '严格保密' : '谨慎', 'warn') : null);
    const text = kind === 'window' ? String(row.text ?? '（已过保留期）').split('\n').map((l) => h('div', null, l))
      : row.text ?? row.narrative ?? row.display_name ?? row.title ?? '（没有文字）';
    const who = (id) => whoName(ctx, Number(id));
    const place = (k) => placeName(ctx, k) ?? '某个场合';
    const parts = [];
    parts.push(h('div', { class: 'mem-big' }, text));
    if (kind === 'episode' && row.title && row.narrative) parts.push(h('p', { class: 'mem-p' }, row.narrative));
    parts.push(listItem ? metaLine(metaParts(listItem, { ...ctxOf(S.list) })) : metaLine(fmt.when(row.recorded_at ?? row.t_end ?? row.at ?? row.formed_at ?? row.updated_at)));
    // 她是怎么知道的（来源原话，看前后）
    const sources = (x.sources ?? []).slice(0, 20);
    if (sources.length) {
      parts.push(ss(`她是怎么知道的（${(x.sources ?? []).length}）`, sources.map((s) => {
        const q = s.percept?.text ?? s.quote;
        const sk = s.percept?.settingKey ?? s.settingKey;
        return h('div', { class: 'mem-src' }, q ? h('div', { class: 'q' }, `「${q}」`) : h('div', { class: 'q mem-faint' }, '（原话已过保留期）'),
          metaLine(s.speaker != null ? who(s.speaker) : null, SRC_MODE[s.mode] ?? null, s.hop ? `转了 ${s.hop} 手` : null, place(sk), fmt.when(s.percept?.at ?? s.at)),
          s.perceptId && sk ? h('div', { class: 'mem-src-go' }, R.link('看前后的原话', () => around(sk, s.percept?.at ?? s.at))) : null);
      })));
    }
    if (kind === 'percept') {
      const der = x.derived ?? [];
      if (der.length) parts.push(ss(`整理出了 ${der.length} 条记忆`, h('div', { class: 'mem-chips' }, der.slice(0, 12).map((r) => R.link(`${KIND_NAME[refKind(r)] ?? '记忆'} ${r.slice(1)}`, () => { closeSheet(); R.setParams({ open: r }); }, { arrow: false })))));
      if (row.setting_key) parts.push(h('div', { class: 'mem-src-go' }, R.link('看前后的原话', () => around(row.setting_key, row.at))));
    }
    if ((kind === 'episode' || kind === 'window') && (row.setting_key ?? row.settingKey) && row.t_start != null) {
      parts.push(h('div', { class: 'mem-src-go' }, R.link('这段时间的原话', () => quotesOf(row.setting_key, row.t_start, row.t_end))));
    }
    // 能对谁说（分寸）
    const nm = x.norm;
    if (nm && (kind === 'assertion' || kind === 'episode' || kind === 'percept' || !nm.unassessed)) {
      parts.push(ss('能对谁说', nm.unassessed ? h('p', { class: 'mem-p mem-faint' }, '还没评估分寸：先按平常处理，说之前她会再看一眼。')
        : R.kv([['分寸', RESTRICT[nm.restriction] ?? nm.restriction], nm.restrictionQuote ? ['原话', `「${nm.restrictionQuote}」`] : null,
          nm.allow?.length ? ['可以告诉', nm.allow.map(who).join('、')] : null, nm.deny?.length ? ['不要告诉', nm.deny.map(who).join('、')] : null,
          nm.attribute ? ['信息类型', nm.attribute] : null, nm.sensitivity != null ? ['敏感程度', fmt.pct(nm.sensitivity)] : null,
          nm.involvesOthers ? ['牵涉别人', '是'] : null])));
    }
    // 谁知道、她对谁说过
    const known = (x.knownBy ?? []).slice(0, 30);
    const told = (x.told ?? []).slice(0, 20);
    if (known.length || told.length || kind !== 'entity') {
      parts.push(ss('谁知道、她对谁说过', R.kv([
        ['知道的', known.length ? [...new Set(known.map((k) => (k.whoKind === 'entity' ? who(k.whoRef) : k.whoKind === 'setting' ? `「${place(k.whoRef)}」里的人` : '当时在场的人')))].join('、') : '没有记下'],
        ['她说起过', told.length ? told.map((t) => `${fmt.when(t.at)}在「${place(t.settingKey)}」里${t.level === 'vague' ? '说了个大概' : '讲全了'}`).join('；') : '还没对别人说过'],
      ])));
    }
    // 版本：之前是什么、后来改成什么
    const versions = x.versions ?? [];
    if (versions.length > 1) {
      parts.push(ss('之前和之后的说法', versions.map((v) => h('div', { class: `mem-src${v.ref === ref ? ' cur' : ''}` },
        h('div', { class: `q${v.ref === ref ? '' : ' mem-faint'}` }, v.text), metaLine(`${fmt.when(v.recordedAt)} 记的`, v.ref === ref ? '就是这一条' : null, v.expiredAt ? `${fmt.when(v.expiredAt)} 起不算了` : null),
        v.ref !== ref ? h('div', { class: 'mem-src-go' }, R.link('看这一版', () => { closeSheet(); R.setParams({ open: v.ref }); })) : null))));
    }
    if (x.planHistory?.length) parts.push(ss('计划的进展', R.kv(x.planHistory.map((p) => [fmt.when(p.at), PLAN[p.status] ?? p.status]))));
    if (x.sameType?.length) parts.push(ss('同一类事的其他几次', x.sameType.slice(0, 8).map((s) => h('div', { class: 'mem-src' }, h('div', { class: 'q' }, s.text), metaLine(fmt.when(s.eventStart ?? s.recordedAt))))));
    // 人与物（从记忆里点开一个人的档案时）
    if (kind === 'entity') {
      if (x.names?.length) parts.push(ss('大家怎么叫', h('div', { class: 'mem-chips' }, x.names.slice(0, 30).map((n) => tag(`${n.text}${n.scope ? ` · 在「${place(n.scope)}」` : ''} · ${n.count} 次`)))));
      if (x.descriptors?.length) parts.push(ss('关系', x.descriptors.map((r) => h('p', { class: 'mem-p' }, `${who(r.anchor)}的${r.relation}${r.text ? `：${r.text}` : ''}`))));
      const imps = (x.impressions ?? []).filter((i) => i.isCurrent);
      if (imps.length) parts.push(ss('她的印象', imps.map((i) => h('p', { class: 'mem-p' }, h('span', { class: 'mem-faint' }, i.layer === 'shared' ? '大家都知道的：' : '她私下了解的：'), i.text))));
    }
    if (kind === 'assertion' && x.entities?.length) parts.push(ss('说的是谁', h('p', { class: 'mem-p' }, [...new Set(x.entities.filter((e) => e.role === 'subject').map((e) => who(e.entityId)))].join('、') || '没认出是谁')));
    // 放进过哪些对话 + 想起来过
    const inj = x.injectedIn ?? [];
    parts.push(ss('放进过哪些对话', h('p', { class: 'mem-p' }, inj.length ? `放进过 ${inj.length} 个对话，最近一次是 ${fmt.when(inj[0].lastAt)}。删了这条也收不回那些对话记录里已经有的字。` : '还没放进过对话。')));
    const act = x.activation;
    if (act) parts.push(ss('想起来过', h('p', { class: 'mem-p' }, act.traceCount ? `一共 ${act.traceCount} 次${act.lastTraceAt ? `，最近一次是 ${fmt.when(act.lastTraceAt)}` : ''}。` : '还没被想起过。')));
    // 技术细节（折叠）
    parts.push(h('div', { class: 'mem-ss' }, R.more('技术细节', R.kv([
      ['引用', h('span', { class: 'mem-mono' }, ref)],
      inj.length ? ['用在过的会话', h('span', { class: 'mem-mono' }, inj.slice(0, 12).map((i) => `${String(i.sessionId).slice(0, 12)} · ${fmt.when(i.lastAt)}`).join('，'))] : null,
      act ? ['激活', `档位 ${act.tier ?? '—'}${act.b != null ? ` · ${Number(act.b).toFixed(2)}` : ''}`] : null,
      x.identity?.length ? ['身份证据', h('span', { class: 'mem-mono' }, x.identity.slice(0, 20).map((i) => `${i.namespace}${i.scope ? `/${i.scope}` : ''}:${i.hash ?? ''}（${i.strength ?? ''}）`).join('，'))] : null,
      sup ? ['收起来的', `${sup.by === 'owner' ? '你' : sup.by ?? '系统'}操作的${sup.reason ? ` · ${sup.reason}` : ''}`] : null,
      kind === 'percept' && x.windows?.length ? ['原文片段', h('span', { class: 'mem-mono' }, x.windows.join('，'))] : null,
    ]))));
    R.clear(body, parts);
    // 底部：危险区（彻底删除）在左边；隐藏 / 忘掉 / 恢复在右边
    const ro = S.readOnly;
    R.clear(foot,
      btn('彻底删除…', { kind: 'danger-ghost', size: 'sm', ic: 'trash', disabled: ro, onclick: () => purge([ref]) }),
      h('span', { class: 'sp' }),
      sup ? btn('恢复', { size: 'sm', disabled: ro, onclick: async () => { if (await setState(ref, null, sup.state)) { closeSheet(); } } })
        : [btn('隐藏', { size: 'sm', disabled: ro, onclick: async () => { if (await setState(ref, 'hidden', null)) closeSheet(); } }),
          btn('忘掉', { size: 'sm', disabled: ro, onclick: async () => { if (await setState(ref, 'forgotten', null)) closeSheet(); } })]);
    if (ro) foot.prepend(h('div', { class: 'mem-ro-foot' }, `${roHint}，这里的操作先关着。`));
  }

  // ── 时间：自定时间段、跳到某一天 ──────────────────────────────────────
  function customRange() {
    const f = S.list.f;
    const toDate = (t) => { if (t == null) return ''; const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const a = h('input', { type: 'date', class: 'input', id: 'mem-from', value: toDate(f.from) });
    const b = h('input', { type: 'date', class: 'input', id: 'mem-to', value: toDate(f.to) });
    const msg = h('div', { class: 'err', role: 'alert', hidden: true });
    const parse = (v, end) => { if (!v) return null; const [y, m, d] = v.split('-').map(Number); const t = new Date(y, m - 1, d).getTime(); return end ? t + DAY - 1 : t; };
    const ok = btn('看这段时间', { kind: 'primary', onclick: () => {
      const from = parse(a.value, false); const to = parse(b.value, true);
      if (from == null && to == null) { msg.hidden = false; R.clear(msg, '至少填一头。'); return; }
      if (from != null && to != null && from > to) { msg.hidden = false; R.clear(msg, '开始不能晚于结束。'); return; }
      l.close();
      setFilters({ time: 'range', from, to });
    } });
    const l = R.dialog({ title: '看一段时间里的', body: [h('p', null, '两头都包含在内；只填一头就是「从那天起」或「到那天为止」。'),
      h('div', { class: 'mem-range' }, h('div', { class: 'field' }, h('label', { for: 'mem-from' }, '从'), a), h('div', { class: 'field' }, h('label', { for: 'mem-to' }, '到'), b)), msg],
    actions: [btn('取消', { onclick: () => l.close() }), ok], initial: () => a });
  }

  async function jumpDialog() {
    const L = S.list;
    const now = new Date();
    let y = now.getFullYear();
    let mo = now.getMonth();
    const grid = h('div', { class: 'mem-cal', role: 'grid', 'aria-label': '月历' });
    const title = h('b', { class: 'mem-cal-t' });
    const prevB = btn('', { kind: 'ghost', size: 'sm', ic: 'left', title: '上个月' });
    const nextB = btn('', { kind: 'ghost', size: 'sm', ic: 'right', title: '下个月' });
    const note = h('p', { class: 'mem-faint mem-cal-note' }, '数字是那天有几条。点一天，从那天开始看；更早、更晚的照样能接着翻。');
    let bounds = { first: null, last: null };
    async function draw() {
      R.clear(title, `${y} 年 ${mo + 1} 月`);
      R.clear(grid, R.loading(''));
      const month = `${y}-${String(mo + 1).padStart(2, '0')}`;
      let d;
      try { const [v, q] = daysRequestFor(L.f, month); d = await R.api.get(v, q); } catch (e) { R.clear(grid, h('p', { class: 'err' }, R.errorText(e, 'read'))); return; }
      bounds = { first: d.first ?? null, last: d.last ?? null };
      const counts = new Map((d.items ?? []).map((x) => [Number(x.day.slice(8, 10)), x.n]));
      const max = Math.max(1, ...counts.values());
      const startW = (new Date(y, mo, 1).getDay() + 6) % 7;
      const days = new Date(y, mo + 1, 0).getDate();
      const cells = ['一', '二', '三', '四', '五', '六', '日'].map((w) => h('div', { class: 'mem-cal-w', 'aria-hidden': 'true' }, w));
      for (let i = 0; i < startW; i++) cells.push(h('div'));
      for (let dd = 1; dd <= days; dd++) {
        const n = counts.get(dd) ?? 0;
        const lv = n ? Math.min(4, 1 + Math.floor((n / max) * 3.999)) : 0;
        const b = h('button', { type: 'button', class: `mem-cal-d l${lv}`, disabled: !n, 'aria-label': `${mo + 1}月${dd}日，${n ? `${n} 条` : '那天没有'}` },
          h('span', null, String(dd)), n ? h('small', null, n > 999 ? '999+' : String(n)) : null);
        b.addEventListener('click', () => { l.close(); setFilters({ at: jumpAt(new Date(y, mo, dd).getTime(), L.f.order === 'rank' ? 'desc' : L.f.order), order: L.f.order === 'rank' ? 'desc' : L.f.order }, { keepAt: true }); });
        cells.push(b);
      }
      R.clear(grid, cells);
      const ym = (t) => { const x = new Date(t); return x.getFullYear() * 12 + x.getMonth(); };
      prevB.disabled = bounds.first == null || ym(bounds.first) >= y * 12 + mo;
      nextB.disabled = bounds.last == null || ym(bounds.last) <= y * 12 + mo;
    }
    prevB.addEventListener('click', () => { mo -= 1; if (mo < 0) { mo = 11; y -= 1; } draw(); });
    nextB.addEventListener('click', () => { mo += 1; if (mo > 11) { mo = 0; y += 1; } draw(); });
    const l = R.dialog({ title: '跳到某一天', body: [h('div', { class: 'mem-cal-h' }, prevB, title, nextB), grid, note],
      actions: [btn('从最早的看', { kind: 'ghost', onclick: () => { l.close(); setFilters({ order: 'asc', at: null }); } }), h('span', { class: 'sp' }),
        btn('取消', { onclick: () => l.close() }), btn('看最新的', { kind: 'primary', onclick: () => { l.close(); setFilters({ order: 'desc', at: null }); } })] });
    l.box.classList.add('mem-cal-dlg');
    draw();
  }

  // ════════════════════════════════════════════════════════════════════════
  // 人物
  // ════════════════════════════════════════════════════════════════════════
  async function renderPeople(body, route) {
    R.clear(body, R.loading('正在看她认识谁…'));
    let d;
    try { d = await R.api.get('people'); } catch (e) { R.clear(body, R.errorBox(e, () => renderPeople(body, route), { title: '人物读不出来' })); return; }
    if (d?.unsupported) { R.clear(body, R.empty({ ic: 'users', title: '这个版本还看不了人物', text: '插件更新、重启 DSH 后再来看；可以先去旧版的「记忆 → 人与物」。' })); return; }
    if (typeof d.readOnly === 'boolean') S.readOnly = d.readOnly;
    const all = d.items ?? [];
    if (!all.length) {
      R.clear(body, R.empty({ ic: 'users', title: '还没认识谁', text: '她在群里、私聊里遇到的人会出现在这里：叫什么、什么关系、她记得关于他们的哪些事。' }));
      return;
    }
    const q = h('input', { type: 'search', placeholder: '搜名字', 'aria-label': '搜名字', autocomplete: 'off' });
    const grid = h('div', { class: 'mem-people', role: 'list' });
    const draw = () => {
      const s = q.value.trim();
      const xs = all.filter((p) => !s || p.name.includes(s) || p.aliases?.some((a) => a.includes(s)));
      R.clear(grid, xs.length ? xs.map(personCard) : h('p', { class: 'quiet' }, `没有叫「${clip(s, 16)}」的人。`));
    };
    q.addEventListener('input', draw);
    const mergeBox = h('div');
    R.clear(body, mergeBox, h('div', { class: 'toolbar mem-toolbar spaced' }, h('label', { class: 'search mem-psearch' }, icon('search', 16), q),
      h('span', { class: 'mem-faint mem-pcount' }, `${all.length} 个`)), grid);
    draw();
    if (route.params.person) openPerson(Number(route.params.person));
    // 等你确认的「可能是同一个人」（读不出来就不提）
    try {
      const r = await R.api.get('review', { kind: 'merge' });
      const m = (r.items ?? [])[0];
      if (m && mergeBox.isConnected) {
        const n = (id) => (typeof r.names?.[id] === 'string' ? r.names[id] : all.find((p) => p.members?.includes(id))?.name) ?? '一个人';
        R.clear(mergeBox, h('div', { class: 'mem-merge' }, R.note('info', `「${n(m.payload?.a)}」和「${n(m.payload?.b)}」可能是同一个人，等你确认。${(r.total ?? 1) > 1 ? `（一共 ${r.total} 对）` : ''}`,
          btn('去看看', { size: 'sm', kind: 'ghost', onclick: () => R.go('pending/approve') }))));
      }
    } catch { /* 读不出来就不提 */ }
  }
  const KIND_IC = { place: 'map', pet: 'paw', thing: 'archive', group: 'users', org: 'users' };
  function leadOf(p, big = false) {
    const ic = KIND_IC[p.kind];
    const chars = [...(p.principal ? '你' : p.name ?? '')];
    return h('span', { class: `lead mem-plead${big ? ' big' : ''}`, 'aria-hidden': 'true' }, ic ? icon(ic, big ? 20 : 16) : chars.length ? chars.at(-1) : '？');
  }
  function personCard(p) {
    const sub = [p.aliases?.length ? `也叫${p.aliases.slice(0, 2).join('、')}` : null, p.kind !== 'person' ? KIND_NAME_ENT[p.kind] ?? null : null].filter(Boolean).join(' · ');
    return h('div', { class: 'card mem-pcard', role: 'listitem' }, leadOf(p),
      h('div', { class: 'main' },
        h('button', { type: 'button', class: 'hit', onclick: () => R.setParams({ person: String(p.id) }) }, h('div', { class: 'nm' }, p.principal ? '你' : p.name, p.principal ? [' ', tag('主人', 'gold')] : null)),
        p.impression ? h('div', { class: 'imp' }, p.impression) : sub ? h('div', { class: 'imp' }, sub) : null,
        metaLine(`记得 ${fmt.num(p.n)} 件事`, p.lastAt ? `最近 ${fmt.day(p.lastAt)}` : null)));
  }
  const KIND_NAME_ENT = { person: '人', place: '地方', thing: '东西', group: '群体', org: '组织', pet: '宠物' };

  async function openPerson(id) {
    if (!Number.isSafeInteger(id)) return;
    closeSheet();
    S.personId = id;
    const body = h('div', null, R.loading('正在读这个人…'));
    const foot = h('div', { class: 'mem-sfoot' });
    const layer = R.sheet({ kicker: ['人物'], body, foot, label: '人物详情',
      onClose: () => { if (S.sheet === layer) { S.sheet = null; S.personId = null; if (R.route()?.params.person) R.setParams({ person: '' }); } } });
    S.sheet = layer;
    let d; let mem;
    try {
      [d, mem] = await Promise.all([R.api.get('people', { id }), R.api.get('feed', { entityId: id, limit: 6 }).catch((e) => ({ error: e }))]);
    } catch (e) {
      if (S.sheet !== layer) return;
      R.clear(body, R.errorBox(e, () => { closeSheet(); openPerson(id); }, { title: '这个人读不出来' }));
      return;
    }
    if (S.sheet !== layer) return;
    const p = d.items?.[0];
    if (!p) { R.clear(body, R.empty({ ic: 'users', title: '没找到这个人', text: '可能已经被删掉，或者和别人认成了同一个人。' })); return; }
    const dt = d.detail ?? {};
    const ctx = { names: { ...(dt.who ?? {}), ...(mem?.names ?? {}) }, settings: { ...(d.allSettings ?? {}), ...(dt.settings ?? {}), ...(mem?.settings ?? {}) }, allSettings: S.meta?.allSettings ?? {}, people: S.meta?.pickable ?? [] };
    const place = (k) => placeName(ctx, k) ?? '某个场合';
    const kick = layer.box.querySelector('.shead .k');
    R.clear(kick, KIND_NAME_ENT[p.kind] ?? '人物', p.principal ? tag('主人', 'gold') : null);
    const names = dt.names ?? [];
    const imps = dt.impressions ?? [];
    const rows = (mem?.items ?? []).map((m) => ({ ...m, _t: m.kind }));
    const parts = [
      h('div', { class: 'mem-phead' }, leadOf(p, true), h('div', null, h('div', { class: 'mem-big' }, p.principal ? '你' : p.name),
        metaLine(p.aliases?.length ? `也叫${p.aliases.join('、')}` : null, `记得 ${fmt.num(p.n)} 件事`, p.lastAt ? `最近一次 ${fmt.when(p.lastAt)}` : null))),
      ss('她的印象', imps.length ? imps.map((i) => h('p', { class: 'mem-p' }, imps.length > 1 ? h('span', { class: 'mem-faint' }, i.layer === 'shared' ? '大家都知道的：' : '她私下了解的：') : null, i.text))
        : h('p', { class: 'mem-p mem-faint' }, p.impression ?? '还没形成印象。和他聊得多了，夜里整理时会慢慢有。')),
      names.length ? ss('大家怎么叫', h('div', { class: 'mem-names' }, names.slice(0, 16).map((n) => h('div', { class: 'mem-name' }, h('b', null, n.text),
        h('span', null, [n.scope ? `在「${place(n.scope)}」` : '各处', `${n.count} 次`].join(' · ')))))) : null,
      dt.descriptors?.length ? ss('关系', dt.descriptors.map((r) => h('p', { class: 'mem-p' }, `${whoName(ctx, r.anchor)}的${r.relation}${r.text ? `：${r.text}` : ''}`))) : null,
      ss(`关于他的记忆（${fmt.num(p.n)}）`, mem?.error ? h('p', { class: 'err' }, R.errorText(mem.error, 'read'))
        : rows.length ? h('div', { class: 'list' }, rows.map((m) => R.row({ title: m.text, tags: tagsOf(m).map(([t, tone]) => tag(t, tone)), meta: metaLine(metaParts(m, ctx)),
          onOpen: () => { closeSheet(); R.go('memory/list', { params: { who: String(p.id), open: m.ref } }); } })))
          : h('p', { class: 'mem-p mem-faint' }, '名下还没有事实、经历或打算。'),
      h('div', { class: 'mem-src-go' }, R.link('在记忆列表里看全部', () => { closeSheet(); R.go('memory/list', { params: { who: String(p.id) } }); }))),
      h('div', { class: 'mem-ss' }, R.more('技术细节', R.kv([
        ['档案', h('span', { class: 'mem-mono' }, (dt.members ?? p.members.map((m) => ({ id: m }))).map((m) => `n${m.id}${m.status ? `（${m.status === 'established' ? '认得' : m.status === 'provisional' ? '还不确定' : m.status === 'retracted' ? '撤销了' : m.status}）` : ''}`).join('，'))],
        dt.links?.length ? ['认成同一个人', dt.links.map((l) => `n${l.a}–n${l.b} ${l.rel === 'same' ? '同一个人' : l.rel === 'maybe_same' ? '可能是' : '不是'}（${l.decidedBy === 'owner' ? '你定的' : l.decidedBy}）`).join('；')] : null,
        ['名下', `事实 ${p.facts ?? '—'} · 经历 ${p.episodes ?? '—'} · 打算 ${p.intents ?? '—'}`],
      ]))),
    ];
    R.clear(body, parts);
    const ro = S.readOnly;
    R.clear(foot, btn('按来源撤回…', { size: 'sm', kind: 'danger-ghost', disabled: ro, onclick: () => withdraw(p) }), h('span', { class: 'sp' }),
      btn('隐藏这个人', { size: 'sm', disabled: ro, onclick: async () => { if (await setState(`n${p.id}`, 'hidden', null)) closeSheet(); } }));
    if (ro) foot.prepend(h('div', { class: 'mem-ro-foot' }, `${roHint}，这里的操作先关着。`));
  }
  /** 按来源撤回（§12.7）：这个人某段时间里说的全部内容先对别人隐藏、进「等你批准」，批准了才删。 */
  async function withdraw(p) {
    let span = 1;
    const sel = R.seg([['1', '最近 24 小时'], ['7', '最近 7 天'], ['30', '最近 30 天']], '1', (k) => { span = Number(k); sel.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === k))); }, '撤回多久的');
    const now = Date.now();
    try {
      const r = await R.api.confirmed('source.withdraw', { entityId: p.id, from: now - DAY, to: now }, {
        title: `按来源撤回${p.name}说的`, okText: '撤回',
        consequence: `把${p.name}在这段时间里说的全部内容，和由它们整理出来的记忆，先对别人隐藏，再放进「等你批准」。批准了才删，驳回就恢复原样。`,
        extra: (state) => { sel.addEventListener('click', () => { state.params = { from: now - span * DAY, to: now }; }); return h('div', { class: 'mem-wd' }, sel); },
      });
      if (r) { R.toast('已撤回，在「等你批准」里等你决定'); closeSheet(); }
    } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 星图（starmap.client.js 的新挂载：星空和时间轴它画，工具条和详情这里画）
  // ════════════════════════════════════════════════════════════════════════
  function renderStarmap(body) {
    const lib2 = window.__pmStarmap;
    if (!lib2?.mount) { R.clear(body, R.empty({ ic: 'warn', tone: 'warn', title: '星图的脚本没有加载', text: '别的页照常能用；可以先去旧版的「星图」页签看。' })); return; }
    if (!S.sky) {
      const bar = h('div', { class: 'mem-skybar' });
      const skyEl = h('div', { class: 'mem-sky' });
      const panel = h('aside', { class: 'card mem-starpanel', 'aria-label': '选中的那颗星' });
      const wrap = h('div', { class: 'mem-skyw' }, skyEl, panel);
      const root = h('div', { class: 'mem-skyroot' }, bar, wrap);
      const searchIn = h('input', { type: 'search', placeholder: '搜记忆', 'aria-label': '在星图里搜记忆，搜到的星会亮起来', autocomplete: 'off' });
      const hits = h('span', { class: 'mem-hits', role: 'status' });
      let st = 0;
      searchIn.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => sky.inst?.control.search(searchIn.value), 450); });
      searchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(st); sky.inst?.control.search(searchIn.value); } if (e.key === 'Escape' && searchIn.value) { e.stopPropagation(); searchIn.value = ''; sky.inst?.control.search(''); } });
      const sky = S.sky = { root, bar, skyEl, panel, searchIn, hits, model: null, state: 'loading', inst: null };
      drawPanel(null);
      sky.inst = lib2.mount(skyEl, {
        h, add: R.add, clear: R.clear, api: R.api, toast: R.toast, reduce: window.matchMedia?.('(prefers-reduced-motion: reduce)'),
        go: () => R.go('memory/list'), openMemory: (ref) => R.setParams({ open: ref }),
        external: {
          maxRoot: root,
          onModel: (m) => { sky.model = m; drawSkyBar(); },
          onSelect: (info) => drawPanel(info),
          onSearch: (s) => { R.clear(hits, s.busy ? '在搜…' : s.error ? `搜不了：${s.error}` : s.n == null ? '' : s.n ? `亮了 ${fmt.num(s.n)} 颗` : '没有搜到'); },
          onState: (s) => { sky.state = s; drawSkyBar(); if (s === 'error' || s === 'unsupported' || s === 'empty') drawPanel(null); },
        },
      });
    }
    R.clear(body, S.sky.root);
    drawSkyBar();
    requestAnimationFrame(() => S.sky?.inst?.show());
  }
  /**
   * 星图的工具条。第一次建好以后原地更新（换摆法、点种类时按钮不重建，键盘焦点不丢）；场合的下拉、演示、放大按状态换。
   */
  function drawSkyBar() {
    const sky = S.sky;
    if (!sky) return;
    const m = sky.model;
    const ctl = () => sky.inst?.control;
    if (!m || sky.state === 'error' || sky.state === 'unsupported' || sky.state === 'empty') { R.clear(sky.bar); sky.ui = null; sky.root.classList.toggle('bare', true); return; }
    sky.root.classList.toggle('bare', false);
    if (!sky.ui || sky.ui.kinds.length !== m.kinds.length || !sky.bar.firstChild) {
      const segEl = R.seg([['people', '按人'], ['time', '按时间']], m.view, (v) => ctl()?.setView(v), '星星怎么摆');
      const kinds = m.kinds.map((k, i) => {
        const dot = h('i'); dot.style.background = k.color;
        const n = h('span', { class: 'n' });
        const b = h('button', { type: 'button', class: 'mem-kchip', title: `只看 / 不看「${k.name}」`, onclick: () => ctl()?.setKind(i, b.getAttribute('aria-pressed') !== 'true') }, dot, k.name, n);
        return { b, n };
      });
      const placeSlot = h('span', { class: 'mem-slot' });
      const demoSlot = h('span', { class: 'mem-slot' });
      const maxSlot = h('span', { class: 'mem-slot' });
      sky.ui = { segEl, kinds, placeSlot, demoSlot, maxSlot, key: '' };
      R.clear(sky.bar, segEl, h('div', { class: 'mem-kinds', role: 'group', 'aria-label': '显示哪几种（点一下只看 / 不看这一种）' }, kinds.map((k) => k.b)),
        h('div', { class: 'end' }, h('label', { class: 'search mem-skysearch' }, icon('search', 16), sky.searchIn), sky.hits, placeSlot, demoSlot, maxSlot));
    }
    const ui = sky.ui;
    for (const b of ui.segEl.querySelectorAll('button')) { const on = b.dataset.k === m.view; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
    m.kinds.forEach((k, i) => { ui.kinds[i].b.setAttribute('aria-pressed', String(k.on)); R.clear(ui.kinds[i].n, fmt.num(k.n)); });
    const key = JSON.stringify([m.place, m.demo, m.max, m.places.map((p) => p.label)]);
    if (key === ui.key) return;
    ui.key = key;
    const keep = document.activeElement;
    const where = [ui.placeSlot, ui.demoSlot, ui.maxSlot].find((sl) => sl.contains(keep));
    const placeOpts = m.places.map((p, i) => (i === 1 ? [{ sep: true }, p] : [p])).flat()
      .map((p) => (p.sep ? p : { value: p.value, label: p.n != null ? `${clip(p.label, 18)}（${fmt.num(p.n)}）` : p.label }));
    R.clear(ui.placeSlot, R.dropdown('场合', placeOpts, m.place, (v) => ctl()?.setPlace(v), { allValue: 'all' }));
    const demo = btn(m.demo ? '退出演示' : '演示模式', { kind: 'ghost', size: 'sm', ic: 'eyeoff', attrs: { 'aria-pressed': String(m.demo), title: '名字换成代称、不显示内容（截图、录屏用）' }, onclick: () => ctl()?.setDemo(!m.demo) });
    const max = btn('', { kind: 'ghost', size: 'sm', ic: m.max ? 'min' : 'max', title: m.max ? '缩回（Esc）' : '放大', onclick: () => ctl()?.toggleMax() });
    R.clear(ui.demoSlot, demo);
    R.clear(ui.maxSlot, max);
    // 焦点在换掉的那个上（点了演示 / 放大、选了场合）：放回新的那一个
    if (where) where.firstElementChild?.focus({ preventScroll: true });
  }
  /** 右边的小卡：选中那颗星的内容、状态、亮度曲线、想起过几次；没选时一句提示。 */
  function drawPanel(info) {
    const sky = S.sky;
    if (!sky) return;
    if (!info) {
      R.clear(sky.panel, h('div', { class: 'mem-sp-empty' }, icon('stars', 20), h('p', null, sky.state === 'empty' ? '她每记住一件事，这里就多一颗星。' : '点星图上的任何一颗星，看它是哪条记忆。'),
        sky.state !== 'empty' ? h('p', { class: 'mem-faint' }, '拖动平移、滚轮缩放、空格回放；Esc 回到原样。') : null));
      return;
    }
    const dot = h('i', { class: 'mem-dot' }); dot.style.background = info.color;
    const peek = info.peek;
    const text = info.demo ? h('p', { class: 'mem-faint' }, '演示模式：不显示内容')
      : peek === undefined ? h('p', { class: 'mem-faint' }, '正在读这条记忆…')
        : peek ? [peek.title ? h('div', { class: 'mem-sp-t' }, peek.title) : null, peek.text && peek.text !== peek.title ? h('p', { class: 'mem-p' }, peek.text) : null]
          : h('p', { class: 'mem-faint' }, '读不到内容（可能刚被隐藏或删掉）');
    R.clear(sky.panel,
      h('div', { class: 'mem-sp-h' }, dot, h('span', null, info.kindName), h('span', { class: 'when' }, info.when),
        btn('', { kind: 'ghost', size: 'sm', ic: 'x', title: '取消选中', onclick: () => info.close() })),
      h('div', { class: 'mem-sp-body' }, text),
      R.kv([['在哪儿', info.place], ['有关的人', info.who], ['状态', [info.status, info.newer ? [' ', R.link('看新的那条', info.newer, { arrow: false })] : null, info.older ? [' ', R.link('看旧的那条', info.older, { arrow: false })] : null]],
        info.cert ? ['从哪儿知道', info.cert] : null]),
      h('div', { class: 'mem-ss' }, h('h3', null, '亮度'), h('p', { class: 'mem-p' }, `${info.live ? '此刻' : '这时'} ${info.bright}%`, h('span', { class: 'mem-faint' }, ` · 痕迹 ${info.traces} 条`)),
        h('div', { class: 'mem-curve' }, info.curve)),
      h('div', { class: 'mem-ss' }, h('h3', null, `想起过 ${info.recalls} 次${info.tells ? ` · 讲给别人 ${info.tells} 次` : ''}`),
        info.last.length ? h('ul', { class: 'mem-recs' }, info.last.map((r) => { const ln = h('i'); ln.style.borderColor = r.color; return h('li', null, ln, h('span', null, r.when), h('span', { class: 'p' }, `在「${r.place}」· ${r.layer}`)); }))
          : h('p', { class: 'mem-faint' }, info.recalls ? '这个时刻之前还没想起过' : '还没被想起过')),
      h('div', { class: 'mem-sp-f' }, btn('打开这条记忆', { size: 'sm', onclick: () => info.open() })));
  }

  // ════════════════════════════════════════════════════════════════════════
  // 成长（她的性格）
  // ════════════════════════════════════════════════════════════════════════
  async function renderGrowth(body) {
    R.clear(body, R.loading('正在读她的性格…'));
    let d;
    try { d = await R.api.get('growth'); } catch (e) { R.clear(body, R.errorBox(e, () => renderGrowth(body), { title: '她的性格读不出来' })); return; }
    const versions = d.versions ?? [];
    const cur = versions.find((v) => v.version === d.current);
    const modeLine = h('p', { class: 'mem-mode' }, d.mode === 'approve' ? '每处新的变化都先放进「等你批准」。' : '新的变化自动写进去，你随时能撤销。', ' ',
      R.link('改', 'settings/basic', { arrow: false }));
    const ro = S.readOnly;
    if (!versions.length) {
      R.clear(body, h('div', { class: 'narrow' }, modeLine, R.empty({ ic: 'sprout', title: '她的性格还没长出新的部分',
        text: '夜里整理时，如果她在不同的场合、不同的人面前都一样地变了（至少 5 段经历、跨 3 天），会写在这里。你随时能撤销。' })));
      return;
    }
    const lines = String(cur?.text ?? '').split('\n').filter(Boolean);
    const now = h('div', { class: 'card mem-now' }, lines.length ? lines.map((l) => h('p', null, l)) : h('p', { class: 'mem-faint' }, '现在是第 0 版：长出来的部分都撤销了，她就是人设本来的样子。'));
    const items = versions.map((g) => growthRow(g, d.current, ro));
    const live = versions.filter((v) => !v.revokedAt && ['add', 'revise', 'remove'].includes(v.change?.op)).length;
    R.clear(body, h('div', { class: 'narrow' },
      R.section('她现在的样子', cur ? `第 ${cur.version} 版 · ${fmt.when(cur.createdAt)}` : '第 0 版', now, modeLine),
      R.section('怎么变成这样的', null, h('div', { class: 'list mem-growth' }, items)),
      h('div', { class: 'mem-more-sec' }, R.more('更多', h('div', { class: 'form' }, R.frow({ title: '清空她的性格变化', hint: '回到第 0 版：长出来的部分全部去掉，人设本身不变。',
        control: btn('清空…', { kind: 'danger-ghost', size: 'sm', disabled: ro || d.current === 0, onclick: () => rollback(0, live, body) }), right: true }))))));
    if (ro) body.querySelector('.narrow').prepend(h('div', { class: 'mem-ro' }, roNote()));
  }
  function growthRow(g, current, ro) {
    const c = g.change ?? {};
    const title = c.op === 'revoke' ? `撤销了第 ${c.of} 版的变化` : c.op === 'rollback' ? `回到了第 ${c.to} 版` : OP[c.op] ?? '有了变化';
    const diff = c.op === 'revoke' || c.op === 'rollback' ? null : h('div', { class: 'mem-diff' },
      c.before ? h('div', { class: 'del' }, h('span', { class: 'sign', 'aria-hidden': 'true' }, '−'), h('span', null, h('span', { class: 'sr' }, '之前：'), c.before)) : null,
      c.after ? h('div', null, h('span', { class: 'sign', 'aria-hidden': 'true' }, '+'), h('span', null, h('span', { class: 'sr' }, '之后：'), c.after)) : null,
      c.op === 'purge' && c.removed ? h('div', null, h('span', { class: 'sign' }, '−'), h('span', null, `去掉了 ${c.removed} 行`)) : null,
      c.purged ? h('div', { class: 'mem-faint' }, '这一处的文字因为彻底删除抹掉了') : null);
    const ev = (g.evidenceRefs ?? []).filter((r) => /^[pweanitscl][1-9]\d{0,15}$/.test(r));
    const items = [];
    if (!g.revokedAt && !c.purged && ['add', 'revise', 'remove'].includes(c.op)) items.push({ label: '撤销这一处', ic: 'undo', disabled: ro, onSelect: () => revoke(g) });
    if (g.version !== current && !g.revokedAt) items.push({ label: '回到这一版', ic: 'undo', disabled: ro, onSelect: () => rollback(g.version) });
    if (ro && items.length) items.push({ hint: `${roHint}，改不了。` });
    return h('div', { class: 'row mem-grow' },
      h('div', { class: 'main' },
        h('div', { class: 'ttl strong' }, `第 ${g.version} 版 · ${title}`, g.version === current ? [' ', tag('现在', 'gold')] : null, g.revokedAt ? [' ', tag('已撤销')] : null),
        diff,
        metaLine(g.createdBy === 'owner' ? '你改的' : g.createdBy === 'sleep' ? '夜里整理时写的' : g.createdBy ?? null, fmt.when(g.createdAt), g.revokedAt ? `${fmt.when(g.revokedAt)} 撤销` : null),
        ev.length ? h('div', { class: 'mem-ev' }, h('span', { class: 'mem-faint' }, `依据 ${ev.length} 段经历：`), ev.slice(0, 8).map((r, i) => R.link(String(i + 1), () => R.setParams({ open: r }), { arrow: false }))) : null),
      items.length ? h('div', { class: 'trail' }, R.moreButton(items, `第 ${g.version} 版的操作`)) : null);
  }
  async function revoke(g) {
    const ok = await R.confirmSimple({ title: '撤销这一处变化', text: '她的性格里会去掉这一处。没有新的依据的话，同样的变化不会再写回来。', okText: '撤销这一处' });
    if (!ok) return;
    try { await R.api.act('growth.revoke', { version: g.version }); } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); return; }
    R.toast('已撤销这一处');
    rerender();
  }
  async function rollback(version, live) {
    try {
      const r = await R.api.confirmed('growth.rollback', { version }, {
        title: version === 0 ? '清空她的性格变化' : `回到第 ${version} 版`, okText: version === 0 ? '清空' : '回到这一版',
        render: (pv) => h('p', null, version === 0 ? `长出来的${live ? ` ${live} 处` : '部分'}都会去掉，记为被撤销；人设本身不变。没有新的依据，同样的变化不会再写回来。`
          : `第 ${version} 版之后的 ${pv?.undone ?? 0} 处变化都会记为被撤销，她的性格回到那时候的样子。`),
      });
      if (r) { R.toast(version === 0 ? '已清空，回到第 0 版' : `已回到第 ${version} 版`); rerender(); }
    } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 模块
  // ════════════════════════════════════════════════════════════════════════
  let host = null;
  let lastRoute = null;
  function rerender() { if (host && lastRoute) render(host, lastRoute); }
  async function render(el, route) {
    host = el; lastRoute = route;
    closeSheet();
    document.querySelector('.mem-bulk')?.remove();
    if (S.sub === 'starmap' && route.sub !== 'starmap') S.sky?.inst?.hide();
    S.sub = route.sub;
    const body = h('div', { class: `mem-body mem-sub-${route.sub}` });
    R.clear(el, h('div', { class: `wrap mem-wrap${route.sub === 'starmap' ? ' mem-wide' : ''}` }, head(route), body));
    if (route.sub === 'people') await renderPeople(body, route);
    else if (route.sub === 'starmap') renderStarmap(body);
    else if (route.sub === 'growth') await renderGrowth(body);
    else await renderList(body, route);
    if (route.sub !== 'list' && route.params.open) openDetail(route.params.open);
  }
  /** 同一个分段只是参数变了：打开 / 关掉详情、人物；筛选变了就在原地重读列表。 */
  function update(route) {
    lastRoute = route;
    const p = route.params;
    if (route.sub === 'list' && S.list) {
      const f = filtersOf(p);
      if (!sameFilters(f, S.list.f)) {
        closeSheet();
        S.list.f = f; S.list.picking = false; S.list.picked.clear(); document.querySelector('.mem-bulk')?.remove();
        if (S.list.els.search.value.trim() !== f.q) S.list.els.search.value = f.q;
        drawToolbar();
        loadFirst();
        return true;
      }
    }
    if (route.sub === 'people') {
      const id = p.person ? Number(p.person) : null;
      if (id !== S.personId) { if (id) openPerson(id); else closeSheet(); }
      return true;
    }
    if ((p.open ?? null) !== S.sheetRef) { if (p.open) { closeSheet(); openDetail(p.open); } else closeSheet(); }
    return true;
  }
  function leave() {
    closeSheet();
    document.querySelector('.mem-bulk')?.remove();
    S.sky?.inst?.hide();
    S.list?.io?.disconnect();
  }

  return { render, update, leave, lib };
});
