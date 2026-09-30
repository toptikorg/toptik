export type VisibleProductCopy = {
  title: string;
  description: string;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type CopyField = keyof VisibleProductCopy;
export type CopyMergeResult = {
  copy: VisibleProductCopy;
  shopifyCopy: VisibleProductCopy;
  galleryCopy: VisibleProductCopy;
  shopifyChanged: boolean;
  galleryChanged: boolean;
  conflicts: Array<{ field: CopyField; winner: "gallery" | "shopify" | "review" }>;
};

const fields: CopyField[] = ["title", "description", "seoTitle", "seoDescription"];
const nonEmpty = (value: string | null): boolean => Boolean(value?.trim());

/**
 * Deterministic, field-level bidirectional merge.
 * - A one-sided edit wins only that field.
 * - Simultaneous edits to one field use source timestamps; Shopify wins ties.
 * - On first binding, a value present on only one side fills the empty side.
 *   Different non-empty values are preserved independently and become
 *   side-specific baselines; they are not treated as new edits.
 * - After binding, each side is compared with its own last-synced snapshot.
 *   One-sided edits propagate field-by-field. Concurrent same-field edits use
 *   best-available timestamps and are returned for a private audit record.
 */
export function mergeVisibleProductCopy(
  gallery: VisibleProductCopy,
  shopify: VisibleProductCopy,
  lastSynced: VisibleProductCopy | null,
  galleryUpdatedAt: string,
  shopifyUpdatedAt: string,
  galleryBaseline: VisibleProductCopy | null = lastSynced,
  shopifyBaseline: VisibleProductCopy | null = lastSynced,
): CopyMergeResult {
  const shopifyCopy = { ...shopify };
  const galleryCopy = { ...gallery };
  const result = { ...shopify };
  const hasSideBaselines = galleryBaseline !== null && shopifyBaseline !== null;
  const conflicts: CopyMergeResult["conflicts"] = [];
  const parsedGalleryTime = Date.parse(galleryUpdatedAt);
  const parsedShopifyTime = Date.parse(shopifyUpdatedAt);
  const timestampsValid = Number.isFinite(parsedGalleryTime) && Number.isFinite(parsedShopifyTime);
  const galleryTime = timestampsValid ? parsedGalleryTime : 0;
  const shopifyTime = timestampsValid ? parsedShopifyTime : 0;

  for (const field of fields) {
    const galleryValue = gallery[field];
    const shopifyValue = shopify[field];
    if (galleryValue === shopifyValue) {
      result[field] = galleryValue as never;
      continue;
    }

    if (!hasSideBaselines) {
      const shopifyHasValue = nonEmpty(shopifyValue);
      const galleryHasValue = nonEmpty(galleryValue);
      if (galleryHasValue && !shopifyHasValue) {
        shopifyCopy[field] = galleryValue as never;
        result[field] = galleryValue as never;
      } else if (shopifyHasValue && !galleryHasValue) {
        galleryCopy[field] = shopifyValue as never;
        result[field] = shopifyValue as never;
      }
      // Different non-empty initial values are preserved on both sides.
      continue;
    }

    const galleryChanged = galleryValue !== galleryBaseline[field];
    const shopifyChanged = shopifyValue !== shopifyBaseline[field];
    if (!galleryChanged && !shopifyChanged) continue;

    let winner: "gallery" | "shopify";
    if (galleryChanged && !shopifyChanged) winner = "gallery";
    else if (shopifyChanged && !galleryChanged) winner = "shopify";
    else if (galleryValue === shopifyValue) continue;
    else winner = timestampsValid && galleryTime > shopifyTime ? "gallery" : "shopify";
    if (galleryChanged && shopifyChanged && galleryValue !== shopifyValue) conflicts.push({ field, winner });

    const winningValue = (winner === "gallery" ? galleryValue : shopifyValue) as never;
    shopifyCopy[field] = winningValue;
    galleryCopy[field] = winningValue;
    result[field] = winningValue;
  }

  return {
    copy: result,
    shopifyCopy,
    galleryCopy,
    shopifyChanged: fields.some(field => shopifyCopy[field] !== shopify[field]),
    galleryChanged: fields.some(field => galleryCopy[field] !== gallery[field]),
    conflicts,
  };
}

const REVIEW_CODES = new Set([
  "SYNC_CANARY_DELETE_DISABLED",
  "SYNC_CANARY_NOT_CONFIGURED",
  "SYNC_CANARY_VARIANT_AMBIGUOUS",
  "SYNC_CANARY_PRODUCT_HAS_MULTIPLE_VARIANTS",
  "SYNC_SKU_OUTSIDE_CANARY",
  "SYNC_OUTBOX_PAYLOAD_INVALID",
  "SYNC_OUTBOX_SKU_MISMATCH",
  "SYNC_BINDING_MISSING_OR_CONFLICTED",
  "SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS",
  "SYNC_SHOPIFY_PRODUCT_MISSING",
  "SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT",
  "SYNC_SHOPIFY_PRODUCT_IDENTITY_CONFLICT",
  "SYNC_COPY_CONCURRENT_UPDATE",
  "SYNC_COPY_READBACK_MISMATCH",
  "SHOPIFY_PRODUCT_COPY_WRITE_REJECTED",
  "SHOPIFY_PRODUCT_COPY_WRITE_MISSING",
]);

export function isSyncReviewCode(code: string): boolean {
  return REVIEW_CODES.has(code);
}
