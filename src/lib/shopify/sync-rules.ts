import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";

export type GallerySkuRow = { id: string; catalogNumber: string | null };
export type ShopifyVariantSku = { id: string; sku: string | null };

export type SkuMatch = {
  catalogKey: string;
  galleryItemId: string;
  variantGid: string;
};

export type SkuReview = {
  catalogKey: string | null;
  reason: "missing_sku" | "duplicate_gallery_sku" | "duplicate_shopify_sku" | "unmatched_gallery_item" | "unmatched_shopify_variant";
};

/**
 * Normalize punctuation and whitespace for exact SKU joins. The only
 * manufacturer-specific equivalence retained is Mandarina Duck's optional
 * terminal `-TU` suffix (also used by the existing verified purchase map).
 */
export function normalizeSyncSku(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const key = normalizeCatalogKey(raw);
  if (!key) return null;
  return /^P\d{2}/.test(key) && key.endsWith("TU") ? key.slice(0, -2) : key;
}

/** Return only one-to-one matches; never select a winner from duplicates. */
export function matchExactSkus(
  galleryRows: GallerySkuRow[],
  variants: ShopifyVariantSku[],
): { matches: SkuMatch[]; reviews: SkuReview[] } {
  const galleryBySku = new Map<string, GallerySkuRow[]>();
  const shopifyBySku = new Map<string, ShopifyVariantSku[]>();
  const reviews: SkuReview[] = [];

  for (const item of galleryRows) {
    const key = normalizeSyncSku(item.catalogNumber);
    if (!key) continue;
    galleryBySku.set(key, [...(galleryBySku.get(key) ?? []), item]);
  }
  for (const variant of variants) {
    const key = normalizeSyncSku(variant.sku);
    if (!key) {
      reviews.push({ catalogKey: null, reason: "missing_sku" });
      continue;
    }
    shopifyBySku.set(key, [...(shopifyBySku.get(key) ?? []), variant]);
  }

  const matches: SkuMatch[] = [];
  for (const [key, variantsForKey] of shopifyBySku) {
    const itemsForKey = galleryBySku.get(key) ?? [];
    if (variantsForKey.length > 1) {
      reviews.push({ catalogKey: key, reason: "duplicate_shopify_sku" });
      continue;
    }
    if (itemsForKey.length > 1) {
      reviews.push({ catalogKey: key, reason: "duplicate_gallery_sku" });
      continue;
    }
    if (itemsForKey.length === 1) {
      matches.push({ catalogKey: key, galleryItemId: itemsForKey[0].id, variantGid: variantsForKey[0].id });
    } else {
      reviews.push({ catalogKey: key, reason: "unmatched_shopify_variant" });
    }
  }

  for (const [key, itemsForKey] of galleryBySku) {
    if (itemsForKey.length > 1) {
      if (!reviews.some(review => review.catalogKey === key && review.reason === "duplicate_gallery_sku")) {
        reviews.push({ catalogKey: key, reason: "duplicate_gallery_sku" });
      }
      continue;
    }
    if (!shopifyBySku.has(key)) reviews.push({ catalogKey: key, reason: "unmatched_gallery_item" });
  }

  return { matches, reviews };
}

export function shopifyProductGid(id: string | number): string | null {
  const raw = String(id).trim();
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(raw)) return raw;
  return /^\d+$/.test(raw) ? `gid://shopify/Product/${raw}` : null;
}

export function numericVariantId(variantGid: string): string | null {
  const match = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(variantGid);
  return match?.[1] ?? null;
}

/** Keep prior bindings untouched when the current SKU evidence is ambiguous. */
export function staleBindingKeys(
  previousKeys: string[],
  acceptedKeys: ReadonlySet<string>,
  protectedKeys: ReadonlySet<string>,
): string[] {
  return previousKeys.filter(key => !acceptedKeys.has(key) && !protectedKeys.has(key));
}
