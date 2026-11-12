// dsh-rugu 的界面入口：DSH 设置侧边栏里的「如故」（英文界面是「Rugu」，D167）。
// DSH 的浏览器插件格式是 window.__ModuleLoader__.load({ id, factory })；这里手写，不需要构建步骤（照 dsh-bili-eyes 的写法）。
// 管理页本身是主人专用 Fetch 路由给的一个页面（src/admin/page.html，§13.1）；这里只放一个同源 iframe 指向它，
// 并把 DSH 的主题变量（颜色、深浅色）抄进 iframe，让它看起来和设置页是一体的。数据都在 iframe 里经主人专用路由读写。
window.__ModuleLoader__.load({
  id: 'dsh-rugu',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const { useEffect, useRef, useState } = React;
    const h = React.createElement;

    // 相对路径（DSH 可能挂在子路径下；宿主自己的 deliverables 客户端也这么写）
    const PAGE = 'api/rugu/admin';
    // 设置左栏里的名字跟着 DSH 的语言（D167）；没有 locale 服务、或者解析出错时一律用中文名
    const NAME = Object.freeze({ en: 'Rugu', zh: '如故' });
    // 管理页用到的 DSH 主题变量
    const VARS = [
      'label-primary', 'label-secondary', 'label-tertiary', 'label-caption', 'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-module-platform',
      'border-l1', 'border-l2', 'border-l3', 'brand-primary', 'label-primary-foreground', 'link', 'state-success-primary', 'state-error-primary',
      'state-warn-primary', 'state-warn-label', 'state-business-primary', 'interactive-bg-hover', 'interactive-bg-active', 'interactive-bg-hover-danger',
      'bg-mask-1', 'toast-bg', 'toast-label',
    ].map((n) => `--dsw-alias-${n}`).concat(['--dsw-font-family', '--ds-font-family-code']);
    // 不透明的颜色：rgb()、alpha 为 1 的 rgba()，以及没有「/ alpha」（或 alpha 为 1）的 color() / oklch() / oklab() / lab() / lch() / hsl()
    const opaque = (c) => {
      c = String(c || '').trim();
      if (!c || c === 'transparent') return false;
      if (/^rgb\(/.test(c)) return true;
      if (/^rgba\(/.test(c)) return Number(c.split(',')[3]?.replace(')', '')) >= 1;
      const m = /^(?:color|oklch|oklab|lab|lch|hsl|hsla)\((.*)\)$/.exec(c);
      if (!m) return false;
      const a = m[1].split('/')[1];
      if (a == null) return !/^hsla\(/.test(c) || m[1].split(',').length < 4;
      const v = a.trim();
      return v.endsWith('%') ? parseFloat(v) >= 100 : Number(v) >= 1;
    };

    /** 父页面的主题 → iframe 的 body（同源，可以直接写）。 */
    function syncTheme(frame) {
      let doc;
      try { doc = frame.contentDocument; } catch { return; }
      const body = doc && doc.body;
      if (!body) return;
      const cs = getComputedStyle(document.body);
      for (const v of VARS) {
        const val = cs.getPropertyValue(v).trim();
        if (val) body.style.setProperty(v, val); else body.style.removeProperty(v);
      }
      const dark = document.body.hasAttribute('data-ds-dark-theme');
      body.toggleAttribute('data-ds-dark-theme', dark);
      body.toggleAttribute('data-ds-light-theme', !dark);
      body.setAttribute('data-pm-embedded', '');
      // 页面底色 = iframe 外面最近的不透明背景（设置面板），sticky 的页签栏要用它
      for (let n = frame.parentElement; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        if (opaque(c)) { body.style.setProperty('--pm-page', c); return; }
      }
      body.style.removeProperty('--pm-page');
    }

    // ── D170：新旧两版管理页并存 + 深浅色同步 ───────────────────────────────
    // DSH 的界面怎么表示深浅色（dsh-client-ui-layout 的 ThemePresenter）：解析好的配色写在 body 上，深色时有 data-ds-dark-theme；
    // <html> 上的 data-ds-theme-source 是主人的偏好（light / dark / system）。这里只看 body 的那个属性。
    const DARK_ATTR = 'data-ds-dark-theme';
    /** 和页面（ui/base.js 的 THEME_MESSAGE）约定的消息类型。页面只认同源、来自父窗口、这个形状的消息。 */
    const THEME_MESSAGE = 'rugu:theme';
    const themeNow = () => (document.body && document.body.hasAttribute(DARK_ATTR) ? 'dark' : 'light');
    /** 主人上次选的是新版还是旧版（页面里点「回旧版」「试试新版」时记下的；同源的 localStorage）。没选过返回 null：按服务端的配置。 */
    function chosenUi() {
      try { const v = window.localStorage.getItem('rugu.admin.ui'); return v === 'next' || v === 'classic' ? v : null; } catch { return null; }
    }
    /** iframe 的地址：主题跟着带上（页面一打开就是对的颜色）；主人选过版本就带上 ui。 */
    function pageUrl() {
      const q = new URLSearchParams();
      const ui = chosenUi();
      if (ui) q.set('ui', ui);
      q.set('theme', themeNow());
      return `${PAGE}?${q}`;
    }
    /** 主题变了：告诉新版页面（postMessage，只发给同源）。旧版页面靠 syncTheme 直接写属性，不看这条消息。 */
    function postTheme(frame) {
      try { frame.contentWindow && frame.contentWindow.postMessage({ type: THEME_MESSAGE, theme: themeNow() }, window.location.origin); } catch { /* iframe 还没好 */ }
    }

    /** iframe 填满设置面板剩下的高度（管理页自己有吸顶的页签栏，在 iframe 里滚动）。 */
    function fit(frame) {
      let scroller = frame.parentElement;
      while (scroller && scroller !== document.body) {
        const oy = getComputedStyle(scroller).overflowY;
        if (oy === 'auto' || oy === 'scroll') break;
        scroller = scroller.parentElement;
      }
      const inBox = !!scroller && scroller !== document.body;
      const bottom = inBox ? scroller.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(scroller).paddingBottom) || 0) : window.innerHeight - 16;
      // 顶部按「滚到最上面时」的位置算，免得外层滚动之后越算越高
      const top = frame.getBoundingClientRect().top + (inBox ? scroller.scrollTop : 0);
      // 下限放低到 360：面板矮时宁可 iframe 矮一点，也不要让外面的面板再出一根滚动条
      frame.style.height = `${Math.max(360, Math.floor(bottom - top))}px`;
    }

    function MemoryAdmin() {
      const ref = useRef(null);
      const [failed, setFailed] = useState(false);
      // 地址只在挂上时算一次（主题之后变了走 postMessage，不重新加载 iframe）
      const [src] = useState(pageUrl);
      useEffect(() => {
        const frame = ref.current;
        if (!frame) return undefined;
        let raf = 0;
        let lastTheme = themeNow();
        const later = () => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            syncTheme(frame); fit(frame);
            const t = themeNow();
            if (t !== lastTheme) { lastTheme = t; postTheme(frame); }
          });
        };
        const onLoad = () => {
          let ok = true;
          try { ok = !!frame.contentDocument && frame.contentDocument.title !== '' && !/^\s*\{/.test(frame.contentDocument.body?.textContent ?? ''); } catch { ok = false; }
          setFailed(!ok);
          // 页面里换了版本（「回旧版」「试试新版」是 iframe 里的链接）以后也对上颜色
          lastTheme = themeNow();
          postTheme(frame);
          later();
        };
        frame.addEventListener('load', onLoad);
        const mo = new MutationObserver(later);
        mo.observe(document.documentElement, { attributes: true });
        mo.observe(document.body, { attributes: true });
        const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        if (mq && mq.addEventListener) mq.addEventListener('change', later);
        window.addEventListener('resize', later);
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null;
        if (ro && frame.parentElement) ro.observe(frame.parentElement);
        later();
        return () => {
          cancelAnimationFrame(raf);
          frame.removeEventListener('load', onLoad);
          mo.disconnect();
          if (mq && mq.removeEventListener) mq.removeEventListener('change', later);
          window.removeEventListener('resize', later);
          if (ro) ro.disconnect();
        };
      }, []);
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
        failed && h('div', { role: 'alert', style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #ec1313)' } }, '如故的管理页没有打开：插件可能还没加载完，或者这个窗口不是主人身份。彻底重启 DSH 后再试。'),
        h('iframe', { ref, src, title: NAME.zh, style: { width: '100%', height: 640, border: 0, display: 'block', background: 'transparent', colorScheme: 'normal' } }));
    }

    // 只硬性依赖 slots。locale 不写进 inject：Cordis 的 inject 都是必需的，写进去以后哪个 DSH 版本没有 locale 服务，
    // 整个入口就不加载、设置里的这一项会消失。改成在里面单独等它：有了就用，没有（或者被卸掉）就退回中文名。
    const inject = ['slots'];
    function apply(ctx) {
      let locale = null;
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['locale'], (sub) => {
            const face = sub.locale;
            locale = face;
            const off = () => { if (locale === face) locale = null; };
            if (typeof sub.effect === 'function') sub.effect(() => off, 'dsh-rugu: locale');
            else if (typeof sub.on === 'function') sub.on('dispose', off);
          });
        }
      } catch { locale = null; }
      // 设置面板每次换语言都会重新取一遍 label（它订阅了 locale 的变化），这里每次现算
      const label = () => {
        try {
          const text = locale && typeof locale.resolveText === 'function' ? locale.resolveText(NAME) : '';
          return typeof text === 'string' && text ? text : NAME.zh;
        } catch { return NAME.zh; }
      };
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-rugu',
        order: 118,
        label,
        inject: () => ({}),
      }, MemoryAdmin));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.MemoryAdmin = MemoryAdmin;
    exports.PAGE = PAGE;
    exports.pageUrl = pageUrl;
    exports.THEME_MESSAGE = THEME_MESSAGE;
    exports.NAME = NAME;
    return module.exports;
  },
});
