export type VisibleProductCopy = {
  title: string;
  description: string;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type CopyField = keyof VisibleProductCopy;
export type CopyMergeResult = {
  copy: VisibleProductCopy;
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
 * - On first binding, a value present on only one side is copied to the other.
 *   Different non-empty values are unresolved and must be reviewed; neither
 *   side is overwritten until an explicit baseline is established.
 * - Conflicting values are returned for a private audit record. A `review`
 *   winner is a hard stop, not a suggestion to write either value.
 */
export function mergeVisibleProductCopy(
  gallery: VisibleProductCopy,
  shopify: VisibleProductCopy,
  lastSynced: VisibleProductCopy | null,
  galleryUpdatedAt: string,
  shopifyUpdatedAt: string,
): CopyMergeResult {
  const result = { ...shopify };
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

    let winner: "gallery" | "shopify" | "review";
    if (!lastSynced) {
      const shopifyHasValue = nonEmpty(shopifyValue);
      const galleryHasValue = nonEmpty(galleryValue);
      if (shopifyValue !== galleryValue && shopifyHasValue && galleryHasValue) {
        winner = "review";
        conflicts.push({ field, winner });
      } else {
        winner = galleryHasValue ? "gallery" : "shopify";
      }
    } else {
      const galleryChanged = galleryValue !== lastSynced[field];
      const shopifyChanged = shopifyValue !== lastSynced[field];
      if (galleryChanged && !shopifyChanged) winner = "gallery";
      else if (shopifyChanged && !galleryChanged) winner = "shopify";
      else if (galleryChanged && shopifyChanged) winner = timestampsValid && galleryTime > shopifyTime ? "gallery" : "shopify";
      else winner = "shopify";
      if (galleryChanged && shopifyChanged) conflicts.push({ field, winner });
    }
    result[field] = (winner === "gallery" ? galleryValue : shopifyValue) as never;
  }

  return {
    copy: result,
    shopifyChanged: fields.some(field => result[field] !== shopify[field]),
    galleryChanged: fields.some(field => result[field] !== gallery[field]),
    conflicts,
  };
}

const REVIEW_CODES = new Set([
  "SYNC_CANARY_DELETE_DISABLED",
  "SYNC_CANARY_NOT_CONFIGURED",
  "SYNC_CANARY_VARIANT_AMBIGUOUS",
  "SYNC_SKU_OUTSIDE_CANARY",
  "SYNC_COPY_INITIAL_CONFLICT",
  "SYNC_OUTBOX_PAYLOAD_INVALID",
  "SYNC_OUTBOX_SKU_MISMATCH",
  "SYNC_BINDING_MISSING_OR_CONFLICTED",
  "SYNC_PRODUCT_COPY_MAPPING_AMBIGUOUS",
  "SYNC_SHOPIFY_PRODUCT_MISSING",
  "SYNC_SHOPIFY_VARIANT_IDENTITY_CONFLICT",
  "SYNC_COPY_CONCURRENT_UPDATE",
  "SYNC_COPY_READBACK_MISMATCH",
  "SHOPIFY_PRODUCT_COPY_WRITE_REJECTED",
  "SHOPIFY_PRODUCT_COPY_WRITE_MISSING",
]);

export function isSyncReviewCode(code: string): boolean {
  return REVIEW_CODES.has(code);
}
