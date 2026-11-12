// 场合（D172）：三个分段——场合（一行一个场合、一个开关、展开的细项）· 规则（你定的「别记」「别说」）· 叮嘱（她在守的、可以解除）。
// 数据只来自一个视图 admin.data?view=places（packages/dsh/src/admin/views.js）。
// 一个开关（设计说明 8.3 第 3 条）：用现有的 setting.mode、setting.remember 两个动作组合，不加新动作（映射在 logic.planSwitch，测试直接调）：
//   开 = 模式开 + 记这里开；关 = 模式关。展开的细项里：跟着默认（去掉这个场合的覆盖）、只想起不记新的（模式开 + 记这里关）、改名、属性（只读）。
//   两个动作之间失败了一个：把已经做了的那一步退回去，重新读一遍显示真实的状态，并说清楚。
// 关掉一个场合：延迟提交，提示条写清后果并带「撤销」。新场合的默认（和你一对一 / 封闭的群 / 公开场合）在「设置 · 基本」里改，这里只读地显示。
// 样式在 places.css，类名带 plc- 前缀。
Rugu.define('places', (R) => {
  const { h, icon, fmt, btn } = R;

  // ════════════════════════════════════════════════════════════════════════
  // 纯函数（不碰 DOM）
  // ════════════════════════════════════════════════════════════════════════
  const clip = (s, n) => { const c = [...String(s ?? '')]; return c.length > n ? `${c.slice(0, n).join('')}…` : c.join(''); };
  const nameOf = (d, id) => (id == null ? null : d.names?.[id] ?? null);
  const placeOf = (d, key) => (key ? d.settings?.[key] ?? '某个场合' : null);

  /** 新场合按属性分的三类（核心 modeFor 的分法：任何人能看到或公开留存 → 公开场合；一对一 → 和你一对一；其余 → 封闭的群）。 */
  const CLASS = { principalOneOnOne: '和你一对一', closed: '封闭的群', public: '公开场合' };
  function classOf(p) {
    const a = p.audience ?? {};
    if (a.visibleTo === 'anyone' || a.persistence === 'public-permanent') return 'public';
    if (p.oneOnOne) return 'principalOneOnOne';
    return 'closed';
  }
  /** 这个场合跟着默认时是什么档（总开关关着时一律关）。 */
  function defaultMode(p, defaults) {
    if (defaults?.global === 'off') return 'off';
    return defaults?.byAttributes?.[classOf(p)] ?? 'live';
  }
  /**
   * 一个场合在页面上的样子：开关（on = 模式开）、跟着默认没有、只想起不记新的、一句状态。
   * 现在这两套控件的确切含义（views.js 的 settings、actions.js）：mode = 生效档（off / live），= min(总开关, 覆盖 ?? 按属性的默认)；
   * override = 这个场合的覆盖（rules.kind = 'mode'，off / live），没有 = 跟着默认；doNotRemember = 有一条指向它的「别记」规则（以后不记新的，已有的照样想得起来）。
   */
  function stateOf(p, defaults) {
    const on = p.mode === 'live';
    const masterOff = defaults?.global === 'off';
    const recallOnly = on && !!p.doNotRemember;
    const status = masterOff ? 'master' : !on ? 'off' : recallOnly ? 'recall' : 'on';
    const text = { master: '没在记 · 记忆总开关关着', off: p.doNotRemember ? '没在记 · 你说过别记这里' : '没在记', recall: '只想起、不记新的', on: '在记' }[status];
    return { on, follow: !p.override, recallOnly, status, text, cls: classOf(p), def: defaultMode(p, defaults) };
  }
  /** 一步动作和它的「退回去」。 */
  const step = (action, body, undo) => ({ action, body, undo });
  const modeBack = (p) => ({ settingKey: p.key, mode: p.override?.mode ?? 'default' });
  /**
   * 主开关 → 动作。开：模式开（setting.mode live），有「别记」的再把它去掉（setting.remember true）；关：模式关（setting.mode off）。
   * 每一步都带着退回去的那一步（模式退回原来的覆盖或「按默认」；记这里退回原样）。
   */
  function planSwitch(p, on) {
    if (!on) return [step('setting.mode', { settingKey: p.key, mode: 'off' }, modeBack(p))];
    const out = [step('setting.mode', { settingKey: p.key, mode: 'live' }, modeBack(p))];
    if (p.doNotRemember) out.push(step('setting.remember', { settingKey: p.key, remember: true }, { settingKey: p.key, remember: false }));
    return out;
  }
  /** 「跟着默认」：开 = 去掉覆盖（setting.mode default）；关 = 把现在生效的那一档定下来（setting.mode 现在的档）。 */
  function planFollow(p, follow) {
    return [step('setting.mode', { settingKey: p.key, mode: follow ? 'default' : p.mode === 'off' ? 'off' : 'live' }, modeBack(p))];
  }
  /** 「只想起，不记新的」：开 = 加「别记」（setting.remember false）；关 = 去掉（setting.remember true）。 */
  function planRecall(p, recallOnly) {
    return [step('setting.remember', { settingKey: p.key, remember: !recallOnly }, { settingKey: p.key, remember: !!recallOnly })];
  }
  /**
   * 一步一步做；第 i 步失败了：把前面做了的倒着退回去。返回 {ok, failedAt?, error?, reverted?}（reverted：前面的都退回去了）。
   * @param {(action: string, body: object) => Promise<any>} act
   */
  async function runSteps(act, steps) {
    for (let i = 0; i < steps.length; i++) {
      try { await act(steps[i].action, steps[i].body); } catch (error) {
        let reverted = true;
        for (let j = i - 1; j >= 0; j--) {
          try { await act(steps[j].action, steps[j].undo); } catch { reverted = false; }
        }
        return { ok: false, failedAt: i, error, reverted };
      }
    }
    return { ok: true };
  }

  /** 规则 → 一句人话（界面上不说「披露」）。 */
  const BY = { owner: '你加的', tool: '聊天里经你同意加的', system: '忘掉那条记忆时一起加上的' };
  function ruleText(d, r) {
    const t = r.target ?? {};
    const who = (id) => nameOf(d, id) ?? '一个人';
    if (r.kind === 'do_not_remember') {
      if (t.settingKey) return `别记「${placeOf(d, t.settingKey)}」`;
      if (t.entityId != null) return `别记关于${who(t.entityId)}的事`;
      if (t.ref) return '别再记一条忘掉的事';
      return '别记';
    }
    const what = t.entityId != null ? `${who(t.entityId)}的事` : t.attribute ? `「${t.attribute}」这类事` : t.settingKey ? `在「${placeOf(d, t.settingKey)}」听到的事`
      : t.settingAttrs ? (t.settingAttrs.publicLike ? '公开场合里的事' : t.settingAttrs.oneOnOne ? '一对一聊到的事' : '某类场合里的事') : '这件事';
    const v = r.value ?? {};
    const deny = (v.deny ?? []).map(who);
    const allow = (v.allow ?? []).map(who);
    const head = v.restriction === 'strict' ? `${what}别提` : v.restriction === 'soft' ? `${what}最多说个大概` : deny.length ? `${what}别告诉${deny.join('、')}` : `${what}照常说`;
    const tail = [v.restriction !== 'none' && v.restriction != null && deny.length ? `尤其别告诉${deny.join('、')}` : null, allow.length ? `只能告诉${allow.join('、')}` : null].filter(Boolean);
    return tail.length ? `${head}，${tail.join('，')}` : head;
  }
  /** 加规则的表单 → rules.add 的参数（kind：dnr / strict / soft / deny）。不合法返回 {error}。 */
  function ruleBody(f) {
    const target = f.targetType === 'setting' ? (f.settingKey ? { settingKey: f.settingKey } : null)
      : f.targetType === 'entity' ? (f.entityId ? { entityId: Number(f.entityId) } : null)
        : (String(f.attribute ?? '').trim() ? { attribute: String(f.attribute).trim() } : null);
    if (!target) return { error: f.targetType === 'setting' ? '先选一个场合' : f.targetType === 'entity' ? '先选一个人' : '先写是哪一类事（比如：健康、住址、工作）' };
    const note = String(f.note ?? '').trim();
    if (f.kind === 'dnr') {
      if (f.targetType === 'attribute') return { error: '「别记」只能指向一个场合或一个人' };
      return { kind: 'do_not_remember', target, ...(note ? { note } : {}) };
    }
    const deny = [...(f.deny ?? [])].map(Number).filter((x) => Number.isSafeInteger(x) && x > 0 && x !== target.entityId);
    if (f.kind === 'deny' && !deny.length) return { error: '选至少一个别告诉的人' };
    const restriction = f.kind === 'strict' ? 'strict' : f.kind === 'soft' ? 'soft' : 'none';
    return { kind: 'disclosure', target, value: { restriction, ...(deny.length ? { deny } : {}) }, ...(note ? { note } : {}) };
  }
  /** 属性的一句话（只读）：几个人、谁能进、谁看得到、留不留存、她是什么身份。 */
  const ENTRY = { closed: '封闭的', invite: '邀请才能进', open: '谁都能进' };
  const VIS = { participants: '只有你们俩看得到', members: '成员看得到', anyone: '谁都看得到' };
  const PERSIST = { ephemeral: '不留存', logged: '有记录', 'public-permanent': '公开留存' };
  function attrsText(p) {
    const a = p.audience;
    if (!a) return '属性还没报上来';
    const hinted = typeof p.hint === 'string' ? /(\d+) 人/.exec(p.hint)?.[1] : null;
    const size = typeof a.size === 'number' ? `${a.size} 人` : a.size === 'unbounded' ? '人数不限' : hinted ? `平台上 ${hinted} 人` : '人数不详';
    return [size, ENTRY[a.entry], VIS[a.visibleTo], PERSIST[a.persistence], a.unknownObservers ? '有不认识的人在看' : null,
      a.herRole ? `她是${a.herRole}${a.herModerates ? '（管事）' : ''}` : null, p.stability === 'transient' ? '一次性的地方' : null].filter(Boolean).join(' · ');
  }
  /** 场合在页面上的名字：主人起的 > 入口给的；没名字的带区分提示。 */
  function titleOf(p) {
    const label = p.labelSource === 'owner' ? p.ownerLabel ?? p.label : p.label;
    const unnamed = p.labelSource !== 'owner' && p.labelKind === 'description' && !!p.hint;
    return { name: label || '没有名字的场合', hint: unnamed ? p.hint : null, unnamed };
  }
  /** 按入口分组（样稿：QQ 群和私聊 / DSH 桌面 / B站，别的入口按名字）。 */
  const GROUP = [['qq', 'QQ 群和私聊', 'qq'], ['dsh-web', 'DSH 桌面', 'monitor'], ['bili', 'B站', 'tv']];
  function groupsOf(items) {
    const out = GROUP.map(([k, t, ic]) => ({ key: k, title: t, ic, items: items.filter((p) => p.adapter === k) }));
    const known = new Set(GROUP.map(([k]) => k));
    const others = new Map();
    for (const p of items) if (!known.has(p.adapter)) (others.get(p.adapter) ?? others.set(p.adapter, { key: p.adapter, title: p.adapterName || p.adapter || '别的入口', ic: 'plug', items: [] }).get(p.adapter)).items.push(p);
    return [...out, ...others.values()].filter((g) => g.items.length);
  }
  const RET = { '1y': '1 年', '2y': '2 年', '5y': '5 年', forever: '一直' };
  /** 告知（丙5）：群里每个人说的话都会被记下、原话留多久。 */
  function noticeText(retention) {
    const keep = retention === '2y' || retention == null ? '原话默认保留 2 年' : retention === 'forever' ? '原话一直保留' : `原话现在保留 ${RET[retention] ?? retention}`;
    return `她所在的群里每个人说的话都会被记下，${keep}；群友不知道的，请你告诉他们。`;
  }

  const logic = { classOf, defaultMode, stateOf, planSwitch, planFollow, planRecall, runSteps, ruleText, ruleBody, attrsText, titleOf, groupsOf, noticeText, CLASS };

  // ════════════════════════════════════════════════════════════════════════
  // 页面
  // ════════════════════════════════════════════════════════════════════════
  const jobs = new Set();
  /** 场合键 → 还没提交的「关掉」（6 秒里又打开 = 撤销）。 */
  const offJobs = new Map();
  let S = null;   // {d, sub, el, body, open: Set(展开的场合), q: 搜索, gone: Set(收起的规则)}
  const RO = '记忆库现在是只读的，改不了。';
  const act = (action, body) => R.api.act(action, body);

  async function load() { S.d = await R.api.get('places'); }
  async function reloadQuiet() { try { await load(); } catch (e) { R.toast(R.errorText(e, 'read'), { tone: 'bad' }); return; } draw(); }

  /** 重画内容，焦点放回原来那个控件（按 data-focus 认）。 */
  function draw(focusKey) {
    if (!S?.body) return;
    const active = focusKey ?? document.activeElement?.closest?.('[data-focus]')?.dataset.focus ?? null;
    R.clear(S.body, content());
    if (active) S.body.querySelector(`[data-focus="${CSS.escape(active)}"]`)?.focus({ preventScroll: true });
  }

  function content() {
    const d = S.d;
    const top = d.readOnly ? R.note('warn', '记忆库现在是只读的：这里只能看，改不了。') : null;
    if (S.sub === 'rules') return [top, rulesView(d)];
    if (S.sub === 'notes') return [top, notesView(d)];
    return [top, placesView(d)];
  }

  // ── 场合 ───────────────────────────────────────────────────────────────
  function placesView(d) {
    const all = d.places?.items ?? [];
    if (!all.length) {
      return R.empty({ ic: 'chat', title: '还没有场合',
        text: '接上 QQ，或在 DSH 里新建任务时选「人设聊天」开一个对话后，她待过的群、私聊和对话会出现在这里，每个都能单独开关。',
        actions: btn('去接 QQ', { onclick: () => R.go('settings/connect') }) });
    }
    const df = d.defaults;
    const defLine = df ? Object.entries(CLASS).map(([k, t]) => `${t}${df.byAttributes?.[k] === 'off' ? '不记' : '在记'}`).join(' · ') : null;
    const head = h('div', { class: 'plc-intro' },
      h('p', { class: 'sdesc' }, noticeText(d.retention)),
      df?.global === 'off' ? R.note('warn', '记忆总开关关着：所有场合都不记新的、也不想起以前的事。', R.link('去设置', 'settings/basic')) : null,
      defLine ? h('p', { class: 'meta plc-defaults' }, `新场合默认：${defLine}`, h('span', { class: 'dot', 'aria-hidden': 'true' }), R.link('在设置里改', 'settings/basic', { arrow: true })) : null);
    // 场合很多时能搜：搜索框只建一次（输入法打字时不能把它换掉），输入时只重画下面的列表
    if (all.length > 8 && !S.searchEl) S.searchEl = searchBox();
    S.listSlot = h('div', { class: 'plc-groups' }, groupsView(d));
    return [head, all.length > 8 ? S.searchEl : null, S.listSlot,
      d.places.total > all.length ? h('p', { class: 'meta' }, `只列了前 ${all.length} 个（一共 ${d.places.total} 个）；用上面的搜索找。`) : null];
  }
  function groupsView(d) {
    const all = d.places?.items ?? [];
    const q = S.q.trim().toLowerCase();
    const items = q ? all.filter((p) => { const t = titleOf(p); return `${t.name} ${t.hint ?? ''} ${p.adapterName ?? ''}`.toLowerCase().includes(q); }) : all;
    const groups = groupsOf(items);
    return groups.length ? groups.map((g) => R.section(g.title, `${g.items.length} 个`, h('div', { class: 'list plc-list' }, g.items.map((p) => placeRow(d, p, g.ic)))))
      : h('p', { class: 'quiet plc-none' }, `没有名字里带「${S.q.trim()}」的场合。`);
  }
  function searchBox() {
    const input = h('input', { type: 'search', value: S.q, placeholder: '搜场合的名字', 'aria-label': '搜场合的名字' });
    input.addEventListener('input', () => { S.q = input.value; if (S.listSlot) R.clear(S.listSlot, groupsView(S.d)); });
    return h('div', { class: 'toolbar plc-toolbar' }, h('label', { class: 'search' }, icon('search', 16), input));
  }

  function placeRow(d, p, ic) {
    const st = stateOf(p, d.defaults);
    const t = titleOf(p);
    const rc = p.reception ?? {};
    const open = S.open.has(p.key);
    const lastLine = rc.state === 'never' ? '还没收到过消息' : rc.state === 'quiet' ? '现在收不到' : rc.lastAt ? `最近一条 ${fmt.when(rc.lastAt, d.now)}` : null;
    const meta = R.metaLine(h('span', { class: `plc-st ${st.status}` }, st.text), lastLine);
    const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon plc-exp', 'aria-expanded': String(open), 'aria-controls': `plc-d-${p.key}`,
      'aria-label': `「${t.name}」的更多设置`, title: '更多设置', 'data-focus': `exp-${p.key}`,
      onclick: () => { if (S.open.has(p.key)) S.open.delete(p.key); else S.open.add(p.key); draw(`exp-${p.key}`); } }, icon('down', 16));
    const disabled = d.readOnly || st.status === 'master';
    const sw = R.sw(st.on, (v) => flip(p, v), `在「${t.name}」记`, { disabled });
    sw.dataset.focus = `sw-${p.key}`;
    if (disabled) sw.title = d.readOnly ? RO : '记忆总开关关着，先在设置里打开';
    const row = R.row({ lead: h('span', { class: 'lead sm' }, icon(ic, 16)), title: [t.name, t.hint ? h('span', { class: 'plc-hint' }, ` · ${t.hint}`) : null],
      strong: true, clamp: false, meta, trail: [toggle, sw], cls: 'plc-row' });
    return h('div', { class: `plc-item${open ? ' open' : ''}`, 'data-key': p.key }, row, open ? detail(d, p, st, t) : null);
  }

  function detail(d, p, st, t) {
    const ro = d.readOnly;
    const swF = R.sw(st.follow, (v) => sub(p, planFollow(p, v), v ? '这里跟着默认走了' : '这里单独设定了'), '跟着默认走', { disabled: ro || st.status === 'master' });
    swF.dataset.focus = `fw-${p.key}`;
    const swR = R.sw(st.recallOnly, (v) => sub(p, planRecall(p, v), v ? '这里只想起、不记新的了' : '这里照常记了'), '只想起，不记新的', { disabled: ro || !st.on });
    swR.dataset.focus = `rc-${p.key}`;
    const rc = p.reception ?? {};
    const facts = [attrsText(p), rc.percepts > 0 ? `收到 ${rc.percepts} 条` : null, p.adapter === 'dsh-web' && rc.sessions > 0 ? `接上过 ${rc.sessions} 个对话` : null].filter(Boolean).join(' · ');
    return h('div', { class: 'plc-detail', id: `plc-d-${p.key}` }, h('div', { class: 'form' },
      R.frow({ title: '跟着默认走', cls: 'sw', right: true, control: swF,
        hint: `默认：${CLASS[st.cls]}${st.def === 'live' ? '在记' : '不记'}。关掉以后这里单独设定，默认改了也不跟着变。` }),
      R.frow({ title: '只想起，不记新的', cls: 'sw', right: true, control: swR,
        hint: st.on ? '以前记得的照样能想起来，这里的新话不再记。' : '这里现在关着：先打开，才谈得上只想起。' }),
      R.frow({ title: '名字', right: true,
        hint: p.labelSource === 'owner' ? `你起的名字（入口给的是「${clip(p.adapterLabel || '没有', 20)}」）` : t.unnamed ? `平台没给名字，区分用的记号 ${t.hint}` : '入口给的名字',
        control: btn(t.unnamed ? '起个名字' : '改名', { size: 'sm', disabled: ro, title: ro ? RO : null, onclick: () => rename(p) }) }),
      h('div', { class: 'frow plc-facts' }, h('div', { class: 'ftext' }, h('div', { class: 'ftitle' }, '这个场合'), h('div', { class: 'fhint' }, facts),
        (rc.state === 'never' || rc.state === 'quiet') && rc.reason ? h('div', { class: 'fhint plc-warn' }, rc.reason) : null))));
  }

  /** 主开关。开：立即做（两步），失败了退回去并说清；关：延迟提交，提示条写清后果、带「撤销」。 */
  async function flip(p, on) {
    const t = titleOf(p);
    const nm = clip(t.name, 12);
    // 刚关掉、还没提交（6 秒里）又打开：等于撤销那次关掉
    if (on && offJobs.has(p.key)) { offJobs.get(p.key).cancel(); R.toast(`「${nm}」照常记着，没关`); return; }
    if (on) {
      const r = await runSteps(act, planSwitch(p, true));
      await reloadQuiet();
      if (r.ok) R.toast(`「${nm}」开始记了`);
      else if (r.failedAt === 0 || r.reverted) R.toast(`没开成：${R.errorText(r.error)}已经恢复成原来的样子。`, { tone: 'bad' });
      else R.toast(`只开了一半：${R.errorText(r.error)}现在是「${stateOf(S.d.places.items.find((x) => x.key === p.key) ?? p, S.d.defaults).text}」。`, { tone: 'bad' });
      return;
    }
    const prev = { mode: p.mode, override: p.override };
    p.mode = 'off'; p.override = { mode: 'off' };
    draw(`sw-${p.key}`);
    const job = R.deferred({
      text: `关掉了「${nm}」：以后不在这里记、也不想起；已经记下的不删`,
      commit: async () => { const r = await runSteps(act, planSwitch({ ...p, ...prev }, false)); if (!r.ok) throw r.error; },
      undo: () => { jobs.delete(job); offJobs.delete(p.key); Object.assign(p, prev); if (S) draw(); },
      done: () => { jobs.delete(job); offJobs.delete(p.key); if (S) reloadQuiet(); },
    });
    jobs.add(job);
    offJobs.set(p.key, job);
  }
  /** 细项里的开关：一步，立即做；失败时开关自己翻回来（R.sw）并提示。 */
  async function sub(p, steps, okText) {
    const r = await runSteps(act, steps);
    if (!r.ok) throw r.error;
    R.toast(okText);
    await reloadQuiet();
  }

  function rename(p) {
    const t = titleOf(p);
    const owner = p.labelSource === 'owner';
    const input = h('input', { class: 'input', id: 'plc-rn', value: t.unnamed ? '' : t.name, maxlength: '40', autocomplete: 'off', spellcheck: 'false', placeholder: t.unnamed ? '起一个你认得出的名字' : '' });
    const err = h('div', { class: 'err', role: 'alert', hidden: true });
    const save = async (label) => {
      err.hidden = true;
      try {
        const r = await act('setting.rename', { settingKey: p.key, label });
        layer.close();
        R.toast(label ? `已改名为「${clip(r?.label ?? label, 16)}」` : `已恢复成入口给的名字「${clip(r?.label ?? p.adapterLabel ?? '', 16)}」`);
        reloadQuiet();
      } catch (e) { err.hidden = false; R.clear(err, R.errorText(e)); }
    };
    const ok = btn('保存', { kind: 'primary', onclick: () => {
      const v = input.value.trim();
      if (!v) { err.hidden = false; R.clear(err, owner ? '名字不能空着；想用入口给的名字，点「恢复自动」。' : '先写一个名字。'); return; }
      if ([...v].length > 40) { err.hidden = false; R.clear(err, `名字最多 40 个字（现在 ${[...v].length} 个）。`); return; }
      save(v);
    } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok.click(); } });
    const layer = R.dialog({
      title: t.unnamed ? '给这个场合起个名字' : '给这个场合改名',
      body: [h('p', null, '她心里、想起事情时说「在哪儿」、这一页都用这个名字；不会改平台上的群名，入口以后报了别的名字也不跟着变。'),
        h('div', { class: 'field' }, h('label', { for: 'plc-rn' }, '名字'), input,
          p.adapterLabel ? h('div', { class: 'fhint' }, `入口给的：${p.adapterLabel}${t.hint ? `（${t.hint}，这个记号只在这一页显示）` : ''}`) : null), err],
      actions: [owner ? btn('恢复自动', { kind: 'ghost', onclick: () => save(null) }) : null, h('span', { class: 'sp' }), btn('取消', { onclick: () => layer.close() }), ok],
      initial: () => input,
    });
    input.select();
  }

  // ── 规则 ───────────────────────────────────────────────────────────────
  function rulesView(d) {
    const add = btn('添加规则', { ic: 'plus', size: 'sm', disabled: d.readOnly, title: d.readOnly ? RO : null, onclick: () => ruleDialog(d) });
    add.dataset.focus = 'rule-add';
    const rules = (d.rules?.items ?? []).filter((r) => !S.gone.has(`rule-${r.id}`));
    const bar = h('div', { class: 'plc-bar' }, h('p', { class: 'sdesc' }, '你定的「别记」和「别说」。只按人、一类事和场合写。'), add);
    if (!rules.length) return [bar, R.empty({ ic: 'shield', title: '还没有你定的规则', text: '比如「别记这个群」「阿明的事别告诉小雨」「健康这类事最多说个大概」。' })];
    return [bar, h('div', { class: 'list' }, rules.map((r) => {
      const items = [
        r.target?.ref ? { label: '看那条记忆', ic: 'book', onSelect: () => R.go('memory/list', { params: { open: r.target.ref } }) } : null,
        { label: '删掉这条规则', ic: 'trash', danger: true, disabled: d.readOnly, onSelect: () => dropRule(r) },
      ].filter(Boolean);
      return R.row({ lead: h('span', { class: 'lead sm' }, icon(r.kind === 'do_not_remember' ? 'eyeoff' : 'shield', 16)), title: ruleText(d, r), strong: true,
        meta: R.metaLine(BY[r.createdBy] ?? null, r.note, r.at != null ? fmt.when(r.at, d.now) : null), trail: R.moreButton(items, '这条规则的操作') });
    }))];
  }
  /** 删掉一条规则：延迟提交（带撤销；真删了也能照原样再加一条，所以给撤销）。 */
  function dropRule(r) {
    const key = `rule-${r.id}`;
    S.gone.add(key);
    draw('rule-add');
    const job = R.deferred({
      text: '已删掉这条规则',
      commit: () => act('rules.revoke', { id: r.id }),
      undo: () => { jobs.delete(job); if (S) { S.gone.delete(key); draw(); } },
      done: async () => { jobs.delete(job); if (S) { await reloadQuiet(); S?.gone.delete(key); } },
    });
    jobs.add(job);
  }
  function ruleDialog(d) {
    const people = (d.pickable ?? []).filter((e) => e.kind === 'person' && !e.isSelf && (!d.people || d.people.includes(e.id)));
    const places = d.places?.items ?? [];
    const f = { kind: 'dnr', targetType: 'setting', settingKey: places[0]?.key ?? '', entityId: '', attribute: '', deny: new Set(), note: '' };
    const box = h('div', { class: 'plc-form' });
    const err = h('div', { class: 'err', role: 'alert', hidden: true });
    const select = (id, opts, value, onChange) => {
      const s = h('select', { class: 'input plc-select', id }, opts.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) }, t)));
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };
    const draw2 = () => {
      const types = f.kind === 'dnr' ? [['setting', '一个场合'], ['entity', '一个人']] : [['entity', '一个人'], ['attribute', '一类事'], ['setting', '一个场合']];
      if (!types.some(([k]) => k === f.targetType)) f.targetType = types[0][0];
      const target = f.targetType === 'setting'
        ? (places.length ? select('plc-rt', places.map((p) => [p.key, `${p.adapterName ? `${p.adapterName} · ` : ''}${titleOf(p).name}${titleOf(p).hint ? `（${titleOf(p).hint}）` : ''}`]), f.settingKey, (v) => { f.settingKey = v; }) : h('p', { class: 'fhint' }, '还没有场合。'))
        : f.targetType === 'entity'
          ? (people.length ? select('plc-rt', [['', '选一个人'], ...people.map((e) => [e.id, e.name])], f.entityId, (v) => { f.entityId = v; draw2(); }) : h('p', { class: 'fhint' }, '还没有认识的人。'))
          : (() => { const i = h('input', { class: 'input', id: 'plc-rt', value: f.attribute, maxlength: '60', placeholder: '比如：健康、住址、工作' }); i.addEventListener('input', () => { f.attribute = i.value; }); return i; })();
      const note = h('input', { class: 'input', id: 'plc-rn2', value: f.note, maxlength: '200', placeholder: '写给自己看的，可以不填' });
      note.addEventListener('input', () => { f.note = note.value; });
      const denyBox = f.kind !== 'dnr' && people.length ? h('div', { class: 'field' }, h('label', null, f.kind === 'deny' ? '别告诉谁' : '尤其别告诉谁（可以不选）'),
        h('div', { class: 'plc-people' }, people.filter((e) => String(e.id) !== String(f.entityId)).slice(0, 60).map((e) => {
          const c = h('input', { type: 'checkbox', checked: f.deny.has(e.id) });
          c.addEventListener('change', () => { if (c.checked) f.deny.add(e.id); else f.deny.delete(e.id); });
          return h('label', { class: 'cbox' }, c, e.name);
        }))) : null;
      // 分段每次重建：选完以后焦点放回同一个分段里选中的那一项
      const back = (label) => box.querySelector(`[aria-label="${label}"] [aria-selected="true"]`)?.focus();
      const segKind = R.seg([['dnr', '别记'], ['strict', '别提'], ['soft', '最多说个大概'], ['deny', '别告诉谁']], f.kind, (v) => { f.kind = v; draw2(); back('什么规则'); }, '什么规则');
      const segType = R.seg(types, f.targetType, (v) => { f.targetType = v; draw2(); back('对谁、在哪儿'); }, '对谁、在哪儿');
      const hint = { dnr: '以后不记这个场合、这个人的新话；已经记下的不删。', strict: '她不再往外说这件事。', soft: '提起时只说个大概，不说细节。', deny: '对点了名的人不说这件事，别人照常。' }[f.kind];
      R.clear(box,
        h('div', { class: 'field' }, h('label', null, '什么规则'), segKind, h('div', { class: 'fhint' }, hint)),
        h('div', { class: 'field' }, h('label', null, '对谁、在哪儿'), segType),
        h('div', { class: 'field' }, h('label', { for: 'plc-rt' }, f.targetType === 'setting' ? '场合' : f.targetType === 'entity' ? '人' : '哪一类事'), target),
        denyBox,
        h('div', { class: 'field' }, h('label', { for: 'plc-rn2' }, '备注'), note));
    };
    draw2();
    const ok = btn('添加', { kind: 'primary', onclick: async () => {
      const body = ruleBody(f);
      if (body.error) { err.hidden = false; R.clear(err, body.error); return; }
      err.hidden = true; ok.disabled = true;
      try { await act('rules.add', body); layer.close(); R.toast('规则加上了'); reloadQuiet(); } catch (e) { ok.disabled = false; err.hidden = false; R.clear(err, R.errorText(e)); }
    } });
    const layer = R.dialog({ title: '添加规则', body: [box, err], actions: [btn('取消', { onclick: () => layer.close() }), ok], initial: () => box.querySelector('.seg button[aria-selected="true"]') });
  }

  // ── 叮嘱 ───────────────────────────────────────────────────────────────
  function notesView(d) {
    const lim = d.limits;
    if (lim?.error) return R.errorBox(lim, () => reloadQuiet(), { title: '叮嘱读不出来' });
    const items = lim?.items ?? [];
    if (!items.length) return R.empty({ ic: 'lock', title: '没有她在守的叮嘱', text: '有人说「这事别外传」并且对得上原话、点了名「别告诉谁」，或你收紧过的，会列在这里。' });
    return [h('p', { class: 'sdesc' }, '别人叮嘱过、她在守着不往外说的事。当事人自己再问起时她照常说；你觉得可以说了就解除。'),
      h('div', { class: 'list' }, items.map((x) => {
        const by = nameOf(d, x.by);
        const deny = (x.deny ?? []).map((id) => nameOf(d, id) ?? '一个人');
        const b = btn('解除…', { size: 'sm', disabled: d.readOnly, title: d.readOnly ? RO : null, onclick: () => relax(x) });
        b.dataset.focus = `relax-${x.ref}`;
        return R.row({ lead: h('span', { class: 'lead sm' }, icon('lock', 16)), title: x.quote ? `「${x.quote}」` : x.about ? x.about : '一件事', strong: true,
          meta: R.metaLine(by ? `${by}叮嘱的` : '有人叮嘱的', deny.length ? `别告诉${deny.join('、')}` : x.kind === 'strict' ? '别外传' : '说的时候小心',
            x.settingKey ? `在「${clip(placeOf(d, x.settingKey), 14)}」` : null, x.at != null ? fmt.when(x.at, d.now) : null,
            h('button', { type: 'button', class: 'link plc-link', onclick: () => R.go('memory/list', { params: { open: x.ref } }) }, '看那条记忆')),
          trail: b });
      }))];
  }
  /** 解除一条叮嘱：底层恢复不了（只能等有人再叮嘱一次），所以走确认框，确认后立即提交。 */
  async function relax(x) {
    const yes = await R.confirmSimple({ title: '解除这条叮嘱', okText: '解除',
      text: '解除以后，她在别处也可以照常提起这件事。解除了就回不去：想再守着，只能等有人再叮嘱一次。' });
    if (!yes) return;
    try {
      const r = await act('limit.relax', { ref: x.ref });
      R.toast(r?.applied === false ? '这条已经不算叮嘱了' : '已解除');
    } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); return; }
    reloadQuiet();
  }

  // ── 登记 ───────────────────────────────────────────────────────────────
  async function render(el, route) {
    await Promise.all([...jobs].map((j) => j.flush()));
    const keep = S && S.el === el ? { open: S.open, q: S.q } : { open: new Set(), q: '' };
    S = { d: null, sub: route.sub, el, body: null, gone: new Set(), ...keep };
    const segEl = R.seg(R.SUBS.places.map(([k, t]) => [k, t]), route.sub, (k) => R.go(`places/${k}`, { focus: false }), '场合的分类');
    S.body = h('div', { class: 'plc-body' }, R.loading('正在读她待过的地方…'));
    R.clear(el, h('div', { class: 'wrap' }, h('div', { class: 'narrow' }, R.pageHead('场合', '她在哪儿记、有什么规矩。', segEl), S.body)));
    try { await load(); } catch (e) {
      R.clear(S.body, R.errorBox(e, () => render(el, route), { title: '场合读不出来' }));
      return;
    }
    draw();
  }
  function leave() { for (const j of [...jobs]) j.flush(); S = null; }

  return { render, leave, logic };
});
