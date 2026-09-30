import { normalizeCatalogKey } from "@/lib/catalog-source/vendor-detect";

export type GallerySkuRow = { id: string; catalogNumber: string | null };
export type ShopifyVariantSku = { id: string; sku: string | null };

export type ShopifySyncMode = "canary" | "verified_catalog" | "disabled";
export function configuredShopifySyncMode(raw: string | null | undefined): ShopifySyncMode {
  if (raw == null || raw === "" || raw === "canary") return "canary";
  return raw === "verified_catalog" ? "verified_catalog" : "disabled";
}

/** One path segment; explicit ASCII/Hebrew grammar matches the reviewed catalog and SQL. */
export function isSafeShopifyProductHandle(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9א-ת][A-Za-z0-9א-ת-]*$/.test(value);
}

export type VerifiedCopyEligibility = {
  product_gid: string; catalog_key: string; carousel_item_id: string; variant_gid: string;
  exact_gallery_sku: string; exact_shopify_sku: string; approved_product_handle: string;
  allowed_fields: string[]; enabled: boolean; approval_id: string;
  approved_source_updated_at: string; alias_evidence: Record<string, unknown>;
};

export function assertVerifiedCopyApproval(approval: VerifiedCopyEligibility | null | undefined): asserts approval is VerifiedCopyEligibility {
  if (!approval || approval.enabled !== true || !approval.approval_id ||
      !Array.isArray(approval.allowed_fields) || approval.allowed_fields.length !== 4 ||
      ["title", "description", "seoTitle", "seoDescription"].some(field => !approval.allowed_fields.includes(field)) ||
      !isSafeShopifyProductHandle(approval.approved_product_handle) ||
      !approval.exact_gallery_sku || !approval.exact_shopify_sku ||
      (approval.exact_gallery_sku !== approval.exact_shopify_sku &&
        (!approval.alias_evidence || typeof approval.alias_evidence !== "object" || Array.isArray(approval.alias_evidence) || !Object.keys(approval.alias_evidence).length))) {
    throw new Error("SYNC_COPY_NOT_APPROVED");
  }
}

export function assertVerifiedCopyIdentity(
  approval: VerifiedCopyEligibility,
  binding: { product_gid: string; catalog_key: string; carousel_item_id: string; variant_gid: string; product_handle: string },
  gallery: { id: string; catalog_number: string | null },
  product: { id: string; handle: string; status: string; publishedOnPublication: boolean; variants: ShopifyVariantSku[] },
) {
  assertVerifiedCopyApproval(approval);
  if (binding.product_gid !== approval.product_gid || binding.catalog_key !== approval.catalog_key ||
      binding.carousel_item_id !== approval.carousel_item_id || binding.variant_gid !== approval.variant_gid ||
      binding.product_handle !== approval.approved_product_handle || gallery.id !== approval.carousel_item_id ||
      gallery.catalog_number !== approval.exact_gallery_sku || product.id !== approval.product_gid ||
      product.variants.length !== 1 || product.variants[0].id !== approval.variant_gid ||
      product.variants[0].sku !== approval.exact_shopify_sku || product.handle !== approval.approved_product_handle ||
      product.status !== "ACTIVE" || !product.publishedOnPublication) {
    throw new Error("SYNC_VERIFIED_COPY_IDENTITY_CONFLICT");
  }
}

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

/**
 * Production activation is intentionally restricted to one exact SKU until
 * the first live round-trip is verified. Multiple values are rejected rather
 * than interpreted as an allowlist.
 */
export function configuredSyncCanarySku(raw: string | null | undefined): string | null {
  if (!raw?.trim() || /[,;\r\n]/.test(raw)) return null;
  const key = normalizeSyncSku(raw);
  return key && /^[A-Z0-9]+$/.test(key) ? key : null;
}

export function isSyncCanarySku(candidate: string | null | undefined, configured: string | null): boolean {
  return configured !== null && normalizeSyncSku(candidate) === configured;
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
