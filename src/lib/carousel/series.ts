import reviewed from "./series-reviewed.json";
import type { CarouselItem } from "./types";
import { brandForItem } from "./brands";

export type GallerySeries = { key: string; label: string; brand: string };
const bySku: Readonly<Record<string, GallerySeries>> = reviewed;
const normalizeSku = (value: string) => value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(P[0-9]{2}.*)TU$/, "$1");

// Exact SKU assignments reviewed against the same manufacturer evidence and
// Shopify collections as the store. Unknown identities are never guessed.
export function seriesForItem(item: CarouselItem): GallerySeries | null {
  if (Object.hasOwn(item, "series")) {
    return item.series && item.series.brand === brandForItem(item)?.key ? item.series : null;
  }
  const series = bySku[normalizeSku(item.catalogNumber ?? "")];
  return series && series.brand === brandForItem(item)?.key ? series : null;
}

export const REVIEWED_SERIES: readonly GallerySeries[] = [...new Map(Object.values(bySku).map(series => [series.key, series])).values()];

export function availableSeries(items: CarouselItem[]): GallerySeries[] {
  const unique = new Map<string, GallerySeries>();
  for (const item of items) {
    const series = seriesForItem(item);
    if (item.isActive && series) unique.set(series.key, series);
  }
  return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, "en"));
}

export function filterBySeries(items: CarouselItem[], series: string): CarouselItem[] {
  return series === "all" ? items : items.filter(item => seriesForItem(item)?.key === series);
}
