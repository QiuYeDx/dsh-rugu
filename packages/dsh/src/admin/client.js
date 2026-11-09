// dsh-rugu 的界面入口：DSH 设置侧边栏里的「记忆」。
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
    const PAGE = 'api/persona-memory/admin';
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
      useEffect(() => {
        const frame = ref.current;
        if (!frame) return undefined;
        let raf = 0;
        const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { syncTheme(frame); fit(frame); }); };
        const onLoad = () => {
          let ok = true;
          try { ok = !!frame.contentDocument && frame.contentDocument.title !== '' && !/^\s*\{/.test(frame.contentDocument.body?.textContent ?? ''); } catch { ok = false; }
          setFailed(!ok);
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
        failed && h('div', { role: 'alert', style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #ec1313)' } }, '记忆管理页没有打开：插件可能还没加载完，或者这个窗口不是主人身份。彻底重启 DSH 后再试。'),
        h('iframe', { ref, src: PAGE, title: '记忆管理', style: { width: '100%', height: 640, border: 0, display: 'block', background: 'transparent', colorScheme: 'normal' } }));
    }

    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-rugu',
        order: 118,
        label: () => '记忆',
        inject: () => ({}),
      }, MemoryAdmin));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.MemoryAdmin = MemoryAdmin;
    exports.PAGE = PAGE;
    return module.exports;
  },
});
