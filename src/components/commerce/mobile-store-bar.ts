/** Own only the body-level bar; leave source links and their tracking intact. */
export function mountMobileStoreBar(root: HTMLElement, className: string) {
  const bar = document.createElement('aside');
  bar.className = className;
  bar.dataset.mobileStoreBar = '';
  bar.dir = 'rtl';
  bar.setAttribute('aria-label', 'מעבר למוצר בחנות');
  bar.hidden = true;
  const name = document.createElement('span');
  const link = document.createElement('a');
  link.textContent = 'למוצר בחנות';
  bar.append(name, link);
  document.body.appendChild(bar);
  const mobile = window.matchMedia('(max-width:767px)');
  let original: HTMLAnchorElement | undefined;
  let passed = false;
  const sync = () => { bar.hidden = !mobile.matches || !original || !passed; };
  // Extending only the bottom detects fast jumps from below to above the
  // viewport, even when the source link never intersects the visible screen.
  const observer = new IntersectionObserver(entries => {
    const entry = entries.find(value => value.target === original);
    if (!entry) return;
    passed = !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
    sync();
  }, { threshold: 0, rootMargin: '0px 0px 100000px 0px' });
  const bind = () => {
    const next = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).find(anchor => {
      try {
        const url = new URL(anchor.href);
        return url.protocol === 'https:' && url.hostname === 'www.toptik.co.il' && url.pathname.startsWith('/products/') &&
          anchor.getBoundingClientRect().height > 0 && getComputedStyle(anchor).visibility !== 'hidden' &&
          !anchor.closest('[aria-hidden="true"]');
      } catch { return false; }
    });
    if (next !== original) {
      observer.disconnect();
      original = next;
      if (original) observer.observe(original);
    }
    if (original) {
      const title = original.dataset.productName || original.querySelector('img')?.alt || original.textContent?.trim() || 'המוצר';
      if (name.textContent !== title) name.textContent = title;
      if (link.href !== original.href) link.href = original.href;
      link.setAttribute('aria-label', `למוצר בחנות: ${title}`);
    }
    passed = !!original && original.getBoundingClientRect().bottom < 0;
    sync();
  };
  const mutations = new MutationObserver(bind);
  mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'aria-hidden', 'style'] });
  document.addEventListener('DOMContentLoaded', bind);
  window.addEventListener('load', bind);
  window.addEventListener('pageshow', bind);
  window.addEventListener('resize', bind);
  mobile.addEventListener('change', bind);
  bind();
  return () => {
    observer.disconnect();
    mutations.disconnect();
    document.removeEventListener('DOMContentLoaded', bind);
    window.removeEventListener('load', bind);
    window.removeEventListener('pageshow', bind);
    window.removeEventListener('resize', bind);
    mobile.removeEventListener('change', bind);
    bar.remove();
  };
}
