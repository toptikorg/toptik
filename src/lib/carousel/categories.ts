import type { CarouselItem } from "./types";

// "all" also includes accessories and items whose category is not verified.
// The two narrower categories can be chosen per-product in the admin.
export type CategoryKey = "all" | "suitcase" | "carryon";
export type ProductCategory = "suitcase" | "carryon";

export interface CategoryDefinition {
  key: CategoryKey;
  label: string;
}

// Side-nav order (includes the view-all tab).
export const CATEGORIES: readonly CategoryDefinition[] = [
  { key: "all", label: "כל המוצרים" },
  { key: "suitcase", label: "מזוודה" },
  { key: "carryon", label: "טרולי / Carry-on" },
] as const;

// The two categories an editor can assign to a product (no "all").
export const PRODUCT_CATEGORIES: ReadonlyArray<{ key: ProductCategory; label: string }> = [
  { key: "suitcase", label: "מזוודה" },
  { key: "carryon", label: "טרולי / Carry-on" },
] as const;

export const DEFAULT_CATEGORY: CategoryKey = "all";

const CATEGORY_KEYS = new Set<string>(CATEGORIES.map((c) => c.key));
const PRODUCT_CATEGORY_KEYS = new Set<string>(PRODUCT_CATEGORIES.map((c) => c.key));

export function isCategoryKey(value: string | null | undefined): value is CategoryKey {
  return Boolean(value && CATEGORY_KEYS.has(value));
}

export function isProductCategory(value: string | null | undefined): value is ProductCategory {
  return Boolean(value && PRODUCT_CATEGORY_KEYS.has(value));
}

export function parseCategoryParam(raw: string | null | undefined): CategoryKey {
  return isCategoryKey(raw) ? raw : DEFAULT_CATEGORY;
}

// Exact identities checked against the sources recorded in reviewed-copy.json.
// BXL38124 is described by Bric's as a cabin trolley (not inferred from size).
// A category here is not a guarantee of acceptance by any particular airline.
// Null keeps accessories and unverified models in "all" without mislabelling.
const REVIEWED_CATEGORY_BY_SKU: Record<string, ProductCategory | null> = {
  P10JNV05465: null,
  P10GXV24A32: null,
  P10JNV0508Q: null,
  BXL38124078: "carryon",
  "BAH08453.001": "suitcase",
  "BAH08453.006": "suitcase",
  "BAH08451.001": "carryon",
  "BAH08454.001": "suitcase",
  "BAH08453.078": "suitcase",
  "BXL58117.101": "carryon",
  BXL38124101: "carryon",
  "BXL58145.101": "suitcase",
  "BXL58145.050": "suitcase",
  "BXL58145.078": "suitcase",
  "P10SZV24-05J-TU": "carryon",
  "P10SZV24-A83-TU": "carryon",
  "P10UJV24-A92-TU": null,
  "P10SZV24-A81-TU": "carryon",
  "P10OUV24-A89-TU": "carryon",
  "P10OUN01-A89-TU": null,
  "P10UJN01-A92-TU": null,
  "ORI05500.909": "carryon",
  "ORI05500.024": "carryon",
  "P10OSV04-05J-TU": "suitcase",
  "P10ZJT06-24U-TU": null,
};

// A deliberate admin choice wins. Otherwise use only verified exact SKU
// evidence, never a translated title or a default that turns bags into luggage.
export function categorizeItem(item: CarouselItem): ProductCategory | null {
  const explicit = item.techSpecs?.category;
  if (isProductCategory(explicit)) return explicit;
  const sku = item.catalogNumber?.trim().toUpperCase();
  return sku && Object.hasOwn(REVIEWED_CATEGORY_BY_SKU, sku)
    ? REVIEWED_CATEGORY_BY_SKU[sku] : null;
}

export function filterByCategory(items: CarouselItem[], category: CategoryKey): CarouselItem[] {
  if (category === "all") return items;
  return items.filter((item) => categorizeItem(item) === category);
}
