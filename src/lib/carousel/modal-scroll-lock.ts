/** Freeze the background on mobile Safari as well as desktop browsers.
 * The owner holds one lock while either product dialog is open, including
 * transitions between products and the nested technical specifications.
 */
export function lockModalScroll(win: Window): () => void {
  const body = win.document.body;
  const root = win.document.documentElement;
  const x = win.scrollX;
  const y = win.scrollY;
  const previousSavedY = body.dataset.modalScrollY;
  body.dataset.modalScrollY = String(y);
  const changed: Array<[CSSStyleDeclaration, string, string, string]> = [];
  const set = (style: CSSStyleDeclaration, property: string, value: string) => {
    changed.push([style, property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
    style.setProperty(property, value);
  };
  set(root.style, "overflow", "hidden");
  set(body.style, "position", "fixed");
  set(body.style, "top", `${-y}px`);
  set(body.style, "left", `${-x}px`);
  set(body.style, "width", "100%");
  set(body.style, "overflow", "hidden");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (previousSavedY === undefined) delete body.dataset.modalScrollY;
    else body.dataset.modalScrollY = previousSavedY;
    for (const [style, property, value, priority] of changed.reverse()) {
      if (value) style.setProperty(property, value, priority);
      else style.removeProperty(property);
    }
    // An instant restore must not inherit the page's smooth-scroll setting.
    win.scrollTo({ left: x, top: y, behavior: "instant" });
  };
}
