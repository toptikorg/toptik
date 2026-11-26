import "server-only";
import type { CarouselItem } from "./types";
import { brandForItem } from "./brands";
import { REVIEWED_SERIES, type GallerySeries } from "./series";
import type { ProductCategory } from "./categories";

type StoreProduct = { vendor: string; product_type: string; tags: string[]; handle?: string; variants: { sku: string; id?: string | number }[] };
export type StoreClassification = { brand: string; series: GallerySeries | null; category: ProductCategory | null;
  purchaseLink?: CarouselItem["shopifyLink"];
  identity?: { sku: string; handle: string; variantId: string; vendor: string } };
type Classification = StoreClassification;
const brands: Record<string,string> = { "mandarina duck":"mandarina-duck", mandarinaduck:"mandarina-duck", "bric's":"brics", "bric’s":"brics", brics:"brics", samsonite:"samsonite", "american tourister":"american-tourister" };
const categories: Record<string,ProductCategory> = {
  "מזוודה":"suitcase", "checked luggage":"suitcase", "טרולי":"carryon", "carry-on luggage":"carryon",
  "תיק צד":"fashion-bags", "תיק כתף":"fashion-bags", "תיק יד":"fashion-bags", "crossbody bag":"fashion-bags", "shoulder bag":"fashion-bags",
  "תיק גב":"backpacks", backpack:"backpacks", "תיק גב למחשב":"laptop-bags", "תיק מחשב":"laptop-bags", "laptop bag":"laptop-bags",
  "תיק נסיעות":"travel-bags", "travel bag":"travel-bags", "ארנק":"wallets", "ארנק עור":"wallets", wallet:"wallets",
  "נרתיק":"pouches", "תיק רחצה":"pouches", pouch:"pouches", "toiletry bag":"pouches",
};
const normalize = (sku: string) => sku.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(P[0-9]{2}.*)TU$/, "$1");
const exactSku = (sku: string) => sku.normalize("NFKC").trim().toUpperCase();

function hasDeclaredBrand(item: CarouselItem): boolean {
  return (item.techSpecs?.specs ?? []).some(section => section.items.some(spec =>
    ["מותג", "brand"].includes(spec.label.normalize("NFKC").trim()
      .replace(/\s+/g, " ").replace(/:$/, "").trim().toLowerCase())));
}

export function classificationIndex(products: StoreProduct[]): Map<string,Classification | null> {
  const index = new Map<string,Classification | null>();
  for (const product of products) {
    const vendor = product.vendor.trim().toLowerCase();
    const brand = vendor === "knirps" ? "brand:knirps" : brands[vendor];
    if (!brand || !Array.isArray(product.tags) || !Array.isArray(product.variants)) continue;
    const matches = REVIEWED_SERIES.filter(s => s.brand === brand && product.tags.includes(`tt-series:${s.key}`));
    const classification = { brand, series: matches.length === 1 ? matches[0] : null,
      category: categories[product.product_type.trim().toLowerCase()] ?? null };
    for (const variant of product.variants) {
      if (typeof variant.sku !== "string" || !variant.sku.trim()) continue;
      const key = normalize(variant.sku);
      const variantId = String(variant.id ?? "");
      const purchaseLink = brand === "brand:knirps" && typeof product.handle === "string" &&
        /^[a-z0-9][a-z0-9-]{0,254}$/.test(product.handle) && /^\d+$/.test(variantId)
        ? { handle: product.handle, variantId, isPublished: true } : undefined;
      const identity = typeof product.handle === "string" && product.handle.length <= 255 &&
        /^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$/.test(product.handle) && /^\d+$/.test(variantId)
        ? { sku: exactSku(variant.sku), handle: product.handle, variantId, vendor: product.vendor.trim() } : undefined;
      index.set(key, index.has(key) ? null : { ...classification,
        ...(purchaseLink ? { purchaseLink } : {}), ...(identity ? { identity } : {}) });
    }
  }
  return index;
}

export async function readStoreClassification(): Promise<Map<string,Classification | null> | null> {
  // Read public catalog data only, never prices, stock, credentials or customers.
  // Bound total cold-fetch time; an unavailable store must not take down gallery.
  const signal = AbortSignal.timeout(2500);
  const products: StoreProduct[] = [];
  try {
    for (let page = 1; page <= 8; page++) {
      const response = await fetch(`https://www.toptik.co.il/products.json?limit=250&page=${page}`, {
        next: { revalidate: 300 }, signal,
      });
      if (!response.ok) throw new Error("STORE_CLASSIFICATION_READ_FAILED");
      const body = await response.json();
      if (!Array.isArray(body.products)) throw new Error("STORE_CLASSIFICATION_SHAPE_INVALID");
      products.push(...body.products);
      if (body.products.length < 250) return classificationIndex(products);
    }
    throw new Error("STORE_CLASSIFICATION_INCOMPLETE");
  } catch {
    console.warn("STORE_CLASSIFICATION_UNAVAILABLE");
    return null;
  }
}

export function applyStoreClassification(items: CarouselItem[], index: Map<string,Classification | null> | null): CarouselItem[] {
  if (!index) return items;
  return items.map(item => {
    const value = index.get(normalize(item.catalogNumber ?? ""));
    if (!value) return item;
    let classified = item;
    if (!brandForItem(item)) {
      const identity = value.identity;
      const link = item.shopifyLink;
      // The public store is the source for a missing brand only when the exact
      // published purchase identity agrees. Never infer it from a title/SKU
      // prefix, override explicit conflicting data, or revive a hidden item.
      if (!item.isActive || hasDeclaredBrand(item) || !identity || link?.isPublished !== true ||
        exactSku(item.catalogNumber ?? "") !== identity.sku ||
        link.handle !== identity.handle || link.variantId !== identity.variantId) return item;
      classified = { ...item, techSpecs: { ...(item.techSpecs ?? { specs: [], colors: [] }),
        specs: [...(item.techSpecs?.specs ?? []), { heading: "פרטי מוצר", items: [{ label: "מותג", value: identity.vendor }] }] } };
    }
    if (value.brand !== brandForItem(classified)?.key) return item;
    return { ...classified, series: value.series,
      ...(value.category ? { techSpecs: { ...(classified.techSpecs ?? { specs: [], colors: [] }), category: value.category } } : {}) };
  });
}
