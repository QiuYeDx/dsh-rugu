// 首页（D170）：一句话状态；需要你看一眼（最多 3 条 + 去全部）；她最近记住的；入口；四行健康；今天的花费。
// 数据只来自一个视图 admin.data?view=home（packages/dsh/src/admin/views.js 的 home + 核心的 admin.home）。工程数字一个都不上首页。
Rugu.define('home', (R) => {
  const { h, icon, fmt, section, link, row, list, metaLine, status, btn } = R;

  // ── 人和场合的叫法 ────────────────────────────────────────────────────
  const nameOf = (d, id) => {
    if (id == null) return null;
    const n = d.names?.[id];
    if (!n) return '有人';
    if (n.principal) return '你';
    if (n.self) return '她';
    return n.name || '没认出是谁的人';
  };
  const clip = (s, n) => { const c = [...String(s ?? '')]; return c.length > n ? `${c.slice(0, n).join('')}…` : c.join(''); };
  // 场合名在小字里最多 14 个字（群名可以很长，整句会被挤成好几行）
  const placeOf = (d, key) => (key ? clip(d.settings?.[key] ?? '某个场合', 14) : null);
  const inPlace = (d, key) => (key ? `在「${placeOf(d, key)}」` : null);

  // ── 需要你看一眼：每种待处理的一句话 ─────────────────────────────────
  /** @returns {{ic: string, cap: string, title: string, to: string}} */
  function pendingText(d, x) {
    const who = nameOf(d, x.who) ?? '有人';
    const q = x.quote ? `「${clip(x.quote, 24)}」` : null;
    if (x.source === 'needToKnow') {
      if (x.kind === 'T1' && x.reason === 'secrecy-request') return { ic: 'eyeoff', cap: '有人要她瞒着你', title: `${who}要她别把一件事告诉你`, to: 'pending/ntk' };
      if (x.kind === 'T1') return { ic: 'shield', cap: '有人想改她的设定', title: `${who}想给她定新规矩`, to: 'pending/ntk' };
      if (x.kind === 'T2') return { ic: 'alert', cap: '聊到了安全', title: q ? `${who}说${q}` : `${who}说到了可能有危险的事`, to: 'pending/ntk' };
      if (x.kind === 'poison') return { ic: 'alert', cap: '有人反复说同一件事', title: `${who}在反复对她说同一件事`, to: 'pending/ntk' };
      if (x.kind === 'taint') return { ic: 'info', cap: '来路不明的内容', title: '她读到了来路不明的内容', to: 'pending/ntk' };
      if (x.kind === 'foreign_write' && /^growth-v\d+$/.test(x.reason ?? '')) return { ic: 'sprout', cap: '她的性格有了变化', title: '夜里整理时，一处变化写进了她的性格', to: 'pending/ntk' };
      if (x.kind === 'foreign_write' && x.reason === 'growth-proposal') return { ic: 'sprout', cap: '她的性格想改一处', title: '夜里整理提议改她的性格', to: 'pending/ntk' };
      if (x.kind === 'foreign_write') return { ic: 'chat', cap: '新规矩', title: '她准备给一个场合写一条规矩', to: 'pending/ntk' };
      return { ic: 'info', cap: '需要你知道', title: q ?? '有一件事需要你知道', to: 'pending/ntk' };
    }
    if (x.kind === 'held_utterance') return { ic: 'msgoff', cap: '她想说一句话，先停下来问你', title: q ?? '她想说一句话', to: 'pending/approve' };
    if (x.kind === 'merge') return { ic: 'merge', cap: '可能是同一个人', title: `「${who}」和「${nameOf(d, x.other) ?? '另一个人'}」可能是同一个人`, to: 'pending/approve' };
    if (x.kind === 'growth') return { ic: 'sprout', cap: '她的性格想改一处', title: q ? `想写进她的性格：${q}` : '夜里整理想改她的性格', to: 'pending/approve' };
    if (x.kind === 'forget_request') return { ic: 'eyeoff', cap: '有人要求忘掉', title: `${who}要她忘掉一条记忆`, to: 'pending/approve' };
    if (x.kind === 'withdraw') return { ic: 'undo', cap: '按来源撤回', title: `撤回${who}说过的一些话`, to: 'pending/approve' };
    if (x.kind === 'setting_rule_relax') return { ic: 'chat', cap: '场合的规矩要放宽', title: q ?? '一个场合的规矩想放宽', to: 'pending/approve' };
    if (x.kind === 'norm_change') return { ic: 'shield', cap: '分寸要改', title: '一件事能对谁说，要你点头', to: 'pending/approve' };
    if (x.kind === 'owner_op') return { ic: 'shield', cap: '只有你能做的操作', title: '有人想做只有你能做的操作', to: 'pending/approve' };
    return { ic: 'inbox', cap: '等你批准', title: q ?? '有一件事等你批准', to: 'pending/approve' };
  }

  // ── 她最近记住的：每一行的小字（和记忆列表同一种写法） ─────────────
  const SOURCE = { stated: '亲口说的', confirmed: '确认过的', self_said: '她自己说的', hearsay: '听别人说的', inferred: '她猜的' };
  function recentMeta(d, m) {
    const now = d.now;
    if (m.kind === 'fact') {
      const n = d.names?.[m.who];
      const who = nameOf(d, m.who);
      const src = !who ? SOURCE[m.certainty] ?? null
        : m.certainty === 'hearsay' ? `听${who}说的`
          : n?.self ? '她自己说的'
            : n?.principal ? (m.certainty === 'stated' ? '你说的' : `你${SOURCE[m.certainty] ?? '说的'}`)
              : `${who}${SOURCE[m.certainty] ?? '说的'}`;
      return metaLine(src, placeOf(d, m.settingKey), fmt.when(m.at, now), m.confidence != null ? `把握 ${fmt.pct(m.confidence)}` : null);
    }
    if (m.kind === 'episode') {
      const ps = (m.participants ?? []).map((id) => nameOf(d, id)).filter(Boolean);
      const people = ps.length > 3 ? `${ps.slice(0, 3).join('、')}等 ${ps.length} 人` : ps.join('、');
      const span = m.tStart != null && fmt.day(m.tStart, now) === fmt.day(m.at, now) && m.at - m.tStart > 60_000
        ? `${fmt.day(m.at, now) === '今天' ? '' : `${fmt.day(m.at, now)} `}${fmt.clock(m.tStart)}–${fmt.clock(m.at)}` : fmt.when(m.at, now);
      return metaLine('经历', people || null, placeOf(d, m.settingKey), span);
    }
    if (m.kind === 'intent') {
      const who = nameOf(d, m.who);
      return metaLine(m.state === 'executed' ? '她做过了' : '她打算做的', who ? `对${who}` : null, m.until && m.state !== 'executed' ? `到 ${fmt.day(m.until, now)}` : null, fmt.when(m.at, now));
    }
    return metaLine(fmt.when(m.at, now));
  }

  // ── 入口：一行一个适配器 ─────────────────────────────────────────────
  const ENTRY_ICON = { 'dsh-web': 'monitor', qq: 'qq', bili: 'tv' };
  const ENTRY_UNIT = { 'dsh-web': '对话', qq: '群和私聊', bili: '评论区' };
  /** @returns {{right: Node|string, sub: string|null, to: string}} */
  function entryText(d, e) {
    const unit = ENTRY_UNIT[e.adapter] ?? '场合';
    const last = e.lastAt != null ? fmt.when(e.lastAt, d.now) : null;
    if (e.state === 'gone') return { right: status('没接着', 'dim'), sub: '这个入口现在没有加载', to: 'settings/connect' };
    if (e.state === 'none') {
      if (e.adapter === 'qq') return { right: R.h('span', { class: 'link', 'aria-hidden': 'true' }, '去接入'), sub: '还没接上', to: 'settings/connect' };
      if (e.adapter === 'dsh-web') return { right: status('还没有对话', 'dim'), sub: '新建任务时选「人设聊天」', to: 'places/list' };
      return { right: status(`还没有${unit}`, 'dim'), sub: null, to: 'places/list' };
    }
    if (e.state === 'paused') {
      const why = { readOnly: '记忆库只读', store: '记忆库读不出来', master: '总开关关着' }[e.pausedBy] ?? '先停着';
      return { right: status('暂停', 'warn'), sub: [`${e.places} 个${unit}`, why].join(' · '), to: e.pausedBy === 'master' ? 'settings/basic' : 'settings/diag' };
    }
    if (e.state === 'off') return { right: status('没在记', 'warn'), sub: [`${e.places} 个${unit}都关着`, last].filter(Boolean).join(' · '), to: 'places/list' };
    return { right: status('在记', 'ok'), sub: [`${e.places} 个${unit}`, last].filter(Boolean).join(' · '), to: 'places/list' };
  }

  // ── 画 ─────────────────────────────────────────────────────────────────
  const miniRow = ({ ic, name, sub, right, to, label }) => h('div', { class: 'home-mini' },
    h('button', { type: 'button', onclick: () => R.go(to), 'aria-label': label ?? null }, ic ? icon(ic, 16) : null,
      h('span', { class: 'l' }, name, sub ? h('small', null, sub) : null), h('span', { class: 'r' }, right), h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('right', 14))));

  function hero(d) {
    const hl = d.headline ?? { level: 'ok', title: '她在记着。', text: '' };
    const orb = { ok: ['ok', 'gu', 26, 1.9], quiet: ['quiet', 'gu', 26, 1.9], warn: ['warn', 'warn', 24], bad: ['bad', 'warn', 24] }[hl.level] ?? ['ok', 'gu', 26, 1.9];
    return h('div', { class: 'home-hero' }, h('div', { class: `home-orb ${orb[0]}`, 'aria-hidden': 'true' }, icon(orb[1], orb[2], orb[3])),
      h('div', null, h('h1', { tabindex: '-1', 'data-page-title': '' }, hl.title), hl.text ? h('p', null, hl.text) : null,
        hl.action ? btn(hl.action.label, { kind: 'primary', onclick: () => R.go(hl.action.to) }) : null));
  }

  function pendingSection(d) {
    const p = d.pending;
    const notices = d.notices ?? [];
    if (!p) return section('需要你看一眼', null, R.errorBox({ code: d.error }, null, { title: '待处理读不出来' }));
    const rows = [
      ...notices.slice(0, 2).map((n) => row({ lead: h('span', { class: `lead sm ${n.level === 'bad' ? 'bad' : 'warn'}` }, icon(n.level === 'bad' ? 'alert' : 'warn', 16)),
        title: n.text, strong: true, meta: metaLine(n.level === 'bad' ? '出了问题' : '要留意'), onOpen: () => R.go(n.to),
        trail: h('span', { 'aria-hidden': 'true' }, icon('right', 16)) })),
      ...p.top.slice(0, 3).map((x) => {
        const t = pendingText(d, x);
        return row({ lead: h('span', { class: 'lead sm' }, icon(t.ic, 16)), title: t.title, strong: true,
          meta: metaLine(t.cap, x.urgent ? h('span', { class: 'home-urgent' }, '要紧') : null, inPlace(d, x.settingKey), fmt.when(x.at, d.now)), onOpen: () => R.go(t.to, { params: { open: `${x.source === 'needToKnow' ? 'ntk' : 'rv'}-${x.id}` } }),
          trail: h('span', { 'aria-hidden': 'true' }, icon('right', 16)) });
      }),
    ];
    const aside = p.total ? link(`全部 ${p.total} 件`, 'pending/all') : null;
    return section('需要你看一眼', aside, rows.length ? list(rows)
      : h('p', { class: 'home-quiet' }, '没有要你管的事。有人想改她的设定、她想在公开的地方说话之类的，会先出现在这里。'));
  }

  function recentSection(d) {
    if (d.error) return section('她最近记住的', null, R.errorBox({ code: d.error }, null, { title: '记忆读不出来' }));
    const rs = d.recent ?? [];
    return section('她最近记住的', rs.length ? link('去记忆', 'memory/list') : null, rs.length
      ? list(rs.map((m) => row({ title: m.text, meta: recentMeta(d, m), onOpen: () => R.go('memory/list', { params: { open: m.ref } }) })))
      : h('p', { class: 'home-quiet' }, '还没有。她会把听到的整理成一件件事，过一会儿再来看。'));
  }

  function freshSection() {
    // 全新安装：告诉人下一步做什么（样稿 state=empty）
    return section('接下来', null, h('div', { class: 'home-next' },
      h('div', null, icon('monitor', 18), h('div', null, h('b', null, '在 DSH 里和她说几句'), h('span', null, '新建任务时选「人设聊天」，那个对话里说的话她会记下。'))),
      h('div', null, icon('qq', 18), h('div', null, h('b', null, '接上 QQ（可以不接）'), h('span', null, '接上以后，她在的群和私聊里大家说的话都会被记下。'), h('div', { style: { marginTop: '6px' } }, link('去接入', 'settings/connect')))),
      h('div', null, icon('book', 18), h('div', null, h('b', null, '过一会儿回来看看'), h('span', null, '她记住的事会出现在这里和「记忆」里。')))));
  }

  function side(d) {
    const entries = d.entries ?? [];
    const health = d.health ?? [];
    const sp = d.spend;
    const toneOf = { ok: 'ok', warn: 'warn', bad: 'bad', dim: 'dim' };
    return h('div', { class: 'home-side' },
      section('入口', null, entries.length ? h('div', null, entries.map((e) => {
        const t = entryText(d, e);
        return miniRow({ ic: ENTRY_ICON[e.adapter] ?? 'plug', name: e.name, sub: t.sub, right: t.right, to: t.to });
      })) : h('p', { class: 'home-quiet' }, d.error ? '读不出来。' : '还没有入口。')),
      section('状态', null, h('div', null, health.map((x) => miniRow({ name: x.label, right: x.state === 'plain' ? x.text : status(x.text, toneOf[x.state] ?? 'dim'), to: x.to })))),
      sp ? section('今天的花费', null, h('div', { class: 'home-spend' },
        h('b', null, sp.priceKnown ? fmt.yuan(sp.yuan ?? 0) : '只记用量'),
        [sp.presetLabel, !sp.priceKnown ? `今天调用 ${sp.calls ?? 0} 次` : null,
          sp.paused ? '后台整理先停了' : typeof sp.daysLeft === 'number' ? `余额还够约 ${Math.max(0, Math.floor(sp.daysLeft))} 天` : null,
          sp.priceKnown && !sp.calls ? '还没调用过后台模型' : null].filter(Boolean).join(' · '),
        h('div', { class: 'go' }, link('看花费', 'settings/cost')))) : null);
  }

  async function render(el) {
    const wrap = h('div', { class: 'wrap' }, R.loading('正在看她怎么样…'));
    R.clear(el, wrap);
    let d;
    try { d = await R.api.get('home'); } catch (e) {
      R.clear(wrap, R.errorBox(e, () => render(el), { title: '首页读不出来' }));
      return;
    }
    if (d.pending) R.setPendingCount(d.pending.total);
    const left = h('div', null, pendingSection(d), d.fresh ? freshSection() : recentSection(d));
    R.clear(wrap, hero(d), h('div', { class: 'home-grid' }, left, side(d)));
  }

  return { render };
});
