// 设置（D173）：基本、模型、接入、花费、备份、诊断、关于。左侧小导航（窄屏变成上面一排），每个小节一个视图（settings-views.js），
// 次要的折叠进「更多」「技术细节」。写操作走 actions.js / settings-actions.js 的动作，要确认的走 R.api.confirmed。
// 文案照设计说明第 4 节：平实的中文，界面上不出现内部说法；配置键名、文件路径只出现在「技术细节」或「关于 · 数据在哪儿」里。
// 后台模型、想起来的方式、QQ 桥接这三块首次设置向导（wizard.js）也要用：放在 Rugu.settingsParts 里（同一套组件，两边各自摆）。
// 规矩同 ui/README.md：节点一律用 DOM API 建、文字走文本节点；不加载外部资源（外部链接只在「关于」里，地址由服务端给）。

/**
 * 设置和首次设置共用的三块（后台模型、想起来的方式、QQ 桥接）。在设置或向导第一次打开时由它们自己调（不在加载时碰 DOM）。
 * @param {any} R  window.Rugu
 */
Rugu.settingsParts = function settingsParts(R) {
  const { h, icon, btn, note, frow, sw, more, tag, status, fmt } = R;

  // ── 说法 ───────────────────────────────────────────────────────────────
  /** 服务商的叫法：DeepSeek 的两条通道说清楚走的是什么；别的用 DSH 给的名字。 */
  const PROVIDER_NAME = { 'deepseek-account': 'DeepSeek（走 DSH 账号）', 'deepseek-official': 'DeepSeek（API Key）' };
  const providerName = (id, list) => PROVIDER_NAME[id] ?? list?.providers?.find((p) => p.id === id)?.name ?? id;
  const pairText = (p, list) => (p ? `${providerName(p.provider, list)} · ${p.model}` : '还没选');
  /** 「试一下」的结论：服务端的话里内部叫法换成界面上的说法。 */
  const verdictText = (v) => String(v ?? '').replaceAll('第一眼', '听到时的判断').replaceAll('提炼', '整理');
  const sec = (ms) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const EMBED_ERR = { HTTP_401: 'API Key 不对（401）', HTTP_403: '没有权限（403）', HTTP_404: '地址不对，或者服务没有这个模型（404）', HTTP_429: '被限流了（429）', EMBED_DIM: '返回的维度和填的不一样',
    EMBED_SHAPE: '返回的格式不对', BAD_URL: '地址不对', TimeoutError: '等太久没有响应', TypeError: '连不上这个地址', ECONNREFUSED: '连不上这个地址', ENOTFOUND: '找不到这个地址',
    STALLED: '下载卡住了，点一下再试', PULL_FAILED: '下载失败', PULL_INCOMPLETE: '下载没完成，点一下再试' };
  const embedErr = (c) => (c ? EMBED_ERR[c] ?? (/^HTTP_5/.test(c) ? `服务出错（${c.slice(5)}）` : `连不上（${c}）`) : '');
  const toastWarn = (r) => { const w = (r?.warnings ?? []).filter(Boolean); if (w.length) R.toast(w.join('；'), { tone: 'bad' }); };

  // ════════════════════════════════════════════════════════════════════
  // 后台模型（D168：llm.list / llm.test / llm.save；status 来自 llmSetup 视图或各页自己的视图）
  // ════════════════════════════════════════════════════════════════════
  /**
   * @param {{status: any, canWrite?: boolean, wizard?: boolean, autoTest?: boolean, onChange?: Function}} o
   * @returns {HTMLElement}
   */
  function llmBlock(o) {
    const box = h('div', { class: 'set-llm' });
    let list = null;
    let st = o.status ?? null;
    let test = null;
    let testing = false;
    let picking = false;
    let pick = null;
    const ro = o.canWrite === false;
    const current = () => list?.current?.target ?? null;
    const chosen = () => (current() && current() !== 'off' ? current() : null);
    const off = () => current() === 'off' || st?.state === 'off';
    const shownPair = () => chosen() ?? st?.pair ?? list?.current?.effective ?? list?.suggest ?? null;

    async function loadList() {
      try { list = await R.api.act('llm.list'); } catch (e) { list = { error: e }; }
      if (!pick) { const p = chosen() ?? list?.suggest ?? null; pick = p ? { provider: p.provider, model: p.model } : null; }
    }
    async function refreshStatus() {
      try { const r = await R.api.get('llmSetup'); if (r?.status && !r.status.error) st = r.status; } catch { /* 留着原来的 */ }
    }
    async function runTest(pair) {
      testing = true; draw();
      try { test = await R.api.act('llm.test', pair ? { provider: pair.provider, model: pair.model } : {}); } catch (e) { test = { level: 'bad', verdict: R.errorText(e) }; }
      testing = false;
      await refreshStatus();
      draw();
      o.onChange?.({ test, list, status: st });
    }
    async function save(body, { andTest = false } = {}) {
      try {
        const r = await R.api.act('llm.save', body);
        toastWarn(r);
        await loadList(); await refreshStatus();
        R.toast('已保存，马上生效');
        o.onChange?.({ list, status: st, saved: body });
        if (andTest) await runTest(null); else draw();
      } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); draw(); }
    }

    function stateLine() {
      if (!st) return list?.error ? R.errorText(list.error, 'read') : '正在看状态…';
      if (off()) return '没用后台模型：原话照记，能按原话、人、时间找回来；不会自己整理出事实和经历。';
      if (st.state === 'down' && st.fallback) return `不工作${st.since ? `（${fmt.when(st.since)} 起）` : ''}：${st.reason ?? '配置有问题'}。现在临时用你聊天的模型（${pairText(st.fallback, list)}）顶着，可能更贵；修好以后自动换回。`;
      if (st.state === 'down') return `不工作${st.since ? `（${fmt.when(st.since)} 起）` : ''}：${st.reason ?? '配置有问题'}。这段时间她记不住新的事、回想变少，聊天照常。`;
      if (st.state === 'flaky') return '最近不稳定：一半的调用没成，会自己重试；一直这样就换一个。';
      const last = (st.pairs ?? []).map((r) => r.lastOkAt).filter(Boolean).sort((a, b) => b - a)[0];
      const catchUp = st.catchUp > 0 ? `正在补之前没整理的 ${st.catchUp} 段（受花费上限管）。` : '';
      if (st.state === 'unknown' || !last) return `${catchUp}还没用过，可以点「试一下」。`;
      return `上一次成功在 ${fmt.when(last)}。${catchUp}花的是 DSH 里这个服务商的余额。`;
    }
    function testNote() {
      if (testing) return h('div', { class: 'set-test' }, h('span', { class: 'spin' }), '正在试：真的调两次很小的请求，十几秒…');
      if (!test) return null;
      const s = test.steps ?? {};
      const step = (name, x) => (x ? (x.ok ? `${name} ${sec(x.ms)}${x.bad ? `，有 ${x.bad} 行读不懂` : ''}` : `${name}没通`) : null);
      const tone = test.level === 'ok' ? 'info' : test.level === 'warn' ? 'warn' : 'bad';
      const sp = shownPair();
      const other = test.pair && !(sp && sp.provider === test.pair.provider && sp.model === test.pair.model);
      const sub = [other ? `试的是 ${pairText(test.pair, list)}` : null, s.glance?.bad || s.extract?.bad || (s.glance && !s.glance.ok) ? [step('听到时的判断', s.glance), step('整理', s.extract)].filter(Boolean).join(' · ') : null].filter(Boolean).join(' · ');
      return note(tone, [h('b', { class: 'set-b' }, verdictText(test.verdict)), sub ? h('div', { class: 'fhint' }, sub) : null]);
    }
    function picker() {
      const ps = Array.isArray(list?.providers) ? list.providers : [];
      const prov = ps.find((p) => p.id === pick?.provider) ?? null;
      const provSel = h('select', { class: 'input set-select', 'aria-label': '服务商', disabled: ro || !ps.length },
        h('option', { value: '' }, ps.length ? '选一个服务商' : 'DSH 里还没有服务商'),
        ps.map((p) => h('option', { value: p.id, selected: p.id === pick?.provider }, providerName(p.id, list))));
      provSel.addEventListener('change', () => {
        const p = ps.find((x) => x.id === provSel.value);
        const sug = list?.suggest;
        pick = p ? { provider: p.id, model: sug?.provider === p.id ? sug.model : p.models.length === 1 ? p.models[0].id : '' } : null;
        test = null; draw();
      });
      let modelCtl;
      if (prov && prov.models.length) {
        modelCtl = h('select', { class: 'input set-select', 'aria-label': '模型', disabled: ro },
          h('option', { value: '' }, '选一个模型'), prov.models.map((m) => h('option', { value: m.id, selected: m.id === pick?.model }, m.name === m.id ? m.id : `${m.name}（${m.id}）`)));
        modelCtl.addEventListener('change', () => { pick = { ...pick, model: modelCtl.value }; test = null; draw(); });
      } else {
        modelCtl = h('input', { class: 'input', 'aria-label': '模型名', placeholder: '模型名，例如 deepseek-flash', value: pick?.model ?? '', disabled: ro || !prov, spellcheck: 'false' });
        modelCtl.addEventListener('change', () => { pick = { ...pick, model: modelCtl.value.trim() }; test = null; });
      }
      const ready = !!(pick?.provider && pick?.model);
      const same = chosen() && ready && chosen().provider === pick.provider && chosen().model === pick.model;
      return h('div', { class: 'set-pick' },
        h('div', { class: 'set-pick-row' }, provSel, modelCtl),
        prov?.error ? h('div', { class: 'fhint' }, '读不到这个服务商的模型目录，可以手填模型名。') : null,
        list?.suggest && (!pick || pick.provider !== list.suggest.provider || pick.model !== list.suggest.model)
          ? h('div', { class: 'fhint' }, `建议：${pairText(list.suggest, list)}${list.suggest.why === 'chat' ? '（这是你聊天用的模型，可能偏贵偏慢；同一个服务商下可以换个小一点的）' : '（又快又便宜）'}`) : null,
        h('div', { class: 'set-acts' },
          btn('试一下', { size: 'sm', disabled: !ready || testing, onclick: () => runTest(pick) }),
          btn(same ? '在用' : '用这个', { size: 'sm', kind: 'primary', disabled: ro || !ready || same || testing, onclick: () => save({ target: { ...pick } }, { andTest: true }) }),
          btn('收起', { size: 'sm', kind: 'ghost', onclick: () => { picking = false; draw(); } })),
        h('div', { class: 'fhint' }, '「试一下」会真的调两次很小的请求（内容是编的），用 DeepSeek 的 flash 一次不到 1 分钱，算进后台花费。'));
    }
    function draw() {
      const p = shownPair();
      const think = (st?.pairs ?? []).some((r) => r.thinkHeavy);
      const titleText = off() ? '不用后台模型' : p ? pairText(p, list) : '还没选';
      const stTone = !st ? 'dim' : st.state === 'down' && !st.fallback ? 'bad' : st.state === 'down' || st.state === 'flaky' ? 'warn' : st.state === 'ok' ? 'ok' : 'dim';
      const stWord = !st ? null : off() ? null : { ok: '正常', warn: st.state === 'flaky' ? '不稳定' : '在顶着', bad: '不工作', dim: '还没用过' }[stTone];
      R.clear(box,
        h('div', { class: 'form' },
          frow({ title: titleText, hint: stateLine(),
            control: [off() || !stWord ? null : status(stWord, stTone),
              off() ? null : btn(test ? '再试一下' : '试一下', { size: 'sm', disabled: testing || (!chosen() && !p), onclick: () => runTest(o.wizard ? pick : null) }),
              picking ? null : btn(off() ? '选一个…' : '换一个…', { size: 'sm', disabled: ro || !list || !!list.error, onclick: () => { picking = true; draw(); } })] })),
        think && !off() ? note('info', '这个模型关不掉思考，会慢一些、贵一些（插件已经给它的输出多留了余量）；在意的话可以换个不带思考的小模型。') : null,
        testNote(),
        picking ? picker() : null,
        o.wizard ? null : h('div', { class: 'form set-gap' },
          frow({ title: '不工作时用聊天的模型顶上', hint: '选的这一对配错了（不认识的模型、没登录、Key 失效）时，临时用你在 DSH 里聊天的那一对，整理不停；可能更贵，修好以后自动换回。暂时连不上不顶。', right: true, cls: 'sw',
            control: sw(list?.current?.fallbackToChat !== false && st?.fallbackToChat !== false, (v) => R.api.act('llm.save', { fallbackToChat: v }).then((r) => { toastWarn(r); R.toast(v ? '已打开，马上生效' : '已关掉，马上生效'); }), '不工作时用聊天的模型顶上', { disabled: ro }) }),
          frow({ title: off() ? '重新用后台模型' : '不用后台模型', right: true,
            hint: off() ? '重新打开以后，没整理的原话会自动补上整理（受花费上限管）。' : '一次都不调、不花钱。她照常记下原话，能按原话、人、时间找回来；但不会自己整理出事实和经历，听到时的判断和说话前的细看也不做。',
            control: off() ? btn('用建议的', { size: 'sm', disabled: ro || !list?.suggest, onclick: () => save({ target: { provider: list.suggest.provider, model: list.suggest.model } }, { andTest: true }) })
              : btn('不用', { size: 'sm', disabled: ro, onclick: async () => { if (await R.confirmSimple({ title: '不用后台模型', text: '她照常记原话、能找回来，但不会自己整理出事实和经历，回想会变少。之后随时能再打开，没整理的会补上。', okText: '不用', danger: true })) save({ target: 'off' }); } }) })));
      if (!o.wizard && list && !list.error) box.append(advanced());
    }
    function advanced() {
      const row = (u, name, why) => {
        const cur = list.current?.perUse?.[u] ?? null;
        return frow({ title: `${name}单独用一对`, hint: cur ? `现在单独用 ${pairText(cur, list)}` : `跟着上面的（${why}）`, right: true,
          control: cur ? btn('跟着上面的', { size: 'sm', disabled: ro, onclick: () => save({ perUse: { [u]: null } }) })
            : btn('用上面选的', { size: 'sm', disabled: ro || !(pick?.provider && pick?.model), title: '先在「换一个…」里选好一对', onclick: () => save({ perUse: { [u]: { ...pick } } }) }) });
      };
      return h('div', { class: 'set-gap' }, more('高级', h('div', { class: 'form' },
        row('glance', '听到时的快速判断', '要快'), row('extract', '整理成记忆', '要好'),
        o.onFailureRow ? o.onFailureRow() : null)));
    }
    draw();
    loadList().then(async () => {
      if (!st) await refreshStatus();
      draw();
      o.onChange?.({ list, status: st });
      if (o.autoTest && !off() && pick?.provider && pick?.model && !ro) runTest(pick);
    });
    return box;
  }

  // ════════════════════════════════════════════════════════════════════
  // 想起来的方式（D127：embeddingSetup 视图；embedding.pull / pullCancel / test / save）
  // ════════════════════════════════════════════════════════════════════
  /**
   * @param {{canWrite?: boolean, wizard?: boolean, initial?: string|null, onPick?: (mode: string, d: any) => void}} o
   *   wizard：向导里（检测不到 Ollama 时默认选「先不用」，乙2）；initial：草稿里记的选择
   */
  function embedBlock(o) {
    const box = h('div', { class: 'set-embed' }, R.loading('正在看这台电脑上有没有 Ollama…'));
    let d = null;
    let sel = null;
    let pollT = 0;
    let test = null;
    const ro = o.canWrite === false;
    const form = { url: '', model: '', dim: '', apiKey: '', clearKey: false };
    async function load() {
      try { d = await R.api.get('embeddingSetup'); } catch (e) { R.clear(box, R.errorBox(e, load, { title: '想起来的方式读不出来' })); return; }
      if (d?.error) { R.clear(box, R.errorBox({ code: d.error }, load, { title: '想起来的方式读不出来' })); return; }
      if (sel == null) sel = defaultChoice(d, o);
      if (d.external) Object.assign(form, { url: form.url || d.external.url || '', model: form.model || d.external.model || '', dim: form.dim || (d.external.dim ? String(d.external.dim) : '') });
      draw();
      o.onPick?.(sel, d);
      clearTimeout(pollT);
      if (d.pull?.state === 'running') pollT = setTimeout(load, 1000);
    }
    async function save(params) {
      try {
        const r = await R.api.confirmed('embedding.save', params, { title: '换想起来的方式', okText: '换', danger: false,
          render: (pv) => (pv?.reasons?.length ? h('div', null, pv.reasons.map((x) => h('p', null, x))) : h('p', null, '马上生效。')) });
        if (r) { R.toast('已保存，马上生效'); form.apiKey = ''; form.clearKey = false; test = null; load(); }
      } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); }
    }
    const OPTS = [
      ['none', o.wizard ? '先不用' : '不用', '什么都不用装，马上能用。换个说法问同一件事时，可能想不起来。'],
      ['ollama', '本机 Ollama', null],
      ['external', '外部服务', '填一个 OpenAI 兼容的地址和模型；记忆的文字会发给那个服务。'],
    ];
    function ollamaDesc() {
      if (!d.ollama?.reachable) return '这台电脑上没找到 Ollama。装好并打开以后点「重新检测」。在你自己的电脑上算，不花钱。';
      const rec = d.tiers?.[d.recommended?.tier];
      return `已找到 Ollama ${d.ollama.version ?? ''}。${d.recommended?.reason ?? ''}${rec && !rec.present ? `，要先下载（${rec.size}）` : ''}。在你自己的电脑上算，不花钱，记忆不出这台电脑。`;
    }
    function tierRows() {
      if (!d.ollama?.reachable) {
        return h('div', { class: 'set-acts' }, d.downloadUrl ? h('a', { class: 'btn btn-secondary btn-sm', href: d.downloadUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 16), '去下载 Ollama') : null,
          btn('重新检测', { size: 'sm', ic: 'refresh', onclick: () => { R.clear(box, R.loading('正在检测…')); load(); } }));
      }
      const p = d.pull ?? {};
      const row = (t, name) => {
        const x = d.tiers?.[t] ?? {};
        const inUse = d.mode === 'ollama' && d.tier === t && x.present;
        const running = p.state === 'running' && p.tier === t;
        const ctl = inUse ? status('在用', 'ok')
          : running ? btn('取消', { size: 'sm', kind: 'ghost', onclick: async () => { await R.api.act('embedding.pullCancel').catch(() => {}); load(); } })
            : x.present ? btn('用这个', { size: 'sm', kind: 'primary', disabled: ro, onclick: () => save({ mode: 'ollama', tier: t, url: d.ollama.url }) })
              : btn('下载', { size: 'sm', ic: 'download', disabled: ro || p.state === 'running', onclick: async () => { try { await R.api.act('embedding.pull', { tier: t, url: d.ollama.url }); load(); } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); } } });
        const hint = running ? `正在下载 ${p.pct ?? 0}%（${p.status ?? ''}）` : `${x.size ?? ''}${x.present ? ' · 已下载' : ''}${d.recommended?.tier === t ? ' · 推荐' : ''}`;
        return frow({ title: name, hint, control: ctl, right: true });
      };
      return h('div', null,
        p.state === 'error' ? note('bad', `下载没成功：${embedErr(p.error)}`) : null,
        h('div', { class: 'form' }, row('standard', '4B（更准）'), row('light', '0.6B（更轻）')),
        o.wizard ? h('p', { class: 'fhint' }, '下好之前先只按字面找，照常能用；设置走完时还没下好的，会先用「不用」，下好以后在「设置 · 模型」里换回来。') : null);
    }
    function externalForm() {
      const inp = (k, label, ph, extra = {}) => {
        const el = h('input', { class: 'input', value: form[k], placeholder: ph, spellcheck: 'false', autocomplete: 'off', disabled: ro, ...extra });
        el.addEventListener('input', () => { form[k] = el.value; });
        return h('div', { class: 'field' }, h('label', null, label), el);
      };
      let third = false;
      try { const host = new URL(form.url).hostname; third = !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(host); } catch { third = false; }
      return h('div', { class: 'set-ext' },
        inp('url', '地址', 'OpenAI 兼容的 /v1/embeddings 服务的地址'), inp('model', '模型', '例如 text-embedding-3-small'), inp('dim', '维度', '例如 1024', { inputmode: 'numeric' }),
        inp('apiKey', 'API Key（可以不填）', d.hasKey ? '已保存（留空不改）' : '不需要就留空', { type: 'password' }),
        h('div', { class: 'fhint' }, 'Key 存在单独的文件里，不进配置、日志、导出和备份。'),
        third ? note('warn', '这是外部服务：记忆的文字（聊天里整理出的事实、经历和原话片段）会发给它算向量。只有你信任它才用。') : null,
        test ? note(test.ok ? 'info' : 'bad', test.ok ? `连上了：${test.dim} 维，用时 ${test.ms} 毫秒${test.sendDimensions === false ? '（这个服务不认维度参数，以后不带）' : ''}` : `没连上：${embedErr(test.error)}${test.got ? `（实际 ${test.got} 维）` : ''}`) : null,
        h('div', { class: 'set-acts' },
          btn('测试连接', { size: 'sm', disabled: ro, onclick: async () => {
            try { test = await R.api.act('embedding.test', { url: form.url.trim(), model: form.model.trim(), dim: Number(form.dim) > 0 ? Number(form.dim) : 0, ...(form.apiKey ? { apiKey: form.apiKey } : {}) }); if (test.ok && !form.dim) form.dim = String(test.dim); } catch (e) { test = { ok: false, error: e.code }; R.toast(R.errorText(e), { tone: 'bad' }); }
            draw();
          } }),
          btn('用这个', { size: 'sm', kind: 'primary', disabled: ro, onclick: () => {
            if (!form.url.trim() || !form.model.trim() || !(Number(form.dim) > 0)) { R.toast('地址、模型、维度都要填', { tone: 'bad' }); return; }
            save({ mode: 'external', url: form.url.trim(), model: form.model.trim(), dim: Number(form.dim), sendDimensions: test?.ok ? test.sendDimensions !== false : true, ...(form.apiKey ? { apiKey: form.apiKey } : {}), ...(form.clearKey ? { clearKey: true } : {}) });
          } })));
    }
    function draw() {
      const cards = h('div', { class: 'set-opts', role: 'radiogroup', 'aria-label': '想起来的方式' }, OPTS.map(([k, t, desc]) => {
        const b = h('button', { type: 'button', class: 'set-opt', role: 'radio', 'aria-checked': String(sel === k), disabled: ro && sel !== k },
          h('span', { class: 'radio', 'aria-hidden': 'true' }),
          h('span', { class: 'set-opt-t' }, h('b', null, t, k === 'ollama' && d.ollama?.reachable ? tag('推荐', 'gold') : null, d.mode === k && !o.wizard ? tag('在用', '') : null),
            h('span', { class: 'd' }, k === 'ollama' ? ollamaDesc() : desc)));
        b.addEventListener('click', () => { sel = k; test = null; draw(); o.onPick?.(sel, d); });
        return b;
      }));
      cards.addEventListener('keydown', (e) => {
        if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
        e.preventDefault();
        const i = OPTS.findIndex(([k]) => k === sel);
        const j = (i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : OPTS.length - 1)) % OPTS.length;
        sel = OPTS[j][0]; draw(); box.querySelector('[aria-checked="true"]')?.focus(); o.onPick?.(sel, d);
      });
      const body = sel === 'ollama' ? tierRows() : sel === 'external' ? externalForm()
        : !o.wizard && d.mode !== 'none' ? h('div', { class: 'set-acts' }, btn('用这个', { size: 'sm', kind: 'primary', disabled: ro, onclick: () => save({ mode: 'none' }) })) : null;
      R.clear(box, cards, body ? h('div', { class: 'set-gap-s' }, body) : null);
    }
    load();
    box.stop = () => clearTimeout(pollT);
    box.choice = () => sel;
    box.data = () => d;
    return box;
  }
  /** 想起来的方式的默认选择：草稿里有就用草稿；向导里检测不到 Ollama → 「先不用」（乙2）；否则照现在配的。 */
  function defaultChoice(d, o = {}) {
    if (o.initial === 'none' || o.initial === 'ollama' || o.initial === 'external') return o.initial;
    if (d?.mode === 'external') return 'external';
    if (o.wizard) return d?.ollama?.reachable ? 'ollama' : 'none';
    return d?.mode ?? 'none';
  }

  // ════════════════════════════════════════════════════════════════════
  // QQ 桥接（D129：bridge 视图；bridge.setDir / bridge.apply）
  // ════════════════════════════════════════════════════════════════════
  /**
   * @param {{bridge: any, canWrite?: boolean, wizard?: boolean, reload: Function, offGroups?: Set<string>, onGroups?: Function}} o
   */
  function bridgeBlock(o) {
    const b = o.bridge;
    const ro = o.canWrite === false;
    const cur = b?.current ?? null;
    async function useDir(dir) {
      try { await R.api.act('bridge.setDir', { dir }); R.toast(o.wizard ? '好，设置走完后就接上这个桥接' : '记下了，彻底重启 DSH 后 QQ 这个入口接上'); o.reload(); } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); }
    }
    async function patch(dir, revert) {
      try {
        const r = await R.api.confirmed('bridge.apply', { dir, revert }, { title: revert ? '还原 QQ 的补丁' : '让她在 QQ 里也能用记忆', okText: revert ? '还原' : '打补丁', danger: false,
          render: (pv) => h('div', null,
            pv?.error ? h('p', null, pv.error) : h('p', null, revert ? '只删带记号的那几行，别的不动。' : '给桥接的工具白名单加上她的几个记忆工具。第一次改之前自动备份，随时能还原。'),
            pv?.changes?.length ? h('div', { class: 'item mono set-pre' }, pv.changes.map((c) => `${c.op === 'add' ? '+' : '−'} ${c.line}`).join('\n')) : h('p', null, '不用改：已经是这样了。'),
            h('p', null, '要彻底重启 DSH 才生效；已经开着的 QQ 会话要重建才拿到。')) });
        if (r) { R.toast(r.applied ? `已${revert ? '还原' : '打好'}，彻底重启 DSH 后生效` : '不用改'); o.reload(); }
      } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); }
    }
    function chooseDir() {
      const cands = [...(b?.candidates ?? [])].filter((x) => x.isBridge && x.dir !== cur?.dir);
      const input = h('input', { class: 'input mono', placeholder: 'dsh-qq 桥接的目录（完整路径）', spellcheck: 'false', value: '' });
      let layer;
      const pickBtn = (x) => h('button', { type: 'button', class: 'set-cand', onclick: () => { layer.close(); useDir(x.dir); } }, h('span', { class: 'mono' }, x.dir), h('span', { class: 'fhint' }, x.hasSocial ? '找到了桥接的状态文件' : '桥接还没跑起来过'));
      layer = R.dialog({ title: '换桥接的目录',
        body: [cands.length ? h('div', null, h('p', null, '在这台电脑上找到的：'), h('div', { class: 'set-cands' }, cands.map(pickBtn))) : h('p', null, '没自动找到别的桥接。DSH 里开过 QQ 会话以后会出现在这里；也可以手填。'),
          h('div', { class: 'field' }, h('label', null, '手填目录'), input)],
        actions: [btn('取消', { onclick: () => layer.close() }), btn('用这个目录', { kind: 'primary', onclick: () => { const v = input.value.trim(); if (!v) { input.focus(); return; } layer.close(); useDir(v); } })],
        initial: () => input });
    }
    const rows = [];
    if (!b || b.error) rows.push(frow({ title: '读不出桥接的情况', hint: b?.error ? R.errorText({ code: b.error }) : null, right: true, control: btn('重试', { size: 'sm', onclick: o.reload }) }));
    else if (!cur) {
      const cand = (b.candidates ?? []).find((x) => x.isBridge);
      rows.push(frow({ title: '还没接上', hint: cand ? h('span', null, '找到了一个桥接：', h('span', { class: 'mono' }, cand.dir)) : '没找到桥接：DSH 里还没开过 QQ 会话，或者桥接不在这台电脑上。可以手填目录。', right: true,
        control: [cand ? btn('用这个', { size: 'sm', kind: 'primary', disabled: ro, onclick: () => useDir(cand.dir) }) : null, btn(cand ? '换一个…' : '填目录…', { size: 'sm', disabled: ro, onclick: chooseDir })] }));
    } else if (!cur.isBridge) {
      rows.push(frow({ title: '这个目录不像 dsh-qq 桥接', hint: h('span', null, h('span', { class: 'mono' }, cur.dir), '：找不到桥接的工具白名单文件。'), right: true, control: btn('换目录…', { size: 'sm', disabled: ro, onclick: chooseDir }) }));
    } else {
      const m = cur.mode ?? {};
      rows.push(frow({ title: m.secondGen === false ? '接上了，但桥接不是二代模式' : '已接上', right: true,
        hint: h('span', null, '桥接目录 ', h('span', { class: 'mono' }, cur.dir)), control: btn('换目录…', { size: 'sm', disabled: ro, onclick: chooseDir }) }));
      if (m.secondGen === false) rows.push(h('div', { class: 'set-rownote' }, note('bad', '只有二代模式才会把群里的消息写下来，现在 QQ 里的话她都听不到。在桥接里切到二代模式（模式名 reserved2，也叫 simulation），再彻底重启 DSH。')));
      else if (m.readable === false) rows.push(h('div', { class: 'set-rownote' }, note('info', '还没读到桥接的模式（桥接跑起来以后才有）。要用二代模式，QQ 里的消息她才听得到。')));
      const w = cur.whitelist ?? {};
      if (!w.readable) rows.push(frow({ title: '读不到桥接的白名单文件', hint: '没法确认她在 QQ 里能不能用记忆。' }));
      else if (w.patched) rows.push(frow({ title: '她在 QQ 里能用记忆', hint: '已经给桥接打过小补丁（放行她的记忆工具）。', right: true, control: w.canRevert ? btn('还原…', { size: 'sm', kind: 'ghost', disabled: ro, onclick: () => patch(cur.dir, true) }) : null }));
      else if (w.applicable) rows.push(frow({ title: '让她在 QQ 里也能用记忆', hint: '要给桥接打一个小补丁（放行她的几个记忆工具），打完彻底重启 DSH 才生效。', right: true, control: btn('看看要改什么…', { size: 'sm', disabled: ro, onclick: () => patch(cur.dir, false) }) }));
      else rows.push(frow({ title: '这个桥接版本打不了补丁', hint: '要手工在桥接的工具白名单里加上她的记忆工具。' }));
    }
    const out = [h('div', { class: 'form' }, rows)];
    // 向导里：记哪些群（批量取消；之后在「场合」里逐个开关）
    if (o.wizard && cur?.isBridge && o.offGroups) {
      const g = b.groups;
      if (!g?.readable) out.push(note('warn', '读不到这个桥接的群列表。走完以后可以在「场合」里一个个关掉不想记的群。'));
      else {
        out.push(h('div', { class: 'wiz-sub' }, h('h3', null, '记哪些群'), h('p', { class: 'fhint' }, '默认都记。取消勾选的群，她不听也不想起；之后在「场合」里能逐个开关。'),
          g.allowAll ? note('warn', '这个桥接没设群白名单：下面只列出已经有聊天的群，以后进的新群也会记。') : null,
          g.groups.length ? h('div', { class: 'set-checks' }, g.groups.map((x) => {
            const c = h('input', { type: 'checkbox', checked: !o.offGroups.has(x.id) });
            c.addEventListener('change', () => { if (c.checked) o.offGroups.delete(x.id); else o.offGroups.add(x.id); o.onGroups?.(); });
            return h('label', { class: 'cbox' }, c, h('span', null, x.name ?? `没读到群名的群 · ${String(x.id).slice(-4)}`));
          })) : h('p', { class: 'fhint' }, '桥接的白名单里还没有群。')));
      }
    }
    return out;
  }

  return { llmBlock, embedBlock, bridgeBlock, defaultChoice, pairText, providerName, verdictText, embedErr, toastWarn };
};

