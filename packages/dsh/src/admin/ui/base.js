// 新管理页的地基（D170）：h()、图标、请求层（含确认令牌流程）、路由、主题、公共组件、格式化。全页只有一个全局名字 window.Rugu。
// 各去处的模块（home.js、memory.js……）各在自己的 <script> 里调 Rugu.define(名字, (R) => ({ render(el, route) {...} }))。
// 规矩（ui/README.md 有完整说明）：
//   - 节点一律用 DOM API 建，文字一律走文本节点（h() 的子节点是字符串时就是 textContent）；从不把字符串当 HTML 解析。
//     记忆、名字、昵称、场合名都是别人可控的字符串。
//   - 不加载任何外部资源（CSP：只许带 nonce 的脚本和样式、只许同源请求）。
//   - 这个文件在模块加载时只定义东西，不碰 DOM（测试在 node 里用 vm 加载它，测纯函数）；碰 DOM 的事都在 Rugu.start() 之后。
(function (G) {
  'use strict';
  const R = {};
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ════════════════════════════════════════════════════════════════════════
  // 节点
  // ════════════════════════════════════════════════════════════════════════
  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'open', 'selected', 'indeterminate']);
  /**
   * 建一个元素。attrs：class、style（对象，走 CSSOM）、on<事件>（函数）、value/checked/disabled/hidden/open/selected/indeterminate（设属性值），
   * 其余照原样 setAttribute（true = 空值，null / false / undefined = 不设）。子节点：节点、字符串（成文本节点）、数组（拍平），null / false / '' 跳过。
   * @param {string} tag
   * @param {Record<string, any>|null} [attrs]
   * @param {...any} kids
   * @returns {HTMLElement}
   */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (PROPS.has(k)) el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    add(el, kids);
    return el;
  }
  /** 往 el 里追加子节点（规则同 h()）。返回 el。 */
  function add(el, ...kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false || k === true || k === '') continue;
      el.append(k instanceof G.Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  /** 清空 el 再放进 kids。返回 el。 */
  function clear(el, ...kids) { el.replaceChildren(); return add(el, kids); }
  R.h = h; R.add = add; R.clear = clear;

  // ── 图标（Lucide 风格：24 网格、2px 描边、圆头） ─────────────────────
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    home: [['path', { d: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' }]],
    book: [['path', { d: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z' }], ['path', { d: 'M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z' }]],
    inbox: [['path', { d: 'M22 12h-6l-2 3h-4l-2-3H2' }], ['path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }]],
    chat: [['path', { d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }]],
    sliders: [['path', { d: 'M20 7h-9' }], ['path', { d: 'M14 17H5' }], ['circle', { cx: 17, cy: 17, r: 3 }], ['circle', { cx: 7, cy: 7, r: 3 }]],
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm21 21-4.3-4.3' }]],
    down: [['path', { d: 'm6 9 6 6 6-6' }]],
    right: [['path', { d: 'm9 18 6-6-6-6' }]],
    left: [['path', { d: 'm15 18-6-6 6-6' }]],
    more: [['circle', { cx: 5, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }]],
    x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    checkc: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm9 12 2 2 4-4' }]],
    warn: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
    alert: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 8v4' }], ['path', { d: 'M12 16h.01' }]],
    info: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41' }]],
    moon: [['path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }]],
    play: [['path', { d: 'M7 4.5v15l12-7.5z' }]],
    pause: [['path', { d: 'M8 5v14M16 5v14' }]],
    eyeoff: [['path', { d: 'M9.88 9.88a3 3 0 1 0 4.24 4.24' }], ['path', { d: 'M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68' }], ['path', { d: 'M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61' }], ['path', { d: 'm2 2 20 20' }]],
    user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M20 21a8 8 0 0 0-16 0' }]],
    users: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]],
    monitor: [['rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }], ['path', { d: 'M8 21h8M12 17v4' }]],
    tv: [['rect', { x: 2, y: 7, width: 20, height: 14, rx: 2 }], ['path', { d: 'm17 2-5 5-5-5' }]],
    qq: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
    archive: [['rect', { x: 2, y: 3, width: 20, height: 5, rx: 1 }], ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4' }]],
    cpu: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 }], ['rect', { x: 9, y: 9, width: 6, height: 6, rx: 1 }], ['path', { d: 'M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2' }]],
    coins: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4m8.71 3.88.7.71-2.82 2.82' }]],
    activity: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
    plus: [['path', { d: 'M5 12h14M12 5v14' }]],
    trash: [['path', { d: 'M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }]],
    undo: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
    refresh: [['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
    lock: [['rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }], ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]],
    clock: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 6v6l4 2' }]],
    shield: [['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }]],
    plug: [['path', { d: 'M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z' }]],
    sprout: [['path', { d: 'M7 20h10M10 20c5.5-2.5.8-6.4 3-10' }], ['path', { d: 'M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z' }], ['path', { d: 'M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z' }]],
    stars: [['path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }], ['path', { d: 'M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z' }]],
    msgoff: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }], ['path', { d: 'm9 8 6 6M15 8l-6 6' }]],
    link: [['path', { d: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
    download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3' }]],
    cal: [['rect', { x: 3, y: 4, width: 18, height: 18, rx: 2 }], ['path', { d: 'M16 2v4M8 2v4M3 10h18' }]],
    select: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['path', { d: 'm9 12 2 2 4-4' }]],
    sort: [['path', { d: 'm3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16' }]],
    hand: [['path', { d: 'M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8' }], ['path', { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' }]],
    merge: [['circle', { cx: 18, cy: 18, r: 3 }], ['circle', { cx: 6, cy: 6, r: 3 }], ['path', { d: 'M6 21V9a9 9 0 0 0 9 9' }]],
    pen: [['path', { d: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }]],
    heart: [['path', { d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z' }]],
    file: [['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }], ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }]],
    map: [['path', { d: 'M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0' }], ['circle', { cx: 12, cy: 10, r: 3 }]],
    paw: [['circle', { cx: 11, cy: 4, r: 2 }], ['circle', { cx: 18, cy: 8, r: 2 }], ['circle', { cx: 20, cy: 16, r: 2 }], ['path', { d: 'M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z' }]],
    construction: [['rect', { x: 2, y: 6, width: 20, height: 8, rx: 1 }], ['path', { d: 'M17 14v7M7 14v7M17 3v3M7 3v3M10 14 2.3 6.3M14 6l7.7 7.7M8 6l8 8' }]],
    // 「故」字形（packages/dsh/assets/glyph.svg，跟文字颜色）
    gu: [['path', { d: 'M2.5 7.5H11' }], ['path', { d: 'M6.75 3.5V12.5' }], ['path', { d: 'M3.5 12.5H10V19.5H3.5Z' }], ['path', { d: 'M15.75 3L14 8' }], ['path', { d: 'M14.5 6.5H21' }],
      ['path', { d: 'M19.25 6.5C18.5 13 16.25 18 12.5 21' }], ['path', { d: 'M15.25 12C16.75 15.75 18.75 18.75 21.5 20.5' }]],
  };
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }
  /**
   * 按名字取一个图标（不认识的名字给空图标，不抛错）。
   * @param {string} name   ICONS 里的键（R.ICONS 列着全部）
   * @param {number} [size] 像素，默认 16
   * @param {number} [stroke] 描边粗细，默认 2
   */
  function icon(name, size = 16, stroke) {
    const s = svgEl('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'i', 'aria-hidden': 'true', focusable: 'false' });
    if (stroke) s.style.strokeWidth = String(stroke);
    for (const [t, a] of ICONS[name] ?? []) s.append(svgEl(t, a));
    return s;
  }
  /**
   * 应用图标（深色圆角方块 + 金色方块 + 「故」；照 assets/icon.svg 画成平涂，小尺寸也清楚）。颜色走 --mark-* token。
   * @param {number} [size] 默认 28
   */
  function brandMark(size = 28) {
    const s = svgEl('svg', { viewBox: '0 0 128 128', width: size, height: size, class: 'mark', 'aria-hidden': 'true', focusable: 'false' });
    s.append(svgEl('rect', { x: 0, y: 0, width: 128, height: 128, rx: 30, fill: 'var(--mark-bg)' }));
    s.append(svgEl('rect', { x: 22, y: 22, width: 84, height: 84, rx: 20, fill: 'var(--mark-orb)' }));
    const g = svgEl('g', { transform: 'translate(29 29) scale(2.92)', fill: 'none', stroke: 'var(--mark-ink)', 'stroke-width': 2.2, 'stroke-linecap': 'square', 'stroke-linejoin': 'miter' });
    for (const [t, a] of ICONS.gu) g.append(svgEl(t, a));
    s.append(g);
    return s;
  }
  R.ICONS = ICONS; R.icon = icon; R.brandMark = brandMark;

  // ════════════════════════════════════════════════════════════════════════
  // 格式（纯函数：now 可以传进来，测试用）
  // ════════════════════════════════════════════════════════════════════════
  const pad = (n) => String(n).padStart(2, '0');
  const sameDay = (a, b) => { const x = new Date(a); const y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const fmt = {
    /** 14:32 */
    clock(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; },
    /** 今天 14:32 / 昨天 14:32 / 11/3 14:32 / 2025/11/3（照旧页面的规矩）；没有时间给 —。 */
    when(t, now = Date.now()) {
      if (t == null || !Number.isFinite(Number(t))) return '—';
      const d = new Date(t);
      if (sameDay(t, now)) return `今天 ${fmt.clock(t)}`;
      const y = new Date(now); y.setDate(y.getDate() - 1);
      if (sameDay(t, y.getTime())) return `昨天 ${fmt.clock(t)}`;
      if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${fmt.clock(t)}`;
      return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    },
    /** 只到天：今天 / 昨天 / 11/3 / 2025/11/3。 */
    day(t, now = Date.now()) {
      if (t == null) return '—';
      const d = new Date(t);
      if (sameDay(t, now)) return '今天';
      const y = new Date(now); y.setDate(y.getDate() - 1);
      if (sameDay(t, y.getTime())) return '昨天';
      return d.getFullYear() === new Date(now).getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    },
    /** 按天分组的标题：['今天', '11月13日 周五'] / ['11月11日 周三', '']。 */
    dayLabel(t, now = Date.now()) {
      const d = new Date(t);
      const md = `${d.getMonth() + 1}月${d.getDate()}日 ${WD[d.getDay()]}`;
      const head = fmt.day(t, now);
      return head === '今天' || head === '昨天' ? [head, md] : [md, ''];
    },
    /** 刚刚 / 5 分钟前 / 3 小时前 / 2 天前。 */
    ago(t, now = Date.now()) {
      if (t == null) return '—';
      const s = Math.max(0, (now - t) / 1000);
      if (s < 90) return '刚刚';
      if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
      if (s < 86400 * 2) return `${Math.round(s / 3600)} 小时前`;
      return `${Math.round(s / 86400)} 天前`;
    },
    /** 数：1234 → 1234，12345 → 1.2 万，1.2e8 → 1.2 亿；null → —。 */
    num(n) {
      if (n == null || Number.isNaN(Number(n))) return '—';
      const one = (x) => x.toFixed(1).replace(/\.0$/, '');
      n = Number(n);
      return n >= 1e8 ? `${one(n / 1e8)} 亿` : n >= 1e4 ? `${one(n / 1e4)} 万` : String(Math.round(n * 100) / 100);
    },
    /** 0.923 → 92%。 */
    pct(x) { return x == null ? '—' : `${Math.round(Number(x) * 100)}%`; },
    /** 钱：¥0.08；不到一分写「不到 ¥0.01」；null → —。 */
    yuan(x) { return x == null ? '—' : x === 0 ? '¥0.00' : x < 0.005 ? '不到 ¥0.01' : `¥${x >= 10 ? x.toFixed(1) : x.toFixed(2)}`; },
    /**
     * 中文和英文、数字之间补一个空格（「今天听到42句」→「今天听到 42 句」）。已经有空格的不重复加；标点旁边不加。
     * 句子尽量直接写成带空格的模板字符串；这个给拼出来的、拿不准的文字兜底。
     */
    spaced(s) {
      return String(s ?? '')
        .replace(/([一-鿿])([A-Za-z0-9¥])/g, '$1 $2')
        .replace(/([A-Za-z0-9%])([一-鿿])/g, '$1 $2');
    },
  };
  R.fmt = fmt;

  // ════════════════════════════════════════════════════════════════════════
  // 路由：地址栏的 hash，#/去处/分段?参数=值
  // ════════════════════════════════════════════════════════════════════════
  /** 五个去处（顺序 = 主导航的顺序）：[键, 名字, 图标]。首次设置不在主导航里。 */
  const DESTS = [['home', '首页', 'home'], ['memory', '记忆', 'book'], ['pending', '待处理', 'inbox'], ['places', '场合', 'chat'], ['settings', '设置', 'sliders']];
  /** 各去处的分段：[键, 名字, 图标?]。第一项是默认的。 */
  const SUBS = {
    memory: [['list', '记忆'], ['people', '人物'], ['starmap', '星图'], ['growth', '成长']],
    pending: [['all', '全部'], ['ntk', '需要你知道'], ['approve', '等你批准'], ['blocked', '被拦下的话']],
    places: [['list', '场合'], ['rules', '规则'], ['notes', '叮嘱']],
    settings: [['basic', '基本', 'user'], ['models', '模型', 'cpu'], ['connect', '接入', 'plug'], ['cost', '花费', 'coins'], ['backup', '备份', 'archive'], ['diag', '诊断', 'activity'], ['about', '关于', 'info']],
    wizard: [['1', '知情'], ['2', '她是谁'], ['3', '模型'], ['4', '接 QQ'], ['5', '完成']],
  };
  const ALL_DESTS = new Set([...DESTS.map(([k]) => k), 'wizard']);
  /**
   * 解析 hash（纯函数）。不认识的去处 → 首页；不认识的分段 → 那个去处的默认分段。
   * @param {string} hash  '#/memory/people?open=a12'
   * @returns {{dest: string, sub: string|null, params: Record<string, string>, path: string}}
   */
  function parseHash(hash) {
    const raw = String(hash ?? '').replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
    const params = {};
    if (qi >= 0) for (const [k, v] of new URLSearchParams(raw.slice(qi + 1))) params[k] = v;
    const [d0, s0] = pathPart.split('/').map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
    const dest = ALL_DESTS.has(d0) ? d0 : 'home';
    const subs = SUBS[dest];
    const sub = subs ? (subs.some(([k]) => k === s0) ? s0 : subs[0][0]) : null;
    return { dest, sub, params, path: sub ? `${dest}/${sub}` : dest };
  }
  /**
   * 拼 hash（纯函数）：buildHash('memory/people', {open: 'a12'}) → '#/memory/people?open=a12'。空值的参数不带。
   * @param {string} path  '去处' 或 '去处/分段'
   * @param {Record<string, any>} [params]
   */
  function buildHash(path, params) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== '' && v !== false) q.set(k, String(v));
    const s = q.toString();
    return `#/${String(path ?? 'home').replace(/^#?\/?/, '')}${s ? `?${s}` : ''}`;
  }
  R.DESTS = DESTS; R.SUBS = SUBS; R.parseHash = parseHash; R.buildHash = buildHash;

  /**
   * 旧版页面上对应的页签（还没搬过来的去处「去旧版里看」用；纯函数）。
   * @param {string} path  '去处/分段'
   */
  const CLASSIC_TAB = {
    home: 'overview', 'memory/list': 'memory', 'memory/people': 'memory', 'memory/starmap': 'starmap', 'memory/growth': 'growth',
    'pending/all': 'needToKnow', 'pending/ntk': 'needToKnow', 'pending/approve': 'review', 'pending/blocked': 'discretion',
    'places/list': 'settings', 'places/rules': 'settings', 'places/notes': 'discretion',
    'settings/basic': 'config', 'settings/models': 'config', 'settings/connect': 'config', 'settings/cost': 'config',
    'settings/backup': 'backups', 'settings/diag': 'diagnostics', 'settings/about': 'config',
  };
  function classicTab(path) { const p = parseHash(`#/${path}`); return CLASSIC_TAB[p.path] ?? CLASSIC_TAB[p.dest] ?? 'overview'; }
  /** 旧版页面的地址（同一个路由加 ?ui=classic&tab=…；主题跟着带过去）。纯函数。 */
  function classicHref(path, theme) {
    const q = new URLSearchParams({ ui: 'classic', tab: classicTab(path) });
    if (theme === 'light' || theme === 'dark') q.set('theme', theme);
    return `admin?${q}`;
  }
  R.classicTab = classicTab; R.classicHref = classicHref;

  // ════════════════════════════════════════════════════════════════════════
  // 请求层
  // ════════════════════════════════════════════════════════════════════════
  class ApiError extends Error {
    /** @param {number} status @param {{code?: string, error?: string, reasons?: string[], path?: string}} body */
    constructor(status, body) {
      super(body?.error || `HTTP ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = body?.code ?? 'HTTP';
      this.reasons = Array.isArray(body?.reasons) ? body.reasons : null;
      this.path = body?.path ?? null;
    }
  }
  /**
   * 出错给人看的一句话（纯函数）。读不出来、只读、403、500 各有自己的说法；服务端给了看得懂的说明（400 / 422 / 409 的大多数）就用它。
   * @param {any} e      ApiError 或别的错
   * @param {'read'|'write'} [kind]  读视图出的错前面加「读不出来：」
   */
  function errorText(e, kind = 'write') {
    const code = e?.code;
    const status = e?.status;
    let t;
    if (code === 'NETWORK' || status === 0) t = '连不上 DSH，可能正在重启。稍后再试。';
    else if (code === 'FORBIDDEN' || status === 403) t = '没有权限。请从 DSH 的设置里打开「如故」。';
    else if (code === 'READ_ONLY') t = '记忆库现在是只读的，改不了。';
    else if (code === 'NOT_READY') t = '还没走完首次设置。';
    else if (code === 'TIMEOUT' || status === 504) t = '等太久没有回应，稍后再试。';
    else if (code === 'INTERNAL' || status === 500) t = '出错了。日志里只记了错误类型，可以到「设置 → 诊断」看。';
    else if (code === 'UNAVAILABLE' || status === 503) t = e?.message && e.message !== `HTTP ${status}` ? e.message : '这一项现在用不了。';
    else if (code === 'NOT_FOUND' || status === 404) t = '没找到，可能已经被删掉了。';
    else if (e?.message && !/^HTTP \d+$/.test(e.message)) t = e.message;
    else t = '出错了。';
    return kind === 'read' && code !== 'READ_ONLY' ? `读不出来：${t}` : t;
  }
  R.ApiError = ApiError; R.errorText = errorText;

  let TOKEN = '';
  async function call(url, init = {}) {
    let r;
    try {
      r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { 'x-pm-admin': TOKEN, ...(init.headers ?? {}) } });
    } catch { throw new ApiError(0, { code: 'NETWORK', error: '连不上 DSH' }); }
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok || !j || j.ok !== true) throw new ApiError(r.status, j ?? { code: 'HTTP', error: `HTTP ${r.status}` });
    return j;
  }
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)])).toString();
  const norm = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  const api = {
    /**
     * 读一个视图：GET admin.data?view=…&参数。自动带上浏览器的时区（tz，分钟，东正），按天算的视图要用。
     * @param {string} view
     * @param {Record<string, any>} [params]
     * @returns {Promise<any>}  视图的数据；出错抛 ApiError
     */
    get(view, params = {}) {
      return call(`admin.data?${qs({ view, tz: -new Date().getTimezoneOffset(), ...params })}`).then((j) => j.data);
    },
    /**
     * 写操作：POST admin.do {action, ...body}。要确认的操作直接调它会得到 428（CONFIRM_REQUIRED）：用 api.confirmed。
     * @returns {Promise<any>}  result；出错抛 ApiError
     */
    act(action, body = {}) {
      return call('admin.do', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...body }) }).then((j) => j.result);
    },
    /**
     * 要确认的写操作（和旧页面同一个流程，actions.js 的 prepare / confirm）：
     *   1. prepare：服务端回 {needsConfirm, preview, token, phrase?, expiresAt, refuse?}；不需要确认的直接执行；
     *      宿主说有风险（CONFIRM_REQUIRED，带 reasons）且 opts.askable 时带 ask:true 再走一遍；
     *   2. 弹对话框：一句后果（opts.consequence 或 opts.render(preview)），可选的手输确认语（服务端给的 phrase），折叠的技术细节；
     *   3. 用户确认后带 {confirm: {token, typed?}} 真正提交；出错留在框里。
     * @param {string} action
     * @param {object} params
     * @param {{title: string, consequence?: string, render?: (preview: any) => any, details?: (preview: any) => any, okText?: string,
     *          danger?: boolean, askable?: boolean, extra?: (state: {params?: object}) => any}} opts
     * @returns {Promise<any|null>}  提交的结果；取消、被拒绝返回 null
     */
    async confirmed(action, params, opts) {
      const pr = await api.act('prepare', { for: action, params });
      if (!pr.needsConfirm) {
        try { return await api.act(action, params); } catch (e) {
          if (e.code === 'CONFIRM_REQUIRED' && opts.askable && !params.ask) return api.confirmed(action, { ...params, ask: true }, { ...opts, reasons: e.reasons });
          throw e;
        }
      }
      if (pr.refuse) { toast(pr.refuse, { tone: 'bad' }); return null; }
      return new Promise((resolve) => {
        let done = false;
        const state = {};
        const input = pr.phrase ? h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', id: 'rg-phrase', 'aria-describedby': 'rg-phrase-hint' }) : null;
        const msg = h('div', { class: 'err', role: 'alert', hidden: true });
        const ok = btn(opts.okText ?? '确定', { kind: opts.danger === false ? 'primary' : 'danger', disabled: !!pr.phrase });
        const mins = Math.max(1, Math.round(((pr.expiresAt ?? Date.now() + 60_000) - Date.now()) / 60000));
        const layer = dialog({
          title: opts.title,
          body: [
            opts.reasons?.length ? note('warn', [h('div', null, '宿主提醒：'), opts.reasons.map((r) => h('div', null, r))]) : null,
            opts.consequence ? h('p', null, opts.consequence) : null,
            opts.render?.(pr.preview) ?? null,
            opts.extra?.(state) ?? null,
            input ? h('div', { class: 'field' }, h('label', { for: 'rg-phrase' }, `输入「${pr.phrase}」确认`), input, h('div', { class: 'fhint', id: 'rg-phrase-hint' }, '照着输入就行，防止点错。')) : null,
            opts.details ? more('技术细节', h('div', { class: 'fhint' }, opts.details(pr.preview))) : null,
            msg,
          ],
          actions: [h('span', { class: 'sp' }, `${mins} 分钟内有效`), btn('取消', { onclick: () => layer.close() }), ok],
          initial: () => input ?? ok,
          onClose: () => { if (!done) resolve(null); },
        });
        input?.addEventListener('input', () => { ok.disabled = norm(input.value) !== norm(pr.phrase); });
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) ok.click(); });
        ok.addEventListener('click', async () => {
          ok.disabled = true; msg.hidden = true;
          const label = opts.okText ?? '确定';
          clear(ok, h('span', { class: 'spin' }), '处理中…');
          try {
            const r = await api.act(action, { ...params, ...(state.params ?? {}), confirm: { token: pr.token, ...(pr.phrase ? { typed: input.value } : {}) } });
            done = true; resolve(r); layer.close();
          } catch (e) {
            clear(ok, label);
            ok.disabled = !!pr.phrase && norm(input?.value) !== norm(pr.phrase);
            msg.hidden = false;
            clear(msg, e.code === 'CONFIRM_REQUIRED' ? `${errorText(e)}请关掉这个框重新操作。` : errorText(e));
            if (e.code === 'CONFIRM_REQUIRED') ok.disabled = true;
          }
        });
      });
    },
  };
  R.api = api;

  // ════════════════════════════════════════════════════════════════════════
  // 主题：DSH 外壳（client.js）打开时用 ?theme= 带过来，之后变了用 postMessage；拿不到时跟系统
  // ════════════════════════════════════════════════════════════════════════
  /** 外壳发来的主题消息的类型（client.js 用同一个字符串）。 */
  const THEME_MESSAGE = 'rugu:theme';
  /**
   * 校验一条 postMessage 是不是外壳发来的主题（纯函数）：来源必须和本页同源、发送方必须是父窗口、形状必须是 {type: 'rugu:theme', theme: 'light'|'dark'}。
   * 别的消息一律不认（页面只接受「主题」这一种消息）。
   * @returns {'light'|'dark'|null}
   */
  function themeFromMessage(data, origin, selfOrigin, fromParent) {
    if (!fromParent || typeof origin !== 'string' || origin !== selfOrigin) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== THEME_MESSAGE) return null;
    return data.theme === 'light' || data.theme === 'dark' ? data.theme : null;
  }
  const theme = {
    current: null,
    /** 设主题：'light' / 'dark' 设 data-theme；别的值去掉 data-theme（跟系统）。 */
    set(t) {
      theme.current = t === 'light' || t === 'dark' ? t : null;
      if (theme.current) document.documentElement.setAttribute('data-theme', theme.current);
      else document.documentElement.removeAttribute('data-theme');
    },
    /** 现在实际是深色吗（data-theme 或系统）。 */
    isDark() { return theme.current ? theme.current === 'dark' : !!G.matchMedia?.('(prefers-color-scheme: dark)').matches; },
  };
  R.THEME_MESSAGE = THEME_MESSAGE; R.themeFromMessage = themeFromMessage; R.theme = theme;
  /** 用户要求减少动态效果吗。 */
  R.reduceMotion = () => !!G.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // ════════════════════════════════════════════════════════════════════════
  // 组件
  // ════════════════════════════════════════════════════════════════════════
  /**
   * 按钮。kind：primary（主，浅色墨色、深色金色）/ secondary（次）/ ghost（文字）/ danger（危险，实心）/ danger-ghost（危险，文字）。
   * size：'sm'。没有 label 时是方形图标按钮，title 当无障碍名字。
   * @param {string|null} label
   * @param {{kind?: string, size?: string, ic?: string, onclick?: Function, disabled?: boolean, title?: string, type?: string, attrs?: object}} [o]
   */
  function btn(label, { kind = 'secondary', size, ic, onclick, disabled, title, attrs = {} } = {}) {
    return h('button', { type: 'button', class: `btn btn-${kind}${size ? ` btn-${size}` : ''}${!label ? ' btn-icon' : ''}`, onclick, disabled, title, 'aria-label': !label ? title : null, ...attrs },
      ic ? icon(ic, 16) : null, label);
  }
  /**
   * 文字链接（蓝色，带 › 箭头）。to 是路由（'memory/list'、{path, params}）或点击函数；href 是真的地址（旧版页面）。
   * @param {string} label
   * @param {string|{path: string, params?: object}|Function} to
   * @param {{arrow?: boolean, href?: string}} [o]
   */
  function link(label, to, { arrow = true } = {}) {
    if (typeof to === 'string' && /^admin\?/.test(to)) return h('a', { class: 'link', href: to }, label, arrow ? icon('right', 14) : null);
    const onclick = typeof to === 'function' ? to : () => go(typeof to === 'string' ? to : to.path, typeof to === 'string' ? undefined : { params: to.params });
    return h('button', { type: 'button', class: 'link', onclick }, label, arrow ? icon('right', 14) : null);
  }
  /**
   * 页头：标题（h1，换页后焦点落在这里）+ 一句说明 + 可选的分段控件等。
   * @param {string} title @param {string} [desc] @param {any} [extra]
   */
  function pageHead(title, desc, extra) {
    return h('header', { class: 'ph' }, h('h1', { tabindex: '-1', 'data-page-title': '' }, title), desc ? h('p', null, desc) : null, extra);
  }
  /**
   * 分段控件（切同一个去处下的几块；role=tablist，左右键 / Home / End 切换）。放不下时两头渐隐。
   * @param {[string, string, number?][]} options  [键, 名字, 计数?]
   * @param {string} value
   * @param {(key: string) => void} onChange
   * @param {string} label  无障碍名字
   */
  function seg(options, value, onChange, label) {
    const box = h('div', { class: 'seg', role: 'tablist', 'aria-label': label });
    const btns = options.map(([k, text, n]) => {
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === value), tabindex: k === value ? '0' : '-1', 'data-k': k },
        text, n != null ? h('span', { class: 'n' }, String(n)) : null);
      b.addEventListener('click', () => onChange(k));
      return b;
    });
    box.addEventListener('keydown', (e) => {
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % btns.length; else if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = btns.length - 1;
      if (j != null) { e.preventDefault(); btns[j].focus(); btns[j].click(); }
    });
    add(box, btns);
    edgeFade(box);
    // 选中的那一项放不下时滚进来
    requestAnimationFrame(() => { const cur = btns.find((b) => b.getAttribute('aria-selected') === 'true'); if (cur && box.scrollWidth > box.clientWidth) box.scrollLeft = Math.max(0, cur.offsetLeft - 24); });
    return box;
  }
  /** 横向能滚的容器：左边 / 右边还有内容时加 fade-start / fade-end（CSS 用遮罩渐隐）。 */
  function edgeFade(box) {
    const fit = () => {
      box.classList.toggle('fade-start', box.scrollLeft > 1);
      box.classList.toggle('fade-end', box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
    };
    box.addEventListener('scroll', fit, { passive: true });
    if (typeof G.ResizeObserver === 'function') new G.ResizeObserver(fit).observe(box);
    requestAnimationFrame(fit);
  }
  /**
   * 设置用的左侧小导航（窄屏变成上面一排胶囊）。items：[键, 名字, 图标?, 有提醒?]。
   * @returns {HTMLElement} nav 元素（放进 .sidenav-layout 的第一列）
   */
  function sideNav(items, value, onChange, label = '设置的分类') {
    const nav = h('nav', { class: 'snav', 'aria-label': label }, items.map(([k, text, ic, dot]) => h('button', { type: 'button', 'aria-current': k === value ? 'true' : null, onclick: () => onChange(k) },
      ic ? icon(ic, 16) : null, text, dot ? h('span', { class: 'dotw', 'aria-label': '有要看的' }) : null)));
    // 窄屏变成横排时放不下：两头渐隐（README 说已经处理，之前漏了这一句；D173 补上），选中的那一项滚进来
    edgeFade(nav);
    requestAnimationFrame(() => { const cur = nav.querySelector('[aria-current="true"]'); if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, cur.offsetLeft - 24); });
    return nav;
  }
  /**
   * 一节：小标题（h2）+ 右边的小字或链接 + 内容。
   * @param {string|null} title @param {string|Node|null} aside @param {...any} body
   */
  function section(title, aside, ...body) {
    return h('section', { class: 'sec' }, title ? h('div', { class: 'sh' }, h('h2', null, title), aside ? (aside instanceof G.Node ? aside : h('span', { class: 'aside' }, aside)) : null) : null, ...body);
  }
  /** 一行小字元信息：用「·」隔开，空的跳过。 */
  function metaLine(...parts) {
    const xs = parts.flat().filter((x) => x != null && x !== false && x !== '');
    return h('div', { class: 'meta' }, xs.map((p, i) => (i ? [h('span', { class: 'dot', 'aria-hidden': 'true' }), p] : p)));
  }
  /**
   * 列表行（全页唯一一种）：第一行是主文（正文字号），第二行小字元信息，行尾放「⋯」、开关、箭头。onOpen 让整行可点（键盘能聚焦）。
   * @param {{lead?: Node, title: any, strong?: boolean, clamp?: boolean, meta?: Node, tags?: Node[], trail?: any, onOpen?: Function,
   *          sel?: boolean, cls?: string, check?: Node, label?: string}} o
   */
  function row({ lead, title, strong, clamp = true, meta, tags, trail, onOpen, sel, cls = '', check, label }) {
    const titleNode = h('div', { class: `ttl${strong ? ' strong' : ''}${clamp ? ' clamp' : ''}` }, title, tags?.length ? [' ', tags] : null);
    return h('div', { class: `row${onOpen ? ' click' : ''}${sel ? ' sel' : ''}${cls ? ` ${cls}` : ''}` },
      check, lead,
      h('div', { class: 'main' }, onOpen ? h('button', { type: 'button', class: 'hit', onclick: onOpen, 'aria-label': label ?? null }, titleNode) : titleNode, meta),
      trail ? h('div', { class: 'trail' }, trail) : null);
  }
  /** 一组列表行。 */
  const list = (rows) => h('div', { class: 'list' }, rows);
  /** 小标签：tone = '' / ok / warn / bad / gold。 */
  const tag = (text, tone = '') => h('span', { class: `tag ${tone}` }, text);
  /** 带图标的状态字：tone = ok（金色对勾、灰字）/ warn / bad / dim（灰字，不带图标）。状态不只靠颜色：永远带图标或文字。 */
  function status(text, tone = 'ok') {
    const ic = { ok: 'checkc', warn: 'warn', bad: 'alert' }[tone];
    return h('span', { class: `st ${tone}` }, ic ? icon(ic, 14) : null, text);
  }
  /**
   * 开关（role=switch）。点了先翻过去再调 onChange(新值)；onChange 返回 Promise 且失败时翻回来。
   * @param {boolean} checked @param {(v: boolean) => any} onChange @param {string} label  无障碍名字
   */
  function sw(checked, onChange, label, { disabled } = {}) {
    const b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label, disabled });
    b.addEventListener('click', async () => {
      const v = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(v));
      try { await onChange?.(v); } catch (e) { b.setAttribute('aria-checked', String(!v)); toast(errorText(e), { tone: 'bad' }); }
    });
    return b;
  }
  /** 空状态：图标 + 一句粗体 + 一段说明 + 操作。 */
  function empty({ ic = 'info', tone = '', title, text, actions }) {
    return h('div', { class: 'empty' }, h('div', { class: `ic${tone ? ` ${tone}` : ''}` }, icon(ic, 22)), h('b', null, title), text ? h('p', null, text) : null,
      actions ? h('div', { class: 'acts' }, actions) : null);
  }
  /** 加载中。 */
  const loading = (text = '正在读取…') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), text);
  /** 出错、可以重试：给 ApiError 就说人话（errorText）。 */
  function errorBox(e, retry, { title = '这一块读不出来' } = {}) {
    return empty({ ic: 'warn', tone: 'warn', title, text: errorText(e), actions: retry ? btn('重试', { ic: 'refresh', onclick: retry }) : null });
  }
  /** 提示框：tone = info / warn / bad；action 放在右边。 */
  function note(tone, text, action) {
    return h('div', { class: `note ${tone}`, role: tone === 'bad' || tone === 'warn' ? 'status' : null }, icon({ warn: 'warn', bad: 'alert', info: 'info' }[tone] ?? 'info', 16), h('div', { class: 'main' }, text), action);
  }
  /** 折叠区（「更多」「技术细节」）：原生 <details>。 */
  function more(summary, ...body) {
    return h('details', { class: 'more' }, h('summary', null, icon('right', 14), summary), h('div', { class: 'body' }, ...body));
  }
  /**
   * 表单行：左边标签 + 说明，右边控件。stack：控件放到下面一整行。
   * @param {{title: string, hint?: any, control?: any, stack?: boolean, right?: boolean, cls?: string}} o
   */
  function frow({ title, hint, control, stack, right, cls = '' }) {
    return h('div', { class: `frow${stack ? ' stack' : ''}${right ? ' r' : ''}${cls ? ` ${cls}` : ''}` },
      h('div', { class: 'ftext' }, h('div', { class: 'ftitle' }, title), hint ? h('div', { class: 'fhint' }, hint) : null),
      control ? h('div', { class: 'fctl' }, control) : null);
  }
  /** 键值对（详情面板里用）：[[键, 值], …]，空的跳过。 */
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  Object.assign(R, { btn, link, pageHead, seg, edgeFade, sideNav, section, metaLine, row, list, tag, status, sw, empty, loading, errorBox, note, more, frow, kv });

  // ── 浮层：菜单 ───────────────────────────────────────────────────────────
  let openMenu = null;
  function closeMenu(restore = true) {
    if (!openMenu) return;
    const { el, anchor, outside } = openMenu;
    el.remove(); anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    openMenu = null;
    if (restore) anchor.focus({ preventScroll: true });
  }
  /**
   * 弹出菜单（锚在一个按钮上；上下键移动、Esc 关、Tab 关；点外面关）。
   * items：[{label, ic?, onSelect, danger?, checked?（单选菜单）, disabled?}]，或 {sep: true}、{header: '小标题'}、{hint: '小字说明'}。
   * @param {HTMLElement} anchor
   * @param {any[]} items
   * @param {{align?: 'start'|'end'}} [o]
   */
  function menu(anchor, items, { align = 'end' } = {}) {
    if (openMenu?.anchor === anchor) { closeMenu(); return; }
    closeMenu(false);
    const el = h('div', { class: 'menu', role: 'menu' });
    const focusables = [];
    for (const it of items) {
      if (it.sep) { el.append(h('hr')); continue; }
      if (it.header) { el.append(h('div', { class: 'mlabel' }, it.header)); continue; }
      if (it.hint) { el.append(h('div', { class: 'mnote' }, it.hint)); continue; }
      const b = h('button', { type: 'button', role: it.checked != null ? 'menuitemradio' : 'menuitem', 'aria-checked': it.checked != null ? String(!!it.checked) : null,
        'aria-disabled': it.disabled ? 'true' : null, class: it.danger ? 'danger' : '', tabindex: '-1' },
      it.ic ? icon(it.ic, 16) : null, h('span', null, it.label), it.checked ? h('span', { class: 'ck' }, icon('check', 16)) : null);
      b.addEventListener('click', () => { if (it.disabled) return; closeMenu(true); it.onSelect?.(); });
      el.append(b); focusables.push(b);
    }
    el.addEventListener('keydown', (e) => {
      const i = focusables.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); focusables[(i + 1) % focusables.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusables[(i - 1 + focusables.length) % focusables.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); focusables[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); focusables.at(-1)?.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
      else if (e.key === 'Tab') closeMenu(false);
    });
    document.body.append(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth; const ht = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(16, Math.min(left, G.innerWidth - w - 16));
    let top = r.bottom + 6;
    if (top + ht > G.innerHeight - 12 && r.top - ht - 6 > 12) top = r.top - ht - 6;
    Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
    anchor.setAttribute('aria-expanded', 'true');
    const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(false); };
    document.addEventListener('pointerdown', outside, true);
    openMenu = { el, anchor, outside };
    (focusables.find((b) => b.getAttribute('aria-checked') === 'true') ?? focusables[0])?.focus();
  }
  /** 行尾的「⋯」按钮（平时隐藏，悬停 / 聚焦 / 选中时出现）。items 可以是函数（点开时才算）。 */
  function moreButton(items, label = '更多操作') {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-icon btn-sm more-btn', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more', 18));
    b.addEventListener('click', (e) => { e.stopPropagation(); menu(b, typeof items === 'function' ? items() : items); });
    return b;
  }
  /**
   * 下拉筛选：一个胶囊按钮 + 单选菜单。value 不等于 allValue 时按钮高亮并写出选了什么。
   * options：[{value, label}]，可以夹 {sep}、{header}、{hint}；{value, label, run} 选了以后调 run 而不是 onChange。
   */
  function dropdown(name, options, value, onChange, { allValue = '' } = {}) {
    const cur = options.find((o) => !o.sep && !o.header && !o.hint && o.value === value);
    const on = value !== allValue;
    const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, on ? `${name}：${cur?.label ?? ''}` : name, icon('down', 14));
    b.addEventListener('click', () => menu(b, options.map((o) => (o.sep || o.header || o.hint ? o : { label: o.label, checked: o.value === value, onSelect: () => (o.run ? o.run() : onChange(o.value)) })), { align: 'start' }));
    return b;
  }
  Object.assign(R, { menu, closeMenu, moreButton, dropdown });

  // ── 浮层：对话框、侧面板（焦点圈在里面，Esc 关，关掉后焦点回原处） ─────
  const layers = [];
  const FOCUSABLE = 'a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex="-1"])';
  function trap(e, box) {
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll(FOCUSABLE)].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) { e.preventDefault(); return; }
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
  /** 浮层打开时，下面的页面不让 Tab 进去、读屏也不读（inert）。 */
  function setInert(on) { const app = document.getElementById('app'); if (app) app.inert = on; }
  /**
   * 对话框（居中，role=dialog aria-modal）。返回 {close, box}。
   * @param {{title: string, body: any, actions: any, initial?: () => HTMLElement|null, onClose?: Function, dismissible?: boolean}} o
   */
  function dialog({ title, body, actions, initial, onClose, dismissible = true }) {
    closeMenu(false);
    const back = document.activeElement;
    const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const scrim = h('div', { class: 'scrim' });
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
      h('h2', { id }, title), h('div', { class: 'dbody' }, body), h('div', { class: 'dfoot' }, actions));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      scrim.remove(); box.remove();
      const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1);
      if (!layers.length) setInert(false);
      back?.focus?.({ preventScroll: true });
      onClose?.();
    };
    const layer = { close, box };
    if (dismissible) scrim.addEventListener('click', close);
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dismissible) { e.preventDefault(); e.stopPropagation(); close(); } trap(e, box); });
    document.body.append(scrim, box);
    layers.push(layer);
    setInert(true);
    (initial?.() ?? box.querySelector('input, .dfoot .btn'))?.focus();
    return layer;
  }
  /**
   * 普通确认：一句话 + 「取消」「okText」。返回 Promise<boolean>（点了确认才是 true）。
   * @param {{title: string, text: any, okText?: string, danger?: boolean}} o
   */
  function confirmSimple({ title, text, okText = '确定', danger = false }) {
    return new Promise((resolve) => {
      let yes = false;
      const layer = dialog({ title, body: h('p', null, text), onClose: () => resolve(yes),
        actions: [btn('取消', { onclick: () => layer.close() }), btn(okText, { kind: danger ? 'danger' : 'primary', onclick: () => { yes = true; layer.close(); } })] });
    });
  }
  /**
   * 危险操作的确认（本地的，不走服务端确认令牌）：一句后果 + 要确认的东西 + 可选的手输确认语 + 折叠的技术细节。
   * 服务端要确认令牌的操作用 R.api.confirmed（它用的是同一种对话框）。返回 Promise<boolean>。
   * @param {{title: string, consequence: string, item?: any, phrase?: string, okText: string, extra?: any, details?: any}} o
   */
  function confirmDanger({ title, consequence, item, phrase, okText, extra, details }) {
    return new Promise((resolve) => {
      let yes = false;
      const input = phrase ? h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', id: 'rg-phrase-l', 'aria-describedby': 'rg-phrase-l-hint' }) : null;
      const ok = btn(okText, { kind: 'danger', disabled: !!phrase });
      input?.addEventListener('input', () => { ok.disabled = norm(input.value) !== norm(phrase); });
      input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !ok.disabled) ok.click(); });
      const layer = dialog({
        title, onClose: () => resolve(yes), initial: () => input ?? ok,
        body: [h('p', null, consequence), item != null ? h('div', { class: 'item' }, item) : null, extra ?? null,
          input ? h('div', { class: 'field' }, h('label', { for: 'rg-phrase-l' }, `输入「${phrase}」确认`), input, h('div', { class: 'fhint', id: 'rg-phrase-l-hint' }, '照着输入就行，防止点错。')) : null,
          details ? more('技术细节', h('div', { class: 'fhint' }, details)) : null],
        actions: [btn('取消', { onclick: () => layer.close() }), ok],
      });
      ok.addEventListener('click', () => { yes = true; layer.close(); });
    });
  }
  /**
   * 右侧滑出的面板（详情用：能边看列表边看）。打开时焦点落在关闭按钮上，Tab 圈在面板里，Esc / 点外面关，关掉后焦点回到打开它的元素。
   * 同时只开一个：再开新的会先关掉旧的。返回 {close, box, body}。
   * @param {{kicker?: any, body: any, foot?: any, label: string, onClose?: Function}} o
   */
  function sheet({ kicker, body, foot, label, onClose }) {
    closeMenu(false);
    for (const l of layers.filter((x) => x.isSheet)) l.close(false);
    const back = document.activeElement;
    const scrim = h('div', { class: 'scrim light' });
    const closeBtn = btn('', { kind: 'ghost', ic: 'x', size: 'sm', title: '关闭' });
    const bodyEl = h('div', { class: 'sbody' }, body);
    const box = h('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
      h('div', { class: 'shead' }, h('div', { class: 'k' }, kicker), closeBtn), bodyEl, foot ? h('div', { class: 'sfoot' }, foot) : null);
    let closed = false;
    const close = (restore = true) => {
      if (closed) return;
      closed = true;
      box.classList.remove('open'); scrim.remove();
      setTimeout(() => box.remove(), R.reduceMotion() ? 200 : 520);
      const i = layers.indexOf(layer); if (i >= 0) layers.splice(i, 1);
      if (!layers.length) setInert(false);
      if (restore) back?.focus?.({ preventScroll: true });
      onClose?.();
    };
    const layer = { close, box, body: bodyEl, isSheet: true };
    closeBtn.addEventListener('click', () => close());
    scrim.addEventListener('click', () => close());
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !openMenu) { e.preventDefault(); e.stopPropagation(); close(); } trap(e, box); });
    document.body.append(scrim, box);
    layers.push(layer);
    setInert(true);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('open')));
    closeBtn.focus({ preventScroll: true });
    return layer;
  }
  /** 关掉全部浮层（换页时）。 */
  function closeAll() { closeMenu(false); for (const l of [...layers]) l.close(false); }
  Object.assign(R, { dialog, confirmSimple, confirmDanger, sheet, closeAll });

  // ── 提示条（toast）和延迟提交 ─────────────────────────────────────────────
  let toastEl = null; let toastTimer = 0;
  /**
   * 底部的提示条。tone='bad' 是出错（多停一会儿）。有 undo 时带「撤销」按钮，点了调 undo。返回提示条元素。
   * @param {string} text
   * @param {{undo?: Function, undoLabel?: string, tone?: ''|'bad', duration?: number}} [o]
   */
  function toast(text, { undo, undoLabel = '撤销', tone = '', duration } = {}) {
    toastEl?.remove();
    clearTimeout(toastTimer);
    const t = h('div', { class: `toast${undo ? '' : ' solo'}${tone ? ` ${tone}` : ''}`, role: tone === 'bad' ? 'alert' : 'status', 'aria-live': 'polite' },
      tone === 'bad' ? icon('alert', 16) : null, h('span', null, text),
      undo ? h('button', { type: 'button', onclick: () => { t.remove(); undo(); } }, undoLabel) : null);
    document.body.append(t);
    toastEl = t;
    toastTimer = setTimeout(() => t.remove(), duration ?? (undo ? 6000 : tone === 'bad' ? 6000 : 3200));
    return t;
  }
  /** 还没提交的延迟操作（离开页面、换去处时一起立刻提交）。 */
  const pendingCommits = new Set();
  /**
   * 延迟提交（设计说明 8.3 第 2 条）：页面先当它做了（调用方先把那一项收起来），显示带「撤销」的提示条；delay 毫秒后才真的 commit()。
   * 这段时间里点「撤销」：不提交，调 undo()（调用方把那一项放回去）。离开页面、切走（换去处、页面藏起来）时立刻提交。
   * commit 失败：提示出错原因，并调 undo() 把界面放回去。不可恢复的操作不要用它，走确认对话框。
   * @param {{text: string, commit: () => Promise<any>, undo?: () => void, delay?: number, done?: (result: any) => void}} o
   * @returns {{flush: () => Promise<void>, cancel: () => void}}
   */
  function deferred({ text, commit, undo, delay = 6000, done }) {
    let state = 'waiting';
    const job = {
      async flush() {
        if (state !== 'waiting') return;
        state = 'running';
        clearTimeout(timer); pendingCommits.delete(job);
        try { const r = await commit(); done?.(r); } catch (e) { toast(errorText(e), { tone: 'bad' }); undo?.(); }
      },
      cancel() {
        if (state !== 'waiting') return;
        state = 'cancelled';
        clearTimeout(timer); pendingCommits.delete(job);
        undo?.();
      },
    };
    const timer = setTimeout(() => job.flush(), delay);
    pendingCommits.add(job);
    toast(text, { undo: () => job.cancel(), duration: delay });
    return job;
  }
  /** 立刻提交全部还在等的延迟操作。 */
  function flushPending() { for (const j of [...pendingCommits]) j.flush(); }
  Object.assign(R, { toast, deferred, flushPending });

  // ════════════════════════════════════════════════════════════════════════
  // 模块登记和渲染
  // ════════════════════════════════════════════════════════════════════════
  /** 名字 → {factory, def, error, missing}。 */
  const modules = {};
  /**
   * 登记一个去处的模块。factory(R) 在第一次用到时才调用，返回：
   *   {render(el, route) — 把这一页画进 el（可以是 async）；
   *    update?(route)   — 只有参数变了（同一个去处、同一个分段，比如打开了哪条详情）时调；返回 true 表示处理了，否则整页重画；
   *    leave?()         — 离开这一页时调（停计时器、关面板）}。
   * factory 或 render 抛错只坏这一页：显示「这一块没打开」和「重试」，别的去处照常。
   * @param {string} name   去处的键（home / memory / pending / places / settings / wizard）
   * @param {(R: any) => {render: Function, update?: Function, leave?: Function}} factory
   */
  function define(name, factory) { modules[name] = { factory, def: null, error: null, missing: false }; }
  /** page.js 读不到某个模块的文件时登记它（这一页显示「这一块没打开」）。 */
  function missing(name, reason) { if (!modules[name]) modules[name] = { factory: null, def: null, error: null, missing: true, reason: reason ?? null }; }
  function moduleOf(name) {
    const m = modules[name];
    if (!m || m.missing) return { error: { code: 'MISSING', message: m?.reason ?? '模块没有加载' } };
    if (m.def) return { def: m.def };
    try {
      const d = m.factory(R);
      if (!d || typeof d.render !== 'function') throw new TypeError('模块没有 render');
      m.def = d;
      return { def: d };
    } catch (e) {
      G.console?.error?.(`[如故] 模块 ${name} 初始化出错`, e);
      return { error: e };
    }
  }
  R.define = define; R.missing = missing;
  /** 给测试和截图看：每个模块的状态（loaded / missing / error / pending）。 */
  R.moduleStates = () => Object.fromEntries(Object.entries(modules).map(([k, m]) => [k, m.missing ? 'missing' : m.def ? 'loaded' : m.error ? 'error' : 'pending']));

  /**
   * 「这一块正在搬过来」：还没搬到新页面的去处用的占位（页头 + 分段 / 左侧小导航照样稿画，内容区一句话 + 去旧版对应页签的链接）。
   * 搬完的去处不再用它。
   * @param {HTMLElement} el
   * @param {{dest: string, sub: string|null, path: string}} route
   * @param {{title: string, desc?: string, subDesc?: Record<string, string>, sideNav?: boolean}} o
   */
  function placeholderPage(el, route, { title, desc, subDesc = {}, sideNav: useSide = false }) {
    const subs = SUBS[route.dest] ?? [];
    const subName = subs.find(([k]) => k === route.sub)?.[1] ?? title;
    const body = h('div', { class: 'narrow' }, empty({
      ic: 'construction', title: '这一块正在搬过来',
      text: '新版的这一页还在做，功能都还在旧版里。',
      actions: h('a', { class: 'btn btn-secondary', href: classicHref(route.path, theme.current) }, '去旧版里看', icon('right', 14)),
    }));
    if (useSide) {
      const nav = sideNav(subs.map(([k, t, ic]) => [k, t, ic]), route.sub, (k) => go(`${route.dest}/${k}`, { focus: false }));
      clear(el, h('div', { class: 'wrap' }, h('div', { class: 'sidenav-layout' }, nav,
        h('div', { class: 'scontent' }, pageHead(subName, subDesc[route.sub] ?? desc), body))));
      return;
    }
    const segEl = subs.length ? seg(subs.map(([k, t]) => [k, t]), route.sub, (k) => go(`${route.dest}/${k}`, { focus: false }), `${title}的分类`) : null;
    clear(el, h('div', { class: 'wrap' }, pageHead(title, subDesc[route.sub] ?? desc, segEl), body));
  }
  R.placeholderPage = placeholderPage;

  // ════════════════════════════════════════════════════════════════════════
  // 页面：顶部、主导航、渲染、换页
  // ════════════════════════════════════════════════════════════════════════
  let topEl = null; let mainEl = null; let navEl = null;
  let cur = null;          // 当前路由
  let curDef = null;       // 当前模块
  let focusTitle = false;
  const counts = { pending: 0 };
  /**
   * 换页：go('memory/people')、go('memory/list', {params: {open: 'a12'}})、go('home', {replace: true})。
   * 改的是地址栏的 hash：刷新、前进后退都对。
   */
  function go(path, { params, replace = false, focus = true } = {}) {
    const hash = buildHash(path, params);
    focusTitle = focus;
    if (G.location.hash === hash) { render(); return; }
    if (replace) { G.history.replaceState(null, '', hash); onHash(); } else G.location.hash = hash;
  }
  /** 改当前页的参数（不换页、不重画，模块的 update 处理；replace 默认 true：不在历史里多留一步）。 */
  function setParams(params, { replace = true } = {}) {
    const next = { ...(cur?.params ?? {}), ...params };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
    const hash = buildHash(cur?.path ?? 'home', next);
    if (G.location.hash === hash) return;
    if (replace) { G.history.replaceState(null, '', hash); onHash(); } else G.location.hash = hash;
  }
  /** 当前路由（{dest, sub, params, path}）。 */
  R.route = () => cur;
  R.go = go; R.setParams = setParams;
  /** 设主导航上「待处理」的数字（首页、待处理页读到总数后调）。 */
  R.setPendingCount = (n) => { counts.pending = Math.max(0, Number(n) || 0); renderTop(); };

  function renderTop() {
    if (!topEl) return;
    const dest = cur?.dest ?? 'home';
    const inWizard = dest === 'wizard';
    navEl = inWizard ? h('div', { class: 'nav', style: { alignItems: 'center' } }, h('span', { class: 'muted', style: { fontSize: '14px' } }, '首次设置'))
      : h('nav', { class: 'nav', 'aria-label': '主导航' }, DESTS.map(([k, label, ic]) => {
        const n = k === 'pending' ? counts.pending : 0;
        return h('button', { type: 'button', 'aria-current': dest === k ? 'page' : null, onclick: () => go(k) },
          icon(ic, 16), label, n ? h('span', { class: 'count', 'aria-label': `${n} 件` }, n > 99 ? '99+' : String(n)) : null);
      }));
    // 回旧版：新页面还在搬的这段时间留着（全部搬完、旧页删掉时去掉）
    const back = h('a', { class: 'uiswitch', href: classicHref(cur?.path ?? 'home', theme.current), title: '回到旧版管理页（新版还在搬，没搬完的去处在旧版里）', onclick: () => rememberUi('classic') },
      icon('undo', 14), h('span', null, '回旧版'));
    clear(topEl, h('div', { class: 'top-in' }, h('div', { class: 'brand' }, brandMark(28), h('b', null, '如故')), navEl, back));
  }
  /** 记下主人选的版本（DSH 外壳下次打开时按它给地址；同源的 localStorage）。 */
  function rememberUi(v) { try { G.localStorage.setItem('rugu.admin.ui', v); } catch { /* 存不了就算了 */ } }
  R.rememberUi = rememberUi;

  const TITLES = Object.fromEntries([...DESTS.map(([k, v]) => [k, v]), ['wizard', '首次设置']]);
  /** 画当前去处。模块抛错只坏这一块。 */
  async function render() {
    if (!mainEl) return;
    const route = cur;
    closeAll();
    renderTop();
    document.title = `如故 · ${TITLES[route.dest] ?? ''}`;
    const el = h('div', { class: 'view', 'data-dest': route.dest });
    clear(mainEl, el);
    const { def, error } = moduleOf(route.dest);
    curDef = def ?? null;
    if (error) { clear(el, broken(route, error)); return; }
    try {
      await def.render(el, route);
    } catch (e) {
      G.console?.error?.(`[如故] ${route.dest} 画的时候出错`, e);
      if (cur === route) clear(el, broken(route, e));
    }
    if (cur === route && focusTitle) {
      focusTitle = false;
      el.querySelector('[data-page-title]')?.focus({ preventScroll: true });
    }
  }
  /** 「这一块没打开」：一句话 + 重试 + 去旧版里看。 */
  function broken(route, e) {
    const mod = modules[route.dest];
    return h('div', { class: 'wrap broken' }, empty({
      ic: 'warn', tone: 'warn', title: '这一块没打开',
      text: e?.code === 'MISSING' || mod?.missing ? '这一页的脚本没有加载，别的页照常能用。' : `这一页出错了（${String(e?.name ?? 'Error')}），别的页照常能用。`,
      actions: [btn('重试', { ic: 'refresh', onclick: () => { if (mod && !mod.missing) { mod.def = null; mod.error = null; } render(); } }),
        h('a', { class: 'btn btn-ghost', href: classicHref(route.path, theme.current) }, '去旧版里看')],
    }));
  }
  function onHash() {
    const next = parseHash(G.location.hash);
    const prev = cur;
    cur = next;
    if (prev && prev.path === next.path && curDef?.update) {
      let handled = false;
      try { handled = curDef.update(next) === true; } catch (e) { G.console?.error?.('[如故] update 出错', e); }
      if (handled) return;
    }
    if (prev && prev.dest !== next.dest) {
      flushPending();
      try { curDef?.leave?.(); } catch (e) { G.console?.error?.('[如故] leave 出错', e); }
    }
    render();
  }

  /**
   * 启动（page.js 拼的最后一个脚本调它）：读令牌和主题、画顶部、按 hash 画当前去处、接上 hashchange / 主题消息 / 离开时提交。
   */
  function start() {
    TOKEN = document.querySelector('meta[name="pm-admin-token"]')?.getAttribute('content') ?? '';
    const q = new URLSearchParams(G.location.search);
    theme.set(q.get('theme'));
    const selfOrigin = G.location.origin;
    G.addEventListener('message', (ev) => {
      const t = themeFromMessage(ev.data, ev.origin, selfOrigin, ev.source != null && ev.source === G.parent && G.parent !== G);
      if (t) { theme.set(t); renderTop(); }
    });
    const app = document.getElementById('app');
    topEl = h('header', { class: 'top' });
    mainEl = h('main', { id: 'main' });
    clear(app, topEl, mainEl);
    app.removeAttribute('aria-busy');
    G.addEventListener('scroll', () => topEl.classList.toggle('scrolled', G.scrollY > 4), { passive: true });
    G.addEventListener('hashchange', onHash);
    // 离开页面、页面藏起来（DSH 换到别的设置项）时，还在等的延迟操作立刻提交
    G.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
    // 记下「在用新版」（DSH 外壳下次按它给地址）
    if (q.get('ui') === 'next') rememberUi('next');
    cur = parseHash(G.location.hash);
    // D173：首次设置模式（page.js 放的标记：还没有核心，别的去处都打不开）——一打开就进向导
    if (document.querySelector('meta[name="rugu-setup-mode"]') && cur.dest !== 'wizard') { cur = parseHash('#/wizard'); G.history.replaceState(null, '', buildHash(cur.path)); }
    if (!G.location.hash) G.history.replaceState(null, '', buildHash(cur.path));
    render();
  }
  R.start = start;

  G.Rugu = R;
})(typeof window !== 'undefined' ? window : globalThis);
