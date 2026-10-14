/** One controller shared by Shopify and the gallery. No network, tracking or review submission. */
export function validReviewBranches(branches) {
  if (!Array.isArray(branches) || branches.length !== 3) return false;
  const ids = new Set();
  return branches.every(b => {
    try {
      const u = new URL(b.reviewUrl);
      if (ids.has(b.id)) return false;
      ids.add(b.id);
      return b.verified === true && !!b.name && !!b.address &&
        u.protocol === 'https:' && !u.username && !u.password &&
        u.hostname === 'g.page' && /^\/r\/[A-Za-z0-9_-]+\/review$/.test(u.pathname) &&
        !u.search && !u.hash && /^\/reviews\/[a-z]+\.svg$/.test(b.qrPath);
    } catch { return false; }
  });
}

export function mountReviewWidget(host, branches, options = {}) {
  // Do not publish a partial selector or generate guessed review destinations.
  if (!validReviewBranches(branches)) return () => {};
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  if (!win || !win.HTMLDialogElement || doc.getElementById('toptik-review-dialog')) return () => {};
  const make = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const button = (cls, text) => { const el = make('button', cls, text); el.type = 'button'; return el; };
  const header = button('tt-review-header', 'דרגו אותנו בגוגל');
  const floating = button('tt-review-fab', 'דרגו אותנו בגוגל');
  [header, floating].forEach(el => {
    const star = make('span', 'tt-review-star', '★');
    star.setAttribute('aria-hidden', 'true');
    el.prepend(star);
  });
  const dialog = make('dialog', 'tt-review-dialog');
  dialog.id = 'toptik-review-dialog'; dialog.dir = 'rtl';
  dialog.setAttribute('aria-labelledby', 'tt-review-title');
  const content = make('div', 'tt-review-content');
  const close = button('tt-review-close', '×'); close.setAttribute('aria-label', 'סגירת חלונית הדירוג');
  const title = make('h2', '', 'איך הייתה החוויה שלכם ב־TopTik?'); title.id = 'tt-review-title';
  const intro = make('p', '', 'נשמח לשמוע. בחרו את הסניף שבו קיבלתם שירות:');
  const choices = make('div', 'tt-review-choices');
  const detail = make('section', 'tt-review-detail'); detail.hidden = true;
  const branchTitle = make('h3'); branchTitle.tabIndex = -1;
  const qr = make('img', 'tt-review-qr'); qr.width = 224; qr.height = 224;
  const qrStatus = make('p'); qrStatus.setAttribute('role','status');
  qr.onload = () => { qr.hidden = false; qrStatus.hidden = true; };
  qr.onerror = () => { qr.hidden = true; qrStatus.hidden = false; qrStatus.textContent = 'הקוד לא נטען. אפשר לכתוב ביקורת באמצעות הקישור למטה.'; };
  const hint = make('p', '', 'סרקו את הקוד במצלמת הטלפון, או לחצו כאן:');
  const link = make('a', 'tt-review-direct', 'כתבו ביקורת ב־Google');
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  const back = button('tt-review-back', 'בחירת סניף אחר');
  detail.append(branchTitle, qrStatus, qr, hint, link, back);
  const note = make('p', 'tt-review-note', 'הביקורת נכתבת ב־Google ונפתחת בלשונית חדשה. ייתכן שתידרש התחברות לחשבון Google.');
  content.append(close, title, intro, choices, detail, note); dialog.append(content);
  let lastChoice = null;
  const branchChoices = new Map();
  branches.forEach(b => {
    const choice = button('tt-review-choice', `${b.name}, ${b.address}`);
    choice.onclick = () => {
      lastChoice = choice;
      branchTitle.textContent = `${b.name}, ${b.address}`;
      qr.hidden = true; qrStatus.hidden = false; qrStatus.textContent = 'טוען קוד QR';
      qr.removeAttribute('src');
      qr.src = options.qrSources?.[b.id] || `${options.assetOrigin || ''}${b.qrPath}`;
      qr.alt = `קוד QR לכתיבת ביקורת על סניף ${b.name}`;
      link.href = b.reviewUrl;
      choices.hidden = true; intro.hidden = true; detail.hidden = false;
      branchTitle.focus();
    };
    choices.append(choice);
    branchChoices.set(b.id, choice);
  });
  const reset = () => { choices.hidden = false; intro.hidden = false; detail.hidden = true; };
  back.onclick = () => { reset(); lastChoice?.focus(); };
  let opener = null, restoreScroll = null, frame = 0, disposed = false;
  const visible = el => !!el && !el.hidden && el.getClientRects().length > 0 && win.getComputedStyle(el).visibility !== 'hidden';
  const blocked = () => Array.from(doc.querySelectorAll(
    'dialog[open], [role="dialog"], .product-modal-backdrop, .tech-specs-backdrop, header [aria-expanded="true"], header details[open], .carousel-page [aria-expanded="true"], .drawer.is-open, .drawer--is-open, .modal.is-open'
  )).some(el => el !== dialog && !dialog.contains(el) && visible(el));
  const update = () => {
    frame = 0;
    const busy = blocked();
    header.hidden = busy;
    floating.hidden = busy || dialog.open;
    if (busy && dialog.open) dialog.close();
    // Reserve room above the mobile purchase bar. Other overlay states hide the control.
    if (!floating.hidden) {
      const r = floating.getBoundingClientRect();
      const candidates = doc.querySelectorAll('a,button,input,select,textarea');
      floating.hidden = Array.from(candidates).some(el => {
        if (el === floating || host.contains(el) || dialog.contains(el) || !visible(el)) return false;
        const p = el.getBoundingClientRect();
        return p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top;
      });
    }
  };
  const schedule = () => { if (!disposed && !frame) frame = win.requestAnimationFrame(update); };
  const open = e => {
    if (blocked()) return;
    opener = e.currentTarget; reset(); dialog.showModal();
    const y = win.scrollY, x = win.scrollX;
    const bodyStyle = doc.body.style;
    const old = ['position','top','left','width','overflow'].map(k => [k,bodyStyle.getPropertyValue(k),bodyStyle.getPropertyPriority(k)]);
    bodyStyle.position = 'fixed'; bodyStyle.top = `${-y}px`; bodyStyle.left = `${-x}px`; bodyStyle.width = '100%'; bodyStyle.overflow = 'hidden';
    restoreScroll = () => {
      old.forEach(([k,v,p]) => v ? bodyStyle.setProperty(k,v,p) : bodyStyle.removeProperty(k));
      win.scrollTo({left:x,top:y,behavior:'instant'});
    };
    close.focus(); schedule();
  };
  header.onclick = open; floating.onclick = open; close.onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    restoreScroll?.(); restoreScroll = null;
    if (disposed) return;
    // Let restored scroll/layout settle before collision checks and focus.
    // The floating opener is hidden while the modal is open.
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      if (disposed || dialog.open) { frame = 0; return; }
      update();
      if (!blocked()) {
        console.debug('review-focus-diagnostic', JSON.stringify({ opener: opener?.className, connected: opener?.isConnected, hidden: opener?.hidden, rect: opener?.getBoundingClientRect().toJSON(), y: win.scrollY }));
        const target = opener?.isConnected && visible(opener) ? opener : header;
        if (visible(target)) target.focus({preventScroll:true});
      }
    });
  });
  [header,floating].forEach(el => { el.setAttribute('aria-haspopup','dialog'); el.setAttribute('aria-controls',dialog.id); });
  host.append(header); doc.body.append(floating,dialog);
  const directButtons = [];
  const phones = {gan:'035097701',ramat:'036030095',weiz:'036958888'};
  // Only verified branch/contact pages, never product/cart content.
  const page = decodeURIComponent(win.location.pathname);
  const pages = {gan:'/pages/חנות-מזוודות-גן-העיר',ramat:'/pages/חנות-מזוודות-רמת-אביב',weiz:'/pages/חנות-מזוודות-ויצמן-איכילוב'};
  for (const b of branches) {
    if (page !== '/pages/contact' && page !== pages[b.id]) continue;
    const phone = doc.querySelector(`main a[href="tel:${phones[b.id]}"]`);
    if (!phone) continue;
    const direct = button('tt-review-header', 'כתבו ביקורת על הסניף ב־Google');
    direct.setAttribute('aria-haspopup','dialog'); direct.setAttribute('aria-controls',dialog.id);
    direct.onclick = e => { open(e); if (dialog.open) branchChoices.get(b.id).click(); };
    phone.after(direct); directButtons.push(direct);
  }
  // Exclude our own state mutations, preventing observer loops.
  const observer = new win.MutationObserver(records => {
    if (records.some(r => r.target !== floating && r.target !== header && !dialog.contains(r.target))) schedule();
  });
  observer.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','open','aria-expanded','aria-hidden']});
  win.addEventListener('scroll',schedule,{passive:true}); win.addEventListener('resize',schedule);
  update();
  return () => {
    disposed = true;
    observer.disconnect(); win.cancelAnimationFrame(frame);
    win.removeEventListener('scroll',schedule); win.removeEventListener('resize',schedule);
    if (dialog.open) dialog.close(); restoreScroll?.(); restoreScroll = null;
    header.remove(); floating.remove(); dialog.remove(); directButtons.forEach(el => el.remove());
  };
}
