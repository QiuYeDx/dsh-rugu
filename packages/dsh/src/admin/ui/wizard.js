// 首次设置（D173，辛5、乙1–乙4、乙6）：一步一屏、上面一排进度点、上一步 / 下一步。
//   1 知情（勾「我知道了」才能往下）→ 2 她是谁 → 3 模型（后台模型自动选建议的那一对并试一下；想起来的方式，没有 Ollama 时默认「先不用」）
//   → 4 接 QQ（可选，和「设置 · 接入」同一套组件）→ 「完成设置」（setup.finish）→ 5 完成（下一步做什么）。
// 中途关掉不丢：每一步的填写存成草稿（setup.draft → 宿主配置 host.setup.draft；写它时宿主标成「向导写了一半」，不会被当成设置完了），
// 重新打开回到上次那一步。共用的三块（后台模型、想起来的方式、QQ 桥接）来自 settings.js 的 Rugu.settingsParts。
Rugu.define('wizard', (R) => {
  const { h, icon, btn, note, more } = R;
  const STEPS = ['知情', '她是谁', '模型', '接 QQ', '完成'];
  const P = typeof Rugu.settingsParts === 'function' ? Rugu.settingsParts(R) : null;

  let draft = {};
  let saveT = 0;
  let info = null;
  let stops = [];
  let pollT = 0;
  const leave = () => { clearTimeout(saveT); clearTimeout(pollT); for (const s of stops) { try { s(); } catch { /* 尽力 */ } } stops = []; };

  /** 草稿存到宿主（设置模式之外存不了，也不需要）。debounce：打字时最多半秒一次。 */
  function saveDraft(now = false) {
    clearTimeout(saveT);
    const run = () => (info?.needed ? R.api.act('setup.draft', { draft }).catch(() => {}) : Promise.resolve());
    if (now) return run();
    saveT = setTimeout(run, 600);
    return Promise.resolve();
  }
  const set = (k, v) => { draft[k] = v; saveDraft(); };

  async function render(el, route) {
    leave();
    const step = Math.min(5, Math.max(1, Number(route.sub) || 1));
    const wrap = h('div', { class: 'wiz' }, R.loading());
    R.clear(el, wrap);
    try { info = await R.api.get('wizard'); } catch (e) {
      // 设置刚走完、管理页换成完整的那一刻，旧令牌会被拒：重新打开页面就好
      if (e.code === 'FORBIDDEN' || e.status === 403) { reloadInto(5); return; }
      R.clear(wrap, R.errorBox(e, () => render(el, R.route()), { title: '首次设置读不出来' }));
      return;
    }
    if (R.route() !== route) return;
    draft = { ...(info.draft ?? {}) };
    if (!info.needed) {
      if (info.starting || step === 5) { R.clear(wrap, ...done(info.starting)); if (info.starting) poll(); return; }
      R.clear(wrap, R.empty({ ic: 'checkc', title: '已经设置过了', text: '她是谁、模型、接入这些，都能在「设置」里改。', actions: [btn('去设置', { kind: 'primary', onclick: () => R.go('settings/basic') }), btn('回首页', { onclick: () => R.go('home') })] }));
      return;
    }
    // 回到上次那一步（没勾「我知道了」的只能在第 1 步）
    const want = draft.ack ? Math.min(4, Math.max(1, Number(draft.step) || 1)) : 1;
    if (route.params?.resume !== '0' && step === 1 && want > 1 && !route.params?.at) { R.go(`wizard/${want}`, { replace: true, focus: false }); return; }
    if (step > 1 && !draft.ack) { R.go('wizard/1', { replace: true }); return; }
    if (draft.step !== step && step <= 4) { draft.step = step; saveDraft(true); }
    R.clear(wrap, ...screen(step));
    wrap.querySelector('[data-page-title]')?.focus({ preventScroll: true });
  }
  function reloadInto(step) {
    const u = new URL(location.href);
    u.searchParams.set('ui', 'next');
    u.hash = `#/wizard/${step}`;
    location.replace(u.toString());
  }
  /** 设置走完、核心还在打开：每 1.5 秒看一眼，好了就重新打开页面（管理页换成完整的，令牌也换了）。 */
  function poll() {
    pollT = setTimeout(async () => {
      try { const s = await R.api.get('wizard'); if (s.starting) { poll(); return; } } catch { /* 被拒 = 已经换成完整的了 */ }
      reloadInto(5);
    }, 1500);
  }

  const dots = (step) => h('div', { class: 'wiz-dots', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': '5', 'aria-valuenow': String(step), 'aria-label': '首次设置的进度' },
    STEPS.map((_, i) => h('i', { class: i + 1 < step ? 'done' : i + 1 === step ? 'cur' : '', 'aria-hidden': 'true' })), h('span', null, `第 ${step} 步，共 5 步 · ${STEPS[step - 1]}`));
  const head = (step, title, lede) => [dots(step), h('h1', { tabindex: '-1', 'data-page-title': '' }, title), lede ? h('p', { class: 'wiz-lede' }, lede) : null];
  const fact = (ic, title, text, extra) => h('div', { class: 'wiz-fact' }, icon(ic, 18), h('div', null, h('b', null, title), h('span', null, text), extra ?? null));
  const foot = (...kids) => h('div', { class: 'wiz-foot' }, ...kids);
  const go = (n) => R.go(`wizard/${n}`, { params: { at: '1' } });

  function screen(step) {
    if (step === 1) return stepKnow();
    if (step === 2) return stepWho();
    if (step === 3) return stepModels();
    if (step === 4) return stepQQ();
    return done(false);
  }

  // ── 1 知情 ─────────────────────────────────────────────────────────────
  function stepKnow() {
    const next = btn('下一步', { kind: 'primary', disabled: !draft.ack, onclick: async () => { draft.step = 2; await saveDraft(true); go(2); } });
    const ck = h('input', { type: 'checkbox', checked: !!draft.ack });
    ck.addEventListener('change', () => { draft.ack = ck.checked; next.disabled = !ck.checked; saveDraft(); });
    return [...head(1, '开始之前，先说清楚几件事', '几分钟的事。后面每一步都能用默认，之后也都能在「设置」里改。'),
      h('div', { class: 'wiz-body wiz-facts' },
        fact('chat', '聊天会被记下来', '接上 QQ 以后，她在的群和私聊里每个人说的话都会被记下、整理成她的记忆；DSH 桌面里只有「人设聊天」的对话才算。群友不知道的，请你告诉他们。'),
        fact('download', '桥接里已有的最近消息也会被导入', '接上 QQ 时，桥接里已经存着的最近一段聊天会一起记进来，不只是从现在起的。'),
        fact('clock', `原话默认留 ${info.retention === '2y' ? '2 年' : info.retention}`, '到期只删原话和原文片段，她记得的事一直留着。之后能在「设置 · 基本」里改。'),
        fact('cpu', '后台会把聊天片段发给模型的服务商', '为了把聊天整理成记忆，后台会把一段段聊天（包括群友说的话）发给你下一步选的后台模型的服务商；花的是那个服务商的余额，有上限。'),
        fact('warn', 'QQ 这条路有封号风险', '走的是第三方的桥接：请用小号，不要用主号。'),
        fact('archive', '记忆存在你自己的电脑上', '卸载插件也不会删。', info.dataDir ? h('span', { class: 'mono wiz-path' }, info.dataDir) : null),
        h('label', { class: 'cbox wiz-ack' }, ck, h('span', null, '我知道了'))),
      foot(h('span', { class: 'sp' }), next)];
  }

  // ── 2 她是谁 ───────────────────────────────────────────────────────────
  function stepWho() {
    const field = (k, label, opts = {}) => {
      const el = opts.area ? h('textarea', { class: 'textarea', id: `wiz-${k}`, rows: 4, maxlength: '2000', placeholder: opts.ph ?? '' }) : h('input', { class: 'input', id: `wiz-${k}`, placeholder: opts.ph ?? '', maxlength: opts.max ? String(opts.max) : null });
      el.value = k === 'selfNames' ? (Array.isArray(draft.selfNames) ? draft.selfNames.join('、') : draft.selfNames ?? '') : draft[k] ?? '';
      el.addEventListener('input', () => set(k, k === 'selfNames' ? el.value.split(/[,，、;；\s]+/).filter(Boolean) : el.value));
      return h('div', { class: 'field' }, h('label', { for: `wiz-${k}` }, label), el, opts.hint ? h('div', { class: 'fhint' }, opts.hint) : null);
    };
    return [...head(2, '她是谁', '都可以先不填，之后在「设置 · 基本」里改。'),
      h('div', { class: 'wiz-body' },
        field('principalLabel', '她怎么称呼你', { ph: '默认「主人」', max: 20 }),
        field('selfNames', '她的名字和昵称', { ph: '可以不填', hint: '在 QQ 里有人叫这些名字时，她知道是在叫她。多个用逗号或顿号隔开。' }),
        field('personaPrefix', '人设开头', { area: true, ph: '比如：我是她，是你的朋友。平时话不多，喜欢听大家聊天。空着就用 DSH 标准模式自带的开头。',
          hint: 'DSH 桌面里「人设聊天」这个预设的开场设定：她对自己的认识，一两段就够。QQ 那边的人设写在桥接自己的预设里，两边要保持一致。' }),
        h('div', { class: 'wiz-more' }, more('更多', field('presetName', 'DSH 新建任务里显示的名字', { ph: '默认「人设聊天」', max: 40, hint: '在 DSH「新建任务」里选这个预设开的对话，才算在和她聊。' })))),
      foot(btn('上一步', { kind: 'ghost', onclick: () => go(1) }), h('span', { class: 'sp' }), btn('下一步', { kind: 'primary', onclick: async () => { draft.step = 3; await saveDraft(true); go(3); } }))];
  }

  // ── 3 模型 ─────────────────────────────────────────────────────────────
  function stepModels() {
    if (!P) return [...head(3, '模型'), note('bad', '这一块没打开（设置的脚本没有加载）。可以先跳过，之后在「设置」里配。'), foot(btn('上一步', { kind: 'ghost', onclick: () => go(2) }), h('span', { class: 'sp' }), btn('下一步', { kind: 'primary', onclick: () => go(4) }))];
    let embed = null;
    const llmBox = h('div');
    const skipBox = h('div', { class: 'wiz-skip' });
    let llmOff = draft.llmSkipped === true;
    const drawLlm = () => {
      R.clear(llmBox, llmOff ? note('info', '先不用后台模型：她照常记下原话、能按原话、人、时间找回来，但不会自己整理出事实和经历。之后在「设置 · 模型」里随时能打开，没整理的会补上。',
        btn('还是用吧', { size: 'sm', kind: 'ghost', onclick: async () => { llmOff = false; set('llmSkipped', false); drawLlm(); } }))
        : P.llmBlock({ wizard: true, autoTest: true, onChange: (x) => { if (x?.list?.current?.target === 'off') { llmOff = true; drawLlm(); } } }));
      R.clear(skipBox, llmOff ? null : btn('先不用后台模型', { size: 'sm', kind: 'ghost', onclick: async () => {
        try { await R.api.act('llm.save', { target: 'off' }); llmOff = true; set('llmSkipped', true); drawLlm(); } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); }
      } }));
    };
    drawLlm();
    embed = P.embedBlock({ wizard: true, initial: draft.embed ?? null, onPick: (m) => { if (draft.embed !== m) set('embed', m); } });
    stops.push(() => embed.stop());
    const next = btn('下一步', { kind: 'primary', onclick: async () => {
      next.disabled = true;
      const choice = embed.choice?.();
      const d = embed.data?.();
      try {
        // 选了「先不用」：现在配的还是本机 Ollama 的话换成「不用」（向导里一条向量都还没有，不用重算、不用确认）
        if (choice === 'none' && d && d.mode !== 'none') await R.api.act('embedding.save', { mode: 'none' });
        if (choice === 'ollama' && d && d.mode !== 'ollama' && d.ollama?.reachable) await R.api.act('embedding.save', { mode: 'ollama', tier: d.recommended?.tier ?? 'standard', url: d.ollama.url });
      } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); next.disabled = false; return; }
      if (choice === 'external' && d?.mode !== 'external') { R.toast('外部服务还没保存：填好以后点「用这个」，或者先选「先不用」', { tone: 'bad' }); next.disabled = false; return; }
      draft.step = 4; await saveDraft(true); go(4);
    } });
    return [...head(3, '模型', '后台整理用 DSH 里的模型；想起来的方式选一个。之后都能在「设置 · 模型」里换。'),
      h('div', { class: 'wiz-body' },
        h('div', { class: 'wiz-sub' }, h('h3', null, '后台模型'), h('p', { class: 'fhint' }, '把聊天整理成记忆用的模型。已经填好了建议的那一对，并且自动试了一下。'), llmBox, skipBox),
        h('div', { class: 'wiz-sub' }, h('h3', null, '想起来的方式'), h('p', { class: 'fhint' }, '给每条记忆算一个「意思」，换个说法也想得起来。三种都能用。'), embed)),
      foot(btn('上一步', { kind: 'ghost', onclick: () => go(2) }), h('span', { class: 'sp' }), next)];
  }

  // ── 4 接 QQ ────────────────────────────────────────────────────────────
  function stepQQ() {
    const box = h('div', { class: 'wiz-body' }, R.loading('正在找桥接…'));
    const off = new Set(Array.isArray(draft.offGroups) ? draft.offGroups : []);
    const acct = h('input', { class: 'input', id: 'wiz-acct', inputmode: 'numeric', placeholder: '可以不填：能自动认出来的话就不用填', value: draft.selfAccount ?? '' });
    acct.addEventListener('input', () => set('selfAccount', acct.value.trim()));
    async function load() {
      let b;
      try { b = await R.api.get('bridge'); } catch (e) { R.clear(box, R.errorBox(e, load)); return; }
      const rows = P ? P.bridgeBlock({ bridge: b, wizard: true, reload: load, offGroups: off, onGroups: () => set('offGroups', [...off]) }) : [note('bad', '这一块没打开。可以先跳过，之后在「设置 · 接入」里接。')];
      R.clear(box,
        h('p', { class: 'fhint wiz-intro' }, 'dsh-qq 是让她进 QQ 的桥接程序（第三方的开源项目）。', info.links?.bridge ? h('a', { class: 'link', href: info.links.bridge, target: '_blank', rel: 'noopener noreferrer' }, '去了解 dsh-qq', icon('link', 14)) : null),
        rows,
        b?.current?.isBridge ? h('div', { class: 'field wiz-sub' }, h('label', { for: 'wiz-acct' }, '她自己的 QQ 号'), acct, h('div', { class: 'fhint' }, '用来认出群里哪一个是她。大多数情况能自动认出来，认不出来（有的协议端不行）再填。')) : null,
        b?.current?.isBridge && !b.current.whitelist?.patched ? note('info', '要让她在 QQ 里也能用记忆，还得给桥接打个小补丁：上面「看看要改什么…」，或者走完以后在「设置 · 接入」里打。') : null,
        note('warn', '第三方的桥接有封号风险，请用小号，不要用主号。'));
    }
    load();
    const finish = async (skip) => {
      for (const b of [skipBtn, doneBtn]) b.disabled = true;
      await saveDraft(true);
      const names = Array.isArray(draft.selfNames) ? draft.selfNames.filter(Boolean) : [];
      try {
        await R.api.act('setup.finish', { ack: true, ...(draft.principalLabel ? { principalLabel: draft.principalLabel } : {}), ...(draft.presetName ? { presetName: draft.presetName } : {}),
          ...(names.length ? { selfNames: names } : {}), ...(!skip && off.size ? { offGroups: [...off] } : {}) });
        R.go('wizard/5');
      } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); for (const b of [skipBtn, doneBtn]) b.disabled = false; }
    };
    const skipBtn = btn('跳过，以后再接', { kind: 'ghost', onclick: () => finish(true) });
    const doneBtn = btn('完成设置', { kind: 'primary', onclick: () => finish(false) });
    return [...head(4, '接 QQ', '可选。不接也能用，只是没有 QQ 这个入口。'), box,
      h('p', { class: 'fhint wiz-finishnote' }, '点「完成设置」以后建库、开始记。'),
      foot(btn('上一步', { kind: 'ghost', onclick: () => go(3) }), h('span', { class: 'sp' }), skipBtn, doneBtn)];
  }

  // ── 5 完成 ─────────────────────────────────────────────────────────────
  function done(starting) {
    return [...head(5, starting ? '正在建库…' : '好了，她开始记了', starting ? '第一次打开要建库，几秒钟。好了以后这一页会自己刷新。' : '库已经建好。接下来可以：'),
      h('div', { class: 'wiz-body wiz-facts' },
        fact('monitor', '在 DSH 里和她说几句', '新建任务时选「人设聊天」，那个对话里说的话她会记下、也会想起来。'),
        fact('qq', '或者去 QQ 里跟她说句话', '接了 QQ 的话：群里、私聊里大家说的话都会被记下。'),
        fact('book', '过一会儿回来看看', '她记住的事会出现在「首页」和「记忆」里；她在哪儿记、记不记，在「场合」里看。'),
        fact('inbox', '留意「待处理」', '有人想改她的设定、她想在公开的地方说话时，会先问你。')),
      foot(h('span', { class: 'sp' }), starting ? h('span', { class: 'wiz-wait' }, h('span', { class: 'spin' }), '正在打开记忆库…') : btn('开始用', { kind: 'primary', onclick: () => R.go('home') }))];
  }

  return { render, leave };
});
