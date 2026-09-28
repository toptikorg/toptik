import type { CarouselItem } from "./types";

// Nav keys: "all" is a view-all tab; every product is classified into one of the
// two real categories, chosen per-product in the admin.
export type CategoryKey = "all" | "suitcase" | "carryon" | `collection:${string}`;
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
  return Boolean(value && (CATEGORY_KEYS.has(value) || /^collection:\d+$/.test(value)));
}

export function isProductCategory(value: string | null | undefined): value is ProductCategory {
  return Boolean(value && PRODUCT_CATEGORY_KEYS.has(value));
}

export function parseCategoryParam(raw: string | null | undefined): CategoryKey {
  return isCategoryKey(raw) ? raw : DEFAULT_CATEGORY;
}

// The category chosen in the admin (stored in techSpecs.category) wins. For
// legacy products with no explicit choice, guess from the English title so they
// still land in one of the two buckets — a clear cabin/carry-on marker maps to
// "carryon", everything else defaults to "suitcase". The admin checkbox lets an
// editor correct any guess.
export function categorizeItem(item: CarouselItem): ProductCategory {
  const explicit = item.techSpecs?.category;
  if (isProductCategory(explicit)) return explicit;
  const t = item.title.toLowerCase();
  if (/\b(cabin|carry[-\s]?on|hand\s*luggage|underseat|trolley\s*case)\b/.test(t)) return "carryon";
  return "suitcase";
}

export function filterByCategory(items: CarouselItem[], category: CategoryKey): CarouselItem[] {
  if (category === "all") return items;
  if (category.startsWith("collection:")) {
    const id = `gid://shopify/Collection/${category.slice("collection:".length)}`;
    return items.filter(item => item.commerce?.collectionIds.includes(id));
  }
  // Legacy saved categories apply to the curated gallery only. In particular,
  // do not classify a newly imported laptop bag as a suitcase by default.
  return items.filter((item) => !item.id.startsWith("shopify-") && categorizeItem(item) === category);
}