Rugu.define('settings', (R) => {
  const { h, icon, fmt, section, link, row, list, metaLine, status, btn, frow, sw, seg, more, note, tag, kv } = R;
  const P = Rugu.settingsParts(R);

  const SUB_DESC = { basic: '她是谁、记不记、原话留多久。', models: '后台整理用的模型，和她怎么想起以前的事。', connect: '她从哪儿听到大家说话。', cost: '后台整理花的是你在 DSH 里那个服务商的余额，有上限。',
    backup: '每天夜里自动备份；硬盘坏了也找得回来。', diag: '她没反应、记不住的时候，先来这里看。', about: '' };
  const RET = { '1y': '1 年', '2y': '2 年', '5y': '5 年', forever: '永久' };
  /** 用途的说法（设计说明第 7 节的对照表）。 */
  const USE = { glance: '听到时的快速判断', extract: '整理成记忆', sleep: '夜里整理', summary: '小结', appraise: '说话前的细看', review: '发出前的检查', rewrite: '读懂问题', perceive: '看图片和视频', test: '试一下（后台模型）' };
  const USE_ORDER = Object.keys(USE);
  const DENY_WHY = { calls: '到了每天的次数上限', tokens: '到了每天的输入上限', output: '到了每天的输出上限', ratio: '超过了她聊天的比例', source: '一个群或私聊占得太多', balance: '余额保护',
    scope: '节省档只在对她说时细看', reserve: '发出前检查的预留用完了', off: '没用后台模型' };
  const PRESET = { saving: '节省', loose: '平衡', unlimited: '效果优先' };
  const TIER_LINE = { saving: '记忆给得少一些', loose: '大多数人用这个', unlimited: '记忆给得最多' };
  const PACK_KIND = { daily: '日包', weekly: '周包', monthly: '月包', 'pre-op': '操作前', manual: '手动' };
  const PREOP = { purge: '彻底删除之前', withdraw: '按来源撤回之前', restore: '整体恢复之前', 'restore-partial': '部分恢复之前', retention: '原话到期删除之前', migrate: '升级数据之前', space: '换想起来的方式之前' };
  const ERR_WORDS = { FTS_MISSING: '全文索引缺了', ECONNRESET: '连接被断开了', ECONNREFUSED: '连不上', ENOTFOUND: '找不到地址', TIMEOUT: '等太久没回', ETIMEDOUT: '等太久没回', EACCES: '没有权限',
    ENOENT: '找不到文件', EBUSY: '文件被占着', SQLITE_BUSY: '数据库忙', SQLITE_CORRUPT: '数据库文件坏了', UNKNOWN_MODEL: '没有这个模型', RATE_LIMIT: '被限流了', QUOTA: '余额用完了', AUTH: 'Key 或登录失效', VERIFY_FAILED: '包验证不过', SAMPLE_MISS: '抽查有记忆没找回来' };
  const errWord = (c) => (c ? `${ERR_WORDS[c] ?? '出错了'}（${c}）` : '');
  const toastWarn = P.toastWarn;
  const ok = (text) => R.toast(text);
  const fail = (e) => R.toast(R.errorText(e), { tone: 'bad' });

  let timers = [];
  let stops = [];
  function leave() { for (const t of timers) clearTimeout(t); timers = []; for (const s of stops) { try { s(); } catch { /* 尽力 */ } } stops = []; }

  // ── 外壳：左侧小导航 + 页头 + 顶上的提示 ──────────────────────────────
  async function render(el, route) {
    leave();
    const sub = route.sub;
    const subs = R.SUBS.settings;
    const content = h('div', { class: 'scontent' });
    const navBox = h('div', { class: 'set-navbox' });
    const drawNav = (dots = {}) => R.clear(navBox, R.sideNav(subs.map(([k, t, ic]) => [k, t, ic, !!dots[k]]), sub, (k) => R.go(`settings/${k}`, { focus: false })));
    drawNav();
    R.clear(el, h('div', { class: 'wrap' }, h('div', { class: 'sidenav-layout' }, navBox, content)));
    const title = subs.find(([k]) => k === sub)?.[1] ?? '设置';
    const headBox = h('div', { class: 'set-head' });
    const body = h('div', { class: 'set-body' }, R.loading());
    R.add(content, sub === 'about' ? null : R.pageHead(title, SUB_DESC[sub]), headBox, body);
    let head = null;
    try { head = await R.api.get('setHead'); } catch { head = null; }
    if (R.route() !== route) return;
    if (head) { drawNav(head.dots); R.clear(headBox, topNotice(head)); }
    const ctx = { head, route, reload: () => render(el, R.route()), canWrite: head ? head.canWrite !== false : true, readOnly: !!head?.store?.readOnly };
    const fn = { basic, models, connect, cost, backup, diag, about }[sub];
    try { await fn(body, ctx); } catch (e) { if (R.route() === route) R.clear(body, R.errorBox(e, ctx.reload)); }
  }
  /** 设置页顶上的一条提示：还没套用的配置改动、配置文件读不了、记忆库只读。 */
  function topNotice(hd) {
    const out = [];
    if (hd.pendingRisky?.length) {
      out.push(note('warn', [h('b', { class: 'set-b' }, `配置文件被直接改过，有 ${hd.pendingRisky.length} 项改动还没生效`), h('div', { class: 'fhint' }, '不是在这个页面上改的：是你自己改的就确认；不是你改的就丢弃（按现在的设置重写配置文件）。'),
        h('div', { class: 'set-acts' }, btn('看看并确认…', { size: 'sm', kind: 'primary', onclick: applyPending }), btn('丢弃', { size: 'sm', onclick: discardPending }))]));
    }
    if (hd.loadError) out.push(note('bad', `配置文件读不了（${hd.loadError}）：现在用的是默认设置，这里的设置都改不了。先修好配置文件（「关于 · 数据在哪儿」里有它的位置）。`));
    else if (hd.canWrite === false) out.push(note('warn', '这里只能看：宿主没给写配置的接口。'));
    if (hd.store?.readOnly) out.push(note('bad', hd.store.newer ? '记忆库现在是只读的：数据的版本比插件新，可能是插件被换回了旧版本。装回新版本就好。备份、恢复这些先改不了。' : '记忆库现在是只读的：备份、恢复这些先改不了。', R.link('看诊断', 'settings/diag')));
    else if (hd.store?.error) out.push(note('bad', '记忆库读不出来。', R.link('看诊断', 'settings/diag')));
    return out.length ? h('div', { class: 'set-notices' }, out) : null;
  }
  async function applyPending() {
    try {
      const r = await R.api.confirmed('config.applyPending', {}, { title: '让配置文件里的这些改动生效', okText: '确认生效',
        render: (pv) => h('div', null, h('p', null, '这些是有风险的改动，确认以后马上生效：'), h('ul', { class: 'set-ul' }, (pv?.items ?? []).map((x) => h('li', null, x.reason)))) });
      if (r) { ok(`已生效 ${r.applied ?? 0} 项`); R.go(R.route().path, { focus: false }); }
    } catch (e) { fail(e); }
  }
  async function discardPending() {
    try { await R.api.act('config.discardPending'); ok('已丢弃，配置文件按现在的设置重写了'); R.go(R.route().path, { focus: false }); } catch (e) { fail(e); }
  }
  /** 写一项配置（config.set）：宿主说有风险时走确认。返回是否成功（取消 = false）。 */
  async function setKey(key, value, { title = '确认修改这项设置', consequence, okText = '确定', danger = false } = {}) {
    try {
      const r = await R.api.confirmed('config.set', { key, value }, { askable: true, title, consequence, okText, danger });
      if (r == null) return false;
      toastWarn(r);
      ok('已保存，马上生效');
      return true;
    } catch (e) { fail(e); return false; }
  }
  /** 开关：返回一个 sw，取消确认时翻回去。 */
  function cfgSwitch(checked, label, onTurn, disabled) {
    const s = sw(checked, async (v) => { const done = await onTurn(v); if (!done) s.setAttribute('aria-checked', String(!v)); }, label, { disabled });
    return s;
  }
  const mono = (t) => h('span', { class: 'mono' }, t);
  const sub2 = (title, ...kids) => h('div', { class: 'set-sub' }, title ? h('h3', null, title) : null, ...kids);

  // ════════════════════════════════════════════════════════════════════
  // 基本
  // ════════════════════════════════════════════════════════════════════
  async function basic(box, ctx) {
    const d = await R.api.get('setBasic');
    const ro = !ctx.canWrite || d.canWrite === false;
    R.clear(box, whoSection(d.who, ro), switchesSection(d, ro), retentionSection(d, ro, ctx),
      h('div', { class: 'set-more' }, more('更多', h('div', { class: 'form' },
        frow({ title: '告诉她怎么用记忆', hint: `${d.usageStyle === 'purpose' ? '只讲目的：规矩少，让模型自己判断，适合更强的模型。' : '写得具体：一步步告诉她什么时候想、怎么记，适合 DeepSeek 这类模型。'}放进对话的记忆从下一条消息起换写法；记忆工具的说明在新开的对话里生效。`,
          control: seg([['guided', '写得具体'], ['purpose', '只讲目的']], d.usageStyle ?? 'guided', async (v) => { await setKey('context.usageStyle', v); ctx.reload(); }, '用法说明的写法') })))));
    if (ro) box.querySelectorAll('.seg button').forEach((b) => { b.disabled = true; });
  }

  function whoSection(w, ro) {
    const f = { principalLabel: w.principalLabel ?? '', selfNames: (w.selfNames ?? []).join('、'), presetName: w.presetName ?? '', personaPrefix: w.personaPrefix ?? '' };
    const orig = { ...f };
    const save = btn('保存', { kind: 'primary', disabled: true });
    const field = (k, label, opts = {}) => {
      const el = opts.area ? h('textarea', { class: 'textarea', id: `set-${k}`, rows: 4, maxlength: String(w.prefixMax ?? 2000), disabled: ro, placeholder: opts.ph ?? '' }) : h('input', { class: 'input', id: `set-${k}`, disabled: ro, placeholder: opts.ph ?? '', maxlength: opts.max ? String(opts.max) : null });
      el.value = f[k];
      const counter = opts.area ? h('span', { class: 'set-count' }) : null;
      const sync = () => { f[k] = el.value; save.disabled = ro || Object.keys(f).every((x) => f[x] === orig[x]); if (counter) counter.textContent = `${[...el.value.trim()].length} / ${w.prefixMax ?? 2000} 字`; };
      el.addEventListener('input', sync);
      sync();
      return h('div', { class: 'field' }, h('label', { for: `set-${k}` }, label), el, opts.hint || counter ? h('div', { class: 'fhint set-fhint' }, h('span', null, opts.hint ?? ''), counter) : null);
    };
    save.addEventListener('click', async () => {
      const body = {};
      for (const k of Object.keys(f)) if (f[k] !== orig[k]) body[k] = k === 'selfNames' ? f[k] : f[k].trim();
      save.disabled = true;
      try { const r = await R.api.act('persona.save', body); toastWarn(r); Object.assign(orig, f); ok('已保存，马上生效'); } catch (e) { fail(e); save.disabled = false; }
    });
    const preset = w.preset;
    return section('她是谁', null,
      field('principalLabel', '她怎么称呼你', { ph: `默认「${w.principalDefault ?? '主人'}」`, max: 20 }),
      field('selfNames', '她的名字和昵称', { ph: '可以不填', hint: '在 QQ 里有人叫这些名字时，她知道是在叫她。多个用逗号或顿号隔开。' }),
      field('presetName', 'DSH 新建任务里显示的名字', { ph: `默认「${w.presetDefault ?? '人设聊天'}」`, max: 40, hint: '在 DSH「新建任务」里选这个预设开的对话，才算在和她聊。' }),
      field('personaPrefix', '人设开头', { area: true, ph: '比如：我是她，是你的朋友。平时话不多，喜欢听大家聊天。空着就用 DSH 标准模式自带的开头。' }),
      h('p', { class: 'fhint set-after' }, '人设开头是 DSH 桌面里「人设聊天」这个预设的开场设定：她对自己的认识，一两段就够。QQ 那边的人设写在 dsh-qq 桥接自己的预设里，两边要保持一致——改了这里，记得也去桥接里改。'),
      h('div', { class: 'set-savebar' }, save, h('span', { class: 'fhint' }, '保存后马上生效：称呼和名字下一条消息起用；预设的名字和人设开头马上在 DSH 新建任务里更新，已经开着的对话不变，新建的对话用新的。')),
      preset && (!preset.registered || preset.broken) ? h('div', { class: 'set-gap-s' }, note('warn', '「人设聊天」现在不在 DSH 新建任务的列表里，改了名字也看不到。到「诊断」看看为什么。', R.link('看诊断', 'settings/diag'))) : null);
  }

  function switchesSection(d, ro) {
    const m = d.mode;
    if (!m) return section('记忆开关', null, note('warn', '读不到总开关的设置。'));
    const master = m.global !== 'off';
    const DEF = [['principalOneOnOne', '和你一对一', '你和她单独聊的地方'], ['closed', '封闭的群', '要邀请才能进、不对外公开的群'], ['public', '公开场合', '任何人能看到、公开留存的地方，比如评论区']];
    return section('记忆开关', null, h('div', { class: 'form' },
      frow({ title: '记忆', right: true, cls: 'sw', hint: master ? '开着：她在哪儿都记得；在群里、公开场合说不说，由她按分寸自己判断。' : '关着：她在哪儿都不记新的事、也不想起以前的事。已经记得的都还在。',
        control: cfgSwitch(master, '记忆总开关', (v) => (v ? setKey('mode.global', 'live')
          : setKey('mode.global', 'off', { title: '关掉记忆', consequence: '她在哪儿都不再记新的事，也不再想起以前的事，直到你再打开。已经记得的不会删。', okText: '关掉', danger: true })), ro) }),
      DEF.map(([k, name, hint]) => frow({ title: `新场合默认：${name}`, right: true, cls: 'sw', hint: `${hint}。新出现的这类场合${m.byAttributes?.[k] === 'off' ? '默认不记' : '默认记'}；每个场合也能在「场合」里单独开关。`,
        control: cfgSwitch(m.byAttributes?.[k] !== 'off', `新场合默认在${name}记`, (v) => setKey(`mode.byAttributes.${k}`, v ? 'live' : 'off'), ro || !master) })),
      h('p', { class: 'fhint set-after' }, '改了马上生效。已经有的场合照它们自己的开关；「场合」页里显示的默认值就是这里的。')));
  }

  function retentionSection(d, ro, ctx) {
    const r = d.retention;
    const cool = d.coolingOffDays ?? 7;
    if (!r || r.error) return section('原话保留多久', null, note('warn', R.errorText({ code: r?.error }, 'read')));
    const value = r.pending ? r.pending.to : r.current;
    const order = d.retentionOptions ?? ['1y', '2y', '5y', 'forever'];
    const chip = R.dropdown('原话保留', order.map((v) => ({ value: v, label: RET[v] ?? v })), value, async (v) => {
      if (v === value) return;
      if (order.indexOf(v) < order.indexOf(r.current)) {
        try {
          const res = await R.api.confirmed('retention.request', { to: v }, { title: `原话只留 ${RET[v]}`, okText: '开始冷静期',
            render: (pv) => { const im = pv?.impact; return h('div', null,
              h('p', null, `到时会删掉${im ? ` ${fmt.num(im.percepts)} 条原话和 ${fmt.num(im.windows)} 段原文片段${im.from ? `（${fmt.day(im.from)} 到 ${fmt.day(im.to)} 之间的）` : ''}` : '更早的原话'}。她记得的经历和事实都留着，只是查不到原话了。`),
              h('p', null, `改完有 ${pv?.coolingOffDays ?? cool} 天冷静期，期间什么都不删、随时能取消；到期前会先做一份完整备份。删掉的原话找不回来。`)); } });
          if (res) ok(res.status === 'cooling-off' ? `${cool} 天后生效，期间随时能取消` : '已保存');
        } catch (e) { fail(e); }
      } else {
        try { await R.api.act('retention.request', { to: v }); ok('已延长，马上生效'); } catch (e) { fail(e); }
      }
      ctx.reload();
    }, { allValue: '__none__' });
    chip.disabled = ro || ctx.readOnly;
    // 样稿的写法：胶囊上只写现在的值（不当成「筛选」高亮）
    chip.classList.remove('on');
    R.clear(chip, RET[value] ?? value, icon('down', 14));
    return section('原话和变化', null, h('div', { class: 'form' },
      frow({ title: '原话保留多久', right: true, control: chip, hint: `到期删掉的只是原话和原文片段，她记得的事一直留着。延长马上生效；缩短要确认，再等 ${cool} 天。` }),
      r.pending ? h('div', { class: 'set-rownote' }, note('info', `${fmt.day(r.pending.effectiveAt)} 起改成 ${RET[r.pending.to] ?? r.pending.to}（还有 ${r.pending.daysLeft} 天）${r.pending.impact ? `，到时会删掉 ${fmt.num(r.pending.impact.percepts)} 条原话` : ''}。`,
        btn('取消这次缩短', { size: 'sm', kind: 'ghost', disabled: ro || ctx.readOnly, onclick: async () => { try { await R.api.act('retention.cancel'); ok('已取消，保留期不变'); ctx.reload(); } catch (e) { fail(e); } } }))) : null,
      frow({ title: '性格的变化怎么生效', hint: d.growthMode === 'approve' ? '每处变化都先放进「待处理 · 等你批准」，你点头才写进去。' : '夜里整理出的变化自动写进她的性格，你随时能撤销。',
        control: d.growthMode ? seg([['auto', '自动'], ['approve', '逐条批准']], d.growthMode, async (v) => { await setKey('sleep.growth.mode', v); ctx.reload(); }, '性格的变化怎么生效') : h('span', { class: 'muted' }, '读不到') }),
      ctx.readOnly ? h('p', { class: 'fhint' }, '记忆库只读的时候，原话保留多久改不了。') : null));
  }

  // ════════════════════════════════════════════════════════════════════
  // 模型
  // ════════════════════════════════════════════════════════════════════
  async function models(box, ctx) {
    const d = await R.api.get('setModels');
    const ro = !ctx.canWrite || d.canWrite === false;
    const onFailureRow = () => frow({ title: '说话前的细看没成的时候', stack: true,
      hint: '有些记忆放进对话之前，要先让后台模型看一眼「这里适不适合提」。模型连不上、今天的花费到了上限、或者太慢等不及时，这一步就没成。公开、收不回的场合（比如评论区）不管选哪个，都照旧先不提。',
      control: seg([['give', '照常想起，让她自己掂量（推荐）'], ['omit', '这一轮先不想起']], d.onFailure, async (v) => {
        try { const r = await R.api.act('discretion.onFailure', { value: v }); toastWarn(r); ok('已保存，马上生效'); } catch (e) { fail(e); ctx.reload(); }
      }, '说话前的细看没成的时候') });
    const llm = P.llmBlock({ status: d.llm && !d.llm.error ? d.llm : null, canWrite: !ro, onFailureRow });
    const embed = P.embedBlock({ canWrite: !ro });
    stops.push(() => embed.stop());
    R.clear(box,
      section('后台模型', null, h('p', { class: 'sdesc' }, '她在后台调的模型：听到时的快速判断、把聊天整理成记忆、夜里整理、说话前的细看。走 DSH 的模型通道，花的是 DSH 里那个服务商的余额。'), llm),
      section('想起来的方式', null, h('p', { class: 'sdesc' }, '给每条记忆算一个「意思」，换个说法也想得起来。三种都能用，差别在想不想得起来。'), embed),
      gpuSection(d.gpu, ro, ctx),
      h('div', { class: 'set-more' }, more('技术细节', techDetails(d, ro, ctx))));
    if (ro) box.querySelectorAll('.seg button').forEach((b) => { b.disabled = true; });
  }
  const GPU_REASON = { 'game-mode': '游戏模式开着', fullscreen: '有程序全屏', vram: '显存不够', busy: '显卡忙', schedule: '在让出的时段里', 'no-sample': '还没读到显卡', 'no-gpu-reading': '读不到显卡',
    'gpu-error': '显卡出过错', cooldown: '刚让出过，等一会儿再用', 'policy-off': '选的是「不用」' };
  const gpuReason = (r) => (/^process:\d+$/.test(r) ? '你列的程序在运行' : GPU_REASON[r] ?? r);
  function gpuSection(g, ro, ctx) {
    if (!g || g.error) return section('显卡', null, h('p', { class: 'fhint' }, g?.error ? R.errorText({ code: g.error }, 'read') : '这里管不了显卡（宿主没提供）。'));
    const pol = g.policy ?? 'adaptive';
    const hint = pol === 'on' ? '一直用：不看显存，玩游戏、开语音合成时可能卡。' : pol === 'off' ? '不用：想起来的方式一直在 CPU 上算（慢一些，聊天不受影响）。' : '有空才用：你玩游戏、全屏或显存紧张时让出来，改用 CPU（慢一些，聊天不受影响）。';
    const game = g.gameMode ?? {};
    let hours = '';
    const hoursSel = h('select', { class: 'input set-select set-hours', 'aria-label': '游戏模式开多久', disabled: ro || !g.canSet, hidden: !!game.on },
      [['', '开到我关掉'], ['1', '开 1 小时'], ['2', '开 2 小时'], ['4', '开 4 小时'], ['8', '开 8 小时']].map(([v, t]) => h('option', { value: v }, t)));
    hoursSel.addEventListener('change', () => { hours = hoursSel.value; });
    return section('显卡', null, h('div', { class: 'form' },
      frow({ title: '用不用显卡', hint,
        control: g.canSet ? seg([['off', '不用'], ['adaptive', '有空才用'], ['on', '一直用']], pol, async (v) => {
          try {
            const r = await R.api.confirmed('gpu.policy', { policy: v }, { askable: true, title: v === 'on' ? '显卡一直用' : '换显卡的用法', danger: false, okText: '换',
              consequence: v === 'on' ? '「一直用」不看显存：玩游戏、开语音合成时可能卡顿。一般用「有空才用」就够了。' : undefined });
            if (r) { toastWarn(r); ok('已切换'); }
          } catch (e) { fail(e); }
          ctx.reload();
        }, '用不用显卡') : status({ off: '不用', on: '一直用', adaptive: '有空才用' }[pol] ?? pol, 'dim') }),
      frow({ title: '游戏模式', right: true, cls: 'sw', hint: game.on ? (game.until === -1 ? '开着，直到你关掉。' : `开着，${fmt.when(game.until)} 自动关。`) : '打开后让出显卡、少占几个 CPU 线程；可以只开几个小时。',
        control: [hoursSel, sw(!!game.on, async (v) => {
          const r = await R.api.act('gpu.gameMode', v ? { on: true, ...(hours ? { hours: Number(hours) } : {}) } : { on: false });
          toastWarn(r); ok(v ? '游戏模式开了' : '游戏模式关了'); ctx.reload();
        }, '游戏模式', { disabled: ro || !g.canSet })] })));
  }
  function techDetails(d, ro, ctx) {
    const g = d.gpu && !d.gpu.error ? d.gpu : null;
    const e = d.embedding?.health && !d.embedding.health.error ? d.embedding.health : null;
    const spaces = Array.isArray(d.spaces) ? d.spaces : [];
    const SPACE = { active: ['在用', 'ok'], shadow: ['备用（正在算）', ''], retired: ['不用了', ''], suspect: ['对不上', 'bad'] };
    const activate = async (s, rebaseline) => {
      try {
        const r = await R.api.confirmed('embedding.activate', { spaceId: s.spaceId, rebaseline }, { title: rebaseline ? '就用现在这个模型' : '换成这一份向量', okText: rebaseline ? '确认并全部重算' : '换', danger: rebaseline,
          consequence: rebaseline ? '会重新记录比对用的句子、删掉这一份的旧向量并全部重算（CPU 上可能要几个小时），这期间先只按字面找。' : '之后想起来都用这一份；旧的留一段时间，可以切回。' });
        if (r) { if (r.ok) ok('已切换'); else R.toast(`没切成：${r.reason ?? '原因不明'}`, { tone: 'bad' }); ctx.reload(); }
      } catch (err) { fail(err); }
    };
    return h('div', { class: 'set-tech' },
      sub2('显卡现在', g ? kv([['现在在', g.device === 'gpu' ? '显卡上算' : `CPU 上算${g.cpuThreads ? `（${g.cpuThreads} 个线程）` : ''}`], ['为什么', g.reasons?.length ? g.reasons.map(gpuReason).join('、') : '显卡有空'],
        ['空闲显存', g.vram ? `${(g.vram.freeMb / 1024).toFixed(1)} GB / ${(g.vram.totalMb / 1024).toFixed(1)} GB` : '—'], ['显卡占用', g.vram?.utilPct != null ? `${g.vram.utilPct}%` : '—'],
        ['重新排序', g.rerankAllowed ? '可以用' : '不用'], ['最近一次读显卡', g.sampler === false ? '读不到' : g.sampledAt ? fmt.ago(g.sampledAt) : '—']]) : h('p', { class: 'fhint' }, '读不到。')),
      sub2('想起来的方式现在', e ? kv([['后台线程', e.mode === 'thread' ? '正常' : '退回主线程'], ['按「意思」找', e.dense ? '能用' : e.breakerOpen ? '连续失败，先停一会儿' : '用不了'],
        ['等着算的', e.queue?.pending ?? '—'], ['要重算 / 失败', `${e.queue?.stale ?? 0} / ${e.queue?.failed ?? 0}`], e.reason ? ['原因', e.reason] : null,
        ['配置', mono(`host.embedding.provider = ${d.embedding?.provider ?? '—'}${d.embedding?.tier ? `，tier = ${d.embedding.tier}` : ''}`)]]) : h('p', { class: 'fhint' }, '读不到。')),
      sub2('向量空间', spaces.length ? list(spaces.map((s) => row({ title: [mono(s.model ?? s.spaceId), ' ', tag(...(SPACE[s.status] ?? [s.status ?? '', '']))], clamp: false,
        meta: metaLine(s.dim ? `${s.dim} 维` : null, s.coverage != null ? `算了 ${fmt.pct(s.coverage)}` : null, s.createdAt ? `${fmt.day(s.createdAt)} 建的` : null),
        trail: s.status === 'shadow' ? btn('换成它', { size: 'sm', disabled: ro || ctx.readOnly, onclick: () => activate(s, false) }) : s.status === 'retired' ? btn('切回', { size: 'sm', disabled: ro || ctx.readOnly, onclick: () => activate(s, false) })
          : s.status === 'suspect' ? btn('就用现在这个模型…', { size: 'sm', kind: 'danger-ghost', disabled: ro || ctx.readOnly, onclick: () => activate(s, true) }) : null })))
        : h('p', { class: 'fhint' }, '还没有。想起来的方式第一次连上时会建。'),
      h('p', { class: 'fhint' }, '换了模型以后，所有记忆要按新模型重算一遍；算完之前照旧用原来的，算完在这里切换。旧的留 14 天，可以切回。')));
  }

  // ════════════════════════════════════════════════════════════════════
  // 接入
  // ════════════════════════════════════════════════════════════════════
  async function connect(box, ctx) {
    const d = await R.api.get('setConnect');
    const ro = !ctx.canWrite || d.canWrite === false;
    const q = d.qq;
    const cur = q.bridge && !q.bridge.error ? q.bridge.current : null;
    const acct = h('input', { class: 'input set-acct', inputmode: 'numeric', placeholder: q.selfAccount.recognized ? '已自动认出' : '她的 QQ 号', value: q.selfAccount.configured ?? '', disabled: ro, 'aria-label': '她自己的 QQ 号' });
    const acctSave = btn('保存', { size: 'sm', disabled: ro, onclick: async () => {
      try { const r = await R.api.act('qq.selfAccount', { account: acct.value.trim() }); toastWarn(r); ok(acct.value.trim() ? '已保存，马上生效' : '已清掉，让插件自己认'); ctx.reload(); } catch (e) { fail(e); }
    } });
    const acctHint = q.selfAccount.configured ? '你填的：用它认出群里哪一个是她。清空就让插件自己从 QQ 的缓存里认。'
      : q.selfAccount.recognized ? '已经从 QQ 的缓存里自动认出了她的账号（号码只在内存里用，不显示、不写进任何文件）。认错了再在这里填。'
        : '没能自动认出来（有的协议端认不出）。填上以后，群里有人 @ 她、提到她时认得更准。';
    const qp = q.places ?? { total: 0, live: 0, off: 0 };
    const bridgeRows = P.bridgeBlock({ bridge: q.bridge, canWrite: !ro, reload: ctx.reload });
    const web = d.web;
    const others = d.others ?? [];
    R.clear(box,
      section('QQ', null,
        h('p', { class: 'sdesc' }, 'dsh-qq 是让她进 QQ 的桥接程序（第三方的开源项目），如故只读它写下的状态文件。', q.links?.bridge ? [' ', extLink('去了解 dsh-qq', q.links.bridge)] : null),
        bridgeRows,
        cur?.isBridge ? h('div', { class: 'form' },
          frow({ title: '她自己的 QQ 号', hint: acctHint, control: h('div', { class: 'set-inline' }, acct, acctSave), stack: true }),
          frow({ title: '记哪些群', right: true, hint: qp.total ? `${qp.live} 个群和私聊在记${qp.off ? `，${qp.off} 个没在记` : ''}。首次设置时可以一次勾掉不想记的群；之后在「场合」里逐个开关。` : '还没有群和私聊：桥接接上、有人说话以后出现。', control: link('去场合', 'places/list') })) : null,
        h('div', { class: 'set-gap-s' }, note('warn', '这条路线是第三方的 QQ 接入，QQ 号有被封的风险：请用小号，不要用主号。也请告诉群友，他们的话会被记下来。'))),
      section('DSH 桌面', null, h('div', { class: 'form' },
        frow({ title: web.places.total ? `已接上 · ${web.places.total} 个对话` : '还没有对话', right: true, hint: `在 DSH「新建任务」里选「${web.presetName}」预设开的对话，她都在场。别的预设开的对话（比如写代码的）不算。`,
          control: web.places.total ? link('去场合', 'places/list') : null }))),
      others.length ? others.map((o) => section(o.name, null, h('div', { class: 'form' },
        frow({ title: o.connected ? `已接上 · ${o.live} 个在记${o.off ? `，${o.off} 个没在记` : ''}` : '没接着（那个插件现在没加载）', right: true, hint: '由别的插件接进来。公开场合说话前，她会多看一眼。', control: link('去场合', 'places/list') }))))
        : section('别的入口', null, h('p', { class: 'fhint' }, '装上能接进如故的插件（比如 B站伙伴）以后，它的评论区、私信会出现在这里和「场合」里，不用另外设置。')));
  }
  /** 外部链接：新窗口打开（嵌在 DSH 里时交给系统浏览器）；地址由服务端给。 */
  function extLink(label, href) {
    return h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('link', 14));
  }

  // ════════════════════════════════════════════════════════════════════
  // 花费
  // ════════════════════════════════════════════════════════════════════
  async function cost(box, ctx) {
    const d = await R.api.get('setCost');
    const ro = !ctx.canWrite || d.canWrite === false;
    const bud = d.budget && !d.budget.error ? d.budget : null;
    const bc = d.budgetConfig;
    const t = d.tiers;
    const known = t.priceKnown;
    const money = (x) => fmt.yuan(x);
    async function setBudget(preset, overrides) {
      try {
        const r = await R.api.confirmed('budget.set', { preset, overrides }, { askable: true, title: preset === 'unlimited' && !Object.keys(overrides).length ? '换成「效果优先」' : '改花费的上限', okText: '换',
          danger: preset === 'unlimited' || overrides.balanceProtectDays === 0,
          render: (pv) => (pv?.reasons?.length ? h('div', null, h('p', null, preset === 'unlimited' ? '后台该做的都照做，不会因为到了每天的上限停下来，记忆也给得最多。余额只够 1 天时照样会停下来。' : '这项改动有风险：'),
            h('ul', { class: 'set-ul' }, pv.reasons.filter((x) => !/^换成「效果优先」/.test(x)).map((x) => h('li', null, x)))) : h('p', null, '马上生效。')) });
        if (r) { toastWarn(r); ok(Object.keys(overrides).length ? '已保存自定义，马上生效' : `已换成「${PRESET[preset]}」，马上生效`); }
      } catch (e) { fail(e); }
      ctx.reload();
    }
    const cards = h('div', { class: 'set-tiers', role: 'radiogroup', 'aria-label': '花费档位' }, t.tiers.map((x) => {
      const c = x.ceiling ?? {};
      const cur = x.current && !t.custom;
      const lines = [];
      if (cur && t.recent) lines.push(h('span', { class: 'set-tv-a' }, t.recent.yuan != null ? `最近 ${t.recent.days} 天平均一天 ${money(t.recent.yuan)}` : `最近 ${t.recent.days} 天平均一天调用 ${t.recent.calls} 次`));
      if (!known) lines.push(h('span', { class: 'muted' }, '上限按次数和用量管，不按钱'));
      else if (c.capped === false) lines.push(h('span', { class: 'muted' }, '不设每天的上限'));
      else if (c.capped) lines.push(h('span', { class: 'muted' }, `最多一天 ${money(c.offPeak)}（高峰 ${money(c.peak)}）`));
      const b = h('button', { type: 'button', class: 'set-tier', role: 'radio', 'aria-checked': String(cur), disabled: ro && !cur },
        h('span', { class: 'set-tn' }, PRESET[x.key], h('span', { class: 'ck', 'aria-hidden': 'true' }, icon('check', 12, 3))), h('span', { class: 'set-tp' }, TIER_LINE[x.key]), h('span', { class: 'set-tv' }, lines));
      b.addEventListener('click', () => { if (!cur) setBudget(x.key, {}); });
      return b;
    }));
    const reserveLine = known && t.tiers.some((x) => x.ceiling?.capped) ? h('p', { class: 'fhint set-after' },
      `「最多」是按每天的用量上限和 DeepSeek 的价目算的最坏一天（全按空闲价；括号里全按高峰价）。另有几小份预留不受它管（对她说的一对一整理、听到时的快速判断、发出前的检查），最坏再多约：${t.tiers.filter((x) => x.ceiling?.capped).map((x) => `${PRESET[x.key]} ${money(x.ceiling.reserveOffPeak)}`).join('、')}（高峰翻倍）。「效果优先」只有余额保护。实际用不到这么多。`) : null;
    const today = bud?.today ?? {};
    const recent = bud?.recent?.days ?? [];
    const last15 = recent.slice(-15);
    const max = Math.max(0.0001, ...last15.map((x) => x.bgYuan ?? 0));
    const sum15 = last15.reduce((a, x) => a + (x.bgYuan ?? 0), 0);
    const daysLeft = bud?.balance?.known && typeof bud.balance.days === 'number' ? Math.max(0, Math.floor(bud.balance.days)) : bud?.balance?.days === 'inf' ? 'inf' : null;
    const figs = bud ? h('div', { class: 'set-figs' },
      h('div', { class: 'set-fig' }, h('div', { class: 'k' }, '今天'), h('div', { class: 'v' }, known ? money(today.bgYuan ?? 0) : `${today.calls ?? 0} 次`),
        h('div', { class: 's' }, known ? (today.mainYuan > 0 ? `她的聊天本身花了 ${money(today.mainYuan)}，后台相当于它的 ${fmt.pct(bud.ratioToMain)}` : today.calls ? `后台调用了 ${today.calls} 次` : '今天还没调用过') : '不知道这个模型的价目，只记用量')),
      h('div', { class: 'set-fig' }, h('div', { class: 'k' }, `最近 ${last15.length || 15} 天`), h('div', { class: 'v' }, known ? money(sum15) : `${last15.reduce((a, x) => a + (x.calls ?? 0), 0)} 次`),
        h('div', { class: 'set-spark', role: 'img', 'aria-label': `最近 ${last15.length} 天每天的后台花费` }, last15.map((x) => h('i', { class: x.today ? 'today' : '', style: { height: `${Math.max(4, ((x.bgYuan ?? 0) / max) * 100)}%` }, title: `${x.day}：${money(x.bgYuan ?? 0)}` }))),
        h('div', { class: 's' }, bud.paused ? '余额快用完了，后台整理先停了' : daysLeft === 'inf' ? '余额还够很久' : daysLeft != null ? `余额还够约 ${daysLeft} 天` : ''))) : note('warn', R.errorText({ code: d.budget?.error }, 'read'));
    R.clear(box,
      section('档位', t.custom ? `现在是自定义（以「${PRESET[bc?.preset] ?? '平衡'}」为基础）` : null, cards, reserveLine,
        t.custom ? h('div', { class: 'set-gap-s' }, note('info', '现在是自定义：点上面任一档就回到那一档，改过的都清掉。')) : null),
      section('花了多少', null, figs),
      bud ? h('div', { class: 'set-more set-folds' },
        more('按用途的明细（今天）', useTable(bud, known)),
        more('每天的上限', limitsBlock(bud, bc, ro, setBudget)),
        more('记忆给多少', memoryRoom(bc)),
        more('这些数准不准', accuracy(bud, t))) : null);
    if (ro) box.querySelectorAll('.set-tier').forEach((b) => { b.disabled = true; });
  }
  function useTable(bud, known) {
    const by = bud.today?.byUse ?? {};
    const keys = Object.keys(by).filter((k) => by[k].calls > 0).sort((a, b) => (USE_ORDER.indexOf(a) + 99 * (USE_ORDER.indexOf(a) < 0)) - (USE_ORDER.indexOf(b) + 99 * (USE_ORDER.indexOf(b) < 0)));
    if (!keys.length) return h('p', { class: 'fhint' }, '今天还没有后台调用。');
    const n = (x) => (x == null ? '—' : fmt.num(x));
    const t = bud.today;
    const rows = keys.map((k) => { const x = by[k]; return [USE[k] ?? '其他', `${x.calls}${x.failed ? `（失败 ${x.failed}）` : ''}`, n(x.in), n(x.cached), n(x.out), known ? fmt.yuan(x.yuan) : '—']; });
    if (keys.length > 1) rows.push(['合计', String(t.calls ?? ''), n(t.uncached), n(t.cached), n(t.out), known ? fmt.yuan(t.bgYuan) : '—']);
    return h('div', null, h('div', { class: 'set-tblw' }, h('table', { class: 'set-tbl' },
      h('thead', null, h('tr', null, ['用途', '次数', '没命中缓存', '命中缓存', '输出', '约'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, rows.map((r, i) => h('tr', { class: i === rows.length - 1 && keys.length > 1 ? 'sum' : '' }, r.map((c) => h('td', null, c))))))),
      h('p', { class: 'fhint set-after' }, `次数和用量是 DSH 每次调用报回来的（单位 token）。${t.bgPeakYuan ? `其中高峰时段约 ${fmt.yuan(t.bgPeakYuan)}。` : ''}${t.failed ? `失败的调用 ${t.failed} 次（DSH 报了用量的照样算钱）。` : ''}`));
  }
  function limitsBlock(bud, bc, ro, setBudget) {
    const L = bud.limits ?? {};
    const t = bud.today ?? {};
    const meter = (name, used, cap, unit, fmtv = fmt.num) => h('div', { class: 'set-meterrow' },
      h('div', { class: 'set-meterhead' }, h('span', null, name), h('span', { class: 'muted num' }, cap === 'none' || cap == null ? `${fmtv(used ?? 0)} ${unit} · 不设上限` : `${fmtv(used ?? 0)} / ${fmtv(cap)} ${unit}`)),
      cap === 'none' || cap == null ? null : h('div', { class: 'set-meter' }, h('i', { style: { width: `${Math.min(100, Math.max(1, ((used ?? 0) / cap) * 100))}%` } })));
    const denied = (t.deniedBy ?? []).slice(0, 6);
    return h('div', null,
      meter('后台调用（不含发出前的检查）', t.calls, L.dailyCalls, '次'),
      meter('没命中缓存的输入', t.uncached, L.dailyUncachedTokens, 'token'),
      meter('输出', t.out, L.dailyOutputTokens, 'token'),
      meter('发出前的检查（单独留的）', t.review, L.egressReservePerDay, '次'),
      h('div', { class: 'set-gap-s' }, kv([
        ['一个群或私聊最多占', L.perSourceShare >= 1 ? '不单独限' : `一天输入上限的 ${fmt.pct(L.perSourceShare)}（防止刷屏的群把额度用完）`],
        ['后台最多是她聊天的', L.mainChatRatioCap == null ? '不设' : fmt.pct(L.mainChatRatioCap)],
        ['余额保护', L.balanceProtectDays > 0 ? `余额只够 ${L.balanceProtectDays} 天时，后台先停下，聊天照常` : '关着（余额被后台用完时她的聊天也会停）'],
        ['今天被挡下的', denied.length ? denied.map((x) => `${USE[x.use] ?? '其他'} ${x.n} 次（${DENY_WHY[x.why] ?? x.why}）`).join('；') : '没有'],
      ])),
      h('p', { class: 'fhint set-after' }, '到了上限会怎样：整理、读懂问题、看图片先停，新话照常存着，零点后接着做；说话前的细看停了时，拿不准的那几条先不给她；发出前检查的预留用完时，公开场合要送检的那句先不发。'),
      h('div', { class: 'set-acts' }, btn('自定义每一项…', { size: 'sm', disabled: ro || !bc, onclick: () => customBudget(bc, setBudget) })));
  }
  function memoryRoom(bc) {
    const m = bc?.memory ?? {};
    const line = (x) => (x ? `想起来最多 ${x.recalled} 条（被问到时 ${x.recalledDeliberate} 条），她在聊的事最多 ${x.working} 行，被问到以前的事时最多约 ${fmt.num(x.recollectAuto)} 字（她自己翻记忆时约 ${fmt.num(x.recollectTool)} 字）` : '—');
    return h('div', null, kv(['saving', 'loose', 'unlimited'].map((k) => [PRESET[k], line(m[k])]).concat(bc?.custom && bc.memoryEffective ? [['现在（自定义）', line(bc.memoryEffective)]] : [])),
      h('p', { class: 'fhint set-after' }, '这些是上限，不是每轮都给满。每条记忆都尽量完整地给，不截半句；给得越多，她的对话长得越快、压缩得越早。'));
  }
  function accuracy(bud, t) {
    const p = bud.prices;
    const hrs = (p?.peakHours ?? []).map(([a, b]) => `${a}–${b}`).join('、');
    return h('ul', { class: 'set-ul fhint' },
      h('li', null, '次数和用量是准的：DSH 每次调用报回来的；没报的按字数估，会标出来。'),
      t.priceKnown && p ? h('li', null, `金额是按价目估算的：命中缓存 ${p.hit} 元、没命中 ${p.miss} 元、输出 ${p.out} 元（每百万 token）；工作日 ${hrs || '—'} 点算高峰 ×${p.peakFactor}（北京时间）。法定节假日 DeepSeek 全天按空闲价，这里不认节假日，会略高估。以 DeepSeek 账单为准。`)
        : h('li', null, '现在用的不是内置价目认识的模型（只认 DeepSeek 的 deepseek-flash），所以只记次数和用量，不显示钱；按次数、按用量的上限照常管。'),
      h('li', null, bud.embedding && !bud.embedding.local ? '想起来的方式接的是外部服务：那边要是收费，这里不算。' : '想起来的方式在本机算，不花钱。'),
      h('li', null, '她回你的话是 DSH 自己的对话，花费不在这里；这里只算如故自己在后台调的模型。'));
  }
  /** 「自定义每一项」（D121）：选一档做基础，改的项存成 overrides。 */
  const FIELDS = {
    dailyCalls: ['每天后台调用次数', '次', 'int'], dailyUncachedTokens: ['每天没命中缓存的输入', '万 token', 'wan'], dailyOutputTokens: ['每天的输出', '万 token', 'wan'],
    perSourceShare: ['一个群或私聊最多占', '%', 'pct'], mainChatRatioCap: ['后台最多是她聊天的', '%', 'pct'], balanceProtectDays: ['余额保护：余额只够几天时停后台', '天（0 = 关）', 'int'],
    stage2Scope: ['说话前的细看', [['all', '所有拿不准的'], ['direct', '只在对她说时']]], prefetchRewrite: ['先读懂问题再想', [[true, '开'], [false, '关']]], rerank: ['想起来以后再排一次序', [[true, '开'], [false, '关']]],
    sleepDepth: ['夜里整理', [['full', '完整'], ['essential', '只做必要的']]], injectShare: ['放进对话的记忆最多占对话增长的', '%', 'pct'], injectPerSessionPerDay: ['每个对话每天放进去的记忆', '字', 'int'], room: ['记忆给多少', '倍', 'dec'],
  };
  function customBudget(bc, setBudget) {
    let base = bc.preset;
    const vals = { ...bc.effective };
    const rowsBox = h('div', { class: 'set-custom' });
    const toInput = (k, v) => { const f = FIELDS[k]; if (v == null) return ''; return f[2] === 'wan' ? String(Math.round((v / 10000) * 10) / 10) : f[2] === 'pct' ? String(Math.round(v * 1000) / 10) : String(v); };
    const fromInput = (k, s) => { const f = FIELDS[k]; const n = Number(s); if (s === '' || !Number.isFinite(n)) return undefined; return f[2] === 'wan' ? Math.round(n * 10000) : f[2] === 'pct' ? n / 100 : f[2] === 'dec' ? n : Math.round(n); };
    const inputs = {};
    const draw = () => {
      R.clear(rowsBox, (bc.keys ?? Object.keys(FIELDS)).filter((k) => FIELDS[k]).map((k) => {
        const f = FIELDS[k];
        const presetV = bc.presets[base]?.[k];
        let ctl;
        if (Array.isArray(f[1])) {
          ctl = seg(f[1].map(([v, t]) => [String(v), t]), String(vals[k]), (v) => { vals[k] = v === 'true' ? true : v === 'false' ? false : v; }, f[0]);
        } else {
          const nullable = ['cap', 'ratio'].includes(bc.ranges?.[k]?.kind);
          const inp = h('input', { class: 'input set-num', inputmode: 'decimal', value: toInput(k, vals[k]), disabled: vals[k] === null, 'aria-label': f[0] });
          inputs[k] = inp;
          const none = nullable ? h('label', { class: 'cbox set-none' }, h('input', { type: 'checkbox', checked: vals[k] === null, onchange: (e) => { vals[k] = e.target.checked ? null : (presetV ?? bc.presets.loose?.[k] ?? bc.ranges[k].min); inp.disabled = e.target.checked; inp.value = toInput(k, vals[k]); } }), h('span', null, '不设')) : null;
          ctl = h('div', { class: 'set-inline' }, inp, h('span', { class: 'muted' }, f[1]), none);
        }
        const same = JSON.stringify(vals[k]) === JSON.stringify(presetV);
        return frow({ title: f[0], hint: same ? `和「${PRESET[base]}」一样` : `「${PRESET[base]}」是 ${presetV == null ? '不设' : Array.isArray(f[1]) ? f[1].find(([v]) => v === presetV)?.[1] : `${toInput(k, presetV)} ${f[1]}`}`, control: ctl });
      }));
    };
    const baseSeg = seg([['saving', '节省'], ['loose', '平衡'], ['unlimited', '效果优先']], base, (v) => { base = v; Object.assign(vals, bc.presets[v]); draw(); }, '以哪一档为基础');
    draw();
    const err = h('div', { class: 'err', role: 'alert', hidden: true });
    const layer = R.dialog({ title: '自定义每一项',
      body: [h('p', null, '从一档开始，改你想改的；和那一档一样的项不存。改了马上生效。'), frow({ title: '以哪一档为基础', control: baseSeg, stack: true }), h('div', { class: 'form' }, rowsBox), err],
      actions: [btn('取消', { onclick: () => layer.close() }), btn('保存', { kind: 'primary', onclick: () => {
        const overrides = {};
        const bad = [];
        for (const k of Object.keys(FIELDS)) {
          if (!(bc.keys ?? Object.keys(FIELDS)).includes(k)) continue;
          let v = vals[k];
          if (inputs[k] && vals[k] !== null) { v = fromInput(k, inputs[k].value.trim()); if (v === undefined) { bad.push(FIELDS[k][0]); continue; } }
          if (JSON.stringify(v) !== JSON.stringify(bc.presets[base]?.[k])) overrides[k] = v;
        }
        if (bad.length) { err.hidden = false; R.clear(err, `这几项要填数字：${bad.join('、')}`); return; }
        layer.close(); setBudget(base, overrides);
      } })] });
    layer.box.classList.add('set-wide');
  }

  // ════════════════════════════════════════════════════════════════════
  // 备份
  // ════════════════════════════════════════════════════════════════════
  async function backup(box, ctx) {
    const d = await R.api.get('backups');
    const ro = ctx.readOnly;
    const o = d.overview && !d.overview.error ? d.overview : null;
    const packs = d.packs && !d.packs.error ? d.packs.items ?? [] : [];
    let filter = '';
    let showAll = false;
    const listBox = h('div', { class: 'set-packs' });
    const kinds = [...new Set(packs.map((b) => b.kind))];
    const drawList = () => {
      const xs = packs.filter((b) => !filter || b.kind === filter);
      const shown = showAll ? xs : xs.slice(0, 8);
      R.clear(listBox, xs.length ? list(shown.map((b) => packRow(b, ctx, ro))) : R.empty({ ic: 'archive', title: '还没有备份', text: '每天夜里 04:30 会自动备份一次。现在也可以手动备一份。' }),
        xs.length > 8 ? h('div', { class: 'set-acts' }, btn(showAll ? '只看最近 8 份' : `显示全部 ${xs.length} 份`, { size: 'sm', kind: 'ghost', onclick: () => { showAll = !showAll; drawList(); } })) : null);
    };
    drawList();
    const nowBtn = btn('立即备份', { kind: 'primary', disabled: ro, onclick: async () => {
      R.clear(nowBtn, h('span', { class: 'spin' }), '正在备份…'); nowBtn.disabled = true;
      try { const r = await R.api.act('backup.now'); ok(`做好了 ${r.packs?.length ?? 0} 份，都验证过了`); ctx.reload(); } catch (e) { fail(e); R.clear(nowBtn, '立即备份'); nowBtn.disabled = false; }
    } });
    const failed = packs.filter((b) => b.verifyStatus === 'failed');
    const headLine = o ? `上次备份 ${o.last ? fmt.when(o.last.at) : '还没有'}` : '备份的状态读不出来';
    const hint = o ? [o.lastOk ? `最近一份验证过的：${fmt.when(o.lastOk)}` : '还没有验证过的', o.totalBytes ? `占用 ${bytes(o.totalBytes)}` : null, o.diskFreeGb != null ? `盘里还剩 ${o.diskFreeGb} GB` : null].filter(Boolean).join(' · ') : R.errorText({ code: d.overview?.error });
    const kindSeg = kinds.length > 1 ? seg([['', '全部'], ...kinds.map((k) => [k, PACK_KIND[k] ?? k])], filter, (v) => { filter = v; showAll = false; drawList(); }, '备份的种类') : null;
    R.clear(box,
      h('div', { class: 'set-status' }, h('div', { class: 'ftext' }, h('div', { class: 'ftitle' }, headLine), h('div', { class: 'fhint' }, hint)), nowBtn),
      o?.lowDisk ? h('div', { class: 'set-gap-s' }, note('bad', `备份所在的盘快满了${o.diskFreeGb != null ? `（还剩 ${o.diskFreeGb} GB）` : ''}：清一清，或者在下面设一个异地目录。`)) : null,
      failed.length ? h('div', { class: 'set-gap-s' }, note('warn', `有 ${failed.length} 份备份没通过验证（${failed.slice(0, 2).map((b) => `${fmt.day(b.createdAt)} 的${PACK_KIND[b.kind] ?? ''}`).join('、')}）。新的备份正常的话一般不用管；连着几天都这样再来看。`)) : null,
      o?.gaps?.length ? h('div', { class: 'set-gap-s' }, note('warn', `恢复后有 ${o.gaps.length} 段经历补不回来。遇到相关的话题时，她会像人记不清一样说「好像有点印象」。`)) : null,
      ro ? h('div', { class: 'set-gap-s' }, note('info', '记忆库只读的时候，备份、恢复都先做不了。')) : null,
      section('备份包', d.packs?.total ? `${d.packs.total} 份` : null, kindSeg, h('div', { class: 'set-gap-s' }, listBox)),
      h('div', { class: 'set-more set-folds' },
        more('异地副本', offsiteBlock(d, o, ro, ctx)),
        more('加密和恢复码', encryptBlock(o, ro, ctx)),
        more('恢复演练', drillBlock(d.drills)),
        more('导出', exportBlock(d, o, ro)),
        more('换了电脑 · 重新扫描', h('div', null, h('p', { class: 'fhint' }, '把旧电脑的备份目录（或异地目录）拷到这台电脑的备份目录里，点「重新扫描」，再从上面的列表里整体恢复。加密的包要输入当初抄下的恢复码。'),
          h('div', { class: 'set-acts' }, btn('重新扫描', { size: 'sm', ic: 'refresh', onclick: async () => { try { const r = await R.api.act('backup.rescan'); ok(`找到 ${r.found} 份`); ctx.reload(); } catch (e) { fail(e); } } }))))));
  }
  const bytes = (n) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  function packRow(b, ctx, ro) {
    const bad = b.verifyStatus === 'failed';
    const st = bad ? status('验证没通过', 'bad') : b.verifyStatus === 'ok' ? status('验证过', 'ok') : status('待验证', 'dim');
    const items = () => [
      { label: '验证', ic: 'checkc', disabled: ro, onSelect: () => verify(b, ctx) },
      { label: '部分恢复…', ic: 'undo', disabled: ro || bad, onSelect: () => partialRestore(b, ctx) },
      { sep: true },
      { label: '整体恢复…', ic: 'undo', danger: true, disabled: ro || bad, onSelect: () => fullRestore(b, ctx) },
      bad ? { hint: '没通过验证的包不能拿来恢复。' } : null,
    ].filter(Boolean);
    return row({ lead: h('span', { class: 'lead sm' }, icon(b.encrypted ? 'lock' : 'archive', 16)), title: `${PACK_KIND[b.kind] ?? b.kind} · ${fmt.when(b.createdAt)}`, strong: true,
      cls: bad ? 'set-bad' : '', meta: metaLine(b.location === 'offsite' ? '异地' : '本机', bytes(b.size), b.encrypted ? '加密' : null, b.reason ? PREOP[String(b.reason).replace(/-v\d+$/, '')] ?? null : null, bad ? '这份不能拿来恢复' : null),
      trail: [st, R.moreButton(items, '这份备份的操作')] });
  }
  async function verify(b, ctx) {
    try { const r = await R.api.act('backup.verify', { id: b.id }); if (r.ok) ok('验证通过'); else R.toast(`验证不过：${(r.errors ?? []).join('；') || '原因不明'}`, { tone: 'bad' }); ctx.reload(); } catch (e) { fail(e); }
  }
  function askCode() {
    return new Promise((resolve) => {
      const input = h('input', { class: 'input mono', placeholder: '本机有备份密钥的话可以留空', autocomplete: 'off', spellcheck: 'false' });
      let v = null;
      const layer = R.dialog({ title: '这份包是加密的', body: [h('p', null, '本机有备份密钥时可以直接继续；换了电脑或密钥丢了，就输入当初抄下的恢复码。'), h('div', { class: 'field' }, h('label', null, '恢复码'), input)],
        actions: [btn('取消', { onclick: () => layer.close() }), btn('继续', { kind: 'primary', onclick: () => { v = input.value.trim(); layer.close(); } })], initial: () => input, onClose: () => resolve(v) });
    });
  }
  const DIFF = { percepts: '原话', episodes: '经历', assertions: '事实', entities: '人和物', intentions: '打算' };
  async function fullRestore(b, ctx) {
    let code = '';
    if (b.encrypted) { code = await askCode(); if (code === null) return; }
    try {
      const r = await R.api.confirmed('backup.restore', { id: b.id, ...(code ? { recoveryCode: code } : {}) }, { title: `整体恢复到 ${fmt.when(b.createdAt)}`, okText: '整体恢复',
        render: (pv) => {
          const lost = Object.entries(pv?.diff ?? {}).map(([k, x]) => (x && typeof x === 'object' && x.extra > 0 ? `${x.extra} 条${DIFF[k] ?? k}` : null)).filter(Boolean);
          return h('div', null,
            h('p', null, `现在的记忆会换成这份备份里的样子${lost.length ? `：之后记下的 ${lost.join('、')}会没有` : '：之后记下的会没有'}。恢复前会先给现在的记忆做一份快照，恢复本身也能撤销；快照之后的经历会从各入口补回来。`),
            pv?.newMachine ? h('p', null, '看起来是在新电脑上恢复。') : null,
            pv?.tombstonesToReapply ? h('p', null, `你删过、忘掉过的 ${pv.tombstonesToReapply} 条会再删一遍。`) : null,
            pv?.gaps?.length ? h('p', null, `有 ${pv.gaps.length} 段经历补不回来。`) : null);
        },
        details: (pv) => [`包：${PACK_KIND[pv?.pack?.kind] ?? ''} ${pv?.pack?.name ?? ''}`, ...Object.entries(pv?.diff ?? {}).map(([k, x]) => (typeof x === 'object' ? `${DIFF[k] ?? k}：包里 ${x.pack ?? '—'}，现在 ${x.current ?? '—'}` : `${DIFF[k] ?? k}：${x}`)), ...(pv?.warnings ?? [])].join('\n') });
      if (r) { ok(r.gaps?.length ? `恢复完成；有 ${r.gaps.length} 段补不回来` : '恢复完成'); ctx.reload(); }
    } catch (e) { fail(e); }
  }
  async function partialRestore(b, ctx) {
    const people = h('div', { class: 'set-checks' }, R.loading('读人和场合…'));
    let pick = { pickable: [], settings: {} };
    try { const v = await R.api.get('backups'); pick = { pickable: v.pickable ?? [], settings: {} }; } catch { /* 选不了人就只能按日期 */ }
    const chosen = new Set();
    R.clear(people, pick.pickable.length ? pick.pickable.filter((p) => p.kind === 'person').slice(0, 60).map((p) => {
      const c = h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); } });
      return h('label', { class: 'cbox' }, c, h('span', null, p.isSelf ? '她自己' : p.name));
    }) : h('p', { class: 'fhint' }, '还没有认识的人。'));
    const date = h('input', { class: 'input', type: 'date', 'aria-label': '只取这一天以前的' });
    let layer;
    const next = btn('下一步', { kind: 'primary', onclick: async () => {
      const entityIds = pick.pickable.filter((p) => chosen.has(p.id)).flatMap((p) => p.members ?? [p.id]);
      const before = date.value ? new Date(`${date.value}T00:00:00`).getTime() : null;
      if (!entityIds.length && !before) { R.toast('至少选一个人，或者一个日期'); return; }
      layer.close();
      let code = '';
      if (b.encrypted) { code = await askCode(); if (code === null) return; }
      try {
        const r = await R.api.confirmed('backup.restorePartial', { id: b.id, selector: { ...(entityIds.length ? { entityIds } : {}), ...(before ? { before } : {}) }, ...(code ? { recoveryCode: code } : {}) },
          { title: '部分恢复', okText: '取回', danger: false, consequence: '从这份包里取回选中的部分，合并进现在的记忆，不覆盖别的；对不上的地方按对账的规矩合。' });
        if (r) { ok(`已取回：新增 ${r.report?.created ?? 0}，合并 ${r.report?.merged ?? 0}`); ctx.reload(); }
      } catch (e) { fail(e); }
    } });
    layer = R.dialog({ title: '部分恢复', body: [h('p', null, `从 ${fmt.when(b.createdAt)} 的${PACK_KIND[b.kind] ?? '包'}里取回一部分，比如误删的某个人，或者被人慢慢灌输之前的看法。`),
      h('div', { class: 'field' }, h('label', null, '关于这些人的'), people), h('div', { class: 'field' }, h('label', null, '只取这一天以前的版本（可以不填）'), date)],
    actions: [btn('取消', { onclick: () => layer.close() }), next] });
    layer.box.classList.add('set-wide');
  }
  function offsiteBlock(d, o, ro, ctx) {
    const input = h('input', { class: 'input mono', value: d.offsiteDir ?? '', placeholder: '例如另一块硬盘上的一个文件夹，或者同步盘里的一个文件夹', spellcheck: 'false', disabled: ro, 'aria-label': '异地目录' });
    return h('div', null, h('p', { class: 'fhint' }, '本机只有一份的话，这块硬盘坏了就全丢了。设一个别的盘上的目录，每份日包、周包、月包都会加密后另存一份过去。'),
      h('div', { class: 'set-inline set-gap-s' }, input, btn('保存', { size: 'sm', disabled: ro, onclick: async () => {
        try { const r = await R.api.act('backup.offsite', { dir: input.value.trim() }); toastWarn(r); ok(input.value.trim() ? '已保存' : '已取消异地副本'); ctx.reload(); } catch (e) { fail(e); }
      } })),
      o?.offsite?.configured && !o.offsite.encrypted ? h('p', { class: 'fhint' }, '还没设恢复码：异地的包要先设恢复码才会加密。') : null);
  }
  function encryptBlock(o, ro, ctx) {
    const on = !!o?.offsite?.encrypted;
    return h('div', null, h('div', { class: 'form' }, frow({ title: on ? '备份加密开着' : '还没设恢复码', right: true, hint: '换电脑、本机的密钥丢了时，只能靠恢复码解开异地的包。恢复码只显示一次，请抄在电脑以外的地方。',
      control: btn(on ? '换一个…' : '设恢复码…', { size: 'sm', kind: on ? 'secondary' : 'primary', disabled: ro, onclick: async () => {
        try {
          const r = await R.api.confirmed('backup.encryption', {}, { title: on ? '换一个恢复码' : '设恢复码', okText: '生成恢复码', danger: false,
            render: (pv) => h('div', null, h('p', null, pv?.replacing ? '会生成一个新的恢复码，之后的异地包用它加密；旧的那把留在本机，已有的异地包照样能解开。' : '会生成一个恢复码，之后的异地副本都用它加密。'), h('p', null, '恢复码只显示这一次。')) });
          if (r) showCode(r, ctx);
        } catch (e) { fail(e); }
      } }) })));
  }
  function showCode(r, ctx) {
    const done = btn('我已经抄下来了', { kind: 'primary', disabled: true });
    const ck = h('input', { type: 'checkbox', onchange: (e) => { done.disabled = !e.target.checked; } });
    const layer = R.dialog({ title: '你的恢复码', dismissible: false,
      body: [h('div', { class: 'item mono set-code' }, r.recoveryCode ?? '（没有拿到恢复码）'), h('p', null, '这是唯一一次显示。关掉这个框以后，插件里任何地方都找不到它了。'),
        h('div', { class: 'set-acts' }, btn('复制', { size: 'sm', ic: 'file', onclick: () => copyText(r.recoveryCode ?? '') })), h('label', { class: 'cbox' }, ck, h('span', null, '我已经把恢复码存在电脑以外的地方'))],
      actions: [done] });
    done.addEventListener('click', () => { layer.close(); ctx.reload(); });
  }
  const DRILL_ERR = { FTS_MISSING: '全文索引缺了', VERIFY_FAILED: '包验证不过', SAMPLE_MISS: '有记忆没找回来', RESTORE_FAILED: '恢复的时候出错了', NO_PACK: '没有可以演练的包' };
  function drillBlock(dr) {
    if (!dr || dr.error) return h('p', { class: 'fhint' }, R.errorText({ code: dr?.error }, 'read'));
    const xs = dr.items ?? [];
    return h('div', null, h('p', { class: 'fhint' }, '每周把最新的包整个恢复到临时目录，抽 20 条记忆找一遍。没恢复过的备份不算真的有备份。'),
      xs.length ? list(xs.slice(0, 5).map((x) => row({ title: fmt.when(x.at), meta: metaLine(`找回 ${x.found ?? 0} / ${x.sampled ?? 0}`, x.error ? (DRILL_ERR[x.error] ?? `出错了（${x.error}）`) : null), trail: status(x.ok ? '通过' : '没通过', x.ok ? 'ok' : 'bad') })))
        : h('p', { class: 'fhint' }, '还没演练过：做周包时会自动演练。'));
  }
  function exportBlock(d, o, ro) {
    const enc = h('input', { type: 'checkbox', disabled: !o?.offsite?.encrypted });
    const result = h('div');
    return h('div', null, h('p', { class: 'fhint' }, '一个人能读懂的 JSONL 文件：人、事实（含旧版本）、经历、打算、规矩、原文片段、她自己。不依赖数据库的结构和想起来的方式，以后插件大改版也能导回来。'),
      h('label', { class: 'cbox set-gap-s' }, enc, h('span', null, o?.offsite?.encrypted ? '用恢复码加密' : '用恢复码加密（先在「加密和恢复码」里设恢复码）')),
      h('div', { class: 'set-acts' }, btn('导出', { size: 'sm', ic: 'download', disabled: !d.exportReady || ro, title: d.exportReady ? null : '没有配置导出目录', onclick: async () => {
        try {
          const r = await R.api.act('backup.export', { encrypt: enc.checked });
          R.clear(result, h('div', { class: 'set-inline set-gap-s' }, status('已导出', 'ok'), mono(r.name), h('span', { class: 'muted' }, `${Object.values(r.counts ?? {}).reduce((a, n) => a + n, 0)} 行`), btn('下载', { size: 'sm', onclick: () => download(r.name) })));
        } catch (e) { fail(e); }
      } })), result);
  }
  /** 下载导出的文件（带管理页令牌；同源）。 */
  async function download(name) {
    try {
      const token = document.querySelector('meta[name="pm-admin-token"]')?.getAttribute('content') ?? '';
      const r = await fetch(`admin.export?name=${encodeURIComponent(name)}`, { credentials: 'same-origin', headers: { 'x-pm-admin': token } });
      if (!r.ok) throw new R.ApiError(r.status, { code: 'HTTP', error: `下载失败（HTTP ${r.status}）` });
      const url = URL.createObjectURL(await r.blob());
      const a = h('a', { href: url, download: name, hidden: true });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { fail(e); }
  }
  /** 复制一段文字：先用剪贴板接口；不让用（iframe 里常见）就弹一个框让人自己选中复制。 */
  async function copyText(text, okText = '已复制') {
    try { await navigator.clipboard.writeText(text); ok(okText); return; } catch { /* 下面兜底 */ }
    const ta = h('textarea', { class: 'textarea mono set-copyarea', readonly: true, rows: 10 });
    ta.value = text;
    const layer = R.dialog({ title: '复制下面这段', body: [h('p', null, '这里不让直接写剪贴板：全选以后按 Ctrl+C 复制。'), ta], actions: [btn('好了', { kind: 'primary', onclick: () => layer.close() })], initial: () => ta });
    ta.select();
  }

  // ════════════════════════════════════════════════════════════════════
  // 诊断
  // ════════════════════════════════════════════════════════════════════
  async function diag(box, ctx) {
    const [d, dg] = await Promise.all([R.api.get('setDiag'), R.api.get('diagnostics').catch((e) => ({ error: e }))]);
    const STI = { bad: ['alert', 'bad'], warn: ['warn', 'warn'], ok: ['checkc', 'ok'], dim: ['info', ''] };
    const items = d.checkup ?? [];
    const problems = items.filter((x) => x.state === 'bad' || x.state === 'warn');
    const fine = items.filter((x) => !(x.state === 'bad' || x.state === 'warn'));
    const itemRow = (x) => {
      const [ic, tone] = STI[x.state] ?? STI.dim;
      const times = x.heardAt !== undefined ? [x.heardAt ? `最近收到消息 ${fmt.when(x.heardAt)}` : null, x.injectedAt ? `最近把记忆放进对话 ${fmt.when(x.injectedAt)}` : x.heardAt ? '还没放进过记忆' : null] : [];
      return row({ lead: h('span', { class: `lead sm ${tone}` }, icon(ic, 16)), title: x.title, strong: x.state === 'bad' || x.state === 'warn', clamp: false,
        meta: x.text || times.some(Boolean) ? metaLine(x.text, ...times) : null,
        trail: x.fix ? btn(x.fix.label, { size: 'sm', kind: x.state === 'bad' ? 'primary' : 'secondary', onclick: () => goFix(x.fix.to) }) : null });
    };
    const devMore = more('开发者明细（只有数字，没有记忆内容）', devDetails(dg, d));
    if (ctx.route.params?.dev === '1') devMore.open = true;
    const evalBox = evalSection(dg, ctx);
    R.clear(box,
      section('自查', d.selfCheckAt ? `启动自检 ${fmt.ago(d.selfCheckAt)}` : null,
        h('p', { class: 'sdesc' }, '每一项一句结论；有问题的，按右边的按钮去修。'),
        problems.length ? list(problems.map(itemRow)) : h('p', { class: 'set-allok' }, icon('checkc', 16), '没发现问题。'),
        fine.length ? h('div', { class: 'set-gap-s' }, more(`其余 ${fine.length} 项`, list(fine.map(itemRow)))) : null,
        h('div', { class: 'set-acts set-gap-s' },
          btn('重新检查', { size: 'sm', ic: 'refresh', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await R.api.act('selfcheck.run'); ok('检查完了'); ctx.reload(); } catch (err) { fail(err); b.disabled = false; } } }),
          btn('复制诊断信息', { size: 'sm', ic: 'file', onclick: () => copyText(JSON.stringify(d.summary, null, 2), '已复制（不含任何聊天内容）') })),
        h('p', { class: 'fhint' }, '「复制诊断信息」复制的是版本、上面每一项的结论、后台模型的状态和几个计数，不含聊天内容、名字、群名、账号和路径。提 Issue 时贴上它。')),
      evalBox,
      h('div', { class: 'set-more' }, devMore));
    function goFix(to) {
      if (to === 'wizard') { R.go('wizard'); return; }
      const [p, q] = to.split('?');
      const params = Object.fromEntries(new URLSearchParams(q ?? ''));
      if (p === 'settings/diag') { devMore.open = true; devMore.scrollIntoView({ block: 'start', behavior: R.reduceMotion() ? 'auto' : 'smooth' }); return; }
      R.go(p, { params });
    }
  }
  function evalSection(dg, ctx) {
    const ev = dg && !dg.error ? dg.memoryEval : null;
    const canRun = dg && !dg.error && dg.memoryEvalCanRun;
    const run = btn(ev ? '再跑一次' : '跑一次', { size: 'sm', disabled: !canRun || ctx.readOnly, onclick: async () => {
      R.clear(run, h('span', { class: 'spin' }), '在跑…'); run.disabled = true;
      try { const r = await R.api.act('eval.run'); ok(`跑完了：有记忆时 ${r.on}/${r.total} 个想起来了`); ctx.reload(); } catch (e) { fail(e); R.clear(run, '再跑一次'); run.disabled = false; }
    } });
    let line;
    if (!ev || ev.error) line = h('p', null, '还没跑过。');
    else {
      const all = ev.on === ev.total && ev.guardsHeld === ev.guards;
      line = h('p', { class: 'set-evalline' }, all ? `都对：有记忆时 ${ev.total} 个都想起来了（没记忆时只对 ${ev.off} 个），该守住的 ${ev.guards} 个都守住了。`
        : `有记忆时 ${ev.on}/${ev.total} 个想起来了（没记忆时 ${ev.off} 个），该守住的守住了 ${ev.guardsHeld}/${ev.guards} 个。`);
    }
    return section('她想不想得起来', ev?.at ? `上次 ${fmt.ago(ev.at)}` : null,
      h('p', { class: 'sdesc' }, '拿几种典型情况（改写过的、没有真名和群名的）在临时库里回放一遍：有记忆时拿不拿得到关键内容，该守住的守没守住。不调模型、不花钱，几秒钟。'),
      line,
      ev?.cases?.length ? more('每个用例', list(ev.cases.map((c) => row({ title: c.name, clamp: false, meta: metaLine(c.on === true ? '有记忆时想起来了' : c.on === false ? '有记忆时没想起来' : null, c.off === true ? '没记忆时也答对了' : null, typeof c.guard === 'boolean' ? (c.guard ? '守住了' : '没守住') : null) })))) : null,
      h('div', { class: 'set-acts set-gap-s' }, run));
  }
  const DEGRADE = ['完整', '不重新排序', '在 CPU 上算', '不按「意思」找', '存储出错'];
  const HOOK = { 'agent/pre-step': '回话前（放记忆）', 'tools/pre-execute': '工具执行前（发出前的检查）', 'tools/post-execute': '工具执行后（记下结果）', 'session/event': '对话事件', 'agent/created': '新对话',
    'compaction/start': '压缩开始', 'compaction/end': '压缩结束', 'systemPrompt.context': '常驻的记忆块' };
  const SLEEP_STEP = { 'seal-review': '复核', replay: '对照原话改正', generalize: '归纳', reflect: '反思', entities: '印象', time: '回头问问', settings: '故事线和圈子', self: '日记和性格', lessons: '回顾经验' };
  function devDetails(dg, d) {
    if (!dg || dg.error) return R.errorBox(dg?.error ?? {}, null, { title: '开发者明细读不出来' });
    const grp = (title, pairs, extra) => h('div', { class: 'set-devgrp' }, h('h3', null, title), pairs ? kv(pairs.filter(Boolean)) : null, extra);
    const s = dg.store && !dg.store.error ? dg.store : {};
    const e = dg.embedding && !dg.embedding.error ? dg.embedding : {};
    const x = dg.host && !dg.host.error ? dg.host : {};
    const sc = dg.selfCheck && !dg.selfCheck.error ? dg.selfCheck : null;
    const deg = Array.isArray(dg.degrade) ? dg.degrade : null;
    const degTotal = deg ? deg.reduce((a, n) => a + n, 0) : 0;
    const rc = dg.recall && !dg.recall.error ? dg.recall : null;
    const t = rc?.days?.[0] ?? null;
    const sl = s.sleep;
    const ex = s.extract;
    const L = d.logRetention ?? {};
    const scList = sc ? list(sc.items.map((c) => row({ lead: h('span', { class: `lead sm ${c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : ''}` }, icon(c.status === 'fail' ? 'alert' : c.status === 'warn' ? 'warn' : c.status === 'ok' ? 'checkc' : 'info', 14)),
      title: c.label, clamp: false, meta: metaLine(c.detail, c.status === 'fail' && c.disables ? `关掉了：${c.disables}` : null) }))) : h('p', { class: 'fhint' }, dg.selfCheck?.error === 'UNAVAILABLE' ? '宿主没提供自检。' : '自检没跑成。');
    return h('div', { class: 'set-dev' },
      h('div', { class: 'set-devgrp set-devwide' }, h('h3', null, `启动自检${sc?.at ? ` · ${fmt.when(sc.at)}` : ''}`), scList),
      h('div', { class: 'set-devgrid' },
        grp('记忆库', [['状态', s.readOnly ? `只读（${s.readOnlyReason ?? '原因不明'}）` : '能写'], ['数据版本', s.schemaVersion != null ? `v${s.schemaVersion}${s.codeSchemaVersion !== s.schemaVersion ? `（插件 v${s.codeSchemaVersion}）` : ''}` : '—'],
          ['表结构', s.schema?.ok === false ? '对不上' : '一致'], ['在用的入口', (s.adapters ?? []).join('、') || '—'],
          ['启动', s.startup ? (() => { const bad = Object.entries(s.startup).filter(([, v]) => v && typeof v === 'object' && v.error); return bad.length ? `${bad.length} 步失败：${bad.map(([k]) => k).join('、')}` : `${Object.keys(s.startup).length} 步都正常`; })() : '—'],
          ['整理一直不成', ex?.segments ? `${ex.segments} 段（一时出错 ${ex.transient ?? 0}、一直被拒 ${ex.rejected ?? 0}）${ex.nextAt ? `，下次 ${fmt.when(ex.nextAt)}` : ''}` : '没有']]),
        grp('夜里整理', sl ? [['上次', fmt.when(sl.at)], ['模型调用', `${sl.llmCalls ?? 0} / ${sl.llmMax ?? '—'}`], ['到上限少做的', (sl.capped ?? []).map((k) => SLEEP_STEP[k] ?? k).join('、') || '没有'],
          sl.generalize ? ['归纳', `问了 ${sl.generalize.asked ?? 0} 组，写了 ${sl.generalize.written ?? 0} 条`] : null, sl.diary ? ['日记', `写了 ${sl.diary.written ?? 0} 天${sl.diary.pending ? `，还缺 ${sl.diary.pending} 天` : ''}`] : null] : [['上次', '还没跑过（每天 04:30）']]),
        grp('想起来', [['后台线程', e.mode === 'thread' ? '正常' : e.mode ? '退回主线程' : '—'], ['按「意思」找', e.dense ? '能用' : e.breakerOpen ? '连续失败，先停一会儿' : '用不了'], ['等着算', e.queue?.pending ?? '—'],
          ['要重算 / 失败', `${e.queue?.stale ?? 0} / ${e.queue?.failed ?? 0}`], e.shadow ? ['备用的算了', fmt.pct(e.shadow.coverage)] : null]),
        grp(`想起来的方式分布${degTotal ? `（${fmt.num(degTotal)} 次）` : ''}`, deg ? deg.map((n, i) => [DEGRADE[i], fmt.num(n)]) : [['—', '还没有数据']]),
        rc && t ? grp(`回想的稳定性（今天 ${t.recalls} 次）`, [['出错', `${t.errors} 处${Object.keys(t.byStage ?? {}).length ? `（${Object.entries(t.byStage).slice(0, 3).map(([k, n]) => `${k} ${n}`).join('、')}）` : ''}`],
          ['整轮什么都没给', t.lost], ['宿主等超时 / 报错', `${t.host?.timeout ?? 0} / ${t.host?.error ?? 0}`], ['因为额度没放进去', `${t.inject?.budgetDropped ?? 0} 条`],
          ...(rc.buckets ?? []).slice(0, 6).map((b) => [b.replace(/^le/, '≤ ').replace(/^gt/, '> ') + ' ms', t.ms?.[b] ?? 0])]) : null,
        grp('后台模型（这次启动以来）', x.llm ? [['调用 / 失败', `${x.llm.calls ?? 0} / ${x.llm.failures ?? 0}`], ['排队', `整理 ${x.llm.queued?.bg ?? 0} · 细看 ${x.llm.queued?.appraise ?? 0} · 检查 ${x.llm.queued?.review ?? 0}`],
          ['上次出错', errWord(x.llm.lastError) || '没有'], ...Object.entries(x.llm.byUse ?? {}).slice(0, 8).map(([k, n]) => [USE[k] ?? k, fmt.num(n)])] : [['—', '读不到']],
          h('div', { class: 'set-acts set-gap-s' }, btn('复制后台模型状态', { size: 'sm', ic: 'file', onclick: async () => { try { const r = await R.api.get('llmSetup'); copyText(JSON.stringify(r.summary, null, 2), '已复制（不含聊天内容、地址和 Key）'); } catch (er) { fail(er); } } }))),
        grp('想起来的服务', x.embedPort ? [['服务', x.embedPort.ok ? `正常${x.embedPort.version ? `（Ollama ${x.embedPort.version}）` : ''}` : errWord(x.embedPort.error) || '连不上'], ['模型', `${x.embedPort.model ?? '—'}${x.embedPort.modelPresent ? '' : '（不在）'}`],
          ['维数', x.embedPort.dim ?? '—'], ['请求 / 失败', `${x.embedPort.requests ?? 0} / ${x.embedPort.failures ?? 0}`], ['上次耗时', x.embedPort.lastMs != null ? `${x.embedPort.lastMs} ms` : '—']] : [['—', '读不到']]),
        grp('对话', [['认出是她的', x.claims?.claimed ?? '—'], ['不是她的', x.claims?.none ?? '—'], ['两个入口都说是自己的', x.claims?.conflicts ?? 0], ...Object.entries(x.claims?.byAdapter ?? {}).map(([k, n]) => [k, n]), ['在用记忆工具的', x.tools?.live ?? '—']]),
        grp('发出前的检查', x.egress ? [['检查过', x.egress.appraised ?? 0], ['说了 / 改口 / 先存着', `${x.egress.speak ?? 0} / ${x.egress.reconsider ?? 0} / ${x.egress.hold ?? 0}`], ['查不了照常发（非公开）', x.egress.failOpen ?? 0],
          ['查不了改口（公开）', x.egress.failClosed ?? 0], ['挡下桥接自带的记忆写入', x.egress.frozenDenied ?? 0], ['读过来路不明内容的回合', x.egress.tainted ?? 0]] : [['—', '读不到']]),
        grp('放进对话的记忆', x.context ? [['记忆块（放了 / 没放）', `${x.context.blocks ?? 0} / ${x.context.withheldBlocks ?? 0}`], ['字数', fmt.num(x.context.chars)], ['发出 / 中止', `${x.context.confirmed ?? 0} / ${x.context.aborted ?? 0}`],
          ['想起来超时 / 出错', `${x.context.recallTimeouts ?? 0} / ${x.context.recallErrors ?? 0}`], ['没经过细看就放进去的', x.context.unappraised ?? 0], ['当场记下的', fmt.num(x.context.observed)]] : [['—', '读不到']]),
        grp('钩子', null, x.hooks?.length ? h('div', { class: 'set-tblw' }, h('table', { class: 'set-tbl' }, h('thead', null, h('tr', null, ['', '调用', '出错', '慢', 'p95', '暂停中'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, x.hooks.map((k) => h('tr', null, [HOOK[k.name] ?? k.name, fmt.num(k.calls), k.errors ?? 0, k.slow ?? 0, k.p95Ms != null ? `${k.p95Ms} ms` : '—', k.openSessions ?? 0].map((c) => h('td', null, String(c)))))))) : h('p', { class: 'fhint' }, '读不到。')),
        grp('调度', x.scheduler ? [['状态', x.scheduler.running ? '在跑' : '停了'], ['上次维护', x.scheduler.lastTickAt ? `${fmt.ago(x.scheduler.lastTickAt)}（${x.scheduler.lastTickMs ?? '—'} ms）` : '—'],
          ['维护 / 出错', `${fmt.num(x.scheduler.ticks)} / ${x.scheduler.tickErrors ?? 0}`], ['后台任务 / 失败', `${fmt.num(x.scheduler.jobsRan)} / ${x.scheduler.jobsFailed ?? 0}`]] : [['—', '读不到']]),
        grp('日志表留多久', [['放进对话的记录', `${L.injectionsDays ?? '—'} 天`], ['后台任务', `${L.jobsDays ?? '—'} 天`], ['细看的结论', `${L.appraisalsDays ?? '—'} 天`], ['她说过的话', `${L.utterancesDays ?? '—'} 天`]]),
        grp(`最近的错误${x.logCounts ? `（警告 ${x.logCounts.warn ?? 0} · 错误 ${x.logCounts.error ?? 0}）` : ''}`, null, (x.recentErrors ?? []).length ? list(x.recentErrors.map((r) => row({ title: [mono(r.event ?? ''), r.error ? ` · ${errWord(r.error)}` : ''], clamp: false, meta: metaLine(fmt.when(r.at), r.level === 'error' ? '错误' : '警告') })))
          : h('p', { class: 'fhint' }, '没有（只记事件名和错误类型，没有内容）。'), (x.unclassifiedTools ?? []).length ? h('p', { class: 'fhint' }, `不知道是干什么的工具：${x.unclassifiedTools.map((u) => `${u.tool}（${u.count} 次）`).join('、')}`) : null)),
      h('p', { class: 'fhint' }, `读取于 ${fmt.when(dg.now)}。这里只有数字，没有任何记忆内容。`));
  }

  // ════════════════════════════════════════════════════════════════════
  // 关于
  // ════════════════════════════════════════════════════════════════════
  async function about(box) {
    const d = await R.api.get('setAbout');
    const pathRow = (label, p) => (p ? h('div', { class: 'set-path' }, h('span', { class: 'muted' }, label), mono(p), btn('', { size: 'sm', kind: 'ghost', ic: 'file', title: `复制${label}的路径`, onclick: () => copyText(p, '已复制路径') })) : null);
    const llmName = d.llm?.pair ? P.pairText(d.llm.pair) : '你在「模型」里选的那个';
    const embedLine = d.embedding?.provider === 'none' ? ['想起来的方式没开', '选的是「不用」：只按字面、人和事、时间找，什么都不发出去。']
      : d.embedding?.provider === 'openai-compat' ? ['想起来的方式用的是外部服务', `记忆的文字会发给 ${d.embedding.externalHost ?? '那个服务'} 算向量。`]
        : ['想起来的方式在本机算', '用本机的 Ollama，记忆的文字不出这台电脑。换成外部服务时才会发出去。'];
    const fact = (ic, title, text, extra) => h('div', { class: 'set-fact' }, icon(ic, 18), h('div', null, h('b', null, title), h('span', null, text), extra));
    R.clear(box, h('div', { class: 'set-about' },
      R.brandMark(72),
      h('h1', { tabindex: '-1', 'data-page-title': '' }, '如故'),
      h('div', { class: 'mono muted set-ver' }, d.version ? `v${d.version}` : '版本读不出来'),
      h('p', { class: 'set-lede' }, '让 DSH 里的她像一个真实存在的人：在 QQ、DSH 桌面和别的入口听到的、说过的，都进同一份记忆，回话前像人一样自己想起来，再判断在这里能不能说。'),
      h('div', { class: 'set-acts' }, d.links?.issues ? h('a', { class: 'btn btn-secondary', href: d.links.issues, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 16), '反馈问题') : null),
      h('p', { class: 'fhint' }, '检查更新：在 DSH 侧边栏的「插件」页里看有没有新版本、一键更新。'),
      section('数据在哪儿、会发给谁', null, h('div', { class: 'set-facts' },
        fact('archive', '记忆存在你自己的电脑上', '只有你能打开这个页面。', h('div', { class: 'set-paths' }, pathRow('数据目录', d.dataDir), pathRow('配置文件', d.configFile))),
        fact('cpu', '后台整理会把聊天片段发给模型的服务商', `为了把聊天整理成记忆，后台会把一段段聊天（包括群友说的话）发给你在「模型」里选的服务商（现在是 ${llmName}），花那个服务商的余额，有上限。`),
        fact(d.embedding?.provider === 'openai-compat' ? 'link' : 'lock', ...embedLine))),
      section('更多', null, h('div', { class: 'form' },
        frow({ title: '源代码', hint: '在 GitHub 上公开', right: true, control: d.links?.repo ? extLink('打开', d.links.repo) : null }),
        frow({ title: '文档', hint: '怎么装、怎么运作、花多少钱', right: true, control: d.links?.docs ? extLink('打开', d.links.docs) : null }),
        frow({ title: '许可', hint: `${d.license ?? 'MIT'}：能自由使用、修改和分发，保留版权声明就行`, right: true, control: d.links?.license ? extLink('查看', d.links.license) : null }),
        frow({ title: '卸载之前', hint: '卸载插件不会删你的记忆：数据目录和配置文件都还在（位置在上面）。想彻底删掉，卸载以后把那个数据目录和配置文件一起删掉；有异地副本的话那边也删。' }),
        frow({ title: '致谢', hint: 'DeepSeek Harness、Ollama、Qwen3 Embedding、dsh-qq，以及每一位帮忙试用的朋友。' })))));
  }

  return { render, leave };
});
