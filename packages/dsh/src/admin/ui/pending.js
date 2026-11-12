// 待处理（D172）：一个收件箱。四个分段：全部（「要你知道的」「等你点头的」两组）· 需要你知道 · 等你批准 · 被拦下的话。
// 一条 = 一张卡：类型和时间、一句话说发生了什么、引用的原话（或之前 → 之后），右下一主一次两个按钮。
// 数据只来自一个视图 admin.data?view=inbox（packages/dsh/src/admin/views.js）；数字的口径和首页一样（需要你知道开着的 + 审核等着的）。
// 撤销（设计说明 8.3 第 2 条）：后端语义不变。点了以后卡片先收起、数字减一、出现带「撤销」的提示条；R.deferred 6 秒后才真的提交，
// 期间点「撤销」就不提交、卡片回来；离开页面、切走、换去处、换分段时立刻提交；提交失败把卡片放回去并说明。
// 不可恢复的不给撤销：批准彻底删除（按来源撤回的批准）、批准把一句话发出去——走确认框，确认后立即提交。
// 「卡片 → 动作」是纯映射（logic.cardOf），测试在 node 里直接调。样式在 pending.css，类名带 pend- 前缀。
Rugu.define('pending', (R) => {
  const { h, icon, fmt, btn } = R;
  const DAY = 86_400_000;

  // ════════════════════════════════════════════════════════════════════════
  // 纯函数（不碰 DOM）
  // ════════════════════════════════════════════════════════════════════════
  const clip = (s, n) => { const c = [...String(s ?? '')]; return c.length > n ? `${c.slice(0, n).join('')}…` : c.join(''); };
  const isRef = (s) => typeof s === 'string' && /^[pweanitscl][1-9]\d{0,15}$/.test(s);
  const nameOf = (d, id) => (id == null ? null : d.names?.[id] ?? null);
  const placeOf = (d, key) => (key ? clip(d.settings?.[key] ?? '某个场合', 16) : null);
  const inPlace = (d, key) => (key ? `在「${placeOf(d, key)}」` : null);
  const md = (t) => { const x = new Date(t); return `${x.getMonth() + 1}/${x.getDate()}`; };

  /** 核心写的原因代码 → 一句人话（照旧页面的表；内部说法换掉；认不出的不显示）。 */
  const REASON = {
    'withdraw-by-source': '你按来源撤回的', 'owner-withdraw': '你按来源撤回的', 'growth-proposal': '夜里整理提议的变化', 'approve-mode': '她的性格设成了每处变化都先问你',
    'maybe-same-uncertain': '没把握是不是同一个人', 'cross-namespace-self-claim': '有人自称是另一个入口的某个人', 'subject-forget-request': '当事人自己要求忘掉',
    'subject-request': '当事人自己要求忘掉', 'forget-request': '有人要求忘掉', 'unauthorized-relax': '没有权限的人想放宽', 'moderator-relax': '群管理想放宽这个群的规矩',
    'looser-rule': '新学到的规矩比原来宽', 'tool-by-non-principal': '不是你本人，却用了只有你能用的操作', 'appraise-error': '检查时出错了，先停下来',
    'prescreen-hit': '碰到了不该说的记忆', 'unknown-target': '不清楚话会落到哪里', 'cross-circle-ledger': '要说到别的圈子，而这次对话里想起过不能带过去的事',
    'tainted-turn': '这一轮读到过来路不明的内容', 'turn-tainted': '这一轮读到过来路不明的内容', 'public-mentions-person': '公开的地方提到了具体的人',
    'persistent-channel': '会被反复看到，又用到了记忆', 'public-narrow-source': '这件事原来只有少数人知道', 'mentions-person': '提到了具体的人',
    'review-unavailable': '检查不了（模型或额度用不了），先停下来', 'public-floor': '公开场合的底线', 'early-public-hold': '刚开始的头几天，公开的话先停下来问你',
    'public-hold': '公开的地方要改口时先停下来', 'final-reject': '同一句话被拦了两次', 'core-self': '提到了她心里最要紧的人',
    directive: '没有权限的人给她下了指令或「设定」', 'secrecy-request': '有人要她「别告诉你」', harm: '有人可能受到伤害、违法或者安全上的问题',
    'learned-setting-rule': '准备写进一个场合的规矩，来源不是你', 'turn-taint': '这一轮读到的内容来路不明', 'poison-repeat': '有人可能在反复灌输同一件事',
  };
  function reasonText(r) {
    if (r == null || r === '') return null;
    const s = String(r);
    if (REASON[s]) return REASON[s];
    if (/^growth-v\d+$/.test(s)) return '写进了她的性格，依据里有你以外的人';
    if (s.startsWith('setting-rule:')) return REASON['learned-setting-rule'];
    if (s.startsWith('withdraw:')) return REASON['withdraw-by-source'];
    if (s.startsWith('unavailable:')) return REASON['review-unavailable'];
    if (/taint/.test(s)) return REASON['turn-taint'];
    if (/poison/.test(s)) return REASON['poison-repeat'];
    return null;
  }
  /** 被拦下的那句的原因（D119：floor:P1 这类代码不上页面；认不出的不显示）。 */
  function blockedWhy(code) {
    const c = String(code);
    if (c === 'floor:P1') return '和一条私聊里的记忆撞上了词，被要求改口';
    if (c === 'floor:P2') return '碰到了一条有限制的记忆，被要求改口';
    if (c === 'floor:P3') return '碰到了一件敏感的事，被要求改口';
    if (c.startsWith('floor:')) return '撞上了旧规则的底线，被要求改口';
    if (c === 'ledger-truncated') return '她心里装的事太多、记不全，于是每句都被送去检查';
    if (c === 'turn-tainted') return '这一轮读过群里或网上的内容，判断更严';
    if (c.startsWith('model:')) return '检查的模型判了「先不说」';
    if (c === 'rewrite' || c === 'touches') return '被要求换个说法';
    if (c === 'error') return '检查本身出错了';
    return REASON[c] ?? null;
  }
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];

  // ── 动作（纯数据）：页面按 type 执行 ─────────────────────────────────────
  //   deferred：延迟提交（带撤销），可选先 confirm（普通确认框）
  //   server：服务端确认令牌的流程（R.api.confirmed），确认后立即提交，不给撤销
  //   go：去别的地方；read：展开 / 看那条记忆
  const goMemory = (ref) => ({ type: 'go', label: '看那条记忆', path: 'memory/list', params: { open: ref } });
  const ntkRead = (x) => ({ type: 'deferred', label: '知道了', action: 'ntk.read', body: { id: x.id }, toast: '已标为已读' });
  const withdrawOp = (x, d) => ({
    type: 'server', label: '按来源撤回…', action: 'source.withdraw', body: { entityId: x.withdraw.entityId, from: x.withdraw.from, to: x.withdraw.to },
    title: '按来源撤回', okText: '撤回并送审', danger: true, reload: true,
    consequence: `把${x.sourceName ?? nameOf(d, x.withdraw.entityId) ?? '这个人'}在 ${fmt.when(x.withdraw.from, d.now)} 到 ${fmt.when(x.withdraw.to, d.now)} 之间说的全部内容，以及由它们整理出来的记忆，先对别人隐藏，再放进「等你批准」。批准了才彻底删除；驳回就恢复原样。`,
    done: (r) => `已撤回 ${r?.refs ?? 0} 条，在「等你批准」里等你决定`,
  });
  const decide = (x, decision, label, toast, extra = {}) => ({ type: 'deferred', label, action: 'review.decide', body: { id: x.id, decision }, toast, ...extra });

  /** 成长那一处的变化 → {del, add}（op：add / remove / revise）。 */
  function diffOf(c) {
    if (!c || typeof c !== 'object' || c.purged) return null;
    if (c.op === 'add') return { del: null, add: c.after ?? null };
    if (c.op === 'remove') return { del: c.before ?? null, add: null };
    if (c.op === 'revise') return { del: c.before ?? null, add: c.after ?? null };
    return null;
  }

  /**
   * 一条「需要你知道」→ 卡片。旧页面里 T1 的「别告诉你主人」贴的是「想改变她」的标签：这里给它自己的说法（有人要她瞒着你）。
   * @returns {{key, group, ic, cap, urgent, at, title, desc?, quote?, diff?, meta: any[], links: object[], primary: object, secondary: object|null}}
   */
  function ntkCard(d, x) {
    const r = String(x.reason ?? '');
    const from = x.sourceName ?? nameOf(d, x.sourceEntityId);
    const fwd = x.forwardedBy ? (x.forwardedBy.name ?? nameOf(d, x.forwardedBy.entityId) ?? '不知道是谁') : null;
    const who = fwd ? `${fwd}转发的，原作者写的是${from ?? '不知道是谁'}（没核实）` : from ? `${from}说的` : null;
    const base = { key: `ntk-${x.id}`, group: 'ntk', urgent: (x.severity ?? 1) >= 2, at: x.quoteAt ?? x.createdAt, quote: x.quote ?? null,
      meta: [inPlace(d, x.settingKey), who], links: [], primary: ntkRead(x), secondary: null };
    const wd = x.withdraw ? withdrawOp(x, d) : null;
    const mem = x.ref ? goMemory(x.ref) : null;
    // 次按钮：按来源撤回（能撤回的）或看那条记忆；另一个放成小字里的链接（旧页面这两样都有）
    const pair = (first) => {
      const [a, b] = first === 'memory' ? [mem, wd] : [wd, mem];
      return { secondary: a ?? b, links: a && b ? [b] : [] };
    };
    if (x.kind === 'foreign_write' && /^growth-v\d+$/.test(r)) {
      const g = x.growth;
      return { ...base, ic: 'sprout', cap: '她的性格有了变化', quote: null, diff: diffOf(g?.change),
        title: `夜里整理时，一处变化写进了她的性格${g?.version ? `（第 ${g.version} 版）` : ''}。依据里有你以外的人，所以告诉你一声。`,
        desc: g?.revokedAt ? `这处已经在 ${fmt.when(g.revokedAt, d.now)} 撤销了。` : g && !g.current ? '之后又有新的版本，现在的性格不一定还是这样。' : '认同就点「知道了」；不认同就去「成长」里撤销这处。',
        meta: [g?.evidenceRefs?.length ? `依据 ${g.evidenceRefs.length} 段经历` : null], secondary: { type: 'go', label: '去成长里看', path: 'memory/growth' } };
    }
    if (x.kind === 'foreign_write' && r === 'growth-proposal') {
      return { ...base, ic: 'sprout', cap: '她的性格想改一处', title: '夜里整理提议改她的性格，依据里有你以外的人。还没生效，在「等你批准」里等你决定。',
        secondary: { type: 'sub', label: '去批准', sub: 'approve' } };
    }
    if (x.kind === 'foreign_write') {
      return { ...base, ic: 'chat', cap: '新规矩', title: '她准备给一个场合写一条规矩，来源不是你（群里的人说的，或者她自己学到的）。',
        desc: '不合适就去「场合」里看看；没问题点「知道了」。', secondary: { type: 'go', label: '去场合看看', path: 'places/list' } };
    }
    if (x.kind === 'T1' && r === 'secrecy-request') {
      return { ...base, ic: 'eyeoff', cap: '有人要她瞒着你', title: '她不会因此瞒你，这一条就是在告诉你。', ...pair('withdraw') };
    }
    if (x.kind === 'T1') {
      return { ...base, ic: 'shield', cap: '有人想改她的设定', title: '没有权限的人想给她定新规矩。她没照做，只记下了有人提过。', ...pair('withdraw') };
    }
    if (x.kind === 'T2') {
      return { ...base, ic: 'alert', cap: '聊到了安全', title: '有人说到了可能有危险的事。看看原话，需要的话亲自问一下。', ...pair('memory') };
    }
    if (x.kind === 'poison') {
      return { ...base, ic: 'alert', cap: '有人反复说同一件事', title: '有人在反复对她说同一件事，像是想改掉她对某个人或某件事的看法。说的不是事实就按来源撤回。', ...pair('withdraw') };
    }
    if (x.kind === 'taint') {
      return { ...base, ic: 'info', cap: '来路不明的内容', title: '她读到了来路不明的内容（转发、网页、工具结果），之后的话会更小心地对待。一般不用管。', ...pair('withdraw') };
    }
    return { ...base, ic: 'info', cap: '需要你知道', title: reasonText(r) ?? '有一件事需要你知道。', ...pair('withdraw') };
  }

  /** 一条审核 → 卡片（每种一对说人话的主次按钮）。 */
  function reviewCard(d, x) {
    const p = x.payload ?? {};
    const now = d.now ?? Date.now();
    const base = { key: `rv-${x.id}`, group: 'approve', at: x.createdAt, urgent: x.expiresAt != null && x.expiresAt - now < 2 * DAY, meta: [], links: [] };
    switch (x.kind) {
      case 'held_utterance': {
        const hd = x.hold;
        const place = placeOf(d, hd?.settingKey) ?? '某个地方';
        const left = x.expiresAt != null ? Math.ceil((x.expiresAt - now) / DAY) : null;
        const why = uniq([reasonText(x.reason), ...(hd?.reasons ?? []).filter((y) => !isRef(y)).map(reasonText)]).slice(0, 2);
        return { ...base, ic: 'msgoff', cap: '她想说一句话，先停下来问你',
          title: hd ? `这句要发到「${place}」${hd.formHint ? `（${hd.formHint}）` : ''}，发之前先问你。` : '她想说一句话，原文读不到了（可能已经过期）。',
          desc: why.length ? `${why.join('；')}。` : null,
          quote: hd?.text ?? null, thought: hd?.reflection ? `她的想法：${hd.reflection}` : null,
          meta: [hd ? `要发到「${place}」` : null, left == null ? null : left <= 1 ? '今天之内不处理就不发' : `${left} 天后不处理就不发`],
          secondary: decide(x, 'reject', '不发', '这句不发了'),
          primary: { type: 'server', label: '批准发出', action: 'review.decide', body: { id: x.id, decision: 'approve' }, title: '批准发出这句话', okText: '批准发出', danger: false,
            consequence: `发出去就收不回：她会照原文发到「${place}」，这次不再检查。`, item: hd?.text ?? null, done: () => '已批准，她会发出去' } };
      }
      case 'merge': {
        const a = nameOf(d, p.a) ?? '一个人'; const b = nameOf(d, p.b) ?? '另一个人';
        return { ...base, ic: 'merge', cap: '可能是同一个人',
          title: `「${a}」和「${b}」可能是同一个人${p.confidence != null ? `（把握 ${fmt.pct(p.confidence)}）` : ''}。`,
          desc: '是的话，两边记得的事会合在一起；不是的话，她以后不会再这样猜。',
          secondary: decide(x, 'reject', '不是', `记下了：「${clip(a, 8)}」和「${clip(b, 8)}」不是同一个人`),
          primary: decide(x, 'approve', '是同一个人', `「${clip(a, 8)}」和「${clip(b, 8)}」合在一起了`, {
            confirm: { title: '是同一个人吗', text: `确认以后，她记得的关于「${a}」的事和关于「${b}」的事会合在一起，以后当成一个人。拿不准就先点「取消」。`, okText: '是同一个人' } }) };
      }
      case 'growth': {
        const n = Array.isArray(p.evidenceRefs) ? p.evidenceRefs.length : 0;
        return { ...base, ic: 'sprout', cap: '她的性格想改一处', title: '夜里整理发现她最近变了，想把这一处写进她的性格。', diff: diffOf(p.change),
          meta: [n ? `依据 ${n} 段经历` : null], links: [{ type: 'go', label: '去成长里看', path: 'memory/growth' }],
          secondary: decide(x, 'reject', '不同意', '这处不写进去了'), primary: decide(x, 'approve', '同意', '写进她的性格了') };
      }
      case 'forget_request': {
        const who = nameOf(d, p.entityId) ?? '有人';
        return { ...base, ic: 'eyeoff', cap: '有人要求忘掉',
          title: p.hidden === false ? `${who}要她忘掉一条记忆。` : `${who}要她忘掉关于自己的一条记忆。这条已经先对别人隐藏了。`,
          quote: x.memo?.text ?? null, links: isRef(p.ref) ? [goMemory(p.ref)] : [],
          secondary: decide(x, 'reject', '留着', p.hidden === false ? '这条留着' : '这条留着，恢复成原样'),
          primary: decide(x, 'approve', '忘掉', '已忘掉（30 天内能恢复）') };
      }
      case 'withdraw': {
        const refs = Array.isArray(p.refs) ? p.refs.filter(isRef) : [];
        const who = nameOf(d, p.entityId) ?? '这个人';
        return { ...base, ic: 'undo', cap: '按来源撤回',
          title: `撤回${who}${p.from != null && p.to != null ? `在 ${md(p.from)} 到 ${md(p.to)} 之间` : ''}说的 ${refs.length} 条内容，以及由它们整理出来的记忆。`,
          desc: '你之前点了「按来源撤回」。批准后彻底删除，找不回来；驳回就恢复原样。', meta: ['这些内容现在对别人隐藏着'],
          secondary: decide(x, 'reject', '驳回', '已驳回，这些内容恢复原样'),
          primary: { type: 'server', label: '批准删除…', action: 'review.decide', body: { id: x.id, decision: 'approve' }, title: '批准并彻底删除', okText: '彻底删除', danger: true,
            consequence: `会彻底删除${who}的 ${refs.length} 条内容和由它们整理出来的记忆，删了找不回来。已经放进过对话里的文字，仍然留在过去的会话记录里。`,
            done: () => '已彻底删除' } };
      }
      case 'setting_rule_relax': {
        const place = placeOf(d, p.settingKey) ?? '一个场合';
        return { ...base, ic: 'chat', cap: '场合的规矩要放宽', title: `她在「${place}」学到的新规矩比原来宽，要你点头才算数。`,
          quote: p.rule?.text ?? null, desc: p.rule?.text ? null : '新规矩的原文在那个场合的规矩里。',
          meta: [reasonText(x.reason)], secondary: decide(x, 'reject', '不同意', '这条规矩不放宽'), primary: decide(x, 'approve', '同意放宽', '规矩放宽了') };
      }
      case 'norm_change': {
        const tighten = p.direction === 'tighten' || p.update?.direction === 'tighten';
        return { ...base, ic: 'shield', cap: '一件事能对谁说要改',
          title: tighten ? '有一件事能对谁说要收紧，要你点头。' : '有人想放宽一件事能对谁说，要你点头。',
          quote: x.memo?.text ?? null, meta: [reasonText(x.reason)], links: isRef(p.ref) ? [goMemory(p.ref)] : [],
          secondary: decide(x, 'reject', '不同意', '照原样，不改'), primary: decide(x, 'approve', '同意', tighten ? '收紧了' : '放宽了') };
      }
      case 'owner_op': {
        return { ...base, ic: 'shield', cap: '只有你能做的事', title: '有人用你的口吻要她做只有你能做的事，但不是你本人说的。照做的话，按那条消息里说的办。',
          quote: x.memo?.text ?? null, meta: [reasonText(x.reason)],
          secondary: decide(x, 'reject', '不照做', '不照做'), primary: decide(x, 'approve', '照做', '照做了') };
      }
      default:
        return { ...base, ic: 'inbox', cap: '等你批准', title: reasonText(x.reason) ?? '有一件事等你决定。',
          secondary: decide(x, 'reject', '驳回', '已驳回'), primary: decide(x, 'approve', '批准', '已批准') };
    }
  }

  /** 被拦下的一句 → 卡片（只是记录：没有按钮，最多一个链接）。 */
  function blockedCard(d, x) {
    const base = { key: `bl-${x.id}`, group: 'blocked', at: x.at, urgent: false, primary: null, secondary: null,
      meta: [inPlace(d, x.settingKey), x.tainted ? '这一轮读过群里或网上的内容' : null], links: [] };
    const why = uniq((x.reasons ?? []).map(blockedWhy));
    if (x.basis === 'guard' && x.kind === 'secret') {
      return { ...base, ic: 'hand', cap: '有句话没说出口', title: '她差点几乎原样说出一条叮嘱过别外传的话，这句没发出去。觉得那件事其实可以说，就去「叮嘱」里解除。',
        links: [{ type: 'go', label: '去叮嘱', path: 'places/notes' }] };
    }
    if (x.basis === 'guard') {
      return { ...base, ic: 'hand', cap: '有句话没说出口', title: '她差点几乎原样转述别人私下跟她说的话。换成自己的话照样能聊，一般不用处理。',
        links: x.ref ? [goMemory(x.ref)] : [] };
    }
    if (x.verdict === 'hold') {
      return { ...base, ic: 'msgoff', cap: '一句话存成了草稿', title: '在公开的地方说话前的检查没通过，这句放进了「等你批准」。',
        desc: why.length ? `${why.join('；')}。` : null, links: [{ type: 'sub', label: '去批准', sub: 'approve' }] };
    }
    if (x.basis === 'error') {
      return { ...base, ic: 'warn', cap: '检查出错了', title: '说话前的检查本身出错了，这句没说。一般不用处理；经常出现的话到「设置 → 诊断」看看。' };
    }
    if (x.basis === 'legacy') {
      return { ...base, ic: 'clock', cap: '旧规则拦下的', title: `${why.length ? `${why.join('；')}。` : ''}这是以前那套更严的规则留下的记录，现在已经不会这样拦。` };
    }
    return { ...base, ic: 'msgoff', cap: '改口了', title: `${why.length ? `${why.join('；')}。` : '公开的地方说话前的检查没通过。'}一般不用处理，这里只是记录。`,
      links: x.ref ? [goMemory(x.ref)] : [] };
  }

  /** 数据 → 三组卡片（需要你知道按严重程度、新旧；等你批准要紧的在前、新的在前——和首页同一个排法）。gone：已经收起的卡片的 key。 */
  function cardsOf(d, gone = new Set()) {
    const order = (a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || (b.at ?? 0) - (a.at ?? 0);
    const ntk = (d.needToKnow?.items ?? []).map((x) => ntkCard(d, x)).filter((c) => !gone.has(c.key)).sort(order);
    const approve = (d.review?.items ?? []).map((x) => reviewCard(d, x)).filter((c) => !gone.has(c.key)).sort(order);
    const blocked = d.blocked?.error ? [] : (d.blocked?.items ?? []).map((x) => blockedCard(d, x));
    return { ntk, approve, blocked };
  }
  /** 各分段的数字。total 和首页「需要你看一眼」、主导航的数字同一个口径：需要你知道开着的 + 审核等着的（收起的那几张已经减掉）。 */
  function countsOf(d, gone = new Set()) {
    // 只减还在数据里的（重新读过以后已经提交掉的那几张不再重复减）
    const goneIn = (items, prefix) => (items ?? []).filter((x) => gone.has(`${prefix}${x.id}`)).length;
    const ntk = Math.max(0, Number(d.counts?.needToKnow ?? d.needToKnow?.total ?? 0) - goneIn(d.needToKnow?.items, 'ntk-'));
    const approve = Math.max(0, Number(d.counts?.review ?? d.review?.total ?? 0) - goneIn(d.review?.items, 'rv-'));
    const blocked = d.blocked?.error ? null : Number(d.blocked?.total ?? 0);
    return { all: ntk + approve, ntk, approve, blocked };
  }
  /** 首页链接过来的参数 open=ntk-3 / rv-12 / bl-40：那一张在哪个分段。 */
  function subOfKey(key) {
    const m = /^(ntk|rv|bl)-[1-9]\d{0,15}$/.exec(String(key ?? ''));
    return m ? { ntk: 'ntk', rv: 'approve', bl: 'blocked' }[m[1]] : null;
  }

  const EMPTY = {
    all: ['checkc', '没有等你决定的事', '有人想改她的设定、要她瞒着你、她想在公开的地方说话之类的，会先出现在这里。'],
    ntk: ['checkc', '没有要你知道的事', '没有权限的人想给她下指令、有人要她瞒着你、聊到安全的事，会列在这里。'],
    approve: ['checkc', '没有等你批准的事', '她想在公开的地方说的话、可能是同一个人、她想改的性格，会在这里等你点头。'],
    blocked: ['hand', '最近没有被拦下的话', '平常的话都照常说；只有几乎原样复述别人叮嘱过别外传的话时，才会挡一句。'],
  };

  /**
   * 一张卡的延迟提交（撤销的那一套）：要确认的先问（取消就什么都不做）→ 卡片收起（hide）→ R.deferred：
   * 6 秒后 act(动作, 参数)；期间撤销 → 不提交、show 放回来；提交失败 → R.deferred 提示原因并调 undo → show 放回来；提交成了 → committed。
   * 依赖都从参数进来（测试换成假的）。返回 R.deferred 的 {flush, cancel}；取消了返回 null。
   * @param {{action: string, body: object, toast: string, confirm?: {title: string, text: string, okText: string}}} op
   * @param {string} key
   * @param {{deferred: Function, act: Function, confirmSimple: Function, hide: (key: string) => any, show: (key: string, job: any) => void, committed: (key: string, job: any) => void}} deps
   */
  async function startDeferred(op, key, deps) {
    if (op.confirm && !(await deps.confirmSimple({ title: op.confirm.title, text: op.confirm.text, okText: op.confirm.okText }))) return null;
    await deps.hide(key);
    const job = deps.deferred({
      text: op.toast,
      commit: () => deps.act(op.action, op.body),
      undo: () => deps.show(key, job),
      done: () => deps.committed(key, job),
    });
    return job;
  }

  const logic = { ntkCard, reviewCard, blockedCard, cardsOf, countsOf, subOfKey, reasonText, blockedWhy, diffOf, startDeferred, EMPTY };

  // ════════════════════════════════════════════════════════════════════════
  // 页面
  // ════════════════════════════════════════════════════════════════════════
  /** 这一页还在等的延迟提交（换分段、重画前先提交，数据才对得上）。 */
  const jobs = new Set();
  let S = null;   // {d, gone, showRead, legacy, sub, el, head, body, segSlot}

  async function flushMine() { await Promise.all([...jobs].map((j) => j.flush())); }

  const readOnlyTitle = '记忆库现在是只读的，改不了。';
  function opButton(op, kind, card) {
    if (!op) return null;
    const ro = S.d.readOnly && (op.type === 'deferred' || op.type === 'server');
    return btn(op.label, { kind, disabled: ro, title: ro ? readOnlyTitle : null, onclick: () => run(op, card) });
  }
  function opLink(op, card) {
    const ro = S.d.readOnly && (op.type === 'deferred' || op.type === 'server');
    return h('button', { type: 'button', class: 'link pend-link', disabled: ro, title: ro ? readOnlyTitle : null, onclick: () => run(op, card) }, op.label);
  }

  /** 执行一个动作。 */
  async function run(op, card) {
    if (op.type === 'go') { R.go(op.path, op.params ? { params: op.params } : undefined); return; }
    if (op.type === 'sub') { R.go(`pending/${op.sub}`, { focus: false }); return; }
    if (op.type === 'server') {
      let r;
      try {
        r = await R.api.confirmed(op.action, op.body, { title: op.title, okText: op.okText, danger: op.danger,
          render: () => [h('p', null, op.consequence), op.item ? h('div', { class: 'item' }, op.item) : null] });
      } catch (e) { R.toast(R.errorText(e), { tone: 'bad' }); return; }
      if (r == null) return;
      R.toast(op.done?.(r) ?? '好了');
      if (card && !op.reload) { S.gone.add(card.key); redraw({ focusAfter: card.key }); }
      await reload();
      return;
    }
    if (op.type === 'deferred') {
      const job = await startDeferred(op, card.key, {
        deferred: R.deferred, act: R.api.act, confirmSimple: R.confirmSimple,
        hide: async (key) => { await collapse(key); S.gone.add(key); redraw({ focusAfter: key }); },
        show: (key, j) => { jobs.delete(j); if (S) { S.gone.delete(key); redraw(); } },
        committed: (key, j) => { jobs.delete(j); if (S) S.committed.add(key); },
      });
      if (job) jobs.add(job);
    }
  }

  /** 收起一张卡（先淡出、再把高度收掉，下面的卡片顺着补上）；减少动态效果时直接收。 */
  function collapse(key) {
    const el = S.body?.querySelector(`[data-key="${key}"]`);
    if (!el || R.reduceMotion()) return Promise.resolve();
    return new Promise((resolve) => {
      el.style.height = `${el.offsetHeight}px`;
      el.classList.add('pend-out');
      setTimeout(() => el.classList.add('pend-gone'), 140);
      setTimeout(resolve, 400);
    });
  }

  function cardEl(c) {
    const d = S.d;
    const id = `pt-${c.key}`;
    const blocked = c.group === 'blocked';
    const el = h('article', { class: 'card pend-card', 'data-key': c.key, 'aria-labelledby': id, tabindex: '-1' },
      h('div', { class: 'pend-k' }, icon(c.ic, 16), h('span', null, c.cap), c.urgent ? h('span', { class: 'pend-urgent' }, '· 要紧') : null,
        h('span', { class: 'pend-when' }, fmt.when(c.at, d.now))),
      h('div', { class: 'pend-t', id }, c.title),
      c.desc ? h('div', { class: 'pend-d' }, c.desc) : null,
      c.diff ? h('div', { class: 'pend-diff' },
        c.diff.del ? h('div', { class: 'del' }, h('span', { class: 'sign', 'aria-label': '原来' }, '−'), h('span', null, c.diff.del)) : null,
        c.diff.add ? h('div', { class: 'add' }, h('span', { class: 'sign', 'aria-label': '改成' }, '+'), h('span', null, c.diff.add)) : null) : null,
      c.quote ? h('blockquote', { class: 'pend-q' }, `「${c.quote}」`, c.thought ? h('span', { class: 'who' }, c.thought) : null) : null,
      h('div', { class: 'pend-f' },
        h('div', { class: 'meta' }, [...c.meta.filter(Boolean), ...(blocked ? [] : c.links.map((l) => opLink(l, c)))].map((p, i) => (i ? [h('span', { class: 'dot', 'aria-hidden': 'true' }), p] : p))),
        blocked ? (c.links[0] ? R.link(c.links[0].label, () => run(c.links[0], c)) : null)
          : h('div', { class: 'pend-acts' }, opButton(c.secondary, 'secondary', c), opButton(c.primary, 'primary', c))));
    return el;
  }

  function segEl(counts) {
    // 没有的分段不写 0（样稿的空状态里分段不带数字）
    const subs = R.SUBS.pending.map(([k, t]) => [k, t, counts[k] ? counts[k] : null]);
    return R.seg(subs, S.sub, (k) => R.go(`pending/${k}`, { focus: false }), '待处理的分类');
  }

  function readBlock(d) {
    const rd = d.read;
    if (!rd || rd.error || !rd.total) return null;
    const box = h('div', { class: 'pend-read' });
    const toggle = h('button', { type: 'button', class: 'link', 'aria-expanded': String(S.showRead), onclick: () => { S.showRead = !S.showRead; redraw(); } },
      S.showRead ? '收起已读的' : `看已读的 ${rd.total} 件`);
    R.add(box, toggle);
    if (S.showRead) {
      R.add(box, R.list(rd.items.map((x) => {
        const c = ntkCard(d, x);
        const items = [c.secondary, ...c.links].filter((o) => o && (o.type === 'server' || o.type === 'go'))
          .map((o) => ({ label: o.label, ic: o.type === 'server' ? 'undo' : 'book', disabled: d.readOnly && o.type === 'server', onSelect: () => run(o, null) }));
        return R.row({ lead: h('span', { class: 'lead sm' }, icon(c.ic, 16)), title: `${c.cap}：${c.quote ? `「${clip(c.quote, 60)}」` : c.title}`,
          meta: R.metaLine(...c.meta, x.readAt ? `${fmt.when(x.readAt, d.now)} 读过` : null), trail: items.length ? R.moreButton(items) : null });
      })));
    }
    return box;
  }

  function legacyBlock(d) {
    const lg = d.blocked?.legacy;
    if (!lg?.total) return null;
    const box = h('div', { class: 'pend-legacy' });
    if (!S.legacy) {
      R.add(box, h('p', { class: 'meta' }, `以前那套更严的规则拦下过 ${lg.total} 句${lg.lastAt ? `（最后一次 ${fmt.day(lg.lastAt, d.now)}）` : ''}，现在已经不会这样拦。 `,
        h('button', { type: 'button', class: 'link', onclick: openLegacy }, '看看')));
      return box;
    }
    R.add(box, h('p', { class: 'meta' }, '下面是旧规则拦下的话，只是历史记录，不用处理。 ', h('button', { type: 'button', class: 'link', onclick: () => { S.legacy = null; redraw(); } }, '收起')),
      S.legacy.error ? R.errorBox(S.legacy.error, openLegacy) : h('div', { class: 'cards' }, S.legacy.items.map((x) => cardEl(blockedCard(d, x)))));
    return box;
  }
  async function openLegacy() {
    try {
      const r = await R.api.get('discretion', { basis: 'legacy' });
      S.legacy = { items: r.blocked?.items ?? [] };
    } catch (e) { S.legacy = { error: e }; }
    redraw();
  }

  function content() {
    const d = S.d;
    const { ntk, approve, blocked } = cardsOf(d, S.gone);
    const sub = S.sub;
    const out = [];
    if (d.readOnly && sub !== 'blocked') out.push(R.note('warn', '记忆库现在是只读的：这里只能看，处理不了。'));
    if (sub === 'blocked') {
      if (d.blocked?.error) return R.errorBox(d.blocked, () => reload(), { title: '被拦下的话读不出来' });
      if (!blocked.length && !d.blocked?.legacy?.total) return emptyOf('blocked');
      const t = d.today ?? {};
      out.push(h('p', { class: 'sdesc pend-desc' }, '她想说、但没说出口的话。只写原因，不放原文；这里只是记录，方便你看出是不是拦多了，一般不用处理，也不算进待处理的数字。'));
      if (t.guard || t.publicHold) out.push(h('p', { class: 'meta pend-today' }, R.fmt.spaced(`今天：挡下 ${t.guard ?? 0} 句、存成草稿 ${t.publicHold ?? 0} 句`)));
      out.push(blocked.length ? h('div', { class: 'cards' }, blocked.map(cardEl)) : null, legacyBlock(d));
      return out;
    }
    const cards = (xs) => h('div', { class: 'cards' }, xs.map(cardEl));
    if (sub === 'all') {
      if (!ntk.length && !approve.length) { out.push(emptyOf('all')); out.push(readBlock(d)); return out; }
      if (ntk.length) out.push(R.section('要你知道的', `${ntk.length} 件`, cards(ntk)));
      if (approve.length) out.push(R.section('等你点头的', `${approve.length} 件`, cards(approve)));
      out.push(readBlock(d));
      return out;
    }
    const xs = sub === 'ntk' ? ntk : approve;
    out.push(xs.length ? cards(xs) : emptyOf(sub));
    if (sub === 'ntk') out.push(readBlock(d));
    return out;
  }
  function emptyOf(sub) { const [ic, title, text] = EMPTY[sub]; return R.empty({ ic, title, text }); }

  /** 重画分段的数字和内容（保持滚动位置；被收起的那张后面的一张拿到焦点）。 */
  function redraw({ focusAfter } = {}) {
    if (!S?.body) return;
    const hadFocus = focusAfter && S.body.contains(document.activeElement);
    const order = [...S.body.querySelectorAll('.pend-card[data-key]')].map((x) => x.dataset.key);
    const counts = countsOf(S.d, S.gone);
    R.setPendingCount(counts.all);
    R.clear(S.segSlot, segEl(counts));
    R.clear(S.body, content());
    if (hadFocus) {
      const i = order.indexOf(focusAfter);
      const next = order.slice(i + 1).concat(order.slice(0, i).reverse()).map((k) => S.body.querySelector(`[data-key="${k}"]`)).find(Boolean);
      (next?.querySelector('.pend-acts .btn-primary:not([disabled])') ?? next ?? S.el.querySelector('[data-page-title]'))?.focus({ preventScroll: true });
    }
  }

  async function reload() {
    try {
      S.d = await R.api.get('inbox');
      // 已经提交掉的不在新数据里了；还在等的（6 秒里）照样收着
      S.gone = new Set([...S.gone].filter((k) => !S.committed.has(k)));
      S.committed.clear();
    } catch (e) { R.toast(R.errorText(e, 'read'), { tone: 'bad' }); return; }
    redraw();
  }

  /** 从首页点一条过来（?open=ntk-3）：滚到那张卡、亮一下、焦点给它。不在这一页的分段：换到它所在的分段。 */
  function locate(key) {
    if (!key || !S?.body) return;
    const el = S.body.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!el) {
      const sub = subOfKey(key);
      const exists = sub && cardsOf(S.d, S.gone)[sub === 'approve' ? 'approve' : sub].some((c) => c.key === key);
      if (exists && sub !== S.sub && S.sub !== 'all') { R.go(`pending/${sub}`, { params: { open: key }, focus: false, replace: true }); return; }
      R.toast('这一条已经处理过了');
      R.setParams({ open: null });
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: R.reduceMotion() ? 'auto' : 'smooth' });
    el.classList.remove('pend-hl'); void el.offsetWidth; el.classList.add('pend-hl');
    el.focus({ preventScroll: true });
    R.setParams({ open: null });
  }

  async function render(el, route) {
    await flushMine();
    const fresh = !S || S.el !== el;
    S = { d: fresh ? null : S.d, gone: new Set(), committed: new Set(), showRead: fresh ? false : S.showRead, legacy: null, sub: route.sub, el, head: null, body: null, segSlot: null };
    S.segSlot = h('div', { class: 'pend-segslot' });
    S.body = h('div', { class: 'pend-body', 'aria-live': 'off' }, R.loading('正在看有什么等你…'));
    R.clear(el, h('div', { class: 'wrap' }, h('div', { class: 'narrow' }, R.pageHead('待处理', '要你知道、或等你点头的事。', S.segSlot), S.body)));
    R.clear(S.segSlot, R.seg(R.SUBS.pending.map(([k, t]) => [k, t]), route.sub, (k) => R.go(`pending/${k}`, { focus: false }), '待处理的分类'));
    try { S.d = await R.api.get('inbox'); } catch (e) {
      R.clear(S.body, R.errorBox(e, () => render(el, route), { title: '待处理读不出来' }));
      return;
    }
    redraw();
    if (route.params.open) requestAnimationFrame(() => locate(route.params.open));
  }
  function update(route) {
    if (!S?.d) return false;
    if (route.params.open) locate(route.params.open);
    return true;
  }
  function leave() { for (const j of [...jobs]) j.flush(); S = null; }

  return { render, update, leave, logic };
});
