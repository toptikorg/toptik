"use client";

import type { ReactNode } from "react";
import { CATEGORIES, categorizeItem, type CategoryKey } from "@/lib/carousel/categories";

import type { CarouselItem } from "@/lib/carousel/types";

type CategoryNavProps = {
  items: CarouselItem[];
  active: CategoryKey;
  onChange: (key: CategoryKey) => void;
};

// Outline-stroke icons matching the mockup — Mandarina warm brown, ~22px,
// stroke-width 1.6 to match the catalog-card-tech-btn family.
const ICONS: Partial<Record<CategoryKey, ReactNode>> = {
  // All products — a shopping/bag glyph for the view-all tab.
  all: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 8h14l-1.4 11.2a2 2 0 0 1-2 1.8h-7.2a2 2 0 0 1-2-1.8L5 8z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  ),
  // Suitcase — large checked case on wheels.
  suitcase: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="6" width="14" height="13" rx="2" />
      <path d="M9 6V3.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 3.5V6" />
      <path d="M9 19v1.5M15 19v1.5" />
      <circle cx="9" cy="22" r="1.2" />
      <circle cx="15" cy="22" r="1.2" />
    </svg>
  ),
  // Carry-on / trolley — upright cabin case with a pull handle.
  carryon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="7" width="12" height="14" rx="2.5" />
      <path d="M9 7V4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5V7" />
      <path d="M12 3V1.5" />
      <path d="M9.5 11h5" />
    </svg>
  ),
};

export function CategoryNav({ active, onChange, items }: CategoryNavProps) {
  const available = new Set(items.map(categorizeItem));
  const categories = CATEGORIES.filter(c => c.key === "all" || c.key === active || available.has(c.key));
  return (
    <aside className="category-nav" dir="rtl" aria-label="קטגוריות מוצרים">
      <h2 className="category-nav-title">קטגוריות</h2>
      <div className="category-nav-list" role="group" aria-label="סינון לפי סוג מוצר">
        {categories.map((c) => {
          const isActive = active === c.key;
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={isActive}
              className={`category-pill${isActive ? " is-active" : ""}`}
              onClick={() => onChange(c.key)}
            >
              <span className="category-pill-label">{c.label}</span>
              <span className="category-pill-icon">{ICONS[c.key] ?? ICONS.all}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
