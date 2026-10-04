"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CATEGORIES, categorizeItem, filterByCategory, type CategoryKey } from "@/lib/carousel/categories";
import { availableSeries, filterBySeries } from "@/lib/carousel/series";
import type { CarouselItem } from "@/lib/carousel/types";
import styles from "./CompactFilters.module.css";

type CategoryNavProps = {
  items: CarouselItem[];
  active: CategoryKey;
  activeSeries: string;
  brandLabel?: string;
  onApply: (series: string, category: CategoryKey) => void;
};
type Panel = "series" | "category";

function positionPanel(element: HTMLDialogElement, button: HTMLButtonElement) {
  const bounds = button.getBoundingClientRect();
  const width = Math.min(480, window.innerWidth - 32);
  const top = Math.max(16, Math.min(bounds.bottom + 8, window.innerHeight - 340));
  element.style.setProperty("--filter-left", String(Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16))) + "px");
  element.style.setProperty("--filter-top", String(top) + "px");
  element.style.setProperty("--filter-height", String(window.innerHeight - top - 16) + "px");
}

export function CategoryNav({ active, items, activeSeries, brandLabel, onApply }: CategoryNavProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draftSeries, setDraftSeries] = useState(activeSeries);
  const [draftCategory, setDraftCategory] = useState(active);
  const series = availableSeries(items);
  const draftItems = filterBySeries(items, draftSeries);
  const available = new Set(draftItems.map(categorizeItem));
  const categories = CATEGORIES.filter(c => c.key === "all" || available.has(c.key));
  const count = filterByCategory(draftItems, draftCategory).length;
  const seriesLabel = series.find(s => s.key === activeSeries)?.label;
  const categoryLabel = CATEGORIES.find(c => c.key === active)?.label;
  const seriesTitle = brandLabel ? `בחירת סדרה, ${brandLabel}` : "בחירת סדרה";

  useEffect(() => {
    if (!panel) return;
    const reposition = () => {
      if (dialog.current && opener.current) positionPanel(dialog.current, opener.current);
    };
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [panel]);

  function openPanel(kind: Panel, button: HTMLButtonElement) {
    setDraftSeries(activeSeries);
    setDraftCategory(active);
    setPanel(kind);
    opener.current = button;
    const element = dialog.current;
    if (!element) return;
    // Desktop stays beside the control; mobile positioning is CSS only.
    positionPanel(element, button);
    element.showModal();
  }

  function closePanel() { dialog.current?.close(); }
  function chooseSeries(key: string) {
    setDraftSeries(key);
    // Do not carry an unavailable product type into a different series.
    if (!filterByCategory(filterBySeries(items, key), draftCategory).length) setDraftCategory("all");
  }

  return (
    <section className={styles.root} dir="rtl" aria-label="בחירת סדרה וסוג מוצר">
      <div className={styles.triggers}>
        <button type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={panel === "series"}
          aria-label={seriesTitle} aria-controls={id} onClick={event => openPanel("series", event.currentTarget)}>
          <span className={styles.triggerLabel}>בחירת סדרה{brandLabel && <bdi className={styles.brandLabel}>{brandLabel}</bdi>}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        <button type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={panel === "category"}
          aria-controls={id} onClick={event => openPanel("category", event.currentTarget)}>
          סוג מוצר <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {(activeSeries !== "all" || active !== "all") && (
        <div className={styles.summary} aria-label="הבחירות שלך">
          <span>הבחירות שלך:</span>
          {seriesLabel && <span>סדרה: <bdi>{seriesLabel}</bdi></span>}
          {active !== "all" && <span>סוג מוצר: {categoryLabel}</span>}
          <button type="button" onClick={() => onApply("all", "all")}>הצגת הכול</button>
        </div>
      )}
      <dialog ref={dialog} id={id} className={styles.dialog} aria-labelledby={id + "-title"}
        onKeyDown={event => event.stopPropagation()}
        onClose={() => { setPanel(null); opener.current?.focus({ preventScroll: true }); }}
        onClick={event => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePanel();
        }}>
        <div className={styles.header}>
          <h2 id={id + "-title"}>{panel === "series" ? <>בחירת סדרה{brandLabel && <bdi className={styles.brandLabel}>{brandLabel}</bdi>}</> : "בחירת סוג מוצר"}</h2>
          <button type="button" onClick={closePanel} aria-label="סגירת חלונית הבחירה">סגירה <span aria-hidden="true">×</span></button>
        </div>
        <div className={styles.options}>
          <fieldset>
            <legend className={styles.srOnly}>{panel === "series" ? "סדרות המותג" : "סוגי המוצרים בסדרה הנבחרת"}</legend>
            {(panel === "series" ? [{ key: "all", label: "כל הסדרות" }, ...series] : categories).map(option => {
              const selected = panel === "series" ? draftSeries === option.key : draftCategory === option.key;
              return <label key={option.key} className={styles.option}>
                <input type="radio" name={id + "-choice"} value={option.key} checked={selected}
                  onChange={() => panel === "series" ? chooseSeries(option.key) : setDraftCategory(option.key as CategoryKey)} />
                <bdi>{option.label}</bdi>
              </label>;
            })}
          </fieldset>
        </div>
        <div className={styles.footer}>
          <p role="status">{count} מוצרים בבחירה זו</p>
          <button type="button" className={styles.apply} onClick={() => { onApply(draftSeries, draftCategory); closePanel(); }}>
            הצגת המוצרים ({count})
          </button>
        </div>
      </dialog>
    </section>
  );
}
