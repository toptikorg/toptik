"use client";

import { availableSeries } from "@/lib/carousel/series";
import type { CarouselItem } from "@/lib/carousel/types";

export function SeriesNav({ items, active, onChange }: {
  items: CarouselItem[]; active: string; onChange: (key: string) => void;
}) {
  const series = availableSeries(items);
  if (!series.length) return null;
  return (
    <section dir="rtl" aria-label="בחירה לפי סדרה">
      <h2 className="category-nav-title">בחירה לפי סדרה</h2>
      <div className="category-nav-list" role="group" aria-label="סדרות היצרן">
        {[{ key: "all", label: "כל הסדרות" }, ...series].map(entry => (
          <button key={entry.key} type="button" aria-pressed={active === entry.key}
            className={`category-pill${active === entry.key ? " is-active" : ""}`}
            onClick={() => onChange(entry.key)}>
            <bdi className="category-pill-label">{entry.label}</bdi>
          </button>
        ))}
      </div>
    </section>
  );
}
